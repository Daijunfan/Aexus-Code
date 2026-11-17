/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AdeEngineeringEdgeVisualStatus,
	AdeEngineeringNodeType,
	AdeEngineeringNodeVisualStatus,
	AdeThinkingLevel,
	AdeWorkspaceIsolationMode,
	AdeWorkTreeType,
	DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
	IAdeEngineeringBlueprint,
	IAdeEngineeringBlueprintEdge,
	IAdeEngineeringBlueprintMetadata,
	IAdeEngineeringBlueprintNode,
	IAdeEngineeringManagerSegment,
	IAdeEngineeringNodeRuntimeState,
	IAdeIncrementalReportEntry,
	IAdeNodeCanvasPosition,
	IAdeRoleModelConfig,
} from './adeEngineering.js';

export class AdeBlueprintValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AdeBlueprintValidationError';
	}
}

const CANONICAL_ENGINE_MAP: Record<string, string> = {
	claude: 'claude-code',
	'claude-code': 'claude-code',
	'aexus-claude': 'claude-code',
	codex: 'codex',
	'aexus-codex': 'codex',
	kilo: 'kilo',
	'kilo-code': 'kilo',
	kilocode: 'kilo',
	'aexus-kilo': 'kilo',
	opencode: 'opencode',
	'aexus-opencode': 'opencode',
	dsh: 'dsh',
	deepseek: 'dsh',
	'deepseek-harness': 'dsh',
	'aexus-dsh': 'dsh',
	agy: 'antigravity',
	antigravity: 'antigravity',
	'google-antigravity': 'antigravity',
	'aexus-antigravity': 'antigravity',
	cline: 'cline',
	'aexus-cline': 'cline',
	pi: 'pi',
	'aexus-pi': 'pi',
};

const ADE_ENGINE_ID_MAP: Record<string, string> = {
	'claude-code': 'aexus-claude',
	codex: 'aexus-codex',
	kilo: 'aexus-kilo',
	opencode: 'aexus-opencode',
	dsh: 'aexus-dsh',
	antigravity: 'aexus-antigravity',
	cline: 'aexus-cline',
	pi: 'aexus-pi',
};

const MERMAID_SHORT_ENGINE_MAP: Record<string, string> = {
	'claude-code': 'claude',
	codex: 'codex',
	kilo: 'kilo',
	opencode: 'opencode',
	dsh: 'dsh',
	antigravity: 'agy',
	cline: 'cline',
	pi: 'pi',
};

export function normalizeBlueprintEngine(raw: string | undefined, fallback = 'claude-code'): string {
	if (!raw || !raw.trim()) {
		return fallback;
	}
	const key = raw.trim().toLowerCase();
	return CANONICAL_ENGINE_MAP[key] ?? key;
}

export function toAdeEngineId(blueprintEngine: string | undefined, fallback = 'aexus-claude'): string {
	if (!blueprintEngine || !blueprintEngine.trim()) {
		return fallback;
	}
	const canonical = normalizeBlueprintEngine(blueprintEngine);
	if (ADE_ENGINE_ID_MAP[canonical]) {
		return ADE_ENGINE_ID_MAP[canonical];
	}
	return canonical.startsWith('aexus-') ? canonical : `aexus-${canonical}`;
}

export function toMermaidShortEngine(blueprintEngine: string | undefined): string {
	const canonical = normalizeBlueprintEngine(blueprintEngine);
	return MERMAID_SHORT_ENGINE_MAP[canonical] ?? canonical;
}

export function normalizeThinkingLevel(raw: string | undefined, fallback: AdeThinkingLevel = 'high'): AdeThinkingLevel {
	if (!raw) {
		return fallback;
	}
	const lower = raw.trim().toLowerCase();
	if (lower === 'off' || lower === 'none' || lower === 'disabled' || lower === 'disable' || lower === '0' || lower === 'false' || lower === 'cancel') {
		return 'off';
	}
	if (lower === 'low' || lower === 'minimal') {
		return 'low';
	}
	if (lower === 'medium' || lower === 'med' || lower === 'normal') {
		return 'medium';
	}
	if (lower === 'max' || lower === 'xhigh' || lower === 'ultra') {
		return 'max';
	}
	if (lower === 'high') {
		return 'high';
	}
	return fallback;
}

interface IParsedMermaidNodeToken {
	readonly id: string;
	readonly rawShape?: 'task' | 'user_gate';
	readonly rawLabel?: string;
}

function parseMermaidNodeEndpoint(rawToken: string): IParsedMermaidNodeToken {
	const trimmed = rawToken.trim();
	if (!trimmed) {
		throw new AdeBlueprintValidationError('Empty node token in Mermaid flowchart.');
	}

	// Double curly braces: U1{{"Label"}} or U1{{Label}}
	const hexMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*\{\{\s*"?([\s\S]*?)"?\s*\}\}$/);
	if (hexMatch) {
		return { id: hexMatch[1], rawShape: 'user_gate', rawLabel: hexMatch[2].trim() };
	}

	// Single curly braces: U1{"Label"} or U1{Label}
	const diamondMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*\{\s*"?([\s\S]*?)"?\s*\}$/);
	if (diamondMatch) {
		return { id: diamondMatch[1], rawShape: 'user_gate', rawLabel: diamondMatch[2].trim() };
	}

	// Stadium / rounded / rectangular brackets: N1["Label"], N1("Label"), N1(["Label"]), N1[Label]
	const rectMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*(?:\(\[|\[|\()\s*"?([\s\S]*?)"?\s*(?:\]\)|\]|\))$/);
	if (rectMatch) {
		return { id: rectMatch[1], rawShape: 'task', rawLabel: rectMatch[2].trim() };
	}

	// Plain identifier: N1
	const idMatch = trimmed.match(/^([A-Za-z0-9_-]+)$/);
	if (idMatch) {
		return { id: idMatch[1] };
	}

	throw new AdeBlueprintValidationError(`Invalid Mermaid node syntax: "${trimmed}"`);
}

interface IMermaidInlineHints {
	readonly title: string;
	readonly critical?: boolean;
	readonly workerEngine?: string;
	readonly workerThinking?: AdeThinkingLevel;
	readonly employeeEngine?: string;
	readonly employeeThinking?: AdeThinkingLevel;
}

function parseMermaidLabelHints(rawLabel: string): IMermaidInlineHints {
	const parts = rawLabel.split('|').map(s => s.trim()).filter(Boolean);
	let titlePart = parts[0] ?? rawLabel.trim();
	let critical: boolean | undefined;

	if (/★\s*Critical\b/i.test(titlePart) || /\[Critical\]/i.test(titlePart)) {
		critical = true;
		titlePart = titlePart
			.replace(/★\s*Critical\b/gi, '')
			.replace(/\[Critical\]/gi, '')
			.trim();
	}

	let workerEngine: string | undefined;
	let workerThinking: AdeThinkingLevel | undefined;
	let employeeEngine: string | undefined;
	let employeeThinking: AdeThinkingLevel | undefined;

	for (let i = 1; i < parts.length; i++) {
		const kvSegments = parts[i].split(/[;,]/).map(s => s.trim()).filter(Boolean);
		for (const seg of kvSegments) {
			const eqIdx = seg.indexOf('=');
			if (eqIdx === -1) {
				if (/^critical$/i.test(seg)) {
					critical = true;
				}
				continue;
			}
			const key = seg.slice(0, eqIdx).trim().toLowerCase();
			const val = seg.slice(eqIdx + 1).trim();
			if (key === 'worker') {
				const [eng, think] = val.split(':');
				if (eng) {
					workerEngine = normalizeBlueprintEngine(eng);
				}
				if (think) {
					workerThinking = normalizeThinkingLevel(think, 'high');
				}
			} else if (key === 'employee') {
				const [eng, think] = val.split(':');
				if (eng) {
					employeeEngine = normalizeBlueprintEngine(eng);
				}
				if (think) {
					employeeThinking = normalizeThinkingLevel(think, 'medium');
				}
			} else if (key === 'critical') {
				critical = val.toLowerCase() === 'true' || val === '1';
			}
		}
	}

	return {
		title: titlePart || rawLabel.trim(),
		critical,
		workerEngine,
		workerThinking,
		employeeEngine,
		employeeThinking,
	};
}

/**
 * Splits a Mermaid flowchart statement by top-level arrow operators (`-->`, `-.->`, `==>`, `-- text -->`),
 * ignoring arrows inside quotes `""` or bracketed node labels `[...]` / `{{...}}`.
 */
function splitMermaidChainLine(line: string): { readonly stages: readonly string[]; readonly labels: readonly (string | undefined)[] } | undefined {
	const stages: string[] = [];
	const labels: (string | undefined)[] = [];
	let inQuotes = false;
	let squareDepth = 0;
	let curlyDepth = 0;
	let parenDepth = 0;
	let lastStart = 0;

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"' && line[i - 1] !== '\\') {
			inQuotes = !inQuotes;
			continue;
		}
		if (inQuotes) {
			continue;
		}
		if (ch === '[') { squareDepth++; continue; }
		if (ch === ']') { squareDepth = Math.max(0, squareDepth - 1); continue; }
		if (ch === '{') { curlyDepth++; continue; }
		if (ch === '}') { curlyDepth = Math.max(0, curlyDepth - 1); continue; }
		if (ch === '(') { parenDepth++; continue; }
		if (ch === ')') { parenDepth = Math.max(0, parenDepth - 1); continue; }

		if (squareDepth > 0 || curlyDepth > 0 || parenDepth > 0) {
			continue;
		}

		const rest = line.slice(i);
		// Match `-->|label|`, `-.->|label|`, `==>|label|`, `-->`, `--->`, `-.->`, `==>`
		const arrowMatch = rest.match(/^(?:--+>|\.+->|==+>|-+\.-+>)(?:\|([^|]*)\|)?/);
		if (arrowMatch) {
			stages.push(line.slice(lastStart, i).trim());
			labels.push(arrowMatch[1]?.trim() || undefined);
			i += arrowMatch[0].length - 1;
			lastStart = i + 1;
			continue;
		}
		// Match `-- label -->`
		const labeledArrow = rest.match(/^--\s+([^->\n]+?)\s+--+>/);
		if (labeledArrow) {
			stages.push(line.slice(lastStart, i).trim());
			labels.push(labeledArrow[1]?.trim() || undefined);
			i += labeledArrow[0].length - 1;
			lastStart = i + 1;
		}
	}

	if (stages.length === 0) {
		return undefined;
	}
	stages.push(line.slice(lastStart).trim());
	return { stages, labels };
}

function splitAmpersandGroup(groupText: string): string[] {
	const items: string[] = [];
	let inQuotes = false;
	let squareDepth = 0;
	let curlyDepth = 0;
	let parenDepth = 0;
	let start = 0;

	for (let i = 0; i < groupText.length; i++) {
		const ch = groupText[i];
		if (ch === '"' && groupText[i - 1] !== '\\') {
			inQuotes = !inQuotes;
			continue;
		}
		if (inQuotes) { continue; }
		if (ch === '[') { squareDepth++; continue; }
		if (ch === ']') { squareDepth = Math.max(0, squareDepth - 1); continue; }
		if (ch === '{') { curlyDepth++; continue; }
		if (ch === '}') { curlyDepth = Math.max(0, curlyDepth - 1); continue; }
		if (ch === '(') { parenDepth++; continue; }
		if (ch === ')') { parenDepth = Math.max(0, parenDepth - 1); continue; }

		if (ch === '&' && squareDepth === 0 && curlyDepth === 0 && parenDepth === 0) {
			const slice = groupText.slice(start, i).trim();
			if (slice) { items.push(slice); }
			start = i + 1;
		}
	}
	const tail = groupText.slice(start).trim();
	if (tail) { items.push(tail); }
	return items;
}

function parseInlineRoleConfig(raw: string, fallbackEngine: string, fallbackThinking: AdeThinkingLevel): IAdeRoleModelConfig {
	let engine = fallbackEngine;
	let model: string | undefined;
	let thinking: AdeThinkingLevel = fallbackThinking;

	const pairs = raw.split(',').map(part => part.trim()).filter(Boolean);
	for (const pair of pairs) {
		const eq = pair.indexOf('=');
		if (eq === -1) {
			continue;
		}
		const key = pair.slice(0, eq).trim().toLowerCase();
		const val = pair.slice(eq + 1).trim();
		if (!val) {
			continue;
		}
		if (key === 'engine') {
			engine = normalizeBlueprintEngine(val, fallbackEngine);
		} else if (key === 'model') {
			model = val;
		} else if (key === 'thinking' || key === 'effort') {
			thinking = normalizeThinkingLevel(val, fallbackThinking);
		}
	}
	return {
		engine,
		...(model ? { model } : {}),
		thinking,
	};
}

interface IMutableNodeDraft {
	id: string;
	title?: string;
	type?: AdeEngineeringNodeType;
	critical?: boolean;
	employee?: IAdeRoleModelConfig;
	worker?: IAdeRoleModelConfig;
	goal?: string;
	acceptance?: string;
	description?: string;
	position?: IAdeNodeCanvasPosition;
}

/**
 * Validates that the node/edge graph is a valid Directed Acyclic Graph (DAG) and returns
 * node IDs in deterministic topological order. Throws `AdeBlueprintValidationError` on cycles.
 */
export function topologicalSortNodes(
	nodes: readonly { readonly id: string }[],
	edges: readonly IAdeEngineeringBlueprintEdge[],
): string[] {
	const nodeSet = new Set<string>();
	const orderIndex = new Map<string, number>();
	for (let i = 0; i < nodes.length; i++) {
		const id = nodes[i].id;
		if (nodeSet.has(id)) {
			throw new AdeBlueprintValidationError(`Duplicate node ID in blueprint: "${id}".`);
		}
		nodeSet.add(id);
		orderIndex.set(id, i);
	}

	const outgoing = new Map<string, string[]>();
	const inDegree = new Map<string, number>();
	for (const id of nodeSet) {
		outgoing.set(id, []);
		inDegree.set(id, 0);
	}

	const seenEdges = new Set<string>();
	for (const edge of edges) {
		if (!nodeSet.has(edge.from)) {
			throw new AdeBlueprintValidationError(`Edge references unknown source node "${edge.from}".`);
		}
		if (!nodeSet.has(edge.to)) {
			throw new AdeBlueprintValidationError(`Edge references unknown target node "${edge.to}".`);
		}
		if (edge.from === edge.to) {
			throw new AdeBlueprintValidationError(`Self-loop detected on node "${edge.from}". Engineering graph must be a DAG.`);
		}
		const edgeKey = `${edge.from}->${edge.to}`;
		if (seenEdges.has(edgeKey)) {
			continue;
		}
		seenEdges.add(edgeKey);
		outgoing.get(edge.from)!.push(edge.to);
		inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
	}

	const ready = [...nodeSet]
		.filter(id => (inDegree.get(id) ?? 0) === 0)
		.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));

	const sorted: string[] = [];
	while (ready.length > 0) {
		const curr = ready.shift()!;
		sorted.push(curr);
		for (const next of outgoing.get(curr) ?? []) {
			const nextDeg = (inDegree.get(next) ?? 1) - 1;
			inDegree.set(next, nextDeg);
			if (nextDeg === 0) {
				ready.push(next);
				ready.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
			}
		}
	}

	if (sorted.length !== nodeSet.size) {
		// Find an explicit cycle path for clear diagnostics
		const state = new Map<string, 0 | 1 | 2>();
		const stack: string[] = [];
		const findCycle = (u: string): string[] | undefined => {
			state.set(u, 1);
			stack.push(u);
			for (const v of outgoing.get(u) ?? []) {
				const st = state.get(v) ?? 0;
				if (st === 1) {
					const idx = stack.indexOf(v);
					return [...stack.slice(idx), v];
				}
				if (st === 0) {
					const found = findCycle(v);
					if (found) {
						return found;
					}
				}
			}
			stack.pop();
			state.set(u, 2);
			return undefined;
		};
		for (const id of nodeSet) {
			if ((state.get(id) ?? 0) === 0) {
				const cycle = findCycle(id);
				if (cycle) {
					throw new AdeBlueprintValidationError(`Cycle detected in Engineering DAG: ${cycle.join(' -> ')}`);
				}
			}
		}
		throw new AdeBlueprintValidationError('Cycle detected in Engineering DAG.');
	}

	return sorted;
}

export function formatManagerSegmentId(nodeIds: readonly string[]): string {
	return nodeIds.join('->');
}

/**
 * 100% Automatic Maximal Non-Branching Path Manager Partitioning (Spec 2.3):
 *
 * - Splits before and after every branch node (`outDegree > 1`) and merge node (`inDegree > 1`).
 * - Treats `user_gate` nodes as hard boundaries without AI executors (never included in a Manager segment).
 * - Guarantees disjoint, contiguous AI execution chains in deterministic topological order.
 */
export function partitionEngineeringManagers(
	nodes: readonly IAdeEngineeringBlueprintNode[],
	edges: readonly IAdeEngineeringBlueprintEdge[],
	existingManagers: readonly IAdeEngineeringManagerSegment[] = [],
	defaultEngine = 'claude-code',
): IAdeEngineeringManagerSegment[] {
	const topoOrder = topologicalSortNodes(nodes, edges);
	const nodeById = new Map(nodes.map(node => [node.id, node]));

	const dedupEdges: IAdeEngineeringBlueprintEdge[] = [];
	const seenEdgeKeys = new Set<string>();
	for (const edge of edges) {
		const key = `${edge.from}->${edge.to}`;
		if (!seenEdgeKeys.has(key)) {
			seenEdgeKeys.add(key);
			dedupEdges.push(edge);
		}
	}

	const outEdges = new Map<string, string[]>();
	const inEdges = new Map<string, string[]>();
	for (const node of nodes) {
		outEdges.set(node.id, []);
		inEdges.set(node.id, []);
	}
	for (const edge of dedupEdges) {
		outEdges.get(edge.from)!.push(edge.to);
		inEdges.get(edge.to)!.push(edge.from);
	}

	// Build joined successor/predecessor map along maximal non-branching task paths:
	// Join u -> v iff:
	//   1. Both u and v are 'task' nodes (not 'user_gate')
	//   2. outDegree_G(u) === 1
	//   3. inDegree_G(v) === 1
	const joinedNext = new Map<string, string>();
	const joinedPrev = new Map<string, string>();

	for (const edge of dedupEdges) {
		const u = nodeById.get(edge.from);
		const v = nodeById.get(edge.to);
		if (!u || !v || u.type !== 'task' || v.type !== 'task') {
			continue;
		}
		if ((outEdges.get(u.id)?.length ?? 0) === 1 && (inEdges.get(v.id)?.length ?? 0) === 1) {
			joinedNext.set(u.id, v.id);
			joinedPrev.set(v.id, u.id);
		}
	}

	const existingBySegmentId = new Map<string, IAdeRoleModelConfig>();
	const existingByNodeId = new Map<string, IAdeRoleModelConfig>();
	for (const mgr of existingManagers) {
		existingBySegmentId.set(mgr.segmentId, mgr.config);
		for (const nid of mgr.nodeIds) {
			existingByNodeId.set(nid, mgr.config);
		}
		// Also map bare single-node ID or arrow-separated IDs parsed from markdown headers
		for (const part of mgr.segmentId.split(/\s*->\s*|\s*,\s*/).filter(Boolean)) {
			if (!existingByNodeId.has(part)) {
				existingByNodeId.set(part, mgr.config);
			}
		}
	}

	const segments: IAdeEngineeringManagerSegment[] = [];
	const visited = new Set<string>();

	for (const id of topoOrder) {
		const node = nodeById.get(id);
		if (!node || node.type !== 'task' || visited.has(id)) {
			continue;
		}
		// Start from the head of this non-branching chain
		let head = id;
		while (joinedPrev.has(head)) {
			head = joinedPrev.get(head)!;
		}
		if (visited.has(head)) {
			continue;
		}
		const chain: string[] = [];
		let cursor: string | undefined = head;
		while (cursor && !visited.has(cursor)) {
			visited.add(cursor);
			chain.push(cursor);
			cursor = joinedNext.get(cursor);
		}

		const segmentId = formatManagerSegmentId(chain);
		const tailId = chain[chain.length - 1];
		const matchedConfig = existingBySegmentId.get(segmentId)
			?? existingByNodeId.get(tailId)
			?? existingByNodeId.get(head)
			?? {
				engine: normalizeBlueprintEngine(defaultEngine),
				thinking: 'high' as AdeThinkingLevel,
			};

		segments.push({
			segmentId,
			nodeIds: chain,
			config: {
				engine: normalizeBlueprintEngine(matchedConfig.engine, defaultEngine),
				...(matchedConfig.model ? { model: matchedConfig.model } : {}),
				thinking: normalizeThinkingLevel(matchedConfig.thinking, 'high'),
			},
		});
	}

	return segments;
}

/**
 * Parses a hybrid `blueprint.md` (Mermaid flowchart block + structured Markdown sections)
 * into a validated `IAdeEngineeringBlueprint` with automatically partitioned Manager segments.
 */
export function parseEngineeringBlueprint(
	markdownText: string,
	defaults?: {
		readonly governorSessionId?: string;
		readonly treeType?: AdeWorkTreeType;
		readonly defaultEngine?: string;
	},
): IAdeEngineeringBlueprint {
	const normalizedText = markdownText.replace(/\r\n/g, '\n');
	const fallbackEngine = normalizeBlueprintEngine(defaults?.defaultEngine, 'claude-code');

	const mermaidMatch = normalizedText.match(/```mermaid\s*\n([\s\S]*?)```/i);
	if (!mermaidMatch) {
		throw new AdeBlueprintValidationError('Blueprint must contain a ```mermaid flowchart block.');
	}
	const mermaidBody = mermaidMatch[1];

	let flowDirection: 'LR' | 'TD' = 'LR';
	const nodeDrafts = new Map<string, IMutableNodeDraft>();
	const parsedPositions = new Map<string, IAdeNodeCanvasPosition>();
	const rawEdges: IAdeEngineeringBlueprintEdge[] = [];
	const mermaidInlineHints = new Map<string, IMermaidInlineHints>();

	const ensureDraft = (token: IParsedMermaidNodeToken): IMutableNodeDraft => {
		let draft = nodeDrafts.get(token.id);
		if (!draft) {
			draft = { id: token.id };
			nodeDrafts.set(token.id, draft);
		}
		if (token.rawShape) {
			draft.type = token.rawShape;
		}
		if (token.rawLabel) {
			const hints = parseMermaidLabelHints(token.rawLabel);
			mermaidInlineHints.set(token.id, hints);
			draft.title = hints.title;
			if (hints.critical !== undefined) {
				draft.critical = hints.critical;
			}
		}
		return draft;
	};

	for (const rawLine of mermaidBody.split('\n')) {
		const trimmed = rawLine.trim();
		if (!trimmed) {
			continue;
		}
		const posMatch = trimmed.match(/^%%\s*@pos\s+([A-Za-z0-9_-]+)\s+(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
		if (posMatch) {
			parsedPositions.set(posMatch[1], { x: Number(posMatch[2]), y: Number(posMatch[3]) });
			continue;
		}
		if (trimmed.startsWith('%%')) {
			continue;
		}
		const headerMatch = trimmed.match(/^(?:flowchart|graph)\s+(LR|RL|TD|TB|BT)\b/i);
		if (headerMatch) {
			const dir = headerMatch[1].toUpperCase();
			flowDirection = (dir === 'TD' || dir === 'TB' || dir === 'BT') ? 'TD' : 'LR';
			continue;
		}
		if (/^(?:subgraph|end|classDef|class|style|linkStyle|direction)\b/i.test(trimmed)) {
			continue;
		}

		const statement = trimmed.replace(/;$/, '').trim();
		const chain = splitMermaidChainLine(statement);
		if (chain) {
			const stageGroups = chain.stages.map(stage => splitAmpersandGroup(stage).map(tok => {
				const parsed = parseMermaidNodeEndpoint(tok);
				ensureDraft(parsed);
				return parsed.id;
			}));
			for (let s = 0; s < stageGroups.length - 1; s++) {
				const label = chain.labels[s];
				for (const fromId of stageGroups[s]) {
					for (const toId of stageGroups[s + 1]) {
						rawEdges.push({ from: fromId, to: toId, ...(label ? { label } : {}) });
					}
				}
			}
		} else {
			for (const tok of splitAmpersandGroup(statement)) {
				const parsed = parseMermaidNodeEndpoint(tok);
				ensureDraft(parsed);
			}
		}
	}

	// Parse Markdown sections outside the Mermaid block
	const restMarkdown = normalizedText.slice((mermaidMatch.index ?? 0) + mermaidMatch[0].length);
	const lines = restMarkdown.split('\n');

	let treeType: AdeWorkTreeType = defaults?.treeType ?? 'engineering';
	let governorSessionId = defaults?.governorSessionId ?? '';
	let workspaceIsolation: AdeWorkspaceIsolationMode = 'shared';
	let watchdogTimeoutMinutes = DEFAULT_WATCHDOG_TIMEOUT_MINUTES;

	// Optional YAML frontmatter before the Mermaid block (`---\nkey: val\n---`)
	const frontmatterMatch = normalizedText.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
	if (frontmatterMatch) {
		for (const fmLine of frontmatterMatch[1].split('\n')) {
			const fmKv = fmLine.trim().match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
			if (!fmKv) { continue; }
			const fk = fmKv[1].toLowerCase();
			const fv = fmKv[2].trim();
			if (fk === 'tree_type' || fk === 'treetype') {
				treeType = fv.toLowerCase() === 'research' ? 'research' : 'engineering';
			} else if (fk === 'governor_session_id' || fk === 'governorsessionid') {
				if (fv && !/^<.*>$/.test(fv)) { governorSessionId = fv; }
			} else if (fk === 'workspace_isolation' || fk === 'workspaceisolation') {
				workspaceIsolation = fv.toLowerCase() === 'worktree' ? 'worktree' : 'shared';
			} else if (fk === 'watchdog_timeout_minutes' || fk === 'watchdogtimeoutminutes') {
				const num = Number(fv);
				if (Number.isFinite(num) && num > 0) { watchdogTimeoutMinutes = num; }
			}
		}
	}

	const parsedManagers: IAdeEngineeringManagerSegment[] = [];

	type SectionKind = 'none' | 'metadata' | 'managers' | 'nodes';
	let currentSection: SectionKind = 'none';
	let currentSegmentId: string | undefined;
	let currentSegmentCfg: { engine: string; model?: string; thinking: AdeThinkingLevel } | undefined;
	let currentNodeDraft: IMutableNodeDraft | undefined;
	let activeNestedRole: 'employee' | 'worker' | undefined;
	let activeNodeProseSubheading: 'goal' | 'acceptance' | 'description' | undefined;

	const bindCurrentNode = (nodeId: string, headingTitle?: string) => {
		activeNestedRole = undefined;
		activeNodeProseSubheading = undefined;
		let draft = nodeDrafts.get(nodeId);
		if (!draft) {
			draft = { id: nodeId };
			nodeDrafts.set(nodeId, draft);
		}
		if (headingTitle) {
			draft.title = headingTitle;
		}
		currentNodeDraft = draft;
	};

	const flushSegment = () => {
		if (currentSegmentId && currentSegmentCfg) {
			const nodeIds = currentSegmentId.split(/\s*->\s*|\s*,\s*/).map(s => s.trim()).filter(Boolean);
			parsedManagers.push({
				segmentId: currentSegmentId,
				nodeIds,
				config: {
					engine: normalizeBlueprintEngine(currentSegmentCfg.engine, fallbackEngine),
					...(currentSegmentCfg.model ? { model: currentSegmentCfg.model } : {}),
					thinking: currentSegmentCfg.thinking,
				},
			});
		}
		currentSegmentId = undefined;
		currentSegmentCfg = undefined;
	};

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		const trimmed = rawLine.trim();

		const h2Match = trimmed.match(/^##\s+(.+)$/);
		if (h2Match) {
			flushSegment();
			currentNodeDraft = undefined;
			activeNestedRole = undefined;
			activeNodeProseSubheading = undefined;
			const rawHeading = h2Match[1].trim();
			const inlineNodeMatch = rawHeading.match(/^Node\s*:\s*\[?([A-Za-z0-9_-]+)\]?(?:\s*[—:-]\s*(.*))?$/i);
			if (inlineNodeMatch) {
				currentSection = 'nodes';
				bindCurrentNode(inlineNodeMatch[1].trim(), inlineNodeMatch[2]?.trim());
				continue;
			}
			const heading = rawHeading.toLowerCase();
			if (heading.includes('metadata')) {
				currentSection = 'metadata';
			} else if (heading.includes('manager')) {
				currentSection = 'managers';
			} else if (heading.includes('node')) {
				currentSection = 'nodes';
			} else {
				currentSection = 'none';
			}
			continue;
		}

		if (currentSection === 'metadata') {
			const kv = trimmed.match(/^-\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
			if (!kv) { continue; }
			const key = kv[1].toLowerCase();
			const val = kv[2].trim();
			if (key === 'tree_type' || key === 'treetype') {
				treeType = val.toLowerCase() === 'research' ? 'research' : 'engineering';
			} else if (key === 'governor_session_id' || key === 'governorsessionid') {
				if (val && !/^<.*>$/.test(val)) {
					governorSessionId = val;
				}
			} else if (key === 'workspace_isolation' || key === 'workspaceisolation') {
				workspaceIsolation = val.toLowerCase() === 'worktree' ? 'worktree' : 'shared';
			} else if (key === 'watchdog_timeout_minutes' || key === 'watchdogtimeoutminutes') {
				const num = Number(val);
				if (Number.isFinite(num) && num > 0) {
					watchdogTimeoutMinutes = num;
				}
			}
			continue;
		}

		if (currentSection === 'managers') {
			const h3Seg = trimmed.match(/^###\s*\[?\s*(?:Segment\s*:\s*)?([^\]]+?)\s*\]?$/i);
			if (h3Seg) {
				flushSegment();
				currentSegmentId = h3Seg[1].trim();
				currentSegmentCfg = { engine: fallbackEngine, thinking: 'high' };
				continue;
			}
			if (currentSegmentCfg) {
				const kv = trimmed.match(/^-\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
				if (kv) {
					const key = kv[1].toLowerCase();
					const val = kv[2].trim();
					if (key === 'engine') {
						currentSegmentCfg.engine = normalizeBlueprintEngine(val, fallbackEngine);
					} else if (key === 'model' && val) {
						currentSegmentCfg.model = val;
					} else if (key === 'thinking' || key === 'effort') {
						currentSegmentCfg.thinking = normalizeThinkingLevel(val, 'high');
					}
				}
			}
			continue;
		}

		if (currentSection === 'nodes') {
			const h3Node = trimmed.match(/^###\s*\[([A-Za-z0-9_-]+)\]\s*(.*)$/)
				?? trimmed.match(/^###\s*Node\s*:\s*\[?([A-Za-z0-9_-]+)\]?(?:\s*[—:-]\s*(.*))?$/i);
			if (h3Node) {
				bindCurrentNode(h3Node[1].trim(), h3Node[2]?.trim());
				continue;
			}

			if (!currentNodeDraft) {
				continue;
			}

			const h3Prose = trimmed.match(/^###\s+(.+)$/);
			if (h3Prose) {
				activeNestedRole = undefined;
				const subTitle = h3Prose[1].trim().toLowerCase();
				if (subTitle.startsWith('goal')) {
					activeNodeProseSubheading = 'goal';
				} else if (subTitle.startsWith('acceptance')) {
					activeNodeProseSubheading = 'acceptance';
				} else if (subTitle.startsWith('description')) {
					activeNodeProseSubheading = 'description';
				} else {
					activeNodeProseSubheading = undefined;
				}
				continue;
			}

			if (activeNodeProseSubheading) {
				if (trimmed) {
					const prevText = currentNodeDraft[activeNodeProseSubheading];
					currentNodeDraft[activeNodeProseSubheading] = prevText ? `${prevText}\n${trimmed}` : trimmed;
				}
				continue;
			}

			// Nested bullet under `- employee:` or `- worker:`
			if (activeNestedRole && /^\s{2,}-\s+/.test(rawLine)) {
				const subKv = trimmed.match(/^-\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
				if (subKv) {
					const prev = currentNodeDraft[activeNestedRole] ?? {
						engine: fallbackEngine,
						thinking: (activeNestedRole === 'employee' ? 'medium' : 'high') as AdeThinkingLevel,
					};
					const k = subKv[1].toLowerCase();
					const v = subKv[2].trim();
					currentNodeDraft[activeNestedRole] = {
						engine: k === 'engine' ? normalizeBlueprintEngine(v, prev.engine) : prev.engine,
						model: k === 'model' ? (v || undefined) : prev.model,
						thinking: (k === 'thinking' || k === 'effort') ? normalizeThinkingLevel(v, prev.thinking) : prev.thinking,
					};
					continue;
				}
			}

			const kv = rawLine.match(/^\s*-\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
			if (!kv) {
				continue;
			}
			activeNestedRole = undefined;
			const key = kv[1].toLowerCase();
			const val = kv[2].trim();

			const readBlockScalar = (): string => {
				const blockLines: string[] = [];
				let baseIndent: number | undefined;
				while (i + 1 < lines.length) {
					const peek = lines[i + 1];
					if (peek.trim() === '') {
						blockLines.push('');
						i++;
						continue;
					}
					const indentMatch = peek.match(/^(\s+)/);
					const indentLen = indentMatch ? indentMatch[1].length : 0;
					if (indentLen < 2 || /^\s*###?\s+/.test(peek) || (baseIndent === undefined && /^\s*-\s+[A-Za-z0-9_-]+\s*:/.test(peek) && indentLen <= 1)) {
						break;
					}
					if (baseIndent === undefined) {
						baseIndent = indentLen;
					} else if (indentLen < baseIndent && /^\s*-\s+[A-Za-z0-9_-]+\s*:/.test(peek)) {
						break;
					}
					blockLines.push(peek.slice(Math.min(indentLen, baseIndent)));
					i++;
				}
				while (blockLines.length > 0 && blockLines[blockLines.length - 1] === '') {
					blockLines.pop();
				}
				return blockLines.join('\n');
			};

			if (key === 'title' && val) {
				currentNodeDraft.title = val;
			} else if (key === 'type') {
				currentNodeDraft.type = (val.toLowerCase() === 'user_gate' || val.toLowerCase() === 'gate') ? 'user_gate' : 'task';
			} else if (key === 'critical') {
				currentNodeDraft.critical = val.toLowerCase() === 'true' || val === '1' || val.toLowerCase() === 'yes';
			} else if (key === 'employee') {
				if (!val) {
					activeNestedRole = 'employee';
				} else {
					currentNodeDraft.employee = parseInlineRoleConfig(val, fallbackEngine, 'medium');
				}
			} else if (key === 'worker') {
				if (!val) {
					activeNestedRole = 'worker';
				} else {
					currentNodeDraft.worker = parseInlineRoleConfig(val, fallbackEngine, 'high');
				}
			} else if (key === 'goal') {
				currentNodeDraft.goal = (val === '|' || val === '>') ? readBlockScalar() : val;
			} else if (key === 'acceptance') {
				currentNodeDraft.acceptance = (val === '|' || val === '>') ? readBlockScalar() : val;
			} else if (key === 'description') {
				currentNodeDraft.description = (val === '|' || val === '>') ? readBlockScalar() : val;
			} else if (key === 'position') {
				const coords = val.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
				if (coords) {
					currentNodeDraft.position = { x: Number(coords[1]), y: Number(coords[2]) };
				}
			}
		}
	}
	flushSegment();

	if (defaults?.governorSessionId && !governorSessionId) {
		governorSessionId = defaults.governorSessionId;
	}

	const finalNodes: IAdeEngineeringBlueprintNode[] = [];
	for (const draft of nodeDrafts.values()) {
		const nodeType: AdeEngineeringNodeType = draft.type ?? 'task';
		const hints = mermaidInlineHints.get(draft.id);
		const pos = draft.position ?? parsedPositions.get(draft.id);

		if (nodeType === 'user_gate') {
			finalNodes.push({
				id: draft.id,
				title: draft.title || draft.id,
				type: 'user_gate',
				critical: false,
				description: draft.description ?? draft.goal ?? '',
				...(pos ? { position: pos } : {}),
			});
		} else {
			const workerCfg: IAdeRoleModelConfig = draft.worker ?? {
				engine: hints?.workerEngine ?? fallbackEngine,
				thinking: hints?.workerThinking ?? 'high',
			};
			const employeeCfg: IAdeRoleModelConfig = draft.employee ?? {
				engine: hints?.employeeEngine ?? fallbackEngine,
				thinking: hints?.employeeThinking ?? 'medium',
			};
			finalNodes.push({
				id: draft.id,
				title: draft.title || draft.id,
				type: 'task',
				critical: Boolean(draft.critical),
				employee: employeeCfg,
				worker: workerCfg,
				goal: draft.goal ?? '',
				acceptance: draft.acceptance ?? '',
				...(pos ? { position: pos } : {}),
			});
		}
	}

	// Deduplicate edges while preserving declaration order
	const dedupEdges: IAdeEngineeringBlueprintEdge[] = [];
	const seenEdge = new Set<string>();
	for (const edge of rawEdges) {
		const key = `${edge.from}->${edge.to}`;
		if (!seenEdge.has(key)) {
			seenEdge.add(key);
			dedupEdges.push(edge);
		}
	}

	// Validate DAG acyclicity and auto-partition Managers via Maximal Non-Branching Path
	const managers = partitionEngineeringManagers(finalNodes, dedupEdges, parsedManagers, fallbackEngine);

	const metadata: IAdeEngineeringBlueprintMetadata = {
		treeType,
		governorSessionId,
		workspaceIsolation,
		watchdogTimeoutMinutes,
		flowDirection,
	};

	return {
		metadata,
		managers,
		nodes: finalNodes,
		edges: dedupEdges,
	};
}

function escapeMermaidQuotes(text: string): string {
	return text.replace(/"/g, '\'').replace(/\r?\n/g, ' ').trim();
}

function formatMermaidNodeDeclaration(node: IAdeEngineeringBlueprintNode): string {
	if (node.type === 'user_gate') {
		return `${node.id}{{"${escapeMermaidQuotes(node.title)}"}}`;
	}
	const critSuffix = node.critical ? ' ★Critical' : '';
	const workerSummary = node.worker
		? ` | worker=${toMermaidShortEngine(node.worker.engine)}:${node.worker.thinking}`
		: '';
	return `${node.id}["${escapeMermaidQuotes(node.title)}${critSuffix}${workerSummary}"]`;
}

function formatRoleConfigLine(cfg: IAdeRoleModelConfig): string {
	const parts = [`engine=${normalizeBlueprintEngine(cfg.engine)}`];
	if (cfg.model && cfg.model.trim()) {
		parts.push(`model=${cfg.model.trim()}`);
	}
	parts.push(`thinking=${cfg.thinking}`);
	return parts.join(', ');
}

function formatBlockScalar(fieldName: string, content: string | undefined): string[] {
	const trimmed = (content ?? '').replace(/\r\n/g, '\n').trim();
	if (!trimmed) {
		return [`- ${fieldName}: |`, '    (Not specified)'];
	}
	return [
		`- ${fieldName}: |`,
		...trimmed.split('\n').map(line => line.length > 0 ? `    ${line}` : ''),
	];
}

/**
 * Serializes an `IAdeEngineeringBlueprint` into canonical `blueprint.md` (Mermaid + Markdown),
 * enforcing automatic Maximal Non-Branching Path Manager partitioning before writing.
 */
export function serializeEngineeringBlueprint(blueprint: IAdeEngineeringBlueprint): string {
	const managers = partitionEngineeringManagers(
		blueprint.nodes,
		blueprint.edges,
		blueprint.managers,
		blueprint.nodes.find(n => n.worker)?.worker?.engine ?? 'claude-code',
	);
	const direction = blueprint.metadata.flowDirection ?? 'LR';
	const nodeById = new Map(blueprint.nodes.map(n => [n.id, n]));
	const declaredInMermaid = new Set<string>();

	const mermaidLines: string[] = [
		'```mermaid',
		`flowchart ${direction}`,
	];

	for (const node of blueprint.nodes) {
		if (node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)) {
			mermaidLines.push(`  %% @pos ${node.id} ${Math.round(node.position.x)},${Math.round(node.position.y)}`);
		}
	}

	if (blueprint.edges.length === 0) {
		for (const node of blueprint.nodes) {
			mermaidLines.push(`  ${formatMermaidNodeDeclaration(node)}`);
			declaredInMermaid.add(node.id);
		}
	} else {
		for (const edge of blueprint.edges) {
			const srcNode = nodeById.get(edge.from);
			const dstNode = nodeById.get(edge.to);
			if (!srcNode || !dstNode) {
				continue;
			}
			const left = declaredInMermaid.has(srcNode.id) ? srcNode.id : formatMermaidNodeDeclaration(srcNode);
			declaredInMermaid.add(srcNode.id);
			const right = declaredInMermaid.has(dstNode.id) ? dstNode.id : formatMermaidNodeDeclaration(dstNode);
			declaredInMermaid.add(dstNode.id);
			const arrow = edge.label ? `-->|${edge.label.replace(/\|/g, '/')}|` : '-->';
			mermaidLines.push(`  ${left} ${arrow} ${right}`);
		}
		for (const node of blueprint.nodes) {
			if (!declaredInMermaid.has(node.id)) {
				mermaidLines.push(`  ${formatMermaidNodeDeclaration(node)}`);
				declaredInMermaid.add(node.id);
			}
		}
	}
	mermaidLines.push('```');

	const metaLines: string[] = [
		'## Tree Metadata',
		`- tree_type: ${blueprint.metadata.treeType}`,
		`- governor_session_id: ${blueprint.metadata.governorSessionId || '<session-uuid>'}`,
		`- workspace_isolation: ${blueprint.metadata.workspaceIsolation}`,
		`- watchdog_timeout_minutes: ${blueprint.metadata.watchdogTimeoutMinutes}`,
	];

	const managerLines: string[] = ['## Auto-Partitioned Managers'];
	for (const mgr of managers) {
		managerLines.push(`### [Segment: ${mgr.segmentId}]`);
		managerLines.push(`- engine: ${normalizeBlueprintEngine(mgr.config.engine)}`);
		if (mgr.config.model && mgr.config.model.trim()) {
			managerLines.push(`- model: ${mgr.config.model.trim()}`);
		}
		managerLines.push(`- thinking: ${mgr.config.thinking}`);
		managerLines.push('');
	}
	if (managerLines[managerLines.length - 1] === '') {
		managerLines.pop();
	}

	const nodeLines: string[] = ['## Nodes'];
	for (const node of blueprint.nodes) {
		nodeLines.push(`### [${node.id}] ${node.title}`);
		nodeLines.push(`- type: ${node.type}`);
		if (node.type === 'user_gate') {
			nodeLines.push(...formatBlockScalar('description', node.description || '人工检查上游节点产物并裁决是否放行进入下一阶段。'));
		} else {
			nodeLines.push(`- critical: ${Boolean(node.critical)}`);
			const emp = node.employee ?? { engine: 'claude-code', thinking: 'medium' };
			const wrk = node.worker ?? { engine: 'codex', thinking: 'high' };
			nodeLines.push(`- employee: ${formatRoleConfigLine(emp)}`);
			nodeLines.push(`- worker: ${formatRoleConfigLine(wrk)}`);
			nodeLines.push(...formatBlockScalar('goal', node.goal || `完成节点 ${node.title} 的代码实现。`));
			nodeLines.push(...formatBlockScalar('acceptance', node.acceptance || `1. 功能实现完整且通过静态检查与相关测试。`));
		}
		nodeLines.push('');
	}
	if (nodeLines[nodeLines.length - 1] === '') {
		nodeLines.pop();
	}

	return [
		mermaidLines.join('\n'),
		'',
		metaLines.join('\n'),
		'',
		managerLines.join('\n'),
		'',
		nodeLines.join('\n'),
		'',
	].join('\n');
}

/**
 * Builds the deduplicated upstream incremental report chain for `targetNodeId` in topological order (Spec 3.2):
 * - Includes all strict `task` ancestors of `targetNodeId` that have a non-stale report.
 * - Automatically deduplicates shared diamond ancestors (e.g. `A` in `A -> B -> D, A -> C -> D` appears once).
 */
export function buildUpstreamReportChain(
	targetNodeId: string,
	blueprint: IAdeEngineeringBlueprint,
	reports: Readonly<Record<string, IAdeIncrementalReportEntry>>,
): IAdeIncrementalReportEntry[] {
	const topoOrder = topologicalSortNodes(blueprint.nodes, blueprint.edges);
	const incoming = new Map<string, string[]>();
	for (const node of blueprint.nodes) {
		incoming.set(node.id, []);
	}
	for (const edge of blueprint.edges) {
		incoming.get(edge.to)?.push(edge.from);
	}

	const ancestors = new Set<string>();
	const queue = [...(incoming.get(targetNodeId) ?? [])];
	while (queue.length > 0) {
		const curr = queue.shift()!;
		if (ancestors.has(curr)) {
			continue;
		}
		ancestors.add(curr);
		for (const pred of incoming.get(curr) ?? []) {
			if (!ancestors.has(pred)) {
				queue.push(pred);
			}
		}
	}

	const chain: IAdeIncrementalReportEntry[] = [];
	for (const id of topoOrder) {
		if (!ancestors.has(id)) {
			continue;
		}
		const report = reports[id];
		if (report && !report.stale && report.summary.trim()) {
			chain.push(report);
		}
	}
	return chain;
}

/**
 * Lists all strict upstream `'task'` ancestors of `gateNodeId` in topological order
 * (used to populate rollback target choices on a User Acceptance Gate).
 */
export function listUpstreamTaskAncestors(
	gateNodeId: string,
	blueprint: IAdeEngineeringBlueprint,
): IAdeEngineeringBlueprintNode[] {
	const topoOrder = topologicalSortNodes(blueprint.nodes, blueprint.edges);
	const nodeById = new Map(blueprint.nodes.map(n => [n.id, n]));
	const incoming = new Map<string, string[]>();
	for (const node of blueprint.nodes) {
		incoming.set(node.id, []);
	}
	for (const edge of blueprint.edges) {
		incoming.get(edge.to)?.push(edge.from);
	}

	const ancestors = new Set<string>();
	const queue = [...(incoming.get(gateNodeId) ?? [])];
	while (queue.length > 0) {
		const curr = queue.shift()!;
		if (ancestors.has(curr)) {
			continue;
		}
		ancestors.add(curr);
		for (const pred of incoming.get(curr) ?? []) {
			if (!ancestors.has(pred)) {
				queue.push(pred);
			}
		}
	}

	return topoOrder
		.filter(id => ancestors.has(id))
		.map(id => nodeById.get(id)!)
		.filter(node => node.type === 'task');
}

/**
 * Computes the exact surgical rollback set when a User Acceptance Gate (`gateNodeId`) rolls back
 * to `targetUpstreamNodeId` (Spec 3.5):
 *
 * `RollbackSet = Descendants_inclusive(targetUpstreamNodeId) ∩ Ancestors_inclusive(gateNodeId)`
 *
 * Parallel branches (e.g. `A -> D` when rolling back `A -> B -> C -> Gate` to `A`) cannot reach
 * `gateNodeId` and are therefore 100% excluded from reset!
 */
export function computeGateRollbackNodes(
	gateNodeId: string,
	targetUpstreamNodeId: string,
	blueprint: IAdeEngineeringBlueprint,
): string[] {
	const topoOrder = topologicalSortNodes(blueprint.nodes, blueprint.edges);
	const nodeById = new Map(blueprint.nodes.map(n => [n.id, n]));
	const gateNode = nodeById.get(gateNodeId);
	if (!gateNode || gateNode.type !== 'user_gate') {
		throw new AdeBlueprintValidationError(`Node "${gateNodeId}" is not a user_gate node.`);
	}
	const targetNode = nodeById.get(targetUpstreamNodeId);
	if (!targetNode || targetNode.type !== 'task') {
		throw new AdeBlueprintValidationError(`Rollback target "${targetUpstreamNodeId}" must be an upstream task node.`);
	}

	const outgoing = new Map<string, string[]>();
	const incoming = new Map<string, string[]>();
	for (const node of blueprint.nodes) {
		outgoing.set(node.id, []);
		incoming.set(node.id, []);
	}
	for (const edge of blueprint.edges) {
		outgoing.get(edge.from)?.push(edge.to);
		incoming.get(edge.to)?.push(edge.from);
	}

	// Reachable forward from targetUpstreamNodeId
	const forwardFromTarget = new Set<string>([targetUpstreamNodeId]);
	const fwdQueue = [targetUpstreamNodeId];
	while (fwdQueue.length > 0) {
		const curr = fwdQueue.shift()!;
		for (const next of outgoing.get(curr) ?? []) {
			if (!forwardFromTarget.has(next)) {
				forwardFromTarget.add(next);
				fwdQueue.push(next);
			}
		}
	}

	if (!forwardFromTarget.has(gateNodeId)) {
		throw new AdeBlueprintValidationError(`Node "${targetUpstreamNodeId}" is not an upstream ancestor of gate "${gateNodeId}".`);
	}

	// Can reach gateNodeId (backward from gateNodeId)
	const backwardFromGate = new Set<string>([gateNodeId]);
	const bwdQueue = [gateNodeId];
	while (bwdQueue.length > 0) {
		const curr = bwdQueue.shift()!;
		for (const pred of incoming.get(curr) ?? []) {
			if (!backwardFromGate.has(pred)) {
				backwardFromGate.add(pred);
				bwdQueue.push(pred);
			}
		}
	}

	return topoOrder.filter(id => forwardFromTarget.has(id) && backwardFromGate.has(id));
}

/**
 * Resolves the Spec 3.6 visual status of a DAG node.
 * Note: Employee internal rework (`employeeRejectCount > 0`) explicitly does NOT turn amber;
 * only Manager formal rejections (`formalFailureCount` 1, 2, 3) trigger Light Amber / Deep Amber / Red!
 */
export function computeNodeVisualStatus(
	_node: IAdeEngineeringBlueprintNode,
	runtime: IAdeEngineeringNodeRuntimeState | undefined,
): AdeEngineeringNodeVisualStatus {
	if (!runtime) {
		return 'pending';
	}
	if (runtime.completed || runtime.phase === 'completed') {
		return 'completed';
	}
	if (runtime.formalFailureCount >= 3 || runtime.phase === 'circuit_broken') {
		return 'failure_3';
	}
	if (runtime.formalFailureCount === 2) {
		return 'failure_2';
	}
	if (runtime.formalFailureCount === 1) {
		return 'failure_1';
	}
	if (
		runtime.phase === 'worker_running'
		|| runtime.phase === 'employee_review'
		|| runtime.phase === 'manager_review'
		|| runtime.phase === 'manager_escalation'
		|| runtime.phase === 'waiting_user_gate'
	) {
		return 'running';
	}
	return 'pending';
}

/**
 * Resolves the Spec 3.6 visual status of a DAG edge:
 * - `pending`: solid gray
 * - `running`: flowing animated green dashed line
 * - `completed`: solid green
 * - `blocked`: solid gray
 */
export function computeEdgeVisualStatus(
	edge: IAdeEngineeringBlueprintEdge,
	runtimes: Readonly<Record<string, IAdeEngineeringNodeRuntimeState>>,
): AdeEngineeringEdgeVisualStatus {
	const src = runtimes[edge.from];
	const dst = runtimes[edge.to];
	if (src?.phase === 'circuit_broken' || dst?.phase === 'circuit_broken' || (src?.formalFailureCount ?? 0) >= 3 || (dst?.formalFailureCount ?? 0) >= 3) {
		return 'blocked';
	}
	if (dst?.completed || dst?.phase === 'completed') {
		return 'completed';
	}
	const srcDone = Boolean(src?.completed || src?.phase === 'completed');
	if (!srcDone) {
		return 'pending';
	}
	const dstActive = dst && (
		dst.phase === 'worker_running'
		|| dst.phase === 'employee_review'
		|| dst.phase === 'manager_review'
		|| dst.phase === 'manager_escalation'
		|| dst.phase === 'waiting_user_gate'
	);
	if (dstActive) {
		return 'running';
	}
	return 'completed';
}

/**
 * Computes balanced layered DAG canvas coordinates (Sugiyama rank assignment + barycenter ordering)
 * for nodes without explicit `@pos` coordinates or when clicking "Auto Layout".
 */
export function computeAutoLayoutPositions(
	blueprint: Pick<IAdeEngineeringBlueprint, 'nodes' | 'edges' | 'metadata'>,
	options?: { horizontalGap?: number; verticalGap?: number; originX?: number; originY?: number },
): Map<string, IAdeNodeCanvasPosition> {
	const topo = topologicalSortNodes(blueprint.nodes, blueprint.edges);
	const incoming = new Map<string, string[]>();
	for (const node of blueprint.nodes) {
		incoming.set(node.id, []);
	}
	for (const edge of blueprint.edges) {
		incoming.get(edge.to)?.push(edge.from);
	}

	const layerById = new Map<string, number>();
	let maxLayer = 0;
	for (const id of topo) {
		const preds = incoming.get(id) ?? [];
		const layer = preds.length === 0
			? 0
			: Math.max(...preds.map(p => (layerById.get(p) ?? 0) + 1));
		layerById.set(id, layer);
		if (layer > maxLayer) {
			maxLayer = layer;
		}
	}

	const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
	for (const id of topo) {
		layers[layerById.get(id) ?? 0].push(id);
	}

	// Barycenter heuristic sweep to minimize edge crossings
	const rankInLayer = new Map<string, number>();
	for (let l = 0; l < layers.length; l++) {
		if (l > 0) {
			layers[l].sort((a, b) => {
				const predsA = incoming.get(a) ?? [];
				const predsB = incoming.get(b) ?? [];
				const baryA = predsA.length ? predsA.reduce((sum, p) => sum + (rankInLayer.get(p) ?? 0), 0) / predsA.length : 0;
				const baryB = predsB.length ? predsB.reduce((sum, p) => sum + (rankInLayer.get(p) ?? 0), 0) / predsB.length : 0;
				return baryA - baryB;
			});
		}
		layers[l].forEach((id, idx) => rankInLayer.set(id, idx));
	}

	const isVertical = blueprint.metadata.flowDirection === 'TD';
	const hGap = options?.horizontalGap ?? (isVertical ? 240 : 285);
	const vGap = options?.verticalGap ?? (isVertical ? 205 : 210);
	const originX = options?.originX ?? 160;
	const originY = options?.originY ?? 240;

	const result = new Map<string, IAdeNodeCanvasPosition>();
	for (let l = 0; l < layers.length; l++) {
		const col = layers[l];
		const totalSpan = (col.length - 1) * (isVertical ? hGap : vGap);
		for (let idx = 0; idx < col.length; idx++) {
			const offset = idx * (isVertical ? hGap : vGap) - totalSpan / 2;
			if (isVertical) {
				result.set(col[idx], {
					x: Math.round(originX + 260 + offset),
					y: Math.round(130 + l * vGap),
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

/**
 * Generates an initial starter `IAdeEngineeringBlueprint` when initializing an Engineering tree.
 */
export function createStarterBlueprint(
	governorSessionId: string,
	defaultEngine = 'claude-code',
	treeType: AdeWorkTreeType = 'engineering',
): IAdeEngineeringBlueprint {
	const canonicalEngine = normalizeBlueprintEngine(defaultEngine, 'claude-code');
	const nodes: IAdeEngineeringBlueprintNode[] = [
		{
			id: 'N1',
			title: '架构设计与接口定义',
			type: 'task',
			critical: true,
			employee: { engine: canonicalEngine, thinking: 'medium' },
			worker: { engine: canonicalEngine, thinking: 'high' },
			goal: '梳理目标模块边界、核心数据结构与接口契约，完成基础骨架代码。',
			acceptance: '1. 核心接口定义清晰且符合现有分层规范；\n2. 静态检查无错误。',
			position: { x: 180, y: 240 },
		},
	];
	const edges: IAdeEngineeringBlueprintEdge[] = [];
	const managers = partitionEngineeringManagers(nodes, edges, [], canonicalEngine);
	return {
		metadata: {
			treeType,
			governorSessionId,
			workspaceIsolation: 'shared',
			watchdogTimeoutMinutes: DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
			flowDirection: 'LR',
		},
		managers,
		nodes,
		edges,
	};
}
