# Contributing to Aexus Code

Thank you for your interest in contributing to **Aexus Code** — the open-source Organizational Agent Development Environment (ADE) & Mirror-Symmetric IDE built on `Code - OSS`.

For a deeper technical walkthrough of subsystems and trust boundaries, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`SECURITY.md`](SECURITY.md).

---

## 30-Second Engine Adapter Contributor Fast-Path

Want to improve one of the 8 BYO-CLI adapters (`claude.ts`, `codex.ts`, `acp.ts`, `kilo.ts`, `pi.ts`), add a new coding CLI (such as Aider or Goose), update model discovery (`capabilities.ts`), or enhance the `aexus-ade` CLI (`adeCli.ts`)? **You do NOT need to compile Code - OSS or native Electron C++ addons!**

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

Shareable Markdown DAG recipes (`examples/blueprints/*.md`) are one of the highest-leverage ways to contribute domain workflows (e.g., Kubernetes upgrades, Rust perf profiling, data-pipeline migrations, or paper replications).

1. **Author the Built-In Template** in [`src/vs/platform/ade/common/adeBlueprintTemplates.ts`](src/vs/platform/ade/common/adeBlueprintTemplates.ts):
   - Define `recommendedBudgetUsd`, `maxConcurrency`, `recommendedIsolation` (`worktree` or `shared`), `defaultVerify`, per-node `files:` globs, per-node `verify:` checks, `critical:` flags, and DAG edges.
   - Use realistic, project-portable `files:` and `verify:` defaults.
2. **Sync the Markdown Recipe 1:1** in [`examples/blueprints/`](examples/blueprints/README.md):
   - Keep `examples/blueprints/<recipe-id>.md` synchronized 100% with the `balanced` preset output of `adeBlueprintTemplates.ts` (including `max_budget_usd`, `max_concurrency`, `verify`, `files`, `critical`, and Mermaid edges).
   - Add a summary row in [`examples/blueprints/README.md`](examples/blueprints/README.md).
3. **Validate Before Opening a PR**:
   ```bash
   # Validate Mermaid + Markdown schema parsing
   node --experimental-strip-types extensions/aexus-agents/src/adeCli.ts engineering blueprint validate --file ./examples/blueprints/<recipe-id>.md

   # Run blueprint parser & template tests
   ./scripts/aexus-env.sh node test/unit/node/index.js \
     --run src/vs/platform/ade/test/node/adeEngineeringBlueprintParser.test.ts \
     --run src/vs/platform/ade/test/node/adeFinOpsAndTemplates.test.ts
   ```
   *(Optional: declare `- org_preset: <presetId>` in `## Tree Metadata` when your recipe pairs best with a specific Organization Preset like `security-audit` or `research-lab`.)*

---

## Architecture Map

| Layer | Path | Responsibilities |
| :--- | :--- | :--- |
| **Platform ADE Contracts & Core** | [`src/vs/platform/ade/common/`](src/vs/platform/ade/common/) | Control env scrubber (`adeControl.ts`), extensible organization & 4-slot role schema (`adeRoleSchema.ts`), Engineering/Research DAG types & Mermaid+Markdown parser (`adeEngineeringBlueprint.ts`), deterministic keyword scaffolding (`adePromptToDag.ts`), configurable FinOps pricing (`adePricing.ts`), 6 curated Blueprint Recipes (`adeBlueprintTemplates.ts`), PR Verification Report generator (`adeRunReport.ts`), SSH Cloud Host contracts (`adeCloudHosts.ts`). |
| **Platform Node Services** | [`src/vs/platform/ade/node/`](src/vs/platform/ade/node/) | Local `0600` socket / Windows Named Pipe control plane with HMAC capability tokens (`adeControlServer.ts`), Git worktrees (`-c core.hooksPath=/dev/null`), Git-native change detection & scrubbed `verify:` runner (`adeEngineeringService.ts`), non-destructive OpenSSH transport (`adeCloudHostService.ts`, `syncUserSshDir: false`), VS Code SSH migration (`vscodeConfigMigration.ts`). |
| **Workbench ADE UI** | [`src/vs/workbench/contrib/ade/browser/`](src/vs/workbench/contrib/ade/browser/) | Lineage-scoped RBAC handler (`adeControlHandler.ts`), Smart Calm `Sessions` tree & accurate rank-filtered `Inbox` (`adeProjectsView.ts`, `adeInboxView.ts`), Organization & Roles Studio with 4-Slot Binding bar & Rank × API Matrix (`adeRoleStudioEditorPane.ts`), Armored Nested Dual-Shell DAG Studio (`adeEngineeringEditorPane.ts`, `adeEngineeringWorkbenchService.ts`), Safe/Autonomous Status Bar pill & `verify:` revocation QuickPick (`ade.contribution.ts`), Cloud Host Studio & `aexus-ssh://` FS (`adeCloudHostsEditorPane.ts`, `adeCloudHostFileSystemProvider.ts`). |
| **Native Coding Agent Bridges & CLI** | [`extensions/aexus-agents/`](extensions/aexus-agents/) | Centralized child-env isolation (`runtime.ts`), adapters for all 8 native Coding Agents (`claude.ts`, `codex.ts`, `acp.ts`, `kilo.ts`, `pi.ts`), public model discovery (`capabilities.ts`), zero-warmup Turn-1 prompt injection with prompt-hash cache invalidation & auto-compaction recovery (`extension.ts`), opt-out third-party role bridge (`nativeRoleBridge.ts`), and the `aexus-ade` CLI (`src/adeCli.ts`). |

---

## Architectural Invariants

Before opening a PR, please ensure your changes preserve these core invariants:

1. **Pure Execution Isolation (`Reviewer ≠ Executor`) & Subprocess Scrubbing**: Pure execution leaf ranks (`Worker [L4]`, `Builder`, `Agent`) must never receive orchestration prompts or ADE control-plane credentials. All `verify:`, automated `git`, SSH, and helper subprocesses must strip `AEXUS_ADE_*` via `stripAdeControlEnv()`, and automated worktree `git` operations must pass `-c core.hooksPath=/dev/null`.
2. **Server-Enforced Capability Tokens & Lineage RBAC**: Never trust client-supplied `caller` strings on the control plane. Validate `_callerSessionId` against live session state, intersect token rank with live rank, enforce `canRankSupervise` + subtree lineage on `session.*`, require `engineering.destroy` on tree-owner deletion, and verify slot + bound session identity on `engineering.review`.
3. **ADE ⇄ IDE Mirror Symmetry**: Both modes share one unified local + `aexus-ssh://` project catalog, file ordering, open editors, and `Focus → Home ⇄ Forward` navigation state. Never hijack standard VS Code `Cmd/Ctrl+K` chords (`Prompt-to-DAG` uses `Cmd/Ctrl+Shift+K` or `/`).
4. **Non-Destructive Host & Git Hygiene**: Blueprint/runtime state persists outside repos under `~/.aexus-code/engineering/` and `~/.aexus-code/research/`. Worktree lanes use `aexus-eng/*` branches with dirty-tree preflight and preserved user Git identity. `AdeCloudHostNodeService` defaults `syncUserSshDir` to `false` and never mutates global `~/.ssh/config`.
5. **Safe Defaults, Upfront Trust Gates & Version Parity**: Interactive sessions default to safe modes; automated DAGs gate untrusted `verify:` commands upfront before dispatching Workers and confine Codex to `workspace-write` when `aexus.ade.autonomousMode` is `false`. Keep `product.json#aexusVersion`, `extensions/aexus-agents/package.json#version`, and `ADE_CLI_VERSION` in lockstep.
6. **Cross-Platform Parity & Open-Source Hygiene**: Keep Open VSX gallery compliance in `product.json`, preserve MIT headers, and verify behavior across macOS (`arm64`/`x64`), Windows 10/11 (`x64`/`arm64`), and Linux (`x64`/`arm64`).

---

## Full Workbench Development Workflow

For changes touching `src/vs/platform/ade/` or `src/vs/workbench/contrib/ade/`:

```bash
# 1. Install dependencies (uses Node.js matching .nvmrc + pnpm@12.16.0)
./scripts/aexus-env.sh pnpm install

# 2. Fast transpile build (compiles core client + extensions/aexus-agents/dist)
./scripts/aexus-env.sh pnpm run build-fast

# 3. Check environment readiness & installed coding CLIs
./extensions/aexus-agents/bin/aexus-ade doctor

# 4. Run typecheck & ESLint zero-warning gate (platform + workbench + aexus-agents)
./scripts/aexus-env.sh pnpm run typecheck-client
./scripts/aexus-env.sh pnpm exec tsc -p extensions/aexus-agents/tsconfig.json --noEmit
./scripts/aexus-env.sh pnpm exec eslint --max-warnings=0 \
  "src/vs/platform/ade/**/*.ts" \
  "src/vs/workbench/contrib/ade/**/*.ts" \
  "extensions/aexus-agents/src/**/*.ts"

# 5. Run ADE unit tests (Node platform + Electron Browser workbench + Agents/CLI)
./scripts/aexus-env.sh node test/unit/node/index.js --runGlob "vs/platform/ade/test/node/*.test.js"
./scripts/aexus-env.sh ./scripts/test.sh \
  --run src/vs/workbench/contrib/ade/test/browser/adeControlAndViews.test.ts \
  --run src/vs/workbench/contrib/ade/test/browser/adeEngineering.test.ts \
  --run src/vs/workbench/contrib/ade/test/browser/adeProjectsService.test.ts \
  --run src/vs/workbench/contrib/ade/test/browser/cloudHostsBrowser.test.ts
./scripts/aexus-env.sh node --test --experimental-strip-types extensions/aexus-agents/test/*.test.*
```

## Pull Request Checklist

- [ ] Added or updated unit tests covering new behavior, security boundaries, and cross-platform edge cases.
- [ ] Passed `pnpm run typecheck-client`, `tsc -p extensions/aexus-agents/tsconfig.json --noEmit`, `eslint --max-warnings=0` (including `extensions/aexus-agents/src/**/*.ts`), ADE Node tests, ADE Browser Workbench tests, and `extensions/aexus-agents` tests.
- [ ] Verified **Dark Modern**, **Light Modern**, **High Contrast**, and `prefers-reduced-motion` for UI changes.
- [ ] Updated `README.md`, `docs/README.zh-CN.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`, or `examples/blueprints/` if user-facing behavior, blueprints, or CLI commands changed.
