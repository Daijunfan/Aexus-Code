# Aexus Code · Curated Blueprint Recipes

These ready-to-run `.md` DAG blueprints are synchronized 1:1 with the built-in `ADE_BLUEPRINT_TEMPLATES` (`balanced` preset in [`src/vs/platform/ade/common/adeBlueprintTemplates.ts`](../../src/vs/platform/ade/common/adeBlueprintTemplates.ts)). Each recipe showcases Aexus Code's **Extensible Multi-Tier Organization** (mapping `orchestrator`, `segment_owner`, `reviewer`, and `executor` onto your active preset), automatic **Maximal Non-Branching Path (`MNP`)** segment lanes, **Git Worktree Isolation**, **SHA-256 Hash-Pinned `verify:` Pre-Review Checks**, **`files:` Scope Serialization**, **`max_concurrency` Critical-Path Scheduling**, **FinOps Budget Guardrails (`max_budget_usd`)**, and **Human Acceptance Gates**.

## Available Blueprints (All 6 Built-In Recipes)

| Blueprint | Mode | Topology | Isolation | Concurrency | Budget Cap | Default `verify:` | Ideal Use Case |
| :--- | :---: | :--- | :---: | :---: | :---: | :--- | :--- |
| [`feature-ship.md`](feature-ship.md) | `engineering` | `N1 → (N2 ∥ N3 ∥ N4) → U1 → N5` | `worktree` | `3` | `$8.00` | `npm test` | Shipping full-stack features across backend, UI & test tracks in parallel without file collisions |
| [`bug-hunt-fix.md`](bug-hunt-fix.md) | `engineering` | `N1 → (N2 ∥ N3) → N4 → U1` | `shared` | `2` | `$4.00` | `npm test` | Repro-first root-cause debugging with parallel surgical fix & edge-case regression suite |
| [`security-audit-swarm.md`](security-audit-swarm.md) | `engineering` | `(N1 ∥ N2 ∥ N3) → N4 → U1 → N5` | `worktree` | `3` | `$6.00` | `npm test` | Multi-engine threat-model & PR security audit with consolidated remediation & sign-off |
| [`safe-migration.md`](safe-migration.md) | `engineering` | `N1 → (N2 ∥ N3) → U1 → N4` | `worktree` | `2` | `$7.00` | `npm test` | Zero-downtime architecture refactoring with baseline characterization tests & safe rollback |
| [`deep-research-lab.md`](deep-research-lab.md) | `research` | `R1 → (R2 ∥ R3 ∥ R4) → U1 → R5` | `shared` | `3` | `$6.00` | `git status --short` | Multi-track literature synthesis, competing hypothesis ablations & reproducible benchmarks |
| [`arch-teardown.md`](arch-teardown.md) | `research` | `R1 → (R2 ∥ R3) → R4 → U1` | `shared` | `2` | `$5.00` | `git status --short` | Competitive & codebase architecture teardown converging into a decision-ready engineering RFC |

## Deterministic Guardrail Fields

Every recipe in this directory includes all deterministic blueprint guardrail fields:

- **`max_budget_usd`** (`## Tree Metadata`): automatically applied when selecting a recipe, enforcing pre-dispatch budget admission and post-turn ceiling pauses (`pauseTree`).
- **`max_concurrency`** (`## Tree Metadata`): caps simultaneous active task pods; ready nodes are prioritized along the graph's **critical path**.
- **`files:`** (per task node): declares glob ownership boundaries (`src/services/**`, `test/**`, etc.). In `shared` workspace isolation, nodes with overlapping scopes are serialized automatically to prevent concurrent edit collisions.
- **`verify:`** (tree default + per task node): runs a deterministic shell check in a scrubbed environment (`AEXUS_ADE_*` stripped, detached process group on POSIX, `cmd.exe /d /s /c` on Windows) after the Pure Executor finishes and **before** waking the Adversarial Reviewer.
- **`org_preset`** *(optional in `## Tree Metadata`)*: pairs a shareable blueprint with a matching Organization Preset (e.g., `security-audit`, `research-lab`, `startup-3tier`).

> [!IMPORTANT]
> **Upfront SHA-256 Hash-Pinned `verify:` Approval & Revocation**: Imported or agent-modified `verify:` commands are checked **upfront before any Worker runs** — never wasting tokens before consent. Aexus Code pins trusted commands by SHA-256 hash per project and lets you inspect or revoke them anytime via **`Aexus ADE: Manage Trusted Verify Commands...`** or `aexus-ade engineering verify-trust list|revoke`. Customize placeholder `verify:` and `files:` globs to match your repository.

> [!NOTE]
> **Local Git Workspace Requirement**: Engineering and Research DAG worktrees currently require a local Git repository. Interactive ADE sessions, remote editing, Git diffs, and SSH terminals work directly on `aexus-ssh://` Cloud Host projects.

## Usage

### Option 1: One-Click inside Aexus Code UI
1. Open any top-level orchestrator (`Governor` in 4-tier, `Tech Lead` in 3-tier, or `Coordinator` in 2-tier) on a local Git workspace in **ADE** mode and right-click → **Engineering** (or **Research**).
2. Click **`Recipes`** in the DAG Studio toolbar.
3. Choose any of the 6 recipes, pick an engine preset (`Balanced` / `Max Quality` / `Fast · $2 Cap`), and click **`Apply Recipe`**.

### Option 2: Scriptable CLI (`aexus-ade`)
```bash
# List all 6 built-in recipes
aexus-ade engineering template list

# Apply directly from the built-in gallery (enforces recipe max_budget_usd automatically)
aexus-ade engineering template apply --governor "$GOV_ID" --template feature-ship --preset balanced --isolation worktree --max-budget-usd 8

# Or apply any custom/shared Markdown blueprint file directly
aexus-ade engineering blueprint apply --governor "$GOV_ID" --file ./examples/blueprints/feature-ship.md

# Manage trusted verify: command hashes before or after a run
aexus-ade engineering verify-trust list

# Run the DAG and export a GitHub PR-ready Verification & FinOps Report
aexus-ade engineering run --governor "$GOV_ID"
aexus-ade engineering report --governor "$GOV_ID" --out ./verification-report.md
```

Want to share your own workflow recipe? See the **[Contribute a Blueprint Recipe](../../CONTRIBUTING.md#contribute-a-blueprint-recipe)** guide!
