/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IMissionDagEdge, IMissionDagNode } from './adeMissionDag.js';

export interface IMissionDagEmployeeGroup {
	/** Stable deduplication key ('emp:<normalized>' for named employees, or node ID for anonymous single-node tasks). */
	readonly key: string;
	/** Display name shown in the left sidebar and canvas reuse picker. */
	readonly displayName: string;
	/** True when explicitly named via `@Employee`, `:::Employee`, or `class ... Employee`. */
	readonly isExplicit: boolean;
	/** Topological-order list of DAG node IDs where this employee is scheduled. */
	readonly nodeIds: readonly string[];
	/** Matching clean task labels across those DAG positions. */
	readonly nodeLabels: readonly string[];
}

const RESERVED_STYLE_CLASSES = new Set([
	'task',
	'gate',
	'default',
	'node',
	'start',
	'end',
	'done',
	'active',
	'crit',
]);

const EMPLOYEE_NAME_PATTERN = '[A-Za-z0-9_\\u4e00-\\u9fff\\u3400-\\u4dbf\\u3040-\\u30ff\\uac00-\\ud7af-]+';
const PREFIX_EMPLOYEE_RE = new RegExp(`^@(${EMPLOYEE_NAME_PATTERN})\\s*(?:[:：|·]|\\s+-\\s+|\\r?\\n|<br\\s*\\/?>)\\s*([\\s\\S]*)$`, 'i');
const SUFFIX_EMPLOYEE_RE = new RegExp(`^([\\s\\S]+?)\\s*[\\(（]\\s*@(${EMPLOYEE_NAME_PATTERN})\\s*[\\)）]$`, 'i');
const STANDALONE_EMPLOYEE_RE = new RegExp(`^@(${EMPLOYEE_NAME_PATTERN})$`, 'i');
const TRAILING_CLASS_RE = new RegExp(`:::([A-Za-z0-9_\\u4e00-\\u9fff-]+)$`);
const CLASS_STMT_RE = new RegExp(`^class\\s+([^\\s;]+(?:\\s*,\\s*[^\\s;]+)*)\\s+(${EMPLOYEE_NAME_PATTERN})\\s*$`, 'i');

export function normalizeMissionEmployeeKey(rawName: string): string {
	return rawName.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function getEmployeeColorIndex(employeeKey: string): number {
	let hash = 2166136261;
	for (let i = 0; i < employeeKey.length; i++) {
		hash ^= employeeKey.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return Math.abs(hash) % 6;
}

/**
 * Extracts an optional inline `@Employee` assignment from a Mermaid node label while safely
 * ignoring email addresses (`user@example.com`) and scoped packages (`@types/node`).
 */
export function extractInlineEmployeeTag(rawLabel: string): { readonly employeeName?: string; readonly label: string } {
	const trimmed = rawLabel.trim();
	if (!trimmed) {
		return { label: '' };
	}

	const prefixMatch = PREFIX_EMPLOYEE_RE.exec(trimmed);
	if (prefixMatch) {
		const employeeName = prefixMatch[1].trim();
		const rest = prefixMatch[2].trim();
		return {
			employeeName,
			label: rest || employeeName,
		};
	}

	const suffixMatch = SUFFIX_EMPLOYEE_RE.exec(trimmed);
	if (suffixMatch) {
		const rest = suffixMatch[1].trim();
		const employeeName = suffixMatch[2].trim();
		return {
			employeeName,
			label: rest || employeeName,
		};
	}

	const standaloneMatch = STANDALONE_EMPLOYEE_RE.exec(trimmed);
	if (standaloneMatch) {
		const employeeName = standaloneMatch[1].trim();
		return {
			employeeName,
			label: employeeName,
		};
	}

	return { label: trimmed };
}

/**
 * Strips a trailing Mermaid `:::ClassName` attachment from a node token, returning the base token
 * and an employee name if the class is not a reserved styling keyword.
 */
export function stripTrailingMermaidClass(rawToken: string): { readonly baseToken: string; readonly className?: string } {
	const trimmed = rawToken.trim();
	const match = TRAILING_CLASS_RE.exec(trimmed);
	if (!match) {
		return { baseToken: trimmed };
	}
	const className = match[1].trim();
	const baseToken = trimmed.slice(0, match.index).trim();
	if (!className || RESERVED_STYLE_CLASSES.has(className.toLowerCase())) {
		return { baseToken };
	}
	return { baseToken, className };
}

/**
 * Parses a standard Mermaid `class N1,N3 Backend` statement into node IDs and an employee name.
 */
export function parseClassAssignmentLine(stmt: string): { readonly nodeIds: readonly string[]; readonly className: string } | undefined {
	const match = CLASS_STMT_RE.exec(stmt.trim());
	if (!match) {
		return undefined;
	}
	const className = match[2].trim();
	if (!className || RESERVED_STYLE_CLASSES.has(className.toLowerCase())) {
		return undefined;
	}
	const nodeIds = match[1].split(',').map(s => s.trim()).filter(Boolean);
	return nodeIds.length > 0 ? { nodeIds, className } : undefined;
}

function computeTopologicalOrder(nodes: readonly IMissionDagNode[], edges: readonly IMissionDagEdge[]): string[] {
	const inDeg = new Map<string, number>();
	const outgoing = new Map<string, string[]>();
	for (const n of nodes) {
		inDeg.set(n.id, 0);
		outgoing.set(n.id, []);
	}
	for (const e of edges) {
		outgoing.get(e.from)?.push(e.to);
		inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
	}
	const queue: string[] = nodes.filter(n => (inDeg.get(n.id) ?? 0) === 0).map(n => n.id);
	const order: string[] = [];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		order.push(id);
		for (const next of outgoing.get(id) ?? []) {
			const deg = (inDeg.get(next) ?? 1) - 1;
			inDeg.set(next, deg);
			if (deg <= 0) {
				queue.push(next);
			}
		}
	}
	for (const n of nodes) {
		if (!seen.has(n.id)) {
			order.push(n.id);
		}
	}
	return order;
}

/**
 * Enriches DAG task nodes with topological occurrence indices (`#1/3`, `#2/3`, `#3/3`) for any
 * employee scheduled at multiple DAG positions, and produces deduplicated employee groups for
 * locked sidebar employee syncing.
 */
export function buildMissionEmployeeGroups(
	nodes: readonly IMissionDagNode[],
	edges: readonly IMissionDagEdge[],
): {
	readonly enrichedNodes: readonly IMissionDagNode[];
	readonly employees: readonly IMissionDagEmployeeGroup[];
} {
	const topoOrder = computeTopologicalOrder(nodes, edges);
	const topoRank = new Map<string, number>();
	topoOrder.forEach((id, idx) => topoRank.set(id, idx));

	const grouped = new Map<string, {
		readonly key: string;
		readonly displayName: string;
		readonly isExplicit: boolean;
		readonly members: IMissionDagNode[];
	}>();

	const taskNodesInTopo = [...nodes]
		.filter(n => n.kind === 'task')
		.sort((a, b) => (topoRank.get(a.id) ?? 0) - (topoRank.get(b.id) ?? 0));

	for (const node of taskNodesInTopo) {
		if (node.employeeKey && node.employeeName) {
			const groupKey = `emp:${node.employeeKey}`;
			let bucket = grouped.get(groupKey);
			if (!bucket) {
				bucket = {
					key: groupKey,
					displayName: node.employeeName,
					isExplicit: true,
					members: [],
				};
				grouped.set(groupKey, bucket);
			}
			bucket.members.push(node);
		} else {
			grouped.set(node.id, {
				key: node.id,
				displayName: `[${node.id}] ${node.label}`,
				isExplicit: false,
				members: [node],
			});
		}
	}

	const occByNodeId = new Map<string, { readonly index: number; readonly total: number; readonly displayName: string }>();
	const employees: IMissionDagEmployeeGroup[] = [];
	for (const bucket of grouped.values()) {
		employees.push({
			key: bucket.key,
			displayName: bucket.displayName,
			isExplicit: bucket.isExplicit,
			nodeIds: bucket.members.map(m => m.id),
			nodeLabels: bucket.members.map(m => m.label),
		});
		if (bucket.isExplicit) {
			const total = bucket.members.length;
			bucket.members.forEach((member, idx) => {
				occByNodeId.set(member.id, { index: idx + 1, total, displayName: bucket.displayName });
			});
		}
	}

	const enrichedNodes: IMissionDagNode[] = nodes.map(node => {
		const occ = occByNodeId.get(node.id);
		if (!occ) {
			return node;
		}
		return {
			...node,
			employeeName: occ.displayName,
			employeeOccurrence: occ.index,
			employeeTotalOccurrences: occ.total,
		};
	});

	return { enrichedNodes, employees };
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeMermaidQuoted(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Pure frontend Mermaid text rewriter: assigns (or clears) an employee on a specific DAG node ID
 * directly inside `mission.mmd` so the Mermaid file remains the single source of truth.
 */
export function setNodeEmployeeInMermaid(
	mermaidText: string,
	nodeId: string,
	employeeName: string | undefined,
): string {
	const rawClean = employeeName?.trim().replace(/^@+/, '')
		.replace(/[\s:：|·()（）"'/\\,]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '') || '';
	const cleanEmp = rawClean || undefined;
	const escapedId = escapeRegExp(nodeId);

	// 1. Remove nodeId from any standalone `class N1,N3 Emp` lines so inline assignment is authoritative
	const nextLines: string[] = [];
	for (const line of mermaidText.split(/\r?\n/)) {
		const trimmed = line.trim();
		const classParsed = parseClassAssignmentLine(trimmed.replace(/;$/, ''));
		if (!classParsed || !classParsed.nodeIds.includes(nodeId)) {
			nextLines.push(line);
			continue;
		}
		const remaining = classParsed.nodeIds.filter(id => id !== nodeId);
		if (remaining.length > 0) {
			const indent = /^(\s*)/.exec(line)?.[1] ?? '';
			nextLines.push(`${indent}class ${remaining.join(',')} ${classParsed.className}`);
		}
	}

	let updated = nextLines.join('\n');

	// 2. Replace the first shaped task definition of nodeId (including [[...]], ([...]), ((...)), [...], (...)) and strip trailing :::Class
	const shapedRe = new RegExp(
		`(^|[^A-Za-z0-9_-])(${escapedId})\\s*(\\[\\[[\\s\\S]*?\\]\\]|\\(\\[[\\s\\S]*?\\]\\)|\\(\\([\\s\\S]*?\\)\\)|\\[[\\s\\S]*?\\]|\\([\\s\\S]*?\\))(:::[A-Za-z0-9_\\u4e00-\\u9fff-]+)?`,
	);
	let replaced = false;
	updated = updated.replace(shapedRe, (_full, prefix: string, id: string, shape: string) => {
		replaced = true;
		let inner = shape;
		if ((shape.startsWith('[[') && shape.endsWith(']]')) || (shape.startsWith('([') && shape.endsWith('])')) || (shape.startsWith('((') && shape.endsWith('))'))) {
			inner = shape.slice(2, -2);
		} else {
			inner = shape.slice(1, -1);
		}
		const trimmedInner = inner.trim();
		const unquoted = ((trimmedInner.startsWith('"') && trimmedInner.endsWith('"')) || (trimmedInner.startsWith('\'') && trimmedInner.endsWith('\'')))
			? trimmedInner.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
			: trimmedInner;
		const { label } = extractInlineEmployeeTag(unquoted);
		const cleanLabel = label || id;
		const nextLabel = cleanEmp ? `@${cleanEmp}: ${cleanLabel}` : cleanLabel;
		return `${prefix}${id}["${escapeMermaidQuoted(nextLabel)}"]`;
	});

	// 3. Also strip any remaining `nodeId:::Class` on subsequent references
	const trailingClassOnNodeRe = new RegExp(`(^|[^A-Za-z0-9_-])(${escapedId}):::[A-Za-z0-9_\\u4e00-\\u9fff-]+`, 'g');
	updated = updated.replace(trailingClassOnNodeRe, '$1$2');

	// 4. If nodeId only appeared as a bare identifier outside quotes & directives (and not a gate `{...}`), shape its first occurrence
	if (!replaced && cleanEmp) {
		const bareLineRe = new RegExp(`(^|[^A-Za-z0-9_-])(${escapedId})(?![A-Za-z0-9_-]|\\s*\\{)`);
		let doneBare = false;
		updated = updated.split(/\r?\n/).map(line => {
			if (doneBare) {
				return line;
			}
			const trimmed = line.trim();
			if (!trimmed || /^(?:flowchart|graph|subgraph|end$|direction|classDef|class|style|linkStyle|click|accTitle|accDescr|%%)/i.test(trimmed)) {
				return line;
			}
			// Split line into alternating unquoted / quoted chunks so we never rewrite inside quotes
			const chunks = line.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g);
			for (let i = 0; i < chunks.length; i += 2) {
				if (bareLineRe.test(chunks[i])) {
					chunks[i] = chunks[i].replace(bareLineRe, (_f, pfx: string, id: string) => `${pfx}${id}["${escapeMermaidQuoted(`@${cleanEmp}: ${id}`)}"]`);
					doneBare = true;
					break;
				}
			}
			return chunks.join('');
		}).join('\n');
	}

	return updated;
}
