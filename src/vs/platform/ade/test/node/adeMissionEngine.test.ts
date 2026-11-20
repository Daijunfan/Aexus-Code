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
	ADE_API_LATEST_REVISION,
	ADE_API_SPEC_CATALOG,
	queryApiUpdateDiff,
} from '../../common/adeApiRegistry.js';
import { syncAdeApiDocsToDisk } from '../../node/adeDocsSync.js';
import {
	getMissionEdgeKind,
	getMissionSourceNodes,
	IMissionDagParseResult,
	parseMissionMermaidDag,
} from '../../common/adeMissionDag.js';
import {
	findDirectSupervisorForNode,
	findParentSupervisorForEscalation,
	IMissionBoundaryConfig,
	resolveSupervisorJurisdiction,
	validateMissionFactoryBoundary,
} from '../../common/adeMissionBoundary.js';
import {
	applySafeMissionPatch,
	blockMissionToken,
	completeMissionToken,
	createInitialMissionRuntimeState,
	escalateMissionIssue,
	expandTracePointer,
	failMissionToken,
	fireMissionSourceTrigger,
	IMissionRuntimeState,
	IMissionSourceTrigger,
	IMissionToken,
	matchesCronExpression,
	pauseMissionRun,
	recallMissionTokens,
	recordWatchdogWakeup,
	rejectMissionToken,
	resolveMissionGate,
	resumeMissionRun,
	setMissionSilenceTimeout,
	startMissionRun,
	stopMissionRun,
	validateSourceTrigger,
} from '../../common/adeMissionEngine.js';
import {
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	IAdeOrganizationConfig,
} from '../../common/adeRoleSchema.js';

const ORG = DEFAULT_ADE_ORGANIZATION_CONFIG;

const ONE_TIER_ORG: IAdeOrganizationConfig = {
	version: 1,
	ranks: [ORG.ranks[0]],
};

function parseGraph(text: string): IMissionDagParseResult {
	const graph = parseMissionMermaidDag(text);
	assert.strictEqual(graph.error, undefined, `Unexpected Mermaid parse error: ${graph.error}`);
	return graph;
}

function createState(
	graph: IMissionDagParseResult,
	boundary?: IMissionBoundaryConfig,
	silenceTimeoutMinutes = 5,
): IMissionRuntimeState {
	const base = createInitialMissionRuntimeState(
		'mission-test',
		ORG,
		undefined,
		graph.nodes.map(n => n.id),
		silenceTimeoutMinutes,
	);
	return boundary ? { ...base, boundary } : base;
}

function activeTokenOn(state: IMissionRuntimeState, nodeId: string): IMissionToken | undefined {
	return Object.values(state.tokens).find(t => t.nodeId === nodeId && (t.status === 'active' || t.status === 'blocked'));
}

suite('ADE Mission Factory Boundary (Off-Graph Supervisors vs In-Graph Employees)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts a valid 4-tier split where L1 supervises off-graph and L2..L4 work in-graph', () => {
		const graph = parseGraph('flowchart LR\n  N1 --> N2\n  N2 --> N3');
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 1,
			supervisors: [{ id: 'sup-l1', tier: 1, managedNodeIds: ['N1'] }],
			nodeAssignments: {
				N1: { tier: 2 },
				N2: { tier: 3 },
				N3: { tier: 4 },
			},
		};
		const result = validateMissionFactoryBoundary(ORG, boundary, graph);
		assert.strictEqual(result.valid, true, result.errors.join(' '));
		assert.deepStrictEqual([...result.offGraphTiers], [1]);
		assert.deepStrictEqual([...result.inGraphTiers], [2, 3, 4]);
	});

	test('accepts a valid single-tier organization where only L0 is off-graph and L1 works in-graph', () => {
		const graph = parseGraph('flowchart LR\n  N1 --> N2');
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 0,
			supervisors: [{ id: 'secretary', tier: 0, managedNodeIds: ['N1'] }],
			nodeAssignments: { N1: { tier: 1 } },
		};
		const result = validateMissionFactoryBoundary(ONE_TIER_ORG, boundary, graph);
		assert.strictEqual(ONE_TIER_ORG.ranks.length, 1);
		assert.strictEqual(result.valid, true, result.errors.join(' '));
		assert.deepStrictEqual([...result.offGraphTiers], [0]);
		assert.deepStrictEqual([...result.inGraphTiers], [1]);
	});

	test('rejects the same tier being used on BOTH sides of the factory wall', () => {
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 2,
			supervisors: [{ id: 'sup-l2', tier: 2, managedNodeIds: ['N1'] }],
			nodeAssignments: { N1: { tier: 2 } },
		};
		const result = validateMissionFactoryBoundary(ORG, boundary);
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('BOTH')), result.errors.join(' '));
	});

	test('rejects an off-graph tier above the cutoff and an in-graph tier at/below the cutoff', () => {
		const offGraphViolation = validateMissionFactoryBoundary(ORG, {
			offGraphMaxTier: 1,
			supervisors: [{ id: 'sup-l2', tier: 2, managedNodeIds: [] }],
			nodeAssignments: {},
		});
		assert.strictEqual(offGraphViolation.valid, false);
		assert.ok(offGraphViolation.errors.some(e => e.includes('inside the in-graph execution layer')), offGraphViolation.errors.join(' '));

		const inGraphViolation = validateMissionFactoryBoundary(ORG, {
			offGraphMaxTier: 1,
			supervisors: [],
			nodeAssignments: { N1: { tier: 1 } },
		});
		assert.strictEqual(inGraphViolation.valid, false);
		assert.ok(inGraphViolation.errors.some(e => e.includes('off-graph supervisor layer')), inGraphViolation.errors.join(' '));

		const badCutoff = validateMissionFactoryBoundary(ORG, {
			offGraphMaxTier: 4,
			supervisors: [],
			nodeAssignments: {},
		});
		assert.strictEqual(badCutoff.valid, false);
		assert.ok(badCutoff.errors.some(e => e.includes('offGraphMaxTier must be an integer')), badCutoff.errors.join(' '));
	});

	test('rejects an off-graph supervisor session occupying a DAG task node', () => {
		const result = validateMissionFactoryBoundary(ORG, {
			offGraphMaxTier: 1,
			supervisors: [{ id: 'sup-l1', tier: 1, managedNodeIds: ['N1'] }],
			nodeAssignments: { N1: { agentId: 'sup-l1', tier: 2 } },
		});
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('cannot occupy in-graph DAG node')), result.errors.join(' '));
	});

	test('rejects inverted parent tiers and escalation cycles', () => {
		const inverted = validateMissionFactoryBoundary(ORG, {
			offGraphMaxTier: 2,
			supervisors: [
				{ id: 'l1', tier: 1, managedNodeIds: [], parentSupervisorId: 'l2' },
				{ id: 'l2', tier: 2, managedNodeIds: [] },
			],
			nodeAssignments: {},
		});
		assert.strictEqual(inverted.valid, false);
		assert.ok(inverted.errors.some(e => e.includes('strictly higher authority')), inverted.errors.join(' '));

		const cyclic = validateMissionFactoryBoundary(ORG, {
			offGraphMaxTier: 2,
			supervisors: [
				{ id: 'l1', tier: 1, managedNodeIds: [], parentSupervisorId: 'l2' },
				{ id: 'l2', tier: 2, managedNodeIds: [], parentSupervisorId: 'l1' },
			],
			nodeAssignments: {},
		});
		assert.strictEqual(cyclic.valid, false);
		assert.ok(cyclic.errors.some(e => e.includes('Cycle detected')), cyclic.errors.join(' '));
	});

	test('resolves free non-contiguous jump-node jurisdiction and transitive subordinate rollup', () => {
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 2,
			supervisors: [
				{ id: 'sup-root', tier: 1, managedNodeIds: ['N1', 'N4'], managedSupervisorIds: ['sup-mid'] },
				{ id: 'sup-mid', tier: 2, managedNodeIds: ['N2', 'N3'] },
			],
			nodeAssignments: {},
		};
		const allNodes = ['N1', 'N2', 'N3', 'N4', 'N5'];
		const root = resolveSupervisorJurisdiction(boundary, 'sup-root', allNodes);
		assert.strictEqual(root.hasFullJurisdiction, false);
		assert.deepStrictEqual([...root.nodeIds].sort(), ['N1', 'N2', 'N3', 'N4']);
		assert.ok(root.supervisorIds.has('sup-mid'));
		assert.ok(!root.supervisorIds.has('sup-root'));

		const human = resolveSupervisorJurisdiction(boundary, 'anyone', allNodes, { isHumanUser: true });
		assert.strictEqual(human.hasFullJurisdiction, true);
		assert.strictEqual(human.nodeIds.size, allNodes.length);

		const secretary = resolveSupervisorJurisdiction(boundary, 'anyone', allNodes, { isSecretary: true });
		assert.strictEqual(secretary.hasFullJurisdiction, true);
		assert.deepStrictEqual([...secretary.supervisorIds].sort(), ['sup-mid', 'sup-root']);

		const owner = resolveSupervisorJurisdiction(boundary, 'owner-session', allNodes, { ownerSessionId: 'owner-session' });
		assert.strictEqual(owner.hasFullJurisdiction, true);

		const unknown = resolveSupervisorJurisdiction(boundary, 'nobody', allNodes);
		assert.strictEqual(unknown.hasFullJurisdiction, false);
		assert.strictEqual(unknown.nodeIds.size, 0);
	});

	test('finds the closest direct supervisor and escalates L2 -> L1 -> Human Inbox (undefined)', () => {
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 2,
			supervisors: [
				{ id: 'l1', tier: 1, managedNodeIds: ['A'] },
				{ id: 'l2', tier: 2, managedNodeIds: ['A', 'B'], parentSupervisorId: 'l1' },
			],
			nodeAssignments: {},
		};
		assert.strictEqual(findDirectSupervisorForNode(boundary, 'A')?.id, 'l2');
		assert.strictEqual(findDirectSupervisorForNode(boundary, 'B')?.id, 'l2');
		assert.strictEqual(findDirectSupervisorForNode(boundary, 'unknown')?.id, 'l1', 'falls back to highest-authority supervisor');

		assert.strictEqual(findParentSupervisorForEscalation(boundary, 'l2')?.id, 'l1');
		assert.strictEqual(findParentSupervisorForEscalation(boundary, 'l1'), undefined, 'L1 escalates directly to Human Inbox');
		assert.strictEqual(findParentSupervisorForEscalation(boundary, 'missing'), undefined);
	});
});

suite('ADE API Registry Revision Diff & Single-Copy Docs Sync', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let tmpDir = '';

	setup(async () => {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aexus-ade-docs-'));
	});

	teardown(async () => {
		if (tmpDir) {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
			tmpDir = '';
		}
	});

	test('immutable api update diff returns all revisions, scoped additions, and up-to-date state', () => {
		const all = queryApiUpdateDiff(0);
		assert.strictEqual(all.contractVersion, 1);
		assert.strictEqual(all.currentRevision, ADE_API_LATEST_REVISION);
		assert.strictEqual(all.sinceRevision, 0);
		assert.strictEqual(all.upToDate, false);
		assert.strictEqual(all.added.length, ADE_API_SPEC_CATALOG.length);

		const inGraph = queryApiUpdateDiff(1, 'in_graph');
		assert.strictEqual(inGraph.scope, 'in_graph');
		assert.strictEqual(inGraph.added.length, 6);
		assert.ok(inGraph.added.every(entry => entry.scope === 'in_graph' && entry.addedInRevision >= 2));
		assert.deepStrictEqual(
			inGraph.added.map(entry => entry.id).sort(),
			[
				'in_graph.token.block',
				'in_graph.token.complete',
				'in_graph.token.current',
				'in_graph.token.fail',
				'in_graph.token.reject',
				'in_graph.token.trace',
			],
		);

		const mission = queryApiUpdateDiff(2, 'mission');
		assert.strictEqual(mission.scope, 'mission');
		assert.deepStrictEqual(
			mission.added.map(entry => entry.id).sort(),
			[
				'mission.boundary',
				'mission.host.bind',
				'mission.patch',
				'mission.recall',
				'mission.trigger',
			],
		);
		assert.strictEqual(mission.modified.length, 0);

		const missionFromRev1 = queryApiUpdateDiff(1, 'mission');
		assert.ok(missionFromRev1.modified.some(entry => entry.id === 'mission.blueprint'), 'modified APIs surface via `modified`');

		const current = queryApiUpdateDiff(ADE_API_LATEST_REVISION);
		assert.strictEqual(current.upToDate, true);
		assert.strictEqual(current.added.length, 0);
		assert.strictEqual(current.modified.length, 0);
		assert.strictEqual(current.deprecated.length, 0);
	});

	test('syncs single-copy COMMON/ranks/MISSION docs plus api-manifest into a temp home directory', async () => {
		const paths = await syncAdeApiDocsToDisk(tmpDir, ORG);

		const commonDoc = path.join(tmpDir, 'docs', 'common', 'COMMON_API.md');
		const manifest = path.join(tmpDir, 'docs', 'api-manifest.json');
		const missionDoc = path.join(tmpDir, 'docs', 'mission', 'MISSION_API.md');

		assert.strictEqual(paths.commonDoc, commonDoc);
		assert.strictEqual(paths.manifestFile, manifest);
		assert.strictEqual(paths.missionDoc, missionDoc);
		assert.ok(fs.existsSync(commonDoc));
		assert.ok(fs.existsSync(manifest));
		assert.ok(fs.existsSync(missionDoc));

		for (const tag of ['L0', 'L1', 'L2', 'L3', 'L4']) {
			const rankDoc = path.join(tmpDir, 'docs', 'ranks', `${tag}.md`);
			assert.strictEqual(paths.rankDocs[tag], rankDoc);
			assert.ok(fs.existsSync(rankDoc), `expected single-copy rank doc ${tag}`);
		}
		assert.strictEqual(Object.keys(paths.rankDocs).length, 5);

		const manifestJson = JSON.parse(await fs.promises.readFile(manifest, 'utf8'));
		assert.strictEqual(manifestJson.contractVersion, 1);
		assert.strictEqual(manifestJson.currentRevision, ADE_API_LATEST_REVISION);
		assert.strictEqual(manifestJson.rankCount, ORG.ranks.length);
		assert.strictEqual(manifestJson.apis.length, ADE_API_SPEC_CATALOG.length);

		const commonText = await fs.promises.readFile(commonDoc, 'utf8');
		assert.ok(commonText.includes(`Current API Revision: **${ADE_API_LATEST_REVISION}**`));
		const missionText = await fs.promises.readFile(missionDoc, 'utf8');
		assert.ok(missionText.includes('Unified Mission API Reference'));
	});
});

suite('ADE Mission DAG Dual-Polarity Edges & Source Nodes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('tags `-->|fail|` and `-.->|on_fail|` as fail edges while regular edges stay success', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  A -->|fail| F',
			'  A -.->|on_fail| G',
			'  A --> B',
			'  B --> C',
		].join('\n'));

		const failEdge = graph.edges.find(e => e.id === 'A->F');
		assert.ok(failEdge);
		assert.strictEqual(failEdge.edgeKind, 'fail');
		assert.strictEqual(getMissionEdgeKind(failEdge), 'fail');

		const onFailEdge = graph.edges.find(e => e.id === 'A->G');
		assert.ok(onFailEdge);
		assert.strictEqual(onFailEdge.edgeKind, 'fail');

		const regularEdge = graph.edges.find(e => e.id === 'A->B');
		assert.ok(regularEdge);
		assert.strictEqual(regularEdge.edgeKind, undefined);
		assert.strictEqual(getMissionEdgeKind(regularEdge), 'success');
		assert.strictEqual(getMissionEdgeKind({ label: 'on_fail' }), 'fail');
	});

	test('getMissionSourceNodes returns exactly the inDegree === 0 nodes', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  A --> B',
			'  A --> C',
			'  B --> D',
			'  C --> D',
			'  S["Standalone Source"]',
		].join('\n'));
		const sources = getMissionSourceNodes(graph).map(n => n.id);
		assert.deepStrictEqual([...sources].sort(), ['A', 'S']);
		assert.ok(!sources.includes('B'));
		assert.ok(!sources.includes('D'));
	});
});

suite('ADE Mission Engine Full State-Machine Lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('startMissionRun locks silence timeout and setMissionSilenceTimeout fails LOCKED_CONFIG while running', () => {
		const graph = parseGraph('flowchart LR\n  A --> B');
		const state = createState(graph, undefined, 5);

		const started = startMissionRun(state, graph, ORG, { silenceTimeoutMinutes: 9, initialPrompt: 'Kick off', now: 1_000 });
		assert.strictEqual(started.ok, true);
		assert.strictEqual(started.state.status, 'running');
		assert.strictEqual(started.state.silenceTimeoutMinutes, 9);
		assert.strictEqual(started.state.silenceTimeoutLocked, true);
		assert.deepStrictEqual(started.data!.mintedTokenIds.length, 1);
		assert.ok(activeTokenOn(started.state, 'A'));

		const locked = setMissionSilenceTimeout(started.state, 30, 2_000);
		assert.strictEqual(locked.ok, false);
		assert.strictEqual(locked.code, 'LOCKED_CONFIG');
		assert.strictEqual(locked.state.silenceTimeoutMinutes, 9, 'locked config must not change');

		const restarted = startMissionRun(started.state, graph, ORG, { now: 3_000 });
		assert.strictEqual(restarted.ok, false);
		assert.strictEqual(restarted.code, 'INVALID_STATE');

		const paused = pauseMissionRun(started.state, 4_000);
		assert.strictEqual(paused.ok, true);
		assert.strictEqual(paused.state.status, 'paused');
		const resumed = resumeMissionRun(paused.state, 5_000);
		assert.strictEqual(resumed.ok, true);
		assert.strictEqual(resumed.state.status, 'running');
		const stopped = stopMissionRun(resumed.state, 6_000);
		assert.strictEqual(stopped.ok, true);
		assert.strictEqual(stopped.state.status, 'stopped');
		assert.strictEqual(stopped.state.silenceTimeoutLocked, false);
	});

	test('completeMissionToken rolls lastSummary into bounded compressedHistory and extends the expandable trace pointer over 16 hops', () => {
		const hopCount = 16;
		const lines = ['flowchart LR'];
		for (let i = 0; i < hopCount; i++) {
			lines.push(`  N${i} --> N${i + 1}`);
		}
		const graph = parseGraph(lines.join('\n'));
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;

		const summaries: string[] = [];
		for (let i = 0; i < hopCount; i++) {
			const token = activeTokenOn(state, `N${i}`);
			assert.ok(token, `expected an active token on N${i}`);
			const summary = `Step ${i}: ${'x'.repeat(180)}`;
			summaries.push(summary);
			const result = completeMissionToken(state, graph, { tokenId: token.id, summary, now: 2_000 + i });
			assert.strictEqual(result.ok, true, result.error);
			state = result.state;
			assert.strictEqual(result.data!.nextTokenIds.length, 1);
			const next = state.tokens[result.data!.nextTokenIds[0]];
			assert.strictEqual(next.nodeId, `N${i + 1}`);
			assert.strictEqual(next.lastSummary, summary, 'previous summary becomes the next lastSummary');
		}

		const finalToken = activeTokenOn(state, `N${hopCount}`);
		assert.ok(finalToken);
		assert.strictEqual(finalToken.lastSummary, summaries[hopCount - 1]);
		assert.ok(finalToken.compressedHistory.length <= 1200, `history must stay bounded (got ${finalToken.compressedHistory.length})`);
		assert.ok(finalToken.compressedHistory.includes('earlier step(s) condensed'), finalToken.compressedHistory);
		assert.ok(finalToken.compressedHistory.split('\n').length < hopCount, 'old hops are condensed');

		const expanded = expandTracePointer(state, finalToken.tracePtr);
		assert.strictEqual(expanded[0].event, 'mint');
		assert.strictEqual(expanded.filter(entry => entry.event === 'complete').length, hopCount);
		assert.strictEqual(expanded.length, hopCount + 1);
		assert.ok(expanded.every(entry => entry.ptr && entry.waveId === finalToken.waveId));
	});

	test('forks parallel branches sharing one waveId and holds at the Join Barrier until ALL branches arrive', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  A --> B',
			'  A --> C',
			'  B --> J',
			'  C --> J',
		].join('\n'));
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const rootToken = activeTokenOn(state, 'A');
		assert.ok(rootToken);

		const forked = completeMissionToken(state, graph, { tokenId: rootToken.id, summary: 'alpha done', now: 2_000 });
		assert.strictEqual(forked.ok, true, forked.error);
		state = forked.state;
		assert.strictEqual(forked.data!.nextTokenIds.length, 2);
		const [bTokenId, cTokenId] = forked.data!.nextTokenIds;
		assert.strictEqual(state.tokens[bTokenId].waveId, rootToken.waveId);
		assert.strictEqual(state.tokens[cTokenId].waveId, rootToken.waveId);
		assert.notStrictEqual(bTokenId, cTokenId);

		const afterB = completeMissionToken(state, graph, { tokenId: bTokenId, summary: 'bravo done', now: 3_000 });
		assert.strictEqual(afterB.ok, true, afterB.error);
		state = afterB.state;
		assert.strictEqual(afterB.data!.nextTokenIds.length, 0, 'join must not fire with only one branch');
		assert.strictEqual(state.nodeStates.J, 'waiting_join');
		const barrierKeys = Object.keys(state.joinBarriers);
		assert.strictEqual(barrierKeys.length, 1);
		const barrier = state.joinBarriers[barrierKeys[0]];
		assert.strictEqual(barrier.targetNodeId, 'J');
		assert.deepStrictEqual([...barrier.expectedFromNodeIds].sort(), ['B', 'C']);
		assert.deepStrictEqual(Object.keys(barrier.arrivedByFrom), ['B']);

		const afterC = completeMissionToken(state, graph, { tokenId: cTokenId, summary: 'charlie done', now: 4_000 });
		assert.strictEqual(afterC.ok, true, afterC.error);
		state = afterC.state;
		assert.strictEqual(afterC.data!.nextTokenIds.length, 1);
		assert.strictEqual(Object.keys(state.joinBarriers).length, 0);

		const joinToken = state.tokens[afterC.data!.nextTokenIds[0]];
		assert.strictEqual(joinToken.nodeId, 'J');
		assert.strictEqual(joinToken.status, 'active');
		assert.ok(joinToken.lastSummary.includes('[B] bravo done'), joinToken.lastSummary);
		assert.ok(joinToken.lastSummary.includes('[C] charlie done'), joinToken.lastSummary);

		const expanded = expandTracePointer(state, joinToken.tracePtr);
		const joinTrace = expanded.find(entry => entry.event === 'join');
		assert.ok(joinTrace, 'join trace must be recorded');
		assert.strictEqual(joinTrace.parentPtrs.length, 2);
		assert.ok(expanded.filter(entry => entry.event === 'complete').length >= 2);
	});

	test('success path marks the unused fail-edge branch skipped so the join fires immediately (zero deadlock)', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  A --> B',
			'  B --> J',
			'  A -->|fail| F',
			'  F --> J',
		].join('\n'));
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);

		const afterA = completeMissionToken(state, graph, { tokenId: aToken.id, summary: 'A ok', now: 2_000 });
		state = afterA.state;
		assert.strictEqual(afterA.ok, true, afterA.error);
		const bToken = activeTokenOn(state, 'B');
		assert.ok(bToken, 'success edge dispatches B');
		assert.strictEqual(activeTokenOn(state, 'F'), undefined, 'fail branch is not dispatched');

		const barrier = Object.values(state.joinBarriers).find(b => b.targetNodeId === 'J');
		assert.ok(barrier, 'skipped fail branch registers on the join barrier');
		assert.deepStrictEqual([...barrier.skippedFromNodeIds], ['F']);

		const afterB = completeMissionToken(state, graph, { tokenId: bToken.id, summary: 'B ok', now: 3_000 });
		state = afterB.state;
		assert.strictEqual(afterB.ok, true, afterB.error);
		assert.strictEqual(afterB.data!.nextTokenIds.length, 1);
		assert.strictEqual(Object.keys(state.joinBarriers).length, 0, 'join barrier releases without waiting for skipped F');
		const joinToken = state.tokens[afterB.data!.nextTokenIds[0]];
		assert.strictEqual(joinToken.nodeId, 'J');
		assert.strictEqual(joinToken.status, 'active');
		assert.ok(joinToken.lastSummary.includes('[B] B ok'));
		assert.ok(!joinToken.lastSummary.includes('[F]'));
	});

	test('failure path routes to the fail edge, skips the success branch, and the join fires when F finishes', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  A --> B',
			'  B --> J',
			'  A -->|fail| F',
			'  F --> J',
		].join('\n'));
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);

		const failed = failMissionToken(state, graph, { tokenId: aToken.id, reason: 'A broke', now: 2_000 });
		assert.strictEqual(failed.ok, true, failed.error);
		state = failed.state;
		assert.strictEqual(failed.data!.routedViaFailEdge, true);
		const fToken = activeTokenOn(state, 'F');
		assert.ok(fToken, 'fail edge dispatches F');
		assert.strictEqual(activeTokenOn(state, 'B'), undefined, 'success branch is skipped');
		assert.strictEqual(state.nodeStates.B, 'idle');

		const barrier = Object.values(state.joinBarriers).find(b => b.targetNodeId === 'J');
		assert.ok(barrier);
		assert.deepStrictEqual([...barrier.skippedFromNodeIds], ['B']);

		const afterF = completeMissionToken(state, graph, { tokenId: fToken.id, summary: 'F recovered', now: 3_000 });
		state = afterF.state;
		assert.strictEqual(afterF.ok, true, afterF.error);
		assert.strictEqual(afterF.data!.nextTokenIds.length, 1);
		assert.strictEqual(Object.keys(state.joinBarriers).length, 0);
		const joinToken = state.tokens[afterF.data!.nextTokenIds[0]];
		assert.strictEqual(joinToken.nodeId, 'J');
		assert.strictEqual(joinToken.status, 'active');
		assert.ok(joinToken.lastSummary.includes('[F] F recovered'));
		assert.ok(!joinToken.lastSummary.includes('[B]'));
	});

	test('reviewer reject bounces the token upstream and records a `reject` trace without a static DAG cycle', () => {
		const graph = parseGraph('flowchart LR\n  A --> B');
		const edgeCountBefore = graph.edges.length;
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);
		const completed = completeMissionToken(state, graph, { tokenId: aToken.id, summary: 'A v1', now: 2_000 });
		state = completed.state;
		const bToken = activeTokenOn(state, 'B');
		assert.ok(bToken);

		const rejected = rejectMissionToken(state, graph, { tokenId: bToken.id, reason: 'needs fixes', now: 3_000 });
		assert.strictEqual(rejected.ok, true, rejected.error);
		state = rejected.state;
		assert.strictEqual(rejected.data!.targetNodeId, 'A');
		const bounced = state.tokens[rejected.data!.bouncedTokenId];
		assert.strictEqual(bounced.nodeId, 'A');
		assert.strictEqual(bounced.status, 'active');
		assert.ok(bounced.lastSummary.includes('Rejected by B'));
		assert.strictEqual(state.nodeStates.B, 'idle');

		const expanded = expandTracePointer(state, bounced.tracePtr);
		assert.ok(expanded.some(entry => entry.event === 'reject' && entry.nodeId === 'B'));

		assert.strictEqual(graph.edges.length, edgeCountBefore);
		assert.ok(!graph.edges.some(edge => edge.from === 'B' && edge.to === 'A'), 'rejection must not add a static cycle');
	});

	test('Human Gate approves forward and rejects/rolls back', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  A --> G{{"Approve"}}',
			'  G --> B',
		].join('\n'));
		assert.strictEqual(graph.nodes.find(n => n.id === 'G')?.kind, 'gate');

		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);
		const entered = completeMissionToken(state, graph, { tokenId: aToken.id, summary: 'ready', now: 2_000 });
		state = entered.state;
		const gateToken = Object.values(state.tokens).find(t => t.nodeId === 'G' && t.status === 'waiting_gate');
		assert.ok(gateToken, 'gate token waits for human review');
		assert.ok(entered.effects.some(effect => effect.kind === 'upsert_gate_inbox' && effect.nodeId === 'G'));

		const approved = resolveMissionGate(state, graph, { nodeId: 'G', decision: 'approve', note: 'LGTM', now: 3_000 });
		assert.strictEqual(approved.ok, true, approved.error);
		assert.strictEqual(approved.data!.nextTokenIds.length, 1);
		const bToken = approved.state.tokens[approved.data!.nextTokenIds[0]];
		assert.strictEqual(bToken.nodeId, 'B');
		assert.strictEqual(bToken.status, 'active');
		assert.strictEqual(approved.state.nodeStates.G, 'completed');
		assert.ok(expandTracePointer(approved.state, bToken.tracePtr).some(entry => entry.event === 'gate_approve'));
		assert.ok(bToken.lastSummary.includes('Gate G Approved'));

		let rejectState = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const rejectAToken = activeTokenOn(rejectState, 'A')!;
		rejectState = completeMissionToken(rejectState, graph, { tokenId: rejectAToken.id, summary: 'ready again', now: 2_000 }).state;
		const rejected = resolveMissionGate(rejectState, graph, { nodeId: 'G', decision: 'reject', note: 'not acceptable', now: 3_000 });
		assert.strictEqual(rejected.ok, true, rejected.error);
		assert.strictEqual(rejected.data!.nextTokenIds.length, 1);
		const rollbackToken = rejected.state.tokens[rejected.data!.nextTokenIds[0]];
		assert.strictEqual(rollbackToken.nodeId, 'A');
		assert.strictEqual(rollbackToken.status, 'active');
		assert.strictEqual(rejected.state.nodeStates.G, 'idle');
		assert.ok(expandTracePointer(rejected.state, rollbackToken.tracePtr).some(entry => entry.event === 'gate_reject'));
	});

	test('blockMissionToken and recordWatchdogWakeup support silence_timeout, pid_exited, file_ready and block_expired', () => {
		const graph = parseGraph('flowchart LR\n  A --> B');
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);

		const blocked = blockMissionToken(state, {
			tokenId: aToken.id,
			reason: 'awaiting build',
			maxDurationMs: 60_000,
			watchPid: 4242,
			watchFile: '/tmp/out.log',
			hostAlias: 'ssh-build',
			now: 2_000,
		});
		assert.strictEqual(blocked.ok, true, blocked.error);
		state = blocked.state;
		const blockedToken = state.tokens[aToken.id];
		assert.strictEqual(blockedToken.status, 'blocked');
		assert.strictEqual(state.nodeStates.A, 'blocked');
		assert.strictEqual(blockedToken.blocked?.expiresAt, 62_000);
		assert.strictEqual(blockedToken.blocked?.watchPid, 4242);
		assert.strictEqual(blockedToken.blocked?.watchFile, '/tmp/out.log');
		assert.strictEqual(blockedToken.blocked?.hostAlias, 'ssh-build');

		const badSilence = recordWatchdogWakeup(state, { tokenId: aToken.id, reason: 'silence_timeout', now: 3_000 });
		assert.strictEqual(badSilence.ok, false);
		assert.strictEqual(badSilence.code, 'INVALID_STATE');

		const pidExited = recordWatchdogWakeup(state, { tokenId: aToken.id, reason: 'pid_exited', detail: 'pid 4242', now: 3_500 });
		assert.strictEqual(pidExited.ok, true);
		state = pidExited.state;
		assert.strictEqual(state.tokens[aToken.id].status, 'active');
		assert.strictEqual(state.tokens[aToken.id].blocked, undefined);
		const pidEffect = pidExited.effects.find(effect => effect.kind === 'wakeup_agent');
		assert.ok(pidEffect && pidEffect.kind === 'wakeup_agent');
		assert.strictEqual(pidEffect.wakeupReason, 'pid_exited');

		const nudge = recordWatchdogWakeup(state, { tokenId: aToken.id, reason: 'silence_timeout', now: 4_000 });
		assert.strictEqual(nudge.ok, true);
		state = nudge.state;
		assert.strictEqual(state.tokens[aToken.id].nudgeCount, 1);
		assert.ok(nudge.effects.some(effect => effect.kind === 'wakeup_agent' && effect.wakeupReason === 'silence_timeout'));

		state = blockMissionToken(state, { tokenId: aToken.id, reason: 'wait file', maxDurationMs: 30_000, now: 5_000 }).state;
		const fileReady = recordWatchdogWakeup(state, { tokenId: aToken.id, reason: 'file_ready', detail: '/tmp/out.log', now: 5_500 });
		assert.strictEqual(fileReady.ok, true);
		state = fileReady.state;
		assert.ok(fileReady.effects.some(effect => effect.kind === 'wakeup_agent' && effect.wakeupReason === 'file_ready'));

		state = blockMissionToken(state, { tokenId: aToken.id, reason: 'wait longer', maxDurationMs: 10_000, now: 6_000 }).state;
		const expired = recordWatchdogWakeup(state, { tokenId: aToken.id, reason: 'block_expired', now: 7_000 });
		assert.strictEqual(expired.ok, true);
		assert.ok(expired.effects.some(effect => effect.kind === 'wakeup_agent' && effect.wakeupReason === 'block_expired'));
	});

	test('failure with no fail edge freezes the token and escalates L2 -> L1 -> critical Human Inbox alert', () => {
		const graph = parseGraph('flowchart LR\n  A --> B');
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 2,
			supervisors: [
				{ id: 'l1', tier: 1, managedNodeIds: [] },
				{ id: 'l2', tier: 2, managedNodeIds: ['A'], parentSupervisorId: 'l1' },
			],
			nodeAssignments: {},
		};
		let state = startMissionRun(createState(graph, boundary), graph, ORG, { now: 1_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);

		const failed = failMissionToken(state, graph, { tokenId: aToken.id, reason: 'unrecoverable root cause', now: 2_000 });
		assert.strictEqual(failed.ok, true, failed.error);
		state = failed.state;
		assert.strictEqual(failed.data!.routedViaFailEdge, false);
		assert.strictEqual(failed.data!.escalatedToSupervisorId, 'l2');
		const frozen = state.tokens[aToken.id];
		assert.strictEqual(frozen.status, 'frozen_failed');
		assert.strictEqual(frozen.failure?.escalatedToSupervisorId, 'l2');
		assert.strictEqual(frozen.failure?.escalationHistory.length, 1);
		assert.ok(failed.effects.some(effect => effect.kind === 'escalate_to_supervisor' && effect.supervisorId === 'l2'));

		const toL1 = escalateMissionIssue(state, { callerSupervisorId: 'l2', reason: 'needs mission owner guidance', tokenId: aToken.id, now: 3_000 });
		assert.strictEqual(toL1.ok, true);
		assert.strictEqual(toL1.data!.escalatedToSupervisorId, 'l1');
		assert.strictEqual(toL1.data!.escalatedToInbox, false);
		state = toL1.state;
		assert.strictEqual(state.tokens[aToken.id].failure?.escalationHistory.length, 2);
		assert.ok(toL1.effects.some(effect => effect.kind === 'escalate_to_supervisor' && effect.supervisorId === 'l1'));

		const toInbox = escalateMissionIssue(state, { callerSupervisorId: 'l1', reason: 'human decision required', tokenId: aToken.id, now: 4_000 });
		assert.strictEqual(toInbox.ok, true);
		assert.strictEqual(toInbox.data!.escalatedToInbox, true);
		state = toInbox.state;
		const inboxEffect = toInbox.effects.find(effect => effect.kind === 'post_inbox');
		assert.ok(inboxEffect && inboxEffect.kind === 'post_inbox');
		assert.strictEqual(inboxEffect.severity, 'critical');
		assert.strictEqual(state.tokens[aToken.id].failure?.escalatedToInbox, true);
		const history = state.tokens[aToken.id].failure!.escalationHistory;
		assert.strictEqual(history.length, 3);
		assert.strictEqual(history[2].fromId, 'l1');
		assert.strictEqual(history[2].toId, 'human-inbox');
	});

	test('recallMissionTokens succeeds inside jurisdiction and rejects OUT_OF_JURISDICTION with parentSupervisorId', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  A --> B',
			'  C --> D',
		].join('\n'));
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 1,
			supervisors: [
				{ id: 'sec0', tier: 0, managedNodeIds: ['C', 'D'] },
				{ id: 'supA', tier: 1, managedNodeIds: ['A', 'B'], parentSupervisorId: 'sec0' },
			],
			nodeAssignments: {},
		};
		const state = startMissionRun(createState(graph, boundary), graph, ORG, { now: 1_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);
		assert.ok(activeTokenOn(state, 'C'));

		const inScope = recallMissionTokens(state, graph, {
			caller: { sessionId: 'supA', tier: 1 },
			nodeIds: ['A', 'B'],
			reason: 'replan branch A',
			now: 2_000,
		});
		assert.strictEqual(inScope.ok, true, inScope.error);
		assert.deepStrictEqual([...inScope.data!.recalledTokenIds], [aToken.id]);
		assert.deepStrictEqual([...inScope.data!.affectedNodeIds], ['A']);
		assert.strictEqual(inScope.state.tokens[aToken.id].status, 'recalled');
		assert.ok(inScope.effects.some(effect => effect.kind === 'stop_agent' && effect.nodeId === 'A'));
		assert.ok(activeTokenOn(inScope.state, 'C'), 'out-of-jurisdiction branch C is untouched');

		const outOfScope = recallMissionTokens(inScope.state, graph, {
			caller: { sessionId: 'supA', tier: 1 },
			nodeIds: ['C'],
			now: 3_000,
		});
		assert.strictEqual(outOfScope.ok, false);
		assert.strictEqual(outOfScope.code, 'OUT_OF_JURISDICTION');
		assert.deepStrictEqual([...outOfScope.outOfScopeNodeIds!], ['C']);
		assert.strictEqual(outOfScope.parentSupervisorId, 'sec0');
		assert.strictEqual(inScope.state.tokens[activeTokenOn(inScope.state, 'C')!.id].status, 'active');

		const forbidden = recallMissionTokens(state, graph, {
			caller: { sessionId: 'worker', tier: 2 },
			nodeIds: ['B'],
			now: 4_000,
		});
		assert.strictEqual(forbidden.ok, false);
		assert.strictEqual(forbidden.code, 'FORBIDDEN');
	});

	test('applySafeMissionPatch enforces off-graph-only, hard anti-dangling, jurisdiction and join reconciliation', () => {
		const baseMermaid = [
			'flowchart LR',
			'  N1["Start"] --> A["Implement"]',
			'  A --> B["Build"]',
		].join('\n');
		const baseGraph = parseGraph(baseMermaid);
		const baseState = createState(baseGraph);

		// a) In-graph employees are strictly forbidden from patching.
		const forbidden = applySafeMissionPatch(baseState, baseGraph, {
			caller: { sessionId: 'worker', tier: 2 },
			newMermaidText: baseMermaid,
			now: 1_000,
		});
		assert.strictEqual(forbidden.ok, false);
		assert.strictEqual(forbidden.code, 'FORBIDDEN');

		// b) Removing A without a replacement path orphans B.
		const dangling = applySafeMissionPatch(baseState, baseGraph, {
			caller: { isHumanUser: true, sessionId: 'human' },
			newMermaidText: [
				'flowchart LR',
				'  N1["Start"]',
				'  B["Build"]',
			].join('\n'),
			now: 2_000,
		});
		assert.strictEqual(dangling.ok, false);
		assert.strictEqual(dangling.code, 'DANGLING_NODE_VIOLATION');
		assert.deepStrictEqual([...dangling.danglingNodeIds!], ['B']);

		// b) Atomic replacement `N1 --> A2 --> B` succeeds and emits `mermaid_patched`.
		const replacement = applySafeMissionPatch(baseState, baseGraph, {
			caller: { isHumanUser: true, sessionId: 'human' },
			newMermaidText: [
				'flowchart LR',
				'  N1["Start"] --> A2["Implement v2"]',
				'  A2 --> B["Build"]',
			].join('\n'),
			reason: 'replace failed step',
			now: 3_000,
		});
		assert.strictEqual(replacement.ok, true, replacement.error);
		assert.deepStrictEqual([...replacement.data!.removedNodes], ['A']);
		assert.deepStrictEqual([...replacement.data!.addedNodes], ['A2']);
		assert.ok(replacement.data!.removedEdges.includes('N1->A'));
		assert.ok(replacement.data!.removedEdges.includes('A->B'));
		assert.ok(replacement.data!.addedEdges.includes('N1->A2'));
		assert.ok(replacement.data!.addedEdges.includes('A2->B'));
		assert.ok(replacement.effects.some(effect => effect.kind === 'mermaid_patched' && effect.reason === 'replace failed step'));

		// c) Out-of-jurisdiction patch returns OUT_OF_JURISDICTION + parentSupervisorId.
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 1,
			supervisors: [
				{ id: 'sec0', tier: 0, managedNodeIds: [] },
				{ id: 'supA', tier: 1, managedNodeIds: ['N1', 'A'], parentSupervisorId: 'sec0' },
			],
			nodeAssignments: {},
		};
		const scopedState = createState(baseGraph, boundary);
		const outOfJurisdiction = applySafeMissionPatch(scopedState, baseGraph, {
			caller: { sessionId: 'supA', tier: 1 },
			newMermaidText: [
				'flowchart LR',
				'  N1["Start"] --> A["Implement"]',
				'  A --> B["Build v2"]',
			].join('\n'),
			now: 4_000,
		});
		assert.strictEqual(outOfJurisdiction.ok, false);
		assert.strictEqual(outOfJurisdiction.code, 'OUT_OF_JURISDICTION');
		assert.deepStrictEqual([...outOfJurisdiction.outOfScopeNodeIds!], ['B']);
		assert.strictEqual(outOfJurisdiction.parentSupervisorId, 'sec0');

		// d) Pruning one branch of a 2-branch join whose sibling already arrived releases the barrier immediately.
		const joinGraph = parseGraph([
			'flowchart LR',
			'  A --> B',
			'  A --> C',
			'  B --> J',
			'  C --> J',
		].join('\n'));
		let running = startMissionRun(createState(joinGraph), joinGraph, ORG, { now: 5_000 }).state;
		const aToken = activeTokenOn(running, 'A')!;
		running = completeMissionToken(running, joinGraph, { tokenId: aToken.id, summary: 'alpha', now: 6_000 }).state;
		const bToken = activeTokenOn(running, 'B')!;
		running = completeMissionToken(running, joinGraph, { tokenId: bToken.id, summary: 'bravo', now: 7_000 }).state;
		assert.strictEqual(Object.keys(running.joinBarriers).length, 1);
		assert.strictEqual(running.nodeStates.J, 'waiting_join');

		const pruned = applySafeMissionPatch(running, joinGraph, {
			caller: { isHumanUser: true, sessionId: 'human' },
			newMermaidText: [
				'flowchart LR',
				'  A --> B',
				'  B --> J',
			].join('\n'),
			reason: 'prune branch C',
			now: 8_000,
		});
		assert.strictEqual(pruned.ok, true, pruned.error);
		assert.deepStrictEqual([...pruned.data!.removedNodes], ['C']);
		assert.strictEqual(Object.keys(pruned.state.joinBarriers).length, 0, 'barrier reconciles down to remaining branch');
		const joinToken = activeTokenOn(pruned.state, 'J');
		assert.ok(joinToken, 'join fires immediately once the pruned branch is removed');
		assert.ok(pruned.effects.some(effect => effect.kind === 'dispatch_token' && effect.nodeId === 'J'));
		assert.ok(pruned.effects.some(effect => effect.kind === 'mermaid_patched'));
	});

	test('validateSourceTrigger enforces inDegree=0 sources, fireMissionSourceTrigger mints a new waveId, and cron matching works', () => {
		const graph = parseGraph('flowchart LR\n  A --> B');

		assert.strictEqual(validateSourceTrigger(graph, { nodeId: 'A', kind: 'once', fireAt: 1 }), undefined);
		assert.ok(validateSourceTrigger(graph, { nodeId: 'B', kind: 'once', fireAt: 1 })?.includes('inDegree = 0'));
		assert.ok(validateSourceTrigger(graph, { nodeId: 'A', kind: 'interval', intervalMs: 4_000 })?.includes('5000'));
		assert.ok(validateSourceTrigger(graph, { nodeId: 'A', kind: 'cron', cronExpr: '0 2 * *' })?.includes('5-field'));
		assert.ok(validateSourceTrigger(graph, { nodeId: 'A', kind: 'event' })?.includes('eventType'));

		const trigger: IMissionSourceTrigger = {
			id: 'trig-1',
			nodeId: 'A',
			kind: 'interval',
			enabled: true,
			intervalMs: 60_000,
			fireCount: 0,
		};
		const seeded: IMissionRuntimeState = { ...createState(graph), triggers: [trigger] };
		const started = startMissionRun(seeded, graph, ORG, { now: 1_000 });
		assert.strictEqual(started.ok, true, started.error);
		assert.deepStrictEqual([...started.data!.mintedTokenIds], [], 'trigger-gated source does not auto-mint');

		const first = fireMissionSourceTrigger(started.state, graph, { triggerId: 'trig-1', payloadSummary: 'external tick', now: 2_000 });
		assert.strictEqual(first.ok, true, first.error);
		assert.strictEqual(first.data!.waveId, 'wave-1');
		const firstToken = first.state.tokens[first.data!.tokenId];
		assert.strictEqual(firstToken.nodeId, 'A');
		assert.strictEqual(firstToken.status, 'active');
		assert.strictEqual(firstToken.lastSummary, 'external tick');
		assert.strictEqual(first.state.triggers[0].fireCount, 1);
		assert.strictEqual(first.state.triggers[0].lastFiredAt, 2_000);

		// A new wave can only be minted once the previous source token is no longer live.
		const firstCompleted = completeMissionToken(first.state, graph, { tokenId: first.data!.tokenId, summary: 'external tick processed', now: 2_500 });
		assert.strictEqual(firstCompleted.ok, true, firstCompleted.error);

		const second = fireMissionSourceTrigger(firstCompleted.state, graph, { triggerId: 'trig-1', now: 3_000 });
		assert.strictEqual(second.ok, true);
		assert.strictEqual(second.data!.waveId, 'wave-2');
		assert.notStrictEqual(second.data!.waveId, first.data!.waveId);
		assert.notStrictEqual(second.data!.tokenId, first.data!.tokenId);

		// 2026-01-05 is a Monday.
		const mondayAt0230 = new Date(2026, 0, 5, 2, 30, 0);
		assert.strictEqual(matchesCronExpression('*/15 2 * * 1', mondayAt0230), true);
		assert.strictEqual(matchesCronExpression('*/15 3 * * 1', mondayAt0230), false);
		assert.strictEqual(matchesCronExpression('10 2 * * 1', mondayAt0230), false);
		assert.strictEqual(matchesCronExpression('0 2 * *', mondayAt0230), false);
		assert.strictEqual(matchesCronExpression('0 2 * * 2', mondayAt0230), false);
	});
});

suite('ADE Mission Engine Regression Guards (wave joins, rework, patches & run-state hygiene)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('wave-scoped join barrier avoids deadlock when a trigger-gated sibling source has not started', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  S1 --> J',
			'  S2 --> J',
		].join('\n'));
		const trigger: IMissionSourceTrigger = {
			id: 'trig-s2',
			nodeId: 'S2',
			kind: 'interval',
			enabled: true,
			intervalMs: 60_000,
			fireCount: 0,
		};

		let state = startMissionRun({ ...createState(graph), triggers: [trigger] }, graph, ORG, { now: 1_000 }).state;
		const s1Token = activeTokenOn(state, 'S1');
		assert.ok(s1Token);
		const afterS1 = completeMissionToken(state, graph, { tokenId: s1Token.id, summary: 'S1 done', now: 2_000 });
		assert.strictEqual(afterS1.ok, true, afterS1.error);
		state = afterS1.state;
		assert.strictEqual(Object.keys(state.joinBarriers).length, 0, 'unstarted trigger-gated branch must not register a barrier');
		assert.strictEqual(afterS1.data!.nextTokenIds.length, 1);
		const joinToken = state.tokens[afterS1.data!.nextTokenIds[0]];
		assert.strictEqual(joinToken.nodeId, 'J');
		assert.strictEqual(joinToken.status, 'active');

		// A trigger-only wave rooted at S2 must dispatch J without waiting for S1.
		const triggerState = startMissionRun({ ...createState(graph), triggers: [trigger] }, graph, ORG, { now: 3_000 }).state;
		const fired = fireMissionSourceTrigger(triggerState, graph, { triggerId: trigger.id, now: 4_000 });
		assert.strictEqual(fired.ok, true, fired.error);
		const s2Token = fired.state.tokens[fired.data!.tokenId];
		const afterS2 = completeMissionToken(fired.state, graph, { tokenId: s2Token.id, summary: 'trigger tick', now: 5_000 });
		assert.strictEqual(afterS2.ok, true, afterS2.error);
		assert.strictEqual(Object.keys(afterS2.state.joinBarriers).length, 0);
		assert.strictEqual(afterS2.data!.nextTokenIds.length, 1);
		const triggeredJoin = afterS2.state.tokens[afterS2.data!.nextTokenIds[0]];
		assert.strictEqual(triggeredJoin.nodeId, 'J');
		assert.strictEqual(triggeredJoin.status, 'active');
	});

	test('rework at a Join routes only back to the Join and never re-dispatches unrelated siblings', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  S --> A',
			'  S --> B',
			'  A --> J',
			'  B --> J',
			'  A --> Sib',
		].join('\n'));
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const sToken = activeTokenOn(state, 'S');
		assert.ok(sToken);
		state = completeMissionToken(state, graph, { tokenId: sToken.id, summary: 'fan out', now: 2_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		const bToken = activeTokenOn(state, 'B');
		assert.ok(aToken);
		assert.ok(bToken);

		state = completeMissionToken(state, graph, { tokenId: aToken.id, summary: 'A v1', now: 3_000 }).state;
		const sibToken = activeTokenOn(state, 'Sib');
		assert.ok(sibToken, 'sibling branch dispatched from A');
		assert.strictEqual(state.nodeStates.J, 'waiting_join');
		state = completeMissionToken(state, graph, { tokenId: bToken.id, summary: 'B done', now: 4_000 }).state;
		const joinToken = activeTokenOn(state, 'J');
		assert.ok(joinToken);

		const rejected = rejectMissionToken(state, graph, { tokenId: joinToken.id, targetNodeId: 'A', reason: 'join rework', now: 5_000 });
		assert.strictEqual(rejected.ok, true, rejected.error);
		state = rejected.state;
		const bounced = state.tokens[rejected.data!.bouncedTokenId];
		assert.strictEqual(bounced.nodeId, 'A');
		assert.strictEqual(bounced.returnToNodeId, 'J');

		const afterRework = completeMissionToken(state, graph, { tokenId: bounced.id, summary: 'A v2', now: 6_000 });
		assert.strictEqual(afterRework.ok, true, afterRework.error);
		assert.strictEqual(afterRework.data!.nextTokenIds.length, 1);
		const nextToken = afterRework.state.tokens[afterRework.data!.nextTokenIds[0]];
		assert.strictEqual(nextToken.nodeId, 'J');
		assert.strictEqual(nextToken.status, 'active');
		assert.strictEqual(Object.keys(afterRework.state.joinBarriers).length, 0, 'rework must bypass the join barrier');

		const sibTokens = Object.values(afterRework.state.tokens).filter(t => t.nodeId === 'Sib');
		assert.strictEqual(sibTokens.length, 1, 'sibling must not be re-dispatched');
		assert.strictEqual(sibTokens[0].id, sibToken.id);
		assert.strictEqual(sibTokens[0].status, 'active');
	});

	test('rework at a Gate routes only back to the Gate and never re-dispatches unrelated siblings', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  S --> A',
			'  S --> B',
			'  A --> G{{"Gate"}}',
			'  B --> G',
			'  A --> Sib',
		].join('\n'));
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const sToken = activeTokenOn(state, 'S');
		assert.ok(sToken);
		state = completeMissionToken(state, graph, { tokenId: sToken.id, summary: 'fan out', now: 2_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		const bToken = activeTokenOn(state, 'B');
		assert.ok(aToken);
		assert.ok(bToken);

		state = completeMissionToken(state, graph, { tokenId: aToken.id, summary: 'A v1', now: 3_000 }).state;
		const sibToken = activeTokenOn(state, 'Sib');
		assert.ok(sibToken, 'sibling branch dispatched from A');
		assert.strictEqual(state.nodeStates.G, 'waiting_join');
		state = completeMissionToken(state, graph, { tokenId: bToken.id, summary: 'B done', now: 4_000 }).state;
		const gateToken = Object.values(state.tokens).find(t => t.nodeId === 'G' && t.status === 'waiting_gate');
		assert.ok(gateToken);

		const rejected = resolveMissionGate(state, graph, { nodeId: 'G', decision: 'reject', rollbackNodeId: 'A', note: 'gate rework', now: 5_000 });
		assert.strictEqual(rejected.ok, true, rejected.error);
		state = rejected.state;
		const bounced = state.tokens[rejected.data!.nextTokenIds[0]];
		assert.strictEqual(bounced.nodeId, 'A');
		assert.strictEqual(bounced.returnToNodeId, 'G');

		const afterRework = completeMissionToken(state, graph, { tokenId: bounced.id, summary: 'A v2', now: 6_000 });
		assert.strictEqual(afterRework.ok, true, afterRework.error);
		assert.strictEqual(afterRework.data!.nextTokenIds.length, 1);
		const nextToken = afterRework.state.tokens[afterRework.data!.nextTokenIds[0]];
		assert.strictEqual(nextToken.nodeId, 'G');
		assert.strictEqual(nextToken.status, 'waiting_gate');

		const sibTokens = Object.values(afterRework.state.tokens).filter(t => t.nodeId === 'Sib');
		assert.strictEqual(sibTokens.length, 1, 'sibling must not be re-dispatched');
		assert.strictEqual(sibTokens[0].id, sibToken.id);
		assert.strictEqual(sibTokens[0].status, 'active');
	});

	test('multi-hop rework across a fork and join merges both branches into a single reviewer token (R2-2)', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  P --> A',
			'  P --> B',
			'  P --> Sib',
			'  A --> R',
			'  B --> R',
			'  C --> R',
		].join('\n'));
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		// Complete P, A, B, C so R receives its initial merged token
		const p1 = activeTokenOn(state, 'P')!;
		const c1 = activeTokenOn(state, 'C')!;
		state = completeMissionToken(state, graph, { tokenId: p1.id, summary: 'P v1', now: 2_000 }).state;
		state = completeMissionToken(state, graph, { tokenId: activeTokenOn(state, 'A')!.id, summary: 'A v1', now: 3_000 }).state;
		state = completeMissionToken(state, graph, { tokenId: activeTokenOn(state, 'B')!.id, summary: 'B v1', now: 4_000 }).state;
		state = completeMissionToken(state, graph, { tokenId: c1.id, summary: 'C v1', now: 4_500 }).state;
		const r1 = activeTokenOn(state, 'R');
		assert.ok(r1, 'R receives initial joined token');
		const initialSibCount = Object.values(state.tokens).filter(t => t.nodeId === 'Sib').length;
		assert.strictEqual(initialSibCount, 1);

		// R rejects 2 hops back to P -> mints a rework wave rooted strictly at [P]
		const rej = rejectMissionToken(state, graph, { tokenId: r1.id, targetNodeId: 'P', reason: 'redo from P', now: 5_000 });
		assert.strictEqual(rej.ok, true, rej.error);
		state = rej.state;
		const pRework = state.tokens[rej.data!.bouncedTokenId];
		assert.strictEqual(pRework.nodeId, 'P');
		assert.notStrictEqual(pRework.waveId, r1.waveId, 'rework mints a dedicated wave rooted at P');

		// Completing P dispatches ONLY A & B (on-path to R), NOT Sib!
		const afterP = completeMissionToken(state, graph, { tokenId: pRework.id, summary: 'P v2', now: 6_000 });
		assert.strictEqual(afterP.ok, true, afterP.error);
		state = afterP.state;
		assert.strictEqual(afterP.data!.nextTokenIds.length, 2);
		assert.strictEqual(Object.values(state.tokens).filter(t => t.nodeId === 'Sib').length, 1, 'unrelated sibling must not re-run');

		// Completing A parks at the rework join barrier (waiting for B, NOT waiting for C!)
		const aRework = activeTokenOn(state, 'A')!;
		const bRework = activeTokenOn(state, 'B')!;
		const afterA = completeMissionToken(state, graph, { tokenId: aRework.id, summary: 'A v2', now: 7_000 });
		assert.strictEqual(afterA.ok, true, afterA.error);
		state = afterA.state;
		assert.strictEqual(afterA.data!.nextTokenIds.length, 0, 'A waits for B at rework join barrier');
		assert.strictEqual(state.nodeStates.R, 'waiting_join');

		// Completing B releases the rework barrier and delivers EXACTLY ONE merged token to R (never waiting for C, never duplicating R!)
		const afterB = completeMissionToken(state, graph, { tokenId: bRework.id, summary: 'B v2', now: 8_000 });
		assert.strictEqual(afterB.ok, true, afterB.error);
		state = afterB.state;
		assert.strictEqual(afterB.data!.nextTokenIds.length, 1, 'R receives exactly one merged rework token');
		const activeOnR = Object.values(state.tokens).filter(t => t.nodeId === 'R' && t.status === 'active');
		assert.strictEqual(activeOnR.length, 1);
		assert.ok(activeOnR[0].lastSummary.includes('A v2') && activeOnR[0].lastSummary.includes('B v2'));
	});

	test('patch removing failed A and adding P --> B kicks off B with inherited wave and history', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  P --> A',
			'  A --> B',
		].join('\n'));
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const pToken = activeTokenOn(state, 'P');
		assert.ok(pToken);
		state = completeMissionToken(state, graph, { tokenId: pToken.id, summary: 'P done', now: 2_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);

		const failed = failMissionToken(state, graph, { tokenId: aToken.id, reason: 'A broke', now: 3_000 });
		assert.strictEqual(failed.ok, true, failed.error);
		assert.strictEqual(failed.state.tokens[aToken.id].status, 'frozen_failed');

		const patched = applySafeMissionPatch(failed.state, graph, {
			caller: { isHumanUser: true, sessionId: 'human' },
			newMermaidText: 'flowchart LR\n  P --> B',
			reason: 'replace failed A',
			now: 4_000,
		});
		assert.strictEqual(patched.ok, true, patched.error);
		assert.deepStrictEqual([...patched.data!.removedNodes], ['A']);
		assert.strictEqual(patched.state.tokens[aToken.id].status, 'recalled');

		const bToken = activeTokenOn(patched.state, 'B');
		assert.ok(bToken, 'existing downstream node B must be kicked off');
		assert.strictEqual(bToken.status, 'active');
		assert.strictEqual(bToken.waveId, pToken.waveId, 'kicked-off node inherits the upstream wave id');
		assert.ok(bToken.lastSummary.includes('P done'), `kicked-off node inherits upstream history: ${bToken.lastSummary}`);
		assert.ok(patched.effects.some(effect => effect.kind === 'dispatch_token' && effect.nodeId === 'B'));
	});

	test('patch recalls waiting_join tokens and reconciles partial-supervisor managed nodes', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  A --> B',
			'  A --> C',
			'  B --> J',
			'  C --> J',
		].join('\n'));
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 1,
			supervisors: [{ id: 'sup-1', tier: 1, managedNodeIds: ['A', 'B', 'C', 'J'] }],
			nodeAssignments: {},
		};
		let state = startMissionRun(createState(graph, boundary), graph, ORG, { now: 1_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);
		state = completeMissionToken(state, graph, { tokenId: aToken.id, summary: 'fan out', now: 2_000 }).state;
		const bToken = activeTokenOn(state, 'B');
		assert.ok(bToken);
		const afterB = completeMissionToken(state, graph, { tokenId: bToken.id, summary: 'B done', now: 3_000 });
		assert.strictEqual(afterB.ok, true, afterB.error);
		state = afterB.state;
		const barrier = Object.values(state.joinBarriers).find(b => b.targetNodeId === 'J');
		assert.ok(barrier);
		const waitingJoin = Object.values(barrier.arrivedByFrom)[0];
		assert.ok(waitingJoin);
		assert.strictEqual(waitingJoin.status, 'waiting_join');
		// Rehydrated runtime state persists barrier arrivals as live waiting_join tokens.
		state = { ...state, tokens: { ...state.tokens, [waitingJoin.id]: waitingJoin } };

		const patched = applySafeMissionPatch(state, graph, {
			caller: { sessionId: 'sup-1', tier: 1 },
			newMermaidText: [
				'flowchart LR',
				'  A --> B',
				'  A --> C',
				'  B --> D',
				'  C --> D',
			].join('\n'),
			reason: 'replace join with D',
			now: 4_000,
		});
		assert.strictEqual(patched.ok, true, patched.error);
		assert.deepStrictEqual([...patched.data!.removedNodes], ['J']);
		assert.deepStrictEqual([...patched.data!.addedNodes], ['D']);
		assert.strictEqual(patched.state.tokens[waitingJoin.id].status, 'recalled');
		const supervisor = patched.state.boundary.supervisors.find(sup => sup.id === 'sup-1');
		assert.ok(supervisor);
		assert.deepStrictEqual([...supervisor.managedNodeIds], ['A', 'B', 'C', 'D'], 'removed join is pruned and added node is granted to the caller supervisor');
	});

	test('patch rejects out-of-jurisdiction success/fail edge relabeling', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  N1 --> A',
			'  A --> B',
		].join('\n'));
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 1,
			supervisors: [{ id: 'sup-1', tier: 1, managedNodeIds: ['N1', 'A'] }],
			nodeAssignments: {},
		};
		const state = createState(graph, boundary);
		const patched = applySafeMissionPatch(state, graph, {
			caller: { sessionId: 'sup-1', tier: 1 },
			newMermaidText: [
				'flowchart LR',
				'  N1 --> A',
				'  A -->|fail| B',
			].join('\n'),
			now: 1_000,
		});
		assert.strictEqual(patched.ok, false);
		assert.strictEqual(patched.code, 'OUT_OF_JURISDICTION');
		assert.ok(patched.outOfScopeNodeIds?.includes('B'));
	});

	test('patch rejects adding an incoming edge into an already-completed node', () => {
		const graph = parseGraph('flowchart LR\n  P --> A');
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const pToken = activeTokenOn(state, 'P');
		assert.ok(pToken);
		state = completeMissionToken(state, graph, { tokenId: pToken.id, summary: 'P done', now: 2_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);
		state = completeMissionToken(state, graph, { tokenId: aToken.id, summary: 'A done', now: 3_000 }).state;
		assert.strictEqual(state.nodeStates.A, 'completed');

		const patched = applySafeMissionPatch(state, graph, {
			caller: { isHumanUser: true, sessionId: 'human' },
			newMermaidText: [
				'flowchart LR',
				'  P --> A',
				'  P --> B',
				'  B --> A',
			].join('\n'),
			now: 4_000,
		});
		assert.strictEqual(patched.ok, false);
		assert.strictEqual(patched.code, 'INVALID_STATE');
		assert.ok(patched.error?.includes('already-completed node'));
	});

	test('run-state hygiene: stop recalls frozen failures and start rejects paused or unassigned runs', () => {
		const graph = parseGraph('flowchart LR\n  A --> B');
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);
		const failed = failMissionToken(state, graph, { tokenId: aToken.id, reason: 'no fallback', now: 2_000 });
		assert.strictEqual(failed.ok, true, failed.error);
		state = failed.state;
		assert.strictEqual(state.tokens[aToken.id].status, 'frozen_failed');

		const stopped = stopMissionRun(state, 3_000);
		assert.strictEqual(stopped.ok, true);
		assert.strictEqual(stopped.state.status, 'stopped');
		assert.strictEqual(stopped.state.tokens[aToken.id].status, 'recalled');
		assert.strictEqual(stopped.state.silenceTimeoutLocked, false);

		const running = startMissionRun(createState(graph), graph, ORG, { now: 4_000 }).state;
		const paused = pauseMissionRun(running, 5_000);
		assert.strictEqual(paused.ok, true);
		const restart = startMissionRun(paused.state, graph, ORG, { now: 6_000 });
		assert.strictEqual(restart.ok, false);
		assert.strictEqual(restart.code, 'INVALID_STATE');

		const unassigned = startMissionRun(createState(graph), graph, ORG, { now: 7_000, requireAssignedNodes: true });
		assert.strictEqual(unassigned.ok, false);
		assert.strictEqual(unassigned.code, 'INVALID_STATE');
		assert.ok(unassigned.error?.includes('unassigned task node(s)'));
	});

	test('completion while paused defers downstream dispatch until resume flushes it', () => {
		const graph = parseGraph('flowchart LR\n  A --> B');
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		state = pauseMissionRun(state, 2_000).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);

		const completed = completeMissionToken(state, graph, { tokenId: aToken.id, summary: 'done while paused', now: 3_000 });
		assert.strictEqual(completed.ok, true, completed.error);
		assert.strictEqual(completed.state.tokens[aToken.id].status, 'completed');
		const deferred = completed.state.deferredEffects ?? [];
		assert.ok(deferred.some(effect => effect.kind === 'dispatch_token' && effect.nodeId === 'B'));
		assert.ok(!completed.effects.some(effect => effect.kind === 'dispatch_token'), 'paused completion must not emit immediately');

		const resumed = resumeMissionRun(completed.state, 4_000);
		assert.strictEqual(resumed.ok, true, resumed.error);
		assert.ok(resumed.effects.some(effect => effect.kind === 'dispatch_token' && effect.nodeId === 'B'));
		assert.strictEqual(resumed.state.deferredEffects, undefined);
	});

	test('recalling the last live token marks the Mission completed', () => {
		const graph = parseGraph('flowchart LR\n  A --> B');
		const state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);

		const recalled = recallMissionTokens(state, graph, {
			caller: { isHumanUser: true, sessionId: 'human' },
			nodeIds: ['A'],
			now: 2_000,
		});
		assert.strictEqual(recalled.ok, true, recalled.error);
		assert.strictEqual(recalled.state.tokens[aToken.id].status, 'recalled');
		assert.strictEqual(recalled.state.status, 'completed');
	});

	test('reject and Gate rollback reject downstream or unvisited-branch targets', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  A --> B',
			'  A --> C',
			'  B --> D',
		].join('\n'));
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const aToken = activeTokenOn(state, 'A');
		assert.ok(aToken);
		state = completeMissionToken(state, graph, { tokenId: aToken.id, summary: 'fan out', now: 2_000 }).state;
		const bToken = activeTokenOn(state, 'B');
		assert.ok(bToken);

		const downstream = rejectMissionToken(state, graph, { tokenId: bToken.id, targetNodeId: 'D', reason: 'bad target', now: 3_000 });
		assert.strictEqual(downstream.ok, false);
		assert.strictEqual(downstream.code, 'INVALID_STATE');
		const unvisited = rejectMissionToken(state, graph, { tokenId: bToken.id, targetNodeId: 'C', reason: 'bad target', now: 4_000 });
		assert.strictEqual(unvisited.ok, false);
		assert.strictEqual(unvisited.code, 'INVALID_STATE');

		const gateGraph = parseGraph([
			'flowchart LR',
			'  A --> G{{"Gate"}}',
			'  G --> B',
			'  A --> C',
		].join('\n'));
		let gateState = startMissionRun(createState(gateGraph), gateGraph, ORG, { now: 5_000 }).state;
		const gateAToken = activeTokenOn(gateState, 'A');
		assert.ok(gateAToken);
		gateState = completeMissionToken(gateState, gateGraph, { tokenId: gateAToken.id, summary: 'to gate', now: 6_000 }).state;

		const gateDownstream = resolveMissionGate(gateState, gateGraph, { nodeId: 'G', decision: 'reject', rollbackNodeId: 'B', now: 7_000 });
		assert.strictEqual(gateDownstream.ok, false);
		assert.strictEqual(gateDownstream.code, 'INVALID_STATE');
		const gateUnvisited = resolveMissionGate(gateState, gateGraph, { nodeId: 'G', decision: 'reject', rollbackNodeId: 'C', now: 8_000 });
		assert.strictEqual(gateUnvisited.ok, false);
		assert.strictEqual(gateUnvisited.code, 'INVALID_STATE');
	});

	test('escalateMissionIssue returns FORBIDDEN for an unknown non-supervisor caller', () => {
		const graph = parseGraph('flowchart LR\n  A --> B');
		const state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const result = escalateMissionIssue(state, { callerSupervisorId: 'nobody', reason: 'help', now: 2_000 });
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.code, 'FORBIDDEN');
	});

	test('queryApiUpdateDiff rejects an unknown scope and lists valid scopes', () => {
		assert.throws(
			() => queryApiUpdateDiff(0, 'bogus_scope'),
			/Valid scopes: common, in_graph, off_graph, mission, all/,
		);
	});

	test('matchesCronExpression handles 1-based dom steps, Sunday as 7 and dom/dow OR semantics', () => {
		const dayOne = new Date(2026, 0, 1, 2, 0, 0);
		const dayTwo = new Date(2026, 0, 2, 2, 0, 0);
		assert.strictEqual(matchesCronExpression('0 2 */2 * *', dayOne), true, 'dom step origins are 1-based');
		assert.strictEqual(matchesCronExpression('0 2 */2 * *', dayTwo), false);

		const sunday = new Date(2026, 0, 4, 2, 0, 0);
		assert.strictEqual(sunday.getDay(), 0);
		assert.strictEqual(matchesCronExpression('0 2 * * 7', sunday), true);
		assert.strictEqual(matchesCronExpression('0 2 * * 0', sunday), true);

		const monday = new Date(2026, 0, 5, 2, 0, 0);
		assert.strictEqual(monday.getDay(), 1);
		assert.strictEqual(matchesCronExpression('0 2 15 * 1', monday), true, 'dow match suffices when both dom and dow are restricted');
		assert.strictEqual(matchesCronExpression('0 2 15 * 2', monday), false);
		const fifteenth = new Date(2026, 0, 15, 2, 0, 0);
		assert.strictEqual(fifteenth.getDay(), 4);
		assert.strictEqual(matchesCronExpression('0 2 15 * 1', fifteenth), true, 'dom match suffices when both dom and dow are restricted');
	});

	test('fireMissionSourceTrigger refuses to mint while a live token occupies the source node', () => {
		const graph = parseGraph('flowchart LR\n  S --> A');
		const trigger: IMissionSourceTrigger = {
			id: 'trig-live',
			nodeId: 'S',
			kind: 'interval',
			enabled: true,
			intervalMs: 60_000,
			fireCount: 0,
		};
		const state = startMissionRun({ ...createState(graph), triggers: [trigger] }, graph, ORG, { now: 1_000 }).state;

		const first = fireMissionSourceTrigger(state, graph, { triggerId: trigger.id, now: 2_000 });
		assert.strictEqual(first.ok, true, first.error);
		assert.strictEqual(first.state.tokens[first.data!.tokenId].nodeId, 'S');

		const second = fireMissionSourceTrigger(first.state, graph, { triggerId: trigger.id, now: 3_000 });
		assert.strictEqual(second.ok, false);
		assert.strictEqual(second.code, 'INVALID_STATE');
		assert.ok(second.error?.includes('already holds a live in-flight token'));
	});
});
