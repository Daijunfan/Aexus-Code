/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append, Dimension } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
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
	IAdeCloudHostConnectionCheck,
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
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../../files/browser/projectNavigationService.js';
import { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import { ProjectTerminalService } from '../../../terminal/browser/projectTerminalService.js';
import { AexusSshFileSystemProvider, pickProjectFoldersWithCloudOption } from '../../browser/adeCloudHostFileSystemProvider.js';
import {
	AdeCloudHostsEditorInput,
	AdeCloudHostsEditorPane,
	ADE_CLOUD_HOST_STALE_CHECK_MS,
	buildSshCommandPreview,
	computeCloudHostKpis,
	countCloudHostsByOs,
	countCloudHostsByStatus,
	emptyDraftForm,
	filterAndSortCloudHosts,
	formatCloudHostTargetBadge,
	getCloudHostLatencyTier,
	getCloudHostStatus,
	hostToDraftForm,
	hostToSshCommand,
	IAdeCloudHostQuery,
	isCloudHostCheckStale,
	isDraftFormEqual,
	parseProxyJumpChain,
} from '../../browser/adeCloudHostsEditorPane.js';
import { executeAdeControlRequest } from '../../browser/adeControlHandler.js';
import { reconcileIdeWorkspaceWithCatalog } from '../../browser/adeProjectManagement.js';
import { AdeProjectsService } from '../../browser/adeProjectsService.js';
import { IAdeSessionsService } from '../../browser/adeSessionsService.js';
import { IAdeEditorService, IAdeProject, IAdeProjectsService } from '../../common/ade.js';

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
				command: 'powershell -NoLogo -NoExit -EncodedCommand UwBlAHQALQBMAG8AYwBhAHQAaQBvAG4AIAAtAEwAaQB0AGUAcgBhAGwAUABhAHQAaAAgACcAQwA6AFwAVQBzAGUAcgBzAFwAQQBkAG0AaQBuAFwAcAByAG8AagBlAGMAdAAnAA==',
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

suite('Cloud Host Studio view-model helpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function makeHost(partial: Partial<IAdeCloudHost> & { id: string }): IAdeCloudHost {
		return {
			name: partial.id,
			alias: partial.id,
			hostName: '10.0.0.1',
			port: 22,
			os: 'linux',
			recentDirectories: [],
			source: 'user',
			createdAt: 0,
			updatedAt: 0,
			...partial,
		};
	}

	test('derives status and latency tiers from the last connection check', () => {
		assert.deepStrictEqual([
			getCloudHostStatus({}),
			getCloudHostStatus({ lastTestStatus: { ok: true, checkedAt: 0, latencyMs: 10 } }),
			getCloudHostStatus({ lastTestStatus: { ok: false, checkedAt: 0, latencyMs: 10 } }),
		], ['untested', 'ok', 'err']);

		assert.deepStrictEqual([
			getCloudHostLatencyTier({}),
			getCloudHostLatencyTier({ lastTestStatus: { ok: true, checkedAt: 0, latencyMs: 79 } }),
			getCloudHostLatencyTier({ lastTestStatus: { ok: true, checkedAt: 0, latencyMs: 80 } }),
			getCloudHostLatencyTier({ lastTestStatus: { ok: true, checkedAt: 0, latencyMs: 249 } }),
			getCloudHostLatencyTier({ lastTestStatus: { ok: true, checkedAt: 0, latencyMs: 250 } }),
			getCloudHostLatencyTier({ lastTestStatus: { ok: false, checkedAt: 0, latencyMs: 10 } }),
		], ['none', 'good', 'warn', 'warn', 'bad', 'bad']);
	});

	test('flags checks older than 24 hours as stale', () => {
		const now = 10 * ADE_CLOUD_HOST_STALE_CHECK_MS;
		const check = (age: number) => ({ lastTestStatus: { ok: true, checkedAt: now - age, latencyMs: 10 } });

		assert.deepStrictEqual([
			isCloudHostCheckStale({}, now),
			isCloudHostCheckStale(check(ADE_CLOUD_HOST_STALE_CHECK_MS), now),
			isCloudHostCheckStale(check(ADE_CLOUD_HOST_STALE_CHECK_MS + 1), now),
		], [false, false, true]);
	});

	test('formats target badges and parses proxy jump chains', () => {
		assert.deepStrictEqual([
			formatCloudHostTargetBadge({ user: 'dev', hostName: 'server', port: 2222 }),
			formatCloudHostTargetBadge({ hostName: 'server', port: 22 }),
			formatCloudHostTargetBadge({ user: 'dev', hostName: 'server', port: 0 }),
		], ['dev@server:2222', 'server:22', 'dev@server:22']);

		assert.deepStrictEqual([
			parseProxyJumpChain(undefined),
			parseProxyJumpChain('  '),
			parseProxyJumpChain(' bastion , jump2,, jump3 '),
		], [[], [], ['bastion', 'jump2', 'jump3']]);
	});

	test('builds ssh command previews for every option', () => {
		assert.deepStrictEqual([
			buildSshCommandPreview({ hostName: 'server', user: '', port: '22', identityFile: '', proxyJump: '', strictHostKeyChecking: '' }),
			buildSshCommandPreview({ hostName: 'server', user: 'dev', port: '2222', identityFile: '', proxyJump: '', strictHostKeyChecking: '' }),
			buildSshCommandPreview({ hostName: 'server', user: 'dev', port: '22', identityFile: '', proxyJump: 'bastion, jump2', strictHostKeyChecking: '' }),
			buildSshCommandPreview({ hostName: 'server', user: 'dev', port: '22', identityFile: '/home/me/my key', proxyJump: '', strictHostKeyChecking: 'accept-new' }),
			buildSshCommandPreview({ hostName: '  ', user: '', port: '22', identityFile: '', proxyJump: '', strictHostKeyChecking: '' }),
		], [
			'ssh server',
			'ssh -p 2222 dev@server',
			'ssh -J bastion,jump2 dev@server',
			'ssh -i \'/home/me/my key\' -o StrictHostKeyChecking=accept-new dev@server',
			'ssh \'<host>\'',
		]);
	});

	test('serializes hosts into copy-ready ssh commands', () => {
		assert.deepStrictEqual([
			hostToSshCommand(makeHost({ id: 'plain' })),
			hostToSshCommand(makeHost({ id: 'dev', user: 'dev', port: 2222, proxyJump: 'bastion', strictHostKeyChecking: 'yes' })),
		], [
			'ssh 10.0.0.1',
			'ssh -p 2222 -J bastion -o StrictHostKeyChecking=yes dev@10.0.0.1',
		]);
	});

	test('computes fleet KPIs and per-os/status counts', () => {
		const hosts = [
			makeHost({ id: 'a', source: 'vscode', lastTestStatus: { ok: true, checkedAt: 10, latencyMs: 10 } }),
			makeHost({ id: 'b', source: 'ssh-config', lastTestStatus: { ok: true, checkedAt: 20, latencyMs: 21 } }),
			makeHost({ id: 'c', os: 'macos', lastTestStatus: { ok: false, checkedAt: 30, latencyMs: 50 } }),
			makeHost({ id: 'd', os: 'windows' }),
			makeHost({ id: 'e' }),
		];

		assert.deepStrictEqual(computeCloudHostKpis(hosts), {
			total: 5,
			connected: 2,
			failing: 1,
			untested: 2,
			avgLatencyMs: 16,
			p95LatencyMs: 21,
			importedFromVsCode: 1,
			importedFromSshConfig: 1,
		});
		assert.deepStrictEqual(computeCloudHostKpis([]), {
			total: 0,
			connected: 0,
			failing: 0,
			untested: 0,
			avgLatencyMs: undefined,
			p95LatencyMs: undefined,
			importedFromVsCode: 0,
			importedFromSshConfig: 0,
		});
		assert.deepStrictEqual(countCloudHostsByOs(hosts), { all: 5, linux: 3, macos: 1, windows: 1 });
		assert.deepStrictEqual(countCloudHostsByStatus(hosts), { all: 5, ok: 2, err: 1, untested: 2 });
	});

	test('filters by text, os and status, and sorts by name/latency/checked', () => {
		const hosts = [
			makeHost({ id: 'alpha', name: 'host10', alias: 'alpha-alias', hostName: '10.0.0.10', user: 'alice', os: 'linux', lastTestStatus: { ok: true, checkedAt: 100, latencyMs: 200 } }),
			makeHost({ id: 'beta', name: 'host2', alias: 'beta-alias', hostName: '10.0.0.2', user: 'bob', os: 'macos', proxyJump: 'jumpbox', lastTestStatus: { ok: true, checkedAt: 300, latencyMs: 50 } }),
			makeHost({ id: 'gamma', name: 'host1', alias: 'gamma-alias', hostName: '10.0.0.1', os: 'linux', lastTestStatus: { ok: false, checkedAt: 200, latencyMs: 30 } }),
			makeHost({ id: 'delta', name: 'host3', alias: 'delta-alias', hostName: '10.0.0.3', os: 'windows' }),
		];
		const ids = (query: Partial<IAdeCloudHostQuery>) => filterAndSortCloudHosts(hosts, {
			text: '',
			os: 'all',
			status: 'all',
			sort: 'name',
			...query,
		}).map(host => host.id);

		assert.deepStrictEqual([
			ids({ text: 'jumpbox' }),
			ids({ text: 'ALICE' }),
			ids({ text: '10.0.0.2' }),
			ids({ text: 'host10' }),
			ids({ text: 'delta-alias' }),
			ids({ os: 'linux' }),
			ids({ status: 'ok' }),
			ids({ sort: 'name' }),
			ids({ sort: 'latency' }),
			ids({ sort: 'checked' }),
		], [
			['beta'],
			['alpha'],
			['beta'],
			['alpha'],
			['delta'],
			['gamma', 'alpha'],
			['beta', 'alpha'],
			['gamma', 'beta', 'delta', 'alpha'],
			['beta', 'alpha', 'gamma', 'delta'],
			['beta', 'gamma', 'alpha', 'delta'],
		]);
	});

	test('maps between hosts and draft forms', () => {
		assert.deepStrictEqual(emptyDraftForm(), {
			name: '',
			alias: '',
			hostName: '',
			user: 'ubuntu',
			port: '22',
			os: 'linux',
			identityFile: '',
			proxyJump: '',
			strictHostKeyChecking: 'accept-new',
			defaultDirectory: '',
			notes: '',
		});

		assert.deepStrictEqual(hostToDraftForm(makeHost({ id: 'bare' })), {
			id: 'bare',
			name: 'bare',
			alias: 'bare',
			hostName: '10.0.0.1',
			user: '',
			port: '22',
			os: 'linux',
			identityFile: '',
			proxyJump: '',
			strictHostKeyChecking: '',
			defaultDirectory: '',
			notes: '',
		});

		const host = makeHost({
			id: 'dev',
			name: 'Dev box',
			alias: 'dev',
			hostName: 'dev.example.com',
			user: 'dev',
			port: 2222,
			os: 'macos',
			identityFile: '/keys/id',
			proxyJump: 'bastion',
			strictHostKeyChecking: 'yes',
			defaultDirectory: '/srv',
			notes: 'notes',
		});
		const draft = hostToDraftForm(host);
		assert.deepStrictEqual(draft, {
			id: 'dev',
			name: 'Dev box',
			alias: 'dev',
			hostName: 'dev.example.com',
			user: 'dev',
			port: '2222',
			os: 'macos',
			identityFile: '/keys/id',
			proxyJump: 'bastion',
			strictHostKeyChecking: 'yes',
			defaultDirectory: '/srv',
			notes: 'notes',
		});

		assert.deepStrictEqual([
			isDraftFormEqual(draft, { ...draft }),
			isDraftFormEqual(draft, { ...draft, id: 'other' }),
			isDraftFormEqual(draft, { ...draft, port: '22' }),
		], [true, true, false]);
	});
});

suite('AdeCloudHostsEditorPane Console Grid & Drawer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const projectFolder = '/srv/projects/repo-one';
	const projectUri = URI.from({ scheme: AEXUS_SSH_SCHEME, authority: 'h1', path: projectFolder });

	function query<T extends Element>(root: ParentNode, selector: string): T {
		const el = root.querySelector<T>(selector);
		assert.ok(el, `Missing element: ${selector}`);
		return el;
	}

	function queryAll<T extends Element>(root: ParentNode, selector: string): T[] {
		return [...root.querySelectorAll<T>(selector)];
	}

	async function waitFor(probe: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!probe()) {
			assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
			await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 5));
		}
	}

	function makePaneHost(partial: Partial<IAdeCloudHost> & { id: string }): IAdeCloudHost {
		return {
			name: partial.id,
			alias: partial.id,
			hostName: `10.0.0.${partial.id}`,
			port: 22,
			os: 'linux',
			recentDirectories: [],
			source: 'user',
			createdAt: 0,
			updatedAt: 0,
			...partial,
		};
	}

	async function createPaneHarness() {
		const instantiation = workbenchInstantiationService(undefined, store);

		const hosts: IAdeCloudHost[] = [
			makePaneHost({
				id: 'h1',
				name: 'Alpha GPU',
				alias: 'h1',
				hostName: '10.0.0.1',
				user: 'ubuntu',
				port: 2222,
				os: 'linux',
				proxyJump: 'bastion, jump2',
				recentDirectories: [`${projectFolder}`, '/srv/projects/repo-two', '/srv/projects/repo-three', '/srv/projects/repo-four', '/srv/archive/old'],
				source: 'vscode',
				lastTestStatus: { ok: true, checkedAt: 1, latencyMs: 40 },
			}),
			makePaneHost({ id: 'h2', name: 'Beta Mac', hostName: '10.0.0.2', os: 'macos' }),
			makePaneHost({ id: 'h3', name: 'Gamma Win', hostName: '10.0.0.3', os: 'windows' }),
			makePaneHost({
				id: 'h4',
				name: 'Delta Linux',
				hostName: '10.0.0.4',
				os: 'linux',
				source: 'ssh-config',
				lastTestStatus: { ok: true, checkedAt: 2, latencyMs: 200 },
			}),
			makePaneHost({
				id: 'h5',
				name: 'Epsilon Fail',
				hostName: '10.0.0.5',
				os: 'windows',
				lastTestStatus: { ok: false, checkedAt: 3, latencyMs: 500, error: 'timeout' },
			}),
		];

		const upsertCalls: IAdeCloudHostUpsertInput[] = [];
		const registeredProjects: URI[] = [];
		const selectedProjects: URI[] = [];
		const recordedDirectories: Array<{ id: string; path: string }> = [];
		const deferredTests = new Map<string, DeferredPromise<IAdeCloudHostConnectionCheck>>();
		const projects: IAdeProject[] = [];

		instantiation.stub(IWorkspaceContextService, {
			getWorkbenchState: () => WorkbenchState.WORKSPACE,
			getWorkspace: () => new Workspace('cloud-console', [toWorkspaceFolder(projectUri)]),
			onDidChangeWorkspaceFolders: Event.None,
		});
		instantiation.stub(IAdeProjectsService, upcastPartial<IAdeProjectsService>({
			projects,
			registerProject: (uri: URI, name?: string) => {
				const project: IAdeProject = { uri, name: name ?? basename(uri) };
				projects.push(project);
				registeredProjects.push(uri);
				return project;
			},
			selectProject: (uri: URI) => { selectedProjects.push(uri); },
		}));
		instantiation.stub(IAdeCloudHostBackendService, upcastPartial<IAdeCloudHostBackendService>({
			onDidChangeHosts: Event.None,
			listHosts: async () => [...hosts],
			getHost: async (idOrAlias: string) => hosts.find(host => host.id === idOrAlias || host.alias === idOrAlias),
			upsertHost: async (input: IAdeCloudHostUpsertInput) => {
				upsertCalls.push(input);
				const alias = input.alias ?? input.name;
				const saved: IAdeCloudHost = {
					id: input.id ?? alias,
					name: input.name,
					alias,
					hostName: input.hostName,
					user: input.user,
					port: input.port ?? 22,
					os: input.os ?? 'linux',
					identityFile: input.identityFile,
					proxyJump: input.proxyJump,
					strictHostKeyChecking: input.strictHostKeyChecking,
					defaultDirectory: input.defaultDirectory,
					recentDirectories: input.recentDirectories ?? [],
					source: 'user',
					notes: input.notes,
					createdAt: 10,
					updatedAt: 11,
				};
				const index = hosts.findIndex(host => host.id === saved.id);
				if (index === -1) {
					hosts.push(saved);
				} else {
					hosts[index] = saved;
				}
				return saved;
			},
			recordRecentDirectory: async (idOrAlias: string, path: string) => {
				recordedDirectories.push({ id: idOrAlias, path });
				return hosts.find(host => host.id === idOrAlias);
			},
			testConnection: (idOrAlias: string) => {
				const deferred = new DeferredPromise<IAdeCloudHostConnectionCheck>();
				deferredTests.set(idOrAlias, deferred);
				return deferred.p;
			},
		}));

		const container = append(mainWindow.document.body, $('div.monaco-workbench', { style: 'position:fixed;left:0;top:0;width:1200px;height:800px;' }));
		store.add({ dispose: () => container.remove() });

		const fakeGroup = new class extends mock<IEditorGroup>() {
			override readonly id = 1;
		}();
		const pane = store.add(instantiation.createInstance(AdeCloudHostsEditorPane, fakeGroup));
		pane.create(container);
		pane.layout(new Dimension(1200, 800));
		const input = store.add(new AdeCloudHostsEditorInput());
		await pane.setInput(input, undefined, {}, CancellationToken.None);

		return {
			container,
			hosts,
			upsertCalls,
			registeredProjects,
			selectedProjects,
			recordedDirectories,
			resolveTest: (id: string, check: IAdeCloudHostConnectionCheck) => {
				const index = hosts.findIndex(host => host.id === id);
				assert.ok(index !== -1, `Unknown host ${id}`);
				hosts[index] = { ...hosts[index], lastTestStatus: check };
				const deferred = deferredTests.get(id);
				assert.ok(deferred, `No pending test for ${id}`);
				deferred.complete(check);
			},
		};
	}

	function kpi(container: HTMLElement, kind: 'total' | 'connected' | 'latency' | 'imported'): { value: string | null; meta: string | null } {
		const el = query<HTMLElement>(container, `.ade-ch-kpi[data-kpi="${kind}"]`);
		return {
			value: query<HTMLElement>(el, '.ade-ch-kpi-value').textContent,
			meta: query<HTMLElement>(el, '.ade-ch-kpi-meta').textContent,
		};
	}

	const kpiKinds: readonly ('total' | 'connected' | 'latency' | 'imported')[] = ['total', 'connected', 'latency', 'imported'];

	function card(container: HTMLElement, id: string): HTMLElement {
		return query<HTMLElement>(container, `article.ade-ch-card[data-host-id="${id}"]`);
	}

	function click(root: ParentNode, selector: string): void {
		query<HTMLElement>(root, selector).dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true, cancelable: true }));
	}

	test('renders the console KPI strip, OS/status chip counts, sort control and view toggle', async () => {
		const harness = await createPaneHarness();
		const { container } = harness;

		const studio = query<HTMLElement>(container, '.ade-ch-studio.ade-ch-console');
		assert.strictEqual(studio.dataset.view, 'grid');
		assert.strictEqual(queryAll(container, '.ade-ch-kpi').length, 4);

		assert.deepStrictEqual(
			kpiKinds.map(kind => kpi(container, kind)),
			[
				{ value: '5', meta: '2 untested' },
				{ value: '2/5', meta: '1 failing' },
				{ value: '120 ms', meta: 'p95 200 ms' },
				{ value: '1', meta: '+ssh_config 1' },
			],
		);

		const osCounts = Object.fromEntries(
			['all', 'linux', 'macos', 'windows'].map(os => [os, query<HTMLElement>(container, `.ade-ch-os-chip[data-os="${os}"] .ade-ch-os-chip-count`).textContent]),
		);
		assert.deepStrictEqual(osCounts, { all: '5', linux: '2', macos: '1', windows: '2' });

		const statusCounts = Object.fromEntries(
			['all', 'ok', 'err', 'untested'].map(status => [status, query<HTMLElement>(container, `.ade-ch-status-chip[data-status="${status}"] .ade-ch-os-chip-count`).textContent]),
		);
		assert.deepStrictEqual(statusCounts, { all: '5', ok: '2', err: '1', untested: '2' });

		const sort = query<HTMLSelectElement>(container, 'select.ade-ch-sort');
		assert.deepStrictEqual(queryAll<HTMLOptionElement>(sort, 'option').map(option => option.value), ['name', 'latency', 'checked']);
		assert.strictEqual(queryAll(container, '.ade-ch-view-toggle').length, 1);

		click(container, '.ade-ch-view-toggle [data-view="list"]');
		assert.strictEqual(studio.dataset.view, 'list');
		click(container, '.ade-ch-view-toggle [data-view="grid"]');
		assert.strictEqual(studio.dataset.view, 'grid');
	});

	test('renders host cards with OS badges, targets, jump chains, latency tiers and project chips', async () => {
		const harness = await createPaneHarness();
		const { container } = harness;

		assert.strictEqual(queryAll(container, 'article.ade-ch-card').length, 5);
		assert.strictEqual(queryAll(container, '.ade-ch-os-badge.os-linux').length, 2);
		assert.strictEqual(queryAll(container, '.ade-ch-os-badge.os-macos').length, 1);
		assert.strictEqual(queryAll(container, '.ade-ch-os-badge.os-windows').length, 2);

		assert.deepStrictEqual(
			['h1', 'h2', 'h3', 'h4', 'h5'].map(id => query<HTMLElement>(card(container, id), 'code.ade-ch-target-badge').textContent),
			['ubuntu@10.0.0.1:2222', '10.0.0.2:22', '10.0.0.3:22', '10.0.0.4:22', '10.0.0.5:22'],
		);

		assert.deepStrictEqual(
			queryAll<HTMLElement>(card(container, 'h1'), '.ade-ch-jump-hop').map(hop => hop.textContent),
			['bastion', 'jump2', 'h1'],
		);
		assert.strictEqual(queryAll(card(container, 'h2'), '.ade-ch-jump-chain').length, 0);

		assert.deepStrictEqual(
			['h1', 'h2', 'h3', 'h4', 'h5'].map(id => query<HTMLElement>(card(container, id), '.ade-ch-latency').dataset.tier),
			['good', 'none', 'none', 'warn', 'bad'],
		);

		const chips = queryAll<HTMLElement>(card(container, 'h1'), '.ade-ch-project-chip');
		assert.strictEqual(chips.length, 3);
		assert.strictEqual(query<HTMLElement>(card(container, 'h1'), '.ade-ch-project-more').textContent, '+2');
		assert.strictEqual(queryAll(card(container, 'h2'), '.ade-ch-project-none').length, 1);

		chips[0].dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true, cancelable: true }));
		await waitFor(() => harness.selectedProjects.length > 0, 'cloud project registration');

		assert.deepStrictEqual(harness.registeredProjects.map(uri => uri.toString()), ['aexus-ssh://h1/srv/projects/repo-one']);
		assert.deepStrictEqual(harness.selectedProjects.map(uri => uri.toString()), ['aexus-ssh://h1/srv/projects/repo-one']);
		assert.deepStrictEqual(harness.recordedDirectories, [{ id: 'h1', path: projectFolder }]);
	});

	test('runs per-host test buttons concurrently, patches only the tested cards and updates KPIs on resolve', async () => {
		const harness = await createPaneHarness();
		const { container } = harness;

		const h2Btn = query<HTMLButtonElement>(card(container, 'h2'), '.ade-ch-test-btn');
		const h3Btn = query<HTMLButtonElement>(card(container, 'h3'), '.ade-ch-test-btn');
		const h1Card = card(container, 'h1');
		const h4Card = card(container, 'h4');
		assert.strictEqual(h2Btn.dataset.state, 'idle');
		assert.strictEqual(h3Btn.dataset.state, 'idle');

		h2Btn.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true, cancelable: true }));
		h3Btn.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true, cancelable: true }));

		assert.strictEqual(h2Btn.dataset.state, 'testing');
		assert.strictEqual(h3Btn.dataset.state, 'testing');
		assert.strictEqual(h2Btn.disabled, true);
		assert.strictEqual(h3Btn.disabled, true);
		assert.strictEqual(card(container, 'h1'), h1Card, 'Testing h2/h3 must not rebuild unrelated cards');
		assert.strictEqual(card(container, 'h4'), h4Card, 'Testing h2/h3 must not rebuild unrelated cards');

		harness.resolveTest('h2', { ok: true, checkedAt: 100, latencyMs: 30 });
		harness.resolveTest('h3', { ok: false, checkedAt: 100, latencyMs: 500, error: 'boom' });

		await waitFor(() => h2Btn.dataset.state === 'ok' && h3Btn.dataset.state === 'err', 'parallel test results');

		assert.strictEqual(query<HTMLElement>(card(container, 'h2'), '.ade-ch-latency').dataset.tier, 'good');
		assert.strictEqual(query<HTMLElement>(card(container, 'h2'), '.ade-ch-latency-text').textContent, '30 ms');
		assert.strictEqual(query<HTMLElement>(card(container, 'h3'), '.ade-ch-latency').dataset.tier, 'bad');
		assert.strictEqual(query<HTMLElement>(card(container, 'h3'), '.ade-ch-latency-text').textContent, 'failed');

		assert.deepStrictEqual(
			kpiKinds.map(kind => kpi(container, kind)),
			[
				{ value: '5', meta: 'all tested' },
				{ value: '3/5', meta: '2 failing' },
				{ value: '90 ms', meta: 'p95 200 ms' },
				{ value: '1', meta: '+ssh_config 1' },
			],
		);
	});

	test('opens the create-host drawer with live alias sanitizing, ssh preview and save', async () => {
		const harness = await createPaneHarness();
		const { container } = harness;
		const studio = query<HTMLElement>(container, '.ade-ch-studio.ade-ch-console');

		assert.strictEqual(studio.hasAttribute('data-drawer-open'), false);
		click(container, '.ade-ch-new-host');
		assert.strictEqual(studio.hasAttribute('data-drawer-open'), true);

		const drawer = query<HTMLElement>(container, 'aside.ade-ch-drawer');
		assert.strictEqual(drawer.getAttribute('aria-hidden'), 'false');
		assert.strictEqual(queryAll(drawer, 'fieldset.ade-ch-fieldset').length, 3);

		const field = (name: string) => query<HTMLInputElement>(drawer, `input[data-field="${name}"]`);
		const typeInto = (name: string, value: string) => {
			const input = field(name);
			input.value = value;
			input.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
		};
		const preview = () => query<HTMLElement>(drawer, '.ade-ch-ssh-preview-code').textContent;

		typeInto('name', 'GPU Server!');
		assert.strictEqual(field('alias').value, 'GPU-Server-');
		assert.strictEqual(preview(), `ssh -o StrictHostKeyChecking=accept-new 'ubuntu@<host>'`);

		typeInto('hostName', '203.0.113.10');
		typeInto('user', 'root');
		typeInto('port', '2222');
		typeInto('proxyJump', 'bastion, jump2');
		typeInto('identityFile', '~/.ssh/id_ed25519');
		click(drawer, '.ade-ch-seg-btn[data-value="yes"]');

		assert.strictEqual(preview(), 'ssh -p 2222 -J bastion,jump2 -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=yes root@203.0.113.10');

		click(drawer, '.save-btn');
		await waitFor(() => harness.upsertCalls.length > 0, 'backend.upsertHost');
		await waitFor(() => container.querySelector('article.ade-ch-card[data-host-id="GPU-Server-"]') !== null, 'saved host card');

		assert.deepStrictEqual(harness.upsertCalls[0], {
			id: undefined,
			name: 'GPU Server!',
			alias: 'GPU-Server-',
			hostName: '203.0.113.10',
			user: 'root',
			port: 2222,
			os: 'linux',
			identityFile: '~/.ssh/id_ed25519',
			proxyJump: 'bastion, jump2',
			strictHostKeyChecking: 'yes',
			defaultDirectory: '',
			notes: '',
		});

		const savedCard = card(container, 'GPU-Server-');
		assert.strictEqual(query<HTMLElement>(savedCard, '.ade-ch-card-name').textContent, 'GPU Server!');
		assert.strictEqual(query<HTMLElement>(savedCard, 'code.ade-ch-target-badge').textContent, 'root@203.0.113.10:2222');
	});
});
