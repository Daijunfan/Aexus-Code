# Security Policy & Threat Model

Aexus Code is a **local-first, multi-agent workbench** built on open-source `Code - OSS`. Because orchestrating coding agents carries real execution risk (shell commands, file edits, IPC control planes, and untrusted repositories), this document states our exact trust boundaries, default guardrails, and opt-in behaviors transparently.

---

## 1. Execution Modes & Safe Defaults (`aexus.ade.autonomousMode`)

- **Safe Interactive Defaults**: Interactive sessions launched in Aexus Code default to each engine's non-bypass mode rather than full unprompted execution:
  - **Claude Code**: `acceptEdits` (prompts before arbitrary shell commands).
  - **Codex**: `workspace-write` sandbox + `on-request` approvals.
  - **Kilo Code / ACP engines**: `ask` approval mode.
- **Explicit Opt-In for Autonomous Mode**: Running unprompted autonomous workflows requires explicit opt-in via **`aexus.ade.autonomousMode`** (default `false`, `application`-scoped and `restricted: true` so untrusted workspaces cannot enable it) or an explicit user-initiated automated DAG run.

---

## 2. Control Plane Authentication & Per-Session Capability Tokens

Aexus Code exposes a local control plane (`aexus-ade`) strictly on loopback local IPC — **never** on a TCP/network port:

- **Transport**:
  - **macOS / Linux**: Per-instance local Unix domain socket (`~/.aexus-code/ade-control.<pid>.sock` + primary symlink/pointer) created with `0600` file permissions.
  - **Windows**: Local Windows Named Pipe (`\\.\pipe\aexus-ade-control-*`) gated by a per-instance 32-byte random bearer token plus per-session HMAC capability tokens.
  - **Multi-Instance Isolation**: Each running Aexus Code window writes its own `0600` per-instance metadata file (`ade-control.<pid>.json`) and exports `AEXUS_ADE_CONTROL_FILE` pointing to its own instance, preventing cross-instance command misrouting when running multiple windows or dev + installed builds side by side.
- **Server-Signed Per-Session Capability Tokens (`AEXUS_ADE_SESSION_TOKEN`)**:
  - The main-process `AdeControlServer` generates a 32-byte `capabilitySecret` held **only in memory** (never written to disk).
  - When spawning an orchestrated agent session, the runtime requests a server-signed capability token (`aexus-cap.<base64url(payload)>.<hmacSha256Hex>`) bound to the session ID and organizational rank, injects `AEXUS_ADE_SESSION_TOKEN` and `AEXUS_ADE_SOCKET`, and **strips `AEXUS_ADE_CONTROL_FILE` and `AEXUS_ADE_TOKEN`** from the child environment.
  - On every incoming request carrying a capability token, the server verifies the HMAC in constant time and **forges/overwrites `caller` server-side from the signed token** — agents cannot spoof `secretary`, elevate their rank, or bypass permission checks by clearing environment variables.
- **Pure Worker Isolation**:
  - Sessions assigned to a `pureExecution` rank (such as `Worker [L4]`, `Builder`, or `Agent`) have `AEXUS_ADE_CONTROL_FILE`, `AEXUS_ADE_TOKEN`, `AEXUS_ADE_SOCKET`, and `AEXUS_ADE_CALLER` stripped, the bundled `aexus-ade` binary directory removed from `PATH`, and receive an explicit server-signed deny token (`pure: true`) that `AdeControlServer` rejects immediately.
- **Least-Privilege API Splits**:
  - Destructive and branch-mutating engineering primitives (`engineering.integrate` for worktree merge/cleanup and `engineering.destroy` for tree reset/remove) are separated from `engineering.design` and flagged as high-privilege (`dangerous: true`) in the Organization & Roles Studio.

---

## 3. Preventing Malicious Repository Prompt Injection

- **Application-Scoped Restricted Settings**: `aexus.ade.organization` (custom rank ladders, system prompt templates, and API grants), `aexus.ade.engineering.watchdogTimeoutMinutes`, and `aexus.ade.autonomousMode` are registered with **`scope: application`** and **`restricted: true`**.
- **Workspace Overrides Ignored**: Aexus Code reads organization configuration exclusively from application/user settings and ignores `.vscode/settings.json` workspace overrides, preventing a cloned untrusted repository from rewriting agent system prompts or expanding `allowedApis`.

---

## 4. SHA-256 Hash-Pinned `verify:` Shell Commands

Engineering and Research blueprints support per-node `verify:` shell commands (run via `/bin/sh -c` on POSIX in a detached process group killed cleanly on timeout) to validate Worker output before waking a reviewer.

- Because shared `.aexus-blueprint.md` files or Governor-edited blueprints could introduce arbitrary shell commands, Aexus Code **pins trusted `verify:` commands by SHA-256 hash per project**.
- Whenever a blueprint introduces a new or modified `verify:` command (whether imported from disk or proposed by an agent), Aexus Code requires explicit user confirmation showing the exact command(s) before execution. Unapproved `verify:` commands are refused.

---

## 5. Third-Party Extension Role Bridge Disclosure & Opt-Out

When you orchestrate third-party coding agent extensions inside Aexus Code's extension host, Aexus Code includes a **Native Extension Role Bridge** (`extensions/aexus-agents/src/nativeRoleBridge.ts`, preloaded via `extHostRolePreload.js`) that synchronizes organizational rank context across supported native engines that do not expose a native runtime system-prompt flag (using official flags/RPC hooks where available, and extension-host spawn/fetch/stdout bridging where vendor extensions lack one).

- **Full Transparency & Opt-Out**:
  - You can disable third-party extension role bridging globally at any time via the **`aexus.ade.nativeExtensionRoleBridge.enabled`** setting (`scope: application`, `restricted: true`, set to `false`) or by launching with **`AEXUS_ADE_DISABLE_NATIVE_ROLE_BRIDGE=1`**.
  - Pure `Worker` sessions never receive orchestration prompt injection.
  - All engine traffic remains strictly direct between your local machine and the provider endpoints you configured — Aexus Code runs no telemetry relay or third-party proxy service.

---

## 6. SSH Cloud Hosts (`aexus-ssh://`) & Credential Boundaries

- **Zero Private Key Handling**: Cloud Host management and automatic VS Code SSH migration read only public host aliases, hostnames, usernames, ports, `ProxyJump` entries, and remote directory history from `~/.ssh/config` and VS Code metadata. Private key contents and passphrases are never copied, stored, or logged.
- **OpenSSH `BatchMode=yes` & Key/Agent Auth**: Non-interactive filesystem and Git transport invokes system OpenSSH with `BatchMode=yes`, which **requires key-based authentication (or a running `ssh-agent`)** — interactive password prompts and non-cached 2FA challenges are not supported on background file transport.
- **Platform Multiplexing Behavior**:
  - **macOS & Linux**: Uses OpenSSH `ControlMaster` connection multiplexing for low-latency remote file and Git operations.
  - **Windows**: OpenSSH on Windows does not support Unix-socket `ControlMaster`; Aexus Code uses direct OpenSSH connections per command.

---

## 7. Extension Gallery & Open-Source Isolation

- **Open VSX Registry**: Aexus Code connects to the open-source **[Open VSX Registry](https://open-vsx.org/)** (`https://open-vsx.org/vscode/gallery`), not Microsoft's proprietary Visual Studio Marketplace.
- **Zero Bundled Copilot / Telemetry**: Upstream Copilot extensions, CLI shims, and Microsoft proprietary agent endpoints are removed. User data is isolated under platform-native `Aexus Code` directories (`~/.aexus-code/extensions`, etc.).

---

## Reporting a Vulnerability

If you discover a security vulnerability in Aexus Code (such as command injection, path traversal, capability-token bypass, privilege escalation, or credential exposure):

1. **Do not** disclose the vulnerability publicly in a GitHub Issue before a fix is ready.
2. Open a private **GitHub Security Advisory** on [`Daijunfan/Aexus-Code`](https://github.com/Daijunfan/Aexus-Code/security/advisories/new) with reproduction steps, affected platform(s), and impact assessment.
3. We aim to acknowledge reports within **48 hours** and coordinate a fix and advisory timeline.
