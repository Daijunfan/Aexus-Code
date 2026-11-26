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
import { IAdeVerifiedCliCaller } from '../../common/adeControlCenterIpc.js';
import { AdeError, AdeErrorCode } from '../../common/adeModels.js';
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

suite('adeJurisdictionAndDepartmentMath Gate (plan.md §4 & §9.2.3)', () => {
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

	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(async () => {
		if (tempDir) {
			await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	setup(async () => {
		const baseTmp = await fs.promises.realpath(isWindows ? os.tmpdir() : '/tmp');
		tempDir = await fs.promises.mkdtemp(path.join(baseTmp, 'ade-jur-'));
		svc = new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'ade-home'),
			socketPath: isWindows ? undefined : path.join(tempDir, 'j.sock'),
			persistIdempotencyLedger: false,
			customLocalEngineProber: async () => ['claude', 'codex', 'pi'],
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

	test('enforces cross-department isolation (ERR_CROSS_DEPT), outer-wrapping-dept allowance, Patch A1/A2 & parent_dept_id recomputation', async () => {
		const wsDir = path.join(tempDir, 'ws-math');
		await fs.promises.mkdir(wsDir, { recursive: true });
		const proj = await svc.createProject({ folderUri: URI.file(wsDir).toString(), name: 'MathProj' });
		const pid = proj.meta.project_id;

		// Create L1 top role -> L2 manager -> L3 sub-lead -> L4 engineer
		const l1 = await svc.uiCreateAgent({
			projectId: pid,
			parentId: null,
			level: 1,
			name: 'L1_CEO',
			roleSummary: 'Top Role',
			host: 'local',
			engine: 'claude',
			model: 'claude-sonnet-4-5',
			effort: 'high',
		});
		const cL1 = makeCaller(pid, l1.agent_id);

		const l2Res = await svc.executeCliCommand(cL1, 'ade_agent_create', {
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-5', effort: 'high', level: 'L2', name: 'L2_Mgr', role: 'Mgr',
		});
		const l2Id = String(l2Res.agent_id);
		const cL2 = makeCaller(pid, l2Id);

		const l3Res = await svc.executeCliCommand(cL2, 'ade_agent_create', {
			host: 'local', engine: 'codex', model: 'gpt-5', effort: 'medium', level: 'L3', name: 'L3_Lead', role: 'SubLead',
		});
		const l3Id = String(l3Res.agent_id);
		const cL3 = makeCaller(pid, l3Id);

		const l4Res = await svc.executeCliCommand(cL3, 'ade_agent_create', {
			host: 'local', engine: 'pi', model: 'default', effort: 'medium', level: 'L4', name: 'L4_Dev', role: 'Dev',
		});
		const l4Id = String(l4Res.agent_id);

		// Anti-hollowing theorem (§4.3): L2 (non-top, without outer wrapping dept) CANNOT create a sub-dept rooted at L3 (would immediately self-lockout!)
		await assertRejectsAdeCode(
			() => svc.executeCliCommand(cL2, 'ade_dept_create', { root: l3Id, name: 'IllegalSubDept' }),
			'ERR_FORBIDDEN_HIERARCHY',
		);

		// L1 creates inner sub-dept D_sub rooted at L3 (while L2 holds NO outer wrapping dept)
		const dSubRes = await svc.executeCliCommand(cL1, 'ade_dept_create', { root: l3Id, name: 'SubDept' });
		const dSubId = String(dSubRes.dept_id);
		assert.deepStrictEqual(Object.keys(dSubRes).sort(), ['dept_id', 'ok', 'parent_dept_id', 'root_agent_id']);
		assert.strictEqual(dSubRes.parent_dept_id, null);

		// Duplicate dept on same root -> strictly ERR_IS_DEPT_ROOT
		await assertRejectsAdeCode(
			() => svc.executeCliCommand(cL1, 'ade_dept_create', { root: l3Id, name: 'DupSubDept' }),
			'ERR_IS_DEPT_ROOT',
		);

		// L2 (no outer wrapping dept) attempting to edit L4 or send Ticket to L3/L4 MUST hit ERR_CROSS_DEPT!
		await assertRejectsAdeCode(
			() => svc.executeCliCommand(cL2, 'ade_agent_edit', { agentId: l4Id, role: 'Hijack' }),
			'ERR_CROSS_DEPT',
		);
		await assertRejectsAdeCode(
			() => svc.executeCliCommand(cL2, 'ade_create', { to: l3Id, type: 'dev', title: 'T', summary: 'S', needReturn: 'false' }),
			'ERR_CROSS_DEPT',
		);

		// L3 (designated root by L1, NOT created_by L3) CANNOT dissolve L1's department boundary!
		await assertRejectsAdeCode(
			() => svc.executeCliCommand(cL3, 'ade_dept_delete', { deptId: dSubId }),
			'ERR_FORBIDDEN_HIERARCHY',
		);

		// Now L2 creates outer wrapping department D_outer rooted at L2 (allowed because L2's parent L1 is_top_role!)
		const dOuterRes = await svc.executeCliCommand(cL2, 'ade_dept_create', { root: l2Id, name: 'OuterDept' });
		const dOuterId = String(dOuterRes.dept_id);

		// D_sub.parent_dept_id must immediately recompute to D_outer!
		const infoL4 = await svc.executeCliCommand(cL1, 'ade_dept_info', { agent: l4Id });
		const deptsL4 = infoL4.departments as Array<{ dept_id: string; parent_dept_id: string | null }>;
		assert.strictEqual(deptsL4.find(d => d.dept_id === dSubId)?.parent_dept_id, dOuterId);

		// Now L2 wraps D_sub via D_outer, so L2 CAN manage L4!
		await svc.executeCliCommand(cL2, 'ade_agent_edit', { agentId: l4Id, role: 'ManagedLegally' });

		// Patch A1 (§4.1.2): Removing L4 from D_outer while L4 is still inside nested D_sub -> ERR_INVALID_ARGS
		await assertRejectsAdeCode(
			() => svc.executeCliCommand(cL2, 'ade_dept_member', { deptId: dOuterId, agent: l4Id, action: 'out' }),
			'ERR_INVALID_ARGS',
		);

		// Patch A2 (§4.1.2): Non-top L2 removing sub-dept root L3 from D_outer would unlink D_sub from L2's jurisdiction -> ERR_FORBIDDEN_HIERARCHY!
		await assertRejectsAdeCode(
			() => svc.executeCliCommand(cL2, 'ade_dept_member', { deptId: dOuterId, agent: l3Id, action: 'out' }),
			'ERR_FORBIDDEN_HIERARCHY',
		);

		// Top role L1 CAN unlink L3 from D_outer (`--action out`); branch-pruning removes BOTH L3 and L4 from D_outer AND sets D_sub.parent_dept_id = null!
		await svc.executeCliCommand(cL1, 'ade_dept_member', { deptId: dOuterId, agent: l3Id, action: 'out' });
		const outerMembers = await svc.executeCliCommand(cL1, 'ade_dept_members', { deptId: dOuterId });
		const memberIds = (outerMembers.members as Array<{ agent_id: string }>).map(m => m.agent_id);
		assert.deepStrictEqual(memberIds, [l2Id]);

		const infoAfterUnlink = await svc.executeCliCommand(cL1, 'ade_dept_info', { agent: l3Id });
		const subAfter = (infoAfterUnlink.departments as Array<{ dept_id: string; parent_dept_id: string | null }>).find(d => d.dept_id === dSubId);
		assert.strictEqual(subAfter?.parent_dept_id, null);

		// Current-state `--action in` check: trying to add L4 into D_outer while parent L3 is still excluded -> ERR_NOT_IN_DEPT_TREE!
		await assertRejectsAdeCode(
			() => svc.executeCliCommand(cL1, 'ade_dept_member', { deptId: dOuterId, agent: l4Id, action: 'in' }),
			'ERR_NOT_IN_DEPT_TREE',
		);
	});

	test('enforces strict whiteboard pre-auth order, ERR_BOARD_NOT_OWNER vs ERR_WB_NOT_OWNER, and 100% lossless upward transfer on ade_dept_delete + ade_agent_delete', async () => {
		const wsDir = path.join(tempDir, 'ws-wb-transfer');
		await fs.promises.mkdir(wsDir, { recursive: true });
		const srcFile = path.join(wsDir, 'architecture.yaml');
		await fs.promises.writeFile(srcFile, 'version: 2\nservice: core\n', 'utf8');

		const proj = await svc.createProject({ folderUri: URI.file(wsDir).toString(), name: 'WbTransferProj' });
		const pid = proj.meta.project_id;

		const l1 = await svc.uiCreateAgent({
			projectId: pid,
			parentId: null,
			level: 1,
			name: 'L1_Root',
			roleSummary: 'Root',
			host: 'local',
			engine: 'claude',
			model: 'claude-sonnet-4-5',
			effort: 'high',
		});
		const cL1 = makeCaller(pid, l1.agent_id);

		const l2a = String((await svc.executeCliCommand(cL1, 'ade_agent_create', {
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-5', effort: 'high', level: 'L2', name: 'L2_Back', role: 'Backend Lead',
		})).agent_id);
		const l2b = String((await svc.executeCliCommand(cL1, 'ade_agent_create', {
			host: 'local', engine: 'codex', model: 'gpt-5', effort: 'medium', level: 'L2', name: 'L2_Outsider', role: 'Frontend Lead',
		})).agent_id);
		const cL2a = makeCaller(pid, l2a);
		const cL2b = makeCaller(pid, l2b);

		// L1 creates dept rooted at L2a; L2a creates department whiteboard + uploads backup file + posts message
		const deptId = String((await svc.executeCliCommand(cL1, 'ade_dept_create', { root: l2a, name: 'BackendDept' })).dept_id);
		const wbRes = await svc.executeCliCommand(cL2a, 'ade_wb_create', {
			name: 'BackendBoard',
			dept: deptId,
			tags: 'spec,bench',
		});
		const boardId = String(wbRes.board_id);
		assert.strictEqual(wbRes.unread_count, 0);

		// One-board-per-department invariant -> ERR_DEPT_BOARD_EXISTS
		await assertRejectsAdeCode(
			() => svc.executeCliCommand(cL2a, 'ade_wb_create', { name: 'SecondBoard', dept: deptId }),
			'ERR_DEPT_BOARD_EXISTS',
		);

		const msgRes = await svc.executeCliCommand(cL2a, 'ade_wb_post_msg', {
			boardId,
			summary: 'Core spec v1',
			stars: '5',
			tags: 'spec',
			detail: 'Detailed design specification body',
		});
		const msgItemId = String(msgRes.item_id);

		const fileRes = await svc.executeCliCommand(cL2a, 'ade_wb_upload_file', {
			boardId,
			file: srcFile,
			summary: 'Architecture YAML backup',
			stars: '4',
			tags: 'bench',
		});
		const fileItemId = String(fileRes.item_id);

		// Strict pre-auth order (§4.4.1): outsider L2b probing non-existent item_id MUST get ERR_WB_FORBIDDEN (never ERR_INVALID_ARGS / ERR_DETAIL_NOT_FOUND!)
		await assertRejectsAdeCode(
			() => svc.executeCliCommand(cL2b, 'ade_wb_get_msg', { boardId, itemId: 'itm_nonexistent_probe' }),
			'ERR_WB_FORBIDDEN',
		);
		await assertRejectsAdeCode(
			() => svc.executeCliCommand(cL2b, 'ade_wb_edit_item', { boardId, itemId: msgItemId, summary: 'Tamper' }),
			'ERR_WB_FORBIDDEN',
		);

		// Exact error code distinction (§5.6): Command #25 `ade_wb_grant` -> ERR_BOARD_NOT_OWNER vs `ade_wb_config` -> ERR_WB_NOT_OWNER!
		await assertRejectsAdeCode(
			() => svc.executeCliCommand(cL1, 'ade_wb_grant', { boardId, to: l2b, perm: 'read' }),
			'ERR_BOARD_NOT_OWNER',
		);
		await assertRejectsAdeCode(
			() => svc.executeCliCommand(cL1, 'ade_wb_config', { boardId, name: 'NotOwnerRename' }),
			'ERR_WB_NOT_OWNER',
		);

		// Critical regression scenario (§4.4.2): L1 dissolves BackendDept (`wb.dept_id` becomes null), then immediately deletes L2a!
		// The former department whiteboard & its backup file MUST NOT be destroyed — ownership transfers losslessly upward to L1!
		await svc.executeCliCommand(cL1, 'ade_dept_delete', { deptId });
		await svc.executeCliCommand(cL1, 'ade_agent_delete', { agentId: l2a });

		const permAfter = await svc.executeCliCommand(cL1, 'ade_wb_my_perm', { boardId });
		assert.strictEqual(permAfter.permission, 'owner');

		const msgReadAfter = await svc.executeCliCommand(cL1, 'ade_wb_get_msg', { boardId, itemId: msgItemId });
		assert.strictEqual(msgReadAfter.detail, 'Detailed design specification body');

		const downloadDest = path.join(tempDir, 'restored-arch.yaml');
		const dlAfter = await svc.executeCliCommand(cL1, 'ade_wb_download', { boardId, itemId: fileItemId, dest: downloadDest });
		assert.strictEqual(dlAfter.saved_path, downloadDest);
		assert.strictEqual(await fs.promises.readFile(downloadDest, 'utf8'), 'version: 2\nservice: core\n');
	});

	test('validates engine effort tiers in uiCreateAgent and uiEditAgent with ERR_INVALID_ARGS and auto-falls back effort on cross-engine switch', async () => {
		const wsDir = path.join(tempDir, 'ws-ui-effort');
		await fs.promises.mkdir(wsDir, { recursive: true });
		const proj = await svc.createProject({ folderUri: URI.file(wsDir).toString(), name: 'EffortValidationProj' });
		const pid = proj.meta.project_id;

		// 1. uiCreateAgent rejects unknown/garbage effort tiers with ERR_INVALID_ARGS before persisting
		await assertRejectsAdeCode(
			() => svc.uiCreateAgent({
				projectId: pid,
				parentId: null,
				level: 1,
				name: 'BadCodexRoot',
				roleSummary: 'Root',
				host: 'local',
				engine: 'codex',
				model: 'gpt-5.3-codex',
				effort: 'extreme',
			}),
			'ERR_INVALID_ARGS',
		);
		await assertRejectsAdeCode(
			() => svc.uiCreateAgent({
				projectId: pid,
				parentId: null,
				level: 1,
				name: 'BadClaudeRoot',
				roleSummary: 'Root',
				host: 'local',
				engine: 'claude',
				model: 'claude-sonnet-4-6',
				effort: 'bogus-tier',
			}),
			'ERR_INVALID_ARGS',
		);
		assert.strictEqual((await svc.getProjectSnapshot(pid))!.agents.length, 0);

		// Real expanded effort tiers ('ultra'/'max' on codex, 'xhigh' on claude, 'none' on kilo) succeed cleanly
		const l1 = await svc.uiCreateAgent({
			projectId: pid,
			parentId: null,
			level: 1,
			name: 'L1_Root',
			roleSummary: 'Root',
			host: 'local',
			engine: 'claude',
			model: 'claude-sonnet-4-6',
			effort: 'xhigh',
		});
		const l2 = await svc.uiCreateAgent({
			projectId: pid,
			parentId: l1.agent_id,
			level: 2,
			name: 'L2_Worker',
			roleSummary: 'Worker',
			host: 'local',
			engine: 'codex',
			model: 'gpt-5.3-codex',
			effort: 'ultra',
		});

		// 2. uiEditAgent rejects explicit garbage effort both on same-engine edit and on cross-engine switch
		await assertRejectsAdeCode(
			() => svc.uiEditAgent({
				projectId: pid,
				agentId: l2.agent_id,
				effort: 'extreme',
			}),
			'ERR_INVALID_ARGS',
		);
		await assertRejectsAdeCode(
			() => svc.uiEditAgent({
				projectId: pid,
				agentId: l2.agent_id,
				engine: 'kilo',
				model: 'deepseek-official/deepseek-flash',
				effort: 'invalid-effort',
			}),
			'ERR_INVALID_ARGS',
		);

		// 3. Switching engine from codex(effort='ultra') to claude without explicit effort auto-normalizes effort to 'medium',
		// and switching claude(effort='medium') to kilo without explicit effort auto-normalizes to 'high' (since kilo lacks 'medium')!
		const switchedToClaude = await svc.uiEditAgent({
			projectId: pid,
			agentId: l2.agent_id,
			engine: 'claude',
			model: 'claude-sonnet-4-6',
		});
		assert.strictEqual(switchedToClaude.engine, 'claude');
		assert.strictEqual(switchedToClaude.effort, 'medium');

		const switchedToKilo = await svc.uiEditAgent({
			projectId: pid,
			agentId: l2.agent_id,
			engine: 'kilo',
			model: 'deepseek-official/deepseek-flash',
		});
		assert.strictEqual(switchedToKilo.engine, 'kilo');
		assert.strictEqual(switchedToKilo.effort, 'high');

		const cL1 = makeCaller(pid, l1.agent_id);
		const cliEditRes = await svc.executeCliCommand(cL1, 'ade_agent_edit', {
			agentId: l2.agent_id,
			role: 'Updated via CLI without effort error',
		});
		assert.strictEqual(cliEditRes.ok, true);
	});
});
