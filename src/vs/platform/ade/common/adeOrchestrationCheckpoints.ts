/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Orchestration Runtime Checkpointing & Time-Travel Restore (Contract C6):
 * - Captures lightweight, serializable snapshots of Orchestration runtime state + optional Mission
 *   Task statuses & department whiteboards (referencing `payloadStore` pointers without duplicating cold blobs).
 * - Computes deterministic diffs between two checkpoints or a checkpoint and live runtime state.
 * - Restores snapshots safely while preserving:
 *   1. Strictly monotonic sequence counters (`tokenSeq`, `traceSeq`, `barrierSeq`, `payloadSeq`, `waveSeq`)
 *      so resumed runs NEVER collide on IDs.
 *   2. Strictly monotonic FinOps spend (`totalCostUsd`, `finOpsTelemetry`) so cost accounting can never
 *      be wound backward.
 *   3. Intact `payloadStore` + `externalizedBlobIndex` union so existing pointer references remain readable.
 *   4. Monotonic `stateRevision + 1` and an explicit `checkpoint_restore` audit trace entry.
 */

import { IMissionTraceNode } from './adeMissionEngine.js';
import {
	buildCompactHeadline,
	IMissionTaskStatusRecord,
	IOrchestrationContextBlob,
	IOrchestrationExternalizedBlobMeta,
	IOrchestrationFinOpsTelemetry,
	IOrchestrationJoinBarrier,
	IOrchestrationNodeReadCursor,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationWhiteboard,
	MissionTaskStatus,
	OrchestrationNodeRuntimeStatus,
	OrchestrationTokenStatus,
} from './adeOrchestrationTypes.js';

export const MAX_HOT_ORCHESTRATION_CHECKPOINTS = 20;

export interface IOrchestrationCheckpointSnapshot {
	readonly id: string;
	readonly missionId: string;
	readonly label?: string;
	readonly reason?: string;
	readonly createdAt: number;
	readonly createdBy?: string;
	readonly stateRevision: number;
	readonly runtimeStatus: 'running' | 'paused' | 'aborted';
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
	readonly joinBarriers: Readonly<Record<string, IOrchestrationJoinBarrier>>;
	readonly nodeReadCursors?: Readonly<Record<string, IOrchestrationNodeReadCursor>>;
	readonly tokenSeq: number;
	readonly waveSeq: number;
	readonly traceSeq: number;
	readonly barrierSeq: number;
	readonly payloadSeq: number;
	readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
	readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
}

export interface IOrchestrationCheckpointSummary {
	readonly id: string;
	readonly label?: string;
	readonly reason?: string;
	readonly createdAt: number;
	readonly createdBy?: string;
	readonly stateRevision: number;
	readonly runtimeStatus: 'running' | 'paused' | 'aborted';
	readonly totalTokens: number;
	readonly activeTokens: number;
	readonly waitingBarriers: number;
	readonly completedTasks?: number;
	readonly totalTasks?: number;
}

export interface IOrchestrationCheckpointDiff {
	readonly fromId: string;
	readonly toId: string;
	readonly addedTokenIds: readonly string[];
	readonly removedTokenIds: readonly string[];
	readonly statusChangedTokens: readonly {
		readonly tokenId: string;
		readonly nodeId: string;
		readonly fromStatus: OrchestrationTokenStatus;
		readonly toStatus: OrchestrationTokenStatus;
	}[];
	readonly barrierChanges: readonly {
		readonly barrierId: string;
		readonly fromStatus?: IOrchestrationJoinBarrier['status'];
		readonly toStatus?: IOrchestrationJoinBarrier['status'];
		readonly fromSettledCount: number;
		readonly toSettledCount: number;
	}[];
	readonly taskStatusChanges: readonly {
		readonly taskId: string;
		readonly fromStatus?: MissionTaskStatus;
		readonly toStatus?: MissionTaskStatus;
	}[];
	readonly whiteboardVersionChanges: readonly {
		readonly whiteboardId: string;
		readonly fromVersion?: number;
		readonly toVersion?: number;
	}[];
}

export interface IOrchestrationCheckpointRestoreResult {
	readonly ok: boolean;
	readonly state: IOrchestrationRuntimeState;
	readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
	readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
	readonly diff: IOrchestrationCheckpointDiff;
	readonly tracePtr: string;
	readonly restoredMode: 'full' | 'tokens_only';
	readonly error?: string;
}

let autoCheckpointIdSeq = 0;

function deepCloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export function summarizeOrchestrationCheckpoint(checkpoint: IOrchestrationCheckpointSnapshot): IOrchestrationCheckpointSummary {
	const tokens = Object.values(checkpoint.tokens);
	const activeTokens = tokens.filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join').length;
	const waitingBarriers = Object.values(checkpoint.joinBarriers).filter(b => b.status === 'waiting').length;
	const taskEntries = checkpoint.taskStatuses ? Object.values(checkpoint.taskStatuses) : undefined;
	return {
		id: checkpoint.id,
		...(checkpoint.label ? { label: checkpoint.label } : {}),
		...(checkpoint.reason ? { reason: checkpoint.reason } : {}),
		createdAt: checkpoint.createdAt,
		...(checkpoint.createdBy ? { createdBy: checkpoint.createdBy } : {}),
		stateRevision: checkpoint.stateRevision,
		runtimeStatus: checkpoint.runtimeStatus,
		totalTokens: tokens.length,
		activeTokens,
		waitingBarriers,
		...(taskEntries
			? {
				completedTasks: taskEntries.filter(t => t.status === 'completed').length,
				totalTasks: taskEntries.length,
			}
			: {}),
	};
}

/**
 * Captures a lightweight, JSON-clean checkpoint snapshot of the current Orchestration runtime state
 * (and optional Mission Task statuses & whiteboards) without duplicating `payloadStore` blobs.
 */
export function createOrchestrationCheckpointSnapshot(
	orchState: IOrchestrationRuntimeState,
	params?: {
		readonly id?: string;
		readonly label?: string;
		readonly reason?: string;
		readonly createdBy?: string;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
		readonly now?: number;
	},
): IOrchestrationCheckpointSnapshot {
	const now = params?.now ?? Date.now();
	const rev = orchState.stateRevision ?? 0;
	autoCheckpointIdSeq += 1;
	const id = params?.id?.trim() || `ckpt-r${rev}-${now}-${autoCheckpointIdSeq}`;
	return {
		id,
		missionId: orchState.missionId,
		...(params?.label?.trim() ? { label: params.label.trim().slice(0, 120) } : {}),
		...(params?.reason?.trim() ? { reason: params.reason.trim().slice(0, 240) } : {}),
		createdAt: now,
		...(params?.createdBy?.trim() ? { createdBy: params.createdBy.trim() } : {}),
		stateRevision: rev,
		runtimeStatus: orchState.status ?? 'running',
		...(orchState.pausedAt !== undefined ? { pausedAt: orchState.pausedAt } : {}),
		...(orchState.pausedReason ? { pausedReason: orchState.pausedReason } : {}),
		silenceReminderMinutes: orchState.silenceReminderMinutes,
		...(orchState.maxHops !== undefined ? { maxHops: orchState.maxHops } : {}),
		...(orchState.budgetLimitUsd !== undefined ? { budgetLimitUsd: orchState.budgetLimitUsd } : {}),
		...(orchState.totalCostUsd !== undefined ? { totalCostUsd: orchState.totalCostUsd } : {}),
		...(orchState.budgetCircuitTripped ? { budgetCircuitTripped: true } : {}),
		...(orchState.finOpsTelemetry ? { finOpsTelemetry: { ...orchState.finOpsTelemetry } } : {}),
		nodeStates: { ...orchState.nodeStates },
		nodeAgentIds: { ...orchState.nodeAgentIds },
		tokens: deepCloneJson(orchState.tokens),
		joinBarriers: deepCloneJson(orchState.joinBarriers ?? {}),
		...(orchState.nodeReadCursors ? { nodeReadCursors: deepCloneJson(orchState.nodeReadCursors) } : {}),
		tokenSeq: orchState.tokenSeq,
		waveSeq: orchState.waveSeq,
		traceSeq: orchState.traceSeq,
		barrierSeq: orchState.barrierSeq ?? 0,
		payloadSeq: orchState.payloadSeq ?? 0,
		...(params?.taskStatuses ? { taskStatuses: deepCloneJson(params.taskStatuses) } : {}),
		...(params?.whiteboards ? { whiteboards: deepCloneJson(params.whiteboards) } : {}),
	};
}

/**
 * Enforces the bounded ring buffer (`MAX_HOT_ORCHESTRATION_CHECKPOINTS`) sorted oldest-to-newest.
 */
export function pruneOrchestrationCheckpoints(
	checkpoints: readonly IOrchestrationCheckpointSnapshot[],
	maxCount = MAX_HOT_ORCHESTRATION_CHECKPOINTS,
): readonly IOrchestrationCheckpointSnapshot[] {
	const limit = Math.max(1, Math.floor(maxCount));
	if (checkpoints.length <= limit) {
		return [...checkpoints];
	}
	return [...checkpoints]
		.sort((a, b) => a.createdAt - b.createdAt || a.stateRevision - b.stateRevision)
		.slice(-limit);
}

function isLiveCheckpointTarget(
	target: IOrchestrationCheckpointSnapshot | {
		readonly id?: string;
		readonly orchState: IOrchestrationRuntimeState;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
	},
): target is {
	readonly id?: string;
	readonly orchState: IOrchestrationRuntimeState;
	readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
	readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
} {
	return Boolean((target as { readonly orchState?: IOrchestrationRuntimeState }).orchState);
}

/**
 * Computes a deterministic structural diff between a checkpoint snapshot and either a target
 * checkpoint snapshot or live Orchestration state + optional live task statuses / whiteboards.
 */
export function computeOrchestrationCheckpointDiff(
	fromSnapshot: IOrchestrationCheckpointSnapshot,
	toTarget: IOrchestrationCheckpointSnapshot | {
		readonly id?: string;
		readonly orchState: IOrchestrationRuntimeState;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
	},
): IOrchestrationCheckpointDiff {
	const isLive = isLiveCheckpointTarget(toTarget);
	const toId = isLive ? (toTarget.id ?? 'live') : toTarget.id;
	const toTokens: Readonly<Record<string, IOrchestrationToken>> = isLive ? toTarget.orchState.tokens : toTarget.tokens;
	const toBarriers: Readonly<Record<string, IOrchestrationJoinBarrier>> = isLive
		? (toTarget.orchState.joinBarriers ?? {})
		: toTarget.joinBarriers;
	const toTaskStatuses = toTarget.taskStatuses;
	const toWhiteboards = toTarget.whiteboards;

	const addedTokenIds: string[] = [];
	const removedTokenIds: string[] = [];
	const statusChangedTokens: {
		readonly tokenId: string;
		readonly nodeId: string;
		readonly fromStatus: OrchestrationTokenStatus;
		readonly toStatus: OrchestrationTokenStatus;
	}[] = [];

	const allTokenIds = [...new Set([...Object.keys(fromSnapshot.tokens), ...Object.keys(toTokens)])].sort();
	for (const tid of allTokenIds) {
		const a = fromSnapshot.tokens[tid];
		const b = toTokens[tid];
		if (!a && b) {
			addedTokenIds.push(tid);
		} else if (a && !b) {
			removedTokenIds.push(tid);
		} else if (a && b && a.status !== b.status) {
			statusChangedTokens.push({
				tokenId: tid,
				nodeId: b.nodeId,
				fromStatus: a.status,
				toStatus: b.status,
			});
		}
	}

	const barrierChanges: {
		readonly barrierId: string;
		readonly fromStatus?: IOrchestrationJoinBarrier['status'];
		readonly toStatus?: IOrchestrationJoinBarrier['status'];
		readonly fromSettledCount: number;
		readonly toSettledCount: number;
	}[] = [];
	const allBarrierIds = [...new Set([...Object.keys(fromSnapshot.joinBarriers), ...Object.keys(toBarriers)])].sort();
	for (const bid of allBarrierIds) {
		const a = fromSnapshot.joinBarriers[bid];
		const b = toBarriers[bid];
		const aSettled = a ? Object.keys(a.settledChildren).length : 0;
		const bSettled = b ? Object.keys(b.settledChildren).length : 0;
		if (a?.status !== b?.status || aSettled !== bSettled) {
			barrierChanges.push({
				barrierId: bid,
				...(a ? { fromStatus: a.status } : {}),
				...(b ? { toStatus: b.status } : {}),
				fromSettledCount: aSettled,
				toSettledCount: bSettled,
			});
		}
	}

	const taskStatusChanges: {
		readonly taskId: string;
		readonly fromStatus?: MissionTaskStatus;
		readonly toStatus?: MissionTaskStatus;
	}[] = [];
	if (fromSnapshot.taskStatuses || toTaskStatuses) {
		const allTaskIds = [...new Set([
			...Object.keys(fromSnapshot.taskStatuses ?? {}),
			...Object.keys(toTaskStatuses ?? {}),
		])].sort();
		for (const tid of allTaskIds) {
			const a = fromSnapshot.taskStatuses?.[tid]?.status;
			const b = toTaskStatuses?.[tid]?.status;
			if (a !== b) {
				taskStatusChanges.push({
					taskId: tid,
					...(a ? { fromStatus: a } : {}),
					...(b ? { toStatus: b } : {}),
				});
			}
		}
	}

	const whiteboardVersionChanges: {
		readonly whiteboardId: string;
		readonly fromVersion?: number;
		readonly toVersion?: number;
	}[] = [];
	if (fromSnapshot.whiteboards || toWhiteboards) {
		const allWbIds = [...new Set([
			...Object.keys(fromSnapshot.whiteboards ?? {}),
			...Object.keys(toWhiteboards ?? {}),
		])].sort();
		for (const wbId of allWbIds) {
			const a = fromSnapshot.whiteboards?.[wbId]?.version;
			const b = toWhiteboards?.[wbId]?.version;
			if (a !== b) {
				whiteboardVersionChanges.push({
					whiteboardId: wbId,
					...(a !== undefined ? { fromVersion: a } : {}),
					...(b !== undefined ? { toVersion: b } : {}),
				});
			}
		}
	}

	return {
		fromId: fromSnapshot.id,
		toId,
		addedTokenIds,
		removedTokenIds,
		statusChangedTokens,
		barrierChanges,
		taskStatusChanges,
		whiteboardVersionChanges,
	};
}

function mergeMonotonicFinOpsTelemetry(
	current: IOrchestrationFinOpsTelemetry | undefined,
	checkpoint: IOrchestrationFinOpsTelemetry | undefined,
	now: number,
): IOrchestrationFinOpsTelemetry | undefined {
	if (!current && !checkpoint) {
		return undefined;
	}
	const totalInputTokens = Math.max(current?.totalInputTokens ?? 0, checkpoint?.totalInputTokens ?? 0);
	const totalOutputTokens = Math.max(current?.totalOutputTokens ?? 0, checkpoint?.totalOutputTokens ?? 0);
	const totalCacheReadTokens = Math.max(current?.totalCacheReadTokens ?? 0, checkpoint?.totalCacheReadTokens ?? 0);
	const totalCacheWriteTokens = Math.max(current?.totalCacheWriteTokens ?? 0, checkpoint?.totalCacheWriteTokens ?? 0);
	const reworkTokens = Math.max(current?.reworkTokens ?? 0, checkpoint?.reworkTokens ?? 0);
	const cacheDenom = totalInputTokens + totalCacheReadTokens;
	const cacheHitRatePct = cacheDenom > 0 ? Math.round((totalCacheReadTokens / cacheDenom) * 1000) / 10 : 0;
	return {
		totalInputTokens,
		totalOutputTokens,
		totalCacheReadTokens,
		totalCacheWriteTokens,
		cacheHitRatePct,
		...(reworkTokens > 0 ? { reworkTokens } : {}),
		updatedAt: now,
	};
}

/**
 * Applies a time-travel restore from `checkpoint` onto `currentState` while guaranteeing:
 * - Strictly monotonic ID sequences (`tokenSeq`, `traceSeq`, `barrierSeq`, `payloadSeq`, `waveSeq`)
 * - Strictly monotonic FinOps spend (`totalCostUsd`, `finOpsTelemetry`)
 * - Preserved `payloadStore` + `externalizedBlobIndex` so no existing pointers ever dangle
 * - Monotonic `stateRevision + 1` and a `checkpoint_restore` audit trace entry
 */
export function applyOrchestrationCheckpointRestore(
	currentState: IOrchestrationRuntimeState,
	checkpoint: IOrchestrationCheckpointSnapshot,
	options?: {
		readonly mode?: 'full' | 'tokens_only';
		readonly currentTaskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly currentWhiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
		readonly restoredBy?: string;
		readonly now?: number;
	},
): IOrchestrationCheckpointRestoreResult {
	const now = options?.now ?? Date.now();
	const mode = options?.mode ?? 'full';
	const diff = computeOrchestrationCheckpointDiff(checkpoint, {
		id: 'pre-restore-live',
		orchState: currentState,
		taskStatuses: options?.currentTaskStatuses,
		whiteboards: options?.currentWhiteboards,
	});
	if (checkpoint.missionId !== currentState.missionId) {
		return {
			ok: false,
			state: currentState,
			...(options?.currentTaskStatuses ? { taskStatuses: options.currentTaskStatuses } : {}),
			...(options?.currentWhiteboards ? { whiteboards: options.currentWhiteboards } : {}),
			diff,
			tracePtr: '',
			restoredMode: mode,
			error: `CHECKPOINT_MISSION_MISMATCH: checkpoint "${checkpoint.id}" belongs to mission "${checkpoint.missionId}", not "${currentState.missionId}".`,
		};
	}

	const nextTokenSeq = Math.max(currentState.tokenSeq, checkpoint.tokenSeq);
	const nextWaveSeq = Math.max(currentState.waveSeq, checkpoint.waveSeq);
	const nextBarrierSeq = Math.max(currentState.barrierSeq ?? 0, checkpoint.barrierSeq);
	const nextPayloadSeq = Math.max(currentState.payloadSeq ?? 0, checkpoint.payloadSeq);
	const nextTraceSeq = Math.max(currentState.traceSeq, checkpoint.traceSeq) + 1;
	const restoreTracePtr = `otrc-${nextTraceSeq}`;

	const monotonicCostUsd = Math.max(currentState.totalCostUsd ?? 0, checkpoint.totalCostUsd ?? 0);
	const effectiveBudgetLimit = currentState.budgetLimitUsd ?? checkpoint.budgetLimitUsd;
	const budgetTripped = Boolean(
		currentState.budgetCircuitTripped
		|| (effectiveBudgetLimit !== undefined && monotonicCostUsd >= effectiveBudgetLimit),
	);
	const mergedFinOps = mergeMonotonicFinOpsTelemetry(currentState.finOpsTelemetry, checkpoint.finOpsTelemetry, now);

	const restoredTokens = deepCloneJson(checkpoint.tokens);
	const restoredBarriers = deepCloneJson(checkpoint.joinBarriers);
	// Initialize surviving post-checkpoint staff nodes to 'idle' so nodeStates stays symmetric with mergedNodeAgentIds
	const restoredNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = {};
	for (const nodeId of Object.keys(currentState.nodeStates)) {
		restoredNodeStates[nodeId] = 'idle';
	}
	for (const [nodeId, status] of Object.entries(checkpoint.nodeStates)) {
		restoredNodeStates[nodeId] = status;
	}
	// Keep live agent session bindings for surviving nodes so restored active tokens dispatch to live agents
	const mergedNodeAgentIds: Record<string, string> = {
		...checkpoint.nodeAgentIds,
		...currentState.nodeAgentIds,
	};

	const summaryHeadline = buildCompactHeadline(
		`Checkpoint restore (${mode}) to "${checkpoint.id}"${checkpoint.label ? ` (${checkpoint.label})` : ''}${options?.restoredBy ? ` by ${options.restoredBy}` : ''}`,
	).headline;
	const restoreTrace: IMissionTraceNode = {
		ptr: restoreTracePtr,
		parentPtrs: [],
		nodeId: options?.restoredBy?.trim() || 'system',
		waveId: `wave-${nextWaveSeq}`,
		event: 'checkpoint_restore',
		summary: summaryHeadline,
		timestamp: now,
	};
	const nextTraces: Record<string, IMissionTraceNode> = {
		...currentState.traces,
		[restoreTracePtr]: restoreTrace,
	};

	const preservedPayloadStore: Readonly<Record<string, IOrchestrationContextBlob>> | undefined = currentState.payloadStore;
	const preservedExtIndex: Readonly<Record<string, IOrchestrationExternalizedBlobMeta>> | undefined = currentState.externalizedBlobIndex;

	const nextStatus: 'running' | 'paused' | 'aborted' = budgetTripped
		? 'paused'
		: checkpoint.runtimeStatus;
	const budgetLimitLabel = effectiveBudgetLimit !== undefined ? `$${effectiveBudgetLimit.toFixed(2)}` : 'configured limit';
	const nextPausedReason = budgetTripped
		? (currentState.pausedReason || `BUDGET_EXCEEDED: Orchestration paused after spending $${monotonicCostUsd.toFixed(4)} against ${budgetLimitLabel} budget ceiling.`)
		: (nextStatus === 'paused' ? checkpoint.pausedReason : undefined);

	const restoredState: IOrchestrationRuntimeState = {
		...currentState,
		status: nextStatus,
		...(nextStatus === 'paused' ? { pausedAt: checkpoint.pausedAt ?? now } : { pausedAt: undefined }),
		...(nextPausedReason ? { pausedReason: nextPausedReason } : { pausedReason: undefined }),
		silenceReminderMinutes: checkpoint.silenceReminderMinutes || currentState.silenceReminderMinutes,
		...(checkpoint.maxHops !== undefined ? { maxHops: checkpoint.maxHops } : { maxHops: currentState.maxHops }),
		...(effectiveBudgetLimit !== undefined ? { budgetLimitUsd: effectiveBudgetLimit } : { budgetLimitUsd: undefined }),
		...(monotonicCostUsd > 0 || currentState.totalCostUsd !== undefined || checkpoint.totalCostUsd !== undefined
			? { totalCostUsd: monotonicCostUsd }
			: {}),
		budgetCircuitTripped: budgetTripped ? true : undefined,
		...(mergedFinOps ? { finOpsTelemetry: mergedFinOps } : {}),
		nodeStates: restoredNodeStates,
		nodeAgentIds: mergedNodeAgentIds,
		tokens: restoredTokens,
		traces: nextTraces,
		joinBarriers: restoredBarriers,
		barrierSeq: nextBarrierSeq,
		...(preservedPayloadStore ? { payloadStore: preservedPayloadStore } : {}),
		payloadSeq: nextPayloadSeq,
		...(preservedExtIndex ? { externalizedBlobIndex: preservedExtIndex } : {}),
		nodeReadCursors: checkpoint.nodeReadCursors ? deepCloneJson(checkpoint.nodeReadCursors) : {},
		pendingHeadlessEffects: undefined,
		tokenSeq: nextTokenSeq,
		waveSeq: nextWaveSeq,
		traceSeq: nextTraceSeq,
		stateRevision: Math.max(currentState.stateRevision ?? 0, checkpoint.stateRevision) + 1,
		updatedAt: now,
	};

	const restoredTaskStatuses = mode === 'full' && checkpoint.taskStatuses
		? deepCloneJson(checkpoint.taskStatuses)
		: options?.currentTaskStatuses;
	const restoredWhiteboards = mode === 'full' && checkpoint.whiteboards
		? deepCloneJson(checkpoint.whiteboards)
		: options?.currentWhiteboards;

	return {
		ok: true,
		state: restoredState,
		...(restoredTaskStatuses ? { taskStatuses: restoredTaskStatuses } : {}),
		...(restoredWhiteboards ? { whiteboards: restoredWhiteboards } : {}),
		diff,
		tracePtr: restoreTracePtr,
		restoredMode: mode,
	};
}
