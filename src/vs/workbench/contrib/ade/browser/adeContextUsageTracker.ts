/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import {
	AdeModelPricingOverrides,
	resolveModelContextWindowTokens,
} from '../../../../platform/ade/common/adeModelPricing.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { IChatModel } from '../../chat/common/model/chatModel.js';
import { buildAdeEmployeeSessionUri, normalizeAdeShortEngineId } from '../common/ade.js';

export interface IAdeTurnTokenUsagePayload {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly totalTokens?: number;
}

export interface IAdeAgentContextUsage {
	readonly usedTokens: number;
	readonly contextWindowTokens: number;
	readonly ratio: number;
	readonly percent: number;
	readonly severity: 'normal' | 'warn' | 'critical';
	readonly isEstimated: boolean;
	readonly isStreaming: boolean;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly updatedAt: number;
}

interface IPersistedAgentUsageEntry {
	readonly sessionKey: string;
	readonly usedTokens: number;
	readonly isEstimated: boolean;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly updatedAt: number;
}

const ADE_CONTEXT_USAGE_STORAGE_KEY = 'aexus.ade.contextUsageByAgent.v1';
const MAX_PERSISTED_USAGE_ENTRIES = 512;
const EXT_AGENT_HISTORY_CMD = 'aexus.agentEngines.history';

export interface IAdeSessionUsageUpdateEvent {
	readonly projectId: string;
	readonly agentId: string;
}

const _onDidUpdateAdeSessionUsage = new Emitter<IAdeSessionUsageUpdateEvent>();
export const onDidUpdateAdeSessionUsage: Event<IAdeSessionUsageUpdateEvent> = _onDidUpdateAdeSessionUsage.event;

const memoryUsageStore = new Map<string, IPersistedAgentUsageEntry>();

function makeAgentKey(projectId: string, agentId: string): string {
	return `${projectId.trim()}::${agentId.trim()}`;
}

export function formatCompactContextTokens(tokens: number): string {
	const safe = Math.max(0, Math.round(Number.isFinite(tokens) ? tokens : 0));
	if (safe === 0) {
		return '0';
	}
	if (safe >= 1_000_000) {
		const m = safe / 1_000_000;
		return Number.isInteger(m) ? `${m}M` : `${m.toFixed(m >= 10 ? 0 : 1).replace(/\.0$/, '')}M`;
	}
	if (safe >= 1_000) {
		const k = safe / 1_000;
		if (k >= 100 || Number.isInteger(k)) {
			return `${Math.round(k)}K`;
		}
		return `${k.toFixed(1).replace(/\.0$/, '')}K`;
	}
	return String(safe);
}

export function estimateTextTokens(text: string): number {
	if (!text) {
		return 0;
	}
	let cjkCount = 0;
	let otherCount = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (
			(code >= 0x4E00 && code <= 0x9FFF)
			|| (code >= 0x3400 && code <= 0x4DBF)
			|| (code >= 0x3000 && code <= 0x303F)
			|| (code >= 0xFF00 && code <= 0xFFEF)
			|| (code >= 0xAC00 && code <= 0xD7AF)
		) {
			cjkCount++;
		} else {
			otherCount++;
		}
	}
	return Math.ceil(cjkCount * 1.15 + otherCount / 4);
}

/**
 * Records exact single-turn context window occupancy reported by `aexus-agents` CLI engines
 * (never accumulated across turns — `totalTokens` on the latest turn reflects live context occupancy).
 */
export function recordAdeTurnContextUsage(params: {
	readonly projectId: string;
	readonly agentId: string;
	readonly nativeSessionId?: string | null;
	readonly usage?: IAdeTurnTokenUsagePayload;
}): void {
	const { projectId, agentId, nativeSessionId, usage } = params;
	if (!projectId || !agentId || !usage) {
		return;
	}
	const inputTokens = Math.max(0, Number(usage.inputTokens ?? 0) || 0);
	const outputTokens = Math.max(0, Number(usage.outputTokens ?? 0) || 0);
	const cacheReadTokens = Math.max(0, Number(usage.cacheReadTokens ?? 0) || 0);
	const cacheWriteTokens = Math.max(0, Number(usage.cacheWriteTokens ?? 0) || 0);
	const explicitTotal = Math.max(0, Number(usage.totalTokens ?? 0) || 0);
	const usedTokens = explicitTotal > 0
		? explicitTotal
		: (inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens);
	if (usedTokens <= 0) {
		return;
	}
	const key = makeAgentKey(projectId, agentId);
	memoryUsageStore.set(key, {
		sessionKey: (nativeSessionId ?? '').trim() || 'started',
		usedTokens,
		isEstimated: false,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		updatedAt: Date.now(),
	});
	_onDidUpdateAdeSessionUsage.fire({ projectId, agentId });
}

export function clearAdeAgentContextUsage(projectId: string, agentId: string): void {
	if (!projectId || !agentId) {
		return;
	}
	const key = makeAgentKey(projectId, agentId);
	if (memoryUsageStore.delete(key)) {
		_onDidUpdateAdeSessionUsage.fire({ projectId, agentId });
	}
}

export function buildContextUsageSnapshot(params: {
	readonly usedTokens: number;
	readonly model?: string;
	readonly engine?: string;
	readonly overrides?: AdeModelPricingOverrides;
	readonly isEstimated?: boolean;
	readonly isStreaming?: boolean;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly updatedAt?: number;
}): IAdeAgentContextUsage {
	const shortEngine = params.engine ? normalizeAdeShortEngineId(params.engine) : undefined;
	const contextWindowTokens = Math.max(1_024, resolveModelContextWindowTokens(params.model, shortEngine, params.overrides));
	const usedTokens = Math.max(0, Math.round(Number.isFinite(params.usedTokens) ? params.usedTokens : 0));
	const ratio = contextWindowTokens > 0 ? Math.max(0, Math.min(1, usedTokens / contextWindowTokens)) : 0;
	const rawPct = contextWindowTokens > 0 ? (usedTokens / contextWindowTokens) * 100 : 0;
	const percent = usedTokens === 0 ? 0 : Math.min(100, Math.max(1, Math.round(rawPct)));
	const severity: 'normal' | 'warn' | 'critical' = rawPct >= 90 ? 'critical' : (rawPct >= 70 ? 'warn' : 'normal');
	return {
		usedTokens,
		contextWindowTokens,
		ratio,
		percent,
		severity,
		isEstimated: Boolean(params.isEstimated),
		isStreaming: Boolean(params.isStreaming),
		inputTokens: params.inputTokens,
		outputTokens: params.outputTokens,
		cacheReadTokens: params.cacheReadTokens,
		cacheWriteTokens: params.cacheWriteTokens,
		updatedAt: params.updatedAt ?? 0,
	};
}

/**
 * Pure frontend Context Window Usage Coordinator for ADE Project Canvas:
 * - Combines Tier 1 exact CLI turn usage, Tier 2 live open `IChatService` streaming deltas,
 *   and Tier 3 lazy cold-start history estimation with `IStorageService` persistence.
 * - Zero backend (`platform/ade/node`) modifications.
 */
export class AdeProjectContextUsageTracker extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly watchedModels = new Map<string, { readonly model: IChatModel; readonly sub: IDisposable }>();
	private readonly modelDisposables = this._register(new DisposableStore());
	private readonly coldStartProbedKeys = new Set<string>();
	private throttleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly storageService: IStorageService,
		private readonly chatService: IChatService | undefined,
		private readonly commandService: ICommandService | undefined,
	) {
		super();
		this.hydrateFromStorage();

		this._register(onDidUpdateAdeSessionUsage(() => {
			this.persistToStorage();
			this.scheduleNotify();
		}));

		if (this.chatService?.onDidCreateModel) {
			this._register(this.chatService.onDidCreateModel(() => {
				this.scheduleNotify();
			}));
		}

		this._register({
			dispose: () => {
				if (this.throttleTimer !== undefined) {
					clearTimeout(this.throttleTimer);
					this.throttleTimer = undefined;
				}
			},
		});
	}

	private hydrateFromStorage(): void {
		try {
			const raw = this.storageService.get(ADE_CONTEXT_USAGE_STORAGE_KEY, StorageScope.APPLICATION);
			if (!raw) {
				return;
			}
			const parsed = JSON.parse(raw) as Record<string, IPersistedAgentUsageEntry>;
			if (!parsed || typeof parsed !== 'object') {
				return;
			}
			for (const [k, v] of Object.entries(parsed)) {
				if (v && typeof v.usedTokens === 'number' && v.usedTokens > 0 && !memoryUsageStore.has(k)) {
					memoryUsageStore.set(k, v);
				}
			}
		} catch {
			// Ignore malformed cache
		}
	}

	private persistToStorage(): void {
		try {
			const entries = [...memoryUsageStore.entries()]
				.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
				.slice(0, MAX_PERSISTED_USAGE_ENTRIES);
			const serializable: Record<string, IPersistedAgentUsageEntry> = {};
			for (const [k, v] of entries) {
				serializable[k] = v;
			}
			this.storageService.store(
				ADE_CONTEXT_USAGE_STORAGE_KEY,
				JSON.stringify(serializable),
				StorageScope.APPLICATION,
				StorageTarget.MACHINE,
			);
		} catch {
			// Ignore quota errors
		}
	}

	private scheduleNotify(): void {
		if (this.throttleTimer !== undefined) {
			return;
		}
		this.throttleTimer = setTimeout(() => {
			this.throttleTimer = undefined;
			if (!this._store.isDisposed) {
				this._onDidChange.fire();
			}
		}, 220);
	}

	resolveAgentUsage(params: {
		readonly projectId: string;
		readonly agentId: string;
		readonly engine: string;
		readonly model: string;
		readonly sessionStarted: boolean;
		readonly sessionResource?: string | null;
		readonly nativeSessionId?: string | null;
		readonly liveChatState?: 'idle' | 'working' | 'pending';
		readonly overrides?: AdeModelPricingOverrides;
	}): IAdeAgentContextUsage {
		const {
			projectId,
			agentId,
			engine,
			model,
			sessionStarted,
			sessionResource,
			nativeSessionId,
			liveChatState,
			overrides,
		} = params;

		if (!sessionStarted) {
			const key = makeAgentKey(projectId, agentId);
			if (memoryUsageStore.has(key)) {
				memoryUsageStore.delete(key);
				this.persistToStorage();
			}
			return buildContextUsageSnapshot({
				usedTokens: 0,
				model,
				engine,
				overrides,
				isStreaming: false,
			});
		}

		const key = makeAgentKey(projectId, agentId);
		const currentSessionKey = (nativeSessionId ?? '').trim() || 'started';
		let stored = memoryUsageStore.get(key);
		if (stored && stored.sessionKey !== 'started' && nativeSessionId && stored.sessionKey !== nativeSessionId.trim()) {
			memoryUsageStore.delete(key);
			stored = undefined;
		}

		let usedTokens = stored?.usedTokens ?? 0;
		let isEstimated = stored?.isEstimated ?? false;
		let isStreaming = liveChatState === 'working';

		// Tier 2: Inspect live open ChatModel for real-time streaming growth or metadata usage
		const sessionUri = this.resolveSessionUri(engine, projectId, agentId, sessionResource);
		const chatModel = sessionUri ? this.chatService?.getSession(sessionUri) : undefined;
		if (chatModel && sessionUri) {
			this.ensureWatchingChatModel(sessionUri.toString(), chatModel);
			const fromModel = this.extractUsageFromChatModel(chatModel);
			if (fromModel.inProgress) {
				isStreaming = true;
			}
			if (fromModel.exactTokens > 0) {
				usedTokens = fromModel.exactTokens;
				isEstimated = false;
			} else if (fromModel.estimatedTokens > 0) {
				if (usedTokens === 0 || isEstimated || fromModel.inProgress) {
					usedTokens = Math.max(usedTokens, fromModel.estimatedTokens);
					if (!stored || stored.isEstimated) {
						isEstimated = true;
					}
				}
			}
		} else if (usedTokens === 0 && sessionStarted && sessionUri && this.commandService) {
			// Tier 3: Cold-start lazy estimation from persisted session history
			const probeKey = `${key}::${currentSessionKey}`;
			if (!this.coldStartProbedKeys.has(probeKey)) {
				this.coldStartProbedKeys.add(probeKey);
				void this.probeColdStartHistory(projectId, agentId, currentSessionKey, sessionUri);
			}
		}

		return buildContextUsageSnapshot({
			usedTokens,
			model,
			engine,
			overrides,
			isEstimated,
			isStreaming,
			inputTokens: stored?.inputTokens,
			outputTokens: stored?.outputTokens,
			cacheReadTokens: stored?.cacheReadTokens,
			cacheWriteTokens: stored?.cacheWriteTokens,
			updatedAt: stored?.updatedAt,
		});
	}

	private resolveSessionUri(
		engine: string,
		projectId: string,
		agentId: string,
		sessionResource?: string | null,
	): URI | undefined {
		if (sessionResource && sessionResource.trim()) {
			try {
				return URI.parse(sessionResource.trim());
			} catch {
				// Fall through
			}
		}
		return buildAdeEmployeeSessionUri(engine, projectId, agentId);
	}

	private ensureWatchingChatModel(uriKey: string, model: IChatModel): void {
		const existing = this.watchedModels.get(uriKey);
		if (existing?.model === model) {
			return;
		}
		existing?.sub.dispose();
		const sub = this.modelDisposables.add(model.onDidChange(() => {
			this.scheduleNotify();
		}));
		this.watchedModels.set(uriKey, { model, sub });
	}

	private extractUsageFromChatModel(model: IChatModel): {
		readonly exactTokens: number;
		readonly estimatedTokens: number;
		readonly inProgress: boolean;
	} {
		const requests = model.getRequests();
		if (requests.length === 0) {
			return { exactTokens: 0, estimatedTokens: 0, inProgress: false };
		}
		let exactTokens = 0;
		let totalCharsTokens = 1_150; // Base ADE system prompt + tool definitions baseline
		let inProgress = false;

		for (const req of requests) {
			const promptText = req.message?.text ?? '';
			totalCharsTokens += estimateTextTokens(promptText) + 18;
			const resp = req.response;
			if (resp) {
				if (!resp.isComplete) {
					inProgress = true;
				}
				const respText = typeof resp.response?.toString === 'function' ? resp.response.toString() : '';
				totalCharsTokens += estimateTextTokens(respText) + 24;
				const meta = resp.result?.metadata as Record<string, unknown> | undefined;
				const usageObj = (meta?.usage ?? (resp.result as unknown as { usage?: Record<string, unknown> } | undefined)?.usage) as Record<string, unknown> | undefined;
				if (usageObj && typeof usageObj === 'object') {
					const tot = Number(usageObj.totalTokens ?? usageObj.total_tokens ?? 0);
					const inp = Number(usageObj.promptTokens ?? usageObj.inputTokens ?? usageObj.input_tokens ?? 0);
					const out = Number(usageObj.completionTokens ?? usageObj.outputTokens ?? usageObj.output_tokens ?? 0);
					const cacheR = Number(usageObj.cacheReadTokens ?? usageObj.cache_read_input_tokens ?? 0);
					const cacheW = Number(usageObj.cacheWriteTokens ?? usageObj.cache_creation_input_tokens ?? 0);
					const resolved = tot > 0 ? tot : (inp + out + cacheR + cacheW);
					if (resolved > 0) {
						exactTokens = resolved;
					}
				}
			}
		}
		return {
			exactTokens,
			estimatedTokens: requests.length > 0 ? totalCharsTokens : 0,
			inProgress,
		};
	}

	private async probeColdStartHistory(
		projectId: string,
		agentId: string,
		sessionKey: string,
		sessionUri: URI,
	): Promise<void> {
		if (!this.commandService || this._store.isDisposed) {
			return;
		}
		try {
			const items = await this.commandService.executeCommand<readonly unknown[] | undefined>(EXT_AGENT_HISTORY_CMD, sessionUri);
			if (this._store.isDisposed || !Array.isArray(items) || items.length === 0) {
				return;
			}
			const key = makeAgentKey(projectId, agentId);
			if (memoryUsageStore.has(key)) {
				return;
			}
			let tokens = 1_150;
			for (const entry of items) {
				if (!entry || typeof entry !== 'object') {
					continue;
				}
				const rec = entry as Record<string, unknown>;
				if (typeof rec.prompt === 'string') {
					tokens += estimateTextTokens(rec.prompt);
				}
				if (typeof rec.text === 'string') {
					tokens += estimateTextTokens(rec.text);
				}
				if (typeof rec.content === 'string') {
					tokens += estimateTextTokens(rec.content);
				}
				if (Array.isArray(rec.parts)) {
					for (const part of rec.parts) {
						if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).value === 'string') {
							tokens += estimateTextTokens((part as Record<string, unknown>).value as string);
						}
					}
				}
			}
			if (tokens > 1_150) {
				memoryUsageStore.set(key, {
					sessionKey,
					usedTokens: tokens,
					isEstimated: true,
					updatedAt: Date.now(),
				});
				this.persistToStorage();
				this.scheduleNotify();
			}
		} catch {
			// Best-effort history estimation
		}
	}
}
