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
		assert.ok(HELP_TEXT.includes('mission task list|get|create|update|set|remove|complete'));
		assert.ok(!HELP_TEXT.includes('mission prompt set'));
		assert.ok(!HELP_TEXT.includes('mission boundary get|set'));
		assert.ok(!HELP_TEXT.includes('Employee IS NOT Worker'));
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
		const received: Array<{ token?: string; action?: string; params?: Record<string, unknown>; idempotencyKey?: string; caller?: string }> = [];
		const srv = net.createServer(sock => {
			let buf = '';
			sock.setEncoding('utf8');
			sock.on('data', chunk => {
				buf += chunk;
				const idx = buf.indexOf('\n');
				if (idx >= 0) {
					received.push(JSON.parse(buf.slice(0, idx)) as { token?: string; action?: string; params?: Record<string, unknown>; idempotencyKey?: string; caller?: string });
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
			assert.strictEqual(received.length, 1);
			assert.strictEqual(received[0].token, capToken);
			assert.strictEqual(received[0].action, 'mission.run');
			assert.deepStrictEqual(received[0].params, { missionId: 'gov-1' });
			assert.strictEqual(received[0].caller, undefined);
			assert.match(received[0].idempotencyKey ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
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
		for (const target of ['L2', 'common', 'engineering', 'paradigm', 'engineering-api', 'mission', 'manifest']) {
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
		assert.ok(HELP_TEXT.includes('docs read <common|L0..LN|engineering|paradigm|engineering-api|mission|manifest>'));
		assert.ok(HELP_TEXT.includes('rank docs [common|L0|L1..LN|engineering|engineering-api|mission]'));
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

	test('parses Engineering dual-view mission task, orchestration, token handoff, and whiteboard commands', () => {
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'open', '--mission', 'eng-1', '--view', 'both'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.open',
				params: { missionId: 'eng-1', view: 'both' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'task', 'complete', '--mission', 'eng-1', '--node', 'T2', '--note', 'verified'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.task.complete',
				params: { missionId: 'eng-1', nodeId: 'T2', status: 'completed', note: 'verified' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'dispatch', '--mission', 'eng-1', '--prompt', 'Build v2 API', '--whiteboard', 'WB1,WB2'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.dispatch',
				params: { missionId: 'eng-1', prompt: 'Build v2 API', whiteboardIds: ['WB1', 'WB2'] },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'staff', 'create', '--mission', 'eng-1', '--name', 'Dave', '--rank', 'L3', '--department', 'Backend', '--handoff-token', 'otok-1', '--summary', 'Build endpoint'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.staff.create',
				params: {
					missionId: 'eng-1',
					name: 'Dave',
					rank: 'L3',
					department: 'Backend',
					handoffTokenId: 'otok-1',
					handoffSummary: 'Build endpoint',
				},
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'token', 'handoff', 'otok-1', '--to', 'BE_Lead,FE_Lead', '--summary', 'Decomposed subtasks', '--whiteboard', 'WB_BE', '--mission', 'eng-1'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'token.handoff',
				params: {
					tokenId: 'otok-1',
					toNodeIds: ['BE_Lead', 'FE_Lead'],
					summary: 'Decomposed subtasks',
					whiteboardIds: ['WB_BE'],
					missionId: 'eng-1',
				},
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'whiteboard', 'write', 'WB_BE', '--mission', 'eng-1', '--department', 'Backend', '--title', 'API Spec', '--content', '# v2 Spec'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'whiteboard.write',
				params: {
					id: 'WB_BE',
					missionId: 'eng-1',
					department: 'Backend',
					title: 'API Spec',
					content: '# v2 Spec',
				},
			},
		);

		// Pointer-native token read, token history, and split-pointer handoff/dispatch flags
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'token', 'read', 'hop-2,art-1,wb:WB_BE', '--mission', 'eng-1', '--token', 'otok-3'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'token.read',
				params: {
					ptrs: ['hop-2', 'art-1', 'wb:WB_BE'],
					missionId: 'eng-1',
					tokenId: 'otok-3',
				},
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'token', 'history', 'otok-3', '--mission', 'eng-1', '--delta'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'token.history',
				params: {
					tokenId: 'otok-3',
					missionId: 'eng-1',
					deltaOnly: true,
				},
			},
		);
		assert.deepStrictEqual(
			parseCliCommand([
				'--json', 'token', 'handoff', 'otok-3',
				'--to', 'BE_Lead',
				'--summary', 'Implemented /v2/pay',
				'--detail', 'Run tests with --json and --help verified',
				'--artifact', 'Bench=p99=11ms --json ok',
				'--decision', 'Lock=INSERT ON CONFLICT',
				'--ref', 'art-1,dec-2',
				'--whiteboard', 'WB_BE',
				'--mission', 'eng-1',
			], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'token.handoff',
				params: {
					tokenId: 'otok-3',
					toNodeIds: ['BE_Lead'],
					summary: 'Implemented /v2/pay',
					detail: 'Run tests with --json and --help verified',
					artifacts: [{ title: 'Bench', content: 'p99=11ms --json ok' }],
					decisions: [{ title: 'Lock', content: 'INSERT ON CONFLICT' }],
					refPtrs: ['art-1', 'dec-2'],
					whiteboardIds: ['WB_BE'],
					missionId: 'eng-1',
				},
			},
		);
		assert.deepStrictEqual(
			parseCliCommand([
				'--json', 'orchestration', 'dispatch',
				'--mission', 'eng-1',
				'--prompt', 'Ship payments v2',
				'--detail', 'Full rollout plan with zero downtime',
				'--artifact', 'DDL=CREATE TABLE t(id TEXT)',
				'--decision', 'TTL=24h',
			], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.dispatch',
				params: {
					missionId: 'eng-1',
					prompt: 'Ship payments v2',
					detail: 'Full rollout plan with zero downtime',
					artifacts: [{ title: 'DDL', content: 'CREATE TABLE t(id TEXT)' }],
					decisions: [{ title: 'TTL', content: '24h' }],
				},
			},
		);
		assert.ok(HELP_TEXT.includes('token read'));
		assert.ok(HELP_TEXT.includes('token history'));
	});

	test('parses lossless migration, group, layout, staff, edge & whiteboard CLI authoring commands', () => {
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'export', '--mission', 'eng-1', '--with-positions', '--file', 'out/eng.json'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.export',
				params: { missionId: 'eng-1', withPositions: true, outputFile: 'out/eng.json' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'import', '--owner', 'gov-1', '--title', 'Migrated App', '--file', 'out/eng.json', '--open'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.import',
				params: { owner: 'gov-1', title: 'Migrated App', file: 'out/eng.json', open: true },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'export', '--mission', 'eng-1', '--with-positions', '--raw', '--file', 'out/orch.mmd'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.export',
				params: { missionId: 'eng-1', withPositions: true, raw: true, outputFile: 'out/orch.mmd' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'import', '--mission', 'eng-1', '--file', 'out/orch.mmd'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.import',
				params: { missionId: 'eng-1', file: 'out/orch.mmd' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'layout', 'set', 'radial', '--mission', 'eng-1', '--persist-in-code'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.layout.set',
				params: { layoutMode: 'radial', missionId: 'eng-1', persistInCode: true },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'group', 'create', '--mission', 'eng-1', '--name', 'Platform Core', '--id', 'PlatformCore'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.group.create',
				params: { missionId: 'eng-1', name: 'Platform Core', groupId: 'PlatformCore' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'group', 'rename', '--mission', 'eng-1', 'PlatformCore', 'Cloud Core'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.group.rename',
				params: { missionId: 'eng-1', group: 'PlatformCore', name: 'Cloud Core' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'group', 'assign', '--mission', 'eng-1', '--node', 'E1', '--group', 'Cloud Core'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.group.assign',
				params: { missionId: 'eng-1', nodeId: 'E1', group: 'Cloud Core' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'group', 'remove', '--mission', 'eng-1', 'Cloud Core', '--delete-members'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.group.remove',
				params: { missionId: 'eng-1', group: 'Cloud Core', deleteMembers: true },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'staff', 'rename', '--mission', 'eng-1', 'E1', 'Staff Backend Engineer'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.staff.rename',
				params: { missionId: 'eng-1', nodeId: 'E1', label: 'Staff Backend Engineer' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'staff', 'remove', '--mission', 'eng-1', 'E1'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.staff.remove',
				params: { missionId: 'eng-1', nodeId: 'E1' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'edge', 'connect', '--mission', 'eng-1', 'CEO', 'Lead', '--label', 'plan', '--bidirectional', '--dashed'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.edge.connect',
				params: { missionId: 'eng-1', from: 'CEO', to: 'Lead', label: 'plan', bidirectional: true, dashed: true },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'edge', 'label', '--mission', 'eng-1', 'CEO', 'Lead', 'review'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.edge.label',
				params: { missionId: 'eng-1', from: 'CEO', to: 'Lead', label: 'review' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'edge', 'remove', '--mission', 'eng-1', 'CEO', 'Lead', '--both'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.edge.remove',
				params: { missionId: 'eng-1', from: 'CEO', to: 'Lead', both: true },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'whiteboard', 'rename', 'WB_BE', 'Platform API Spec', '--department', 'Cloud Core', '--mission', 'eng-1'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'whiteboard.rename',
				params: { id: 'WB_BE', title: 'Platform API Spec', department: 'Cloud Core', missionId: 'eng-1' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'whiteboard', 'remove', 'WB_BE', '--mission', 'eng-1'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'whiteboard.remove',
				params: { id: 'WB_BE', missionId: 'eng-1' },
			},
		);
		assert.ok(HELP_TEXT.includes('mission export'));
		assert.ok(HELP_TEXT.includes('orchestration group'));
		assert.ok(HELP_TEXT.includes('orchestration edge'));
		assert.ok(HELP_TEXT.includes('whiteboard rename'));
	});

	test('parses Revision 8 heterogeneous token mint/split/return, dynamic Mission Task DAG CRUD, code-as-config validate/load, staff config/remove, and pause/resume/abort', async () => {
		// Item 1: token mint / split / return
		const branchesJson = JSON.stringify([
			{ toNodeId: 'BE_Lead', summary: 'Build API', detail: 'Schema+REST', taskNodeId: 'T_BE' },
			{ toNodeId: 'FE_Lead', summary: 'Build UI', detail: 'Checkout drawer', taskNodeId: 'T_FE' },
		]);
		assert.deepStrictEqual(
			parseCliCommand([
				'--json', 'token', 'split', 'otok-1',
				'--branches-json', branchesJson,
				'--wait-join', '--join-mode', 'all', '--mission', 'eng-1',
			], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'token.split',
				params: {
					parentTokenId: 'otok-1',
					branchesJson,
					waitJoin: true,
					joinMode: 'all',
					missionId: 'eng-1',
				},
			},
		);
		assert.deepStrictEqual(
			parseCliCommand([
				'--json', 'token', 'mint', 'otok-1',
				'--to', 'BE_Lead',
				'--summary', 'Build API',
				'--detail', 'Schema+REST',
				'--task', 'T_BE',
				'--no-wait-join', '--mission', 'eng-1',
			], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'token.mint',
				params: {
					parentTokenId: 'otok-1',
					toNodeIds: ['BE_Lead'],
					summary: 'Build API',
					detail: 'Schema+REST',
					taskNodeId: 'T_BE',
					waitJoin: false,
					noWaitJoin: true,
					missionId: 'eng-1',
				},
			},
		);
		assert.deepStrictEqual(
			parseCliCommand([
				'--json', 'token', 'return', 'otok-2',
				'--to', 'CEO',
				'--summary', 'API done',
				'--detail', '42 tests pass',
				'--skip-checks', '--mission', 'eng-1',
			], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'token.return',
				params: {
					tokenId: 'otok-2',
					toNodeId: 'CEO',
					summary: 'API done',
					detail: '42 tests pass',
					skipChecks: true,
					missionId: 'eng-1',
				},
			},
		);

		// Item 3: Mission Task DAG CRUD & force complete
		assert.deepStrictEqual(
			parseCliCommand([
				'--json', 'mission', 'task', 'create',
				'--mission', 'eng-1', '--id', 'T_API', '--title', 'Build API',
				'--description', 'REST endpoints', '--after', 'T_SPEC',
				'--owner', 'BE_Lead', '--department', 'Backend', '--min-tier', '2',
				'--completers', 'BE_Lead,QA1',
			], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.task.create',
				params: {
					missionId: 'eng-1',
					id: 'T_API',
					title: 'Build API',
					description: 'REST endpoints',
					after: ['T_SPEC'],
					ownerNodeId: 'BE_Lead',
					department: 'Backend',
					minCompleterTier: 2,
					allowedCompleterNodeIds: ['BE_Lead', 'QA1'],
				},
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'task', 'edge', 'add', 'T_SPEC', 'T_API', '--label', 'blocks', '--mission', 'eng-1'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.task.edge.add',
				params: { from: 'T_SPEC', to: 'T_API', label: 'blocks', missionId: 'eng-1' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'task', 'complete', 'T_API', '--mission', 'eng-1', '--force', '--note', 'Override'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'mission.task.complete',
				params: { status: 'completed', nodeId: 'T_API', missionId: 'eng-1', force: true, note: 'Override' },
			},
		);

		// Item 2 & 5 & 8: staff config/remove, validate/load, pause/resume/abort
		assert.deepStrictEqual(
			parseCliCommand([
				'--json', 'orchestration', 'staff', 'config', 'Dev1',
				'--mission', 'eng-1', '--engine', 'aexus-claude', '--model', 'claude-sonnet-4-6',
				'--thinking', 'high', '--host', 'gpu-1', '--allowed-path', 'src/api/**', '--reset-session',
			], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.staff.configure',
				params: {
					nodeId: 'Dev1',
					missionId: 'eng-1',
					engineId: 'aexus-claude',
					model: 'claude-sonnet-4-6',
					thinking: 'high',
					hostAlias: 'gpu-1',
					allowedPaths: ['src/api/**'],
					resetSession: true,
				},
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'staff', 'remove', 'Dev1', '--mission', 'eng-1', '--reason', 'Downsize', '--force'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.staff.remove',
				params: { nodeId: 'Dev1', missionId: 'eng-1', reason: 'Downsize', force: true },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'pause', '--mission', 'eng-1', '--reason', 'Hold wave'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.pause',
				params: { missionId: 'eng-1', reason: 'Hold wave' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'resume', '--mission', 'eng-1'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.resume',
				params: { missionId: 'eng-1' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'abort', '--mission', 'eng-1', '--reason', 'Stop now'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.abort',
				params: { missionId: 'eng-1', reason: 'Stop now' },
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'export', '--mission', 'eng-1', '--format', 'json'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'orchestration.export',
				params: { missionId: 'eng-1', format: 'json' },
			},
		);

		// Verify runCli loads both .json and .mjs manifest files for `orchestration validate`
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-cli-manifest-'));
		const sockPath = path.join(tmpDir, 'ctrl.sock');
		const received: Array<{ action: string; params: Record<string, unknown> }> = [];
		const srv = net.createServer(sock => {
			let buf = '';
			let replied = false;
			sock.on('data', chunk => {
				buf += chunk.toString('utf8');
				const nl = buf.indexOf('\n');
				if (!replied && nl >= 0) {
					replied = true;
					const msg = JSON.parse(buf.slice(0, nl).trim());
					received.push({ action: msg.action, params: msg.params });
					sock.end(JSON.stringify({ ok: true, result: { valid: true } }) + '\n');
				}
			});
		});
		await new Promise<void>(resolve => srv.listen(sockPath, resolve));
		try {
			const jsonPath = path.join(tmpDir, 'team.json');
			await fs.writeFile(jsonPath, JSON.stringify({ schemaVersion: 1, title: 'JSON Team', staff: [{ id: 'CEO', name: 'Alice', tier: 1 }] }), 'utf8');
			const mjsPath = path.join(tmpDir, 'team.mjs');
			await fs.writeFile(mjsPath, 'export default { schemaVersion: 1, title: "MJS Team", staff: [{ id: "CEO", name: "Bob", tier: 1 }] };\n', 'utf8');

			const env = { AEXUS_ADE_SOCKET: sockPath, AEXUS_ADE_TOKEN: 'tok-test' };
			const code1 = await runCli(['--json', 'orchestration', 'validate', '--file', jsonPath], { stdout: () => { }, stderr: () => { }, env });
			const code2 = await runCli(['--json', 'orchestration', 'load', '--mission', 'eng-1', '--file', mjsPath], { stdout: () => { }, stderr: () => { }, env });
			assert.strictEqual(code1, 0);
			assert.strictEqual(code2, 0);
			assert.strictEqual(received[0].action, 'orchestration.validate');
			assert.strictEqual((received[0].params.manifest as { title: string }).title, 'JSON Team');
			assert.strictEqual(received[1].action, 'orchestration.load');
			assert.strictEqual((received[1].params.manifest as { title: string }).title, 'MJS Team');
		} finally {
			srv.close();
			await fs.rm(tmpDir, { recursive: true, force: true });
		}

		assert.deepStrictEqual(
			parseCliCommand(['--json', 'whiteboard', 'list', '--mission', 'eng-1', '--department', 'Backend'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'whiteboard.list', params: { missionId: 'eng-1', department: 'Backend' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'whiteboard', 'write', 'WB_BE', '--mission', 'eng-1', '--content', 'v2 spec', '--expected-version', '1'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'whiteboard.write', params: { id: 'WB_BE', missionId: 'eng-1', content: 'v2 spec', expectedVersion: 1 } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'staff', 'create', '--mission', 'eng-1', '--name', 'Sam', '--mint-token', 'otok-1', '--summary', 'Own cache'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'orchestration.staff.create', params: { missionId: 'eng-1', name: 'Sam', mintTokenId: 'otok-1', handoffSummary: 'Own cache' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'staff', 'config', '--mission', 'eng-1', '--node', 'CEO', '--color', 'gold'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'orchestration.staff.configure', params: { missionId: 'eng-1', nodeId: 'CEO', color: 'gold' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'mission', 'task', 'update', '--mission', 'eng-1', '--node', 'T1', '--color', '#22d3ee'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'mission.task.update', params: { missionId: 'eng-1', nodeId: 'T1', color: '#22d3ee' } },
		);

		// Root token mint & split WITHOUT pre-existing parentTokenId (L1 directly after User Chat!) + CLI doc flag parity
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'token', 'split', '--branches-json', branchesJson, '--mission', 'eng-1'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'token.split', params: { branchesJson, missionId: 'eng-1' } },
		);
		assert.deepStrictEqual(
			parseCliCommand([
				'--json', 'token', 'split', 'otok-1',
				'--branch', '{"toNodeId":"BE_Lead","summary":"Build API"}',
				'--branch', '{"toNodeId":"FE_Lead","summary":"Build UI"}',
				'--wait-join',
			], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'token.split',
				params: {
					parentTokenId: 'otok-1',
					branches: [
						{ toNodeId: 'BE_Lead', summary: 'Build API' },
						{ toNodeId: 'FE_Lead', summary: 'Build UI' },
					],
					waitJoin: true,
				},
			},
		);
		assert.throws(
			() => parseCliCommand(['token', 'split', '--branch', '{not-json'], CWD),
			/Option --branch expects valid JSON/,
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'token', 'mint', '--to', 'BE_Lead', '--summary', 'Build auth', '--from', 'CEO', '--wait-join', '--mission', 'eng-1'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'token.mint', params: { toNodeIds: ['BE_Lead'], summary: 'Build auth', fromNodeId: 'CEO', waitJoin: true, missionId: 'eng-1' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'token', 'return', 'otok-3', '--summary', 'Done', '--task-id', 'T2', '--complete-task', '--files', 'src/backend/a.ts,tests/backend/a.test.ts', '--mission', 'eng-1'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'token.return', params: { tokenId: 'otok-3', summary: 'Done', taskNodeId: 'T2', completeTask: true, modifiedFiles: ['src/backend/a.ts', 'tests/backend/a.test.ts'], missionId: 'eng-1' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'token', 'complete', 'otok-9', '--summary', 'Verified', '--task-id', 'T2', '--finish', '--complete-task', '--mission', 'eng-1'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'token.complete', params: { tokenId: 'otok-9', summary: 'Verified', taskNodeId: 'T2', finish: true, completeTask: true, missionId: 'eng-1' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'token', 'reject', 'otok-2', '--reason', 'Missing null check', '--target', 'Dev1,QA1', '--detail', 'Line 42 crashes on empty input', '--whiteboard', 'WB_BE', '--no-wait-join', '--mission', 'eng-1'], CWD),
			{
				help: false,
				json: true,
				windowId: undefined,
				action: 'token.reject',
				params: {
					tokenId: 'otok-2',
					reason: 'Missing null check',
					targetNodeIds: ['Dev1', 'QA1'],
					targetNodeId: 'Dev1',
					detail: 'Line 42 crashes on empty input',
					whiteboardIds: ['WB_BE'],
					waitJoin: false,
					noWaitJoin: true,
					missionId: 'eng-1',
				},
			},
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'token', 'fail', 'otok-4', '--reason', 'Build failed', '--detail', 'Exit code 2 in tsc', '--mission', 'eng-1'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'token.fail', params: { tokenId: 'otok-4', reason: 'Build failed', detail: 'Exit code 2 in tsc', missionId: 'eng-1' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'staff', 'create', '--mission', 'eng-1', '--name', 'Nova', '--role', 'L2', '--allow-path', 'src/ai', '--color', 'cyan', '--bidirectional'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'orchestration.staff.create', params: { missionId: 'eng-1', name: 'Nova', rank: 'L2', allowedPaths: ['src/ai'], color: 'cyan', bidirectional: true } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'staff', 'create', '--mission', 'eng-1', '--name', 'QA Lead', '--rank', 'L2', '--new-department', 'QA & Audit', '--create-whiteboard', '--whiteboard-title', 'QA Shared Board', '--engine', 'claude', '--model', 'deepseek-flash[1m]', '--thinking', 'medium'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'orchestration.staff.create', params: { missionId: 'eng-1', name: 'QA Lead', rank: 'L2', department: 'QA & Audit', createWhiteboard: true, whiteboardTitle: 'QA Shared Board', engineId: 'claude', model: 'deepseek-flash[1m]', thinking: 'medium' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'staff', 'create', '--mission', 'eng-1', '--name', 'Sec Lead', '--rank', 'L2', '--new-dept', 'Security', '--create-whiteboard=Security Board'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'orchestration.staff.create', params: { missionId: 'eng-1', name: 'Sec Lead', rank: 'L2', department: 'Security', createWhiteboard: true, whiteboardTitle: 'Security Board' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'staff', 'config', '--mission', 'eng-1', '--node', 'Nova', '--allow-path', 'src/ai,tests/ai'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'orchestration.staff.configure', params: { missionId: 'eng-1', nodeId: 'Nova', allowedPaths: ['src/ai', 'tests/ai'] } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'limits', '--mission', 'eng-1', '--max-hops', '32', '--budget', '15.5'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'orchestration.limits', params: { missionId: 'eng-1', maxHops: 32, budgetLimitUsd: 15.5 } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'orchestration', 'limits', '--mission', 'eng-1', '--max-hops', 'none', '--budget', 'none'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'orchestration.limits', params: { missionId: 'eng-1', maxHops: null, budgetLimitUsd: null } },
		);
		assert.ok(HELP_TEXT.includes('token mint'));
		assert.ok(HELP_TEXT.includes('token return'));
		assert.ok(HELP_TEXT.includes('orchestration validate'));
		assert.ok(HELP_TEXT.includes('orchestration pause'));
		assert.ok(HELP_TEXT.includes('orchestration limits'));
	});

	test('supports shell-safe --detail-file, --detail -, --append-file, and --append - across token and whiteboard commands', () => {
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'token', 'mint', 'otok-1', '--to', 'Eng1', '--summary', 'Fix D1', '--detail-file', '/tmp/spec.md', '--mission', 'eng-1'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'token.mint', params: { parentTokenId: 'otok-1', toNodeIds: ['Eng1'], summary: 'Fix D1', detailFile: '/tmp/spec.md', missionId: 'eng-1' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'token', 'return', 'otok-2', '--summary', 'Fixed', '--detail', '-', '--mission', 'eng-1'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'token.return', params: { tokenId: 'otok-2', summary: 'Fixed', detail: '-', missionId: 'eng-1' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'token', 'reject', 'otok-3', '--reason', 'Broken edge case', '--detail-file', 'notes.md', '--mission', 'eng-1'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'token.reject', params: { tokenId: 'otok-3', reason: 'Broken edge case', detailFile: 'notes.md', missionId: 'eng-1' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'whiteboard', 'write', 'wb-cli', '--append', '-', '--mission', 'eng-1'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'whiteboard.write', params: { id: 'wb-cli', appendContent: '-', missionId: 'eng-1' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'whiteboard', 'write', 'wb-cli', '--append-file', 'addendum.md', '--mission', 'eng-1'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'whiteboard.write', params: { id: 'wb-cli', appendFile: 'addendum.md', missionId: 'eng-1' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['--json', 'whiteboard', 'append', 'wb-cli', '--file', 'addendum.md', '--mission', 'eng-1'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'whiteboard.write', params: { id: 'wb-cli', appendFile: 'addendum.md', missionId: 'eng-1' } },
		);
	});

	test('covers Phase 2 CLI parser & completion parity: freeform flags, next-flag guards, --role= symmetry, strict --min-tier, session delete --force, host add alias, rank mission-name, mission rename, read-only limits & --full', async () => {
		// 1. Freeform flags (--title, --name, --branches-json, --cmd) never let --help/--json hijack parsing; --flag=value works too
		assert.deepStrictEqual(
			parseCliCommand(['mission', 'init', '--title', 'Fix --help & -v handling', '--json'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'mission.init', params: { title: 'Fix --help & -v handling' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['mission', 'init', '--title=--json title', '--json'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'mission.init', params: { title: '--json title' } },
		);

		// 2. Non-positional flags before positional IDs do NOT corrupt positionalCount (`org send --mission m-1 --json emp-1 ...`)
		assert.deepStrictEqual(
			parseCliCommand(['org', 'send', '--mission', 'm-1', '--json', 'emp-1', 'run', 'tool', '--help'], CWD),
			{ help: false, json: true, windowId: undefined, action: 'org.send', params: { missionId: 'm-1', target: 'emp-1', message: 'run tool --help' } },
		);
		// Trailing `--help` inside `session send <id> ...` stays part of prompt text instead of printing CLI help
		assert.deepStrictEqual(
			parseCliCommand(['session', 'send', 's-1', 'check', '--help'], CWD),
			{ help: false, json: false, windowId: undefined, action: 'session.send', params: { id: 's-1', prompt: 'check --help' } },
		);

		// 3. takeOptVal rejects swallowing next `--flag` when value was omitted
		assert.throws(() => parseCliCommand(['token', 'handoff', 'otok-1', '--to', '--summary', 'oops'], CWD), /requires a value, got --summary/);
		assert.throws(() => parseCliCommand(['docs', 'read', 'common', 'extra-arg'], CWD), /Usage: aexus-ade docs read/);

		// 4. `--role=L2` and `--role L2` behave symmetrically in `orchestration staff create`, plus `--bidirectional=false`
		assert.deepStrictEqual(
			parseCliCommand(['orchestration', 'staff', 'create', '--mission', 'm-1', '--name', 'Lead', '--role=L2', '--bidirectional=false'], CWD),
			{ help: false, json: false, windowId: undefined, action: 'orchestration.staff.create', params: { missionId: 'm-1', name: 'Lead', rank: 'L2', bidirectional: false } },
		);

		// 5. Strict `--min-tier` enforces 1..99 (L1..L99) and accepts clear/off/none on update
		assert.throws(() => parseCliCommand(['mission', 'task', 'create', '--title', 'T', '--min-tier', 'L'], CWD), /Invalid --min-tier/);
		assert.throws(() => parseCliCommand(['mission', 'task', 'create', '--title', 'T', '--min-tier', 'L2x'], CWD), /Invalid --min-tier/);
		assert.throws(() => parseCliCommand(['mission', 'task', 'create', '--title', 'T', '--min-tier', '-1'], CWD), /Invalid --min-tier/);
		assert.throws(() => parseCliCommand(['mission', 'task', 'create', '--title', 'T', '--min-tier', '0'], CWD), /Invalid --min-tier/);
		assert.throws(() => parseCliCommand(['mission', 'task', 'create', '--title', 'T', '--min-tier', '100'], CWD), /Invalid --min-tier/);
		assert.deepStrictEqual(
			parseCliCommand(['mission', 'task', 'update', 'T1', '--min-tier', 'L2'], CWD).params,
			{ nodeId: 'T1', minCompleterTier: 2 },
		);
		assert.deepStrictEqual(
			parseCliCommand(['mission', 'task', 'update', 'T1', '--min-tier', 'clear'], CWD).params,
			{ nodeId: 'T1', minCompleterTier: null },
		);
		assert.deepStrictEqual(
			parseCliCommand(['mission', 'task', 'update', 'T1', '--min-tier', 'off'], CWD).params,
			{ nodeId: 'T1', minCompleterTier: null },
		);

		// 6. `session delete <id> --force`, `host add <alias> --host <addr>`, `rank mission-name`, `mission rename` (no wrong fallbackAction), read-only & full `orchestration limits`, `token split` quorum/fail-fast/deadline, `orchestration dispatch --ref`, and `--full`
		assert.deepStrictEqual(
			parseCliCommand(['session', 'delete', 's-9', '--force'], CWD),
			{ help: false, json: false, windowId: undefined, action: 'session.delete', params: { id: 's-9', force: true } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['host', 'add', 'gpu1', '--host', '10.0.0.5', '--user', 'ubuntu'], CWD),
			{ help: false, json: false, windowId: undefined, action: 'host.upsert', params: { alias: 'gpu1', hostName: '10.0.0.5', user: 'ubuntu' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['rank', 'mission-name', 'Campaign'], CWD),
			{ help: false, json: false, windowId: undefined, action: 'rank.setMissionName', params: { name: 'Campaign' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['mission', 'rename', 'm-1', 'Payments', 'v2'], CWD),
			{ help: false, json: false, windowId: undefined, action: 'mission.rename', params: { missionId: 'm-1', title: 'Payments v2' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['orchestration', 'limits', '--mission', 'm-1'], CWD),
			{ help: false, json: false, windowId: undefined, action: 'orchestration.limits', params: { missionId: 'm-1' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['orchestration', 'limits', '--mission', 'm-1', '--max-hops', 'off', '--budget', 'inf', '--silence', '30', '--total-cost', '1.5'], CWD).params,
			{ missionId: 'm-1', maxHops: null, budgetLimitUsd: null, silenceReminderMinutes: 30, totalCostUsd: 1.5 },
		);
		const splitQuorum = parseCliCommand(['token', 'split', 'otok-1', '--branches-json', '[{"to":"Dev1","summary":"A"},{"to":"Dev2","summary":"B"}]', '--join-mode', 'quorum', '--quorum', '2', '--fail-fast', '--deadline', '1700000000000'], CWD);
		assert.strictEqual(splitQuorum.params?.joinMode, 'quorum');
		assert.strictEqual(splitQuorum.params?.quorumCount, 2);
		assert.strictEqual(splitQuorum.params?.failFast, true);
		assert.strictEqual(splitQuorum.params?.deadlineAt, 1700000000000);
		const splitRelDeadline = parseCliCommand(['token', 'mint', 'otok-1', '--to', 'Dev1', '--summary', 'Run', '--deadline', '15m'], CWD);
		assert.ok(typeof splitRelDeadline.params?.deadlineAt === 'number' && (splitRelDeadline.params.deadlineAt as number) > Date.now() + 800_000);
		assert.deepStrictEqual(
			parseCliCommand(['orchestration', 'dispatch', '--mission', 'm-1', '--prompt', 'Start', '--ref', 'art-1,dec-2'], CWD).params,
			{ missionId: 'm-1', prompt: 'Start', refPtrs: ['art-1', 'dec-2'] },
		);
		assert.strictEqual(parseCliCommand(['orchestration', 'status', '--mission', 'm-1', '--full'], CWD).params?.full, true);
		assert.strictEqual(parseCliCommand(['token', 'current', '--full'], CWD).params?.full, true);
		assert.strictEqual(parseCliCommand(['org', 'context', 'emp-1', '--full'], CWD).params?.full, true);
		assert.strictEqual(parseCliCommand(['mission', 'task', 'list', '--full'], CWD).params?.full, true);
		assert.deepStrictEqual(
			parseCliCommand(['token', 'reject', 'otok-5', '--summary', 'Missing edge case', '--to', 'Dev1'], CWD).params,
			{ tokenId: 'otok-5', reason: 'Missing edge case', targetNodeId: 'Dev1' },
		);
		assert.deepStrictEqual(
			parseCliCommand(['token', 'retry', 'otok-6', '--guidance', 'Re-run with clean env', '--wait-join', '--mission', 'm-1'], CWD).params,
			{ tokenId: 'otok-6', guidance: 'Re-run with clean env', waitJoin: true, missionId: 'm-1' },
		);

		// 7. Zsh completion includes orchestration, whiteboard, mission task/export/import/rename, rank mission-name, token mint/split/return, session configure
		let zsh = '';
		await runCli(['completion', 'zsh'], { stdout: s => { zsh += s; }, stderr: () => { }, env: {} });
		for (const expected of ['orchestration:', 'whiteboard:', 'mission-name:', 'mint:', 'split:', 'return:', 'configure:', 'export:', 'import:', 'task:']) {
			assert.ok(zsh.includes(expected), `Zsh completion missing ${expected}`);
		}
	});
});
