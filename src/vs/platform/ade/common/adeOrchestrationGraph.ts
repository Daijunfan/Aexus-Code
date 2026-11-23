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

import { IMissionEdgeObstacle, IMissionNodeCheckHook, IMissionNodePosition, MissionCheckOnFailAction } from './adeMissionDag.js';
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

function stripOuterQuotes(raw: string): string {
	const t = raw.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('\'') && t.endsWith('\''))) {
		return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
	}
	return t;
}

function extractMermaidSource(rawText: string): string {
	const trimmed = rawText.trim();
	if (/^(?:flowchart|graph)\b/i.test(trimmed) || trimmed.startsWith('%%')) {
		return trimmed;
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

function sanitizeMermaidId(raw: string, fallback: string): string {
	const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
	if (!cleaned) {
		return fallback;
	}
	return /^[A-Za-z]/.test(cleaned) ? cleaned : `${fallback}_${cleaned}`;
}

function escapeMermaidQuotedLabel(label: string): string {
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

function parseMetaBracketPairs(optStr: string): Record<string, string> {
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
	const idx = rawLine.indexOf('%%');
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
	const idx = rawLine.indexOf('%%');
	if (idx < 0) {
		return undefined;
	}
	const body = rawLine.slice(idx + 2).trim();
	const m = /^(?:group|dept|department)\s+([A-Za-z0-9_-]+)\s*(?:\[([^\]]*)\])?$/i.exec(body);
	if (!m) {
		return undefined;
	}
	const id = m[1].trim();
	const pairs = m[2] ? parseMetaBracketPairs(m[2]) : {};
	const name = (pairs.name || pairs.title || id).trim();
	return { id, name };
}

function parsePosCommentDirective(rawLine: string): { readonly id: string; readonly pos: IMissionNodePosition } | undefined {
	const idx = rawLine.indexOf('%%');
	if (idx < 0) {
		return undefined;
	}
	const body = rawLine.slice(idx + 2).trim();
	const m = /^pos\s+([A-Za-z0-9_-]+)\s*\[([^\]]*)\]$/i.exec(body);
	if (!m) {
		return undefined;
	}
	const id = m[1].trim();
	const pairs = parseMetaBracketPairs(m[2]);
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
	const idx = rawLine.indexOf('%%');
	if (idx < 0) {
		return undefined;
	}
	const body = rawLine.slice(idx + 2).trim();
	const m = /^(?:staff|employee|role)\s+([A-Za-z0-9_-]+)\s*\[([^\]]*)\]$/i.exec(body);
	if (!m) {
		return undefined;
	}
	const nodeId = m[1].trim();
	const pairs = parseMetaBracketPairs(m[2]);
	let tier: number | undefined;
	const rawTier = pairs.tier ?? pairs.level;
	if (rawTier) {
		const tMatch = /^L?(\d+)$/i.exec(rawTier.trim());
		if (tMatch) {
			const parsed = Number.parseInt(tMatch[1], 10);
			if (Number.isInteger(parsed) && parsed >= 0) {
				tier = parsed;
			}
		}
	}
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
			...(pairs.rank || pairs.rank_id ? { rankId: (pairs.rank || pairs.rank_id).trim() } : {}),
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
	const idx = rawLine.indexOf('%%');
	if (idx < 0) {
		return undefined;
	}
	const body = rawLine.slice(idx + 2).trim();
	const m = /^(?:staff-check|staff_check|check)\s+([A-Za-z0-9_-]+)(?:\s*\[([^\]]*)\])?(?:\s*:\s*(.*))?$/i.exec(body);
	if (!m) {
		return undefined;
	}
	const nodeId = m[1].trim();
	const pairs = m[2] ? parseMetaBracketPairs(m[2]) : {};
	const command = m[3]?.trim() || undefined;
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
	const idx = rawLine.indexOf('%%');
	if (idx < 0) {
		return undefined;
	}
	const body = rawLine.slice(idx + 2).trim();
	const m = /^(?:whiteboard|board|wb)\s+([A-Za-z0-9_-]+)\s*(?:\[([^\]]*)\])?$/i.exec(body);
	if (!m) {
		return undefined;
	}
	const nodeId = m[1].trim();
	const pairs = m[2] ? parseMetaBracketPairs(m[2]) : {};
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

function extractRankAndEmployeeFromLabel(rawLabel: string): {
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

	// Extract `@EmployeeName` prefix if present (e.g. `@Alice · Backend Lead` or `@Alice: API`)
	const atMatch = /^@([^\s·:：|()[\]]+(?:\s+[^\s·:：|()[\]]+)?)(?:\s*[·:：|-]\s*([\s\S]+))?$/.exec(text);
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

function parseSubgraphHeader(stmt: string): { readonly id: string; readonly name: string } | undefined {
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

/**
 * Parses cyclic free-topology Orchestration Mermaid syntax.
 * - Allows arbitrary cycles and bidirectional edges (`A <--> B`, `A --> B --> A`).
 * - Enforces STRICT employee uniqueness (rejects duplicate employee identities across nodes).
 * - Preserves `subgraph` departments and Department Shared Whiteboard nodes.
 */
export function parseOrchestrationGraph(rawText: string): IOrchestrationGraphParseResult {
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
		const noComment = rawLine.replace(/%%.*$/, '').trim();
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

			ORCH_EDGE_OP_RE.lastIndex = 0;
			const matches: { start: number; end: number; label?: string; bidirectional: boolean; dashed: boolean }[] = [];
			let m: RegExpExecArray | null;
			while ((m = ORCH_EDGE_OP_RE.exec(stmt)) !== null) {
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
			if (meta.department && !existing.department) { existing.department = meta.department; }
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
			const deptId = sanitizeMermaidId(raw.department, 'Dept');
			let grp = [...deptById.values()].find(g => g.name.toLowerCase() === raw.department!.toLowerCase());
			if (!grp) {
				grp = { id: deptId, name: raw.department, nodeIds: new Set(), whiteboardIds: new Set() };
				deptById.set(deptId, grp);
				deptOrder.push(deptId);
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
	for (const e of edges) {
		if (staffIds.has(e.from) && staffIds.has(e.to)) {
			staffAdj.get(e.from)!.push(e.to);
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
		const hasIncoming = edges.some(e => e.to === n.id && staffIds.has(e.from));
		const hasOutgoing = (staffAdj.get(n.id)?.length ?? 0) > 0;
		if (hasIncoming && !hasOutgoing && !advisories.some(a => a.toNodeId === n.id)) {
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

function formatMetaValue(val: string): string {
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
	// Also ensure any whiteboard in `input.whiteboards` not yet in `input.nodes` is preserved losslessly!
	if (input.whiteboards) {
		for (const [wbKey, wb] of Object.entries(input.whiteboards)) {
			const wbId = (wb.id?.trim() || wbKey).trim();
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

	// Emit 100% lossless multiline whiteboard content blocks (`%% wb-body <id>` ... `%% wb-end`)
	for (const node of orderedNodes) {
		if (node.kind !== 'whiteboard') {
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

// ============================================================================
// Declarative Authoring Mutators (Canvas <-> Code Live Bidirectional Sync)
// ============================================================================

export function generateNextOrchestrationNodeId(
	existingIds: Iterable<string>,
	prefix = 'E',
): string {
	const used = new Set(existingIds);
	let i = 1;
	while (used.has(`${prefix}${i}`)) {
		i++;
	}
	return `${prefix}${i}`;
}

export function addStaffNodeToOrchestration(
	rawText: string,
	options: {
		readonly id?: string;
		readonly name: string;
		readonly roleLabel?: string;
		readonly tier?: number;
		readonly rankId?: string;
		readonly department?: string;
		readonly agentId?: string;
		readonly engineId?: string;
		readonly model?: string;
		readonly thinking?: string;
		readonly hostAlias?: string;
		readonly rolePrompt?: string;
		readonly allowedPaths?: readonly string[];
		readonly checks?: readonly IMissionNodeCheckHook[];
		readonly color?: string;
		readonly direction?: OrchestrationDirection;
	},
): { readonly ok: boolean; readonly nodeId?: string; readonly orchestrationText?: string; readonly error?: string } {
	const parsed = parseOrchestrationGraph(rawText);
	if (parsed.error && rawText.trim().length > 0) {
		return { ok: false, error: parsed.error };
	}
	const cleanName = options.name.trim();
	if (!cleanName) {
		return { ok: false, error: 'Employee name is required.' };
	}
	const candidateKey = normalizeMissionEmployeeKey(cleanName);
	const dup = parsed.nodes.find(n => n.kind === 'staff' && n.employeeKey === candidateKey);
	if (dup) {
		return {
			ok: false,
			error: `Employee "${cleanName}" already exists on the Orchestration canvas (node "${dup.id}"). Each employee can appear only once.`,
		};
	}

	const existingIds = new Set(parsed.nodes.map(n => n.id));
	const nodeId = options.id?.trim()
		? sanitizeMermaidId(options.id.trim(), 'E')
		: generateNextOrchestrationNodeId(existingIds, 'E');
	if (existingIds.has(nodeId)) {
		return { ok: false, error: `Node ID "${nodeId}" already exists on the Orchestration canvas.` };
	}

	const tierSuffix = options.tier !== undefined ? ` (L${options.tier})` : '';
	const rolePart = options.roleLabel?.trim() ? ` · ${options.roleLabel.trim()}` : '';
	const label = escapeMermaidQuotedLabel(`@${cleanName}${rolePart}${tierSuffix}`);
	const declLine = `  ${nodeId}["${label}"]`;

	const metaParts: string[] = [];
	if (options.tier !== undefined) { metaParts.push(`tier=${options.tier}`); }
	if (options.rankId) { metaParts.push(`rank=${options.rankId}`); }
	if (options.department?.trim()) { metaParts.push(`dept="${escapeMermaidQuotedLabel(options.department.trim())}"`); }
	if (options.agentId) { metaParts.push(`agent=${options.agentId}`); }
	if (options.engineId?.trim()) { metaParts.push(`engine=${formatMetaValue(options.engineId.trim())}`); }
	if (options.model?.trim()) { metaParts.push(`model=${formatMetaValue(options.model.trim())}`); }
	if (options.thinking?.trim()) { metaParts.push(`thinking=${formatMetaValue(options.thinking.trim())}`); }
	if (options.hostAlias?.trim()) { metaParts.push(`host=${formatMetaValue(options.hostAlias.trim())}`); }
	if (options.rolePrompt?.trim()) { metaParts.push(`role_prompt="${escapeMermaidQuotedLabel(options.rolePrompt.trim())}"`); }
	if (options.allowedPaths && options.allowedPaths.length > 0) {
		const cleaned = options.allowedPaths.map(p => p.trim()).filter(Boolean);
		if (cleaned.length > 0) {
			metaParts.push(`paths="${escapeMermaidQuotedLabel(cleaned.join('|'))}"`);
		}
	}
	const normalizedColor = normalizeAdeNodeColor(options.color);
	if (normalizedColor) { metaParts.push(`color=${formatMetaValue(normalizedColor)}`); }
	const metaLine = metaParts.length > 0 ? `  %% staff ${nodeId} [${metaParts.join(', ')}]` : undefined;
	const checkLines: string[] = [];
	for (const chk of options.checks ?? []) {
		if (chk.enabled === false || (!chk.command?.trim() && !(chk.expectFiles && chk.expectFiles.length > 0))) {
			continue;
		}
		const cParts: string[] = [];
		if (chk.name) { cParts.push(`name=${formatMetaValue(chk.name)}`); }
		if (chk.cwd) { cParts.push(`cwd=${formatMetaValue(chk.cwd)}`); }
		if (chk.hostAlias) { cParts.push(`host=${formatMetaValue(chk.hostAlias)}`); }
		if (chk.expectFiles && chk.expectFiles.length > 0) { cParts.push(`expect_file="${escapeMermaidQuotedLabel(chk.expectFiles.join('|'))}"`); }
		if (chk.timeoutMs !== undefined) { cParts.push(`timeout=${chk.timeoutMs}ms`); }
		if (chk.onFail) { cParts.push(`on_fail=${chk.onFail}`); }
		const optBlock = cParts.length > 0 ? ` [${cParts.join(', ')}]` : '';
		const cmdBlock = chk.command?.trim() ? `: ${chk.command.trim()}` : '';
		checkLines.push(`  %% staff-check ${nodeId}${optBlock}${cmdBlock}`);
	}

	const dir = options.direction ?? parsed.direction ?? 'TD';
	const trimmed = rawText.trim();
	let nextText = trimmed || `flowchart ${dir}`;
	if (!/^(?:flowchart|graph)\s+/im.test(nextText)) {
		nextText = `flowchart ${dir}\n${nextText}`;
	}

	const insertLines = [declLine, ...(metaLine ? [metaLine] : []), ...checkLines];
	const deptName = options.department?.trim();
	if (deptName) {
		nextText = insertLinesIntoDepartmentSubgraph(nextText, deptName, insertLines);
	} else {
		nextText = `${nextText}\n${insertLines.join('\n')}`;
	}

	return { ok: true, nodeId, orchestrationText: nextText };
}

export function addWhiteboardNodeToOrchestration(
	rawText: string,
	options: {
		readonly id?: string;
		readonly title: string;
		readonly department: string;
		readonly color?: string;
		readonly direction?: OrchestrationDirection;
	},
): { readonly ok: boolean; readonly whiteboardId?: string; readonly orchestrationText?: string; readonly error?: string } {
	const parsed = parseOrchestrationGraph(rawText);
	if (parsed.error && rawText.trim().length > 0) {
		return { ok: false, error: parsed.error };
	}
	const dept = options.department.trim() || 'General';
	const title = options.title.trim() || `${dept} Whiteboard`;
	const existingIds = new Set(parsed.nodes.map(n => n.id));
	const wbId = options.id?.trim()
		? sanitizeMermaidId(options.id.trim(), 'WB')
		: generateNextOrchestrationNodeId(existingIds, 'WB');
	if (existingIds.has(wbId)) {
		return { ok: false, error: `Whiteboard ID "${wbId}" already exists on the Orchestration canvas.` };
	}

	const declLine = `  ${wbId}[("Whiteboard: ${escapeMermaidQuotedLabel(title)}")]`;
	const wbColor = normalizeAdeNodeColor(options.color);
	const wbMetaParts = [
		`dept="${escapeMermaidQuotedLabel(dept)}"`,
		`title="${escapeMermaidQuotedLabel(title)}"`,
		...(wbColor ? [`color=${formatMetaValue(wbColor)}`] : []),
	];
	const metaLine = `  %% whiteboard ${wbId} [${wbMetaParts.join(', ')}]`;

	const dir = options.direction ?? parsed.direction ?? 'TD';
	const trimmed = rawText.trim();
	let nextText = trimmed || `flowchart ${dir}`;
	if (!/^(?:flowchart|graph)\s+/im.test(nextText)) {
		nextText = `flowchart ${dir}\n${nextText}`;
	}
	nextText = insertLinesIntoDepartmentSubgraph(nextText, dept, [declLine, metaLine]);
	return { ok: true, whiteboardId: wbId, orchestrationText: nextText };
}

function insertLinesIntoDepartmentSubgraph(sourceText: string, departmentName: string, linesToInsert: readonly string[]): string {
	const lines = sourceText.split(/\r?\n/);
	const targetLower = departmentName.trim().toLowerCase();
	let inMatchingSubgraph = false;
	let depth = 0;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].replace(/%%.*$/, '').trim();
		if (/^subgraph\b/i.test(trimmed)) {
			const sub = parseSubgraphHeader(trimmed);
			if (!inMatchingSubgraph && sub && (sub.name.toLowerCase() === targetLower || sub.id.toLowerCase() === targetLower)) {
				inMatchingSubgraph = true;
				depth = 1;
				continue;
			}
			if (inMatchingSubgraph) {
				depth++;
			}
		} else if (inMatchingSubgraph && /^end$/i.test(trimmed)) {
			depth--;
			if (depth === 0) {
				const indented = linesToInsert.map(l => `  ${l}`);
				lines.splice(i, 0, ...indented);
				return lines.join('\n');
			}
		}
	}

	const deptId = sanitizeMermaidId(departmentName, 'Dept');
	const escapedDept = escapeMermaidQuotedLabel(departmentName);
	return [
		...lines,
		`  subgraph ${deptId}["${escapedDept}"]`,
		...linesToInsert.map(l => `  ${l}`),
		'  end',
	].join('\n');
}

export function connectOrchestrationEdge(
	rawText: string,
	fromId: string,
	toId: string,
	options?: { readonly label?: string; readonly bidirectional?: boolean; readonly dashed?: boolean },
): { readonly ok: boolean; readonly orchestrationText?: string; readonly error?: string } {
	const from = fromId.trim();
	const to = toId.trim();
	if (!from || !to) {
		return { ok: false, error: 'Source and target node IDs are required.' };
	}
	if (from === to) {
		return { ok: false, error: `Cannot connect "${from}" to itself.` };
	}
	const parsed = parseOrchestrationGraph(rawText);
	if (parsed.error) {
		return { ok: false, error: parsed.error };
	}
	const hasExact = parsed.edges.some(e => e.from === from && e.to === to);
	const hasReverse = parsed.edges.some(e => e.from === to && e.to === from);
	if (hasExact && (!options?.bidirectional || hasReverse)) {
		return { ok: false, error: `Edge "${from} -> ${to}" already exists.` };
	}

	const cleanLabel = options?.label?.trim();
	const op = options?.bidirectional
		? (options?.dashed ? '<-.->' : '<-->')
		: (options?.dashed ? '-.->' : '-->');
	const edgeLine = cleanLabel
		? `  ${from} ${op}|${cleanLabel.replace(/\|/g, '/')}| ${to}`
		: `  ${from} ${op} ${to}`;
	const base = rawText.trim() || `flowchart ${parsed.direction}`;
	return { ok: true, orchestrationText: `${base}\n${edgeLine}` };
}

export function removeOrchestrationEdge(rawText: string, fromId: string, toId: string): string {
	const from = fromId.trim();
	const to = toId.trim();
	if (!from || !to) {
		return rawText;
	}
	const lines = rawText.split(/\r?\n/);
	const out: string[] = [];
	const directRe = new RegExp(`^\\s*${escapeRegExp(from)}(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}))?\\s*(?:-->|-.->|==>|--->)\\s*(?:\\|[^|]*\\|)?\\s*${escapeRegExp(to)}(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}))?\\s*$`);
	const bidirForwardRe = new RegExp(`^(\\s*)${escapeRegExp(from)}(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}))?\\s*<--+>\\s*(?:\\|([^|]*)\\|)?\\s*${escapeRegExp(to)}(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}))?\\s*$`);
	const bidirReverseRe = new RegExp(`^(\\s*)${escapeRegExp(to)}(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}))?\\s*<--+>\\s*(?:\\|([^|]*)\\|)?\\s*${escapeRegExp(from)}(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}))?\\s*$`);

	for (const line of lines) {
		const trimmed = line.replace(/%%.*$/, '').trim();
		if (directRe.test(trimmed)) {
			continue;
		}
		const bf = bidirForwardRe.exec(line);
		if (bf) {
			// Downgrade bidirectional `from <--> to` to single reverse `to --> from`
			const lbl = bf[2]?.trim();
			out.push(lbl ? `${bf[1]}${to} -->|${lbl}| ${from}` : `${bf[1]}${to} --> ${from}`);
			continue;
		}
		const br = bidirReverseRe.exec(line);
		if (br) {
			// Downgrade bidirectional `to <--> from` to single `to --> from`
			const lbl = br[2]?.trim();
			out.push(lbl ? `${br[1]}${to} -->|${lbl}| ${from}` : `${br[1]}${to} --> ${from}`);
			continue;
		}
		out.push(line);
	}
	return out.join('\n');
}

export function removeOrchestrationNode(rawText: string, nodeId: string): string {
	const id = nodeId.trim();
	if (!id) {
		return rawText;
	}
	const tokenRe = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(id)}([^A-Za-z0-9_-]|$)`);
	const wbBodyStartRe = new RegExp(`^%%\\s*wb-body\\s+${escapeRegExp(id)}\\s*$`, 'i');
	const directiveRe = new RegExp(`^%%\\s*(?:staff-check|staff_check|check|staff|employee|role|whiteboard|board|wb|pos)\\s+${escapeRegExp(id)}\\b`, 'i');
	const lines = rawText.split(/\r?\n/);
	const kept: string[] = [];
	let skippingWbBody = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (skippingWbBody) {
			if (/^%%\s*wb-end\b/i.test(trimmed)) {
				skippingWbBody = false;
				continue;
			}
			if (/^%%\s*\|/.test(trimmed)) {
				continue;
			}
			skippingWbBody = false;
		}
		if (wbBodyStartRe.test(trimmed)) {
			skippingWbBody = true;
			continue;
		}
		if (directiveRe.test(trimmed)) {
			continue;
		}
		const codePart = line.replace(/%%.*$/, '').trim();
		if (codePart && !/^(?:flowchart|graph|subgraph|end)\b/i.test(codePart) && tokenRe.test(codePart)) {
			continue;
		}
		kept.push(line);
	}
	return kept.join('\n');
}

export function renameOrchestrationNode(rawText: string, nodeId: string, nextLabel: string): string {
	const id = nodeId.trim();
	const clean = escapeMermaidQuotedLabel(nextLabel);
	if (!id || !clean) {
		return rawText;
	}
	const parsed = parseOrchestrationGraph(rawText);
	const node = parsed.nodes.find(n => n.id === id);
	if (!node) {
		return rawText;
	}
	const lines = rawText.split(/\r?\n/);
	const isWb = node.kind === 'whiteboard';
	const replacementShape = isWb
		? `${id}[("Whiteboard: ${clean}")]`
		: `${id}["${clean}"]`;
	const shapeRe = new RegExp(
		`(^|[^A-Za-z0-9_-])${escapeRegExp(id)}\\s*(?:\\[\\([\\s\\S]*?\\)\\]|\\(\\[[\\s\\S]*?\\]\\)|\\(\\([\\s\\S]*?\\)\\)|\\{\\{[\\s\\S]*?\\}\\}|\\{[\\s\\S]*?\\}|\\[[\\s\\S]*?\\]|\\([\\s\\S]*?\\))`,
	);
	const staffMetaRe = new RegExp(`^(\\s*%%\\s*(?:staff|employee|role)\\s+${escapeRegExp(id)}\\s*\\[)([^\\]]*)(\\]\\s*)$`, 'i');
	const wbMetaRe = new RegExp(`^(\\s*%%\\s*(?:whiteboard|board|wb)\\s+${escapeRegExp(id)}\\s*\\[)([^\\]]*)(\\]\\s*)$`, 'i');
	const extractedName = extractRankAndEmployeeFromLabel(nextLabel).employeeName ?? clean;
	let replaced = false;
	const nextLines = lines.map(line => {
		if (isWb) {
			const wm = wbMetaRe.exec(line);
			if (wm) {
				const pairs = parseMetaBracketPairs(wm[2]);
				pairs.title = clean;
				const parts: string[] = [];
				if (pairs.dept || pairs.department) { parts.push(`dept="${escapeMermaidQuotedLabel(pairs.dept || pairs.department)}"`); }
				parts.push(`title="${clean}"`);
				if (pairs.version || pairs.v) { parts.push(`version=${pairs.version || pairs.v}`); }
				const wbColor = normalizeAdeNodeColor(pairs.color ?? pairs.accent ?? pairs.tint);
				if (wbColor) { parts.push(`color=${formatMetaValue(wbColor)}`); }
				return `${wm[1]}${parts.join(', ')}${wm[3]}`;
			}
		} else {
			const sm = staffMetaRe.exec(line);
			if (sm) {
				const pairs = parseMetaBracketPairs(sm[2]);
				if (pairs.name || pairs.employee) {
					const updatedBody = sm[2].replace(/\b(name|employee)\s*=\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^,\]]+)/i, `name="${escapeMermaidQuotedLabel(extractedName)}"`);
					return `${sm[1]}${updatedBody}${sm[3]}`;
				}
			}
		}
		if (replaced || /^\s*%%/.test(line)) {
			return line;
		}
		if (shapeRe.test(line)) {
			replaced = true;
			return line.replace(shapeRe, `$1${replacementShape}`);
		}
		return line;
	});
	if (!replaced) {
		nextLines.push(`  ${replacementShape}`);
	}
	return nextLines.join('\n');
}

/**
 * Updates or inserts `%% staff <nodeId> [...]` configuration metadata (engine, model, thinking, host,
 * rolePrompt, allowedPaths) directly inside Orchestration Mermaid code so pre-launch visual & CLI
 * configuration persists cleanly before any agent session is spawned.
 */
export function upsertOrchestrationStaffMetaInCode(
	rawText: string,
	nodeId: string,
	patch: {
		readonly engineId?: string | null;
		readonly model?: string | null;
		readonly thinking?: string | null;
		readonly hostAlias?: string | null;
		readonly rolePrompt?: string | null;
		readonly allowedPaths?: readonly string[] | null;
		readonly color?: string | null;
	},
): { readonly ok: boolean; readonly orchestrationText?: string; readonly error?: string } {
	const id = nodeId.trim();
	if (!id) {
		return { ok: false, error: 'Staff node ID is required.' };
	}
	const parsed = parseOrchestrationGraph(rawText);
	if (parsed.error) {
		return { ok: false, error: parsed.error };
	}
	const target = parsed.nodes.find(n => n.id === id && n.kind === 'staff');
	if (!target) {
		return { ok: false, error: `Staff node "${id}" not found on Orchestration canvas.` };
	}

	const nextEngine = patch.engineId === undefined ? target.engineId : (patch.engineId?.trim() || undefined);
	const nextModel = patch.model === undefined ? target.model : (patch.model?.trim() || undefined);
	const nextThinking = patch.thinking === undefined ? target.thinking : (patch.thinking?.trim() || undefined);
	const nextHost = patch.hostAlias === undefined ? target.hostAlias : (patch.hostAlias?.trim() || undefined);
	const nextRolePrompt = patch.rolePrompt === undefined ? target.rolePrompt : (patch.rolePrompt?.trim() || undefined);
	const nextAllowedPaths = patch.allowedPaths === undefined
		? target.allowedPaths
		: (patch.allowedPaths && patch.allowedPaths.length > 0
			? [...new Set(patch.allowedPaths.map(p => p.trim()).filter(Boolean))]
			: undefined);
	const nextColor = patch.color === undefined
		? normalizeAdeNodeColor(target.color)
		: normalizeAdeNodeColor(patch.color);

	const metaParts: string[] = [];
	if (target.tier !== undefined) { metaParts.push(`tier=${target.tier}`); }
	if (target.rankId) { metaParts.push(`rank=${formatMetaValue(target.rankId)}`); }
	if (target.department?.trim()) { metaParts.push(`dept="${escapeMermaidQuotedLabel(target.department.trim())}"`); }
	if (target.employeeName?.trim()) { metaParts.push(`name="${escapeMermaidQuotedLabel(target.employeeName.trim())}"`); }
	if (nextEngine) { metaParts.push(`engine=${formatMetaValue(nextEngine)}`); }
	if (nextModel) { metaParts.push(`model=${formatMetaValue(nextModel)}`); }
	if (nextThinking) { metaParts.push(`thinking=${formatMetaValue(nextThinking)}`); }
	if (nextHost) { metaParts.push(`host=${formatMetaValue(nextHost)}`); }
	if (nextRolePrompt) { metaParts.push(`role_prompt="${escapeMermaidQuotedLabel(nextRolePrompt)}"`); }
	if (nextAllowedPaths && nextAllowedPaths.length > 0) { metaParts.push(`paths="${escapeMermaidQuotedLabel(nextAllowedPaths.join('|'))}"`); }
	if (nextColor) { metaParts.push(`color=${formatMetaValue(nextColor)}`); }
	if (target.agentId) { metaParts.push(`agent=${formatMetaValue(target.agentId)}`); }

	const staffMetaRe = new RegExp(`^(\\s*)%%\\s*(?:staff|employee|role)\\s+${escapeRegExp(id)}\\s*\\[[^\\]]*\\]\\s*$`, 'i');
	const declRe = new RegExp(`^(\\s*)${escapeRegExp(id)}\\s*(?:\\[|\\(|\\{)`);
	const lines = rawText.split(/\r?\n/);
	const nextLines: string[] = [];
	let replaced = false;
	for (const line of lines) {
		const m = staffMetaRe.exec(line);
		if (m) {
			if (!replaced && metaParts.length > 0) {
				nextLines.push(`${m[1]}%% staff ${id} [${metaParts.join(', ')}]`);
				replaced = true;
			}
			continue;
		}
		nextLines.push(line);
	}
	if (!replaced && metaParts.length > 0) {
		const declIdx = nextLines.findIndex(l => !/^\s*%%/.test(l) && declRe.test(l));
		if (declIdx >= 0) {
			const indent = (/^(\s*)/.exec(nextLines[declIdx])?.[1]) ?? '  ';
			nextLines.splice(declIdx + 1, 0, `${indent}%% staff ${id} [${metaParts.join(', ')}]`);
		} else {
			nextLines.push(`  %% staff ${id} [${metaParts.join(', ')}]`);
		}
	}
	return { ok: true, orchestrationText: nextLines.join('\n') };
}

export function renameOrchestrationEdgeLabel(rawText: string, fromId: string, toId: string, nextLabel: string): string {
	const from = fromId.trim();
	const to = toId.trim();
	const clean = nextLabel.trim().replace(/\|/g, '/');
	if (!from || !to) {
		return rawText;
	}
	const edgeRe = new RegExp(
		`(^\\s*${escapeRegExp(from)}(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)))?\\s*)(<--+>|<-\\.+->|-->|-\\.+->|==>)(?:\\|[^|]*\\|)?(\\s*${escapeRegExp(to)}\\b)`,
	);
	return rawText.split(/\r?\n/).map(line => {
		if (!edgeRe.test(line)) {
			return line;
		}
		return line.replace(edgeRe, (_m, p1: string, op: string, p3: string) =>
			clean ? `${p1}${op}|${clean}|${p3}` : `${p1}${op}${p3}`);
	}).join('\n');
}

// ============================================================================
// Lossless Group, Layout, Whiteboard-Body & Position Authoring Mutators
// ============================================================================

export function addOrchestrationGroup(
	rawText: string,
	options: {
		readonly id?: string;
		readonly name: string;
		readonly direction?: OrchestrationDirection;
	},
): { readonly ok: boolean; readonly groupId?: string; readonly groupName?: string; readonly orchestrationText?: string; readonly error?: string } {
	const parsed = parseOrchestrationGraph(rawText);
	if (parsed.error && rawText.trim().length > 0) {
		return { ok: false, error: parsed.error };
	}
	const cleanName = options.name.trim();
	if (!cleanName) {
		return { ok: false, error: 'Group name is required.' };
	}
	const existingByName = parsed.departments.find(d => d.name.toLowerCase() === cleanName.toLowerCase());
	if (existingByName) {
		return { ok: false, error: `Group "${cleanName}" already exists (ID "${existingByName.id}").` };
	}
	const usedIds = new Set<string>([
		...parsed.departments.map(d => d.id),
		...parsed.nodes.map(n => n.id),
	]);
	let groupId = options.id?.trim() ? sanitizeMermaidId(options.id.trim(), 'Dept') : sanitizeMermaidId(cleanName, 'Dept');
	if (usedIds.has(groupId)) {
		if (options.id?.trim()) {
			return { ok: false, error: `Group ID "${groupId}" already exists on the Orchestration canvas.` };
		}
		let idx = 2;
		while (usedIds.has(`${groupId}_${idx}`)) {
			idx++;
		}
		groupId = `${groupId}_${idx}`;
	}
	const dir = options.direction ?? parsed.direction ?? 'TD';
	const trimmed = rawText.trim();
	let nextText = trimmed || `flowchart ${dir}`;
	if (!/^(?:flowchart|graph)\s+/im.test(nextText)) {
		nextText = `flowchart ${dir}\n${nextText}`;
	}
	nextText = `${nextText}\n  subgraph ${groupId}["${escapeMermaidQuotedLabel(cleanName)}"]\n  end`;
	return { ok: true, groupId, groupName: cleanName, orchestrationText: nextText };
}

export function renameOrchestrationGroup(
	rawText: string,
	groupIdOrName: string,
	nextName: string,
): { readonly ok: boolean; readonly groupId?: string; readonly oldName?: string; readonly newName?: string; readonly orchestrationText?: string; readonly error?: string } {
	const parsed = parseOrchestrationGraph(rawText);
	if (parsed.error) {
		return { ok: false, error: parsed.error };
	}
	const query = groupIdOrName.trim();
	const cleanNext = nextName.trim();
	if (!query || !cleanNext) {
		return { ok: false, error: 'Group identifier and new name are required.' };
	}
	const target = parsed.departments.find(d => d.id === query || d.id.toLowerCase() === query.toLowerCase() || d.name.toLowerCase() === query.toLowerCase());
	if (!target) {
		return { ok: false, error: `Group "${query}" not found.` };
	}
	const dup = parsed.departments.find(d => d.id !== target.id && d.name.toLowerCase() === cleanNext.toLowerCase());
	if (dup) {
		return { ok: false, error: `Another group named "${cleanNext}" already exists.` };
	}
	const nextDepartments: IOrchestrationDepartmentGroup[] = parsed.departments.map(d =>
		d.id === target.id ? { ...d, name: cleanNext } : d,
	);
	const memberIdSet = new Set([...target.nodeIds, ...target.whiteboardIds]);
	const nextNodes: IOrchestrationGraphNode[] = parsed.nodes.map(n => {
		const sameDept = memberIdSet.has(n.id) || (n.department && n.department.toLowerCase() === target.name.toLowerCase());
		return sameDept ? { ...n, department: cleanNext } : n;
	});
	const nextText = serializeOrchestrationGraph({
		direction: parsed.direction,
		layoutMode: parsed.layoutMode,
		nodes: nextNodes,
		edges: parsed.edges,
		departments: nextDepartments,
		positions: parsed.positions,
		includeAgentIds: true,
	});
	return { ok: true, groupId: target.id, oldName: target.name, newName: cleanNext, orchestrationText: nextText };
}

export function moveOrchestrationNodeToGroup(
	rawText: string,
	nodeId: string,
	targetGroupIdOrName: string | undefined,
): { readonly ok: boolean; readonly groupId?: string; readonly groupName?: string; readonly orchestrationText?: string; readonly error?: string } {
	const parsed = parseOrchestrationGraph(rawText);
	if (parsed.error) {
		return { ok: false, error: parsed.error };
	}
	const nid = nodeId.trim();
	const node = parsed.nodes.find(n => n.id === nid);
	if (!node) {
		return { ok: false, error: `Node "${nid}" not found in Orchestration graph.` };
	}
	const targetRaw = targetGroupIdOrName?.trim();
	let resolvedGroup: IOrchestrationDepartmentGroup | undefined;
	let nextDepartments: IOrchestrationDepartmentGroup[] = parsed.departments.map(d => ({
		...d,
		nodeIds: d.nodeIds.filter(id => id !== nid),
		whiteboardIds: d.whiteboardIds.filter(id => id !== nid),
	}));

	if (targetRaw) {
		resolvedGroup = nextDepartments.find(d =>
			d.id === targetRaw || d.id.toLowerCase() === targetRaw.toLowerCase() || d.name.toLowerCase() === targetRaw.toLowerCase(),
		);
		if (!resolvedGroup) {
			const newId = sanitizeMermaidId(targetRaw, 'Dept');
			resolvedGroup = {
				id: newId,
				name: targetRaw,
				nodeIds: node.kind === 'staff' ? [nid] : [],
				whiteboardIds: node.kind === 'whiteboard' ? [nid] : [],
			};
			nextDepartments = [...nextDepartments, resolvedGroup];
		} else {
			const grpId = resolvedGroup.id;
			nextDepartments = nextDepartments.map(d => {
				if (d.id !== grpId) {
					return d;
				}
				return node.kind === 'whiteboard'
					? { ...d, whiteboardIds: [...d.whiteboardIds, nid] }
					: { ...d, nodeIds: [...d.nodeIds, nid] };
			});
		}
	}

	const nextNodes = parsed.nodes.map(n =>
		n.id === nid ? { ...n, department: resolvedGroup?.name } : n,
	);
	const nextText = serializeOrchestrationGraph({
		direction: parsed.direction,
		layoutMode: parsed.layoutMode,
		nodes: nextNodes,
		edges: parsed.edges,
		departments: nextDepartments,
		positions: parsed.positions,
		includeAgentIds: true,
	});
	return {
		ok: true,
		groupId: resolvedGroup?.id,
		groupName: resolvedGroup?.name,
		orchestrationText: nextText,
	};
}

export function removeOrchestrationGroup(
	rawText: string,
	groupIdOrName: string,
	options?: { readonly deleteMembers?: boolean },
): { readonly ok: boolean; readonly groupId?: string; readonly removedNodeIds?: readonly string[]; readonly orchestrationText?: string; readonly error?: string } {
	const parsed = parseOrchestrationGraph(rawText);
	if (parsed.error) {
		return { ok: false, error: parsed.error };
	}
	const query = groupIdOrName.trim();
	const target = parsed.departments.find(d =>
		d.id === query || d.id.toLowerCase() === query.toLowerCase() || d.name.toLowerCase() === query.toLowerCase(),
	);
	if (!target) {
		return { ok: false, error: `Group "${query}" not found.` };
	}
	const memberIds = new Set<string>([...target.nodeIds, ...target.whiteboardIds]);
	const deleteMembers = Boolean(options?.deleteMembers);
	const nextDepartments = parsed.departments.filter(d => d.id !== target.id);
	const nextNodes = deleteMembers
		? parsed.nodes.filter(n => !memberIds.has(n.id))
		: parsed.nodes.map(n => (memberIds.has(n.id) ? { ...n, department: undefined } : n));
	const nextEdges = deleteMembers
		? parsed.edges.filter(e => !memberIds.has(e.from) && !memberIds.has(e.to))
		: parsed.edges;
	const nextPositions: Record<string, IMissionNodePosition> | undefined = parsed.positions ? { ...parsed.positions } : undefined;
	if (nextPositions) {
		delete nextPositions[target.id];
		if (deleteMembers) {
			for (const id of memberIds) {
				delete nextPositions[id];
			}
		}
	}
	const nextText = serializeOrchestrationGraph({
		direction: parsed.direction,
		layoutMode: parsed.layoutMode,
		nodes: nextNodes,
		edges: nextEdges,
		departments: nextDepartments,
		positions: nextPositions,
		includeAgentIds: true,
	});
	return {
		ok: true,
		groupId: target.id,
		removedNodeIds: deleteMembers ? [...memberIds] : [],
		orchestrationText: nextText,
	};
}

export function setOrchestrationLayoutInCode(
	rawText: string,
	layoutMode: OrchestrationLayoutMode,
	options?: { readonly clearPositions?: boolean },
): string {
	const trimmed = rawText.trim();
	const dir: OrchestrationDirection = layoutMode === 'lr' ? 'LR' : 'TD';
	if (!trimmed) {
		return `flowchart ${dir}\n  %% layout ${layoutMode}`;
	}
	const lines = rawText.split(/\r?\n/);
	const out: string[] = [];
	let insertedLayout = false;
	for (const line of lines) {
		if (/^\s*%%\s*layout\s+/i.test(line)) {
			if (!insertedLayout) {
				out.push(`  %% layout ${layoutMode}`);
				insertedLayout = true;
			}
			continue;
		}
		if (options?.clearPositions && /^\s*%%\s*pos\s+/i.test(line)) {
			continue;
		}
		out.push(line);
	}
	if (!insertedLayout) {
		const headerIdx = out.findIndex(l => /^\s*(?:flowchart|graph)\s+/i.test(l));
		if (headerIdx >= 0) {
			out.splice(headerIdx + 1, 0, `  %% layout ${layoutMode}`);
		} else {
			out.unshift(`flowchart ${dir}`, `  %% layout ${layoutMode}`);
		}
	}
	return out.join('\n');
}

export function upsertOrchestrationWhiteboardInCode(
	rawText: string,
	wb: {
		readonly id: string;
		readonly title?: string;
		readonly department?: string;
		readonly content?: string;
		readonly version?: number;
		readonly color?: string | null;
	},
): string {
	const parsed = parseOrchestrationGraph(rawText);
	if (parsed.error && rawText.trim().length > 0) {
		return rawText;
	}
	const wbId = wb.id.trim();
	if (!wbId) {
		return rawText;
	}
	const existing = parsed.nodes.find(n => n.id === wbId);
	const resolvedTitle = wb.title?.trim() || existing?.label || wbId;
	const resolvedDept = wb.department?.trim() || existing?.department || 'General';
	const resolvedContent = wb.content !== undefined ? wb.content : (existing?.whiteboardContent ?? '');
	const resolvedVersion = wb.version !== undefined ? wb.version : (existing?.whiteboardVersion ?? (resolvedContent.length > 0 ? 1 : 0));
	const resolvedColor = wb.color === undefined
		? normalizeAdeNodeColor(existing?.color)
		: normalizeAdeNodeColor(wb.color);

	const updatedNode: IOrchestrationGraphNode = {
		id: wbId,
		label: resolvedTitle,
		kind: 'whiteboard',
		whiteboardId: wbId,
		department: resolvedDept,
		whiteboardVersion: resolvedVersion,
		whiteboardContent: resolvedContent,
		...(resolvedColor ? { color: resolvedColor } : {}),
	};
	const nextNodes = existing
		? parsed.nodes.map(n => (n.id === wbId ? updatedNode : n))
		: [...parsed.nodes, updatedNode];

	return serializeOrchestrationGraph({
		direction: parsed.direction,
		layoutMode: parsed.layoutMode,
		nodes: nextNodes,
		edges: parsed.edges,
		departments: parsed.departments,
		positions: parsed.positions,
		includeAgentIds: true,
	});
}

/**
 * Sets or clears the custom accent color (`color=<preset|#hex>`) of any Orchestration node
 * (both Staff and Department Whiteboard) directly inside Orchestration Mermaid code.
 */
export function upsertOrchestrationNodeColorInCode(
	rawText: string,
	nodeId: string,
	color: string | null,
): { readonly ok: boolean; readonly orchestrationText?: string; readonly error?: string } {
	const id = nodeId.trim();
	if (!id) {
		return { ok: false, error: 'Node ID is required.' };
	}
	const parsed = parseOrchestrationGraph(rawText);
	if (parsed.error) {
		return { ok: false, error: parsed.error };
	}
	const target = parsed.nodes.find(n => n.id === id);
	if (!target) {
		return { ok: false, error: `Node "${id}" not found on Orchestration canvas.` };
	}
	if (target.kind === 'whiteboard') {
		const nextText = upsertOrchestrationWhiteboardInCode(rawText, {
			id: target.id,
			color,
		});
		return { ok: true, orchestrationText: nextText };
	}
	return upsertOrchestrationStaffMetaInCode(rawText, id, { color });
}

export function upsertOrchestrationPositionsInCode(
	rawText: string,
	positions: Readonly<Record<string, IMissionNodePosition>>,
	options?: { readonly replaceAll?: boolean },
): string {
	const parsed = parseOrchestrationGraph(rawText);
	if (parsed.error && rawText.trim().length > 0) {
		return rawText;
	}
	const merged: Record<string, IMissionNodePosition> = options?.replaceAll
		? {}
		: { ...(parsed.positions ?? {}) };
	for (const [id, pos] of Object.entries(positions)) {
		if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
			merged[id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
		}
	}
	const keptLines = rawText.split(/\r?\n/).filter(line => !/^\s*%%\s*pos\s+/i.test(line));
	for (const [id, pos] of Object.entries(merged)) {
		keptLines.push(`  %% pos ${id} [x=${pos.x}, y=${pos.y}]`);
	}
	return keptLines.join('\n');
}

export function clearOrchestrationPositionsInCode(rawText: string): string {
	return rawText.split(/\r?\n/).filter(line => !/^\s*%%\s*pos\s+/i.test(line)).join('\n');
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
		if (e.isBidirectional && e.from > e.to && (graph.nodes.find(n => n.id === e.from)?.tier ?? 0) === (graph.nodes.find(n => n.id === e.to)?.tier ?? 0)) {
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
			const node = graph.nodes.find(n => n.id === id);
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
			const node = graph.nodes.find(n => n.id === id);
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
