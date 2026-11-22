/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import {
	computeAdeStorageFingerprint,
	IAdeEngineeringBackendService,
} from '../../../../platform/ade/common/adeEngineering.js';
import { IMissionNodeCheckHook, IMissionNodePosition, parseMissionMermaidDag } from '../../../../platform/ade/common/adeMissionDag.js';
import { computeMissionTotalCostUsd, IMissionRuntimeState } from '../../../../platform/ade/common/adeMissionEngine.js';
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
	readonly mermaidText: string;
	/** Per-node authored Pre-Prompts (nodeId -> prompt text) packaged together with Token info on wakeup. */
	readonly nodePrompts?: Readonly<Record<string, string>>;
	/** Per-node zero-cost deterministic verification hooks (nodeId -> hooks) enforced before token completion advances. */
	readonly nodeChecks?: Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
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
 * Enforces strict Mission ownership authority for destructive / structural blueprint writes:
 * Whichever session (at any rank L0 or L1..LN) created a Mission is the ONLY agent session
 * permitted to overwrite/delete its Mission orchestration; Human User (L-1) always retains full authority.
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

/**
 * Authorizes read-only Mission topology inspection (`mission.get`, `mission.blueprint.get`):
 * Human User (L-1), Secretary (L0), the Mission owner, and any bound off-graph supervisor of the Mission
 * may inspect its Mermaid DAG so off-graph supervisors can review topology before issuing scoped patches.
 */
export function canCallerReadMission(
	mission: IAdeMissionRecord,
	caller: IAdeMissionCaller,
	runtime?: Pick<IMissionRuntimeState, 'boundary'>,
): boolean {
	if (caller.isHumanUser || caller.isSecretary || canCallerOperateMission(mission, caller)) {
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
	readonly focusNodeId?: string;
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
	updateNodeChecks(id: string, nodeId: string, checks: readonly IMissionNodeCheckHook[]): IAdeMissionRecord | undefined;
	upsertNodeCheck(id: string, nodeId: string, check: IMissionNodeCheckHook): IAdeMissionRecord | undefined;
	removeNodeCheck(id: string, nodeId: string, checkId?: string): IAdeMissionRecord | undefined;
	updateRuntime(id: string, runtime: IMissionRuntimeState | undefined, options?: { readonly deferPersist?: boolean }): IAdeMissionRecord | undefined;
	updateNodePositions(id: string, positions: Readonly<Record<string, IMissionNodePosition>>): IAdeMissionRecord | undefined;
	clearNodePositions(id: string): IAdeMissionRecord | undefined;
	renameMission(id: string, title: string): IAdeMissionRecord | undefined;
	deleteMission(id: string): boolean;
	removeMissionWithEmployees(id: string, options?: { readonly deleteEngineHistory?: boolean }): Promise<IAdeMissionRemoveResult>;
	openMissionEditor(id: string, options?: IAdeMissionOpenOptions): Promise<void>;
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
				void this.handleExternalColdFileChange(ev.missionId, ev.updatedAt, Boolean(ev.deleted));
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
			this._onDidChange.fire();
		}
	}

	private async handleExternalColdFileChange(missionId: string, updatedAt: number, deleted: boolean): Promise<void> {
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
		if (localRec && !this.indexOnlyIds.has(extRec.id) && extRec.updatedAt < localRec.updatedAt) {
			return;
		}
		if (this.dirtyMissionIds.has(extRec.id) && localRec && localRec.updatedAt >= extRec.updatedAt) {
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

		// Drive deletions from explicit `removedIds` tombstones when incremental metadata is present so a
		// slightly stale index from another window never drops a concurrently created local Mission.
		const hasDeltaMeta = (envelope.updatedIds && envelope.updatedIds.length > 0) || (envelope.removedIds && envelope.removedIds.length > 0);
		if (hasDeltaMeta) {
			for (const removedId of envelope.removedIds ?? []) {
				if (!preservedDirty.has(removedId)) {
					this.records.delete(removedId);
					this.hydratedColdIds.delete(removedId);
					this.indexOnlyIds.delete(removedId);
				}
			}
		} else {
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
			const changedIds = envelope.updatedIds && envelope.updatedIds.length > 0
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
		const totalCostUsd = record.runtime ? computeMissionTotalCostUsd(record.runtime) : undefined;
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
		return {
			id,
			title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : 'Untitled',
			mermaidText: typeof entry.mermaidText === 'string' ? entry.mermaidText : '',
			...(Object.keys(sanitizedPrompts).length > 0 ? { nodePrompts: sanitizedPrompts } : {}),
			...(Object.keys(sanitizedChecks).length > 0 ? { nodeChecks: sanitizedChecks } : {}),
			positions: entry.positions && typeof entry.positions === 'object' ? entry.positions as Readonly<Record<string, IMissionNodePosition>> : {},
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
			...(updatedIds.length > 0 ? { updatedIds } : {}),
			...(removedIds.length > 0 ? { removedIds } : {}),
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
				persistedColdIds.push(id);
				void backend.saveMissionRecord(id, payloadJson, record.updatedAt, this.writerId).catch(() => {
					if (!this._store.isDisposed && this.records.has(id)) {
						this.dirtyMissionIds.add(id);
						this.scheduleDeferredPersist(1500);
					}
				});
			}
			for (const id of removedIds) {
				this.indexOnlyIds.delete(id);
				void backend.deleteMissionRecord?.(id, this.writerId).catch(() => {
					if (!this._store.isDisposed && !this.records.has(id)) {
						this.deletedMissionIds.add(id);
						this.scheduleDeferredPersist(1500);
					}
				});
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
			ownerTier: Math.max(record.ownerTier, record.runtime?.boundary.offGraphMaxTier ?? record.ownerTier),
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
			title: options?.title?.trim() || ownerAgent?.label || `Mission ${num}`,
			mermaidText: options?.mermaidText ?? '',
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
		if (deleted && existing) {
			this.dirtyMissionIds.delete(existing.id);
			this.hydratedColdIds.delete(existing.id);
			this.deletedMissionIds.add(existing.id);
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

	async openMissionEditor(id: string, options?: IAdeMissionOpenOptions): Promise<void> {
		const rec = this.ensureMission(id);
		this.modeService.setMode('ade');
		const input = this.instantiationService.createInstance(AdeEngineeringEditorInput, rec.id);
		if (options?.focusNodeId) {
			input.setPendingFocus({
				nodeId: options.focusNodeId,
				inspectorTab: options.inspectorTab,
				openAgentBeside: options.openAgentBeside,
			});
		}
		const pane = await this.editorService.openEditor(input, { pinned: true }, options?.side ? SIDE_GROUP : undefined);
		if (options?.focusNodeId) {
			const unconsumed = input.consumePendingFocus();
			const maybeCanvasPane = pane as {
				focusNode?: (nodeId: string, opts?: { readonly inspectorTab?: 'overview' | 'token' | 'distill' | 'finops'; readonly openAgentBeside?: boolean }) => void;
			} | undefined;
			// Only invoke focusNode directly when VS Code reused an already-open AdeEngineeringEditorPane
			// (so setInput did NOT run and consume pendingFocus), preventing duplicate openAgent/warm-up calls.
			if (unconsumed && maybeCanvasPane && typeof maybeCanvasPane.focusNode === 'function') {
				maybeCanvasPane.focusNode(unconsumed.nodeId, {
					inspectorTab: unconsumed.inspectorTab,
					openAgentBeside: unconsumed.openAgentBeside,
				});
			}
		}
	}
}
