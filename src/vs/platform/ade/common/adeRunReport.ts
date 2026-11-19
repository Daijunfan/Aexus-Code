/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	formatCompactTokenCount,
	IAdeEngineeringResolvedNodeStatus,
	IAdeEngineeringTreeSnapshot,
} from './adeEngineering.js';
import { buildOrthogonalRoundedEdgePath, IAdeOrthogonalEdgeObstacle } from './adeEngineeringBlueprint.js';
import { computeTreeFinancialSummary, formatUsdCost } from './adePricing.js';

function formatDurationMs(ms: number | undefined): string {
	if (!ms || !Number.isFinite(ms) || ms <= 0) {
		return '—';
	}
	const sec = Math.max(1, Math.round(ms / 1000));
	if (sec < 60) {
		return `${sec}s`;
	}
	const min = Math.floor(sec / 60);
	const remSec = sec % 60;
	if (min < 60) {
		return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
	}
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function statusEmoji(node: IAdeEngineeringResolvedNodeStatus): string {
	switch (node.visualStatus) {
		case 'completed':
			return '✅';
		case 'running':
			return node.runtime.phase === 'waiting_user_gate' ? '🟡' : '🔄';
		case 'failure_1':
		case 'failure_2':
			return '⚠️';
		case 'failure_3':
			return '🛑';
		default:
			return '⏳';
	}
}

function sanitizeMermaidText(text: string): string {
	return text.replace(/[\r\n]+/g, ' ').replace(/"/g, '\'').trim();
}

function sanitizeMdCell(text: string): string {
	return text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Generates a publication-grade, GitHub PR-ready Markdown Audit Report for an
 * Engineering or Research DAG run — including a live-status Mermaid topology,
 * 4-tier FinOps breakdown (tokens, USD cost, prompt cache savings), and per-node
 * verified deliverables & touched files.
 */
export function buildEngineeringRunReportMarkdown(snapshot: IAdeEngineeringTreeSnapshot): string {
	const fin = computeTreeFinancialSummary(snapshot);
	const tu = snapshot.tokenUsage;
	const modeLabel = snapshot.treeType === 'research' ? 'Research DAG' : 'Engineering DAG';
	const isoLabel = snapshot.blueprint.metadata.workspaceIsolation === 'worktree' ? 'Git Worktree Isolated' : 'Shared Workspace';

	const startedTimes = snapshot.nodes.map(n => n.runtime.startedAt).filter((t): t is number => typeof t === 'number' && t > 0);
	const endedTimes = snapshot.nodes.map(n => n.runtime.completedAt).filter((t): t is number => typeof t === 'number' && t > 0);
	const wallDurationMs = startedTimes.length > 0
		? Math.max(0, (endedTimes.length > 0 ? Math.max(...endedTimes) : snapshot.state.updatedAt) - Math.min(...startedTimes))
		: tu.total.durationMs;

	const lines: string[] = [];
	lines.push(`# Aexus Code · ${modeLabel} Verification Report`);
	lines.push('');
	lines.push(`> **Governor**: \`${snapshot.governorLabel}\` · **Project**: \`${snapshot.projectName || snapshot.projectPath}\` · **Status**: \`${snapshot.state.runStatus}\``);
	lines.push('');

	// Executive Metrics Table
	lines.push('## Execution Summary');
	lines.push('');
	lines.push('| Metric | Value |');
	lines.push('| :--- | :--- |');
	lines.push(`| **Mode / Isolation** | ${modeLabel} · ${isoLabel} |`);
	lines.push(`| **Progress** | ${snapshot.progress.completedNodes}/${snapshot.progress.totalNodes} nodes (${snapshot.progress.completedTasks}/${snapshot.progress.totalTasks} tasks · ${snapshot.blueprint.managers.length} Manager lanes) |`);
	lines.push(`| **Wall Duration** | ${formatDurationMs(wallDurationMs)} |`);
	lines.push(`| **Total Tokens** | ${tu.total.totalTokens.toLocaleString()} (${tu.total.turns} turns) |`);
	lines.push(`| **Estimated Spend** | **${formatUsdCost(fin.totalCostUsd)}**${fin.maxBudgetUsd ? ` / ${formatUsdCost(fin.maxBudgetUsd)} cap (${fin.budgetUtilizationPct ?? 0}%)` : ''} |`);
	lines.push(`| **Prompt Cache Savings** | **${formatUsdCost(fin.cacheSavingsUsd)}** (${fin.cacheHitRatePct}% cache hit · ${formatCompactTokenCount(tu.total.cacheReadTokens)} cached tok) |`);
	lines.push('');

	// Visual Mermaid DAG with Live Status Icons
	lines.push('## Verified Workflow Topology');
	lines.push('');
	lines.push('```mermaid');
	lines.push(`flowchart ${snapshot.blueprint.metadata.flowDirection ?? 'LR'}`);
	const nodeMap = new Map(snapshot.nodes.map(n => [n.node.id, n]));
	const declared = new Set<string>();
	const formatNode = (id: string): string => {
		if (declared.has(id)) {
			return id;
		}
		declared.add(id);
		const entry = nodeMap.get(id);
		if (!entry) {
			return id;
		}
		const title = sanitizeMermaidText(`${statusEmoji(entry)} ${entry.node.id}: ${entry.node.title}`);
		return entry.node.type === 'user_gate' ? `${id}{{"${title}"}}` : `${id}["${title}"]`;
	};
	if (snapshot.edges.length === 0) {
		for (const n of snapshot.nodes) {
			lines.push(`  ${formatNode(n.node.id)}`);
		}
	} else {
		for (const e of snapshot.edges) {
			lines.push(`  ${formatNode(e.edge.from)} --> ${formatNode(e.edge.to)}`);
		}
		for (const n of snapshot.nodes) {
			if (!declared.has(n.node.id)) {
				lines.push(`  ${formatNode(n.node.id)}`);
			}
		}
	}
	lines.push('```');
	lines.push('');

	// 4-Tier FinOps Breakdown
	lines.push('## 4-Tier Agent FinOps Breakdown');
	lines.push('');
	lines.push('| Organizational Tier | Turns | Input | Output | Cache Read | Total Tokens | Est. Cost |');
	lines.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: |');
	const tierRows = [
		{ name: '**Governor · L1** (Architect)', u: tu.governor, cost: fin.costByTier.governor },
		{ name: '**Manager · L2** (Segment Lead)', u: tu.manager, cost: fin.costByTier.manager },
		{ name: '**Employee · L3** (Adversarial QA)', u: tu.employee, cost: fin.costByTier.employee },
		{ name: '**Worker · L4** (Native Executor)', u: tu.worker, cost: fin.costByTier.worker },
		{ name: '**Total**', u: tu.total, cost: fin.totalCostUsd },
	];
	for (const r of tierRows) {
		lines.push(`| ${r.name} | ${r.u.turns} | ${formatCompactTokenCount(r.u.inputTokens)} | ${formatCompactTokenCount(r.u.outputTokens)} | ${formatCompactTokenCount(r.u.cacheReadTokens)} | ${r.u.totalTokens.toLocaleString()} | **${formatUsdCost(r.cost)}** |`);
	}
	lines.push('');

	// Node-by-Node Verified Deliverables
	lines.push('## Node Deliverables & Acceptance Audit');
	lines.push('');
	lines.push('| Node | Status | Engine (Worker → Reviewer) | Files | Tokens / Cost | Acceptance Summary |');
	lines.push('| :--- | :---: | :--- | ---: | ---: | :--- |');
	for (const entry of snapshot.nodes) {
		const n = entry.node;
		const rt = entry.runtime;
		const filesCount = rt.lastChanges?.touchedFiles.length ?? 0;
		const nTok = rt.tokenUsage?.total.totalTokens ?? 0;
		const nCost = fin.costByNode[n.id] ?? 0;
		const engines = n.type === 'user_gate'
			? 'Human Gate'
			: `${n.worker?.engine ?? 'claude-code'} → ${n.employee?.engine ?? 'claude-code'}`;
		const summaryRaw = entry.report?.summary
			|| (n.type === 'user_gate' ? (n.description || 'Human approval checkpoint') : (rt.lastManagerFeedback || rt.lastEmployeeFeedback || n.goal || '—'));
		const summaryShort = sanitizeMdCell(summaryRaw.length > 160 ? `${summaryRaw.slice(0, 157)}…` : summaryRaw);
		lines.push(`| \`${n.id}\` ${sanitizeMdCell(n.title)} | ${statusEmoji(entry)} \`${entry.visualStatus}\` | ${sanitizeMdCell(engines)} | ${filesCount} | ${formatCompactTokenCount(nTok)} · ${formatUsdCost(nCost)} | ${summaryShort} |`);
	}
	lines.push('');

	// Touched Files Inventory (deduplicated)
	const allTouched = new Map<string, string>();
	for (const entry of snapshot.nodes) {
		for (const f of entry.runtime.lastChanges?.touchedFiles ?? []) {
			allTouched.set(f.relativePath, f.kind);
		}
	}
	if (allTouched.size > 0) {
		lines.push('## Touched Files');
		lines.push('');
		for (const [relPath, kind] of [...allTouched.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			const badge = kind === 'added' ? 'A' : kind === 'deleted' ? 'D' : 'M';
			lines.push(`- \`[${badge}]\` \`${relPath}\``);
		}
		lines.push('');
	}

	// Active Worktree Branches (if worktree isolation used)
	const worktrees = Object.values(snapshot.state.worktrees ?? {});
	if (worktrees.length > 0) {
		lines.push('## Isolated Segment Worktrees');
		lines.push('');
		for (const wt of worktrees) {
			lines.push(`- **Segment \`${wt.segmentId}\`** → branch \`${wt.branchName}\`${wt.headCommit ? ` (\`${wt.headCommit.slice(0, 8)}\`)` : ''}`);
		}
		lines.push('');
	}

	lines.push('---');
	lines.push('_Generated by **[Aexus Code](https://github.com/Daijunfan/Aexus-Code)** · Organizational ADE & Multi-Agent Engineering Workbench_');
	lines.push('');
	return lines.join('\n');
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function truncateSvgText(value: string, maxChars: number): string {
	const cleaned = value.replace(/\s+/g, ' ').trim();
	return cleaned.length > maxChars ? `${cleaned.slice(0, Math.max(1, maxChars - 1))}…` : cleaned;
}

/**
 * Generates a self-contained, shareable dark-obsidian vector SVG snapshot of a live
 * Engineering or Research DAG (MGR L2 lanes, Armored Nested Dual-Shell Task Pods,
 * User Gate shields, Bézier edges, and 4-tier FinOps KPI header) suitable for
 * GitHub PRs, RFCs, Notion, and social sharing.
 */
export function buildEngineeringDagSvg(snapshot: IAdeEngineeringTreeSnapshot): string {
	const fin = computeTreeFinancialSummary(snapshot);
	const POD_W = 268;
	const POD_H = 148;
	const GATE_W = 192;
	const GATE_H = 82;
	const HEADER_H = 68;
	const FOOTER_H = 38;
	const PAD = 72;

	const nodeEntries = snapshot.nodes;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const entry of nodeEntries) {
		const isGate = entry.node.type === 'user_gate';
		const hw = (isGate ? GATE_W : POD_W) / 2;
		const hh = (isGate ? GATE_H : POD_H) / 2;
		const cx = entry.node.position?.x ?? 200;
		const cy = entry.node.position?.y ?? 200;
		minX = Math.min(minX, cx - hw);
		minY = Math.min(minY, cy - hh);
		maxX = Math.max(maxX, cx + hw);
		maxY = Math.max(maxY, cy + hh);
	}

	if (!Number.isFinite(minX)) {
		minX = 0;
		minY = 0;
		maxX = 640;
		maxY = 300;
	}

	const contentW = Math.max(760, Math.ceil(maxX - minX + PAD * 2));
	const contentH = Math.max(320, Math.ceil(maxY - minY + PAD * 2));
	const width = contentW;
	const height = HEADER_H + contentH + FOOTER_H;
	const ox = PAD - minX + Math.max(0, (contentW - (maxX - minX + PAD * 2)) / 2);
	const oy = HEADER_H + PAD - minY;

	const nodePos = new Map<string, { cx: number; cy: number; hw: number; hh: number; entry: IAdeEngineeringResolvedNodeStatus }>();
	for (const entry of nodeEntries) {
		const isGate = entry.node.type === 'user_gate';
		const hw = (isGate ? GATE_W : POD_W) / 2;
		const hh = (isGate ? GATE_H : POD_H) / 2;
		const cx = (entry.node.position?.x ?? 200) + ox;
		const cy = (entry.node.position?.y ?? 200) + oy;
		nodePos.set(entry.node.id, { cx, cy, hw, hh, entry });
	}

	const modeLabel = snapshot.treeType === 'research' ? 'RESEARCH DAG' : 'ENGINEERING DAG';
	const accent = snapshot.treeType === 'research' ? '#f59e0b' : '#38bdf8';
	const parts: string[] = [];
	parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif">`);
	parts.push(`<defs>`);
	parts.push(`  <pattern id="aexusGrid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="0.9" fill="rgba(148,163,184,0.16)"/></pattern>`);
	parts.push(`  <marker id="arrowIdle" viewBox="0 0 10 10" refX="8.2" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse"><path d="M 0 1.8 L 8.6 5 L 0 8.2 L 1.8 5 z" fill="#64748b"/></marker>`);
	parts.push(`  <marker id="arrowDone" viewBox="0 0 10 10" refX="8.2" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse"><path d="M 0 1.8 L 8.6 5 L 0 8.2 L 1.8 5 z" fill="#34d399"/></marker>`);
	parts.push(`</defs>`);
	parts.push(`<rect width="${width}" height="${height}" rx="14" fill="#0d1117"/>`);
	parts.push(`<rect x="0" y="${HEADER_H}" width="${width}" height="${contentH}" fill="url(#aexusGrid)"/>`);

	// Header bar
	parts.push(`<rect x="0" y="0" width="${width}" height="${HEADER_H}" fill="#111622"/>`);
	parts.push(`<line x1="0" y1="${HEADER_H}" x2="${width}" y2="${HEADER_H}" stroke="rgba(148,163,184,0.16)" stroke-width="1"/>`);
	parts.push(`<rect x="20" y="18" width="112" height="22" rx="11" fill="rgba(56,189,248,0.14)" stroke="${accent}" stroke-opacity="0.5"/>`);
	parts.push(`<text x="76" y="33" text-anchor="middle" font-size="10" font-weight="700" letter-spacing="0.6" fill="${accent}">${modeLabel}</text>`);
	parts.push(`<text x="144" y="34" font-size="15" font-weight="700" fill="#f1f5f9">${escapeXml(truncateSvgText(snapshot.governorLabel || 'Aexus DAG', 44))}</text>`);
	parts.push(`<text x="144" y="52" font-size="11" fill="#94a3b8">${escapeXml(`${snapshot.progress.completedNodes}/${snapshot.progress.totalNodes} nodes · ${snapshot.blueprint.managers.length} Manager lanes · ${snapshot.blueprint.metadata.workspaceIsolation === 'worktree' ? 'Git Worktree Isolated' : 'Shared Workspace'}`)}</text>`);

	// FinOps pill on header right
	const spendText = `${formatCompactTokenCount(snapshot.tokenUsage.total.totalTokens)} tok · ${formatUsdCost(fin.totalCostUsd)}${fin.maxBudgetUsd ? ` / ${formatUsdCost(fin.maxBudgetUsd)}` : ''}`;
	const cacheText = fin.cacheSavingsUsd > 0 ? `Cache Saved ${formatUsdCost(fin.cacheSavingsUsd)} (${fin.cacheHitRatePct}%)` : `Status: ${snapshot.state.runStatus}`;
	parts.push(`<rect x="${width - 284}" y="13" width="264" height="42" rx="10" fill="#161d2d" stroke="rgba(52,211,153,0.34)"/>`);
	parts.push(`<text x="${width - 270}" y="30" font-size="12" font-weight="700" fill="#e2e8f0">${escapeXml(spendText)}</text>`);
	parts.push(`<text x="${width - 270}" y="46" font-size="10.5" font-weight="600" fill="#34d399">${escapeXml(cacheText)}</text>`);

	// MGR L2 segment lanes
	for (const seg of snapshot.blueprint.managers) {
		let sMinX = Infinity;
		let sMinY = Infinity;
		let sMaxX = -Infinity;
		let sMaxY = -Infinity;
		for (const nid of seg.nodeIds) {
			const p = nodePos.get(nid);
			if (!p) {
				continue;
			}
			sMinX = Math.min(sMinX, p.cx - p.hw);
			sMinY = Math.min(sMinY, p.cy - p.hh);
			sMaxX = Math.max(sMaxX, p.cx + p.hw);
			sMaxY = Math.max(sMaxY, p.cy + p.hh);
		}
		if (!Number.isFinite(sMinX)) {
			continue;
		}
		const lx = sMinX - 18;
		const ly = sMinY - 30;
		const lw = (sMaxX - sMinX) + 36;
		const lh = (sMaxY - sMinY) + 46;
		const wt = snapshot.state.worktrees?.[seg.segmentId];
		const segLabel = wt
			? `MGR · L2 [${seg.segmentId}] · ${truncateSvgText(wt.branchName, 20)}`
			: `MGR · L2 [${seg.segmentId}] · ${seg.config.engine}`;
		parts.push(`<rect x="${lx}" y="${ly}" width="${lw}" height="${lh}" rx="14" fill="rgba(148,163,184,0.035)" stroke="rgba(129,140,248,0.28)" stroke-width="1"/>`);
		parts.push(`<text x="${lx + 12}" y="${ly + 18}" font-size="10" font-weight="650" fill="#a5b4fc">${escapeXml(segLabel)}</text>`);
	}

	// Strictly Orthogonal Edges with Draw.io Smooth Rounded Corners
	for (const e of snapshot.edges) {
		const from = nodePos.get(e.edge.from);
		const to = nodePos.get(e.edge.to);
		if (!from || !to) {
			continue;
		}
		const x1 = from.cx + from.hw;
		const y1 = from.cy;
		const x2 = to.cx - to.hw;
		const y2 = to.cy;
		const obstacles: IAdeOrthogonalEdgeObstacle[] = [];
		for (const [nid, np] of nodePos) {
			if (nid === e.edge.from || nid === e.edge.to) {
				continue;
			}
			obstacles.push({
				minX: np.cx - np.hw - 12,
				minY: np.cy - np.hh - 12,
				maxX: np.cx + np.hw + 12,
				maxY: np.cy + np.hh + 12,
			});
		}
		const d = buildOrthogonalRoundedEdgePath(x1, y1, x2, y2, {
			cornerRadius: 14,
			minStub: 24,
			wrapClearanceY: 112,
			obstacles,
		});
		const isDone = from.entry.visualStatus === 'completed';
		const stroke = isDone ? '#34d399' : '#64748b';
		const marker = isDone ? 'url(#arrowDone)' : 'url(#arrowIdle)';
		const dash = isDone ? '' : ' stroke-dasharray="4 4"';
		parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${isDone ? 1.8 : 1.5}" stroke-linecap="round" stroke-linejoin="round"${dash} marker-end="${marker}"/>`);
	}

	// Nodes (Armored Nested Dual-Shell Pods & User Gates)
	for (const entry of nodeEntries) {
		const p = nodePos.get(entry.node.id);
		if (!p) {
			continue;
		}
		const x = p.cx - p.hw;
		const y = p.cy - p.hh;
		const nCost = fin.costByNode[entry.node.id] ?? 0;
		const nTok = entry.runtime.tokenUsage?.total.totalTokens ?? 0;

		if (entry.node.type === 'user_gate') {
			const isWaiting = entry.runtime.phase === 'waiting_user_gate';
			const isDone = entry.visualStatus === 'completed';
			const stroke = isWaiting ? '#f59e0b' : (isDone ? '#34d399' : '#475569');
			const bg = isWaiting ? 'rgba(245,158,11,0.15)' : (isDone ? 'rgba(52,211,153,0.12)' : '#161b26');
			parts.push(`<rect x="${x}" y="${y}" width="${GATE_W}" height="${GATE_H}" rx="12" fill="${bg}" stroke="${stroke}" stroke-width="1.8"/>`);
			parts.push(`<text x="${p.cx}" y="${y + 24}" text-anchor="middle" font-size="9.5" font-weight="800" letter-spacing="0.6" fill="${stroke}">${isWaiting ? 'AWAITING APPROVAL' : (isDone ? 'GATE APPROVED' : 'USER GATE')}</text>`);
			parts.push(`<text x="${p.cx}" y="${y + 46}" text-anchor="middle" font-size="12.5" font-weight="700" fill="#f8fafc">${escapeXml(truncateSvgText(entry.node.title, 24))}</text>`);
			parts.push(`<text x="${p.cx}" y="${y + 66}" text-anchor="middle" font-size="10" fill="#94a3b8">${escapeXml(entry.node.id)}</text>`);
			continue;
		}

		const statusStroke = entry.visualStatus === 'completed'
			? '#34d399'
			: entry.visualStatus === 'running'
				? (entry.runtime.phase === 'employee_review' ? '#a78bfa' : '#38bdf8')
				: entry.visualStatus === 'failure_3'
					? '#ef4444'
					: entry.visualStatus === 'failure_1' || entry.visualStatus === 'failure_2'
						? '#f59e0b'
						: '#334155';

		// Outer EMPLOYEE L3 shell
		parts.push(`<rect x="${x}" y="${y}" width="${POD_W}" height="${POD_H}" rx="13" fill="#171b2e" stroke="${statusStroke}" stroke-width="1.7"/>`);
		parts.push(`<text x="${x + 12}" y="${y + 20}" font-size="9.5" font-weight="800" letter-spacing="0.5" fill="#c4b5fd">EMPLOYEE · L3</text>`);
		parts.push(`<text x="${x + 104}" y="${y + 20}" font-size="9.5" fill="#94a3b8">${escapeXml(truncateSvgText(entry.node.employee?.engine ?? 'claude-code', 18))}</text>`);
		parts.push(`<text x="${x + POD_W - 12}" y="${y + 20}" text-anchor="end" font-size="9.5" font-weight="700" fill="${statusStroke}">${escapeXml(entry.visualStatus.toUpperCase())}</text>`);

		// Inner recessed WORKER L4 core
		parts.push(`<rect x="${x + 10}" y="${y + 28}" width="${POD_W - 20}" height="88" rx="9" fill="#0d1119" stroke="rgba(52,211,153,0.34)" stroke-width="1.2"/>`);
		parts.push(`<text x="${x + 20}" y="${y + 46}" font-size="9" font-weight="800" letter-spacing="0.5" fill="#34d399">WORKER · L4</text>`);
		parts.push(`<text x="${x + POD_W - 20}" y="${y + 46}" text-anchor="end" font-size="9.5" font-weight="700" fill="#64748b">${escapeXml(entry.node.id)}</text>`);
		parts.push(`<text x="${x + 20}" y="${y + 72}" font-size="13" font-weight="700" fill="#f8fafc">${escapeXml(truncateSvgText(entry.node.title, 28))}</text>`);
		parts.push(`<text x="${x + 20}" y="${y + 96}" font-size="10.5" fill="#94a3b8">${escapeXml(`${entry.node.worker?.engine ?? 'claude-code'} · ${entry.node.worker?.thinking ?? 'high'}`)}</text>`);

		// Pod footer
		const touched = entry.runtime.lastChanges?.touchedFiles.length ?? 0;
		const footLeft = touched > 0 ? `${touched} file${touched === 1 ? '' : 's'}` : (entry.report ? 'Report verified' : 'Pending');
		const footRight = nTok > 0 ? `${formatCompactTokenCount(nTok)} · ${formatUsdCost(nCost)}` : '0 tok';
		parts.push(`<text x="${x + 12}" y="${y + POD_H - 12}" font-size="10" fill="#94a3b8">${escapeXml(footLeft)}</text>`);
		parts.push(`<text x="${x + POD_W - 12}" y="${y + POD_H - 12}" text-anchor="end" font-size="10" font-weight="600" fill="#cbd5e1">${escapeXml(footRight)}</text>`);
	}

	// Footer attribution bar
	parts.push(`<rect x="0" y="${height - FOOTER_H}" width="${width}" height="${FOOTER_H}" fill="#0f1420"/>`);
	parts.push(`<line x1="0" y1="${height - FOOTER_H}" x2="${width}" y2="${height - FOOTER_H}" stroke="rgba(148,163,184,0.14)" stroke-width="1"/>`);
	parts.push(`<text x="20" y="${height - 14}" font-size="11" font-weight="600" fill="#94a3b8">Aexus Code · Organizational ADE &amp; Multi-Agent Engineering Workbench</text>`);
	parts.push(`<text x="${width - 20}" y="${height - 14}" text-anchor="end" font-size="11" fill="#64748b">github.com/Daijunfan/Aexus-Code</text>`);
	parts.push(`</svg>`);
	return parts.join('\n');
}
