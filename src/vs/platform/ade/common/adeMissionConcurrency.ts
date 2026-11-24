/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IJSONSchema } from '../../../base/common/jsonSchema.js';
import type { IMissionBoundaryConfig } from './adeMissionBoundary.js';
import type { IMissionNodeTelemetry } from './adeMissionFinOpsAndHistory.js';

export type MissionQueueBlockReason = 'global' | 'local_host' | 'cloud_host' | 'provider' | 'employee';

export interface IMissionConcurrencyLimits {
	/** Hard ceiling on total simultaneously active task tokens in a Mission (`0` = unlimited). Default: 8. */
	readonly maxGlobal?: number;
	/** Max simultaneously active task tokens on the local host (`0` = unlimited). Default: 4. */
	readonly maxLocalHost?: number;
	/** Default max simultaneously active task tokens per SSH Cloud Host (`0` = unlimited). Default: 2. */
	readonly maxPerCloudHost?: number;
	/** Default max simultaneously active task tokens per cloud LLM provider (`0` = unlimited). Default: 4. */
	readonly maxPerProvider?: number;
	/** Optional per-hostAlias overrides (e.g. `{ "gpu-h100": 1 }`). */
	readonly hostOverrides?: Readonly<Record<string, number>>;
	/** Optional per-provider overrides (e.g. `{ "anthropic": 3, "openai": 4 }`). */
	readonly providerOverrides?: Readonly<Record<string, number>>;
}

export interface IResolvedMissionConcurrencyLimits {
	readonly maxGlobal: number;
	readonly maxLocalHost: number;
	readonly maxPerCloudHost: number;
	readonly maxPerProvider: number;
	readonly hostOverrides: Readonly<Record<string, number>>;
	readonly providerOverrides: Readonly<Record<string, number>>;
}

export const DEFAULT_MISSION_CONCURRENCY_LIMITS: Readonly<Pick<IResolvedMissionConcurrencyLimits, 'maxGlobal' | 'maxLocalHost' | 'maxPerCloudHost' | 'maxPerProvider'>> = {
	maxGlobal: 8,
	maxLocalHost: 4,
	maxPerCloudHost: 2,
	maxPerProvider: 4,
};

export const ADE_MISSION_CONCURRENCY_CONFIG_KEY = 'aexus.ade.mission.concurrency';

export const ADE_MISSION_CONCURRENCY_JSON_SCHEMA: IJSONSchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		maxGlobal: {
			type: 'integer',
			minimum: 0,
			maximum: 128,
			default: DEFAULT_MISSION_CONCURRENCY_LIMITS.maxGlobal,
			description: 'Hard ceiling on simultaneously active task nodes across a Mission (0 = unlimited).',
		},
		maxLocalHost: {
			type: 'integer',
			minimum: 0,
			maximum: 64,
			default: DEFAULT_MISSION_CONCURRENCY_LIMITS.maxLocalHost,
			description: 'Maximum simultaneously active task nodes on the local machine (0 = unlimited).',
		},
		maxPerCloudHost: {
			type: 'integer',
			minimum: 0,
			maximum: 64,
			default: DEFAULT_MISSION_CONCURRENCY_LIMITS.maxPerCloudHost,
			description: 'Default maximum simultaneously active task nodes per remote SSH Cloud Host (protects GPU VRAM & SSH MaxSessions; 0 = unlimited).',
		},
		maxPerProvider: {
			type: 'integer',
			minimum: 0,
			maximum: 64,
			default: DEFAULT_MISSION_CONCURRENCY_LIMITS.maxPerProvider,
			description: 'Default maximum simultaneously active task nodes per cloud LLM provider (protects against API 429 rate limits; 0 = unlimited).',
		},
		hostOverrides: {
			type: 'object',
			default: {},
			additionalProperties: { type: 'integer', minimum: 0, maximum: 64 },
			description: 'Optional per-host concurrency overrides keyed by host alias (e.g. { "gpu-h100": 1 }).',
		},
		providerOverrides: {
			type: 'object',
			default: {},
			additionalProperties: { type: 'integer', minimum: 0, maximum: 64 },
			description: 'Optional per-provider concurrency overrides keyed by provider ID (e.g. { "anthropic": 3, "openai": 4 }).',
		},
	},
};

export function normalizeMissionConcurrencyLimits(raw?: IMissionConcurrencyLimits): IResolvedMissionConcurrencyLimits {
	const clamp = (val: unknown, fallback: number): number => {
		if (typeof val !== 'number' || !Number.isFinite(val)) {
			return fallback;
		}
		return Math.max(0, Math.min(128, Math.floor(val)));
	};
	const normalizeMap = (src: unknown): Record<string, number> => {
		const out: Record<string, number> = {};
		if (!src || typeof src !== 'object' || Array.isArray(src)) {
			return out;
		}
		for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
			const key = k.trim().toLowerCase();
			if (key && typeof v === 'number' && Number.isFinite(v)) {
				out[key] = Math.max(0, Math.min(64, Math.floor(v)));
			}
		}
		return out;
	};
	return {
		maxGlobal: clamp(raw?.maxGlobal, DEFAULT_MISSION_CONCURRENCY_LIMITS.maxGlobal),
		maxLocalHost: clamp(raw?.maxLocalHost, DEFAULT_MISSION_CONCURRENCY_LIMITS.maxLocalHost),
		maxPerCloudHost: clamp(raw?.maxPerCloudHost, DEFAULT_MISSION_CONCURRENCY_LIMITS.maxPerCloudHost),
		maxPerProvider: clamp(raw?.maxPerProvider, DEFAULT_MISSION_CONCURRENCY_LIMITS.maxPerProvider),
		hostOverrides: normalizeMap(raw?.hostOverrides),
		providerOverrides: normalizeMap(raw?.providerOverrides),
	};
}

/**
 * Infers the cloud LLM API provider bucket for per-provider concurrency limiting.
 * Self-hosted / local models (ollama, lmstudio, vllm, mlx, llama.cpp) return `undefined`
 * so they are governed by host CPU/VRAM slot ceilings rather than cloud API 429 buckets.
 */
export function inferMissionConcurrencyProvider(model?: string, engineId?: string): string | undefined {
	const m = (model ?? '').trim().toLowerCase();
	if (m) {
		if (/(?:^|[:/_-])(ollama|lmstudio|lm-studio|vllm|llama\.?cpp|mlx|local)(?:$|[:/_-])/.test(m)) {
			return undefined;
		}
		if (m.includes('claude') || m.includes('anthropic') || /(?:^|[:/_-])(fable|mythos)(?:$|[:/_.\d-])/.test(m)) {
			return 'anthropic';
		}
		if (m.includes('gpt-') || m.includes('codex') || m.includes('openai') || /^o[134](?:$|[-.])/.test(m)) {
			return 'openai';
		}
		if (m.includes('gemini') || m.includes('google') || /(?:^|[:/_-])(argon|neon|carbon|hydrogen)(?:$|[:/_.\d-])/.test(m)) {
			return 'google';
		}
		if (m.includes('deepseek')) {
			return 'deepseek';
		}
		if (m.includes('qwen') || m.includes('qwq')) {
			return 'qwen';
		}
		if (m.includes('kimi') || m.includes('moonshot')) {
			return 'moonshot';
		}
		if (m.includes('glm') || m.includes('zhipu')) {
			return 'zhipu';
		}
		if (m.includes('minimax')) {
			return 'minimax';
		}
		if (m.includes('grok') || m.includes('xai')) {
			return 'xai';
		}
		if (m.includes('mistral') || m.includes('codestral')) {
			return 'mistral';
		}
	}
	const e = (engineId ?? '').trim().toLowerCase();
	if (!e) {
		return undefined;
	}
	if (e.includes('claude')) {
		return 'anthropic';
	}
	if (e.includes('codex') || e.includes('openai')) {
		return 'openai';
	}
	if (e.includes('antigravity') || e.includes('gemini')) {
		return 'google';
	}
	if (e.includes('dsh') || e.includes('deepseek')) {
		return 'deepseek';
	}
	return undefined;
}

export interface IMissionTokenQueueInfo {
	/** 1-based FIFO rank among all currently queued tokens (`#1`, `#2`, ...). */
	readonly position: number;
	/** Total number of tokens currently waiting in the concurrency queue. */
	readonly totalQueued: number;
	/** Primary concurrency semaphore level currently saturated. */
	readonly blockedBy: MissionQueueBlockReason;
	/** Scope label for the saturated semaphore (e.g. `'global'`, `'local'`, `'gpu-h100'`, `'anthropic'`). */
	readonly scopeKey: string;
	/** Active slot usage vs ceiling at scheduling time (e.g. `2/2`). */
	readonly activeSlots: number;
	readonly maxSlots: number;
	/** Timestamp when the token entered the concurrency queue. */
	readonly enqueuedAt: number;
	/** Pending dispatch prompt preserved while queued so draining promotes cleanly with zero prompt loss. */
	readonly pendingPrompt: string;
	readonly isRejection?: boolean;
}

export interface IConcurrencySlotUsage {
	activeGlobal: number;
	readonly activeByHost: Map<string, number>;
	readonly activeByProvider: Map<string, number>;
	/** Tracks live (`active` or `blocked`) occupancy per employee agentId to enforce exclusive session access. */
	readonly activeByAgent: Map<string, string>;
}

export type ConcurrencyAdmissionDecision =
	| { readonly admitted: true }
	| {
		readonly admitted: false;
		readonly blockedBy: MissionQueueBlockReason;
		readonly scopeKey: string;
		readonly activeSlots: number;
		readonly maxSlots: number;
	};

export interface IConcurrencySchedulableToken {
	readonly id: string;
	readonly nodeId: string;
	readonly holderAgentId?: string;
	readonly status: string;
	readonly arrivedAt: number;
	readonly lastActivityAt: number;
	readonly blocked?: {
		readonly watchPid?: number;
		readonly hostAlias?: string;
	};
	readonly queued?: IMissionTokenQueueInfo;
}

export interface IConcurrencySlotContext<TToken extends IConcurrencySchedulableToken = IConcurrencySchedulableToken> {
	readonly status: string;
	readonly boundary: IMissionBoundaryConfig;
	readonly nodeTelemetry?: Readonly<Record<string, IMissionNodeTelemetry>>;
	readonly concurrencyLimits?: IMissionConcurrencyLimits;
	tokens: Record<string, TToken>;
}

export function parseTokenSeqNumber(tokenId: string): number {
	const m = /^tok-(\d+)$/.exec(tokenId);
	return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

export function resolveNodeConcurrencyDimensions(
	ctx: Pick<IConcurrencySlotContext, 'boundary' | 'nodeTelemetry'>,
	nodeId: string,
): { readonly hostKey: string; readonly hostLabel: string; readonly provider: string | undefined } {
	const assign = ctx.boundary.nodeAssignments[nodeId];
	const hostLabel = assign?.hostAlias?.trim() || 'local';
	const hostKey = hostLabel.toLowerCase();
	const explicitProvider = assign?.provider?.trim().toLowerCase() || undefined;
	const provider = explicitProvider ?? inferMissionConcurrencyProvider(ctx.nodeTelemetry?.[nodeId]?.model);
	return { hostKey, hostLabel, provider };
}

export function computeConcurrencySlotUsage<TToken extends IConcurrencySchedulableToken>(
	ctx: Pick<IConcurrencySlotContext<TToken>, 'tokens' | 'boundary' | 'nodeTelemetry'>,
	excludeTokenId?: string,
): IConcurrencySlotUsage {
	let activeGlobal = 0;
	const activeByHost = new Map<string, number>();
	const activeByProvider = new Map<string, number>();
	const activeByAgent = new Map<string, string>();

	for (const tok of Object.values(ctx.tokens)) {
		if (excludeTokenId && tok.id === excludeTokenId) {
			continue;
		}
		if (tok.status === 'active') {
			activeGlobal += 1;
			const { hostKey, provider } = resolveNodeConcurrencyDimensions(ctx, tok.nodeId);
			activeByHost.set(hostKey, (activeByHost.get(hostKey) ?? 0) + 1);
			if (provider) {
				activeByProvider.set(provider, (activeByProvider.get(provider) ?? 0) + 1);
			}
			const agentId = (ctx.boundary.nodeAssignments[tok.nodeId]?.agentId ?? tok.holderAgentId)?.trim();
			if (agentId) {
				activeByAgent.set(agentId, tok.id);
			}
		} else if (tok.status === 'blocked') {
			// A blocked token still owns its employee's underlying LLM session until completed/failed/recalled;
			// prevent parallel sibling nodes bound to the same @Employee from contaminating its suspended context.
			const agentId = (ctx.boundary.nodeAssignments[tok.nodeId]?.agentId ?? tok.holderAgentId)?.trim();
			if (agentId) {
				activeByAgent.set(agentId, tok.id);
			}
			if (tok.blocked?.watchPid !== undefined) {
				// A blocked token watching a live OS/GPU PID still occupies compute/VRAM on its host,
				// while freeing cloud LLM API provider & active-turn global slots for OTHER employees.
				const fallbackHost = resolveNodeConcurrencyDimensions(ctx, tok.nodeId).hostKey;
				const blockedHost = (tok.blocked.hostAlias?.trim() || fallbackHost).toLowerCase();
				activeByHost.set(blockedHost, (activeByHost.get(blockedHost) ?? 0) + 1);
			}
		}
	}

	return { activeGlobal, activeByHost, activeByProvider, activeByAgent };
}

export function evaluateConcurrencySlot(
	ctx: Pick<IConcurrencySlotContext, 'boundary' | 'nodeTelemetry'>,
	usage: IConcurrencySlotUsage,
	nodeId: string,
	limits: IResolvedMissionConcurrencyLimits,
): ConcurrencyAdmissionDecision {
	// 0. Per-employee exclusive session lock (ALWAYS enforced regardless of host/provider/global caps)
	const agentId = ctx.boundary.nodeAssignments[nodeId]?.agentId?.trim();
	if (agentId && usage.activeByAgent.has(agentId)) {
		return {
			admitted: false,
			blockedBy: 'employee',
			scopeKey: agentId,
			activeSlots: 1,
			maxSlots: 1,
		};
	}

	const { hostKey, hostLabel, provider } = resolveNodeConcurrencyDimensions(ctx, nodeId);

	// 1. Host slot cap (protects local RAM/CPU & cloud GPU VRAM / SSH MaxSessions)
	const hostLimit = Object.hasOwn(limits.hostOverrides, hostKey)
		? limits.hostOverrides[hostKey]
		: (hostKey === 'local' ? limits.maxLocalHost : limits.maxPerCloudHost);
	const hostUsed = usage.activeByHost.get(hostKey) ?? 0;
	if (hostLimit > 0 && hostUsed >= hostLimit) {
		return {
			admitted: false,
			blockedBy: hostKey === 'local' ? 'local_host' : 'cloud_host',
			scopeKey: hostLabel,
			activeSlots: hostUsed,
			maxSlots: hostLimit,
		};
	}

	// 2. Cloud LLM provider slot cap (protects against API 429 rate-limit bursts)
	if (provider) {
		const providerLimit = Object.hasOwn(limits.providerOverrides, provider)
			? limits.providerOverrides[provider]
			: limits.maxPerProvider;
		const providerUsed = usage.activeByProvider.get(provider) ?? 0;
		if (providerLimit > 0 && providerUsed >= providerLimit) {
			return {
				admitted: false,
				blockedBy: 'provider',
				scopeKey: provider,
				activeSlots: providerUsed,
				maxSlots: providerLimit,
			};
		}
	}

	// 3. Global Mission active slot cap
	if (limits.maxGlobal > 0 && usage.activeGlobal >= limits.maxGlobal) {
		return {
			admitted: false,
			blockedBy: 'global',
			scopeKey: 'global',
			activeSlots: usage.activeGlobal,
			maxSlots: limits.maxGlobal,
		};
	}

	return { admitted: true };
}

export function recordActiveSlotOccupancy(
	ctx: Pick<IConcurrencySlotContext, 'boundary' | 'nodeTelemetry'>,
	usage: IConcurrencySlotUsage,
	nodeId: string,
	tokenId?: string,
): void {
	const { hostKey, provider } = resolveNodeConcurrencyDimensions(ctx, nodeId);
	usage.activeGlobal += 1;
	usage.activeByHost.set(hostKey, (usage.activeByHost.get(hostKey) ?? 0) + 1);
	if (provider) {
		usage.activeByProvider.set(provider, (usage.activeByProvider.get(provider) ?? 0) + 1);
	}
	const agentId = ctx.boundary.nodeAssignments[nodeId]?.agentId?.trim();
	if (agentId) {
		usage.activeByAgent.set(agentId, tokenId ?? nodeId);
	}
}

export function getSortedQueuedTokens<TToken extends IConcurrencySchedulableToken>(
	ctx: Pick<IConcurrencySlotContext<TToken>, 'tokens'>,
): TToken[] {
	return Object.values(ctx.tokens)
		.filter(t => t.status === 'queued')
		.sort((a, b) => {
			const enqDiff = (a.queued?.enqueuedAt ?? a.arrivedAt) - (b.queued?.enqueuedAt ?? b.arrivedAt);
			if (enqDiff !== 0) {
				return enqDiff;
			}
			const arrDiff = a.arrivedAt - b.arrivedAt;
			if (arrDiff !== 0) {
				return arrDiff;
			}
			return parseTokenSeqNumber(a.id) - parseTokenSeqNumber(b.id);
		});
}

/**
 * O(Q log Q + T) queue renumbering: computes slot usage once, updates all queued tokens in FIFO order,
 * and batch-recomputes node states across all touched nodes in a single pass instead of O(Q * T).
 */
export function renumberMissionConcurrencyQueueCore<TToken extends IConcurrencySchedulableToken>(
	ctx: IConcurrencySlotContext<TToken>,
	helpers: {
		readonly buildPrompt: (token: TToken, nodeId: string, isRejection?: boolean) => string;
		readonly recomputeNodeStatesBatch: (nodeIds: ReadonlySet<string>, fallbackState: 'queued') => void;
	},
	precomputedUsage?: IConcurrencySlotUsage,
): void {
	const queued = getSortedQueuedTokens(ctx);
	if (queued.length === 0) {
		return;
	}
	const limits = normalizeMissionConcurrencyLimits(ctx.concurrencyLimits);
	const usage = precomputedUsage ?? computeConcurrencySlotUsage(ctx);
	const totalQueued = queued.length;
	const touchedNodeIds = new Set<string>();
	for (let i = 0; i < queued.length; i++) {
		const tok = queued[i];
		const decision = evaluateConcurrencySlot(ctx, usage, tok.nodeId, limits);
		const prev = tok.queued;
		const nextQueueInfo: IMissionTokenQueueInfo = {
			position: i + 1,
			totalQueued,
			blockedBy: !decision.admitted ? decision.blockedBy : (prev?.blockedBy ?? 'global'),
			scopeKey: !decision.admitted ? decision.scopeKey : (prev?.scopeKey ?? 'global'),
			activeSlots: !decision.admitted ? decision.activeSlots : (prev?.activeSlots ?? usage.activeGlobal),
			maxSlots: !decision.admitted ? decision.maxSlots : (prev?.maxSlots ?? limits.maxGlobal),
			enqueuedAt: prev?.enqueuedAt ?? tok.arrivedAt,
			pendingPrompt: prev?.pendingPrompt ?? helpers.buildPrompt(tok, tok.nodeId, prev?.isRejection),
			...(prev?.isRejection ? { isRejection: true } : {}),
		};
		ctx.tokens[tok.id] = {
			...tok,
			queued: nextQueueInfo,
		};
		touchedNodeIds.add(tok.nodeId);
	}
	helpers.recomputeNodeStatesBatch(touchedNodeIds, 'queued');
}

/**
 * Work-conserving multi-level FIFO concurrency scheduler:
 * promotes every queued token whose `(employee, host, provider, global)` semaphores have free capacity,
 * avoiding head-of-line blocking across independent hosts/providers, then renumbers remaining ranks `#1..#K` in O(Q log Q + T).
 */
export function drainMissionConcurrencyQueueCore<TToken extends IConcurrencySchedulableToken>(
	missionId: string,
	ctx: IConcurrencySlotContext<TToken>,
	now: number,
	helpers: {
		readonly buildPrompt: (token: TToken, nodeId: string, isRejection?: boolean) => string;
		readonly recomputeNodeStatesBatch: (nodeIds: ReadonlySet<string>, fallbackState: 'active' | 'queued') => void;
		readonly emitDispatch: (effect: {
			readonly kind: 'dispatch_token';
			readonly missionId: string;
			readonly nodeId: string;
			readonly tokenId: string;
			readonly holderAgentId?: string;
			readonly isRejection?: boolean;
			readonly prompt: string;
		}) => void;
	},
): string[] {
	const queued = getSortedQueuedTokens(ctx);
	if (queued.length === 0) {
		return [];
	}
	const limits = normalizeMissionConcurrencyLimits(ctx.concurrencyLimits);
	const usage = computeConcurrencySlotUsage(ctx);
	const promotedIds: string[] = [];
	const promotedNodeIds = new Set<string>();

	if (ctx.status === 'running') {
		for (const tok of queued) {
			const decision = evaluateConcurrencySlot(ctx, usage, tok.nodeId, limits);
			if (!decision.admitted) {
				continue;
			}
			const assignedHolder = ctx.boundary.nodeAssignments[tok.nodeId]?.agentId ?? tok.holderAgentId;
			const pendingPrompt = tok.queued?.pendingPrompt || helpers.buildPrompt(tok, tok.nodeId, tok.queued?.isRejection);
			const isRejection = tok.queued?.isRejection;
			ctx.tokens[tok.id] = {
				...tok,
				status: 'active',
				holderAgentId: assignedHolder,
				queued: undefined,
				lastActivityAt: now,
			};
			recordActiveSlotOccupancy(ctx, usage, tok.nodeId, tok.id);
			promotedNodeIds.add(tok.nodeId);
			helpers.emitDispatch({
				kind: 'dispatch_token',
				missionId,
				nodeId: tok.nodeId,
				tokenId: tok.id,
				holderAgentId: assignedHolder,
				isRejection,
				prompt: pendingPrompt,
			});
			promotedIds.push(tok.id);
		}
	}

	if (promotedNodeIds.size > 0) {
		helpers.recomputeNodeStatesBatch(promotedNodeIds, 'active');
	}
	renumberMissionConcurrencyQueueCore(ctx, helpers, usage);
	return promotedIds;
}
