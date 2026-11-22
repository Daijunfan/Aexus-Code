/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliCommand, runCli, type IAdeControlWireRequest } from '../src/adeCli.ts';
import {
	buildOptionGroupsForSession,
	discoverEngineModels,
	discoverSlashCommands,
	discoverCustomizationFiles,
	parseAgyModelsOutput,
	readSkillOrCommandTemplate,
} from '../src/capabilities.ts';

const ENGINE_IDS = [
	'aexus-claude',
	'aexus-codex',
	'aexus-kilo',
	'aexus-opencode',
	'aexus-dsh',
	'aexus-antigravity',
	'aexus-cline',
	'aexus-pi',
];

const SECRETARY_MACROS = ['status', 'projects', 'sessions', 'mission', 'inbox', 'focus', 'home', 'new', 'engine', 'reset'];

const ENGINE_SIGNATURE_COMMANDS = {
	'aexus-claude': ['security-review', 'agents', 'memory'],
	'aexus-codex': ['sandbox', 'search', 'fork'],
	'aexus-kilo': ['summarize', 'undo', 'share'],
	'aexus-opencode': ['agent', 'undo', 'share'],
	'aexus-dsh': ['feedback', 'mode', 'permissions'],
	'aexus-antigravity': ['grill-me', 'teamwork', 'browser'],
	'aexus-cline': ['newtask', 'deep-planning', 'smol'],
	'aexus-pi': ['tree', 'stats', 'reload'],
};

const ENGINE_SPECIFIC_GROUPS = {
	'aexus-claude': ['permissions'],
	'aexus-codex': ['permissions', 'sandbox', 'webSearch'],
	'aexus-kilo': ['mode', 'permissions'],
	'aexus-opencode': ['mode', 'permissions'],
	'aexus-dsh': ['permissions'],
	'aexus-antigravity': ['mode'],
	'aexus-cline': ['mode'],
	'aexus-pi': ['mode', 'permissions'],
};

// The highest-permission default for each engine, keyed by option group.
const HIGHEST_PERMISSION_DEFAULTS = {
	secretary: { permissions: 'bypassPermissions' },
	'aexus-claude': { permissions: 'bypassPermissions' },
	'aexus-codex': { permissions: 'never', sandbox: 'danger-full-access' },
	'aexus-kilo': { permissions: 'bypassPermissions' },
	'aexus-opencode': { permissions: 'bypassPermissions' },
	'aexus-dsh': { permissions: 'danger-full-access' },
	'aexus-antigravity': { mode: 'auto' },
	'aexus-cline': { mode: 'yolo' },
	'aexus-pi': { permissions: 'bypassPermissions' },
};

const LEGACY_DEFAULT_STATE = { permissionMode: 'default', sandboxMode: 'default', mode: 'default' };

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(TEST_DIR, '..');
const PACKAGE_JSON_PATH = path.join(EXTENSION_ROOT, 'package.json');

// Isolate home-directory discovery so a developer's real config cannot affect results.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aexus-capabilities-'));
const workspace = path.join(testRoot, 'workspace');
const isolatedHome = path.join(testRoot, 'home');
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(isolatedHome, { recursive: true });
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

function writeWorkspaceFile(relativePath: string, content: string): string {
	const filePath = path.join(workspace, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	return filePath;
}

// Each discovery case gets a fresh directory so cached reads cannot leak between tests.
function createCaseDir(name: string): string {
	return fs.mkdtempSync(path.join(testRoot, `${name}-`));
}

function writeCaseFile(cwd: string, relativePath: string, content: string): void {
	const filePath = path.join(cwd, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

const skillFilePath = writeWorkspaceFile('.claude/skills/my-skill/SKILL.md', [
	'---',
	'name: my-skill',
	'description: My local skill description',
	'argument-hint: "[topic]"',
	'---',
	'# My Skill',
	'',
	'Do the thing with care.',
	'',
].join('\n'));

const deployFilePath = writeWorkspaceFile('.claude/commands/deploy.md', [
	'---',
	'description: Deploy the current project',
	'argument-hint: "[environment]"',
	'---',
	'Deploy the current project to $ARGUMENTS.',
	'',
	'Verify the deployment afterwards.',
	'',
].join('\n'));

const auditFilePath = writeWorkspaceFile('.clinerules/workflows/audit.md', [
	'---',
	'description: Audit the codebase for issues',
	'---',
	'Audit the codebase thoroughly.',
	'',
].join('\n'));

const sharedSkillFilePath = writeWorkspaceFile('.agents/skills/shared-skill/SKILL.md', [
	'---',
	'description: Shared skill for every engine',
	'---',
	'Shared skill body.',
	'',
].join('\n'));

const reviewerFilePath = writeWorkspaceFile('.claude/agents/reviewer.md', [
	'---',
	'name: reviewer',
	'description: Reviews changes for correctness',
	'---',
	'Review the changes.',
	'',
].join('\n'));

const agentsInstructionFilePath = writeWorkspaceFile('AGENTS.md', [
	'# Project Instructions',
	'',
	'Use tabs.',
	'',
].join('\n'));

const hookFilePath = writeWorkspaceFile('.claude/hooks/pre-commit.sh', '#!/bin/sh\nexit 0\n');

const pluginManifestPath = writeWorkspaceFile('.claude/plugins/demo/plugin.json', JSON.stringify({
	name: 'demo-plugin',
	description: 'A demo plugin',
}));

// Templates used only by readSkillOrCommandTemplate; they live outside every scanned root.
const emptyTemplatePath = writeWorkspaceFile('empty-template.md', '---\ndescription: Empty template\n---\n\n');
const repeatTemplatePath = writeWorkspaceFile('repeat-template.md', 'Use $ARGUMENTS, then $ARGUMENTS again.\n');

after(() => {
	if (previousHome.HOME === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = previousHome.HOME;
	}
	if (previousHome.USERPROFILE === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = previousHome.USERPROFILE;
	}
	fs.rmSync(testRoot, { recursive: true, force: true });
});

function groupById(groups, id) {
	return groups.find(group => group.id === id);
}

function itemIds(group) {
	return group.items.map(item => item.id);
}

function findCommand(commands, name) {
	return commands.find(command => command.name.toLowerCase() === name.toLowerCase());
}

describe('discoverEngineModels', () => {

	test('Claude Code replaceBuiltInOptions drops built-in aliases but keeps picker models', async () => {
		const cwd = createCaseDir('claude-replace');
		writeCaseFile(cwd, '.claude/settings.json', JSON.stringify({
			modelPicker: {
				replaceBuiltInOptions: true,
				options: [
					{ model: 'claude-custom-sonnet', label: 'Custom Sonnet', description: 'Team model' },
					{ model: 'claude-custom-opus', label: 'Custom Opus' },
				],
			},
		}));

		const models = await discoverEngineModels('aexus-claude', cwd);
		const ids = models.map(model => model.id);

		assert.deepEqual(ids, ['default', 'claude-custom-sonnet', 'claude-custom-opus']);
		assert.deepEqual(models[1], {
			id: 'claude-custom-sonnet',
			name: 'Custom Sonnet',
			description: 'claude-custom-sonnet · Team model',
		});
		assert.equal(models[2].name, 'Custom Opus');
		assert.equal(models[0].name, 'Default (Engine Config)');
		for (const alias of ['sonnet', 'opus', 'haiku']) {
			assert.ok(!ids.includes(alias), `${alias} should be replaced`);
		}
	});

	test('Codex discovers models_cache.json entries by slug and display_name', async () => {
		const cwd = createCaseDir('codex-cache');
		writeCaseFile(cwd, '.codex/models_cache.json', JSON.stringify({
			models: [
				{ slug: 'gpt-5', display_name: 'GPT-5', description: 'Fast frontier model' },
				{ slug: 'o3', display_name: 'o3' },
			],
		}));

		const models = await discoverEngineModels('aexus-codex', cwd);

		assert.deepEqual(models, [
			{ id: 'default', name: 'Default (Engine Config)', description: 'Use engine default model from config', default: true },
			{ id: 'gpt-5', name: 'GPT-5', description: 'gpt-5 · Fast frontier model' },
			{ id: 'o3', name: 'o3', description: undefined },
		]);
	});

	test('Kilo and OpenCode expose provider models with human-readable names', async () => {
		const kiloCwd = createCaseDir('kilo-models');
		writeCaseFile(kiloCwd, '.kilo/kilo.jsonc', `{
			"model": "anthropic/claude-sonnet-4-5",
			"provider": {
				"anthropic": {
					"models": {
						"claude-sonnet-4-5": {},
						"claude-opus-4-5": { "name": "Claude Opus 4.5" }
					}
				}
			}
		}`);

		const kiloModels = await discoverEngineModels('aexus-kilo', kiloCwd);
		assert.equal(kiloModels[0].name, 'Default (anthropic/claude-sonnet-4-5)');
		assert.deepEqual(kiloModels.find(model => model.id === 'anthropic/claude-opus-4-5'), {
			id: 'anthropic/claude-opus-4-5',
			name: 'Claude Opus 4.5',
			description: 'anthropic/claude-opus-4-5',
		});
		assert.equal(kiloModels.filter(model => model.id === 'anthropic/claude-sonnet-4-5').length, 1);

		const openCodeCwd = createCaseDir('opencode-models');
		writeCaseFile(openCodeCwd, 'opencode.json', JSON.stringify({
			model: 'openai/gpt-5',
			small_model: 'openai/gpt-5-mini',
			provider: {
				openai: {
					models: {
						'gpt-5': { name: 'GPT-5' },
						'o3': { name: 'o3' },
					},
				},
			},
		}));

		const openCodeModels = await discoverEngineModels('aexus-opencode', openCodeCwd);
		assert.equal(openCodeModels[0].name, 'Default (openai/gpt-5)');
		assert.equal(openCodeModels.find(model => model.id === 'openai/gpt-5-mini').name, 'openai/gpt-5-mini (Small)');
		assert.deepEqual(openCodeModels.find(model => model.id === 'openai/o3'), {
			id: 'openai/o3',
			name: 'o3',
			description: 'openai/o3',
		});
	});

	test('Pi discovers provider/model IDs from models.json', async () => {
		const cwd = createCaseDir('pi-models');
		writeCaseFile(cwd, '.pi/models.json', JSON.stringify({
			providers: {
				openai: {
					models: ['gpt-5', { id: 'o4-mini', name: 'O4 Mini' }, { id: 'openai/gpt-5-mini' }],
				},
			},
		}));

		const models = await discoverEngineModels('aexus-pi', cwd);

		assert.deepEqual(models.map(model => [model.id, model.name]), [
			['default', 'Default (Engine Config)'],
			['openai/gpt-5', 'openai/gpt-5'],
			['openai/o4-mini', 'O4 Mini (openai)'],
			['openai/gpt-5-mini', 'openai/gpt-5-mini'],
		]);
		assert.equal(models.find(model => model.id === 'openai/o4-mini').description, 'openai/o4-mini');
	});

	test('DeepSeek Harness reads cordis.patch.yml into provider/model tuple IDs', async () => {
		const cwd = createCaseDir('dsh-yaml');
		writeCaseFile(cwd, '.dsh/cordis.patch.yml', [
			'# DeepSeek Harness configuration',
			'provider: deepseek-official',
			'model: deepseek-reasoner',
			'',
		].join('\n'));

		const models = await discoverEngineModels('aexus-dsh', cwd);

		assert.deepEqual(models[0], {
			id: 'default',
			name: 'Default (deepseek-reasoner)',
			description: 'Use engine default model from config (resolved: deepseek-reasoner)',
			default: true,
		});
		assert.deepEqual(models[1], {
			id: '["deepseek-official","deepseek-reasoner"]',
			name: 'deepseek-reasoner',
			description: 'deepseek-official/deepseek-reasoner',
		});
		assert.equal(models.filter(model => model.id === '["deepseek-official","deepseek-reasoner"]').length, 1);
		assert.deepEqual(models.slice(2).map(model => model.id), [
			'["deepseek-official","deepseek-chat"]',
		]);
	});

	test('Cline discovers models.json and providers.json settings', async () => {
		const cwd = createCaseDir('cline-models');
		writeCaseFile(cwd, '.cline/settings/models.json', JSON.stringify({
			providers: {
				deepseek: {
					provider: { defaultModelId: 'deepseek-reasoner' },
					models: {
						'deepseek-reasoner': { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
						'deepseek-chat': { id: 'deepseek-chat', name: 'DeepSeek Chat' },
					},
				},
			},
		}));
		writeCaseFile(cwd, '.cline/settings/providers.json', JSON.stringify({
			lastUsedProvider: 'anthropic',
			providers: {
				anthropic: { settings: { model: 'claude-sonnet-4-5' } },
				openai: { settings: { model: 'gpt-5' } },
			},
		}));

		const models = await discoverEngineModels('aexus-cline', cwd);

		// providers.json is the highest-priority source for the resolved default.
		assert.equal(models[0].name, 'Default (claude-sonnet-4-5)');
		assert.deepEqual(models.find(model => model.id === 'deepseek-reasoner'), {
			id: 'deepseek-reasoner',
			name: 'DeepSeek Reasoner',
			description: 'deepseek · deepseek-reasoner',
		});
		assert.deepEqual(models.find(model => model.id === 'claude-sonnet-4-5'), {
			id: 'claude-sonnet-4-5',
			name: 'claude-sonnet-4-5',
			description: 'anthropic · claude-sonnet-4-5',
		});
		assert.deepEqual(models.find(model => model.id === 'gpt-5'), {
			id: 'gpt-5',
			name: 'gpt-5',
			description: 'openai · gpt-5',
		});
	});

	test('Antigravity reflects a runtime default model in the Default label', async () => {
		const cwd = createCaseDir('antigravity-default');

		const models = await discoverEngineModels('aexus-antigravity', cwd, [], 'gemini-2.5-pro');
		assert.equal(models[0].id, 'default');
		assert.equal(models[0].name, 'Default (gemini-2.5-pro)');
		assert.equal(models[0].description, 'Use engine default model from config (resolved: gemini-2.5-pro)');
		assert.ok(models.some(model => model.id === 'gemini-2.5-pro'));

		const groups = await buildOptionGroupsForSession('aexus-antigravity', {}, cwd, { defaultModel: 'gemini-2.5-pro' });
		assert.equal(groupById(groups, 'model').items[0].name, 'Default (gemini-2.5-pro)');
	});

	test('built-in fallback model lists only expose real public shipping model IDs', async () => {
		const forbiddenPattern = /deepseek-flash|deepseek-v4|gpt-6|gpt-5\.6|gpt-5\.4|gemini-4|gemini-3\.8|pro-orchestrator|claude-(?:opus|sonnet)-5|luna|sol/i;
		const cleanCwd = createCaseDir('public-fallbacks');
		for (const engineId of ENGINE_IDS) {
			const models = await discoverEngineModels(engineId, cleanCwd);
			for (const item of models) {
				assert.doesNotMatch(item.id, forbiddenPattern, `${engineId} leaked private/unreleased model id: ${item.id}`);
				assert.doesNotMatch(item.name, forbiddenPattern, `${engineId} leaked private/unreleased model name: ${item.name}`);
			}
		}
		const claudeIds = (await discoverEngineModels('aexus-claude', cleanCwd)).map(m => m.id);
		assert.deepEqual(claudeIds, ['default', 'sonnet', 'opus', 'haiku', 'claude-sonnet-4-5', 'claude-opus-4-5']);
		const codexIds = (await discoverEngineModels('aexus-codex', cleanCwd)).map(m => m.id);
		assert.deepEqual(codexIds, ['default', 'gpt-5', 'gpt-5-mini', 'o3', 'o4-mini', 'codex-mini-latest']);
	});

	test('custom models do not suppress built-in fallback lists', async () => {
		const cleanCwd = createCaseDir('custom-fallbacks');
		const expectedFallbacks: Record<string, string[]> = {
			'aexus-antigravity': ['gemini-2.5-pro', 'gemini-2.5-flash', 'claude-sonnet-4-5'],
			'aexus-codex': ['gpt-5', 'gpt-5-mini', 'o3', 'o4-mini', 'codex-mini-latest'],
			'aexus-dsh': ['["deepseek-official","deepseek-reasoner"]', '["deepseek-official","deepseek-chat"]'],
			'aexus-pi': ['claude-sonnet-4-5', 'gpt-5', 'gemini-2.5-pro', 'deepseek-reasoner'],
			'aexus-cline': ['deepseek-reasoner', 'deepseek-chat', 'claude-sonnet-4-5', 'gpt-5', 'gemini-2.5-pro'],
		};

		for (const [engineId, fallbackIds] of Object.entries(expectedFallbacks)) {
			const models = await discoverEngineModels(engineId, cleanCwd, [], undefined, ['my-saved-custom']);
			const ids = models.map(model => model.id);
			for (const fallbackId of fallbackIds) {
				assert.ok(ids.includes(fallbackId), `${engineId} lost fallback model ${fallbackId}`);
			}
			assert.deepEqual(models[models.length - 1], {
				id: 'my-saved-custom',
				name: 'my-saved-custom',
				description: 'Custom model',
			}, `${engineId} should append real custom models at the tail`);
		}
	});

	test('custom models never overwrite the display name or description of configured models', async () => {
		const codexCwd = createCaseDir('custom-codex');
		writeCaseFile(codexCwd, '.codex/models_cache.json', JSON.stringify({
			models: [{ slug: 'gpt-5', display_name: 'GPT-5', description: 'Fast frontier model' }],
		}));

		const models = await discoverEngineModels('aexus-codex', codexCwd, [], undefined, ['gpt-5', 'my-saved-custom']);
		const configured = models.filter(model => model.id === 'gpt-5');

		assert.equal(configured.length, 1);
		assert.deepEqual(configured[0], {
			id: 'gpt-5',
			name: 'GPT-5',
			description: 'gpt-5 · Fast frontier model',
		});
		assert.deepEqual(models[models.length - 1], {
			id: 'my-saved-custom',
			name: 'my-saved-custom',
			description: 'Custom model',
		});
		assert.equal(models.filter(model => model.description === 'Custom model').length, 1);
	});

	test('Codex models_cache.json hides entries marked visibility "hide" or hidden: true', async () => {
		const cwd = createCaseDir('codex-visibility');
		writeCaseFile(cwd, '.codex/models_cache.json', JSON.stringify({
			models: [
				{ slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list' },
				{ slug: 'hidden-by-visibility', display_name: 'Hidden By Visibility', visibility: 'hide' },
				{ slug: 'hidden-by-visibility-alias', display_name: 'Hidden By Visibility Alias', visibility: 'hidden' },
				{ slug: 'hidden-by-flag', display_name: 'Hidden By Flag', hidden: true },
				{ slug: 'o3', display_name: 'o3', visibility: 'list' },
			],
		}));

		const ids = (await discoverEngineModels('aexus-codex', cwd)).map(model => model.id);

		assert.deepEqual(ids, ['default', 'gpt-5', 'o3']);
	});

	test('Kilo and OpenCode keep provider display names for default models, including array-form models', async () => {
		const kiloCwd = createCaseDir('kilo-default-name');
		writeCaseFile(kiloCwd, '.kilo/kilo.jsonc', JSON.stringify({
			model: 'anthropic/claude-sonnet-4-5',
			provider: {
				anthropic: {
					models: {
						'claude-sonnet-4-5': { name: 'Claude Sonnet 4.5' },
					},
				},
			},
		}));

		const kiloModels = await discoverEngineModels('aexus-kilo', kiloCwd);
		const kiloDefault = kiloModels.filter(model => model.id === 'anthropic/claude-sonnet-4-5');
		assert.equal(kiloDefault.length, 1);
		assert.deepEqual(kiloDefault[0], {
			id: 'anthropic/claude-sonnet-4-5',
			name: 'Claude Sonnet 4.5',
			description: 'anthropic/claude-sonnet-4-5',
		});

		const openCodeCwd = createCaseDir('opencode-array-models');
		writeCaseFile(openCodeCwd, 'opencode.json', JSON.stringify({
			model: 'openai/gpt-5',
			provider: {
				openai: {
					models: [
						{ id: 'gpt-5', name: 'GPT-5' },
						'o3',
					],
				},
			},
		}));

		const openCodeModels = await discoverEngineModels('aexus-opencode', openCodeCwd);
		const openCodeDefault = openCodeModels.filter(model => model.id === 'openai/gpt-5');
		assert.equal(openCodeDefault.length, 1);
		assert.deepEqual(openCodeDefault[0], {
			id: 'openai/gpt-5',
			name: 'GPT-5',
			description: 'openai/gpt-5',
		});
		assert.deepEqual(openCodeModels.find(model => model.id === 'openai/o3'), {
			id: 'openai/o3',
			name: 'openai/o3',
		});

		const openRouterCwd = createCaseDir('kilo-openrouter-nested-slash');
		writeCaseFile(openRouterCwd, '.kilo/kilo.jsonc', JSON.stringify({
			model: 'openrouter/anthropic/claude-sonnet-4-5',
			provider: {
				openrouter: {
					models: {
						'anthropic/claude-sonnet-4-5': { name: 'Claude Sonnet 4.5 (OR)' },
						'openrouter/openai/gpt-5': { name: 'GPT-5 (OR)' },
					},
				},
			},
		}));
		const orModels = await discoverEngineModels('aexus-kilo', openRouterCwd);
		assert.deepEqual(orModels.filter(m => m.id === 'openrouter/anthropic/claude-sonnet-4-5'), [{
			id: 'openrouter/anthropic/claude-sonnet-4-5',
			name: 'Claude Sonnet 4.5 (OR)',
			description: 'openrouter/anthropic/claude-sonnet-4-5',
		}]);
		assert.deepEqual(orModels.find(m => m.id === 'openrouter/openai/gpt-5'), {
			id: 'openrouter/openai/gpt-5',
			name: 'GPT-5 (OR)',
			description: 'openrouter/openai/gpt-5',
		});
	});

	test('parseAgyModelsOutput skips the header, blank lines, and duplicate IDs', () => {
		const output = [
			'Fetching available models...',
			'',
			'gemini-2.5-pro\tGemini 2.5 Pro',
			'gemini-2.5-flash\tGemini 2.5 Flash',
			'',
			'claude-sonnet-4-5\tClaude Sonnet 4.5',
			'gemini-2.5-pro\tGemini 2.5 Pro (duplicate)',
			'',
		].join('\n');

		assert.deepEqual(parseAgyModelsOutput(output), [
			{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
			{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
			{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
		]);
	});
});

describe('buildOptionGroupsForSession', () => {

	test('secretary starts with an engine picker listing all eight engines', async () => {
		const groups = await buildOptionGroupsForSession('secretary', {}, workspace);
		const engineGroup = groupById(groups, 'engine');

		assert.equal(groups[0].id, 'engine');
		assert.equal(engineGroup.name, 'Engine');
		assert.deepEqual(itemIds(engineGroup), ENGINE_IDS);
		assert.equal(engineGroup.selectedId, 'aexus-claude');
		assert.deepEqual(groups.map(group => group.id), ['engine', 'model', 'thinking', 'permissions']);
	});

	for (const engineId of ENGINE_IDS) {
		test(`${engineId} exposes model, thinking, and its unique groups`, async () => {
			const groups = await buildOptionGroupsForSession(engineId, {}, workspace);

			assert.deepEqual(groups.map(group => group.id), ['model', 'thinking', ...ENGINE_SPECIFIC_GROUPS[engineId]]);
			assert.equal(groupById(groups, 'engine'), undefined);
			assert.ok(groupById(groups, 'model').items.length >= 1);
			assert.ok(groupById(groups, 'thinking').items.some(item => item.id === 'default'));
		});
	}

	test('empty and legacy default state resolve to the highest-permission defaults', async () => {
		const states = [{}, LEGACY_DEFAULT_STATE];
		for (const state of states) {
			for (const targetKind of ['secretary', ...ENGINE_IDS]) {
				const groups = await buildOptionGroupsForSession(targetKind, state, workspace);
				for (const [groupId, selectedId] of Object.entries(HIGHEST_PERMISSION_DEFAULTS[targetKind])) {
					const group = groupById(groups, groupId);
					assert.ok(group, `${targetKind} is missing group ${groupId} for ${JSON.stringify(state)}`);
					assert.equal(group.selectedId, selectedId, `${targetKind}.${groupId} for ${JSON.stringify(state)}`);
				}
			}
		}
	});

	test('switching the secretary engine dynamically rebuilds model, thinking, and engine groups', async () => {
		const claudeGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-claude' }, workspace);
		assert.deepEqual(claudeGroups.map(group => group.id), ['engine', 'model', 'thinking', 'permissions']);
		assert.deepEqual(itemIds(groupById(claudeGroups, 'permissions')), ['bypassPermissions', 'auto', 'acceptEdits', 'plan', 'ask']);

		const codexGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-codex' }, workspace);
		assert.deepEqual(codexGroups.map(group => group.id), ['engine', 'model', 'thinking', 'permissions', 'sandbox', 'webSearch']);
		assert.equal(groupById(codexGroups, 'engine').selectedId, 'aexus-codex');
		assert.deepEqual(itemIds(groupById(codexGroups, 'permissions')), ['never', 'on-request', 'untrusted']);
		assert.deepEqual(itemIds(groupById(codexGroups, 'sandbox')), ['danger-full-access', 'workspace-write', 'read-only']);
		assert.deepEqual(itemIds(groupById(codexGroups, 'webSearch')), ['enabled', 'disabled']);
		assert.deepEqual(itemIds(groupById(codexGroups, 'thinking')), ['default', 'minimal', 'low', 'medium', 'high', 'xhigh']);

		const kiloGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-kilo' }, workspace);
		assert.deepEqual(kiloGroups.map(group => group.id), ['engine', 'model', 'thinking', 'mode', 'permissions']);
		assert.ok(itemIds(groupById(kiloGroups, 'mode')).includes('architect'));
		assert.ok(itemIds(groupById(kiloGroups, 'mode')).includes('orchestrator'));
		assert.deepEqual(itemIds(groupById(kiloGroups, 'permissions')), ['bypassPermissions', 'ask']);

		const openCodeGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-opencode' }, workspace);
		assert.deepEqual(openCodeGroups.map(group => group.id), ['engine', 'model', 'thinking', 'mode', 'permissions']);
		assert.equal(groupById(openCodeGroups, 'mode').name, 'Agent');
		assert.ok(itemIds(groupById(openCodeGroups, 'mode')).includes('build'));
		assert.ok(itemIds(groupById(openCodeGroups, 'mode')).includes('plan'));
		assert.deepEqual(itemIds(groupById(openCodeGroups, 'permissions')), ['bypassPermissions', 'ask']);

		const clineGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-cline' }, workspace);
		assert.deepEqual(clineGroups.map(group => group.id), ['engine', 'model', 'thinking', 'mode']);
		assert.deepEqual(itemIds(groupById(clineGroups, 'mode')), ['yolo', 'act', 'plan', 'ask']);

		const piGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-pi' }, workspace);
		assert.deepEqual(piGroups.map(group => group.id), ['engine', 'model', 'thinking', 'mode', 'permissions']);
		assert.deepEqual(itemIds(groupById(piGroups, 'mode')), ['full', 'readonly', 'chat']);
		assert.deepEqual(itemIds(groupById(piGroups, 'permissions')), ['bypassPermissions', 'ask']);

		const dshGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-dsh' }, workspace);
		assert.deepEqual(dshGroups.map(group => group.id), ['engine', 'model', 'thinking', 'permissions']);
		assert.deepEqual(itemIds(groupById(dshGroups, 'permissions')), ['danger-full-access', 'workspace-write', 'read-only', 'ask']);

		const antigravityGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-antigravity' }, workspace);
		assert.deepEqual(antigravityGroups.map(group => group.id), ['engine', 'model', 'thinking', 'mode']);
		assert.deepEqual(itemIds(groupById(antigravityGroups, 'mode')), ['auto', 'accept-edits', 'plan', 'ask']);
	});

	test('custom model IDs that are not defaults are preserved', async () => {
		for (const targetKind of ['secretary', ...ENGINE_IDS]) {
			const state = targetKind === 'secretary'
				? { secretaryEngineId: 'aexus-codex', model: 'custom-model-xyz' }
				: { model: 'custom-model-xyz' };
			const modelGroup = groupById(await buildOptionGroupsForSession(targetKind, state, workspace), 'model');

			assert.equal(modelGroup.selectedId, 'custom-model-xyz', targetKind);
			assert.deepEqual(
				modelGroup.items.filter(item => item.id === 'custom-model-xyz'),
				[{ id: 'custom-model-xyz', name: 'custom-model-xyz' }],
				targetKind,
			);
			assert.equal(modelGroup.items[1].id, 'custom-model-xyz', `${targetKind} keeps the custom model near the top`);
		}
	});

	test('custom mode, permission, sandbox, web search, and thinking IDs are preserved', async () => {
		const kiloGroups = await buildOptionGroupsForSession('aexus-kilo', { mode: 'my-custom-mode' }, workspace);
		const kiloMode = groupById(kiloGroups, 'mode');
		assert.equal(kiloMode.selectedId, 'my-custom-mode');
		assert.ok(itemIds(kiloMode).includes('my-custom-mode'));
		assert.equal(kiloMode.items.filter(item => item.id === 'my-custom-mode').length, 1);

		const openCodeGroups = await buildOptionGroupsForSession('aexus-opencode', { mode: 'my-opencode-agent' }, workspace);
		assert.equal(groupById(openCodeGroups, 'mode').selectedId, 'my-opencode-agent');

		const clineGroups = await buildOptionGroupsForSession('aexus-cline', { mode: 'my-cline-mode' }, workspace);
		assert.equal(groupById(clineGroups, 'mode').selectedId, 'my-cline-mode');

		const piGroups = await buildOptionGroupsForSession('aexus-pi', { mode: 'my-pi-tools' }, workspace);
		assert.equal(groupById(piGroups, 'mode').selectedId, 'my-pi-tools');

		const claudeGroups = await buildOptionGroupsForSession('aexus-claude', { permissionMode: 'bypassPermissions' }, workspace);
		assert.equal(groupById(claudeGroups, 'permissions').selectedId, 'bypassPermissions');

		const claudeCustomPermission = groupById(await buildOptionGroupsForSession('aexus-claude', { permissionMode: 'custom-permission' }, workspace), 'permissions');
		assert.equal(claudeCustomPermission.selectedId, 'custom-permission');
		assert.ok(itemIds(claudeCustomPermission).includes('custom-permission'));

		const codexGroups = await buildOptionGroupsForSession('aexus-codex', {
			permissionMode: 'custom-approval',
			sandboxMode: 'custom-sandbox',
			webSearch: 'disabled',
			thinking: 'ultra',
		}, workspace);
		assert.equal(groupById(codexGroups, 'permissions').selectedId, 'custom-approval');
		assert.equal(groupById(codexGroups, 'sandbox').selectedId, 'custom-sandbox');
		assert.ok(itemIds(groupById(codexGroups, 'sandbox')).includes('custom-sandbox'));
		assert.equal(groupById(codexGroups, 'webSearch').selectedId, 'disabled');
		assert.equal(groupById(codexGroups, 'thinking').selectedId, 'ultra');
		assert.ok(itemIds(groupById(codexGroups, 'thinking')).includes('ultra'));
	});

	test('runtime models and modes merge without replacing a custom selection', async () => {
		const runtimeExtras = {
			models: [
				{ id: 'runtime-model', name: 'Runtime Model', description: 'Discovered at runtime' },
				{ id: 'custom-model-xyz', name: 'Runtime Custom Model' },
			],
			modes: [
				{ id: 'runtime-mode', name: 'Runtime Mode', description: 'Discovered at runtime' },
				{ id: 'custom-mode', name: 'Runtime Custom Mode' },
			],
		};

		const codexGroups = await buildOptionGroupsForSession('aexus-codex', { model: 'custom-model-xyz' }, workspace, runtimeExtras);
		const modelGroup = groupById(codexGroups, 'model');
		assert.equal(modelGroup.selectedId, 'custom-model-xyz');
		assert.equal(modelGroup.items.filter(item => item.id === 'custom-model-xyz').length, 1);
		assert.ok(itemIds(modelGroup).includes('runtime-model'));

		const antigravityGroups = await buildOptionGroupsForSession('aexus-antigravity', { mode: 'custom-mode' }, workspace, runtimeExtras);
		const antigravityMode = groupById(antigravityGroups, 'mode');
		assert.equal(antigravityMode.selectedId, 'custom-mode');
		assert.ok(itemIds(antigravityMode).includes('runtime-mode'));
		assert.equal(antigravityMode.items.filter(item => item.id === 'custom-mode').length, 1);

		const dshGroups = await buildOptionGroupsForSession('aexus-dsh', {}, workspace, { modes: runtimeExtras.modes });
		assert.deepEqual(dshGroups.map(group => group.id), ['model', 'thinking', 'permissions', 'mode']);
		assert.equal(groupById(dshGroups, 'mode').selectedId, 'runtime-mode');
	});
});

describe('discoverSlashCommands', () => {

	test('goal is the first command for the secretary and every engine', async () => {
		const targets = [['secretary', 'aexus-claude'], ...ENGINE_IDS.map(engineId => [engineId, engineId])];
		for (const [targetKind, effectiveEngineId] of targets) {
			const commands = await discoverSlashCommands(targetKind, effectiveEngineId, workspace);
			assert.equal(commands[0].name, 'goal', targetKind);
			assert.equal(commands[0].source, 'builtin', targetKind);
			assert.equal(commands[0].kind, 'command', targetKind);
			assert.equal(commands.filter(command => command.name === 'goal').length, 1, targetKind);
		}
	});

	test('goal stays first even when runtime commands are supplied', async () => {
		const commands = await discoverSlashCommands('aexus-codex', 'aexus-codex', workspace, [
			{ name: 'runtime-command', description: 'Runtime command' },
		]);
		assert.equal(commands[0].name, 'goal');
		assert.equal(commands.filter(command => command.name === 'goal').length, 1);
		assert.equal(findCommand(commands, 'runtime-command').source, 'local');
	});

	for (const engineId of ENGINE_IDS) {
		test(`secretary merges its macros with ${engineId} commands`, async () => {
			const commands = await discoverSlashCommands('secretary', engineId, workspace);
			const names = commands.map(command => command.name);

			for (const macro of SECRETARY_MACROS) {
				assert.ok(names.includes(macro), `${engineId} is missing secretary macro ${macro}`);
				assert.equal(findCommand(commands, macro).kind, 'macro', `${macro} should stay a macro`);
			}
			for (const signature of ENGINE_SIGNATURE_COMMANDS[engineId]) {
				assert.ok(names.includes(signature), `${engineId} is missing engine command ${signature}`);
			}
			assert.ok(names.includes('goal'));
		});
	}

	test('secretary macro descriptions win over engine command duplicates', async () => {
		const codexSecretary = await discoverSlashCommands('secretary', 'aexus-codex', workspace);
		assert.deepEqual(findCommand(codexSecretary, 'status'), {
			name: 'status',
			description: 'Show secretary and agent status',
			source: 'builtin',
			kind: 'macro',
		});

		const piSecretary = await discoverSlashCommands('secretary', 'aexus-pi', workspace);
		assert.equal(findCommand(piSecretary, 'new').kind, 'macro');
		assert.equal(piSecretary.filter(command => command.name === 'new').length, 1);

		const piEngine = await discoverSlashCommands('aexus-pi', 'aexus-pi', workspace);
		assert.equal(findCommand(piEngine, 'new').kind, 'command');
	});

	test('discovers local skills, commands, and workflows with accurate metadata', async () => {
		const commands = await discoverSlashCommands('aexus-claude', 'aexus-claude', workspace);

		assert.deepEqual(findCommand(commands, 'my-skill'), {
			name: 'my-skill',
			description: 'My local skill description',
			argumentHint: '[topic]',
			source: 'local',
			kind: 'skill',
			filePath: skillFilePath,
			engineId: 'aexus-claude',
		});

		assert.deepEqual(findCommand(commands, 'shared-skill'), {
			name: 'shared-skill',
			description: 'Shared skill for every engine',
			argumentHint: undefined,
			source: 'local',
			kind: 'skill',
			filePath: sharedSkillFilePath,
			engineId: 'aexus-claude',
		});

		assert.deepEqual(findCommand(commands, 'deploy'), {
			name: 'deploy',
			description: 'Deploy the current project',
			argumentHint: '[environment]',
			source: 'local',
			kind: 'command',
			filePath: deployFilePath,
			engineId: 'aexus-claude',
		});

		assert.deepEqual(findCommand(commands, 'audit'), {
			name: 'audit',
			description: 'Audit the codebase for issues',
			argumentHint: undefined,
			source: 'local',
			kind: 'workflow',
			filePath: auditFilePath,
			engineId: 'aexus-claude',
		});
	});

	test('local templates are discovered for every engine', async () => {
		for (const engineId of ENGINE_IDS) {
			const commands = await discoverSlashCommands(engineId, engineId, workspace);
			for (const name of ['my-skill', 'shared-skill', 'deploy', 'audit']) {
				const command = findCommand(commands, name);
				assert.ok(command, `${engineId} did not discover ${name}`);
				assert.equal(command.source, 'local', `${engineId}.${name}`);
			}
		}
	});

	test('runtime commands merge and deduplicate case-insensitively', async () => {
		const commands = await discoverSlashCommands('aexus-claude', 'aexus-claude', workspace, [
			{ name: 'runtime-fetch', description: 'Fetch data from the runtime' },
			{ name: '/runtime-slash', description: 'Runtime command with a leading slash' },
			{ name: 'init', description: 'Duplicate builtin must not win' },
			{ name: 'my-skill', description: 'Duplicate skill must not win' },
			{ name: 'DEPLOY', description: 'Duplicate file command must not win' },
			{ name: 'Runtime-Fetch', description: 'Same command in another case' },
		]);

		assert.deepEqual(findCommand(commands, 'runtime-fetch'), {
			name: 'runtime-fetch',
			description: 'Fetch data from the runtime',
			source: 'local',
			kind: 'command',
			engineId: 'aexus-claude',
		});

		assert.equal(commands.filter(command => command.name.toLowerCase() === 'runtime-fetch').length, 1);
		assert.equal(findCommand(commands, 'runtime-slash').name, 'runtime-slash');

		assert.equal(findCommand(commands, 'init').source, 'builtin');
		assert.equal(findCommand(commands, 'init').description, 'Initialize a CLAUDE.md file with codebase documentation');
		assert.equal(commands.filter(command => command.name === 'init').length, 1);

		const skill = findCommand(commands, 'my-skill');
		assert.equal(skill.source, 'local');
		assert.equal(skill.filePath, skillFilePath);
		assert.equal(skill.description, 'My local skill description');

		const deploy = findCommand(commands, 'deploy');
		assert.equal(deploy.description, 'Deploy the current project');
		assert.equal(deploy.filePath, deployFilePath);
		assert.equal(commands.filter(command => command.name.toLowerCase() === 'deploy').length, 1);
	});

	test('Pi runtime get_commands style commands merge with builtins', async () => {
		const commands = await discoverSlashCommands('aexus-pi', 'aexus-pi', workspace, [
			{ name: 'pi-command', description: 'Reported by Pi get_commands' },
		]);

		assert.equal(commands[0].name, 'goal');
		assert.deepEqual(findCommand(commands, 'pi-command'), {
			name: 'pi-command',
			description: 'Reported by Pi get_commands',
			source: 'local',
			kind: 'command',
			engineId: 'aexus-pi',
		});
		for (const builtin of ['tree', 'stats', 'reload', 'fork']) {
			assert.equal(findCommand(commands, builtin).source, 'builtin', builtin);
		}
	});

	test('ACP available_commands_update style commands merge without duplicates', async () => {
		const commands = await discoverSlashCommands('aexus-codex', 'aexus-codex', workspace, [
			{ name: 'acp-review', description: 'ACP supplied review' },
			{ name: 'acp-review', description: 'ACP duplicate' },
			{ name: 'sandbox', description: 'ACP duplicate of a builtin' },
		]);

		assert.equal(findCommand(commands, 'acp-review').description, 'ACP supplied review');
		assert.equal(commands.filter(command => command.name === 'acp-review').length, 1);
		assert.equal(commands.filter(command => command.name === 'sandbox').length, 1);
		assert.equal(findCommand(commands, 'sandbox').description, 'Configure the sandbox policy');
	});
});

describe('discoverCustomizationFiles', () => {

	test('returns on-disk skills, prompts, agents, instructions, hooks, and plugins', async () => {
		const files = await discoverCustomizationFiles('aexus-claude', workspace);

		assert.deepEqual(files.find(file => file.name === 'my-skill'), {
			uriPath: skillFilePath,
			isBuiltin: false,
			type: 'skill',
			name: 'my-skill',
			description: 'My local skill description',
			source: 'local',
			userInvocable: true,
		});

		assert.deepEqual(files.find(file => file.name === 'shared-skill'), {
			uriPath: sharedSkillFilePath,
			isBuiltin: false,
			type: 'skill',
			name: 'shared-skill',
			description: 'Shared skill for every engine',
			source: 'local',
			userInvocable: true,
		});

		assert.deepEqual(files.find(file => file.name === 'deploy'), {
			uriPath: deployFilePath,
			isBuiltin: false,
			type: 'prompt',
			name: 'deploy',
			description: 'Deploy the current project',
			source: 'local',
			userInvocable: true,
		});

		assert.deepEqual(files.find(file => file.uriPath === auditFilePath && file.type === 'prompt'), {
			uriPath: auditFilePath,
			isBuiltin: false,
			type: 'prompt',
			name: 'audit',
			description: 'Audit the codebase for issues',
			source: 'local',
			userInvocable: true,
		});

		assert.deepEqual(files.find(file => file.name === 'reviewer'), {
			uriPath: reviewerFilePath,
			isBuiltin: false,
			type: 'agent',
			name: 'reviewer',
			description: 'Reviews changes for correctness',
			source: 'local',
			userInvocable: true,
		});

		assert.deepEqual(files.find(file => file.uriPath === agentsInstructionFilePath), {
			uriPath: agentsInstructionFilePath,
			isBuiltin: false,
			type: 'instructions',
			name: 'AGENTS.md',
			description: 'Instructions from AGENTS.md',
			source: 'local',
			userInvocable: false,
		});

		assert.deepEqual(files.find(file => file.uriPath === hookFilePath), {
			uriPath: hookFilePath,
			isBuiltin: false,
			type: 'hook',
			name: 'pre-commit.sh',
			description: 'Hook from hooks',
			source: 'local',
			userInvocable: false,
		});

		assert.deepEqual(files.find(file => file.uriPath === pluginManifestPath), {
			uriPath: pluginManifestPath,
			isBuiltin: false,
			type: 'plugin',
			name: 'demo-plugin',
			description: 'A demo plugin',
			source: 'plugin',
			userInvocable: false,
		});
	});

	test('surfaces dynamic built-in commands as agent-builtin://aexus/<name>', async () => {
		const files = await discoverCustomizationFiles('aexus-claude', workspace, [
			{ name: 'runtime-custom', description: 'Runtime supplied command' },
		]);

		const builtinFiles = files.filter(file => file.isBuiltin);
		assert.ok(builtinFiles.length > 0);
		for (const file of builtinFiles) {
			assert.equal(file.uriPath, `agent-builtin://aexus/${file.name}`);
			assert.equal(file.type, 'prompt');
			assert.equal(file.userInvocable, true);
			assert.match(file.uriPath, /^agent-builtin:\/\/aexus\//);
		}

		assert.deepEqual(files.find(file => file.name === 'goal'), {
			uriPath: 'agent-builtin://aexus/goal',
			isBuiltin: true,
			type: 'prompt',
			name: 'goal',
			description: 'Set an autonomous goal verified before stopping [<goal> | clear]',
			source: 'builtin',
			userInvocable: true,
		});

		assert.deepEqual(files.find(file => file.name === 'runtime-custom'), {
			uriPath: 'agent-builtin://aexus/runtime-custom',
			isBuiltin: true,
			type: 'prompt',
			name: 'runtime-custom',
			description: 'Runtime supplied command',
			source: 'local',
			userInvocable: true,
		});

		assert.equal(files.find(file => file.isBuiltin && file.name === 'my-skill'), undefined);
	});

	test('file-backed commands are not duplicated as built-ins', async () => {
		const files = await discoverCustomizationFiles('aexus-claude', workspace, [
			{ name: 'deploy', description: 'Runtime duplicate of deploy' },
			{ name: 'my-skill', description: 'Runtime duplicate of my-skill' },
		]);

		assert.equal(files.filter(file => file.name === 'deploy').length, 1);
		assert.equal(files.find(file => file.name === 'deploy').uriPath, deployFilePath);
		assert.equal(files.filter(file => file.name === 'my-skill').length, 1);
		assert.equal(files.find(file => file.name === 'my-skill').isBuiltin, false);
		assert.equal(files.find(file => file.name === 'deploy' && file.isBuiltin), undefined);
	});

	test('every engine discovers the same on-disk customizations', async () => {
		for (const engineId of ENGINE_IDS) {
			const files = await discoverCustomizationFiles(engineId, workspace);
			for (const name of ['my-skill', 'shared-skill', 'deploy', 'reviewer']) {
				const file = files.find(entry => entry.name === name);
				assert.ok(file, `${engineId} did not discover ${name}`);
				assert.equal(file.isBuiltin, false, `${engineId}.${name}`);
				assert.equal(file.uriPath.startsWith(workspace), true, `${engineId}.${name}`);
			}
		}
	});
});

describe('readSkillOrCommandTemplate', () => {

	test('strips YAML frontmatter and substitutes $ARGUMENTS', async () => {
		const commands = await discoverSlashCommands('aexus-claude', 'aexus-claude', workspace);
		const output = await readSkillOrCommandTemplate(findCommand(commands, 'deploy'), 'production');

		assert.equal(output, 'Deploy the current project to production.\n\nVerify the deployment afterwards.');
	});

	test('substitutes every $ARGUMENTS occurrence', async () => {
		const output = await readSkillOrCommandTemplate({
			name: 'repeat',
			description: 'Repeat',
			source: 'local',
			kind: 'command',
			filePath: repeatTemplatePath,
		}, 'the build');
		assert.equal(output, 'Use the build, then the build again.');
	});

	test('appends the user request when $ARGUMENTS is absent', async () => {
		const commands = await discoverSlashCommands('aexus-claude', 'aexus-claude', workspace);
		const output = await readSkillOrCommandTemplate(findCommand(commands, 'my-skill'), 'Refactor auth');

		assert.equal(output, '# My Skill\n\nDo the thing with care.\n\nUser Request: Refactor auth');
	});

	test('returns the trimmed body when no arguments are supplied', async () => {
		const commands = await discoverSlashCommands('aexus-claude', 'aexus-claude', workspace);
		assert.equal(await readSkillOrCommandTemplate(findCommand(commands, 'my-skill'), ''), '# My Skill\n\nDo the thing with care.');
		assert.equal(await readSkillOrCommandTemplate(findCommand(commands, 'audit'), '   '), 'Audit the codebase thoroughly.');
	});

	test('returns undefined for builtins, missing files, and empty bodies', async () => {
		const commands = await discoverSlashCommands('aexus-claude', 'aexus-claude', workspace);

		assert.equal(await readSkillOrCommandTemplate(findCommand(commands, 'goal'), 'do it'), undefined);
		assert.equal(await readSkillOrCommandTemplate({
			name: 'missing',
			description: 'Missing',
			source: 'local',
			kind: 'command',
			filePath: path.join(workspace, 'does-not-exist.md'),
		}, 'args'), undefined);
		assert.equal(await readSkillOrCommandTemplate({
			name: 'empty',
			description: 'Empty',
			source: 'local',
			kind: 'command',
			filePath: emptyTemplatePath,
		}, 'args'), undefined);
	});
});

describe('package.json contributions', () => {

	const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

	test('all nine chat sessions support prompt attachments', async () => {
		const sessions = pkg.contributes.chatSessions;
		assert.equal(sessions.length, 9);
		for (const session of sessions) {
			assert.equal(session.supportsPromptAttachments, true, session.type);
		}
		assert.deepEqual(
			sessions.map(session => session.type).sort(),
			['aexus-secretary', ...ENGINE_IDS].sort(),
		);
	});

	test('the customization provider API proposal is enabled', async () => {
		assert.ok(pkg.enabledApiProposals.includes('chatSessionCustomizationProvider'));
	});

	test('all nine chat participants declare goal as their first command', async () => {
		const participants = pkg.contributes.chatParticipants;
		assert.equal(participants.length, 9);
		for (const participant of participants) {
			assert.equal(participant.commands[0].name, 'goal', participant.id);
		}
		assert.deepEqual(
			participants.map(participant => participant.id).sort(),
			['aexus-secretary', ...ENGINE_IDS].sort(),
		);
	});
});

interface IFakeAdeControlServer {
	readonly env: NodeJS.ProcessEnv;
	readonly requests: IAdeControlWireRequest[];
	close(): Promise<void>;
}

async function startFakeAdeControlServer(result: unknown = { ok: true }): Promise<IFakeAdeControlServer> {
	// Unix socket paths are limited to ~104 bytes on macOS, so keep this outside the longer testRoot path.
	const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aexus-cli-'));
	const socketPath = process.platform === 'win32'
		? `\\\\.\\pipe\\aexus-cli-test-${path.basename(socketDir)}-${process.pid}`
		: path.join(socketDir, 's.sock');
	const requests: IAdeControlWireRequest[] = [];
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.setEncoding('utf8');
		let buffer = '';
		socket.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			let newline = buffer.indexOf('\n');
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) {
					requests.push(JSON.parse(line) as IAdeControlWireRequest);
					socket.write(JSON.stringify({ ok: true, result }) + '\n');
				}
				newline = buffer.indexOf('\n');
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	return {
		env: { AEXUS_ADE_SOCKET: socketPath, AEXUS_ADE_TOKEN: 'test-token' },
		requests,
		close: () => new Promise<void>(resolve => {
			for (const socket of sockets) {
				socket.destroy();
			}
			server.close(() => {
				fs.rmSync(socketDir, { recursive: true, force: true });
				resolve();
			});
		}),
	};
}

async function runCliAgainstFakeServer(argv: readonly string[], result?: unknown): Promise<{ code: number; stdout: string; stderr: string; requests: IAdeControlWireRequest[] }> {
	const server = await startFakeAdeControlServer(result);
	const stdout: string[] = [];
	const stderr: string[] = [];
	try {
		const code = await runCli(argv, {
			stdout: text => stdout.push(text),
			stderr: text => stderr.push(text),
			env: server.env,
			cwd: workspace,
		});
		return { code, stdout: stdout.join(''), stderr: stderr.join(''), requests: server.requests };
	} finally {
		await server.close();
	}
}

const HOST_COMMAND_CASES: { argv: readonly string[]; action: string; params: Record<string, unknown> }[] = [
	{ argv: ['host', 'list'], action: 'host.list', params: {} },
	{ argv: ['host', 'info', 'gpu1'], action: 'host.get', params: { target: 'gpu1' } },
	{
		argv: ['host', 'add', 'ubuntu@10.0.0.5:2222', '--name', 'MyGPU', '--alias', 'gpu1', '--os', 'linux', '--default-dir', '/workspace'],
		action: 'host.upsert',
		params: {
			name: 'MyGPU',
			alias: 'gpu1',
			os: 'linux',
			defaultDirectory: '/workspace',
			user: 'ubuntu',
			hostName: '10.0.0.5',
			port: 2222,
		},
	},
	{ argv: ['host', 'update', 'gpu1', '--jump', 'bastion'], action: 'host.upsert', params: { proxyJump: 'bastion', alias: 'gpu1' } },
	{ argv: ['host', 'remove', 'gpu1'], action: 'host.delete', params: { target: 'gpu1' } },
	{ argv: ['host', 'test', 'gpu1'], action: 'host.test', params: { target: 'gpu1' } },
	{ argv: ['host', 'browse', 'gpu1', '--path', '/workspace'], action: 'host.browse', params: { target: 'gpu1', path: '/workspace' } },
	{ argv: ['host', 'import-vscode'], action: 'host.import', params: {} },
	{ argv: ['host', 'open', 'gpu1'], action: 'host.open', params: { target: 'gpu1' } },
];

describe('Ade CLI cloud host commands', () => {

	describe('parseCliCommand', () => {

		for (const { argv, action, params } of HOST_COMMAND_CASES) {
			test(`parses 'aexus-ade ${argv.join(' ')}'`, () => {
				assert.deepStrictEqual(parseCliCommand([...argv], workspace), {
					help: false,
					json: false,
					windowId: undefined,
					action,
					params,
				});
			});
		}

		test('cloud-host is an alias for host', () => {
			assert.deepStrictEqual(parseCliCommand(['cloud-host', 'list'], workspace), {
				help: false,
				json: false,
				windowId: undefined,
				action: 'host.list',
				params: {},
			});
		});

		test('host add rejects a missing host spec', () => {
			assert.throws(() => parseCliCommand(['host', 'add', '--name', 'gpu'], workspace), /Usage: aexus-ade host add/);
		});

		test('host add rejects an out-of-range port', () => {
			assert.throws(() => parseCliCommand(['host', 'add', 'gpu1', '--port', '70000'], workspace), /--port requires an integer between 1 and 65535/);
		});

		test('host add rejects an unsupported os', () => {
			assert.throws(() => parseCliCommand(['host', 'add', 'gpu1', '--os', 'solaris'], workspace), /--os must be linux, macos, or windows/);
		});

		test('host browse rejects a missing target', () => {
			assert.throws(() => parseCliCommand(['host', 'browse', '--path', '/workspace'], workspace), /Usage: aexus-ade host browse/);
		});

		test('project add preserves aexus-ssh specs', () => {
			assert.deepStrictEqual(parseCliCommand(['project', 'add', 'aexus-ssh://gpu1/workspace/repo'], workspace), {
				help: false,
				json: false,
				windowId: undefined,
				action: 'project.add',
				params: { paths: ['aexus-ssh://gpu1/workspace/repo'] },
			});
		});

		test('project add preserves host:path specs', () => {
			assert.deepStrictEqual(parseCliCommand(['project', 'add', 'gpu1:/workspace/repo'], workspace), {
				help: false,
				json: false,
				windowId: undefined,
				action: 'project.add',
				params: { paths: ['gpu1:/workspace/repo'] },
			});
		});
	});

	describe('runCli', () => {

		for (const { argv, action, params } of HOST_COMMAND_CASES) {
			test(`sends ${action} for 'aexus-ade ${argv.join(' ')}'`, async () => {
				const result = { id: 'gpu1' };
				const { code, stdout, stderr, requests } = await runCliAgainstFakeServer([...argv, '--json'], result);
				assert.deepStrictEqual(
					{ code, stdout: JSON.parse(stdout), stderr, requests: requests.map(request => ({ action: request.action, params: request.params })) },
					{ code: 0, stdout: result, stderr: '', requests: [{ action, params }] },
				);
			});
		}

		test('does not resolve aexus-ssh project paths against the local cwd', async () => {
			const spec = 'aexus-ssh://gpu1/workspace/repo';
			const { code, requests } = await runCliAgainstFakeServer(['project', 'add', spec, '--json'], { paths: [spec] });
			assert.deepStrictEqual(
				{ code, params: requests.map(request => request.params) },
				{ code: 0, params: [{ paths: [spec] }] },
			);
		});

		test('does not resolve host:path project specs against the local cwd', async () => {
			const spec = 'gpu1:/workspace/repo';
			const { code, requests } = await runCliAgainstFakeServer(['project', 'add', spec, '--json'], { paths: [spec] });
			assert.deepStrictEqual(
				{ code, params: requests.map(request => request.params) },
				{ code: 0, params: [{ paths: [spec] }] },
			);
		});
	});
});
