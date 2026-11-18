/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as cp from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import { VSBuffer } from '../../../../base/common/buffer.js';
import * as path from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IAdeCloudHost } from '../../common/adeCloudHosts.js';
import { AdeCloudHostNodeService, IAdeCloudHostNodeServiceOptions, parseOpenSshConfigFiles } from '../../node/adeCloudHostService.js';

/**
 * A minimal stand-in for OpenSSH used by the remote transport tests. It consumes the
 * `[options] -- <target> <remote-command>` argument shape and executes the remote command
 * locally through `sh`, so no network, sshd or credentials are ever required.
 */
const MOCK_SSH_SCRIPT = [
	'#!/bin/sh',
	'# Test double for OpenSSH: run the requested remote command on the local machine.',
	'while [ $# -gt 0 ]; do',
	'  if [ "$1" = "--" ]; then',
	'    shift',
	'    break',
	'  fi',
	'  shift',
	'done',
	'target="$1"',
	'shift',
	'remote_command="$1"',
	'if [ "$target" = "broken-host" ]; then',
	'  echo "ssh: connect to host broken-host port 22: Connection refused" >&2',
	'  exit 255',
	'fi',
	'exec /bin/sh -c "$remote_command"',
	'',
].join('\n');

async function writeText(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, 'utf8');
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function createMockSsh(root: string): Promise<string> {
	const scriptPath = path.join(root, 'mock-ssh.sh');
	await fs.writeFile(scriptPath, MOCK_SSH_SCRIPT, { encoding: 'utf8', mode: 0o755 });
	await fs.chmod(scriptPath, 0o755);
	return scriptPath;
}

function runGitSync(cwd: string, args: string[]): void {
	cp.execFileSync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function summarizeHost(host: IAdeCloudHost) {
	return {
		name: host.name,
		alias: host.alias,
		hostName: host.hostName,
		user: host.user,
		port: host.port,
		os: host.os,
		identityFile: host.identityFile,
		defaultDirectory: host.defaultDirectory,
		recentDirectories: host.recentDirectories,
		source: host.source,
	};
}

interface IMockEnvironment {
	readonly homedir: string;
	readonly userDataPath: string;
	readonly vsCodeUserDataDir: string;
	readonly sshConfigPath: string;
}

/**
 * Seeds a fake VS Code / Aexus profile: SSH config, VS Code `settings.json`, `storage.json`,
 * Project Manager projects plus the legacy Aexus `hosts.json` / `workspaces.json`.
 */
async function seedMockEnvironment(root: string): Promise<IMockEnvironment> {
	const homedir = path.join(root, 'home');
	const userDataPath = path.join(root, 'aexus');
	const vsCodeUserDataDir = path.join(root, 'vscode');
	const sshConfigPath = path.join(homedir, '.ssh', 'config');

	await writeText(sshConfigPath, [
		'Host gpu-box',
		'    HostName 10.1.2.3',
		'    User gpu',
		'    Port 2200',
		'',
		'Host ssh-host-alias',
		'    HostName dev.example.com',
		'    User dev',
		'    IdentityFile ~/.ssh/id_dev',
		'',
		'Host ip-alias',
		'    HostName 192.168.7.9',
		'    User ubuntu',
		'',
		'Host 192.168.7.9',
		'    HostName 192.168.7.9',
		'    User ubuntu',
		'',
		'Host win-box',
		'    HostName win.example.com',
		'    User admin',
		'',
	].join('\n'));

	await writeText(path.join(vsCodeUserDataDir, 'User', 'settings.json'), [
		'{',
		'  // Mock VS Code user settings: JSONC comments must be tolerated.',
		'  "remote.SSH.remotePlatform": {',
		'    "gpu-box": "linux",',
		'    "ssh-host-alias": "macos",',
		'    "win-box": "windows",',
		'    "192.168.7.9": "linux"',
		'  }',
		'}',
		'',
	].join('\n'));

	await writeJson(path.join(vsCodeUserDataDir, 'User', 'globalStorage', 'storage.json'), {
		profileAssociations: {
			workspaces: {
				'vscode-remote://ssh-remote+ssh-host-alias/home/dev/proj': { profile: 'default' },
				'vscode-remote://local-only/tmp/local': { profile: 'default' },
			},
		},
		backupWorkspaces: {
			folders: [
				{ folderUri: 'vscode-remote://ssh-remote+gpu-box/srv/gpu' },
				{ folderUri: 'vscode-remote://ssh-remote+deploy%40win-box%3A2222/C%3A/Users/deploy/work' },
			],
		},
	});

	await writeJson(path.join(vsCodeUserDataDir, 'User', 'globalStorage', 'alefragnani.project-manager', 'projects.json'), [
		{ name: 'Remote app', rootPath: 'vscode-remote://ssh-remote+ssh-host-alias/work/other' },
		{ name: 'Local app', rootPath: '/Users/someone/local-app' },
	]);

	await writeJson(path.join(userDataPath, 'hosts.json'), [
		{
			id: 'legacy-1',
			name: 'Legacy Box',
			alias: 'legacy-box',
			host: 'root@legacy.example.com',
			port: 2201,
			os: 'linux',
			defaultDirectory: '/srv/legacy',
			identityFile: '/home/ci/.ssh/id_legacy',
			password: 'super-secret-password',
			privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
			passphrase: 'super-secret-passphrase',
			token: 'super-secret-token',
		},
		{
			id: 'legacy-2',
			name: 'Orphan Legacy',
			alias: 'orphan-legacy',
			host: 'orphan.example.com',
		},
	]);

	await writeJson(path.join(userDataPath, 'workspaces.json'), {
		entries: [
			{ hostId: 'legacy-1', directory: '/srv/legacy-app' },
		],
	});

	return { homedir, userDataPath, vsCodeUserDataDir, sshConfigPath };
}

suite('AdeCloudHosts', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let tmpDir: string;

	setup(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-cloud-host-'));
	});

	teardown(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	suite('parseOpenSshConfigFiles', () => {
		test('parses multi-alias Host lines and keeps OpenSSH first-seen-wins semantics', async () => {
			const homedir = path.join(tmpDir, 'home');
			const sshDir = path.join(homedir, '.ssh');
			const configPath = path.join(sshDir, 'config');
			await writeText(configPath, [
				'# Leading comment must be ignored',
				'Host web-prod db-prod   # two aliases on one line',
				'  HostName 10.0.0.5',
				'  User deploy',
				'  Port 2222',
				'  IdentityFile "~/.ssh/id_prod"',
				'',
				'Host web-prod',
				'  HostName ignored.example.com',
				'  User ignored',
				'  Port 9999',
				'',
				'Host=auth-box',
				'  HostName auth.example.com',
				'  ProxyJump bastion',
				'  UserKnownHostsFile ~/.ssh/known_auth',
				'  StrictHostKeyChecking accept-new',
				'',
			].join('\n'));

			const parsed = await parseOpenSshConfigFiles(configPath, homedir);

			assert.deepStrictEqual([...parsed.keys()], ['web-prod', 'db-prod', 'auth-box']);
			assert.deepStrictEqual(parsed.get('web-prod'), {
				alias: 'web-prod',
				hostName: '10.0.0.5',
				user: 'deploy',
				port: 2222,
				identityFile: path.join(homedir, '.ssh', 'id_prod'),
			});
			assert.deepStrictEqual(parsed.get('db-prod'), {
				alias: 'db-prod',
				hostName: '10.0.0.5',
				user: 'deploy',
				port: 2222,
				identityFile: path.join(homedir, '.ssh', 'id_prod'),
			});
			assert.deepStrictEqual(parsed.get('auth-box'), {
				alias: 'auth-box',
				hostName: 'auth.example.com',
				port: 22,
				proxyJump: 'bastion',
				knownHostsFile: path.join(homedir, '.ssh', 'known_auth'),
				strictHostKeyChecking: 'accept-new',
			});
		});

		test('follows recursive Include directives with quoted paths, globs and cycle protection', async () => {
			const homedir = path.join(tmpDir, 'home');
			const sshDir = path.join(homedir, '.ssh');
			const confDir = path.join(sshDir, 'conf.d');
			const sharedDir = path.join(homedir, 'shared');
			const spacedDir = path.join(tmpDir, 'config maps');
			const configPath = path.join(sshDir, 'config');
			const spacedConfigPath = path.join(spacedDir, 'spaced.conf');

			await writeText(path.join(confDir, '01-base.conf'), [
				'Include conf.d/02-nested.conf',
				'',
				'Host base-host',
				'    HostName base.example.com',
				'    User base',
				'',
			].join('\n'));
			await writeText(path.join(confDir, '02-nested.conf'), [
				'Include conf.d/01-base.conf',
				'',
				'Host nested-host',
				'    HostName nested.example.com',
				'    Port 2200',
				'',
			].join('\n'));
			await writeText(path.join(sharedDir, 'extra.conf'), [
				'Host extra-host',
				'    HostName extra.example.com',
				'',
			].join('\n'));
			await writeText(spacedConfigPath, [
				'Host spaced-host',
				'    HostName spaced.example.com',
				'',
			].join('\n'));
			await writeText(configPath, [
				'Include "conf.d/01-base.conf"',
				'Include ~/shared/*.conf',
				'Include conf.d/01-base.conf',
				`Include "${spacedConfigPath}"`,
				'',
				'Host base-host',
				'    HostName override.example.com',
				'    User override',
				'',
			].join('\n'));

			const parsed = await parseOpenSshConfigFiles(configPath, homedir);

			assert.deepStrictEqual([...parsed.keys()], ['nested-host', 'base-host', 'extra-host', 'spaced-host']);
			assert.deepStrictEqual(parsed.get('nested-host'), {
				alias: 'nested-host',
				hostName: 'nested.example.com',
				port: 2200,
			});
			// The included file is parsed first, so its options win over the later entry file block.
			assert.deepStrictEqual(parsed.get('base-host'), {
				alias: 'base-host',
				hostName: 'base.example.com',
				user: 'base',
				port: 22,
			});
			assert.deepStrictEqual(parsed.get('extra-host'), {
				alias: 'extra-host',
				hostName: 'extra.example.com',
				port: 22,
			});
			assert.deepStrictEqual(parsed.get('spaced-host'), {
				alias: 'spaced-host',
				hostName: 'spaced.example.com',
				port: 22,
			});
		});

		test('applies Host * defaults without overriding explicit values or creating wildcard records', async () => {
			const homedir = path.join(tmpDir, 'home');
			const configPath = path.join(homedir, '.ssh', 'config');
			await writeText(configPath, [
				'Host *',
				'    User global-user',
				'    Port 2201',
				'    IdentityFile "~/.ssh/id_global"',
				'',
				'Host *.corp.example.com',
				'    User wildcard-user',
				'',
				'Host defaults-only',
				'',
				'Host explicit',
				'    HostName explicit.example.com',
				'    User explicit-user',
				'    Port 2222',
				'',
			].join('\n'));

			const parsed = await parseOpenSshConfigFiles(configPath, homedir);

			assert.deepStrictEqual([...parsed.keys()], ['defaults-only', 'explicit']);
			assert.deepStrictEqual(parsed.get('defaults-only'), {
				alias: 'defaults-only',
				hostName: 'defaults-only',
				user: 'global-user',
				port: 2201,
				identityFile: path.join(homedir, '.ssh', 'id_global'),
			});
			assert.deepStrictEqual(parsed.get('explicit'), {
				alias: 'explicit',
				hostName: 'explicit.example.com',
				user: 'explicit-user',
				port: 2222,
				identityFile: path.join(homedir, '.ssh', 'id_global'),
			});
		});
	});

	suite('importFromVsCodeAndSshConfig', () => {
		test('auto-imports hosts from SSH config, VS Code state, Project Manager and legacy Aexus files', async () => {
			const env = await seedMockEnvironment(tmpDir);
			const svc = disposables.add(new AdeCloudHostNodeService({ ...env }));

			const hosts = await svc.listHosts();
			const byAlias = new Map(hosts.map(h => [h.alias, h]));

			assert.deepStrictEqual([...byAlias.keys()].sort(), [
				'gpu-box', 'ip-alias', 'legacy-box', 'orphan-legacy', 'ssh-host-alias', 'win-box',
			]);
			assert.deepStrictEqual(summarizeHost(byAlias.get('gpu-box')!), {
				name: 'gpu-box',
				alias: 'gpu-box',
				hostName: '10.1.2.3',
				user: 'gpu',
				port: 2200,
				os: 'linux',
				identityFile: undefined,
				defaultDirectory: '/srv/gpu',
				recentDirectories: ['/srv/gpu'],
				source: 'vscode',
			});
			assert.deepStrictEqual(summarizeHost(byAlias.get('ssh-host-alias')!), {
				name: 'ssh-host-alias',
				alias: 'ssh-host-alias',
				hostName: 'dev.example.com',
				user: 'dev',
				port: 22,
				os: 'macos',
				identityFile: path.join(env.homedir, '.ssh', 'id_dev'),
				defaultDirectory: '/home/dev/proj',
				recentDirectories: ['/home/dev/proj', '/work/other'],
				source: 'vscode',
			});
			assert.deepStrictEqual(summarizeHost(byAlias.get('ip-alias')!), {
				name: 'ip-alias',
				alias: 'ip-alias',
				hostName: '192.168.7.9',
				user: 'ubuntu',
				port: 22,
				os: 'linux',
				identityFile: undefined,
				defaultDirectory: undefined,
				recentDirectories: [],
				source: 'ssh-config',
			});
			assert.deepStrictEqual(summarizeHost(byAlias.get('win-box')!), {
				name: 'win-box',
				alias: 'win-box',
				hostName: 'win.example.com',
				user: 'admin',
				port: 22,
				os: 'windows',
				identityFile: undefined,
				defaultDirectory: '/C:/Users/deploy/work',
				recentDirectories: ['/C:/Users/deploy/work'],
				source: 'vscode',
			});
			assert.deepStrictEqual(summarizeHost(byAlias.get('legacy-box')!), {
				name: 'Legacy Box',
				alias: 'legacy-box',
				hostName: 'legacy.example.com',
				user: 'root',
				port: 2201,
				os: 'linux',
				identityFile: '/home/ci/.ssh/id_legacy',
				defaultDirectory: '/srv/legacy',
				recentDirectories: ['/srv/legacy-app', '/srv/legacy'],
				source: 'vscode',
			});
			assert.deepStrictEqual(summarizeHost(byAlias.get('orphan-legacy')!), {
				name: 'Orphan Legacy',
				alias: 'orphan-legacy',
				hostName: 'orphan.example.com',
				user: undefined,
				port: 22,
				os: 'linux',
				identityFile: undefined,
				defaultDirectory: undefined,
				recentDirectories: [],
				source: 'aexus-legacy',
			});

			// Duplicate raw-IP aliases are folded into the equivalent named alias.
			assert.strictEqual(byAlias.has('192.168.7.9'), false);
			// Legacy IDs survive the migration.
			assert.strictEqual(byAlias.get('legacy-box')!.id, 'legacy-1');
			assert.strictEqual(byAlias.get('orphan-legacy')!.id, 'legacy-2');

			// Secrets stored by the legacy file must never be carried over.
			const serialized = JSON.stringify(hosts);
			assert.strictEqual(serialized.includes('super-secret'), false);
			assert.strictEqual(serialized.includes('BEGIN OPENSSH PRIVATE KEY'), false);
			assert.strictEqual(serialized.includes('passphrase'), false);
			assert.strictEqual(serialized.includes('password'), false);

			// Auto-import persists the imported hosts.
			assert.strictEqual(await exists(path.join(env.userDataPath, 'cloud-hosts.json')), true);
		});

		test('reports import counts and is idempotent on subsequent imports', async () => {
			const env = await seedMockEnvironment(tmpDir);
			const svc = disposables.add(new AdeCloudHostNodeService({ ...env, autoImportOnFirstLoad: false }));

			const first = await svc.importFromVsCodeAndSshConfig();
			assert.deepStrictEqual(
				{
					importedCount: first.importedCount,
					updatedCount: first.updatedCount,
					totalHosts: first.totalHosts,
					importedRecentFolders: first.importedRecentFolders,
				},
				{
					importedCount: 6,
					updatedCount: 0,
					totalHosts: 6,
					importedRecentFolders: 6,
				},
			);

			const second = await svc.importFromVsCodeAndSshConfig();
			assert.deepStrictEqual(
				{
					importedCount: second.importedCount,
					updatedCount: second.updatedCount,
					totalHosts: second.totalHosts,
					importedRecentFolders: second.importedRecentFolders,
				},
				{
					importedCount: 0,
					updatedCount: 0,
					totalHosts: 6,
					importedRecentFolders: 0,
				},
			);
		});

		test('honors remote.SSH.configFile from the VS Code user settings', async () => {
			const homedir = path.join(tmpDir, 'home');
			const customSshConfigPath = path.join(homedir, 'custom', 'ssh_config');
			const vsCodeUserDataDir = path.join(tmpDir, 'vscode');
			await writeText(customSshConfigPath, [
				'Host custom-host',
				'    HostName custom.example.com',
				'    User custom-user',
				'    Port 2022',
				'',
			].join('\n'));
			await writeJson(path.join(vsCodeUserDataDir, 'User', 'settings.json'), {
				'remote.SSH.configFile': '~/custom/ssh_config',
			});

			const svc = disposables.add(new AdeCloudHostNodeService({
				homedir,
				userDataPath: path.join(tmpDir, 'aexus'),
				vsCodeUserDataDir,
				sshConfigPath: path.join(homedir, '.ssh', 'config'),
				autoImportOnFirstLoad: false,
			}));

			const result = await svc.importFromVsCodeAndSshConfig();
			assert.deepStrictEqual(result.hosts.map(h => summarizeHost(h)), [{
				name: 'custom-host',
				alias: 'custom-host',
				hostName: 'custom.example.com',
				user: 'custom-user',
				port: 2022,
				os: 'linux',
				identityFile: undefined,
				defaultDirectory: undefined,
				recentDirectories: [],
				source: 'ssh-config',
			}]);

			const effectiveContent = await fs.readFile(await svc.getEffectiveSshConfigPath(), 'utf8');
			assert.ok(effectiveContent.includes(`Include "${customSshConfigPath}"`));
		});
	});

	suite('host management', () => {
		function createService(root: string, options: Partial<IAdeCloudHostNodeServiceOptions> = {}): AdeCloudHostNodeService {
			return new AdeCloudHostNodeService({
				homedir: path.join(root, 'home'),
				userDataPath: path.join(root, 'aexus'),
				vsCodeUserDataDir: path.join(root, 'vscode'),
				sshConfigPath: path.join(root, 'home', '.ssh', 'config'),
				autoImportOnFirstLoad: false,
				...options,
			});
		}

		test('upserts, updates and persists a host without duplicating it', async () => {
			const svc = disposables.add(createService(tmpDir));
			let changeEvents = 0;
			disposables.add(svc.onDidChangeHosts(() => changeEvents++));

			const created = await svc.upsertHost({
				name: 'My Staging Box',
				hostName: 'deploy@staging.example.com:2222',
				defaultDirectory: 'srv/app',
				identityFile: '~/.ssh/id_staging',
			});
			assert.deepStrictEqual(summarizeHost(created), {
				name: 'My Staging Box',
				alias: 'My-Staging-Box',
				hostName: 'staging.example.com',
				user: 'deploy',
				port: 2222,
				os: 'linux',
				identityFile: path.join(tmpDir, 'home', '.ssh', 'id_staging'),
				defaultDirectory: '/srv/app',
				recentDirectories: ['/srv/app'],
				source: 'user',
			});
			assert.strictEqual(changeEvents, 1);

			// Lookup by id, alias and name (case-insensitive fallback).
			assert.deepStrictEqual(await svc.getHost(created.id), created);
			assert.deepStrictEqual(await svc.getHost('My-Staging-Box'), created);
			assert.deepStrictEqual(await svc.getHost('my staging box'), created);

			const updated = await svc.upsertHost({
				id: created.id,
				name: 'My Staging Box',
				hostName: 'staging2.example.com',
				user: 'admin',
				port: 2200,
				defaultDirectory: '/deploy/app',
				recentDirectories: ['/srv/extra', 'deploy/current'],
			});

			assert.strictEqual(updated.id, created.id);
			assert.strictEqual(updated.createdAt, created.createdAt);
			assert.ok(updated.updatedAt >= created.updatedAt);
			assert.deepStrictEqual(summarizeHost(updated), {
				name: 'My Staging Box',
				alias: 'My-Staging-Box',
				hostName: 'staging2.example.com',
				user: 'admin',
				port: 2200,
				os: 'linux',
				identityFile: path.join(tmpDir, 'home', '.ssh', 'id_staging'),
				defaultDirectory: '/deploy/app',
				recentDirectories: ['/deploy/app', '/srv/extra', '/deploy/current', '/srv/app'],
				source: 'user',
			});
			assert.strictEqual((await svc.listHosts()).length, 1);
			assert.strictEqual(changeEvents, 2);

			const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, 'aexus', 'cloud-hosts.json'), 'utf8')) as IAdeCloudHost[];
			assert.deepStrictEqual(persisted.map(h => ({ id: h.id, alias: h.alias, hostName: h.hostName })), [{
				id: created.id,
				alias: 'My-Staging-Box',
				hostName: 'staging2.example.com',
			}]);
		});

		test('rejects upserts without a name or address', async () => {
			const svc = disposables.add(createService(tmpDir));

			await assert.rejects(() => svc.upsertHost({ name: '', hostName: '' }), /Cloud Host name is required/);
			await assert.rejects(() => svc.upsertHost({ name: 'No Address', hostName: '   ' }), /Cloud Host address/);
			assert.deepStrictEqual(await svc.listHosts(), []);
		});

		test('deletes hosts by alias and id and reports misses', async () => {
			const svc = disposables.add(createService(tmpDir));
			let changeEvents = 0;
			disposables.add(svc.onDidChangeHosts(() => changeEvents++));

			const alpha = await svc.upsertHost({ name: 'Alpha', hostName: 'alpha.example.com' });
			const beta = await svc.upsertHost({ name: 'Beta', hostName: 'beta.example.com' });

			assert.strictEqual(await svc.deleteHost('Alpha'), true);
			assert.strictEqual(await svc.deleteHost(alpha.id), false);
			assert.strictEqual(await svc.getHost('Alpha'), undefined);
			assert.strictEqual(await svc.deleteHost(beta.id), true);
			assert.deepStrictEqual(await svc.listHosts(), []);
			assert.strictEqual(await svc.deleteHost('beta'), false);
			assert.strictEqual(changeEvents, 4);

			const raw = await fs.readFile(path.join(tmpDir, 'aexus', 'cloud-hosts.json'), 'utf8');
			assert.deepStrictEqual(JSON.parse(raw), []);
		});

		test('records recent directories with de-duplication and OS-specific path normalization', async () => {
			const svc = disposables.add(createService(tmpDir));

			const linuxHost = await svc.upsertHost({
				name: 'Linux Box',
				hostName: 'linux.example.com',
				defaultDirectory: '/srv/app',
			});
			const first = await svc.recordRecentDirectory(linuxHost.id, '/srv/other');
			assert.deepStrictEqual(first?.recentDirectories, ['/srv/other', '/srv/app']);
			assert.strictEqual(first?.defaultDirectory, '/srv/app');

			const second = await svc.recordRecentDirectory(linuxHost.alias, '/srv/app');
			assert.deepStrictEqual(second?.recentDirectories, ['/srv/app', '/srv/other']);
			assert.strictEqual(second?.defaultDirectory, '/srv/app');

			assert.strictEqual(await svc.recordRecentDirectory('does-not-exist', '/srv/x'), undefined);

			const windowsHost = await svc.upsertHost({
				name: 'Win Box',
				hostName: 'win.example.com',
				os: 'windows',
				defaultDirectory: 'C:\\work\\app',
			});
			assert.strictEqual(windowsHost.defaultDirectory, '/C:/work/app');
			const winUpdated = await svc.recordRecentDirectory(windowsHost.id, 'D:\\data');
			assert.deepStrictEqual(winUpdated?.recentDirectories, ['/D:/data', '/C:/work/app']);
		});

		test('generates an effective SSH config where managed hosts precede the user config', async () => {
			const homedir = path.join(tmpDir, 'home');
			const userSshConfigPath = path.join(homedir, '.ssh', 'config');
			await writeText(userSshConfigPath, 'Host personal\n    HostName personal.example.com\n');

			const svc = disposables.add(createService(tmpDir));
			await svc.upsertHost({
				name: 'My Staging Box',
				hostName: 'deploy@staging.example.com:2222',
				defaultDirectory: 'srv/app',
				identityFile: '~/.ssh/id_staging',
			});

			const effectivePath = await svc.getEffectiveSshConfigPath();
			const managedPath = path.join(tmpDir, 'aexus', 'ssh', 'aexus-managed-hosts.conf');
			assert.strictEqual(effectivePath, path.join(tmpDir, 'aexus', 'ssh', 'effective_ssh_config'));

			const effectiveContent = await fs.readFile(effectivePath, 'utf8');
			assert.deepStrictEqual(effectiveContent, [
				'# Effective SSH config generated by Aexus Code (Aexus managed hosts take precedence, then user ~/.ssh/config).',
				`Include "${managedPath}"`,
				`Include "${userSshConfigPath}"`,
				'',
			].join('\n'));
			assert.ok(effectiveContent.indexOf(`Include "${managedPath}"`) < effectiveContent.indexOf(`Include "${userSshConfigPath}"`));

			const managedContent = await fs.readFile(managedPath, 'utf8');
			assert.deepStrictEqual(managedContent, [
				'# Managed by Aexus Code Cloud Hosts. Private keys and credentials are never stored in this file.',
				'',
				'Host My-Staging-Box',
				'    HostName staging.example.com',
				'    User deploy',
				'    Port 2222',
				`    IdentityFile "${path.join(homedir, '.ssh', 'id_staging')}"`,
				'    IdentitiesOnly yes',
				'    ServerAliveInterval 15',
				'    ServerAliveCountMax 3',
				'',
			].join('\n'));
		});

		test('omits the user Include when ~/.ssh/config does not exist yet', async () => {
			const svc = disposables.add(createService(tmpDir));
			await svc.upsertHost({ name: 'Solo', hostName: 'solo.example.com' });

			const effectivePath = await svc.getEffectiveSshConfigPath();
			const managedPath = path.join(tmpDir, 'aexus', 'ssh', 'aexus-managed-hosts.conf');
			assert.deepStrictEqual(await fs.readFile(effectivePath, 'utf8'), [
				'# Effective SSH config generated by Aexus Code (Aexus managed hosts take precedence, then user ~/.ssh/config).',
				`Include "${managedPath}"`,
				'',
			].join('\n'));
		});
	});

	(isWindows ? suite.skip : suite)('remote transport', () => {
		async function createService(root: string): Promise<AdeCloudHostNodeService> {
			const homedir = path.join(root, 'home');
			const svc = new AdeCloudHostNodeService({
				homedir,
				userDataPath: path.join(root, 'aexus'),
				vsCodeUserDataDir: path.join(root, 'vscode'),
				sshConfigPath: path.join(homedir, '.ssh', 'config'),
				autoImportOnFirstLoad: false,
				sshExecutable: await createMockSsh(root),
			});
			await svc.upsertHost({ name: 'Mock Host', alias: 'mock-host', hostName: 'mock.example.com', os: 'linux' });
			return svc;
		}

		test('reports successful and failed connection checks', async () => {
			const svc = disposables.add(await createService(tmpDir));

			const check = await svc.testConnection('mock-host');
			const expectedOs = os.type() === 'Darwin' ? 'macos' : 'linux';
			assert.deepStrictEqual(
				{ ok: check.ok, os: check.os, remoteUname: check.remoteUname, remoteHome: check.remoteHome },
				{ ok: true, os: expectedOs, remoteUname: os.type(), remoteHome: os.homedir() },
			);
			assert.strictEqual(typeof check.latencyMs, 'number');
			const stored = await svc.getHost('mock-host');
			assert.deepStrictEqual(
				{ ok: stored?.lastTestStatus?.ok, os: stored?.lastTestStatus?.os },
				{ ok: true, os: expectedOs },
			);

			await svc.upsertHost({ name: 'Broken Host', alias: 'broken-host', hostName: 'broken.example.com', os: 'linux' });
			const failed = await svc.testConnection('broken-host');
			assert.strictEqual(failed.ok, false);
			assert.ok(failed.error?.includes('Connection refused'));
			assert.strictEqual((await svc.getHost('broken-host'))?.lastTestStatus?.ok, false);
		});

		test('stats, lists and reads remote files and directories', async () => {
			const remoteRoot = path.join(tmpDir, 'remote');
			await writeText(path.join(remoteRoot, 'hello.txt'), 'hello world\n');
			await writeText(path.join(remoteRoot, 'sub', 'nested.txt'), 'nested\n');
			await writeText(path.join(remoteRoot, 'plain.txt'), 'plain\n');
			const svc = disposables.add(await createService(tmpDir));

			const dirStat = await svc.remoteStat('mock-host', remoteRoot);
			assert.strictEqual(dirStat.type, 'directory');
			assert.ok(dirStat.mtime > 0);
			assert.strictEqual(dirStat.ctime, dirStat.mtime);

			const fileStat = await svc.remoteStat('mock-host', path.join(remoteRoot, 'hello.txt'));
			assert.deepStrictEqual({ type: fileStat.type, size: fileStat.size }, { type: 'file', size: 'hello world\n'.length });

			const entries = await svc.remoteReadDir('mock-host', remoteRoot);
			assert.deepStrictEqual(
				entries.map(e => `${e.type}:${e.name}`).sort(),
				['directory:sub', 'file:hello.txt', 'file:plain.txt'],
			);

			assert.strictEqual((await svc.remoteReadFile('mock-host', path.join(remoteRoot, 'hello.txt'))).toString(), 'hello world\n');
			assert.strictEqual((await svc.remoteReadFile('mock-host', path.join(remoteRoot, 'sub', 'nested.txt'))).toString(), 'nested\n');

			await assert.rejects(() => svc.remoteStat('mock-host', path.join(remoteRoot, 'missing.txt')), /\[ENOENT\]/);
			await assert.rejects(() => svc.remoteReadDir('mock-host', path.join(remoteRoot, 'missing')), /\[ENOENT\]/);
			await assert.rejects(() => svc.remoteReadDir('mock-host', path.join(remoteRoot, 'plain.txt')), /\[ENOTDIR\]/);
			await assert.rejects(() => svc.remoteReadFile('mock-host', path.join(remoteRoot, 'missing.txt')), /\[ENOENT\]/);
			await assert.rejects(() => svc.remoteReadFile('mock-host', path.join(remoteRoot, 'sub')), /\[EISDIR\]/);
		});

		test('writes, creates directories, renames, copies and deletes remote paths', async () => {
			const remoteRoot = path.join(tmpDir, 'remote');
			await fs.mkdir(remoteRoot, { recursive: true });
			const svc = disposables.add(await createService(tmpDir));

			// Write (with implicit parent directory creation) and overwrite semantics.
			const nestedFile = path.join(remoteRoot, 'nested', 'deep', 'created.txt');
			await svc.remoteWriteFile('mock-host', nestedFile, VSBuffer.fromString('created content'), { create: true, overwrite: true });
			assert.strictEqual(await fs.readFile(nestedFile, 'utf8'), 'created content');
			await assert.rejects(
				() => svc.remoteWriteFile('mock-host', nestedFile, VSBuffer.fromString('again'), { create: true, overwrite: false }),
				/\[EEXIST\]/,
			);
			await svc.remoteWriteFile('mock-host', nestedFile, VSBuffer.fromString('replaced content'), { create: true, overwrite: true });
			assert.strictEqual(await fs.readFile(nestedFile, 'utf8'), 'replaced content');
			await assert.rejects(
				() => svc.remoteWriteFile('mock-host', path.join(remoteRoot, 'missing.txt'), VSBuffer.fromString('x'), { create: false, overwrite: true }),
				/\[ENOENT\]/,
			);

			// Mkdir is recursive.
			const madeDir = path.join(remoteRoot, 'made', 'nested');
			await svc.remoteMkdir('mock-host', madeDir);
			assert.strictEqual((await fs.stat(madeDir)).isDirectory(), true);
			assert.deepStrictEqual(await svc.remoteReadDir('mock-host', madeDir), []);

			// Rename with and without overwrite.
			const renameFrom = path.join(remoteRoot, 'move-me.txt');
			await writeText(renameFrom, 'move\n');
			const renameTo = path.join(remoteRoot, 'moved', 'dest.txt');
			await svc.remoteRename('mock-host', renameFrom, renameTo, false);
			assert.strictEqual(await fs.readFile(renameTo, 'utf8'), 'move\n');
			assert.strictEqual(await exists(renameFrom), false);

			const occupied = path.join(remoteRoot, 'occupied.txt');
			await writeText(occupied, 'occupied\n');
			await assert.rejects(() => svc.remoteRename('mock-host', renameTo, occupied, false), /\[EEXIST\]/);
			await svc.remoteRename('mock-host', renameTo, occupied, true);
			assert.strictEqual(await fs.readFile(occupied, 'utf8'), 'move\n');
			await assert.rejects(
				() => svc.remoteRename('mock-host', path.join(remoteRoot, 'missing.txt'), occupied, true),
				/\[ENOENT\]/,
			);

			// Copy files and directories.
			const copySource = path.join(remoteRoot, 'copy-src.txt');
			await writeText(copySource, 'copy me\n');
			const copyTarget = path.join(remoteRoot, 'copies', 'copy-dst.txt');
			await svc.remoteCopy('mock-host', copySource, copyTarget, false);
			assert.strictEqual(await fs.readFile(copyTarget, 'utf8'), 'copy me\n');
			await assert.rejects(() => svc.remoteCopy('mock-host', copySource, copyTarget, false), /\[EEXIST\]/);
			await svc.remoteCopy('mock-host', copySource, copyTarget, true);
			assert.strictEqual(await fs.readFile(copyTarget, 'utf8'), 'copy me\n');

			const dirCopyTarget = path.join(remoteRoot, 'sub-copy');
			await writeText(path.join(remoteRoot, 'sub', 'nested.txt'), 'nested\n');
			await svc.remoteCopy('mock-host', path.join(remoteRoot, 'sub'), dirCopyTarget, true);
			assert.strictEqual(await fs.readFile(path.join(dirCopyTarget, 'nested.txt'), 'utf8'), 'nested\n');
			await assert.rejects(
				() => svc.remoteCopy('mock-host', path.join(remoteRoot, 'missing.txt'), copyTarget, true),
				/\[ENOENT\]/,
			);

			// Delete files, empty directories and trees.
			await svc.remoteDelete('mock-host', copyTarget, false);
			assert.strictEqual(await exists(copyTarget), false);
			await assert.rejects(() => svc.remoteStat('mock-host', copyTarget), /\[ENOENT\]/);
			await svc.remoteDelete('mock-host', madeDir, false);
			assert.strictEqual(await exists(madeDir), false);

			// A non-recursive delete refuses to remove a non-empty directory.
			await assert.rejects(() => svc.remoteDelete('mock-host', remoteRoot, false));
			assert.strictEqual(await exists(remoteRoot), true);
			await svc.remoteDelete('mock-host', dirCopyTarget, true);
			assert.strictEqual(await exists(dirCopyTarget), false);

			await assert.rejects(() => svc.remoteDelete('mock-host', path.join(remoteRoot, 'missing-dir'), true), /\[ENOENT\]/);
			await assert.rejects(() => svc.remoteDelete('mock-host', '/', true), /\[EACCES\]/);
		});

		test('parses git status and HEAD contents over the mock transport', async () => {
			const repoDir = path.join(tmpDir, 'repo');
			await fs.mkdir(repoDir, { recursive: true });
			runGitSync(repoDir, ['init']);
			runGitSync(repoDir, ['config', 'user.name', 'Test']);
			runGitSync(repoDir, ['config', 'user.email', 'test@example.com']);
			await writeText(path.join(repoDir, 'tracked.txt'), 'original\n');
			await writeText(path.join(repoDir, 'gone.txt'), 'gone\n');
			runGitSync(repoDir, ['add', '.']);
			runGitSync(repoDir, ['commit', '-m', 'initial']);

			await writeText(path.join(repoDir, 'tracked.txt'), 'modified\n');
			await writeText(path.join(repoDir, 'staged.txt'), 'staged\n');
			runGitSync(repoDir, ['add', 'staged.txt']);
			await writeText(path.join(repoDir, 'untracked.txt'), 'untracked\n');
			await fs.rm(path.join(repoDir, 'gone.txt'));

			const svc = disposables.add(await createService(tmpDir));

			const statuses = await svc.remoteGitStatus('mock-host', repoDir);
			assert.deepStrictEqual(
				statuses
					.map(s => ({ relativePath: s.relativePath, status: s.status, staged: s.staged }))
					.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
				[
					{ relativePath: 'gone.txt', status: 'D', staged: false },
					{ relativePath: 'staged.txt', status: 'A', staged: true },
					{ relativePath: 'tracked.txt', status: 'M', staged: false },
					{ relativePath: 'untracked.txt', status: 'U', staged: false },
				],
			);
			assert.strictEqual(await svc.remoteGitShowHead('mock-host', repoDir, 'tracked.txt'), 'original\n');

			// Non repositories and Windows hosts report no status.
			assert.deepStrictEqual(await svc.remoteGitStatus('mock-host', tmpDir), []);
			await svc.upsertHost({ name: 'Win Host', alias: 'win-host', hostName: 'win.example.com', os: 'windows' });
			assert.deepStrictEqual(await svc.remoteGitStatus('win-host', 'C:\\repo'), []);
		});
	});
});
