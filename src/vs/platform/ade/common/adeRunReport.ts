/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	formatCompactTokenCount,
	IAdeEngineeringResolvedNodeStatus,
	IAdeEngineeringTreeSnapshot,
} from './adeEngineering.js';
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
