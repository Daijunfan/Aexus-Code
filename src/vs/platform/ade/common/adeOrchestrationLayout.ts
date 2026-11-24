/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IMissionEdgeObstacle, IMissionNodePosition } from './adeMissionDag.js';
import {
	getOrchestrationNodeSize,
	IOrchestrationAnchorPoint,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	IOrchestrationGraphParseResult,
	IOrchestrationRoutedEdge,
	ORCHESTRATION_ANCHOR_SIDES,
	ORCHESTRATION_SLOTS_PER_SIDE,
	ORCHESTRATION_STAFF_NODE_HEIGHT,
	ORCHESTRATION_STAFF_NODE_WIDTH,
	OrchestrationAnchorSide,
	OrchestrationDirection,
	OrchestrationLayoutMode,
} from './adeOrchestrationGraph.js';

// ============================================================================
// Cycle-Safe Hierarchical Auto-Layout (Rank-Aware + Department-Clustered)
// ============================================================================

export function computeOrchestrationAutoLayout(
	graph: Pick<IOrchestrationGraphParseResult, 'direction' | 'nodes' | 'edges' | 'departments'>,
	options?: { readonly layoutMode?: OrchestrationLayoutMode },
): Map<string, IMissionNodePosition> {
	const positions = new Map<string, IMissionNodePosition>();
	if (graph.nodes.length === 0) {
		return positions;
	}

	const layoutMode: OrchestrationLayoutMode = options?.layoutMode ?? (graph.direction === 'TD' ? 'td' : 'lr');
	const nodeById = new Map<string, IOrchestrationGraphNode>(graph.nodes.map(n => [n.id, n]));
	const staffNodes = graph.nodes.filter(n => n.kind === 'staff');
	const wbNodes = graph.nodes.filter(n => n.kind === 'whiteboard');
	const layerById = new Map<string, number>();

	// 1. Assign base layers using rank tiers when present, else longest acyclic path on non-back edges!
	const nonBackEdges = graph.edges.filter(e => !e.isCycleBackEdge);
	const adj = new Map<string, string[]>();
	const inDeg = new Map<string, number>();
	for (const n of staffNodes) {
		adj.set(n.id, []);
		inDeg.set(n.id, 0);
	}
	const staffIdSet = new Set(staffNodes.map(n => n.id));
	for (const e of nonBackEdges) {
		if (!staffIdSet.has(e.from) || !staffIdSet.has(e.to)) {
			continue;
		}
		if (e.isBidirectional && e.from > e.to && (nodeById.get(e.from)?.tier ?? 0) === (nodeById.get(e.to)?.tier ?? 0)) {
			continue;
		}
		adj.get(e.from)!.push(e.to);
		inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
	}

	const anyExplicitTier = staffNodes.some(n => n.tier !== undefined);
	if (anyExplicitTier) {
		const distinctTiers = [...new Set(staffNodes.map(n => n.tier ?? 99))].sort((a, b) => a - b);
		const tierToLayer = new Map(distinctTiers.map((t, idx) => [t, idx]));
		for (const n of staffNodes) {
			layerById.set(n.id, tierToLayer.get(n.tier ?? 99) ?? 0);
		}
	} else {
		const queue: string[] = [];
		for (const n of staffNodes) {
			if ((inDeg.get(n.id) ?? 0) === 0) {
				queue.push(n.id);
				layerById.set(n.id, 0);
			}
		}
		if (queue.length === 0 && staffNodes.length > 0) {
			queue.push(staffNodes[0].id);
			layerById.set(staffNodes[0].id, 0);
		}
		let guard = 0;
		const maxSteps = Math.max(16, staffNodes.length * staffNodes.length + 16);
		while (queue.length > 0 && guard < maxSteps) {
			guard++;
			const u = queue.shift()!;
			const uLayer = layerById.get(u) ?? 0;
			for (const v of adj.get(u) ?? []) {
				const prev = layerById.get(v);
				if (prev === undefined) {
					layerById.set(v, uLayer + 1);
					queue.push(v);
				} else if (prev < uLayer + 1 && uLayer + 1 < staffNodes.length) {
					layerById.set(v, uLayer + 1);
					queue.push(v);
				}
			}
		}
		for (const n of staffNodes) {
			if (!layerById.has(n.id)) {
				layerById.set(n.id, 0);
			}
		}
	}

	const deptOrderKeys: string[] = [];
	const deptOrderSeen = new Set<string>();
	for (const d of graph.departments) {
		if (d.nodeIds.length === 0 && d.whiteboardIds.length === 0) {
			continue;
		}
		const key = d.name.trim().toLowerCase();
		if (key && !deptOrderSeen.has(key)) {
			deptOrderSeen.add(key);
			deptOrderKeys.push(key);
		}
	}
	for (const n of staffNodes) {
		const key = (n.department ?? '').trim().toLowerCase();
		if (key && !deptOrderSeen.has(key)) {
			deptOrderSeen.add(key);
			deptOrderKeys.push(key);
		}
	}

	// Helper: build a self-contained local-coordinate department block (zero internal overlaps)
	interface ILocalDeptBlock {
		readonly deptKey: string;
		readonly localPos: Map<string, IMissionNodePosition>;
		readonly minX: number;
		readonly maxX: number;
		readonly minY: number;
		readonly maxY: number;
		readonly width: number;
		readonly height: number;
	}
	const buildDeptBlock = (deptKey: string, orient: 'east' | 'west' | 'north' | 'south'): ILocalDeptBlock => {
		const localPos = new Map<string, IMissionNodePosition>();
		const dStaff = staffNodes
			.filter(n => (n.department ?? '').trim().toLowerCase() === deptKey)
			.sort((a, b) => {
				const la = layerById.get(a.id) ?? 0;
				const lb = layerById.get(b.id) ?? 0;
				if (la !== lb) { return la - lb; }
				return a.id.localeCompare(b.id);
			});
		const dWbs = wbNodes
			.filter(n => (n.department ?? '').trim().toLowerCase() === deptKey)
			.sort((a, b) => a.id.localeCompare(b.id));

		const minLayer = dStaff.reduce((m, n) => Math.min(m, layerById.get(n.id) ?? 0), Infinity);
		const leads = dStaff.filter(n => (layerById.get(n.id) ?? 0) === minLayer);
		const members = dStaff.filter(n => (layerById.get(n.id) ?? 0) > minLayer);

		if (orient === 'south' || orient === 'north') {
			const sign = orient === 'south' ? 1 : -1;
			const colStep = 420;
			const rowStep = 294;
			const leadY = 0;
			const leadOffset = ((leads.length - 1) / 2);
			for (let i = 0; i < leads.length; i++) {
				localPos.set(leads[i].id, { x: Math.round((i - leadOffset) * colStep), y: leadY });
			}
			let furthestY = leadY;
			if (members.length > 0) {
				const subCols = members.length <= 2 ? members.length : 2;
				const subRows = Math.ceil(members.length / subCols);
				for (let i = 0; i < members.length; i++) {
					const r = Math.floor(i / subCols);
					const c = i % subCols;
					const rowCount = Math.min(subCols, members.length - r * subCols);
					const x = Math.round((c - (rowCount - 1) / 2) * colStep);
					const y = Math.round(sign * (320 + r * rowStep));
					localPos.set(members[i].id, { x, y });
					if (sign > 0) { furthestY = Math.max(furthestY, y); } else { furthestY = Math.min(furthestY, y); }
				}
				void subRows;
			}
			for (let wi = 0; wi < dWbs.length; wi++) {
				const x = Math.round((wi - (dWbs.length - 1) / 2) * 300);
				const y = Math.round(furthestY + sign * 252);
				localPos.set(dWbs[wi].id, { x, y });
			}
		} else {
			// East (+x) or West (-x) radial wing
			const sign = orient === 'east' ? 1 : -1;
			const colStep = 424;
			const rowStep = 286;
			const leadX = 0;
			const leadOffset = ((leads.length - 1) / 2);
			for (let i = 0; i < leads.length; i++) {
				localPos.set(leads[i].id, { x: leadX, y: Math.round((i - leadOffset) * rowStep) });
			}
			let furthestX = leadX;
			if (members.length > 0) {
				const subRows = members.length <= 3 ? members.length : Math.ceil(members.length / 2);
				const subCols = Math.ceil(members.length / subRows);
				for (let i = 0; i < members.length; i++) {
					const c = Math.floor(i / subRows);
					const r = i % subRows;
					const colCount = Math.min(subRows, members.length - c * subRows);
					const x = Math.round(sign * (colStep + c * 392));
					const y = Math.round((r - (colCount - 1) / 2) * rowStep);
					localPos.set(members[i].id, { x, y });
					if (sign > 0) { furthestX = Math.max(furthestX, x); } else { furthestX = Math.min(furthestX, x); }
				}
				void subCols;
			}
			for (let wi = 0; wi < dWbs.length; wi++) {
				const x = Math.round(furthestX + sign * 356);
				const y = Math.round((wi - (dWbs.length - 1) / 2) * 196);
				localPos.set(dWbs[wi].id, { x, y });
			}
		}

		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (const [id, p] of localPos.entries()) {
			const node = nodeById.get(id);
			const sz = node ? getOrchestrationNodeSize(node) : { width: ORCHESTRATION_STAFF_NODE_WIDTH, height: ORCHESTRATION_STAFF_NODE_HEIGHT };
			minX = Math.min(minX, p.x - sz.width / 2);
			maxX = Math.max(maxX, p.x + sz.width / 2);
			minY = Math.min(minY, p.y - sz.height / 2);
			maxY = Math.max(maxY, p.y + sz.height / 2);
		}
		if (!Number.isFinite(minX)) {
			minX = -160; maxX = 160; minY = -110; maxY = 110;
		}
		return { deptKey, localPos, minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
	};

	const normalizeToPositiveCanvas = (posMap: Map<string, IMissionNodePosition>, marginX = 220, marginY = 200): Map<string, IMissionNodePosition> => {
		let minX = Infinity;
		let minY = Infinity;
		for (const [id, p] of posMap.entries()) {
			const node = nodeById.get(id);
			const sz = node ? getOrchestrationNodeSize(node) : { width: ORCHESTRATION_STAFF_NODE_WIDTH, height: ORCHESTRATION_STAFF_NODE_HEIGHT };
			minX = Math.min(minX, p.x - sz.width / 2);
			minY = Math.min(minY, p.y - sz.height / 2);
		}
		if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
			return posMap;
		}
		const shiftX = Math.round(marginX - minX);
		const shiftY = Math.round(marginY - minY);
		for (const [id, p] of posMap.entries()) {
			posMap.set(id, { x: p.x + shiftX, y: p.y + shiftY });
		}
		return posMap;
	};

	// =========================================================================
	// Mode A: Core-Centered Radial Constellation (`radial` — 核心居中，四周环绕)
	// =========================================================================
	if (layoutMode === 'radial') {
		const unassignedStaff = staffNodes.filter(n => !(n.department ?? '').trim()).sort((a, b) => (layerById.get(a.id) ?? 0) - (layerById.get(b.id) ?? 0) || a.id.localeCompare(b.id));
		if (deptOrderKeys.length > 0) {
			const coreNodes = unassignedStaff.length > 0
				? unassignedStaff
				: [staffNodes.reduce((best, n) => ((layerById.get(n.id) ?? 99) < (layerById.get(best.id) ?? 99) ? n : best), staffNodes[0])];
			const coreIdSet = new Set(coreNodes.map(n => n.id));
			const coreGapX = 396;
			for (let i = 0; i < coreNodes.length; i++) {
				positions.set(coreNodes[i].id, { x: Math.round((i - (coreNodes.length - 1) / 2) * coreGapX), y: 0 });
			}
			const coreHalfW = Math.max(ORCHESTRATION_STAFF_NODE_WIDTH / 2, ((coreNodes.length - 1) * coreGapX + ORCHESTRATION_STAFF_NODE_WIDTH) / 2);
			const coreHalfH = ORCHESTRATION_STAFF_NODE_HEIGHT / 2;

			// Partition departments into balanced North / East / South / West compass wings around the center
			const wings: Record<'north' | 'east' | 'south' | 'west', string[]> = { north: [], east: [], south: [], west: [] };
			const K = deptOrderKeys.length;
			const wingPlan: readonly ('north' | 'east' | 'south' | 'west')[] =
				K === 1 ? ['east']
					: K === 2 ? ['west', 'east']
						: K === 3 ? ['north', 'east', 'west']
							: K === 4 ? ['north', 'east', 'south', 'west']
								: K === 5 ? ['north', 'east', 'east', 'south', 'west']
									: K === 6 ? ['north', 'east', 'east', 'south', 'west', 'west']
										: deptOrderKeys.map((_, idx) => (['east', 'west', 'north', 'south'] as const)[idx % 4]);
			for (let i = 0; i < K; i++) {
				wings[wingPlan[i]].push(deptOrderKeys[i]);
			}

			const deptGap = 156;
			const northBlocks = wings.north.map(k => buildDeptBlock(k, 'north'));
			const southBlocks = wings.south.map(k => buildDeptBlock(k, 'south'));
			const northTotalW = northBlocks.reduce((acc, b, idx) => acc + b.width + (idx > 0 ? deptGap : 0), 0);
			const southTotalW = southBlocks.reduce((acc, b, idx) => acc + b.width + (idx > 0 ? deptGap : 0), 0);
			const maxNsHalfW = Math.max(northTotalW / 2, southTotalW / 2);
			// Dynamically widen East/West clearance just enough for balanced North/South wings to tuck snugly around the centered L1 core!
			const wingClearX = maxNsHalfW > 0
				? Math.min(coreHalfW + 520, Math.max(coreHalfW + 300, Math.ceil(maxNsHalfW) + 136))
				: (coreHalfW + 300);

			// Place East wing (+x) stacked vertically around y=0
			const eastBlocks = wings.east.map(k => buildDeptBlock(k, 'east'));
			const eastTotalH = eastBlocks.reduce((acc, b, idx) => acc + b.height + (idx > 0 ? deptGap : 0), 0);
			let cursorY = -eastTotalH / 2;
			let eastMinX = Infinity;
			let eastMinY = Infinity;
			let eastMaxY = -Infinity;
			for (const blk of eastBlocks) {
				const dx = Math.round(wingClearX - blk.minX);
				const dy = Math.round(cursorY - blk.minY);
				for (const [id, p] of blk.localPos.entries()) {
					if (!coreIdSet.has(id)) { positions.set(id, { x: p.x + dx, y: p.y + dy }); }
				}
				eastMinX = Math.min(eastMinX, blk.minX + dx);
				eastMinY = Math.min(eastMinY, blk.minY + dy);
				eastMaxY = Math.max(eastMaxY, blk.maxY + dy);
				cursorY += blk.height + deptGap;
			}

			// Place West wing (-x) stacked vertically around y=0
			const westBlocks = wings.west.map(k => buildDeptBlock(k, 'west'));
			const westTotalH = westBlocks.reduce((acc, b, idx) => acc + b.height + (idx > 0 ? deptGap : 0), 0);
			cursorY = -westTotalH / 2;
			let westMaxX = -Infinity;
			let westMinY = Infinity;
			let westMaxY = -Infinity;
			for (const blk of westBlocks) {
				const dx = Math.round(-wingClearX - blk.maxX);
				const dy = Math.round(cursorY - blk.minY);
				for (const [id, p] of blk.localPos.entries()) {
					if (!coreIdSet.has(id)) { positions.set(id, { x: p.x + dx, y: p.y + dy }); }
				}
				westMaxX = Math.max(westMaxX, blk.maxX + dx);
				westMinY = Math.min(westMinY, blk.minY + dy);
				westMaxY = Math.max(westMaxY, blk.maxY + dy);
				cursorY += blk.height + deptGap;
			}

			const centerCorridorHalfW = Math.min(
				Number.isFinite(eastMinX) ? eastMinX : Infinity,
				Number.isFinite(westMaxX) ? -westMaxX : Infinity,
			) - 110;
			const ewTopY = Math.min(eastMinY, westMinY);
			const ewBotY = Math.max(eastMaxY, westMaxY);

			// Place North wing (-y) above center (tucked inside center corridor if narrow enough, else cleanly above East/West!)
			const northFitsBetween = northTotalW / 2 <= centerCorridorHalfW;
			const northBottomY = northFitsBetween || !Number.isFinite(ewTopY)
				? -(coreHalfH + 236)
				: Math.min(-(coreHalfH + 236), ewTopY - 140);
			let cursorX = -northTotalW / 2;
			for (const blk of northBlocks) {
				const dx = Math.round(cursorX - blk.minX);
				const dy = Math.round(northBottomY - blk.maxY);
				for (const [id, p] of blk.localPos.entries()) {
					if (!coreIdSet.has(id)) { positions.set(id, { x: p.x + dx, y: p.y + dy }); }
				}
				cursorX += blk.width + deptGap;
			}

			// Place South wing (+y) below center
			const southFitsBetween = southTotalW / 2 <= centerCorridorHalfW;
			const southTopY = southFitsBetween || !Number.isFinite(ewBotY)
				? (coreHalfH + 236)
				: Math.max(coreHalfH + 236, ewBotY + 140);
			cursorX = -southTotalW / 2;
			for (const blk of southBlocks) {
				const dx = Math.round(cursorX - blk.minX);
				const dy = Math.round(southTopY - blk.minY);
				for (const [id, p] of blk.localPos.entries()) {
					if (!coreIdSet.has(id)) { positions.set(id, { x: p.x + dx, y: p.y + dy }); }
				}
				cursorX += blk.width + deptGap;
			}

			// Place any unattached department-less whiteboards cleanly below
			const unplacedWbs = wbNodes.filter(w => !positions.has(w.id));
			for (let i = 0; i < unplacedWbs.length; i++) {
				positions.set(unplacedWbs[i].id, { x: Math.round((i - (unplacedWbs.length - 1) / 2) * 320), y: Math.round(southTopY + 560) });
			}
			return normalizeToPositiveCanvas(positions);
		}

		// No departments declared: concentric rings radiating around lowest-layer core!
		const layers = new Map<number, IOrchestrationGraphNode[]>();
		for (const n of staffNodes) {
			const l = layerById.get(n.id) ?? 0;
			const arr = layers.get(l) ?? [];
			arr.push(n);
			layers.set(l, arr);
		}
		const sortedL = [...layers.keys()].sort((a, b) => a - b);
		let ringR = 0;
		for (let li = 0; li < sortedL.length; li++) {
			const ringNodes = layers.get(sortedL[li])!.sort((a, b) => a.id.localeCompare(b.id));
			if (li === 0 && ringNodes.length === 1) {
				positions.set(ringNodes[0].id, { x: 0, y: 0 });
				ringR = 540;
				continue;
			}
			const minCircRadius = Math.ceil((ringNodes.length * 410) / (2 * Math.PI));
			const r = Math.max(ringR, minCircRadius, 460);
			for (let i = 0; i < ringNodes.length; i++) {
				const angle = -Math.PI / 2 + (i * 2 * Math.PI) / ringNodes.length;
				positions.set(ringNodes[i].id, {
					x: Math.round(Math.cos(angle) * r * 1.18),
					y: Math.round(Math.sin(angle) * r),
				});
			}
			ringR = r + 420;
		}
		for (let wi = 0; wi < wbNodes.length; wi++) {
			const angle = -Math.PI / 2 + ((wi + 0.5) * 2 * Math.PI) / Math.max(1, wbNodes.length);
			positions.set(wbNodes[wi].id, {
				x: Math.round(Math.cos(angle) * ringR * 1.15),
				y: Math.round(Math.sin(angle) * ringR),
			});
		}
		return normalizeToPositiveCanvas(positions);
	}

	// =========================================================================
	// Mode B: Top -> Down Org Tree (`td`) & Mode C: Compact Department Grid (`grid`)
	// =========================================================================
	if ((layoutMode === 'td' || layoutMode === 'grid') && deptOrderKeys.length > 0) {
		const blocks = deptOrderKeys.map(k => buildDeptBlock(k, 'south'));
		const deptGapX = 156;
		const deptGapY = 176;
		const gridCols = layoutMode === 'td'
			? blocks.length
			: (blocks.length <= 2 ? blocks.length : blocks.length <= 4 ? 2 : 3);
		const gridRows = Math.ceil(blocks.length / gridCols);

		// Compute column widths and row heights so every department frame stays strictly disjoint
		const colWidths: number[] = Array(gridCols).fill(0);
		const rowHeights: number[] = Array(gridRows).fill(0);
		for (let i = 0; i < blocks.length; i++) {
			const r = Math.floor(i / gridCols);
			const c = i % gridCols;
			colWidths[c] = Math.max(colWidths[c], blocks[i].width);
			rowHeights[r] = Math.max(rowHeights[r], blocks[i].height);
		}
		const totalW = colWidths.reduce((acc, w, idx) => acc + w + (idx > 0 ? deptGapX : 0), 0);

		const unassignedStaff = staffNodes
			.filter(n => !(n.department ?? '').trim())
			.sort((a, b) => (layerById.get(a.id) ?? 0) - (layerById.get(b.id) ?? 0) || a.id.localeCompare(b.id));
		let topStartY = 0;
		if (unassignedStaff.length > 0) {
			const coreGapX = 410;
			const centerX = totalW / 2;
			for (let i = 0; i < unassignedStaff.length; i++) {
				positions.set(unassignedStaff[i].id, {
					x: Math.round(centerX + (i - (unassignedStaff.length - 1) / 2) * coreGapX),
					y: 0,
				});
			}
			topStartY = ORCHESTRATION_STAFF_NODE_HEIGHT / 2 + 250;
		}

		let curY = topStartY;
		for (let r = 0; r < gridRows; r++) {
			let curX = 0;
			for (let c = 0; c < gridCols; c++) {
				const idx = r * gridCols + c;
				if (idx >= blocks.length) {
					break;
				}
				const blk = blocks[idx];
				const cellCenterX = curX + colWidths[c] / 2;
				const dx = Math.round(cellCenterX - (blk.minX + blk.maxX) / 2);
				const dy = Math.round(curY - blk.minY);
				for (const [id, p] of blk.localPos.entries()) {
					positions.set(id, { x: p.x + dx, y: p.y + dy });
				}
				curX += colWidths[c] + deptGapX;
			}
			curY += rowHeights[r] + deptGapY;
		}
		const unplacedWbs = wbNodes.filter(w => !positions.has(w.id));
		for (let wi = 0; wi < unplacedWbs.length; wi++) {
			positions.set(unplacedWbs[wi].id, { x: Math.round(totalW / 2 + (wi - (unplacedWbs.length - 1) / 2) * 320), y: Math.round(curY + 120) });
		}
		return normalizeToPositiveCanvas(positions);
	}

	// =========================================================================
	// Mode D: Left -> Right Department-Band Hierarchy (`lr` — default) & Fallback
	// =========================================================================
	const layers = new Map<number, IOrchestrationGraphNode[]>();
	for (const n of staffNodes) {
		const layer = layerById.get(n.id) ?? 0;
		const list = layers.get(layer) ?? [];
		list.push(n);
		layers.set(layer, list);
	}
	const sortedLayerNums = [...layers.keys()].sort((a, b) => a - b);
	const layerIndexByNum = new Map(sortedLayerNums.map((num, idx) => [num, idx]));

	const isLR = layoutMode !== 'td';
	const colGap = isLR ? 472 : 436;
	const rowGap = isLR ? 310 : 344;
	const startX = 250;
	const startY = 200;

	if (deptOrderKeys.length > 0) {
		// Allocate a strictly disjoint vertical (LR) or horizontal (TD) band to each department
		const deptBandGap = 0.58; // Extra breathing gap between department dashed frames
		let cursorSlot = 0;

		for (let di = 0; di < deptOrderKeys.length; di++) {
			const deptKey = deptOrderKeys[di];
			const deptByLayer = new Map<number, IOrchestrationGraphNode[]>();
			let bandSpan = 1;
			for (const n of staffNodes) {
				if ((n.department ?? '').trim().toLowerCase() !== deptKey) {
					continue;
				}
				const lNum = layerById.get(n.id) ?? 0;
				const bucket = deptByLayer.get(lNum) ?? [];
				bucket.push(n);
				deptByLayer.set(lNum, bucket);
				bandSpan = Math.max(bandSpan, bucket.length);
			}
			const bandStart = cursorSlot;
			for (const [lNum, bucket] of deptByLayer.entries()) {
				bucket.sort((a, b) => a.id.localeCompare(b.id));
				const li = layerIndexByNum.get(lNum) ?? 0;
				const innerOffset = (bandSpan - bucket.length) / 2;
				for (let i = 0; i < bucket.length; i++) {
					const slotPos = bandStart + innerOffset + i;
					const x = isLR ? Math.round(startX + li * colGap) : Math.round(startX + slotPos * colGap);
					const y = isLR ? Math.round(startY + slotPos * rowGap) : Math.round(startY + li * rowGap);
					positions.set(bucket[i].id, { x, y });
				}
			}
			cursorSlot += bandSpan + deptBandGap;
		}
		const totalSpan = Math.max(1, cursorSlot - deptBandGap);

		// Center unassigned executive/top-level staff (e.g. CEO) across the full company span
		const unassignedByLayer = new Map<number, IOrchestrationGraphNode[]>();
		for (const n of staffNodes) {
			if ((n.department ?? '').trim()) {
				continue;
			}
			const lNum = layerById.get(n.id) ?? 0;
			const bucket = unassignedByLayer.get(lNum) ?? [];
			bucket.push(n);
			unassignedByLayer.set(lNum, bucket);
		}
		for (const [lNum, bucket] of unassignedByLayer.entries()) {
			bucket.sort((a, b) => a.id.localeCompare(b.id));
			const li = layerIndexByNum.get(lNum) ?? 0;
			const offset = (totalSpan - bucket.length) / 2;
			for (let i = 0; i < bucket.length; i++) {
				const slotPos = offset + i;
				const x = isLR ? Math.round(startX + li * colGap) : Math.round(startX + slotPos * colGap);
				const y = isLR ? Math.round(startY + slotPos * rowGap) : Math.round(startY + li * rowGap);
				positions.set(bucket[i].id, { x, y });
			}
		}
	} else {
		for (const list of layers.values()) {
			list.sort((a, b) => a.id.localeCompare(b.id));
		}
		let maxSpan = 1;
		for (const list of layers.values()) {
			maxSpan = Math.max(maxSpan, list.length);
		}
		for (let li = 0; li < sortedLayerNums.length; li++) {
			const list = layers.get(sortedLayerNums[li])!;
			const offset = ((maxSpan - list.length) / 2);
			for (let i = 0; i < list.length; i++) {
				const node = list[i];
				const x = isLR
					? Math.round(startX + li * colGap)
					: Math.round(startX + (offset + i) * colGap);
				const y = isLR
					? Math.round(startY + (offset + i) * rowGap)
					: Math.round(startY + li * rowGap);
				positions.set(node.id, { x, y });
			}
		}
	}

	// Place each Department Shared Whiteboard cleanly beside its department members without colliding with peer nodes
	let maxY = startY;
	let maxX = startX;
	for (const p of positions.values()) {
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
	}

	const occupiedBoxes: { minX: number; maxX: number; minY: number; maxY: number }[] = [];
	for (const node of staffNodes) {
		const p = positions.get(node.id);
		if (!p) {
			continue;
		}
		const sz = getOrchestrationNodeSize(node);
		occupiedBoxes.push({
			minX: p.x - sz.width / 2 - 24,
			maxX: p.x + sz.width / 2 + 24,
			minY: p.y - sz.height / 2 - 24,
			maxY: p.y + sz.height / 2 + 24,
		});
	}
	const isRectClear = (cx: number, cy: number, w: number, h: number): boolean => {
		const minX = cx - w / 2 - 16;
		const maxX = cx + w / 2 + 16;
		const minY = cy - h / 2 - 16;
		const maxY = cy + h / 2 + 16;
		return !occupiedBoxes.some(b => minX < b.maxX && maxX > b.minX && minY < b.maxY && maxY > b.minY);
	};

	const placedWbOffsets = new Map<string, number>();
	for (let wi = 0; wi < wbNodes.length; wi++) {
		const wb = wbNodes[wi];
		const wbSz = getOrchestrationNodeSize(wb);
		const deptKey = (wb.department ?? '').toLowerCase();
		const deptPeers = deptKey
			? staffNodes.filter(n => (n.department ?? '').toLowerCase() === deptKey && positions.has(n.id))
			: [];
		let candX: number;
		let candY: number;
		if (deptPeers.length > 0) {
			let peerMaxX = -Infinity;
			let peerMinY = Infinity;
			let peerMaxY = -Infinity;
			let peerSumX = 0;
			for (const pNode of deptPeers) {
				const p = positions.get(pNode.id)!;
				peerMaxX = Math.max(peerMaxX, p.x);
				peerMinY = Math.min(peerMinY, p.y);
				peerMaxY = Math.max(peerMaxY, p.y);
				peerSumX += p.x;
			}
			const wbIdxInDept = placedWbOffsets.get(deptKey) ?? 0;
			placedWbOffsets.set(deptKey, wbIdxInDept + 1);
			if (isLR) {
				candX = Math.round(peerMaxX + 380 + wbIdxInDept * 290);
				candY = Math.round((peerMinY + peerMaxY) / 2);
				if (!isRectClear(candX, candY, wbSz.width, wbSz.height)) {
					candX = Math.round(peerSumX / deptPeers.length + wbIdxInDept * 290);
					candY = Math.round(peerMaxY + 264);
				}
			} else {
				candX = Math.round(peerSumX / deptPeers.length + wbIdxInDept * 290);
				candY = Math.round(peerMaxY + 276);
				if (!isRectClear(candX, candY, wbSz.width, wbSz.height)) {
					candX = Math.round(peerMaxX + 372);
					candY = Math.round((peerMinY + peerMaxY) / 2 + wbIdxInDept * 184);
				}
			}
		} else {
			candX = Math.round(startX + wi * 310);
			candY = Math.round(staffNodes.length > 0 ? maxY + 270 : startY);
		}
		for (let guard = 0; guard < 8 && !isRectClear(candX, candY, wbSz.width, wbSz.height); guard++) {
			candY += 188;
		}
		positions.set(wb.id, { x: candX, y: candY });
		occupiedBoxes.push({
			minX: candX - wbSz.width / 2 - 20,
			maxX: candX + wbSz.width / 2 + 20,
			minY: candY - wbSz.height / 2 - 20,
			maxY: candY + wbSz.height / 2 + 20,
		});
	}

	return positions;
}

// ============================================================================
// 4-Side Multi-Anchor Port System & High-Craft Orthogonal Edge Router
// ============================================================================

const DEFAULT_SLOT_FRACTIONS_3 = [0.24, 0.5, 0.76] as const;
const DEFAULT_SLOT_FRACTIONS_5 = [0.16, 0.33, 0.5, 0.67, 0.84] as const;

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
	isCycleBackEdge: boolean,
	isBidirectional: boolean,
	direction: OrchestrationDirection,
	layoutMode?: OrchestrationLayoutMode,
): { readonly fromSide: OrchestrationAnchorSide; readonly toSide: OrchestrationAnchorSide } {
	const dx = toPos.x - fromPos.x;
	const dy = toPos.y - fromPos.y;
	const absDx = Math.abs(dx);
	const absDy = Math.abs(dy);

	// Non-bidirectional long cycle back-edge returning against primary flow (LR/TD linear flows only; radial/grid route naturally along 4 compass sides)
	if (isCycleBackEdge && !isBidirectional && layoutMode !== 'radial' && layoutMode !== 'grid') {
		if (direction === 'LR' && dx < -fromSize.width * 0.45 && absDy < fromSize.height * 1.1) {
			return { fromSide: 'bottom', toSide: 'bottom' };
		}
		if (direction === 'TD' && dy < -fromSize.height * 0.45 && absDx < fromSize.width * 1.1) {
			return { fromSide: 'right', toSide: 'right' };
		}
	}

	// Compare normalized aspect-corrected distances so wide cards naturally pick top/bottom when stacked vertically
	const normDx = absDx / Math.max(1, (fromSize.width + toSize.width) / 2);
	const normDy = absDy / Math.max(1, (fromSize.height + toSize.height) / 2);

	if (normDy >= normDx * 0.85) {
		return dy >= 0
			? { fromSide: 'bottom', toSide: 'top' }
			: { fromSide: 'top', toSide: 'bottom' };
	}
	return dx >= 0
		? { fromSide: 'right', toSide: 'left' }
		: { fromSide: 'left', toSide: 'right' };
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

function simplifyOrthogonalPoints(pts: readonly { readonly x: number; readonly y: number }[]): { readonly x: number; readonly y: number }[] {
	const deduped: { x: number; y: number }[] = [];
	for (const p of pts) {
		const prev = deduped[deduped.length - 1];
		if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.5) {
			deduped.push({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
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
		const colinearX = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5;
		const colinearY = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5;
		if (!colinearX && !colinearY) {
			out.push(b);
		}
	}
	out.push(deduped[deduped.length - 1]);
	return out;
}

function buildRoundedSvgPath(points: readonly { readonly x: number; readonly y: number }[], cornerRadius = 12): string {
	if (points.length === 0) {
		return '';
	}
	if (points.length === 1) {
		return `M ${points[0].x} ${points[0].y}`;
	}
	if (points.length === 2) {
		return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
	}
	const cmds: string[] = [`M ${points[0].x} ${points[0].y}`];
	for (let i = 1; i < points.length - 1; i++) {
		const p0 = points[i - 1];
		const p1 = points[i];
		const p2 = points[i + 1];
		const d1x = p1.x - p0.x;
		const d1y = p1.y - p0.y;
		const len1 = Math.hypot(d1x, d1y);
		const d2x = p2.x - p1.x;
		const d2y = p2.y - p1.y;
		const len2 = Math.hypot(d2x, d2y);
		if (len1 < 0.5 || len2 < 0.5) {
			cmds.push(`L ${p1.x} ${p1.y}`);
			continue;
		}
		const r = Math.min(cornerRadius, len1 / 2, len2 / 2);
		const sx = Math.round((p1.x - (d1x / len1) * r) * 10) / 10;
		const sy = Math.round((p1.y - (d1y / len1) * r) * 10) / 10;
		const ex = Math.round((p1.x + (d2x / len2) * r) * 10) / 10;
		const ey = Math.round((p1.y + (d2y / len2) * r) * 10) / 10;
		cmds.push(`L ${sx} ${sy} Q ${p1.x} ${p1.y} ${ex} ${ey}`);
	}
	const last = points[points.length - 1];
	cmds.push(`L ${last.x} ${last.y}`);
	return cmds.join(' ');
}

function buildMultiAnchorOrthogonalPoints(
	from: IOrchestrationAnchorPoint,
	to: IOrchestrationAnchorPoint,
	obstacles: readonly IMissionEdgeObstacle[],
	laneOffset: number,
	minStub = 24,
): readonly { readonly x: number; readonly y: number }[] {
	const s1 = { x: from.x + from.nx * minStub, y: from.y + from.ny * minStub };
	const e1 = { x: to.x + to.nx * minStub, y: to.y + to.ny * minStub };

	const fromHoriz = from.nx !== 0;
	const toHoriz = to.nx !== 0;
	const hitsAny = (pts: readonly { readonly x: number; readonly y: number }[]): boolean => {
		for (let i = 0; i < pts.length - 1; i++) {
			for (const obs of obstacles) {
				if (segmentHitsObstacle(pts[i], pts[i + 1], obs)) {
					return true;
				}
			}
		}
		return false;
	};

	// Case 1: Same-side perimeter arch (e.g. bottom -> bottom or right -> right cycle back-edge)
	if (from.side === to.side) {
		if (from.side === 'bottom' || from.side === 'top') {
			const sign = from.side === 'bottom' ? 1 : -1;
			let channelY = sign > 0
				? Math.max(s1.y, e1.y) + 28 + Math.abs(laneOffset)
				: Math.min(s1.y, e1.y) - 28 - Math.abs(laneOffset);
			for (let step = 0; step < 6; step++) {
				const cand = simplifyOrthogonalPoints([
					{ x: from.x, y: from.y },
					{ x: from.x, y: channelY },
					{ x: to.x, y: channelY },
					{ x: to.x, y: to.y },
				]);
				if (!hitsAny(cand)) {
					return cand;
				}
				channelY += sign * 42;
			}
			return simplifyOrthogonalPoints([
				{ x: from.x, y: from.y },
				{ x: from.x, y: channelY },
				{ x: to.x, y: channelY },
				{ x: to.x, y: to.y },
			]);
		} else {
			const sign = from.side === 'right' ? 1 : -1;
			let channelX = sign > 0
				? Math.max(s1.x, e1.x) + 32 + Math.abs(laneOffset)
				: Math.min(s1.x, e1.x) - 32 - Math.abs(laneOffset);
			for (let step = 0; step < 6; step++) {
				const cand = simplifyOrthogonalPoints([
					{ x: from.x, y: from.y },
					{ x: channelX, y: from.y },
					{ x: channelX, y: to.y },
					{ x: to.x, y: to.y },
				]);
				if (!hitsAny(cand)) {
					return cand;
				}
				channelX += sign * 42;
			}
			return simplifyOrthogonalPoints([
				{ x: from.x, y: from.y },
				{ x: channelX, y: from.y },
				{ x: channelX, y: to.y },
				{ x: to.x, y: to.y },
			]);
		}
	}

	// Case 2: Opposite horizontal sides (`right -> left` or `left -> right`)
	if (fromHoriz && toHoriz) {
		const forward = (from.nx > 0 && e1.x >= s1.x) || (from.nx < 0 && e1.x <= s1.x);
		if (forward) {
			const baseMidX = (s1.x + e1.x) / 2 + laneOffset;
			const shifts = [0, 28, -28, 56, -56, 92, -92];
			for (const shift of shifts) {
				const mx = Math.round(baseMidX + shift);
				const cand = simplifyOrthogonalPoints([
					{ x: from.x, y: from.y },
					{ x: mx, y: from.y },
					{ x: mx, y: to.y },
					{ x: to.x, y: to.y },
				]);
				if (!hitsAny(cand)) {
					return cand;
				}
			}
			// Detour above/below obstacle corridor
			const detourY = computeClearHorizontalDetourY(s1, e1, obstacles, laneOffset);
			return simplifyOrthogonalPoints([
				{ x: from.x, y: from.y },
				s1,
				{ x: s1.x, y: detourY },
				{ x: e1.x, y: detourY },
				e1,
				{ x: to.x, y: to.y },
			]);
		}
		const wrapY = computeClearHorizontalDetourY(s1, e1, obstacles, laneOffset);
		return simplifyOrthogonalPoints([
			{ x: from.x, y: from.y },
			s1,
			{ x: s1.x, y: wrapY },
			{ x: e1.x, y: wrapY },
			e1,
			{ x: to.x, y: to.y },
		]);
	}

	// Case 3: Opposite vertical sides (`bottom -> top` or `top -> bottom`)
	if (!fromHoriz && !toHoriz) {
		const forward = (from.ny > 0 && e1.y >= s1.y) || (from.ny < 0 && e1.y <= s1.y);
		if (forward) {
			const baseMidY = (s1.y + e1.y) / 2 + laneOffset;
			const shifts = [0, 26, -26, 52, -52, 86, -86];
			for (const shift of shifts) {
				const my = Math.round(baseMidY + shift);
				const cand = simplifyOrthogonalPoints([
					{ x: from.x, y: from.y },
					{ x: from.x, y: my },
					{ x: to.x, y: my },
					{ x: to.x, y: to.y },
				]);
				if (!hitsAny(cand)) {
					return cand;
				}
			}
			const detourX = computeClearVerticalDetourX(s1, e1, obstacles, laneOffset);
			return simplifyOrthogonalPoints([
				{ x: from.x, y: from.y },
				s1,
				{ x: detourX, y: s1.y },
				{ x: detourX, y: e1.y },
				e1,
				{ x: to.x, y: to.y },
			]);
		}
		const wrapX = computeClearVerticalDetourX(s1, e1, obstacles, laneOffset);
		return simplifyOrthogonalPoints([
			{ x: from.x, y: from.y },
			s1,
			{ x: wrapX, y: s1.y },
			{ x: wrapX, y: e1.y },
			e1,
			{ x: to.x, y: to.y },
		]);
	}

	// Case 4: Orthogonal corner sides (e.g. `right -> top`, `bottom -> left`)
	if (fromHoriz && !toHoriz) {
		const cand = simplifyOrthogonalPoints([
			{ x: from.x, y: from.y },
			{ x: e1.x, y: from.y },
			{ x: to.x, y: to.y },
		]);
		if (!hitsAny(cand)) {
			return cand;
		}
		const alt = simplifyOrthogonalPoints([
			{ x: from.x, y: from.y },
			s1,
			{ x: s1.x, y: e1.y },
			e1,
			{ x: to.x, y: to.y },
		]);
		if (!hitsAny(alt)) {
			return alt;
		}
		const detourY = computeClearHorizontalDetourY(s1, e1, obstacles, laneOffset);
		return simplifyOrthogonalPoints([
			{ x: from.x, y: from.y },
			s1,
			{ x: s1.x, y: detourY },
			{ x: e1.x, y: detourY },
			e1,
			{ x: to.x, y: to.y },
		]);
	}

	const cand = simplifyOrthogonalPoints([
		{ x: from.x, y: from.y },
		{ x: from.x, y: e1.y },
		{ x: to.x, y: to.y },
	]);
	if (!hitsAny(cand)) {
		return cand;
	}
	const alt = simplifyOrthogonalPoints([
		{ x: from.x, y: from.y },
		s1,
		{ x: e1.x, y: s1.y },
		e1,
		{ x: to.x, y: to.y },
	]);
	if (!hitsAny(alt)) {
		return alt;
	}
	const detourX = computeClearVerticalDetourX(s1, e1, obstacles, laneOffset);
	return simplifyOrthogonalPoints([
		{ x: from.x, y: from.y },
		s1,
		{ x: detourX, y: s1.y },
		{ x: detourX, y: e1.y },
		e1,
		{ x: to.x, y: to.y },
	]);
}

function computeClearHorizontalDetourY(
	s1: { readonly x: number; readonly y: number },
	e1: { readonly x: number; readonly y: number },
	obstacles: readonly IMissionEdgeObstacle[],
	laneOffset: number,
): number {
	const minX = Math.min(s1.x, e1.x);
	const maxX = Math.max(s1.x, e1.x);
	let lowestObs = Math.max(s1.y, e1.y) + 46;
	let highestObs = Math.min(s1.y, e1.y) - 46;
	for (const obs of obstacles) {
		if (obs.maxX >= minX && obs.minX <= maxX) {
			lowestObs = Math.max(lowestObs, obs.maxY + 28);
			highestObs = Math.min(highestObs, obs.minY - 28);
		}
	}
	const midY = (s1.y + e1.y) / 2;
	const distDown = Math.abs(lowestObs - midY);
	const distUp = Math.abs(midY - highestObs);
	return Math.round((distDown <= distUp ? lowestObs : highestObs) + laneOffset);
}

function computeClearVerticalDetourX(
	s1: { readonly x: number; readonly y: number },
	e1: { readonly x: number; readonly y: number },
	obstacles: readonly IMissionEdgeObstacle[],
	laneOffset: number,
): number {
	const minY = Math.min(s1.y, e1.y);
	const maxY = Math.max(s1.y, e1.y);
	let rightObs = Math.max(s1.x, e1.x) + 46;
	let leftObs = Math.min(s1.x, e1.x) - 46;
	for (const obs of obstacles) {
		if (obs.maxY >= minY && obs.minY <= maxY) {
			rightObs = Math.max(rightObs, obs.maxX + 28);
			leftObs = Math.min(leftObs, obs.minX - 28);
		}
	}
	const midX = (s1.x + e1.x) / 2;
	const distRight = Math.abs(rightObs - midX);
	const distLeft = Math.abs(midX - leftObs);
	return Math.round((distRight <= distLeft ? rightObs : leftObs) + laneOffset);
}

function computeLabelMidpoint(
	points: readonly { readonly x: number; readonly y: number }[],
	tBias = 0.5,
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
	const targetDist = totalLen * Math.max(0.2, Math.min(0.8, tBias));
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
 * Globally plans 4-side multi-anchor slot assignments, bidirectional track separation,
 * crossing-minimizing fan-out/fan-in ordering, and smooth rounded orthogonal paths
 * for the entire Orchestration graph.
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
	const cornerRadius = options?.cornerRadius ?? 12;
	const nodeById = new Map(nodes.map(n => [n.id, n]));
	const sizeById = new Map(nodes.map(n => [n.id, getOrchestrationNodeSize(n)]));

	// 1. Precompute node obstacles for obstacle avoidance
	const allObstacles: { readonly id: string; readonly box: IMissionEdgeObstacle }[] = [];
	for (const node of nodes) {
		const pos = positions.get(node.id);
		const sz = sizeById.get(node.id);
		if (!pos || !sz) {
			continue;
		}
		const pad = 12;
		allObstacles.push({
			id: node.id,
			box: {
				minX: pos.x - sz.width / 2 - pad,
				maxX: pos.x + sz.width / 2 + pad,
				minY: pos.y - sz.height / 2 - pad,
				maxY: pos.y + sz.height / 2 + pad,
			},
		});
	}

	// 2. Choose optimal `(fromSide, toSide)` for every edge
	interface IEdgeSideChoice {
		readonly edge: IOrchestrationGraphEdge;
		fromSide: OrchestrationAnchorSide;
		toSide: OrchestrationAnchorSide;
		readonly bidirRank: -1 | 0 | 1; // -1 = first of bidir pair, +1 = reverse of bidir pair, 0 = unidirectional
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
		const sides = chooseOptimalAnchorSides(
			fromPos,
			toPos,
			fromSize,
			toSize,
			Boolean(edge.isCycleBackEdge),
			Boolean(edge.isBidirectional),
			direction,
			layoutMode,
		);
		const bidirRank: -1 | 0 | 1 = edge.isBidirectional
			? (edge.from < edge.to ? -1 : 1)
			: 0;
		edgeChoices.push({ edge, fromSide: sides.fromSide, toSide: sides.toSide, bidirRank });
	}

	// 3. Bucket all incident edge endpoints per `(nodeId, side)`, spill >3 overflow endpoints cleanly
	//    onto perpendicular sides so high-degree hubs fan out across all 4 edges, and sort to minimize crossings!
	interface ISideEndpointRef {
		readonly choice: IEdgeSideChoice;
		readonly nodeId: string;
		readonly edgeId: string;
		readonly isFrom: boolean;
		readonly otherPos: IMissionNodePosition;
		readonly bidirRank: -1 | 0 | 1;
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
	const addSideRef = (nodeId: string, side: OrchestrationAnchorSide, ref: ISideEndpointRef) => {
		getSideBucket(nodeId, side).push(ref);
	};

	for (const ch of edgeChoices) {
		const fromPos = positions.get(ch.edge.from)!;
		const toPos = positions.get(ch.edge.to)!;
		addSideRef(ch.edge.from, ch.fromSide, { choice: ch, nodeId: ch.edge.from, edgeId: ch.edge.id, isFrom: true, otherPos: toPos, bidirRank: ch.bidirRank });
		addSideRef(ch.edge.to, ch.toSide, { choice: ch, nodeId: ch.edge.to, edgeId: ch.edge.id, isFrom: false, otherPos: fromPos, bidirRank: ch.bidirRank });
	}

	// Spill excess (> ORCHESTRATION_SLOTS_PER_SIDE) endpoints onto adjacent perpendicular sides with free slots
	const sortSideBucket = (list: ISideEndpointRef[], side: OrchestrationAnchorSide) => {
		const isHorizontalSide = side === 'top' || side === 'bottom';
		list.sort((a, b) => {
			const coordA = isHorizontalSide ? a.otherPos.x : a.otherPos.y;
			const coordB = isHorizontalSide ? b.otherPos.x : b.otherPos.y;
			if (Math.abs(coordA - coordB) > 2) {
				return coordA - coordB;
			}
			if (a.bidirRank !== b.bidirRank) {
				return a.bidirRank - b.bidirRank;
			}
			return a.edgeId.localeCompare(b.edgeId);
		});
	};
	for (const node of nodes) {
		const nodePos = positions.get(node.id);
		if (!nodePos) {
			continue;
		}
		for (const side of ['top', 'right', 'bottom', 'left'] as const) {
			const bucket = endpointsByNodeSide.get(`${node.id}:${side}`);
			if (!bucket || bucket.length <= ORCHESTRATION_SLOTS_PER_SIDE) {
				continue;
			}
			sortSideBucket(bucket, side);
			const isHorizontalSide = side === 'top' || side === 'bottom';
			const oppositeSide: OrchestrationAnchorSide =
				side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : side === 'left' ? 'right' : 'left';
			// Peel outermost endpoints (alternating start/end of sorted order) onto the closest perpendicular side with capacity
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
					break; // All 4 sides (>= 12 endpoints) are saturated; remaining share physical slots below
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

	// Assign physical slot index (always 0 <= slot < ORCHESTRATION_SLOTS_PER_SIDE) per `(edgeId, isFrom)`
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
			assignedSlot.set(mapKey, { slot: slotMap[i] ?? Math.floor(ORCHESTRATION_SLOTS_PER_SIDE / 2), totalSlots: ORCHESTRATION_SLOTS_PER_SIDE });
		}
	}

	// 4. Compute spatially-bucketed orthogonal channel lane offsets so large 30-100+ node graphs stay tight inside each corridor!
	const makeCorridorKey = (ch: IEdgeSideChoice): string => {
		const fp = positions.get(ch.edge.from)!;
		const tp = positions.get(ch.edge.to)!;
		const bx = Math.round((fp.x + tp.x) / 840);
		const by = Math.round((fp.y + tp.y) / 840);
		return `${ch.fromSide}->${ch.toSide}@${bx}:${by}`;
	};
	const corridorCounts = new Map<string, number>();
	const edgeLaneMap = new Map<string, number>();
	let cycleBackIndex = 0;
	for (const ch of edgeChoices) {
		const corridorKey = makeCorridorKey(ch);
		const idx = corridorCounts.get(corridorKey) ?? 0;
		corridorCounts.set(corridorKey, idx + 1);
		edgeLaneMap.set(ch.edge.id, idx);
	}

	// Track placed edge label pills so overlapping pills gently stagger along their own paths
	const placedLabels: Array<{ readonly x: number; readonly y: number; readonly halfW: number; readonly halfH: number }> = [];
	const labelOverlaps = (x: number, y: number, halfW: number, halfH: number): boolean =>
		placedLabels.some(b => Math.abs(b.x - x) < (b.halfW + halfW + 8) && Math.abs(b.y - y) < (b.halfH + halfH + 4));

	// 5. Route every edge cleanly with obstacle avoidance, bus-lane separation & rounded corners
	for (const ch of edgeChoices) {
		const { edge, fromSide, toSide, bidirRank } = ch;
		const fromPos = positions.get(edge.from)!;
		const toPos = positions.get(edge.to)!;
		const fromSize = sizeById.get(edge.from)!;
		const toSize = sizeById.get(edge.to)!;

		const fromSlotInfo = assignedSlot.get(`${edge.id}:from`) ?? { slot: Math.floor(ORCHESTRATION_SLOTS_PER_SIDE / 2), totalSlots: ORCHESTRATION_SLOTS_PER_SIDE };
		const toSlotInfo = assignedSlot.get(`${edge.id}:to`) ?? { slot: Math.floor(ORCHESTRATION_SLOTS_PER_SIDE / 2), totalSlots: ORCHESTRATION_SLOTS_PER_SIDE };

		const fromAnchor = computeOrchestrationAnchorPoint(fromPos, fromSize, fromSide, fromSlotInfo.slot, fromSlotInfo.totalSlots, 0);
		const toAnchor = computeOrchestrationAnchorPoint(toPos, toSize, toSide, toSlotInfo.slot, toSlotInfo.totalSlots, 4);

		const corridorKey = makeCorridorKey(ch);
		const totalInCorridor = corridorCounts.get(corridorKey) ?? 1;
		const laneIdx = edgeLaneMap.get(edge.id) ?? 0;
		let laneOffset = totalInCorridor > 1
			? Math.round((laneIdx - (totalInCorridor - 1) / 2) * 12)
			: 0;
		if (bidirRank !== 0) {
			const pairGroupOffset = totalInCorridor > 2
				? Math.round((Math.floor(laneIdx / 2) - (Math.ceil(totalInCorridor / 2) - 1) / 2) * 16)
				: 0;
			laneOffset = pairGroupOffset + bidirRank * 9;
		} else if (edge.isCycleBackEdge && fromSide === toSide) {
			laneOffset = (cycleBackIndex++) * 20;
		}
		if (!(edge.isCycleBackEdge && fromSide === toSide)) {
			laneOffset = Math.max(-44, Math.min(44, laneOffset));
		}

		// Local obstacle culling
		const corridorPad = 148;
		const corridor: IMissionEdgeObstacle = {
			minX: Math.min(fromAnchor.x, toAnchor.x) - corridorPad,
			maxX: Math.max(fromAnchor.x, toAnchor.x) + corridorPad,
			minY: Math.min(fromAnchor.y, toAnchor.y) - corridorPad,
			maxY: Math.max(fromAnchor.y, toAnchor.y) + corridorPad,
		};
		const localObstacles: IMissionEdgeObstacle[] = [];
		for (const o of allObstacles) {
			if (o.id === edge.from || o.id === edge.to) {
				continue;
			}
			if (o.box.minX <= corridor.maxX && o.box.maxX >= corridor.minX && o.box.minY <= corridor.maxY && o.box.maxY >= corridor.minY) {
				localObstacles.push(o.box);
			}
		}

		const points = buildMultiAnchorOrthogonalPoints(fromAnchor, toAnchor, localObstacles, laneOffset, 24);
		const path = buildRoundedSvgPath(points, cornerRadius);

		// De-collide edge label midpoints along their own path so labels never stack on top of one another!
		const baseBias = bidirRank === -1 ? 0.38 : bidirRank === 1 ? 0.62 : 0.5;
		const biasCandidates = [baseBias, 0.34, 0.66, 0.26, 0.74, 0.44, 0.56];
		let chosenMid = computeLabelMidpoint(points, baseBias);
		if (edge.label) {
			const estHalfW = Math.min(72, Math.max(26, edge.label.length * 5.2));
			for (const b of biasCandidates) {
				const cand = computeLabelMidpoint(points, b);
				if (!labelOverlaps(cand.midX, cand.midY, estHalfW, 11)) {
					chosenMid = cand;
					break;
				}
			}
			placedLabels.push({ x: chosenMid.midX, y: chosenMid.midY, halfW: estHalfW, halfH: 11 });
		}
		const { midX, midY } = chosenMid;

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
			isBidirectional: Boolean(edge.isBidirectional),
			isCycleBackEdge: Boolean(edge.isCycleBackEdge),
			laneIndex: laneIdx,
		});
	}

	void nodeById;
	return result;
}
