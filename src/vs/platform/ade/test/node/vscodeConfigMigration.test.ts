/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Database } from '@vscode/sqlite3';
import assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import { parse } from '../../../../base/common/json.js';
import * as path from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { applyHttpProxySettingsToEnv, enrichCodingAgentPath } from '../../common/adeEnv.js';
import { migrateVsCodeSettingsToAexus, migrateVsCodeStateAndExtensionsToAexus, shouldMigrateVsCodeSettingKey } from '../../node/vscodeConfigMigration.js';

async function withSqliteDb(dbPath: string, mode: number, fn: (db: Database) => Promise<void>): Promise<void> {
	const sqlite3 = await import('@vscode/sqlite3');
	const db = await new Promise<Database>((resolve, reject) => {
		const instance = new sqlite3.default.Database(dbPath, mode, (error: Error | null) => {
			if (error) {
				reject(error);
			} else {
				resolve(instance);
			}
		});
	});
	try {
		await fn(db);
	} finally {
		await new Promise<void>((resolve, reject) => db.close((err: Error | null) => err ? reject(err) : resolve()));
	}
}

function dbRun(db: Database, sql: string, params: readonly unknown[] = []): Promise<void> {
	return new Promise((resolve, reject) => db.run(sql, params, (err: Error | null) => err ? reject(err) : resolve()));
}

function dbAll(db: Database, sql: string): Promise<Array<{ key: string; value: string }>> {
	return new Promise((resolve, reject) => db.all(sql, (err: Error | null, rows: unknown[]) => err ? reject(err) : resolve(rows as Array<{ key: string; value: string }>)));
}

suite('VSCodeConfigMigration & AdeEnv', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let tempRoot: string;

	setup(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aexus-mig-test-'));
	});

	teardown(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	test('enrichCodingAgentPath deduplicates and appends missing agent directories cleanly', () => {
		const macPath = enrichCodingAgentPath('/usr/bin:/Users/alice/.npm-global/bin:/usr/bin', '/Users/alice', true, false);
		assert.deepStrictEqual(macPath.split(':'), [
			'/usr/bin',
			'/Users/alice/.npm-global/bin',
			'/Users/alice/.local/bin',
			'/Users/alice/.local/node-current/bin',
			'/Users/alice/.gemini/bin',
			'/Users/alice/.opencode/bin',
			'/Users/alice/.bun/bin',
			'/Users/alice/.volta/bin',
			'/Users/alice/.asdf/shims',
			'/Users/alice/.cargo/bin',
			'/opt/homebrew/bin',
			'/usr/local/bin',
			'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin',
		]);

		const winPath = enrichCodingAgentPath('C:\\Windows\\System32;C:\\Users\\alice\\.Gemini\\bin', 'C:\\Users\\alice', false, true);
		assert.deepStrictEqual(winPath.split(';'), [
			'C:\\Windows\\System32',
			'C:\\Users\\alice\\.Gemini\\bin',
			'C:\\Users\\alice\\.npm-global\\bin',
			'C:\\Users\\alice\\.local\\bin',
			'C:\\Users\\alice\\.local\\node-current',
			'C:\\Users\\alice\\.opencode\\bin',
			'C:\\Users\\alice\\.bun\\bin',
			'C:\\Users\\alice\\.volta\\bin',
			'C:\\Users\\alice\\.cargo\\bin',
		]);
	});

	test('applyHttpProxySettingsToEnv handles proxy on, noProxy merge, loopback safety, off mode, and NODE_USE_SYSTEM_CA', () => {
		const envOn: Record<string, string | undefined> = { NO_PROXY: 'internal.local' };
		applyHttpProxySettingsToEnv(envOn, {
			proxySupport: 'on',
			proxy: 'http://127.0.0.1:7890',
			noProxy: ['myai.bupt.edu.cn', 'localhost'],
			systemCertificatesNode: true,
		}, true);
		assert.strictEqual(envOn.HTTP_PROXY, 'http://127.0.0.1:7890');
		assert.strictEqual(envOn.HTTPS_PROXY, 'http://127.0.0.1:7890');
		assert.strictEqual(envOn.http_proxy, 'http://127.0.0.1:7890');
		assert.strictEqual(envOn.https_proxy, 'http://127.0.0.1:7890');
		assert.strictEqual(envOn.NO_PROXY, 'internal.local,myai.bupt.edu.cn,localhost,127.0.0.1,::1');
		assert.strictEqual(envOn.no_proxy, 'internal.local,myai.bupt.edu.cn,localhost,127.0.0.1,::1');
		assert.strictEqual(envOn.NODE_USE_SYSTEM_CA, '1');

		const envOff: Record<string, string | undefined> = {
			HTTP_PROXY: 'http://127.0.0.1:7890',
			HTTPS_PROXY: 'http://127.0.0.1:7890',
			https_proxy: 'http://127.0.0.1:7890',
		};
		applyHttpProxySettingsToEnv(envOff, {
			proxySupport: 'off',
			proxy: 'http://127.0.0.1:7890',
			systemCertificatesNode: false,
		}, true);
		assert.strictEqual(envOff.HTTP_PROXY, undefined);
		assert.strictEqual(envOff.HTTPS_PROXY, undefined);
		assert.strictEqual(envOff.https_proxy, undefined);
		assert.strictEqual(envOff.NO_PROXY, '*');
		assert.strictEqual(envOff.no_proxy, '*');
		assert.strictEqual(envOff.NODE_USE_SYSTEM_CA, undefined);
	});

	test('migrateVsCodeSettingsToAexus parses JSONC, migrates proxy and agent settings non-destructively, and rejects UI/Copilot keys', async () => {
		assert.strictEqual(shouldMigrateVsCodeSettingKey('http.proxy'), true);
		assert.strictEqual(shouldMigrateVsCodeSettingKey('antigravity.serverPort'), true);
		assert.strictEqual(shouldMigrateVsCodeSettingKey('piAgent.pi.executable'), true);
		assert.strictEqual(shouldMigrateVsCodeSettingKey('chat.viewSessions.enabled'), false);
		assert.strictEqual(shouldMigrateVsCodeSettingKey('github.copilot.enable'), false);
		assert.strictEqual(shouldMigrateVsCodeSettingKey('workbench.secondarySideBar.defaultVisibility'), false);

		const vsCodeSettingsPath = path.join(tempRoot, 'Code', 'User', 'settings.json');
		const aexusSettingsPath = path.join(tempRoot, 'Aexus', 'User', 'settings.json');
		await fs.mkdir(path.dirname(vsCodeSettingsPath), { recursive: true });
		await fs.mkdir(path.dirname(aexusSettingsPath), { recursive: true });

		await fs.writeFile(vsCodeSettingsPath, `{
			// JSONC comment & trailing comma support
			"http.proxy": "http://127.0.0.1:7890",
			"http.proxySupport": "on",
			"http.noProxy": ["myai.bupt.edu.cn", "127.0.0.1"],
			"http.systemCertificatesNode": true,
			"antigravity.enableInlineDiff": true,
			"chatgpt.followUpQueueMode": "queue",
			"claudeCode.preferredLocation": "sidebar",
			"workbench.editor.autoLockGroups": {
				"mainThreadWebview-claudeVSCodePanel": false,
				"mainThreadWebview-extra": false
			},
			"terminal.integrated.commandsToSkipShell": [
				"kilo-code.new.agentManagerOpen",
				"antigravity.insertTerminalSnippet"
			],
			"chat.viewSessions.enabled": false,
			"workbench.secondarySideBar.defaultVisibility": "hidden",
			"github.copilot.enable": { "*": false },
		}`, 'utf8');

		await fs.writeFile(aexusSettingsPath, JSON.stringify({
			'claudeCode.preferredLocation': 'panel',
			'workbench.editor.autoLockGroups': {
				'mainThreadWebview-claudeVSCodePanel': true,
			},
			'terminal.integrated.commandsToSkipShell': [
				'kilo-code.new.agentManagerOpen',
			],
		}, null, '\t'), 'utf8');

		const res = await migrateVsCodeSettingsToAexus({ vsCodeSettingsPath, aexusSettingsPath });
		assert.ok(res.updatedKeys.includes('http.proxy'));
		assert.ok(res.updatedKeys.includes('http.noProxy'));
		assert.ok(res.updatedKeys.includes('antigravity.enableInlineDiff'));
		assert.ok(res.updatedKeys.includes('terminal.integrated.commandsToSkipShell'));
		assert.ok(res.updatedKeys.includes('workbench.editor.autoLockGroups'));
		assert.ok(!res.updatedKeys.includes('claudeCode.preferredLocation'));
		assert.ok(!res.updatedKeys.includes('chat.viewSessions.enabled'));
		assert.ok(!res.updatedKeys.includes('github.copilot.enable'));

		const finalObj = parse(await fs.readFile(aexusSettingsPath, 'utf8')) as Record<string, unknown>;
		assert.strictEqual(finalObj['http.proxy'], 'http://127.0.0.1:7890');
		assert.strictEqual(finalObj['claudeCode.preferredLocation'], 'panel');
		assert.deepStrictEqual(finalObj['terminal.integrated.commandsToSkipShell'], [
			'kilo-code.new.agentManagerOpen',
			'antigravity.insertTerminalSnippet',
		]);
		assert.deepStrictEqual(finalObj['workbench.editor.autoLockGroups'], {
			'mainThreadWebview-claudeVSCodePanel': true,
			'mainThreadWebview-extra': false,
		});
		assert.strictEqual(finalObj['chat.viewSessions.enabled'], undefined);
		assert.strictEqual(finalObj['github.copilot.enable'], undefined);
		assert.strictEqual(finalObj['workbench.secondarySideBar.defaultVisibility'], undefined);
	});

	test('migrateVsCodeStateAndExtensionsToAexus merges non-secret state, excludes secrets, copies missing storage & missing extensions', async () => {
		const vsUserData = path.join(tempRoot, 'Code');
		const vsGlobalStorage = path.join(vsUserData, 'User', 'globalStorage');
		const vsExts = path.join(tempRoot, '.vscode', 'extensions');
		const aexusGlobalStorage = path.join(tempRoot, 'Aexus', 'User', 'globalStorage');
		const aexusExts = path.join(tempRoot, '.aexus-code', 'extensions');

		await fs.mkdir(vsGlobalStorage, { recursive: true });
		await fs.mkdir(aexusGlobalStorage, { recursive: true });
		await fs.mkdir(vsExts, { recursive: true });
		await fs.mkdir(aexusExts, { recursive: true });

		const sqlite3 = await import('@vscode/sqlite3');
		const vsDbPath = path.join(vsGlobalStorage, 'state.vscdb');
		const aexusDbPath = path.join(aexusGlobalStorage, 'state.vscdb');

		await withSqliteDb(vsDbPath, sqlite3.default.OPEN_READWRITE | sqlite3.default.OPEN_CREATE, async db => {
			await dbRun(db, 'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);');
			await dbRun(db, 'INSERT INTO ItemTable VALUES (?, ?);', [
				'google.google-antigravity',
				JSON.stringify({
					'antigravity.lastInstalledReleaseBaseUrl': 'https://old.example',
					'antigravity-storage': { 'agy.onboarding.lastLoginUsername': 'user@example.com' },
				}),
			]);
			await dbRun(db, 'INSERT INTO ItemTable VALUES (?, ?);', [
				'Fengze233.dsh-vscode-panel',
				JSON.stringify({
					'dsh.secondaryGuideShown': true,
					'auth-session:127.0.0.1:3080': { issuedAt: 100 },
				}),
			]);
			await dbRun(db, 'INSERT INTO ItemTable VALUES (?, ?);', [
				'kilocode.kilo-code',
				JSON.stringify({ recentModels: [{ providerID: 'openai', modelID: 'gpt-6.1-sol' }] }),
			]);
			await dbRun(db, 'INSERT INTO ItemTable VALUES (?, ?);', [
				'saoudrizwan.claude-dev',
				JSON.stringify({ welcomeViewCompleted: false, 'cline.rollout.bundle': 'next' }),
			]);
			await dbRun(db, 'INSERT INTO ItemTable VALUES (?, ?);', [
				'secret://{"extensionId":"google.google-antigravity","key":"antigravity.authSync"}',
				'{"shouldNeverBeCopied":true}',
			]);
			await dbRun(db, 'INSERT INTO ItemTable VALUES (?, ?);', [
				'unrelated.extension',
				JSON.stringify({ ignore: true }),
			]);
		});

		await withSqliteDb(aexusDbPath, sqlite3.default.OPEN_READWRITE | sqlite3.default.OPEN_CREATE, async db => {
			await dbRun(db, 'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);');
			await dbRun(db, 'INSERT INTO ItemTable VALUES (?, ?);', [
				'google.google-antigravity',
				JSON.stringify({ 'antigravity.lastInstalledReleaseBaseUrl': 'https://aexus-keep.example' }),
			]);
			await dbRun(db, 'INSERT INTO ItemTable VALUES (?, ?);', [
				'Fengze233.dsh-vscode-panel',
				JSON.stringify({ 'auth-session:127.0.0.1:3080': { issuedAt: 999 } }),
			]);
			await dbRun(db, 'INSERT INTO ItemTable VALUES (?, ?);', [
				'saoudrizwan.claude-dev',
				JSON.stringify({ welcomeViewCompleted: true }),
			]);
		});

		// globalStorage/<extId> files
		await fs.mkdir(path.join(vsGlobalStorage, 'saoudrizwan.claude-dev', 'settings'), { recursive: true });
		await fs.writeFile(path.join(vsGlobalStorage, 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), '{"from":"vscode"}', 'utf8');
		await fs.writeFile(path.join(vsGlobalStorage, 'saoudrizwan.claude-dev', 'settings', 'existing.json'), '{"from":"vscode-should-not-overwrite"}', 'utf8');
		await fs.writeFile(path.join(vsGlobalStorage, 'saoudrizwan.claude-dev', 'temp.lock'), 'locked', 'utf8');

		await fs.mkdir(path.join(aexusGlobalStorage, 'saoudrizwan.claude-dev', 'settings'), { recursive: true });
		await fs.writeFile(path.join(aexusGlobalStorage, 'saoudrizwan.claude-dev', 'settings', 'existing.json'), '{"from":"aexus"}', 'utf8');

		// Extensions: openai.chatgpt already installed in Aexus (newer version), zgy.opencode-vscode-ui missing in Aexus
		const vsChatgptDir = path.join(vsExts, 'openai.chatgpt-26.1021.22027-darwin-arm64');
		const aexusChatgptDir = path.join(aexusExts, 'openai.chatgpt-26.51111.21308-darwin-arm64');
		const vsOpenCodeDir = path.join(vsExts, 'zgy.opencode-vscode-ui-0.0.7');
		await fs.mkdir(vsChatgptDir, { recursive: true });
		await fs.mkdir(aexusChatgptDir, { recursive: true });
		await fs.mkdir(vsOpenCodeDir, { recursive: true });
		await fs.writeFile(path.join(vsChatgptDir, 'package.json'), '{"version":"26.1021.22027"}', 'utf8');
		await fs.writeFile(path.join(aexusChatgptDir, 'package.json'), '{"version":"26.51111.21308"}', 'utf8');
		await fs.writeFile(path.join(vsOpenCodeDir, 'package.json'), '{"version":"0.0.7"}', 'utf8');
		await fs.writeFile(path.join(vsExts, 'extensions.json'), JSON.stringify([
			{
				identifier: { id: 'openai.chatgpt' },
				version: '26.1021.22027',
				relativeLocation: 'openai.chatgpt-26.1021.22027-darwin-arm64',
				location: { $mid: 1, path: vsChatgptDir, scheme: 'file' },
			},
			{
				identifier: { id: 'zgy.opencode-vscode-ui' },
				version: '0.0.7',
				relativeLocation: 'zgy.opencode-vscode-ui-0.0.7',
				location: { $mid: 1, path: vsOpenCodeDir, scheme: 'file' },
			},
		]), 'utf8');
		await fs.writeFile(path.join(aexusExts, 'extensions.json'), JSON.stringify([
			{
				identifier: { id: 'openai.chatgpt' },
				version: '26.51111.21308',
				relativeLocation: 'openai.chatgpt-26.51111.21308-darwin-arm64',
				location: { $mid: 1, path: aexusChatgptDir, scheme: 'file' },
			},
		]), 'utf8');

		const result = await migrateVsCodeStateAndExtensionsToAexus({
			vsCodeUserDataDir: vsUserData,
			vsCodeExtensionsDir: vsExts,
			aexusGlobalStorageDir: aexusGlobalStorage,
			aexusExtensionsDir: aexusExts,
		});

		assert.deepStrictEqual(result.copiedExtensions, ['zgy.opencode-vscode-ui']);
		assert.strictEqual(result.copiedStorageFiles, 1);

		await withSqliteDb(aexusDbPath, sqlite3.default.OPEN_READONLY, async db => {
			const rows = await dbAll(db, 'SELECT key, value FROM ItemTable');
			const byKey = new Map(rows.map(r => [r.key, r.value]));

			assert.strictEqual(byKey.has('secret://{"extensionId":"google.google-antigravity","key":"antigravity.authSync"}'), false);
			assert.strictEqual(byKey.has('unrelated.extension'), false);

			const agy = JSON.parse(byKey.get('google.google-antigravity')!) as Record<string, unknown>;
			assert.strictEqual(agy['antigravity.lastInstalledReleaseBaseUrl'], 'https://aexus-keep.example');
			assert.deepStrictEqual(agy['antigravity-storage'], { 'agy.onboarding.lastLoginUsername': 'user@example.com' });

			const dsh = JSON.parse(byKey.get('Fengze233.dsh-vscode-panel')!) as Record<string, unknown>;
			assert.strictEqual(dsh['dsh.secondaryGuideShown'], true);
			assert.deepStrictEqual(dsh['auth-session:127.0.0.1:3080'], { issuedAt: 999 });

			const cline = JSON.parse(byKey.get('saoudrizwan.claude-dev')!) as Record<string, unknown>;
			assert.strictEqual(cline.welcomeViewCompleted, true);
			assert.strictEqual(cline['cline.rollout.bundle'], 'next');

			const kilo = JSON.parse(byKey.get('kilocode.kilo-code')!) as Record<string, unknown>;
			assert.deepStrictEqual(kilo.recentModels, [{ providerID: 'openai', modelID: 'gpt-6.1-sol' }]);
		});

		assert.strictEqual(await fs.readFile(path.join(aexusGlobalStorage, 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), 'utf8'), '{"from":"vscode"}');
		assert.strictEqual(await fs.readFile(path.join(aexusGlobalStorage, 'saoudrizwan.claude-dev', 'settings', 'existing.json'), 'utf8'), '{"from":"aexus"}');
		await assert.rejects(() => fs.access(path.join(aexusGlobalStorage, 'saoudrizwan.claude-dev', 'temp.lock')));

		// Existing ChatGPT extension remained untouched; OpenCode UI copied + registered
		assert.strictEqual(await fs.readFile(path.join(aexusChatgptDir, 'package.json'), 'utf8'), '{"version":"26.51111.21308"}');
		assert.strictEqual(await fs.readFile(path.join(aexusExts, 'zgy.opencode-vscode-ui-0.0.7', 'package.json'), 'utf8'), '{"version":"0.0.7"}');
		const aexusReg = JSON.parse(await fs.readFile(path.join(aexusExts, 'extensions.json'), 'utf8')) as Array<{ identifier: { id: string }; location: { path: string } }>;
		assert.strictEqual(aexusReg.length, 2);
		assert.strictEqual(aexusReg.find(e => e.identifier.id === 'zgy.opencode-vscode-ui')?.location.path, path.join(aexusExts, 'zgy.opencode-vscode-ui-0.0.7'));
	});
});
