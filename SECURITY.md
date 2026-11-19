# Security Policy & Threat Model

Aexus Code (`v1.1.0`) is a **local-first, multi-agent workbench** built on open-source `Code - OSS`. Because orchestrating coding agents carries real execution risk (shell commands, file edits, IPC control planes, Git hooks, and untrusted repositories), this document states our exact trust boundaries, default guardrails, and opt-in behaviors transparently.

---

## 1. Execution Modes, Safe Defaults & Automated DAG Approval (`aexus.ade.autonomousMode`)

- **Safe Interactive Defaults**: Interactive sessions launched in Aexus Code default to each engine's non-bypass mode rather than unrestricted execution:
  - **Claude Code**: `acceptEdits` (prompts before arbitrary shell commands).
  - **Codex**: `workspace-write` sandbox + `on-request` approvals.
  - **Kilo Code / OpenCode / DeepSeek Harness / Cline / Antigravity / Pi**: `ask` / safe approval mode.
- **Visible Workbench Posture Indicator**: A live Status Bar pill (**`ADE: Safe Mode`** vs warning-tinted **`ADE: Autonomous`**) and Command Palette action (**`Aexus ADE: Toggle Safe / Autonomous Permission Mode`**) make the active permission mode immediately visible and toggleable at `ConfigurationTarget.USER`.
- **Per-Project Automated DAG Approval & Bounded Codex Sandbox**:
  - `aexus.ade.autonomousMode` defaults to **`false`** (`scope: application`, `restricted: true` — `.vscode/settings.json` inside untrusted repos cannot enable it).
  - When `aexus.ade.autonomousMode` is `false`, starting an automated Engineering or Research DAG requires an **explicit per-project confirmation modal** before dispatching unattended lanes.
  - Even during automated DAG execution, **Codex Workers remain bounded to `sandbox: 'workspace-write'`** (scoped strictly to the node's isolated Git worktree `cwd`) whenever `aexus.ade.autonomousMode` is `false`. OS-wide `danger-full-access` is used **only** when the user explicitly enables `aexus.ade.autonomousMode === true` (or supplies an explicit sandbox override).

---

## 2. Control Plane Authentication, Lineage-Scoped RBAC & Live Session Verification

Aexus Code exposes a local control plane (`aexus-ade`) strictly on loopback local IPC — **never** on a TCP/network port:

- **Transport & Multi-Instance Isolation**:
  - **macOS / Linux**: Per-instance local Unix domain socket (`~/.aexus-code/ade-control.<pid>.sock`) created with `0600` file permissions.
  - **Windows**: Local Windows Named Pipe (`\\.\pipe\aexus-ade-control-*`) gated by a per-instance 32-byte random bearer token plus per-session HMAC capability tokens.
  - Each running Aexus Code window writes its own `0600` per-instance metadata file (`ade-control.<pid>.json`) so side-by-side windows never cross-route agent commands.
- **Server-Signed Per-Session Capability Tokens (`AEXUS_ADE_SESSION_TOKEN`)**:
  - The main-process `AdeControlServer` generates a 32-byte `capabilitySecret` held **only in memory** (never written to disk).
  - Orchestrated agent sessions receive an HMAC-SHA256 capability token (`aexus-cap.<base64url(payload)>.<hmacSha256Hex>`) bound to `(sid, rank, pure)` plus `AEXUS_ADE_SOCKET`, with `AEXUS_ADE_CONTROL_FILE` and `AEXUS_ADE_TOKEN` stripped from the child environment.
  - On every incoming request carrying a capability token, `AdeControlServer` verifies the HMAC in constant time and injects server-verified `_callerSessionId` and `caller` — agents cannot spoof `secretary`, elevate rank, or bypass checks by mutating env vars.
- **Live Session Validation, Rank Intersection & Identity-Keyed Engine Pools**:
  - On every non-human request, `AdeControlHandler` resolves `_callerSessionId` against the live session registry and rejects deleted or archived callers immediately (`Permission denied: caller session no longer active.`).
  - If a session's live rank changed (e.g., demoted from `Governor` to `Employee` or `Worker`), permissions are re-evaluated against the **live** rank (and rejected outright if demoted to a `pureExecution` rank).
  - Long-lived engine client pools (`codex`, `acp`, `kilo`) are keyed by `(cwd, sessionId, rank, pure)` so a demoted session never reuses an older higher-privilege client process.
- **Subtree Lineage & Supervision Enforcement (`canRankSupervise`)**:
  - `session.create`, `session.role`, `session.move`, `session.send`, `session.stop`, `session.archive`, `session.detach`, and `session.delete` enforce both rank supervision (`canRankSupervise(roleConfig, callerRank, targetRank)`) and subtree lineage ownership:
    - Agents cannot self-promote (e.g., `Employee → Governor`) or assign any rank equal to or higher than their own.
    - Non-top-tier callers cannot omit `--parent` to spawn a root orchestrator or inject commands into unrelated session trees (descendants and direct parent reporting only).
    - Deleting or archiving a session that owns an Engineering/Research tree additionally requires **`engineering.destroy`**, preventing lower tiers from wiping a locked DAG via `session delete --force`.
- **Slot-Verified `engineering.review`**:
  - For non-human callers, `engineering.review` verifies that `--role manager` callers hold (or supervise via `canRankSupervise`) the active `segment_owner` slot, `--role employee` callers hold (or supervise) the active `reviewer` slot, and `_callerSessionId` matches the node's assigned `employeeSessionId` / `managerSessionId` when bound — preventing single-agent bypass of `★ Critical` dual sign-off.
- **High-Privilege API Splits (`dangerous: true`)**:
  - Destructive and host-mutating kernel primitives are split out and flagged `dangerous: true` in Organization & Roles Studio:
    - **`host.manage`** (`host.upsert`, `host.delete`, `host.test`, `host.import`) — separated from read-only **`host.access`** (`host.list`, `host.get`, `host.browse`, `host.open`).
    - **`engineering.integrate`** (worktree merge/cleanup) and **`engineering.destroy`** (tree reset/remove) — separated from `engineering.design`.
- **Local OS-User Threat Boundary**: Human terminal invocations of `aexus-ade` authenticate with the per-instance `0600` master metadata file under `~/.aexus-code/`. Because local coding agents run under the same OS user account on a single-user workstation, server-signed capability tokens and scrubbed environments enforce strict least-privilege against prompt injection and CLI misuse, rather than acting as an OS-level VM or kernel container boundary against an adversarial local process with arbitrary filesystem read access.

---

## 3. Pure Worker Airgap & Scrubbed Subprocess Execution (`stripAdeControlEnv`)

- **Pure Execution Ranks (`0` Control APIs)**:
  - Sessions assigned to a `pureExecution` rank (`Worker [L4]`, `Builder`, `Scanner`, `Experimenter`, `Agent`) have `AEXUS_ADE_CONTROL_FILE`, `AEXUS_ADE_TOKEN`, `AEXUS_ADE_SOCKET`, `AEXUS_ADE_SESSION_TOKEN`, and `AEXUS_ADE_CALLER` stripped, the bundled `aexus-ade` binary directory removed from `PATH`, and receive an explicit server-signed deny token (`pure: true`) that `AdeControlServer` rejects immediately.
- **Unconditional Subprocess Environment Scrubbing**:
  - `stripAdeControlEnv()` unconditionally removes all `AEXUS_ADE_*` control-plane variables before spawning:
    1. **`verify:` shell commands** (`AdeEngineeringNodeService.runNodeVerificationCommand`) — preventing untrusted Worker-edited tests or scripts from reading `AEXUS_ADE_CONTROL_FILE` or escalating to master control-plane access.
    2. **Automated `git` worktree subprocesses** (`AdeEngineeringNodeService.execGitRaw`).
    3. **Remote OpenSSH commands** (`AdeCloudHostNodeService.runSshRaw`).
    4. **ACP `sqlite3` helper invocations** (`extensions/aexus-agents/src/acp.ts`, resolved via `PATH` rather than hardcoded `/usr/bin/sqlite3`).
- **Git Hook Neutralization (`-c core.hooksPath=/dev/null`)**:
  - Automated worktree `git commit`, `git merge`, and `git checkout` commands pass **`-c core.hooksPath=/dev/null`** so malicious `.git/hooks/*` scripts inside cloned repositories cannot execute in the Electron main process.

---

## 4. Upfront SHA-256 Hash-Pinned `verify:` Gate & Revocation

Engineering and Research blueprints support per-node `verify:` shell commands (executed in a scrubbed detached process group via `/bin/sh -c` on POSIX, or via `cmd.exe /d /s /c` with `windowsVerbatimArguments: true` on Windows, with clean timeout teardown) to validate Worker output before waking a reviewer.

- **Upfront Pre-Dispatch Verification**: At the start of `runTree()` — **before any Worker is dispatched** — Aexus Code scans all `verify:` commands against the project's SHA-256 trust store. Any new or agent-modified command triggers an explicit human approval modal (or pauses with a **`Trust Gate`** Inbox item in non-interactive mode) so untrusted commands neither execute silently nor burn Worker tokens beforehand.
- **Full Audit & Revocation**: Stored trust entries record command previews alongside their SHA-256 hashes and can be inspected or revoked at any time via:
  - Command Palette: **`Aexus ADE: Manage Trusted Verify Commands...`** (multi-select revoke or Revoke All).
  - CLI (`human`-only): **`aexus-ade engineering verify-trust list`** and **`aexus-ade engineering verify-trust revoke [hash|--all]`**.

---

## 5. Preventing Malicious Repository Prompt Injection

- **Application-Scoped Restricted Settings**: `aexus.ade.organization` (custom rank ladders, 4-slot bindings, system prompt templates, and API grants), `aexus.ade.engineering.watchdogTimeoutMinutes`, `aexus.ade.autonomousMode`, and `aexus.ade.nativeExtensionRoleBridge.enabled` are registered with **`scope: application`** and **`restricted: true`**.
- **Workspace Overrides Ignored**: Aexus Code reads these settings exclusively from application/user configuration and ignores `.vscode/settings.json` workspace overrides, preventing a cloned untrusted repository from rewriting agent prompts, expanding `allowedApis`, or enabling autonomous bypass.

---

## 6. Third-Party Extension Role Bridge Disclosure & Opt-Out

When you orchestrate third-party coding agent extensions inside Aexus Code's extension host, Aexus Code includes a **Native Extension Role Bridge** (`extensions/aexus-agents/src/nativeRoleBridge.ts`, preloaded via `extHostRolePreload.js`) that synchronizes organizational rank context across supported native engines that do not expose a native runtime system-prompt flag (using official flags/RPC hooks where available, and extension-host spawn/fetch/stdout bridging where vendor extensions lack one).

- **Full Transparency & Opt-Out**:
  - Disable globally anytime via **`aexus.ade.nativeExtensionRoleBridge.enabled: false`** (`scope: application`, `restricted: true`) or by launching with **`AEXUS_ADE_DISABLE_NATIVE_ROLE_BRIDGE=1`**.
  - Pure `Worker` sessions never receive orchestration prompt injection.
  - All engine traffic remains strictly direct between your local machine and the provider endpoints you configured — Aexus Code runs no telemetry relay or third-party proxy service.

---

## 7. Non-Destructive SSH Cloud Hosts (`aexus-ssh://`) & Credential Boundaries

- **Global `~/.ssh/config` Untouched by Default (`syncUserSshDir: false`)**: `AdeCloudHostNodeService` defaults `syncUserSshDir` to **`false`**. Aexus Code writes managed overrides solely to `<userDataDir>/ssh/effective_ssh_config` and passes `-F <effective_ssh_config>` exclusively to its own SSH commands and integrated terminals — **never prepending `Include` or modifying your global `~/.ssh/config`** (eliminating OS-wide OpenSSH first-match-wins side effects).
- **Zero Private Key Handling**: Cloud Host management and read-only VS Code SSH migration read only public host aliases, hostnames, usernames, ports, `ProxyJump` entries, and remote directory history. Private key contents and passphrases are never copied, stored, or logged.
- **OpenSSH `BatchMode=yes` & Host Key Verification**: Non-interactive filesystem and Git transport invokes system OpenSSH with `BatchMode=yes` (requiring key/`ssh-agent` authentication) and scrubbed ADE control env vars. Aexus Code respects any `StrictHostKeyChecking` directive configured in `~/.ssh/config`, falling back to `accept-new` only when unspecified.
- **Platform Multiplexing Behavior**: Uses OpenSSH `ControlMaster` connection multiplexing on macOS/Linux and direct OpenSSH per command on Windows.
- **Scoped Remote Capabilities**: Interactive ADE sessions, remote editing, Git diffs, and SSH terminals work over `aexus-ssh://`; Engineering/Research DAG Git worktrees are explicitly gated to local Git repositories so remote URIs can never misresolve to local filesystem paths.

---

## 8. Extension Gallery & Open-Source Isolation

- **Open VSX Registry**: Aexus Code connects to the open-source **[Open VSX Registry](https://open-vsx.org/)** (`https://open-vsx.org/vscode/gallery`), not Microsoft's proprietary Visual Studio Marketplace.
- **Zero Bundled Copilot / Telemetry**: Upstream Copilot extensions, CLI shims, and Microsoft proprietary agent endpoints are removed. User data is isolated under platform-native `Aexus Code` directories (`~/.aexus-code/extensions`, etc.).

---

## Reporting a Vulnerability

If you discover a security vulnerability in Aexus Code (such as command injection, path traversal, capability-token bypass, privilege escalation, or credential exposure):

1. **Do not** disclose the vulnerability publicly in a GitHub Issue before a fix is ready.
2. Open a private **GitHub Security Advisory** on [`Daijunfan/Aexus-Code`](https://github.com/Daijunfan/Aexus-Code/security/advisories/new) with reproduction steps, affected platform(s), and impact assessment.
3. **Fallback Contact**: If GitHub Private Security Advisories are unavailable to you (for example, if you do not hold a GitHub account), contact the project maintainer privately via the public security/maintainer contact listed on the [`Daijunfan`](https://github.com/Daijunfan) GitHub profile and include `[SECURITY] Aexus Code` in the subject line.
4. We aim to acknowledge reports within **48 hours** and coordinate a fix and advisory timeline.
