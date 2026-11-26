/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IAdeControlCenterService,
	IAdeUiWhiteboardInspection,
	IAdeWbItemsFilter,
} from '../../../../../platform/ade/common/adeControlCenterIpc.js';
import {
	IAdeAgentNode,
	IAdeProjectSnapshot,
	IAdeTicketTransferAnimationEvent,
	IAdeWhiteboard,
} from '../../../../../platform/ade/common/adeModels.js';
import {
	buildProjectOrchestrationGraph,
	computeOrchestrationLayoutPositions,
	ORCH_STAFF_CARD_HEIGHT,
	ORCH_STAFF_CARD_WIDTH,
	ORCH_WHITEBOARD_CARD_HEIGHT,
	ORCH_WHITEBOARD_CARD_WIDTH,
} from '../../../../../platform/ade/common/adeOrchestrationLayout.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import '../../browser/media/adeMissionCanvas.css';
import '../../browser/media/adeMissionEdges.css';
import '../../browser/media/adeMissionCards.css';
import '../../browser/media/adeMissionOverlays.css';
import {
	buildMinimapSyncPayload,
	EngineeringHistoryStore,
	EngineeringViewportMemory,
} from '../../browser/adeEngineeringViewLinkage.js';
import { AdeMissionCanvasRenderer } from '../../browser/adeMissionCanvasRenderer.js';
import { AdeMissionHostCatalog } from '../../browser/adeMissionHostCatalog.js';
import { AdeMissionMinimap } from '../../browser/adeMissionMinimap.js';
import { AdeWhiteboardPopover } from '../../browser/adeWhiteboardPopover.js';
import { setAdeDisplayLanguageOverride } from '../../common/adeLocalization.js';

function makeAgent(overrides: Partial<IAdeAgentNode> & { readonly agent_id: string; readonly name: string }): IAdeAgentNode {
	const now = 1_764_060_000_000;
	return {
		project_id: 'proj_r3',
		level: 1,
		is_top_role: false,
		parent_id: null,
		role_summary: 'Module owner',
		host: 'local',
		engine: 'claude',
		model: 'claude-sonnet-4-5',
		effort: 'medium',
		session_phase: 'unstarted',
		session_started: false,
		excluded_dept_ids: [],
		last_read_doc_rev: 1,
		token_gen: 1,
		created_at: now,
		updated_at: now,
		...overrides,
	};
}

function makeSampleSnapshot(): IAdeProjectSnapshot {
	const now = 1_764_060_000_000;
	const l1 = makeAgent({
		agent_id: 'agent_l1',
		name: 'Chief Architect',
		level: 1,
		is_top_role: true,
		parent_id: null,
	});
	const l2 = makeAgent({
		agent_id: 'agent_l2',
		name: 'Backend Lead',
		level: 2,
		is_top_role: false,
		parent_id: 'agent_l1',
		host: '10.0.1.12',
		engine: 'codex',
		model: 'gpt-5.2-codex',
		effort: 'high',
		session_phase: 'started',
		session_started: true,
	});
	const wb: IAdeWhiteboard = {
		board_id: 'wb_arch',
		project_id: 'proj_r3',
		name: 'Architecture Board',
		owner_id: 'agent_l1',
		dept_id: 'dept_rd',
		storage_host: '10.0.1.12',
		tag_categories: ['API', 'Benchmark'],
		migration_epoch: 1,
		migration_state: 'transferring',
		migration_progress: {
			total_items: 4,
			completed_items: 2,
		},
		created_at: now,
		updated_at: now,
	};
	return {
		meta: {
			project_id: 'proj_r3',
			folder_id: 'fld_1',
			folder_uri: 'file:///workspace/alpha',
			name: 'Alpha System',
			cross_host_ticket_storage: 'local',
			ticket_migration_epoch: 0,
			ticket_migration_state: 'idle',
			layout_direction: 'TD',
			created_at: now,
			updated_at: now,
		},
		hosts: [
			{
				host_id: 'h_gpu1',
				ip: '10.0.1.12',
				name: 'GPU Node 01',
				ssh_alias: 'gpu-01',
				os_kind: 'linux',
			},
		],
		agents: [l1, l2],
		deleted_agents: [],
		departments: [
			{
				dept_id: 'dept_rd',
				project_id: 'proj_r3',
				name: 'R&D Center',
				root_agent_id: 'agent_l1',
				parent_dept_id: null,
				board_permissions: { wb_arch: 'read_write' },
				created_by: 'agent_l1',
				created_at: now,
				updated_at: now,
			},
		],
		whiteboards: [wb],
		board_grants: [],
		tickets: [
			{
				ticket_id: 'tk_101',
				creator_id: 'agent_l1',
				peer_id: 'agent_l2',
				ticket_level: 1,
				from_id: 'agent_l1',
				to_id: 'agent_l2',
				holder_id: 'agent_l2',
				delivery_mode: 'queue',
				need_return: true,
				current_task_id: 'tsk_001',
				current_task_type: 'dev',
				current_task_title: 'Implement Auth Middleware',
				current_task_summary: 'Verify HMAC-SHA256 channel proof',
				current_has_detail_ref: true,
				has_history_ref: false,
				status: 'active',
				created_at: now,
				updated_at: now,
			},
		],
		edge_latest_transfer_at: {
			'agent_l1<->agent_l2': now,
		},
	};
}

suite('ADE Project Canvas Cards, Minimap, Viewport/History Stores & Whiteboard Popover', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function mountCanvasDom() {
		const workbench = append(mainWindow.document.body, $('.monaco-workbench.vs-dark'));
		workbench.style.position = 'fixed';
		workbench.style.left = '0';
		workbench.style.top = '0';
		workbench.style.width = '1280px';
		workbench.style.height = '800px';
		const editorEl = append(workbench, $('.ade-mission-editor.ade-eng-editor'));
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

	test('EngineeringViewportMemory and EngineeringHistoryStore isolate camera & undo/redo per projectId', () => {
		const vp = new EngineeringViewportMemory();
		vp.save('proj_a', { panX: 120, panY: 80, zoom: 1.25 });
		vp.save('proj_b', { panX: -40, panY: 200, zoom: 0.75 });

		assert.deepStrictEqual(vp.get('proj_a'), { panX: 120, panY: 80, zoom: 1.25 });
		assert.deepStrictEqual(vp.get('proj_b'), { panX: -40, panY: 200, zoom: 0.75 });

		const hist = new EngineeringHistoryStore();
		hist.push('proj_a', {
			positions: { agent_l1: { x: 100, y: 100 } },
			label: 'Move L1',
		});
		const undone = hist.popUndo('proj_a', label => ({
			positions: { agent_l1: { x: 260, y: 180 } },
			label,
		}));
		assert.deepStrictEqual(undone?.positions.agent_l1, { x: 100, y: 100 });
		assert.strictEqual(hist.popUndo('proj_b', l => ({ positions: {}, label: l })), undefined);

		const redone = hist.popRedo('proj_a', label => ({
			positions: { agent_l1: { x: 100, y: 100 } },
			label,
		}));
		assert.deepStrictEqual(redone?.positions.agent_l1, { x: 260, y: 180 });
	});

	test('Staff 344x188 & Whiteboard 276x164 cards render badges and sync incrementally with AdeMissionMinimap', () => {
		setAdeDisplayLanguageOverride('en');
		store.add({ dispose: () => setAdeDisplayLanguageOverride(undefined) });

		const { bodyEl, worldEl, emptyHintEl } = mountCanvasDom();
		const storage = store.add(new InMemoryStorageService());
		const hostCatalog = store.add(new AdeMissionHostCatalog(storage, undefined, undefined, undefined, undefined));

		const renderer = store.add(new AdeMissionCanvasRenderer(worldEl, emptyHintEl, hostCatalog, {
			onHoverNode: () => { },
			onOpenModelPopover: () => { },
			onOpenEnginePopover: () => { },
			onOpenAgentSession: () => { },
			onStartNodeDrag: () => { },
			onDragNodeMove: () => { },
			onEndNodeDrag: () => { },
			getNodePosition: () => undefined,
			getZoom: () => 1,
		}));
		const minimap = store.add(new AdeMissionMinimap(bodyEl, {
			onNavigateToWorldCenter: () => { },
		}));

		assert.strictEqual(ORCH_STAFF_CARD_WIDTH, 344);
		assert.strictEqual(ORCH_STAFF_CARD_HEIGHT, 188);
		assert.strictEqual(ORCH_WHITEBOARD_CARD_WIDTH, 276);
		assert.strictEqual(ORCH_WHITEBOARD_CARD_HEIGHT, 164);

		const snap = makeSampleSnapshot();
		const graph = buildProjectOrchestrationGraph(snap);
		const positions = computeOrchestrationLayoutPositions(graph.nodes, graph.edges, graph.departments, { mode: 'td', direction: 'TD' });

		renderer.syncGraph({
			direction: 'TD',
			layoutMode: 'td',
			nodes: graph.nodes,
			edges: graph.edges,
			departments: graph.departments,
			positions,
			agentNodesById: new Map(snap.agents.map(a => [a.agent_id, a])),
			whiteboardsById: new Map(snap.whiteboards.map(w => [w.board_id, w])),
			tickets: snap.tickets,
		});

		const l1Card = renderer.getCardElement('agent_l1');
		const l2Card = renderer.getCardElement('agent_l2');
		const wbCard = renderer.getCardElement('wb_arch');
		assert.ok(l1Card, 'L1 staff card should be rendered');
		assert.ok(l2Card, 'L2 staff card should be rendered');
		assert.ok(wbCard, 'Whiteboard card should be rendered');

		// L2 has session_started === true, and all 4 configuration pills remain interactive buttons (session reset handled in popover)
		const l2ModelPill = l2Card.querySelector<HTMLButtonElement>('button.ade-mission-model-pill');
		const l2ThinkingPill = l2Card.querySelector<HTMLButtonElement>('button.ade-mission-thinking-tag');
		const l2EnginePill = l2Card.querySelector<HTMLButtonElement>('button.ade-mission-engine-pill');
		const l2HostPill = l2Card.querySelector<HTMLButtonElement>('button.ade-mission-host-pill');
		assert.ok(l2ModelPill && l2ModelPill.disabled === false);
		assert.ok(l2ThinkingPill && l2ThinkingPill.disabled === false);
		assert.ok(l2EnginePill && l2EnginePill.disabled === false);
		assert.strictEqual(l2EnginePill.getAttribute('data-engine-locked'), 'false');
		assert.ok(l2HostPill && l2HostPill.disabled === false);
		assert.strictEqual(l2HostPill.getAttribute('data-host-readonly'), null);

		// Whiteboard card shows storage_host and controlled tag chips
		assert.ok(wbCard.textContent?.includes('10.0.1.12'));
		assert.ok(wbCard.textContent?.includes('API'));

		const minimapPayload = buildMinimapSyncPayload(graph.nodes, snap, undefined, renderer.getLastDepartmentBounds());
		minimap.syncGraph(graph.nodes, graph.edges, positions, undefined, minimapPayload);
		minimap.updateViewport(80, 72, 1, 1280, 800);

		const minimapNodes = bodyEl.querySelectorAll('.ade-mission-minimap-node');
		assert.strictEqual(minimapNodes.length, 3);
		for (const mn of Array.from(minimapNodes)) {
			assert.strictEqual(mn.getAttribute('data-minimap-shape'), 'rect');
		}
	});

	test('AdeWhiteboardPopover filters items, expands >300-char role notes, and renders untrusted Markdown safely', async () => {
		setAdeDisplayLanguageOverride('zh-cn');
		store.add({ dispose: () => setAdeDisplayLanguageOverride(undefined) });

		const { bodyEl } = mountCanvasDom();
		const storage = store.add(new InMemoryStorageService());
		const snap = makeSampleSnapshot();
		let capturedFilter: IAdeWbItemsFilter | undefined;

		const fakeControlCenter = {
			_serviceBrand: undefined,
			onDidChangeCatalog: Event.None,
			onDidChangeProject: Event.None,
			onDidTransferTicket: new Emitter<IAdeTicketTransferAnimationEvent>().event,
			onDidEnqueueOutbox: Event.None,
			onDidCancelOutboxTickets: Event.None,
			onDidDisposeAgentRuntime: Event.None,
			probeEngines: async () => ['claude', 'codex'],
			probeModels: async () => ({ models: ['claude-sonnet-4-5'], efforts: ['low', 'medium', 'high'] }),
			uiInspectWhiteboard: async (_pid: string, _bid: string, filter?: IAdeWbItemsFilter): Promise<IAdeUiWhiteboardInspection> => {
				capturedFilter = filter;
				return {
					board: snap.whiteboards[0],
					members: [
						{ agent_id: 'agent_l1', name: 'Chief Architect', permission: 'owner' },
						{ agent_id: 'agent_l2', name: 'Backend Lead', permission: 'read_write' },
					],
					items: [
						{
							item_id: 'itm_pinned',
							item_type: 'msg',
							author_id: 'agent_l1',
							summary: 'Auth Token Spec',
							stars: 5,
							tags: ['API'],
							is_pinned: true,
							has_detail: true,
							file_meta: null,
							created_at: 1_764_060_010_000,
						},
						{
							item_id: 'itm_file',
							item_type: 'file',
							author_id: 'agent_l2',
							summary: 'Benchmark YAML',
							stars: 4,
							tags: ['Benchmark'],
							is_pinned: false,
							has_detail: false,
							file_meta: { filename: 'bench.yaml', size_bytes: 4096 },
							created_at: 1_764_060_020_000,
						},
					],
					notes: [
						{
							note_id: 'nt_long',
							from_id: 'agent_l1',
							to_id: 'agent_l2',
							is_read: false,
							content_preview: 'Please check edge stub tolerance...',
							has_detail: true,
							created_at: 1_764_060_030_000,
						},
					],
				};
			},
			uiReadWhiteboardItemDetail: async () => '## Spec\n<script>window.__wbXss = 1;</script>\nSafe body text',
			uiReadWhiteboardNoteDetail: async () => 'Full >300-char role note content with <img src=x onerror="window.__wbXss=2">',
		} as unknown as IAdeControlCenterService;

		const hostCatalog = store.add(new AdeMissionHostCatalog(storage, undefined, undefined, undefined, fakeControlCenter));
		const wbPopover = store.add(new AdeWhiteboardPopover(
			bodyEl,
			fakeControlCenter,
			hostCatalog,
			undefined,
			undefined,
			{
				getProjectId: () => 'proj_r3',
				getProjectSnapshot: () => snap,
			},
		));

		const anchor = append(bodyEl, $('div'));
		await wbPopover.open(snap.whiteboards[0], anchor);
		assert.strictEqual(wbPopover.isOpen(), true);
		assert.ok(wbPopover.popoverEl.querySelector('[data-ade-wb-migration-state="transferring"]'), 'CAS migration progress banner should render');

		// Expand msg detail and verify XSS sanitization
		const detailBtn = wbPopover.popoverEl.querySelector<HTMLButtonElement>('[data-ade-wb-msg-detail="itm_pinned"]');
		assert.ok(detailBtn);
		detailBtn.click();
		await new Promise(r => setTimeout(r, 0));

		const renderedMd = wbPopover.popoverEl.querySelector('[data-ade-wb-rendered-msg="itm_pinned"] .ade-safe-markdown');
		assert.ok(renderedMd);
		assert.strictEqual(renderedMd.querySelectorAll('script').length, 0);
		assert.ok(renderedMd.textContent?.includes('Safe body text'));

		// Filter by stars
		const starsSelect = wbPopover.popoverEl.querySelector<HTMLSelectElement>('[data-ade-wb-filter-stars="true"]');
		assert.ok(starsSelect);
		starsSelect.value = '4-5';
		starsSelect.dispatchEvent(new mainWindow.Event('change'));
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(capturedFilter?.stars, '4-5');

		// Switch to Role Notes tab and expand >300-char full note
		const notesTab = wbPopover.popoverEl.querySelector<HTMLButtonElement>('[data-ade-wb-tab="notes"]');
		assert.ok(notesTab);
		notesTab.click();
		const noteDetailBtn = wbPopover.popoverEl.querySelector<HTMLButtonElement>('[data-ade-wb-note-detail="nt_long"]');
		assert.ok(noteDetailBtn);
		noteDetailBtn.click();
		await new Promise(r => setTimeout(r, 0));

		const noteMd = wbPopover.popoverEl.querySelector('[data-ade-wb-rendered-note="nt_long"] .ade-safe-markdown');
		assert.ok(noteMd);
		assert.strictEqual(noteMd.querySelectorAll('img[onerror]').length, 0);
		assert.ok(noteMd.textContent?.includes('Full >300-char role note content'));
	});
});
