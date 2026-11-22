/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	ADE_DOCS_MISSION_FILE_NAME,
	buildAdeDocsBundle,
	buildAdeDocsPaths,
} from '../../common/adeDocsCatalog.js';
import {
	ADE_MIN_RANK_COUNT,
	ADE_SECRETARY_ALIAS,
	ADE_SECRETARY_TIER_TAG,
	ADE_USER_ALIAS,
	ADE_USER_TIER_TAG,
	buildLiveRankDirectory,
	findRankByTierOrId,
	formatTierTag,
	parseTierNumber,
	renameOrganizationRankAlias,
	resizeOrganizationRanks,
} from '../../common/adeRankResize.js';
import {
	checkAdeApiPermission,
	compileAdeRolePrompt,
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	resolveActionPrimitiveApi,
} from '../../common/adeRoleSchema.js';
import { syncAdeApiDocsToDisk } from '../../node/adeDocsSync.js';

suite('ADE Rank Resize, Hot Aliases, Mission RBAC & Single-Copy API Docs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('supports rank count >= 1, preserves existing aliases on resize, and hot-renames aliases keeping tier & ID stable', () => {
		// Default preset keeps the user's original 4-tier naming
		assert.deepStrictEqual(
			DEFAULT_ADE_ORGANIZATION_CONFIG.ranks.map(r => [formatTierTag(r.tier), r.id, r.name]),
			[
				['L1', 'governor', 'Governor'],
				['L2', 'manager', 'Manager'],
				['L3', 'employee', 'Employee'],
				['L4', 'worker', 'Worker'],
			],
		);

		// Hot-rename L2 & L3 aliases
		const renamed = renameOrganizationRankAlias(
			renameOrganizationRankAlias(DEFAULT_ADE_ORGANIZATION_CONFIG, 'L2', 'Director', 'Dir'),
			'L3',
			'Reviewer',
			'Rev',
		);
		assert.strictEqual(findRankByTierOrId(renamed, 'L2')?.name, 'Director');
		assert.strictEqual(findRankByTierOrId(renamed, 'L2')?.id, 'manager');
		assert.strictEqual(findRankByTierOrId(renamed, 'Director')?.tier, 2);
		assert.strictEqual(findRankByTierOrId(renamed, 'L3')?.name, 'Reviewer');

		// Live rank directory includes L-1 User + L0 Secretary + L1..LN
		const dir = buildLiveRankDirectory(renamed, buildAdeDocsPaths('/ade', renamed.ranks.length));
		assert.strictEqual(dir.rankCount, 4);
		assert.deepStrictEqual(dir.namesByTier, {
			'L-1': ADE_USER_ALIAS,
			L0: ADE_SECRETARY_ALIAS,
			L1: 'Governor',
			L2: 'Director',
			L3: 'Reviewer',
			L4: 'Worker',
		});
		assert.strictEqual(dir.tierByAlias.user, 'L-1');
		assert.strictEqual(dir.tierByAlias.director, 'L2');
		assert.strictEqual(dir.ranks[0].tierTag, ADE_USER_TIER_TAG);
		assert.strictEqual(dir.ranks[0].isSystemUser, true);
		assert.strictEqual(dir.ranks[1].tierTag, ADE_SECRETARY_TIER_TAG);
		assert.strictEqual(dir.ranks[1].isSystemL0, true);
		assert.strictEqual(dir.ranks[1].docPath, '/ade/docs/ranks/L0.md');
		assert.strictEqual(dir.ranks[3].docPath, '/ade/docs/ranks/L2.md');

		// Resize down to minimum 1 tier (clamping 0 -> 1)
		const single = resizeOrganizationRanks(renamed, 0);
		assert.strictEqual(single.ranks.length, ADE_MIN_RANK_COUNT);
		assert.strictEqual(single.ranks[0].tier, 1);
		assert.strictEqual(single.ranks[0].name, 'Governor');
		assert.strictEqual(single.ranks[0].pureExecution, false);

		// Resize up to 6 tiers while preserving existing L1..L4 aliases
		const sixTiers = resizeOrganizationRanks(renamed, 6);
		assert.strictEqual(sixTiers.ranks.length, 6);
		assert.strictEqual(sixTiers.ranks[0].name, 'Governor');
		assert.strictEqual(sixTiers.ranks[1].name, 'Director');
		assert.strictEqual(sixTiers.ranks[2].name, 'Reviewer');
		assert.strictEqual(sixTiers.ranks[5].tier, 6);
		assert.strictEqual(sixTiers.ranks[5].pureExecution, true);

		assert.strictEqual(parseTierNumber('L-1'), -1);
		assert.strictEqual(parseTierNumber(-1), -1);
		assert.strictEqual(formatTierTag(-1), 'L-1');
		assert.strictEqual(parseTierNumber('L0'), 0);
		assert.strictEqual(parseTierNumber('l3'), 3);
		assert.strictEqual(parseTierNumber(2), 2);
		assert.strictEqual(parseTierNumber('invalid'), undefined);
	});

	test('writes single-copy tier docs under docs/ranks/L0..LN.md alongside sibling docs/mission/MISSION_API.md, alias-agnostic, and prunes stale files', async () => {
		const tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aexus-ade-docs-test-'));
		try {
			const paths4 = await syncAdeApiDocsToDisk(tmpHome, DEFAULT_ADE_ORGANIZATION_CONFIG);
			assert.strictEqual(paths4.docsRoot, path.join(tmpHome, 'docs'));
			assert.strictEqual(paths4.ranksDir, path.join(tmpHome, 'docs', 'ranks'));
			assert.strictEqual(paths4.missionDir, path.join(tmpHome, 'docs', 'mission'));
			assert.strictEqual(paths4.missionDoc, path.join(tmpHome, 'docs', 'mission', ADE_DOCS_MISSION_FILE_NAME));
			assert.strictEqual(path.dirname(paths4.ranksDir), path.dirname(paths4.missionDir), 'mission/ must be sibling to ranks/');

			const rankEntries4 = (await fs.promises.readdir(paths4.ranksDir)).sort();
			assert.deepStrictEqual(rankEntries4, ['L0.md', 'L1.md', 'L2.md', 'L3.md', 'L4.md']);
			assert.ok(fs.existsSync(paths4.missionDoc), 'MISSION_API.md must exist');

			// Renaming custom aliases must NOT alter tier-indexed rank docs (roles only read by L<tier>)
			const l2Before = await fs.promises.readFile(path.join(paths4.ranksDir, 'L2.md'), 'utf8');
			assert.ok(l2Before.includes('Tier L2'), 'L2 doc must be indexed by Tier L2');
			assert.ok(l2Before.includes('aexus-ade rank names --json'), 'L2 doc must instruct querying live names via API');
			assert.ok(l2Before.includes('../mission/MISSION_API.md'), 'L2 doc must link sibling Mission doc on demand');
			assert.ok(!l2Before.includes('Manager'), 'L2 doc must stay decoupled from mutable display alias Manager');

			const renamed = renameOrganizationRankAlias(DEFAULT_ADE_ORGANIZATION_CONFIG, 'L2', 'SquadLead', 'Lead');
			await syncAdeApiDocsToDisk(tmpHome, renamed);
			const l2After = await fs.promises.readFile(path.join(paths4.ranksDir, 'L2.md'), 'utf8');
			assert.strictEqual(l2After, l2Before, 'Renaming display alias must leave single-copy L2.md unchanged');

			// Shrinking rank count from 4 to 2 must prune stale L3.md & L4.md
			const twoTier = resizeOrganizationRanks(renamed, 2);
			await syncAdeApiDocsToDisk(tmpHome, twoTier);
			const rankEntries2 = (await fs.promises.readdir(paths4.ranksDir)).sort();
			assert.deepStrictEqual(rankEntries2, ['L0.md', 'L1.md', 'L2.md']);

			const missionContent = await fs.promises.readFile(paths4.missionDoc, 'utf8');
			assert.ok(missionContent.includes('aexus-ade mission docs --json'));
			assert.ok(missionContent.includes('L1` highest → `L2` lowest'));

			// Bundle parity check
			const bundle = buildAdeDocsBundle(twoTier);
			assert.deepStrictEqual(Object.keys(bundle.rankFiles).sort(), ['L0.md', 'L1.md', 'L2.md']);
		} finally {
			await fs.promises.rm(tmpHome, { recursive: true, force: true });
		}
	});

	test('authorizes rank.* query APIs and unified mission.* actions via kernel RBAC and injects single-copy doc pointers in compiled prompts', () => {
		// Read APIs granted to orchestrated ranks holding session.read_context
		assert.strictEqual(resolveActionPrimitiveApi('rank.names'), 'session.read_context');
		assert.strictEqual(resolveActionPrimitiveApi('rank.list'), 'session.read_context');
		assert.strictEqual(resolveActionPrimitiveApi('rank.docs'), 'session.read_context');
		assert.strictEqual(resolveActionPrimitiveApi('mission.docs'), 'session.read_context');
		assert.strictEqual(resolveActionPrimitiveApi('mission.status'), 'mission.read');
		assert.strictEqual(resolveActionPrimitiveApi('mission.blueprint.apply'), 'mission.design');
		assert.strictEqual(resolveActionPrimitiveApi('mission.run'), 'mission.control');
		assert.strictEqual(resolveActionPrimitiveApi('rank.rename'), undefined);
		assert.strictEqual(resolveActionPrimitiveApi('rank.setCount'), undefined);

		// Manager (L2) can query live rank names & mission docs, but cannot rename ranks or run Missions
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'manager', 'rank.names').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'manager', 'mission.docs').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'manager', 'mission.status').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'manager', 'rank.rename').allowed, false);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'manager', 'mission.run').allowed, false);

		// Secretary (L0) & human can invoke rank.rename, rank.setCount, and mission.run
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'secretary', 'rank.rename').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'secretary', 'rank.setCount').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, undefined, 'mission.run').allowed, true);

		// Pure Worker (L4) has zero API access
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'worker', 'rank.names').allowed, false);

		// Compiled prompt references single-copy tier doc + sibling Mission doc on demand
		const prompt = compileAdeRolePrompt({
			config: DEFAULT_ADE_ORGANIZATION_CONFIG,
			rank: DEFAULT_ADE_ORGANIZATION_CONFIG.ranks[1],
			agentId: 'mgr-1',
			agentLabel: 'Backend Lead',
			engineDisplay: 'Claude Code',
			engineId: 'aexus-claude',
			projectName: 'Demo',
			projectPath: '/tmp/demo',
			docsPaths: {
				rankDoc: '/home/.aexus-code/docs/ranks/L2.md',
				missionDoc: '/home/.aexus-code/docs/mission/MISSION_API.md',
			},
			workTree: {
				treeType: 'mission',
				governorId: 'gov-1',
				segmentId: 'seg-1',
				slot: 'segment_owner',
			},
		});
		assert.ok(prompt && prompt.includes('Tier: L2'));
		assert.ok(prompt.includes('/home/.aexus-code/docs/ranks/L2.md'));
		assert.ok(prompt.includes('/home/.aexus-code/docs/mission/MISSION_API.md'));
		assert.ok(prompt.includes('ADE Mission'));
		assert.ok(prompt.includes('aexus-ade rank names --json'));
	});
});
