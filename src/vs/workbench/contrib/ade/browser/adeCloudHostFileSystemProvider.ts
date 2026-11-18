/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { matchesFuzzy } from '../../../../base/common/filters.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
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
	formatLiveRemoteDirInput,
	IAdeCloudHost,
	IAdeCloudHostBackendService,
	IAdeRemoteDirEntry,
	normalizeRemoteProjectPath,
	parseLiveRemotePathInput,
	resolveInitialCloudHostDirectory,
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
		try {
			const content = await this.backend.remoteGitShowHead(resource.authority, rootPath, relPath);
			if (existing) {
				existing.setValue(content);
				return existing;
			}
			const langSelection = this.languageService.createByFilepathOrFirstLine(URI.file(resource.path));
			return this.modelService.createModel(content, langSelection, resource, false);
		} catch {
			if (existing) {
				return existing;
			}
			const langSelection = this.languageService.createByFilepathOrFirstLine(URI.file(resource.path));
			return this.modelService.createModel('', langSelection, resource, false);
		}
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

	const smartDefaultGuess = osPick.os === 'windows'
		? (parsedUser ? `/C:/Users/${parsedUser}` : '/C:/Users')
		: (osPick.os === 'macos'
			? (parsedUser ? `/Users/${parsedUser}` : '/Users')
			: (parsedUser === 'root' ? '/root' : (parsedUser ? `/home/${parsedUser}` : '/')));
	const defaultDir = await quickInput.input({
		title: localize('adeCloudHostDefaultDirTitle', "Default Remote Project Directory (Optional)"),
		prompt: localize('adeCloudHostDefaultDirPrompt', "Default starting folder when browsing projects on this host (leave blank to auto-detect home)"),
		value: existing?.defaultDirectory ?? smartDefaultGuess,
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

	type BrowseActionItem = IQuickPickItem & {
		readonly action: 'select-current' | 'select-path' | 'select-recent' | 'enter-dir' | 'parent' | 'mkdir-and-enter' | 'mkdir-and-select' | 'switch-host';
		readonly targetPath?: string;
	};

	let hostOs: AdeCloudHostOs = host.os;
	let discoveredHome: string | undefined = host.lastTestStatus?.remoteHome;
	let showDotFolders = false;

	const dirCache = new Map<string, readonly IAdeRemoteDirEntry[]>();
	const dirErrors = new Map<string, string>();

	const addAsProjectInlineBtn: IQuickInputButton = {
		iconClass: ThemeIcon.asClassName(Codicon.check),
		tooltip: localize('adeCloudAddSubfolderDirectlyTooltip', "Add This Folder as Project Workspace"),
	};
	const toggleDotBtn = (): IQuickInputButton => ({
		iconClass: ThemeIcon.asClassName(showDotFolders ? Codicon.eye : Codicon.eyeClosed),
		tooltip: showDotFolders
			? localize('adeCloudHideDotFoldersTooltip', "Hide Hidden (.dot) Folders")
			: localize('adeCloudShowDotFoldersTooltip', "Show Hidden (.dot) Folders"),
	});
	const newFolderHeaderBtn: IQuickInputButton = {
		iconClass: ThemeIcon.asClassName(Codicon.newFolder),
		tooltip: localize('adeCloudNewFolderHeaderTooltip', "Create New Folder in Current Path"),
	};
	const refreshHeaderBtn: IQuickInputButton = {
		iconClass: ThemeIcon.asClassName(Codicon.refresh),
		tooltip: localize('adeCloudRefreshFoldersTooltip', "Refresh Remote Folders"),
	};

	const initialDir = resolveInitialCloudHostDirectory(host);
	const hadExplicitInitialDir = Boolean(
		host.defaultDirectory?.trim() || host.recentDirectories[0]?.trim() || host.lastTestStatus?.remoteHome?.trim(),
	);

	return new Promise<URI | 'switch-host' | undefined>(resolve => {
		const store = new DisposableStore();
		const qp = store.add(quickInput.createQuickPick<BrowseActionItem>({ useSeparators: true }));

		let settled = false;
		let suppressValueChange = false;
		let userHasEditedValue = false;
		let requestSeq = 0;
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;

		const clearDebounce = () => {
			if (debounceTimer !== undefined) {
				clearTimeout(debounceTimer);
				debounceTimer = undefined;
			}
		};
		store.add({ dispose: clearDebounce });

		const finish = (outcome: URI | 'switch-host' | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			clearDebounce();
			qp.hide();
			store.dispose();
			resolve(outcome);
		};

		const updateHeaderButtons = () => {
			const btns: IQuickInputButton[] = [];
			if (allowSwitchHost) {
				btns.push(quickInput.backButton);
			}
			btns.push(toggleDotBtn(), newFolderHeaderBtn, refreshHeaderBtn);
			qp.buttons = btns;
		};

		const setInputValueProgrammatically = (nextVal: string, selectionRange?: readonly [number, number]) => {
			suppressValueChange = true;
			try {
				qp.value = nextVal;
				qp.valueSelection = selectionRange ?? [nextVal.length, nextVal.length];
			} finally {
				suppressValueChange = false;
			}
		};

		const warmParentCache = (parentDir: string | undefined) => {
			if (!parentDir || dirCache.has(parentDir) || dirErrors.has(parentDir)) {
				return;
			}
			void backend.remoteReadDir(host.alias, parentDir).then(
				entries => {
					if (!settled) {
						dirCache.set(parentDir, entries);
					}
				},
				() => { /* ignore background prefetch error */ },
			);
		};

		const confirmAndFinishWithPath = async (rawTargetPath: string) => {
			const norm = normalizeRemoteProjectPath(rawTargetPath, hostOs);
			if (hostOs === 'windows' && norm === '/') {
				qp.validationMessage = localize('adeCloudPickWinDriveValidation', "Please select a Windows drive (e.g. /C:/) or folder first.");
				return;
			}
			qp.busy = true;
			try {
				const st = await backend.remoteStat(host.alias, norm);
				if (st.type === 'file') {
					qp.busy = false;
					qp.validationMessage = localize('adeCloudTargetIsFileValidation', "'{0}' is a file. Please select a folder.", norm);
					return;
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes('[EISDIR]')) {
					// Directory confirmed
				} else if (msg.includes('[ENOTDIR]')) {
					qp.busy = false;
					qp.validationMessage = localize('adeCloudTargetIsFileValidation', "'{0}' is a file. Please select a folder.", norm);
					return;
				} else if (msg.includes('[ENOENT]')) {
					qp.busy = false;
					qp.validationMessage = localize('adeCloudFolderDoesNotExistValidation', "Folder '{0}' does not exist yet — select 'Create & Add as Project' below or edit the path.", norm);
					return;
				}
				// For offline/unimplemented stat stubs, allow confirming the normalized path directly.
			}
			await backend.recordRecentDirectory(host.id, norm);
			finish(buildCloudProjectUri(host.alias, norm, hostOs));
		};

		const shortSepPath = (p: string): string => p.length <= 28 ? p : `…/${posix.basename(p) || p.slice(-20)}`;

		const renderItemsForState = (rawInput: string) => {
			const parsed = parseLiveRemotePathInput(rawInput, hostOs, discoveredHome);
			const dirEntries = dirCache.get(parsed.browseDir) ?? [];
			const browseError = dirErrors.get(parsed.browseDir);
			const sepDirLabel = shortSepPath(parsed.browseDir);

			const includeDots = showDotFolders || parsed.filterPrefix.startsWith('.');
			const allDirs = dirEntries
				.filter(e => e.type === 'directory' && (includeDots || !e.name.startsWith('.')))
				.sort((a, b) => a.name.localeCompare(b.name));

			const makeDirItem = (sub: IAdeRemoteDirEntry, highlights?: { label?: { start: number; end: number }[] }): BrowseActionItem => {
				const joined = posix.join(parsed.browseDir, sub.name);
				const nextPath = parsed.browseDir.startsWith('//') && !joined.startsWith('//') ? `/${joined}` : joined;
				const isDriveItem = parsed.isWindowsDriveRoot && /^[A-Za-z]:$/.test(sub.name);
				return {
					label: `${sub.name}/`,
					description: isDriveItem ? localize('adeCloudWindowsDriveDesc', "Windows Drive ({0}\\)", sub.name) : nextPath,
					iconClass: ThemeIcon.asClassName(isDriveItem ? Codicon.vm : Codicon.folder),
					highlights,
					buttons: isDriveItem ? undefined : [addAsProjectInlineBtn],
					action: 'enter-dir',
					targetPath: nextPath,
				};
			};

			const items: (BrowseActionItem | IQuickPickSeparator)[] = [];
			const needle = parsed.filterPrefix.trim();

			if (needle) {
				const lowerNeedle = needle.toLowerCase().replace(/:$/, '');
				const matched: { entry: IAdeRemoteDirEntry; rank: number; ranges?: { start: number; end: number }[] }[] = [];
				const unmatched: IAdeRemoteDirEntry[] = [];

				for (const sub of allDirs) {
					const cleanSub = sub.name.replace(/:$/, '');
					const lowerName = sub.name.toLowerCase();
					const lowerClean = cleanSub.toLowerCase();
					if (lowerName === needle.toLowerCase() || lowerClean === lowerNeedle) {
						matched.push({ entry: sub, rank: 0, ranges: [{ start: 0, end: Math.min(sub.name.length, needle.length) }] });
					} else if (lowerName.startsWith(needle.toLowerCase()) || lowerClean.startsWith(lowerNeedle)) {
						matched.push({ entry: sub, rank: 1, ranges: [{ start: 0, end: Math.min(sub.name.length, needle.length) }] });
					} else {
						const subIdx = lowerName.indexOf(needle.toLowerCase());
						if (subIdx >= 0) {
							matched.push({ entry: sub, rank: 2, ranges: [{ start: subIdx, end: subIdx + needle.length }] });
						} else {
							const fuzzy = matchesFuzzy(needle, sub.name, true);
							if (fuzzy) {
								matched.push({ entry: sub, rank: 3, ranges: fuzzy });
							} else {
								unmatched.push(sub);
							}
						}
					}
				}
				matched.sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name));

				if (matched.length > 0) {
					items.push({
						type: 'separator',
						label: parsed.isWindowsDriveRoot
							? localize('adeCloudMatchingDrivesSep', "Matching Drives on {0}", host.name)
							: localize('adeCloudMatchingFoldersSep', "Matching Folders in {0}", sepDirLabel),
					});
					for (const m of matched) {
						items.push(makeDirItem(m.entry, m.ranges ? { label: m.ranges } : undefined));
					}
				}

				if (!parsed.isWindowsDriveRoot) {
					const exactDirExists = allDirs.some(d => d.name.toLowerCase() === needle.toLowerCase());
					items.push({
						type: 'separator',
						label: localize('adeCloudTargetActionsSep', "Target Path Actions"),
					});
					if (exactDirExists || browseError) {
						items.push({
							label: localize('adeCloudOpenTypedFolderItem', "Open This Folder: {0}", parsed.targetPath),
							description: localize('adeCloudAddAsProjectDesc', "Add {0}:{1} as Project Workspace", host.alias, parsed.targetPath),
							iconClass: ThemeIcon.asClassName(Codicon.check),
							action: 'select-path',
							targetPath: parsed.targetPath,
						});
					} else {
						items.push({
							label: localize('adeCloudCreateAndAddFolderItem', "Create & Add as Project: {0}", parsed.targetPath),
							description: localize('adeCloudCreateAndAddFolderDesc', "Create remote folder on {0} and open as workspace", host.alias),
							iconClass: ThemeIcon.asClassName(Codicon.check),
							action: 'mkdir-and-select',
							targetPath: parsed.targetPath,
						});
						items.push({
							label: localize('adeCloudCreateAndEnterFolderItem', "Create & Enter Folder: {0}/", parsed.targetPath),
							description: localize('adeCloudCreateAndEnterFolderDesc', "Create remote folder and continue browsing inside it"),
							iconClass: ThemeIcon.asClassName(Codicon.newFolder),
							action: 'mkdir-and-enter',
							targetPath: parsed.targetPath,
						});
					}
				}

				if (unmatched.length > 0 || parsed.parentDir !== undefined) {
					items.push({
						type: 'separator',
						label: parsed.isWindowsDriveRoot
							? localize('adeCloudOtherDrivesSep', "All Drives on {0}", host.name)
							: localize('adeCloudOtherFoldersInParentSep', "Other Folders in {0}", sepDirLabel),
					});
					if (parsed.parentDir !== undefined) {
						items.push({
							label: '..',
							description: localize('adeCloudParentFolderDesc', "Up to {0}", shortSepPath(parsed.parentDir)),
							iconClass: ThemeIcon.asClassName(Codicon.arrowUp),
							action: 'parent',
							targetPath: parsed.parentDir,
						});
					}
					for (const sub of unmatched) {
						items.push(makeDirItem(sub));
					}
				}
			} else {
				if (!parsed.isWindowsDriveRoot && !browseError) {
					items.push({
						label: localize('adeCloudUseCurrentFolder', "Open This Folder: {0}", parsed.browseDir),
						description: localize('adeCloudAddAsProjectDesc', "Add {0}:{1} as Project Workspace", host.alias, parsed.browseDir),
						iconClass: ThemeIcon.asClassName(Codicon.check),
						action: 'select-current',
						targetPath: parsed.browseDir,
					});
				} else if (!parsed.isWindowsDriveRoot && browseError) {
					items.push({
						label: localize('adeCloudUseTypedPathOffline', "Open This Folder: {0}", parsed.browseDir),
						description: localize('adeCloudOfflineFolderHint', "Live listing unavailable ({0}) — add path directly or edit above", browseError.slice(0, 64)),
						iconClass: ThemeIcon.asClassName(Codicon.check),
						action: 'select-path',
						targetPath: parsed.browseDir,
					});
				}

				items.push({
					type: 'separator',
					label: parsed.isWindowsDriveRoot
						? localize('adeCloudWindowsDrivesSep', "Drives on {0}", host.name)
						: localize('adeCloudSubfoldersSep', "Folders in {0}", sepDirLabel),
				});

				if (parsed.parentDir !== undefined) {
					items.push({
						label: '..',
						description: localize('adeCloudParentFolderDesc', "Up to {0}", shortSepPath(parsed.parentDir)),
						iconClass: ThemeIcon.asClassName(Codicon.arrowUp),
						action: 'parent',
						targetPath: parsed.parentDir,
					});
				}

				for (const sub of allDirs) {
					items.push(makeDirItem(sub));
				}

				if (host.recentDirectories.length > 0) {
					items.push({ type: 'separator', label: localize('adeCloudRecentFoldersSep', "Recent & Migrated VS Code Folders") });
					for (const recPath of host.recentDirectories) {
						if (recPath === parsed.browseDir) {
							continue;
						}
						items.push({
							label: basename(URI.from({ scheme: AEXUS_SSH_SCHEME, authority: host.alias, path: recPath })) || recPath,
							description: `${host.alias}:${recPath}`,
							iconClass: ThemeIcon.asClassName(Codicon.history),
							action: 'select-recent',
							targetPath: recPath,
						});
					}
				}
			}

			if (allowSwitchHost) {
				items.push({ type: 'separator', label: localize('adeCloudHostNavSep', "Host") });
				items.push({
					label: localize('adeCloudSwitchHostItem', "Switch Host..."),
					description: localize('adeCloudSwitchHostItemDesc', "Go back to select Local or another Cloud Host"),
					iconClass: ThemeIcon.asClassName(Codicon.arrowLeft),
					action: 'switch-host',
				});
			}

			qp.prompt = browseError
				? localize('adeCloudLivePathErrorPrompt', "Cannot list {0} ({1}) — Backspace for parent folder", sepDirLabel, browseError.slice(0, 56))
				: localize('adeCloudLivePathHintPrompt', "Type path or Backspace for parent folders · Enter opens folder · Click 'Open' to add");
			qp.items = items;
		};

		const ensureDirLoadedAndRender = async (rawInput: string, forceNetwork = false, allowInitialFallback = false) => {
			if (settled) {
				return;
			}
			const parsed = parseLiveRemotePathInput(rawInput, hostOs, discoveredHome);
			if (!forceNetwork && dirCache.has(parsed.browseDir)) {
				qp.busy = false;
				renderItemsForState(qp.value);
				warmParentCache(parsed.parentDir);
				return;
			}

			const seq = ++requestSeq;
			qp.busy = true;
			renderItemsForState(rawInput);

			try {
				const entries = await backend.remoteReadDir(host.alias, parsed.browseDir);
				if (settled) {
					return;
				}
				dirCache.set(parsed.browseDir, entries);
				dirErrors.delete(parsed.browseDir);
				if (seq === requestSeq) {
					qp.busy = false;
					renderItemsForState(qp.value);
					warmParentCache(parsed.parentDir);
				}
			} catch (err) {
				if (settled) {
					return;
				}
				const cleanErr = err instanceof Error ? err.message.replace(/^\[[A-Z]+\]\s*/, '') : String(err);

				// On initial open before user edits, auto-discover real remote home / OS or walk up to existing parent folder!
				if (allowInitialFallback && !userHasEditedValue) {
					if (!hadExplicitInitialDir) {
						try {
							const check = await backend.testConnection(host.id);
							if (!settled && !userHasEditedValue && check.ok) {
								if (check.os) {
									hostOs = check.os;
								}
								if (check.remoteHome) {
									discoveredHome = check.remoteHome;
									const realHome = normalizeRemoteProjectPath(check.remoteHome, hostOs);
									if (realHome !== parsed.browseDir) {
										const nextDisplay = formatLiveRemoteDirInput(realHome, hostOs, false);
										setInputValueProgrammatically(nextDisplay);
										await ensureDirLoadedAndRender(nextDisplay, true, true);
										return;
									}
								}
							}
						} catch {
							// proceed to parent walk-up
						}
					}
					if (!settled && !userHasEditedValue && parsed.parentDir !== undefined && parsed.parentDir !== parsed.browseDir) {
						const parentDisplay = formatLiveRemoteDirInput(parsed.parentDir, hostOs, parsed.omitLeadingSlashOnWindows);
						setInputValueProgrammatically(parentDisplay);
						await ensureDirLoadedAndRender(parentDisplay, true, true);
						return;
					}
				}

				dirErrors.set(parsed.browseDir, cleanErr);
				dirCache.delete(parsed.browseDir);
				if (seq === requestSeq) {
					qp.busy = false;
					renderItemsForState(qp.value);
					warmParentCache(parsed.parentDir);
				}
			}
		};

		const navigateToDirectory = (dirPath: string) => {
			const curParsed = parseLiveRemotePathInput(qp.value, hostOs, discoveredHome);
			const formatted = formatLiveRemoteDirInput(dirPath, hostOs, curParsed.omitLeadingSlashOnWindows);
			qp.validationMessage = undefined;
			clearDebounce();
			setInputValueProgrammatically(formatted);
			void ensureDirLoadedAndRender(formatted, false, false);
		};

		qp.title = allowSwitchHost
			? localize('adeBrowseCloudHostStep2Title', "Add Project (2/2) — Select Folder on {0}", host.name)
			: localize('adeBrowseCloudHostTitle', "Select Remote Project Folder on {0}", host.name);
		qp.placeholder = hostOs === 'windows'
			? localize('adeCloudLiveWinPathPlaceholder', "Type remote path (e.g. /C:/Users/...) or select a folder below")
			: localize('adeCloudLivePosixPathPlaceholder', "Type remote path (e.g. /home/...) or select a folder below");
		qp.matchOnLabel = false;
		qp.matchOnDescription = false;
		qp.matchOnDetail = false;
		qp.sortByLabel = false;
		qp.keepScrollPosition = false;
		qp.ignoreFocusOut = true;
		qp.customButton = true;
		qp.customLabel = localize('adeCloudConfirmAddProjectBtn', "Open");
		qp.customHover = localize('adeCloudConfirmAddProjectHover', "Add the folder path in the input box as a Project Workspace");
		updateHeaderButtons();

		const initialDisplay = formatLiveRemoteDirInput(initialDir, hostOs, false);
		setInputValueProgrammatically(initialDisplay);

		store.add(qp.onDidChangeValue(val => {
			if (suppressValueChange || settled) {
				return;
			}
			userHasEditedValue = true;
			qp.validationMessage = undefined;
			clearDebounce();

			const parsed = parseLiveRemotePathInput(val, hostOs, discoveredHome);
			if (dirCache.has(parsed.browseDir)) {
				// Instant 0ms popup when typing/filtering or pressing Backspace into a cached parent directory!
				requestSeq++;
				qp.busy = false;
				renderItemsForState(val);
				warmParentCache(parsed.parentDir);
				return;
			}

			renderItemsForState(val);
			debounceTimer = setTimeout(() => {
				debounceTimer = undefined;
				void ensureDirLoadedAndRender(qp.value, false, false);
			}, 60);
		}));

		store.add(qp.onDidTriggerButton(btn => {
			if (settled) {
				return;
			}
			if (btn === quickInput.backButton) {
				finish('switch-host');
				return;
			}
			if (btn === newFolderHeaderBtn) {
				const parsed = parseLiveRemotePathInput(qp.value, hostOs, discoveredHome);
				if (parsed.isWindowsDriveRoot) {
					qp.validationMessage = localize('adeCloudPickWinDriveBeforeMkdir', "Open a drive (e.g. /C:/) first before creating a new folder.");
					return;
				}
				const base = formatLiveRemoteDirInput(parsed.browseDir, hostOs, parsed.omitLeadingSlashOnWindows);
				const draftLeaf = 'new-folder';
				const nextVal = `${base}${draftLeaf}`;
				qp.validationMessage = undefined;
				userHasEditedValue = true;
				setInputValueProgrammatically(nextVal, [base.length, nextVal.length]);
				renderItemsForState(nextVal);
				return;
			}
			if (btn === refreshHeaderBtn) {
				const parsed = parseLiveRemotePathInput(qp.value, hostOs, discoveredHome);
				dirCache.delete(parsed.browseDir);
				dirErrors.delete(parsed.browseDir);
				void ensureDirLoadedAndRender(qp.value, true, false);
				return;
			}
			// Toggle dot folders button
			showDotFolders = !showDotFolders;
			updateHeaderButtons();
			renderItemsForState(qp.value);
		}));

		store.add(qp.onDidTriggerItemButton(ev => {
			if (settled) {
				return;
			}
			if (ev.button === addAsProjectInlineBtn && ev.item.targetPath) {
				void confirmAndFinishWithPath(ev.item.targetPath);
			}
		}));

		store.add(qp.onDidCustom(() => {
			if (settled) {
				return;
			}
			const parsed = parseLiveRemotePathInput(qp.value, hostOs, discoveredHome);
			void confirmAndFinishWithPath(parsed.targetPath);
		}));

		store.add(qp.onDidAccept(async () => {
			if (settled) {
				return;
			}
			const sel = qp.selectedItems[0] ?? qp.activeItems[0];
			if (!sel) {
				const parsed = parseLiveRemotePathInput(qp.value, hostOs, discoveredHome);
				await confirmAndFinishWithPath(parsed.targetPath);
				return;
			}

			if (sel.action === 'switch-host') {
				finish('switch-host');
				return;
			}

			if (sel.action === 'enter-dir' || sel.action === 'parent') {
				if (sel.targetPath) {
					navigateToDirectory(sel.targetPath);
				}
				return;
			}

			if (sel.action === 'select-current' || sel.action === 'select-path' || sel.action === 'select-recent') {
				const parsed = parseLiveRemotePathInput(qp.value, hostOs, discoveredHome);
				await confirmAndFinishWithPath(sel.targetPath ?? parsed.targetPath);
				return;
			}

			if ((sel.action === 'mkdir-and-enter' || sel.action === 'mkdir-and-select') && sel.targetPath) {
				const targetToCreate = normalizeRemoteProjectPath(sel.targetPath, hostOs);
				qp.busy = true;
				try {
					await backend.remoteMkdir(host.alias, targetToCreate);
					dirCache.delete(posix.dirname(targetToCreate));
					if (sel.action === 'mkdir-and-select') {
						await backend.recordRecentDirectory(host.id, targetToCreate);
						finish(buildCloudProjectUri(host.alias, targetToCreate, hostOs));
					} else {
						navigateToDirectory(targetToCreate);
					}
				} catch (err) {
					qp.busy = false;
					const msg = err instanceof Error ? err.message : String(err);
					qp.validationMessage = msg;
					notifications?.error(msg);
				}
			}
		}));

		store.add(qp.onDidHide(() => {
			if (!settled) {
				finish(undefined);
			}
		}));

		qp.show();
		// Re-apply end-of-input cursor placement right after show() so QuickInput doesn't select-all the initial path!
		qp.valueSelection = [initialDisplay.length, initialDisplay.length];

		if (!hadExplicitInitialDir) {
			// Probe remote home & OS first on hosts without an explicit saved folder so we jump directly into actual $HOME / %USERPROFILE%!
			qp.busy = true;
			void backend.testConnection(host.id).then(
				check => {
					if (settled) {
						return;
					}
					if (!userHasEditedValue && check.ok) {
						if (check.os) {
							hostOs = check.os;
						}
						if (check.remoteHome) {
							discoveredHome = check.remoteHome;
							const realHome = normalizeRemoteProjectPath(check.remoteHome, hostOs);
							const homeDisplay = formatLiveRemoteDirInput(realHome, hostOs, false);
							setInputValueProgrammatically(homeDisplay);
							void ensureDirLoadedAndRender(homeDisplay, false, true);
							return;
						}
					}
					void ensureDirLoadedAndRender(qp.value, false, true);
				},
				() => {
					if (!settled) {
						void ensureDirLoadedAndRender(qp.value, false, true);
					}
				},
			);
		} else {
			void ensureDirLoadedAndRender(initialDisplay, false, true);
		}
	});
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
