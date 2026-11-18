/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildOptionGroupsForSession,
	discoverSlashCommands,
	discoverCustomizationFiles,
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

const SECRETARY_MACROS = ['status', 'projects', 'sessions', 'engineering', 'inbox', 'focus', 'home', 'new', 'engine', 'reset'];

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
	'aexus-kilo': ['mode'],
	'aexus-opencode': ['mode'],
	'aexus-dsh': ['permissions'],
	'aexus-antigravity': ['mode'],
	'aexus-cline': ['mode'],
	'aexus-pi': ['mode'],
};

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

	test('switching the secretary engine dynamically rebuilds model, thinking, and engine groups', async () => {
		const claudeGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-claude' }, workspace);
		assert.deepEqual(claudeGroups.map(group => group.id), ['engine', 'model', 'thinking', 'permissions']);
		assert.deepEqual(itemIds(groupById(claudeGroups, 'permissions')), ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);

		const codexGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-codex' }, workspace);
		assert.deepEqual(codexGroups.map(group => group.id), ['engine', 'model', 'thinking', 'permissions', 'sandbox', 'webSearch']);
		assert.equal(groupById(codexGroups, 'engine').selectedId, 'aexus-codex');
		assert.deepEqual(itemIds(groupById(codexGroups, 'sandbox')), ['default', 'read-only', 'workspace-write', 'danger-full-access']);
		assert.deepEqual(itemIds(groupById(codexGroups, 'webSearch')), ['enabled', 'disabled']);
		assert.deepEqual(itemIds(groupById(codexGroups, 'thinking')), ['default', 'minimal', 'low', 'medium', 'high', 'xhigh']);

		const kiloGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-kilo' }, workspace);
		assert.deepEqual(kiloGroups.map(group => group.id), ['engine', 'model', 'thinking', 'mode']);
		assert.ok(itemIds(groupById(kiloGroups, 'mode')).includes('architect'));
		assert.ok(itemIds(groupById(kiloGroups, 'mode')).includes('orchestrator'));

		const openCodeGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-opencode' }, workspace);
		assert.deepEqual(openCodeGroups.map(group => group.id), ['engine', 'model', 'thinking', 'mode']);
		assert.equal(groupById(openCodeGroups, 'mode').name, 'Agent');
		assert.ok(itemIds(groupById(openCodeGroups, 'mode')).includes('build'));
		assert.ok(itemIds(groupById(openCodeGroups, 'mode')).includes('plan'));

		const clineGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-cline' }, workspace);
		assert.deepEqual(clineGroups.map(group => group.id), ['engine', 'model', 'thinking', 'mode']);
		assert.deepEqual(itemIds(groupById(clineGroups, 'mode')), ['act', 'plan', 'yolo']);

		const piGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-pi' }, workspace);
		assert.deepEqual(piGroups.map(group => group.id), ['engine', 'model', 'thinking', 'mode']);
		assert.deepEqual(itemIds(groupById(piGroups, 'mode')), ['full', 'readonly', 'chat']);

		const dshGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-dsh' }, workspace);
		assert.deepEqual(dshGroups.map(group => group.id), ['engine', 'model', 'thinking', 'permissions']);
		assert.ok(itemIds(groupById(dshGroups, 'permissions')).includes('danger-full-access'));

		const antigravityGroups = await buildOptionGroupsForSession('secretary', { secretaryEngineId: 'aexus-antigravity' }, workspace);
		assert.deepEqual(antigravityGroups.map(group => group.id), ['engine', 'model', 'thinking', 'mode']);
		assert.deepEqual(itemIds(groupById(antigravityGroups, 'mode')), ['accept-edits', 'auto', 'plan', 'default']);
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
