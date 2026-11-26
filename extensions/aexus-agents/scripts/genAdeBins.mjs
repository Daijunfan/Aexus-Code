#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ADE_CLI_COMMANDS = Object.freeze([
	// Module 0: Base (3)
	'ade_whoami',
	'ade_sysprompt_path',
	'ade_sysprompt_update',
	// Module 1: Ticket (7)
	'ade_create',
	'ade_destroy',
	'ade_edit',
	'ade_list',
	'ade_get',
	'ade_detail',
	'ade_history',
	// Module 2: Orchestration (15)
	'ade_host_list',
	'ade_engine_list',
	'ade_model_list',
	'ade_agent_list',
	'ade_agent_create',
	'ade_agent_edit',
	'ade_agent_move',
	'ade_agent_delete',
	'ade_dept_create',
	'ade_dept_edit',
	'ade_dept_delete',
	'ade_dept_member',
	'ade_dept_members',
	'ade_dept_info',
	'ade_wb_grant',
	// Module 3: White Board (20)
	'ade_wb_list',
	'ade_wb_my_perm',
	'ade_wb_members',
	'ade_wb_create',
	'ade_wb_config',
	'ade_wb_delete',
	'ade_wb_tags',
	'ade_wb_tag_manage',
	'ade_wb_post_msg',
	'ade_wb_upload_file',
	'ade_wb_items',
	'ade_wb_get_msg',
	'ade_wb_download',
	'ade_wb_edit_item',
	'ade_wb_delete_item',
	'ade_wb_manage_item',
	'ade_wb_note_send',
	'ade_wb_note_unread',
	'ade_wb_note_detail',
	'ade_wb_unread_all',
]);

if (ADE_CLI_COMMANDS.length !== 45) {
	throw new Error(`Expected exactly 45 ADE CLI commands, got ${ADE_CLI_COMMANDS.length}`);
}

const POSIX_RUNNER_SH = `#!/usr/bin/env sh
set -e
if [ -z "\${ADE_INVOKED_CMD:-}" ] && [ -z "\${ADE_CLI_CMD:-}" ]; then
  BASE_ZERO=$(basename -- "$0")
  if [ -n "$BASE_ZERO" ] && [ "$BASE_ZERO" != "_ade_runner" ]; then
    export ADE_INVOKED_CMD="$BASE_ZERO"
  fi
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLI_JS="$SCRIPT_DIR/../dist/adeCli.js"
if [ ! -f "$CLI_JS" ]; then
  CLI_JS="$SCRIPT_DIR/../extensions/aexus-agents/dist/adeCli.js"
fi
if [ ! -f "$CLI_JS" ]; then
  CLI_JS="$SCRIPT_DIR/../resources/app/extensions/aexus-agents/dist/adeCli.js"
fi
if [ ! -f "$CLI_JS" ]; then
  for VDIR in "$SCRIPT_DIR"/../*; do
    if [ -f "$VDIR/resources/app/extensions/aexus-agents/dist/adeCli.js" ]; then
      CLI_JS="$VDIR/resources/app/extensions/aexus-agents/dist/adeCli.js"
      break
    fi
  done
fi
exec_runtime() {
  BIN="$1"
  shift
  TARGET_JS="$CLI_JS"
  case "$BIN" in
    *.exe|*.EXE)
      if [ -n "\${WSL_DISTRO_NAME:-}" ] && command -v wslpath >/dev/null 2>&1; then
        TARGET_JS=$(wslpath -m "$CLI_JS")
        export WSLENV="ELECTRON_RUN_AS_NODE/w:ADE_INVOKED_CMD/u:ADE_CLI_CMD/u:ADE_AGENT_TOKEN/u:ADE_CONTROL_SOCKET/u:ADE_CONTROL_ENDPOINT/u:ADE_CONTROL_BRIDGE_FILE/u\${WSLENV:+:\$WSLENV}"
      elif command -v cygpath >/dev/null 2>&1; then
        TARGET_JS=$(cygpath -m "$CLI_JS")
      fi
      ;;
  esac
  exec "$BIN" "$TARGET_JS" "$@"
}
if [ -n "\${ADE_NODE_BIN:-}" ] && [ -x "\${ADE_NODE_BIN}" ]; then
  exec_runtime "$ADE_NODE_BIN" "$@"
fi
if command -v node >/dev/null 2>&1; then
  exec_runtime "$(command -v node)" "$@"
fi
for CAND in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/node-current/bin/node" "$HOME/.nvm/current/bin/node" "$HOME/.volta/bin/node" "$HOME/.asdf/shims/node" "$HOME/.bun/bin/node"; do
  if [ -x "$CAND" ]; then
    exec_runtime "$CAND" "$@"
  fi
done
if [ -d "$HOME/.nvm/versions/node" ]; then
  NVM_LATEST_NODE=""
  for NVDIR in "$HOME/.nvm/versions/node"/*; do
    if [ -x "$NVDIR/bin/node" ]; then
      NVM_LATEST_NODE="$NVDIR/bin/node"
    fi
  done
  if [ -n "$NVM_LATEST_NODE" ]; then
    exec_runtime "$NVM_LATEST_NODE" "$@"
  fi
fi
for ECAND in \\
  "$SCRIPT_DIR/../../../MacOS/Aexus Code" \\
  "$SCRIPT_DIR/../../../../../MacOS/Aexus Code" \\
  "$SCRIPT_DIR/../aexus-code" \\
  "$SCRIPT_DIR/../../../../../aexus-code" \\
  "$SCRIPT_DIR/../../../.build/electron/aexus-code" \\
  "$SCRIPT_DIR/../../../.build/electron/Aexus Code.app/Contents/MacOS/Aexus Code" \\
  "$SCRIPT_DIR/../Aexus Code.exe" \\
  "$SCRIPT_DIR/../../../../../Aexus Code.exe" \\
  "$SCRIPT_DIR/../../../../../../Aexus Code.exe" \\
  "$SCRIPT_DIR/../../../.build/electron/Aexus Code.exe"; do
  if [ -x "$ECAND" ]; then
    export ELECTRON_RUN_AS_NODE=1
    exec_runtime "$ECAND" "$@"
  fi
done
printf '{"ok":false,"code":"ERR_INVALID_ARGS","error":"Node.js runtime not found in PATH for ADE CLI"}\\n'
exit 1
`;

export function generateAdeBins(binDir = path.resolve(__dirname, '..', 'bin')) {
	fs.mkdirSync(binDir, { recursive: true });

	const validFiles = new Set(['_ade_runner', ...ADE_CLI_COMMANDS, ...ADE_CLI_COMMANDS.map(c => `${c}.cmd`)]);
	for (const entry of fs.readdirSync(binDir)) {
		if (!validFiles.has(entry)) {
			fs.rmSync(path.join(binDir, entry), { force: true });
		}
	}

	const runnerPath = path.join(binDir, '_ade_runner');
	fs.writeFileSync(runnerPath, POSIX_RUNNER_SH, { encoding: 'utf8', mode: 0o755 });
	fs.chmodSync(runnerPath, 0o755);

	for (const cmd of ADE_CLI_COMMANDS) {
		const posixWrapper = [
			'#!/usr/bin/env sh',
			`export ADE_INVOKED_CMD="${cmd}"`,
			'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
			'exec "$SCRIPT_DIR/_ade_runner" "$@"',
			'',
		].join('\n');
		const posixPath = path.join(binDir, cmd);
		fs.writeFileSync(posixPath, posixWrapper, { encoding: 'utf8', mode: 0o755 });
		fs.chmodSync(posixPath, 0o755);

		const winWrapper = [
			'@echo off',
			'setlocal',
			`set "ADE_INVOKED_CMD=${cmd}"`,
			'set "CLI_JS=%~dp0..\\dist\\adeCli.js"',
			'if not exist "%CLI_JS%" set "CLI_JS=%~dp0..\\extensions\\aexus-agents\\dist\\adeCli.js"',
			'if not exist "%CLI_JS%" set "CLI_JS=%~dp0..\\resources\\app\\extensions\\aexus-agents\\dist\\adeCli.js"',
			'if not exist "%CLI_JS%" for /d %%D in ("%~dp0..\\*") do if exist "%%~fD\\resources\\app\\extensions\\aexus-agents\\dist\\adeCli.js" set "CLI_JS=%%~fD\\resources\\app\\extensions\\aexus-agents\\dist\\adeCli.js"',
			'if defined ADE_NODE_BIN goto :run_ade_node',
			'where node >nul 2>nul',
			'if %ERRORLEVEL% EQU 0 goto :run_path_node',
			'set "ELECTRON_EXE=%~dp0..\\Aexus Code.exe"',
			'if not exist "%ELECTRON_EXE%" set "ELECTRON_EXE=%~dp0..\\..\\..\\..\\..\\Aexus Code.exe"',
			'if not exist "%ELECTRON_EXE%" set "ELECTRON_EXE=%~dp0..\\..\\..\\..\\..\\..\\Aexus Code.exe"',
			'if not exist "%ELECTRON_EXE%" set "ELECTRON_EXE=%~dp0..\\..\\..\\.build\\electron\\Aexus Code.exe"',
			'if exist "%ELECTRON_EXE%" goto :run_electron',
			'goto :run_path_node',
			':run_ade_node',
			'set "ADE_NODE_CLEAN=%ADE_NODE_BIN:"=%"',
			'"%ADE_NODE_CLEAN%" "%CLI_JS%" %*',
			'exit /b %ERRORLEVEL%',
			':run_electron',
			'set "ELECTRON_RUN_AS_NODE=1"',
			'"%ELECTRON_EXE%" "%CLI_JS%" %*',
			'exit /b %ERRORLEVEL%',
			':run_path_node',
			'node "%CLI_JS%" %*',
			'exit /b %ERRORLEVEL%',
			'',
		].join('\r\n');
		const winPath = path.join(binDir, `${cmd}.cmd`);
		fs.writeFileSync(winPath, winWrapper, { encoding: 'ascii' });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
	generateAdeBins();
}
