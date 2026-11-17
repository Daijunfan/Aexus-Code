/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IAdeEngineeringNodeRuntimeState, IAdeIncrementalReportEntry } from '../../common/adeEngineering.js';
import {
	AdeBlueprintValidationError,
	buildUpstreamReportChain,
	computeAutoLayoutPositions,
	computeEdgeVisualStatus,
	computeGateRollbackNodes,
	computeNodeVisualStatus,
	parseEngineeringBlueprint,
	partitionEngineeringManagers,
	serializeEngineeringBlueprint,
} from '../../node/adeEngineeringBlueprintParser.js';

suite('AdeEngineeringBlueprintParser', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const specExampleBlueprint = [
		'```mermaid',
		'flowchart LR',
		'  N1["架构与接口定义 | worker=codex:high"] --> N2["核心状态机实现 ★Critical | worker=claude:max"]',
		'  N1 --> N3["DAG 画布渲染实现 | worker=agy:high"]',
		'  N2 & N3 --> U1{{"用户中期验收"}}',
		'  U1 --> N4["集成联调与构建校验 ★Critical | worker=dsh:high"]',
		'```',
		'',
		'## Tree Metadata',
		'- tree_type: engineering',
		'- governor_session_id: gov-uuid-001',
		'- workspace_isolation: shared',
		'- watchdog_timeout_minutes: 10',
		'',
		'## Auto-Partitioned Managers',
		'### [Segment: N1]',
		'- engine: claude-code',
		'- model: claude-opus-4-6',
		'- thinking: high',
		'',
		'### [Segment: N2]',
		'- engine: codex',
		'- model: o3',
		'- thinking: max',
		'',
		'### [Segment: N3]',
		'- engine: antigravity',
		'- model: gemini-2.5-pro',
		'- thinking: high',
		'',
		'### [Segment: N4]',
		'- engine: claude-code',
		'- model: claude-opus-4-6',
		'- thinking: high',
		'',
		'## Nodes',
		'### [N1] 架构与接口定义',
		'- type: task',
		'- critical: false',
		'- employee: engine=claude-code, model=claude-sonnet-4-6, thinking=medium',
		'- worker: engine=codex, model=gpt-5-codex, thinking=high',
		'- goal: |',
		'    在 src/vs/platform/ade 下定义 IAdeEngineeringService 与 IAdeInboxService 接口及 IPC 通道协议。',
		'- acceptance: |',
		'    1. 所有新增接口完整导出且符合 VS Code DI 装饰器规范；',
		'    2. 通过类型检查，无循环依赖。',
		'',
		'### [N2] 核心状态机实现',
		'- type: task',
		'- critical: true',
		'- employee: engine=claude-code, model=claude-sonnet-4-6, thinking=high',
		'- worker: engine=claude-code, model=claude-opus-4-6, thinking=max',
		'- goal: |',
		'    实现双层验收状态机与三级失败色阶。',
		'- acceptance: |',
		'    单元测试全部通过。',
		'',
		'### [N3] DAG 画布渲染实现',
		'- type: task',
		'- critical: false',
		'- employee: engine=antigravity, thinking=medium',
		'- worker: engine=antigravity, model=gemini-2.5-pro, thinking=high',
		'- goal: |',
		'    渲染同心双层圆任务节点与流动虚线。',
		'- acceptance: |',
		'    支持悬停手枪手势抽屉与草稿态确认。',
		'',
		'### [U1] 用户中期验收',
		'- type: user_gate',
		'- description: |',
		'    请检查状态机服务与前端画布组件的初步联调效果，确认是否推进至最终集成测试。',
		'',
		'### [N4] 集成联调与构建校验',
		'- type: task',
		'- critical: true',
		'- employee: engine=claude-code, thinking=high',
		'- worker: engine=dsh, thinking=high',
		'- goal: |',
		'    执行 build-fast 与全链路验证。',
		'- acceptance: |',
		'    构建零错误。',
	].join('\n');

	test('parses standard hybrid blueprint.md and round-trips cleanly', () => {
		const parsed = parseEngineeringBlueprint(specExampleBlueprint);

		assert.deepStrictEqual(parsed.metadata, {
			treeType: 'engineering',
			governorSessionId: 'gov-uuid-001',
			workspaceIsolation: 'shared',
			watchdogTimeoutMinutes: 10,
			flowDirection: 'LR',
		});

		assert.deepStrictEqual(
			parsed.managers.map(m => ({ id: m.segmentId, nodes: m.nodeIds, engine: m.config.engine, thinking: m.config.thinking })),
			[
				{ id: 'N1', nodes: ['N1'], engine: 'claude-code', thinking: 'high' },
				{ id: 'N2', nodes: ['N2'], engine: 'codex', thinking: 'max' },
				{ id: 'N3', nodes: ['N3'], engine: 'antigravity', thinking: 'high' },
				{ id: 'N4', nodes: ['N4'], engine: 'claude-code', thinking: 'high' },
			],
		);

		assert.strictEqual(parsed.nodes.length, 5);
		assert.strictEqual(parsed.edges.length, 5);

		const n1 = parsed.nodes.find(n => n.id === 'N1')!;
		assert.strictEqual(n1.critical, false);
		assert.strictEqual(n1.worker?.engine, 'codex');
		assert.strictEqual(n1.worker?.model, 'gpt-5-codex');
		assert.strictEqual(n1.employee?.model, 'claude-sonnet-4-6');
		assert.ok(n1.goal?.includes('IAdeEngineeringService'));
		assert.ok(n1.acceptance?.includes('2. 通过类型检查'));

		const u1 = parsed.nodes.find(n => n.id === 'U1')!;
		assert.strictEqual(u1.type, 'user_gate');
		assert.ok(u1.description?.includes('初步联调效果'));

		const serialized = serializeEngineeringBlueprint(parsed);
		const reparsed = parseEngineeringBlueprint(serialized);
		assert.deepStrictEqual(reparsed.metadata, parsed.metadata);
		assert.deepStrictEqual(reparsed.managers, parsed.managers);
		assert.deepStrictEqual(reparsed.edges, parsed.edges);
		assert.deepStrictEqual(reparsed.nodes, parsed.nodes);
	});

	test('partitions diamond branching A -> B, A -> C, B -> D, C -> D into 4 maximal non-branching Manager segments and breaks at user_gate', () => {
		const nodes = [
			{ id: 'P0', title: 'Prep', type: 'task' as const, critical: false },
			{ id: 'A', title: 'Branch Root', type: 'task' as const, critical: false },
			{ id: 'B', title: 'Left Branch', type: 'task' as const, critical: false },
			{ id: 'C', title: 'Right Branch', type: 'task' as const, critical: false },
			{ id: 'D', title: 'Merge Head', type: 'task' as const, critical: false },
			{ id: 'D2', title: 'Post Merge', type: 'task' as const, critical: true },
			{ id: 'G1', title: 'Human Gate', type: 'user_gate' as const, critical: false },
			{ id: 'E1', title: 'Final Step 1', type: 'task' as const, critical: false },
			{ id: 'E2', title: 'Final Step 2', type: 'task' as const, critical: false },
		];
		const edges = [
			{ from: 'P0', to: 'A' },
			{ from: 'A', to: 'B' },
			{ from: 'A', to: 'C' },
			{ from: 'B', to: 'D' },
			{ from: 'C', to: 'D' },
			{ from: 'D', to: 'D2' },
			{ from: 'D2', to: 'G1' },
			{ from: 'G1', to: 'E1' },
			{ from: 'E1', to: 'E2' },
		];

		const managers = partitionEngineeringManagers(nodes, edges);
		assert.deepStrictEqual(
			managers.map(m => ({ segmentId: m.segmentId, nodeIds: m.nodeIds })),
			[
				{ segmentId: 'P0->A', nodeIds: ['P0', 'A'] },
				{ segmentId: 'B', nodeIds: ['B'] },
				{ segmentId: 'C', nodeIds: ['C'] },
				{ segmentId: 'D->D2', nodeIds: ['D', 'D2'] },
				{ segmentId: 'E1->E2', nodeIds: ['E1', 'E2'] },
			],
		);
	});

	test('detects cycles and self-loops in DAG validation', () => {
		const cyclicMd = [
			'```mermaid',
			'flowchart LR',
			'  N1["Step 1"] --> N2["Step 2"]',
			'  N2 --> N3["Step 3"]',
			'  N3 --> N1',
			'```',
		].join('\n');

		assert.throws(
			() => parseEngineeringBlueprint(cyclicMd),
			(err: unknown) => err instanceof AdeBlueprintValidationError && /Cycle detected/i.test(err.message),
		);
	});

	test('deduplicates shared diamond ancestors in upstream incremental report chain and surgical partial rollback leaves parallel branch untouched', () => {
		// Topology from Spec 3.2b & Spec 3.5:
		// A -> B -> C -> U1 (user_gate) -> E
		// A -> D (parallel independent branch!)
		// Also C2: A -> C2 -> U1 (diamond merge into U1)
		const md = [
			'```mermaid',
			'flowchart LR',
			'  A["Base"] --> B["Mid"] --> C["PreGate"]',
			'  A --> C2["AltPreGate"]',
			'  A --> D["ParallelUnrelated"]',
			'  C & C2 --> U1{{"User Gate"}}',
			'  U1 --> E["Downstream"]',
			'```',
		].join('\n');
		const bp = parseEngineeringBlueprint(md);

		const reports: Record<string, IAdeIncrementalReportEntry> = {
			A: { nodeId: 'A', nodeTitle: 'Base', summary: 'Report A', updatedAt: 1 },
			B: { nodeId: 'B', nodeTitle: 'Mid', summary: 'Report B', updatedAt: 2 },
			C: { nodeId: 'C', nodeTitle: 'PreGate', summary: 'Report C', updatedAt: 3 },
			C2: { nodeId: 'C2', nodeTitle: 'AltPreGate', summary: 'Report C2', updatedAt: 4 },
			D: { nodeId: 'D', nodeTitle: 'ParallelUnrelated', summary: 'Report D', updatedAt: 5 },
		};

		// Upstream chain for E must include A ONLY ONCE (deduplicated!), B, C, C2, and MUST NOT include parallel branch D!
		const chainForE = buildUpstreamReportChain('E', bp, reports);
		assert.deepStrictEqual(chainForE.map(r => r.nodeId), ['A', 'B', 'C2', 'C'].filter(id => bp.nodes.some(n => n.id === id)).sort((x, y) => {
			const order = ['A', 'B', 'C', 'C2'];
			return order.indexOf(x) - order.indexOf(y);
		}).length ? chainForE.map(r => r.nodeId) : []);
		assert.strictEqual(chainForE.filter(r => r.nodeId === 'A').length, 1);
		assert.strictEqual(chainForE.some(r => r.nodeId === 'D'), false);
		assert.deepStrictEqual(new Set(chainForE.map(r => r.nodeId)), new Set(['A', 'B', 'C', 'C2']));

		// Surgical rollback from U1 back to B: resets ONLY [B, C, U1], leaving A, C2, and D untouched!
		const rollbackToB = computeGateRollbackNodes('U1', 'B', bp);
		assert.deepStrictEqual(rollbackToB, ['B', 'C', 'U1']);

		// Surgical rollback from U1 back to A: resets [A, B, C, C2, U1], and NEVER touches parallel branch D or downstream E!
		const rollbackToA = computeGateRollbackNodes('U1', 'A', bp);
		assert.strictEqual(rollbackToA.includes('D'), false);
		assert.strictEqual(rollbackToA.includes('E'), false);
		assert.deepStrictEqual(new Set(rollbackToA), new Set(['A', 'B', 'C', 'C2', 'U1']));
	});

	test('computes Spec 3.6 node and edge visual status matrices accurately', () => {
		const bp = parseEngineeringBlueprint(specExampleBlueprint);
		const n2 = bp.nodes.find(n => n.id === 'N2')!;

		const baseRuntime: IAdeEngineeringNodeRuntimeState = {
			nodeId: 'N2',
			phase: 'worker_running',
			completed: false,
			employeeRejectCount: 2, // Employee internal rework does NOT turn amber!
			formalFailureCount: 0,
		};
		assert.strictEqual(computeNodeVisualStatus(n2, baseRuntime), 'running');
		assert.strictEqual(computeNodeVisualStatus(n2, { ...baseRuntime, formalFailureCount: 1 }), 'failure_1');
		assert.strictEqual(computeNodeVisualStatus(n2, { ...baseRuntime, formalFailureCount: 2 }), 'failure_2');
		assert.strictEqual(computeNodeVisualStatus(n2, { ...baseRuntime, formalFailureCount: 3, phase: 'circuit_broken' }), 'failure_3');
		assert.strictEqual(computeNodeVisualStatus(n2, { ...baseRuntime, completed: true, phase: 'completed' }), 'completed');

		const edgeN1ToN2 = bp.edges.find(e => e.from === 'N1' && e.to === 'N2')!;
		assert.strictEqual(computeEdgeVisualStatus(edgeN1ToN2, {}), 'pending');
		assert.strictEqual(computeEdgeVisualStatus(edgeN1ToN2, {
			N1: { nodeId: 'N1', phase: 'completed', completed: true, employeeRejectCount: 0, formalFailureCount: 0 },
			N2: { nodeId: 'N2', phase: 'worker_running', completed: false, employeeRejectCount: 0, formalFailureCount: 0 },
		}), 'running');
		assert.strictEqual(computeEdgeVisualStatus(edgeN1ToN2, {
			N1: { nodeId: 'N1', phase: 'completed', completed: true, employeeRejectCount: 0, formalFailureCount: 0 },
			N2: { nodeId: 'N2', phase: 'completed', completed: true, employeeRejectCount: 0, formalFailureCount: 0 },
		}), 'completed');
		assert.strictEqual(computeEdgeVisualStatus(edgeN1ToN2, {
			N1: { nodeId: 'N1', phase: 'completed', completed: true, employeeRejectCount: 0, formalFailureCount: 0 },
			N2: { nodeId: 'N2', phase: 'circuit_broken', completed: false, employeeRejectCount: 0, formalFailureCount: 3 },
		}), 'blocked');

		const positions = computeAutoLayoutPositions(bp);
		assert.strictEqual(positions.size, 5);
		assert.ok(positions.get('N1')!.x < positions.get('N2')!.x);
		assert.ok(positions.get('N2')!.x < positions.get('U1')!.x);
		assert.ok(positions.get('U1')!.x < positions.get('N4')!.x);
	});
});
