# Aexus Agent Engines

`aexus-agents` connects Aexus Code and ADE Project Pages to your installed Coding Agent CLIs while keeping each engine's native authentication, model configuration, permissions, and conversation transcripts intact:

- **Claude Code** (`claude`): streaming JSON CLI protocol + native JSONL resume and cleanup.
- **Codex** (`codex`): stdio app-server protocol + native thread history and cleanup.
- **Kilo Code** (`kilo`) & **OpenCode** (`opencode`): loopback server / SSE session lifecycle.
- **DeepSeek Harness** (`dsh`): ACP (`--profile acp`) + multi-frame Zstandard `.jsonl.zstd` history.
- **Google Antigravity** (`agy`): ACP (`agy acp`) + native conversation lifecycle.
- **Cline** (`cline`): ACP (`cline --acp`) + provider bridging and native history.
- **Pi** (`pi`): RPC mode (`pi --mode rpc`) + JSONL session lifecycle.

## ADE Project Pages & 45 `ade_*` CLI Executables

When an employee node runs inside an ADE Project Page:
- Each employee runs in an isolated daemon slot (`ade:${projectId}:${agentId}`) with an in-memory `ADE_AGENT_TOKEN` authenticated over a full-duplex mutual HMAC-SHA256 UDS / SSH reverse tunnel.
- All 45 standalone `ade_*` CLI executables (`ade_whoami`, `ade_sysprompt_path`, `ade_create`, `ade_edit`, `ade_agent_create`, `ade_wb_post_msg`, etc.) are automatically exposed on `PATH` (`bin/ade_*` locally and `~/.ade_store/_bin/ade_*` on remote SSH Cloud Hosts).
- Standalone IDE chat sessions run with zero ADE environment variables and zero prompt modifications.

See `resources/NOTICE.md` for icon attributions.
