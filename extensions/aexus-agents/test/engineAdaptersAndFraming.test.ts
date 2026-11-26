/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { LineByteAccumulator } from '../src/lineByteAccumulator.ts';
import {
	ADE_SAFE_CLI_COMMANDS,
	isClaudeEffortRejectedError,
	isOversizedClaudeUserEchoLine,
	isSafeAdeBashCommand,
	mapClaudeEffortArg,
	mapClaudeThinkingTokens,
	mapCodexReasoningEffort,
	planCodexTurnFallbacks,
	registerSpawnedEngineChildForTracking,
	stopSpawnedEngineProcess,
	truncateToolPreview,
} from '../src/engineAdapterHelpers.ts';

describe('LineByteAccumulator O(N) chunk-array byte framing', () => {
	test('frames split multi-byte UTF-8 lines, strips CRLF, and tracks exact byte offsets', () => {
		const acc = new LineByteAccumulator();
		const line1 = '{"seq":1,"msg":"你好世界"}\n';
		const line2 = '{"seq":2,"msg":"🚀✨"}\r\n';
		const tail = '{"seq":3,"partial":true}';
		const full = Buffer.concat([Buffer.from(line1, 'utf8'), Buffer.from(line2, 'utf8'), Buffer.from(tail, 'utf8')]);

		const out: Array<{ text: string; bytes: number }> = [];
		const splits = [0, 5, 17, 19, 28, full.indexOf(0x0d) + 1, full.length];
		for (let i = 0; i < splits.length - 1; i++) {
			acc.push(full.subarray(splits[i], splits[i + 1]), (text, bytes) => {
				out.push({ text, bytes });
			});
		}

		assert.deepStrictEqual(out, [
			{ text: '{"seq":1,"msg":"你好世界"}', bytes: Buffer.byteLength(line1, 'utf8') },
			{ text: '{"seq":2,"msg":"🚀✨"}', bytes: Buffer.byteLength(line2, 'utf8') },
		]);
		assert.strictEqual(acc.pendingBytes, Buffer.byteLength(tail, 'utf8'));

		const flushed: Array<{ text: string; bytes: number }> = [];
		acc.flushTail((text, bytes) => flushed.push({ text, bytes }));
		assert.deepStrictEqual(flushed, [{ text: tail, bytes: Buffer.byteLength(tail, 'utf8') }]);
		assert.strictEqual(acc.pendingBytes, 0);
	});

	test('drops oversized single lines exceeding maxLineBytes without crashing and recovers on next newline', () => {
		const acc = new LineByteAccumulator(64);
		const seen: string[] = [];
		acc.push(Buffer.from('a'.repeat(50), 'utf8'), line => seen.push(line));
		acc.push(Buffer.from('b'.repeat(50), 'utf8'), line => seen.push(line));
		acc.push(Buffer.from('c'.repeat(10) + '\n{"ok":true}\n', 'utf8'), line => seen.push(line));
		assert.deepStrictEqual(seen, ['{"ok":true}']);
	});
});

describe('Engine adapter thinking mappings, fallback cascades & safe 45-command ade_* CLI guards', () => {
	test('maps thinking="max" distinctly from "high" across Claude and Codex', () => {
		assert.strictEqual(mapClaudeThinkingTokens('high'), '31999');
		assert.strictEqual(mapClaudeThinkingTokens('xhigh'), '48000');
		assert.strictEqual(mapClaudeThinkingTokens('max'), '64000');
		assert.strictEqual(mapClaudeThinkingTokens('off'), '0');
		assert.strictEqual(mapClaudeEffortArg('max'), 'max');
		assert.strictEqual(mapClaudeEffortArg('xhigh'), 'high');
		assert.strictEqual(isClaudeEffortRejectedError('error: unknown option \'--effort\''), true);
		assert.strictEqual(isClaudeEffortRejectedError('Invalid value "max" for --effort'), true);
		assert.strictEqual(isClaudeEffortRejectedError('Authentication failed'), false);

		assert.strictEqual(mapCodexReasoningEffort('high'), 'high');
		assert.strictEqual(mapCodexReasoningEffort('xhigh'), 'xhigh');
		assert.strictEqual(mapCodexReasoningEffort('max'), 'max');
		assert.strictEqual(mapCodexReasoningEffort('ultra'), 'ultra');
		assert.strictEqual(mapCodexReasoningEffort('off'), 'minimal');
	});

	test('planCodexTurnFallbacks downgrades reasoning effort on requestedModel before falling back to defaultModel', () => {
		const fallbacks = planCodexTurnFallbacks(
			'o4-mini-custom',
			'xhigh',
			'gpt-5-codex',
			'Unsupported value: reasoning_effort xhigh is not supported on this model',
		);
		assert.deepStrictEqual(fallbacks, [
			{ model: 'o4-mini-custom', effort: 'high' },
			{ model: 'o4-mini-custom', effort: undefined },
			{ model: 'gpt-5-codex', effort: 'high', pinDefaultModel: true },
			{ model: 'gpt-5-codex', effort: undefined, pinDefaultModel: true },
		]);
	});

	test('isSafeAdeBashCommand allows exact 45 ade_* commands & safe stdin pipes while blocking compound or injected commands', () => {
		assert.strictEqual(ADE_SAFE_CLI_COMMANDS.size, 45);
		for (const cmd of ADE_SAFE_CLI_COMMANDS) {
			assert.strictEqual(isSafeAdeBashCommand(`${cmd}`), true, `Expected ${cmd} to be allowlisted`);
		}

		assert.strictEqual(isSafeAdeBashCommand('/Users/dev/.ade_store/_bin/ade_whoami'), true);
		assert.strictEqual(isSafeAdeBashCommand('printf \'%s\\n\' "## Spec" | ade_wb_post_msg wb_01 --summary "spec" --stars 5 --detail-stdin'), true);
		assert.strictEqual(isSafeAdeBashCommand([
			`cat <<'EOF' | ade_create --to agent_l2 --type dev --title "Auth" --summary "Impl" --need-return true --detail-stdin`,
			`## Spec from bare cat heredoc with $(not_expanded) & rm -rf text`,
			`EOF`,
		].join('\n')), true);
		assert.strictEqual(isSafeAdeBashCommand('NO_COLOR=1 ade_list 2>&1'), true);

		// Reject compound commands, command substitution, redirects, env spoofing, and arbitrary file reads
		assert.strictEqual(isSafeAdeBashCommand('ade_whoami; rm -rf /tmp/x'), false);
		assert.strictEqual(isSafeAdeBashCommand('ade_whoami && curl https://evil.example'), false);
		assert.strictEqual(isSafeAdeBashCommand('cd /Users/dev/repo && ade_list'), false);
		assert.strictEqual(isSafeAdeBashCommand('ade_wb_note_send wb_01 --to a1 --text "$(whoami)"'), false);
		assert.strictEqual(isSafeAdeBashCommand('ade_wb_note_send wb_01 --to a1 --text "`id`"'), false);
		assert.strictEqual(isSafeAdeBashCommand('ade_whoami > /etc/passwd'), false);
		assert.strictEqual(isSafeAdeBashCommand(`ade_wb_note_send wb_01 --to a1 --text "<<'EOF'"\nrm -rf /tmp/pwn\nEOF`), false);
		assert.strictEqual(isSafeAdeBashCommand(`NODE_OPTIONS='-r /tmp/pwn.js' ade_whoami`), false);
		assert.strictEqual(isSafeAdeBashCommand(`PATH=/tmp ade_whoami`), false);
		assert.strictEqual(isSafeAdeBashCommand(`ADE_AGENT_TOKEN=spoof ade_whoami`), false);
		assert.strictEqual(isSafeAdeBashCommand('cat ~/.ssh/id_rsa | ade_wb_post_msg wb_01 --summary "done" --stars 3 --detail-stdin'), false);
		assert.strictEqual(isSafeAdeBashCommand([
			`ade_wb_post_msg wb_01 --summary "x" --stars 3 --detail-stdin <<EOF`,
			`$(touch /tmp/pwn)`,
			`EOF`,
		].join('\n')), false);
	});

	test('isOversizedClaudeUserEchoLine & truncateToolPreview bound memory on multi-MB tool results', () => {
		const bigUserLine = `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"${'x'.repeat(80_000)}"}]}}`;
		assert.strictEqual(isOversizedClaudeUserEchoLine(bigUserLine, 65_536), true);

		const bigAssistantLine = `{"type":"assistant","message":{"role":"assistant","content":"${'y'.repeat(80_000)}"}}`;
		assert.strictEqual(isOversizedClaudeUserEchoLine(bigAssistantLine, 65_536), false);

		const truncated = truncateToolPreview('z'.repeat(10_000), 200);
		assert.ok(truncated.length < 240);
		assert.ok(truncated.endsWith('… [truncated]'));
	});
});

describe('engineProcess dedicated PGID containment & killTree split', { skip: process.platform === 'win32' ? 'POSIX PGID test' : false }, () => {
	test('terminates both inner CLI and spawned background grandchild when IPC disconnects or SIGTERM (killTree: true) arrives', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aexus-engine-pgid-'));
		const childPidFile = path.join(tmpDir, 'inner.pid');
		const grandPidFile = path.join(tmpDir, 'grand.pid');
		const innerCli = path.join(tmpDir, 'fake-cli.cjs');
		const grandScript = path.join(tmpDir, 'grand.cjs');

		fs.writeFileSync(grandScript, [
			`'use strict';`,
			`const fs = require('node:fs');`,
			`fs.writeFileSync(process.argv[2], String(process.pid));`,
			`setInterval(() => {}, 1000);`,
		].join('\n'));
		fs.writeFileSync(innerCli, [
			`'use strict';`,
			`const cp = require('node:child_process');`,
			`const fs = require('node:fs');`,
			`fs.writeFileSync(process.argv[2], String(process.pid));`,
			`cp.spawn(process.execPath, [process.argv[3], process.argv[4]], { stdio: 'ignore' });`,
			`setInterval(() => {}, 1000);`,
		].join('\n'));

		const esbuild = await import('esbuild');
		const compiledLauncher = path.join(tmpDir, 'engineProcess.cjs');
		await esbuild.build({
			entryPoints: [path.resolve(import.meta.dirname, '../src/engineProcess.ts')],
			bundle: true,
			platform: 'node',
			format: 'cjs',
			outfile: compiledLauncher,
		});

		const wrapper = cp.spawn(
			process.execPath,
			[compiledLauncher, process.execPath, innerCli, childPidFile, grandScript, grandPidFile],
			{ stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
		);

		const waitForPid = async (file: string): Promise<number> => {
			const deadline = Date.now() + 4_000;
			while (Date.now() < deadline) {
				if (fs.existsSync(file)) {
					const val = Number(fs.readFileSync(file, 'utf8').trim());
					if (Number.isInteger(val) && val > 0) {
						return val;
					}
				}
				await new Promise(r => setTimeout(r, 25));
			}
			throw new Error(`Timed out waiting for PID file ${file}`);
		};

		const isAlive = (pid: number): boolean => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};

		try {
			const innerPid = await waitForPid(childPidFile);
			const grandPid = await waitForPid(grandPidFile);
			assert.strictEqual(isAlive(innerPid), true);
			assert.strictEqual(isAlive(grandPid), true);

			wrapper.disconnect();

			const deadline = Date.now() + 4_000;
			while ((isAlive(innerPid) || isAlive(grandPid)) && Date.now() < deadline) {
				await new Promise(r => setTimeout(r, 30));
			}
			assert.strictEqual(isAlive(innerPid), false, 'Inner CLI process must be terminated');
			assert.strictEqual(isAlive(grandPid), false, 'Grandchild process in dedicated PGID must be terminated (zero orphans)');
		} finally {
			try { wrapper.kill('SIGKILL'); } catch { }
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('stopSpawnedEngineProcess(..., "SIGINT", { killTree: false }) interrupts ONLY inner CLI while sparing detached background grandchild', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aexus-engine-steer-'));
		const childPidFile = path.join(tmpDir, 'inner.pid');
		const grandPidFile = path.join(tmpDir, 'grand.pid');
		const innerSigFile = path.join(tmpDir, 'inner.sigint');
		const innerCli = path.join(tmpDir, 'fake-cli.cjs');
		const grandScript = path.join(tmpDir, 'grand.cjs');

		fs.writeFileSync(grandScript, [
			`'use strict';`,
			`const fs = require('node:fs');`,
			`fs.writeFileSync(process.argv[2], String(process.pid));`,
			`setInterval(() => {}, 1000);`,
		].join('\n'));
		fs.writeFileSync(innerCli, [
			`'use strict';`,
			`const cp = require('node:child_process');`,
			`const fs = require('node:fs');`,
			`fs.writeFileSync(process.argv[2], String(process.pid));`,
			`const bg = cp.spawn(process.execPath, [process.argv[3], process.argv[4]], { detached: true, stdio: 'ignore' });`,
			`bg.unref();`,
			`process.on('SIGINT', () => { fs.writeFileSync(process.argv[5], 'got-sigint'); });`,
			`setInterval(() => {}, 1000);`,
		].join('\n'));

		const esbuild = await import('esbuild');
		const compiledLauncher = path.join(tmpDir, 'engineProcess.cjs');
		await esbuild.build({
			entryPoints: [path.resolve(import.meta.dirname, '../src/engineProcess.ts')],
			bundle: true,
			platform: 'node',
			format: 'cjs',
			outfile: compiledLauncher,
		});

		const wrapper = cp.spawn(
			process.execPath,
			[compiledLauncher, process.execPath, innerCli, childPidFile, grandScript, grandPidFile, innerSigFile],
			{ detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
		);
		registerSpawnedEngineChildForTracking(wrapper);

		const waitForPid = async (file: string): Promise<number> => {
			const deadline = Date.now() + 4_000;
			while (Date.now() < deadline) {
				if (fs.existsSync(file)) {
					const val = Number(fs.readFileSync(file, 'utf8').trim());
					if (Number.isInteger(val) && val > 0) {
						return val;
					}
				}
				await new Promise(r => setTimeout(r, 25));
			}
			throw new Error(`Timed out waiting for PID file ${file}`);
		};

		const isAlive = (pid: number): boolean => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};

		let grandPid = 0;
		try {
			const innerPid = await waitForPid(childPidFile);
			grandPid = await waitForPid(grandPidFile);
			await new Promise(r => setTimeout(r, 40));
			assert.strictEqual(isAlive(innerPid), true);
			assert.strictEqual(isAlive(grandPid), true);

			stopSpawnedEngineProcess(wrapper, 'SIGINT', { killTree: false });
			const deadline = Date.now() + 2_000;
			while (!fs.existsSync(innerSigFile) && Date.now() < deadline) {
				await new Promise(r => setTimeout(r, 20));
			}
			assert.strictEqual(fs.existsSync(innerSigFile), true, 'Inner CLI must receive SIGINT');
			assert.strictEqual(isAlive(grandPid), true, 'Detached background grandchild MUST remain alive on killTree: false');
		} finally {
			if (grandPid > 0) {
				try { process.kill(grandPid, 'SIGKILL'); } catch { }
			}
			try { stopSpawnedEngineProcess(wrapper, 'SIGKILL', { killTree: true }); } catch { }
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('preserves NON-detached background grandchild in the SAME PGID when inner CLI exits normally or exits after killTree: false SIGINT', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aexus-engine-same-pgid-'));
		const esbuild = await import('esbuild');
		const compiledLauncher = path.join(tmpDir, 'engineProcess.cjs');
		await esbuild.build({
			entryPoints: [path.resolve(import.meta.dirname, '../src/engineProcess.ts')],
			bundle: true,
			platform: 'node',
			format: 'cjs',
			outfile: compiledLauncher,
		});

		const grandScript = path.join(tmpDir, 'grand.cjs');
		fs.writeFileSync(grandScript, [
			`'use strict';`,
			`const fs = require('node:fs');`,
			`process.on('SIGINT', () => {});`,
			`const tmp = process.argv[2] + '.tmp';`,
			`fs.writeFileSync(tmp, String(process.pid));`,
			`fs.renameSync(tmp, process.argv[2]);`,
			`setTimeout(() => process.exit(0), 15000).unref();`,
			`setInterval(() => {}, 1000);`,
		].join('\n'));

		const isAlive = (pid: number): boolean => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};

		const waitForPid = async (file: string): Promise<number> => {
			const deadline = Date.now() + 4_000;
			while (Date.now() < deadline) {
				if (fs.existsSync(file)) {
					const val = Number(fs.readFileSync(file, 'utf8').trim());
					if (Number.isInteger(val) && val > 0) {
						return val;
					}
				}
				await new Promise(r => setTimeout(r, 20));
			}
			throw new Error(`Timed out waiting for PID file ${file}`);
		};

		// Case A: Inner CLI spawns non-detached grandchild in same PGID and exits 0 naturally
		const normalGrandPidFile = path.join(tmpDir, 'normal-grand.pid');
		const normalInnerCli = path.join(tmpDir, 'normal-cli.cjs');
		fs.writeFileSync(normalInnerCli, [
			`'use strict';`,
			`const cp = require('node:child_process');`,
			`const fs = require('node:fs');`,
			`cp.spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });`,
			`const timer = setInterval(() => {`,
			`  if (fs.existsSync(process.argv[3])) { clearInterval(timer); process.exit(0); }`,
			`}, 15);`,
		].join('\n'));

		let normalGrandPid = 0;
		try {
			const wrapperNormal = cp.spawn(
				process.execPath,
				[compiledLauncher, process.execPath, normalInnerCli, grandScript, normalGrandPidFile],
				{ detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
			);
			registerSpawnedEngineChildForTracking(wrapperNormal);
			const normalExitPromise = new Promise<number | null>(r => {
				if (wrapperNormal.exitCode !== null) {
					r(wrapperNormal.exitCode);
				} else {
					wrapperNormal.once('exit', code => r(code));
				}
			});
			normalGrandPid = await waitForPid(normalGrandPidFile);
			const exitCode = await normalExitPromise;
			await new Promise(r => setTimeout(r, 60));
			assert.strictEqual(exitCode, 0);
			assert.strictEqual(isAlive(normalGrandPid), true, 'Same-PGID grandchild must survive normal CLI turn exit');
		} finally {
			if (normalGrandPid > 0) {
				try { process.kill(normalGrandPid, 'SIGKILL'); } catch { }
			}
		}

		// Case B: Inner CLI spawns non-detached grandchild in same PGID and exits on SIGINT (killTree: false)
		const sigintGrandPidFile = path.join(tmpDir, 'sigint-grand.pid');
		const sigintInnerCli = path.join(tmpDir, 'sigint-cli.cjs');
		fs.writeFileSync(sigintInnerCli, [
			`'use strict';`,
			`const cp = require('node:child_process');`,
			`cp.spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });`,
			`process.on('SIGINT', () => process.exit(130));`,
			`setInterval(() => {}, 1000);`,
		].join('\n'));

		let sigintGrandPid = 0;
		try {
			const wrapperSigint = cp.spawn(
				process.execPath,
				[compiledLauncher, process.execPath, sigintInnerCli, grandScript, sigintGrandPidFile],
				{ detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
			);
			registerSpawnedEngineChildForTracking(wrapperSigint);
			sigintGrandPid = await waitForPid(sigintGrandPidFile);
			const sigintExitPromise = new Promise<void>(r => {
				if (wrapperSigint.exitCode !== null || wrapperSigint.signalCode !== null) {
					r();
				} else {
					wrapperSigint.once('exit', () => r());
				}
			});
			stopSpawnedEngineProcess(wrapperSigint, 'SIGINT', { killTree: false });
			await sigintExitPromise;
			await new Promise(r => setTimeout(r, 60));
			assert.strictEqual(isAlive(sigintGrandPid), true, 'Same-PGID grandchild must survive killTree: false interruption exit');
		} finally {
			if (sigintGrandPid > 0) {
				try { process.kill(sigintGrandPid, 'SIGKILL'); } catch { }
			}
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
