/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AdeThinkingLevel, AdeWorkTreeType } from '../../../../platform/ade/common/adeEngineering.js';
import {
	ADE_ORGANIZATION_CONFIG_KEY,
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	getDefaultPureLeafRank,
	getNextLowerRankFromConfig,
	getTopRankDefinition,
	IAdeOrganizationConfig,
	isPureExecutionRank,
	normalizeAdeOrganizationConfig,
	resolveEffectiveRankDefinition,
	resolveWorkTreeSlotRank,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import {
	AdeAgentRole,
	AdeAgentStatus,
	AdeProjectsChangeKind,
	getAdeRoleRankLevel,
	IAdeAddSessionOptions,
	IAdeAgent,
	IAdeAgentTreeNode,
	IAdeProject,
	IAdeProjectsService,
	IAdeSecretary,
	IAdeSession,
	IAdeWorkTreeSegmentSpec,
	IAdeWorkTreeSyncResult,
} from '../common/ade.js';
import { readTrustedApplicationConfigValue } from '../common/adeRoleSchemaService.js';

interface IStoredProject {
	uri: string;
	name: string;
}

interface IStoredAgent {
	id: string;
	parentId?: string;
	projectUri: string;
	label: string;
	labelIsCustom?: boolean;
	role?: AdeAgentRole;
	archived?: boolean;
	unread?: boolean;
	draft: string;
	session?: { engineId: string; resource: string };
	treeType?: AdeWorkTreeType;
	treeGovernorId?: string;
	treeSegmentId?: string;
	treeNodeId?: string;
	preferredEngineId?: string;
	preferredModel?: string;
	preferredThinking?: AdeThinkingLevel;
	workingDirectoryOverride?: string;
}

interface IStoredSecretary {
	label?: string;
	draft?: string;
	unread?: boolean;
	session?: { engineId: string; resource: string };
}

export class AdeProjectsService extends Disposable implements IAdeProjectsService {
	declare readonly _serviceBrand: undefined;

	private catalogProjects: IAdeProject[];
	private entries: IAdeAgent[];
	private selectedProjectUri: URI | undefined;
	private _selectedAgentId: string | undefined;
	private _secretary: IAdeSecretary;
	private _showArchived: boolean;
	private suppressNavEvents = false;
	private suppressWorkspaceSyncCount = 0;
	private isSavingStorage = false;
	private lastWorkspaceKeys: string;

	private readonly changeEmitter = this._register(new Emitter<AdeProjectsChangeKind | void>());
	readonly onDidChange = this.changeEmitter.event;
	private readonly removedAgentsEmitter = this._register(new Emitter<readonly IAdeAgent[]>());
	readonly onDidRemoveAgents = this.removedAgentsEmitter.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IProjectNavigationService private readonly projectNavigation: IProjectNavigationService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ADE_ORGANIZATION_CONFIG_KEY)) {
				this.changeEmitter.fire();
			}
		}));

		const catalogInitialized = storageService.getBoolean('aexus.ade.catalogInitialized', StorageScope.PROFILE, false);
		const hasStoredProjectsKey = storageService.get('aexus.ade.projects', StorageScope.PROFILE) !== undefined;
		this.catalogProjects = this.loadStoredCatalogProjects();
		this.entries = this.loadStoredAgents();

		let catalogDirty = false;
		for (const agent of this.entries) {
			if (!agent.parentId && this.ensureCatalogProject(agent.projectUri, basename(agent.projectUri), false)) {
				catalogDirty = true;
			}
		}

		const isInternalMirror = this.isInternalMirrorWorkspace();
		if (!catalogInitialized) {
			this.mergeIntoCatalog(this.projectNavigation.orderedProjects);
			if (hasStoredProjectsKey || this.entries.some(agent => !agent.parentId)) {
				catalogDirty = true;
			}
		} else if (!isInternalMirror && this.projectNavigation.orderedProjects.length > 0) {
			if (this.mergeIntoCatalog(this.projectNavigation.orderedProjects)) {
				catalogDirty = true;
			}
		} else if (isInternalMirror) {
			this.applyCatalogOrderToNavigation();
		}

		if (catalogDirty) {
			this.saveProjects();
		}

		const storedSelectedProject = storageService.get('aexus.ade.selectedProject', StorageScope.PROFILE);
		const storedSelectedAgentId = storageService.get('aexus.ade.selectedProjectId', StorageScope.PROFILE);
		this._selectedAgentId = storedSelectedAgentId;
		if (storedSelectedProject) {
			this.selectedProjectUri = removeTrailingPathSeparator(URI.parse(storedSelectedProject));
		} else if (storedSelectedAgentId) {
			const legacyAgent = this.entries.find(agent => agent.id === storedSelectedAgentId);
			this.selectedProjectUri = legacyAgent?.projectUri;
		} else if (this.projectNavigation.selectedProject) {
			this.selectedProjectUri = this.projectNavigation.selectedProject.uri;
		}

		const storedSecretary = storageService.getObject<IStoredSecretary>('aexus.ade.secretary', StorageScope.PROFILE, {});
		this._secretary = {
			label: localize('adeSecretaryLabel', "Secretary"),
			draft: storedSecretary.draft ?? '',
			status: 'idle',
			unread: storedSecretary.unread,
			session: storedSecretary.session ? { engineId: storedSecretary.session.engineId, resource: URI.parse(storedSecretary.session.resource) } : undefined,
		};

		if (storageService.get('aexus.ade.viewMode', StorageScope.PROFILE) !== undefined) {
			this.isSavingStorage = true;
			try {
				storageService.remove('aexus.ade.viewMode', StorageScope.PROFILE);
			} finally {
				this.isSavingStorage = false;
			}
		}
		this._showArchived = storageService.getBoolean('aexus.ade.showArchived', StorageScope.PROFILE, false);

		this.lastWorkspaceKeys = this.computeWorkspaceKeys();

		this._register(this.contextService.onDidChangeWorkspaceFolders(e => {
			const removedAgents: IAdeAgent[] = [];
			let catalogChanged = false;
			if (this.suppressWorkspaceSyncCount === 0) {
				for (const folder of e?.added ?? []) {
					if (this.ensureCatalogProject(folder.uri, folder.name, false)) {
						catalogChanged = true;
					}
				}
				for (const folder of e?.removed ?? []) {
					const removed = this.doRemoveProject(folder.uri, false);
					removedAgents.push(...removed.removedAgents);
					if (removed.projectsChanged) {
						catalogChanged = true;
					}
				}
				if (this.syncCatalogOrderWith(this.projectNavigation.orderedProjects)) {
					catalogChanged = true;
				}
				if (catalogChanged) {
					this.saveProjects();
				}
			}
			this.lastWorkspaceKeys = this.computeWorkspaceKeys();
			if (removedAgents.length > 0) {
				this.removedAgentsEmitter.fire(removedAgents);
			}
			this.changeEmitter.fire();
		}));

		this._register(this.projectNavigation.onDidChangeProjectOrder(() => {
			if (this.suppressNavEvents || this.suppressWorkspaceSyncCount > 0) {
				return;
			}
			const nextKeys = this.computeWorkspaceKeys();
			const structureChanged = nextKeys !== this.lastWorkspaceKeys;
			this.lastWorkspaceKeys = nextKeys;
			if (structureChanged) {
				return;
			}
			if (this.syncCatalogOrderWith(this.projectNavigation.orderedProjects)) {
				this.saveProjects();
			}
			this.changeEmitter.fire('order');
		}));

		this._register(this.projectNavigation.onDidChangeProject(focused => {
			if (this.suppressNavEvents) {
				return;
			}
			if (focused) {
				this.selectedProjectUri = focused.uri;
				this.persistSelectedProject();
			}
			this.changeEmitter.fire();
		}));

		this._register(this.projectNavigation.onDidChangeSelectedProject(selected => {
			if (this.suppressNavEvents || !selected) {
				return;
			}
			if (!this.uriIdentityService.extUri.isEqual(this.selectedProjectUri, selected.uri)) {
				this.selectedProjectUri = selected.uri;
				this.persistSelectedProject();
				this.changeEmitter.fire('selection');
			}
		}));

		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, undefined, this._store)(e => {
			if (!e.external || this.isSavingStorage) {
				return;
			}
			if (e.key === 'aexus.ade.projects' || e.key === 'aexus.ade.agents') {
				this.reloadFromExternalStorage();
			}
		}));
	}

	ensureCatalogPersisted(): void {
		if (!this.storageService.getBoolean('aexus.ade.catalogInitialized', StorageScope.PROFILE, false) && this.catalogProjects.length > 0) {
			this.saveProjects();
		}
	}

	async runWithSuppressedWorkspaceSync<T>(fn: () => Promise<T>): Promise<T> {
		this.suppressWorkspaceSyncCount++;
		try {
			return await fn();
		} finally {
			this.suppressWorkspaceSyncCount--;
		}
	}

	private isInternalMirrorWorkspace(): boolean {
		const configUri = this.contextService.getWorkspace()?.configuration;
		return Boolean(configUri && /\/Projects\/[^/]+\/projects\.code-workspace$/i.test(configUri.path));
	}

	private loadStoredCatalogProjects(): IAdeProject[] {
		const seen = new Set<string>();
		const result: IAdeProject[] = [];
		const stored = this.storageService.getObject<IStoredProject[]>('aexus.ade.projects', StorageScope.PROFILE, []);
		if (!Array.isArray(stored)) {
			return result;
		}
		for (const item of stored) {
			if (!item || typeof item.uri !== 'string' || !item.uri.trim()) {
				continue;
			}
			try {
				const normalized = removeTrailingPathSeparator(URI.parse(item.uri));
				const key = this.uriIdentityService.extUri.getComparisonKey(normalized);
				if (!seen.has(key)) {
					seen.add(key);
					result.push({ uri: normalized, name: item.name || basename(normalized) });
				}
			} catch {
				// Skip malformed persisted URI entry rather than aborting startup.
			}
		}
		return result;
	}

	private loadStoredAgents(preserveStatusFrom?: readonly IAdeAgent[]): IAdeAgent[] {
		const statusById = preserveStatusFrom ? new Map(preserveStatusFrom.map(agent => [agent.id, agent.status ?? 'idle'])) : undefined;
		const stored = this.storageService.getObject<IStoredAgent[]>('aexus.ade.agents', StorageScope.PROFILE, []);
		if (!Array.isArray(stored)) {
			return [];
		}
		const parsed: IAdeAgent[] = [];
		for (const entry of stored) {
			if (!entry || typeof entry.id !== 'string' || typeof entry.projectUri !== 'string') {
				continue;
			}
			try {
				let parsedSession: { engineId: string; resource: URI } | undefined;
				if (entry.session && typeof entry.session.engineId === 'string' && typeof entry.session.resource === 'string') {
					try {
						parsedSession = { engineId: entry.session.engineId, resource: URI.parse(entry.session.resource) };
					} catch {
						parsedSession = undefined;
					}
				}
				parsed.push({
					id: entry.id,
					parentId: entry.parentId,
					projectUri: removeTrailingPathSeparator(URI.parse(entry.projectUri)),
					label: entry.label || entry.id,
					labelIsCustom: entry.labelIsCustom,
					role: entry.role,
					archived: entry.archived,
					unread: entry.unread,
					status: statusById?.get(entry.id) ?? 'idle',
					draft: entry.draft ?? '',
					session: parsedSession,
					treeType: entry.treeType,
					treeGovernorId: entry.treeGovernorId,
					treeSegmentId: entry.treeSegmentId,
					treeNodeId: entry.treeNodeId,
					preferredEngineId: entry.preferredEngineId,
					preferredModel: entry.preferredModel,
					preferredThinking: entry.preferredThinking,
					workingDirectoryOverride: entry.workingDirectoryOverride,
				});
			} catch {
				// Skip malformed persisted agent entry rather than aborting startup.
			}
		}
		return this.pruneOrphanedAgents(parsed);
	}

	private pruneOrphanedAgents(agents: readonly IAdeAgent[]): IAdeAgent[] {
		if (agents.length === 0) {
			return [];
		}
		const byId = new Map(agents.map(agent => [agent.id, agent]));
		const validIds = new Set<string>();
		for (const agent of agents) {
			if (!agent.parentId) {
				if (!agent.treeGovernorId || agent.treeGovernorId === agent.id || byId.has(agent.treeGovernorId)) {
					validIds.add(agent.id);
				}
				continue;
			}
			const visited = new Set<string>([agent.id]);
			let cursor = byId.get(agent.parentId);
			let reachesRoot = false;
			while (cursor && !visited.has(cursor.id)) {
				visited.add(cursor.id);
				if (!cursor.parentId) {
					reachesRoot = !cursor.treeGovernorId || cursor.treeGovernorId === cursor.id || byId.has(cursor.treeGovernorId);
					break;
				}
				cursor = byId.get(cursor.parentId);
			}
			if (reachesRoot && (!agent.treeGovernorId || byId.has(agent.treeGovernorId))) {
				validIds.add(agent.id);
			}
		}
		return agents.filter(agent => validIds.has(agent.id));
	}

	private mergeIntoCatalog(candidates: readonly { uri: URI; name?: string }[]): boolean {
		let changed = false;
		for (const candidate of candidates) {
			if (this.ensureCatalogProject(candidate.uri, candidate.name, false)) {
				changed = true;
			}
		}
		return changed;
	}

	private syncCatalogOrderWith(ordered: readonly { uri: URI }[]): boolean {
		const orderedKeys = ordered.map(folder => this.uriIdentityService.extUri.getComparisonKey(removeTrailingPathSeparator(folder.uri)));
		const orderedSet = new Set(orderedKeys);
		const catalogByKey = new Map(this.catalogProjects.map(project => [this.uriIdentityService.extUri.getComparisonKey(project.uri), project]));
		const reorderedSubset = orderedKeys.map(key => catalogByKey.get(key)).filter((project): project is IAdeProject => Boolean(project));
		let subIdx = 0;
		const nextCatalog = this.catalogProjects.map(project => {
			const key = this.uriIdentityService.extUri.getComparisonKey(project.uri);
			return orderedSet.has(key) && subIdx < reorderedSubset.length ? reorderedSubset[subIdx++] : project;
		});
		if (nextCatalog.every((project, idx) => project === this.catalogProjects[idx])) {
			return false;
		}
		this.catalogProjects = nextCatalog;
		return true;
	}

	private applyCatalogOrderToNavigation(): void {
		if (typeof this.projectNavigation.moveProjects !== 'function') {
			return;
		}
		const ordered = this.projectNavigation.orderedProjects;
		if (ordered.length < 2) {
			return;
		}
		const navKeys = new Set(ordered.map(folder => this.uriIdentityService.extUri.getComparisonKey(removeTrailingPathSeparator(folder.uri))));
		const targetOrder = this.catalogProjects.filter(project => navKeys.has(this.uriIdentityService.extUri.getComparisonKey(project.uri)));
		if (targetOrder.length < 2) {
			return;
		}
		const currentSubsetKeys = ordered
			.filter(folder => targetOrder.some(project => this.uriIdentityService.extUri.isEqual(folder.uri, project.uri)))
			.map(folder => this.uriIdentityService.extUri.getComparisonKey(removeTrailingPathSeparator(folder.uri)));
		const targetKeys = targetOrder.map(project => this.uriIdentityService.extUri.getComparisonKey(project.uri));
		if (currentSubsetKeys.length === targetKeys.length && currentSubsetKeys.every((key, idx) => key === targetKeys[idx])) {
			return;
		}
		this.suppressNavEvents = true;
		try {
			const currentFirst = this.projectNavigation.orderedProjects[0]?.uri;
			if (currentFirst && !this.uriIdentityService.extUri.isEqual(currentFirst, targetOrder[0].uri)) {
				this.projectNavigation.moveProjects([targetOrder[0].uri], currentFirst, false);
			}
			for (let idx = 1; idx < targetOrder.length; idx++) {
				this.projectNavigation.moveProjects([targetOrder[idx].uri], targetOrder[idx - 1].uri, true);
			}
		} finally {
			this.suppressNavEvents = false;
		}
	}

	private reloadFromExternalStorage(): void {
		const nextCatalog = this.loadStoredCatalogProjects();
		const nextAgents = this.loadStoredAgents(this.entries);
		for (const agent of nextAgents) {
			if (!agent.parentId) {
				const normalized = removeTrailingPathSeparator(agent.projectUri);
				if (!nextCatalog.some(project => this.uriIdentityService.extUri.isEqual(project.uri, normalized))) {
					nextCatalog.push({ uri: normalized, name: basename(normalized) });
				}
			}
		}

		const prevIds = new Set(this.entries.map(agent => agent.id));
		const nextIds = new Set(nextAgents.map(agent => agent.id));
		const removedAgents = this.entries.filter(agent => prevIds.has(agent.id) && !nextIds.has(agent.id));

		const catalogUnchanged = nextCatalog.length === this.catalogProjects.length
			&& nextCatalog.every((project, idx) => project.name === this.catalogProjects[idx].name && this.uriIdentityService.extUri.isEqual(project.uri, this.catalogProjects[idx].uri));
		const agentsUnchanged = nextAgents.length === this.entries.length
			&& nextAgents.every((agent, idx) => {
				const prev = this.entries[idx];
				return agent.id === prev.id
					&& agent.parentId === prev.parentId
					&& agent.label === prev.label
					&& agent.role === prev.role
					&& agent.archived === prev.archived
					&& agent.unread === prev.unread
					&& agent.draft === prev.draft
					&& this.uriIdentityService.extUri.isEqual(agent.projectUri, prev.projectUri)
					&& agent.session?.engineId === prev.session?.engineId
					&& agent.session?.resource.toString() === prev.session?.resource.toString()
					&& agent.treeType === prev.treeType
					&& agent.treeGovernorId === prev.treeGovernorId
					&& agent.treeSegmentId === prev.treeSegmentId
					&& agent.treeNodeId === prev.treeNodeId
					&& agent.preferredEngineId === prev.preferredEngineId
					&& agent.preferredModel === prev.preferredModel
					&& agent.preferredThinking === prev.preferredThinking
					&& agent.workingDirectoryOverride === prev.workingDirectoryOverride;
			});
		if (catalogUnchanged && agentsUnchanged) {
			return;
		}

		this.catalogProjects = nextCatalog;
		this.entries = nextAgents;
		if (this._selectedAgentId && !nextIds.has(this._selectedAgentId)) {
			this._selectedAgentId = undefined;
		}
		if (this.selectedProjectUri && !this.catalogProjects.some(project => this.uriIdentityService.extUri.isEqual(project.uri, this.selectedProjectUri))) {
			this.selectedProjectUri = undefined;
		}
		this.applyCatalogOrderToNavigation();
		if (removedAgents.length > 0) {
			this.removedAgentsEmitter.fire(removedAgents);
		}
		this.changeEmitter.fire();
	}

	private computeWorkspaceKeys(): string {
		return [...this.projectNavigation.orderedProjects]
			.map(folder => this.uriIdentityService.extUri.getComparisonKey(folder.uri))
			.sort()
			.join('\n');
	}

	private isWorkspaceFolder(uri: URI): boolean {
		return this.projectNavigation.orderedProjects.some(folder => this.uriIdentityService.extUri.isEqual(folder.uri, uri));
	}

	private ensureCatalogProject(uri: URI, name = basename(uri), persist = true): boolean {
		const normalized = removeTrailingPathSeparator(uri);
		if (this.catalogProjects.some(project => this.uriIdentityService.extUri.isEqual(project.uri, normalized))) {
			return false;
		}
		const wsFolder = this.projectNavigation.orderedProjects.find(folder => this.uriIdentityService.extUri.isEqual(folder.uri, normalized));
		this.catalogProjects.push({ uri: normalized, name: wsFolder?.name || name || basename(normalized) });
		if (persist) {
			this.saveProjects();
		}
		return true;
	}

	get projects(): readonly IAdeProject[] {
		const wsNames = new Map(
			this.projectNavigation.orderedProjects.map(folder => [
				this.uriIdentityService.extUri.getComparisonKey(removeTrailingPathSeparator(folder.uri)),
				folder.name,
			]),
		);
		const seen = new Set<string>();
		const result: IAdeProject[] = [];
		const pushProject = (uri: URI, name: string) => {
			const normalized = removeTrailingPathSeparator(uri);
			const key = this.uriIdentityService.extUri.getComparisonKey(normalized);
			if (!seen.has(key)) {
				seen.add(key);
				result.push({ uri: normalized, name: wsNames.get(key) || name });
			}
		};

		for (const project of this.catalogProjects) {
			pushProject(project.uri, project.name);
		}
		for (const agent of this.entries) {
			if (!agent.parentId) {
				pushProject(agent.projectUri, basename(agent.projectUri));
			}
		}
		return result;
	}

	get agents(): readonly IAdeAgent[] {
		return this.entries;
	}

	get selectedAgentId(): string | undefined {
		return this._selectedAgentId;
	}

	get selectedProject(): IAdeProject | undefined {
		if (this.projectNavigation.focusedProject) {
			return { uri: this.projectNavigation.focusedProject.uri, name: this.projectNavigation.focusedProject.name };
		}
		if (this.selectedProjectUri) {
			const match = this.projects.find(project => this.uriIdentityService.extUri.isEqual(project.uri, this.selectedProjectUri));
			if (match) {
				return match;
			}
		}
		if (this.projectNavigation.selectedProject) {
			return { uri: this.projectNavigation.selectedProject.uri, name: this.projectNavigation.selectedProject.name };
		}
		return undefined;
	}

	get secretary(): IAdeSecretary {
		return this._secretary;
	}

	get showArchived(): boolean {
		return this._showArchived;
	}

	getProjectName(projectUri: URI): string {
		const match = this.projects.find(project => this.uriIdentityService.extUri.isEqual(project.uri, projectUri));
		return match?.name ?? basename(projectUri);
	}

	registerProject(uri: URI, name = basename(uri)): IAdeProject {
		const normalized = removeTrailingPathSeparator(uri);
		const wsFolder = this.projectNavigation.orderedProjects.find(folder => this.uriIdentityService.extUri.isEqual(folder.uri, normalized));
		const nextName = name || wsFolder?.name || basename(normalized);
		const existing = this.catalogProjects.find(project => this.uriIdentityService.extUri.isEqual(project.uri, normalized));
		if (existing) {
			if (nextName && existing.name !== nextName) {
				this.catalogProjects = this.catalogProjects.map(project => project === existing ? { uri: normalized, name: nextName } : project);
				this.saveProjects();
				this.changeEmitter.fire();
			}
			return { uri: normalized, name: nextName || existing.name };
		}
		const added: IAdeProject = { uri: normalized, name: nextName };
		this.catalogProjects.push(added);
		this.saveProjects();
		this.changeEmitter.fire();
		return added;
	}

	migrateCloudHostAlias(oldAlias: string, newAlias: string): number {
		const prev = oldAlias.trim().toLowerCase();
		const next = newAlias.trim();
		if (!prev || !next || prev === next.toLowerCase()) {
			return 0;
		}
		let migratedProjects = 0;
		this.catalogProjects = this.catalogProjects.map(project => {
			if (project.uri.scheme === 'aexus-ssh' && project.uri.authority.toLowerCase() === prev) {
				migratedProjects++;
				return { ...project, uri: project.uri.with({ authority: next }) };
			}
			return project;
		});
		let migratedAgents = 0;
		this.entries = this.entries.map(agent => {
			if (agent.projectUri.scheme === 'aexus-ssh' && agent.projectUri.authority.toLowerCase() === prev) {
				migratedAgents++;
				return { ...agent, projectUri: agent.projectUri.with({ authority: next }) };
			}
			return agent;
		});
		if (migratedProjects > 0) {
			this.saveProjects();
		}
		if (migratedAgents > 0) {
			this.saveAgents();
		}
		if (migratedProjects > 0 || migratedAgents > 0) {
			this.changeEmitter.fire();
		}
		return migratedProjects;
	}

	unregisterProject(uri: URI): void {
		this.removeProject(uri);
	}

	removeProject(uri: URI): readonly IAdeAgent[] {
		const { removedAgents } = this.doRemoveProject(uri, true);
		if (removedAgents.length > 0) {
			this.removedAgentsEmitter.fire(removedAgents);
		}
		this.changeEmitter.fire();
		return removedAgents;
	}

	private doRemoveProject(uri: URI, persistProjects = true): { removedAgents: IAdeAgent[]; projectsChanged: boolean } {
		const normalized = removeTrailingPathSeparator(uri);
		let projectsChanged = false;

		const removedAgents = this.entries.filter(agent => this.uriIdentityService.extUri.isEqual(agent.projectUri, normalized));
		if (removedAgents.length > 0) {
			const removedIds = new Set(removedAgents.map(agent => agent.id));
			this.entries = this.entries.filter(agent => !removedIds.has(agent.id));
			if (this._selectedAgentId && removedIds.has(this._selectedAgentId)) {
				this._selectedAgentId = undefined;
				this.storageService.remove('aexus.ade.selectedProjectId', StorageScope.PROFILE);
			}
			this.saveAgents();
		}

		const beforeProjects = this.catalogProjects.length;
		this.catalogProjects = this.catalogProjects.filter(project => !this.uriIdentityService.extUri.isEqual(project.uri, normalized));
		if (this.catalogProjects.length !== beforeProjects) {
			projectsChanged = true;
			if (persistProjects) {
				this.saveProjects();
			}
		}

		if (this.selectedProjectUri && this.uriIdentityService.extUri.isEqual(this.selectedProjectUri, normalized)) {
			this.selectedProjectUri = undefined;
			this.persistSelectedProject();
		}

		return { removedAgents, projectsChanged };
	}

	moveProjectFolder(sourceUri: URI, targetUri: URI | undefined, after: boolean): void {
		const normalizedSource = removeTrailingPathSeparator(sourceUri);
		const normalizedTarget = targetUri ? removeTrailingPathSeparator(targetUri) : undefined;
		if (normalizedTarget && this.uriIdentityService.extUri.isEqual(normalizedSource, normalizedTarget)) {
			return;
		}

		let moved = false;
		const sourceCatalog = this.catalogProjects.find(project => this.uriIdentityService.extUri.isEqual(project.uri, normalizedSource));
		if (sourceCatalog && (!normalizedTarget || this.catalogProjects.some(project => this.uriIdentityService.extUri.isEqual(project.uri, normalizedTarget)))) {
			const remaining = this.catalogProjects.filter(project => project !== sourceCatalog);
			const index = normalizedTarget
				? remaining.findIndex(project => this.uriIdentityService.extUri.isEqual(project.uri, normalizedTarget)) + Number(after)
				: remaining.length;
			remaining.splice(index, 0, sourceCatalog);
			if (!remaining.every((project, idx) => project === this.catalogProjects[idx])) {
				this.catalogProjects = remaining;
				this.saveProjects();
				moved = true;
			}
		}

		if (this.isWorkspaceFolder(normalizedSource) && (!normalizedTarget || this.isWorkspaceFolder(normalizedTarget))) {
			const beforeOrder = this.projectNavigation.orderedProjects.map(folder => folder.uri.toString()).join('\n');
			this.suppressNavEvents = true;
			try {
				this.projectNavigation.moveProjects([normalizedSource], normalizedTarget, after);
			} finally {
				this.suppressNavEvents = false;
			}
			const afterOrder = this.projectNavigation.orderedProjects.map(folder => folder.uri.toString()).join('\n');
			if (beforeOrder !== afterOrder) {
				moved = true;
			}
		}

		if (moved) {
			this.changeEmitter.fire('order');
		}
	}

	selectProject(resource: URI): void {
		if (this.projectNavigation.focusedProject) {
			return;
		}
		const target = this.projects
			.filter(project => this.uriIdentityService.extUri.isEqualOrParent(resource, project.uri))
			.sort((a, b) => b.uri.path.length - a.uri.path.length)[0];

		const nextUri = target?.uri;
		const changed = Boolean(nextUri && !this.uriIdentityService.extUri.isEqual(this.selectedProjectUri, nextUri));
		if (nextUri) {
			this.selectedProjectUri = nextUri;
			this.persistSelectedProject();
		}

		this.suppressNavEvents = true;
		try {
			this.projectNavigation.selectProject(nextUri ?? resource);
		} finally {
			this.suppressNavEvents = false;
		}

		if (changed) {
			this.changeEmitter.fire('selection');
		}
	}

	selectAgent(id: string): void {
		const agent = this.getAgent(id);
		if (!agent) {
			return;
		}
		this._selectedAgentId = agent.id;
		this.storageService.store('aexus.ade.selectedProjectId', agent.id, StorageScope.PROFILE, StorageTarget.MACHINE);
		this.selectProject(agent.projectUri);
	}

	getAgent(id: string): IAdeAgent | undefined {
		return this.entries.find(agent => agent.id === id);
	}

	getRootAgent(id: string): IAdeAgent | undefined {
		const visited = new Set<string>();
		let current = this.getAgent(id);
		while (current?.parentId && !visited.has(current.id)) {
			visited.add(current.id);
			const parent = this.getAgent(current.parentId);
			if (!parent) {
				break;
			}
			current = parent;
		}
		return current;
	}

	getDirectSubordinates(id: string): readonly IAdeAgent[] {
		return this.entries.filter(agent => agent.parentId === id);
	}

	getSubtree(id: string): readonly IAdeAgent[] {
		const root = this.getAgent(id);
		if (!root) {
			return [];
		}
		const ids = new Set<string>([id]);
		let added = true;
		while (added) {
			added = false;
			for (const entry of this.entries) {
				if (ids.has(entry.id)) {
					continue;
				}
				const byParent = Boolean(entry.parentId && ids.has(entry.parentId));
				const byWorkTreeGov = Boolean(entry.treeGovernorId && entry.treeGovernorId !== entry.id && ids.has(entry.treeGovernorId));
				if (byParent || byWorkTreeGov) {
					ids.add(entry.id);
					added = true;
				}
			}
		}
		return this.entries.filter(entry => ids.has(entry.id));
	}

	getAgentTree(id: string): IAdeAgentTreeNode | undefined {
		const root = this.getAgent(id);
		if (!root) {
			return undefined;
		}
		const visited = new Set<string>();
		const build = (node: IAdeAgent): IAdeAgentTreeNode => {
			visited.add(node.id);
			const children = this.getDirectSubordinates(node.id)
				.filter(child => !visited.has(child.id))
				.map(child => build(child));
			return { agent: node, children };
		};
		return build(root);
	}

	hasSubordinates(id: string): boolean {
		return this.entries.some(agent => agent.parentId === id);
	}

	private getRoleSchema(): IAdeOrganizationConfig {
		const raw = readTrustedApplicationConfigValue<unknown>(this.configurationService, ADE_ORGANIZATION_CONFIG_KEY);
		return raw ? normalizeAdeOrganizationConfig(raw) : DEFAULT_ADE_ORGANIZATION_CONFIG;
	}

	isOrchestrated(agentOrId: IAdeAgent | string): boolean {
		const agent = typeof agentOrId === 'string' ? this.getAgent(agentOrId) : agentOrId;
		if (!agent) {
			return false;
		}
		if (this.hasSubordinates(agent.id)) {
			return true;
		}
		if (!agent.role) {
			return false;
		}
		return !isPureExecutionRank(this.getRoleSchema(), agent.role);
	}

	isArchived(id: string): boolean {
		const visited = new Set<string>();
		let current = this.getAgent(id);
		while (current && !visited.has(current.id)) {
			if (current.archived) {
				return true;
			}
			visited.add(current.id);
			current = current.parentId ? this.getAgent(current.parentId) : undefined;
		}
		return false;
	}

	getWorkTreeGovernor(id: string): IAdeAgent | undefined {
		const agent = this.getAgent(id);
		if (!agent) {
			return undefined;
		}
		if (agent.treeGovernorId) {
			const explicit = this.getAgent(agent.treeGovernorId);
			if (explicit?.treeType) {
				return explicit;
			}
		}
		const visited = new Set<string>();
		let cursor: IAdeAgent | undefined = agent;
		while (cursor && !visited.has(cursor.id)) {
			visited.add(cursor.id);
			if (cursor.treeType) {
				return cursor;
			}
			cursor = cursor.parentId ? this.getAgent(cursor.parentId) : undefined;
		}
		return undefined;
	}

	isLockedByWorkTree(id: string): boolean {
		const agent = this.getAgent(id);
		if (!agent || !agent.treeGovernorId || agent.treeGovernorId === agent.id) {
			return false;
		}
		if (agent.treeType === 'mission' && agent.treeNodeId) {
			return true;
		}
		const owner = this.getAgent(agent.treeGovernorId);
		return Boolean(owner?.treeType && (agent.treeNodeId || agent.treeSegmentId));
	}

	setAgentWorkTreeTag(governorId: string, treeType: AdeWorkTreeType | undefined): void {
		const owner = this.getAgent(governorId);
		if (!owner) {
			return;
		}
		this.entries = this.entries.map(agent => agent.id === governorId
			? {
				...agent,
				treeType,
				treeGovernorId: treeType ? governorId : undefined,
			}
			: agent);
		this.saveAgents();
		this.changeEmitter.fire();
	}

	syncMissionMermaidEmployees(
		ownerOrMissionId: string,
		nodes: readonly { readonly id: string; readonly title: string }[],
		options?: { readonly projectUri?: URI; readonly ownerTier?: number },
	): { readonly employeeAgentsByNode: Readonly<Record<string, IAdeAgent>>; readonly removedAgents: readonly IAdeAgent[] } {
		const ownerAgent = this.getAgent(ownerOrMissionId);
		const targetProjectUri = ownerAgent?.projectUri
			?? (options?.projectUri ? removeTrailingPathSeparator(options.projectUri) : undefined);
		if (!targetProjectUri) {
			return { employeeAgentsByNode: {}, removedAgents: [] };
		}

		const schema = this.getRoleSchema();
		const defaultLeaf = getDefaultPureLeafRank(schema);
		let employeeRole: AdeAgentRole | undefined;
		if (ownerAgent) {
			const ownerDef = resolveEffectiveRankDefinition(schema, ownerAgent.role, true);
			const nextTier = schema.ranks.find(r => r.tier > ownerDef.tier) ?? ownerDef;
			const isDefaultPure = Boolean(nextTier.pureExecution && nextTier.id === defaultLeaf.id);
			employeeRole = isDefaultPure ? undefined : nextTier.id;
		} else {
			const topRank = getTopRankDefinition(schema);
			const isDefaultPure = Boolean(topRank.pureExecution && topRank.id === defaultLeaf.id);
			employeeRole = isDefaultPure ? undefined : topRank.id;
		}

		const existingGenerated = this.entries.filter(entry =>
			entry.treeGovernorId === ownerOrMissionId
			&& entry.id !== ownerOrMissionId
			&& Boolean(entry.treeNodeId),
		);
		const existingByNodeId = new Map<string, IAdeAgent>();
		for (const entry of existingGenerated) {
			if (entry.treeNodeId) {
				existingByNodeId.set(entry.treeNodeId, entry);
			}
		}

		const keptIds = new Set<string>();
		const nextGenerated: IAdeAgent[] = [];
		const employeeAgentsByNode: Record<string, IAdeAgent> = {};
		const inheritedEngineId = ownerAgent?.session?.engineId ?? ownerAgent?.preferredEngineId;

		for (const node of nodes) {
			const prev = existingByNodeId.get(node.id);
			const defaultLabel = `[${node.id}] ${node.title}`;
			const nextAgent: IAdeAgent = prev
				? {
					...prev,
					parentId: ownerAgent?.id,
					projectUri: targetProjectUri,
					label: prev.labelIsCustom ? prev.label : defaultLabel,
					role: employeeRole,
					archived: undefined,
					treeType: 'mission',
					treeGovernorId: ownerOrMissionId,
					treeNodeId: node.id,
				}
				: {
					id: generateUuid(),
					parentId: ownerAgent?.id,
					projectUri: targetProjectUri,
					label: defaultLabel,
					role: employeeRole,
					status: 'idle',
					draft: '',
					preferredEngineId: inheritedEngineId,
					treeType: 'mission',
					treeGovernorId: ownerOrMissionId,
					treeNodeId: node.id,
				};
			keptIds.add(nextAgent.id);
			nextGenerated.push(nextAgent);
			employeeAgentsByNode[node.id] = nextAgent;
		}

		const oldGeneratedIds = new Set(existingGenerated.map(a => a.id));
		const removedAgents = existingGenerated.filter(a => !keptIds.has(a.id));

		const nextEntries: IAdeAgent[] = [];
		let inserted = false;
		for (const entry of this.entries) {
			if (ownerAgent && entry.id === ownerAgent.id) {
				nextEntries.push({
					...entry,
					treeType: 'mission',
					treeGovernorId: ownerAgent.id,
				});
				nextEntries.push(...nextGenerated);
				inserted = true;
			} else if (oldGeneratedIds.has(entry.id)) {
				continue;
			} else {
				nextEntries.push(entry);
			}
		}
		if (!inserted && nextGenerated.length > 0) {
			this.ensureCatalogProject(targetProjectUri, basename(targetProjectUri));
			nextEntries.push(...nextGenerated);
		}

		this.entries = nextEntries;
		if (this._selectedAgentId && removedAgents.some(a => a.id === this._selectedAgentId)) {
			this._selectedAgentId = ownerAgent?.id;
		}
		this.saveAgents();
		if (removedAgents.length > 0) {
			this.removedAgentsEmitter.fire(removedAgents);
		}
		this.changeEmitter.fire();
		return { employeeAgentsByNode, removedAgents };
	}

	clearMissionEmployees(ownerOrMissionId: string): readonly IAdeAgent[] {
		const generatedRoots = this.entries.filter(entry =>
			entry.treeGovernorId === ownerOrMissionId
			&& entry.id !== ownerOrMissionId
			&& Boolean(entry.treeNodeId),
		);
		const removedIdSet = new Set<string>();
		for (const gen of generatedRoots) {
			for (const member of this.getSubtree(gen.id)) {
				removedIdSet.add(member.id);
			}
		}
		const removedAgents = this.entries.filter(entry => removedIdSet.has(entry.id));
		const ownerExists = this.entries.some(entry => entry.id === ownerOrMissionId && Boolean(entry.treeType));

		if (removedAgents.length === 0 && !ownerExists) {
			return [];
		}

		this.entries = this.entries
			.filter(entry => !removedIdSet.has(entry.id))
			.map(entry => entry.id === ownerOrMissionId
				? {
					...entry,
					treeType: undefined,
					treeGovernorId: undefined,
					treeSegmentId: undefined,
					treeNodeId: undefined,
				}
				: entry);

		if (this._selectedAgentId && removedIdSet.has(this._selectedAgentId)) {
			this._selectedAgentId = this.getAgent(ownerOrMissionId)?.id;
		}
		this.saveAgents();
		if (removedAgents.length > 0) {
			this.removedAgentsEmitter.fire(removedAgents);
		}
		this.changeEmitter.fire();
		return removedAgents;
	}

	updateAgentEnginePreferences(id: string, prefs: {
		readonly preferredEngineId?: string;
		readonly preferredModel?: string;
		readonly preferredThinking?: AdeThinkingLevel;
		readonly workingDirectoryOverride?: string;
	}): void {
		const current = this.getAgent(id);
		if (!current) {
			return;
		}
		this.entries = this.entries.map(agent => agent.id === id ? {
			...agent,
			...(Object.hasOwn(prefs, 'preferredEngineId') ? { preferredEngineId: prefs.preferredEngineId } : {}),
			...(Object.hasOwn(prefs, 'preferredModel') ? { preferredModel: prefs.preferredModel } : {}),
			...(Object.hasOwn(prefs, 'preferredThinking') ? { preferredThinking: prefs.preferredThinking } : {}),
			...(Object.hasOwn(prefs, 'workingDirectoryOverride') ? { workingDirectoryOverride: prefs.workingDirectoryOverride } : {}),
		} : agent);
		this.saveAgents();
		this.changeEmitter.fire();
	}

	syncWorkTreeHierarchy(
		governorId: string,
		treeType: AdeWorkTreeType,
		segments: readonly IAdeWorkTreeSegmentSpec[],
	): IAdeWorkTreeSyncResult {
		const gov = this.getAgent(governorId);
		if (!gov || gov.parentId) {
			throw new Error(localize('adeWorkTreeGovernorMissing', "Engineering Governor session '{0}' does not exist or is not a top-level session.", governorId));
		}

		const schema = this.getRoleSchema();
		const orchestratorRank = resolveWorkTreeSlotRank(schema, 'orchestrator');
		const segmentOwnerRank = resolveWorkTreeSlotRank(schema, 'segment_owner');
		const reviewerRank = resolveWorkTreeSlotRank(schema, 'reviewer');
		const executorRank = resolveWorkTreeSlotRank(schema, 'executor');
		const defaultLeaf = getDefaultPureLeafRank(schema);
		const executorRole: AdeAgentRole | undefined = executorRank.pureExecution && executorRank.id === defaultLeaf.id
			? undefined
			: executorRank.id;

		const existingSubtree = this.getSubtree(governorId).slice(1);
		const existingById = new Map(existingSubtree.map(a => [a.id, a]));
		const existingManagersBySeg = new Map<string, IAdeAgent>();
		const existingEmployeesByNode = new Map<string, IAdeAgent>();
		const existingWorkersByNode = new Map<string, IAdeAgent>();

		for (const item of existingSubtree) {
			if (item.treeSegmentId && !item.treeNodeId) {
				existingManagersBySeg.set(item.treeSegmentId, item);
			} else if (item.treeNodeId) {
				const parent = item.parentId ? existingById.get(item.parentId) : undefined;
				const isExecutor = !item.role || (parent !== undefined && parent.treeNodeId === item.treeNodeId);
				if (isExecutor) {
					existingWorkersByNode.set(item.treeNodeId, item);
				} else {
					existingEmployeesByNode.set(item.treeNodeId, item);
				}
			}
		}

		const keptIds = new Set<string>([governorId]);
		const newSubtreeEntries: IAdeAgent[] = [];
		const managerAgentsBySegment: Record<string, string> = {};
		const employeeAgentsByNode: Record<string, string> = {};
		const workerAgentsByNode: Record<string, string> = {};

		for (const seg of segments) {
			const prevMgr = (seg.existingManagerAgentId ? existingById.get(seg.existingManagerAgentId) : undefined)
				?? existingManagersBySeg.get(seg.segmentId);
			const mgrId = prevMgr?.id ?? generateUuid();
			keptIds.add(mgrId);
			managerAgentsBySegment[seg.segmentId] = mgrId;

			const mgrSessionMatchesEngine = prevMgr?.session?.engineId === seg.managerEngineId;
			newSubtreeEntries.push({
				id: mgrId,
				parentId: governorId,
				projectUri: gov.projectUri,
				label: seg.label,
				labelIsCustom: true,
				role: segmentOwnerRank.id,
				archived: undefined,
				unread: prevMgr?.unread,
				status: prevMgr?.status ?? 'idle',
				draft: prevMgr?.draft ?? '',
				session: mgrSessionMatchesEngine ? prevMgr?.session : undefined,
				treeType,
				treeGovernorId: governorId,
				treeSegmentId: seg.segmentId,
				preferredEngineId: seg.managerEngineId,
				preferredModel: seg.managerModel,
				preferredThinking: seg.managerThinking,
				workingDirectoryOverride: seg.workingDirectoryOverride,
			});

			for (const task of seg.tasks) {
				const prevEmp = (task.existingEmployeeAgentId ? existingById.get(task.existingEmployeeAgentId) : undefined)
					?? existingEmployeesByNode.get(task.nodeId);
				const empId = prevEmp?.id ?? generateUuid();
				keptIds.add(empId);
				employeeAgentsByNode[task.nodeId] = empId;

				const empSessionMatches = prevEmp?.session?.engineId === task.employeeEngineId;
				newSubtreeEntries.push({
					id: empId,
					parentId: mgrId,
					projectUri: gov.projectUri,
					label: `[${task.nodeId}] ${task.title}`,
					labelIsCustom: true,
					role: reviewerRank.id,
					archived: undefined,
					unread: prevEmp?.unread,
					status: prevEmp?.status ?? 'idle',
					draft: prevEmp?.draft ?? '',
					session: empSessionMatches ? prevEmp?.session : undefined,
					treeType,
					treeGovernorId: governorId,
					treeSegmentId: seg.segmentId,
					treeNodeId: task.nodeId,
					preferredEngineId: task.employeeEngineId,
					preferredModel: task.employeeModel,
					preferredThinking: task.employeeThinking,
					workingDirectoryOverride: task.workingDirectoryOverride ?? seg.workingDirectoryOverride,
				});

				const prevWrk = (task.existingWorkerAgentId ? existingById.get(task.existingWorkerAgentId) : undefined)
					?? existingWorkersByNode.get(task.nodeId);
				const wrkId = prevWrk?.id ?? generateUuid();
				keptIds.add(wrkId);
				workerAgentsByNode[task.nodeId] = wrkId;

				const wrkSessionMatches = prevWrk?.session?.engineId === task.workerEngineId;
				newSubtreeEntries.push({
					id: wrkId,
					parentId: empId,
					projectUri: gov.projectUri,
					label: `${task.title} · ${executorRank.name}`,
					labelIsCustom: true,
					role: executorRole,
					archived: undefined,
					unread: prevWrk?.unread,
					status: prevWrk?.status ?? 'idle',
					draft: prevWrk?.draft ?? '',
					session: wrkSessionMatches ? prevWrk?.session : undefined,
					treeType,
					treeGovernorId: governorId,
					treeSegmentId: seg.segmentId,
					treeNodeId: task.nodeId,
					preferredEngineId: task.workerEngineId,
					preferredModel: task.workerModel,
					preferredThinking: task.workerThinking,
					workingDirectoryOverride: task.workingDirectoryOverride ?? seg.workingDirectoryOverride,
				});
			}
		}

		const oldSubtreeIds = new Set(existingSubtree.map(a => a.id));
		const removedAgents = existingSubtree.filter(a => !keptIds.has(a.id));

		const nextEntries: IAdeAgent[] = [];
		for (const entry of this.entries) {
			if (entry.id === governorId) {
				nextEntries.push({
					...entry,
					role: orchestratorRank.id,
					treeType,
					treeGovernorId: governorId,
				});
				nextEntries.push(...newSubtreeEntries);
			} else if (oldSubtreeIds.has(entry.id)) {
				continue;
			} else {
				nextEntries.push(entry);
			}
		}

		this.entries = nextEntries;
		if (this._selectedAgentId && removedAgents.some(a => a.id === this._selectedAgentId)) {
			this._selectedAgentId = governorId;
		}
		this.saveAgents();
		if (removedAgents.length > 0) {
			this.removedAgentsEmitter.fire(removedAgents);
		}
		this.changeEmitter.fire();

		return {
			managerAgentsBySegment,
			employeeAgentsByNode,
			workerAgentsByNode,
			removedAgents,
		};
	}

	addProject(uri: URI, label = basename(uri)): IAdeAgent {
		const normalized = removeTrailingPathSeparator(uri);
		const addedCatalog = this.ensureCatalogProject(normalized, label);
		const existing = this.entries.find(agent => !agent.parentId && !agent.session && this.uriIdentityService.extUri.isEqual(agent.projectUri, normalized));
		if (existing) {
			if (addedCatalog) {
				this.changeEmitter.fire();
			}
			return existing;
		}
		return this.add({ id: generateUuid(), projectUri: normalized, label, draft: '', status: 'idle' });
	}

	addAgent(parentId: string, label: string, role?: AdeAgentRole): IAdeAgent {
		const parent = this.getAgent(parentId);
		if (!parent) {
			throw new Error(localize('agentParentMissing', "The parent Agent no longer exists."));
		}
		return this.add({ id: generateUuid(), parentId, projectUri: parent.projectUri, label, role, draft: '', status: 'idle' });
	}

	addSession(projectUri: URI, session: IAdeSession, label: string, optionsOrParentId?: string | IAdeAddSessionOptions): IAdeAgent {
		const normalized = removeTrailingPathSeparator(projectUri);
		const addedCatalog = this.ensureCatalogProject(normalized, basename(normalized));
		const options: IAdeAddSessionOptions = typeof optionsOrParentId === 'string'
			? { parentId: optionsOrParentId }
			: (optionsOrParentId ?? {});

		const existing = this.entries.find(agent => agent.session?.engineId === session.engineId && agent.session.resource.toString() === session.resource.toString());
		if (existing) {
			if (options.role && existing.role !== options.role) {
				this.setAgentRole(existing.id, options.role);
				return this.getAgent(existing.id)!;
			}
			if (addedCatalog) {
				this.changeEmitter.fire();
			}
			return existing;
		}
		return this.add({
			id: generateUuid(),
			projectUri: normalized,
			session: { engineId: session.engineId, resource: session.resource },
			label,
			labelIsCustom: options.labelIsCustom ?? false,
			parentId: options.parentId,
			role: options.role,
			status: 'idle',
			draft: '',
		});
	}

	private add(agent: IAdeAgent): IAdeAgent {
		this.entries.push(agent);
		this.saveAgents();
		this.changeEmitter.fire();
		return agent;
	}

	bindSession(id: string, session: IAdeSession): void {
		this.entries = this.entries.map(agent => agent.id === id ? { ...agent, session: { engineId: session.engineId, resource: session.resource } } : agent);
		this.saveAgents();
		this.changeEmitter.fire();
	}

	moveProject(id: string, targetId: string | undefined, after: boolean): void {
		const roots = this.entries.filter(agent => !agent.parentId);
		const source = roots.find(agent => agent.id === id);
		const target = targetId ? roots.find(agent => agent.id === targetId) : undefined;
		if (!source || id === targetId || (targetId && !target)) {
			return;
		}
		const reordered = roots.filter(agent => agent !== source);
		const index = target ? reordered.findIndex(agent => agent.id === target.id) + Number(after) : reordered.length;
		reordered.splice(index, 0, source);
		if (reordered.every((agent, idx) => agent === roots[idx])) {
			return;
		}
		this.entries = [...reordered, ...this.entries.filter(agent => agent.parentId)];
		this.saveAgents();

		// Synchronize catalog and workspace folder order without double-emitting 'order'
		if (!target || !this.uriIdentityService.extUri.isEqual(source.projectUri, target.projectUri)) {
			const sourceCatalog = this.catalogProjects.find(project => this.uriIdentityService.extUri.isEqual(project.uri, source.projectUri));
			if (sourceCatalog) {
				const remaining = this.catalogProjects.filter(project => project !== sourceCatalog);
				const catalogIdx = target
					? remaining.findIndex(project => this.uriIdentityService.extUri.isEqual(project.uri, target.projectUri)) + Number(after)
					: remaining.length;
				if (catalogIdx >= 0) {
					remaining.splice(catalogIdx, 0, sourceCatalog);
					if (!remaining.every((project, idx) => project === this.catalogProjects[idx])) {
						this.catalogProjects = remaining;
						this.saveProjects();
					}
				}
			}
			if (this.isWorkspaceFolder(source.projectUri) && (!target || this.isWorkspaceFolder(target.projectUri))) {
				this.suppressNavEvents = true;
				try {
					this.projectNavigation.moveProjects([source.projectUri], target?.projectUri, after);
				} finally {
					this.suppressNavEvents = false;
				}
			}
		}

		this.changeEmitter.fire('order');
	}

	canReparentAgent(id: string, newParentId: string | undefined, targetProjectUri?: URI): boolean {
		const agent = this.getAgent(id);
		if (!agent || id === newParentId) {
			return false;
		}
		if (this.isLockedByWorkTree(id)) {
			return false;
		}
		if (newParentId !== undefined && this.isLockedByWorkTree(newParentId)) {
			return false;
		}
		if (newParentId === undefined) {
			const nextProj = targetProjectUri ? removeTrailingPathSeparator(targetProjectUri) : agent.projectUri;
			return Boolean(agent.parentId) || !this.uriIdentityService.extUri.isEqual(agent.projectUri, nextProj);
		}
		if (agent.parentId === newParentId) {
			return false;
		}
		const newParent = this.getAgent(newParentId);
		if (!newParent) {
			return false;
		}
		if (this.getSubtree(id).some(member => member.id === newParentId)) {
			return false;
		}
		const schema = this.getRoleSchema();
		const parentDef = resolveEffectiveRankDefinition(schema, newParent.role, this.hasSubordinates(newParent.id));
		if (parentDef.pureExecution || !parentDef.canHaveSubordinates) {
			return false;
		}
		const parentRank = getAdeRoleRankLevel(newParent.role, this.hasSubordinates(newParent.id), schema);
		if (parentRank === 0) {
			return false;
		}
		return true;
	}

	reparentAgent(id: string, newParentId: string | undefined, targetProjectUri?: URI): boolean {
		if (!this.canReparentAgent(id, newParentId, targetProjectUri)) {
			return false;
		}
		const schema = this.getRoleSchema();
		const topRankId = getTopRankDefinition(schema).id;
		const agent = this.getAgent(id)!;
		const subtree = this.getSubtree(id);
		const subtreeIds = new Set(subtree.map(member => member.id));
		if (newParentId !== undefined) {
			const newParent = this.getAgent(newParentId)!;
			const roleUpdates = new Map<string, AdeAgentRole | undefined>();
			if (!newParent.parentId && !newParent.role) {
				roleUpdates.set(newParent.id, topRankId);
			}
			const queue: string[] = [id];
			const seen = new Set<string>();
			while (queue.length > 0) {
				const currId = queue.shift()!;
				if (seen.has(currId)) {
					continue;
				}
				seen.add(currId);
				const curr = this.getAgent(currId);
				if (!curr) {
					continue;
				}
				const effParent = currId === id ? newParent : this.getAgent(curr.parentId!);
				const pRole = effParent && roleUpdates.has(effParent.id) ? roleUpdates.get(effParent.id) : effParent?.role;
				const pLevel = effParent ? getAdeRoleRankLevel(pRole, true, schema) : getAdeRoleRankLevel(topRankId, true, schema);
				const currHasSubs = this.hasSubordinates(curr.id);
				if (!curr.role && !currHasSubs) {
					roleUpdates.set(curr.id, undefined);
				} else {
					const currLevel = getAdeRoleRankLevel(curr.role, currHasSubs, schema);
					if (currLevel >= pLevel) {
						const nextLower = getNextLowerRankFromConfig(schema, pRole, true);
						roleUpdates.set(curr.id, nextLower.childRole);
					} else {
						roleUpdates.set(curr.id, curr.role ?? topRankId);
					}
				}
				for (const child of this.getDirectSubordinates(curr.id)) {
					queue.push(child.id);
				}
			}
			this.entries = this.entries.map(entry => {
				if (entry.id === id) {
					return { ...entry, parentId: newParentId, role: roleUpdates.get(entry.id), projectUri: newParent.projectUri, archived: undefined };
				}
				if (subtreeIds.has(entry.id)) {
					return { ...entry, role: roleUpdates.get(entry.id), projectUri: newParent.projectUri, archived: undefined };
				}
				if (roleUpdates.has(entry.id)) {
					return { ...entry, role: roleUpdates.get(entry.id) };
				}
				return entry;
			});
		} else {
			const nextProj = targetProjectUri ? removeTrailingPathSeparator(targetProjectUri) : agent.projectUri;
			this.ensureCatalogProject(nextProj, basename(nextProj));
			this.entries = this.entries.map(entry => {
				if (entry.id === id) {
					return { ...entry, parentId: undefined, projectUri: nextProj };
				}
				if (subtreeIds.has(entry.id)) {
					return { ...entry, projectUri: nextProj };
				}
				return entry;
			});
		}
		this.saveAgents();
		this.changeEmitter.fire();
		return true;
	}

	renameAgent(id: string, label: string): void {
		const trimmed = label.trim();
		if (!trimmed) {
			return;
		}
		this.entries = this.entries.map(agent => agent.id === id ? { ...agent, label: trimmed, labelIsCustom: true } : agent);
		this.saveAgents();
		this.changeEmitter.fire();
	}

	setAgentRole(id: string, role: AdeAgentRole | undefined): void {
		const current = this.getAgent(id);
		if (!current || current.role === role || this.isLockedByWorkTree(id)) {
			return;
		}
		this.entries = this.entries.map(agent => agent.id === id ? { ...agent, role } : agent);
		this.saveAgents();
		this.changeEmitter.fire();
	}

	/**
	 * Migrates all live sessions carrying `oldRankId` to `newRankId` (including work-tree sessions)
	 * when an organizational rank slug ID is renamed in Organization & Roles Studio.
	 */
	migrateRankId(oldRankId: string, newRankId: string): number {
		const prev = oldRankId.trim().toLowerCase();
		const next = newRankId.trim();
		if (!prev || !next || prev === next.toLowerCase()) {
			return 0;
		}
		let migrated = 0;
		this.entries = this.entries.map(agent => {
			if (agent.role && agent.role.trim().toLowerCase() === prev) {
				migrated++;
				return { ...agent, role: next };
			}
			return agent;
		});
		if (migrated > 0) {
			this.saveAgents();
			this.changeEmitter.fire();
		}
		return migrated;
	}

	setArchived(id: string, archived: boolean): void {
		const root = this.getRootAgent(id);
		if (!root || Boolean(root.archived) === archived) {
			return;
		}
		const subtreeIds = new Set(this.getSubtree(root.id).map(item => item.id));
		this.entries = this.entries.map(agent => {
			if (agent.id === root.id) {
				return { ...agent, archived: archived || undefined, unread: archived ? false : agent.unread };
			}
			if (archived && subtreeIds.has(agent.id) && agent.unread) {
				return { ...agent, unread: false };
			}
			return agent;
		});
		this.saveAgents();
		this.changeEmitter.fire();
	}

	markRead(id: string): void {
		const current = this.getAgent(id);
		if (!current?.unread) {
			return;
		}
		this.entries = this.entries.map(agent => agent.id === id ? { ...agent, unread: false } : agent);
		this.saveAgents();
		this.changeEmitter.fire();
	}

	setAgentStatus(id: string, status: AdeAgentStatus, unread?: boolean): void {
		const current = this.getAgent(id);
		if (!current) {
			return;
		}
		const nextUnread = unread !== undefined ? unread : current.unread;
		if ((current.status ?? 'idle') === status && Boolean(current.unread) === Boolean(nextUnread)) {
			return;
		}
		this.entries = this.entries.map(agent => agent.id === id ? { ...agent, status, unread: nextUnread || undefined } : agent);
		this.saveAgents();
		this.changeEmitter.fire();
	}

	updateSessionLabel(resource: URI, label: string): void {
		this.syncSessionItem(resource, { label });
	}

	syncSessionItem(resource: URI, update: { readonly label?: string; readonly status?: AdeAgentStatus }, isActiveInEditor = false): void {
		let changed = false;
		const key = resource.toString();

		if ((this._secretary.session?.resource.toString() === key || resource.scheme === 'aexus-secretary') && update.status) {
			const nextStatus: 'idle' | 'working' = update.status === 'working' ? 'working' : 'idle';
			const completedInBackground = this._secretary.status === 'working' && nextStatus === 'idle' && !isActiveInEditor;
			const nextUnread = isActiveInEditor ? false : (completedInBackground ? true : this._secretary.unread);
			if (this._secretary.status !== nextStatus || Boolean(this._secretary.unread) !== Boolean(nextUnread)) {
				this._secretary = { ...this._secretary, status: nextStatus, unread: nextUnread || undefined };
				this.saveSecretary();
				changed = true;
			}
		}

		const agent = this.entries.find(item => item.session?.resource.toString() === key);
		if (agent) {
			const nextLabel = agent.labelIsCustom === false && update.label && update.label !== agent.label ? update.label : agent.label;
			const prevStatus = agent.status ?? 'idle';
			const nextStatus = update.status ?? prevStatus;
			const needsAttention = !isActiveInEditor && ((prevStatus === 'working' && nextStatus === 'idle') || nextStatus === 'pending');
			const nextUnread = isActiveInEditor ? false : (needsAttention ? true : agent.unread);
			if (nextLabel !== agent.label || nextStatus !== prevStatus || Boolean(nextUnread) !== Boolean(agent.unread)) {
				this.entries = this.entries.map(entry => entry.id === agent.id ? { ...entry, label: nextLabel, status: nextStatus, unread: nextUnread || undefined } : entry);
				this.saveAgents();
				changed = true;
			}
		}

		if (changed) {
			this.changeEmitter.fire();
		}
	}

	removeAgent(id: string): readonly IAdeAgent[] {
		const subtree = this.getSubtree(id);
		if (!subtree.length) {
			return [];
		}
		const removed = new Set(subtree.map(agent => agent.id));
		if (this._selectedAgentId && removed.has(this._selectedAgentId)) {
			this._selectedAgentId = undefined;
			this.storageService.remove('aexus.ade.selectedProjectId', StorageScope.PROFILE);
		}
		this.entries = this.pruneOrphanedAgents(this.entries.filter(agent => !removed.has(agent.id)));
		this.saveAgents();
		this.removedAgentsEmitter.fire(subtree);
		this.changeEmitter.fire();
		return subtree;
	}

	setDraft(id: string, draft: string): void {
		this.entries = this.entries.map(agent => agent.id === id ? { ...agent, draft } : agent);
		this.saveAgents();
	}

	configureSecretary(session: IAdeSession): void {
		this._secretary = {
			...this._secretary,
			status: 'idle',
			unread: undefined,
			session: { engineId: session.engineId, resource: session.resource },
		};
		this.saveSecretary();
		this.changeEmitter.fire();
	}

	resetSecretary(session?: IAdeSession): void {
		this._secretary = {
			label: localize('adeSecretaryLabel', "Secretary"),
			draft: '',
			status: 'idle',
			unread: undefined,
			session: session ? { engineId: session.engineId, resource: session.resource } : undefined,
		};
		this.saveSecretary();
		this.changeEmitter.fire();
	}

	setSecretaryDraft(draft: string): void {
		this._secretary = { ...this._secretary, draft };
		this.saveSecretary();
	}

	markSecretaryRead(): void {
		if (!this._secretary.unread) {
			return;
		}
		this._secretary = { ...this._secretary, unread: undefined };
		this.saveSecretary();
		this.changeEmitter.fire();
	}

	setShowArchived(showArchived: boolean): void {
		if (this._showArchived === showArchived) {
			return;
		}
		this._showArchived = showArchived;
		this.storageService.store('aexus.ade.showArchived', showArchived, StorageScope.PROFILE, StorageTarget.MACHINE);
		this.changeEmitter.fire();
	}

	private persistSelectedProject(): void {
		this.isSavingStorage = true;
		try {
			if (this.selectedProjectUri) {
				this.storageService.store('aexus.ade.selectedProject', this.selectedProjectUri.toString(), StorageScope.PROFILE, StorageTarget.MACHINE);
			} else {
				this.storageService.remove('aexus.ade.selectedProject', StorageScope.PROFILE);
			}
		} finally {
			this.isSavingStorage = false;
		}
	}

	private saveProjects(): void {
		this.isSavingStorage = true;
		try {
			const stored: IStoredProject[] = this.catalogProjects.map(project => ({ uri: project.uri.toString(), name: project.name }));
			this.storageService.store('aexus.ade.projects', JSON.stringify(stored), StorageScope.PROFILE, StorageTarget.MACHINE);
			this.storageService.store('aexus.ade.catalogInitialized', true, StorageScope.PROFILE, StorageTarget.MACHINE);
		} finally {
			this.isSavingStorage = false;
		}
	}

	private saveAgents(): void {
		this.isSavingStorage = true;
		try {
			const stored: IStoredAgent[] = this.entries.map(agent => ({
				id: agent.id,
				parentId: agent.parentId,
				projectUri: agent.projectUri.toString(),
				label: agent.label,
				labelIsCustom: agent.labelIsCustom,
				role: agent.role,
				archived: agent.archived,
				unread: agent.unread,
				draft: agent.draft,
				session: agent.session ? { engineId: agent.session.engineId, resource: agent.session.resource.toString() } : undefined,
				...(agent.treeType ? { treeType: agent.treeType } : {}),
				...(agent.treeGovernorId ? { treeGovernorId: agent.treeGovernorId } : {}),
				...(agent.treeSegmentId ? { treeSegmentId: agent.treeSegmentId } : {}),
				...(agent.treeNodeId ? { treeNodeId: agent.treeNodeId } : {}),
				...(agent.preferredEngineId ? { preferredEngineId: agent.preferredEngineId } : {}),
				...(agent.preferredModel ? { preferredModel: agent.preferredModel } : {}),
				...(agent.preferredThinking ? { preferredThinking: agent.preferredThinking } : {}),
				...(agent.workingDirectoryOverride ? { workingDirectoryOverride: agent.workingDirectoryOverride } : {}),
			}));
			this.storageService.store('aexus.ade.agents', JSON.stringify(stored), StorageScope.PROFILE, StorageTarget.MACHINE);
		} finally {
			this.isSavingStorage = false;
		}
	}

	private saveSecretary(): void {
		this.isSavingStorage = true;
		try {
			const stored: IStoredSecretary = {
				label: this._secretary.label,
				draft: this._secretary.draft,
				unread: this._secretary.unread,
				session: this._secretary.session ? { engineId: this._secretary.session.engineId, resource: this._secretary.session.resource.toString() } : undefined,
			};
			this.storageService.store('aexus.ade.secretary', JSON.stringify(stored), StorageScope.PROFILE, StorageTarget.MACHINE);
		} finally {
			this.isSavingStorage = false;
		}
	}
}
