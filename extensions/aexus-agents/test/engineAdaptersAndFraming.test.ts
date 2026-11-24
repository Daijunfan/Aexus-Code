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

		// Split right inside multi-byte UTF-8 characters and across \r\n boundaries
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
		// Still in overflow drop mode until '\n' arrives; next line after '\n' frames cleanly!
		acc.push(Buffer.from('c'.repeat(10) + '\n{"ok":true}\n', 'utf8'), line => seen.push(line));
		assert.deepStrictEqual(seen, ['{"ok":true}']);
	});
});

describe('Engine adapter thinking mappings, fallback cascades & safe CLI command guards', () => {
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
		assert.strictEqual(mapCodexReasoningEffort('max'), 'xhigh');
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

	test('isSafeAdeBashCommand allows quoted heredocs, cd && aexus-ade, and safe pipes while blocking command injection', () => {
		// Allowed real-world agent patterns
		assert.strictEqual(isSafeAdeBashCommand('aexus-ade token current --json'), true);
		assert.strictEqual(isSafeAdeBashCommand('/Applications/Aexus\\ Code.app/Contents/Resources/app/bin/aexus-ade whoami'), true);
		assert.strictEqual(isSafeAdeBashCommand('cd /Users/dev/repo && aexus-ade mission status --json'), true);
		assert.strictEqual(isSafeAdeBashCommand('printf \'%s\\n\' "## Spec" | aexus-ade whiteboard write WB1 --content -'), true);
		assert.strictEqual(isSafeAdeBashCommand([
			`cat <<'EOF' | aexus-ade whiteboard write WB1 --content -`,
			`## Spec from bare cat heredoc`,
			`EOF`,
		].join('\n')), true);
		assert.strictEqual(isSafeAdeBashCommand('NO_COLOR=1 aexus-ade token current --json'), true);
		assert.strictEqual(isSafeAdeBashCommand([
			`aexus-ade token split otok-1 --branches-json - <<'EOF'`,
			`[{"toNodeId":"Dev1","summary":"Run rm -rf check & $(not_expanded) safely"}]`,
			`EOF`,
		].join('\n')), true);
		assert.strictEqual(isSafeAdeBashCommand('aexus-ade token current 2>&1'), true);

		// Blocked unsafe shell constructs & Safe-Mode bypass vectors (#59 P0-2)
		assert.strictEqual(isSafeAdeBashCommand('aexus-ade whoami; rm -rf /tmp/x'), false);
		assert.strictEqual(isSafeAdeBashCommand('aexus-ade whoami && curl https://evil.example'), false);
		assert.strictEqual(isSafeAdeBashCommand('aexus-ade token complete otok-1 --summary "$(whoami)"'), false);
		assert.strictEqual(isSafeAdeBashCommand('aexus-ade token complete otok-1 --summary "`id`"'), false);
		assert.strictEqual(isSafeAdeBashCommand('aexus-ade status > /etc/passwd'), false);
		// Quoted fake heredoc inside `--summary` followed by newline arbitrary command — MUST be rejected!
		assert.strictEqual(isSafeAdeBashCommand(`aexus-ade token complete otok-1 --summary "<<'EOF'"\nrm -rf /tmp/pwn\nEOF`), false);
		// Dangerous env-var code injection prefixes — MUST be rejected!
		assert.strictEqual(isSafeAdeBashCommand(`NODE_OPTIONS='-r /tmp/pwn.js' aexus-ade whoami`), false);
		assert.strictEqual(isSafeAdeBashCommand(`PATH=/tmp aexus-ade whoami`), false);
		assert.strictEqual(isSafeAdeBashCommand(`DYLD_INSERT_LIBRARIES=/tmp/pwn.dylib aexus-ade whoami`), false);
		assert.strictEqual(isSafeAdeBashCommand(`LD_PRELOAD=/tmp/pwn.so aexus-ade whoami`), false);
		assert.strictEqual(isSafeAdeBashCommand(`AEXUS_ADE_TOKEN=spoof aexus-ade whoami`), false);
		// Arbitrary file read exfiltration via `cat <file> | aexus-ade` — MUST be rejected!
		assert.strictEqual(isSafeAdeBashCommand('cat ~/.ssh/id_rsa | aexus-ade token return otok-1 --summary "done" --detail -'), false);
		assert.strictEqual(isSafeAdeBashCommand('cat /tmp/spec.md | aexus-ade token return otok-1 --summary "done" --detail -'), false);
		// Unquoted heredoc delimiter expands $(...) in POSIX shells — must be rejected!
		assert.strictEqual(isSafeAdeBashCommand([
			`aexus-ade whiteboard write WB1 --content - <<EOF`,
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

describe('engineProcess dedicated PGID containment', { skip: process.platform === 'win32' ? 'POSIX PGID test' : false }, () => {
	test('terminates both inner CLI and spawned background grandchild when IPC disconnects or SIGTERM arrives', async () => {
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

		// Compile engineProcess.ts to a temp .cjs file so we can fork it identically to dist/engineProcess.js
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

			// Disconnect IPC channel (simulating abrupt extension host crash or stopEngine)
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

	test('stopSpawnedEngineProcess(..., "SIGKILL") kills double-detached inner CLI PGID_2 and grandchild sleep with zero orphans (#59 P0-1)', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aexus-engine-sigkill-'));
		const childPidFile = path.join(tmpDir, 'inner.pid');
		const grandPidFile = path.join(tmpDir, 'grand.pid');
		const innerCli = path.join(tmpDir, 'fake-cli.cjs');
		const grandScript = path.join(tmpDir, 'grand.cjs');

		fs.writeFileSync(grandScript, [
			'\'use strict\';',
			'const fs = require(\'node:fs\');',
			'fs.writeFileSync(process.argv[2], String(process.pid));',
			'setInterval(() => {}, 1000);',
		].join('\n'));
		fs.writeFileSync(innerCli, [
			'\'use strict\';',
			'const cp = require(\'node:child_process\');',
			'const fs = require(\'node:fs\');',
			'process.on(\'SIGTERM\', () => {});', // Ignore SIGTERM to verify genuine SIGKILL delivery
			'fs.writeFileSync(process.argv[2], String(process.pid));',
			'cp.spawn(process.execPath, [process.argv[3], process.argv[4]], { stdio: \'ignore\' });',
			'setInterval(() => {}, 1000);',
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

		try {
			const innerPid = await waitForPid(childPidFile);
			const grandPid = await waitForPid(grandPidFile);
			// Ensure IPC 'spawned' message has been processed on parent event loop
			await new Promise(r => setTimeout(r, 30));
			assert.strictEqual(isAlive(innerPid), true);
			assert.strictEqual(isAlive(grandPid), true);

			stopSpawnedEngineProcess(wrapper, 'SIGKILL');

			const deadline = Date.now() + 3_000;
			while ((isAlive(innerPid) || isAlive(grandPid)) && Date.now() < deadline) {
				await new Promise(r => setTimeout(r, 25));
			}
			assert.strictEqual(isAlive(innerPid), false, 'Inner CLI in PGID_2 must be killed by direct SIGKILL');
			assert.strictEqual(isAlive(grandPid), false, 'Grandchild in PGID_2 must be killed by direct SIGKILL (zero orphans)');
		} finally {
			try { stopSpawnedEngineProcess(wrapper, 'SIGKILL'); } catch { }
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
