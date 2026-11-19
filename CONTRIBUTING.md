# Contributing to Aexus Code

Thank you for your interest in contributing to **Aexus Code** — the open-source Organizational Agent Development Environment (ADE) & Mirror-Symmetric IDE built on `Code - OSS`.

For a deeper technical walkthrough of subsystems and trust boundaries, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`SECURITY.md`](SECURITY.md).

## Architecture Map

| Layer | Path | Responsibilities |
| :--- | :--- | :--- |
| **Platform ADE Contracts & Core** | [`src/vs/platform/ade/common/`](src/vs/platform/ade/common/) | Extensible organization & role schema (`adeRoleSchema.ts`), Engineering/Research DAG types & Mermaid+Markdown blueprint parser (`adeEngineeringBlueprint.ts`), deterministic keyword scaffolding (`adePromptToDag.ts`), configurable FinOps pricing (`adePricing.ts`), 6 curated Blueprint Recipes (`adeBlueprintTemplates.ts`), PR Verification Report generator (`adeRunReport.ts`), SSH Cloud Host contracts (`adeCloudHosts.ts`). |
| **Platform Node Services** | [`src/vs/platform/ade/node/`](src/vs/platform/ade/node/) | Local `0600` socket / Windows Named Pipe control plane with server-signed HMAC capability tokens (`adeControlServer.ts`), Git worktrees, Git-native change detection & detached `verify:` runner (`adeEngineeringService.ts`), OpenSSH transport (`adeCloudHostService.ts`), non-destructive VS Code SSH migration (`vscodeConfigMigration.ts`). |
| **Workbench ADE UI** | [`src/vs/workbench/contrib/ade/browser/`](src/vs/workbench/contrib/ade/browser/) | Smart Calm `Sessions` tree & rank-filtered `Inbox` (`adeProjectsView.ts`, `adeInboxView.ts`), Organization & Roles Studio with Rank × API Matrix (`adeRoleStudioEditorPane.ts`), interactive Armored Nested Dual-Shell DAG Studio (`adeEngineeringEditorPane.ts`, `adeEngineeringWorkbenchService.ts`), Cloud Host Studio (`adeCloudHostsEditorPane.ts`), `aexus-ssh://` filesystem provider (`adeCloudHostFileSystemProvider.ts`). |
| **Native Coding Agent Bridges & CLI** | [`extensions/aexus-agents/`](extensions/aexus-agents/) | Centralized child-env isolation (`runtime.ts`), adapters for all 8 native Coding Agents (Claude Code, Codex, Antigravity, Kilo Code, OpenCode, DeepSeek Harness, Cline, Pi), zero-warmup Turn-1 prompt injection with prompt-hash cache invalidation & auto-compaction recovery (`extension.ts`), opt-out third-party role bridge (`nativeRoleBridge.ts`), and the `aexus-ade` CLI (`src/adeCli.ts`). |

## Architectural Invariants

Before opening a PR, please ensure your changes preserve these core invariants:

1. **Pure Execution Isolation (`Reviewer ≠ Executor`)**: Pure execution leaf ranks (`Worker [L4]`, `Builder`, `Agent`) must never receive orchestration prompts or ADE control-plane credentials. Their child environment strips control files and `aexus-ade` from `PATH` and carries a server-signed deny token.
2. **Server-Enforced Capability Tokens**: Never trust client-supplied `caller` strings on the control plane. Rank identity is derived exclusively server-side from HMAC-signed `AEXUS_ADE_SESSION_TOKEN` tokens.
3. **ADE ⇄ IDE Mirror Symmetry**: Both modes share one unified local + `aexus-ssh://` project catalog, file ordering, open editors, and `Focus → Home ⇄ Forward` navigation state.
4. **Clean Workspace State & Honest Git Worktrees**: Blueprint and runtime state persists under `~/.aexus-code/engineering/` and `~/.aexus-code/research/`. When `worktree` isolation is enabled, parallel lanes operate on dedicated `aexus-eng/*` Git branches with dirty-tree preflight, preserved user Git identity (`Co-authored-by` trailer), and explicit human merge/cleanup controls.
5. **Safe Defaults & Trust Gates**: Interactive sessions default to safe engine modes; workspace `.vscode/settings.json` must never override `aexus.ade.organization` or `aexus.ade.autonomousMode`; blueprint `verify:` commands require SHA-256 hash-pinned human approval.
6. **Cross-Platform Parity & Open-Source Hygiene**: Keep Open VSX gallery compliance in `product.json`, preserve MIT headers, and verify behavior across macOS (`arm64`/`x64`), Windows 10/11 (`x64`/`arm64`), and Linux (`x64`/`arm64`).

## Development Workflow

```bash
# 1. Install dependencies (uses Node.js matching .nvmrc + pnpm@12.16.0)
./scripts/aexus-env.sh pnpm install

# 2. Fast transpile build (compiles core client + extensions/aexus-agents/dist)
./scripts/aexus-env.sh pnpm run build-fast

# 3. Check environment readiness & installed coding CLIs (after build-fast)
./extensions/aexus-agents/bin/aexus-ade doctor
# Or standalone before building:
node --experimental-strip-types extensions/aexus-agents/src/adeCli.ts doctor

# 4. Run typecheck & lint
./scripts/aexus-env.sh pnpm run typecheck-client
./scripts/aexus-env.sh pnpm exec tsc -p extensions/aexus-agents/tsconfig.json --noEmit
./scripts/aexus-env.sh pnpm exec eslint --max-warnings=0 "src/vs/platform/ade/**/*.ts" "src/vs/workbench/contrib/ade/**/*.ts"

# 5. Run ADE unit tests (Node platform + Browser workbench + Agents/CLI)
./scripts/aexus-env.sh node test/unit/node/index.js --runGlob "vs/platform/ade/test/node/*.test.js"
./scripts/aexus-env.sh ./scripts/test.sh --run src/vs/workbench/contrib/ade/test/browser/adeEngineering.test.ts
./scripts/aexus-env.sh node --test --experimental-strip-types extensions/aexus-agents/test/*.test.*
```

## Pull Request Checklist

- [ ] Added or updated unit tests covering new behavior, security boundaries, and edge cases.
- [ ] Passed `pnpm run typecheck-client`, `eslint --max-warnings=0`, ADE Node tests, and `extensions/aexus-agents` tests.
- [ ] Verified **Dark Modern**, **Light Modern**, **High Contrast**, and `prefers-reduced-motion` for UI changes.
- [ ] Updated `README.md`, `docs/README.zh-CN.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`, or `examples/blueprints/` if user-facing behavior or CLI commands changed.
