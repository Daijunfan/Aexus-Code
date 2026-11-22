# Aexus Code · Mission Blueprint Recipes

These ready-to-apply Markdown blueprints use Aexus Code's **Pure Mermaid DAG** syntax (parsed directly by [`parseMissionMermaidDag`](../../src/vs/platform/ade/common/adeMissionDag.ts)) paired with **Per-Node Pre-Prompts** stored in the Mission Store. Each recipe demonstrates:

- **Flat Layered DAG Choreography**: Parallel fan-out, convergence joins, and explicit `-->|fail|` fallback routes.
- **Same-Employee Context Reuse (`@Employee:`)**: Assigning multiple DAG positions to the same employee (`@Backend:`, `@Reviewer:`, etc.) reuses one continuous agent session across stages instead of cold-starting from scratch.
- **Human Acceptance Gates (`U1{{...}}`)**: Explicit release/review checkpoints with approve or directed rollback via `aexus-ade mission gate` or the Mission Canvas.
- **Factory Wall & Token Bus**: In-graph execution nodes communicate exclusively via the Token Bus (`aexus-ade token complete|reject|block|fail`), while off-graph tiers (`L1` / `L2`) supervise top-down (`org.*`) and patch topology (`mission.patch`).

## Available Blueprints (All 6 Curated Recipes)

| Blueprint | Topology | Employee Context Reuse | Ideal Use Case |
| :--- | :--- | :--- | :--- |
| [`feature-ship.md`](feature-ship.md) | `N1 → (N2 ∥ N3 ∥ N4) → U1 → N5` | `@Architect`, `@Backend`, `@Frontend`, `@QA` | Contract-first full-stack delivery with parallel backend, UI, and test tracks + Release Gate |
| [`bug-hunt-fix.md`](bug-hunt-fix.md) | `N1 → (N2 ∥ N3) → N4 → U1` | `@Debugger`, `@QA`, `@Auditor` | Repro-first root-cause debugging with surgical fix, edge-case regression suite & audit |
| [`security-audit-swarm.md`](security-audit-swarm.md) | `(N1 ∥ N2 ∥ N3) → N4 → U1 → N5` | `@AuthAudit`, `@IpcAudit`, `@SupplyAudit`, `@Hardening` | Multi-track auth, IPC & supply-chain threat audit converging into hardened patches |
| [`safe-migration.md`](safe-migration.md) | `N1 → (N2 ∥ N3) → U1 → N4` | `@Architect`, `@CoreDev`, `@CallerDev` | Characterization-tested refactor with rollback verification gate & legacy cleanup |
| [`deep-research-lab.md`](deep-research-lab.md) | `R1 → (R2 ∥ R3 ∥ R4) → U1 → R5` | `@PI`, `@TrackA`, `@TrackB`, `@Bench` | Multi-track hypothesis probing, counter-baseline ablations & quantitative benchmark synthesis |
| [`arch-teardown.md`](arch-teardown.md) | `R1 → (R2 ∥ R3) → R4 → U1` | `@Systems`, `@UX`, `@Architect` | Parallel codebase & UX teardown converging into a decision-ready Engineering RFC |

## Usage

### Option 1: Directly in the Mission Canvas
1. Open or initialize a Mission in **ADE** mode.
2. Click the top-left **File** button to open the **Mermaid & Node Pre-Prompts** split drawer.
3. Paste the ```` ```mermaid ```` block from any recipe on the left, copy each node's pre-prompt into the right-hand **Node Pre-Prompts** panel (or click the prompt icon on any node card — both sync directly to the same Mission store), pick each node's **Host**, **Engine**, and **Model/Thinking**, then click **Start**.

### Option 2: Scriptable CLI (`aexus-ade`)
```bash
# 1. Create a Mission owned by a Governor (or standalone with --title)
GOV_ID=$(aexus-ade session create --project . --engine claude --role governor --title "Release Lead" --no-open --json | jq -r .id)
MISSION_ID=$(aexus-ade mission init --governor "$GOV_ID" --title "Feature Ship" --open --json | jq -r .id)

# 2. Validate & apply a blueprint file directly (extracts the ```mermaid fence automatically)
aexus-ade mission blueprint validate --file ./examples/blueprints/feature-ship.md
aexus-ade mission blueprint apply --mission "$MISSION_ID" --file ./examples/blueprints/feature-ship.md

# 3. Attach per-node pre-prompts (synced immediately with the Canvas & Split Drawer)
aexus-ade mission prompt set --mission "$MISSION_ID" --node N1 --text "Define shared TypeScript/API contracts and file ownership boundaries."
aexus-ade mission prompt list --mission "$MISSION_ID"

# 4. Optional: bind a node to a remote SSH Cloud Host, then start the Mission
# aexus-ade mission host bind --mission "$MISSION_ID" --node N2 --host gpu-box --path /workspace/app
aexus-ade mission start --mission "$MISSION_ID" --timeout 15

# 5. Inspect live runtime status and approve the release gate when ready
aexus-ade mission status --mission "$MISSION_ID" --json
aexus-ade mission gate approve --mission "$MISSION_ID" --node U1 --note "All tracks verified"
```

Want to share your own Mission workflow recipe? See the **[Contribute a Blueprint Recipe](../../CONTRIBUTING.md#contribute-a-blueprint-recipe)** guide!
