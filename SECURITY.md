# Security Policy

## Security Architecture & Local-First Design

Aexus Code is engineered from the ground up as a **local-first, zero-middleman** developer workbench:

- **Authenticated Local Control Plane**: The `aexus-ade` control server binds strictly to a per-user local Unix domain socket (`~/.aexus-code/ade-control.sock` with `0600` permissions on macOS/Linux) or a local Windows Named Pipe (`\\.\pipe\aexus-ade-control-*`) gated by a per-launch cryptographic bearer token. It never exposes an unauthenticated network port.
- **Zero Private Key Handling**: SSH Cloud Host management and automatic VS Code SSH migration read only public host aliases, user names, ports, and `ProxyJump` metadata from `~/.ssh/config`. Private key bytes and passphrases are never copied, logged, or stored by Aexus Code — authentication delegates directly to the system OpenSSH client / SSH agent.
- **Direct Provider / BYO CLI Execution**: All 8 native Coding Agent engines (`claude`, `codex`, `agy`, `kilo`, `opencode`, `dsh`, `cline`, `pi`) execute locally using your own credentials and CLIs. Aexus Code bundles no proprietary telemetry relays or mandatory cloud login gates.
- **Hard Spend Guardrails**: Engineering and Research DAGs support optional `max_budget_usd` ceilings that automatically pause execution and raise a critical `ADE Inbox` alert before runaway multi-agent loops can exhaust API budgets.

## Reporting a Vulnerability

If you discover a security vulnerability in Aexus Code (such as command injection, path traversal, control-plane privilege escalation, or credential exposure):

1. **Do not** disclose the vulnerability publicly in a GitHub Issue before a fix is prepared.
2. Open a private **GitHub Security Advisory** on [`Daijunfan/Aexus-Code`](https://github.com/Daijunfan/Aexus-Code/security/advisories/new) with reproduction steps, affected platform(s), and impact assessment.
3. We aim to acknowledge reports within **48 hours** and provide a coordinated remediation timeline.
