# Changelog

All notable releases and engineering milestones of **Aexus Code** are documented here.

## [1.1.0] - 2026-11-19

### Security, Extensible Organizations, DAG Reliability & Open-Source Packaging Hardening

#### Security & Control-Plane Enforcement
- **Server-Signed Per-Session Capability Tokens (`AEXUS_ADE_SESSION_TOKEN`)**: `AdeControlServer` now holds an in-memory 32-byte HMAC secret and mints signed per-session capability tokens bound to `(sessionId, rank, pure)`. Caller rank is derived exclusively on the server; agents cannot spoof `secretary` or clear env vars to escalate privileges.
- **Centralized 8-Engine Child Env Isolation**: All 8 native engine adapters build child environments through one shared helper. Pure execution Workers (`pureExecution: true`) have control metadata env vars stripped, the bundled `aexus-ade` bin directory removed from `PATH`, and receive an explicit server-signed deny token.
- **Multi-Instance Control Plane Isolation**: Every running instance writes a per-instance `0600` metadata file (`ade-control.<pid>.json`) and binds `AEXUS_ADE_CONTROL_FILE` to its own instance so side-by-side windows never cross-route agent commands.
- **Safe Interactive Defaults & Explicit Autonomous Opt-In**: Interactive sessions default to each engine's safe approval/sandbox mode (`acceptEdits` on Claude, `workspace-write` + `on-request` on Codex, `ask` on Kilo/ACP). Unprompted autonomous mode requires explicit opt-in via `aexus.ade.autonomousMode` (`application`-scoped, `restricted: true`).
- **Workspace Prompt-Injection Defense**: `aexus.ade.organization` and `aexus.ade.engineering.watchdogTimeoutMinutes` are now `application`-scoped and `restricted: true`, ignoring `.vscode/settings.json` workspace overrides from untrusted repositories.
- **SHA-256 Hash-Pinned `verify:` Command Approval**: Blueprint `verify:` shell commands are hash-pinned per project and require explicit human confirmation before running. On POSIX, commands execute via `/bin/sh -c` in a detached process group killed cleanly on timeout.
- **Third-Party Extension Role Bridge Opt-Out**: Added `aexus.ade.nativeExtensionRoleBridge.enabled` (`application`-scoped, `restricted: true`) and `AEXUS_ADE_DISABLE_NATIVE_ROLE_BRIDGE=1`, and documented all hooks transparently in [`SECURITY.md`](SECURITY.md).
- **Least-Privilege Engineering API Split**: Separated `engineering.integrate` (worktree merge/cleanup) and `engineering.destroy` (tree reset/remove) from `engineering.design` as flagged high-privilege (`dangerous: true`) primitives.

#### Organization & Roles Studio ("Everything is Extensible") & Smart Calm UI
- **Organization & Roles Studio**: Full dirty-tracked editor (`isDirty` / `Cmd+S` save / revert) with **5 starter presets** (`default-4tier`, `startup-3tier`, `research-lab`, `security-audit`, `flat-swarm`), custom rank ladders, `{{variables}}` prompt templates, an interactive **Rank × Fixed Kernel API Permission Matrix**, live session migration on rank ID rename, High Contrast & `prefers-reduced-motion` accessibility, and the `aexus-ade role` CLI group (`list`, `apis`, `presets`, `preset`, `reset`, `studio`).
- **Structural Work-Tree Slots**: Engineering and Research DAGs resolve `orchestrator`, `segment_owner`, `reviewer`, and `executor` dynamically from the active organization schema, enabling full DAG execution under 2-tier, 3-tier, 4-tier, and custom presets.
- **Zero-Warmup Turn-1 Injection & Prompt-Hash Invalidation**: Role charters inject inline on Turn 1, commit only after a successful send, re-inject automatically whenever Studio edits change the compiled prompt's SHA-256 hash, and reset cleanly upon engine auto-compaction (`compact_boundary` / `context_compacted`).
- **Smart Calm Sidebar & Rank-Filtered Inbox**: Compact hover-bloom sidebar badges with a 1-click full-badge toggle, and a unified `ADE Inbox` with dynamic schema-driven per-rank filter pills.

#### Deterministic DAG Reliability & FinOps
- **Pre-Dispatch Budget Admission & Clean Ceiling Pause**: Budget pauses route through `pauseTree()` to stop active agents and reset running nodes cleanly to `idle`, paired with pre-dispatch admission checks.
- **Race-Free Node State Updates**: Eliminated stale read-modify-write overwrites across asynchronous `verify:` awaits so concurrent per-node token usage updates are never lost.
- **Git-Native Change Detection & Safe Worktree Lifecycle**: Uses `git status --porcelain=v2 -z` inside Git repos (respecting `.gitignore` with no 12k-file truncation), adds dirty-tree preflight before merge, preserves user Git identity with a `Co-authored-by` trailer, avoids destructive `-B` resets and `-D` branch deletions by default, and pauses with an Inbox alert instead of silently falling back to shared mode if worktree creation fails.
- **Deterministic Guardrails across All 6 Recipes**: Added `max_concurrency`, `files:` scope declarations, and `verify:` checks to all 6 example blueprints (including newly added `bug-hunt-fix.md` and `arch-teardown.md`), plus branch-isolated RED circuit breakers, cumulative diffs, and a 2-stage zero-token-first Watchdog.
- **Configurable FinOps Pricing & Subscription Mode**: Fixed `gpt-5-pro` matching priority, added `aexus.ade.pricing` custom rate-card overrides, and added `aexus.ade.pricing.subscriptionMode` (`$0` marginal cost mode).
- **CI-Ready `aexus-ade doctor` Exit Codes**: Exits `1` on failed checks and `2` on warnings with `--strict`.

#### Open-Source Compliance, Original Branding, Installer & CI/Release
- **Open VSX Registry**: Switched `product.json` `extensionsGallery` from Microsoft Visual Studio Marketplace to [Open VSX](https://open-vsx.org/).
- **Original Aexus Code Geometric Mark**: Replaced the upstream VS Code ribbon icon with an original Aexus geometric A-prism / 3-node DAG mark (`docs/assets/aexus-logo.svg`, `docs/assets/aexus-logo.png`, and the inline 16×16 Secretary mark in `adeProjectsView.ts`).
- **Universal macOS Installer & Honest Toolchain Scripts**: `scripts/aexus-install.sh` auto-detects `arm64`/`x64` (`AEXUS_ARCH` override), makes the optional local keychain helper non-blocking, and falls back to ad-hoc `codesign` when no local signing config is present. `scripts/aexus-env.sh` validates Node against `.nvmrc` and emits actionable errors when Node/pnpm are absent.
- **Real Core CI & Release Workflows**: Pruned upstream Microsoft-only workflows; expanded `.github/workflows/aexus-ci.yml` with `build-fast`, `typecheck-client`, `eslint --max-warnings=0` on all ADE sources, and Node unit tests (`src/vs/platform/ade/test/node/*`); added `.github/workflows/release.yml` for tagged macOS (`arm64`/`x64`), Linux (`x64`), and Windows (`x64`) release artifacts; added English [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/gallery.md`](docs/gallery.md).

---

## [1.0.0] - 2026-11-19

### Initial Public Release

#### Organizational ADE & Visual Engineering / Research DAG Studio
- **Armored Nested Dual-Shell Task Pods (`268×172`)**: Outer supervisory review shell physically enclosing a recessed inner pure-execution core inside auto-partitioned Maximal Non-Branching Path (`MNP`) segment lanes.
- **6 Built-In Blueprint Recipes & `.md` Gallery**: `feature-ship`, `bug-hunt-fix`, `security-audit-swarm`, `safe-migration`, `deep-research-lab`, and `arch-teardown` with mini-SVG topology previews and 3 engine presets (`Balanced`, `Max Quality`, `Fast · $2 Cap`).
- **4-Tier Agent FinOps**: Real-time estimated USD spend, prompt-cache savings (`Cache Saved $`), per-tier/per-lane/per-node telemetry, and `max_budget_usd` ceilings.
- **Git Worktree Sandbox & Merge Workbench**: Per-segment Git worktree branches (`aexus-eng/*`) with in-studio merge/cleanup controls.
- **Execution Gantt, Vector SVG & PR Audit Report**: Wall-clock execution Gantt strip, vector SVG export, and 1-click Markdown PR Verification Report (`Copy PR Report` / `aexus-ade engineering report`).
- **Prompt-to-DAG (`Cmd/Ctrl+K`) & Simulated 0-Token Interactive Demo**: Fast deterministic keyword-to-DAG scaffolding (`<50ms`) plus a simulated `$0.00`-spend interactive demo (`aexus-ade engineering demo`) and `Alt+Cmd/Ctrl+A` `ADE ⇄ IDE` toggle.

#### 8 Native Coding Agent Engines, Control Plane CLI & SSH Cloud Hosts
- Unified local adapters for **Claude Code**, **Codex**, **Google Antigravity**, **Kilo Code**, **OpenCode**, **DeepSeek Harness**, **Cline**, and **Pi**.
- Added `aexus-ade` local control plane CLI (`doctor`, `completion`, `status`, `mode`, `view`, `project`, `host`, `engine`, `session`, `secretary`, `engineering`, `inbox`).
- **Zero-Server SSH Cloud Hosts (`aexus-ssh://`)**: Local + remote multi-OS workspaces over system OpenSSH with VS Code `~/.ssh/config` migration, live two-step remote path browser, remote Git diffs, and hybrid SSH PTY terminals.
- **Cross-Platform Source Builds**: Support for **macOS (`arm64`/`x64`)**, **Windows 10/11 (`x64`/`arm64`)**, and **Linux (`x64`/`arm64`)** across Dark Modern, Light Modern, and High Contrast themes.
