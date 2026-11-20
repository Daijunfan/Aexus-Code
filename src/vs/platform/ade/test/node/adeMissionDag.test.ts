/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	buildOrthogonalRoundedEdgePath,
	computeMissionAutoLayout,
	computeMissionWorldSize,
	computeOrthogonalRoundedEdgeRoute,
	parseMissionMermaidDag,
	setNodeEmployeeInMermaid,
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
			assert.ok(fs.existsSync(paths.rankDocs['L0']));
			assert.ok(fs.existsSync(paths.rankDocs['L1']));

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
});
