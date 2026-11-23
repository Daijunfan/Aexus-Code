/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { MissionNodeRoleKind } from './adeMissionBoundary.js';
import {
	getMissionEdgeKind,
	IMissionDagEdge,
	IMissionDagNode,
	IMissionNodeCheckHook,
	IMissionNodePosition,
	MissionDagDirection,
	MissionDagEdgeKind,
	parseMissionMermaidDag,
} from './adeMissionDag.js';
import { extractInlineEmployeeTag, stripTrailingMermaidClass } from './adeMissionEmployee.js';
import { normalizeAdeNodeColor } from './adeNodeColors.js';

function escapeMermaidQuotedLabel(label: string): string {
	return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ').trim();
}

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatNodeDeclaration(node: {
	readonly id: string;
	readonly label: string;
	readonly kind: 'task' | 'gate' | 'cluster';
	readonly employeeName?: string;
}): string {
	const cleanLabel = node.label.trim() || node.id;
	if (node.kind === 'gate') {
		return `${node.id}{{"${escapeMermaidQuotedLabel(cleanLabel)}"}}`;
	}
	const fullLabel = node.employeeName?.trim()
		? `@${node.employeeName.trim()}: ${cleanLabel}`
		: cleanLabel;
	return `${node.id}["${escapeMermaidQuotedLabel(fullLabel)}"]`;
}

function formatEdgeOperator(edge: Pick<IMissionDagEdge, 'label' | 'edgeKind'>): string {
	const kind = getMissionEdgeKind(edge);
	const cleanLabel = edge.label?.trim();
	if (kind === 'fail') {
		return `-->|${cleanLabel || 'fail'}|`;
	}
	return cleanLabel ? `-->|${cleanLabel}|` : '-->';
}

function ensureFlowchartHeader(rawText: string, defaultDirection: MissionDagDirection = 'LR'): string[] {
	const trimmed = rawText.trim();
	if (!trimmed) {
		return [`flowchart ${defaultDirection}`];
	}
	const lines = rawText.split(/\r?\n/);
	const hasHeader = lines.some(l => /^\s*(?:flowchart|graph)\s+(?:LR|RL|TD|TB|BT)\b/i.test(l));
	if (!hasHeader) {
		return [`flowchart ${defaultDirection}`, ...lines];
	}
	return lines;
}

/**
 * Generates the next unused node ID (`N1, N2...`, `U1, U2...`, or `R1, R2...`).
 */
export function generateNextMissionNodeId(
	nodes: readonly Pick<IMissionDagNode, 'id'>[],
	kind: 'task' | 'gate' | 'reviewer' = 'task',
): string {
	const used = new Set(nodes.map(n => n.id.toUpperCase()));
	const prefix = kind === 'gate' ? 'U' : kind === 'reviewer' ? 'R' : 'N';
	for (let i = 1; i < 10_000; i++) {
		const candidate = `${prefix}${i}`;
		if (!used.has(candidate)) {
			return candidate;
		}
	}
	return `${prefix}${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Appends a new task or human gate node to Mermaid source text while preserving all existing lines & comments.
 */
export function addNodeToMermaid(
	mermaidText: string,
	options: {
		readonly id?: string;
		readonly label?: string;
		readonly kind?: 'task' | 'gate';
		readonly roleHint?: MissionNodeRoleKind;
		readonly employeeName?: string;
		readonly direction?: MissionDagDirection;
	},
): { readonly mermaidText: string; readonly nodeId: string } {
	const parsed = parseMissionMermaidDag(mermaidText);
	const kind = options.kind ?? 'task';
	const nodeId = options.id?.trim() || generateNextMissionNodeId(parsed.nodes, kind === 'gate' ? 'gate' : (options.roleHint === 'reviewer' ? 'reviewer' : 'task'));
	const defaultLabel = kind === 'gate'
		? 'Human Approval Gate'
		: (options.roleHint === 'reviewer' ? `Review ${nodeId}` : `Task ${nodeId}`);
	const label = options.label?.trim() || defaultLabel;
	const decl = formatNodeDeclaration({ id: nodeId, label, kind, employeeName: options.employeeName });
	const lines = ensureFlowchartHeader(mermaidText, options.direction ?? parsed.direction);
	while (lines.length > 1 && lines[lines.length - 1].trim() === '') {
		lines.pop();
	}
	lines.push(`  ${decl}`);
	return { mermaidText: lines.join('\n'), nodeId };
}

/**
 * Renames a node's display label in-place in Mermaid source while preserving `@Employee` tags,
 * `:::Class` bindings, Gate `{{...}}`/`{...}` shapes, edges, and `%% check` comments.
 */
export function renameNodeInMermaid(mermaidText: string, nodeId: string, newLabel: string): string {
	const cleanId = nodeId.trim();
	const cleanLabel = newLabel.trim();
	if (!cleanId || !cleanLabel) {
		return mermaidText;
	}
	const parsed = parseMissionMermaidDag(mermaidText);
	const targetNode = parsed.nodes.find(n => n.id === cleanId);
	if (!targetNode) {
		return mermaidText;
	}

	const escapedId = escapeRegExp(cleanId);
	const shapeRe = new RegExp(
		`(^|[^A-Za-z0-9_-])(${escapedId})(\\s*(?:\\{\\{[\\s\\S]*?\\}\\}|\\{[\\s\\S]*?\\}|\\(\\[[\\s\\S]*?\\]\\)|\\(\\([\\s\\S]*?\\)\\)|\\[[\\s\\S]*?\\]|\\([\\s\\S]*?\\))(?:\\s*:::[A-Za-z0-9_\\u4e00-\\u9fff-]+)?)`,
	);
	let replaced = false;
	const lines = mermaidText.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		const commentIdx = rawLine.indexOf('%%');
		const codePart = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
		const commentPart = commentIdx >= 0 ? rawLine.slice(commentIdx) : '';
		if (!codePart.trim() || /^\s*(?:class|classDef|style|linkStyle|subgraph|end|direction)\b/i.test(codePart)) {
			continue;
		}
		const match = shapeRe.exec(codePart);
		if (match) {
			const fullToken = `${match[2]}${match[3]}`;
			const { baseToken, className } = stripTrailingMermaidClass(fullToken);
			const classSuffix = className ? `:::${className}` : '';
			let replacementToken: string;
			if (targetNode.kind === 'gate' || baseToken.includes('{')) {
				const isDouble = baseToken.includes('{{');
				const escaped = escapeMermaidQuotedLabel(cleanLabel);
				replacementToken = isDouble ? `${cleanId}{{"${escaped}"}}${classSuffix}` : `${cleanId}{"${escaped}"}${classSuffix}`;
			} else {
				// Preserve inline @Employee prefix and original Mermaid node shape delimiters
				const innerMatch = /^[A-Za-z0-9_-]+\s*(?:(\(\[)([\s\S]*?)(\]\))|(\(\()([\s\S]*?)(\)\))|(\[)([\s\S]*?)(\])|(\()([\s\S]*?)(\)))$/.exec(baseToken);
				const openDelim = innerMatch?.[1] ?? innerMatch?.[4] ?? innerMatch?.[7] ?? innerMatch?.[10] ?? '[';
				const closeDelim = innerMatch?.[3] ?? innerMatch?.[6] ?? innerMatch?.[9] ?? innerMatch?.[12] ?? ']';
				const rawInner = (innerMatch?.[2] ?? innerMatch?.[5] ?? innerMatch?.[8] ?? innerMatch?.[11] ?? '').trim().replace(/^["']|["']$/g, '');
				const inlineEmp = extractInlineEmployeeTag(rawInner).employeeName;
				const nextInner = inlineEmp
					? `@${inlineEmp}: ${cleanLabel}`
					: cleanLabel;
				replacementToken = `${cleanId}${openDelim}"${escapeMermaidQuotedLabel(nextInner)}"${closeDelim}${classSuffix}`;
			}
			const nextCode = codePart.slice(0, match.index) + match[1] + replacementToken + codePart.slice(match.index + match[0].length);
			lines[i] = `${nextCode}${commentPart}`;
			replaced = true;
			break;
		}
	}

	if (!replaced) {
		// Node only appeared as bare ID in edges; prepend an explicit declaration right after header.
		const decl = formatNodeDeclaration({
			id: cleanId,
			label: cleanLabel,
			kind: targetNode.kind,
			employeeName: targetNode.employeeName,
		});
		const headerIdx = lines.findIndex(l => /^\s*(?:flowchart|graph)\s+(?:LR|RL|TD|TB|BT)\b/i.test(l));
		if (headerIdx >= 0) {
			lines.splice(headerIdx + 1, 0, `  ${decl}`);
		} else {
			lines.unshift(`flowchart ${parsed.direction}`, `  ${decl}`);
		}
	}

	return lines.join('\n');
}

/**
 * Rebuilds a clean canonical Mermaid flowchart from parsed nodes/edges while preserving all
 * inline `%% check` / `%% verify` comments (for surviving nodes) and regular comments.
 */
function serializePreservingDirectives(
	originalMermaid: string,
	direction: MissionDagDirection,
	nodes: readonly IMissionDagNode[],
	edges: readonly IMissionDagEdge[],
): string {
	const survivingIds = new Set(nodes.map(n => n.id));
	const preservedComments: string[] = [];
	for (const rawLine of originalMermaid.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (!trimmed.startsWith('%%')) {
			continue;
		}
		const checkMatch = /^%%\s*(?:check|verify|task)\s+([A-Za-z0-9_-]+)/i.exec(trimmed);
		if (checkMatch && !survivingIds.has(checkMatch[1])) {
			continue;
		}
		preservedComments.push(`  ${trimmed}`);
	}

	if (nodes.length === 0) {
		return '';
	}

	const lines: string[] = [`flowchart ${direction}`];
	const declared = new Set<string>();
	const nodeById = new Map(nodes.map(n => [n.id, n]));

	const tokenFor = (id: string): string => {
		const n = nodeById.get(id);
		if (!n || declared.has(id)) {
			return id;
		}
		declared.add(id);
		return formatNodeDeclaration(n);
	};

	for (const edge of edges) {
		if (!survivingIds.has(edge.from) || !survivingIds.has(edge.to)) {
			continue;
		}
		lines.push(`  ${tokenFor(edge.from)} ${formatEdgeOperator(edge)} ${tokenFor(edge.to)}`);
	}
	for (const node of nodes) {
		if (!declared.has(node.id)) {
			declared.add(node.id);
			lines.push(`  ${formatNodeDeclaration(node)}`);
		}
	}
	for (const comment of preservedComments) {
		lines.push(comment);
	}
	return lines.join('\n');
}

/**
 * Connects two existing nodes with a directed edge (regular or `on_fail`), rejecting self-loops,
 * duplicates, and cycles via `parseMissionMermaidDag`.
 */
export function addEdgeToMermaid(
	mermaidText: string,
	fromId: string,
	toId: string,
	options?: { readonly label?: string; readonly kind?: MissionDagEdgeKind },
): { readonly ok: boolean; readonly mermaidText?: string; readonly error?: string } {
	const from = fromId.trim();
	const to = toId.trim();
	if (!from || !to) {
		return { ok: false, error: 'Source and target nodes are required.' };
	}
	if (from === to) {
		return { ok: false, error: `Cannot connect node "${from}" to itself (DAGs must be acyclic).` };
	}
	const parsed = parseMissionMermaidDag(mermaidText);
	if (parsed.error) {
		return { ok: false, error: parsed.error };
	}
	if (!parsed.nodes.some(n => n.id === from) || !parsed.nodes.some(n => n.id === to)) {
		return { ok: false, error: `Unknown node in edge "${from} -> ${to}".` };
	}
	if (parsed.edges.some(e => e.from === from && e.to === to)) {
		return { ok: false, error: `Edge "${from} -> ${to}" already exists.` };
	}

	const op = formatEdgeOperator({ label: options?.label, edgeKind: options?.kind });
	const lines = ensureFlowchartHeader(mermaidText, parsed.direction);
	while (lines.length > 1 && lines[lines.length - 1].trim() === '') {
		lines.pop();
	}
	lines.push(`  ${from} ${op} ${to}`);
	const nextMermaid = lines.join('\n');
	const check = parseMissionMermaidDag(nextMermaid);
	if (check.error) {
		return { ok: false, error: check.error };
	}
	return { ok: true, mermaidText: nextMermaid };
}

/**
 * Removes a single directed edge `(fromId -> toId)` while keeping both endpoint nodes intact.
 */
export function removeEdgeFromMermaid(mermaidText: string, fromId: string, toId: string): string {
	const parsed = parseMissionMermaidDag(mermaidText);
	if (parsed.error) {
		return mermaidText;
	}
	const nextEdges = parsed.edges.filter(e => !(e.from === fromId && e.to === toId));
	if (nextEdges.length === parsed.edges.length) {
		return mermaidText;
	}
	return serializePreservingDirectives(mermaidText, parsed.direction, parsed.nodes, nextEdges);
}

/**
 * Toggles an existing edge between regular success flow (`-->`) and failure fallback (`-->|fail|`).
 */
export function toggleEdgeFailInMermaid(mermaidText: string, fromId: string, toId: string): string {
	const parsed = parseMissionMermaidDag(mermaidText);
	if (parsed.error) {
		return mermaidText;
	}
	let changed = false;
	const nextEdges = parsed.edges.map(e => {
		if (e.from !== fromId || e.to !== toId) {
			return e;
		}
		changed = true;
		const currentlyFail = getMissionEdgeKind(e) === 'fail';
		if (currentlyFail) {
			return { id: e.id, from: e.from, to: e.to, edgeKind: 'success' as const };
		}
		return { id: e.id, from: e.from, to: e.to, label: 'fail', edgeKind: 'fail' as const };
	});
	if (!changed) {
		return mermaidText;
	}
	return serializePreservingDirectives(mermaidText, parsed.direction, parsed.nodes, nextEdges);
}

/**
 * Removes a node and all of its incident edges (plus any `%% check` directives bound to it).
 */
export function removeNodeFromMermaid(mermaidText: string, nodeId: string): string {
	return removeNodesFromMermaid(mermaidText, [nodeId]);
}

/**
 * Atomically removes one or more nodes and all of their incident edges (plus bound `%% check` directives).
 */
export function removeNodesFromMermaid(mermaidText: string, nodeIds: readonly string[]): string {
	const removeSet = new Set(nodeIds.map(id => id.trim()).filter(Boolean));
	if (removeSet.size === 0) {
		return mermaidText;
	}
	const parsed = parseMissionMermaidDag(mermaidText);
	if (parsed.error) {
		return mermaidText;
	}
	const nextNodes = parsed.nodes.filter(n => !removeSet.has(n.id));
	if (nextNodes.length === parsed.nodes.length) {
		return mermaidText;
	}
	const nextEdges = parsed.edges.filter(e => !removeSet.has(e.from) && !removeSet.has(e.to));
	return serializePreservingDirectives(mermaidText, parsed.direction, nextNodes, nextEdges);
}

const FAIL_EDGE_LABEL_RE = /^(?:fail|failed|error|err|on_fail|on-fail|retry_fail|fallback|异常|失败|兜底)$/i;

/**
 * Updates or clears an edge's label in Mermaid source text while automatically syncing
 * fail/success edge polarity when a failure keyword (e.g. `fail`, `on_fail`) is entered or cleared.
 */
export function renameEdgeLabelInMermaid(
	mermaidText: string,
	fromId: string,
	toId: string,
	nextLabel: string,
): string {
	const parsed = parseMissionMermaidDag(mermaidText);
	if (parsed.error) {
		return mermaidText;
	}
	const sanitized = nextLabel.replace(/\|/g, '/').replace(/\r?\n/g, ' ').trim();
	let changed = false;
	const nextEdges = parsed.edges.map(e => {
		if (e.from !== fromId || e.to !== toId) {
			return e;
		}
		const prevLabel = (e.label ?? '').trim();
		const nextKind: MissionDagEdgeKind = sanitized && FAIL_EDGE_LABEL_RE.test(sanitized) ? 'fail' : 'success';
		const prevKind = getMissionEdgeKind(e);
		if (prevLabel === sanitized && prevKind === nextKind) {
			return e;
		}
		changed = true;
		return {
			id: e.id,
			from: e.from,
			to: e.to,
			...(sanitized ? { label: sanitized } : {}),
			edgeKind: nextKind,
		};
	});
	if (!changed) {
		return mermaidText;
	}
	return serializePreservingDirectives(mermaidText, parsed.direction, parsed.nodes, nextEdges);
}

/**
 * Inserts, updates, or clears inline `%% task <nodeId> [owner=..., assignee=..., dept=..., min_tier=..., completers=...]`
 * metadata comments for a Mission Task DAG node without disrupting existing graph layout or other comments.
 */
export function upsertTaskMetadataInMermaid(
	mermaidText: string,
	nodeId: string,
	patch: {
		readonly ownerNodeId?: string | null;
		readonly assigneeNodeId?: string | null;
		readonly department?: string | null;
		readonly minCompleterTier?: number | null;
		readonly allowedCompleterNodeIds?: readonly string[] | null;
		readonly color?: string | null;
	},
): string {
	const cleanId = nodeId.trim();
	if (!cleanId) {
		return mermaidText;
	}
	const parsed = parseMissionMermaidDag(mermaidText);
	const existing = parsed.nodes.find(n => n.id === cleanId);
	if (!existing) {
		return mermaidText;
	}

	const nextOwner = patch.ownerNodeId === undefined ? existing.ownerNodeId : (patch.ownerNodeId?.trim() || undefined);
	const nextAssignee = patch.assigneeNodeId === undefined ? existing.assigneeNodeId : (patch.assigneeNodeId?.trim() || undefined);
	const nextDept = patch.department === undefined ? existing.department : (patch.department?.trim() || undefined);
	const nextMinTier = patch.minCompleterTier === undefined
		? existing.minCompleterTier
		: (typeof patch.minCompleterTier === 'number' && Number.isInteger(patch.minCompleterTier) && patch.minCompleterTier >= 0 ? patch.minCompleterTier : undefined);
	const nextCompleters = patch.allowedCompleterNodeIds === undefined
		? existing.allowedCompleterNodeIds
		: (patch.allowedCompleterNodeIds && patch.allowedCompleterNodeIds.length > 0
			? [...new Set(patch.allowedCompleterNodeIds.map(s => s.trim()).filter(Boolean))]
			: undefined);
	const nextColor = patch.color === undefined
		? normalizeAdeNodeColor(existing.color)
		: normalizeAdeNodeColor(patch.color);

	const formatVal = (v: string): string => /^[A-Za-z0-9_.:|#-]+$/.test(v) ? v : `"${escapeMermaidQuotedLabel(v)}"`;
	const parts: string[] = [];
	if (nextOwner) { parts.push(`owner=${formatVal(nextOwner)}`); }
	if (nextAssignee) { parts.push(`assignee=${formatVal(nextAssignee)}`); }
	if (nextDept) { parts.push(`dept=${formatVal(nextDept)}`); }
	if (nextMinTier !== undefined) { parts.push(`min_tier=${nextMinTier}`); }
	if (nextCompleters && nextCompleters.length > 0) { parts.push(`completers=${formatVal(nextCompleters.join('|'))}`); }
	if (nextColor) { parts.push(`color=${formatVal(nextColor)}`); }

	const directiveLine = parts.length > 0 ? `  %% task ${cleanId} [${parts.join(', ')}]` : undefined;
	const directiveRe = new RegExp(`^\\s*%%\\s*task\\s+${escapeRegExp(cleanId)}\\s*\\[[^\\]]*\\]\\s*$`, 'i');
	const lines = mermaidText.split(/\r?\n/);
	const kept: string[] = [];
	let replaced = false;
	for (const line of lines) {
		if (directiveRe.test(line)) {
			if (!replaced && directiveLine) {
				kept.push(directiveLine);
				replaced = true;
			}
			continue;
		}
		kept.push(line);
	}
	if (!replaced && directiveLine) {
		while (kept.length > 1 && kept[kept.length - 1].trim() === '') {
			kept.pop();
		}
		kept.push(directiveLine);
	}
	return kept.join('\n');
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

/**
 * Computes magnetic drag alignment snap deltas & visual reference guide lines against stationary nodes.
 * Checks left/center/right X edges and top/middle/bottom Y edges within `threshold` world pixels.
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

export interface IMissionCanvasHistorySnapshot {
	readonly mermaidText: string;
	readonly positions: Readonly<Record<string, IMissionNodePosition>>;
	readonly nodePrompts: Readonly<Record<string, string>>;
	readonly nodeChecks: Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
	readonly label: string;
	readonly timestamp?: number;
}

function cloneHistorySnapshot(snap: IMissionCanvasHistorySnapshot): IMissionCanvasHistorySnapshot {
	const positions: Record<string, IMissionNodePosition> = {};
	for (const [k, v] of Object.entries(snap.positions)) {
		positions[k] = { x: v.x, y: v.y };
	}
	const nodePrompts: Record<string, string> = {};
	for (const [k, v] of Object.entries(snap.nodePrompts)) {
		nodePrompts[k] = v;
	}
	const nodeChecks: Record<string, readonly IMissionNodeCheckHook[]> = {};
	for (const [k, list] of Object.entries(snap.nodeChecks)) {
		nodeChecks[k] = list.map(c => ({
			...c,
			...(c.expectFiles ? { expectFiles: [...c.expectFiles] } : {}),
		}));
	}
	return {
		mermaidText: snap.mermaidText,
		positions,
		nodePrompts,
		nodeChecks,
		label: snap.label,
		timestamp: snap.timestamp,
	};
}

/**
 * Bounded 50-step in-memory undo/redo snapshot stack for Mission Canvas visual DAG editing.
 */
export class MissionCanvasHistoryStack {
	private undoStack: IMissionCanvasHistorySnapshot[] = [];
	private redoStack: IMissionCanvasHistorySnapshot[] = [];

	constructor(private readonly maxEntries = 50) { }

	get undoCount(): number {
		return this.undoStack.length;
	}

	get redoCount(): number {
		return this.redoStack.length;
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	peekUndoLabel(): string | undefined {
		return this.undoStack[this.undoStack.length - 1]?.label;
	}

	peekRedoLabel(): string | undefined {
		return this.redoStack[this.redoStack.length - 1]?.label;
	}

	/**
	 * Pushes a pre-mutation snapshot onto the undo stack and clears redo history.
	 * When `coalesceMs > 0` and the top snapshot shares the same `label` within that window,
	 * keeps the earlier baseline so rapid edits (e.g. Mermaid typing) collapse into one Undo step.
	 */
	push(beforeSnapshot: IMissionCanvasHistorySnapshot, options?: { readonly coalesceMs?: number }): void {
		const now = beforeSnapshot.timestamp ?? Date.now();
		const top = this.undoStack[this.undoStack.length - 1];
		if (
			options?.coalesceMs
			&& top
			&& top.label === beforeSnapshot.label
			&& top.timestamp !== undefined
			&& now - top.timestamp <= options.coalesceMs
		) {
			this.redoStack = [];
			return;
		}
		this.undoStack.push(cloneHistorySnapshot({ ...beforeSnapshot, timestamp: now }));
		if (this.undoStack.length > this.maxEntries) {
			this.undoStack.splice(0, this.undoStack.length - this.maxEntries);
		}
		this.redoStack = [];
	}

	undo(currentSnapshot: IMissionCanvasHistorySnapshot): IMissionCanvasHistorySnapshot | undefined {
		const prev = this.undoStack.pop();
		if (!prev) {
			return undefined;
		}
		this.redoStack.push(cloneHistorySnapshot({ ...currentSnapshot, label: prev.label }));
		if (this.redoStack.length > this.maxEntries) {
			this.redoStack.splice(0, this.redoStack.length - this.maxEntries);
		}
		return cloneHistorySnapshot(prev);
	}

	redo(currentSnapshot: IMissionCanvasHistorySnapshot): IMissionCanvasHistorySnapshot | undefined {
		const next = this.redoStack.pop();
		if (!next) {
			return undefined;
		}
		this.undoStack.push(cloneHistorySnapshot({ ...currentSnapshot, label: next.label }));
		if (this.undoStack.length > this.maxEntries) {
			this.undoStack.splice(0, this.undoStack.length - this.maxEntries);
		}
		return cloneHistorySnapshot(next);
	}

	clear(): void {
		this.undoStack = [];
		this.redoStack = [];
	}
}
