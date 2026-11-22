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

Shareable Mission DAG blueprints (`examples/blueprints/*.md`) are one of the highest-leverage ways to contribute domain workflows (e.g., Kubernetes upgrades, Rust perf profiling, data-pipeline migrations, or paper replications).

1. **Author the Markdown Blueprint** in [`examples/blueprints/`](examples/blueprints/README.md):
   - Include a fenced ```` ```mermaid ```` block starting with `flowchart LR` using clean node labels, `@EmployeeName:` context-reuse tags where appropriate, `U1{{"..."}}` human gates, and optional `-->|fail|` fallback edges.
   - Do **not** embed legacy `worker=engine:thinking` pipes inside node labels or legacy `## Tree Metadata` sections.
   - Add a `## Node Pre-Prompts` section documenting the concrete pre-prompt for every node (`### N1`, `### N2`, …).
   - Add a summary row in [`examples/blueprints/README.md`](examples/blueprints/README.md).
2. **Validate Before Opening a PR**:
   ```bash
   # Validate Mermaid DAG syntax via the standalone parser tests
   ./scripts/aexus-env.sh node test/unit/node/index.js \
     --runGlob "vs/platform/ade/test/node/adeMissionDag.test.js"

   # Or validate a single blueprint against a running workbench
   aexus-ade mission blueprint validate --file ./examples/blueprints/<recipe-id>.md
   ```

---

## Architecture Map

| Layer | Path | Responsibilities |
| :--- | :--- | :--- |
| **Platform ADE Contracts & Core** | [`src/vs/platform/ade/common/`](src/vs/platform/ade/common/) | Control env scrubber (`adeControl.ts`), extensible organization & 4-slot role schema (`adeRoleSchema.ts`), Mission Mermaid DAG parser, `@Employee:` context reuse, auto-layout & orthogonal edge router (`adeMissionDag.ts`, `adeMissionEmployee.ts`), Mission Token Bus engine (`adeMissionEngine.ts`), Factory Wall boundary (`adeMissionBoundary.ts`), dynamic rank resize & single-copy docs catalog (`adeRankResize.ts`, `adeDocsCatalog.ts`, `adeApiRegistry.ts`), SSH Cloud Host contracts (`adeCloudHosts.ts`). |
| **Platform Node Services** | [`src/vs/platform/ade/node/`](src/vs/platform/ade/node/) | Local `0600` socket / Windows Named Pipe / loopback TCP control plane with HMAC capability tokens (`adeControlServer.ts`), single-copy API docs & Inbox persistence (`adeDocsBackendService.ts`, `adeDocsSync.ts`), zero-token Mission watchdog probes (`adeMissionWatchdogService.ts`), non-destructive OpenSSH transport (`adeCloudHostService.ts`, `syncUserSshDir: false`), VS Code SSH migration (`vscodeConfigMigration.ts`). |
| **Workbench ADE UI & Mission Runtime** | [`src/vs/workbench/contrib/ade/browser/`](src/vs/workbench/contrib/ade/browser/) | Lineage-scoped RBAC & Token Bus handlers (`adeControlHandler.ts`, `adeMissionControlHandler.ts`, `adeRankApiHandler.ts`), Mission store & live runtime (`adeMissionStore.ts`, `adeMissionRuntime.ts`), modular high-performance Mission Canvas (`adeEngineeringEditorPane.ts`, `adeMissionHostCatalog.ts`, `adeMissionFileDrawer.ts`, `adeMissionPopovers.ts`, `adeMissionCanvasRenderer.ts`), Smart Calm `Sessions` tree & rank-filtered `Inbox` (`adeProjectsView.ts`, `adeInboxView.ts`), Organization & Roles Studio (`adeRoleStudioEditorPane.ts`), Cloud Host Studio & `aexus-ssh://` FS (`adeCloudHostsEditorPane.ts`, `adeCloudHostFileSystemProvider.ts`). |
| **Native Coding Agent Bridges & CLI** | [`extensions/aexus-agents/`](extensions/aexus-agents/) | Centralized child-env isolation (`runtime.ts`), adapters for all 8 native Coding Agents (`claude.ts`, `codex.ts`, `acp.ts`, `kilo.ts`, `pi.ts`), public model discovery (`capabilities.ts`), zero-warmup Turn-1 prompt injection with prompt-hash cache invalidation & auto-compaction recovery (`extension.ts`), opt-out third-party role bridge (`nativeRoleBridge.ts`), and the `aexus-ade` CLI (`src/adeCli.ts`). |

---

## Architectural Invariants

Before opening a PR, please ensure your changes preserve these core invariants:

1. **Pure Execution Isolation & Subprocess Scrubbing**: Interactive pure execution leaf ranks (`Worker [L4]`, `Builder`, `Agent`) must never receive orchestration prompts or ADE control-plane credentials; in-graph pure Mission nodes may only call `token.*`, `whoami`, `docs.read`, and `api.update`. All SSH, watchdog, and helper subprocesses must strip `AEXUS_ADE_*` via `stripAdeControlEnv()`.
2. **Server-Enforced Capability Tokens & Strictly Top-Down Lineage RBAC**: Never trust client-supplied `caller` strings on the control plane. Validate `_callerSessionId` against live session state, intersect token rank with live rank, enforce `canRankSupervise` + subtree lineage on `session.*` and `org.*`, enforce the Factory Wall on Mission actions, and require `mission.destroy` on Mission-owner deletion.
3. **ADE ⇄ IDE Mirror Symmetry**: Both modes share one unified local + `aexus-ssh://` project catalog, file ordering, open editors, and `Focus → Home ⇄ Forward` navigation state.
4. **Non-Destructive Host & Settings Hygiene**: `AdeCloudHostNodeService` defaults `syncUserSshDir` to `false` and never mutates global `~/.ssh/config`. Security-critical settings (`aexus.ade.organization`, `aexus.ade.autonomousMode`, `aexus.ade.nativeExtensionRoleBridge.enabled`) stay `scope: application` and `restricted: true`.
5. **Version Parity & Open-Source Hygiene**: Keep `product.json#aexusVersion`, `extensions/aexus-agents/package.json#version`, and `ADE_CLI_VERSION` in strict lockstep, keep Open VSX gallery compliance in `product.json`, preserve MIT headers, and verify behavior across macOS (`arm64`/`x64`), Windows (`x64`/`arm64`), and Linux (`x64`/`arm64`).

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
  --run src/vs/workbench/contrib/ade/test/browser/adeProjectsService.test.ts \
  --run src/vs/workbench/contrib/ade/test/browser/cloudHostsBrowser.test.ts
./scripts/aexus-env.sh node --test --experimental-strip-types extensions/aexus-agents/test/*.test.*
```

## Pull Request Checklist

- [ ] Added or updated unit tests covering new behavior, security boundaries, and cross-platform edge cases.
- [ ] Passed `pnpm run typecheck-client`, `tsc -p extensions/aexus-agents/tsconfig.json --noEmit`, `eslint --max-warnings=0` (including `extensions/aexus-agents/src/**/*.ts`), ADE Node tests, ADE Browser Workbench tests, and `extensions/aexus-agents` tests.
- [ ] Verified **Dark Modern**, **Light Modern**, **High Contrast**, and `prefers-reduced-motion` for UI changes.
- [ ] Updated `README.md`, `docs/README.zh-CN.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`, or `examples/blueprints/` if user-facing behavior, blueprints, or CLI commands changed.
