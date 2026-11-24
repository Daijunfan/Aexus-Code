/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IMissionNodeCheckHook, IMissionNodePosition } from './adeMissionDag.js';
import { normalizeMissionEmployeeKey } from './adeMissionEmployee.js';
import { normalizeAdeNodeColor } from './adeNodeColors.js';
import {
	escapeMermaidQuotedLabel,
	extractRankAndEmployeeFromLabel,
	formatMetaValue,
	IOrchestrationDepartmentGroup,
	IOrchestrationGraphNode,
	OrchestrationDirection,
	OrchestrationLayoutMode,
	parseMetaBracketPairs,
	parseOrchestrationGraph,
	parseSubgraphHeader,
	sanitizeMermaidId,
	serializeOrchestrationGraph,
} from './adeOrchestrationGraph.js';

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
	const rawRole = options.roleLabel?.trim() ?? '';
	const rolePart = rawRole && rawRole.toLowerCase() !== cleanName.toLowerCase() ? ` · ${rawRole}` : '';
	const label = escapeMermaidQuotedLabel(`@${cleanName}${rolePart}${tierSuffix}`);
	const declLine = `  ${nodeId}["${label}"]`;

	const metaParts: string[] = [];
	if (options.tier !== undefined) { metaParts.push(`tier=${options.tier}`); }
	if (options.rankId) { metaParts.push(`rank=${options.rankId}`); }
	if (options.department?.trim()) { metaParts.push(`dept="${escapeMermaidQuotedLabel(options.department.trim())}"`); }
	metaParts.push(`name="${escapeMermaidQuotedLabel(cleanName)}"`);
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

	const validated = parseOrchestrationGraph(nextText);
	if (validated.error) {
		return { ok: false, error: validated.error };
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
	const validated = parseOrchestrationGraph(nextText);
	if (validated.error) {
		return { ok: false, error: validated.error };
	}
	return { ok: true, whiteboardId: wbId, orchestrationText: nextText };
}

function insertLinesIntoDepartmentSubgraph(sourceText: string, departmentName: string, linesToInsert: readonly string[]): string {
	const lines = sourceText.split(/\r?\n/);
	const targetLower = departmentName.trim().toLowerCase();
	let inMatchingSubgraph = false;
	let depth = 0;
	const usedIds = new Set<string>();
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].replace(/%%.*$/, '').trim();
		if (/^subgraph\b/i.test(trimmed)) {
			const sub = parseSubgraphHeader(trimmed);
			if (sub) {
				usedIds.add(sub.id);
			}
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

	let deptId = sanitizeMermaidId(departmentName, 'Dept');
	if (usedIds.has(deptId)) {
		let suffix = 2;
		while (usedIds.has(`${deptId}_${suffix}`)) {
			suffix++;
		}
		deptId = `${deptId}_${suffix}`;
	}
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
	const parsed = parseOrchestrationGraph(rawText);
	if (!parsed.error) {
		const nextEdges = parsed.edges.filter(e => !(e.from === from && e.to === to));
		if (nextEdges.length === parsed.edges.length) {
			return rawText;
		}
		return serializeOrchestrationGraph({
			direction: parsed.direction,
			layoutMode: parsed.layoutMode,
			nodes: parsed.nodes,
			edges: nextEdges,
			departments: parsed.departments,
			positions: parsed.positions,
			includeAgentIds: true,
		});
	}
	// Fallback only when rawText has syntax errors and cannot be parsed into an AST
	const lines = rawText.split(/\r?\n/);
	const out: string[] = [];
	const directRe = new RegExp(`^\\s*${escapeRegExp(from)}(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}))?\\s*(?:-->|-\\.+->|==+>|--->)\\s*(?:\\|[^|]*\\|)?\\s*${escapeRegExp(to)}(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}))?\\s*$`);
	const bidirForwardRe = new RegExp(`^(\\s*)${escapeRegExp(from)}(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}))?\\s*(<-+\\.+->|<==+>|<--+>)\\s*(?:\\|([^|]*)\\|)?\\s*${escapeRegExp(to)}(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}))?\\s*$`);
	const bidirReverseRe = new RegExp(`^(\\s*)${escapeRegExp(to)}(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}))?\\s*(<-+\\.+->|<==+>|<--+>)\\s*(?:\\|([^|]*)\\|)?\\s*${escapeRegExp(from)}(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}))?\\s*$`);
	const downgradeOp = (op: string): string => op.includes('.') ? '-.->' : op.includes('=') ? '==>' : '-->';

	for (const line of lines) {
		const trimmed = line.replace(/%%.*$/, '').trim();
		if (directRe.test(trimmed)) {
			continue;
		}
		const bf = bidirForwardRe.exec(line);
		if (bf) {
			const op = downgradeOp(bf[2]);
			const lbl = bf[3]?.trim();
			out.push(lbl ? `${bf[1]}${to} ${op}|${lbl}| ${from}` : `${bf[1]}${to} ${op} ${from}`);
			continue;
		}
		const br = bidirReverseRe.exec(line);
		if (br) {
			const op = downgradeOp(br[2]);
			const lbl = br[3]?.trim();
			out.push(lbl ? `${br[1]}${to} ${op}|${lbl}| ${from}` : `${br[1]}${to} ${op} ${from}`);
			continue;
		}
		out.push(line);
	}
	return out.join('\n');
}

function stripQuotedSegmentsForTokenMatch(code: string): string {
	let out = '';
	let inQuote: '"' | '\'' | undefined;
	for (let i = 0; i < code.length; i++) {
		const ch = code[i];
		if (inQuote) {
			if (ch === inQuote) {
				let bs = 0;
				for (let j = i - 1; j >= 0 && code[j] === '\\'; j--) { bs++; }
				if ((bs % 2) === 0) {
					inQuote = undefined;
				}
			}
			continue;
		}
		if (ch === '"' || ch === '\'') {
			inQuote = ch;
			out += ' ';
			continue;
		}
		out += ch;
	}
	return out;
}

export function removeOrchestrationNode(rawText: string, nodeId: string): string {
	const id = nodeId.trim();
	if (!id) {
		return rawText;
	}
	const parsed = parseOrchestrationGraph(rawText);
	if (!parsed.error) {
		if (!parsed.nodes.some(n => n.id === id)) {
			return rawText;
		}
		const nextNodes = parsed.nodes.filter(n => n.id !== id);
		const nextEdges = parsed.edges.filter(e => e.from !== id && e.to !== id);
		const nextDepartments: IOrchestrationDepartmentGroup[] = parsed.departments.map(d => ({
			...d,
			nodeIds: d.nodeIds.filter(nid => nid !== id),
			whiteboardIds: d.whiteboardIds.filter(wid => wid !== id),
		}));
		let nextPositions: Record<string, IMissionNodePosition> | undefined;
		if (parsed.positions) {
			nextPositions = { ...parsed.positions };
			delete nextPositions[id];
		}
		return serializeOrchestrationGraph({
			direction: parsed.direction,
			layoutMode: parsed.layoutMode,
			nodes: nextNodes,
			edges: nextEdges,
			departments: nextDepartments,
			positions: nextPositions,
			includeAgentIds: true,
		});
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
		const codePart = stripQuotedSegmentsForTokenMatch(line.replace(/%%.*$/, '')).trim();
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
	const staffMetaRe = new RegExp(`^(\\s*%%\\s*(?:staff|employee|role)\\s+${escapeRegExp(id)}\\s*\\[)(.*)(\\]\\s*)$`, 'i');
	const wbMetaRe = new RegExp(`^(\\s*%%\\s*(?:whiteboard|board|wb)\\s+${escapeRegExp(id)}\\s*\\[)(.*)(\\]\\s*)$`, 'i');
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

	const staffMetaRe = new RegExp(`^(\\s*)%%\\s*(?:staff|employee|role)\\s+${escapeRegExp(id)}\\s*\\[.*\\]\\s*$`, 'i');
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

