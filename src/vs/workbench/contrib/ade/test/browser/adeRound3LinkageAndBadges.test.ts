/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMissionDagEdge, IMissionDagNode, IMissionNodePosition } from '../../../../../platform/ade/common/adeMissionDag.js';
import {
	buildOrchestrationTokenDeltaView,
	IMissionTaskStatusRecord,
	IOrchestrationJoinBarrier,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationWhiteboard,
} from '../../../../../platform/ade/common/adeOrchestrationEngine.js';
import { IOrchestrationDepartmentGroup, IOrchestrationGraphEdge, IOrchestrationGraphNode } from '../../../../../platform/ade/common/adeOrchestrationGraph.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG } from '../../../../../platform/ade/common/adeRoleSchema.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import '../../browser/media/adeMissionCanvas.css';
import '../../browser/media/adeMissionEdges.css';
import '../../browser/media/adeMissionCards.css';
import '../../browser/media/adeMissionOverlays.css';
import {
	buildMinimapSyncPayload,
	computeEngineeringConsoleFinOps,
	EngineeringHistoryStore,
	EngineeringViewportMemory,
	inferEngineeringViewModeForNode,
	resolveCrossViewLinkedNodeIds,
} from '../../browser/adeEngineeringViewLinkage.js';
import { AdeMissionCanvasRenderer, IMissionCanvasRenderSnapshot } from '../../browser/adeMissionCanvasRenderer.js';
import { AdeMissionHostCatalog } from '../../browser/adeMissionHostCatalog.js';
import { AdeMissionMinimap } from '../../browser/adeMissionMinimap.js';
import { AdeMissionPopovers } from '../../browser/adeMissionPopovers.js';
import type { IAdeMissionRecord } from '../../browser/adeMissionStore.js';
import { setAdeDisplayLanguageOverride } from '../../common/adeLocalization.js';

function makeToken(overrides: Partial<IOrchestrationToken> & { readonly id: string; readonly waveId: string; readonly nodeId: string }): IOrchestrationToken {
	const now = Date.now();
	return {
		status: 'active',
		lastSummary: 'Execute task',
		compressedHistory: '',
		tracePtr: `trace-${overrides.id}`,
		arrivedAt: now - 5_000,
		lastActivityAt: now - 1_000,
		nudgeCount: 0,
		...overrides,
	};
}

function makeRuntime(overrides?: Partial<IOrchestrationRuntimeState>): IOrchestrationRuntimeState {
	const now = Date.now();
	return {
		missionId: 'mission-r3',
		status: 'running',
		silenceReminderMinutes: 5,
		nodeStates: {},
		nodeAgentIds: {},
		tokens: {},
		traces: {},
		joinBarriers: {},
		payloadStore: {},
		tokenSeq: 1,
		waveSeq: 1,
		traceSeq: 1,
		updatedAt: now,
		...overrides,
	};
}

suite('ADE Round-3 Cross-View Linkage, Round-2 Card Badges & Detail Popovers', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function mountWorkbenchCanvas(): {
		readonly workbench: HTMLElement;
		readonly editorEl: HTMLElement;
		readonly bodyEl: HTMLElement;
		readonly worldEl: HTMLElement;
		readonly emptyHintEl: HTMLElement;
	} {
		const workbench = append(mainWindow.document.body, $('.monaco-workbench.vs-dark'));
		workbench.style.position = 'fixed';
		workbench.style.left = '0';
		workbench.style.top = '0';
		workbench.style.width = '1280px';
		workbench.style.height = '800px';
		const editorEl = append(workbench, $('.ade-mission-editor.ade-eng-editor'));
		editorEl.style.position = 'relative';
		editorEl.style.width = '1280px';
		editorEl.style.height = '800px';
		const bodyEl = append(editorEl, $('.ade-mission-body.ade-eng-body'));
		bodyEl.style.position = 'relative';
		bodyEl.style.width = '1280px';
		bodyEl.style.height = '800px';
		const worldEl = append(bodyEl, $('.ade-mission-world.ade-eng-world'));
		const emptyHintEl = append(bodyEl, $('.ade-mission-empty-hint'));
		store.add({ dispose: () => workbench.remove() });
		return { workbench, editorEl, bodyEl, worldEl, emptyHintEl };
	}

	test('inferEngineeringViewModeForNode, bidirectional cross-view linkage, viewport/history isolation, and FinOps telemetry', () => {
		setAdeDisplayLanguageOverride('en');
		store.add({ dispose: () => setAdeDisplayLanguageOverride(undefined) });

		const now = Date.now();
		const wbArch: IOrchestrationWhiteboard = {
			id: 'WB_ARCH',
			department: 'Platform Engineering',
			title: 'Auth v2 Architecture',
			content: '## Token Schema\nRS256 dual KID\n\n## Key Rollover\n30s skew',
			version: 4,
			createdAt: now - 60_000,
			updatedAt: now - 10_000,
		};
		const orchRuntime = makeRuntime({
			totalCostUsd: 8.8,
			budgetLimitUsd: 10.0,
			finOpsTelemetry: {
				totalInputTokens: 300_000,
				totalOutputTokens: 61_000,
				totalCacheReadTokens: 150_000,
				totalCacheWriteTokens: 20_000,
				cacheHitRatePct: 50,
				reworkTokens: 12_000,
				updatedAt: now,
			},
			nodeStates: { ArchLead: 'waiting_join', CoreDev: 'active' },
			tokens: {
				'otok-101': makeToken({
					id: 'otok-101',
					waveId: 'w1',
					nodeId: 'CoreDev',
					fromNodeId: 'ArchLead',
					lastSummary: 'Fix JWKS clock-skew tolerance',
					taskNodeId: 'T2',
				}),
			},
		});
		const record: IAdeMissionRecord = {
			id: 'mission-r3',
			title: 'Auth v2',
			mermaidText: [
				'flowchart LR',
				'  T1["Draft RFC"] --> T2["Implement JWT Rotation"]',
				'  %% task T2 [dept=Platform, require_wb=WB_ARCH]',
			].join('\n'),
			orchestrationText: [
				'flowchart LR',
				'  subgraph Platform["Platform Engineering"]',
				'    ArchLead["Backend Lead @Bob"] <--> CoreDev["Core Auth Engineer @Charlie"]',
				'    WB_ARCH[("Auth v2 Architecture")]',
				'  end',
				'  %% staff ArchLead [tier=2, rank=manager, dept=Platform Engineering]',
				'  %% staff CoreDev [tier=3, rank=employee, dept=Platform Engineering]',
			].join('\n'),
			positions: {},
			ownerTier: 1,
			createdAt: now,
			updatedAt: now,
			whiteboards: { WB_ARCH: wbArch },
			taskStatuses: {
				T2: {
					status: 'in_progress',
					assigneeNodeId: 'CoreDev',
					updatedAt: now,
				},
			},
			orchestrationRuntime: orchRuntime,
		};

		assert.strictEqual(inferEngineeringViewModeForNode(record, 'T2'), 'mission');
		assert.strictEqual(inferEngineeringViewModeForNode(record, 'CoreDev'), 'orchestration');
		assert.strictEqual(inferEngineeringViewModeForNode(record, 'WB_ARCH'), 'orchestration');

		const fromTask = resolveCrossViewLinkedNodeIds(record, 'mission', ['T2'], [], []);
		assert.ok(fromTask.includes('CoreDev'), 'Task T2 links to assigned/tokenized Orchestration Staff CoreDev');
		assert.ok(fromTask.includes('WB_ARCH'), 'Task T2 links to required Whiteboard WB_ARCH');

		const fromStaff = resolveCrossViewLinkedNodeIds(record, 'orchestration', ['CoreDev'], [], []);
		assert.deepStrictEqual(fromStaff, ['T2'], 'Staff CoreDev links back to Mission Task T2');

		const fromWb = resolveCrossViewLinkedNodeIds(record, 'orchestration', ['WB_ARCH'], [], []);
		assert.deepStrictEqual(fromWb, ['T2'], 'Whiteboard WB_ARCH links back to Mission Task T2');

		const vpMem = new EngineeringViewportMemory();
		vpMem.save('m1', 'mission', { panX: 100, panY: 50, zoom: 0.9 });
		vpMem.save('m1', 'orchestration', { panX: -200, panY: 80, zoom: 0.75 });
		assert.deepStrictEqual(vpMem.get('m1', 'mission'), { panX: 100, panY: 50, zoom: 0.9 });
		assert.deepStrictEqual(vpMem.get('m1', 'orchestration'), { panX: -200, panY: 80, zoom: 0.75 });

		const hist = new EngineeringHistoryStore();
		const mKey = EngineeringHistoryStore.keyFor('m1', 'mission');
		const oKey = EngineeringHistoryStore.keyFor('m1', 'orchestration');
		hist.push(mKey, { viewMode: 'mission', codeText: 'v1', positions: {}, nodePrompts: {}, label: 'edit m' });
		hist.push(oKey, { viewMode: 'orchestration', codeText: 'o1', positions: {}, nodePrompts: {}, label: 'edit o' });
		const undoneM = hist.popUndo(mKey, label => ({ viewMode: 'mission', codeText: 'v2', positions: {}, nodePrompts: {}, label }));
		assert.strictEqual(undoneM?.codeText, 'v1');
		const undoneO = hist.popUndo(oKey, label => ({ viewMode: 'orchestration', codeText: 'o2', positions: {}, nodePrompts: {}, label }));
		assert.strictEqual(undoneO?.codeText, 'o1');

		const warnSummary = computeEngineeringConsoleFinOps(orchRuntime, undefined);
		assert.strictEqual(warnSummary.visible, true);
		assert.strictEqual(warnSummary.warningLevel, 'warn', '88% spend triggers warn level');
		assert.ok(!/[\u4e00-\u9fff]/.test(warnSummary.text + warnSummary.tooltip), 'Pure EN FinOps text has 0 CJK');

		const trippedSummary = computeEngineeringConsoleFinOps({ ...orchRuntime, budgetCircuitTripped: true }, undefined);
		assert.strictEqual(trippedSummary.warningLevel, 'tripped');
		assert.ok(trippedSummary.text.includes('Budget Limit'), 'Tripped budget displays Budget Limit pill');
		assert.ok(!/[\u4e00-\u9fff]/.test(trippedSummary.text + trippedSummary.tooltip), 'Pure EN tripped FinOps has 0 CJK');
	});

	test('Mission Task DAG renders Round-2 contract/receipt/frontier badges, preserves #160 280x154 geometry, patches live in-place, and wires cross-view jumps', () => {
		setAdeDisplayLanguageOverride('en');
		store.add({ dispose: () => setAdeDisplayLanguageOverride(undefined) });

		const { editorEl, worldEl, emptyHintEl } = mountWorkbenchCanvas();
		const storage = store.add(new InMemoryStorageService());
		const hostCatalog = store.add(new AdeMissionHostCatalog(storage, undefined, undefined, undefined));

		const jumpedStaff: string[] = [];
		const openedTaskSections: { readonly nodeId: string; readonly section?: string }[] = [];

		const renderer = store.add(new AdeMissionCanvasRenderer(worldEl, emptyHintEl, hostCatalog, {
			onHoverNode: () => undefined,
			onOpenEmployeePopover: () => undefined,
			onOpenModelPopover: () => undefined,
			onOpenEnginePopover: () => undefined,
			onOpenHostPopover: () => undefined,
			onOpenNodePromptPopover: () => undefined,
			onOpenGateDecisionPopover: () => undefined,
			onOpenAgentSession: () => undefined,
			onStartNodeDrag: () => undefined,
			onDragNodeMove: () => undefined,
			onEndNodeDrag: () => undefined,
			getNodePosition: () => undefined,
			getZoom: () => 1,
			onOpenMissionTaskPopover: (node, _anchor, opts) => {
				openedTaskSections.push({ nodeId: node.id, section: opts?.focusSection });
			},
			onJumpToOrchestrationStaff: staffId => {
				jumpedStaff.push(staffId);
			},
			getEffectiveNodeChecksCount: nodeId => (nodeId === 'T2' ? 3 : 0),
		}));

		const now = Date.now();
		const nodes: IMissionDagNode[] = [
			{ id: 'T1', label: 'Draft RFC', kind: 'task', department: 'Platform' },
			{
				id: 'T2',
				label: 'Implement JWT Rotation',
				kind: 'task',
				department: 'Platform',
				completionContract: {
					requireChecksPassed: true,
					requireArtifact: true,
					requireFiles: true,
					minSummaryChars: 40,
					requiredWhiteboardIds: ['WB_ARCH'],
				},
			},
			{ id: 'T3B', label: 'Audit Session Cookie', kind: 'task', department: 'Frontend' },
			{ id: 'U1', label: 'Release Sign-Off', kind: 'gate' },
		];
		const edges: IMissionDagEdge[] = [
			{ id: 'T1->T2', from: 'T1', to: 'T2', label: 'RFC v4' },
			{ id: 'T1->T3B', from: 'T1', to: 'T3B' },
			{ id: 'T2->U1', from: 'T2', to: 'U1' },
			{ id: 'T3B->U1', from: 'T3B', to: 'U1' },
		];
		const positions = new Map<string, IMissionNodePosition>([
			['T1', { x: 180, y: 240 }],
			['T2', { x: 540, y: 160 }],
			['T3B', { x: 540, y: 340 }],
			['U1', { x: 920, y: 240 }],
		]);
		const taskStatuses: Record<string, IMissionTaskStatusRecord> = {
			T1: { status: 'completed', updatedAt: now - 60_000 },
			T2: {
				status: 'in_progress',
				assigneeNodeId: 'CoreDev',
				touchedFiles: ['src/auth/jwt.ts', 'src/auth/jwks.ts'],
				artifactPtrs: ['art-1'],
				lastCheckReceipt: { passed: false, checkedAt: now - 5_000, summary: '2/3 passed' },
				updatedAt: now - 2_000,
			},
			T3B: { status: 'pending', updatedAt: now - 10_000 },
			U1: { status: 'pending', updatedAt: now - 10_000 },
		};
		const orchRuntime = makeRuntime({
			nodeStates: { CoreDev: 'active' },
			tokens: {
				'otok-101': makeToken({
					id: 'otok-101',
					waveId: 'w1',
					nodeId: 'CoreDev',
					fromNodeId: 'ArchLead',
					lastSummary: 'Fix clock skew',
					taskNodeId: 'T2',
					attemptNumber: 2,
					reworkCategory: 'test',
				}),
			},
		});

		const makeSnapshot = (overrides?: Partial<IMissionCanvasRenderSnapshot>): IMissionCanvasRenderSnapshot => ({
			viewMode: 'mission',
			direction: 'LR',
			nodes,
			edges,
			positions,
			runtimeState: undefined,
			nodePrompts: { T2: 'Zero-downtime RS256 rotation' },
			taskStatuses,
			orchestrationRuntime: orchRuntime,
			agentByNodeId: new Map(),
			fallbackOwnerEngineId: 'aexus-claude',
			orgConfig: DEFAULT_ADE_ORGANIZATION_CONFIG,
			hasSubordinates: () => false,
			canSwitchEngine: () => false,
			canSwitchModel: false,
			canSwitchHost: false,
			...overrides,
		});

		renderer.syncGraph(makeSnapshot(), true);

		const t2Node = worldEl.querySelector<HTMLElement>('.ade-mission-node[data-node-id="T2"]')!;
		const t2Card = t2Node.querySelector<HTMLElement>('.ade-mission-node-card.is-task-card.is-sculpted-task')!;
		assert.ok(t2Card, 'Sculpted task card renders for T2');
		const t2Style = mainWindow.getComputedStyle(t2Card);
		assert.strictEqual(t2Style.width, '280px', '#160 lock: sculpted task card width === 280px');
		assert.strictEqual(t2Style.height, '154px', '#160 lock: sculpted task card height === 154px');
		assert.strictEqual(t2Style.borderRadius, '14px', '#160 lock: sculpted task card borderRadius === 14px');
		assert.strictEqual(t2Node.querySelectorAll('.ade-mission-clamp').length, 0, '#160 lock: non-gate task card has 0 clamps');

		const u1Node = worldEl.querySelector<HTMLElement>('.ade-mission-node[data-node-id="U1"]')!;
		assert.strictEqual(u1Node.querySelectorAll('.ade-mission-clamp').length, 4, '#160 lock: gate card has 4 clamps');
		assert.ok(u1Node.querySelector('[data-ade-task-deps="U1"]'), '#160 lock: gate card preserves [data-ade-task-deps]');

		assert.ok(t2Node.querySelector('button[data-ade-task-contract="T2"]'), 'T2 renders clickable completion contract pill');
		assert.ok(t2Node.querySelector('button[data-ade-task-files="T2"]'), 'T2 renders touched-files pill');
		assert.ok(t2Node.querySelector('button[data-ade-task-rework="T2"]'), 'T2 renders rework attempt pill');
		const checksPill = t2Node.querySelector<HTMLElement>('[data-ade-task-checks="T2"]')!;
		assert.strictEqual(checksPill.getAttribute('data-check-state'), 'fail', 'T2 check pill reflects failed receipt');

		const t3bNode = worldEl.querySelector<HTMLElement>('.ade-mission-node[data-node-id="T3B"]')!;
		assert.strictEqual(t3bNode.getAttribute('data-ready-frontier'), 'true', 'Pending task T3B with all upstream completed gets ready-frontier attribute');

		t2Node.querySelector<HTMLButtonElement>('button[data-ade-task-files="T2"]')!.click();
		assert.deepStrictEqual(openedTaskSections, [{ nodeId: 'T2', section: 'checks' }]);
		t2Node.querySelector<HTMLButtonElement>('button[data-ade-jump-staff="CoreDev"]')!.click();
		assert.deepStrictEqual(jumpedStaff, ['CoreDev']);

		renderer.setCrossViewLinkedNodeIds(new Set(['T2']));
		assert.strictEqual(t2Node.classList.contains('is-cross-view-linked'), true);
		renderer.setCrossViewLinkedNodeIds(undefined);
		assert.strictEqual(t2Node.classList.contains('is-cross-view-linked'), false);

		renderer.syncGraph(makeSnapshot({
			taskStatuses: {
				...taskStatuses,
				T2: {
					...taskStatuses.T2,
					lastCheckReceipt: { passed: true, checkedAt: Date.now(), summary: '3/3 passed' },
				},
			},
		}), false);
		assert.strictEqual(worldEl.querySelector('.ade-mission-node[data-node-id="T2"]'), t2Node, 'Incremental patch preserves exact DOM node identity');
		assert.strictEqual(t2Node.querySelector('[data-ade-task-checks="T2"]')?.getAttribute('data-check-state'), 'pass');

		editorEl.classList.add('ade-animations-paused');
		assert.strictEqual(mainWindow.getComputedStyle(t2Card).animationPlayState, 'paused', 'ade-animations-paused pauses in-progress card animation');
	});

	test('Orchestration Staff & Folded Whiteboard cards, clickable live comets, and upgraded Minimap render Round-2 badges & #160 locks', () => {
		setAdeDisplayLanguageOverride('en');
		store.add({ dispose: () => setAdeDisplayLanguageOverride(undefined) });

		const { bodyEl, worldEl, emptyHintEl } = mountWorkbenchCanvas();
		const storage = store.add(new InMemoryStorageService());
		const hostCatalog = store.add(new AdeMissionHostCatalog(storage, undefined, undefined, undefined));

		const jumpedTasks: string[] = [];
		const openedWb: { readonly id: string; readonly section?: string }[] = [];
		const openedTokens: string[] = [];

		const renderer = store.add(new AdeMissionCanvasRenderer(worldEl, emptyHintEl, hostCatalog, {
			onHoverNode: () => undefined,
			onOpenEmployeePopover: () => undefined,
			onOpenModelPopover: () => undefined,
			onOpenEnginePopover: () => undefined,
			onOpenHostPopover: () => undefined,
			onOpenNodePromptPopover: () => undefined,
			onOpenGateDecisionPopover: () => undefined,
			onOpenAgentSession: () => undefined,
			onStartNodeDrag: () => undefined,
			onDragNodeMove: () => undefined,
			onEndNodeDrag: () => undefined,
			getNodePosition: () => undefined,
			getZoom: () => 1,
			onJumpToMissionTask: taskId => {
				jumpedTasks.push(taskId);
			},
			onOpenWhiteboardPopover: (wb, _anchor, opts) => {
				openedWb.push({ id: wb.id, section: opts?.initialSection });
			},
			onOpenOrchestrationTokenPopover: (_label, tok) => {
				openedTokens.push(tok.id);
			},
		}));

		const now = Date.now();
		const orchNodes: IOrchestrationGraphNode[] = [
			{ id: 'ArchLead', label: 'Backend Lead', kind: 'staff', tier: 2, rankId: 'manager', department: 'Platform Engineering', employeeName: 'Bob' },
			{ id: 'CoreDev', label: 'Core Auth Engineer', kind: 'staff', tier: 3, rankId: 'employee', department: 'Platform Engineering', employeeName: 'Charlie', allowedPaths: ['src/auth/**'] },
			{ id: 'WB_ARCH', label: 'Auth v2 Architecture', kind: 'whiteboard', department: 'Platform Engineering' },
		];
		const orchEdges: IOrchestrationGraphEdge[] = [
			{ id: 'ArchLead->CoreDev', from: 'ArchLead', to: 'CoreDev', label: 'JWT slice', isBidirectional: true },
			{ id: 'CoreDev->ArchLead', from: 'CoreDev', to: 'ArchLead', label: 'JWT slice', isBidirectional: true },
		];
		const depts: IOrchestrationDepartmentGroup[] = [
			{ id: 'dept_platform', name: 'Platform Engineering', nodeIds: ['ArchLead', 'CoreDev'], whiteboardIds: ['WB_ARCH'] },
		];
		const positions = new Map<string, IMissionNodePosition>([
			['ArchLead', { x: 220, y: 240 }],
			['CoreDev', { x: 680, y: 240 }],
			['WB_ARCH', { x: 1080, y: 240 }],
		]);
		const wbArch: IOrchestrationWhiteboard = {
			id: 'WB_ARCH',
			department: 'Platform Engineering',
			title: 'Auth v2 Architecture',
			content: '## Token Schema\nRS256\n\n## Key Rollover\nDual KID',
			version: 4,
			createdAt: now - 120_000,
			updatedAt: now - 5_000,
		};
		const barrier: IOrchestrationJoinBarrier = {
			id: 'jb-1',
			waveId: 'w1',
			ownerNodeId: 'ArchLead',
			parentTokenId: 'otok-100',
			childTokenIds: ['otok-101', 'otok-102'],
			settledChildren: {},
			mode: 'quorum',
			quorumCount: 1,
			failFast: true,
			deadlineAt: now + 300_000,
			fileConflicts: [{ path: 'src/auth/sessionTypes.ts', tokenIds: ['otok-101', 'otok-102'], fromNodeIds: ['CoreDev', 'ArchLead'] }],
			status: 'waiting',
			createdAt: now - 60_000,
		};
		const orchRuntime = makeRuntime({
			tokenSeq: 2,
			nodeStates: { ArchLead: 'waiting_join', CoreDev: 'active' },
			tokens: {
				'otok-100': makeToken({
					id: 'otok-100',
					waveId: 'w1',
					nodeId: 'ArchLead',
					status: 'waiting_join',
					lastSummary: 'Coordinate JWT rotation',
					joinBarrierId: 'jb-1',
				}),
				'otok-101': makeToken({
					id: 'otok-101',
					waveId: 'w1',
					nodeId: 'CoreDev',
					fromNodeId: 'ArchLead',
					lastSummary: 'Fix JWKS clock skew',
					taskNodeId: 'T2',
					scopePaths: ['src/auth/**'],
					attemptNumber: 2,
					reworkCategory: 'test',
					dispatchKind: 'reject',
				}),
			},
			joinBarriers: { 'jb-1': barrier },
		});

		renderer.syncGraph({
			viewMode: 'orchestration',
			direction: 'LR',
			nodes: [],
			edges: [],
			positions,
			runtimeState: undefined,
			nodePrompts: {},
			orchestrationNodes: orchNodes,
			orchestrationEdges: orchEdges,
			orchestrationDepartments: depts,
			whiteboards: { WB_ARCH: wbArch },
			orchestrationRuntime: orchRuntime,
			agentByNodeId: new Map(),
			fallbackOwnerEngineId: 'aexus-claude',
			orgConfig: DEFAULT_ADE_ORGANIZATION_CONFIG,
			hasSubordinates: () => false,
			canSwitchEngine: () => false,
			canSwitchModel: false,
			canSwitchHost: false,
		}, true);

		const coreCard = worldEl.querySelector<HTMLElement>('.ade-mission-node[data-node-id="CoreDev"][data-node-kind="staff"]')!;
		assert.strictEqual(coreCard.querySelectorAll('.ade-orch-anchor').length, 20, '#160 lock: Staff pod has 20 perimeter anchors');
		assert.strictEqual(coreCard.querySelectorAll('.ade-mission-clamp').length, 4, '#160 lock: Staff pod has 4 clamps');
		assert.ok(coreCard.querySelector('.ade-orch-staff-meta-strip'), 'Staff pod renders Round-2 meta strip');
		assert.ok(coreCard.querySelector('[data-ade-staff-scope="CoreDev"]'), 'Staff pod renders scope badge');
		assert.ok(coreCard.querySelector('button.ade-orch-rework-pill[data-ade-staff-rework="CoreDev"]'), 'Staff pod renders rework pill');
		coreCard.querySelector<HTMLButtonElement>('button[data-ade-jump-task="T2"]')!.click();
		assert.deepStrictEqual(jumpedTasks, ['T2'], 'Clicking Staff task pill triggers cross-view jump to T2');

		const leadCard = worldEl.querySelector<HTMLElement>('.ade-mission-node[data-node-id="ArchLead"][data-node-kind="staff"]')!;
		assert.ok(leadCard.querySelector('.ade-orch-barrier-chip.is-sla'), 'Waiting-join staff renders SLA countdown chip');
		assert.ok(leadCard.querySelector('.ade-orch-barrier-chip.is-conflict'), 'Conflicting barrier renders conflict chip');

		const wbCard = worldEl.querySelector<HTMLElement>('.ade-mission-node[data-node-id="WB_ARCH"][data-node-kind="whiteboard"]')!;
		assert.strictEqual(wbCard.querySelectorAll('.ade-mission-clamp').length, 4, '#160 lock: Whiteboard pod preserves 4 clamps');
		assert.ok(wbCard.querySelector('.ade-mission-core-well.wb-well'), '#160 lock: Whiteboard pod preserves .wb-well');
		assert.strictEqual(wbCard.querySelector('.ade-orch-wb-ver-tag')?.textContent, 'v4', '#160 lock: exact v4 text');
		const tocChip = wbCard.querySelector<HTMLButtonElement>('button.ade-orch-wb-toc-chip[data-ade-wb-section="Token Schema"]')!;
		assert.ok(tocChip, 'Whiteboard renders Markdown section TOC chip');
		tocChip.click();
		assert.deepStrictEqual(openedWb, [{ id: 'WB_ARCH', section: 'Token Schema' }]);

		const livePuck = worldEl.querySelector<SVGGElement>('.ade-orch-live-puck')!;
		assert.ok(livePuck, 'Live flow comet renders on active Orchestration edge');
		assert.strictEqual(mainWindow.getComputedStyle(livePuck).pointerEvents, 'auto', 'Live comet puck accepts pointer events');
		let worldSawPointerDown = false;
		worldEl.addEventListener('pointerdown', () => { worldSawPointerDown = true; }, { once: true });
		livePuck.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, bubbles: true }));
		assert.strictEqual(worldSawPointerDown, false, 'Comet pointerdown stops propagation to avoid canvas pan hijack');
		livePuck.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true }));
		assert.deepStrictEqual(openedTokens, ['otok-101'], 'Clicking comet opens live Orchestration token popover');

		const minimap = store.add(new AdeMissionMinimap(bodyEl, { onNavigateToWorldCenter: () => undefined }));
		const orchPayload = buildMinimapSyncPayload('orchestration', orchNodes, orchEdges, [], [], orchRuntime, {}, {
			departmentBounds: renderer.getLastDepartmentBounds(),
			orchConflictNodeIds: renderer.getLastOrchConflictNodeIds(),
		});
		minimap.syncGraph(orchPayload.nodes, orchPayload.edges, positions, undefined, 'CoreDev', orchPayload.options);
		assert.ok(bodyEl.querySelector('.ade-mission-minimap-dept'), 'Minimap renders department region tint rect');
		assert.ok(bodyEl.querySelector('.ade-mission-minimap-node.kind-whiteboard[data-minimap-node="WB_ARCH"]'), 'Minimap renders whiteboard node class');
		assert.ok(bodyEl.querySelector('.ade-mission-minimap-node.is-conflict[data-minimap-node="CoreDev"]'), 'Minimap marks conflicting staff node');
		assert.strictEqual(bodyEl.querySelector('.ade-mission-minimap-node[data-minimap-node="CoreDev"]')?.getAttribute('data-minimap-shape'), 'rect', '#160 lock: non-gate minimap shape === rect');

		minimap.syncGraph(
			[{ id: 'T3B', label: 'Ready Task', kind: 'task' }],
			[],
			new Map([['T3B', { x: 200, y: 200 }]]),
			undefined,
			undefined,
			{ nodeStates: { T3B: 'pending' }, readyNodeIds: new Set(['T3B']), criticalNodeIds: new Set(['T3B']) },
		);
		const readyMini = bodyEl.querySelector('.ade-mission-minimap-node[data-minimap-node="T3B"]')!;
		assert.ok(readyMini.classList.contains('state-ready'), 'Minimap renders state-ready for pending ready-frontier task');
		assert.ok(readyMini.classList.contains('is-critical'), 'Minimap renders is-critical class');
	});

	test('Round-3 Detail Popovers enforce lazy pointer preview, C4 failure retention, +N wave switcher, and Whiteboard external-version Reload', async () => {
		setAdeDisplayLanguageOverride('en');
		store.add({ dispose: () => setAdeDisplayLanguageOverride(undefined) });

		const now = Date.now();
		const { bodyEl } = mountWorkbenchCanvas();
		const anchorEl = append(bodyEl, $('button', {}, 'anchor'));
		const storage = store.add(new InMemoryStorageService());
		const hostCatalog = store.add(new AdeMissionHostCatalog(storage, undefined, undefined, undefined));

		const popovers = store.add(new AdeMissionPopovers(bodyEl, hostCatalog, undefined, undefined, undefined, undefined, {
			getActiveMissionId: () => 'm1',
			getNodePrompt: () => 'Zero-downtime JWT rotation',
			canSwitchAgentEngine: () => false,
			getExplicitNodeHost: () => undefined,
			onAssignNodeEmployee: () => undefined,
			onNodePromptEdit: () => undefined,
			onOpenDrawerForNodePrompt: () => undefined,
			onGraphVisualInvalidated: () => undefined,
			onRuntimeControlsInvalidated: () => undefined,
		}));

		// 1. Task Details Popover: C4 contract, lazy preview, error retention + retry clear
		let allowComplete = false;
		popovers.openMissionTaskEditorPopover(
			'm1',
			{
				id: 'T2',
				label: 'Implement JWT Rotation',
				kind: 'task',
				completionContract: { requireChecksPassed: true, requireArtifact: true, requiredWhiteboardIds: ['WB_ARCH'] },
			},
			{
				status: 'in_progress',
				artifactPtrs: ['art-1'],
				lastCheckReceipt: { passed: false, checkedAt: now - 1000, summary: '2/3 passed' },
				updatedAt: now,
			},
			anchorEl,
			{
				onRenameTask: () => undefined,
				onChangeDescription: () => undefined,
				onSetTaskStatus: () => (allowComplete ? { ok: true } : { ok: false, error: 'Checks failed', unmetRequirements: ['checks_pass'] }),
			},
			{
				nodeChecks: [{ id: 'c1', name: 'jwt.test.ts', command: 'npm test' }],
				onRunChecks: async () => undefined,
				onReadPointer: ptr => ({ title: 'Benchmark', content: `SECRET_BODY_${ptr}` }),
			},
		);

		const popEl = bodyEl.querySelector<HTMLElement>('[data-ade-mission-emp-popover="true"]')!;
		assert.ok(popEl.querySelector('.ade-pop-contract-box'), 'Task popover renders C4 contract box');
		assert.ok(popEl.querySelector('.ade-pop-receipt-box'), 'Task popover renders receipt & evidence box');
		const taskPreview = popEl.querySelector<HTMLElement>('[data-ade-task-ptr-preview="true"]')!;
		assert.strictEqual(taskPreview.hidden, true, '#160 lock: task pointer preview stays hidden before click');
		assert.ok(!(popEl.textContent ?? '').includes('SECRET_BODY_art-1'), 'Pointer body not preloaded');
		popEl.querySelector<HTMLButtonElement>('button[data-ade-task-artifact-ptr="art-1"]')!.click();
		await timeout(10);
		assert.strictEqual(taskPreview.hidden, false, 'Clicking artifact chip lazily opens preview');
		assert.ok((taskPreview.textContent ?? '').includes('SECRET_BODY_art-1'));

		const completeBtn = popEl.querySelector<HTMLButtonElement>('button[data-ade-task-toggle-complete="T2"]')!;
		completeBtn.click();
		await timeout(10);
		assert.strictEqual(popovers.isOpen(), true, 'Failed Mark Completed keeps popover open');
		const errEl = popEl.querySelector<HTMLElement>('[data-ade-popover-inline-error="true"]')!;
		assert.strictEqual(errEl.hidden, false, 'Failed Mark Completed shows structured inline error');
		assert.ok((errEl.textContent ?? '').includes('Checks failed'));

		allowComplete = true;
		completeBtn.click();
		await timeout(10);
		assert.strictEqual(popovers.isOpen(), false, 'Retry Mark Completed closes popover once ok:true');

		// 2. Orchestration Token Popover: +N switcher, Join Barrier child rows, conflict row, lazy preview
		const tok1 = makeToken({
			id: 'otok-101',
			waveId: 'w1',
			nodeId: 'CoreDev',
			fromNodeId: 'ArchLead',
			lastSummary: 'Fix clock skew',
			joinBarrierId: 'jb-1',
			attemptNumber: 2,
			reworkCategory: 'test',
			reworkHistory: [{ attempt: 1, kind: 'reject', byNodeId: 'ArchLead', category: 'test', summary: 'Add 30s tolerance', timestamp: now - 10_000 }],
			contextRefs: [{ ptr: 'art-1', kind: 'artifact', title: 'Latency Report', version: 2, updatedAtHop: 1, sizeChars: 610 }],
		});
		const tok2 = makeToken({ ...tok1, id: 'otok-104', waveId: 'w2', lastSummary: 'Second wave check' });
		const jb: IOrchestrationJoinBarrier = {
			id: 'jb-1',
			waveId: 'w1',
			ownerNodeId: 'ArchLead',
			parentTokenId: 'otok-100',
			childTokenIds: ['otok-101', 'otok-102'],
			settledChildren: { 'otok-102': { tokenId: 'otok-102', fromNodeId: 'UILead', outcome: 'returned', summary: 'PKCE UI ready', settledAt: now - 1000 } },
			mode: 'quorum',
			quorumCount: 2,
			failFast: true,
			deadlineAt: now + 180_000,
			fileConflicts: [{ path: 'src/auth/sessionTypes.ts', tokenIds: ['otok-101', 'otok-102'], fromNodeIds: ['CoreDev', 'UILead'] }],
			status: 'waiting',
			createdAt: now - 30_000,
		};
		const orchRt = makeRuntime({
			tokenSeq: 2,
			nodeStates: { CoreDev: 'active' },
			tokens: { 'otok-101': tok1, 'otok-104': tok2 },
			payloadStore: {
				'art-1': { ptr: 'art-1', kind: 'artifact', title: 'Latency Report', content: 'TOKEN_PTR_BODY', sizeChars: 14, digest: 'deadbeef', hop: 1, waveId: 'w1', createdAt: now },
			},
			joinBarriers: { 'jb-1': jb },
		});
		popovers.openOrchestrationTokenPopover('Core Auth Engineer', tok1, anchorEl, {
			delta: buildOrchestrationTokenDeltaView(orchRt, tok1, {}),
			getDeltaForToken: t => buildOrchestrationTokenDeltaView(orchRt, t, {}),
			allStaffTokens: [tok1, tok2],
			joinBarrier: jb,
			joinBarriers: orchRt.joinBarriers,
			onReadPointer: ptr => ({ title: 'Latency Report', content: orchRt.payloadStore?.[ptr]?.content }),
		});

		assert.strictEqual(popEl.querySelectorAll('.ade-mission-token-wave-switcher button').length, 2, '+N token switcher lists both live waves');
		assert.strictEqual(popEl.querySelectorAll('[data-ade-barrier-child]').length, 2, 'Join Barrier lists per-child convergence rows');
		assert.ok(popEl.querySelector('.ade-pop-conflict-row'), 'Join Barrier displays file conflict row');
		assert.ok(popEl.querySelector('.ade-pop-rework-list'), 'Token popover renders Rework Memory Ledger');
		const tokPreview = popEl.querySelector<HTMLElement>('[data-ade-ptr-preview="true"]')!;
		assert.strictEqual(tokPreview.hidden, true, '#160 lock: token pointer preview starts hidden');
		assert.ok(!(popEl.textContent ?? '').includes('TOKEN_PTR_BODY'), 'Token pointer body not preloaded');

		// 3. Whiteboard Popover: external version conflict guard & Reload v{N} live header/stats update
		let latestWb: IOrchestrationWhiteboard = {
			id: 'WB_ARCH',
			department: 'Platform Engineering',
			title: 'Auth v2 Architecture',
			content: '## Token Schema\nv4 content',
			version: 4,
			updatedByLabel: 'ArchLead',
			createdAt: now - 60_000,
			updatedAt: now - 5_000,
		};
		let saveCalls = 0;
		popovers.openWhiteboardEditorPopover(latestWb, anchorEl, () => { saveCalls++; }, {
			getLatestVersion: () => latestWb.version,
			getLatestWhiteboard: () => latestWb,
		});
		assert.ok(popEl.querySelector('.ade-pop-wb-toc-chip'), 'Whiteboard popover renders Markdown TOC chip');

		latestWb = {
			...latestWb,
			version: 5,
			title: 'Auth v2 Architecture Revised',
			content: '## Token Schema\nv5 external update\n\n## New Section\nDetails',
			updatedByLabel: 'CoreDev',
			updatedAt: Date.now(),
		};
		popEl.querySelector<HTMLButtonElement>('button[data-ade-whiteboard-save="WB_ARCH"]')!.click();
		assert.strictEqual(saveCalls, 0, 'First save blocked by external version bump v5');
		const reloadBtn = popEl.querySelector<HTMLButtonElement>('button[data-ade-wb-reload-external="true"]')!;
		assert.ok(reloadBtn, 'Conflict banner offers Reload v5 button');
		reloadBtn.click();
		assert.ok((popEl.querySelector('.ade-mission-emp-popover-title')?.textContent ?? '').includes('(v5)'), 'Reload v5 updates popover header title live');
		assert.ok((popEl.querySelector('[data-ade-wb-stats-meta="true"]')?.textContent ?? '').includes('v5'), 'Reload v5 updates stats metadata live');
		assert.strictEqual(popEl.querySelector<HTMLTextAreaElement>('textarea[data-ade-whiteboard-content-input="WB_ARCH"]')?.value, latestWb.content);
		assert.strictEqual(popEl.querySelectorAll('.ade-pop-wb-toc-chip').length, 2, 'Reload v5 rebuilds TOC chips live');
	});
});
