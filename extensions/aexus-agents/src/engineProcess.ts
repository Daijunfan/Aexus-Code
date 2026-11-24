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
				return { nodeExe: nodeExe, jsEntry, useElectronAsNode: false };
			}
		}
	} catch { /* fallback to cmd.exe */ }
	return undefined;
}

function killPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
			return;
		}
	}
	try {
		process.kill(pid, signal);
	} catch { /* already exited */ }
}

async function main(): Promise<void> {
	// Node IPC tracks the host lifetime without consuming the engine's stdio protocol.
	const [rawExecutable, ...args] = process.argv.slice(2);
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.NODE_CHANNEL_FD;
	delete env.NODE_CHANNEL_SERIALIZATION_MODE;

	const executable = await resolveWindowsCommandIfBare(rawExecutable, env);
	const isPosix = process.platform !== 'win32';

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
		// Dedicated POSIX process group (`detached: true`) ensures `-child.pid` kills the CLI and ALL
		// grandchild subshells/compilers without prematurely killing this supervisor before SIGKILL escalation.
		child = cp.spawn(executable, args, {
			stdio: 'inherit',
			env,
			windowsHide: true,
			detached: isPosix,
		});
	}

	if (child.pid && typeof process.send === 'function') {
		try {
			process.send({ type: 'spawned', pid: child.pid });
		} catch { /* parent IPC may have closed */ }
	}

	let terminating = false;
	const terminate = (initialSignal: NodeJS.Signals = 'SIGTERM') => {
		if (!child.pid) {
			process.exit(1);
			return;
		}
		if (process.platform === 'win32') {
			if (terminating && initialSignal !== 'SIGKILL') {
				return;
			}
			terminating = true;
			const taskkill = cp.spawn(
				path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
				['/PID', String(child.pid), '/T', '/F'],
				{ windowsHide: true, stdio: 'ignore' },
			);
			const hardExit = setTimeout(() => {
				try { child.kill('SIGKILL'); } catch { /* ignore */ }
				process.exit(0);
			}, 2000);
			hardExit.unref?.();
			taskkill.on('exit', () => {
				clearTimeout(hardExit);
				process.exit(0);
			});
			taskkill.on('error', () => {
				clearTimeout(hardExit);
				try { child.kill(); } catch { /* ignore */ }
				process.exit(1);
			});
			return;
		}

		// POSIX: forward signal to child's dedicated PGID and stay alive up to 1.4s to enforce SIGKILL escalation.
		killPosixProcessGroup(child.pid, initialSignal);
		if (initialSignal === 'SIGKILL') {
			const finalExit = setTimeout(() => process.exit(0), 150);
			finalExit.unref?.();
			return;
		}
		if (terminating) {
			return;
		}
		terminating = true;
		if (initialSignal === 'SIGINT') {
			const termTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null && child.pid) {
					killPosixProcessGroup(child.pid, 'SIGTERM');
				}
			}, 650);
			termTimer.unref?.();
		}
		const killTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null && child.pid) {
				killPosixProcessGroup(child.pid, 'SIGKILL');
			}
			const hardExit = setTimeout(() => process.exit(0), 200);
			hardExit.unref?.();
		}, 1400);
		killTimer.unref?.();
	};

	process.on('SIGTERM', () => terminate('SIGTERM'));
	process.on('SIGINT', () => terminate('SIGINT'));
	process.on('SIGHUP', () => terminate('SIGTERM'));
	process.on('disconnect', () => terminate('SIGTERM'));
	process.on('message', (msg: unknown) => {
		if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'terminate') {
			const sig = (msg as { signal?: unknown }).signal;
			terminate(sig === 'SIGINT' || sig === 'SIGKILL' ? sig : 'SIGTERM');
		}
	});
	child.on('error', error => {
		console.error(error.message);
		process.exit(1);
	});
	child.on('exit', (code, signal) => {
		if (child.pid && isPosix) {
			// Sweep any lingering background grandchildren in the child's PGID when the main CLI exits.
			killPosixProcessGroup(child.pid, 'SIGKILL');
		}
		process.exit(code ?? (signal ? 1 : 0));
	});
}

void main();
