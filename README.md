<p align="center">
  <img src="docs/assets/aexus-logo.png" width="88" alt="Aexus Code Monochrome Logo" />
</p>

<h1 align="center">Aexus Code</h1>

<p align="center">
  <strong>Open-Source Cross-Host Multi-Agent Workbench &amp; Mirror-Symmetric IDE</strong><br/>
  1..N ADE Project Pages per Folder · Single-Parent Reporting Tree &amp; Connected Department Subtrees · 45 Mutual-HMAC <code>ade_*</code> CLIs · 4-Quadrant Cross-Host Storage · 8 Native BYO-CLI Engines
</p>

<p align="center">
  <a href="https://github.com/Daijunfan/Aexus-Code/actions/workflows/aexus-ci.yml"><img src="https://github.com/Daijunfan/Aexus-Code/actions/workflows/aexus-ci.yml/badge.svg" alt="Aexus Code CI" /></a>
  <a href="https://github.com/Daijunfan/Aexus-Code/releases"><img src="https://img.shields.io/badge/Release-v1.1.0%20%C2%B7%20macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-0284c7?style=flat-square" alt="Releases v1.1.0" /></a>
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/License-MIT-0f172a?style=flat-square" alt="MIT License" /></a>
  <a href="https://open-vsx.org/"><img src="https://img.shields.io/badge/Extensions-Open%20VSX-6366f1?style=flat-square" alt="Open VSX Registry" /></a>
  <img src="https://img.shields.io/badge/Modes-ADE%20%E2%87%84%20IDE%20Symmetry-2563eb?style=flat-square" alt="ADE IDE Mirror Symmetry" />
  <img src="https://img.shields.io/badge/Native%20Engines-8%20BYO--CLI%20Agents-059669?style=flat-square" alt="8 Native Coding Agent Engines" />
</p>

<p align="center">
  <strong>English</strong> · <a href="docs/README.zh-CN.md">简体中文</a> · <a href="docs/ARCHITECTURE.md">Architecture</a> · <a href="docs/gallery.md">Visual Gallery</a> · <a href="SECURITY.md">Security</a> · <a href="CHANGELOG.md">Changelog</a> · <a href="CONTRIBUTING.md">Contributing</a> · <a href="CODE_OF_CONDUCT.md">Code of Conduct</a>
</p>

<p align="center">
  <img src="docs/promo/aexus-01-flagship-command-center-dark.png" width="100%" alt="Aexus Code ADE Command Center" />
</p>

## Overview

**Aexus Code** (`v1.1.0`) is an MIT-licensed, local-first desktop workbench built on `Code - OSS` (`1.146.0`) with [Open VSX](https://open-vsx.org/) compatibility and zero bundled Copilot telemetry. It pairs a full-parity VS Code **IDE (`IDE`)** with a lightweight cross-host **Agent Development Environment (`ADE`)**:

1. **Workspace Folder → `1..N` Project Pages & Bidirectional Reporting-Tree Canvas** — Create any number of isolated ADE Project Pages under local `file://` or zero-server `aexus-ssh://` folders (with side-by-side editor split support). Each Project Page renders a single-parent reporting tree (`L1..LN`, `344×188` employee cards + `276×164` shared whiteboards) with forced bidirectional arrows, 3000ms arc-length proportional Ticket flow particles, edge hover last-transfer timestamps, and click-to-inspect full Ticket history & detail popovers.
2. **45 Standalone `ade_*` CLI Executables & Full-Duplex Mutual HMAC-SHA256 Auth** — Employees collaborate exclusively through 45 focused `ade_*` CLI commands across 4 modules (**Base**, **Ticket**, **Orchestration**, **Whiteboard**) over a `0600` local Unix socket or SSH StreamLocal reverse tunnel, using in-memory `ADE_AGENT_TOKEN` challenge-response authentication with zero plaintext secrets on disk.
3. **Zero Hidden Prompt Injection & On-Demand `0444` Module Manuals** — All 8 coding agent engines run with zero hidden prompt wrappers or monkey-patched extension preloads. Agents read a concise workspace `AGENTS.md` router and pull `0444` read-only module manuals (`ticket.md`, `orchestration.md`, `whiteboard.md`) on demand via `ade_sysprompt_path`.
4. **Formal Connected Department Subtrees, Shared Whiteboards & Zero-Tension Ticket Archive** — Enforces strict top-down supervision, nested connected department subtrees, 2-level whiteboard access control with lossless upward ownership transfer on employee deletion, and `zlib.gzip` local detail archiving + physical tombstone cleanup on `ade_destroy`.
5. **4-Quadrant Dynamic Cross-Host Storage & Zero-Server SSH Cloud Hosts** — Transparently stores and streams Ticket details and Whiteboard file backups across local Mac and remote SSH Cloud Hosts (same-cloud zero-round-trip local copy, 3-way SHA-256 SSH stream verification, lexicographical dual-host locks preventing AB-BA deadlocks, and resumable CAS online storage migration) without installing `vscode-server` or modifying `~/.ssh/config`.
6. **8 Native BYO-CLI Coding Engines with 60fps Dual-Path Live Streaming** — Run **Claude Code**, **Codex**, **Google Antigravity**, **Kilo Code**, **OpenCode**, **DeepSeek Harness**, **Cline**, and **Pi** in isolated per-employee daemon slots (`ade:<projectId>:<agentId>`), with context-preserving `steer` preemption (`killTree: false`) and zero-flicker 60fps streaming whether the chat tab is already open or opened mid-turn.

## 8 Native Coding Agent Engines

| Engine | Session Type | Default CLI | Transport & Isolation |
| :--- | :--- | :--- | :--- |
| **Claude Code** | `aexus-claude` | `claude` | Streaming JSON CLI · `SIGINT` (`killTree: false`) context-preserving `steer` |
| **Codex** | `aexus-codex` | `codex` | `app-server` JSON-RPC · per-employee daemon slot & `ignore_default_excludes: true` |
| **Google Antigravity** | `aexus-antigravity` | `agy` | `agy acp` ConnectRPC · `.agents/rules/ade-routing.md` routing sync |
| **Kilo Code** | `aexus-kilo` | `kilo` | Loopback server / SSE · `POST /session/:id/abort` turn preemption |
| **OpenCode** | `aexus-opencode` | `opencode` | Loopback server / SSE · per-employee daemon slot |
| **DeepSeek Harness** | `aexus-dsh` | `dsh` | `--profile acp` + multi-frame Zstandard `.jsonl.zstd` history |
| **Cline** | `aexus-cline` | `cline` | `cline --acp` streaming protocol · `session/cancel` preemption |
| **Pi** | `aexus-pi` | `pi` | `pi --mode rpc` native `steer` / JSONL session lifecycle |

## 45 `ade_*` CLI Command Matrix

Inside every ADE Project employee session, `bin/ade_*` (locally) or `~/.ade_store/_bin/ade_*` (on SSH Cloud Hosts) is prepended to `PATH` with `ADE_AGENT_TOKEN` injected automatically:

| Module | Commands | Purpose |
| :--- | :--- | :--- |
| **0. Base (3)** | `ade_whoami` · `ade_sysprompt_path` · `ade_sysprompt_update` | Inspect caller identity/counts, resolve local `0444` manual paths, and check manual revision diffs. |
| **1. Ticket (7)** | `ade_create` · `ade_destroy` · `ade_edit` · `ade_list` · `ade_get` · `ade_detail` · `ade_history` | Non-blocking superior↔subordinate bound task batons (`queue` / `steer`), detail pointers, history chains, and gzip-archived clean destruction. |
| **2. Orchestration (15)** | `ade_host_list` · `ade_engine_list` · `ade_model_list` · `ade_agent_list` · `ade_agent_create` · `ade_agent_edit` · `ade_agent_move` · `ade_agent_delete` · `ade_dept_create` · `ade_dept_edit` · `ade_dept_delete` · `ade_dept_member` · `ade_dept_members` · `ade_dept_info` · `ade_wb_grant` | Probe hosts/engines/models, manage subordinate nodes in the reporting tree, manage nested connected department subtrees, and grant individual whiteboard access. |
| **3. Whiteboard (20)** | `ade_wb_list` · `ade_wb_my_perm` · `ade_wb_members` · `ade_wb_create` · `ade_wb_config` · `ade_wb_delete` · `ade_wb_tags` · `ade_wb_tag_manage` · `ade_wb_post_msg` · `ade_wb_upload_file` · `ade_wb_items` · `ade_wb_get_msg` · `ade_wb_download` · `ade_wb_edit_item` · `ade_wb_delete_item` · `ade_wb_manage_item` · `ade_wb_note_send` · `ade_wb_note_unread` · `ade_wb_note_detail` · `ade_wb_unread_all` | Asynchronous shared messages, independent cross-host file backups, controlled tag pools, owner curation, and `<=300`-char inline / `>300`-char pointer role notes (with automatic `unread_count` on all 17 single-board commands). |

## Quick Start: Download or Build from Source

### Option A — Prebuilt Binary Release (`v1.1.0`)

Download prebuilt archives from **[GitHub Releases](https://github.com/Daijunfan/Aexus-Code/releases)** ([Open VSX](https://open-vsx.org/) pre-configured):
- **macOS (`arm64` / `x64`)**: `Aexus-Code-v1.1.0-darwin-*.dmg` or `.zip` *(for ad-hoc signed builds, run `xattr -dr com.apple.quarantine "/Applications/Aexus Code.app"` on first launch)*.
- **Linux (`x64`)**: `Aexus-Code-v1.1.0-linux-x64.tar.gz`
- **Windows (`x64`)**: `Aexus-Code-v1.1.0-win32-x64.zip`

### Option B — Build from Source

Requires **Node.js `24.x`** (see [`.nvmrc`](.nvmrc)), **`pnpm@12.16.0`**, Python 3, Git, OpenSSH, and platform C++ build tools:

```bash
# 1. Install dependencies & fast-transpile core + extensions/aexus-agents (generates 45 ade_* shims)
./scripts/aexus-env.sh pnpm install
./scripts/aexus-env.sh pnpm run build-fast

# 2. Compile & test the 8-engine extension and 45 ade_* CLIs
(cd extensions/aexus-agents && ./../../scripts/aexus-env.sh npm run compile && ./../../scripts/aexus-env.sh npm test)

# 3. Launch from source
./scripts/aexus-env.sh ./scripts/code.sh

# 4. Package for macOS / Linux
ARCH=$(uname -m | sed 's/x86_64/x64/')
./scripts/aexus-env.sh pnpm run gulp "vscode-darwin-${ARCH}"
```

Windows PowerShell:

```powershell
.\scripts\aexus-env.ps1 pnpm install
.\scripts\aexus-env.ps1 pnpm run build-fast
.\scripts\aexus-env.ps1 .\scripts\code.bat
.\scripts\aexus-env.ps1 pnpm run gulp vscode-win32-x64
```

## Documentation & License

- **Architecture, Gallery & Security**: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/gallery.md`](docs/gallery.md) · [`SECURITY.md`](SECURITY.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CHANGELOG.md`](CHANGELOG.md).
- **License**: Derived from Microsoft [`Code - OSS`](https://github.com/microsoft/vscode) under the **[MIT License](LICENSE.txt)** with all upstream copyright notices preserved.
