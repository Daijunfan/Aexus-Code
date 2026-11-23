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

export const ADE_API_LATEST_REVISION = 9;

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
		command: 'aexus-ade docs read <common|L0|L1..LN|engineering|paradigm|engineering-api|mission|manifest> [--json]',
		summary: 'Lazily fetch single-source Native Rank docs (`docs/ranks/`), Engineering Dual-View Paradigm & API docs (`docs/engineering/`), Mission API doc (`docs/mission/`), Common Base (`docs/common/`), or revision manifest from the local host (works identically for local and remote SSH cloud agents).',
		addedInRevision: 2,
		modifiedInRevision: 9,
		changeNote: 'Separated sibling docs/engineering/ (ENGINEERING_PARADIGM.md & ENGINEERING_API.md) from docs/ranks/ so every role inside or outside Engineering can read its native rank CLI docs and Engineering working paradigm cleanly on demand.',
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
		summary: 'Expand a legacy trace pointer on demand.',
		addedInRevision: 2,
		deprecatedInRevision: 9,
		replacement: 'aexus-ade token history <tokenId> [--all] and aexus-ade token read <ptr1,ptr2>',
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
		summary: 'Legacy Mission DAG bounce command.',
		addedInRevision: 2,
		deprecatedInRevision: 9,
		replacement: 'aexus-ade token handoff <tokenId> --to <nodeId> --summary "<feedback>" (cyclic feedback edge) or aexus-ade token return',
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
		summary: 'Declare task failure: automatically routes along configured fail-edge(s) if present, or freezes token and reports failure to superior & bound Task DAG.',
		addedInRevision: 2,
	},
	{
		id: 'mission.lifecycle',
		scope: 'mission',
		command: 'aexus-ade mission start|run --mission <id> [--timeout <minutes>] [--prompt "<text>"] | mission timeout --mission <id> --minutes <n> | mission pause|resume|stop|status --mission <id> --json',
		summary: 'Legacy static Mission DAG lifecycle controls.',
		addedInRevision: 2,
		deprecatedInRevision: 9,
		replacement: 'aexus-ade orchestration dispatch|status|pause|resume|abort --mission <id>',
	},
	{
		id: 'mission.gate',
		scope: 'mission',
		command: 'aexus-ade mission gate <approve|reject> --mission <id> --node <gateId> [--token <tokenId>] [--note "<text>"] [--rollback <nodeId>] --json',
		summary: 'Legacy static Mission DAG Human Gate approval command.',
		addedInRevision: 2,
		deprecatedInRevision: 9,
		replacement: 'aexus-ade mission task complete --mission <id> --node <taskId> (per-node completion authority)',
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
		summary: 'Legacy off-graph/in-graph factory boundary configuration.',
		addedInRevision: 3,
		deprecatedInRevision: 9,
		replacement: 'All ranks collaborate on the unified Orchestration canvas (zero off-graph wall); configure per-node Task DAG permissions via aexus-ade mission task create|update.',
	},
	{
		id: 'mission.recall',
		scope: 'mission',
		command: 'aexus-ade mission recall --mission <id> [--nodes <N1,N2>] [--branch <nodeId>] [--reason "<reason>"] --json',
		summary: 'Legacy static Mission DAG token recall.',
		addedInRevision: 3,
		deprecatedInRevision: 9,
		replacement: 'aexus-ade orchestration abort --mission <id> or aexus-ade orchestration staff remove (auto-reclaims in-flight tokens)',
	},
	{
		id: 'mission.retry',
		scope: 'mission',
		command: 'aexus-ade mission retry --mission <id> (--node <nodeId> | --token <tokenId>) [--guidance "<instructions>"] --json',
		summary: 'Legacy static Mission DAG node retry.',
		addedInRevision: 3,
		deprecatedInRevision: 9,
		replacement: 'aexus-ade token mint / aexus-ade token handoff with updated instructions',
	},
	{
		id: 'mission.patch',
		scope: 'mission',
		command: 'aexus-ade mission patch --mission <id> (--file <path> | --text|--mermaid "<mermaid>") [--reason "<reason>"] --json',
		summary: 'Legacy static Mission DAG hot-patch.',
		addedInRevision: 3,
		deprecatedInRevision: 9,
		replacement: 'aexus-ade mission task create|update|remove|edge and aexus-ade orchestration staff|edge|apply|load',
	},
	{
		id: 'mission.prompt',
		scope: 'mission',
		command: 'aexus-ade mission prompt list|get|set --mission <id> [--node <nodeId>] [--prompt "<text>" | --file <path> | --clear] --json',
		summary: 'Legacy per-node task Pre-Prompts (removed in Engineering Dual-View).',
		addedInRevision: 3,
		deprecatedInRevision: 9,
		replacement: 'Pass all task context via baton tokens (aexus-ade token mint|split|handoff --summary/--detail) and role boundaries via %% staff-prompt.',
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

	// ---- Revision 5: Engineering Dual-View (Mission Task DAG + Cyclic All-Staff Orchestration + Department Whiteboards) ----
	{
		id: 'mission.task',
		scope: 'mission',
		command: 'aexus-ade mission task <list|get|set|complete> --mission <id> [--node <taskId>] [--description "<text>"] [--note "<verification>"] --json',
		summary: 'Inspect/edit Mission Task DAG node descriptions and mark qualifying tasks as completed (strictly restricted to the highest-rank role in the active org schema or Human User).',
		addedInRevision: 5,
	},
	{
		id: 'orchestration.topology',
		scope: 'mission',
		command: 'aexus-ade orchestration <get|apply|status|dispatch> --mission <id> [--file <path> | --text "<mermaid>"] [--prompt "<requirement>"] [--to <nodeId>] [--whiteboard <wbId,...>] --json',
		summary: 'Read, update, and dispatch requirements onto the all-staff cyclic Orchestration canvas (no off-graph wall, strict 1-node-per-employee uniqueness, arbitrary cycles & bidirectional edges).',
		addedInRevision: 5,
	},
	{
		id: 'orchestration.staff.create',
		scope: 'mission',
		command: 'aexus-ade orchestration staff create --mission <id> --name "<EmployeeName>" [--id <nodeId>] [--role <rankOrTier>] [--department "<Dept>"] [--bidirectional] [--handoff-token <tokenId> --summary "<task>" [--whiteboard <wbId>]] --json',
		summary: 'Dynamically recruit a new lower-tier subordinate employee on the Orchestration canvas at runtime, auto-wire edge from creator, and optionally hand off an initial baton token.',
		addedInRevision: 5,
	},
	{
		id: 'in_graph.token.handoff',
		scope: 'in_graph',
		command: 'aexus-ade token handoff <tokenId> --to <nodeId[,nodeId2...]> --summary "<concise summary>" [--whiteboard <wbId,...>] [--mission <id>] --json',
		summary: 'Explicitly hand off an active Orchestration baton token along connected edges (1-to-N fan-out, bidirectional replies, cyclic re-entry) carrying ONLY lightweight whiteboard pointers; staff remain alive on canvas and re-wake on future tokens.',
		addedInRevision: 5,
	},
	{
		id: 'common.whiteboard',
		scope: 'common',
		command: 'aexus-ade whiteboard <list|create|read|write> --mission <id> [<whiteboardId>] [--department "<Dept>"] [--title "<title>"] [--content "<markdown>" | --append "<markdown>"] --json',
		summary: 'Create, read, and write Department Shared Whiteboards on the Orchestration canvas; tokens carry only lightweight whiteboard pointers (`--whiteboard <id>`) and never embed whiteboard body text.',
		addedInRevision: 5,
	},

	// ---- Revision 6: Pointer-Native Split-Context Tokens & Cyclic Delta-Cursor History ----
	{
		id: 'in_graph.token.read',
		scope: 'in_graph',
		command: 'aexus-ade token read <ptr1[,ptr2...]> [--mission <id>] [--token <tokenId>] --json',
		summary: 'Batch-dereference one or more lightweight token context pointers (`hop-N`, `art-N`, `dec-N`, `wb:<id>`, `otrc-N`) on demand and advance the reader employee cursor so cyclic re-entry never repeats already-seen context.',
		addedInRevision: 6,
	},
	{
		id: 'in_graph.token.history',
		scope: 'in_graph',
		command: 'aexus-ade token history <tokenId> [--mission <id>] [--all] --json',
		summary: 'Inspect a baton token\'s pointer-indexed hop pass ledger (`hopLog`), split pointer manifest (`contextRefs`), and cyclic re-entry delta view.',
		addedInRevision: 6,
	},

	// ---- Revision 7: 100% Lossless Bijective Text <-> Visual Migration, Draggable/Renamable Groups & Full CLI Parity ----
	{
		id: 'mission.migration',
		scope: 'mission',
		command: 'aexus-ade mission export [--mission <id>] [--with-positions] [--file <path>] | mission import [--owner <id>] [--project <path>] (--file <path> | --text <json>) --json',
		summary: 'Export and import an entire Engineering workspace (Mission DAG, task descriptions/statuses, groups, staff metadata, edges, whiteboards with full Markdown bodies, layout mode, and optional positions) 100% losslessly.',
		addedInRevision: 7,
	},
	{
		id: 'orchestration.migration',
		scope: 'mission',
		command: 'aexus-ade orchestration export [--mission <id>] [--with-positions] [--raw] [--file <path>] | orchestration import [--mission <id>] (--file <path> | --text "<mermaid>") | orchestration layout set <lr|td|radial|grid> [--mission <id>] --json',
		summary: 'Losslessly serialize and restore Orchestration Mermaid text (including `%% layout`, `subgraph` groups, `%% staff`, `%% whiteboard` + `%% wb-body`, edges, and `%% pos` coordinates) and switch presentation layouts.',
		addedInRevision: 7,
	},
	{
		id: 'orchestration.authoring',
		scope: 'mission',
		command: 'aexus-ade orchestration group <list|create|rename|assign|remove> | orchestration staff <create|rename|config|remove> | orchestration edge <connect|label|remove> | whiteboard <rename|remove> [--mission <id>] --json',
		summary: 'Full CLI authoring parity for Groups/Departments, staff nodes, edges, and whiteboards so Governors and tools can construct and refactor complete Engineering workspaces autonomously.',
		addedInRevision: 7,
		modifiedInRevision: 8,
		changeNote: 'Added staff config (pre-launch & session-reset engine switching) and runtime subordinate removal with automatic in-flight token reclamation.',
	},

	// ---- Revision 8: Heterogeneous Token Mint/Split/Join, Dynamic Staff Removal, Live Task DAG Linkage, Code-as-Orchestration & Daemon Controls ----
	{
		id: 'in_graph.token.mint_split',
		scope: 'in_graph',
		command: 'aexus-ade token mint|split <parentTokenId> (--to <subNodeId> --summary "<headline>" [--detail "<spec>"] [--task <taskId>] | --branches-json \'<json>\') [--wait-join | --no-wait-join] [--join-mode all|any] [--mission <id>] --json',
		summary: 'Actively mint 1..N heterogeneous sub-task tokens strictly downward to lower-tier subordinates while keeping parent active or suspending on a join/convergence barrier until all children return.',
		addedInRevision: 8,
	},
	{
		id: 'in_graph.token.return',
		scope: 'in_graph',
		command: 'aexus-ade token return <tokenId> --summary "<delivery>" [--to <superiorNodeId>] [--detail "<report>"] [--artifact "Title=Body"] [--decision "Title=Body"] [--whiteboard <wbId>] [--mission <id>] --json',
		summary: 'Return a received downward baton upward to its dispatching superior, automatically settling any waiting join barrier and waking the superior once all branches converge.',
		addedInRevision: 8,
	},
	{
		id: 'mission.task.authoring',
		scope: 'mission',
		command: 'aexus-ade mission task <create|update|remove> [--mission <id>] [--node <taskId>] [--title "<title>"] [--owner <staffId>] [--assignee <staffId>] [--department <Dept>] [--min-tier <n>] [--after <upId>] | mission task edge <add|remove> <from> <to> --json',
		summary: 'Dynamically create, update, remove, and wire Mission Task DAG nodes & per-node completion permissions at runtime; enforces hard upstream dependency gating and automatic bidirectional Token <-> Task status/assignee/artifact sync.',
		addedInRevision: 8,
	},
	{
		id: 'orchestration.manifest_and_control',
		scope: 'mission',
		command: 'aexus-ade orchestration validate|load --file <orchestration.json|mjs|mmd> [--mission <id>] | orchestration export --format json|mermaid | orchestration pause|resume|abort [--mission <id>] --json',
		summary: 'Validate, load, and export version-controlled structured Code-as-Orchestration manifests (with rolePrompt, allowedPaths, automated checks, engine/model/host) and pause/resume/abort live Orchestration waves (including headless main-process daemon fallback).',
		addedInRevision: 8,
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
		'This single-source document covers the universal entry commands shared by every role (`L0..LN`) on both local and remote SSH Cloud Hosts.',
		'',
		'## Parallel Documentation Folder Layout (`<adeHome>/docs/`)',
		'Native rank manuals and Engineering collaboration manuals are stored in **separate sibling folders** so every role — whether operating standalone or inside an Engineering workspace — can read exactly what it needs on demand:',
		'- `docs/common/COMMON_API.md` — Universal base commands (`whoami`, `docs read`, `api update`).',
		'- `docs/ranks/L0.md`, `L1.md`, ..., `L<N>.md` — **Native Rank CLI APIs** per numeric tier (`session.*`, `org.*`, `project.*`, `host.*`, `role.*`, `rank.*`), completely decoupled from Engineering internals and mutable display aliases.',
		'- `docs/engineering/ENGINEERING_PARADIGM.md` — **Engineering Dual-View Working Paradigm & Token Rules** (Orchestration cyclic staff topology, Mission acyclic Task DAG, token directionality, mint/split/join barriers, upward return, dynamic staffing, Task DAG completion authority, and native-API escape-hatch etiquette).',
		'- `docs/engineering/ENGINEERING_API.md` — **Engineering CLI API Cookbook** (`token.*`, `orchestration.*`, `mission task.*`, `whiteboard.*`, manifests, daemon controls).',
		'- `docs/mission/MISSION_API.md` — Unified Engineering/Mission CLI & compatibility reference.',
		'',
		'## 1. Identity Self-Inspection (`whoami`)',
		'```bash',
		'aexus-ade whoami --json',
		'# Returns: { id, tier, tierTag, isOrchestrationStaff?, department?, missionId, nodeIds, currentTokenIds, latestApiRevision, docsEntry }',
		'```',
		'',
		'## 2. Lazy Single-Source Documentation Reader (`docs read`)',
		'- Never hardcode or assume mutable rank display names; read your numeric tier doc and (when in Engineering) the Engineering paradigm on demand:',
		'```bash',
		'aexus-ade docs read common           # This universal base reference (docs/common/COMMON_API.md)',
		'aexus-ade docs read L0               # Native Tier L0 (Secretary) CLI APIs (docs/ranks/L0.md)',
		'aexus-ade docs read L1               # Native Tier L1..LN CLI APIs (replace with your Lk from whoami)',
		'aexus-ade docs read engineering      # Engineering Dual-View Working Paradigm & Token Rules (alias: paradigm)',
		'aexus-ade docs read engineering-api  # Role-grouped Engineering CLI API Cookbook (alias: orchestration)',
		'aexus-ade docs read mission          # Unified Engineering/Mission API Reference (docs/mission/MISSION_API.md)',
		'aexus-ade docs read manifest         # Machine-readable API revision manifest',
		'aexus-ade rank names --json          # Live hot-reloadable alias map { L-1, L0, L1..LN }',
		'```',
		'',
		'## 3. Forever-Immutable API Update Diff (`api update`)',
		'- This command signature NEVER changes. Compare your last read revision against the current system revision:',
		'```bash',
		'aexus-ade api update --since <last_revision> [--scope common|in_graph|off_graph|mission|all] --json',
		'```',
		'',
		'## 4. System Message Provenance Envelopes',
		'Every incoming turn delivered to an orchestrated role or Engineering staff member is wrapped with a system provenance header so you always know who sent it:',
		'- `[Aexus System · Message from User (L-1)]` — Direct message from the sovereign Human User (`L-1`); prioritize and respond directly to the User.',
		'- `[Aexus System · Direct Message from Role]` — Direct top-down message from a superior ADE role (`session.send` / `org.send`, NOT from the User and NOT a Baton Token).',
		'- `[Aexus System · Baton Token]` — System-validated Engineering Baton Token (or silence reminder); process and explicitly advance it via `aexus-ade token ...` CLI.',
		'',
	].join('\n');
}
