/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	AdeEngineeringNodeVisualStatus,
	IAdeEngineeringBlueprint,
	IAdeEngineeringBlueprintNode,
	IAdeEngineeringNodeRuntimeState,
	IAdeEngineeringResolvedEdgeStatus,
	IAdeEngineeringResolvedNodeStatus,
	IAdeEngineeringTreeSnapshot,
	IAdeEngineeringTreeState,
	IAdeNodeRoleTokenBreakdown,
	IAdeTokenUsage,
	IAdeTreeTokenUsageSummary,
} from '../../common/adeEngineering.js';
import {
	AdeBlueprintTemplatePreset,
	buildBlueprintFromTemplate,
	getBlueprintTemplate,
	listBlueprintTemplates,
} from '../../common/adeBlueprintTemplates.js';
import {
	computeTreeFinancialSummary,
	estimateCacheSavingsUsd,
	estimateTokenUsageCostUsd,
	formatUsdCost,
	resolveModelPricing,
} from '../../common/adePricing.js';
import { synthesizeBlueprintFromPrompt } from '../../common/adePromptToDag.js';
import { buildEngineeringDagSvg, buildEngineeringRunReportMarkdown } from '../../common/adeRunReport.js';
import {
	buildOrthogonalRoundedEdgePath,
	computeAutoLayoutPositions,
	computeOrthogonalRoundedEdgeRoute,
	hasOverlappingPodPositions,
	parseEngineeringBlueprint,
	serializeEngineeringBlueprint,
} from '../../common/adeEngineeringBlueprint.js';

const TEMPLATE_PRESETS: readonly AdeBlueprintTemplatePreset[] = ['balanced', 'max-quality', 'fast-economy'];

function createUsage(overrides: Partial<IAdeTokenUsage> = {}): IAdeTokenUsage {
	const inputTokens = overrides.inputTokens ?? 0;
	const outputTokens = overrides.outputTokens ?? 0;
	const cacheReadTokens = overrides.cacheReadTokens ?? 0;
	const cacheWriteTokens = overrides.cacheWriteTokens ?? 0;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens: overrides.totalTokens ?? (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens),
		turns: overrides.turns ?? 0,
		durationMs: overrides.durationMs ?? 0,
		...(overrides.costUsd !== undefined ? { costUsd: overrides.costUsd } : {}),
		...(overrides.estimated !== undefined ? { estimated: overrides.estimated } : {}),
	};
}

function createNodeRoleUsage(overrides: Partial<IAdeNodeRoleTokenBreakdown> = {}): IAdeNodeRoleTokenBreakdown {
	const zero = createUsage();
	return { worker: zero, employee: zero, manager: zero, total: zero, ...overrides };
}

function createRuntime(overrides: Partial<IAdeEngineeringNodeRuntimeState> & { readonly nodeId: string }): IAdeEngineeringNodeRuntimeState {
	return {
		phase: 'idle',
		completed: false,
		employeeRejectCount: 0,
		formalFailureCount: 0,
		...overrides,
	};
}

function createTreeState(
	nodes: Readonly<Record<string, IAdeEngineeringNodeRuntimeState>> = {},
	overrides: Partial<IAdeEngineeringTreeState> = {},
): IAdeEngineeringTreeState {
	return {
		treeType: 'engineering',
		governorSessionId: 'gov-test',
		projectPath: '/repo',
		runStatus: 'idle',
		createdAt: 0,
		updatedAt: 0,
		managerAgentsBySegment: {},
		nodes,
		reports: {},
		events: [],
		...overrides,
	};
}

function createTreeTokenUsage(overrides: Partial<IAdeTreeTokenUsageSummary> = {}): IAdeTreeTokenUsageSummary {
	const zero = createUsage();
	return { governor: zero, manager: zero, employee: zero, worker: zero, total: zero, ...overrides };
}

function resolvedNode(
	node: IAdeEngineeringBlueprintNode,
	runtime: IAdeEngineeringNodeRuntimeState,
	visualStatus: AdeEngineeringNodeVisualStatus,
): IAdeEngineeringResolvedNodeStatus {
	return { node, runtime, visualStatus, isSegmentTail: false, upstreamReports: [] };
}

suite('AdePricing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const opusRate = { label: 'Claude Opus', inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 };
	const sonnetRate = { label: 'Claude Sonnet', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 };
	const opusConfig = { engine: 'claude-code', model: 'claude-opus-4-6', thinking: 'high' as const };
	const sonnetConfig = { engine: 'claude-code', model: 'claude-sonnet-4-6', thinking: 'high' as const };
	const codexConfig = { engine: 'codex', model: 'gpt-5-codex', thinking: 'high' as const };

	test('resolves all 8 engine default pricing tables and common engine aliases', () => {
		const engines = ['claude-code', 'codex', 'antigravity', 'dsh', 'opencode', 'kilo', 'cline', 'pi'];
		assert.deepStrictEqual(
			engines.map(engine => resolveModelPricing({ engine })),
			[
				{ label: 'Claude Code', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
				{ label: 'Codex', inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 0.25, cacheWritePerMTok: 2.5 },
				{ label: 'Antigravity', inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.31, cacheWritePerMTok: 1.25 },
				{ label: 'DeepSeek Harness', inputPerMTok: 0.55, outputPerMTok: 2.19, cacheReadPerMTok: 0.14, cacheWritePerMTok: 0.55 },
				{ label: 'OpenCode', inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 0.3, cacheWritePerMTok: 2.5 },
				{ label: 'Kilo Code', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
				{ label: 'Cline', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
				{ label: 'Pi', inputPerMTok: 1.5, outputPerMTok: 6, cacheReadPerMTok: 0.2, cacheWritePerMTok: 1.5 },
			],
		);

		assert.deepStrictEqual(
			['agy', 'deepseek', 'aexus-claude', 'kilocode', 'aexus-pi'].map(engine => resolveModelPricing({ engine }).label),
			['Antigravity', 'DeepSeek Harness', 'Claude Code', 'Kilo Code', 'Pi'],
		);
	});

	test('matches every model family and lets an explicit model win over the engine default', () => {
		const cases: readonly { readonly model: string; readonly config: { readonly engine: string; readonly model: string; readonly thinking: 'high' } }[] = [
			{ model: 'claude-opus-4-6', config: opusConfig },
			{ model: 'claude-sonnet-4-6', config: sonnetConfig },
			{ model: 'claude-haiku-4-5', config: { engine: 'claude-code', model: 'claude-haiku-4-5', thinking: 'high' } },
			{ model: 'o3', config: { engine: 'codex', model: 'o3', thinking: 'high' } },
			{ model: 'o4-mini', config: { engine: 'codex', model: 'o4-mini', thinking: 'high' } },
			{ model: 'gpt-5-codex', config: codexConfig },
			{ model: 'gemini-2.5-flash', config: { engine: 'antigravity', model: 'gemini-2.5-flash', thinking: 'high' } },
			{ model: 'gemini-2.5-pro', config: { engine: 'antigravity', model: 'gemini-2.5-pro', thinking: 'high' } },
			{ model: 'deepseek-r1', config: { engine: 'dsh', model: 'deepseek-r1', thinking: 'high' } },
			{ model: 'qwen3-coder', config: { engine: 'opencode', model: 'qwen3-coder', thinking: 'high' } },
		];
		assert.deepStrictEqual(
			cases.map(c => resolveModelPricing(c.config)),
			[
				opusRate,
				sonnetRate,
				{ label: 'Claude Haiku', inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08, cacheWritePerMTok: 1 },
				{ label: 'OpenAI Reasoning', inputPerMTok: 10, outputPerMTok: 40, cacheReadPerMTok: 2.5, cacheWritePerMTok: 10 },
				{ label: 'OpenAI Mini', inputPerMTok: 1.1, outputPerMTok: 4.4, cacheReadPerMTok: 0.275, cacheWritePerMTok: 1.1 },
				{ label: 'OpenAI Codex', inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 0.25, cacheWritePerMTok: 2.5 },
				{ label: 'Gemini Flash', inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0.3 },
				{ label: 'Gemini Pro', inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.31, cacheWritePerMTok: 1.25 },
				{ label: 'DeepSeek Reasoner', inputPerMTok: 0.55, outputPerMTok: 2.19, cacheReadPerMTok: 0.14, cacheWritePerMTok: 0.55 },
				{ label: 'Qwen Coder', inputPerMTok: 0.4, outputPerMTok: 1.2, cacheReadPerMTok: 0.1, cacheWritePerMTok: 0.4 },
			],
		);

		// Model family beats engine default; whitespace is trimmed; unknown model+engine falls back.
		assert.deepStrictEqual(
			[
				resolveModelPricing({ engine: 'claude-code', model: '  gpt-5-codex  ' }).label,
				resolveModelPricing({ engine: 'dsh', model: 'qwen3-coder' }).label,
				resolveModelPricing({ engine: 'unknown-engine', model: 'unknown-model' }).label,
				resolveModelPricing(undefined).label,
			],
			['OpenAI Codex', 'Qwen Coder', 'Standard LLM', 'Standard LLM'],
		);
	});

	test('estimates token usage cost honoring explicit costUsd, structured tokens, and the totalTokens fallback split', () => {
		assert.deepStrictEqual(
			[
				estimateTokenUsageCostUsd(undefined, opusConfig),
				estimateTokenUsageCostUsd(createUsage({ totalTokens: 0, costUsd: 0.1234567 }), opusConfig),
				estimateTokenUsageCostUsd(createUsage({ inputTokens: 1_000_000, totalTokens: 1_000_000, costUsd: 0.5 }), opusConfig),
				estimateTokenUsageCostUsd(createUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }), opusConfig),
				estimateTokenUsageCostUsd(createUsage({ inputTokens: 2_000_000 }), sonnetConfig),
				estimateTokenUsageCostUsd(createUsage({ totalTokens: 1_000_000 }), codexConfig),
				// Structured tokens without a positive totalTokens are intentionally not billed.
				estimateTokenUsageCostUsd(createUsage({ inputTokens: 1_000_000, totalTokens: 0 }), opusConfig),
				// Non-positive / non-finite explicit costs fall through to estimation.
				estimateTokenUsageCostUsd(createUsage({ totalTokens: 1_000_000, costUsd: -1 }), sonnetConfig),
				estimateTokenUsageCostUsd(createUsage({ totalTokens: 1_000_000, costUsd: Number.POSITIVE_INFINITY }), sonnetConfig),
			],
			[0, 0.123457, 0.5, 110.25, 6, 4.375, 0, 6, 6],
		);
	});

	test('estimates prompt cache savings from the uncached input-rate delta', () => {
		assert.deepStrictEqual(
			[
				estimateCacheSavingsUsd(undefined, opusConfig),
				estimateCacheSavingsUsd(createUsage({ cacheReadTokens: 0 }), opusConfig),
				estimateCacheSavingsUsd(createUsage({ cacheReadTokens: 1_000_000 }), opusConfig),
				estimateCacheSavingsUsd(createUsage({ cacheReadTokens: 1_000_000 }), codexConfig),
				estimateCacheSavingsUsd(createUsage({ cacheReadTokens: 1_000_000 }), { engine: 'dsh', model: 'deepseek-r1' }),
			],
			[0, 0, 13.5, 2.25, 0.41],
		);
	});

	test('formats USD costs across zero, sub-cent, dollars, and large-cap boundaries', () => {
		assert.deepStrictEqual(
			[0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.005, 0.01, 1.234, 12.5, 99.99, 100, 1234.56].map(formatUsdCost),
			['$0.00', '$0.00', '$0.00', '$0.00', '$0.005', '$0.01', '$1.23', '$12.50', '$99.99', '$100.0', '$1234.6'],
		);
	});

	const financeWorker = { engine: 'codex', model: 'gpt-5-codex', thinking: 'high' as const };
	const financeEmployee = { engine: 'claude-code', model: 'claude-sonnet-4-6', thinking: 'medium' as const };
	const financeManager = { engine: 'claude-code', model: 'claude-sonnet-4-6', thinking: 'high' as const };

	function createFinanceBlueprint(maxBudgetUsd?: number): IAdeEngineeringBlueprint {
		return {
			metadata: {
				treeType: 'engineering',
				governorSessionId: 'gov-fin',
				workspaceIsolation: 'worktree',
				watchdogTimeoutMinutes: 10,
				flowDirection: 'LR',
				...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
			},
			managers: [
				{ segmentId: 'N1', nodeIds: ['N1'], config: financeManager },
				{ segmentId: 'N2', nodeIds: ['N2'], config: financeManager },
			],
			nodes: [
				{ id: 'N1', title: 'One', type: 'task', critical: true, worker: financeWorker, employee: financeEmployee, goal: '', acceptance: '' },
				{ id: 'N2', title: 'Two', type: 'task', critical: false, worker: financeWorker, employee: financeEmployee, goal: '', acceptance: '' },
			],
			edges: [],
		};
	}

	const financeNodeUsage: Readonly<Record<string, IAdeNodeRoleTokenBreakdown>> = {
		N1: createNodeRoleUsage({
			worker: createUsage({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000 }),
			employee: createUsage({ inputTokens: 1_000_000 }),
			manager: createUsage({ inputTokens: 1_000_000 }),
			total: createUsage({ inputTokens: 3_000_000, cacheReadTokens: 1_000_000 }),
		}),
		N2: createNodeRoleUsage({
			worker: createUsage({ inputTokens: 2_000_000 }),
			total: createUsage({ inputTokens: 2_000_000 }),
		}),
	};

	function createFinanceInput(maxBudgetUsd?: number, explicitTotalCostUsd?: number): Pick<IAdeEngineeringTreeSnapshot, 'blueprint' | 'state' | 'tokenUsage'> {
		return {
			blueprint: createFinanceBlueprint(maxBudgetUsd),
			state: createTreeState({
				N1: createRuntime({ nodeId: 'N1', phase: 'completed', completed: true, tokenUsage: financeNodeUsage.N1 }),
				N2: createRuntime({ nodeId: 'N2', phase: 'worker_running', tokenUsage: financeNodeUsage.N2 }),
			}),
			tokenUsage: createTreeTokenUsage({
				governor: createUsage({ inputTokens: 1_000_000 }),
				total: createUsage({
					inputTokens: 9_000_000,
					cacheReadTokens: 1_000_000,
					costUsd: explicitTotalCostUsd,
				}),
			}),
		};
	}

	test('computes 4-tier, per-node, per-segment, cache, and unbudgeted tree financial summaries', () => {
		assert.deepStrictEqual(computeTreeFinancialSummary(createFinanceInput()), {
			totalCostUsd: 16.75,
			cacheSavingsUsd: 2.25,
			cacheHitRatePct: 10,
			costByTier: { governor: 3, manager: 3, employee: 3, worker: 7.75 },
			costByNode: { N1: 8.75, N2: 5 },
			costBySegment: { N1: 8.75, N2: 5 },
			budgetStatus: 'none',
		});
	});

	test('classifies budget status as ok, warn, and exceeded at the expected utilization thresholds', () => {
		const summarize = (cap: number) => {
			const summary = computeTreeFinancialSummary(createFinanceInput(cap));
			return { maxBudgetUsd: summary.maxBudgetUsd, budgetUtilizationPct: summary.budgetUtilizationPct, budgetStatus: summary.budgetStatus };
		};
		assert.deepStrictEqual(
			[summarize(40), summarize(20), summarize(16.75)],
			[
				{ maxBudgetUsd: 40, budgetUtilizationPct: 42, budgetStatus: 'ok' },
				{ maxBudgetUsd: 20, budgetUtilizationPct: 84, budgetStatus: 'warn' },
				{ maxBudgetUsd: 16.75, budgetUtilizationPct: 100, budgetStatus: 'exceeded' },
			],
		);
	});

	test('lets an explicitly reported total cost dominate the estimated tier sum', () => {
		const summary = computeTreeFinancialSummary(createFinanceInput(20, 25));
		assert.deepStrictEqual(
			{
				totalCostUsd: summary.totalCostUsd,
				tierSum: summary.costByTier.governor + summary.costByTier.manager + summary.costByTier.employee + summary.costByTier.worker,
				budgetUtilizationPct: summary.budgetUtilizationPct,
				budgetStatus: summary.budgetStatus,
			},
			{ totalCostUsd: 25, tierSum: 16.75, budgetUtilizationPct: 125, budgetStatus: 'exceeded' },
		);
	});

	test('matches gpt-5-pro before generic gpt-5, supports customPricing overrides, and supports zero-dollar subscriptionMode (P1-13)', () => {
		const gpt5Pro = resolveModelPricing({ engine: 'codex', model: 'gpt-5-pro' });
		const gpt5Std = resolveModelPricing({ engine: 'codex', model: 'gpt-5' });
		assert.strictEqual(gpt5Pro.label, 'OpenAI GPT-5 Pro');
		assert.strictEqual(gpt5Pro.inputPerMTok, 15);
		assert.strictEqual(gpt5Pro.outputPerMTok, 120);
		assert.strictEqual(gpt5Std.label, 'OpenAI Codex');
		assert.strictEqual(gpt5Std.inputPerMTok, 2.5);

		// Custom pricing override map merges partial or full overrides cleanly
		const customOptions = {
			customPricing: {
				'claude-opus-4-6': { label: 'Enterprise Opus Discount', inputPerMTok: 10, outputPerMTok: 50 },
			},
		};
		const overridden = resolveModelPricing({ engine: 'claude-code', model: 'claude-opus-4-6' }, customOptions);
		assert.strictEqual(overridden.label, 'Enterprise Opus Discount');
		assert.strictEqual(overridden.inputPerMTok, 10);
		assert.strictEqual(overridden.outputPerMTok, 50);
		assert.strictEqual(
			estimateTokenUsageCostUsd(createUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), { engine: 'claude-code', model: 'claude-opus-4-6' }, customOptions),
			60,
		);

		// Subscription mode reports $0.00 marginal spend while keeping token usage intact
		const subSummary = computeTreeFinancialSummary(createFinanceInput(20, 25), { subscriptionMode: true });
		assert.strictEqual(subSummary.subscriptionMode, true);
		assert.strictEqual(subSummary.totalCostUsd, 0);
		assert.strictEqual(subSummary.costByTier.worker, 0);
		assert.strictEqual(subSummary.costByTier.employee, 0);
		assert.strictEqual(subSummary.budgetStatus, 'ok');
		assert.strictEqual(
			estimateTokenUsageCostUsd(createUsage({ inputTokens: 1_000_000, outputTokens: 500_000, costUsd: 12.5 }), opusConfig, { subscriptionMode: true }),
			0,
		);
	});
});

suite('AdeBlueprintTemplates', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists all 6 templates with engineering and research filters', () => {
		assert.deepStrictEqual(
			listBlueprintTemplates().map(t => ({ id: t.id, treeType: t.treeType, nodeCount: t.nodeCount, previewNodes: t.previewNodes.length, previewEdges: t.previewEdges.length })),
			[
				{ id: 'feature-ship', treeType: 'engineering', nodeCount: 6, previewNodes: 6, previewEdges: 7 },
				{ id: 'bug-hunt-fix', treeType: 'engineering', nodeCount: 5, previewNodes: 5, previewEdges: 5 },
				{ id: 'security-audit-swarm', treeType: 'engineering', nodeCount: 6, previewNodes: 6, previewEdges: 5 },
				{ id: 'safe-migration', treeType: 'engineering', nodeCount: 5, previewNodes: 5, previewEdges: 5 },
				{ id: 'deep-research-lab', treeType: 'research', nodeCount: 6, previewNodes: 6, previewEdges: 7 },
				{ id: 'arch-teardown', treeType: 'research', nodeCount: 5, previewNodes: 5, previewEdges: 5 },
			],
		);
		assert.deepStrictEqual(
			{
				engineering: listBlueprintTemplates('engineering').map(t => t.id),
				research: listBlueprintTemplates('research').map(t => t.id),
			},
			{
				engineering: ['feature-ship', 'bug-hunt-fix', 'security-audit-swarm', 'safe-migration'],
				research: ['deep-research-lab', 'arch-teardown'],
			},
		);
		// Summaries must never leak the internal node/edge definitions.
		const summaryKeys = ['category', 'highlights', 'id', 'name', 'nodeCount', 'parallelBranches', 'previewEdges', 'previewNodes', 'recommendedBudgetUsd', 'recommendedIsolation', 'tagline', 'treeType'];
		assert.deepStrictEqual(listBlueprintTemplates().map(t => Object.keys(t).sort()), listBlueprintTemplates().map(() => summaryKeys));
	});

	test('gets templates by id and returns undefined for unknown ids', () => {
		const all = listBlueprintTemplates();
		assert.deepStrictEqual(
			all.map(t => getBlueprintTemplate(t.id)),
			all,
		);
		assert.strictEqual(getBlueprintTemplate('does-not-exist'), undefined);
	});

	for (const summary of listBlueprintTemplates()) {
		test(`builds and round-trips "${summary.id}" across all 3 presets without overlapping pods`, () => {
			for (const preset of TEMPLATE_PRESETS) {
				const built = buildBlueprintFromTemplate(summary.id, {
					governorSessionId: `gov-${summary.id}`,
					preset,
					defaultEngine: 'codex',
					secondaryEngine: 'claude-code',
				});
				const parsed = parseEngineeringBlueprint(serializeEngineeringBlueprint(built));

				assert.strictEqual(built.nodes.length, summary.nodeCount, `${summary.id}/${preset} node count`);
				assert.ok(typeof built.metadata.maxConcurrency === 'number' && built.metadata.maxConcurrency >= 1, `${summary.id} declares maxConcurrency`);
				assert.ok(typeof built.metadata.verify === 'string' && built.metadata.verify.length > 0, `${summary.id} declares metadata verify`);
				for (const taskNode of built.nodes.filter(n => n.type === 'task')) {
					assert.ok(Array.isArray(taskNode.files) && taskNode.files.length > 0, `${summary.id}/${taskNode.id} declares concrete files scope`);
					assert.ok(typeof taskNode.verify === 'string' && taskNode.verify.length > 0, `${summary.id}/${taskNode.id} declares concrete verify command`);
				}
				assert.deepStrictEqual(canonicalBlueprint(parsed), canonicalBlueprint(built), `${summary.id}/${preset} round-trip`);
				assert.strictEqual(hasOverlappingPodPositions(built.nodes), false, `${summary.id}/${preset} built layout overlaps`);
				assert.strictEqual(hasOverlappingPodPositions(parsed.nodes), false, `${summary.id}/${preset} parsed layout overlaps`);
			}
		});
	}

	test('applies preset thinking/engine policies consistently', () => {
		const summarize = (preset: AdeBlueprintTemplatePreset) => {
			const bp = buildBlueprintFromTemplate('feature-ship', {
				governorSessionId: 'gov-preset',
				preset,
				defaultEngine: 'claude-code',
				secondaryEngine: 'codex',
			});
			const node = (id: string) => bp.nodes.find(n => n.id === id)!;
			return {
				preset,
				criticalWorker: node('N1').worker,
				nonCriticalWorker: node('N3').worker,
				employee: node('N3').employee,
				manager: bp.managers[0].config,
				maxBudgetUsd: bp.metadata.maxBudgetUsd,
			};
		};
		assert.deepStrictEqual(TEMPLATE_PRESETS.map(summarize), [
			{
				preset: 'balanced',
				criticalWorker: { engine: 'claude-code', thinking: 'high' },
				nonCriticalWorker: { engine: 'codex', thinking: 'medium' },
				employee: { engine: 'claude-code', thinking: 'medium' },
				manager: { engine: 'claude-code', thinking: 'medium' },
				maxBudgetUsd: 8,
			},
			{
				preset: 'max-quality',
				criticalWorker: { engine: 'claude-code', thinking: 'max' },
				nonCriticalWorker: { engine: 'claude-code', thinking: 'high' },
				employee: { engine: 'claude-code', thinking: 'high' },
				manager: { engine: 'claude-code', thinking: 'high' },
				maxBudgetUsd: 8,
			},
			{
				preset: 'fast-economy',
				criticalWorker: { engine: 'claude-code', thinking: 'medium' },
				nonCriticalWorker: { engine: 'claude-code', thinking: 'low' },
				employee: { engine: 'claude-code', thinking: 'low' },
				manager: { engine: 'claude-code', thinking: 'low' },
				maxBudgetUsd: 2,
			},
		]);
	});

	test('honors budget and workspace isolation overrides and keeps them across serialization', () => {
		const built = buildBlueprintFromTemplate('feature-ship', {
			governorSessionId: 'gov-override',
			maxBudgetUsd: 12.5,
			workspaceIsolation: 'shared',
			treeType: 'research',
			defaultEngine: 'agy',
		});
		const parsed = parseEngineeringBlueprint(serializeEngineeringBlueprint(built));
		assert.deepStrictEqual(
			{
				built: { maxBudgetUsd: built.metadata.maxBudgetUsd, workspaceIsolation: built.metadata.workspaceIsolation, treeType: built.metadata.treeType },
				parsed: { maxBudgetUsd: parsed.metadata.maxBudgetUsd, workspaceIsolation: parsed.metadata.workspaceIsolation, treeType: parsed.metadata.treeType },
				engine: built.nodes.find(n => n.id === 'N1')!.worker?.engine,
			},
			{
				built: { maxBudgetUsd: 12.5, workspaceIsolation: 'shared', treeType: 'research' },
				parsed: { maxBudgetUsd: 12.5, workspaceIsolation: 'shared', treeType: 'research' },
				engine: 'antigravity',
			},
		);

		// A non-positive explicit cap disables the budget entirely, even for fast-economy.
		assert.strictEqual(
			buildBlueprintFromTemplate('feature-ship', { governorSessionId: 'gov-zero', preset: 'fast-economy', maxBudgetUsd: 0 }).metadata.maxBudgetUsd,
			undefined,
		);

		// P2-07: Optional orgPreset metadata round-trips cleanly from template builder through serializer & parser
		const withOrgPreset = buildBlueprintFromTemplate('feature-ship', {
			governorSessionId: 'gov-org',
			orgPreset: 'startup-3tier',
		});
		assert.strictEqual(withOrgPreset.metadata.orgPreset, 'startup-3tier');
		assert.strictEqual(withOrgPreset.metadata.maxBudgetUsd, 8);
		const serializedOrg = serializeEngineeringBlueprint(withOrgPreset);
		assert.ok(serializedOrg.includes('- org_preset: startup-3tier'));
		const reparsedOrg = parseEngineeringBlueprint(serializedOrg);
		assert.strictEqual(reparsedOrg.metadata.orgPreset, 'startup-3tier');
		assert.strictEqual(reparsedOrg.metadata.maxBudgetUsd, 8);
	});

	test('throws on unknown template ids', () => {
		assert.throws(
			() => buildBlueprintFromTemplate('unknown-template', { governorSessionId: 'gov' }),
			(err: unknown) => err instanceof Error && /Unknown blueprint template/i.test(err.message),
		);
	});
});

/**
 * Canonicalizes a blueprint for round-trip comparison:
 * - Nodes and managers are sorted because Mermaid declaration order is edge-driven.
 * - `user_gate.critical` is dropped because the canonical Markdown format does not persist it.
 */
function canonicalBlueprint(blueprint: IAdeEngineeringBlueprint) {
	return {
		metadata: blueprint.metadata,
		managers: [...blueprint.managers].sort((a, b) => a.segmentId.localeCompare(b.segmentId)),
		nodes: [...blueprint.nodes]
			.sort((a, b) => a.id.localeCompare(b.id))
			.map(node => node.type === 'user_gate'
				? { id: node.id, title: node.title, type: node.type, description: node.description, position: node.position }
				: node),
		edges: [...blueprint.edges].sort((a, b) => `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`)),
	};
}

const reportBlueprint: IAdeEngineeringBlueprint = {
	metadata: {
		treeType: 'engineering',
		governorSessionId: 'gov-report',
		workspaceIsolation: 'worktree',
		watchdogTimeoutMinutes: 10,
		flowDirection: 'LR',
		maxBudgetUsd: 25,
	},
	managers: [{
		segmentId: 'N1->N2',
		nodeIds: ['N1', 'N2'],
		config: { engine: 'claude-code', model: 'claude-sonnet-4-6', thinking: 'high' },
	}],
	nodes: [
		{
			id: 'N1', title: 'Build Core', type: 'task', critical: true,
			worker: { engine: 'codex', model: 'gpt-5-codex', thinking: 'high' },
			employee: { engine: 'claude-code', model: 'claude-sonnet-4-6', thinking: 'medium' },
			goal: 'Build the core service', acceptance: 'Tests pass',
		},
		{
			id: 'N2', title: 'Review | Audit', type: 'task', critical: false,
			worker: { engine: 'claude-code', thinking: 'high' },
			employee: { engine: 'claude-code', thinking: 'medium' },
			goal: 'Review the audit', acceptance: '',
		},
		{ id: 'U1', title: 'Human Gate', type: 'user_gate', critical: true, description: 'Approve release' },
		{
			id: 'N3', title: 'Finalize', type: 'task', critical: true,
			worker: { engine: 'codex', thinking: 'high' },
			employee: { engine: 'claude-code', thinking: 'medium' },
			goal: 'Finalize release', acceptance: '',
		},
		{
			id: 'N4', title: 'Polish', type: 'task', critical: false,
			worker: { engine: 'codex', thinking: 'high' },
			employee: { engine: 'claude-code', thinking: 'medium' },
			goal: 'Polish release', acceptance: '',
		},
		{
			id: 'N5', title: 'Announce', type: 'task', critical: false,
			worker: { engine: 'codex', thinking: 'high' },
			employee: { engine: 'claude-code', thinking: 'medium' },
			goal: 'Announce release', acceptance: '',
		},
	],
	edges: [
		{ from: 'N1', to: 'N2' },
		{ from: 'N2', to: 'U1' },
		{ from: 'U1', to: 'N3' },
		{ from: 'N3', to: 'N4' },
		{ from: 'N4', to: 'N5' },
	],
};

function createReportSnapshot(overrides: Partial<IAdeEngineeringTreeSnapshot> = {}): IAdeEngineeringTreeSnapshot {
	const node = (id: string): IAdeEngineeringBlueprintNode => reportBlueprint.nodes.find(n => n.id === id)!;
	const runtimes: Readonly<Record<string, IAdeEngineeringNodeRuntimeState>> = {
		N1: createRuntime({
			nodeId: 'N1',
			phase: 'completed',
			completed: true,
			startedAt: 1000,
			completedAt: 61000,
			tokenUsage: createNodeRoleUsage({ worker: createUsage({ inputTokens: 1_000_000 }), total: createUsage({ inputTokens: 1_000_000 }) }),
			lastChanges: {
				capturedAt: 60000,
				touchedFiles: [
					{ relativePath: 'src/a.ts', kind: 'added' },
					{ relativePath: 'src/b.ts', kind: 'modified' },
				],
				combinedDiff: '',
			},
		}),
		N2: createRuntime({
			nodeId: 'N2',
			phase: 'worker_running',
			startedAt: 2000,
			lastChanges: {
				capturedAt: 70000,
				touchedFiles: [
					{ relativePath: 'src/b.ts', kind: 'modified' },
					{ relativePath: 'src/c.ts', kind: 'deleted' },
				],
				combinedDiff: '',
			},
		}),
		U1: createRuntime({ nodeId: 'U1', phase: 'waiting_user_gate', startedAt: 80000 }),
		N3: createRuntime({ nodeId: 'N3', phase: 'circuit_broken', formalFailureCount: 3, lastEmployeeFeedback: 'Build failed' }),
		N4: createRuntime({ nodeId: 'N4', phase: 'idle' }),
		N5: createRuntime({ nodeId: 'N5', phase: 'manager_review', formalFailureCount: 2, lastManagerFeedback: 'Needs rework' }),
	};

	return {
		governorSessionId: 'gov-report',
		governorLabel: 'Governor Prime',
		projectPath: '/repo/aexus',
		projectName: 'Aexus',
		treeType: 'engineering',
		blueprintText: '',
		blueprint: reportBlueprint,
		state: createTreeState(runtimes, {
			runStatus: 'running',
			updatedAt: 120_000,
			worktrees: {
				'seg-1': { segmentId: 'N1->N2', branchName: 'ade/N1-N2', worktreePath: '/wt/n1-n2', headCommit: 'abcdef1234567890' },
			},
		}),
		nodes: [
			resolvedNode(node('N1'), runtimes.N1, 'completed'),
			resolvedNode(node('N2'), runtimes.N2, 'running'),
			resolvedNode(node('U1'), runtimes.U1, 'running'),
			resolvedNode(node('N3'), runtimes.N3, 'failure_3'),
			resolvedNode(node('N4'), runtimes.N4, 'pending'),
			resolvedNode(node('N5'), runtimes.N5, 'failure_2'),
		],
		edges: reportBlueprint.edges.map((edge, index): IAdeEngineeringResolvedEdgeStatus => ({
			edge,
			visualStatus: index === 0 ? 'completed' : 'pending',
		})),
		progress: { totalNodes: 6, completedNodes: 1, totalTasks: 5, completedTasks: 1, runningNodes: 2, failedNodes: 2, waitingGates: 1 },
		tokenUsage: createTreeTokenUsage({
			worker: createUsage({ cacheReadTokens: 500_000 }),
			total: createUsage({ inputTokens: 4_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, turns: 12, costUsd: 12.5 }),
		}),
		...overrides,
	};
}

suite('AdeEngineeringRunReport', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('renders the executive summary, status-icon Mermaid DAG, FinOps tiers, deliverables, files, worktrees, and footer', () => {
		const md = buildEngineeringRunReportMarkdown(createReportSnapshot());

		assert.deepStrictEqual(
			[
				md.startsWith('# Aexus Code · Engineering DAG Verification Report'),
				md.includes('> **Governor**: `Governor Prime` · **Project**: `Aexus` · **Status**: `running`'),
				md.includes('## Execution Summary'),
				md.includes('| **Mode / Isolation** | Engineering DAG · Git Worktree Isolated |'),
				md.includes('| **Progress** | 1/6 nodes (1/5 tasks · 1 Manager lanes) |'),
				md.includes('| **Wall Duration** | 1m |'),
				md.includes(`| **Total Tokens** | ${(6_000_000).toLocaleString()} (12 turns) |`),
				md.includes('| **Estimated Spend** | **$12.50** / $25.00 cap (50%) |'),
				md.includes('| **Prompt Cache Savings** | **$1.13** (20% cache hit · 1M cached tok) |'),
				md.includes('## Verified Workflow Topology'),
				md.includes('```mermaid\nflowchart LR'),
			],
			new Array(11).fill(true),
		);

		const mermaidLines = [
			'  N1["✅ N1: Build Core"] --> N2["🔄 N2: Review | Audit"]',
			'  N2 --> U1{{"🟡 U1: Human Gate"}}',
			'  U1 --> N3["🛑 N3: Finalize"]',
			'  N3 --> N4["⏳ N4: Polish"]',
			'  N4 --> N5["⚠️ N5: Announce"]',
		];
		assert.deepStrictEqual(
			mermaidLines.map(line => md.includes(line)),
			new Array(mermaidLines.length).fill(true),
		);

		assert.deepStrictEqual(
			[
				md.includes('## 4-Tier Agent FinOps Breakdown'),
				md.includes('| **Governor · L1** (Architect) | 0 | 0 | 0 | 0 | 0 | **$0.00** |'),
				md.includes('| **Worker · L4** (Native Executor) | 0 | 0 | 0 | 500k | 500,000 | **$2.50** |'),
				md.includes(`| **Total** | 12 | 4M | 1M | 1M | ${(6_000_000).toLocaleString()} | **$12.50** |`),
				md.includes('## Node Deliverables & Acceptance Audit'),
				md.includes('| `N1` Build Core | ✅ `completed` | codex → claude-code | 2 | 1M · $2.50 | Build the core service |'),
				md.includes('| `N2` Review \\| Audit | 🔄 `running` | claude-code → claude-code | 2 | 0 · $0.00 | Review the audit |'),
				md.includes('| `U1` Human Gate | 🟡 `running` | Human Gate | 0 | 0 · $0.00 | Approve release |'),
				md.includes('| `N5` Announce | ⚠️ `failure_2` | codex → claude-code | 0 | 0 · $0.00 | Needs rework |'),
			],
			new Array(9).fill(true),
		);

		assert.deepStrictEqual(
			[
				md.includes('## Touched Files'),
				md.includes('- `[A]` `src/a.ts`'),
				md.includes('- `[M]` `src/b.ts`'),
				md.includes('- `[D]` `src/c.ts`'),
				md.indexOf('`src/a.ts`') < md.indexOf('`src/b.ts`') && md.indexOf('`src/b.ts`') < md.indexOf('`src/c.ts`'),
				md.includes('## Isolated Segment Worktrees'),
				md.includes('- **Segment `N1->N2`** → branch `ade/N1-N2` (`abcdef12`)'),
				md.includes('_Generated by **[Aexus Code](https://github.com/Daijunfan/Aexus-Code)** · Organizational ADE & Multi-Agent Engineering Workbench_'),
			],
			new Array(8).fill(true),
		);
	});

	test('omits optional sections when no files were touched and no worktrees exist', () => {
		const snapshot = createReportSnapshot();
		const md = buildEngineeringRunReportMarkdown({
			...snapshot,
			nodes: snapshot.nodes.map(entry => ({
				...entry,
				runtime: { ...entry.runtime, lastChanges: undefined },
			})),
			state: { ...snapshot.state, worktrees: undefined },
		});
		assert.deepStrictEqual(
			[md.includes('## Touched Files'), md.includes('## Isolated Segment Worktrees'), md.includes('## Node Deliverables & Acceptance Audit')],
			[false, false, true],
		);
	});

	test('labels research trees and shared workspaces correctly', () => {
		const md = buildEngineeringRunReportMarkdown(createReportSnapshot({
			treeType: 'research',
			blueprint: {
				...reportBlueprint,
				metadata: { ...reportBlueprint.metadata, workspaceIsolation: 'shared' },
			},
		}));
		assert.deepStrictEqual(
			[
				md.startsWith('# Aexus Code · Research DAG Verification Report'),
				md.includes('| **Mode / Isolation** | Research DAG · Shared Workspace |'),
			],
			[true, true],
		);
	});
});

suite('AdeDagSvgExport', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('renders a valid dual-shell DAG SVG with tier labels, the MGR worktree lane, User Gate and FinOps header, escaping XML safely', () => {
		const snapshot = createReportSnapshot();
		const svg = buildEngineeringDagSvg({
			...snapshot,
			governorLabel: 'Gov <Prime> & Co',
			state: {
				...snapshot.state,
				worktrees: { 'N1->N2': snapshot.state.worktrees!['seg-1'] },
			},
			nodes: snapshot.nodes.map(entry => entry.node.id === 'N1'
				? { ...entry, node: { ...entry.node, title: 'Build <Core> & Ship' } }
				: entry),
		});

		assert.deepStrictEqual({
			validRoot: svg.startsWith('<svg ') && svg.endsWith('</svg>'),
			outerEmployee: svg.includes('EMPLOYEE · L3'),
			innerWorker: svg.includes('WORKER · L4'),
			managerLane: svg.includes('MGR · L2 [N1-&gt;N2] · ade/N1-N2'),
			userGate: svg.includes('AWAITING APPROVAL') && svg.includes('Human Gate'),
			finOpsHeader: svg.includes('Cache Saved $1.13 (20%)') && svg.includes('$12.50 / $25.00'),
			escapedTitle: svg.includes('Build &lt;Core&gt; &amp; Ship'),
			escapedGovernor: svg.includes('Gov &lt;Prime&gt; &amp; Co'),
			noRawMarkup: !svg.includes('<Core>') && !svg.includes('<Prime>'),
		}, {
			validRoot: true,
			outerEmployee: true,
			innerWorker: true,
			managerLane: true,
			userGate: true,
			finOpsHeader: true,
			escapedTitle: true,
			escapedGovernor: true,
			noRawMarkup: true,
		});

		const edgePathMatches = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="[^"]+" stroke-width=/g)].map(m => m[1]);
		assert.ok(edgePathMatches.length >= 2, 'Exported SVG contains directed edge paths');
		for (const d of edgePathMatches) {
			assertOrthogonalRoundedSvgPath(d);
		}
	});
});

function assertOrthogonalRoundedSvgPath(d: string, expectedCorners?: number): number {
	assert.ok(d.startsWith('M '), `Path must start with absolute M: ${d}`);
	assert.strictEqual(/[CcSsAa]/.test(d), false, `Path must not contain cubic/arc curves: ${d}`);
	const commands = (d.match(/[A-Za-z][^A-Za-z]*/g) ?? []).map(raw => ({
		op: raw[0],
		args: (raw.slice(1).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number),
	}));
	assert.ok(commands.length >= 2 && commands[0].op === 'M' && commands[commands.length - 1].op === 'L', `Invalid path commands: ${d}`);
	assert.match(commands.map(c => c.op).join(''), /^M(LQ)*L$/, `Unexpected orthogonal command sequence: ${d}`);
	let cx = commands[0].args[0];
	let cy = commands[0].args[1];
	let corners = 0;
	for (const cmd of commands.slice(1)) {
		if (cmd.op === 'L') {
			const [nx, ny] = cmd.args;
			assert.ok(Math.abs(nx - cx) < 0.05 || Math.abs(ny - cy) < 0.05, `L segment must be strictly horizontal or vertical: ${d}`);
			cx = nx;
			cy = ny;
		} else {
			assert.strictEqual(cmd.op, 'Q');
			const [qx, qy, bx, by] = cmd.args;
			const inX = qx - cx;
			const inY = qy - cy;
			const outX = bx - qx;
			const outY = by - qy;
			assert.ok(Math.abs(inX * outX + inY * outY) < 0.05, `Q corner must join perpendicular H/V segments: ${d}`);
			assert.ok(Math.abs(Math.hypot(inX, inY) - Math.hypot(outX, outY)) < 0.15, `Q fillet arms must be symmetric: ${d}`);
			cx = bx;
			cy = by;
			corners++;
		}
	}
	if (expectedCorners !== undefined) {
		assert.strictEqual(corners, expectedCorners, `Expected ${expectedCorners} rounded corners in ${d}`);
	}
	return corners;
}

suite('AdeOrthogonalRoundedEdgeRouting', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function assertStrictlyOrthogonal(points: readonly { readonly x: number; readonly y: number }[], label: string): void {
		assert.ok(points.length >= 2, `${label}: expected at least 2 waypoints`);
		for (let i = 1; i < points.length; i++) {
			const dx = Math.abs(points[i].x - points[i - 1].x);
			const dy = Math.abs(points[i].y - points[i - 1].y);
			assert.ok(dx < 0.05 || dy < 0.05, `${label}: segment ${i - 1}->${i} must be strictly horizontal or vertical (dx=${dx}, dy=${dy})`);
		}
	}

	test('routes straight horizontal edges without curves or slant', () => {
		const route = computeOrthogonalRoundedEdgeRoute(338, 260, 462, 260);
		assertStrictlyOrthogonal(route.points, 'straight');
		assert.strictEqual(route.path, 'M 338 260 L 462 260');
		assertOrthogonalRoundedSvgPath(route.path, 0);
		assert.strictEqual(route.midX, 400);
		assert.strictEqual(route.midY, 260);
	});

	test('routes forward fan-out edges with strictly H/V segments, smooth draw.io Q corners and aligned trunk', () => {
		const top = computeOrthogonalRoundedEdgeRoute(338, 260, 462, 140, { cornerRadius: 14 });
		const bot = computeOrthogonalRoundedEdgeRoute(338, 260, 462, 380, { cornerRadius: 14 });
		assertStrictlyOrthogonal(top.points, 'fan-out-top');
		assertStrictlyOrthogonal(bot.points, 'fan-out-bot');
		assert.strictEqual(top.path, 'M 338 260 L 386 260 Q 400 260 400 246 L 400 154 Q 400 140 414 140 L 462 140');
		assert.strictEqual(bot.path, 'M 338 260 L 386 260 Q 400 260 400 274 L 400 366 Q 400 380 414 380 L 462 380');
		assertOrthogonalRoundedSvgPath(top.path, 2);
		assertOrthogonalRoundedSvgPath(bot.path, 2);
		assert.strictEqual(top.midX, bot.midX, 'Sibling fan-out edges share a clean vertical trunk');
	});

	test('routes obstacle detours and backward U-routes strictly orthogonally with 4 rounded corners', () => {
		const detour = computeOrthogonalRoundedEdgeRoute(200, 260, 800, 260, {
			cornerRadius: 14,
			obstacles: [{ minX: 420, minY: 160, maxX: 580, maxY: 360 }],
		});
		assertStrictlyOrthogonal(detour.points, 'obstacle-detour');
		assertOrthogonalRoundedSvgPath(detour.path, 4);

		const shiftedTrunk = computeOrthogonalRoundedEdgeRoute(200, 200, 800, 420, {
			cornerRadius: 14,
			obstacles: [{ minX: 460, minY: 180, maxX: 540, maxY: 440 }],
		});
		assertStrictlyOrthogonal(shiftedTrunk.points, 'shifted-trunk');
		assertOrthogonalRoundedSvgPath(shiftedTrunk.path, 2);
		assert.ok(shiftedTrunk.midX < 460 || shiftedTrunk.midX > 540, `Trunk ${shiftedTrunk.midX} avoids intermediate pod obstacle [460..540]`);

		const backPath = buildOrthogonalRoundedEdgePath(600, 260, 200, 260, { cornerRadius: 12 });
		assertOrthogonalRoundedSvgPath(backPath, 4);
	});
});

suite('AdeEngineeringBlueprintBudgetAndLayout', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function minimalMarkdown(metadataLines: readonly string[] = []): string {
		return [
			'```mermaid',
			'flowchart LR',
			'  N1["Task"] --> U1{{"Gate"}}',
			'```',
			'',
			'## Tree Metadata',
			'- tree_type: engineering',
			'- governor_session_id: gov-budget',
			'- workspace_isolation: shared',
			'- watchdog_timeout_minutes: 10',
			...metadataLines,
			'',
			'## Nodes',
			'### [N1] Task',
			'- type: task',
			'- employee: engine=claude-code, thinking=medium',
			'- worker: engine=codex, thinking=high',
			'- goal: |',
			'    goal',
			'- acceptance: |',
			'    acceptance',
			'',
			'### [U1] Gate',
			'- type: user_gate',
			'- description: |',
			'    approve',
		].join('\n');
	}

	test('parses max_budget_usd from frontmatter and ## Tree Metadata, with the metadata section taking precedence', () => {
		const frontmatterOnly = [
			'---',
			'tree_type: engineering',
			'max_budget_usd: $5',
			'---',
			'',
			'```mermaid',
			'flowchart LR',
			'  N1["Task"]',
			'```',
		].join('\n');
		assert.strictEqual(parseEngineeringBlueprint(frontmatterOnly).metadata.maxBudgetUsd, 5);

		assert.strictEqual(parseEngineeringBlueprint(minimalMarkdown(['- max_budget_usd: 7.25'])).metadata.maxBudgetUsd, 7.25);

		// Both present: the `## Tree Metadata` bullet is parsed after the frontmatter and wins.
		const both = `---\nmax_budget_usd: 5\n---\n\n${minimalMarkdown(['- max_budget_usd: 7.25'])}`;
		assert.strictEqual(parseEngineeringBlueprint(both).metadata.maxBudgetUsd, 7.25);

		// Non-positive and unparsable caps are ignored entirely.
		assert.strictEqual(parseEngineeringBlueprint(minimalMarkdown(['- max_budget_usd: -3'])).metadata.maxBudgetUsd, undefined);
		assert.strictEqual(parseEngineeringBlueprint(minimalMarkdown(['- max_budget_usd: nope'])).metadata.maxBudgetUsd, undefined);
	});

	test('serializes max_budget_usd and round-trips it through parseEngineeringBlueprint', () => {
		const blueprint = parseEngineeringBlueprint(minimalMarkdown(['- max_budget_usd: 7.25']));
		const serialized = serializeEngineeringBlueprint(blueprint);
		assert.deepStrictEqual(
			[serialized.includes('- max_budget_usd: 7.25'), parseEngineeringBlueprint(serialized).metadata.maxBudgetUsd],
			[true, 7.25],
		);

		// Budgets are rounded to cents on the way out and back in.
		const cents = serializeEngineeringBlueprint({
			...blueprint,
			metadata: { ...blueprint.metadata, maxBudgetUsd: 12.345 },
		});
		assert.deepStrictEqual(
			[cents.includes('- max_budget_usd: 12.35'), parseEngineeringBlueprint(cents).metadata.maxBudgetUsd],
			[true, 12.35],
		);

		// No cap means no serialized line at all.
		const withoutBudget = serializeEngineeringBlueprint({
			...blueprint,
			metadata: { ...blueprint.metadata, maxBudgetUsd: undefined },
		});
		assert.strictEqual(withoutBudget.includes('max_budget_usd'), false);
	});

	test('detects cramped legacy 88x88 coordinates while accepting auto-layout output', () => {
		const positioned = (id: string, x: number, y: number): IAdeEngineeringBlueprintNode => ({
			id, title: id, type: 'task', critical: false, position: { x, y },
		});
		const legacyNodes = [positioned('N1', 160, 30), positioned('N2', 160, 240), positioned('N4', 445, 240)];

		const layeredBlueprint: IAdeEngineeringBlueprint = {
			metadata: {
				treeType: 'engineering',
				governorSessionId: 'gov-layout',
				workspaceIsolation: 'shared',
				watchdogTimeoutMinutes: 10,
				flowDirection: 'LR',
			},
			managers: [],
			nodes: ['N1', 'N2', 'N3', 'N4'].map(id => ({ id, title: id, type: 'task' as const, critical: false })),
			edges: [
				{ from: 'N1', to: 'N2' },
				{ from: 'N1', to: 'N3' },
				{ from: 'N2', to: 'N4' },
				{ from: 'N3', to: 'N4' },
			],
		};
		const positions = computeAutoLayoutPositions(layeredBlueprint);
		const autoLaidOut = layeredBlueprint.nodes.map(n => ({ ...n, position: positions.get(n.id)! }));

		assert.deepStrictEqual(
			{
				legacy: hasOverlappingPodPositions(legacyNodes),
				crampedPair: hasOverlappingPodPositions([positioned('N1', 160, 30), positioned('N2', 160, 240)]),
				single: hasOverlappingPodPositions([positioned('N1', 160, 30)]),
				autoLayout: hasOverlappingPodPositions(autoLaidOut),
			},
			{ legacy: true, crampedPair: true, single: false, autoLayout: false },
		);
	});
});

suite('AdePromptToDag', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('synthesizes a 6-node worktree engineering DAG with 3 parallel tracks that round-trips through serialize/parse', () => {
		const result = synthesizeBlueprintFromPrompt(
			'Build OAuth2 GitHub and Google login, migrate user schema, add E2E tests',
			{ governorSessionId: 'gov-prompt-feature' },
		);
		const { blueprint } = result;

		assert.deepStrictEqual(
			{
				archetype: result.archetype,
				treeType: result.treeType,
				isolation: blueprint.metadata.workspaceIsolation,
				tracks: result.tracks,
				nodeIds: blueprint.nodes.map(n => n.id),
				overlapping: hasOverlappingPodPositions(blueprint.nodes),
			},
			{
				archetype: 'migration',
				treeType: 'engineering',
				isolation: 'worktree',
				tracks: ['OAuth2 GitHub', 'Google login', 'User schema'],
				nodeIds: ['N1', 'N2', 'N3', 'N4', 'U1', 'N5'],
				overlapping: false,
			},
		);

		const parsed = parseEngineeringBlueprint(serializeEngineeringBlueprint(blueprint));
		assert.deepStrictEqual(
			{
				metadata: parsed.metadata,
				nodeIds: parsed.nodes.map(n => n.id),
				titles: parsed.nodes.map(n => n.title),
				edges: parsed.edges,
			},
			{
				metadata: blueprint.metadata,
				nodeIds: blueprint.nodes.map(n => n.id),
				titles: blueprint.nodes.map(n => n.title),
				edges: blueprint.edges,
			},
		);
	});

	test('detects research prompts as shared-isolation research trees', () => {
		const result = synthesizeBlueprintFromPrompt(
			'Benchmark Redis vs Dragonfly vs Garnet latency and write RFC',
			{ governorSessionId: 'gov-prompt-research' },
		);

		assert.deepStrictEqual(
			{
				archetype: result.archetype,
				treeType: result.treeType,
				isolation: result.blueprint.metadata.workspaceIsolation,
			},
			{ archetype: 'research', treeType: 'research', isolation: 'shared' },
		);
	});

	test('detects Chinese bugfix prompts while keeping the engineering tree type', () => {
		const result = synthesizeBlueprintFromPrompt(
			'修复 WebSocket 断线重连内存泄漏并补齐回归测试',
			{ governorSessionId: 'gov-prompt-bugfix' },
		);

		assert.deepStrictEqual(
			{ archetype: result.archetype, treeType: result.treeType },
			{ archetype: 'bugfix', treeType: 'engineering' },
		);
	});

	test('rejects an empty prompt', () => {
		assert.throws(
			() => synthesizeBlueprintFromPrompt('   ', { governorSessionId: 'gov-prompt-empty' }),
			/Describe what you want/,
		);
	});
});
