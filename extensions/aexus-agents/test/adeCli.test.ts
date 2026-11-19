/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { parseCliCommand, runCli } from '../src/adeCli.ts';

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
			outputs: Array.from({ length: 3 }, () => 'aexus-ade 1.0.0 (Aexus Code / Code - OSS 1.146.0)\n'),
		});
	});

	test('prints structured JSON when --json is passed', async () => {
		let stdout = '';
		const exitCode = await runCli(['--version', '--json'], {
			stdout: text => { stdout += text; },
			stderr: text => { stdout += text; },
			env: {},
		});
		assert.deepStrictEqual({ exitCode, version: JSON.parse(stdout) }, {
			exitCode: 0,
			version: { cli: 'aexus-ade', version: '1.0.0', engineBaseline: '1.146.0' },
		});
	});
});

describe('runCli completion', () => {
	test('emits a completion script for bash, zsh, and fish covering the top-level groups', async () => {
		const scripts = await Promise.all((['bash', 'zsh', 'fish'] as const).map(async shell => {
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
			for (const token of ['doctor', 'completion', 'status', 'mode', 'view', 'project', 'host', 'engine', 'session', 'secretary', 'engineering', 'inbox', 'demo', 'watchdog-action']) {
				assert.ok(stdout.includes(token), `${shell} completion is missing ${token}`);
			}
		}
		assert.match(scripts.find(script => script.shell === 'bash')!.stdout, /complete -F _aexus_ade aexus-ade/);
		assert.match(scripts.find(script => script.shell === 'zsh')!.stdout, /^#compdef aexus-ade/m);
		assert.match(scripts.find(script => script.shell === 'fish')!.stdout, /^# fish completion for aexus-ade/m);
	});

	test('rejects an unknown or missing shell', async () => {
		const errors: string[] = [];
		const io = { stdout: (text: string) => { errors.push(text); }, stderr: (text: string) => { errors.push(text); }, env: {} };
		const exitCodes = [
			await runCli(['completion'], io),
			await runCli(['completion', 'powershell'], io),
		];
		assert.deepStrictEqual({ exitCodes, errors }, {
			exitCodes: [1, 1],
			errors: [
				'Error: Usage: aexus-ade completion <bash|zsh|fish>\n',
				'Error: Usage: aexus-ade completion <bash|zsh|fish>\n',
			],
		});
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
		assert.deepStrictEqual({ exitCode, stderr, hasAnsi: stdout.includes('\u001b[') }, { exitCode: 0, stderr: '', hasAnsi: false });
	});

	test('FORCE_COLOR enables ANSI even when stdout is not a TTY', async () => {
		const { stdout } = await runDoctor({ FORCE_COLOR: '1' }, false);
		assert.ok(stdout.includes('\u001b['));
	});
});

describe('runCli doctor --json', () => {
	test('emits a structured environment report without requiring a running workbench', async () => {
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
		assert.deepStrictEqual({ exitCode, stderr }, { exitCode: 0, stderr: '' });
		const report = JSON.parse(stdout) as {
			readonly platform: string;
			readonly arch: string;
			readonly projectPath: string;
			readonly controlPlane: { readonly connected: boolean };
			readonly projectRules: readonly string[];
			readonly engines: readonly { readonly id: string }[];
			readonly summary: { readonly enginesReady: number; readonly enginesTotal: number };
		};
		assert.deepStrictEqual({
			platform: report.platform,
			arch: report.arch,
			projectPath: report.projectPath,
			controlPlaneConnected: report.controlPlane.connected,
			projectRules: report.projectRules,
			engineIds: report.engines.map(engine => engine.id),
			summary: report.summary,
		}, {
			platform: process.platform,
			arch: process.arch,
			projectPath: CWD,
			controlPlaneConnected: false,
			projectRules: [],
			engineIds: ['claude-code', 'codex', 'antigravity', 'opencode', 'kilo', 'dsh', 'cline', 'pi'],
			summary: { enginesReady: 0, enginesTotal: 8 },
		});
	});
});
