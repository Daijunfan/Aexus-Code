/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAdeCloudHost, IAdeCloudHostBackendService } from '../../../../../platform/ade/common/adeCloudHosts.js';
import { IAdeControlCenterService, IAdeUiEditAgentInput } from '../../../../../platform/ade/common/adeControlCenterIpc.js';
import {
	IAdeAgentNode,
	IAdeProjectSnapshot,
	IAdeWhiteboard,
} from '../../../../../platform/ade/common/adeModels.js';
import {
	buildProjectOrchestrationGraph,
	computeOrchestrationLayoutPositions,
} from '../../../../../platform/ade/common/adeOrchestrationLayout.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import '../../browser/media/adeGlassSelect.css';
import '../../browser/media/adeMissionCanvas.css';
import '../../browser/media/adeMissionEdges.css';
import '../../browser/media/adeMissionCards.css';
import '../../browser/media/adeMissionOverlays.css';
import {
	buildContextUsageSnapshot,
	IAdeAgentContextUsage,
	recordAdeTurnContextUsage,
} from '../../browser/adeContextUsageTracker.js';
import { installEngineeringCanvasInteractions } from '../../browser/adeEngineeringViewLinkage.js';
import {
	ADE_CARD_INTERACTIVE_SELECTOR,
	AdeMissionCanvasRenderer,
	ORCH_STAFF_CARD_HEIGHT,
	ORCH_STAFF_CARD_WIDTH,
	ORCH_WHITEBOARD_CARD_HEIGHT,
	ORCH_WHITEBOARD_CARD_WIDTH,
} from '../../browser/adeMissionCanvasRenderer.js';
import { AdeMissionHostCatalog } from '../../browser/adeMissionHostCatalog.js';
import {
	AdeMissionPopovers,
} from '../../browser/adeMissionPopovers.js';
import { setAdeDisplayLanguageOverride } from '../../common/adeLocalization.js';

function makeStaffAgent(overrides: Partial<IAdeAgentNode> & { readonly agent_id: string; readonly name: string }): IAdeAgentNode {
	const now = 1_764_100_000_000;
	return {
		project_id: 'proj_human_feel',
		level: 1,
		is_top_role: false,
		parent_id: null,
		role_summary: 'Distributed runtime engineer',
		host: 'local',
		engine: 'codex',
		model: 'openai/gpt-5.3-codex',
		effort: 'high',
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

function makeHumanFeelSnapshot(): IAdeProjectSnapshot {
	const now = 1_764_100_000_000;
	const l1 = makeStaffAgent({
		agent_id: 'agent_l1',
		name: 'Architecture Lead',
		level: 1,
		is_top_role: true,
		parent_id: null,
		host: 'local',
		engine: 'claude',
		model: 'anthropic/claude-sonnet-4-6',
		effort: 'medium',
		session_phase: 'unstarted',
		session_started: false,
	});
	const l2Started = makeStaffAgent({
		agent_id: 'agent_l2',
		name: 'Kernel Specialist',
		level: 2,
		is_top_role: false,
		parent_id: 'agent_l1',
		host: '10.0.12.77',
		engine: 'codex',
		model: 'anthropic/claude-sonnet-4-6',
		effort: 'high',
		session_phase: 'started',
		session_started: true,
	});
	const wb: IAdeWhiteboard = {
		board_id: 'wb_sec',
		project_id: 'proj_human_feel',
		name: 'RedTeam Shared Ops',
		owner_id: 'agent_l1',
		dept_id: null,
		storage_host: 'kali-redteam-01',
		migration_state: 'idle',
		migration_epoch: 0,
		tag_categories: ['recon', 'cve'],
		created_at: now,
		updated_at: now,
	};

	return {
		meta: {
			project_id: 'proj_human_feel',
			folder_id: 'fld_human_feel',
			folder_uri: 'file:///workspace/human-feel',
			name: 'Card Human Feel Suite',
			cross_host_ticket_storage: 'local',
			ticket_migration_epoch: 0,
			ticket_migration_state: 'idle',
			layout_direction: 'TD',
			created_at: now,
			updated_at: now,
		},
		hosts: [
			{
				host_id: 'h_ubuntu_gpu',
				ip: '10.0.12.88',
				ssh_alias: 'gpu-ubuntu-01',
				name: 'Ubuntu GPU Cluster',
				os_kind: 'linux',
			},
			{
				host_id: 'h_kali_red',
				ip: '10.0.12.77',
				ssh_alias: 'kali-redteam-01',
				name: 'Kali RedTeam Box',
				os_kind: 'linux',
			},
			{
				host_id: 'h_win_lab',
				ip: '10.0.12.99',
				ssh_alias: 'win-build-02',
				name: 'Windows Build Node',
				os_kind: 'windows',
			},
		],
		agents: [l1, l2Started],
		deleted_agents: [],
		departments: [],
		whiteboards: [wb],
		board_grants: [
			{
				board_id: 'wb_sec',
				agent_id: 'agent_l2',
				permission: 'read_write',
				granted_by: 'agent_l1',
				updated_at: now,
			},
		],
		tickets: [],
		edge_latest_transfer_at: {},
	};
}

function centerOf(el: Element): { readonly cx: number; readonly cy: number; readonly rect: DOMRect } {
	const rect = el.getBoundingClientRect();
	return {
		cx: Math.round((rect.left + rect.right) / 2),
		cy: Math.round((rect.top + rect.bottom) / 2),
		rect,
	};
}

function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
	return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Simulates a real human pointer press + click at viewport coordinates `(cx, cy)`
 * by resolving the live hit target via `document.elementFromPoint(cx, cy)` and firing
 * `pointerdown -> mousedown -> pointerup -> mouseup -> click`.
 */
function dispatchRealClickSequenceAt(cx: number, cy: number, detail = 1): Element {
	const downHit = mainWindow.document.elementFromPoint(cx, cy);
	assert.ok(downHit, `Expected hit element at (${cx}, ${cy})`);

	downHit.dispatchEvent(new mainWindow.PointerEvent('pointerdown', {
		bubbles: true,
		cancelable: true,
		composed: true,
		pointerId: 1,
		pointerType: 'mouse',
		isPrimary: true,
		button: 0,
		buttons: 1,
		clientX: cx,
		clientY: cy,
	}));
	downHit.dispatchEvent(new mainWindow.MouseEvent('mousedown', {
		bubbles: true,
		cancelable: true,
		composed: true,
		button: 0,
		buttons: 1,
		detail,
		clientX: cx,
		clientY: cy,
	}));

	const upHit = mainWindow.document.elementFromPoint(cx, cy) ?? downHit;
	upHit.dispatchEvent(new mainWindow.PointerEvent('pointerup', {
		bubbles: true,
		cancelable: true,
		composed: true,
		pointerId: 1,
		pointerType: 'mouse',
		isPrimary: true,
		button: 0,
		buttons: 0,
		clientX: cx,
		clientY: cy,
	}));
	upHit.dispatchEvent(new mainWindow.MouseEvent('mouseup', {
		bubbles: true,
		cancelable: true,
		composed: true,
		button: 0,
		buttons: 0,
		detail,
		clientX: cx,
		clientY: cy,
	}));
	upHit.dispatchEvent(new mainWindow.MouseEvent('click', {
		bubbles: true,
		cancelable: true,
		composed: true,
		button: 0,
		buttons: 0,
		detail,
		clientX: cx,
		clientY: cy,
	}));
	return downHit;
}

/**
 * Simulates a rapid human double-click at viewport coordinates `(cx, cy)`:
 * click #1 -> click #2 -> `dblclick`.
 */
function dispatchRealDoubleClickSequenceAt(cx: number, cy: number): Element {
	const firstHit = dispatchRealClickSequenceAt(cx, cy, 1);
	const secondHit = dispatchRealClickSequenceAt(cx, cy, 2);
	secondHit.dispatchEvent(new mainWindow.MouseEvent('dblclick', {
		bubbles: true,
		cancelable: true,
		composed: true,
		button: 0,
		buttons: 0,
		detail: 2,
		clientX: cx,
		clientY: cy,
	}));
	return firstHit;
}

suite('ADE Staff & Whiteboard Card Commercial UX, Kali Icon, Hover Flow, Zoom & Context Usage Suite', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function mountInteractiveCanvas() {
		setAdeDisplayLanguageOverride('zh-cn');
		store.add({ dispose: () => setAdeDisplayLanguageOverride(undefined) });

		const workbench = append(mainWindow.document.body, $('.monaco-workbench.vs-dark'));
		workbench.style.position = 'fixed';
		workbench.style.left = '0';
		workbench.style.top = '0';
		workbench.style.width = '1440px';
		workbench.style.height = '900px';
		workbench.style.zIndex = '99999';
		store.add({ dispose: () => workbench.remove() });

		const editorEl = append(workbench, $('.ade-mission-editor.ade-eng-editor'));
		editorEl.style.position = 'relative';
		editorEl.style.width = '1440px';
		editorEl.style.height = '900px';

		const bodyEl = append(editorEl, $('.ade-mission-body.ade-eng-body'));
		bodyEl.style.position = 'relative';
		bodyEl.style.width = '1440px';
		bodyEl.style.height = '900px';

		const viewportEl = append(bodyEl, $('.ade-mission-viewport'));
		viewportEl.style.position = 'relative';
		viewportEl.style.width = '1440px';
		viewportEl.style.height = '900px';

		const worldEl = append(viewportEl, $('.ade-mission-world.ade-eng-world'));
		worldEl.style.position = 'absolute';
		worldEl.style.left = '0';
		worldEl.style.top = '0';

		const emptyHintEl = append(viewportEl, $('.ade-mission-empty-hint'));
		emptyHintEl.hidden = true;
		const marqueeBoxEl = append(viewportEl, $('.ade-mission-marquee'));
		marqueeBoxEl.hidden = true;

		let currentSnap = makeHumanFeelSnapshot();
		let contextUsageByAgentId = new Map<string, IAdeAgentContextUsage>();
		const editCalls: IAdeUiEditAgentInput[] = [];
		const openSessionCalls: Array<{ readonly agentId: string; readonly side: boolean }> = [];
		const openWbCalls: Array<{ readonly boardId: string; readonly initialTag?: string }> = [];
		const selectedNodeIds = new Set<string>();
		let dragStartCount = 0;
		let manageCloudHostsCount = 0;

		const sshHosts: readonly IAdeCloudHost[] = [
			{
				id: 'ssh_generic_same_ip',
				alias: '10.0.12.77',
				name: '10.0.12.77',
				hostName: '10.0.12.77',
				port: 22,
				os: 'linux',
				source: 'ssh-config',
				recentDirectories: [],
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: 'h_kali_red',
				alias: 'kali-redteam-01',
				name: 'Kali RedTeam Box',
				hostName: '10.0.12.77',
				port: 22,
				os: 'linux',
				user: 'kali',
				source: 'user',
				recentDirectories: ['/home/kali/redteam'],
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: 'h_ubuntu_gpu',
				alias: 'gpu-ubuntu-01',
				name: 'Ubuntu GPU Cluster',
				hostName: '10.0.12.88',
				port: 22,
				os: 'linux',
				user: 'ubuntu',
				source: 'user',
				recentDirectories: ['/home/ubuntu/workspace'],
				createdAt: 1,
				updatedAt: 1,
			},
		];

		const fakeCloudHostService = {
			_serviceBrand: undefined,
			onDidChangeHosts: Event.None,
			listHosts: async () => sshHosts,
		} as unknown as IAdeCloudHostBackendService;

		const fakeControlCenter = {
			_serviceBrand: undefined,
			onDidChangeProjectSnapshot: Event.None,
			onDidTransferTicket: Event.None,
			onDidEnqueueOutbox: Event.None,
			onDidCancelOutboxTickets: Event.None,
			onDidDisposeAgentRuntime: Event.None,
			probeEngines: async (host: string) => {
				if (host === 'gpu-ubuntu-01') {
					return ['claude', 'codex', 'kilo'];
				}
				return ['claude', 'codex', 'gemini', 'kilo'];
			},
			probeModels: async (_host: string, engine: string) => {
				if (engine === 'claude') {
					return {
						models: ['anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4-6'],
						efforts: ['low', 'medium', 'high', 'max'],
					};
				}
				return {
					models: ['openai/gpt-5.3-codex', 'anthropic/claude-opus-4-6', 'deepseek/deepseek-reasoner'],
					efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
				};
			},
		} as unknown as IAdeControlCenterService;

		const storage = store.add(new InMemoryStorageService());
		const hostCatalog = store.add(new AdeMissionHostCatalog(storage, undefined, fakeCloudHostService, undefined, fakeControlCenter));

		const popovers = store.add(new AdeMissionPopovers(bodyEl, hostCatalog, {
			getProjectSnapshot: () => currentSnap,
			onCreateAgent: async () => currentSnap.agents[0],
			onEditAgent: async input => {
				editCalls.push(input);
				currentSnap = {
					...currentSnap,
					agents: currentSnap.agents.map(ag => ag.agent_id !== input.agentId ? ag : {
						...ag,
						...(input.host !== undefined ? { host: input.host } : {}),
						...(input.engine !== undefined ? { engine: input.engine as IAdeAgentNode['engine'] } : {}),
						...(input.model !== undefined ? { model: input.model } : {}),
						...(input.effort !== undefined ? { effort: input.effort } : {}),
					}),
				};
				return currentSnap.agents.find(a => a.agent_id === input.agentId);
			},
			onOpenAgentSession: (agentId, side) => {
				openSessionCalls.push({ agentId, side });
			},
			onManageCloudHosts: () => {
				manageCloudHostsCount++;
			},
		}));

		const renderer = store.add(new AdeMissionCanvasRenderer(worldEl, emptyHintEl, hostCatalog, {
			onHoverNode: nodeId => renderer.setHoveredNode(nodeId),
			onSelectNode: (nodeId, additive) => {
				if (!additive) {
					selectedNodeIds.clear();
				}
				if (nodeId) {
					selectedNodeIds.add(nodeId);
				}
				renderer.setSelectedState(selectedNodeIds, undefined);
			},
			onOpenModelPopover: (nodeId, agent, eng, anchorEl, opts) => {
				popovers.openModelPopover(nodeId, agent, eng, anchorEl, opts);
			},
			onOpenEffortPopover: (nodeId, agent, eng, anchorEl, opts) => {
				popovers.openEffortPopover(nodeId, agent, eng, anchorEl, opts);
			},
			onOpenEnginePopover: (nodeId, agent, eng, anchorEl, opts) => {
				popovers.openEnginePopover(nodeId, agent, eng, anchorEl, opts);
			},
			onOpenHostPopover: (nodeId, agent, rawHost, anchorEl, opts) => {
				popovers.openHostPopover(nodeId, agent, rawHost, anchorEl, opts);
			},
			onOpenStaffEditPopover: (node, anchorEl) => {
				const ag = currentSnap.agents.find(a => a.agent_id === node.id);
				if (ag) {
					popovers.openEditAgentPopover(currentSnap, ag, anchorEl);
				}
			},
			onOpenWhiteboardPopover: (wb, _anchorEl, opts) => {
				openWbCalls.push({ boardId: wb.board_id, initialTag: opts?.initialTag });
			},
			onOpenAgentSession: (agentId, side) => {
				openSessionCalls.push({ agentId, side });
			},
			onStartNodeDrag: () => {
				dragStartCount++;
			},
			onDragNodeMove: () => { },
			onEndNodeDrag: () => { },
			getNodePosition: () => undefined,
			getZoom: () => 1,
		}));

		const renderSnapshot = (nextUsage?: Map<string, IAdeAgentContextUsage>) => {
			if (nextUsage) {
				contextUsageByAgentId = nextUsage;
			}
			const graph = buildProjectOrchestrationGraph(currentSnap);
			const positions = computeOrchestrationLayoutPositions(graph.nodes, graph.edges, graph.departments, {
				mode: 'td',
				direction: 'TD',
			});
			renderer.syncGraph({
				direction: 'TD',
				layoutMode: 'td',
				nodes: graph.nodes,
				edges: graph.edges,
				departments: graph.departments,
				positions,
				agentNodesById: new Map(currentSnap.agents.map(a => [a.agent_id, a])),
				whiteboardsById: new Map(currentSnap.whiteboards.map(w => [w.board_id, w])),
				tickets: currentSnap.tickets,
				contextUsageByAgentId,
			});
		};

		renderSnapshot();

		return {
			bodyEl,
			viewportEl,
			marqueeBoxEl,
			worldEl,
			renderer,
			popovers,
			hostCatalog,
			editCalls,
			openSessionCalls,
			openWbCalls,
			selectedNodeIds,
			getDragStartCount: () => dragStartCount,
			getManageCloudHostsCount: () => manageCloudHostsCount,
			renderSnapshot,
		};
	}

	test('1. Real 344x188 geometry & hitboxes: all 4 config pills + edit gear + open-chat button are distinct enabled native <button>s inside card bounds with zero vertical clipping', () => {
		const { renderer } = mountInteractiveCanvas();
		const cardEl = renderer.getCardElement('agent_l2');
		assert.ok(cardEl, 'Started L2 staff card must be mounted');

		const cardRect = cardEl.getBoundingClientRect();
		assert.strictEqual(Math.round(cardRect.width), ORCH_STAFF_CARD_WIDTH);
		assert.strictEqual(Math.round(cardRect.height), ORCH_STAFF_CARD_HEIGHT);
		const coreWell = cardEl.querySelector<HTMLElement>('.ade-mission-core-well')!;
		assert.ok(coreWell.scrollHeight <= coreWell.clientHeight + 1, `Core well must not clip vertically (${coreWell.scrollHeight} <= ${coreWell.clientHeight})`);
		const footer = cardEl.querySelector<HTMLElement>('.ade-mission-node-footer')!;
		assert.ok(footer.getBoundingClientRect().bottom <= cardRect.bottom, 'Card footer must fit cleanly inside 188px card height');

		const modelPill = cardEl.querySelector<HTMLButtonElement>('button.ade-mission-model-pill')!;
		const effortPill = cardEl.querySelector<HTMLButtonElement>('button.ade-mission-thinking-tag')!;
		const enginePill = cardEl.querySelector<HTMLButtonElement>('button.ade-mission-engine-pill')!;
		const hostPill = cardEl.querySelector<HTMLButtonElement>('button.ade-mission-host-pill')!;
		const editBtn = cardEl.querySelector<HTMLButtonElement>('button.ade-orch-card-edit-btn')!;
		const openChatBtn = cardEl.querySelector<HTMLButtonElement>('button.ade-orch-open-chat-btn')!;

		for (const [name, btn] of [
			['modelPill', modelPill],
			['effortPill', effortPill],
			['enginePill', enginePill],
			['hostPill', hostPill],
			['editBtn', editBtn],
			['openChatBtn', openChatBtn],
		] as const) {
			assert.ok(btn, `${name} must exist as a native button`);
			assert.strictEqual(btn.tagName, 'BUTTON', `${name} must be <button>`);
			assert.strictEqual(btn.disabled, false, `${name} must NOT be disabled even when session_started === true`);
			assert.strictEqual(btn.getAttribute('data-ade-card-interactive'), 'true');
			assert.ok(btn.matches(ADE_CARD_INTERACTIVE_SELECTOR));

			const { cx, cy, rect } = centerOf(btn);
			assert.ok(rect.width >= 16 && rect.height >= 16, `${name} must have a real clickable hitbox (${rect.width}x${rect.height})`);
			assert.ok(rect.left >= cardRect.left && rect.right <= cardRect.right + 1, `${name} must not overflow horizontally`);
			assert.ok(rect.top >= cardRect.top && rect.bottom <= cardRect.bottom + 1, `${name} must not overflow vertically`);

			const hit = mainWindow.document.elementFromPoint(cx, cy);
			assert.strictEqual(hit?.closest('button'), btn, `elementFromPoint center of ${name} must resolve to ${name}`);
		}

		assert.strictEqual(rectsOverlap(modelPill.getBoundingClientRect(), effortPill.getBoundingClientRect()), false, 'Model pill and Thinking Effort pill must be physically separate');
		assert.strictEqual(rectsOverlap(enginePill.getBoundingClientRect(), hostPill.getBoundingClientRect()), false, 'Engine pill and Host pill must be physically separate');
		assert.strictEqual(rectsOverlap(editBtn.getBoundingClientRect(), openChatBtn.getBoundingClientRect()), false, 'Edit button and Open Chat button must be physically separate');
	});

	test('2. Real pointer sequence on Model & Thinking Effort pills opens dedicated in-place popovers and triggers 0 session jumps even on rapid double-click', async () => {
		const { renderer, popovers, editCalls, openSessionCalls, getDragStartCount } = mountInteractiveCanvas();
		const cardEl = renderer.getCardElement('agent_l2')!;

		const modelPill = cardEl.querySelector<HTMLButtonElement>('button.ade-mission-model-pill')!;
		const effortPill = cardEl.querySelector<HTMLButtonElement>('button.ade-mission-thinking-tag')!;

		const modelCenter = centerOf(modelPill);
		dispatchRealClickSequenceAt(modelCenter.cx, modelCenter.cy);
		await new Promise(r => setTimeout(r, 0));

		assert.strictEqual(popovers.isOpen(), true, 'Model popover must open on single click');
		assert.strictEqual(popovers.popoverEl.classList.contains('is-model-popover'), true);
		assert.ok(popovers.popoverEl.querySelector('[data-ade-quick-model-search="true"]'), 'Model popover must provide real-time search');
		assert.ok(popovers.popoverEl.querySelector('[data-ade-select-group="Anthropic"]'), 'Model popover must render real vendor group headers');
		assert.strictEqual(openSessionCalls.length, 0, 'Clicking Model pill must NEVER open chat session');
		assert.strictEqual(getDragStartCount(), 0, 'Clicking Model pill must NEVER trigger card pointer-capture drag');

		const opusOption = popovers.popoverEl.querySelector<HTMLButtonElement>('[data-ade-model-option="anthropic/claude-opus-4-6"]')!;
		assert.ok(opusOption, 'Real probed Anthropic model must be selectable');
		opusOption.click();
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(editCalls.length, 1);
		assert.strictEqual(editCalls[0].agentId, 'agent_l2');
		assert.strictEqual(editCalls[0].model, 'anthropic/claude-opus-4-6');
		assert.strictEqual(popovers.isOpen(), false);

		const effortCenter = centerOf(effortPill);
		dispatchRealClickSequenceAt(effortCenter.cx, effortCenter.cy);
		await new Promise(r => setTimeout(r, 0));

		assert.strictEqual(popovers.isOpen(), true, 'Dedicated Effort popover must open on single click');
		assert.strictEqual(popovers.popoverEl.classList.contains('is-effort-popover'), true);
		const xhighBtn = popovers.popoverEl.querySelector<HTMLButtonElement>('[data-ade-effort-option="xhigh"]')!;
		assert.ok(xhighBtn, 'Engine-supported xhigh effort option must be listed');
		xhighBtn.click();
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(editCalls.length, 2);
		assert.strictEqual(editCalls[1].effort, 'xhigh');
		assert.strictEqual(openSessionCalls.length, 0, 'Clicking Thinking Effort pill must NEVER open chat session');

		popovers.close();
		dispatchRealDoubleClickSequenceAt(modelCenter.cx, modelCenter.cy);
		popovers.close();
		dispatchRealDoubleClickSequenceAt(effortCenter.cx, effortCenter.cy);
		assert.strictEqual(openSessionCalls.length, 0, 'Rapid double-clicking Model or Effort pill must trigger 0 chat session jumps');
		assert.strictEqual(getDragStartCount(), 0);
	});

	test('3. Real pointer sequence on Engine, Host & Edit buttons (session_started === true) opens popovers with session-reset notice and triggers 0 session jumps', async () => {
		const { renderer, popovers, editCalls, openSessionCalls, getDragStartCount, getManageCloudHostsCount } = mountInteractiveCanvas();
		await new Promise(r => setTimeout(r, 15));
		const cardEl = renderer.getCardElement('agent_l2')!;

		const enginePill = cardEl.querySelector<HTMLButtonElement>('button.ade-mission-engine-pill')!;
		const hostPill = cardEl.querySelector<HTMLButtonElement>('button.ade-mission-host-pill')!;
		const editBtn = cardEl.querySelector<HTMLButtonElement>('button.ade-orch-card-edit-btn')!;

		const engCenter = centerOf(enginePill);
		dispatchRealClickSequenceAt(engCenter.cx, engCenter.cy);
		await new Promise(r => setTimeout(r, 0));

		assert.strictEqual(popovers.isOpen(), true, 'Engine quick popover must open even when session_started === true');
		assert.ok(popovers.popoverEl.querySelector('[data-ade-session-reset-banner="true"]'), 'Engine popover must display session-reset notice when session_started === true');
		const claudeOpt = popovers.popoverEl.querySelector<HTMLButtonElement>('[data-ade-engine-option="claude"]')!;
		assert.ok(claudeOpt && claudeOpt.disabled === false, 'Installed Claude engine option must be clickable');
		claudeOpt.click();
		await new Promise(r => setTimeout(r, 0));

		assert.strictEqual(editCalls.length, 1);
		assert.strictEqual(editCalls[0].engine, 'claude');
		assert.strictEqual(editCalls[0].allowSessionReset, true);
		assert.strictEqual(openSessionCalls.length, 0);

		const hostCenter = centerOf(hostPill);
		dispatchRealClickSequenceAt(hostCenter.cx, hostCenter.cy);
		await new Promise(r => setTimeout(r, 0));

		assert.strictEqual(popovers.isOpen(), true, 'Host quick popover must open on single click');
		assert.strictEqual(popovers.popoverEl.classList.contains('is-host-popover'), true);
		assert.ok(popovers.popoverEl.querySelector('[data-ade-session-reset-banner="true"]'), 'Host popover must display session-reset notice when session_started === true');
		const gpuHostOpt = popovers.popoverEl.querySelector<HTMLButtonElement>('[data-ade-host-option="gpu-ubuntu-01"]')!;
		assert.ok(gpuHostOpt, 'SSH cloud host gpu-ubuntu-01 must be listed in Host quick popover');
		gpuHostOpt.click();
		await new Promise(r => setTimeout(r, 0));

		assert.strictEqual(editCalls.length, 2);
		assert.strictEqual(editCalls[1].host, 'gpu-ubuntu-01');
		assert.strictEqual(editCalls[1].allowSessionReset, true);
		assert.strictEqual(openSessionCalls.length, 0);

		dispatchRealClickSequenceAt(hostCenter.cx, hostCenter.cy);
		const manageBtn = popovers.popoverEl.querySelector<HTMLButtonElement>('[data-ade-manage-cloud-hosts="true"]')!;
		assert.ok(manageBtn);
		manageBtn.click();
		assert.strictEqual(getManageCloudHostsCount(), 1);
		assert.strictEqual(popovers.isOpen(), false);

		const editCenter = centerOf(editBtn);
		dispatchRealClickSequenceAt(editCenter.cx, editCenter.cy);
		assert.strictEqual(popovers.isOpen(), true);
		assert.ok(popovers.popoverEl.querySelector('[data-ade-agent-edit-form="agent_l2"]'));
		popovers.close();

		dispatchRealDoubleClickSequenceAt(engCenter.cx, engCenter.cy);
		popovers.close();
		dispatchRealDoubleClickSequenceAt(hostCenter.cx, hostCenter.cy);
		popovers.close();
		dispatchRealDoubleClickSequenceAt(editCenter.cx, editCenter.cy);
		popovers.close();

		assert.strictEqual(openSessionCalls.length, 0, 'Zero accidental chat jumps across Engine, Host, and Edit button double-clicks');
		assert.strictEqual(getDragStartCount(), 0);
	});

	test('4. Single-click ONLY selects & real two-click sequence (with 80ms delay + 2px jitter) reliably enters Staff session and opens Whiteboard across all non-pill surfaces', async () => {
		const { renderer, popovers, openSessionCalls, openWbCalls, selectedNodeIds, getDragStartCount } = mountInteractiveCanvas();
		const staffCard = renderer.getCardElement('agent_l2')!;
		const staffNode = staffCard.parentElement!;
		const wbCard = renderer.getCardElement('wb_sec')!;
		assert.strictEqual(Math.round(wbCard.getBoundingClientRect().width), ORCH_WHITEBOARD_CARD_WIDTH);
		assert.strictEqual(Math.round(wbCard.getBoundingClientRect().height), ORCH_WHITEBOARD_CARD_HEIGHT);

		const iconWell = staffCard.querySelector<HTMLElement>('.ade-mission-core-icon-well')!;
		const titleEl = staffCard.querySelector<HTMLElement>('.ade-mission-node-title')!;
		const roleEl = staffCard.querySelector<HTMLElement>('.ade-mission-core-context')!;
		const statusStrip = staffCard.querySelector<HTMLElement>('.ade-mission-node-status-strip')!;
		const ctxRow = staffCard.querySelector<HTMLElement>('.ade-mission-ctx-row')!;

		for (const [surfaceName, el] of [
			['iconWell', iconWell],
			['titleEl', titleEl],
			['roleEl', roleEl],
			['statusStrip', statusStrip],
			['ctxRow', ctxRow],
		] as const) {
			openSessionCalls.length = 0;
			selectedNodeIds.clear();
			const { cx, cy } = centerOf(el);

			// Click #1: MUST ONLY select the card — 0 popovers, 0 sessions, 0 premature `.dragging`!
			dispatchRealClickSequenceAt(cx, cy, 1);
			assert.strictEqual(selectedNodeIds.has('agent_l2'), true, `Single-clicking ${surfaceName} must select the card`);
			assert.strictEqual(popovers.isOpen(), false, `Single-clicking ${surfaceName} must NEVER open any popover`);
			assert.strictEqual(openSessionCalls.length, 0, `Single-clicking ${surfaceName} must NOT enter session prematurely`);
			assert.strictEqual(staffNode.classList.contains('dragging'), false, `Single-clicking ${surfaceName} must NOT apply .dragging`);
			assert.strictEqual(getDragStartCount(), 0, `Single-clicking ${surfaceName} without >5px movement must NOT start drag`);

			// Click #2 (80ms later with 2px natural hand jitter, WITHOUT dispatching synthetic dblclick):
			// MUST reliably enter employee session once!
			await new Promise(r => setTimeout(r, 80));
			dispatchRealClickSequenceAt(cx + 2, cy + 1, 2);
			assert.strictEqual(openSessionCalls.length, 1, `Two-click sequence on ${surfaceName} must enter employee session once`);
			assert.deepStrictEqual(openSessionCalls[0], { agentId: 'agent_l2', side: false });

			// Wait past 220ms dedup window before testing next surface
			await new Promise(r => setTimeout(r, 230));
		}

		// Whiteboard card: Click #1 ONLY selects, Click #2 opens whiteboard panel!
		const wbTitle = wbCard.querySelector<HTMLElement>('.ade-mission-node-title')!;
		const wbCenter = centerOf(wbTitle);
		dispatchRealClickSequenceAt(wbCenter.cx, wbCenter.cy, 1);
		assert.strictEqual(selectedNodeIds.has('wb_sec'), true, 'Single-clicking whiteboard card must select it');
		assert.strictEqual(openWbCalls.length, 0, 'Single-clicking whiteboard card body must NOT pop open panel prematurely');

		await new Promise(r => setTimeout(r, 75));
		dispatchRealClickSequenceAt(wbCenter.cx + 2, wbCenter.cy, 2);
		assert.strictEqual(openWbCalls.length, 1, 'Double-clicking whiteboard card body must open whiteboard panel once');
		assert.strictEqual(openWbCalls[0].boardId, 'wb_sec');
	});

	test('5. Kali blue OS icon, Node-Hover flowing edge animation, Canvas zoom sensitivity, and Live Context Usage (CTX) telemetry', async () => {
		const { renderer, viewportEl, marqueeBoxEl, worldEl, renderSnapshot } = mountInteractiveCanvas();
		await new Promise(r => setTimeout(r, 25));
		renderSnapshot();

		// (a) Kali Linux host (`10.0.12.77` -> `kali-redteam-01`) renders vivid blue SVG circle + dragon & friendly displayHost
		const l2Card = renderer.getCardElement('agent_l2')!;
		const hostPill = l2Card.querySelector<HTMLButtonElement>('button.ade-mission-host-pill')!;
		assert.ok(hostPill.classList.contains('os-kali'), `Expected os-kali on host pill, got ${hostPill.className}`);
		const kaliSvg = hostPill.querySelector('svg');
		assert.ok(kaliSvg, 'Kali host pill must render an inline SVG icon');
		const kaliBlueCircle = kaliSvg.querySelector('circle[fill="#2563eb"]');
		assert.ok(kaliBlueCircle, 'Kali SVG must embed vivid blue background circle (#2563eb) so it is never white-on-transparent');
		assert.ok(!hostPill.textContent?.includes('10.0.12.77'), `Host pill should display friendly name/alias instead of raw IP, got "${hostPill.textContent}"`);

		// (b) Hovering over `agent_l1` lights up connected edge with `.is-hover-flow` + `.ade-mission-edge-hover-stream` at full opacity
		renderer.setHoveredNode('agent_l1');
		assert.strictEqual(worldEl.classList.contains('has-node-hover'), true);
		const edgeHandle = renderer.getAllEdgeHandles().find(h => !h.isWhiteboardLink && h.fromId === 'agent_l1' && h.toId === 'agent_l2');
		assert.ok(edgeHandle, 'Staff edge handle agent_l1 -> agent_l2 must exist');
		assert.strictEqual(edgeHandle.group.classList.contains('is-hover-flow'), true, 'Hovered node edge must gain .is-hover-flow');
		assert.strictEqual(edgeHandle.group.classList.contains('is-outgoing'), true);
		assert.ok(edgeHandle.hoverStreamPath.getAttribute('d')?.startsWith('M '), 'Hover stream path must sync edge geometry');
		const computedGroupOpacity = Number(mainWindow.getComputedStyle(edgeHandle.group).opacity);
		assert.strictEqual(computedGroupOpacity, 1, 'Hovered edge group must NOT be dimmed to 0.72');
		renderer.setHoveredNode(undefined);
		assert.strictEqual(edgeHandle.group.classList.contains('is-hover-flow'), false);

		// (c) Responsive trackpad pinch & mouse wheel zoom sensitivity
		let camZoom = 1;
		let camPan = { x: 80, y: 72 };
		const subStore = store.add(new DisposableStore());
		installEngineeringCanvasInteractions(
			{
				viewportEl,
				marqueeBoxEl,
				getZoom: () => camZoom,
				getPan: () => camPan,
				setCamera: (nx, ny, nz) => {
					camPan = { x: nx, y: ny };
					camZoom = nz;
				},
				getNodes: () => [],
				getPositions: () => new Map(),
				getSelectedNodeIds: () => new Set(),
				setSelectedNodesAndEdge: () => { },
				onBlankCanvasClick: () => { },
				onBlankCanvasContextMenu: () => { },
				onDismissTransientContextMenuOnly: () => { },
				onUpdateLivePositions: () => { },
				onRenderSnapGuides: () => { },
				onCommitPositionsChange: () => { },
				onSetConnectPreview: () => { },
				onReparentAgent: () => { },
				onSpawnSubordinateAtWorldPos: () => { },
			},
			subStore,
			{ minZoom: 0.25, maxZoom: 2.5 },
		);
		viewportEl.dispatchEvent(new mainWindow.WheelEvent('wheel', {
			bubbles: true,
			cancelable: true,
			ctrlKey: true,
			deltaY: -40,
			clientX: 400,
			clientY: 300,
		}));
		assert.ok(camZoom > 1.45, `Trackpad pinch (-40 deltaY) must zoom briskly (>1.45x), got ${camZoom.toFixed(3)}`);

		// (d) Live Session Context Window Usage (`CTX`) meter across unused -> normal -> warn -> critical
		const l1Card = renderer.getCardElement('agent_l1')!;
		const l1CtxRow = l1Card.querySelector<HTMLElement>('[data-ade-ctx-meter="agent_l1"]')!;
		assert.ok(l1CtxRow.classList.contains('is-unused'), 'Unstarted L1 card CTX meter must be marked is-unused');
		assert.strictEqual(l1CtxRow.querySelector('.ade-mission-ctx-pct')?.textContent, '0%');

		recordAdeTurnContextUsage({
			projectId: 'proj_human_feel',
			agentId: 'agent_l2',
			nativeSessionId: 'sess_l2_live',
			usage: { inputTokens: 36_000, cacheReadTokens: 10_000, outputTokens: 2_500, totalTokens: 48_500 },
		});
		const usageMap = new Map<string, IAdeAgentContextUsage>();
		usageMap.set('agent_l2', buildContextUsageSnapshot({
			usedTokens: 48_500,
			model: 'anthropic/claude-sonnet-4-6',
			engine: 'codex',
			inputTokens: 36_000,
			cacheReadTokens: 10_000,
			outputTokens: 2_500,
		}));
		renderSnapshot(usageMap);

		const l2CtxRow = l2Card.querySelector<HTMLElement>('[data-ade-ctx-meter="agent_l2"]')!;
		assert.strictEqual(l2CtxRow.getAttribute('data-ctx-severity'), 'normal');
		assert.strictEqual(l2CtxRow.querySelector('.ade-mission-ctx-tokens')?.textContent, '48.5K/200K');
		assert.strictEqual(l2CtxRow.querySelector('.ade-mission-ctx-pct')?.textContent, '24%');

		usageMap.set('agent_l2', buildContextUsageSnapshot({
			usedTokens: 156_000,
			model: 'anthropic/claude-sonnet-4-6',
			engine: 'codex',
		}));
		renderSnapshot(usageMap);
		assert.strictEqual(l2CtxRow.getAttribute('data-ctx-severity'), 'warn');
		assert.strictEqual(l2CtxRow.querySelector('.ade-mission-ctx-pct')?.textContent, '78%');

		usageMap.set('agent_l2', buildContextUsageSnapshot({
			usedTokens: 188_000,
			model: 'anthropic/claude-sonnet-4-6',
			engine: 'codex',
		}));
		renderSnapshot(usageMap);
		assert.strictEqual(l2CtxRow.getAttribute('data-ctx-severity'), 'critical');
		assert.strictEqual(l2CtxRow.querySelector('.ade-mission-ctx-pct')?.textContent, '94%');
	});
});
