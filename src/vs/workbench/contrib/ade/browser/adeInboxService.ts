/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import {
	AdeInboxSenderRank,
	AdeInboxSeverity,
	AdeWorkTreeType,
	IAdeEngineeringBackendService,
	IAdeInboxItem,
	IAdeInboxMutation,
	IAdeInboxService,
	resolveAdeInboxSeverity,
} from '../../../../platform/ade/common/adeEngineering.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAdeProjectsService } from '../common/ade.js';

export class AdeInboxService extends Disposable implements IAdeInboxService {
	declare readonly _serviceBrand: undefined;

	private readonly backend: IAdeEngineeringBackendService | undefined;
	private _items: IAdeInboxItem[] = [];
	private readonly _readyPromise: Promise<void>;
	private persistChain: Promise<void> = Promise.resolve();
	private persistPending = false;
	private activeSelfSaves = 0;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
	) {
		super();
		this.backend = instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(IAdeEngineeringBackendService);
			} catch {
				return undefined;
			}
		});
		if (this.backend?.onDidInboxChange) {
			this._register(this.backend.onDidInboxChange(externalItems => {
				if (!Array.isArray(externalItems)) {
					return;
				}
				const sorted = [...externalItems].sort((a, b) => b.createdAt - a.createdAt);
				// If a local fallback saveInbox is still in flight, merge instead of dropping external writes;
				// when using atomic main-process mutateInbox, externalItems is already the authoritative merged truth.
				if (this.activeSelfSaves > 0) {
					const byId = new Map(sorted.map(i => [i.id, i]));
					for (const localItem of this._items) {
						if (!byId.has(localItem.id)) {
							byId.set(localItem.id, localItem);
						}
					}
					const merged = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
					if (JSON.stringify(merged) !== JSON.stringify(this._items)) {
						this._items = merged;
						this._onDidChange.fire();
					}
					return;
				}
				if (JSON.stringify(sorted) !== JSON.stringify(this._items)) {
					this._items = sorted;
					this._onDidChange.fire();
				}
			}));
		}
		this._readyPromise = this.loadInitial();
	}

	private async loadInitial(): Promise<void> {
		if (!this.backend) {
			return;
		}
		try {
			const loaded = await this.backend.loadInbox();
			if (loaded.length > 0) {
				if (this._items.length === 0) {
					this._items = [...loaded].sort((a, b) => b.createdAt - a.createdAt);
				} else {
					const existingIds = new Set(this._items.map(i => i.id));
					const merged = [...this._items, ...loaded.filter(i => !existingIds.has(i.id))];
					this._items = merged.sort((a, b) => b.createdAt - a.createdAt);
				}
				this._onDidChange.fire();
			}
		} catch {
			// Ignore transient load error
		}
	}

	private persistInbox(): Promise<void> {
		if (!this.backend) {
			return Promise.resolve();
		}
		this.persistPending = true;
		const run = async (): Promise<void> => {
			while (this.persistPending) {
				this.persistPending = false;
				const snapshot = [...this._items];
				this.activeSelfSaves++;
				try {
					await this.backend!.saveInbox(snapshot);
				} finally {
					this.activeSelfSaves--;
				}
			}
		};
		const next = this.persistChain.then(run, run);
		this.persistChain = next.catch(() => undefined);
		return next.catch(() => undefined);
	}

	get items(): readonly IAdeInboxItem[] {
		return this._items;
	}

	get unreadCount(): number {
		return this._items.filter(item => item.unread && !item.resolved).length;
	}

	list(options?: { unreadOnly?: boolean; governorSessionId?: string; includeResolved?: boolean }): readonly IAdeInboxItem[] {
		const includeResolved = options?.includeResolved ?? true;
		return this._items.filter(item => {
			if (!includeResolved && item.resolved) {
				return false;
			}
			if (options?.unreadOnly && !item.unread) {
				return false;
			}
			if (options?.governorSessionId && item.governorSessionId !== options.governorSessionId) {
				return false;
			}
			return true;
		});
	}

	private async applyMutation(mutation: IAdeInboxMutation, fallbackLocalUpdate: () => void): Promise<void> {
		if (this.backend?.mutateInbox) {
			try {
				const authoritative = await this.backend.mutateInbox(mutation);
				this._items = [...authoritative].sort((a, b) => b.createdAt - a.createdAt);
				this._onDidChange.fire();
				return;
			} catch {
				// Fall back to local mutation + full save on transient error
			}
		}
		fallbackLocalUpdate();
		await this.persistInbox();
		this._onDidChange.fire();
	}

	async postGovernorMessage(params: {
		readonly governorSessionId: string;
		readonly message: string;
		readonly title?: string;
		readonly nodeId?: string;
		readonly severity?: AdeInboxSeverity;
		readonly senderRank?: AdeInboxSenderRank;
		readonly senderAgentId?: string;
	}): Promise<IAdeInboxItem> {
		await this._readyPromise;
		const agent = this.projects.getAgent(params.governorSessionId);
		const projectUri = agent?.projectUri;
		const title = params.title?.trim() || localize('adeInboxDefaultTitle', "Agent Escalation — Human Decision Needed");
		const severity: AdeInboxSeverity = params.severity ?? resolveAdeInboxSeverity({ kind: 'governor_message', title });
		const item: IAdeInboxItem = {
			id: generateUuid(),
			kind: 'governor_message',
			treeType: 'mission',
			governorSessionId: params.governorSessionId,
			governorLabel: agent?.label ?? params.governorSessionId,
			projectPath: projectUri?.fsPath ?? '',
			projectName: projectUri ? this.projects.getProjectName(projectUri) : '',
			...(params.nodeId ? { nodeId: params.nodeId } : {}),
			title,
			message: params.message.trim(),
			unread: true,
			resolved: false,
			createdAt: Date.now(),
			severity,
			senderRank: params.senderRank ?? agent?.role ?? 'governor',
			...(params.senderAgentId ? { senderAgentId: params.senderAgentId } : {}),
		};
		await this.applyMutation({ kind: 'upsert', item }, () => {
			this._items = [item, ...this._items];
		});
		return item;
	}

	async upsertUserGateTodo(params: {
		readonly governorSessionId: string;
		readonly treeType: AdeWorkTreeType;
		readonly nodeId: string;
		readonly nodeTitle: string;
		readonly description: string;
		readonly upstreamSummary: string;
		readonly rollbackCandidates: readonly { readonly id: string; readonly title: string }[];
	}): Promise<IAdeInboxItem> {
		await this._readyPromise;
		const agent = this.projects.getAgent(params.governorSessionId);
		const projectUri = agent?.projectUri;
		const item: IAdeInboxItem = {
			id: generateUuid(),
			kind: 'user_gate',
			treeType: params.treeType,
			governorSessionId: params.governorSessionId,
			governorLabel: agent?.label ?? params.governorSessionId,
			projectPath: projectUri?.fsPath ?? '',
			projectName: projectUri ? this.projects.getProjectName(projectUri) : '',
			nodeId: params.nodeId,
			nodeTitle: params.nodeTitle,
			title: localize('adeInboxGateTitle', "Acceptance Gate: [{0}] {1}", params.nodeId, params.nodeTitle),
			message: params.description.trim(),
			upstreamSummary: params.upstreamSummary,
			rollbackCandidates: params.rollbackCandidates,
			unread: true,
			resolved: false,
			createdAt: Date.now(),
			severity: 'gate',
		};
		await this.applyMutation({ kind: 'upsert', item }, () => {
			this._items = [item, ...this._items];
		});
		return item;
	}

	async markRead(id?: string): Promise<void> {
		await this._readyPromise;
		const hasUnread = this._items.some(item => (!id || item.id === id) && item.unread);
		if (!hasUnread) {
			return;
		}
		await this.applyMutation({ kind: 'markRead', id }, () => {
			this._items = this._items.map(item => ((!id || item.id === id) && item.unread)
				? { ...item, unread: false }
				: item);
		});
	}

	async resolveItem(id: string, resolution?: string): Promise<IAdeInboxItem | undefined> {
		await this._readyPromise;
		const existing = this._items.find(item => item.id === id);
		if (!existing) {
			return undefined;
		}
		const resolvedAt = Date.now();
		let resolvedItem: IAdeInboxItem = { ...existing, unread: false, resolved: true, resolution, resolvedAt };
		await this.applyMutation({ kind: 'resolve', id, resolution, resolvedAt }, () => {
			this._items = this._items.map(item => item.id === id ? resolvedItem : item);
		});
		resolvedItem = this._items.find(item => item.id === id) ?? resolvedItem;
		return resolvedItem;
	}

	async removeItemsForGovernor(governorSessionId: string): Promise<void> {
		await this._readyPromise;
		const hasAny = this._items.some(item => item.governorSessionId === governorSessionId);
		if (!hasAny) {
			return;
		}
		await this.applyMutation({ kind: 'removeGovernor', governorSessionId }, () => {
			this._items = this._items.filter(item => item.governorSessionId !== governorSessionId);
		});
	}
}
