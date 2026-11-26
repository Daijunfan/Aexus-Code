/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IAdeControlCenterService,
	IAdeUiWhiteboardInspection,
	IAdeWbItemsFilter,
} from '../../../../../platform/ade/common/adeControlCenterIpc.js';
import {
	canonicalEdgePairKey,
	IAdeAgentNode,
	IAdeProjectSnapshot,
} from '../../../../../platform/ade/common/adeModels.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { AdeEdgeTicketHistoryPopover } from '../../browser/adeEdgeTicketHistoryPopover.js';
import { AdeGlassSelect, buildModelGlassSelectItem } from '../../browser/adeGlassSelect.js';
import { AdeMissionHostCatalog } from '../../browser/adeMissionHostCatalog.js';
import { AdeMissionPopovers } from '../../browser/adeMissionPopovers.js';
import { AdeWhiteboardPopover } from '../../browser/adeWhiteboardPopover.js';

function makeAgent(overrides: Partial<IAdeAgentNode> & { readonly agent_id: string; readonly name: string }): IAdeAgentNode {
	const now = 1_764_090_000_000;
	return {
		project_id: 'proj_glass',
		level: 1,
		is_top_role: false,
		parent_id: null,
		role_summary: 'Owner',
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

function makeSnapshot(): IAdeProjectSnapshot {
	const now = 1_764_090_000_000;
	const l1 = makeAgent({
		agent_id: 'agent_l1',
		name: 'Chief Architect',
		level: 1,
		is_top_role: true,
		parent_id: null,
	});
	const l2Started = makeAgent({
		agent_id: 'agent_l2',
		name: 'Systems Engineer',
		level: 2,
		is_top_role: false,
		parent_id: 'agent_l1',
		engine: 'codex',
		model: 'openai/gpt-5.3-codex',
		session_phase: 'started',
		session_started: true,
	});
	const l3Fresh = makeAgent({
		agent_id: 'agent_l3',
		name: 'QA Specialist',
		level: 3,
		is_top_role: false,
		parent_id: 'agent_l2',
		engine: 'kilo',
		model: 'deepseek/deepseek-reasoner',
		session_phase: 'unstarted',
		session_started: false,
	});

	return {
		meta: {
			project_id: 'proj_glass',
			folder_id: 'fld_glass',
			folder_uri: 'file:///workspace/glass',
			name: 'Glass Select Suite',
			cross_host_ticket_storage: 'local',
			ticket_migration_epoch: 0,
			ticket_migration_state: 'idle',
			layout_direction: 'TD',
			created_at: now,
			updated_at: now,
		},
		hosts: [
			{
				host_id: 'h_gpu_a',
				ip: '10.0.8.10',
				ssh_alias: 'gpu-node-a',
				name: 'GPU Node A',
				os_kind: 'linux',
			},
		],
		agents: [l1, l2Started, l3Fresh],
		deleted_agents: [],
		departments: [
			{
				dept_id: 'dept_core',
				project_id: 'proj_glass',
				name: 'Core Platform',
				root_agent_id: 'agent_l2',
				parent_dept_id: null,
				board_permissions: { wb_core: 'read_write' },
				created_by: 'agent_l1',
				created_at: now,
				updated_at: now,
			},
			{
				dept_id: 'dept_qa',
				project_id: 'proj_glass',
				name: 'Quality Engineering',
				root_agent_id: 'agent_l3',
				parent_dept_id: null,
				board_permissions: {},
				created_by: 'agent_l1',
				created_at: now,
				updated_at: now,
			},
		],
		whiteboards: [
			{
				board_id: 'wb_core',
				project_id: 'proj_glass',
				name: 'Core Spec Board',
				owner_id: 'agent_l1',
				dept_id: 'dept_core',
				storage_host: 'local',
				migration_epoch: 0,
				migration_state: 'idle',
				tag_categories: ['API', 'Perf'],
				created_at: now,
				updated_at: now,
			},
		],
		board_grants: [],
		tickets: [],
		edge_latest_transfer_at: {},
	};
}

suite('AdeGlassSelect & Zero Native Select Suite', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createTestRoot(): HTMLElement {
		const root = append(mainWindow.document.body, $('div.ade-glass-select-test-root'));
		root.style.position = 'relative';
		root.style.width = '1200px';
		root.style.height = '800px';
		store.add(toDisposable(() => root.remove()));
		return root;
	}

	test('1. buildModelGlassSelectItem classifies all 12 vendor groups while preserving rawModelId verbatim', () => {
		const cases: ReadonlyArray<{ readonly raw: string; readonly expectedGroup: string }> = [
			{ raw: 'anthropic/claude-sonnet-4-6', expectedGroup: 'Anthropic' },
			{ raw: 'claude-opus-4-5', expectedGroup: 'Anthropic' },
			{ raw: 'openai/gpt-5.4', expectedGroup: 'OpenAI' },
			{ raw: 'o3', expectedGroup: 'OpenAI' },
			{ raw: 'google/gemini-3.1-pro', expectedGroup: 'Google' },
			{ raw: 'deepseek/deepseek-reasoner', expectedGroup: 'DeepSeek' },
			{ raw: 'qwen/qwen3-coder-plus', expectedGroup: 'Qwen' },
			{ raw: 'moonshot/kimi-k2.5', expectedGroup: 'Moonshot' },
			{ raw: 'zhipu/glm-5', expectedGroup: 'Zhipu' },
			{ raw: 'minimax/MiniMax-M1', expectedGroup: 'MiniMax' },
			{ raw: 'xai/grok-4.5', expectedGroup: 'xAI' },
			{ raw: 'meta-llama/llama-4-maverick', expectedGroup: 'Meta' },
			{ raw: 'mistralai/codestral-latest', expectedGroup: 'Mistral' },
			{ raw: 'internal-finetune-70b-v2', expectedGroup: 'Custom' },
		];

		for (const c of cases) {
			const item = buildModelGlassSelectItem(c.raw);
			assert.strictEqual(item.value, c.raw, `value must remain 100% identical for ${c.raw}`);
			assert.strictEqual(item.group, c.expectedGroup, `expected group ${c.expectedGroup} for ${c.raw}`);
			assert.ok(item.label.length > 0);
			assert.ok(item.description && item.description.length > 0);
		}
	});

	test('2. Model search filtering, vendor group headers, auto >=8 search threshold, and orphan-free disposal', () => {
		const root = createTestRoot();
		const modelIds = [
			'anthropic/claude-sonnet-4-6',
			'anthropic/claude-haiku-4-5',
			'openai/gpt-5.3-codex',
			'openai/o3',
			'deepseek/deepseek-reasoner',
			'google/gemini-3.1-pro',
			'qwen/qwen3-coder-plus',
			'zhipu/glm-5',
			'local-custom-ckpt',
		];

		const select = store.add(new AdeGlassSelect({
			container: root,
			portalContainer: root,
			items: modelIds.map(id => buildModelGlassSelectItem(id)),
			value: 'anthropic/claude-sonnet-4-6',
		}));

		assert.strictEqual(root.querySelectorAll('select').length, 0);
		select.open();

		const portal = root.querySelector<HTMLElement>('[data-ade-select-portal="true"]');
		assert.ok(portal, 'Portal should mount on portalContainer');
		assert.strictEqual(portal.style.position, 'fixed');
		assert.strictEqual(portal.style.zIndex, '10050');

		// >= 8 items automatically renders search input
		const searchInput = portal.querySelector<HTMLInputElement>('[data-ade-select-search="true"]');
		assert.ok(searchInput, 'Search input must auto-enable when items.length >= 8');

		const initialGroups = [...portal.querySelectorAll<HTMLElement>('[data-ade-select-group]')].map(el => el.dataset.adeSelectGroup);
		assert.deepStrictEqual(initialGroups, ['Anthropic', 'OpenAI', 'DeepSeek', 'Google', 'Qwen', 'Zhipu', 'Custom']);

		// Filter by keyword "deepseek"
		searchInput.value = 'deepseek';
		searchInput.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));

		const filteredGroups = [...portal.querySelectorAll<HTMLElement>('[data-ade-select-group]')].map(el => el.dataset.adeSelectGroup);
		assert.deepStrictEqual(filteredGroups, ['DeepSeek']);
		const filteredOptions = [...portal.querySelectorAll<HTMLButtonElement>('[data-ade-select-option]')];
		assert.strictEqual(filteredOptions.length, 1);
		assert.strictEqual(filteredOptions[0].dataset.adeSelectOption, 'deepseek/deepseek-reasoner');

		// Click filtered option -> value preserves exact raw ID
		filteredOptions[0].click();
		assert.strictEqual(select.value, 'deepseek/deepseek-reasoner');
		assert.strictEqual((select.triggerEl as unknown as { value: string }).value, 'deepseek/deepseek-reasoner');
		assert.strictEqual(root.querySelectorAll('[data-ade-select-portal="true"]').length, 0, 'Portal must unmount after selection');

		// Re-open and dispose directly -> zero orphan portal nodes
		select.open();
		assert.strictEqual(root.querySelectorAll('[data-ade-select-portal="true"]').length, 1);
		select.dispose();
		assert.strictEqual(root.querySelectorAll('[data-ade-select-portal="true"]').length, 0, 'Zero orphan portal after dispose');
	});

	test('3. Portal click does NOT dismiss useCapture=true parent Popovers, two-stage Escape, wheel stopPropagation, and .value/change shim', async () => {
		const bodyEl = createTestRoot();
		const snap = makeSnapshot();
		const storage = store.add(new InMemoryStorageService());

		let lastFilter: IAdeWbItemsFilter | undefined;
		const fakeControlCenter = {
			_serviceBrand: undefined,
			onDidChangeProjectSnapshot: Event.None,
			onDidTransferTicket: Event.None,
			onDidEnqueueOutbox: Event.None,
			onDidCancelOutboxTickets: Event.None,
			onDidDisposeAgentRuntime: Event.None,
			probeEngines: async () => ['claude', 'codex', 'kilo'],
			probeModels: async () => ({
				models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5.3-codex', 'deepseek/deepseek-reasoner'],
				efforts: ['low', 'medium', 'high'],
			}),
			uiInspectWhiteboard: async (_pid: string, _bid: string, filter?: IAdeWbItemsFilter): Promise<IAdeUiWhiteboardInspection> => {
				lastFilter = filter;
				return {
					board: snap.whiteboards[0],
					members: [{ agent_id: 'agent_l1', name: 'Chief Architect', permission: 'owner' }],
					items: [],
					notes: [],
				};
			},
			uiInspectEdgeTransfers: async () => [],
		} as unknown as IAdeControlCenterService;

		const hostCatalog = store.add(new AdeMissionHostCatalog(storage, undefined, undefined, undefined, fakeControlCenter));
		const wbPopover = store.add(new AdeWhiteboardPopover(
			bodyEl,
			fakeControlCenter,
			hostCatalog,
			undefined,
			undefined,
			{
				getProjectId: () => 'proj_glass',
				getProjectSnapshot: () => snap,
			},
		));
		const edgePopover = store.add(new AdeEdgeTicketHistoryPopover(
			bodyEl,
			fakeControlCenter,
			undefined,
			{
				getProjectId: () => 'proj_glass',
				getProjectSnapshot: () => snap,
			},
		));

		let parentWheelCount = 0;
		store.add(addDisposableListener(bodyEl, EventType.WHEEL, () => {
			parentWheelCount++;
		}));

		const anchor = append(bodyEl, $('div'));
		await wbPopover.open(snap.whiteboards[0], anchor);
		assert.strictEqual(wbPopover.isOpen(), true);

		// Zero native <select> on Items tab (5 filters)
		assert.strictEqual(wbPopover.popoverEl.querySelectorAll('select').length, 0);
		assert.strictEqual(wbPopover.popoverEl.querySelectorAll('button.ade-glass-select-trigger').length, 5);

		// Open stars dropdown and simulate capture-phase pointerdown + wheel + click inside portal
		const starsTrigger = wbPopover.popoverEl.querySelector<HTMLButtonElement>('[data-ade-wb-filter-stars="true"]')!;
		assert.ok(starsTrigger);
		starsTrigger.click();

		const portal = bodyEl.querySelector<HTMLElement>('[data-ade-select-portal="true"]')!;
		assert.ok(portal, 'Stars portal should be open');

		// Also verify AdeEdgeTicketHistoryPopover useCapture=true guard ignores portal pointerdown
		const pairKey = canonicalEdgePairKey('agent_l1', 'agent_l2');
		await edgePopover.openForEdge(pairKey, 300, 200);
		assert.strictEqual(edgePopover.isClickPopoverOpen(), true);

		const opt5 = portal.querySelector<HTMLButtonElement>('[data-ade-select-option="5"]')!;
		assert.ok(opt5);
		opt5.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { bubbles: true }));
		assert.strictEqual(wbPopover.isOpen(), true, 'useCapture=true WhiteboardPopover MUST NOT close when clicking inside select portal');
		assert.strictEqual(edgePopover.isClickPopoverOpen(), true, 'useCapture=true EdgeTicketHistoryPopover MUST NOT close when clicking inside select portal');

		// Wheel inside portal must not propagate to canvas/bodyEl
		portal.dispatchEvent(new mainWindow.WheelEvent('wheel', { deltaY: 120, bubbles: true }));
		assert.strictEqual(parentWheelCount, 0, 'Wheel inside portal must call stopPropagation()');

		// Two-stage Escape: 1st Escape closes ONLY the select portal; 2nd Escape closes WhiteboardPopover
		edgePopover.closeClickPopover();
		portal.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.strictEqual(bodyEl.querySelectorAll('[data-ade-select-portal="true"]').length, 0, '1st Escape must close select portal');
		assert.strictEqual(wbPopover.isOpen(), true, '1st Escape must keep parent Popover open');

		wbPopover.popoverEl.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.strictEqual(wbPopover.isOpen(), false, '2nd Escape must close parent Popover');

		// Re-open WhiteboardPopover to verify backward-compatible .value assignment + change event shim & Settings tab zero <select>
		await wbPopover.open(snap.whiteboards[0], anchor);
		const starsCompat = wbPopover.popoverEl.querySelector<HTMLSelectElement>('[data-ade-wb-filter-stars="true"]')!;
		starsCompat.value = '3-5';
		starsCompat.dispatchEvent(new mainWindow.Event('change'));
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(lastFilter?.stars, '3-5');

		const settingsTab = wbPopover.popoverEl.querySelector<HTMLButtonElement>('[data-ade-wb-tab="settings"]')!;
		settingsTab.click();
		assert.strictEqual(wbPopover.popoverEl.querySelectorAll('select').length, 0, 'Zero native <select> on Settings tab');
		assert.ok(wbPopover.popoverEl.querySelector('button.ade-glass-select-trigger[data-ade-wb-storage-host-select="true"]'));
	});

	test('4. All 11 AdeMissionPopovers selects render zero <select>, enforce session_started engine lock with codicon-lock, and enable searchable model picker', async () => {
		const bodyEl = createTestRoot();
		const snap = makeSnapshot();
		const storage = store.add(new InMemoryStorageService());
		const fakeControlCenter = {
			_serviceBrand: undefined,
			onDidChangeProjectSnapshot: Event.None,
			onDidTransferTicket: Event.None,
			onDidEnqueueOutbox: Event.None,
			onDidCancelOutboxTickets: Event.None,
			onDidDisposeAgentRuntime: Event.None,
			probeEngines: async () => ['claude', 'codex', 'kilo'],
			probeModels: async () => ({
				models: ['anthropic/claude-sonnet-4-6', 'openai/gpt-5.3-codex', 'deepseek/deepseek-reasoner'],
				efforts: ['low', 'medium', 'high'],
			}),
		} as unknown as IAdeControlCenterService;

		const hostCatalog = store.add(new AdeMissionHostCatalog(storage, undefined, undefined, undefined, fakeControlCenter));
		const popovers = store.add(new AdeMissionPopovers(bodyEl, hostCatalog, {
			getProjectSnapshot: () => snap,
			onCreateAgent: async () => snap.agents[0],
			onEditAgent: async () => snap.agents[1],
			onCreateDepartment: async () => snap.departments[0],
			onEditDepartment: async () => snap.departments[0],
			onToggleDepartmentMember: async () => snap.departments[0],
			onDeleteDepartment: async () => undefined,
			onCreateWhiteboard: async () => snap.whiteboards[0],
		}));
		const anchor = append(bodyEl, $('div'));

		// (a) Create Subordinate Agent: 4 selects (parent, host, engine, model), zero <select>, searchable model select
		popovers.openCreateAgentPopover({ snapshot: snap, defaultParentId: 'agent_l1' }, { anchorEl: anchor });
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(popovers.popoverEl.querySelectorAll('select').length, 0);
		assert.strictEqual(popovers.popoverEl.querySelectorAll('button.ade-glass-select-trigger').length, 4);

		const createModelTrigger = popovers.popoverEl.querySelector<HTMLButtonElement>('[data-ade-create-model="true"]')!;
		createModelTrigger.click();
		const createModelPortal = bodyEl.querySelector<HTMLElement>('[data-ade-select-portal="true"]')!;
		assert.ok(createModelPortal.querySelector('[data-ade-select-search="true"]'), 'Create agent model select must explicitly enable search');

		// Two-stage Escape on AdeMissionPopovers
		createModelPortal.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.strictEqual(bodyEl.querySelectorAll('[data-ade-select-portal="true"]').length, 0);
		assert.strictEqual(popovers.isOpen(), true);
		popovers.popoverEl.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.strictEqual(popovers.isOpen(), false);

		// (b) Edit Agent with session_started === true: 3 unlocked AdeGlassSelects (host, engine, model), zero <select>, and session-reset notice on change
		const startedAgent = snap.agents.find(a => a.agent_id === 'agent_l2')!;
		popovers.openEditAgentPopover(snap, startedAgent, anchor);
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(popovers.popoverEl.querySelectorAll('select').length, 0);
		assert.strictEqual(popovers.popoverEl.querySelectorAll('button.ade-glass-select-trigger').length, 3);

		const editHostTrigger = popovers.popoverEl.querySelector<HTMLButtonElement>('[data-ade-edit-host="true"]')!;
		const editEngineTrigger = popovers.popoverEl.querySelector<HTMLButtonElement>('[data-ade-edit-engine="true"]')!;
		const editResetNotice = popovers.popoverEl.querySelector<HTMLElement>('[data-ade-edit-reset-notice="true"]')!;
		assert.strictEqual(editHostTrigger.disabled, false);
		assert.strictEqual(editEngineTrigger.disabled, false);
		assert.strictEqual(editResetNotice.hidden, true);
		editHostTrigger.click();
		const gpuHostOpt = bodyEl.querySelector<HTMLButtonElement>('[data-ade-select-portal="true"] [data-ade-select-value="gpu-node-a"]');
		assert.ok(gpuHostOpt, 'Host AdeGlassSelect portal must list SSH cloud hosts');
		gpuHostOpt.click();
		assert.strictEqual(editResetNotice.hidden, false, 'Switching host on started agent must reveal fresh-session notice');

		// Edit Agent model select remains unlocked and explicitly searchable
		const editModelTrigger = popovers.popoverEl.querySelector<HTMLButtonElement>('[data-ade-edit-model="true"]')!;
		assert.strictEqual(editModelTrigger.disabled, false);
		editModelTrigger.click();
		assert.ok(bodyEl.querySelector('[data-ade-select-portal="true"] [data-ade-select-search="true"]'));
		popovers.close();
		assert.strictEqual(bodyEl.querySelectorAll('[data-ade-select-portal="true"]').length, 0);

		// Verify AdeGlassSelect disabled lock contract directly
		const lockedContainer = append(bodyEl, $('div'));
		const lockedSelect = store.add(new AdeGlassSelect({
			container: lockedContainer,
			portalContainer: bodyEl,
			items: [{ value: 'v1', label: 'Locked Option' }],
			value: 'v1',
			disabled: true,
		}));
		assert.strictEqual(lockedSelect.triggerEl.disabled, true);
		assert.ok(lockedSelect.triggerEl.querySelector('.codicon-lock'), 'Disabled AdeGlassSelect must display codicon-lock');
		lockedSelect.triggerEl.click();
		assert.strictEqual(bodyEl.querySelectorAll('[data-ade-select-portal="true"]').length, 0);

		// (c) Create Department (1 select)
		popovers.openCreateDepartmentPopover(snap, { anchorEl: anchor });
		assert.strictEqual(popovers.popoverEl.querySelectorAll('select').length, 0);
		assert.strictEqual(popovers.popoverEl.querySelectorAll('button.ade-glass-select-trigger').length, 1);

		// (d) Edit Department with bound whiteboard (1 permission select)
		popovers.openEditDepartmentPopover(snap, snap.departments[0], 'cyan', { anchorEl: anchor });
		assert.strictEqual(popovers.popoverEl.querySelectorAll('select').length, 0);
		assert.strictEqual(popovers.popoverEl.querySelectorAll('button.ade-glass-select-trigger').length, 1);

		// (e) Create Whiteboard (3 selects: owner, dept, storageHost)
		popovers.openCreateWhiteboardPopover(snap, { anchorEl: anchor });
		assert.strictEqual(popovers.popoverEl.querySelectorAll('select').length, 0);
		assert.strictEqual(popovers.popoverEl.querySelectorAll('button.ade-glass-select-trigger').length, 3);
		popovers.close();
	});
});
