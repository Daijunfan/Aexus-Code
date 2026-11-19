/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { ADE_CLI_SCHEMA_VERSION, ADE_CLI_VERSION, computeDoctorExitCode, HELP_TEXT, parseCliCommand, runCli } from '../src/adeCli.ts';

const CWD = path.join(os.tmpdir(), 'aexus-ade-cli');

describe('parseCliCommand doctor', () => {
	test('doctor --json defaults the project path to the working directory', () => {
		assert.deepStrictEqual(parseCliCommand(['doctor', '--json'], CWD), {
			help: false,
			json: true,
			windowId: undefined,
			action: 'doctor',
			params: { projectPath: CWD },
		});
	});

	test('doctor resolves an explicit relative project path', () => {
		assert.deepStrictEqual(parseCliCommand(['doctor', '--project', './repo'], CWD).params, {
			projectPath: path.join(CWD, 'repo'),
		});
	});

	test('doctor parses --strict flag without altering default params when omitted', () => {
		assert.deepStrictEqual(parseCliCommand(['doctor', '--strict', '--json'], CWD), {
			help: false,
			json: true,
			windowId: undefined,
			action: 'doctor',
			params: { projectPath: CWD, strict: true },
		});
	});
});

describe('parseCliCommand engineering templates', () => {
	test('engineering template list filters by tree type', () => {
		assert.deepStrictEqual(parseCliCommand(['engineering', 'template', 'list', '--tree-type', 'research']), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'engineering.templates.list',
			params: { treeType: 'research' },
		});
	});

	test('engineering template apply forwards preset, engines, isolation, budget and force-stop', () => {
		assert.deepStrictEqual(parseCliCommand([
			'engineering', 'template', 'apply',
			'--governor', 'gov-1',
			'--template', 'feature-ship',
			'--preset', 'max-quality',
			'--engine', 'claude-code',
			'--secondary-engine', 'codex',
			'--isolation', 'worktree',
			'--max-budget-usd', '$8.5',
			'--force-stop-running',
		]), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'engineering.templates.apply',
			params: {
				governor: 'gov-1',
				template: 'feature-ship',
				preset: 'max-quality',
				engine: 'claude-code',
				secondaryEngine: 'codex',
				isolation: 'worktree',
				maxBudgetUsd: 8.5,
				forceStopRunning: true,
			},
		});
	});

	test('engineering template apply requires both governor and template', () => {
		assert.throws(
			() => parseCliCommand(['engineering', 'template', 'apply', '--governor', 'gov-1']),
			/Usage: aexus-ade engineering template apply/,
		);
	});
});

describe('parseCliCommand engineering report and worktrees', () => {
	test('engineering report resolves the output file against the working directory', () => {
		assert.deepStrictEqual(parseCliCommand(['engineering', 'report', '--governor', 'gov-1', '--out', './reports/run.md'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'engineering.report',
			params: { governor: 'gov-1', outFile: path.join(CWD, 'reports', 'run.md') },
		});
	});

	test('engineering worktrees merge and cleanup map to distinct actions', () => {
		assert.deepStrictEqual([
			parseCliCommand(['engineering', 'worktrees', 'merge', '--governor', 'gov-1']),
			parseCliCommand(['engineering', 'worktrees', 'cleanup', '--governor', 'gov-1']),
		], [
			{
				help: false,
				json: false,
				windowId: undefined,
				action: 'engineering.worktrees.merge',
				params: { governor: 'gov-1' },
			},
			{
				help: false,
				json: false,
				windowId: undefined,
				action: 'engineering.worktrees.cleanup',
				params: { governor: 'gov-1' },
			},
		]);
	});

	test('engineering worktrees rejects unknown operations and missing governors', () => {
		assert.throws(
			() => parseCliCommand(['engineering', 'worktrees', 'prune']),
			/Usage: aexus-ade engineering worktrees <merge\|cleanup>/,
		);
		assert.throws(
			() => parseCliCommand(['engineering', 'worktrees', 'merge']),
			/Usage: aexus-ade engineering worktrees merge --governor/,
		);
	});
});

describe('parseCliCommand engineering configure budget', () => {
	test('engineering configure --max-budget-usd rounds to cents and strips a dollar prefix', () => {
		assert.deepStrictEqual(parseCliCommand([
			'engineering', 'configure',
			'--governor', 'gov-1',
			'--max-budget-usd', '$5.004',
		]).params, {
			governor: 'gov-1',
			maxBudgetUsd: 5,
		});
	});

	test('engineering configure --max-budget-usd 0 clears the cap', () => {
		assert.deepStrictEqual(parseCliCommand([
			'engineering', 'configure',
			'--governor', 'gov-1',
			'--max-budget-usd', '0',
		]).params, {
			governor: 'gov-1',
			clearBudget: true,
		});
	});

	test('engineering configure rejects negative budgets', () => {
		assert.throws(
			() => parseCliCommand(['engineering', 'configure', '--governor', 'gov-1', '--max-budget-usd', '-1']),
			/Option --max-budget-usd requires a non-negative number\./,
		);
	});
});

describe('runCli version', () => {
	test('prints a human-readable version without a running workbench', async () => {
		const outputs: string[] = [];
		const io = {
			stdout: (text: string) => { outputs.push(text); },
			stderr: (text: string) => { outputs.push(text); },
			env: {},
		};
		const exitCodes = [
			await runCli(['--version'], io),
			await runCli(['-v'], io),
			await runCli(['version'], io),
		];
		assert.deepStrictEqual({ exitCodes, outputs }, {
			exitCodes: [0, 0, 0],
			outputs: Array.from({ length: 3 }, () => `aexus-ade ${ADE_CLI_VERSION} (Aexus Code / Code - OSS 1.146.0)\n`),
		});
		assert.strictEqual(ADE_CLI_VERSION, '1.1.0');
	});

	test('prints structured JSON with schemaVersion when --json is passed', async () => {
		let stdout = '';
		const exitCode = await runCli(['--version', '--json'], {
			stdout: text => { stdout += text; },
			stderr: text => { stdout += text; },
			env: {},
		});
		assert.deepStrictEqual({ exitCode, version: JSON.parse(stdout) }, {
			exitCode: 0,
			version: { schemaVersion: ADE_CLI_SCHEMA_VERSION, cli: 'aexus-ade', version: '1.1.0', engineBaseline: '1.146.0' },
		});
	});
});

describe('runCli completion & HELP_TEXT', () => {
	test('emits completion scripts for bash, zsh, fish, and powershell covering role, generate, demo, and verify-trust', async () => {
		const scripts = await Promise.all((['bash', 'zsh', 'fish', 'powershell'] as const).map(async shell => {
			let stdout = '';
			const exitCode = await runCli(['completion', shell], {
				stdout: text => { stdout += text; },
				stderr: text => { stdout += text; },
				env: {},
			});
			return { shell, exitCode, stdout };
		}));
		for (const { shell, exitCode, stdout } of scripts) {
			assert.strictEqual(exitCode, 0, shell);
			assert.match(stdout, /aexus-ade/, shell);
			for (const token of [
				'doctor', 'completion', 'status', 'mode', 'view', 'role', 'project', 'host',
				'engine', 'session', 'secretary', 'engineering', 'inbox',
				'apply-preset', 'set-tier', 'presets', 'reset',
				'demo', 'generate', 'verify-trust', 'revoke', 'watchdog-action',
			]) {
				assert.ok(stdout.includes(token), `${shell} completion is missing ${token}`);
			}
		}
		assert.match(scripts.find(script => script.shell === 'bash')!.stdout, /complete -F _aexus_ade aexus-ade/);
		assert.match(scripts.find(script => script.shell === 'zsh')!.stdout, /^#compdef aexus-ade/m);
		assert.match(scripts.find(script => script.shell === 'fish')!.stdout, /^# fish completion for aexus-ade/m);
		assert.match(scripts.find(script => script.shell === 'powershell')!.stdout, /Register-ArgumentCompleter -Native -CommandName aexus-ade/);

		// `pwsh` alias resolves to PowerShell completion script.
		let pwshOut = '';
		const pwshCode = await runCli(['completion', 'pwsh'], { stdout: t => { pwshOut += t; }, stderr: () => { }, env: {} });
		assert.strictEqual(pwshCode, 0);
		assert.strictEqual(pwshOut, scripts.find(script => script.shell === 'powershell')!.stdout);
	});

	test('HELP_TEXT documents engineering generate, verify-trust, role subcommands, and powershell completions', () => {
		assert.ok(HELP_TEXT.includes('completion <bash|zsh|fish|powershell>'));
		assert.ok(HELP_TEXT.includes('engineering generate '));
		assert.ok(HELP_TEXT.includes('engineering verify-trust list'));
		assert.ok(HELP_TEXT.includes('engineering verify-trust revoke'));
		assert.ok(HELP_TEXT.includes('role apply-preset'));
		assert.ok(HELP_TEXT.includes('role set-tier'));
	});

	test('rejects an unknown or missing shell', async () => {
		const errors: string[] = [];
		const io = { stdout: (text: string) => { errors.push(text); }, stderr: (text: string) => { errors.push(text); }, env: {} };
		const exitCodes = [
			await runCli(['completion'], io),
			await runCli(['completion', 'tcsh'], io),
		];
		assert.deepStrictEqual({ exitCodes, errors }, {
			exitCodes: [1, 1],
			errors: [
				'Error: Usage: aexus-ade completion <bash|zsh|fish|powershell>\n',
				'Error: Usage: aexus-ade completion <bash|zsh|fish|powershell>\n',
			],
		});
	});
});

describe('parseCliCommand engineering verify-trust', () => {
	test('routes verify-trust list and revoke with hash, --all, and --project', () => {
		assert.deepStrictEqual([
			parseCliCommand(['engineering', 'verify-trust', 'list'], CWD),
			parseCliCommand(['engineering', 'verify-trust', 'list', '--project', './repo'], CWD),
			parseCliCommand(['engineering', 'verify-trust', 'revoke', 'sha256-abc'], CWD),
			parseCliCommand(['engineering', 'verify-trust', 'revoke', '--all', '--project', './repo'], CWD),
		], [
			{ help: false, json: false, windowId: undefined, action: 'engineering.verifyTrust.list', params: {} },
			{ help: false, json: false, windowId: undefined, action: 'engineering.verifyTrust.list', params: { project: path.join(CWD, 'repo') } },
			{ help: false, json: false, windowId: undefined, action: 'engineering.verifyTrust.revoke', params: { hash: 'sha256-abc' } },
			{ help: false, json: false, windowId: undefined, action: 'engineering.verifyTrust.revoke', params: { all: true, project: path.join(CWD, 'repo') } },
		]);
		assert.throws(
			() => parseCliCommand(['engineering', 'verify-trust', 'revoke'], CWD),
			/Usage: aexus-ade engineering verify-trust revoke/,
		);
	});
});

describe('parseCliCommand engineering demo', () => {
	test('routes to engineering.demo with an optional governor', () => {
		assert.deepStrictEqual([
			parseCliCommand(['engineering', 'demo']),
			parseCliCommand(['engineering', 'demo', '--governor', 'gov-1']),
		], [
			{ help: false, json: false, windowId: undefined, action: 'engineering.demo', params: {} },
			{ help: false, json: false, windowId: undefined, action: 'engineering.demo', params: { governor: 'gov-1' } },
		]);
	});
});

describe('parseCliCommand role customization & custom rank slugs', () => {
	test('routes role subcommands and accepts custom rank IDs on session create/role/list', () => {
		assert.deepStrictEqual([
			parseCliCommand(['role', 'list', '--json']),
			parseCliCommand(['role', 'apis', '--json']),
			parseCliCommand(['role', 'presets']),
			parseCliCommand(['role', 'preset', 'startup-3tier']),
			parseCliCommand(['role', 'apply-preset', 'startup-3tier']),
			parseCliCommand(['role', 'set-tier', 's-1', 'tech-lead']),
			parseCliCommand(['role', 'reset']),
			parseCliCommand(['role', 'studio', 'qa-auditor']),
			parseCliCommand(['session', 'create', '--role', 'qa-auditor', '--title', 'Audit Lead', '--no-open']),
			parseCliCommand(['session', 'role', 's-1', 'tech-lead']),
		], [
			{ help: false, json: true, windowId: undefined, action: 'role.schema.get', params: {} },
			{ help: false, json: true, windowId: undefined, action: 'role.apis', params: {} },
			{ help: false, json: false, windowId: undefined, action: 'role.presets', params: {} },
			{ help: false, json: false, windowId: undefined, action: 'role.schema.set', params: { presetId: 'startup-3tier' } },
			{ help: false, json: false, windowId: undefined, action: 'role.schema.set', params: { presetId: 'startup-3tier' } },
			{ help: false, json: false, windowId: undefined, action: 'session.setRole', params: { id: 's-1', role: 'tech-lead' } },
			{ help: false, json: false, windowId: undefined, action: 'role.schema.reset', params: {} },
			{ help: false, json: false, windowId: undefined, action: 'role.studio.open', params: { rankId: 'qa-auditor' } },
			{ help: false, json: false, windowId: undefined, action: 'session.create', params: { open: false, noOpen: true, title: 'Audit Lead', role: 'qa-auditor' } },
			{ help: false, json: false, windowId: undefined, action: 'session.setRole', params: { id: 's-1', role: 'tech-lead' } },
		]);
	});
});

describe('runCli doctor color output', () => {
	const runDoctor = async (env: NodeJS.ProcessEnv, stdoutIsTTY: boolean) => {
		let stdout = '';
		let stderr = '';
		const exitCode = await runCli(['doctor', '--project', CWD], {
			stdout: text => { stdout += text; },
			stderr: text => { stderr += text; },
			env: { PATH: path.join(CWD, 'no-tools'), AEXUS_ADE_SOCKET: path.join(CWD, 'no-workbench.sock'), AEXUS_ADE_TOKEN: '', ...env },
			cwd: CWD,
			stdoutIsTTY,
		});
		return { exitCode, stderr, stdout };
	};

	test('NO_COLOR disables ANSI even when stdout is a TTY', async () => {
		const { exitCode, stderr, stdout } = await runDoctor({ NO_COLOR: '1' }, true);
		assert.deepStrictEqual({ exitCode, stderr, hasAnsi: stdout.includes('\u001b[') }, { exitCode: 1, stderr: '', hasAnsi: false });
	});

	test('FORCE_COLOR enables ANSI even when stdout is not a TTY', async () => {
		const { stdout } = await runDoctor({ FORCE_COLOR: '1' }, false);
		assert.ok(stdout.includes('\u001b['));
	});
});

describe('runCli doctor --json', () => {
	test('emits a structured environment report and exits 1 when control plane is offline and no engines are installed', async () => {
		let stdout = '';
		let stderr = '';
		const exitCode = await runCli(['doctor', '--json', '--project', CWD], {
			stdout: text => { stdout += text; },
			stderr: text => { stderr += text; },
			env: {
				PATH: path.join(CWD, 'no-tools'),
				AEXUS_ADE_SOCKET: path.join(CWD, 'no-workbench.sock'),
				AEXUS_ADE_TOKEN: '',
			},
			cwd: CWD,
		});
		assert.deepStrictEqual({ exitCode, stderr }, { exitCode: 1, stderr: '' });
		const report = JSON.parse(stdout) as {
			readonly schemaVersion: number;
			readonly aexusVersion: string;
			readonly platform: string;
			readonly arch: string;
			readonly projectPath: string;
			readonly controlPlane: { readonly connected: boolean };
			readonly projectRules: readonly string[];
			readonly engines: readonly { readonly id: string }[];
			readonly checks: readonly { readonly id: string; readonly status: string }[];
			readonly summary: { readonly enginesReady: number; readonly enginesTotal: number };
		};
		assert.deepStrictEqual({
			schemaVersion: report.schemaVersion,
			aexusVersion: report.aexusVersion,
			platform: report.platform,
			arch: report.arch,
			projectPath: report.projectPath,
			controlPlaneConnected: report.controlPlane.connected,
			projectRules: report.projectRules,
			engineIds: report.engines.map(engine => engine.id),
			checkStatuses: Object.fromEntries(report.checks.map(check => [check.id, check.status])),
			summary: report.summary,
		}, {
			schemaVersion: 1,
			aexusVersion: '1.1.0',
			platform: process.platform,
			arch: process.arch,
			projectPath: CWD,
			controlPlaneConnected: false,
			projectRules: [],
			engineIds: ['claude-code', 'codex', 'antigravity', 'opencode', 'kilo', 'dsh', 'cline', 'pi'],
			checkStatuses: {
				'control-plane': 'fail',
				engines: 'fail',
				git: 'warn',
				ssh: 'warn',
			},
			summary: { enginesReady: 0, enginesTotal: 8 },
		});
	});

	test('emits schemaVersion: 1 on status --json and supports --json uniformly across role list and role presets', async t => {
		if (process.platform === 'win32') {
			t.skip('Unix domain socket test');
			return;
		}
		const tmpDir = await fs.mkdtemp(path.join('/tmp', 'ade-json-'));
		const sockPath = path.join(tmpDir, 'ade.sock');
		const srv = net.createServer(sock => {
			let buf = '';
			sock.setEncoding('utf8');
			sock.on('data', chunk => {
				buf += chunk;
				const idx = buf.indexOf('\n');
				if (idx >= 0) {
					const req = JSON.parse(buf.slice(0, idx)) as { action?: string };
					if (req.action === 'status') {
						sock.end(JSON.stringify({ ok: true, result: { mode: 'ade', counts: { projects: 1 } } }) + '\n');
					} else if (req.action === 'role.schema.get') {
						sock.end(JSON.stringify({ ok: true, result: { ranks: [{ id: 'governor', name: 'Governor', tier: 1, apis: ['session.manage'] }] } }) + '\n');
					} else if (req.action === 'role.presets') {
						sock.end(JSON.stringify({ ok: true, result: [{ id: 'default-4tier', name: '4-Tier Org', description: 'Standard hierarchy' }] }) + '\n');
					} else {
						sock.end(JSON.stringify({ ok: true, result: {} }) + '\n');
					}
				}
			});
		});
		await new Promise<void>(resolve => srv.listen(sockPath, resolve));
		try {
			const env: NodeJS.ProcessEnv = { AEXUS_ADE_SOCKET: sockPath, AEXUS_ADE_TOKEN: 'tok' };
			const invoke = async (argv: string[]) => {
				let stdout = '';
				let stderr = '';
				const code = await runCli(argv, { stdout: s => { stdout += s; }, stderr: s => { stderr += s; }, env, cwd: tmpDir });
				return { code, stdout, stderr };
			};
			const statusRes = await invoke(['status', '--json']);
			assert.strictEqual(statusRes.code, 0, statusRes.stderr);
			assert.deepStrictEqual(JSON.parse(statusRes.stdout), { schemaVersion: 1, mode: 'ade', counts: { projects: 1 } });

			const roleListJson = await invoke(['role', 'list', '--json']);
			assert.strictEqual(roleListJson.code, 0, roleListJson.stderr);
			assert.deepStrictEqual(JSON.parse(roleListJson.stdout), { ranks: [{ id: 'governor', name: 'Governor', tier: 1, apis: ['session.manage'] }] });

			const roleListHuman = await invoke(['role', 'list']);
			assert.strictEqual(roleListHuman.code, 0, roleListHuman.stderr);
			assert.match(roleListHuman.stdout, /Organization Role Schema:/);
			assert.match(roleListHuman.stdout, /governor \(L1\): Governor/);

			const rolePresetsJson = await invoke(['role', 'presets', '--json']);
			assert.strictEqual(rolePresetsJson.code, 0, rolePresetsJson.stderr);
			assert.deepStrictEqual(JSON.parse(rolePresetsJson.stdout), [{ id: 'default-4tier', name: '4-Tier Org', description: 'Standard hierarchy' }]);

			const rolePresetsHuman = await invoke(['role', 'presets']);
			assert.strictEqual(rolePresetsHuman.code, 0, rolePresetsHuman.stderr);
			assert.match(rolePresetsHuman.stdout, /Available Organization Presets:/);
			assert.match(rolePresetsHuman.stdout, /default-4tier: 4-Tier Org/);
		} finally {
			await new Promise<void>(resolve => srv.close(() => resolve()));
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

describe('computeDoctorExitCode & runCli doctor --strict exit codes', () => {
	test('returns 1 on fail/error, 2 on warn with --strict, and 0 otherwise', () => {
		assert.strictEqual(computeDoctorExitCode({ checks: [{ id: 'a', label: 'A', status: 'ok', detail: '' }] }, false), 0);
		assert.strictEqual(computeDoctorExitCode({ checks: [{ id: 'a', label: 'A', status: 'ok', detail: '' }] }, true), 0);
		assert.strictEqual(computeDoctorExitCode({ checks: [{ id: 'a', label: 'A', status: 'warn', detail: '' }] }, false), 0);
		assert.strictEqual(computeDoctorExitCode({ checks: [{ id: 'a', label: 'A', status: 'warn', detail: '' }] }, true), 2);
		assert.strictEqual(computeDoctorExitCode({ checks: [{ id: 'a', label: 'A', status: 'fail', detail: '' }, { id: 'b', label: 'B', status: 'warn', detail: '' }] }, true), 1);
		assert.strictEqual(computeDoctorExitCode({ checks: [{ id: 'a', label: 'A', status: 'error', detail: '' }] }, false), 1);
	});

	test('exits 0 on warnings without --strict, 2 with --strict, and 0 with --strict when all checks are healthy', async t => {
		if (process.platform === 'win32') {
			t.skip('Unix domain socket + POSIX sh stub test');
			return;
		}
		const tmpDir = await fs.mkdtemp(path.join('/tmp', 'ade-doc-'));
		const binDir = path.join(tmpDir, 'bin');
		await fs.mkdir(binDir, { recursive: true });
		const makeStub = async (name: string, output: string) => {
			const file = path.join(binDir, name);
			await fs.writeFile(file, `#!/bin/sh\necho "${output}"\n`, { mode: 0o755 });
		};
		// Provide claude engine + git, intentionally omitting ssh to trigger a warn check.
		await makeStub('claude', 'claude 1.0.0');
		await makeStub('git', 'git version 2.45.0');
		// Include /usr/bin so `which` is available, wait: /usr/bin has ssh on macOS!
		// Provide a minimal stub `which` in binDir so PATH contains ONLY binDir!
		await fs.writeFile(path.join(binDir, 'which'), `#!/bin/sh\nif [ -x "${binDir}/$1" ]; then echo "${binDir}/$1"; exit 0; fi\nexit 1\n`, { mode: 0o755 });

		const sockPath = path.join(tmpDir, 'ade.sock');
		const srv = net.createServer(sock => {
			let buf = '';
			sock.setEncoding('utf8');
			sock.on('data', chunk => {
				buf += chunk;
				if (buf.includes('\n')) {
					sock.end(JSON.stringify({ ok: true, result: { mode: 'ade' } }) + '\n');
				}
			});
		});
		await new Promise<void>(resolve => srv.listen(sockPath, resolve));
		try {
			const env: NodeJS.ProcessEnv = {
				PATH: binDir,
				AEXUS_ADE_SOCKET: sockPath,
				AEXUS_ADE_TOKEN: 'test-token',
			};
			let out1 = '';
			const codeWarnDefault = await runCli(['doctor', '--json', '--project', tmpDir], {
				stdout: s => { out1 += s; },
				stderr: () => { },
				env,
				cwd: tmpDir,
			});
			assert.strictEqual(codeWarnDefault, 0, out1);

			let out2 = '';
			const codeWarnStrict = await runCli(['doctor', '--strict', '--json', '--project', tmpDir], {
				stdout: s => { out2 += s; },
				stderr: () => { },
				env,
				cwd: tmpDir,
			});
			assert.strictEqual(codeWarnStrict, 2, out2);

			// Add ssh stub so all checks pass with status === 'ok'.
			await makeStub('ssh', 'OpenSSH_9.7p1');
			let out3 = '';
			const codeAllOkStrict = await runCli(['doctor', '--strict', '--json', '--project', tmpDir], {
				stdout: s => { out3 += s; },
				stderr: () => { },
				env,
				cwd: tmpDir,
			});
			assert.strictEqual(codeAllOkStrict, 0, out3);
		} finally {
			await new Promise<void>(resolve => srv.close(() => resolve()));
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

describe('runCli AEXUS_ADE_SESSION_TOKEN capability auth', () => {
	test('uses AEXUS_ADE_SESSION_TOKEN + AEXUS_ADE_SOCKET without reading master control file and strips caller spoofing', async t => {
		if (process.platform === 'win32') {
			t.skip('Unix domain socket test');
			return;
		}
		const tmpDir = await fs.mkdtemp(path.join('/tmp', 'ade-cap-'));
		const sockPath = path.join(tmpDir, 'ade.sock');
		const received: Array<{ token?: string; action?: string; params?: Record<string, unknown> }> = [];
		const srv = net.createServer(sock => {
			let buf = '';
			sock.setEncoding('utf8');
			sock.on('data', chunk => {
				buf += chunk;
				const idx = buf.indexOf('\n');
				if (idx >= 0) {
					received.push(JSON.parse(buf.slice(0, idx)) as { token?: string; action?: string; params?: Record<string, unknown> });
					sock.end(JSON.stringify({ ok: true, result: { status: 'ok' } }) + '\n');
				}
			});
		});
		await new Promise<void>(resolve => srv.listen(sockPath, resolve));
		try {
			const capToken = 'aexus-cap.eyJzaWQiOiJzLTEiLCJyYW5rIjoiZW1wbG95ZWUiLCJpYXQiOjF9.deadbeef';
			let stdout = '';
			let stderr = '';
			const code = await runCli(['--json', 'engineering', 'run', '--governor', 'gov-1'], {
				stdout: s => { stdout += s; },
				stderr: s => { stderr += s; },
				env: {
					AEXUS_ADE_HOME: path.join(tmpDir, 'does-not-exist'),
					AEXUS_ADE_CONTROL_FILE: path.join(tmpDir, 'does-not-exist', 'ade-control.json'),
					AEXUS_ADE_TOKEN: 'master-token-must-be-ignored',
					AEXUS_ADE_SOCKET: sockPath,
					AEXUS_ADE_SESSION_TOKEN: capToken,
					AEXUS_ADE_CALLER: 'secretary',
				},
				cwd: tmpDir,
			});
			assert.strictEqual(code, 0, stderr || stdout);
			assert.deepStrictEqual(received, [
				{
					token: capToken,
					action: 'engineering.run',
					params: { governor: 'gov-1' },
				},
			]);
		} finally {
			await new Promise<void>(resolve => srv.close(() => resolve()));
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});
