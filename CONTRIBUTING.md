# Contributing to Aexus Code

Thank you for contributing to **Aexus Code** — the open-source lightweight cross-host multi-agent orchestrator (`ADE`) & mirror-symmetric `Code - OSS` IDE (`IDE`).

For subsystem details and security boundaries, read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`SECURITY.md`](SECURITY.md).

## 30-Second Extension & 45 `ade_*` CLI Fast-Path

Working on one of the 8 BYO-CLI adapters (`claude.ts`, `codex.ts`, `acp.ts`, `kilo.ts`, `pi.ts`), model discovery (`capabilities.ts`), or the 45 `ade_*` CLI wrappers (`adeCli.ts`, `adeCliTransport.ts`, `scripts/genAdeBins.mjs`)? **You do NOT need a full Electron C++ build:**

```bash
# 1. Compile & bundle extensions/aexus-agents (regenerates bin/_ade_runner + 45 ade_* shims)
cd extensions/aexus-agents
./../../scripts/aexus-env.sh npm run compile

# 2. Run the full extension & 45 CLI unit test suite
./../../scripts/aexus-env.sh npm test

# 3. Run ESLint zero-warning check from repository root
cd ../..
./scripts/aexus-env.sh npx eslint --max-warnings=0 "extensions/aexus-agents/src/**/*.ts"
```

## Architecture Map

| Layer | Path | Responsibilities |
| :--- | :--- | :--- |
| **Platform ADE Contracts & Formal Policy** | [`src/vs/platform/ade/common/`](src/vs/platform/ade/common/) | Canonical entities & 28 `AdeErrorCode` values (`adeModels.ts`), 45 `ade_*` manifest (`adeCliManifest.ts`), pure formal tree/department/whiteboard/ticket policy (`adeJurisdictionPolicy.ts`), byte-identical static `Rebuild/*.md` manuals (`adeSyspromptCatalog.ts`), mutual HMAC wire contracts (`adeControl.ts`, `adeControlCenterIpc.ts`), and SSH Cloud Host contracts (`adeCloudHosts.ts`). |
| **Main-Process SQLite WAL & Dynamic Storage** | [`src/vs/platform/ade/node/`](src/vs/platform/ade/node/) | Dual-DB SQLite WAL store (`catalog.db` + per-project `state.db` in `adeSqliteStore.ts`), full-duplex mutual HMAC-SHA256 server (`adeControlServer.ts`), 4-quadrant cross-host storage engine with lexicographical dual-host locks & CAS migration (`adeDynamicStorageEngine.ts`), `0444` sysprompt sync (`adeSyspromptSyncService.ts`), engine/model probing (`adeEngineProbeService.ts`), unified 45-command dispatcher (`adeControlCenterService.ts`), and non-destructive OpenSSH transport (`adeCloudHostService.ts`). |
| **Workbench ADE Project Pages & Canvas** | [`src/vs/workbench/contrib/ade/browser/`](src/vs/workbench/contrib/ade/browser/) | `Workspace Folder -> 1..N Project Pages` sidebar (`adeProjectsService.ts`, `adeProjectsView.ts`), `{ v: 2, projectId }` split-capable canvas editor (`adeEditorService.ts`, `adeEngineeringEditorPane.ts`), forced bidirectional `userSpaceOnUse` edges with 22px rigid stubs, 3000ms multi-hop flow particles, Hover timestamp tooltip & Click full ticket history/detail popover, and Cloud Host Studio (`adeCloudHostsEditorPane.ts`). |
| **8-Engine Runtime & 45 `ade_*` CLIs** | [`extensions/aexus-agents/`](extensions/aexus-agents/) | Per-employee daemon slot isolation (`agentEnvIsolation.ts`), 8 native BYO-CLI adapters (`claude.ts`, `codex.ts`, `acp.ts`, `kilo.ts`, `pi.ts`), context-preserving `interruptTurn` vs `disposeAgentRuntime`, dual-path 60fps live streaming (`extensionEngineeringDispatch.ts`, `extension.ts`), and the 45 `ade_*` CLI binaries (`adeCli.ts`, `adeCliTransport.ts`, `scripts/genAdeBins.mjs`). |

## Core Architectural Invariants

1. **Zero Hidden System Prompt Injection**: Never add hidden prompt preambles, role-hijack preloads, or wrapper envelopes to engine adapters. Only the static workspace `AGENTS.md` router, `0444` external module manuals (`ticket.md`, `orchestration.md`, `whiteboard.md`), and the exact Ticket line-1 prefix (`"[系统提示词: 此消息是来自Agent {<from_id>}的Ticket] "` with trailing single ASCII space) are permitted.
2. **Mutual HMAC-SHA256 & Per-Employee Slot Isolation**: Every `ade_*` call authenticates via `ADE_AGENT_TOKEN` challenge-response with host-channel binding; persistent engine daemons must use `ade:<projectId>:<agentId>` slots, and `claude` / `pi` `interruptTurn` must pass `{ killTree: false }` while `disposeAgentRuntime` passes `{ killTree: true }`.
3. **Async I/O & Layer Discipline in `platform/ade/node/`**: Always load `@vscode/sqlite3` via dynamic `await import('@vscode/sqlite3')` and use asynchronous `fs.promises` / streams (passing `valid-layers-check` and `eslint --max-warnings=0`).
4. **Non-Destructive SSH & Open VSX Hygiene**: Keep `syncUserSshDir: false` by default (never mutate `~/.ssh/config`) and maintain Open VSX compliance + MIT headers.

## Full Workbench Verification Commands

```bash
# 1. Architecture layers & full client TypeScript check
./scripts/aexus-env.sh npm run valid-layers-check
./scripts/aexus-env.sh npm run typecheck-client

# 2. Extension compile & unit tests
(cd extensions/aexus-agents && ./../../scripts/aexus-env.sh npm run compile && ./../../scripts/aexus-env.sh npm test)

# 3. ESLint zero-warning gate
./scripts/aexus-env.sh npx eslint --max-warnings=0 "src/vs/platform/ade/**/*.ts" "src/vs/workbench/contrib/ade/**/*.ts" "extensions/aexus-agents/src/**/*.ts"

# 4. ADE Node unit tests
./scripts/aexus-env.sh node test/unit/node/index.js --runGlob "vs/platform/ade/test/node/*.test.js"
```
