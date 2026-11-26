/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise,timeout } from '../../../base/common/async.js';
import { bufferToStream,readableToBuffer,VSBuffer,VSBufferReadable } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter,Event } from '../../../base/common/event.js';
import { IMarkdownString } from '../../../base/common/htmlContent.js';
import { Iterable } from '../../../base/common/iterator.js';
import { Disposable,IDisposable,toDisposable } from '../../../base/common/lifecycle.js';
import { ResourceMap,ResourceSet } from '../../../base/common/map.js';
import { Schemas } from '../../../base/common/network.js';
import { observableValue } from '../../../base/common/observable.js';
import { join } from '../../../base/common/path.js';
import { isLinux,isMacintosh } from '../../../base/common/platform.js';
import { basename,isEqual,isEqualAuthority,isEqualOrParent,removeTrailingPathSeparator } from '../../../base/common/resources.js';
import { AEXUS_SSH_SCHEME } from '../../../platform/ade/common/adeCloudHosts.js';
import { AdeCliCommandName } from '../../../platform/ade/common/adeCliManifest.js';
import {
	IAdeAgentLaunchBundle,
	IAdeAgentRuntimeDisposeEvent,
	IAdeControlCenterService,
	IAdeOutboxDeliveryItem,
	IAdeUiCreateAgentInput,
	IAdeUiEditAgentInput,
	IAdeUiWhiteboardInspection,
	IAdeVerifiedCliCaller,
	IAdeWbItemsFilter,
} from '../../../platform/ade/common/adeControlCenterIpc.js';
import {
	AdeBoardPermission,
	AdeError,
	AdeLayoutDirection,
	AdeTicketDeliveryMode,
	IAdeAgentNode,
	IAdeBoardGrant,
	IAdeBoardItemPublicSummary,
	IAdeBoardNotePublicItem,
	IAdeCatalogSnapshot,
	IAdeDeletedAgentArchive,
	IAdeDepartment,
	IAdeEdgeTransferRecord,
	IAdeProjectHostEntry,
	IAdeProjectMeta,
	IAdeProjectSnapshot,
	IAdeProjectSummaryItem,
	IAdeTicketSummaryCard,
	IAdeTicketTransferAnimationEvent,
	IAdeUiTicketFullInspection,
	IAdeUiTicketTaskRecord,
	IAdeWhiteboard,
	IAdeWorkspaceFolder,
} from '../../../platform/ade/common/adeModels.js';
import { URI } from '../../../base/common/uri.js';
import { ITextResourcePropertiesService } from '../../../editor/common/services/textResourceConfiguration.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IResourceEditorInput } from '../../../platform/editor/common/editor.js';
import { FileChangesEvent,FileOperationEvent,FileSystemProviderCapabilities,IBaseFileStat,ICreateFileOptions,IFileContent,IFileService,IFileStat,IFileStatResult,IFileStatWithMetadata,IFileStatWithPartialMetadata,IFileStreamContent,IFileSystemProvider,IFileSystemProviderActivationEvent,IFileSystemProviderCapabilitiesChangeEvent,IFileSystemWatcher,IReadFileOptions,IReadFileStreamOptions,IResolveFileOptions,IResolveMetadataFileOptions,IWatchOptions,IWatchOptionsWithCorrelation,IWriteFileOptions } from '../../../platform/files/common/files.js';
import { AbstractLoggerService,ILogger,LogLevel,NullLogger } from '../../../platform/log/common/log.js';
import { IMarker,IMarkerChangeOptions,IMarkerData,IMarkerService,IResourceMarker,MarkerStatistics } from '../../../platform/markers/common/markers.js';
import product from '../../../platform/product/common/product.js';
import { IProgress,IProgressStep } from '../../../platform/progress/common/progress.js';
import { InMemoryStorageService,WillSaveStateReason } from '../../../platform/storage/common/storage.js';
import { toUserDataProfile } from '../../../platform/userDataProfile/common/userDataProfile.js';
import { ISingleFolderWorkspaceIdentifier,IWorkspace,IWorkspaceContextService,IWorkspaceFolder,IWorkspaceFoldersChangeEvent,IWorkspaceFoldersWillChangeEvent,IWorkspaceIdentifier,WorkbenchState,Workspace } from '../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustEnablementService,IWorkspaceTrustManagementService,IWorkspaceTrustRequestService,IWorkspaceTrustTransitionParticipant,IWorkspaceTrustUriInfo,ResourceTrustRequestOptions,WorkspaceTrustRequestOptions,WorkspaceTrustUriResponse } from '../../../platform/workspace/common/workspaceTrust.js';
import { TestWorkspace } from '../../../platform/workspace/test/common/testWorkspace.js';
import { GroupIdentifier,IRevertOptions,ISaveOptions,SaveReason } from '../../common/editor.js';
import { EditorInput } from '../../common/editor/editorInput.js';
import { IActivity,IActivityService } from '../../services/activity/common/activity.js';
import { ChatEntitlement,IChatEntitlementService } from '../../services/chat/common/chatEntitlementService.js';
import { NullExtensionService } from '../../services/extensions/common/extensions.js';
import { IAutoSaveConfiguration,IAutoSaveMode,IFilesConfigurationService } from '../../services/filesConfiguration/common/filesConfigurationService.js';
import { IHistoryService } from '../../services/history/common/history.js';
import { BeforeShutdownErrorEvent,ILifecycleService,InternalBeforeShutdownEvent,LifecyclePhase,ShutdownReason,StartupKind,WillShutdownEvent } from '../../services/lifecycle/common/lifecycle.js';
import { IResourceEncoding } from '../../services/textfile/common/textfiles.js';
import { IUserDataProfileService } from '../../services/userDataProfile/common/userDataProfile.js';
import { IStoredFileWorkingCopySaveEvent } from '../../services/workingCopy/common/storedFileWorkingCopy.js';
import { IWorkingCopy,IWorkingCopyBackup,WorkingCopyCapabilities } from '../../services/workingCopy/common/workingCopy.js';
import { ICopyOperation,ICreateFileOperation,ICreateOperation,IDeleteOperation,IFileOperationUndoRedoInfo,IMoveOperation,IStoredFileWorkingCopySaveParticipant,IStoredFileWorkingCopySaveParticipantContext,IWorkingCopyFileOperationParticipant,IWorkingCopyFileService,WorkingCopyFileEvent } from '../../services/workingCopy/common/workingCopyFileService.js';

export class TestLoggerService extends AbstractLoggerService {
	constructor(logsHome?: URI) {
		super(LogLevel.Info, logsHome ?? URI.file('tests').with({ scheme: 'vscode-tests' }));
	}
	protected doCreateLogger(): ILogger { return new NullLogger(); }
}

export class TestTextResourcePropertiesService implements ITextResourcePropertiesService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
	}

	getEOL(resource: URI, language?: string): string {
		const eol = this.configurationService.getValue('files.eol', { overrideIdentifier: language, resource });
		if (eol && typeof eol === 'string' && eol !== 'auto') {
			return eol;
		}
		return (isLinux || isMacintosh) ? '\n' : '\r\n';
	}
}

export class TestUserDataProfileService implements IUserDataProfileService {

	readonly _serviceBrand: undefined;
	readonly onDidChangeCurrentProfile = Event.None;
	readonly currentProfile = toUserDataProfile('test', 'test', URI.file('tests').with({ scheme: 'vscode-tests' }), URI.file('tests').with({ scheme: 'vscode-tests' }));
	async updateCurrentProfile(): Promise<void> { }
}

export class TestContextService implements IWorkspaceContextService {

	declare readonly _serviceBrand: undefined;

	private workspace: Workspace;
	private options: object;

	private readonly _onDidChangeWorkspaceName: Emitter<void>;
	get onDidChangeWorkspaceName(): Event<void> { return this._onDidChangeWorkspaceName.event; }

	private readonly _onWillChangeWorkspaceFolders: Emitter<IWorkspaceFoldersWillChangeEvent>;
	get onWillChangeWorkspaceFolders(): Event<IWorkspaceFoldersWillChangeEvent> { return this._onWillChangeWorkspaceFolders.event; }

	private readonly _onDidChangeWorkspaceFolders: Emitter<IWorkspaceFoldersChangeEvent>;
	get onDidChangeWorkspaceFolders(): Event<IWorkspaceFoldersChangeEvent> { return this._onDidChangeWorkspaceFolders.event; }

	private readonly _onDidChangeWorkbenchState: Emitter<WorkbenchState>;
	get onDidChangeWorkbenchState(): Event<WorkbenchState> { return this._onDidChangeWorkbenchState.event; }

	constructor(workspace = TestWorkspace, options = null) {
		this.workspace = workspace;
		this.options = options || Object.create(null);
		this._onDidChangeWorkspaceName = new Emitter<void>();
		this._onWillChangeWorkspaceFolders = new Emitter<IWorkspaceFoldersWillChangeEvent>();
		this._onDidChangeWorkspaceFolders = new Emitter<IWorkspaceFoldersChangeEvent>();
		this._onDidChangeWorkbenchState = new Emitter<WorkbenchState>();
	}

	getFolders(): IWorkspaceFolder[] {
		return this.workspace ? this.workspace.folders : [];
	}

	getWorkbenchState(): WorkbenchState {
		if (this.workspace.configuration) {
			return WorkbenchState.WORKSPACE;
		}

		if (this.workspace.folders.length) {
			return WorkbenchState.FOLDER;
		}

		return WorkbenchState.EMPTY;
	}

	hasWorkspaceData(): boolean {
		return this.getWorkbenchState() !== WorkbenchState.EMPTY;
	}

	getCompleteWorkspace(): Promise<IWorkspace> {
		return Promise.resolve(this.getWorkspace());
	}

	getWorkspace(): IWorkspace {
		return this.workspace;
	}

	getWorkspaceFolder(resource: URI): IWorkspaceFolder | null {
		return this.workspace.getFolder(resource);
	}

	setWorkspace(workspace: any): void {
		this.workspace = workspace;
	}

	getOptions() {
		return this.options;
	}

	updateOptions() { }

	isInsideWorkspace(resource: URI): boolean {
		if (resource && this.workspace) {
			return isEqualOrParent(resource, this.workspace.folders[0].uri);
		}

		return false;
	}

	toResource(workspaceRelativePath: string): URI {
		return URI.file(join('C:\\', workspaceRelativePath));
	}

	isCurrentWorkspace(workspaceIdOrFolder: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | URI): boolean {
		return URI.isUri(workspaceIdOrFolder) && isEqual(this.workspace.folders[0].uri, workspaceIdOrFolder);
	}
}

export class TestStorageService extends InMemoryStorageService {

	testEmitWillSaveState(reason: WillSaveStateReason): void {
		super.emitWillSaveState(reason);
	}
}

export class TestHistoryService implements IHistoryService {

	declare readonly _serviceBrand: undefined;

	constructor(private root?: URI) { }

	async reopenLastClosedEditor(): Promise<void> { }
	async goForward(): Promise<void> { }
	async goBack(): Promise<void> { }
	async goPrevious(): Promise<void> { }
	async goLast(): Promise<void> { }
	removeFromHistory(_input: EditorInput | IResourceEditorInput): void { }
	clear(): void { }
	clearRecentlyOpened(): void { }
	getHistory(): readonly (EditorInput | IResourceEditorInput)[] { return []; }
	async openNextRecentlyUsedEditor(group?: GroupIdentifier): Promise<void> { }
	async openPreviouslyUsedEditor(group?: GroupIdentifier): Promise<void> { }
	getLastActiveWorkspaceRoot(_schemeFilter: string): URI | undefined { return this.root; }
	getLastActiveFile(_schemeFilter: string): URI | undefined { return undefined; }
}

export class TestWorkingCopy extends Disposable implements IWorkingCopy {

	private readonly _onDidChangeDirty = this._register(new Emitter<void>());
	readonly onDidChangeDirty = this._onDidChangeDirty.event;

	private readonly _onDidChangeContent = this._register(new Emitter<void>());
	readonly onDidChangeContent = this._onDidChangeContent.event;

	private readonly _onDidSave = this._register(new Emitter<IStoredFileWorkingCopySaveEvent>());
	readonly onDidSave = this._onDidSave.event;

	readonly capabilities = WorkingCopyCapabilities.None;

	readonly name;

	private dirty = false;

	constructor(readonly resource: URI, isDirty = false, readonly typeId = 'testWorkingCopyType') {
		super();

		this.name = basename(this.resource);
		this.dirty = isDirty;
	}

	setDirty(dirty: boolean): void {
		if (this.dirty !== dirty) {
			this.dirty = dirty;
			this._onDidChangeDirty.fire();
		}
	}

	setContent(content: string): void {
		this._onDidChangeContent.fire();
	}

	isDirty(): boolean {
		return this.dirty;
	}

	isModified(): boolean {
		return this.isDirty();
	}

	async save(options?: ISaveOptions, stat?: IFileStatWithMetadata): Promise<boolean> {
		this._onDidSave.fire({ reason: options?.reason ?? SaveReason.EXPLICIT, stat: stat ?? createFileStat(this.resource), source: options?.source });

		return true;
	}

	async revert(options?: IRevertOptions): Promise<void> {
		this.setDirty(false);
	}

	async backup(token: CancellationToken): Promise<IWorkingCopyBackup> {
		return {};
	}
}

export function createFileStat(resource: URI, readonly = false, isFile?: boolean, isDirectory?: boolean, isSymbolicLink?: boolean, children?: { resource: URI; isFile?: boolean; isDirectory?: boolean; isSymbolicLink?: boolean; executable?: boolean }[] | undefined, executable?: boolean): IFileStatWithMetadata {
	return {
		resource,
		etag: Date.now().toString(),
		mtime: Date.now(),
		ctime: Date.now(),
		size: 42,
		isFile: isFile ?? true,
		isDirectory: isDirectory ?? false,
		isSymbolicLink: isSymbolicLink ?? false,
		readonly,
		locked: false,
		executable: executable ?? false,
		name: basename(resource),
		children: children?.map(c => createFileStat(c.resource, false, c.isFile, c.isDirectory, c.isSymbolicLink, undefined, c.executable)),
	};
}

export class TestWorkingCopyFileService implements IWorkingCopyFileService {

	declare readonly _serviceBrand: undefined;

	readonly onWillRunWorkingCopyFileOperation: Event<WorkingCopyFileEvent> = Event.None;
	readonly onDidFailWorkingCopyFileOperation: Event<WorkingCopyFileEvent> = Event.None;
	readonly onDidRunWorkingCopyFileOperation: Event<WorkingCopyFileEvent> = Event.None;

	addFileOperationParticipant(participant: IWorkingCopyFileOperationParticipant): IDisposable { return Disposable.None; }

	readonly hasSaveParticipants = false;
	addSaveParticipant(participant: IStoredFileWorkingCopySaveParticipant): IDisposable { return Disposable.None; }
	async runSaveParticipants(workingCopy: IWorkingCopy, context: IStoredFileWorkingCopySaveParticipantContext, progress: IProgress<IProgressStep>, token: CancellationToken): Promise<void> { }

	async delete(operations: IDeleteOperation[], token: CancellationToken, undoInfo?: IFileOperationUndoRedoInfo): Promise<void> { }

	registerWorkingCopyProvider(provider: (resourceOrFolder: URI) => IWorkingCopy[]): IDisposable { return Disposable.None; }

	getDirty(resource: URI): IWorkingCopy[] { return []; }

	create(operations: ICreateFileOperation[], token: CancellationToken, undoInfo?: IFileOperationUndoRedoInfo): Promise<IFileStatWithMetadata[]> { throw new Error('Method not implemented.'); }
	createFolder(operations: ICreateOperation[], token: CancellationToken, undoInfo?: IFileOperationUndoRedoInfo): Promise<IFileStatWithMetadata[]> { throw new Error('Method not implemented.'); }

	move(operations: IMoveOperation[], token: CancellationToken, undoInfo?: IFileOperationUndoRedoInfo): Promise<IFileStatWithMetadata[]> { throw new Error('Method not implemented.'); }

	copy(operations: ICopyOperation[], token: CancellationToken, undoInfo?: IFileOperationUndoRedoInfo): Promise<IFileStatWithMetadata[]> { throw new Error('Method not implemented.'); }
}

export function mock<T>(): Ctor<T> {
	// eslint-disable-next-line local/code-no-any-casts
	return function () { } as any;
}

export interface Ctor<T> {
	new(): T;
}

export class TestExtensionService extends NullExtensionService { }

export const TestProductService = { _serviceBrand: undefined, ...product };

export class TestActivityService implements IActivityService {
	_serviceBrand: undefined;
	onDidChangeActivity = Event.None;
	getViewContainerActivities(viewContainerId: string): IActivity[] {
		return [];
	}
	getActivity(id: string): IActivity[] {
		return [];
	}
	showViewContainerActivity(viewContainerId: string, badge: IActivity): IDisposable {
		return this;
	}
	showViewActivity(viewId: string, badge: IActivity): IDisposable {
		return this;
	}
	showAccountsActivity(activity: IActivity): IDisposable {
		return this;
	}
	showGlobalActivity(activity: IActivity): IDisposable {
		return this;
	}

	dispose() { }
}

export const NullFilesConfigurationService = new class implements IFilesConfigurationService {

	_serviceBrand: undefined;

	readonly onDidChangeAutoSaveConfiguration = Event.None;
	readonly onDidChangeAutoSaveDisabled = Event.None;
	readonly onDidChangeReadonly = Event.None;
	readonly onDidChangeFilesAssociation = Event.None;

	readonly isHotExitEnabled = false;
	readonly hotExitConfiguration = undefined;

	getAutoSaveConfiguration(): IAutoSaveConfiguration { throw new Error('Method not implemented.'); }
	getAutoSaveMode(): IAutoSaveMode { throw new Error('Method not implemented.'); }
	hasShortAutoSaveDelay(): boolean { throw new Error('Method not implemented.'); }
	toggleAutoSave(): Promise<void> { throw new Error('Method not implemented.'); }
	enableAutoSaveAfterShortDelay(resourceOrEditor: URI | EditorInput): IDisposable { throw new Error('Method not implemented.'); }
	disableAutoSave(resourceOrEditor: URI | EditorInput): IDisposable { throw new Error('Method not implemented.'); }
	isReadonly(resource: URI, stat?: IBaseFileStat | undefined): boolean { return false; }
	async updateReadonly(_resource: URI | URI[], _readonly: boolean | IMarkdownString | 'toggle' | 'reset'): Promise<void> { }
	preventSaveConflicts(resource: URI, language?: string | undefined): boolean { throw new Error('Method not implemented.'); }
};

export class TestWorkspaceTrustEnablementService implements IWorkspaceTrustEnablementService {
	_serviceBrand: undefined;

	constructor(private isEnabled: boolean = true) { }

	isWorkspaceTrustEnabled(): boolean {
		return this.isEnabled;
	}
}

export class TestWorkspaceTrustManagementService extends Disposable implements IWorkspaceTrustManagementService {
	_serviceBrand: undefined;
	private readonly trustedAuthorities = new Set<{ readonly scheme: string; readonly authority: string }>();

	private _onDidChangeTrust = this._register(new Emitter<boolean>());
	onDidChangeTrust = this._onDidChangeTrust.event;

	private _onDidChangeTrustedFolders = this._register(new Emitter<void>());
	onDidChangeTrustedFolders = this._onDidChangeTrustedFolders.event;

	private _onDidInitiateWorkspaceTrustRequestOnStartup = this._register(new Emitter<void>());
	onDidInitiateWorkspaceTrustRequestOnStartup = this._onDidInitiateWorkspaceTrustRequestOnStartup.event;


	constructor(
		private trusted: boolean = true,
		private trustedUris: ResourceSet = new ResourceSet()
	) {
		super();
	}

	get acceptsOutOfWorkspaceFiles(): boolean {
		throw new Error('Method not implemented.');
	}

	set acceptsOutOfWorkspaceFiles(value: boolean) {
		throw new Error('Method not implemented.');
	}

	addWorkspaceTrustTransitionParticipant(participant: IWorkspaceTrustTransitionParticipant): IDisposable {
		throw new Error('Method not implemented.');
	}

	getTrustedUris(): URI[] {
		throw new Error('Method not implemented.');
	}

	setParentFolderTrust(trusted: boolean): Promise<void> {
		throw new Error('Method not implemented.');
	}

	getUriTrustInfo(uri: URI): Promise<IWorkspaceTrustUriInfo> {
		const authorityTrusted = Array.from(this.trustedAuthorities).some(entry => entry.scheme === uri.scheme && isEqualAuthority(entry.authority, uri.authority));
		return Promise.resolve({ trusted: authorityTrusted || this.trustedUris.has(uri), uri });
	}

	registerTrustedAuthority(scheme: string, authority: string): IDisposable {
		const entry = { scheme, authority };
		this.trustedAuthorities.add(entry);
		return toDisposable(() => this.trustedAuthorities.delete(entry));
	}

	async setTrustedUris(folders: URI[]): Promise<void> {
		this.trustedUris = new ResourceSet(folders);
	}

	async setUrisTrust(uris: URI[], trusted: boolean): Promise<void> {
		throw new Error('Method not implemented.');
	}

	canSetParentFolderTrust(): boolean {
		throw new Error('Method not implemented.');
	}

	canSetWorkspaceTrust(): boolean {
		throw new Error('Method not implemented.');
	}

	isWorkspaceTrustSourceResolved(): boolean {
		return true;
	}

	async resolveWorkspaceTrust(): Promise<void> {
		throw new Error('Method not implemented.');
	}

	isWorkspaceTrusted(): boolean {
		return this.trusted;
	}

	isWorkspaceTrustForced(): boolean {
		return false;
	}

	get workspaceTrustInitialized(): Promise<void> {
		return Promise.resolve();
	}

	get workspaceResolved(): Promise<void> {
		return Promise.resolve();
	}

	async setWorkspaceTrust(trusted: boolean): Promise<void> {
		if (this.trusted !== trusted) {
			this.trusted = trusted;
			this._onDidChangeTrust.fire(this.trusted);
		}
	}
}

export class TestWorkspaceTrustRequestService extends Disposable implements IWorkspaceTrustRequestService {
	_serviceBrand: any;

	private readonly _onDidInitiateOpenFilesTrustRequest = this._register(new Emitter<void>());
	readonly onDidInitiateOpenFilesTrustRequest = this._onDidInitiateOpenFilesTrustRequest.event;

	private readonly _onDidInitiateResourcesTrustRequest = this._register(new Emitter<ResourceTrustRequestOptions>());
	readonly onDidInitiateResourcesTrustRequest = this._onDidInitiateResourcesTrustRequest.event;

	private readonly _onDidInitiateWorkspaceTrustRequest = this._register(new Emitter<WorkspaceTrustRequestOptions>());
	readonly onDidInitiateWorkspaceTrustRequest = this._onDidInitiateWorkspaceTrustRequest.event;

	private readonly _onDidInitiateWorkspaceTrustRequestOnStartup = this._register(new Emitter<void>());
	readonly onDidInitiateWorkspaceTrustRequestOnStartup = this._onDidInitiateWorkspaceTrustRequestOnStartup.event;

	constructor(private readonly _trusted: boolean) {
		super();
	}

	requestOpenUrisHandler = async (uris: URI[]) => {
		return WorkspaceTrustUriResponse.Open;
	};

	requestOpenFilesTrust(uris: URI[]): Promise<WorkspaceTrustUriResponse> {
		return this.requestOpenUrisHandler(uris);
	}

	async completeOpenFilesTrustRequest(result: WorkspaceTrustUriResponse, saveResponse: boolean): Promise<void> {
		throw new Error('Method not implemented.');
	}

	async completeResourcesTrustRequest(uri: URI, result: WorkspaceTrustUriResponse): Promise<void> {
		throw new Error('Method not implemented.');
	}

	async requestResourcesTrust(options: ResourceTrustRequestOptions): Promise<boolean | undefined> {
		return this._trusted;
	}

	cancelWorkspaceTrustRequest(): void {
		throw new Error('Method not implemented.');
	}

	async completeWorkspaceTrustRequest(trusted?: boolean): Promise<void> {
		throw new Error('Method not implemented.');
	}

	async requestWorkspaceTrust(options?: WorkspaceTrustRequestOptions): Promise<boolean> {
		return this._trusted;
	}

	requestWorkspaceTrustOnStartup(): void {
		throw new Error('Method not implemented.');
	}
}

export class TestMarkerService implements IMarkerService {

	_serviceBrand: undefined;

	onMarkerChanged = Event.None;

	getStatistics(): MarkerStatistics { throw new Error('Method not implemented.'); }
	isSourceTruncated(resource: URI): boolean { return false; }
	changeOne(owner: string, resource: URI, markers: IMarkerData[], options?: IMarkerChangeOptions): void { }
	changeAll(owner: string, data: IResourceMarker[]): void { }
	remove(owner: string, resources: URI[]): void { }
	read(filter?: { owner?: string | undefined; resource?: URI | undefined; severities?: number | undefined; take?: number | undefined } | undefined): IMarker[] { return []; }
	installResourceFilter(resource: URI, reason: string): IDisposable {
		return { dispose: () => { /* TODO: Implement cleanup logic */ } };
	}
}

export class TestFileService implements IFileService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidFilesChange = new Emitter<FileChangesEvent>();
	get onDidFilesChange(): Event<FileChangesEvent> { return this._onDidFilesChange.event; }
	fireFileChanges(event: FileChangesEvent): void { this._onDidFilesChange.fire(event); }

	private readonly _onDidRunOperation = new Emitter<FileOperationEvent>();
	get onDidRunOperation(): Event<FileOperationEvent> { return this._onDidRunOperation.event; }
	fireAfterOperation(event: FileOperationEvent): void { this._onDidRunOperation.fire(event); }

	private readonly _onDidChangeFileSystemProviderCapabilities = new Emitter<IFileSystemProviderCapabilitiesChangeEvent>();
	get onDidChangeFileSystemProviderCapabilities(): Event<IFileSystemProviderCapabilitiesChangeEvent> { return this._onDidChangeFileSystemProviderCapabilities.event; }
	fireFileSystemProviderCapabilitiesChangeEvent(event: IFileSystemProviderCapabilitiesChangeEvent): void { this._onDidChangeFileSystemProviderCapabilities.fire(event); }

	private _onWillActivateFileSystemProvider = new Emitter<IFileSystemProviderActivationEvent>();
	readonly onWillActivateFileSystemProvider = this._onWillActivateFileSystemProvider.event;
	readonly onDidWatchError = Event.None;

	protected content = 'Hello Html';
	protected lastReadFileUri!: URI;

	readonly = false;

	// Tracking functionality for tests
	readonly writeOperations: Array<{ resource: URI; content: string }> = [];
	readonly readOperations: Array<{ resource: URI }> = [];

	setContent(content: string): void { this.content = content; }
	getContent(): string { return this.content; }
	getLastReadFileUri(): URI { return this.lastReadFileUri; }

	// Clear tracking data for tests
	clearTracking(): void {
		this.writeOperations.length = 0;
		this.readOperations.length = 0;
	}

	resolve(resource: URI, _options: IResolveMetadataFileOptions): Promise<IFileStatWithMetadata>;
	resolve(resource: URI, _options?: IResolveFileOptions): Promise<IFileStat>;
	async resolve(resource: URI, _options?: IResolveFileOptions): Promise<IFileStat> {
		return createFileStat(resource, this.readonly);
	}

	stat(resource: URI): Promise<IFileStatWithPartialMetadata> {
		return this.resolve(resource, { resolveMetadata: true });
	}

	async realpath(resource: URI): Promise<URI> {
		return resource;
	}

	async resolveAll(toResolve: { resource: URI; options?: IResolveFileOptions }[]): Promise<IFileStatResult[]> {
		const stats = await Promise.all(toResolve.map(resourceAndOption => this.resolve(resourceAndOption.resource, resourceAndOption.options)));

		return stats.map(stat => ({ stat, success: true }));
	}

	readonly notExistsSet = new ResourceMap<boolean>();

	async exists(_resource: URI): Promise<boolean> { return !this.notExistsSet.has(_resource); }

	readShouldThrowError: Error | undefined = undefined;

	async readFile(resource: URI, options?: IReadFileOptions | undefined): Promise<IFileContent> {
		if (this.readShouldThrowError) {
			throw this.readShouldThrowError;
		}

		this.lastReadFileUri = resource;
		this.readOperations.push({ resource });

		return {
			...createFileStat(resource, this.readonly),
			value: VSBuffer.fromString(this.content)
		};
	}

	async readFileStream(resource: URI, options?: IReadFileStreamOptions | undefined): Promise<IFileStreamContent> {
		if (this.readShouldThrowError) {
			throw this.readShouldThrowError;
		}

		this.lastReadFileUri = resource;

		return {
			...createFileStat(resource, this.readonly),
			value: bufferToStream(VSBuffer.fromString(this.content))
		};
	}

	writeShouldThrowError: Error | undefined = undefined;

	async writeFile(resource: URI, bufferOrReadable: VSBuffer | VSBufferReadable, options?: IWriteFileOptions): Promise<IFileStatWithMetadata> {
		await timeout(0);

		if (this.writeShouldThrowError) {
			throw this.writeShouldThrowError;
		}

		let content: VSBuffer | undefined;
		if (bufferOrReadable instanceof VSBuffer) {
			content = bufferOrReadable;
		} else {
			try {
				content = readableToBuffer(bufferOrReadable);
			} catch {
				// Some preexisting tests are writing with invalid objects
			}
		}

		if (content) {
			this.writeOperations.push({ resource, content: content.toString() });
		}

		return createFileStat(resource, this.readonly);
	}

	move(_source: URI, _target: URI, _overwrite?: boolean): Promise<IFileStatWithMetadata> { return Promise.resolve(null!); }
	copy(_source: URI, _target: URI, _overwrite?: boolean): Promise<IFileStatWithMetadata> { return Promise.resolve(null!); }
	async cloneFile(_source: URI, _target: URI): Promise<void> { }
	createFile(_resource: URI, _content?: VSBuffer | VSBufferReadable, _options?: ICreateFileOptions): Promise<IFileStatWithMetadata> { return Promise.resolve(null!); }
	createFolder(_resource: URI): Promise<IFileStatWithMetadata> { return Promise.resolve(null!); }

	onDidChangeFileSystemProviderRegistrations = Event.None;

	private providers = new Map<string, IFileSystemProvider>();

	registerProvider(scheme: string, provider: IFileSystemProvider) {
		this.providers.set(scheme, provider);

		return toDisposable(() => this.providers.delete(scheme));
	}

	getProvider(scheme: string) {
		return this.providers.get(scheme);
	}

	async activateProvider(_scheme: string): Promise<void> {
		this._onWillActivateFileSystemProvider.fire({ scheme: _scheme, join: () => { } });
	}
	async canHandleResource(resource: URI): Promise<boolean> { return this.hasProvider(resource); }
	hasProvider(resource: URI): boolean { return resource.scheme === Schemas.file || this.providers.has(resource.scheme); }
	listCapabilities() {
		return [
			{ scheme: Schemas.file, capabilities: FileSystemProviderCapabilities.FileOpenReadWriteClose },
			...Iterable.map(this.providers, ([scheme, p]) => { return { scheme, capabilities: p.capabilities }; })
		];
	}
	hasCapability(resource: URI, capability: FileSystemProviderCapabilities): boolean {
		if (capability === FileSystemProviderCapabilities.PathCaseSensitive && isLinux) {
			return true;
		}

		const provider = this.getProvider(resource.scheme);

		return !!(provider && (provider.capabilities & capability));
	}

	async del(_resource: URI, _options?: { useTrash?: boolean; recursive?: boolean }): Promise<void> { }

	createWatcher(resource: URI, options: IWatchOptions): IFileSystemWatcher {
		return {
			onDidChange: Event.None,
			dispose: () => { }
		};
	}


	readonly watches: URI[] = [];
	watch(_resource: URI, options: IWatchOptionsWithCorrelation): IFileSystemWatcher;
	watch(_resource: URI): IDisposable;
	watch(_resource: URI): IDisposable {
		this.watches.push(_resource);

		return toDisposable(() => this.watches.splice(this.watches.indexOf(_resource), 1));
	}

	getWriteEncoding(_resource: URI): IResourceEncoding { return { encoding: 'utf8', hasBOM: false }; }
	dispose(): void { }

	async canCreateFile(source: URI, options?: ICreateFileOptions): Promise<Error | true> { return true; }
	async canMove(source: URI, target: URI, overwrite?: boolean | undefined): Promise<Error | true> { return true; }
	async canCopy(source: URI, target: URI, overwrite?: boolean | undefined): Promise<Error | true> { return true; }
	async canDelete(resource: URI, options?: { useTrash?: boolean | undefined; recursive?: boolean | undefined } | undefined): Promise<Error | true> { return true; }
}

/**
 * TestFileService with in-memory file storage.
 * Use this when your test needs to write files and read them back.
 */
export class InMemoryTestFileService extends TestFileService {

	private files = new ResourceMap<VSBuffer>();

	override clearTracking(): void {
		super.clearTracking();
		this.files.clear();
	}

	override async readFile(resource: URI, options?: IReadFileOptions | undefined): Promise<IFileContent> {
		if (this.readShouldThrowError) {
			throw this.readShouldThrowError;
		}

		this.lastReadFileUri = resource;
		this.readOperations.push({ resource });

		// Check if we have content in our in-memory store
		const content = this.files.get(resource);
		if (content) {
			return {
				...createFileStat(resource, this.readonly),
				value: content
			};
		}

		return {
			...createFileStat(resource, this.readonly),
			value: VSBuffer.fromString(this.content)
		};
	}

	override async writeFile(resource: URI, bufferOrReadable: VSBuffer | VSBufferReadable, options?: IWriteFileOptions): Promise<IFileStatWithMetadata> {
		await timeout(0);

		if (this.writeShouldThrowError) {
			throw this.writeShouldThrowError;
		}

		let content: VSBuffer;
		if (bufferOrReadable instanceof VSBuffer) {
			content = bufferOrReadable;
		} else {
			content = readableToBuffer(bufferOrReadable);
		}

		// Store in memory and track
		this.files.set(resource, content);
		this.writeOperations.push({ resource, content: content.toString() });

		return createFileStat(resource, this.readonly);
	}

	override async del(resource: URI, _options?: { useTrash?: boolean; recursive?: boolean }): Promise<void> {
		this.files.delete(resource);
		this.notExistsSet.set(resource, true);
	}

	override async exists(resource: URI): Promise<boolean> {
		const inMemory = this.files.has(resource);
		if (inMemory) {
			return true;
		}

		return super.exists(resource);
	}
}

export class TestChatEntitlementService implements IChatEntitlementService {

	_serviceBrand: undefined;


	readonly organisations: undefined;
	readonly isInternal: boolean = false;
	readonly sku = undefined;
	readonly copilotTrackingId = undefined;

	readonly onDidChangeQuotaExceeded = Event.None;
	readonly onDidChangeQuotaRemaining = Event.None;
	readonly onDidChangeUsageBasedBilling = Event.None;
	readonly quotas = {};

	update(token: CancellationToken): Promise<void> {
		throw new Error('Method not implemented.');
	}

	readonly onDidChangeSentiment = Event.None;
	readonly sentimentObs = observableValue({}, {});
	readonly sentiment = {};

	readonly onDidChangeEntitlement = Event.None;
	entitlement: ChatEntitlement = ChatEntitlement.Unknown;
	readonly entitlementObs = observableValue({}, ChatEntitlement.Unknown);

	readonly anonymous = false;
	onDidChangeAnonymous = Event.None;
	readonly anonymousObs = observableValue({}, false);

	acceptQuotas(): void { }
	clearQuotas(): void { }
	markAnonymousRateLimited(): void { }
	markSetupCompleted(): void { }
	setForceHidden(_hidden: boolean): void { }

	readonly clientByokEnabled = false;
	readonly hasByokModels = false;
}

export class TestLifecycleService extends Disposable implements ILifecycleService {

	declare readonly _serviceBrand: undefined;

	usePhases = false;
	_phase!: LifecyclePhase;
	get phase(): LifecyclePhase { return this._phase; }
	set phase(value: LifecyclePhase) {
		this._phase = value;
		if (value === LifecyclePhase.Starting) {
			this.whenStarted.complete();
		} else if (value === LifecyclePhase.Ready) {
			this.whenReady.complete();
		} else if (value === LifecyclePhase.Restored) {
			this.whenRestored.complete();
		} else if (value === LifecyclePhase.Eventually) {
			this.whenEventually.complete();
		}
	}

	private readonly whenStarted = new DeferredPromise<void>();
	private readonly whenReady = new DeferredPromise<void>();
	private readonly whenRestored = new DeferredPromise<void>();
	private readonly whenEventually = new DeferredPromise<void>();
	async when(phase: LifecyclePhase): Promise<void> {
		if (!this.usePhases) {
			return;
		}
		if (phase === LifecyclePhase.Starting) {
			await this.whenStarted.p;
		} else if (phase === LifecyclePhase.Ready) {
			await this.whenReady.p;
		} else if (phase === LifecyclePhase.Restored) {
			await this.whenRestored.p;
		} else if (phase === LifecyclePhase.Eventually) {
			await this.whenEventually.p;
		}
	}

	startupKind!: StartupKind;
	willShutdown = false;

	private readonly _onBeforeShutdown = this._register(new Emitter<InternalBeforeShutdownEvent>());
	get onBeforeShutdown(): Event<InternalBeforeShutdownEvent> { return this._onBeforeShutdown.event; }

	private readonly _onBeforeShutdownError = this._register(new Emitter<BeforeShutdownErrorEvent>());
	get onBeforeShutdownError(): Event<BeforeShutdownErrorEvent> { return this._onBeforeShutdownError.event; }

	private readonly _onShutdownVeto = this._register(new Emitter<void>());
	get onShutdownVeto(): Event<void> { return this._onShutdownVeto.event; }

	private readonly _onWillShutdown = this._register(new Emitter<WillShutdownEvent>());
	get onWillShutdown(): Event<WillShutdownEvent> { return this._onWillShutdown.event; }

	private readonly _onDidShutdown = this._register(new Emitter<void>());
	get onDidShutdown(): Event<void> { return this._onDidShutdown.event; }

	shutdownJoiners: Promise<void>[] = [];

	fireShutdown(reason = ShutdownReason.QUIT): void {
		this.shutdownJoiners = [];

		this._onWillShutdown.fire({
			join: p => {
				this.shutdownJoiners.push(typeof p === 'function' ? p() : p);
			},
			joiners: () => [],
			force: () => { /* No-Op in tests */ },
			token: CancellationToken.None,
			reason
		});
	}

	fireBeforeShutdown(event: InternalBeforeShutdownEvent): void { this._onBeforeShutdown.fire(event); }

	fireWillShutdown(event: WillShutdownEvent): void { this._onWillShutdown.fire(event); }

async shutdown(): Promise<void> {
		this.fireShutdown();
	}
}

interface ITestMutableProjectState {
	meta: IAdeProjectMeta;
	sortOrder: number;
	hosts: IAdeProjectHostEntry[];
	agents: Map<string, IAdeAgentNode>;
	deletedAgents: IAdeDeletedAgentArchive[];
	departments: Map<string, IAdeDepartment>;
	whiteboards: Map<string, IAdeWhiteboard>;
	boardGrants: IAdeBoardGrant[];
	tickets: Map<string, IAdeTicketSummaryCard>;
	ticketTasks: Map<string, IAdeUiTicketTaskRecord[]>;
	taskDetails: Map<string, string>;
	edgeTransfers: IAdeEdgeTransferRecord[];
	edgeLatestTransferAt: Record<string, number>;
	wbItems: Map<string, IAdeBoardItemPublicSummary[]>;
	wbItemDetails: Map<string, string>;
	wbNotes: Map<string, Array<IAdeBoardNotePublicItem & { to_id: string; is_read: boolean; detail?: string }>>;
}

interface ITestMutableOutboxItem extends IAdeOutboxDeliveryItem {
	state: 'pending' | 'in_flight' | 'blocked_cli' | 'dead_letter';
	claimedByWindowId: number | null;
	leasedUntil: number | null;
	attempts: number;
	nextRetryAt: number;
	lastError?: string;
}

function normalizeTestFolderUri(rawUri: string): URI {
	const parsed = removeTrailingPathSeparator(URI.parse(rawUri));
	if (parsed.scheme === AEXUS_SSH_SCHEME && parsed.authority) {
		return parsed.with({ authority: parsed.authority.toLowerCase() });
	}
	return parsed;
}

function normalizeShortEngine(raw: string): string {
	const low = raw.trim().toLowerCase();
	if (low === 'claude-code' || low === 'aexus-claude') {
		return 'claude';
	}
	if (low === 'agy' || low === 'aexus-antigravity') {
		return 'antigravity';
	}
	if (low === 'deepseek' || low === 'aexus-dsh') {
		return 'dsh';
	}
	return low.startsWith('aexus-') ? low.slice('aexus-'.length) : low;
}

export class TestAdeControlCenterService extends Disposable implements IAdeControlCenterService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeCatalog = this._register(new Emitter<void>());
	readonly onDidChangeCatalog: Event<void> = this._onDidChangeCatalog.event;

	private readonly _onDidChangeProject = this._register(new Emitter<{ readonly projectId: string }>());
	readonly onDidChangeProject: Event<{ readonly projectId: string }> = this._onDidChangeProject.event;

	private readonly _onDidTransferTicket = this._register(new Emitter<IAdeTicketTransferAnimationEvent>());
	readonly onDidTransferTicket: Event<IAdeTicketTransferAnimationEvent> = this._onDidTransferTicket.event;

	private readonly _onDidEnqueueOutbox = this._register(new Emitter<{ readonly projectId: string; readonly targetAgentId: string }>());
	readonly onDidEnqueueOutbox: Event<{ readonly projectId: string; readonly targetAgentId: string }> = this._onDidEnqueueOutbox.event;

	private readonly _onDidCancelOutboxTickets = this._register(new Emitter<{ readonly projectId: string; readonly ticketIds: readonly string[] }>());
	readonly onDidCancelOutboxTickets: Event<{ readonly projectId: string; readonly ticketIds: readonly string[] }> = this._onDidCancelOutboxTickets.event;

	private readonly _onDidDisposeAgentRuntime = this._register(new Emitter<IAdeAgentRuntimeDisposeEvent>());
	readonly onDidDisposeAgentRuntime: Event<IAdeAgentRuntimeDisposeEvent> = this._onDidDisposeAgentRuntime.event;

	private seq = 0;
	private readonly folders = new Map<string, IAdeWorkspaceFolder>();
	private readonly projects = new Map<string, ITestMutableProjectState>();
	private readonly outbox = new Map<string, ITestMutableOutboxItem>();

	private nextId(prefix: string): string {
		return `${prefix}_${++this.seq}`;
	}

	private buildSessionResource(engine: string, projectId: string, agentId: string): string {
		return `aexus-${normalizeShortEngine(engine)}:/ade-${projectId}-${agentId}`;
	}

	private findFolderByUri(rawUri: string): IAdeWorkspaceFolder | undefined {
		const norm = normalizeTestFolderUri(rawUri).toString();
		for (const folder of this.folders.values()) {
			if (normalizeTestFolderUri(folder.folder_uri).toString() === norm) {
				return folder;
			}
		}
		return undefined;
	}

	async getCatalogSnapshot(): Promise<IAdeCatalogSnapshot> {
		const folders = [...this.folders.values()].sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);
		const projects: IAdeProjectSummaryItem[] = [...this.projects.values()]
			.sort((a, b) => a.sortOrder - b.sortOrder || a.meta.created_at - b.meta.created_at)
			.map(p => ({
				project_id: p.meta.project_id,
				folder_id: p.meta.folder_id,
				folder_uri: p.meta.folder_uri,
				name: p.meta.name,
				sort_order: p.sortOrder,
				created_at: p.meta.created_at,
				updated_at: p.meta.updated_at,
			}));
		return { folders, projects };
	}

	async registerWorkspaceFolder(input: { readonly folderUri: string; readonly displayName?: string; readonly host?: string }): Promise<IAdeWorkspaceFolder> {
		const normUri = normalizeTestFolderUri(input.folderUri);
		const existing = this.findFolderByUri(input.folderUri);
		const now = Date.now();
		if (existing) {
			if (input.displayName && input.displayName.trim() && input.displayName.trim() !== existing.display_name) {
				const updated: IAdeWorkspaceFolder = {
					...existing,
					display_name: input.displayName.trim(),
					updated_at: now,
				};
				this.folders.set(existing.folder_id, updated);
				this._onDidChangeCatalog.fire();
				return updated;
			}
			return existing;
		}
		const folderId = this.nextId('fld');
		const inferredHost = input.host ?? (normUri.scheme === AEXUS_SSH_SCHEME ? normUri.authority : 'local');
		const displayName = input.displayName?.trim() || basename(normUri) || normUri.authority || 'workspace';
		const created: IAdeWorkspaceFolder = {
			folder_id: folderId,
			folder_uri: normUri.toString(),
			display_name: displayName,
			host: inferredHost,
			sort_order: (this.folders.size + 1) * 10,
			collapsed: false,
			created_at: now,
			updated_at: now,
		};
		this.folders.set(folderId, created);
		this._onDidChangeCatalog.fire();
		return created;
	}

	async removeWorkspaceFolder(folderUri: string): Promise<void> {
		const existing = this.findFolderByUri(folderUri);
		if (!existing) {
			return;
		}
		for (const [pid, proj] of [...this.projects.entries()]) {
			if (proj.meta.folder_id === existing.folder_id) {
				for (const ag of proj.agents.values()) {
					this._onDidDisposeAgentRuntime.fire({
						projectId: pid,
						agentId: ag.agent_id,
						host: ag.host,
						engine: ag.engine,
						sessionResource: ag.session_resource ?? this.buildSessionResource(ag.engine, pid, ag.agent_id),
					});
				}
				this.projects.delete(pid);
			}
		}
		this.folders.delete(existing.folder_id);
		this._onDidChangeCatalog.fire();
	}

	async reorderWorkspaceFolder(sourceUri: string, targetUri: string | undefined, after: boolean): Promise<void> {
		const src = this.findFolderByUri(sourceUri);
		if (!src) {
			return;
		}
		const ordered = [...this.folders.values()].sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);
		const withoutSrc = ordered.filter(f => f.folder_id !== src.folder_id);
		if (!targetUri) {
			if (after) {
				withoutSrc.push(src);
			} else {
				withoutSrc.unshift(src);
			}
		} else {
			const tgt = this.findFolderByUri(targetUri);
			const idx = tgt ? withoutSrc.findIndex(f => f.folder_id === tgt.folder_id) : -1;
			if (idx === -1) {
				withoutSrc.push(src);
			} else {
				withoutSrc.splice(after ? idx + 1 : idx, 0, src);
			}
		}
		const now = Date.now();
		withoutSrc.forEach((f, index) => {
			this.folders.set(f.folder_id, { ...f, sort_order: (index + 1) * 10, updated_at: now });
		});
		this._onDidChangeCatalog.fire();
	}

	async setWorkspaceFolderCollapsed(folderUri: string, collapsed: boolean): Promise<void> {
		const existing = this.findFolderByUri(folderUri);
		if (!existing || existing.collapsed === collapsed) {
			return;
		}
		this.folders.set(existing.folder_id, { ...existing, collapsed, updated_at: Date.now() });
		this._onDidChangeCatalog.fire();
	}

	async migrateCloudHostAlias(oldAlias: string, newAlias: string): Promise<number> {
		const oldLower = oldAlias.trim().toLowerCase();
		const nextLower = newAlias.trim().toLowerCase();
		if (!oldLower || !nextLower || oldLower === nextLower) {
			return 0;
		}
		let count = 0;
		const now = Date.now();
		for (const [fid, folder] of [...this.folders.entries()]) {
			const u = URI.parse(folder.folder_uri);
			if (u.scheme === AEXUS_SSH_SCHEME && u.authority.toLowerCase() === oldLower) {
				const migratedUri = u.with({ authority: nextLower }).toString();
				this.folders.set(fid, {
					...folder,
					folder_uri: migratedUri,
					host: folder.host.toLowerCase() === oldLower ? nextLower : folder.host,
					updated_at: now,
				});
				for (const proj of this.projects.values()) {
					if (proj.meta.folder_id === fid) {
						proj.meta = { ...proj.meta, folder_uri: migratedUri, updated_at: now };
					}
				}
				count++;
			}
		}
		if (count > 0) {
			this._onDidChangeCatalog.fire();
		}
		return count;
	}

	async createProject(input: { readonly folderUri: string; readonly name?: string }): Promise<IAdeProjectSnapshot> {
		const folder = await this.registerWorkspaceFolder({ folderUri: input.folderUri });
		const siblings = [...this.projects.values()].filter(p => p.meta.folder_id === folder.folder_id);
		const now = Date.now();
		const projectId = this.nextId('proj');
		const defaultName = siblings.length === 0 ? `${folder.display_name} #1` : `${folder.display_name} #${siblings.length + 1}`;
		const projectName = input.name?.trim() || defaultName;
		const meta: IAdeProjectMeta = {
			project_id: projectId,
			folder_id: folder.folder_id,
			folder_uri: folder.folder_uri,
			name: projectName,
			cross_host_ticket_storage: 'local',
			ticket_migration_epoch: 0,
			ticket_migration_state: 'idle',
			layout_direction: 'TD',
			created_at: now,
			updated_at: now,
		};
		const state: ITestMutableProjectState = {
			meta,
			sortOrder: (siblings.length + 1) * 10,
			hosts: [],
			agents: new Map(),
			deletedAgents: [],
			departments: new Map(),
			whiteboards: new Map(),
			boardGrants: [],
			tickets: new Map(),
			ticketTasks: new Map(),
			taskDetails: new Map(),
			edgeTransfers: [],
			edgeLatestTransferAt: {},
			wbItems: new Map(),
			wbItemDetails: new Map(),
			wbNotes: new Map(),
		};
		this.projects.set(projectId, state);
		this._onDidChangeCatalog.fire();
		this._onDidChangeProject.fire({ projectId });
		return (await this.getProjectSnapshot(projectId))!;
	}

	async renameProject(projectId: string, name: string): Promise<void> {
		const proj = this.projects.get(projectId);
		const trimmed = name.trim();
		if (!proj || !trimmed) {
			throw new AdeError('ERR_INVALID_ARGS', 'Project not found or empty name');
		}
		proj.meta = { ...proj.meta, name: trimmed, updated_at: Date.now() };
		this._onDidChangeCatalog.fire();
		this._onDidChangeProject.fire({ projectId });
	}

	async reorderProject(projectId: string, targetProjectId: string | undefined, after: boolean): Promise<void> {
		const src = this.projects.get(projectId);
		if (!src) {
			return;
		}
		if (targetProjectId) {
			const tgt = this.projects.get(targetProjectId);
			if (!tgt || tgt.meta.folder_id !== src.meta.folder_id) {
				return;
			}
		}
		const siblings = [...this.projects.values()]
			.filter(p => p.meta.folder_id === src.meta.folder_id)
			.sort((a, b) => a.sortOrder - b.sortOrder || a.meta.created_at - b.meta.created_at);
		const withoutSrc = siblings.filter(p => p.meta.project_id !== projectId);
		if (!targetProjectId) {
			if (after) {
				withoutSrc.push(src);
			} else {
				withoutSrc.unshift(src);
			}
		} else {
			const idx = withoutSrc.findIndex(p => p.meta.project_id === targetProjectId);
			if (idx === -1) {
				withoutSrc.push(src);
			} else {
				withoutSrc.splice(after ? idx + 1 : idx, 0, src);
			}
		}
		const now = Date.now();
		withoutSrc.forEach((p, index) => {
			p.sortOrder = (index + 1) * 10;
			p.meta = { ...p.meta, updated_at: now };
		});
		this._onDidChangeCatalog.fire();
	}

	async deleteProject(projectId: string): Promise<void> {
		const proj = this.projects.get(projectId);
		if (!proj) {
			return;
		}
		for (const ag of proj.agents.values()) {
			this._onDidDisposeAgentRuntime.fire({
				projectId,
				agentId: ag.agent_id,
				host: ag.host,
				engine: ag.engine,
				sessionResource: ag.session_resource ?? this.buildSessionResource(ag.engine, projectId, ag.agent_id),
			});
		}
		for (const [did, item] of [...this.outbox.entries()]) {
			if (item.projectId === projectId) {
				this.outbox.delete(did);
			}
		}
		this.projects.delete(projectId);
		this._onDidChangeCatalog.fire();
	}

	async getProjectSnapshot(projectId: string): Promise<IAdeProjectSnapshot | undefined> {
		const proj = this.projects.get(projectId);
		if (!proj) {
			return undefined;
		}
		return {
			meta: proj.meta,
			hosts: [...proj.hosts],
			agents: [...proj.agents.values()],
			deleted_agents: [...proj.deletedAgents],
			departments: [...proj.departments.values()],
			whiteboards: [...proj.whiteboards.values()],
			board_grants: [...proj.boardGrants],
			tickets: [...proj.tickets.values()],
			edge_latest_transfer_at: { ...proj.edgeLatestTransferAt },
		};
	}

	seedTestProjectSnapshot(snapshot: IAdeProjectSnapshot): void {
		const existing = this.projects.get(snapshot.meta.project_id);
		const sortOrder = existing?.sortOrder ?? (this.projects.size + 1) * 10;
		this.projects.set(snapshot.meta.project_id, {
			meta: { ...snapshot.meta },
			sortOrder,
			hosts: [...snapshot.hosts],
			agents: new Map(snapshot.agents.map(a => [a.agent_id, {
				...a,
				session_resource: a.session_resource ?? this.buildSessionResource(a.engine, snapshot.meta.project_id, a.agent_id),
			}])),
			deletedAgents: [...snapshot.deleted_agents],
			departments: new Map(snapshot.departments.map(d => [d.dept_id, d])),
			whiteboards: new Map(snapshot.whiteboards.map(w => [w.board_id, w])),
			boardGrants: [...snapshot.board_grants],
			tickets: new Map(snapshot.tickets.map(t => [t.ticket_id, t])),
			ticketTasks: existing?.ticketTasks ?? new Map(),
			taskDetails: existing?.taskDetails ?? new Map(),
			edgeTransfers: existing?.edgeTransfers ?? [],
			edgeLatestTransferAt: { ...snapshot.edge_latest_transfer_at },
			wbItems: existing?.wbItems ?? new Map(),
			wbItemDetails: existing?.wbItemDetails ?? new Map(),
			wbNotes: existing?.wbNotes ?? new Map(),
		});
	}

	async listAllBoundSessionResources(): Promise<readonly string[]> {
		const out: string[] = [];
		for (const [pid, proj] of this.projects.entries()) {
			for (const ag of proj.agents.values()) {
				out.push(ag.session_resource ?? this.buildSessionResource(ag.engine, pid, ag.agent_id));
			}
		}
		return out;
	}

	async probeEngines(_host: string): Promise<readonly string[]> {
		return ['claude', 'codex', 'dsh'];
	}

	async probeModels(_host: string, engine: string): Promise<{ readonly models: readonly string[]; readonly efforts: readonly string[] }> {
		const eng = normalizeShortEngine(engine);
		return {
			models: eng === 'codex' ? ['gpt-5.2-codex', 'o4-mini'] : ['claude-sonnet-4-5'],
			efforts: ['low', 'medium', 'high'],
		};
	}

	async uiCreateAgent(input: IAdeUiCreateAgentInput): Promise<IAdeAgentNode> {
		const proj = this.projects.get(input.projectId);
		if (!proj) {
			throw new AdeError('ERR_INVALID_ARGS', 'Project not found');
		}
		const isTopRole = input.parentId === null;
		if (isTopRole && [...proj.agents.values()].some(a => a.is_top_role)) {
			throw new AdeError('ERR_FORBIDDEN_HIERARCHY', 'Project already has a top L1 leader');
		}
		const now = Date.now();
		const agentId = this.nextId('agent');
		const engine = normalizeShortEngine(input.engine);
		const node: IAdeAgentNode = {
			agent_id: agentId,
			project_id: input.projectId,
			level: isTopRole ? 1 : Math.max(2, input.level),
			is_top_role: isTopRole,
			parent_id: input.parentId,
			name: input.name.trim() || agentId,
			role_summary: input.roleSummary.trim(),
			host: input.host || 'local',
			engine,
			model: input.model || 'default',
			effort: input.effort || 'medium',
			session_phase: 'unstarted',
			session_started: false,
			excluded_dept_ids: [],
			session_resource: this.buildSessionResource(engine, input.projectId, agentId),
			last_read_doc_rev: 0,
			token_gen: 1,
			...(input.canvasX !== undefined ? { canvas_x: input.canvasX } : {}),
			...(input.canvasY !== undefined ? { canvas_y: input.canvasY } : {}),
			...(input.colorToken ? { color_token: input.colorToken } : {}),
			created_at: now,
			updated_at: now,
		};
		proj.agents.set(agentId, node);
		if (isTopRole) {
			for (const [bid, wb] of proj.whiteboards.entries()) {
				if (wb.owner_id === null) {
					proj.whiteboards.set(bid, { ...wb, owner_id: agentId, updated_at: now });
				}
			}
		}
		this._onDidChangeProject.fire({ projectId: input.projectId });
		return node;
	}

	async uiEditAgent(input: IAdeUiEditAgentInput): Promise<IAdeAgentNode> {
		const proj = this.projects.get(input.projectId);
		const existing = proj?.agents.get(input.agentId);
		if (!proj || !existing) {
			throw new AdeError('ERR_AGENT_NOT_FOUND', 'Agent not found');
		}
		const nextEngine = input.engine ? normalizeShortEngine(input.engine) : existing.engine;
		const engineChanged = Boolean(input.engine && nextEngine !== existing.engine);
		if (engineChanged && existing.session_started) {
			throw new AdeError('ERR_ENGINE_LOCKED', 'Session has already started; engine is locked');
		}
		const updated: IAdeAgentNode = {
			...existing,
			...(input.name !== undefined ? { name: input.name.trim() || existing.name } : {}),
			...(input.roleSummary !== undefined ? { role_summary: input.roleSummary } : {}),
			engine: nextEngine,
			session_resource: this.buildSessionResource(nextEngine, input.projectId, existing.agent_id),
			...(input.model !== undefined ? { model: input.model } : {}),
			...(input.effort !== undefined ? { effort: input.effort } : {}),
			...(input.colorToken !== undefined ? { color_token: input.colorToken } : {}),
			updated_at: Date.now(),
		};
		proj.agents.set(existing.agent_id, updated);
		this._onDidChangeProject.fire({ projectId: input.projectId });
		if (engineChanged) {
			await this.requeueBlockedCliDeliveries({ projectId: input.projectId, agentId: existing.agent_id });
		}
		return updated;
	}

	async uiMoveAgent(projectId: string, agentId: string, newParentId: string): Promise<IAdeAgentNode> {
		const proj = this.projects.get(projectId);
		const ag = proj?.agents.get(agentId);
		const parent = proj?.agents.get(newParentId);
		if (!proj || !ag || !parent) {
			throw new AdeError('ERR_AGENT_NOT_FOUND', 'Agent or parent not found');
		}
		if (ag.is_top_role || parent.level >= ag.level) {
			throw new AdeError('ERR_FORBIDDEN_HIERARCHY', 'Invalid hierarchy move');
		}
		const updated: IAdeAgentNode = { ...ag, parent_id: newParentId, updated_at: Date.now() };
		proj.agents.set(agentId, updated);
		this._onDidChangeProject.fire({ projectId });
		return updated;
	}

	async uiDeleteAgent(projectId: string, agentId: string): Promise<{ readonly frozenTicketIds: readonly string[] }> {
		const proj = this.projects.get(projectId);
		const ag = proj?.agents.get(agentId);
		if (!proj || !ag) {
			throw new AdeError('ERR_AGENT_NOT_FOUND', 'Agent not found');
		}
		if ([...proj.agents.values()].some(c => c.parent_id === agentId)) {
			throw new AdeError('ERR_HAS_SUBORDINATES', 'Agent still has direct subordinates');
		}
		if ([...proj.departments.values()].some(d => d.root_agent_id === agentId)) {
			throw new AdeError('ERR_IS_DEPT_ROOT', 'Agent is root of an active department');
		}
		const now = Date.now();
		proj.deletedAgents.push({
			agent_id: ag.agent_id,
			project_id: projectId,
			name: ag.name,
			level: ag.level,
			role_summary: ag.role_summary,
			host: ag.host,
			deleted_at: now,
		});
		for (const [bid, wb] of proj.whiteboards.entries()) {
			if (wb.owner_id === agentId) {
				proj.whiteboards.set(bid, { ...wb, owner_id: ag.parent_id, updated_at: now });
			}
		}
		const frozenTicketIds: string[] = [];
		for (const [tid, tk] of proj.tickets.entries()) {
			if (tk.status === 'active' && (tk.creator_id === agentId || tk.peer_id === agentId)) {
				proj.tickets.set(tid, { ...tk, status: 'frozen_orphan', holder_id: null, updated_at: now });
				frozenTicketIds.push(tid);
			}
		}
		proj.agents.delete(agentId);
		if (frozenTicketIds.length > 0) {
			this._onDidCancelOutboxTickets.fire({ projectId, ticketIds: frozenTicketIds });
		}
		this._onDidDisposeAgentRuntime.fire({
			projectId,
			agentId,
			host: ag.host,
			engine: ag.engine,
			sessionResource: ag.session_resource ?? this.buildSessionResource(ag.engine, projectId, agentId),
		});
		this._onDidChangeProject.fire({ projectId });
		return { frozenTicketIds };
	}

	async uiUpdateCanvasLayout(projectId: string, patch: {
		readonly layoutDirection?: AdeLayoutDirection;
		readonly nodePositions?: Readonly<Record<string, { readonly x: number; readonly y: number; readonly color?: string }>>;
	}): Promise<void> {
		const proj = this.projects.get(projectId);
		if (!proj) {
			return;
		}
		const now = Date.now();
		if (patch.layoutDirection) {
			proj.meta = { ...proj.meta, layout_direction: patch.layoutDirection, updated_at: now };
		}
		if (patch.nodePositions) {
			for (const [nid, pos] of Object.entries(patch.nodePositions)) {
				const ag = proj.agents.get(nid);
				if (ag) {
					proj.agents.set(nid, { ...ag, canvas_x: pos.x, canvas_y: pos.y, ...(pos.color ? { color_token: pos.color } : {}), updated_at: now });
				}
				const wb = proj.whiteboards.get(nid);
				if (wb) {
					proj.whiteboards.set(nid, { ...wb, canvas_x: pos.x, canvas_y: pos.y, updated_at: now });
				}
			}
		}
		this._onDidChangeProject.fire({ projectId });
	}

	async uiCreateDepartment(projectId: string, rootAgentId: string, name: string): Promise<IAdeDepartment> {
		const proj = this.projects.get(projectId);
		if (!proj || !proj.agents.has(rootAgentId)) {
			throw new AdeError('ERR_AGENT_NOT_FOUND', 'Root agent not found');
		}
		if ([...proj.departments.values()].some(d => d.root_agent_id === rootAgentId)) {
			throw new AdeError('ERR_IS_DEPT_ROOT', 'Agent is already root of a department');
		}
		const now = Date.now();
		const dept: IAdeDepartment = {
			dept_id: this.nextId('dept'),
			project_id: projectId,
			name: name.trim(),
			root_agent_id: rootAgentId,
			parent_dept_id: null,
			board_permissions: {},
			created_by: rootAgentId,
			created_at: now,
			updated_at: now,
		};
		proj.departments.set(dept.dept_id, dept);
		this._onDidChangeProject.fire({ projectId });
		return dept;
	}

	async uiEditDepartment(projectId: string, deptId: string, patch: { readonly name?: string; readonly boardId?: string; readonly perm?: AdeBoardPermission }): Promise<IAdeDepartment> {
		const proj = this.projects.get(projectId);
		const dept = proj?.departments.get(deptId);
		if (!proj || !dept) {
			throw new AdeError('ERR_INVALID_ARGS', 'Department not found');
		}
		const nextPerms = { ...dept.board_permissions };
		if (patch.boardId && patch.perm) {
			nextPerms[patch.boardId] = patch.perm;
		}
		const updated: IAdeDepartment = {
			...dept,
			...(patch.name ? { name: patch.name.trim() } : {}),
			board_permissions: nextPerms,
			updated_at: Date.now(),
		};
		proj.departments.set(deptId, updated);
		this._onDidChangeProject.fire({ projectId });
		return updated;
	}

	async uiDeleteDepartment(projectId: string, deptId: string): Promise<void> {
		const proj = this.projects.get(projectId);
		if (!proj) {
			return;
		}
		proj.departments.delete(deptId);
		for (const [bid, wb] of proj.whiteboards.entries()) {
			if (wb.dept_id === deptId) {
				proj.whiteboards.set(bid, { ...wb, dept_id: null, updated_at: Date.now() });
			}
		}
		this._onDidChangeProject.fire({ projectId });
	}

	async uiSetDepartmentMember(projectId: string, deptId: string, agentId: string, action: 'in' | 'out'): Promise<void> {
		const proj = this.projects.get(projectId);
		const ag = proj?.agents.get(agentId);
		if (!proj || !ag) {
			return;
		}
		const set = new Set(ag.excluded_dept_ids);
		if (action === 'out') {
			set.add(deptId);
		} else {
			set.delete(deptId);
		}
		proj.agents.set(agentId, { ...ag, excluded_dept_ids: [...set], updated_at: Date.now() });
		this._onDidChangeProject.fire({ projectId });
	}

	async uiConfigureProjectTicketStorage(projectId: string, targetHost: string): Promise<void> {
		const proj = this.projects.get(projectId);
		if (!proj) {
			throw new AdeError('ERR_INVALID_ARGS', 'Project not found');
		}
		proj.meta = {
			...proj.meta,
			cross_host_ticket_storage: targetHost.trim() || 'local',
			ticket_migration_epoch: proj.meta.ticket_migration_epoch + 1,
			ticket_migration_state: 'completed',
			updated_at: Date.now(),
		};
		this._onDidChangeProject.fire({ projectId });
	}

	async uiCreateWhiteboard(input: {
		readonly projectId: string;
		readonly name: string;
		readonly ownerId?: string | null;
		readonly deptId?: string | null;
		readonly storageHost?: string;
		readonly tags?: readonly string[];
		readonly canvasX?: number;
		readonly canvasY?: number;
	}): Promise<IAdeWhiteboard> {
		const proj = this.projects.get(input.projectId);
		if (!proj) {
			throw new AdeError('ERR_INVALID_ARGS', 'Project not found');
		}
		const now = Date.now();
		const board: IAdeWhiteboard = {
			board_id: this.nextId('wb'),
			project_id: input.projectId,
			name: input.name.trim(),
			owner_id: input.ownerId ?? ([...proj.agents.values()].find(a => a.is_top_role)?.agent_id ?? null),
			dept_id: input.deptId ?? null,
			storage_host: input.storageHost || 'local',
			tag_categories: input.tags ? [...input.tags] : [],
			migration_epoch: 0,
			migration_state: 'idle',
			...(input.canvasX !== undefined ? { canvas_x: input.canvasX } : {}),
			...(input.canvasY !== undefined ? { canvas_y: input.canvasY } : {}),
			created_at: now,
			updated_at: now,
		};
		proj.whiteboards.set(board.board_id, board);
		this._onDidChangeProject.fire({ projectId: input.projectId });
		return board;
	}

	async uiConfigureWhiteboard(input: {
		readonly projectId: string;
		readonly boardId: string;
		readonly name?: string;
		readonly targetStorageHost?: string;
		readonly addTags?: readonly string[];
		readonly removeTags?: readonly string[];
		readonly grants?: readonly { readonly agentId: string; readonly perm: AdeBoardPermission | 'none' }[];
	}): Promise<IAdeWhiteboard> {
		const proj = this.projects.get(input.projectId);
		const wb = proj?.whiteboards.get(input.boardId);
		if (!proj || !wb) {
			throw new AdeError('ERR_BOARD_NOT_FOUND', 'Board not found');
		}
		const tagSet = new Set(wb.tag_categories);
		for (const t of input.addTags ?? []) { tagSet.add(t); }
		for (const t of input.removeTags ?? []) { tagSet.delete(t); }
		const updated: IAdeWhiteboard = {
			...wb,
			...(input.name ? { name: input.name.trim() } : {}),
			...(input.targetStorageHost ? { storage_host: input.targetStorageHost, migration_epoch: wb.migration_epoch + 1, migration_state: 'completed' } : {}),
			tag_categories: [...tagSet],
			updated_at: Date.now(),
		};
		proj.whiteboards.set(input.boardId, updated);
		this._onDidChangeProject.fire({ projectId: input.projectId });
		return updated;
	}

	async uiDeleteWhiteboard(projectId: string, boardId: string): Promise<void> {
		const proj = this.projects.get(projectId);
		if (!proj) {
			return;
		}
		proj.whiteboards.delete(boardId);
		this._onDidChangeProject.fire({ projectId });
	}

	async uiManageWhiteboardItem(_input: {
		readonly projectId: string;
		readonly boardId: string;
		readonly itemId: string;
		readonly pin?: boolean;
		readonly stars?: 1 | 2 | 3 | 4 | 5;
		readonly tags?: readonly string[];
		readonly deleteItem?: boolean;
	}): Promise<void> { }

	async uiInspectWhiteboard(projectId: string, boardId: string, _filter?: IAdeWbItemsFilter): Promise<IAdeUiWhiteboardInspection> {
		const proj = this.projects.get(projectId);
		const wb = proj?.whiteboards.get(boardId);
		if (!proj || !wb) {
			throw new AdeError('ERR_BOARD_NOT_FOUND', 'Board not found');
		}
		return {
			board: wb,
			members: [],
			items: proj.wbItems.get(boardId) ?? [],
			notes: proj.wbNotes.get(boardId) ?? [],
		};
	}

	async uiReadWhiteboardItemDetail(projectId: string, boardId: string, itemId: string): Promise<string> {
		const detail = this.projects.get(projectId)?.wbItemDetails.get(`${boardId}:${itemId}`);
		if (detail === undefined) {
			throw new AdeError('ERR_DETAIL_NOT_FOUND', 'Detail not found');
		}
		return detail;
	}

	async uiDownloadWhiteboardFile(_projectId: string, _boardId: string, _itemId: string, destPath: string): Promise<string> {
		return destPath;
	}

	async uiReadWhiteboardNoteDetail(projectId: string, boardId: string, noteId: string): Promise<string> {
		const note = (this.projects.get(projectId)?.wbNotes.get(boardId) ?? []).find(n => n.note_id === noteId);
		if (!note?.detail) {
			throw new AdeError('ERR_DETAIL_NOT_FOUND', 'Note detail not found');
		}
		return note.detail;
	}

	async getEdgeLatestTransferTime(projectId: string, edgePairKey: string): Promise<number | null> {
		return this.projects.get(projectId)?.edgeLatestTransferAt[edgePairKey] ?? null;
	}

	async listEdgeTicketTransfers(projectId: string, edgePairKey: string): Promise<readonly IAdeEdgeTransferRecord[]> {
		return (this.projects.get(projectId)?.edgeTransfers ?? []).filter(t => t.edge_pair_key === edgePairKey);
	}

	async inspectTicketFullDetailForUi(_projectId: string, _ticketId: string): Promise<IAdeUiTicketFullInspection | undefined> {
		return undefined;
	}

	async readTicketTaskDetailForUi(projectId: string, ticketId: string, taskId: string): Promise<string> {
		const detail = this.projects.get(projectId)?.taskDetails.get(`${ticketId}:${taskId}`);
		if (detail === undefined) {
			throw new AdeError('ERR_DETAIL_NOT_FOUND', 'Task detail not found');
		}
		return detail;
	}

	async issueAgentLaunchBundle(projectId: string, agentId: string): Promise<IAdeAgentLaunchBundle> {
		const proj = this.projects.get(projectId);
		const ag = proj?.agents.get(agentId);
		if (!proj || !ag) {
			throw new AdeError('ERR_AGENT_NOT_FOUND', 'Agent not found');
		}
		const folderUri = URI.parse(proj.meta.folder_uri);
		const isCloudAgent = ag.host !== 'local';
		const matchedHost = isCloudAgent
			? proj.hosts.find(h => h.ip === ag.host || h.ssh_alias.toLowerCase() === ag.host.toLowerCase() || h.host_id === ag.host)
			: undefined;
		const sshAlias = isCloudAgent ? (matchedHost?.ssh_alias ?? (folderUri.scheme === AEXUS_SSH_SCHEME ? folderUri.authority : ag.host)) : undefined;
		const workspaceCwd = !isCloudAgent
			? (folderUri.scheme === Schemas.file ? folderUri.fsPath : `/tmp/ade-workspaces/${projectId}/${agentId}`)
			: (folderUri.scheme === AEXUS_SSH_SCHEME ? (folderUri.path || '/workspace') : `${matchedHost?.remote_home ?? '/home/ubuntu'}/.ade_store/_workspaces/${projectId}/${agentId}`);
		return {
			projectId,
			agentId,
			level: ag.level,
			name: ag.name,
			host: ag.host,
			...(sshAlias ? { sshAlias } : {}),
			engine: ag.engine,
			model: ag.model,
			effort: ag.effort,
			workspaceCwd,
			sessionResource: ag.session_resource ?? this.buildSessionResource(ag.engine, projectId, agentId),
			...(ag.native_session_id ? { nativeSessionId: ag.native_session_id } : {}),
			agentToken: `ades1.${projectId}_${agentId}_g${ag.token_gen}.testsecret`,
			controlSocketPath: '/tmp/test-ade-control.sock',
			...(isCloudAgent ? {
				remoteBridgeFile: '/home/ubuntu/.ade_store/_run/bridge-test.json',
				remoteControlEndpoint: 'tcp:127.0.0.1:49152',
				remoteBinDir: '/home/ubuntu/.ade_store/_bin',
			} : {}),
		};
	}

	async resolveAgentBySessionResource(sessionResource: string): Promise<{ readonly projectId: string; readonly agent: IAdeAgentNode } | undefined> {
		const target = sessionResource.trim();
		for (const [pid, proj] of this.projects.entries()) {
			for (const ag of proj.agents.values()) {
				const res = ag.session_resource ?? this.buildSessionResource(ag.engine, pid, ag.agent_id);
				if (res === target) {
					return { projectId: pid, agent: ag };
				}
			}
		}
		return undefined;
	}

	async markAgentSessionStarting(projectId: string, agentId: string, sessionResource?: string): Promise<void> {
		const proj = this.projects.get(projectId);
		const ag = proj?.agents.get(agentId);
		if (!proj || !ag) {
			return;
		}
		proj.agents.set(agentId, {
			...ag,
			session_phase: ag.session_phase === 'started' ? 'started' : 'starting',
			session_started: true,
			...(sessionResource ? { session_resource: sessionResource } : {}),
			updated_at: Date.now(),
		});
		this._onDidChangeProject.fire({ projectId });
	}

	async markAgentSessionStarted(projectId: string, agentId: string, info: { readonly sessionResource?: string; readonly nativeSessionId?: string }): Promise<void> {
		const proj = this.projects.get(projectId);
		const ag = proj?.agents.get(agentId);
		if (!proj || !ag) {
			return;
		}
		proj.agents.set(agentId, {
			...ag,
			session_phase: 'started',
			session_started: true,
			...(info.sessionResource ? { session_resource: info.sessionResource } : {}),
			...(info.nativeSessionId ? { native_session_id: info.nativeSessionId } : {}),
			updated_at: Date.now(),
		});
		this._onDidChangeProject.fire({ projectId });
	}

	async rollbackUnstartedIfCliMissing(projectId: string, agentId: string): Promise<boolean> {
		const proj = this.projects.get(projectId);
		const ag = proj?.agents.get(agentId);
		if (!proj || !ag || ag.session_phase !== 'starting') {
			return false;
		}
		const hasPending = [...this.outbox.values()].some(
			o => o.projectId === projectId && o.targetAgentId === agentId && (o.state === 'pending' || o.state === 'in_flight'),
		);
		if (hasPending) {
			return false;
		}
		proj.agents.set(agentId, {
			...ag,
			session_phase: 'unstarted',
			session_started: false,
			updated_at: Date.now(),
		});
		this._onDidChangeProject.fire({ projectId });
		return true;
	}

	enqueueTestOutboxDelivery(input: {
		readonly projectId: string;
		readonly ticketId: string;
		readonly taskId: string;
		readonly targetAgentId: string;
		readonly deliveryMode: AdeTicketDeliveryMode;
		readonly payloadText: string;
	}): IAdeOutboxDeliveryItem {
		const deliveryId = this.nextId('dlv');
		const row: ITestMutableOutboxItem = {
			deliveryId,
			projectId: input.projectId,
			ticketId: input.ticketId,
			taskId: input.taskId,
			targetAgentId: input.targetAgentId,
			deliveryMode: input.deliveryMode,
			payloadText: input.payloadText,
			createdAt: Date.now(),
			state: 'pending',
			claimedByWindowId: null,
			leasedUntil: null,
			attempts: 0,
			nextRetryAt: 0,
		};
		this.outbox.set(deliveryId, row);
		const proj = this.projects.get(input.projectId);
		const ag = proj?.agents.get(input.targetAgentId);
		if (proj && ag && ag.session_phase === 'unstarted') {
			proj.agents.set(ag.agent_id, {
				...ag,
				session_phase: 'starting',
				session_started: true,
				updated_at: Date.now(),
			});
			this._onDidChangeProject.fire({ projectId: input.projectId });
		}
		this._onDidEnqueueOutbox.fire({ projectId: input.projectId, targetAgentId: input.targetAgentId });
		return row;
	}

	cancelTestOutboxTickets(projectId: string, ticketIds: readonly string[]): void {
		const set = new Set(ticketIds);
		for (const [did, row] of [...this.outbox.entries()]) {
			if (row.projectId === projectId && set.has(row.ticketId)) {
				this.outbox.delete(did);
			}
		}
		this._onDidCancelOutboxTickets.fire({ projectId, ticketIds });
	}

	async claimPendingDeliveries(windowId: number, limit = 16): Promise<readonly IAdeOutboxDeliveryItem[]> {
		const now = Date.now();
		for (const row of this.outbox.values()) {
			if (row.state === 'in_flight' && row.leasedUntil !== null && row.leasedUntil <= now) {
				row.state = 'pending';
				row.claimedByWindowId = null;
				row.leasedUntil = null;
			}
		}
		const pending = [...this.outbox.values()]
			.filter(r => r.state === 'pending' && r.nextRetryAt <= now)
			.sort((a, b) => (a.deliveryMode === 'steer' ? 0 : 1) - (b.deliveryMode === 'steer' ? 0 : 1) || a.createdAt - b.createdAt)
			.slice(0, limit);
		for (const r of pending) {
			r.state = 'in_flight';
			r.claimedByWindowId = windowId;
			r.leasedUntil = now + 30_000;
			r.attempts += 1;
		}
		return pending.map(r => ({
			deliveryId: r.deliveryId,
			projectId: r.projectId,
			ticketId: r.ticketId,
			taskId: r.taskId,
			targetAgentId: r.targetAgentId,
			deliveryMode: r.deliveryMode,
			payloadText: r.payloadText,
			createdAt: r.createdAt,
		}));
	}

	async ackDeliveryDispatched(deliveryId: string, _windowId: number): Promise<void> {
		this.outbox.delete(deliveryId);
	}

	async nackDeliveryFailed(deliveryId: string, _windowId: number, error: string, cliMissing?: boolean): Promise<void> {
		const row = this.outbox.get(deliveryId);
		if (!row) {
			return;
		}
		if (cliMissing) {
			row.state = 'blocked_cli';
			row.claimedByWindowId = null;
			row.leasedUntil = null;
			row.lastError = error;
			await this.rollbackUnstartedIfCliMissing(row.projectId, row.targetAgentId);
			return;
		}
		row.state = row.attempts >= 5 ? 'dead_letter' : 'pending';
		row.claimedByWindowId = null;
		row.leasedUntil = null;
		row.nextRetryAt = Date.now() + 50;
		row.lastError = error;
	}

	async requeueBlockedCliDeliveries(req?: { readonly projectId?: string; readonly agentId?: string }): Promise<{ readonly requeuedCount: number }> {
		const projectFilter = req?.projectId?.trim() || undefined;
		const agentFilter = req?.agentId?.trim() || undefined;
		let requeuedCount = 0;
		const wokenTargets = new Map<string, { readonly projectId: string; readonly targetAgentId: string }>();
		for (const row of this.outbox.values()) {
			if (row.state !== 'blocked_cli') {
				continue;
			}
			if (projectFilter && row.projectId !== projectFilter) {
				continue;
			}
			if (agentFilter && row.targetAgentId !== agentFilter) {
				continue;
			}
			row.state = 'pending';
			row.claimedByWindowId = null;
			row.leasedUntil = null;
			row.nextRetryAt = 0;
			row.lastError = undefined;
			requeuedCount++;
			wokenTargets.set(`${row.projectId}:${row.targetAgentId}`, { projectId: row.projectId, targetAgentId: row.targetAgentId });
		}
		for (const target of wokenTargets.values()) {
			this._onDidEnqueueOutbox.fire(target);
		}
		return { requeuedCount };
	}

	async releaseWindowDeliveries(windowId: number): Promise<void> {
		const released: Array<{ projectId: string; targetAgentId: string }> = [];
		for (const row of this.outbox.values()) {
			if (row.state === 'in_flight' && row.claimedByWindowId === windowId) {
				row.state = 'pending';
				row.claimedByWindowId = null;
				row.leasedUntil = null;
				row.nextRetryAt = 0;
				released.push({ projectId: row.projectId, targetAgentId: row.targetAgentId });
			}
		}
		for (const item of released) {
			this._onDidEnqueueOutbox.fire(item);
		}
	}

	async executeCliCommand(
		caller: IAdeVerifiedCliCaller,
		command: AdeCliCommandName,
		_args: Readonly<Record<string, unknown>>,
		_idempotencyKey?: string,
	): Promise<Record<string, unknown>> {
		if (command === 'ade_whoami') {
			const ag = this.projects.get(caller.projectId)?.agents.get(caller.agentId);
			if (!ag) {
				throw new AdeError('ERR_UNAUTHORIZED', 'Agent not found');
			}
			return {
				ok: true,
				agent_id: ag.agent_id,
				project_id: caller.projectId,
				level: `L${ag.level}`,
				name: ag.name,
				role_summary: ag.role_summary,
				host: ag.host,
				held_ticket_count: 0,
				wb_unread_total: 0,
				current_doc_rev: 1,
			};
		}
		return { ok: true };
	}
}
