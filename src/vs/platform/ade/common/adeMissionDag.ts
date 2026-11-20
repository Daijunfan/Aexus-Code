/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure frontend Mission Mermaid DAG parser, flat non-nested layered auto-layout,
 * and draw.io-style smooth rounded orthogonal edge router.
 * Zero backend orchestration, zero prompts, zero nested node containers.
 */

export type MissionDagDirection = 'LR' | 'TD';
export type MissionDagNodeKind = 'task' | 'gate';

export interface IMissionNodePosition {
	readonly x: number;
	readonly y: number;
}

export interface IMissionDagNode {
	readonly id: string;
	readonly label: string;
	readonly kind: MissionDagNodeKind;
}

export interface IMissionDagEdge {
	readonly id: string;
	readonly from: string;
	readonly to: string;
	readonly label?: string;
}

export interface IMissionDagParseResult {
	readonly direction: MissionDagDirection;
	readonly nodes: readonly IMissionDagNode[];
	readonly edges: readonly IMissionDagEdge[];
	readonly error?: string;
}

export interface IMissionEdgeObstacle {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
}

export interface IMissionOrthogonalEdgeOptions {
	readonly cornerRadius?: number;
	readonly minStub?: number;
	readonly wrapClearanceY?: number;
	readonly obstacles?: readonly IMissionEdgeObstacle[];
}

export interface IMissionOrthogonalEdgeRoute {
	readonly path: string;
	readonly midX: number;
	readonly midY: number;
	readonly points: readonly { readonly x: number; readonly y: number }[];
}

export const MISSION_TASK_NODE_WIDTH = 248;
export const MISSION_TASK_NODE_HEIGHT = 104;
export const MISSION_GATE_NODE_WIDTH = 216;
export const MISSION_GATE_NODE_HEIGHT = 86;

const MIN_WORLD_WIDTH = 4800;
const MIN_WORLD_HEIGHT = 3600;
const WORLD_MARGIN = 640;

function stripOuterQuotes(raw: string): string {
	const t = raw.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('\'') && t.endsWith('\''))) {
		return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
	}
	return t;
}

function extractMermaidSource(rawText: string): string {
	const fenced = /```mermaid\s*\r?\n([\s\S]*?)```/i.exec(rawText);
	return (fenced ? fenced[1] : rawText).trim();
}

function splitTopLevelByDelimiter(input: string, delimiter: string): string[] {
	const parts: string[] = [];
	let current = '';
	let inQuote: '"' | '\'' | undefined;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (inQuote) {
			current += ch;
			if (ch === inQuote && input[i - 1] !== '\\') {
				inQuote = undefined;
			}
			continue;
		}
		if (ch === '"' || ch === '\'') {
			inQuote = ch;
			current += ch;
			continue;
		}
		if (ch === delimiter) {
			if (current.trim()) {
				parts.push(current.trim());
			}
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim()) {
		parts.push(current.trim());
	}
	return parts;
}

function splitTopLevelStatements(line: string): string[] {
	return splitTopLevelByDelimiter(line, ';');
}

function parseNodeToken(rawToken: string): { readonly id: string; readonly label?: string; readonly kind?: MissionDagNodeKind } | undefined {
	const token = rawToken.trim();
	if (!token) {
		return undefined;
	}

	// Gate / hexagon / diamond shapes: id{{"Label"}} or id{"Label"}
	const hexMatch = /^([A-Za-z0-9_-]+)\s*\{\{([\s\S]+?)\}\}$/.exec(token);
	if (hexMatch) {
		return { id: hexMatch[1], label: stripOuterQuotes(hexMatch[2]), kind: 'gate' };
	}
	const diamondMatch = /^([A-Za-z0-9_-]+)\s*\{([\s\S]+?)\}$/.exec(token);
	if (diamondMatch) {
		return { id: diamondMatch[1], label: stripOuterQuotes(diamondMatch[2]), kind: 'gate' };
	}

	// Stadium / circle / rounded / square task shapes: id(["..."]), id(("...")), id("..."), id["..."]
	const stadiumMatch = /^([A-Za-z0-9_-]+)\s*\(\[([\s\S]+?)\]\)$/.exec(token);
	if (stadiumMatch) {
		return { id: stadiumMatch[1], label: stripOuterQuotes(stadiumMatch[2]), kind: 'task' };
	}
	const circleMatch = /^([A-Za-z0-9_-]+)\s*\(\(([\s\S]+?)\)\)$/.exec(token);
	if (circleMatch) {
		return { id: circleMatch[1], label: stripOuterQuotes(circleMatch[2]), kind: 'task' };
	}
	const rectMatch = /^([A-Za-z0-9_-]+)\s*\[([\s\S]+?)\]$/.exec(token);
	if (rectMatch) {
		return { id: rectMatch[1], label: stripOuterQuotes(rectMatch[2]), kind: 'task' };
	}
	const roundMatch = /^([A-Za-z0-9_-]+)\s*\(([\s\S]+?)\)$/.exec(token);
	if (roundMatch) {
		return { id: roundMatch[1], label: stripOuterQuotes(roundMatch[2]), kind: 'task' };
	}

	// Bare identifier: N1
	const bareMatch = /^([A-Za-z0-9_-]+)$/.exec(token);
	if (bareMatch) {
		return { id: bareMatch[1] };
	}
	return undefined;
}

const EDGE_OP_RE = /\s*(?:--+>|-\.+->|==+>|--+)(?:\|([^|]*)\|)?\s*/g;

function detectCycle(nodes: readonly IMissionDagNode[], edges: readonly IMissionDagEdge[]): string | undefined {
	const adj = new Map<string, string[]>();
	const inDegree = new Map<string, number>();
	for (const node of nodes) {
		adj.set(node.id, []);
		inDegree.set(node.id, 0);
	}
	for (const edge of edges) {
		if (edge.from === edge.to) {
			return `Self-loop detected on node "${edge.from}". Mission graphs must be acyclic DAGs.`;
		}
		adj.get(edge.from)?.push(edge.to);
		inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
	}
	const queue: string[] = [];
	for (const [id, deg] of inDegree.entries()) {
		if (deg === 0) {
			queue.push(id);
		}
	}
	let visited = 0;
	while (queue.length > 0) {
		const id = queue.shift()!;
		visited++;
		for (const next of adj.get(id) ?? []) {
			const nextDeg = (inDegree.get(next) ?? 1) - 1;
			inDegree.set(next, nextDeg);
			if (nextDeg === 0) {
				queue.push(next);
			}
		}
	}
	if (visited < nodes.length) {
		return 'Cycle detected in Mermaid graph. Mission workflows must form a directed acyclic graph (DAG).';
	}
	return undefined;
}

/**
 * Parses pure Mermaid flowchart / graph syntax into a flat (non-nested) DAG.
 * Empty text returns an empty graph with no error so users can create a Mission first and author Mermaid later.
 */
export function parseMissionMermaidDag(rawText: string): IMissionDagParseResult {
	const source = extractMermaidSource(rawText);
	if (!source) {
		return { direction: 'LR', nodes: [], edges: [] };
	}

	let direction: MissionDagDirection = 'LR';
	const nodeMap = new Map<string, { id: string; label: string; kind: MissionDagNodeKind }>();
	const edges: IMissionDagEdge[] = [];
	const edgeKeys = new Set<string>();

	const upsertNode = (token: { readonly id: string; readonly label?: string; readonly kind?: MissionDagNodeKind }) => {
		const existing = nodeMap.get(token.id);
		if (!existing) {
			nodeMap.set(token.id, {
				id: token.id,
				label: token.label?.trim() || token.id,
				kind: token.kind ?? 'task',
			});
		} else {
			if (token.label?.trim() && existing.label === existing.id) {
				existing.label = token.label.trim();
			}
			if (token.kind === 'gate') {
				existing.kind = 'gate';
			}
		}
	};

	const rawLines = source.split(/\r?\n/);
	for (const rawLine of rawLines) {
		const noComment = rawLine.replace(/%%.*$/, '').trim();
		if (!noComment) {
			continue;
		}
		for (const stmt of splitTopLevelStatements(noComment)) {
			const headerMatch = /^(?:flowchart|graph)\s+(LR|RL|TD|TB|BT)\b/i.exec(stmt);
			if (headerMatch) {
				const dir = headerMatch[1].toUpperCase();
				direction = (dir === 'TD' || dir === 'TB' || dir === 'BT') ? 'TD' : 'LR';
				continue;
			}
			// Explicitly flatten any subgraph wrappers so nodes are strictly non-nested
			if (/^(?:subgraph\b|end$|direction\b|classDef\b|class\b|style\b|linkStyle\b|click\b|accTitle\b|accDescr\b)/i.test(stmt)) {
				continue;
			}

			EDGE_OP_RE.lastIndex = 0;
			const matches: { start: number; end: number; label?: string }[] = [];
			let m: RegExpExecArray | null;
			while ((m = EDGE_OP_RE.exec(stmt)) !== null) {
				matches.push({ start: m.index, end: m.index + m[0].length, label: m[1]?.trim() || undefined });
			}

			if (matches.length === 0) {
				const single = parseNodeToken(stmt);
				if (single) {
					upsertNode(single);
				}
				continue;
			}

			// Extract chained segments: seg0 --op0--> seg1 --op1--> seg2
			const segments: string[] = [];
			let cursor = 0;
			for (const op of matches) {
				segments.push(stmt.slice(cursor, op.start).trim());
				cursor = op.end;
			}
			segments.push(stmt.slice(cursor).trim());

			for (let s = 0; s < matches.length; s++) {
				const fromGroup = splitTopLevelByDelimiter(segments[s], '&').map(parseNodeToken).filter((t): t is NonNullable<typeof t> => Boolean(t));
				const toGroup = splitTopLevelByDelimiter(segments[s + 1], '&').map(parseNodeToken).filter((t): t is NonNullable<typeof t> => Boolean(t));
				if (fromGroup.length === 0 || toGroup.length === 0) {
					return {
						direction,
						nodes: [...nodeMap.values()],
						edges,
						error: `Could not parse edge statement: "${stmt}"`,
					};
				}
				for (const f of fromGroup) {
					upsertNode(f);
				}
				for (const t of toGroup) {
					upsertNode(t);
				}
				for (const f of fromGroup) {
					for (const t of toGroup) {
						const key = `${f.id}->${t.id}`;
						if (!edgeKeys.has(key)) {
							edgeKeys.add(key);
							edges.push({
								id: key,
								from: f.id,
								to: t.id,
								...(matches[s].label ? { label: matches[s].label } : {}),
							});
						}
					}
				}
			}
		}
	}

	const nodes = [...nodeMap.values()];
	if (nodes.length === 0) {
		return {
			direction,
			nodes: [],
			edges: [],
			error: 'No valid Mermaid nodes found. Example: flowchart LR\\n  N1["Design"] --> N2["Build"]',
		};
	}

	const cycleError = detectCycle(nodes, edges);
	if (cycleError) {
		return { direction, nodes, edges, error: cycleError };
	}

	return { direction, nodes, edges };
}

/**
 * Computes balanced layered flat DAG coordinates (Sugiyama layering + barycenter ordering).
 */
export function computeMissionAutoLayout(
	graph: Pick<IMissionDagParseResult, 'nodes' | 'edges' | 'direction'>,
	options?: { horizontalGap?: number; verticalGap?: number; originX?: number; originY?: number },
): Map<string, IMissionNodePosition> {
	const result = new Map<string, IMissionNodePosition>();
	if (graph.nodes.length === 0) {
		return result;
	}

	const incoming = new Map<string, string[]>();
	const outgoing = new Map<string, string[]>();
	const inDeg = new Map<string, number>();
	for (const node of graph.nodes) {
		incoming.set(node.id, []);
		outgoing.set(node.id, []);
		inDeg.set(node.id, 0);
	}
	for (const edge of graph.edges) {
		incoming.get(edge.to)?.push(edge.from);
		outgoing.get(edge.from)?.push(edge.to);
		inDeg.set(edge.to, (inDeg.get(edge.to) ?? 0) + 1);
	}

	// Kahn topological order preserving declaration order for ties
	const queue: string[] = graph.nodes.filter(n => (inDeg.get(n.id) ?? 0) === 0).map(n => n.id);
	const topo: string[] = [];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		topo.push(id);
		for (const next of outgoing.get(id) ?? []) {
			const deg = (inDeg.get(next) ?? 1) - 1;
			inDeg.set(next, deg);
			if (deg <= 0) {
				queue.push(next);
			}
		}
	}
	for (const node of graph.nodes) {
		if (!seen.has(node.id)) {
			topo.push(node.id);
		}
	}

	const layerById = new Map<string, number>();
	let maxLayer = 0;
	for (const id of topo) {
		const preds = incoming.get(id) ?? [];
		const layer = preds.length === 0 ? 0 : Math.max(...preds.map(p => (layerById.get(p) ?? 0) + 1));
		layerById.set(id, layer);
		if (layer > maxLayer) {
			maxLayer = layer;
		}
	}

	const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
	for (const id of topo) {
		layers[layerById.get(id) ?? 0].push(id);
	}

	const rankInLayer = new Map<string, number>();
	for (let l = 0; l < layers.length; l++) {
		if (l > 0) {
			layers[l].sort((a, b) => {
				const predsA = incoming.get(a) ?? [];
				const predsB = incoming.get(b) ?? [];
				const baryA = predsA.length ? predsA.reduce((s, p) => s + (rankInLayer.get(p) ?? 0), 0) / predsA.length : 0;
				const baryB = predsB.length ? predsB.reduce((s, p) => s + (rankInLayer.get(p) ?? 0), 0) / predsB.length : 0;
				return baryA - baryB;
			});
		}
		layers[l].forEach((id, idx) => rankInLayer.set(id, idx));
	}

	const isVertical = graph.direction === 'TD';
	const hGap = options?.horizontalGap ?? (isVertical ? 310 : 340);
	const vGap = options?.verticalGap ?? (isVertical ? 176 : 162);
	const originX = options?.originX ?? 240;
	const originY = options?.originY ?? 280;

	for (let l = 0; l < layers.length; l++) {
		const col = layers[l];
		const totalSpan = (col.length - 1) * (isVertical ? hGap : vGap);
		for (let idx = 0; idx < col.length; idx++) {
			const offset = idx * (isVertical ? hGap : vGap) - totalSpan / 2;
			if (isVertical) {
				result.set(col[idx], {
					x: Math.round(originX + 260 + offset),
					y: Math.round(140 + l * vGap),
				});
			} else {
				result.set(col[idx], {
					x: Math.round(originX + l * hGap),
					y: Math.round(originY + offset),
				});
			}
		}
	}

	return result;
}

export function computeMissionWorldSize(positions: readonly IMissionNodePosition[]): { readonly width: number; readonly height: number } {
	let maxX = 0;
	let maxY = 0;
	for (const p of positions) {
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
	}
	return {
		width: Math.max(MIN_WORLD_WIDTH, Math.ceil((maxX + WORLD_MARGIN) / 200) * 200),
		height: Math.max(MIN_WORLD_HEIGHT, Math.ceil((maxY + WORLD_MARGIN) / 200) * 200),
	};
}

function roundSvgCoord(value: number): number {
	return Math.round(value * 10) / 10;
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

function roundedOrthogonalPolylineToSvgPath(
	rawPoints: readonly { readonly x: number; readonly y: number }[],
	cornerRadius: number,
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
			if (sameX || sameY) {
				pts[pts.length - 1] = { x: p.x, y: p.y };
				continue;
			}
		}
		pts.push({ x: p.x, y: p.y });
	}
	if (pts.length === 0) {
		return '';
	}
	if (pts.length === 1) {
		return `M ${roundSvgCoord(pts[0].x)} ${roundSvgCoord(pts[0].y)}`;
	}
	const parts: string[] = [`M ${roundSvgCoord(pts[0].x)} ${roundSvgCoord(pts[0].y)}`];
	if (pts.length === 2) {
		parts.push(`L ${roundSvgCoord(pts[1].x)} ${roundSvgCoord(pts[1].y)}`);
		return parts.join(' ');
	}
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
		const avail1 = i === 1 ? len1 : len1 / 2;
		const avail2 = i === pts.length - 2 ? len2 : len2 / 2;
		const r = Math.min(cornerRadius, avail1, avail2);
		if (r < 0.5) {
			parts.push(`L ${roundSvgCoord(curr.x)} ${roundSvgCoord(curr.y)}`);
		} else {
			const ux1 = vx1 / len1;
			const uy1 = vy1 / len1;
			const ux2 = vx2 / len2;
			const uy2 = vy2 / len2;
			const ax = curr.x - ux1 * r;
			const ay = curr.y - uy1 * r;
			const bx = curr.x + ux2 * r;
			const by = curr.y + uy2 * r;
			parts.push(`L ${roundSvgCoord(ax)} ${roundSvgCoord(ay)} Q ${roundSvgCoord(curr.x)} ${roundSvgCoord(curr.y)} ${roundSvgCoord(bx)} ${roundSvgCoord(by)}`);
		}
	}
	const last = pts[pts.length - 1];
	parts.push(`L ${roundSvgCoord(last.x)} ${roundSvgCoord(last.y)}`);
	return parts.join(' ');
}

/**
 * Draw.io-style strictly horizontal/vertical orthogonal edge routing with smooth rounded `Q` corners.
 */
export function computeOrthogonalRoundedEdgeRoute(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	options?: IMissionOrthogonalEdgeOptions,
): IMissionOrthogonalEdgeRoute {
	const cornerRadius = Math.max(0, options?.cornerRadius ?? 14);
	const minStub = Math.max(4, options?.minStub ?? 22);
	const wrapClearanceY = Math.max(24, options?.wrapClearanceY ?? 84);
	const obstacles = options?.obstacles ?? [];
	const dx = x2 - x1;
	const dy = y2 - y1;

	if (Math.abs(dy) < 1.5 && dx >= 0) {
		const blocking = obstacles.filter(o => o.minX < x2 - 4 && o.maxX > x1 + 4 && y1 >= o.minY && y1 <= o.maxY);
		if (blocking.length === 0) {
			const y = roundSvgCoord((y1 + y2) / 2);
			const points = [{ x: x1, y }, { x: x2, y }];
			return {
				path: roundedOrthogonalPolylineToSvgPath(points, cornerRadius),
				midX: roundSvgCoord((x1 + x2) / 2),
				midY: y,
				points,
			};
		}
		const minTop = Math.min(...blocking.map(o => o.minY)) - 18;
		const maxBot = Math.max(...blocking.map(o => o.maxY)) + 18;
		const detourY = Math.abs(y1 - minTop) <= Math.abs(maxBot - y1) ? minTop : maxBot;
		const stub = Math.min(minStub, Math.max(8, dx * 0.25));
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
			path: roundedOrthogonalPolylineToSvgPath(points, cornerRadius),
			midX: roundSvgCoord((lx + rx) / 2),
			midY: roundSvgCoord(detourY),
			points,
		};
	}

	if (dx >= Math.min(minStub * 1.4, 20)) {
		let trunkX = (x1 + x2) / 2;
		const minTrunk = x1 + Math.min(minStub, dx / 2);
		const maxTrunk = x2 - Math.min(minStub, dx / 2);
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
			path: roundedOrthogonalPolylineToSvgPath(points, cornerRadius),
			midX: roundSvgCoord(trunkX),
			midY: roundSvgCoord((y1 + y2) / 2),
			points,
		};
	}

	const rightX = x1 + minStub;
	const leftX = x2 - minStub;
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
		path: roundedOrthogonalPolylineToSvgPath(points, cornerRadius),
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
