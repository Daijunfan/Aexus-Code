# Aexus Code · Curated Blueprint Recipes

These ready-to-run `.md` DAG blueprints showcase Aexus Code's **4-Tier Organizational Hierarchy** (`Governor L1 → Manager L2 → Employee L3 Reviewer → Worker L4 Executor`), automatic **Maximal Non-Branching Path (`MNP`)** segment lanes, **Git Worktree Isolation**, **Hard `$USD` Budget Guardrails**, and **Human Acceptance Gates**.

## Available Blueprints

| Blueprint | Mode | Topology | Isolation | Budget Cap | Ideal Use Case |
| :--- | :---: | :--- | :---: | :---: | :--- |
| [`feature-ship.md`](feature-ship.md) | `engineering` | `N1 → (N2 ∥ N3 ∥ N4) → U1 → N5` | `worktree` | `$8.00` | Shipping full-stack features across backend, UI & test tracks in parallel without file collisions |
| [`security-audit-swarm.md`](security-audit-swarm.md) | `engineering` | `(N1 ∥ N2 ∥ N3) → N4 → U1 → N5` | `worktree` | `$6.00` | Multi-engine threat-model & PR security audit with consolidated remediation & sign-off |
| [`safe-migration.md`](safe-migration.md) | `engineering` | `N1 → (N2 ∥ N3) → U1 → N4` | `worktree` | `$7.00` | Zero-downtime architecture refactoring with baseline characterization tests & safe rollback |
| [`deep-research-lab.md`](deep-research-lab.md) | `research` | `R1 → (R2 ∥ R3 ∥ R4) → U1 → R5` | `shared` | `$6.00` | Multi-track literature synthesis, competing hypothesis ablations & reproducible benchmarks |

## Usage

### Option 1: One-Click inside Aexus Code UI
1. Open any `Governor (L1)` session in **ADE** mode and right-click → **Engineering** (or **Research**).
2. Click **`Recipes`** in the DAG Studio toolbar.
3. Choose a recipe, pick an engine preset (`Balanced` / `Max Quality` / `Fast · $2 Cap`), and click **`Apply Recipe`**.

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
