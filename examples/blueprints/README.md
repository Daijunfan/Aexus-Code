# Aexus Code · Dual-View Engineering Blueprint Recipes

These ready-to-apply Markdown blueprints follow Aexus Code's **Dual-View Engineering Architecture**:

1. **Mission Task DAG (`## Mission Task DAG`)** — Strictly acyclic Mermaid flowchart parsed by [`parseMissionMermaidDag`](../../src/vs/platform/ade/common/adeMissionDag.ts), defining deliverable milestones, upstream dependency gates (`INCOMPLETE_DEPENDENCIES`), Human Approval Gates (`U1{{"..."}}`), optional `%% task` completion authority & deterministic `completionContract` guardrails (`--require-checks`, `--require-files`, `--require-artifact`, `--require-whiteboard`), and `%% check` zero-token verification hooks.
2. **All-Staff Cyclic Orchestration Team (`## Orchestration Team`)** — Persistent cyclic Mermaid org topology parsed by [`parseOrchestrationGraph`](../../src/vs/platform/ade/common/adeOrchestrationGraph.ts), placing every rank (`L1..LN`) on one canvas with 1-to-1 employee uniqueness, `<-->` bidirectional review loops, disjoint `paths="..."` file-scope boundaries, department `subgraph` wings, and Department Shared Whiteboards (`%% whiteboard` with `--toc` / `--section` budgeted reads).
3. **Token-Driven Task Specifications (`## Task Specifications`)** — Extracted automatically by `aexus-ade mission blueprint apply` into per-task specifications (`### T1..TN`, `### U1`) and delivered dynamically via lightweight `otok-*` baton tokens (`token mint|split --wait-join [--scope-paths ... --join-mode quorum]|return --complete-task|handoff|reject --category ...|fail|retry`), durable `mission checkpoint` snapshots, and `mission diagnostics`.

> [!NOTE]
> **Native Employee APIs vs. Engineering Canvas Staff APIs**:
> - `aexus-ade session create|attach|send|move|role|configure|delete` are **native core ADE APIs** for regular hierarchical employee sessions outside Engineering.
> - Adding, configuring, or removing an employee **node on an Engineering Orchestration canvas** requires the Engineering-exclusive APIs: `aexus-ade orchestration staff create|config|rename|remove --mission <id> ...` (or `orchestration apply|load`).

## Available Dual-View Blueprints (All 6 Curated Recipes)

| Blueprint | Mission Task DAG | Orchestration Staff Roles | Ideal Use Case |
| :--- | :--- | :--- | :--- |
| [`feature-ship.md`](feature-ship.md) | `T1 → (T2 ∥ T3 ∥ T4) → U1 → T5` | `Architect (L1)`, `Backend (L2)`, `Frontend (L2)`, `QA (L3)` | Contract-first full-stack delivery with parallel Backend/UI/QA tracks + Release Gate |
| [`bug-hunt-fix.md`](bug-hunt-fix.md) | `T1 → (T2 ∥ T3) → T4 → U1` | `LeadDebugger (L1)`, `FixDev (L2)`, `QA (L3)`, `Auditor (L2)` | Repro-first root-cause debugging with surgical fix, edge-case regression suite & audit |
| [`security-audit-swarm.md`](security-audit-swarm.md) | `(T1 ∥ T2 ∥ T3) → T4 → U1 → T5` | `AuditLead (L1)`, `AuthAudit (L2)`, `IpcAudit (L2)`, `SupplyAudit (L2)`, `Hardening (L3)` | Multi-track auth, IPC & supply-chain threat audit converging into hardened patches |
| [`safe-migration.md`](safe-migration.md) | `T1 → (T2 ∥ T3) → U1 → T4` | `Architect (L1)`, `CoreDev (L2)`, `CallerDev (L2)`, `Verifier (L3)` | Characterization-tested refactor with rollback verification gate & legacy cleanup |
| [`deep-research-lab.md`](deep-research-lab.md) | `R1 → (R2 ∥ R3 ∥ R4) → U1 → R5` | `PI (L1)`, `TrackA (L2)`, `TrackB (L2)`, `Bench (L3)` | Multi-track hypothesis probing, counter-baseline ablations & quantitative benchmark synthesis |
| [`arch-teardown.md`](arch-teardown.md) | `R1 → (R2 ∥ R3) → R4 → U1` | `Architect (L1)`, `Systems (L2)`, `UX (L2)`, `Reviewer (L3)` | Parallel codebase & UX teardown converging into a decision-ready Engineering RFC |

## Usage

### Option 1: Directly in the Dual-View Engineering Canvas
1. Create or open an Engineering workspace (`ADE` → **New Engineering** / `aexus-ade mission init --title "Feature Ship" --open`).
2. Run `aexus-ade mission blueprint apply --mission <id> --file ./examples/blueprints/feature-ship.md` (or paste into the top-left **Source Drawer**), which populates **both** the Mission Task DAG, the Orchestration Team + Whiteboards, and all `### <TaskId>` descriptions.
3. Configure each staff node's **Host**, **Engine**, and **Model/Thinking**, then chat directly with your `L1` lead (auto-minting a root `otok-*` baton) or run `aexus-ade orchestration dispatch`!

### Option 2: Scriptable CLI (`aexus-ade`)
```bash
# 1. Initialize an Engineering workspace
MISSION_ID=$(aexus-ade mission init --title "Feature Ship" --open --json | jq -r .id)

# 2. Validate & apply Task DAG + Orchestration Team + Whiteboards + Task Specifications in ONE call
aexus-ade mission blueprint validate --file ./examples/blueprints/feature-ship.md --json
aexus-ade mission blueprint apply --mission "$MISSION_ID" --file ./examples/blueprints/feature-ship.md

# 3. Configure cycle, silence cadence & FinOps budget guardrails + capture baseline checkpoint
aexus-ade orchestration limits --mission "$MISSION_ID" --max-hops 48 --budget 15 --silence 10 --json
aexus-ade mission checkpoint create --mission "$MISSION_ID" --label "initial-blueprint" --json

# 4. Optional: dynamically add a new employee node inside the Engineering canvas
aexus-ade orchestration staff create --mission "$MISSION_ID" --name "Perf Engineer" --rank L3 --department Backend --engine codex --json

# 5. Dispatch the initial requirement wave onto the L1 Orchestration lead (or chat directly with L1!)
aexus-ade orchestration dispatch --mission "$MISSION_ID" --prompt "Deliver Feature X per T1..T5" --task T1 --json

# 6. Inspect compact Dual-View state, critical-path diagnostics & approve Human Gate U1 when ready (User L-1 / Secretary L0)
aexus-ade orchestration status --mission "$MISSION_ID" --json
aexus-ade mission diagnostics --mission "$MISSION_ID" --json
aexus-ade mission task list --mission "$MISSION_ID" --json
aexus-ade mission task complete --mission "$MISSION_ID" --node U1 --note "Release gate approved by User"
```

Want to share your own Dual-View workflow recipe? See the **[Contribute a Blueprint Recipe](../../CONTRIBUTING.md#contribute-a-blueprint-recipe)** guide!
