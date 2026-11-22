/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Single-source versioned ADE API specification registry & forever-immutable `api update` diff engine.
 *
 * Design guarantee (`mission_plan.md` Principle 5):
 * The signature and response contract of `aexus-ade api update [--since <rev>] [--scope <scope>] --json`
 * is frozen forever so any agent at any tier (`L0..LN`) can lazily discover API additions, modifications,
 * or deprecations since the last revision it read.
 */

export type AdeApiDocScope = 'common' | 'in_graph' | 'off_graph' | 'mission';

export interface IAdeApiChangeRecord {
	readonly id: string;
	readonly scope: AdeApiDocScope;
	readonly command: string;
	readonly summary: string;
	readonly addedInRevision: number;
	readonly modifiedInRevision?: number;
	readonly deprecatedInRevision?: number;
	readonly replacement?: string;
	readonly changeNote?: string;
}

export interface IAdeApiUpdateDiffResult {
	readonly contractVersion: 1;
	readonly currentRevision: number;
	readonly sinceRevision: number;
	readonly scope: string;
	readonly upToDate: boolean;
	readonly added: readonly IAdeApiChangeRecord[];
	readonly modified: readonly IAdeApiChangeRecord[];
	readonly deprecated: readonly IAdeApiChangeRecord[];
}

export const ADE_API_LATEST_REVISION = 4;

export const ADE_API_SPEC_CATALOG: readonly IAdeApiChangeRecord[] = [
	// ---- Revision 1: Base ADE Core ----
	{
		id: 'common.rank.names',
		scope: 'common',
		command: 'aexus-ade rank names --json',
		summary: 'Query live hot-reloadable { L-1, L0, L1..LN } rank display aliases and Mission alias.',
		addedInRevision: 1,
	},
	{
		id: 'common.rank.list',
		scope: 'common',
		command: 'aexus-ade rank list --json',
		summary: 'Inspect configured rank ladder, permissions, pure flags, and single-source doc paths.',
		addedInRevision: 1,
	},
	{
		id: 'off_graph.session.manage',
		scope: 'off_graph',
		command: 'aexus-ade session list|info|tree|create|send|history|stop --json',
		summary: 'Manage subordinate sessions, inspect histories, and coordinate projects/hosts.',
		addedInRevision: 1,
	},
	{
		id: 'mission.blueprint',
		scope: 'mission',
		command: 'aexus-ade mission init|list|open|blueprint get|validate|apply|remove',
		summary: 'Create, open, validate, apply Mermaid DAG blueprints, and remove Missions.',
		addedInRevision: 1,
		modifiedInRevision: 2,
		changeNote: 'Extended Mermaid edge syntax to support explicit fail-trigger edges (e.g. `-->|fail|`).',
	},

	// ---- Revision 2: Single-Source Docs, Immutable `api update`, Pure-Text Token Engine & Watchdog ----
	{
		id: 'common.whoami',
		scope: 'common',
		command: 'aexus-ade whoami --json',
		summary: 'Query own session ID (`id`), numeric tier (`tier`, `tierTag`), `factorySide`, `missionId`, `nodeIds`, `managedNodeIds`, `currentTokenIds`, and `latestApiRevision`.',
		addedInRevision: 2,
	},
	{
		id: 'common.docs.read',
		scope: 'common',
		command: 'aexus-ade docs read <common|L0|L1..LN|mission|manifest> [--json]',
		summary: 'Lazily fetch the single-source API documentation or revision manifest from the local host (works identically for local and remote SSH cloud agents).',
		addedInRevision: 2,
	},
	{
		id: 'common.api.update',
		scope: 'common',
		command: 'aexus-ade api update [--since <rev>] [--scope <common|in_graph|off_graph|mission|all>] --json',
		summary: 'Forever-immutable diff query returning APIs added, modified, or deprecated since a previously read revision.',
		addedInRevision: 2,
	},
	{
		id: 'in_graph.token.current',
		scope: 'in_graph',
		command: 'aexus-ade token current [--mission <id>] [--agent <id>] --json',
		summary: 'Inspect active plain-text token(s) held by this node: last_summary, rolling compressed_history, and lightweight trace_ptr.',
		addedInRevision: 2,
	},
	{
		id: 'in_graph.token.trace',
		scope: 'in_graph',
		command: 'aexus-ade token trace <tracePtr> [--limit <n>] [--mission <id>] --json',
		summary: 'Expand a lightweight trace pointer on demand to inspect the most recent step-by-step traversal history (including rejections & merged branch sub-paths).',
		addedInRevision: 2,
	},
	{
		id: 'in_graph.token.complete',
		scope: 'in_graph',
		command: 'aexus-ade token complete <tokenId> --summary "<plain human summary>" [--mission <id>] [--skip-checks] --json',
		summary: 'Submit work completion with a concise, high-SNR human-readable summary; automatically runs any zero-cost deterministic node verification hooks first (--skip-checks is Human L-1 only), rolls prior summary into hierarchical compressed history, and advances token(s) through forks/join barriers.',
		addedInRevision: 2,
		modifiedInRevision: 4,
		changeNote: 'Executes configured deterministic verification hooks (shell/exit-code/files/output match) with zero LLM cost prior to advancing tokens, and replaces hard history slicing with hierarchical semantic rolling compaction.',
	},
	{
		id: 'in_graph.token.reject',
		scope: 'in_graph',
		command: 'aexus-ade token reject <tokenId> --reason "<reason>" [--target <nodeId>] [--mission <id>] --json',
		summary: 'In-graph reviewer rejects upstream result and bounces token back to previous step (without adding static cycles to Mermaid).',
		addedInRevision: 2,
	},
	{
		id: 'in_graph.token.block',
		scope: 'in_graph',
		command: 'aexus-ade token block <tokenId> --duration <10h|30m|600s> --reason "<reason>" [--watch-pid|--wake-on-pid-exit <pid>] [--watch-file|--wake-on-file <path>] [--host <alias>] [--mission <id>] --json',
		summary: 'Declare a long-running task blocked (pausing routine silence nudges) with optional local/remote PID-exit or clock-drift-safe file-ready early wakeup conditions.',
		addedInRevision: 2,
		modifiedInRevision: 4,
		changeNote: 'Supports --wake-on-pid-exit / --wake-on-file aliases and captures target-host baseline mtime for clock-drift-safe remote file wakeups.',
	},
	{
		id: 'in_graph.token.fail',
		scope: 'in_graph',
		command: 'aexus-ade token fail <tokenId> --reason "<reason>" [--mission <id>] --json',
		summary: 'Declare task failure: automatically routes along configured fail-edge(s) if present (preserving rework return routing), or freezes token and escalates to direct off-graph supervisor.',
		addedInRevision: 2,
	},
	{
		id: 'mission.lifecycle',
		scope: 'mission',
		command: 'aexus-ade mission start|run --mission <id> [--timeout <minutes>] [--prompt "<text>"] | mission timeout --mission <id> --minutes <n> | mission pause|resume|stop|status --mission <id> --json',
		summary: 'Start (locking silence timeout), configure timeout before start, pause, resume, stop, and inspect live Mission topology, token states, barriers, and triggers.',
		addedInRevision: 2,
	},
	{
		id: 'mission.gate',
		scope: 'mission',
		command: 'aexus-ade mission gate <approve|reject> --mission <id> --node <gateId> [--token <tokenId>] [--note "<text>"] [--rollback <nodeId>] --json',
		summary: 'Approve or reject a waiting Human Gate token (Human only; supports multi-wave queued gates via optional --token).',
		addedInRevision: 2,
	},

	// ---- Revision 3: Free Jurisdiction, Top-Down Org Comms, Recall, Safe Atomic Patch, Triggers & Cloud Host Binding ----
	{
		id: 'off_graph.org.subordinates',
		scope: 'off_graph',
		command: 'aexus-ade org subordinates [--mission <id>] --json',
		summary: 'List off-graph supervisor free-mapped managed DAG nodes and subordinate supervisors.',
		addedInRevision: 3,
	},
	{
		id: 'off_graph.org.send',
		scope: 'off_graph',
		command: 'aexus-ade org send <nodeOrSessionId> "<message>" [--mission <id>] [--wait] --json',
		summary: 'Strictly top-down directive message to a managed subordinate (upward messaging from subordinates is hard-blocked).',
		addedInRevision: 3,
	},
	{
		id: 'off_graph.org.context',
		scope: 'off_graph',
		command: 'aexus-ade org context <nodeOrSessionId> [--limit <n>] [--mission <id>] --json',
		summary: 'Actively pull latest conversation transcript & token state of any managed local or remote SSH cloud subordinate.',
		addedInRevision: 3,
	},
	{
		id: 'off_graph.org.escalate',
		scope: 'off_graph',
		command: 'aexus-ade org escalate --reason "<reason>" [--node <nodeId>] [--token <tokenId>] [--mission <id>] --json',
		summary: 'Escalate unresolved failures or out-of-jurisdiction patch/recall needs upward to parent supervisor (L1 escalates directly to Human Inbox).',
		addedInRevision: 3,
	},
	{
		id: 'mission.boundary',
		scope: 'mission',
		command: 'aexus-ade mission boundary get|set --mission <id> [--off-graph-max-tier <k>] [--supervisors-json <json>] [--assignments-json <json>] --json',
		summary: 'Configure and validate strict factory boundary cutoff (Lk), strictly top-down supervisor jurisdictions, and node assignments.',
		addedInRevision: 3,
	},
	{
		id: 'mission.recall',
		scope: 'mission',
		command: 'aexus-ade mission recall --mission <id> [--nodes <N1,N2>] [--branch <nodeId>] [--reason "<reason>"] --json',
		summary: 'Forcibly recall in-flight tokens and abort active turns within supervisor jurisdiction (blocks & requests escalation if parallel branches exceed jurisdiction).',
		addedInRevision: 3,
	},
	{
		id: 'mission.retry',
		scope: 'mission',
		command: 'aexus-ade mission retry --mission <id> (--node <nodeId> | --token <tokenId>) [--guidance "<instructions>"] --json',
		summary: 'Retry a frozen_failed or recalled node in-place within supervisor jurisdiction (alias: token retry), preserving wave & join-barrier state.',
		addedInRevision: 3,
	},
	{
		id: 'mission.patch',
		scope: 'mission',
		command: 'aexus-ade mission patch --mission <id> (--file <path> | --text|--mermaid "<mermaid>") [--reason "<reason>"] --json',
		summary: 'Atomically patch unfinished DAG topology within supervisor jurisdiction with hard anti-dangling connectivity validation and automatic join-barrier reconciliation.',
		addedInRevision: 3,
	},
	{
		id: 'mission.prompt',
		scope: 'mission',
		command: 'aexus-ade mission prompt list|get|set --mission <id> [--node <nodeId>] [--prompt "<text>" | --file <path> | --clear] --json',
		summary: 'Inspect, update, or clear per-node authored Pre-Prompts delivered on token wakeup.',
		addedInRevision: 3,
	},
	{
		id: 'mission.trigger',
		scope: 'mission',
		command: 'aexus-ade mission trigger list --mission <id> | set --mission <id> --node <sourceNodeId> --kind <once|interval|cron|event> ... | remove --mission <id> --trigger <triggerId> --json',
		summary: 'Attach/manage zero-token timed, repeating, cron, or external-event (file/git/gpu-idle) triggers on inDegree=0 source nodes (persisted across restarts).',
		addedInRevision: 3,
	},
	{
		id: 'mission.host.bind',
		scope: 'mission',
		command: 'aexus-ade mission host bind --mission <id> --node <nodeId> --host <local|sshAlias> [--path <remoteDir>] [--agent <id>] [--role-kind worker|reviewer] --json',
		summary: 'Bind a Mission node or employee to run natively on local machine or a configured remote SSH Cloud Host.',
		addedInRevision: 3,
	},

	// ---- Revision 4: Zero-Cost Deterministic Verification Hooks & Hierarchical Semantic Rolling History ----
	{
		id: 'mission.check',
		scope: 'mission',
		command: 'aexus-ade mission check <list|get|set|remove|run> --mission <id> [--node <nodeId>] [--id <checkId>] [--name <label>] [--cmd "<shell>"] [--expect-file <path>] [--match "<pattern>"] [--expect-exit <code>] [--timeout <duration>] [--cwd <dir>] [--host <local|alias>] [--on-fail bounce|fail|escalate] [--max-retries <n>] [--disabled] [--all] --json',
		summary: 'Configure, inspect, remove, or dry-run zero-token deterministic verification hooks (build/test/lint/file assertions on local or remote SSH hosts) enforced automatically before token completion advances downstream.',
		addedInRevision: 4,
	},
];

export const VALID_ADE_API_SCOPES = ['common', 'in_graph', 'off_graph', 'mission', 'all'] as const;

function normalizeScopeFilter(rawScope: string | undefined): AdeApiDocScope | 'all' {
	if (rawScope === undefined || rawScope.trim() === '') {
		return 'all';
	}
	const s = rawScope.trim().toLowerCase();
	if (s === 'all' || s === '*') {
		return 'all';
	}
	if (s === 'common') {
		return 'common';
	}
	if (s === 'mission' || s === 'engineering') {
		return 'mission';
	}
	if (s === 'in_graph' || s === 'in-graph' || s === 'ingraph' || s === 'factory' || s === 'worker') {
		return 'in_graph';
	}
	if (s === 'off_graph' || s === 'off-graph' || s === 'offgraph' || s === 'supervisor' || s === 'l0') {
		return 'off_graph';
	}
	throw new Error(`Unknown API scope "${rawScope}". Valid scopes: ${VALID_ADE_API_SCOPES.join(', ')}.`);
}

/**
 * Forever-immutable `api update` diff calculation.
 */
export function queryApiUpdateDiff(sinceRevision?: number, rawScope?: string): IAdeApiUpdateDiffResult {
	const since = typeof sinceRevision === 'number' && Number.isFinite(sinceRevision) && sinceRevision >= 0
		? Math.floor(sinceRevision)
		: 0;
	const scope = normalizeScopeFilter(rawScope);
	const filtered = scope === 'all'
		? ADE_API_SPEC_CATALOG
		: ADE_API_SPEC_CATALOG.filter(entry => entry.scope === scope);

	const added: IAdeApiChangeRecord[] = [];
	const modified: IAdeApiChangeRecord[] = [];
	const deprecated: IAdeApiChangeRecord[] = [];

	for (const entry of filtered) {
		if (entry.deprecatedInRevision !== undefined && entry.deprecatedInRevision > since) {
			deprecated.push(entry);
		}
		if (entry.addedInRevision > since) {
			added.push(entry);
		} else if (entry.modifiedInRevision !== undefined && entry.modifiedInRevision > since) {
			modified.push(entry);
		}
	}

	return {
		contractVersion: 1,
		currentRevision: ADE_API_LATEST_REVISION,
		sinceRevision: since,
		scope,
		upToDate: added.length === 0 && modified.length === 0 && deprecated.length === 0,
		added,
		modified,
		deprecated,
	};
}

export function renderCommonApiDoc(): string {
	return [
		'# Aexus ADE API Reference — Common Base (All Roles L0..LN)',
		'',
		`Current API Revision: **${ADE_API_LATEST_REVISION}**`,
		'',
		'This single-source document covers the minimal universal commands shared by every role (`L0..LN`) on both local and remote SSH Cloud Hosts.',
		'',
		'## 1. Identity Self-Inspection (`whoami`)',
		'```bash',
		'aexus-ade whoami --json',
		'# Returns: { id, tier, tierTag, factorySide, missionId, nodeIds, managedNodeIds, currentTokenIds, latestApiRevision }',
		'```',
		'',
		'## 2. Lazy Single-Source Documentation Reader (`docs read`)',
		'- Never hardcode or assume mutable rank display names; read your numeric tier doc on demand:',
		'```bash',
		'aexus-ade docs read common           # This base reference',
		'aexus-ade docs read L0               # Tier L0 (Secretary)',
		'aexus-ade docs read L1               # Tier L1..LN (replace with your Lk from whoami)',
		'aexus-ade docs read mission          # Unified Mission DAG, Token, Patch, Recall & Trigger APIs',
		'aexus-ade rank names --json          # Live hot-reloadable alias map { L-1, L0, L1..LN }',
		'```',
		'',
		'## 3. Forever-Immutable API Update Diff (`api update`)',
		'- This command signature NEVER changes. Compare your last read revision against the current system revision:',
		'```bash',
		'aexus-ade api update --since <last_revision> [--scope common|in_graph|off_graph|mission|all] --json',
		'```',
		'',
	].join('\n');
}
