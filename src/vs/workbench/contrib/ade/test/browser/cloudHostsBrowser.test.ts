/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AdeCloudHostOs,
	AEXUS_SSH_SCHEME,
	IAdeCloudHost,
	IAdeCloudHostBackendService,
	IAdeCloudHostUpsertInput,
	IAdeRemoteDirEntry,
	IAdeRemoteFileStat,
} from '../../../../../platform/ade/common/adeCloudHosts.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileDialogService, IOpenDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import {
	FileChangeType,
	FilePermission,
	FileSystemProviderErrorCode,
	FileType,
	IFileService,
	IFileSystemProviderError,
} from '../../../../../platform/files/common/files.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import {
	IQuickInputButton,
	IQuickInputHideEvent,
	IQuickInputService,
	IQuickPick,
	IQuickPickDidAcceptEvent,
	IQuickPickItem,
	IQuickPickItemButtonEvent,
	IQuickPickSeparator,
	QuickInputHideReason,
} from '../../../../../platform/quickinput/common/quickInput.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, toWorkspaceFolder, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../../files/browser/projectNavigationService.js';
import { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import { ProjectTerminalService } from '../../../terminal/browser/projectTerminalService.js';
import { AexusSshFileSystemProvider, pickProjectFoldersWithCloudOption } from '../../browser/adeCloudHostFileSystemProvider.js';
import { executeAdeControlRequest } from '../../browser/adeControlHandler.js';
import { reconcileIdeWorkspaceWithCatalog } from '../../browser/adeProjectManagement.js';
import { AdeProjectsService } from '../../browser/adeProjectsService.js';
import { IAdeSessionsService } from '../../browser/adeSessionsService.js';
import { IAdeEditorService, IAdeProjectsService } from '../../common/ade.js';

class FakeCloudHostBackend {
	statResult: IAdeRemoteFileStat = { type: 'file', ctime: 10, mtime: 20, size: 30 };
	dirEntries: readonly IAdeRemoteDirEntry[] = [];
	fileContent = VSBuffer.fromString('remote-bytes');

	statError: Error | undefined;
	readDirError: Error | undefined;
	readFileError: Error | undefined;
	writeError: Error | undefined;
	mkdirError: Error | undefined;
	deleteError: Error | undefined;
	renameError: Error | undefined;
	copyError: Error | undefined;

	readonly calls = {
		stat: [] as Array<{ authority: string; path: string }>,
		readDir: [] as Array<{ authority: string; path: string }>,
		readFile: [] as Array<{ authority: string; path: string }>,
		writeFile: [] as Array<{ authority: string; path: string; content: string; options: { create: boolean; overwrite: boolean } }>,
		mkdir: [] as Array<{ authority: string; path: string }>,
		delete: [] as Array<{ authority: string; path: string; recursive: boolean }>,
		rename: [] as Array<{ authority: string; from: string; to: string; overwrite: boolean }>,
		copy: [] as Array<{ authority: string; from: string; to: string; overwrite: boolean }>,
	};

	async remoteStat(authority: string, path: string): Promise<IAdeRemoteFileStat> {
		this.calls.stat.push({ authority, path });
		if (this.statError) {
			throw this.statError;
		}
		return this.statResult;
	}

	async remoteReadDir(authority: string, path: string): Promise<readonly IAdeRemoteDirEntry[]> {
		this.calls.readDir.push({ authority, path });
		if (this.readDirError) {
			throw this.readDirError;
		}
		return this.dirEntries;
	}

	async remoteReadFile(authority: string, path: string): Promise<VSBuffer> {
		this.calls.readFile.push({ authority, path });
		if (this.readFileError) {
			throw this.readFileError;
		}
		return this.fileContent;
	}

	async remoteWriteFile(authority: string, path: string, content: VSBuffer, options: { create: boolean; overwrite: boolean }): Promise<void> {
		this.calls.writeFile.push({ authority, path, content: content.toString(), options: { create: options.create, overwrite: options.overwrite } });
		if (this.writeError) {
			throw this.writeError;
		}
	}

	async remoteMkdir(authority: string, path: string): Promise<void> {
		this.calls.mkdir.push({ authority, path });
		if (this.mkdirError) {
			throw this.mkdirError;
		}
	}

	async remoteDelete(authority: string, path: string, recursive: boolean): Promise<void> {
		this.calls.delete.push({ authority, path, recursive });
		if (this.deleteError) {
			throw this.deleteError;
		}
	}

	async remoteRename(authority: string, from: string, to: string, overwrite: boolean): Promise<void> {
		this.calls.rename.push({ authority, from, to, overwrite });
		if (this.renameError) {
			throw this.renameError;
		}
	}

	async remoteCopy(authority: string, from: string, to: string, overwrite: boolean): Promise<void> {
		this.calls.copy.push({ authority, from, to, overwrite });
		if (this.copyError) {
			throw this.copyError;
		}
	}
}

async function captureProviderErrorCode(operation: Promise<unknown>): Promise<FileSystemProviderErrorCode | 'no-error'> {
	try {
		await operation;
		return 'no-error';
	} catch (error) {
		return (error as IFileSystemProviderError).code;
	}
}

function cloudUri(authority: string, path: string): URI {
	return URI.from({ scheme: AEXUS_SSH_SCHEME, authority, path });
}

function launchArgs(config: IShellLaunchConfig): string[] {
	return Array.isArray(config.args) ? config.args : [];
}

suite('AexusSshFileSystemProvider', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createProvider() {
		const backend = new FakeCloudHostBackend();
		const provider = store.add(new AexusSshFileSystemProvider(upcastPartial<IAdeCloudHostBackendService>(backend)));
		const changes: Array<{ type: FileChangeType; path: string }> = [];
		store.add(provider.onDidChangeFile(events => changes.push(...events.map(event => ({ type: event.type, path: event.resource.path })))));
		return { backend, provider, changes };
	}

	test('maps stat/readdir/read/write/mkdir/delete/rename/copy onto the remote backend and emits onDidChangeFile events', async () => {
		const { backend, provider, changes } = createProvider();
		const appFile = cloudUri('cloud-a', '/srv/project/src/app.ts');
		const srcDir = cloudUri('cloud-a', '/srv/project/src');
		const newDir = cloudUri('cloud-a', '/srv/project/new');

		const fileStat = await provider.stat(appFile);
		backend.statResult = { type: 'directory', ctime: 1, mtime: 2, size: 0, readonly: true };
		const readonlyDirStat = await provider.stat(srcDir);

		backend.dirEntries = [
			{ name: 'app.ts', type: 'file' },
			{ name: 'nested', type: 'directory' },
			{ name: 'link', type: 'symlink' },
			{ name: 'mystery', type: 'unknown' },
		];
		const entries = await provider.readdir(srcDir);

		const readText = VSBuffer.wrap(await provider.readFile(appFile)).toString();

		await provider.mkdir(newDir);
		await provider.writeFile(cloudUri('cloud-a', '/srv/project/new/file.txt'), VSBuffer.fromString('hello').buffer, { create: true, overwrite: true, unlock: false, atomic: false });
		await provider.copy(cloudUri('cloud-a', '/srv/project/new/file.txt'), cloudUri('cloud-a', '/srv/project/new/copy.txt'), { overwrite: true });
		await provider.rename(cloudUri('cloud-a', '/srv/project/new/copy.txt'), cloudUri('cloud-a', '/srv/project/new/renamed.txt'), { overwrite: false });
		await provider.delete(cloudUri('cloud-a', '/srv/project/new/renamed.txt'), { recursive: false, useTrash: false, atomic: false });

		assert.deepStrictEqual({
			fileStat,
			readonlyDirStat,
			entries,
			readText,
			calls: backend.calls,
			changes,
		}, {
			fileStat: { type: FileType.File, ctime: 10, mtime: 20, size: 30, permissions: undefined },
			readonlyDirStat: { type: FileType.Directory, ctime: 1, mtime: 2, size: 0, permissions: FilePermission.Readonly },
			entries: [
				['app.ts', FileType.File],
				['nested', FileType.Directory],
				['link', FileType.SymbolicLink],
				['mystery', FileType.Unknown],
			],
			readText: 'remote-bytes',
			calls: {
				stat: [
					{ authority: 'cloud-a', path: '/srv/project/src/app.ts' },
					{ authority: 'cloud-a', path: '/srv/project/src' },
				],
				readDir: [{ authority: 'cloud-a', path: '/srv/project/src' }],
				readFile: [{ authority: 'cloud-a', path: '/srv/project/src/app.ts' }],
				writeFile: [{ authority: 'cloud-a', path: '/srv/project/new/file.txt', content: 'hello', options: { create: true, overwrite: true } }],
				mkdir: [{ authority: 'cloud-a', path: '/srv/project/new' }],
				delete: [{ authority: 'cloud-a', path: '/srv/project/new/renamed.txt', recursive: false }],
				rename: [{ authority: 'cloud-a', from: '/srv/project/new/copy.txt', to: '/srv/project/new/renamed.txt', overwrite: false }],
				copy: [{ authority: 'cloud-a', from: '/srv/project/new/file.txt', to: '/srv/project/new/copy.txt', overwrite: true }],
			},
			changes: [
				{ type: FileChangeType.ADDED, path: '/srv/project/new' },
				{ type: FileChangeType.UPDATED, path: '/srv/project/new/file.txt' },
				{ type: FileChangeType.ADDED, path: '/srv/project/new/copy.txt' },
				{ type: FileChangeType.DELETED, path: '/srv/project/new/copy.txt' },
				{ type: FileChangeType.ADDED, path: '/srv/project/new/renamed.txt' },
				{ type: FileChangeType.DELETED, path: '/srv/project/new/renamed.txt' },
			],
		});
	});

	test('maps remote ENOENT/EEXIST/EISDIR/ENOTDIR/EACCES and unknown failures to FileSystemProviderErrorCode', async () => {
		const { backend, provider } = createProvider();
		const file = cloudUri('cloud-a', '/srv/missing.ts');

		backend.statError = new Error('cat: /srv/missing.ts: [ENOENT] No such file or directory');
		const statEnoent = await captureProviderErrorCode(provider.stat(file));

		backend.writeError = new Error('create: [EEXIST] File exists');
		const writeEexist = await captureProviderErrorCode(provider.writeFile(file, VSBuffer.fromString('x').buffer, { create: true, overwrite: false, unlock: false, atomic: false }));

		backend.readFileError = new Error('[EACCES] Permission denied');
		const readEacces = await captureProviderErrorCode(provider.readFile(file));

		backend.readDirError = new Error('[ENOTDIR] Not a directory');
		const readdirEnotdir = await captureProviderErrorCode(provider.readdir(file));

		backend.mkdirError = new Error('[EISDIR] Is a directory');
		const mkdirEisdir = await captureProviderErrorCode(provider.mkdir(file));

		backend.deleteError = new Error('ssh: connection lost');
		const deleteUnavailable = await captureProviderErrorCode(provider.delete(file, { recursive: true, useTrash: false, atomic: false }));

		assert.deepStrictEqual({ statEnoent, writeEexist, readEacces, readdirEnotdir, mkdirEisdir, deleteUnavailable }, {
			statEnoent: FileSystemProviderErrorCode.FileNotFound,
			writeEexist: FileSystemProviderErrorCode.FileExists,
			readEacces: FileSystemProviderErrorCode.NoPermissions,
			readdirEnotdir: FileSystemProviderErrorCode.FileNotADirectory,
			mkdirEisdir: FileSystemProviderErrorCode.FileIsADirectory,
			deleteUnavailable: FileSystemProviderErrorCode.Unavailable,
		});
	});

	test('bridges cross-authority rename/copy through read/write/delete instead of the backend transfer calls', async () => {
		const { backend, provider, changes } = createProvider();

		await provider.rename(cloudUri('cloud-a', '/srv/from.ts'), cloudUri('cloud-b', '/srv/to.ts'), { overwrite: true });
		await provider.copy(cloudUri('cloud-a', '/srv/from.ts'), cloudUri('cloud-c', '/srv/copy.ts'), { overwrite: false });

		assert.deepStrictEqual({
			readFile: backend.calls.readFile,
			writeFile: backend.calls.writeFile,
			delete: backend.calls.delete,
			serverRename: backend.calls.rename,
			serverCopy: backend.calls.copy,
			changes,
		}, {
			readFile: [
				{ authority: 'cloud-a', path: '/srv/from.ts' },
				{ authority: 'cloud-a', path: '/srv/from.ts' },
			],
			writeFile: [
				{ authority: 'cloud-b', path: '/srv/to.ts', content: 'remote-bytes', options: { create: true, overwrite: true } },
				{ authority: 'cloud-c', path: '/srv/copy.ts', content: 'remote-bytes', options: { create: true, overwrite: false } },
			],
			delete: [{ authority: 'cloud-a', path: '/srv/from.ts', recursive: true }],
			serverRename: [],
			serverCopy: [],
			changes: [
				{ type: FileChangeType.UPDATED, path: '/srv/to.ts' },
				{ type: FileChangeType.DELETED, path: '/srv/from.ts' },
				{ type: FileChangeType.UPDATED, path: '/srv/copy.ts' },
			],
		});
	});
});

suite('ProjectTerminalService cloud host launches', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const effectiveSshConfigPath = '/home/test/.ssh/aexus_effective_config';

	function makeHost(alias: string, os: AdeCloudHostOs): IAdeCloudHost {
		return {
			id: alias,
			name: alias,
			alias,
			hostName: alias,
			port: 22,
			os,
			recentDirectories: [],
			source: 'user',
			createdAt: 0,
			updatedAt: 0,
		};
	}

	function setup() {
		const services = workbenchInstantiationService(undefined, store);
		services.stub(IWorkspaceContextService, {
			getWorkbenchState: () => WorkbenchState.WORKSPACE,
			getWorkspace: () => new Workspace('cloud-terminals', []),
			onDidChangeWorkspaceFolders: Event.None,
		});
		const ide = store.add(services.createInstance(ProjectNavigationService));
		services.stub(IProjectNavigationService, ide);
		const ade = store.add(services.createInstance(AdeProjectsService));
		services.stub(IAdeProjectsService, ade);

		const configuration = services.get(IConfigurationService) as TestConfigurationService;
		const backend = upcastPartial<IAdeCloudHostBackendService>({
			onDidChangeHosts: Event.None,
			getEffectiveSshConfigPath: async () => effectiveSshConfigPath,
			listHosts: async () => [makeHost('cloud-linux', 'linux'), makeHost('cloud-win', 'windows')],
		});
		services.stub(IAdeCloudHostBackendService, backend);
		const terminals = store.add(services.createInstance(ProjectTerminalService));
		return { terminals, configuration };
	}

	test('builds effective SSH config launches for Linux and Windows remotes', async () => {
		const { terminals, configuration } = setup();
		configuration.setUserConfiguration('remote.SSH.configFile', '/stale/legacy_ssh_config');

		const linuxUri = cloudUri('cloud-linux', '/srv/app');
		const windowsUri = cloudUri('cloud-win', '/C:/Users/Admin/project');
		const linuxTarget = { uri: linuxUri, name: 'API', host: 'cloud-linux' };
		const windowsTarget = { uri: windowsUri, name: 'Windows', host: 'cloud-win' };

		const resolvedLinux = await terminals.resolveLaunchConfigForUri(linuxUri, 'API Shell');
		const resolvedWindows = await terminals.resolveLaunchConfigForUri(windowsUri, 'Windows Shell');
		const linux = terminals.getLaunchConfig(linuxTarget);
		const windows = terminals.getLaunchConfig(windowsTarget);

		assert.deepStrictEqual({
			linux: {
				name: linux.name,
				configArgs: launchArgs(linux).slice(0, 2),
				transportFlags: launchArgs(linux).slice(2, 4),
				target: launchArgs(linux)[4],
				command: launchArgs(linux)[5],
				remotePty: linux.isRemotePty,
				localCwd: URI.isUri(linux.cwd) && linux.cwd.scheme === Schemas.file,
			},
			windows: {
				name: windows.name,
				configArgs: launchArgs(windows).slice(0, 2),
				transportFlags: launchArgs(windows).slice(2, 4),
				target: launchArgs(windows)[4],
				command: launchArgs(windows)[5],
				remotePty: windows.isRemotePty,
				localCwd: URI.isUri(windows.cwd) && windows.cwd.scheme === Schemas.file,
			},
			resolved: {
				explicitNames: [resolvedLinux.name?.startsWith('API Shell · '), resolvedWindows.name?.startsWith('Windows Shell · ')],
				configArgs: [launchArgs(resolvedLinux).slice(0, 2), launchArgs(resolvedWindows).slice(0, 2)],
				targets: [launchArgs(resolvedLinux)[4], launchArgs(resolvedWindows)[4]],
			},
		}, {
			linux: {
				name: 'API · cloud-linux',
				configArgs: ['-F', effectiveSshConfigPath],
				transportFlags: ['-t', '--'],
				target: 'cloud-linux',
				command: 'cd -- \'/srv/app\' && exec "${SHELL:-/bin/sh}" -l',
				remotePty: true,
				localCwd: true,
			},
			windows: {
				name: 'Windows · cloud-win',
				configArgs: ['-F', effectiveSshConfigPath],
				transportFlags: ['-t', '--'],
				target: 'cloud-win',
				command: 'powershell -NoLogo -NoExit -Command "Set-Location -LiteralPath \'C:\\Users\\Admin\\project\'"',
				remotePty: true,
				localCwd: true,
			},
			resolved: {
				explicitNames: [true, true],
				configArgs: [['-F', effectiveSshConfigPath], ['-F', effectiveSshConfigPath]],
				targets: ['cloud-linux', 'cloud-win'],
			},
		});
	});
});

suite('reconcileIdeWorkspaceWithCatalog cloud roots & host.* control actions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const localProject = URI.file('/Users/me/local-app');
	const cloudProject = cloudUri('cloud-a', '/srv/cloud-app');

	function createHarness(catalog: readonly URI[], initialFolders: readonly URI[], existsOnDisk: (uri: URI) => boolean) {
		const instantiation = workbenchInstantiationService(undefined, store);
		let folders = initialFolders.map(uri => toWorkspaceFolder(uri));
		const onFoldersChanged = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		instantiation.stub(IWorkspaceContextService, {
			getWorkbenchState: () => WorkbenchState.WORKSPACE,
			getWorkspace: () => new Workspace('cloud-reconcile', folders),
			onDidChangeWorkspaceFolders: onFoldersChanged.event,
		});
		const navigation = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, navigation);
		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, projects);
		for (const uri of catalog) {
			projects.registerProject(uri, basename(uri) || uri.authority);
		}

		const added: string[] = [];
		const removed: string[] = [];
		const workspaceEditing = new class extends mock<IWorkspaceEditingService>() {
			override async addFolders(toAdd: { uri: URI }[]): Promise<void> {
				const workspaceFolders = toAdd.map(item => toWorkspaceFolder(item.uri));
				added.push(...workspaceFolders.map(folder => folder.name));
				folders = [...folders, ...workspaceFolders];
				onFoldersChanged.fire({ added: workspaceFolders, removed: [], changed: [] });
			}
			override async removeFolders(uris: URI[]): Promise<void> {
				const workspaceFolders = folders.filter(folder => uris.some(uri => uri.toString() === folder.uri.toString()));
				removed.push(...workspaceFolders.map(folder => folder.name));
				folders = folders.filter(folder => !uris.some(uri => uri.toString() === folder.uri.toString()));
				onFoldersChanged.fire({ added: [], removed: workspaceFolders, changed: [] });
			}
		}();
		instantiation.stub(IWorkspaceEditingService, workspaceEditing);

		const existsChecks: string[] = [];
		instantiation.stub(IFileService, new class extends mock<IFileService>() {
			override hasCapability(): boolean {
				return false;
			}
			override async exists(resource: URI): Promise<boolean> {
				existsChecks.push(resource.toString());
				return existsOnDisk(resource);
			}
		}());

		const run = () => reconcileIdeWorkspaceWithCatalog({
			projects,
			contextService: instantiation.get(IWorkspaceContextService),
			workspaceEditing,
			environmentService: undefined as unknown as IWorkbenchEnvironmentService,
			fileService: instantiation.get(IFileService),
			uriIdentity: instantiation.get(IUriIdentityService),
		});

		return {
			instantiation,
			projects,
			run,
			snapshot: () => ({ folderNames: folders.map(folder => folder.name), added: [...added], removed: [...removed], existsChecks: [...existsChecks] }),
		};
	}

	test('keeps file and aexus-ssh roots side by side without probing local disk for cloud roots', async () => {
		const sideBySide = createHarness([localProject, cloudProject], [localProject, cloudProject], () => false);
		await sideBySide.run();

		const addedBoth = createHarness([localProject, cloudProject], [], uri => uri.scheme === Schemas.file);
		await addedBoth.run();

		const missingLocal = createHarness([localProject, cloudProject], [], () => false);
		await missingLocal.run();

		assert.deepStrictEqual({
			sideBySide: sideBySide.snapshot(),
			addedBoth: addedBoth.snapshot(),
			missingLocal: missingLocal.snapshot(),
		}, {
			sideBySide: {
				folderNames: ['local-app', 'cloud-app'],
				added: [],
				removed: [],
				existsChecks: [],
			},
			addedBoth: {
				folderNames: ['local-app', 'cloud-app'],
				added: ['local-app', 'cloud-app'],
				removed: [],
				existsChecks: [localProject.toString()],
			},
			missingLocal: {
				folderNames: ['cloud-app'],
				added: ['cloud-app'],
				removed: [],
				existsChecks: [localProject.toString()],
			},
		});
	});

	test('dispatches host.* CRUD/browse/import and project.add with aexus-ssh:// and alias:/path specs', async () => {
		const harness = createHarness([], [], () => true);
		const savedHosts = new Map<string, IAdeCloudHost>();
		let openedTarget: string | undefined;

		harness.instantiation.stub(IAdeEditorService, upcastPartial<IAdeEditorService>({
			activeEditor: undefined,
			openCloudHosts: async (target?: string) => {
				openedTarget = target ?? '__all__';
			},
			closeAgents: async () => { },
		}));
		harness.instantiation.stub(IAdeSessionsService, upcastPartial<IAdeSessionsService>({
			onDidChangeEngines: Event.None,
			getEngines: async () => [],
		}));
		harness.instantiation.stub(IAdeCloudHostBackendService, upcastPartial<IAdeCloudHostBackendService>({
			onDidChangeHosts: Event.None,
			listHosts: async () => [...savedHosts.values()],
			getHost: async (idOrAlias: string) => savedHosts.get(idOrAlias),
			upsertHost: async (input: IAdeCloudHostUpsertInput) => {
				const alias = input.alias ?? input.name;
				const host: IAdeCloudHost = {
					id: alias,
					name: input.name,
					alias,
					hostName: input.hostName,
					user: input.user,
					port: input.port ?? 22,
					os: input.os ?? 'linux',
					proxyJump: input.proxyJump,
					defaultDirectory: input.defaultDirectory,
					recentDirectories: [],
					source: 'user',
					createdAt: 1,
					updatedAt: 2,
				};
				savedHosts.set(alias, host);
				return host;
			},
			deleteHost: async (idOrAlias: string) => savedHosts.delete(idOrAlias),
			testConnection: async (idOrAlias: string) => ({ ok: true, latencyMs: 12, remoteUname: 'Linux', remoteHome: `/home/${idOrAlias}`, checkedAt: 1 }),
			remoteReadDir: async (_authority: string, _remotePath: string) => [{ name: 'repo-one', type: 'directory' }],
			importFromVsCodeAndSshConfig: async () => ({ importedCount: 2, updatedCount: 1, totalHosts: savedHosts.size, importedRecentFolders: 3, hosts: [...savedHosts.values()] }),
		}));

		const call = (action: string, params: Record<string, unknown> = {}) =>
			harness.instantiation.invokeFunction(acc => executeAdeControlRequest(acc, action, params));

		const created = await call('host.upsert', { name: 'GPU Cluster', alias: 'gpu1', hostName: '10.0.0.8', user: 'ubuntu', port: 2222, os: 'linux', defaultDirectory: '/workspace' }) as IAdeCloudHost;
		assert.strictEqual(created.alias, 'gpu1');
		assert.strictEqual(created.port, 2222);

		const updated = await call('host.upsert', { alias: 'gpu1', proxyJump: 'bastion' }) as IAdeCloudHost;
		assert.strictEqual(updated.hostName, '10.0.0.8');
		assert.strictEqual(updated.proxyJump, 'bastion');

		const browsed = await call('host.browse', { target: 'gpu1' }) as { host: string; path: string; entries: IAdeRemoteDirEntry[] };
		assert.strictEqual(browsed.path, '/workspace');
		assert.strictEqual(browsed.entries[0].name, 'repo-one');

		const ping = await call('host.test', { target: 'gpu1' }) as { ok: boolean; latencyMs: number };
		assert.strictEqual(ping.ok, true);

		await call('host.open', { target: 'gpu1' });
		assert.strictEqual(openedTarget, 'gpu1');

		const addedUri = await call('project.add', { path: 'aexus-ssh://gpu1/workspace/repo-one' }) as { uri: string; path: string };
		assert.strictEqual(addedUri.uri, 'aexus-ssh://gpu1/workspace/repo-one');
		assert.strictEqual(addedUri.path, 'gpu1:/workspace/repo-one');

		const addedShorthand = await call('project.add', { path: 'gpu1:/workspace/repo-two' }) as { uri: string; path: string };
		assert.strictEqual(addedShorthand.uri, 'aexus-ssh://gpu1/workspace/repo-two');
		assert.strictEqual(addedShorthand.path, 'gpu1:/workspace/repo-two');

		await call('host.delete', { target: 'gpu1' });
		const remaining = await call('host.list') as IAdeCloudHost[];
		assert.strictEqual(remaining.length, 0);
	});
});

class TestCloudHostQuickPick extends mock<IQuickPick<IQuickPickItem, { useSeparators: true }>>() {
	private readonly disposables = new DisposableStore();
	private readonly hideEmitter = this.disposables.add(new Emitter<IQuickInputHideEvent>());
	private readonly acceptEmitter = this.disposables.add(new Emitter<IQuickPickDidAcceptEvent>());
	private readonly valueChangeEmitter = this.disposables.add(new Emitter<string>());
	private readonly customEmitter = this.disposables.add(new Emitter<void>());

	override readonly onDidHide: Event<IQuickInputHideEvent> = (listener, thisArgs, disposables) => this.disposables.add(this.hideEmitter.event(listener, thisArgs, disposables));
	override readonly onDidAccept: Event<IQuickPickDidAcceptEvent> = (listener, thisArgs, disposables) => this.disposables.add(this.acceptEmitter.event(listener, thisArgs, disposables));
	override readonly onDidChangeValue: Event<string> = this.valueChangeEmitter.event;
	override readonly onDidCustom: Event<void> = this.customEmitter.event;
	override readonly onDidTriggerButton: Event<IQuickInputButton> = Event.None;
	override readonly onDidTriggerItemButton: Event<IQuickPickItemButtonEvent<IQuickPickItem>> = Event.None;
	override items: readonly (IQuickPickItem | IQuickPickSeparator)[] = [];
	override selectedItems: readonly IQuickPickItem[] = [];
	override activeItems: readonly IQuickPickItem[] = [];
	override title: string | undefined = undefined;
	override placeholder: string | undefined = undefined;
	override prompt: string | undefined = undefined;
	override valueSelection: Readonly<[number, number]> | undefined = undefined;
	override busy = false;
	override validationMessage: string | undefined = undefined;
	override matchOnDescription = false;
	override matchOnLabel = false;
	override matchOnDetail = false;
	override sortByLabel = false;
	override keepScrollPosition = false;
	override ignoreFocusOut = false;
	override customButton = false;
	override customLabel: string | undefined = undefined;
	override customHover: string | undefined = undefined;
	override buttons: ReadonlyArray<IQuickInputButton> = [];

	private shown = false;
	private _value = '';

	override get value(): string {
		return this._value;
	}

	override set value(next: string) {
		this._value = next;
		this.valueChangeEmitter.fire(next);
	}

	override show(): void {
		this.shown = true;
	}

	override hide(): void {
		if (!this.shown) {
			return;
		}
		this.shown = false;
		this.hideEmitter.fire({ reason: QuickInputHideReason.Other });
	}

	override dispose(): void {
		this.shown = false;
		this.disposables.dispose();
	}

	labels(): string[] {
		return this.items.map(item => item.label ?? '');
	}

	typeValue(next: string): void {
		this.value = next;
	}

	fireCustomButton(): void {
		this.customEmitter.fire();
	}

	acceptItemByLabel(label: string): void {
		const item = this.items.find((entry): entry is IQuickPickItem => entry.type !== 'separator' && entry.label === label);
		assert.ok(item, `Missing quick pick item: ${label}`);
		this.selectedItems = [item];
		this.acceptEmitter.fire({ inBackground: false });
	}
}

function stubQuickInput(instantiation: TestInstantiationService): TestCloudHostQuickPick[] {
	const quickPicks: TestCloudHostQuickPick[] = [];
	instantiation.stub(IQuickInputService, {
		backButton: { iconClass: 'codicon-arrow-left', tooltip: 'Back' },
	}, 'createQuickPick', <T extends IQuickPickItem>(): IQuickPick<T, { useSeparators: true }> => {
		const quickPick = new TestCloudHostQuickPick();
		quickPicks.push(quickPick);
		return quickPick as unknown as IQuickPick<T, { useSeparators: true }>;
	});
	return quickPicks;
}

async function waitForQuickPick(quickPicks: TestCloudHostQuickPick[], count: number): Promise<TestCloudHostQuickPick> {
	for (let i = 0; i < 100 && quickPicks.length < count; i++) {
		await Promise.resolve();
	}
	assert.strictEqual(quickPicks.length, count, `Expected ${count} quick pick(s)`);
	return quickPicks[count - 1];
}

async function waitForLabels(quickPick: TestCloudHostQuickPick, expected: readonly string[]): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!expected.every(label => quickPick.labels().includes(label))) {
		if (Date.now() > deadline) {
			assert.fail(`Quick pick did not show ${JSON.stringify(expected)}. Items: ${JSON.stringify(quickPick.labels())}`);
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

function snapshotQuickPick(quickPick: TestCloudHostQuickPick) {
	return { title: quickPick.title, value: quickPick.value, items: quickPick.labels() };
}

function makeCloudHost(alias: string, os: AdeCloudHostOs, defaultDirectory?: string, user?: string): IAdeCloudHost {
	return {
		id: alias,
		name: alias,
		alias,
		hostName: alias,
		user,
		port: 22,
		os,
		defaultDirectory,
		recentDirectories: [],
		source: 'user',
		createdAt: 0,
		updatedAt: 0,
	};
}

function directories(...names: string[]): IAdeRemoteDirEntry[] {
	return names.map(name => ({ name, type: 'directory' }));
}

suite('pickProjectFoldersWithCloudOption', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface IPickerHarness {
		readonly quickPicks: TestCloudHostQuickPick[];
		readonly remoteReads: Array<{ authority: string; path: string }>;
		readonly statCalls: Array<{ authority: string; path: string }>;
		readonly recordedDirectories: Array<{ id: string; path: string }>;
		readonly dialogOptions: IOpenDialogOptions[];
		readonly pick: () => Promise<URI[] | undefined>;
	}

	function createHarness(remoteReadDir: (authority: string, path: string) => Promise<readonly IAdeRemoteDirEntry[]>): IPickerHarness {
		const instantiation = workbenchInstantiationService(undefined, store);
		const quickPicks = stubQuickInput(instantiation);

		const remoteReads: Array<{ authority: string; path: string }> = [];
		const statCalls: Array<{ authority: string; path: string }> = [];
		const recordedDirectories: Array<{ id: string; path: string }> = [];
		instantiation.stub(IAdeCloudHostBackendService, upcastPartial<IAdeCloudHostBackendService>({
			onDidChangeHosts: Event.None,
			listHosts: async () => [
				makeCloudHost('cloud-linux', 'linux', '/srv/projects', 'ubuntu'),
				makeCloudHost('cloud-win', 'windows', 'C:\\Users\\djf', 'djf'),
			],
			remoteReadDir: async (authority: string, path: string) => {
				remoteReads.push({ authority, path });
				return remoteReadDir(authority, path);
			},
			remoteStat: async (authority: string, path: string) => {
				statCalls.push({ authority, path });
				return { type: 'directory', ctime: 0, mtime: 0, size: 0 };
			},
			recordRecentDirectory: async (id: string, path: string) => { recordedDirectories.push({ id, path }); },
		}));

		const home = URI.file('/home/me');
		const localFolder = URI.file('/Users/me/local-project');
		const dialogOptions: IOpenDialogOptions[] = [];
		instantiation.stub(IFileDialogService, upcastPartial<IFileDialogService>({
			defaultFolderPath: async () => home,
			showOpenDialog: async (options: IOpenDialogOptions) => {
				dialogOptions.push(options);
				return [localFolder];
			},
		}));
		instantiation.stub(ICommandService, upcastPartial<ICommandService>({
			executeCommand: async () => undefined,
		}));

		return {
			quickPicks,
			remoteReads,
			statCalls,
			recordedDirectories,
			dialogOptions,
			pick: () => instantiation.invokeFunction(accessor => pickProjectFoldersWithCloudOption(accessor)),
		};
	}

	test('pre-fills the host folder, drills into cached folders, backspaces across the slash, and confirms Open This Folder', async () => {
		const harness = createHarness(async (_authority, path) => {
			switch (path) {
				case '/srv/projects':
					return [...directories('repo-one', 'repo-two'), { name: 'notes.txt', type: 'file' }];
				case '/srv/projects/repo-one':
					return directories('packages', 'apps');
				case '/srv/projects/repo-two':
					return directories('docs');
				default:
					return [];
			}
		});

		const remotePick = harness.pick();
		const step1 = await waitForQuickPick(harness.quickPicks, 1);
		step1.acceptItemByLabel('cloud-linux');

		// Step 2 keeps a single QuickPick instance open for the whole browse session.
		const step2 = await waitForQuickPick(harness.quickPicks, 2);
		await waitForLabels(step2, ['repo-one/', 'repo-two/']);
		const prefill = snapshotQuickPick(step2);

		step2.acceptItemByLabel('repo-one/');
		await waitForLabels(step2, ['packages/', 'apps/']);
		const drilled = snapshotQuickPick(step2);

		// Backspace crosses the trailing slash into the cached parent: the folder list updates synchronously from cache.
		step2.typeValue('/srv/projects/repo-one');
		const deletingLeaf = snapshotQuickPick(step2);
		step2.typeValue('/srv/projects/repo');
		const deletingAcrossSlash = { ...snapshotQuickPick(step2), busy: step2.busy };

		step2.typeValue('/srv/projects/repo-one/');
		await waitForLabels(step2, ['packages/', 'apps/']);
		step2.acceptItemByLabel('Open This Folder: /srv/projects/repo-one');
		const remoteResult = await remotePick;

		assert.deepStrictEqual({
			quickPickCount: harness.quickPicks.length,
			step1: snapshotQuickPick(step1),
			prefill,
			drilled,
			deletingLeaf,
			deletingAcrossSlash,
			remoteResult: remoteResult?.map(uri => uri.toString()),
			remoteReads: harness.remoteReads,
			statCalls: harness.statCalls,
			recordedDirectories: harness.recordedDirectories,
		}, {
			quickPickCount: 2,
			step1: {
				title: 'Add Project (1/2) — Select Host',
				value: '',
				items: [
					'Local Host',
					'Local (This Computer)',
					'Cloud Hosts (SSH) · 2',
					'cloud-linux',
					'cloud-win',
					'Cloud Host Management',
					'Add New Cloud Host...',
					'Manage Saved Cloud Hosts...',
					'Sync / Import Cloud Hosts from VS Code & ~/.ssh/config',
				],
			},
			prefill: {
				title: 'Add Project (2/2) — Select Folder on cloud-linux',
				value: '/srv/projects/',
				items: [
					'Open This Folder: /srv/projects',
					'Folders in /srv/projects',
					'..',
					'repo-one/',
					'repo-two/',
					'Host',
					'Switch Host...',
				],
			},
			drilled: {
				title: 'Add Project (2/2) — Select Folder on cloud-linux',
				value: '/srv/projects/repo-one/',
				items: [
					'Open This Folder: /srv/projects/repo-one',
					'Folders in /srv/projects/repo-one',
					'..',
					'apps/',
					'packages/',
					'Host',
					'Switch Host...',
				],
			},
			deletingLeaf: {
				title: 'Add Project (2/2) — Select Folder on cloud-linux',
				value: '/srv/projects/repo-one',
				items: [
					'Matching Folders in /srv/projects',
					'repo-one/',
					'Target Path Actions',
					'Open This Folder: /srv/projects/repo-one',
					'Other Folders in /srv/projects',
					'..',
					'repo-two/',
					'Host',
					'Switch Host...',
				],
			},
			deletingAcrossSlash: {
				title: 'Add Project (2/2) — Select Folder on cloud-linux',
				value: '/srv/projects/repo',
				items: [
					'Matching Folders in /srv/projects',
					'repo-one/',
					'repo-two/',
					'Target Path Actions',
					'Create & Add as Project: /srv/projects/repo',
					'Create & Enter Folder: /srv/projects/repo/',
					'Other Folders in /srv/projects',
					'..',
					'Host',
					'Switch Host...',
				],
				busy: false,
			},
			remoteResult: ['aexus-ssh://cloud-linux/srv/projects/repo-one'],
			remoteReads: [
				{ authority: 'cloud-linux', path: '/srv/projects' },
				{ authority: 'cloud-linux', path: '/srv' },
				{ authority: 'cloud-linux', path: '/srv/projects/repo-one' },
			],
			statCalls: [{ authority: 'cloud-linux', path: '/srv/projects/repo-one' }],
			recordedDirectories: [{ id: 'cloud-linux', path: '/srv/projects/repo-one' }],
		});
	});

	test('confirms the typed folder when the Add Project custom button is triggered', async () => {
		const harness = createHarness(async (_authority, path) => {
			switch (path) {
				case '/srv/projects':
					return directories('repo-one', 'repo-two');
				case '/srv/projects/repo-two':
					return directories('docs');
				default:
					return [];
			}
		});

		const customPick = harness.pick();
		const step1 = await waitForQuickPick(harness.quickPicks, 1);
		step1.acceptItemByLabel('cloud-linux');

		const step2 = await waitForQuickPick(harness.quickPicks, 2);
		await waitForLabels(step2, ['repo-one/', 'repo-two/']);
		step2.typeValue('/srv/projects/repo-two');
		const typed = snapshotQuickPick(step2);
		const customLabel = step2.customLabel;
		step2.fireCustomButton();
		const customResult = await customPick;

		assert.deepStrictEqual({
			quickPickCount: harness.quickPicks.length,
			customLabel,
			typed,
			customResult: customResult?.map(uri => uri.toString()),
			statCalls: harness.statCalls,
			recordedDirectories: harness.recordedDirectories,
		}, {
			quickPickCount: 2,
			customLabel: 'Open',
			typed: {
				title: 'Add Project (2/2) — Select Folder on cloud-linux',
				value: '/srv/projects/repo-two',
				items: [
					'Matching Folders in /srv/projects',
					'repo-two/',
					'Target Path Actions',
					'Open This Folder: /srv/projects/repo-two',
					'Other Folders in /srv/projects',
					'..',
					'repo-one/',
					'Host',
					'Switch Host...',
				],
			},
			customResult: ['aexus-ssh://cloud-linux/srv/projects/repo-two'],
			statCalls: [{ authority: 'cloud-linux', path: '/srv/projects/repo-two' }],
			recordedDirectories: [{ id: 'cloud-linux', path: '/srv/projects/repo-two' }],
		});
	});

	test('backs a Windows host out to the drive root and lists drives from remoteReadDir("/")', async () => {
		const harness = createHarness(async (_authority, path) => {
			switch (path) {
				case '/C:/Users/djf':
					return directories('Desktop', 'work');
				case '/C:/Users':
					return directories('Public', 'djf');
				case '/C:':
					return directories('Users', 'Windows');
				case '/':
					return directories('C:', 'D:');
				default:
					return [];
			}
		});

		const windowsPick = harness.pick();
		const step1 = await waitForQuickPick(harness.quickPicks, 1);
		step1.acceptItemByLabel('cloud-win');

		const step2 = await waitForQuickPick(harness.quickPicks, 2);
		await waitForLabels(step2, ['Desktop/', 'work/']);
		const prefill = snapshotQuickPick(step2);

		step2.typeValue('/C:/Users/djf');
		step2.typeValue('/C:/');
		await waitForLabels(step2, ['Users/', 'Windows/']);
		const driveFolder = snapshotQuickPick(step2);

		step2.typeValue('/C:');
		await waitForLabels(step2, ['C:/', 'D:/']);
		const filteredDrives = snapshotQuickPick(step2);

		// '/' is already cached, so the drive list pops up synchronously.
		step2.typeValue('/');
		const slashRoot = { ...snapshotQuickPick(step2), busy: step2.busy };

		step2.typeValue('/C:/Users/djf/');
		await waitForLabels(step2, ['Desktop/', 'work/']);
		step2.acceptItemByLabel('Open This Folder: /C:/Users/djf');
		const windowsResult = await windowsPick;

		assert.deepStrictEqual({
			quickPickCount: harness.quickPicks.length,
			prefill,
			driveFolder,
			filteredDrives,
			slashRoot,
			windowsResult: windowsResult?.map(uri => uri.toString()),
			remoteReads: harness.remoteReads,
			statCalls: harness.statCalls,
			recordedDirectories: harness.recordedDirectories,
		}, {
			quickPickCount: 2,
			prefill: {
				title: 'Add Project (2/2) — Select Folder on cloud-win',
				value: '/C:/Users/djf/',
				items: [
					'Open This Folder: /C:/Users/djf',
					'Folders in /C:/Users/djf',
					'..',
					'Desktop/',
					'work/',
					'Host',
					'Switch Host...',
				],
			},
			driveFolder: {
				title: 'Add Project (2/2) — Select Folder on cloud-win',
				value: '/C:/',
				items: [
					'Open This Folder: /C:',
					'Folders in /C:',
					'..',
					'Users/',
					'Windows/',
					'Host',
					'Switch Host...',
				],
			},
			filteredDrives: {
				title: 'Add Project (2/2) — Select Folder on cloud-win',
				value: '/C:',
				items: [
					'Matching Drives on cloud-win',
					'C:/',
					'All Drives on cloud-win',
					'D:/',
					'Host',
					'Switch Host...',
				],
			},
			slashRoot: {
				title: 'Add Project (2/2) — Select Folder on cloud-win',
				value: '/',
				items: [
					'Drives on cloud-win',
					'C:/',
					'D:/',
					'Host',
					'Switch Host...',
				],
				busy: false,
			},
			windowsResult: ['aexus-ssh://cloud-win/c%3A/Users/djf'],
			remoteReads: [
				{ authority: 'cloud-win', path: '/C:/Users/djf' },
				{ authority: 'cloud-win', path: '/C:/Users' },
				{ authority: 'cloud-win', path: '/C:' },
				{ authority: 'cloud-win', path: '/' },
			],
			statCalls: [{ authority: 'cloud-win', path: '/C:/Users/djf' }],
			recordedDirectories: [{ id: 'cloud-win', path: '/C:/Users/djf' }],
		});
	});

	test('delegates to the local folder dialog when Local (This Computer) is selected', async () => {
		const harness = createHarness(async () => []);

		const localPick = harness.pick();
		const localStep = await waitForQuickPick(harness.quickPicks, 1);
		const localStepSnapshot = snapshotQuickPick(localStep);
		localStep.acceptItemByLabel('Local (This Computer)');
		const localResult = await localPick;

		assert.deepStrictEqual({
			localStep: localStepSnapshot,
			localDialog: {
				options: harness.dialogOptions.map(options => ({
					title: options.title,
					canSelectFiles: options.canSelectFiles,
					canSelectFolders: options.canSelectFolders,
					canSelectMany: options.canSelectMany,
					availableFileSystems: options.availableFileSystems,
					defaultUri: options.defaultUri?.toString(),
				})),
				result: localResult?.map(uri => uri.toString()),
			},
		}, {
			localStep: {
				title: 'Add Project (1/2) — Select Host',
				value: '',
				items: [
					'Local Host',
					'Local (This Computer)',
					'Cloud Hosts (SSH) · 2',
					'cloud-linux',
					'cloud-win',
					'Cloud Host Management',
					'Add New Cloud Host...',
					'Manage Saved Cloud Hosts...',
					'Sync / Import Cloud Hosts from VS Code & ~/.ssh/config',
				],
			},
			localDialog: {
				options: [{
					title: 'Add Local Project Folder',
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: true,
					availableFileSystems: [Schemas.file],
					defaultUri: 'file:///home/me',
				}],
				result: ['file:///Users/me/local-project'],
			},
		});
	});
});
