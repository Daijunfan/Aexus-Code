/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import {
	AdeLayoutDirection,
	AdeSessionPhase,
	canonicalEdgePairKey,
	formatLevelLabel,
	IAdeAgentNode,
	IAdeCatalogSnapshot,
	IAdeDepartment,
	IAdeProjectSnapshot,
	IAdeProjectSummaryItem,
	IAdeTicketSummaryCard,
	IAdeWhiteboard,
	IAdeWorkspaceFolder,
} from '../../../../platform/ade/common/adeModels.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { WorkbenchModeViewContainers } from '../../../services/workbenchMode/common/workbenchMode.js';

export {
	canonicalEdgePairKey,
	formatLevelLabel,
	type AdeLayoutDirection,
	type AdeSessionPhase,
	type IAdeAgentNode,
	type IAdeCatalogSnapshot,
	type IAdeDepartment,
	type IAdeProjectSnapshot,
	type IAdeProjectSummaryItem,
	type IAdeTicketSummaryCard,
	type IAdeWhiteboard,
	type IAdeWorkspaceFolder,
};

export type AdeAgentStatus = 'idle' | 'working' | 'pending';

export const ADE_PROJECTS_VIEW_ID = 'workbench.ade.projects';
export const ADE_INSPECTOR_CONTAINER_ID = WorkbenchModeViewContainers.adeInspector;
export const ADE_CHANGES_VIEW_ID = 'workbench.ade.changes';
export const ADE_FILES_VIEW_ID = 'workbench.ade.files';
export const ADE_SESSION_SCHEME = 'aexus-agent';
export const ADE_PROJECT_SCHEME = 'ade-project';
export const ADE_ENGINEERING_SCHEME = ADE_PROJECT_SCHEME;
export const ADE_CLOUD_HOSTS_SCHEME = 'aexus-cloud-hosts';

export const ADE_ADD_PROJECT_FOLDER_COMMAND_ID = 'workbench.action.ade.addProjectFolder';
export const ADE_REMOVE_PROJECT_COMMAND_ID = 'workbench.action.ade.removeProjectFolder';
export const ADE_DELETE_PROJECT_COMMAND_ID = 'workbench.action.ade.deleteProjectFolder';
export const ADE_RENAME_PROJECT_COMMAND_ID = 'workbench.action.ade.renameProjectFolder';
export const ADE_CREATE_PROJECT_PAGE_COMMAND_ID = 'workbench.action.ade.createProjectPage';
export const ADE_OPEN_PROJECT_PAGE_COMMAND_ID = 'workbench.action.ade.openProjectPage';
export const ADE_RENAME_PROJECT_PAGE_COMMAND_ID = 'workbench.action.ade.renameProjectPage';
export const ADE_DELETE_PROJECT_PAGE_COMMAND_ID = 'workbench.action.ade.deleteProjectPage';
export const ADE_CONFIGURE_PROJECT_STORAGE_COMMAND_ID = 'workbench.action.ade.configureProjectStorage';
export const ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID = 'workbench.action.aexusCloudHosts.manage';
export const ADE_ADD_CLOUD_PROJECT_COMMAND_ID = 'workbench.action.aexusCloudHosts.addProject';
export const ADE_IMPORT_VSCODE_CLOUD_HOSTS_COMMAND_ID = 'workbench.action.aexusCloudHosts.importFromVSCode';
export const ADE_TRY_SEND_OPEN_CHAT_REQUEST_COMMAND_ID = 'aexus.ade.trySendOpenChatRequest';
export const ADE_TRY_NATIVE_IN_STREAM_STEER_COMMAND_ID = 'aexus.ade.tryNativeInStreamSteer';

export function normalizeAdeShortEngineId(raw: string): string {
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
	if (low.startsWith('aexus-')) {
		return low.slice('aexus-'.length);
	}
	return low;
}

/**
 * Deterministic session resource URI per employee (`aexus-<engine>:/ade-${projectId}-${agentId}`, `plan.md` §7.3).
 */
export function buildAdeEmployeeSessionUri(engine: string, projectId: string, agentId: string): URI {
	const shortEng = normalizeAdeShortEngineId(engine);
	return URI.from({
		scheme: `aexus-${shortEng}`,
		path: `/ade-${projectId}-${agentId}`,
	});
}

export function parseAdeEmployeeSessionUri(uri: URI | undefined): {
	readonly engine: string;
	readonly projectId: string;
	readonly agentId: string;
} | undefined {
	if (!uri || !uri.scheme.startsWith('aexus-')) {
		return undefined;
	}
	const engine = uri.scheme.slice('aexus-'.length);
	const rawPath = uri.path.replace(/^\/+/, '');
	if (!rawPath.startsWith('ade-')) {
		return undefined;
	}
	const rest = rawPath.slice('ade-'.length);
	if (!rest || rest.includes('/')) {
		return undefined;
	}
	const legacySepIdx = rest.indexOf('::');
	if (legacySepIdx > 0 && legacySepIdx + 2 < rest.length) {
		const projectId = rest.slice(0, legacySepIdx);
		const agentId = rest.slice(legacySepIdx + 2);
		return projectId && agentId ? { engine, projectId, agentId } : undefined;
	}
	const doubleDashIdx = rest.indexOf('--');
	if (doubleDashIdx > 0 && doubleDashIdx + 2 < rest.length) {
		const projectId = rest.slice(0, doubleDashIdx);
		const agentId = rest.slice(doubleDashIdx + 2);
		if (projectId && agentId && !projectId.endsWith('-') && !agentId.startsWith('-')) {
			return { engine, projectId, agentId };
		}
	}
	// projectId starts with proj_... and agentId starts with agent_... (or custom IDs without slash)
	const agentIdx = rest.lastIndexOf('-agent_');
	if (agentIdx > 0 && agentIdx < rest.length - 1) {
		return {
			engine,
			projectId: rest.slice(0, agentIdx),
			agentId: rest.slice(agentIdx + 1),
		};
	}
	const projPrefixMatch = /^(proj_[A-Za-z0-9_]+)-(.+)$/.exec(rest);
	if (projPrefixMatch && projPrefixMatch[1] && projPrefixMatch[2]) {
		return {
			engine,
			projectId: projPrefixMatch[1],
			agentId: projPrefixMatch[2],
		};
	}
	const sep = rest.indexOf('-');
	if (sep <= 0 || sep >= rest.length - 1) {
		return undefined;
	}
	return {
		engine,
		projectId: rest.slice(0, sep),
		agentId: rest.slice(sep + 1),
	};
}

export function buildAdeProjectEditorUri(projectId: string): URI {
	return URI.from({
		scheme: ADE_PROJECT_SCHEME,
		authority: projectId,
		path: '/',
	});
}

export function parseAdeProjectEditorUri(uri: URI | undefined): string | undefined {
	if (!uri || uri.scheme !== ADE_PROJECT_SCHEME) {
		return undefined;
	}
	const id = (uri.authority || uri.path.replace(/^\/+/, '')).trim();
	return id || undefined;
}

/**
 * Workspace Folder item in ADE mode (supports both local `file://` and remote `aexus-ssh://` folders).
 */
export interface IAdeProject {
	readonly uri: URI;
	readonly name: string;
	readonly folderId?: string;
	readonly host?: string;
	readonly collapsed?: boolean;
}

/**
 * Project Page item mounted under a Workspace Folder (1 Folder -> 0..N Project Pages, no upper cap).
 */
export interface IAdeProjectPageItem {
	readonly projectId: string;
	readonly folderId: string;
	readonly folderUri: URI;
	readonly name: string;
	readonly sortOrder: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface IAdeSession {
	readonly engineId: string;
	readonly resource: URI;
}

export interface IAdeAgent {
	readonly id: string;
	readonly projectId: string;
	readonly parentId?: string;
	readonly projectUri: URI;
	readonly label: string;
	readonly level: number;
	readonly isTopRole: boolean;
	readonly roleSummary: string;
	readonly host: string;
	readonly engine: string;
	readonly model: string;
	readonly effort: string;
	readonly sessionPhase: AdeSessionPhase;
	readonly sessionStarted: boolean;
	readonly status?: AdeAgentStatus;
	readonly unread?: boolean;
	readonly session: IAdeSession;
}

export const IAdeProjectsService = createDecorator<IAdeProjectsService>('adeProjectsService');

export type AdeProjectsChangeKind = 'order' | 'selection';

export interface IAdeProjectsService {
	readonly _serviceBrand: undefined;
	whenReady(): Promise<void>;

	readonly folders: readonly IAdeWorkspaceFolder[];
	/** Workspace folders registered in ADE mode (compatible with terminal & workbenchMode consumers). */
	readonly projects: readonly IAdeProject[];
	/** All Project pages across workspace folders. */
	readonly projectPages: readonly IAdeProjectPageItem[];
	readonly agents: readonly IAdeAgent[];

	readonly selectedProject: IAdeProject | undefined;
	readonly selectedProjectPageId: string | undefined;
	readonly selectedAgentId: string | undefined;
	readonly onDidChange: Event<AdeProjectsChangeKind | void>;

	getProjectName(projectUri: URI): string;
	getProjectPagesForFolder(folderUri: URI): readonly IAdeProjectPageItem[];
	getProjectPage(projectId: string): IAdeProjectPageItem | undefined;
	getFolderForProjectPage(projectId: string): IAdeProject | undefined;
	allBoundSessionUris(): ReadonlySet<string>;

	registerProject(uri: URI, name?: string): IAdeProject;
	registerWorkspaceFolderAsync?(uri: URI, name?: string): Promise<IAdeProject>;
	migrateCloudHostAlias?(oldAlias: string, newAlias: string): Promise<number> | number;
	unregisterProject(uri: URI): void;
	removeProject(uri: URI): readonly IAdeAgent[];
	removeWorkspaceFolderAsync?(uri: URI): Promise<void>;
	moveProjectFolder(sourceUri: URI, targetUri: URI | undefined, after: boolean): void;
	setFolderCollapsed?(folderUri: URI, collapsed: boolean): Promise<void>;
	runWithSuppressedWorkspaceSync?<T>(fn: () => Promise<T>): Promise<T>;
	ensureCatalogPersisted?(): void;

	createProjectPage(folderUri: URI, name?: string): Promise<IAdeProjectSnapshot>;
	renameProjectPage(projectId: string, name: string): Promise<void>;
	reorderProjectPage(projectId: string, targetProjectId: string | undefined, after: boolean): Promise<void>;
	deleteProjectPage(projectId: string): Promise<void>;
	refreshCatalog(): Promise<void>;
	notifyProjectSnapshotLoaded(snapshot: IAdeProjectSnapshot): void;

	selectProject(resource: URI): void;
	selectProjectPage(projectId: string | undefined): void;
	selectAgent(id: string | undefined, projectId?: string): void;
	getAgent(id: string, projectId?: string): IAdeAgent | undefined;
	markRead(id: string, projectId?: string): void;
	setAgentStatus(id: string, status: AdeAgentStatus, unread?: boolean, projectId?: string): void;
	syncSessionItem(resource: URI, update: { readonly label?: string; readonly status?: AdeAgentStatus }, isActiveInEditor?: boolean): void;
}

export interface IAdeProjectOpenOptions {
	readonly side?: boolean;
	readonly focusNodeId?: string;
	readonly highlightNodeIds?: readonly string[];
	readonly preferExistingGroup?: boolean;
	readonly openPopover?: 'whiteboard' | 'agent';
	readonly openAgentBeside?: boolean;
}

export const IAdeEditorService = createDecorator<IAdeEditorService>('adeEditorService');

export interface IAdeEditorService {
	readonly _serviceBrand: undefined;
	readonly activeEditor: EditorInput | undefined;
	getActiveProjectPageId(): string | undefined;
	getActiveFolderUri(): URI | undefined;
	getAgentIdForEditor?(editor: EditorInput | undefined): string | undefined;
	getAgentForEditor?(editor: EditorInput | undefined): { readonly projectId: string; readonly agentId: string } | undefined;
	isSessionActive(resource: URI): boolean;
	openProjectPage(projectId: string, options?: IAdeProjectOpenOptions): Promise<void>;
	closeProjectPageEditors(projectId: string): Promise<void>;
	openAgent(id: string, options?: { readonly projectId?: string; readonly side?: boolean }): Promise<void>;
	openCloudHosts?(hostIdOrAlias?: string, options?: { readonly side?: boolean }): Promise<void>;
	rebindUnstartedAgentEditors?(projectId?: string, snapshot?: IAdeProjectSnapshot): Promise<number>;
	closeAgents(agents: readonly IAdeAgent[]): Promise<void>;
	openFile(resource: URI, projectUriOrAgentId?: URI | string, options?: IEditorOptions): Promise<void>;
	openDiff(original: URI, modified: URI, label?: string, projectUri?: URI, options?: IEditorOptions): Promise<void>;
}
