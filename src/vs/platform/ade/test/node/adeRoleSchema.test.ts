/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	ADE_ORGANIZATION_PRESETS,
	ADE_PRIMITIVE_APIS,
	canRankSupervise,
	checkAdeApiPermission,
	compileAdeRolePrompt,
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	formatOrganizationLadder,
	getNextLowerRankFromConfig,
	getRankLevelFromConfig,
	IAdeOrganizationConfig,
	normalizeAdeOrganizationConfig,
	previewCompiledRankPrompt,
	resolveActionPrimitiveApi,
	resolveRankWorkTreeSlots,
	resolveWorkTreeSlotRank,
	resolveWorkTreeSlotRankId,
} from '../../common/adeRoleSchema.js';

suite('ADE Extensible Organization Schema & Core Primitive APIs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes malformed configs safely, reserves privileged IDs, and returns isolated clones', () => {
		const fallback1 = normalizeAdeOrganizationConfig(null);
		const fallback2 = normalizeAdeOrganizationConfig({ ranks: [] });
		assert.notStrictEqual(fallback1, DEFAULT_ADE_ORGANIZATION_CONFIG);
		assert.notStrictEqual(fallback1, fallback2);
		assert.strictEqual(fallback1.ranks.length, 4);

		const normalized = normalizeAdeOrganizationConfig({
			version: 1,
			ranks: [
				{
					id: 'user',
					name: 'Spoof User',
					tier: 2,
					canHaveSubordinates: false,
					defaultChildRankId: 'coder',
					allowedApis: ['session.read_context', 'not.a.real.api'],
				},
				{
					id: 'human',
					name: 'Spoof Human',
					tier: 1,
					allowedApis: ['session.message'],
				},
				{
					id: 'coder',
					name: 'Coder',
					tier: 3,
					pureExecution: true,
					canHaveSubordinates: true,
					initPrompt: 'Should be cleared',
					allowedApis: ['session.manage'],
				},
			],
		});

		assert.ok(!normalized.ranks.some(r => r.id === 'user' || r.id === 'human'), 'Reserved IDs must never bypass kernel auth');
		assert.deepStrictEqual(normalized.ranks.map(r => r.tier), [1, 2, 3]);
		const tier2 = normalized.ranks.find(r => r.tier === 2)!;
		assert.deepStrictEqual(tier2.allowedApis, ['session.read_context']);
		assert.strictEqual(tier2.defaultChildRankId, undefined);
		const pure = normalized.ranks.find(r => r.id === 'coder')!;
		assert.strictEqual(pure.pureExecution, true);
		assert.strictEqual(pure.canHaveSubordinates, false);
		assert.strictEqual(pure.initPrompt, '');
		assert.deepStrictEqual(pure.allowedApis, []);
	});

	test('enforces fixed core primitive API permissions at the kernel boundary for built-in and custom ranks', () => {
		// Default Governor: allowed mission.design & mission.read & inbox, denied mission.run (mission.control)
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'mission.blueprint.apply').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'mission.list').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'mission.task.set').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'inbox.post').allowed, true);
		const govRun = checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'mission.run');
		assert.strictEqual(govRun.allowed, false);
		assert.strictEqual(govRun.requiredApi, 'mission.control');
		assert.match(govRun.reason ?? '', /Governor/);

		// Human (undefined) and Secretary retain full authority; non-string caller is rejected
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, undefined, 'mission.run').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'secretary', 'mission.run').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 42, 'session.list').allowed, false);

		// Pure Worker denied all control APIs
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'worker', 'session.list').allowed, false);

		// Custom least-privilege rank: QA Auditor with ONLY session.read_context + project.read + inbox.post
		const customOrg: IAdeOrganizationConfig = normalizeAdeOrganizationConfig({
			version: 1,
			ranks: [
				{ id: 'cto', name: 'CTO', shortName: 'CTO', tier: 1, color: 'amber', icon: 'rocket', summary: 'L1 CTO', initPrompt: 'Lead {{project.name}}', canHaveSubordinates: true, allowedApis: ['session.read_context', 'session.message', 'session.manage', 'project.read', 'inbox.post'] },
				{ id: 'qa-auditor', name: 'QA Auditor', shortName: 'QA', tier: 2, color: 'cyan', icon: 'eye', summary: 'L2 QA', initPrompt: 'Audit diffs only.', canHaveSubordinates: false, allowedApis: ['session.read_context', 'project.read', 'inbox.post'] },
				{ id: 'coder', name: 'Coder', shortName: 'Cod', tier: 3, color: 'emerald', icon: 'tools', summary: 'L3 Coder', initPrompt: '', pureExecution: true, canHaveSubordinates: false, allowedApis: [] },
			],
		});

		assert.strictEqual(checkAdeApiPermission(customOrg, 'qa-auditor', 'session.info').allowed, true);
		assert.strictEqual(checkAdeApiPermission(customOrg, 'qa-auditor', 'project.changes').allowed, true);
		assert.strictEqual(checkAdeApiPermission(customOrg, 'qa-auditor', 'inbox.post').allowed, true);
		assert.strictEqual(checkAdeApiPermission(customOrg, 'qa-auditor', 'session.send').allowed, false);
		assert.strictEqual(checkAdeApiPermission(customOrg, 'qa-auditor', 'session.create').allowed, false);
		assert.strictEqual(checkAdeApiPermission(customOrg, 'qa-auditor', 'session.setRole').allowed, false);
		assert.strictEqual(checkAdeApiPermission(customOrg, 'qa-auditor', 'project.delete').allowed, false);
		assert.strictEqual(checkAdeApiPermission(customOrg, 'cto', 'session.reparent').allowed, true);
		assert.strictEqual(checkAdeApiPermission(customOrg, 'cto', 'session.detach').allowed, true);
		// Read-only host.access vs High Privilege host.manage split
		assert.strictEqual(resolveActionPrimitiveApi('host.list'), 'host.access');
		assert.strictEqual(resolveActionPrimitiveApi('host.get'), 'host.access');
		assert.strictEqual(resolveActionPrimitiveApi('host.browse'), 'host.access');
		assert.strictEqual(resolveActionPrimitiveApi('host.open'), 'host.access');
		assert.strictEqual(resolveActionPrimitiveApi('host.upsert'), 'host.manage');
		assert.strictEqual(resolveActionPrimitiveApi('host.delete'), 'host.manage');
		assert.strictEqual(resolveActionPrimitiveApi('host.test'), 'host.manage');
		assert.strictEqual(resolveActionPrimitiveApi('host.import'), 'host.manage');
		const hostAccessSpec = ADE_PRIMITIVE_APIS.find(a => a.id === 'host.access');
		const hostManageSpec = ADE_PRIMITIVE_APIS.find(a => a.id === 'host.manage');
		assert.strictEqual(Boolean(hostAccessSpec?.dangerous), false);
		assert.strictEqual(hostManageSpec?.dangerous, true);
		const readOnlyHostOrg = normalizeAdeOrganizationConfig({
			version: 1,
			ranks: [{ id: 'observer', name: 'Observer', tier: 1, allowedApis: ['host.access'] }],
		});
		assert.strictEqual(checkAdeApiPermission(readOnlyHostOrg, 'observer', 'host.list').allowed, true);
		assert.strictEqual(checkAdeApiPermission(readOnlyHostOrg, 'observer', 'host.browse').allowed, true);
		assert.strictEqual(checkAdeApiPermission(readOnlyHostOrg, 'observer', 'host.upsert').allowed, false);
		assert.strictEqual(checkAdeApiPermission(readOnlyHostOrg, 'observer', 'host.delete').allowed, false);
		assert.strictEqual(checkAdeApiPermission(readOnlyHostOrg, 'observer', 'host.test').allowed, false);
		assert.strictEqual(checkAdeApiPermission(readOnlyHostOrg, 'observer', 'host.import').allowed, false);
		assert.strictEqual(resolveActionPrimitiveApi('mission.remove'), 'mission.destroy');
		assert.strictEqual(resolveActionPrimitiveApi('mission.delete'), 'mission.destroy');
		assert.strictEqual(resolveActionPrimitiveApi('mission.start'), 'mission.control');
		assert.strictEqual(resolveActionPrimitiveApi('mission.stop'), 'mission.control');
		assert.strictEqual(resolveActionPrimitiveApi('mission.patch'), 'mission.design');
		// Dead legacy engineering.* actions no longer resolve to any primitive API
		assert.strictEqual(resolveActionPrimitiveApi('engineering.worktrees.merge'), undefined);
		assert.strictEqual(resolveActionPrimitiveApi('engineering.review'), undefined);

		// Legacy saved user configs with engineering.* APIs auto-migrate cleanly to mission.* and drop dead APIs
		const migratedLegacy = normalizeAdeOrganizationConfig({
			version: 1,
			ranks: [{
				id: 'lead',
				name: 'Lead',
				tier: 1,
				allowedApis: ['engineering.read', 'engineering.design', 'engineering.review', 'engineering.integrate', 'engineering.destroy', 'engineering.control'],
			}],
		});
		assert.deepStrictEqual(migratedLegacy.ranks[0].allowedApis, ['mission.read', 'mission.design', 'mission.destroy', 'mission.control']);

		// Governor mission.design compiled prompt includes ONLY live mission/role CLI docs and zero dead engineering commands
		const govPrompt = compileAdeRolePrompt({
			config: DEFAULT_ADE_ORGANIZATION_CONFIG,
			rank: DEFAULT_ADE_ORGANIZATION_CONFIG.ranks[0],
			agentId: 'gov-doc',
			agentLabel: 'Doc Gov',
			engineDisplay: 'Claude Code',
			engineId: 'aexus-claude',
			projectName: 'Demo',
			projectPath: '/tmp/demo',
			workTree: { treeType: 'mission', governorId: 'gov-doc', slot: 'orchestrator' },
		})!;
		assert.ok(govPrompt.includes('aexus-ade mission blueprint apply'));
		assert.ok(govPrompt.includes('aexus-ade mission task create|update|complete'));
		assert.ok(govPrompt.includes('aexus-ade orchestration staff create|config|remove'));
		assert.ok(govPrompt.includes('aexus-ade role list'));
		assert.ok(!govPrompt.includes('aexus-ade mission prompt set'), 'Obsolete mission prompt set must not appear in compiled prompts');
		assert.ok(!govPrompt.includes('engineering template'));
		assert.ok(!govPrompt.includes('engineering generate'));
		assert.ok(!govPrompt.includes('worktrees merge'));
		assert.ok(!govPrompt.includes('engineering review'));

		// Default governor holds mission.design only — MUST NOT be authorized for dangerous mission.control / mission.destroy actions
		const controlSpec = ADE_PRIMITIVE_APIS.find(a => a.id === 'mission.control');
		const destroySpec = ADE_PRIMITIVE_APIS.find(a => a.id === 'mission.destroy');
		assert.strictEqual(controlSpec?.dangerous, true);
		assert.strictEqual(destroySpec?.dangerous, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'mission.start').allowed, false);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'mission.remove').allowed, false);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'mission.delete').allowed, false);
	});

	test('computes custom hierarchy levels, next-lower ranks, template interpolation, and scoped CLI compilation', () => {
		const startup = ADE_ORGANIZATION_PRESETS.find(p => p.id === 'startup-3tier')!.config;
		assert.strictEqual(getRankLevelFromConfig(startup, 'tech-lead'), 2);
		assert.strictEqual(getRankLevelFromConfig(startup, 'reviewer'), 1);
		assert.strictEqual(getRankLevelFromConfig(startup, 'builder'), 0);

		const underLead = getNextLowerRankFromConfig(startup, 'tech-lead');
		assert.strictEqual(underLead.canSpawnSubSession, true);
		assert.strictEqual(underLead.childRole, 'reviewer');

		const underReviewer = getNextLowerRankFromConfig(startup, 'reviewer');
		assert.strictEqual(underReviewer.canSpawnSubSession, true);
		assert.strictEqual(underReviewer.childRole, undefined); // default pure leaf stays clean
		assert.strictEqual(underReviewer.childRank, 'builder');

		assert.strictEqual(canRankSupervise(startup, 'tech-lead', false, 'reviewer', false), true);
		assert.strictEqual(canRankSupervise(startup, 'reviewer', false, 'tech-lead', false), false);
		assert.strictEqual(canRankSupervise(startup, 'builder', false, 'reviewer', false), false);
		assert.ok(formatOrganizationLadder(startup).includes('Tech Lead'));

		const reviewerDef = startup.ranks.find(r => r.id === 'reviewer')!;
		const compiled = compileAdeRolePrompt({
			config: startup,
			rank: {
				...reviewerDef,
				initPrompt: 'Hello {{rank.tier}} {{rank.name}} on {{project.name}} reporting to {{supervisor.label}} ({{supervisor.rank}}).',
				allowedApis: ['session.read_context', 'project.read'],
			},
			agentId: 'rev-1',
			agentLabel: 'PR Reviewer',
			engineDisplay: 'Claude Code',
			engineId: 'aexus-claude',
			projectName: 'AcmeApp',
			projectPath: '/workspace/AcmeApp',
			supervisor: { id: 'lead-1', label: 'Alice Lead', rankName: 'Tech Lead' },
		})!;

		assert.ok(compiled.includes('Hello L2 Reviewer on AcmeApp reporting to Alice Lead (Tech Lead).'));
		assert.ok(compiled.includes('aexus-ade session subordinates rev-1 --json'));
		assert.ok(compiled.includes('aexus-ade project list --json'));
		assert.ok(!compiled.includes('aexus-ade session send'), 'Ungranted session.message API must NOT appear in compiled prompt');
		assert.ok(!compiled.includes('aexus-ade session create'), 'Ungranted session.manage API must NOT appear in compiled prompt');

		const builderDef = startup.ranks.find(r => r.id === 'builder')!;
		const purePreview = previewCompiledRankPrompt(startup, builderDef);
		assert.strictEqual(purePreview.estimatedTokens, 0);
		assert.ok(ADE_PRIMITIVE_APIS.length >= 12);
	});

	test('resolves structural Work-Tree slots across all 5 presets and custom orgs, and compiles slot-aware English prompts (P0-3, P2-6)', () => {
		const startup = ADE_ORGANIZATION_PRESETS.find(p => p.id === 'startup-3tier')!.config;
		const flat = ADE_ORGANIZATION_PRESETS.find(p => p.id === 'flat-swarm')!.config;
		const research = ADE_ORGANIZATION_PRESETS.find(p => p.id === 'research-lab')!.config;
		const sec = ADE_ORGANIZATION_PRESETS.find(p => p.id === 'security-audit')!.config;

		assert.deepStrictEqual({
			default4: ['orchestrator', 'segment_owner', 'reviewer', 'executor'].map(s => resolveWorkTreeSlotRankId(DEFAULT_ADE_ORGANIZATION_CONFIG, s as 'orchestrator')),
			startup3: ['orchestrator', 'segment_owner', 'reviewer', 'executor'].map(s => resolveWorkTreeSlotRankId(startup, s as 'orchestrator')),
			flat2: ['orchestrator', 'segment_owner', 'reviewer', 'executor'].map(s => resolveWorkTreeSlotRankId(flat, s as 'orchestrator')),
			research4: ['orchestrator', 'segment_owner', 'reviewer', 'executor'].map(s => resolveWorkTreeSlotRankId(research, s as 'orchestrator')),
			sec4: ['orchestrator', 'segment_owner', 'reviewer', 'executor'].map(s => resolveWorkTreeSlotRankId(sec, s as 'orchestrator')),
		}, {
			default4: ['governor', 'manager', 'employee', 'worker'],
			startup3: ['tech-lead', 'tech-lead', 'reviewer', 'builder'],
			flat2: ['coordinator', 'coordinator', 'coordinator', 'agent'],
			research4: ['governor', 'manager', 'employee', 'worker'],
			sec4: ['governor', 'manager', 'employee', 'worker'],
		});

		assert.deepStrictEqual(resolveRankWorkTreeSlots(startup, 'tech-lead'), ['orchestrator', 'segment_owner']);
		assert.deepStrictEqual(resolveRankWorkTreeSlots(flat, 'coordinator'), ['orchestrator', 'segment_owner', 'reviewer']);

		// Custom slotless 3-tier org resolves structural slots cleanly via tier heuristic
		const customSlotless = normalizeAdeOrganizationConfig({
			version: 1,
			ranks: [
				{ id: 'cto', name: 'CTO', tier: 1, allowedApis: ['mission.design', 'mission.read'] },
				{ id: 'qa', name: 'QA Lead', tier: 2, allowedApis: ['mission.read'] },
				{ id: 'dev', name: 'Dev Bot', tier: 3, pureExecution: true },
			],
		});
		assert.strictEqual(resolveWorkTreeSlotRank(customSlotless, 'orchestrator').id, 'cto');
		assert.strictEqual(resolveWorkTreeSlotRank(customSlotless, 'segment_owner').id, 'cto');
		assert.strictEqual(resolveWorkTreeSlotRank(customSlotless, 'reviewer').id, 'qa');
		assert.strictEqual(resolveWorkTreeSlotRank(customSlotless, 'executor').id, 'dev');

		// Slot-aware v2 Mission prompt compilation: numeric-tier lazy-read entry commands, top-down org.*, zero v1 dogma
		const startupReviewerPrompt = compileAdeRolePrompt({
			config: startup,
			rank: resolveWorkTreeSlotRank(startup, 'reviewer'),
			agentId: 'rev-n1',
			agentLabel: '[N1] Spec',
			engineDisplay: 'Claude Code',
			engineId: 'aexus-claude',
			projectName: 'Demo',
			projectPath: '/tmp/demo',
			workTree: { treeType: 'mission', governorId: 'lead-1', nodeId: 'N1', slot: 'reviewer' },
		})!;
		assert.ok(startupReviewerPrompt.includes('aexus-ade whoami --json'), 'Includes immutable whoami entrypoint');
		assert.ok(startupReviewerPrompt.includes('aexus-ade docs read L2'), 'Includes numeric-tier lazy-read docs entrypoint');
		assert.ok(startupReviewerPrompt.includes('aexus-ade api update --since 0 --json'), 'Includes immutable api update entrypoint');
		assert.ok(startupReviewerPrompt.includes('aexus-ade token complete'), 'Mission Token Bus instruction renders cleanly for reviewer slot');
		assert.ok(!startupReviewerPrompt.includes('Employee ≠ Worker'), 'Must not inject legacy v1 Employee ≠ Worker dogma');
		assert.ok(!startupReviewerPrompt.includes('NEVER claim'), 'Must not inject legacy v1 identity boilerplate');
		assert.ok(!/没有职级/.test(startupReviewerPrompt), 'English prompt must not embed Chinese text (P2-6)');

		const offGraphSupPrompt = compileAdeRolePrompt({
			config: DEFAULT_ADE_ORGANIZATION_CONFIG,
			rank: DEFAULT_ADE_ORGANIZATION_CONFIG.ranks[1],
			agentId: 'mgr-sup',
			agentLabel: 'Off-Graph Mgr',
			engineDisplay: 'Claude Code',
			engineId: 'aexus-claude',
			projectName: 'Demo',
			projectPath: '/tmp/demo',
			workTree: { treeType: 'mission', governorId: 'mission-1', isMissionOwner: false, managedNodeIds: ['N1', 'N2'] },
		})!;
		assert.ok(offGraphSupPrompt.includes('Off-Graph Supervisor (L2) Operations'));
		assert.ok(offGraphSupPrompt.includes('aexus-ade mission blueprint get --mission mission-1 --raw'));
		assert.ok(offGraphSupPrompt.includes('managed nodes: N1, N2'));
		assert.ok(!offGraphSupPrompt.includes('module/segment delivery'), 'Must not inject legacy v1 segment dogma');
		assert.ok(!offGraphSupPrompt.includes('report concise outcomes upward'), 'Must not contradict strictly top-down communication law');
		assert.ok(!/没有职级/.test(offGraphSupPrompt));

		// Default 4-tier L3 Employee prompt is clean of legacy v1 Employee ≠ Worker dogma
		const defaultEmpPrompt = compileAdeRolePrompt({
			config: DEFAULT_ADE_ORGANIZATION_CONFIG,
			rank: resolveWorkTreeSlotRank(DEFAULT_ADE_ORGANIZATION_CONFIG, 'reviewer'),
			agentId: 'emp-n1',
			agentLabel: '[N1] Core',
			engineDisplay: 'Claude Code',
			engineId: 'aexus-claude',
			projectName: 'Demo',
			projectPath: '/tmp/demo',
			workTree: { treeType: 'mission', governorId: 'gov-1', nodeId: 'N1', slot: 'reviewer' },
		})!;
		assert.ok(defaultEmpPrompt.includes('In-Graph Mission Reviewer (L3)'));
		assert.ok(defaultEmpPrompt.includes('aexus-ade token reject'));
		assert.ok(!defaultEmpPrompt.includes('Employee ≠ Worker'));
		assert.ok(!/没有职级/.test(defaultEmpPrompt));
	});
});
