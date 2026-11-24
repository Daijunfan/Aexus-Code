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
import { AdeDocsBackendNodeService } from '../../node/adeDocsBackendService.js';
import { computeAdeStorageFingerprint, encodeAdeMissionStorageFileName } from '../../common/adeEngineering.js';
import {
	computeNodeDragSnapAlignment,
	getMissionEdgeKind,
	getMissionSourceNodes,
	IMissionDagParseResult,
	MissionCanvasHistoryStack,
	parseMissionMermaidDag,
	removeNodesFromMermaid,
	renameEdgeLabelInMermaid,
} from '../../common/adeMissionDag.js';
import {
	findDirectSupervisorForNode,
	findParentSupervisorForEscalation,
	IMissionBoundaryConfig,
	resolveSupervisorJurisdiction,
	validateMissionFactoryBoundary,
} from '../../common/adeMissionBoundary.js';
import {
	appendMissionDagRevision,
	applySafeMissionPatch,
	blockMissionToken,
	buildMissionRunArchiveSnapshot,
	buildTokenDispatchPrompt,
	collectValidUpstreamRollbackCandidates,
	compareMissionRuns,
	completeMissionToken,
	compressTokenHistory,
	computeMissionFinOpsSummary,
	computeMissionNodeContextBreakdown,
	createInitialMissionRuntimeState,
	distillMissionNodeContext,
	escalateMissionIssue,
	expandTracePointer,
	failMissionToken,
	fireMissionSourceTrigger,
	IMissionRuntimeState,
	IMissionSourceTrigger,
	IMissionToken,
	inferMissionConcurrencyProvider,
	inferModelContextWindowTokens,
	matchesCronExpression,
	MAX_MISSION_RUN_HISTORY,
	pauseMissionRun,
	recallMissionTokens,
	recordMissionNodeTurnUsage,
	recordTokenCheckResult,
	recordWatchdogWakeup,
	rejectMissionToken,
	resolveMissionGate,
	resumeMissionRun,
	retryMissionToken,
	setMissionBudgetLimit,
	setMissionConcurrencyLimits,
	setMissionSilenceTimeout,
	startMissionRun,
	stopMissionRun,
	validateSourceTrigger,
} from '../../common/adeMissionEngine.js';
import {
	estimateTokenCostUsd,
	isBuiltInLocalZeroCostModel,
	parseExplicitModelContextWindowTag,
	resolveModelContextWindowTokens,
	resolveModelTokenPricingRate,
} from '../../common/adeModelPricing.js';
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
		assert.strictEqual(inGraph.added.length, 12);
		assert.ok(inGraph.added.every(entry => entry.scope === 'in_graph' && entry.addedInRevision >= 2));
		assert.deepStrictEqual(
			inGraph.added.map(entry => entry.id).sort(),
			[
				'in_graph.token.block',
				'in_graph.token.complete',
				'in_graph.token.current',
				'in_graph.token.fail',
				'in_graph.token.handoff',
				'in_graph.token.history',
				'in_graph.token.mint_split',
				'in_graph.token.read',
				'in_graph.token.reject',
				'in_graph.token.retry',
				'in_graph.token.return',
				'in_graph.token.trace',
			],
		);

		const mission = queryApiUpdateDiff(2, 'mission');
		assert.strictEqual(mission.scope, 'mission');
		assert.deepStrictEqual(
			mission.added.map(entry => entry.id).sort(),
			[
				'mission.boundary',
				'mission.check',
				'mission.checkpoint',
				'mission.diagnostics',
				'mission.host.bind',
				'mission.migration',
				'mission.patch',
				'mission.prompt',
				'mission.recall',
				'mission.retry',
				'mission.task',
				'mission.task.authoring',
				'mission.task.status',
				'mission.trigger',
				'orchestration.authoring',
				'orchestration.limits',
				'orchestration.manifest_and_control',
				'orchestration.migration',
				'orchestration.staff.create',
				'orchestration.topology',
			],
		);
		assert.deepStrictEqual(mission.modified.map(entry => entry.id), ['mission.blueprint']);

		const missionFromRev3 = queryApiUpdateDiff(3, 'mission');
		assert.deepStrictEqual(
			missionFromRev3.added.map(entry => entry.id).sort(),
			['mission.check', 'mission.checkpoint', 'mission.diagnostics', 'mission.migration', 'mission.task', 'mission.task.authoring', 'mission.task.status', 'orchestration.authoring', 'orchestration.limits', 'orchestration.manifest_and_control', 'orchestration.migration', 'orchestration.staff.create', 'orchestration.topology'],
		);
		const missionFromRev4 = queryApiUpdateDiff(4, 'mission');
		assert.deepStrictEqual(
			missionFromRev4.added.map(entry => entry.id).sort(),
			['mission.checkpoint', 'mission.diagnostics', 'mission.migration', 'mission.task', 'mission.task.authoring', 'mission.task.status', 'orchestration.authoring', 'orchestration.limits', 'orchestration.manifest_and_control', 'orchestration.migration', 'orchestration.staff.create', 'orchestration.topology'],
		);
		const missionFromRev6 = queryApiUpdateDiff(6, 'mission');
		assert.deepStrictEqual(
			missionFromRev6.added.map(entry => entry.id).sort(),
			['mission.checkpoint', 'mission.diagnostics', 'mission.migration', 'mission.task.authoring', 'mission.task.status', 'orchestration.authoring', 'orchestration.limits', 'orchestration.manifest_and_control', 'orchestration.migration'],
		);
		const rev8All = queryApiUpdateDiff(7, 'all');
		assert.deepStrictEqual(
			rev8All.added.map(entry => entry.id).sort(),
			['common.idempotency', 'in_graph.token.mint_split', 'in_graph.token.retry', 'in_graph.token.return', 'mission.checkpoint', 'mission.diagnostics', 'mission.task.authoring', 'mission.task.status', 'off_graph.session.configure', 'orchestration.limits', 'orchestration.manifest_and_control'],
		);
		assert.ok(rev8All.modified.some(entry => entry.id === 'orchestration.authoring'));
		const rev10All = queryApiUpdateDiff(9, 'all');
		assert.deepStrictEqual(
			rev10All.added.map(entry => entry.id).sort(),
			['common.idempotency', 'in_graph.token.retry', 'mission.checkpoint', 'mission.diagnostics', 'mission.task.status', 'off_graph.session.configure', 'orchestration.limits'],
		);
		assert.ok(rev10All.modified.some(entry => entry.id === 'in_graph.token.reject'));
		assert.strictEqual(rev10All.deprecated.length, 0);
		const commonFromRev4 = queryApiUpdateDiff(4, 'common');
		assert.deepStrictEqual(commonFromRev4.added.map(entry => entry.id), ['common.whiteboard', 'common.idempotency']);
		const inGraphFromRev3 = queryApiUpdateDiff(3, 'in_graph');
		assert.ok(inGraphFromRev3.modified.some(entry => entry.id === 'in_graph.token.complete'));

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
		assert.ok(missionText.includes('Engineering Dual-View API Reference'));
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
		// deliverTokenToTarget persists waiting_join tokens directly into state.tokens.
		assert.strictEqual(state.tokens[waitingJoin.id]?.status, 'waiting_join');

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

	test('recordWatchdogWakeup auto-escalates silent token to Governor after 3 nudges', () => {
		const graph = parseGraph('flowchart LR\n  A --> B');
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 1,
			supervisors: [{ id: 'gov-1', tier: 1, managedNodeIds: ['A', 'B'] }],
			nodeAssignments: { A: { agentId: 'emp-a', tier: 2, roleKind: 'worker', hostAlias: 'local' } },
		};
		let state = startMissionRun(createState(graph, boundary), graph, ORG, { now: 1_000 }).state;
		const aTok = activeTokenOn(state, 'A')!;
		for (let i = 1; i <= 3; i++) {
			const res = recordWatchdogWakeup(state, { tokenId: aTok.id, reason: 'silence_timeout', graph, owner: { ownerSessionId: 'gov-1', ownerTier: 1 }, now: 1_000 + i * 300_000 });
			assert.strictEqual(res.ok, true);
			state = res.state;
			assert.strictEqual(state.tokens[aTok.id].status, 'active');
			assert.strictEqual(state.tokens[aTok.id].nudgeCount, i);
		}
		const escalated = recordWatchdogWakeup(state, { tokenId: aTok.id, reason: 'silence_timeout', graph, owner: { ownerSessionId: 'gov-1', ownerTier: 1 }, now: 2_000_000 });
		assert.strictEqual(escalated.ok, true);
		assert.strictEqual(escalated.state.tokens[aTok.id].status, 'frozen_failed');
		assert.ok(escalated.effects.some(e => e.kind === 'escalate_to_supervisor' && e.supervisorId === 'gov-1'));
	});

	test('retryMissionToken unfreezes frozen_failed branch in-place and releases waiting join barrier', () => {
		const graph = parseGraph('flowchart LR\n  N1 --> N2\n  N1 --> N3\n  N2 --> N4\n  N3 --> N4');
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 1,
			supervisors: [{ id: 'gov-1', tier: 1, managedNodeIds: ['N1', 'N2', 'N3', 'N4'] }],
			nodeAssignments: {
				N1: { agentId: 'a1', tier: 2, roleKind: 'worker', hostAlias: 'local' },
				N2: { agentId: 'a2', tier: 3, roleKind: 'worker', hostAlias: 'local' },
				N3: { agentId: 'a3', tier: 4, roleKind: 'worker', hostAlias: 'local' },
				N4: { agentId: 'a4', tier: 2, roleKind: 'worker', hostAlias: 'local' },
			},
		};
		let state = startMissionRun(createState(graph, boundary), graph, ORG, { now: 1_000 }).state;
		state = completeMissionToken(state, graph, { tokenId: activeTokenOn(state, 'N1')!.id, summary: 'N1 ok', now: 2_000 }).state;
		const n2Tok = activeTokenOn(state, 'N2')!;
		const n3Tok = activeTokenOn(state, 'N3')!;

		// N2 fails with 502 (frozen_failed), N3 finishes and parks at N4 join barrier
		state = failMissionToken(state, graph, { tokenId: n2Tok.id, reason: '502 gateway', owner: { ownerSessionId: 'gov-1', ownerTier: 1 }, now: 3_000 }).state;
		state = completeMissionToken(state, graph, { tokenId: n3Tok.id, summary: 'N3 ok', now: 4_000 }).state;
		assert.strictEqual(state.nodeStates.N4, 'waiting_join');
		assert.strictEqual(state.tokens[n2Tok.id].status, 'frozen_failed');

		// In-graph worker cannot retry; off-graph Governor can retry N2 in-place preserving wave-1
		const forbidden = retryMissionToken(state, graph, { caller: { sessionId: 'a2', tier: 3 }, nodeId: 'N2', now: 5_000 });
		assert.strictEqual(forbidden.ok, false);
		assert.strictEqual(forbidden.code, 'FORBIDDEN');

		const retried = retryMissionToken(state, graph, {
			caller: { sessionId: 'gov-1', tier: 1, ownerSessionId: 'gov-1' },
			tokenId: n2Tok.id,
			guidance: 'Gateway recovered; finish ParserDev tests',
			now: 5_000,
		});
		assert.strictEqual(retried.ok, true, retried.error);
		state = retried.state;
		const freshN2 = state.tokens[retried.data!.retriedTokenId];
		assert.strictEqual(freshN2.status, 'active');
		assert.strictEqual(freshN2.waveId, n2Tok.waveId);
		assert.ok(freshN2.lastSummary.includes('Gateway recovered'));

		// Completing retried N2 releases N4 join barrier cleanly and completes Mission
		state = completeMissionToken(state, graph, { tokenId: freshN2.id, summary: 'N2 recovered', now: 6_000 }).state;
		const n4Tok = activeTokenOn(state, 'N4');
		assert.ok(n4Tok, 'N4 released from join barrier after in-place retry of N2');
		state = completeMissionToken(state, graph, { tokenId: n4Tok.id, summary: 'N4 done', now: 7_000 }).state;
		assert.strictEqual(state.status, 'completed');
	});

	test('rejectMissionToken restores returnWaveId so parallel downstream join barrier completes cleanly', () => {
		const graph = parseGraph('flowchart LR\n  S --> A\n  S --> B\n  A --> R\n  R --> J\n  B --> J');
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		state = completeMissionToken(state, graph, { tokenId: activeTokenOn(state, 'S')!.id, summary: 'S ok', now: 2_000 }).state;
		state = completeMissionToken(state, graph, { tokenId: activeTokenOn(state, 'B')!.id, summary: 'B ok', now: 3_000 }).state;
		assert.strictEqual(state.nodeStates.J, 'waiting_join');

		state = completeMissionToken(state, graph, { tokenId: activeTokenOn(state, 'A')!.id, summary: 'A v1', now: 4_000 }).state;
		const rTok1 = activeTokenOn(state, 'R')!;
		state = rejectMissionToken(state, graph, { tokenId: rTok1.id, reason: 'fix edge case', now: 5_000 }).state;
		const aRework = activeTokenOn(state, 'A')!;
		assert.strictEqual(aRework.returnToNodeId, 'R');
		assert.strictEqual(aRework.returnWaveId, rTok1.waveId);

		state = completeMissionToken(state, graph, { tokenId: aRework.id, summary: 'A v2 fixed', now: 6_000 }).state;
		const rTok2 = activeTokenOn(state, 'R')!;
		assert.strictEqual(rTok2.waveId, rTok1.waveId, 'Returning to R restores original waveId');

		state = completeMissionToken(state, graph, { tokenId: rTok2.id, summary: 'R approved', now: 7_000 }).state;
		const jTok = activeTokenOn(state, 'J');
		assert.ok(jTok, 'J join barrier releases cleanly without orphaned wave-1 barrier');
		state = completeMissionToken(state, graph, { tokenId: jTok.id, summary: 'J done', now: 8_000 }).state;
		assert.strictEqual(state.status, 'completed');
		assert.strictEqual(Object.keys(state.joinBarriers).length, 0);
	});

	test('recordMissionNodeTurnUsage infers 1M window for 1m/gemini models and avoids cacheRead saturation', () => {
		const graph = parseGraph('flowchart LR\n  A --> B');
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		state = recordMissionNodeTurnUsage(state, 'A', {
			inputTokens: 30_000,
			outputTokens: 20_000,
			cacheReadTokens: 4_000_000,
			totalTokens: 4_050_000,
			model: 'deepseek-flash[1m]',
		});
		const tel = state.nodeTelemetry?.A;
		assert.ok(tel);
		assert.strictEqual(tel.contextWindowMax, 1_000_000);
		assert.strictEqual(tel.contextSourceTokens, 50_000);
	});

	test('single-branch recall never deadlocks downstream join barriers (before arrival, after sibling arrival, multi-hop, retry re-arm & jurisdiction guard)', () => {
		const diamond = parseGraph([
			'flowchart LR',
			'  S --> A',
			'  S --> B',
			'  A --> J',
			'  B --> J',
		].join('\n'));

		// Case 1: B already arrived at J (waiting_join), A is still active -> recalling A immediately releases J with B!
		let s1 = startMissionRun(createState(diamond), diamond, ORG, { now: 1_000 }).state;
		s1 = completeMissionToken(s1, diamond, { tokenId: activeTokenOn(s1, 'S')!.id, summary: 'S done', now: 2_000 }).state;
		s1 = completeMissionToken(s1, diamond, { tokenId: activeTokenOn(s1, 'B')!.id, summary: 'B done', now: 3_000 }).state;
		assert.strictEqual(s1.nodeStates.J, 'waiting_join');
		const rec1 = recallMissionTokens(s1, diamond, { caller: { isHumanUser: true }, nodeIds: ['A'], reason: 'cancel A', now: 4_000 });
		assert.strictEqual(rec1.ok, true, rec1.error);
		assert.strictEqual(Object.keys(rec1.state.joinBarriers).length, 0, 'join barrier releases immediately when sole missing branch A is recalled');
		const j1 = activeTokenOn(rec1.state, 'J');
		assert.ok(j1, 'J receives active token immediately after single-branch recall of A');
		assert.ok(j1.lastSummary.includes('[B] B done'));
		assert.ok(rec1.effects.some(e => e.kind === 'dispatch_token' && e.nodeId === 'J'));

		// Case 2: Both A and B still active (barrier not created yet) -> recalling A marks A skipped -> when B completes, J fires cleanly!
		let s2 = startMissionRun(createState(diamond), diamond, ORG, { now: 1_000 }).state;
		s2 = completeMissionToken(s2, diamond, { tokenId: activeTokenOn(s2, 'S')!.id, summary: 'S done', now: 2_000 }).state;
		const rec2 = recallMissionTokens(s2, diamond, { caller: { isHumanUser: true }, nodeIds: ['A'], reason: 'drop A early', now: 3_000 });
		assert.strictEqual(rec2.ok, true, rec2.error);
		const afterB2 = completeMissionToken(rec2.state, diamond, { tokenId: activeTokenOn(rec2.state, 'B')!.id, summary: 'B solo', now: 4_000 });
		assert.strictEqual(afterB2.ok, true, afterB2.error);
		assert.strictEqual(Object.keys(afterB2.state.joinBarriers).length, 0);
		assert.ok(activeTokenOn(afterB2.state, 'J'), 'J fires immediately once surviving branch B completes');

		// Case 3: A already arrived at J, B still active -> recalling A purges A & marks skipped -> when B completes, J fires with B only!
		let s3 = startMissionRun(createState(diamond), diamond, ORG, { now: 1_000 }).state;
		s3 = completeMissionToken(s3, diamond, { tokenId: activeTokenOn(s3, 'S')!.id, summary: 'S done', now: 2_000 }).state;
		s3 = completeMissionToken(s3, diamond, { tokenId: activeTokenOn(s3, 'A')!.id, summary: 'A bad', now: 3_000 }).state;
		assert.strictEqual(s3.nodeStates.J, 'waiting_join');
		const rec3 = recallMissionTokens(s3, diamond, { caller: { isHumanUser: true }, nodeIds: ['A'], reason: 'purge arrived A', now: 4_000 });
		assert.strictEqual(rec3.ok, true, rec3.error);
		assert.strictEqual(rec3.state.nodeStates.J, 'idle');
		const afterB3 = completeMissionToken(rec3.state, diamond, { tokenId: activeTokenOn(rec3.state, 'B')!.id, summary: 'B clean', now: 5_000 });
		assert.strictEqual(afterB3.ok, true, afterB3.error);
		const j3 = activeTokenOn(afterB3.state, 'J');
		assert.ok(j3);
		assert.ok(j3.lastSummary.includes('[B] B clean') && !j3.lastSummary.includes('A bad'));

		// Case 4: Multi-hop branch `S -> A1 -> A2 -> J` + `S -> B -> J` -> recalling A1 cascades skip to J!
		const multiHop = parseGraph('flowchart LR\n  S --> A1\n  A1 --> A2\n  A2 --> J\n  S --> B\n  B --> J');
		let s4 = startMissionRun(createState(multiHop), multiHop, ORG, { now: 1_000 }).state;
		s4 = completeMissionToken(s4, multiHop, { tokenId: activeTokenOn(s4, 'S')!.id, summary: 'S', now: 2_000 }).state;
		s4 = recallMissionTokens(s4, multiHop, { caller: { isHumanUser: true }, nodeIds: ['A1'], now: 3_000 }).state;
		s4 = completeMissionToken(s4, multiHop, { tokenId: activeTokenOn(s4, 'B')!.id, summary: 'B ok', now: 4_000 }).state;
		assert.ok(activeTokenOn(s4, 'J'), 'Multi-hop single-branch recall cascades skip to join J');

		// Case 5: Recall A then retry A BEFORE B finishes -> barrier re-arms so J waits for BOTH A and B!
		let s5 = startMissionRun(createState(diamond), diamond, ORG, { now: 1_000 }).state;
		s5 = completeMissionToken(s5, diamond, { tokenId: activeTokenOn(s5, 'S')!.id, summary: 'S', now: 2_000 }).state;
		s5 = recallMissionTokens(s5, diamond, { caller: { isHumanUser: true }, nodeIds: ['A'], now: 3_000 }).state;
		const retried5 = retryMissionToken(s5, diamond, { caller: { isHumanUser: true }, nodeId: 'A', guidance: 'redo A', now: 3_500 });
		assert.strictEqual(retried5.ok, true, retried5.error);
		s5 = completeMissionToken(retried5.state, diamond, { tokenId: activeTokenOn(retried5.state, 'B')!.id, summary: 'B ok', now: 4_000 }).state;
		assert.strictEqual(s5.nodeStates.J, 'waiting_join', 'J must wait for retried A after retry re-armed the barrier');
		s5 = completeMissionToken(s5, diamond, { tokenId: activeTokenOn(s5, 'A')!.id, summary: 'A retried ok', now: 5_000 }).state;
		const j5 = activeTokenOn(s5, 'J');
		assert.ok(j5 && j5.lastSummary.includes('A retried ok') && j5.lastSummary.includes('B ok'));

		// Case 6: Partial supervisor managing only A (not J) is rejected OUT_OF_JURISDICTION even before J's barrier exists!
		const scopedBoundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 2,
			supervisors: [
				{ id: 'sup-l1', tier: 1, managedNodeIds: ['S', 'B', 'J'] },
				{ id: 'sup-l2', tier: 2, managedNodeIds: ['A'], parentSupervisorId: 'sup-l1' },
			],
			nodeAssignments: {},
		};
		let s6 = startMissionRun(createState(diamond, scopedBoundary), diamond, ORG, { now: 1_000 }).state;
		s6 = completeMissionToken(s6, diamond, { tokenId: activeTokenOn(s6, 'S')!.id, summary: 'S', now: 2_000 }).state;
		const blockedRecall = recallMissionTokens(s6, diamond, { caller: { sessionId: 'sup-l2', tier: 2 }, nodeIds: ['A'], now: 3_000 });
		assert.strictEqual(blockedRecall.ok, false);
		assert.strictEqual(blockedRecall.code, 'OUT_OF_JURISDICTION');
		assert.ok(blockedRecall.outOfScopeNodeIds?.includes('J'));
		assert.strictEqual(blockedRecall.parentSupervisorId, 'sup-l1');

		// Case 7: Patching a join node J -> D while B already completed and C is still active replays B into D's barrier so C finishes cleanly!
		let s7 = startMissionRun(createState(diamond), diamond, ORG, { now: 1_000 }).state;
		s7 = completeMissionToken(s7, diamond, { tokenId: activeTokenOn(s7, 'S')!.id, summary: 'S', now: 2_000 }).state;
		s7 = completeMissionToken(s7, diamond, { tokenId: activeTokenOn(s7, 'A')!.id, summary: 'A done before patch', now: 3_000 }).state;
		const patchedJoin = applySafeMissionPatch(s7, diamond, {
			caller: { isHumanUser: true },
			newMermaidText: 'flowchart LR\n  S --> A\n  S --> B\n  A --> J2\n  B --> J2',
			reason: 'swap join J -> J2',
			now: 4_000,
		});
		assert.strictEqual(patchedJoin.ok, true, patchedJoin.error);
		assert.strictEqual(patchedJoin.state.nodeStates.J2, 'waiting_join', 'Already-completed A is replayed into new join J2');
		const newGraph = parseGraph('flowchart LR\n  S --> A\n  S --> B\n  A --> J2\n  B --> J2');
		const finished7 = completeMissionToken(patchedJoin.state, newGraph, { tokenId: activeTokenOn(patchedJoin.state, 'B')!.id, summary: 'B done after patch', now: 5_000 });
		assert.strictEqual(finished7.ok, true, finished7.error);
		const j2Tok = activeTokenOn(finished7.state, 'J2');
		assert.ok(j2Tok, 'J2 fires immediately once B completes after live join replacement');
		assert.ok(j2Tok.lastSummary.includes('A done before patch') && j2Tok.lastSummary.includes('B done after patch'));
	});

	test('hierarchical semantic rolling history preserves cumulative counts, node trail, file artifacts, critical verdicts, and real tracePtr without hard mid-word truncation', () => {
		// 1. Signal-aware per-hop distillation preserves trailing file path & test verdict instead of hard-slicing at char 240
		const verboseSummary = [
			'Spent some time reading existing conventions and exploring unrelated folders across the repository before starting implementation.',
			'Also checked background notes and formatting preferences in detail so everything aligns with team style guidelines and documentation prose.',
			'Implemented JWT auth middleware in src/auth/jwtMiddleware.ts and verified 42/42 tests passing with 0 errors.',
		].join(' ');
		const singleDistilled = compressTokenHistory('', verboseSummary, 'N1');
		assert.ok(singleDistilled.includes('src/auth/jwtMiddleware.ts'), `must retain trailing file path, got: ${singleDistilled}`);
		assert.ok(singleDistilled.includes('42/42 tests passing') || singleDistilled.includes('0 errors'), `must retain trailing verdict metric, got: ${singleDistilled}`);

		// 2. Over 14 hops with rich artifacts & a mid-chain rejection, archivedCount accumulates accurately (never resets to 1!)
		const hopCount = 14;
		const lines = ['flowchart LR'];
		for (let i = 0; i < hopCount; i++) {
			lines.push(`  S${i} --> S${i + 1}`);
		}
		const graph = parseGraph(lines.join('\n'));
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		for (let i = 0; i < hopCount; i++) {
			const tok = activeTokenOn(state, `S${i}`)!;
			const summary = i === 2
				? `[Rejected by R1] Fixed race condition in src/core/scheduler.ts; 18/18 tests passing.`
				: `Completed phase ${i} updating src/mod/part${i}.ts with detailed engineering notes and validation. Result: ${10 + i}/${10 + i} passing.`;
			const res = completeMissionToken(state, graph, { tokenId: tok.id, summary, now: 2_000 + i });
			assert.strictEqual(res.ok, true, res.error);
			state = res.state;
		}
		const tailTok = activeTokenOn(state, `S${hopCount}`)!;
		assert.ok(tailTok.compressedHistory.length <= 1200, `bounded <= 1200 (got ${tailTok.compressedHistory.length})`);
		assert.ok(!tailTok.compressedHistory.includes('Mission started — begin execution'), 'skips synthetic startup boilerplate');
		assert.ok(tailTok.historyState, 'attaches structured rolling history state');
		assert.ok((tailTok.historyState?.archivedCount ?? 0) >= 5, `archivedCount must accumulate accurately (got ${tailTok.historyState?.archivedCount})`);
		assert.ok(tailTok.compressedHistory.includes(`${tailTok.historyState!.archivedCount} earlier step(s) condensed`), tailTok.compressedHistory);
		assert.ok(tailTok.historyState!.archivedNodeIds.includes('S0'), 'archived trail preserves earliest real hop S0');
		assert.ok(
			tailTok.compressedHistory.includes('src/core/scheduler.ts')
			|| tailTok.historyState!.archivedArtifacts.includes('src/core/scheduler.ts'),
			'critical rejection artifact survives across 14 hops',
		);

		// Prompt rendering substitutes real tracePtr in expand hint
		const prompt = buildTokenDispatchPrompt(tailTok, 'Final Node');
		assert.ok(!prompt.includes('aexus-ade token trace <ptr>'), 'dispatch prompt substitutes real tracePtr');
		assert.ok(prompt.includes(`aexus-ade token trace ${tailTok.tracePtr}`), 'dispatch prompt exposes copy-pasteable tracePtr');

		// 3. Direct string-only 3-arg compressTokenHistory also accumulates archived count across hops
		let rolling = '';
		for (let i = 0; i < 12; i++) {
			rolling = compressTokenHistory(rolling, `Phase ${i} modified src/step${i}.ts and passed ${i + 1} tests. ${'details '.repeat(18)}`, `P${i}`);
		}
		const countMatch = /\((\d+)\s+earlier step\(s\) condensed/.exec(rolling);
		assert.ok(countMatch && Number(countMatch[1]) >= 4, `string-only compressTokenHistory must accumulate archived count (got: ${rolling})`);
		assert.ok(rolling.length <= 1200);

		// 4. Parallel join merge preserves archived steps & artifacts from BOTH branches
		const forkJoin = parseGraph('flowchart LR\n  R --> A1\n  A1 --> A2\n  A2 --> J\n  R --> B1\n  B1 --> B2\n  B2 --> J');
		let fjState = startMissionRun(createState(forkJoin), forkJoin, ORG, { now: 1_000 }).state;
		fjState = completeMissionToken(fjState, forkJoin, { tokenId: activeTokenOn(fjState, 'R')!.id, summary: 'Init schema in src/schema.ts', now: 2_000 }).state;
		fjState = completeMissionToken(fjState, forkJoin, { tokenId: activeTokenOn(fjState, 'A1')!.id, summary: 'Backend in src/api.ts passed 12/12 tests', now: 3_000 }).state;
		fjState = completeMissionToken(fjState, forkJoin, { tokenId: activeTokenOn(fjState, 'A2')!.id, summary: 'Backend integration ok', now: 4_000 }).state;
		fjState = completeMissionToken(fjState, forkJoin, { tokenId: activeTokenOn(fjState, 'B1')!.id, summary: 'Frontend in src/ui.tsx passed 9/9 tests', now: 5_000 }).state;
		fjState = completeMissionToken(fjState, forkJoin, { tokenId: activeTokenOn(fjState, 'B2')!.id, summary: 'Frontend polish ok', now: 6_000 }).state;
		const joinTok = activeTokenOn(fjState, 'J')!;
		assert.ok(joinTok.compressedHistory.includes('src/api.ts'), 'join history preserves branch A artifact');
		assert.ok(joinTok.compressedHistory.includes('src/ui.tsx'), 'join history preserves branch B artifact');
	});

	test('recordTokenCheckResult enforces zero-cost bounce retries, on_fail edge routing, direct escalation, and verified completion trace', () => {
		const graphWithFallback = parseGraph([
			'flowchart LR',
			'  N1["Build"] --> N2["Review"]',
			'  N1 -->|fail| F1["Fallback Repair"]',
		].join('\n'));
		const s = startMissionRun(createState(graphWithFallback), graphWithFallback, ORG, { now: 1_000 }).state;
		const tok1 = activeTokenOn(s, 'N1')!;

		const failingSuite = {
			nodeId: 'N1',
			passed: false,
			totalDurationMs: 420,
			results: [{
				checkId: 'chk-1',
				name: 'typecheck',
				command: 'pnpm typecheck',
				hostAlias: 'local',
				passed: false,
				exitCode: 2,
				expectedExitCode: 0,
				durationMs: 420,
				outputTail: 'src/app.ts(12,4): error TS2322',
				error: 'Exit code 2 (expected 0)',
			}],
			summary: '[Check Failed: typecheck — Exit code 2 (expected 0)]',
		};

		// Attempt 1/2 (bounce): token stays active on N1, zero downstream dispatch, checkFailureCount=1
		const bounce1 = recordTokenCheckResult(s, graphWithFallback, {
			tokenId: tok1.id,
			suiteResult: failingSuite,
			onFail: 'bounce',
			maxAutoRetries: 2,
			now: 2_000,
		});
		assert.strictEqual(bounce1.ok, false);
		assert.strictEqual(bounce1.code, 'CHECK_FAILED');
		assert.strictEqual(bounce1.data?.action, 'bounced');
		assert.strictEqual(bounce1.effects.length, 0, 'bounced check must NOT wake downstream LLM reviewer');
		assert.strictEqual(bounce1.state.tokens[tok1.id].status, 'active');
		assert.strictEqual(bounce1.state.tokens[tok1.id].checkFailureCount, 1);
		assert.strictEqual(bounce1.state.nodeTelemetry?.N1?.lastCheckStatus, 'failed');

		// Attempt 2/2 (bounce): still active
		const bounce2 = recordTokenCheckResult(bounce1.state, graphWithFallback, {
			tokenId: tok1.id,
			suiteResult: failingSuite,
			onFail: 'bounce',
			maxAutoRetries: 2,
			now: 3_000,
		});
		assert.strictEqual(bounce2.data?.action, 'bounced');
		assert.strictEqual(bounce2.state.tokens[tok1.id].checkFailureCount, 2);

		// Attempt 3 (> maxAutoRetries 2): automatically routes along `-->|fail|` edge to F1!
		const exhausted = recordTokenCheckResult(bounce2.state, graphWithFallback, {
			tokenId: tok1.id,
			suiteResult: failingSuite,
			onFail: 'bounce',
			maxAutoRetries: 2,
			now: 4_000,
		});
		assert.strictEqual(exhausted.ok, false);
		assert.strictEqual(exhausted.code, 'CHECK_FAILED');
		assert.strictEqual(exhausted.data?.routedViaFailEdge, true);
		assert.ok(activeTokenOn(exhausted.state, 'F1'), 'exhausted bounce auto-routes along on_fail edge');
		assert.strictEqual(activeTokenOn(exhausted.state, 'N2'), undefined, 'Reviewer N2 never woken');

		// `onFail: 'escalate'` bypasses `-->|fail|` edge and escalates directly to supervisor!
		const supBoundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 1,
			supervisors: [{ id: 'sup-l1', tier: 1, managedNodeIds: ['N1', 'N2', 'F1'] }],
			nodeAssignments: {},
		};
		const sEsc = startMissionRun(createState(graphWithFallback, supBoundary), graphWithFallback, ORG, { now: 1_000 }).state;
		const escTok = activeTokenOn(sEsc, 'N1')!;
		const escRes = recordTokenCheckResult(sEsc, graphWithFallback, {
			tokenId: escTok.id,
			suiteResult: failingSuite,
			onFail: 'escalate',
			maxAutoRetries: 0,
			now: 2_000,
		});
		assert.strictEqual(escRes.ok, false);
		assert.strictEqual(escRes.data?.action, 'escalated');
		assert.strictEqual(escRes.data?.escalatedToSupervisorId, 'sup-l1');
		assert.strictEqual(escRes.state.tokens[escTok.id].status, 'frozen_failed');
		assert.ok(escRes.effects.some(e => e.kind === 'escalate_to_supervisor' && e.supervisorId === 'sup-l1'));

		// Passed check after bounce clears lastCheckFailure, logs `check_passed`, and chains into completeMissionToken
		const passingSuite = {
			nodeId: 'N1',
			passed: true,
			totalDurationMs: 310,
			results: [{
				checkId: 'chk-1',
				name: 'typecheck',
				command: 'pnpm typecheck',
				hostAlias: 'local',
				passed: true,
				exitCode: 0,
				expectedExitCode: 0,
				durationMs: 310,
				outputTail: '0 errors',
			}],
			summary: '[Verified: typecheck (ok, 310ms)]',
		};
		const passCheck = recordTokenCheckResult(bounce1.state, graphWithFallback, {
			tokenId: tok1.id,
			suiteResult: passingSuite,
			now: 2_500,
		});
		assert.strictEqual(passCheck.ok, true);
		assert.strictEqual(passCheck.state.tokens[tok1.id].lastCheckFailure, undefined);
		assert.strictEqual(passCheck.state.nodeTelemetry?.N1?.lastCheckStatus, 'passed');
		const done = completeMissionToken(passCheck.state, graphWithFallback, {
			tokenId: tok1.id,
			summary: 'Fixed TS2322 in src/app.ts',
			verificationNote: passingSuite.summary,
			now: 2_600,
		});
		assert.strictEqual(done.ok, true);
		const n2Tok = activeTokenOn(done.state, 'N2')!;
		assert.ok(n2Tok.lastSummary.includes('[Verified: typecheck (ok, 310ms)]'));
		const traceEvents = expandTracePointer(done.state, n2Tok.tracePtr).map(t => t.event);
		assert.ok(traceEvents.includes('check_failed') && traceEvents.includes('check_passed') && traceEvents.includes('complete'));
	});

	test('Join Barrier persists waiting_join tokens in ctx.tokens, preserves uncontaminated siblings on branch recall, and unblocks nested joins on direct barrier recall', () => {
		// Part 1: Diamond A -> B/C -> J
		const diamond = parseGraph([
			'flowchart LR',
			'  A --> B',
			'  A --> C',
			'  B --> J',
			'  C --> J',
		].join('\n'));
		let s1 = startMissionRun(createState(diamond), diamond, ORG, { now: 1_000 }).state;
		s1 = completeMissionToken(s1, diamond, { tokenId: activeTokenOn(s1, 'A')!.id, summary: 'fanout', now: 2_000 }).state;
		// C finishes first -> creates waiting_join token at J
		s1 = completeMissionToken(s1, diamond, { tokenId: activeTokenOn(s1, 'C')!.id, summary: 'C done', now: 3_000 }).state;
		const waitingAtJ = Object.values(s1.tokens).find(t => t.nodeId === 'J' && t.status === 'waiting_join');
		assert.ok(waitingAtJ, 'deliverTokenToTarget MUST persist waiting_join token in state.tokens');
		assert.strictEqual(s1.nodeStates.J, 'waiting_join');

		// Recalling branch B must NOT clobber C's waiting_join token, and must release J immediately without deadlock!
		const recalledB = recallMissionTokens(s1, diamond, {
			caller: { isHumanUser: true },
			branchRootNodeId: 'B',
			reason: 'cancel branch B',
			now: 4_000,
		});
		assert.strictEqual(recalledB.ok, true, recalledB.error);
		assert.strictEqual(recalledB.state.tokens[waitingAtJ.id].status, 'completed', 'sibling waiting_join token transitions to completed on barrier release');
		const jActive = activeTokenOn(recalledB.state, 'J');
		assert.ok(jActive, 'J must release cleanly once branch B is recalled and C already arrived');

		// Part 2: Nested join S -> (A, B) -> J -> K, and S -> C -> K
		const nested = parseGraph([
			'flowchart LR',
			'  S --> A',
			'  S --> B',
			'  S --> C',
			'  A --> J',
			'  B --> J',
			'  J --> K',
			'  C --> K',
		].join('\n'));
		let s2 = startMissionRun(createState(nested), nested, ORG, { now: 10_000 }).state;
		s2 = completeMissionToken(s2, nested, { tokenId: activeTokenOn(s2, 'S')!.id, summary: 'fanout 3', now: 11_000 }).state;
		// A finishes -> waiting_join at J; B is still running; C is still running.
		s2 = completeMissionToken(s2, nested, { tokenId: activeTokenOn(s2, 'A')!.id, summary: 'A done', now: 12_000 }).state;
		const jWaiting = Object.values(s2.tokens).find(t => t.nodeId === 'J' && t.status === 'waiting_join');
		assert.ok(jWaiting, 'waiting_join token for A->J present in state.tokens');

		// Directly recall node J -> cancels J's barrier AND records J as skipped for downstream join K!
		const recallJ = recallMissionTokens(s2, nested, {
			caller: { isHumanUser: true },
			nodeIds: ['J'],
			reason: 'skip intermediate join J',
			now: 13_000,
		});
		assert.strictEqual(recallJ.ok, true, recallJ.error);
		assert.strictEqual(recallJ.state.tokens[jWaiting.id].status, 'recalled');
		assert.strictEqual(Object.values(recallJ.state.joinBarriers).some(b => b.targetNodeId === 'J'), false);

		// Now C finishes -> K must NOT deadlock waiting for recalled J!
		const afterC = completeMissionToken(recallJ.state, nested, {
			tokenId: activeTokenOn(recallJ.state, 'C')!.id,
			summary: 'C done',
			now: 14_000,
		});
		assert.strictEqual(afterC.ok, true, afterC.error);
		assert.ok(activeTokenOn(afterC.state, 'K'), 'nested downstream join K must release once C completes after J was recalled');

		// Part 3: Retrying a recalled branch AFTER its downstream join already released is rejected (no orphan barrier),
		// and retrying a recalled partial waiting_join arrival on J is rejected (cannot bypass unfinished sibling B).
		const retryReleasedBranch = retryMissionToken(recalledB.state, diamond, {
			caller: { isHumanUser: true },
			nodeId: 'B',
			now: 5_000,
		});
		assert.strictEqual(retryReleasedBranch.ok, false);
		assert.strictEqual(retryReleasedBranch.code, 'INVALID_STATE');
		assert.match(retryReleasedBranch.error ?? '', /already released/i);

		const retryPartialJoin = retryMissionToken(recallJ.state, nested, {
			caller: { isHumanUser: true },
			nodeId: 'J',
			now: 13_500,
		});
		assert.strictEqual(retryPartialJoin.ok, false);
		assert.strictEqual(retryPartialJoin.code, 'INVALID_STATE');

		// Part 4: ARCHIVED_LINE_RE round-trips rollup lines containing both files: and key: via legacy string API
		const rollupLine = '... (3 earlier step(s) condensed [N1→N2→N3]: files: src/app.ts, src/api.ts; key: [N2] fixed race | [N3] tests green; expand: aexus-ade token trace tr-3)';
		const nextHistory = compressTokenHistory(rollupLine, 'Shipped v2', 'N4');
		assert.ok(nextHistory.includes('3 earlier step(s) condensed') || nextHistory.includes('4 earlier step(s) condensed'), `Expected condensed count preserved across legacy parse, got:\n${nextHistory}`);
		assert.ok(nextHistory.includes('src/app.ts'), 'archived artifacts preserved across string round-trip');
	});

	test('validateMissionFactoryBoundary validates managedSupervisorIds against self-reference, unknown IDs, reverse-tier supervision, and cycles', () => {
		const graph = parseGraph('flowchart LR\n  A --> B');

		// 1. Reverse-tier supervision (L2 supervising L1) rejected
		const reverseRes = validateMissionFactoryBoundary(ORG, {
			offGraphMaxTier: 2,
			supervisors: [
				{ id: 'sup-l1', tier: 1, managedNodeIds: ['A'] },
				{ id: 'sup-l2', tier: 2, managedNodeIds: ['B'], managedSupervisorIds: ['sup-l1'] },
			],
			nodeAssignments: {},
		}, graph);
		assert.strictEqual(reverseRes.valid, false);
		assert.ok(reverseRes.errors.some(e => /cannot supervise.*strictly top-down/i.test(e)));

		// 2. Self-supervision & unknown supervisor ID rejected
		const selfAndUnknown = validateMissionFactoryBoundary(ORG, {
			offGraphMaxTier: 2,
			supervisors: [
				{ id: 'sup-l1', tier: 1, managedNodeIds: ['A'], managedSupervisorIds: ['sup-l1', 'ghost-sup'] },
			],
			nodeAssignments: {},
		}, graph);
		assert.strictEqual(selfAndUnknown.valid, false);
		assert.ok(selfAndUnknown.errors.some(e => /cannot manage itself/i.test(e)));
		assert.ok(selfAndUnknown.errors.some(e => /unknown subordinate supervisor/i.test(e)));

		// 3. Valid strict top-down managedSupervisorIds passes
		const validRes = validateMissionFactoryBoundary(ORG, {
			offGraphMaxTier: 2,
			supervisors: [
				{ id: 'sup-l1', tier: 1, managedNodeIds: ['A'], managedSupervisorIds: ['sup-l2'] },
				{ id: 'sup-l2', tier: 2, managedNodeIds: ['B'], parentSupervisorId: 'sup-l1' },
			],
			nodeAssignments: {},
		}, graph);
		assert.strictEqual(validRes.valid, true, validRes.errors.join(' '));
	});

	test('multi-wave concurrent nodeStates never get clobbered by Wave 1 finishing while Wave 2 is active, and resolveMissionGate supports queued multi-wave gates + tokenId', () => {
		const graph = parseGraph('flowchart LR\n  S --> G{"Release Gate"}\n  G --> D');
		let state = createState(graph);
		state = {
			...state,
			triggers: [{ id: 'tr-1', nodeId: 'S', kind: 'interval', intervalMs: 10_000, enabled: true, fireCount: 0, autoStartOnMissionStart: true }],
		};
		state = startMissionRun(state, graph, ORG, { now: 1_000 }).state;
		const sWave1 = activeTokenOn(state, 'S')!;
		state = completeMissionToken(state, graph, { tokenId: sWave1.id, summary: 'Wave 1 build', now: 2_000 }).state;
		const gWave1 = Object.values(state.tokens).find(t => t.nodeId === 'G' && t.status === 'waiting_gate')!;
		assert.ok(gWave1);

		// Fire Wave 2 while Wave 1 is waiting at G -> S completes Wave 2 -> BOTH Wave 1 and Wave 2 are queued at Gate G!
		state = fireMissionSourceTrigger(state, graph, { triggerId: 'tr-1', payloadSummary: 'Wave 2 start', now: 3_000 }).state;
		const sWave2 = activeTokenOn(state, 'S')!;
		state = completeMissionToken(state, graph, { tokenId: sWave2.id, summary: 'Wave 2 build', now: 4_000 }).state;
		const gWave2 = Object.values(state.tokens).find(t => t.nodeId === 'G' && t.status === 'waiting_gate' && t.id !== gWave1.id)!;
		assert.ok(gWave2, 'Wave 2 queues a second waiting_gate token on G');

		// Approve explicitly Wave 2 first via tokenId -> Gate G MUST remain waiting_gate for Wave 1 AND re-surface Wave 1 inbox todo!
		const resW2 = resolveMissionGate(state, graph, { nodeId: 'G', tokenId: gWave2.id, decision: 'approve', note: 'Expedite wave 2', now: 5_000 });
		assert.strictEqual(resW2.ok, true, resW2.error);
		assert.strictEqual(resW2.data?.resolvedTokenId, gWave2.id);
		assert.strictEqual(resW2.data?.remainingQueuedGateCount, 1);
		assert.strictEqual(resW2.state.nodeStates.G, 'waiting_gate', 'Gate G remains waiting_gate while Wave 1 is still queued');
		assert.ok(resW2.effects.some(e => e.kind === 'upsert_gate_inbox' && e.tokenId === gWave1.id), 'Re-emits upsert_gate_inbox for next queued wave token');

		// Approve Wave 1 -> both Wave 2 and Wave 1 are now active on D!
		const resW1 = resolveMissionGate(resW2.state, graph, { nodeId: 'G', decision: 'approve', now: 6_000 });
		assert.strictEqual(resW1.ok, true, resW1.error);
		assert.strictEqual(resW1.state.nodeStates.G, 'completed');
		const activeOnD = Object.values(resW1.state.tokens).filter(t => t.nodeId === 'D' && t.status === 'active');
		assert.strictEqual(activeOnD.length, 2, 'Two waves concurrently active on node D');

		// Completing first wave on D must NOT overwrite nodeStates.D to completed while second wave is still active!
		const afterFirstD = completeMissionToken(resW1.state, graph, { tokenId: activeOnD[0].id, summary: 'D wave A done', now: 7_000 });
		assert.strictEqual(afterFirstD.ok, true);
		assert.strictEqual(afterFirstD.state.nodeStates.D, 'active', 'nodeStates.D stays active while sibling wave token is still active');

		const afterSecondD = completeMissionToken(afterFirstD.state, graph, { tokenId: activeOnD[1].id, summary: 'D wave B done', now: 8_000 });
		assert.strictEqual(afterSecondD.ok, true);
		assert.strictEqual(afterSecondD.state.nodeStates.D, 'completed', 'nodeStates.D becomes completed once all waves finish');
	});

	test('expandTracePointer retains NEWEST maxEntries hops (including latest rejection) on >100-step chains and prunes history bounds', () => {
		const graph = parseGraph('flowchart LR\n  A --> R');
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		// Drive 60 reject/rework cycles (>120 trace entries)
		let ts = 2_000;
		for (let i = 0; i < 60; i++) {
			const aTok = activeTokenOn(state, 'A')!;
			state = completeMissionToken(state, graph, { tokenId: aTok.id, summary: `impl-${i}`, now: ts++ }).state;
			const rTok = activeTokenOn(state, 'R')!;
			state = rejectMissionToken(state, graph, { tokenId: rTok.id, reason: `reject-${i}`, targetNodeId: 'A', now: ts++ }).state;
		}
		const latestA = activeTokenOn(state, 'A')!;
		const expanded = expandTracePointer(state, latestA.tracePtr, 20);
		assert.strictEqual(expanded.length, 20);
		const lastEntry = expanded[expanded.length - 1];
		assert.strictEqual(lastEntry.ptr, latestA.tracePtr, 'Newest rejection trace entry MUST be preserved');
		assert.ok((lastEntry.summary ?? '').includes('reject-59'), `Expected latest reject-59, got: ${lastEntry.summary}`);
		assert.ok(expanded[0].timestamp < expanded[expanded.length - 1].timestamp, 'Returned trace slice stays in chronological order');
	});

	test('failMissionToken forwards returnToNodeId/returnWaveId across fail edges so rework fallback returns to Reviewer', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  A --> R',
			'  A -.fail.-> F',
			'  F --> R',
			'  R --> Done',
		].join('\n'));
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		state = completeMissionToken(state, graph, { tokenId: activeTokenOn(state, 'A')!.id, summary: 'A v1', now: 2_000 }).state;
		const rTok1 = activeTokenOn(state, 'R')!;
		// Reviewer rejects back to A
		state = rejectMissionToken(state, graph, { tokenId: rTok1.id, reason: 'fix edge case', targetNodeId: 'A', now: 3_000 }).state;
		const aRework = activeTokenOn(state, 'A')!;
		assert.strictEqual(aRework.returnToNodeId, 'R');
		assert.strictEqual(aRework.returnWaveId, rTok1.waveId);

		// A hits failure during rework and routes to fallback node F -> F MUST inherit returnToNodeId='R' & returnWaveId!
		const failed = failMissionToken(state, graph, { tokenId: aRework.id, reason: 'primary build crashed', now: 4_000 });
		assert.strictEqual(failed.ok, true, failed.error);
		assert.strictEqual(failed.data?.routedViaFailEdge, true);
		const fTok = activeTokenOn(failed.state, 'F')!;
		assert.ok(fTok);
		assert.strictEqual(fTok.returnToNodeId, 'R', 'Fallback node F inherits returnToNodeId');
		assert.strictEqual(fTok.returnWaveId, rTok1.waveId, 'Fallback node F inherits returnWaveId');

		// Completing F restores wave-1 back at Reviewer R!
		const afterF = completeMissionToken(failed.state, graph, { tokenId: fTok.id, summary: 'F recovered fix', now: 5_000 });
		assert.strictEqual(afterF.ok, true, afterF.error);
		const rTok2 = activeTokenOn(afterF.state, 'R')!;
		assert.ok(rTok2);
		assert.strictEqual(rTok2.waveId, rTok1.waveId, 'Fallback completion returns to Reviewer R with original waveId');
	});

	test('applySafeMissionPatch merges ALL completed parallel upstream summaries and histories into newly connected multi-inDegree node', () => {
		const initial = parseGraph([
			'flowchart LR',
			'  S --> A',
			'  S --> B',
			'  A --> OldMerge',
			'  B --> OldMerge',
		].join('\n'));
		let state = startMissionRun(createState(initial), initial, ORG, { now: 1_000 }).state;
		state = completeMissionToken(state, initial, { tokenId: activeTokenOn(state, 'S')!.id, summary: 'S start', now: 2_000 }).state;
		state = completeMissionToken(state, initial, { tokenId: activeTokenOn(state, 'A')!.id, summary: 'Alpha API schema done', now: 3_000 }).state;
		state = completeMissionToken(state, initial, { tokenId: activeTokenOn(state, 'B')!.id, summary: 'Beta UI layout done', now: 4_000 }).state;
		// Both A and B are completed; OldMerge is active. Patch OldMerge -> NewMerge!
		const patched = applySafeMissionPatch(state, initial, {
			caller: { isHumanUser: true },
			newMermaidText: [
				'flowchart LR',
				'  S --> A',
				'  S --> B',
				'  A --> NewMerge',
				'  B --> NewMerge',
			].join('\n'),
			reason: 'replace merge node',
			now: 5_000,
		});
		assert.strictEqual(patched.ok, true, patched.error);
		const newMergeTok = activeTokenOn(patched.state, 'NewMerge');
		assert.ok(newMergeTok, 'NewMerge receives merged active token immediately');
		assert.ok(newMergeTok.lastSummary.includes('Alpha API schema done'), `Must include branch A summary, got: ${newMergeTok.lastSummary}`);
		assert.ok(newMergeTok.lastSummary.includes('Beta UI layout done'), `Must include branch B summary, got: ${newMergeTok.lastSummary}`);
	});

	test('recordMissionNodeTurnUsage honors measured contextInitTokens/contextTierDocTokens without fake ratios or double-counting', () => {
		const graph = parseGraph('flowchart LR\n  A --> B');
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		// Turn 1 with exact measured init + contract tokens
		state = recordMissionNodeTurnUsage(state, 'A', {
			inputTokens: 6_000,
			outputTokens: 800,
			totalTokens: 6_800,
			contextInitTokens: 4_000,
			contextTierDocTokens: 1_200,
			model: 'claude-sonnet-4-6',
		});
		const tel1 = state.nodeTelemetry?.A;
		assert.ok(tel1);
		assert.strictEqual(tel1.contextInitTokens, 4_000);
		assert.strictEqual(tel1.contextTierDocTokens, 1_200);
		assert.strictEqual(tel1.contextSourceTokens, 1_600, 'Turn 1 workspace tokens exclude init + contract without double-counting');

		// Turn 2 on a pure worker with 0 init / 0 contract (never fabricates 8%/14% ratios!)
		state = recordMissionNodeTurnUsage(state, 'B', {
			inputTokens: 900,
			outputTokens: 300,
			totalTokens: 1_200,
			contextInitTokens: 0,
			contextTierDocTokens: 0,
		});
		const telB = state.nodeTelemetry?.B;
		assert.ok(telB);
		assert.strictEqual(telB.contextInitTokens, 0);
		assert.strictEqual(telB.contextTierDocTokens, 0);
		assert.strictEqual(telB.contextSourceTokens, 1_200);
	});

	test('FinOps budget circuit-breaker auto-pauses on ceiling, blocks resume with BUDGET_EXCEEDED until raised, and aggregates tier/host ledgers', () => {
		const graph = parseGraph('flowchart LR\n  A["GPU Train"] --> B["Local Report"]');
		let state = createState(graph);
		state = {
			...state,
			boundary: {
				...state.boundary,
				nodeAssignments: {
					A: { tier: 2, agentId: 'emp-A', hostAlias: 'ubuntu-h100' },
					B: { tier: 3, agentId: 'emp-B', hostAlias: 'local' },
				},
			},
		};
		state = startMissionRun(state, graph, ORG, { now: 1_000 }).state;
		state = setMissionBudgetLimit(state, 1.50, 1_500);
		assert.strictEqual(state.budgetLimitUsd, 1.50);
		assert.strictEqual(state.budgetCircuitTripped, false);

		// Turn 1: $0.90 spent (60% of $1.50) with 80% cache hit ratio
		state = recordMissionNodeTurnUsage(state, 'A', {
			inputTokens: 40_000,
			outputTokens: 10_000,
			cacheReadTokens: 160_000,
			totalTokens: 210_000,
			costUsd: 0.90,
			timestamp: 2_000,
		});
		assert.strictEqual(state.status, 'running');
		const midSummary = computeMissionFinOpsSummary(state, graph.nodes);
		assert.strictEqual(midSummary.totalCostUsd, 0.90);
		assert.strictEqual(midSummary.budgetUsedPct, 60);
		assert.strictEqual(midSummary.cacheSavingsPct, 80);
		assert.strictEqual(midSummary.severity, 'normal');

		// Turn 2: +$0.75 pushes total to $1.65 >= $1.50 -> auto-pauses & trips circuit-breaker!
		state = recordMissionNodeTurnUsage(state, 'B', {
			inputTokens: 20_000,
			outputTokens: 5_000,
			totalTokens: 25_000,
			costUsd: 0.75,
			timestamp: 3_000,
		});
		assert.strictEqual(state.status, 'paused', 'Exceeding FinOps budget must auto-pause running Mission');
		assert.strictEqual(state.budgetCircuitTripped, true);

		// Attempting to resume while over budget is refused with BUDGET_EXCEEDED
		const blockedResume = resumeMissionRun(state, 3_500);
		assert.strictEqual(blockedResume.ok, false);
		assert.strictEqual(blockedResume.code, 'BUDGET_EXCEEDED');

		const trippedSummary = computeMissionFinOpsSummary(state, graph.nodes);
		assert.strictEqual(trippedSummary.totalCostUsd, 1.65);
		assert.strictEqual(trippedSummary.budgetCircuitTripped, true);
		assert.strictEqual(trippedSummary.severity, 'tripped');
		assert.strictEqual(trippedSummary.byTier.length, 2);
		assert.strictEqual(trippedSummary.byHost.length, 2);
		assert.strictEqual(trippedSummary.byHost[0].label, '@ubuntu-h100');
		assert.strictEqual(trippedSummary.byNode[0].nodeId, 'A');

		// Raising budget above cumulative spend clears breaker and unlocks resumeMissionRun
		state = setMissionBudgetLimit(state, 5.00, 4_000);
		assert.strictEqual(state.budgetCircuitTripped, false);
		const resumed = resumeMissionRun(state, 4_500);
		assert.strictEqual(resumed.ok, true, resumed.error);
		assert.strictEqual(resumed.state.status, 'running');
	});

	test('distillMissionNodeContext clears noisy context, preserves cumulative cost & completed tokens, and re-dispatches active node', () => {
		const graph = parseGraph('flowchart LR\n  A["Step A"] --> B["Step B"]');
		let state = createState(graph);
		state = {
			...state,
			boundary: {
				...state.boundary,
				nodeAssignments: {
					A: { tier: 2, agentId: 'emp-A' },
					B: { tier: 2, agentId: 'emp-B' },
				},
			},
		};
		state = startMissionRun(state, graph, ORG, { now: 1_000 }).state;
		state = completeMissionToken(state, graph, { tokenId: activeTokenOn(state, 'A')!.id, summary: 'A finished cleanly', now: 2_000 }).state;
		const aCompletedTokId = Object.values(state.tokens).find(t => t.nodeId === 'A')!.id;
		state = recordMissionNodeTurnUsage(state, 'B', {
			inputTokens: 120_000,
			outputTokens: 12_000,
			totalTokens: 132_000,
			costUsd: 0.42,
			isNoiseTurn: true,
			timestamp: 2_500,
		});
		assert.ok((state.nodeTelemetry?.B?.contextNoiseTokens ?? 0) > 0);

		const distilled = distillMissionNodeContext(state, graph, 'B', {
			memo: 'Switch to streaming parser',
			now: 3_000,
		});
		assert.strictEqual(distilled.ok, true, distilled.error);
		assert.strictEqual(distilled.state.nodeTelemetry?.B?.contextNoiseTokens, 0, 'Distill clears noise tokens');
		assert.strictEqual(distilled.state.nodeTelemetry?.B?.costUsd, 0.42, 'Distill preserves cumulative spend honestly');
		const bTok = activeTokenOn(distilled.state, 'B')!;
		assert.ok(bTok.lastSummary.includes('Switch to streaming parser'));
		const traceChain = expandTracePointer(distilled.state, bTok.tracePtr, 20);
		assert.ok(traceChain.some(e => e.event === 'distill'), 'Distill records a distill trace entry');
		assert.ok(distilled.effects.some(e => e.kind === 'stop_agent'), 'Distill stops bloated agent session');
		assert.ok(distilled.effects.some(e => e.kind === 'dispatch_token'), 'Distill re-dispatches clean prompt to active node');

		// Distilling an already-completed node MUST NOT mutate its historical completed token
		const aOrigSummary = distilled.state.tokens[aCompletedTokId].lastSummary;
		const idleDistill = distillMissionNodeContext(distilled.state, graph, 'A', { now: 3_500 });
		assert.strictEqual(idleDistill.ok, true);
		assert.strictEqual(idleDistill.state.tokens[aCompletedTokId].status, 'completed');
		assert.strictEqual(idleDistill.state.tokens[aCompletedTokId].lastSummary, aOrigSummary);
	});

	test('appendMissionDagRevision tracks versioned Mermaid diffs and skips duplicate or invalid snapshots', () => {
		const m1 = 'flowchart LR\n  A["Start"] --> B["Build"]';
		const m2 = 'flowchart LR\n  A["Start"] --> B["Build"]\n  B --> C["Verify"]';
		const g1 = parseGraph(m1);
		const g2 = parseGraph(m2);
		let state = createState(g1);
		state = appendMissionDagRevision(state, m1, 'Mission started (v1)', undefined, g1, 1_000);
		assert.strictEqual(state.revisions?.length, 1);
		assert.strictEqual(state.revisions?.[0].version, 1);

		// Duplicate whitespace-only change is ignored
		state = appendMissionDagRevision(state, `  ${m1}\n  `, 'No-op', g1, g1, 1_500);
		assert.strictEqual(state.revisions?.length, 1);

		// Invalid Mermaid is ignored
		state = appendMissionDagRevision(state, 'not valid mermaid syntax %%%%', 'Broken', g1, undefined, 1_800);
		assert.strictEqual(state.revisions?.length, 1);

		// Real topology patch records v2 with addedNodeIds=['C']
		state = appendMissionDagRevision(state, m2, 'Add Verify step', g1, g2, 2_000);
		assert.strictEqual(state.revisions?.length, 2);
		assert.strictEqual(state.revisions?.[1].version, 2);
		assert.deepStrictEqual(state.revisions?.[1].addedNodeIds, ['C']);
	});

	test('unified model pricing catalog estimates input/output/cache rates across all 8 engines, handles local zero-cost & user overrides', () => {
		// 1. OpenAI/Codex inclusive inputTokens avoids double-billing cached input tokens
		const codexEst = estimateTokenCostUsd({
			inputTokens: 1_000_000, // OpenAI style: includes 800k cached input tokens
			outputTokens: 100_000,
			cacheReadTokens: 800_000,
			totalTokens: 1_100_000,
			model: 'gpt-5.3-codex',
			engineId: 'aexus-codex',
		});
		// Billable non-cached input = 200k * $1.75/M ($0.35) + cacheRead 800k * $0.175/M ($0.14) + output 100k * $14/M ($1.40) = $1.89
		assert.strictEqual(codexEst.estimated, true);
		assert.strictEqual(codexEst.isLocalFree, false);
		assert.strictEqual(codexEst.costUsd, 1.89);

		// 2. DSH JSON tuple model ID unwraps cleanly to deepseek-r1
		const dshEst = estimateTokenCostUsd({
			inputTokens: 500_000,
			outputTokens: 200_000,
			cacheReadTokens: 500_000,
			model: '["deepseek-official","deepseek-r1"]',
			engineId: 'aexus-dsh',
		});
		// 0.5*0.55 ($0.275) + 0.2*2.19 ($0.438) + 0.5*0.14 ($0.07) = $0.783
		assert.strictEqual(dshEst.estimated, true);
		assert.strictEqual(dshEst.costUsd, 0.783);

		// 3. Antigravity / Gemini, OpenCode / Qwen, Pi / engine default fallback when model is omitted
		const agyEst = estimateTokenCostUsd({ inputTokens: 400_000, outputTokens: 100_000, model: 'gemini-2.5-pro', engineId: 'aexus-antigravity' });
		assert.strictEqual(agyEst.costUsd, 1.5); // 0.4*1.25 + 0.1*10
		const opencodeEst = estimateTokenCostUsd({ inputTokens: 1_000_000, outputTokens: 500_000, engineId: 'aexus-opencode' });
		assert.strictEqual(opencodeEst.source, 'engine_default');
		assert.strictEqual(opencodeEst.costUsd, 0.9); // qwen3-coder: 1*0.3 + 0.5*1.2

		// 4. Built-in local / self-hosted zero-cost models always price at $0.00
		assert.strictEqual(isBuiltInLocalZeroCostModel('ollama/qwen3:32b'), true);
		assert.strictEqual(isBuiltInLocalZeroCostModel('vllm/deepseek-r1-distill'), true);
		assert.strictEqual(isBuiltInLocalZeroCostModel('openrouter/qwen/qwen3:free'), true);
		const localEst = estimateTokenCostUsd({ inputTokens: 2_000_000, outputTokens: 500_000, model: 'ollama/qwen3:32b' });
		assert.strictEqual(localEst.costUsd, 0);
		assert.strictEqual(localEst.isLocalFree, true);
		assert.strictEqual(localEst.estimated, false);

		// 5. User settings overrides: custom rates, glob patterns, and explicit `local: true`
		const overrides = {
			'gpt-5.3-codex': { inputPerMillion: 4.0, outputPerMillion: 20.0, cacheReadPerMillion: 0.4, cacheWritePerMillion: 5.0 },
			'corp-cluster/*': { local: true },
		};
		const customCodex = estimateTokenCostUsd({
			inputTokens: 500_000,
			outputTokens: 100_000,
			cacheWriteTokens: 200_000,
			model: 'openai/gpt-5.3-codex',
			overrides,
		});
		// 0.5*4 + 0.1*20 + 0.2*5 = $5.00
		assert.strictEqual(customCodex.source, 'override');
		assert.strictEqual(customCodex.costUsd, 5);

		const customLocal = resolveModelTokenPricingRate('corp-cluster/llama-70b', 'aexus-opencode', overrides);
		assert.strictEqual(customLocal.isLocalFree, true);
		assert.strictEqual(customLocal.source, 'override_local');
	});

	test('FinOps engine activates budget circuit-breaker on non-Claude engines via token estimation and reconciles interim estimates against real provider bills without double-counting', () => {
		const graph = parseGraph('flowchart LR\n  A["Codex Worker"] --> B["Claude Reviewer"]\n  A --> C["Local Ollama"]');
		let state = createState(graph);
		state = {
			...state,
			boundary: {
				...state.boundary,
				nodeAssignments: {
					A: { tier: 2, agentId: 'emp-codex', hostAlias: 'local' },
					B: { tier: 3, agentId: 'emp-claude', hostAlias: 'local' },
					C: { tier: 2, agentId: 'emp-local', hostAlias: 'gpu-box' },
				},
			},
		};
		state = setMissionBudgetLimit(state, 1.50, 1_000);
		const started = startMissionRun(state, graph, ORG, { now: 1_100 });
		assert.strictEqual(started.ok, true, started.error);
		state = started.state;

		// 1. Local Ollama model consumes massive tokens at $0.00 -> never trips budget
		state = recordMissionNodeTurnUsage(state, 'C', {
			inputTokens: 1_000_000,
			outputTokens: 500_000,
			model: 'ollama/qwen3:32b',
			engineId: 'aexus-opencode',
			timestamp: 1_200,
		});
		assert.strictEqual(state.nodeTelemetry?.C?.costUsd, 0);
		assert.strictEqual(state.nodeTelemetry?.C?.costLocalFree, true);
		assert.strictEqual(state.nodeTelemetry?.C?.costEstimated, undefined);
		assert.strictEqual(state.status, 'running');

		// 2. Claude streams interim delta (no real cost yet -> estimated $0.0625), then completes with real total_cost_usd=$0.08
		//    Must reconcile to exact $0.08 with ZERO double-counting and clear costEstimated!
		state = recordMissionNodeTurnUsage(state, 'B', {
			inputTokens: 10_000,
			outputTokens: 500,
			model: 'claude-opus-4-6',
			engineId: 'aexus-claude',
			turns: 0,
			timestamp: 1_300,
		});
		assert.strictEqual(state.nodeTelemetry?.B?.costUsd, 0.0625);
		assert.strictEqual(state.nodeTelemetry?.B?.costEstimated, true);
		state = recordMissionNodeTurnUsage(state, 'B', {
			inputTokens: 2_000,
			outputTokens: 200,
			costUsd: 0.08,
			model: 'claude-opus-4-6',
			engineId: 'aexus-claude',
			turns: 1,
			timestamp: 1_400,
		});
		assert.strictEqual(state.nodeTelemetry?.B?.costUsd, 0.08, 'Real CLI bill replaces pending interim estimate without double-counting');
		assert.strictEqual(state.nodeTelemetry?.B?.costEstimated, undefined, 'Reconciled real bill clears estimated flag');

		// 3. Codex emits tokens WITHOUT costUsd -> auto-estimated & trips $1.50 hard budget circuit-breaker!
		//    400k in * $1.75/M ($0.70) + 60k out * $14/M ($0.84) = $1.54 -> total $1.62 >= $1.50!
		state = recordMissionNodeTurnUsage(state, 'A', {
			inputTokens: 400_000,
			outputTokens: 60_000,
			model: 'gpt-5.3-codex',
			engineId: 'aexus-codex',
			timestamp: 1_500,
		});
		assert.strictEqual(state.nodeTelemetry?.A?.costUsd, 1.54);
		assert.strictEqual(state.nodeTelemetry?.A?.costEstimated, true);
		assert.strictEqual(state.budgetCircuitTripped, true, 'Codex token-estimated spend MUST trip hard budget circuit-breaker');
		assert.strictEqual(state.status, 'paused', 'Mission pauses immediately upon non-Claude budget breach');

		const summary = computeMissionFinOpsSummary(state, graph.nodes);
		assert.strictEqual(summary.totalCostUsd, 1.62);
		assert.strictEqual(summary.hasEstimatedCost, true);
		assert.strictEqual(summary.estimatedCostUsd, 1.54);
		assert.strictEqual(summary.hasLocalFreeNodes, true);
		assert.strictEqual(summary.budgetCircuitTripped, true);
		assert.strictEqual(summary.byNode.find(n => n.nodeId === 'A')?.costEstimated, true);
		assert.strictEqual(summary.byNode.find(n => n.nodeId === 'B')?.costEstimated, undefined);
		assert.strictEqual(summary.byNode.find(n => n.nodeId === 'C')?.costLocalFree, true);
	});

	test('canvas editing primitives: renameEdgeLabelInMermaid, removeNodesFromMermaid, magnetic snap alignment, and 50-step MissionCanvasHistoryStack', () => {
		const initialMmd = [
			'flowchart LR',
			'  A["Plan"] --> B["Build"]',
			'  B --> C["Verify"]',
			'  C --> D["Ship"]',
			'  %% check B [name=unit, command="npm test"]',
			'  %% check D [name=release, command="npm run check"]',
		].join('\n');

		// 1. Edge label rename updates label and automatically switches polarity for fail keywords
		const labeledMmd = renameEdgeLabelInMermaid(initialMmd, 'A', 'B', 'spec');
		const parsedLabeled = parseMissionMermaidDag(labeledMmd);
		assert.strictEqual(parsedLabeled.edges.find(e => e.from === 'A' && e.to === 'B')?.label, 'spec');
		assert.strictEqual(getMissionEdgeKind(parsedLabeled.edges.find(e => e.from === 'A' && e.to === 'B')!), 'success');

		const failMmd = renameEdgeLabelInMermaid(labeledMmd, 'A', 'B', 'fail');
		const parsedFail = parseMissionMermaidDag(failMmd);
		assert.strictEqual(getMissionEdgeKind(parsedFail.edges.find(e => e.from === 'A' && e.to === 'B')!), 'fail');

		const clearedMmd = renameEdgeLabelInMermaid(failMmd, 'A', 'B', '');
		const parsedCleared = parseMissionMermaidDag(clearedMmd);
		assert.strictEqual(parsedCleared.edges.find(e => e.from === 'A' && e.to === 'B')?.label, undefined);
		assert.strictEqual(getMissionEdgeKind(parsedCleared.edges.find(e => e.from === 'A' && e.to === 'B')!), 'success');

		// 2. Batch node deletion removes target nodes, incident edges, and bound %% check directives atomically
		const afterBatchDel = removeNodesFromMermaid(initialMmd, ['B', 'C']);
		const parsedBatch = parseMissionMermaidDag(afterBatchDel);
		assert.deepStrictEqual(parsedBatch.nodes.map(n => n.id), ['A', 'D']);
		assert.strictEqual(parsedBatch.edges.length, 0);
		assert.strictEqual(afterBatchDel.includes('%% check B'), false);
		assert.strictEqual(afterBatchDel.includes('%% check D'), true);

		// 3. Smart alignment snap guides lock X/Y within 8px threshold and stay 0 outside threshold
		const stationary = [
			{ id: 'N1', minX: 100, maxX: 300, minY: 100, maxY: 200 }, // center (200, 150)
			{ id: 'N2', minX: 500, maxX: 700, minY: 300, maxY: 400 }, // center (600, 350)
		];
		const snapHit = computeNodeDragSnapAlignment({ minX: 104, maxX: 304, minY: 305, maxY: 405 }, stationary, 8);
		assert.strictEqual(snapHit.dx, -4, 'Snaps left/center X to N1 (delta -4)');
		assert.strictEqual(snapHit.dy, -5, 'Snaps top/middle Y to N2 (delta -5)');
		assert.strictEqual(snapHit.guides.length, 2);
		assert.ok(snapHit.guides.some(g => g.axis === 'x'));
		assert.ok(snapHit.guides.some(g => g.axis === 'y'));

		const snapMiss = computeNodeDragSnapAlignment({ minX: 120, maxX: 320, minY: 230, maxY: 330 }, stationary, 8);
		assert.strictEqual(snapMiss.dx, 0);
		assert.strictEqual(snapMiss.dy, 0);
		assert.strictEqual(snapMiss.guides.length, 0);

		// 4. 50-step bounded history stack enforces cap, deep-clones, coalesces rapid edits, and clears redo on new push
		const stack = new MissionCanvasHistoryStack(50);
		for (let i = 1; i <= 55; i++) {
			stack.push({
				mermaidText: `flowchart LR\n  N${i}["Step ${i}"]`,
				positions: { [`N${i}`]: { x: i * 10, y: 100 } },
				nodePrompts: { [`N${i}`]: `Prompt ${i}` },
				nodeChecks: {},
				label: `Step ${i}`,
				timestamp: i * 5_000,
			});
		}
		assert.strictEqual(stack.undoCount, 50, 'History stack caps at 50 entries');
		assert.strictEqual(stack.peekUndoLabel(), 'Step 55');

		const restored = stack.undo({
			mermaidText: 'flowchart LR\n  N56["Current"]',
			positions: { N56: { x: 560, y: 100 } },
			nodePrompts: {},
			nodeChecks: {},
			label: '',
		});
		assert.ok(restored);
		assert.strictEqual(restored.mermaidText, 'flowchart LR\n  N55["Step 55"]');
		assert.strictEqual(stack.redoCount, 1);

		const redone = stack.redo(restored);
		assert.ok(redone);
		assert.strictEqual(redone.mermaidText, 'flowchart LR\n  N56["Current"]');
		assert.strictEqual(stack.redoCount, 0);

		// Rapid coalesced edits keep original baseline
		const coalStack = new MissionCanvasHistoryStack(50);
		coalStack.push({ mermaidText: 'v0', positions: {}, nodePrompts: {}, nodeChecks: {}, label: 'Edit', timestamp: 1_000 }, { coalesceMs: 1200 });
		coalStack.push({ mermaidText: 'v1', positions: {}, nodePrompts: {}, nodeChecks: {}, label: 'Edit', timestamp: 1_500 }, { coalesceMs: 1200 });
		assert.strictEqual(coalStack.undoCount, 1);
		assert.strictEqual(coalStack.undo({ mermaidText: 'v2', positions: {}, nodePrompts: {}, nodeChecks: {}, label: '' })?.mermaidText, 'v0');
	});

	test('collectValidUpstreamRollbackCandidates returns all executed upstream ancestors ordered earliest -> direct predecessor and syncs upsert_gate_inbox (Audit #9)', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  A["Design Spec"] --> B["Implement"]',
			'  B --> C["Verify"]',
			'  C --> G{"Release Gate"}',
			'  G --> D["Deploy"]',
			'  A --> X["Parallel Side"]',
		].join('\n'));
		let state = startMissionRun(createState(graph), graph, ORG, { now: 1_000 }).state;
		const tokA = activeTokenOn(state, 'A')!;
		state = completeMissionToken(state, graph, { tokenId: tokA.id, summary: 'Spec done', now: 2_000 }).state;
		const tokB = activeTokenOn(state, 'B')!;
		state = completeMissionToken(state, graph, { tokenId: tokB.id, summary: 'Impl done', now: 3_000 }).state;
		const tokC = activeTokenOn(state, 'C')!;
		const toGate = completeMissionToken(state, graph, { tokenId: tokC.id, summary: 'Verified', now: 4_000 });
		state = toGate.state;

		const gateTok = Object.values(state.tokens).find(t => t.nodeId === 'G' && t.status === 'waiting_gate')!;
		assert.ok(gateTok);

		// Helper returns all 3 executed upstream reachable ancestors [A, B, C], excludes downstream D and sibling X
		const candidates = collectValidUpstreamRollbackCandidates(state, graph, 'G', gateTok.tracePtr, gateTok.fromNodeId);
		assert.deepStrictEqual(candidates.map(c => c.id), ['A', 'B', 'C']);
		assert.strictEqual(candidates[0].isDirectPredecessor, false);
		assert.strictEqual(candidates[2].isDirectPredecessor, true);

		// upsert_gate_inbox effect mirrors the exact same full upstream candidate list
		const inboxEffect = toGate.effects.find(e => e.kind === 'upsert_gate_inbox');
		assert.ok(inboxEffect && inboxEffect.kind === 'upsert_gate_inbox');
		assert.deepStrictEqual(inboxEffect.rollbackCandidates.map(c => c.id), ['A', 'B', 'C']);

		// Every single returned candidate is accepted by resolveMissionGate
		for (const cand of candidates) {
			const res = resolveMissionGate(state, graph, { nodeId: 'G', decision: 'reject', rollbackNodeId: cand.id, note: `Rework from ${cand.id}`, now: 5_000 });
			assert.strictEqual(res.ok, true, `Rollback target ${cand.id} must be accepted by engine: ${res.error}`);
			const bounced = res.state.tokens[res.data!.nextTokenIds[0]];
			assert.strictEqual(bounced.nodeId, cand.id);
		}

		// Empty/unknown trace never emits invalid unexecuted candidates
		assert.deepStrictEqual(
			collectValidUpstreamRollbackCandidates(state, graph, 'G', 'missing-trace-ptr', 'C'),
			[],
		);
	});

	test('multi-level concurrency scheduler enforces global/host/provider caps, queues excess wide fan-out in FIFO order, protects GPU watchPid slots, and drains work-conservingly (Audit #15)', () => {
		// 1. Provider inference maps cloud APIs cleanly and exempts self-hosted local engines
		assert.strictEqual(inferMissionConcurrencyProvider('claude-opus-4-6', 'claude'), 'anthropic');
		assert.strictEqual(inferMissionConcurrencyProvider('gpt-5.3-codex', 'codex'), 'openai');
		assert.strictEqual(inferMissionConcurrencyProvider('gemini-2.5-pro', 'acp'), 'google');
		assert.strictEqual(inferMissionConcurrencyProvider('deepseek-r1', 'kilo'), 'deepseek');
		assert.strictEqual(inferMissionConcurrencyProvider('claude-fable-5-2', 'kilo'), 'anthropic');
		assert.strictEqual(inferMissionConcurrencyProvider('gpt-6.2-astra', 'kilo'), 'openai');
		assert.strictEqual(inferMissionConcurrencyProvider('gemini-4-argon', 'kilo'), 'google');
		assert.strictEqual(inferMissionConcurrencyProvider('ollama/llama3.3', 'kilo'), undefined);
		assert.strictEqual(inferMissionConcurrencyProvider('vllm/qwen2.5-72b', 'kilo'), undefined);
		assert.strictEqual(inferMissionConcurrencyProvider('mlx-community/qwen', 'pi'), undefined);

		// 2. Wide 6-branch fan-out across local, gpu-a, and gpu-b with distinct providers
		const graph = parseGraph([
			'flowchart LR',
			'  Root["Dispatch"] --> L1["Local 1"]',
			'  Root --> L2["Local 2"]',
			'  Root --> G1["GPU-A 1"]',
			'  Root --> G2["GPU-A 2"]',
			'  Root --> B1["GPU-B 1"]',
			'  Root --> G3["GPU-A 3"]',
		].join('\n'));
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 1,
			supervisors: [{ id: 'sup-l1', tier: 1, managedNodeIds: ['Root'] }],
			nodeAssignments: {
				Root: { tier: 2, agentId: 'a-root', provider: 'anthropic' },
				L1: { tier: 3, agentId: 'a-l1', provider: 'anthropic' },
				L2: { tier: 3, agentId: 'a-l2', provider: 'anthropic' },
				G1: { tier: 3, agentId: 'a-g1', hostAlias: 'gpu-a', provider: 'openai' },
				G2: { tier: 3, agentId: 'a-g2', hostAlias: 'gpu-a', provider: 'openai' },
				B1: { tier: 3, agentId: 'a-b1', hostAlias: 'gpu-b', provider: 'google' },
				G3: { tier: 3, agentId: 'a-g3', hostAlias: 'gpu-a', provider: 'anthropic' },
			},
		};
		let state = createState(graph, boundary);
		const started = startMissionRun(state, graph, ORG, {
			now: 1_000,
			concurrencyLimits: {
				maxGlobal: 4,
				maxLocalHost: 1,
				maxPerCloudHost: 1,
				maxPerProvider: 2,
			},
		});
		assert.strictEqual(started.ok, true);
		state = started.state;
		const rootTok = activeTokenOn(state, 'Root')!;
		assert.ok(rootTok);

		// Completing Root fans out to 6 branches simultaneously:
		// - L1 (local, anthropic): admitted (local 1/1, anthropic 1/2, global 1/4)
		// - L2 (local, anthropic): queued (#1) due to local_host 1/1
		// - G1 (gpu-a, openai): admitted (gpu-a 1/1, openai 1/2, global 2/4)
		// - G2 (gpu-a, openai): queued (#2) due to cloud_host gpu-a 1/1
		// - B1 (gpu-b, google): admitted work-conservingly! (gpu-b 1/1, google 1/2, global 3/4)
		// - G3 (gpu-a, anthropic): queued (#3) due to cloud_host gpu-a 1/1
		const fanned = completeMissionToken(state, graph, { tokenId: rootTok.id, summary: 'Fan-out ready', now: 2_000 });
		assert.strictEqual(fanned.ok, true);
		state = fanned.state;

		const dispatchedNodes = fanned.effects
			.filter((e): e is Extract<typeof e, { kind: 'dispatch_token' }> => e.kind === 'dispatch_token')
			.map(e => e.nodeId);
		assert.deepStrictEqual(dispatchedNodes, ['L1', 'G1', 'B1'], 'Only admitted branches may emit dispatch_token effects');
		assert.strictEqual(state.nodeStates.L1, 'active');
		assert.strictEqual(state.nodeStates.G1, 'active');
		assert.strictEqual(state.nodeStates.B1, 'active');
		assert.strictEqual(state.nodeStates.L2, 'queued');
		assert.strictEqual(state.nodeStates.G2, 'queued');
		assert.strictEqual(state.nodeStates.G3, 'queued');

		const queuedToks = Object.values(state.tokens).filter(t => t.status === 'queued').sort((a, b) => (a.queued?.position ?? 0) - (b.queued?.position ?? 0));
		assert.deepStrictEqual(queuedToks.map(t => [t.nodeId, t.queued?.position, t.queued?.totalQueued, t.queued?.blockedBy]), [
			['L2', 1, 3, 'local_host'],
			['G2', 2, 3, 'cloud_host'],
			['G3', 3, 3, 'cloud_host'],
		]);

		// 3. Blocking G1 WITH watchPid keeps gpu-a host slot occupied (preventing GPU OOM!), so G2 stays queued!
		const g1Tok = activeTokenOn(state, 'G1')!;
		const blockedWithPid = blockMissionToken(state, {
			tokenId: g1Tok.id,
			reason: 'GPU training epoch 1/10',
			maxDurationMs: 600_000,
			watchPid: 42424,
			hostAlias: 'gpu-a',
			now: 3_000,
		});
		assert.strictEqual(blockedWithPid.ok, true);
		state = blockedWithPid.state;
		assert.strictEqual(blockedWithPid.effects.some(e => e.kind === 'dispatch_token'), false, 'watchPid block must keep host slot occupied');
		assert.strictEqual(state.nodeStates.G2, 'queued');

		// 4. Blocking G1 WITHOUT watchPid releases gpu-a slot and immediately promotes G2 (leaving L2=#1/2, G3=#2/2)
		const blockedNoPid = blockMissionToken(state, {
			tokenId: g1Tok.id,
			reason: 'Waiting for external artifact upload',
			maxDurationMs: 600_000,
			now: 4_000,
		});
		assert.strictEqual(blockedNoPid.ok, true);
		state = blockedNoPid.state;
		assert.deepStrictEqual(
			blockedNoPid.effects.filter(e => e.kind === 'dispatch_token').map(e => e.nodeId),
			['G2'],
			'Non-PID block frees cloud host slot and promotes queued G2',
		);
		assert.strictEqual(state.nodeStates.G2, 'active');
		const remainingAfterBlock = Object.values(state.tokens).filter(t => t.status === 'queued').sort((a, b) => (a.queued?.position ?? 0) - (b.queued?.position ?? 0));
		assert.deepStrictEqual(remainingAfterBlock.map(t => [t.nodeId, t.queued?.position, t.queued?.totalQueued]), [
			['L2', 1, 2],
			['G3', 2, 2],
		]);

		// 5. Completing L1 frees local_host and promotes L2 (G3 shifts to #1/1)
		const l1Tok = activeTokenOn(state, 'L1')!;
		const l1Done = completeMissionToken(state, graph, { tokenId: l1Tok.id, summary: 'L1 done', now: 5_000 });
		assert.strictEqual(l1Done.ok, true);
		state = l1Done.state;
		assert.deepStrictEqual(l1Done.effects.filter(e => e.kind === 'dispatch_token').map(e => e.nodeId), ['L2']);
		assert.strictEqual(state.nodeStates.L2, 'active');
		const g3Queued = Object.values(state.tokens).find(t => t.nodeId === 'G3' && t.status === 'queued')!;
		assert.strictEqual(g3Queued.queued?.position, 1);
		assert.strictEqual(g3Queued.queued?.totalQueued, 1);

		// 6. Raising concurrency limits dynamically via setMissionConcurrencyLimits immediately promotes G3
		const raised = setMissionConcurrencyLimits(state, {
			maxGlobal: 8,
			maxLocalHost: 4,
			maxPerCloudHost: 2,
			maxPerProvider: 4,
		}, 6_000);
		assert.strictEqual(raised.ok, true);
		state = raised.state;
		assert.deepStrictEqual(raised.data?.promotedTokenIds, [g3Queued.id]);
		assert.deepStrictEqual(raised.effects.filter(e => e.kind === 'dispatch_token').map(e => e.nodeId), ['G3']);
		assert.strictEqual(state.nodeStates.G3, 'active');

		// 7. Recalling a queued token emits zero stop_agent effects and shifts subsequent queue ranks cleanly
		let recallState = startMissionRun(createState(graph, boundary), graph, ORG, {
			now: 10_000,
			concurrencyLimits: { maxGlobal: 1, maxLocalHost: 1, maxPerCloudHost: 1, maxPerProvider: 1 },
		}).state;
		const rRoot = activeTokenOn(recallState, 'Root')!;
		recallState = completeMissionToken(recallState, graph, { tokenId: rRoot.id, summary: 'Fan out capped at 1', now: 11_000 }).state;
		assert.strictEqual(recallState.nodeStates.L1, 'active');
		assert.strictEqual(recallState.nodeStates.L2, 'queued');
		assert.strictEqual(recallState.nodeStates.G1, 'queued');
		const recQueued = recallMissionTokens(recallState, graph, {
			caller: { isHumanUser: true },
			nodeIds: ['L2'],
			reason: 'Drop redundant queued branch',
			now: 12_000,
		});
		assert.strictEqual(recQueued.ok, true);
		assert.strictEqual(recQueued.effects.some(e => e.kind === 'stop_agent'), false, 'Recalling a queued token must not emit stop_agent');
		const g1AfterRecall = Object.values(recQueued.state.tokens).find(t => t.nodeId === 'G1' && t.status === 'queued')!;
		assert.strictEqual(g1AfterRecall.queued?.position, 1, 'Remaining queued token must renumber to #1');
		assert.strictEqual(g1AfterRecall.queued?.totalQueued, 4);

		// 8. Deterministic check escalation frees active slot and immediately drains queued token (no stall)
		const l1ActiveForCheck = activeTokenOn(recallState, 'L1')!;
		const escRes = recordTokenCheckResult(recallState, graph, {
			tokenId: l1ActiveForCheck.id,
			suiteResult: {
				nodeId: 'L1',
				passed: false,
				summary: '1/1 failed: lint',
				totalDurationMs: 120,
				results: [{
					checkId: 'chk-lint',
					name: 'Lint',
					hostAlias: 'local',
					passed: false,
					exitCode: 1,
					expectedExitCode: 0,
					durationMs: 120,
					outputTail: 'lint failed',
				}],
			},
			onFail: 'escalate',
			maxAutoRetries: 1,
			now: 13_000,
		});
		assert.strictEqual(escRes.ok, false);
		assert.strictEqual(escRes.state.nodeStates.L1, 'failed');
		assert.strictEqual(escRes.state.nodeStates.L2, 'active', 'Check escalation must free concurrency slot and promote queued L2');
		assert.deepStrictEqual(
			escRes.effects.filter(e => e.kind === 'dispatch_token').map(e => e.nodeId),
			['L2'],
		);

		// 9. Distilling a node while Mission is paused defers its re-dispatch until resumeMissionRun
		const paused = pauseMissionRun(escRes.state, 14_000);
		assert.strictEqual(paused.ok, true);
		const distilledPaused = distillMissionNodeContext(paused.state, graph, 'L2', { memo: 'Focus on parser', now: 15_000 });
		assert.strictEqual(distilledPaused.ok, true);
		assert.strictEqual(distilledPaused.effects.some(e => e.kind === 'dispatch_token'), false);
		const resumed = resumeMissionRun(distilledPaused.state, 16_000);
		assert.strictEqual(resumed.ok, true);
		assert.ok(
			resumed.effects.some(e => e.kind === 'dispatch_token' && e.nodeId === 'L2'),
			'Resuming after paused distill must replay deferred dispatch_token for L2',
		);
	});

	test('startMissionRun archives previous run ledgers (cost, duration, tokens, per-node metrics) for multi-run comparison, and AdeDocsBackendNodeService persists independent cold Mission files (Audit #18)', async () => {
		const graph = parseGraph([
			'flowchart LR',
			'  A["Plan"] --> B["Build"]',
		].join('\n'));
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 1,
			supervisors: [{ id: 'sup-l1', tier: 1, managedNodeIds: ['A'] }],
			nodeAssignments: {
				A: { tier: 2, agentId: 'a-plan', hostAlias: 'local', provider: 'anthropic' },
				B: { tier: 3, agentId: 'a-build', hostAlias: 'gpu-1', provider: 'openai' },
			},
		};

		// Run #1: expensive & slower ($1.00, 40s, 100k tokens)
		let state = startMissionRun(createState(graph, boundary), graph, ORG, { now: 10_000 }).state;
		assert.strictEqual(state.runSeq, 1);
		assert.strictEqual(state.runHistory, undefined);
		state = recordMissionNodeTurnUsage(state, 'A', { inputTokens: 20_000, outputTokens: 10_000, totalTokens: 30_000, costUsd: 0.40, turns: 2, model: 'claude-opus-4-6', engineId: 'claude', timestamp: 25_000 });
		const tokA1 = activeTokenOn(state, 'A')!;
		state = completeMissionToken(state, graph, { tokenId: tokA1.id, summary: 'Plan v1 done', now: 25_000 }).state;
		state = recordMissionNodeTurnUsage(state, 'B', { inputTokens: 50_000, outputTokens: 20_000, cacheReadTokens: 10_000, totalTokens: 70_000, costUsd: 0.60, turns: 3, model: 'gpt-5.3-codex', engineId: 'codex', timestamp: 50_000 });
		const tokB1 = activeTokenOn(state, 'B')!;
		state = completeMissionToken(state, graph, { tokenId: tokB1.id, summary: 'Build v1 done', now: 50_000 }).state;
		assert.strictEqual(state.status, 'completed');
		assert.strictEqual(state.completedAt, 50_000);

		// Run #2: re-run archives Run #1 cleanly BEFORE clearing nodeTelemetry!
		state = startMissionRun(state, graph, ORG, { now: 100_000 }).state;
		assert.strictEqual(state.runSeq, 2);
		assert.strictEqual(state.runHistory?.length, 1, 'Previous run ledger must be archived on re-run');
		const run1 = state.runHistory![0];
		assert.strictEqual(run1.runNumber, 1);
		assert.strictEqual(run1.outcome, 'completed');
		assert.strictEqual(run1.totalCostUsd, 1.0);
		assert.strictEqual(run1.totalTokens, 100_000);
		assert.strictEqual(run1.durationMs, 40_000);
		assert.strictEqual(run1.completedNodeCount, 2);
		assert.strictEqual(run1.nodeMetrics.length, 2);
		assert.strictEqual(Object.keys(state.nodeTelemetry ?? {}).length, 0, 'Fresh run starts with clean live nodeTelemetry');

		// Run #2 finishes cheaper & faster ($0.40, 20s, 50k tokens)
		state = recordMissionNodeTurnUsage(state, 'A', { inputTokens: 10_000, outputTokens: 5_000, totalTokens: 15_000, costUsd: 0.15, turns: 1, model: 'claude-sonnet-4-6', engineId: 'claude', timestamp: 108_000 });
		const tokA2 = activeTokenOn(state, 'A')!;
		state = completeMissionToken(state, graph, { tokenId: tokA2.id, summary: 'Plan v2 fast', now: 108_000 }).state;
		state = recordMissionNodeTurnUsage(state, 'B', { inputTokens: 25_000, outputTokens: 10_000, cacheReadTokens: 15_000, totalTokens: 35_000, costUsd: 0.25, turns: 1, model: 'gpt-5.3-codex', engineId: 'codex', timestamp: 120_000 });
		const tokB2 = activeTokenOn(state, 'B')!;
		state = completeMissionToken(state, graph, { tokenId: tokB2.id, summary: 'Build v2 fast', now: 120_000 }).state;

		const liveRun2 = buildMissionRunArchiveSnapshot(state, graph.nodes, { runNumber: 2, now: 120_000 });
		const cmp = compareMissionRuns(liveRun2, run1);
		assert.strictEqual(cmp.currentRunNumber, 2);
		assert.strictEqual(cmp.baselineRunNumber, 1);
		assert.strictEqual(cmp.costDeltaUsd, -0.6);
		assert.strictEqual(cmp.costDeltaPct, -60);
		assert.strictEqual(cmp.durationDeltaMs, -20_000);
		assert.strictEqual(cmp.durationDeltaPct, -50);
		assert.strictEqual(cmp.tokensDelta, -50_000);
		assert.strictEqual(cmp.tokensDeltaPct, -50);
		assert.strictEqual(cmp.nodeDeltas.length, 2);

		// Run #3 stopped mid-flight still records completedAt and archives accurately on Run #4
		state = startMissionRun(state, graph, ORG, { now: 200_000 }).state;
		assert.strictEqual(state.runHistory?.length, 2);
		state = recordMissionNodeTurnUsage(state, 'A', { inputTokens: 5_000, outputTokens: 2_000, totalTokens: 7_000, costUsd: 0.08, turns: 1, timestamp: 205_000 });
		state = stopMissionRun(state, 207_000).state;
		assert.strictEqual(state.completedAt, 207_000);
		state = startMissionRun(state, graph, ORG, { now: 250_000 }).state;
		assert.strictEqual(state.runHistory?.length, 3);
		assert.strictEqual(state.runHistory![2].outcome, 'stopped');
		assert.strictEqual(state.runHistory![2].durationMs, 7_000);
		assert.strictEqual(state.runHistory![2].totalCostUsd, 0.08);

		// Bounded history never exceeds MAX_MISSION_RUN_HISTORY (20)
		let capState = state;
		let ts = 300_000;
		for (let i = 0; i < MAX_MISSION_RUN_HISTORY + 5; i++) {
			capState = stopMissionRun(capState, ts + 500).state;
			capState = startMissionRun(capState, graph, ORG, { now: ts + 1_000 }).state;
			ts += 2_000;
		}
		assert.strictEqual(capState.runHistory?.length, MAX_MISSION_RUN_HISTORY);
		assert.ok(capState.runHistory![capState.runHistory!.length - 1].runNumber > MAX_MISSION_RUN_HISTORY);

		// Cold per-Mission file persistence in AdeDocsBackendNodeService + compact storage fingerprint
		assert.notStrictEqual(computeAdeStorageFingerprint('payload-a'), computeAdeStorageFingerprint('payload-b'));
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-cold-missions-'));
		const backend = new AdeDocsBackendNodeService({ baseDir: tmpHome });
		try {
			const events: Array<{ missionId: string; deleted?: boolean; writerId?: string }> = [];
			const sub = backend.onDidMissionRecordChange(ev => events.push({ missionId: ev.missionId, deleted: ev.deleted, writerId: ev.writerId }));
			try {
				await backend.saveMissionRecord('mission/alpha', JSON.stringify({ id: 'mission/alpha', title: 'Alpha', mermaidText: 'flowchart LR\n  A-->B' }), 1_000, 'win-1');
				await backend.saveMissionRecord('mission/beta', JSON.stringify({ id: 'mission/beta', title: 'Beta', mermaidText: 'flowchart LR\n  X-->Y' }), 2_000, 'win-1');

				const fileAlpha = path.join(tmpHome, 'missions', encodeAdeMissionStorageFileName('mission/alpha'));
				const fileBeta = path.join(tmpHome, 'missions', encodeAdeMissionStorageFileName('mission/beta'));
				assert.ok(fs.existsSync(fileAlpha), 'Mission Alpha written to its own isolated cold file');
				assert.ok(fs.existsSync(fileBeta), 'Mission Beta written to its own isolated cold file');
				assert.notStrictEqual(fileAlpha, fileBeta);

				const loadedAll = await backend.loadAllMissionRecords();
				assert.deepStrictEqual(Object.keys(loadedAll).sort(), ['mission/alpha', 'mission/beta']);
				const loadedAlpha = JSON.parse((await backend.loadMissionRecord('mission/alpha'))!);
				assert.strictEqual(loadedAlpha.title, 'Alpha');

				await backend.deleteMissionRecord('mission/alpha', 'win-2');
				assert.strictEqual(fs.existsSync(fileAlpha), false);
				assert.strictEqual(fs.existsSync(fileBeta), true, 'Deleting Alpha leaves Beta untouched');
				assert.strictEqual(events.length, 3);
				assert.strictEqual(events[2].missionId, 'mission/alpha');
				assert.strictEqual(events[2].deleted, true);
				assert.strictEqual(events[2].writerId, 'win-2');
			} finally {
				sub.dispose();
			}
		} finally {
			backend.dispose();
			fs.rmSync(tmpHome, { recursive: true, force: true });
		}
	});

	test('resolves true per-model context windows across vendors & overrides and auto-marks production rework & tool-error turns into contextNoiseTokens (Audit #24)', () => {
		// 1. Unified per-model context window catalog + explicit suffix tags + local fallback + user overrides
		assert.strictEqual(inferModelContextWindowTokens('deepseek-r1'), 64_000);
		assert.strictEqual(inferModelContextWindowTokens('deepseek-chat'), 64_000);
		assert.strictEqual(inferModelContextWindowTokens('deepseek-v3.2'), 128_000);
		assert.strictEqual(inferModelContextWindowTokens('gpt-4o'), 128_000);
		assert.strictEqual(inferModelContextWindowTokens('claude-opus-4-6'), 200_000);
		assert.strictEqual(inferModelContextWindowTokens('qwen3-coder'), 256_000);
		assert.strictEqual(inferModelContextWindowTokens('gpt-5.3-codex'), 400_000);
		assert.strictEqual(inferModelContextWindowTokens('gemini-2.5-pro'), 1_000_000);
		assert.strictEqual(inferModelContextWindowTokens('gpt-4.1'), 1_000_000);
		assert.strictEqual(inferModelContextWindowTokens('claude-sonnet-4-6[1m]'), 1_000_000);
		assert.strictEqual(inferModelContextWindowTokens('claude-fable-5-2'), 1_000_000);
		assert.strictEqual(inferModelContextWindowTokens('claude-opus-5-5'), 1_000_000);
		assert.strictEqual(inferModelContextWindowTokens('gpt-6.2-astra'), 1_000_000);
		assert.strictEqual(inferModelContextWindowTokens('deepseek-v4-pro'), 1_000_000);
		assert.strictEqual(inferModelContextWindowTokens('gemini-4-argon'), 1_000_000);
		assert.strictEqual(inferModelContextWindowTokens('qwen4-max'), 1_000_000);
		assert.strictEqual(inferModelContextWindowTokens('kimi-k3.1-pro'), 1_000_000);
		assert.strictEqual(inferModelContextWindowTokens('grok-4.5'), 1_000_000);
		assert.strictEqual(inferModelContextWindowTokens('glm-5'), 500_000);
		assert.strictEqual(parseExplicitModelContextWindowTag('custom-coder-32k'), 32_000);
		assert.strictEqual(inferModelContextWindowTokens('custom-coder-32k'), 32_000);
		assert.strictEqual(inferModelContextWindowTokens('ollama/my-custom-7b'), 32_768);
		assert.strictEqual(inferModelContextWindowTokens('ollama/deepseek-r1'), 64_000);
		assert.strictEqual(resolveModelContextWindowTokens(undefined, 'aexus-antigravity'), 1_000_000);
		assert.strictEqual(resolveModelContextWindowTokens(undefined, 'aexus-dsh'), 64_000);
		assert.strictEqual(
			inferModelContextWindowTokens('deepseek-r1', {
				overrides: {
					'deepseek-r1': { contextWindowTokens: 48_000 },
				},
			}),
			48_000,
			'User contextWindowTokens override must take precedence over built-in catalog',
		);
		assert.strictEqual(
			inferModelContextWindowTokens('claude-sonnet-4-6[1m]', {
				overrides: {
					'claude-sonnet-4-6': { contextWindowTokens: 300_000 },
				},
			}),
			300_000,
			'User override on base model ID must win over [1m] suffix tag',
		);
		assert.strictEqual(
			inferModelContextWindowTokens('claude-sonnet-4-6:thinking', {
				overrides: {
					'claude-sonnet-4-6': { contextWindowTokens: 300_000 },
				},
			}),
			300_000,
			'User override on base model ID must win over :thinking suffix',
		);

		// 2. 64k model hitting 58k tokens triggers critical >=90% severity (NOT masked at 29% by hardcoded 200k!)
		const graph = parseGraph([
			'flowchart LR',
			'  N1["@Dev: Build"] --> R1["@Rev: Audit"]',
			'  R1 --> G1{"Gate: Release"}',
			'  G1 --> N2["@Ops: Deploy"]',
		].join('\n'));
		const baseBoundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 1,
			supervisors: [{ id: 'gov-1', tier: 1, managedNodeIds: ['N1', 'R1', 'G1', 'N2'] }],
			nodeAssignments: {
				N1: { agentId: 'dev-1', tier: 2, roleKind: 'worker' },
				R1: { agentId: 'rev-1', tier: 2, roleKind: 'reviewer' },
				G1: { tier: 2, roleKind: 'worker' },
				N2: { agentId: 'ops-1', tier: 2, roleKind: 'worker' },
			},
		};
		let state = createState(graph, baseBoundary);
		const started = startMissionRun(state, graph, ORG, { now: 1_000 });
		assert.strictEqual(started.ok, true);
		state = started.state;

		// Turn 1: clean work on 64k deepseek-r1 -> goes to contextSourceTokens, ZERO noise
		state = recordMissionNodeTurnUsage(state, 'N1', {
			inputTokens: 50_000,
			outputTokens: 8_000,
			model: 'deepseek-r1',
			engineId: 'aexus-dsh',
			timestamp: 2_000,
		});
		const n1Tel1 = state.nodeTelemetry!.N1;
		assert.strictEqual(n1Tel1.contextWindowMax, 64_000);
		assert.strictEqual(n1Tel1.contextNoiseTokens, 0);
		assert.strictEqual(n1Tel1.contextSourceTokens, 58_000);
		const bd1 = computeMissionNodeContextBreakdown(n1Tel1);
		assert.strictEqual(bd1.maxTokens, 64_000);
		assert.strictEqual(bd1.usedPct, 91);
		assert.strictEqual(bd1.severity, 'critical');

		// Switching model on same node dynamically updates contextWindowMax (64k -> 200k),
		// and adding/removing user overrides updates contextWindowMax immediately even on unchanged model!
		state = recordMissionNodeTurnUsage(state, 'N1', {
			inputTokens: 2_000,
			outputTokens: 500,
			model: 'claude-sonnet-4-6',
			engineId: 'aexus-claude',
			timestamp: 2_500,
		}, {
			overrides: { 'claude-sonnet-4-6': { contextWindowTokens: 500_000 } },
		});
		assert.strictEqual(state.nodeTelemetry!.N1.contextWindowMax, 500_000);
		state = recordMissionNodeTurnUsage(state, 'N1', {
			inputTokens: 500,
			outputTokens: 200,
			model: 'claude-sonnet-4-6',
			engineId: 'aexus-claude',
			timestamp: 2_600,
		});
		assert.strictEqual(state.nodeTelemetry!.N1.contextWindowMax, 200_000, 'Removing user override reverts contextWindowMax back to catalog 200k');

		// 3. Tool-error turn (WITHOUT passing isNoiseTurn!) automatically routes into contextNoiseTokens,
		//    and does NOT leak onto the next clean turn.
		state = recordMissionNodeTurnUsage(state, 'N1', {
			inputTokens: 8_000,
			outputTokens: 2_000,
			hadToolError: true,
			toolErrorCount: 2,
			model: 'claude-sonnet-4-6',
			engineId: 'aexus-claude',
			timestamp: 3_000,
		});
		assert.strictEqual(state.nodeTelemetry!.N1.contextNoiseTokens, 10_000);
		assert.strictEqual(state.nodeTelemetry!.N1.noiseTurns, 1);
		assert.strictEqual(state.nodeTelemetry!.N1.pendingNoiseReason, undefined, 'One-shot tool_error clears after failing turn completes');

		const sourceBeforeClean = state.nodeTelemetry!.N1.contextSourceTokens;
		state = recordMissionNodeTurnUsage(state, 'N1', {
			inputTokens: 3_000,
			outputTokens: 1_000,
			model: 'claude-sonnet-4-6',
			engineId: 'aexus-claude',
			timestamp: 3_500,
		});
		assert.strictEqual(state.nodeTelemetry!.N1.contextNoiseTokens, 10_000, 'Next clean turn does NOT leak into noise');
		assert.strictEqual(state.nodeTelemetry!.N1.contextSourceTokens, sourceBeforeClean + 4_000);

		// 4. Deterministic check failure bounce automatically marks token & node telemetry as rework noise
		const n1TokId = Object.values(state.tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!.id;
		const noiseBeforeBounce = state.nodeTelemetry!.N1.contextNoiseTokens;
		const bounced = recordTokenCheckResult(state, graph, {
			tokenId: n1TokId,
			suiteResult: {
				nodeId: 'N1',
				passed: false,
				summary: 'FAIL unit-tests: TypeError cannot read property id of undefined',
				totalDurationMs: 120,
				results: [{
					checkId: 'chk-1',
					name: 'unit-tests',
					command: 'pnpm test',
					hostAlias: 'local',
					passed: false,
					exitCode: 1,
					expectedExitCode: 0,
					durationMs: 120,
					outputTail: 'TypeError cannot read property id of undefined',
				}],
			},
			onFail: 'bounce',
			maxAutoRetries: 2,
			now: 4_000,
		});
		assert.strictEqual(bounced.ok, false);
		assert.strictEqual(bounced.data?.action, 'bounced');
		state = bounced.state;
		assert.strictEqual(state.tokens[n1TokId].isRework, true);
		assert.strictEqual(state.tokens[n1TokId].reworkReason, 'check_failed');
		assert.ok(state.nodeTelemetry!.N1.contextNoiseTokens > noiseBeforeBounce, 'Check bounce adds failure diagnostic tokens to noise');

		const noiseAfterBounce = state.nodeTelemetry!.N1.contextNoiseTokens;
		state = recordMissionNodeTurnUsage(state, 'N1', {
			inputTokens: 6_000,
			outputTokens: 2_000,
			model: 'claude-sonnet-4-6',
			engineId: 'aexus-claude',
			timestamp: 4_500,
		});
		assert.strictEqual(state.nodeTelemetry!.N1.contextNoiseTokens, noiseAfterBounce + 8_000, 'Rework turn after check bounce routes automatically into noise');

		// Passing the deterministic check clears check_failed rework state so subsequent clean turns go back to source
		const passedCheck = recordTokenCheckResult(state, graph, {
			tokenId: n1TokId,
			suiteResult: {
				nodeId: 'N1',
				passed: true,
				summary: 'PASS unit-tests',
				totalDurationMs: 90,
				results: [{
					checkId: 'chk-1',
					name: 'unit-tests',
					command: 'pnpm test',
					hostAlias: 'local',
					passed: true,
					exitCode: 0,
					expectedExitCode: 0,
					durationMs: 90,
					outputTail: '12 passing',
				}],
			},
			now: 4_700,
		});
		assert.strictEqual(passedCheck.ok, true);
		state = passedCheck.state;
		assert.strictEqual(state.tokens[n1TokId].isRework, undefined);
		assert.strictEqual(state.tokens[n1TokId].checkFailureCount, 0);
		assert.strictEqual(state.nodeTelemetry!.N1.pendingNoiseReason, undefined);
		const noiseAfterCheckPass = state.nodeTelemetry!.N1.contextNoiseTokens;
		const srcAfterCheckPass = state.nodeTelemetry!.N1.contextSourceTokens;
		state = recordMissionNodeTurnUsage(state, 'N1', {
			inputTokens: 1_000,
			outputTokens: 200,
			model: 'claude-sonnet-4-6',
			engineId: 'aexus-claude',
			timestamp: 4_800,
		});
		assert.strictEqual(state.nodeTelemetry!.N1.contextNoiseTokens, noiseAfterCheckPass, 'Clean turn after check passes must NOT accrue noise');
		assert.strictEqual(state.nodeTelemetry!.N1.contextSourceTokens, srcAfterCheckPass + 1_200);

		// 5. Complete N1 -> R1 Reviewer rejects back to N1 -> automatically marks reviewer_rejected rework noise
		const comp1 = completeMissionToken(state, graph, { tokenId: n1TokId, summary: 'Fixed unit tests', now: 5_000 });
		assert.strictEqual(comp1.ok, true);
		state = comp1.state;
		assert.strictEqual(state.nodeTelemetry!.N1.pendingNoiseReason, undefined);

		const r1TokId = Object.values(state.tokens).find(t => t.nodeId === 'R1' && t.status === 'active')!.id;
		const rejRes = rejectMissionToken(state, graph, {
			tokenId: r1TokId,
			reason: 'Missing input sanitization on webhook handler',
			callerAgentId: 'rev-1',
			now: 5_500,
		});
		assert.strictEqual(rejRes.ok, true);
		state = rejRes.state;
		const n1ReworkTok = Object.values(state.tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
		assert.strictEqual(n1ReworkTok.isRework, true);
		assert.strictEqual(n1ReworkTok.reworkReason, 'reviewer_rejected');
		const noiseBeforeRevTurn = state.nodeTelemetry!.N1.contextNoiseTokens;
		state = recordMissionNodeTurnUsage(state, 'N1', {
			inputTokens: 5_000,
			outputTokens: 1_500,
			model: 'claude-sonnet-4-6',
			engineId: 'aexus-claude',
			timestamp: 6_000,
		});
		assert.strictEqual(state.nodeTelemetry!.N1.contextNoiseTokens, noiseBeforeRevTurn + 6_500, 'Turn after Reviewer rejection routes automatically into noise');

		// 6. Complete N1 -> R1 -> G1 Gate rejects back to N1 -> automatically marks gate_rejected rework noise
		const comp2 = completeMissionToken(state, graph, { tokenId: n1ReworkTok.id, summary: 'Added webhook sanitization', now: 6_500 });
		state = comp2.state;
		const r1Tok2 = Object.values(state.tokens).find(t => t.nodeId === 'R1' && t.status === 'active')!;
		const compR1 = completeMissionToken(state, graph, { tokenId: r1Tok2.id, summary: 'LGTM', now: 7_000 });
		state = compR1.state;
		const gateRej = resolveMissionGate(state, graph, {
			nodeId: 'G1',
			decision: 'reject',
			rollbackNodeId: 'N1',
			note: 'Rollback for security header check',
			now: 7_500,
		});
		assert.strictEqual(gateRej.ok, true);
		state = gateRej.state;
		const n1GateReworkTok = Object.values(state.tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
		assert.strictEqual(n1GateReworkTok.isRework, true);
		assert.strictEqual(n1GateReworkTok.reworkReason, 'gate_rejected');

		// 7. Watchdog silence_timeout wakeup marks watchdog_nudge rework noise
		const noiseBeforeWd = state.nodeTelemetry!.N1.contextNoiseTokens;
		const wdRes = recordWatchdogWakeup(state, {
			tokenId: n1GateReworkTok.id,
			reason: 'silence_timeout',
			now: 8_000,
		});
		assert.strictEqual(wdRes.ok, true);
		state = wdRes.state;
		assert.strictEqual(state.tokens[n1GateReworkTok.id].nudgeCount, 1);
		assert.strictEqual(state.nodeTelemetry!.N1.pendingNoiseReason, 'watchdog_nudge');
		assert.ok(state.nodeTelemetry!.N1.contextNoiseTokens > noiseBeforeWd);

		// 8. 4-color segment breakdown never exceeds 100% total even if model switches down to a smaller window
		const bdOverflow = computeMissionNodeContextBreakdown({
			...state.nodeTelemetry!.N1,
			contextWindowMax: 32_000,
		});
		assert.ok(bdOverflow.noisePct > 0, 'Noise segment remains visible on overflow');
		assert.ok(bdOverflow.initPct + bdOverflow.tierPct + bdOverflow.sourcePct + bdOverflow.noisePct <= 100.01, '4-segment sum must never overflow 100%');

		// 9. Distill & Refresh clears contextNoiseTokens, pendingNoiseReason, and isRework
		const distilled = distillMissionNodeContext(state, graph, 'N1', { memo: 'Keep sanitized handler', now: 9_000 });
		assert.strictEqual(distilled.ok, true);
		state = distilled.state;
		assert.strictEqual(state.nodeTelemetry!.N1.contextNoiseTokens, 0);
		assert.strictEqual(state.nodeTelemetry!.N1.pendingNoiseReason, undefined);
		assert.strictEqual(state.tokens[n1GateReworkTok.id].isRework, undefined);

		const sourceAfterDistill = state.nodeTelemetry!.N1.contextSourceTokens;
		state = recordMissionNodeTurnUsage(state, 'N1', {
			inputTokens: 4_000,
			outputTokens: 1_000,
			model: 'claude-sonnet-4-6',
			engineId: 'aexus-claude',
			timestamp: 9_500,
		});
		assert.strictEqual(state.nodeTelemetry!.N1.contextNoiseTokens, 0, 'Clean turn after distill stays noise-free');
		assert.strictEqual(state.nodeTelemetry!.N1.contextSourceTokens, sourceAfterDistill + 5_000);
	});

	test('enforces per-employee exclusive session locking on parallel @Employee branches and during blocked waits without starving other employees (Audit #19)', () => {
		const graph = parseGraph([
			'flowchart LR',
			'  S["@Lead: Kickoff"] --> P1["@Alice: API"]',
			'  S --> P2["@Alice: Docs"]',
			'  S --> P3["@Bob: UI"]',
			'  P1 --> J["@Lead: Merge"]',
			'  P2 --> J',
			'  P3 --> J',
		].join('\n'));
		const boundary: IMissionBoundaryConfig = {
			offGraphMaxTier: 1,
			supervisors: [{ id: 'gov-1', tier: 1, managedNodeIds: ['S', 'P1', 'P2', 'P3', 'J'] }],
			nodeAssignments: {
				S: { agentId: 'emp-lead', tier: 2, roleKind: 'worker' },
				P1: { agentId: 'emp-alice', tier: 2, roleKind: 'worker' },
				P2: { agentId: 'emp-alice', tier: 2, roleKind: 'worker' },
				P3: { agentId: 'emp-bob', tier: 2, roleKind: 'worker' },
				J: { agentId: 'emp-lead', tier: 2, roleKind: 'worker' },
			},
		};
		let state = createState(graph, boundary);
		const started = startMissionRun(state, graph, ORG, {
			concurrencyLimits: { maxGlobal: 2, maxLocalHost: 4, maxPerCloudHost: 4, maxPerProvider: 4 },
			now: 1_000,
		});
		assert.strictEqual(started.ok, true);
		state = started.state;

		const sTok = Object.values(state.tokens).find(t => t.nodeId === 'S' && t.status === 'active')!;
		const compS = completeMissionToken(state, graph, { tokenId: sTok.id, summary: 'Fork ready', now: 2_000 });
		assert.strictEqual(compS.ok, true);
		state = compS.state;

		// P1 (@Alice) is active, P2 (@Alice) MUST be queued exclusively with blockedBy='employee',
		// and P3 (@Bob) is active (not blocked by @Alice's employee lock!).
		const p1Tok = Object.values(state.tokens).find(t => t.nodeId === 'P1')!;
		const p2Tok = Object.values(state.tokens).find(t => t.nodeId === 'P2')!;
		const p3Tok = Object.values(state.tokens).find(t => t.nodeId === 'P3')!;
		assert.strictEqual(p1Tok.status, 'active');
		assert.strictEqual(p3Tok.status, 'active');
		assert.strictEqual(p2Tok.status, 'queued', 'Second parallel node for @Alice must queue exclusively');
		assert.strictEqual(p2Tok.queued?.blockedBy, 'employee');
		assert.strictEqual(p2Tok.queued?.scopeKey, 'emp-alice');
		assert.strictEqual(p2Tok.queued?.activeSlots, 1);
		assert.strictEqual(p2Tok.queued?.maxSlots, 1);
		assert.strictEqual(state.nodeStates.P2, 'queued');

		// Raise global limit to unlimited (0) -> P2 STILL remains exclusively queued because @Alice owns P1!
		const unlimited = setMissionConcurrencyLimits(state, { maxGlobal: 0, maxLocalHost: 0, maxPerCloudHost: 0, maxPerProvider: 0 }, 2_200);
		state = unlimited.state;
		assert.strictEqual(state.tokens[p2Tok.id].status, 'queued', 'Unlimited global caps never override per-employee exclusivity');
		assert.strictEqual(state.tokens[p2Tok.id].queued?.blockedBy, 'employee');

		// Block P1 (long-running file wait without watchPid) -> P2 MUST STAY queued so @Alice's blocked session is never contaminated!
		const blockedP1 = blockMissionToken(state, {
			tokenId: p1Tok.id,
			reason: 'Waiting for migration snapshot file',
			maxDurationMs: 600_000,
			watchFile: '/tmp/migration.done',
			now: 3_000,
		});
		assert.strictEqual(blockedP1.ok, true);
		state = blockedP1.state;
		assert.strictEqual(state.tokens[p1Tok.id].status, 'blocked');
		assert.strictEqual(state.tokens[p2Tok.id].status, 'queued', 'Blocked token on @Alice keeps sibling P2 queued to prevent session pollution');
		assert.strictEqual(state.tokens[p2Tok.id].queued?.blockedBy, 'employee');

		// Watchdog wakes P1 (file_ready) -> P1 MUST NOT self-block against its own employee slot!
		const wokeP1 = recordWatchdogWakeup(state, {
			tokenId: p1Tok.id,
			reason: 'file_ready',
			detail: '/tmp/migration.done',
			now: 4_000,
		});
		assert.strictEqual(wokeP1.ok, true);
		state = wokeP1.state;
		assert.strictEqual(state.tokens[p1Tok.id].status, 'active', 'Waking blocked token must not self-conflict with its own employee lock');
		assert.strictEqual(state.tokens[p2Tok.id].status, 'queued');

		// Completing P1 frees @Alice -> P2 automatically promotes from queued -> active with dispatch effect!
		const compP1 = completeMissionToken(state, graph, { tokenId: p1Tok.id, summary: 'API shipped', now: 5_000 });
		assert.strictEqual(compP1.ok, true);
		state = compP1.state;
		assert.strictEqual(state.tokens[p2Tok.id].status, 'active', 'Completing P1 automatically promotes @Alice queued sibling P2');
		assert.ok(compP1.effects.some(e => e.kind === 'dispatch_token' && e.tokenId === p2Tok.id && e.nodeId === 'P2'));

		// Completing P2 and P3 releases the 3-way Join barrier cleanly with zero deadlock
		state = completeMissionToken(state, graph, { tokenId: p2Tok.id, summary: 'Docs written', now: 6_000 }).state;
		state = completeMissionToken(state, graph, { tokenId: p3Tok.id, summary: 'UI ready', now: 6_500 }).state;
		const jTok = Object.values(state.tokens).find(t => t.nodeId === 'J' && t.status === 'active');
		assert.ok(jTok, 'Join barrier fires cleanly after serialized @Alice branches + parallel @Bob branch all complete');

		// Mid-run reassignment consistency: when active P1 is reassigned from @Alice to @Dave via boundary update,
		// queued sibling P2 (still @Alice) immediately promotes using live nodeAssignments rather than stale holderAgentId!
		let state2 = startMissionRun(createState(graph, boundary), graph, ORG, { now: 10_000 }).state;
		const s2 = Object.values(state2.tokens).find(t => t.nodeId === 'S' && t.status === 'active')!;
		state2 = completeMissionToken(state2, graph, { tokenId: s2.id, summary: 'Fork 2', now: 11_000 }).state;
		const p2Queued2 = Object.values(state2.tokens).find(t => t.nodeId === 'P2')!;
		assert.strictEqual(p2Queued2.status, 'queued');
		const reassignedState: IMissionRuntimeState = {
			...state2,
			boundary: {
				...state2.boundary,
				nodeAssignments: {
					...state2.boundary.nodeAssignments,
					P1: { ...state2.boundary.nodeAssignments.P1, agentId: 'emp-dave' },
				},
			},
		};
		const drainedAfterReassign = setMissionConcurrencyLimits(reassignedState, reassignedState.concurrencyLimits, 11_500);
		assert.strictEqual(drainedAfterReassign.state.tokens[p2Queued2.id].status, 'active', 'Reassigning P1 away from @Alice frees @Alice and promotes queued P2');
	});
});
