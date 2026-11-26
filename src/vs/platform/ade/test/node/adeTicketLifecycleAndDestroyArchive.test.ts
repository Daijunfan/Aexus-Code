/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ADE_WB_COMMANDS_WITH_UNREAD_COUNT } from '../../common/adeCliManifest.js';
import { IAdeVerifiedCliCaller } from '../../common/adeControlCenterIpc.js';
import { AdeError, AdeErrorCode, canonicalEdgePairKey } from '../../common/adeModels.js';
import { AdeControlCenterService } from '../../node/adeControlCenterService.js';

async function assertRejectsAdeCode(fn: () => Promise<unknown>, expectedCode: AdeErrorCode): Promise<void> {
	let caught: unknown;
	try {
		await fn();
	} catch (err) {
		caught = err;
	}
	assert.ok(caught instanceof AdeError, `Expected AdeError(${expectedCode}), got ${String(caught)}`);
	assert.strictEqual(caught.code, expectedCode);
}

suite('adeTicketLifecycleAndDestroyArchive Gate (plan.md §3.3, §4.5, §5 & §9.2.4)', () => {
	let tempDir: string;
	let svc: AdeControlCenterService;
	let activeSvc: AdeControlCenterService | undefined;

	teardown(async () => {
		if (activeSvc) {
			const toClose = activeSvc;
			activeSvc = undefined;
			await toClose.gracefulShutdown();
		}
	});

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(async () => {
		if (tempDir) {
			await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	setup(async () => {
		const baseTmp = isWindows ? os.tmpdir() : '/tmp';
		tempDir = await fs.promises.mkdtemp(path.join(baseTmp, 'ade-tk-'));
		svc = new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'ade-home'),
			socketPath: isWindows ? undefined : path.join(tempDir, 't.sock'),
			persistIdempotencyLedger: false,
			customLocalEngineProber: async () => ['claude', 'codex'],
		});
		activeSvc = svc;
		await svc.whenReady();
	});

	const makeCaller = (projectId: string, agentId: string): IAdeVerifiedCliCaller => ({
		projectId,
		agentId,
		host: 'local',
		tokenGen: 1,
	});

	test('verifies L1<->L3 multi-hop Ticket round-trip, default queue reset, archived_detail_gzip lossless UI restore & physical tombstone cleanup on ade_destroy', async () => {
		const wsDir = path.join(tempDir, 'ws-ticket');
		await fs.promises.mkdir(wsDir, { recursive: true });
		const proj = await svc.createProject({ folderUri: URI.file(wsDir).toString(), name: 'TicketProj' });
		const pid = proj.meta.project_id;

		const l1 = await svc.uiCreateAgent({
			projectId: pid,
			parentId: null,
			level: 1,
			name: 'L1_Arch',
			roleSummary: 'Chief Architect',
			host: 'local',
			engine: 'claude',
			model: 'claude-sonnet-4-5',
			effort: 'high',
		});
		const cL1 = makeCaller(pid, l1.agent_id);

		const l2Id = String((await svc.executeCliCommand(cL1, 'ade_agent_create', {
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-5', effort: 'high', level: 'L2', name: 'L2_Mid', role: 'Mid',
		})).agent_id);
		const l3Id = String((await svc.executeCliCommand(cL1, 'ade_agent_create', {
			host: 'local', engine: 'codex', model: 'gpt-5', effort: 'medium', level: 'L3', name: 'L3_Worker', role: 'Worker', parent: l2Id,
		})).agent_id);
		const cL2 = makeCaller(pid, l2Id);
		const cL3 = makeCaller(pid, l3Id);

		// Track 3000ms transfer animation events
		const animEvents: Array<{ total_hops: number }> = [];
		store.add(svc.onDidTransferTicket(ev => {
			animEvents.push({ total_hops: ev.hops.length });
		}));

		// L1 -> L3 (2 hops across L1<->L2 and L2<->L3) with mode='steer' and need_return=true
		const detailHop1 = 'Full technical design for hop 1 — implement HMAC verifier with constant-time compare.';
		const created = await svc.executeCliCommand(cL1, 'ade_create', {
			to: l3Id,
			type: 'dev',
			title: 'Implement HMAC',
			summary: 'Complete mutual HMAC\nwith tests',
			needReturn: 'true',
			mode: 'steer',
			detail: detailHop1,
		});
		const ticketId = String(created.ticket_id);
		const task1Id = String(created.task_id);
		assert.deepStrictEqual(Object.keys(created).sort(), ['ok', 'task_id', 'ticket_id']);
		assert.strictEqual(animEvents.length, 1);
		assert.strictEqual(animEvents[0].total_hops, 2);

		// Verify outbox payload exact line-1 Ticket prefix (`[系统提示词: 此消息是来自Agent {<from_id>}的Ticket] `) & window disconnect recovery
		const claimedWin1 = await svc.claimPendingDeliveries(101);
		assert.strictEqual(claimedWin1.length, 1);
		const line1 = claimedWin1[0].payloadText.split('\n')[0];
		assert.strictEqual(line1, `[系统提示词: 此消息是来自Agent {${l1.agent_id}}的Ticket] `);

		// Simulate window 101 Cmd+R reload -> `in_flight` resets to `pending` so window 102 reclaims cleanly!
		await svc.releaseWindowDeliveries(101);
		const claimedWin2 = await svc.claimPendingDeliveries(102);
		assert.strictEqual(claimedWin2.length, 1);
		assert.strictEqual(claimedWin2[0].ticketId, ticketId);
		await svc.ackDeliveryDispatched(claimedWin2[0].deliveryId, 102);

		// Verify `ade_get` exact 10 public fields under `ticket` key
		const get1 = await svc.executeCliCommand(cL3, 'ade_get', { ticketId });
		const pubTk = get1.ticket as Record<string, unknown>;
		assert.deepStrictEqual(
			Object.keys(pubTk).sort(),
			['creator_id', 'current_task', 'delivery_mode', 'from_id', 'has_history_ref', 'need_return', 'project_id', 'ticket_id', 'ticket_level', 'to_id'],
		);
		assert.strictEqual(pubTk.delivery_mode, 'steer');

		// Unrelated third party L2 is blocked from reading (`ERR_FORBIDDEN`) and editing (`ERR_NOT_HOLDER`)
		await assertRejectsAdeCode(() => svc.executeCliCommand(cL2, 'ade_get', { ticketId }), 'ERR_FORBIDDEN');
		await assertRejectsAdeCode(() => svc.executeCliCommand(cL2, 'ade_destroy', { ticketId }), 'ERR_NOT_HOLDER');

		// Holder L3 cannot destroy while `need_return === true` -> ERR_RETURN_REQUIRED
		await assertRejectsAdeCode(() => svc.executeCliCommand(cL3, 'ade_destroy', { ticketId }), 'ERR_RETURN_REQUIRED');

		// L3 edits & returns Ticket to L1 WITHOUT passing `--mode` -> delivery_mode resets to `'queue'`!
		const detailHop2 = 'All 45 commands & HMAC tests passing; ready for final sign-off.';
		const edited = await svc.executeCliCommand(cL3, 'ade_edit', {
			ticketId,
			type: 'review',
			title: 'HMAC Ready',
			summary: 'Please review',
			needReturn: 'false',
			detail: detailHop2,
		});
		const task2Id = String(edited.task_id);
		assert.deepStrictEqual(Object.keys(edited).sort(), ['ok', 'task_id', 'ticket_id', 'to_id']);
		assert.strictEqual(edited.to_id, l1.agent_id);

		const get2 = await svc.executeCliCommand(cL1, 'ade_get', { ticketId });
		assert.strictEqual((get2.ticket as Record<string, unknown>).delivery_mode, 'queue');
		assert.strictEqual((get2.ticket as Record<string, unknown>).has_history_ref, true);

		const hist = await svc.executeCliCommand(cL1, 'ade_history', { ticketId });
		const histTasks = hist.tasks as Array<{ task_id: string }>;
		assert.strictEqual(histTasks.length, 1);
		assert.strictEqual(histTasks[0].task_id, task1Id);

		// Record physical ticket storage dir before `ade_destroy`
		const ticketStoreDir = path.join(svc.sqliteStore.localStoreRootDir, `${pid}_tickets`, ticketId);
		const filesBeforeDestroy = await fs.promises.readdir(ticketStoreDir);
		assert.strictEqual(filesBeforeDestroy.length, 2);

		// L1 destroys completed Ticket (`need_return === false`)
		const destroyed = await svc.executeCliCommand(cL1, 'ade_destroy', { ticketId });
		assert.deepStrictEqual(destroyed, { ok: true, ticket_id: ticketId });
		await svc.storageEngine.drainTombstonesAsync();

		// 1. Every Agent CLI now sees ERR_TICKET_NOT_FOUND
		await assertRejectsAdeCode(() => svc.executeCliCommand(cL1, 'ade_get', { ticketId }), 'ERR_TICKET_NOT_FOUND');
		await assertRejectsAdeCode(() => svc.executeCliCommand(cL1, 'ade_detail', { ticketId, taskId: task1Id }), 'ERR_TICKET_NOT_FOUND');
		await assertRejectsAdeCode(() => svc.executeCliCommand(cL3, 'ade_history', { ticketId }), 'ERR_TICKET_NOT_FOUND');

		// 2. Physical files in `ade-store` are 100% deleted via tombstones
		const dirStillExists = await fs.promises.access(ticketStoreDir).then(() => true, () => false);
		assert.strictEqual(dirStillExists, false, 'Ticket physical detail directory must be completely removed after ade_destroy');

		// 3. Human UI Click panel still inspects edge transfer history AND decompresses `archived_detail_gzip` losslessly!
		const edgeHistory = await svc.listEdgeTicketTransfers(pid, canonicalEdgePairKey(l1.agent_id, l2Id));
		assert.strictEqual(edgeHistory.length, 2);
		assert.strictEqual(edgeHistory[0].ticket_status, 'destroyed');

		const uiInspection = await svc.inspectTicketFullDetailForUi(pid, ticketId);
		assert.ok(uiInspection);
		assert.strictEqual(uiInspection.status, 'destroyed');
		assert.strictEqual(uiInspection.all_tasks.length, 2);
		assert.strictEqual(await svc.readTicketTaskDetailForUi(pid, ticketId, task1Id), detailHop1);
		assert.strictEqual(await svc.readTicketTaskDetailForUi(pid, ticketId, task2Id), detailHop2);
	});

	test('verifies 4-step assertTicketAccess on frozen_orphan tickets and top-level unread_count across all 17 single-board commands', async () => {
		const wsDir = path.join(tempDir, 'ws-frozen');
		await fs.promises.mkdir(wsDir, { recursive: true });
		const uploadSample = path.join(wsDir, 'sample.txt');
		await fs.promises.writeFile(uploadSample, 'sample-payload', 'utf8');

		const proj = await svc.createProject({ folderUri: URI.file(wsDir).toString(), name: 'FrozenAndWbProj' });
		const pid = proj.meta.project_id;

		const l1 = await svc.uiCreateAgent({
			projectId: pid,
			parentId: null,
			level: 1,
			name: 'L1',
			roleSummary: 'Top',
			host: 'local',
			engine: 'claude',
			model: 'claude-sonnet-4-5',
			effort: 'high',
		});
		const cL1 = makeCaller(pid, l1.agent_id);
		const l2 = String((await svc.executeCliCommand(cL1, 'ade_agent_create', {
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-5', effort: 'high', level: 'L2', name: 'L2_Temp', role: 'Sub',
		})).agent_id);
		const l2Other = String((await svc.executeCliCommand(cL1, 'ade_agent_create', {
			host: 'local', engine: 'codex', model: 'gpt-5', effort: 'medium', level: 'L2', name: 'L2_Other', role: 'Other',
		})).agent_id);
		const cL2Other = makeCaller(pid, l2Other);

		const tkId = String((await svc.executeCliCommand(cL1, 'ade_create', {
			to: l2, type: 'dev', title: 'Work', summary: 'Do work', needReturn: 'false',
		})).ticket_id);

		// Deleting L2 moves tkId to `frozen_orphan` and cancels pending outbox deliveries!
		const delRes = await svc.executeCliCommand(cL1, 'ade_agent_delete', { agentId: l2 });
		assert.deepStrictEqual(delRes.frozen_ticket_ids, [tkId]);
		assert.strictEqual((await svc.claimPendingDeliveries(1)).length, 0);

		// Bound party L1 calling ade_edit / ade_destroy -> ERR_TICKET_FROZEN; read-only ade_get still works;
		// Unrelated L2_Other calling ade_edit / ade_destroy -> ERR_NOT_HOLDER (never leaks ERR_TICKET_FROZEN!)
		await assertRejectsAdeCode(() => svc.executeCliCommand(cL1, 'ade_destroy', { ticketId: tkId }), 'ERR_TICKET_FROZEN');
		await assertRejectsAdeCode(() => svc.executeCliCommand(cL1, 'ade_edit', {
			ticketId: tkId, type: 'dev', title: 'T', summary: 'S', needReturn: 'false',
		}), 'ERR_TICKET_FROZEN');
		await assertRejectsAdeCode(() => svc.executeCliCommand(cL2Other, 'ade_destroy', { ticketId: tkId }), 'ERR_NOT_HOLDER');
		const readFrozen = await svc.executeCliCommand(cL1, 'ade_get', { ticketId: tkId });
		assert.strictEqual(readFrozen.ok, true);

		// Verify all 17 single-whiteboard commands return top-level integer `unread_count`
		const createdWb = await svc.executeCliCommand(cL1, 'ade_wb_create', { name: 'Board17', tags: 't1,t2' });
		const boardId = String(createdWb.board_id);
		await svc.executeCliCommand(cL1, 'ade_wb_grant', { boardId, to: l2Other, perm: 'read_write' });
		const postMsg = await svc.executeCliCommand(cL1, 'ade_wb_post_msg', { boardId, summary: 'M', stars: '3', tags: 't1', detail: 'Long msg' });
		const msgId = String(postMsg.item_id);
		const upFile = await svc.executeCliCommand(cL1, 'ade_wb_upload_file', { boardId, file: uploadSample, summary: 'F', stars: '4' });
		const fileId = String(upFile.item_id);
		const longNoteText = 'N'.repeat(320);
		const sentNote = await svc.executeCliCommand(cL2Other, 'ade_wb_note_send', { boardId, to: l1.agent_id, text: longNoteText });
		const noteId = String(sentNote.note_id);

		const dlPath = path.join(tempDir, 'dl-sample.txt');
		const responsesByCmd: Record<string, Record<string, unknown>> = {
			ade_wb_create: createdWb,
			ade_wb_my_perm: await svc.executeCliCommand(cL1, 'ade_wb_my_perm', { boardId }),
			ade_wb_members: await svc.executeCliCommand(cL1, 'ade_wb_members', { boardId }),
			ade_wb_config: await svc.executeCliCommand(cL1, 'ade_wb_config', { boardId, name: 'Board17Renamed' }),
			ade_wb_tags: await svc.executeCliCommand(cL1, 'ade_wb_tags', { boardId }),
			ade_wb_tag_manage: await svc.executeCliCommand(cL1, 'ade_wb_tag_manage', { boardId, action: 'add', tags: 't3' }),
			ade_wb_post_msg: postMsg,
			ade_wb_upload_file: upFile,
			ade_wb_items: await svc.executeCliCommand(cL1, 'ade_wb_items', { boardId }),
			ade_wb_get_msg: await svc.executeCliCommand(cL1, 'ade_wb_get_msg', { boardId, itemId: msgId }),
			ade_wb_download: await svc.executeCliCommand(cL1, 'ade_wb_download', { boardId, itemId: fileId, dest: dlPath }),
			ade_wb_edit_item: await svc.executeCliCommand(cL1, 'ade_wb_edit_item', { boardId, itemId: msgId, summary: 'M2' }),
			ade_wb_manage_item: await svc.executeCliCommand(cL1, 'ade_wb_manage_item', { boardId, itemId: msgId, pin: 'true' }),
			ade_wb_note_send: sentNote,
			ade_wb_note_detail: await svc.executeCliCommand(cL1, 'ade_wb_note_detail', { boardId, noteId }),
			ade_wb_note_unread: await svc.executeCliCommand(cL1, 'ade_wb_note_unread', { boardId }),
			ade_wb_delete_item: await svc.executeCliCommand(cL1, 'ade_wb_delete_item', { boardId, itemId: msgId }),
		};

		assert.strictEqual(Object.keys(responsesByCmd).length, ADE_WB_COMMANDS_WITH_UNREAD_COUNT.length);
		for (const cmdName of ADE_WB_COMMANDS_WITH_UNREAD_COUNT) {
			const r = responsesByCmd[cmdName];
			assert.ok(r, `Missing response check for ${cmdName}`);
			assert.strictEqual(typeof r.unread_count, 'number', `${cmdName} must return top-level integer unread_count`);
		}
		assert.strictEqual(responsesByCmd.ade_wb_my_perm.unread_count, 1);
		assert.strictEqual(responsesByCmd.ade_wb_note_unread.unread_count, 0);
	});

	test('verifies uiUpdateCanvasLayout(resetPinnedPositions: true), launchBundle credential reuse, and durable frozen_orphan persistence on ade_edit', async () => {
		const wsDir = path.join(tempDir, 'ws-layout-reset');
		await fs.promises.mkdir(wsDir, { recursive: true });
		const proj = await svc.createProject({ folderUri: URI.file(wsDir).toString(), name: 'LayoutAndFreezeProj' });
		const pid = proj.meta.project_id;

		const l1 = await svc.uiCreateAgent({
			projectId: pid, parentId: null, level: 1, name: 'L1', roleSummary: 'Lead',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-5', effort: 'high',
			canvasX: 120, canvasY: 80,
		});
		const l2 = await svc.uiCreateAgent({
			projectId: pid, parentId: l1.agent_id, level: 2, name: 'L2', roleSummary: 'Dev',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-5', effort: 'high',
			canvasX: 340, canvasY: 260,
		});
		const wb = await svc.uiCreateWhiteboard({
			projectId: pid, name: 'PinnedBoard', canvasX: 500, canvasY: 140,
		});

		// 1. Repeated issueAgentLaunchBundle calls reuse the exact same credential without inflating _sessionsByJti
		const b1 = await svc.issueAgentLaunchBundle(pid, l1.agent_id);
		const b2 = await svc.issueAgentLaunchBundle(pid, l1.agent_id);
		assert.strictEqual(b1.agentToken, b2.agentToken);
		assert.strictEqual(svc.controlServer.activeSessionCredentialCount, 1);

		// Switching engine on unstarted L2 rotates token_gen and evicts previous L2 token cleanly
		const bL2Old = await svc.issueAgentLaunchBundle(pid, l2.agent_id);
		assert.strictEqual(svc.controlServer.activeSessionCredentialCount, 2);
		await svc.uiEditAgent({ projectId: pid, agentId: l2.agent_id, engine: 'codex', model: 'gpt-5' });
		assert.strictEqual(svc.controlServer.activeSessionCredentialCount, 1);
		const bL2New = await svc.issueAgentLaunchBundle(pid, l2.agent_id);
		assert.notStrictEqual(bL2New.agentToken, bL2Old.agentToken);
		assert.strictEqual(svc.controlServer.activeSessionCredentialCount, 2);

		// 2. uiUpdateCanvasLayout with resetPinnedPositions: true atomically clears canvas_x/canvas_y on agents & whiteboards
		await svc.uiUpdateCanvasLayout(pid, { layoutDirection: 'LR', resetPinnedPositions: true });
		const snap = (await svc.getProjectSnapshot(pid))!;
		assert.strictEqual(snap.meta.layout_direction, 'LR');
		for (const ag of snap.agents) {
			assert.strictEqual(ag.canvas_x, undefined, `Expected agent ${ag.agent_id} canvas_x reset to undefined`);
			assert.strictEqual(ag.canvas_y, undefined, `Expected agent ${ag.agent_id} canvas_y reset to undefined`);
		}
		const resetWb = snap.whiteboards.find(w => w.board_id === wb.board_id)!;
		assert.strictEqual(resetWb.canvas_x, undefined);
		assert.strictEqual(resetWb.canvas_y, undefined);

		// 3. When pair jurisdiction becomes invalid before ade_edit, status='frozen_orphan' is committed (not rolled back!)
		const l2Other = await svc.uiCreateAgent({
			projectId: pid, parentId: l1.agent_id, level: 2, name: 'L2Other', roleSummary: 'Other',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-5', effort: 'high',
		});
		const l3 = await svc.uiCreateAgent({
			projectId: pid, parentId: l2.agent_id, level: 3, name: 'L3', roleSummary: 'Leaf',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-5', effort: 'high',
		});
		const cL2: IAdeVerifiedCliCaller = { projectId: pid, agentId: l2.agent_id, host: 'local', tokenGen: 2 };
		const cL3: IAdeVerifiedCliCaller = { projectId: pid, agentId: l3.agent_id, host: 'local', tokenGen: 1 };
		const tkId = String((await svc.executeCliCommand(cL2, 'ade_create', {
			to: l3.agent_id, type: 'dev', title: 'Task', summary: 'Init', needReturn: 'true',
		})).ticket_id);
		const pdb = svc.sqliteStore.openProjectDb(pid);
		// Simulate an un-reconciled reparenting where L3 moved under L2Other while ticket stayed active
		await pdb.run('UPDATE agents SET parent_id = ? WHERE agent_id = ?', [l2Other.agent_id, l3.agent_id]);

		await assertRejectsAdeCode(() => svc.executeCliCommand(cL3, 'ade_edit', {
			ticketId: tkId, type: 'dev', title: 'Reply', summary: 'Done', needReturn: 'false', detail: 'Should not leak blob',
		}), 'ERR_TICKET_FROZEN');

		const tkRow = await pdb.get<{ status: string; holder_id: string | null }>('SELECT status, holder_id FROM tickets WHERE ticket_id = ?', [tkId]);
		assert.strictEqual(tkRow?.status, 'frozen_orphan');
		assert.strictEqual(tkRow?.holder_id, null);
	});
});
