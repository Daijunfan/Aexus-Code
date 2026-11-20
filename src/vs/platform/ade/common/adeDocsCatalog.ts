/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ADE_PRIMITIVE_APIS,
	IAdeOrganizationConfig,
	IAdeRankDefinition,
	renderAllowedPrimitiveApiLines,
} from './adeRoleSchema.js';
import { ADE_SECRETARY_TIER_TAG, formatTierTag } from './adeRankResize.js';

export const ADE_DOCS_DIR_NAME = 'docs';
export const ADE_DOCS_RANKS_DIR_NAME = 'ranks';
export const ADE_DOCS_MISSION_DIR_NAME = 'mission';
export const ADE_DOCS_MISSION_FILE_NAME = 'MISSION_API.md';

export interface IAdeDocsPaths {
	readonly docsRoot: string;
	readonly ranksDir: string;
	readonly missionDir: string;
	readonly missionDoc: string;
	readonly rankDocs: Readonly<Record<string, string>>;
}

export interface IAdeDocsBundle {
	readonly rankFiles: Readonly<Record<string, string>>;
	readonly missionFile: string;
}

function joinDocPath(base: string, ...parts: readonly string[]): string {
	const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	const cleanBase = base.replace(/[\\/]+$/, '');
	return [cleanBase, ...parts.map(p => p.replace(/^[\\/]+|[\\/]+$/g, ''))].join(sep);
}

/**
 * Computes canonical single-copy documentation paths under `<adeHome>/docs/`:
 * - `<adeHome>/docs/ranks/L0.md`, `L1.md`, ..., `L<N>.md`
 * - `<adeHome>/docs/mission/MISSION_API.md` (sibling directory alongside `ranks/`)
 */
export function buildAdeDocsPaths(adeHomeDir: string, rankCount: number): IAdeDocsPaths {
	const docsRoot = joinDocPath(adeHomeDir, ADE_DOCS_DIR_NAME);
	const ranksDir = joinDocPath(docsRoot, ADE_DOCS_RANKS_DIR_NAME);
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
	return { docsRoot, ranksDir, missionDir, missionDoc, rankDocs };
}

/**
 * Renders the single-copy L0 (Secretary) API reference document.
 * Strictly tier-indexed (L0) and alias-agnostic; live user aliases are queried via `aexus-ade rank names --json`.
 */
export function renderL0SecretaryDoc(config: IAdeOrganizationConfig): string {
	const tierCount = config.ranks.length;
	return [
		'# Aexus ADE API Reference — Tier L0 (Secretary)',
		'',
		'This document is the single shared API specification for **Tier L0 (Secretary)**.',
		'User-defined rank aliases (`L1`..`LN`) can hot-update at runtime — always query live names via `aexus-ade rank names --json` instead of assuming fixed labels.',
		'',
		'## Scope & Authority',
		'- Sovereign global macro-control across **ADE** (projects, cloud hosts, sessions, ranks, Missions, and Inbox).',
		'- Never switch workbench mode to IDE or touch IDE-only UI.',
		`- Current organization depth: **${tierCount} rank tier(s)** (\`L1\` highest → \`L${tierCount}\` lowest; \`L0\` sits above \`L1\`).`,
		'- Mission APIs live in the sibling folder `../mission/MISSION_API.md` — read it **only when working with a Mission**.',
		'',
		'## Live Rank & Alias Query APIs (Hot-Reload Safe)',
		'```bash',
		'aexus-ade rank names --json                      # Instant { L0, L1..LN } current alias map',
		'aexus-ade rank list --json                       # Full L0 + L1..LN permissions, pure flags & doc paths',
		'aexus-ade rank get <L0|L1..LN|id> --json         # Inspect a specific tier',
		'aexus-ade rank docs [L0|L1..LN|mission] --json   # Canonical single-copy doc file paths',
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
		'## Sessions, Hierarchy & Inbox',
		'```bash',
		'aexus-ade engine list --json',
		'aexus-ade session list [--project <p>] [--parent <id|root>] [--role <tierOrId>] [--status <s>] --json',
		'aexus-ade session info <id> --json | session tree [id] --json | session subordinates [id] [--recursive] --json',
		'aexus-ade session create [--project <p>] [--engine <e>] [--title <t>] [--parent <id>] [--role <tierOrId>] [--no-open]',
		'aexus-ade session send <id> "<prompt>" [--wait] | session history <id> [--limit <n>] --json',
		'aexus-ade session role <id> <L1..LN|rankId|none> | session move <id> <parentId|none> | session rename <id> "<title>"',
		'aexus-ade session stop <id> | archive <id> | unarchive <id> | detach <id> | delete <id> [--force]',
		'aexus-ade inbox list [--unread-only] --json | inbox post --from <id> --message "<text>" | inbox mark-read <id|--all> | inbox resolve --id <id>',
		'aexus-ade secretary [status | open | engine <e> | send "<prompt>" [--wait] | history | stop]',
		'```',
		'',
		'## Mission Orchestration (Read On Demand)',
		'- Read `../mission/MISSION_API.md` when initializing, inspecting, designing, or controlling a **Mission**.',
		'',
	].join('\n');
}

/**
 * Renders the single-copy tier documentation `ranks/L<tier>.md`.
 * Strictly tier-based (`L1`, `L2`, ..., `LN`) — completely decoupled from user-customizable display aliases!
 */
export function renderTierRankDoc(config: IAdeOrganizationConfig, rank: IAdeRankDefinition): string {
	const tierTag = formatTierTag(rank.tier);
	const totalTiers = config.ranks.length;
	const lowerTierTag = rank.tier < totalTiers ? formatTierTag(rank.tier + 1) : undefined;
	const higherTierTag = rank.tier > 1 ? formatTierTag(rank.tier - 1) : ADE_SECRETARY_TIER_TAG;

	const header = [
		`# Aexus ADE API Reference — Tier ${tierTag}`,
		'',
		`This document is the single shared API specification for **Tier ${tierTag}** (hierarchy depth: \`L1\` highest → \`L${totalTiers}\` lowest; \`L0\` is Secretary).`,
		'User-defined rank display aliases may change dynamically at runtime. Always rely on your tier index (`L<n>`) for protocol rules, and query live aliases anytime via:',
		'```bash',
		'aexus-ade rank names --json   # Returns live { L0, L1..LN } alias map',
		'aexus-ade rank list --json    # Returns live hierarchy & permissions',
		'```',
		'',
		'## Tier Position & Capabilities',
		`- **Tier**: \`${tierTag}\` (machine ID: \`${rank.id}\`)`,
		`- **Immediate Upper Tier**: \`${higherTierTag}\``,
		`- **Immediate Lower Tier**: ${lowerTierTag ? `\`${lowerTierTag}\`` : 'None (lowest tier)'}`,
		`- **Can Supervise Subordinates**: ${rank.canHaveSubordinates ? 'Yes' : 'No'}`,
		`- **Pure Execution Mode**: ${rank.pureExecution ? 'Yes (0 ADE prompt/API injection — pure native Coding Agent execution)' : 'No (orchestrated ADE agent)'}`,
		'',
	];

	if (rank.pureExecution || rank.allowedApis.length === 0) {
		return [
			...header,
			'## Authorized Aexus-Code Primitive APIs',
			'- None. Agents at this tier execute coding tasks directly in a clean native Coding Agent context without ADE orchestration APIs.',
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

	const hasMissionApis = rank.allowedApis.some(api => api.startsWith('engineering.'));

	return [
		...header,
		'## Authorized Aexus-Code Kernel Primitive APIs',
		'All permissions below are enforced at the Aexus-Code control kernel boundary:',
		...apiSpecs.map(spec => `- \`${spec.id}\` — ${spec.description}`),
		'',
		'## CLI Command Reference (`aexus-ade`)',
		...cliLines,
		'',
		...(hasMissionApis ? [
			'## Mission API Reference (Read On Demand)',
			'- When participating in or orchestrating a **Mission**, read the sibling specification `../mission/MISSION_API.md` (or run `aexus-ade mission docs --json` to locate it).',
			'',
		] : []),
	].join('\n');
}

/**
 * Renders the single-copy unified Mission API documentation (`mission/MISSION_API.md`),
 * stored in a sibling folder right next to `ranks/` and read ONLY on demand when working on a Mission.
 */
export function renderMissionApiDoc(config: IAdeOrganizationConfig): string {
	const totalTiers = config.ranks.length;
	return [
		'# Aexus ADE — Unified Mission API Reference',
		'',
		'This document is the single shared specification for **Mission** orchestration (`docs/mission/MISSION_API.md`, sibling to `docs/ranks/`).',
		'Read this file **only on demand** when creating, editing, inspecting, or executing a Mission.',
		'',
		'## Concepts',
		'- **Mission** is the single unified multi-agent DAG work-tree abstraction in Aexus Code (replacing any legacy Engineering/Research split).',
		`- A Mission coordinates across the configured tier hierarchy (\`L1\` highest → \`L${totalTiers}\` lowest; \`L0\` is Secretary).`,
		'- Rank display aliases are user-configurable and hot-reloadable. Query live tier names anytime via `aexus-ade rank names --json`.',
		'',
		'## Core Mission CLI Commands (`aexus-ade mission ...`)',
		'```bash',
		'# Discovery & Docs',
		'aexus-ade mission docs --json',
		'aexus-ade mission list [--project <path>] --json',
		'aexus-ade mission status --governor <L1-session-id> [--node <nodeId>] --json',
		'',
		'# Initialize, Open & Design',
		'aexus-ade mission init --governor <L1-session-id> [--on-children <relocate|delete> --target <id>] [--open]',
		'aexus-ade mission open --governor <L1-session-id> [--side]',
		'aexus-ade mission blueprint get --governor <L1-session-id> [--raw]',
		'aexus-ade mission blueprint validate (--file <path> | --text "<markdown>") --json',
		'aexus-ade mission blueprint apply --governor <L1-session-id> --file <path> [--force-stop-running]',
		'aexus-ade mission configure --governor <L1-session-id> [--node <nodeId>|--all] [--role <worker|employee|manager|all>] [--engine <e>] [--model <m>] [--thinking <off|low|medium|high|max>] [--isolation <shared|worktree>]',
		'',
		'# Execution Lifecycle (User / L0 Secretary authorized)',
		'aexus-ade mission run --governor <L1-session-id>',
		'aexus-ade mission pause --governor <L1-session-id>',
		'aexus-ade mission resume --governor <L1-session-id>',
		'aexus-ade mission stop --governor <L1-session-id>',
		'aexus-ade mission reset --governor <L1-session-id> [--node <nodeId>] [--keep-completed]',
		'aexus-ade mission remove --governor <L1-session-id>',
		'',
		'# Reviews, Diffs, Reports & Human Gates',
		'aexus-ade mission diff --governor <L1-session-id> --node <nodeId> --json',
		'aexus-ade mission reports --governor <L1-session-id> --json',
		'aexus-ade mission review --governor <L1-session-id> --node <nodeId> --role <employee|manager> --verdict <pass|reject|guidance> [--report "<text>"] [--feedback "<text>"]',
		'aexus-ade mission gate --governor <L1-session-id> --node <nodeId> --verdict <pass|rollback> [--target-node <upstreamNodeId>] [--feedback "<text>"]',
		'aexus-ade mission watchdog-action --governor <L1-session-id> --node <nodeId> --action <remind|kill-restart> [--message "<text>"]',
		'```',
		'',
		'## Blueprint Format (`blueprint.md`)',
		'- Define DAG topology in a fenced `mermaid` (`flowchart LR`) block with task nodes (`N1["Title"]`) and optional human acceptance gates (`U1{{"Gate"}}`).',
		'- Declare optional node `files:` scope, `verify:` deterministic check commands, `max_concurrency`, and `workspace_isolation: shared | worktree`.',
		'- Always validate with `aexus-ade mission blueprint validate` before applying.',
		'',
	].join('\n');
}

/**
 * Generates the complete single-copy documentation bundle (`ranks/L0.md..L<N>.md` + `mission/MISSION_API.md`).
 */
export function buildAdeDocsBundle(config: IAdeOrganizationConfig): IAdeDocsBundle {
	const sorted = [...config.ranks].sort((a, b) => a.tier - b.tier);
	const rankFiles: Record<string, string> = {
		[`${ADE_SECRETARY_TIER_TAG}.md`]: renderL0SecretaryDoc(config),
	};
	for (const rank of sorted) {
		rankFiles[`${formatTierTag(rank.tier)}.md`] = renderTierRankDoc(config, rank);
	}
	return {
		rankFiles,
		missionFile: renderMissionApiDoc(config),
	};
}
