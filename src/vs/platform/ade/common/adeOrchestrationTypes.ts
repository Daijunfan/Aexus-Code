/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMissionNodeCheckHook } from './adeMissionDag.js';
import {
	IMissionRollingHistoryState,
	IMissionTokenBlockedInfo,
	IMissionTraceNode,
} from './adeMissionEngine.js';
import { IOrchestrationGraphNode } from './adeOrchestrationGraph.js';
import { IAdeOrganizationConfig, IAdeRankDefinition } from './adeRoleSchema.js';

export const ORCHESTRATION_SILENCE_REMINDER_MINUTES = 5;

const COMPANY_WIDE_EXEC_DEPT_RE = /^(?:executive|hq|headquarters|leadership|company|general|all|root|管理层|高管|总部|决策层|总办|公司)$/i;

export function isCompanyWideExecutiveDept(dept: string | undefined): boolean {
	const clean = dept?.trim();
	return Boolean(clean && COMPANY_WIDE_EXEC_DEPT_RE.test(clean));
}

export type MissionTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface IMissionTaskCheckReceipt {
	readonly passed: boolean;
	readonly summary: string;
	readonly checkedAt: number;
	readonly checkCount?: number;
	readonly tokenId?: string;
	readonly byNodeId?: string;
}

export interface IMissionTaskStatusRecord {
	readonly status: MissionTaskStatus;
	readonly completedBy?: string;
	readonly completedByLabel?: string;
	readonly completedByTier?: number;
	readonly completedAt?: number;
	readonly note?: string;
	readonly updatedAt: number;
	/** Live Orchestration staff node ID currently executing or last assigned to this task. */
	readonly assigneeNodeId?: string;
	readonly assigneeLabel?: string;
	/** Currently active / blocked / waiting_join Orchestration token IDs bound to this task node. */
	readonly activeTokenIds?: readonly string[];
	/** Most recent Orchestration token ID bound to this task node. */
	readonly lastTokenId?: string;
	/** Timestamp when the first bound Orchestration token began executing this task. */
	readonly startedAt?: number;
	/** Elapsed execution duration in milliseconds (live or frozen at completion). */
	readonly durationMs?: number;
	/** Lightweight artifact/decision pointer IDs (`art-N`, `dec-N`) produced for this task. */
	readonly artifactPtrs?: readonly string[];
	/** Repo-relative files reported as modified on tokens bound to this task. */
	readonly touchedFiles?: readonly string[];
	/** Most recent deterministic check suite verification receipt for this task. */
	readonly lastCheckReceipt?: IMissionTaskCheckReceipt;
	/** Most recent rework/reject/retry/failure timestamp on bound tokens (invalidates older check receipts). */
	readonly lastReworkAt?: number;
	/** Active block reason if a bound token is blocked. */
	readonly blockedReason?: string;
	/** Most recent failure reason if a bound token failed. */
	readonly lastError?: string;
}

export interface IMissionTaskStatusTransitionResult {
	readonly ok: boolean;
	readonly taskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>>;
	readonly incompleteUpstreamTaskIds?: readonly string[];
	readonly unmetRequirements?: readonly string[];
	readonly code?: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_DAG' | 'INCOMPLETE_DEPENDENCIES' | 'COMPLETION_CONTRACT_UNMET';
	readonly error?: string;
}

export interface ITaskBindingValidationResult {
	readonly ok: boolean;
	readonly code?: 'NOT_FOUND' | 'INVALID_STATE' | 'INVALID_GRAPH';
	readonly error?: string;
}

export interface IOrchestrationWhiteboard {
	readonly id: string;
	readonly title: string;
	readonly department: string;
	readonly content: string;
	readonly version: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly updatedBy?: string;
	readonly updatedByLabel?: string;
}

/**
 * Strictly lightweight reference pointer carried inside Orchestration tokens.
 * NEVER embeds `whiteboard.content`!
 */
export interface IOrchestrationWhiteboardPointer {
	readonly whiteboardId: string;
	readonly department: string;
	readonly title: string;
	readonly version: number;
}

export interface IWhiteboardAttachmentValidationResult {
	readonly ok: boolean;
	readonly normalizedIds: readonly string[];
	readonly code?: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_STATE';
	readonly error?: string;
}

export interface IMutateDepartmentWhiteboardResult {
	readonly ok: boolean;
	readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
	readonly whiteboard?: IOrchestrationWhiteboard;
	readonly code?: 'ALREADY_EXISTS' | 'VERSION_CONFLICT' | 'INVALID_STATE';
	readonly error?: string;
	readonly currentVersion?: number;
	readonly updatedByLabel?: string;
}

export type OrchestrationTokenStatus = 'active' | 'blocked' | 'waiting_join' | 'handed_off' | 'completed' | 'failed' | 'reclaimed' | 'aborted';
export type OrchestrationNodeRuntimeStatus = 'idle' | 'active' | 'blocked' | 'waiting_join';
export type OrchestrationRefKind = 'handoff' | 'whiteboard' | 'artifact' | 'decision';

export type OrchestrationReworkCategory = 'defect' | 'spec' | 'test' | 'env' | 'scope' | 'security' | 'other';
export type OrchestrationScopeConflictPolicy = 'reject' | 'warn' | 'allow';

export interface IOrchestrationReworkEntry {
	readonly attempt: number;
	readonly kind: 'reject' | 'retry' | 'check_fail';
	readonly byNodeId: string;
	readonly category?: OrchestrationReworkCategory;
	readonly summary: string;
	readonly payloadPtr?: string;
	readonly timestamp: number;
}

export interface IOrchestrationBarrierFileConflict {
	readonly path: string;
	readonly tokenIds: readonly string[];
	readonly fromNodeIds: readonly string[];
}

export interface IOrchestrationJoinBarrierChildResult {
	readonly tokenId: string;
	readonly fromNodeId: string;
	readonly outcome: 'returned' | 'completed' | 'failed' | 'rejected' | 'reclaimed' | 'aborted';
	readonly summary: string;
	readonly payloadPtr?: string;
	readonly attachedRefPtrs?: readonly string[];
	readonly taskNodeId?: string;
	readonly scopePaths?: readonly string[];
	readonly touchedFiles?: readonly string[];
	readonly settledAt: number;
}

export interface IOrchestrationJoinBarrier {
	readonly id: string;
	readonly waveId: string;
	readonly parentTokenId: string;
	readonly ownerNodeId: string;
	readonly childTokenIds: readonly string[];
	readonly mode: 'all' | 'any' | 'quorum';
	/** Optional minimum non-failed children required when `mode === 'quorum'`. */
	readonly quorumCount?: number;
	/** When true, automatically reclaim/cancel remaining active sibling branches once `any`/`quorum` satisfies. */
	readonly failFast?: boolean;
	/** Optional epoch ms deadline for barrier watchdogs. */
	readonly deadlineAt?: number;
	/** True when this barrier converged via deadline expiration (`expireOrchestrationJoinBarrier`). */
	readonly timedOut?: boolean;
	readonly timedOutAt?: number;
	/** Parallel file overlaps detected across settled sibling branches at convergence. */
	readonly fileConflicts?: readonly IOrchestrationBarrierFileConflict[];
	/** Non-blocking scope overlap advisories recorded when parallel branches were minted. */
	readonly scopeOverlapWarnings?: readonly string[];
	readonly status: 'waiting' | 'satisfied' | 'aborted';
	readonly settledChildren: Readonly<Record<string, IOrchestrationJoinBarrierChildResult>>;
	readonly createdAt: number;
	readonly satisfiedAt?: number;
}

export interface IOrchestrationMintBranch {
	readonly toNodeId: string;
	readonly summary: string;
	readonly detail?: string;
	readonly taskNodeId?: string;
	readonly taskNodeIds?: readonly string[];
	readonly scopePaths?: readonly string[];
	readonly whiteboardIds?: readonly string[];
	readonly artifacts?: readonly IOrchestrationContextBlobInput[];
	readonly decisions?: readonly IOrchestrationContextBlobInput[];
	readonly refPtrs?: readonly string[];
}

/** Max inline characters kept in a token's 1-line headline; anything longer auto-spills into an independent per-hop pointer (`hop-N`). */
export const ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS = 160;

export interface IOrchestrationContextBlobInput {
	readonly title: string;
	readonly content: string;
}

/**
 * Immutable context blob stored ONCE in `state.payloadStore[ptr]` (deduplicated by content digest).
 * Tokens NEVER embed `content` inline — they carry only lightweight `IOrchestrationContextRef` pointers.
 */
export interface IOrchestrationContextBlob {
	/** Stable pointer ID inside this Engineering workspace (`hop-N`, `art-N`, `dec-N`). */
	readonly ptr: string;
	readonly kind: Exclude<OrchestrationRefKind, 'whiteboard'>;
	readonly title: string;
	readonly content: string;
	readonly sizeChars: number;
	/** Deterministic 8-hex-char FNV-1a digest for content deduplication & change detection. */
	readonly digest: string;
	readonly authorNodeId?: string;
	readonly authorAgentId?: string;
	readonly hop: number;
	readonly waveId: string;
	readonly createdAt: number;
}

/**
 * Strictly lightweight, self-describing pointer carried in Orchestration tokens.
 * Gives the receiver exact WHAT / WHO / VERSION / SIZE metadata (~15 tokens) with ZERO body text!
 */
export interface IOrchestrationContextRef {
	/** Pointer ID: `hop-N` (per-hop handoff detail), `art-N` (artifact), `dec-N` (decision), or `wb:<whiteboardId>`. */
	readonly ptr: string;
	readonly kind: OrchestrationRefKind;
	readonly title: string;
	/** Monotonic version (1 for immutable blobs; live `whiteboard.version` for mutable department whiteboards). */
	readonly version: number;
	/** Hop index when this pointer was attached or last updated — drives O(1) delta filtering on cyclic re-entry! */
	readonly updatedAtHop: number;
	readonly authorNodeId?: string;
	readonly department?: string;
	readonly sizeChars: number;
	readonly digest?: string;
}

export interface IOrchestrationHopLedgerEntry {
	readonly hop: number;
	readonly tokenId: string;
	readonly fromNodeId?: string;
	readonly toNodeId: string;
	readonly event: 'dispatch' | 'mint' | 'handoff' | 'return' | 'reject' | 'retry' | 'join_resume' | 'complete' | 'fail' | 'reclaim' | 'abort';
	readonly headline: string;
	/** Independent per-hop payload pointer (`hop-N`) when this round carried details beyond the 1-line headline. */
	readonly payloadPtr?: string;
	/** Any split pointers (`art-N`, `dec-N`, `wb:<id>`) newly attached or bumped on this hop. */
	readonly attachedRefPtrs?: readonly string[];
	readonly timestamp: number;
}

export interface IOrchestrationNodeReadCursor {
	readonly lastSeenHop: number;
	/** Exact hop keys (`${tokenId}:${hop}`) observed by this staff node so parallel branches never suppress each other's hops! */
	readonly seenHopIds?: readonly string[];
	readonly seenRefVersions: Readonly<Record<string, number>>;
	readonly updatedAt: number;
}

export interface IOrchestrationTokenDeltaView {
	readonly tokenId: string;
	readonly nodeId: string;
	readonly waveId: string;
	readonly currentHop: number;
	readonly isReentrantVisit: boolean;
	readonly lastSeenHop?: number;
	readonly newHops: readonly IOrchestrationHopLedgerEntry[];
	readonly earlierHops: readonly IOrchestrationHopLedgerEntry[];
	readonly newOrUpdatedRefs: readonly IOrchestrationContextRef[];
	readonly unchangedRefs: readonly IOrchestrationContextRef[];
}

export interface IOrchestrationToken {
	readonly id: string;
	readonly missionId?: string;
	readonly waveId: string;
	readonly nodeId: string;
	readonly fromNodeId?: string;
	readonly holderAgentId?: string;
	readonly status: OrchestrationTokenStatus;
	readonly parentTokenId?: string;
	readonly rootTokenId?: string;
	readonly originNodeId?: string;
	readonly returnToNodeId?: string;
	readonly dispatchKind?: 'dispatch' | 'mint' | 'handoff' | 'return' | 'reject' | 'retry';
	readonly joinBarrierId?: string;
	readonly parentJoinBarrierId?: string;
	readonly childTokenIds?: readonly string[];
	readonly taskNodeId?: string;
	readonly taskNodeIds?: readonly string[];
	readonly hopIndex?: number;
	/** True serial/cyclic relay depth (does NOT increment on parent fan-in returns, preventing wide fan-outs from tripping `MAX_HOPS_EXCEEDED`). */
	readonly relayDepth?: number;
	/** Directed edge traversal counters (`"A->B": count`) along this token's lineage for cycle/ping-pong detection. */
	readonly edgeBounceCounts?: Readonly<Record<string, number>>;
	/** When this failed/rejected/reclaimed token was superseded by a retry, points to the replacement token ID. */
	readonly supersededByTokenId?: string;
	/** Per-branch repo-relative path globs governing write isolation on parallel splits. */
	readonly scopePaths?: readonly string[];
	/** Repo-relative files reported as modified on this token (`--files`). */
	readonly touchedFiles?: readonly string[];
	/** 1-based attempt counter across rework/retry chains. */
	readonly attemptNumber?: number;
	/** Structured defect/failure category when rejected or retried. */
	readonly reworkCategory?: OrchestrationReworkCategory;
	/** Bounded rework memory ledger (last 8 rejections/retries/check failures) so workers never repeat failed attempts. */
	readonly reworkHistory?: readonly IOrchestrationReworkEntry[];
	readonly lastSummary: string;
	readonly payloadPtr?: string;
	readonly hopLog?: readonly IOrchestrationHopLedgerEntry[];
	readonly contextRefs?: readonly IOrchestrationContextRef[];
	readonly compressedHistory: string;
	readonly historyState?: IMissionRollingHistoryState;
	readonly tracePtr: string;
	readonly whiteboardPointers?: readonly IOrchestrationWhiteboardPointer[];
	readonly arrivedAt: number;
	readonly lastActivityAt: number;
	readonly lastNudgeAt?: number;
	readonly nudgeCount: number;
	readonly blocked?: IMissionTokenBlockedInfo;
	readonly handedOffToNodeIds?: readonly string[];
	readonly failureReason?: string;
	readonly rejectionReason?: string;
	readonly reclaimedReason?: string;
	readonly reclaimedBy?: string;
}

export interface IOrchestrationExternalizedBlobMeta {
	readonly ptr: string;
	readonly kind: Exclude<OrchestrationRefKind, 'whiteboard'>;
	readonly title: string;
	readonly sizeChars: number;
	readonly digest: string;
	readonly authorNodeId?: string;
	readonly authorAgentId?: string;
	/** Staff node IDs authorized by lineage to read this blob even after hot tokens are archived. */
	readonly authorizedNodeIds?: readonly string[];
	readonly hop: number;
	readonly waveId: string;
	readonly createdAt: number;
}

export interface IOrchestrationFinOpsTelemetry {
	readonly totalInputTokens: number;
	readonly totalOutputTokens: number;
	readonly totalCacheReadTokens: number;
	readonly totalCacheWriteTokens: number;
	readonly cacheHitRatePct: number;
	readonly reworkTokens?: number;
	readonly updatedAt: number;
}

export const DEFAULT_ORCHESTRATION_MAX_HOPS = 64;

export interface IOrchestrationRuntimeState {
	readonly missionId: string;
	readonly status?: 'running' | 'paused' | 'aborted';
	readonly pausedAt?: number;
	readonly pausedReason?: string;
	readonly silenceReminderMinutes: number;
	readonly maxHops?: number;
	readonly budgetLimitUsd?: number;
	readonly totalCostUsd?: number;
	readonly budgetCircuitTripped?: boolean;
	readonly finOpsTelemetry?: IOrchestrationFinOpsTelemetry;
	readonly nodeStates: Readonly<Record<string, OrchestrationNodeRuntimeStatus>>;
	readonly nodeAgentIds: Readonly<Record<string, string>>;
	readonly tokens: Readonly<Record<string, IOrchestrationToken>>;
	readonly traces: Readonly<Record<string, IMissionTraceNode>>;
	readonly joinBarriers?: Readonly<Record<string, IOrchestrationJoinBarrier>>;
	readonly barrierSeq?: number;
	readonly payloadStore?: Readonly<Record<string, IOrchestrationContextBlob>>;
	readonly payloadSeq?: number;
	readonly externalizedBlobIndex?: Readonly<Record<string, IOrchestrationExternalizedBlobMeta>>;
	readonly archivedTokenCount?: number;
	readonly archivedTraceCount?: number;
	readonly nodeReadCursors?: Readonly<Record<string, IOrchestrationNodeReadCursor>>;
	readonly pendingHeadlessEffects?: readonly OrchestrationEngineEffect[];
	readonly tokenSeq: number;
	readonly waveSeq: number;
	readonly traceSeq: number;
	/** Monotonic state transition counter for concurrency/freshness detection. */
	readonly stateRevision?: number;
	readonly updatedAt: number;
}

export type OrchestrationEngineEffect =
	| {
		readonly kind: 'dispatch_token';
		readonly missionId: string;
		readonly nodeId: string;
		readonly tokenId: string;
		readonly holderAgentId?: string;
		readonly prompt: string;
	}
	| {
		readonly kind: 'silence_reminder';
		readonly missionId: string;
		readonly nodeId: string;
		readonly tokenId: string;
		readonly holderAgentId?: string;
		readonly nudgeCount: number;
		readonly message: string;
	}
	| {
		readonly kind: 'wakeup_blocked';
		readonly missionId: string;
		readonly nodeId: string;
		readonly tokenId: string;
		readonly holderAgentId?: string;
		readonly message: string;
	}
	| {
		readonly kind: 'post_inbox';
		readonly missionId: string;
		readonly nodeId: string;
		readonly tokenId: string;
		readonly title: string;
		readonly message: string;
		readonly severity: 'info' | 'critical';
		readonly senderAgentId?: string;
	};

export interface IOrchestrationTransitionResult<T = unknown> {
	readonly ok: boolean;
	readonly state: IOrchestrationRuntimeState;
	readonly effects: readonly OrchestrationEngineEffect[];
	readonly code?:
		| 'INVALID_STATE'
		| 'NOT_FOUND'
		| 'FORBIDDEN'
		| 'INVALID_GRAPH'
		| 'NO_EDGE'
		| 'AMBIGUOUS_TARGET'
		| 'UPWARD_MINT_FORBIDDEN'
		| 'UPWARD_TOKEN_FORBIDDEN'
		| 'INCOMPLETE_DEPENDENCIES'
		| 'ALLOWED_PATHS_VIOLATION'
		| 'SCOPE_CONFLICT'
		| 'COMPLETION_CONTRACT_UNMET'
		| 'DEADLINE_EXCEEDED'
		| 'PAUSED'
		| 'MAX_HOPS_EXCEEDED'
		| 'BUDGET_EXCEEDED';
	readonly error?: string;
	readonly data?: T;
}

export interface IOrchestrationWhiteboardSectionHeading {
	readonly level: number;
	readonly title: string;
	readonly slug: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly chars: number;
}

export interface IWhiteboardSliceOptions {
	readonly toc?: boolean;
	readonly summaryOnly?: boolean;
	readonly section?: string;
	readonly maxChars?: number;
	readonly offset?: number;
	readonly tailChars?: number;
}

export interface IWhiteboardSliceResult {
	readonly content: string;
	readonly truncated: boolean;
	readonly totalChars: number;
	readonly lineCount: number;
	readonly offset: number;
	readonly nextOffset?: number;
	readonly matchedSection?: string;
	readonly headings: readonly IOrchestrationWhiteboardSectionHeading[];
	readonly availableSections?: readonly string[];
	readonly isPartialSlice: boolean;
}

export interface IDereferencedOrchestrationPointer {
	readonly ptr: string;
	readonly ok: boolean;
	readonly kind?: OrchestrationRefKind | 'trace';
	readonly title?: string;
	readonly version?: number;
	readonly department?: string;
	readonly authorNodeId?: string;
	readonly hop?: number;
	readonly sizeChars?: number;
	readonly content?: string;
	readonly truncated?: boolean;
	readonly lineCount?: number;
	readonly offset?: number;
	readonly nextOffset?: number;
	readonly matchedSection?: string;
	readonly headings?: readonly IOrchestrationWhiteboardSectionHeading[];
	readonly availableSections?: readonly string[];
	readonly isPartialSlice?: boolean;
	readonly externalized?: boolean;
	readonly error?: string;
}

export interface ICreateSubordinatePlan {
	readonly ok: boolean;
	readonly error?: string;
	readonly code?: 'FORBIDDEN' | 'NOT_FOUND' | 'DUPLICATE_EMPLOYEE' | 'INVALID_RANK' | 'INVALID_GRAPH' | 'RANK_SKIP_FORBIDDEN' | 'CROSS_DEPARTMENT_FORBIDDEN';
	readonly newNodeId?: string;
	readonly resolvedRank?: IAdeRankDefinition;
	readonly department?: string;
	readonly createdDepartment?: boolean;
	readonly orchestrationText?: string;
}

export interface IRemoveSubordinatePlan {
	readonly ok: boolean;
	readonly error?: string;
	readonly code?:
		| 'FORBIDDEN'
		| 'NOT_FOUND'
		| 'INVALID_GRAPH'
		| 'RANK_SKIP_FORBIDDEN'
		| 'CROSS_DEPARTMENT_FORBIDDEN'
		| 'HAS_ACTIVE_SUBORDINATES';
	readonly removedNode?: IOrchestrationGraphNode;
	readonly activeSubordinateIds?: readonly string[];
	readonly orchestrationText?: string;
}

export type IOrchestrationArchiveEntry =
	| { readonly kind: 'token'; readonly archivedAt: number; readonly token: IOrchestrationToken }
	| { readonly kind: 'trace'; readonly archivedAt: number; readonly trace: IMissionTraceNode };

export interface IOrchestrationCompactionResult {
	readonly compactedState: IOrchestrationRuntimeState;
	readonly blobsToExternalize: readonly IOrchestrationContextBlob[];
	readonly archiveEntries: readonly IOrchestrationArchiveEntry[];
	readonly didCompact: boolean;
}

export interface IDynamicSubordinateCreateParams {
	readonly callerNodeId?: string;
	readonly callerTier?: number;
	readonly isHumanUser?: boolean;
	readonly isSecretary?: boolean;
	readonly id?: string;
	readonly name: string;
	readonly roleLabel?: string;
	readonly targetRankIdOrTier?: string | number;
	readonly department?: string;
	readonly engineId?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly hostAlias?: string;
	readonly rolePrompt?: string;
	readonly allowedPaths?: readonly string[];
	readonly checks?: readonly IMissionNodeCheckHook[];
	readonly color?: string;
	readonly bidirectional?: boolean;
	readonly edgeLabel?: string;
}

export function getHighestRankInSchema(config: IAdeOrganizationConfig): IAdeRankDefinition {
	const sorted = [...config.ranks].sort((a, b) => a.tier - b.tier);
	return sorted[0];
}

export function isHighestRankTaskCompleter(
	config: IAdeOrganizationConfig,
	caller: { readonly isHumanUser?: boolean; readonly isSecretary?: boolean; readonly callerTier?: number },
): boolean {
	if (caller.isHumanUser || caller.isSecretary) {
		return true;
	}
	const highest = getHighestRankInSchema(config);
	if (!highest || caller.callerTier === undefined) {
		return false;
	}
	return caller.callerTier <= highest.tier;
}

export function resolveEffectiveStaffTier(
	node: IOrchestrationGraphNode | undefined,
	config: IAdeOrganizationConfig,
): number | undefined {
	if (!node || node.kind !== 'staff') {
		return undefined;
	}
	if (typeof node.tier === 'number' && Number.isFinite(node.tier)) {
		return node.tier;
	}
	const tryMatchRankText = (raw: string | undefined): number | undefined => {
		const text = raw?.trim();
		if (!text) {
			return undefined;
		}
		const tierMatch = /\bL(\d+)\b/i.exec(text);
		if (tierMatch) {
			const parsed = Number.parseInt(tierMatch[1], 10);
			if (Number.isInteger(parsed) && parsed >= 0) {
				return parsed;
			}
		}
		const lower = text.toLowerCase();
		const matchedRank = config.ranks.find(
			r => r.id.toLowerCase() === lower || r.name.toLowerCase() === lower,
		);
		return matchedRank?.tier;
	};
	return tryMatchRankText(node.rankId) ?? tryMatchRankText(node.label);
}

export function computeOrchestrationContentDigest(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildCompactHeadline(rawText: string, maxChars = ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS): {
	readonly headline: string;
	readonly wasTruncated: boolean;
} {
	const normalized = rawText.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
	if (normalized.length <= maxChars) {
		return { headline: normalized, wasTruncated: false };
	}
	return {
		headline: `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`,
		wasTruncated: true,
	};
}

export function buildCursorKey(waveId: string, nodeId: string): string {
	return `${waveId}:${nodeId}`;
}

export function buildHopKey(entry: Pick<IOrchestrationHopLedgerEntry, 'tokenId' | 'hop'>): string {
	return `${entry.tokenId}:${entry.hop}`;
}

export function buildWhiteboardContextRef(
	wb: IOrchestrationWhiteboard,
	updatedAtHop: number,
): IOrchestrationContextRef {
	return {
		ptr: `wb:${wb.id}`,
		kind: 'whiteboard',
		title: wb.title,
		version: wb.version,
		updatedAtHop,
		...(wb.updatedByLabel ? { authorNodeId: wb.updatedByLabel } : {}),
		department: wb.department,
		sizeChars: wb.content.length,
		digest: computeOrchestrationContentDigest(wb.content),
	};
}

export function refreshContextRefsWithLiveWhiteboards(
	refs: readonly IOrchestrationContextRef[] | undefined,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	fallbackWhiteboardPointers: readonly IOrchestrationWhiteboardPointer[] | undefined,
	currentHop: number,
): readonly IOrchestrationContextRef[] {
	const map = new Map<string, IOrchestrationContextRef>();
	for (const ref of refs ?? []) {
		if (ref.kind === 'whiteboard') {
			const wbId = ref.ptr.startsWith('wb:') ? ref.ptr.slice(3) : ref.ptr;
			const liveWb = whiteboards?.[wbId];
			if (liveWb) {
				const versionBumped = liveWb.version > ref.version;
				map.set(ref.ptr, {
					...buildWhiteboardContextRef(liveWb, versionBumped ? currentHop : ref.updatedAtHop),
				});
			} else {
				map.set(ref.ptr, ref);
			}
		} else {
			map.set(ref.ptr, ref);
		}
	}
	for (const wp of fallbackWhiteboardPointers ?? []) {
		const ptr = `wb:${wp.whiteboardId}`;
		if (!map.has(ptr)) {
			const liveWb = whiteboards?.[wp.whiteboardId];
			map.set(ptr, liveWb
				? buildWhiteboardContextRef(liveWb, currentHop)
				: {
					ptr,
					kind: 'whiteboard',
					title: wp.title,
					version: wp.version,
					updatedAtHop: currentHop,
					department: wp.department,
					sizeChars: 0,
				});
		}
	}
	return [...map.values()];
}

export function buildOrchestrationTokenDeltaView(
	state: IOrchestrationRuntimeState,
	token: IOrchestrationToken,
	whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>,
): IOrchestrationTokenDeltaView {
	const currentHop = token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1);
	const hopLog = token.hopLog ?? [];
	const allRefs = refreshContextRefsWithLiveWhiteboards(token.contextRefs, whiteboards, token.whiteboardPointers, currentHop);
	const cursor = state.nodeReadCursors?.[buildCursorKey(token.waveId, token.nodeId)];

	if (!cursor) {
		return {
			tokenId: token.id,
			nodeId: token.nodeId,
			waveId: token.waveId,
			currentHop,
			isReentrantVisit: false,
			newHops: hopLog,
			earlierHops: [],
			newOrUpdatedRefs: allRefs,
			unchangedRefs: [],
		};
	}

	const hasSeenHopIds = Boolean(cursor.seenHopIds && cursor.seenHopIds.length > 0);
	const hasSeenHops = cursor.lastSeenHop >= 0 || hasSeenHopIds;
	const seenHopSet = hasSeenHopIds ? new Set(cursor.seenHopIds) : undefined;
	const newHops = !hasSeenHops
		? hopLog
		: (seenHopSet
			? hopLog.filter(h => !seenHopSet.has(buildHopKey(h)))
			: hopLog.filter(h => h.hop > cursor.lastSeenHop));
	const earlierHops = !hasSeenHops
		? []
		: (seenHopSet
			? hopLog.filter(h => seenHopSet.has(buildHopKey(h)))
			: hopLog.filter(h => h.hop <= cursor.lastSeenHop));
	const newOrUpdatedRefs: IOrchestrationContextRef[] = [];
	const unchangedRefs: IOrchestrationContextRef[] = [];
	for (const ref of allRefs) {
		const seenVer = cursor.seenRefVersions[ref.ptr];
		if (seenVer === undefined || ref.version > seenVer) {
			newOrUpdatedRefs.push(ref);
		} else {
			unchangedRefs.push(ref);
		}
	}

	return {
		tokenId: token.id,
		nodeId: token.nodeId,
		waveId: token.waveId,
		currentHop,
		isReentrantVisit: hasSeenHops,
		...(hasSeenHops ? { lastSeenHop: Math.max(0, cursor.lastSeenHop) } : {}),
		newHops,
		earlierHops,
		newOrUpdatedRefs,
		unchangedRefs,
	};
}

export function recordNodeCursorObservation(
	cursors: Readonly<Record<string, IOrchestrationNodeReadCursor>> | undefined,
	waveId: string,
	nodeId: string,
	observedHop: number,
	observedRefs: readonly IOrchestrationContextRef[],
	now: number,
	observedHopIds?: readonly string[] | string,
): Readonly<Record<string, IOrchestrationNodeReadCursor>> {
	const key = buildCursorKey(waveId, nodeId);
	const prev = cursors?.[key];
	const nextSeen: Record<string, number> = { ...(prev?.seenRefVersions ?? {}) };
	for (const ref of observedRefs) {
		nextSeen[ref.ptr] = Math.max(nextSeen[ref.ptr] ?? 0, ref.version);
	}
	const seenHopSet = new Set<string>(prev?.seenHopIds ?? []);
	let hopIdsList: readonly string[];
	if (typeof observedHopIds === 'string') {
		const trimmed = observedHopIds.trim();
		if (!trimmed) {
			hopIdsList = [];
		} else if (!trimmed.includes(':') && observedHop >= 0) {
			hopIdsList = [`${trimmed}:${observedHop}`];
		} else {
			hopIdsList = [trimmed];
		}
	} else {
		hopIdsList = observedHopIds ?? [];
	}
	for (const hopId of hopIdsList) {
		seenHopSet.add(hopId);
	}
	return {
		...(cursors ?? {}),
		[key]: {
			lastSeenHop: Math.max(prev?.lastSeenHop ?? -1, observedHop),
			...(seenHopSet.size > 0 ? { seenHopIds: [...seenHopSet] } : {}),
			seenRefVersions: nextSeen,
			updatedAt: now,
		},
	};
}
