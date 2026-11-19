/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AdeWorkTreeType,
	AdeWorkspaceIsolationMode,
	IAdeEngineeringBlueprint,
	IAdeEngineeringBlueprintEdge,
	IAdeEngineeringBlueprintNode,
} from './adeEngineering.js';
import {
	computeAutoLayoutPositions,
	normalizeBlueprintEngine,
	partitionEngineeringManagers,
} from './adeEngineeringBlueprint.js';

export type AdeSynthesizedArchetype = 'feature' | 'bugfix' | 'security' | 'migration' | 'research';

export interface ISynthesizeBlueprintOptions {
	readonly governorSessionId: string;
	readonly defaultEngine?: string;
	readonly secondaryEngine?: string;
	readonly maxBudgetUsd?: number;
}

export interface ISynthesizedBlueprintResult {
	readonly archetype: AdeSynthesizedArchetype;
	readonly treeType: AdeWorkTreeType;
	readonly titleSummary: string;
	readonly tracks: readonly string[];
	readonly blueprint: IAdeEngineeringBlueprint;
}

export interface IPromptDagExample {
	readonly id: string;
	readonly label: string;
	readonly prompt: string;
}

export const PROMPT_DAG_EXAMPLES: readonly IPromptDagExample[] = [
	{
		id: 'oauth-ship',
		label: '⚡ OAuth2 + Migration',
		prompt: 'Build OAuth2 GitHub and Google login, migrate user schema, add E2E tests and release gate',
	},
	{
		id: 'sec-audit',
		label: '🛡 Security Audit',
		prompt: 'Audit auth token validation, SQL injection boundaries, and dependency CVEs then ship hardened patches',
	},
	{
		id: 'bench-rfc',
		label: '🔬 Benchmark RFC',
		prompt: 'Research and benchmark Redis vs Dragonfly vs Garnet latency and throughput then write architecture RFC',
	},
];

function detectArchetype(prompt: string): { archetype: AdeSynthesizedArchetype; treeType: AdeWorkTreeType } {
	const p = prompt.toLowerCase();
	if (/(research|benchmark|survey|compare|vs\.?|rfc|architecture teardown|paper|调研|对比|基准测试|评测|研究|报告)/i.test(p)) {
		return { archetype: 'research', treeType: 'research' };
	}
	if (/(security|audit|cve|vuln|owasp|pentest|injection|xss|csrf|hardening|安全|审计|漏洞|渗透)/i.test(p)) {
		return { archetype: 'security', treeType: 'engineering' };
	}
	if (/(migrat|refactor|rewrite|upgrade|cutover|zero-downtime|重构|迁移|升级)/i.test(p)) {
		return { archetype: 'migration', treeType: 'engineering' };
	}
	if (/(fix|bug|crash|leak|race|regression|incident|hotfix|debug|修复|内存泄漏|崩溃|排障|回归)/i.test(p)) {
		return { archetype: 'bugfix', treeType: 'engineering' };
	}
	return { archetype: 'feature', treeType: 'engineering' };
}

function toTitleCase(raw: string): string {
	const cleaned = raw
		.replace(/^[\s\-•*0-9.)]+/, '')
		.replace(/^(build|add|create|implement|fix|audit|research|benchmark|migrate|refactor|write|ship|then|and|with|实现|构建|新增|修复|审计|调研|重构|编写)\s+/i, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!cleaned) {
		return '';
	}
	const clipped = cleaned.length > 36 ? `${cleaned.slice(0, 35).trim()}…` : cleaned;
	return /^[a-z]/.test(clipped) ? clipped[0].toUpperCase() + clipped.slice(1) : clipped;
}

function extractParallelTracks(prompt: string, archetype: AdeSynthesizedArchetype): string[] {
	// Split on commas, Chinese commas/ideographic commas, semicolons, "then", "+", " and ", "以及/并且/并"
	const rawParts = prompt
		.split(/[,，、;；\n]+|\s+(?:then|plus|\+)\s+|\s+and\s+(?=[a-zA-Z0-9\u4e00-\u9fff])|(?:以及|并且|并|然后)/gi)
		.map(s => s.trim())
		.filter(s => s.length >= 3)
		.filter(s => !/^(?:release gate|human gate|sign-?off|gate|人工门禁|审批)$/i.test(s));

	const unique: string[] = [];
	const seen = new Set<string>();
	for (const part of rawParts) {
		const titled = toTitleCase(part);
		if (!titled || titled.length < 3) {
			continue;
		}
		const key = titled.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		unique.push(titled);
		if (unique.length >= 3) {
			break;
		}
	}

	if (unique.length >= 2) {
		return unique;
	}

	switch (archetype) {
		case 'research':
			return ['Literature & Prior Art', 'Empirical Benchmarks', 'Trade-Off Matrix'];
		case 'security':
			return ['Auth & Session Boundaries', 'Input & Injection Surface', 'Dependencies & Secrets'];
		case 'migration':
			return ['Core Module Migration', 'Call-Site Adaptation'];
		case 'bugfix':
			return ['Surgical Root-Cause Fix', 'Regression Test Harness'];
		default:
			return ['Core Backend & API', 'Interactive UI Surface', 'Automated Test Suite'];
	}
}

/**
 * Deterministically synthesizes a complete, topology-valid, MNP-partitioned
 * Engineering or Research DAG Blueprint directly from a natural-language goal prompt
 * in <5ms (zero API tokens spent).
 */
export function synthesizeBlueprintFromPrompt(
	rawPrompt: string,
	options: ISynthesizeBlueprintOptions,
): ISynthesizedBlueprintResult {
	const prompt = rawPrompt.trim();
	if (!prompt) {
		throw new Error('Describe what you want the multi-agent team to build, debug, audit, or research.');
	}

	const { archetype, treeType } = detectArchetype(prompt);
	const primary = normalizeBlueprintEngine(options.defaultEngine, 'claude-code');
	const secondary = normalizeBlueprintEngine(options.secondaryEngine, primary === 'claude-code' ? 'codex' : primary);
	const tracks = extractParallelTracks(prompt, archetype);
	const isolation: AdeWorkspaceIsolationMode = (treeType === 'engineering' && archetype !== 'bugfix') ? 'worktree' : 'shared';
	const defaultBudget = options.maxBudgetUsd ?? (archetype === 'bugfix' ? 4 : archetype === 'research' ? 5 : 6);
	const shortTopic = toTitleCase(prompt) || prompt.slice(0, 36);

	const nodes: IAdeEngineeringBlueprintNode[] = [];
	const edges: IAdeEngineeringBlueprintEdge[] = [];

	const mkTask = (
		id: string,
		title: string,
		critical: boolean,
		workerEngine: string,
		workerThinking: 'medium' | 'high',
		goal: string,
		criteria: string,
	): IAdeEngineeringBlueprintNode => ({
		id,
		title,
		type: 'task',
		critical,
		worker: { engine: workerEngine, thinking: workerThinking },
		employee: { engine: primary, thinking: critical ? 'high' : 'medium' },
		goal,
		acceptance: criteria,
	});

	// Entry node N1 (Contract / Repro / Scoping)
	const entryTitle = archetype === 'research'
		? 'Problem Framing & Rubric'
		: archetype === 'bugfix'
			? 'Deterministic Repro & Root Cause'
			: archetype === 'migration'
				? 'Baseline Characterization Tests'
				: archetype === 'security'
					? 'Threat Model & Attack Surface'
					: 'Architecture & Interface Contract';
	const entryGoal = archetype === 'research'
		? `Define clear evaluation criteria, benchmark methodology, and evidence standards for: ${prompt}`
		: archetype === 'bugfix'
			? `Create a minimal deterministic reproduction test and pinpoint the exact root cause for: ${prompt}`
			: `Freeze interfaces, module contracts, and test plan before parallel execution for: ${prompt}`;
	const entryCriteria = archetype === 'research'
		? 'Explicit rubric, baseline metrics, and verifiable source requirements documented.'
		: 'Clean contracts compile with zero circular deps and explicit verification checklist.';

	nodes.push(mkTask('N1', entryTitle, true, primary, 'high', entryGoal, entryCriteria));

	// Parallel track nodes N2..N{k+1}
	const trackIds: string[] = [];
	tracks.forEach((trackTitle, index) => {
		const id = `N${index + 2}`;
		trackIds.push(id);
		const isCrit = index === 0;
		const goal = archetype === 'research'
			? `Investigate "${trackTitle}" in depth with primary sources, reproducible numbers, and concrete failure modes for: ${prompt}`
			: `Implement and verify "${trackTitle}" strictly honoring N1 contracts for: ${prompt}`;
		const criteria = archetype === 'research'
			? 'Findings backed by concrete data points, reproducible citations, and clear trade-offs.'
			: 'Zero type/lint errors, focused minimal diff, and passing unit/integration tests.';
		nodes.push(mkTask(id, trackTitle, isCrit, secondary, isCrit ? 'high' : 'medium', goal, criteria));
		edges.push({ from: 'N1', to: id });
	});

	// Human Sign-Off Gate U1
	const gateTitle = archetype === 'research'
		? 'Evidence & Rubric Gate'
		: archetype === 'security'
			? 'Security Sign-Off Gate'
			: 'Release Readiness Gate';
	nodes.push({
		id: 'U1',
		title: gateTitle,
		type: 'user_gate',
		critical: false,
		description: `Review aggregated Employee (L3) verification reports across [${trackIds.join(', ')}] before final integration for: ${shortTopic}`,
	});
	for (const tid of trackIds) {
		edges.push({ from: tid, to: 'U1' });
	}

	// Convergence / Delivery node
	const finalId = `N${tracks.length + 2}`;
	const finalTitle = archetype === 'research'
		? 'Synthesis & Decision RFC'
		: archetype === 'security'
			? 'Hardened Patch & Verification'
			: 'Integration & Smoke Verification';
	const finalGoal = archetype === 'research'
		? `Synthesize all verified parallel findings into an executive decision RFC with ranked recommendations for: ${prompt}`
		: `Integrate all approved parallel lanes, run full build/test verification, and prepare PR audit summary for: ${prompt}`;
	const finalCriteria = archetype === 'research'
		? 'Self-contained RFC with clear recommendation, benchmark table, and open risks.'
		: 'All worktree lanes merged cleanly with 100% green build, lint, and regression tests.';
	nodes.push(mkTask(finalId, finalTitle, true, secondary, 'high', finalGoal, finalCriteria));
	edges.push({ from: 'U1', to: finalId });

	const metadata = {
		treeType,
		governorSessionId: options.governorSessionId,
		workspaceIsolation: isolation,
		watchdogTimeoutMinutes: 10,
		maxBudgetUsd: defaultBudget,
		flowDirection: 'LR' as const,
	};

	const positions = computeAutoLayoutPositions({ nodes, edges, metadata });
	const positionedNodes = nodes.map(n => ({ ...n, position: positions.get(n.id) }));
	const managers = partitionEngineeringManagers(positionedNodes, edges, [], primary);

	return {
		archetype,
		treeType,
		titleSummary: shortTopic,
		tracks,
		blueprint: {
			metadata,
			nodes: positionedNodes,
			edges,
			managers,
		},
	};
}
