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

describe('parseCliCommand mission lifecycle, blueprints & pre-prompts', () => {
	test('parses mission init, list, open, blueprint get/apply/validate, prompt CRUD, and remove', () => {
		assert.deepStrictEqual(parseCliCommand(['mission', 'init', '--governor', 'gov-1', '--title', 'Release Pipeline', '--open']), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.init',
			params: { owner: 'gov-1', title: 'Release Pipeline', open: true },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'list', '--project', './repo'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.list',
			params: { project: path.join(CWD, 'repo') },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'open', '--mission', 'm-1']), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.open',
			params: { missionId: 'm-1' },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'blueprint', 'get', '--mission', 'm-1', '--raw']), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.blueprint.get',
			params: { missionId: 'm-1', raw: true },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'blueprint', 'validate', '--text', 'flowchart LR\n  A --> B']), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.blueprint.validate',
			params: { text: 'flowchart LR\n  A --> B' },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'prompt', 'list', '--mission', 'm-1']), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.prompt.list',
			params: { missionId: 'm-1' },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'prompt', 'get', '--mission', 'm-1', '--node', 'N1']), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.prompt.get',
			params: { missionId: 'm-1', nodeId: 'N1' },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'prompt', 'set', '--mission', 'm-1', '--node', 'N1', '--text', 'Check edge cases']), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.prompt.set',
			params: { missionId: 'm-1', nodeId: 'N1', prompt: 'Check edge cases' },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'prompt', 'clear', '--mission', 'm-1', '--node', 'N1']), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.prompt.set',
			params: { missionId: 'm-1', nodeId: 'N1', clear: true },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'remove', '--mission', 'm-1']), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.remove',
			params: { missionId: 'm-1' },
		});
	});

	test('rejects removed legacy engineering group and dead engineering subcommands', () => {
		for (const deadArgv of [
			['engineering', 'demo'],
			['engineering', 'list'],
			['mission', 'demo'],
			['mission', 'generate', '--prompt', 'ship feature'],
			['mission', 'template', 'list'],
			['mission', 'template', 'apply', '--governor', 'gov-1', '--template', 'feature-ship'],
			['mission', 'worktrees', 'merge', '--governor', 'gov-1'],
			['mission', 'verify-trust', 'list'],
			['mission', 'review', '--governor', 'gov-1', '--node', 'N1'],
			['mission', 'diff', '--governor', 'gov-1'],
			['mission', 'report', '--governor', 'gov-1'],
			['mission', 'reports', '--governor', 'gov-1'],
			['mission', 'reset', '--governor', 'gov-1'],
			['mission', 'configure', '--governor', 'gov-1'],
			['mission', 'watchdog-action', '--governor', 'gov-1'],
		]) {
			assert.throws(() => parseCliCommand(deadArgv, CWD), /Unknown|Usage:/, `Expected dead command to fail: ${deadArgv.join(' ')}`);
		}
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
	test('emits completion scripts for bash, zsh, fish, and powershell covering role, rank, mission, token, and org', async () => {
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
				'doctor', 'completion', 'status', 'mode', 'view', 'role', 'rank', 'project', 'host',
				'engine', 'session', 'secretary', 'mission', 'token', 'org', 'inbox',
				'apply-preset', 'set-tier', 'presets', 'reset',
				'blueprint', 'prompt', 'boundary', 'recall', 'patch', 'trigger',
			]) {
				assert.ok(stdout.includes(token), `${shell} completion is missing ${token}`);
			}
			assert.ok(!stdout.includes('verify-trust'), `${shell} completion must not contain removed verify-trust`);
			assert.ok(!stdout.includes('watchdog-action'), `${shell} completion must not contain removed watchdog-action`);
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

	test('HELP_TEXT documents mission, token, org, role subcommands, and powershell completions without dead engineering commands', () => {
		assert.ok(HELP_TEXT.includes('completion <bash|zsh|fish|powershell>'));
		assert.ok(HELP_TEXT.includes('mission blueprint apply'));
		assert.ok(HELP_TEXT.includes('mission prompt set'));
		assert.ok(HELP_TEXT.includes('token complete'));
		assert.ok(HELP_TEXT.includes('role apply-preset'));
		assert.ok(HELP_TEXT.includes('role set-tier'));
		assert.ok(!HELP_TEXT.includes('engineering demo'));
		assert.ok(!HELP_TEXT.includes('verify-trust'));
		assert.ok(!HELP_TEXT.includes('worktrees merge'));
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
			const code = await runCli(['--json', 'mission', 'run', '--governor', 'gov-1'], {
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
					action: 'mission.run',
					params: { missionId: 'gov-1' },
				},
			]);
		} finally {
			await new Promise<void>(resolve => srv.close(() => resolve()));
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test('supports --window-id alias and AEXUS_ADE_WINDOW_ID env fallback with explicit flag precedence', async t => {
		assert.strictEqual(parseCliCommand(['--window-id', '9', 'status'], CWD).windowId, 9);
		assert.strictEqual(parseCliCommand(['--window-id=12', 'token', 'current'], CWD).windowId, 12);

		if (process.platform === 'win32') {
			t.skip('Unix domain socket test');
			return;
		}
		const tmpDir = await fs.mkdtemp(path.join('/tmp', 'ade-wid-'));
		const sockPath = path.join(tmpDir, 'ade.sock');
		const received: Array<{ windowId?: number; action?: string }> = [];
		const srv = net.createServer(sock => {
			let buf = '';
			sock.setEncoding('utf8');
			sock.on('data', chunk => {
				buf += chunk;
				const idx = buf.indexOf('\n');
				if (idx >= 0) {
					received.push(JSON.parse(buf.slice(0, idx)) as { windowId?: number; action?: string });
					sock.end(JSON.stringify({ ok: true, result: { ok: true } }) + '\n');
				}
			});
		});
		await new Promise<void>(resolve => srv.listen(sockPath, resolve));
		try {
			const baseEnv = {
				AEXUS_ADE_SOCKET: sockPath,
				AEXUS_ADE_TOKEN: 'test-master-token',
				AEXUS_ADE_WINDOW_ID: '17',
			};
			const code1 = await runCli(['--json', 'whoami'], { stdout: () => undefined, stderr: () => undefined, env: baseEnv, cwd: tmpDir });
			const code2 = await runCli(['--json', '--window-id', '5', 'whoami'], { stdout: () => undefined, stderr: () => undefined, env: baseEnv, cwd: tmpDir });
			assert.strictEqual(code1, 0);
			assert.strictEqual(code2, 0);
			assert.deepStrictEqual(received.map(r => r.windowId), [17, 5]);
		} finally {
			await new Promise<void>(resolve => srv.close(() => resolve()));
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

describe('Mission Runtime CLI commands & AEXUS_ADE_TCP_PORT transport', () => {
	test('parses whoami, docs read, and api update --since/--scope', () => {
		assert.deepStrictEqual(parseCliCommand(['whoami', '--json'], CWD), {
			help: false,
			json: true,
			windowId: undefined,
			action: 'whoami',
			params: {},
		});
		for (const target of ['L2', 'common', 'mission']) {
			assert.deepStrictEqual(parseCliCommand(['docs', 'read', target], CWD), {
				help: false,
				json: false,
				windowId: undefined,
				action: 'docs.read',
				params: { target },
			});
		}
		assert.deepStrictEqual(parseCliCommand(['api', 'update', '--since', '1', '--scope', 'mission', '--json'], CWD), {
			help: false,
			json: true,
			windowId: undefined,
			action: 'api.update',
			params: { since: 1, scope: 'mission' },
		});
	});

	test('parses token bus current, trace, complete, reject, block, and fail', () => {
		assert.deepStrictEqual(parseCliCommand(['token', 'current', '--mission', 'm1'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'token.current',
			params: { missionId: 'm1' },
		});
		assert.deepStrictEqual(parseCliCommand(['token', 'trace', 'tr-1', '--mission', 'm1', '--limit', '10'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'token.trace',
			params: { missionId: 'm1', limit: 10, tracePtr: 'tr-1' },
		});
		assert.deepStrictEqual(parseCliCommand(['token', 'complete', 'tok-1', '--summary', 'shipped fix'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'token.complete',
			params: { tokenId: 'tok-1', summary: 'shipped fix' },
		});
		assert.deepStrictEqual(parseCliCommand(['token', 'reject', 'tok-1', '--reason', 'missing test', '--to', 'N1'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'token.reject',
			params: { tokenId: 'tok-1', reason: 'missing test', targetNodeId: 'N1' },
		});
		assert.deepStrictEqual(parseCliCommand([
			'token', 'block', 'tok-1',
			'--max', '4h',
			'--reason', 'training',
			'--watch-pid', '999',
			'--watch-file', '/tmp/done',
			'--host', 'gpu1',
		], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'token.block',
			params: {
				tokenId: 'tok-1',
				maxDuration: '4h',
				reason: 'training',
				watchPid: 999,
				watchFile: '/tmp/done',
				hostAlias: 'gpu1',
			},
		});
		assert.deepStrictEqual(parseCliCommand(['token', 'fail', 'tok-1', '--reason', 'oom'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'token.fail',
			params: { tokenId: 'tok-1', reason: 'oom' },
		});
	});

	test('parses strictly top-down org control commands', () => {
		assert.deepStrictEqual(parseCliCommand(['org', 'subordinates'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'org.subordinates',
			params: {},
		});
		assert.deepStrictEqual(parseCliCommand(['org', 'send', 'emp-1', 'please', 'inspect', 'logs', '--wait'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'org.send',
			params: { target: 'emp-1', message: 'please inspect logs', wait: true },
		});
		assert.deepStrictEqual(parseCliCommand(['org', 'context', 'emp-1', '--limit', '8'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'org.context',
			params: { target: 'emp-1', limit: 8 },
		});
		assert.deepStrictEqual(parseCliCommand(['org', 'escalate', '--mission', 'm1', '--token', 'tok-1', '--reason', 'need patch'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'org.escalate',
			params: { missionId: 'm1', tokenId: 'tok-1', reason: 'need patch' },
		});
	});

	test('parses mission lifecycle, boundary, recall, patch, trigger, and host bind', () => {
		assert.deepStrictEqual(parseCliCommand(['mission', 'start', '--mission', 'm1', '--timeout', '10'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.start',
			params: { missionId: 'm1', silenceTimeoutMinutes: 10 },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'timeout', '--mission', 'm1', '--minutes', '8'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.timeout.set',
			params: { missionId: 'm1', minutes: 8 },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'boundary', 'get', '--mission', 'm1'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.boundary.get',
			params: { missionId: 'm1' },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'boundary', 'set', '--mission', 'm1', '--off-graph-max-tier', '2'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.boundary.set',
			params: { missionId: 'm1', offGraphMaxTier: 2 },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'recall', '--mission', 'm1', '--nodes', 'N2,N3', '--reason', 'pivot'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.recall',
			params: { missionId: 'm1', nodes: ['N2', 'N3'], reason: 'pivot' },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'patch', '--mission', 'm1', '--mermaid', 'graph LR\nN1-->N2', '--reason', 'fix'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.patch',
			params: { missionId: 'm1', mermaid: 'graph LR\nN1-->N2', reason: 'fix' },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'trigger', 'list', '--mission', 'm1'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.trigger.list',
			params: { missionId: 'm1' },
		});
		assert.deepStrictEqual(parseCliCommand([
			'mission', 'trigger', 'set',
			'--mission', 'm1',
			'--node', 'N1',
			'--kind', 'cron',
			'--cron', '0 * * * *',
		], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.trigger.set',
			params: { missionId: 'm1', nodeId: 'N1', kind: 'cron', cronExpr: '0 * * * *' },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'trigger', 'remove', '--mission', 'm1', '--trigger-id', 'trig-1'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.trigger.remove',
			params: { missionId: 'm1', triggerId: 'trig-1' },
		});
		assert.deepStrictEqual(parseCliCommand([
			'mission', 'host', 'bind',
			'--mission', 'm1',
			'--node', 'N1',
			'--host', 'gpu-box',
			'--path', '/workspace/app',
			'--role-kind', 'reviewer',
		], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.host.bind',
			params: {
				missionId: 'm1',
				nodeId: 'N1',
				hostAlias: 'gpu-box',
				remoteProjectPath: '/workspace/app',
				roleKind: 'reviewer',
			},
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'check', 'list', '--mission', 'm1', '--node', 'N1'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.check.list',
			params: { missionId: 'm1', nodeId: 'N1' },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'check', 'get', '--mission', 'm1', '--node', 'N1'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.check.get',
			params: { missionId: 'm1', nodeId: 'N1' },
		});
		assert.deepStrictEqual(parseCliCommand([
			'mission', 'check', 'set',
			'--mission', 'm1',
			'--node', 'N1',
			'--name', 'unit',
			'--cmd', 'pnpm test',
			'--expect-file', 'dist/out.js,dist/out.d.ts',
			'--match', 'passing',
			'--on-fail', 'bounce',
			'--max-retries', '3',
			'--timeout', '90s',
			'--cwd', 'packages/app',
			'--host', 'bupt208',
		], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.check.set',
			params: {
				missionId: 'm1',
				nodeId: 'N1',
				name: 'unit',
				command: 'pnpm test',
				expectFiles: ['dist/out.js', 'dist/out.d.ts'],
				expectOutputMatch: 'passing',
				onFail: 'bounce',
				maxAutoRetries: 3,
				timeout: '90s',
				cwd: 'packages/app',
				hostAlias: 'bupt208',
			},
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'check', 'remove', '--mission', 'm1', '--node', 'N1', '--id', 'chk-1'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.check.remove',
			params: { missionId: 'm1', nodeId: 'N1', checkId: 'chk-1' },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'check', 'run', '--mission', 'm1', '--node', 'N1'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.check.run',
			params: { missionId: 'm1', nodeId: 'N1' },
		});
		assert.deepStrictEqual(parseCliCommand(['token', 'complete', 'tok-9', '--summary', 'ok', '--skip-checks'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'token.complete',
			params: { tokenId: 'tok-9', summary: 'ok', skipChecks: true },
		});
	});

	test('runCli sends the capability token over a real loopback TCP control socket', async () => {
		const sessionToken = 'aexus-cap.fake.sig';
		const received: Array<{ token?: string; action?: string; params?: Record<string, unknown> }> = [];
		const server = net.createServer(socket => {
			let buffer = '';
			socket.setEncoding('utf8');
			socket.on('data', chunk => {
				buffer += chunk;
				const newline = buffer.indexOf('\n');
				if (newline < 0) {
					return;
				}
				received.push(JSON.parse(buffer.slice(0, newline)));
				socket.end(JSON.stringify({ ok: true, result: { agentId: 'emp-1', rank: 'employee' } }) + '\n');
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as net.AddressInfo).port;
		try {
			let stdout = '';
			let stderr = '';
			const code = await runCli(['whoami', '--json'], {
				stdout: text => { stdout += text; },
				stderr: text => { stderr += text; },
				env: {
					AEXUS_ADE_TCP_PORT: String(port),
					AEXUS_ADE_SESSION_TOKEN: sessionToken,
					AEXUS_ADE_HOME: path.join(CWD, 'no-control-file'),
					AEXUS_ADE_CONTROL_FILE: path.join(CWD, 'no-control-file', 'ade-control.json'),
				},
				cwd: CWD,
			});
			assert.strictEqual(code, 0, stderr || stdout);
			assert.deepStrictEqual(received, [{ token: sessionToken, action: 'whoami', params: {} }]);
			assert.deepStrictEqual(JSON.parse(stdout), { agentId: 'emp-1', rank: 'employee' });
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('runCli prints raw markdown for docs read in non-JSON mode', async () => {
		const request: Array<{ action?: string; params?: Record<string, unknown> }> = [];
		const server = net.createServer(socket => {
			let buffer = '';
			socket.setEncoding('utf8');
			socket.on('data', chunk => {
				buffer += chunk;
				const newline = buffer.indexOf('\n');
				if (newline < 0) {
					return;
				}
				request.push(JSON.parse(buffer.slice(0, newline)));
				socket.end(JSON.stringify({
					ok: true,
					result: { target: 'common', content: '# Common\nHello **world**' },
				}) + '\n');
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as net.AddressInfo).port;
		try {
			let stdout = '';
			let stderr = '';
			const code = await runCli(['docs', 'read', 'common'], {
				stdout: text => { stdout += text; },
				stderr: text => { stderr += text; },
				env: {
					AEXUS_ADE_TCP_PORT: String(port),
					AEXUS_ADE_SESSION_TOKEN: 'aexus-cap.fake.sig',
				},
				cwd: CWD,
			});
			assert.strictEqual(code, 0, stderr || stdout);
			assert.deepStrictEqual(request, [{ token: 'aexus-cap.fake.sig', action: 'docs.read', params: { target: 'common' } }]);
			assert.strictEqual(stdout, '# Common\nHello **world**\n');
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('runCli re-reads AEXUS_ADE_REMOTE_BRIDGE_FILE and retries transparently across ECONNREFUSED port rollover', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aexus-cli-rollover-'));
		const metaPath = path.join(tmpDir, 'ade-remote-bridge.json');
		// Allocate a guaranteed-closed ephemeral port to simulate a dead pre-reconnect tunnel.
		const deadServer = net.createServer();
		await new Promise<void>(resolve => deadServer.listen(0, '127.0.0.1', resolve));
		const deadPort = (deadServer.address() as net.AddressInfo).port;
		await new Promise<void>(resolve => deadServer.close(() => resolve()));

		const liveServer = net.createServer(socket => {
			let buffer = '';
			socket.setEncoding('utf8');
			socket.on('data', chunk => {
				buffer += chunk;
				const newline = buffer.indexOf('\n');
				if (newline < 0) {
					return;
				}
				socket.end(JSON.stringify({ ok: true, result: { agentId: 'gpu-worker', rank: 'employee' } }) + '\n');
			});
		});
		await new Promise<void>(resolve => liveServer.listen(0, '127.0.0.1', resolve));
		const livePort = (liveServer.address() as net.AddressInfo).port;

		try {
			// Initially pointer file still points at deadPort (mid-reconnect window).
			await fs.writeFile(metaPath, JSON.stringify({ version: 1, tcpPort: deadPort, updatedAt: Date.now() }));
			// After 180ms, simulate reverse bridge finishing auto-heal on a new port and atomically updating metaPath!
			const swapTimer = setTimeout(() => {
				void fs.writeFile(metaPath, JSON.stringify({ version: 1, tcpPort: livePort, updatedAt: Date.now() }));
			}, 180);

			let stdout = '';
			let stderr = '';
			const code = await runCli(['--json', 'whoami'], {
				stdout: text => { stdout += text; },
				stderr: text => { stderr += text; },
				env: {
					AEXUS_ADE_TCP_PORT: String(deadPort),
					AEXUS_ADE_REMOTE_BRIDGE_FILE: metaPath,
					AEXUS_ADE_SESSION_TOKEN: 'aexus-cap.rollover.sig',
				},
				cwd: CWD,
			});
			clearTimeout(swapTimer);
			assert.strictEqual(code, 0, stderr || stdout);
			assert.deepStrictEqual(JSON.parse(stdout), { agentId: 'gpu-worker', rank: 'employee' });
		} finally {
			await new Promise<void>(resolve => liveServer.close(() => resolve()));
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

describe('parseCliCommand rank & unified mission commands', () => {
	test('parses rank list, names, get, docs, rename, and set-count (>= 1)', () => {
		assert.deepStrictEqual(parseCliCommand(['--json', 'rank', 'names'], CWD), {
			help: false,
			json: true,
			windowId: undefined,
			action: 'rank.names',
			params: {},
		});
		assert.deepStrictEqual(parseCliCommand(['rank', 'list'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'rank.list',
			params: {},
		});
		assert.deepStrictEqual(parseCliCommand(['rank', 'get', 'L0'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'rank.get',
			params: { target: 'L0' },
		});
		assert.deepStrictEqual(parseCliCommand(['rank', 'docs', 'L2'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'rank.docs',
			params: { target: 'L2' },
		});
		assert.deepStrictEqual(parseCliCommand(['rank', 'rename', 'L2', 'Squad Lead', '--short', 'Lead'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'rank.rename',
			params: { target: 'L2', alias: 'Squad Lead', shortName: 'Lead' },
		});
		assert.deepStrictEqual(parseCliCommand(['rank', 'set-count', '1'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'rank.setCount',
			params: { count: 1 },
		});
		assert.throws(() => parseCliCommand(['rank', 'set-count', '0'], CWD), /at least 1/i);
	});

	test('parses unified mission docs and mission lifecycle actions cleanly', () => {
		assert.deepStrictEqual(parseCliCommand(['--json', 'mission', 'docs'], CWD), {
			help: false,
			json: true,
			windowId: undefined,
			action: 'mission.docs',
			params: {},
		});
		assert.deepStrictEqual(parseCliCommand(['--json', 'mission', 'status', '--governor', 'gov-1'], CWD), {
			help: false,
			json: true,
			windowId: undefined,
			action: 'mission.status',
			params: { missionId: 'gov-1' },
		});
		assert.deepStrictEqual(parseCliCommand(['mission', 'init', '--governor', 'gov-1', '--open'], CWD), {
			help: false,
			json: false,
			windowId: undefined,
			action: 'mission.init',
			params: { owner: 'gov-1', open: true },
		});
		assert.ok(HELP_TEXT.includes('rank names'));
		assert.ok(HELP_TEXT.includes('mission docs'));
	});

	test('converges mission gate, --mission/--governor aliases, org --mission, recall --branch, token reject --target, and trigger flags', () => {
		// mission gate positional approve/reject + --note + --rollback
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'gate', 'reject', '--mission', 'm-1', '--node', 'G1', '--note', 'Fix tests', '--rollback', 'N1'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.gate',
				params: { missionId: 'm-1', node: 'G1', decision: 'reject', note: 'Fix tests', rollback: 'N1' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'gate', 'approve', '--governor', 'm-1', '--node', 'G1', '--note', 'LGTM'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.gate',
				params: { missionId: 'm-1', node: 'G1', decision: 'approve', note: 'LGTM' },
			},
		);

		// org send --mission must NOT fold --mission into the message text
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'org', 'send', 'N2', 'Focus on latency', '--mission', 'm-1', '--wait'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'org.send',
				params: { target: 'N2', message: 'Focus on latency', missionId: 'm-1', wait: true },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'org', 'context', 'N2', '--limit', '15', '--mission', 'm-1'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'org.context',
				params: { target: 'N2', limit: 15, missionId: 'm-1' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'org', 'subordinates', '--mission', 'm-1'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'org.subordinates',
				params: { missionId: 'm-1' },
			},
		);

		// --branch on mission recall, --target on token reject, --event-type/--target/--trigger on triggers, --title on mission init, --governor alias everywhere
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'recall', '--governor', 'm-1', '--branch', 'N2', '--reason', 'pivot'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.recall',
				params: { missionId: 'm-1', branchRootNodeId: 'N2', reason: 'pivot' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'token', 'reject', 'tok-5', '--reason', 'bad diff', '--target', 'N1', '--governor', 'm-1'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'token.reject',
				params: { tokenId: 'tok-5', reason: 'bad diff', targetNodeId: 'N1', missionId: 'm-1' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'trigger', 'set', '--mission', 'm-1', '--node', 'S1', '--kind', 'event', '--event-type', 'file_created', '--target', '/tmp/a.txt', '--trigger', 'tr-1'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.trigger.set',
				params: { missionId: 'm-1', nodeId: 'S1', kind: 'event', eventType: 'file_created', targetPath: '/tmp/a.txt', triggerId: 'tr-1' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'trigger', 'remove', '--mission', 'm-1', '--trigger', 'tr-1'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.trigger.remove',
				params: { missionId: 'm-1', triggerId: 'tr-1' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'init', '--title', 'Nightly Bench', '--open'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.init',
				params: { title: 'Nightly Bench', open: true },
			},
		);

		// --wake-on-pid-exit / --wake-on-file aliases on token block & --token on mission gate
		assert.deepStrictEqual(
			parseCliCommand([
				'token', 'block', 'tok-9',
				'--duration', '30m',
				'--reason', 'long gpu run',
				'--wake-on-pid-exit', '4242',
				'--wake-on-file', '/tmp/model.pt',
				'--host', 'gpu-a100',
			], CWD),
			{
				help: false,
				json: false,
				windowId: undefined,
				action: 'token.block',
				params: {
					tokenId: 'tok-9',
					maxDuration: '30m',
					reason: 'long gpu run',
					watchPid: 4242,
					watchFile: '/tmp/model.pt',
					hostAlias: 'gpu-a100',
				},
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'gate', 'approve', '--mission', 'm-1', '--node', 'G1', '--token', 'tok-wave2', '--note', 'LGTM'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.gate',
				params: {
					missionId: 'm-1',
					node: 'G1',
					tokenId: 'tok-wave2',
					decision: 'approve',
					note: 'LGTM',
				},
			},
		);
	});
});
