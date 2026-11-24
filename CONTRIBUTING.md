# Contributing to Aexus Code

Thank you for your interest in contributing to **Aexus Code** — the open-source Organizational Agent Development Environment (ADE) & Mirror-Symmetric IDE built on `Code - OSS`.

For a deeper technical walkthrough of subsystems and trust boundaries, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`SECURITY.md`](SECURITY.md).

---

## 30-Second Engine Adapter Contributor Fast-Path

Want to improve one of the 8 BYO-CLI adapters (`claude.ts`, `codex.ts`, `acp.ts`, `kilo.ts`, `pi.ts`), add a new coding CLI (such as Aider or Goose), update model discovery (`capabilities.ts`), or enhance the `aexus-ade` CLI (`adeCli.ts`, `adeCliMissionRuntime.mjs`)? **You do NOT need to compile Code - OSS or native Electron C++ addons!**

```bash
# 1. Install lightweight extension build dependencies (~5 seconds, no native C++ builds)
pnpm -C extensions install --frozen-lockfile --ignore-scripts

# 2. Run the full aexus-agents & CLI unit test suite (~2 seconds)
node --test --experimental-strip-types extensions/aexus-agents/test/*.test.*

# 3. Typecheck, bundle & lint extension sources
pnpm exec tsc -p extensions/aexus-agents/tsconfig.json --noEmit
node extensions/aexus-agents/esbuild.mts
pnpm exec eslint --max-warnings=0 "extensions/aexus-agents/src/**/*.ts"

# 4. Smoke-test the standalone CLI immediately (no running IDE window required)
node --experimental-strip-types extensions/aexus-agents/src/adeCli.ts --version
node --experimental-strip-types extensions/aexus-agents/src/adeCli.ts doctor --project . --json
```

> [!TIP]
> When adding or updating an engine adapter:
> - Route all child env construction through `prepareAgentChildEnv()` in `extensions/aexus-agents/src/runtime.ts` so `Pure Worker` airgap stripping and `AEXUS_ADE_SESSION_TOKEN` propagation remain automatic.
> - Key any long-lived client pools by `(cwd, sessionId, rank, pure)` so demoted sessions never reuse a higher-rank process.
> - Use **only publicly shipping upstream model IDs** in built-in fallback catalogs (`capabilities.ts`); dynamic discovery from user CLI config files handles custom gateways automatically.

---

## Contribute a Blueprint Recipe

Shareable Dual-View Engineering blueprints (`examples/blueprints/*.md`) are one of the highest-leverage ways to contribute domain workflows (e.g., Kubernetes upgrades, Rust perf profiling, data-pipeline migrations, or paper replications).

1. **Author the Dual-View Markdown Blueprint** in [`examples/blueprints/`](examples/blueprints/README.md):
   - Add a `## Mission Task DAG` section with a fenced ```` ```mermaid ```` block starting with `flowchart LR` defining acyclic tasks (`T1..TN`), optional `%% task` completion authority metadata, and a `U1{{"..."}}` human gate.
   - Add a `## Orchestration Team` section with a fenced ```` ```mermaid ```` block defining the cyclic all-staff topology (`%% staff <id> [role=L1..LN, dept=...]`, `<-->` bidirectional collaboration edges, department `subgraph` wings, and `%% whiteboard`).
   - Add a `## Task Specifications` section documenting concrete deliverables for each task node (`### T1`, `### T2`, …).
   - Do **not** include retired `## Node Pre-Prompts`, `mission prompt set`, `worker=engine:thinking` pipes, or legacy `## Tree Metadata` sections.
   - Add a summary row in [`examples/blueprints/README.md`](examples/blueprints/README.md).
2. **Validate Before Opening a PR**:
   ```bash
   # Validate BOTH Mission Task DAG & Orchestration Team blocks across all official blueprints
   ./scripts/aexus-env.sh node test/unit/node/index.js \
     --runGlob "vs/platform/ade/test/node/adeMissionDag.test.js"

   # Or validate a single blueprint against a running workbench
   aexus-ade mission blueprint validate --file ./examples/blueprints/<recipe-id>.md --json
   ```

---

## Architecture Map

| Layer | Path | Responsibilities |
| :--- | :--- | :--- |
| **Platform ADE Contracts & Dual-View Engine** | [`src/vs/platform/ade/common/`](src/vs/platform/ade/common/) | Control env scrubber (`adeControl.ts`), message envelopes (`adeMessageEnvelope.ts`), extensible organization & 4-slot role schema (`adeRoleSchema.ts`), Mission Task DAG parser/layout/router (`adeMissionDag.ts`, `adeMissionEmployee.ts`), cyclic Orchestration graph & Code-as-Orchestration manifest compiler (`adeOrchestrationGraph.ts`, `adeOrchestrationConfig.ts`), **modular Dual-View Orchestration engine** (`adeOrchestrationTypes.ts`, `adeOrchestrationTasks.ts`, `adeOrchestrationWhiteboards.ts`, `adeOrchestrationArchive.ts`, `adeOrchestrationStaffPlans.ts`, `adeOrchestrationEngine.ts`), window-scoped headless IPC (`adeEngineeringIpc.ts`), FinOps pricing (`adeModelPricing.ts`), dynamic rank resize & single-copy docs catalog (`adeRankResize.ts`, `adeDocsCatalog.ts`, `adeApiRegistry.ts`), SSH Cloud Host contracts (`adeCloudHosts.ts`). |
| **Platform Node Services & Headless Daemon** | [`src/vs/platform/ade/node/`](src/vs/platform/ade/node/) | Local `0600` socket / Windows Named Pipe / loopback TCP control plane with HMAC capability tokens (`adeControlServer.ts`), 0-window headless Orchestration daemon, cold blob/archive storage, single-copy API docs & Inbox persistence (`adeDocsBackendService.ts`, `adeDocsSync.ts`), zero-token local/SSH watchdog & 5-min baton silence probes (`adeMissionWatchdogService.ts`), non-destructive OpenSSH transport (`adeCloudHostService.ts`, `syncUserSshDir: false`), VS Code SSH migration (`vscodeConfigMigration.ts`). |
| **Workbench ADE UI & Control Plane** | [`src/vs/workbench/contrib/ade/browser/`](src/vs/workbench/contrib/ade/browser/) | Native session/project/host RBAC handler (`adeControlHandler.ts`), **modular Engineering/Mission control plane** (`adeMissionControlHelpers.ts`, `adeOrgControlActions.ts`, `adeMissionTaskControlActions.ts`, `adeWhiteboardControlActions.ts`, `adeMissionControlHandler.ts`) & `adeRankApiHandler.ts`, Dual-View store & live runtime with 429/502 retry & deterministic check execution (`adeMissionStore.ts`, `adeMissionRuntime.ts`), modular Dual-View Canvas (`adeEngineeringEditorPane.ts`, `adeMissionHostCatalog.ts`, `adeMissionFileDrawer.ts`, `adeMissionPopovers.ts`, `adeMissionCanvasRenderer.ts`, `adeMissionNodeInspector.ts`), Smart Calm `Sessions` tree & rank-filtered `Inbox` (`adeProjectsView.ts`, `adeInboxView.ts`), Organization & Roles Studio (`adeRoleStudioEditorPane.ts`), Cloud Host Studio & `aexus-ssh://` FS (`adeCloudHostsEditorPane.ts`, `adeCloudHostFileSystemProvider.ts`). |
| **Native Coding Agent Bridges & CLI** | [`extensions/aexus-agents/`](extensions/aexus-agents/) | Centralized child-env isolation (`runtime.ts`), adapters for all 8 native Coding Agents (`claude.ts`, `codex.ts`, `acp.ts`, `kilo.ts`, `pi.ts`), public model discovery (`capabilities.ts`), zero-warmup Turn-1 prompt injection with prompt-hash cache invalidation & auto-compaction recovery (`extension.ts`), opt-out third-party role bridge (`nativeRoleBridge.ts`), and the `aexus-ade` CLI (`src/adeCli.ts`, `adeCliMissionRuntime.mjs`, `adeCliRankMission.mjs`). |

---

## Architectural Invariants

Before opening a PR, please ensure your changes preserve these core invariants:

1. **Native Employee APIs vs. Engineering Canvas Staff APIs**: Never conflate regular ADE employee management (`aexus-ade session create|attach|send|move|role|delete`, which is a built-in native core ADE feature) with creating/managing an employee **node on an Engineering Orchestration canvas** (`aexus-ade orchestration staff create|config|rename|remove --mission <id> ...`, which is Engineering-exclusive and handles topology wiring + zero-leak in-flight token reclamation).
2. **Pure Execution Isolation & Subprocess Scrubbing**: Interactive pure execution leaf ranks (`Worker [L4]`, `Builder`, `Agent`) outside Engineering must never receive orchestration prompts or ADE control-plane credentials; pure-rank Engineering staff tokens are strictly scoped at the server boundary (`token.*`, `whiteboard.*`, `whoami`, `docs.read`, `api.update`). All SSH, watchdog, and helper subprocesses must strip `AEXUS_ADE_*` via `stripAdeControlEnv()`.
3. **Server-Enforced Capability Tokens & Strictly Top-Down Lineage RBAC**: Never trust client-supplied `caller` strings on the control plane. Validate `_callerSessionId` against live session state, intersect token rank with live rank, enforce `canRankSupervise` + subtree/department lineage on `session.*` and `org.*`, enforce upstream Task DAG completion gates (`INCOMPLETE_DEPENDENCIES`), and require `mission.destroy` on Mission-owner deletion.
4. **Headless Continuity & Guardrails**: Keep Orchestration state transitions pure in `src/vs/platform/ade/common/` so the main-process daemon (`AdeDocsBackendNodeService`) can execute headless operations cleanly at 0 windows, preserving `maxHops` cycle breakers, FinOps budget breakers, and zero-leak staff removal.
5. **ADE ⇄ IDE Mirror Symmetry & Non-Destructive Hygiene**: Keep `aexus-ssh://` `syncUserSshDir: false` (never mutate global `~/.ssh/config`), keep security-critical settings (`aexus.ade.organization`, `aexus.ade.autonomousMode`, `aexus.ade.nativeExtensionRoleBridge.enabled`) `scope: application` + `restricted: true`, keep `product.json#aexusVersion`, `extensions/aexus-agents/package.json#version`, and `ADE_CLI_VERSION` in strict lockstep, and maintain Open VSX compliance + MIT headers.

---

## Full Workbench Development Workflow

For changes touching `src/vs/platform/ade/` or `src/vs/workbench/contrib/ade/`:

> [!TIP]
> **Minimal Native Install (Faster CI-Style Setup)**: You only need `@vscode/sqlite3` rebuilt natively to run typecheck, ESLint, and ADE Node/extension tests — skip full native builds when you don't need full Electron packaging:
> ```bash
> ./scripts/aexus-env.sh pnpm install --frozen-lockfile --ignore-scripts
> ./scripts/aexus-env.sh pnpm rebuild @vscode/sqlite3
> ./scripts/aexus-env.sh pnpm -C build install --frozen-lockfile --ignore-scripts
> ./scripts/aexus-env.sh pnpm -C extensions install --frozen-lockfile --ignore-scripts
> ```

```bash
# 1. Fast transpile build (compiles core client + extensions/aexus-agents/dist)
./scripts/aexus-env.sh pnpm run build-fast

# 2. Check environment readiness & installed coding CLIs
./extensions/aexus-agents/bin/aexus-ade doctor

# 3. Run typecheck & ESLint zero-warning gate (platform + workbench + aexus-agents)
./scripts/aexus-env.sh pnpm run typecheck-client
./scripts/aexus-env.sh pnpm exec tsc -p extensions/aexus-agents/tsconfig.json --noEmit
./scripts/aexus-env.sh pnpm exec eslint --max-warnings=0 \
  "src/vs/platform/ade/**/*.ts" \
  "src/vs/workbench/contrib/ade/**/*.ts" \
  "extensions/aexus-agents/src/**/*.ts"

# 4. Run ADE unit tests (Node platform + Electron Browser workbench + Agents/CLI)
./scripts/aexus-env.sh node test/unit/node/index.js --runGlob "vs/platform/ade/test/node/*.test.js"
./scripts/aexus-env.sh ./scripts/test.sh \
  --run src/vs/workbench/contrib/ade/test/browser/adeControlAndViews.test.ts \
  --run src/vs/workbench/contrib/ade/test/browser/adeProjectsService.test.ts \
  --run src/vs/workbench/contrib/ade/test/browser/cloudHostsBrowser.test.ts
./scripts/aexus-env.sh node --test --experimental-strip-types extensions/aexus-agents/test/*.test.*
```

## Pull Request Checklist

- [ ] Added or updated unit tests covering new behavior, security boundaries, and cross-platform edge cases.
- [ ] Passed `pnpm run typecheck-client`, `tsc -p extensions/aexus-agents/tsconfig.json --noEmit`, `eslint --max-warnings=0` (including `extensions/aexus-agents/src/**/*.ts`), ADE Node tests, ADE Browser Workbench tests, and `extensions/aexus-agents` tests.
- [ ] Verified **Dark Modern**, **Light Modern**, **High Contrast**, and `prefers-reduced-motion` for UI changes.
- [ ] Updated `README.md`, `docs/README.zh-CN.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`, or `examples/blueprints/` if user-facing behavior, blueprints, or CLI commands changed.
