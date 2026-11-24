# Security Policy & Threat Model

Aexus Code (`v1.1.0`) is a **local-first, multi-agent workbench** built on open-source `Code - OSS`. Because orchestrating coding agents carries real execution risk (shell commands, file edits, IPC control planes, SSH hosts, and untrusted repositories), this document states our exact trust boundaries, default guardrails, and opt-in behaviors transparently.

---

## 1. Execution Modes & Safe Defaults (`aexus.ade.autonomousMode`)

- **Safe Interactive Defaults**: Interactive sessions launched in Aexus Code default to each engine's non-bypass mode rather than unrestricted execution:
  - **Claude Code**: `acceptEdits` (prompts before arbitrary shell commands).
  - **Codex**: `workspace-write` sandbox + `on-request` approvals.
  - **Kilo Code / OpenCode / DeepSeek Harness / Cline / Antigravity / Pi**: `ask` / safe approval mode.
- **Visible Workbench Posture Indicator**: A live Status Bar pill (**`ADE: Safe Mode`** vs warning-tinted **`ADE: Autonomous`**) and Command Palette action (**`Aexus ADE: Toggle Safe / Autonomous Permission Mode`**) make the active permission mode immediately visible and toggleable at `ConfigurationTarget.USER`.
- **Application-Scoped Autonomous Guard**: `aexus.ade.autonomousMode` defaults to **`false`** (`scope: application`, `restricted: true` — `.vscode/settings.json` inside untrusted repositories cannot enable it). Codex execution sessions stay bounded to `sandbox: 'workspace-write'` whenever `aexus.ade.autonomousMode` is `false`.

---

## 2. Control Plane Authentication, Dual-View Boundaries & Lineage-Scoped RBAC

Aexus Code exposes a local control plane (`aexus-ade`) strictly on local IPC and a `127.0.0.1` loopback bridge — **never** on an external network interface:

- **Transport & Multi-Instance Isolation**:
  - **macOS / Linux**: Per-instance local Unix domain socket (`~/.aexus-code/ade-control.<pid>.sock`) created with `0600` file permissions, plus an ephemeral `127.0.0.1` loopback TCP bridge for sandboxed/SSH-tunneled sessions.
  - **Windows**: Local Windows Named Pipe (`\\.\pipe\aexus-ade-control-*`) plus loopback TCP gated by per-instance 32-byte tokens and server-signed HMAC capability tokens.
  - Each running Aexus Code window writes its own `0600` per-instance metadata file (`ade-control.<pid>.json`) so side-by-side windows never cross-route agent commands.
- **Server-Signed Per-Session Capability Tokens (`AEXUS_ADE_SESSION_TOKEN`)**:
  - The main-process `AdeControlServer` generates a 32-byte `capabilitySecret` held **only in memory** (never written to disk).
  - Orchestrated agent sessions receive an HMAC-SHA256 capability token (`aexus-cap.<base64url(payload)>.<hmacSha256Hex>`) bound to `(sid, rank, pure, missionNode)` plus socket/port connection info, with `AEXUS_ADE_CONTROL_FILE` and `AEXUS_ADE_TOKEN` stripped from the child environment.
  - On every incoming request carrying a capability token, `AdeControlServer` verifies the HMAC in constant time and injects server-verified `_callerSessionId` and `caller` — agents cannot spoof `secretary`, elevate rank, or bypass checks by mutating env vars.
- **Live Session Validation, Rank Intersection & Identity-Keyed Engine Pools**:
  - On every non-human request, `AdeControlHandler` resolves `_callerSessionId` against the live session registry and rejects deleted or archived callers immediately (`Permission denied: caller session no longer active.`).
  - If a session's live rank changed (e.g., demoted from `Governor` to `Employee` or `Worker`), permissions are re-evaluated against the **live** rank (and rejected outright if demoted to a `pureExecution` rank outside a Mission).
  - Long-lived engine client pools (`codex`, `acp`, `kilo`) are keyed by `(cwd, sessionId, rank, pure)` so a demoted session never reuses an older higher-privilege client process.
- **Top-Down Lineage Enforcement (`canRankSupervise`) & Dual-View Guardrails**:
  - `session.create`, `session.role`, `session.move`, `session.send`, `session.stop`, `session.archive`, `session.detach`, `session.delete`, and `org.send`/`org.context` strictly enforce top-down supervision (`canRankSupervise(roleConfig, callerRank, targetRank)`) and subtree/department lineage ownership:
    - Agents cannot self-promote (e.g., `Employee → Governor`) or assign any rank equal to or higher than their own.
    - Non-top-tier callers cannot omit `--parent` to spawn a root orchestrator or message peers, superiors, or unrelated session trees.
    - Deleting or archiving a session that owns a Mission additionally requires **`mission.destroy`**, preventing lower tiers from wiping a locked Mission via `session delete --force`.
    - Native `session create|delete` is blocked on locked Engineering canvas sessions — Engineering staff nodes MUST be created/removed exclusively via `orchestration staff create|remove`, which enforces immediate next-tier & same-department scoping plus automatic in-flight token reclamation.
  - Inside a Dual-View Engineering workspace, downward baton minting (`token mint|split`) is strictly top-down (subordinates can only return received batons via `token return`), Department Shared Whiteboards enforce department/edge scoping, Task DAG completion enforces per-node authority plus upstream dependency checks (`INCOMPLETE_DEPENDENCIES`), and `maxHops` + FinOps budget ceilings hard-stop runaway loops or spend.
- **High-Privilege API Splits (`dangerous: true`)**:
  - Destructive and host-mutating kernel primitives are split out and flagged `dangerous: true` in Organization & Roles Studio:
    - **`project.manage`** (project creation/deletion).
    - **`host.manage`** (`host.upsert`, `host.delete`, `host.test`, `host.import`) — separated from read-only **`host.access`** (`host.list`, `host.get`, `host.browse`, `host.open`).
    - **`mission.control`** (starting/stopping/patching/recalling live Missions) and **`mission.destroy`** (removing/deleting Missions) — separated from `mission.read` and `mission.design`.
- **Local OS-User Threat Boundary**: Human terminal invocations of `aexus-ade` authenticate with the per-instance `0600` master metadata file under `~/.aexus-code/`. Because local coding agents run under the same OS user account on a single-user workstation, server-signed capability tokens and scrubbed environments enforce strict least-privilege against prompt injection and CLI misuse, rather than acting as an OS-level VM or kernel container boundary against an adversarial local process with arbitrary filesystem read access.

---

## 3. Pure Worker Airgap & Scrubbed Subprocess Execution (`stripAdeControlEnv`)

- **Pure Execution Ranks (`0` Control APIs)**:
  - Interactive sessions assigned to a `pureExecution` rank (`Worker [L4]`, `Builder`, `Scanner`, `Experimenter`, `Agent`) have `AEXUS_ADE_CONTROL_FILE`, `AEXUS_ADE_TOKEN`, `AEXUS_ADE_SOCKET`, `AEXUS_ADE_SESSION_TOKEN`, and `AEXUS_ADE_CALLER` stripped, the bundled `aexus-ade` binary directory removed from `PATH`, and receive an explicit server-signed deny token (`pure: true`) that `AdeControlServer` rejects immediately.
  - When a pure-rank session executes as an **in-graph Mission node**, its capability token carries `missionNode: true`, which `AdeControlServer` strictly scopes to `token.*`, `whoami`, `docs.read`, and `api.update` while blocking every orchestration, session, host, and topology-mutation API.
- **Unconditional Subprocess Environment Scrubbing**:
  - `stripAdeControlEnv()` unconditionally removes all `AEXUS_ADE_*` control-plane variables before spawning:
    1. **Remote OpenSSH commands** (`AdeCloudHostNodeService.runSshRaw`).
    2. **Watchdog liveness probes** (`AdeMissionWatchdogNodeService`).
    3. **ACP `sqlite3` helper invocations** (`extensions/aexus-agents/src/acp.ts`, resolved via `PATH` rather than hardcoded `/usr/bin/sqlite3`).

---

## 4. Preventing Malicious Repository Prompt Injection

- **Application-Scoped Restricted Settings**: `aexus.ade.organization` (custom rank ladders, 4-slot bindings, system prompt templates, and API grants), `aexus.ade.autonomousMode`, and `aexus.ade.nativeExtensionRoleBridge.enabled` are registered with **`scope: application`** and **`restricted: true`**.
- **Workspace Overrides Ignored**: Aexus Code reads these settings exclusively from application/user configuration and ignores `.vscode/settings.json` workspace overrides, preventing a cloned untrusted repository from rewriting agent prompts, expanding `allowedApis`, or enabling autonomous bypass.

---

## 5. Third-Party Extension Role Bridge Disclosure & Opt-Out

When you orchestrate third-party coding agent extensions inside Aexus Code's extension host, Aexus Code includes a **Native Extension Role Bridge** (`extensions/aexus-agents/src/nativeRoleBridge.ts`, preloaded via `extHostRolePreload.js`) that synchronizes organizational rank context across supported native engines that do not expose a native runtime system-prompt flag (using official flags/RPC hooks where available, and extension-host spawn/fetch/stdout bridging where vendor extensions lack one).

- **Full Transparency & Opt-Out**:
  - Disable globally anytime via **`aexus.ade.nativeExtensionRoleBridge.enabled: false`** (`scope: application`, `restricted: true`) or by launching with **`AEXUS_ADE_DISABLE_NATIVE_ROLE_BRIDGE=1`**.
  - Interactive pure `Worker` sessions never receive orchestration prompt injection.
  - All engine traffic remains strictly direct between your local machine and the provider endpoints you configured — Aexus Code runs no telemetry relay or third-party proxy service.

---

## 6. Non-Destructive SSH Cloud Hosts (`aexus-ssh://`) & Credential Boundaries

- **Global `~/.ssh/config` Untouched by Default (`syncUserSshDir: false`)**: `AdeCloudHostNodeService` defaults `syncUserSshDir` to **`false`**. Aexus Code writes managed overrides solely to `<userDataDir>/ssh/effective_ssh_config` and passes `-F <effective_ssh_config>` exclusively to its own SSH commands and integrated terminals — **never prepending `Include` or modifying your global `~/.ssh/config`**.
- **Zero Private Key Handling**: Cloud Host management and read-only VS Code SSH migration read only public host aliases, hostnames, usernames, ports, `ProxyJump` entries, and remote directory history. Private key contents and passphrases are never copied, stored, or logged.
- **OpenSSH `BatchMode=yes` & Host Key Verification**: Non-interactive filesystem, Git, and engine-probe transport invokes system OpenSSH with `BatchMode=yes` (requiring key/`ssh-agent` authentication) and scrubbed ADE control env vars. Aexus Code respects any `StrictHostKeyChecking` directive configured in `~/.ssh/config`, falling back to `accept-new` only when unspecified.
- **Platform Multiplexing Behavior**: Uses OpenSSH `ControlMaster` connection multiplexing on macOS/Linux and direct OpenSSH per command on Windows.

---

## 7. Extension Gallery & Open-Source Isolation

- **Open VSX Registry**: Aexus Code connects to the open-source **[Open VSX Registry](https://open-vsx.org/)** (`https://open-vsx.org/vscode/gallery`), not Microsoft's proprietary Visual Studio Marketplace.
- **Zero Bundled Copilot / Telemetry**: Upstream Copilot extensions, CLI shims, and Microsoft proprietary agent endpoints are removed. User data is isolated under platform-native `Aexus Code` directories (`~/.aexus-code/extensions`, etc.).

---

## Reporting a Vulnerability

If you discover a security vulnerability in Aexus Code (such as command injection, path traversal, capability-token bypass, privilege escalation, or credential exposure):

1. **Do not** disclose the vulnerability publicly in a GitHub Issue before a fix is ready.
2. Open a private **GitHub Security Advisory** on [`Daijunfan/Aexus-Code`](https://github.com/Daijunfan/Aexus-Code/security/advisories/new) with reproduction steps, affected platform(s), and impact assessment.
3. **Fallback Contact**: If GitHub Private Security Advisories are unavailable to you (for example, if you do not hold a GitHub account), contact the project maintainer privately via the public security/maintainer contact listed on the [`Daijunfan`](https://github.com/Daijunfan) GitHub profile and include `[SECURITY] Aexus Code` in the subject line.
4. We aim to acknowledge reports within **48 hours** and coordinate a fix and advisory timeline.
