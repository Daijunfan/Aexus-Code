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
	queryApiUpdateDiff,
} from '../../common/adeApiRegistry.js';
import {
	ADE_DOCS_ENGINEERING_API_FILE_NAME,
	ADE_DOCS_ENGINEERING_PARADIGM_FILE_NAME,
	ADE_DOCS_MISSION_FILE_NAME,
	buildAdeDocsBundle,
	buildAdeDocsPaths,
	normalizeAdeDocTargetKey,
} from '../../common/adeDocsCatalog.js';
import {
	AEXUS_SYSTEM_ROLE_DM_ENVELOPE_HEADER,
	AEXUS_SYSTEM_TOKEN_ENVELOPE_HEADER,
	AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER,
	buildTokenSystemEnvelopeLines,
	hasAexusSystemMessageEnvelope,
	wrapRoleDirectMessageEnvelope,
	wrapUserDirectMessageEnvelope,
} from '../../common/adeMessageEnvelope.js';
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
	getMissionDisplayName,
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

	test('writes single-copy tier docs under docs/ranks/L0..LN.md alongside sibling docs/engineering/ and docs/mission/MISSION_API.md, alias-agnostic, and prunes stale files', async () => {
		const tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aexus-ade-docs-test-'));
		try {
			const paths4 = await syncAdeApiDocsToDisk(tmpHome, DEFAULT_ADE_ORGANIZATION_CONFIG);
			assert.strictEqual(paths4.docsRoot, path.join(tmpHome, 'docs'));
			assert.strictEqual(paths4.ranksDir, path.join(tmpHome, 'docs', 'ranks'));
			assert.strictEqual(paths4.engineeringDir, path.join(tmpHome, 'docs', 'engineering'));
			assert.strictEqual(paths4.engineeringParadigmDoc, path.join(tmpHome, 'docs', 'engineering', ADE_DOCS_ENGINEERING_PARADIGM_FILE_NAME));
			assert.strictEqual(paths4.engineeringApiDoc, path.join(tmpHome, 'docs', 'engineering', ADE_DOCS_ENGINEERING_API_FILE_NAME));
			assert.strictEqual(paths4.missionDir, path.join(tmpHome, 'docs', 'mission'));
			assert.strictEqual(paths4.missionDoc, path.join(tmpHome, 'docs', 'mission', ADE_DOCS_MISSION_FILE_NAME));
			assert.strictEqual(path.dirname(paths4.ranksDir), path.dirname(paths4.engineeringDir!), 'engineering/ must be sibling to ranks/');
			assert.strictEqual(path.dirname(paths4.ranksDir), path.dirname(paths4.missionDir), 'mission/ must be sibling to ranks/');

			const rankEntries4 = (await fs.promises.readdir(paths4.ranksDir)).sort();
			assert.deepStrictEqual(rankEntries4, ['L0.md', 'L1.md', 'L2.md', 'L3.md', 'L4.md']);
			const engEntries = (await fs.promises.readdir(paths4.engineeringDir!)).sort();
			assert.deepStrictEqual(engEntries, [ADE_DOCS_ENGINEERING_API_FILE_NAME, ADE_DOCS_ENGINEERING_PARADIGM_FILE_NAME]);
			assert.ok(fs.existsSync(paths4.missionDoc), 'MISSION_API.md must exist');

			// Renaming custom aliases must NOT alter tier-indexed rank docs (roles only read by L<tier>),
			// and rank docs stay cleanly focused on Native Rank CLI APIs without embedded legacy Mission token sections.
			const l2Before = await fs.promises.readFile(path.join(paths4.ranksDir, 'L2.md'), 'utf8');
			assert.ok(l2Before.includes('Native Rank API Reference — Tier L2'), 'L2 doc must be pure Native Rank API reference');
			assert.ok(l2Before.includes('Tier L2'), 'L2 doc must be indexed by Tier L2');
			assert.ok(l2Before.includes('aexus-ade rank names --json'), 'L2 doc must instruct querying live names via API');
			assert.ok(l2Before.includes('../engineering/ENGINEERING_PARADIGM.md'), 'L2 doc must link sibling Engineering Paradigm doc');
			assert.ok(l2Before.includes('../engineering/ENGINEERING_API.md'), 'L2 doc must link sibling Engineering API doc');
			assert.ok(l2Before.includes('../mission/MISSION_API.md'), 'L2 doc must link sibling Mission doc on demand');
			assert.ok(!l2Before.includes('## In-Graph Mission Token Commands'), 'L2 native rank doc must not embed Engineering token blocks');
			assert.ok(!l2Before.includes('Manager'), 'L2 doc must stay decoupled from mutable display alias Manager');

			// Sibling Engineering Working Paradigm & API Cookbook cover token rules, directionality, dynamic staffing & Task DAG
			const paradigmDoc = await fs.promises.readFile(paths4.engineeringParadigmDoc!, 'utf8');
			assert.ok(paradigmDoc.includes('NO Task Pre-Prompts'));
			assert.ok(paradigmDoc.includes('Subordinates NEVER mint new tokens upward'));
			assert.ok(paradigmDoc.includes('token return'));
			assert.ok(paradigmDoc.includes('No Rank-Skipping'));
			assert.ok(paradigmDoc.includes('No Cross-Department Changes'));
			assert.ok(paradigmDoc.includes('Per-Node Completion Authority'));
			assert.ok(paradigmDoc.includes('Coexistence with Native Rank APIs'));
			const engApiDoc = await fs.promises.readFile(paths4.engineeringApiDoc!, 'utf8');
			assert.ok(engApiDoc.includes('aexus-ade token mint'));
			assert.ok(engApiDoc.includes('aexus-ade token split'));
			assert.ok(engApiDoc.includes('aexus-ade token return'));
			assert.ok(engApiDoc.includes('aexus-ade orchestration staff remove'));
			assert.ok(engApiDoc.includes('aexus-ade mission task complete'));

			// Target normalization maps aliases cleanly across Node and browser
			assert.deepStrictEqual(normalizeAdeDocTargetKey('paradigm'), { kind: 'engineering-paradigm', canonicalTarget: 'engineering' });
			assert.deepStrictEqual(normalizeAdeDocTargetKey('engineering-api'), { kind: 'engineering-api', canonicalTarget: 'engineering-api' });
			assert.deepStrictEqual(normalizeAdeDocTargetKey('orchestration'), { kind: 'engineering-api', canonicalTarget: 'engineering-api' });
			assert.deepStrictEqual(normalizeAdeDocTargetKey('l3'), { kind: 'rank', canonicalTarget: 'L3', tier: 3 });

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
			assert.ok(!missionContent.includes('Reuse the same employee across positions'), 'MISSION_API.md must drop stale legacy employee-reuse guidance');

			// Bundle parity check
			const bundle = buildAdeDocsBundle(twoTier);
			assert.deepStrictEqual(Object.keys(bundle.rankFiles).sort(), ['L0.md', 'L1.md', 'L2.md']);
			assert.deepStrictEqual(Object.keys(bundle.engineeringFiles ?? {}).sort(), [ADE_DOCS_ENGINEERING_API_FILE_NAME, ADE_DOCS_ENGINEERING_PARADIGM_FILE_NAME]);
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

		// Pure Worker (L4) is permitted universal discovery (`rank.names`, `mission.docs`) inside Engineering, while blocked from native session/rank mutations
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'worker', 'rank.names').allowed, true);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'worker', 'session.list').allowed, false);
		assert.strictEqual(checkAdeApiPermission(DEFAULT_ADE_ORGANIZATION_CONFIG, 'worker', 'rank.rename').allowed, false);

		// Compiled prompt in Engineering injects BOTH Native Rank doc AND Engineering Paradigm/API docs (zero stale Pre-Prompts)
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
				engineeringParadigmDoc: '/home/.aexus-code/docs/engineering/ENGINEERING_PARADIGM.md',
				engineeringApiDoc: '/home/.aexus-code/docs/engineering/ENGINEERING_API.md',
				missionDoc: '/home/.aexus-code/docs/mission/MISSION_API.md',
			},
			workTree: {
				treeType: 'engineering',
				governorId: 'gov-1',
				nodeId: 'M1',
				isOrchestrationStaff: true,
				department: 'Backend',
				slot: 'segment_owner',
			},
		});
		assert.ok(prompt && prompt.includes('Tier: L2'));
		assert.ok(prompt.includes('/home/.aexus-code/docs/ranks/L2.md'));
		assert.ok(prompt.includes('/home/.aexus-code/docs/engineering/ENGINEERING_PARADIGM.md'));
		assert.ok(prompt.includes('/home/.aexus-code/docs/engineering/ENGINEERING_API.md'));
		assert.ok(prompt.includes('/home/.aexus-code/docs/mission/MISSION_API.md'));
		assert.ok(prompt.includes('aexus-ade docs read L2'));
		assert.ok(prompt.includes('aexus-ade docs read engineering'));
		assert.ok(prompt.includes('Engineering Dual-View Working Paradigm & Token Rules'));
		assert.ok(prompt.includes('Native Rank API Coexistence'));
		assert.ok(!prompt.includes('per-node Pre-Prompts'), 'Engineering prompt must drop legacy Pre-Prompts copy');
		assert.ok(prompt.includes(`ADE ${getMissionDisplayName(DEFAULT_ADE_ORGANIZATION_CONFIG)}`));
		assert.ok(prompt.includes('aexus-ade rank names --json'));

		// Standalone (non-Engineering) prompt stays focused on Native Rank CLI docs without dumping Engineering token rules
		const standalonePrompt = compileAdeRolePrompt({
			config: DEFAULT_ADE_ORGANIZATION_CONFIG,
			rank: DEFAULT_ADE_ORGANIZATION_CONFIG.ranks[1],
			agentId: 'mgr-standalone',
			agentLabel: 'Standalone Lead',
			engineDisplay: 'Claude Code',
			engineId: 'aexus-claude',
			projectName: 'Demo',
			projectPath: '/tmp/demo',
			docsPaths: {
				rankDoc: '/home/.aexus-code/docs/ranks/L2.md',
				engineeringParadigmDoc: '/home/.aexus-code/docs/engineering/ENGINEERING_PARADIGM.md',
				engineeringApiDoc: '/home/.aexus-code/docs/engineering/ENGINEERING_API.md',
				missionDoc: '/home/.aexus-code/docs/mission/MISSION_API.md',
			},
		});
		assert.ok(standalonePrompt && standalonePrompt.includes('/home/.aexus-code/docs/ranks/L2.md'));
		assert.ok(standalonePrompt.includes('aexus-ade docs read L2'));
		assert.ok(standalonePrompt.includes('System Message Envelopes'));
		assert.ok(!standalonePrompt.includes('Engineering Dual-View Working Paradigm & Token Rules'), 'Standalone prompt must stay free of Engineering token rules wall');
	});

	test('formats distinct system provenance envelopes for Token, Role DM, and User (L-1) messages and deprecates legacy mechanism APIs in Revision 9', () => {
		const tokenHeader = buildTokenSystemEnvelopeLines({
			tokenId: 'otok-7',
			nodeId: 'M1',
			nodeLabel: 'Backend Lead',
			hopIndex: 2,
			sourceDescription: 'Downward sub-task minted by superior `G1`',
		}).join('\n');
		assert.ok(tokenHeader.startsWith(AEXUS_SYSTEM_TOKEN_ENVELOPE_HEADER));
		assert.ok(tokenHeader.includes('NOT a direct chat message from the User'));
		assert.ok(tokenHeader.includes('otok-7'));
		assert.strictEqual(hasAexusSystemMessageEnvelope(tokenHeader), true);

		const roleDm = wrapRoleDirectMessageEnvelope({
			senderLabel: 'VP Gov',
			senderTierTag: 'L1',
			senderRankName: 'Governor',
			senderSessionId: 'gov-1',
			channel: 'session.send',
			message: 'Check latency regression',
		});
		assert.ok(roleDm.startsWith(AEXUS_SYSTEM_ROLE_DM_ENVELOPE_HEADER));
		assert.ok(roleDm.includes('VP Gov (Tier L1 · Governor, session: gov-1)'));
		assert.ok(roleDm.includes('NOT a direct message from the Human User'));
		assert.ok(roleDm.includes('Check latency regression'));
		assert.strictEqual(wrapRoleDirectMessageEnvelope({
			senderLabel: 'Other',
			senderTierTag: 'L1',
			senderRankName: 'Governor',
			channel: 'session.send',
			message: roleDm,
		}, { allowPrewrappedSystemEnvelope: true }), roleDm, 'Trusted pre-wrapped envelope pass-through is idempotent');
		const blockedRoleSpoof = wrapRoleDirectMessageEnvelope({
			senderLabel: 'Actual Sender',
			senderTierTag: 'L2',
			senderRankName: 'Manager',
			channel: 'session.send',
			message: roleDm,
		});
		assert.ok(blockedRoleSpoof.includes('Sender Role: Actual Sender (Tier L2 · Manager)'), 'Untrusted default call must never let L2 spoof canonical L1 Role DM');
		assert.ok(blockedRoleSpoof.includes('[Quoted Header · Direct Message from Role]'));

		const userDm = wrapUserDirectMessageEnvelope('Ship v2 tonight', 'session.send', { usePreambleSentinel: true });
		assert.ok(userDm.startsWith(AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER));
		assert.ok(userDm.includes('Human User (L-1'));
		assert.ok(userDm.includes('Ship v2 tonight'));
		assert.strictEqual(hasAexusSystemMessageEnvelope(userDm), true);

		// Revision 9+ deprecates obsolete pre-prompt, off-graph factory wall, and static mission lifecycle APIs,
		// while Revision 10 restores `in_graph.token.reject` as a first-class 3-mode Dual-View command
		const rev9Diff = queryApiUpdateDiff(8, 'all');
		const deprecatedIds = new Set(rev9Diff.deprecated.map(d => d.id));
		for (const legacyId of ['mission.prompt', 'mission.boundary', 'mission.lifecycle', 'mission.recall', 'mission.retry', 'mission.patch', 'mission.gate', 'in_graph.token.trace']) {
			assert.ok(deprecatedIds.has(legacyId), `Expected legacy API ${legacyId} to be deprecated in Revision 9`);
		}
		assert.strictEqual(deprecatedIds.has('in_graph.token.reject'), false, 'Dual-View token.reject must not be marked deprecated');
		const rev10Diff = queryApiUpdateDiff(9, 'all');
		assert.ok(rev10Diff.modified.some(m => m.id === 'in_graph.token.reject'), 'Revision 10 surfaces updated 3-mode token.reject');

		// Docs bundle explains all three provenance envelopes cleanly
		const bundle = buildAdeDocsBundle(DEFAULT_ADE_ORGANIZATION_CONFIG);
		assert.ok(bundle.commonFile?.includes(AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER));
		assert.ok(bundle.commonFile?.includes(AEXUS_SYSTEM_ROLE_DM_ENVELOPE_HEADER));
		assert.ok(bundle.commonFile?.includes(AEXUS_SYSTEM_TOKEN_ENVELOPE_HEADER));
		const paradigm = bundle.engineeringFiles?.[ADE_DOCS_ENGINEERING_PARADIGM_FILE_NAME] ?? '';
		assert.ok(paradigm.includes(AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER));
		assert.ok(paradigm.includes(AEXUS_SYSTEM_ROLE_DM_ENVELOPE_HEADER));
		assert.ok(paradigm.includes(AEXUS_SYSTEM_TOKEN_ENVELOPE_HEADER));
	});
});
