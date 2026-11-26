/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAdeControlCenterService } from '../../../../platform/ade/common/adeControlCenterIpc.js';
import { AdeLayoutDirection, IAdeProjectSnapshot } from '../../../../platform/ade/common/adeModels.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IAdeProjectsService } from '../common/ade.js';

export interface IAdeProjectCanvasChangeEvent {
	readonly projectId?: string;
}

export const IAdeMissionService = createDecorator<IAdeMissionService>('adeMissionService');

/**
 * Reactive renderer-side cache and coordinator for ADE Project page snapshots (`IAdeProjectSnapshot`).
 * Backed authoritatively by `IAdeControlCenterService` (`state.db` + `catalog.db`) with zero local
 * Mermaid/prompt state.
 */
export interface IAdeMissionService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<IAdeProjectCanvasChangeEvent>;

	isSyncingProjectSnapshot?(projectId: string): boolean;
	getProjectSnapshotCached(projectId: string): IAdeProjectSnapshot | undefined;
	loadProjectSnapshot(projectId: string, forceRefresh?: boolean): Promise<IAdeProjectSnapshot | undefined>;
	cacheSnapshot(snapshot: IAdeProjectSnapshot): void;
	evictProjectSnapshot(projectId: string): void;
	getDepartmentAccentColor(projectId: string, deptId: string): string | undefined;
	setDepartmentAccentColor(projectId: string, deptId: string, colorToken: string | undefined): void;
	getWhiteboardAccentColor(projectId: string, boardId: string): string | undefined;
	setWhiteboardAccentColor(projectId: string, boardId: string, colorToken: string | undefined): void;
	updateCanvasLayout(projectId: string, patch: {
		readonly layoutDirection?: AdeLayoutDirection;
		readonly nodePositions?: Readonly<Record<string, { readonly x: number; readonly y: number; readonly color?: string }>>;
		readonly resetPinnedPositions?: boolean;
	}): Promise<void>;
}

export class AdeMissionStoreService extends Disposable implements IAdeMissionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<IAdeProjectCanvasChangeEvent>());
	readonly onDidChange: Event<IAdeProjectCanvasChangeEvent> = this._onDidChange.event;

	private readonly snapshots = new Map<string, IAdeProjectSnapshot>();
	private readonly inflightLoads = new Map<string, {
		promise: Promise<IAdeProjectSnapshot | undefined>;
		isForceRefresh: boolean;
		pendingTrailingRefresh: boolean;
	}>();
	private readonly deptColors = new Map<string, string>();
	private readonly wbColors = new Map<string, string>();
	private _syncingSnapshotProjectId: string | undefined;

	constructor(
		@IAdeControlCenterService private readonly controlCenter: IAdeControlCenterService,
		@IAdeProjectsService private readonly projectsService: IAdeProjectsService,
	) {
		super();

		const coordinatorTarget = this.projectsService as IAdeProjectsService & {
			attachSnapshotCoordinator?: () => { dispose(): void };
		};
		if (typeof coordinatorTarget.attachSnapshotCoordinator === 'function') {
			this._register(coordinatorTarget.attachSnapshotCoordinator());
		}

		this._register(this.controlCenter.onDidChangeProject(({ projectId }) => {
			this.handleProjectChanged(projectId);
		}));

		this._register(this.controlCenter.onDidChangeCatalog(() => {
			void this.reconcileDeletedProjects();
		}));
	}

	private async reconcileDeletedProjects(): Promise<void> {
		try {
			const catalog = await this.controlCenter.getCatalogSnapshot();
			const alive = new Set(catalog.projects.map(p => p.project_id));
			let removedAny = false;
			for (const pid of [...this.snapshots.keys()]) {
				if (!alive.has(pid)) {
					this.snapshots.delete(pid);
					removedAny = true;
				}
			}
			if (removedAny) {
				this._onDidChange.fire({});
			}
		} catch {
			// Ignore transient IPC errors in partial test harnesses.
		}
	}

	isSyncingProjectSnapshot(projectId: string): boolean {
		return this._syncingSnapshotProjectId === projectId;
	}

	private notifyProjectsSnapshotSynced(projectId: string, snapshot: IAdeProjectSnapshot): void {
		this._syncingSnapshotProjectId = projectId;
		try {
			this.projectsService.notifyProjectSnapshotLoaded?.(snapshot);
		} finally {
			this._syncingSnapshotProjectId = undefined;
		}
	}

	getProjectSnapshotCached(projectId: string): IAdeProjectSnapshot | undefined {
		return this.snapshots.get(projectId);
	}

	cacheSnapshot(snapshot: IAdeProjectSnapshot): void {
		const pid = snapshot.meta.project_id;
		this.snapshots.set(pid, snapshot);
		this.notifyProjectsSnapshotSynced(pid, snapshot);
		this._onDidChange.fire({ projectId: pid });
	}

	evictProjectSnapshot(projectId: string): void {
		if (this.snapshots.delete(projectId)) {
			this._onDidChange.fire({ projectId });
		}
	}

	private handleProjectChanged(projectId: string): void {
		if (!projectId) {
			return;
		}
		const existingLoad = this.inflightLoads.get(projectId);
		if (existingLoad) {
			existingLoad.isForceRefresh = true;
			existingLoad.pendingTrailingRefresh = true;
			return;
		}
		void this.loadProjectSnapshot(projectId, true);
	}

	loadProjectSnapshot(projectId: string, forceRefresh = false): Promise<IAdeProjectSnapshot | undefined> {
		if (!projectId) {
			return Promise.resolve(undefined);
		}
		const existingLoad = this.inflightLoads.get(projectId);
		if (!forceRefresh) {
			if (existingLoad) {
				return existingLoad.promise;
			}
			const cached = this.snapshots.get(projectId);
			if (cached) {
				return Promise.resolve(cached);
			}
		} else if (existingLoad) {
			if (!existingLoad.isForceRefresh) {
				existingLoad.isForceRefresh = true;
				existingLoad.pendingTrailingRefresh = true;
			}
			return existingLoad.promise;
		}

		const entry = {
			promise: undefined as unknown as Promise<IAdeProjectSnapshot | undefined>,
			isForceRefresh: forceRefresh,
			pendingTrailingRefresh: false,
		};
		entry.promise = (async () => {
			try {
				let snap: IAdeProjectSnapshot | undefined;
				for (;;) {
					entry.pendingTrailingRefresh = false;
					snap = await this.controlCenter.getProjectSnapshot(projectId);
					if (!entry.pendingTrailingRefresh) {
						break;
					}
				}
				if (snap) {
					this.snapshots.set(projectId, snap);
					this.notifyProjectsSnapshotSynced(projectId, snap);
				} else {
					this.snapshots.delete(projectId);
					if (this.projectsService.getProjectPage?.(projectId)) {
						await this.projectsService.refreshCatalog?.().catch(() => undefined);
					}
				}
				this._onDidChange.fire({ projectId });
				return snap;
			} finally {
				if (this.inflightLoads.get(projectId) === entry) {
					this.inflightLoads.delete(projectId);
				}
			}
		})();
		this.inflightLoads.set(projectId, entry);
		return entry.promise;
	}

	getDepartmentAccentColor(projectId: string, deptId: string): string | undefined {
		return this.deptColors.get(`${projectId}::${deptId}`);
	}

	setDepartmentAccentColor(projectId: string, deptId: string, colorToken: string | undefined): void {
		const key = `${projectId}::${deptId}`;
		if (colorToken) {
			this.deptColors.set(key, colorToken);
		} else {
			this.deptColors.delete(key);
		}
		this._onDidChange.fire({ projectId });
	}

	getWhiteboardAccentColor(projectId: string, boardId: string): string | undefined {
		return this.wbColors.get(`${projectId}::${boardId}`);
	}

	setWhiteboardAccentColor(projectId: string, boardId: string, colorToken: string | undefined): void {
		const key = `${projectId}::${boardId}`;
		if (colorToken) {
			this.wbColors.set(key, colorToken);
		} else {
			this.wbColors.delete(key);
		}
		this._onDidChange.fire({ projectId });
	}

	async updateCanvasLayout(projectId: string, patch: {
		readonly layoutDirection?: AdeLayoutDirection;
		readonly nodePositions?: Readonly<Record<string, { readonly x: number; readonly y: number; readonly color?: string }>>;
		readonly resetPinnedPositions?: boolean;
	}): Promise<void> {
		if (patch.resetPinnedPositions) {
			this.snapshots.delete(projectId);
		}
		const layoutPatch: Parameters<IAdeControlCenterService['uiUpdateCanvasLayout']>[1] & {
			readonly resetPinnedPositions?: boolean;
		} = patch;
		await this.controlCenter.uiUpdateCanvasLayout(projectId, layoutPatch);
		await this.loadProjectSnapshot(projectId, true);
	}
}
