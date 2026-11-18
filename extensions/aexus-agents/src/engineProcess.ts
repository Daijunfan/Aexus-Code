/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Escapes an argument for Windows `CreateProcess` + `cmd.exe /d /s /c "..."` (`windowsVerbatimArguments: true`)
 * so paths with spaces and arguments containing quotes or cmd metacharacters (`%&|<>()^`) never split or expand,
 * while avoiding Node 24's `EINVAL` on direct `.cmd`/`.bat` spawns (CVE-2024-27980).
 */
function escapeWinCmdToken(arg: string, isCommand = false): string {
	if (isCommand) {
		return `"${arg.replace(/"/g, '')}"`;
	}
	let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
	escaped = escaped.replace(/(\\+)$/, '$1$1');
	escaped = `"${escaped}"`;
	return escaped.replace(/[()%!^"<>&|]/g, '^$&');
}

async function resolveWindowsCommandIfBare(cmd: string, env: NodeJS.ProcessEnv): Promise<string> {
	if (process.platform !== 'win32' || !cmd || path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
		return cmd;
	}
	if (/\.(exe|cmd|bat|com|ps1)$/i.test(cmd)) {
		return cmd;
	}
	const rawPath = env.Path ?? env.PATH ?? '';
	const dirs = rawPath.split(path.delimiter).map(d => d.trim().replace(/^"+|"+$/g, '')).filter(Boolean);
	for (const dir of dirs) {
		for (const ext of ['.exe', '.cmd', '.bat', '.com', '.ps1']) {
			const candidate = path.join(dir, cmd + ext);
			try {
				const st = await fs.stat(candidate);
				if (st.isFile()) {
					return candidate;
				}
			} catch { /* continue */ }
		}
	}
	return cmd;
}

/**
 * Unwraps Windows npm/node `.cmd` shims (`"%dp0%\node_modules\...\cli.js" %*` or `"node.exe" "script.js" %*`)
 * so Node CLI agents spawn directly via `CreateProcessW` without going through `cmd.exe` (which truncates
 * multiline arguments like `--append-system-prompt` at `\n`).
 */
async function tryUnwrapWindowsCmdNodeShim(cmdPath: string, env: NodeJS.ProcessEnv): Promise<{ nodeExe: string; jsEntry: string; useElectronAsNode: boolean } | undefined> {
	try {
		const st = await fs.stat(cmdPath);
		if (!st.isFile() || st.size > 32 * 1024) {
			return undefined;
		}
		const content = await fs.readFile(cmdPath, 'utf8');
		const cmdDir = path.dirname(cmdPath);

		const dp0Match = content.match(/"%(?:~)?dp0%?\\([^"]+\.(?:c|m)?js)"\s+%\*/i);
		if (dp0Match) {
			const jsEntry = path.resolve(cmdDir, dp0Match[1].replace(/\\/g, path.sep));
			const stJs = await fs.stat(jsEntry).catch(() => undefined);
			if (stJs?.isFile()) {
				const siblingNode = path.join(cmdDir, 'node.exe');
				const stSibling = await fs.stat(siblingNode).catch(() => undefined);
				if (stSibling?.isFile()) {
					return { nodeExe: siblingNode, jsEntry, useElectronAsNode: false };
				}
				const pathNode = await resolveWindowsCommandIfBare('node', env);
				if (/\.exe$/i.test(pathNode)) {
					return { nodeExe: pathNode, jsEntry, useElectronAsNode: false };
				}
				return { nodeExe: process.execPath, jsEntry, useElectronAsNode: true };
			}
		}

		const directNodeMatch = content.match(/^"([^"]*node(?:\.exe)?)"\s+"([^"]+\.(?:c|m)?js)"\s+%\*\s*$/im);
		if (directNodeMatch) {
			const nodeExe = directNodeMatch[1];
			const jsEntry = directNodeMatch[2];
			const [stNode, stJs] = await Promise.all([fs.stat(nodeExe).catch(() => undefined), fs.stat(jsEntry).catch(() => undefined)]);
			if (stNode?.isFile() && stJs?.isFile()) {
				return { nodeExe, jsEntry, useElectronAsNode: false };
			}
		}
	} catch { /* fallback to cmd.exe */ }
	return undefined;
}

async function main(): Promise<void> {
	// Node IPC tracks the host lifetime without consuming the engine's stdio protocol.
	const [rawExecutable, ...args] = process.argv.slice(2);
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.NODE_CHANNEL_FD;
	delete env.NODE_CHANNEL_SERIALIZATION_MODE;

	const executable = await resolveWindowsCommandIfBare(rawExecutable, env);

	let child: cp.ChildProcess;
	if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
		const unwrapped = await tryUnwrapWindowsCmdNodeShim(executable, env);
		if (unwrapped) {
			const childEnv = unwrapped.useElectronAsNode ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env;
			child = cp.spawn(unwrapped.nodeExe, [unwrapped.jsEntry, ...args], {
				stdio: 'inherit',
				env: childEnv,
				windowsHide: true,
			});
		} else {
			const comspec = env.ComSpec || path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
			const innerCmd = [escapeWinCmdToken(executable, true), ...args.map(a => escapeWinCmdToken(a, false))].join(' ');
			child = cp.spawn(comspec, ['/d', '/s', '/c', `"${innerCmd}"`], {
				stdio: 'inherit',
				env,
				windowsHide: true,
				windowsVerbatimArguments: true,
			});
		}
	} else if (process.platform === 'win32' && /\.ps1$/i.test(executable)) {
		const psExe = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
		child = cp.spawn(psExe, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args], {
			stdio: 'inherit',
			env,
			windowsHide: true,
		});
	} else {
		child = cp.spawn(executable, args, {
			stdio: 'inherit',
			env,
			windowsHide: true,
		});
	}

	const terminate = () => {
		if (process.platform === 'win32') {
			if (!child.pid) { process.exit(1); }
			const taskkill = cp.spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
			taskkill.on('exit', () => process.exit(0));
			taskkill.on('error', () => { child.kill(); process.exit(1); });
		} else if (child.pid) {
			try { process.kill(-process.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
		}
	};
	process.on('disconnect', terminate);
	child.on('error', error => { console.error(error.message); process.exit(1); });
	child.on('exit', code => process.exit(code ?? 1));
}

void main();
