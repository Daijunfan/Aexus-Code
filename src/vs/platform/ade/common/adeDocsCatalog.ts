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
 * - `<adeHome>/docs/mission/MISSION_API.md` (sibling directory alongside `ranks/` and `engineering/`)
 * - `<adeHome>/docs/api-manifest.json` (versioned revision manifest)
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
 * Renders the single-copy L0 (Secretary) Native Rank API reference document.
 * Strictly tier-indexed (L0) and alias-agnostic; live user aliases are queried via `aexus-ade rank names --json`.
 * Engineering working paradigm & Engineering CLI live in the sibling `../engineering/` folder.
 */
export function renderL0SecretaryDoc(config: IAdeOrganizationConfig): string {
	const tierCount = config.ranks.length;
	return [
		'# Aexus ADE Native Rank API Reference — Tier L0 (Secretary)',
		'',
		'This document is the single shared **Native Rank** CLI API specification for **Tier L0 (Secretary)** (`docs/ranks/L0.md`).',
		'User-defined rank aliases (`L1`..`LN`) can hot-update at runtime — always query live names via `aexus-ade rank names --json` instead of assuming fixed labels.',
		'',
		'## Scope & Authority',
		'- Global ADE assistant at **default Tier L0** (positioned directly beneath **User `L-1`** and above `L1..LN`).',
		'- Never switch workbench mode to IDE or touch IDE-only UI.',
		`- Current organization depth: **${tierCount} rank tier(s)** (\`L-1\` User → \`L0\` Secretary → \`L1\` highest → \`L${tierCount}\` lowest).`,
		'- Engineering Dual-View working rules & CLI APIs live in the sibling folder `../engineering/` (and unified `../mission/MISSION_API.md`) — read them **only when working with an Engineering workspace**.',
		'',
		'## Live Rank, Docs & Alias Query APIs (Hot-Reload Safe)',
		'```bash',
		'aexus-ade whoami --json',
		'aexus-ade docs read <common|L0|L1..LN|engineering|engineering-api|mission|manifest>',
		`aexus-ade api update --since ${ADE_API_LATEST_REVISION} --json`,
		'aexus-ade rank names --json                      # Instant { L-1, L0, L1..LN } current alias map',
		'aexus-ade rank list --json                       # Full L-1 + L0 + L1..LN permissions, pure flags & doc paths',
		'aexus-ade rank get <L-1|L0|L1..LN|id> --json     # Inspect a specific tier',
		'aexus-ade rank docs [common|L0..LN|engineering|engineering-api|mission] --json',
		'aexus-ade rank rename <L1..LN> "<alias>" [--short <tag>]',
		'aexus-ade rank set-count <N>                     # Resize rank ladder (N >= 1)',
		'```',
		'',
		'## Viewport, Projects & Cloud Hosts',
		'```bash',
		'aexus-ade status --json',
		'aexus-ade view [status | --archived <true|false|toggle> | --inspector <changes|files|hide> | --refresh] --json',
		'aexus-ade project list --json',
		'aexus-ade project add <path|host:/path...> [--name <label>]',
		'aexus-ade project select <target> | focus <target> | home | forward | remove <target>',
		'aexus-ade project changes [target] --json | files [target] [--path <subpath>] [--depth <n>] --json',
		'aexus-ade project open-file <file> [--project <target>] [--side] | open-diff <file> [--project <target>]',
		'aexus-ade host list --json | host info <alias> --json | host test <alias> --json | host browse <alias> [--path <dir>]',
		'```',
		'',
		'## Native Sessions, Hierarchy, Top-Down Org & Inbox',
		'```bash',
		'aexus-ade engine list --json',
		'aexus-ade session list [--project <p>] [--parent <id|root>] [--role <tierOrId>] [--status <s>] --json',
		'aexus-ade session info <id> --json | session tree [id] --json | session subordinates [id] [--recursive] --json',
		'aexus-ade session create [--project <p>] [--engine <e>] [--title <t>] [--parent <id>] [--role <tierOrId>] [--no-open]',
		'aexus-ade session send <id> "<prompt>" [--wait] | session history <id> [--limit <n>] --json',
		'aexus-ade session role <id> <L1..LN|rankId|none> | session move <id> <parentId|none> | session rename <id> "<title>"',
		'aexus-ade session stop <id> | archive <id> | unarchive <id> | detach <id> | delete <id> [--force]',
		'aexus-ade org subordinates [--mission <id>] --json | org context <id> [--limit 20] --json | org send <id> "<directive>" [--wait] --json',
		'aexus-ade inbox list [--unread-only] --json | inbox post --from <id> --message "<text>" | inbox mark-read <id|--all> | inbox resolve --id <id>',
		'aexus-ade secretary [status | open | engine <e> | send "<prompt>" [--wait] | history | stop]',
		'```',
		'',
		'## Engineering Dual-View Docs (Sibling Folder — Read On Demand)',
		'- Working Paradigm & Token Rules: `../engineering/ENGINEERING_PARADIGM.md` (`aexus-ade docs read engineering`)',
		'- Engineering CLI API Cookbook: `../engineering/ENGINEERING_API.md` (`aexus-ade docs read engineering-api`)',
		'- Unified Engineering/Mission Reference: `../mission/MISSION_API.md` (`aexus-ade docs read mission`)',
		'',
	].join('\n');
}

/**
 * Renders the single-copy **Native Rank** tier documentation `docs/ranks/L<tier>.md`.
 * Strictly tier-based (`L1`, `L2`, ..., `LN`) — completely decoupled from user-customizable display aliases
 * AND cleanly separated from Engineering working paradigm docs (which live in sibling `docs/engineering/`).
 */
export function renderTierRankDoc(config: IAdeOrganizationConfig, rank: IAdeRankDefinition): string {
	const tierTag = formatTierTag(rank.tier);
	const totalTiers = config.ranks.length;
	const lowerTierTag = rank.tier < totalTiers ? formatTierTag(rank.tier + 1) : undefined;
	const higherTierTag = rank.tier > 1 ? formatTierTag(rank.tier - 1) : ADE_SECRETARY_TIER_TAG;

	const header = [
		`# Aexus ADE Native Rank API Reference — Tier ${tierTag}`,
		'',
		`This document is the single shared **Native Rank** CLI API specification for **Tier ${tierTag}** (\`docs/ranks/${tierTag}.md\`).`,
		`Hierarchy depth: \`L-1\` User → \`L0\` Secretary → \`L1\` highest → \`L${totalTiers}\` lowest.`,
		'User-defined rank display aliases may change dynamically at runtime. Always rely on your numeric tier (`L<n>`) for protocol rules, and query live aliases anytime via:',
		'```bash',
		'aexus-ade rank names --json   # Returns live { L-1, L0, L1..LN } alias map',
		'aexus-ade rank list --json    # Returns live hierarchy, permissions & doc paths',
		'```',
		'',
		'## Tier Position & Native Capabilities',
		`- **Tier**: \`${tierTag}\` (machine ID: \`${rank.id}\`)`,
		`- **Immediate Upper Tier**: \`${higherTierTag}\``,
		`- **Immediate Lower Tier**: ${lowerTierTag ? `\`${lowerTierTag}\`` : 'None (lowest tier)'}`,
		`- **Can Supervise Subordinates**: ${rank.canHaveSubordinates ? 'Yes' : 'No'}`,
		`- **Pure Execution Mode (Outside Engineering)**: ${rank.pureExecution ? 'Yes (100% clean native Coding Agent context — zero ADE management APIs)' : 'No (orchestrated ADE rank)'}`,
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
			'- **None.** Outside Engineering, sessions at this tier execute coding tasks directly in a 100% clean native Coding Agent context with zero ADE management APIs.',
			'',
			'## Engineering Dual-View Docs (Sibling Folder — Read On Demand)',
			'- When participating as staff inside an **Engineering** workspace, read the sibling working paradigm and token rules:',
			'  - Working Paradigm & Token Rules: `../engineering/ENGINEERING_PARADIGM.md` (`aexus-ade docs read engineering`)',
			'  - Engineering CLI API Cookbook (Token & Whiteboard section): `../engineering/ENGINEERING_API.md` (`aexus-ade docs read engineering-api`)',
			'  - Unified Reference: `../mission/MISSION_API.md` (`aexus-ade docs read mission`)',
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

	const hasMissionApis = rank.allowedApis.some(api => api.startsWith('mission.'));

	return [
		...header,
		'## Universal Base & Immutable API Update Diff',
		'```bash',
		'aexus-ade whoami --json',
		'aexus-ade docs read common',
		`aexus-ade api update --since ${ADE_API_LATEST_REVISION} --json`,
		'```',
		'',
		'## Native Top-Down Supervision & Direct Inspection (`org.*` / `session.*`)',
		'- Communication is strictly **top-down**: superiors may inspect subordinate conversation context, send direct directives, and create/delete lower-tier sessions inside their own subordinate subtree; subordinates cannot message upward.',
		'- **Inside an Engineering workspace**: these native rank APIs remain preserved as superior escape hatches for exceptional inspection or emergency recovery, while routine task delegation and delivery MUST flow through **Engineering baton tokens** (see `../engineering/ENGINEERING_PARADIGM.md`).',
		'```bash',
		'aexus-ade org subordinates [--mission <id>] --json',
		'aexus-ade org context <nodeOrSessionId> [--limit 20] [--mission <id>] --json',
		'aexus-ade org send <nodeOrSessionId> "<directive>" [--mission <id>] [--wait] --json',
		'aexus-ade org escalate --reason "<reason>" [--node <nodeId>] [--token <tokenId>] [--mission <id>] --json',
		'```',
		'',
		'## Authorized Native Kernel Primitive APIs',
		'All permissions below are enforced at the Aexus-Code control kernel boundary:',
		...apiSpecs.map(spec => `- \`${spec.id}\` — ${spec.description}`),
		'',
		'## Native Rank CLI Command Reference (`aexus-ade`)',
		...cliLines,
		'',
		'## Engineering Dual-View Docs (Sibling Folder — Read On Demand)',
		'- Engineering working paradigm, token rules, dynamic staffing, and Task DAG verification live in the **sibling folder `../engineering/`** (kept cleanly separate from this Native Rank CLI manual):',
		'  - Working Paradigm & Token Rules: `../engineering/ENGINEERING_PARADIGM.md` (`aexus-ade docs read engineering`)',
		'  - Engineering CLI API Cookbook: `../engineering/ENGINEERING_API.md` (`aexus-ade docs read engineering-api`)',
		...(hasMissionApis
			? ['  - Unified Engineering/Mission Reference: `../mission/MISSION_API.md` (`aexus-ade docs read mission`)']
			: ['  - Unified Reference: `../mission/MISSION_API.md` (`aexus-ade docs read mission`)']),
		'',
	].join('\n');
}

/**
 * Renders the single-copy **Engineering Dual-View Working Paradigm & Token Rules** document
 * (`docs/engineering/ENGINEERING_PARADIGM.md`), stored in a sibling folder right next to `docs/ranks/`.
 */
export function renderEngineeringParadigmDoc(config: IAdeOrganizationConfig): string {
	const totalTiers = config.ranks.length;
	return [
		'# Aexus ADE — Engineering Dual-View Working Paradigm & Token Rules',
		'',
		`Current API Revision: **${ADE_API_LATEST_REVISION}**`,
		'',
		'This document (`docs/engineering/ENGINEERING_PARADIGM.md`, sibling to `docs/ranks/` and `docs/common/`) defines **how all roles collaborate inside an Engineering workspace**.',
		'Every staff member inside Engineering works with **two complementary manuals**:',
		'1. **Native Rank CLI Manual** (`../ranks/L<tier>.md` → `aexus-ade docs read L<tier>`) — your tier authority and native `session.*` / `org.*` / `project.*` / `host.*` capabilities.',
		'2. **Engineering Working Paradigm & API Cookbook** (this file → `aexus-ade docs read engineering`, plus `./ENGINEERING_API.md` → `aexus-ade docs read engineering-api`) — token rules, dual-view workflow, dynamic staffing, and Task DAG verification.',
		'',
		'---',
		'',
		'## 1. Dual-View Architecture (Staff Topology vs. Task Progress)',
		'- **Orchestration View (All-Staff Cyclic Topology)**:',
		'  - Models your persistent organization chart (departments/groups, reporting lines, and peer feedback loops).',
		'  - **Zero off-graph isolation wall**: every participating rank (`L1`..`L' + totalTiers + '`) sits on the same canvas with **strict 1-to-1 employee uniqueness** (each employee appears at most once).',
		'  - Supports arbitrary cycles and bidirectional edges (`<-->`). Staff stay alive after passing a token and re-wake seamlessly when new tokens arrive.',
		'  - **NO Task Pre-Prompts**: do NOT rely on static per-node task prompts. All task specifications, review feedback, and deliverables flow dynamically via **baton tokens and lightweight pointers**.',
		'- **Mission View (Strictly Acyclic Task DAG)**:',
		'  - Models global engineering progress as a strictly acyclic DAG of deliverable tasks (`T1 --> T2 --> T3`).',
		'  - Tasks bind bidirectionally to Orchestration tokens and staff (`--task <taskId>`), giving live status/assignee/artifact visibility while reserving `completed` marking for explicit superior verification.',
		`- **Rank Hierarchy**: \`L-1\` User → \`L0\` Secretary → \`L1\` highest → \`L${totalTiers}\` lowest (query live display aliases via \`aexus-ade rank names --json\`).`,
		'',
		'## 2. System Message Provenance Envelopes (Recognizing Message Sources)',
		'The Aexus-Code runtime automatically wraps incoming messages with a standardized provenance header so you NEVER confuse a baton token, a superior role message, and a direct Human User message:',
		'- **`[Aexus System · Baton Token]`**: This turn is a **system-validated Baton Token** (or 5-minute baton reminder), NOT a direct chat message from the User. Execute the work and explicitly advance the baton via `aexus-ade token mint|split|return|handoff|complete|block|fail`.',
		'- **`[Aexus System · Direct Message from Role]`**: This turn is a **direct top-down message from a superior ADE Role** (`org.send` / `session.send`) — NOT from the Human User and NOT a baton token. Follow the superior\'s guidance while keeping routine baton progression on tokens.',
		'- **`[Aexus System · Message from User (L-1)]`**: This turn is a **direct message from the sovereign Human User (`L-1`)** — NOT a baton token and NOT from another agent role. Prioritize and answer the User directly.',
		'',
		'## 3. Token Submission, Kernel Validation & Lightweight Pointer Hygiene',
		'- **Core Kernel Validation**: Every token action is submitted via CLI (`aexus-ade token ...`) and validated by the Aexus-Code core kernel before dispatching to any target employee:',
		'  1. Required fields present & well-formed (`tokenId`, non-empty `--summary` / `--reason`, valid target node(s)).',
		'  2. Active holder ownership (caller actually holds the live token).',
		'  3. Strict directionality & graph/hierarchy rules (see Section 3).',
		'  4. Any configured automated verification gates (`%% staff-check`) pass before delivery/completion.',
		'- **Lightweight Pointer Discipline (NEVER inline large payloads)**:',
		'  - Keep `--summary` to a crisp **1-line headline (`<= 160` chars)**.',
		'  - Pass detailed specs, logs, or reports via `--detail "<full spec>"`, `--artifact "Title=Body"`, `--decision "Title=Body"`, or `--whiteboard <wbId>`.',
		'  - The runtime stores full bodies behind compact typed pointers (`hop-N`, `art-N`, `dec-N`, `wb:<id>`) and externalizes large/cold blobs automatically.',
		'  - Every token carries a pointer-indexed flow history (`hopLog`) and manifest (`contextRefs`). On cyclic re-entry, the delta cursor shows only new/updated pointers since your previous visit — dereference only what you need with `aexus-ade token read <ptr1,ptr2>` and inspect full lineage with `aexus-ade token history <tokenId> --all`.',
		'',
		'## 4. Token Directionality, Heterogeneous Mint/Split & Join Barriers',
		'- **End-to-End Ideal Flow**: The User (`L-1`) sends a direct requirement message (`[Aexus System · Message from User (L-1)]`) to the highest-rank role (`L1`), then steps back. `L1` decomposes the work into Mission Task DAG nodes and immediately mints/splits distinct sub-task tokens strictly downward (`aexus-ade token split --mission <id> --branches-json [...]` or `aexus-ade token mint --mission <id> --to <subNodeId> --summary "..."` — omitting `<parentTokenId>` automatically creates a root wave + parent token held by you with zero duplicate self-dispatch!); middle tiers (`L2`, `L3`, ...) execute or further split downward; results return upward along provenance for review and Task DAG sign-off; finally `L1` closes the root wave (`token complete <rootTokId> --finish --summary "..."`) which delivers a completion report to the User\'s ADE Inbox.',
		'- **Rule A — Strict Downward Minting (`token mint` / `token split`)**:',
		'  - Newly minted sub-task tokens may ONLY be sent **strictly downward** to lower-tier subordinates (`targetTier > callerTier`).',
		'  - **Subordinates NEVER mint new tokens upward to a superior.**',
		'  - Authorized superiors can omit `<parentTokenId>` to start a fresh root wave immediately after receiving a User chat message, or pass an existing `<parentTokenId>` to fork further sub-tasks within the active wave.',
		'  - Use `token mint` to issue heterogeneous sub-tasks one by one while keeping your parent token active, or `token split --branches-json [...]` to fan out multiple distinct sub-tasks atomically (each with its own target, `--summary`, `--detail`, and `--task <taskId>`).',
		'  - Pass `--wait-join` (default on `token split`) to suspend your parent token on a **convergence join barrier** — the kernel automatically re-wakes you with a consolidated summary of every branch as soon as all child tokens return (or settle).',
		'- **Rule B — Upward Return Along Provenance (`token return`)**:',
		'  - The ONLY way a subordinate sends a token upward to a superior is by **returning a token it received from that superior** (`aexus-ade token return <tokenId> --summary "<delivery>" [--detail ...] [--artifact ...]`).',
		'  - Returning settles the parent join barrier (if waiting) and wakes the dispatching superior to verify the work and mark the corresponding Mission Task DAG node `completed`.',
		'- **Rule C — Peer / Cyclic Relay (`token handoff` / `token complete`)**:',
		'  - Use `token handoff` along connected Orchestration edges for peer collaboration, review ping-pong, or multi-stage relay (passing lightweight `--whiteboard` / `--ref` pointers).',
		'  - Use `token complete ... --finish` only when concluding a root wave or terminal handoff.',
		'- **Rule D — Blocking, Failure & 5-Minute Silence Reminder**:',
		'  - Long-running builds/experiments MUST call `token block <tokenId> --duration <30m|2h> --reason "<why>" [--watch-pid <pid>] [--watch-file <path>]` to pause routine nudges and wake early on completion.',
		'  - Unrecoverable failures MUST call `token fail <tokenId> --reason "<root cause>"` so the superior and Task DAG reflect the failure immediately.',
		'  - While holding an active (non-blocked) token, silence triggers an automatic reminder every **5 minutes** (suppressed while paused).',
		'',
		'## 5. Dynamic Runtime Staffing & In-Flight Token Reclamation',
		'- During live execution, authorized superiors may dynamically recruit (`orchestration staff create`) or remove (`orchestration staff remove`) staff under **two hard invariants**:',
		'  1. **No Rank-Skipping**: you may ONLY create or remove **immediate next-tier subordinates** (`targetTier === callerTier + 1`).',
		'  2. **No Cross-Department Changes**: you may ONLY create or remove staff inside **your own department**.',
		'- **In-Flight Token Lifecycle on Staff Removal**:',
		'  - Removing a staff member aborts their active turn, automatically reclaims all active/blocked/waiting tokens they hold back to their dispatching superior (or cancels unclaimed root tokens), settles any waiting join barriers cleanly, and records full audit history so zero tasks are silently lost.',
		'',
		'## 6. Mission Task DAG Progress & Per-Node Completion Authority',
		'- Authorized top-tier and mid-tier superiors can dynamically create, update, remove, and rewire Task DAG nodes (`aexus-ade mission task create|update|remove|edge`) at runtime.',
		'- **Automatic Live Sync (Never Auto-Completes)**: dispatching, handing off, blocking, failing, or returning a token bound via `--task <taskId>` automatically updates that Task DAG node\'s live status (`in_progress` / `blocked` / `failed`), current assignee, active tokens, elapsed metrics, and artifact pointers — but **never auto-marks `completed`**.',
		'- **Explicit Superior Sign-Off (`mission task complete`)**: after verifying a subordinate\'s returned token, an authorized superior marks the Task DAG node `completed`. The kernel enforces BOTH:',
		'  1. **Per-Node Completion Authority**: caller must satisfy the node\'s `owner` / `completers` / `min_tier` policy (or be the direct superior of the node\'s assignee / top rank / User `L-1`).',
		'  2. **Hard Upstream Dependency Gate**: ALL upstream prerequisite Task DAG nodes must already be `completed` before a downstream task can be marked `completed`.',
		'',
		'## 7. Coexistence with Native Rank APIs (`org.*` / `session.*`)',
		'- All native rank CLI APIs documented in sibling `../ranks/L<tier>.md` (e.g., `org context`, `org send`, `org subordinates`, `session history`, `session create|delete`) remain **100% preserved and functional**.',
		'- **Conflict-Avoidance Etiquette**: Because direct `org send` / `session send` bypasses token lineage, join barriers, reminders, and Task DAG binding, **do NOT use them for routine task delegation inside Engineering**. Keep normal work strictly on **tokens**, and invoke native `org context` / `org send` / `session.*` sparingly only when genuinely necessary (diagnosing a stuck subordinate, inspecting full session history, or handling emergencies).',
		'',
		'## 8. Department Shared Whiteboards, Code-as-Orchestration & Headless Daemon',
		'- **Department Shared Whiteboards**: store living specs, schemas, and shared notes on department whiteboards (`whiteboard create|read|write`) and pass ONLY `--whiteboard <wbId>` pointers in tokens.',
		'- **Code-as-Orchestration**: version-control your staff topology, per-role boundaries (`rolePrompt`, `allowedPaths`, automated `checks`, `engineId`/`model`/`hostAlias`), whiteboards, and Task DAG in a project `.json` / `.mjs` / `.mmd` manifest and apply via `orchestration validate|load|export --format json`.',
		'- **Main-Process Daemon Continuity**: Orchestration state, cold blob storage, and pause/resume/abort controls persist in the main-process daemon so multi-agent runs survive window reloads.',
		'',
		'## Next Step',
		'- For exact CLI command signatures and flags, read `./ENGINEERING_API.md` (`aexus-ade docs read engineering-api`).',
		'- For your tier\'s native capabilities and escape-hatch commands, read `../ranks/L<tier>.md` (`aexus-ade docs read L<tier>`).',
		'',
	].join('\n');
}

/**
 * Renders the role-grouped **Engineering CLI API Cookbook** (`docs/engineering/ENGINEERING_API.md`),
 * stored alongside `ENGINEERING_PARADIGM.md` in sibling folder `docs/engineering/`.
 */
export function renderEngineeringApiDoc(config: IAdeOrganizationConfig): string {
	const totalTiers = config.ranks.length;
	return [
		'# Aexus ADE — Engineering CLI API Cookbook (`aexus-ade`)',
		'',
		`Current API Revision: **${ADE_API_LATEST_REVISION}** | Rank Hierarchy: \`L-1\` User → \`L0\` Secretary → \`L1\` highest → \`L${totalTiers}\` lowest`,
		'',
		'This document (`docs/engineering/ENGINEERING_API.md`) is the concise command reference paired with `./ENGINEERING_PARADIGM.md` (`aexus-ade docs read engineering`).',
		'For native rank APIs (`session.*`, `org.*`, `project.*`, `host.*`, `rank.*`), read sibling `../ranks/L<tier>.md` (`aexus-ade docs read L<tier>`).',
		'',
		'## 1. Discovery & Identity (All Staff)',
		'```bash',
		'aexus-ade whoami --json',
		'aexus-ade docs read engineering       # Engineering Working Paradigm & Token Rules',
		'aexus-ade docs read engineering-api   # This Engineering CLI Cookbook',
		'aexus-ade docs read L<tier>           # Your Native Rank CLI API manual (docs/ranks/L<tier>.md)',
		'aexus-ade rank names --json           # Live hot-reloadable rank display aliases',
		`aexus-ade api update --since ${ADE_API_LATEST_REVISION} --scope all --json`,
		'```',
		'',
		'## 2. Token Bus — Inspect, Return, Handoff, Block & Fail (All Staff)',
		'```bash',
		'aexus-ade token current [--mission <id>] --json',
		'aexus-ade token read <ptr1[,ptr2...]> [--mission <id>] [--token <tokenId>] --json',
		'aexus-ade token history <tokenId> [--mission <id>] [--all] --json',
		'aexus-ade token return <tokenId> --summary "<1-line delivery>" [--to <superiorNodeId>] [--detail "<report>"] [--artifact "Title=Body"] [--decision "Title=Body"] [--whiteboard <wbId>] [--mission <id>] --json',
		'aexus-ade token handoff <tokenId> --to <nodeId[,nodeId2]> --summary "<1-line headline>" [--detail "<round body>"] [--task <taskId>] [--artifact "Title=Body"] [--decision "Title=Body"] [--whiteboard <wbId,...>] [--ref <ptr,...>] [--mission <id>] --json',
		'aexus-ade token complete <tokenId> --summary "<1-line headline>" [--detail "<round body>"] [--to <nodeId,...> | --finish] [--whiteboard <wbId,...>] [--mission <id>] --json',
		'aexus-ade token block <tokenId> --duration <30m|2h> --reason "<why>" [--watch-pid <pid>] [--watch-file <path>] [--host <alias>] [--mission <id>] --json',
		'aexus-ade token fail <tokenId> --reason "<root cause>" [--mission <id>] --json',
		'```',
		'',
		'## 3. Downward Sub-Task Minting, Heterogeneous Splitting & Join Barriers (Superiors)',
		'- **Direct User Chat -> Instant Token Split (No Pre-Existing Parent Token Required!)**: When the Human User (`L-1`) chats directly with an authorized superior (such as the top-rank `L1` lead), omit `<parentTokenId>` — `token mint` / `token split` automatically creates a root wave + parent token owned by you (no duplicate self-dispatch!) and dispatches child tokens strictly downward.',
		'```bash',
		'# Mint a single sub-task token downward (omit parentTokenId to start a fresh root wave from User chat, or pass parentTokenId to fork from an active baton)',
		'aexus-ade token mint [parentTokenId] --to <subNodeId> --summary "<1-line subtask>" [--detail "<full spec>"] [--task <taskId>] [--artifact "Title=Body"] [--decision "Title=Body"] [--whiteboard <wbId>] [--wait-join] [--mission <id>] --json',
		'',
		'# Atomically split into N heterogeneous downward sub-task tokens with a join barrier (default --wait-join; parentTokenId optional for authorized superiors)',
		'aexus-ade token split [parentTokenId] --branches-json \'[{"toNodeId":"Sub1","summary":"...","detail":"...","taskNodeId":"T1"},{"toNodeId":"Sub2","summary":"...","taskNodeId":"T2"}]\' [--join-mode all|any] [--no-wait-join] [--mission <id>] --json',
		'',
		'# Dispatch an initial requirement wave onto the Orchestration root from outside chat (User L-1 / Secretary / CLI)',
		'aexus-ade orchestration dispatch --mission <id> --prompt "<1-line headline>" [--detail "<full spec>"] [--task <taskId>] [--artifact "Title=Body"] [--decision "Title=Body"] [--to <nodeId>] [--whiteboard <wbId>] --json',
		'```',
		'',
		'## 4. Department Shared Whiteboards (Lightweight Pointer Passing & Optimistic Concurrency)',
		'```bash',
		'aexus-ade whiteboard list --mission <id> [--department "<Dept>"] --json',
		'aexus-ade whiteboard create --mission <id> --department "<Dept>" --title "<Title>" [--id <wbId>] [--content "<markdown>"] --json',
		'aexus-ade whiteboard read <wbId> --mission <id> --json',
		'aexus-ade whiteboard write <wbId> --mission <id> (--content "<markdown>" | --append "<markdown>") [--expected-version <n>] --json',
		'aexus-ade whiteboard rename <wbId> "<New Title>" [--department "<Dept>"] --mission <id> --json',
		'aexus-ade whiteboard remove <wbId> --mission <id> --json',
		'```',
		'',
		'## 5. Dynamic Runtime Staffing & Topology Authoring (Authorized Superiors)',
		'- Enforces **immediate next-tier only** (no rank-skipping) and **same department only** (no cross-department changes). Removing staff automatically reclaims in-flight tokens, re-parents surviving child tokens, and settles join barriers.',
		'```bash',
		'aexus-ade orchestration staff create --mission <id> --name "<Name>" [--id <nodeId>] [--rank <L2..LN|rankId>] [--role "<Title>"] [--department "<Dept>"] [--engine <e>] [--model <m>] [--thinking <lvl>] [--host <alias>] [--role-prompt "<boundary>"] [--allowed-paths "dir1,dir2"] [--color <hex|token>] [--bidirectional | --one-way] [--mint-token <parentTokId> | --handoff-token <tokId>] [--summary "<task>"] --json',
		'aexus-ade orchestration staff config --mission <id> --node <nodeId> [--engine <e>] [--model <m>] [--thinking <lvl>] [--host <alias>] [--role-prompt "<boundary>"] [--allowed-paths "dir1,dir2"] [--color <hex|token>] [--reset-session] --json',
		'aexus-ade orchestration staff rename --mission <id> --node <nodeId> "<New Name>" --json',
		'aexus-ade orchestration staff remove --mission <id> --node <nodeId> [--reason "<why>"] --json',
		'aexus-ade orchestration group <list|create|rename|assign|remove> --mission <id> ... --json',
		'aexus-ade orchestration edge <connect|label|remove> --mission <id> <fromId> <toId> [--bidirectional] [--label "<text>"] --json',
		'```',
		'',
		'## 6. Mission Task DAG Authoring & Per-Node Verification (Authorized Superiors)',
		'```bash',
		'aexus-ade mission task list --mission <id> --json',
		'aexus-ade mission task get --mission <id> --node <taskId> --json',
		'aexus-ade mission task create --mission <id> [--id <T1>] --title "<Title>" [--description "<spec>"] [--after <upTaskId>] [--owner <staffId>] [--assignee <staffId>] [--department "<Dept>"] [--min-tier <n>] --json',
		'aexus-ade mission task update --mission <id> --node <taskId> [--title "<Title>"] [--description "<spec>"] [--owner <staffId>] [--assignee <staffId>] [--min-tier <n>] --json',
		'aexus-ade mission task remove --mission <id> --node <taskId> --json',
		'aexus-ade mission task edge <add|remove> --mission <id> <fromTaskId> <toTaskId> --json',
		'aexus-ade mission task set --mission <id> --node <taskId> --description "<detailed task spec>" --json',
		'aexus-ade mission task complete --mission <id> --node <taskId> [--note "<verification>"] --json   # Enforces per-node authority & upstream DAG completion',
		'```',
		'',
		'## 7. Code-as-Orchestration Manifests, Live Run Controls & Lossless Migration',
		'```bash',
		'aexus-ade orchestration get --mission <id> [--raw] --json',
		'aexus-ade orchestration status --mission <id> --json',
		'aexus-ade orchestration validate --file <orchestration.json|mjs|mmd> --json',
		'aexus-ade orchestration load --mission <id> --file <orchestration.json|mjs|mmd> --json',
		'aexus-ade orchestration apply --mission <id> (--file <path> | --text "<mermaid>") --json',
		'aexus-ade orchestration export --mission <id> [--format json|mermaid] [--with-positions] [--raw] [--file <path>] --json',
		'aexus-ade orchestration import --mission <id> (--file <path> | --text "<mermaid>") --json',
		'aexus-ade orchestration layout set <lr|td|radial|grid> --mission <id> [--persist-in-code] --json',
		'aexus-ade orchestration pause|resume|abort --mission <id> [--reason "<why>"] --json',
		'aexus-ade mission open --mission <id> [--view <orchestration|mission|both>] [--side]',
		'aexus-ade mission export --mission <id> [--with-positions] [--file <path>] --json',
		'aexus-ade mission import [--owner <id>] [--project <path>] (--file <path> | --text "<json>") [--open] --json',
		'```',
		'',
		'## 8. Native Rank Escape-Hatch APIs (Use Sparingly Inside Engineering)',
		'- Superiors retain full access to native `org subordinates|context|send` and `session.*` commands from sibling `../ranks/L<tier>.md`.',
		'- Reserve them for exceptional diagnostics or emergency intervention; keep routine work strictly on baton tokens above.',
		'',
	].join('\n');
}

/**
 * Renders the single-copy unified Mission/Engineering API documentation (`docs/mission/MISSION_API.md`),
 * stored in a sibling folder right next to `ranks/`, `engineering/`, and `common/`.
 */
export function renderMissionApiDoc(config: IAdeOrganizationConfig): string {
	const totalTiers = config.ranks.length;
	return [
		'# Aexus ADE — Engineering Dual-View API Reference (Mission DAG + Cyclic Orchestration)',
		'',
		`Current API Revision: **${ADE_API_LATEST_REVISION}**`,
		'',
		'This document is the unified Engineering & Mission specification (`docs/mission/MISSION_API.md`, sibling to `docs/ranks/`, `docs/engineering/`, and `docs/common/`).',
		'- For the dedicated **Working Paradigm & Token Rules**, read `../engineering/ENGINEERING_PARADIGM.md` (`aexus-ade docs read engineering`).',
		'- For the role-grouped **Engineering CLI API Cookbook**, read `../engineering/ENGINEERING_API.md` (`aexus-ade docs read engineering-api`).',
		'- For **Native Rank CLI APIs** (`session.*`, `org.*`, `project.*`, `host.*`), read `../ranks/L<tier>.md` (`aexus-ade docs read L<tier>`).',
		'- Check API diffs anytime via `aexus-ade api update --since <rev> --scope mission --json`.',
		'',
		'## Core Architecture Rules',
		'- **Dual-View Engineering Split**: Every Engineering workspace has two sibling views:',
		'  1. **Mission View (Task DAG)**: Strictly acyclic Mermaid DAG where every node is a concrete **Task** with an editable description, optional per-node completion permissions (`owner`, `assignee`, `dept`, `min_tier`, `completers`), and live Orchestration token/assignee/artifact binding. Authorized superiors mark tasks `completed` via `aexus-ade mission task complete` ONLY after all upstream prerequisites are completed.',
		'  2. **Orchestration View (All-Staff Cyclic Collaboration)**: Zero off-graph isolation wall — ALL ranks enter the same canvas. Strict 1-to-1 employee uniqueness (each employee appears at most once). Arbitrary cycles and bidirectional edges (`<-->`) are supported. **NO task pre-prompts**: pass task instructions and context exclusively via baton tokens and lightweight pointers. Employees stay alive after handing off tokens and re-wake seamlessly on future arrivals.',
		'- **Strict Directionality, Active Minting & Join Barriers**: Newly minted sub-task tokens (`token mint` / `token split [--wait-join]`) may ONLY be sent strictly downward to lower-tier subordinates. Subordinates NEVER mint upward — they return completed received batons upward via `token return`, automatically settling any waiting join barrier and waking their superior once all branches converge.',
		'- **Pointer-Native Baton Tokens & Cyclic Re-Entry Delta Cursor**: Every token carries a 1-line headline (`<= 160` chars), a compact pointer-indexed hop history ledger (`hopLog`), and a typed pointer manifest (`contextRefs`: per-hop `hop-N`, split `art-N` artifacts, `dec-N` decisions, and mutable `wb:<id>` department whiteboards) with ZERO duplicated body text. Large/cold blobs are automatically externalized to disk and transparently readable via `aexus-ade token read <ptr1,ptr2>`.',
		'- **5-Minute Repeating Silence Reminder**: Holding an active baton triggers an automatic reminder every **5 minutes** if silent (suppressed while paused). Employees must explicitly hand off, return, or complete tokens when finishing a stage.',
		'- **Dynamic Runtime Staffing (No Rank-Skipping, No Cross-Department)**: Superiors (L1, L2, ...) can dynamically recruit (`orchestration staff create`) or remove (`orchestration staff remove`) immediate next-tier subordinates inside their own department. Removing an employee automatically reclaims all in-flight tokens and settles waiting join barriers.',
		'- **Code-as-Orchestration Manifests**: Teams can version-control structured JSON or JS/MJS orchestration definitions (including `rolePrompt`, `allowedPaths`, automated `checks`, `engineId`, `model`, `thinking`, `hostAlias`, whiteboards, and Task DAG) and validate/load/export them via CLI (`orchestration validate|load|export --format json`).',
		'- **Department Shared Whiteboards (Lightweight Pointer Passing)**: Create/read/write shared department whiteboards (`aexus-ade whiteboard create|list|read|write`). Tokens MUST stay lightweight — pass ONLY `--whiteboard <wbId>` pointer references, NEVER full whiteboard text.',
		`- **Rank Hierarchy**: \`L-1\` User → \`L0\` Secretary → \`L1\` highest → \`L${totalTiers}\` lowest (depth ${totalTiers}).`,
		'- **Native Rank API Coexistence**: All native rank APIs (`org.*` / `session.*` in `../ranks/L<tier>.md`) remain preserved as superior escape hatches; reserve them for exceptions so routine collaboration stays on tokens.',
		'- **Watchdog Daemon, Main-Process Continuity & `blocked`**: Long-running tasks may call `token block` with optional local/remote PID-exit or file-ready early wakeup. Pause/resume/abort and status/blob inspection stay available via main-process daemon even across window reloads.',
		'',
		'## Engineering CLI Commands (`mission`, `orchestration`, `token`, `whiteboard`)',
		'```bash',
		'# Mission View (Strictly Acyclic Task DAG — Dynamic Authoring & Per-Node Completion Authority)',
		'aexus-ade mission task list --mission <id> --json',
		'aexus-ade mission task get --mission <id> --node <taskId> --json',
		'aexus-ade mission task create --mission <id> [--id <T1>] --title "<Title>" [--description "<spec>"] [--after <T0>] [--owner <staffId>] [--assignee <staffId>] [--department <Dept>] [--min-tier <n>] --json',
		'aexus-ade mission task update --mission <id> --node <taskId> [--title "<Title>"] [--description "<spec>"] [--owner <staffId>] [--assignee <staffId>] [--min-tier <n>] --json',
		'aexus-ade mission task remove --mission <id> --node <taskId> --json',
		'aexus-ade mission task edge <add|remove> --mission <id> <fromTaskId> <toTaskId> --json',
		'aexus-ade mission task set --mission <id> --node <taskId> --description "<detailed task spec>" --json',
		'aexus-ade mission task complete --mission <id> --node <taskId> [--note "<verification>"] --json   # Enforces per-node authority & upstream DAG dependencies',
		'',
		'# Orchestration View (All-Staff Cyclic Graph, Code-as-Orchestration Manifests, Staffing & Run Controls)',
		'aexus-ade orchestration get --mission <id> [--raw] --json',
		'aexus-ade orchestration validate --file <orchestration.json|mjs|mmd> --json',
		'aexus-ade orchestration load --mission <id> --file <orchestration.json|mjs|mmd> --json',
		'aexus-ade orchestration apply --mission <id> (--file <path> | --text "<mermaid>") --json',
		'aexus-ade orchestration export --mission <id> [--format mermaid|json] [--with-positions] [--raw] [--file <path>] --json',
		'aexus-ade orchestration import --mission <id> (--file <path> | --text "<mermaid>") --json',
		'aexus-ade orchestration layout set <lr|td|radial|grid> --mission <id> [--persist-in-code] --json',
		'aexus-ade orchestration group <list|create|rename|assign|remove> --mission <id> ... --json',
		'aexus-ade orchestration staff <create|rename|config|remove> --mission <id> ... --json',
		'aexus-ade orchestration edge <connect|label|remove> --mission <id> <fromId> <toId> ... --json',
		'aexus-ade orchestration status --mission <id> --json',
		'aexus-ade orchestration pause|resume|abort --mission <id> [--reason "<why>"] --json',
		'aexus-ade orchestration dispatch --mission <id> --prompt "<1-line headline>" [--detail "<full spec>"] [--task <taskId>] [--artifact "Title=Body"] [--decision "Title=Body"] [--to <nodeId>] [--whiteboard <wbId>] --json',
		'',
		'# Pointer-Native Relay Baton Token Bus (Mint/Split/Join, Return & Handoff)',
		'aexus-ade token current [--mission <id>] --json',
		'aexus-ade token history <tokenId> [--mission <id>] [--all] --json',
		'aexus-ade token read <ptr1[,ptr2...]> [--mission <id>] [--token <tokenId>] --json',
		'aexus-ade token mint <parentTokenId> --to <subNodeId> --summary "<subtask headline>" [--detail "<spec>"] [--task <taskId>] [--wait-join] [--mission <id>] --json',
		'aexus-ade token split <parentTokenId> --branches-json \'[{"toNodeId":"Sub1","summary":"...","taskNodeId":"T1"},{"toNodeId":"Sub2","summary":"...","taskNodeId":"T2"}]\' [--no-wait-join] [--mission <id>] --json',
		'aexus-ade token return <tokenId> --summary "<1-line delivery>" [--to <superiorNodeId>] [--detail "<report>"] [--artifact "Title=Body"] [--decision "Title=Body"] [--whiteboard <wbId>] [--mission <id>] --json',
		'aexus-ade token handoff <tokenId> --to <nodeId[,nodeId2]> --summary "<1-line headline>" [--detail "<round body>"] [--task <taskId>] [--artifact "Title=Body"] [--decision "Title=Body"] [--whiteboard <wbId,...>] [--ref <ptr,...>] [--mission <id>] --json',
		'aexus-ade token complete <tokenId> --summary "<1-line headline>" [--detail "<round body>"] [--to <nodeId,...> | --finish] [--whiteboard <wbId,...>] [--mission <id>] --json',
		'aexus-ade token fail <tokenId> --reason "<why>" [--mission <id>] --json',
		'aexus-ade token block <tokenId> --duration <30m|2h> --reason "<why>" [--watch-pid <pid>] [--watch-file <path>] --json',
		'',
		'# Department Shared Whiteboards (Lightweight Pointers & Lossless `%% wb-body` Sync)',
		'aexus-ade whiteboard list --mission <id> [--department "<Dept>"] --json',
		'aexus-ade whiteboard create --mission <id> --department "<Dept>" --title "<Title>" [--id <wbId>] [--content "<markdown>"] --json',
		'aexus-ade whiteboard read <wbId> --mission <id> --json',
		'aexus-ade whiteboard write <wbId> --mission <id> (--content "<markdown>" | --append "<markdown>") [--expected-version <n>] --json',
		'aexus-ade whiteboard rename <wbId> "<New Title>" [--department "<Dept>"] --mission <id> --json',
		'aexus-ade whiteboard remove <wbId> --mission <id> --json',
		'',
		'# Discovery, Blueprint, Lossless Bundle Migration & Lifecycle',
		'aexus-ade docs read engineering | docs read engineering-api | docs read mission',
		'aexus-ade mission docs --json | mission list [--project <path>] --json',
		'aexus-ade mission init [--owner <id>] [--title "<name>"] [--open]',
		'aexus-ade mission export --mission <id> [--with-positions] [--file <path>] --json',
		'aexus-ade mission import [--owner <id>] [--project <path>] (--file <path> | --text "<json>") [--open] --json',
		'aexus-ade mission open --mission <id> [--view <mission|orchestration|both>] [--side]',
		'aexus-ade mission blueprint get --mission <id> [--raw]',
		'aexus-ade mission blueprint validate (--file <path> | --text "<mermaid>") --json',
		'aexus-ade mission blueprint apply --mission <id> --file <path>',
		'aexus-ade mission remove --mission <id>',
		'```',
		'',
		'## Mermaid Format Reference (Mission Task DAG vs. Orchestration Topology)',
		'- **Mission Task DAG (`mission.mmd`)**: Strictly acyclic `flowchart LR` / `graph TD` defining engineering tasks (`T1["API Spec"] --> T2["Core Engine"]`), optional per-node completion metadata (`%% task T1 [owner=Lead, min_tier=2, dept=Backend]`), and optional zero-cost deterministic checks (`%% check T1 [timeout=90s]: pnpm test`).',
		'- **Orchestration Staff Topology (`orchestration.mmd` / `.json` / `.mjs`)**: Persistent all-staff cyclic graph (`%% staff S1 [role=L2, dept=Backend, engine=aexus-claude]`, `%% staff-prompt`, `%% staff-paths`, `%% staff-check`), bidirectional edges (`<-->`), department `subgraph` groups, and `%% whiteboard` + `%% wb-body` notes — NO task pre-prompts; context flows via baton tokens.',
		'',
	].join('\n');
}

/**
 * Generates the complete single-copy documentation bundle:
 * - `common/COMMON_API.md`
 * - `ranks/L0..LN.md` (pure Native Rank CLI APIs)
 * - `engineering/ENGINEERING_PARADIGM.md` & `ENGINEERING_API.md` (sibling Engineering docs)
 * - `mission/MISSION_API.md` (unified Engineering/Mission reference)
 * - `api-manifest.json`
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
	const configFingerprint = sorted.map(r => `${r.tier}:${r.id}:${r.pureExecution ? '1' : '0'}:${r.canHaveSubordinates ? '1' : '0'}:${r.allowedApis.join(',')}`).join('|');
	const manifestJson = JSON.stringify({
		contractVersion: 1,
		currentRevision: ADE_API_LATEST_REVISION,
		rankCount: sorted.length,
		configFingerprint,
		apis: ADE_API_SPEC_CATALOG,
	}, null, 2) + '\n';
	return {
		commonFile: renderCommonApiDoc(),
		manifestJson,
		rankFiles,
		engineeringFiles,
		missionFile: renderMissionApiDoc(config),
	};
}
