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
	discoverCustomizationFiles,
	discoverEngineModels,
	discoverSlashCommands,
	parseAgyModelsOutput,
	readSkillOrCommandTemplate,
	type EngineId,
} from '../src/capabilities.ts';

const ENGINE_IDS: readonly EngineId[] = [
	'aexus-claude',
	'aexus-codex',
	'aexus-kilo',
	'aexus-opencode',
	'aexus-dsh',
	'aexus-antigravity',
	'aexus-cline',
	'aexus-pi',
];

const ENGINE_SPECIFIC_GROUPS: Record<EngineId, string[]> = {
	'aexus-claude': ['permissions'],
	'aexus-codex': ['permissions', 'sandbox', 'webSearch'],
	'aexus-kilo': ['mode', 'permissions'],
	'aexus-opencode': ['mode', 'permissions'],
	'aexus-dsh': ['permissions'],
	'aexus-antigravity': ['mode'],
	'aexus-cline': ['mode'],
	'aexus-pi': ['mode', 'permissions'],
};

const HIGHEST_PERMISSION_DEFAULTS: Record<EngineId, Record<string, string>> = {
	'aexus-claude': { permissions: 'bypassPermissions' },
	'aexus-codex': { permissions: 'never', sandbox: 'danger-full-access' },
	'aexus-kilo': { permissions: 'bypassPermissions' },
	'aexus-opencode': { permissions: 'bypassPermissions' },
	'aexus-dsh': { permissions: 'danger-full-access' },
	'aexus-antigravity': { mode: 'auto' },
	'aexus-cline': { mode: 'yolo' },
	'aexus-pi': { permissions: 'bypassPermissions' },
};

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(TEST_DIR, '..');
const PACKAGE_JSON_PATH = path.join(EXTENSION_ROOT, 'package.json');

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

describe('discoverEngineModels & buildOptionGroupsForSession (8 real engines, zero legacy secretary)', () => {
	test('Claude Code replaceBuiltInOptions drops built-in aliases while keeping picker models', async () => {
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
		assert.deepEqual(models.map(m => m.id), ['default', 'claude-custom-sonnet', 'claude-custom-opus']);
	});

	test('Codex discovers models_cache.json entries and filters hidden models', async () => {
		const cwd = createCaseDir('codex-cache');
		writeCaseFile(cwd, '.codex/models_cache.json', JSON.stringify({
			models: [
				{ slug: 'gpt-5', display_name: 'GPT-5', description: 'Fast frontier model', visibility: 'list' },
				{ slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
				{ slug: 'o3', display_name: 'o3' },
			],
		}));

		const models = await discoverEngineModels('aexus-codex', cwd);
		assert.deepEqual(models.map(m => m.id), ['default', 'gpt-5', 'o3']);
	});

	test('parseAgyModelsOutput skips header, blank lines, and duplicate IDs', () => {
		const output = [
			'Fetching available models...',
			'',
			'gemini-2.5-pro\tGemini 2.5 Pro',
			'gemini-2.5-flash\tGemini 2.5 Flash',
			'gemini-2.5-pro\tGemini 2.5 Pro (duplicate)',
		].join('\n');

		assert.deepEqual(parseAgyModelsOutput(output), [
			{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
			{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
		]);
	});

	for (const engineId of ENGINE_IDS) {
		test(`${engineId} exposes model, thinking, and its unique permission/mode groups with highest-permission defaults`, async () => {
			const groups = await buildOptionGroupsForSession(engineId, {}, workspace);
			assert.deepEqual(groups.map(g => g.id), ['model', 'thinking', ...ENGINE_SPECIFIC_GROUPS[engineId]]);
			for (const [groupId, expectedSelected] of Object.entries(HIGHEST_PERMISSION_DEFAULTS[engineId])) {
				const grp = groups.find(g => g.id === groupId);
				assert.ok(grp);
				assert.equal(grp.selectedId, expectedSelected);
			}
		});
	}
});

describe('discoverSlashCommands & discoverCustomizationFiles (zero /goal or legacy orchestration macros)', () => {
	test('discovers native engine commands and local skills/workflows without legacy /goal or /mission', async () => {
		for (const engineId of ENGINE_IDS) {
			const commands = await discoverSlashCommands(engineId, workspace);
			const names = commands.map(c => c.name);
			assert.equal(names.includes('goal'), false, `${engineId} must not expose legacy /goal`);
			assert.equal(names.includes('mission'), false, `${engineId} must not expose legacy /mission`);
			assert.equal(names.includes('teamwork'), false, `${engineId} must not expose legacy /teamwork`);
			for (const localName of ['my-skill', 'shared-skill', 'deploy', 'audit']) {
				assert.ok(names.includes(localName), `${engineId} must discover ${localName}`);
			}
		}
	});

	test('discoverCustomizationFiles surfaces skills, prompts, agents, instructions, and built-in commands', async () => {
		const files = await discoverCustomizationFiles('aexus-claude', workspace, [
			{ name: 'runtime-custom', description: 'Runtime supplied command' },
		]);
		assert.ok(files.some(f => f.uriPath === skillFilePath && f.type === 'skill'));
		assert.ok(files.some(f => f.uriPath === sharedSkillFilePath && f.type === 'skill'));
		assert.ok(files.some(f => f.uriPath === deployFilePath && f.type === 'prompt'));
		assert.ok(files.some(f => f.uriPath === auditFilePath && f.type === 'prompt'));
		assert.ok(files.some(f => f.uriPath === reviewerFilePath && f.type === 'agent'));
		assert.ok(files.some(f => f.uriPath === agentsInstructionFilePath && f.type === 'instructions'));
		assert.ok(files.some(f => f.uriPath === 'agent-builtin://aexus/runtime-custom' && f.isBuiltin));
	});

	test('readSkillOrCommandTemplate strips frontmatter and substitutes $ARGUMENTS', async () => {
		const commands = await discoverSlashCommands('aexus-claude', workspace);
		const deploy = commands.find(c => c.name === 'deploy')!;
		const output = await readSkillOrCommandTemplate(deploy, 'production');
		assert.equal(output, 'Deploy the current project to production.\n\nVerify the deployment afterwards.');
	});
});

describe('package.json contributions (exact 8 engines, zero secretary/goal)', () => {
	const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

	test('contributes exactly the 8 Coding Agent sessions & participants with zero secretary or /goal', () => {
		const sessions = pkg.contributes.chatSessions;
		assert.equal(sessions.length, 8);
		assert.deepEqual(sessions.map((s: { type: string }) => s.type).sort(), [...ENGINE_IDS].sort());

		const participants = pkg.contributes.chatParticipants;
		assert.equal(participants.length, 8);
		assert.deepEqual(participants.map((p: { id: string }) => p.id).sort(), [...ENGINE_IDS].sort());
		for (const p of participants) {
			for (const cmd of p.commands) {
				assert.notEqual(cmd.name, 'goal', `${p.id} must not declare /goal`);
				assert.notEqual(cmd.name, 'mission', `${p.id} must not declare /mission`);
			}
		}
	});
});
