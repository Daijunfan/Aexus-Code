# Security Policy & Threat Model

Aexus Code (`v1.1.0`) is a **local-first multi-agent workbench** built on open-source `Code - OSS` (`1.146.0`). Because orchestrating local and remote coding agents involves shell execution, IPC channels, cross-host file transfers, and SSH tunnels, this document states our trust boundaries, cryptographic controls, and default guardrails transparently.

## 1. Execution Modes & Safe Defaults (`aexus.ade.autonomousMode`)

- **Safe Interactive Defaults**: Standalone IDE sessions default to each engine's non-bypass approval posture:
  - **Claude Code**: `acceptEdits` (prompts before arbitrary shell commands outside the 45 `ade_*` CLI allowlist).
  - **Codex**: `workspace-write` sandbox + `on-request` approvals.
  - **Kilo Code / OpenCode / DeepSeek Harness / Cline / Antigravity / Pi**: `ask` / safe approval mode.
- **Narrow 45-Command `ade_*` Allowlist**: `isSafeAdeCliBashCommand()` auto-approves only standalone invocations of the 45 registered `ade_*` executables (or pure stdin heredoc/printf pipes to `ade_*`), strictly rejecting compound shell operators (`;`, `&&`, `||`, backticks, `$()`, or file redirects).
- **Application-Scoped Autonomous Guard**: `aexus.ade.autonomousMode` defaults to **`false`** (`scope: application`, `restricted: true` — `.vscode/settings.json` inside untrusted repositories cannot override it).

## 2. Full-Duplex Mutual HMAC-SHA256 Control Plane & Zero Plaintext Secrets on Disk

Aexus Code's ADE Control Center listens exclusively on a `0600` local Unix socket (or Windows Named Pipe) and per-host `127.0.0.1:0` loopback listeners forwarded over SSH reverse tunnels — **never** on an external network interface, and **zero master token files are written to disk**:

- **In-Memory Session Credentials (`ADE_AGENT_TOKEN`)**:
  - For each ADE Project employee, `AdeControlServer` mints an in-memory credential `ADE_AGENT_TOKEN="ades1.<jti>.<secret_b64url>"` bound to `(projectId, agentId, host, tokenGen)`.
  - When `ade_*` connects, the server emits a 256-bit random `nonce`; the client proves possession via `HMAC-SHA256(secret, "req:" + nonce + ":" + jti + ":" + payloadJson)` without ever transmitting `secret` over the wire, and verifies the server's `resProof` (`HMAC-SHA256(secret, "res:" + nonce + ":" + jti + ":" + responseJson)`) in constant time (`crypto.timingSafeEqual`).
  - Deleting an employee (`ade_agent_delete`) immediately increments `token_gen` and revokes all active `jti` sessions.
- **Strict Host-Channel Binding & Zero-Secret `bridge.json`**:
  - Remote POSIX SSH Cloud Hosts use `0700` StreamLocal Unix socket reverse forwarding (`ssh -R <remoteSock>:127.0.0.1:<localPort>` with `StreamLocalBindMask=0177`), writing only `{ endpoint, updatedAt }` (zero secrets) to `$HOME/.ade_store/_run/bridge-<hash>.json` (`0600`).
  - `AdeControlServer` enforces `cred.host === listener.boundCanonicalHostKey`, blocking cross-host token replay.

## 3. Per-Employee Daemon Slot Isolation, Zero Hidden Prompts & Subprocess Scrubbing

- **Per-Employee Daemon Slots (`ade:<projectId>:<agentId>`)**:
  - Long-lived engine daemons (`codex app-server`, `kilo serve`, `opencode serve`, `dsh`, `agy acp`, `cline --acp`, `pi --mode rpc`) run in dedicated per-employee slots so two employees in the same workspace never share `ADE_AGENT_TOKEN`.
  - Standalone IDE chat sessions run in `SHARED_PURE_SCOPE_KEY` with all `ADE_*` environment variables and `bin/ade_*` `PATH` entries stripped.
- **Zero Hidden System Prompt Injection**:
  - All 8 engine adapters run cleanly without monkey-patching third-party extensions or injecting hidden system prompts. Only static routing documentation (`AGENTS.md` and `0444` read-only module manuals under `sysprompts/v1/`) and the single immutable Ticket delivery header (`"[系统提示词: 此消息是来自Agent {<from_id>}的Ticket] "`) are used.
- **Subprocess Environment Scrubbing (`stripAdeControlEnv`)**:
  - `stripAdeControlEnv()` strips all `ADE_AGENT_TOKEN` and `ADE_CONTROL_*` variables before spawning OpenSSH transport pipes and helper subprocesses.

## 4. Formal Tree Jurisdiction, Whiteboard Pre-Auth & Path Traversal Guards

- **Formal Hierarchy & Connected Department Subtrees (`adeJurisdictionPolicy.ts`)**:
  - Employees can manage or send Tickets only to strict subordinates (`caller.level < target.level`) within permitted department boundaries (enforcing branch-pruned connected subtrees and anti-self-lockout theorems).
  - Whiteboards enforce strict pre-authentication (`ERR_BOARD_NOT_FOUND` / `ERR_WB_FORBIDDEN`) before querying any `item_id` or `note_id`, eliminating item-ID enumeration side channels.
- **4-Quadrant Storage Integrity & Symlink Escape Protection (`adeDynamicStorageEngine.ts`)**:
  - Cross-host SSH streams enforce a 3-way integrity gate (`exitCode === 0`, exact byte length, and exact SHA-256) before atomic `mv -f`, preventing truncated files on OpenSSH `exit 255` disconnects.
  - `ade_wb_download --dest` resolves `realpath` and blocks writes into sensitive paths (`~/.aexus-code`, `~/.ade_store`, `~/.ssh`, `/etc`, `/System`, system `bin`/`sbin`), while remote GC verifies `[ -f "$target" ] && [ ! -L "$target" ]` inside `$HOME/.ade_store/`.

## 5. Non-Destructive SSH Cloud Hosts (`aexus-ssh://`) & Open VSX Isolation

- **Global `~/.ssh/config` Untouched by Default (`syncUserSshDir: false`)**: Aexus Code writes managed SSH overrides solely to `<userDataDir>/ssh/effective_ssh_config` and passes `-F` only to its own SSH invocations. Private keys and passphrases are never copied, stored, or logged.
- **Open VSX Registry & Zero Bundled Copilot Telemetry**: Connects to **[Open VSX Registry](https://open-vsx.org/)** with upstream proprietary Copilot extensions and telemetry endpoints removed.

## Reporting a Vulnerability

1. **Do not** disclose security vulnerabilities publicly in a GitHub Issue before a fix is available.
2. Open a private **GitHub Security Advisory** on [`Daijunfan/Aexus-Code`](https://github.com/Daijunfan/Aexus-Code/security/advisories/new) with reproduction steps, affected platform(s), and impact assessment.
3. **Fallback Contact**: Contact the maintainer privately via the public contact on the [`Daijunfan`](https://github.com/Daijunfan) GitHub profile with `[SECURITY] Aexus Code` in the subject line.
