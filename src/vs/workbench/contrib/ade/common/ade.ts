/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { AdeAgentRole, AdeSessionRank } from '../../../../platform/ade/common/adeControl.js';
import { AdeThinkingLevel, AdeWorkTreeType } from '../../../../platform/ade/common/adeEngineering.js';
import {
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	getNextLowerRankFromConfig,
	getRankLevelFromConfig,
	IAdeOrganizationConfig,
	resolveEffectiveRankDefinition,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { WorkbenchModeViewContainers } from '../../../services/workbenchMode/common/workbenchMode.js';

export type { AdeAgentRole, AdeSessionRank };
export type AdeAgentStatus = 'idle' | 'working' | 'pending';

/** Maps an ADE agent role to its numeric hierarchy level (higher = more authority; default 4-tier: Governor=3, Manager=2, Employee=1, Worker=0). */
export function getAdeRoleRankLevel(
	role: AdeAgentRole | undefined,
	hasSubordinates = false,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
): number {
	return getRankLevelFromConfig(config, role, hasSubordinates);
}

/** Resolves the effective display rank ID of an ADE agent session. */
export function resolveAdeAgentRank(
	agent: Pick<IAdeAgent, 'role'>,
	hasSubordinates = false,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
): AdeSessionRank {
	if (agent.role) {
		return agent.role;
	}
	return resolveEffectiveRankDefinition(config, undefined, hasSubordinates).id;
}

/** Computes the automatic one-rank-lower child role when creating a sub-session under a parent session. */
export function getNextLowerAdeRole(
	parentRole: AdeAgentRole | undefined,
	parentHasSubordinates = false,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
): {
	readonly canSpawnSubSession: boolean;
	readonly childRole: AdeAgentRole | undefined;
	readonly childRank: AdeSessionRank;
} {
	const next = getNextLowerRankFromConfig(config, parentRole, parentHasSubordinates);
	return {
		canSpawnSubSession: next.canSpawnSubSession,
		childRole: next.childRole,
		childRank: next.childRank,
	};
}

export const ADE_PROJECTS_VIEW_ID = 'workbench.ade.projects';
export const ADE_INSPECTOR_CONTAINER_ID = WorkbenchModeViewContainers.adeInspector;
export const ADE_CHANGES_VIEW_ID = 'workbench.ade.changes';
export const ADE_FILES_VIEW_ID = 'workbench.ade.files';
export const ADE_SESSION_SCHEME = 'aexus-agent';
export const ADE_ENGINEERING_SCHEME = 'aexus-engineering';
export const ADE_CLOUD_HOSTS_SCHEME = 'aexus-cloud-hosts';
export const ADE_ROLE_STUDIO_SCHEME = 'aexus-roles';
export const ADE_CONFIG_SCHEME = 'aexus-ade-config';
export const ADE_SECRETARY_ID = '__secretary__';
export const ADE_REMOVE_PROJECT_COMMAND_ID = 'workbench.action.ade.removeProjectFolder';
export const ADE_DELETE_PROJECT_COMMAND_ID = 'workbench.action.ade.deleteProjectFolder';
export const ADE_RENAME_PROJECT_COMMAND_ID = 'workbench.action.ade.renameProjectFolder';
export const ADE_OPEN_MISSION_COMMAND_ID = 'workbench.action.ade.openMission';
export const ADE_REMOVE_MISSION_COMMAND_ID = 'workbench.action.ade.removeMission';
export const ADE_OPEN_ENGINEERING_COMMAND_ID = 'workbench.action.ade.openEngineering';
export const ADE_OPEN_RESEARCH_COMMAND_ID = 'workbench.action.ade.openResearch';
export const ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID = 'workbench.action.aexusCloudHosts.manage';
export const ADE_ADD_CLOUD_PROJECT_COMMAND_ID = 'workbench.action.aexusCloudHosts.addProject';
export const ADE_IMPORT_VSCODE_CLOUD_HOSTS_COMMAND_ID = 'workbench.action.aexusCloudHosts.importFromVSCode';
export const ADE_OPEN_ROLE_STUDIO_COMMAND_ID = 'workbench.action.ade.openRoleStudio';
export const ADE_OPEN_CONFIG_COMMAND_ID = 'workbench.action.ade.openConfig';

export interface IAdeProject {
	readonly uri: URI;
	readonly name: string;
}

export interface IAdeSession {
	readonly engineId: string;
	readonly resource: URI;
}

export interface IAdeAgent {
	readonly id: string;
	readonly parentId?: string;
	readonly projectUri: URI;
	readonly label: string;
	readonly labelIsCustom?: boolean;
	readonly role?: AdeAgentRole;
	readonly archived?: boolean;
	readonly unread?: boolean;
	readonly status?: AdeAgentStatus;
	readonly draft: string;
	readonly session?: IAdeSession;
	readonly treeType?: AdeWorkTreeType;
	readonly treeGovernorId?: string;
	readonly treeSegmentId?: string;
	readonly treeNodeId?: string;
	/** Ordered DAG node IDs assigned to this locked Mission employee (length > 1 when reused across multiple DAG positions). */
	readonly treeNodeIds?: readonly string[];
	readonly preferredEngineId?: string;
	readonly preferredModel?: string;
	readonly preferredThinking?: AdeThinkingLevel;
	readonly workingDirectoryOverride?: string;
}

export interface IAdeWorkTreeTaskSpec {
	readonly nodeId: string;
	readonly title: string;
	readonly employeeEngineId: string;
	readonly employeeModel?: string;
	readonly employeeThinking?: AdeThinkingLevel;
	readonly workerEngineId: string;
	readonly workerModel?: string;
	readonly workerThinking?: AdeThinkingLevel;
	readonly existingEmployeeAgentId?: string;
	readonly existingWorkerAgentId?: string;
	readonly workingDirectoryOverride?: string;
}

export interface IAdeWorkTreeSegmentSpec {
	readonly segmentId: string;
	readonly label: string;
	readonly managerEngineId: string;
	readonly managerModel?: string;
	readonly managerThinking?: AdeThinkingLevel;
	readonly existingManagerAgentId?: string;
	readonly workingDirectoryOverride?: string;
	readonly tasks: readonly IAdeWorkTreeTaskSpec[];
}

export interface IAdeWorkTreeSyncResult {
	readonly managerAgentsBySegment: Readonly<Record<string, string>>;
	readonly employeeAgentsByNode: Readonly<Record<string, string>>;
	readonly workerAgentsByNode: Readonly<Record<string, string>>;
	readonly removedAgents: readonly IAdeAgent[];
}

export interface IAdeSecretary {
	readonly label: string;
	readonly draft: string;
	readonly status: 'idle' | 'working';
	readonly unread?: boolean;
	readonly session?: IAdeSession;
}

export interface IAdeAddSessionOptions {
	readonly parentId?: string;
	readonly role?: AdeAgentRole;
	readonly labelIsCustom?: boolean;
}

export interface IAdeAgentTreeNode {
	readonly agent: IAdeAgent;
	readonly children: readonly IAdeAgentTreeNode[];
}

export const IAdeProjectsService = createDecorator<IAdeProjectsService>('adeProjectsService');

export type AdeProjectsChangeKind = 'order' | 'selection';

export interface IAdeProjectsService {
	readonly _serviceBrand: undefined;
	readonly projects: readonly IAdeProject[];
	readonly agents: readonly IAdeAgent[];
	readonly selectedProject: IAdeProject | undefined;
	readonly selectedAgentId: string | undefined;
	readonly secretary: IAdeSecretary;
	readonly showArchived: boolean;
	readonly onDidChange: Event<AdeProjectsChangeKind | void>;
	readonly onDidRemoveAgents?: Event<readonly IAdeAgent[]>;

	getProjectName(projectUri: URI): string;
	registerProject(uri: URI, name?: string): IAdeProject;
	migrateCloudHostAlias?(oldAlias: string, newAlias: string): number;
	unregisterProject(uri: URI): void;
	removeProject(uri: URI): readonly IAdeAgent[];
	moveProjectFolder(sourceUri: URI, targetUri: URI | undefined, after: boolean): void;
	runWithSuppressedWorkspaceSync?<T>(fn: () => Promise<T>): Promise<T>;
	ensureCatalogPersisted?(): void;

	selectProject(resource: URI): void;
	selectAgent(id: string): void;
	getAgent(id: string): IAdeAgent | undefined;
	getRootAgent(id: string): IAdeAgent | undefined;
	getDirectSubordinates(id: string): readonly IAdeAgent[];
	getSubtree(id: string): readonly IAdeAgent[];
	getAgentTree(id: string): IAdeAgentTreeNode | undefined;
	hasSubordinates(id: string): boolean;
	isOrchestrated(agentOrId: IAdeAgent | string): boolean;
	isArchived(id: string): boolean;
	isLockedByWorkTree?(id: string): boolean;
	getWorkTreeGovernor?(id: string): IAdeAgent | undefined;
	setAgentWorkTreeTag?(governorId: string, treeType: AdeWorkTreeType | undefined): void;
	syncMissionMermaidEmployees?(
		ownerOrMissionId: string,
		employees: readonly { readonly id: string; readonly title: string; readonly nodeIds?: readonly string[]; readonly isExplicitEmployee?: boolean }[],
		options?: { readonly projectUri?: URI; readonly ownerTier?: number },
	): { readonly employeeAgentsByNode: Readonly<Record<string, IAdeAgent>>; readonly removedAgents: readonly IAdeAgent[] };
	clearMissionEmployees?(ownerOrMissionId: string): readonly IAdeAgent[];
	syncWorkTreeHierarchy?(governorId: string, treeType: AdeWorkTreeType, segments: readonly IAdeWorkTreeSegmentSpec[]): IAdeWorkTreeSyncResult;
	updateAgentEnginePreferences?(id: string, prefs: {
		readonly preferredEngineId?: string;
		readonly preferredModel?: string;
		readonly preferredThinking?: AdeThinkingLevel;
		readonly workingDirectoryOverride?: string;
		readonly projectUri?: URI;
	}): void;

	addProject(uri: URI, label?: string): IAdeAgent;
	addAgent(parentId: string, label: string, role?: AdeAgentRole): IAdeAgent;
	addSession(projectUri: URI, session: IAdeSession, label: string, optionsOrParentId?: string | IAdeAddSessionOptions): IAdeAgent;
	bindSession(id: string, session: IAdeSession): void;
	moveProject(id: string, targetId: string | undefined, after: boolean): void;
	canReparentAgent(id: string, newParentId: string | undefined, targetProjectUri?: URI): boolean;
	reparentAgent(id: string, newParentId: string | undefined, targetProjectUri?: URI): boolean;
	renameAgent(id: string, label: string): void;
	setAgentRole(id: string, role: AdeAgentRole | undefined): void;
	setArchived(id: string, archived: boolean): void;
	markRead(id: string): void;
	setAgentStatus(id: string, status: AdeAgentStatus, unread?: boolean): void;
	updateSessionLabel(resource: URI, label: string): void;
	syncSessionItem(resource: URI, update: { readonly label?: string; readonly status?: AdeAgentStatus }, isActiveInEditor?: boolean): void;
	removeAgent(id: string): readonly IAdeAgent[] | void;
	setDraft(id: string, draft: string): void;

	configureSecretary(session: IAdeSession): void;
	resetSecretary(session?: IAdeSession): void;
	setSecretaryDraft(draft: string): void;
	markSecretaryRead(): void;

	setShowArchived(showArchived: boolean): void;
}

export const IAdeEditorService = createDecorator<IAdeEditorService>('adeEditorService');

export interface IAdeEditorService {
	readonly _serviceBrand: undefined;
	readonly activeEditor: EditorInput | undefined;
	getAgentIdForEditor?(editor: EditorInput | undefined): string | undefined;
	isSessionActive(resource: URI): boolean;
	openAgent(id: string, options?: { side?: boolean }): Promise<void>;
	openEngineering?(governorId: string, options?: { side?: boolean }): Promise<void>;
	openCloudHosts?(hostIdOrAlias?: string, options?: { side?: boolean }): Promise<void>;
	openRoleStudio?(focusRankId?: string, options?: { side?: boolean }): Promise<void>;
	openAdeConfig?(options?: { side?: boolean }): Promise<void>;
	openSecretary(options?: { side?: boolean }): Promise<void>;
	closeAgents(agents: readonly IAdeAgent[]): Promise<void>;
	openFile(resource: URI, projectUriOrAgentId?: URI | string, options?: IEditorOptions): Promise<void>;
	openDiff(original: URI, modified: URI, label?: string, projectUri?: URI, options?: IEditorOptions): Promise<void>;
}
