# Aexus Code · Curated Blueprint Recipes

These ready-to-run `.md` DAG blueprints showcase Aexus Code's **Extensible Multi-Tier Organization** (default `Governor L1 → Manager L2 → Employee L3 Reviewer → Pure Worker L4`, or any custom preset mapped via structural work-tree slots), automatic **Maximal Non-Branching Path (`MNP`)** segment lanes, **Git Worktree Isolation**, **Deterministic Pre-Review `verify:` Checks**, **`files:` Scope Serialization**, **`max_concurrency` Scheduling**, **Budget Guardrails**, and **Human Acceptance Gates**.

## Available Blueprints (All 6 Built-In Recipes)

| Blueprint | Mode | Topology | Isolation | Concurrency | Budget Cap | Ideal Use Case |
| :--- | :---: | :--- | :---: | :---: | :---: | :--- |
| [`feature-ship.md`](feature-ship.md) | `engineering` | `N1 → (N2 ∥ N3 ∥ N4) → U1 → N5` | `worktree` | `3` | `$8.00` | Shipping full-stack features across backend, UI & test tracks in parallel without file collisions |
| [`bug-hunt-fix.md`](bug-hunt-fix.md) | `engineering` | `N1 → (N2 ∥ N3) → N4 → U1` | `shared` | `2` | `$4.00` | Repro-first root-cause debugging with parallel surgical fix & edge-case regression suite |
| [`security-audit-swarm.md`](security-audit-swarm.md) | `engineering` | `(N1 ∥ N2 ∥ N3) → N4 → U1 → N5` | `worktree` | `3` | `$6.00` | Multi-engine threat-model & PR security audit with consolidated remediation & sign-off |
| [`safe-migration.md`](safe-migration.md) | `engineering` | `N1 → (N2 ∥ N3) → U1 → N4` | `worktree` | `2` | `$7.00` | Zero-downtime architecture refactoring with baseline characterization tests & safe rollback |
| [`deep-research-lab.md`](deep-research-lab.md) | `research` | `R1 → (R2 ∥ R3 ∥ R4) → U1 → R5` | `shared` | `3` | `$6.00` | Multi-track literature synthesis, competing hypothesis ablations & reproducible benchmarks |
| [`arch-teardown.md`](arch-teardown.md) | `research` | `R1 → (R2 ∥ R3) → R4 → U1` | `shared` | `2` | `$5.00` | Competitive & codebase architecture teardown converging into a decision-ready engineering RFC |

## Deterministic Guardrail Fields

Every recipe in this directory includes the three deterministic blueprint guardrail fields:

- **`max_concurrency`** (`## Tree Metadata`): caps simultaneous active task pods; ready nodes are prioritized along the graph's **critical path**.
- **`files:`** (per task node): declares glob ownership boundaries (`src/server/**`, `test/**`, etc.). In `shared` workspace isolation, nodes with overlapping scopes are automatically serialized to prevent concurrent edit collisions.
- **`verify:`** (per task node): runs a deterministic shell check (such as `npm run typecheck && npm test`) after the Worker finishes and **before** waking the `Employee` reviewer, saving review tokens on failing builds.

> [!IMPORTANT]
> **SHA-256 Hash-Pinned `verify:` Approval**: Imported or agent-modified `verify:` commands never run silently. Aexus Code pins every `verify:` command by SHA-256 hash per project and prompts you to inspect and explicitly approve the exact shell commands before execution. Customize the placeholder `verify:` and `files:` values in each blueprint to match your repository's scripts and folder layout.

## Usage

### Option 1: One-Click inside Aexus Code UI
1. Open any top-level orchestrator (`Governor` in 4-tier, `Tech Lead` in 3-tier, or `Coordinator` in 2-tier) in **ADE** mode and right-click → **Engineering** (or **Research**).
2. Click **`Recipes`** in the DAG Studio toolbar.
3. Choose any of the 6 recipes, pick an engine preset (`Balanced` / `Max Quality` / `Fast · $2 Cap`), and click **`Apply Recipe`**.

### Option 2: Scriptable CLI (`aexus-ade`)
```bash
# List all 6 built-in recipes
aexus-ade engineering template list

# Apply directly from the built-in gallery
aexus-ade engineering template apply --governor "$GOV_ID" --template feature-ship --preset balanced --worktree --max-budget-usd 8

# Or apply any custom/shared Markdown blueprint file directly
aexus-ade engineering blueprint apply --governor "$GOV_ID" --file ./examples/blueprints/feature-ship.md

# Run the DAG and export a GitHub PR-ready Verification & FinOps Report
aexus-ade engineering run --governor "$GOV_ID"
aexus-ade engineering report --governor "$GOV_ID" --out ./verification-report.md
```
