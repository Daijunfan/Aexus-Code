# Aexus Agent Engines

ADE uses the standard VS Code chat editor with installed Coding Agent CLIs, retaining each engine's native authentication, model configuration, permissions, and conversation history:

- **Codex** (`codex`): stdio app-server protocol + rollout/session index history + permanent thread/file deletion.
- **Claude Code** (`claude`): streaming JSON CLI protocol + native session JSONL resume & permanent deletion.
- **Kilo Code** (`kilo`) & **OpenCode** (`opencode`): JSON CLI / loopback server session lifecycle + permanent session deletion.
- **DeepSeek Harness** (`dsh`): ACP (`--profile acp`) + multi-frame Zstandard `.jsonl.zstd` history & session cache cleanup.
- **Google Antigravity** (`agy`): ACP (`agy chat --acp`) + native session lifecycle.
- **Cline** (`cline`): ACP (`cline --acp`) with automatic `~/.cline/data/settings/providers.json` environment bridging + `cline history` listing & permanent deletion.
- **Pi** (`pi`): RPC mode (`pi --mode rpc`) + `~/.pi/agent/sessions` JSONL history & permanent deletion.

ADE distinguishes **Remove from Sidebar** (detaches the sidebar entry without touching engine storage) from **Delete Permanently** (invokes the engine runtime's `delete` implementation to wipe the underlying native session history). Built-in `aexus-ade` CLI (`bin/aexus-ade` -> `dist/adeCli.js`) is automatically prepended to `PATH` for engine subprocesses and integrated terminals.

Engine-created child conversations appear beneath their actual parent session. Codex and Kilo report new children during a request; startup, completed requests, and the Refresh action also discover persisted children. Removing a child shortcut hides it from subsequent discovery until it is explicitly attached again. Custom ADE names apply to the tree and editor tabs without renaming the engine's native conversation.

Open child views receive updated native history when their parent finishes work or the projects are refreshed. Native message IDs keep these updates stable, and the workbench retains unsent drafts. Permission and question prompts identify their engine and project directory.

Claude Code subagent transcripts and Codex v2 subagents use the native read-only chat view: their engines keep control in the parent conversation. Open Parent Conversation returns to that controlling session. Codex child history is inspected without resuming execution; resumable older children restore their parent chain before a new request.

Root conversation IDs retain the selected project even when multiple conversations share one folder. New entries follow conversation title updates, while manually assigned ADE names are retained. A new terminal keeps the project selected when its creation was requested.

The built-in bridge runs in its own local extension host. Local IDE workspace-folder and trust transitions restart workspace extensions while retaining ADE requests. Explicit extension-host restarts, profile changes, and application shutdown still stop the bridge. Engine processes share its lifetime, including after an unexpected host exit. Server and inventory processes start from the user home directory; individual requests use the selected local ADE project. IDE workspace trust does not grant permissions to an ADE engine: execution continues to use that engine's native permission controls.

CLI executables are discovered from PATH and common user installation locations. `aexus.ade.cliPaths` can explicitly select an executable. Engine settings continue to be managed in the engine itself. These built-in providers are private to the ADE creation flow; IDE extensions retain their existing interfaces.

Other extensions can supply sessions through the standard `chatSessions` provider API. ADE requires an authoritative project directory in session metadata before attaching a session, and does not invent a CLI protocol for unrecognized engines.

Engine icons retain their original artwork. See `resources/NOTICE.md` for the Kilo icon attribution.
