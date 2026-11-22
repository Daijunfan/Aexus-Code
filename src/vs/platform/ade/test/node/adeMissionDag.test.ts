/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	addEdgeToMermaid,
	addNodeToMermaid,
	buildMissionContextReusePaths,
	buildOrthogonalRoundedEdgePath,
	computeMissionAutoLayout,
	computeMissionEdgeLabelLayout,
	computeMissionWorldSize,
	computeOrthogonalRoundedEdgeRoute,
	getMissionEdgeKind,
	measureMissionEdgeLabelTextWidth,
	MISSION_DAG_TEMPLATES,
	MISSION_TASK_NODE_HEIGHT,
	MISSION_TASK_NODE_WIDTH,
	parseMissionMermaidDag,
	removeEdgeFromMermaid,
	removeNodeFromMermaid,
	renameNodeInMermaid,
	setNodeEmployeeInMermaid,
	toggleEdgeFailInMermaid,
} from '../../common/adeMissionDag.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, getMissionDisplayName } from '../../common/adeRoleSchema.js';
import { renameMissionAlias } from '../../common/adeRankResize.js';
import { AdeDocsBackendNodeService } from '../../node/adeDocsBackendService.js';

suite('ADE Pure-Frontend Mission Mermaid DAG, Flat Auto-Layout & Draw.io Orthogonal Router', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses empty Mermaid cleanly, flattens subgraph nesting, supports shapes/chains/labels, and rejects cycles', () => {
		const empty = parseMissionMermaidDag('   \n  ');
		assert.strictEqual(empty.error, undefined);
		assert.strictEqual(empty.nodes.length, 0);
		assert.strictEqual(empty.edges.length, 0);

		const mermaid = [
			'```mermaid',
			'flowchart LR',
			'  subgraph NestedShouldFlatten',
			'    N1["API Spec & Schema"] -->|contract| N2["Core Engine"] --> U1{{"Approval Gate"}}',
			'    N1 --> N3["UI Canvas"]',
			'    N3 --> U1',
			'  end',
			'```',
		].join('\n');
		const parsed = parseMissionMermaidDag(mermaid);
		assert.strictEqual(parsed.error, undefined);
		assert.strictEqual(parsed.direction, 'LR');
		assert.deepStrictEqual(
			parsed.nodes.map(n => [n.id, n.label, n.kind]),
			[
				['N1', 'API Spec & Schema', 'task'],
				['N2', 'Core Engine', 'task'],
				['U1', 'Approval Gate', 'gate'],
				['N3', 'UI Canvas', 'task'],
			],
		);
		assert.strictEqual(parsed.edges.length, 4);
		assert.strictEqual(parsed.edges[0].label, 'contract');

		// Cycles & self-loops rejected cleanly
		assert.ok(parseMissionMermaidDag('flowchart LR\n  A --> B\n  B --> A').error?.includes('Cycle'));
		assert.ok(parseMissionMermaidDag('flowchart LR\n  A --> A').error?.includes('Self-loop'));
	});

	test('computes non-overlapping flat layered auto-layout and draw.io smooth rounded orthogonal routes', () => {
		const parsed = parseMissionMermaidDag([
			'flowchart LR',
			'  N1["Start"] --> N2["Track A"]',
			'  N1 --> N3["Track B"]',
			'  N2 & N3 --> N4["Merge"]',
		].join('\n'));
		const layout = computeMissionAutoLayout(parsed);
		assert.strictEqual(layout.size, 4);
		assert.ok(layout.get('N1')!.x < layout.get('N2')!.x);
		assert.strictEqual(layout.get('N2')!.x, layout.get('N3')!.x);
		assert.notStrictEqual(layout.get('N2')!.y, layout.get('N3')!.y);
		assert.ok(layout.get('N2')!.x < layout.get('N4')!.x);

		// Draw.io orthogonal rounded path: strictly horizontal/vertical segments + Q smooth corners
		const route = computeOrthogonalRoundedEdgeRoute(100, 100, 420, 260, { cornerRadius: 14 });
		assert.ok(route.path.includes('Q '), 'Forward fan-out uses smooth quadratic-Bezier Q corners');
		for (let i = 1; i < route.points.length; i++) {
			const prev = route.points[i - 1];
			const curr = route.points[i];
			const isHorizontal = Math.abs(prev.y - curr.y) < 0.1;
			const isVertical = Math.abs(prev.x - curr.x) < 0.1;
			assert.ok(isHorizontal || isVertical, 'Every underlying segment must be strictly horizontal or vertical');
		}

		// Straight horizontal path with obstacle detours orthogonally
		const detourPath = buildOrthogonalRoundedEdgePath(100, 200, 600, 200, {
			obstacles: [{ minX: 280, maxX: 420, minY: 160, maxY: 240 }],
		});
		assert.ok(detourPath.includes('Q '), 'Obstacle detour uses smooth rounded corners');

		const world = computeMissionWorldSize([...layout.values()]);
		assert.ok(world.width >= 4800 && world.height >= 3600);
	});

	test('hot-renames unified Mission alias and persists Inbox + single-copy API docs via slim AdeDocsBackendNodeService', async () => {
		assert.strictEqual(getMissionDisplayName(DEFAULT_ADE_ORGANIZATION_CONFIG), 'Mission');
		const engAlias = renameMissionAlias(DEFAULT_ADE_ORGANIZATION_CONFIG, 'Engineering');
		assert.strictEqual(getMissionDisplayName(engAlias), 'Engineering');
		const resAlias = renameMissionAlias(engAlias, 'Research');
		assert.strictEqual(getMissionDisplayName(resAlias), 'Research');

		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aexus-slim-backend-'));
		const backend = new AdeDocsBackendNodeService({ baseDir: tmpDir });
		try {
			const paths = await backend.syncApiDocs(resAlias);
			assert.ok(fs.existsSync(paths.missionDoc));
			assert.ok(fs.existsSync(paths.rankDocs.L0));
			assert.ok(fs.existsSync(paths.rankDocs.L1));

			assert.deepStrictEqual(await backend.loadInbox(), []);
			await backend.saveInbox([{
				id: 'i1',
				kind: 'governor_message',
				treeType: 'mission',
				governorSessionId: 's1',
				governorLabel: 'Alpha',
				projectPath: '/tmp/p',
				projectName: 'p',
				title: 'Check',
				message: 'Ready',
				unread: true,
				resolved: false,
				createdAt: 1000,
			}]);
			const loaded = await backend.loadInbox();
			assert.strictEqual(loaded.length, 1);
			assert.strictEqual(loaded[0].id, 'i1');
		} finally {
			backend.dispose();
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test('schedules the same employee across multiple DAG positions to reuse context (@Employee, :::Employee, class) without false positives', () => {
		const mermaid = [
			'flowchart LR',
			'  N1["@Backend: API Contract"] --> N2["@Frontend: UI Canvas"]',
			'  N1 --> N3["Core Engine (@backend)"]',
			'  N2 --> N4["Integration & Review"]:::Backend',
			'  N3 --> N4',
			'  N4 --> N5["Fix user@example.com & @types/node"]',
			'  N4 --> N6["架构评审"]',
			'  N6 --> U1{{"Release Signoff"}}',
			'  class N6 后端架构',
		].join('\n');

		const parsed = parseMissionMermaidDag(mermaid);
		assert.strictEqual(parsed.error, undefined);

		const byId = new Map(parsed.nodes.map(n => [n.id, n]));
		assert.strictEqual(byId.get('N1')?.label, 'API Contract');
		assert.strictEqual(byId.get('N1')?.employeeKey, 'backend');
		assert.strictEqual(byId.get('N1')?.employeeName, 'Backend');
		assert.strictEqual(byId.get('N1')?.employeeOccurrence, 1);
		assert.strictEqual(byId.get('N1')?.employeeTotalOccurrences, 3);

		assert.strictEqual(byId.get('N3')?.label, 'Core Engine');
		assert.strictEqual(byId.get('N3')?.employeeKey, 'backend');
		assert.strictEqual(byId.get('N3')?.employeeOccurrence, 2);
		assert.strictEqual(byId.get('N3')?.employeeTotalOccurrences, 3);

		assert.strictEqual(byId.get('N4')?.label, 'Integration & Review');
		assert.strictEqual(byId.get('N4')?.employeeKey, 'backend');
		assert.strictEqual(byId.get('N4')?.employeeOccurrence, 3);
		assert.strictEqual(byId.get('N4')?.employeeTotalOccurrences, 3);

		// Email & npm scoped package MUST NOT be misparsed as an employee assignment
		assert.strictEqual(byId.get('N5')?.employeeKey, undefined);
		assert.strictEqual(byId.get('N5')?.label, 'Fix user@example.com & @types/node');

		// Unicode class assignment works cleanly
		assert.strictEqual(byId.get('N6')?.employeeName, '后端架构');
		assert.strictEqual(byId.get('U1')?.kind, 'gate');
		assert.strictEqual(byId.get('U1')?.employeeKey, undefined);

		// Deduplicated employee groups: Backend (3 steps), Frontend (1 step), N5 anonymous (1), 后端架构 (1) = 4 unique employees for 6 task steps
		assert.strictEqual(parsed.employees?.length, 4);
		const backendGroup = parsed.employees?.find(e => e.key === 'emp:backend');
		assert.deepStrictEqual(backendGroup?.nodeIds, ['N1', 'N3', 'N4']);
		assert.strictEqual(backendGroup?.displayName, 'Backend');

		// Pure Mermaid rewriter updates N5 to reuse Backend, then clears N4 cleanly
		const reassigned = setNodeEmployeeInMermaid(mermaid, 'N5', 'Backend');
		const reparsed = parseMissionMermaidDag(reassigned);
		assert.strictEqual(reparsed.error, undefined);
		assert.deepStrictEqual(reparsed.employees?.find(e => e.key === 'emp:backend')?.nodeIds, ['N1', 'N3', 'N4', 'N5']);

		const cleared = setNodeEmployeeInMermaid(reassigned, 'N4', undefined);
		const reparsedCleared = parseMissionMermaidDag(cleared);
		assert.strictEqual(reparsedCleared.error, undefined);
		assert.deepStrictEqual(reparsedCleared.employees?.find(e => e.key === 'emp:backend')?.nodeIds, ['N1', 'N3', 'N5']);
		assert.strictEqual(reparsedCleared.nodes.find(n => n.id === 'N4')?.employeeKey, undefined);
	});

	test('buildMissionContextReusePaths shares one gapless lane across same-employee hops and falls back to a separate lane on direction reversal', () => {
		const laneY = 100;
		const anchors = [
			{ id: 'N2', x: 400, borderY: 200 },
			{ id: 'N5', x: 720, borderY: 200 },
			{ id: 'N8', x: 1040, borderY: 200 },
		];
		const hops = buildMissionContextReusePaths(anchors, laneY, false, 12);
		assert.strictEqual(hops.length, 2);
		assert.deepStrictEqual(hops.map(hop => [hop.fromId, hop.toId]), [['N2', 'N5'], ['N5', 'N8']]);

		// Both hops ride the exact same horizontal lane with no gap: hop 1 starts at hop 0's final corner.
		const hop0Corner = hops[0].path.match(/L ([^ ]+) 100/);
		assert.ok(hop0Corner, `hop 0 must reach the shared lane: ${hops[0].path}`);
		const sharedCornerX = Number(hop0Corner[1]);
		assert.ok(hops[1].path.startsWith(`M ${sharedCornerX} 100`), `hop 1 must start exactly on hop 0's lane corner: ${hops[1].path}`);
		assert.ok(sharedCornerX < anchors[1].x, 'shared corner must land before the next card center');
		assert.deepStrictEqual(hops[1].junction, { x: 720, y: laneY });

		const laneOf = (path: string): number => {
			const match = path.match(/Q [^ ]+ ([^ ]+) /);
			assert.ok(match, `expected a lane corner in ${path}`);
			return Number(match[1]);
		};
		assert.strictEqual(laneOf(hops[0].path), laneY);
		assert.strictEqual(laneOf(hops[1].path), laneY);

		// Dragging #3 to the left of #2 (direction reversal) falls back to a second, non-overlapping lane.
		const reversed = buildMissionContextReusePaths([
			{ id: 'N2', x: 400, borderY: 200 },
			{ id: 'N5', x: 720, borderY: 200 },
			{ id: 'N8', x: 300, borderY: 200 },
		], laneY, false, 12);
		assert.strictEqual(reversed.length, 2);
		assert.strictEqual(reversed[1].junction, undefined, 'direction reversal must not reuse the shared spine');
		const reversedLaneY = laneOf(reversed[1].path);
		assert.notStrictEqual(reversedLaneY, laneY, 'reversed hop must fall back to a separate lane');
		assert.strictEqual(reversedLaneY, laneY - 18);
	});

	test('parses inline `-- fail -->` and `-. on_fail .->` as fail edges without phantom nodes', () => {
		const graph = parseMissionMermaidDag([
			'flowchart LR',
			'  A -- fail --> B',
			'  B -. on_fail .-> C',
		].join('\n'));

		assert.strictEqual(graph.error, undefined);
		assert.deepStrictEqual(graph.nodes.map(n => n.id), ['A', 'B', 'C']);
		assert.strictEqual(graph.edges.length, 2);

		const first = graph.edges.find(e => e.id === 'A->B');
		assert.ok(first);
		assert.strictEqual(first.edgeKind, 'fail');
		assert.strictEqual(first.label, 'fail');
		assert.strictEqual(getMissionEdgeKind(first), 'fail');

		const second = graph.edges.find(e => e.id === 'B->C');
		assert.ok(second);
		assert.strictEqual(second.edgeKind, 'fail');
		assert.strictEqual(second.label, 'on_fail');
		assert.strictEqual(getMissionEdgeKind(second), 'fail');
	});

	test('returns a non-empty error for unknown non-empty statements', () => {
		const unknownNode = parseMissionMermaidDag('flowchart LR\n  ???');
		assert.ok(unknownNode.error && unknownNode.error.length > 0, 'unknown node statement must surface an error');

		const unknownAfterEdge = parseMissionMermaidDag('flowchart LR\n  A --> B\n  @@@');
		assert.ok(unknownAfterEdge.error && unknownAfterEdge.error.length > 0, 'unknown statement after a valid edge must surface an error');
	});

	test('parses every official blueprint in examples/blueprints/*.md cleanly without legacy worker= syntax or swallowed metadata', () => {
		const blueprintsDir = path.resolve(process.cwd(), 'examples', 'blueprints');
		const required = [
			'feature-ship.md',
			'bug-hunt-fix.md',
			'security-audit-swarm.md',
			'safe-migration.md',
			'deep-research-lab.md',
			'arch-teardown.md',
		];
		for (const fileName of required) {
			const fullPath = path.join(blueprintsDir, fileName);
			assert.ok(fs.existsSync(fullPath), `Missing official blueprint: ${fullPath}`);
			const content = fs.readFileSync(fullPath, 'utf8');
			assert.ok(content.includes('```mermaid'), `${fileName} must contain a fenced mermaid block`);
			assert.ok(content.includes('## Node Pre-Prompts'), `${fileName} must contain ## Node Pre-Prompts`);
			assert.ok(!content.includes('## Tree Metadata'), `${fileName} must not contain legacy ## Tree Metadata`);
			assert.ok(!content.includes('## Auto-Partitioned Managers'), `${fileName} must not contain legacy ## Auto-Partitioned Managers`);
			assert.ok(!/worker=[a-z0-9_-]+:/i.test(content), `${fileName} must not contain legacy worker=engine:thinking syntax`);

			const parsed = parseMissionMermaidDag(content);
			assert.strictEqual(parsed.error, undefined, `${fileName} failed to parse: ${parsed.error}`);
			assert.ok(parsed.nodes.length >= 4, `${fileName} should define at least 4 DAG nodes`);
			assert.ok(parsed.edges.length >= 4, `${fileName} should define at least 4 DAG edges`);
			assert.ok(parsed.nodes.some(n => n.kind === 'gate'), `${fileName} should include a human gate node`);
			for (const node of parsed.nodes) {
				assert.ok(!node.label.includes('worker='), `${fileName} node ${node.id} leaked legacy syntax: ${node.label}`);
				assert.ok(!node.label.includes('|'), `${fileName} node ${node.id} contains pipe syntax: ${node.label}`);
			}
		}
	});

	test('parses inline Mermaid %% check / %% verify directives onto task nodes while ignoring gates and regular comments', () => {
		const graph = parseMissionMermaidDag([
			'flowchart LR',
			'  %% Regular human comment that must be ignored',
			'  N1["@Dev: Build Core"] --> N2["Review"] --> G1{{"Signoff"}}',
			'  %% check N1 [name=typecheck, timeout=90s, on_fail=bounce, max_retries=3, cwd=packages/core, expect_file=dist/index.js|dist/index.d.ts, match=/0 errors/i]: pnpm run typecheck',
			'  %% verify N1 [on_fail=fail, expect_exit=0]: pnpm test',
			'  %% check N2 [expect_file=REPORT.md, host=bupt208]',
			'  %% check G1: echo should-ignore-gates',
		].join('\n'));

		assert.strictEqual(graph.error, undefined);
		const n1 = graph.nodes.find(n => n.id === 'N1');
		const n2 = graph.nodes.find(n => n.id === 'N2');
		const g1 = graph.nodes.find(n => n.id === 'G1');
		assert.strictEqual(n1?.checks?.length, 2);
		assert.strictEqual(n1?.checks?.[0].name, 'typecheck');
		assert.strictEqual(n1?.checks?.[0].command, 'pnpm run typecheck');
		assert.strictEqual(n1?.checks?.[0].timeoutMs, 90_000);
		assert.strictEqual(n1?.checks?.[0].onFail, 'bounce');
		assert.strictEqual(n1?.checks?.[0].maxAutoRetries, 3);
		assert.strictEqual(n1?.checks?.[0].cwd, 'packages/core');
		assert.deepStrictEqual(n1?.checks?.[0].expectFiles, ['dist/index.js', 'dist/index.d.ts']);
		assert.strictEqual(n1?.checks?.[0].expectOutputMatch, '/0 errors/i');
		assert.strictEqual(n1?.checks?.[1].command, 'pnpm test');
		assert.strictEqual(n1?.checks?.[1].onFail, 'fail');
		assert.strictEqual(n1?.checks?.[1].expectExitCode, 0);

		assert.strictEqual(n2?.checks?.length, 1);
		assert.strictEqual(n2?.checks?.[0].command, undefined);
		assert.deepStrictEqual(n2?.checks?.[0].expectFiles, ['REPORT.md']);
		assert.strictEqual(n2?.checks?.[0].hostAlias, 'bupt208');
		assert.strictEqual(g1?.checks, undefined, 'Human Gate nodes do not accept task check hooks');
	});

	test('clamps wide parallel layers (7+ siblings) to strictly positive bounds in both LR and TD, routes vertical TD orthogonally, and sizes CJK edge labels accurately', () => {
		// 1. LR 7 parallel nodes in a single layer -> ZERO negative top/left coordinates!
		const lrWide = parseMissionMermaidDag([
			'flowchart LR',
			'  S["Start"] --> P1["B1"]',
			'  S --> P2["B2"]',
			'  S --> P3["B3"]',
			'  S --> P4["B4"]',
			'  S --> P5["B5"]',
			'  S --> P6["B6"]',
			'  S --> P7["B7"]',
		].join('\n'));
		const lrPos = computeMissionAutoLayout(lrWide);
		for (const [id, p] of lrPos.entries()) {
			assert.ok(p.x - MISSION_TASK_NODE_WIDTH / 2 >= 100, `LR node ${id} left edge must be >= 100, got ${p.x - MISSION_TASK_NODE_WIDTH / 2}`);
			assert.ok(p.y - MISSION_TASK_NODE_HEIGHT / 2 >= 100, `LR node ${id} top edge must be >= 100, got ${p.y - MISSION_TASK_NODE_HEIGHT / 2}`);
		}

		// 2. TD 7 parallel nodes in a single layer -> ZERO negative left/top coordinates & top-down layering!
		const tdWide = parseMissionMermaidDag([
			'flowchart TD',
			'  S["Start"] --> P1["B1"]',
			'  S --> P2["B2"]',
			'  S --> P3["B3"]',
			'  S --> P4["B4"]',
			'  S --> P5["B5"]',
			'  S --> P6["B6"]',
			'  S --> P7["B7"]',
		].join('\n'));
		assert.strictEqual(tdWide.direction, 'TD');
		const tdPos = computeMissionAutoLayout(tdWide);
		assert.ok(tdPos.get('S')!.y < tdPos.get('P1')!.y, 'TD parent sits above child');
		for (const [id, p] of tdPos.entries()) {
			assert.ok(p.x - MISSION_TASK_NODE_WIDTH / 2 >= 100, `TD node ${id} left edge must be >= 100, got ${p.x - MISSION_TASK_NODE_WIDTH / 2}`);
			assert.ok(p.y - MISSION_TASK_NODE_HEIGHT / 2 >= 100, `TD node ${id} top edge must be >= 100, got ${p.y - MISSION_TASK_NODE_HEIGHT / 2}`);
		}

		// 3. Vertical orthogonal routing (bottom-out -> top-in) produces strictly horizontal/vertical segments & obstacle detour
		const vRoute = computeOrthogonalRoundedEdgeRoute(300, 220, 620, 520, { orientation: 'vertical', cornerRadius: 14 });
		assert.ok(vRoute.path.includes('Q '), 'Vertical elbow includes smooth rounded Q corners');
		assert.strictEqual(vRoute.points[0].x, 300);
		assert.strictEqual(vRoute.points[0].y, 220);
		assert.strictEqual(vRoute.points[vRoute.points.length - 1].x, 620);
		assert.strictEqual(vRoute.points[vRoute.points.length - 1].y, 520);
		// First segment drops vertically (same X, increasing Y)
		assert.strictEqual(vRoute.points[1].x, 300);
		assert.ok(vRoute.points[1].y > 220);
		for (let i = 1; i < vRoute.points.length; i++) {
			const a = vRoute.points[i - 1];
			const b = vRoute.points[i];
			assert.ok(Math.abs(a.x - b.x) < 0.1 || Math.abs(a.y - b.y) < 0.1, 'Every vertical-mode segment must be strictly orthogonal');
		}

		// 4. CJK edge label width measurement gives wide glyphs proper pill width and truncates extreme labels gracefully
		const cjkWidth = measureMissionEdgeLabelTextWidth('失败降级路由');
		const asciiWidth = measureMissionEdgeLabelTextWidth('abcdef');
		assert.ok(cjkWidth > asciiWidth * 1.5, `CJK text width (${cjkWidth}) must be substantially wider than ASCII (${asciiWidth})`);
		const cjkPill = computeMissionEdgeLabelLayout('审批不通过打回重做');
		assert.strictEqual(cjkPill.displayText, '审批不通过打回重做');
		assert.ok(cjkPill.pillWidth >= 120, `9-char Chinese label pill width should be >=120px, got ${cjkPill.pillWidth}`);
		const longPill = computeMissionEdgeLabelLayout('这是一段极其冗长的中文边标签说明文本用于验证胶囊最大宽度截断保护机制');
		assert.ok(longPill.displayText.endsWith('…'), 'Extreme labels truncate with ellipsis inside capsule');
		assert.ok(longPill.pillWidth <= 260, `Truncated pill width stays within cap, got ${longPill.pillWidth}`);
	});

	test('validates all curated 1-click DAG templates and lossless Mermaid visual authoring mutations', () => {
		// 1. All curated templates parse cleanly, lay out cleanly, and reference valid reviewer nodes
		assert.ok(MISSION_DAG_TEMPLATES.length >= 4, 'At least 4 curated templates');
		for (const tpl of MISSION_DAG_TEMPLATES) {
			const parsed = parseMissionMermaidDag(tpl.mermaidText);
			assert.strictEqual(parsed.error, undefined, `Template "${tpl.id}" must parse cleanly: ${parsed.error}`);
			assert.ok(parsed.nodes.length >= 2, `Template "${tpl.id}" has >= 2 nodes`);
			assert.ok(parsed.edges.length >= 1, `Template "${tpl.id}" has >= 1 edge`);
			const pos = computeMissionAutoLayout(parsed);
			assert.strictEqual(pos.size, parsed.nodes.length, `Template "${tpl.id}" lays out all nodes`);
			for (const revId of tpl.reviewerNodeIds ?? []) {
				assert.ok(parsed.nodes.some(n => n.id === revId && n.kind === 'task'), `Template "${tpl.id}" reviewer ${revId} must be a task node`);
			}
		}
		const researchTpl = MISSION_DAG_TEMPLATES.find(t => t.id === 'multi-gpu-research')!;
		const researchParsed = parseMissionMermaidDag(researchTpl.mermaidText);
		assert.ok(researchParsed.edges.some(e => e.from === 'R2' && e.to === 'F1' && getMissionEdgeKind(e) === 'fail'), 'Research template includes on_fail fallback edge');
		assert.strictEqual(researchParsed.nodes.find(n => n.id === 'R4')?.checks?.[0]?.expectFiles?.[0], 'research/benchmarks/metrics.json');

		// 2. addNodeToMermaid builds from empty text with distinct IDs for task / reviewer / gate
		const step1 = addNodeToMermaid('', { kind: 'task', label: 'Spec & Plan', employeeName: 'Architect' });
		assert.strictEqual(step1.nodeId, 'N1');
		const step2 = addNodeToMermaid(step1.mermaidText, { kind: 'task', roleHint: 'reviewer', label: 'Code Review' });
		assert.strictEqual(step2.nodeId, 'R1');
		const step3 = addNodeToMermaid(step2.mermaidText, { kind: 'gate', label: 'Ship Sign-Off' });
		assert.strictEqual(step3.nodeId, 'U1');

		const parsed3 = parseMissionMermaidDag(step3.mermaidText);
		assert.strictEqual(parsed3.error, undefined);
		assert.deepStrictEqual(parsed3.nodes.map(n => [n.id, n.kind]), [['N1', 'task'], ['R1', 'task'], ['U1', 'gate']]);
		assert.strictEqual(parsed3.nodes[0].employeeName, 'Architect');

		// 3. addEdgeToMermaid supports regular + fail edges and rejects self-loops, duplicates, and cycles
		const e1 = addEdgeToMermaid(step3.mermaidText, 'N1', 'R1');
		assert.strictEqual(e1.ok, true);
		const e2 = addEdgeToMermaid(e1.mermaidText!, 'R1', 'U1', { kind: 'fail', label: 'fail' });
		assert.strictEqual(e2.ok, true);
		assert.strictEqual(addEdgeToMermaid(e2.mermaidText!, 'N1', 'N1').ok, false, 'Rejects self-loop');
		assert.strictEqual(addEdgeToMermaid(e2.mermaidText!, 'N1', 'R1').ok, false, 'Rejects duplicate edge');
		assert.strictEqual(addEdgeToMermaid(e2.mermaidText!, 'U1', 'N1').ok, false, 'Rejects cycle');

		// 4. renameNodeInMermaid preserves @Employee, :::Class, Gate {{...}}, and %% check comments
		const withCheck = `${e2.mermaidText!}\n  %% check R1 [name=tests]: pnpm test\n  %% check N1 [name=spec, expect_file=spec.md]`;
		const renamed1 = renameNodeInMermaid(withCheck, 'N1', 'API Contract v2');
		const renamed2 = renameNodeInMermaid(renamed1, 'U1', 'Release Gate v2');
		const parsedRenamed = parseMissionMermaidDag(renamed2);
		assert.strictEqual(parsedRenamed.error, undefined);
		assert.strictEqual(parsedRenamed.nodes.find(n => n.id === 'N1')?.label, 'API Contract v2');
		assert.strictEqual(parsedRenamed.nodes.find(n => n.id === 'N1')?.employeeName, 'Architect', 'Inline @Employee preserved across rename');
		assert.strictEqual(parsedRenamed.nodes.find(n => n.id === 'U1')?.kind, 'gate', 'Gate shape preserved across rename');
		assert.strictEqual(parsedRenamed.nodes.find(n => n.id === 'U1')?.label, 'Release Gate v2');
		assert.strictEqual(parsedRenamed.nodes.find(n => n.id === 'R1')?.checks?.length, 1, '%% check preserved across rename');

		// 5. toggleEdgeFailInMermaid & removeEdgeFromMermaid & removeNodeFromMermaid
		const toggled = toggleEdgeFailInMermaid(renamed2, 'R1', 'U1');
		const parsedToggled = parseMissionMermaidDag(toggled);
		assert.strictEqual(getMissionEdgeKind(parsedToggled.edges.find(e => e.from === 'R1' && e.to === 'U1')!), 'success', 'Toggled fail edge back to success');

		const toggledFail = toggleEdgeFailInMermaid(toggled, 'N1', 'R1');
		assert.strictEqual(getMissionEdgeKind(parseMissionMermaidDag(toggledFail).edges.find(e => e.from === 'N1' && e.to === 'R1')!), 'fail', 'Toggled success edge to fail');

		const edgeRemoved = removeEdgeFromMermaid(toggledFail, 'N1', 'R1');
		const parsedEdgeRemoved = parseMissionMermaidDag(edgeRemoved);
		assert.strictEqual(parsedEdgeRemoved.edges.some(e => e.from === 'N1' && e.to === 'R1'), false, 'Edge removed cleanly');
		assert.strictEqual(parsedEdgeRemoved.nodes.length, 3, 'Endpoints retained after edge removal');

		const nodeRemoved = removeNodeFromMermaid(toggledFail, 'R1');
		const parsedNodeRemoved = parseMissionMermaidDag(nodeRemoved);
		assert.strictEqual(parsedNodeRemoved.nodes.some(n => n.id === 'R1'), false, 'Node R1 removed');
		assert.strictEqual(parsedNodeRemoved.edges.length, 0, 'Incident edges removed with R1');
		assert.strictEqual(parsedNodeRemoved.nodes.find(n => n.id === 'N1')?.checks?.length, 1, 'Surviving node N1 check preserved');
		assert.ok(!nodeRemoved.includes('%% check R1'), 'Deleted node check directive pruned');
	});
});
