/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { parseMissionMermaidDag, upsertTaskMetadataInMermaid } from '../../common/adeMissionDag.js';
import { normalizeAdeNodeColor, resolveAdeNodeColorHex } from '../../common/adeNodeColors.js';
import {
	abortOrchestrationTokens,
	blockOrchestrationToken,
	buildOrchestrationTokenDeltaView,
	canCallerAccessWhiteboard,
	canCallerCompleteMissionTask,
	compactOrchestrationRuntimeState,
	completeOrchestrationToken,
	composeOrchestrationTokenWakeupPrompt,
	createInitialOrchestrationRuntimeState,
	dispatchRequirementToOrchestration,
	failOrchestrationToken,
	findHighestRankStaffNode,
	getOrchestrationTokenHistory,
	handoffOrchestrationToken,
	isLightweightOrchestrationToken,
	mintOrchestrationTokens,
	mutateDepartmentWhiteboard,
	ORCHESTRATION_SILENCE_REMINDER_MINUTES,
	ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS,
	pauseOrchestration,
	planDynamicSubordinateCreation,
	planDynamicSubordinateRemoval,
	planDynamicWhiteboardCreation,
	pruneRemovedWhiteboardFromState,
	readOrchestrationTokenPointers,
	reclaimOrchestrationTokensForRemovedNode,
	recordOrchestrationSilenceReminder,
	resolveEffectiveStaffTier,
	resumeOrchestration,
	returnOrchestrationToken,
	syncMissionTaskStatusesFromOrchestration,
	updateMissionTaskNodeStatus,
	upsertDepartmentWhiteboard,
	validateTokenWhiteboardAttachments,
	wakeBlockedOrchestrationToken,
} from '../../common/adeOrchestrationEngine.js';
import {
	compileOrchestrationManifest,
	exportToOrchestrationManifest,
	IAdeOrchestrationManifest,
	validateOrchestrationManifest,
} from '../../common/adeOrchestrationConfig.js';
import {
	addStaffNodeToOrchestration,
	addWhiteboardNodeToOrchestration,
	computeOrchestrationAutoLayout,
	computeOrchestrationMultiAnchorRoutes,
	connectOrchestrationEdge,
	ORCHESTRATION_ANCHOR_SIDES,
	ORCHESTRATION_SLOTS_PER_SIDE,
	parseOrchestrationGraph,
	removeOrchestrationEdge,
	removeOrchestrationNode,
	renameOrchestrationEdgeLabel,
	renameOrchestrationNode,
	upsertOrchestrationNodeColorInCode,
	upsertOrchestrationStaffMetaInCode,
} from '../../common/adeOrchestrationGraph.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, normalizeAdeOrganizationConfig } from '../../common/adeRoleSchema.js';

suite('ADE Engineering Dual-View — Mission Task DAG & All-Staff Cyclic Orchestration', () => {
	const CORPORATE_ORCHESTRATION_TEXT = [
		'flowchart LR',
		'  CEO["CEO @Alice"] <--> BE_Lead["Backend Lead @Bob"]',
		'  CEO <--> FE_Lead["Frontend Lead @Carol"]',
		'  subgraph Backend["Backend Dept"]',
		'    BE_Lead <--> Dev1["API Engineer @Dave"]',
		'    Dev1 --> QA1["QA Engineer @Eve"]',
		'    QA1 -->|feedback| BE_Lead',
		'    WB_BE[("Whiteboard: Backend Spec")]',
		'    BE_Lead -.-> WB_BE',
		'    Dev1 -.-> WB_BE',
		'  end',
		'  subgraph Frontend["Frontend Dept"]',
		'    FE_Lead <--> UI1["UI Engineer @Frank"]',
		'  end',
		'  %% staff CEO [tier=1, rank=governor]',
		'  %% staff BE_Lead [tier=2, rank=manager, dept="Backend Dept"]',
		'  %% staff FE_Lead [tier=2, rank=manager, dept="Frontend Dept"]',
		'  %% staff Dev1 [tier=3, rank=employee, dept="Backend Dept"]',
		'  %% staff QA1 [tier=3, rank=employee, dept="Backend Dept"]',
		'  %% staff UI1 [tier=3, rank=employee, dept="Frontend Dept"]',
		'  %% whiteboard WB_BE [dept="Backend Dept", title="Backend Spec"]',
	].join('\n');

	test('parses cyclic & bidirectional Orchestration topology, subgraphs & whiteboards while enforcing 1:1 employee uniqueness', () => {
		const parsed = parseOrchestrationGraph(CORPORATE_ORCHESTRATION_TEXT);
		assert.strictEqual(parsed.error, undefined, `Unexpected parse error: ${parsed.error}`);
		assert.strictEqual(parsed.direction, 'LR');

		const staffNodes = parsed.nodes.filter(n => n.kind === 'staff');
		const wbNodes = parsed.nodes.filter(n => n.kind === 'whiteboard');
		assert.strictEqual(staffNodes.length, 6, 'All 6 staff ranks (L1..L3) enter the same canvas');
		assert.strictEqual(wbNodes.length, 1, 'Department whiteboard node parsed');
		assert.strictEqual(wbNodes[0].id, 'WB_BE');
		assert.strictEqual(wbNodes[0].department, 'Backend Dept');

		// Bidirectional edge CEO <--> BE_Lead expands to both directions
		assert.ok(parsed.edges.some(e => e.from === 'CEO' && e.to === 'BE_Lead' && e.isBidirectional));
		assert.ok(parsed.edges.some(e => e.from === 'BE_Lead' && e.to === 'CEO' && e.isBidirectional));

		// Arbitrary cycles allowed: BE_Lead -> Dev1 -> QA1 -> BE_Lead
		assert.ok(parsed.edges.some(e => e.from === 'QA1' && e.to === 'BE_Lead' && e.label === 'feedback'));

		// Department grouping captured
		const backendDept = parsed.departments.find(d => d.name === 'Backend Dept');
		assert.ok(backendDept, 'Backend Dept subgraph parsed');
		assert.ok(backendDept!.nodeIds.includes('BE_Lead'));
		assert.ok(backendDept!.nodeIds.includes('Dev1'));
		assert.ok(backendDept!.whiteboardIds.includes('WB_BE'));

		// Strict 1:1 employee uniqueness: duplicate @Alice across two nodes MUST be rejected!
		const dupGraph = parseOrchestrationGraph([
			'flowchart LR',
			'  N1["Lead @Alice"] --> N2["Reviewer @Alice"]',
		].join('\n'));
		assert.ok(dupGraph.error, 'Duplicate employee on two Orchestration nodes must be rejected');
		assert.ok(/once|unique|already|duplicate/i.test(dupGraph.error!));
	});

	test('computes cycle-safe layout & 4-side x 3-slot multi-anchor routing with bidirectional track separation and cycle back-edges', () => {
		const parsed = parseOrchestrationGraph(CORPORATE_ORCHESTRATION_TEXT);
		assert.strictEqual(parsed.error, undefined);
		assert.strictEqual(ORCHESTRATION_ANCHOR_SIDES.length, 4);
		assert.strictEqual(ORCHESTRATION_SLOTS_PER_SIDE, 5);

		const positions = computeOrchestrationAutoLayout(parsed);
		assert.strictEqual(positions.size, parsed.nodes.length, 'Every node in cyclic graph gets finite coordinates');
		for (const pos of positions.values()) {
			assert.ok(Number.isFinite(pos.x) && Number.isFinite(pos.y));
		}

		const routeMap = computeOrchestrationMultiAnchorRoutes(parsed.nodes, parsed.edges, positions, {
			direction: parsed.direction,
			cornerRadius: 14,
		});
		const routes = [...routeMap.values()];
		assert.strictEqual(routes.length, parsed.edges.length, 'Every edge receives a routed SVG path');

		// Verify all 4 presentation layout modes (lr, td, radial, grid) produce finite, non-overlapping coordinates & valid routes
		for (const mode of ['lr', 'td', 'radial', 'grid'] as const) {
			const modePos = computeOrchestrationAutoLayout(parsed, { layoutMode: mode });
			assert.strictEqual(modePos.size, parsed.nodes.length, `Layout mode "${mode}" positions all nodes`);
			for (const p of modePos.values()) {
				assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 0 && p.y > 0, `Layout mode "${mode}" stays in positive canvas space`);
			}
			const modeRoutes = computeOrchestrationMultiAnchorRoutes(parsed.nodes, parsed.edges, modePos, {
				direction: parsed.direction,
				layoutMode: mode,
				cornerRadius: 14,
			});
			assert.strictEqual(modeRoutes.size, parsed.edges.length, `Layout mode "${mode}" routes every edge cleanly`);
		}

		for (const r of routes) {
			assert.ok(r.path.startsWith('M '), `Route ${r.edgeId} must produce a valid SVG path`);
			assert.ok(Number.isFinite(r.midX) && Number.isFinite(r.midY));
			assert.ok(r.fromAnchor.slot >= 0 && r.fromAnchor.slot < ORCHESTRATION_SLOTS_PER_SIDE);
			assert.ok(r.toAnchor.slot >= 0 && r.toAnchor.slot < ORCHESTRATION_SLOTS_PER_SIDE);
		}

		// Bidirectional pair CEO <-> BE_Lead MUST separate onto distinct anchor slots (parallel tracks, never overlapping)
		const forwardEdge = parsed.edges.find(e => e.from === 'CEO' && e.to === 'BE_Lead')!;
		const backwardEdge = parsed.edges.find(e => e.from === 'BE_Lead' && e.to === 'CEO')!;
		const forward = routeMap.get(forwardEdge.id)!;
		const backward = routeMap.get(backwardEdge.id)!;
		assert.ok(forward && backward);
		assert.strictEqual(forward.isBidirectional, true);
		assert.strictEqual(backward.isBidirectional, true);
		const sameFromPort = forward.fromAnchor.side === backward.toAnchor.side && forward.fromAnchor.slot === backward.toAnchor.slot;
		const sameToPort = forward.toAnchor.side === backward.fromAnchor.side && forward.toAnchor.slot === backward.fromAnchor.slot;
		assert.ok(!sameFromPort || !sameToPort, 'Bidirectional edges must separate anchor slots so parallel lines stay crisp');

		// High-fan-out node spreads edges across multiple anchors instead of cramming 1 port
		const fanoutGraph = parseOrchestrationGraph([
			'flowchart LR',
			'  Hub["CEO @Alice (L1)"] --> A["@Bob (L2)"]',
			'  Hub --> B["@Carol (L2)"]',
			'  Hub --> C["@Dave (L2)"]',
			'  Hub --> D["@Eve (L2)"]',
			'  C --> E["@Frank (L3)"]',
			'  E --> Hub',
		].join('\n'));
		assert.strictEqual(fanoutGraph.error, undefined);
		const fanPos = computeOrchestrationAutoLayout(fanoutGraph);
		const fanRouteMap = computeOrchestrationMultiAnchorRoutes(fanoutGraph.nodes, fanoutGraph.edges, fanPos);
		const usedHubSlots = new Set(
			fanoutGraph.edges
				.filter(e => e.from === 'Hub')
				.map(e => fanRouteMap.get(e.id)!)
				.map(r => `${r.fromAnchor.side}:${r.fromAnchor.slot}`),
		);
		assert.ok(usedHubSlots.size >= 3, `Expected Hub 1-to-4 fan-out to spread across >=3 distinct anchors, got ${usedHubSlots.size}`);
		const backEdge = fanoutGraph.edges.find(e => e.from === 'E' && e.to === 'Hub')!;
		assert.strictEqual(fanRouteMap.get(backEdge.id)?.isCycleBackEdge, true, 'Feedback edge E->Hub is flagged as cycle back-edge');
	});

	test('enforces strict DAG acyclicity on Mission tasks and restricts Completed sign-off exclusively to highest-rank role (or Human)', () => {
		// Mission Task DAG MUST reject cycles
		const cyclicTaskDag = parseMissionMermaidDag('flowchart LR\n  T1["Design"] --> T2["Build"]\n  T2 --> T1');
		assert.ok(cyclicTaskDag.error, 'Mission Task DAG must remain strictly acyclic');

		const validTaskDag = parseMissionMermaidDag('flowchart LR\n  T1["Design"] --> T2["Build"]\n  T2 --> T3["Ship"]');
		assert.strictEqual(validTaskDag.error, undefined);
		assert.strictEqual(validTaskDag.nodes.length, 3);

		// Custom 3-tier schema where tier 1 is "VP"
		const customOrg = normalizeAdeOrganizationConfig({
			version: 1,
			ranks: [
				{ id: 'vp', name: 'VP Engineering', shortName: 'VP', tier: 1, color: 'amber', icon: 'shield', summary: '', initPrompt: '', canHaveSubordinates: true, allowedApis: [] },
				{ id: 'lead', name: 'Tech Lead', shortName: 'Lead', tier: 2, color: 'blue', icon: 'organization', summary: '', initPrompt: '', canHaveSubordinates: true, allowedApis: [] },
				{ id: 'eng', name: 'Engineer', shortName: 'Eng', tier: 3, color: 'green', icon: 'terminal', summary: '', initPrompt: '', canHaveSubordinates: false, allowedApis: [] },
			],
		});

		// L2 & L3 cannot mark task completed
		const rejL2 = updateMissionTaskNodeStatus({}, validTaskDag, customOrg, {
			nodeId: 'T1',
			status: 'completed',
			caller: { callerTier: 2, callerLabel: 'Lead Bob' },
		});
		assert.strictEqual(rejL2.ok, false, 'L2 must be denied marking Mission task completed');
		assert.strictEqual(rejL2.code, 'FORBIDDEN');

		const rejL3 = updateMissionTaskNodeStatus({}, validTaskDag, customOrg, {
			nodeId: 'T1',
			status: 'completed',
			caller: { callerTier: 3, callerLabel: 'Eng Dave' },
		});
		assert.strictEqual(rejL3.ok, false, 'L3 must be denied marking Mission task completed');

		// L1 (highest rank) succeeds!
		const okL1 = updateMissionTaskNodeStatus({}, validTaskDag, customOrg, {
			nodeId: 'T1',
			status: 'completed',
			caller: { callerSessionId: 'ag-vp', callerTier: 1, callerLabel: 'VP Alice' },
			now: 1000,
		});
		assert.strictEqual(okL1.ok, true);
		assert.strictEqual(okL1.taskStatuses.T1.status, 'completed');
		assert.strictEqual(okL1.taskStatuses.T1.completedByLabel, 'VP Alice');
		assert.strictEqual(okL1.taskStatuses.T1.completedAt, 1000);

		// Human user (L-1) also succeeds
		const okHuman = updateMissionTaskNodeStatus(okL1.taskStatuses, validTaskDag, customOrg, {
			nodeId: 'T2',
			status: 'completed',
			caller: { isHumanUser: true, callerLabel: 'Human' },
			now: 2000,
		});
		assert.strictEqual(okHuman.ok, true);
		assert.strictEqual(okHuman.taskStatuses.T2.status, 'completed');
	});

	test('runs corporate top-down dispatch, re-entrant cyclic token relay without destroying staff, and 5-minute repeating silence reminders', () => {
		const parsed = parseOrchestrationGraph(CORPORATE_ORCHESTRATION_TEXT);
		assert.strictEqual(parsed.error, undefined);

		const topNode = findHighestRankStaffNode(parsed);
		assert.strictEqual(topNode?.id, 'CEO', 'Highest-rank node is CEO (tier 1)');

		const t0 = 1_000_000;
		const staffIds = parsed.nodes.filter(n => n.kind === 'staff').map(n => n.id);
		const initState = createInitialOrchestrationRuntimeState('eng-1', staffIds, t0);
		const dispatched = dispatchRequirementToOrchestration(initState, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Deliver v2 payments API and checkout UI',
			now: t0,
		});
		assert.strictEqual(dispatched.ok, true);
		assert.strictEqual(dispatched.data!.targetNodeId, 'CEO');
		assert.strictEqual(dispatched.state.nodeStates.CEO, 'active');

		// 5-minute silence reminder repeats every 5 minutes without freezing or destroying the employee!
		assert.strictEqual(ORCHESTRATION_SILENCE_REMINDER_MINUTES, 5);
		const ceoTokId = dispatched.data!.tokenId;
		const r1 = recordOrchestrationSilenceReminder(dispatched.state, { tokenId: ceoTokId, now: t0 + 5 * 60_000 });
		assert.strictEqual(r1.ok, true);
		assert.strictEqual(r1.state.tokens[ceoTokId].nudgeCount, 1);
		assert.strictEqual(r1.state.tokens[ceoTokId].status, 'active', 'Reminder must NEVER freeze or destroy active staff');
		assert.ok(r1.effects.some(e => e.kind === 'silence_reminder' && e.nudgeCount === 1));

		const r2 = recordOrchestrationSilenceReminder(r1.state, { tokenId: ceoTokId, now: t0 + 10 * 60_000 });
		assert.strictEqual(r2.ok, true);
		assert.strictEqual(r2.state.tokens[ceoTokId].nudgeCount, 2);
		assert.strictEqual(r2.state.tokens[ceoTokId].status, 'active');

		// CEO decomposes requirement and hands off parallel tokens to BE_Lead and FE_Lead
		const fanout = handoffOrchestrationToken(r2.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: ceoTokId,
			toNodeIds: ['BE_Lead', 'FE_Lead'],
			summary: 'Split into Backend ledger API and Frontend checkout UI',
			now: t0 + 11 * 60_000,
		});
		assert.strictEqual(fanout.ok, true);
		assert.strictEqual(fanout.state.nodeStates.CEO, 'idle', 'CEO returns to idle (not destroyed) after handing off token');
		assert.strictEqual(fanout.state.nodeStates.BE_Lead, 'active');
		assert.strictEqual(fanout.state.nodeStates.FE_Lead, 'active');

		const beTokId = fanout.data!.nextTokenIds.find(id => fanout.state.tokens[id].nodeId === 'BE_Lead')!;
		const feTokId = fanout.data!.nextTokenIds.find(id => fanout.state.tokens[id].nodeId === 'FE_Lead')!;

		// BE_Lead -> Dev1 -> QA1 -> BE_Lead (cyclic re-entry wakes BE_Lead again!)
		const toDev = handoffOrchestrationToken(fanout.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: beTokId,
			toNodeIds: ['Dev1'],
			summary: 'Code /v2/pay endpoint',
			now: t0 + 12 * 60_000,
		});
		assert.strictEqual(toDev.ok, true);
		assert.strictEqual(toDev.state.nodeStates.BE_Lead, 'idle');

		const toQa = handoffOrchestrationToken(toDev.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: toDev.data!.nextTokenIds[0],
			toNodeIds: ['QA1'],
			summary: 'Run integration tests',
			now: t0 + 13 * 60_000,
		});
		assert.strictEqual(toQa.ok, true);

		const backToBeLead = handoffOrchestrationToken(toQa.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: toQa.data!.nextTokenIds[0],
			toNodeIds: ['BE_Lead'],
			summary: 'QA feedback: fix idempotency key',
			now: t0 + 14 * 60_000,
		});
		assert.strictEqual(backToBeLead.ok, true, 'Cyclic edge QA1 -> BE_Lead must re-wake BE_Lead seamlessly');
		assert.strictEqual(backToBeLead.state.nodeStates.BE_Lead, 'active');
		assert.ok(backToBeLead.effects.some(e => e.kind === 'dispatch_token' && e.nodeId === 'BE_Lead'));

		// Block & wake token cleanly
		const blocked = blockOrchestrationToken(backToBeLead.state, {
			tokenId: feTokId,
			reason: 'Waiting for webpack build',
			maxDurationMs: 60_000,
			now: t0 + 15 * 60_000,
		});
		assert.strictEqual(blocked.ok, true);
		assert.strictEqual(blocked.state.nodeStates.FE_Lead, 'blocked');
		const woke = wakeBlockedOrchestrationToken(blocked.state, {
			tokenId: feTokId,
			reason: 'pid_exited',
			detail: 'Build succeeded',
			now: t0 + 16 * 60_000,
		});
		assert.strictEqual(woke.ok, true);
		assert.strictEqual(woke.state.nodeStates.FE_Lead, 'active');

		// Explicit finish returns staff to idle cleanly
		const doneFe = completeOrchestrationToken(woke.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: feTokId,
			summary: 'Checkout UI verified',
			finish: true,
			now: t0 + 17 * 60_000,
		});
		assert.strictEqual(doneFe.ok, true);
		assert.strictEqual(doneFe.state.nodeStates.FE_Lead, 'idle');
	});

	test('supports runtime dynamic subordinate expansion (L1 -> L2 -> L3) while enforcing rank & uniqueness constraints', () => {
		const startGraph = [
			'flowchart LR',
			'  CEO["CEO @Alice"]',
			'  %% staff CEO [tier=1, rank=governor]',
		].join('\n');

		// L1 CEO dynamically creates L2 Backend Lead
		const step1 = planDynamicSubordinateCreation(startGraph, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			callerNodeId: 'CEO',
			callerTier: 1,
			name: 'Bob',
			roleLabel: 'Backend Lead',
			targetRankIdOrTier: 2,
			department: 'Backend',
			bidirectional: true,
		});
		assert.strictEqual(step1.ok, true, `Expected L1->L2 creation to succeed: ${step1.error}`);
		assert.ok(step1.newNodeId && step1.orchestrationText);

		// L2 Bob recursively creates L3 Engineer Carol!
		const step2 = planDynamicSubordinateCreation(step1.orchestrationText!, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			callerNodeId: step1.newNodeId!,
			callerTier: 2,
			name: 'Carol',
			roleLabel: 'API Engineer',
			targetRankIdOrTier: 3,
			department: 'Backend',
			bidirectional: true,
		});
		assert.strictEqual(step2.ok, true, `Expected L2->L3 recursive expansion to succeed: ${step2.error}`);

		const parsedAfter = parseOrchestrationGraph(step2.orchestrationText!);
		assert.strictEqual(parsedAfter.error, undefined);
		assert.strictEqual(parsedAfter.nodes.filter(n => n.kind === 'staff').length, 3);

		// Reject peer/higher tier creation (L2 cannot create another L2 or L1)
		const badTier = planDynamicSubordinateCreation(step2.orchestrationText!, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			callerNodeId: step1.newNodeId!,
			callerTier: 2,
			name: 'Intruder',
			targetRankIdOrTier: 2,
		});
		assert.strictEqual(badTier.ok, false, 'Caller must only create strictly lower-tier subordinates');

		// Reject duplicate employee name
		const dupName = planDynamicSubordinateCreation(step2.orchestrationText!, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			callerNodeId: 'CEO',
			callerTier: 1,
			name: 'Bob',
			targetRankIdOrTier: 2,
		});
		assert.strictEqual(dupName.ok, false, 'Dynamic creation must preserve 1:1 unique employee invariant');
	});

	test('enforces department shared whiteboard scoping and strictly lightweight pointer-only tokens', () => {
		const parsed = parseOrchestrationGraph(CORPORATE_ORCHESTRATION_TEXT);
		assert.strictEqual(parsed.error, undefined);

		const secretLongSpec = 'DETAILED_BACKEND_SPEC_BODY_UNIQUE_MARKER_987654321\n'.repeat(40);
		const wbUpsert = upsertDepartmentWhiteboard({}, {
			id: 'WB_BE',
			department: 'Backend Dept',
			title: 'Backend Spec',
			content: secretLongSpec,
			updatedBy: 'BE_Lead',
			updatedByLabel: 'Backend Lead @Bob',
			now: 5000,
		});
		const wb = wbUpsert.whiteboard;
		assert.strictEqual(wb.version, 1);

		// Same-department staff & L1/Human can read/write; unrelated Frontend L3 cannot
		assert.strictEqual(canCallerAccessWhiteboard(parsed, wb, DEFAULT_ADE_ORGANIZATION_CONFIG, { callerNodeId: 'Dev1', callerTier: 3 }), true);
		assert.strictEqual(canCallerAccessWhiteboard(parsed, wb, DEFAULT_ADE_ORGANIZATION_CONFIG, { callerNodeId: 'CEO', callerTier: 1 }), true);
		assert.strictEqual(canCallerAccessWhiteboard(parsed, wb, DEFAULT_ADE_ORGANIZATION_CONFIG, { isHumanUser: true }), true);
		assert.strictEqual(
			canCallerAccessWhiteboard(parsed, wb, DEFAULT_ADE_ORGANIZATION_CONFIG, { callerNodeId: 'UI1', callerTier: 3 }),
			false,
			'Cross-department non-executive must not write another department whiteboard',
		);

		// Dispatch and hand off token carrying ONLY whiteboard pointer (NOT full whiteboard body!)
		const staffIds = parsed.nodes.filter(n => n.kind === 'staff').map(n => n.id);
		const init = createInitialOrchestrationRuntimeState('eng-wb', staffIds, 6000);
		const d = dispatchRequirementToOrchestration(init, parsed, wbUpsert.whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Sync backend spec',
			targetNodeId: 'BE_Lead',
			whiteboardIds: ['WB_BE'],
			now: 6000,
		});
		assert.strictEqual(d.ok, true);

		const handed = handoffOrchestrationToken(d.state, parsed, wbUpsert.whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: d.data!.tokenId,
			toNodeIds: ['Dev1'],
			summary: 'Read WB_BE pointer and implement',
			whiteboardIds: ['WB_BE'],
			now: 7000,
		});
		assert.strictEqual(handed.ok, true);

		const childTok = handed.state.tokens[handed.data!.nextTokenIds[0]];
		assert.strictEqual(childTok.whiteboardPointers?.length, 1);
		assert.strictEqual(childTok.whiteboardPointers![0].whiteboardId, 'WB_BE');
		assert.strictEqual(childTok.whiteboardPointers![0].version, 1);
		assert.strictEqual(isLightweightOrchestrationToken(childTok, wbUpsert.whiteboards), true, 'Token must remain lightweight with pointer only');
		assert.ok(!JSON.stringify(childTok).includes('DETAILED_BACKEND_SPEC_BODY_UNIQUE_MARKER_987654321'), 'Token JSON must NEVER inline full whiteboard text');

		// Runtime dynamic whiteboard creation works cleanly
		const wbPlan = planDynamicWhiteboardCreation(CORPORATE_ORCHESTRATION_TEXT, {
			department: 'Frontend Dept',
			title: 'Design Tokens',
			connectFromNodeId: 'FE_Lead',
		});
		assert.strictEqual(wbPlan.ok, true);
		assert.ok(wbPlan.whiteboardId && wbPlan.orchestrationText);
		const reparsed = parseOrchestrationGraph(wbPlan.orchestrationText!);
		assert.strictEqual(reparsed.error, undefined);
		assert.ok(reparsed.nodes.some(n => n.id === wbPlan.whiteboardId && n.kind === 'whiteboard'));
	});

	test('supports bidirectional authoring mutators on Orchestration declarative code', () => {
		let code = 'flowchart LR';
		const a1 = addStaffNodeToOrchestration(code, { name: 'Alice', tier: 1, rankId: 'governor' });
		assert.strictEqual(a1.ok, true);
		code = a1.orchestrationText!;

		const a2 = addStaffNodeToOrchestration(code, { name: 'Bob', tier: 2, rankId: 'manager', department: 'Core' });
		assert.strictEqual(a2.ok, true);
		code = a2.orchestrationText!;

		const wb = addWhiteboardNodeToOrchestration(code, { department: 'Core', title: 'Core Notes' });
		assert.strictEqual(wb.ok, true);
		code = wb.orchestrationText!;

		const conn = connectOrchestrationEdge(code, a1.nodeId!, a2.nodeId!, { bidirectional: true, label: 'sync' });
		assert.strictEqual(conn.ok, true);
		code = conn.orchestrationText!;

		code = renameOrchestrationNode(code, a2.nodeId!, 'Bob Lead');
		code = renameOrchestrationEdgeLabel(code, a1.nodeId!, a2.nodeId!, 'handoff');
		let parsed = parseOrchestrationGraph(code);
		assert.strictEqual(parsed.error, undefined);
		assert.strictEqual(parsed.nodes.find(n => n.id === a2.nodeId)?.label, 'Bob Lead');
		assert.ok(parsed.edges.some(e => e.from === a1.nodeId && e.to === a2.nodeId && e.label === 'handoff'));

		code = removeOrchestrationEdge(code, a1.nodeId!, a2.nodeId!);
		code = removeOrchestrationNode(code, wb.whiteboardId!);
		parsed = parseOrchestrationGraph(code);
		assert.strictEqual(parsed.error, undefined);
		assert.ok(!parsed.nodes.some(n => n.id === wb.whiteboardId));
	});

	test('strictly enforces directed edges at runtime while surfacing non-blocking return-edge choreography advisories at authoring time', () => {
		// Well-formed corporate graph where every downward hierarchy edge has a return channel (<--> or cycle) -> ZERO advisories!
		const cleanParsed = parseOrchestrationGraph(CORPORATE_ORCHESTRATION_TEXT);
		assert.strictEqual(cleanParsed.error, undefined);
		assert.strictEqual(cleanParsed.advisories?.length ?? 0, 0, 'Graph with <--> and cycle return paths has zero one-way advisories');

		// One-way downward Manager --> Engineer edge WITHOUT return edge parses cleanly (non-blocking) AND emits advisory!
		const oneWayText = [
			'flowchart LR',
			'  Mgr["@Bob · Manager (L2)"] --> Eng["@Carol · Engineer (L3)"]',
		].join('\n');
		const oneWayParsed = parseOrchestrationGraph(oneWayText);
		assert.strictEqual(oneWayParsed.error, undefined, 'One-way graph remains valid (advisory must NOT block parsing)');
		assert.ok(oneWayParsed.advisories && oneWayParsed.advisories.length >= 1, 'One-way downward edge surfaces choreography advisory');
		assert.ok(oneWayParsed.advisories!.some(a => a.code === 'ONE_WAY_HIERARCHY_EDGE' && a.fromNodeId === 'Mgr' && a.toNodeId === 'Eng'));

		// Same-tier one-way peer link without outgoing edge triggers DEAD_END_STAFF_NODE advisory
		const deadEndParsed = parseOrchestrationGraph('flowchart LR\n  PeerA["@Dave · Dev (L3)"] --> PeerB["@Eve · QA (L3)"]');
		assert.strictEqual(deadEndParsed.error, undefined);
		assert.ok(deadEndParsed.advisories!.some(a => a.code === 'DEAD_END_STAFF_NODE' && a.fromNodeId === 'PeerB'));

		// At runtime, engine strictly respects directed edges (NEVER bypasses missing return edge!)
		const init = createInitialOrchestrationRuntimeState('eng-oneway', ['Mgr', 'Eng'], 1000);
		const d = dispatchRequirementToOrchestration(init, oneWayParsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Implement rate limiter',
			targetNodeId: 'Mgr',
			now: 1000,
		});
		assert.strictEqual(d.ok, true);
		const toEng = handoffOrchestrationToken(d.state, oneWayParsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: d.data!.tokenId,
			toNodeIds: ['Eng'],
			summary: 'Build rate limiter module',
			now: 2000,
		});
		assert.strictEqual(toEng.ok, true, 'Forward directed edge Mgr -> Eng succeeds');

		// Eng tries to hand baton back to Mgr without a return edge -> MUST be rejected with NO_EDGE!
		const backAttempt = handoffOrchestrationToken(toEng.state, oneWayParsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: toEng.data!.nextTokenIds[0],
			toNodeIds: ['Mgr'],
			summary: 'Done, returning to Manager',
			now: 3000,
		});
		assert.strictEqual(backAttempt.ok, false, 'Subordinate cannot return token without an explicit return edge');
		assert.strictEqual(backAttempt.code, 'NO_EDGE');
		assert.ok(/return edge|<-->/i.test(backAttempt.error ?? ''), 'Error guides user/agent to add return edge during choreography');
	});

	test('implements pointer-native tokens with adaptive <=160c headlines, independent per-hop/artifact/decision pointers, and content-addressed dedup', () => {
		const parsed = parseOrchestrationGraph(CORPORATE_ORCHESTRATION_TEXT);
		assert.strictEqual(parsed.error, undefined);
		const wbRes = upsertDepartmentWhiteboard({}, {
			id: 'WB_BE',
			department: 'Backend Dept',
			title: 'Backend Spec',
			content: 'WHITEBOARD_V1_CANONICAL_API_CONTRACT_PAYLOAD_XYZ'.repeat(15),
			updatedBy: 'BE_Lead',
			updatedByLabel: 'Backend Lead @Bob',
			now: 1000,
		});

		const staffIds = parsed.nodes.filter(n => n.kind === 'staff').map(n => n.id);
		const init = createInitialOrchestrationRuntimeState('eng-ptr', staffIds, 1000);

		// Long >160-char dispatch prompt auto-spills into independent hop-N pointer while keeping headline compact!
		const longRequirement = `REQUIREMENT_FULL_BODY_MARKER: ${'Deliver zero-downtime ledger migration with full idempotency and shadow verification. '.repeat(5)}`;
		assert.ok(longRequirement.length > ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS);
		const d = dispatchRequirementToOrchestration(init, parsed, wbRes.whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: longRequirement,
			artifacts: [{ title: 'Schema DDL', content: 'CREATE TABLE ledger_v2 (id TEXT PRIMARY KEY, amount BIGINT NOT NULL);' }],
			decisions: [{ title: 'Idempotency Key', content: 'Use UUIDv7 client idempotency key with 24h Redis TTL.' }],
			whiteboardIds: ['WB_BE'],
			now: 1000,
		});
		assert.strictEqual(d.ok, true);
		const ceoTok = d.state.tokens[d.data!.tokenId];
		assert.ok(ceoTok.lastSummary.length <= ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS + 1, 'Headline stays <=160 chars');
		assert.ok(ceoTok.payloadPtr && ceoTok.payloadPtr.startsWith('hop-'), 'Long dispatch auto-spills to independent hop-N pointer');
		assert.strictEqual(ceoTok.hopIndex, 0);
		assert.strictEqual(ceoTok.hopLog?.length, 1);
		assert.strictEqual(ceoTok.hopLog![0].payloadPtr, ceoTok.payloadPtr);
		assert.ok(ceoTok.contextRefs?.some(r => r.kind === 'artifact' && r.ptr.startsWith('art-') && r.title === 'Schema DDL'));
		assert.ok(ceoTok.contextRefs?.some(r => r.kind === 'decision' && r.ptr.startsWith('dec-') && r.title === 'Idempotency Key'));
		assert.ok(ceoTok.contextRefs?.some(r => r.kind === 'whiteboard' && r.ptr === 'wb:WB_BE' && r.version === 1));
		assert.strictEqual(isLightweightOrchestrationToken(ceoTok, wbRes.whiteboards, d.state.payloadStore), true);
		const serializedCeoTok = JSON.stringify(ceoTok);
		assert.ok(!serializedCeoTok.includes('CREATE TABLE ledger_v2'), 'Token JSON never inlines artifact body');
		assert.ok(!serializedCeoTok.includes('24h Redis TTL'), 'Token JSON never inlines decision body');
		assert.ok(!serializedCeoTok.includes('WHITEBOARD_V1_CANONICAL_API_CONTRACT_PAYLOAD_XYZ'), 'Token JSON never inlines whiteboard body');

		// Content-addressed deduplication: re-attaching identical artifact body on handoff reuses the EXACT same art-N pointer!
		const artPtrBefore = ceoTok.contextRefs!.find(r => r.kind === 'artifact')!.ptr;
		const h1 = handoffOrchestrationToken(d.state, parsed, wbRes.whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: ceoTok.id,
			toNodeIds: ['BE_Lead'],
			summary: 'Own backend ledger migration',
			detail: 'ROUND_1_DETAIL_BODY: Split DB migration from API rollout and verify benchmarks.',
			artifacts: [{ title: 'Schema DDL Copy', content: 'CREATE TABLE ledger_v2 (id TEXT PRIMARY KEY, amount BIGINT NOT NULL);' }],
			now: 2000,
		});
		assert.strictEqual(h1.ok, true);
		const leadTok = h1.state.tokens[h1.data!.nextTokenIds[0]];
		assert.strictEqual(leadTok.hopIndex, 1);
		assert.strictEqual(leadTok.hopLog?.length, 2, 'Pass history carries both Hop #0 and Hop #1');
		assert.ok(leadTok.payloadPtr && leadTok.payloadPtr !== ceoTok.payloadPtr, 'Each handoff round with detail gets its own independent hop-N pointer');
		const artRefsAfter = (leadTok.contextRefs ?? []).filter(r => r.kind === 'artifact');
		assert.strictEqual(artRefsAfter.length, 1, 'Identical artifact content deduplicates onto existing art-N pointer');
		assert.strictEqual(artRefsAfter[0].ptr, artPtrBefore);
		assert.strictEqual(isLightweightOrchestrationToken(leadTok, wbRes.whiteboards, h1.state.payloadStore), true);
	});

	test('delivers zero-redundancy cyclic re-entry deltas, resurfaces version-bumped whiteboards, and supports batch pointer dereferencing', () => {
		const parsed = parseOrchestrationGraph(CORPORATE_ORCHESTRATION_TEXT);
		assert.strictEqual(parsed.error, undefined);

		let whiteboards = upsertDepartmentWhiteboard({}, {
			id: 'WB_BE',
			department: 'Backend Dept',
			title: 'Backend Spec',
			content: 'WB_V1_INITIAL_BACKEND_SPEC_BODY',
			updatedBy: 'BE_Lead',
			updatedByLabel: 'Backend Lead @Bob',
			now: 1000,
		}).whiteboards;

		const staffIds = parsed.nodes.filter(n => n.kind === 'staff').map(n => n.id);
		const init = createInitialOrchestrationRuntimeState('eng-delta', staffIds, 1000);

		// Hop 0: User -> CEO
		const d0 = dispatchRequirementToOrchestration(init, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Build payments v2',
			artifacts: [{ title: 'API Contract', content: 'POST /v2/pay { amount, currency, idempotencyKey }' }],
			whiteboardIds: ['WB_BE'],
			now: 1000,
		});
		assert.strictEqual(d0.ok, true);

		// Hop 1: CEO -> BE_Lead (1st visit for BE_Lead: NOT re-entrant, sees full manifest)
		const h1 = handoffOrchestrationToken(d0.state, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: d0.data!.tokenId,
			toNodeIds: ['BE_Lead'],
			summary: 'Lead backend implementation',
			detail: 'LEAD_BRIEF_V1: Coordinate Dev1 and QA1 on /v2/pay.',
			now: 2000,
		});
		assert.strictEqual(h1.ok, true);
		const leadTok1 = h1.state.tokens[h1.data!.nextTokenIds[0]];
		const deltaVisit1 = buildOrchestrationTokenDeltaView(h1.state, leadTok1, whiteboards);
		assert.strictEqual(deltaVisit1.isReentrantVisit, false);
		assert.strictEqual(deltaVisit1.newHops.length, 2);
		assert.strictEqual(deltaVisit1.unchangedRefs.length, 0);

		// Hop 2: BE_Lead -> Dev1 (updates BE_Lead's read cursor through hop #2 + seen art-1@v1 & wb:WB_BE@v1!)
		const h2 = handoffOrchestrationToken(h1.state, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: leadTok1.id,
			toNodeIds: ['Dev1'],
			summary: 'Implement /v2/pay handler',
			now: 3000,
		});
		assert.strictEqual(h2.ok, true);

		// Dev1 updates Department Whiteboard WB_BE (v1 -> v2) AND attaches a new build artifact!
		whiteboards = upsertDepartmentWhiteboard(whiteboards, {
			id: 'WB_BE',
			department: 'Backend Dept',
			title: 'Backend Spec',
			content: 'WB_V2_UPDATED_WITH_ERROR_CODES_409_422',
			updatedBy: 'Dev1',
			updatedByLabel: 'API Engineer @Dave',
			now: 3500,
		}).whiteboards;

		// Hop 3: Dev1 -> QA1
		const h3 = handoffOrchestrationToken(h2.state, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: h2.data!.nextTokenIds[0],
			toNodeIds: ['QA1'],
			summary: 'Endpoint ready for QA',
			artifacts: [{ title: 'Benchmark Log', content: 'p99=11ms, 0 errors across 5k reqs' }],
			now: 4000,
		});
		assert.strictEqual(h3.ok, true);

		// Hop 4: QA1 -> BE_Lead (CYCLIC RE-ENTRY into BE_Lead!)
		const h4 = handoffOrchestrationToken(h3.state, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: h3.data!.nextTokenIds[0],
			toNodeIds: ['BE_Lead'],
			summary: 'QA failed edge case on duplicate key',
			detail: 'QA_REPRO_STACKTRACE_HOP4: Concurrent replay returns 500 instead of 409.',
			decisions: [{ title: 'Lock Strategy', content: 'Use INSERT ... ON CONFLICT DO NOTHING returning existing row.' }],
			now: 5000,
		});
		assert.strictEqual(h4.ok, true);
		const leadTok2 = h4.state.tokens[h4.data!.nextTokenIds[0]];

		// Verify Delta View on BE_Lead's 2nd visit:
		// - earlierHops collapses Hops #0..#2 (already seen by BE_Lead)
		// - newHops contains ONLY Hops #3 (Dev1->QA1) and #4 (QA1->BE_Lead)
		// - unchangedRefs collapses art-1@v1 (API Contract) and earlier hop details -> ZERO duplicate context!
		// - newOrUpdatedRefs automatically surfaces:
		//   1) wb:WB_BE@v2 (version bumped v1 -> v2!),
		//   2) Benchmark Log artifact (new at hop #3),
		//   3) QA_REPRO_STACKTRACE_HOP4 & Lock Strategy decision (new at hop #4)!
		const deltaVisit2 = buildOrchestrationTokenDeltaView(h4.state, leadTok2, whiteboards);
		assert.strictEqual(deltaVisit2.isReentrantVisit, true);
		assert.strictEqual(deltaVisit2.lastSeenHop, 2);
		assert.deepStrictEqual(deltaVisit2.earlierHops.map(h => h.hop), [0, 1, 2]);
		assert.deepStrictEqual(deltaVisit2.newHops.map(h => h.hop), [3, 4]);
		assert.ok(deltaVisit2.unchangedRefs.some(r => r.title === 'API Contract'), 'Unchanged API Contract stays collapsed on cyclic re-entry');
		assert.ok(deltaVisit2.newOrUpdatedRefs.some(r => r.ptr === 'wb:WB_BE' && r.version === 2), 'Version-bumped whiteboard wb:WB_BE@v2 automatically surfaces in delta!');
		assert.ok(deltaVisit2.newOrUpdatedRefs.some(r => r.kind === 'artifact' && r.title === 'Benchmark Log'));
		assert.ok(deltaVisit2.newOrUpdatedRefs.some(r => r.kind === 'decision' && r.title === 'Lock Strategy'));

		// Wakeup prompt generated for BE_Lead reflects delta collapse without pasting any blob bodies!
		const beNode = parsed.nodes.find(n => n.id === 'BE_Lead')!;
		const wakeupPrompt = composeOrchestrationTokenWakeupPrompt('eng-delta', beNode, leadTok2, ['CEO', 'Dev1'], false, deltaVisit2);
		assert.ok(wakeupPrompt.includes('cyclic re-entry — delta since hop #2'));
		assert.ok(wakeupPrompt.includes('Unchanged Pointers Already In Your Context'));
		assert.ok(wakeupPrompt.includes('wb:WB_BE'));
		assert.ok(!wakeupPrompt.includes('WB_V2_UPDATED_WITH_ERROR_CODES_409_422'), 'Wakeup prompt never inlines whiteboard body');
		assert.ok(!wakeupPrompt.includes('QA_REPRO_STACKTRACE_HOP4'), 'Wakeup prompt never inlines hop detail body');

		// Batch dereference multiple heterogeneous pointers in 1 call (hop-N + dec-N + wb:WB_BE)
		const qaDetailPtr = leadTok2.payloadPtr!;
		const decPtr = deltaVisit2.newOrUpdatedRefs.find(r => r.kind === 'decision')!.ptr;
		const batchRead = readOrchestrationTokenPointers(h4.state, whiteboards, parsed, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			ptrs: [qaDetailPtr, decPtr, 'wb:WB_BE'],
			readerNodeId: 'BE_Lead',
			waveId: leadTok2.waveId,
			caller: { callerNodeId: 'BE_Lead', callerTier: 2 },
			now: 5500,
		});
		assert.strictEqual(batchRead.items.length, 3);
		assert.strictEqual(batchRead.items[0].ok, true);
		assert.ok(batchRead.items[0].content?.includes('QA_REPRO_STACKTRACE_HOP4'));
		assert.strictEqual(batchRead.items[1].ok, true);
		assert.ok(batchRead.items[1].content?.includes('ON CONFLICT DO NOTHING'));
		assert.strictEqual(batchRead.items[2].ok, true);
		assert.strictEqual(batchRead.items[2].version, 2);
		assert.ok(batchRead.items[2].content?.includes('WB_V2_UPDATED_WITH_ERROR_CODES_409_422'));

		// Cross-department L3 (UI1 in Frontend Dept) is blocked from reading Backend whiteboard via token read!
		const crossDeptRead = readOrchestrationTokenPointers(batchRead.state, whiteboards, parsed, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			ptrs: ['wb:WB_BE'],
			caller: { callerNodeId: 'UI1', callerTier: 3 },
		});
		assert.strictEqual(crossDeptRead.items[0].ok, false);
		assert.ok(/FORBIDDEN/i.test(crossDeptRead.items[0].error ?? ''));

		// After BE_Lead read those pointers, delta view marks them seen!
		const deltaAfterRead = buildOrchestrationTokenDeltaView(batchRead.state, leadTok2, whiteboards);
		assert.ok(deltaAfterRead.unchangedRefs.some(r => r.ptr === 'wb:WB_BE' && r.version === 2), 'Reading wb:WB_BE@v2 updates BE_Lead read cursor');

		// getOrchestrationTokenHistory supports both full (--all) and delta (--delta) views
		const fullHist = getOrchestrationTokenHistory(h4.state, leadTok2.id, whiteboards, { includeAll: true });
		const deltaHist = getOrchestrationTokenHistory(h4.state, leadTok2.id, whiteboards, { includeAll: false });
		assert.strictEqual(fullHist.ok, true);
		assert.strictEqual(fullHist.hopLog?.length, 5, 'Full history contains all 5 hops (#0..#4)');
		assert.strictEqual(deltaHist.hopLog?.length, 2, 'Delta history contains only the 2 unseen hops (#3..#4)');

		// Parallel fan-in within the same wave MUST NOT suppress unseen hops from a second branch!
		const fanGraph = parseOrchestrationGraph([
			'flowchart LR',
			'  CEO["CEO @Alice (L1)"] <--> A["Lead A @Bob (L2)"]',
			'  CEO <--> B["Lead B @Carol (L2)"]',
			'  A <--> B',
		].join('\n'));
		assert.strictEqual(fanGraph.error, undefined);
		const fanInit = createInitialOrchestrationRuntimeState('eng-fan', ['CEO', 'A', 'B'], 1000);
		const fd0 = dispatchRequirementToOrchestration(fanInit, fanGraph, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, { prompt: 'Parallel branches', now: 1000 });
		const fSplit = handoffOrchestrationToken(fd0.state, fanGraph, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: fd0.data!.tokenId,
			toNodeIds: ['A', 'B'],
			summary: 'Fan out to A and B',
			now: 2000,
		});
		const tokA = fSplit.data!.nextTokenIds.find(id => fSplit.state.tokens[id].nodeId === 'A')!;
		const tokB = fSplit.data!.nextTokenIds.find(id => fSplit.state.tokens[id].nodeId === 'B')!;
		// A hands off back to CEO (advancing A's cursor to hop #2)
		const aToCeo = handoffOrchestrationToken(fSplit.state, fanGraph, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: tokA,
			toNodeIds: ['CEO'],
			summary: 'Branch A done',
			now: 3000,
		});
		// B then hands off to A at hop #2 in the SAME wave! A must still see B's hop #1 and #2!
		const bToA = handoffOrchestrationToken(aToCeo.state, fanGraph, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: tokB,
			toNodeIds: ['A'],
			summary: 'Branch B needs A review',
			now: 4000,
		});
		const bToATok = bToA.state.tokens[bToA.data!.nextTokenIds[0]];
		const parallelDelta = buildOrchestrationTokenDeltaView(bToA.state, bToATok, {});
		assert.deepStrictEqual(parallelDelta.earlierHops.map(h => h.hop), [0], 'Only shared root Hop #0 collapses');
		assert.deepStrictEqual(parallelDelta.newHops.map(h => h.hop), [1, 2], 'Parallel branch B hops #1 and #2 stay visible despite A already passing hop #2 on branch A');
	});

	test('100% lossless bijective Mermaid serialization round-trips groups, empty groups, staff runtime metadata, multiline whiteboards, layout mode, edges & positions', async () => {
		const mod = await import('../../common/adeOrchestrationGraph.js');
		const trickyMarkdown = [
			'# Platform Architecture Spec',
			'',
			'Includes unicode (架构规范), quotes "double" & \'single\', code fences:',
			'```mermaid',
			'%% wb-end  <-- literal directive inside body MUST NOT prematurely close block!',
			'A --> B',
			'```',
			'Trailing empty line test:',
			'',
		].join('\n');

		const initialCode = mod.serializeOrchestrationGraph({
			direction: 'LR',
			layoutMode: 'radial',
			departments: [
				{ id: 'Backend', name: 'Backend Engineering', nodeIds: ['M_BE', 'E_API'], whiteboardIds: ['WB_BE'] },
				{ id: 'SecAudit', name: 'Security Audit', nodeIds: [], whiteboardIds: [] },
			],
			nodes: [
				{ id: 'GOV', label: 'Chief Architect', kind: 'staff', employeeName: 'Chief Architect', tier: 1, rankId: 'governor', engineId: 'aexus-claude', model: 'claude-opus-4-6', thinking: 'high', hostAlias: 'local' },
				{ id: 'M_BE', label: 'Backend Manager', kind: 'staff', employeeName: 'Backend Manager', tier: 2, rankId: 'manager', department: 'Backend Engineering', engineId: 'aexus-codex', model: 'gpt-5.4', thinking: 'medium', hostAlias: 'gpu-box-1' },
				{ id: 'E_API', label: 'API Engineer', kind: 'staff', employeeName: 'API Engineer', tier: 3, rankId: 'employee', department: 'Backend Engineering' },
				{ id: 'WB_BE', label: 'Backend API Contract', kind: 'whiteboard', whiteboardId: 'WB_BE', department: 'Backend Engineering', whiteboardVersion: 4, whiteboardContent: trickyMarkdown },
			],
			edges: [
				{ id: 'GOV->M_BE', from: 'GOV', to: 'M_BE', label: 'delegate' },
				{ id: 'M_BE->GOV', from: 'M_BE', to: 'GOV', label: 'delegate' },
				{ id: 'M_BE->E_API', from: 'M_BE', to: 'E_API', label: 'build' },
				{ id: 'E_API->M_BE', from: 'E_API', to: 'M_BE', label: 'review' },
				{ id: 'E_API->WB_BE', from: 'E_API', to: 'WB_BE', label: 'sync', dashed: true },
			],
			positions: {
				GOV: { x: 400, y: 300 },
				M_BE: { x: 820, y: 260 },
				E_API: { x: 1240, y: 340 },
				WB_BE: { x: 1240, y: 600 },
				SecAudit: { x: 1620, y: 260 },
			},
		});

		assert.ok(initialCode.includes('%% layout radial'));
		assert.ok(initialCode.includes('subgraph Backend["Backend Engineering"]'));
		assert.ok(initialCode.includes('subgraph SecAudit["Security Audit"]'));
		assert.ok(initialCode.includes('%% wb-body WB_BE'));
		assert.ok(initialCode.includes('%% | %% wb-end'));
		assert.ok(initialCode.includes('%% pos GOV [x=400, y=300]'));

		const parsed1 = mod.parseOrchestrationGraph(initialCode);
		assert.strictEqual(parsed1.error, undefined);
		assert.strictEqual(parsed1.layoutMode, 'radial');
		assert.strictEqual(parsed1.departments.length, 2, 'Empty subgraph SecAudit is preserved losslessly');
		assert.strictEqual(parsed1.departments.find(d => d.id === 'SecAudit')?.name, 'Security Audit');
		assert.strictEqual(parsed1.nodes.find(n => n.id === 'GOV')?.engineId, 'aexus-claude');
		assert.strictEqual(parsed1.nodes.find(n => n.id === 'GOV')?.model, 'claude-opus-4-6');
		assert.strictEqual(parsed1.nodes.find(n => n.id === 'GOV')?.thinking, 'high');
		assert.strictEqual(parsed1.nodes.find(n => n.id === 'M_BE')?.hostAlias, 'gpu-box-1');
		assert.strictEqual(parsed1.nodes.find(n => n.id === 'WB_BE')?.whiteboardVersion, 4);
		assert.strictEqual(parsed1.nodes.find(n => n.id === 'WB_BE')?.whiteboardContent, trickyMarkdown, 'Byte-for-byte lossless multiline whiteboard recovery');
		assert.strictEqual(parsed1.whiteboardContents?.WB_BE.content, trickyMarkdown);
		assert.deepStrictEqual(parsed1.positions?.SecAudit, { x: 1620, y: 260 });
		assert.strictEqual(parsed1.edges.find(e => e.from === 'M_BE' && e.to === 'E_API')?.label, 'build');
		assert.strictEqual(parsed1.edges.find(e => e.from === 'E_API' && e.to === 'M_BE')?.label, 'review', 'Asymmetric bidirectional edge labels preserved without folding loss');
		assert.strictEqual(parsed1.edges.find(e => e.from === 'E_API' && e.to === 'WB_BE')?.dashed, true);

		// Second round-trip MUST be strictly identical!
		const reserialized = mod.serializeOrchestrationGraph({
			direction: parsed1.direction,
			layoutMode: parsed1.layoutMode,
			nodes: parsed1.nodes,
			edges: parsed1.edges,
			departments: parsed1.departments,
			positions: parsed1.positions,
		});
		const parsed2 = mod.parseOrchestrationGraph(reserialized);
		assert.deepStrictEqual(parsed2, parsed1, 'Bijective round-trip invariant: parse(serialize(parse(text))) === parse(text)');

		// Group authoring mutators: add, rename, move node, remove (ungroup vs cascade)
		const addedGrp = mod.addOrchestrationGroup(initialCode, { name: 'Data Platform' });
		assert.strictEqual(addedGrp.ok, true);
		const renamedGrp = mod.renameOrchestrationGroup(addedGrp.orchestrationText!, 'Backend', 'Core Services');
		assert.strictEqual(renamedGrp.ok, true);
		const afterRename = mod.parseOrchestrationGraph(renamedGrp.orchestrationText!);
		assert.strictEqual(afterRename.departments.find(d => d.id === 'Backend')?.name, 'Core Services');
		assert.strictEqual(afterRename.nodes.find(n => n.id === 'M_BE')?.department, 'Core Services');
		assert.strictEqual(afterRename.nodes.find(n => n.id === 'WB_BE')?.department, 'Core Services');
		assert.strictEqual(afterRename.nodes.find(n => n.id === 'WB_BE')?.whiteboardContent, trickyMarkdown, 'Group rename preserves whiteboard markdown content losslessly');

		const movedNode = mod.moveOrchestrationNodeToGroup(renamedGrp.orchestrationText!, 'E_API', 'Data Platform');
		assert.strictEqual(movedNode.ok, true);
		const afterMove = mod.parseOrchestrationGraph(movedNode.orchestrationText!);
		assert.strictEqual(afterMove.nodes.find(n => n.id === 'E_API')?.department, 'Data Platform');
		assert.ok(afterMove.departments.find(d => d.name === 'Data Platform')?.nodeIds.includes('E_API'));

		const ungrouped = mod.removeOrchestrationGroup(movedNode.orchestrationText!, 'Data Platform', { deleteMembers: false });
		assert.strictEqual(ungrouped.ok, true);
		const afterUngroup = mod.parseOrchestrationGraph(ungrouped.orchestrationText!);
		assert.ok(afterUngroup.nodes.some(n => n.id === 'E_API'), 'Ungroup keeps member staff node');
		assert.strictEqual(afterUngroup.nodes.find(n => n.id === 'E_API')?.department, undefined);

		const deletedGroup = mod.removeOrchestrationGroup(ungrouped.orchestrationText!, 'Core Services', { deleteMembers: true });
		assert.strictEqual(deletedGroup.ok, true);
		const afterCascade = mod.parseOrchestrationGraph(deletedGroup.orchestrationText!);
		assert.strictEqual(afterCascade.nodes.some(n => n.id === 'M_BE'), false, 'Cascade group deletion removes member staff');
		assert.strictEqual(afterCascade.nodes.some(n => n.id === 'WB_BE'), false, 'Cascade group deletion removes member whiteboard');
		assert.strictEqual(deletedGroup.orchestrationText!.includes('wb-body WB_BE'), false, 'Cascade group deletion strips member whiteboard body');
	});

	test('Item 1: heterogeneous mint/split, strict downward minting, upward return along provenance, and join barrier convergence', () => {
		const parsed = parseOrchestrationGraph(CORPORATE_ORCHESTRATION_TEXT);
		assert.strictEqual(parsed.error, undefined);
		const staffIds = parsed.nodes.filter(n => n.kind === 'staff').map(n => n.id);
		const init = createInitialOrchestrationRuntimeState('eng-mint', staffIds, 1000);
		const d0 = dispatchRequirementToOrchestration(init, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Deliver full-stack billing v2',
			now: 1000,
		});
		assert.strictEqual(d0.ok, true);
		const ceoTokId = d0.data!.tokenId;

		// Sequential mint without waitJoin: CEO mints 1st heterogeneous token to BE_Lead while keeping ceoTokId active
		const m1 = mintOrchestrationTokens(d0.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: ceoTokId,
			branches: [
				{
					toNodeId: 'BE_Lead',
					summary: 'Build /v2/billing ledger endpoints',
					detail: 'BACKEND_DETAIL_UNIQUE_A: schema + idempotent API',
					taskNodeId: 'T_BE',
				},
			],
			now: 2000,
		});
		assert.strictEqual(m1.ok, true, `Expected sequential mint to succeed: ${m1.error}`);
		assert.strictEqual(m1.state.tokens[ceoTokId].status, 'active', 'Non-waitJoin mint leaves parent token active for further mints');
		assert.strictEqual(m1.data!.mintedTokenIds.length, 1);
		const beTok1 = m1.state.tokens[m1.data!.mintedTokenIds[0]];
		assert.strictEqual(beTok1.taskNodeId, 'T_BE');
		assert.strictEqual(beTok1.lastSummary, 'Build /v2/billing ledger endpoints');

		// Subordinate BE_Lead MUST NOT mint a new token upward to CEO!
		const badUpwardMint = mintOrchestrationTokens(m1.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: beTok1.id,
			branches: [{ toNodeId: 'CEO', summary: 'Trying to command CEO upward' }],
			now: 2100,
		});
		assert.strictEqual(badUpwardMint.ok, false);
		assert.strictEqual(badUpwardMint.code, 'UPWARD_MINT_FORBIDDEN');

		// Subordinate without downward provenance from CEO also cannot send unsolicited upward handoff!
		const unseededState = createInitialOrchestrationRuntimeState('eng-upward', staffIds, 1000);
		const directBe = dispatchRequirementToOrchestration(unseededState, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Direct task on BE_Lead',
			targetNodeId: 'BE_Lead',
			now: 1000,
		});
		const unsolicitedUp = handoffOrchestrationToken(directBe.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: directBe.data!.tokenId,
			toNodeIds: ['CEO'],
			summary: 'Unsolicited upward handoff without lineage from CEO',
			now: 1500,
		});
		assert.strictEqual(unsolicitedUp.ok, false);
		assert.strictEqual(unsolicitedUp.code, 'UPWARD_TOKEN_FORBIDDEN');

		// Now test heterogeneous 2-branch fan-out with waitJoin=true convergence barrier!
		const dJoin = dispatchRequirementToOrchestration(init, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Coordinated v2 release across Backend and Frontend',
			now: 3000,
		});
		const split = mintOrchestrationTokens(dJoin.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: dJoin.data!.tokenId,
			waitJoin: true,
			joinMode: 'all',
			branches: [
				{ toNodeId: 'BE_Lead', summary: 'Implement GraphQL mutations', detail: 'BE_SPEC_123', taskNodeId: 'T_BE' },
				{ toNodeId: 'FE_Lead', summary: 'Implement React checkout drawer', detail: 'FE_SPEC_456', taskNodeId: 'T_FE' },
			],
			now: 3500,
		});
		assert.strictEqual(split.ok, true, `Expected waitJoin mint to succeed: ${split.error}`);
		assert.ok(split.data!.joinBarrierId, 'waitJoin creates a join barrier');
		assert.strictEqual(split.state.tokens[dJoin.data!.tokenId].status, 'waiting_join');
		assert.strictEqual(split.state.nodeStates.CEO, 'waiting_join');
		assert.strictEqual(split.data!.mintedTokenIds.length, 2);

		const [childBeId, childFeId] = split.data!.mintedTokenIds;
		assert.notStrictEqual(split.state.tokens[childBeId].lastSummary, split.state.tokens[childFeId].lastSummary, 'Heterogeneous branches get distinct payloads');

		// 1st subordinate returns -> barrier NOT yet satisfied, CEO stays waiting_join
		const ret1 = returnOrchestrationToken(split.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: childBeId,
			summary: 'GraphQL mutations passing unit tests',
			artifacts: [{ title: 'BE Test Report', content: '42/42 passed' }],
			now: 4000,
		});
		assert.strictEqual(ret1.ok, true, `Expected BE return to succeed: ${ret1.error}`);
		assert.strictEqual(ret1.data!.barrierSatisfied, false);
		assert.strictEqual(ret1.state.nodeStates.CEO, 'waiting_join');
		assert.strictEqual(ret1.effects.filter(e => e.kind === 'dispatch_token' && e.nodeId === 'CEO').length, 0);

		// 2nd subordinate returns -> barrier SATISFIED! CEO wakes ONCE with consolidated results + pointers
		const ret2 = returnOrchestrationToken(ret1.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: childFeId,
			summary: 'Checkout drawer passing E2E tests',
			artifacts: [{ title: 'FE Build Log', content: 'bundle=84kb gz' }],
			now: 4500,
		});
		assert.strictEqual(ret2.ok, true, `Expected FE return to settle barrier: ${ret2.error}`);
		assert.strictEqual(ret2.data!.barrierSatisfied, true);
		assert.strictEqual(ret2.state.nodeStates.CEO, 'active');
		assert.strictEqual(ret2.state.tokens[dJoin.data!.tokenId].status, 'active');
		assert.strictEqual(ret2.effects.filter(e => e.kind === 'dispatch_token' && e.nodeId === 'CEO').length, 1);

		// Failing a branch also settles join barrier cleanly without deadlocking superior
		const splitFail = mintOrchestrationTokens(ret2.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: dJoin.data!.tokenId,
			waitJoin: true,
			branches: [{ toNodeId: 'BE_Lead', summary: 'Run migration smoke test' }],
			now: 5000,
		});
		assert.strictEqual(splitFail.ok, true);
		const failedBranch = failOrchestrationToken(splitFail.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: splitFail.data!.mintedTokenIds[0],
			reason: 'Staging DB connection refused',
			now: 5500,
		});
		assert.strictEqual(failedBranch.ok, true);
		assert.strictEqual(failedBranch.data!.barrierSatisfied, true);
		assert.strictEqual(failedBranch.state.nodeStates.CEO, 'active');
	});

	test('Item 2: enforces no-rank-skip & no-cross-department on dynamic staff create/remove plus in-flight token reclamation', () => {
		// No rank skip on create: L1 CEO cannot directly create L3 Employee (must create L2)
		const skipCreate = planDynamicSubordinateCreation(CORPORATE_ORCHESTRATION_TEXT, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			callerNodeId: 'CEO',
			callerTier: 1,
			name: 'Skippy',
			targetRankIdOrTier: 3,
		});
		assert.strictEqual(skipCreate.ok, false);
		assert.strictEqual(skipCreate.code, 'RANK_SKIP_FORBIDDEN');

		// No cross-department create: Backend L2 cannot create subordinate in Frontend Dept
		const crossDeptCreate = planDynamicSubordinateCreation(CORPORATE_ORCHESTRATION_TEXT, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			callerNodeId: 'BE_Lead',
			callerTier: 2,
			name: 'CrossGuy',
			targetRankIdOrTier: 3,
			department: 'Frontend Dept',
		});
		assert.strictEqual(crossDeptCreate.ok, false);
		assert.strictEqual(crossDeptCreate.code, 'CROSS_DEPARTMENT_FORBIDDEN');

		// Removal guards:
		// 1) Cross-department removal denied (BE_Lead cannot remove UI1 in Frontend Dept)
		const crossRemove = planDynamicSubordinateRemoval(CORPORATE_ORCHESTRATION_TEXT, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			callerNodeId: 'BE_Lead',
			callerTier: 2,
			targetNodeId: 'UI1',
		});
		assert.strictEqual(crossRemove.ok, false);
		assert.strictEqual(crossRemove.code, 'CROSS_DEPARTMENT_FORBIDDEN');

		// 2) Rank skip removal denied (CEO L1 cannot directly delete L3 Dev1)
		const skipRemove = planDynamicSubordinateRemoval(CORPORATE_ORCHESTRATION_TEXT, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			callerNodeId: 'CEO',
			callerTier: 1,
			targetNodeId: 'Dev1',
		});
		assert.strictEqual(skipRemove.ok, false);
		assert.strictEqual(skipRemove.code, 'RANK_SKIP_FORBIDDEN');

		// 3) Removing manager who still has active subordinates is blocked unless force=true
		const hasSubsRemove = planDynamicSubordinateRemoval(CORPORATE_ORCHESTRATION_TEXT, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			callerNodeId: 'CEO',
			callerTier: 1,
			targetNodeId: 'BE_Lead',
		});
		assert.strictEqual(hasSubsRemove.ok, false);
		assert.strictEqual(hasSubsRemove.code, 'HAS_ACTIVE_SUBORDINATES');

		// 4) Direct same-department subordinate removal succeeds cleanly (BE_Lead L2 removes Dev1 L3)
		const validRemove = planDynamicSubordinateRemoval(CORPORATE_ORCHESTRATION_TEXT, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			callerNodeId: 'BE_Lead',
			callerTier: 2,
			targetNodeId: 'Dev1',
		});
		assert.strictEqual(validRemove.ok, true, `Expected valid removal to succeed: ${validRemove.error}`);
		assert.strictEqual(validRemove.removedNode?.id, 'Dev1');
		const reparsedAfterRemove = parseOrchestrationGraph(validRemove.orchestrationText!);
		assert.strictEqual(reparsedAfterRemove.error, undefined);
		assert.strictEqual(reparsedAfterRemove.nodes.some(n => n.id === 'Dev1'), false);

		// 5) In-flight token reclamation bounces recovery baton & settles waiting join barrier!
		const parsedBefore = parseOrchestrationGraph(CORPORATE_ORCHESTRATION_TEXT);
		const staffIds = parsedBefore.nodes.filter(n => n.kind === 'staff').map(n => n.id);
		const init = createInitialOrchestrationRuntimeState('eng-reclaim', staffIds, 1000);
		const d0 = dispatchRequirementToOrchestration(init, parsedBefore, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Backend work',
			targetNodeId: 'BE_Lead',
			now: 1000,
		});
		const split = mintOrchestrationTokens(d0.state, parsedBefore, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: d0.data!.tokenId,
			waitJoin: true,
			branches: [{
				toNodeId: 'Dev1',
				summary: 'Implement endpoint',
				artifacts: [{ title: 'Draft Patch', content: 'diff --git a/api.ts' }],
			}],
			now: 2000,
		});
		assert.strictEqual(split.ok, true);
		assert.strictEqual(split.state.nodeStates.BE_Lead, 'waiting_join');

		const reclaimed = reclaimOrchestrationTokensForRemovedNode(split.state, reparsedAfterRemove, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			removedNodeId: 'Dev1',
			fallbackSupervisorNodeId: 'BE_Lead',
			reason: 'Downsized Dev1 mid-flight',
			now: 3000,
		});
		assert.strictEqual(reclaimed.ok, true);
		assert.strictEqual(reclaimed.data!.reclaimedTokenIds.length, 1);
		assert.strictEqual(reclaimed.state.tokens[split.data!.mintedTokenIds[0]].status, 'reclaimed');
		assert.strictEqual(reclaimed.data!.settledBarrierIds.length, 1, 'Waiting join barrier must settle when removed worker token is reclaimed');
		assert.strictEqual(reclaimed.state.nodeStates.BE_Lead, 'active', 'Superior BE_Lead wakes up with reclaimed context');
		assert.strictEqual(reclaimed.state.nodeStates.Dev1, undefined, 'Removed node purged from nodeStates');
	});

	test('Item 3: Mission Task DAG dependency blocking, per-node completion RBAC, and live Orchestration -> Task status sync', () => {
		const taskDagText = [
			'flowchart LR',
			'  T1["Schema Design"] --> T2["Backend API"]',
			'  T2 --> T3["Release Sign-off"]',
			'  %% task T1 [owner=BE_Lead, dept="Backend Dept", minTier=2]',
			'  %% task T2 [owner=BE_Lead, dept="Backend Dept", completers="BE_Lead,QA1"]',
			'  %% task T3 [minTier=1]',
		].join('\n');
		const taskDag = parseMissionMermaidDag(taskDagText);
		assert.strictEqual(taskDag.error, undefined);
		assert.strictEqual(taskDag.nodes.find(n => n.id === 'T1')?.ownerNodeId, 'BE_Lead');
		assert.strictEqual(taskDag.nodes.find(n => n.id === 'T1')?.minCompleterTier, 2);
		assert.deepStrictEqual(taskDag.nodes.find(n => n.id === 'T2')?.allowedCompleterNodeIds, ['BE_Lead', 'QA1']);

		// Dependency gate: cannot mark T2 completed while upstream T1 is still pending!
		const blockedDep = updateMissionTaskNodeStatus({}, taskDag, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			nodeId: 'T2',
			status: 'completed',
			caller: { callerNodeId: 'BE_Lead', callerTier: 2, callerLabel: 'BE_Lead' },
		});
		assert.strictEqual(blockedDep.ok, false);
		assert.strictEqual(blockedDep.code, 'INCOMPLETE_DEPENDENCIES');

		// Owner BE_Lead (L2) CAN complete T1 (per-node minTier=2 + owner=BE_Lead)
		const doneT1 = updateMissionTaskNodeStatus({}, taskDag, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			nodeId: 'T1',
			status: 'completed',
			caller: { callerNodeId: 'BE_Lead', callerTier: 2, callerLabel: 'Backend Lead @Bob' },
			now: 1000,
		});
		assert.strictEqual(doneT1.ok, true);

		// Unlisted L3 engineer Dev1 CANNOT complete T2, but listed completer QA1 CAN now that T1 is done!
		const deniedDev1 = updateMissionTaskNodeStatus(doneT1.taskStatuses, taskDag, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			nodeId: 'T2',
			status: 'completed',
			caller: { callerNodeId: 'Dev1', callerTier: 3, callerLabel: 'Dev1' },
		});
		assert.strictEqual(deniedDev1.ok, false);
		assert.strictEqual(deniedDev1.code, 'FORBIDDEN');

		const okQa1 = updateMissionTaskNodeStatus(doneT1.taskStatuses, taskDag, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			nodeId: 'T2',
			status: 'completed',
			caller: { callerNodeId: 'QA1', callerTier: 3, callerLabel: 'QA1' },
			now: 2000,
		});
		assert.strictEqual(okQa1.ok, true);

		// Human force override bypasses incomplete dependency gate on T3 when needed
		const forceHuman = updateMissionTaskNodeStatus({}, taskDag, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			nodeId: 'T3',
			status: 'completed',
			force: true,
			caller: { isHumanUser: true, callerLabel: 'Human' },
			now: 3000,
		});
		assert.strictEqual(forceHuman.ok, true);

		// Live bidirectional sync: active token bound to T2 updates Task DAG card state, assignee, active tokens & artifacts (NEVER auto-completes!)
		const orchGraph = parseOrchestrationGraph(CORPORATE_ORCHESTRATION_TEXT);
		const staffIds = orchGraph.nodes.filter(n => n.kind === 'staff').map(n => n.id);
		const initOrch = createInitialOrchestrationRuntimeState('eng-sync', staffIds, 1000);
		const disp = dispatchRequirementToOrchestration(initOrch, orchGraph, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Work on Backend API',
			targetNodeId: 'BE_Lead',
			taskNodeId: 'T2',
			artifacts: [{ title: 'OpenAPI YAML', content: 'openapi: 3.1.0' }],
			now: 1000,
		});
		assert.strictEqual(disp.ok, true);
		const synced1 = syncMissionTaskStatusesFromOrchestration(doneT1.taskStatuses, taskDag, disp.state, orchGraph, 2500).taskStatuses;
		assert.strictEqual(synced1.T2.status, 'in_progress');
		assert.strictEqual(synced1.T2.assigneeNodeId, 'BE_Lead');
		assert.deepStrictEqual(synced1.T2.activeTokenIds, [disp.data!.tokenId]);
		assert.ok((synced1.T2.artifactPtrs?.length ?? 0) >= 1);
		assert.strictEqual(synced1.T1.status, 'completed', 'Already completed task stays completed');

		// Even after token finishes, sync NEVER auto-marks T2 completed (superior must still verify & sign off!)
		const finished = completeOrchestrationToken(disp.state, orchGraph, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: disp.data!.tokenId,
			summary: 'Done coding',
			finish: true,
			now: 5000,
		});
		const synced2 = syncMissionTaskStatusesFromOrchestration(synced1, taskDag, finished.state, orchGraph, 5000).taskStatuses;
		assert.notStrictEqual(synced2.T2.status, 'completed', 'Sync must never auto-complete a Mission task');
		assert.strictEqual(synced2.T2.activeTokenIds?.length ?? 0, 0);
	});

	test('Item 5: structured orchestration manifest validate/compile/export round-trip, rolePrompt/allowedPaths/checks & pre-launch meta editing', () => {
		const manifest: IAdeOrchestrationManifest = {
			schemaVersion: 1,
			name: 'Payments Platform',
			direction: 'LR',
			layoutMode: 'lr',
			departments: [{ id: 'Backend', name: 'Backend' }],
			staff: [
				{
					id: 'CEO',
					name: 'Alice',
					roleLabel: 'CTO',
					tier: 1,
					rankId: 'governor',
					engineId: 'aexus-claude',
					model: 'claude-opus-4-6',
					thinking: 'high',
					hostAlias: 'local',
					rolePrompt: 'Own architecture and approve final Mission tasks.',
				},
				{
					id: 'Dev1',
					name: 'Dave',
					roleLabel: 'API Engineer',
					tier: 2,
					rankId: 'manager',
					department: 'Backend',
					engineId: 'aexus-codex',
					model: 'gpt-5.4',
					thinking: 'medium',
					hostAlias: 'gpu-1',
					rolePrompt: 'Implement typed REST handlers only.',
					allowedPaths: ['src/api/**', 'test/api/**'],
					checks: [{ id: 'chk-test', name: 'Unit tests', command: 'npm test', timeoutMs: 120_000 }],
				},
			],
			whiteboards: [{ id: 'WB_API', title: 'API Spec', department: 'Backend', content: '# OpenAPI' }],
			edges: [{ from: 'CEO', to: 'Dev1', label: 'delegate', bidirectional: true }],
			tasks: {
				direction: 'LR',
				nodes: [
					{ id: 'T1', title: 'Design API', ownerNodeId: 'CEO', minCompleterTier: 1, description: 'Draft endpoints' },
					{ id: 'T2', title: 'Implement API', ownerNodeId: 'Dev1', department: 'Backend', minCompleterTier: 2 },
				],
				edges: [{ from: 'T1', to: 'T2' }],
			},
		};

		const validation = validateOrchestrationManifest(manifest);
		assert.strictEqual(validation.valid, true, `Expected manifest valid: ${validation.errors.join('; ')}`);

		const compiled = compileOrchestrationManifest(manifest);
		assert.ok(compiled.orchestrationText && compiled.mermaidText);

		const parsedOrch = parseOrchestrationGraph(compiled.orchestrationText);
		assert.strictEqual(parsedOrch.error, undefined);
		const devNode = parsedOrch.nodes.find(n => n.id === 'Dev1')!;
		assert.strictEqual(devNode.rolePrompt, 'Implement typed REST handlers only.');
		assert.deepStrictEqual(devNode.allowedPaths, ['src/api/**', 'test/api/**']);
		assert.strictEqual(devNode.checks?.length, 1);
		assert.strictEqual(devNode.checks![0].command, 'npm test');

		// Pre-launch metadata editor updates engine/model/thinking/host in code losslessly
		const updatedRes = upsertOrchestrationStaffMetaInCode(compiled.orchestrationText, 'Dev1', {
			engineId: 'aexus-claude',
			model: 'claude-sonnet-4-6',
			thinking: 'high',
			hostAlias: 'local',
		});
		assert.strictEqual(updatedRes.ok, true);
		const updatedCode = updatedRes.orchestrationText!;
		const reparsed = parseOrchestrationGraph(updatedCode);
		assert.strictEqual(reparsed.error, undefined);
		assert.strictEqual(reparsed.nodes.find(n => n.id === 'Dev1')?.engineId, 'aexus-claude');
		assert.strictEqual(reparsed.nodes.find(n => n.id === 'Dev1')?.model, 'claude-sonnet-4-6');
		assert.strictEqual(reparsed.nodes.find(n => n.id === 'Dev1')?.thinking, 'high');
		assert.strictEqual(reparsed.nodes.find(n => n.id === 'Dev1')?.hostAlias, 'local');

		// Export back to structured JSON manifest preserves staff config + checks + tasks
		const exported = exportToOrchestrationManifest({
			name: 'Payments Platform',
			orchestrationText: updatedCode,
			mermaidText: compiled.mermaidText,
			nodePrompts: compiled.nodePrompts,
		});
		assert.strictEqual(exported.schemaVersion, 1);
		assert.strictEqual(exported.staff.find(s => s.id === 'Dev1')?.engineId, 'aexus-claude');
		assert.deepStrictEqual(exported.staff.find(s => s.id === 'Dev1')?.allowedPaths, ['src/api/**', 'test/api/**']);
		assert.strictEqual(exported.tasks?.nodes.length, 2);

		// Wakeup prompt renders rolePrompt, allowedPaths, and checks directly (no legacy pre-prompts)
		const tokInit = createInitialOrchestrationRuntimeState('eng-cfg', ['CEO', 'Dev1'], 1000);
		const d = dispatchRequirementToOrchestration(tokInit, reparsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Implement /v2/charge',
			targetNodeId: 'Dev1',
			taskNodeId: 'T2',
			now: 1000,
		});
		const wake = composeOrchestrationTokenWakeupPrompt('eng-cfg', reparsed.nodes.find(n => n.id === 'Dev1')!, d.state.tokens[d.data!.tokenId], ['CEO'], false);
		assert.ok(wake.includes('Implement typed REST handlers only.'));
		assert.ok(wake.includes('src/api/**'));
		assert.ok(wake.includes('npm test'));
		assert.ok(wake.includes('T2'));
	});

	test('Items 8 & 9: pause/resume/abort controls and cold blob externalization + archive compaction', () => {
		const parsed = parseOrchestrationGraph(CORPORATE_ORCHESTRATION_TEXT);
		const staffIds = parsed.nodes.filter(n => n.kind === 'staff').map(n => n.id);
		const init = createInitialOrchestrationRuntimeState('eng-ctrl', staffIds, 1000);
		const d0 = dispatchRequirementToOrchestration(init, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Run batch job',
			artifacts: [{ title: 'Big Dump', content: 'X'.repeat(4000) }],
			now: 1000,
		});
		assert.strictEqual(d0.ok, true);

		// Pause blocks new handoffs; resume re-enables
		const paused = pauseOrchestration(d0.state, { reason: 'Maintenance pause', now: 1500 });
		assert.strictEqual(paused.ok, true);
		assert.strictEqual(paused.state.status, 'paused');
		const blockedHandoff = handoffOrchestrationToken(paused.state, parsed, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: d0.data!.tokenId,
			toNodeIds: ['BE_Lead'],
			summary: 'Should wait while paused',
			now: 1600,
		});
		assert.strictEqual(blockedHandoff.ok, false);
		assert.strictEqual(blockedHandoff.code, 'PAUSED');

		const resumed = resumeOrchestration(paused.state, { now: 1700 });
		assert.strictEqual(resumed.ok, true);
		assert.strictEqual(resumed.state.status, 'running');

		// Abort terminates all active tokens cleanly
		const aborted = abortOrchestrationTokens(resumed.state, { reason: 'Emergency stop', now: 1800 });
		assert.strictEqual(aborted.ok, true);
		assert.deepStrictEqual(aborted.data!.abortedTokenIds, [d0.data!.tokenId]);
		assert.strictEqual(aborted.state.tokens[d0.data!.tokenId].status, 'aborted');
		assert.strictEqual(aborted.state.nodeStates.CEO, 'idle');

		// State compaction externalizes large cold payload blobs & archives excess terminal tokens!
		const compacted = compactOrchestrationRuntimeState(aborted.state, {
			hotBlobMaxChars: 1024,
			maxHotTerminalTokens: 0,
			maxHotTraces: 0,
		});
		assert.strictEqual(compacted.didCompact, true);
		assert.ok(compacted.blobsToExternalize.length >= 1, 'Large cold blob must be extracted for disk storage');
		assert.ok(compacted.archiveEntries.some(e => e.kind === 'token'), 'Excess terminal token moved to cold archive');
		assert.strictEqual(Object.keys(compacted.compactedState.tokens).length, 0);
		assert.strictEqual(compacted.compactedState.archivedTokenCount, 1);

		const extPtr = compacted.blobsToExternalize[0].ptr;
		assert.strictEqual(compacted.compactedState.payloadStore?.[extPtr], undefined, 'Externalized blob removed from hot JSON payloadStore');
		assert.ok(compacted.compactedState.externalizedBlobIndex?.[extPtr], 'Metadata index kept for externalized blob');

		// Synchronous pointer read flags externalized=true so async runtime/daemon hydrates from .blobs/
		const syncRead = readOrchestrationTokenPointers(compacted.compactedState, {}, parsed, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			ptrs: [extPtr],
			caller: { isHumanUser: true },
		});
		assert.strictEqual(syncRead.items[0].externalized, true);
	});

	test('hardens whiteboard attachments, optimistic concurrency, pause guards, task validation, self/rank-only hierarchy, and orphan re-parenting', () => {
		const parsed = parseOrchestrationGraph(CORPORATE_ORCHESTRATION_TEXT);
		assert.strictEqual(parsed.error, undefined);

		// W2: Strict create vs write separation + optimistic concurrency (--expected-version)
		const c1 = mutateDepartmentWhiteboard({}, {
			id: 'WB_BE',
			department: 'Backend Dept',
			title: 'Backend Spec',
			content: 'v1 spec',
			mode: 'create',
			updatedBy: 'BE_Lead',
			updatedByLabel: 'Bob',
			now: 1000,
		});
		assert.strictEqual(c1.ok, true);
		assert.strictEqual(c1.whiteboard?.version, 1);

		const dupCreate = mutateDepartmentWhiteboard(c1.whiteboards, {
			id: 'WB_BE',
			department: 'Backend Dept',
			title: 'Duplicate',
			content: 'overwrite attempt',
			mode: 'create',
			now: 1100,
		});
		assert.strictEqual(dupCreate.ok, false);
		assert.strictEqual(dupCreate.code, 'ALREADY_EXISTS');

		const staleWrite = mutateDepartmentWhiteboard(c1.whiteboards, {
			id: 'WB_BE',
			content: 'stale write',
			mode: 'write',
			expectedVersion: 0,
			now: 1200,
		});
		assert.strictEqual(staleWrite.ok, false);
		assert.strictEqual(staleWrite.code, 'VERSION_CONFLICT');
		assert.strictEqual(staleWrite.currentVersion, 1);

		const okWrite = mutateDepartmentWhiteboard(c1.whiteboards, {
			id: 'WB_BE',
			content: 'v2 spec',
			mode: 'write',
			expectedVersion: 1,
			now: 1300,
		});
		assert.strictEqual(okWrite.ok, true);
		assert.strictEqual(okWrite.whiteboard?.version, 2);

		const withFeWb = mutateDepartmentWhiteboard(okWrite.whiteboards, {
			id: 'WB_FE',
			department: 'Frontend Dept',
			title: 'Frontend Spec',
			content: 'fe secret',
			mode: 'create',
			now: 1350,
		});
		assert.strictEqual(withFeWb.ok, true);
		const whiteboards = withFeWb.whiteboards!;

		// W1: Token whiteboard attachment validation rejects nonexistent IDs, inline text pasted as ID, and foreign-department whiteboards
		const staffIds = parsed.nodes.filter(n => n.kind === 'staff').map(n => n.id);
		const init = createInitialOrchestrationRuntimeState('eng-hardened', staffIds, 2000);
		const badWbMissing = dispatchRequirementToOrchestration(init, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Kickoff',
			whiteboardIds: ['WB_DOES_NOT_EXIST'],
			now: 2000,
		});
		assert.strictEqual(badWbMissing.ok, false);
		assert.strictEqual(badWbMissing.code, 'NOT_FOUND');

		const badWbInline = dispatchRequirementToOrchestration(init, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Kickoff',
			whiteboardIds: ['# Full Spec\nLine 1\nLine 2\nDo not inline bodies here!'],
			now: 2000,
		});
		assert.strictEqual(badWbInline.ok, false);
		assert.strictEqual(badWbInline.code, 'INVALID_STATE');
		assert.match(badWbInline.error ?? '', /INVALID_WHITEBOARD_POINTER/i);

		// T2: Task DAG binding validation rejects nonexistent tasks and already-completed tasks
		const taskGraph = parseMissionMermaidDag('flowchart LR\n  T1["Spec"] --> T2["Build"]');
		const taskStatuses = {
			T1: { status: 'completed' as const, updatedAt: 1500 },
		};
		const badTaskMissing = dispatchRequirementToOrchestration(init, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Kickoff',
			taskNodeId: 'T999',
			taskGraph,
			taskStatuses,
			now: 2000,
		});
		assert.strictEqual(badTaskMissing.ok, false);
		assert.strictEqual(badTaskMissing.code, 'NOT_FOUND');

		const badTaskCompleted = dispatchRequirementToOrchestration(init, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Kickoff',
			taskNodeId: 'T1',
			taskGraph,
			taskStatuses,
			now: 2000,
		});
		assert.strictEqual(badTaskCompleted.ok, false);
		assert.strictEqual(badTaskCompleted.code, 'INVALID_STATE');

		// Valid dispatch to CEO with valid T2 and WB_BE
		const d0 = dispatchRequirementToOrchestration(init, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Deliver API v2',
			taskNodeId: 'T2',
			taskGraph,
			taskStatuses,
			whiteboardIds: ['WB_BE'],
			now: 2000,
		});
		assert.strictEqual(d0.ok, true);

		// W4: Pruning removed whiteboard clears live tokens cleanly
		const prunedRes = pruneRemovedWhiteboardFromState(d0.state, 'WB_BE', 2050);
		assert.deepStrictEqual(prunedRes.prunedTokenIds, [d0.data!.tokenId]);
		assert.strictEqual(prunedRes.state.tokens[d0.data!.tokenId].whiteboardPointers, undefined);
		assert.ok(!(prunedRes.state.tokens[d0.data!.tokenId].contextRefs ?? []).some(r => r.ptr === 'wb:WB_BE'));

		// T3: Self-mint and self-handoff are rejected with INVALID_STATE
		const selfMint = mintOrchestrationTokens(d0.state, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: d0.data!.tokenId,
			branches: [{ toNodeId: 'CEO', summary: 'Loop to self' }],
			now: 2100,
		});
		assert.strictEqual(selfMint.ok, false);
		assert.strictEqual(selfMint.code, 'INVALID_STATE');

		const selfHandoff = handoffOrchestrationToken(d0.state, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: d0.data!.tokenId,
			toNodeIds: ['CEO'],
			summary: 'Self handoff',
			now: 2100,
		});
		assert.strictEqual(selfHandoff.ok, false);
		assert.strictEqual(selfHandoff.code, 'INVALID_STATE');

		// Mint downward CEO -> BE_Lead (waitJoin), then BE_Lead tries attaching foreign Frontend whiteboard WB_FE -> FORBIDDEN!
		const m1 = mintOrchestrationTokens(d0.state, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: d0.data!.tokenId,
			branches: [{ toNodeId: 'BE_Lead', summary: 'Own backend work', taskNodeId: 'T2', whiteboardIds: ['WB_BE'] }],
			waitJoin: true,
			taskGraph,
			taskStatuses,
			now: 2200,
		});
		assert.strictEqual(m1.ok, true);
		const leadTokId = m1.data!.mintedTokenIds[0];

		const crossDeptAttach = validateTokenWhiteboardAttachments(parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, { callerNodeId: 'BE_Lead', callerTier: 2 }, ['WB_FE']);
		assert.strictEqual(crossDeptAttach.ok, false);
		assert.strictEqual(crossDeptAttach.code, 'FORBIDDEN');

		const m2BadWb = mintOrchestrationTokens(m1.state, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: leadTokId,
			branches: [{ toNodeId: 'Dev1', summary: 'Should block foreign wb', whiteboardIds: ['WB_FE'] }],
			now: 2300,
		});
		assert.strictEqual(m2BadWb.ok, false);
		assert.strictEqual(m2BadWb.code, 'FORBIDDEN');

		// BE_Lead legitimately mints child token to Dev1 with waitJoin=true
		const m2 = mintOrchestrationTokens(m1.state, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: leadTokId,
			branches: [{ toNodeId: 'Dev1', summary: 'Build handler', taskNodeId: 'T2', whiteboardIds: ['WB_BE'] }],
			waitJoin: true,
			taskGraph,
			taskStatuses,
			now: 2400,
		});
		assert.strictEqual(m2.ok, true);
		const devTokId = m2.data!.mintedTokenIds[0];
		assert.strictEqual(m2.state.tokens[devTokId].returnToNodeId, 'BE_Lead');

		// T1: Pause blocks return, complete, AND fail!
		const paused = pauseOrchestration(m2.state, { reason: 'Freeze wave', now: 2500 });
		assert.strictEqual(returnOrchestrationToken(paused.state, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: devTokId,
			summary: 'Try return while paused',
			now: 2550,
		}).code, 'PAUSED');
		assert.strictEqual(completeOrchestrationToken(paused.state, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: devTokId,
			summary: 'Try complete while paused',
			finish: true,
			now: 2550,
		}).code, 'PAUSED');
		assert.strictEqual(failOrchestrationToken(paused.state, parsed, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: devTokId,
			reason: 'Try fail while paused',
			now: 2550,
		}).code, 'PAUSED');

		// S2: Force-removing mid-tier BE_Lead (by Human --force) re-parents surviving Dev1 child token cleanly to CEO!
		const remPlan = planDynamicSubordinateRemoval(CORPORATE_ORCHESTRATION_TEXT, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			targetNodeId: 'BE_Lead',
			callerNodeId: 'CEO',
			isHumanUser: true,
			force: true,
		});
		assert.strictEqual(remPlan.ok, true);
		const graphAfter = parseOrchestrationGraph(remPlan.orchestrationText!);
		const reclaimed = reclaimOrchestrationTokensForRemovedNode(m2.state, graphAfter, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			removedNodeId: 'BE_Lead',
			reclaimedBy: 'CEO',
			fallbackSupervisorNodeId: 'CEO',
			reason: 'Reorg',
			now: 2600,
		});
		assert.strictEqual(reclaimed.ok, true);
		assert.ok(reclaimed.data!.reclaimedTokenIds.includes(leadTokId));
		assert.ok(reclaimed.data!.reparentedTokenIds.includes(devTokId), 'Surviving child token held by Dev1 must be re-parented');
		const reparentedDevTok = reclaimed.state.tokens[devTokId];
		assert.strictEqual(reparentedDevTok.returnToNodeId, 'CEO');
		assert.strictEqual(reparentedDevTok.parentJoinBarrierId, undefined, 'Dead barrier owned by removed manager is detached');

		// Dev1 can now seamlessly return its re-parented token directly to CEO without orphan error!
		const devReturn = returnOrchestrationToken(reclaimed.state, graphAfter, whiteboards, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: devTokId,
			summary: 'Handler built; returning to surviving CEO',
			now: 2700,
		});
		assert.strictEqual(devReturn.ok, true, `Expected re-parented return to succeed, got: ${devReturn.error}`);
		assert.strictEqual(devReturn.data!.returnedToNodeId, 'CEO');

		// T3: rankId-only node (no explicit tier) still resolves effective tier and enforces anti-upward mint rules
		const rankOnlyGraph = parseOrchestrationGraph([
			'flowchart LR',
			'  Boss["@Alice"] <--> Worker["@Dave"]',
			'  %% staff Boss [rank=governor, name="Alice"]',
			'  %% staff Worker [rank=worker, name="Dave"]',
		].join('\n'));
		assert.strictEqual(resolveEffectiveStaffTier(rankOnlyGraph.nodes.find(n => n.id === 'Boss'), DEFAULT_ADE_ORGANIZATION_CONFIG), 1);
		assert.strictEqual(resolveEffectiveStaffTier(rankOnlyGraph.nodes.find(n => n.id === 'Worker'), DEFAULT_ADE_ORGANIZATION_CONFIG), 4);
		const rankState0 = createInitialOrchestrationRuntimeState('eng-rank', ['Boss', 'Worker'], 3000);
		const rankDisp = dispatchRequirementToOrchestration(rankState0, rankOnlyGraph, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			prompt: 'Test rank-only node',
			targetNodeId: 'Worker',
			now: 3000,
		});
		assert.strictEqual(rankDisp.ok, true);
		const workerMintUp = mintOrchestrationTokens(rankDisp.state, rankOnlyGraph, {}, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: rankDisp.data!.tokenId,
			branches: [{ toNodeId: 'Boss', summary: 'Illegal upward mint' }],
			now: 3100,
		});
		assert.strictEqual(workerMintUp.ok, false);
		assert.strictEqual(workerMintUp.code, 'UPWARD_MINT_FORBIDDEN');
	});

	test('per-node custom accent color: normalization, lossless Staff/Whiteboard/Task code roundtrip, manifest preserve & 4-wing radial symmetry', () => {
		// 1. Color normalization & hex resolution
		assert.strictEqual(normalizeAdeNodeColor('Gold'), 'gold');
		assert.strictEqual(normalizeAdeNodeColor('purple'), 'violet');
		assert.strictEqual(normalizeAdeNodeColor('#F0A'), '#ff00aa');
		assert.strictEqual(normalizeAdeNodeColor('default'), undefined);
		assert.strictEqual(resolveAdeNodeColorHex('cyan'), '#22d3ee');
		assert.strictEqual(resolveAdeNodeColorHex('#12ab34'), '#12ab34');

		// 2. Staff & Whiteboard color mutation + lossless parse/serialize roundtrip
		let orchText = [
			'flowchart TD',
			'  %% layout radial',
			'  CEO["@Aria (L1)"] <--> AI["@Nova (L2)"]',
			'  subgraph AI_Kernel["AI Kernel"]',
			'    AI["@Nova (L2)"] <--> RAG["@Vex (L3)"]',
			'    WB_AI[("Whiteboard: AI Spec")]',
			'    %% whiteboard WB_AI [dept="AI Kernel", title="AI Spec", version=2]',
			'  end',
		].join('\n');

		const r1 = upsertOrchestrationNodeColorInCode(orchText, 'CEO', 'gold');
		assert.strictEqual(r1.ok, true);
		orchText = r1.orchestrationText!;
		const r2 = upsertOrchestrationNodeColorInCode(orchText, 'WB_AI', '#22d3ee');
		assert.strictEqual(r2.ok, true);
		orchText = r2.orchestrationText!;
		const parsedOrch = parseOrchestrationGraph(orchText);
		assert.strictEqual(parsedOrch.nodes.find(n => n.id === 'CEO')?.color, 'gold');
		assert.strictEqual(parsedOrch.nodes.find(n => n.id === 'WB_AI')?.color, '#22d3ee');

		// Clearing color removes custom accent cleanly
		const r3 = upsertOrchestrationNodeColorInCode(orchText, 'CEO', null);
		assert.strictEqual(r3.ok, true);
		assert.strictEqual(parseOrchestrationGraph(r3.orchestrationText!).nodes.find(n => n.id === 'CEO')?.color, undefined);

		// 3. Mission Task DAG color mutation + parse roundtrip
		const dag0 = 'flowchart LR\n  T1["Spec"] --> T2["Build"]';
		const dag1 = upsertTaskMetadataInMermaid(dag0, 'T1', { ownerNodeId: 'CEO', color: 'rose' });
		assert.strictEqual(parseMissionMermaidDag(dag1).nodes.find(n => n.id === 'T1')?.color, 'rose');
		const dag2 = upsertTaskMetadataInMermaid(dag1, 'T1', { color: null });
		assert.strictEqual(parseMissionMermaidDag(dag2).nodes.find(n => n.id === 'T1')?.color, undefined);
		assert.strictEqual(parseMissionMermaidDag(dag2).nodes.find(n => n.id === 'T1')?.ownerNodeId, 'CEO');

		// 4. Structured Manifest validate -> compile -> export roundtrip preserves Staff, Whiteboard & Task colors
		const manifest: IAdeOrchestrationManifest = {
			schemaVersion: 1,
			layoutMode: 'radial',
			staff: [
				{ id: 'CEO', name: 'Aria', tier: 1, color: 'gold' },
				{ id: 'AI', name: 'Nova', tier: 2, department: 'AI', color: 'cyan' },
				{ id: 'BE', name: 'Orion', tier: 2, department: 'BE', color: 'indigo' },
				{ id: 'FE', name: 'Mina', tier: 2, department: 'FE', color: 'rose' },
				{ id: 'SEC', name: 'Atlas', tier: 2, department: 'SEC', color: 'emerald' },
			],
			whiteboards: [{ id: 'WB_AI', title: 'AI Spec', department: 'AI', content: 'v1', color: 'cyan' }],
			edges: [
				{ from: 'CEO', to: 'AI', bidirectional: true },
				{ from: 'CEO', to: 'BE', bidirectional: true },
				{ from: 'CEO', to: 'FE', bidirectional: true },
				{ from: 'CEO', to: 'SEC', bidirectional: true },
			],
			tasks: {
				direction: 'LR',
				nodes: [{ id: 'T1', title: 'Launch', ownerNodeId: 'CEO', color: 'gold' }],
			},
		};
		const val = validateOrchestrationManifest(manifest);
		assert.strictEqual(val.valid, true, `Manifest errors: ${val.errors.join('; ')}`);
		const compiled = compileOrchestrationManifest(val.manifest!);
		const exported = exportToOrchestrationManifest({
			orchestrationText: compiled.orchestrationText,
			whiteboards: compiled.whiteboards,
			mermaidText: compiled.mermaidText,
		});
		assert.strictEqual(exported.staff.find(s => s.id === 'CEO')?.color, 'gold');
		assert.strictEqual(exported.whiteboards?.find(w => w.id === 'WB_AI')?.color, 'cyan');
		assert.strictEqual(exported.tasks?.nodes.find(t => t.id === 'T1')?.color, 'gold');

		// Radial layout places L1 CEO centered between West (SEC) and East (BE), and between North (AI) and South (FE)
		const pos = computeOrchestrationAutoLayout(compiled.parsedOrchestration, { layoutMode: 'radial' });
		const ceoP = pos.get('CEO')!;
		assert.ok(pos.get('AI')!.y < ceoP.y, 'North wing sits above CEO');
		assert.ok(pos.get('FE')!.y > ceoP.y, 'South wing sits below CEO');
		assert.ok(pos.get('BE')!.x > ceoP.x, 'East wing sits right of CEO');
		assert.ok(pos.get('SEC')!.x < ceoP.x, 'West wing sits left of CEO');
	});

	test('root token mint/split directly from L1 without pre-existing parentTokenId, allowedPaths enforcement, failure bounce & final Inbox delivery', () => {
		const orchCode = [
			'flowchart TD',
			'  CEO["@Alice · Governor (L1)"] <--> BE_Lead["@Bob · Backend Lead (L2)"]',
			'  CEO <--> FE_Lead["@Carol · Frontend Lead (L2)"]',
			'  subgraph Backend["Backend"]',
			'    BE_Lead <--> BE_Dev["@Dave · Worker (L4)"]',
			'    %% staff BE_Dev [tier=4, dept="Backend", paths="src/backend|tests/backend"]',
			'  end',
			'  subgraph Frontend["Frontend"]',
			'    FE_Lead',
			'  end',
		].join('\n');
		const graph = parseOrchestrationGraph(orchCode);
		assert.strictEqual(graph.error, undefined);
		let state = createInitialOrchestrationRuntimeState('m-root-mint', ['CEO', 'BE_Lead', 'FE_Lead', 'BE_Dev']);
		state = {
			...state,
			nodeAgentIds: {
				CEO: 'agent-ceo',
				BE_Lead: 'agent-be-lead',
				FE_Lead: 'agent-fe-lead',
				BE_Dev: 'agent-be-dev',
			},
		};

		// 1. Leaf L4 worker CANNOT originate root tokens
		const leafTry = mintOrchestrationTokens(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			branches: [{ toNodeId: 'BE_Lead', summary: 'Illegal upward mint' }],
			callerAgentId: 'agent-be-dev',
		});
		assert.strictEqual(leafTry.ok, false);
		assert.strictEqual(leafTry.code, 'UPWARD_MINT_FORBIDDEN');

		// 2. L1 Governor immediately splits work after a User Chat message WITHOUT pre-existing parentTokenId!
		const rootSplit = mintOrchestrationTokens(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			branches: [
				{ toNodeId: 'BE_Lead', summary: 'Implement auth API', detail: 'Add JWT + refresh token endpoints' },
				{ toNodeId: 'FE_Lead', summary: 'Build login UI', detail: 'Create modal + session state' },
			],
			waitJoin: true,
			callerAgentId: 'agent-ceo',
		});
		assert.strictEqual(rootSplit.ok, true, rootSplit.error);
		assert.strictEqual(rootSplit.data?.createdRootParent, true);
		assert.strictEqual(rootSplit.data?.mintedTokenIds.length, 2);
		assert.ok(rootSplit.data?.joinBarrierId, 'waitJoin creates a convergence barrier on synthesized root parent');
		assert.strictEqual(rootSplit.effects.length, 2, 'must dispatch ONLY to child targets — ZERO duplicate self-dispatch to L1 CEO!');
		assert.ok(rootSplit.effects.every(e => e.kind === 'dispatch_token' && e.nodeId !== 'CEO'));
		state = rootSplit.state;
		const rootTokId = rootSplit.data!.parentTokenId;
		const beLeadTokId = rootSplit.data!.branches.find(b => b.toNodeId === 'BE_Lead')!.tokenId;
		const feLeadTokId = rootSplit.data!.branches.find(b => b.toNodeId === 'FE_Lead')!.tokenId;
		assert.strictEqual(state.tokens[rootTokId].status, 'waiting_join');

		// 3. BE_Lead delegates downward to BE_Dev (non-barrier) -> BE_Dev tests allowedPaths guardrail + failure bounce
		const devMint = mintOrchestrationTokens(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: beLeadTokId,
			branches: [{ toNodeId: 'BE_Dev', summary: 'Code JWT middleware' }],
			waitJoin: false,
			callerAgentId: 'agent-be-lead',
		});
		assert.strictEqual(devMint.ok, true, devMint.error);
		state = devMint.state;
		const devTokId = devMint.data!.mintedTokenIds[0];

		const badScope = returnOrchestrationToken(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: devTokId,
			summary: 'Edited frontend by mistake',
			modifiedFiles: ['src/frontend/App.tsx'],
			callerAgentId: 'agent-be-dev',
		});
		assert.strictEqual(badScope.ok, false);
		assert.strictEqual(badScope.code, 'ALLOWED_PATHS_VIOLATION');

		// Non-barrier failure bounces a recovery baton back to dispatching superior BE_Lead!
		const devFail = failOrchestrationToken(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: devTokId,
			reason: 'Missing OpenSSL headers in container',
			callerAgentId: 'agent-be-dev',
		});
		assert.strictEqual(devFail.ok, true);
		assert.strictEqual(devFail.effects.length, 1);
		assert.strictEqual(devFail.effects[0].kind, 'dispatch_token');
		assert.strictEqual(devFail.effects[0].nodeId, 'BE_Lead');
		state = devFail.state;

		// 4. Both L2 leads return upward -> Join Barrier automatically wakes L1 CEO ONCE!
		const retBe = returnOrchestrationToken(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: beLeadTokId,
			summary: 'Backend auth shipped with fallback crypto',
			artifacts: [{ title: 'Auth API', content: 'POST /auth/login + /auth/refresh' }],
			callerAgentId: 'agent-be-lead',
		});
		assert.strictEqual(retBe.ok, true);
		assert.strictEqual(retBe.data?.barrierSatisfied, false);
		state = retBe.state;

		const retFe = returnOrchestrationToken(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: feLeadTokId,
			summary: 'Login UI verified',
			callerAgentId: 'agent-fe-lead',
		});
		assert.strictEqual(retFe.ok, true);
		assert.strictEqual(retFe.data?.barrierSatisfied, true);
		assert.strictEqual(retFe.effects.length, 1);
		assert.strictEqual(retFe.effects[0].kind, 'dispatch_token');
		assert.strictEqual(retFe.effects[0].nodeId, 'CEO');
		state = retFe.state;
		assert.strictEqual(state.tokens[rootTokId].status, 'active');

		// 5. L1 CEO concludes root wave -> emits post_inbox delivery report to Human User!
		const finish = completeOrchestrationToken(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: rootTokId,
			finish: true,
			summary: 'Auth feature delivered end-to-end',
			detail: 'Both Backend and Frontend verified.',
			callerAgentId: 'agent-ceo',
		});
		assert.strictEqual(finish.ok, true);
		assert.strictEqual(finish.data?.finished, true);
		const inboxEff = finish.effects.find(e => e.kind === 'post_inbox');
		assert.ok(inboxEff && inboxEff.kind === 'post_inbox', 'completing root wave must emit post_inbox report for resting User');
		assert.strictEqual(inboxEff.severity, 'info');
		assert.ok(inboxEff.message.includes('Auth feature delivered end-to-end'));
	});

	test('P1 regressions: joinMode=any trailing branch settles quietly, non-barrier return/fail merges into active parent baton, terminal complete persists artifacts/decisions & auto-returns subordinate, and multi-hop task completion BFS', () => {
		const orchCode = [
			'flowchart TD',
			'  CEO["@Alice · Governor (L1)"] <--> BE_Lead["@Bob · Backend Lead (L2)"]',
			'  CEO <--> FE_Lead["@Carol · Frontend Lead (L2)"]',
			'  subgraph Backend["Backend"]',
			'    BE_Lead <--> BE_Eng["@Eve · Backend Eng (L3)"]',
			'    BE_Eng <--> BE_Dev["@Dave · Worker (L4)"]',
			'    %% staff BE_Lead [tier=2, dept="Backend"]',
			'    %% staff BE_Eng [tier=3, dept="Backend"]',
			'    %% staff BE_Dev [tier=4, dept="Backend"]',
			'  end',
			'  subgraph Frontend["Frontend"]',
			'    FE_Lead',
			'    %% staff FE_Lead [tier=2, dept="Frontend"]',
			'  end',
		].join('\n');
		const graph = parseOrchestrationGraph(orchCode);
		assert.strictEqual(graph.error, undefined);

		// 1. Multi-hop downward BFS task completion authority: L2 BE_Lead can complete task assigned to L4 BE_Dev (L2 -> L3 -> L4), FE_Lead cannot
		const taskDag = parseMissionMermaidDag('flowchart LR\n  T_DEEP["Deep Worker Task"]');
		assert.strictEqual(taskDag.error, undefined);
		const deepTaskNode = taskDag.nodes[0];
		const deepTaskRecord = { status: 'in_progress' as const, updatedAt: 1000, assigneeNodeId: 'BE_Dev' };
		assert.strictEqual(
			canCallerCompleteMissionTask(DEFAULT_ADE_ORGANIZATION_CONFIG, deepTaskNode, { callerTier: 2, callerNodeId: 'BE_Lead' }, graph, deepTaskRecord),
			true,
			'L2 department lead must be able to complete task delegated multi-hop down to L4 in same department',
		);
		assert.strictEqual(
			canCallerCompleteMissionTask(DEFAULT_ADE_ORGANIZATION_CONFIG, deepTaskNode, { callerTier: 2, callerNodeId: 'FE_Lead' }, graph, deepTaskRecord),
			false,
			'Cross-department L2 lead must NOT be able to complete Backend task',
		);

		let state = createInitialOrchestrationRuntimeState('m-p1-reg', ['CEO', 'BE_Lead', 'FE_Lead', 'BE_Eng', 'BE_Dev']);
		state = {
			...state,
			nodeAgentIds: {
				CEO: 'ag-ceo',
				BE_Lead: 'ag-be-lead',
				FE_Lead: 'ag-fe-lead',
				BE_Eng: 'ag-be-eng',
				BE_Dev: 'ag-be-dev',
			},
		};

		// 2. joinMode: 'any' wakes CEO on FIRST return; trailing second branch settles cleanly with 0 extra wakeups!
		const anySplit = mintOrchestrationTokens(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			branches: [
				{ toNodeId: 'BE_Lead', summary: 'Fast path A' },
				{ toNodeId: 'FE_Lead', summary: 'Backup path B' },
			],
			waitJoin: true,
			joinMode: 'any',
			callerAgentId: 'ag-ceo',
		});
		assert.strictEqual(anySplit.ok, true, anySplit.error);
		state = anySplit.state;
		const rootAnyId = anySplit.data!.parentTokenId;
		const beTokId = anySplit.data!.branches.find(b => b.toNodeId === 'BE_Lead')!.tokenId;
		const feTokId = anySplit.data!.branches.find(b => b.toNodeId === 'FE_Lead')!.tokenId;

		// 3. Multi-tier non-barrier (--no-wait-join): BE_Lead -> BE_Eng return AND fail BOTH merge into BE_Lead's active baton (zero duplicate ghost batons!)
		const nbMint1 = mintOrchestrationTokens(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: beTokId,
			branches: [{ toNodeId: 'BE_Eng', summary: 'Build cache layer' }],
			waitJoin: false,
			callerAgentId: 'ag-be-lead',
		});
		assert.strictEqual(nbMint1.ok, true, nbMint1.error);
		state = nbMint1.state;
		const engTok1 = nbMint1.data!.mintedTokenIds[0];

		const engRet1 = returnOrchestrationToken(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: engTok1,
			summary: 'Cache layer ready',
			artifacts: [{ title: 'CacheBench', content: 'p99=1.2ms' }],
			callerAgentId: 'ag-be-eng',
		});
		assert.strictEqual(engRet1.ok, true, engRet1.error);
		assert.strictEqual(engRet1.data?.returnedTokenId, beTokId, 'non-barrier return must merge into active parent baton instead of creating duplicate ghost baton');
		assert.strictEqual(engRet1.effects.length, 1);
		assert.strictEqual(engRet1.effects[0].kind, 'dispatch_token');
		assert.strictEqual(engRet1.effects[0].tokenId, beTokId);
		state = engRet1.state;
		const activeOnBeAfterRet = Object.values(state.tokens).filter(t => t.nodeId === 'BE_Lead' && t.status === 'active');
		assert.strictEqual(activeOnBeAfterRet.length, 1, 'BE_Lead must hold exactly 1 active baton after non-barrier child return');
		assert.ok(state.tokens[beTokId].contextRefs?.some(r => r.title === 'CacheBench'), 'child artifacts must propagate into merged active parent baton');

		const nbMint2 = mintOrchestrationTokens(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: beTokId,
			branches: [{ toNodeId: 'BE_Eng', summary: 'Run migration' }],
			waitJoin: false,
			callerAgentId: 'ag-be-lead',
		});
		assert.strictEqual(nbMint2.ok, true, nbMint2.error);
		state = nbMint2.state;
		const engTok2 = nbMint2.data!.mintedTokenIds[0];

		const engFail2 = failOrchestrationToken(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: engTok2,
			reason: 'Replica read-only mode',
			callerAgentId: 'ag-be-eng',
		});
		assert.strictEqual(engFail2.ok, true, engFail2.error);
		assert.strictEqual(engFail2.effects.length, 1);
		assert.strictEqual(engFail2.effects[0].kind, 'dispatch_token');
		assert.strictEqual(engFail2.effects[0].tokenId, beTokId, 'non-barrier child failure must bounce into active parent baton');
		state = engFail2.state;
		const activeOnBeAfterFail = Object.values(state.tokens).filter(t => t.nodeId === 'BE_Lead' && t.status === 'active');
		assert.strictEqual(activeOnBeAfterFail.length, 1, 'BE_Lead must STILL hold exactly 1 active baton after non-barrier child failure');

		// 4. Subordinate calling `completeOrchestrationToken` WITHOUT toNodeIds/finish auto-routes upward via returnOrchestrationToken!
		const subAutoReturn = completeOrchestrationToken(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: beTokId,
			summary: 'Backend path won join=any race',
			callerAgentId: 'ag-be-lead',
		});
		assert.strictEqual(subAutoReturn.ok, true, subAutoReturn.error);
		assert.strictEqual(subAutoReturn.effects.length, 1);
		assert.strictEqual(subAutoReturn.effects[0].kind, 'dispatch_token');
		assert.strictEqual(subAutoReturn.effects[0].nodeId, 'CEO', 'First winner of joinMode=any wakes CEO');
		state = subAutoReturn.state;

		// Trailing second branch returns AFTER joinMode='any' already satisfied -> settles quietly with 0 extra wakeups!
		const trailingRet = returnOrchestrationToken(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: feTokId,
			summary: 'Trailing frontend branch finished later',
			callerAgentId: 'ag-fe-lead',
		});
		assert.strictEqual(trailingRet.ok, true, trailingRet.error);
		assert.strictEqual(trailingRet.effects.length, 0, 'Trailing branch of already-satisfied joinMode=any barrier must NOT re-wake CEO');
		assert.strictEqual(trailingRet.state.tokens[feTokId].status, 'completed');
		state = trailingRet.state;

		// 5. Subordinate --finish must NOT emit User Inbox "Engineering Delivery Completed", whereas L1 root --finish DOES persist artifacts/decisions + emit post_inbox!
		const subMintForFinish = mintOrchestrationTokens(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			parentTokenId: rootAnyId,
			branches: [{ toNodeId: 'FE_Lead', summary: 'Optional polish' }],
			waitJoin: false,
			callerAgentId: 'ag-ceo',
		});
		assert.strictEqual(subMintForFinish.ok, true);
		state = subMintForFinish.state;
		const subFinishTok = subMintForFinish.data!.mintedTokenIds[0];
		const subFinishRes = completeOrchestrationToken(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: subFinishTok,
			finish: true,
			summary: 'Local subordinate finish',
			callerAgentId: 'ag-fe-lead',
		});
		assert.strictEqual(subFinishRes.ok, true);
		assert.strictEqual(subFinishRes.effects.some(e => e.kind === 'post_inbox'), false, 'Subordinate --finish must never post fake Engineering Delivery Completed to User Inbox');
		state = subFinishRes.state;

		const rootFinish = completeOrchestrationToken(state, graph, undefined, DEFAULT_ADE_ORGANIZATION_CONFIG, {
			tokenId: rootAnyId,
			finish: true,
			summary: 'Release v2 complete',
			artifacts: [{ title: 'ReleaseNotes', content: 'All 42 checks green' }],
			decisions: [{ title: 'CacheChoice', content: 'Selected LRU with 5m TTL' }],
			callerAgentId: 'ag-ceo',
		});
		assert.strictEqual(rootFinish.ok, true, rootFinish.error);
		const finalTok = rootFinish.state.tokens[rootAnyId];
		assert.ok(finalTok.contextRefs?.some(r => r.title === 'ReleaseNotes'), 'Terminal complete must persist --artifact into contextRefs');
		assert.ok(finalTok.contextRefs?.some(r => r.title === 'CacheChoice'), 'Terminal complete must persist --decision into contextRefs');
		const finalInbox = rootFinish.effects.find(e => e.kind === 'post_inbox');
		assert.ok(finalInbox && finalInbox.kind === 'post_inbox');
		assert.ok(finalInbox.message.includes('Release v2 complete'));
	});
});
