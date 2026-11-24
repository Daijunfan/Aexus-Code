/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { AEXUS_SSH_SCHEME } from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	AdeThinkingLevel,
	computeAdeStorageFingerprint,
	IAdeEngineeringBackendService,
} from '../../../../platform/ade/common/adeEngineering.js';
import { IMissionNodeCheckHook, IMissionNodePosition, parseMissionMermaidDag } from '../../../../platform/ade/common/adeMissionDag.js';
import { computeMissionTotalCostUsd, IMissionRuntimeState } from '../../../../platform/ade/common/adeMissionEngine.js';
import {
	findHighestRankStaffNode,
	IMissionTaskStatusRecord,
	IOrchestrationRuntimeState,
	IOrchestrationWhiteboard,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import { OrchestrationLayoutMode, parseOrchestrationGraph } from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { ADE_SECRETARY_TIER, ADE_USER_TIER } from '../../../../platform/ade/common/adeRankResize.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, normalizeAdeEngineId, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import { createDecorator, IInstantiationService, ServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { ADE_SECRETARY_ID, AdeEngineeringViewMode, encodeAdeEngineeringInputSpec, IAdeAgent, IAdeEditorService, IAdeProjectsService } from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { AdeEngineeringEditorInput } from './adeEngineeringEditorPane.js';
import { IAdePendingMissionNodeFocus, inferEngineeringViewModeForNode } from './adeEngineeringViewLinkage.js';
import { IAdeSessionsService } from './adeSessionsService.js';

/** Legacy monolithic single-key storage (auto-migrated to v2 hot index + cold per-Mission files). */
export const ADE_MISSIONS_LEGACY_STORAGE_KEY = 'aexus.ade.missions.v1';
/** Lightweight hot index stored in Application storage (metadata only — no Mermaid, tokens, traces, or revisions). */
export const ADE_MISSIONS_INDEX_STORAGE_KEY = 'aexus.ade.missions.index.v2';
/** Per-Mission cold payload key prefix used when Node file backend is unavailable (browser/in-memory tests). */
export const ADE_MISSION_RECORD_STORAGE_PREFIX = 'aexus.ade.mission.v2.';

export interface IAdeMissionIndexEntry {
	readonly id: string;
	readonly title: string;
	readonly ownerSessionId?: string;
	readonly ownerTier: number;
	readonly ownerRankId?: string;
	readonly linkedSessionId?: string;
	readonly projectUri?: string;
	readonly status?: string;
	readonly runCount?: number;
	readonly totalCostUsd?: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

interface IAdeMissionIndexEnvelope {
	readonly version: 2;
	readonly writerId?: string;
	readonly coldBackend?: 'file' | 'storage';
	readonly updatedIds?: readonly string[];
	readonly removedIds?: readonly string[];
	readonly entries: readonly IAdeMissionIndexEntry[];
}

export interface IAdeMissionRecord {
	readonly id: string;
	readonly title: string;
	/** Mission view: strictly acyclic Mermaid Task DAG source. */
	readonly mermaidText: string;
	/** Mission view: per-task detailed descriptions (taskNodeId -> description). */
	readonly nodePrompts?: Readonly<Record<string, string>>;
	/** Mission view: per-task completion status records (marked completed by highest-rank role). */
	readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
	/** Per-node zero-cost deterministic verification hooks (nodeId -> hooks). */
	readonly nodeChecks?: Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
	/** Mission view: manual task node positions on canvas. */
	readonly positions: Readonly<Record<string, IMissionNodePosition>>;
	/** Orchestration view: cyclic all-staff declarative topology (Mermaid with cycles, `<-->`, departments, whiteboards). */
	readonly orchestrationText?: string;
	/** Orchestration view: visual presentation layout mode (does NOT mutate `orchestrationText`). */
	readonly orchestrationLayoutMode?: OrchestrationLayoutMode;
	/** Orchestration view: manual staff & whiteboard positions on canvas. */
	readonly orchestrationPositions?: Readonly<Record<string, IMissionNodePosition>>;
	/** Orchestration view: Department Shared Whiteboards (referenced via lightweight pointers in tokens). */
	readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
	/** Orchestration view: all-staff cyclic re-entrant token runtime state. */
	readonly orchestrationRuntime?: IOrchestrationRuntimeState;
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
	/** True when the caller is the top-rank staff member (e.g. L1) bound to this Mission's Orchestration canvas. */
	readonly isTopRankOrchestrationStaff?: boolean;
	/** True when the caller is any staff member bound to this Mission's Orchestration canvas. */
	readonly isOrchestrationMember?: boolean;
}

export interface IAdeMissionRemoveResult {
	readonly deleted: boolean;
	readonly id: string;
	readonly removedEmployeeIds: readonly string[];
}

/**
 * Enforces strict Mission ownership authority for destructive / structural blueprint writes:
 * - Human User (L-1) always retains full authority.
 * - On User-created standalone Orchestration workspaces (`ownerSessionId` empty or `ownerTier <= L-1`),
 *   the highest-rank staff role on that Orchestration canvas (e.g. L1 Chief Architect / Governor)
 *   holds full operational authority (including `mission.blueprint.apply`, `mission.open`, `mission.rename`).
 * - Otherwise, only the exact owner session (L0 or L1..LN) may overwrite/delete its Mission orchestration.
 */
export function canCallerOperateMission(mission: IAdeMissionRecord, caller: IAdeMissionCaller): boolean {
	if (caller.isHumanUser) {
		return true;
	}
	if (caller.isTopRankOrchestrationStaff && Boolean(mission.orchestrationText?.trim())) {
		if (!mission.ownerSessionId || mission.ownerTier <= ADE_USER_TIER || (caller.callerSessionId && caller.callerSessionId === mission.ownerSessionId)) {
			return true;
		}
	}
	if (mission.ownerTier <= ADE_USER_TIER || !mission.ownerSessionId) {
		return false;
	}
	if (caller.isSecretary) {
		return mission.ownerSessionId === ADE_SECRETARY_ID;
	}
	return Boolean(caller.callerSessionId && caller.callerSessionId === mission.ownerSessionId);
}

/**
 * Authorizes read-only Mission topology inspection (`mission.get`, `mission.blueprint.get`):
 * Human User (L-1), Secretary (L0), the Mission owner, any Orchestration staff member bound to
 * this workspace, and any bound off-graph supervisor of the Mission may inspect its Mermaid DAG.
 */
export function canCallerReadMission(
	mission: IAdeMissionRecord,
	caller: IAdeMissionCaller,
	runtime?: Pick<IMissionRuntimeState, 'boundary'>,
): boolean {
	if (caller.isHumanUser || caller.isSecretary || caller.isOrchestrationMember || canCallerOperateMission(mission, caller)) {
		return true;
	}
	const callerId = caller.callerSessionId;
	if (!callerId) {
		return false;
	}
	const effectiveBoundary = runtime?.boundary ?? mission.runtime?.boundary;
	return Boolean(effectiveBoundary?.supervisors.some(sup => sup.id === callerId));
}

export const IAdeMissionService = createDecorator<IAdeMissionService>('adeMissionService');

/**
 * Pure frontend Mission catalog backed by `IStorageService`, with strict owner-only orchestration
 * metadata and locked Mermaid-generated employee syncing in the left sidebar.
 */
export interface IAdeMissionOpenOptions {
	readonly side?: boolean;
	readonly viewMode?: AdeEngineeringViewMode;
	readonly openSiblingViews?: boolean;
	readonly focusNodeId?: string;
	readonly focusTokenId?: string;
	readonly highlightNodeIds?: readonly string[];
	readonly preferExistingGroup?: boolean;
	readonly openPopover?: 'task' | 'token' | 'whiteboard';
	readonly whiteboardSection?: string;
	readonly inspectorTab?: 'overview' | 'token' | 'distill' | 'finops';
	readonly openAgentBeside?: boolean;
}

export interface IAdeMissionService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** Fires when Mission state is reloaded from another window's storage write (no local re-persist). */
	readonly onDidChangeExternal?: Event<void>;
	/** Resolves once initial async cold-file hydration completes (instant when using pure storage fallback). */
	whenHydrated?(): Promise<void>;

	listMissions(): readonly IAdeMissionRecord[];
	getMission(id: string): IAdeMissionRecord | undefined;
	getMissionByLinkedSession(sessionId: string): IAdeMissionRecord | undefined;
	getGeneratedEmployees(idOrOwnerId: string): readonly IAdeAgent[];
	createMission(options?: {
		readonly id?: string;
		readonly title?: string;
		readonly mermaidText?: string;
		readonly orchestrationText?: string;
		readonly nodePrompts?: Readonly<Record<string, string>>;
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
	updateNodePrompt(id: string, nodeId: string, prompt: string): IAdeMissionRecord | undefined;
	updateNodePrompts(id: string, prompts: Readonly<Record<string, string>>): IAdeMissionRecord | undefined;
	replaceNodePrompts?(id: string, prompts: Readonly<Record<string, string>> | undefined): IAdeMissionRecord | undefined;
	updateTaskStatuses(id: string, taskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>>, options?: { readonly deferPersist?: boolean; readonly silent?: boolean }): IAdeMissionRecord | undefined;
	updateOrchestrationText(id: string, orchestrationText: string, options?: { readonly replaceWhiteboards?: boolean; readonly replacePositions?: boolean }): IAdeMissionRecord | undefined;
	updateOrchestrationLayoutMode?(id: string, layoutMode: OrchestrationLayoutMode): IAdeMissionRecord | undefined;
	ensureOrchestrationStaffSynced?(id: string): void;
	updateOrchestrationPositions(id: string, positions: Readonly<Record<string, IMissionNodePosition>>): IAdeMissionRecord | undefined;
	removeOrchestrationPositions?(id: string, nodeIds: readonly string[]): IAdeMissionRecord | undefined;
	clearOrchestrationPositions(id: string): IAdeMissionRecord | undefined;
	updateWhiteboards(id: string, whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>>): IAdeMissionRecord | undefined;
	updateOrchestrationRuntime(id: string, orchestrationRuntime: IOrchestrationRuntimeState | undefined, options?: { readonly deferPersist?: boolean; readonly silent?: boolean }): IAdeMissionRecord | undefined;
	updateNodeChecks(id: string, nodeId: string, checks: readonly IMissionNodeCheckHook[]): IAdeMissionRecord | undefined;
	replaceAllNodeChecks?(id: string, checks: Readonly<Record<string, readonly IMissionNodeCheckHook[]>> | undefined): IAdeMissionRecord | undefined;
	upsertNodeCheck(id: string, nodeId: string, check: IMissionNodeCheckHook): IAdeMissionRecord | undefined;
	removeNodeCheck(id: string, nodeId: string, checkId?: string): IAdeMissionRecord | undefined;
	updateRuntime(id: string, runtime: IMissionRuntimeState | undefined, options?: { readonly deferPersist?: boolean }): IAdeMissionRecord | undefined;
	updateNodePositions(id: string, positions: Readonly<Record<string, IMissionNodePosition>>): IAdeMissionRecord | undefined;
	clearNodePositions(id: string): IAdeMissionRecord | undefined;
	renameMission(id: string, title: string): IAdeMissionRecord | undefined;
	deleteMission(id: string): boolean;
	removeMissionWithEmployees(id: string, options?: { readonly deleteEngineHistory?: boolean }): Promise<IAdeMissionRemoveResult>;
	openMissionEditor(id: string, options?: IAdeMissionOpenOptions): Promise<void>;
	batch?<T>(fn: () => T): T;
	flushPersist?(): Promise<void>;
}

export class AdeMissionStoreService extends Disposable implements IAdeMissionService {
	declare readonly _serviceBrand: undefined;

	private readonly writerId = generateUuid();
	private readonly records = new Map<string, IAdeMissionRecord>();
	private readonly dirtyMissionIds = new Set<string>();
	private readonly deletedMissionIds = new Set<string>();
	private readonly hydratedColdIds = new Set<string>();
	/** Missions seeded solely from the lightweight hot index awaiting cold-file hydration (never overwritten onto disk as empty stubs). */
	private readonly indexOnlyIds = new Set<string>();
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidChangeExternal = this._register(new Emitter<void>());
	readonly onDidChangeExternal = this._onDidChangeExternal.event;
	private isPersisting = false;
	private batchDepth = 0;
	private batchNeedsPersist = false;
	private readonly pendingColdOps = new Set<Promise<void>>();
	/** Compact 64-bit content fingerprints for O(1) self-echo filtering without retaining full JSON copies in RAM. */
	private readonly recentSavedFingerprints = new Set<string>();
	private deferredPersistTimer: ReturnType<typeof setTimeout> | undefined;
	private coldHydrationPromise: Promise<void> | undefined;
	private migratedLegacyIds: string[] = [];

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchModeService private readonly modeService: IWorkbenchModeService,
	) {
		super();
		this.loadFromStorage();
		if (typeof this.storageService.onWillSaveState === 'function') {
			this._register(this.storageService.onWillSaveState(() => {
				if (this.deferredPersistTimer !== undefined || this.dirtyMissionIds.size > 0 || this.deletedMissionIds.size > 0) {
					this.persist();
				}
			}));
		}
		this._register({
			dispose: () => {
				if (this.deferredPersistTimer !== undefined || this.dirtyMissionIds.size > 0 || this.deletedMissionIds.size > 0) {
					if (this.deferredPersistTimer !== undefined) {
						clearTimeout(this.deferredPersistTimer);
						this.deferredPersistTimer = undefined;
					}
					this.persist();
				}
			},
		});
		if (typeof this.storageService.onDidChangeValue === 'function') {
			this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, ADE_MISSIONS_INDEX_STORAGE_KEY, this._store)(() => {
				this.handleExternalIndexChange();
			}));
			this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, ADE_MISSIONS_LEGACY_STORAGE_KEY, this._store)(() => {
				this.handleExternalLegacyBlobChange();
			}));
		}
		queueMicrotask(() => {
			if (this._store.isDisposed) {
				return;
			}
			this.attachColdBackendAndHydrate();
		});
	}

	private tryGet<T>(id: ServiceIdentifier<T>): T | undefined {
		try {
			return this.instantiationService.invokeFunction(accessor => accessor.get(id));
		} catch {
			return undefined;
		}
	}

	private get backendService(): IAdeEngineeringBackendService | undefined {
		return this.tryGet(IAdeEngineeringBackendService);
	}

	private hasColdFileBackend(): boolean {
		const backend = this.backendService;
		return Boolean(backend?.saveMissionRecord && backend?.loadAllMissionRecords);
	}

	whenHydrated(): Promise<void> {
		if (!this.coldHydrationPromise && this.hasColdFileBackend()) {
			this.attachColdBackendAndHydrate();
		}
		return this.coldHydrationPromise ?? Promise.resolve();
	}

	batch<T>(fn: () => T): T {
		this.batchDepth++;
		try {
			return fn();
		} finally {
			this.batchDepth = Math.max(0, this.batchDepth - 1);
			if (this.batchDepth === 0 && (this.batchNeedsPersist || this.dirtyMissionIds.size > 0 || this.deletedMissionIds.size > 0)) {
				this.batchNeedsPersist = false;
				this.persist();
			}
		}
	}

	async flushPersist(): Promise<void> {
		if (this.batchDepth === 0 && (this.deferredPersistTimer !== undefined || this.dirtyMissionIds.size > 0 || this.deletedMissionIds.size > 0)) {
			this.persist();
		}
		if (this.pendingColdOps.size > 0) {
			await Promise.allSettled([...this.pendingColdOps]);
		}
	}

	private trackColdMissionOp(op: () => Promise<void>): void {
		let promise: Promise<void>;
		try {
			promise = Promise.resolve(op()).catch(() => undefined);
		} catch {
			return;
		}
		this.pendingColdOps.add(promise);
		void promise.finally(() => {
			this.pendingColdOps.delete(promise);
		});
	}

	private attachColdBackendAndHydrate(): void {
		if (this.coldHydrationPromise || this._store.isDisposed) {
			return;
		}
		const backend = this.backendService;
		if (!backend?.saveMissionRecord || !backend?.loadAllMissionRecords) {
			if (this.migratedLegacyIds.length > 0) {
				for (const mid of this.migratedLegacyIds) {
					if (this.records.has(mid)) {
						this.dirtyMissionIds.add(mid);
					}
				}
				this.migratedLegacyIds = [];
				this.persist();
			}
			this.coldHydrationPromise = Promise.resolve();
			return;
		}
		if (backend.onDidMissionRecordChange) {
			this._register(backend.onDidMissionRecordChange(ev => {
				if (this._store.isDisposed || ev.writerId === this.writerId) {
					return;
				}
				void this.handleExternalColdFileChange(ev.missionId, ev.updatedAt, Boolean(ev.deleted), ev.writerId);
			}));
		}
		this.coldHydrationPromise = this.hydrateFromColdFiles(backend).catch(() => undefined);
	}

	private async hydrateFromColdFiles(backend: IAdeEngineeringBackendService): Promise<void> {
		const rawMap = await backend.loadAllMissionRecords?.();
		if (this._store.isDisposed) {
			return;
		}
		let changed = false;
		const storageKeysToPurge: string[] = [];
		const toMigrateToFile: IAdeMissionRecord[] = [];
		if (rawMap) {
			for (const [missionId, rawJson] of Object.entries(rawMap)) {
				if (this.deletedMissionIds.has(missionId)) {
					continue;
				}
				let parsedRaw: unknown;
				try {
					parsedRaw = JSON.parse(rawJson);
				} catch {
					continue;
				}
				const record = this.sanitizeMissionRecord(parsedRaw);
				if (!record) {
					continue;
				}
				const existing = this.records.get(record.id);
				const wasIndexOnly = this.indexOnlyIds.has(record.id);
				const isLocallyDirty = this.dirtyMissionIds.has(record.id);
				if (wasIndexOnly) {
					this.indexOnlyIds.delete(record.id);
					this.hydratedColdIds.add(record.id);
					const merged = (isLocallyDirty && existing && existing.updatedAt >= record.updatedAt)
						? {
							...record,
							title: existing.title || record.title,
							...(existing.mermaidText ? { mermaidText: existing.mermaidText } : {}),
							...(Object.keys(existing.positions).length > 0 ? { positions: { ...record.positions, ...existing.positions } } : {}),
							...(existing.nodePrompts ? { nodePrompts: { ...record.nodePrompts, ...existing.nodePrompts } } : {}),
							...(existing.nodeChecks ? { nodeChecks: { ...record.nodeChecks, ...existing.nodeChecks } } : {}),
							...(existing.taskStatuses ? { taskStatuses: { ...record.taskStatuses, ...existing.taskStatuses } } : {}),
							...(existing.orchestrationText ? { orchestrationText: existing.orchestrationText } : {}),
							...(existing.orchestrationPositions ? { orchestrationPositions: { ...record.orchestrationPositions, ...existing.orchestrationPositions } } : {}),
							...(existing.whiteboards ? { whiteboards: { ...record.whiteboards, ...existing.whiteboards } } : {}),
							...(existing.orchestrationRuntime ? { orchestrationRuntime: existing.orchestrationRuntime } : {}),
							...(existing.runtime ? { runtime: existing.runtime } : {}),
							updatedAt: Math.max(record.updatedAt, existing.updatedAt),
						}
						: record;
					this.records.set(record.id, merged);
					if (isLocallyDirty && merged !== record) {
						toMigrateToFile.push(merged);
					}
					changed = true;
				} else if (isLocallyDirty && existing && existing.updatedAt >= record.updatedAt) {
					continue;
				} else if (!existing || record.updatedAt > existing.updatedAt) {
					this.records.set(record.id, record);
					this.hydratedColdIds.add(record.id);
					changed = true;
				}
				storageKeysToPurge.push(`${ADE_MISSION_RECORD_STORAGE_PREFIX}${record.id}`);
			}
		}

		// Flush any records migrated from legacy single-key storage or per-key storage into independent cold files.
		for (const mid of this.migratedLegacyIds) {
			const rec = this.records.get(mid);
			if (rec && !this.deletedMissionIds.has(mid) && !this.indexOnlyIds.has(mid) && !toMigrateToFile.some(m => m.id === mid)) {
				toMigrateToFile.push(rec);
			}
		}
		this.migratedLegacyIds = [];
		for (const rec of this.records.values()) {
			const hasOnDisk = Boolean(rawMap && Object.hasOwn(rawMap, rec.id));
			if (!hasOnDisk && !this.deletedMissionIds.has(rec.id) && this.hydratedColdIds.has(rec.id) && !this.indexOnlyIds.has(rec.id) && !toMigrateToFile.some(m => m.id === rec.id)) {
				toMigrateToFile.push(rec);
			}
		}
		if (toMigrateToFile.length > 0 && backend.saveMissionRecord) {
			await Promise.all(toMigrateToFile.map(async rec => {
				const compact = rec.runtime ? { ...rec, runtime: this.compactRuntimeForStorage(rec.runtime) } : rec;
				await backend.saveMissionRecord!(rec.id, JSON.stringify(compact), rec.updatedAt, this.writerId);
				this.hydratedColdIds.add(rec.id);
				storageKeysToPurge.push(`${ADE_MISSION_RECORD_STORAGE_PREFIX}${rec.id}`);
			}));
			this.writeHotIndexOnly([], [], 'file');
		}
		if (storageKeysToPurge.length > 0 && !this._store.isDisposed) {
			this.isPersisting = true;
			try {
				for (const k of storageKeysToPurge) {
					if (this.storageService.get(k, StorageScope.APPLICATION) !== undefined) {
						this.storageService.remove(k, StorageScope.APPLICATION);
					}
				}
				if (this.storageService.get(ADE_MISSIONS_LEGACY_STORAGE_KEY, StorageScope.APPLICATION) !== undefined) {
					this.storageService.remove(ADE_MISSIONS_LEGACY_STORAGE_KEY, StorageScope.APPLICATION);
				}
			} finally {
				this.isPersisting = false;
			}
		}
		if (changed && !this._store.isDisposed) {
			this.writeHotIndexOnly([], [], 'file');
			const projects = this.projectsService;
			if (projects) {
				for (const rec of this.records.values()) {
					if (rec.ownerSessionId && rec.ownerSessionId !== ADE_SECRETARY_ID && rec.orchestrationText?.trim() && projects.getAgent(rec.ownerSessionId)) {
						this.syncSidebarEmployeesForRecord(rec);
					}
				}
			}
			this._onDidChange.fire();
		}
	}

	private async handleExternalColdFileChange(missionId: string, updatedAt: number, deleted: boolean, writerId?: string): Promise<void> {
		if (deleted) {
			const localRec = this.records.get(missionId);
			if (this.dirtyMissionIds.has(missionId) && localRec && localRec.updatedAt > updatedAt) {
				return;
			}
			if (this.records.delete(missionId)) {
				this.hydratedColdIds.delete(missionId);
				this.indexOnlyIds.delete(missionId);
				this.dirtyMissionIds.delete(missionId);
				this._onDidChangeExternal.fire();
				this._onDidChange.fire();
			}
			return;
		}
		const rawJson = await this.backendService?.loadMissionRecord?.(missionId);
		if (this._store.isDisposed || !rawJson) {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawJson);
		} catch {
			return;
		}
		const extRec = this.sanitizeMissionRecord(parsed);
		if (!extRec) {
			return;
		}
		const localRec = this.records.get(extRec.id);
		const isHeadlessDaemon = writerId === 'headless-daemon';
		if (localRec && !this.indexOnlyIds.has(extRec.id)) {
			const skewToleranceMs = isHeadlessDaemon && !this.dirtyMissionIds.has(extRec.id) ? 5_000 : 0;
			if (extRec.updatedAt + skewToleranceMs < localRec.updatedAt) {
				return;
			}
		}
		if (this.dirtyMissionIds.has(extRec.id) && localRec) {
			if (localRec.updatedAt >= extRec.updatedAt) {
				return;
			}
			// Preserve unpersisted local structural edits (canvas/prompts/checks/whiteboards) while adopting
			// fresher external runtime/orchestration/task progress, and keep the record dirty for flush.
			const merged: IAdeMissionRecord = {
				...extRec,
				title: localRec.title,
				mermaidText: localRec.mermaidText,
				orchestrationText: localRec.orchestrationText,
				positions: localRec.positions,
				orchestrationPositions: localRec.orchestrationPositions,
				orchestrationLayoutMode: localRec.orchestrationLayoutMode,
				nodePrompts: localRec.nodePrompts,
				nodeChecks: localRec.nodeChecks,
				whiteboards: localRec.whiteboards,
				updatedAt: Math.max(localRec.updatedAt, extRec.updatedAt) + 1,
			};
			this.indexOnlyIds.delete(extRec.id);
			this.records.set(extRec.id, merged);
			this.hydratedColdIds.add(extRec.id);
			this.dirtyMissionIds.add(extRec.id);
			this.persist();
			this._onDidChangeExternal.fire();
			this._onDidChange.fire();
			return;
		}
		this.dirtyMissionIds.delete(extRec.id);
		this.indexOnlyIds.delete(extRec.id);
		this.records.set(extRec.id, extRec);
		this.hydratedColdIds.add(extRec.id);
		this._onDidChangeExternal.fire();
		this._onDidChange.fire();
	}

	private handleExternalIndexChange(): void {
		if (this.isPersisting) {
			return;
		}
		const raw = this.storageService.get(ADE_MISSIONS_INDEX_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return;
		}
		const fp = computeAdeStorageFingerprint(raw);
		if (this.recentSavedFingerprints.has(fp)) {
			this.recentSavedFingerprints.delete(fp);
			return;
		}
		let envelope: IAdeMissionIndexEnvelope | undefined;
		try {
			const parsed = JSON.parse(raw) as Partial<IAdeMissionIndexEnvelope>;
			if (parsed && parsed.version === 2 && Array.isArray(parsed.entries)) {
				envelope = parsed as IAdeMissionIndexEnvelope;
			}
		} catch {
			return;
		}
		if (!envelope || envelope.writerId === this.writerId) {
			return;
		}
		const preservedDirty = new Map<string, IAdeMissionRecord>();
		for (const dirtyId of this.dirtyMissionIds) {
			const localRec = this.records.get(dirtyId);
			if (localRec) {
				preservedDirty.set(dirtyId, localRec);
			}
		}

		// Drive deletions strictly from explicit `removedIds` tombstones whenever delta metadata arrays
		// are present (including empty `[]`), so a slightly stale peer index never wipes concurrently created local Missions.
		const hasExplicitTombstones = Array.isArray(envelope.removedIds) || Array.isArray(envelope.updatedIds);
		if (hasExplicitTombstones) {
			for (const removedId of envelope.removedIds ?? []) {
				if (!preservedDirty.has(removedId)) {
					this.records.delete(removedId);
					this.hydratedColdIds.delete(removedId);
					this.indexOnlyIds.delete(removedId);
				}
			}
		} else if (envelope.entries.length > 0) {
			const indexIds = new Set(envelope.entries.map(e => e.id));
			for (const existingId of [...this.records.keys()]) {
				if (!indexIds.has(existingId) && !preservedDirty.has(existingId)) {
					this.records.delete(existingId);
					this.hydratedColdIds.delete(existingId);
					this.indexOnlyIds.delete(existingId);
				}
			}
		}
		if (envelope.coldBackend === 'file' && this.hasColdFileBackend()) {
			const changedIds = Array.isArray(envelope.updatedIds)
				? envelope.updatedIds
				: envelope.entries.map(e => e.id);
			for (const entry of envelope.entries) {
				if (!this.records.has(entry.id)) {
					this.records.set(entry.id, this.recordFromIndexEntry(entry));
					this.indexOnlyIds.add(entry.id);
				}
			}
			for (const id of changedIds) {
				if (!preservedDirty.has(id)) {
					const entry = envelope.entries.find(e => e.id === id);
					void this.handleExternalColdFileChange(id, entry?.updatedAt ?? Date.now(), false);
				}
			}
			return;
		}

		// Per-Mission storage fallback: reload ONLY the changed/missing Mission keys (never re-parse untouched Missions!).
		const idsToReload = new Set<string>(envelope.updatedIds ?? []);
		if (idsToReload.size === 0) {
			for (const entry of envelope.entries) {
				const existing = this.records.get(entry.id);
				if (!existing || existing.updatedAt !== entry.updatedAt || existing.title !== entry.title) {
					idsToReload.add(entry.id);
				}
			}
		}
		for (const entry of envelope.entries) {
			if (!idsToReload.has(entry.id) && this.records.has(entry.id)) {
				continue;
			}
			const coldRaw = this.storageService.get(`${ADE_MISSION_RECORD_STORAGE_PREFIX}${entry.id}`, StorageScope.APPLICATION);
			let extRec: IAdeMissionRecord | undefined;
			if (coldRaw) {
				try {
					extRec = this.sanitizeMissionRecord(JSON.parse(coldRaw));
				} catch {
					extRec = undefined;
				}
			}
			extRec ??= this.recordFromIndexEntry(entry);
			const localDirty = preservedDirty.get(entry.id);
			if (localDirty && localDirty.updatedAt >= extRec.updatedAt) {
				this.records.set(entry.id, localDirty);
			} else {
				this.dirtyMissionIds.delete(entry.id);
				this.records.set(entry.id, extRec);
				this.hydratedColdIds.add(entry.id);
			}
		}
		if (this.dirtyMissionIds.size > 0) {
			this.scheduleDeferredPersist();
		}
		this._onDidChangeExternal.fire();
		this._onDidChange.fire();
	}

	private handleExternalLegacyBlobChange(): void {
		if (this.isPersisting) {
			return;
		}
		const raw = this.storageService.get(ADE_MISSIONS_LEGACY_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return;
		}
		const fp = computeAdeStorageFingerprint(raw);
		if (this.recentSavedFingerprints.has(fp)) {
			this.recentSavedFingerprints.delete(fp);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		if (!Array.isArray(parsed)) {
			return;
		}
		const preservedDirty = new Map<string, IAdeMissionRecord>();
		for (const dirtyId of this.dirtyMissionIds) {
			const localRec = this.records.get(dirtyId);
			if (localRec) {
				preservedDirty.set(dirtyId, localRec);
			}
		}
		const incomingIds = new Set<string>();
		for (const entry of parsed) {
			const extRec = this.sanitizeMissionRecord(entry);
			if (!extRec) {
				continue;
			}
			incomingIds.add(extRec.id);
			const localDirty = preservedDirty.get(extRec.id);
			if (localDirty && localDirty.updatedAt >= extRec.updatedAt) {
				this.records.set(extRec.id, localDirty);
			} else {
				this.dirtyMissionIds.delete(extRec.id);
				this.records.set(extRec.id, extRec);
				this.hydratedColdIds.add(extRec.id);
			}
		}
		for (const existingId of [...this.records.keys()]) {
			if (!incomingIds.has(existingId) && !preservedDirty.has(existingId)) {
				this.records.delete(existingId);
				this.hydratedColdIds.delete(existingId);
			}
		}
		if (this.dirtyMissionIds.size > 0) {
			this.scheduleDeferredPersist();
		}
		this._onDidChangeExternal.fire();
		this._onDidChange.fire();
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

	private recordFromIndexEntry(entry: IAdeMissionIndexEntry): IAdeMissionRecord {
		return {
			id: entry.id,
			title: entry.title || 'Untitled',
			mermaidText: '',
			positions: {},
			...(entry.ownerSessionId ? { ownerSessionId: entry.ownerSessionId, linkedSessionId: entry.ownerSessionId } : {}),
			ownerTier: entry.ownerTier,
			...(entry.ownerRankId ? { ownerRankId: entry.ownerRankId } : {}),
			...(entry.projectUri ? { projectUri: entry.projectUri } : {}),
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
		};
	}

	private toIndexEntry(record: IAdeMissionRecord): IAdeMissionIndexEntry {
		const legacyCost = record.runtime ? computeMissionTotalCostUsd(record.runtime) : 0;
		const orchCost = typeof record.orchestrationRuntime?.totalCostUsd === 'number' && Number.isFinite(record.orchestrationRuntime.totalCostUsd)
			? record.orchestrationRuntime.totalCostUsd
			: 0;
		const totalCostUsd = Math.max(legacyCost, orchCost);
		const runCount = record.runtime
			? ((record.runtime.runHistory?.length ?? 0) + (record.runtime.startedAt !== undefined ? 1 : 0))
			: 0;
		return {
			id: record.id,
			title: record.title,
			...(record.ownerSessionId ? { ownerSessionId: record.ownerSessionId, linkedSessionId: record.ownerSessionId } : {}),
			ownerTier: record.ownerTier,
			...(record.ownerRankId ? { ownerRankId: record.ownerRankId } : {}),
			...(record.projectUri ? { projectUri: record.projectUri } : {}),
			...(record.runtime?.status ? { status: record.runtime.status } : {}),
			...(runCount > 0 ? { runCount } : {}),
			...(totalCostUsd !== undefined && totalCostUsd > 0 ? { totalCostUsd } : {}),
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
		};
	}

	private sanitizeMissionRecord(rawEntry: unknown): IAdeMissionRecord | undefined {
		if (!rawEntry || typeof rawEntry !== 'object') {
			return undefined;
		}
		const entry = rawEntry as Record<string, unknown>;
		if (typeof entry.id !== 'string' || !entry.id.trim()) {
			return undefined;
		}
		const id = entry.id.trim();
		const ownerSessionId = typeof entry.ownerSessionId === 'string' && entry.ownerSessionId.trim()
			? entry.ownerSessionId.trim()
			: (typeof entry.linkedSessionId === 'string' && entry.linkedSessionId.trim() ? entry.linkedSessionId.trim() : undefined);
		const ownerTier = typeof entry.ownerTier === 'number' && Number.isFinite(entry.ownerTier)
			? Math.floor(entry.ownerTier)
			: (ownerSessionId === ADE_SECRETARY_ID ? ADE_SECRETARY_TIER : ownerSessionId ? 1 : ADE_USER_TIER);
		const ownerRankId = typeof entry.ownerRankId === 'string' && entry.ownerRankId.trim()
			? entry.ownerRankId.trim()
			: (ownerTier <= ADE_USER_TIER ? 'user' : ownerTier === ADE_SECRETARY_TIER ? 'secretary' : undefined);
		const sanitizedPrompts: Record<string, string> = {};
		if (entry.nodePrompts && typeof entry.nodePrompts === 'object') {
			for (const [nid, val] of Object.entries(entry.nodePrompts as Record<string, unknown>)) {
				if (typeof val === 'string' && val.trim()) {
					sanitizedPrompts[nid] = val;
				}
			}
		}
		const sanitizedChecks: Record<string, IMissionNodeCheckHook[]> = {};
		if (entry.nodeChecks && typeof entry.nodeChecks === 'object') {
			for (const [nid, list] of Object.entries(entry.nodeChecks as Record<string, unknown>)) {
				if (!Array.isArray(list)) {
					continue;
				}
				const cleanList: IMissionNodeCheckHook[] = [];
				for (const rawHook of list) {
					if (!rawHook || typeof rawHook !== 'object') {
						continue;
					}
					const h = rawHook as Record<string, unknown>;
					const hookId = typeof h.id === 'string' && h.id.trim() ? h.id.trim() : '';
					const command = typeof h.command === 'string' && h.command.trim() ? h.command.trim() : undefined;
					const expectFiles = Array.isArray(h.expectFiles)
						? h.expectFiles.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).map(f => f.trim())
						: undefined;
					if (!hookId || (!command && (!expectFiles || expectFiles.length === 0))) {
						continue;
					}
					const onFailRaw = typeof h.onFail === 'string' ? h.onFail.trim().toLowerCase() : undefined;
					const onFail = (onFailRaw === 'bounce' || onFailRaw === 'fail' || onFailRaw === 'escalate') ? onFailRaw : undefined;
					cleanList.push({
						id: hookId,
						...(typeof h.name === 'string' && h.name.trim() ? { name: h.name.trim() } : {}),
						...(command ? { command } : {}),
						...(typeof h.expectExitCode === 'number' && Number.isInteger(h.expectExitCode) ? { expectExitCode: h.expectExitCode } : {}),
						...(typeof h.cwd === 'string' && h.cwd.trim() ? { cwd: h.cwd.trim() } : {}),
						...(typeof h.hostAlias === 'string' && h.hostAlias.trim() ? { hostAlias: h.hostAlias.trim() } : {}),
						...(expectFiles && expectFiles.length > 0 ? { expectFiles } : {}),
						...(typeof h.expectOutputMatch === 'string' && h.expectOutputMatch.trim() ? { expectOutputMatch: h.expectOutputMatch.trim() } : {}),
						...(typeof h.timeoutMs === 'number' && Number.isFinite(h.timeoutMs) ? { timeoutMs: Math.max(1_000, Math.min(300_000, Math.round(h.timeoutMs))) } : {}),
						...(onFail ? { onFail } : {}),
						...(typeof h.maxAutoRetries === 'number' && Number.isInteger(h.maxAutoRetries) ? { maxAutoRetries: Math.max(0, Math.min(5, h.maxAutoRetries)) } : {}),
						...(typeof h.enabled === 'boolean' ? { enabled: h.enabled } : {}),
						source: 'config',
					});
				}
				if (cleanList.length > 0) {
					sanitizedChecks[nid] = cleanList;
				}
			}
		}
		const sanitizedTaskStatuses: Record<string, IMissionTaskStatusRecord> = {};
		if (entry.taskStatuses && typeof entry.taskStatuses === 'object') {
			for (const [tid, rawRec] of Object.entries(entry.taskStatuses as Record<string, unknown>)) {
				if (!rawRec || typeof rawRec !== 'object') {
					continue;
				}
				const r = rawRec as Record<string, unknown>;
				const st = r.status;
				if (st === 'pending' || st === 'in_progress' || st === 'completed' || st === 'blocked') {
					const activeTokenIds = Array.isArray(r.activeTokenIds)
						? r.activeTokenIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
						: undefined;
					const artifactPtrs = Array.isArray(r.artifactPtrs)
						? r.artifactPtrs.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
						: undefined;
					sanitizedTaskStatuses[tid] = {
						status: st,
						...(typeof r.completedBy === 'string' && r.completedBy ? { completedBy: r.completedBy } : {}),
						...(typeof r.completedByLabel === 'string' && r.completedByLabel ? { completedByLabel: r.completedByLabel } : {}),
						...(typeof r.completedByTier === 'number' && Number.isFinite(r.completedByTier) ? { completedByTier: r.completedByTier } : {}),
						...(typeof r.completedAt === 'number' && Number.isFinite(r.completedAt) ? { completedAt: r.completedAt } : {}),
						...(typeof r.note === 'string' && r.note.trim() ? { note: r.note.trim() } : {}),
						...(typeof r.assigneeNodeId === 'string' && r.assigneeNodeId.trim() ? { assigneeNodeId: r.assigneeNodeId.trim() } : {}),
						...(typeof r.assigneeLabel === 'string' && r.assigneeLabel.trim() ? { assigneeLabel: r.assigneeLabel.trim() } : {}),
						...(activeTokenIds && activeTokenIds.length > 0 ? { activeTokenIds } : {}),
						...(typeof r.lastTokenId === 'string' && r.lastTokenId.trim() ? { lastTokenId: r.lastTokenId.trim() } : {}),
						...(typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) ? { startedAt: r.startedAt } : {}),
						...(typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? { durationMs: r.durationMs } : {}),
						...(artifactPtrs && artifactPtrs.length > 0 ? { artifactPtrs } : {}),
						...(typeof r.blockedReason === 'string' && r.blockedReason.trim() ? { blockedReason: r.blockedReason.trim() } : {}),
						...(typeof r.lastError === 'string' && r.lastError.trim() ? { lastError: r.lastError.trim() } : {}),
						...(r.lastCheckReceipt && typeof r.lastCheckReceipt === 'object' ? { lastCheckReceipt: r.lastCheckReceipt as never } : {}),
						updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now(),
					};
				}
			}
		}
		const sanitizedWhiteboards: Record<string, IOrchestrationWhiteboard> = {};
		if (entry.whiteboards && typeof entry.whiteboards === 'object') {
			for (const [wid, rawWb] of Object.entries(entry.whiteboards as Record<string, unknown>)) {
				if (!rawWb || typeof rawWb !== 'object') {
					continue;
				}
				const w = rawWb as Record<string, unknown>;
				const wbId = typeof w.id === 'string' && w.id.trim() ? w.id.trim() : wid.trim();
				if (!wbId) {
					continue;
				}
				sanitizedWhiteboards[wbId] = {
					id: wbId,
					title: typeof w.title === 'string' && w.title.trim() ? w.title.trim() : wbId,
					department: typeof w.department === 'string' && w.department.trim() ? w.department.trim() : 'General',
					content: typeof w.content === 'string' ? w.content : '',
					version: typeof w.version === 'number' && Number.isInteger(w.version) && w.version >= 1 ? w.version : 1,
					createdAt: typeof w.createdAt === 'number' && Number.isFinite(w.createdAt) ? w.createdAt : Date.now(),
					updatedAt: typeof w.updatedAt === 'number' && Number.isFinite(w.updatedAt) ? w.updatedAt : Date.now(),
					...(typeof w.updatedBy === 'string' && w.updatedBy ? { updatedBy: w.updatedBy } : {}),
					...(typeof w.updatedByLabel === 'string' && w.updatedByLabel ? { updatedByLabel: w.updatedByLabel } : {}),
				};
			}
		}
		return {
			id,
			title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : 'Untitled',
			mermaidText: typeof entry.mermaidText === 'string' ? entry.mermaidText : '',
			...(Object.keys(sanitizedPrompts).length > 0 ? { nodePrompts: sanitizedPrompts } : {}),
			...(Object.keys(sanitizedTaskStatuses).length > 0 ? { taskStatuses: sanitizedTaskStatuses } : {}),
			...(Object.keys(sanitizedChecks).length > 0 ? { nodeChecks: sanitizedChecks } : {}),
			positions: entry.positions && typeof entry.positions === 'object' ? entry.positions as Readonly<Record<string, IMissionNodePosition>> : {},
			...(typeof entry.orchestrationText === 'string' ? { orchestrationText: entry.orchestrationText } : {}),
			...(entry.orchestrationLayoutMode === 'lr' || entry.orchestrationLayoutMode === 'td' || entry.orchestrationLayoutMode === 'radial' || entry.orchestrationLayoutMode === 'grid'
				? { orchestrationLayoutMode: entry.orchestrationLayoutMode }
				: {}),
			...(entry.orchestrationPositions && typeof entry.orchestrationPositions === 'object' ? { orchestrationPositions: entry.orchestrationPositions as Readonly<Record<string, IMissionNodePosition>> } : {}),
			...(Object.keys(sanitizedWhiteboards).length > 0 ? { whiteboards: sanitizedWhiteboards } : {}),
			...(entry.orchestrationRuntime && typeof entry.orchestrationRuntime === 'object' ? { orchestrationRuntime: entry.orchestrationRuntime as IOrchestrationRuntimeState } : {}),
			...(ownerSessionId ? { ownerSessionId, linkedSessionId: ownerSessionId } : {}),
			ownerTier,
			...(ownerRankId ? { ownerRankId } : {}),
			...(typeof entry.projectUri === 'string' ? { projectUri: entry.projectUri } : {}),
			...(entry.runtime && typeof entry.runtime === 'object' ? { runtime: entry.runtime as IMissionRuntimeState } : {}),
			createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
			updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
		};
	}

	private loadFromStorage(): void {
		// 1. Load v2 lightweight hot index + per-Mission cold payloads (if in storage fallback mode).
		try {
			const indexRaw = this.storageService.get(ADE_MISSIONS_INDEX_STORAGE_KEY, StorageScope.APPLICATION);
			if (indexRaw) {
				const parsedIndex = JSON.parse(indexRaw) as Partial<IAdeMissionIndexEnvelope>;
				if (parsedIndex && parsedIndex.version === 2 && Array.isArray(parsedIndex.entries)) {
					for (const entry of parsedIndex.entries) {
						if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) {
							continue;
						}
						const coldRaw = this.storageService.get(`${ADE_MISSION_RECORD_STORAGE_PREFIX}${entry.id}`, StorageScope.APPLICATION);
						if (coldRaw) {
							try {
								const fullRec = this.sanitizeMissionRecord(JSON.parse(coldRaw));
								if (fullRec) {
									this.records.set(fullRec.id, fullRec);
									this.hydratedColdIds.add(fullRec.id);
									continue;
								}
							} catch {
								// Fall through to lightweight index metadata
							}
						}
						this.records.set(entry.id, this.recordFromIndexEntry(entry));
						this.indexOnlyIds.add(entry.id);
					}
				}
			}
		} catch {
			// Ignore malformed v2 index
		}

		// 2. Auto-migrate any legacy monolithic single-key storage (`aexus.ade.missions.v1`).
		try {
			const legacyRaw = this.storageService.get(ADE_MISSIONS_LEGACY_STORAGE_KEY, StorageScope.APPLICATION);
			if (!legacyRaw) {
				return;
			}
			const parsed = JSON.parse(legacyRaw);
			if (!Array.isArray(parsed)) {
				return;
			}
			const migratedIds: string[] = [];
			for (const entry of parsed) {
				const record = this.sanitizeMissionRecord(entry);
				if (!record) {
					continue;
				}
				const existing = this.records.get(record.id);
				const existingIsIndexOnly = Boolean(existing && this.indexOnlyIds.has(record.id));
				if (!existing || existingIsIndexOnly || record.updatedAt > existing.updatedAt) {
					this.records.set(record.id, record);
					this.indexOnlyIds.delete(record.id);
					this.hydratedColdIds.add(record.id);
					migratedIds.push(record.id);
				}
			}
			if (migratedIds.length > 0) {
				this.migratedLegacyIds = migratedIds;
				// Immediately remove the legacy monolithic blob once migrated into per-Mission cold storage + hot index.
				if (!this.hasColdFileBackend()) {
					for (const mid of migratedIds) {
						this.dirtyMissionIds.add(mid);
					}
					this.migratedLegacyIds = [];
					this.persist();
					this.isPersisting = true;
					try {
						this.storageService.remove(ADE_MISSIONS_LEGACY_STORAGE_KEY, StorageScope.APPLICATION);
					} finally {
						this.isPersisting = false;
					}
				}
			}
		} catch {
			// Ignore malformed legacy storage
		}
	}

	private compactRuntimeForStorage(runtime: IMissionRuntimeState): IMissionRuntimeState {
		const MAX_SUMMARY_CHARS = 2_000;
		const MAX_REVISIONS = 30;
		let changed = false;
		let nextTokens: Record<string, IMissionRuntimeState['tokens'][string]> | undefined;
		for (const [id, tok] of Object.entries(runtime.tokens)) {
			if (tok.lastSummary && tok.lastSummary.length > MAX_SUMMARY_CHARS) {
				if (!nextTokens) {
					nextTokens = { ...runtime.tokens };
				}
				nextTokens[id] = { ...tok, lastSummary: `${tok.lastSummary.slice(0, MAX_SUMMARY_CHARS - 1)}…` };
				changed = true;
			}
		}
		let nextTraces: Record<string, IMissionRuntimeState['traces'][string]> | undefined;
		for (const [ptr, tr] of Object.entries(runtime.traces)) {
			if (tr.summary && tr.summary.length > MAX_SUMMARY_CHARS) {
				if (!nextTraces) {
					nextTraces = { ...runtime.traces };
				}
				nextTraces[ptr] = { ...tr, summary: `${tr.summary.slice(0, MAX_SUMMARY_CHARS - 1)}…` };
				changed = true;
			}
		}
		let nextRevisions = runtime.revisions;
		if (nextRevisions && nextRevisions.length > MAX_REVISIONS) {
			nextRevisions = nextRevisions.slice(nextRevisions.length - MAX_REVISIONS);
			changed = true;
		}
		if (!changed) {
			return runtime;
		}
		return {
			...runtime,
			tokens: nextTokens ?? runtime.tokens,
			traces: nextTraces ?? runtime.traces,
			...(nextRevisions ? { revisions: nextRevisions } : {}),
		};
	}

	private markRecordDirty(id: string): void {
		this.deletedMissionIds.delete(id);
		this.dirtyMissionIds.add(id);
		if (!this.indexOnlyIds.has(id)) {
			this.hydratedColdIds.add(id);
		}
	}

	private recordSavedFingerprint(serialized: string): void {
		const fp = computeAdeStorageFingerprint(serialized);
		this.recentSavedFingerprints.add(fp);
		if (this.recentSavedFingerprints.size > 24) {
			const oldest = this.recentSavedFingerprints.values().next().value;
			if (oldest !== undefined) {
				this.recentSavedFingerprints.delete(oldest);
			}
		}
	}

	private writeHotIndexOnly(
		updatedIds: readonly string[],
		removedIds: readonly string[],
		coldBackend: 'file' | 'storage',
	): void {
		const envelope: IAdeMissionIndexEnvelope = {
			version: 2,
			writerId: this.writerId,
			coldBackend,
			updatedIds: [...updatedIds],
			removedIds: [...removedIds],
			entries: [...this.records.values()].map(rec => this.toIndexEntry(rec)),
		};
		const indexSerialized = JSON.stringify(envelope);
		this.recordSavedFingerprint(indexSerialized);
		this.isPersisting = true;
		try {
			this.storageService.store(ADE_MISSIONS_INDEX_STORAGE_KEY, indexSerialized, StorageScope.APPLICATION, StorageTarget.USER);
		} finally {
			this.isPersisting = false;
		}
	}

	/**
	 * Cold/Hot separated per-Mission persistence:
	 * - Only dirty Mission IDs are serialized & flushed (untouched Missions incur zero JSON serialization or I/O).
	 * - Heavy cold payloads (Mermaid, tokens, traces, revisions, telemetry, runHistory) are persisted asynchronously
	 *   to independent per-Mission files (`<adeHome>/missions/<safeId>.json`) via Node backend (with per-Mission
	 *   storage key fallback in browser-only test environments).
	 * - `IStorageService` retains ONLY a tiny metadata hot index (`aexus.ade.missions.index.v2`).
	 */
	private persist(): void {
		if (this.batchDepth > 0) {
			this.batchNeedsPersist = true;
			return;
		}
		if (this.deferredPersistTimer !== undefined) {
			clearTimeout(this.deferredPersistTimer);
			this.deferredPersistTimer = undefined;
		}
		const dirtyIds = [...this.dirtyMissionIds];
		const removedIds = [...this.deletedMissionIds];
		this.dirtyMissionIds.clear();
		this.deletedMissionIds.clear();

		const useColdFiles = this.hasColdFileBackend();
		const backend = useColdFiles ? this.backendService : undefined;

		if (useColdFiles && backend?.saveMissionRecord) {
			const persistedColdIds: string[] = [];
			for (const id of dirtyIds) {
				const record = this.records.get(id);
				if (!record) {
					continue;
				}
				if (this.indexOnlyIds.has(id)) {
					// Never overwrite a cold file on disk with an unhydrated index-only stub; retain dirty until hydration merges.
					this.dirtyMissionIds.add(id);
					continue;
				}
				const compactRecord = record.runtime
					? { ...record, runtime: this.compactRuntimeForStorage(record.runtime) }
					: record;
				const payloadJson = JSON.stringify(compactRecord);
				const updatedAt = record.updatedAt;
				persistedColdIds.push(id);
				this.trackColdMissionOp(async () => {
					try {
						await backend.saveMissionRecord!(id, payloadJson, updatedAt, this.writerId);
					} catch {
						if (!this._store.isDisposed && this.records.has(id)) {
							this.dirtyMissionIds.add(id);
							this.scheduleDeferredPersist(1500);
						}
					}
				});
			}
			for (const id of removedIds) {
				this.indexOnlyIds.delete(id);
				this.trackColdMissionOp(async () => {
					try {
						await backend.deleteMissionRecord?.(id, this.writerId);
					} catch {
						if (!this._store.isDisposed && !this.records.has(id)) {
							this.deletedMissionIds.add(id);
							this.scheduleDeferredPersist(1500);
						}
					}
				});
			}
			if (persistedColdIds.length === 0 && removedIds.length === 0) {
				return;
			}
			this.writeHotIndexOnly(persistedColdIds, removedIds, 'file');
			return;
		}

		// Per-Mission storage key fallback (still strictly 1-Mission-per-key — zero monolithic mega-blob!).
		this.isPersisting = true;
		try {
			for (const id of dirtyIds) {
				const record = this.records.get(id);
				if (!record) {
					continue;
				}
				const compactRecord = record.runtime
					? { ...record, runtime: this.compactRuntimeForStorage(record.runtime) }
					: record;
				this.storageService.store(
					`${ADE_MISSION_RECORD_STORAGE_PREFIX}${id}`,
					JSON.stringify(compactRecord),
					StorageScope.APPLICATION,
					StorageTarget.USER,
				);
			}
			for (const id of removedIds) {
				this.storageService.remove(`${ADE_MISSION_RECORD_STORAGE_PREFIX}${id}`, StorageScope.APPLICATION);
			}
		} finally {
			this.isPersisting = false;
		}
		this.writeHotIndexOnly(dirtyIds, removedIds, 'storage');
	}

	private scheduleDeferredPersist(delayMs = 150): void {
		if (this.deferredPersistTimer !== undefined) {
			return;
		}
		this.deferredPersistTimer = setTimeout(() => {
			this.deferredPersistTimer = undefined;
			this.persist();
		}, delayMs);
	}

	private getOwnerSyncKey(record: IAdeMissionRecord): string {
		return record.ownerSessionId ?? record.id;
	}

	ensureOrchestrationStaffSynced(id: string): void {
		const rec = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!rec) {
			return;
		}
		this.syncSidebarEmployeesForRecord(rec);
	}

	private syncSidebarEmployeesForRecord(record: IAdeMissionRecord): void {
		const projects = this.projectsService;
		if (!projects) {
			return;
		}
		const ownerAgent = record.ownerSessionId && record.ownerSessionId !== ADE_SECRETARY_ID
			? projects.getAgent(record.ownerSessionId)
			: undefined;
		if (ownerAgent) {
			projects.setAgentWorkTreeTag?.(ownerAgent.id, 'mission');
		}
		if (record.orchestrationText && record.orchestrationText.trim().length > 0) {
			const parsedOrch = parseOrchestrationGraph(record.orchestrationText);
			if (parsedOrch.error) {
				// Preserve existing staff sessions while editing invalid Orchestration syntax.
				return;
			}
			const ownerKey = this.getOwnerSyncKey(record);
			const parsedProjectUri = record.projectUri
				? URI.parse(record.projectUri)
				: (ownerAgent?.projectUri ?? projects.selectedProject?.uri ?? projects.projects[0]?.uri);
			if (!ownerAgent && !parsedProjectUri) {
				return;
			}
			const schema = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
			const staffNodes = parsedOrch.nodes.filter(n => n.kind === 'staff');
			const staffById = new Map(staffNodes.map(n => [n.id, n]));
			// When owned by a real project Governor agent, that owner session IS the root highest-rank node on canvas!
			const rootStaffNode = ownerAgent ? findHighestRankStaffNode(parsedOrch) : undefined;
			const normalizeThinking = (raw: string | undefined): AdeThinkingLevel | undefined => (
				raw === 'off' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max' ? raw : undefined
			);
			const applyStaffEnginePrefs = (agent: IAdeAgent, node: typeof staffNodes[number]) => {
				const prefPatch: { preferredEngineId?: string; preferredModel?: string; preferredThinking?: AdeThinkingLevel } = {};
				const normEngine = normalizeAdeEngineId(node.engineId);
				if (normEngine && !agent.session && agent.preferredEngineId !== normEngine) {
					prefPatch.preferredEngineId = normEngine;
				}
				if (node.model && agent.preferredModel !== node.model) {
					prefPatch.preferredModel = node.model;
				}
				const normThinking = normalizeThinking(node.thinking);
				if (normThinking && agent.preferredThinking !== normThinking) {
					prefPatch.preferredThinking = normThinking;
				}
				if (Object.keys(prefPatch).length > 0) {
					projects.updateAgentEnginePreferences?.(agent.id, prefPatch);
				}
			};
			if (ownerAgent && rootStaffNode && (rootStaffNode.engineId || rootStaffNode.model || rootStaffNode.thinking)) {
				applyStaffEnginePrefs(ownerAgent, rootStaffNode);
			}
			const subordinateStaff = rootStaffNode
				? staffNodes.filter(n => n.id !== rootStaffNode.id)
				: staffNodes;

			const resolveParentKey = (node: typeof staffNodes[number]): string | undefined => {
				const nodeTier = node.tier ?? 99;
				const incomingSuperiors = parsedOrch.edges
					.filter(e => e.to === node.id)
					.map(e => staffById.get(e.from))
					.filter((sup): sup is typeof staffNodes[number] => Boolean(sup && sup.id !== node.id && (sup.tier ?? 0) < nodeTier));
				if (incomingSuperiors.length === 0) {
					return undefined;
				}
				// Prefer direct superior in the same department, closest higher tier (largest tier < nodeTier)
				incomingSuperiors.sort((a, b) => {
					const aSameDept = Boolean(node.department && a.department && a.department.toLowerCase() === node.department.toLowerCase()) ? 1 : 0;
					const bSameDept = Boolean(node.department && b.department && b.department.toLowerCase() === node.department.toLowerCase()) ? 1 : 0;
					if (aSameDept !== bSameDept) { return bSameDept - aSameDept; }
					return (b.tier ?? 0) - (a.tier ?? 0);
				});
				const bestSup = incomingSuperiors[0];
				if (rootStaffNode && bestSup.id === rootStaffNode.id) {
					// Direct child of the owner Governor session (`parentId = ownerAgent.id`)
					return undefined;
				}
				return bestSup.employeeKey ?? bestSup.id;
			};

			const staffSpecs = subordinateStaff.map(node => {
				const targetRank = node.rankId
					? schema.ranks.find(r => r.id === node.rankId)
					: (node.tier !== undefined ? schema.ranks.find(r => r.tier === node.tier) : undefined);
				const parentKey = resolveParentKey(node);
				return {
					id: node.employeeKey ?? node.id,
					title: node.employeeName ?? node.label,
					nodeIds: [node.id],
					isExplicitEmployee: true,
					...(parentKey ? { parentKey } : {}),
					...(targetRank ? { role: targetRank.id } : {}),
				};
			});

			// Tight 1:1 locked hierarchical sync between Orchestration canvas and left sidebar Projects tree!
			const syncRes = projects.syncMissionMermaidEmployees?.(ownerKey, staffSpecs, {
				projectUri: parsedProjectUri,
				ownerTier: ownerAgent ? Math.max(0, record.ownerTier) : 0,
				treeType: 'engineering',
			});
			if (syncRes) {
				for (const node of subordinateStaff) {
					const agent = syncRes.employeeAgentsByNode[node.id];
					if (!agent) {
						continue;
					}
					const targetRank = node.rankId
						? schema.ranks.find(r => r.id === node.rankId)
						: (node.tier !== undefined ? schema.ranks.find(r => r.tier === node.tier) : undefined);
					if (targetRank && agent.role !== targetRank.id) {
						projects.setAgentRole(agent.id, targetRank.id, { allowLockedMissionEmployee: true });
						void this.backendService?.revokeSession?.(agent.id).catch(() => undefined);
					}
					if (node.engineId || node.model || node.thinking) {
						applyStaffEnginePrefs(agent, node);
					}
				}
				if (syncRes.removedAgents.length > 0) {
					for (const removedAgent of syncRes.removedAgents) {
						void this.backendService?.revokeSession?.(removedAgent.id).catch(() => undefined);
						if (removedAgent.session && this.sessionsService?.stop) {
							const hostAlias = removedAgent.projectUri.scheme === AEXUS_SSH_SCHEME ? removedAgent.projectUri.authority : undefined;
							void this.sessionsService.stop(removedAgent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
						}
					}
					const editors = this.adeEditorsService;
					if (editors) {
						void editors.closeAgents(syncRes.removedAgents).catch(() => undefined);
					}
				}
			}
			return;
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
			ownerTier: Math.max(record.ownerTier, record.runtime?.boundary.offGraphMaxTier ?? record.ownerTier),
		});
		if (syncRes && syncRes.removedAgents.length > 0) {
			for (const removedAgent of syncRes.removedAgents) {
				void this.backendService?.revokeSession?.(removedAgent.id).catch(() => undefined);
				if (removedAgent.session && this.sessionsService?.stop) {
					const hostAlias = removedAgent.projectUri.scheme === AEXUS_SSH_SCHEME ? removedAgent.projectUri.authority : undefined;
					void this.sessionsService.stop(removedAgent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
				}
			}
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
		readonly orchestrationText?: string;
		readonly nodePrompts?: Readonly<Record<string, string>>;
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
		const sanitizedPrompts: Record<string, string> = {};
		if (options?.nodePrompts) {
			for (const [nid, val] of Object.entries(options.nodePrompts)) {
				if (typeof val === 'string' && val.trim()) {
					sanitizedPrompts[nid] = val;
				}
			}
		}
		const record: IAdeMissionRecord = {
			id,
			title: options?.title?.trim() || ownerAgent?.label || `Engineering ${num}`,
			mermaidText: options?.mermaidText ?? '',
			...(typeof options?.orchestrationText === 'string' ? { orchestrationText: options.orchestrationText } : {}),
			...(Object.keys(sanitizedPrompts).length > 0 ? { nodePrompts: sanitizedPrompts } : {}),
			positions: {},
			...(ownerMeta.ownerSessionId ? { ownerSessionId: ownerMeta.ownerSessionId, linkedSessionId: ownerMeta.ownerSessionId } : {}),
			ownerTier: ownerMeta.ownerTier,
			ownerRankId: ownerMeta.ownerRankId,
			...(projectUri ? { projectUri } : {}),
			createdAt: now,
			updatedAt: now,
		};
		this.records.set(id, record);
		this.indexOnlyIds.delete(id);
		this.markRecordDirty(id);
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
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		this.persist();
		this.syncSidebarEmployeesForRecord(updated);
		this._onDidChange.fire();
		return updated;
	}

	updateNodePrompt(id: string, nodeId: string, prompt: string): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		const cleanNodeId = nodeId.trim();
		if (!existing || !cleanNodeId) {
			return undefined;
		}
		const prev = existing.nodePrompts ?? {};
		const prevVal = prev[cleanNodeId] ?? '';
		const isClearing = prompt.trim().length === 0;
		if (isClearing && !Object.hasOwn(prev, cleanNodeId)) {
			return existing;
		}
		if (!isClearing && prevVal === prompt) {
			return existing;
		}
		const nextPrompts: Record<string, string> = { ...prev };
		if (isClearing) {
			delete nextPrompts[cleanNodeId];
		} else {
			nextPrompts[cleanNodeId] = prompt;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			nodePrompts: Object.keys(nextPrompts).length > 0 ? nextPrompts : undefined,
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	updateNodePrompts(id: string, prompts: Readonly<Record<string, string>>): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		const nextPrompts: Record<string, string> = { ...(existing.nodePrompts ?? {}) };
		for (const [rawNodeId, rawPrompt] of Object.entries(prompts)) {
			const cleanNodeId = rawNodeId.trim();
			if (!cleanNodeId) {
				continue;
			}
			if (typeof rawPrompt !== 'string' || rawPrompt.trim().length === 0) {
				delete nextPrompts[cleanNodeId];
			} else {
				nextPrompts[cleanNodeId] = rawPrompt;
			}
		}
		const updated: IAdeMissionRecord = {
			...existing,
			nodePrompts: Object.keys(nextPrompts).length > 0 ? nextPrompts : undefined,
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	replaceNodePrompts(id: string, prompts: Readonly<Record<string, string>> | undefined): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		const clean: Record<string, string> = {};
		for (const [k, v] of Object.entries(prompts ?? {})) {
			const trimmedKey = k.trim();
			if (trimmedKey && typeof v === 'string' && v.trim().length > 0) {
				clean[trimmedKey] = v;
			}
		}
		const updated: IAdeMissionRecord = {
			...existing,
			nodePrompts: Object.keys(clean).length > 0 ? clean : undefined,
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	replaceAllNodeChecks(id: string, checks: Readonly<Record<string, readonly IMissionNodeCheckHook[]>> | undefined): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		const clean: Record<string, readonly IMissionNodeCheckHook[]> = {};
		for (const [k, v] of Object.entries(checks ?? {})) {
			const trimmedKey = k.trim();
			if (trimmedKey && Array.isArray(v) && v.length > 0) {
				clean[trimmedKey] = [...v];
			}
		}
		const updated: IAdeMissionRecord = {
			...existing,
			nodeChecks: Object.keys(clean).length > 0 ? clean : undefined,
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	updateTaskStatuses(id: string, taskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>>, options?: { readonly deferPersist?: boolean; readonly silent?: boolean }): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			taskStatuses: Object.keys(taskStatuses).length > 0 ? taskStatuses : undefined,
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		if (options?.deferPersist) {
			this.scheduleDeferredPersist(250);
		} else {
			this.persist();
		}
		if (!options?.silent) {
			this._onDidChange.fire();
		}
		return updated;
	}

	updateOrchestrationText(id: string, orchestrationText: string, options?: { readonly replaceWhiteboards?: boolean; readonly replacePositions?: boolean }): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		if ((existing.orchestrationText ?? '') === orchestrationText && !options?.replaceWhiteboards && !options?.replacePositions) {
			return existing;
		}
		const now = Math.max(Date.now(), existing.updatedAt + 1);
		const parsed = parseOrchestrationGraph(orchestrationText);
		let nextWhiteboards = existing.whiteboards;
		let nextPositions = existing.orchestrationPositions;
		let nextLayoutMode = existing.orchestrationLayoutMode;
		if (!parsed.error) {
			if (parsed.layoutMode && (options?.replacePositions || !nextLayoutMode)) {
				nextLayoutMode = parsed.layoutMode;
			}
			if (options?.replacePositions) {
				nextPositions = parsed.positions && Object.keys(parsed.positions).length > 0 ? { ...parsed.positions } : undefined;
			} else if (parsed.positions && Object.keys(parsed.positions).length > 0) {
				nextPositions = { ...(existing.orchestrationPositions ?? {}), ...parsed.positions };
			}
			const wbNodes = parsed.nodes.filter(n => n.kind === 'whiteboard');
			if (options?.replaceWhiteboards) {
				const rebuilt: Record<string, IOrchestrationWhiteboard> = {};
				for (const node of wbNodes) {
					rebuilt[node.id] = {
						id: node.id,
						title: node.label,
						department: node.department || 'General',
						content: node.whiteboardContent ?? '',
						version: node.whiteboardVersion ?? (node.whiteboardContent ? 1 : 0),
						createdAt: now,
						updatedAt: now,
					};
				}
				nextWhiteboards = Object.keys(rebuilt).length > 0 ? rebuilt : undefined;
			} else if (wbNodes.length > 0) {
				const merged: Record<string, IOrchestrationWhiteboard> = { ...(existing.whiteboards ?? {}) };
				let wbChanged = false;
				for (const node of wbNodes) {
					const prev = merged[node.id];
					const nextDept = node.department || 'General';
					const nextTitle = node.label || prev?.title || node.id;
					if (!prev) {
						merged[node.id] = {
							id: node.id,
							title: nextTitle,
							department: nextDept,
							content: node.whiteboardContent ?? '',
							version: node.whiteboardVersion ?? (node.whiteboardContent ? 1 : 0),
							createdAt: now,
							updatedAt: now,
						};
						wbChanged = true;
					} else {
						const contentChanged = node.whiteboardContent !== undefined && node.whiteboardContent !== prev.content;
						if (prev.department !== nextDept || prev.title !== nextTitle || contentChanged) {
							merged[node.id] = {
								...prev,
								title: nextTitle,
								department: nextDept,
								...(contentChanged ? {
									content: node.whiteboardContent!,
									version: Math.max(prev.version + 1, node.whiteboardVersion ?? 1),
								} : {}),
								updatedAt: now,
							};
							wbChanged = true;
						}
					}
				}
				if (wbChanged) {
					nextWhiteboards = merged;
				}
			}
		}
		const updated: IAdeMissionRecord = {
			...existing,
			orchestrationText,
			...(nextLayoutMode ? { orchestrationLayoutMode: nextLayoutMode } : {}),
			orchestrationPositions: nextPositions,
			whiteboards: nextWhiteboards,
			updatedAt: now,
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		this.persist();
		this.syncSidebarEmployeesForRecord(updated);
		this._onDidChange.fire();
		return updated;
	}

	updateOrchestrationLayoutMode(id: string, layoutMode: OrchestrationLayoutMode): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		if (existing.orchestrationLayoutMode === layoutMode) {
			return existing;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			orchestrationLayoutMode: layoutMode,
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	updateOrchestrationPositions(id: string, positions: Readonly<Record<string, IMissionNodePosition>>): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			orchestrationPositions: { ...(existing.orchestrationPositions ?? {}), ...positions },
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		this.scheduleDeferredPersist(150);
		return updated;
	}

	removeOrchestrationPositions(id: string, nodeIds: readonly string[]): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing || !existing.orchestrationPositions || nodeIds.length === 0) {
			return existing;
		}
		const drop = new Set(nodeIds.map(s => s.trim()).filter(Boolean));
		let removedAny = false;
		const nextPos: Record<string, IMissionNodePosition> = {};
		for (const [k, v] of Object.entries(existing.orchestrationPositions)) {
			if (drop.has(k)) {
				removedAny = true;
			} else {
				nextPos[k] = v;
			}
		}
		if (!removedAny) {
			return existing;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			orchestrationPositions: Object.keys(nextPos).length > 0 ? nextPos : undefined,
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		this.persist();
		return updated;
	}

	clearOrchestrationPositions(id: string): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			orchestrationPositions: {},
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	updateWhiteboards(id: string, whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>>): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			whiteboards: Object.keys(whiteboards).length > 0 ? whiteboards : undefined,
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	updateOrchestrationRuntime(id: string, orchestrationRuntime: IOrchestrationRuntimeState | undefined, options?: { readonly deferPersist?: boolean; readonly silent?: boolean }): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			...(orchestrationRuntime ? { orchestrationRuntime } : { orchestrationRuntime: undefined }),
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		if (options?.deferPersist) {
			this.scheduleDeferredPersist(250);
		} else {
			this.persist();
		}
		if (!options?.silent) {
			this._onDidChange.fire();
		}
		return updated;
	}

	updateNodeChecks(id: string, nodeId: string, checks: readonly IMissionNodeCheckHook[]): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		const cleanNodeId = nodeId.trim();
		if (!existing || !cleanNodeId) {
			return undefined;
		}
		const nextMap: Record<string, readonly IMissionNodeCheckHook[]> = { ...(existing.nodeChecks ?? {}) };
		if (checks.length === 0) {
			delete nextMap[cleanNodeId];
		} else {
			nextMap[cleanNodeId] = checks.map(c => ({ ...c, source: 'config' }));
		}
		const updated: IAdeMissionRecord = {
			...existing,
			nodeChecks: Object.keys(nextMap).length > 0 ? nextMap : undefined,
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	upsertNodeCheck(id: string, nodeId: string, check: IMissionNodeCheckHook): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		const cleanNodeId = nodeId.trim();
		if (!existing || !cleanNodeId) {
			return undefined;
		}
		const prevList = existing.nodeChecks?.[cleanNodeId] ?? [];
		const normalized: IMissionNodeCheckHook = { ...check, source: 'config' };
		const idx = prevList.findIndex(c => c.id === normalized.id);
		const nextList = idx >= 0
			? prevList.map((c, i) => i === idx ? normalized : c)
			: [...prevList, normalized];
		return this.updateNodeChecks(existing.id, cleanNodeId, nextList);
	}

	removeNodeCheck(id: string, nodeId: string, checkId?: string): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		const cleanNodeId = nodeId.trim();
		if (!existing || !cleanNodeId) {
			return undefined;
		}
		if (!checkId?.trim()) {
			return this.updateNodeChecks(existing.id, cleanNodeId, []);
		}
		const prevList = existing.nodeChecks?.[cleanNodeId] ?? [];
		const nextList = prevList.filter(c => c.id !== checkId.trim());
		return this.updateNodeChecks(existing.id, cleanNodeId, nextList);
	}

	updateRuntime(id: string, runtime: IMissionRuntimeState | undefined, options?: { readonly deferPersist?: boolean }): IAdeMissionRecord | undefined {
		const existing = this.records.get(id) ?? this.getMissionByLinkedSession(id);
		if (!existing) {
			return undefined;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			...(runtime ? { runtime } : { runtime: undefined }),
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		if (options?.deferPersist) {
			this.scheduleDeferredPersist(250);
		} else {
			this.persist();
		}
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
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
		this.scheduleDeferredPersist(150);
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
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
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
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		};
		this.records.set(existing.id, updated);
		this.markRecordDirty(existing.id);
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
		this.dirtyMissionIds.delete(existing.id);
		this.hydratedColdIds.delete(existing.id);
		this.deletedMissionIds.add(existing.id);
		this.persist();
		this._onDidChange.fire();
		void this.backendService?.removeMissionWatchdog?.(existing.id).catch(() => undefined);
		if (removedAgents.length > 0) {
			const sessions = this.sessionsService;
			for (const agent of removedAgents) {
				void this.backendService?.revokeSession?.(agent.id).catch(() => undefined);
				if (agent.session && sessions?.stop) {
					const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
					void sessions.stop(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
				}
			}
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
			void this.backendService?.revokeSession?.(member.id).catch(() => undefined);
			if (member.session) {
				const hostAlias = member.projectUri.scheme === AEXUS_SSH_SCHEME ? member.projectUri.authority : undefined;
				await sessions?.stop?.(member.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
				if (options?.deleteEngineHistory) {
					await sessions?.delete(member.session).catch(() => undefined);
				}
			}
		}

		const removed = projects?.clearMissionEmployees?.(ownerKey) ?? [];
		for (const member of removed) {
			void this.backendService?.revokeSession?.(member.id).catch(() => undefined);
		}
		const deleted = existing ? this.records.delete(existing.id) : false;
		if (deleted && existing) {
			this.dirtyMissionIds.delete(existing.id);
			this.hydratedColdIds.delete(existing.id);
			this.deletedMissionIds.add(existing.id);
			this.persist();
		}
		void this.backendService?.removeMissionWatchdog?.(targetId).catch(() => undefined);
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

	async openMissionEditor(id: string, options?: IAdeMissionOpenOptions): Promise<void> {
		const rec = this.ensureMission(id);
		this.modeService.setMode('ade');
		const targetGroup = options?.side ? SIDE_GROUP : undefined;
		const pendingFocus: IAdePendingMissionNodeFocus | undefined = options?.focusNodeId ? {
			nodeId: options.focusNodeId,
			focusTokenId: options.focusTokenId,
			highlightNodeIds: options.highlightNodeIds,
			openPopover: options.openPopover,
			whiteboardSection: options.whiteboardSection,
			inspectorTab: options.inspectorTab,
			openAgentBeside: options.openAgentBeside,
		} : undefined;

		const applyUnconsumedFocus = (input: AdeEngineeringEditorInput, pane: unknown): void => {
			if (!pendingFocus) {
				return;
			}
			const unconsumed = input.consumePendingFocus();
			const maybeCanvasPane = pane as {
				focusNode?: (nodeId: string, opts?: Omit<IAdePendingMissionNodeFocus, 'nodeId'>) => void;
			} | undefined;
			// Only invoke focusNode directly when VS Code reused an already-open AdeEngineeringEditorPane
			// (so setInput did NOT run and consume pendingFocus), preventing duplicate openAgent/warm-up calls.
			if (unconsumed && maybeCanvasPane && typeof maybeCanvasPane.focusNode === 'function') {
				maybeCanvasPane.focusNode(unconsumed.nodeId, {
					focusTokenId: unconsumed.focusTokenId,
					highlightNodeIds: unconsumed.highlightNodeIds,
					openPopover: unconsumed.openPopover,
					whiteboardSection: unconsumed.whiteboardSection,
					inspectorTab: unconsumed.inspectorTab,
					openAgentBeside: unconsumed.openAgentBeside,
				});
			}
		};

		if (options?.openSiblingViews) {
			const missionInput = this.instantiationService.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(rec.id, 'mission'));
			const orchInput = this.instantiationService.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(rec.id, 'orchestration'));
			const focusView: AdeEngineeringViewMode = options.viewMode
				?? inferEngineeringViewModeForNode(rec, options.focusNodeId, 'orchestration');
			const focusedInput = focusView === 'mission' ? missionInput : orchInput;
			if (pendingFocus) {
				focusedInput.setPendingFocus(pendingFocus);
			}
			if (focusView === 'mission') {
				await this.editorService.openEditor(orchInput, { pinned: true, inactive: true, preserveFocus: true }, targetGroup);
				const pane = await this.editorService.openEditor(missionInput, { pinned: true }, targetGroup);
				applyUnconsumedFocus(missionInput, pane);
			} else {
				await this.editorService.openEditor(missionInput, { pinned: true, inactive: true, preserveFocus: true }, targetGroup);
				const pane = await this.editorService.openEditor(orchInput, { pinned: true }, targetGroup);
				applyUnconsumedFocus(orchInput, pane);
			}
			return;
		}

		const resolvedViewMode: AdeEngineeringViewMode = options?.viewMode
			?? inferEngineeringViewModeForNode(rec, options?.focusNodeId, 'orchestration');

		if (options?.preferExistingGroup !== false) {
			const editorGroupsService = this.tryGet(IEditorGroupsService);
			const groups = editorGroupsService?.mainPart?.groups ?? [];
			const activeGroup = editorGroupsService?.mainPart?.activeGroup;
			for (const group of groups) {
				if (options?.side && activeGroup && group === activeGroup) {
					continue;
				}
				for (const editor of group.editors) {
					if (editor instanceof AdeEngineeringEditorInput && !editor.isDisposed() && editor.governorSessionId === rec.id && editor.viewMode === resolvedViewMode) {
						if (pendingFocus) {
							editor.setPendingFocus(pendingFocus);
						}
						const pane = await this.editorService.openEditor(editor, { pinned: true }, group.id);
						applyUnconsumedFocus(editor, pane);
						return;
					}
				}
			}
		}

		const spec = encodeAdeEngineeringInputSpec(rec.id, resolvedViewMode);
		const input = this.instantiationService.createInstance(AdeEngineeringEditorInput, spec);
		if (pendingFocus) {
			input.setPendingFocus(pendingFocus);
		}
		const pane = await this.editorService.openEditor(input, { pinned: true }, targetGroup);
		applyUnconsumedFocus(input, pane);
	}
}
