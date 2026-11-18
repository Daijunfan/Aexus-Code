/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { posix } from '../../../../base/common/path.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import {
	ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID,
} from '../common/ade.js';
import {
	AdeCloudHostOs,
	AEXUS_SSH_GIT_HEAD_SCHEME,
	AEXUS_SSH_SCHEME,
	buildCloudProjectUri,
	formatCloudHostTargetLabel,
	IAdeCloudHost,
	IAdeCloudHostBackendService,
	normalizeRemoteProjectPath,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import {
	createFileSystemProviderError,
	FileChangeType,
	FilePermission,
	FileSystemProviderCapabilities,
	FileSystemProviderErrorCode,
	FileType,
	IFileChange,
	IFileDeleteOptions,
	IFileOverwriteOptions,
	IFileService,
	IFileSystemProviderWithFileFolderCopyCapability,
	IFileSystemProviderWithFileReadWriteCapability,
	IFileWriteOptions,
	IStat,
	IWatchOptions,
} from '../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputButton, IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

function toVsFileType(kind: 'file' | 'directory' | 'symlink' | 'unknown'): FileType {
	switch (kind) {
		case 'directory':
			return FileType.Directory;
		case 'file':
			return FileType.File;
		case 'symlink':
			return FileType.SymbolicLink;
		default:
			return FileType.Unknown;
	}
}

function mapRemoteFsError(err: unknown): Error {
	const msg = err instanceof Error ? err.message : String(err);
	if (msg.includes('[ENOENT]')) {
		return createFileSystemProviderError(msg, FileSystemProviderErrorCode.FileNotFound);
	}
	if (msg.includes('[EEXIST]')) {
		return createFileSystemProviderError(msg, FileSystemProviderErrorCode.FileExists);
	}
	if (msg.includes('[EISDIR]')) {
		return createFileSystemProviderError(msg, FileSystemProviderErrorCode.FileIsADirectory);
	}
	if (msg.includes('[ENOTDIR]')) {
		return createFileSystemProviderError(msg, FileSystemProviderErrorCode.FileNotADirectory);
	}
	if (msg.includes('[EACCES]')) {
		return createFileSystemProviderError(msg, FileSystemProviderErrorCode.NoPermissions);
	}
	return createFileSystemProviderError(msg, FileSystemProviderErrorCode.Unavailable);
}

export class AexusSshFileSystemProvider extends Disposable implements
	IFileSystemProviderWithFileReadWriteCapability,
	IFileSystemProviderWithFileFolderCopyCapability {

	readonly capabilities =
		FileSystemProviderCapabilities.FileReadWrite
		| FileSystemProviderCapabilities.FileFolderCopy
		| FileSystemProviderCapabilities.PathCaseSensitive;

	readonly onDidChangeCapabilities = Event.None;

	private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	constructor(private readonly backend: IAdeCloudHostBackendService) {
		super();
	}

	watch(_resource: URI, _opts: IWatchOptions): IDisposable {
		return Disposable.None;
	}

	async stat(resource: URI): Promise<IStat> {
		try {
			const res = await this.backend.remoteStat(resource.authority, resource.path || '/');
			return {
				type: toVsFileType(res.type),
				ctime: res.ctime,
				mtime: res.mtime,
				size: res.size,
				permissions: res.readonly ? FilePermission.Readonly : undefined,
			};
		} catch (err) {
			throw mapRemoteFsError(err);
		}
	}

	async readdir(resource: URI): Promise<[string, FileType][]> {
		try {
			const entries = await this.backend.remoteReadDir(resource.authority, resource.path || '/');
			return entries.map(entry => [entry.name, toVsFileType(entry.type)]);
		} catch (err) {
			throw mapRemoteFsError(err);
		}
	}

	async mkdir(resource: URI): Promise<void> {
		try {
			await this.backend.remoteMkdir(resource.authority, resource.path);
			this._onDidChangeFile.fire([{ type: FileChangeType.ADDED, resource }]);
		} catch (err) {
			throw mapRemoteFsError(err);
		}
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		try {
			const buf = await this.backend.remoteReadFile(resource.authority, resource.path);
			return buf.buffer;
		} catch (err) {
			throw mapRemoteFsError(err);
		}
	}

	async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
		try {
			const { VSBuffer } = await import('../../../../base/common/buffer.js');
			await this.backend.remoteWriteFile(resource.authority, resource.path, VSBuffer.wrap(content), {
				create: opts.create,
				overwrite: opts.overwrite,
			});
			this._onDidChangeFile.fire([{ type: FileChangeType.UPDATED, resource }]);
		} catch (err) {
			throw mapRemoteFsError(err);
		}
	}

	async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		try {
			await this.backend.remoteDelete(resource.authority, resource.path, opts.recursive);
			this._onDidChangeFile.fire([{ type: FileChangeType.DELETED, resource }]);
		} catch (err) {
			throw mapRemoteFsError(err);
		}
	}

	async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		try {
			if (from.authority !== to.authority) {
				const bytes = await this.readFile(from);
				await this.writeFile(to, bytes, { create: true, overwrite: opts.overwrite, unlock: false, atomic: false });
				await this.delete(from, { recursive: true, useTrash: false, atomic: false });
				return;
			}
			await this.backend.remoteRename(from.authority, from.path, to.path, opts.overwrite);
			this._onDidChangeFile.fire([
				{ type: FileChangeType.DELETED, resource: from },
				{ type: FileChangeType.ADDED, resource: to },
			]);
		} catch (err) {
			throw mapRemoteFsError(err);
		}
	}

	async copy(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		try {
			if (from.authority !== to.authority) {
				const bytes = await this.readFile(from);
				await this.writeFile(to, bytes, { create: true, overwrite: opts.overwrite, unlock: false, atomic: false });
				return;
			}
			await this.backend.remoteCopy(from.authority, from.path, to.path, opts.overwrite);
			this._onDidChangeFile.fire([{ type: FileChangeType.ADDED, resource: to }]);
		} catch (err) {
			throw mapRemoteFsError(err);
		}
	}
}

class AexusSshGitHeadContentProvider implements ITextModelContentProvider {
	constructor(
		private readonly backend: IAdeCloudHostBackendService,
		private readonly modelService: IModelService,
		private readonly languageService: ILanguageService,
	) { }

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const existing = this.modelService.getModel(resource);
		const params = new URLSearchParams(resource.query);
		const rootPath = params.get('root') || '/';
		const relPath = params.get('rel') || resource.path.replace(/^\/+/, '');
		let content = '';
		try {
			content = await this.backend.remoteGitShowHead(resource.authority, rootPath, relPath);
		} catch {
			content = '';
		}
		if (existing) {
			existing.setValue(content);
			return existing;
		}
		const langSelection = this.languageService.createByFilepathOrFirstLine(URI.file(resource.path));
		return this.modelService.createModel(content, langSelection, resource, false);
	}
}

export class AdeCloudHostWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.adeCloudHostFileSystem';

	constructor(
		@IFileService fileService: IFileService,
		@ILabelService labelService: ILabelService,
		@ITextModelService textModelService: ITextModelService,
		@IModelService modelService: IModelService,
		@ILanguageService languageService: ILanguageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const backend = instantiationService.invokeFunction(accessor => tryGetOptional<IAdeCloudHostBackendService>(accessor, IAdeCloudHostBackendService));
		this._register(labelService.registerFormatter({
			scheme: AEXUS_SSH_SCHEME,
			formatting: {
				label: '${path}',
				separator: '/',
				tildify: false,
				normalizeDriveLetter: false,
				workspaceSuffix: 'Cloud SSH',
				authorityPrefix: '${authority}:',
			},
		}));
		if (!backend) {
			return;
		}
		const provider = this._register(new AexusSshFileSystemProvider(backend));
		this._register(fileService.registerProvider(AEXUS_SSH_SCHEME, provider));
		this._register(textModelService.registerTextModelContentProvider(
			AEXUS_SSH_GIT_HEAD_SCHEME,
			new AexusSshGitHeadContentProvider(backend, modelService, languageService),
		));
	}
}

function tryGetOptional<T>(accessor: ServicesAccessor, id: { (...args: unknown[]): unknown; toString(): string }): T | undefined {
	try {
		return accessor.get(id as never);
	} catch {
		return undefined;
	}
}

export async function promptQuickUpsertCloudHost(
	accessor: ServicesAccessor,
	existing?: IAdeCloudHost,
): Promise<IAdeCloudHost | undefined> {
	const quickInput = accessor.get(IQuickInputService);
	const backend = tryGetOptional<IAdeCloudHostBackendService>(accessor, IAdeCloudHostBackendService);
	const dialogs = tryGetOptional<IFileDialogService>(accessor, IFileDialogService);
	if (!backend) {
		return undefined;
	}

	const rawTarget = await quickInput.input({
		title: existing
			? localize('adeEditCloudHostTitle', "Edit Cloud Host: {0}", existing.name)
			: localize('adeNewCloudHostTitle', "Add Cloud Host (SSH)"),
		prompt: localize('adeCloudHostTargetPrompt', "Enter SSH target (e.g. ubuntu@203.0.113.10 or user@host:2222)"),
		value: existing ? formatCloudHostTargetLabel(existing) : '',
		placeHolder: 'ubuntu@203.0.113.10:22',
		ignoreFocusLost: true,
		validateInput: async val => val.trim() ? undefined : localize('adeCloudHostTargetReq', "SSH host address is required."),
	});
	if (!rawTarget?.trim()) {
		return undefined;
	}

	let parsedUser = existing?.user;
	let parsedHost = rawTarget.trim();
	let parsedPort = existing?.port ?? 22;
	if (parsedHost.includes('@')) {
		const idx = parsedHost.lastIndexOf('@');
		parsedUser = parsedHost.slice(0, idx).trim() || undefined;
		parsedHost = parsedHost.slice(idx + 1).trim();
	}
	const portMatch = /^([^:]+):(\d+)$/.exec(parsedHost);
	if (portMatch) {
		parsedHost = portMatch[1].trim();
		parsedPort = Number(portMatch[2]);
	}

	const nameVal = await quickInput.input({
		title: localize('adeCloudHostNameStepTitle', "Cloud Host Display Name & Alias"),
		prompt: localize('adeCloudHostNamePrompt', "Friendly name / SSH alias for this Cloud Host"),
		value: existing?.name ?? parsedHost,
		ignoreFocusLost: true,
		validateInput: async val => val.trim() ? undefined : localize('adeCloudHostNameReq', "Display name is required."),
	});
	if (!nameVal?.trim()) {
		return undefined;
	}

	const osPick = await quickInput.pick<{ label: string; os: AdeCloudHostOs }>([
		{ label: 'Linux', os: 'linux' },
		{ label: 'macOS', os: 'macos' },
		{ label: 'Windows (OpenSSH / PowerShell)', os: 'windows' },
	], {
		title: localize('adeCloudHostOsTitle', "Cloud Host Operating System"),
		placeHolder: localize('adeCloudHostOsPlaceholder', "Select the remote operating system"),
	});
	if (!osPick) {
		return undefined;
	}

	let identityFile = existing?.identityFile ?? '';
	const keyChoice = await quickInput.pick<{ label: string; mode: 'default' | 'browse' | 'manual' }>([
		{
			label: identityFile
				? localize('adeCloudHostKeepKey', "Keep SSH Key ({0})", identityFile)
				: localize('adeCloudHostDefaultKey', "Use Default SSH Agent / ~/.ssh Key"),
			mode: 'default',
		},
		{
			label: localize('adeCloudHostBrowseKey', "Browse SSH Private Key File..."),
			mode: 'browse',
		},
		{
			label: localize('adeCloudHostManualKey', "Enter Private Key Path or ProxyJump..."),
			mode: 'manual',
		},
	], {
		title: localize('adeCloudHostAuthTitle', "SSH Key & Jump Host (Optional)"),
	});
	if (!keyChoice) {
		return undefined;
	}

	let proxyJump = existing?.proxyJump;
	if (keyChoice.mode === 'browse' && dialogs) {
		const homeUri = await dialogs.defaultFolderPath(Schemas.file);
		const pickedKey = await dialogs.showOpenDialog({
			title: localize('adeSelectSshKeyTitle', "Select SSH Private Key"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			defaultUri: homeUri ? joinPath(homeUri, '.ssh') : undefined,
		});
		if (pickedKey?.[0]) {
			identityFile = pickedKey[0].fsPath;
		}
	} else if (keyChoice.mode === 'manual') {
		const manualKey = await quickInput.input({
			title: localize('adeCloudHostManualKeyTitle', "SSH Private Key Path (Optional)"),
			prompt: localize('adeCloudHostManualKeyPrompt', "Path to private key (e.g. ~/.ssh/id_ed25519), or leave empty for default"),
			value: identityFile,
			placeHolder: '~/.ssh/id_ed25519',
			ignoreFocusLost: true,
		});
		if (manualKey === undefined) {
			return undefined;
		}
		identityFile = manualKey.trim();

		const manualJump = await quickInput.input({
			title: localize('adeCloudHostJumpTitle', "ProxyJump Bastion Host (Optional)"),
			prompt: localize('adeCloudHostJumpPrompt', "Optional jump host alias or user@bastion, or leave empty"),
			value: proxyJump ?? '',
			ignoreFocusLost: true,
		});
		if (manualJump === undefined) {
			return undefined;
		}
		proxyJump = manualJump.trim() || undefined;
	}

	const defaultDir = await quickInput.input({
		title: localize('adeCloudHostDefaultDirTitle', "Default Remote Project Directory (Optional)"),
		prompt: localize('adeCloudHostDefaultDirPrompt', "Default folder when browsing projects on this host"),
		value: existing?.defaultDirectory ?? (osPick.os === 'windows' ? 'C:/Users' : (parsedUser ? `/home/${parsedUser}` : '/root')),
		ignoreFocusLost: true,
	});
	if (defaultDir === undefined) {
		return undefined;
	}

	return backend.upsertHost({
		id: existing?.id,
		name: nameVal.trim(),
		alias: existing?.alias ?? nameVal.trim(),
		hostName: parsedHost,
		user: parsedUser,
		port: parsedPort,
		os: osPick.os,
		identityFile,
		proxyJump,
		defaultDirectory: defaultDir.trim() || undefined,
	});
}

export async function browseRemoteFolderOnCloudHost(
	accessor: ServicesAccessor,
	host: IAdeCloudHost,
): Promise<URI | undefined> {
	const result = await browseRemoteFolderOnCloudHostWithBack(accessor, host, false);
	return result === 'switch-host' ? undefined : result;
}

async function browseRemoteFolderOnCloudHostWithBack(
	accessor: ServicesAccessor,
	host: IAdeCloudHost,
	allowSwitchHost: boolean,
): Promise<URI | 'switch-host' | undefined> {
	const quickInput = accessor.get(IQuickInputService);
	const notifications = tryGetOptional<INotificationService>(accessor, INotificationService);
	const backend = tryGetOptional<IAdeCloudHostBackendService>(accessor, IAdeCloudHostBackendService);
	if (!backend) {
		return undefined;
	}

	let currentDir = normalizeRemoteProjectPath(
		host.defaultDirectory || host.recentDirectories[0] || (host.os === 'windows' ? '/C:/' : (host.user ? `/home/${host.user}` : '/')),
		host.os,
	);

	type BrowseActionItem = IQuickPickItem & {
		readonly action: 'select-current' | 'select-recent' | 'enter-dir' | 'parent' | 'manual' | 'mkdir' | 'switch-host';
		readonly targetPath?: string;
	};

	while (true) {
		let dirEntries: readonly { name: string; type: string }[] = [];
		let browseError: string | undefined;
		try {
			dirEntries = await backend.remoteReadDir(host.alias, currentDir);
		} catch (err) {
			browseError = err instanceof Error ? err.message.replace(/^\[[A-Z]+\]\s*/, '') : String(err);
		}

		const subFolders = dirEntries
			.filter(e => e.type === 'directory' && !e.name.startsWith('.'))
			.sort((a, b) => a.name.localeCompare(b.name));
		const hiddenFolders = dirEntries
			.filter(e => e.type === 'directory' && e.name.startsWith('.'))
			.sort((a, b) => a.name.localeCompare(b.name));

		const items: (BrowseActionItem | IQuickPickSeparator)[] = [];

		if (!browseError) {
			items.push({
				label: localize('adeCloudUseCurrentFolder', "Open This Folder: {0}", currentDir),
				description: localize('adeCloudAddAsProjectDesc', "Add {0}:{1} as Project Workspace", host.alias, currentDir),
				iconClass: ThemeIcon.asClassName(Codicon.check),
				alwaysShow: true,
				action: 'select-current',
				targetPath: currentDir,
			});
		}

		items.push({
			label: localize('adeCloudEnterPathManually', "Enter Remote Folder Path Manually..."),
			description: browseError
				? localize('adeCloudBrowseOfflineHint', "Direct path input (Live browse unavailable: {0})", browseError.slice(0, 72))
				: localize('adeCloudEnterPathDesc', "Type or paste any remote folder path"),
			iconClass: ThemeIcon.asClassName(Codicon.edit),
			alwaysShow: true,
			action: 'manual',
		});

		if (!browseError) {
			items.push({
				label: localize('adeCloudCreateFolderHere', "New Folder in {0}...", currentDir),
				iconClass: ThemeIcon.asClassName(Codicon.newFolder),
				action: 'mkdir',
			});
		}

		if (allowSwitchHost) {
			items.push({
				label: localize('adeCloudSwitchHostItem', "Switch Host..."),
				description: localize('adeCloudSwitchHostItemDesc', "Go back to select Local or another Cloud Host"),
				iconClass: ThemeIcon.asClassName(Codicon.arrowLeft),
				alwaysShow: true,
				action: 'switch-host',
			});
		}

		if (host.recentDirectories.length > 0) {
			items.push({ type: 'separator', label: localize('adeCloudRecentFoldersSep', "Recent & Migrated VS Code Folders") });
			for (const recPath of host.recentDirectories) {
				items.push({
					label: basename(URI.from({ scheme: AEXUS_SSH_SCHEME, authority: host.alias, path: recPath })) || recPath,
					description: `${host.alias}:${recPath}`,
					iconClass: ThemeIcon.asClassName(Codicon.history),
					action: 'select-recent',
					targetPath: recPath,
				});
			}
		}

		if (!browseError) {
			items.push({ type: 'separator', label: localize('adeCloudSubfoldersSep', "Folders in {0}", currentDir) });
			if (currentDir !== '/' && !/^\/[A-Za-z]:\/?$/.test(currentDir)) {
				const parentPath = posix.dirname(currentDir);
				items.push({
					label: '..',
					description: localize('adeCloudParentFolderDesc', "Up to {0}", parentPath),
					iconClass: ThemeIcon.asClassName(Codicon.arrowUp),
					alwaysShow: true,
					action: 'parent',
					targetPath: parentPath,
				});
			}
			for (const sub of [...subFolders, ...hiddenFolders]) {
				const nextPath = posix.join(currentDir, sub.name);
				items.push({
					label: `${sub.name}/`,
					description: nextPath,
					iconClass: ThemeIcon.asClassName(Codicon.folder),
					action: 'enter-dir',
					targetPath: nextPath,
				});
			}
		}

		const picked = await new Promise<{ item?: BrowseActionItem; back?: boolean }>(resolve => {
			const qp = quickInput.createQuickPick<BrowseActionItem>({ useSeparators: true });
			qp.title = allowSwitchHost
				? localize('adeBrowseCloudHostStep2Title', "Add Project (2/2) — Select Folder on {0}", host.name)
				: localize('adeBrowseCloudHostTitle', "Select Remote Project Folder on {0}", host.name);
			qp.placeholder = browseError
				? localize('adeCloudBrowseOfflinePlaceholder', "Choose a recent folder or enter a remote path on {0}", host.name)
				: localize('adeCloudBrowsePlaceholder', "Navigate folders or select Open This Folder ({0}:{1})", host.alias, currentDir);
			qp.matchOnDescription = true;
			if (allowSwitchHost) {
				qp.buttons = [quickInput.backButton];
			}
			qp.items = items;
			let settled = false;
			qp.onDidTriggerButton(btn => {
				if (btn === quickInput.backButton) {
					settled = true;
					qp.hide();
					resolve({ back: true });
				}
			});
			qp.onDidAccept(() => {
				settled = true;
				const sel = qp.selectedItems[0];
				qp.hide();
				resolve({ item: sel });
			});
			qp.onDidHide(() => {
				qp.dispose();
				if (!settled) {
					resolve({});
				}
			});
			qp.show();
		});

		if (picked.back || picked.item?.action === 'switch-host') {
			return 'switch-host';
		}

		if (!picked.item) {
			return undefined;
		}

		if (picked.item.action === 'select-current' || picked.item.action === 'select-recent') {
			const finalPath = picked.item.targetPath ?? currentDir;
			await backend.recordRecentDirectory(host.id, finalPath);
			return buildCloudProjectUri(host.alias, finalPath, host.os);
		}

		if (picked.item.action === 'parent' || picked.item.action === 'enter-dir') {
			currentDir = picked.item.targetPath ?? currentDir;
			continue;
		}

		if (picked.item.action === 'mkdir') {
			const folderName = await quickInput.input({
				title: localize('adeCloudNewFolderTitle', "Create Remote Folder in {0}", currentDir),
				prompt: localize('adeCloudNewFolderPrompt', "New folder name"),
				validateInput: async v => v.trim() && !v.includes('/') ? undefined : localize('adeCloudValidFolderName', "Enter a valid folder name."),
			});
			if (folderName?.trim()) {
				const createdPath = posix.join(currentDir, folderName.trim());
				try {
					await backend.remoteMkdir(host.alias, createdPath);
					currentDir = createdPath;
				} catch (err) {
					notifications?.error(err instanceof Error ? err.message : String(err));
				}
			}
			continue;
		}

		if (picked.item.action === 'manual') {
			const manualPath = await quickInput.input({
				title: localize('adeCloudManualPathTitle', "Remote Project Folder on {0}", host.name),
				prompt: localize('adeCloudManualPathPrompt', "Enter absolute path on {0}", formatCloudHostTargetLabel(host)),
				value: currentDir,
				placeHolder: host.os === 'windows' ? 'C:/Users/Administrator/project' : '/home/ubuntu/project',
				validateInput: async v => v.trim() ? undefined : localize('adeCloudManualPathReq', "Remote folder path is required."),
			});
			if (!manualPath?.trim()) {
				continue;
			}
			const norm = normalizeRemoteProjectPath(manualPath.trim(), host.os);
			await backend.recordRecentDirectory(host.id, norm);
			return buildCloudProjectUri(host.alias, norm, host.os);
		}
	}
}

export async function pickCloudHostProjectFolder(
	accessor: ServicesAccessor,
	preselectedHostIdOrAlias?: string,
): Promise<URI | undefined> {
	const instantiationService = accessor.get(IInstantiationService);
	const quickInput = accessor.get(IQuickInputService);
	const commands = accessor.get(ICommandService);
	const notifications = tryGetOptional<INotificationService>(accessor, INotificationService);
	const backend = tryGetOptional<IAdeCloudHostBackendService>(accessor, IAdeCloudHostBackendService);
	if (!backend) {
		return undefined;
	}

	if (preselectedHostIdOrAlias) {
		const targetHost = await backend.getHost(preselectedHostIdOrAlias);
		if (targetHost) {
			return instantiationService.invokeFunction(acc => browseRemoteFolderOnCloudHost(acc, targetHost));
		}
	}

	const editBtn: IQuickInputButton = {
		iconClass: ThemeIcon.asClassName(Codicon.edit),
		tooltip: localize('adeEditCloudHostBtnTooltip', "Edit Cloud Host"),
	};

	while (true) {
		const hosts = await backend.listHosts();
		type HostPickItem = IQuickPickItem & {
			readonly kind: 'host' | 'add-host' | 'import-vscode' | 'open-manager';
			readonly host?: IAdeCloudHost;
		};

		const items: (HostPickItem | IQuickPickSeparator)[] = [
			{
				label: localize('adeAddNewCloudHostItem', "Add New Cloud Host..."),
				description: localize('adeAddNewCloudHostItemDesc', "Save a new SSH Cloud Host (IP, User, Port, SSH Key, ProxyJump)"),
				iconClass: ThemeIcon.asClassName(Codicon.add),
				alwaysShow: true,
				kind: 'add-host',
			},
			{
				label: localize('adeOpenCloudHostManagerItem', "Manage Saved Cloud Hosts..."),
				description: localize('adeOpenCloudHostManagerItemDesc', "Open Cloud Host Studio to edit, test, delete, or open terminals"),
				iconClass: ThemeIcon.asClassName(Codicon.serverProcess),
				alwaysShow: true,
				kind: 'open-manager',
			},
			{
				label: localize('adeImportVsCodeHostsItem', "Sync / Import Cloud Hosts from VS Code & ~/.ssh/config"),
				description: localize('adeImportVsCodeHostsItemDesc', "Migrate SSH hosts, platforms & recent remote project folders from VS Code"),
				iconClass: ThemeIcon.asClassName(Codicon.sync),
				kind: 'import-vscode',
			},
		];

		if (hosts.length > 0) {
			items.push({
				type: 'separator',
				label: localize('adeSavedCloudHostsSep', "Saved & Migrated Cloud Hosts ({0})", hosts.length),
			});
			for (const h of hosts) {
				const jumpTag = h.proxyJump ? ` · via ${h.proxyJump}` : '';
				const recentHint = h.recentDirectories[0] ? ` · ${h.recentDirectories[0]}` : '';
				items.push({
					label: h.name,
					description: `${formatCloudHostTargetLabel(h)} [${h.os}]${jumpTag}${recentHint}`,
					iconClass: ThemeIcon.asClassName(Codicon.remote),
					buttons: [editBtn],
					kind: 'host',
					host: h,
				});
			}
		}

		const picked = await new Promise<{ item?: HostPickItem; editHost?: IAdeCloudHost }>(resolve => {
			const qp = quickInput.createQuickPick<HostPickItem>({ useSeparators: true });
			qp.title = localize('adePickCloudHostTitle', "Select Cloud Host");
			qp.placeholder = localize('adePickCloudHostPlaceholder', "Choose a Cloud Host to browse & add its project folder");
			qp.matchOnDescription = true;
			qp.items = items;
			let settled = false;
			qp.onDidTriggerItemButton(ev => {
				if (ev.item.host) {
					settled = true;
					qp.hide();
					resolve({ editHost: ev.item.host });
				}
			});
			qp.onDidAccept(() => {
				settled = true;
				const sel = qp.selectedItems[0];
				qp.hide();
				resolve({ item: sel });
			});
			qp.onDidHide(() => {
				qp.dispose();
				if (!settled) {
					resolve({});
				}
			});
			qp.show();
		});

		if (picked.editHost) {
			const toEdit = picked.editHost;
			await instantiationService.invokeFunction(acc => promptQuickUpsertCloudHost(acc, toEdit));
			continue;
		}

		if (!picked.item) {
			return undefined;
		}

		if (picked.item.kind === 'add-host') {
			const created = await instantiationService.invokeFunction(acc => promptQuickUpsertCloudHost(acc));
			if (created) {
				return instantiationService.invokeFunction(acc => browseRemoteFolderOnCloudHost(acc, created));
			}
			continue;
		}

		if (picked.item.kind === 'open-manager') {
			await commands.executeCommand(ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID);
			return undefined;
		}

		if (picked.item.kind === 'import-vscode') {
			const res = await backend.importFromVsCodeAndSshConfig();
			notifications?.info(localize(
				'adeImportedVsCodeCloudHostsToast',
				"Synced {0} Cloud Host(s) ({1} new, {2} recent folders) from VS Code & SSH config.",
				res.totalHosts,
				res.importedCount,
				res.importedRecentFolders,
			));
			continue;
		}

		if (picked.item.kind === 'host' && picked.item.host) {
			const chosenHost = picked.item.host;
			const res = await instantiationService.invokeFunction(acc => browseRemoteFolderOnCloudHostWithBack(acc, chosenHost, true));
			if (res === 'switch-host') {
				continue;
			}
			return res;
		}
	}
}

export async function pickProjectFoldersWithCloudOption(
	accessor: ServicesAccessor,
	options: { readonly title?: string } = {},
): Promise<URI[] | undefined> {
	const instantiationService = accessor.get(IInstantiationService);
	const quickInput = accessor.get(IQuickInputService);
	const dialogs = accessor.get(IFileDialogService);
	const commands = accessor.get(ICommandService);
	const notifications = tryGetOptional<INotificationService>(accessor, INotificationService);
	const backend = tryGetOptional<IAdeCloudHostBackendService>(accessor, IAdeCloudHostBackendService);

	const editBtn: IQuickInputButton = {
		iconClass: ThemeIcon.asClassName(Codicon.edit),
		tooltip: localize('adeEditCloudHostBtnTooltip', "Edit Cloud Host"),
	};
	const studioBtn: IQuickInputButton = {
		iconClass: ThemeIcon.asClassName(Codicon.settingsGear),
		tooltip: localize('adeOpenHostInStudioBtnTooltip', "Open in Cloud Host Studio"),
	};

	type HostStepItem = IQuickPickItem & {
		readonly kind: 'local' | 'cloud-host' | 'add-host' | 'open-manager' | 'import-vscode';
		readonly host?: IAdeCloudHost;
	};

	while (true) {
		const hosts = backend ? await backend.listHosts().catch(() => []) : [];

		const items: (HostStepItem | IQuickPickSeparator)[] = [
			{
				type: 'separator',
				label: localize('adeHostStepLocalSep', "Local Host"),
			},
			{
				label: localize('adeHostStepLocalItem', "Local (This Computer)"),
				description: localize('adeHostStepLocalItemDesc', "Select folder(s) on this computer as project workspace(s)"),
				iconClass: ThemeIcon.asClassName(Codicon.deviceDesktop),
				alwaysShow: true,
				kind: 'local',
			},
			{
				type: 'separator',
				label: hosts.length > 0
					? localize('adeHostStepCloudListSepCount', "Cloud Hosts (SSH) · {0}", hosts.length)
					: localize('adeHostStepCloudListSepEmpty', "Cloud Hosts (SSH)"),
			},
		];

		for (const h of hosts) {
			const jumpTag = h.proxyJump ? ` · via ${h.proxyJump}` : '';
			const recentHint = h.recentDirectories[0] ? ` · ${h.recentDirectories[0]}` : '';
			items.push({
				label: h.name,
				description: `${formatCloudHostTargetLabel(h)} [${h.os}]${jumpTag}${recentHint}`,
				iconClass: ThemeIcon.asClassName(Codicon.remote),
				buttons: [editBtn, studioBtn],
				kind: 'cloud-host',
				host: h,
			});
		}

		items.push(
			{
				type: 'separator',
				label: localize('adeHostStepManageSep', "Cloud Host Management"),
			},
			{
				label: localize('adeAddNewCloudHostItem', "Add New Cloud Host..."),
				description: localize('adeHostStepAddNewDesc', "Save a new SSH Cloud Host (IP, User, Port, SSH Key, ProxyJump), then pick a folder"),
				iconClass: ThemeIcon.asClassName(Codicon.add),
				alwaysShow: true,
				kind: 'add-host',
			},
			{
				label: localize('adeOpenCloudHostManagerItem', "Manage Saved Cloud Hosts..."),
				description: localize('adeHostStepManageDesc', "Open Cloud Host Studio to edit, modify, test, or delete Cloud Hosts"),
				iconClass: ThemeIcon.asClassName(Codicon.serverProcess),
				alwaysShow: true,
				kind: 'open-manager',
			},
			{
				label: localize('adeImportVsCodeHostsItem', "Sync / Import Cloud Hosts from VS Code & ~/.ssh/config"),
				description: localize('adeImportVsCodeHostsItemDesc', "Migrate SSH hosts, platforms & recent remote project folders from VS Code"),
				iconClass: ThemeIcon.asClassName(Codicon.sync),
				kind: 'import-vscode',
			},
		);

		const picked = await new Promise<{ item?: HostStepItem; editHost?: IAdeCloudHost; studioHost?: IAdeCloudHost }>(resolve => {
			const qp = quickInput.createQuickPick<HostStepItem>({ useSeparators: true });
			qp.title = options.title
				? localize('adeSelectHostWithPrefixTitle', "{0} (1/2) — Select Host", options.title)
				: localize('adeSelectHostStep1Title', "Add Project (1/2) — Select Host");
			qp.placeholder = localize('adeSelectHostStep1Placeholder', "Choose Local (This Computer) or select a Cloud Host to pick a folder on it");
			qp.matchOnDescription = true;
			qp.items = items;
			let settled = false;
			qp.onDidTriggerItemButton(ev => {
				if (!ev.item.host) {
					return;
				}
				settled = true;
				qp.hide();
				if (ev.button === studioBtn) {
					resolve({ studioHost: ev.item.host });
				} else {
					resolve({ editHost: ev.item.host });
				}
			});
			qp.onDidAccept(() => {
				settled = true;
				const sel = qp.selectedItems[0];
				qp.hide();
				resolve({ item: sel });
			});
			qp.onDidHide(() => {
				qp.dispose();
				if (!settled) {
					resolve({});
				}
			});
			qp.show();
		});

		if (picked.studioHost) {
			await commands.executeCommand(ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID, picked.studioHost.alias);
			return undefined;
		}

		if (picked.editHost) {
			const toEdit = picked.editHost;
			await instantiationService.invokeFunction(acc => promptQuickUpsertCloudHost(acc, toEdit));
			continue;
		}

		if (!picked.item) {
			return undefined;
		}

		if (picked.item.kind === 'local') {
			return dialogs.showOpenDialog({
				title: options.title ?? localize('adeSelectLocalProjectFolderDialog', "Add Local Project Folder"),
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: true,
				availableFileSystems: [Schemas.file],
				defaultUri: await dialogs.defaultFolderPath(Schemas.file),
			});
		}

		if (picked.item.kind === 'cloud-host' && picked.item.host) {
			const chosenHost = picked.item.host;
			const cloudRes = await instantiationService.invokeFunction(acc => browseRemoteFolderOnCloudHostWithBack(acc, chosenHost, true));
			if (cloudRes === 'switch-host') {
				continue;
			}
			return cloudRes ? [cloudRes] : undefined;
		}

		if (picked.item.kind === 'add-host') {
			const created = await instantiationService.invokeFunction(acc => promptQuickUpsertCloudHost(acc));
			if (created) {
				const cloudRes = await instantiationService.invokeFunction(acc => browseRemoteFolderOnCloudHostWithBack(acc, created, true));
				if (cloudRes === 'switch-host') {
					continue;
				}
				return cloudRes ? [cloudRes] : undefined;
			}
			continue;
		}

		if (picked.item.kind === 'open-manager') {
			await commands.executeCommand(ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID);
			return undefined;
		}

		if (picked.item.kind === 'import-vscode' && backend) {
			const res = await backend.importFromVsCodeAndSshConfig();
			notifications?.info(localize(
				'adeImportedVsCodeCloudHostsToast',
				"Synced {0} Cloud Host(s) ({1} new, {2} recent folders) from VS Code & SSH config.",
				res.totalHosts,
				res.importedCount,
				res.importedRecentFolders,
			));
			continue;
		}
	}
}
