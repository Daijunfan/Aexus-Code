/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IMissionNodePosition } from '../../../../platform/ade/common/adeMissionDag.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { AdeEngineeringEditorInput } from './adeEngineeringEditorPane.js';

const ADE_MISSIONS_STORAGE_KEY = 'aexus.ade.missions.v1';

export interface IAdeMissionRecord {
	readonly id: string;
	readonly title: string;
	readonly mermaidText: string;
	readonly positions: Readonly<Record<string, IMissionNodePosition>>;
	readonly linkedSessionId?: string;
	readonly projectUri?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export const IAdeMissionService = createDecorator<IAdeMissionService>('adeMissionService');

/**
 * Pure frontend Mission catalog backed by `IStorageService`.
 * Completely decoupled from left-sidebar session hierarchy (zero session locking, zero backend runner/prompts).
 */
export interface IAdeMissionService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;

	listMissions(): readonly IAdeMissionRecord[];
	getMission(id: string): IAdeMissionRecord | undefined;
	getMissionByLinkedSession(sessionId: string): IAdeMissionRecord | undefined;
	createMission(options?: {
		readonly id?: string;
		readonly title?: string;
		readonly mermaidText?: string;
		readonly linkedSessionId?: string;
		readonly projectUri?: string;
	}): IAdeMissionRecord;
	ensureMission(id: string, defaults?: { readonly title?: string; readonly linkedSessionId?: string; readonly projectUri?: string }): IAdeMissionRecord;
	updateMermaid(id: string, mermaidText: string): IAdeMissionRecord | undefined;
	updateNodePositions(id: string, positions: Readonly<Record<string, IMissionNodePosition>>): IAdeMissionRecord | undefined;
	clearNodePositions(id: string): IAdeMissionRecord | undefined;
	renameMission(id: string, title: string): IAdeMissionRecord | undefined;
	deleteMission(id: string): boolean;
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
					this.records.set(entry.id, {
						id: entry.id,
						title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : 'Untitled',
						mermaidText: typeof entry.mermaidText === 'string' ? entry.mermaidText : '',
						positions: entry.positions && typeof entry.positions === 'object' ? entry.positions : {},
						...(typeof entry.linkedSessionId === 'string' ? { linkedSessionId: entry.linkedSessionId } : {}),
						...(typeof entry.projectUri === 'string' ? { projectUri: entry.projectUri } : {}),
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
			if (rec.linkedSessionId === sessionId) {
				return rec;
			}
		}
		return undefined;
	}

	createMission(options?: {
		readonly id?: string;
		readonly title?: string;
		readonly mermaidText?: string;
		readonly linkedSessionId?: string;
		readonly projectUri?: string;
	}): IAdeMissionRecord {
		const id = options?.id?.trim() || `mission-${generateUuid().slice(0, 8)}`;
		const now = Date.now();
		const num = this.records.size + 1;
		const record: IAdeMissionRecord = {
			id,
			title: options?.title?.trim() || `Mission ${num}`,
			mermaidText: options?.mermaidText ?? '',
			positions: {},
			...(options?.linkedSessionId ? { linkedSessionId: options.linkedSessionId } : {}),
			...(options?.projectUri ? { projectUri: options.projectUri } : {}),
			createdAt: now,
			updatedAt: now,
		};
		this.records.set(id, record);
		this.persist();
		this._onDidChange.fire();
		return record;
	}

	ensureMission(id: string, defaults?: { readonly title?: string; readonly linkedSessionId?: string; readonly projectUri?: string }): IAdeMissionRecord {
		const existing = this.records.get(id);
		if (existing) {
			return existing;
		}
		return this.createMission({
			id,
			title: defaults?.title,
			mermaidText: '',
			linkedSessionId: defaults?.linkedSessionId,
			projectUri: defaults?.projectUri,
		});
	}

	updateMermaid(id: string, mermaidText: string): IAdeMissionRecord | undefined {
		const existing = this.records.get(id);
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
		this.records.set(id, updated);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	updateNodePositions(id: string, positions: Readonly<Record<string, IMissionNodePosition>>): IAdeMissionRecord | undefined {
		const existing = this.records.get(id);
		if (!existing) {
			return undefined;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			positions: { ...existing.positions, ...positions },
			updatedAt: Date.now(),
		};
		this.records.set(id, updated);
		this.persist();
		return updated;
	}

	clearNodePositions(id: string): IAdeMissionRecord | undefined {
		const existing = this.records.get(id);
		if (!existing) {
			return undefined;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			positions: {},
			updatedAt: Date.now(),
		};
		this.records.set(id, updated);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	renameMission(id: string, title: string): IAdeMissionRecord | undefined {
		const existing = this.records.get(id);
		const trimmed = title.trim();
		if (!existing || !trimmed) {
			return existing;
		}
		const updated: IAdeMissionRecord = {
			...existing,
			title: trimmed,
			updatedAt: Date.now(),
		};
		this.records.set(id, updated);
		this.persist();
		this._onDidChange.fire();
		return updated;
	}

	deleteMission(id: string): boolean {
		const deleted = this.records.delete(id);
		if (deleted) {
			this.persist();
			this._onDidChange.fire();
		}
		return deleted;
	}

	async openMissionEditor(id: string, options?: { side?: boolean }): Promise<void> {
		this.ensureMission(id);
		this.modeService.setMode('ade');
		const input = this.instantiationService.createInstance(AdeEngineeringEditorInput, id);
		await this.editorService.openEditor(input, { pinned: true }, options?.side ? SIDE_GROUP : undefined);
	}
}
