/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { AEXUS_SSH_SCHEME } from '../../../../platform/ade/common/adeCloudHosts.js';
import { IAdeControlCenterService } from '../../../../platform/ade/common/adeControlCenterIpc.js';
import {
	IAdeAgentNode,
	IAdeCatalogSnapshot,
	IAdeProjectSnapshot,
	IAdeWorkspaceFolder,
} from '../../../../platform/ade/common/adeModels.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import {
	AdeAgentStatus,
	AdeProjectsChangeKind,
	buildAdeEmployeeSessionUri,
	IAdeAgent,
	IAdeProject,
	IAdeProjectPageItem,
	IAdeProjectsService,
	normalizeAdeShortEngineId,
	parseAdeEmployeeSessionUri,
} from '../common/ade.js';

const SELECTED_FOLDER_STORAGE_KEY = 'aexus.ade.selectedProject';
const SELECTED_PAGE_STORAGE_KEY = 'aexus.ade.selectedProjectPageId';

export type AdeProjectSelectionSource = 'sidebar' | 'editor' | 'cloudHost';

export interface IAdeProjectsSelectionRouting {
	readonly lastSelectionSource: AdeProjectSelectionSource;
	readonly selectedCloudHostUri: URI | undefined;
	setSelectionSource(source: AdeProjectSelectionSource, cloudHostUri?: URI): void;
	getCachedProjectSnapshot(projectId: string): IAdeProjectSnapshot | undefined;
}

export function asAdeProjectsSelectionRouting(service: IAdeProjectsService | undefined): IAdeProjectsSelectionRouting | undefined {
	if (service && typeof (service as unknown as Partial<IAdeProjectsSelectionRouting>).setSelectionSource === 'function') {
		return service as unknown as IAdeProjectsSelectionRouting;
	}
	return undefined;
}

interface IAgentTransientUiState {
	status: AdeAgentStatus;
	unread: boolean;
}

function normalizeFolderUri(uri: URI): URI {
	const stripped = removeTrailingPathSeparator(uri);
	if (stripped.scheme === AEXUS_SSH_SCHEME && stripped.authority) {
		return stripped.with({ authority: stripped.authority.toLowerCase() });
	}
	return stripped;
}

export class AdeProjectsService extends Disposable implements IAdeProjectsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<AdeProjectsChangeKind | void>());
	readonly onDidChange: Event<AdeProjectsChangeKind | void> = this._onDidChange.event;

	private readonly _onDidRemoveAgents = this._register(new Emitter<readonly IAdeAgent[]>());
	readonly onDidRemoveAgents: Event<readonly IAdeAgent[]> = this._onDidRemoveAgents.event;

	private readonly _onDidRemoveProjects = this._register(new Emitter<readonly string[]>());
	readonly onDidRemoveProjects: Event<readonly string[]> = this._onDidRemoveProjects.event;

	private readonly mutationQueue = new Sequencer();
	private readonly _readyPromise: Promise<void>;

	private _folders: IAdeWorkspaceFolder[] = [];
	private _projectPages: IAdeProjectPageItem[] = [];
	private readonly _snapshotsByProject = new Map<string, IAdeProjectSnapshot>();
	private readonly _transientByAgentKey = new Map<string, IAgentTransientUiState>();
	private readonly _extraBoundSessionUris = new Set<string>();

	private _selectedFolderUri: URI | undefined;
	private _selectedProjectPageId: string | undefined;
	private _selectedAgentId: string | undefined;
	private _lastSelectionSource: AdeProjectSelectionSource = 'sidebar';
	private _selectedCloudHostUri: URI | undefined;
	private _suppressWorkspaceSyncDepth = 0;
	private _isSyncingSelection = false;
	private _optimisticSeq = 0;
	private _snapshotCoordinatorCount = 0;
	private readonly _inflightSingleProjectRefreshes = new Map<string, {
		promise: Promise<void>;
		dispatched: boolean;
		pendingTrailing: boolean;
	}>();

	constructor(
		@IAdeControlCenterService private readonly controlCenter: IAdeControlCenterService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IProjectNavigationService private readonly projectNavigation: IProjectNavigationService,
		@IUriIdentityService private readonly uriIdentity: IUriIdentityService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		const savedFolderRaw = this.storageService.get(SELECTED_FOLDER_STORAGE_KEY, StorageScope.PROFILE);
		if (savedFolderRaw) {
			try {
				this._selectedFolderUri = normalizeFolderUri(URI.parse(savedFolderRaw));
			} catch {
				this._selectedFolderUri = undefined;
			}
		}
		this._selectedProjectPageId = this.storageService.get(SELECTED_PAGE_STORAGE_KEY, StorageScope.PROFILE) || undefined;

		this.seedInitialWorkspaceFoldersOptimistically();

		this._register(this.controlCenter.onDidChangeCatalog(() => {
			void this.refreshCatalog();
		}));
		this._register(this.controlCenter.onDidChangeProject(({ projectId }) => {
			if (this._snapshotCoordinatorCount > 0) {
				return;
			}
			void this.refreshSingleProject(projectId);
		}));
		this._register(this.workspaceContext.onDidChangeWorkspaceFolders(ev => {
			if (this._suppressWorkspaceSyncDepth > 0) {
				return;
			}
			for (const added of ev.added) {
				this.registerProject(added.uri, added.name);
			}
		}));
		if (this.projectNavigation.onDidChangeSelectedProject) {
			this._register(this.projectNavigation.onDidChangeSelectedProject(folder => {
				if (this._isSyncingSelection || !folder) {
					return;
				}
				const norm = normalizeFolderUri(folder.uri);
				if (this.findFolderIndex(norm) !== -1 && (!this._selectedFolderUri || !this.isSameFolderUri(this._selectedFolderUri, norm))) {
					this._selectedFolderUri = norm;
					this.persistSelectionCursors();
					this._onDidChange.fire('selection');
				}
			}));
		}

		this._readyPromise = this.hydrateFromControlCenter();
	}

	whenReady(): Promise<void> {
		return this._readyPromise;
	}

	private seedInitialWorkspaceFoldersOptimistically(): void {
		const wsFolders = this.workspaceContext.getWorkspace().folders ?? [];
		const now = Date.now();
		for (const wf of wsFolders) {
			const norm = normalizeFolderUri(wf.uri);
			if (this.findFolderIndex(norm) !== -1) {
				continue;
			}
			this._folders.push({
				folder_id: `opt_fld_${++this._optimisticSeq}`,
				folder_uri: norm.toString(),
				display_name: wf.name || basename(norm) || norm.authority || 'workspace',
				host: norm.scheme === AEXUS_SSH_SCHEME ? norm.authority : 'local',
				sort_order: this._folders.length * 10 + 10,
				collapsed: false,
				created_at: now,
				updated_at: now,
			});
		}
		if (!this._selectedFolderUri && this._folders.length > 0) {
			this._selectedFolderUri = URI.parse(this._folders[0].folder_uri);
		}
	}

	private async hydrateFromControlCenter(): Promise<void> {
		try {
			const wsFolders = this.workspaceContext.getWorkspace().folders ?? [];
			for (const wf of wsFolders) {
				const norm = normalizeFolderUri(wf.uri);
				await this.controlCenter.registerWorkspaceFolder({
					folderUri: norm.toString(),
					displayName: wf.name || basename(norm) || norm.authority || 'workspace',
					host: norm.scheme === AEXUS_SSH_SCHEME ? norm.authority : 'local',
				}).catch(() => undefined);
			}
			await this.refreshCatalog();
		} catch {
			// Resilient in partial unit-test harnesses.
		}
	}

	private isSameFolderUri(a: URI, b: URI): boolean {
		const na = normalizeFolderUri(a);
		const nb = normalizeFolderUri(b);
		return this.uriIdentity.extUri.isEqual(na, nb) || na.toString() === nb.toString();
	}

	private findFolderIndex(uri: URI): number {
		const norm = normalizeFolderUri(uri);
		return this._folders.findIndex(f => {
			try {
				return this.isSameFolderUri(URI.parse(f.folder_uri), norm);
			} catch {
				return f.folder_uri === norm.toString();
			}
		});
	}

	private persistSelectionCursors(): void {
		if (this._selectedFolderUri) {
			this.storageService.store(SELECTED_FOLDER_STORAGE_KEY, this._selectedFolderUri.toString(), StorageScope.PROFILE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(SELECTED_FOLDER_STORAGE_KEY, StorageScope.PROFILE);
		}
		if (this._selectedProjectPageId) {
			this.storageService.store(SELECTED_PAGE_STORAGE_KEY, this._selectedProjectPageId, StorageScope.PROFILE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(SELECTED_PAGE_STORAGE_KEY, StorageScope.PROFILE);
		}
	}

	get folders(): readonly IAdeWorkspaceFolder[] {
		return this._folders;
	}

	get projects(): readonly IAdeProject[] {
		return this._folders.map(f => ({
			uri: URI.parse(f.folder_uri),
			name: f.display_name,
			folderId: f.folder_id,
			host: f.host,
			collapsed: f.collapsed,
		}));
	}

	get projectPages(): readonly IAdeProjectPageItem[] {
		return this._projectPages;
	}

	private mapAgentNode(node: IAdeAgentNode, folderUri: URI): IAdeAgent {
		const shortEng = normalizeAdeShortEngineId(node.engine);
		const engineId = `aexus-${shortEng}`;
		const resource = node.session_resource
			? URI.parse(node.session_resource)
			: buildAdeEmployeeSessionUri(shortEng, node.project_id, node.agent_id);
		const transient = this._transientByAgentKey.get(`${node.project_id}:${node.agent_id}`);
		return {
			id: node.agent_id,
			projectId: node.project_id,
			...(node.parent_id ? { parentId: node.parent_id } : {}),
			projectUri: folderUri,
			label: node.name,
			level: node.level,
			isTopRole: node.is_top_role,
			roleSummary: node.role_summary,
			host: node.host,
			engine: shortEng,
			model: node.model,
			effort: node.effort,
			sessionPhase: node.session_phase,
			sessionStarted: node.session_started,
			status: transient?.status ?? 'idle',
			unread: transient?.unread ?? false,
			session: {
				engineId,
				resource,
			},
		};
	}

	get agents(): readonly IAdeAgent[] {
		const list: IAdeAgent[] = [];
		for (const page of this._projectPages) {
			const snap = this._snapshotsByProject.get(page.projectId);
			if (!snap) {
				continue;
			}
			for (const node of snap.agents) {
				list.push(this.mapAgentNode(node, page.folderUri));
			}
		}
		return list;
	}

	get selectedProject(): IAdeProject | undefined {
		const all = this.projects;
		if (this._selectedFolderUri) {
			const match = all.find(p => this.isSameFolderUri(p.uri, this._selectedFolderUri!));
			if (match) {
				return match;
			}
		}
		return all[0];
	}

	get selectedProjectPageId(): string | undefined {
		if (this._selectedProjectPageId && this._projectPages.some(p => p.projectId === this._selectedProjectPageId)) {
			return this._selectedProjectPageId;
		}
		return undefined;
	}

	get selectedAgentId(): string | undefined {
		if (this._selectedAgentId && this._selectedProjectPageId && this.getAgent(this._selectedAgentId, this._selectedProjectPageId)) {
			return this._selectedAgentId;
		}
		return undefined;
	}

	getProjectName(projectUri: URI): string {
		const matched = this.findMatchingFolder(projectUri);
		if (matched) {
			return matched.name;
		}
		const norm = normalizeFolderUri(projectUri);
		return basename(norm) || norm.authority || 'project';
	}

	private findMatchingFolder(resource: URI): IAdeProject | undefined {
		const norm = normalizeFolderUri(resource);
		const candidates = this.projects.filter(p =>
			this.isSameFolderUri(p.uri, norm) || this.uriIdentity.extUri.isEqualOrParent(norm, p.uri),
		);
		candidates.sort((a, b) => b.uri.path.length - a.uri.path.length);
		return candidates[0];
	}

	getProjectPagesForFolder(folderUri: URI): readonly IAdeProjectPageItem[] {
		const norm = normalizeFolderUri(folderUri);
		return this._projectPages
			.filter(p => this.isSameFolderUri(p.folderUri, norm))
			.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
	}

	getProjectPage(projectId: string): IAdeProjectPageItem | undefined {
		return this._projectPages.find(p => p.projectId === projectId);
	}

	getFolderForProjectPage(projectId: string): IAdeProject | undefined {
		const page = this.getProjectPage(projectId);
		if (!page) {
			return undefined;
		}
		return this.projects.find(f => f.folderId === page.folderId || this.isSameFolderUri(f.uri, page.folderUri));
	}

	allBoundSessionUris(): ReadonlySet<string> {
		const set = new Set<string>(this._extraBoundSessionUris);
		for (const ag of this.agents) {
			set.add(ag.session.resource.toString());
		}
		return set;
	}

	registerProject(uri: URI, name?: string): IAdeProject {
		const norm = normalizeFolderUri(uri);
		const idx = this.findFolderIndex(norm);
		const displayName = name?.trim() || basename(norm) || norm.authority || 'workspace';
		const now = Date.now();
		if (idx !== -1) {
			const current = this._folders[idx];
			if (name?.trim() && current.display_name !== displayName) {
				this._folders[idx] = { ...current, display_name: displayName, updated_at: now };
				this._onDidChange.fire();
			}
		} else {
			this._folders.push({
				folder_id: `opt_fld_${++this._optimisticSeq}`,
				folder_uri: norm.toString(),
				display_name: displayName,
				host: norm.scheme === AEXUS_SSH_SCHEME ? norm.authority : 'local',
				sort_order: (this._folders.length + 1) * 10,
				collapsed: false,
				created_at: now,
				updated_at: now,
			});
			if (!this._selectedFolderUri) {
				this._selectedFolderUri = norm;
				this.persistSelectionCursors();
			}
			this._onDidChange.fire();
		}

		void this.mutationQueue.queue(async () => {
			await this.controlCenter.registerWorkspaceFolder({
				folderUri: norm.toString(),
				displayName,
				host: norm.scheme === AEXUS_SSH_SCHEME ? norm.authority : 'local',
			});
			await this.refreshCatalog();
		}).catch(() => undefined);

		return this.projects.find(p => this.isSameFolderUri(p.uri, norm)) ?? {
			uri: norm,
			name: displayName,
		};
	}

	async registerWorkspaceFolderAsync(uri: URI, name?: string): Promise<IAdeProject> {
		const norm = normalizeFolderUri(uri);
		const displayName = name?.trim() || basename(norm) || norm.authority || 'workspace';
		await this.mutationQueue.queue(async () => {
			await this.controlCenter.registerWorkspaceFolder({
				folderUri: norm.toString(),
				displayName,
				host: norm.scheme === AEXUS_SSH_SCHEME ? norm.authority : 'local',
			});
			await this.refreshCatalog();
		});
		return this.projects.find(p => this.isSameFolderUri(p.uri, norm)) ?? { uri: norm, name: displayName };
	}

	migrateCloudHostAlias(oldAlias: string, newAlias: string): number {
		const oldLower = oldAlias.trim().toLowerCase();
		const nextLower = newAlias.trim().toLowerCase();
		if (!oldLower || !nextLower || oldLower === nextLower) {
			return 0;
		}
		let count = 0;
		const now = Date.now();
		this._folders = this._folders.map(folder => {
			const parsed = URI.parse(folder.folder_uri);
			if (parsed.scheme === AEXUS_SSH_SCHEME && parsed.authority.toLowerCase() === oldLower) {
				count++;
				const migrated = parsed.with({ authority: nextLower });
				return {
					...folder,
					folder_uri: migrated.toString(),
					host: folder.host.toLowerCase() === oldLower ? nextLower : folder.host,
					updated_at: now,
				};
			}
			return folder;
		});
		this._projectPages = this._projectPages.map(page => {
			if (page.folderUri.scheme === AEXUS_SSH_SCHEME && page.folderUri.authority.toLowerCase() === oldLower) {
				return {
					...page,
					folderUri: page.folderUri.with({ authority: nextLower }),
					updatedAt: now,
				};
			}
			return page;
		});
		if (this._selectedFolderUri?.scheme === AEXUS_SSH_SCHEME && this._selectedFolderUri.authority.toLowerCase() === oldLower) {
			this._selectedFolderUri = this._selectedFolderUri.with({ authority: nextLower });
			this.persistSelectionCursors();
		}
		if (count > 0) {
			this._onDidChange.fire();
		}
		void this.mutationQueue.queue(async () => {
			await this.controlCenter.migrateCloudHostAlias(oldAlias, newAlias);
			await this.refreshCatalog();
		}).catch(() => undefined);
		return count;
	}

	unregisterProject(uri: URI): void {
		this.removeProject(uri);
	}

	removeProject(uri: URI): readonly IAdeAgent[] {
		const norm = normalizeFolderUri(uri);
		const removedAgents = this.agents.filter(a => this.isSameFolderUri(a.projectUri, norm));
		const removedPages = this._projectPages.filter(p => this.isSameFolderUri(p.folderUri, norm));
		const removedProjectIds = removedPages.map(p => p.projectId);
		this._folders = this._folders.filter(f => !this.isSameFolderUri(URI.parse(f.folder_uri), norm));
		this._projectPages = this._projectPages.filter(p => !this.isSameFolderUri(p.folderUri, norm));
		for (const page of removedPages) {
			this._snapshotsByProject.delete(page.projectId);
			if (this._selectedProjectPageId === page.projectId) {
				this._selectedProjectPageId = undefined;
				this._selectedAgentId = undefined;
			}
		}
		if (this._selectedFolderUri && this.isSameFolderUri(this._selectedFolderUri, norm)) {
			this._selectedFolderUri = this._folders[0] ? URI.parse(this._folders[0].folder_uri) : undefined;
		}
		if (
			this._selectedAgentId
			&& (!this._selectedProjectPageId
				? removedAgents.some(a => a.id === this._selectedAgentId)
				: !this.getAgent(this._selectedAgentId, this._selectedProjectPageId))
		) {
			this._selectedAgentId = undefined;
		}
		this.persistSelectionCursors();
		if (removedProjectIds.length > 0) {
			this._onDidRemoveProjects.fire(removedProjectIds);
		}
		if (removedAgents.length > 0) {
			this._onDidRemoveAgents.fire(removedAgents);
		}
		this._onDidChange.fire();

		void this.mutationQueue.queue(async () => {
			await this.controlCenter.removeWorkspaceFolder(norm.toString());
			await this.refreshCatalog();
		}).catch(() => undefined);

		return removedAgents;
	}

	async removeWorkspaceFolderAsync(uri: URI): Promise<void> {
		const norm = normalizeFolderUri(uri);
		const removedAgents = this.agents.filter(a => this.isSameFolderUri(a.projectUri, norm));
		const removedProjectIds = this._projectPages.filter(p => this.isSameFolderUri(p.folderUri, norm)).map(p => p.projectId);
		await this.mutationQueue.queue(async () => {
			await this.controlCenter.removeWorkspaceFolder(norm.toString());
			await this.refreshCatalog();
		});
		if (removedProjectIds.length > 0) {
			this._onDidRemoveProjects.fire(removedProjectIds);
		}
		if (removedAgents.length > 0) {
			this._onDidRemoveAgents.fire(removedAgents);
		}
	}

	moveProjectFolder(sourceUri: URI, targetUri: URI | undefined, after: boolean): void {
		const srcNorm = normalizeFolderUri(sourceUri);
		const srcIdx = this.findFolderIndex(srcNorm);
		if (srcIdx === -1) {
			return;
		}
		const src = this._folders[srcIdx];
		const rest = this._folders.filter((_, idx) => idx !== srcIdx);
		if (!targetUri) {
			if (after) {
				rest.push(src);
			} else {
				rest.unshift(src);
			}
		} else {
			const tgtNorm = normalizeFolderUri(targetUri);
			if (this.isSameFolderUri(srcNorm, tgtNorm)) {
				return;
			}
			const tgtIdx = rest.findIndex(f => this.isSameFolderUri(URI.parse(f.folder_uri), tgtNorm));
			if (tgtIdx === -1) {
				return;
			}
			rest.splice(after ? tgtIdx + 1 : tgtIdx, 0, src);
		}
		const now = Date.now();
		this._folders = rest.map((f, index) => ({ ...f, sort_order: (index + 1) * 10, updated_at: now }));
		this._onDidChange.fire('order');

		void this.mutationQueue.queue(async () => {
			await this.controlCenter.reorderWorkspaceFolder(srcNorm.toString(), targetUri ? normalizeFolderUri(targetUri).toString() : undefined, after);
			await this.refreshCatalog();
		}).catch(() => undefined);
	}

	async setFolderCollapsed(folderUri: URI, collapsed: boolean): Promise<void> {
		const norm = normalizeFolderUri(folderUri);
		const idx = this.findFolderIndex(norm);
		if (idx !== -1 && this._folders[idx].collapsed !== collapsed) {
			this._folders[idx] = { ...this._folders[idx], collapsed, updated_at: Date.now() };
			this._onDidChange.fire();
		}
		await this.mutationQueue.queue(async () => {
			await this.controlCenter.setWorkspaceFolderCollapsed(norm.toString(), collapsed);
		});
	}

	async runWithSuppressedWorkspaceSync<T>(fn: () => Promise<T>): Promise<T> {
		this._suppressWorkspaceSyncDepth++;
		try {
			return await fn();
		} finally {
			this._suppressWorkspaceSyncDepth = Math.max(0, this._suppressWorkspaceSyncDepth - 1);
		}
	}

	ensureCatalogPersisted(): void {
		// Authoritative catalog state lives in SQLite via IAdeControlCenterService.
	}

	async createProjectPage(folderUri: URI, name?: string): Promise<IAdeProjectSnapshot> {
		const norm = normalizeFolderUri(folderUri);
		const snap = await this.mutationQueue.queue(async () => {
			await this.controlCenter.registerWorkspaceFolder({
				folderUri: norm.toString(),
				displayName: this.getProjectName(norm),
				host: norm.scheme === AEXUS_SSH_SCHEME ? norm.authority : 'local',
			});
			return this.controlCenter.createProject({
				folderUri: norm.toString(),
				...(name?.trim() ? { name: name.trim() } : {}),
			});
		});
		this._snapshotsByProject.set(snap.meta.project_id, snap);
		await this.refreshCatalog();
		this.selectProjectPage(snap.meta.project_id);
		return snap;
	}

	async renameProjectPage(projectId: string, name: string): Promise<void> {
		const trimmed = name.trim();
		if (!trimmed) {
			return;
		}
		await this.mutationQueue.queue(async () => {
			await this.controlCenter.renameProject(projectId, trimmed);
		});
		await this.refreshCatalog();
	}

	async reorderProjectPage(projectId: string, targetProjectId: string | undefined, after: boolean): Promise<void> {
		const src = this.getProjectPage(projectId);
		if (!src) {
			return;
		}
		if (targetProjectId) {
			const tgt = this.getProjectPage(targetProjectId);
			if (!tgt || !this.isSameFolderUri(src.folderUri, tgt.folderUri)) {
				return;
			}
		}
		await this.mutationQueue.queue(async () => {
			await this.controlCenter.reorderProject(projectId, targetProjectId, after);
		});
		await this.refreshCatalog('order');
	}

	async deleteProjectPage(projectId: string): Promise<void> {
		const trimmed = projectId.trim();
		if (!trimmed) {
			return;
		}
		const page = this.getProjectPage(trimmed);
		const removedAgents = this.agents.filter(a => a.projectId === trimmed);
		await this.mutationQueue.queue(async () => {
			await this.controlCenter.deleteProject(trimmed);
		});
		this._snapshotsByProject.delete(trimmed);
		if (this._selectedProjectPageId === trimmed) {
			this._selectedProjectPageId = undefined;
			this._selectedAgentId = undefined;
			if (page) {
				this._selectedFolderUri = page.folderUri;
			}
			this.persistSelectionCursors();
		}
		if (
			this._selectedAgentId
			&& (!this._selectedProjectPageId
				? removedAgents.some(a => a.id === this._selectedAgentId)
				: !this.getAgent(this._selectedAgentId, this._selectedProjectPageId))
		) {
			this._selectedAgentId = undefined;
		}
		await this.refreshCatalog();
		this._onDidRemoveProjects.fire([trimmed]);
		if (removedAgents.length > 0) {
			this._onDidRemoveAgents.fire(removedAgents);
		}
	}

	private applyCatalogSnapshot(catalog: IAdeCatalogSnapshot): void {
		const sortedFolders = [...catalog.folders].sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);
		this._folders = sortedFolders;

		const sortedPages = [...catalog.projects]
			.sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at)
			.map((p): IAdeProjectPageItem => ({
				projectId: p.project_id,
				folderId: p.folder_id,
				folderUri: normalizeFolderUri(URI.parse(p.folder_uri)),
				name: p.name,
				sortOrder: p.sort_order,
				createdAt: p.created_at,
				updatedAt: p.updated_at,
			}));
		this._projectPages = sortedPages;

		const validProjectIds = new Set(sortedPages.map(p => p.projectId));
		for (const pid of [...this._snapshotsByProject.keys()]) {
			if (!validProjectIds.has(pid)) {
				this._snapshotsByProject.delete(pid);
			}
		}

		if (this._selectedProjectPageId && !validProjectIds.has(this._selectedProjectPageId)) {
			this._selectedProjectPageId = undefined;
			this._selectedAgentId = undefined;
		}
		if (this._selectedFolderUri && this.findFolderIndex(this._selectedFolderUri) === -1) {
			this._selectedFolderUri = this._folders[0] ? URI.parse(this._folders[0].folder_uri) : undefined;
		} else if (!this._selectedFolderUri && this._folders.length > 0) {
			this._selectedFolderUri = URI.parse(this._folders[0].folder_uri);
		}
	}

	async refreshCatalog(changeKind?: AdeProjectsChangeKind): Promise<void> {
		const [catalog, boundResources] = await Promise.all([
			this.controlCenter.getCatalogSnapshot(),
			this.controlCenter.listAllBoundSessionResources().catch(() => [] as readonly string[]),
		]);
		this.applyCatalogSnapshot(catalog);
		this._extraBoundSessionUris.clear();
		for (const r of boundResources) {
			if (r) {
				this._extraBoundSessionUris.add(r);
			}
		}

		await Promise.all(
			catalog.projects.map(async p => {
				const snap = await this.controlCenter.getProjectSnapshot(p.project_id).catch(() => undefined);
				if (snap) {
					this._snapshotsByProject.set(p.project_id, snap);
				}
			}),
		);
		this._onDidChange.fire(changeKind);
	}

	attachSnapshotCoordinator(): { dispose(): void } {
		this._snapshotCoordinatorCount++;
		let disposed = false;
		return {
			dispose: () => {
				if (!disposed) {
					disposed = true;
					this._snapshotCoordinatorCount = Math.max(0, this._snapshotCoordinatorCount - 1);
				}
			},
		};
	}

	private async refreshSingleProject(projectId: string): Promise<void> {
		if (!projectId) {
			return;
		}
		const existing = this._inflightSingleProjectRefreshes.get(projectId);
		if (existing) {
			if (existing.dispatched) {
				existing.pendingTrailing = true;
			}
			return existing.promise;
		}
		const entry = {
			promise: undefined as unknown as Promise<void>,
			dispatched: false,
			pendingTrailing: false,
		};
		entry.promise = (async () => {
			try {
				let snap: IAdeProjectSnapshot | undefined;
				for (;;) {
					entry.pendingTrailing = false;
					entry.dispatched = false;
					queueMicrotask(() => {
						entry.dispatched = true;
					});
					snap = await this.controlCenter.getProjectSnapshot(projectId).catch(() => undefined);
					if (!entry.pendingTrailing) {
						break;
					}
				}
				if (snap) {
					this.notifyProjectSnapshotLoaded(snap);
				} else {
					await this.refreshCatalog();
				}
			} finally {
				if (this._inflightSingleProjectRefreshes.get(projectId) === entry) {
					this._inflightSingleProjectRefreshes.delete(projectId);
				}
			}
		})();
		this._inflightSingleProjectRefreshes.set(projectId, entry);
		return entry.promise;
	}

	notifyProjectSnapshotLoaded(snapshot: IAdeProjectSnapshot): void {
		const projectId = snapshot.meta.project_id;
		this._snapshotsByProject.set(projectId, snapshot);
		const pageIdx = this._projectPages.findIndex(p => p.projectId === projectId);
		if (pageIdx !== -1 && (this._projectPages[pageIdx].name !== snapshot.meta.name || this._projectPages[pageIdx].updatedAt !== snapshot.meta.updated_at)) {
			this._projectPages[pageIdx] = {
				...this._projectPages[pageIdx],
				name: snapshot.meta.name,
				updatedAt: snapshot.meta.updated_at,
			};
		}
		this._onDidChange.fire();
	}

	get lastSelectionSource(): AdeProjectSelectionSource {
		return this._lastSelectionSource;
	}

	get selectedCloudHostUri(): URI | undefined {
		return this._selectedCloudHostUri;
	}

	setSelectionSource(source: AdeProjectSelectionSource, cloudHostUri?: URI): void {
		const prevSource = this._lastSelectionSource;
		const prevCloudKey = this._selectedCloudHostUri?.toString();
		this._lastSelectionSource = source;
		if (source === 'cloudHost') {
			this._selectedCloudHostUri = cloudHostUri;
		} else if (source === 'sidebar') {
			this._selectedCloudHostUri = undefined;
		}
		if (prevSource !== source || prevCloudKey !== this._selectedCloudHostUri?.toString()) {
			this._onDidChange.fire('selection');
		}
	}

	getCachedProjectSnapshot(projectId: string): IAdeProjectSnapshot | undefined {
		return this._snapshotsByProject.get(projectId);
	}

	selectProject(resource: URI): void {
		const matched = this.findMatchingFolder(resource);
		const nextUri = matched ? matched.uri : normalizeFolderUri(resource);
		const folderChanged = !this._selectedFolderUri || !this.isSameFolderUri(this._selectedFolderUri, nextUri);
		let clearedCrossFolderRefs = false;
		if (folderChanged) {
			if (this._selectedProjectPageId !== undefined) {
				const currentPage = this.getProjectPage(this._selectedProjectPageId);
				if (!currentPage || !this.isSameFolderUri(currentPage.folderUri, nextUri)) {
					this._selectedProjectPageId = undefined;
					clearedCrossFolderRefs = true;
				}
			}
			if (this._selectedAgentId !== undefined) {
				const currentAgent = this._selectedProjectPageId
					? this.getAgent(this._selectedAgentId, this._selectedProjectPageId)
					: this.getAgent(this._selectedAgentId);
				if (!currentAgent || !this.isSameFolderUri(currentAgent.projectUri, nextUri)) {
					this._selectedAgentId = undefined;
					clearedCrossFolderRefs = true;
				}
			}
		} else if (this._selectedProjectPageId !== undefined) {
			const currentPage = this.getProjectPage(this._selectedProjectPageId);
			if (currentPage && !this.isSameFolderUri(currentPage.folderUri, nextUri)) {
				this._selectedProjectPageId = undefined;
				this._selectedAgentId = undefined;
				clearedCrossFolderRefs = true;
			}
		}
		this._selectedFolderUri = nextUri;
		this.persistSelectionCursors();
		if (!this._isSyncingSelection) {
			const syncTargetUri = matched ? matched.uri : nextUri;
			const navUri = this.projectNavigation.selectedProject?.uri;
			if (folderChanged || !navUri || !this.isSameFolderUri(navUri, syncTargetUri)) {
				this._isSyncingSelection = true;
				try {
					this.projectNavigation.selectProject(syncTargetUri);
				} finally {
					this._isSyncingSelection = false;
				}
			}
		}
		if (folderChanged || clearedCrossFolderRefs) {
			this._onDidChange.fire('selection');
		}
	}

	selectProjectPage(projectId: string | undefined): void {
		if (!projectId) {
			if (this._selectedProjectPageId !== undefined) {
				this._selectedProjectPageId = undefined;
				this.persistSelectionCursors();
				this._onDidChange.fire('selection');
			}
			return;
		}
		const page = this.getProjectPage(projectId);
		const pageChanged = this._selectedProjectPageId !== projectId;
		this._selectedProjectPageId = projectId;
		if (page) {
			const folderChanged = !this._selectedFolderUri || !this.isSameFolderUri(this._selectedFolderUri, page.folderUri);
			if (this._selectedAgentId && !this.getAgent(this._selectedAgentId, projectId)) {
				this._selectedAgentId = undefined;
			}
			this._selectedFolderUri = page.folderUri;
			this.persistSelectionCursors();
			if (!this._isSyncingSelection) {
				const navUri = this.projectNavigation.selectedProject?.uri;
				if (folderChanged || !navUri || !this.isSameFolderUri(navUri, page.folderUri)) {
					this._isSyncingSelection = true;
					try {
						this.projectNavigation.selectProject(page.folderUri);
					} finally {
						this._isSyncingSelection = false;
					}
				}
			}
			if (pageChanged || folderChanged) {
				this._onDidChange.fire('selection');
			}
			return;
		}
		this.persistSelectionCursors();
		if (pageChanged) {
			this._onDidChange.fire('selection');
		}
	}

	selectAgent(id: string | undefined, projectId?: string): void {
		if (!id) {
			if (this._selectedAgentId !== undefined) {
				this._selectedAgentId = undefined;
				this._onDidChange.fire('selection');
			}
			return;
		}
		const agent = this.getAgent(id, projectId);
		const targetProjectId = agent?.projectId ?? projectId;
		const agentChanged = this._selectedAgentId !== id;
		const pageChanged = Boolean(targetProjectId && this._selectedProjectPageId !== targetProjectId);
		this._selectedAgentId = id;
		if (targetProjectId) {
			this._selectedProjectPageId = targetProjectId;
		}
		const candidateFolderUri = agent?.projectUri ?? (targetProjectId ? this.getProjectPage(targetProjectId)?.folderUri : undefined);
		let folderChanged = false;
		if (candidateFolderUri) {
			const matched = this.findMatchingFolder(candidateFolderUri);
			const nextFolderUri = matched ? matched.uri : normalizeFolderUri(candidateFolderUri);
			folderChanged = !this._selectedFolderUri || !this.isSameFolderUri(this._selectedFolderUri, nextFolderUri);
			this._selectedFolderUri = nextFolderUri;
			this.persistSelectionCursors();
			if (!this._isSyncingSelection) {
				const navUri = this.projectNavigation.selectedProject?.uri;
				if (folderChanged || !navUri || !this.isSameFolderUri(navUri, nextFolderUri)) {
					this._isSyncingSelection = true;
					try {
						this.projectNavigation.selectProject(nextFolderUri);
					} finally {
						this._isSyncingSelection = false;
					}
				}
			}
		} else if (pageChanged) {
			this.persistSelectionCursors();
		}
		if (agentChanged || pageChanged || folderChanged) {
			this._onDidChange.fire('selection');
		}
	}

	getAgent(id: string, projectId?: string): IAdeAgent | undefined {
		if (projectId) {
			const page = this.getProjectPage(projectId);
			const snap = this._snapshotsByProject.get(projectId);
			const node = snap?.agents.find(a => a.agent_id === id);
			if (node) {
				return this.mapAgentNode(node, page?.folderUri ?? URI.parse(snap!.meta.folder_uri));
			}
			return undefined;
		}
		if (this._selectedProjectPageId) {
			const inSelected = this.getAgent(id, this._selectedProjectPageId);
			if (inSelected) {
				return inSelected;
			}
		}
		for (const page of this._projectPages) {
			const snap = this._snapshotsByProject.get(page.projectId);
			const node = snap?.agents.find(a => a.agent_id === id);
			if (node) {
				return this.mapAgentNode(node, page.folderUri);
			}
		}
		return undefined;
	}

	markRead(id: string, projectId?: string): void {
		const resolvedProjectId = projectId ?? this._selectedProjectPageId ?? this.getAgent(id)?.projectId;
		if (!resolvedProjectId) {
			return;
		}
		const targetKey = `${resolvedProjectId}:${id}`;
		const state = this._transientByAgentKey.get(targetKey);
		if (state?.unread) {
			this._transientByAgentKey.set(targetKey, { ...state, unread: false });
			this._onDidChange.fire();
		}
	}

	setAgentStatus(id: string, status: AdeAgentStatus, unread?: boolean, projectId?: string): void {
		const agent = this.getAgent(id, projectId);
		if (!agent) {
			return;
		}
		const key = `${agent.projectId}:${agent.id}`;
		const prev = this._transientByAgentKey.get(key) ?? { status: 'idle', unread: false };
		const nextUnread = unread !== undefined ? unread : prev.unread;
		if (prev.status === status && prev.unread === nextUnread) {
			return;
		}
		this._transientByAgentKey.set(key, { status, unread: nextUnread });
		this._onDidChange.fire();
	}

	syncSessionItem(resource: URI, update: { readonly label?: string; readonly status?: AdeAgentStatus }, isActiveInEditor?: boolean): void {
		const parsed = parseAdeEmployeeSessionUri(resource);
		const targetKey = resource.toString();
		const agent = parsed
			? this.getAgent(parsed.agentId, parsed.projectId)
			: this.agents.find(a => a.session.resource.toString() === targetKey);
		if (!agent) {
			return;
		}
		const key = `${agent.projectId}:${agent.id}`;
		const prev = this._transientByAgentKey.get(key) ?? { status: 'idle', unread: false };
		const nextStatus = update.status ?? prev.status;
		let nextUnread = prev.unread;
		if (isActiveInEditor) {
			nextUnread = false;
		} else if (prev.status === 'working' && nextStatus === 'idle') {
			nextUnread = true;
		}
		if (prev.status !== nextStatus || prev.unread !== nextUnread) {
			this._transientByAgentKey.set(key, { status: nextStatus, unread: nextUnread });
			this._onDidChange.fire();
		}
	}
}
