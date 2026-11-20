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
export const ADE_DOCS_MISSION_DIR_NAME = 'mission';
export const ADE_DOCS_MISSION_FILE_NAME = 'MISSION_API.md';
export const ADE_DOCS_MANIFEST_FILE_NAME = 'api-manifest.json';

export interface IAdeDocsPaths {
	readonly docsRoot: string;
	readonly commonDir?: string;
	readonly commonDoc?: string;
	readonly manifestFile?: string;
	readonly ranksDir: string;
	readonly missionDir: string;
	readonly missionDoc: string;
	readonly rankDocs: Readonly<Record<string, string>>;
}

export interface IAdeDocsBundle {
	readonly commonFile?: string;
	readonly manifestJson?: string;
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
 * - `<adeHome>/docs/common/COMMON_API.md` (universal base commands & immutable `api update`)
 * - `<adeHome>/docs/ranks/L0.md`, `L1.md`, ..., `L<N>.md`
 * - `<adeHome>/docs/mission/MISSION_API.md` (sibling directory alongside `ranks/` and `common/`)
 * - `<adeHome>/docs/api-manifest.json` (versioned revision manifest)
 */
export function buildAdeDocsPaths(adeHomeDir: string, rankCount: number): IAdeDocsPaths {
	const docsRoot = joinDocPath(adeHomeDir, ADE_DOCS_DIR_NAME);
	const commonDir = joinDocPath(docsRoot, ADE_DOCS_COMMON_DIR_NAME);
	const commonDoc = joinDocPath(commonDir, ADE_DOCS_COMMON_FILE_NAME);
	const manifestFile = joinDocPath(docsRoot, ADE_DOCS_MANIFEST_FILE_NAME);
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
	return { docsRoot, commonDir, commonDoc, manifestFile, ranksDir, missionDir, missionDoc, rankDocs };
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
		'- Global ADE assistant at **default Tier L0** (positioned directly beneath **User `L-1`** and above `L1..LN`).',
		'- Never switch workbench mode to IDE or touch IDE-only UI.',
		`- Current organization depth: **${tierCount} rank tier(s)** (\`L-1\` User → \`L0\` Secretary → \`L1\` highest → \`L${tierCount}\` lowest).`,
		'- Mission APIs live in the sibling folder `../mission/MISSION_API.md` — read it **only when working with a Mission** (note: only the session that owns a Mission, or User `L-1`, may operate that Mission).',
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
		`This document is the single shared API specification for **Tier ${tierTag}** (hierarchy depth: \`L-1\` User → \`L0\` Secretary → \`L1\` highest → \`L${totalTiers}\` lowest).`,
		'User-defined rank display aliases may change dynamically at runtime. Always rely on your tier index (`L<n>`) for protocol rules, and query live aliases anytime via:',
		'```bash',
		'aexus-ade rank names --json   # Returns live { L-1, L0, L1..LN } alias map',
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
			'## Global Base & On-Demand API Update',
			'```bash',
			'aexus-ade whoami --json',
			`aexus-ade api update --since ${ADE_API_LATEST_REVISION} --json`,
			'```',
			'',
			'## In-Graph Mission Token Commands (When Participating in a Mission)',
			'- Write plain, concrete human-readable summaries (key changes, file paths, results — no filler).',
			'- Strictly top-down comms: never send private messages upward to supervisors; report blockers via `token block` or failures via `token fail`.',
			'```bash',
			'aexus-ade token current --json',
			'aexus-ade token trace <tracePtr> --json',
			'aexus-ade token complete <tokenId> --summary "<concrete human summary>" --json',
			'aexus-ade token reject <tokenId> --reason "<specific defects>" [--target <nodeId>] --json',
			'aexus-ade token block <tokenId> --duration <10h|30m> --reason "<reason>" [--watch-pid <pid>] [--watch-file <path>] --json',
			'aexus-ade token fail <tokenId> --reason "<root cause>" --json',
			'```',
			'',
			'## Authorized Aexus-Code Primitive APIs',
			'- None outside Mission token reporting. Agents at this tier execute coding tasks directly in a clean native Coding Agent context without ADE orchestration APIs.',
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
		'## Global Base & Immutable API Update Diff',
		'```bash',
		'aexus-ade whoami --json',
		'aexus-ade docs read common',
		`aexus-ade api update --since ${ADE_API_LATEST_REVISION} --json`,
		'```',
		'',
		'## Off-Graph Supervision & Top-Down Communication (`org.*`)',
		'- Communication is strictly top-down: supervisors may message and pull conversation context from managed subordinates; subordinates cannot message upward.',
		'```bash',
		'aexus-ade org subordinates [--mission <id>] --json',
		'aexus-ade org send <nodeOrSessionId> "<directive>" [--mission <id>] [--wait] --json',
		'aexus-ade org context <nodeOrSessionId> [--limit 20] [--mission <id>] --json',
		'aexus-ade org escalate --reason "<reason>" [--node <nodeId>] [--token <tokenId>] [--mission <id>] --json',
		'```',
		'',
		'## In-Graph Mission Token Commands (When Assigned to a Mission Node)',
		'```bash',
		'aexus-ade token current --json | token trace <tracePtr> --json',
		'aexus-ade token complete <tokenId> --summary "<concrete human summary>" --json',
		'aexus-ade token reject <tokenId> --reason "<defects>" [--target <nodeId>] --json',
		'aexus-ade token block <tokenId> --duration <10h|30m> --reason "<reason>" [--watch-pid <pid>] [--watch-file <path>] --json',
		'aexus-ade token fail <tokenId> --reason "<root cause>" --json',
		'```',
		'',
		'## Authorized Aexus-Code Kernel Primitive APIs',
		'All permissions below are enforced at the Aexus-Code control kernel boundary:',
		...apiSpecs.map(spec => `- \`${spec.id}\` — ${spec.description}`),
		'',
		'## CLI Command Reference (`aexus-ade`)',
		...cliLines,
		'',
		...(hasMissionApis ? [
			'## Mission API Reference (Read On Demand)',
			'- When participating in or orchestrating a **Mission**, read the sibling specification `../mission/MISSION_API.md` (or run `aexus-ade docs read mission`).',
			'',
		] : []),
	].join('\n');
}

/**
 * Renders the single-copy unified Mission API documentation (`mission/MISSION_API.md`),
 * stored in a sibling folder right next to `ranks/` and `common/`, read ONLY on demand when working on a Mission.
 */
export function renderMissionApiDoc(config: IAdeOrganizationConfig): string {
	const totalTiers = config.ranks.length;
	return [
		'# Aexus ADE — Unified Mission API Reference',
		'',
		`Current API Revision: **${ADE_API_LATEST_REVISION}**`,
		'',
		'This document is the single shared specification for **Mission** Mermaid DAG workflows (`docs/mission/MISSION_API.md`, sibling to `docs/ranks/` and `docs/common/`).',
		'Read this file **only on demand** when creating, editing, inspecting, or operating a Mission. Check diffs anytime via `aexus-ade api update --since <rev> --scope mission --json`.',
		'',
		'## Core Architecture Rules',
		'- **Unified Mission Mode**: All engineering and research tasks converge into one flat Mermaid DAG workflow.',
		`- **Factory Wall (Off-Graph vs In-Graph)**: Hierarchy \`L-1\` User → \`L0\` Secretary → \`L1\` highest → \`L${totalTiers}\` lowest (depth ${totalTiers}). Tiers \`<= offGraphMaxTier\` are strictly off-graph supervisors (never occupy DAG task nodes); tiers \`> offGraphMaxTier\` work inside the DAG. No tier may span both sides.`,
		'- **Plain-Text Token Bus**: Only plain-text tokens travel across edges (`last_summary` + rolling `compressed_history` + expandable `trace_ptr`). Code/data sync across local & SSH Cloud Hosts is performed directly by agents via Git/SCP/Rsync.',
		'- **Dual-Polarity Edges**: Regular edges trigger on `token complete`; fail edges (`-->|fail|`, `-.->|on_fail|`, `A -- fail --> B`, plus synonyms `error`, `fallback`, `recover`) trigger automatically on `token fail` without waking supervisors.',
		'- **Join Barrier & Anti-Deadlock**: Forked branches share a `wave_id`; join nodes wait only for active upstream branches belonging to that wave (untaken success/fail branches are automatically marked skipped).',
		'- **Watchdog Daemon & `blocked`**: Silence timeout (default 5m) locks upon Mission start. Long-running tasks call `token block` with optional local/remote PID-exit or file-ready early wakeup.',
		'- **Safe Jurisdiction Recall & Anti-Dangling Patch**: Only off-graph supervisors may recall/patch unfinished regions within their jurisdiction. Deleting the sole incoming path to a non-source downstream node without atomically providing a replacement path is strictly rejected; out-of-jurisdiction edits/recalls must escalate upward.',
		'- **Zero-Token Source Triggers**: `inDegree = 0` source nodes support `once`, `interval`, `cron`, and `event` (`file_created`, `file_changed`, `git_updated`, `gpu_idle`) triggers.',
		'',
		'## Mission CLI Commands (`aexus-ade mission ...`)',
		'```bash',
		'# Discovery, Docs & Blueprint',
		'aexus-ade docs read mission',
		'aexus-ade mission docs --json | mission list [--project <path>] --json',
		'aexus-ade mission init [--owner <id>] [--title "<name>"] [--open]',
		'aexus-ade mission open --mission <id> [--side]',
		'aexus-ade mission blueprint get --mission <id> [--raw]',
		'aexus-ade mission blueprint validate (--file <path> | --text "<mermaid>") --json',
		'aexus-ade mission blueprint apply --mission <id> --file <path>',
		'aexus-ade mission remove --mission <id>',
		'',
		'# Lifecycle, Factory Boundary & Human Gates',
		'aexus-ade mission boundary get|set --mission <id> [--off-graph-max-tier <k>] [--supervisors-json <json>] --json',
		'aexus-ade mission start --mission <id> [--timeout <minutes>] --json',
		'aexus-ade mission timeout --mission <id> --minutes <n> --json',
		'aexus-ade mission pause|resume|stop|status --mission <id> --json',
		'aexus-ade mission gate approve|reject --mission <id> --node <gateId> [--note "<text>"] [--rollback <nodeId>] --json',
		'',
		'# Jurisdiction Recall & Atomic Safe Patch (Off-Graph Supervisors Only)',
		'aexus-ade mission recall --mission <id> [--nodes <N1,N2>] [--branch <nodeId>] [--reason "<reason>"] --json',
		'aexus-ade mission patch --mission <id> (--file <path> | --text "<mermaid>") [--reason "<reason>"] --json',
		'',
		'# Source Triggers (inDegree = 0) & Cloud Host Binding',
		'aexus-ade mission trigger list --mission <id> --json',
		'aexus-ade mission trigger set --mission <id> --node <nodeId> --kind <once|interval|cron|event> [--delay <10m>|--interval <30m>|--cron "0 2 * * *"|--event-type <file_created|file_changed|git_updated|gpu_idle> --target <pathOrHost>] --json',
		'aexus-ade mission trigger remove --mission <id> --trigger <triggerId> --json',
		'aexus-ade mission host bind --mission <id> --node <nodeId> --host <local|sshAlias> [--path <remoteDir>] --json',
		'```',
		'',
		'## Mermaid DAG Format (`mission.mmd`)',
		'- Define flat, non-nested DAG topology (`flowchart LR` / `graph TD`) with task nodes (`N1["Title"]`), gate nodes (`G1{{"Gate"}}`), and fail edges (`N1 -->|fail| N_Fallback`).',
		'- Reuse the same employee across positions with `@Name: Task`, `:::Name`, or `class N1,N3 Name`.',
		'',
	].join('\n');
}

/**
 * Generates the complete single-copy documentation bundle (`common/COMMON_API.md` + `ranks/L0..LN.md` + `mission/MISSION_API.md` + `api-manifest.json`).
 */
export function buildAdeDocsBundle(config: IAdeOrganizationConfig): IAdeDocsBundle {
	const sorted = [...config.ranks].sort((a, b) => a.tier - b.tier);
	const rankFiles: Record<string, string> = {
		[`${ADE_SECRETARY_TIER_TAG}.md`]: renderL0SecretaryDoc(config),
	};
	for (const rank of sorted) {
		rankFiles[`${formatTierTag(rank.tier)}.md`] = renderTierRankDoc(config, rank);
	}
	const manifestJson = JSON.stringify({
		contractVersion: 1,
		currentRevision: ADE_API_LATEST_REVISION,
		rankCount: sorted.length,
		apis: ADE_API_SPEC_CATALOG,
	}, null, 2) + '\n';
	return {
		commonFile: renderCommonApiDoc(),
		manifestJson,
		rankFiles,
		missionFile: renderMissionApiDoc(config),
	};
}
