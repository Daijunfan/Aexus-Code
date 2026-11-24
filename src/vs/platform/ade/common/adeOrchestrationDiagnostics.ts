/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Deterministic Mission & Orchestration Health Diagnostics (Contract C6):
 * Computes ready tasks, Task DAG critical path (topological longest-path DP), blocked tasks,
 * stalled tokens, expiring/overdue join barriers, hot bounce edges, rework hotspots, FinOps
 * budget/cache health, overall operational grade, and concise recommended next actions.
 */

import { IMissionDagParseResult } from './adeMissionDag.js';
import { IOrchestrationGraphParseResult } from './adeOrchestrationGraph.js';
import {
	DEFAULT_ORCHESTRATION_MAX_HOPS,
	IMissionTaskStatusRecord,
	IOrchestrationRuntimeState,
	ORCHESTRATION_SILENCE_REMINDER_MINUTES,
} from './adeOrchestrationTypes.js';

export type MissionDiagnosticsGrade = 'healthy' | 'degraded' | 'stalled' | 'critical';

export interface IMissionDiagnosticsCriticalPath {
	readonly nodeIds: readonly string[];
	readonly remainingNodeIds: readonly string[];
	readonly totalDurationMs: number;
	readonly remainingTasks: number;
	readonly hasCycle?: boolean;
}

export interface IMissionDiagnosticsBlockedTask {
	readonly taskId: string;
	readonly title: string;
	readonly status: string;
	readonly reason: string;
	readonly missingUpstreamIds?: readonly string[];
	readonly activeTokenIds?: readonly string[];
}

export interface IMissionDiagnosticsStalledToken {
	readonly tokenId: string;
	readonly nodeId: string;
	readonly status: 'active' | 'blocked';
	readonly silentMs: number;
	readonly nudgeCount: number;
	readonly taskNodeId?: string;
	readonly blockedReason?: string;
}

export interface IMissionDiagnosticsExpiringBarrier {
	readonly barrierId: string;
	readonly ownerNodeId: string;
	readonly parentTokenId: string;
	readonly mode: 'all' | 'any' | 'quorum';
	readonly deadlineAt: number;
	readonly remainingMs: number;
	readonly overdue: boolean;
	readonly settledCount: number;
	readonly totalChildren: number;
}

export interface IMissionDiagnosticsHotBounceEdge {
	readonly edge: string;
	readonly count: number;
	readonly tokenId: string;
	readonly relayDepth: number;
	readonly maxHops: number;
	readonly hopUsagePct: number;
}

export interface IMissionDiagnosticsReworkHotspot {
	readonly nodeId: string;
	readonly rejects: number;
	readonly retries: number;
	readonly failures: number;
	readonly totalEvents: number;
}

export interface IMissionDiagnosticsFinOpsHealth {
	readonly totalCostUsd: number;
	readonly budgetLimitUsd?: number;
	readonly budgetUsedPct?: number;
	readonly budgetCircuitTripped: boolean;
	readonly cacheHitRatePct?: number;
	readonly totalTokens?: number;
	readonly reworkTokens?: number;
}

export interface IMissionDiagnosticsReport {
	readonly missionId?: string;
	readonly generatedAt: number;
	readonly runtimeStatus: 'running' | 'paused' | 'aborted' | 'idle';
	readonly grade: MissionDiagnosticsGrade;
	readonly readyTaskIds: readonly string[];
	readonly criticalPath: IMissionDiagnosticsCriticalPath;
	readonly blockedTasks: readonly IMissionDiagnosticsBlockedTask[];
	readonly stalledTokens: readonly IMissionDiagnosticsStalledToken[];
	readonly expiringBarriers: readonly IMissionDiagnosticsExpiringBarrier[];
	readonly hotBounceEdges: readonly IMissionDiagnosticsHotBounceEdge[];
	readonly reworkHotspots: readonly IMissionDiagnosticsReworkHotspot[];
	readonly finOpsHealth: IMissionDiagnosticsFinOpsHealth;
	readonly recommendedActions: readonly string[];
}

export interface IMissionDiagnosticsInput {
	readonly missionId?: string;
	readonly taskGraph?: IMissionDagParseResult;
	readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
	readonly orchGraph?: IOrchestrationGraphParseResult;
	readonly orchState?: IOrchestrationRuntimeState;
	readonly finOpsSummary?: {
		readonly totalCostUsd?: number;
		readonly totalTokens?: number;
		readonly cacheHitRatePct?: number;
		readonly reworkTokens?: number;
	};
	readonly now?: number;
}

function computeCriticalPath(
	taskGraph: IMissionDagParseResult | undefined,
	taskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined,
): IMissionDiagnosticsCriticalPath {
	if (!taskGraph || taskGraph.error || taskGraph.nodes.length === 0) {
		return { nodeIds: [], remainingNodeIds: [], totalDurationMs: 0, remainingTasks: 0 };
	}
	const nodeIds = taskGraph.nodes.map(n => n.id);
	const nodeSet = new Set(nodeIds);
	const adj = new Map<string, string[]>();
	const inDeg = new Map<string, number>();
	for (const id of nodeIds) {
		adj.set(id, []);
		inDeg.set(id, 0);
	}
	for (const e of taskGraph.edges) {
		if (e.edgeKind === 'fail') {
			continue;
		}
		if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) {
			continue;
		}
		adj.get(e.from)!.push(e.to);
		inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
	}

	// Kahn's topological sort
	const queue: string[] = [];
	for (const id of nodeIds) {
		if ((inDeg.get(id) ?? 0) === 0) {
			queue.push(id);
		}
	}
	const topo: string[] = [];
	while (queue.length > 0) {
		const cur = queue.shift()!;
		topo.push(cur);
		for (const next of adj.get(cur) ?? []) {
			const d = (inDeg.get(next) ?? 1) - 1;
			inDeg.set(next, d);
			if (d === 0) {
				queue.push(next);
			}
		}
	}
	if (topo.length === 0) {
		return { nodeIds: [], remainingNodeIds: [], totalDurationMs: 0, remainingTasks: 0, ...(nodeIds.length > 0 ? { hasCycle: true } : {}) };
	}
	const hasCycle = topo.length < nodeIds.length;

	// Weight: prioritize remaining (non-completed) tasks via primary score = remainingCount * 1e9 + durationWeight
	const isIncomplete = (id: string): boolean => taskStatuses?.[id]?.status !== 'completed';
	const durationOf = (id: string): number => {
		const rec = taskStatuses?.[id];
		if (rec?.durationMs !== undefined && Number.isFinite(rec.durationMs) && rec.durationMs > 0) {
			return rec.durationMs;
		}
		return 1;
	};

	const bestRemaining = new Map<string, number>();
	const bestDuration = new Map<string, number>();
	const bestDepth = new Map<string, number>();
	const prev = new Map<string, string | undefined>();

	for (const id of topo) {
		const remW = isIncomplete(id) ? 1 : 0;
		const durW = durationOf(id);
		if (!bestRemaining.has(id)) {
			bestRemaining.set(id, remW);
			bestDuration.set(id, durW);
			bestDepth.set(id, 1);
			prev.set(id, undefined);
		}
		const curRem = bestRemaining.get(id)!;
		const curDur = bestDuration.get(id)!;
		const curDepth = bestDepth.get(id)!;
		for (const next of adj.get(id) ?? []) {
			const candRem = curRem + (isIncomplete(next) ? 1 : 0);
			const candDur = curDur + durationOf(next);
			const candDepth = curDepth + 1;
			const oldRem = bestRemaining.get(next) ?? -1;
			const oldDepth = bestDepth.get(next) ?? -1;
			const oldDur = bestDuration.get(next) ?? -1;
			const isBetter = candRem > oldRem
				|| (candRem === oldRem && candDepth > oldDepth)
				|| (candRem === oldRem && candDepth === oldDepth && candDur > oldDur);
			if (isBetter) {
				bestRemaining.set(next, candRem);
				bestDuration.set(next, candDur);
				bestDepth.set(next, candDepth);
				prev.set(next, id);
			}
		}
	}

	let bestEnd: string | undefined;
	for (const id of topo) {
		if (!bestEnd) {
			bestEnd = id;
			continue;
		}
		const aRem = bestRemaining.get(id) ?? 0;
		const bRem = bestRemaining.get(bestEnd) ?? 0;
		const aDepth = bestDepth.get(id) ?? 0;
		const bDepth = bestDepth.get(bestEnd) ?? 0;
		const aDur = bestDuration.get(id) ?? 0;
		const bDur = bestDuration.get(bestEnd) ?? 0;
		if (aRem > bRem || (aRem === bRem && aDepth > bDepth) || (aRem === bRem && aDepth === bDepth && aDur > bDur)) {
			bestEnd = id;
		}
	}

	const path: string[] = [];
	let cur: string | undefined = bestEnd;
	const seen = new Set<string>();
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		path.push(cur);
		cur = prev.get(cur);
	}
	path.reverse();

	const remainingNodeIds = path.filter(isIncomplete);
	const totalDurationMs = path.reduce((sum, id) => {
		const d = taskStatuses?.[id]?.durationMs;
		return sum + (typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : 0);
	}, 0);
	return {
		nodeIds: path,
		remainingNodeIds,
		totalDurationMs,
		remainingTasks: remainingNodeIds.length,
		...(hasCycle ? { hasCycle: true } : {}),
	};
}

/**
 * Computes a complete deterministic health & bottleneck diagnostic report across the Mission Task DAG,
 * Orchestration token/barrier runtime, and FinOps telemetry.
 */
export function computeMissionDiagnostics(input: IMissionDiagnosticsInput): IMissionDiagnosticsReport {
	const now = input.now ?? Date.now();
	const orchState = input.orchState;
	const taskGraph = input.taskGraph;
	const taskStatuses = input.taskStatuses ?? {};
	const tokens = Object.values(orchState?.tokens ?? {});
	const barriers = Object.values(orchState?.joinBarriers ?? {});

	// 1. Ready tasks, ready human gates & blocked tasks
	const readyTaskIds: string[] = [];
	const readyGateIds: string[] = [];
	const blockedTasks: IMissionDiagnosticsBlockedTask[] = [];
	if (taskGraph && !taskGraph.error) {
		const incomingByTask = new Map<string, string[]>();
		for (const n of taskGraph.nodes) {
			incomingByTask.set(n.id, []);
		}
		for (const e of taskGraph.edges) {
			if (e.edgeKind !== 'fail') {
				incomingByTask.get(e.to)?.push(e.from);
			}
		}
		for (const node of taskGraph.nodes) {
			const rec = taskStatuses[node.id];
			const status = rec?.status ?? 'pending';
			const upstreamIds = incomingByTask.get(node.id) ?? [];
			const missingUpstreamIds = upstreamIds.filter(uid => taskStatuses[uid]?.status !== 'completed');
			const activeIds = rec?.activeTokenIds ?? [];

			if (status === 'pending' && missingUpstreamIds.length === 0 && activeIds.length === 0) {
				if (node.kind === 'gate') {
					readyGateIds.push(node.id);
				} else {
					readyTaskIds.push(node.id);
				}
			} else if (status === 'blocked') {
				blockedTasks.push({
					taskId: node.id,
					title: node.label,
					status,
					reason: rec?.blockedReason || rec?.lastError || 'Task is blocked',
					...(missingUpstreamIds.length > 0 ? { missingUpstreamIds } : {}),
					...(activeIds.length > 0 ? { activeTokenIds: activeIds } : {}),
				});
			} else if (status !== 'completed' && rec?.lastError && activeIds.length === 0) {
				blockedTasks.push({
					taskId: node.id,
					title: node.label,
					status,
					reason: rec.lastError,
					...(missingUpstreamIds.length > 0 ? { missingUpstreamIds } : {}),
				});
			}
		}
	}

	// 2. Critical path
	const criticalPath = computeCriticalPath(taskGraph, taskStatuses);

	// 3. Stalled tokens (respect `silenceReminderMinutes === 0` off-mode and freeze silence clock while paused)
	const rawSilenceMin = orchState?.silenceReminderMinutes;
	const silenceEnabled = rawSilenceMin === undefined ? true : rawSilenceMin > 0;
	const silenceThresholdMs = silenceEnabled
		? Math.max(1, rawSilenceMin ?? ORCHESTRATION_SILENCE_REMINDER_MINUTES) * 60_000
		: Number.POSITIVE_INFINITY;
	const silenceClockNow = orchState?.status === 'paused' && orchState.pausedAt !== undefined
		? Math.min(now, orchState.pausedAt)
		: now;
	const stalledTokens: IMissionDiagnosticsStalledToken[] = [];
	for (const tok of tokens) {
		if (tok.status === 'active') {
			const silentMs = Math.max(0, silenceClockNow - (tok.lastActivityAt || tok.arrivedAt || silenceClockNow));
			if (tok.nudgeCount >= 1 || (silenceEnabled && silentMs >= silenceThresholdMs)) {
				stalledTokens.push({
					tokenId: tok.id,
					nodeId: tok.nodeId,
					status: 'active',
					silentMs,
					nudgeCount: tok.nudgeCount,
					...(tok.taskNodeId ? { taskNodeId: tok.taskNodeId } : {}),
				});
			}
		} else if (tok.status === 'blocked' && tok.blocked?.expiresAt !== undefined && orchState?.status !== 'paused' && now >= tok.blocked.expiresAt) {
			stalledTokens.push({
				tokenId: tok.id,
				nodeId: tok.nodeId,
				status: 'blocked',
				silentMs: Math.max(0, now - tok.blocked.startedAt),
				nudgeCount: tok.nudgeCount,
				...(tok.taskNodeId ? { taskNodeId: tok.taskNodeId } : {}),
				blockedReason: `Block expired: ${tok.blocked.reason}`,
			});
		}
	}
	stalledTokens.sort((a, b) => b.silentMs - a.silentMs);

	// 4. Expiring / overdue waiting join barriers
	const expiringBarriers: IMissionDiagnosticsExpiringBarrier[] = [];
	for (const b of barriers) {
		if (b.status !== 'waiting' || b.deadlineAt === undefined) {
			continue;
		}
		const remainingMs = b.deadlineAt - now;
		expiringBarriers.push({
			barrierId: b.id,
			ownerNodeId: b.ownerNodeId,
			parentTokenId: b.parentTokenId,
			mode: b.mode,
			deadlineAt: b.deadlineAt,
			remainingMs,
			overdue: remainingMs <= 0,
			settledCount: Object.keys(b.settledChildren).length,
			totalChildren: b.childTokenIds.length,
		});
	}
	expiringBarriers.sort((a, b) => a.remainingMs - b.remainingMs);

	// 5. Hot bounce edges & tokens approaching maxHops
	const effectiveMaxHops = orchState?.maxHops !== undefined && Number.isFinite(orchState.maxHops) && orchState.maxHops >= 1
		? Math.floor(orchState.maxHops)
		: DEFAULT_ORCHESTRATION_MAX_HOPS;
	const hotEdgeBest = new Map<string, IMissionDiagnosticsHotBounceEdge>();
	for (const tok of tokens) {
		const relayDepth = tok.relayDepth ?? tok.hopIndex ?? 0;
		const hopUsagePct = Math.round((relayDepth / effectiveMaxHops) * 1000) / 10;
		for (const [edge, count] of Object.entries(tok.edgeBounceCounts ?? {})) {
			if (count >= 3 || (tok.status === 'active' && hopUsagePct >= 70)) {
				const prev = hotEdgeBest.get(edge);
				if (!prev || count > prev.count || (count === prev.count && relayDepth > prev.relayDepth)) {
					hotEdgeBest.set(edge, {
						edge,
						count,
						tokenId: tok.id,
						relayDepth,
						maxHops: effectiveMaxHops,
						hopUsagePct,
					});
				}
			}
		}
	}
	const hotBounceEdges = [...hotEdgeBest.values()].sort((a, b) => b.count - a.count || b.hopUsagePct - a.hopUsagePct);

	// 6. Rework hotspots per staff node
	const reworkCounts = new Map<string, { rejects: number; retries: number; failures: number }>();
	const bumpRework = (nodeId: string, kind: 'rejects' | 'retries' | 'failures') => {
		let entry = reworkCounts.get(nodeId);
		if (!entry) {
			entry = { rejects: 0, retries: 0, failures: 0 };
			reworkCounts.set(nodeId, entry);
		}
		entry[kind] += 1;
	};
	for (const tok of tokens) {
		if (tok.dispatchKind === 'reject') {
			bumpRework(tok.nodeId, 'rejects');
		}
		if (tok.dispatchKind === 'retry') {
			bumpRework(tok.nodeId, 'retries');
		}
		if (tok.status === 'failed') {
			bumpRework(tok.nodeId, 'failures');
		}
	}
	const reworkHotspots: IMissionDiagnosticsReworkHotspot[] = [...reworkCounts.entries()]
		.map(([nodeId, c]) => ({
			nodeId,
			rejects: c.rejects,
			retries: c.retries,
			failures: c.failures,
			totalEvents: c.rejects + c.retries + c.failures,
		}))
		.filter(h => h.totalEvents > 0)
		.sort((a, b) => b.totalEvents - a.totalEvents || a.nodeId.localeCompare(b.nodeId));

	// 7. FinOps health
	const totalCostUsd = Math.max(orchState?.totalCostUsd ?? 0, input.finOpsSummary?.totalCostUsd ?? 0);
	const budgetLimitUsd = orchState?.budgetLimitUsd;
	const budgetUsedPct = budgetLimitUsd !== undefined && budgetLimitUsd > 0
		? Math.round((totalCostUsd / budgetLimitUsd) * 1000) / 10
		: undefined;
	const budgetCircuitTripped = Boolean(
		orchState?.budgetCircuitTripped
		|| (budgetLimitUsd !== undefined && budgetLimitUsd > 0 && totalCostUsd >= budgetLimitUsd),
	);
	const telem = orchState?.finOpsTelemetry;
	const totalTokensFromTelem = telem
		? telem.totalInputTokens + telem.totalOutputTokens + telem.totalCacheReadTokens + telem.totalCacheWriteTokens
		: undefined;
	const finOpsHealth: IMissionDiagnosticsFinOpsHealth = {
		totalCostUsd,
		...(budgetLimitUsd !== undefined ? { budgetLimitUsd } : {}),
		...(budgetUsedPct !== undefined ? { budgetUsedPct } : {}),
		budgetCircuitTripped,
		...(input.finOpsSummary?.cacheHitRatePct !== undefined
			? { cacheHitRatePct: input.finOpsSummary.cacheHitRatePct }
			: (telem ? { cacheHitRatePct: telem.cacheHitRatePct } : {})),
		...(input.finOpsSummary?.totalTokens !== undefined
			? { totalTokens: input.finOpsSummary.totalTokens }
			: (totalTokensFromTelem !== undefined ? { totalTokens: totalTokensFromTelem } : {})),
		...(input.finOpsSummary?.reworkTokens !== undefined
			? { reworkTokens: input.finOpsSummary.reworkTokens }
			: (telem?.reworkTokens !== undefined ? { reworkTokens: telem.reworkTokens } : {})),
	};

	// 8. Operational grade & recommended actions (capped at 5)
	const overdueBarriers = expiringBarriers.filter(b => b.overdue);
	const unresolvedFailedTokens = tokens.filter(t => t.status === 'failed' && !t.supersededByTokenId);
	const runtimeStatus: IMissionDiagnosticsReport['runtimeStatus'] = orchState?.status ?? 'idle';

	let grade: MissionDiagnosticsGrade = 'healthy';
	if (
		budgetCircuitTripped
		|| runtimeStatus === 'aborted'
		|| unresolvedFailedTokens.length > 0
		|| overdueBarriers.length > 0
		|| criticalPath.hasCycle
		|| hotBounceEdges.some(e => e.hopUsagePct >= 85)
	) {
		grade = 'critical';
	} else if (stalledTokens.length > 0 || blockedTasks.length > 0 || runtimeStatus === 'paused') {
		grade = 'stalled';
	} else if (
		hotBounceEdges.length > 0
		|| reworkHotspots.some(h => h.totalEvents >= 2)
		|| (budgetUsedPct !== undefined && budgetUsedPct >= 80)
		|| expiringBarriers.some(b => b.remainingMs <= 5 * 60_000)
	) {
		grade = 'degraded';
	}

	const actions: string[] = [];
	if (criticalPath.hasCycle) {
		actions.push('Task DAG contains a cycle; fix cyclic dependency edges so critical-path progression can complete.');
	}
	if (budgetCircuitTripped) {
		actions.push(`Budget ceiling reached ($${totalCostUsd.toFixed(4)} / $${(budgetLimitUsd ?? 0).toFixed(2)}); raise or clear budget limit and resume.`);
	}
	if (overdueBarriers.length > 0) {
		actions.push(`Expire ${overdueBarriers.length} overdue join barrier(s): ${overdueBarriers.slice(0, 3).map(b => b.barrierId).join(', ')}.`);
	}
	if (unresolvedFailedTokens.length > 0) {
		actions.push(`Retry or reassign ${unresolvedFailedTokens.length} failed token(s): ${unresolvedFailedTokens.slice(0, 3).map(t => `${t.id}@${t.nodeId}`).join(', ')}.`);
	}
	if (stalledTokens.length > 0) {
		actions.push(`Nudge or inspect ${stalledTokens.length} stalled token(s): ${stalledTokens.slice(0, 3).map(t => `${t.tokenId}@${t.nodeId}`).join(', ')}.`);
	}
	if (blockedTasks.length > 0) {
		actions.push(`Unblock ${blockedTasks.length} task(s): ${blockedTasks.slice(0, 3).map(t => t.taskId).join(', ')}.`);
	}
	if (hotBounceEdges.length > 0) {
		actions.push(`Break ping-pong loop on ${hotBounceEdges[0].edge} (${hotBounceEdges[0].count} traversals, ${hotBounceEdges[0].hopUsagePct}% of maxHops).`);
	}
	if (readyGateIds.length > 0 && actions.length < 5) {
		actions.push(`Await Human (L-1) / Secretary (L0) approval on ready gate(s): ${readyGateIds.slice(0, 4).join(', ')}.`);
	}
	if (readyTaskIds.length > 0 && actions.length < 5) {
		actions.push(`Dispatch ${readyTaskIds.length} ready task(s): ${readyTaskIds.slice(0, 4).join(', ')}.`);
	}

	return {
		...(input.missionId ?? orchState?.missionId ? { missionId: input.missionId ?? orchState?.missionId } : {}),
		generatedAt: now,
		runtimeStatus,
		grade,
		readyTaskIds,
		criticalPath,
		blockedTasks,
		stalledTokens,
		expiringBarriers,
		hotBounceEdges,
		reworkHotspots,
		finOpsHealth,
		recommendedActions: actions.slice(0, 5),
	};
}
