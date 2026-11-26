/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAdeCloudHost, IAdeCloudHostBackendService } from '../../../../../platform/ade/common/adeCloudHosts.js';
import { IAdeControlCenterService } from '../../../../../platform/ade/common/adeControlCenterIpc.js';
import {
	canonicalEdgePairKey,
	IAdeAgentNode,
	IAdeEdgeTransferRecord,
	IAdeProjectSnapshot,
	IAdeTicketTransferAnimationEvent,
	IAdeUiTicketFullInspection,
} from '../../../../../platform/ade/common/adeModels.js';
import {
	buildProjectOrchestrationGraph,
	computeOrchestrationAnchorPoint,
	computeOrchestrationLayoutPositions,
	computeOrchestrationMultiAnchorRoutes,
	detourPolylineAroundPillBoxes,
	IMissionEdgeObstacle,
	IMissionNodePosition,
	ORCH_RIGID_STUB_LENGTH,
	ORCH_STAFF_CARD_HEIGHT,
	ORCH_STAFF_CARD_WIDTH,
	ORCH_STAFF_EDGE_OUTSET,
	ORCH_WHITEBOARD_CARD_HEIGHT,
	ORCH_WHITEBOARD_CARD_WIDTH,
	ORCH_WHITEBOARD_EDGE_OUTSET,
	reanchorOrchestrationRoute,
	satisfiesRigidNormalStubs,
} from '../../../../../platform/ade/common/adeOrchestrationLayout.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { EditorInputCapabilities } from '../../../../common/editor.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import '../../browser/media/adeMissionCanvas.css';
import '../../browser/media/adeMissionEdges.css';
import '../../browser/media/adeMissionCards.css';
import '../../browser/media/adeMissionOverlays.css';
import {
	AdeEdgeTicketHistoryPopover,
	formatEdgeTransferTimestamp,
} from '../../browser/adeEdgeTicketHistoryPopover.js';
import {
	AdeEngineeringEditorInput,
	AdeEngineeringEditorPane,
	AdeEngineeringEditorSerializer,
} from '../../browser/adeEngineeringEditorPane.js';
import { AdeEngineeringGraphActions } from '../../browser/adeEngineeringGraphActions.js';
import {
	buildBlankCanvasContextMenuItems,
	buildDepartmentContextMenuItems,
	buildStaffNodeContextMenuItems,
	buildWhiteboardNodeContextMenuItems,
	EngineeringHistoryStore,
	installEngineeringCanvasInteractions,
} from '../../browser/adeEngineeringViewLinkage.js';
import {
	ADE_TICKET_FLOW_DURATION_MS,
	computeRelaySegmentDurations,
	IAdeTicketFlowClock,
} from '../../browser/adeMissionCanvasEdgeRouter.js';
import { AdeMissionCanvasRenderer } from '../../browser/adeMissionCanvasRenderer.js';
import { AdeMissionHostCatalog } from '../../browser/adeMissionHostCatalog.js';
import { AdeMissionMinimap } from '../../browser/adeMissionMinimap.js';
import { AdeMissionPopovers } from '../../browser/adeMissionPopovers.js';
import { AdeMissionStoreService, IAdeMissionService } from '../../browser/adeMissionStore.js';
import { AdeProjectsService } from '../../browser/adeProjectsService.js';
import {
	configureAdeProjectTicketStorage,
	confirmAndDeleteAdeProjectPage,
	promptRenameAdeProjectPage,
} from '../../browser/adeProjectsView.js';
import {
	ADE_CONFIGURE_PROJECT_STORAGE_COMMAND_ID,
	ADE_DELETE_PROJECT_PAGE_COMMAND_ID,
	ADE_PROJECTS_VIEW_ID,
	ADE_RENAME_PROJECT_PAGE_COMMAND_ID,
	AdeAgentStatus,
	buildAdeEmployeeSessionUri,
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectsService,
} from '../../common/ade.js';
import { setAdeDisplayLanguageOverride } from '../../common/adeLocalization.js';

class FakeTicketFlowClock implements IAdeTicketFlowClock {
	private currentMs = 10_000;
	private nextHandle = 1;
	private readonly callbacks = new Map<number, (frameTime: number) => void>();

	now(): number {
		return this.currentMs;
	}

	setNow(ms: number): void {
		this.currentMs = ms;
	}

	requestFrame(callback: (frameTime: number) => void): number {
		const id = this.nextHandle++;
		this.callbacks.set(id, callback);
		return id;
	}

	cancelFrame(handle: number): void {
		this.callbacks.delete(handle);
	}

	hasPendingFrames(): boolean {
		return this.callbacks.size > 0;
	}

	stepTo(targetMs: number): void {
		this.currentMs = targetMs;
		const batch = [...this.callbacks.entries()];
		this.callbacks.clear();
		for (const [, cb] of batch) {
			cb(this.currentMs);
		}
	}
}

function makeAgentNode(overrides: Partial<IAdeAgentNode> & { readonly agent_id: string; readonly name: string }): IAdeAgentNode {
	const now = 1_764_065_445_000;
	return {
		project_id: 'proj_gate8',
		level: 1,
		is_top_role: false,
		parent_id: null,
		role_summary: 'Engineering specialist',
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

function makeTreeSnapshot(): IAdeProjectSnapshot {
	const now = 1_764_065_445_000;
	const l1 = makeAgentNode({
		agent_id: 'agent_l1_lead',
		name: 'L1 Lead',
		level: 1,
		is_top_role: true,
		parent_id: null,
	});
	const l2 = makeAgentNode({
		agent_id: 'agent_l2_mgr',
		name: 'L2 Manager',
		level: 2,
		parent_id: 'agent_l1_lead',
		session_phase: 'started',
		session_started: true,
		host: '10.0.0.8',
	});
	const l3 = makeAgentNode({
		agent_id: 'agent_l3_dev',
		name: 'L3 Developer',
		level: 3,
		parent_id: 'agent_l2_mgr',
	});
	return {
		meta: {
			project_id: 'proj_gate8',
			folder_id: 'fld_gate8',
			folder_uri: 'file:///workspace/gate8',
			name: 'Gate 8 Project',
			cross_host_ticket_storage: 'local',
			ticket_migration_epoch: 0,
			ticket_migration_state: 'idle',
			layout_direction: 'TD',
			created_at: now,
			updated_at: now,
		},
		hosts: [
			{
				host_id: 'h_1',
				ip: '10.0.0.8',
				name: 'Build Server',
				ssh_alias: 'build-01',
				os_kind: 'linux',
			},
		],
		agents: [l1, l2, l3],
		deleted_agents: [
			{
				agent_id: 'agent_l4_old',
				project_id: 'proj_gate8',
				name: 'Archived Researcher',
				level: 4,
				role_summary: 'Legacy PoC',
				host: 'local',
				deleted_at: now - 10_000,
			},
		],
		departments: [
			{
				dept_id: 'dept_core',
				project_id: 'proj_gate8',
				name: 'Core Systems',
				root_agent_id: 'agent_l2_mgr',
				parent_dept_id: null,
				board_permissions: { wb_core: 'read_write' },
				created_by: 'agent_l1_lead',
				created_at: now,
				updated_at: now,
			},
		],
		whiteboards: [
			{
				board_id: 'wb_core',
				project_id: 'proj_gate8',
				name: 'Core Whiteboard',
				owner_id: 'agent_l2_mgr',
				dept_id: 'dept_core',
				storage_host: 'local',
				tag_categories: ['Spec'],
				migration_epoch: 0,
				migration_state: 'idle',
				created_at: now,
				updated_at: now,
			},
		],
		board_grants: [],
		tickets: [],
		edge_latest_transfer_at: {
			[canonicalEdgePairKey('agent_l1_lead', 'agent_l2_mgr')]: now,
		},
	};
}

suite('Gate 8: Bidirectional 22px Rigid-Stub Edges, Strict 3000ms Relay Flow & Hover/Click Popovers', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function mountTestCanvas() {
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
		const viewportEl = append(bodyEl, $('.ade-mission-viewport'));
		viewportEl.style.width = '1280px';
		viewportEl.style.height = '800px';
		const worldEl = append(viewportEl, $('.ade-mission-world.ade-eng-world'));
		const emptyHintEl = append(viewportEl, $('.ade-mission-empty-hint'));
		const marqueeBoxEl = append(viewportEl, $('.ade-mission-marquee'));
		marqueeBoxEl.hidden = true;
		store.add({ dispose: () => workbench.remove() });
		return { workbench, editorEl, bodyEl, viewportEl, worldEl, emptyHintEl, marqueeBoxEl };
	}

	test('1. All staff edges bind constant-pixel userSpaceOnUse markers at both ends, zero <title>, pointer hit cursor, and zero one-way/delete-edge menus', () => {
		const { worldEl, emptyHintEl } = mountTestCanvas();
		const storage = store.add(new InMemoryStorageService());
		const hostCatalog = store.add(new AdeMissionHostCatalog(storage, undefined, undefined, undefined, undefined));
		const renderer = store.add(new AdeMissionCanvasRenderer(worldEl, emptyHintEl, hostCatalog, {
			onHoverNode: id => renderer.setHoveredNode(id),
			onOpenModelPopover: () => { },
			onOpenEnginePopover: () => { },
			onOpenAgentSession: () => { },
			onStartNodeDrag: () => { },
			onDragNodeMove: () => { },
			onEndNodeDrag: () => { },
			getNodePosition: () => undefined,
			getZoom: () => 1,
		}));

		const snap = makeTreeSnapshot();
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
			tickets: [],
		});

		const svg = renderer.getEdgesSvgElement();
		const markers = Array.from(svg.querySelectorAll('defs > marker'));
		assert.ok(markers.length >= 3, 'Expected SVG arrow markers in <defs>');
		for (const m of markers) {
			assert.strictEqual(m.getAttribute('markerUnits'), 'userSpaceOnUse');
			assert.strictEqual(m.getAttribute('viewBox'), '0 0 10 10');
			assert.strictEqual(m.getAttribute('markerWidth'), '8.5');
			assert.strictEqual(m.getAttribute('markerHeight'), '8.5');
			assert.strictEqual(m.getAttribute('refX'), '8.8');
			assert.strictEqual(m.getAttribute('refY'), '5');
			assert.strictEqual(m.getAttribute('orient'), 'auto-start-reverse');
		}

		// Zero native <title> anywhere in edges SVG (`plan.md` §8.4.1)
		assert.strictEqual(svg.querySelectorAll('title').length, 0);

		const handles = renderer.getAllEdgeHandles();
		const staffHandles = handles.filter(h => !h.isWhiteboardLink);
		const wbHandles = handles.filter(h => h.isWhiteboardLink);

		// N = 3 staff nodes -> strictly N - 1 = 2 direct reporting tree edges
		assert.strictEqual(staffHandles.length, 2);
		for (const h of staffHandles) {
			assert.strictEqual(h.group.getAttribute('data-bidirectional'), 'true');
			assert.ok(h.path.getAttribute('marker-start')?.startsWith('url(#ade-mission-arrow-'));
			assert.ok(h.path.getAttribute('marker-end')?.startsWith('url(#ade-mission-arrow-'));
			assert.ok(h.hitPath, 'Staff edge must expose 14px hit path');
			const hitCursor = mainWindow.getComputedStyle(h.hitPath).cursor;
			assert.strictEqual(hitCursor, 'pointer');
		}

		// Selection widens stroke without altering markerUnits="userSpaceOnUse"
		renderer.setSelectedState(new Set(), staffHandles[0].edgePairKey);
		assert.strictEqual(staffHandles[0].path.getAttribute('marker-start'), 'url(#ade-mission-arrow-active)');
		assert.strictEqual(staffHandles[0].path.getAttribute('marker-end'), 'url(#ade-mission-arrow-active)');

		// Hovering a node activates .is-hover-flow overlay stream on connected edges while keeping primary .ade-mission-edge-path solid bidirectional
		renderer.setHoveredNode('agent_l2_mgr');
		assert.strictEqual(svg.querySelectorAll('.is-hover-flow').length, 3);
		for (const h of staffHandles) {
			assert.strictEqual(mainWindow.getComputedStyle(h.path).strokeDasharray, 'none');
		}
		renderer.setHoveredNode(undefined);
		assert.strictEqual(svg.querySelectorAll('.is-hover-flow').length, 0);

		// Whiteboard dashed links have zero arrowheads
		assert.ok(wbHandles.length >= 1);
		for (const wh of wbHandles) {
			assert.strictEqual(wh.path.getAttribute('marker-start'), null);
			assert.strictEqual(wh.path.getAttribute('marker-end'), null);
		}

		// Verify context menus contain zero legacy one-way / edit-label / delete-edge actions
		const allMenuIds = [
			...buildBlankCanvasContextMenuItems({
				snapshot: snap,
				onCreateSoleTopRole: () => { },
				onCreateSubordinate: () => { },
				onCreateDepartment: () => { },
				onCreateWhiteboard: () => { },
				onFitView: () => { },
			}),
			...buildStaffNodeContextMenuItems({
				snapshot: snap,
				agent: snap.agents[2],
				onOpenSession: () => { },
				onEditAgent: () => { },
				onRecruitSubordinate: () => { },
				onCreateDepartmentHere: () => { },
				onRenameInline: () => { },
				onPickColor: () => { },
				onDeleteAgent: () => { },
			}),
			...buildWhiteboardNodeContextMenuItems({
				whiteboard: snap.whiteboards[0],
				onInspectWhiteboard: () => { },
				onRenameInline: () => { },
				onPickColor: () => { },
				onDeleteWhiteboard: () => { },
			}),
			...buildDepartmentContextMenuItems({
				snapshot: snap,
				department: snap.departments[0],
				onEditDepartment: () => { },
				onCreateDeptWhiteboard: () => { },
				onDissolveDepartment: () => { },
			}),
		].map(i => `${i.id}:${i.label.toLowerCase()}`);

		for (const item of allMenuIds) {
			assert.ok(!item.includes('one-way') && !item.includes('单向'), `Forbidden one-way menu: ${item}`);
			assert.ok(!item.includes('delete-edge') && !item.includes('删除边'), `Forbidden delete-edge menu: ${item}`);
			assert.ok(!item.includes('edit-label') && !item.includes('编辑边标签'), `Forbidden edit-label menu: ${item}`);
		}
	});

	test('2. Symmetric outset=6 (+5.66px arrow tip clearance) and 22px outward-normal rigid stubs hold under TD, LR, pill-box detour, and face-to-face card overlap', () => {
		assert.strictEqual(ORCH_STAFF_EDGE_OUTSET, 6);
		assert.strictEqual(ORCH_WHITEBOARD_EDGE_OUTSET, 0);
		assert.strictEqual(ORCH_RIGID_STUB_LENGTH, 22);

		// Marker geometry math: viewBox 10->8.5px (0.85x), refX=8.8, tipX=9.2 => tip extends 0.4 * 0.85 = 0.34px ahead of anchor
		// With outset = 6.0px, arrow tip sits at exact 6.0 - 0.34 = +5.66px outside 344x188 card border!
		const markerScale = 8.5 / 10;
		const tipForwardExtensionPx = (9.2 - 8.8) * markerScale;
		const tipClearanceOutsideCardBorder = ORCH_STAFF_EDGE_OUTSET - tipForwardExtensionPx;
		assert.ok(Math.abs(tipClearanceOutsideCardBorder - 5.66) < 1e-6);

		const snap = makeTreeSnapshot();
		const graph = buildProjectOrchestrationGraph(snap);

		const scenarios: {
			readonly name: string;
			readonly dir: 'TD' | 'LR';
			readonly positions: ReadonlyMap<string, IMissionNodePosition>;
		}[] = [
			{
				name: 'Standard TD',
				dir: 'TD',
				positions: computeOrchestrationLayoutPositions(graph.nodes, graph.edges, graph.departments, { mode: 'td', direction: 'TD' }),
			},
			{
				name: 'Standard LR',
				dir: 'LR',
				positions: computeOrchestrationLayoutPositions(graph.nodes, graph.edges, graph.departments, { mode: 'lr', direction: 'LR' }),
			},
			{
				name: 'Face-to-face 2px gap vertical & inverted child above parent',
				dir: 'TD',
				positions: new Map<string, IMissionNodePosition>([
					['agent_l1_lead', { x: 400, y: 400 }],
					['agent_l2_mgr', { x: 405, y: 400 + ORCH_STAFF_CARD_HEIGHT + 2 }],
					['agent_l3_dev', { x: 400, y: 260 }], // Inverted above L2!
					['wb_core', { x: 820, y: 420 }],
				]),
			},
			{
				name: 'Direct card-body overlap / collision under drag',
				dir: 'LR',
				positions: new Map<string, IMissionNodePosition>([
					['agent_l1_lead', { x: 300, y: 300 }],
					['agent_l2_mgr', { x: 320, y: 310 }], // Directly overlapping L1!
					['agent_l3_dev', { x: 300 - ORCH_STAFF_CARD_WIDTH + 12, y: 305 }], // Overlapping from left!
					['wb_core', { x: 330, y: 320 }],
				]),
			},
		];

		const nodesById = new Map(graph.nodes.map(n => [n.id, n]));
		const edgesById = new Map(graph.edges.map(e => [e.id, e]));

		for (const sc of scenarios) {
			const routedMap = computeOrchestrationMultiAnchorRoutes(
				graph.nodes,
				graph.edges,
				sc.positions,
				{ direction: sc.dir, layoutMode: sc.dir === 'LR' ? 'lr' : 'td' },
			);
			for (const r of routedMap.values()) {
				if (r.isWhiteboardLink) {
					continue;
				}
				const edgeObj = edgesById.get(r.edgeId)!;
				const fromPos = sc.positions.get(r.from)!;
				const toPos = sc.positions.get(r.to)!;
				const fa = r.fromAnchor;
				const ta = r.toAnchor;

				// Check exact +5.66px arrow tip clearance from 344x188 card outer border (pos is center coordinate)
				const checkTipClearance = (
					pos: IMissionNodePosition,
					side: typeof fa.side,
					anchor: { x: number; y: number; nx: number; ny: number },
				) => {
					const tipX = anchor.x - anchor.nx * tipForwardExtensionPx; // marker-start / marker-end points toward card
					const tipY = anchor.y - anchor.ny * tipForwardExtensionPx;
					const cardTop = pos.y - ORCH_STAFF_CARD_HEIGHT / 2;
					const cardBottom = pos.y + ORCH_STAFF_CARD_HEIGHT / 2;
					const cardLeft = pos.x - ORCH_STAFF_CARD_WIDTH / 2;
					const cardRight = pos.x + ORCH_STAFF_CARD_WIDTH / 2;
					const signedDist = side === 'top'
						? cardTop - tipY
						: side === 'bottom'
							? tipY - cardBottom
							: side === 'left'
								? cardLeft - tipX
								: tipX - cardRight;
					assert.ok(
						Math.abs(signedDist - 5.66) < 1e-4,
						`[${sc.name}] Expected +5.66px tip clearance on ${side}, got ${signedDist}`,
					);
				};
				checkTipClearance(fromPos, fa.side, fa);
				checkTipClearance(toPos, ta.side, ta);

				// Verify initial route, pill-box detour, and drag re-anchoring ALL preserve 22px outward-normal stubs
				assert.strictEqual(
					satisfiesRigidNormalStubs(r.points, fa, ta, ORCH_RIGID_STUB_LENGTH),
					true,
					`[${sc.name}] computeOrchestrationMultiAnchorRoutes violated 22px stub on ${r.edgeId}`,
				);

				const detoured = detourPolylineAroundPillBoxes(
					r.points,
					[{ minX: fa.x - 40, maxX: fa.x + 40, minY: fa.y + 4, maxY: fa.y + 32 }],
				);
				assert.strictEqual(
					satisfiesRigidNormalStubs(detoured.points, fa, ta, ORCH_RIGID_STUB_LENGTH),
					true,
					`[${sc.name}] detourPolylineAroundPillBoxes intruded into 22px stub on ${r.edgeId}`,
				);

				const reanchored = reanchorOrchestrationRoute(edgeObj, r, nodesById, sc.positions, []);
				assert.strictEqual(
					satisfiesRigidNormalStubs(reanchored.points, reanchored.fromAnchor, reanchored.toAnchor, ORCH_RIGID_STUB_LENGTH),
					true,
					`[${sc.name}] reanchorOrchestrationRoute violated 22px stub on ${r.edgeId}`,
				);

				// Explicitly assert outward-normal dot product > 0 (>= 22) on both first and last segments
				const pts = reanchored.points;
				const rfa = reanchored.fromAnchor;
				const rta = reanchored.toAnchor;
				const firstDot = (pts[1].x - pts[0].x) * rfa.nx + (pts[1].y - pts[0].y) * rfa.ny;
				const m = pts.length - 1;
				const lastOutDot = (pts[m - 1].x - pts[m].x) * rta.nx + (pts[m - 1].y - pts[m].y) * rta.ny;
				assert.ok(firstDot >= 21.999, `[${sc.name}] First stub dot product must be >= 22, got ${firstDot}`);
				assert.ok(lastOutDot >= 21.999, `[${sc.name}] Last stub dot product must be >= 22, got ${lastOutDot}`);
			}
		}
	});

	test('3. Strict 3000ms Ticket flow animation: cross-tier arc-length proportional relay, bidirectional concurrency, drag adherence, background reconcile, alive at 2999ms & cleared/stopped at 3001ms', () => {
		assert.strictEqual(ADE_TICKET_FLOW_DURATION_MS, 3000);

		const durs = computeRelaySegmentDurations([150, 450]);
		assert.strictEqual(durs.length, 2);
		assert.ok(Math.abs(durs[0] - 750) < 1e-9);
		assert.ok(Math.abs(durs[1] - 2250) < 1e-9);
		assert.strictEqual(durs[0] + durs[1], 3000);

		const { worldEl, emptyHintEl } = mountTestCanvas();
		const storage = store.add(new InMemoryStorageService());
		const hostCatalog = store.add(new AdeMissionHostCatalog(storage, undefined, undefined, undefined, undefined));
		const clock = new FakeTicketFlowClock();

		const renderer = store.add(new AdeMissionCanvasRenderer(
			worldEl,
			emptyHintEl,
			hostCatalog,
			{
				onHoverNode: () => { },
				onOpenModelPopover: () => { },
				onOpenEnginePopover: () => { },
				onOpenAgentSession: () => { },
				onStartNodeDrag: () => { },
				onDragNodeMove: () => { },
				onEndNodeDrag: () => { },
				getNodePosition: () => undefined,
				getZoom: () => 1,
			},
			clock,
		));

		const snap = makeTreeSnapshot();
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
			tickets: [],
		});

		const e12 = canonicalEdgePairKey('agent_l1_lead', 'agent_l2_mgr');
		const e23 = canonicalEdgePairKey('agent_l2_mgr', 'agent_l3_dev');

		// Cross-tier L1 -> L3 relay via L2 at t = 10_000ms
		clock.setNow(10_000);
		const relayEvent: IAdeTicketTransferAnimationEvent = {
			transfer_group_id: 'xfer_relay_1',
			project_id: 'proj_gate8',
			ticket_id: 'tk_relay',
			task_id: 'tsk_1',
			origin_from_id: 'agent_l1_lead',
			target_to_id: 'agent_l3_dev',
			transferred_at: 10_000,
			hops: [
				{ edge_pair_key: e12, hop_from_id: 'agent_l1_lead', hop_to_id: 'agent_l2_mgr', hop_seq: 1, total_hops: 2 },
				{ edge_pair_key: e23, hop_from_id: 'agent_l2_mgr', hop_to_id: 'agent_l3_dev', hop_seq: 2, total_hops: 2 },
			],
		};
		assert.strictEqual(renderer.triggerTicketTransferAnimation(relayEvent), true);

		// Still ONLY 2 staff edges in the DOM — zero cross-tier dashed edges spawned!
		assert.strictEqual(renderer.getAllEdgeHandles().filter(h => !h.isWhiteboardLink).length, 2);
		assert.strictEqual(renderer.ticketFlow.getActiveCount(), 1);
		assert.strictEqual(clock.hasPendingFrames(), true);

		// Concurrent reverse transfer L2 -> L1 on the same L1<->L2 edge at t = 10_500ms
		clock.stepTo(10_500);
		const reverseEvent: IAdeTicketTransferAnimationEvent = {
			transfer_group_id: 'xfer_rev_2',
			project_id: 'proj_gate8',
			ticket_id: 'tk_rev',
			task_id: 'tsk_2',
			origin_from_id: 'agent_l2_mgr',
			target_to_id: 'agent_l1_lead',
			transferred_at: 10_500,
			hops: [
				{ edge_pair_key: e12, hop_from_id: 'agent_l2_mgr', hop_to_id: 'agent_l1_lead', hop_seq: 1, total_hops: 1 },
			],
		};
		assert.strictEqual(renderer.triggerTicketTransferAnimation(reverseEvent), true);
		assert.strictEqual(renderer.ticketFlow.getActiveCount(), 2);

		const flowLayer = renderer.getEdgesSvgElement().querySelector('g.ade-ticket-flow-layer')!;
		assert.strictEqual(flowLayer.querySelectorAll('.ade-ticket-flow-particle').length, 2);
		assert.strictEqual(flowLayer.querySelectorAll('.ade-orch-live-puck-bloom, .ade-orch-live-puck-dot').length, 0, 'Zero mismatched legacy puck classes inside ticket flow particles');

		// Drag L2 card mid-flight and verify active particles snap to the updated path without dropping
		const l2Old = positions.get('agent_l2_mgr')!;
		const movedMap = new Map<string, IMissionNodePosition>([
			['agent_l2_mgr', { x: l2Old.x + 140, y: l2Old.y + 30 }],
		]);
		const coreBefore = flowLayer.querySelector('[data-transfer-id="xfer_relay_1"] .ade-ticket-flow-head')!.getAttribute('transform');
		renderer.updateDraggedNodesPositions(movedMap, 'agent_l2_mgr');
		const coreAfter = flowLayer.querySelector('[data-transfer-id="xfer_relay_1"] .ade-ticket-flow-head')!.getAttribute('transform');
		assert.notStrictEqual(coreAfter, coreBefore, 'Particle coordinates must follow dragged route on the same frame');

		// Simulate background tab hidden for 1800ms (t = 10_500 -> t = 12_300) and foreground reconcileNow()
		clock.setNow(12_300);
		renderer.ticketFlow.reconcileNow();
		assert.strictEqual(renderer.ticketFlow.getActiveCount(), 2);

		// At t = 10_000 + 2999 = 12_999ms: xfer_relay_1 MUST still be alive!
		clock.stepTo(12_999);
		assert.ok(flowLayer.querySelector('[data-transfer-id="xfer_relay_1"]'), 'Particle must remain alive at 2999ms');
		assert.strictEqual(renderer.ticketFlow.getActiveCount(), 2);

		// At t = 10_000 + 3001 = 13_001ms: xfer_relay_1 MUST be cleared while xfer_rev_2 (started at 10_500, elapsed=2501ms) stays alive!
		clock.stepTo(13_001);
		assert.strictEqual(flowLayer.querySelector('[data-transfer-id="xfer_relay_1"]'), null, 'Particle must be removed at 3001ms');
		assert.strictEqual(renderer.ticketFlow.getActiveCount(), 1);
		assert.strictEqual(clock.hasPendingFrames(), true);

		// At t = 10_500 + 2999 = 13_499ms: xfer_rev_2 still alive
		clock.stepTo(13_499);
		assert.strictEqual(renderer.ticketFlow.getActiveCount(), 1);

		// At t = 10_500 + 3001 = 13_501ms: pool hits 0, DOM is 100% clean, and shared rAF stops immediately!
		clock.stepTo(13_501);
		assert.strictEqual(renderer.ticketFlow.getActiveCount(), 0);
		assert.strictEqual(flowLayer.children.length, 0);
		assert.strictEqual(renderer.ticketFlow.isFrameLoopRunning(), false);
		assert.strictEqual(clock.hasPendingFrames(), false);
	});

	test('4. AdeEdgeTicketHistoryPopover: Hover shows ONLY timestamp, Click survives wheel & topology refresh, two-stage Escape, and renders untrusted Markdown safely', async () => {
		setAdeDisplayLanguageOverride('zh-cn');
		store.add({ dispose: () => setAdeDisplayLanguageOverride(undefined) });

		const { bodyEl, viewportEl, marqueeBoxEl } = mountTestCanvas();
		const snap = makeTreeSnapshot();
		const pair12 = canonicalEdgePairKey('agent_l1_lead', 'agent_l2_mgr');
		const pair23 = canonicalEdgePairKey('agent_l2_mgr', 'agent_l3_dev');
		const transferEpoch = 1_764_065_445_000;

		const records: IAdeEdgeTransferRecord[] = [
			{
				transfer_id: 'tr_destroyed',
				project_id: 'proj_gate8',
				edge_pair_key: pair12,
				hop_from_id: 'agent_l1_lead',
				hop_to_id: 'agent_l2_mgr',
				hop_seq: 1,
				total_hops: 2,
				origin_from_id: 'agent_l1_lead',
				origin_from_name: 'L1 Lead',
				target_to_id: 'agent_l3_dev',
				target_to_name: 'L3 Developer',
				ticket_id: 'tk_secret_999',
				task_id: 'tsk_002',
				action_kind: 'create',
				task_type: 'audit',
				task_title: 'Confidential Security Audit Title',
				summary: 'Confidential summary that must NEVER leak into Hover tip',
				has_detail_ref: true,
				ticket_status: 'destroyed',
				transferred_at: transferEpoch,
			},
			{
				transfer_id: 'tr_frozen',
				project_id: 'proj_gate8',
				edge_pair_key: pair12,
				hop_from_id: 'agent_l2_mgr',
				hop_to_id: 'agent_l1_lead',
				hop_seq: 1,
				total_hops: 1,
				origin_from_id: 'agent_l4_old',
				origin_from_name: '',
				target_to_id: 'agent_l1_lead',
				target_to_name: 'L1 Lead',
				ticket_id: 'tk_orphan_1',
				task_id: 'tsk_001',
				action_kind: 'edit',
				task_type: 'research',
				task_title: 'Orphaned Report',
				summary: 'Frozen after agent deletion',
				has_detail_ref: false,
				ticket_status: 'frozen_orphan',
				transferred_at: transferEpoch - 5_000,
			},
		];

		const fullInspection: IAdeUiTicketFullInspection = {
			public_ticket: {
				ticket_id: 'tk_secret_999',
				project_id: 'proj_gate8',
				creator_id: 'agent_l1_lead',
				ticket_level: 1,
				from_id: 'agent_l1_lead',
				to_id: 'agent_l3_dev',
				delivery_mode: 'steer',
				need_return: false,
				current_task: {
					task_id: 'tsk_002',
					task_type: 'audit',
					task_title: 'Confidential Security Audit Title',
					task_comment: {
						summary: 'Audit current task summary',
						has_detail_ref: true,
					},
				},
				has_history_ref: true,
			},
			status: 'destroyed',
			creator_name: 'L1 Lead',
			peer_id: 'agent_l3_dev',
			peer_name: 'L3 Developer',
			created_at: transferEpoch - 20_000,
			updated_at: transferEpoch,
			destroyed_at: transferEpoch + 1_000,
			all_tasks: [
				{
					task_id: 'tsk_001',
					seq: 1,
					is_archived: true,
					from_id: 'agent_l1_lead',
					from_name: 'L1 Lead',
					to_id: 'agent_l3_dev',
					to_name: 'L3 Developer',
					delivery_mode: 'queue',
					need_return: true,
					task_type: 'dev',
					task_title: 'Initial Hop',
					summary: 'First archived task',
					has_detail_ref: false,
					detail_truncated: false,
					created_at: transferEpoch - 20_000,
				},
				{
					task_id: 'tsk_002',
					seq: 2,
					is_archived: false,
					from_id: 'agent_l1_lead',
					from_name: 'L1 Lead',
					to_id: 'agent_l3_dev',
					to_name: 'L3 Developer',
					delivery_mode: 'steer',
					need_return: false,
					task_type: 'audit',
					task_title: 'Confidential Security Audit Title',
					summary: 'Audit current task summary',
					has_detail_ref: true,
					detail_truncated: false,
					created_at: transferEpoch,
				},
			],
		};

		const frozenInspection: IAdeUiTicketFullInspection = {
			public_ticket: {
				ticket_id: 'tk_orphan_1',
				project_id: 'proj_gate8',
				creator_id: 'agent_l4_old',
				ticket_level: 4,
				from_id: 'agent_l2_mgr',
				to_id: 'agent_l1_lead',
				delivery_mode: 'queue',
				need_return: false,
				current_task: {
					task_id: 'tsk_001',
					task_type: 'research',
					task_title: 'Orphaned Report',
					task_comment: {
						summary: 'Frozen after agent deletion',
						has_detail_ref: false,
					},
				},
				has_history_ref: false,
			},
			status: 'frozen_orphan',
			creator_name: 'Archived Researcher',
			peer_id: 'agent_l1_lead',
			peer_name: 'L1 Lead',
			created_at: transferEpoch - 15_000,
			updated_at: transferEpoch - 5_000,
			all_tasks: [
				{
					task_id: 'tsk_001',
					seq: 1,
					is_archived: false,
					from_id: 'agent_l2_mgr',
					from_name: 'L2 Manager',
					to_id: 'agent_l1_lead',
					to_name: 'L1 Lead',
					delivery_mode: 'queue',
					need_return: false,
					task_type: 'research',
					task_title: 'Orphaned Report',
					summary: 'Frozen after agent deletion',
					has_detail_ref: false,
					detail_truncated: false,
					created_at: transferEpoch - 5_000,
				},
			],
		};

		const fakeControlCenter = {
			getEdgeLatestTransferTime: async (_pid: string, key: string) => (key === pair12 ? transferEpoch : null),
			listEdgeTicketTransfers: async () => records,
			inspectTicketFullDetailForUi: async (_pid: string, ticketId: string) => (ticketId === 'tk_orphan_1' ? frozenInspection : fullInspection),
			readTicketTaskDetailForUi: async () => [
				'# Gunzipped Archived Detail',
				'<script>window.__pwned = true;</script>',
				'<img src="x" onerror="window.__pwned = true">',
				'[evil](javascript:alert(1))',
				'Verified safe gunzipped text.',
			].join('\n\n'),
		} as unknown as IAdeControlCenterService;

		const edgePop = store.add(new AdeEdgeTicketHistoryPopover(
			bodyEl,
			fakeControlCenter,
			undefined,
			{
				getProjectId: () => 'proj_gate8',
				getProjectSnapshot: () => snap,
			},
		));

		// Hover on edge without transfers
		edgePop.showHover(pair23, 300, 200);
		assert.strictEqual(edgePop.isHoverVisible(), true);
		assert.strictEqual(edgePop.hoverTipEl.style.pointerEvents, 'none');
		assert.strictEqual(edgePop.hoverTipEl.textContent, '暂无 Ticket 传递记录');

		// Hover on edge WITH transfers: ONLY timestamp, ZERO ticket_id / title / summary!
		edgePop.showHover(pair12, 320, 220);
		assert.strictEqual(edgePop.hoverTipEl.textContent, `最近传递：${formatEdgeTransferTimestamp(transferEpoch)}`);
		assert.ok(!edgePop.hoverTipEl.textContent.includes('tk_secret_999'));
		assert.ok(!edgePop.hoverTipEl.textContent.includes('Confidential'));

		// Install canvas wheel interactions to verify wheel zooming does NOT close Click popover!
		let cameraZoom = 1;
		const interactionDisposables = store.add(new (await import('../../../../../base/common/lifecycle.js')).DisposableStore());
		installEngineeringCanvasInteractions(
			{
				viewportEl,
				marqueeBoxEl,
				getZoom: () => cameraZoom,
				getPan: () => ({ x: 0, y: 0 }),
				setCamera: (_x, _y, z) => { cameraZoom = z; },
				getNodes: () => [],
				getPositions: () => new Map(),
				getSelectedNodeIds: () => new Set(),
				setSelectedNodesAndEdge: () => { },
				onBlankCanvasClick: () => edgePop.closeClickPopover(),
				onBlankCanvasContextMenu: () => { },
				onDismissTransientContextMenuOnly: () => edgePop.hideHover(),
				onUpdateLivePositions: () => { },
				onRenderSnapGuides: () => { },
				onCommitPositionsChange: () => { },
				onSetConnectPreview: () => { },
				onReparentAgent: () => { },
				onSpawnSubordinateAtWorldPos: () => { },
			},
			interactionDisposables,
			{ minZoom: 0.25, maxZoom: 2.5 },
		);

		// Open Click Popover -> Hover tip MUST auto-hide!
		await edgePop.openForEdge(pair12, 400, 240);
		assert.strictEqual(edgePop.isClickPopoverOpen(), true);
		assert.strictEqual(edgePop.isHoverVisible(), false);

		// Wheel on canvas viewport changes zoom AND keeps Click popover open!
		viewportEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }));
		assert.ok(cameraZoom > 1, 'Canvas wheel zoom should update camera');
		assert.strictEqual(edgePop.isClickPopoverOpen(), true, 'Canvas wheel zoom must NEVER close AdeEdgeTicketHistoryPopover');

		// Wheel inside Click popover stops propagation so cameraZoom does NOT change!
		const zoomBeforeInnerScroll = cameraZoom;
		edgePop.popoverEl.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true }));
		assert.strictEqual(cameraZoom, zoomBeforeInnerScroll, 'Scrolling inside popover must not zoom canvas');
		assert.strictEqual(edgePop.isClickPopoverOpen(), true);

		// Topology refresh (`notifyTopologyOrTransferUpdated`) updates in place without closing!
		edgePop.notifyTopologyOrTransferUpdated(new Set([pair12, pair23]));
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(edgePop.isClickPopoverOpen(), true);

		// Verify relay badge `[跨级途经 L1 → L3]`, deleted_agents name restoration (`Archived Researcher`), and `.status-frozen-orphan` badge CSS class
		assert.ok(edgePop.popoverEl.querySelector('[data-ade-relay-badge="true"]')?.textContent?.includes('L1 → L3'));
		assert.ok(edgePop.popoverEl.textContent?.includes('Archived Researcher'));
		const frozenRow = edgePop.popoverEl.querySelector<HTMLElement>('[data-ade-ticket-id="tk_orphan_1"]');
		assert.ok(frozenRow, 'Expected frozen_orphan transfer row in history list');
		const frozenListBadge = frozenRow.querySelector<HTMLElement>('.ade-edge-status-badge.status-frozen-orphan');
		assert.ok(frozenListBadge, 'frozen_orphan row must render .ade-edge-status-badge.status-frozen-orphan');
		assert.strictEqual(edgePop.popoverEl.querySelector('.ade-edge-status-badge.status-frozen'), null, 'Legacy misspelled .status-frozen class must never be rendered');

		// Verify detail view header also renders `.ade-edge-status-badge.status-frozen-orphan` for frozen_orphan ticket, then Escape back to list
		frozenRow.click();
		await new Promise(r => setTimeout(r, 0));
		assert.ok(
			edgePop.popoverEl.querySelector('.ade-edge-history-head .ade-edge-status-badge.status-frozen-orphan'),
			'frozen_orphan detail header must render .ade-edge-status-badge.status-frozen-orphan',
		);
		assert.strictEqual(edgePop.handleEscapeKey(), true);

		// Click into Level-2 Single-Ticket Full Detail Inspection
		const firstItem = edgePop.popoverEl.querySelector<HTMLElement>('[data-ade-ticket-id="tk_secret_999"]');
		assert.ok(firstItem);
		firstItem.click();
		await new Promise(r => setTimeout(r, 0));

		// Exact 10 standard public fields in Rebuild/Ticket.md:37-52 order (NO non-standard 'bound_pair' inside ten-fields grid!)
		const tenFieldsGrid = edgePop.popoverEl.querySelector('[data-ade-ticket-ten-fields="true"]')!;
		assert.ok(tenFieldsGrid);
		const fieldCells = Array.from(tenFieldsGrid.querySelectorAll('.ade-edge-field-cell'));
		assert.strictEqual(fieldCells.length, 10);
		const fieldKeys = fieldCells.map(c => c.getAttribute('data-ticket-field'));
		assert.deepStrictEqual(fieldKeys, [
			'ticket_id',
			'project_id',
			'creator_id',
			'ticket_level',
			'from_id',
			'to_id',
			'delivery_mode',
			'need_return',
			'current_task',
			'has_history_ref',
		]);
		assert.strictEqual(tenFieldsGrid.querySelector('[data-ticket-field="bound_pair"]'), null);
		const currentTaskVal = tenFieldsGrid.querySelector('[data-ticket-field="current_task"] .ade-edge-field-val')?.textContent;
		assert.strictEqual(currentTaskVal, 'tsk_002 (audit) · Confidential Security Audit Title');
		assert.ok(edgePop.popoverEl.querySelector('[data-ade-ticket-bound-pair="true"]')?.textContent?.includes('L1 Lead ↔ L3 Developer'));
		assert.ok(edgePop.popoverEl.querySelector('[data-ade-history-tasks="true"]')?.textContent?.includes('Initial Hop'));

		const mdWell = edgePop.popoverEl.querySelector('[data-ade-rendered-detail="tsk_002"] .ade-safe-markdown');
		assert.ok(mdWell, 'Destroyed ticket gunzipped detail should auto-expand');
		assert.strictEqual(mdWell.querySelectorAll('script').length, 0, 'XSS <script> must be stripped');
		assert.strictEqual(mdWell.querySelectorAll('img[onerror]').length, 0, 'XSS img[onerror] must be stripped');
		assert.strictEqual(mdWell.querySelectorAll('a[href^="javascript:"]').length, 0, 'javascript: links must be neutralized');
		assert.ok(mdWell.textContent?.includes('Verified safe gunzipped text.'));

		// Two-stage Escape: 1st Escape returns from detail -> list; 2nd Escape closes popover!
		assert.strictEqual(edgePop.handleEscapeKey(), true);
		assert.strictEqual(edgePop.isClickPopoverOpen(), true);
		assert.ok(edgePop.popoverEl.querySelector('[data-ade-edge-transfer-list="true"]'), '1st Escape should return to transfer list');

		assert.strictEqual(edgePop.handleEscapeKey(), true);
		assert.strictEqual(edgePop.isClickPopoverOpen(), false);
	});

	test('5. { v: 2, projectId } serializer, CanSplitInGroup, empty-canvas sole L1 onboarding, editable host & engine with session_started reset notice', async () => {
		const insta = workbenchInstantiationService(undefined, store);
		const serializer = new AdeEngineeringEditorSerializer();

		// Legacy v !== 2 payloads are synchronously discarded
		assert.strictEqual(serializer.deserialize(insta, ''), undefined);
		assert.strictEqual(serializer.deserialize(insta, 'not-json'), undefined);
		assert.strictEqual(serializer.deserialize(insta, JSON.stringify({ v: 1, projectId: 'proj_old' })), undefined);
		assert.strictEqual(serializer.deserialize(insta, JSON.stringify({ governorSessionId: 'gov_1' })), undefined);

		// Valid { v: 2, projectId } round-trips synchronously and supports side-by-side split
		const input = store.add(insta.createInstance(AdeEngineeringEditorInput, 'proj_alpha'));
		assert.strictEqual(input.resource.toString(), 'ade-project://proj_alpha/');
		assert.ok((input.capabilities & EditorInputCapabilities.CanSplitInGroup) !== 0);
		assert.strictEqual(input.capabilities & EditorInputCapabilities.Singleton, 0);

		const rawJson = serializer.serialize(input);
		assert.strictEqual(rawJson, JSON.stringify({ v: 2, projectId: 'proj_alpha' }));
		const restored = serializer.deserialize(insta, rawJson!);
		assert.ok(restored instanceof AdeEngineeringEditorInput);
		store.add(restored);
		assert.strictEqual(restored.projectId, 'proj_alpha');
		assert.strictEqual(restored.matches(input), true);

		// Empty canvas (`agents.length === 0`) renders sole L1 onboarding & locks L1 root creation
		const { bodyEl, worldEl, emptyHintEl } = mountTestCanvas();
		const storage = store.add(new InMemoryStorageService());
		const hostCatalog = store.add(new AdeMissionHostCatalog(storage, undefined, undefined, undefined, undefined));
		let triggeredEmptyL1 = false;
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
			onCreateSoleTopRoleFromEmptyHint: () => { triggeredEmptyL1 = true; },
		}));

		const emptySnap: IAdeProjectSnapshot = {
			...makeTreeSnapshot(),
			agents: [],
			departments: [],
			whiteboards: [],
		};
		renderer.syncGraph({
			direction: 'TD',
			layoutMode: 'td',
			nodes: [],
			edges: [],
			departments: [],
			positions: new Map(),
			agentNodesById: new Map(),
			whiteboardsById: new Map(),
			tickets: [],
		});
		assert.strictEqual(emptyHintEl.hidden, false);
		const createSoleL1Btn = emptyHintEl.querySelector<HTMLButtonElement>('[data-ade-create-sole-l1="true"]');
		assert.ok(createSoleL1Btn);
		createSoleL1Btn.click();
		assert.strictEqual(triggeredEmptyL1, true);

		// Popover verification: Sole L1 cascade + editable host/engine AdeGlassSelect with explicit session-reset notice on session_started
		let capturedEditPayload: Record<string, unknown> | undefined;
		const popovers = store.add(new AdeMissionPopovers(bodyEl, hostCatalog, {
			getProjectSnapshot: () => makeTreeSnapshot(),
			onCreateAgent: async () => makeTreeSnapshot().agents[0],
			onEditAgent: async input => {
				capturedEditPayload = input as unknown as Record<string, unknown>;
				return makeTreeSnapshot().agents[1];
			},
		}));

		popovers.openCreateAgentPopover({ snapshot: emptySnap }, { clientX: 200, clientY: 160 });
		assert.ok(popovers.popoverEl.querySelector('[data-ade-locked-sole-l1="true"]'));
		assert.strictEqual(popovers.popoverEl.querySelector('[data-ade-create-parent]'), null);

		const anchor = append(bodyEl, $('div'));
		const startedAgent = makeTreeSnapshot().agents[1]; // session_started === true
		popovers.openEditAgentPopover(makeTreeSnapshot(), startedAgent, anchor);
		const hostTrigger = popovers.popoverEl.querySelector<HTMLButtonElement>('button[data-ade-edit-host="true"]');
		const engineTrigger = popovers.popoverEl.querySelector<HTMLButtonElement>('button[data-ade-edit-engine="true"]');
		const resetNotice = popovers.popoverEl.querySelector<HTMLElement>('[data-ade-edit-reset-notice="true"]');
		assert.ok(hostTrigger && hostTrigger.disabled === false, 'Host AdeGlassSelect trigger must be editable');
		assert.ok(engineTrigger && engineTrigger.disabled === false, 'Engine AdeGlassSelect trigger must be editable even when session_started === true');
		assert.ok(resetNotice && resetNotice.hidden === true, 'Session reset notice starts hidden until host or engine changes');
		engineTrigger.click();
		const otherEngOpt = bodyEl.querySelector<HTMLButtonElement>('[data-ade-select-portal="true"] [data-ade-select-value="codex"]')
			?? bodyEl.querySelector<HTMLButtonElement>('[data-ade-select-portal="true"] [data-ade-select-value="kilo"]');
		assert.ok(otherEngOpt);
		otherEngOpt.click();
		assert.strictEqual(resetNotice.hidden, false, 'Changing engine on session_started agent reveals fresh-session notice');
		const saveBtn = popovers.popoverEl.querySelector<HTMLButtonElement>('[data-ade-edit-save="true"]');
		assert.ok(saveBtn);
		saveBtn.click();
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(capturedEditPayload?.allowSessionReset, true, 'Saving engine change on session_started agent must pass allowSessionReset: true');
		const legacyFieldKey = ['node', 'Prompts'].join('');
		assert.strictEqual(popovers.popoverEl.innerHTML.includes(legacyFieldKey), false, 'Zero legacy pre-prompt UI');
	});

	test('6. Defect #1 & #2 regressions: deleted_agents_archive from_name/to_name fallback without snapshot entry, switchLayoutDirection resetPinnedPositions + Undo, and toolbar non-overlapping creation', async () => {
		const { bodyEl } = mountTestCanvas();
		// Snapshot intentionally omits deleted ghost agents so resolveAgentDisplay MUST rely on backend-resolved fallback names!
		const bareSnap: IAdeProjectSnapshot = {
			...makeTreeSnapshot(),
			deleted_agents: [],
		};
		const pairKey = canonicalEdgePairKey('agent_l1_lead', 'agent_l2_mgr');
		const ts = 1_764_070_000_000;
		const orphanInspection: IAdeUiTicketFullInspection = {
			public_ticket: {
				ticket_id: 'tk_ghost_orphan',
				project_id: 'proj_gate8',
				creator_id: 'agent_ghost_creator',
				ticket_level: 2,
				from_id: 'agent_ghost_sender',
				to_id: 'agent_ghost_receiver',
				delivery_mode: 'queue',
				need_return: true,
				current_task: {
					task_id: 'tsk_cur_ghost',
					task_type: 'bugfix',
					task_title: 'Fix Orphan Fallback',
					task_comment: { summary: 'Verify fallback names', has_detail_ref: false },
				},
				has_history_ref: true,
			},
			status: 'frozen_orphan',
			creator_name: 'Ghost Creator Name',
			peer_id: 'agent_ghost_receiver',
			peer_name: 'Ghost Receiver Name',
			created_at: ts - 5000,
			updated_at: ts,
			frozen_at: ts,
			all_tasks: [
				{
					task_id: 'tsk_arch_ghost',
					seq: 1,
					is_archived: true,
					from_id: 'agent_ghost_creator',
					from_name: 'Ghost Creator Name',
					to_id: 'agent_ghost_receiver',
					to_name: 'Ghost Receiver Name',
					delivery_mode: 'queue',
					need_return: true,
					task_type: 'dev',
					task_title: 'Archived Ghost Hop',
					summary: 'Hop 1',
					has_detail_ref: false,
					detail_truncated: false,
					created_at: ts - 5000,
				},
				{
					task_id: 'tsk_cur_ghost',
					seq: 2,
					is_archived: false,
					from_id: 'agent_ghost_sender',
					from_name: 'Ghost Sender Name',
					to_id: 'agent_ghost_receiver',
					to_name: 'Ghost Receiver Name',
					delivery_mode: 'queue',
					need_return: true,
					task_type: 'bugfix',
					task_title: 'Fix Orphan Fallback',
					summary: 'Hop 2',
					has_detail_ref: false,
					detail_truncated: false,
					created_at: ts,
				},
			],
		};

		const ccStub = {
			getEdgeLatestTransferTime: async () => ts,
			listEdgeTicketTransfers: async (): Promise<readonly IAdeEdgeTransferRecord[]> => [{
				transfer_id: 'tr_ghost',
				project_id: 'proj_gate8',
				edge_pair_key: pairKey,
				hop_from_id: 'agent_ghost_sender',
				hop_to_id: 'agent_ghost_receiver',
				hop_seq: 1,
				total_hops: 1,
				origin_from_id: 'agent_ghost_sender',
				origin_from_name: 'Ghost Sender Name',
				target_to_id: 'agent_ghost_receiver',
				target_to_name: 'Ghost Receiver Name',
				ticket_id: 'tk_ghost_orphan',
				task_id: 'tsk_cur_ghost',
				action_kind: 'edit',
				task_type: 'bugfix',
				task_title: 'Fix Orphan Fallback',
				summary: 'Hop 2',
				has_detail_ref: false,
				ticket_status: 'frozen_orphan',
				transferred_at: ts,
			}],
			inspectTicketFullDetailForUi: async () => orphanInspection,
			readTicketTaskDetailForUi: async () => '',
		} as unknown as IAdeControlCenterService;

		const pop = store.add(new AdeEdgeTicketHistoryPopover(bodyEl, ccStub, undefined, {
			getProjectId: () => 'proj_gate8',
			getProjectSnapshot: () => bareSnap,
		}));
		await pop.openForEdge(pairKey, 200, 160);
		await pop.openTicketDetail('tk_ghost_orphan');

		const fromCellText = pop.popoverEl.querySelector('[data-ticket-field="from_id"] .ade-edge-field-val')?.textContent ?? '';
		const toCellText = pop.popoverEl.querySelector('[data-ticket-field="to_id"] .ade-edge-field-val')?.textContent ?? '';
		assert.ok(fromCellText.includes('Ghost Sender Name'), `Expected archived from_name fallback, got: ${fromCellText}`);
		assert.ok(toCellText.includes('Ghost Receiver Name'), `Expected archived to_name fallback, got: ${toCellText}`);

		const curTaskDir = pop.popoverEl.querySelector('[data-ade-task-card="tsk_cur_ghost"] .ade-edge-history-dir')?.textContent ?? '';
		const archTaskDir = pop.popoverEl.querySelector('[data-ade-task-card="tsk_arch_ghost"] .ade-edge-history-dir')?.textContent ?? '';
		assert.strictEqual(curTaskDir, 'Ghost Sender Name → Ghost Receiver Name');
		assert.strictEqual(archTaskDir, 'Ghost Creator Name → Ghost Receiver Name');

		// Defect #2: switchLayoutDirection pushes history snapshot, passes resetPinnedPositions: true, clears local cache, and supports Undo!
		const historyStore = new EngineeringHistoryStore();
		let currentSnap: IAdeProjectSnapshot = {
			...makeTreeSnapshot(),
			agents: makeTreeSnapshot().agents.map((a, idx) => ({
				...a,
				canvas_x: 320 + idx * 90,
				canvas_y: 260 + idx * 70,
			})),
		};
		let liveMap: Record<string, IMissionNodePosition> = {
			agent_l1_lead: { x: 320, y: 260 },
			agent_l2_mgr: { x: 410, y: 330 },
			agent_l3_dev: { x: 500, y: 400 },
		};
		let clearedCacheCount = 0;
		const layoutCalls: Array<{ projectId: string; patch: Record<string, unknown> }> = [];

		const layoutCc = {
			uiUpdateCanvasLayout: async (pid: string, patch: Record<string, unknown>) => {
				layoutCalls.push({ projectId: pid, patch });
				if (patch.resetPinnedPositions) {
					currentSnap = {
						...currentSnap,
						meta: { ...currentSnap.meta, layout_direction: (patch.layoutDirection as 'LR') ?? currentSnap.meta.layout_direction },
						agents: currentSnap.agents.map(a => ({ ...a, canvas_x: undefined, canvas_y: undefined })),
						whiteboards: currentSnap.whiteboards.map(w => ({ ...w, canvas_x: undefined, canvas_y: undefined })),
					};
				}
				if (patch.nodePositions) {
					const np = patch.nodePositions as Record<string, { x: number; y: number }>;
					currentSnap = {
						...currentSnap,
						agents: currentSnap.agents.map(a => np[a.agent_id] ? { ...a, canvas_x: np[a.agent_id].x, canvas_y: np[a.agent_id].y } : a),
					};
				}
			},
		} as unknown as IAdeControlCenterService;

		const actions = new AdeEngineeringGraphActions(layoutCc, undefined, undefined, historyStore, {
			getProjectId: () => 'proj_gate8',
			getProjectSnapshot: () => currentSnap,
			getCurrentPositionsObject: () => ({ ...liveMap }),
			clearLocalPositionCache: () => {
				clearedCacheCount++;
				liveMap = {};
			},
			applyOptimisticPositions: pos => { liveMap = { ...pos }; },
			onFeedback: () => { },
			onRefreshSnapshot: async () => {
				const g = buildProjectOrchestrationGraph(currentSnap);
				const computed = computeOrchestrationLayoutPositions(g.nodes, g.edges, g.departments, {
					mode: g.layoutMode,
					direction: g.direction,
					existingPositions: g.storedPositions,
				});
				liveMap = Object.fromEntries(computed.entries());
			},
		});

		await actions.switchLayoutDirection('LR');
		assert.strictEqual(clearedCacheCount, 1);
		assert.strictEqual(layoutCalls.length, 1);
		assert.strictEqual(layoutCalls[0].patch.layoutDirection, 'LR');
		assert.strictEqual(layoutCalls[0].patch.resetPinnedPositions, true);
		// In fresh LR layout, L1 -> L2 -> L3 progress strictly left-to-right!
		assert.ok(liveMap.agent_l1_lead.x < liveMap.agent_l2_mgr.x && liveMap.agent_l2_mgr.x < liveMap.agent_l3_dev.x);

		// Undo restores exact manual positions captured before switchLayoutDirection!
		const undone = await actions.undoPositions();
		assert.strictEqual(undone, true);
		assert.deepStrictEqual(liveMap.agent_l1_lead, { x: 320, y: 260 });
		assert.deepStrictEqual(liveMap.agent_l2_mgr, { x: 410, y: 330 });
		assert.deepStrictEqual(liveMap.agent_l3_dev, { x: 500, y: 400 });

		// Verify toolbar `+ Agent` and `+ Whiteboard` in AdeEngineeringEditorPane leave canvasX/canvasY undefined!
		const insta = workbenchInstantiationService(undefined, store);
		const paneHost = append(bodyEl, $('div', { style: 'width:1000px;height:700px;' }));
		let capturedAgentInput: { canvasX?: number; canvasY?: number } | undefined;
		let capturedWbInput: { canvasX?: number; canvasY?: number } | undefined;
		const paneCc = {
			onDidTransferTicket: () => ({ dispose: () => { } }),
			onDidChangeProject: () => ({ dispose: () => { } }),
			probeEngines: async () => ['claude'],
			probeModels: async () => ({ models: ['claude-sonnet-4-5'], efforts: ['medium'] }),
			getProjectSnapshot: async () => makeTreeSnapshot(),
			uiCreateAgent: async (inp: { canvasX?: number; canvasY?: number }) => {
				capturedAgentInput = inp;
				return makeTreeSnapshot().agents[0];
			},
			uiCreateWhiteboard: async (inp: { canvasX?: number; canvasY?: number }) => {
				capturedWbInput = inp;
				return makeTreeSnapshot().whiteboards[0];
			},
		} as unknown as IAdeControlCenterService;
		insta.stub(IAdeControlCenterService, paneCc);
		const pane = store.add(insta.createInstance(AdeEngineeringEditorPane, { id: 1 } as never));
		pane.create(paneHost);
		(pane as unknown as { applySnapshotToCanvas(s: IAdeProjectSnapshot, f: boolean): void }).applySnapshotToCanvas(makeTreeSnapshot(), true);
		(pane as unknown as { activeProjectId: string }).activeProjectId = 'proj_gate8';

		const addAgentBtn = paneHost.querySelector<HTMLButtonElement>('[data-ade-toolbar-add-agent="true"]')!;
		addAgentBtn.click();
		const nameInp = paneHost.querySelector<HTMLInputElement>('[data-ade-create-name="true"]')!;
		nameInp.value = 'Auto Layout Worker';
		paneHost.querySelector<HTMLButtonElement>('[data-ade-create-submit="true"]')!.click();
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(capturedAgentInput?.canvasX, undefined, 'Toolbar + Agent must not pin viewport center X');
		assert.strictEqual(capturedAgentInput?.canvasY, undefined, 'Toolbar + Agent must not pin viewport center Y');

		const addWbBtn = paneHost.querySelector<HTMLButtonElement>('[data-ade-toolbar-add-wb="true"]')!;
		addWbBtn.click();
		const wbNameInp = paneHost.querySelector<HTMLInputElement>('[data-ade-wb-name="true"]')!;
		wbNameInp.value = 'Auto Layout Board';
		paneHost.querySelector<HTMLButtonElement>('[data-ade-wb-submit="true"]')!.click();
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(capturedWbInput?.canvasX, undefined, 'Toolbar + Whiteboard must not pin viewport center X');
		assert.strictEqual(capturedWbInput?.canvasY, undefined, 'Toolbar + Whiteboard must not pin viewport center Y');
	});

	test('7. Defect #3 regressions: Shift marquee center-box intersection and rigid relative formation on multi-select & department wall collision', () => {
		const { viewportEl, marqueeBoxEl } = mountTestCanvas();
		const snap = makeTreeSnapshot();
		const graph = buildProjectOrchestrationGraph(snap);

		// Card centers: L1 at (400, 300) [344x188 => x in 228..572, y in 206..394], L2 at (760, 520), wb_core at (620, 340) [276x164]
		const livePositions = new Map<string, IMissionNodePosition>([
			['agent_l1_lead', { x: 400, y: 300 }],
			['agent_l2_mgr', { x: 760, y: 520 }],
			['agent_l3_dev', { x: 960, y: 700 }],
			['wb_core', { x: 620, y: 340 }],
		]);
		let selectedIds = new Set<string>();
		const interactionStore = store.add(new DisposableStore());
		const rect = viewportEl.getBoundingClientRect();

		const interactions = installEngineeringCanvasInteractions(
			{
				viewportEl,
				marqueeBoxEl,
				getZoom: () => 1,
				getPan: () => ({ x: 0, y: 0 }),
				setCamera: () => { },
				getNodes: () => graph.nodes,
				getPositions: () => livePositions,
				getSelectedNodeIds: () => selectedIds,
				setSelectedNodesAndEdge: ids => { selectedIds = new Set(ids); },
				onBlankCanvasClick: () => { },
				onBlankCanvasContextMenu: () => { },
				onDismissTransientContextMenuOnly: () => { },
				onUpdateLivePositions: updated => {
					for (const [id, p] of updated.entries()) {
						livePositions.set(id, p);
					}
				},
				onRenderSnapGuides: () => { },
				onCommitPositionsChange: () => { },
				onSetConnectPreview: () => { },
				onReparentAgent: () => { },
				onSpawnSubordinateAtWorldPos: () => { },
			},
			interactionStore,
			{ minZoom: 0.25, maxZoom: 2.5 },
		);

		// 1) Marquee over LEFT half of L1 [240..310, 220..260] (strictly left of center 400!): MUST hit L1!
		viewportEl.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, shiftKey: true, clientX: rect.left + 240, clientY: rect.top + 220, bubbles: true }));
		viewportEl.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, shiftKey: true, clientX: rect.left + 310, clientY: rect.top + 260, bubbles: true }));
		viewportEl.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, clientX: rect.left + 310, clientY: rect.top + 260, bubbles: true }));
		assert.strictEqual(selectedIds.has('agent_l1_lead'), true, 'Marquee intersecting left half of center-anchored card must select it');

		// 2) Marquee at [580..585, 460..500] (strictly outside L1 right edge 572, wb_core bottom 422, and L2 left edge 588): MUST hit ZERO cards!
		viewportEl.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 2, shiftKey: true, clientX: rect.left + 580, clientY: rect.top + 460, bubbles: true }));
		viewportEl.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, shiftKey: true, clientX: rect.left + 585, clientY: rect.top + 500, bubbles: true }));
		viewportEl.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 2, clientX: rect.left + 585, clientY: rect.top + 500, bubbles: true }));
		assert.strictEqual(selectedIds.size, 0, 'Marquee outside actual center-origin card bounds must not false-positive');

		// 3) Multi-selected group drag slamming into top-left wall (-2000, -2000): preserves exact relative offsets & >= 24px outer margin!
		selectedIds = new Set(['agent_l1_lead', 'agent_l2_mgr', 'wb_core']);
		const initRelL2 = { dx: 760 - 400, dy: 520 - 300 };
		const initRelWb = { dx: 620 - 400, dy: 340 - 300 };

		interactions.startNodeDrag('agent_l2_mgr', new PointerEvent('pointerdown', { clientX: 500, clientY: 500 }));
		interactions.moveNodeDrag('agent_l2_mgr', new PointerEvent('pointermove', { clientX: -1500, clientY: -1500 }));
		interactions.endNodeDrag('agent_l2_mgr', new PointerEvent('pointerup', { clientX: -1500, clientY: -1500 }));

		const p1 = livePositions.get('agent_l1_lead')!;
		const p2 = livePositions.get('agent_l2_mgr')!;
		const pWb = livePositions.get('wb_core')!;
		assert.strictEqual(p1.x, 24 + ORCH_STAFF_CARD_WIDTH / 2, 'Leftmost card clamped to exact 24 + width/2');
		assert.strictEqual(p1.y, 24 + ORCH_STAFF_CARD_HEIGHT / 2, 'Topmost card clamped to exact 24 + height/2');
		assert.strictEqual(p2.x - p1.x, initRelL2.dx, 'Multi-drag X relative spacing preserved without deformation');
		assert.strictEqual(p2.y - p1.y, initRelL2.dy, 'Multi-drag Y relative spacing preserved without deformation');
		assert.strictEqual(pWb.x - p1.x, initRelWb.dx, 'Whiteboard X relative spacing preserved without deformation');
		assert.strictEqual(pWb.y - p1.y, initRelWb.dy, 'Whiteboard Y relative spacing preserved without deformation');
		assert.ok(pWb.x - ORCH_WHITEBOARD_CARD_WIDTH / 2 >= 24 && pWb.y - ORCH_WHITEBOARD_CARD_HEIGHT / 2 >= 24);

		// 4) Department pill group drag slamming into top-left wall (-3000, -3000): preserves exact relative offsets!
		livePositions.set('agent_l2_mgr', { x: 520, y: 380 });
		livePositions.set('agent_l3_dev', { x: 880, y: 610 });
		livePositions.set('wb_core', { x: 640, y: 260 });
		const deptRel32 = { dx: 880 - 520, dy: 610 - 380 };
		const deptRelWb2 = { dx: 640 - 520, dy: 260 - 380 };

		interactions.startDepartmentDrag(graph.departments[0], ['agent_l2_mgr', 'agent_l3_dev', 'wb_core'], new PointerEvent('pointerdown', { clientX: 600, clientY: 400 }));
		interactions.moveDepartmentDrag(new PointerEvent('pointermove', { clientX: -2400, clientY: -2400 }));
		interactions.endDepartmentDrag(new PointerEvent('pointerup', { clientX: -2400, clientY: -2400 }));

		const d2 = livePositions.get('agent_l2_mgr')!;
		const d3 = livePositions.get('agent_l3_dev')!;
		const dWb = livePositions.get('wb_core')!;
		assert.strictEqual(d3.x - d2.x, deptRel32.dx, 'Department drag X spacing preserved on wall collision');
		assert.strictEqual(d3.y - d2.y, deptRel32.dy, 'Department drag Y spacing preserved on wall collision');
		assert.strictEqual(dWb.x - d2.x, deptRelWb2.dx, 'Department whiteboard X spacing preserved on wall collision');
		assert.strictEqual(dWb.y - d2.y, deptRelWb2.dy, 'Department whiteboard Y spacing preserved on wall collision');
		assert.ok(d2.x - ORCH_STAFF_CARD_WIDTH / 2 >= 24);
		assert.ok(dWb.y - ORCH_WHITEBOARD_CARD_HEIGHT / 2 >= 24);
	});

	test('8. Defect #4 & #5 regressions: LR dynamic re-anchoring without anchor jump, cached getTotalLength (zero repeat calls), and O(|Delta|) live-flow edge highlights', () => {
		const { worldEl, emptyHintEl } = mountTestCanvas();
		const storage = store.add(new InMemoryStorageService());
		const hostCatalog = store.add(new AdeMissionHostCatalog(storage, undefined, undefined, undefined, undefined));
		const clock = new FakeTicketFlowClock();

		const renderer = store.add(new AdeMissionCanvasRenderer(
			worldEl,
			emptyHintEl,
			hostCatalog,
			{
				onHoverNode: () => { },
				onOpenModelPopover: () => { },
				onOpenEnginePopover: () => { },
				onOpenAgentSession: () => { },
				onStartNodeDrag: () => { },
				onDragNodeMove: () => { },
				onEndNodeDrag: () => { },
				getNodePosition: () => undefined,
				getZoom: () => 1,
			},
			clock,
		));

		const snap: IAdeProjectSnapshot = {
			...makeTreeSnapshot(),
			meta: { ...makeTreeSnapshot().meta, layout_direction: 'LR' },
		};
		const graph = buildProjectOrchestrationGraph(snap);
		const lrPositions = computeOrchestrationLayoutPositions(graph.nodes, graph.edges, graph.departments, { mode: 'lr', direction: 'LR' });

		renderer.syncGraph({
			direction: 'LR',
			layoutMode: 'lr',
			nodes: graph.nodes,
			edges: graph.edges,
			departments: graph.departments,
			positions: lrPositions,
			agentNodesById: new Map(snap.agents.map(a => [a.agent_id, a])),
			whiteboardsById: new Map(snap.whiteboards.map(w => [w.board_id, w])),
			tickets: [],
		});

		const e12 = canonicalEdgePairKey('agent_l1_lead', 'agent_l2_mgr');
		const e23 = canonicalEdgePairKey('agent_l2_mgr', 'agent_l3_dev');
		const h12 = renderer.getEdgeHandleByPairKey(e12)!;
		const h23 = renderer.getEdgeHandleByPairKey(e23)!;
		assert.strictEqual(h12.route.fromAnchor.side, 'right');
		assert.strictEqual(h12.route.toAnchor.side, 'left');

		// Defect #4: Drag L2 left of L1 (inverting horizontally in LR mode), then drag L2 back to the right with vertical offset (dy=210, dx=360 where normDx >= normDy * 0.72 holds in LR, fails in TD!)
		const l1Pos = lrPositions.get('agent_l1_lead')!;
		renderer.updateDraggedNodesPositions(new Map([['agent_l2_mgr', { x: l1Pos.x - 420, y: l1Pos.y + 40 }]]), 'agent_l2_mgr');
		assert.strictEqual(h12.route.fromAnchor.side, 'left');
		assert.strictEqual(h12.route.toAnchor.side, 'right');

		const dragReleasePos = { x: l1Pos.x + 360, y: l1Pos.y + 210 };
		renderer.updateDraggedNodesPositions(new Map([['agent_l2_mgr', dragReleasePos]]), 'agent_l2_mgr');
		assert.strictEqual(h12.route.fromAnchor.side, 'right', 'LR drag re-anchor must stay horizontal right->left');
		assert.strictEqual(h12.route.toAnchor.side, 'left', 'LR drag re-anchor must match full LR route on release');

		const fullAfterRelease = computeOrchestrationMultiAnchorRoutes(
			graph.nodes,
			graph.edges,
			new Map([...lrPositions, ['agent_l2_mgr', dragReleasePos]]),
			{ direction: 'LR', layoutMode: 'lr' },
		).get(h12.edgeId)!;
		assert.strictEqual(h12.route.fromAnchor.side, fullAfterRelease.fromAnchor.side, 'Zero anchor side jump between LR drag and release');
		assert.strictEqual(h12.route.toAnchor.side, fullAfterRelease.toAnchor.side, 'Zero target anchor side jump between LR drag and release');
		assert.strictEqual(reanchorOrchestrationRoute(graph.edges[0], h12.route, new Map(graph.nodes.map(n => [n.id, n])), new Map([...lrPositions, ['agent_l2_mgr', dragReleasePos]]), [], 'LR').fromAnchor.side, 'right');

		// Defect #5: Spy on SVGPathElement.getTotalLength across 25 frames — cached on handle, ZERO repeat calls while path `d` is unchanged!
		h12.cachedTotalLength = undefined;
		h23.cachedTotalLength = undefined;
		let lenCalls12 = 0;
		let lenCalls23 = 0;
		const origLen12 = h12.path.getTotalLength.bind(h12.path);
		const origLen23 = h23.path.getTotalLength.bind(h23.path);
		h12.path.getTotalLength = () => { lenCalls12++; return origLen12(); };
		h23.path.getTotalLength = () => { lenCalls23++; return origLen23(); };

		clock.setNow(20_000);
		assert.strictEqual(renderer.triggerTicketTransferAnimation({
			transfer_group_id: 'perf_relay',
			project_id: 'proj_gate8',
			ticket_id: 'tk_perf',
			task_id: 'tsk_perf',
			origin_from_id: 'agent_l1_lead',
			target_to_id: 'agent_l3_dev',
			transferred_at: 20_000,
			hops: [
				{ edge_pair_key: e12, hop_from_id: 'agent_l1_lead', hop_to_id: 'agent_l2_mgr', hop_seq: 1, total_hops: 2 },
				{ edge_pair_key: e23, hop_from_id: 'agent_l2_mgr', hop_to_id: 'agent_l3_dev', hop_seq: 2, total_hops: 2 },
			],
		}), true);

		// Frame 0 measured each edge path ONCE; sampleSvgPathAtLength made ZERO getTotalLength calls!
		assert.strictEqual(lenCalls12, 1);
		assert.strictEqual(lenCalls23, 1);
		assert.strictEqual(h12.group.classList.contains('is-orch-live-flow'), true);
		assert.strictEqual(h23.group.classList.contains('is-orch-live-flow'), false);

		// Advance 25 frames across hop 1 and hop 2 without changing path `d`: ZERO extra getTotalLength calls!
		for (let f = 1; f <= 25; f++) {
			clock.stepTo(20_000 + f * 100);
		}
		assert.strictEqual(lenCalls12, 1, 'Cached totalLength must prevent repeated getTotalLength() across 60fps frames');
		assert.strictEqual(lenCalls23, 1, 'Hop 2 cached totalLength must also prevent repeated getTotalLength()');
		// At t = 22_500ms (83.3% through 3000ms), particle has transitioned to hop 2: h12 highlight removed, h23 highlight active!
		assert.strictEqual(h12.group.classList.contains('is-orch-live-flow'), false);
		assert.strictEqual(h23.group.classList.contains('is-orch-live-flow'), true);

		// Mutate L3 position so h23 path `d` changes -> invalidates ONLY h23.cachedTotalLength (re-measured once)!
		const l3Pos = lrPositions.get('agent_l3_dev')!;
		renderer.updateDraggedNodesPositions(new Map([['agent_l3_dev', { x: l3Pos.x + 80, y: l3Pos.y + 40 }]]), 'agent_l3_dev');
		assert.strictEqual(lenCalls12, 1, 'Unchanged edge h12 must not re-measure');
		assert.strictEqual(lenCalls23, 2, 'Mutated edge h23 re-measures exactly once after d update');

		// clearAll() removes all residual live-flow highlights immediately
		renderer.ticketFlow.clearAll();
		assert.strictEqual(h12.group.classList.contains('is-orch-live-flow'), false);
		assert.strictEqual(h23.group.classList.contains('is-orch-live-flow'), false);
		assert.strictEqual(h23.haloPath.classList.contains('is-live'), false);
	});

	test('9. AdeEngineeringEditorPane.syncMinimap() forwards liveChatStateByAgentId so unheld-ticket working/pending agents render live state on minimap', () => {
		const { bodyEl } = mountTestCanvas();
		const paneHost = append(bodyEl, $('div', { style: 'width:1000px;height:700px;' }));
		const onDidChangeProjects = store.add(new Emitter<void>());
		const statusByAgentId = new Map<string, AdeAgentStatus>([
			['agent_l1_lead', 'idle'],
			['agent_l2_mgr', 'idle'],
			['agent_l3_dev', 'idle'],
		]);

		const snap = makeTreeSnapshot();
		assert.strictEqual(snap.tickets.length, 0, 'Precondition: zero active tickets in snapshot');

		const insta = workbenchInstantiationService(undefined, store);
		const mockProjects = {
			onDidChange: onDidChangeProjects.event,
			getProjectPage: () => undefined,
			getAgent: (id: string, projectId?: string): IAdeAgent | undefined => {
				if (projectId && projectId !== snap.meta.project_id) {
					return undefined;
				}
				const node = snap.agents.find(a => a.agent_id === id);
				if (!node) {
					return undefined;
				}
				return {
					id: node.agent_id,
					projectId: node.project_id,
					...(node.parent_id ? { parentId: node.parent_id } : {}),
					projectUri: URI.parse(snap.meta.folder_uri),
					label: node.name,
					level: node.level,
					isTopRole: node.is_top_role,
					roleSummary: node.role_summary,
					host: node.host,
					engine: node.engine,
					model: node.model,
					effort: node.effort,
					sessionPhase: node.session_phase,
					sessionStarted: node.session_started,
					status: statusByAgentId.get(id) ?? 'idle',
					unread: false,
					session: {
						engineId: `aexus-${node.engine}`,
						resource: buildAdeEmployeeSessionUri(node.engine, node.project_id, node.agent_id),
					},
				};
			},
		} as unknown as IAdeProjectsService;
		insta.stub(IAdeProjectsService, mockProjects);

		const pane = store.add(insta.createInstance(AdeEngineeringEditorPane, { id: 1 } as never));
		pane.create(paneHost);
		const internalPane = pane as unknown as {
			activeProjectId: string;
			applySnapshotToCanvas(s: IAdeProjectSnapshot, f: boolean): void;
			syncMinimap(): void;
		};
		internalPane.activeProjectId = snap.meta.project_id;
		internalPane.applySnapshotToCanvas(snap, true);

		const getMinimapNodeRect = (nodeId: string) => paneHost.querySelector<SVGRectElement>(`[data-minimap-node="${nodeId}"]`)!;
		assert.strictEqual(getMinimapNodeRect('agent_l3_dev').classList.contains('state-idle'), true);

		// Transition unheld-ticket employee agent_l3_dev -> 'working'
		statusByAgentId.set('agent_l3_dev', 'working');
		onDidChangeProjects.fire();
		assert.strictEqual(getMinimapNodeRect('agent_l3_dev').classList.contains('state-active'), true, 'Minimap rect must reflect live working chat state as state-active');
		assert.strictEqual(getMinimapNodeRect('agent_l1_lead').classList.contains('state-idle'), true);

		// Calling syncMinimap() directly (as during node drag) preserves state-active without reverting to state-idle
		internalPane.syncMinimap();
		assert.strictEqual(getMinimapNodeRect('agent_l3_dev').classList.contains('state-active'), true, 'Standalone syncMinimap() must retain cached live working state');

		// Transition -> 'pending' -> state-waiting-gate, then back -> 'idle'
		statusByAgentId.set('agent_l3_dev', 'pending');
		onDidChangeProjects.fire();
		assert.strictEqual(getMinimapNodeRect('agent_l3_dev').classList.contains('state-waiting-gate'), true, 'Minimap rect must reflect live pending chat state as state-waiting-gate');

		statusByAgentId.set('agent_l3_dev', 'idle');
		onDidChangeProjects.fire();
		assert.strictEqual(getMinimapNodeRect('agent_l3_dev').classList.contains('state-idle'), true);
	});

	test('10. Wave 5 Track C: Reverse (child -> parent) 3000ms Ticket flow particle aligns .is-return/.is-reverse classes & --flow-color/--puck-color across core, ring, bloom, and trail in dark & light themes', () => {
		const { workbench, worldEl, emptyHintEl } = mountTestCanvas();
		const storage = store.add(new InMemoryStorageService());
		const hostCatalog = store.add(new AdeMissionHostCatalog(storage, undefined, undefined, undefined, undefined));
		const clock = new FakeTicketFlowClock();

		const renderer = store.add(new AdeMissionCanvasRenderer(
			worldEl,
			emptyHintEl,
			hostCatalog,
			{
				onHoverNode: () => { },
				onOpenModelPopover: () => { },
				onOpenEnginePopover: () => { },
				onOpenAgentSession: () => { },
				onStartNodeDrag: () => { },
				onDragNodeMove: () => { },
				onEndNodeDrag: () => { },
				getNodePosition: () => undefined,
				getZoom: () => 1,
			},
			clock,
		));

		const snap = makeTreeSnapshot();
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
			tickets: [],
		});

		const e12 = canonicalEdgePairKey('agent_l1_lead', 'agent_l2_mgr');
		clock.setNow(30_000);
		assert.strictEqual(renderer.triggerTicketTransferAnimation({
			transfer_group_id: 'w5_fwd',
			project_id: 'proj_gate8',
			ticket_id: 'tk_fwd',
			task_id: 'tsk_fwd',
			origin_from_id: 'agent_l1_lead',
			target_to_id: 'agent_l2_mgr',
			transferred_at: 30_000,
			hops: [{ edge_pair_key: e12, hop_from_id: 'agent_l1_lead', hop_to_id: 'agent_l2_mgr', hop_seq: 1, total_hops: 1 }],
		}), true);
		assert.strictEqual(renderer.triggerTicketTransferAnimation({
			transfer_group_id: 'w5_rev',
			project_id: 'proj_gate8',
			ticket_id: 'tk_rev',
			task_id: 'tsk_rev',
			origin_from_id: 'agent_l2_mgr',
			target_to_id: 'agent_l1_lead',
			transferred_at: 30_000,
			hops: [{ edge_pair_key: e12, hop_from_id: 'agent_l2_mgr', hop_to_id: 'agent_l1_lead', hop_seq: 1, total_hops: 1 }],
		}), true);

		const flowLayer = renderer.getEdgesSvgElement().querySelector('g.ade-ticket-flow-layer')!;
		const fwdRoot = flowLayer.querySelector<SVGGElement>('[data-transfer-id="w5_fwd"]')!;
		const revRoot = flowLayer.querySelector<SVGGElement>('[data-transfer-id="w5_rev"]')!;
		assert.ok(fwdRoot && revRoot);

		// Verify unified class names and zero legacy mismatched puck classes
		assert.strictEqual(fwdRoot.classList.contains('is-dispatch'), true);
		assert.strictEqual(fwdRoot.classList.contains('is-return'), false);
		assert.strictEqual(fwdRoot.classList.contains('is-reverse'), false);
		assert.strictEqual(revRoot.classList.contains('is-return'), true);
		assert.strictEqual(revRoot.classList.contains('is-reverse'), true);
		assert.strictEqual(revRoot.classList.contains('is-dispatch'), false);
		assert.strictEqual(revRoot.querySelector('.ade-orch-live-puck-bloom'), null);
		assert.strictEqual(revRoot.querySelector('.ade-orch-live-puck-dot'), null);

		const revBloom = revRoot.querySelector<SVGCircleElement>('.ade-ticket-flow-bloom')!;
		const revRing = revRoot.querySelector<SVGCircleElement>('.ade-ticket-flow-core-ring')!;
		const revCore = revRoot.querySelector<SVGCircleElement>('.ade-ticket-flow-core')!;
		const revTrails = Array.from(revRoot.querySelectorAll<SVGCircleElement>('.ade-ticket-flow-trail'));
		assert.ok(revBloom && revRing && revCore && revTrails.length === 2);

		const fwdRing = fwdRoot.querySelector<SVGCircleElement>('.ade-ticket-flow-core-ring')!;
		const fwdTrail = fwdRoot.querySelector<SVGCircleElement>('.ade-ticket-flow-trail.is-inner')!;

		// Dark theme (.vs-dark): forward = #38bdf8 (rgb(56, 189, 248)), reverse = #34d399 (rgb(52, 211, 153))
		assert.strictEqual(fwdRoot.style.getPropertyValue('--flow-color'), '#38bdf8');
		assert.strictEqual(fwdRoot.style.getPropertyValue('--puck-color'), '#38bdf8');
		assert.strictEqual(revRoot.style.getPropertyValue('--flow-color'), '#34d399');
		assert.strictEqual(revRoot.style.getPropertyValue('--puck-color'), '#34d399');

		assert.strictEqual(mainWindow.getComputedStyle(fwdRing).stroke, 'rgb(56, 189, 248)');
		assert.strictEqual(mainWindow.getComputedStyle(fwdTrail).stroke, 'rgb(56, 189, 248)');
		assert.strictEqual(mainWindow.getComputedStyle(revBloom).fill, 'rgb(52, 211, 153)', 'Reverse bloom must be emerald green in dark theme');
		assert.strictEqual(mainWindow.getComputedStyle(revRing).stroke, 'rgb(52, 211, 153)', 'Reverse outer core-ring must be emerald green (never locked to blue)');
		assert.strictEqual(mainWindow.getComputedStyle(revCore).stroke, 'rgb(52, 211, 153)', 'Reverse core stroke must be emerald green');
		for (const tr of revTrails) {
			assert.strictEqual(mainWindow.getComputedStyle(tr).stroke, 'rgb(52, 211, 153)', 'Reverse trail wake must be emerald green (never locked to blue)');
		}

		// Switch to Light theme (.monaco-workbench.vs) and verify coordinated dispatch blue (#0284c7 => rgb(2, 132, 199)) & return green (#059669 => rgb(5, 150, 105))
		workbench.classList.remove('vs-dark');
		workbench.classList.add('vs');
		clock.stepTo(30_400);

		assert.strictEqual(fwdRoot.style.getPropertyValue('--flow-color'), '#0284c7');
		assert.strictEqual(fwdRoot.style.getPropertyValue('--puck-color'), '#0284c7');
		assert.strictEqual(revRoot.style.getPropertyValue('--flow-color'), '#059669');
		assert.strictEqual(revRoot.style.getPropertyValue('--puck-color'), '#059669');
		assert.strictEqual(mainWindow.getComputedStyle(fwdRing).stroke, 'rgb(2, 132, 199)');
		assert.strictEqual(mainWindow.getComputedStyle(fwdTrail).stroke, 'rgb(2, 132, 199)');
		assert.strictEqual(mainWindow.getComputedStyle(revBloom).fill, 'rgb(5, 150, 105)');
		assert.strictEqual(mainWindow.getComputedStyle(revRing).stroke, 'rgb(5, 150, 105)');
		assert.strictEqual(mainWindow.getComputedStyle(revCore).stroke, 'rgb(5, 150, 105)');
		for (const tr of revTrails) {
			assert.strictEqual(mainWindow.getComputedStyle(tr).stroke, 'rgb(5, 150, 105)');
		}
	});

	test('11. Wave 5 Track C: AdeMissionMinimap & AdeEngineeringEditorPane sync single-select, Shift multi-select/marquee, blank click, and Escape in real time', () => {
		const { bodyEl } = mountTestCanvas();
		const paneHost = append(bodyEl, $('div', { style: 'width:1280px;height:800px;' }));
		const snap = makeTreeSnapshot();
		const insta = workbenchInstantiationService(undefined, store);
		const pane = store.add(insta.createInstance(AdeEngineeringEditorPane, { id: 1 } as never));
		pane.create(paneHost);

		const internalPane = pane as unknown as {
			activeProjectId: string;
			applySnapshotToCanvas(s: IAdeProjectSnapshot, f: boolean): void;
			syncMinimap(): void;
			minimap: AdeMissionMinimap;
			renderer: AdeMissionCanvasRenderer;
			livePositions: Map<string, IMissionNodePosition>;
		};
		internalPane.activeProjectId = snap.meta.project_id;
		internalPane.applySnapshotToCanvas(snap, true);

		const getSelectedMinimapIds = (): string[] => Array.from(
			paneHost.querySelectorAll<SVGRectElement>('.ade-mission-minimap-node.is-selected'),
		).map(el => el.getAttribute('data-minimap-node')!).sort();

		assert.deepStrictEqual(getSelectedMinimapIds(), []);

		// 1. Single click on L1 staff card -> minimap immediately highlights agent_l1_lead
		const l1Card = internalPane.renderer.getCardElement('agent_l1_lead')!;
		l1Card.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
		l1Card.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true }));
		assert.deepStrictEqual(getSelectedMinimapIds(), ['agent_l1_lead']);

		// 2. Shift-click on L3 staff card & Whiteboard card -> minimap highlights ALL 3 selected nodes simultaneously!
		const l3Card = internalPane.renderer.getCardElement('agent_l3_dev')!;
		const wbCard = internalPane.renderer.getCardElement('wb_core')!;
		l3Card.dispatchEvent(new MouseEvent('click', { button: 0, shiftKey: true, bubbles: true }));
		wbCard.dispatchEvent(new MouseEvent('click', { button: 0, shiftKey: true, bubbles: true }));
		assert.deepStrictEqual(getSelectedMinimapIds(), ['agent_l1_lead', 'agent_l3_dev', 'wb_core']);

		// syncMinimap() preserves full ReadonlySet multi-selection (never truncating to first iterator value)
		internalPane.syncMinimap();
		assert.deepStrictEqual(getSelectedMinimapIds(), ['agent_l1_lead', 'agent_l3_dev', 'wb_core']);

		// 3. Blank canvas click clears minimap selection immediately
		const viewport = paneHost.querySelector<HTMLElement>('.ade-mission-viewport')!;
		const vpRect = viewport.getBoundingClientRect();
		viewport.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 11, clientX: vpRect.left + 12, clientY: vpRect.top + 12, bubbles: true }));
		viewport.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 11, clientX: vpRect.left + 12, clientY: vpRect.top + 12, bubbles: true }));
		assert.deepStrictEqual(getSelectedMinimapIds(), []);

		// 4. Shift marquee drag over all nodes -> minimap reflects marquee multi-selection, then Escape clears it!
		viewport.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 12, shiftKey: true, clientX: vpRect.left + 5, clientY: vpRect.top + 5, bubbles: true }));
		viewport.dispatchEvent(new PointerEvent('pointermove', { pointerId: 12, shiftKey: true, clientX: vpRect.left + 1250, clientY: vpRect.top + 780, bubbles: true }));
		viewport.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 12, clientX: vpRect.left + 1250, clientY: vpRect.top + 780, bubbles: true }));
		assert.ok(getSelectedMinimapIds().length >= 2, 'Shift marquee box must highlight multiple nodes on minimap');

		const rootEditorEl = paneHost.querySelector<HTMLElement>('.ade-eng-editor')!;
		rootEditorEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.deepStrictEqual(getSelectedMinimapIds(), [], 'Escape key must clear minimap selection immediately');
	});

	test('12. Wave 5 Track C: Project tab switch clears previous project snapshot/DOM/particles synchronously with zero stale flash, and AdeMissionStoreService coalesces concurrent & trailing refreshes into single IPC', async () => {
		const { bodyEl } = mountTestCanvas();
		const paneHost = append(bodyEl, $('div', { style: 'width:1280px;height:800px;' }));

		const snapA: IAdeProjectSnapshot = {
			...makeTreeSnapshot(),
			meta: { ...makeTreeSnapshot().meta, project_id: 'proj_switch_a', name: 'Switch Alpha' },
			agents: makeTreeSnapshot().agents.map(a => ({ ...a, project_id: 'proj_switch_a' })),
			departments: makeTreeSnapshot().departments.map(d => ({ ...d, project_id: 'proj_switch_a' })),
			whiteboards: makeTreeSnapshot().whiteboards.map(w => ({ ...w, project_id: 'proj_switch_a' })),
		};
		const snapBBase: IAdeProjectSnapshot = {
			...makeTreeSnapshot(),
			meta: { ...makeTreeSnapshot().meta, project_id: 'proj_switch_b', name: 'Switch Beta' },
			agents: [
				makeAgentNode({
					project_id: 'proj_switch_b',
					agent_id: 'agent_beta_sole',
					name: 'Beta Sole Lead',
					level: 1,
					is_top_role: true,
					parent_id: null,
				}),
			],
			departments: [],
			whiteboards: [],
		};

		const onDidChangeProject = store.add(new Emitter<{ readonly projectId: string }>());
		const onDidChangeCatalog = store.add(new Emitter<void>());
		const onDidTransferTicket = store.add(new Emitter<IAdeTicketTransferAnimationEvent>());

		let snapshotCallsForA = 0;
		let snapshotCallsForB = 0;
		let latestSnapB = snapBBase;
		const pendingDeferredB: Array<(snap: IAdeProjectSnapshot) => void> = [];
		let blockSnapB = false;

		const mockCc = {
			_serviceBrand: undefined,
			onDidChangeCatalog: onDidChangeCatalog.event,
			onDidChangeProject: onDidChangeProject.event,
			onDidTransferTicket: onDidTransferTicket.event,
			onDidEnqueueOutbox: Event.None,
			onDidCancelOutboxTickets: Event.None,
			onDidDisposeAgentRuntime: Event.None,
			registerWorkspaceFolder: async () => ({
				folder_id: 'fld_sw',
				folder_uri: 'file:///workspace/gate8',
				display_name: 'gate8',
				host: 'local',
				sort_order: 10,
				collapsed: false,
				created_at: 1,
				updated_at: 1,
			}),
			listAllBoundSessionResources: async () => [],
			getCatalogSnapshot: async () => ({
				folders: [{
					folder_id: 'fld_sw',
					folder_uri: 'file:///workspace/gate8',
					display_name: 'gate8',
					host: 'local',
					sort_order: 10,
					collapsed: false,
					created_at: 1,
					updated_at: 1,
				}],
				projects: [
					{ project_id: 'proj_switch_a', folder_id: 'fld_sw', folder_uri: 'file:///workspace/gate8', name: 'Switch Alpha', sort_order: 10, created_at: 1, updated_at: 1 },
					{ project_id: 'proj_switch_b', folder_id: 'fld_sw', folder_uri: 'file:///workspace/gate8', name: 'Switch Beta', sort_order: 20, created_at: 2, updated_at: 2 },
				],
			}),
			getProjectSnapshot: (projectId: string): Promise<IAdeProjectSnapshot | undefined> => {
				if (projectId === 'proj_switch_a') {
					snapshotCallsForA++;
					return Promise.resolve(snapA);
				}
				if (projectId === 'proj_switch_b') {
					snapshotCallsForB++;
					if (blockSnapB) {
						return new Promise<IAdeProjectSnapshot>(resolve => {
							pendingDeferredB.push(resolve);
						});
					}
					return Promise.resolve(latestSnapB);
				}
				return Promise.resolve(undefined);
			},
			probeEngines: async () => ['claude'],
			probeModels: async () => ({ models: ['claude-sonnet-4-5'], efforts: ['medium'] }),
		} as unknown as IAdeControlCenterService;

		const insta = workbenchInstantiationService({
			adeControlCenterService: () => mockCc,
		}, store);
		const projects = insta.get(IAdeProjectsService);
		const missionStore = store.add(insta.createInstance(AdeMissionStoreService));
		insta.stub(IAdeMissionService, missionStore);
		await projects.whenReady();

		const pane = store.add(insta.createInstance(AdeEngineeringEditorPane, {
			id: 1,
			closeEditor: async () => true,
		} as never));
		pane.create(paneHost);

		const renderedLog: Array<{ projectId: string; panX: number; panY: number; zoom: number }> = [];
		const internalPane = pane as unknown as {
			activeProjectId: string | undefined;
			currentSnapshot: IAdeProjectSnapshot | undefined;
			currentNodes: readonly unknown[];
			currentEdges: readonly unknown[];
			livePositions: Map<string, IMissionNodePosition>;
			panX: number;
			panY: number;
			zoom: number;
			setCamera(x: number, y: number, z: number, persist?: boolean): void;
			renderer: AdeMissionCanvasRenderer;
			hostCatalog: AdeMissionHostCatalog;
			applySnapshotToCanvas(s: IAdeProjectSnapshot, f: boolean): void;
			reloadAndRenderProject(pid: string, force: boolean, rebuild: boolean): Promise<void>;
		};
		const origApply = internalPane.applySnapshotToCanvas.bind(internalPane);
		internalPane.applySnapshotToCanvas = (s: IAdeProjectSnapshot, f: boolean) => {
			renderedLog.push({
				projectId: s.meta.project_id,
				panX: internalPane.panX,
				panY: internalPane.panY,
				zoom: internalPane.zoom,
			});
			origApply(s, f);
		};

		const inputA = store.add(insta.createInstance(AdeEngineeringEditorInput, 'proj_switch_a'));
		const inputB = store.add(insta.createInstance(AdeEngineeringEditorInput, 'proj_switch_b'));

		// Pre-seed proj_switch_b camera in sharedViewportMemory by opening B first, setting custom camera (-160, 44, 0.8), then opening A
		await pane.setInput(inputB, undefined, {}, CancellationToken.None);
		internalPane.setCamera(-160, 44, 0.8, true);

		await pane.setInput(inputA, undefined, {}, CancellationToken.None);
		internalPane.setCamera(220, 150, 1.3, true);
		// Spawn a live 3000ms particle on proj_switch_a before switching back to proj_switch_b
		const e12 = canonicalEdgePairKey('agent_l1_lead', 'agent_l2_mgr');
		assert.strictEqual(internalPane.renderer.triggerTicketTransferAnimation({
			transfer_group_id: 'stale_proj_a_flow',
			project_id: 'proj_switch_a',
			ticket_id: 'tk_a',
			task_id: 'tsk_a',
			origin_from_id: 'agent_l1_lead',
			target_to_id: 'agent_l2_mgr',
			transferred_at: Date.now(),
			hops: [{ edge_pair_key: e12, hop_from_id: 'agent_l1_lead', hop_to_id: 'agent_l2_mgr', hop_seq: 1, total_hops: 1 }],
		}), true);
		assert.strictEqual(internalPane.renderer.ticketFlow.getActiveCount(), 1);
		assert.ok(paneHost.querySelectorAll('.ade-mission-node').length >= 3);

		// 1. Now switch A -> B while getProjectSnapshot('proj_switch_b') is blocked on an async deferred!
		renderedLog.length = 0;
		snapshotCallsForB = 0;
		blockSnapB = true;

		const switchPromise = pane.setInput(inputB, undefined, {}, CancellationToken.None);

		// Synchronously on the SAME frame of setInput(inputB):
		assert.strictEqual(internalPane.activeProjectId, 'proj_switch_b');
		assert.strictEqual(internalPane.currentSnapshot, undefined, 'currentSnapshot must clear synchronously on project switch');
		assert.strictEqual(internalPane.currentNodes.length, 0, 'currentNodes must clear synchronously on project switch');
		assert.strictEqual(internalPane.currentEdges.length, 0, 'currentEdges must clear synchronously on project switch');
		assert.strictEqual(internalPane.livePositions.size, 0, 'livePositions must clear synchronously on project switch');
		assert.strictEqual(internalPane.renderer.ticketFlow.getActiveCount(), 0, 'Previous project flow particles must be cleared immediately');
		assert.strictEqual(paneHost.querySelectorAll('.ade-mission-node').length, 0, 'Zero proj_switch_a DOM cards may linger during async load');
		assert.strictEqual(paneHost.querySelector<HTMLElement>('.ade-mission-empty-hint')!.hidden, true, 'Empty onboarding hint must remain hidden while loading');

		// Flush microtasks up to getProjectSnapshot('proj_switch_b') and trigger unrelated service notifications mid-load -> ZERO stale or premature renders!
		await Promise.resolve();
		await Promise.resolve();
		projects.setAgentStatus('agent_l1_lead', 'working', true, 'proj_switch_a');
		assert.strictEqual(renderedLog.length, 0, 'Zero stale or premature pre-camera renders while setInput is awaiting snapshot');
		assert.strictEqual(snapshotCallsForB, 1);

		// Resolve proj_switch_b snapshot -> camera MUST restore to (-160, 44, 0.8) BEFORE the single applySnapshotToCanvas call!
		blockSnapB = false;
		pendingDeferredB.shift()!(latestSnapB);
		await switchPromise;

		assert.strictEqual(renderedLog.length, 1, 'Switch to proj_switch_b must render snapshot strictly once after restoring savedCam');
		assert.deepStrictEqual(renderedLog[0], {
			projectId: 'proj_switch_b',
			panX: -160,
			panY: 44,
			zoom: 0.8,
		});

		// 2. Concurrent forceRefresh = true calls reuse the exact same inflight Promise (1 IPC)
		renderedLog.length = 0;
		snapshotCallsForB = 0;
		blockSnapB = true;
		const p1 = missionStore.loadProjectSnapshot('proj_switch_b', true);
		const p2 = missionStore.loadProjectSnapshot('proj_switch_b', true);
		assert.strictEqual(p1, p2, 'Concurrent loadProjectSnapshot(projectId, true) must share identical inflight Promise');
		assert.strictEqual(snapshotCallsForB, 1);
		blockSnapB = false;
		pendingDeferredB.shift()!(latestSnapB);
		await Promise.all([p1, p2]);
		assert.strictEqual(snapshotCallsForB, 1, 'Concurrent forceRefresh calls execute strictly 1 IPC');
		assert.strictEqual(renderedLog.length, 1, 'Single unified render across missionStore + projects + pane');

		// 3. Single onDidChangeProject + reloadAndRenderProject triggers strictly 1 IPC & 1 render; 4 mid-flight changes coalesce into at most 1 trailing refresh (total = 2 IPCs)!
		renderedLog.length = 0;
		snapshotCallsForB = 0;
		blockSnapB = true;

		onDidChangeProject.fire({ projectId: 'proj_switch_b' });
		const reloadJoin = internalPane.reloadAndRenderProject('proj_switch_b', true, false);
		assert.strictEqual(snapshotCallsForB, 1, 'AdeProjectsService & AdeEngineeringEditorPane must not fire duplicate getProjectSnapshot IPCs');

		// Fire 4 more rapid backend change events while IPC #1 is still in flight!
		const updatedSnapBV2: IAdeProjectSnapshot = {
			...latestSnapB,
			meta: { ...latestSnapB.meta, name: 'Switch Beta v2', updated_at: 999 },
		};
		latestSnapB = updatedSnapBV2;
		onDidChangeProject.fire({ projectId: 'proj_switch_b' });
		onDidChangeProject.fire({ projectId: 'proj_switch_b' });
		onDidChangeProject.fire({ projectId: 'proj_switch_b' });
		onDidChangeProject.fire({ projectId: 'proj_switch_b' });
		assert.strictEqual(snapshotCallsForB, 1, 'Mid-flight changes must wait for active IPC instead of spawning parallel storm');

		// Resolve IPC #1 -> coalesced into strictly 1 trailing refresh (IPC #2)!
		pendingDeferredB.shift()!(snapBBase);
		for (let i = 0; i < 4 && snapshotCallsForB < 2; i++) {
			await Promise.resolve();
		}
		assert.strictEqual(snapshotCallsForB, 2, '4 mid-flight changes must coalesce into strictly 1 trailing refresh');

		blockSnapB = false;
		pendingDeferredB.shift()!(updatedSnapBV2);
		await reloadJoin;

		assert.strictEqual(snapshotCallsForB, 2);
		assert.strictEqual(missionStore.getProjectSnapshotCached('proj_switch_b')?.meta.name, 'Switch Beta v2');
		assert.strictEqual(projects.getProjectPage('proj_switch_b')?.name, 'Switch Beta v2', 'AdeProjectsService page title synced from unified snapshot coordinator');
		assert.strictEqual(renderedLog.length, 1, 'Coalesced refresh batch renders final snapshot once');
		assert.ok(snapshotCallsForA >= 1);
	});

	test('13. Wave 7 Track C (C-1): >5 subordinates perpendicular detours (TD l1_root->l2_mgr->6 L3 & LR symmetric) and critical forwardSpan===76px obstructed corridors have zero 344x188 card penetration, zero 180° foldback spikes, and strict 22px rigid stubs', () => {
		// 1. Direct unit assertions on hardened `satisfiesRigidNormalStubs` guard
		const leftFrom = computeOrchestrationAnchorPoint(
			{ x: 1300, y: 200 },
			{ width: ORCH_STAFF_CARD_WIDTH, height: ORCH_STAFF_CARD_HEIGHT },
			'left',
			2,
			5,
			ORCH_STAFF_EDGE_OUTSET,
		);
		const topTo = computeOrchestrationAnchorPoint(
			{ x: 1100, y: 524 },
			{ width: ORCH_STAFF_CARD_WIDTH, height: ORCH_STAFF_CARD_HEIGHT },
			'top',
			2,
			5,
			ORCH_STAFF_EDGE_OUTSET,
		);
		const targetTorso: IMissionEdgeObstacle = {
			minX: 1100 - ORCH_STAFF_CARD_WIDTH / 2,
			maxX: 1100 + ORCH_STAFF_CARD_WIDTH / 2,
			minY: 524 - ORCH_STAFF_CARD_HEIGHT / 2,
			maxY: 524 + ORCH_STAFF_CARD_HEIGHT / 2,
		};

		// Degenerate end-stub overshoot + 180° barb from below `topTo` through target card body MUST be rejected
		const barbEndPolyline = [
			{ x: leftFrom.x, y: leftFrom.y },
			{ x: leftFrom.x - 38, y: leftFrom.y },
			{ x: leftFrom.x - 38, y: 656 },
			{ x: topTo.x, y: 656 },
			{ x: topTo.x, y: topTo.y - 38 },
			{ x: topTo.x, y: topTo.y },
		];
		assert.strictEqual(
			satisfiesRigidNormalStubs(barbEndPolyline, leftFrom, topTo, ORCH_RIGID_STUB_LENGTH),
			false,
			'satisfiesRigidNormalStubs must reject 180° collinear foldback before end stub',
		);

		// Degenerate start-stub 180° foldback on `[1]->[2]` MUST be rejected
		const barbStartPolyline = [
			{ x: leftFrom.x, y: leftFrom.y },
			{ x: leftFrom.x - 38, y: leftFrom.y },
			{ x: leftFrom.x + 10, y: leftFrom.y },
			{ x: leftFrom.x + 10, y: topTo.y - 38 },
			{ x: topTo.x, y: topTo.y - 38 },
			{ x: topTo.x, y: topTo.y },
		];
		assert.strictEqual(
			satisfiesRigidNormalStubs(barbStartPolyline, leftFrom, topTo, ORCH_RIGID_STUB_LENGTH),
			false,
			'satisfiesRigidNormalStubs must reject 180° collinear foldback right after start stub',
		);

		// Interior segment cutting across `targetTorso` without 180° foldback MUST also be rejected when safetyBoxes are passed
		const cardPiercingPolyline = [
			{ x: leftFrom.x, y: leftFrom.y },
			{ x: leftFrom.x - 38, y: leftFrom.y },
			{ x: leftFrom.x - 38, y: 524 },
			{ x: 1320, y: 524 },
			{ x: 1320, y: topTo.y - 38 },
			{ x: topTo.x, y: topTo.y - 38 },
			{ x: topTo.x, y: topTo.y },
		];
		assert.strictEqual(
			satisfiesRigidNormalStubs(cardPiercingPolyline, leftFrom, topTo, ORCH_RIGID_STUB_LENGTH, [targetTorso]),
			false,
			'satisfiesRigidNormalStubs must reject interior segments penetrating card safetyBoxes',
		);

		// Helper to sample SVG `<path>` (`M`, `L`, `Q`) densely and verify zero interior penetration of any card torso
		const sampleSvgPathPoints = (pathStr: string): Array<{ readonly x: number; readonly y: number }> => {
			const tokens = pathStr.trim().split(/\s+/);
			const sampled: Array<{ readonly x: number; readonly y: number }> = [];
			let cur = { x: 0, y: 0 };
			let idx = 0;
			while (idx < tokens.length) {
				const cmd = tokens[idx++];
				if (cmd === 'M') {
					cur = { x: Number(tokens[idx++]), y: Number(tokens[idx++]) };
					sampled.push(cur);
				} else if (cmd === 'L') {
					const nx = Number(tokens[idx++]);
					const ny = Number(tokens[idx++]);
					for (let s = 1; s <= 24; s++) {
						const t = s / 24;
						sampled.push({ x: cur.x + (nx - cur.x) * t, y: cur.y + (ny - cur.y) * t });
					}
					cur = { x: nx, y: ny };
				} else if (cmd === 'Q') {
					const cx = Number(tokens[idx++]);
					const cy = Number(tokens[idx++]);
					const bx = Number(tokens[idx++]);
					const by = Number(tokens[idx++]);
					for (let s = 1; s <= 24; s++) {
						const t = s / 24;
						const omt = 1 - t;
						sampled.push({
							x: omt * omt * cur.x + 2 * omt * t * cx + t * t * bx,
							y: omt * omt * cur.y + 2 * omt * t * cy + t * t * by,
						});
					}
					cur = { x: bx, y: by };
				} else {
					throw new Error(`Unexpected SVG path token: ${cmd}`);
				}
			}
			return sampled;
		};

		const segmentPenetratesCard = (
			a: { readonly x: number; readonly y: number },
			b: { readonly x: number; readonly y: number },
			box: IMissionEdgeObstacle,
		): boolean => {
			const eps = 0.05;
			if (Math.abs(a.x - b.x) < 0.5) {
				const x = a.x;
				const minY = Math.min(a.y, b.y);
				const maxY = Math.max(a.y, b.y);
				return x > box.minX + eps && x < box.maxX - eps && maxY > box.minY + eps && minY < box.maxY - eps;
			}
			if (Math.abs(a.y - b.y) < 0.5) {
				const y = a.y;
				const minX = Math.min(a.x, b.x);
				const maxX = Math.max(a.x, b.x);
				return y > box.minY + eps && y < box.maxY - eps && maxX > box.minX + eps && minX < box.maxX - eps;
			}
			return false;
		};

		const buildSubordinateSnapshot = (dir: 'TD' | 'LR', subCount = 6): IAdeProjectSnapshot => {
			const base = makeTreeSnapshot();
			const l1 = makeAgentNode({
				agent_id: 'l1_root',
				name: 'L1 Root',
				level: 1,
				is_top_role: true,
				parent_id: null,
			});
			const l2 = makeAgentNode({
				agent_id: 'l2_mgr',
				name: 'L2 Manager',
				level: 2,
				parent_id: 'l1_root',
			});
			const l3Children: IAdeAgentNode[] = [];
			for (let i = 0; i < subCount; i++) {
				l3Children.push(makeAgentNode({
					agent_id: `l3_sub_${i}`,
					name: `L3 Sub ${i}`,
					level: 3,
					parent_id: 'l2_mgr',
				}));
			}
			return {
				...base,
				meta: { ...base.meta, layout_direction: dir },
				agents: [l1, l2, ...l3Children],
				departments: [],
				whiteboards: [
					{
						...base.whiteboards[0],
						board_id: 'wb_mgr',
						owner_id: 'l2_mgr',
						dept_id: null,
					},
				],
			};
		};

		const snapTd6 = buildSubordinateSnapshot('TD', 6);
		const graphTd6 = buildProjectOrchestrationGraph(snapTd6);
		const autoTdPositions = computeOrchestrationLayoutPositions(graphTd6.nodes, graphTd6.edges, graphTd6.departments, {
			mode: 'td',
			direction: 'TD',
			existingPositions: new Map<string, IMissionNodePosition>([
				['l1_root', { x: 1120, y: -40 }],
				['l2_mgr', { x: 1300, y: 200 }],
			]),
		});

		// Tight/obstructed 7-subordinate TD repro: all 7 L3 nodes sit inside chooseOptimalAnchorSides's bottom->top cone
		// (`absDx <= 200`, `dy >= 324`), forcing 2 overflows (`l3_sub_0` -> `left->top` & `l3_sub_6` -> `right->top` behind `wb_mgr`)!
		const snapTd7 = buildSubordinateSnapshot('TD', 7);
		const graphTd7 = buildProjectOrchestrationGraph(snapTd7);
		const obstructedTdPositions = new Map<string, IMissionNodePosition>([
			['l1_root', { x: 1120, y: -40 }],
			['l2_mgr', { x: 1300, y: 200 }],
			['wb_mgr', { x: 1680, y: 200 }],
			['l3_sub_0', { x: 1100, y: 524 }],
			['l3_sub_1', { x: 1110, y: 760 }],
			['l3_sub_2', { x: 1115, y: 996 }],
			['l3_sub_3', { x: 1300, y: 1232 }],
			['l3_sub_4', { x: 1485, y: 996 }],
			['l3_sub_5', { x: 1490, y: 760 }],
			['l3_sub_6', { x: 1500, y: 524 }],
		]);

		const snapLr7 = buildSubordinateSnapshot('LR', 7);
		const graphLr7 = buildProjectOrchestrationGraph(snapLr7);
		const obstructedLrPositions = new Map<string, IMissionNodePosition>([
			['l1_root', { x: -40, y: 1120 }],
			['l2_mgr', { x: 200, y: 1300 }],
			['wb_mgr', { x: 200, y: 1660 }],
			['l3_sub_0', { x: 660, y: 1090 }],
			['l3_sub_1', { x: 1060, y: 1100 }],
			['l3_sub_2', { x: 1460, y: 1110 }],
			['l3_sub_3', { x: 1860, y: 1300 }],
			['l3_sub_4', { x: 1460, y: 1490 }],
			['l3_sub_5', { x: 1060, y: 1500 }],
			['l3_sub_6', { x: 660, y: 1510 }],
		]);

		// Critical `forwardSpan === 76px` (`2 * preferredTurnStub`) with mid-corridor obstacle in both LR and TD
		const snapSpan76Base = makeTreeSnapshot();
		const snapSpan76: IAdeProjectSnapshot = {
			...snapSpan76Base,
			agents: [
				makeAgentNode({ agent_id: 'p_span', name: 'Span Parent', level: 1, is_top_role: true, parent_id: null }),
				makeAgentNode({ agent_id: 'c_span', name: 'Span Child', level: 2, parent_id: 'p_span' }),
				makeAgentNode({ agent_id: 'obs_blocker', name: 'Corridor Blocker', level: 2, parent_id: 'p_span' }),
			],
			departments: [],
			whiteboards: [
				{
					...snapSpan76Base.whiteboards[0],
					board_id: 'wb_mid_block',
					owner_id: 'obs_blocker',
					dept_id: null,
				},
			],
		};
		const graphSpan76 = buildProjectOrchestrationGraph(snapSpan76);
		// LR: p_span right anchor = 400 + 172 + 6 = 578; c_span left anchor = 832 - 172 - 6 = 654 -> exact 654 - 578 = 76px!
		// wb_mid_block (276x164) at (720, 330) sits strictly outside both cards while blocking all Z-bend mid-columns [600..632]!
		const lrSpan76Positions = new Map<string, IMissionNodePosition>([
			['p_span', { x: 400, y: 200 }],
			['c_span', { x: 832, y: 520 }],
			['obs_blocker', { x: 1320, y: 200 }],
			['wb_mid_block', { x: 720, y: 330 }],
		]);
		// TD: p_span bottom anchor = 400 + 94 + 6 = 500; c_span top anchor = 676 - 94 - 6 = 576 -> exact 576 - 500 = 76px!
		// wb_mid_block (276x164) at (516, 590) sits strictly outside both cards while blocking all Z-bend mid-rows [522..554]!
		const tdSpan76Positions = new Map<string, IMissionNodePosition>([
			['p_span', { x: 200, y: 400 }],
			['c_span', { x: 832, y: 676 }],
			['obs_blocker', { x: 200, y: 1120 }],
			['wb_mid_block', { x: 516, y: 590 }],
		]);

		const testCases: ReadonlyArray<{
			readonly label: string;
			readonly dir: 'TD' | 'LR';
			readonly graph: ReturnType<typeof buildProjectOrchestrationGraph>;
			readonly positions: ReadonlyMap<string, IMissionNodePosition>;
			readonly requirePerpendicularOverflow?: boolean;
			readonly checkExact76SpanEdge?: string;
		}> = [
			{
				label: 'TD >5 subordinates (l1_root(1120,-40) -> l2_mgr(1300,200) -> 6 L3 auto)',
				dir: 'TD',
				graph: graphTd6,
				positions: autoTdPositions,
				requirePerpendicularOverflow: true,
			},
			{
				label: 'TD >5 subordinates obstructed left->top & right->top',
				dir: 'TD',
				graph: graphTd7,
				positions: obstructedTdPositions,
				requirePerpendicularOverflow: true,
			},
			{
				label: 'LR >5 subordinates symmetric obstructed top->left & bottom->left',
				dir: 'LR',
				graph: graphLr7,
				positions: obstructedLrPositions,
				requirePerpendicularOverflow: true,
			},
			{
				label: 'LR forwardSpan===76px with mid-corridor obstacle',
				dir: 'LR',
				graph: graphSpan76,
				positions: lrSpan76Positions,
				checkExact76SpanEdge: canonicalEdgePairKey('p_span', 'c_span'),
			},
			{
				label: 'TD forwardSpan===76px with mid-corridor obstacle',
				dir: 'TD',
				graph: graphSpan76,
				positions: tdSpan76Positions,
				checkExact76SpanEdge: canonicalEdgePairKey('p_span', 'c_span'),
			},
		];

		for (const tc of testCases) {
			const nodesById = new Map(tc.graph.nodes.map(n => [n.id, n]));
			const edgesById = new Map(tc.graph.edges.map(e => [e.id, e]));
			const cardBoxes: Array<{ readonly id: string; readonly box: IMissionEdgeObstacle }> = tc.graph.nodes.map(n => {
				const p = tc.positions.get(n.id)!;
				const w = n.kind === 'whiteboard' ? ORCH_WHITEBOARD_CARD_WIDTH : ORCH_STAFF_CARD_WIDTH;
				const h = n.kind === 'whiteboard' ? ORCH_WHITEBOARD_CARD_HEIGHT : ORCH_STAFF_CARD_HEIGHT;
				return {
					id: n.id,
					box: {
						minX: p.x - w / 2,
						maxX: p.x + w / 2,
						minY: p.y - h / 2,
						maxY: p.y + h / 2,
					},
				};
			});
			const paddedAllObstacles: Array<{ readonly id: string; readonly box: IMissionEdgeObstacle }> = cardBoxes.map(c => ({
				id: c.id,
				box: {
					minX: c.box.minX - 10,
					maxX: c.box.maxX + 10,
					minY: c.box.minY - 10,
					maxY: c.box.maxY + 10,
				},
			}));
			const rawTorsoBoxes = cardBoxes.map(c => c.box);

			const routed = computeOrchestrationMultiAnchorRoutes(
				tc.graph.nodes,
				tc.graph.edges,
				tc.positions,
				{ direction: tc.dir, layoutMode: tc.dir === 'LR' ? 'lr' : 'td' },
			);

			let sawPerpendicularStaffEdge = false;
			for (const r of routed.values()) {
				const minStub = r.isWhiteboardLink ? 14 : ORCH_RIGID_STUB_LENGTH;
				if (!r.isWhiteboardLink && (r.fromAnchor.nx !== 0) !== (r.toAnchor.nx !== 0)) {
					sawPerpendicularStaffEdge = true;
				}
				if (tc.checkExact76SpanEdge && r.edgeId === tc.checkExact76SpanEdge) {
					const span = tc.dir === 'LR'
						? (r.toAnchor.x - r.fromAnchor.x) * r.fromAnchor.nx
						: (r.toAnchor.y - r.fromAnchor.y) * r.fromAnchor.ny;
					assert.strictEqual(span, 76, `[${tc.label}] Expected exact 76px critical forwardSpan`);
				}

				const verifyRouteGeometry = (
					variantLabel: string,
					pts: readonly { readonly x: number; readonly y: number }[],
					svgPath: string,
					fa: typeof r.fromAnchor,
					ta: typeof r.toAnchor,
				) => {
					assert.strictEqual(
						satisfiesRigidNormalStubs(pts, fa, ta, minStub, rawTorsoBoxes),
						true,
						`[${tc.label} / ${variantLabel}] satisfiesRigidNormalStubs failed on ${r.edgeId}: ${JSON.stringify(pts)}`,
					);
					// Explicitly assert zero 180° collinear foldback on every adjacent segment pair
					for (let k = 0; k < pts.length - 2; k++) {
						const v1x = pts[k + 1].x - pts[k].x;
						const v1y = pts[k + 1].y - pts[k].y;
						const v2x = pts[k + 2].x - pts[k + 1].x;
						const v2y = pts[k + 2].y - pts[k + 1].y;
						const len1 = Math.hypot(v1x, v1y);
						const len2 = Math.hypot(v2x, v2y);
						assert.ok(len1 >= 0.05 && len2 >= 0.05, `[${tc.label} / ${variantLabel}] Degenerate zero-length segment on ${r.edgeId}`);
						const uDot = (v1x * v2x + v1y * v2y) / (len1 * len2);
						assert.ok(
							uDot >= -1e-6,
							`[${tc.label} / ${variantLabel}] 180° collinear foldback (dot=${uDot}) at vertex ${k + 1} on ${r.edgeId}: ${JSON.stringify(pts)}`,
						);
					}
					// Explicitly assert zero polyline segment penetration of ANY 344×188 staff card or 276×164 whiteboard card
					for (let s = 0; s < pts.length - 1; s++) {
						for (const card of cardBoxes) {
							assert.strictEqual(
								segmentPenetratesCard(pts[s], pts[s + 1], card.box),
								false,
								`[${tc.label} / ${variantLabel}] Segment ${s} of ${r.edgeId} penetrated card ${card.id} (${JSON.stringify(card.box)}): ${JSON.stringify(pts)}`,
							);
						}
					}
					// Explicitly assert densely sampled SVG `<path>` (including Q Bezier corners) never enters ANY card torso
					const sampled = sampleSvgPathPoints(svgPath);
					assert.ok(sampled.length >= 2, `[${tc.label} / ${variantLabel}] Non-empty SVG path expected`);
					for (const sp of sampled) {
						for (const card of cardBoxes) {
							const strictlyInside = sp.x > card.box.minX + 0.05
								&& sp.x < card.box.maxX - 0.05
								&& sp.y > card.box.minY + 0.05
								&& sp.y < card.box.maxY - 0.05;
							assert.strictEqual(
								strictlyInside,
								false,
								`[${tc.label} / ${variantLabel}] Sampled SVG path point (${sp.x.toFixed(2)}, ${sp.y.toFixed(2)}) of ${r.edgeId} pierced card ${card.id}`,
							);
						}
					}
				};

				verifyRouteGeometry('initial', r.points, r.path, r.fromAnchor, r.toAnchor);
				const edgeObj = edgesById.get(r.edgeId)!;
				const reanchored = reanchorOrchestrationRoute(edgeObj, r, nodesById, tc.positions, paddedAllObstacles, tc.dir);
				verifyRouteGeometry('reanchored', reanchored.points, reanchored.path, reanchored.fromAnchor, reanchored.toAnchor);
			}

			if (tc.requirePerpendicularOverflow) {
				assert.strictEqual(
					sawPerpendicularOverflowFlag(sawPerpendicularStaffEdge),
					true,
					`[${tc.label}] >5 subordinates must overflow onto at least one perpendicular side pair (e.g. left->top or top->left)`,
				);
			}
		}

		function sawPerpendicularOverflowFlag(flag: boolean): boolean {
			return flag;
		}
	});

	test('14. Wave 7 Track C (C-2): Collapsed sidebar (getActiveViewWithId === null) Command Palette delete requires IDialogService.confirm and storage config opens QuickPick', async () => {
		const deletedIds: string[] = [];
		const closedEditors: string[] = [];
		const configuredStorageCalls: Array<{ readonly projectId: string; readonly targetHost: string }> = [];
		let currentStorageHost = 'local';

		const snapBase = makeTreeSnapshot();
		const onDidChangeCatalog = store.add(new Emitter<void>());
		const mockCc = {
			_serviceBrand: undefined,
			onDidChangeCatalog: onDidChangeCatalog.event,
			onDidChangeProject: Event.None,
			onDidTransferTicket: Event.None,
			onDidEnqueueOutbox: Event.None,
			onDidCancelOutboxTickets: Event.None,
			onDidDisposeAgentRuntime: Event.None,
			registerWorkspaceFolder: async () => ({
				folder_id: 'fld_c2',
				folder_uri: 'file:///workspace/c2',
				display_name: 'c2',
				host: 'local',
				sort_order: 10,
				collapsed: false,
				created_at: 1,
				updated_at: 1,
			}),
			listAllBoundSessionResources: async () => [],
			getCatalogSnapshot: async () => ({
				folders: [{
					folder_id: 'fld_c2',
					folder_uri: 'file:///workspace/c2',
					display_name: 'c2',
					host: 'local',
					sort_order: 10,
					collapsed: false,
					created_at: 1,
					updated_at: 1,
				}],
				projects: deletedIds.includes('proj_c2')
					? []
					: [{
						project_id: 'proj_c2',
						folder_id: 'fld_c2',
						folder_uri: 'file:///workspace/c2',
						name: 'Track C Project',
						sort_order: 10,
						created_at: 1,
						updated_at: 1,
					}],
			}),
			getProjectSnapshot: async (projectId: string) => {
				if (projectId !== 'proj_c2' || deletedIds.includes('proj_c2')) {
					return undefined;
				}
				return {
					...snapBase,
					meta: {
						...snapBase.meta,
						project_id: 'proj_c2',
						name: 'Track C Project',
						cross_host_ticket_storage: currentStorageHost,
					},
				};
			},
			deleteProject: async (projectId: string) => {
				deletedIds.push(projectId);
				onDidChangeCatalog.fire();
				return true;
			},
			uiConfigureProjectTicketStorage: async (projectId: string, targetHost: string) => {
				configuredStorageCalls.push({ projectId, targetHost });
				currentStorageHost = targetHost;
				return { ok: true };
			},
		} as unknown as IAdeControlCenterService;

		const insta = workbenchInstantiationService({
			adeControlCenterService: () => mockCc,
		}, store);

		insta.stub(IAdeCloudHostBackendService, {
			_serviceBrand: undefined,
			listHosts: async (): Promise<readonly IAdeCloudHost[]> => [{
				id: 'ch_1',
				alias: 'gpu-node',
				name: 'GPU Cluster',
				hostName: '10.20.30.40',
				port: 22,
				os: 'linux',
				recentDirectories: [],
				source: 'user',
				createdAt: 1,
				updatedAt: 1,
			}],
		} as unknown as IAdeCloudHostBackendService);

		insta.stub(IAdeEditorService, {
			_serviceBrand: undefined,
			activeEditor: undefined,
			getActiveProjectPageId: () => 'proj_c2',
			closeProjectPageEditors: async (projectId: string) => {
				closedEditors.push(projectId);
			},
			isSessionActive: () => false,
		} as unknown as IAdeEditorService);

		// Simulate `Cmd+B` collapsed left sidebar: `getActiveViewWithId(ADE_PROJECTS_VIEW_ID)` strictly returns `null`!
		let viewLookupCount = 0;
		insta.stub(IViewsService, {
			_serviceBrand: undefined,
			getActiveViewWithId: (id: string) => {
				if (id === ADE_PROJECTS_VIEW_ID) {
					viewLookupCount++;
				}
				return null;
			},
		} as unknown as IViewsService);

		insta.stub(ICommandService, {
			_serviceBrand: undefined,
			onWillExecuteCommand: Event.None,
			onDidExecuteCommand: Event.None,
			executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
				const cmd = CommandsRegistry.getCommand(id);
				assert.ok(cmd, `Expected registered command ${id}`);
				return insta.invokeFunction(cmd.handler, ...args) as unknown as Promise<T>;
			},
		} as unknown as ICommandService);

		const projects = store.add(insta.createInstance(AdeProjectsService));
		insta.stub(IAdeProjectsService, projects);
		await projects.whenReady();
		projects.selectProjectPage('proj_c2');
		assert.ok(projects.getProjectPage('proj_c2'), 'proj_c2 loaded in AdeProjectsService');

		let confirmCalls = 0;
		let nextConfirmResult = false;
		insta.stub(IDialogService, 'confirm', async () => {
			confirmCalls++;
			return { confirmed: nextConfirmResult };
		});

		let pickCalls = 0;
		let seenCandidateHosts: string[] = [];
		insta.stub(IQuickInputService, 'pick', async (items: ReadonlyArray<{ readonly targetHost?: string }>) => {
			pickCalls++;
			seenCandidateHosts = items.map(i => String(i.targetHost ?? ''));
			return items.find(i => i.targetHost === '10.20.30.40') as never;
		});

		const commandService = insta.get(ICommandService);

		// 1. User triggers `Delete Project Page...` via F1 Command Palette while sidebar is collapsed and clicks Cancel:
		//    MUST show confirmation dialog and MUST NOT close editors or delete the project!
		nextConfirmResult = false;
		const cancelResult = await commandService.executeCommand<boolean>(ADE_DELETE_PROJECT_PAGE_COMMAND_ID);
		assert.strictEqual(cancelResult, false);
		assert.strictEqual(confirmCalls, 1, 'IDialogService.confirm must be invoked even when AdeProjectsView is unmounted');
		assert.deepStrictEqual(closedEditors, []);
		assert.deepStrictEqual(deletedIds, []);
		assert.ok(projects.getProjectPage('proj_c2'), 'Project Page must survive canceled confirmation');

		// 2. User triggers `Configure Cross-Host Ticket Storage...` via F1 Command Palette while sidebar is collapsed:
		//    MUST open QuickPick with local + cloud + snapshot hosts and persist selection!
		const configuredHost = await commandService.executeCommand<string | undefined>(ADE_CONFIGURE_PROJECT_STORAGE_COMMAND_ID);
		assert.strictEqual(pickCalls, 1, 'IQuickInputService.pick must open even when AdeProjectsView is unmounted');
		assert.deepStrictEqual(seenCandidateHosts, ['local', '10.20.30.40', '10.0.0.8']);
		assert.strictEqual(configuredHost, '10.20.30.40');
		assert.deepStrictEqual(configuredStorageCalls, [{ projectId: 'proj_c2', targetHost: '10.20.30.40' }]);

		// Also verify direct helper invocation with explicit host argument
		const explicitHost = await insta.invokeFunction(acc => configureAdeProjectTicketStorage(acc, 'proj_c2', '10.0.0.8'));
		assert.strictEqual(explicitHost, '10.0.0.8');
		assert.strictEqual(configuredStorageCalls.length, 2);

		// 3. User confirms `Delete Project Page...` via F1 Command Palette while sidebar is still collapsed:
		//    MUST close editors and delete project cleanly!
		nextConfirmResult = true;
		const confirmedResult = await commandService.executeCommand<boolean>(ADE_DELETE_PROJECT_PAGE_COMMAND_ID);
		assert.strictEqual(confirmedResult, true);
		assert.strictEqual(confirmCalls, 2);
		assert.ok(viewLookupCount >= 1);
		assert.deepStrictEqual(closedEditors, ['proj_c2']);
		assert.deepStrictEqual(deletedIds, ['proj_c2']);
		assert.strictEqual(await insta.invokeFunction(acc => confirmAndDeleteAdeProjectPage(acc, 'proj_c2')), false);
	});

	test('15. Wave 8 Track C: (1) RADIAL CEO + 6 subordinates zero card penetration & node-order invariance, (2) TD 36px sibling detour zero penetration, (3) 16~34px near-drag zero penetration + 22px stubs, and (4) collapsed sidebar rename fallback when selectedProjectPageId === undefined', async () => {
		const sampleSvgPathPoints = (pathStr: string): Array<{ readonly x: number; readonly y: number }> => {
			const tokens = pathStr.trim().split(/\s+/);
			const sampled: Array<{ readonly x: number; readonly y: number }> = [];
			let cur = { x: 0, y: 0 };
			let idx = 0;
			while (idx < tokens.length) {
				const cmd = tokens[idx++];
				if (cmd === 'M') {
					cur = { x: Number(tokens[idx++]), y: Number(tokens[idx++]) };
					sampled.push(cur);
				} else if (cmd === 'L') {
					const nx = Number(tokens[idx++]);
					const ny = Number(tokens[idx++]);
					for (let s = 1; s <= 24; s++) {
						const t = s / 24;
						sampled.push({ x: cur.x + (nx - cur.x) * t, y: cur.y + (ny - cur.y) * t });
					}
					cur = { x: nx, y: ny };
				} else if (cmd === 'Q') {
					const cx = Number(tokens[idx++]);
					const cy = Number(tokens[idx++]);
					const bx = Number(tokens[idx++]);
					const by = Number(tokens[idx++]);
					for (let s = 1; s <= 24; s++) {
						const t = s / 24;
						const omt = 1 - t;
						sampled.push({
							x: omt * omt * cur.x + 2 * omt * t * cx + t * t * bx,
							y: omt * omt * cur.y + 2 * omt * t * cy + t * t * by,
						});
					}
					cur = { x: bx, y: by };
				} else {
					throw new Error(`Unexpected SVG path token: ${cmd}`);
				}
			}
			return sampled;
		};

		const segmentPenetratesCard = (
			a: { readonly x: number; readonly y: number },
			b: { readonly x: number; readonly y: number },
			box: IMissionEdgeObstacle,
		): boolean => {
			const eps = 0.05;
			if (Math.abs(a.x - b.x) < 0.5) {
				const x = a.x;
				const minY = Math.min(a.y, b.y);
				const maxY = Math.max(a.y, b.y);
				return x > box.minX + eps && x < box.maxX - eps && maxY > box.minY + eps && minY < box.maxY - eps;
			}
			if (Math.abs(a.y - b.y) < 0.5) {
				const y = a.y;
				const minX = Math.min(a.x, b.x);
				const maxX = Math.max(a.x, b.x);
				return y > box.minY + eps && y < box.maxY - eps && maxX > box.minX + eps && minX < box.maxX - eps;
			}
			return false;
		};

		const assertZeroPenetrationAnd22pxStubs = (
			ctxLabel: string,
			pts: readonly { readonly x: number; readonly y: number }[],
			svgPath: string,
			fa: { readonly x: number; readonly y: number; readonly nx: number; readonly ny: number; readonly side: 'top' | 'right' | 'bottom' | 'left'; readonly slot: number; readonly fraction: number },
			ta: { readonly x: number; readonly y: number; readonly nx: number; readonly ny: number; readonly side: 'top' | 'right' | 'bottom' | 'left'; readonly slot: number; readonly fraction: number },
			cards: ReadonlyArray<{ readonly id: string; readonly box: IMissionEdgeObstacle }>,
		) => {
			const rawBoxes = cards.map(c => c.box);
			assert.strictEqual(
				satisfiesRigidNormalStubs(pts, fa, ta, ORCH_RIGID_STUB_LENGTH, rawBoxes),
				true,
				`[${ctxLabel}] satisfiesRigidNormalStubs failed: ${JSON.stringify(pts)}`,
			);
			const firstDot = (pts[1].x - pts[0].x) * fa.nx + (pts[1].y - pts[0].y) * fa.ny;
			const lastIdx = pts.length - 1;
			const lastOutDot = (pts[lastIdx - 1].x - pts[lastIdx].x) * ta.nx + (pts[lastIdx - 1].y - pts[lastIdx].y) * ta.ny;
			assert.ok(firstDot >= 21.999, `[${ctxLabel}] Expected >=22px start rigid stub, got ${firstDot}`);
			assert.ok(lastOutDot >= 21.999, `[${ctxLabel}] Expected >=22px end rigid stub, got ${lastOutDot}`);

			for (let s = 0; s < pts.length - 1; s++) {
				for (const card of cards) {
					assert.strictEqual(
						segmentPenetratesCard(pts[s], pts[s + 1], card.box),
						false,
						`[${ctxLabel}] Segment ${s} penetrated 344x188 card ${card.id} (${JSON.stringify(card.box)}): ${JSON.stringify(pts)}`,
					);
				}
			}
			const sampled = sampleSvgPathPoints(svgPath);
			for (const sp of sampled) {
				for (const card of cards) {
					const inside = sp.x > card.box.minX + 0.05
						&& sp.x < card.box.maxX - 0.05
						&& sp.y > card.box.minY + 0.05
						&& sp.y < card.box.maxY - 0.05;
					assert.strictEqual(
						inside,
						false,
						`[${ctxLabel}] Sampled SVG point (${sp.x.toFixed(2)}, ${sp.y.toFixed(2)}) pierced card ${card.id}`,
					);
				}
			}
		};

		const snapBase = makeTreeSnapshot();

		// =========================================================================
		// (1) RADIAL mode: CEO + 6 subordinates -> all 6 edges have ZERO penetration
		//     of any 344x188 card (both forward & reversed `nodes` array orders!)
		// =========================================================================
		const ceoNode = makeAgentNode({ agent_id: 'ceo_radial', name: 'CEO', level: 1, is_top_role: true, parent_id: null });
		const radialSubs = Array.from({ length: 6 }, (_, i) => makeAgentNode({
			agent_id: `sub_radial_${i}`,
			name: `Sub ${i}`,
			level: 2,
			parent_id: 'ceo_radial',
		}));
		const radialSnap: IAdeProjectSnapshot = {
			...snapBase,
			meta: { ...snapBase.meta, layout_direction: 'RADIAL' },
			agents: [ceoNode, ...radialSubs],
			departments: [],
			whiteboards: [],
		};
		const radialGraph = buildProjectOrchestrationGraph(radialSnap);
		const radialPositions = computeOrchestrationLayoutPositions(
			radialGraph.nodes,
			radialGraph.edges,
			radialGraph.departments,
			{ mode: 'radial', direction: 'TD' },
		);
		const radialCards = radialGraph.nodes.map(n => {
			const p = radialPositions.get(n.id)!;
			return {
				id: n.id,
				box: {
					minX: p.x - ORCH_STAFF_CARD_WIDTH / 2,
					maxX: p.x + ORCH_STAFF_CARD_WIDTH / 2,
					minY: p.y - ORCH_STAFF_CARD_HEIGHT / 2,
					maxY: p.y + ORCH_STAFF_CARD_HEIGHT / 2,
				},
			};
		});

		for (const [orderLabel, orderedNodes] of [
			['normal-order', radialGraph.nodes],
			['reversed-nodes-order', [...radialGraph.nodes].reverse()],
		] as const) {
			const radialRouted = computeOrchestrationMultiAnchorRoutes(
				orderedNodes,
				radialGraph.edges,
				radialPositions,
				{ direction: 'TD', layoutMode: 'radial' },
			);
			assert.strictEqual(radialRouted.size, 6, `[RADIAL ${orderLabel}] Expected all 6 CEO->subordinate edges`);
			for (const r of radialRouted.values()) {
				assertZeroPenetrationAnd22pxStubs(`RADIAL/${orderLabel}/${r.edgeId}`, r.points, r.path, r.fromAnchor, r.toAnchor, radialCards);
			}
		}

		// =========================================================================
		// (2) TD detour with adjacent left/right sibling cards at exact 36px net gap
		// =========================================================================
		// Case 2A: Parent(1000,200) -> Target(1000,848) blocked at (1000,524) by mid_center,
		// flanked by mid_left(620,524) & mid_right(1380,524) with exact 36px net gap (old +-210px blind spot!)
		const tdSiblingAgents: IAdeAgentNode[] = [
			makeAgentNode({ agent_id: 'td_p', name: 'TD Parent', level: 1, is_top_role: true, parent_id: null }),
			makeAgentNode({ agent_id: 'mid_left', name: 'Mid Left', level: 2, parent_id: 'td_p' }),
			makeAgentNode({ agent_id: 'mid_center', name: 'Mid Center', level: 2, parent_id: 'td_p' }),
			makeAgentNode({ agent_id: 'mid_right', name: 'Mid Right', level: 2, parent_id: 'td_p' }),
			makeAgentNode({ agent_id: 'td_target', name: 'TD Target', level: 2, parent_id: 'td_p' }),
		];
		const tdSiblingSnap: IAdeProjectSnapshot = {
			...snapBase,
			meta: { ...snapBase.meta, layout_direction: 'TD' },
			agents: tdSiblingAgents,
			departments: [],
			whiteboards: [],
		};
		const tdSiblingGraph = buildProjectOrchestrationGraph(tdSiblingSnap);
		const tdSiblingPositions = new Map<string, IMissionNodePosition>([
			['td_p', { x: 1000, y: 200 }],
			['mid_left', { x: 620, y: 524 }],
			['mid_center', { x: 1000, y: 524 }],
			['mid_right', { x: 1380, y: 524 }],
			['td_target', { x: 1000, y: 848 }],
		]);
		// Verify exact 36px net horizontal gap between adjacent 344x188 sibling cards
		assert.strictEqual((1000 - ORCH_STAFF_CARD_WIDTH / 2) - (620 + ORCH_STAFF_CARD_WIDTH / 2), 36);
		assert.strictEqual((1380 - ORCH_STAFF_CARD_WIDTH / 2) - (1000 + ORCH_STAFF_CARD_WIDTH / 2), 36);

		const tdSiblingCards = tdSiblingGraph.nodes.map(n => {
			const p = tdSiblingPositions.get(n.id)!;
			return {
				id: n.id,
				box: {
					minX: p.x - ORCH_STAFF_CARD_WIDTH / 2,
					maxX: p.x + ORCH_STAFF_CARD_WIDTH / 2,
					minY: p.y - ORCH_STAFF_CARD_HEIGHT / 2,
					maxY: p.y + ORCH_STAFF_CARD_HEIGHT / 2,
				},
			};
		});
		const tdSiblingRouted = computeOrchestrationMultiAnchorRoutes(
			tdSiblingGraph.nodes,
			tdSiblingGraph.edges,
			tdSiblingPositions,
			{ direction: 'TD', layoutMode: 'td' },
		);
		assert.strictEqual(tdSiblingRouted.size, 4);
		for (const r of tdSiblingRouted.values()) {
			assertZeroPenetrationAnd22pxStubs(`TD-36px-Corridor/${r.edgeId}`, r.points, r.path, r.fromAnchor, r.toAnchor, tdSiblingCards);
		}

		// Case 2B: >5 subordinates overflow on l2_center(1000,200) flanked at y=200 by l2_left(620,200) & l2_right(1380,200) at 36px net gap
		const tdOverflowAgents: IAdeAgentNode[] = [
			makeAgentNode({ agent_id: 'l1_top', name: 'L1 Top', level: 1, is_top_role: true, parent_id: null }),
			makeAgentNode({ agent_id: 'l2_left', name: 'L2 Left Sibling', level: 2, parent_id: 'l1_top' }),
			makeAgentNode({ agent_id: 'l2_center', name: 'L2 Center', level: 2, parent_id: 'l1_top' }),
			makeAgentNode({ agent_id: 'l2_right', name: 'L2 Right Sibling', level: 2, parent_id: 'l1_top' }),
			...Array.from({ length: 7 }, (_, i) => makeAgentNode({
				agent_id: `l3_kid_${i}`,
				name: `L3 Kid ${i}`,
				level: 3,
				parent_id: 'l2_center',
			})),
		];
		const tdOverflowGraph = buildProjectOrchestrationGraph({
			...snapBase,
			meta: { ...snapBase.meta, layout_direction: 'TD' },
			agents: tdOverflowAgents,
			departments: [],
			whiteboards: [],
		});
		const tdOverflowPositions = new Map<string, IMissionNodePosition>([
			['l1_top', { x: 1000, y: -124 }],
			['l2_left', { x: 620, y: 200 }],
			['l2_center', { x: 1000, y: 200 }],
			['l2_right', { x: 1380, y: 200 }],
			...Array.from({ length: 7 }, (_, i) => [`l3_kid_${i}`, { x: -140 + i * 380, y: 524 }] as const),
		]);
		const tdOverflowCards = tdOverflowGraph.nodes.map(n => {
			const p = tdOverflowPositions.get(n.id)!;
			return {
				id: n.id,
				box: {
					minX: p.x - ORCH_STAFF_CARD_WIDTH / 2,
					maxX: p.x + ORCH_STAFF_CARD_WIDTH / 2,
					minY: p.y - ORCH_STAFF_CARD_HEIGHT / 2,
					maxY: p.y + ORCH_STAFF_CARD_HEIGHT / 2,
				},
			};
		});
		const tdOverflowRouted = computeOrchestrationMultiAnchorRoutes(
			tdOverflowGraph.nodes,
			tdOverflowGraph.edges,
			tdOverflowPositions,
			{ direction: 'TD', layoutMode: 'td' },
		);
		for (const r of tdOverflowRouted.values()) {
			assertZeroPenetrationAnd22pxStubs(`TD-36px-Overflow/${r.edgeId}`, r.points, r.path, r.fromAnchor, r.toAnchor, tdOverflowCards);
		}

		// =========================================================================
		// (3) Near-distance 16~34px non-overlapping drag (p=(0,0), c=(80,220) [32px] & (80,208) [20px])
		//     -> ZERO penetration of either card + strict 22px rigid stubs on both compute & reanchor!
		// =========================================================================
		const dragPairSnap: IAdeProjectSnapshot = {
			...snapBase,
			meta: { ...snapBase.meta, layout_direction: 'TD' },
			agents: [
				makeAgentNode({ agent_id: 'p_drag', name: 'Parent Drag', level: 1, is_top_role: true, parent_id: null }),
				makeAgentNode({ agent_id: 'c_drag', name: 'Child Drag', level: 2, parent_id: 'p_drag' }),
			],
			departments: [],
			whiteboards: [],
		};
		const dragPairGraph = buildProjectOrchestrationGraph(dragPairSnap);
		const dragNodesById = new Map(dragPairGraph.nodes.map(n => [n.id, n]));
		const dragEdge = dragPairGraph.edges[0]!;

		// Initial far TD route (bottom -> top) before live dragging child into 16~34px slit
		const farPositions = new Map<string, IMissionNodePosition>([
			['p_drag', { x: 0, y: 0 }],
			['c_drag', { x: 0, y: 324 }],
		]);
		const initialFarRoute = computeOrchestrationMultiAnchorRoutes(
			dragPairGraph.nodes,
			dragPairGraph.edges,
			farPositions,
			{ direction: 'TD', layoutMode: 'td' },
		).get(dragEdge.id)!;
		assert.strictEqual(initialFarRoute.fromAnchor.side, 'bottom');
		assert.strictEqual(initialFarRoute.toAnchor.side, 'top');

		const nearDragCases: ReadonlyArray<{
			readonly label: string;
			readonly dir: 'TD' | 'LR';
			readonly pPos: IMissionNodePosition;
			readonly cPos: IMissionNodePosition;
			readonly expectedGap: number;
		}> = [
			{ label: 'TD gap=32px p=(0,0) c=(80,220)', dir: 'TD', pPos: { x: 0, y: 0 }, cPos: { x: 80, y: 220 }, expectedGap: 32 },
			{ label: 'TD gap=20px p=(0,0) c=(80,208)', dir: 'TD', pPos: { x: 0, y: 0 }, cPos: { x: 80, y: 208 }, expectedGap: 20 },
			{ label: 'TD gap=16px p=(0,0) c=(80,204)', dir: 'TD', pPos: { x: 0, y: 0 }, cPos: { x: 80, y: 204 }, expectedGap: 16 },
			{ label: 'TD gap=34px p=(0,0) c=(-80,222)', dir: 'TD', pPos: { x: 0, y: 0 }, cPos: { x: -80, y: 222 }, expectedGap: 34 },
			{ label: 'LR gap=20px p=(0,0) c=(364,80)', dir: 'LR', pPos: { x: 0, y: 0 }, cPos: { x: 364, y: 80 }, expectedGap: 20 },
			{ label: 'LR gap=32px p=(0,0) c=(376,80)', dir: 'LR', pPos: { x: 0, y: 0 }, cPos: { x: 376, y: 80 }, expectedGap: 32 },
		];

		for (const nc of nearDragCases) {
			const actualGap = nc.dir === 'TD'
				? Math.abs(nc.cPos.y - nc.pPos.y) - ORCH_STAFF_CARD_HEIGHT
				: Math.abs(nc.cPos.x - nc.pPos.x) - ORCH_STAFF_CARD_WIDTH;
			assert.strictEqual(actualGap, nc.expectedGap);

			const posMap = new Map<string, IMissionNodePosition>([
				['p_drag', nc.pPos],
				['c_drag', nc.cPos],
			]);
			const cards = [
				{
					id: 'p_drag',
					box: {
						minX: nc.pPos.x - ORCH_STAFF_CARD_WIDTH / 2,
						maxX: nc.pPos.x + ORCH_STAFF_CARD_WIDTH / 2,
						minY: nc.pPos.y - ORCH_STAFF_CARD_HEIGHT / 2,
						maxY: nc.pPos.y + ORCH_STAFF_CARD_HEIGHT / 2,
					},
				},
				{
					id: 'c_drag',
					box: {
						minX: nc.cPos.x - ORCH_STAFF_CARD_WIDTH / 2,
						maxX: nc.cPos.x + ORCH_STAFF_CARD_WIDTH / 2,
						minY: nc.cPos.y - ORCH_STAFF_CARD_HEIGHT / 2,
						maxY: nc.cPos.y + ORCH_STAFF_CARD_HEIGHT / 2,
					},
				},
			];
			const paddedObs = cards.map(c => ({
				id: c.id,
				box: {
					minX: c.box.minX - 10,
					maxX: c.box.maxX + 10,
					minY: c.box.minY - 10,
					maxY: c.box.maxY + 10,
				},
			}));

			const computed = computeOrchestrationMultiAnchorRoutes(
				dragPairGraph.nodes,
				dragPairGraph.edges,
				posMap,
				{ direction: nc.dir, layoutMode: nc.dir === 'LR' ? 'lr' : 'td' },
			).get(dragEdge.id)!;
			assertZeroPenetrationAnd22pxStubs(`NearDrag-Computed/${nc.label}`, computed.points, computed.path, computed.fromAnchor, computed.toAnchor, cards);

			const reanchored = reanchorOrchestrationRoute(dragEdge, initialFarRoute, dragNodesById, posMap, paddedObs, nc.dir);
			assertZeroPenetrationAnd22pxStubs(`NearDrag-Reanchored/${nc.label}`, reanchored.points, reanchored.path, reanchored.fromAnchor, reanchored.toAnchor, cards);
		}

		// =========================================================================
		// (4) Collapsed left sidebar + selectedProjectPageId === undefined:
		//     ADE_RENAME_PROJECT_PAGE_COMMAND_ID opens IQuickInputService.input & renames active page!
		// =========================================================================
		let currentPageName = 'Before Collapse Rename';
		const renameCalls: Array<{ readonly projectId: string; readonly name: string }> = [];
		const onDidChangeCatalog = store.add(new Emitter<void>());

		const renameMockCc = {
			_serviceBrand: undefined,
			onDidChangeCatalog: onDidChangeCatalog.event,
			onDidChangeProject: Event.None,
			onDidTransferTicket: Event.None,
			onDidEnqueueOutbox: Event.None,
			onDidCancelOutboxTickets: Event.None,
			onDidDisposeAgentRuntime: Event.None,
			registerWorkspaceFolder: async () => ({
				folder_id: 'fld_c8',
				folder_uri: 'file:///workspace/c8',
				display_name: 'c8',
				host: 'local',
				sort_order: 10,
				collapsed: false,
				created_at: 1,
				updated_at: 1,
			}),
			listAllBoundSessionResources: async () => [],
			getCatalogSnapshot: async () => ({
				folders: [{
					folder_id: 'fld_c8',
					folder_uri: 'file:///workspace/c8',
					display_name: 'c8',
					host: 'local',
					sort_order: 10,
					collapsed: false,
					created_at: 1,
					updated_at: 1,
				}],
				projects: [{
					project_id: 'proj_c8',
					folder_id: 'fld_c8',
					folder_uri: 'file:///workspace/c8',
					name: currentPageName,
					sort_order: 10,
					created_at: 1,
					updated_at: 2,
				}],
			}),
			getProjectSnapshot: async (projectId: string) => {
				if (projectId !== 'proj_c8') {
					return undefined;
				}
				return {
					...snapBase,
					meta: {
						...snapBase.meta,
						project_id: 'proj_c8',
						name: currentPageName,
					},
				};
			},
			renameProject: async (projectId: string, name: string) => {
				renameCalls.push({ projectId, name });
				currentPageName = name;
				onDidChangeCatalog.fire();
			},
		} as unknown as IAdeControlCenterService;

		const insta = workbenchInstantiationService({
			adeControlCenterService: () => renameMockCc,
		}, store);

		insta.stub(IAdeEditorService, {
			_serviceBrand: undefined,
			activeEditor: undefined,
			getActiveProjectPageId: () => 'proj_c8',
			closeProjectPageEditors: async () => { },
			isSessionActive: () => false,
		} as unknown as IAdeEditorService);

		insta.stub(IViewsService, {
			_serviceBrand: undefined,
			getActiveViewWithId: () => null,
		} as unknown as IViewsService);

		insta.stub(ICommandService, {
			_serviceBrand: undefined,
			onWillExecuteCommand: Event.None,
			onDidExecuteCommand: Event.None,
			executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
				const cmd = CommandsRegistry.getCommand(id);
				assert.ok(cmd, `Expected registered command ${id}`);
				return insta.invokeFunction(cmd.handler, ...args) as unknown as Promise<T>;
			},
		} as unknown as ICommandService);

		const projects = store.add(insta.createInstance(AdeProjectsService));
		insta.stub(IAdeProjectsService, projects);
		await projects.whenReady();

		// Precondition: sidebar tree never selected any Project Page (`selectedProjectPageId === undefined`)!
		assert.strictEqual(projects.selectedProjectPageId, undefined);
		assert.strictEqual(projects.getProjectPage('proj_c8')?.name, 'Before Collapse Rename');

		let inputPromptCount = 0;
		let initialInputValue: string | undefined;
		insta.stub(IQuickInputService, 'input', async (opts?: { readonly value?: string }) => {
			inputPromptCount++;
			initialInputValue = opts?.value;
			return '  After Collapse Rename  ';
		});

		const commandService = insta.get(ICommandService);
		const renamed = await commandService.executeCommand<string | undefined>(ADE_RENAME_PROJECT_PAGE_COMMAND_ID);
		assert.strictEqual(inputPromptCount, 1, 'IQuickInputService.input must open when sidebar is collapsed and selectedProjectPageId is undefined');
		assert.strictEqual(initialInputValue, 'Before Collapse Rename');
		assert.strictEqual(renamed, 'After Collapse Rename');
		assert.deepStrictEqual(renameCalls, [{ projectId: 'proj_c8', name: 'After Collapse Rename' }]);
		assert.strictEqual(projects.getProjectPage('proj_c8')?.name, 'After Collapse Rename');

		// Also verify direct helper invocation without explicit projectId while selectedProjectPageId remains undefined
		assert.strictEqual(projects.selectedProjectPageId, undefined);
		const helperRenamed = await insta.invokeFunction(acc => promptRenameAdeProjectPage(acc, undefined, 'Direct Helper Rename'));
		assert.strictEqual(helperRenamed, 'Direct Helper Rename');
		assert.strictEqual(projects.getProjectPage('proj_c8')?.name, 'Direct Helper Rename');
	});
});
