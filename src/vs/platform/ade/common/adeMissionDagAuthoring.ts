/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { MissionNodeRoleKind } from './adeMissionBoundary.js';
import {
	getMissionEdgeKind,
	IMissionDagEdge,
	IMissionDagNode,
	MissionDagDirection,
	MissionDagEdgeKind,
	parseMissionMermaidDag,
} from './adeMissionDag.js';
import { extractInlineEmployeeTag, stripTrailingMermaidClass } from './adeMissionEmployee.js';

export interface IMissionDagTemplate {
	readonly id: string;
	readonly title: string;
	readonly badge: string;
	readonly category: 'engineering' | 'research' | 'security' | 'starter';
	readonly description: string;
	readonly mermaidText: string;
	readonly nodePrompts: Readonly<Record<string, string>>;
	readonly reviewerNodeIds?: readonly string[];
}

/**
 * Curated 1-click classic multi-machine engineering & research Mission DAG templates
 * so new users can go from an empty canvas to a production-grade multi-agent pipeline in 1 click.
 */
export const MISSION_DAG_TEMPLATES: readonly IMissionDagTemplate[] = [
	{
		id: 'multi-gpu-research',
		title: '多机科研训练与评测流水线',
		badge: 'Multi-GPU Research',
		category: 'research',
		description: '文献与实验设计 → 并行双路 GPU 训练 + 自动基准评测（含显存 OOM 降参兜底）→ 人工方法学 Gate → 论文结论报告。',
		mermaidText: [
			'flowchart LR',
			'  R1["@PI: 文献调研与实验方案"] -->|spec| R2["@TrainA: 主实验 GPU 训练"]',
			'  R1 -->|spec| R3["@TrainB: 消融对比基线"]',
			'  R1 -->|spec| R4["@Bench: 基准评测与指标审稿"]',
			'  R2 -->|fail| F1["@Ops: 显存诊断与降参恢复"]',
			'  R2 --> U1{{"方法学人工审核 Gate"}}',
			'  R3 --> U1',
			'  R4 --> U1',
			'  F1 --> U1',
			'  U1 --> R5["@PI: 论文结论与实验报告"]',
			'  %% check R4 [name=metrics-json, expect_file=research/benchmarks/metrics.json, on_fail=bounce, max_retries=2]',
		].join('\n'),
		nodePrompts: {
			R1: '调研核心基线与失败模式，在 `research/spec.md` 中固化可证伪假设、超参矩阵与统一量化指标后交出令牌。',
			R2: '按 `research/spec.md` 在云端 GPU 节点启动主实验训练；长耗时训练请使用 `aexus-ade token block --watch-pid <pid>` 零 Token 挂起等待。',
			R3: '在相同数据切分与随机种子下完成对比基线/消融实验，输出可复现日志与 checkpoint 路径。',
			R4: '作为图内 Reviewer 运行统一评测脚本，产出 `research/benchmarks/metrics.json`；若数据泄露或统计不显著请 `token reject` 打回上游。',
			F1: '分析上游训练失败原因（OOM / NaN / 依赖异常），自动调整 batch size 或混合精度并产出一份可复现的降参兜底结果。',
			R5: '汇总 `R1`–`R4` 经人工审核通过的量化结果与图表，撰写最终论文实验章节与结论简报。',
		},
		reviewerNodeIds: ['R4'],
	},
	{
		id: 'fullstack-ship',
		title: '跨端全栈并行工程发布',
		badge: 'Full-Stack Ship',
		category: 'engineering',
		description: '接口契约先行 → 后端 / 前端 / QA 审稿三路并行 → 发布人工 Gate → 架构师联调验收发版（上下文复用）。',
		mermaidText: [
			'flowchart LR',
			'  N1["@Architect: 接口与数据契约"] -->|contract| N2["@Backend: 服务端核心实现"]',
			'  N1 -->|contract| N3["@Frontend: 前端交互画布"]',
			'  N1 -->|contract| N4["@QA: 自动化测试与审稿"]',
			'  N2 --> U1{{"发布上线人工 Gate"}}',
			'  N3 --> U1',
			'  N4 --> U1',
			'  U1 --> N5["@Architect: 全链路联调与发版"]',
		].join('\n'),
		nodePrompts: {
			N1: '定义共享 TypeScript/API 契约与文件边界，确保并行轨道 `N2` / `N3` / `N4` 零冲突开发并通过类型检查。',
			N2: '按 `N1` 契约完成核心后端服务与持久化逻辑，补齐边界单元测试。',
			N3: '按 `N1` 契约构建响应式暗色/亮色前端交互组件，确保可访问性与零布局溢出。',
			N4: '作为图内 Reviewer 编写端到端与回归测试，验证全部正向/异常路径；发现阻塞缺陷时打回对应上游节点。',
			N5: '复用架构师上下文完成跨模块联调、全量编译/Lint/单测验收并输出发布说明。',
		},
		reviewerNodeIds: ['N4'],
	},
	{
		id: 'security-audit',
		title: '并行安全审计与缺陷闭环',
		badge: 'Security Swarm',
		category: 'security',
		description: '静态扫描 + 模糊测试双路并行 → 漏洞归因分级 → 补丁修复（含异常兜底）→ 安全合入 Gate。',
		mermaidText: [
			'flowchart LR',
			'  S1["@Scanner: 静态审计与攻击面测绘"] --> S3["@Triage: 漏洞归因与风险分级"]',
			'  S2["@Fuzzer: 模糊测试与边界探测"] --> S3',
			'  S3 --> S4["@Fixer: 补丁修复与安全单测"]',
			'  S4 -->|fail| F1["@Escalation: 回滚与应急止血"]',
			'  S4 --> U1{{"安全合入审核 Gate"}}',
			'  F1 --> U1',
		].join('\n'),
		nodePrompts: {
			S1: '扫描权限校验、路径穿越、命令注入与密钥泄露风险，按严重级别输出可复现定位清单。',
			S2: '针对关键输入解析与 IPC/CLI 通道构造异常边界用例与 fuzz 负载，记录崩溃与越权现象。',
			S3: '合并去重 `S1`/`S2` 发现，按 P0/P1/P2 排序并给出最小修复方案。',
			S4: '实施最小高内聚安全补丁并补充回归单测，确保全部测试通过后交出令牌。',
			F1: '若补丁引入回归或无法自动验证，立即整理最小复现与止血建议提交人工 Gate。',
		},
		reviewerNodeIds: ['S3'],
	},
	{
		id: 'minimal-starter',
		title: '双节点最小快速起步',
		badge: 'Quick Start',
		category: 'starter',
		description: '最简洁的 2 节点任务骨架，支持右键加节点、拖线建边、双击改名快速扩展。',
		mermaidText: [
			'flowchart LR',
			'  N1["需求拆解与方案"] --> N2["实现与验收交付"]',
		].join('\n'),
		nodePrompts: {
			N1: '梳理任务目标、关键约束与验证标准，输出清晰执行方案后交出令牌。',
			N2: '按方案完成实现、运行测试验收并汇报关键变更与验证结果。',
		},
	},
];

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
		const checkMatch = /^%%\s*(?:check|verify)\s+([A-Za-z0-9_-]+)/i.exec(trimmed);
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
	const parsed = parseMissionMermaidDag(mermaidText);
	if (parsed.error) {
		return mermaidText;
	}
	const nextNodes = parsed.nodes.filter(n => n.id !== nodeId);
	if (nextNodes.length === parsed.nodes.length) {
		return mermaidText;
	}
	const nextEdges = parsed.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
	return serializePreservingDirectives(mermaidText, parsed.direction, nextNodes, nextEdges);
}
