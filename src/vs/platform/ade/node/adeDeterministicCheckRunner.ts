/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { stripAdeControlEnv } from '../common/adeControl.js';
import {
	IAdeDeterministicCheckRequest,
	IAdeDeterministicCheckResponse,
} from '../common/adeEngineering.js';
import type { IAdeRemoteWatchdogProbe } from './adeMissionWatchdogService.js';

const MAX_CHECK_MEMORY_BYTES = 64 * 1024;
const MAX_CHECK_TAIL_CHARS = 2_400;

function appendTailBuffer(prev: string, chunk: string, maxChars: number): string {
	const next = prev + chunk;
	if (next.length <= maxChars) {
		return next;
	}
	return next.slice(next.length - maxChars);
}

function formatBoundedOutputTail(raw: string, maxChars = MAX_CHECK_TAIL_CHARS): string {
	const trimmed = raw.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}
	const tail = trimmed.slice(trimmed.length - maxChars);
	const newlineIdx = tail.indexOf('\n');
	const aligned = newlineIdx >= 0 && newlineIdx < 160 ? tail.slice(newlineIdx + 1) : tail;
	return `…[truncated ${trimmed.length - aligned.length} chars]\n${aligned}`;
}

function matchesExpectedOutput(output: string, pattern: string): boolean {
	const trimmed = pattern.trim();
	if (!trimmed) {
		return true;
	}
	const regexLiteral = /^\/(.+)\/([a-z]*)$/.exec(trimmed);
	if (regexLiteral) {
		try {
			const re = new RegExp(regexLiteral[1], regexLiteral[2]);
			return re.test(output);
		} catch {
			return output.includes(trimmed);
		}
	}
	return output.includes(trimmed);
}

function runLocalDeterministicShell(
	command: string,
	cwd: string | undefined,
	timeoutMs: number,
): Promise<{ readonly exitCode: number; readonly output: string; readonly timedOut: boolean; readonly durationMs: number; readonly error?: string }> {
	const startedAt = Date.now();
	return new Promise(resolve => {
		const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
		const shellArgs = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];
		let child;
		try {
			child = spawn(shell, shellArgs, {
				cwd: cwd || undefined,
				windowsHide: true,
				detached: !isWindows,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: stripAdeControlEnv(process.env),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			resolve({ exitCode: 1, output: msg, timedOut: false, durationMs: Math.max(0, Date.now() - startedAt), error: msg });
			return;
		}

		let combined = '';
		let settled = false;
		let timedOut = false;

		const killTree = () => {
			if (!child.pid) {
				return;
			}
			try {
				if (!isWindows) {
					process.kill(-child.pid, 'SIGKILL');
				} else {
					child.kill('SIGKILL');
				}
			} catch {
				try { child.kill('SIGKILL'); } catch { /* already exited */ }
			}
		};

		const timer = setTimeout(() => {
			if (!settled) {
				timedOut = true;
				killTree();
			}
		}, timeoutMs);

		const onChunk = (buf: Buffer | string) => {
			const text = typeof buf === 'string' ? buf : buf.toString('utf8');
			combined = appendTailBuffer(combined, text, MAX_CHECK_MEMORY_BYTES);
		};
		child.stdout?.on('data', onChunk);
		child.stderr?.on('data', onChunk);

		child.once('error', err => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				const msg = err instanceof Error ? err.message : String(err);
				resolve({
					exitCode: timedOut ? 124 : 1,
					output: combined || msg,
					timedOut,
					durationMs: Math.max(0, Date.now() - startedAt),
					error: msg,
				});
			}
		});

		child.once('close', code => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({
					exitCode: timedOut ? 124 : (typeof code === 'number' ? code : 1),
					output: combined,
					timedOut,
					durationMs: Math.max(0, Date.now() - startedAt),
					...(timedOut ? { error: `Deterministic check timed out after ${timeoutMs}ms` } : {}),
				});
			}
		});
	});
}

/**
 * Executes a zero-token deterministic verification hook locally or on a remote SSH Cloud Host
 * via `remoteProbe`, verifying exit code, output pattern match, and non-empty artifact files.
 */
export async function executeAdeDeterministicCheck(
	request: IAdeDeterministicCheckRequest,
	remoteProbe?: IAdeRemoteWatchdogProbe,
): Promise<IAdeDeterministicCheckResponse> {
	const startedAt = Date.now();
	const hostAlias = request.hostAlias?.trim() || 'local';
	const isRemote = hostAlias !== 'local';
	const expectedExitCode = Number.isInteger(request.expectExitCode) ? Number(request.expectExitCode) : 0;
	const timeoutMs = Math.max(1_000, Math.min(300_000, Math.round(request.timeoutMs ?? 120_000)));
	const command = request.command?.trim() || undefined;
	const cwd = request.cwd?.trim() || undefined;
	const expectFiles = (request.expectFiles ?? []).map(f => f.trim()).filter(Boolean);
	const expectOutputMatch = request.expectOutputMatch?.trim() || undefined;

	if (!command && expectFiles.length === 0) {
		return {
			checkId: request.checkId,
			name: request.name,
			hostAlias,
			cwd,
			passed: false,
			exitCode: -1,
			expectedExitCode,
			durationMs: Math.max(0, Date.now() - startedAt),
			outputTail: '',
			error: 'Invalid deterministic check hook: must specify a command or at least one expected file.',
		};
	}

	let exitCode = 0;
	let timedOut = false;
	let rawOutput = '';
	let execError: string | undefined;

	if (command) {
		if (isRemote) {
			if (!remoteProbe?.remoteExecCommand) {
				return {
					checkId: request.checkId,
					name: request.name,
					command,
					hostAlias,
					cwd,
					passed: false,
					exitCode: -1,
					expectedExitCode,
					durationMs: Math.max(0, Date.now() - startedAt),
					outputTail: '',
					error: `Remote deterministic check execution is unavailable for SSH host "${hostAlias}".`,
				};
			}
			const remoteRes = await remoteProbe.remoteExecCommand(hostAlias, {
				command,
				cwd,
				timeoutMs,
				maxOutputChars: MAX_CHECK_TAIL_CHARS,
			});
			exitCode = remoteRes.exitCode;
			rawOutput = remoteRes.outputTail;
			timedOut = remoteRes.timedOut;
			execError = remoteRes.error;
		} else {
			const localRes = await runLocalDeterministicShell(command, cwd, timeoutMs);
			exitCode = localRes.exitCode;
			rawOutput = localRes.output;
			timedOut = localRes.timedOut;
			execError = localRes.error;
		}
	}

	const exitOk = !timedOut && !execError && (!command || exitCode === expectedExitCode);
	const outputMatchFailed = Boolean(command && expectOutputMatch && !matchesExpectedOutput(rawOutput, expectOutputMatch));

	const missingFiles: string[] = [];
	if (expectFiles.length > 0 && exitOk && !outputMatchFailed) {
		for (const relOrAbs of expectFiles) {
			const resolvedTarget = isRemote
				? (relOrAbs.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relOrAbs)
					? relOrAbs
					: (cwd ? path.posix.join(cwd, relOrAbs) : relOrAbs))
				: (path.isAbsolute(relOrAbs) ? relOrAbs : (cwd ? path.resolve(cwd, relOrAbs) : path.resolve(relOrAbs)));
			let existsOk = false;
			if (isRemote) {
				try {
					if (remoteProbe?.remoteStat) {
						const st = await remoteProbe.remoteStat(hostAlias, resolvedTarget);
						existsOk = st.type === 'directory' || st.size > 0;
					} else if (remoteProbe) {
						const mtime = await remoteProbe.remoteFileStatMtime(hostAlias, resolvedTarget);
						existsOk = mtime !== undefined;
					}
				} catch {
					existsOk = false;
				}
			} else {
				try {
					const st = await fs.promises.stat(resolvedTarget);
					existsOk = st.isDirectory() || st.size > 0;
				} catch {
					existsOk = false;
				}
			}
			if (!existsOk) {
				missingFiles.push(relOrAbs);
			}
		}
	}

	const passed = exitOk && !outputMatchFailed && missingFiles.length === 0;
	const errorParts: string[] = [];
	if (execError) {
		errorParts.push(execError);
	} else if (command && exitCode !== expectedExitCode) {
		errorParts.push(`Exit code ${exitCode} (expected ${expectedExitCode})`);
	}
	if (outputMatchFailed) {
		errorParts.push(`Output did not match required pattern "${expectOutputMatch}"`);
	}
	if (missingFiles.length > 0) {
		errorParts.push(`Missing or empty required artifact(s): ${missingFiles.join(', ')}`);
	}

	return {
		checkId: request.checkId,
		...(request.name ? { name: request.name } : {}),
		...(command ? { command } : {}),
		hostAlias,
		...(cwd ? { cwd } : {}),
		passed,
		exitCode,
		expectedExitCode,
		...(timedOut ? { timedOut: true } : {}),
		durationMs: Math.max(0, Date.now() - startedAt),
		...(missingFiles.length > 0 ? { missingFiles } : {}),
		...(outputMatchFailed ? { outputMatchFailed: true } : {}),
		outputTail: formatBoundedOutputTail(rawOutput),
		...(errorParts.length > 0 ? { error: errorParts.join('; ') } : {}),
	};
}
