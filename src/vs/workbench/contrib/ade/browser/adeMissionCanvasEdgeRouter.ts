/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	computeMissionEdgeLabelLayout,
	computeOrthogonalRoundedEdgeRoute,
	getMissionEdgeKind,
	IMissionDagEdge,
	IMissionDagNode,
	IMissionEdgeObstacle,
	IMissionNodePosition,
} from '../../../../platform/ade/common/adeMissionDag.js';
import { normalizeAdeNodeColor, resolveAdeNodeColorHex } from '../../../../platform/ade/common/adeNodeColors.js';
import {
	IMissionTaskStatusRecord,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	computeOrchestrationMultiAnchorRoutes,
	IOrchestrationDepartmentGroup,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	IOrchestrationRoutedEdge,
	OrchestrationLayoutMode,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { adeBi } from '../common/adeLocalization.js';
import { getMissionWaveColorIndex, getRenderedOrchestrationNodeSize, reanchorOrchestrationRoute } from './adeMissionOrchCardBuilder.js';
import { getMissionNodeSize } from './adeMissionTaskCardBuilder.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string>): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			el.setAttribute(k, v);
		}
	}
	return el;
}

export function boxesOverlap(a: IMissionEdgeObstacle, b: IMissionEdgeObstacle): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function computeRouteBbox(points: readonly { readonly x: number; readonly y: number }[], pad = 20): IMissionEdgeObstacle {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const pt of points) {
		if (pt.x < minX) { minX = pt.x; }
		if (pt.x > maxX) { maxX = pt.x; }
		if (pt.y < minY) { minY = pt.y; }
		if (pt.y > maxY) { maxY = pt.y; }
	}
	if (!Number.isFinite(minX)) {
		return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
	}
	return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

export function samplePolylinePointAtFraction(
	points: readonly { readonly x: number; readonly y: number }[],
	fraction: number,
): { readonly x: number; readonly y: number } {
	if (points.length === 0) {
		return { x: 0, y: 0 };
	}
	if (points.length === 1) {
		return points[0];
	}
	const segLens: number[] = [];
	let total = 0;
	for (let i = 0; i < points.length - 1; i++) {
		const len = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
		segLens.push(len);
		total += len;
	}
	if (total <= 0.01) {
		return points[0];
	}
	const clamped = Math.max(0.05, Math.min(0.95, fraction));
	let target = total * clamped;
	for (let i = 0; i < segLens.length; i++) {
		const len = segLens[i];
		if (target <= len || i === segLens.length - 1) {
			const t = len > 0.001 ? Math.max(0, Math.min(1, target / len)) : 0;
			return {
				x: Math.round((points[i].x + (points[i + 1].x - points[i].x) * t) * 10) / 10,
				y: Math.round((points[i].y + (points[i + 1].y - points[i].y) * t) * 10) / 10,
			};
		}
		target -= len;
	}
	return points[points.length - 1];
}

export function resolveArrowMarkerUrlForColor(rawColor: string | undefined, fallbackId: string): string {
	const norm = normalizeAdeNodeColor(rawColor);
	if (norm && !norm.startsWith('#')) {
		return `url(#ade-mission-arrow-preset-${norm})`;
	}
	return `url(#${fallbackId})`;
}

export function measureSvgPillWidth(text: string, padPx: number, minW: number, maxW: number): number {
	let px = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		px += code > 0x2e7f ? 13 : 7.2;
	}
	return Math.round(Math.max(minW, Math.min(maxW, px + padPx)));
}

export interface ILabelBox {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

export function resolveNonOverlappingLabelCenter(
	baseX: number,
	baseY: number,
	pillW: number,
	placedBoxes: ILabelBox[],
	pillH = 20,
): { readonly x: number; readonly y: number } {
	let labelY = baseY;
	for (let attempt = 0; attempt < 6; attempt++) {
		const hit = placedBoxes.some(b =>
			Math.abs(b.x - baseX) < (b.w + pillW) / 2 + 6
			&& Math.abs(b.y - labelY) < (b.h + pillH) / 2 + 4,
		);
		if (!hit) {
			break;
		}
		const step = Math.ceil((attempt + 1) / 2) * 24 * (attempt % 2 === 0 ? -1 : 1);
		labelY = Math.round((baseY + step) * 10) / 10;
	}
	placedBoxes.push({ x: baseX, y: labelY, w: pillW, h: pillH });
	return { x: baseX, y: labelY };
}

export function computeMissionPortOffsets(
	edges: readonly IMissionDagEdge[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
	sizeById: ReadonlyMap<string, { readonly width: number; readonly height: number }>,
	isVertical: boolean,
): { readonly exitOffsetByEdgeId: ReadonlyMap<string, number>; readonly entryOffsetByEdgeId: ReadonlyMap<string, number> } {
	const outByNode = new Map<string, IMissionDagEdge[]>();
	const inByNode = new Map<string, IMissionDagEdge[]>();
	for (const e of edges) {
		const o = outByNode.get(e.from) ?? [];
		o.push(e);
		outByNode.set(e.from, o);
		const i = inByNode.get(e.to) ?? [];
		i.push(e);
		inByNode.set(e.to, i);
	}

	const exitOffsetByEdgeId = new Map<string, number>();
	const entryOffsetByEdgeId = new Map<string, number>();

	const assignOffsets = (
		map: Map<string, IMissionDagEdge[]>,
		target: Map<string, number>,
		getPeerId: (e: IMissionDagEdge) => string,
	) => {
		for (const [nodeId, list] of map.entries()) {
			if (list.length <= 1) {
				if (list.length === 1) {
					target.set(list[0].id, 0);
				}
				continue;
			}
			const sz = sizeById.get(nodeId) ?? { width: 280, height: 154 };
			const dim = isVertical ? sz.width : sz.height;
			const maxHalfSpan = Math.min(34, Math.round(dim * 0.26));
			const sorted = [...list].sort((a, b) => {
				const pa = positions.get(getPeerId(a));
				const pb = positions.get(getPeerId(b));
				const ca = pa ? (isVertical ? pa.x : pa.y) : 0;
				const cb = pb ? (isVertical ? pb.x : pb.y) : 0;
				return ca - cb || a.id.localeCompare(b.id);
			});
			const k = sorted.length;
			const halfSpan = Math.min(maxHalfSpan, (k - 1) * 9);
			for (let idx = 0; idx < k; idx++) {
				const frac = k === 1 ? 0 : (idx / (k - 1)) * 2 - 1;
				target.set(sorted[idx].id, Math.round(frac * halfSpan));
			}
		}
	};

	assignOffsets(outByNode, exitOffsetByEdgeId, e => e.to);
	assignOffsets(inByNode, entryOffsetByEdgeId, e => e.from);
	return { exitOffsetByEdgeId, entryOffsetByEdgeId };
}

export interface IRenderedEdgeHandle {
	readonly group: SVGGElement;
	readonly path: SVGPathElement;
	readonly hitPath: SVGPathElement;
	haloPath?: SVGPathElement;
	flowStreamPath?: SVGPathElement;
	readonly labelBg?: SVGRectElement;
	readonly labelText?: SVGTextElement;
	readonly pillW: number;
	readonly edge: IMissionDagEdge;
	readonly isCrossHost: boolean;
	readonly isWhiteboardLink: boolean;
	readonly isCycleBack: boolean;
	readonly isBidirectional: boolean;
	readonly isCriticalEdge: boolean;
	readonly isReworkFlow: boolean;
	readonly isHotBounce: boolean;
	baseMarkerEnd: string;
	baseMarkerStart?: string;
	midX: number;
	midY: number;
	bbox: IMissionEdgeObstacle;
	lastFlowHopSignature?: string;
}

export interface ILivePuckHandle {
	readonly group: SVGGElement;
	readonly edgeId: string;
	readonly staticFrac: number;
}

export interface IOrchDeptHandle {
	dept: IOrchestrationDepartmentGroup;
	readonly group: SVGGElement;
	readonly frameRect: SVGRectElement;
	readonly pillGroup: SVGGElement;
	readonly pillBg: SVGRectElement;
	readonly pillText: SVGTextElement;
	readonly grips: readonly SVGCircleElement[];
	emptyHint?: SVGTextElement;
	memberIds: readonly string[];
	emptyCenter?: IMissionNodePosition;
	boxX: number;
	boxY: number;
	boxW: number;
	x: number;
	y: number;
	w: number;
}

export interface IOrchDeptBounds {
	readonly id: string;
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
	readonly colorHex?: string;
}

export interface IEdgeTransitBurst {
	readonly edgeKey: string;
	readonly edgeId: string;
	readonly tokenId: string;
	readonly waveId: string;
	readonly isFail: boolean;
	readonly hopSignature: string;
	readonly expiresAt: number;
}

export function computeEmptyDeptFallbackPositions(
	nodes: readonly IOrchestrationGraphNode[],
	departments: readonly IOrchestrationDepartmentGroup[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
): readonly IMissionNodePosition[] {
	if (departments.length === 0) {
		return [];
	}
	const nodeById = new Map(nodes.map(n => [n.id, n]));
	let globalMaxX = 120;
	let globalMinY = 140;
	let hasPlacedNode = false;
	for (const n of nodes) {
		const p = positions.get(n.id);
		if (!p) {
			continue;
		}
		const sz = getRenderedOrchestrationNodeSize(n);
		globalMaxX = Math.max(globalMaxX, p.x + sz.width / 2);
		globalMinY = hasPlacedNode ? Math.min(globalMinY, p.y - sz.height / 2) : (p.y - sz.height / 2);
		hasPlacedNode = true;
	}
	const extras: IMissionNodePosition[] = [];
	let emptyIndex = 0;
	for (const dept of departments) {
		const allIds = [...new Set([...dept.nodeIds, ...dept.whiteboardIds])];
		const hasMemberPos = allIds.some(nid => nodeById.has(nid) && positions.has(nid));
		if (hasMemberPos) {
			continue;
		}
		const emptyH = 184;
		const center = positions.get(dept.id) ?? {
			x: Math.round((hasPlacedNode ? globalMaxX + 260 : 340)),
			y: Math.round((hasPlacedNode ? globalMinY + 90 : 220) + emptyIndex * (emptyH + 54)),
		};
		emptyIndex++;
		extras.push(center, { x: center.x + 200, y: center.y + 120 });
	}
	return extras;
}

export interface IOrchDeptRenderContext {
	readonly cloudTerritoriesLayerEl: SVGGElement;
	readonly deptDisposables: DisposableStore;
	readonly deptHandles: Map<string, IOrchDeptHandle>;
	readonly deptPillRectById: Map<string, { readonly dept: IOrchestrationDepartmentGroup; readonly x: number; readonly y: number; readonly w: number }>;
	readonly orchRuntime: IOrchestrationRuntimeState | undefined;
	readonly bindDepartmentPillInteractions: (
		pillGroup: SVGGElement,
		getDept: () => IOrchestrationDepartmentGroup,
		getMemberIds: () => readonly string[],
		getEmptyCenter: () => IMissionNodePosition | undefined,
	) => void;
}

export function renderOrchestrationDepartmentRegions(
	nodes: readonly IOrchestrationGraphNode[],
	departments: readonly IOrchestrationDepartmentGroup[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
	ctx: IOrchDeptRenderContext,
	forceRebuild = false,
): readonly IOrchDeptBounds[] {
	if (departments.length === 0) {
		ctx.deptDisposables.clear();
		ctx.deptHandles.clear();
		ctx.deptPillRectById.clear();
		while (ctx.cloudTerritoriesLayerEl.firstChild) {
			ctx.cloudTerritoriesLayerEl.removeChild(ctx.cloudTerritoriesLayerEl.firstChild);
		}
		return [];
	}

	const canPatchInPlace = !forceRebuild
		&& ctx.deptHandles.size === departments.length
		&& departments.every(d => ctx.deptHandles.has(d.id));

	if (!canPatchInPlace) {
		ctx.deptDisposables.clear();
		ctx.deptHandles.clear();
		ctx.deptPillRectById.clear();
		while (ctx.cloudTerritoriesLayerEl.firstChild) {
			ctx.cloudTerritoriesLayerEl.removeChild(ctx.cloudTerritoriesLayerEl.firstChild);
		}
	}

	const nodeById = new Map(nodes.map(n => [n.id, n]));
	let globalMaxX = 120;
	let globalMinY = 140;
	let hasPlacedNode = false;
	for (const n of nodes) {
		const p = positions.get(n.id);
		if (!p) {
			continue;
		}
		const sz = getRenderedOrchestrationNodeSize(n);
		globalMaxX = Math.max(globalMaxX, p.x + sz.width / 2);
		globalMinY = hasPlacedNode ? Math.min(globalMinY, p.y - sz.height / 2) : (p.y - sz.height / 2);
		hasPlacedNode = true;
	}

	const conflictStaffIds = new Set<string>();
	if (ctx.orchRuntime) {
		for (const barrier of Object.values(ctx.orchRuntime.joinBarriers ?? {})) {
			if ((barrier.fileConflicts?.length ?? 0) > 0) {
				conflictStaffIds.add(barrier.ownerNodeId);
				for (const cf of barrier.fileConflicts ?? []) {
					for (const fromStaffId of cf.fromNodeIds ?? []) {
						if (fromStaffId) {
							conflictStaffIds.add(fromStaffId);
						}
					}
					for (const tid of cf.tokenIds) {
						const tok = ctx.orchRuntime.tokens[tid];
						if (tok?.nodeId) {
							conflictStaffIds.add(tok.nodeId);
						}
					}
				}
			}
		}
	}

	const allBounds: IOrchDeptBounds[] = [];
	let emptyIndex = 0;

	for (let idx = 0; idx < departments.length; idx++) {
		const dept = departments[idx];
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		let count = 0;
		const allDeptMemberIds = [...new Set([...dept.nodeIds, ...dept.whiteboardIds])];
		for (const nid of allDeptMemberIds) {
			const n = nodeById.get(nid);
			const p = positions.get(nid);
			if (!n || !p) {
				continue;
			}
			const sz = getRenderedOrchestrationNodeSize(n);
			minX = Math.min(minX, p.x - sz.width / 2);
			maxX = Math.max(maxX, p.x + sz.width / 2);
			minY = Math.min(minY, p.y - sz.height / 2);
			maxY = Math.max(maxY, p.y + sz.height / 2);
			count++;
		}

		const isEmptyGroup = count === 0 || !Number.isFinite(minX);
		let boxX: number;
		let boxY: number;
		let boxW: number;
		let boxH: number;
		let emptyCenter: IMissionNodePosition | undefined;
		if (isEmptyGroup) {
			const emptyW = 368;
			const emptyH = 184;
			const explicitPos = positions.get(dept.id);
			emptyCenter = explicitPos ?? {
				x: Math.round((hasPlacedNode ? globalMaxX + 260 : 340)),
				y: Math.round((hasPlacedNode ? globalMinY + 90 : 220) + emptyIndex * (emptyH + 54)),
			};
			emptyIndex++;
			boxX = Math.round(emptyCenter.x - emptyW / 2);
			boxY = Math.round(emptyCenter.y - emptyH / 2);
			boxW = emptyW;
			boxH = emptyH;
		} else {
			const padX = 36;
			const padTop = 44;
			const padBottom = 30;
			boxX = Math.round(minX - padX);
			boxY = Math.round(minY - padTop);
			boxW = Math.round(maxX - minX + padX * 2);
			boxH = Math.round(maxY - minY + padTop + padBottom);
		}

		const colorIdx = idx % 5;
		const deptColoredStaff = dept.nodeIds
			.map(nid => nodeById.get(nid))
			.filter((n): n is IOrchestrationGraphNode => Boolean(n && resolveAdeNodeColorHex(n.color)))
			.sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99));
		const deptAccentHex = resolveAdeNodeColorHex(deptColoredStaff[0]?.color);

		let activeStaffCount = 0;
		let deptConflictCount = 0;
		for (const nid of dept.nodeIds) {
			const st = ctx.orchRuntime?.nodeStates[nid];
			if (st === 'active' || st === 'waiting_join' || st === 'blocked') {
				activeStaffCount++;
			}
			if (conflictStaffIds.has(nid)) {
				deptConflictCount++;
			}
		}

		const staffCount = dept.nodeIds.length;
		const wbPart = dept.whiteboardIds.length > 0 ? ` · ${dept.whiteboardIds.length} WB` : '';
		const activePart = activeStaffCount > 0
			? ` · ${adeBi(localize('adeOrchDeptActiveCount', "{0} active", activeStaffCount), '{0} 活跃', activeStaffCount)}`
			: '';
		const conflictPart = deptConflictCount > 0 ? ` · ⚠ ${deptConflictCount}` : '';
		const titleText = `${dept.name} (${staffCount}${wbPart}${activePart}${conflictPart})`;
		const pillW = measureSvgPillWidth(titleText, 40, 124, 340);
		const pillX = boxX + 16;
		const pillY = boxY - 12;

		allBounds.push({
			id: dept.id,
			minX: boxX,
			minY: boxY,
			maxX: boxX + boxW,
			maxY: boxY + boxH,
			colorHex: deptAccentHex,
		});

		const existing = canPatchInPlace ? ctx.deptHandles.get(dept.id) : undefined;
		if (existing) {
			existing.dept = dept;
			existing.memberIds = allDeptMemberIds;
			existing.emptyCenter = emptyCenter;
			existing.boxX = boxX;
			existing.boxY = boxY;
			existing.boxW = boxW;
			existing.x = pillX;
			existing.y = boxY;
			existing.w = pillW;
			existing.group.setAttribute('data-ade-dept-region', dept.name);
			existing.group.classList.toggle('has-custom-dept-accent', Boolean(deptAccentHex));
			existing.group.classList.toggle('is-empty-group', isEmptyGroup);
			existing.group.classList.toggle('has-active-staff', activeStaffCount > 0);
			existing.group.classList.toggle('has-conflict', deptConflictCount > 0);
			if (deptAccentHex) {
				existing.group.style.setProperty('--ade-dept-accent', deptAccentHex);
			} else {
				existing.group.style.removeProperty('--ade-dept-accent');
			}
			existing.frameRect.setAttribute('x', String(boxX));
			existing.frameRect.setAttribute('y', String(boxY));
			existing.frameRect.setAttribute('width', String(boxW));
			existing.frameRect.setAttribute('height', String(boxH));
			existing.pillGroup.setAttribute('data-ade-dept-name', dept.name);
			existing.pillBg.setAttribute('x', String(pillX));
			existing.pillBg.setAttribute('y', String(pillY));
			existing.pillBg.setAttribute('width', String(pillW));
			let gi = 0;
			for (let r = 0; r < 3; r++) {
				for (let c = 0; c < 2; c++) {
					const dot = existing.grips[gi++];
					if (dot) {
						dot.setAttribute('cx', String(pillX + 12 + c * 4));
						dot.setAttribute('cy', String(pillY + 8 + r * 4));
					}
				}
			}
			existing.pillText.setAttribute('x', String(pillX + 24));
			existing.pillText.setAttribute('y', String(boxY + 1));
			if (existing.pillText.textContent !== titleText) {
				existing.pillText.textContent = titleText;
			}
			if (isEmptyGroup) {
				if (!existing.emptyHint) {
					const hintText = svgEl('text', {
						class: 'ade-orch-dept-empty-hint',
						x: String(Math.round(boxX + boxW / 2)),
						y: String(Math.round(boxY + boxH / 2 + 4)),
					});
					hintText.textContent = adeBi(localize('adeOrchEmptyGroupHint', "Empty Group · Right-click pill to add staff or whiteboard"), '空分组 · 右键标题可添加员工或白板');
					existing.group.insertBefore(hintText, existing.pillGroup);
					existing.emptyHint = hintText;
				} else {
					existing.emptyHint.setAttribute('x', String(Math.round(boxX + boxW / 2)));
					existing.emptyHint.setAttribute('y', String(Math.round(boxY + boxH / 2 + 4)));
				}
			} else if (existing.emptyHint) {
				existing.emptyHint.remove();
				existing.emptyHint = undefined;
			}
			ctx.deptPillRectById.set(dept.id, { dept, x: pillX, y: boxY, w: pillW });
			continue;
		}

		const g = svgEl('g', {
			class: `ade-orch-dept-region dept-color-${colorIdx}${deptAccentHex ? ' has-custom-dept-accent' : ''}${isEmptyGroup ? ' is-empty-group' : ''}${activeStaffCount > 0 ? ' has-active-staff' : ''}${deptConflictCount > 0 ? ' has-conflict' : ''}`,
			'data-ade-dept-region': dept.name,
			'data-ade-dept-id': dept.id,
		});
		if (deptAccentHex) {
			g.style.setProperty('--ade-dept-accent', deptAccentHex);
		}
		const frameRect = svgEl('rect', {
			class: 'ade-orch-dept-frame',
			x: String(boxX),
			y: String(boxY),
			width: String(boxW),
			height: String(boxH),
			rx: '20',
			ry: '20',
		});
		g.appendChild(frameRect);

		let emptyHint: SVGTextElement | undefined;
		if (isEmptyGroup) {
			emptyHint = svgEl('text', {
				class: 'ade-orch-dept-empty-hint',
				x: String(Math.round(boxX + boxW / 2)),
				y: String(Math.round(boxY + boxH / 2 + 4)),
			});
			emptyHint.textContent = adeBi(localize('adeOrchEmptyGroupHint', "Empty Group · Right-click pill to add staff or whiteboard"), '空分组 · 右键标题可添加员工或白板');
			g.appendChild(emptyHint);
		}

		const pillGroup = svgEl('g', {
			class: 'ade-orch-dept-pill-group',
			'data-ade-dept-pill': dept.id,
			'data-ade-dept-name': dept.name,
		});
		const titleEl = svgEl('title');
		titleEl.textContent = adeBi(
			localize('adeOrchDeptPillTooltip', "Drag to move group · Double-click to rename · Right-click for group options"),
			'拖拽整体移动分组 · 双击重命名分组 · 右键打开分组菜单',
		);
		pillGroup.appendChild(titleEl);
		const pillBg = svgEl('rect', {
			class: 'ade-orch-dept-pill-bg',
			x: String(pillX),
			y: String(pillY),
			width: String(pillW),
			height: '24',
			rx: '12',
		});
		pillGroup.appendChild(pillBg);
		const grips: SVGCircleElement[] = [];
		for (let r = 0; r < 3; r++) {
			for (let c = 0; c < 2; c++) {
				const dot = svgEl('circle', {
					class: 'ade-orch-dept-grip',
					cx: String(pillX + 12 + c * 4),
					cy: String(pillY + 8 + r * 4),
					r: '1.05',
				});
				pillGroup.appendChild(dot);
				grips.push(dot);
			}
		}
		const pillText = svgEl('text', {
			class: 'ade-orch-dept-pill-text',
			x: String(pillX + 24),
			y: String(boxY + 1),
		});
		pillText.textContent = titleText;
		pillGroup.appendChild(pillText);
		g.appendChild(pillGroup);
		ctx.cloudTerritoriesLayerEl.appendChild(g);

		const handle: IOrchDeptHandle = {
			dept,
			group: g,
			frameRect,
			pillGroup,
			pillBg,
			pillText,
			grips,
			emptyHint,
			memberIds: allDeptMemberIds,
			emptyCenter,
			boxX,
			boxY,
			boxW,
			x: pillX,
			y: boxY,
			w: pillW,
		};
		ctx.deptHandles.set(dept.id, handle);
		ctx.deptPillRectById.set(dept.id, { dept, x: pillX, y: boxY, w: pillW });
		ctx.bindDepartmentPillInteractions(pillGroup, () => handle.dept, () => handle.memberIds, () => handle.emptyCenter);
	}

	return allBounds;
}

export interface IMissionEdgeSyncContext {
	readonly edgesLayerEl: SVGGElement;
	readonly tokenGliderLayerEl: SVGGElement;
	readonly edgeDisposables: DisposableStore;
	readonly edgeHandles: Map<string, IRenderedEdgeHandle>;
	readonly tokenGliderHandles: Map<string, { readonly group: SVGGElement; readonly text: SVGTextElement; waveClass: string; hopSignature: string }>;
	readonly livePuckHandles: Map<string, ILivePuckHandle>;
	readonly lastNodeObstacleById: Map<string, IMissionEdgeObstacle>;
	readonly orchNodeSizeById: ReadonlyMap<string, { readonly width: number; readonly height: number }>;
	readonly getNodeHostAttr: (nodeId: string) => string;
	readonly lastTaskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined;
	readonly orchRuntime: IOrchestrationRuntimeState | undefined;
	readonly criticalEdgeKeys: ReadonlySet<string>;
	readonly selectedEdgeKey: string | undefined;
	readonly animationsPaused: boolean;
	readonly clearGliderDom: () => void;
	readonly onSelectEdge?: (edge: IMissionDagEdge | undefined) => void;
	readonly onRenameEdgeLabel?: (fromId: string, toId: string, nextLabel: string) => void;
	readonly onEdgeContextMenu?: (edge: IMissionDagEdge, clientX: number, clientY: number) => void;
	readonly isRevisionPreview?: () => boolean;
	readonly startInlineEdgeLabelEdit: (edgeId: string) => void;
	readonly onOpenOrchestrationTokenPopover?: (staffLabel: string, token: IOrchestrationToken, anchorEl: HTMLElement, options?: { readonly staffNodeId?: string }) => void;
	readonly getLiveOrchToken: (tokenId: string) => IOrchestrationToken | undefined;
	readonly resolveStaffLabel: (staffNodeId: string) => string;
	lastEdgeStructureKey: string;
}

export function syncMissionEdgesSvg(
	nodes: readonly IMissionDagNode[],
	edges: readonly IMissionDagEdge[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
	direction: 'LR' | 'TD',
	movedNodeIdInput: string | undefined,
	ctx: IMissionEdgeSyncContext,
): { readonly rebuilt: boolean } {
	const isVertical = direction === 'TD';
	if (edges.length === 0) {
		ctx.edgeDisposables.clear();
		ctx.edgeHandles.clear();
		ctx.clearGliderDom();
		ctx.lastNodeObstacleById.clear();
		ctx.lastEdgeStructureKey = '';
		while (ctx.edgesLayerEl.firstChild) {
			ctx.edgesLayerEl.removeChild(ctx.edgesLayerEl.firstChild);
		}
		return { rebuilt: true };
	}

	const nodeById = new Map(nodes.map(n => [n.id, n]));
	const sizeById = new Map<string, { readonly width: number; readonly height: number }>();
	const allObstacles: { readonly id: string; readonly box: IMissionEdgeObstacle }[] = [];
	const currentObstacleById = new Map<string, IMissionEdgeObstacle>();
	for (const node of nodes) {
		const size = ctx.orchNodeSizeById.get(node.id) ?? getMissionNodeSize(node);
		sizeById.set(node.id, size);
		const pos = positions.get(node.id);
		if (!pos) {
			continue;
		}
		const pad = 12;
		const box: IMissionEdgeObstacle = {
			minX: pos.x - size.width / 2 - pad,
			maxX: pos.x + size.width / 2 + pad,
			minY: pos.y - size.height / 2 - pad,
			maxY: pos.y + size.height / 2 + pad,
		};
		allObstacles.push({ id: node.id, box });
		currentObstacleById.set(node.id, box);
	}

	const edgeDescriptors = edges.map(edge => {
		const edgeKind = getMissionEdgeKind(edge);
		const fromHost = ctx.getNodeHostAttr(edge.from);
		const toHost = ctx.getNodeHostAttr(edge.to);
		const isCrossHost = Boolean(fromHost && toHost && fromHost.toLowerCase() !== toHost.toLowerCase());
		const fromSt = ctx.lastTaskStatuses?.[edge.from]?.status ?? '';
		const toSt = ctx.lastTaskStatuses?.[edge.to]?.status ?? '';
		const toActiveTok = ctx.lastTaskStatuses?.[edge.to]?.activeTokenIds?.[0] ?? '';
		const toCol = nodeById.get(edge.to)?.color ?? nodeById.get(edge.from)?.color ?? '';
		const isCrit = ctx.criticalEdgeKeys.has(`${edge.from}->${edge.to}`);
		return { edge, edgeKind, isCrossHost, fromSt, toSt, toActiveTok, toCol, isCrit };
	});
	const nextEdgeStructureKey = `mission\x1e${direction}\x1e` + edgeDescriptors
		.map(d => `${d.edge.id}\x1f${d.edge.from}\x1f${d.edge.to}\x1f${d.edge.label ?? ''}\x1f${d.edgeKind}\x1f${d.isCrossHost ? '1' : '0'}\x1f${d.fromSt}\x1f${d.toSt}\x1f${d.toActiveTok}\x1f${d.toCol}\x1f${d.isCrit ? '1' : '0'}`)
		.join('\x1e');

	const canPatchInPlace = nextEdgeStructureKey === ctx.lastEdgeStructureKey && ctx.edgeHandles.size > 0;
	if (!canPatchInPlace) {
		ctx.edgeDisposables.clear();
		ctx.edgeHandles.clear();
		ctx.clearGliderDom();
		ctx.lastNodeObstacleById.clear();
		while (ctx.edgesLayerEl.firstChild) {
			ctx.edgesLayerEl.removeChild(ctx.edgesLayerEl.firstChild);
		}
		ctx.lastEdgeStructureKey = nextEdgeStructureKey;
	}

	const movedNodeId = canPatchInPlace ? movedNodeIdInput : undefined;
	let movedDirtyBox: IMissionEdgeObstacle | undefined;
	if (movedNodeId) {
		const prevBox = ctx.lastNodeObstacleById.get(movedNodeId);
		const currBox = currentObstacleById.get(movedNodeId);
		const margin = 28;
		if (prevBox && currBox) {
			movedDirtyBox = {
				minX: Math.min(prevBox.minX, currBox.minX) - margin,
				maxX: Math.max(prevBox.maxX, currBox.maxX) + margin,
				minY: Math.min(prevBox.minY, currBox.minY) - margin,
				maxY: Math.max(prevBox.maxY, currBox.maxY) + margin,
			};
		} else if (currBox ?? prevBox) {
			const b = (currBox ?? prevBox)!;
			movedDirtyBox = {
				minX: b.minX - margin,
				maxX: b.maxX + margin,
				minY: b.minY - margin,
				maxY: b.maxY + margin,
			};
		}
	}

	// Deterministic fan-out / fan-in port offsets (single-edge nodes stay dead-center!)
	const { exitOffsetByEdgeId, entryOffsetByEdgeId } = computeMissionPortOffsets(edges, positions, sizeById, isVertical);

	const placedLabelBoxes: ILabelBox[] = [];
	const routePointsByEdgeId = new Map<string, readonly { readonly x: number; readonly y: number }[]>();
	// Pre-seed placed boxes of untouched labeled edges during incremental drag so moving edge labels never collide with stationary ones
	if (movedNodeId) {
		for (const h of ctx.edgeHandles.values()) {
			if (h.labelBg && h.edge.from !== movedNodeId && h.edge.to !== movedNodeId) {
				placedLabelBoxes.push({ x: h.midX, y: h.midY, w: h.pillW, h: 20 });
			}
		}
	}

	for (const { edge, edgeKind, isCrossHost, isCrit } of edgeDescriptors) {
		const existing = canPatchInPlace ? ctx.edgeHandles.get(edge.id) : undefined;
		if (movedNodeId && existing) {
			const isIncident = edge.from === movedNodeId || edge.to === movedNodeId;
			const intersectsMoved = movedDirtyBox ? boxesOverlap(existing.bbox, movedDirtyBox) : true;
			if (!isIncident && !intersectsMoved) {
				continue;
			}
		}

		const fromNode = nodeById.get(edge.from);
		const toNode = nodeById.get(edge.to);
		const fromPos = positions.get(edge.from);
		const toPos = positions.get(edge.to);
		if (!fromNode || !toNode || !fromPos || !toPos) {
			continue;
		}
		const fromSize = sizeById.get(edge.from) ?? getMissionNodeSize(fromNode);
		const toSize = sizeById.get(edge.to) ?? getMissionNodeSize(toNode);
		const exitOff = exitOffsetByEdgeId.get(edge.id) ?? 0;
		const entryOff = entryOffsetByEdgeId.get(edge.id) ?? 0;
		const x1 = isVertical ? (fromPos.x + exitOff) : (fromPos.x + fromSize.width / 2);
		const y1 = isVertical ? (fromPos.y + fromSize.height / 2) : (fromPos.y + exitOff);
		const x2 = isVertical ? (toPos.x + entryOff) : (toPos.x - toSize.width / 2 - 4);
		const y2 = isVertical ? (toPos.y - toSize.height / 2 - 4) : (toPos.y + entryOff);

		const corridorPadX = isVertical ? 96 : 56;
		const corridorPadY = isVertical ? 56 : 96;
		const corridor: IMissionEdgeObstacle = {
			minX: Math.min(x1, x2) - corridorPadX,
			maxX: Math.max(x1, x2) + corridorPadX,
			minY: Math.min(y1, y2) - corridorPadY,
			maxY: Math.max(y1, y2) + corridorPadY,
		};
		const obstacles: IMissionEdgeObstacle[] = [];
		for (const o of allObstacles) {
			if (o.id !== edge.from && o.id !== edge.to && boxesOverlap(o.box, corridor)) {
				obstacles.push(o.box);
			}
		}

		const route = computeOrthogonalRoundedEdgeRoute(x1, y1, x2, y2, {
			cornerRadius: 16,
			minStub: 28,
			orientation: isVertical ? 'vertical' : 'horizontal',
			obstacles,
		});
		routePointsByEdgeId.set(edge.id, route.points);
		const routeBbox = computeRouteBbox(route.points);

		if (existing) {
			existing.bbox = routeBbox;
			if (existing.path.getAttribute('d') !== route.path) {
				existing.path.setAttribute('d', route.path);
				existing.hitPath.setAttribute('d', route.path);
				if (existing.haloPath) {
					existing.haloPath.setAttribute('d', route.path);
				}
				if (existing.flowStreamPath) {
					existing.flowStreamPath.setAttribute('d', route.path);
				}
				const glider = ctx.tokenGliderHandles.get(edge.id);
				if (glider) {
					glider.group.style.offsetPath = `path("${route.path}")`;
					glider.group.style.setProperty('offset-rotate', '0deg');
				}
				const livePuck = ctx.livePuckHandles.get(edge.id);
				if (livePuck) {
					if (ctx.animationsPaused) {
						const pt = samplePolylinePointAtFraction(route.points, livePuck.staticFrac);
						livePuck.group.setAttribute('transform', `translate(${pt.x}, ${pt.y})`);
					} else {
						livePuck.group.style.offsetPath = `path("${route.path}")`;
						livePuck.group.style.setProperty('offset-rotate', '0deg');
					}
				}
			}
			if (existing.labelBg && existing.labelText) {
				const resolved = resolveNonOverlappingLabelCenter(route.midX, route.midY, existing.pillW, placedLabelBoxes);
				existing.midX = resolved.x;
				existing.midY = resolved.y;
				existing.labelBg.setAttribute('x', String(resolved.x - existing.pillW / 2));
				existing.labelBg.setAttribute('y', String(resolved.y - 10));
				existing.labelText.setAttribute('x', String(resolved.x));
				existing.labelText.setAttribute('y', String(resolved.y));
			} else {
				existing.midX = route.midX;
				existing.midY = route.midY;
			}
			continue;
		}

		const edgeClasses = ['ade-mission-edge-group', 'is-mission-dag-edge'];
		if (edgeKind === 'fail') {
			edgeClasses.push('is-fail-edge');
		} else if (isCrossHost) {
			edgeClasses.push('is-cross-host');
		}
		if (isCrit) {
			edgeClasses.push('is-critical-edge');
		}
		const fromTaskStatus = ctx.lastTaskStatuses?.[edge.from]?.status;
		const toTaskStatus = ctx.lastTaskStatuses?.[edge.to]?.status;
		const isTaskCompletedFlow = edgeKind !== 'fail' && fromTaskStatus === 'completed' && toTaskStatus === 'completed';
		const isTaskLiveFlow = edgeKind !== 'fail' && fromTaskStatus === 'completed' && toTaskStatus === 'in_progress';
		const isTaskBlockedFlow = edgeKind !== 'fail' && (fromTaskStatus === 'blocked' || toTaskStatus === 'blocked');
		const isTaskReadyFlow = edgeKind !== 'fail'
			&& !isTaskBlockedFlow
			&& fromTaskStatus === 'completed'
			&& (!toTaskStatus || toTaskStatus === 'pending');
		let edgeStateTag = edgeKind === 'fail' ? 'fail' : 'pending';
		if (isTaskCompletedFlow) {
			edgeClasses.push('is-task-edge-completed');
			edgeStateTag = 'completed';
		} else if (isTaskLiveFlow) {
			edgeClasses.push('is-task-edge-live');
			edgeStateTag = 'live';
		} else if (isTaskBlockedFlow) {
			edgeClasses.push('is-task-edge-blocked');
			edgeStateTag = 'blocked';
		} else if (isTaskReadyFlow) {
			edgeClasses.push('is-task-edge-ready');
			edgeStateTag = 'ready';
		}
		const edgeKey = `${edge.from}->${edge.to}`;
		const isSelected = Boolean(ctx.selectedEdgeKey && ctx.selectedEdgeKey === edgeKey);
		if (isSelected) {
			edgeClasses.push('is-selected');
		}
		const targetCustomHex = resolveAdeNodeColorHex(toNode.color ?? fromNode.color);
		const group = svgEl('g', {
			class: edgeClasses.join(' '),
			'data-edge-id': edge.id,
			'data-edge-kind': edgeKind,
			'data-edge-state': edgeStateTag,
			'data-cross-host': String(isCrossHost),
			'data-from': edge.from,
			'data-to': edge.to,
			...(isCrit ? { 'data-critical-edge': 'true' } : {}),
			...(isSelected ? { 'data-edge-selected': 'true' } : {}),
		});
		const taskEdgeAccent = isTaskLiveFlow
			? (targetCustomHex ?? '#38bdf8')
			: isTaskCompletedFlow
				? '#34d399'
				: isTaskReadyFlow
					? '#2dd4bf'
					: isTaskBlockedFlow
						? '#fbbf24'
						: isCrit
							? '#f59e0b'
							: targetCustomHex;
		if (taskEdgeAccent && edgeKind !== 'fail') {
			group.style.setProperty('--edge-accent', taskEdgeAccent);
		}

		const hitPath = svgEl('path', { class: 'ade-mission-edge-hit', d: route.path });
		group.appendChild(hitPath);

		let haloPath: SVGPathElement | undefined;
		if (isTaskCompletedFlow || isTaskLiveFlow || isTaskReadyFlow || isTaskBlockedFlow || isCrit || targetCustomHex) {
			haloPath = svgEl('path', {
				class: `ade-orch-edge-halo${isTaskLiveFlow ? ' is-live' : ''}${isCrit ? ' is-critical' : ''}`,
				d: route.path,
			});
			group.appendChild(haloPath);
		}

		const baseMarkerEnd = edgeKind === 'fail'
			? 'url(#ade-mission-arrow-fail)'
			: isTaskLiveFlow
				? resolveArrowMarkerUrlForColor(toNode.color ?? fromNode.color, 'ade-mission-arrow-active')
				: (isTaskCompletedFlow || isTaskReadyFlow)
					? 'url(#ade-mission-arrow-out)'
					: isTaskBlockedFlow
						? 'url(#ade-mission-arrow-cycle)'
						: targetCustomHex
							? resolveArrowMarkerUrlForColor(toNode.color ?? fromNode.color, 'ade-mission-arrow-default')
							: isCrossHost
								? 'url(#ade-mission-arrow-cloud)'
								: 'url(#ade-mission-arrow-default)';

		const path = svgEl('path', {
			class: 'ade-mission-edge-path',
			d: route.path,
			'marker-end': isSelected ? 'url(#ade-mission-arrow-active)' : baseMarkerEnd,
		});
		group.appendChild(path);

		let flowStreamPath: SVGPathElement | undefined;
		if (isTaskLiveFlow) {
			flowStreamPath = svgEl('path', {
				class: 'ade-orch-edge-flow-stream',
				d: route.path,
			});
			group.appendChild(flowStreamPath);
		}

		ctx.edgeDisposables.add(addDisposableListener(group, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button === 0) {
				e.stopPropagation();
			}
		}));
		ctx.edgeDisposables.add(addDisposableListener(group, EventType.CLICK, (e: MouseEvent) => {
			e.stopPropagation();
			ctx.onSelectEdge?.(edge);
		}));
		ctx.edgeDisposables.add(addDisposableListener(group, EventType.DBLCLICK, (e: MouseEvent) => {
			if (!ctx.onRenameEdgeLabel || ctx.isRevisionPreview?.()) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			ctx.startInlineEdgeLabelEdit(edge.id);
		}));
		ctx.edgeDisposables.add(addDisposableListener(group, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			if (!ctx.onEdgeContextMenu) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			ctx.onEdgeContextMenu(edge, e.clientX, e.clientY);
		}));

		let labelBg: SVGRectElement | undefined;
		let labelText: SVGTextElement | undefined;
		let pillW = 0;
		let labelMidX = route.midX;
		let labelMidY = route.midY;
		if (edge.label) {
			const labelLayout = computeMissionEdgeLabelLayout(edge.label);
			pillW = Math.max(labelLayout.pillWidth, measureSvgPillWidth(labelLayout.displayText, 16, 36, 176));
			const resolved = resolveNonOverlappingLabelCenter(route.midX, route.midY, pillW, placedLabelBoxes);
			labelMidX = resolved.x;
			labelMidY = resolved.y;
			labelBg = svgEl('rect', {
				class: 'ade-mission-edge-label-bg',
				x: String(labelMidX - pillW / 2),
				y: String(labelMidY - 10),
				width: String(pillW),
				height: '20',
				rx: '6',
			});
			labelText = svgEl('text', {
				class: 'ade-mission-edge-label-text',
				x: String(labelMidX),
				y: String(labelMidY),
			});
			labelText.textContent = labelLayout.displayText;
			if (labelLayout.displayText !== edge.label.trim()) {
				const titleEl = svgEl('title');
				titleEl.textContent = edge.label;
				group.appendChild(titleEl);
			}
			group.appendChild(labelBg);
			group.appendChild(labelText);
		}

		// Place Mission DAG live beacon AFTER edge label & check against BOTH card borders + labels!
		if (isTaskLiveFlow) {
			const toRec = ctx.lastTaskStatuses?.[edge.to];
			const activeTokId = toRec?.activeTokenIds?.[0];
			const liveTok = activeTokId ? ctx.orchRuntime?.tokens?.[activeTokId] : undefined;
			const tokBadge = activeTokId ? `⚡ ${activeTokId}` : `⚡ ${edge.to}`;
			const puckW = Math.max(54, Math.min(96, Math.round(tokBadge.length * 6.2 + 20)));
			const halfW = puckW / 2;
			const cardAvoidBoxes: ILabelBox[] = [
				{ x: fromPos.x, y: fromPos.y, w: fromSize.width + 8, h: fromSize.height + 8 },
				{ x: toPos.x, y: toPos.y, w: toSize.width + 8, h: toSize.height + 8 },
			];
			const placement = chooseNonOverlappingBeaconPoint(route.points, puckW, placedLabelBoxes, cardAvoidBoxes, Boolean(edge.label), 0);
			const beaconX = placement.x;
			let beaconY = placement.y;
			// If edge is short (narrow inter-card gap with label) and beacon crowds the label vertically, stack label cleanly above & beacon below!
			if (labelBg && labelText && Math.abs(labelMidX - beaconX) < (pillW + puckW) / 2 + 8 && Math.abs(labelMidY - beaconY) < 28) {
				labelMidY = Math.round((labelMidY - 16) * 10) / 10;
				labelBg.setAttribute('y', String(labelMidY - 10));
				labelText.setAttribute('y', String(labelMidY));
				beaconY = Math.round((labelMidY + 26) * 10) / 10;
			}
			placedLabelBoxes.push({ x: beaconX, y: beaconY, w: puckW, h: 24 });

			const puckColor = taskEdgeAccent ?? '#38bdf8';
			const puckGroup = svgEl('g', {
				class: `ade-orch-live-puck is-task-dag-beacon${liveTok ? ' is-clickable-puck' : ''}`,
				'data-ade-task-live-beacon': edge.id,
				...(activeTokId ? { 'data-token-id': activeTokId } : {}),
			});
			puckGroup.style.setProperty('--puck-color', puckColor);
			if (ctx.animationsPaused) {
				puckGroup.setAttribute('transform', `translate(${beaconX}, ${beaconY})`);
			} else {
				puckGroup.style.offsetPath = `path("${route.path}")`;
				puckGroup.style.setProperty('offset-rotate', '0deg');
				puckGroup.style.animationDelay = `${-(placement.frac * 3.4).toFixed(2)}s`;
			}
			puckGroup.appendChild(svgEl('rect', { class: 'ade-orch-live-puck-bloom', x: String(-halfW - 4), y: '-12', width: String(puckW + 8), height: '24', rx: '12' }));
			puckGroup.appendChild(svgEl('rect', { class: 'ade-orch-live-puck-pill', x: String(-halfW), y: '-9.5', width: String(puckW), height: '19', rx: '9.5' }));
			puckGroup.appendChild(svgEl('circle', { class: 'ade-orch-live-puck-dot', cx: String(-halfW + 8), cy: '0', r: '2.4' }));
			const bText = svgEl('text', { class: 'ade-orch-live-puck-text', x: '3.5', y: '0.5' });
			bText.textContent = tokBadge;
			puckGroup.appendChild(bText);
			if (activeTokId && liveTok && ctx.onOpenOrchestrationTokenPopover) {
				ctx.edgeDisposables.add(addDisposableListener(puckGroup, EventType.POINTER_DOWN, (ev: PointerEvent) => {
					if (ev.button === 0) {
						ev.stopPropagation();
					}
				}));
				ctx.edgeDisposables.add(addDisposableListener(puckGroup, EventType.CLICK, (ev: MouseEvent) => {
					ev.stopPropagation();
					const curTok = ctx.getLiveOrchToken(activeTokId) ?? liveTok;
					ctx.onOpenOrchestrationTokenPopover?.(ctx.resolveStaffLabel(curTok.nodeId), curTok, puckGroup as unknown as HTMLElement, { staffNodeId: curTok.nodeId });
				}));
			}
			ctx.tokenGliderLayerEl.appendChild(puckGroup);
			ctx.livePuckHandles.set(edge.id, { group: puckGroup, edgeId: edge.id, staticFrac: placement.frac });
		}

		ctx.edgesLayerEl.appendChild(group);
		ctx.edgeHandles.set(edge.id, {
			group,
			path,
			hitPath,
			haloPath,
			flowStreamPath,
			labelBg,
			labelText,
			pillW,
			edge,
			isCrossHost,
			isWhiteboardLink: false,
			isCycleBack: false,
			isBidirectional: false,
			isCriticalEdge: isCrit,
			isReworkFlow: false,
			isHotBounce: false,
			baseMarkerEnd,
			midX: labelMidX,
			midY: labelMidY,
			bbox: routeBbox,
		});
	}

	if (!canPatchInPlace) {
		// Nudge labeled pills clear of sibling edge strokes & paint fail/wrap edges below forward labeled edges
		const labeledHandles: IRenderedEdgeHandle[] = [];
		for (const h of ctx.edgeHandles.values()) {
			if (!h.labelBg || !h.labelText) {
				continue;
			}
			labeledHandles.push(h);
			const countCrossings = (cx: number, cy: number): number => {
				const box: IMissionEdgeObstacle = { minX: cx - h.pillW / 2 - 4, maxX: cx + h.pillW / 2 + 4, minY: cy - 11, maxY: cy + 11 };
				let hits = 0;
				for (const [otherId, pts] of routePointsByEdgeId.entries()) {
					if (otherId === h.edge.id) {
						continue;
					}
					for (let i = 0; i < pts.length - 1; i++) {
						if (segmentCrossesRect(pts[i], pts[i + 1], box)) {
							hits++;
						}
					}
				}
				return hits;
			};
			const baseHits = countCrossings(h.midX, h.midY);
			if (baseHits > 0) {
				const nudges: readonly (readonly [number, number])[] = [
					[-16, 0], [16, 0], [-28, 0], [28, 0], [-42, 0], [42, 0], [-56, 0], [56, 0],
					[0, -18], [0, 18], [0, -30], [0, 30],
				];
				let bestX = h.midX;
				let bestY = h.midY;
				let bestHits = baseHits;
				for (const [dx, dy] of nudges) {
					const cx = Math.round((h.midX + dx) * 10) / 10;
					const cy = Math.round((h.midY + dy) * 10) / 10;
					const cardOverlap = allObstacles.some(o => cx + h.pillW / 2 > o.box.minX + 8 && cx - h.pillW / 2 < o.box.maxX - 8 && cy + 10 > o.box.minY + 8 && cy - 10 < o.box.maxY - 8);
					if (cardOverlap) {
						continue;
					}
					const hits = countCrossings(cx, cy);
					if (hits < bestHits) {
						bestHits = hits;
						bestX = cx;
						bestY = cy;
						if (hits === 0) {
							break;
						}
					}
				}
				if (bestX !== h.midX || bestY !== h.midY) {
					h.midX = bestX;
					h.midY = bestY;
					h.labelBg.setAttribute('x', String(bestX - h.pillW / 2));
					h.labelBg.setAttribute('y', String(bestY - 10));
					h.labelText.setAttribute('x', String(bestX));
					h.labelText.setAttribute('y', String(bestY));
				}
			}
		}
		// Append fail/wrap-around labeled edges first so forward labeled pills always paint above them!
		labeledHandles.sort((a, b) => {
			const aFail = getMissionEdgeKind(a.edge) === 'fail' ? 0 : 1;
			const bFail = getMissionEdgeKind(b.edge) === 'fail' ? 0 : 1;
			return aFail - bFail;
		});
		for (const h of labeledHandles) {
			ctx.edgesLayerEl.appendChild(h.group);
		}
	}

	if (movedNodeId) {
		const updatedBox = currentObstacleById.get(movedNodeId);
		if (updatedBox) {
			ctx.lastNodeObstacleById.set(movedNodeId, updatedBox);
		}
	} else {
		ctx.lastNodeObstacleById.clear();
		for (const [id, box] of currentObstacleById) {
			ctx.lastNodeObstacleById.set(id, box);
		}
	}

	return { rebuilt: !canPatchInPlace };
}

export interface IOrchEdgeSyncContext {
	readonly edgesLayerEl: SVGGElement;
	readonly tokenGliderLayerEl: SVGGElement;
	readonly edgeDisposables: DisposableStore;
	readonly edgeHandles: Map<string, IRenderedEdgeHandle>;
	readonly livePuckHandles: Map<string, ILivePuckHandle>;
	readonly orchAnchorButtons: Map<string, HTMLButtonElement>;
	readonly deptHandles: ReadonlyMap<string, IOrchDeptHandle>;
	readonly deptPillRectById: Map<string, { readonly dept: IOrchestrationDepartmentGroup; readonly x: number; readonly y: number; readonly w: number }>;
	readonly lastNodeObstacleById: Map<string, IMissionEdgeObstacle>;
	readonly orchRuntime: IOrchestrationRuntimeState | undefined;
	readonly selectedEdgeKey: string | undefined;
	readonly animationsPaused: boolean;
	readonly clearGliderDom: () => void;
	readonly onSelectEdge?: (edge: IMissionDagEdge | undefined) => void;
	readonly onRenameEdgeLabel?: (fromId: string, toId: string, nextLabel: string) => void;
	readonly onEdgeContextMenu?: (edge: IMissionDagEdge, clientX: number, clientY: number) => void;
	readonly startInlineEdgeLabelEdit: (edgeId: string) => void;
	readonly onOpenOrchestrationTokenPopover?: (staffLabel: string, token: IOrchestrationToken, anchorEl: HTMLElement, options?: { readonly focusSection?: 'barrier' | 'scope' | 'rework'; readonly staffNodeId?: string }) => void;
	readonly getLiveOrchToken: (tokenId: string) => IOrchestrationToken | undefined;
	readonly resolveStaffLabel: (staffNodeId: string) => string;
	readonly seenTokenHopSignatures: Set<string>;
	readonly registerOrchBurst: (burst: IEdgeTransitBurst, now: number) => void;
	lastEdgeStructureKey: string;
}

interface ILiveOrchEdgeFlow {
	readonly token: IOrchestrationToken;
	readonly tokenId: string;
	readonly waveId: string;
	readonly kind: 'dispatch' | 'return' | 'rework';
	readonly label: string;
	readonly colorHex?: string;
}

function roundedPolylineToSvgPath(points: readonly { readonly x: number; readonly y: number }[], cornerRadius: number): string {
	if (points.length === 0) {
		return '';
	}
	const r1 = (n: number) => Math.round(n * 10) / 10;
	if (points.length === 1) {
		return `M ${r1(points[0].x)} ${r1(points[0].y)}`;
	}
	const parts: string[] = [`M ${r1(points[0].x)} ${r1(points[0].y)}`];
	for (let i = 1; i < points.length - 1; i++) {
		const prev = points[i - 1];
		const cur = points[i];
		const next = points[i + 1];
		const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
		const d2 = Math.hypot(next.x - cur.x, next.y - cur.y);
		if (d1 < 0.5 || d2 < 0.5) {
			parts.push(`L ${r1(cur.x)} ${r1(cur.y)}`);
			continue;
		}
		const r = Math.min(cornerRadius, d1 * 0.45, d2 * 0.45);
		const ax = cur.x - ((cur.x - prev.x) / d1) * r;
		const ay = cur.y - ((cur.y - prev.y) / d1) * r;
		const bx = cur.x + ((next.x - cur.x) / d2) * r;
		const by = cur.y + ((next.y - cur.y) / d2) * r;
		parts.push(`L ${r1(ax)} ${r1(ay)} Q ${r1(cur.x)} ${r1(cur.y)} ${r1(bx)} ${r1(by)}`);
	}
	const last = points[points.length - 1];
	parts.push(`L ${r1(last.x)} ${r1(last.y)}`);
	return parts.join(' ');
}

function segmentCrossesRect(
	a: { readonly x: number; readonly y: number },
	b: { readonly x: number; readonly y: number },
	box: IMissionEdgeObstacle,
): boolean {
	if (Math.abs(a.x - b.x) < 1) {
		const minY = Math.min(a.y, b.y);
		const maxY = Math.max(a.y, b.y);
		return a.x >= box.minX && a.x <= box.maxX && minY < box.maxY && maxY > box.minY;
	}
	if (Math.abs(a.y - b.y) < 1) {
		const minX = Math.min(a.x, b.x);
		const maxX = Math.max(a.x, b.x);
		return a.y >= box.minY && a.y <= box.maxY && minX < box.maxX && maxX > box.minX;
	}
	return false;
}

function repositionDeptPillsAwayFromRoutes(
	deptHandles: ReadonlyMap<string, IOrchDeptHandle>,
	deptPillRectById: Map<string, { readonly dept: IOrchestrationDepartmentGroup; readonly x: number; readonly y: number; readonly w: number }>,
	allRoutePolylines: readonly (readonly { readonly x: number; readonly y: number }[])[],
): IMissionEdgeObstacle[] {
	const pillBoxes: IMissionEdgeObstacle[] = [];
	for (const handle of deptHandles.values()) {
		const minX = handle.boxX + 12;
		const maxX = Math.max(minX, handle.boxX + handle.boxW - handle.w - 12);
		const candidates: number[] = [
			Math.min(maxX, handle.boxX + 16),
			maxX,
			Math.round(minX + (maxX - minX) / 2),
			minX,
		];
		for (let step = 1; step <= 7; step++) {
			const fracX = Math.round(minX + ((maxX - minX) * step) / 8);
			if (!candidates.includes(fracX)) {
				candidates.push(fracX);
			}
		}
		const pillY = handle.boxY - 12;
		let bestX = candidates[0];
		let bestCrossings = Infinity;
		for (const cx of candidates) {
			const box: IMissionEdgeObstacle = { minX: cx - 10, maxX: cx + handle.w + 10, minY: pillY - 8, maxY: pillY + 32 };
			let crossings = 0;
			for (const pts of allRoutePolylines) {
				for (let i = 0; i < pts.length - 1; i++) {
					if (segmentCrossesRect(pts[i], pts[i + 1], box)) {
						crossings++;
					}
				}
			}
			if (crossings < bestCrossings) {
				bestCrossings = crossings;
				bestX = cx;
				if (crossings === 0) {
					break;
				}
			}
		}
		if (handle.x !== bestX) {
			handle.x = bestX;
			handle.pillBg.setAttribute('x', String(bestX));
			let gi = 0;
			for (let r = 0; r < 3; r++) {
				for (let c = 0; c < 2; c++) {
					const dot = handle.grips[gi++];
					dot?.setAttribute('cx', String(bestX + 12 + c * 4));
				}
			}
			handle.pillText.setAttribute('x', String(bestX + 24));
			deptPillRectById.set(handle.dept.id, { dept: handle.dept, x: bestX, y: handle.boxY, w: handle.w });
		}
		pillBoxes.push({ minX: handle.x - 6, maxX: handle.x + handle.w + 6, minY: pillY - 4, maxY: pillY + 28 });
	}
	return pillBoxes;
}

function detourPolylineAroundPillBoxes(
	points: readonly { readonly x: number; readonly y: number }[],
	pillBoxes: readonly IMissionEdgeObstacle[],
	cornerRadius: number,
): { readonly points: readonly { readonly x: number; readonly y: number }[]; readonly path?: string; readonly midX?: number; readonly midY?: number } {
	if (pillBoxes.length === 0 || points.length < 2) {
		return { points };
	}
	let changed = false;
	const out: { readonly x: number; readonly y: number }[] = [points[0]];
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		if (Math.abs(a.x - b.x) < 1) {
			const minY = Math.min(a.y, b.y);
			const maxY = Math.max(a.y, b.y);
			const hit = pillBoxes.find(box => a.x >= box.minX && a.x <= box.maxX && minY < box.maxY && maxY > box.minY);
			if (hit) {
				const leftX = hit.minX - 12;
				const rightX = hit.maxX + 12;
				const detourX = Math.abs(a.x - rightX) <= Math.abs(a.x - leftX) ? rightX : leftX;
				const goingDown = b.y > a.y;
				const yTop = Math.max(minY + 8, hit.minY - 10);
				const yBot = Math.min(maxY - 8, hit.maxY + 10);
				if (yBot > yTop + 4) {
					changed = true;
					if (goingDown) {
						out.push({ x: a.x, y: yTop }, { x: detourX, y: yTop }, { x: detourX, y: yBot }, { x: a.x, y: yBot });
					} else {
						out.push({ x: a.x, y: yBot }, { x: detourX, y: yBot }, { x: detourX, y: yTop }, { x: a.x, y: yTop });
					}
				}
			}
		} else if (Math.abs(a.y - b.y) < 1) {
			const minX = Math.min(a.x, b.x);
			const maxX = Math.max(a.x, b.x);
			const hit = pillBoxes.find(box => a.y >= box.minY && a.y <= box.maxY && minX < box.maxX && maxX > box.minX);
			if (hit) {
				const topY = hit.minY - 10;
				const botY = hit.maxY + 10;
				const detourY = Math.abs(a.y - botY) <= Math.abs(a.y - topY) ? botY : topY;
				const goingRight = b.x > a.x;
				const xLeft = Math.max(minX + 8, hit.minX - 10);
				const xRight = Math.min(maxX - 8, hit.maxX + 10);
				if (xRight > xLeft + 4) {
					changed = true;
					if (goingRight) {
						out.push({ x: xLeft, y: a.y }, { x: xLeft, y: detourY }, { x: xRight, y: detourY }, { x: xRight, y: a.y });
					} else {
						out.push({ x: xRight, y: a.y }, { x: xRight, y: detourY }, { x: xLeft, y: detourY }, { x: xLeft, y: a.y });
					}
				}
			}
		}
		out.push(b);
	}
	if (!changed) {
		return { points };
	}
	const mid = samplePolylinePointAtFraction(out, 0.5);
	return { points: out, path: roundedPolylineToSvgPath(out, Math.min(10, cornerRadius)), midX: mid.x, midY: mid.y };
}

function chooseNonOverlappingBeaconPoint(
	points: readonly { readonly x: number; readonly y: number }[],
	puckW: number,
	avoidBoxes: readonly ILabelBox[],
	cardBoxes: readonly ILabelBox[],
	hasPairLabel: boolean,
	gliderIndex: number,
): { readonly frac: number; readonly x: number; readonly y: number } {
	const candidates = hasPairLabel
		? (gliderIndex % 2 === 0 ? [0.28, 0.72, 0.36, 0.64, 0.20, 0.80, 0.50] : [0.72, 0.28, 0.64, 0.36, 0.80, 0.20, 0.50])
		: [0.50, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.20, 0.80];
	const halfW = puckW / 2;
	const pStart = points[0];
	const pEnd = points[points.length - 1];

	let best = { frac: candidates[0], x: 0, y: 0, score: -Infinity };
	for (const frac of candidates) {
		const pt = samplePolylinePointAtFraction(points, frac);
		let cardHit = false;
		for (const cb of cardBoxes) {
			if (Math.abs(cb.x - pt.x) < (cb.w + puckW) / 2 + 8 && Math.abs(cb.y - pt.y) < (cb.h + 28) / 2 + 8) {
				cardHit = true;
				break;
			}
		}
		if (!cardHit && pStart && pEnd) {
			const minEndDist = Math.min(Math.hypot(pt.x - pStart.x, pt.y - pStart.y), Math.hypot(pt.x - pEnd.x, pt.y - pEnd.y));
			if (minEndDist < halfW + 18) {
				cardHit = true;
			}
		}
		let minAvoid = Infinity;
		let labelHit = false;
		for (const b of avoidBoxes) {
			const dx = Math.abs(b.x - pt.x) - ((b.w + puckW) / 2 + 20);
			const dy = Math.abs(b.y - pt.y) - ((b.h + 28) / 2 + 18);
			if (dx < 0 && dy < 0) {
				labelHit = true;
			}
			minAvoid = Math.min(minAvoid, Math.max(dx, dy));
		}
		if (!cardHit && !labelHit) {
			return { frac, x: pt.x, y: pt.y };
		}
		const score = (cardHit ? -10_000 : 0) + (Number.isFinite(minAvoid) ? minAvoid : 0);
		if (score > best.score) {
			best = { frac, x: pt.x, y: pt.y, score };
		}
	}
	return { frac: best.frac, x: best.x, y: best.y };
}

function chooseNonOverlappingPuckFraction(
	points: readonly { readonly x: number; readonly y: number }[],
	puckW: number,
	avoidBoxes: readonly ILabelBox[],
	cardBoxes: readonly ILabelBox[],
	hasPairLabel: boolean,
	gliderIndex: number,
): number {
	return chooseNonOverlappingBeaconPoint(points, puckW, avoidBoxes, cardBoxes, hasPairLabel, gliderIndex).frac;
}

export function syncOrchestrationEdgesSvg(
	nodes: readonly IOrchestrationGraphNode[],
	edges: readonly IOrchestrationGraphEdge[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
	direction: 'LR' | 'TD',
	layoutMode: OrchestrationLayoutMode | undefined,
	movedNodeIdInput: string | undefined,
	ctx: IOrchEdgeSyncContext,
): { readonly rebuilt: boolean } {
	if (edges.length === 0) {
		ctx.edgeDisposables.clear();
		ctx.edgeHandles.clear();
		ctx.clearGliderDom();
		ctx.lastNodeObstacleById.clear();
		ctx.lastEdgeStructureKey = '';
		while (ctx.edgesLayerEl.firstChild) {
			ctx.edgesLayerEl.removeChild(ctx.edgesLayerEl.firstChild);
		}
		for (const btn of ctx.orchAnchorButtons.values()) {
			btn.classList.remove('is-occupied', 'is-bidir-anchor', 'is-cycle-anchor', 'is-wb-anchor');
		}
		return { rebuilt: true };
	}

	const nodeById = new Map(nodes.map(n => [n.id, n]));
	const currentObstacleById = new Map<string, IMissionEdgeObstacle>();
	for (const n of nodes) {
		const pos = positions.get(n.id);
		if (!pos) {
			continue;
		}
		const sz = getRenderedOrchestrationNodeSize(n);
		const pad = 12;
		currentObstacleById.set(n.id, {
			minX: pos.x - sz.width / 2 - pad,
			maxX: pos.x + sz.width / 2 + pad,
			minY: pos.y - sz.height / 2 - pad,
			maxY: pos.y + sz.height / 2 + pad,
		});
	}

	// Collect live token-passing flows, hot-bounce edges, and active whiteboard pointers
	const liveFlowByEdgeKey = new Map<string, ILiveOrchEdgeFlow>();
	const hotBounceEdgeKeys = new Set<string>();
	const activeWbPairs = new Set<string>();
	const edgeKeySet = new Set(edges.map(e => `${e.from}->${e.to}`));

	if (ctx.orchRuntime) {
		const allTokens = Object.values(ctx.orchRuntime.tokens);
		const activeParentIds = new Set(
			allTokens.filter(t => t.status === 'waiting_join' || t.status === 'active').map(t => t.id),
		);
		for (const tok of allTokens) {
			if (tok.edgeBounceCounts) {
				for (const [eKey, cnt] of Object.entries(tok.edgeBounceCounts)) {
					if (cnt >= 3) {
						hotBounceEdgeKeys.add(eKey);
					}
				}
			}
			const isLive = tok.status === 'active' || tok.status === 'blocked' || tok.status === 'waiting_join';
			if (isLive) {
				for (const wp of tok.whiteboardPointers ?? []) {
					activeWbPairs.add(`${tok.nodeId}->${wp.whiteboardId}`);
					activeWbPairs.add(`${wp.whiteboardId}->${tok.nodeId}`);
				}
				for (const ref of tok.contextRefs ?? []) {
					if (ref.kind === 'whiteboard') {
						const wbId = ref.ptr.replace(/^wb:/, '');
						activeWbPairs.add(`${tok.nodeId}->${wbId}`);
						activeWbPairs.add(`${wbId}->${tok.nodeId}`);
					}
				}
			}
			if (isLive && tok.fromNodeId && tok.fromNodeId !== tok.nodeId) {
				const fwdKey = `${tok.fromNodeId}->${tok.nodeId}`;
				if (edgeKeySet.has(fwdKey)) {
					const isRework = tok.dispatchKind === 'reject' || tok.dispatchKind === 'retry';
					const destNode = nodeById.get(tok.nodeId);
					const srcNode = nodeById.get(tok.fromNodeId);
					const destHex = isRework ? '#fb7185' : resolveAdeNodeColorHex(destNode?.color ?? srcNode?.color);
					liveFlowByEdgeKey.set(fwdKey, {
						token: tok,
						tokenId: tok.id,
						waveId: tok.waveId,
						kind: isRework ? 'rework' : 'dispatch',
						label: isRework ? `↻ ${tok.id}` : `⚡ ${tok.id}`,
						colorHex: destHex,
					});
				}
			}
			const hopLog = tok.hopLog;
			if (tok.status === 'completed' && tok.parentTokenId && activeParentIds.has(tok.parentTokenId) && hopLog && hopLog.length > 0) {
				const lastHop = hopLog[hopLog.length - 1];
				if (lastHop.event === 'return' && lastHop.fromNodeId && lastHop.toNodeId && lastHop.fromNodeId !== lastHop.toNodeId) {
					const retKey = `${lastHop.fromNodeId}->${lastHop.toNodeId}`;
					if (edgeKeySet.has(retKey) && !liveFlowByEdgeKey.has(retKey)) {
						liveFlowByEdgeKey.set(retKey, {
							token: tok,
							tokenId: tok.id,
							waveId: tok.waveId,
							kind: 'return',
							label: `↩ ${tok.id}`,
							colorHex: '#34d399',
						});
					}
				}
			}
		}
	}

	const nextStructureKey = `orch\x1e${direction}\x1e${layoutMode ?? ''}\x1e${ctx.animationsPaused ? '1' : '0'}\x1e` + edges.map(e => {
		const ek = `${e.from}->${e.to}`;
		const lf = liveFlowByEdgeKey.get(ek);
		const fc = nodeById.get(e.from)?.color ?? '';
		const tc = nodeById.get(e.to)?.color ?? '';
		return `${e.id}\x1f${e.from}\x1f${e.to}\x1f${e.label ?? ''}\x1f${e.dashed ? '1' : '0'}\x1f${fc}\x1f${tc}\x1f${lf ? `${lf.tokenId}:${lf.kind}` : ''}\x1f${hotBounceEdgeKeys.has(ek) ? '1' : '0'}\x1f${activeWbPairs.has(ek) ? '1' : '0'}`;
	}).join('\x1e');

	const rawRouteById = computeOrchestrationMultiAnchorRoutes(nodes, edges, positions, {
		cornerRadius: 16,
		direction,
		layoutMode,
	});
	const routeById = new Map<string, IOrchestrationRoutedEdge>();
	for (const edge of edges) {
		const raw = rawRouteById.get(edge.id);
		if (raw) {
			routeById.set(edge.id, reanchorOrchestrationRoute(edge, raw, nodeById, positions, roundedPolylineToSvgPath, samplePolylinePointAtFraction));
		}
	}

	const canPatchInPlace = nextStructureKey === ctx.lastEdgeStructureKey && ctx.edgeHandles.size === routeById.size;
	const movedNodeId = canPatchInPlace ? movedNodeIdInput : undefined;

	let movedDirtyBox: IMissionEdgeObstacle | undefined;
	if (movedNodeId) {
		const prevBox = ctx.lastNodeObstacleById.get(movedNodeId);
		const currBox = currentObstacleById.get(movedNodeId);
		const margin = 32;
		if (prevBox && currBox) {
			movedDirtyBox = {
				minX: Math.min(prevBox.minX, currBox.minX) - margin,
				maxX: Math.max(prevBox.maxX, currBox.maxX) + margin,
				minY: Math.min(prevBox.minY, currBox.minY) - margin,
				maxY: Math.max(prevBox.maxY, currBox.maxY) + margin,
			};
		} else if (currBox ?? prevBox) {
			const b = (currBox ?? prevBox)!;
			movedDirtyBox = {
				minX: b.minX - margin,
				maxX: b.maxX + margin,
				minY: b.minY - margin,
				maxY: b.maxY + margin,
			};
		}
	}

	// Shift department header pills into clear segments & collect pill rects so wires never cross pill text
	const deptPillBoxes = repositionDeptPillsAwayFromRoutes(
		ctx.deptHandles,
		ctx.deptPillRectById,
		[...routeById.values()].map(r => r.points),
	);

	if (!canPatchInPlace) {
		ctx.edgeDisposables.clear();
		ctx.edgeHandles.clear();
		ctx.clearGliderDom();
		ctx.lastNodeObstacleById.clear();
		while (ctx.edgesLayerEl.firstChild) {
			ctx.edgesLayerEl.removeChild(ctx.edgesLayerEl.firstChild);
		}
		ctx.lastEdgeStructureKey = nextStructureKey;
	}

	// Update anchor pin occupancy classes cleanly (avoid wiping unrelated anchors on partial drag if unchanged, else fast reset)
	for (const btn of ctx.orchAnchorButtons.values()) {
		btn.classList.remove('is-occupied', 'is-bidir-anchor', 'is-cycle-anchor', 'is-wb-anchor');
	}

	const renderedBidirLabelKeys = new Set<string>();
	const labeledBidirPairs = new Set<string>();
	for (const e of edges) {
		if (e.label) {
			const pairId = e.from < e.to ? `${e.from}<->${e.to}` : `${e.to}<->${e.from}`;
			labeledBidirPairs.add(pairId);
		}
	}
	const placedLabelBoxes: ILabelBox[] = [];
	if (movedNodeId) {
		for (const h of ctx.edgeHandles.values()) {
			if (h.labelBg && h.edge.from !== movedNodeId && h.edge.to !== movedNodeId) {
				placedLabelBoxes.push({ x: h.midX, y: h.midY, w: h.pillW, h: 20 });
			}
		}
	}

	const pendingPucks: Array<{
		readonly edge: IOrchestrationGraphEdge;
		readonly liveFlow: ILiveOrchEdgeFlow;
		readonly routePath: string;
		readonly routePoints: readonly { readonly x: number; readonly y: number }[];
		readonly edgeAccentHex: string;
		readonly hasPairLabel: boolean;
	}> = [];

	for (const edge of edges) {
		const rawRoute = routeById.get(edge.id);
		if (!rawRoute) {
			continue;
		}
		const fromNode = nodeById.get(edge.from);
		const toNode = nodeById.get(edge.to);
		const isWhiteboardLink = fromNode?.kind === 'whiteboard' || toNode?.kind === 'whiteboard';
		const isTrueCycle = rawRoute.isCycleBackEdge && !rawRoute.isBidirectional;
		const edgeKey = `${edge.from}->${edge.to}`;
		const liveFlow = liveFlowByEdgeKey.get(edgeKey);
		const isHotBounce = hotBounceEdgeKeys.has(edgeKey);
		const isActiveWbLink = isWhiteboardLink && activeWbPairs.has(edgeKey);

		const isDownwardTier = fromNode?.kind === 'staff' && toNode?.kind === 'staff'
			&& (fromNode.tier ?? 99) < (toNode.tier ?? 99);
		const preferredColorToken = isWhiteboardLink
			? (toNode?.kind === 'whiteboard' ? (toNode.color ?? fromNode?.color) : (fromNode?.color ?? toNode?.color))
			: isTrueCycle
				? 'amber'
				: isDownwardTier
					? (toNode?.color ?? fromNode?.color)
					: (fromNode?.color ?? toNode?.color);
		const edgeAccentHex = liveFlow?.kind === 'rework'
			? '#fb7185'
			: isTrueCycle
				? '#f59e0b'
				: resolveAdeNodeColorHex(preferredColorToken) ?? (isWhiteboardLink ? '#a78bfa' : rawRoute.isBidirectional ? '#38bdf8' : '#34d399');

		// Mark occupied multi-anchor pins
		const fromPin = ctx.orchAnchorButtons.get(`${edge.from}:${rawRoute.fromAnchor.side}:${rawRoute.fromAnchor.slot}`);
		const toPin = ctx.orchAnchorButtons.get(`${edge.to}:${rawRoute.toAnchor.side}:${rawRoute.toAnchor.slot}`);
		for (const pin of [fromPin, toPin]) {
			if (!pin) {
				continue;
			}
			pin.classList.add('is-occupied');
			pin.style.setProperty('--pin-accent', edgeAccentHex);
			if (isWhiteboardLink) {
				pin.classList.add('is-wb-anchor');
			} else if (isTrueCycle) {
				pin.classList.add('is-cycle-anchor');
			} else if (rawRoute.isBidirectional) {
				pin.classList.add('is-bidir-anchor');
			}
		}

		const existing = canPatchInPlace ? ctx.edgeHandles.get(edge.id) : undefined;
		if (existing && movedNodeId) {
			const isIncident = edge.from === movedNodeId || edge.to === movedNodeId;
			const intersectsMoved = movedDirtyBox ? boxesOverlap(existing.bbox, movedDirtyBox) : true;
			if (!isIncident && !intersectsMoved) {
				continue;
			}
		}

		const detoured = detourPolylineAroundPillBoxes(rawRoute.points, deptPillBoxes, 14);
		const route = detoured.path
			? { ...rawRoute, points: detoured.points, path: detoured.path, midX: detoured.midX ?? rawRoute.midX, midY: detoured.midY ?? rawRoute.midY }
			: rawRoute;

		if (existing) {
			const nextBbox = computeRouteBbox(route.points);
			existing.bbox = nextBbox;
			existing.group.setAttribute('data-from-anchor', `${route.fromAnchor.side}:${route.fromAnchor.slot}`);
			existing.group.setAttribute('data-to-anchor', `${route.toAnchor.side}:${route.toAnchor.slot}`);
			if (existing.path.getAttribute('d') !== route.path) {
				existing.path.setAttribute('d', route.path);
				existing.hitPath.setAttribute('d', route.path);
				if (existing.haloPath) {
					existing.haloPath.setAttribute('d', route.path);
				}
				if (existing.flowStreamPath) {
					existing.flowStreamPath.setAttribute('d', route.path);
				}
				const livePuck = ctx.livePuckHandles.get(edge.id);
				if (livePuck) {
					if (ctx.animationsPaused) {
						const pt = samplePolylinePointAtFraction(route.points, livePuck.staticFrac);
						livePuck.group.setAttribute('transform', `translate(${pt.x}, ${pt.y})`);
					} else {
						livePuck.group.style.offsetPath = `path("${route.path}")`;
						livePuck.group.style.setProperty('offset-rotate', '0deg');
					}
				}
			}
			if (existing.labelBg && existing.labelText) {
				const resolved = resolveNonOverlappingLabelCenter(route.midX, route.midY, existing.pillW, placedLabelBoxes);
				existing.midX = resolved.x;
				existing.midY = resolved.y;
				existing.labelBg.setAttribute('x', String(resolved.x - existing.pillW / 2));
				existing.labelBg.setAttribute('y', String(resolved.y - 10));
				existing.labelText.setAttribute('x', String(resolved.x));
				existing.labelText.setAttribute('y', String(resolved.y));
			} else {
				existing.midX = route.midX;
				existing.midY = route.midY;
			}
			continue;
		}

		const isSelected = Boolean(ctx.selectedEdgeKey && ctx.selectedEdgeKey === edgeKey);
		const isReworkFlow = liveFlow?.kind === 'rework';
		const edgeClasses = ['ade-mission-edge-group', 'is-orch-edge'];
		if (route.isBidirectional) {
			edgeClasses.push('is-bidirectional');
		}
		if (isTrueCycle) {
			edgeClasses.push('is-cycle-back');
		}
		if (isWhiteboardLink) {
			edgeClasses.push('is-whiteboard-link');
		}
		if (isActiveWbLink) {
			edgeClasses.push('is-wb-active-link');
		}
		if (edge.dashed) {
			edgeClasses.push('is-dashed');
		}
		if (isHotBounce) {
			edgeClasses.push('is-hot-bounce');
		}
		if (isSelected) {
			edgeClasses.push('is-selected');
		}
		if (liveFlow) {
			edgeClasses.push('is-orch-live-flow');
			if (liveFlow.kind === 'return') {
				edgeClasses.push('is-return-flow');
			} else if (liveFlow.kind === 'rework') {
				edgeClasses.push('is-orch-rework-flow');
			} else {
				edgeClasses.push('is-dispatch-flow');
			}
		}

		const group = svgEl('g', {
			class: edgeClasses.join(' '),
			'data-edge-id': edge.id,
			'data-from': edge.from,
			'data-to': edge.to,
			'data-from-anchor': `${route.fromAnchor.side}:${route.fromAnchor.slot}`,
			'data-to-anchor': `${route.toAnchor.side}:${route.toAnchor.slot}`,
			'data-bidirectional': String(route.isBidirectional),
			'data-cycle-back': String(route.isCycleBackEdge),
			...(isHotBounce ? { 'data-hot-bounce': 'true' } : {}),
			...(liveFlow ? { 'data-live-token-id': liveFlow.tokenId, 'data-live-flow-kind': liveFlow.kind } : {}),
			...(isSelected ? { 'data-edge-selected': 'true' } : {}),
		});
		group.style.setProperty('--edge-accent', liveFlow?.colorHex ?? edgeAccentHex);

		const hitPath = svgEl('path', { class: 'ade-mission-edge-hit', d: route.path });
		group.appendChild(hitPath);

		const haloPath = svgEl('path', {
			class: `ade-orch-edge-halo${liveFlow ? ' is-live' : ''}${isActiveWbLink ? ' is-wb-active' : ''}`,
			d: route.path,
		});
		group.appendChild(haloPath);

		const baseMarkerEnd = isReworkFlow
			? 'url(#ade-mission-arrow-fail)'
			: liveFlow?.kind === 'return'
				? 'url(#ade-mission-arrow-preset-emerald)'
				: isTrueCycle
					? 'url(#ade-mission-arrow-cycle)'
					: isWhiteboardLink
						? resolveArrowMarkerUrlForColor(preferredColorToken, 'ade-mission-arrow-whiteboard')
						: resolveArrowMarkerUrlForColor(preferredColorToken, route.isBidirectional ? 'ade-mission-arrow-bidir' : 'ade-mission-arrow-default');

		const path = svgEl('path', {
			class: 'ade-mission-edge-path',
			d: route.path,
			'marker-end': isSelected ? 'url(#ade-mission-arrow-active)' : baseMarkerEnd,
		});
		group.appendChild(path);

		let flowStreamPath: SVGPathElement | undefined;
		if (liveFlow) {
			flowStreamPath = svgEl('path', {
				class: `ade-orch-edge-flow-stream${liveFlow.kind === 'return' ? ' is-return' : isReworkFlow ? ' is-rework' : ''}`,
				d: route.path,
			});
			group.appendChild(flowStreamPath);
		}

		const compatEdge: IMissionDagEdge = {
			id: edge.id,
			from: edge.from,
			to: edge.to,
			...(edge.label ? { label: edge.label } : {}),
		};
		ctx.edgeDisposables.add(addDisposableListener(group, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button === 0) {
				e.stopPropagation();
			}
		}));
		ctx.edgeDisposables.add(addDisposableListener(group, EventType.CLICK, (e: MouseEvent) => {
			e.stopPropagation();
			ctx.onSelectEdge?.(compatEdge);
		}));
		ctx.edgeDisposables.add(addDisposableListener(group, EventType.DBLCLICK, (e: MouseEvent) => {
			if (!ctx.onRenameEdgeLabel) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			ctx.startInlineEdgeLabelEdit(edge.id);
		}));
		ctx.edgeDisposables.add(addDisposableListener(group, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			if (!ctx.onEdgeContextMenu) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			ctx.onEdgeContextMenu(compatEdge, e.clientX, e.clientY);
		}));

		let labelBg: SVGRectElement | undefined;
		let labelText: SVGTextElement | undefined;
		let pillW = 0;
		let labelMidX = route.midX;
		let labelMidY = route.midY;
		let shouldRenderLabel = Boolean(edge.label);
		if (shouldRenderLabel && route.isBidirectional && edge.label) {
			const pairId = edge.from < edge.to ? `${edge.from}<->${edge.to}` : `${edge.to}<->${edge.from}`;
			const bidirLabelKey = `${pairId}|${edge.label.trim()}`;
			if (renderedBidirLabelKeys.has(bidirLabelKey)) {
				shouldRenderLabel = false;
			} else {
				renderedBidirLabelKeys.add(bidirLabelKey);
			}
		}
		if (shouldRenderLabel && edge.label) {
			const labelLayout = computeMissionEdgeLabelLayout(edge.label);
			pillW = Math.max(labelLayout.pillWidth, measureSvgPillWidth(labelLayout.displayText, 16, 36, 176));
			const resolved = resolveNonOverlappingLabelCenter(route.midX, route.midY, pillW, placedLabelBoxes);
			labelMidX = resolved.x;
			labelMidY = resolved.y;
			labelBg = svgEl('rect', {
				class: 'ade-mission-edge-label-bg',
				x: String(labelMidX - pillW / 2),
				y: String(labelMidY - 10),
				width: String(pillW),
				height: '20',
				rx: '6',
			});
			labelText = svgEl('text', {
				class: 'ade-mission-edge-label-text',
				x: String(labelMidX),
				y: String(labelMidY),
			});
			labelText.textContent = labelLayout.displayText;
			if (labelLayout.displayText !== edge.label.trim()) {
				const titleEl = svgEl('title');
				titleEl.textContent = edge.label;
				group.appendChild(titleEl);
			}
			group.appendChild(labelBg);
			group.appendChild(labelText);
		}

		ctx.edgesLayerEl.appendChild(group);
		ctx.edgeHandles.set(edge.id, {
			group,
			path,
			hitPath,
			haloPath,
			flowStreamPath,
			labelBg,
			labelText,
			pillW,
			edge: compatEdge,
			isCrossHost: false,
			isWhiteboardLink,
			isCycleBack: isTrueCycle,
			isBidirectional: route.isBidirectional,
			isCriticalEdge: false,
			isReworkFlow,
			isHotBounce,
			baseMarkerEnd,
			midX: labelMidX,
			midY: labelMidY,
			bbox: computeRouteBbox(route.points),
		});

		if (liveFlow) {
			const pairId = edge.from < edge.to ? `${edge.from}<->${edge.to}` : `${edge.to}<->${edge.from}`;
			pendingPucks.push({
				edge,
				liveFlow,
				routePath: route.path,
				routePoints: route.points,
				edgeAccentHex,
				hasPairLabel: Boolean(labelBg) || (route.isBidirectional && labeledBidirPairs.has(pairId)),
			});
		}
	}

	// Mount clickable non-overlapping Baton Comet Pucks AFTER all edge labels are placed!
	if (!canPatchInPlace) {
		for (const h of ctx.edgeHandles.values()) {
			if (h.labelBg) {
				ctx.edgesLayerEl.appendChild(h.group);
			}
		}
		const puckAvoidBoxes: ILabelBox[] = [
			...placedLabelBoxes,
			...deptPillBoxes.map(b => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, w: b.maxX - b.minX, h: b.maxY - b.minY })),
		];
		let liveGliderIndex = 0;
		for (const item of pendingPucks) {
			const { edge, liveFlow, routePath, routePoints, edgeAccentHex, hasPairLabel } = item;
			const puckColor = liveFlow.colorHex ?? edgeAccentHex;
			const puckText = liveFlow.label;
			const puckW = Math.max(58, Math.min(118, Math.round(puckText.length * 6.4 + 22)));
			const halfW = puckW / 2;
			const fPos = positions.get(edge.from);
			const tPos = positions.get(edge.to);
			const fNode = nodeById.get(edge.from);
			const tNode = nodeById.get(edge.to);
			const cardBoxes: ILabelBox[] = [];
			if (fPos && fNode) {
				const sz = getRenderedOrchestrationNodeSize(fNode);
				cardBoxes.push({ x: fPos.x, y: fPos.y, w: sz.width + 6, h: sz.height + 6 });
			}
			if (tPos && tNode) {
				const sz = getRenderedOrchestrationNodeSize(tNode);
				cardBoxes.push({ x: tPos.x, y: tPos.y, w: sz.width + 6, h: sz.height + 6 });
			}
			const staticFrac = chooseNonOverlappingPuckFraction(routePoints, puckW, puckAvoidBoxes, cardBoxes, hasPairLabel, liveGliderIndex);
			const anchorPt = samplePolylinePointAtFraction(routePoints, staticFrac);
			puckAvoidBoxes.push({ x: anchorPt.x, y: anchorPt.y, w: puckW, h: 26 });

			const puckGroup = svgEl('g', {
				class: `ade-orch-live-puck is-clickable-puck wave-color-${getMissionWaveColorIndex(liveFlow.waveId)}${liveFlow.kind === 'return' ? ' is-return' : liveFlow.kind === 'rework' ? ' is-rework' : ''}`,
				'data-ade-orch-live-puck': edge.id,
				'data-token-id': liveFlow.tokenId,
				'data-wave-id': liveFlow.waveId,
				'data-flow-kind': liveFlow.kind,
			});
			puckGroup.style.setProperty('--puck-color', puckColor);
			if (ctx.animationsPaused) {
				puckGroup.setAttribute('transform', `translate(${anchorPt.x}, ${anchorPt.y})`);
			} else {
				puckGroup.style.offsetPath = `path("${routePath}")`;
				puckGroup.style.setProperty('offset-rotate', '0deg');
				const delaySec = -(staticFrac * 3.4);
				puckGroup.style.animationDelay = `${delaySec.toFixed(2)}s`;
			}
			const puckTitle = svgEl('title');
			puckTitle.textContent = adeBi(
				localize('adeOrchLivePuckTip', "Baton {0} — click to inspect", liveFlow.tokenId),
				'接力棒 {0} — 点击查看详情',
				liveFlow.tokenId,
			);
			puckGroup.appendChild(puckTitle);
			puckGroup.appendChild(svgEl('rect', { class: 'ade-orch-live-puck-bloom', x: String(-halfW - 4), y: '-13', width: String(puckW + 8), height: '26', rx: '13' }));
			puckGroup.appendChild(svgEl('rect', { class: 'ade-orch-live-puck-pill', x: String(-halfW), y: '-10', width: String(puckW), height: '20', rx: '10' }));
			puckGroup.appendChild(svgEl('circle', { class: 'ade-orch-live-puck-dot', cx: String(-halfW + 8.5), cy: '0', r: '2.6' }));
			const textEl = svgEl('text', { class: 'ade-orch-live-puck-text', x: '4', y: '0.5' });
			textEl.textContent = puckText;
			puckGroup.appendChild(textEl);

			if (ctx.onOpenOrchestrationTokenPopover) {
				ctx.edgeDisposables.add(addDisposableListener(puckGroup, EventType.POINTER_DOWN, (ev: PointerEvent) => {
					if (ev.button === 0) {
						ev.stopPropagation();
					}
				}));
				ctx.edgeDisposables.add(addDisposableListener(puckGroup, EventType.CLICK, (ev: MouseEvent) => {
					ev.stopPropagation();
					const curTok = ctx.getLiveOrchToken(liveFlow.tokenId) ?? liveFlow.token;
					ctx.onOpenOrchestrationTokenPopover?.(
						ctx.resolveStaffLabel(curTok.nodeId),
						curTok,
						puckGroup as unknown as HTMLElement,
						{
							focusSection: liveFlow.kind === 'rework' ? 'rework' : undefined,
							staffNodeId: curTok.nodeId,
						},
					);
				}));
			}

			ctx.tokenGliderLayerEl.appendChild(puckGroup);
			ctx.livePuckHandles.set(edge.id, { group: puckGroup, edgeId: edge.id, staticFrac });
			liveGliderIndex++;
		}

		// Register one-shot 800ms bursts into tracked expiry map (zero permanent leak!)
		if (ctx.orchRuntime && !ctx.animationsPaused) {
			const now = Date.now();
			for (const tok of Object.values(ctx.orchRuntime.tokens)) {
				if (tok.status !== 'active' || !tok.fromNodeId) {
					continue;
				}
				const key = `${tok.fromNodeId}->${tok.nodeId}`;
				if (liveFlowByEdgeKey.has(key)) {
					continue;
				}
				const age = now - tok.arrivedAt;
				const hopSignature = `${tok.id}|${key}|${tok.arrivedAt}`;
				if (age >= -5_000 && age < 800 && !ctx.seenTokenHopSignatures.has(hopSignature)) {
					ctx.seenTokenHopSignatures.add(hopSignature);
					const eh = [...ctx.edgeHandles.values()].find(h => `${h.edge.from}->${h.edge.to}` === key);
					if (eh) {
						eh.group.classList.add('is-token-flowing');
						ctx.registerOrchBurst({
							edgeKey: key,
							edgeId: eh.edge.id,
							tokenId: tok.id,
							waveId: tok.waveId,
							isFail: tok.dispatchKind === 'reject',
							hopSignature,
							expiresAt: now + Math.max(1, 800 - Math.max(0, age)),
						}, now);
					}
				}
			}
		}
	}

	if (movedNodeId) {
		const updatedBox = currentObstacleById.get(movedNodeId);
		if (updatedBox) {
			ctx.lastNodeObstacleById.set(movedNodeId, updatedBox);
		}
	} else {
		ctx.lastNodeObstacleById.clear();
		for (const [id, box] of currentObstacleById) {
			ctx.lastNodeObstacleById.set(id, box);
		}
	}

	return { rebuilt: !canPatchInPlace };
}
