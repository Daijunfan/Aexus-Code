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
		// Default Governor: allowed design & read & inbox, denied engineering.run (engineering.control)
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'engineering.blueprint.apply').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'engineering.templates.list').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'inbox.post').allowed, true);
		const govRun = checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'engineering.run');
		assert.strictEqual(govRun.allowed, false);
		assert.strictEqual(govRun.requiredApi, 'engineering.control');
		assert.match(govRun.reason ?? '', /Governor/);

		// Human (undefined) and Secretary retain full authority; non-string caller is rejected
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, undefined, 'engineering.run').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'secretary', 'engineering.run').allowed, true);
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
		assert.strictEqual(resolveActionPrimitiveApi('host.upsert'), 'host.access');
		assert.strictEqual(resolveActionPrimitiveApi('engineering.worktrees.merge'), 'engineering.integrate');
		assert.strictEqual(resolveActionPrimitiveApi('engineering.worktrees.cleanup'), 'engineering.integrate');
		assert.strictEqual(resolveActionPrimitiveApi('engineering.remove'), 'engineering.destroy');
		assert.strictEqual(resolveActionPrimitiveApi('engineering.reset'), 'engineering.destroy');

		// P1-7: Default governor holds engineering.design only — MUST NOT be authorized for dangerous integrate/destroy actions
		const integrateSpec = ADE_PRIMITIVE_APIS.find(a => a.id === 'engineering.integrate');
		const destroySpec = ADE_PRIMITIVE_APIS.find(a => a.id === 'engineering.destroy');
		assert.strictEqual(integrateSpec?.dangerous, true);
		assert.strictEqual(destroySpec?.dangerous, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'engineering.worktrees.merge').allowed, false);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'engineering.remove').allowed, false);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'governor', 'engineering.reset').allowed, false);
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
				{ id: 'cto', name: 'CTO', tier: 1, allowedApis: ['engineering.design', 'engineering.review'] },
				{ id: 'qa', name: 'QA Lead', tier: 2, allowedApis: ['engineering.review'] },
				{ id: 'dev', name: 'Dev Bot', tier: 3, pureExecution: true },
			],
		});
		assert.strictEqual(resolveWorkTreeSlotRank(customSlotless, 'orchestrator').id, 'cto');
		assert.strictEqual(resolveWorkTreeSlotRank(customSlotless, 'segment_owner').id, 'cto');
		assert.strictEqual(resolveWorkTreeSlotRank(customSlotless, 'reviewer').id, 'qa');
		assert.strictEqual(resolveWorkTreeSlotRank(customSlotless, 'executor').id, 'dev');

		// Slot-aware work-tree prompt compilation under startup-3tier & flat-swarm
		const startupReviewerPrompt = compileAdeRolePrompt({
			config: startup,
			rank: resolveWorkTreeSlotRank(startup, 'reviewer'),
			agentId: 'rev-n1',
			agentLabel: '[N1] Spec',
			engineDisplay: 'Claude Code',
			engineId: 'aexus-claude',
			projectName: 'Demo',
			projectPath: '/tmp/demo',
			workTree: { treeType: 'engineering', governorId: 'lead-1', segmentId: 'S1', nodeId: 'N1', slot: 'reviewer' },
		})!;
		assert.ok(startupReviewerPrompt.includes('Reviewer ≠ Builder'), 'Startup 3-tier reviewer prompt uses resolved slot pair');
		assert.ok(startupReviewerPrompt.includes('--role employee'), 'Review CLI instruction renders cleanly for reviewer slot');
		assert.ok(!/没有职级/.test(startupReviewerPrompt), 'English prompt must not embed Chinese text (P2-6)');

		const flatReviewerPrompt = compileAdeRolePrompt({
			config: flat,
			rank: resolveWorkTreeSlotRank(flat, 'reviewer'),
			agentId: 'coord-n1',
			agentLabel: '[N1] Swarm Task',
			engineDisplay: 'Claude Code',
			engineId: 'aexus-claude',
			projectName: 'Demo',
			projectPath: '/tmp/demo',
			workTree: { treeType: 'engineering', governorId: 'coord-1', segmentId: 'S1', nodeId: 'N1', slot: 'reviewer' },
		})!;
		assert.ok(flatReviewerPrompt.includes('Coordinator ≠ Agent'));
		assert.ok(!/没有职级/.test(flatReviewerPrompt));

		// Default 4-tier still keeps exact Employee ≠ Worker wording
		const defaultEmpPrompt = compileAdeRolePrompt({
			config: DEFAULT_ADE_ORGANIZATION_CONFIG,
			rank: resolveWorkTreeSlotRank(DEFAULT_ADE_ORGANIZATION_CONFIG, 'reviewer'),
			agentId: 'emp-n1',
			agentLabel: '[N1] Core',
			engineDisplay: 'Claude Code',
			engineId: 'aexus-claude',
			projectName: 'Demo',
			projectPath: '/tmp/demo',
			workTree: { treeType: 'engineering', governorId: 'gov-1', segmentId: 'S1', nodeId: 'N1', slot: 'reviewer' },
		})!;
		assert.ok(defaultEmpPrompt.includes('Employee ≠ Worker'));
		assert.ok(!/没有职级/.test(defaultEmpPrompt));
	});
});
