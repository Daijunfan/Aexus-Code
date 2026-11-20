/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IMissionNodePosition, parseMissionMermaidDag } from '../../../../platform/ade/common/adeMissionDag.js';
import type { IMissionRuntimeState } from '../../../../platform/ade/common/adeMissionEngine.js';
import { ADE_SECRETARY_TIER, ADE_USER_TIER } from '../../../../platform/ade/common/adeRankResize.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import { createDecorator, IInstantiationService, ServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { ADE_SECRETARY_ID, IAdeAgent, IAdeEditorService, IAdeProjectsService } from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { AdeEngineeringEditorInput } from './adeEngineeringEditorPane.js';
import { IAdeSessionsService } from './adeSessionsService.js';

const ADE_MISSIONS_STORAGE_KEY = 'aexus.ade.missions.v1';

export interface IAdeMissionRecord {
	readonly id: string;
	readonly title: string;
	readonly mermaidText: string;
	readonly positions: Readonly<Record<string, IMissionNodePosition>>;
	/** Exact owner session ID (agent session ID for L1..LN, ADE_SECRETARY_ID for L0, undefined for User L-1 standalone). */
	readonly ownerSessionId?: string;
	/** Hierarchy tier of the owner (-1 = User L-1, 0 = Secretary L0, 1..N = L1..LN). */
	readonly ownerTier: number;
	/** Rank slug ID of the owner ('user', 'secretary', or configured rank ID). */
	readonly ownerRankId?: string;
	/** Legacy alias kept in sync with ownerSessionId. */
	readonly linkedSessionId?: string;
	readonly projectUri?: string;
	readonly runtime?: IMissionRuntimeState;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface IAdeMissionCaller {
	readonly isHumanUser: boolean;
	readonly isSecretary?: boolean;
	readonly callerSessionId?: string;
}

export interface IAdeMissionRemoveResult {
	readonly deleted: boolean;
	readonly id: string;
	readonly removedEmployeeIds: readonly string[];
}

/**
 * Enforces strict Mission ownership authority:
 * Whichever session (at any rank L0 or L1..LN) created a Mission is the ONLY agent session
 * permitted to operate its Mission orchestration; Human User (L-1) always retains full authority.
 */
export function canCallerOperateMission(mission: IAdeMissionRecord, caller: IAdeMissionCaller): boolean {
	if (caller.isHumanUser) {
		return true;
	}
	if (mission.ownerTier <= ADE_USER_TIER || !mission.ownerSessionId) {
		return false;
	}
	if (caller.isSecretary) {
		return mission.ownerSessionId === ADE_SECRETARY_ID;
	}
	return Boolean(caller.callerSessionId && caller.callerSessionId === mission.ownerSessionId);
}

export const IAdeMissionService = createDecorator<IAdeMissionService>('adeMissionService');

/**
 * Pure frontend Mission catalog backed by `IStorageService`, with strict owner-only orchestration
 * metadata and locked Mermaid-generated employee syncing in the left sidebar.
 */
export interface IAdeMissionService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;

	listMissions(): readonly IAdeMissionRecord[];
	getMission(id: string): IAdeMissionRecord | undefined;
	getMissionByLinkedSession(sessionId: string): IAdeMissionRecord | undefined;
	getGeneratedEmployees(idOrOwnerId: string): readonly IAdeAgent[];
	createMission(options?: {
		readonly id?: string;
		readonly title?: string;
		readonly mermaidText?: string;
		readonly ownerSessionId?: string;
		readonly ownerTier?: number;
		readonly ownerRankId?: string;
		readonly linkedSessionId?: string;
		readonly projectUri?: string;
	}): IAdeMissionRecord;
	ensureMission(id: string, defaults?: {
		readonly title?: string;
		readonly ownerSessionId?: string;
		readonly ownerTier?: number;
		readonly ownerRankId?: string;
		readonly linkedSessionId?: string;
		readonly projectUri?: string;
	}): IAdeMissionRecord;
	updateMermaid(id: string, mermaidText: string): IAdeMissionRecord | undefined;
	updateRuntime(id: string, runtime: IMissionRuntimeState | undefined): IAdeMissionRecord | undefined;
	updateNodePositions(id: string, positions: Readonly<Record<string, IMissionNodePosition>>): IAdeMissionRecord | undefined;
	clearNodePositions(id: string): IAdeMissionRecord | undefined;
	renameMission(id: string, title: string): IAdeMissionRecord | undefined;
	deleteMission(id: string): boolean;
	removeMissionWithEmployees(id: string, options?: { readonly deleteEngineHistory?: boolean }): Promise<IAdeMissionRemoveResult>;
	openMissionEditor(id: string, options?: { side?: boolean }): Promise<void>;
}

export class AdeMissionStoreService extends Disposable implements IAdeMissionService {
	declare readonly _serviceBrand: undefined;

	private readonly records = new Map<string, IAdeMissionRecord>();
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchModeService private readonly modeService: IWorkbenchModeService,
	) {
		super();
		this.loadFromStorage();
	}

	private tryGet<T>(id: ServiceIdentifier<T>): T | undefined {
		try {
			return this.instantiationService.invokeFunction(accessor => accessor.get(id));
		} catch {
			return undefined;
		}
	}

	private get projectsService(): IAdeProjectsService | undefined {
		return this.tryGet(IAdeProjectsService);
	}

	private get adeEditorsService(): IAdeEditorService | undefined {
		return this.tryGet(IAdeEditorService);
	}

	private get sessionsService(): IAdeSessionsService | undefined {
		return this.tryGet(IAdeSessionsService);
	}

	private get roleSchemaService(): IAdeRoleSchemaService | undefined {
		return this.tryGet(IAdeRoleSchemaService);
	}

	private resolveOwnerMeta(options?: {
		readonly ownerSessionId?: string;
		readonly linkedSessionId?: string;
		readonly ownerTier?: number;
		readonly ownerRankId?: string;
	}): { readonly ownerSessionId?: string; readonly ownerTier: number; readonly ownerRankId: string } {
		const ownerId = (options?.ownerSessionId ?? options?.linkedSessionId)?.trim() || undefined;
		if (!ownerId) {
			return {
				ownerTier: options?.ownerTier ?? ADE_USER_TIER,
				ownerRankId: options?.ownerRankId ?? 'user',
			};
		}
		if (ownerId === ADE_SECRETARY_ID) {
			return {
				ownerSessionId: ADE_SECRETARY_ID,
				ownerTier: ADE_SECRETARY_TIER,
				ownerRankId: 'secretary',
			};
		}
		const projects = this.projectsService;
		const agent = projects?.getAgent(ownerId);
		if (agent && projects) {
			const schema = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
			const rankDef = resolveEffectiveRankDefinition(schema, agent.role, projects.hasSubordinates(agent.id));
			return {
				ownerSessionId: agent.id,
				ownerTier: options?.ownerTier ?? rankDef.tier,
				ownerRankId: options?.ownerRankId ?? rankDef.id,
			};
		}
		return {
			ownerSessionId: ownerId,
			ownerTier: options?.ownerTier ?? 1,
			ownerRankId: options?.ownerRankId ?? 'governor',
		};
	}

	private loadFromStorage(): void {
		try {
			const raw = this.storageService.get(ADE_MISSIONS_STORAGE_KEY, StorageScope.APPLICATION);
			if (!raw) {
				return;
			}
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				return;
			}
			for (const entry of parsed) {
				if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.trim()) {
					const ownerSessionId = typeof entry.ownerSessionId === 'string' && entry.ownerSessionId.trim()
						? entry.ownerSessionId.trim()
						: (typeof entry.linkedSessionId === 'string' && entry.linkedSessionId.trim() ? entry.linkedSessionId.trim() : undefined);
					const ownerTier = typeof entry.ownerTier === 'number' && Number.isFinite(entry.ownerTier)
						? Math.floor(entry.ownerTier)
						: (ownerSessionId === ADE_SECRETARY_ID ? ADE_SECRETARY_TIER : ownerSessionId ? 1 : ADE_USER_TIER);
					const ownerRankId = typeof entry.ownerRankId === 'string' && entry.ownerRankId.trim()
						? entry.ownerRankId.trim()
						: (ownerTier <= ADE_USER_TIER ? 'user' : ownerTier === ADE_SECRETARY_TIER ? 'secretary' : undefined);
					this.records.set(entry.id, {
						id: entry.id,
						title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : 'Untitled',
						mermaidText: typeof entry.mermaidText === 'string' ? entry.mermaidText : '',
						positions: entry.positions && typeof entry.positions === 'object' ? entry.positions : {},
						...(ownerSessionId ? { ownerSessionId, linkedSessionId: ownerSessionId } : {}),
						ownerTier,
						...(ownerRankId ? { ownerRankId } : {}),
						...(typeof entry.projectUri === 'string' ? { projectUri: entry.projectUri } : {}),
						...(entry.runtime && typeof entry.runtime === 'object' ? { runtime: entry.runtime as IMissionRuntimeState } : {}),
						createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
						updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
					});
				}
			}
		} catch {
			// Ignore malformed legacy storage
		}
	}

	private persist(): void {
		const payload = [...this.records.values()];
		this.storageService.store(ADE_MISSIONS_STORAGE_KEY, JSON.stringify(payload), StorageScope.APPLICATION, StorageTarget.USER);
	}

	private getOwnerSyncKey(record: IAdeMissionRecord): string {
		return record.ownerSessionId ?? record.id;
	}

	private syncSidebarEmployeesForRecord(record: IAdeMissionRecord): void {
		const projects = this.projectsService;
		if (!projects) {
			return;
		}
		if (record.ownerSessionId && record.ownerSessionId !== ADE_SECRETARY_ID && projects.getAgent(record.ownerSessionId)) {
			projects.setAgentWorkTreeTag?.(record.ownerSessionId, 'mission');
		}
		const parsed = parseMissionMermaidDag(record.mermaidText);
		if (parsed.error) {
			// Preserve existing locked employees while the user is mid-edit on invalid Mermaid syntax.
			return;
		}
		const employeeSpecs = (parsed.employees ?? []).map(group => ({
			id: group.key,
			title: group.displayName,
			nodeIds: group.nodeIds,
			isExplicitEmployee: group.isExplicit,
		}));

		const ownerKey = this.getOwnerSyncKey(record);
		const hasAgentOwner = Boolean(record.ownerSessionId && projects.getAgent(record.ownerSessionId));
		const parsedProjectUri = record.projectUri
			? URI.parse(record.projectUri)
			: (projects.selectedProject?.uri ?? projects.projects[0]?.uri);
		if (!hasAgentOwner && !parsedProjectUri) {
			return;
		}
		const syncRes = projects.syncMissionMermaidEmployees?.(ownerKey, employeeSpecs, {
			projectUri: parsedProjectUri,
			ownerTier: record.ownerTier,
		});
		if (syncRes && syncRes.removedAgents.length > 0) {
			const editors = this.adeEditorsService;
			if (editors) {
				void editors.closeAgents(syncRes.removedAgents).catch(() => undefined);
			}
		}
	}

	private async closeMissionEditorTabs(missionId: string): Promise<void> {
		try {
			const editorsToClose: { editor: AdeEngineeringEditorInput; groupId: number }[] = [];
			for (const entry of this.editorService.getEditors(0)) {
				if (entry.editor instanceof AdeEngineeringEditorInput && entry.editor.governorSessionId === missionId) {
					editorsToClose.push({ editor: entry.editor, groupId: entry.groupId });
				}
			}
			for (const item of editorsToClose) {
				await this.editorService.closeEditor(item).catch(() => undefined);
			}
		} catch {
			// Best-effort tab close in minimal test environments
		}
	}

	listMissions(): readonly IAdeMissionRecord[] {
		return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	getMission(id: string): IAdeMissionRecord | undefined {
		return this.records.get(id);
	}

	getMissionByLinkedSession(sessionId: string): IAdeMissionRecord | undefined {
		const direct = this.records.get(sessionId);
		if (direct) {
			return direct;
		}
		for (const rec of this.records.values()) {
			if (rec.ownerSessionId === sessionId || rec.linkedSessionId === sessionId) {
				return rec;
			}
		}
		return undefined;
	}

	getGeneratedEmployees(idOrOwnerId: string): readonly IAdeAgent[] {
		const projects = this.projectsService;
		if (!projects) {
			return [];
		}
		const rec = this.getMission(idOrOwnerId) ?? this.getMissionByLinkedSession(idOrOwnerId);
		const ownerKey = rec ? this.getOwnerSyncKey(rec) : idOrOwnerId;
		return projects.agents.filter(entry =>
			entry.treeGovernorId === ownerKey
			&& entry.id !== ownerKey
			&& Boolean(entry.treeNodeId),
		);
	}

	createMission(options?: {
		readonly id?: string;
		readonly title?: string;
		readonly mermaidText?: string;
		readonly ownerSessionId?: string;
		readonly ownerTier?: number;
		readonly ownerRankId?: string;
		readonly linkedSessionId?: string;
		readonly projectUri?: string;
	}): IAdeMissionRecord {
		const ownerMeta = this.resolveOwnerMeta(options);
		const id = options?.id?.trim() || ownerMeta.ownerSessionId || `mission-${generateUuid().slice(0, 8)}`;
		const now = Date.now();
		const num = this.records.size + 1;
		const ownerAgent = ownerMeta.ownerSessionId ? this.projectsService?.getAgent(ownerMeta.ownerSessionId) : undefined;
		const projectUri = options?.projectUri
			?? ownerAgent?.projectUri.toString()
			?? this.projectsService?.selectedProject?.uri.toString()
			?? this.projectsService?.projects[0]?.uri.toString();
		const record: IAdeMissionRecord = {
			id,
			title: options?.title?.trim() || ownerAgent?.label || `Mission ${num}`,
			mermaidText: options?.mermaidText ?? '',
			positions: {},
			...(ownerMeta.ownerSessionId ? { ownerSessionId: ownerMeta.ownerSessionId, linkedSessionId: ownerMeta.ownerSessionId } : {}),
			ownerTier: ownerMeta.ownerTier,
			ownerRankId: ownerMeta.ownerRankId,
			...(projectUri ? { projectUri } : {}),
			createdAt: now,
			updatedAt: now,
		};
		this.records.set(id, record);
		this.persist();
		this.syncSidebarEmployeesForRecord(record);
		this._onDidChange.fire();
		return record;
	}

	ensureMission(id: string, defaults?: {
		readonly title?: string;
		readonly ownerSessionId?: string;
		readonly ownerTier?: number;
		readonly ownerRankId?: string;
		readonly linkedSessionId?: string;
		readonly projectUri?: string;
	}): IAdeMissionRecord {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (existing) {
			return existing;
		}
		return this.createMission({
			id,
			title: defaults?.title,
			mermaidText: '',
			ownerSessionId: defaults?.ownerSessionId,
			ownerTier: defaults?.ownerTier,
			ownerRankId: defaults?.ownerRankId,
			linkedSessionId: defaults?.linkedSessionId,
			projectUri: defaults?.projectUri,
		});
	}

	updateMermaid(id: string, mermaidText: string): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		if (existing.mermaidText === mermaidText) {
			return existing;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			mermaidText,
			updatedAt: Date.now(),
		};
		this.records.set(existing.id, updated);
		this.persist();
		this.syncSidebarEmployeesForRecord(updated);
		this._onDidChange.fire();
		return updated;
	}

	updateRuntime(id: string, runtime: IMissionRuntimeState | undefined): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			...(runtime ? { runtime } : { runtime: undefined }),
			updatedAt: Date.now(),
		};
		this.records.set(existing.id, updated);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	updateNodePositions(id: string, positions: Readonly<Record<string, IMissionNodePosition>>): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			positions: { ...existing.positions, ...positions },
			updatedAt: Date.now(),
		};
		this.records.set(existing.id, updated);
		this.persist();
		return updated;
	}

	clearNodePositions(id: string): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			positions: {},
			updatedAt: Date.now(),
		};
		this.records.set(existing.id, updated);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	renameMission(id: string, title: string): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		const trimmed = title.trim();
		if (!existing || !trimmed) {
			return existing;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			title: trimmed,
			updatedAt: Date.now(),
		};
		this.records.set(existing.id, updated);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	deleteMission(id: string): boolean {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return false;
		}
		const ownerKey = this.getOwnerSyncKey(existing);
		const removedAgents = this.projectsService?.clearMissionEmployees?.(ownerKey) ?? [];
		this.records.delete(existing.id);
		this.persist();
		this._onDidChange.fire();
		if (removedAgents.length > 0) {
			const editors = this.adeEditorsService;
			if (editors) {
				void editors.closeAgents(removedAgents).catch(() => undefined);
			}
		}
		void this.closeMissionEditorTabs(existing.id);
		return true;
	}

	async removeMissionWithEmployees(id: string, options?: { readonly deleteEngineHistory?: boolean }): Promise<IAdeMissionRemoveResult> {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		const targetId = existing?.id ?? id;
		const ownerKey = existing ? this.getOwnerSyncKey(existing) : id;
		const projects = this.projectsService;
		const sessions = this.sessionsService;
		const editors = this.adeEditorsService;

		const generated = this.getGeneratedEmployees(ownerKey);
		const generatedWithSubtrees = new Map<string, IAdeAgent>();
		for (const gen of generated) {
			for (const member of projects?.getSubtree(gen.id) ?? [gen]) {
				generatedWithSubtrees.set(member.id, member);
			}
		}
		const toStop = [...generatedWithSubtrees.values()];
		for (const member of toStop) {
			if (member.session) {
				await sessions?.stop?.(member.session).catch(() => undefined);
				if (options?.deleteEngineHistory) {
					await sessions?.delete(member.session).catch(() => undefined);
				}
			}
		}

		const removed = projects?.clearMissionEmployees?.(ownerKey) ?? [];
		const deleted = existing ? this.records.delete(existing.id) : false;
		if (deleted) {
			this.persist();
		}
		const closeList = removed.length > 0 ? removed : toStop;
		if (closeList.length > 0 && editors) {
			await editors.closeAgents(closeList).catch(() => undefined);
		}
		await this.closeMissionEditorTabs(targetId);
		if (deleted || removed.length > 0) {
			this._onDidChange.fire();
		}
		return {
			deleted: deleted || removed.length > 0,
			id: targetId,
			removedEmployeeIds: closeList.map(a => a.id),
		};
	}

	async openMissionEditor(id: string, options?: { side?: boolean }): Promise<void> {
		const rec = this.ensureMission(id);
		this.modeService.setMode('ade');
		const input = this.instantiationService.createInstance(AdeEngineeringEditorInput, rec.id);
		await this.editorService.openEditor(input, { pinned: true }, options?.side ? SIDE_GROUP : undefined);
	}
}
