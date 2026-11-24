/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure Cyclic Free-Topology Orchestration Graph Parser, Authoring Mutator,
 * Cycle-Safe Layered Auto-Layout, and 4-Side Multi-Anchor Orthogonal Edge Router.
 *
 * Key architectural invariants:
 * 1. Allows arbitrary cycles and bidirectional edges (`A --> B`, `B --> A`, `A <--> B`).
 * 2. Enforces STRICT 1-to-1 employee uniqueness: each employee may appear at most once on canvas.
 * 3. Supports Department groupings (`subgraph Dept["Department"] ... end`) and
 *    Department Shared Whiteboard nodes (`WB1[("Whiteboard: Backend")]` or `%% whiteboard ...`).
 * 4. Exposes 4-side multi-slot connection anchors (top/right/bottom/left × 3 slots = 12 anchors)
 *    with bidirectional parallel-track separation, cycle back-edge routing, crossing minimization,
 *    obstacle avoidance, and smooth rounded orthogonal corners.
 */

import { IMissionNodeCheckHook, IMissionNodePosition, MissionCheckOnFailAction } from './adeMissionDag.js';
import { normalizeMissionEmployeeKey } from './adeMissionEmployee.js';
import { normalizeAdeNodeColor } from './adeNodeColors.js';

export type OrchestrationDirection = 'LR' | 'TD';
export type OrchestrationLayoutMode = 'lr' | 'td' | 'radial' | 'grid';
export type OrchestrationNodeKind = 'staff' | 'whiteboard';
export type OrchestrationAnchorSide = 'top' | 'right' | 'bottom' | 'left';

export const ORCHESTRATION_ANCHOR_SIDES: readonly OrchestrationAnchorSide[] = ['top', 'right', 'bottom', 'left'];
export const ORCHESTRATION_SLOTS_PER_SIDE = 5;

export const ORCHESTRATION_STAFF_NODE_WIDTH = 316;
export const ORCHESTRATION_STAFF_NODE_HEIGHT = 220;
export const ORCHESTRATION_WHITEBOARD_NODE_WIDTH = 256;
export const ORCHESTRATION_WHITEBOARD_NODE_HEIGHT = 148;

export interface IOrchestrationGraphNode {
	readonly id: string;
	readonly label: string;
	readonly kind: OrchestrationNodeKind;
	/** Unique employee display name (for `kind === 'staff'`). */
	readonly employeeName?: string;
	/** Normalized employee uniqueness key (for `kind === 'staff'`). */
	readonly employeeKey?: string;
	/** Optional hierarchy tier (1 = highest rank L1, 2 = L2, ...). */
	readonly tier?: number;
	/** Optional rank slug ID (e.g. 'governor', 'manager', 'employee', 'worker'). */
	readonly rankId?: string;
	/** Optional department name (from `subgraph` or metadata comment). */
	readonly department?: string;
	/** Optional bound ADE agent session ID. */
	readonly agentId?: string;
	/** Optional preferred Coding Agent engine ID (lossless migration metadata). */
	readonly engineId?: string;
	/** Optional preferred LLM model ID (lossless migration metadata). */
	readonly model?: string;
	/** Optional preferred thinking level (lossless migration metadata). */
	readonly thinking?: string;
	/** Optional preferred execution host alias (e.g. 'local' or SSH alias). */
	readonly hostAlias?: string;
	/** Optional concise role boundary / persona prompt (strictly role scope, NEVER legacy task pre-prompt). */
	readonly rolePrompt?: string;
	/** Optional repo-relative allowed read/write directory scopes for this staff role. */
	readonly allowedPaths?: readonly string[];
	/** Optional automated verification checks executed before token handoff/return/complete. */
	readonly checks?: readonly IMissionNodeCheckHook[];
	/** Optional custom visual accent color preset ID (e.g. 'gold', 'cyan') or `#rrggbb` hex. */
	readonly color?: string;
	/** Optional whiteboard ID when `kind === 'whiteboard'` (defaults to `id`). */
	readonly whiteboardId?: string;
	/** Optional whiteboard revision number parsed from `%% whiteboard ... [version=N]`. */
	readonly whiteboardVersion?: number;
	/** Optional lossless whiteboard Markdown body parsed from `%% wb-body <id> ... %% wb-end`. */
	readonly whiteboardContent?: string;
}

export interface IOrchestrationWhiteboardContentSpec {
	readonly id: string;
	readonly title: string;
	readonly department: string;
	readonly content: string;
	readonly version: number;
}

export interface IOrchestrationDepartmentGroup {
	readonly id: string;
	readonly name: string;
	readonly nodeIds: readonly string[];
	readonly whiteboardIds: readonly string[];
}

export interface IOrchestrationGraphEdge {
	readonly id: string;
	readonly from: string;
	readonly to: string;
	readonly label?: string;
	/** True when the reverse edge `to -> from` also exists in the graph (declared via `<-->` or paired `-->`). */
	readonly isBidirectional?: boolean;
	/** ID of the paired reverse edge when `isBidirectional === true`. */
	readonly reverseEdgeId?: string;
	/** True when this edge closes a cycle / points back upstream in rank or topological flow. */
	readonly isCycleBackEdge?: boolean;
	/** Optional style hint (`solid` vs `dashed`). */
	readonly dashed?: boolean;
}

export interface IOrchestrationTopologyAdvisory {
	readonly code: 'ONE_WAY_HIERARCHY_EDGE' | 'DEAD_END_STAFF_NODE';
	readonly fromNodeId: string;
	readonly toNodeId?: string;
	readonly message: string;
}

export interface IOrchestrationGraphParseResult {
	readonly direction: OrchestrationDirection;
	/** Optional presentation layout directive (`%% layout <lr|td|radial|grid>`). */
	readonly layoutMode?: OrchestrationLayoutMode;
	readonly nodes: readonly IOrchestrationGraphNode[];
	readonly edges: readonly IOrchestrationGraphEdge[];
	readonly departments: readonly IOrchestrationDepartmentGroup[];
	/** Optional lossless canvas coordinates parsed from `%% pos <id> [x=..., y=...]`. */
	readonly positions?: Readonly<Record<string, IMissionNodePosition>>;
	/** Optional lossless whiteboard records hydrated from `%% whiteboard` + `%% wb-body` directives. */
	readonly whiteboardContents?: Readonly<Record<string, IOrchestrationWhiteboardContentSpec>>;
	/** Non-blocking orchestration choreography advisories (e.g., one-way downward edges without return path). */
	readonly advisories?: readonly IOrchestrationTopologyAdvisory[];
	readonly error?: string;
}

export interface IOrchestrationSerializeInput {
	readonly direction?: OrchestrationDirection;
	readonly layoutMode?: OrchestrationLayoutMode;
	readonly nodes: readonly IOrchestrationGraphNode[];
	readonly edges: readonly IOrchestrationGraphEdge[];
	readonly departments?: readonly IOrchestrationDepartmentGroup[];
	readonly whiteboards?: Readonly<Record<string, {
		readonly id?: string;
		readonly title?: string;
		readonly department?: string;
		readonly content: string;
		readonly version?: number;
	}>>;
	readonly positions?: Readonly<Record<string, IMissionNodePosition>>;
	readonly staffRuntimeMeta?: Readonly<Record<string, {
		readonly engineId?: string;
		readonly model?: string;
		readonly thinking?: string;
		readonly hostAlias?: string;
		readonly agentId?: string;
		readonly rolePrompt?: string;
		readonly allowedPaths?: readonly string[];
		readonly checks?: readonly IMissionNodeCheckHook[];
	}>>;
	/** Include bound local `agent=<id>` attributes (default false for clean portable migration). */
	readonly includeAgentIds?: boolean;
	/** When true, omit all `%% wb-body ... %% wb-end` content blocks while preserving whiteboard topology & headers. */
	readonly stripWhiteboardBodies?: boolean;
	/** Optional caller-scoped allowlist of whiteboard IDs whose `%% wb-body` blocks (and ungraphed whiteboard entries) may be emitted. */
	readonly allowedWhiteboardIds?: ReadonlySet<string>;
}

export interface IOrchestrationAnchorPoint {
	readonly side: OrchestrationAnchorSide;
	readonly slot: number;
	/** Normalized fraction along the edge in `(0, 1)`. */
	readonly fraction: number;
	readonly x: number;
	readonly y: number;
	/** Outward unit normal vector `(nx, ny)` leaving the node border. */
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
	readonly isCycleBackEdge: boolean;
	readonly laneIndex: number;
}

export function getOrchestrationNodeSize(node: Pick<IOrchestrationGraphNode, 'kind'>): { readonly width: number; readonly height: number } {
	return node.kind === 'whiteboard'
		? { width: ORCHESTRATION_WHITEBOARD_NODE_WIDTH, height: ORCHESTRATION_WHITEBOARD_NODE_HEIGHT }
		: { width: ORCHESTRATION_STAFF_NODE_WIDTH, height: ORCHESTRATION_STAFF_NODE_HEIGHT };
}

function isEscapedAt(input: string, index: number): boolean {
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && input[i] === '\\'; i--) {
		backslashes++;
	}
	return (backslashes % 2) === 1;
}

function fnv1aHex(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

function findMermaidCommentIndex(rawLine: string): number {
	let inQuote: '"' | '\'' | undefined;
	for (let i = 0; i < rawLine.length; i++) {
		const ch = rawLine[i];
		if (inQuote) {
			if (ch === inQuote && !isEscapedAt(rawLine, i)) {
				inQuote = undefined;
			}
			continue;
		}
		if (ch === '"' || ch === '\'') {
			inQuote = ch;
			continue;
		}
		if (ch === '%' && rawLine[i + 1] === '%') {
			return i;
		}
	}
	return -1;
}

function extractBalancedBracketSection(input: string, openIdx: number): { readonly content: string; readonly closeIdx: number } | undefined {
	if (input[openIdx] !== '[') {
		return undefined;
	}
	let depth = 0;
	let inQuote: '"' | '\'' | undefined;
	for (let i = openIdx; i < input.length; i++) {
		const ch = input[i];
		if (inQuote) {
			if (ch === inQuote && !isEscapedAt(input, i)) {
				inQuote = undefined;
			}
			continue;
		}
		if (ch === '"' || ch === '\'') {
			inQuote = ch;
			continue;
		}
		if (ch === '[') {
			depth++;
		} else if (ch === ']') {
			depth--;
			if (depth === 0) {
				return { content: input.slice(openIdx + 1, i), closeIdx: i };
			}
		}
	}
	return undefined;
}

function buildQuoteRanges(input: string): readonly (readonly [number, number])[] {
	const ranges: [number, number][] = [];
	let inQuote: '"' | '\'' | undefined;
	let start = -1;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (inQuote) {
			if (ch === inQuote && !isEscapedAt(input, i)) {
				ranges.push([start, i + 1]);
				inQuote = undefined;
				start = -1;
			}
			continue;
		}
		if (ch === '"' || ch === '\'') {
			inQuote = ch;
			start = i;
		}
	}
	if (inQuote && start >= 0) {
		ranges.push([start, input.length]);
	}
	return ranges;
}

function isIndexInsideRanges(index: number, ranges: readonly (readonly [number, number])[]): boolean {
	for (const [start, end] of ranges) {
		if (index >= start && index < end) {
			return true;
		}
	}
	return false;
}

function stripOuterQuotes(raw: string): string {
	const t = raw.trim();
	if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('\'') && t.endsWith('\'')))) {
		const quote = t[0];
		return t.slice(1, -1).replace(/\\(.)/g, (_m, ch: string) => {
			if (ch === 'n') { return '\n'; }
			if (ch === 't') { return '\t'; }
			if (ch === 'r') { return '\r'; }
			if (ch === '\\' || ch === '"' || ch === '\'' || ch === quote) { return ch; }
			return `\\${ch}`;
		});
	}
	return t;
}

function extractMermaidSource(rawText: string): string {
	const trimmed = rawText.trim();
	if (/^(?:flowchart|graph)\b/i.test(trimmed) || trimmed.startsWith('%%')) {
		return trimmed;
	}
	const lines = trimmed.split(/\r?\n/);
	let inMermaid = false;
	const collected: string[] = [];
	for (const line of lines) {
		const t = line.trim();
		if (!inMermaid) {
			if (/^```mermaid\s*$/i.test(t)) {
				inMermaid = true;
			}
		} else {
			if (/^```\s*$/.test(t)) {
				return collected.join('\n').trim();
			}
			collected.push(line);
		}
	}
	const fenced = /(?:^|\r?\n)```mermaid\s*\r?\n([\s\S]*?)\r?\n```(?:\r?\n|$)/i.exec(trimmed);
	return (fenced ? fenced[1] : trimmed).trim();
}

function splitTopLevelByDelimiter(input: string, delimiter: string): string[] {
	const parts: string[] = [];
	let current = '';
	let inQuote: '"' | '\'' | undefined;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (inQuote) {
			current += ch;
			if (ch === inQuote && !isEscapedAt(input, i)) {
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

export function sanitizeMermaidId(raw: string, fallback: string): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		return fallback;
	}
	const cleaned = trimmed.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
	if (!cleaned) {
		return `${fallback}_${fnv1aHex(trimmed)}`;
	}
	const base = /^[A-Za-z]/.test(cleaned) ? cleaned : `${fallback}_${cleaned}`;
	if (/[^\x00-\x7F]/.test(trimmed)) {
		return `${base}_${fnv1aHex(trimmed).slice(0, 6)}`;
	}
	return base;
}

export function escapeMermaidQuotedLabel(label: string): string {
	return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ').trim();
}

interface IParsedStaffMeta {
	readonly tier?: number;
	readonly rankId?: string;
	readonly department?: string;
	readonly agentId?: string;
	readonly employeeName?: string;
	readonly engineId?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly hostAlias?: string;
	readonly rolePrompt?: string;
	readonly allowedPaths?: readonly string[];
	readonly color?: string;
}

interface IParsedWhiteboardMeta {
	readonly department?: string;
	readonly title?: string;
	readonly version?: number;
	readonly color?: string;
}

export function parseMetaBracketPairs(optStr: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of splitTopLevelByDelimiter(optStr, ',')) {
		const eq = part.indexOf('=');
		if (eq <= 0) {
			continue;
		}
		const key = part.slice(0, eq).trim().toLowerCase().replace(/-/g, '_');
		const val = stripOuterQuotes(part.slice(eq + 1).trim());
		if (key && val) {
			out[key] = val;
		}
	}
	return out;
}

function parseLayoutCommentDirective(rawLine: string): OrchestrationLayoutMode | undefined {
	const idx = findMermaidCommentIndex(rawLine);
	if (idx < 0) {
		return undefined;
	}
	const body = rawLine.slice(idx + 2).trim();
	const m = /^layout\s+(lr|td|radial|grid)\b/i.exec(body);
	if (!m) {
		return undefined;
	}
	return m[1].toLowerCase() as OrchestrationLayoutMode;
}

function parseGroupCommentDirective(rawLine: string): { readonly id: string; readonly name: string } | undefined {
	const idx = findMermaidCommentIndex(rawLine);
	if (idx < 0) {
		return undefined;
	}
	const body = rawLine.slice(idx + 2).trim();
	const headMatch = /^(?:group|dept|department)\s+([A-Za-z0-9_-]+)/i.exec(body);
	if (!headMatch) {
		return undefined;
	}
	const id = headMatch[1].trim();
	const rest = body.slice(headMatch[0].length).trim();
	let pairs: Record<string, string> = {};
	if (rest.startsWith('[')) {
		const bracketed = extractBalancedBracketSection(rest, 0);
		if (!bracketed || rest.slice(bracketed.closeIdx + 1).trim().length > 0) {
			return undefined;
		}
		pairs = parseMetaBracketPairs(bracketed.content);
	} else if (rest.length > 0) {
		return undefined;
	}
	const name = (pairs.name || pairs.title || id).trim();
	return { id, name };
}

function parsePosCommentDirective(rawLine: string): { readonly id: string; readonly pos: IMissionNodePosition } | undefined {
	const idx = findMermaidCommentIndex(rawLine);
	if (idx < 0) {
		return undefined;
	}
	const body = rawLine.slice(idx + 2).trim();
	const headMatch = /^pos\s+([A-Za-z0-9_-]+)\s*/i.exec(body);
	if (!headMatch) {
		return undefined;
	}
	const id = headMatch[1].trim();
	const rest = body.slice(headMatch[0].length).trim();
	if (!rest.startsWith('[')) {
		return undefined;
	}
	const bracketed = extractBalancedBracketSection(rest, 0);
	if (!bracketed || rest.slice(bracketed.closeIdx + 1).trim().length > 0) {
		return undefined;
	}
	const pairs = parseMetaBracketPairs(bracketed.content);
	const x = Number(pairs.x);
	const y = Number(pairs.y);
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		return undefined;
	}
	return { id, pos: { x: Math.round(x), y: Math.round(y) } };
}

/**
 * Parses inline staff metadata comments:
 *   `%% staff CEO [tier=1, rank=governor, dept=Executive, agent=agent-123, name="Chief Architect", engine=aexus-claude, model="claude-opus-4-6", thinking=high, host=local]`
 */
function parseStaffCommentDirective(rawLine: string): { readonly nodeId: string; readonly meta: IParsedStaffMeta } | undefined {
	const idx = findMermaidCommentIndex(rawLine);
	if (idx < 0) {
		return undefined;
	}
	const body = rawLine.slice(idx + 2).trim();
	const headMatch = /^(?:staff|employee|role)\s+([A-Za-z0-9_-]+)\s*/i.exec(body);
	if (!headMatch) {
		return undefined;
	}
	const nodeId = headMatch[1].trim();
	const rest = body.slice(headMatch[0].length).trim();
	if (!rest.startsWith('[')) {
		return undefined;
	}
	const bracketed = extractBalancedBracketSection(rest, 0);
	if (!bracketed || rest.slice(bracketed.closeIdx + 1).trim().length > 0) {
		return undefined;
	}
	const pairs = parseMetaBracketPairs(bracketed.content);
	let tier: number | undefined;
	const rawRoleVal = pairs.role?.trim();
	const rawTier = pairs.tier ?? pairs.level ?? (rawRoleVal && /^L?\d+$/i.test(rawRoleVal) ? rawRoleVal : undefined);
	if (rawTier) {
		const tMatch = /^L?(\d+)$/i.exec(rawTier.trim());
		if (tMatch) {
			const parsed = Number.parseInt(tMatch[1], 10);
			if (Number.isInteger(parsed) && parsed >= 0) {
				tier = parsed;
			}
		}
	}
	const rawRankId = (pairs.rank || pairs.rank_id || (rawRoleVal && !/^L?\d+$/i.test(rawRoleVal) ? rawRoleVal : undefined))?.trim();
	const rawRolePrompt = pairs.role_prompt ?? pairs.persona ?? pairs.prompt;
	const rawPaths = pairs.paths ?? pairs.allowed_paths ?? pairs.dirs;
	const allowedPaths = rawPaths
		? [...new Set(rawPaths.split(/[|;]/).map(s => s.trim()).filter(Boolean))]
		: undefined;
	const color = normalizeAdeNodeColor(pairs.color ?? pairs.accent ?? pairs.tint);
	return {
		nodeId,
		meta: {
			...(tier !== undefined ? { tier } : {}),
			...(rawRankId ? { rankId: rawRankId } : {}),
			...(pairs.dept || pairs.department ? { department: (pairs.dept || pairs.department).trim() } : {}),
			...(pairs.agent || pairs.agent_id ? { agentId: (pairs.agent || pairs.agent_id).trim() } : {}),
			...(pairs.name || pairs.employee ? { employeeName: (pairs.name || pairs.employee).trim() } : {}),
			...(pairs.engine || pairs.engine_id ? { engineId: (pairs.engine || pairs.engine_id).trim() } : {}),
			...(pairs.model ? { model: pairs.model.trim() } : {}),
			...(pairs.thinking ? { thinking: pairs.thinking.trim() } : {}),
			...(pairs.host || pairs.host_alias ? { hostAlias: (pairs.host || pairs.host_alias).trim() } : {}),
			...(rawRolePrompt?.trim() ? { rolePrompt: rawRolePrompt.trim() } : {}),
			...(allowedPaths && allowedPaths.length > 0 ? { allowedPaths } : {}),
			...(color ? { color } : {}),
		},
	};
}

function parseStaffCheckDurationMs(raw: string): number | undefined {
	const t = raw.trim().toLowerCase();
	if (!t) {
		return undefined;
	}
	if (/^\d+$/.test(t)) {
		const n = Number.parseInt(t, 10);
		return n <= 600 ? n * 1000 : n;
	}
	const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins)$/.exec(t);
	if (!m) {
		return undefined;
	}
	const val = Number.parseFloat(m[1]);
	if (!Number.isFinite(val) || val <= 0) {
		return undefined;
	}
	const unit = m[2];
	if (unit === 'ms') { return Math.round(val); }
	if (unit === 'm' || unit === 'min' || unit === 'mins') { return Math.round(val * 60_000); }
	return Math.round(val * 1000);
}

/**
 * Parses automated staff verification check directives:
 *   `%% staff-check Dev1 [name=unit, cwd=backend, timeout=90s, on_fail=bounce]: npm test`
 */
function parseStaffCheckCommentDirective(
	rawLine: string,
	seqByNode: Map<string, number>,
): { readonly nodeId: string; readonly hook: IMissionNodeCheckHook } | undefined {
	const idx = findMermaidCommentIndex(rawLine);
	if (idx < 0) {
		return undefined;
	}
	const body = rawLine.slice(idx + 2).trim();
	const headMatch = /^(?:staff-check|staff_check|check)\s+([A-Za-z0-9_-]+)/i.exec(body);
	if (!headMatch) {
		return undefined;
	}
	const nodeId = headMatch[1].trim();
	let rest = body.slice(headMatch[0].length).trim();
	let pairs: Record<string, string> = {};
	if (rest.startsWith('[')) {
		const bracketed = extractBalancedBracketSection(rest, 0);
		if (!bracketed) {
			return undefined;
		}
		pairs = parseMetaBracketPairs(bracketed.content);
		rest = rest.slice(bracketed.closeIdx + 1).trim();
	}
	let command: string | undefined;
	if (rest.startsWith(':')) {
		command = rest.slice(1).trim() || undefined;
	} else if (rest.length > 0) {
		return undefined;
	}
	const expectFiles = (pairs.expect_file ?? pairs.expect_files ?? pairs.file ?? pairs.files ?? '')
		.split('|')
		.map(s => s.trim())
		.filter(Boolean);
	if (!command && expectFiles.length === 0) {
		return undefined;
	}
	const expectExitRaw = pairs.expect_exit ?? pairs.exit ?? pairs.exit_code;
	const parsedExit = expectExitRaw !== undefined ? Number.parseInt(expectExitRaw, 10) : undefined;
	const expectExitCode = parsedExit !== undefined && Number.isInteger(parsedExit) && parsedExit >= 0 ? parsedExit : undefined;
	const timeoutRaw = pairs.timeout ?? pairs.timeout_ms;
	const parsedTimeout = timeoutRaw ? parseStaffCheckDurationMs(timeoutRaw) : undefined;
	const timeoutMs = parsedTimeout !== undefined ? Math.max(1_000, Math.min(300_000, parsedTimeout)) : undefined;
	const rawOnFail = (pairs.on_fail ?? pairs.onfail ?? '').toLowerCase();
	const onFail: MissionCheckOnFailAction | undefined = rawOnFail === 'bounce' || rawOnFail === 'fail' || rawOnFail === 'escalate' ? rawOnFail : undefined;
	const retriesRaw = pairs.max_retries ?? pairs.retries ?? pairs.max_auto_retries;
	const parsedRetries = retriesRaw !== undefined ? Number.parseInt(retriesRaw, 10) : undefined;
	const maxAutoRetries = parsedRetries !== undefined && Number.isInteger(parsedRetries) && parsedRetries >= 0 ? Math.min(5, parsedRetries) : undefined;

	const nextSeq = (seqByNode.get(nodeId) ?? 0) + 1;
	seqByNode.set(nodeId, nextSeq);
	return {
		nodeId,
		hook: {
			id: pairs.id || `orch-check-${nodeId}-${nextSeq}`,
			...(pairs.name || pairs.label ? { name: pairs.name || pairs.label } : {}),
			...(command ? { command } : {}),
			...(expectExitCode !== undefined ? { expectExitCode } : {}),
			...(pairs.cwd || pairs.dir ? { cwd: pairs.cwd || pairs.dir } : {}),
			...(pairs.host || pairs.host_alias ? { hostAlias: pairs.host || pairs.host_alias } : {}),
			...(expectFiles.length > 0 ? { expectFiles } : {}),
			...(pairs.match || pairs.expect_match || pairs.expect_output ? { expectOutputMatch: pairs.match || pairs.expect_match || pairs.expect_output } : {}),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
			...(onFail ? { onFail } : {}),
			...(maxAutoRetries !== undefined ? { maxAutoRetries } : {}),
			enabled: true,
			source: 'mermaid',
		},
	};
}

/**
 * Parses inline whiteboard metadata comments:
 *   `%% whiteboard WB_BE [dept=Backend, title="Backend Architecture", version=3]`
 */
function parseWhiteboardCommentDirective(rawLine: string): { readonly nodeId: string; readonly meta: IParsedWhiteboardMeta } | undefined {
	const idx = findMermaidCommentIndex(rawLine);
	if (idx < 0) {
		return undefined;
	}
	const body = rawLine.slice(idx + 2).trim();
	const headMatch = /^(?:whiteboard|board|wb)\s+([A-Za-z0-9_-]+)/i.exec(body);
	if (!headMatch) {
		return undefined;
	}
	const nodeId = headMatch[1].trim();
	const rest = body.slice(headMatch[0].length).trim();
	let pairs: Record<string, string> = {};
	if (rest.startsWith('[')) {
		const bracketed = extractBalancedBracketSection(rest, 0);
		if (!bracketed || rest.slice(bracketed.closeIdx + 1).trim().length > 0) {
			return undefined;
		}
		pairs = parseMetaBracketPairs(bracketed.content);
	} else if (rest.length > 0) {
		return undefined;
	}
	let version: number | undefined;
	const rawVer = pairs.version ?? pairs.v;
	if (rawVer !== undefined) {
		const parsedVer = Number.parseInt(rawVer.trim(), 10);
		if (Number.isInteger(parsedVer) && parsedVer >= 0) {
			version = parsedVer;
		}
	}
	const color = normalizeAdeNodeColor(pairs.color ?? pairs.accent ?? pairs.tint);
	return {
		nodeId,
		meta: {
			...(pairs.dept || pairs.department ? { department: (pairs.dept || pairs.department).trim() } : {}),
			...(pairs.title || pairs.name ? { title: (pairs.title || pairs.name).trim() } : {}),
			...(version !== undefined ? { version } : {}),
			...(color ? { color } : {}),
		},
	};
}

export function extractRankAndEmployeeFromLabel(rawLabel: string): {
	readonly label: string;
	readonly employeeName?: string;
	readonly tier?: number;
} {
	let text = rawLabel.trim();
	let tier: number | undefined;

	// Extract trailing or leading tier badge like `(L1)`, `[L2]`, `L1 · ...`, `L2:`
	const trailingTier = /\s*[([]\s*L(\d+)\s*[)\]]\s*$/i.exec(text);
	if (trailingTier) {
		tier = Number.parseInt(trailingTier[1], 10);
		text = text.slice(0, trailingTier.index).trim();
	} else {
		const leadingTier = /^L(\d+)\s*(?:[·:：|-]\s*|\s+)/i.exec(text);
		if (leadingTier) {
			tier = Number.parseInt(leadingTier[1], 10);
			text = text.slice(leadingTier[0].length).trim();
		}
	}

	// Extract `@EmployeeName` prefix if present (e.g. `@Alice · Backend Lead`, `@QA Audit Manager · Lead`, or `@Alice: API`)
	const atMatch = /^@([^·:：|()[\]]+?)(?:\s*[·:：|-]\s*([\s\S]+))?$/.exec(text);
	if (atMatch) {
		const empName = atMatch[1].trim();
		const roleTitle = atMatch[2]?.trim();
		return {
			label: roleTitle ? `${empName} · ${roleTitle}` : empName,
			employeeName: empName,
			...(tier !== undefined ? { tier } : {}),
		};
	}

	// Also match embedded `@EmployeeName` anywhere in the label (e.g. `Lead @Alice`, `CEO @Alice · Core`)
	const embeddedAtMatch = /(?:^|[\s(\[/·|])@([A-Za-z0-9_\u4e00-\u9fff-]+)/.exec(text);
	if (embeddedAtMatch) {
		const empName = embeddedAtMatch[1].trim();
		return {
			label: text || rawLabel.trim(),
			employeeName: empName,
			...(tier !== undefined ? { tier } : {}),
		};
	}

	return {
		label: text || rawLabel.trim(),
		...(tier !== undefined ? { tier } : {}),
	};
}

interface IParsedOrchNodeToken {
	readonly id: string;
	readonly label?: string;
	readonly kind?: OrchestrationNodeKind;
	readonly employeeName?: string;
	readonly tier?: number;
	readonly departmentHint?: string;
}

function parseOrchestrationNodeToken(rawToken: string): IParsedOrchNodeToken | undefined {
	// Strip optional Mermaid class suffix `:::Dept`
	let token = rawToken.trim();
	let classDept: string | undefined;
	const clsIdx = token.lastIndexOf(':::');
	if (clsIdx > 0) {
		const tail = token.slice(clsIdx + 3).trim();
		if (/^[A-Za-z0-9_-]+$/.test(tail)) {
			classDept = tail;
			token = token.slice(0, clsIdx).trim();
		}
	}
	if (!token) {
		return undefined;
	}

	// Cylinder shape: WB1[("Whiteboard: Backend")] -> Department Shared Whiteboard
	const cylMatch = /^([A-Za-z0-9_-]+)\s*\[\(([\s\S]+?)\)\]$/.exec(token);
	if (cylMatch) {
		const id = cylMatch[1];
		const rawInner = stripOuterQuotes(cylMatch[2]);
		const cleanTitle = rawInner.replace(/^(?:📋\s*)?(?:whiteboard|白板|board)\s*[:：-]?\s*/i, '').trim() || rawInner;
		return {
			id,
			label: cleanTitle,
			kind: 'whiteboard',
			...(classDept ? { departmentHint: classDept } : {}),
		};
	}

	const buildStaff = (id: string, rawInner: string): IParsedOrchNodeToken => {
		const unquoted = stripOuterQuotes(rawInner);
		// Also treat explicit "Whiteboard: ..." / "白板: ..." labels as whiteboards
		if (/^(?:📋\s*)?(?:whiteboard|白板)\s*[:：]/i.test(unquoted)) {
			const cleanTitle = unquoted.replace(/^(?:📋\s*)?(?:whiteboard|白板)\s*[:：]\s*/i, '').trim() || unquoted;
			return {
				id,
				label: cleanTitle,
				kind: 'whiteboard',
				...(classDept ? { departmentHint: classDept } : {}),
			};
		}
		const extracted = extractRankAndEmployeeFromLabel(unquoted);
		return {
			id,
			label: extracted.label,
			kind: 'staff',
			employeeName: extracted.employeeName,
			...(extracted.tier !== undefined ? { tier: extracted.tier } : {}),
			...(classDept ? { departmentHint: classDept } : {}),
		};
	};

	const stadiumMatch = /^([A-Za-z0-9_-]+)\s*\(\[([\s\S]+?)\]\)$/.exec(token);
	if (stadiumMatch) {
		return buildStaff(stadiumMatch[1], stadiumMatch[2]);
	}
	const doubleCircleMatch = /^([A-Za-z0-9_-]+)\s*\(\(([\s\S]+?)\)\)$/.exec(token);
	if (doubleCircleMatch) {
		return buildStaff(doubleCircleMatch[1], doubleCircleMatch[2]);
	}
	const hexMatch = /^([A-Za-z0-9_-]+)\s*\{\{([\s\S]+?)\}\}$/.exec(token);
	if (hexMatch) {
		return buildStaff(hexMatch[1], hexMatch[2]);
	}
	const diamondMatch = /^([A-Za-z0-9_-]+)\s*\{([\s\S]+?)\}$/.exec(token);
	if (diamondMatch) {
		return buildStaff(diamondMatch[1], diamondMatch[2]);
	}
	const rectMatch = /^([A-Za-z0-9_-]+)\s*\[([\s\S]+?)\]$/.exec(token);
	if (rectMatch) {
		return buildStaff(rectMatch[1], rectMatch[2]);
	}
	const roundMatch = /^([A-Za-z0-9_-]+)\s*\(([\s\S]+?)\)$/.exec(token);
	if (roundMatch) {
		return buildStaff(roundMatch[1], roundMatch[2]);
	}

	const bareMatch = /^([A-Za-z0-9_-]+)$/.exec(token);
	if (bareMatch) {
		return {
			id: bareMatch[1],
			...(classDept ? { departmentHint: classDept } : {}),
		};
	}
	return undefined;
}

/**
 * Matches Mermaid directed AND bidirectional edge operators:
 * - `<-->`, `<-->|label|`, `<-.->`, `<-.->|label|`, `<==>`, `<==>|label|`
 * - `-->`, `-->|label|`, `-.->`, `-.->|label|`, `==>`, `==>|label|`
 * - `-- label -->`, `-. label .->`, `<-- label -->`
 */
const ORCH_EDGE_OP_RE = /\s*(?:<--\s+([^->\n|]+?)\s+-->|--\s+([^->\n|]+?)\s+-->|-\.\s*([^.->\n|]+?)\s*\.->|(<-+\.+->|<==+>|<--+>|-\.+->|==+>|-->|---+>)(?:\|([^|]*)\|)?)\s*/g;

export function parseSubgraphHeader(stmt: string): { readonly id: string; readonly name: string } | undefined {
	const m = /^subgraph\s+(.+)$/i.exec(stmt.trim());
	if (!m) {
		return undefined;
	}
	const rest = m[1].trim();
	// `subgraph Backend["Backend Dept"]`
	const idAndLabel = /^([A-Za-z0-9_-]+)\s*\[([\s\S]+?)\]$/.exec(rest);
	if (idAndLabel) {
		return { id: idAndLabel[1].trim(), name: stripOuterQuotes(idAndLabel[2]) };
	}
	const quoted = stripOuterQuotes(rest);
	return { id: sanitizeMermaidId(quoted, 'Dept'), name: quoted };
}

const ORCH_GRAPH_PARSE_CACHE_MAX = 64;
const ORCH_GRAPH_CACHE_MAX_TEXT_LEN = 512 * 1024;
const ORCH_GRAPH_CACHE_MAX_TOTAL_CHARS = 4 * 1024 * 1024;
let orchGraphMruRaw: string | undefined;
let orchGraphMruResult: IOrchestrationGraphParseResult | undefined;
let orchGraphCacheTotalChars = 0;
const orchGraphParseCache = new Map<string, IOrchestrationGraphParseResult>();

function deepFreezeOrchGraph<T>(value: T): T {
	if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
		return value;
	}
	Object.freeze(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			deepFreezeOrchGraph(item);
		}
	} else {
		for (const v of Object.values(value as Record<string, unknown>)) {
			deepFreezeOrchGraph(v);
		}
	}
	return value;
}

/**
 * Parses cyclic free-topology Orchestration Mermaid syntax.
 * - Allows arbitrary cycles and bidirectional edges (`A <--> B`, `A --> B --> A`).
 * - Enforces STRICT employee uniqueness (rejects duplicate employee identities across nodes).
 * - Preserves `subgraph` departments and Department Shared Whiteboard nodes.
 * - Memoized via lock-free MRU + byte-bounded frozen LRU cache so repeated hot-path parses run in O(1) safely.
 */
export function parseOrchestrationGraph(rawText: string): IOrchestrationGraphParseResult {
	if (rawText === orchGraphMruRaw && orchGraphMruResult) {
		return orchGraphMruResult;
	}
	if (rawText.length <= ORCH_GRAPH_CACHE_MAX_TEXT_LEN) {
		const cached = orchGraphParseCache.get(rawText);
		if (cached) {
			orchGraphParseCache.delete(rawText);
			orchGraphParseCache.set(rawText, cached);
			orchGraphMruRaw = rawText;
			orchGraphMruResult = cached;
			return cached;
		}
	}
	const parsed = deepFreezeOrchGraph(parseOrchestrationGraphUncached(rawText));
	if (rawText.length <= ORCH_GRAPH_CACHE_MAX_TEXT_LEN) {
		while (
			orchGraphParseCache.size > 0
			&& (orchGraphParseCache.size >= ORCH_GRAPH_PARSE_CACHE_MAX
				|| orchGraphCacheTotalChars + rawText.length > ORCH_GRAPH_CACHE_MAX_TOTAL_CHARS)
		) {
			const oldestKey = orchGraphParseCache.keys().next().value;
			if (oldestKey === undefined) {
				break;
			}
			orchGraphParseCache.delete(oldestKey);
			orchGraphCacheTotalChars = Math.max(0, orchGraphCacheTotalChars - oldestKey.length);
		}
		orchGraphParseCache.set(rawText, parsed);
		orchGraphCacheTotalChars += rawText.length;
		orchGraphMruRaw = rawText;
		orchGraphMruResult = parsed;
	}
	return parsed;
}

function parseOrchestrationGraphUncached(rawText: string): IOrchestrationGraphParseResult {
	const source = extractMermaidSource(rawText);
	if (!source) {
		return { direction: 'TD', nodes: [], edges: [], departments: [] };
	}

	let direction: OrchestrationDirection = 'TD';
	let layoutMode: OrchestrationLayoutMode | undefined;
	const nodeMap = new Map<string, {
		id: string;
		label: string;
		kind: OrchestrationNodeKind;
		employeeName?: string;
		employeeKey?: string;
		tier?: number;
		rankId?: string;
		department?: string;
		agentId?: string;
		engineId?: string;
		model?: string;
		thinking?: string;
		hostAlias?: string;
		rolePrompt?: string;
		allowedPaths?: readonly string[];
		checks?: IMissionNodeCheckHook[];
		color?: string;
		whiteboardId?: string;
		whiteboardVersion?: number;
		whiteboardContent?: string;
	}>();
	const staffMetaByNodeId = new Map<string, IParsedStaffMeta>();
	const staffChecksByNodeId = new Map<string, IMissionNodeCheckHook[]>();
	const staffCheckSeqByNodeId = new Map<string, number>();
	const whiteboardMetaByNodeId = new Map<string, IParsedWhiteboardMeta>();
	const whiteboardBodyByNodeId = new Map<string, string>();
	const parsedPositions: Record<string, IMissionNodePosition> = {};
	const deptStack: { readonly id: string; readonly name: string }[] = [];
	const deptOrder: string[] = [];
	const declaredDeptIds = new Set<string>();
	const deptById = new Map<string, { id: string; name: string; nodeIds: Set<string>; whiteboardIds: Set<string> }>();
	const rawEdges: { id: string; from: string; to: string; label?: string; dashed?: boolean }[] = [];
	const edgeKeySet = new Set<string>();

	const registerInActiveDept = (nodeId: string, kind: OrchestrationNodeKind) => {
		const activeDept = deptStack[deptStack.length - 1];
		if (!activeDept) {
			return;
		}
		let grp = deptById.get(activeDept.id);
		if (!grp) {
			grp = { id: activeDept.id, name: activeDept.name, nodeIds: new Set(), whiteboardIds: new Set() };
			deptById.set(activeDept.id, grp);
			deptOrder.push(activeDept.id);
		}
		if (kind === 'whiteboard') {
			grp.whiteboardIds.add(nodeId);
		} else {
			grp.nodeIds.add(nodeId);
		}
	};

	const upsertNode = (token: IParsedOrchNodeToken) => {
		const activeDept = deptStack[deptStack.length - 1];
		const existing = nodeMap.get(token.id);
		const inferredDept = activeDept?.name ?? token.departmentHint;
		const resolvedKind: OrchestrationNodeKind = token.kind ?? existing?.kind ?? 'staff';

		if (!existing) {
			const label = token.label?.trim() || token.id;
			const empName = resolvedKind === 'staff' ? (token.employeeName?.trim() || undefined) : undefined;
			nodeMap.set(token.id, {
				id: token.id,
				label,
				kind: resolvedKind,
				...(empName ? { employeeName: empName, employeeKey: normalizeMissionEmployeeKey(empName) } : {}),
				...(token.tier !== undefined ? { tier: token.tier } : {}),
				...(inferredDept ? { department: inferredDept } : {}),
				...(resolvedKind === 'whiteboard' ? { whiteboardId: token.id } : {}),
			});
		} else {
			if (token.label?.trim() && existing.label === existing.id) {
				existing.label = token.label.trim();
			}
			if (token.kind === 'whiteboard') {
				existing.kind = 'whiteboard';
				existing.whiteboardId = existing.id;
				existing.employeeName = undefined;
				existing.employeeKey = undefined;
			}
			if (existing.kind === 'staff' && token.employeeName?.trim() && !existing.employeeName) {
				existing.employeeName = token.employeeName.trim();
				existing.employeeKey = normalizeMissionEmployeeKey(existing.employeeName);
			}
			if (token.tier !== undefined && existing.tier === undefined) {
				existing.tier = token.tier;
			}
			if (inferredDept && !existing.department) {
				existing.department = inferredDept;
			}
		}
		const latest = nodeMap.get(token.id)!;
		registerInActiveDept(latest.id, latest.kind);
	};

	const pushEdge = (from: string, to: string, label?: string, dashed?: boolean): string | undefined => {
		if (from === to) {
			return `Self-loop "${from} --> ${to}" is not allowed on Orchestration canvas.`;
		}
		const key = `${from}->${to}`;
		if (!edgeKeySet.has(key)) {
			edgeKeySet.add(key);
			rawEdges.push({
				id: key,
				from,
				to,
				...(label ? { label } : {}),
				...(dashed ? { dashed: true } : {}),
			});
		}
		return undefined;
	};

	const rawLines = source.split(/\r?\n/);
	let activeWbBodyId: string | undefined;
	let activeWbBodyLines: string[] = [];
	const flushWbBody = () => {
		if (activeWbBodyId) {
			whiteboardBodyByNodeId.set(activeWbBodyId, activeWbBodyLines.join('\n'));
			activeWbBodyId = undefined;
			activeWbBodyLines = [];
		}
	};

	for (const rawLine of rawLines) {
		if (activeWbBodyId) {
			const trimmedLine = rawLine.trim();
			if (/^%%\s*wb-end\b/i.test(trimmedLine)) {
				flushWbBody();
				continue;
			}
			const bodyLineMatch = /^\s*%%\s*\|(?: (.*)|())$/.exec(rawLine);
			if (bodyLineMatch) {
				activeWbBodyLines.push(bodyLineMatch[1] ?? '');
				continue;
			}
			// Defensive close if user hand-edited code without `%% wb-end`
			flushWbBody();
		}

		const wbBodyStart = /^\s*%%\s*wb-body\s+([A-Za-z0-9_-]+)\s*$/i.exec(rawLine);
		if (wbBodyStart) {
			activeWbBodyId = wbBodyStart[1].trim();
			activeWbBodyLines = [];
			continue;
		}
		const parsedLayout = parseLayoutCommentDirective(rawLine);
		if (parsedLayout) {
			layoutMode = parsedLayout;
		}
		const groupMeta = parseGroupCommentDirective(rawLine);
		if (groupMeta) {
			declaredDeptIds.add(groupMeta.id);
			const existingGrp = deptById.get(groupMeta.id);
			if (!existingGrp) {
				deptById.set(groupMeta.id, { id: groupMeta.id, name: groupMeta.name, nodeIds: new Set(), whiteboardIds: new Set() });
				deptOrder.push(groupMeta.id);
			} else if (groupMeta.name && existingGrp.name === existingGrp.id) {
				existingGrp.name = groupMeta.name;
			}
		}
		const posMeta = parsePosCommentDirective(rawLine);
		if (posMeta) {
			parsedPositions[posMeta.id] = posMeta.pos;
		}
		const staffMeta = parseStaffCommentDirective(rawLine);
		if (staffMeta) {
			staffMetaByNodeId.set(staffMeta.nodeId, { ...staffMetaByNodeId.get(staffMeta.nodeId), ...staffMeta.meta });
		}
		const staffCheck = parseStaffCheckCommentDirective(rawLine, staffCheckSeqByNodeId);
		if (staffCheck) {
			const list = staffChecksByNodeId.get(staffCheck.nodeId) ?? [];
			list.push(staffCheck.hook);
			staffChecksByNodeId.set(staffCheck.nodeId, list);
		}
		const wbMeta = parseWhiteboardCommentDirective(rawLine);
		if (wbMeta) {
			whiteboardMetaByNodeId.set(wbMeta.nodeId, { ...whiteboardMetaByNodeId.get(wbMeta.nodeId), ...wbMeta.meta });
		}
		const commentIdx = findMermaidCommentIndex(rawLine);
		const noComment = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trim();
		if (!noComment) {
			continue;
		}
		for (const stmt of splitTopLevelByDelimiter(noComment, ';')) {
			const headerMatch = /^(?:flowchart|graph)\s+(LR|RL|TD|TB|BT)\b/i.exec(stmt);
			if (headerMatch) {
				const dir = headerMatch[1].toUpperCase();
				direction = (dir === 'LR' || dir === 'RL') ? 'LR' : 'TD';
				continue;
			}
			if (/^subgraph\b/i.test(stmt)) {
				const sub = parseSubgraphHeader(stmt);
				if (sub) {
					deptStack.push(sub);
					declaredDeptIds.add(sub.id);
					if (!deptById.has(sub.id)) {
						deptById.set(sub.id, { id: sub.id, name: sub.name, nodeIds: new Set(), whiteboardIds: new Set() });
						deptOrder.push(sub.id);
					}
				}
				continue;
			}
			if (/^end$/i.test(stmt)) {
				if (deptStack.length > 0) {
					deptStack.pop();
				}
				continue;
			}
			if (/^(?:direction\b|classDef\b|class\b|style\b|linkStyle\b|click\b|accTitle\b|accDescr\b)/i.test(stmt)) {
				continue;
			}

			const quoteRanges = buildQuoteRanges(stmt);
			ORCH_EDGE_OP_RE.lastIndex = 0;
			const matches: { start: number; end: number; label?: string; bidirectional: boolean; dashed: boolean }[] = [];
			let m: RegExpExecArray | null;
			while ((m = ORCH_EDGE_OP_RE.exec(stmt)) !== null) {
				if (isIndexInsideRanges(m.index, quoteRanges)) {
					continue;
				}
				const rawTextOp = m[0].trim();
				const bidirLabel = m[1]?.trim();
				const solidLabel = m[2]?.trim();
				const dashedLabel = m[3]?.trim();
				const opToken = m[4] ?? '';
				const pipeLabel = m[5]?.trim();
				const bidirectional = Boolean(bidirLabel) || rawTextOp.startsWith('<');
				const dashed = Boolean(dashedLabel) || opToken.includes('.');
				const label = (bidirLabel || solidLabel || dashedLabel || pipeLabel || undefined);
				matches.push({
					start: m.index,
					end: m.index + m[0].length,
					label,
					bidirectional,
					dashed,
				});
			}

			if (matches.length === 0) {
				const single = parseOrchestrationNodeToken(stmt);
				if (single) {
					upsertNode(single);
					continue;
				}
				return {
					direction,
					nodes: [],
					edges: [],
					departments: [],
					error: `Unrecognized Orchestration statement: "${stmt}". Use Mermaid nodes/edges (e.g. CEO["@CEO (L1)"] <--> Lead["@Lead (L2)"]).`,
				};
			}

			const segments: string[] = [];
			let cursor = 0;
			for (const op of matches) {
				segments.push(stmt.slice(cursor, op.start).trim());
				cursor = op.end;
			}
			segments.push(stmt.slice(cursor).trim());

			for (let s = 0; s < matches.length; s++) {
				const fromGroup = splitTopLevelByDelimiter(segments[s], '&').map(parseOrchestrationNodeToken).filter((t): t is IParsedOrchNodeToken => Boolean(t));
				const toGroup = splitTopLevelByDelimiter(segments[s + 1], '&').map(parseOrchestrationNodeToken).filter((t): t is IParsedOrchNodeToken => Boolean(t));
				if (fromGroup.length === 0 || toGroup.length === 0) {
					return {
						direction,
						nodes: [],
						edges: [],
						departments: [],
						error: `Could not parse Orchestration edge statement: "${stmt}".`,
					};
				}
				for (const f of fromGroup) { upsertNode(f); }
				for (const t of toGroup) { upsertNode(t); }

				const op = matches[s];
				for (const f of fromGroup) {
					for (const t of toGroup) {
						const err1 = pushEdge(f.id, t.id, op.label, op.dashed);
						if (err1) {
							return { direction, nodes: [], edges: [], departments: [], error: err1 };
						}
						if (op.bidirectional) {
							const err2 = pushEdge(t.id, f.id, op.label, op.dashed);
							if (err2) {
								return { direction, nodes: [], edges: [], departments: [], error: err2 };
							}
						}
					}
				}
			}
		}
	}

	flushWbBody();

	// Merge inline `%% staff` and `%% whiteboard` metadata directives
	for (const [nodeId, meta] of staffMetaByNodeId.entries()) {
		const existing = nodeMap.get(nodeId);
		if (!existing) {
			const empName = meta.employeeName ?? nodeId;
			nodeMap.set(nodeId, {
				id: nodeId,
				label: empName,
				kind: 'staff',
				employeeName: empName,
				employeeKey: normalizeMissionEmployeeKey(empName),
				...(meta.tier !== undefined ? { tier: meta.tier } : {}),
				...(meta.rankId ? { rankId: meta.rankId } : {}),
				...(meta.department ? { department: meta.department } : {}),
				...(meta.agentId ? { agentId: meta.agentId } : {}),
				...(meta.engineId ? { engineId: meta.engineId } : {}),
				...(meta.model ? { model: meta.model } : {}),
				...(meta.thinking ? { thinking: meta.thinking } : {}),
				...(meta.hostAlias ? { hostAlias: meta.hostAlias } : {}),
				...(meta.rolePrompt ? { rolePrompt: meta.rolePrompt } : {}),
				...(meta.allowedPaths && meta.allowedPaths.length > 0 ? { allowedPaths: meta.allowedPaths } : {}),
				...(meta.color ? { color: meta.color } : {}),
			});
		} else if (existing.kind === 'staff') {
			if (meta.tier !== undefined) { existing.tier = meta.tier; }
			if (meta.rankId) { existing.rankId = meta.rankId; }
			if (meta.department) { existing.department = meta.department; }
			if (meta.agentId) { existing.agentId = meta.agentId; }
			if (meta.engineId) { existing.engineId = meta.engineId; }
			if (meta.model) { existing.model = meta.model; }
			if (meta.thinking) { existing.thinking = meta.thinking; }
			if (meta.hostAlias) { existing.hostAlias = meta.hostAlias; }
			if (meta.rolePrompt) { existing.rolePrompt = meta.rolePrompt; }
			if (meta.allowedPaths && meta.allowedPaths.length > 0) { existing.allowedPaths = meta.allowedPaths; }
			if (meta.color) { existing.color = meta.color; }
			if (meta.employeeName) {
				existing.employeeName = meta.employeeName;
				existing.employeeKey = normalizeMissionEmployeeKey(meta.employeeName);
			}
		}
	}

	for (const [nodeId, hooks] of staffChecksByNodeId.entries()) {
		const existing = nodeMap.get(nodeId);
		if (existing && existing.kind === 'staff' && hooks.length > 0) {
			existing.checks = hooks;
		}
	}

	for (const [nodeId, meta] of whiteboardMetaByNodeId.entries()) {
		const existing = nodeMap.get(nodeId);
		if (!existing) {
			nodeMap.set(nodeId, {
				id: nodeId,
				label: meta.title || nodeId,
				kind: 'whiteboard',
				whiteboardId: nodeId,
				...(meta.department ? { department: meta.department } : {}),
				...(meta.version !== undefined ? { whiteboardVersion: meta.version } : {}),
				...(meta.color ? { color: meta.color } : {}),
			});
		} else {
			existing.kind = 'whiteboard';
			existing.whiteboardId = nodeId;
			existing.employeeName = undefined;
			existing.employeeKey = undefined;
			if (meta.title && existing.label === existing.id) { existing.label = meta.title; }
			if (meta.department) { existing.department = meta.department; }
			if (meta.version !== undefined) { existing.whiteboardVersion = meta.version; }
			if (meta.color) { existing.color = meta.color; }
		}
	}

	for (const [nodeId, bodyText] of whiteboardBodyByNodeId.entries()) {
		const existing = nodeMap.get(nodeId);
		if (!existing) {
			nodeMap.set(nodeId, {
				id: nodeId,
				label: nodeId,
				kind: 'whiteboard',
				whiteboardId: nodeId,
				whiteboardContent: bodyText,
				whiteboardVersion: 1,
			});
		} else if (existing.kind === 'whiteboard') {
			existing.whiteboardContent = bodyText;
			if (existing.whiteboardVersion === undefined) {
				existing.whiteboardVersion = bodyText.length > 0 ? 1 : 0;
			}
		}
	}

	// Finalize employee uniqueness keys & STRICTLY enforce 1-node-per-employee uniqueness!
	const seenEmployeeKeyToNodeId = new Map<string, string>();
	const seenAgentIdToNodeId = new Map<string, string>();
	const nodes: IOrchestrationGraphNode[] = [];
	const whiteboardContents: Record<string, IOrchestrationWhiteboardContentSpec> = {};
	const deptByLowerName = new Map<string, { id: string; name: string; nodeIds: Set<string>; whiteboardIds: Set<string> }>();
	for (const g of deptById.values()) {
		const key = g.name.toLowerCase();
		if (!deptByLowerName.has(key)) {
			deptByLowerName.set(key, g);
		}
	}
	for (const raw of nodeMap.values()) {
		if (raw.kind === 'staff') {
			const empName = raw.employeeName?.trim() || raw.label.trim() || raw.id;
			const empKey = normalizeMissionEmployeeKey(empName) || normalizeMissionEmployeeKey(raw.id);
			const dupNodeId = seenEmployeeKeyToNodeId.get(empKey);
			if (dupNodeId && dupNodeId !== raw.id) {
				return {
					direction,
					nodes: [],
					edges: [],
					departments: [],
					error: `Duplicate employee "${empName}" on nodes "${dupNodeId}" and "${raw.id}". Each staff member may appear only once on the Orchestration canvas.`,
				};
			}
			seenEmployeeKeyToNodeId.set(empKey, raw.id);
			if (raw.agentId) {
				const dupAgentNode = seenAgentIdToNodeId.get(raw.agentId);
				if (dupAgentNode && dupAgentNode !== raw.id) {
					return {
						direction,
						nodes: [],
						edges: [],
						departments: [],
						error: `Duplicate bound employee session "${raw.agentId}" on nodes "${dupAgentNode}" and "${raw.id}". Each staff member may appear only once on the Orchestration canvas.`,
					};
				}
				seenAgentIdToNodeId.set(raw.agentId, raw.id);
			}
			nodes.push({
				id: raw.id,
				label: raw.label,
				kind: 'staff',
				employeeName: empName,
				employeeKey: empKey,
				...(raw.tier !== undefined ? { tier: raw.tier } : {}),
				...(raw.rankId ? { rankId: raw.rankId } : {}),
				...(raw.department ? { department: raw.department } : {}),
				...(raw.agentId ? { agentId: raw.agentId } : {}),
				...(raw.engineId ? { engineId: raw.engineId } : {}),
				...(raw.model ? { model: raw.model } : {}),
				...(raw.thinking ? { thinking: raw.thinking } : {}),
				...(raw.hostAlias ? { hostAlias: raw.hostAlias } : {}),
				...(raw.rolePrompt ? { rolePrompt: raw.rolePrompt } : {}),
				...(raw.allowedPaths && raw.allowedPaths.length > 0 ? { allowedPaths: raw.allowedPaths } : {}),
				...(raw.checks && raw.checks.length > 0 ? { checks: raw.checks } : {}),
				...(raw.color ? { color: raw.color } : {}),
			});
		} else {
			nodes.push({
				id: raw.id,
				label: raw.label,
				kind: 'whiteboard',
				whiteboardId: raw.whiteboardId ?? raw.id,
				...(raw.department ? { department: raw.department } : {}),
				...(raw.whiteboardVersion !== undefined ? { whiteboardVersion: raw.whiteboardVersion } : {}),
				...(raw.whiteboardContent !== undefined ? { whiteboardContent: raw.whiteboardContent } : {}),
				...(raw.color ? { color: raw.color } : {}),
			});
			if (raw.whiteboardContent !== undefined || raw.whiteboardVersion !== undefined) {
				whiteboardContents[raw.id] = {
					id: raw.whiteboardId ?? raw.id,
					title: raw.label,
					department: raw.department || 'General',
					content: raw.whiteboardContent ?? '',
					version: raw.whiteboardVersion ?? (raw.whiteboardContent ? 1 : 0),
				};
			}
		}

		// Ensure department metadata from `%% staff` / `%% whiteboard` is also represented in departments list
		if (raw.department) {
			const lowerDept = raw.department.toLowerCase();
			let grp = deptByLowerName.get(lowerDept);
			if (!grp) {
				let deptId = sanitizeMermaidId(raw.department, 'Dept');
				if (deptById.has(deptId)) {
					let suffix = 2;
					while (deptById.has(`${deptId}_${suffix}`)) {
						suffix++;
					}
					deptId = `${deptId}_${suffix}`;
				}
				grp = { id: deptId, name: raw.department, nodeIds: new Set(), whiteboardIds: new Set() };
				deptById.set(deptId, grp);
				deptByLowerName.set(lowerDept, grp);
				deptOrder.push(deptId);
			}
			// Deduplicate membership so explicit `%% staff`/`%% whiteboard [dept=...]` overrides never leave the node in two departments
			for (const other of deptById.values()) {
				if (other !== grp) {
					other.nodeIds.delete(raw.id);
					other.whiteboardIds.delete(raw.id);
				}
			}
			if (raw.kind === 'whiteboard') {
				grp.whiteboardIds.add(raw.id);
				grp.nodeIds.delete(raw.id);
			} else {
				grp.nodeIds.add(raw.id);
			}
		}
	}

	// Classify bidirectional pairs and cycle back-edges
	const nodeById = new Map(nodes.map(n => [n.id, n]));
	const reverseEdgeLookup = new Map<string, string>();
	for (const e of rawEdges) {
		reverseEdgeLookup.set(`${e.from}->${e.to}`, e.id);
	}

	// Identify cycle back-edges using tier order first, then DFS recursion stack
	const backEdgeKeys = new Set<string>();
	const adj = new Map<string, string[]>();
	for (const n of nodes) {
		adj.set(n.id, []);
	}
	for (const e of rawEdges) {
		adj.get(e.from)?.push(e.to);
	}

	// Order DFS roots: highest rank (lowest tier) first, then lowest in-degree
	const inDeg = new Map<string, number>();
	for (const n of nodes) { inDeg.set(n.id, 0); }
	for (const e of rawEdges) { inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1); }
	const sortedStarts = [...nodes].sort((a, b) => {
		const ta = a.tier ?? (a.kind === 'whiteboard' ? 999 : 50);
		const tb = b.tier ?? (b.kind === 'whiteboard' ? 999 : 50);
		if (ta !== tb) { return ta - tb; }
		return (inDeg.get(a.id) ?? 0) - (inDeg.get(b.id) ?? 0);
	});
	const color = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=visiting, 2=done
	const dfs = (u: string) => {
		color.set(u, 1);
		for (const v of adj.get(u) ?? []) {
			const c = color.get(v) ?? 0;
			if (c === 1) {
				backEdgeKeys.add(`${u}->${v}`);
			} else if (c === 0) {
				dfs(v);
			}
		}
		color.set(u, 2);
	};
	for (const n of sortedStarts) {
		if ((color.get(n.id) ?? 0) === 0) {
			dfs(n.id);
		}
	}

	const edges: IOrchestrationGraphEdge[] = rawEdges.map(e => {
		const revId = reverseEdgeLookup.get(`${e.to}->${e.from}`);
		const isBidir = Boolean(revId);
		const fromNode = nodeById.get(e.from);
		const toNode = nodeById.get(e.to);
		const pointsUpwardByTier = Boolean(
			fromNode?.tier !== undefined
			&& toNode?.tier !== undefined
			&& fromNode.tier > toNode.tier,
		);
		const isCycleBack = pointsUpwardByTier || (!isBidir && backEdgeKeys.has(e.id));
		return {
			id: e.id,
			from: e.from,
			to: e.to,
			...(e.label ? { label: e.label } : {}),
			...(e.dashed ? { dashed: true } : {}),
			...(isBidir ? { isBidirectional: true, reverseEdgeId: revId } : {}),
			...(isCycleBack ? { isCycleBackEdge: true } : {}),
		};
	});

	const departments: IOrchestrationDepartmentGroup[] = deptOrder
		.map(id => deptById.get(id)!)
		.filter(g => declaredDeptIds.has(g.id) || g.nodeIds.size > 0 || g.whiteboardIds.size > 0)
		.map(g => ({
			id: g.id,
			name: g.name,
			nodeIds: [...g.nodeIds],
			whiteboardIds: [...g.whiteboardIds],
		}));

	// Compute non-blocking orchestration choreography advisories:
	// Tokens ONLY travel along explicit directed edges; warn (never block!) if a superior connects
	// one-way to a subordinate with NO return path (direct `<-->` or cycle) back to the superior.
	const advisories: IOrchestrationTopologyAdvisory[] = [];
	const staffIds = new Set(nodes.filter(n => n.kind === 'staff').map(n => n.id));
	const staffAdj = new Map<string, string[]>();
	for (const sid of staffIds) {
		staffAdj.set(sid, []);
	}
	const incomingStaffNodes = new Set<string>();
	for (const e of edges) {
		if (staffIds.has(e.from) && staffIds.has(e.to)) {
			staffAdj.get(e.from)!.push(e.to);
			incomingStaffNodes.add(e.to);
		}
	}
	const canReachStaff = (start: string, target: string): boolean => {
		if (start === target) {
			return true;
		}
		const visited = new Set<string>([start]);
		const queue: string[] = [start];
		while (queue.length > 0) {
			const cur = queue.shift()!;
			for (const nxt of staffAdj.get(cur) ?? []) {
				if (nxt === target) {
					return true;
				}
				if (!visited.has(nxt)) {
					visited.add(nxt);
					queue.push(nxt);
				}
			}
		}
		return false;
	};
	const seenAdv = new Set<string>();
	const advisedToNodeIds = new Set<string>();
	for (const e of edges) {
		if (e.isBidirectional || !staffIds.has(e.from) || !staffIds.has(e.to)) {
			continue;
		}
		const fromNode = nodeById.get(e.from);
		const toNode = nodeById.get(e.to);
		const isDownwardHierarchy = fromNode?.tier !== undefined && toNode?.tier !== undefined && fromNode.tier < toNode.tier;
		if (isDownwardHierarchy && !canReachStaff(e.to, e.from)) {
			const key = `ow:${e.from}->${e.to}`;
			if (!seenAdv.has(key)) {
				seenAdv.add(key);
				advisedToNodeIds.add(e.to);
				advisories.push({
					code: 'ONE_WAY_HIERARCHY_EDGE',
					fromNodeId: e.from,
					toNodeId: e.to,
					message: `One-way edge ${e.from} --> ${e.to} has no return path back to ${e.from}. Use ${e.from} <--> ${e.to} (or add a return cycle) if ${e.to} needs to hand tokens back to ${e.from}.`,
				});
			}
		}
	}
	for (const n of nodes) {
		if (n.kind !== 'staff') {
			continue;
		}
		const hasIncoming = incomingStaffNodes.has(n.id);
		const hasOutgoing = (staffAdj.get(n.id)?.length ?? 0) > 0;
		if (hasIncoming && !hasOutgoing && !advisedToNodeIds.has(n.id)) {
			advisories.push({
				code: 'DEAD_END_STAFF_NODE',
				fromNodeId: n.id,
				message: `Staff node "${n.id}" has incoming edges but no outgoing edge — once it receives a token it cannot hand it off unless a return or next edge is connected.`,
			});
		}
	}

	return {
		direction,
		...(layoutMode ? { layoutMode } : {}),
		nodes,
		edges,
		departments,
		...(Object.keys(parsedPositions).length > 0 ? { positions: parsedPositions } : {}),
		...(Object.keys(whiteboardContents).length > 0 ? { whiteboardContents } : {}),
		...(advisories.length > 0 ? { advisories } : {}),
	};
}

// ============================================================================
// 100% Lossless Bijective Canonical Mermaid Serializer (Visual <-> Text Migration)
// ============================================================================

export function formatMetaValue(val: string): string {
	return /^[A-Za-z0-9_.:/-]+$/.test(val) ? val : `"${escapeMermaidQuotedLabel(val)}"`;
}

/**
 * Serializes a complete Orchestration state (topology, groups including empty groups,
 * staff + engine/model/thinking/host metadata, whiteboards + FULL lossless multiline Markdown
 * contents, layout presentation mode, and optional manual positions) into valid, portable,
 * 100% bijective Mermaid code.
 */
export function serializeOrchestrationGraph(input: IOrchestrationSerializeInput): string {
	const dir: OrchestrationDirection = input.layoutMode === 'lr'
		? 'LR'
		: input.layoutMode === 'td'
			? 'TD'
			: (input.direction ?? 'TD');
	const lines: string[] = [`flowchart ${dir}`];
	if (input.layoutMode) {
		lines.push(`  %% layout ${input.layoutMode}`);
	}

	// Build unified group catalog (preserving explicit group order & empty groups)
	interface IOrderedGroup {
		readonly id: string;
		readonly name: string;
		readonly nodeIds: string[];
		readonly whiteboardIds: string[];
	}
	const groups: IOrderedGroup[] = [];
	const groupByKey = new Map<string, IOrderedGroup>();
	const usedGroupIds = new Set<string>();
	const ensureGroup = (rawName: string, preferredId?: string): IOrderedGroup => {
		const cleanName = rawName.trim() || 'General';
		const key = cleanName.toLowerCase();
		const existing = groupByKey.get(key);
		if (existing) {
			return existing;
		}
		let id = preferredId?.trim() ? sanitizeMermaidId(preferredId.trim(), 'Dept') : sanitizeMermaidId(cleanName, 'Dept');
		if (usedGroupIds.has(id)) {
			let idx = 2;
			while (usedGroupIds.has(`${id}_${idx}`)) {
				idx++;
			}
			id = `${id}_${idx}`;
		}
		usedGroupIds.add(id);
		const grp: IOrderedGroup = { id, name: cleanName, nodeIds: [], whiteboardIds: [] };
		groups.push(grp);
		groupByKey.set(key, grp);
		return grp;
	};

	for (const d of input.departments ?? []) {
		ensureGroup(d.name, d.id);
	}

	const nodeById = new Map<string, IOrchestrationGraphNode>();
	const orderedNodes: IOrchestrationGraphNode[] = [];
	for (const n of input.nodes) {
		if (!nodeById.has(n.id)) {
			nodeById.set(n.id, n);
			orderedNodes.push(n);
		}
	}
	// Also ensure any whiteboard in `input.whiteboards` not yet in `input.nodes` is preserved losslessly (filtered by `allowedWhiteboardIds` when set)!
	if (input.whiteboards) {
		for (const [wbKey, wb] of Object.entries(input.whiteboards)) {
			const wbId = (wb.id?.trim() || wbKey).trim();
			if (input.allowedWhiteboardIds && !input.allowedWhiteboardIds.has(wbId)) {
				continue;
			}
			if (wbId && !nodeById.has(wbId)) {
				const synthetic: IOrchestrationGraphNode = {
					id: wbId,
					label: wb.title?.trim() || wbId,
					kind: 'whiteboard',
					whiteboardId: wbId,
					department: wb.department?.trim() || 'General',
					whiteboardVersion: wb.version,
					whiteboardContent: wb.content,
				};
				nodeById.set(wbId, synthetic);
				orderedNodes.push(synthetic);
			}
		}
	}

	const ungroupedNodes: IOrchestrationGraphNode[] = [];
	for (const n of orderedNodes) {
		const deptName = n.department?.trim();
		if (deptName) {
			const grp = ensureGroup(deptName);
			if (n.kind === 'whiteboard') {
				if (!grp.whiteboardIds.includes(n.id)) {
					grp.whiteboardIds.push(n.id);
				}
			} else {
				if (!grp.nodeIds.includes(n.id)) {
					grp.nodeIds.push(n.id);
				}
			}
		} else {
			ungroupedNodes.push(n);
		}
	}

	const formatStaffLines = (node: IOrchestrationGraphNode, indent: string): string[] => {
		const out: string[] = [];
		out.push(`${indent}${node.id}["${escapeMermaidQuotedLabel(node.label)}"]`);
		const rtMeta = input.staffRuntimeMeta?.[node.id];
		const metaParts: string[] = [];
		if (node.tier !== undefined) { metaParts.push(`tier=${node.tier}`); }
		if (node.rankId) { metaParts.push(`rank=${formatMetaValue(node.rankId)}`); }
		if (node.department?.trim()) { metaParts.push(`dept="${escapeMermaidQuotedLabel(node.department.trim())}"`); }
		const empName = node.employeeName?.trim();
		if (empName) { metaParts.push(`name="${escapeMermaidQuotedLabel(empName)}"`); }
		const engineId = rtMeta?.engineId ?? node.engineId;
		if (engineId) { metaParts.push(`engine=${formatMetaValue(engineId)}`); }
		const model = rtMeta?.model ?? node.model;
		if (model) { metaParts.push(`model=${formatMetaValue(model)}`); }
		const thinking = rtMeta?.thinking ?? node.thinking;
		if (thinking) { metaParts.push(`thinking=${formatMetaValue(thinking)}`); }
		const hostAlias = rtMeta?.hostAlias ?? node.hostAlias;
		if (hostAlias) { metaParts.push(`host=${formatMetaValue(hostAlias)}`); }
		const rolePrompt = rtMeta?.rolePrompt ?? node.rolePrompt;
		if (rolePrompt?.trim()) { metaParts.push(`role_prompt="${escapeMermaidQuotedLabel(rolePrompt.trim())}"`); }
		const allowedPaths = rtMeta?.allowedPaths ?? node.allowedPaths;
		if (allowedPaths && allowedPaths.length > 0) { metaParts.push(`paths="${escapeMermaidQuotedLabel(allowedPaths.join('|'))}"`); }
		const normalizedColor = normalizeAdeNodeColor(node.color);
		if (normalizedColor) { metaParts.push(`color=${formatMetaValue(normalizedColor)}`); }
		const agentId = input.includeAgentIds ? (rtMeta?.agentId ?? node.agentId) : undefined;
		if (agentId) { metaParts.push(`agent=${formatMetaValue(agentId)}`); }
		if (metaParts.length > 0) {
			out.push(`${indent}%% staff ${node.id} [${metaParts.join(', ')}]`);
		}
		const checks = rtMeta?.checks ?? node.checks;
		for (const chk of checks ?? []) {
			if (chk.enabled === false) {
				continue;
			}
			const cParts: string[] = [];
			if (chk.id) { cParts.push(`id=${formatMetaValue(chk.id)}`); }
			if (chk.name) { cParts.push(`name=${formatMetaValue(chk.name)}`); }
			if (chk.cwd) { cParts.push(`cwd=${formatMetaValue(chk.cwd)}`); }
			if (chk.hostAlias) { cParts.push(`host=${formatMetaValue(chk.hostAlias)}`); }
			if (chk.expectExitCode !== undefined) { cParts.push(`expect_exit=${chk.expectExitCode}`); }
			if (chk.expectFiles && chk.expectFiles.length > 0) { cParts.push(`expect_file="${escapeMermaidQuotedLabel(chk.expectFiles.join('|'))}"`); }
			if (chk.expectOutputMatch) { cParts.push(`match=${formatMetaValue(chk.expectOutputMatch)}`); }
			if (chk.timeoutMs !== undefined) { cParts.push(`timeout=${chk.timeoutMs}ms`); }
			if (chk.onFail) { cParts.push(`on_fail=${chk.onFail}`); }
			if (chk.maxAutoRetries !== undefined) { cParts.push(`max_retries=${chk.maxAutoRetries}`); }
			const optBlock = cParts.length > 0 ? ` [${cParts.join(', ')}]` : '';
			const cmdBlock = chk.command?.trim() ? `: ${chk.command.trim()}` : '';
			out.push(`${indent}%% staff-check ${node.id}${optBlock}${cmdBlock}`);
		}
		return out;
	};

	const resolveWhiteboardState = (node: IOrchestrationGraphNode): { readonly title: string; readonly department: string; readonly content?: string; readonly version?: number } => {
		const ext = input.whiteboards?.[node.id];
		const title = (ext?.title?.trim() || node.label || node.id).trim();
		const department = (ext?.department?.trim() || node.department?.trim() || 'General').trim();
		const content = ext ? ext.content : node.whiteboardContent;
		const version = ext?.version ?? node.whiteboardVersion;
		return { title, department, content, version };
	};

	const formatWhiteboardLines = (node: IOrchestrationGraphNode, indent: string): string[] => {
		const wb = resolveWhiteboardState(node);
		const metaParts: string[] = [
			`dept="${escapeMermaidQuotedLabel(wb.department)}"`,
			`title="${escapeMermaidQuotedLabel(wb.title)}"`,
		];
		if (wb.version !== undefined && wb.version >= 0) {
			metaParts.push(`version=${wb.version}`);
		}
		const normalizedColor = normalizeAdeNodeColor(node.color);
		if (normalizedColor) {
			metaParts.push(`color=${formatMetaValue(normalizedColor)}`);
		}
		return [
			`${indent}${node.id}[("Whiteboard: ${escapeMermaidQuotedLabel(wb.title)}")]`,
			`${indent}%% whiteboard ${node.id} [${metaParts.join(', ')}]`,
		];
	};

	for (const node of ungroupedNodes) {
		lines.push(...(node.kind === 'whiteboard' ? formatWhiteboardLines(node, '  ') : formatStaffLines(node, '  ')));
	}

	for (const grp of groups) {
		lines.push(`  subgraph ${grp.id}["${escapeMermaidQuotedLabel(grp.name)}"]`);
		for (const nid of grp.nodeIds) {
			const node = nodeById.get(nid);
			if (node) {
				lines.push(...formatStaffLines(node, '    '));
			}
		}
		for (const wid of grp.whiteboardIds) {
			const node = nodeById.get(wid);
			if (node) {
				lines.push(...formatWhiteboardLines(node, '    '));
			}
		}
		lines.push('  end');
	}

	// Emit canonical edges (folding symmetric bidirectional pairs into `<-->` / `<-.->`)
	const edgeMap = new Map<string, IOrchestrationGraphEdge>();
	for (const e of input.edges) {
		edgeMap.set(`${e.from}->${e.to}`, e);
	}
	const emittedEdges = new Set<string>();
	for (const e of input.edges) {
		const fwdKey = `${e.from}->${e.to}`;
		if (emittedEdges.has(fwdKey)) {
			continue;
		}
		const revKey = `${e.to}->${e.from}`;
		const rev = edgeMap.get(revKey);
		const isSymmetricBidir = Boolean(
			rev
			&& !emittedEdges.has(revKey)
			&& (rev.label ?? '') === (e.label ?? '')
			&& Boolean(rev.dashed) === Boolean(e.dashed),
		);
		const cleanLabel = e.label?.trim().replace(/\|/g, '/');
		if (isSymmetricBidir) {
			const op = e.dashed ? '<-.->' : '<-->';
			lines.push(cleanLabel ? `  ${e.from} ${op}|${cleanLabel}| ${e.to}` : `  ${e.from} ${op} ${e.to}`);
			emittedEdges.add(fwdKey);
			emittedEdges.add(revKey);
		} else {
			const op = e.dashed ? '-.->' : '-->';
			lines.push(cleanLabel ? `  ${e.from} ${op}|${cleanLabel}| ${e.to}` : `  ${e.from} ${op} ${e.to}`);
			emittedEdges.add(fwdKey);
		}
	}

	// Emit 100% lossless multiline whiteboard content blocks (`%% wb-body <id>` ... `%% wb-end`) unless stripped or filtered out by caller ACL
	if (!input.stripWhiteboardBodies) {
		for (const node of orderedNodes) {
			if (node.kind !== 'whiteboard') {
				continue;
			}
			const wbId = node.whiteboardId ?? node.id;
			if (input.allowedWhiteboardIds && !input.allowedWhiteboardIds.has(wbId) && !input.allowedWhiteboardIds.has(node.id)) {
				continue;
			}
			const wb = resolveWhiteboardState(node);
			if (wb.content !== undefined && (wb.content.length > 0 || (wb.version ?? 0) > 0)) {
				lines.push(`  %% wb-body ${node.id}`);
				if (wb.content.length > 0) {
					const normalizedLines = wb.content.replace(/\r\n/g, '\n').split('\n');
					for (const rawBodyLine of normalizedLines) {
						lines.push(rawBodyLine.length > 0 ? `  %% | ${rawBodyLine}` : '  %% |');
					}
				}
				lines.push('  %% wb-end');
			}
		}
	}

	// Emit optional lossless canvas positions (`%% pos <id> [x=..., y=...]`)
	if (input.positions) {
		const validIds = new Set<string>([
			...orderedNodes.map(n => n.id),
			...groups.map(g => g.id),
		]);
		for (const id of Object.keys(input.positions)) {
			if (!validIds.has(id)) {
				continue;
			}
			const p = input.positions[id];
			if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
				lines.push(`  %% pos ${id} [x=${Math.round(p.x)}, y=${Math.round(p.y)}]`);
			}
		}
	}

	return lines.join('\n');
}

export * from './adeOrchestrationMutators.js';
export * from './adeOrchestrationLayout.js';
