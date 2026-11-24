/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ADE_API_LATEST_REVISION,
	ADE_API_SPEC_CATALOG,
	renderCommonApiDoc,
} from './adeApiRegistry.js';
import {
	ADE_PRIMITIVE_APIS,
	ADE_WORK_TREE_SLOTS,
	IAdeOrganizationConfig,
	IAdeRankDefinition,
	renderAllowedPrimitiveApiLines,
} from './adeRoleSchema.js';
import { ADE_SECRETARY_TIER_TAG, formatTierTag } from './adeRankResize.js';

export const ADE_DOCS_DIR_NAME = 'docs';
export const ADE_DOCS_COMMON_DIR_NAME = 'common';
export const ADE_DOCS_COMMON_FILE_NAME = 'COMMON_API.md';
export const ADE_DOCS_RANKS_DIR_NAME = 'ranks';
export const ADE_DOCS_ENGINEERING_DIR_NAME = 'engineering';
export const ADE_DOCS_ENGINEERING_PARADIGM_FILE_NAME = 'ENGINEERING_PARADIGM.md';
export const ADE_DOCS_ENGINEERING_API_FILE_NAME = 'ENGINEERING_API.md';
export const ADE_DOCS_MISSION_DIR_NAME = 'mission';
export const ADE_DOCS_MISSION_FILE_NAME = 'MISSION_API.md';
export const ADE_DOCS_MANIFEST_FILE_NAME = 'api-manifest.json';

export interface IAdeDocsPaths {
	readonly docsRoot: string;
	readonly commonDir?: string;
	readonly commonDoc?: string;
	readonly manifestFile?: string;
	readonly ranksDir: string;
	readonly engineeringDir?: string;
	readonly engineeringParadigmDoc?: string;
	readonly engineeringApiDoc?: string;
	readonly missionDir: string;
	readonly missionDoc: string;
	readonly rankDocs: Readonly<Record<string, string>>;
}

export interface IAdeDocsBundle {
	readonly commonFile?: string;
	readonly manifestJson?: string;
	readonly rankFiles: Readonly<Record<string, string>>;
	readonly engineeringFiles?: Readonly<Record<string, string>>;
	readonly missionFile: string;
}

export type AdeNormalizedDocTarget =
	| { readonly kind: 'common'; readonly canonicalTarget: 'common' }
	| { readonly kind: 'engineering-paradigm'; readonly canonicalTarget: 'engineering' }
	| { readonly kind: 'engineering-api'; readonly canonicalTarget: 'engineering-api' }
	| { readonly kind: 'mission'; readonly canonicalTarget: 'mission' }
	| { readonly kind: 'manifest'; readonly canonicalTarget: 'manifest' }
	| { readonly kind: 'rank'; readonly canonicalTarget: string; readonly tier: number };

/**
 * Normalizes a CLI `docs read <target>` argument into a canonical document target.
 * Shared across Node backend (`AdeDocsBackendNodeService`) and workbench (`adeRankApiHandler`)
 * so local, remote SSH, and browser fallback paths stay 100% consistent.
 */
export function normalizeAdeDocTargetKey(rawTarget: string): AdeNormalizedDocTarget | undefined {
	const trimmed = (rawTarget || '').trim();
	if (!trimmed) {
		return undefined;
	}
	const lower = trimmed.toLowerCase();
	if (lower === 'common' || lower === 'base') {
		return { kind: 'common', canonicalTarget: 'common' };
	}
	if (
		lower === 'engineering'
		|| lower === 'paradigm'
		|| lower === 'engineering-paradigm'
		|| lower === 'engineering_paradigm'
		|| lower === 'workflow'
		|| lower === 'rules'
	) {
		return { kind: 'engineering-paradigm', canonicalTarget: 'engineering' };
	}
	if (
		lower === 'engineering-api'
		|| lower === 'engineering_api'
		|| lower === 'orchestration'
		|| lower === 'orchestration-api'
		|| lower === 'orchestration_api'
	) {
		return { kind: 'engineering-api', canonicalTarget: 'engineering-api' };
	}
	if (lower === 'mission') {
		return { kind: 'mission', canonicalTarget: 'mission' };
	}
	if (lower === 'manifest') {
		return { kind: 'manifest', canonicalTarget: 'manifest' };
	}
	const rankMatch = /^l(\d+)$/i.exec(trimmed);
	if (rankMatch) {
		const tier = Number(rankMatch[1]);
		return { kind: 'rank', canonicalTarget: `L${tier}`, tier };
	}
	return undefined;
}

function joinDocPath(base: string, ...parts: readonly string[]): string {
	const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	const cleanBase = base.replace(/[\\/]+$/, '');
	return [cleanBase, ...parts.map(p => p.replace(/^[\\/]+|[\\/]+$/g, ''))].join(sep);
}

/**
 * Computes canonical single-copy documentation paths under `<adeHome>/docs/`:
 * - `<adeHome>/docs/common/COMMON_API.md` (universal base commands & immutable `api update`)
 * - `<adeHome>/docs/ranks/L0.md`, `L1.md`, ..., `L<N>.md` (pure Native Rank CLI API docs)
 * - `<adeHome>/docs/engineering/ENGINEERING_PARADIGM.md` & `ENGINEERING_API.md` (sibling folder: Engineering Dual-View working paradigm & CLI reference)
 * - `<adeHome>/docs/mission/MISSION_API.md` (compact compatibility index pointing to `engineering/`)
 * - `<adeHome>/docs/api-manifest.json` (compact versioned revision manifest)
 */
export function buildAdeDocsPaths(adeHomeDir: string, rankCount: number): IAdeDocsPaths {
	const docsRoot = joinDocPath(adeHomeDir, ADE_DOCS_DIR_NAME);
	const commonDir = joinDocPath(docsRoot, ADE_DOCS_COMMON_DIR_NAME);
	const commonDoc = joinDocPath(commonDir, ADE_DOCS_COMMON_FILE_NAME);
	const manifestFile = joinDocPath(docsRoot, ADE_DOCS_MANIFEST_FILE_NAME);
	const ranksDir = joinDocPath(docsRoot, ADE_DOCS_RANKS_DIR_NAME);
	const engineeringDir = joinDocPath(docsRoot, ADE_DOCS_ENGINEERING_DIR_NAME);
	const engineeringParadigmDoc = joinDocPath(engineeringDir, ADE_DOCS_ENGINEERING_PARADIGM_FILE_NAME);
	const engineeringApiDoc = joinDocPath(engineeringDir, ADE_DOCS_ENGINEERING_API_FILE_NAME);
	const missionDir = joinDocPath(docsRoot, ADE_DOCS_MISSION_DIR_NAME);
	const missionDoc = joinDocPath(missionDir, ADE_DOCS_MISSION_FILE_NAME);
	const rankDocs: Record<string, string> = {
		[ADE_SECRETARY_TIER_TAG]: joinDocPath(ranksDir, `${ADE_SECRETARY_TIER_TAG}.md`),
	};
	const clamped = Math.max(1, Math.floor(rankCount));
	for (let tier = 1; tier <= clamped; tier++) {
		const tag = formatTierTag(tier);
		rankDocs[tag] = joinDocPath(ranksDir, `${tag}.md`);
	}
	return {
		docsRoot,
		commonDir,
		commonDoc,
		manifestFile,
		ranksDir,
		engineeringDir,
		engineeringParadigmDoc,
		engineeringApiDoc,
		missionDir,
		missionDoc,
		rankDocs,
	};
}

/**
 * Renders the single-copy L0 (Secretary) Native Rank API reference document (`docs/ranks/L0.md`).
 * Strictly tier-indexed (L0) and alias-agnostic; live user aliases are queried via `aexus-ade rank names --json`.
 */
export function renderL0SecretaryDoc(config: IAdeOrganizationConfig): string {
	const tierCount = config.ranks.length;
	return [
		'# Aexus ADE Native Rank API Reference — Tier L0 (Secretary)',
		'',
		'Single shared **Native Rank** CLI reference for **Tier L0 (Secretary)** (`docs/ranks/L0.md`).',
		`Organization depth: **${tierCount} tier(s)** (\`L-1\` User → \`L0\` Secretary → \`L1\` highest → \`L${tierCount}\` lowest). Query live aliases via \`aexus-ade rank names --json\`; never switch workbench mode to IDE.`,
		'',
		'## 1. Live Rank, Role & Docs APIs',
		'```bash',
		'aexus-ade whoami --json',
		'aexus-ade docs read <common|L0|L1..LN|engineering|engineering-api|mission|manifest>',
		`aexus-ade api update --since ${ADE_API_LATEST_REVISION} --json`,
		'aexus-ade rank names --json | rank list --json | rank get <L-1|L0|L1..LN|id> --json',
		'aexus-ade rank rename <L1..LN> "<alias>" [--short <tag>] | rank set-count <N> | rank mission-name "<Alias>"',
		'aexus-ade role list --json | role presets --json | role apply-preset <presetId> | role set-tier <sessionId> <L1..LN|rankId|none>',
		'```',
		'',
		'## 2. Viewport, Projects & Cloud Hosts',
		'```bash',
		'aexus-ade status --json | view [status | --archived <true|false|toggle> | --inspector <changes|files|hide> | --refresh] --json',
		'aexus-ade project list --json | project add <path|host:/path...> [--name <label>]',
		'aexus-ade project select <target> | focus <target> | home | forward | remove <target>',
		'aexus-ade project changes [target] --json | files [target] [--path <subpath>] [--depth <n>] --json',
		'aexus-ade project open-file <file> [--project <target>] | open-diff <file> [--project <target>]',
		'aexus-ade host list --json | host info <alias> --json | host add --alias <alias> --host <addr> | host test <alias> --json | host browse <alias> [--path <dir>]',
		'```',
		'',
		'## 3. Native Sessions, Top-Down Org & Inbox',
		'- **Native ADE Sessions vs. Engineering Canvas Staff**: `session create|configure|move|role|delete` manage regular ADE employee sessions; adding/removing employee **nodes on an Engineering Orchestration canvas** MUST use `aexus-ade orchestration staff create|config|rename|remove --mission <id> ...`.',
		'```bash',
		'aexus-ade engine list --json',
		'aexus-ade session list [--project <p>] [--parent <id|root>] [--role <L1..LN|rankId|none>] [--status <s>] --json',
		'aexus-ade session info <id> --json | session tree [id] --json | session subordinates [id] [--recursive] --json',
		'aexus-ade session create [--project <p>] [--engine <e>] [--title <t>] [--parent <id>] [--role <L1..LN|rankId>] [--model <m>] [--thinking <lvl>] [--no-open] --json',
		'aexus-ade session configure <id> [--engine <e>] [--model <m>] [--thinking <off|low|medium|high|max>] [--role <L1..LN|rankId|none>] --json',
		'aexus-ade session send <id> "<prompt>" [--wait] | session history <id> [--limit <n>] --json',
		'aexus-ade session role <id> <L1..LN|rankId|none> | session move <id> <parentId|none> | session rename <id> "<title>"',
		'aexus-ade session stop <id> | archive <id> | unarchive <id> | detach <id> | delete <id> [--force]',
		'aexus-ade org subordinates [--mission <id>] --json | org context <id> [--limit 10] [--full] --json | org send <id> "<directive>" [--wait] --json',
		'aexus-ade inbox list [--unread-only] --json | inbox post --from <id> --message "<text>" | inbox mark-read <id|--all> | inbox resolve --id <id>',
		'aexus-ade mission list [--project <path>] --json | mission init [--title "<name>"] [--open] | mission rename <id> "<title>"',
		'```',
		'',
		'## 4. Engineering Dual-View Docs (Sibling Folder — Read On Demand)',
		'- Working Paradigm & Token Rules: `../engineering/ENGINEERING_PARADIGM.md` (`aexus-ade docs read engineering`)',
		'- Engineering CLI API Cookbook: `../engineering/ENGINEERING_API.md` (`aexus-ade docs read engineering-api`)',
		'- Compatibility Index: `../mission/MISSION_API.md` (`aexus-ade docs read mission`)',
		'',
	].join('\n');
}

/**
 * Renders the single-copy **Native Rank** tier documentation `docs/ranks/L<tier>.md`.
 * Strictly tier-based (`L1`, `L2`, ..., `LN`) — decoupled from mutable display aliases
 * and separated from Engineering working paradigm docs (`../engineering/`).
 */
export function renderTierRankDoc(config: IAdeOrganizationConfig, rank: IAdeRankDefinition): string {
	const tierTag = formatTierTag(rank.tier);
	const totalTiers = config.ranks.length;
	const lowerTierTag = rank.tier < totalTiers ? formatTierTag(rank.tier + 1) : undefined;
	const higherTierTag = rank.tier > 1 ? formatTierTag(rank.tier - 1) : ADE_SECRETARY_TIER_TAG;

	const header = [
		`# Aexus ADE Native Rank API Reference — Tier ${tierTag}`,
		'',
		`Single shared **Native Rank** CLI specification for **Tier ${tierTag}** (\`docs/ranks/${tierTag}.md\`).`,
		`Hierarchy depth: \`L-1\` User → \`L0\` Secretary → \`L1\` highest → \`L${totalTiers}\` lowest. Always rely on numeric tier (\`L<n>\`) and query live display aliases via:`,
		'```bash',
		'aexus-ade rank names --json   # Live { L-1, L0, L1..LN } alias map',
		'aexus-ade rank list --json    # Live hierarchy, permissions & doc paths',
		'```',
		'',
		'## Tier Position & Native Capabilities',
		`- **Tier**: \`${tierTag}\` (machine ID: \`${rank.id}\`) | **Upper**: \`${higherTierTag}\` | **Lower**: ${lowerTierTag ? `\`${lowerTierTag}\`` : 'None (lowest tier)'}`,
		`- **Can Supervise Subordinates**: ${rank.canHaveSubordinates ? 'Yes' : 'No'} | **Pure Execution (Outside Engineering)**: ${rank.pureExecution ? 'Yes (zero ADE management APIs)' : 'No'}`,
		'',
	];

	if (rank.pureExecution || rank.allowedApis.length === 0) {
		return [
			...header,
			'## Universal Base & On-Demand API Update',
			'```bash',
			'aexus-ade whoami --json',
			'aexus-ade docs read common',
			`aexus-ade api update --since ${ADE_API_LATEST_REVISION} --json`,
			'```',
			'',
			'## Authorized Native Rank Primitive APIs',
			'- **None.** Outside Engineering, sessions at this tier execute coding tasks in a 100% clean native Coding Agent context. Inside an Engineering workspace, assigned staff may use scoped `token.*`, `org.escalate`, `whiteboard.list|read|write`, `mission.task.list|get`, `mission.check.list|get|run`, `mission.diagnostics`, `mission.checkpoint.list|diff`, and read-only `orchestration.get|status|validate|limits` (see `../engineering/ENGINEERING_API.md`).',
			'',
			'## Engineering Dual-View Docs (Sibling Folder — Read On Demand)',
			'- Working Paradigm & Token Rules: `../engineering/ENGINEERING_PARADIGM.md` (`aexus-ade docs read engineering`)',
			'- Engineering CLI API Cookbook: `../engineering/ENGINEERING_API.md` (`aexus-ade docs read engineering-api`)',
			'- Unified Reference: `../mission/MISSION_API.md` (`aexus-ade docs read mission`)',
			'',
		].join('\n');
	}

	const apiSpecs = rank.allowedApis
		.map(id => ADE_PRIMITIVE_APIS.find(spec => spec.id === id))
		.filter((spec): spec is NonNullable<typeof spec> => Boolean(spec));

	const cliLines = renderAllowedPrimitiveApiLines(rank, {
		agentId: '<your-session-id>',
		isWorkTree: false,
		rankId: rank.id,
	});

	const canReadOrg = rank.allowedApis.includes('session.read_context');
	const canMsgOrg = rank.allowedApis.includes('session.message');
	const canEscalate = rank.allowedApis.includes('inbox.post');
	const supervisionBlock = rank.canHaveSubordinates
		? [
			'## Native Top-Down Supervision & Boundary vs. Engineering Canvas',
			'- Communication is strictly **top-down**: superiors inspect subordinate context, send directives, and spawn/configure/delete lower-tier **native ADE employee sessions** (`session create|configure|delete`) within their subtree; subordinates never message upward.',
			'- **Native Session vs. Engineering Canvas Staff**: `aexus-ade session create` creates a regular ADE session outside Engineering. To add, configure, or remove an employee **node on an Engineering Orchestration canvas**, ALWAYS use `aexus-ade orchestration staff create|config|remove --mission <id> ...` (`../engineering/ENGINEERING_API.md`). Keep routine Engineering work on baton tokens.',
			'```bash',
			...(canReadOrg ? [
				'aexus-ade org subordinates [--mission <id>] --json',
				'aexus-ade org context <nodeOrSessionId> [--limit 10] [--full] [--mission <id>] --json',
			] : []),
			...(canMsgOrg ? ['aexus-ade org send <nodeOrSessionId> "<directive>" [--mission <id>] [--wait] --json'] : []),
			...(canEscalate ? ['aexus-ade org escalate --reason "<reason>" [--node <nodeId>] [--token <tokenId>] [--mission <id>] --json'] : []),
			'```',
			'',
		]
		: [
			'## Hierarchy Discipline & Escalation',
			'- This tier has **no subordinate sessions** (`canHaveSubordinates: false`): do NOT call `session create` or `orchestration staff create`. Outside Engineering, execute assigned scope directly; inside Engineering, collaborate via baton tokens (`../engineering/ENGINEERING_API.md`).',
			...(canEscalate ? [
				'```bash',
				'aexus-ade org escalate --reason "<reason>" [--node <nodeId>] [--token <tokenId>] [--mission <id>] --json',
				'```',
			] : []),
			'',
		];

	return [
		...header,
		'## Universal Base & Immutable API Update Diff',
		'```bash',
		'aexus-ade whoami --json',
		'aexus-ade docs read common',
		`aexus-ade api update --since ${ADE_API_LATEST_REVISION} --json`,
		'```',
		'',
		...supervisionBlock,
		'## Authorized Native Kernel Primitive APIs',
		...apiSpecs.map(spec => `- \`${spec.id}\` — ${spec.description}`),
		'',
		'## Native Rank CLI Command Reference (`aexus-ade`)',
		...cliLines,
		'',
		'## Engineering Dual-View Docs (Sibling Folder — Read On Demand)',
		'- Working Paradigm & Token Rules: `../engineering/ENGINEERING_PARADIGM.md` (`aexus-ade docs read engineering`)',
		'- Engineering CLI API Cookbook: `../engineering/ENGINEERING_API.md` (`aexus-ade docs read engineering-api`)',
		'- Unified Reference: `../mission/MISSION_API.md` (`aexus-ade docs read mission`)',
		'',
	].join('\n');
}

/**
 * Renders the single-copy **Engineering Dual-View Working Paradigm & Token Rules** document
 * (`docs/engineering/ENGINEERING_PARADIGM.md`).
 */
export function renderEngineeringParadigmDoc(config: IAdeOrganizationConfig): string {
	const totalTiers = config.ranks.length;
	return [
		'# Aexus ADE — Engineering Dual-View Working Paradigm & Token Rules',
		'',
		`Current API Revision: **${ADE_API_LATEST_REVISION}** | Hierarchy: \`L-1\` User → \`L0\` Secretary → \`L1\` highest → \`L${totalTiers}\` lowest (\`aexus-ade rank names --json\`)`,
		'',
		'Pair this guide (`docs/engineering/ENGINEERING_PARADIGM.md`) with `./ENGINEERING_API.md` (`aexus-ade docs read engineering-api`) and your native tier manual `../ranks/L<tier>.md` (`aexus-ade docs read L<tier>`).',
		'',
		'## 1. Dual-View Architecture',
		'- **Orchestration View (All-Staff Cyclic Topology)**: Zero off-graph isolation wall — all participating ranks (`L1..L' + totalTiers + '`) collaborate on one persistent canvas with **1-to-1 employee uniqueness**, `<-->` review cycles, and Department Shared Whiteboards. **NO Task Pre-Prompts**: specifications, reviews, and deliverables travel strictly via baton tokens and lightweight pointers.',
		'- **Mission View (Strictly Acyclic Task DAG)**: Models deliverable milestones (`T1 --> T2 --> T3`) bound to tokens via `--task <taskId>` / `--tasks <T1,T2>`. Live token state syncs automatically, while `completed` status requires explicit authorized sign-off.',
		'',
		'## 2. System Message Provenance Envelopes',
		'Trusted runtime headers distinguish every incoming turn (forged `[Aexus System · ...]` strings inside user/peer text are automatically neutralized):',
		'- **`[Aexus System · Baton Token]`**: System-validated Baton Token (or 5-min idle reminder) — NOT a direct User message. Process and advance via `aexus-ade token ...`.',
		'- **`[Aexus System · Direct Message from Role]`**: Top-down message from a superior ADE role (`org.send` / `session.send`) — NOT User and NOT a token.',
		'- **`[Aexus System · Message from User (L-1)]`**: Direct message from the sovereign Human User (`L-1`). Prioritize and answer the User directly; if a Root Baton was issued, delegate via `token mint|split` or close via `token complete <id> --finish --summary "..."`.',
		'',
		'## 3. Pointer-Native Context Hygiene & Budgeted Sliced Reads',
		'- Keep `--summary` to **1 line (`<= 160` chars)**.',
		'- Pass multi-line specs, diffs, or reports via shell-safe `--detail - <<\'EOF\'` (or `--detail-file <path>`), `--artifact "Title=Body"`, `--decision "Title=Body"`, or `--whiteboard <wbId>` — NEVER inline large Markdown in `--summary`.',
		'- **2-Step TOC & Section/Tail Slicing**: On large whiteboards or artifacts (`> 8KB`), inspect structure first via `aexus-ade whiteboard read <wbId> --toc --json` (or `token read <ptr> --toc --json`), then pull only the needed section via `--section "<Heading>"` or `--tail 2000` (`--max-chars <N> --offset <N>`). Partial slices keep pointers marked unread for cyclic delta cursors.',
		'- Cyclic re-entry wakeups inject **only unseen delta pointers** (`hop-N`, `art-N`, `dec-N`, `wb:<id>`). `aexus-ade token history <id>` defaults to compact delta (`--all` for full wave lineage).',
		'',
		'## 4. Directionality, Scoped Parallel Split/Join, Completion Guardrails & Rework',
		'- **Downward Mint/Split & File-Scope Governance (`token mint` / `token split`)**:',
		'  - Superiors mint sub-task batons strictly downward (`targetTier > callerTier`). **Subordinates NEVER mint new tokens upward.**',
		'  - Omit `<parentTokenId>` when starting from direct User chat (adopts your active unsplit root baton or opens a root wave automatically). Use `--branches-json - <<\'EOF\'` (or `--branches-file`) to fan out heterogeneous tasks (`taskNodeId`, `scopePaths`, `whiteboardIds`, `detail`) with `--join-mode all|any|quorum [--quorum <k>] [--fail-fast] [--deadline 30m] [--conflict-policy reject|warn|allow]`.',
		'  - **Disjoint File Scopes**: Assign per-branch `scopePaths` (and pass `--files "src/..."` on `token return|complete`) so parallel branches never trample the same files; join barriers surface any overlapping `touchedFiles` automatically.',
		'  - **Zero-Polling Rule (`--wait-join`)**: After calling `token mint|split --wait-join`, **STOP YOUR TURN IMMEDIATELY** — NEVER `sleep`, poll `orchestration status`, or run background loops. Aexus wakes you automatically when child batons converge or `--deadline` expires.',
		'- **Deterministic Completion Guardrails (`token return [--complete-task]` & `mission task complete`)**:',
		'  - Subordinates return received batons upward via `aexus-ade token return <tokenId> --summary "<delivery>" [--files "p1,p2"]`.',
		'  - Tasks configured with `%% check` hooks or `completionContract` (`require_checks=true`, `require_artifact=true`, `require_files=true`, `require_wb=WB_A`, `min_summary=40`) verify deterministic checks and required deliverables in BOTH workbench and headless modes before `--complete-task` / `mission task complete` succeeds (`COMPLETION_CONTRACT_UNMET` on missing proof).',
		'- **3-Mode Defect Bounce (`token reject`) & Recovery (`token retry`)**:',
		'  - `token reject <id> --reason "<defect>" [--category <defect|spec|test|env|scope>] [--to <nodeId>]` supports: (1) **downward rework** to a subordinate, (2) **peer bounce** along a `<-->` review loop (e.g. `QA -> Backend`), or (3) **upward reject** when an upstream input/contract is invalid, recording structured `reworkHistory` + `attemptNumber`. Failed tokens recover via `aexus-ade token retry <failedId> --guidance "..." [--wait-join]`.',
		'- **Blocking & 5-Min Reminder (`token block`)**: Call `token block <id> --duration <30m|2h> --reason "..." [--watch-pid <pid>] [--watch-file <path>]` during long runs; unblocked silent batons nudge every 5 minutes.',
		'',
		'## 5. Dynamic Runtime Staffing & In-Flight Reclamation',
		'- Use `orchestration staff create|config|remove` under two hard kernel rules:',
		'  1. **No Rank-Skipping**: create or remove ONLY **immediate next-tier subordinates** (`targetTier === callerTier + 1`).',
		'  2. **No Cross-Department Changes**: `L2+` managers act strictly inside **their own department**; top-rank `L1` may spin up a new `L2` Manager + department + whiteboard in one call (`--new-department "<Dept>" --create-whiteboard`).',
		'- Removing a staff node aborts its active turn, reclaims all held tokens back to its dispatching superior, and settles waiting join barriers with zero lost work.',
		'',
		'## 6. Mission Task DAG, Human Gates (`U1{{...}}`), Checkpoints & Diagnostics',
		'- **Per-Node Completion Authority & Upstream Gate**: `mission task complete --node <taskId>` enforces the node\'s `owner`/`completers`/`min_tier` policy, its `completionContract` & `nodeChecks`, AND that **every non-fail upstream task is `completed`** (`INCOMPLETE_DEPENDENCIES`).',
		'- **Human Gate Nodes (`U1{{"..."}}`, `kind === "gate"`)**: Hexagon gate nodes in the Task DAG require **Human User (`L-1`) or delegated Secretary (`L0`)** approval (via the Canvas Gate button or `aexus-ade mission task complete --mission <id> --node U1`) unless explicit `completers` override it. When upstream work reaches `U1`, `L1` summarizes readiness (via chat or `inbox post`) and waits for `U1` approval before completing downstream sink tasks (`T5`) and closing the wave (`token complete <rootId> --finish --complete-task`).',
		'- **Critical-Path Diagnostics & Checkpoints**: Run `aexus-ade mission diagnostics --mission <id> --json` to inspect critical path, ready/blocked tasks, stalled batons, and FinOps health; use `aexus-ade mission checkpoint list|create|diff|restore --mission <id>` for safe rollback points.',
		'',
		'## 7. Department Whiteboards & Coexistence with Native Rank APIs',
		'- **Whiteboard Access Matrix**:',
		'  - **Department Boards (`dept=<Dept>`)**: Read/write by same-department staff and `L1`; cross-department staff gain **read** access when a board is attached to an active baton (`--whiteboard <wbId>`).',
		'  - **Executive / `dept=General` Shared Boards**: Readable across the mission; writable by `L1`, board owner, or connected/authorized leads (pass ONLY `--whiteboard <wbId>` pointers in tokens, never full Markdown).',
		'- **Coexistence with Native Rank APIs**: `aexus-ade session create|delete` (`../ranks/L<tier>.md`) manages regular ADE sessions outside Engineering; NEVER call `session create` to add an Engineering canvas node (use `orchestration staff create`). Reserve native `org context|send` strictly for exceptional diagnostics.',
		'',
	].join('\n');
}

/**
 * Renders the role-grouped **Engineering CLI API Cookbook** (`docs/engineering/ENGINEERING_API.md`).
 */
export function renderEngineeringApiDoc(config: IAdeOrganizationConfig): string {
	const totalTiers = config.ranks.length;
	return [
		'# Aexus ADE — Engineering CLI API Cookbook (`aexus-ade`)',
		'',
		`Current API Revision: **${ADE_API_LATEST_REVISION}** | Rank Hierarchy: \`L-1\` User → \`L0\` Secretary → \`L1\` highest → \`L${totalTiers}\` lowest`,
		'',
		'Paired with `./ENGINEERING_PARADIGM.md` (`aexus-ade docs read engineering`) and native rank docs `../ranks/L<tier>.md` (`aexus-ade docs read L<tier>`).',
		'',
		'## 1. Discovery & Verification Checks (All Staff, Including L4 Leaf Workers)',
		'```bash',
		'aexus-ade whoami --json               # Returns { id, tier, tierTag, missionId, nodeIds, currentTokenIds, department }',
		'aexus-ade rank names --json           # Live hot-reloadable rank & Mission aliases',
		`aexus-ade api update --since ${ADE_API_LATEST_REVISION} --scope all --json`,
		'aexus-ade mission check list --mission <id> [--node <nodeId>] --json',
		'aexus-ade mission check run --mission <id> [--node <nodeId>] [--id <checkId>] --json',
		'```',
		'',
		'## 2. Token Bus — Sliced Read, Return, Handoff, Reject, Block, Fail & Complete (All Staff)',
		'- **Shell-Safe Details & Automatic Idempotency**: Prefer `--detail - <<\'EOF\'` or `--detail-file <path>`; mutating CLI calls attach an automatic UUIDv4 `idempotencyKey` (override via `--idempotency-key <key>`).',
		'- **Atomic Task Sign-Off (`--complete-task`)**: On `token return` or `token complete`, pass `--complete-task` (plus `--files "p1,p2"` / `--artifact` when required by the task\'s `completionContract`) once `mission check run` passes and upstream tasks are completed.',
		'```bash',
		'aexus-ade token current [--mission <id>] [--full] --json',
		'aexus-ade token read <ptr1[,ptr2...]> [--mission <id>] [--token <tokenId>] [--toc | --summary-only] [--section "<Heading>"] [--max-chars <N>] [--offset <N> | --tail <N>] --json',
		'aexus-ade token history <tokenId> [--mission <id>] [--delta | --all] --json   # Default: compact cyclic delta; --all for full wave',
		'aexus-ade token return <tokenId> --summary "<1-line delivery>" [--complete-task] [--to <superiorNodeId>] [--task <T1> | --tasks <T1,T2>] [--detail - | --detail-file <path>] [--artifact "Title=Body"] [--decision "Title=Body"] [--whiteboard <wbId,...>] [--files <p1,p2>] [--mission <id>] --json',
		'aexus-ade token handoff <tokenId> --to <nodeId[,nodeId2]> --summary "<1-line headline>" [--task <T1> | --tasks <T1,T2>] [--detail - | --detail-file <path>] [--artifact "Title=Body"] [--decision "Title=Body"] [--whiteboard <wbId,...>] [--ref <ptr,...>] [--files <p1,p2>] [--mission <id>] --json',
		'aexus-ade token reject <tokenId> --reason "<rework feedback>" [--category <defect|spec|test|env|scope>] [--to <nodeId>] [--detail - | --detail-file <path>] [--whiteboard <wbId>] [--mission <id>] --json',
		'aexus-ade token complete <tokenId> --summary "<1-line outcome>" [--finish] [--complete-task] [--to <nodeId,...>] [--detail - | --detail-file <path>] [--whiteboard <wbId,...>] [--files <p1,p2>] [--mission <id>] --json',
		'aexus-ade token block <tokenId> --duration <30m|2h> --reason "<why>" [--watch-pid <pid>] [--watch-file <path>] [--host <alias>] [--mission <id>] --json',
		'aexus-ade token fail <tokenId> --reason "<root cause>" [--category <defect|spec|test|env|scope>] [--detail - | --detail-file <path>] [--mission <id>] --json',
		'```',
		'',
		'## 3. Downward Mint, Scoped Parallel Split, Join Barriers & Retry (Superiors)',
		'- **STOP TURN AFTER `--wait-join`**: Never `sleep` or poll after `token mint|split --wait-join`; runtime wakes you automatically on barrier convergence or `--deadline` expiry.',
		'```bash',
		'# Single downward sub-task (omit parentTokenId from User chat to adopt active root baton or start a new wave)',
		'aexus-ade token mint [parentTokenId] --to <subNodeId> --summary "<1-line subtask>" [--task <T1> | --tasks <T1,T2>] [--scope-paths "src/api/**"] [--detail - | --detail-file <path>] [--whiteboard <wbId>] [--wait-join] [--mission <id>] --json',
		'',
		'# Shell-safe multi-branch heterogeneous split with disjoint scopePaths + quorum/deadline options',
		'aexus-ade token split [parentTokenId] --wait-join [--join-mode all|any|quorum] [--quorum <k>] [--fail-fast] [--deadline 30m] [--conflict-policy reject|warn|allow] --mission <id> --json --branches-json - <<\'EOF\'',
		'[',
		'  {"toNodeId":"Backend","summary":"Implement API service","taskNodeId":"T2","scopePaths":["src/server/**"],"whiteboardIds":["WB_CONTRACT"]},',
		'  {"toNodeId":"Frontend","summary":"Build UI components","taskNodeId":"T3","scopePaths":["src/ui/**"],"whiteboardIds":["WB_CONTRACT"]}',
		']',
		'EOF',
		'',
		'# Retry a failed baton with updated guidance, or dispatch a root wave from CLI / L-1 / L0',
		'aexus-ade token retry <failedTokenId> [--guidance "<instructions>"] [--wait-join] [--mission <id>] --json',
		'aexus-ade orchestration dispatch --mission <id> --prompt "<1-line headline>" [--detail - | --detail-file <path>] [--task <T1> | --tasks <T1,T2>] [--to <nodeId>] [--whiteboard <wbId>] [--ref <ptr,...>] --json',
		'```',
		'',
		'## 4. Department Shared Whiteboards — TOC, Section Slicing & Targeted Upsert',
		'- Same-department staff read/write `<Dept>` boards; cross-department staff read boards attached via `--whiteboard <wbId>` (and `L1`/Executive/`dept=General` shared contract boards). Pass ONLY `--whiteboard <wbId>` pointers in tokens.',
		'```bash',
		'aexus-ade whiteboard list --mission <id> [--department "<Dept>"] --json',
		'aexus-ade whiteboard create --mission <id> --department "<Dept>" --title "<Title>" [--id <wbId>] [--content - | --file <path>] --json',
		'aexus-ade whiteboard read <wbId> --mission <id> [--toc | --summary-only] [--section "<Heading>"] [--max-chars <N>] [--offset <N> | --tail <N>] --json',
		'aexus-ade whiteboard write <wbId> --mission <id> [--section "<Heading>"] (--content - | --append - | --file <path> | --append-file <path> | --content "<md>" | --append "<md>") [--expected-version <n>] --json',
		'aexus-ade whiteboard rename <wbId> "<New Title>" [--department "<Dept>"] --mission <id> --json',
		'aexus-ade whiteboard remove <wbId> --mission <id> --json',
		'```',
		'',
		'## 5. Dynamic Runtime Staffing & Topology Authoring (Engineering Canvas Only)',
		'- Enforces immediate next-tier (`targetTier === callerTier + 1`) and same-department (`L1` may add `--new-department "<Dept>" --create-whiteboard`). Never use `session create` for canvas nodes.',
		'```bash',
		'aexus-ade orchestration staff create --mission <id> --name "<Name>" [--id <nodeId>] [--rank <L2..LN|rankId>] [--role "<Title>"] [--department|--new-department "<Dept>"] [--create-whiteboard] [--whiteboard-title "<Title>"] [--engine <e>] [--model <m>] [--thinking <lvl>] [--host <alias>] [--role-prompt "<boundary>"] [--allowed-paths "dir1,dir2"] [--color <hex|token>] [--bidirectional | --one-way] [--mint-token <parentTokId> | --handoff-token <tokId>] [--summary "<task>"] --json',
		'aexus-ade orchestration staff config --mission <id> --node <nodeId> [--engine <e>] [--model <m>] [--thinking <lvl>] [--host <alias>] [--role-prompt "<boundary>"] [--allowed-paths "dir1,dir2"] [--color <hex|token>] [--reset-session] --json',
		'aexus-ade orchestration staff rename --mission <id> --node <nodeId> "<New Name>" --json',
		'aexus-ade orchestration staff remove --mission <id> --node <nodeId> [--reason "<why>"] --json',
		'aexus-ade orchestration group <list|create|rename|assign|remove> --mission <id> ... --json',
		'aexus-ade orchestration edge <connect|label|remove> --mission <id> <fromId> <toId> [--bidirectional] [--label "<text>"] --json',
		'```',
		'',
		'## 6. Mission Task DAG, Dual-View Blueprints & Run Lifecycle',
		'- `mission blueprint apply --file <blueprint.md>` applies **both** the `## Mission Task DAG` (1st Mermaid block) and `## Orchestration Team` (2nd Mermaid block + `%% whiteboard`) plus `### <TaskId>` specifications in one command.',
		'- Hexagon gate nodes (`U1{{"..."}}`) require `L-1` User / `L0` Secretary `mission task complete --node U1` before downstream tasks can complete.',
		'```bash',
		'aexus-ade mission blueprint validate --file <blueprint.md> --json',
		'aexus-ade mission blueprint apply --mission <id> --file <blueprint.md>',
		'aexus-ade mission rename <id> "<New Title>"',
		'aexus-ade mission task list --mission <id> [--full] --json | mission task get --mission <id> --node <taskId> --json',
		'aexus-ade mission task create --mission <id> [--id <T1>] --title "<Title>" [--description "<spec>" | --file <path|->] [--after <upId>] [--owner <staffId>] [--assignee <staffId>] [--department "<Dept>"] [--min-tier <n>] [--require-checks] [--require-artifact] [--require-files] [--require-whiteboard <wbId,...>] [--min-summary <chars>] --json',
		'aexus-ade mission task update --mission <id> --node <taskId> [--title "<Title>"] [--description "<spec>" | --file <path|->] [--owner <staffId>] [--assignee <staffId>] [--min-tier <n>] [--require-checks] [--require-artifact] [--require-files] [--require-whiteboard <wbId,...>] [--min-summary <chars>] --json',
		'aexus-ade mission task set --mission <id> --node <taskId> (--description "<spec>" | --file <path|->) --json',
		'aexus-ade mission task edge <add|remove> --mission <id> <fromTaskId> <toTaskId> --json | mission task remove --mission <id> --node <taskId> --json',
		'aexus-ade mission task complete --mission <id> --node <taskId> [--note "<verification>"] --json',
		'aexus-ade mission diagnostics --mission <id> --json | mission checkpoint <list|create|diff|restore> --mission <id> [--label "<name>"] [--checkpoint|--id <id>] --json',
		'aexus-ade orchestration get --mission <id> [--raw] --json | orchestration status --mission <id> [--full] --json',
		'aexus-ade orchestration validate --file <orchestration.json|mjs|mmd> --json | orchestration load --mission <id> --file <orchestration.json|mjs|mmd> --json',
		'aexus-ade orchestration apply --mission <id> (--file <path> | --text "<mermaid>") --json',
		'aexus-ade orchestration export --mission <id> [--format json|mermaid] [--with-positions] [--raw] [--file <path>] --json',
		'aexus-ade orchestration layout set <lr|td|radial|grid> --mission <id> [--persist-in-code] --json',
		'aexus-ade orchestration pause|resume|abort --mission <id> [--reason "<why>"] --json',
		'aexus-ade orchestration limits --mission <id> [--max-hops <N|off>] [--budget <usd|off|inf>] [--silence <minutes|off>] [--total-cost <usd|off>] --json',
		'aexus-ade mission open --mission <id> [--view <orchestration|mission|both>] [--side]',
		'aexus-ade mission export --mission <id> [--format json|markdown] [--with-positions] [--file <path>] --json | mission import (--file <path> | --text "<json>") [--open] --json',
		'```',
		'',
	].join('\n');
}

/**
 * Renders the compact compatibility index (`docs/mission/MISSION_API.md`),
 * eliminating 3-way prose/command duplication by routing directly to `../engineering/`.
 */
export function renderMissionApiDoc(config: IAdeOrganizationConfig): string {
	const totalTiers = config.ranks.length;
	return [
		'# Aexus ADE — Engineering Dual-View API Reference (Compatibility Index)',
		'',
		`Current API Revision: **${ADE_API_LATEST_REVISION}** | Rank Hierarchy: \`L-1\` User → \`L0\` Secretary → \`L1\` highest → \`L${totalTiers}\` lowest`,
		'',
		'To keep agent context lean and single-source, Engineering Dual-View documentation lives in two focused manuals under sibling `../engineering/` (query paths anytime via `aexus-ade mission docs --json`):',
		'1. **Working Paradigm & Token Rules** (`../engineering/ENGINEERING_PARADIGM.md` → `aexus-ade docs read engineering`): Dual-View mental model, `[Aexus System · ...]` provenance envelopes, pointer-only context hygiene, downward `token mint|split --wait-join`, upward `token return [--complete-task]`, 3-mode `token reject`, Human Gate (`U1{{...}}`) sign-off, dynamic `orchestration staff create|remove`, and Whiteboard access rules.',
		'2. **Engineering CLI Cookbook** (`../engineering/ENGINEERING_API.md` → `aexus-ade docs read engineering-api`): Exact signatures and flags for `token`, `orchestration`, `mission task`, `mission check`, `mission blueprint`, and `whiteboard`.',
		'3. **Native Rank CLI Manual** (`../ranks/L<tier>.md` → `aexus-ade docs read L<tier>`): Native `session.*`, `org.*`, `project.*`, `host.*`, and `rank.*` commands.',
		'',
		'## Quick Entry Commands',
		'```bash',
		'aexus-ade whoami --json',
		'aexus-ade mission docs --json',
		'aexus-ade docs read engineering       # Read Working Paradigm & Token Rules',
		'aexus-ade docs read engineering-api   # Read Full CLI Command & Flag Cookbook',
		`aexus-ade api update --since ${ADE_API_LATEST_REVISION} --scope mission --json`,
		'```',
		'',
		'## Dual-View Mermaid Summary',
		'- **Mission Task DAG (`## Mission Task DAG`)**: Strictly acyclic `flowchart LR` of deliverables (`T1 --> T2`), `U1{{"Human Gate"}}` gates, `%% task T1 [owner=..., min_tier=..., dept=..., require_checks=true]`, and `%% check T1 [...]: <cmd>` (`mission diagnostics` / `mission checkpoint`).',
		'- **Orchestration Team (`## Orchestration Team`)**: Persistent cyclic all-staff topology (`1:1` unique employees, `<-->` review loops, `subgraph` departments, `%% staff <id> [role_prompt="...", paths="dir1|dir2"]`, `%% staff-check`, and `%% whiteboard` + `--toc`/`--section` sliced reads) — zero static task pre-prompts.',
		'',
	].join('\n');
}

function hashDocsConfigMeta(text: string): string {
	let h1 = 0x811c9dc5 ^ text.length;
	let h2 = 0x9e3779b9 ^ text.length;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 16777619);
		h2 = Math.imul(h2 ^ ch, 2654435761);
	}
	return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Generates the complete single-copy documentation bundle with a compact `api-manifest.json`.
 */
export function buildAdeDocsBundle(config: IAdeOrganizationConfig): IAdeDocsBundle {
	const sorted = [...config.ranks].sort((a, b) => a.tier - b.tier);
	const rankFiles: Record<string, string> = {
		[`${ADE_SECRETARY_TIER_TAG}.md`]: renderL0SecretaryDoc(config),
	};
	for (const rank of sorted) {
		rankFiles[`${formatTierTag(rank.tier)}.md`] = renderTierRankDoc(config, rank);
	}
	const engineeringFiles: Record<string, string> = {
		[ADE_DOCS_ENGINEERING_PARADIGM_FILE_NAME]: renderEngineeringParadigmDoc(config),
		[ADE_DOCS_ENGINEERING_API_FILE_NAME]: renderEngineeringApiDoc(config),
	};
	const slotsSig = ADE_WORK_TREE_SLOTS.map(slot => [slot, config.slots?.[slot] ?? '']);
	const rankStructuralSig = sorted.map(r => [r.tier, r.id, r.pureExecution ? 1 : 0, r.canHaveSubordinates ? 1 : 0, r.allowedApis]);
	const fullMetaHash = hashDocsConfigMeta(JSON.stringify({
		revision: ADE_API_LATEST_REVISION,
		missionName: config.missionName ?? '',
		slots: slotsSig,
		ranks: sorted.map(r => [r.tier, r.id, r.name, r.shortName, r.summary, r.initPrompt, r.defaultChildRankId ?? '', r.pureExecution ? 1 : 0, r.canHaveSubordinates ? 1 : 0, r.allowedApis]),
	}));
	const configFingerprint = `rev${ADE_API_LATEST_REVISION}#${JSON.stringify(rankStructuralSig)}#${fullMetaHash}`;
	const compactApis = ADE_API_SPEC_CATALOG.map(entry => ({
		id: entry.id,
		scope: entry.scope,
		addedInRevision: entry.addedInRevision,
		...(entry.modifiedInRevision !== undefined ? { modifiedInRevision: entry.modifiedInRevision } : {}),
		...(entry.deprecatedInRevision !== undefined ? { deprecatedInRevision: entry.deprecatedInRevision } : {}),
	}));
	const manifestJson = JSON.stringify({
		contractVersion: 1,
		currentRevision: ADE_API_LATEST_REVISION,
		rankCount: sorted.length,
		configFingerprint,
		apis: compactApis,
	}) + '\n';
	return {
		commonFile: renderCommonApiDoc(),
		manifestJson,
		rankFiles,
		engineeringFiles,
		missionFile: renderMissionApiDoc(config),
	};
}
