/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { Event } from '../../../../base/common/event.js';
import * as path from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IAdeCloudHost, IAdeCloudHostBackendService } from '../../common/adeCloudHosts.js';
import { ADE_EFFORT_LEVELS, isAdeEffortLevel } from '../../common/adeModels.js';
import { AdeControlCenterService } from '../../node/adeControlCenterService.js';
import {
	AdeEngineProbeService,
	foldAntigravityTierSuffix,
	parseAntigravityModelsFromSources,
	parseClaudeModelsFromSettings,
	parseClineModelsFromSources,
	parseCodexModelsFromSources,
	parseDshModelsFromSources,
	parseKiloModelsFromSources,
	parseOpenCodeModelsFromSources,
	parsePiModelsFromSources,
} from '../../node/adeEngineProbeService.js';

function execLocalSh(script: string, envHome: string): Promise<{ readonly exitCode: number; readonly outputTail: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn('/bin/sh', ['-c', script], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, HOME: envHome },
		});
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		let out = '';
		child.stdout.on('data', (c: string) => { out += c; });
		child.stderr.on('data', (c: string) => { out += c; });
		child.once('error', reject);
		child.once('close', code => resolve({ exitCode: code ?? 1, outputTail: out }));
	});
}

suite('Track B1: AdeEngineProbeService Real 8-Engine Model & Effort Probing, Singleflight Cache & Pure Dynamic Vendor Catalog', function () {
	ensureNoDisposablesAreLeakedInTestSuite();

	let tempDir: string;

	setup(async () => {
		const baseTmp = isWindows ? os.tmpdir() : '/tmp';
		tempDir = await fs.promises.mkdtemp(path.join(baseTmp, 'ade-probe-b1-'));
	});

	teardown(async () => {
		if (tempDir) {
			await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	test('1. collectLocalBinSearchDirs orders nvm descending, includes ~/.gemini/bin & App dsh, prepends env.PATH, and injects http.proxy when unset', async () => {
		const fakeHome = path.join(tempDir, 'home-bins');
		await fs.promises.mkdir(path.join(fakeHome, '.nvm', 'versions', 'node', 'v20.11.0', 'bin'), { recursive: true });
		await fs.promises.mkdir(path.join(fakeHome, '.nvm', 'versions', 'node', 'v24.2.0', 'bin'), { recursive: true });
		await fs.promises.mkdir(path.join(fakeHome, '.nvm', 'versions', 'node', 'v22.9.1', 'bin'), { recursive: true });
		await fs.promises.mkdir(path.join(fakeHome, '.aexus-code'), { recursive: true });
		await fs.promises.writeFile(
			path.join(fakeHome, '.aexus-code', 'settings.json'),
			'// JSONC comment\n{\n  "http.proxy": "http://127.0.0.1:7890",\n}\n',
			'utf8',
		);

		const prober = new AdeEngineProbeService({ homedir: fakeHome });
		const dirs = await prober.collectLocalBinSearchDirs();

		assert.strictEqual(dirs.includes(path.join(fakeHome, '.gemini', 'bin')), true);
		assert.strictEqual(dirs.includes(path.join(fakeHome, '.local', 'node-current', 'bin')), true);
		assert.strictEqual(dirs.includes(path.join(fakeHome, '.bun', 'bin')), true);
		assert.strictEqual(dirs.includes(path.join(fakeHome, '.volta', 'bin')), true);
		assert.strictEqual(dirs.includes(path.join(fakeHome, '.npm-global', 'bin')), true);
		if (!isWindows) {
			assert.strictEqual(dirs.includes('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin'), true);
		}

		const idx24 = dirs.indexOf(path.join(fakeHome, '.nvm', 'versions', 'node', 'v24.2.0', 'bin'));
		const idx22 = dirs.indexOf(path.join(fakeHome, '.nvm', 'versions', 'node', 'v22.9.1', 'bin'));
		const idx20 = dirs.indexOf(path.join(fakeHome, '.nvm', 'versions', 'node', 'v20.11.0', 'bin'));
		assert.strictEqual(idx24 >= 0 && idx24 < idx22 && idx22 < idx20, true, 'nvm node bin directories must be sorted in descending semver order');

		const savedHttp = process.env.HTTP_PROXY;
		const savedHttps = process.env.HTTPS_PROXY;
		const savedAll = process.env.ALL_PROXY;
		const savedLowerHttp = process.env.http_proxy;
		const savedLowerHttps = process.env.https_proxy;
		const savedLowerAll = process.env.all_proxy;
		const savedNoProxy = process.env.NO_PROXY;
		const savedLowerNoProxy = process.env.no_proxy;
		try {
			delete process.env.HTTP_PROXY;
			delete process.env.HTTPS_PROXY;
			delete process.env.ALL_PROXY;
			delete process.env.http_proxy;
			delete process.env.https_proxy;
			delete process.env.all_proxy;
			delete process.env.NO_PROXY;
			delete process.env.no_proxy;

			const subEnv = await prober.buildSubprocessEnv();
			const pathVal = subEnv.PATH ?? subEnv.Path ?? '';
			assert.strictEqual(pathVal.startsWith(path.join(fakeHome, '.gemini', 'bin')), true);
			assert.strictEqual(subEnv.HTTP_PROXY, 'http://127.0.0.1:7890');
			assert.strictEqual(subEnv.HTTPS_PROXY, 'http://127.0.0.1:7890');
			assert.strictEqual(subEnv.ALL_PROXY, 'http://127.0.0.1:7890');
			assert.strictEqual(subEnv.NO_PROXY, '127.0.0.1,localhost,::1');
			assert.strictEqual(subEnv.no_proxy, '127.0.0.1,localhost,::1');

			process.env.NO_PROXY = '10.0.0.0/8, LocalHost ';
			process.env.no_proxy = '::1,corp.internal';
			const mergedEnv = await prober.buildSubprocessEnv();
			assert.strictEqual(mergedEnv.NO_PROXY, '10.0.0.0/8,LocalHost,::1,corp.internal,127.0.0.1');
			assert.strictEqual(mergedEnv.no_proxy, '10.0.0.0/8,LocalHost,::1,corp.internal,127.0.0.1');
		} finally {
			if (savedHttp !== undefined) { process.env.HTTP_PROXY = savedHttp; } else { delete process.env.HTTP_PROXY; }
			if (savedHttps !== undefined) { process.env.HTTPS_PROXY = savedHttps; } else { delete process.env.HTTPS_PROXY; }
			if (savedAll !== undefined) { process.env.ALL_PROXY = savedAll; } else { delete process.env.ALL_PROXY; }
			if (savedLowerHttp !== undefined) { process.env.http_proxy = savedLowerHttp; } else { delete process.env.http_proxy; }
			if (savedLowerHttps !== undefined) { process.env.https_proxy = savedLowerHttps; } else { delete process.env.https_proxy; }
			if (savedLowerAll !== undefined) { process.env.all_proxy = savedLowerAll; } else { delete process.env.all_proxy; }
			if (savedNoProxy !== undefined) { process.env.NO_PROXY = savedNoProxy; } else { delete process.env.NO_PROXY; }
			if (savedLowerNoProxy !== undefined) { process.env.no_proxy = savedLowerNoProxy; } else { delete process.env.no_proxy; }
		}
	});

	test('2. Claude replaceBuiltInOptions === true strictly excludes claude-sonnet-4-6 & built-ins while promoting top-level model first', () => {
		const customJsonc = `
		{
			// Custom proxy gateway config with trailing commas
			"model": "deepseek-flash[1m]",
			"env": {
				"ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-flash",
				"ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-flash[1m]",
				"ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-flash[1m]",
				"ANTHROPIC_DEFAULT_FABLE_MODEL": "deepseek-flash[1m]",
				"ANTHROPIC_CUSTOM_MODEL_OPTION": "Qwen3.8-Flash-Next-Uncensored-Q5_K_M",
			},
			"modelPicker": {
				"replaceBuiltInOptions": true,
				"options": [
					{ "model": "gpt-6.1-sol", "label": "GPT-6.1 Sol" },
					{ "value": "deepseek-v4-pro[1m]", "label": "DeepSeek Pro" },
					{ "model": "deepseek-flash[1m]", "label": "DeepSeek Flash" },
				],
			},
			"modelSettings": {
				"deepseek-flash": { "effortLevel": "medium" },
				"deepseek-v4-pro": { "effortLevel": "high" },
			},
		}`;
		const replaced = parseClaudeModelsFromSettings(customJsonc);
		assert.strictEqual(replaced.replaceBuiltInOptions, true);
		assert.strictEqual(replaced.models[0], 'deepseek-flash[1m]');
		assert.strictEqual(replaced.models.includes('claude-sonnet-4-6'), false, 'Must NEVER mix claude-sonnet-4-6 when replaceBuiltInOptions === true');
		assert.strictEqual(replaced.models.includes('sonnet'), false);
		assert.strictEqual(replaced.models.includes('gpt-6.1-sol'), true);
		assert.strictEqual(replaced.models.includes('deepseek-v4-pro[1m]'), true);
		assert.strictEqual(replaced.models.includes('Qwen3.8-Flash-Next-Uncensored-Q5_K_M'), true);

		const additive = parseClaudeModelsFromSettings(JSON.stringify({
			model: 'custom-gateway-sonnet',
			modelPicker: { replaceBuiltInOptions: false, options: [{ value: 'custom-gateway-sonnet' }] },
		}));
		assert.strictEqual(additive.models[0], 'custom-gateway-sonnet');
		assert.strictEqual(additive.models.includes('claude-sonnet-4-6'), true);
		assert.strictEqual(additive.models.includes('opus'), true);
	});

	test('3. Codex, Kilo, OpenCode, Pi (models.json + models-store.json), Antigravity, DSH & Cline parsers extract real models and exact effort sets', () => {
		const codexRes = parseCodexModelsFromSources({
			configToml: `model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n\n[profiles.fast]\nmodel = "gpt-5.5"\n`,
			modelsCacheJson: JSON.stringify({
				models: [
					{ slug: 'gpt-reserve', visibility: 'hide' },
					{ slug: 'gpt-6-luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'xhigh' }] },
				],
			}),
			appServerListData: [
				{ id: 'gpt-6.1-sol', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] },
				{ id: 'codex-auto-review', hidden: true },
			],
		});
		assert.deepStrictEqual(codexRes.models, ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.5']);
		assert.strictEqual(codexRes.models.includes('gpt-reserve'), false);
		assert.strictEqual(codexRes.models.includes('codex-auto-review'), false);
		assert.deepStrictEqual(codexRes.efforts, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
		assert.strictEqual(codexRes.defaultEffort, 'high');

		const kiloModels = parseKiloModelsFromSources(
			[`{ "model": "deepseek-official/deepseek-flash", "provider": { "deepseek-official": { "models": { "deepseek-v4-pro": {} } } } }`],
			'\x1b[32mdeepseek-official/deepseek-v4-pro\x1b[0m\ndeepseek-official/deepseek-flash\n',
		);
		assert.deepStrictEqual(kiloModels, ['deepseek-official/deepseek-flash', 'deepseek-official/deepseek-v4-pro']);

		const ocModels = parseOpenCodeModelsFromSources(
			[`{ "model": "group-openai/gpt-6", "small_model": "group-openai/gpt-5.6-luna" }`],
			'group-openai/gpt-5.2\ngroup-openai/gpt-6\n',
		);
		assert.strictEqual(ocModels[0], 'group-openai/gpt-6');
		assert.strictEqual(ocModels.includes('group-openai/gpt-5.6-luna'), true);

		const piModels = parsePiModelsFromSources({
			settingsJson: JSON.stringify({ defaultProvider: 'group-openai', defaultModel: 'gpt-6' }),
			modelsJson: JSON.stringify({ providers: { 'group-openai': { models: [{ id: 'gpt-5.2' }, { id: 'gpt-6' }] } } }),
			modelsStoreJson: JSON.stringify({
				deepseek: { models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] },
				anthropic: { models: [{ id: 'claude-sonnet-4-6' }] },
			}),
			listModelsCliOutput: 'provider  model  context\ngroup-openai  gpt-6.1-sol  400K\n',
		});
		assert.deepStrictEqual(piModels, [
			'group-openai/gpt-6',
			'group-openai/gpt-6.1-sol',
			'group-openai/gpt-5.2',
			'deepseek/deepseek-flash',
			'deepseek/deepseek-v4-pro',
			'anthropic/claude-sonnet-4-6',
		]);

		assert.strictEqual(foldAntigravityTierSuffix('gemini-4-neon-xhigh'), 'gemini-4-neon');
		assert.strictEqual(foldAntigravityTierSuffix('gemini-pro-orchestrator-neon'), 'gemini-pro-orchestrator-neon');
		const agyModels = parseAntigravityModelsFromSources(
			[
				'gemini-4-neon-high\tGemini 4 Neon (High)',
				'gemini-4-neon-low\tGemini 4 Neon (Low)',
				'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
				'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
				'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
			].join('\n'),
		);
		assert.deepStrictEqual(agyModels, [
			'gemini-4-neon',
			'gemini-pro-orchestrator-neon',
			'claude-opus-5-5',
			'gpt-oss-120b',
		]);

		const dshModels = parseDshModelsFromSources({
			yamlTexts: ['- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n'],
			acpSessionNewResult: {
				configOptions: [{
					id: 'model',
					currentValue: '["deepseek-official","deepseek-v4-flash"]',
					options: [{
						group: 'deepseek-official',
						options: [
							{ value: '["deepseek-official","deepseek-v4-flash"]' },
							{ value: '["deepseek-official","deepseek-v4-pro"]' },
						],
					}],
				}],
			},
		});
		assert.deepStrictEqual(dshModels, [
			'deepseek-flash',
			'deepseek-v4-flash',
			'deepseek-v4-pro',
			'deepseek-chat',
			'deepseek-reasoner',
		]);

		const clineModels = parseClineModelsFromSources({
			globalStateJsons: [JSON.stringify({ actModeApiModelId: 'deepseek-v4-pro', actModeOpenAiModelId: 'deepseek-v4-flash' })],
			providersJson: JSON.stringify({ lastUsedProvider: 'deepseek', providers: { sapaicore: { settings: { model: 'anthropic--claude-3.5-sonnet' } } } }),
			modelsJson: JSON.stringify({ providers: { deepseek: { models: { 'deepseek-flash': { id: 'deepseek-flash' } } } } }),
		});
		assert.deepStrictEqual(clineModels, [
			'deepseek-v4-pro',
			'deepseek-v4-flash',
			'anthropic--claude-3.5-sonnet',
			'deepseek-flash',
		]);
	});

	test('4. Singleflight + 30s TTL cache coalesces concurrent remote SSH probeModels calls and enforces effort sets', async function () {
		if (isWindows) {
			this.skip();
		}
		const remoteHome = path.join(tempDir, 'remote-ssh-home');
		await fs.promises.mkdir(path.join(remoteHome, '.claude'), { recursive: true });
		await fs.promises.mkdir(path.join(remoteHome, '.pi', 'agent'), { recursive: true });
		await fs.promises.mkdir(path.join(remoteHome, '.gemini', 'bin'), { recursive: true });

		const agyStub = path.join(remoteHome, '.gemini', 'bin', 'agy');
		await fs.promises.writeFile(
			agyStub,
			'#!/bin/sh\nif [ "$1" = "models" ]; then printf "gemini-4-neon-high\\tNeon\\ngemini-4-argon-low\\tArgon\\n"; fi\n',
			{ mode: 0o755 },
		);
		await fs.promises.writeFile(
			path.join(remoteHome, '.claude', 'settings.json'),
			JSON.stringify({
				model: 'deepseek-flash[1m]',
				modelPicker: { replaceBuiltInOptions: true, options: [{ model: 'deepseek-flash[1m]' }, { model: 'gpt-6.1-sol' }] },
			}),
			'utf8',
		);
		await fs.promises.writeFile(
			path.join(remoteHome, '.pi', 'agent', 'models-store.json'),
			JSON.stringify({ deepseek: { models: [{ id: 'deepseek-flash' }] } }),
			'utf8',
		);

		let sshCalls = 0;
		const mockCloud: Partial<IAdeCloudHostBackendService> & {
			remoteExecCommand: (alias: string, opts: { command: string }) => Promise<{ exitCode: number; outputTail: string }>;
		} = {
			onDidChangeHosts: Event.None,
			listHosts: async (): Promise<IAdeCloudHost[]> => [{
				id: 'h_rem', name: 'RemoteBox', alias: 'rem-box', hostName: '10.99.0.1', port: 22,
				os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
			}],
			remoteExecCommand: async (_alias, opts) => {
				sshCalls++;
				await new Promise<void>(r => setTimeout(r, 20));
				return execLocalSh(opts.command, remoteHome);
			},
		};

		const prober = new AdeEngineProbeService({
			cloudHostService: mockCloud as unknown as IAdeCloudHostBackendService,
			modelCacheTtlMs: 30_000,
		});

		const remoteEngines = await prober.probeEngines('rem-box');
		assert.strictEqual(remoteEngines.includes('antigravity'), true, 'Remote ~/.gemini/bin/agy must be detected');

		sshCalls = 0;
		const [c1, c2, c3, c4] = await Promise.all([
			prober.probeModels('rem-box', 'claude'),
			prober.probeModels('10.99.0.1', 'claude'),
			prober.probeModels('rem-box', 'claude'),
			prober.probeModels('10.99.0.1', 'claude'),
		]);
		assert.strictEqual(sshCalls, 1, 'Concurrent alias/IP probeModels must coalesce via singleflight & 30s cache');
		assert.deepStrictEqual(c1.models, ['deepseek-flash[1m]', 'gpt-6.1-sol']);
		assert.deepStrictEqual(c2.models, c1.models);
		assert.deepStrictEqual(c3.models, c1.models);
		assert.deepStrictEqual(c4.models, c1.models);
		assert.deepStrictEqual(c1.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);

		// Cached follow-up within 30s hits memory cache with 0 SSH calls
		await prober.probeModels('rem-box', 'claude');
		assert.strictEqual(sshCalls, 1);

		const remoteAgy = await prober.probeModels('rem-box', 'antigravity');
		assert.deepStrictEqual(remoteAgy.models, ['gemini-4-neon', 'gemini-4-argon']);
		assert.deepStrictEqual(remoteAgy.efforts, ['low', 'medium', 'high', 'xhigh']);

		const remotePi = await prober.probeModels('rem-box', 'pi');
		assert.deepStrictEqual(remotePi.models, ['deepseek/deepseek-flash']);
		assert.deepStrictEqual(remotePi.efforts, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
	});

	test('5. AdeEffortLevel covers all 10 tiers and AdeControlCenterService auto-falls back unsupported effort on engine switch', async () => {
		for (const tier of ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max', 'ultra']) {
			assert.strictEqual(isAdeEffortLevel(tier), true);
			assert.strictEqual((ADE_EFFORT_LEVELS as readonly string[]).includes(tier), true);
		}
		assert.strictEqual(isAdeEffortLevel('extreme'), false);

		const wsDir = path.join(tempDir, 'ws-cc');
		await fs.promises.mkdir(wsDir, { recursive: true });
		const svc = new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'cc-home'),
			socketPath: path.join(tempDir, 'cc.sock'),
			persistIdempotencyLedger: false,
			customLocalEngineProber: async () => ['claude', 'kilo', 'opencode', 'codex'],
		});
		try {
			await svc.whenReady();
			const proj = await svc.createProject({ folderUri: URI.file(wsDir).toString(), name: 'B1EffortProj' });
			const l1 = await svc.uiCreateAgent({
				projectId: proj.meta.project_id,
				parentId: null,
				level: 1,
				name: 'L1',
				roleSummary: 'Lead',
				host: 'local',
				engine: 'opencode',
				model: 'group-openai/gpt-6',
				effort: 'extra-high',
			});
			assert.strictEqual(l1.effort, 'extra-high');

			// Switch opencode(extra-high) -> kilo without explicit effort -> falls back to kilo default ('high')
			const rebound = await svc.uiEditAgent({
				projectId: proj.meta.project_id,
				agentId: l1.agent_id,
				engine: 'kilo',
				model: 'deepseek-official/deepseek-flash',
			});
			assert.strictEqual(rebound.engine, 'kilo');
			assert.strictEqual(rebound.effort, 'high');
		} finally {
			await svc.gracefulShutdown();
		}
	});
});
