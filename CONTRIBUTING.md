# Contributing to Aexus Code

Thank you for your interest in contributing to **Aexus Code** — the open-source Organizational Agent Development Environment (ADE) & Mirror-Symmetric IDE built on `Code - OSS`.

## Architecture Map

| Layer | Path | Responsibilities |
| :--- | :--- | :--- |
| **Platform ADE Contracts & Core** | [`src/vs/platform/ade/common/`](src/vs/platform/ade/common/) | Engineering/Research DAG types, hybrid Mermaid+Markdown blueprint parser/serializer (`adeEngineeringBlueprint.ts`), 4-tier FinOps USD pricing (`adePricing.ts`), curated Blueprint Recipes (`adeBlueprintTemplates.ts`), PR Verification Report generator (`adeRunReport.ts`), SSH Cloud Host contracts (`adeCloudHosts.ts`). |
| **Platform Node Services** | [`src/vs/platform/ade/node/`](src/vs/platform/ade/node/) | Local `0600` socket / Windows Named Pipe control plane (`adeControlServer.ts`), Git worktree & diff backend (`adeEngineeringService.ts`), multiplexed OpenSSH transport (`adeCloudHostService.ts`), non-destructive VS Code SSH migration (`vscodeConfigMigration.ts`). |
| **Workbench ADE UI** | [`src/vs/workbench/contrib/ade/browser/`](src/vs/workbench/contrib/ade/browser/) | 4-tier `Sessions` tree & triage `Inbox` (`adeProjectsView.ts`, `adeInboxView.ts`), interactive Armored Nested Pod DAG Studio (`adeEngineeringEditorPane.ts`, `media/adeEngineeringStudio.css`), orchestration runtime (`adeEngineeringWorkbenchService.ts`), Cloud Host Studio (`adeCloudHostsEditorPane.ts`), `aexus-ssh://` filesystem provider (`adeCloudHostFileSystemProvider.ts`). |
| **Native Coding Agent Bridges & CLI** | [`extensions/aexus-agents/`](extensions/aexus-agents/) | Adapters for all 8 native Coding Agents (Claude Code, Codex, Antigravity, Kilo Code, OpenCode, DeepSeek Harness, Cline, Pi), zero-latency role warmup bridges, and the `aexus-ade` CLI (`src/adeCli.ts`). |

## Architectural Invariants

Before opening a PR, please ensure your changes preserve these core invariants:

1. **`Employee (L3) ≠ Worker (L4)`**: `Worker (L4)` is always a 100% clean, native Coding Agent execution tier with zero ADE orchestration prompt injection or subordinate APIs. `Employee (L3)` is strictly supervisory / acceptance-review.
2. **ADE ⇄ IDE Mirror Symmetry**: Both modes share one unified local + `aexus-ssh://` project catalog, file ordering, open editors, and `Focus → Home ⇄ Forward` navigation state.
3. **Zero Repository Pollution**: Engineering and Research DAG state persists strictly under `~/.aexus-code/engineering/` and `~/.aexus-code/research/`, never creating tracking clutter inside user repositories.
4. **Local-First & Zero Credential Exposure**: Control plane communication uses `0600` local Unix sockets (macOS/Linux) or authenticated Windows Named Pipes. SSH migration never reads or copies private keys.
5. **Cross-Platform Parity**: All core services, CLI launchers, and worktree/SSH helpers must work cleanly across macOS (`arm64`/`x64`), Windows 10/11 (`x64`/`arm64`), and Linux (`x64`/`arm64`).

## Development Workflow

```bash
# 1. Install dependencies (uses pinned Node.js + pnpm)
./scripts/aexus-env.sh pnpm install

# 2. Fast transpile build
./scripts/aexus-env.sh pnpm run build-fast

# 3. Check environment readiness & installed coding CLIs
./extensions/aexus-agents/bin/aexus-ade doctor

# 4. Run typecheck & lint
./scripts/aexus-env.sh pnpm run typecheck-client
./scripts/aexus-env.sh pnpm exec eslint --max-warnings=0 <modified-files>

# 5. Run ADE unit tests
./scripts/aexus-env.sh ./scripts/test.sh --run src/vs/workbench/contrib/ade/test/browser/adeEngineering.test.ts
./scripts/aexus-env.sh node --test --experimental-strip-types extensions/aexus-agents/test/*.test.*
```

## Pull Request Checklist

- [ ] Added or updated unit tests covering new behavior and edge cases.
- [ ] Passed `pnpm run typecheck-client` and `eslint --max-warnings=0` on all modified files.
- [ ] Verified both **Dark Modern** and **Light Modern** themes (plus **High Contrast** & `prefers-reduced-motion` for UI changes).
- [ ] Updated `README.md` / `docs/README.zh-CN.md` / `examples/blueprints/` if user-facing features or CLI commands changed.
