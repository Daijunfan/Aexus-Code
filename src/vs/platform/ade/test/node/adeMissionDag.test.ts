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
});
