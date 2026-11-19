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
		assert.strictEqual(resolveActionPrimitiveApi('engineering.worktrees.merge'), 'engineering.design');
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
		assert.ok(ADE_PRIMITIVE_APIS.length >= 10);
	});
});
