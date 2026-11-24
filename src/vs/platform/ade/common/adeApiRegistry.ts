/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Single-source versioned ADE API specification registry & forever-immutable `api update` diff engine.
 *
 * Design guarantee:
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

export const ADE_API_LATEST_REVISION = 11;

export const ADE_API_SPEC_CATALOG: readonly IAdeApiChangeRecord[] = [
	// ---- Revision 1: Base ADE Core ----
	{
		id: 'common.rank.names',
		scope: 'common',
		command: 'aexus-ade rank names --json | aexus-ade rank mission-name "<Alias>"',
		summary: 'Query live hot-reloadable { L-1, L0, L1..LN } rank display aliases and Mission alias (or rename the Mission alias as L-1/L0).',
		addedInRevision: 1,
		modifiedInRevision: 10,
		changeNote: 'Exposed CLI subcommand `rank mission-name "<Alias>"` alongside `rank names --json`.',
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
		command: 'aexus-ade session list|info|tree|create|configure|send|history|delete [--force] --json',
		summary: 'Manage native subordinate sessions, configure engine/model/thinking, inspect histories, and coordinate projects/hosts.',
		addedInRevision: 1,
		modifiedInRevision: 10,
		changeNote: 'Added `session.configure`/`session.prefs` to `session.manage` RBAC and forwarded `--force` on `session delete`.',
	},
	{
		id: 'mission.blueprint',
		scope: 'mission',
		command: 'aexus-ade mission init|list [--project <p>]|rename <id> <title>|open|blueprint get|validate|apply|remove',
		summary: 'Create, list, rename, open, validate, apply Dual-View blueprints (Task DAG + Orchestration Team + Task Specs), and remove Missions.',
		addedInRevision: 1,
		modifiedInRevision: 10,
		changeNote: 'Extended `mission blueprint apply` to extract both Mission Task DAG and Orchestration Team Mermaid blocks + Task Specifications, and exposed `mission rename` & `mission list --project`.',
	},

	// ---- Revision 2: Single-Source Docs, Immutable `api update`, Pure-Text Token Engine & Watchdog ----
	{
		id: 'common.whoami',
		scope: 'common',
		command: 'aexus-ade whoami --json',
		summary: 'Query own session ID (`id`), numeric tier (`tier`, `tierTag`), `isOrchestrationStaff`, `department`, `missionId`, `nodeIds`, `currentTokenIds` (including `otok-*`), and `latestApiRevision`.',
		addedInRevision: 2,
		modifiedInRevision: 10,
		changeNote: 'Returns live Orchestration `otok-*` batons in `currentTokenIds`/`currentTokens` across renderer and headless modes.',
	},
	{
		id: 'common.docs.read',
		scope: 'common',
		command: 'aexus-ade docs read <common|L0|L1..LN|engineering|paradigm|engineering-api|mission|manifest> [--json]',
		summary: 'Lazily fetch single-source Native Rank docs (`docs/ranks/`), Engineering Dual-View Paradigm & API docs (`docs/engineering/`), compact Mission compatibility index (`docs/mission/`), or revision manifest.',
		addedInRevision: 2,
		modifiedInRevision: 10,
		changeNote: 'Deduplicated `MISSION_API.md` into a compact compatibility index and compacted `api-manifest.json` (~75% fewer tokens).',
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
		command: 'aexus-ade token current [--mission <id>] [--agent <id>] [--full] --json',
		summary: 'Inspect active baton token(s) held by this node with compact delta projection by default (`--full` for raw hopLog/contextRefs).',
		addedInRevision: 2,
		modifiedInRevision: 10,
		changeNote: 'Projects compact token + delta summary by default (eliminating duplicate hopLog/contextRefs serialization unless `--full` is passed).',
	},
	{
		id: 'in_graph.token.trace',
		scope: 'in_graph',
		command: 'aexus-ade token trace <tracePtr> [--limit <n>] [--mission <id>] --json',
		summary: 'Expand a legacy trace pointer on demand.',
		addedInRevision: 2,
		deprecatedInRevision: 9,
		replacement: 'aexus-ade token history <tokenId> [--delta|--all] and aexus-ade token read <ptr1,ptr2>',
	},
	{
		id: 'in_graph.token.complete',
		scope: 'in_graph',
		command: 'aexus-ade token complete <tokenId> --summary "<1-line summary>" [--finish] [--complete-task] [--task <T1> | --tasks <T1,T2>] [--detail - | --detail-file <path>] [--whiteboard <wbId,...>] [--files <p1,p2>] [--mission <id>] --json',
		summary: 'Complete an active baton (pass `--finish` when closing a root wave or terminal baton, and `--complete-task` to atomically sign off the bound Mission Task DAG node after deterministic `nodeChecks` and `completionContract` verification across both renderer and headless).',
		addedInRevision: 2,
		modifiedInRevision: 11,
		changeNote: 'Enforces deterministic `nodeChecks` and task `completionContract` (`COMPLETION_CONTRACT_UNMET`) identically across renderer and headless before `--complete-task` sign-off.',
	},
	{
		id: 'in_graph.token.reject',
		scope: 'in_graph',
		command: 'aexus-ade token reject <tokenId> --reason "<feedback>" [--category <defect|spec|test|env|scope>] [--to <nodeId>] [--detail - | --detail-file <path>] [--whiteboard <wbId>] [--mission <id>] --json',
		summary: 'Bounce or reject an active Dual-View Orchestration baton across 3 modes (`downward_rework`, `peer_bounce`, `upward_reject`) with structured `--category` rework provenance and bounded rework memory.',
		addedInRevision: 2,
		modifiedInRevision: 11,
		changeNote: 'Added `--category <defect|spec|test|env|scope>` structured rework provenance and bounded per-token `reworkHistory` / `attemptNumber` tracking.',
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
		command: 'aexus-ade token fail <tokenId> --reason "<reason>" [--category <defect|spec|test|env|scope>] [--detail - | --detail-file <path>] [--mission <id>] --json',
		summary: 'Declare task failure with optional `--category`: routes along fail-edge(s) if present, or freezes token and reports failure to superior & bound Task DAG.',
		addedInRevision: 2,
		modifiedInRevision: 11,
		changeNote: 'Added `--category <defect|spec|test|env|scope>` structured failure provenance alongside `--detail -` / `--detail-file`.',
	},
	{
		id: 'mission.lifecycle',
		scope: 'mission',
		command: 'aexus-ade mission start|run --mission <id> [--timeout <minutes>] [--prompt "<text>"] | mission timeout --mission <id> --minutes <n> | mission pause|resume|stop|status --mission <id> --json',
		summary: 'Legacy static Mission DAG lifecycle controls.',
		addedInRevision: 2,
		deprecatedInRevision: 9,
		replacement: 'aexus-ade orchestration dispatch|status|pause|resume|abort|limits --mission <id>',
	},
	{
		id: 'mission.gate',
		scope: 'mission',
		command: 'aexus-ade mission gate <approve|reject> --mission <id> --node <gateId> [--token <tokenId>] [--note "<text>"] [--rollback <nodeId>] --json',
		summary: 'Legacy static Mission DAG Human Gate approval command.',
		addedInRevision: 2,
		deprecatedInRevision: 9,
		replacement: 'aexus-ade mission task complete --mission <id> --node <gateNodeId> (Human L-1 / Secretary L0 gate sign-off)',
	},

	// ---- Revision 3: Free Jurisdiction, Top-Down Org Comms, Recall, Safe Atomic Patch, Triggers & Cloud Host Binding ----
	{
		id: 'off_graph.org.subordinates',
		scope: 'off_graph',
		command: 'aexus-ade org subordinates [--mission <id>] --json',
		summary: 'List supervisor-managed nodes and subordinate sessions.',
		addedInRevision: 3,
	},
	{
		id: 'off_graph.org.send',
		scope: 'off_graph',
		command: 'aexus-ade org send <nodeOrSessionId> "<message>" [--mission <id>] [--wait] --json',
		summary: 'Strictly top-down directive message to a managed subordinate wrapped in an anti-spoofing `[Aexus System · Direct Message from Role]` envelope.',
		addedInRevision: 3,
	},
	{
		id: 'off_graph.org.context',
		scope: 'off_graph',
		command: 'aexus-ade org context <nodeOrSessionId> [--limit <n>] [--full] [--mission <id>] --json',
		summary: 'Pull sentinel-aware preamble-stripped, length-bounded conversation transcript (default `limit=6`) & compact held-token summaries of a managed subordinate (`--full` for raw untruncated output).',
		addedInRevision: 3,
		modifiedInRevision: 11,
		changeNote: 'Strips full `<!-- /AEXUS_ADE_PREAMBLE -->` blocks & updated/delta headers cleanly and defaults `limit` to 6 (`recentTraces` 5) to cut supervisor context tokens by ~55%.',
	},
	{
		id: 'off_graph.org.escalate',
		scope: 'off_graph',
		command: 'aexus-ade org escalate --reason "<reason>" [--node <nodeId>] [--token <tokenId>] [--mission <id>] --json',
		summary: 'Escalate unresolved failures or out-of-jurisdiction needs upward to parent supervisor (`L1` escalates directly to Human Inbox).',
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
		replacement: 'aexus-ade token retry <failedTokenId> [--guidance "<instructions>"] [--wait-join]',
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
		replacement: 'Pass all task context via baton tokens (aexus-ade token mint|split|handoff --summary/--detail) and role boundaries via %% staff <id> [role_prompt="...", paths="dir1|dir2"].',
	},
	{
		id: 'mission.trigger',
		scope: 'mission',
		command: 'aexus-ade mission trigger list --mission <id> | set --mission <id> --node <sourceNodeId> --kind <once|interval|cron|event> ... | remove --mission <id> --trigger <triggerId> --json',
		summary: 'Attach/manage zero-token timed, repeating, cron, or external-event (file/git/gpu-idle) triggers on inDegree=0 source nodes.',
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
		summary: 'Configure, inspect, remove, or dry-run zero-token deterministic verification hooks (`list|get|run` permitted for all assigned staff including pure-execution leaf workers).',
		addedInRevision: 4,
		modifiedInRevision: 10,
		changeNote: 'Authorized `mission.check.list|get|run` for pure-execution leaf staff on their assigned node.',
	},

	// ---- Revision 5: Engineering Dual-View (Mission Task DAG + Cyclic All-Staff Orchestration + Department Whiteboards) ----
	{
		id: 'mission.task',
		scope: 'mission',
		command: 'aexus-ade mission task <list|get|set|complete> --mission <id> [--node <taskId>] [--description "<text>" | --file <path|->] [--note "<verification>"] [--full] --json',
		summary: 'Inspect/edit Mission Task DAG node descriptions and mark qualifying tasks `completed` under per-node completion authority (`owner` / `completers` / `min_tier`, Human Gate `U1{{...}}` protection, deterministic `nodeChecks` & `completionContract` verification, and hard upstream dependency gating).',
		addedInRevision: 5,
		modifiedInRevision: 11,
		changeNote: 'Enforces deterministic `nodeChecks` and `completionContract` (`require_checks`, `require_artifact`, `require_files`, `require_wb`, `min_summary`) identically in renderer and headless.',
	},
	{
		id: 'orchestration.topology',
		scope: 'mission',
		command: 'aexus-ade orchestration <get|apply|status|dispatch> --mission <id> [--file <path> | --text "<mermaid>"] [--prompt "<requirement>"] [--detail - | --detail-file <path>] [--task <T1> | --tasks <T1,T2>] [--to <nodeId>] [--whiteboard <wbId,...>] [--ref <ptr,...>] [--full] --json',
		summary: 'Read, update, check compact deduplicated wave status (`--full` for raw token objects), and dispatch requirements (including `--ref` pointers) onto the all-staff cyclic Orchestration canvas.',
		addedInRevision: 5,
		modifiedInRevision: 11,
		changeNote: 'Added `--ref <ptr,...>` parity on `orchestration dispatch` and deduplicated headless `orchestration status` JSON fields.',
	},
	{
		id: 'orchestration.staff.create',
		scope: 'mission',
		command: 'aexus-ade orchestration staff create --mission <id> --name "<Name>" [--id <nodeId>] [--rank <L2..LN|rankId>] [--role "<Title>"] [--department|--new-department "<Dept>"] [--create-whiteboard] [--whiteboard-title "<Title>"] [--engine <e>] [--model <m>] [--thinking <lvl>] [--host <alias>] [--role-prompt "<boundary>"] [--allowed-paths "dir1,dir2"] [--color <hex|token>] [--bidirectional | --one-way] [--mint-token <parentTokId> | --handoff-token <tokId>] [--summary "<task>"] --json',
		summary: 'Dynamically recruit an immediate next-tier subordinate node on the Orchestration canvas (`L1` may spin up `--new-department` + `--create-whiteboard`), wire edges, and optionally mint/handoff an initial baton.',
		addedInRevision: 5,
		modifiedInRevision: 10,
		changeNote: 'Documented complete `--rank`, `--new-department`, `--create-whiteboard`, `--mint-token`, engine/model/thinking/host, and role boundary flags.',
	},
	{
		id: 'in_graph.token.handoff',
		scope: 'in_graph',
		command: 'aexus-ade token handoff <tokenId> --to <nodeId[,nodeId2...]> --summary "<1-line summary>" [--task <T1> | --tasks <T1,T2>] [--detail - | --detail-file <path>] [--artifact "Title=Body"] [--decision "Title=Body"] [--whiteboard <wbId,...>] [--ref <ptr,...>] [--files <p1,p2>] [--mission <id>] --json',
		summary: 'Hand off an active Orchestration baton along connected edges (1-to-N fan-out, peer review loops, cyclic re-entry) carrying lightweight pointers only.',
		addedInRevision: 5,
		modifiedInRevision: 10,
		changeNote: 'Documented `--task`/`--tasks`, shell-safe `--detail -`/`--detail-file`, `--artifact`, `--decision`, `--ref`, and `--files`.',
	},
	{
		id: 'common.whiteboard',
		scope: 'common',
		command: 'aexus-ade whiteboard <list|create|read|write|rename|remove> --mission <id> [<whiteboardId>] [--department "<Dept>"] [--title "<title>"] [--toc | --summary-only] [--section "<Heading>"] [--max-chars <N>] [--offset <N> | --tail <N>] [--content "<md>" | --content - | --file <path> | --append "<md>" | --append - | --append-file <path>] [--expected-version <n>] --json',
		summary: 'Create, inspect TOC/section/tail-sliced reads (`--toc`, `--section`, `--max-chars`, `--tail`), section-upsert or CAS-write (`--section`, `--expected-version`, stdin `-`), rename, and remove Department Shared Whiteboards; pass ONLY `--whiteboard <wbId>` pointers in tokens.',
		addedInRevision: 5,
		modifiedInRevision: 11,
		changeNote: 'Added `--toc`/`--summary-only`, `--section`, `--max-chars`, `--offset`, and `--tail` sliced reads plus `--section` targeted upsert on `whiteboard write`.',
	},

	// ---- Revision 6: Pointer-Native Split-Context Tokens & Cyclic Delta-Cursor History ----
	{
		id: 'in_graph.token.read',
		scope: 'in_graph',
		command: 'aexus-ade token read <ptr1[,ptr2...]> [--mission <id>] [--token <tokenId>] [--toc | --summary-only] [--section "<Heading>"] [--max-chars <N>] [--offset <N> | --tail <N>] --json',
		summary: 'Batch-dereference lightweight context pointers (`hop-N`, `art-N`, `dec-N`, `wb:<id>`, `otrc-N`) with optional TOC, Markdown `--section`, or `--max-chars`/`--tail` slicing (partial slices preserve `seenRefVersions` delta cursors!).',
		addedInRevision: 6,
		modifiedInRevision: 11,
		changeNote: 'Added `--toc`, `--summary-only`, `--section`, `--max-chars`, `--offset`, and `--tail` budgeted slicing across renderer and headless while preserving unread cursor state on partial slices.',
	},
	{
		id: 'in_graph.token.history',
		scope: 'in_graph',
		command: 'aexus-ade token history <tokenId> [--mission <id>] [--delta | --all] --json',
		summary: 'Inspect a baton token\'s cyclic re-entry delta view by default (`--delta`), or pass `--all` for full wave `hopLog` and `contextRefs` lineage.',
		addedInRevision: 6,
		modifiedInRevision: 10,
		changeNote: 'Aligned default response to compact cyclic delta view (`--all` opt-in for full wave lineage) across renderer and headless.',
	},

	// ---- Revision 7: 100% Lossless Bijective Text <-> Visual Migration, Draggable/Renamable Groups & Full CLI Parity ----
	{
		id: 'mission.migration',
		scope: 'mission',
		command: 'aexus-ade mission export [--mission <id>] [--format json|markdown] [--with-positions] [--file <path>] | mission import [--owner <id>] [--project <path>] (--file <path> | --text <json>) --json',
		summary: 'Export (JSON bundle or Dual-View `.md` blueprint) and import an entire Dual-View Engineering workspace losslessly.',
		addedInRevision: 7,
		modifiedInRevision: 11,
		changeNote: 'Documented `--format json|markdown` raw blueprint export support.',
	},
	{
		id: 'orchestration.migration',
		scope: 'mission',
		command: 'aexus-ade orchestration export [--mission <id>] [--with-positions] [--raw] [--file <path>] | orchestration import [--mission <id>] (--file <path> | --text "<mermaid>") | orchestration layout set <lr|td|radial|grid> [--mission <id>] --json',
		summary: 'Losslessly serialize and restore Orchestration Mermaid text and switch presentation layouts.',
		addedInRevision: 7,
	},
	{
		id: 'orchestration.authoring',
		scope: 'mission',
		command: 'aexus-ade orchestration group <list|create|rename|assign|remove> | orchestration staff <create|rename|config|remove> | orchestration edge <connect|label|remove> | whiteboard <rename|remove> [--mission <id>] --json',
		summary: 'Full CLI authoring parity for Groups/Departments, staff nodes, edges, and whiteboards.',
		addedInRevision: 7,
		modifiedInRevision: 8,
		changeNote: 'Added staff config (pre-launch & session-reset engine switching) and runtime subordinate removal with automatic in-flight token reclamation.',
	},

	// ---- Revision 8: Heterogeneous Token Mint/Split/Join, Dynamic Staff Removal, Live Task DAG Linkage, Code-as-Orchestration & Daemon Controls ----
	{
		id: 'in_graph.token.mint_split',
		scope: 'in_graph',
		command: 'aexus-ade token mint|split [parentTokenId] (--to <subNodeId> --summary "<headline>" [--detail - | --detail-file <path>] [--task <T1> | --tasks <T1,T2>] [--scope-paths <glob,...>] | --branches-json <json|-> | --branches-file <path> | --branch <json>) [--wait-join | --no-wait-join] [--join-mode all|any|quorum] [--quorum <k>] [--fail-fast] [--deadline <duration|iso|ms>] [--conflict-policy reject|warn|allow | --allow-overlap] [--wave-summary "<text>"] [--mission <id>] --json',
		summary: 'Mint 1..N heterogeneous downward sub-task batons with per-branch `scopePaths` file-ownership governance, overlap conflict detection at join barriers, and `all|any|quorum` + `--fail-fast` + `--deadline` convergence.',
		addedInRevision: 8,
		modifiedInRevision: 11,
		changeNote: 'Added `--scope-paths` / `--conflict-policy` (`--allow-overlap`) parallel file-scope governance, `--join-mode quorum --quorum <k>`, `--fail-fast`, watchdog-enforced `--deadline`, and `--wave-summary`.',
	},
	{
		id: 'in_graph.token.return',
		scope: 'in_graph',
		command: 'aexus-ade token return <tokenId> --summary "<delivery>" [--complete-task] [--to <superiorNodeId>] [--task <T1> | --tasks <T1,T2>] [--detail - | --detail-file <path>] [--artifact "Title=Body"] [--decision "Title=Body"] [--whiteboard <wbId,...>] [--files <p1,p2>] [--mission <id>] --json',
		summary: 'Return a received downward baton upward to its dispatching superior, recording `touchedFiles` on join barriers and verifying deterministic `nodeChecks` & `completionContract` before `--complete-task` sign-off.',
		addedInRevision: 8,
		modifiedInRevision: 11,
		changeNote: 'Verifies deterministic `nodeChecks` & task `completionContract` in both renderer and headless, and checks `--files` against branch `scopePaths` + sibling barrier overlaps.',
	},
	{
		id: 'mission.task.authoring',
		scope: 'mission',
		command: 'aexus-ade mission task <create|update|remove> [--mission <id>] [--node <taskId>] [--title "<title>"] [--description "<text>" | --file <path|->] [--owner <staffId>] [--assignee <staffId>] [--department <Dept>] [--min-tier <n>] [--after <upId>] [--require-checks] [--require-artifact] [--require-files] [--require-whiteboard <wbId,...>] [--min-summary <chars>] | mission task edge <add|remove> <from> <to> --json',
		summary: 'Dynamically create, update, remove, and wire Mission Task DAG nodes, per-node completion permissions, and deterministic `completionContract` guardrails at runtime.',
		addedInRevision: 8,
		modifiedInRevision: 11,
		changeNote: 'Added deterministic `completionContract` flags (`--require-checks`, `--require-artifact`, `--require-files`, `--require-whiteboard`, `--min-summary`) and `--description -` stdin support on `create`.',
	},
	{
		id: 'orchestration.manifest_and_control',
		scope: 'mission',
		command: 'aexus-ade orchestration validate|load --file <orchestration.json|mjs|mmd> [--mission <id>] | orchestration export --format json|mermaid | orchestration pause|resume|abort [--mission <id>] --json',
		summary: 'Validate, load, and export structured Code-as-Orchestration manifests and pause/resume/abort live Orchestration waves.',
		addedInRevision: 8,
	},

	// ---- Revision 10: Context Economy v2, Dual-View Retry/Limits/Task-Status, Subordinate Session Configure & Restored 3-Mode `token.reject` ----
	{
		id: 'in_graph.token.retry',
		scope: 'in_graph',
		command: 'aexus-ade token retry <failedTokenId> [--guidance "<instructions>"] [--wait-join] [--mission <id>] --json',
		summary: 'Re-mint and dispatch a replacement baton for a failed Orchestration token (`supersededByTokenId`), optionally re-attaching a join barrier (`--wait-join`).',
		addedInRevision: 10,
	},
	{
		id: 'orchestration.limits',
		scope: 'mission',
		command: 'aexus-ade orchestration limits [--mission <id>] [--max-hops <N|off>] [--budget <usd|off|inf>] [--silence <minutes|off>] [--total-cost <usd|off>] --json',
		summary: 'Inspect or configure per-mission `maxHops` cycle circuit-breaker, FinOps USD hard budget cap, silence reminder cadence (`1..1440`m), and Human-only total-cost reset.',
		addedInRevision: 10,
		modifiedInRevision: 11,
		changeNote: 'Exposed `--silence <minutes|off>` and `--total-cost <usd|off>` CLI flags and allowed read-only inspection by all bound mission members.',
	},
	{
		id: 'mission.task.status',
		scope: 'mission',
		command: 'aexus-ade mission task status --mission <id> --node <taskId> --status <pending|in_progress|blocked|completed> [--note "<why>"] --json',
		summary: 'Update a Mission Task DAG node runtime status within caller task-completion/department authority (enforcing rollback protection on already-completed tasks).',
		addedInRevision: 10,
	},
	{
		id: 'off_graph.session.configure',
		scope: 'off_graph',
		command: 'aexus-ade session configure <sessionId> [--engine <e>] [--model <m>] [--thinking <off|low|medium|high|max>] [--role <L1..LN|rankId|none>] --json',
		summary: 'Configure preferred engine (pre-launch), model, thinking effort, or rank on a managed subordinate session.',
		addedInRevision: 10,
	},

	// ---- Revision 11: Mutation Idempotency, Sliced/TOC Whiteboards, Completion Contracts, Scoped Splits, Checkpoints & Diagnostics ----
	{
		id: 'common.idempotency',
		scope: 'common',
		command: 'aexus-ade --idempotency-key <key> <command> [args] --json',
		summary: 'Temporal-grade mutation deduplication across local/SSH control sockets (auto-generated UUIDv4 by default on mutating CLI invocations; explicit `--idempotency-key` or `AEXUS_ADE_IDEMPOTENCY_KEY` supported for crash-safe replay).',
		addedInRevision: 11,
	},
	{
		id: 'mission.diagnostics',
		scope: 'mission',
		command: 'aexus-ade mission diagnostics [--mission <id>] --json',
		summary: 'Compute Dual-View critical path, ready/blocked tasks, stalled batons, expiring join barriers, rework hotspots, normalized FinOps cache/cost health, overall grade, and recommended next actions.',
		addedInRevision: 11,
	},
	{
		id: 'mission.checkpoint',
		scope: 'mission',
		command: 'aexus-ade mission checkpoint <list|create|diff|restore> [--mission <id>] [--label "<name>"] [--checkpoint|--id <id>] --json',
		summary: 'Create, list, diff, and restore durable Dual-View Mission & Orchestration state checkpoints (auto-captured before blueprint/orchestration overwrites or aborts while preserving monotonic sequences and FinOps spend).',
		addedInRevision: 11,
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
		'Universal entry commands shared by every role (`L0..LN`) on local and remote SSH Cloud Hosts.',
		'',
		'## Documentation Layout (`<adeHome>/docs/`)',
		'- `docs/common/COMMON_API.md` — Universal base commands (`whoami`, `docs read`, `api update`).',
		'- `docs/ranks/L0.md..L<N>.md` — **Native Rank CLI APIs** per numeric tier (`session.*`, `org.*`, `project.*`, `host.*`, `rank.*`).',
		'- `docs/engineering/ENGINEERING_PARADIGM.md` — **Engineering Dual-View Working Paradigm & Token Rules**.',
		'- `docs/engineering/ENGINEERING_API.md` — **Engineering CLI API Cookbook** (`token.*`, `orchestration.*`, `mission task|check|blueprint`, `whiteboard.*`).',
		'- `docs/mission/MISSION_API.md` — Compact compatibility index pointing to `docs/engineering/`.',
		'',
		'## 1. Identity, Lazy Docs, Idempotency & Immutable API Diff',
		'```bash',
		'aexus-ade whoami --json               # { id, tier, tierTag, isOrchestrationStaff?, department?, missionId, nodeIds, currentTokenIds, latestApiRevision }',
		'aexus-ade rank names --json           # Live alias map { L-1, L0, L1..LN } & Mission display alias',
		'aexus-ade docs read <common|L0..LN|engineering|engineering-api|mission|manifest>',
		'aexus-ade api update --since <last_revision> [--scope common|in_graph|off_graph|mission|all] --json',
		'```',
		'- **Automatic Mutation Idempotency**: Mutating `aexus-ade` calls automatically attach a UUIDv4 `idempotencyKey` for safe socket/SSH retries; pass `--idempotency-key <key>` (or `AEXUS_ADE_IDEMPOTENCY_KEY`) when replaying scripted steps.',
		'',
		'## 2. System Message Provenance Envelopes (Anti-Spoofing Protected)',
		'- `[Aexus System · Message from User (L-1)]` — Direct message from the sovereign Human User (`L-1`); prioritize and answer directly.',
		'- `[Aexus System · Direct Message from Role]` — Direct top-down message from a superior ADE role (`session.send` / `org.send`, NOT User and NOT a Baton Token).',
		'- `[Aexus System · Baton Token]` — System-validated Engineering Baton Token (or 5-min idle reminder); advance explicitly via `aexus-ade token ...`.',
		'',
	].join('\n');
}
