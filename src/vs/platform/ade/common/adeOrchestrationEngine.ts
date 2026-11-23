/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure Engineering Dual-View Runtime Engine:
 * 1. Mission View (Task DAG): strictly acyclic task status tracking where ONLY the
 *    highest-rank role in the active organization schema (or Human User) may mark
 *    qualifying task nodes as "completed".
 * 2. Orchestration View (All-Staff Cyclic Collaboration):
 *    - Zero off-graph wall: ALL staff tiers enter the same canvas.
 *    - Strict employee uniqueness: 1 node === 1 employee; employees are NEVER destroyed
 *      after handing off a token and are seamlessly re-woken on future token arrivals (cycles!).
 *    - Token relay-baton handoff (`handoff` / `complete` / `dispatchToTopRank`) supporting
 *      1-to-N fan-out, bidirectional collaboration, and cyclic re-entry.
 *    - 5-minute repeating silence reminder: every 5 minutes while holding an active token,
 *      the watchdog sends an automatic nudge without freezing/destroying the employee.
 *    - Department Shared Whiteboards with STRICT lightweight pointer-only token passing
 *      (tokens carry ONLY `{ whiteboardId, department, title, version }`, NEVER full text).
 *    - Runtime dynamic subordinate creation (elastic corporate hierarchy expansion).
 */

import { buildTokenSystemEnvelopeLines } from './adeMessageEnvelope.js';
import { IMissionDagNode, IMissionDagParseResult, IMissionNodeCheckHook } from './adeMissionDag.js';
import {
	compressTokenHistoryState,
	IMissionRollingHistoryState,
	IMissionTokenBlockedInfo,
	IMissionTraceNode,
} from './adeMissionEngine.js';
import {
	addStaffNodeToOrchestration,
	addWhiteboardNodeToOrchestration,
	connectOrchestrationEdge,
	IOrchestrationGraphNode,
	IOrchestrationGraphParseResult,
	parseOrchestrationGraph,
	serializeOrchestrationGraph,
} from './adeOrchestrationGraph.js';
import { IAdeOrganizationConfig, IAdeRankDefinition } from './adeRoleSchema.js';

export const ORCHESTRATION_SILENCE_REMINDER_MINUTES = 5;

const COMPANY_WIDE_EXEC_DEPT_RE = /^(?:executive|hq|headquarters|leadership|company|general|all|root)$/i;

function isCompanyWideExecutiveDept(dept: string | undefined): boolean {
	const clean = dept?.trim();
	return !clean || COMPANY_WIDE_EXEC_DEPT_RE.test(clean);
}

// ============================================================================
// 1. Mission Task DAG Status Model, Per-Node Authority & Live Orchestration Sync
// ============================================================================

export type MissionTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

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
	/** Active block reason if a bound token is blocked. */
	readonly blockedReason?: string;
	/** Most recent failure reason if a bound token failed. */
	readonly lastError?: string;
}

export function getHighestRankInSchema(config: IAdeOrganizationConfig): IAdeRankDefinition {
	const sorted = [...config.ranks].sort((a, b) => a.tier - b.tier);
	return sorted[0];
}

/**
 * Checks whether the caller holds the highest rank in the active organization schema
 * (dynamically resolved from `config.ranks`, normally L1) or is the Human User (L-1).
 */
export function isHighestRankTaskCompleter(
	config: IAdeOrganizationConfig,
	caller: { readonly isHumanUser?: boolean; readonly callerTier?: number },
): boolean {
	if (caller.isHumanUser) {
		return true;
	}
	const highest = getHighestRankInSchema(config);
	if (!highest || caller.callerTier === undefined) {
		return false;
	}
	return caller.callerTier === highest.tier;
}

/**
 * Evaluates fine-grained per-node Mission Task DAG completion authority:
 * 1. Human User (L-1) or highest-rank role (normally L1) is ALWAYS permitted.
 * 2. Explicit per-node allowlist (`allowedCompleterNodeIds`) or `ownerNodeId` matches `callerNodeId`.
 * 3. Explicit per-node `minCompleterTier` allows any rank with `callerTier <= minCompleterTier`
 *    (scoped to `taskNode.department` when both task & caller specify non-executive departments).
 * 4. Direct Orchestration superior of the task's `assigneeNodeId` (when `orchGraph` is supplied,
 *    caller can have subordinates, edge `callerNodeId -> assigneeNodeId` exists, strictly higher rank,
 *    and same department when departmentalized).
 */
export function canCallerCompleteMissionTask(
	config: IAdeOrganizationConfig,
	taskNode: IMissionDagNode,
	caller: {
		readonly isHumanUser?: boolean;
		readonly callerTier?: number;
		readonly callerNodeId?: string;
	},
	orchGraph?: IOrchestrationGraphParseResult,
	currentRecord?: IMissionTaskStatusRecord,
): boolean {
	if (isHighestRankTaskCompleter(config, caller)) {
		return true;
	}
	const callerNodeId = caller.callerNodeId?.trim();
	const callerNode = callerNodeId && orchGraph
		? orchGraph.nodes.find(n => n.id === callerNodeId && n.kind === 'staff')
		: undefined;
	const effectiveTier = caller.callerTier ?? callerNode?.tier;

	if (callerNodeId && taskNode.allowedCompleterNodeIds?.includes(callerNodeId)) {
		return true;
	}
	if (callerNodeId && taskNode.ownerNodeId && taskNode.ownerNodeId === callerNodeId) {
		return true;
	}
	if (taskNode.minCompleterTier !== undefined && effectiveTier !== undefined && effectiveTier <= taskNode.minCompleterTier) {
		if (
			taskNode.department
			&& callerNode?.department
			&& !isCompanyWideExecutiveDept(callerNode.department)
			&& taskNode.department.trim().toLowerCase() !== callerNode.department.trim().toLowerCase()
		) {
			return false;
		}
		return true;
	}
	const effectiveAssigneeId = currentRecord?.assigneeNodeId ?? taskNode.assigneeNodeId;
	if (callerNodeId && effectiveAssigneeId && orchGraph && effectiveTier !== undefined) {
		const callerRank = config.ranks.find(r => r.tier === effectiveTier);
		if (callerRank && !callerRank.pureExecution && callerRank.canHaveSubordinates) {
			const assigneeNode = orchGraph.nodes.find(n => n.id === effectiveAssigneeId && n.kind === 'staff');
			const strictlyHigher = assigneeNode?.tier !== undefined ? effectiveTier < assigneeNode.tier : true;
			const deptOk = !callerNode?.department
				|| isCompanyWideExecutiveDept(callerNode.department)
				|| !assigneeNode?.department
				|| callerNode.department.trim().toLowerCase() === assigneeNode.department.trim().toLowerCase();
			if (assigneeNode && strictlyHigher && deptOk) {
				// Allow BOTH direct 1-hop superiors AND transitive multi-hop downward supervisors (e.g. L2 -> L3 -> L4 in same department).
				const visited = new Set<string>([callerNodeId]);
				const queue: string[] = [callerNodeId];
				while (queue.length > 0) {
					const cur = queue.shift()!;
					const curNode = orchGraph.nodes.find(n => n.id === cur && n.kind === 'staff');
					const curTier = curNode ? resolveEffectiveStaffTier(curNode, config) : undefined;
					for (const e of orchGraph.edges) {
						if (e.from !== cur || visited.has(e.to)) {
							continue;
						}
						const nxt = orchGraph.nodes.find(n => n.id === e.to && n.kind === 'staff');
						if (!nxt) {
							continue;
						}
						const nxtTier = resolveEffectiveStaffTier(nxt, config);
						if (curTier !== undefined && nxtTier !== undefined && nxtTier <= curTier) {
							continue;
						}
						if (
							callerNode?.department
							&& !isCompanyWideExecutiveDept(callerNode.department)
							&& nxt.department
							&& nxt.department.trim().toLowerCase() !== callerNode.department.trim().toLowerCase()
						) {
							continue;
						}
						if (nxt.id === effectiveAssigneeId) {
							return true;
						}
						visited.add(nxt.id);
						queue.push(nxt.id);
					}
				}
			}
		}
	}
	return false;
}

export interface IMissionTaskStatusTransitionResult {
	readonly ok: boolean;
	readonly taskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>>;
	readonly incompleteUpstreamTaskIds?: readonly string[];
	readonly code?: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_DAG' | 'INCOMPLETE_DEPENDENCIES';
	readonly error?: string;
}

export function updateMissionTaskNodeStatus(
	currentStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined,
	taskGraph: IMissionDagParseResult,
	config: IAdeOrganizationConfig,
	params: {
		readonly nodeId: string;
		readonly status: MissionTaskStatus;
		readonly caller: {
			readonly isHumanUser?: boolean;
			readonly callerTier?: number;
			readonly callerSessionId?: string;
			readonly callerLabel?: string;
			readonly callerNodeId?: string;
		};
		readonly orchGraph?: IOrchestrationGraphParseResult;
		readonly force?: boolean;
		readonly note?: string;
		readonly now?: number;
	},
): IMissionTaskStatusTransitionResult {
	const existing = currentStatuses ?? {};
	if (taskGraph.error) {
		return { ok: false, taskStatuses: existing, code: 'INVALID_DAG', error: taskGraph.error };
	}
	const nodeId = params.nodeId.trim();
	const targetNode = taskGraph.nodes.find(n => n.id === nodeId);
	if (!targetNode) {
		return { ok: false, taskStatuses: existing, code: 'NOT_FOUND', error: `Task node "${nodeId}" not found in Mission Task DAG.` };
	}

	const prevRecord = existing[nodeId];

	if (params.status === 'completed' && !canCallerCompleteMissionTask(config, targetNode, params.caller, params.orchGraph, prevRecord)) {
		const highest = getHighestRankInSchema(config);
		const permHint = targetNode.ownerNodeId
			? `task owner "${targetNode.ownerNodeId}", `
			: targetNode.minCompleterTier !== undefined
				? `rank <= L${targetNode.minCompleterTier}, `
				: '';
		return {
			ok: false,
			taskStatuses: existing,
			code: 'FORBIDDEN',
			error: `FORBIDDEN: only ${permHint}the highest-rank role (${highest ? `L${highest.tier} ${highest.name}` : 'L1'}) or Human User may mark Mission task "${nodeId}" as completed.`,
		};
	}

	const now = params.now ?? Date.now();
	const incompleteUpstreamTaskIds = taskGraph.edges
		.filter(e => e.to === nodeId && e.edgeKind !== 'fail')
		.map(e => e.from)
		.filter(upId => existing[upId]?.status !== 'completed');

	// Hard DAG invariant: refuse premature task completion when upstream dependencies are incomplete
	// (only Human User may override explicitly via `force: true`).
	if (params.status === 'completed' && incompleteUpstreamTaskIds.length > 0 && !(params.force && params.caller.isHumanUser)) {
		return {
			ok: false,
			taskStatuses: existing,
			incompleteUpstreamTaskIds,
			code: 'INCOMPLETE_DEPENDENCIES',
			error: `INCOMPLETE_DEPENDENCIES: cannot mark Mission task "${nodeId}" completed while upstream prerequisite(s) are incomplete: ${incompleteUpstreamTaskIds.join(', ')}.`,
		};
	}

	const startedAt = prevRecord?.startedAt ?? (params.status === 'in_progress' ? now : undefined);
	const durationMs = params.status === 'completed' && startedAt !== undefined
		? Math.max(0, now - startedAt)
		: prevRecord?.durationMs;

	const nextRecord: IMissionTaskStatusRecord = {
		...(prevRecord ? {
			...(prevRecord.assigneeNodeId ? { assigneeNodeId: prevRecord.assigneeNodeId } : {}),
			...(prevRecord.assigneeLabel ? { assigneeLabel: prevRecord.assigneeLabel } : {}),
			...(prevRecord.activeTokenIds ? { activeTokenIds: prevRecord.activeTokenIds } : {}),
			...(prevRecord.lastTokenId ? { lastTokenId: prevRecord.lastTokenId } : {}),
			...(prevRecord.artifactPtrs ? { artifactPtrs: prevRecord.artifactPtrs } : {}),
		} : {}),
		status: params.status,
		...(startedAt !== undefined ? { startedAt } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(params.status === 'completed'
			? {
				completedBy: params.caller.callerSessionId ?? (params.caller.isHumanUser ? 'human' : undefined),
				completedByLabel: params.caller.callerLabel ?? (params.caller.isHumanUser ? 'User' : undefined),
				completedByTier: params.caller.isHumanUser ? -1 : params.caller.callerTier,
				completedAt: now,
			}
			: {}),
		...(params.status === 'blocked' && prevRecord?.blockedReason ? { blockedReason: prevRecord.blockedReason } : {}),
		...(params.status === 'blocked' && prevRecord?.lastError ? { lastError: prevRecord.lastError } : {}),
		...(params.note?.trim() ? { note: params.note.trim() } : (prevRecord?.note ? { note: prevRecord.note } : {})),
		updatedAt: now,
	};

	return {
		ok: true,
		taskStatuses: {
			...existing,
			[nodeId]: nextRecord,
		},
		...(incompleteUpstreamTaskIds.length > 0 ? { incompleteUpstreamTaskIds } : {}),
	};
}

/**
 * Bidirectional Mission Task DAG ↔ Orchestration Runtime synchronizer:
 * Automatically reflects live token bindings (`taskNodeId` / `taskNodeIds`) onto each Mission DAG
 * task card (status `in_progress`/`blocked`, active tokens, current assignee, elapsed duration,
 * artifact pointers, and errors) while strictly preserving authorized superior sign-off for `'completed'`.
 */
export function syncMissionTaskStatusesFromOrchestration(
	currentStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined,
	taskGraph: IMissionDagParseResult,
	orchState: IOrchestrationRuntimeState | undefined,
	orchGraph: IOrchestrationGraphParseResult | undefined,
	now = Date.now(),
): {
	readonly taskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>>;
	readonly changed: boolean;
} {
	const existing = currentStatuses ?? {};
	if (!orchState || taskGraph.error || taskGraph.nodes.length === 0) {
		return { taskStatuses: existing, changed: false };
	}

	const tokensByTask = new Map<string, IOrchestrationToken[]>();
	for (const token of Object.values(orchState.tokens)) {
		const boundIds = new Set<string>();
		if (token.taskNodeId?.trim()) {
			boundIds.add(token.taskNodeId.trim());
		}
		for (const tid of token.taskNodeIds ?? []) {
			if (tid.trim()) {
				boundIds.add(tid.trim());
			}
		}
		for (const tid of boundIds) {
			const list = tokensByTask.get(tid) ?? [];
			list.push(token);
			tokensByTask.set(tid, list);
		}
	}

	const staffById = new Map<string, IOrchestrationGraphNode>();
	for (const n of orchGraph?.nodes ?? []) {
		if (n.kind === 'staff') {
			staffById.set(n.id, n);
		}
	}

	let changed = false;
	const next: Record<string, IMissionTaskStatusRecord> = { ...existing };

	for (const taskNode of taskGraph.nodes) {
		const boundTokens = tokensByTask.get(taskNode.id);
		const prev = existing[taskNode.id];
		if (!boundTokens || boundTokens.length === 0) {
			// Ensure static assignee from `%% task ... [assignee=...]` surfaces if not already set
			if (taskNode.assigneeNodeId && !prev?.assigneeNodeId) {
				const staff = staffById.get(taskNode.assigneeNodeId);
				next[taskNode.id] = {
					...(prev ?? {}),
					status: prev?.status ?? 'pending',
					assigneeNodeId: taskNode.assigneeNodeId,
					...(staff ? { assigneeLabel: staff.employeeName || staff.label } : {}),
					updatedAt: prev?.updatedAt ?? now,
				};
				changed = true;
			}
			continue;
		}

		boundTokens.sort((a, b) => (a.arrivedAt - b.arrivedAt) || (a.lastActivityAt - b.lastActivityAt));
		const activeTokens = boundTokens.filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join');
		const blockedTokens = boundTokens.filter(t => t.status === 'blocked');
		const latestToken = boundTokens[boundTokens.length - 1];
		const primaryActive = activeTokens[activeTokens.length - 1];
		const earliestArrived = boundTokens[0]?.arrivedAt;

		const artifactPtrSet = new Set<string>(prev?.artifactPtrs ?? []);
		for (const tok of boundTokens) {
			for (const ref of tok.contextRefs ?? []) {
				if (ref.kind === 'artifact' || ref.kind === 'decision') {
					artifactPtrSet.add(ref.ptr);
				}
			}
		}
		const artifactPtrs = [...artifactPtrSet];
		const activeTokenIds = activeTokens.map(t => t.id);

		const assigneeNodeId = primaryActive?.nodeId ?? latestToken?.nodeId ?? prev?.assigneeNodeId ?? taskNode.assigneeNodeId;
		const assigneeStaff = assigneeNodeId ? staffById.get(assigneeNodeId) : undefined;
		const assigneeLabel = assigneeStaff ? (assigneeStaff.employeeName || assigneeStaff.label) : prev?.assigneeLabel;

		let nextStatus: MissionTaskStatus = prev?.status ?? 'pending';
		let blockedReason: string | undefined = prev?.blockedReason;
		let lastError: string | undefined = prev?.lastError;

		if (prev?.status === 'completed') {
			nextStatus = 'completed';
			blockedReason = undefined;
			lastError = undefined;
		} else if (blockedTokens.length > 0) {
			nextStatus = 'blocked';
			blockedReason = blockedTokens[blockedTokens.length - 1].blocked?.reason ?? 'Blocked';
		} else if (activeTokens.length > 0) {
			nextStatus = 'in_progress';
			blockedReason = undefined;
			lastError = undefined;
		} else if (latestToken?.status === 'failed') {
			nextStatus = 'blocked';
			lastError = latestToken.failureReason ?? 'Token failed';
			blockedReason = lastError;
		} else if (prev?.status === 'pending' && boundTokens.length > 0) {
			// Work started & returned awaiting superior's explicit completion verification
			nextStatus = 'in_progress';
		}

		const startedAt = prev?.startedAt ?? earliestArrived;
		const durationMs = nextStatus === 'completed'
			? (prev?.durationMs ?? (startedAt !== undefined && prev?.completedAt !== undefined ? Math.max(0, prev.completedAt - startedAt) : undefined))
			: (startedAt !== undefined ? Math.max(0, now - startedAt) : prev?.durationMs);

		const candidate: IMissionTaskStatusRecord = {
			...(prev ?? { status: nextStatus, updatedAt: now }),
			status: nextStatus,
			...(assigneeNodeId ? { assigneeNodeId } : {}),
			...(assigneeLabel ? { assigneeLabel } : {}),
			...(activeTokenIds.length > 0 ? { activeTokenIds } : { activeTokenIds: undefined }),
			...(latestToken ? { lastTokenId: latestToken.id } : {}),
			...(startedAt !== undefined ? { startedAt } : {}),
			...(durationMs !== undefined ? { durationMs } : {}),
			...(artifactPtrs.length > 0 ? { artifactPtrs } : {}),
			...(blockedReason ? { blockedReason } : { blockedReason: undefined }),
			...(lastError ? { lastError } : { lastError: undefined }),
			updatedAt: prev?.updatedAt ?? now,
		};

		const cleanCandidate = JSON.parse(JSON.stringify(candidate)) as IMissionTaskStatusRecord;
		const prevSig = prev ? JSON.stringify({ ...prev, updatedAt: 0, durationMs: 0 }) : '';
		const nextSig = JSON.stringify({ ...cleanCandidate, updatedAt: 0, durationMs: 0 });
		if (prevSig !== nextSig) {
			next[taskNode.id] = { ...cleanCandidate, updatedAt: now };
			changed = true;
		}
	}

	return { taskStatuses: changed ? next : existing, changed };
}

// ============================================================================
// 2. Department Shared Whiteboards (Strictly Lightweight Token Pointers)
// ============================================================================

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

export interface IWhiteboardAttachmentValidationResult {
	readonly ok: boolean;
	readonly normalizedIds: readonly string[];
	readonly code?: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_STATE';
	readonly error?: string;
}

/**
 * Strictly validates all `--whiteboard` / `wb:<id>` token attachments before any state mutation:
 * 1. Rejects inline document text pasted into `--whiteboard` (enforcing pointer-only discipline).
 * 2. Rejects nonexistent whiteboard IDs (`NOT_FOUND`).
 * 3. Enforces department / graph-edge whiteboard scoping (`FORBIDDEN`) via `canCallerAccessWhiteboard`.
 */
export function validateTokenWhiteboardAttachments(
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	caller: {
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerTier?: number;
		readonly callerNodeId?: string;
	},
	whiteboardIds?: readonly string[],
	refPtrs?: readonly string[],
): IWhiteboardAttachmentValidationResult {
	const rawIds: string[] = [];
	for (const raw of whiteboardIds ?? []) {
		const trimmed = raw.trim();
		if (!trimmed) {
			continue;
		}
		rawIds.push(trimmed.startsWith('wb:') ? trimmed.slice(3).trim() : trimmed);
	}
	for (const rawPtr of refPtrs ?? []) {
		const trimmed = rawPtr.trim();
		if (trimmed.startsWith('wb:')) {
			const wbId = trimmed.slice(3).trim();
			if (wbId) {
				rawIds.push(wbId);
			}
		}
	}
	if (rawIds.length === 0) {
		return { ok: true, normalizedIds: [] };
	}

	const normalizedIds: string[] = [];
	const seen = new Set<string>();
	for (const id of rawIds) {
		if (seen.has(id)) {
			continue;
		}
		const wb = whiteboards?.[id];
		if (!wb) {
			if (/[\r\n]/.test(id) || id.length > 96 || (/\s/.test(id) && id.length > 24)) {
				return {
					ok: false,
					normalizedIds: [],
					code: 'INVALID_STATE',
					error: `INVALID_WHITEBOARD_POINTER: "--whiteboard" accepts ONLY lightweight whiteboard IDs (e.g. "WB_ARCH"), never inline document text. Write content via "aexus-ade whiteboard write" first, then pass its ID.`,
				};
			}
			return {
				ok: false,
				normalizedIds: [],
				code: 'NOT_FOUND',
				error: `Whiteboard "${id}" does not exist. Create it first via "aexus-ade whiteboard create" or inspect available IDs via "aexus-ade whiteboard list".`,
			};
		}
		if (!canCallerAccessWhiteboard(graph, wb, config, caller)) {
			return {
				ok: false,
				normalizedIds: [],
				code: 'FORBIDDEN',
				error: `FORBIDDEN: staff "${caller.callerNodeId ?? 'caller'}" cannot attach whiteboard "${wb.id}" (Department: "${wb.department}") to token.`,
			};
		}
		seen.add(id);
		normalizedIds.push(id);
	}
	return { ok: true, normalizedIds };
}

export interface ITaskBindingValidationResult {
	readonly ok: boolean;
	readonly code?: 'NOT_FOUND' | 'INVALID_STATE' | 'INVALID_GRAPH';
	readonly error?: string;
}

/**
 * Validates explicit `--task <taskId>` bindings against the Mission Task DAG when present.
 * Rejects nonexistent task IDs (`NOT_FOUND`) and new active work targeting already-completed tasks (`INVALID_STATE`).
 */
export function validateTokenTaskBindings(
	taskGraph: IMissionDagParseResult | undefined,
	taskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined,
	taskIds: readonly string[],
	options?: { readonly allowCompleted?: boolean },
): ITaskBindingValidationResult {
	if (!taskGraph || taskIds.length === 0) {
		return { ok: true };
	}
	if (taskGraph.error) {
		return { ok: false, code: 'INVALID_GRAPH', error: `Mission Task DAG is invalid: ${taskGraph.error}` };
	}
	const validIds = new Set(taskGraph.nodes.map(n => n.id));
	for (const raw of taskIds) {
		const tid = raw.trim();
		if (!tid) {
			continue;
		}
		if (!validIds.has(tid)) {
			return {
				ok: false,
				code: 'NOT_FOUND',
				error: `Mission Task DAG node "${tid}" does not exist. Inspect valid tasks via "aexus-ade mission task list" or create it via "aexus-ade mission task create".`,
			};
		}
		if (!options?.allowCompleted && taskStatuses?.[tid]?.status === 'completed') {
			return {
				ok: false,
				code: 'INVALID_STATE',
				error: `Mission Task DAG node "${tid}" is already completed and cannot be bound to a new active work token.`,
			};
		}
	}
	return { ok: true };
}

export function buildWhiteboardPointers(
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	whiteboardIds: readonly string[] | undefined,
): readonly IOrchestrationWhiteboardPointer[] {
	if (!whiteboards || !whiteboardIds || whiteboardIds.length === 0) {
		return [];
	}
	const seen = new Set<string>();
	const pointers: IOrchestrationWhiteboardPointer[] = [];
	for (const rawId of whiteboardIds) {
		const id = rawId.trim();
		if (!id || seen.has(id)) {
			continue;
		}
		const wb = whiteboards[id];
		if (!wb) {
			continue;
		}
		seen.add(id);
		// Explicitly project ONLY lightweight metadata fields — never `content`!
		pointers.push({
			whiteboardId: wb.id,
			department: wb.department,
			title: wb.title,
			version: wb.version,
		});
	}
	return pointers;
}

export function canCallerAccessWhiteboard(
	graph: IOrchestrationGraphParseResult,
	whiteboard: IOrchestrationWhiteboard,
	config: IAdeOrganizationConfig,
	caller: {
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerTier?: number;
		readonly callerNodeId?: string;
	},
): boolean {
	if (caller.isHumanUser || caller.isSecretary || isHighestRankTaskCompleter(config, caller)) {
		return true;
	}
	if (!caller.callerNodeId) {
		return false;
	}
	const staffNode = graph.nodes.find(n => n.id === caller.callerNodeId && n.kind === 'staff');
	if (!staffNode) {
		return false;
	}
	// 1. Same department (case-insensitive)
	if (staffNode.department && whiteboard.department && staffNode.department.trim().toLowerCase() === whiteboard.department.trim().toLowerCase()) {
		return true;
	}
	// 2. Direct graph edge between staff node and whiteboard node
	if (graph.edges.some(e =>
		(e.from === staffNode.id && e.to === whiteboard.id)
		|| (e.to === staffNode.id && e.from === whiteboard.id),
	)) {
		return true;
	}
	// 3. Department-wide fallback when whiteboard department is 'General' or empty
	if (!whiteboard.department || whiteboard.department.trim().toLowerCase() === 'general') {
		return true;
	}
	return false;
}

export function upsertDepartmentWhiteboard(
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	params: {
		readonly id: string;
		readonly title?: string;
		readonly department?: string;
		readonly content?: string;
		readonly appendContent?: string;
		readonly updatedBy?: string;
		readonly updatedByLabel?: string;
		readonly now?: number;
	},
): { readonly whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>>; readonly whiteboard: IOrchestrationWhiteboard } {
	const existingMap = whiteboards ?? {};
	const id = params.id.trim();
	const prev = existingMap[id];
	const now = params.now ?? Date.now();

	let nextContent: string;
	if (params.appendContent !== undefined) {
		const prevText = prev?.content ?? '';
		nextContent = prevText ? `${prevText.replace(/\s+$/, '')}\n\n${params.appendContent}` : params.appendContent;
	} else if (params.content !== undefined) {
		nextContent = params.content;
	} else {
		nextContent = prev?.content ?? '';
	}

	const whiteboard: IOrchestrationWhiteboard = {
		id,
		title: params.title?.trim() || prev?.title || id,
		department: params.department?.trim() || prev?.department || 'General',
		content: nextContent,
		version: prev ? prev.version + 1 : 1,
		createdAt: prev?.createdAt ?? now,
		updatedAt: now,
		...(params.updatedBy ? { updatedBy: params.updatedBy } : (prev?.updatedBy ? { updatedBy: prev.updatedBy } : {})),
		...(params.updatedByLabel ? { updatedByLabel: params.updatedByLabel } : (prev?.updatedByLabel ? { updatedByLabel: prev.updatedByLabel } : {})),
	};

	return {
		whiteboards: {
			...existingMap,
			[id]: whiteboard,
		},
		whiteboard,
	};
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

/**
 * Validated Department Shared Whiteboard mutator supporting:
 * - Strict create/write separation (`mode: 'create'` rejects duplicate IDs with `ALREADY_EXISTS`).
 * - Optimistic concurrency control (`expectedVersion` rejects stale writes with `VERSION_CONFLICT`).
 */
export function mutateDepartmentWhiteboard(
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	params: {
		readonly id: string;
		readonly title?: string;
		readonly department?: string;
		readonly content?: string;
		readonly appendContent?: string;
		readonly updatedBy?: string;
		readonly updatedByLabel?: string;
		readonly mode?: 'create' | 'write' | 'upsert';
		readonly expectedVersion?: number;
		readonly existingVersionHint?: number;
		readonly now?: number;
	},
): IMutateDepartmentWhiteboardResult {
	const id = params.id.trim();
	if (!id) {
		return { ok: false, code: 'INVALID_STATE', error: 'Whiteboard ID is required.' };
	}
	const existingMap = whiteboards ?? {};
	const prev = existingMap[id];
	const currentVersion = prev ? prev.version : (params.existingVersionHint ?? 0);
	const exists = Boolean(prev || (params.existingVersionHint !== undefined));

	if (params.mode === 'create' && exists) {
		return {
			ok: false,
			code: 'ALREADY_EXISTS',
			currentVersion,
			...(prev?.updatedByLabel ? { updatedByLabel: prev.updatedByLabel } : {}),
			error: `ALREADY_EXISTS: Department whiteboard "${id}" already exists (v${currentVersion}). Use "aexus-ade whiteboard write ${id}" to update it.`,
		};
	}

	if (params.expectedVersion !== undefined) {
		if (!Number.isInteger(params.expectedVersion) || params.expectedVersion < 0) {
			return {
				ok: false,
				code: 'INVALID_STATE',
				error: `Invalid expectedVersion "${String(params.expectedVersion)}": must be a non-negative integer.`,
			};
		}
		if (currentVersion !== params.expectedVersion) {
			const lastAuthor = prev?.updatedByLabel || prev?.updatedBy || 'unknown';
			return {
				ok: false,
				code: 'VERSION_CONFLICT',
				currentVersion,
				...(prev?.updatedByLabel ? { updatedByLabel: prev.updatedByLabel } : {}),
				error: `VERSION_CONFLICT: Whiteboard "${id}" is at v${currentVersion} (last updated by ${lastAuthor}), expected v${params.expectedVersion}. Re-read via "aexus-ade whiteboard read ${id}" before retrying.`,
			};
		}
	}

	const upserted = upsertDepartmentWhiteboard(existingMap, params);
	return {
		ok: true,
		whiteboards: upserted.whiteboards,
		whiteboard: upserted.whiteboard,
	};
}

/**
 * Prunes dangling `wb:<id>` references from live (`active`/`blocked`/`waiting_join`) tokens
 * after a whiteboard is removed so re-woken staff never carry dead whiteboard pointers.
 */
export function pruneRemovedWhiteboardFromState(
	state: IOrchestrationRuntimeState,
	whiteboardId: string,
	now = Date.now(),
): { readonly state: IOrchestrationRuntimeState; readonly prunedTokenIds: readonly string[] } {
	const id = whiteboardId.trim();
	if (!id) {
		return { state, prunedTokenIds: [] };
	}
	const ptr = `wb:${id}`;
	let changed = false;
	const prunedTokenIds: string[] = [];
	const nextTokens: Record<string, IOrchestrationToken> = { ...state.tokens };
	for (const [tid, tok] of Object.entries(state.tokens)) {
		if (tok.status !== 'active' && tok.status !== 'blocked' && tok.status !== 'waiting_join') {
			continue;
		}
		const hadPointer = Boolean(tok.whiteboardPointers?.some(p => p.whiteboardId === id));
		const hadRef = Boolean(tok.contextRefs?.some(r => r.ptr === ptr));
		if (!hadPointer && !hadRef) {
			continue;
		}
		changed = true;
		prunedTokenIds.push(tid);
		const nextPointers = tok.whiteboardPointers?.filter(p => p.whiteboardId !== id);
		const nextRefs = tok.contextRefs?.filter(r => r.ptr !== ptr);
		nextTokens[tid] = {
			...tok,
			...(nextPointers && nextPointers.length > 0 ? { whiteboardPointers: nextPointers } : { whiteboardPointers: undefined }),
			...(nextRefs ? { contextRefs: nextRefs } : {}),
		};
	}
	if (!changed) {
		return { state, prunedTokenIds: [] };
	}
	return {
		state: {
			...state,
			tokens: nextTokens,
			updatedAt: now,
		},
		prunedTokenIds,
	};
}

// ============================================================================
// 3. All-Staff Cyclic Re-Entrant Orchestration Token Engine
//    (Layered Content-Addressed Pointer Envelope + Per-Employee Delta Cursor)
// ============================================================================

export type OrchestrationTokenStatus = 'active' | 'blocked' | 'waiting_join' | 'handed_off' | 'completed' | 'failed' | 'reclaimed' | 'aborted';
export type OrchestrationNodeRuntimeStatus = 'idle' | 'active' | 'blocked' | 'waiting_join';
export type OrchestrationRefKind = 'handoff' | 'whiteboard' | 'artifact' | 'decision';

export interface IOrchestrationJoinBarrierChildResult {
	readonly tokenId: string;
	readonly fromNodeId: string;
	readonly outcome: 'returned' | 'completed' | 'failed' | 'reclaimed' | 'aborted';
	readonly summary: string;
	readonly payloadPtr?: string;
	readonly attachedRefPtrs?: readonly string[];
	readonly taskNodeId?: string;
	readonly settledAt: number;
}

export interface IOrchestrationJoinBarrier {
	readonly id: string;
	readonly waveId: string;
	readonly parentTokenId: string;
	readonly ownerNodeId: string;
	readonly childTokenIds: readonly string[];
	readonly mode: 'all' | 'any';
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

/**
 * Compact 1-line pass-history ledger entry carried by the token so any holder sees the full
 * relay trajectory and can jump directly to any historical round's independent pointer on demand.
 */
export interface IOrchestrationHopLedgerEntry {
	readonly hop: number;
	readonly tokenId: string;
	readonly fromNodeId?: string;
	readonly toNodeId: string;
	readonly event: 'dispatch' | 'mint' | 'handoff' | 'return' | 'join_resume' | 'complete' | 'fail' | 'reclaim' | 'abort';
	readonly headline: string;
	/** Independent per-hop payload pointer (`hop-N`) when this round carried details beyond the 1-line headline. */
	readonly payloadPtr?: string;
	/** Any split pointers (`art-N`, `dec-N`, `wb:<id>`) newly attached or bumped on this hop. */
	readonly attachedRefPtrs?: readonly string[];
	readonly timestamp: number;
}

/**
 * Per-staff-node read watermark (keyed by `${waveId}:${nodeId}`):
 * Because Orchestration employees persist across cycles, tracking their last seen hop & ref versions
 * ensures cyclic re-entry injects ONLY new/changed deltas and NEVER repeats already-seen context!
 */
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
	readonly waveId: string;
	readonly nodeId: string;
	readonly fromNodeId?: string;
	readonly holderAgentId?: string;
	readonly status: OrchestrationTokenStatus;
	/** Parent token ID when minted/handed off from an upstream baton. */
	readonly parentTokenId?: string;
	/** Root token ID of this orchestration wave/chain. */
	readonly rootTokenId?: string;
	/** Staff node ID that dispatched/minted this baton downward (or `'User'` for root dispatches). */
	readonly originNodeId?: string;
	/** Explicit superior staff node ID that a subordinate should return this token to upon completion. */
	readonly returnToNodeId?: string;
	readonly dispatchKind?: 'dispatch' | 'mint' | 'handoff' | 'return';
	/** Join barrier ID this parent token is currently waiting on (`status === 'waiting_join'`). */
	readonly joinBarrierId?: string;
	/** Join barrier ID this child token reports into upon return/complete/fail/reclaim. */
	readonly parentJoinBarrierId?: string;
	/** Child token IDs actively minted from this superior baton. */
	readonly childTokenIds?: readonly string[];
	/** Optional primary Mission Task DAG node ID bound to this token. */
	readonly taskNodeId?: string;
	/** Optional additional Mission Task DAG node IDs bound to this token. */
	readonly taskNodeIds?: readonly string[];
	/** Monotonic hop index along this baton's lineage (0 = User dispatch, 1 = first handoff, ...). */
	readonly hopIndex?: number;
	/** Compact 1-line headline (<= 160 chars) for instant zero-tool-call orientation. Full body lives at `payloadPtr`. */
	readonly lastSummary: string;
	/** Independent per-hop pointer ID (`hop-N`) pointing to THIS hop's full detailed payload in `state.payloadStore`. */
	readonly payloadPtr?: string;
	/** Compact hop-by-hop pass history ledger (ONLY 1-line headlines + pointer IDs, NEVER raw bodies). */
	readonly hopLog?: readonly IOrchestrationHopLedgerEntry[];
	/** Typed, deduplicated pointer manifest (`handoff`, `whiteboard`, `artifact`, `decision`) — ZERO body text. */
	readonly contextRefs?: readonly IOrchestrationContextRef[];
	readonly compressedHistory: string;
	readonly historyState?: IMissionRollingHistoryState;
	readonly tracePtr: string;
	/** STRICTLY lightweight reference pointers to Department Shared Whiteboards (NEVER full whiteboard text!). */
	readonly whiteboardPointers?: readonly IOrchestrationWhiteboardPointer[];
	readonly arrivedAt: number;
	readonly lastActivityAt: number;
	readonly lastNudgeAt?: number;
	readonly nudgeCount: number;
	readonly blocked?: IMissionTokenBlockedInfo;
	readonly handedOffToNodeIds?: readonly string[];
	readonly failureReason?: string;
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
	readonly hop: number;
	readonly waveId: string;
	readonly createdAt: number;
}

export interface IOrchestrationRuntimeState {
	readonly missionId: string;
	readonly status?: 'running' | 'paused' | 'aborted';
	readonly pausedAt?: number;
	readonly pausedReason?: string;
	readonly silenceReminderMinutes: number;
	readonly nodeStates: Readonly<Record<string, OrchestrationNodeRuntimeStatus>>;
	readonly nodeAgentIds: Readonly<Record<string, string>>;
	readonly tokens: Readonly<Record<string, IOrchestrationToken>>;
	readonly traces: Readonly<Record<string, IMissionTraceNode>>;
	/** Convergence barriers tracking fan-out child tokens back to their waiting superior baton. */
	readonly joinBarriers?: Readonly<Record<string, IOrchestrationJoinBarrier>>;
	readonly barrierSeq?: number;
	/** Single-source content-addressed pointer store for per-hop payloads, artifacts & decisions (ZERO duplication in tokens). */
	readonly payloadStore?: Readonly<Record<string, IOrchestrationContextBlob>>;
	readonly payloadSeq?: number;
	/** Metadata index for cold blobs externalized out of hot JSON into per-mission `.blobs/<ptr>.json`. */
	readonly externalizedBlobIndex?: Readonly<Record<string, IOrchestrationExternalizedBlobMeta>>;
	/** Count of terminal tokens archived out of hot JSON into `.archive.jsonl`. */
	readonly archivedTokenCount?: number;
	/** Count of trace entries archived out of hot JSON into `.archive.jsonl`. */
	readonly archivedTraceCount?: number;
	/** Per-employee read cursors (`${waveId}:${nodeId}`) driving zero-redundancy delta views on cyclic re-entry. */
	readonly nodeReadCursors?: Readonly<Record<string, IOrchestrationNodeReadCursor>>;
	/** Durable queue of side-effects emitted by the main-process headless daemon while 0 workbench windows were open; drained on next window attach. */
	readonly pendingHeadlessEffects?: readonly OrchestrationEngineEffect[];
	readonly tokenSeq: number;
	readonly waveSeq: number;
	readonly traceSeq: number;
	readonly updatedAt: number;
}

export function computeOrchestrationContentDigest(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildCompactHeadline(rawText: string, maxChars = ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS): {
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

function buildCursorKey(waveId: string, nodeId: string): string {
	return `${waveId}:${nodeId}`;
}

function storeOrReuseContextBlob(
	store: Record<string, IOrchestrationContextBlob>,
	seqRef: { value: number },
	params: {
		readonly kind: Exclude<OrchestrationRefKind, 'whiteboard'>;
		readonly title: string;
		readonly content: string;
		readonly authorNodeId?: string;
		readonly authorAgentId?: string;
		readonly hop: number;
		readonly waveId: string;
		readonly now: number;
	},
): IOrchestrationContextRef {
	const cleanContent = params.content.trim();
	const cleanTitle = params.title.replace(/\s+/g, ' ').trim().slice(0, 100) || `${params.kind} #${params.hop}`;
	const digest = computeOrchestrationContentDigest(cleanContent);
	// Content-addressed deduplication: reuse existing identical blob pointer if already stored!
	for (const existing of Object.values(store)) {
		if (existing.kind === params.kind && existing.digest === digest && existing.content === cleanContent) {
			return {
				ptr: existing.ptr,
				kind: existing.kind,
				title: existing.title,
				version: 1,
				updatedAtHop: params.hop,
				...(existing.authorNodeId ? { authorNodeId: existing.authorNodeId } : {}),
				sizeChars: existing.sizeChars,
				digest: existing.digest,
			};
		}
	}
	seqRef.value += 1;
	const prefix = params.kind === 'handoff' ? 'hop' : params.kind === 'artifact' ? 'art' : 'dec';
	const ptr = `${prefix}-${seqRef.value}`;
	const blob: IOrchestrationContextBlob = {
		ptr,
		kind: params.kind,
		title: cleanTitle,
		content: cleanContent,
		sizeChars: cleanContent.length,
		digest,
		...(params.authorNodeId ? { authorNodeId: params.authorNodeId } : {}),
		...(params.authorAgentId ? { authorAgentId: params.authorAgentId } : {}),
		hop: params.hop,
		waveId: params.waveId,
		createdAt: params.now,
	};
	store[ptr] = blob;
	return {
		ptr,
		kind: blob.kind,
		title: blob.title,
		version: 1,
		updatedAtHop: params.hop,
		...(blob.authorNodeId ? { authorNodeId: blob.authorNodeId } : {}),
		sizeChars: blob.sizeChars,
		digest: blob.digest,
	};
}

function buildWhiteboardContextRef(
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

function refreshContextRefsWithLiveWhiteboards(
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

/**
 * Computes the zero-redundancy Delta View of an Orchestration token for its current holder node.
 * On first visit, surfaces all compact hops & pointers; on cyclic re-entry into an already-visited
 * employee, isolates ONLY new hops & newly added / version-bumped pointers so already-seen context
 * is NEVER duplicated into the employee's persistent LLM session!
 */
function buildHopKey(entry: Pick<IOrchestrationHopLedgerEntry, 'tokenId' | 'hop'>): string {
	return `${entry.tokenId}:${entry.hop}`;
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

	const seenHopSet = cursor.seenHopIds ? new Set(cursor.seenHopIds) : undefined;
	const newHops = seenHopSet
		? hopLog.filter(h => !seenHopSet.has(buildHopKey(h)))
		: hopLog.filter(h => h.hop > cursor.lastSeenHop);
	const earlierHops = seenHopSet
		? hopLog.filter(h => seenHopSet.has(buildHopKey(h)))
		: hopLog.filter(h => h.hop <= cursor.lastSeenHop);
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
		isReentrantVisit: true,
		lastSeenHop: cursor.lastSeenHop,
		newHops,
		earlierHops,
		newOrUpdatedRefs,
		unchangedRefs,
	};
}

function recordNodeCursorObservation(
	cursors: Readonly<Record<string, IOrchestrationNodeReadCursor>> | undefined,
	waveId: string,
	nodeId: string,
	observedHop: number,
	observedRefs: readonly IOrchestrationContextRef[],
	now: number,
	observedHopIds?: readonly string[],
): Readonly<Record<string, IOrchestrationNodeReadCursor>> {
	const key = buildCursorKey(waveId, nodeId);
	const prev = cursors?.[key];
	const nextSeen: Record<string, number> = { ...(prev?.seenRefVersions ?? {}) };
	for (const ref of observedRefs) {
		nextSeen[ref.ptr] = Math.max(nextSeen[ref.ptr] ?? 0, ref.version);
	}
	const seenHopSet = new Set<string>(prev?.seenHopIds ?? []);
	for (const hopId of observedHopIds ?? []) {
		seenHopSet.add(hopId);
	}
	return {
		...(cursors ?? {}),
		[key]: {
			lastSeenHop: Math.max(prev?.lastSeenHop ?? -1, observedHop),
			seenHopIds: [...seenHopSet],
			seenRefVersions: nextSeen,
			updatedAt: now,
		},
	};
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
		| 'ALLOWED_PATHS_VIOLATION'
		| 'PAUSED';
	readonly error?: string;
	readonly data?: T;
}

function normalizeScopePath(raw: string): string {
	return raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Validates explicitly reported modified files against a staff node's configured `allowedPaths`.
 * Returns `ok: true` when no `allowedPaths` boundary is configured or no files were reported.
 */
export function validateStaffAllowedPaths(
	node: IOrchestrationGraphNode | undefined,
	modifiedFiles: readonly string[] | undefined,
): { readonly ok: boolean; readonly violations?: readonly string[]; readonly error?: string } {
	const allowed = (node?.allowedPaths ?? []).map(normalizeScopePath).filter(Boolean);
	const files = (modifiedFiles ?? []).map(normalizeScopePath).filter(Boolean);
	if (allowed.length === 0 || files.length === 0) {
		return { ok: true };
	}
	const violations = files.filter(filePath => {
		return !allowed.some(prefix => {
			if (prefix === '.' || prefix === '*' || prefix === '**') {
				return true;
			}
			const cleanPrefix = prefix.replace(/\/\*\*?$/, '');
			return filePath === cleanPrefix || filePath.startsWith(`${cleanPrefix}/`);
		});
	});
	if (violations.length > 0) {
		return {
			ok: false,
			violations,
			error: `ALLOWED_PATHS_VIOLATION: staff "${node?.id}" modified out-of-scope file(s): ${violations.join(', ')}. Allowed paths: ${allowed.join(', ')}.`,
		};
	}
	return { ok: true };
}

export function createInitialOrchestrationRuntimeState(
	missionId: string,
	staffNodeIds: readonly string[] = [],
	now = Date.now(),
): IOrchestrationRuntimeState {
	const nodeStates: Record<string, OrchestrationNodeRuntimeStatus> = {};
	for (const id of staffNodeIds) {
		nodeStates[id] = 'idle';
	}
	return {
		missionId,
		status: 'running',
		silenceReminderMinutes: ORCHESTRATION_SILENCE_REMINDER_MINUTES,
		nodeStates,
		nodeAgentIds: {},
		tokens: {},
		traces: {},
		joinBarriers: {},
		barrierSeq: 0,
		payloadStore: {},
		payloadSeq: 0,
		externalizedBlobIndex: {},
		archivedTokenCount: 0,
		archivedTraceCount: 0,
		nodeReadCursors: {},
		tokenSeq: 0,
		waveSeq: 0,
		traceSeq: 0,
		updatedAt: now,
	};
}

export function hasActiveOrchestrationTokens(state: IOrchestrationRuntimeState | undefined): boolean {
	if (!state) {
		return false;
	}
	return Object.values(state.tokens).some(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join');
}

function recomputeOrchestrationNodeState(
	tokens: Readonly<Record<string, IOrchestrationToken>>,
	nodeId: string,
): OrchestrationNodeRuntimeStatus {
	let hasBlocked = false;
	let hasWaitingJoin = false;
	for (const t of Object.values(tokens)) {
		if (t.nodeId !== nodeId) {
			continue;
		}
		if (t.status === 'active') {
			return 'active';
		}
		if (t.status === 'blocked') {
			hasBlocked = true;
		}
		if (t.status === 'waiting_join') {
			hasWaitingJoin = true;
		}
	}
	return hasBlocked ? 'blocked' : hasWaitingJoin ? 'waiting_join' : 'idle';
}

function hasDownwardLineageFrom(token: IOrchestrationToken, targetNodeId: string): boolean {
	if (token.returnToNodeId === targetNodeId || token.originNodeId === targetNodeId || token.fromNodeId === targetNodeId) {
		return true;
	}
	for (const entry of token.hopLog ?? []) {
		if (entry.fromNodeId === targetNodeId || entry.toNodeId === targetNodeId) {
			return true;
		}
	}
	return false;
}

function normalizeBoundTaskIds(taskNodeId?: string, taskNodeIds?: readonly string[]): {
	readonly taskNodeId?: string;
	readonly taskNodeIds?: readonly string[];
} {
	const list = [...new Set([
		...(taskNodeId?.trim() ? [taskNodeId.trim()] : []),
		...(taskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
	])];
	if (list.length === 0) {
		return {};
	}
	return {
		taskNodeId: list[0],
		...(list.length > 1 ? { taskNodeIds: list } : {}),
	};
}

export function findHighestRankStaffNode(
	graph: IOrchestrationGraphParseResult,
): IOrchestrationGraphNode | undefined {
	const staff = graph.nodes.filter(n => n.kind === 'staff');
	if (staff.length === 0) {
		return undefined;
	}
	const sorted = [...staff].sort((a, b) => {
		const ta = a.tier ?? 99;
		const tb = b.tier ?? 99;
		if (ta !== tb) {
			return ta - tb;
		}
		// Tie-breaker: node with fewest incoming non-cycle edges
		const inA = graph.edges.filter(e => e.to === a.id && !e.isCycleBackEdge).length;
		const inB = graph.edges.filter(e => e.to === b.id && !e.isCycleBackEdge).length;
		return inA - inB;
	});
	return sorted[0];
}

function formatContextRefLine(ref: IOrchestrationContextRef): string {
	const metaParts = [
		ref.kind,
		ref.department ? `dept:${ref.department}` : undefined,
		`v${ref.version}`,
		`hop #${ref.updatedAtHop}`,
		ref.authorNodeId ? `by ${ref.authorNodeId}` : undefined,
		`${ref.sizeChars} chars`,
	].filter(Boolean).join(', ');
	return `- \`${ref.ptr}\` [${metaParts}] — ${ref.title}`;
}

export function composeOrchestrationTokenWakeupPrompt(
	missionId: string,
	node: IOrchestrationGraphNode,
	token: IOrchestrationToken,
	outgoingStaffIds: readonly string[],
	isHighestRank: boolean,
	delta?: IOrchestrationTokenDeltaView,
	extra?: {
		readonly convergedBarrier?: IOrchestrationJoinBarrier;
		readonly subordinateTargetIds?: readonly string[];
	},
): string {
	const hopNum = token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1);
	const boundTasks = [...new Set([
		...(token.taskNodeId ? [token.taskNodeId] : []),
		...(token.taskNodeIds ?? []),
	])];
	const sourceDescription = extra?.convergedBarrier
		? `Join Barrier \`${extra.convergedBarrier.id}\` converged (${Object.keys(extra.convergedBarrier.settledChildren).length}/${extra.convergedBarrier.childTokenIds.length} child tokens settled)`
		: !token.fromNodeId
			? 'User (L-1) top-level requirement dispatch into Orchestration'
			: token.dispatchKind === 'mint'
				? `Downward sub-task minted by superior \`${token.fromNodeId}\``
				: token.dispatchKind === 'return'
					? `Upward return from subordinate \`${token.fromNodeId}\``
					: `Relay handoff from staff \`${token.fromNodeId}\``;
	const lines: string[] = [
		...buildTokenSystemEnvelopeLines({
			tokenId: token.id,
			nodeId: node.id,
			nodeLabel: node.label,
			hopIndex: hopNum,
			sourceDescription,
		}),
		`[Engineering Orchestration Baton · Staff \`${node.id}\` (${node.label}) · Token \`${token.id}\` · Hop #${hopNum}]`,
		token.fromNodeId
			? `- ${token.dispatchKind === 'mint' ? 'Minted downward' : token.dispatchKind === 'return' ? 'Returned' : 'Handed off'} from: \`${token.fromNodeId}\` (wave \`${token.waveId}\`${delta?.isReentrantVisit ? `, cyclic re-entry — delta since hop #${delta.lastSeenHop}` : ''})`
			: `- Dispatched directly by User to highest-rank role (wave \`${token.waveId}\`)`,
		...(boundTasks.length > 0 ? [`- Bound Mission Task DAG Node(s): ${boundTasks.map(t => `\`${t}\``).join(', ')}`] : []),
		...(token.returnToNodeId ? [`- Return Target Superior: \`${token.returnToNodeId}\` (use \`aexus-ade token return ${token.id} --summary "..." --mission ${missionId} --json\` when finished)`] : []),
		'',
		'### Current Directive (1-Line Headline)',
		token.lastSummary || '(No headline provided)',
	];

	if (node.rolePrompt?.trim() || (node.allowedPaths && node.allowedPaths.length > 0) || (node.checks && node.checks.length > 0)) {
		lines.push('', '### Role Boundaries & Verification Scope');
		if (node.rolePrompt?.trim()) {
			lines.push(`- Role Boundary: ${node.rolePrompt.trim()}`);
		}
		if (node.allowedPaths && node.allowedPaths.length > 0) {
			lines.push(`- Allowed Read/Write Paths: ${node.allowedPaths.map(p => `\`${p}\``).join(', ')}`);
		}
		if (node.checks && node.checks.length > 0) {
			lines.push(`- Automated Verification Gates (${node.checks.length}): ${node.checks.map(c => (c.name && c.command ? `${c.name}: \`${c.command}\`` : (c.command || c.name || c.id))).join(' | ')}`);
		}
	}

	if (extra?.convergedBarrier) {
		const settledList = Object.values(extra.convergedBarrier.settledChildren);
		lines.push(
			'',
			`### Converged Sub-Task Results (Join Barrier \`${extra.convergedBarrier.id}\` · ${settledList.length}/${extra.convergedBarrier.childTokenIds.length} settled)`,
		);
		for (const child of settledList) {
			const ptrPart = child.payloadPtr ? ` [detail:\`${child.payloadPtr}\`]` : '';
			const taskPart = child.taskNodeId ? ` [task:\`${child.taskNodeId}\`]` : '';
			lines.push(`- \`${child.tokenId}\` from \`${child.fromNodeId}\` (${child.outcome})${taskPart}: ${child.summary}${ptrPart}`);
		}
	}

	if (token.payloadPtr) {
		lines.push(`- Full handoff detail pointer: \`${token.payloadPtr}\` → \`aexus-ade token read ${token.payloadPtr} --mission ${missionId} --token ${token.id} --json\``);
	}

	const newOrUpdatedRefs = delta ? delta.newOrUpdatedRefs : (token.contextRefs ?? []);
	const unchangedRefs = delta ? delta.unchangedRefs : [];

	if (newOrUpdatedRefs.length > 0) {
		lines.push(
			'',
			delta?.isReentrantVisit
				? '### New / Updated Context Pointers Since Your Last Visit (Read Only What You Need)'
				: '### Context Pointers Manifest (Lightweight References — Read On Demand)',
		);
		for (const ref of newOrUpdatedRefs) {
			lines.push(formatContextRefLine(ref));
		}
		const batchPtrs = newOrUpdatedRefs.slice(0, 4).map(r => r.ptr).join(',');
		lines.push(`- Batch read selected pointers: \`aexus-ade token read <ptr1,ptr2> --mission ${missionId} --token ${token.id} --json\` (e.g. \`${batchPtrs}\`)`);
	}

	if (unchangedRefs.length > 0) {
		lines.push(
			'',
			`### Unchanged Pointers Already In Your Context (${unchangedRefs.length} skipped to save tokens)`,
			`- ${unchangedRefs.map(r => `\`${r.ptr}@v${r.version}\` (${r.title})`).join(', ')}`,
		);
	} else if (!delta && token.whiteboardPointers && token.whiteboardPointers.length > 0 && newOrUpdatedRefs.length === 0) {
		lines.push('', '### Department Shared Whiteboard Pointers (Read On Demand)');
		for (const ptr of token.whiteboardPointers) {
			lines.push(`- \`wb:${ptr.whiteboardId}\` [Dept: ${ptr.department}, "${ptr.title}", v${ptr.version}] → \`aexus-ade token read wb:${ptr.whiteboardId} --mission ${missionId} --json\``);
		}
	}

	const newHops = delta ? delta.newHops : (token.hopLog ?? []);
	const earlierHops = delta ? delta.earlierHops : [];
	if (newHops.length > 0 || earlierHops.length > 0) {
		lines.push(
			'',
			delta?.isReentrantVisit
				? `### Relay Pass History (Delta: ${newHops.length} new hop(s); ${earlierHops.length} earlier hop(s) already seen)`
				: `### Relay Pass History (${newHops.length} hop(s) — pointer-indexed)`,
		);
		if (earlierHops.length > 0) {
			const earlierPtrs = earlierHops.map(h => h.payloadPtr).filter(Boolean).join(', ');
			lines.push(`- [Collapsed ${earlierHops.length} earlier hop(s) #0..#${earlierHops[earlierHops.length - 1].hop}${earlierPtrs ? ` · ptrs: ${earlierPtrs}` : ''} — run \`aexus-ade token history ${token.id} --mission ${missionId} --all --json\` if needed]`);
		}
		for (const entry of newHops) {
			const route = entry.fromNodeId ? `${entry.fromNodeId} → ${entry.toNodeId}` : `User → ${entry.toNodeId}`;
			const ptrHint = entry.payloadPtr ? ` [detail:\`${entry.payloadPtr}\`]` : '';
			const refHint = entry.attachedRefPtrs && entry.attachedRefPtrs.length > 0
				? ` [refs:${entry.attachedRefPtrs.map(p => `\`${p}\``).join(',')}]`
				: '';
			lines.push(`- #${entry.hop} (${entry.event}: ${route}): ${entry.headline}${ptrHint}${refHint}`);
		}
	} else if (token.compressedHistory) {
		lines.push('', '### Prior Relay History', token.compressedHistory);
	}

	lines.push('', '### Mandatory Token Relay & Context Hygiene Protocol');
	lines.push(`- You currently hold active relay baton \`${token.id}\`. Keep advancing this work until you explicitly mint/split, hand off, return, or submit the baton (a reminder fires every ${ORCHESTRATION_SILENCE_REMINDER_MINUTES} minutes if silent).`);
	lines.push('- **Directionality & Pointer Rule**: Newly minted tokens (`token mint` / `token split`) may ONLY be sent strictly downward to lower-tier subordinates. Subordinates return completed received tokens upward via `token return`. Never paste huge bodies into `--summary`; put long context in `--detail`, `--artifact`, `--decision`, or `--whiteboard`.');
	if (extra?.subordinateTargetIds && extra.subordinateTargetIds.length > 0) {
		lines.push(`- Subordinate delegation targets: ${extra.subordinateTargetIds.map(id => `\`${id}\``).join(', ')}`);
		lines.push(`- Mint heterogeneous sub-task tokens (keep parent active, OR add \`--wait-join\` to pause until all children return):`);
		lines.push(`  \`aexus-ade token mint ${token.id} --to <subNodeId> --summary "<subtask headline>" [--detail "<spec>"] [--task <taskId>] [--wait-join] --mission ${missionId} --json\``);
		lines.push(`  \`aexus-ade token split ${token.id} --branches-json '[{"toNodeId":"Sub1","summary":"...","taskNodeId":"T1"},{"toNodeId":"Sub2","summary":"...","taskNodeId":"T2"}]' --mission ${missionId} --json\``);
	}
	if (token.returnToNodeId) {
		lines.push(`- Return completed token upward to \`${token.returnToNodeId}\`:`);
		lines.push(`  \`aexus-ade token return ${token.id} --summary "<1-line delivery>" [--detail "<report>"] [--artifact "Title=Body"] --mission ${missionId} --json\``);
	}
	if (outgoingStaffIds.length > 0) {
		lines.push(`- Connected outgoing handoff targets: ${outgoingStaffIds.map(id => `\`${id}\``).join(', ')}`);
		lines.push(`- Hand off baton: \`aexus-ade token handoff ${token.id} --to <nodeId[,nodeId2]> --summary "<1-line headline>" [--detail "<full round detail>"] [--task <taskId>] [--artifact "Title=Body"] [--decision "Title=Body"] [--whiteboard <wbId>] --mission ${missionId} --json\``);
	} else if (!token.returnToNodeId) {
		lines.push(`- Note: You currently have NO outgoing staff edges on the Orchestration canvas. If you must return results to a superior, ask the orchestrator to connect a return edge (\`<-->\`) or finish if authorized.`);
	}
	lines.push(`- Inspect full hop history or dereference any pointer on demand: \`aexus-ade token history ${token.id} --mission ${missionId} --json\` | \`aexus-ade token read <ptr1,ptr2> --mission ${missionId} --token ${token.id} --json\``);
	lines.push(`- Dynamic org staffing (strictly immediate next rank & same department): \`aexus-ade orchestration staff create|remove --mission ${missionId} ...\``);
	lines.push(`- Department whiteboard (pass \`--whiteboard <id>\` pointer only): \`aexus-ade whiteboard create|read|write --mission ${missionId} ...\``);
	if (isHighestRank) {
		lines.push(`- Mission Task DAG authoring & completion: \`aexus-ade mission task create|update|remove|complete --mission ${missionId} --node <taskId> ...\``);
		lines.push(`- To conclude and submit final completion to User: \`aexus-ade token complete ${token.id} --finish --summary "<final delivery headline>" [--detail "<final report>"] --mission ${missionId} --json\``);
	} else {
		lines.push(`- Long-running wait (build/training): \`aexus-ade token block ${token.id} --duration <30m|2h> --reason "<why>" [--watch-pid <pid>] [--watch-file <path>] --mission ${missionId} --json\``);
	}
	return lines.join('\n');
}

/**
 * Dispatches a top-level requirement from the User to the highest-rank role on the Orchestration canvas
 * (or an explicitly targeted staff node).
 */
export function dispatchRequirementToOrchestration(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly prompt: string;
		readonly detail?: string;
		readonly targetNodeId?: string;
		readonly taskNodeId?: string;
		readonly taskNodeIds?: readonly string[];
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{ readonly tokenId: string; readonly targetNodeId: string; readonly payloadPtr?: string }> {
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before dispatching new requirements.' };
	}
	if (graph.error) {
		return { ok: false, state, effects: [], code: 'INVALID_GRAPH', error: graph.error };
	}
	const promptText = params.prompt.trim();
	if (!promptText) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'Requirement prompt is required.' };
	}
	const targetNode = params.targetNodeId
		? graph.nodes.find(n => n.id === params.targetNodeId && n.kind === 'staff')
		: findHighestRankStaffNode(graph);
	if (!targetNode) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'NOT_FOUND',
			error: params.targetNodeId
				? `Staff node "${params.targetNodeId}" not found on Orchestration canvas.`
				: 'No staff nodes exist on the Orchestration canvas.',
		};
	}
	const wbCheck = validateTokenWhiteboardAttachments(graph, whiteboards, config, { isHumanUser: true }, params.whiteboardIds);
	if (!wbCheck.ok) {
		return { ok: false, state, effects: [], code: wbCheck.code ?? 'INVALID_STATE', error: wbCheck.error };
	}
	const explicitTaskIds = [...new Set([
		...(params.taskNodeId?.trim() ? [params.taskNodeId.trim()] : []),
		...(params.taskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
	])];
	const taskCheck = validateTokenTaskBindings(params.taskGraph, params.taskStatuses, explicitTaskIds);
	if (!taskCheck.ok) {
		return { ok: false, state, effects: [], code: taskCheck.code ?? 'INVALID_STATE', error: taskCheck.error };
	}

	const now = params.now ?? Date.now();
	const nextWaveSeq = state.waveSeq + 1;
	const nextTokenSeq = state.tokenSeq + 1;
	const nextTraceSeq = state.traceSeq + 1;
	const waveId = `wave-${nextWaveSeq}`;
	const tokenId = `otok-${nextTokenSeq}`;
	const tracePtr = `otrc-${nextTraceSeq}`;
	const holderAgentId = state.nodeAgentIds[targetNode.id] ?? targetNode.agentId;

	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const { headline, wasTruncated } = buildCompactHeadline(promptText);
	const rawDetail = params.detail?.trim() || (wasTruncated ? promptText : '');

	const contextRefMap = new Map<string, IOrchestrationContextRef>();
	const attachedRefPtrSet = new Set<string>();
	let payloadPtr: string | undefined;
	if (rawDetail) {
		const hopRef = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
			kind: 'handoff',
			title: `Hop #0 Dispatch → ${targetNode.id}`,
			content: rawDetail,
			authorNodeId: 'User',
			hop: 0,
			waveId,
			now,
		});
		payloadPtr = hopRef.ptr;
		contextRefMap.set(hopRef.ptr, hopRef);
	}
	for (const art of params.artifacts ?? []) {
		if (art.content.trim()) {
			const ref = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
				kind: 'artifact',
				title: art.title || 'Artifact',
				content: art.content,
				authorNodeId: 'User',
				hop: 0,
				waveId,
				now,
			});
			contextRefMap.set(ref.ptr, ref);
			attachedRefPtrSet.add(ref.ptr);
		}
	}
	for (const dec of params.decisions ?? []) {
		if (dec.content.trim()) {
			const ref = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
				kind: 'decision',
				title: dec.title || 'Decision',
				content: dec.content,
				authorNodeId: 'User',
				hop: 0,
				waveId,
				now,
			});
			contextRefMap.set(ref.ptr, ref);
			attachedRefPtrSet.add(ref.ptr);
		}
	}

	const pointers = buildWhiteboardPointers(whiteboards, wbCheck.normalizedIds);
	for (const wp of pointers) {
		const liveWb = whiteboards?.[wp.whiteboardId];
		const wbRef = liveWb
			? buildWhiteboardContextRef(liveWb, 0)
			: { ptr: `wb:${wp.whiteboardId}`, kind: 'whiteboard' as const, title: wp.title, version: wp.version, updatedAtHop: 0, department: wp.department, sizeChars: 0 };
		contextRefMap.set(wbRef.ptr, wbRef);
		attachedRefPtrSet.add(wbRef.ptr);
	}
	const contextRefs = [...contextRefMap.values()];
	const attachedRefPtrs = [...attachedRefPtrSet];

	const hopEntry: IOrchestrationHopLedgerEntry = {
		hop: 0,
		tokenId,
		toNodeId: targetNode.id,
		event: 'dispatch',
		headline,
		...(payloadPtr ? { payloadPtr } : {}),
		...(attachedRefPtrs.length > 0 ? { attachedRefPtrs } : {}),
		timestamp: now,
	};

	const boundTaskFields = normalizeBoundTaskIds(params.taskNodeId, params.taskNodeIds);
	const token: IOrchestrationToken = {
		id: tokenId,
		waveId,
		nodeId: targetNode.id,
		holderAgentId,
		status: 'active',
		rootTokenId: tokenId,
		originNodeId: 'User',
		dispatchKind: 'dispatch',
		...boundTaskFields,
		hopIndex: 0,
		lastSummary: headline,
		...(payloadPtr ? { payloadPtr } : {}),
		hopLog: [hopEntry],
		contextRefs,
		compressedHistory: '',
		tracePtr,
		...(pointers.length > 0 ? { whiteboardPointers: pointers } : {}),
		arrivedAt: now,
		lastActivityAt: now,
		nudgeCount: 0,
	};

	const trace: IMissionTraceNode = {
		ptr: tracePtr,
		parentPtrs: [],
		nodeId: targetNode.id,
		employeeId: holderAgentId,
		waveId,
		event: 'mint',
		summary: headline,
		timestamp: now,
	};

	const nextTokens = { ...state.tokens, [tokenId]: token };
	const nextNodeStates = { ...state.nodeStates, [targetNode.id]: recomputeOrchestrationNodeState(nextTokens, targetNode.id) };
	const nextState: IOrchestrationRuntimeState = {
		...state,
		status: 'running',
		pausedAt: undefined,
		pausedReason: undefined,
		tokens: nextTokens,
		nodeStates: nextNodeStates,
		traces: { ...state.traces, [tracePtr]: trace },
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		waveSeq: nextWaveSeq,
		tokenSeq: nextTokenSeq,
		traceSeq: nextTraceSeq,
		updatedAt: now,
	};

	const delta = buildOrchestrationTokenDeltaView(nextState, token, whiteboards);
	const outgoingStaffIds = graph.edges
		.filter(e => e.from === targetNode.id && graph.nodes.some(n => n.id === e.to && n.kind === 'staff'))
		.map(e => e.to);
	const subordinateTargetIds = outgoingStaffIds.filter(outId => {
		const outNode = graph.nodes.find(n => n.id === outId && n.kind === 'staff');
		return Boolean(outNode && (targetNode.tier === undefined || outNode.tier === undefined || outNode.tier > targetNode.tier));
	});
	const highest = getHighestRankInSchema(config);
	const isHighest = targetNode.tier !== undefined ? targetNode.tier === highest.tier : targetNode.id === findHighestRankStaffNode(graph)?.id;
	const wakeupPrompt = composeOrchestrationTokenWakeupPrompt(state.missionId, targetNode, token, outgoingStaffIds, isHighest, delta, { subordinateTargetIds });

	return {
		ok: true,
		state: nextState,
		effects: [{
			kind: 'dispatch_token',
			missionId: state.missionId,
			nodeId: targetNode.id,
			tokenId,
			holderAgentId,
			prompt: wakeupPrompt,
		}],
		data: { tokenId, targetNodeId: targetNode.id, ...(payloadPtr ? { payloadPtr } : {}) },
	};
}

/**
 * Hands off a held Orchestration token along connected edges to 1 or more target staff nodes
 * (supports 1-to-N fan-out, bidirectional replies, and cyclic re-entry into idle employees).
 * - Strictly enforces directed edges (`from -> to`): only connected nodes may receive a token.
 * - Employees are NEVER destroyed on handoff — they return to `'idle'` and re-wake on future tokens.
 * - Every round's rich detail, artifacts, and decisions are split into independent content-addressed pointers;
 *   returning employees automatically receive ONLY the delta since their last visit (zero duplicate context!).
 */
export function handoffOrchestrationToken(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly tokenId: string;
		readonly toNodeIds: readonly string[];
		readonly summary: string;
		readonly detail?: string;
		readonly taskNodeId?: string;
		readonly taskNodeIds?: readonly string[];
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
		readonly refPtrs?: readonly string[];
		readonly modifiedFiles?: readonly string[];
		readonly callerAgentId?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{
	readonly nextTokenIds: readonly string[];
	readonly handedOffTo: readonly string[];
	readonly payloadPtr?: string;
	readonly attachedRefPtrs?: readonly string[];
	readonly barrierSatisfied?: boolean;
}> {
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before handing off tokens.' };
	}
	if (graph.error) {
		return { ok: false, state, effects: [], code: 'INVALID_GRAPH', error: graph.error };
	}
	const token = state.tokens[params.tokenId];
	if (!token || (token.status !== 'active' && token.status !== 'blocked')) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active Orchestration token "${params.tokenId}" not found.` };
	}
	if (params.callerAgentId !== undefined) {
		const boundHolder = state.nodeAgentIds[token.nodeId] ?? token.holderAgentId;
		if (boundHolder && boundHolder !== params.callerAgentId) {
			return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `Token "${params.tokenId}" is held by "${boundHolder}", not caller "${params.callerAgentId}".` };
		}
	}
	const summary = params.summary.trim();
	if (!summary) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'A concise handoff --summary is required.' };
	}

	const uniqueTargets = [...new Set(params.toNodeIds.map(s => s.trim()).filter(Boolean))];
	if (uniqueTargets.length === 0) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'At least one target staff node (--to) is required for token handoff.' };
	}

	// If this token reports into a waiting join barrier and is being handed directly back to that barrier's owner,
	// route seamlessly through `returnOrchestrationToken` so convergence happens cleanly without minting stray batons.
	if (token.parentJoinBarrierId && uniqueTargets.length === 1) {
		const barrier = state.joinBarriers?.[token.parentJoinBarrierId];
		if (barrier && barrier.status === 'waiting' && barrier.ownerNodeId === uniqueTargets[0]) {
			const ret = returnOrchestrationToken(state, graph, whiteboards, config, {
				tokenId: params.tokenId,
				toNodeId: uniqueTargets[0],
				summary,
				detail: params.detail,
				whiteboardIds: params.whiteboardIds,
				artifacts: params.artifacts,
				decisions: params.decisions,
				refPtrs: params.refPtrs,
				modifiedFiles: params.modifiedFiles,
				callerAgentId: params.callerAgentId,
				now: params.now,
			});
			return {
				...ret,
				data: ret.data
					? {
						nextTokenIds: ret.data.returnedTokenId ? [ret.data.returnedTokenId] : [],
						handedOffTo: [uniqueTargets[0]],
						...(ret.data.payloadPtr ? { payloadPtr: ret.data.payloadPtr } : {}),
						...(ret.data.attachedRefPtrs ? { attachedRefPtrs: ret.data.attachedRefPtrs } : {}),
						...(ret.data.barrierSatisfied ? { barrierSatisfied: true } : {}),
					}
					: undefined,
			};
		}
	}

	const holderNode = graph.nodes.find(n => n.id === token.nodeId && n.kind === 'staff');
	const pathScopeCheck = validateStaffAllowedPaths(holderNode, params.modifiedFiles);
	if (!pathScopeCheck.ok) {
		return { ok: false, state, effects: [], code: 'ALLOWED_PATHS_VIOLATION', error: pathScopeCheck.error };
	}
	const holderTier = resolveEffectiveStaffTier(holderNode, config);
	const validOutgoing = new Set(
		graph.edges
			.filter(e => e.from === token.nodeId)
			.map(e => e.to),
	);
	for (const targetId of uniqueTargets) {
		if (targetId === token.nodeId) {
			return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Staff node "${token.nodeId}" cannot hand off token "${token.id}" to itself.` };
		}
		const targetNode = graph.nodes.find(n => n.id === targetId && n.kind === 'staff');
		if (!targetNode) {
			return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Target staff node "${targetId}" does not exist on Orchestration canvas.` };
		}
		if (!validOutgoing.has(targetId)) {
			const available = [...validOutgoing].filter(id => graph.nodes.some(n => n.id === id && n.kind === 'staff'));
			const hasReverseEdge = graph.edges.some(e => e.from === targetId && e.to === token.nodeId);
			const choreographyHint = hasReverseEdge
				? ` Only one-way edge "${targetId} --> ${token.nodeId}" exists — add a return edge (${targetId} <--> ${token.nodeId}) during orchestration so "${token.nodeId}" can hand tokens back.`
				: '';
			return {
				ok: false,
				state,
				effects: [],
				code: 'NO_EDGE',
				error: `No directed edge from "${token.nodeId}" to "${targetId}" in Orchestration graph.${choreographyHint} Connected targets: ${available.length > 0 ? available.join(', ') : '(none)'}.`,
			};
		}
		// Strict upward directionality check: a lower-tier subordinate may ONLY send a token upward
		// to a superior who previously dispatched this token down in its lineage (return/reply).
		const targetTier = resolveEffectiveStaffTier(targetNode, config);
		if (holderTier !== undefined && targetTier !== undefined && targetTier < holderTier) {
			if (!hasDownwardLineageFrom(token, targetId)) {
				return {
					ok: false,
					state,
					effects: [],
					code: 'UPWARD_TOKEN_FORBIDDEN',
					error: `UPWARD_TOKEN_FORBIDDEN: subordinate "${token.nodeId}" (L${holderTier}) cannot send token "${token.id}" upward to superior "${targetId}" (L${targetTier}) who did not dispatch this token's lineage.`,
				};
			}
		}
	}
	const wbCheck = validateTokenWhiteboardAttachments(
		graph,
		whiteboards,
		config,
		{ callerNodeId: token.nodeId, callerTier: holderTier },
		params.whiteboardIds,
		params.refPtrs,
	);
	if (!wbCheck.ok) {
		return { ok: false, state, effects: [], code: wbCheck.code ?? 'INVALID_STATE', error: wbCheck.error };
	}
	const explicitTaskIds = [...new Set([
		...(params.taskNodeId?.trim() ? [params.taskNodeId.trim()] : []),
		...(params.taskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
	])];
	const taskCheck = validateTokenTaskBindings(params.taskGraph, params.taskStatuses, explicitTaskIds);
	if (!taskCheck.ok) {
		return { ok: false, state, effects: [], code: taskCheck.code ?? 'INVALID_STATE', error: taskCheck.error };
	}

	const now = params.now ?? Date.now();
	const prevHopIndex = token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1);
	const nextHopIndex = prevHopIndex + 1;
	const { headline, wasTruncated } = buildCompactHeadline(summary);
	const rawDetail = params.detail?.trim() || (wasTruncated ? summary : '');
	const rolledHistory = compressTokenHistoryState(token.historyState, token.compressedHistory, token.lastSummary, token.fromNodeId);

	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };

	// Merge existing context refs (refreshing live whiteboard versions/digests WITHOUT copying body text!)
	const existingRefs = refreshContextRefsWithLiveWhiteboards(token.contextRefs, whiteboards, token.whiteboardPointers, nextHopIndex);
	const mergedRefMap = new Map<string, IOrchestrationContextRef>();
	for (const ref of existingRefs) {
		mergedRefMap.set(ref.ptr, ref);
	}

	const newlyAttachedPtrs: string[] = [];
	let payloadPtr: string | undefined;
	if (rawDetail) {
		const hopRef = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
			kind: 'handoff',
			title: `Hop #${nextHopIndex}: ${token.nodeId} → ${uniqueTargets.join(', ')}`,
			content: rawDetail,
			authorNodeId: token.nodeId,
			authorAgentId: token.holderAgentId,
			hop: nextHopIndex,
			waveId: token.waveId,
			now,
		});
		payloadPtr = hopRef.ptr;
		mergedRefMap.set(hopRef.ptr, hopRef);
	}

	for (const art of params.artifacts ?? []) {
		if (art.content.trim()) {
			const ref = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
				kind: 'artifact',
				title: art.title || `Artifact from ${token.nodeId}`,
				content: art.content,
				authorNodeId: token.nodeId,
				authorAgentId: token.holderAgentId,
				hop: nextHopIndex,
				waveId: token.waveId,
				now,
			});
			mergedRefMap.set(ref.ptr, ref);
			newlyAttachedPtrs.push(ref.ptr);
		}
	}

	for (const dec of params.decisions ?? []) {
		if (dec.content.trim()) {
			const ref = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
				kind: 'decision',
				title: dec.title || `Decision by ${token.nodeId}`,
				content: dec.content,
				authorNodeId: token.nodeId,
				authorAgentId: token.holderAgentId,
				hop: nextHopIndex,
				waveId: token.waveId,
				now,
			});
			mergedRefMap.set(ref.ptr, ref);
			newlyAttachedPtrs.push(ref.ptr);
		}
	}

	// Re-pin any explicitly referenced existing pointers from payloadStore or whiteboards
	const extraWhiteboardIds: string[] = [];
	for (const rawPtr of params.refPtrs ?? []) {
		const ptr = rawPtr.trim();
		if (!ptr || mergedRefMap.has(ptr)) {
			continue;
		}
		const blob = payloadStore[ptr];
		if (blob) {
			mergedRefMap.set(ptr, {
				ptr: blob.ptr,
				kind: blob.kind,
				title: blob.title,
				version: 1,
				updatedAtHop: blob.hop,
				...(blob.authorNodeId ? { authorNodeId: blob.authorNodeId } : {}),
				sizeChars: blob.sizeChars,
				digest: blob.digest,
			});
			newlyAttachedPtrs.push(ptr);
			continue;
		}
		const wbId = ptr.startsWith('wb:') ? ptr.slice(3) : ptr;
		if (whiteboards?.[wbId]) {
			extraWhiteboardIds.push(wbId);
		}
	}

	// Merge any newly attached whiteboard pointers with existing pointers (always lightweight metadata only!)
	const newPointers = buildWhiteboardPointers(whiteboards, [...wbCheck.normalizedIds, ...extraWhiteboardIds]);
	const mergedPointerMap = new Map<string, IOrchestrationWhiteboardPointer>();
	for (const p of token.whiteboardPointers ?? []) {
		const latestWb = whiteboards?.[p.whiteboardId];
		mergedPointerMap.set(p.whiteboardId, latestWb
			? { whiteboardId: latestWb.id, department: latestWb.department, title: latestWb.title, version: latestWb.version }
			: p);
	}
	for (const p of newPointers) {
		mergedPointerMap.set(p.whiteboardId, p);
		const liveWb = whiteboards?.[p.whiteboardId];
		const wbRef = liveWb
			? buildWhiteboardContextRef(liveWb, nextHopIndex)
			: { ptr: `wb:${p.whiteboardId}`, kind: 'whiteboard' as const, title: p.title, version: p.version, updatedAtHop: nextHopIndex, department: p.department, sizeChars: 0 };
		mergedRefMap.set(wbRef.ptr, wbRef);
		newlyAttachedPtrs.push(wbRef.ptr);
	}
	const mergedPointers = [...mergedPointerMap.values()];
	const mergedContextRefs = [...mergedRefMap.values()];
	const baseHopLog: readonly IOrchestrationHopLedgerEntry[] = token.hopLog && token.hopLog.length > 0
		? token.hopLog
		: [{
			hop: prevHopIndex,
			tokenId: token.id,
			...(token.fromNodeId ? { fromNodeId: token.fromNodeId } : {}),
			toNodeId: token.nodeId,
			event: token.fromNodeId ? 'handoff' : 'dispatch',
			headline: buildCompactHeadline(token.lastSummary).headline,
			...(token.payloadPtr ? { payloadPtr: token.payloadPtr } : {}),
			timestamp: token.arrivedAt,
		}];

	// Pre-allocate child token IDs so the handing-off employee's cursor records both its seen lineage
	// and its own emitted handoff hops without suppressing unrelated parallel branches in the same wave!
	let tokenSeq = state.tokenSeq;
	let traceSeq = state.traceSeq + 1;
	const handoffTracePtr = `otrc-${traceSeq}`;
	const allocatedTargets = uniqueTargets.map(targetId => {
		tokenSeq += 1;
		traceSeq += 1;
		return {
			targetId,
			childTokenId: `otok-${tokenSeq}`,
			arriveTracePtr: `otrc-${traceSeq}`,
		};
	});
	const uniqueAttachedPtrs = [...new Set(newlyAttachedPtrs)];
	const observedHopIds = [
		...baseHopLog.map(h => buildHopKey(h)),
		...allocatedTargets.map(t => `${t.childTokenId}:${nextHopIndex}`),
	];
	const nextCursors = recordNodeCursorObservation(
		state.nodeReadCursors,
		token.waveId,
		token.nodeId,
		nextHopIndex,
		mergedContextRefs,
		now,
		observedHopIds,
	);
	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[token.id]: {
			...token,
			status: 'handed_off',
			blocked: undefined,
			lastActivityAt: now,
			handedOffToNodeIds: uniqueTargets,
		},
	};
	const nextTraces: Record<string, IMissionTraceNode> = {
		...state.traces,
		[handoffTracePtr]: {
			ptr: handoffTracePtr,
			parentPtrs: [token.tracePtr],
			nodeId: token.nodeId,
			employeeId: token.holderAgentId,
			waveId: token.waveId,
			event: 'complete',
			summary: `Handoff -> [${uniqueTargets.join(', ')}]: ${headline}`,
			timestamp: now,
		},
	};

	const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = {
		...state.nodeStates,
		[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
	};
	const effects: OrchestrationEngineEffect[] = [];
	const nextTokenIds: string[] = [];
	const highest = getHighestRankInSchema(config);
	const topStaffId = findHighestRankStaffNode(graph)?.id;

	const previewState: IOrchestrationRuntimeState = {
		...state,
		tokens: nextTokens,
		nodeStates: nextNodeStates,
		traces: nextTraces,
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		nodeReadCursors: nextCursors,
		tokenSeq,
		traceSeq,
		updatedAt: now,
	};

	for (const { targetId, childTokenId, arriveTracePtr } of allocatedTargets) {
		const targetNode = graph.nodes.find(n => n.id === targetId)!;
		const targetAgentId = state.nodeAgentIds[targetId] ?? targetNode.agentId;
		const isDownwardMove = Boolean(holderNode?.tier !== undefined && targetNode.tier !== undefined && targetNode.tier > holderNode.tier);
		const isUpwardMove = Boolean(holderNode?.tier !== undefined && targetNode.tier !== undefined && targetNode.tier < holderNode.tier);
		const inheritedTasks = normalizeBoundTaskIds(params.taskNodeId ?? token.taskNodeId, params.taskNodeIds ?? token.taskNodeIds);

		const hopEntry: IOrchestrationHopLedgerEntry = {
			hop: nextHopIndex,
			tokenId: childTokenId,
			fromNodeId: token.nodeId,
			toNodeId: targetId,
			event: isUpwardMove ? 'return' : 'handoff',
			headline,
			...(payloadPtr ? { payloadPtr } : {}),
			...(uniqueAttachedPtrs.length > 0 ? { attachedRefPtrs: uniqueAttachedPtrs } : {}),
			timestamp: now,
		};

		const childToken: IOrchestrationToken = {
			id: childTokenId,
			waveId: token.waveId,
			nodeId: targetId,
			fromNodeId: token.nodeId,
			holderAgentId: targetAgentId,
			status: 'active',
			parentTokenId: token.id,
			rootTokenId: token.rootTokenId ?? token.id,
			originNodeId: isDownwardMove ? token.nodeId : (token.originNodeId ?? token.nodeId),
			...(isDownwardMove
				? { returnToNodeId: token.nodeId }
				: (!isUpwardMove && token.returnToNodeId ? { returnToNodeId: token.returnToNodeId } : {})),
			dispatchKind: isUpwardMove ? 'return' : 'handoff',
			...inheritedTasks,
			hopIndex: nextHopIndex,
			lastSummary: headline,
			...(payloadPtr ? { payloadPtr } : {}),
			hopLog: [...baseHopLog, hopEntry],
			contextRefs: mergedContextRefs,
			compressedHistory: rolledHistory.text,
			historyState: rolledHistory.state,
			tracePtr: arriveTracePtr,
			...(mergedPointers.length > 0 ? { whiteboardPointers: mergedPointers } : {}),
			arrivedAt: now,
			lastActivityAt: now,
			nudgeCount: 0,
		};
		nextTokens[childTokenId] = childToken;
		nextTraces[arriveTracePtr] = {
			ptr: arriveTracePtr,
			parentPtrs: [handoffTracePtr],
			nodeId: targetId,
			employeeId: targetAgentId,
			waveId: token.waveId,
			event: 'mint',
			summary: headline,
			timestamp: now,
		};
		nextNodeStates[targetId] = recomputeOrchestrationNodeState(nextTokens, targetId);
		nextTokenIds.push(childTokenId);

		const delta = buildOrchestrationTokenDeltaView(previewState, childToken, whiteboards);
		const outgoingStaffIds = graph.edges
			.filter(e => e.from === targetId && graph.nodes.some(n => n.id === e.to && n.kind === 'staff'))
			.map(e => e.to);
		const subordinateTargetIds = outgoingStaffIds.filter(outId => {
			const outNode = graph.nodes.find(n => n.id === outId && n.kind === 'staff');
			return Boolean(outNode && (targetNode.tier === undefined || outNode.tier === undefined || outNode.tier > targetNode.tier));
		});
		const isHighest = targetNode.tier !== undefined ? targetNode.tier === highest.tier : targetId === topStaffId;
		effects.push({
			kind: 'dispatch_token',
			missionId: state.missionId,
			nodeId: targetId,
			tokenId: childTokenId,
			holderAgentId: targetAgentId,
			prompt: composeOrchestrationTokenWakeupPrompt(state.missionId, targetNode, childToken, outgoingStaffIds, isHighest, delta, { subordinateTargetIds }),
		});
	}

	return {
		ok: true,
		state: {
			...state,
			tokens: nextTokens,
			nodeStates: nextNodeStates,
			traces: nextTraces,
			payloadStore,
			payloadSeq: payloadSeqRef.value,
			nodeReadCursors: nextCursors,
			tokenSeq,
			traceSeq,
			updatedAt: now,
		},
		effects,
		data: {
			nextTokenIds,
			handedOffTo: uniqueTargets,
			...(payloadPtr ? { payloadPtr } : {}),
			...(newlyAttachedPtrs.length > 0 ? { attachedRefPtrs: newlyAttachedPtrs } : {}),
		},
	};
}

/**
 * Internal helper that settles a child token into its parent's `IOrchestrationJoinBarrier` and,
 * once the convergence condition (`all` or `any`) is satisfied, restores the waiting superior's
 * baton to `'active'` with consolidated branch summaries + pointers and emits ONE wakeup effect!
 */
function settleJoinBarrierIfApplicable(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly childToken: IOrchestrationToken;
		readonly outcome: IOrchestrationJoinBarrierChildResult['outcome'];
		readonly summary: string;
		readonly payloadPtr?: string;
		readonly attachedRefPtrs?: readonly string[];
		readonly extraContextRefs?: readonly IOrchestrationContextRef[];
		readonly extraWhiteboardPointers?: readonly IOrchestrationWhiteboardPointer[];
		readonly now: number;
	},
): {
	readonly state: IOrchestrationRuntimeState;
	readonly effects: readonly OrchestrationEngineEffect[];
	readonly barrierSatisfied: boolean;
	readonly parentTokenId?: string;
} {
	const barrierId = params.childToken.parentJoinBarrierId;
	if (!barrierId) {
		return { state, effects: [], barrierSatisfied: false };
	}
	const barrier = state.joinBarriers?.[barrierId];
	if (!barrier || barrier.status !== 'waiting') {
		return { state, effects: [], barrierSatisfied: false };
	}
	const childResult: IOrchestrationJoinBarrierChildResult = {
		tokenId: params.childToken.id,
		fromNodeId: params.childToken.nodeId,
		outcome: params.outcome,
		summary: buildCompactHeadline(params.summary).headline,
		...(params.payloadPtr ? { payloadPtr: params.payloadPtr } : (params.childToken.payloadPtr ? { payloadPtr: params.childToken.payloadPtr } : {})),
		...(params.attachedRefPtrs && params.attachedRefPtrs.length > 0 ? { attachedRefPtrs: params.attachedRefPtrs } : {}),
		...(params.childToken.taskNodeId ? { taskNodeId: params.childToken.taskNodeId } : {}),
		settledAt: params.now,
	};
	const nextSettled: Record<string, IOrchestrationJoinBarrierChildResult> = {
		...barrier.settledChildren,
		[params.childToken.id]: childResult,
	};
	const satisfied = barrier.mode === 'any'
		? Object.keys(nextSettled).length >= 1
		: barrier.childTokenIds.every(cid => Boolean(nextSettled[cid]));

	const updatedBarrier: IOrchestrationJoinBarrier = {
		...barrier,
		settledChildren: nextSettled,
		status: satisfied ? 'satisfied' : 'waiting',
		...(satisfied ? { satisfiedAt: params.now } : {}),
	};
	const nextBarriers: Record<string, IOrchestrationJoinBarrier> = {
		...(state.joinBarriers ?? {}),
		[barrier.id]: updatedBarrier,
	};

	if (!satisfied) {
		return {
			state: {
				...state,
				joinBarriers: nextBarriers,
				updatedAt: params.now,
			},
			effects: [],
			barrierSatisfied: false,
			parentTokenId: barrier.parentTokenId,
		};
	}

	const parentToken = state.tokens[barrier.parentTokenId];
	if (!parentToken || parentToken.status !== 'waiting_join') {
		return {
			state: {
				...state,
				joinBarriers: nextBarriers,
				updatedAt: params.now,
			},
			effects: [],
			barrierSatisfied: true,
			parentTokenId: barrier.parentTokenId,
		};
	}

	const now = params.now;
	const nextHop = (parentToken.hopIndex ?? Math.max(0, (parentToken.hopLog?.length ?? 1) - 1)) + 1;
	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const settledEntries = barrier.childTokenIds
		.map(cid => nextSettled[cid])
		.filter((r): r is IOrchestrationJoinBarrierChildResult => Boolean(r));
	const convergenceLines = settledEntries.map(r =>
		`- ${r.tokenId} (${r.fromNodeId}, ${r.outcome}${r.taskNodeId ? `, task:${r.taskNodeId}` : ''}): ${r.summary}${r.payloadPtr ? ` [detail:${r.payloadPtr}]` : ''}`,
	);
	const convergenceSummary = buildCompactHeadline(
		`Join barrier ${barrier.id} satisfied (${settledEntries.length}/${barrier.childTokenIds.length}): ${settledEntries.map(r => `${r.fromNodeId}=${r.outcome}`).join(', ')}`,
	).headline;
	const convergenceRef = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
		kind: 'handoff',
		title: `Join Barrier ${barrier.id} Convergence (${settledEntries.length} branches)`,
		content: convergenceLines.join('\n'),
		authorNodeId: barrier.ownerNodeId,
		hop: nextHop,
		waveId: parentToken.waveId,
		now,
	});

	// Consolidate lightweight pointers from parent + all settled children (NEVER inline body text!)
	const refMap = new Map<string, IOrchestrationContextRef>();
	for (const ref of refreshContextRefsWithLiveWhiteboards(parentToken.contextRefs, whiteboards, parentToken.whiteboardPointers, nextHop)) {
		refMap.set(ref.ptr, ref);
	}
	refMap.set(convergenceRef.ptr, convergenceRef);
	for (const cid of barrier.childTokenIds) {
		const cTok = state.tokens[cid];
		for (const ref of cTok?.contextRefs ?? []) {
			refMap.set(ref.ptr, ref);
		}
	}
	for (const ref of params.extraContextRefs ?? []) {
		refMap.set(ref.ptr, ref);
	}

	const wbMap = new Map<string, IOrchestrationWhiteboardPointer>();
	for (const wp of parentToken.whiteboardPointers ?? []) {
		wbMap.set(wp.whiteboardId, wp);
	}
	for (const cid of barrier.childTokenIds) {
		const cTok = state.tokens[cid];
		for (const wp of cTok?.whiteboardPointers ?? []) {
			wbMap.set(wp.whiteboardId, wp);
		}
	}
	for (const wp of params.extraWhiteboardPointers ?? []) {
		wbMap.set(wp.whiteboardId, wp);
	}

	const mergedRefs = [...refMap.values()];
	const mergedWbs = [...wbMap.values()];
	const traceSeq = state.traceSeq + 1;
	const resumeTracePtr = `otrc-${traceSeq}`;
	const resumeHop: IOrchestrationHopLedgerEntry = {
		hop: nextHop,
		tokenId: parentToken.id,
		fromNodeId: params.childToken.nodeId,
		toNodeId: parentToken.nodeId,
		event: 'join_resume',
		headline: convergenceSummary,
		payloadPtr: convergenceRef.ptr,
		timestamp: now,
	};
	const resumedParent: IOrchestrationToken = {
		...parentToken,
		status: 'active',
		joinBarrierId: undefined,
		hopIndex: nextHop,
		lastSummary: convergenceSummary,
		payloadPtr: convergenceRef.ptr,
		hopLog: [...(parentToken.hopLog ?? []), resumeHop],
		contextRefs: mergedRefs,
		...(mergedWbs.length > 0 ? { whiteboardPointers: mergedWbs } : {}),
		lastActivityAt: now,
		lastNudgeAt: undefined,
		nudgeCount: 0,
	};
	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[parentToken.id]: resumedParent,
	};
	const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = {
		...state.nodeStates,
		[parentToken.nodeId]: recomputeOrchestrationNodeState(nextTokens, parentToken.nodeId),
	};
	const nextTraces: Record<string, IMissionTraceNode> = {
		...state.traces,
		[resumeTracePtr]: {
			ptr: resumeTracePtr,
			parentPtrs: [parentToken.tracePtr, ...barrier.childTokenIds.map(cid => state.tokens[cid]?.tracePtr).filter((p): p is string => Boolean(p))],
			nodeId: parentToken.nodeId,
			employeeId: state.nodeAgentIds[parentToken.nodeId] ?? parentToken.holderAgentId,
			waveId: parentToken.waveId,
			event: 'mint',
			summary: convergenceSummary,
			timestamp: now,
		},
	};
	const nextState: IOrchestrationRuntimeState = {
		...state,
		tokens: nextTokens,
		nodeStates: nextNodeStates,
		traces: nextTraces,
		joinBarriers: nextBarriers,
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		traceSeq,
		updatedAt: now,
	};

	const effects: OrchestrationEngineEffect[] = [];
	const ownerNode = graph.nodes.find(n => n.id === parentToken.nodeId && n.kind === 'staff');
	if (ownerNode) {
		const delta = buildOrchestrationTokenDeltaView(nextState, resumedParent, whiteboards);
		const outgoingStaffIds = graph.edges
			.filter(e => e.from === ownerNode.id && graph.nodes.some(n => n.id === e.to && n.kind === 'staff'))
			.map(e => e.to);
		const subordinateTargetIds = outgoingStaffIds.filter(outId => {
			const outNode = graph.nodes.find(n => n.id === outId && n.kind === 'staff');
			return Boolean(outNode && (ownerNode.tier === undefined || outNode.tier === undefined || outNode.tier > ownerNode.tier));
		});
		const highest = getHighestRankInSchema(config);
		const isHighest = ownerNode.tier !== undefined ? ownerNode.tier === highest.tier : ownerNode.id === findHighestRankStaffNode(graph)?.id;
		effects.push({
			kind: 'dispatch_token',
			missionId: state.missionId,
			nodeId: ownerNode.id,
			tokenId: resumedParent.id,
			holderAgentId: state.nodeAgentIds[ownerNode.id] ?? resumedParent.holderAgentId,
			prompt: composeOrchestrationTokenWakeupPrompt(state.missionId, ownerNode, resumedParent, outgoingStaffIds, isHighest, delta, {
				convergedBarrier: updatedBarrier,
				subordinateTargetIds,
			}),
		});
	}

	return {
		state: nextState,
		effects,
		barrierSatisfied: true,
		parentTokenId: parentToken.id,
	};
}

/**
 * Active Minting & Heterogeneous Sub-Task Token Splitting + Optional Join/Convergence Barrier:
 * - Allows a superior holding an active baton to mint 1..N distinct sub-task tokens to lower-tier
 *   subordinates, each carrying its OWN summary, detail pointer, bound Mission DAG `taskNodeId`,
 *   artifacts, decisions, and whiteboards.
 * - STRICTLY enforces downward-only minting (`targetNode.tier > parentNode.tier`): subordinates
 *   and peers are forbidden from minting brand-new tokens upward (`UPWARD_MINT_FORBIDDEN`).
 * - When `waitJoin !== true`, the superior retains its own `'active'` baton so it can sequentially
 *   mint additional heterogeneous tokens to other subordinates!
 * - When `waitJoin === true`, creates an `IOrchestrationJoinBarrier` and transitions the superior's
 *   baton to `'waiting_join'` until all (or any) children return/complete/fail/reclaim.
 */
export function mintOrchestrationTokens(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		/** Existing active parent token ID, or omit / `'root'` / `'new'` to auto-create a root wave owned by the calling superior (e.g. after a direct User Chat message!). */
		readonly parentTokenId?: string;
		/** Optional originating staff node ID when auto-creating a root parent token (defaults to caller's bound staff node or highest-rank staff node for Human/Secretary). */
		readonly fromNodeId?: string;
		/** Optional 1-line summary for an auto-created root parent wave. */
		readonly waveSummary?: string;
		readonly branches: readonly IOrchestrationMintBranch[];
		readonly waitJoin?: boolean;
		readonly joinMode?: 'all' | 'any';
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly callerAgentId?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{
	readonly parentTokenId: string;
	readonly mintedTokenIds: readonly string[];
	readonly joinBarrierId?: string;
	readonly createdRootParent?: boolean;
	readonly branches: readonly { readonly tokenId: string; readonly toNodeId: string; readonly taskNodeId?: string; readonly payloadPtr?: string }[];
}> {
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before minting tokens.' };
	}
	if (graph.error) {
		return { ok: false, state, effects: [], code: 'INVALID_GRAPH', error: graph.error };
	}
	if (!params.branches || params.branches.length === 0) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'At least one sub-task branch is required to mint tokens.' };
	}

	const rawParentId = params.parentTokenId?.trim() ?? '';
	const shouldCreateRootParent = !rawParentId || rawParentId.toLowerCase() === 'root' || rawParentId.toLowerCase() === 'new';

	let parentNode: IOrchestrationGraphNode | undefined;
	let existingParentToken: IOrchestrationToken | undefined;

	if (!shouldCreateRootParent) {
		existingParentToken = state.tokens[rawParentId];
		if (!existingParentToken || (existingParentToken.status !== 'active' && existingParentToken.status !== 'blocked')) {
			return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active parent Orchestration token "${rawParentId}" not found.` };
		}
		if (params.callerAgentId !== undefined) {
			const boundHolder = state.nodeAgentIds[existingParentToken.nodeId] ?? existingParentToken.holderAgentId;
			if (boundHolder && boundHolder !== params.callerAgentId) {
				return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `Token "${rawParentId}" is held by "${boundHolder}", not caller "${params.callerAgentId}".` };
			}
		}
		parentNode = graph.nodes.find(n => n.id === existingParentToken!.nodeId && n.kind === 'staff');
		if (!parentNode) {
			return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Parent staff node "${existingParentToken.nodeId}" not found on Orchestration canvas.` };
		}
	} else {
		const requestedFrom = params.fromNodeId?.trim();
		if (params.callerAgentId !== undefined) {
			const boundNodeId = Object.entries(state.nodeAgentIds).find(([, aid]) => aid === params.callerAgentId)?.[0]
				?? graph.nodes.find(n => n.kind === 'staff' && n.agentId === params.callerAgentId)?.id;
			if (!boundNodeId) {
				return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `Caller "${params.callerAgentId}" is not bound to any staff node on the Orchestration canvas.` };
			}
			if (requestedFrom && requestedFrom !== boundNodeId) {
				return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `FORBIDDEN: caller "${params.callerAgentId}" (staff "${boundNodeId}") cannot mint root tokens on behalf of "${requestedFrom}".` };
			}
			parentNode = graph.nodes.find(n => n.id === boundNodeId && n.kind === 'staff');
		} else {
			parentNode = requestedFrom
				? graph.nodes.find(n => n.id === requestedFrom && n.kind === 'staff')
				: findHighestRankStaffNode(graph);
		}
		if (!parentNode) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'NOT_FOUND',
				error: requestedFrom
					? `Originating staff node "${requestedFrom}" not found on Orchestration canvas.`
					: 'No staff nodes exist on the Orchestration canvas to originate tokens.',
			};
		}
	}

	const parentTier = resolveEffectiveStaffTier(parentNode, config);
	const parentRank = parentTier !== undefined ? config.ranks.find(r => r.tier === parentTier) : undefined;
	if (parentRank && (parentRank.pureExecution || !parentRank.canHaveSubordinates)) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'UPWARD_MINT_FORBIDDEN',
			error: `UPWARD_MINT_FORBIDDEN: leaf execution staff "${parentNode.id}" (L${parentRank.tier} ${parentRank.name}) cannot mint new downward tokens. Use "token return" or "token handoff" along existing edges.`,
		};
	}
	const validOutgoing = new Set(graph.edges.filter(e => e.from === parentNode.id).map(e => e.to));
	const normalizedBranchWbIds: (readonly string[])[] = [];

	// Atomic pre-validation of EVERY branch before mutating any state!
	for (let i = 0; i < params.branches.length; i++) {
		const branch = params.branches[i];
		const targetId = branch.toNodeId?.trim();
		const summary = branch.summary?.trim();
		if (!targetId) {
			return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Branch #${i + 1} is missing target staff node "toNodeId".` };
		}
		if (!summary) {
			return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Branch #${i + 1} (-> "${targetId}") is missing a concise "summary".` };
		}
		if (targetId === parentNode.id) {
			return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Staff node "${parentNode.id}" cannot mint a child token to itself.` };
		}
		const targetNode = graph.nodes.find(n => n.id === targetId && n.kind === 'staff');
		if (!targetNode) {
			return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Target staff node "${targetId}" does not exist on Orchestration canvas.` };
		}
		if (!validOutgoing.has(targetId)) {
			const available = [...validOutgoing].filter(id => graph.nodes.some(n => n.id === id && n.kind === 'staff'));
			return {
				ok: false,
				state,
				effects: [],
				code: 'NO_EDGE',
				error: `No directed edge from "${parentNode.id}" to "${targetId}" in Orchestration graph. Connected targets: ${available.length > 0 ? available.join(', ') : '(none)'}.`,
			};
		}
		// Strict hierarchy rule: newly minted tokens may ONLY be sent downward to strictly lower-tier subordinates!
		const targetTier = resolveEffectiveStaffTier(targetNode, config);
		if (parentTier !== undefined && targetTier !== undefined && targetTier <= parentTier) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'UPWARD_MINT_FORBIDDEN',
				error: `UPWARD_MINT_FORBIDDEN: staff "${parentNode.id}" (L${parentTier}) may only mint new tokens downward to strictly lower-tier subordinates, not to "${targetId}" (L${targetTier}). Use "token return" to reply upward on a received token.`,
			};
		}
		const wbCheck = validateTokenWhiteboardAttachments(
			graph,
			whiteboards,
			config,
			{ callerNodeId: parentNode.id, callerTier: parentTier },
			branch.whiteboardIds,
			branch.refPtrs,
		);
		if (!wbCheck.ok) {
			return { ok: false, state, effects: [], code: wbCheck.code ?? 'INVALID_STATE', error: wbCheck.error };
		}
		normalizedBranchWbIds.push(wbCheck.normalizedIds);
		const branchExplicitTasks = [...new Set([
			...(branch.taskNodeId?.trim() ? [branch.taskNodeId.trim()] : []),
			...(branch.taskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
		])];
		const taskCheck = validateTokenTaskBindings(params.taskGraph, params.taskStatuses, branchExplicitTasks);
		if (!taskCheck.ok) {
			return { ok: false, state, effects: [], code: taskCheck.code ?? 'INVALID_STATE', error: taskCheck.error };
		}
	}

	const now = params.now ?? Date.now();
	let waveSeq = state.waveSeq;
	let tokenSeq = state.tokenSeq;
	let traceSeq = state.traceSeq;
	const nextTraces: Record<string, IMissionTraceNode> = { ...state.traces };

	let parentToken: IOrchestrationToken;
	if (existingParentToken) {
		parentToken = existingParentToken;
	} else {
		waveSeq += 1;
		tokenSeq += 1;
		traceSeq += 1;
		const waveId = `wave-${waveSeq}`;
		const synthParentId = `otok-${tokenSeq}`;
		const synthTracePtr = `otrc-${traceSeq}`;
		const synthAgentId = state.nodeAgentIds[parentNode.id] ?? parentNode.agentId;
		const defaultWaveSummary = params.waveSummary?.trim()
			|| (params.branches.length === 1
				? `Delegated to ${params.branches[0].toNodeId.trim()}: ${params.branches[0].summary.trim()}`
				: `Split into ${params.branches.length} branches (${params.branches.map(b => b.toNodeId.trim()).join(', ')})`);
		const synthHeadline = buildCompactHeadline(defaultWaveSummary).headline;
		parentToken = {
			id: synthParentId,
			waveId,
			nodeId: parentNode.id,
			holderAgentId: synthAgentId,
			status: 'active',
			rootTokenId: synthParentId,
			originNodeId: 'User',
			dispatchKind: 'dispatch',
			hopIndex: 0,
			lastSummary: synthHeadline,
			hopLog: [{
				hop: 0,
				tokenId: synthParentId,
				toNodeId: parentNode.id,
				event: 'dispatch',
				headline: synthHeadline,
				timestamp: now,
			}],
			contextRefs: [],
			compressedHistory: '',
			tracePtr: synthTracePtr,
			arrivedAt: now,
			lastActivityAt: now,
			nudgeCount: 0,
		};
		nextTraces[synthTracePtr] = {
			ptr: synthTracePtr,
			parentPtrs: [],
			nodeId: parentNode.id,
			employeeId: synthAgentId,
			waveId,
			event: 'mint',
			summary: synthHeadline,
			timestamp: now,
		};
	}

	const prevHopIndex = parentToken.hopIndex ?? Math.max(0, (parentToken.hopLog?.length ?? 1) - 1);
	const nextHopIndex = prevHopIndex + 1;
	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const parentBaseRefs = refreshContextRefsWithLiveWhiteboards(parentToken.contextRefs, whiteboards, parentToken.whiteboardPointers, nextHopIndex);
	const baseHopLog: readonly IOrchestrationHopLedgerEntry[] = parentToken.hopLog && parentToken.hopLog.length > 0
		? parentToken.hopLog
		: [{
			hop: prevHopIndex,
			tokenId: parentToken.id,
			...(parentToken.fromNodeId ? { fromNodeId: parentToken.fromNodeId } : {}),
			toNodeId: parentToken.nodeId,
			event: parentToken.fromNodeId ? 'handoff' : 'dispatch',
			headline: buildCompactHeadline(parentToken.lastSummary).headline,
			...(parentToken.payloadPtr ? { payloadPtr: parentToken.payloadPtr } : {}),
			timestamp: parentToken.arrivedAt,
		}];

	let barrierSeq = state.barrierSeq ?? 0;
	let joinBarrierId: string | undefined;
	if (params.waitJoin) {
		barrierSeq += 1;
		joinBarrierId = `bar-${barrierSeq}`;
	}

	const allocated = params.branches.map((branch, idx) => {
		tokenSeq += 1;
		traceSeq += 1;
		return {
			branch,
			normalizedWbIds: normalizedBranchWbIds[idx] ?? [],
			targetId: branch.toNodeId.trim(),
			childTokenId: `otok-${tokenSeq}`,
			tracePtr: `otrc-${traceSeq}`,
		};
	});

	const mintedTokenIds = allocated.map(a => a.childTokenId);
	const existingChildIds = parentToken.childTokenIds ?? [];
	const updatedParentToken: IOrchestrationToken = {
		...parentToken,
		status: params.waitJoin ? 'waiting_join' : 'active',
		blocked: undefined,
		...(joinBarrierId ? { joinBarrierId } : {}),
		childTokenIds: [...existingChildIds, ...mintedTokenIds],
		lastActivityAt: now,
	};

	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[parentToken.id]: updatedParentToken,
	};
	const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = { ...state.nodeStates };
	const nextBarriers: Record<string, IOrchestrationJoinBarrier> = { ...(state.joinBarriers ?? {}) };
	if (joinBarrierId) {
		nextBarriers[joinBarrierId] = {
			id: joinBarrierId,
			waveId: parentToken.waveId,
			parentTokenId: parentToken.id,
			ownerNodeId: parentToken.nodeId,
			childTokenIds: mintedTokenIds,
			mode: params.joinMode === 'any' ? 'any' : 'all',
			status: 'waiting',
			settledChildren: {},
			createdAt: now,
		};
	}

	const allParentObservedRefs = new Map<string, IOrchestrationContextRef>();
	for (const ref of parentBaseRefs) {
		allParentObservedRefs.set(ref.ptr, ref);
	}
	const observedHopIds = [
		...baseHopLog.map(h => buildHopKey(h)),
		...allocated.map(a => `${a.childTokenId}:${nextHopIndex}`),
	];

	const branchResults: { readonly tokenId: string; readonly toNodeId: string; readonly taskNodeId?: string; readonly payloadPtr?: string }[] = [];
	const pendingDispatches: { readonly targetNode: IOrchestrationGraphNode; readonly childToken: IOrchestrationToken; readonly targetAgentId?: string }[] = [];

	for (const item of allocated) {
		const { branch, targetId, childTokenId, tracePtr } = item;
		const targetNode = graph.nodes.find(n => n.id === targetId)!;
		const targetAgentId = state.nodeAgentIds[targetId] ?? targetNode.agentId;
		const { headline, wasTruncated } = buildCompactHeadline(branch.summary);
		const rawDetail = branch.detail?.trim() || (wasTruncated ? branch.summary.trim() : '');
		const rolledHistory = compressTokenHistoryState(parentToken.historyState, parentToken.compressedHistory, parentToken.lastSummary, parentToken.fromNodeId);

		const mergedRefMap = new Map<string, IOrchestrationContextRef>();
		for (const ref of parentBaseRefs) {
			mergedRefMap.set(ref.ptr, ref);
		}
		const newlyAttachedPtrs: string[] = [];
		let payloadPtr: string | undefined;
		if (rawDetail) {
			const hopRef = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
				kind: 'handoff',
				title: `Mint #${nextHopIndex}: ${parentToken.nodeId} → ${targetId}`,
				content: rawDetail,
				authorNodeId: parentToken.nodeId,
				authorAgentId: parentToken.holderAgentId,
				hop: nextHopIndex,
				waveId: parentToken.waveId,
				now,
			});
			payloadPtr = hopRef.ptr;
			mergedRefMap.set(hopRef.ptr, hopRef);
			allParentObservedRefs.set(hopRef.ptr, hopRef);
		}
		for (const art of branch.artifacts ?? []) {
			if (art.content.trim()) {
				const ref = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
					kind: 'artifact',
					title: art.title || `Artifact from ${parentToken.nodeId}`,
					content: art.content,
					authorNodeId: parentToken.nodeId,
					authorAgentId: parentToken.holderAgentId,
					hop: nextHopIndex,
					waveId: parentToken.waveId,
					now,
				});
				mergedRefMap.set(ref.ptr, ref);
				allParentObservedRefs.set(ref.ptr, ref);
				newlyAttachedPtrs.push(ref.ptr);
			}
		}
		for (const dec of branch.decisions ?? []) {
			if (dec.content.trim()) {
				const ref = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
					kind: 'decision',
					title: dec.title || `Decision by ${parentToken.nodeId}`,
					content: dec.content,
					authorNodeId: parentToken.nodeId,
					authorAgentId: parentToken.holderAgentId,
					hop: nextHopIndex,
					waveId: parentToken.waveId,
					now,
				});
				mergedRefMap.set(ref.ptr, ref);
				allParentObservedRefs.set(ref.ptr, ref);
				newlyAttachedPtrs.push(ref.ptr);
			}
		}
		const extraWbIds: string[] = [];
		for (const rawPtr of branch.refPtrs ?? []) {
			const ptr = rawPtr.trim();
			if (!ptr || mergedRefMap.has(ptr)) {
				continue;
			}
			const blob = payloadStore[ptr];
			if (blob) {
				mergedRefMap.set(ptr, {
					ptr: blob.ptr,
					kind: blob.kind,
					title: blob.title,
					version: 1,
					updatedAtHop: blob.hop,
					...(blob.authorNodeId ? { authorNodeId: blob.authorNodeId } : {}),
					sizeChars: blob.sizeChars,
					digest: blob.digest,
				});
				newlyAttachedPtrs.push(ptr);
				continue;
			}
			const wbId = ptr.startsWith('wb:') ? ptr.slice(3) : ptr;
			if (whiteboards?.[wbId]) {
				extraWbIds.push(wbId);
			}
		}
		const newPointers = buildWhiteboardPointers(whiteboards, [...item.normalizedWbIds, ...extraWbIds]);
		const mergedPointerMap = new Map<string, IOrchestrationWhiteboardPointer>();
		for (const p of parentToken.whiteboardPointers ?? []) {
			const liveWb = whiteboards?.[p.whiteboardId];
			mergedPointerMap.set(p.whiteboardId, liveWb
				? { whiteboardId: liveWb.id, department: liveWb.department, title: liveWb.title, version: liveWb.version }
				: p);
		}
		for (const p of newPointers) {
			mergedPointerMap.set(p.whiteboardId, p);
			const liveWb = whiteboards?.[p.whiteboardId];
			const wbRef = liveWb
				? buildWhiteboardContextRef(liveWb, nextHopIndex)
				: { ptr: `wb:${p.whiteboardId}`, kind: 'whiteboard' as const, title: p.title, version: p.version, updatedAtHop: nextHopIndex, department: p.department, sizeChars: 0 };
			mergedRefMap.set(wbRef.ptr, wbRef);
			allParentObservedRefs.set(wbRef.ptr, wbRef);
			newlyAttachedPtrs.push(wbRef.ptr);
		}

		const boundTasks = normalizeBoundTaskIds(branch.taskNodeId ?? parentToken.taskNodeId, branch.taskNodeIds ?? parentToken.taskNodeIds);
		const uniqueAttached = [...new Set(newlyAttachedPtrs)];
		const hopEntry: IOrchestrationHopLedgerEntry = {
			hop: nextHopIndex,
			tokenId: childTokenId,
			fromNodeId: parentToken.nodeId,
			toNodeId: targetId,
			event: 'mint',
			headline,
			...(payloadPtr ? { payloadPtr } : {}),
			...(uniqueAttached.length > 0 ? { attachedRefPtrs: uniqueAttached } : {}),
			timestamp: now,
		};

		const childToken: IOrchestrationToken = {
			id: childTokenId,
			waveId: parentToken.waveId,
			nodeId: targetId,
			fromNodeId: parentToken.nodeId,
			holderAgentId: targetAgentId,
			status: 'active',
			parentTokenId: parentToken.id,
			rootTokenId: parentToken.rootTokenId ?? parentToken.id,
			originNodeId: parentToken.nodeId,
			returnToNodeId: parentToken.nodeId,
			dispatchKind: 'mint',
			...(joinBarrierId ? { parentJoinBarrierId: joinBarrierId } : {}),
			...boundTasks,
			hopIndex: nextHopIndex,
			lastSummary: headline,
			...(payloadPtr ? { payloadPtr } : {}),
			hopLog: [...baseHopLog, hopEntry],
			contextRefs: [...mergedRefMap.values()],
			compressedHistory: rolledHistory.text,
			historyState: rolledHistory.state,
			tracePtr,
			...(mergedPointerMap.size > 0 ? { whiteboardPointers: [...mergedPointerMap.values()] } : {}),
			arrivedAt: now,
			lastActivityAt: now,
			nudgeCount: 0,
		};

		nextTokens[childTokenId] = childToken;
		nextTraces[tracePtr] = {
			ptr: tracePtr,
			parentPtrs: [parentToken.tracePtr],
			nodeId: targetId,
			employeeId: targetAgentId,
			waveId: parentToken.waveId,
			event: 'mint',
			summary: `Mint -> ${targetId}: ${headline}`,
			timestamp: now,
		};
		nextNodeStates[targetId] = recomputeOrchestrationNodeState(nextTokens, targetId);
		branchResults.push({
			tokenId: childTokenId,
			toNodeId: targetId,
			...(boundTasks.taskNodeId ? { taskNodeId: boundTasks.taskNodeId } : {}),
			...(payloadPtr ? { payloadPtr } : {}),
		});
		pendingDispatches.push({ targetNode, childToken, targetAgentId });
	}

	nextNodeStates[parentToken.nodeId] = recomputeOrchestrationNodeState(nextTokens, parentToken.nodeId);
	const nextCursors = recordNodeCursorObservation(
		state.nodeReadCursors,
		parentToken.waveId,
		parentToken.nodeId,
		nextHopIndex,
		[...allParentObservedRefs.values()],
		now,
		observedHopIds,
	);

	const nextState: IOrchestrationRuntimeState = {
		...state,
		status: 'running',
		pausedAt: undefined,
		pausedReason: undefined,
		tokens: nextTokens,
		nodeStates: nextNodeStates,
		traces: nextTraces,
		joinBarriers: nextBarriers,
		barrierSeq,
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		nodeReadCursors: nextCursors,
		waveSeq,
		tokenSeq,
		traceSeq,
		updatedAt: now,
	};

	const effects: OrchestrationEngineEffect[] = [];
	const highest = getHighestRankInSchema(config);
	const topStaffId = findHighestRankStaffNode(graph)?.id;
	for (const { targetNode, childToken, targetAgentId } of pendingDispatches) {
		const delta = buildOrchestrationTokenDeltaView(nextState, childToken, whiteboards);
		const outgoingStaffIds = graph.edges
			.filter(e => e.from === targetNode.id && graph.nodes.some(n => n.id === e.to && n.kind === 'staff'))
			.map(e => e.to);
		const subordinateTargetIds = outgoingStaffIds.filter(outId => {
			const outNode = graph.nodes.find(n => n.id === outId && n.kind === 'staff');
			return Boolean(outNode && (targetNode.tier === undefined || outNode.tier === undefined || outNode.tier > targetNode.tier));
		});
		const isHighest = targetNode.tier !== undefined ? targetNode.tier === highest.tier : targetNode.id === topStaffId;
		effects.push({
			kind: 'dispatch_token',
			missionId: state.missionId,
			nodeId: targetNode.id,
			tokenId: childToken.id,
			holderAgentId: targetAgentId,
			prompt: composeOrchestrationTokenWakeupPrompt(state.missionId, targetNode, childToken, outgoingStaffIds, isHighest, delta, { subordinateTargetIds }),
		});
	}

	return {
		ok: true,
		state: nextState,
		effects,
		data: {
			parentTokenId: parentToken.id,
			mintedTokenIds,
			...(joinBarrierId ? { joinBarrierId } : {}),
			...(shouldCreateRootParent ? { createdRootParent: true } : {}),
			branches: branchResults,
		},
	};
}

/**
 * Dedicated subordinate upward return (`token return`):
 * - Allows a subordinate who received a downward baton to return its completed result (and lightweight
 *   detail/artifact/decision/whiteboard pointers) back to the dispatching superior.
 * - If this token reports into an active `waiting_join` barrier, settles the barrier cleanly and wakes
 *   the waiting superior ONCE when all branches converge!
 * - Otherwise, sends a `dispatchKind: 'return'` baton directly back to the superior!
 */
export function returnOrchestrationToken(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly tokenId: string;
		readonly toNodeId?: string;
		readonly summary: string;
		readonly detail?: string;
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
		readonly refPtrs?: readonly string[];
		readonly modifiedFiles?: readonly string[];
		readonly callerAgentId?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{
	readonly returnedToNodeId: string;
	readonly returnedTokenId?: string;
	readonly barrierId?: string;
	readonly barrierSatisfied?: boolean;
	readonly payloadPtr?: string;
	readonly attachedRefPtrs?: readonly string[];
}> {
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before returning tokens.' };
	}
	if (graph.error) {
		return { ok: false, state, effects: [], code: 'INVALID_GRAPH', error: graph.error };
	}
	const token = state.tokens[params.tokenId];
	if (!token || (token.status !== 'active' && token.status !== 'blocked')) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active Orchestration token "${params.tokenId}" not found.` };
	}
	if (params.callerAgentId !== undefined) {
		const boundHolder = state.nodeAgentIds[token.nodeId] ?? token.holderAgentId;
		if (boundHolder && boundHolder !== params.callerAgentId) {
			return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `Token "${params.tokenId}" is held by "${boundHolder}", not caller "${params.callerAgentId}".` };
		}
	}
	const summary = params.summary.trim();
	if (!summary) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'A concise return --summary is required.' };
	}

	const activeBarrier = token.parentJoinBarrierId ? state.joinBarriers?.[token.parentJoinBarrierId] : undefined;
	const targetId = params.toNodeId?.trim()
		|| (activeBarrier?.status === 'waiting' ? activeBarrier.ownerNodeId : undefined)
		|| token.returnToNodeId
		|| (token.originNodeId && token.originNodeId !== 'User' ? token.originNodeId : undefined)
		|| token.fromNodeId;
	if (!targetId || targetId === token.nodeId) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Token "${token.id}" has no upstream superior return target; use "token complete --finish" or specify --to.` };
	}
	const targetNode = graph.nodes.find(n => n.id === targetId && n.kind === 'staff');
	if (!targetNode) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Return target staff node "${targetId}" does not exist on Orchestration canvas.` };
	}
	if (!hasDownwardLineageFrom(token, targetId) && activeBarrier?.ownerNodeId !== targetId) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'UPWARD_TOKEN_FORBIDDEN',
			error: `UPWARD_TOKEN_FORBIDDEN: "${token.nodeId}" can only return token "${token.id}" to a superior in its dispatch lineage, not to "${targetId}".`,
		};
	}
	const holderNode = graph.nodes.find(n => n.id === token.nodeId && n.kind === 'staff');
	const returnPathCheck = validateStaffAllowedPaths(holderNode, params.modifiedFiles);
	if (!returnPathCheck.ok) {
		return { ok: false, state, effects: [], code: 'ALLOWED_PATHS_VIOLATION', error: returnPathCheck.error };
	}
	const wbCheck = validateTokenWhiteboardAttachments(
		graph,
		whiteboards,
		config,
		{ callerNodeId: token.nodeId, callerTier: resolveEffectiveStaffTier(holderNode, config) },
		params.whiteboardIds,
		params.refPtrs,
	);
	if (!wbCheck.ok) {
		return { ok: false, state, effects: [], code: wbCheck.code ?? 'INVALID_STATE', error: wbCheck.error };
	}

	const now = params.now ?? Date.now();
	const prevHopIndex = token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1);
	const nextHopIndex = prevHopIndex + 1;
	const { headline, wasTruncated } = buildCompactHeadline(summary);
	const rawDetail = params.detail?.trim() || (wasTruncated ? summary : '');
	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const existingRefs = refreshContextRefsWithLiveWhiteboards(token.contextRefs, whiteboards, token.whiteboardPointers, nextHopIndex);
	const mergedRefMap = new Map<string, IOrchestrationContextRef>();
	for (const ref of existingRefs) {
		mergedRefMap.set(ref.ptr, ref);
	}
	const newlyAttachedPtrs: string[] = [];
	let payloadPtr: string | undefined;
	if (rawDetail) {
		const hopRef = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
			kind: 'handoff',
			title: `Return #${nextHopIndex}: ${token.nodeId} → ${targetId}`,
			content: rawDetail,
			authorNodeId: token.nodeId,
			authorAgentId: token.holderAgentId,
			hop: nextHopIndex,
			waveId: token.waveId,
			now,
		});
		payloadPtr = hopRef.ptr;
		mergedRefMap.set(hopRef.ptr, hopRef);
	}
	for (const art of params.artifacts ?? []) {
		if (art.content.trim()) {
			const ref = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
				kind: 'artifact',
				title: art.title || `Artifact from ${token.nodeId}`,
				content: art.content,
				authorNodeId: token.nodeId,
				authorAgentId: token.holderAgentId,
				hop: nextHopIndex,
				waveId: token.waveId,
				now,
			});
			mergedRefMap.set(ref.ptr, ref);
			newlyAttachedPtrs.push(ref.ptr);
		}
	}
	for (const dec of params.decisions ?? []) {
		if (dec.content.trim()) {
			const ref = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
				kind: 'decision',
				title: dec.title || `Decision by ${token.nodeId}`,
				content: dec.content,
				authorNodeId: token.nodeId,
				authorAgentId: token.holderAgentId,
				hop: nextHopIndex,
				waveId: token.waveId,
				now,
			});
			mergedRefMap.set(ref.ptr, ref);
			newlyAttachedPtrs.push(ref.ptr);
		}
	}
	const extraWbIds: string[] = [];
	for (const rawPtr of params.refPtrs ?? []) {
		const ptr = rawPtr.trim();
		if (!ptr || mergedRefMap.has(ptr)) { continue; }
		const blob = payloadStore[ptr];
		if (blob) {
			mergedRefMap.set(ptr, {
				ptr: blob.ptr,
				kind: blob.kind,
				title: blob.title,
				version: 1,
				updatedAtHop: blob.hop,
				...(blob.authorNodeId ? { authorNodeId: blob.authorNodeId } : {}),
				sizeChars: blob.sizeChars,
				digest: blob.digest,
			});
			newlyAttachedPtrs.push(ptr);
			continue;
		}
		const wbId = ptr.startsWith('wb:') ? ptr.slice(3) : ptr;
		if (whiteboards?.[wbId]) { extraWbIds.push(wbId); }
	}
	const newPointers = buildWhiteboardPointers(whiteboards, [...wbCheck.normalizedIds, ...extraWbIds]);
	const mergedPointerMap = new Map<string, IOrchestrationWhiteboardPointer>();
	for (const p of token.whiteboardPointers ?? []) {
		const liveWb = whiteboards?.[p.whiteboardId];
		mergedPointerMap.set(p.whiteboardId, liveWb
			? { whiteboardId: liveWb.id, department: liveWb.department, title: liveWb.title, version: liveWb.version }
			: p);
	}
	for (const p of newPointers) {
		mergedPointerMap.set(p.whiteboardId, p);
		const liveWb = whiteboards?.[p.whiteboardId];
		const wbRef = liveWb
			? buildWhiteboardContextRef(liveWb, nextHopIndex)
			: { ptr: `wb:${p.whiteboardId}`, kind: 'whiteboard' as const, title: p.title, version: p.version, updatedAtHop: nextHopIndex, department: p.department, sizeChars: 0 };
		mergedRefMap.set(wbRef.ptr, wbRef);
		newlyAttachedPtrs.push(wbRef.ptr);
	}
	const mergedContextRefs = [...mergedRefMap.values()];
	const mergedPointers = [...mergedPointerMap.values()];
	const uniqueAttached = [...new Set(newlyAttachedPtrs)];
	const returnHopEntry: IOrchestrationHopLedgerEntry = {
		hop: nextHopIndex,
		tokenId: token.id,
		fromNodeId: token.nodeId,
		toNodeId: targetId,
		event: 'return',
		headline,
		...(payloadPtr ? { payloadPtr } : {}),
		...(uniqueAttached.length > 0 ? { attachedRefPtrs: uniqueAttached } : {}),
		timestamp: now,
	};

	// Path A0: Trailing branch of an ALREADY-satisfied join barrier (e.g. `joinMode: 'any'`):
	// record its result cleanly and close the child token WITHOUT re-waking the already-resumed superior!
	if (activeBarrier && activeBarrier.status === 'satisfied') {
		const traceSeq = state.traceSeq + 1;
		const retTracePtr = `otrc-${traceSeq}`;
		const finishedChild: IOrchestrationToken = {
			...token,
			status: 'completed',
			blocked: undefined,
			hopIndex: nextHopIndex,
			lastSummary: headline,
			...(payloadPtr ? { payloadPtr } : {}),
			hopLog: [...(token.hopLog ?? []), returnHopEntry],
			contextRefs: mergedContextRefs,
			...(mergedPointers.length > 0 ? { whiteboardPointers: mergedPointers } : {}),
			lastActivityAt: now,
		};
		const nextTokens: Record<string, IOrchestrationToken> = {
			...state.tokens,
			[token.id]: finishedChild,
		};
		const nextBarriers: Record<string, IOrchestrationJoinBarrier> = {
			...(state.joinBarriers ?? {}),
			[activeBarrier.id]: {
				...activeBarrier,
				settledChildren: {
					...activeBarrier.settledChildren,
					[token.id]: {
						tokenId: token.id,
						fromNodeId: token.nodeId,
						outcome: 'returned',
						summary: headline,
						...(payloadPtr ? { payloadPtr } : {}),
						...(uniqueAttached.length > 0 ? { attachedRefPtrs: uniqueAttached } : {}),
						...(token.taskNodeId ? { taskNodeId: token.taskNodeId } : {}),
						settledAt: now,
					},
				},
			},
		};
		const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = {
			...state.nodeStates,
			[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
		};
		const nextCursors = recordNodeCursorObservation(
			state.nodeReadCursors,
			token.waveId,
			token.nodeId,
			nextHopIndex,
			mergedContextRefs,
			now,
			[...(token.hopLog ?? []).map(h => buildHopKey(h)), buildHopKey(returnHopEntry)],
		);
		return {
			ok: true,
			state: {
				...state,
				tokens: nextTokens,
				nodeStates: nextNodeStates,
				joinBarriers: nextBarriers,
				traces: {
					...state.traces,
					[retTracePtr]: {
						ptr: retTracePtr,
						parentPtrs: [token.tracePtr],
						nodeId: token.nodeId,
						employeeId: token.holderAgentId,
						waveId: token.waveId,
						event: 'complete',
						summary: `Trailing return -> ${targetId} (barrier ${activeBarrier.id} already satisfied): ${headline}`,
						timestamp: now,
					},
				},
				payloadStore,
				payloadSeq: payloadSeqRef.value,
				nodeReadCursors: nextCursors,
				traceSeq,
				updatedAt: now,
			},
			effects: [],
			data: {
				returnedToNodeId: targetId,
				barrierId: activeBarrier.id,
				barrierSatisfied: true,
				...(payloadPtr ? { payloadPtr } : {}),
				...(uniqueAttached.length > 0 ? { attachedRefPtrs: uniqueAttached } : {}),
			},
		};
	}

	// Path A: Settling a waiting join barrier!
	if (activeBarrier && activeBarrier.status === 'waiting' && activeBarrier.ownerNodeId === targetId) {
		const traceSeq = state.traceSeq + 1;
		const retTracePtr = `otrc-${traceSeq}`;
		const finishedChild: IOrchestrationToken = {
			...token,
			status: 'completed',
			blocked: undefined,
			hopIndex: nextHopIndex,
			lastSummary: headline,
			...(payloadPtr ? { payloadPtr } : {}),
			hopLog: [...(token.hopLog ?? []), returnHopEntry],
			contextRefs: mergedContextRefs,
			...(mergedPointers.length > 0 ? { whiteboardPointers: mergedPointers } : {}),
			lastActivityAt: now,
		};
		const nextTokens: Record<string, IOrchestrationToken> = {
			...state.tokens,
			[token.id]: finishedChild,
		};
		const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = {
			...state.nodeStates,
			[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
		};
		const nextCursors = recordNodeCursorObservation(
			state.nodeReadCursors,
			token.waveId,
			token.nodeId,
			nextHopIndex,
			mergedContextRefs,
			now,
			[...(token.hopLog ?? []).map(h => buildHopKey(h)), buildHopKey(returnHopEntry)],
		);
		const preBarrierState: IOrchestrationRuntimeState = {
			...state,
			tokens: nextTokens,
			nodeStates: nextNodeStates,
			traces: {
				...state.traces,
				[retTracePtr]: {
					ptr: retTracePtr,
					parentPtrs: [token.tracePtr],
					nodeId: token.nodeId,
					employeeId: token.holderAgentId,
					waveId: token.waveId,
					event: 'complete',
					summary: `Return -> ${targetId} (barrier ${activeBarrier.id}): ${headline}`,
					timestamp: now,
				},
			},
			payloadStore,
			payloadSeq: payloadSeqRef.value,
			nodeReadCursors: nextCursors,
			traceSeq,
			updatedAt: now,
		};
		const settled = settleJoinBarrierIfApplicable(preBarrierState, graph, whiteboards, config, {
			childToken: finishedChild,
			outcome: 'returned',
			summary: headline,
			payloadPtr,
			attachedRefPtrs: uniqueAttached,
			extraContextRefs: mergedContextRefs,
			extraWhiteboardPointers: mergedPointers,
			now,
		});
		return {
			ok: true,
			state: settled.state,
			effects: settled.effects,
			data: {
				returnedToNodeId: targetId,
				barrierId: activeBarrier.id,
				barrierSatisfied: settled.barrierSatisfied,
				...(payloadPtr ? { payloadPtr } : {}),
				...(uniqueAttached.length > 0 ? { attachedRefPtrs: uniqueAttached } : {}),
			},
		};
	}

	// Path B0: Superior still holds its active parent baton (e.g. minted with `--no-wait-join`).
	// Merge the child's return summary + lightweight pointers directly into the superior's existing
	// active parent baton instead of creating a duplicate competing active baton on the same superior!
	const existingActiveParent = token.parentTokenId ? state.tokens[token.parentTokenId] : undefined;
	if (
		existingActiveParent
		&& existingActiveParent.nodeId === targetId
		&& (existingActiveParent.status === 'active' || existingActiveParent.status === 'blocked')
	) {
		const traceSeq = state.traceSeq + 1;
		const retTracePtr = `otrc-${traceSeq}`;
		const targetAgentId = state.nodeAgentIds[targetId] ?? targetNode.agentId;
		const parentHopIndex = Math.max(
			nextHopIndex,
			(existingActiveParent.hopIndex ?? Math.max(0, (existingActiveParent.hopLog?.length ?? 1) - 1)) + 1,
		);
		const parentRefMap = new Map<string, IOrchestrationContextRef>();
		for (const ref of refreshContextRefsWithLiveWhiteboards(existingActiveParent.contextRefs, whiteboards, existingActiveParent.whiteboardPointers, parentHopIndex)) {
			parentRefMap.set(ref.ptr, ref);
		}
		for (const ref of mergedContextRefs) {
			parentRefMap.set(ref.ptr, ref);
		}
		const parentWbMap = new Map<string, IOrchestrationWhiteboardPointer>();
		for (const wp of existingActiveParent.whiteboardPointers ?? []) {
			parentWbMap.set(wp.whiteboardId, wp);
		}
		for (const wp of mergedPointers) {
			parentWbMap.set(wp.whiteboardId, wp);
		}
		const mergedParentRefs = [...parentRefMap.values()];
		const mergedParentWbs = [...parentWbMap.values()];
		const parentReturnHop: IOrchestrationHopLedgerEntry = {
			hop: parentHopIndex,
			tokenId: existingActiveParent.id,
			fromNodeId: token.nodeId,
			toNodeId: targetId,
			event: 'return',
			headline: buildCompactHeadline(`[Returned from ${token.nodeId} (${token.id})] ${headline}`).headline,
			...(payloadPtr ? { payloadPtr } : {}),
			...(uniqueAttached.length > 0 ? { attachedRefPtrs: uniqueAttached } : {}),
			timestamp: now,
		};
		const finishedChild: IOrchestrationToken = {
			...token,
			status: 'completed',
			blocked: undefined,
			hopIndex: nextHopIndex,
			lastSummary: headline,
			...(payloadPtr ? { payloadPtr } : {}),
			hopLog: [...(token.hopLog ?? []), returnHopEntry],
			contextRefs: mergedContextRefs,
			...(mergedPointers.length > 0 ? { whiteboardPointers: mergedPointers } : {}),
			lastActivityAt: now,
		};
		const updatedParent: IOrchestrationToken = {
			...existingActiveParent,
			status: 'active',
			blocked: undefined,
			fromNodeId: token.nodeId,
			holderAgentId: targetAgentId,
			hopIndex: parentHopIndex,
			lastSummary: parentReturnHop.headline,
			...(payloadPtr ? { payloadPtr } : {}),
			hopLog: [...(existingActiveParent.hopLog ?? []), parentReturnHop],
			contextRefs: mergedParentRefs,
			...(mergedParentWbs.length > 0 ? { whiteboardPointers: mergedParentWbs } : {}),
			lastActivityAt: now,
			lastNudgeAt: undefined,
			nudgeCount: 0,
		};
		const nextTokens: Record<string, IOrchestrationToken> = {
			...state.tokens,
			[token.id]: finishedChild,
			[existingActiveParent.id]: updatedParent,
		};
		const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = {
			...state.nodeStates,
			[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
			[targetId]: recomputeOrchestrationNodeState(nextTokens, targetId),
		};
		const nextCursors = recordNodeCursorObservation(
			state.nodeReadCursors,
			token.waveId,
			token.nodeId,
			nextHopIndex,
			mergedContextRefs,
			now,
			[...(token.hopLog ?? []).map(h => buildHopKey(h)), buildHopKey(returnHopEntry)],
		);
		const nextState: IOrchestrationRuntimeState = {
			...state,
			tokens: nextTokens,
			nodeStates: nextNodeStates,
			traces: {
				...state.traces,
				[retTracePtr]: {
					ptr: retTracePtr,
					parentPtrs: [token.tracePtr, existingActiveParent.tracePtr],
					nodeId: targetId,
					employeeId: targetAgentId,
					waveId: token.waveId,
					event: 'complete',
					summary: `Return (${token.nodeId} -> ${targetId} into ${existingActiveParent.id}): ${headline}`,
					timestamp: now,
				},
			},
			payloadStore,
			payloadSeq: payloadSeqRef.value,
			nodeReadCursors: nextCursors,
			traceSeq,
			updatedAt: now,
		};
		const delta = buildOrchestrationTokenDeltaView(nextState, updatedParent, whiteboards);
		const outgoingStaffIds = graph.edges
			.filter(e => e.from === targetId && graph.nodes.some(n => n.id === e.to && n.kind === 'staff'))
			.map(e => e.to);
		const subordinateTargetIds = outgoingStaffIds.filter(outId => {
			const outNode = graph.nodes.find(n => n.id === outId && n.kind === 'staff');
			return Boolean(outNode && (targetNode.tier === undefined || outNode.tier === undefined || outNode.tier > targetNode.tier));
		});
		const highest = getHighestRankInSchema(config);
		const isHighest = targetNode.tier !== undefined ? targetNode.tier === highest.tier : targetId === findHighestRankStaffNode(graph)?.id;
		return {
			ok: true,
			state: nextState,
			effects: [{
				kind: 'dispatch_token',
				missionId: state.missionId,
				nodeId: targetId,
				tokenId: existingActiveParent.id,
				holderAgentId: targetAgentId,
				prompt: composeOrchestrationTokenWakeupPrompt(state.missionId, targetNode, updatedParent, outgoingStaffIds, isHighest, delta, { subordinateTargetIds }),
			}],
			data: {
				returnedToNodeId: targetId,
				returnedTokenId: existingActiveParent.id,
				...(payloadPtr ? { payloadPtr } : {}),
				...(uniqueAttached.length > 0 ? { attachedRefPtrs: uniqueAttached } : {}),
			},
		};
	}

	// Path B: Direct return token to dispatching superior (allowed along explicit outgoing edge OR exact minted `returnToNodeId`)
	const hasDirectEdge = graph.edges.some(e => e.from === token.nodeId && e.to === targetId);
	if (!hasDirectEdge && token.returnToNodeId !== targetId) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'NO_EDGE',
			error: `No directed return edge from "${token.nodeId}" to "${targetId}" in Orchestration graph.`,
		};
	}

	const rolledHistory = compressTokenHistoryState(token.historyState, token.compressedHistory, token.lastSummary, token.fromNodeId);
	const tokenSeq = state.tokenSeq + 1;
	const retTokenId = `otok-${tokenSeq}`;
	const handoffTracePtr = `otrc-${state.traceSeq + 1}`;
	const arriveTracePtr = `otrc-${state.traceSeq + 2}`;
	const traceSeq = state.traceSeq + 2;
	const targetAgentId = state.nodeAgentIds[targetId] ?? targetNode.agentId;
	const childReturnHop: IOrchestrationHopLedgerEntry = {
		...returnHopEntry,
		tokenId: retTokenId,
	};
	const returnedToken: IOrchestrationToken = {
		id: retTokenId,
		waveId: token.waveId,
		nodeId: targetId,
		fromNodeId: token.nodeId,
		holderAgentId: targetAgentId,
		status: 'active',
		parentTokenId: token.id,
		rootTokenId: token.rootTokenId ?? token.id,
		originNodeId: token.originNodeId,
		dispatchKind: 'return',
		...(token.taskNodeId ? { taskNodeId: token.taskNodeId } : {}),
		...(token.taskNodeIds ? { taskNodeIds: token.taskNodeIds } : {}),
		hopIndex: nextHopIndex,
		lastSummary: headline,
		...(payloadPtr ? { payloadPtr } : {}),
		hopLog: [...(token.hopLog ?? []), childReturnHop],
		contextRefs: mergedContextRefs,
		compressedHistory: rolledHistory.text,
		historyState: rolledHistory.state,
		tracePtr: arriveTracePtr,
		...(mergedPointers.length > 0 ? { whiteboardPointers: mergedPointers } : {}),
		arrivedAt: now,
		lastActivityAt: now,
		nudgeCount: 0,
	};

	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[token.id]: {
			...token,
			status: 'handed_off',
			blocked: undefined,
			lastActivityAt: now,
			handedOffToNodeIds: [targetId],
		},
		[retTokenId]: returnedToken,
	};
	const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = {
		...state.nodeStates,
		[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
		[targetId]: recomputeOrchestrationNodeState(nextTokens, targetId),
	};
	const nextCursors = recordNodeCursorObservation(
		state.nodeReadCursors,
		token.waveId,
		token.nodeId,
		nextHopIndex,
		mergedContextRefs,
		now,
		[...(token.hopLog ?? []).map(h => buildHopKey(h)), buildHopKey(childReturnHop)],
	);
	const nextState: IOrchestrationRuntimeState = {
		...state,
		tokens: nextTokens,
		nodeStates: nextNodeStates,
		traces: {
			...state.traces,
			[handoffTracePtr]: {
				ptr: handoffTracePtr,
				parentPtrs: [token.tracePtr],
				nodeId: token.nodeId,
				employeeId: token.holderAgentId,
				waveId: token.waveId,
				event: 'complete',
				summary: `Return -> ${targetId}: ${headline}`,
				timestamp: now,
			},
			[arriveTracePtr]: {
				ptr: arriveTracePtr,
				parentPtrs: [handoffTracePtr],
				nodeId: targetId,
				employeeId: targetAgentId,
				waveId: token.waveId,
				event: 'mint',
				summary: headline,
				timestamp: now,
			},
		},
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		nodeReadCursors: nextCursors,
		tokenSeq,
		traceSeq,
		updatedAt: now,
	};

	const delta = buildOrchestrationTokenDeltaView(nextState, returnedToken, whiteboards);
	const outgoingStaffIds = graph.edges
		.filter(e => e.from === targetId && graph.nodes.some(n => n.id === e.to && n.kind === 'staff'))
		.map(e => e.to);
	const subordinateTargetIds = outgoingStaffIds.filter(outId => {
		const outNode = graph.nodes.find(n => n.id === outId && n.kind === 'staff');
		return Boolean(outNode && (targetNode.tier === undefined || outNode.tier === undefined || outNode.tier > targetNode.tier));
	});
	const highest = getHighestRankInSchema(config);
	const isHighest = targetNode.tier !== undefined ? targetNode.tier === highest.tier : targetId === findHighestRankStaffNode(graph)?.id;

	return {
		ok: true,
		state: nextState,
		effects: [{
			kind: 'dispatch_token',
			missionId: state.missionId,
			nodeId: targetId,
			tokenId: retTokenId,
			holderAgentId: targetAgentId,
			prompt: composeOrchestrationTokenWakeupPrompt(state.missionId, targetNode, returnedToken, outgoingStaffIds, isHighest, delta, { subordinateTargetIds }),
		}],
		data: {
			returnedToNodeId: targetId,
			returnedTokenId: retTokenId,
			...(payloadPtr ? { payloadPtr } : {}),
			...(uniqueAttached.length > 0 ? { attachedRefPtrs: uniqueAttached } : {}),
		},
	};
}

/**
 * Explicitly marks an Orchestration token as `'failed'`, settling any waiting join barrier
 * so a failed branch never deadlocks its waiting superior.
 */
export function failOrchestrationToken(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly callerAgentId?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{ readonly barrierSatisfied?: boolean }> {
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before failing tokens.' };
	}
	const token = state.tokens[params.tokenId];
	if (!token || (token.status !== 'active' && token.status !== 'blocked')) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active Orchestration token "${params.tokenId}" not found.` };
	}
	if (params.callerAgentId !== undefined) {
		const boundHolder = state.nodeAgentIds[token.nodeId] ?? token.holderAgentId;
		if (boundHolder && boundHolder !== params.callerAgentId) {
			return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `Token "${params.tokenId}" is not held by caller "${params.callerAgentId}".` };
		}
	}
	const reason = params.reason.trim() || 'Execution failed';
	const now = params.now ?? Date.now();
	const traceSeq = state.traceSeq + 1;
	const failTracePtr = `otrc-${traceSeq}`;
	const nextHop = (token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1)) + 1;
	const { headline } = buildCompactHeadline(reason);
	const failedToken: IOrchestrationToken = {
		...token,
		status: 'failed',
		blocked: undefined,
		failureReason: reason,
		hopIndex: nextHop,
		lastSummary: headline,
		hopLog: [...(token.hopLog ?? []), {
			hop: nextHop,
			tokenId: token.id,
			fromNodeId: token.nodeId,
			toNodeId: token.nodeId,
			event: 'fail',
			headline,
			timestamp: now,
		}],
		lastActivityAt: now,
	};
	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[token.id]: failedToken,
	};
	const preBarrierState: IOrchestrationRuntimeState = {
		...state,
		tokens: nextTokens,
		nodeStates: {
			...state.nodeStates,
			[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
		},
		traces: {
			...state.traces,
			[failTracePtr]: {
				ptr: failTracePtr,
				parentPtrs: [token.tracePtr],
				nodeId: token.nodeId,
				employeeId: token.holderAgentId,
				waveId: token.waveId,
				event: 'fail_escalate',
				summary: headline,
				timestamp: now,
			},
		},
		traceSeq,
		updatedAt: now,
	};
	const settled = settleJoinBarrierIfApplicable(preBarrierState, graph, whiteboards, config, {
		childToken: failedToken,
		outcome: 'failed',
		summary: `FAILED: ${headline}`,
		now,
	});
	// When a non-barrier child token fails, bounce a failure-recovery notice to its dispatching superior
	// (merging into an existing active parent baton when present so zero orphan batons accumulate);
	// when a root/top-rank token fails, alert the Human User Inbox!
	const parentBarrierStatus = failedToken.parentJoinBarrierId ? settled.state.joinBarriers?.[failedToken.parentJoinBarrierId]?.status : undefined;
	if (!failedToken.parentJoinBarrierId && settled.effects.length === 0 && parentBarrierStatus !== 'satisfied') {
		const survivingStaffIds = new Set(graph.nodes.filter(n => n.kind === 'staff').map(n => n.id));
		const fallbackSuperiorId = [
			failedToken.returnToNodeId,
			failedToken.originNodeId && failedToken.originNodeId !== 'User' ? failedToken.originNodeId : undefined,
		].find((id): id is string => Boolean(id && id !== failedToken.nodeId && survivingStaffIds.has(id)));
		if (fallbackSuperiorId) {
			const supNode = graph.nodes.find(n => n.id === fallbackSuperiorId && n.kind === 'staff')!;
			const supAgentId = settled.state.nodeAgentIds[fallbackSuperiorId] ?? supNode.agentId;
			const activeParent = failedToken.parentTokenId ? settled.state.tokens[failedToken.parentTokenId] : undefined;
			if (activeParent && activeParent.nodeId === fallbackSuperiorId && (activeParent.status === 'active' || activeParent.status === 'blocked')) {
				const nextTraceSeq = settled.state.traceSeq + 1;
				const noticeTracePtr = `otrc-${nextTraceSeq}`;
				const noticeHeadline = buildCompactHeadline(`[FAILED at ${failedToken.nodeId} (${failedToken.id})] ${reason}`).headline;
				const parentHop = Math.max(nextHop + 1, (activeParent.hopIndex ?? Math.max(0, (activeParent.hopLog?.length ?? 1) - 1)) + 1);
				const noticeHop: IOrchestrationHopLedgerEntry = {
					hop: parentHop,
					tokenId: activeParent.id,
					fromNodeId: failedToken.nodeId,
					toNodeId: fallbackSuperiorId,
					event: 'fail',
					headline: noticeHeadline,
					...(failedToken.payloadPtr ? { payloadPtr: failedToken.payloadPtr } : {}),
					timestamp: now,
				};
				const refMap = new Map<string, IOrchestrationContextRef>();
				for (const r of activeParent.contextRefs ?? []) { refMap.set(r.ptr, r); }
				for (const r of failedToken.contextRefs ?? []) { refMap.set(r.ptr, r); }
				const updatedParent: IOrchestrationToken = {
					...activeParent,
					status: 'active',
					blocked: undefined,
					fromNodeId: failedToken.nodeId,
					holderAgentId: supAgentId,
					hopIndex: parentHop,
					lastSummary: noticeHeadline,
					...(failedToken.payloadPtr ? { payloadPtr: failedToken.payloadPtr } : {}),
					hopLog: [...(activeParent.hopLog ?? []), noticeHop],
					contextRefs: [...refMap.values()],
					lastActivityAt: now,
					lastNudgeAt: undefined,
					nudgeCount: 0,
				};
				const mergedTokens = { ...settled.state.tokens, [activeParent.id]: updatedParent };
				const bouncedState: IOrchestrationRuntimeState = {
					...settled.state,
					tokens: mergedTokens,
					nodeStates: {
						...settled.state.nodeStates,
						[fallbackSuperiorId]: recomputeOrchestrationNodeState(mergedTokens, fallbackSuperiorId),
					},
					traces: {
						...settled.state.traces,
						[noticeTracePtr]: {
							ptr: noticeTracePtr,
							parentPtrs: [failTracePtr, activeParent.tracePtr],
							nodeId: fallbackSuperiorId,
							employeeId: supAgentId,
							waveId: failedToken.waveId,
							event: 'fail_escalate',
							summary: noticeHeadline,
							timestamp: now,
						},
					},
					traceSeq: nextTraceSeq,
					updatedAt: now,
				};
				const delta = buildOrchestrationTokenDeltaView(bouncedState, updatedParent, whiteboards);
				const outgoingStaffIds = graph.edges
					.filter(e => e.from === fallbackSuperiorId && graph.nodes.some(n => n.id === e.to && n.kind === 'staff'))
					.map(e => e.to);
				const subordinateTargetIds = outgoingStaffIds.filter(outId => {
					const outNode = graph.nodes.find(n => n.id === outId && n.kind === 'staff');
					return Boolean(outNode && (supNode.tier === undefined || outNode.tier === undefined || outNode.tier > supNode.tier));
				});
				const highest = getHighestRankInSchema(config);
				const isHighest = supNode.tier !== undefined ? supNode.tier === highest.tier : supNode.id === findHighestRankStaffNode(graph)?.id;
				return {
					ok: true,
					state: bouncedState,
					effects: [{
						kind: 'dispatch_token',
						missionId: state.missionId,
						nodeId: fallbackSuperiorId,
						tokenId: activeParent.id,
						holderAgentId: supAgentId,
						prompt: composeOrchestrationTokenWakeupPrompt(state.missionId, supNode, updatedParent, outgoingStaffIds, isHighest, delta, { subordinateTargetIds }),
					}],
					data: {
						notifiedSuperiorNodeId: fallbackSuperiorId,
						recoveryTokenId: activeParent.id,
					} as { readonly barrierSatisfied?: boolean; readonly notifiedSuperiorNodeId?: string; readonly recoveryTokenId?: string },
				};
			}
			const nextTokenSeq = settled.state.tokenSeq + 1;
			const nextTraceSeq = settled.state.traceSeq + 1;
			const noticeTokenId = `otok-${nextTokenSeq}`;
			const noticeTracePtr = `otrc-${nextTraceSeq}`;
			const noticeHeadline = buildCompactHeadline(`[FAILED at ${failedToken.nodeId}] ${reason}`).headline;
			const noticeHop: IOrchestrationHopLedgerEntry = {
				hop: nextHop + 1,
				tokenId: noticeTokenId,
				fromNodeId: failedToken.nodeId,
				toNodeId: fallbackSuperiorId,
				event: 'fail',
				headline: noticeHeadline,
				...(failedToken.payloadPtr ? { payloadPtr: failedToken.payloadPtr } : {}),
				timestamp: now,
			};
			const noticeToken: IOrchestrationToken = {
				id: noticeTokenId,
				waveId: failedToken.waveId,
				nodeId: fallbackSuperiorId,
				fromNodeId: failedToken.nodeId,
				holderAgentId: supAgentId,
				status: 'active',
				parentTokenId: failedToken.id,
				rootTokenId: failedToken.rootTokenId ?? failedToken.id,
				originNodeId: failedToken.originNodeId,
				dispatchKind: 'return',
				...(failedToken.taskNodeId ? { taskNodeId: failedToken.taskNodeId } : {}),
				...(failedToken.taskNodeIds ? { taskNodeIds: failedToken.taskNodeIds } : {}),
				hopIndex: nextHop + 1,
				lastSummary: noticeHeadline,
				...(failedToken.payloadPtr ? { payloadPtr: failedToken.payloadPtr } : {}),
				hopLog: [...(failedToken.hopLog ?? []), noticeHop],
				contextRefs: failedToken.contextRefs ?? [],
				compressedHistory: failedToken.compressedHistory,
				historyState: failedToken.historyState,
				tracePtr: noticeTracePtr,
				...(failedToken.whiteboardPointers ? { whiteboardPointers: failedToken.whiteboardPointers } : {}),
				arrivedAt: now,
				lastActivityAt: now,
				nudgeCount: 0,
			};
			const mergedTokens = { ...settled.state.tokens, [noticeTokenId]: noticeToken };
			const bouncedState: IOrchestrationRuntimeState = {
				...settled.state,
				tokens: mergedTokens,
				nodeStates: {
					...settled.state.nodeStates,
					[fallbackSuperiorId]: recomputeOrchestrationNodeState(mergedTokens, fallbackSuperiorId),
				},
				traces: {
					...settled.state.traces,
					[noticeTracePtr]: {
						ptr: noticeTracePtr,
						parentPtrs: [failTracePtr],
						nodeId: fallbackSuperiorId,
						employeeId: supAgentId,
						waveId: failedToken.waveId,
						event: 'fail_escalate',
						summary: noticeHeadline,
						timestamp: now,
					},
				},
				tokenSeq: nextTokenSeq,
				traceSeq: nextTraceSeq,
				updatedAt: now,
			};
			const delta = buildOrchestrationTokenDeltaView(bouncedState, noticeToken, whiteboards);
			const outgoingStaffIds = graph.edges
				.filter(e => e.from === fallbackSuperiorId && graph.nodes.some(n => n.id === e.to && n.kind === 'staff'))
				.map(e => e.to);
			const subordinateTargetIds = outgoingStaffIds.filter(outId => {
				const outNode = graph.nodes.find(n => n.id === outId && n.kind === 'staff');
				return Boolean(outNode && (supNode.tier === undefined || outNode.tier === undefined || outNode.tier > supNode.tier));
			});
			const highest = getHighestRankInSchema(config);
			const isHighest = supNode.tier !== undefined ? supNode.tier === highest.tier : supNode.id === findHighestRankStaffNode(graph)?.id;
			return {
				ok: true,
				state: bouncedState,
				effects: [{
					kind: 'dispatch_token',
					missionId: state.missionId,
					nodeId: fallbackSuperiorId,
					tokenId: noticeTokenId,
					holderAgentId: supAgentId,
					prompt: composeOrchestrationTokenWakeupPrompt(state.missionId, supNode, noticeToken, outgoingStaffIds, isHighest, delta, { subordinateTargetIds }),
				}],
				data: {
					notifiedSuperiorNodeId: fallbackSuperiorId,
					recoveryTokenId: noticeTokenId,
				} as { readonly barrierSatisfied?: boolean; readonly notifiedSuperiorNodeId?: string; readonly recoveryTokenId?: string },
			};
		}
		return {
			ok: true,
			state: settled.state,
			effects: [{
				kind: 'post_inbox',
				missionId: state.missionId,
				nodeId: failedToken.nodeId,
				tokenId: failedToken.id,
				title: `Engineering Failure (${failedToken.nodeId})`,
				message: `Token \`${failedToken.id}\` failed on staff node \`${failedToken.nodeId}\`: ${reason}`,
				severity: 'critical',
				senderAgentId: failedToken.holderAgentId,
			}],
			data: {},
		};
	}
	return {
		ok: true,
		state: settled.state,
		effects: settled.effects,
		data: { ...(settled.barrierSatisfied ? { barrierSatisfied: true } : {}) },
	};
}

export function pauseOrchestration(
	state: IOrchestrationRuntimeState,
	params?: { readonly reason?: string; readonly now?: number },
): IOrchestrationTransitionResult<{ readonly status: 'paused' }> {
	const now = params?.now ?? Date.now();
	return {
		ok: true,
		state: {
			...state,
			status: 'paused',
			pausedAt: now,
			...(params?.reason?.trim() ? { pausedReason: params.reason.trim() } : {}),
			updatedAt: now,
		},
		effects: [],
		data: { status: 'paused' },
	};
}

export function resumeOrchestration(
	state: IOrchestrationRuntimeState,
	params?: { readonly now?: number },
): IOrchestrationTransitionResult<{ readonly status: 'running'; readonly activeTokenIds: readonly string[] }> {
	const now = params?.now ?? Date.now();
	const activeTokenIds = Object.values(state.tokens)
		.filter(t => t.status === 'active')
		.map(t => t.id);
	return {
		ok: true,
		state: {
			...state,
			status: 'running',
			pausedAt: undefined,
			pausedReason: undefined,
			updatedAt: now,
		},
		effects: [],
		data: { status: 'running', activeTokenIds },
	};
}

export function abortOrchestrationTokens(
	state: IOrchestrationRuntimeState,
	params?: { readonly reason?: string; readonly now?: number },
): IOrchestrationTransitionResult<{ readonly abortedTokenIds: readonly string[]; readonly abortedBarrierIds: readonly string[] }> {
	const now = params?.now ?? Date.now();
	const reason = params?.reason?.trim() || 'Aborted by operator';
	const nextTokens: Record<string, IOrchestrationToken> = { ...state.tokens };
	const abortedTokenIds: string[] = [];
	const touchedNodes = new Set<string>(Object.keys(state.nodeStates));
	let traceSeq = state.traceSeq;
	const nextTraces: Record<string, IMissionTraceNode> = { ...state.traces };

	for (const token of Object.values(state.tokens)) {
		if (token.status === 'active' || token.status === 'blocked' || token.status === 'waiting_join') {
			abortedTokenIds.push(token.id);
			touchedNodes.add(token.nodeId);
			traceSeq += 1;
			const abortTracePtr = `otrc-${traceSeq}`;
			const nextHop = (token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1)) + 1;
			nextTokens[token.id] = {
				...token,
				status: 'aborted',
				blocked: undefined,
				joinBarrierId: undefined,
				failureReason: reason,
				hopIndex: nextHop,
				hopLog: [...(token.hopLog ?? []), {
					hop: nextHop,
					tokenId: token.id,
					fromNodeId: token.nodeId,
					toNodeId: token.nodeId,
					event: 'abort',
					headline: buildCompactHeadline(reason).headline,
					timestamp: now,
				}],
				lastActivityAt: now,
			};
			nextTraces[abortTracePtr] = {
				ptr: abortTracePtr,
				parentPtrs: [token.tracePtr],
				nodeId: token.nodeId,
				employeeId: token.holderAgentId,
				waveId: token.waveId,
				event: 'recall',
				summary: `Aborted: ${reason}`,
				timestamp: now,
			};
		}
	}

	const nextBarriers: Record<string, IOrchestrationJoinBarrier> = { ...(state.joinBarriers ?? {}) };
	const abortedBarrierIds: string[] = [];
	for (const barrier of Object.values(nextBarriers)) {
		if (barrier.status === 'waiting') {
			abortedBarrierIds.push(barrier.id);
			nextBarriers[barrier.id] = {
				...barrier,
				status: 'aborted',
			};
		}
	}

	const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = {};
	for (const nodeId of touchedNodes) {
		nextNodeStates[nodeId] = recomputeOrchestrationNodeState(nextTokens, nodeId);
	}

	return {
		ok: true,
		state: {
			...state,
			status: 'aborted',
			pausedAt: undefined,
			pausedReason: undefined,
			tokens: nextTokens,
			nodeStates: nextNodeStates,
			traces: nextTraces,
			joinBarriers: nextBarriers,
			traceSeq,
			updatedAt: now,
		},
		effects: [],
		data: { abortedTokenIds, abortedBarrierIds },
	};
}

/**
 * Explicitly submits/completes an Orchestration token:
 * - If `toNodeIds` is provided, delegates to `handoffOrchestrationToken`.
 * - If `finish === true` (or highest-rank role with no target), closes the token cleanly and returns the employee to `'idle'`.
 * - Otherwise if exactly 1 unique outgoing staff neighbor exists, auto-hands off along that single edge;
 *   if multiple outgoing edges exist (common in cyclic/bidirectional graphs), asks for explicit `--to` or `--finish`.
 */
export function completeOrchestrationToken(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly tokenId: string;
		readonly summary: string;
		readonly detail?: string;
		readonly toNodeIds?: readonly string[];
		readonly taskNodeId?: string;
		readonly taskNodeIds?: readonly string[];
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
		readonly refPtrs?: readonly string[];
		readonly modifiedFiles?: readonly string[];
		readonly finish?: boolean;
		readonly callerAgentId?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{ readonly nextTokenIds: readonly string[]; readonly finished?: boolean; readonly payloadPtr?: string; readonly barrierSatisfied?: boolean }> {
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before completing tokens.' };
	}
	if (params.toNodeIds && params.toNodeIds.length > 0) {
		const res = handoffOrchestrationToken(state, graph, whiteboards, config, {
			tokenId: params.tokenId,
			toNodeIds: params.toNodeIds,
			summary: params.summary,
			detail: params.detail,
			taskNodeId: params.taskNodeId,
			taskNodeIds: params.taskNodeIds,
			taskGraph: params.taskGraph,
			taskStatuses: params.taskStatuses,
			whiteboardIds: params.whiteboardIds,
			artifacts: params.artifacts,
			decisions: params.decisions,
			refPtrs: params.refPtrs,
			modifiedFiles: params.modifiedFiles,
			callerAgentId: params.callerAgentId,
			now: params.now,
		});
		return { ...res, data: res.data ? { nextTokenIds: res.data.nextTokenIds, ...(res.data.payloadPtr ? { payloadPtr: res.data.payloadPtr } : {}), ...(res.data.barrierSatisfied ? { barrierSatisfied: true } : {}) } : undefined };
	}

	const token = state.tokens[params.tokenId];
	if (!token || (token.status !== 'active' && token.status !== 'blocked')) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active Orchestration token "${params.tokenId}" not found.` };
	}
	if (params.callerAgentId !== undefined) {
		const boundHolder = state.nodeAgentIds[token.nodeId] ?? token.holderAgentId;
		if (boundHolder && boundHolder !== params.callerAgentId) {
			return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `Token "${params.tokenId}" is not held by caller "${params.callerAgentId}".` };
		}
	}
	const summary = params.summary.trim();
	if (!summary) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'A concrete --summary is required.' };
	}

	const outgoingStaff = graph.edges
		.filter(e => e.from === token.nodeId && graph.nodes.some(n => n.id === e.to && n.kind === 'staff'))
		.map(e => e.to);
	const uniqueOut = [...new Set(outgoingStaff)];
	const holderNode = graph.nodes.find(n => n.id === token.nodeId);
	const completePathCheck = validateStaffAllowedPaths(holderNode, params.modifiedFiles);
	if (!completePathCheck.ok) {
		return { ok: false, state, effects: [], code: 'ALLOWED_PATHS_VIOLATION', error: completePathCheck.error };
	}
	const holderTier = resolveEffectiveStaffTier(holderNode, config);
	const highest = getHighestRankInSchema(config);
	const isHighest = holderTier !== undefined
		? holderTier === highest.tier
		: holderNode?.id === findHighestRankStaffNode(graph)?.id;

	// If a subordinate holds a minted downward baton with an explicit return target and invokes
	// `token complete` without `--to` or `--finish`, transparently route through `returnOrchestrationToken`
	// so subordinates never get stuck on `AMBIGUOUS_TARGET` when they also have peer edges!
	if (!params.finish && !isHighest && token.returnToNodeId) {
		const ret = returnOrchestrationToken(state, graph, whiteboards, config, {
			tokenId: params.tokenId,
			toNodeId: token.returnToNodeId,
			summary,
			detail: params.detail,
			whiteboardIds: params.whiteboardIds,
			artifacts: params.artifacts,
			decisions: params.decisions,
			refPtrs: params.refPtrs,
			modifiedFiles: params.modifiedFiles,
			callerAgentId: params.callerAgentId,
			now: params.now,
		});
		return {
			...ret,
			data: ret.data
				? {
					nextTokenIds: ret.data.returnedTokenId ? [ret.data.returnedTokenId] : [],
					...(ret.data.payloadPtr ? { payloadPtr: ret.data.payloadPtr } : {}),
					...(ret.data.barrierSatisfied ? { barrierSatisfied: true } : {}),
				}
				: undefined,
		};
	}

	if (!params.finish && !isHighest && uniqueOut.length === 1) {
		const res = handoffOrchestrationToken(state, graph, whiteboards, config, {
			tokenId: params.tokenId,
			toNodeIds: uniqueOut,
			summary,
			detail: params.detail,
			taskNodeId: params.taskNodeId,
			taskNodeIds: params.taskNodeIds,
			taskGraph: params.taskGraph,
			taskStatuses: params.taskStatuses,
			whiteboardIds: params.whiteboardIds,
			artifacts: params.artifacts,
			decisions: params.decisions,
			refPtrs: params.refPtrs,
			modifiedFiles: params.modifiedFiles,
			callerAgentId: params.callerAgentId,
			now: params.now,
		});
		return { ...res, data: res.data ? { nextTokenIds: res.data.nextTokenIds, ...(res.data.payloadPtr ? { payloadPtr: res.data.payloadPtr } : {}) } : undefined };
	}

	if (!params.finish && !isHighest && uniqueOut.length > 1) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'AMBIGUOUS_TARGET',
			error: `Staff node "${token.nodeId}" has multiple connected neighbors (${uniqueOut.join(', ')}). Specify --to <nodeId[,...]> to hand off the baton, or pass --finish to close without forwarding.`,
		};
	}

	const wbCheck = validateTokenWhiteboardAttachments(
		graph,
		whiteboards,
		config,
		{ callerNodeId: token.nodeId, callerTier: holderTier },
		params.whiteboardIds,
		params.refPtrs,
	);
	if (!wbCheck.ok) {
		return { ok: false, state, effects: [], code: wbCheck.code ?? 'INVALID_STATE', error: wbCheck.error };
	}

	// Final completion: mark token completed and return employee to idle (NEVER destroyed!)
	const now = params.now ?? Date.now();
	const traceSeq = state.traceSeq + 1;
	const donePtr = `otrc-${traceSeq}`;
	const prevHopIndex = token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1);
	const doneHop = prevHopIndex + 1;
	const { headline, wasTruncated } = buildCompactHeadline(summary);
	const rawDetail = params.detail?.trim() || (wasTruncated ? summary : '');
	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const existingRefMap = new Map<string, IOrchestrationContextRef>();
	for (const ref of refreshContextRefsWithLiveWhiteboards(token.contextRefs, whiteboards, token.whiteboardPointers, doneHop)) {
		existingRefMap.set(ref.ptr, ref);
	}
	let payloadPtr: string | undefined;
	const newlyAttachedCompletePtrs: string[] = [];
	if (rawDetail) {
		const ref = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
			kind: 'handoff',
			title: `Hop #${doneHop}: Final Completion by ${token.nodeId}`,
			content: rawDetail,
			authorNodeId: token.nodeId,
			authorAgentId: token.holderAgentId,
			hop: doneHop,
			waveId: token.waveId,
			now,
		});
		payloadPtr = ref.ptr;
		existingRefMap.set(ref.ptr, ref);
	}
	for (const art of params.artifacts ?? []) {
		if (art.content.trim()) {
			const ref = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
				kind: 'artifact',
				title: art.title || `Artifact from ${token.nodeId}`,
				content: art.content,
				authorNodeId: token.nodeId,
				authorAgentId: token.holderAgentId,
				hop: doneHop,
				waveId: token.waveId,
				now,
			});
			existingRefMap.set(ref.ptr, ref);
			newlyAttachedCompletePtrs.push(ref.ptr);
		}
	}
	for (const dec of params.decisions ?? []) {
		if (dec.content.trim()) {
			const ref = storeOrReuseContextBlob(payloadStore, payloadSeqRef, {
				kind: 'decision',
				title: dec.title || `Decision by ${token.nodeId}`,
				content: dec.content,
				authorNodeId: token.nodeId,
				authorAgentId: token.holderAgentId,
				hop: doneHop,
				waveId: token.waveId,
				now,
			});
			existingRefMap.set(ref.ptr, ref);
			newlyAttachedCompletePtrs.push(ref.ptr);
		}
	}
	const extraCompleteWbIds: string[] = [];
	for (const rawPtr of params.refPtrs ?? []) {
		const ptr = rawPtr.trim();
		if (!ptr || existingRefMap.has(ptr)) { continue; }
		const blob = payloadStore[ptr];
		if (blob) {
			existingRefMap.set(ptr, {
				ptr: blob.ptr,
				kind: blob.kind,
				title: blob.title,
				version: 1,
				updatedAtHop: blob.hop,
				...(blob.authorNodeId ? { authorNodeId: blob.authorNodeId } : {}),
				sizeChars: blob.sizeChars,
				digest: blob.digest,
			});
			newlyAttachedCompletePtrs.push(ptr);
			continue;
		}
		const wbId = ptr.startsWith('wb:') ? ptr.slice(3) : ptr;
		if (whiteboards?.[wbId]) { extraCompleteWbIds.push(wbId); }
	}
	const newCompletePointers = buildWhiteboardPointers(whiteboards, [...wbCheck.normalizedIds, ...extraCompleteWbIds]);
	const mergedCompletePointerMap = new Map<string, IOrchestrationWhiteboardPointer>();
	for (const p of token.whiteboardPointers ?? []) {
		const liveWb = whiteboards?.[p.whiteboardId];
		mergedCompletePointerMap.set(p.whiteboardId, liveWb
			? { whiteboardId: liveWb.id, department: liveWb.department, title: liveWb.title, version: liveWb.version }
			: p);
	}
	for (const p of newCompletePointers) {
		mergedCompletePointerMap.set(p.whiteboardId, p);
		const liveWb = whiteboards?.[p.whiteboardId];
		const wbRef = liveWb
			? buildWhiteboardContextRef(liveWb, doneHop)
			: { ptr: `wb:${p.whiteboardId}`, kind: 'whiteboard' as const, title: p.title, version: p.version, updatedAtHop: doneHop, department: p.department, sizeChars: 0 };
		existingRefMap.set(wbRef.ptr, wbRef);
		newlyAttachedCompletePtrs.push(wbRef.ptr);
	}
	const existingRefs = [...existingRefMap.values()];
	const mergedCompletePointers = [...mergedCompletePointerMap.values()];
	const uniqueAttachedCompletePtrs = [...new Set(newlyAttachedCompletePtrs)];
	const doneHopEntry: IOrchestrationHopLedgerEntry = {
		hop: doneHop,
		tokenId: token.id,
		fromNodeId: token.nodeId,
		toNodeId: token.nodeId,
		event: 'complete',
		headline,
		...(payloadPtr ? { payloadPtr } : {}),
		...(uniqueAttachedCompletePtrs.length > 0 ? { attachedRefPtrs: uniqueAttachedCompletePtrs } : {}),
		timestamp: now,
	};
	const completedToken: IOrchestrationToken = {
		...token,
		status: 'completed',
		blocked: undefined,
		hopIndex: doneHop,
		lastSummary: headline,
		...(payloadPtr ? { payloadPtr } : {}),
		hopLog: [...(token.hopLog ?? []), doneHopEntry],
		contextRefs: existingRefs,
		...(mergedCompletePointers.length > 0 ? { whiteboardPointers: mergedCompletePointers } : {}),
		lastActivityAt: now,
	};
	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[token.id]: completedToken,
	};
	const preBarrierState: IOrchestrationRuntimeState = {
		...state,
		tokens: nextTokens,
		nodeStates: {
			...state.nodeStates,
			[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
		},
		traces: {
			...state.traces,
			[donePtr]: {
				ptr: donePtr,
				parentPtrs: [token.tracePtr],
				nodeId: token.nodeId,
				employeeId: token.holderAgentId,
				waveId: token.waveId,
				event: 'complete',
				summary: headline,
				timestamp: now,
			},
		},
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		traceSeq,
		updatedAt: now,
	};
	const settled = settleJoinBarrierIfApplicable(preBarrierState, graph, whiteboards, config, {
		childToken: completedToken,
		outcome: 'completed',
		summary: headline,
		payloadPtr,
		extraContextRefs: existingRefs,
		now,
	});
	const completionEffects: OrchestrationEngineEffect[] = [...settled.effects];
	// When the root wave completes (e.g. L1 Governor finishes via `token complete --finish`),
	// deliver a structured completion report directly to the Human User's ADE Inbox!
	// Never let a lower-tier subordinate's local `--finish` falsely report wave completion to the User.
	const isRootOrTopCompletion = isHighest || (!completedToken.returnToNodeId && completedToken.originNodeId === 'User');
	if (!completedToken.parentJoinBarrierId && !settled.barrierSatisfied && isRootOrTopCompletion && (isHighest || params.finish)) {
		const artifactPtrs = existingRefs.filter(r => r.kind === 'artifact' || r.kind === 'decision').map(r => r.ptr);
		const detailLines = [
			`Wave \`${completedToken.waveId}\` completed by \`${completedToken.nodeId}\`${holderNode?.label ? ` (${holderNode.label})` : ''} (token \`${completedToken.id}\`).`,
			'',
			`Summary: ${summary}`,
			...(rawDetail && rawDetail !== summary ? ['', rawDetail.slice(0, 1200)] : []),
			...(payloadPtr ? [`\nDetail pointer: \`${payloadPtr}\``] : []),
			...(artifactPtrs.length > 0 ? [`Artifacts/Decisions: ${artifactPtrs.map(p => `\`${p}\``).join(', ')}`] : []),
		];
		completionEffects.push({
			kind: 'post_inbox',
			missionId: state.missionId,
			nodeId: completedToken.nodeId,
			tokenId: completedToken.id,
			title: `Engineering Delivery Completed (${completedToken.nodeId})`,
			message: detailLines.join('\n'),
			severity: 'info',
			senderAgentId: completedToken.holderAgentId,
		});
	}
	return {
		ok: true,
		state: settled.state,
		effects: completionEffects,
		data: {
			nextTokenIds: [],
			finished: true,
			...(payloadPtr ? { payloadPtr } : {}),
			...(settled.barrierSatisfied ? { barrierSatisfied: true } : {}),
		},
	};
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
	/** True when the blob was externalized out of hot JSON to cold `.blobs/<ptr>.json` and must be hydrated asynchronously. */
	readonly externalized?: boolean;
	readonly error?: string;
}

/**
 * Batch on-demand pointer dereferencer (`token.read`):
 * Resolves `hop-N`, `art-N`, `dec-N`, `wb:<id>` (or raw whiteboard ID), and `otrc-N` in one round-trip,
 * enforces department whiteboard scoping, and records observed pointer versions in `nodeReadCursors`
 * so returning employees never re-read unchanged pointers!
 */
export function readOrchestrationTokenPointers(
	state: IOrchestrationRuntimeState,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	graph: IOrchestrationGraphParseResult,
	config: IAdeOrganizationConfig,
	params: {
		readonly ptrs: readonly string[];
		readonly readerNodeId?: string;
		readonly waveId?: string;
		readonly caller?: {
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerNodeId?: string;
		};
		readonly now?: number;
	},
): {
	readonly state: IOrchestrationRuntimeState;
	readonly items: readonly IDereferencedOrchestrationPointer[];
} {
	const now = params.now ?? Date.now();
	const items: IDereferencedOrchestrationPointer[] = [];
	const observedRefs: IOrchestrationContextRef[] = [];
	let maxObservedHop = -1;

	for (const raw of params.ptrs) {
		const ptr = raw.trim();
		if (!ptr) {
			continue;
		}
		// 1. Content-addressed payload store (`hop-N`, `art-N`, `dec-N`)
		const blob = state.payloadStore?.[ptr];
		if (blob) {
			items.push({
				ptr: blob.ptr,
				ok: true,
				kind: blob.kind,
				title: blob.title,
				version: 1,
				authorNodeId: blob.authorNodeId,
				hop: blob.hop,
				sizeChars: blob.sizeChars,
				content: blob.content,
			});
			observedRefs.push({
				ptr: blob.ptr,
				kind: blob.kind,
				title: blob.title,
				version: 1,
				updatedAtHop: blob.hop,
				...(blob.authorNodeId ? { authorNodeId: blob.authorNodeId } : {}),
				sizeChars: blob.sizeChars,
				digest: blob.digest,
			});
			maxObservedHop = Math.max(maxObservedHop, blob.hop);
			continue;
		}

		// 1b. Cold externalized payload blob index (hydrated asynchronously from `<adeHome>/missions/<safe>.blobs/<ptr>.json`)
		const extMeta = state.externalizedBlobIndex?.[ptr];
		if (extMeta) {
			items.push({
				ptr: extMeta.ptr,
				ok: false,
				kind: extMeta.kind,
				title: extMeta.title,
				version: 1,
				authorNodeId: extMeta.authorNodeId,
				hop: extMeta.hop,
				sizeChars: extMeta.sizeChars,
				externalized: true,
				error: `Pointer "${ptr}" is externalized to cold blob storage.`,
			});
			continue;
		}

		// 2. Department Shared Whiteboard pointer (`wb:<id>` or direct whiteboard ID)
		const wbId = ptr.startsWith('wb:') ? ptr.slice(3) : ptr;
		const wb = whiteboards?.[wbId];
		if (wb) {
			if (params.caller && !canCallerAccessWhiteboard(graph, wb, config, params.caller)) {
				items.push({
					ptr,
					ok: false,
					kind: 'whiteboard',
					error: `FORBIDDEN: caller cannot read whiteboard "${wb.id}" (Department: "${wb.department}").`,
				});
				continue;
			}
			items.push({
				ptr: `wb:${wb.id}`,
				ok: true,
				kind: 'whiteboard',
				title: wb.title,
				version: wb.version,
				department: wb.department,
				authorNodeId: wb.updatedByLabel,
				sizeChars: wb.content.length,
				content: wb.content,
			});
			observedRefs.push(buildWhiteboardContextRef(wb, Math.max(0, maxObservedHop)));
			continue;
		}

		// 3. Legacy/trace pointer (`otrc-N`)
		const traceNode = state.traces[ptr];
		if (traceNode) {
			const traceText = traceNode.summary ?? '';
			items.push({
				ptr: traceNode.ptr,
				ok: true,
				kind: 'trace',
				title: `${traceNode.event} @ ${traceNode.nodeId}`,
				version: 1,
				authorNodeId: traceNode.nodeId,
				sizeChars: traceText.length,
				content: traceText,
			});
			continue;
		}

		items.push({
			ptr,
			ok: false,
			error: ptr.startsWith('wb:')
				? `Whiteboard pointer "${ptr}" not found (removed or does not exist).`
				: `Pointer "${ptr}" not found in Orchestration payloadStore, whiteboards, or traces.`,
		});
	}

	let nextState = state;
	if (params.readerNodeId && params.waveId && observedRefs.length > 0) {
		const nextCursors = recordNodeCursorObservation(
			state.nodeReadCursors,
			params.waveId,
			params.readerNodeId,
			maxObservedHop,
			observedRefs,
			now,
		);
		nextState = {
			...state,
			nodeReadCursors: nextCursors,
			updatedAt: now,
		};
	}

	return { state: nextState, items };
}

/**
 * Returns full pass-history timeline and typed pointer manifest for any Orchestration token
 * along with its Delta View relative to the holder (or specified viewer node).
 */
export function getOrchestrationTokenHistory(
	state: IOrchestrationRuntimeState,
	tokenId: string,
	whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>,
	options?: { readonly includeAll?: boolean },
): {
	readonly ok: boolean;
	readonly tokenId: string;
	readonly waveId?: string;
	readonly nodeId?: string;
	readonly currentHop?: number;
	readonly hopLog?: readonly IOrchestrationHopLedgerEntry[];
	readonly contextRefs?: readonly IOrchestrationContextRef[];
	readonly delta?: IOrchestrationTokenDeltaView;
	readonly error?: string;
} {
	const token = state.tokens[tokenId];
	if (!token) {
		return { ok: false, tokenId, error: `Orchestration token "${tokenId}" not found.` };
	}
	const delta = buildOrchestrationTokenDeltaView(state, token, whiteboards);
	const currentHop = token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1);
	const refreshedRefs = refreshContextRefsWithLiveWhiteboards(token.contextRefs, whiteboards, token.whiteboardPointers, currentHop);
	return {
		ok: true,
		tokenId: token.id,
		waveId: token.waveId,
		nodeId: token.nodeId,
		currentHop,
		hopLog: options?.includeAll !== false ? (token.hopLog ?? []) : delta.newHops,
		contextRefs: options?.includeAll !== false ? refreshedRefs : delta.newOrUpdatedRefs,
		delta,
	};
}

/**
 * 5-Minute Repeating Silence Reminder:
 * Whenever an employee holds an active baton token and stays silent/idle for >= 5 minutes,
 * automatically emits a reminder urging them to keep progressing and explicitly submit/hand off
 * the token when done. Repeats cleanly every 5 minutes without freezing or destroying the employee.
 */
export function recordOrchestrationSilenceReminder(
	state: IOrchestrationRuntimeState,
	params: {
		readonly tokenId: string;
		readonly detail?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{ readonly nudgeCount: number }> {
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is paused; silence reminders are suppressed.' };
	}
	const token = state.tokens[params.tokenId];
	if (!token || token.status !== 'active') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Active Orchestration token "${params.tokenId}" not found.` };
	}
	const now = params.now ?? Date.now();
	const intervalMin = Math.max(1, state.silenceReminderMinutes || ORCHESTRATION_SILENCE_REMINDER_MINUTES);
	const nextNudgeCount = token.nudgeCount + 1;
	const updatedToken: IOrchestrationToken = {
		...token,
		lastNudgeAt: now,
		nudgeCount: nextNudgeCount,
	};
	const message = [
		...buildTokenSystemEnvelopeLines({
			tokenId: token.id,
			nodeId: token.nodeId,
			hopIndex: token.hopIndex,
			sourceDescription: `Automatic ${intervalMin}-minute silence reminder #${nextNudgeCount}`,
			isReminder: true,
		}),
		`[Orchestration 5m Silence Reminder #${nextNudgeCount} · Staff \`${token.nodeId}\` · Token \`${token.id}\`]`,
		`You still hold active baton token \`${token.id}\` and have been silent for ${intervalMin} minute(s)${params.detail ? ` (${params.detail})` : ''}.`,
		`Please continue advancing your assigned work immediately. When you finish your current stage, you MUST explicitly advance your token via \`aexus-ade token return ${token.id} --summary "..."\` (if returning upward) or \`aexus-ade token handoff ${token.id} --to <targetNodeId> --summary "..."\` (or \`token complete\` / \`token block\` if waiting on a long-running command).`,
	].join('\n');

	return {
		ok: true,
		state: {
			...state,
			tokens: {
				...state.tokens,
				[token.id]: updatedToken,
			},
			updatedAt: now,
		},
		effects: [{
			kind: 'silence_reminder',
			missionId: state.missionId,
			nodeId: token.nodeId,
			tokenId: token.id,
			holderAgentId: state.nodeAgentIds[token.nodeId] ?? token.holderAgentId,
			nudgeCount: nextNudgeCount,
			message,
		}],
		data: { nudgeCount: nextNudgeCount },
	};
}

export function blockOrchestrationToken(
	state: IOrchestrationRuntimeState,
	params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly maxDurationMs: number;
		readonly watchPid?: number;
		readonly watchFile?: string;
		readonly initialFileMtime?: number | null;
		readonly hostAlias?: string;
		readonly callerAgentId?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult {
	const token = state.tokens[params.tokenId];
	if (!token || (token.status !== 'active' && token.status !== 'blocked')) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active Orchestration token "${params.tokenId}" not found.` };
	}
	if (params.callerAgentId !== undefined) {
		const boundHolder = state.nodeAgentIds[token.nodeId] ?? token.holderAgentId;
		if (boundHolder && boundHolder !== params.callerAgentId) {
			return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `Token "${params.tokenId}" is not held by caller "${params.callerAgentId}".` };
		}
	}
	const now = params.now ?? Date.now();
	const durationMs = Math.max(10_000, Math.min(7 * 86_400_000, Math.round(params.maxDurationMs)));
	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[token.id]: {
			...token,
			status: 'blocked',
			lastActivityAt: now,
			blocked: {
				reason: params.reason.trim() || 'Long-running task in progress',
				startedAt: now,
				maxDurationMs: durationMs,
				expiresAt: now + durationMs,
				...(typeof params.watchPid === 'number' && params.watchPid > 0 ? { watchPid: Math.floor(params.watchPid) } : {}),
				...(params.watchFile?.trim() ? { watchFile: params.watchFile.trim() } : {}),
				...(params.initialFileMtime !== undefined ? { initialFileMtime: params.initialFileMtime } : {}),
				...(params.hostAlias?.trim() ? { hostAlias: params.hostAlias.trim() } : {}),
			},
		},
	};
	return {
		ok: true,
		state: {
			...state,
			tokens: nextTokens,
			nodeStates: {
				...state.nodeStates,
				[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
			},
			updatedAt: now,
		},
		effects: [],
	};
}

export function wakeBlockedOrchestrationToken(
	state: IOrchestrationRuntimeState,
	params: {
		readonly tokenId: string;
		readonly reason: 'block_expired' | 'pid_exited' | 'file_ready';
		readonly detail?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult {
	const token = state.tokens[params.tokenId];
	if (!token || token.status !== 'blocked') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Blocked Orchestration token "${params.tokenId}" not found.` };
	}
	const now = params.now ?? Date.now();
	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[token.id]: {
			...token,
			status: 'active',
			blocked: undefined,
			lastActivityAt: now,
			lastNudgeAt: now,
		},
	};
	const message = `[Orchestration Watchdog Wakeup · Token \`${token.id}\`] Blocked condition triggered (${params.reason}${params.detail ? `: ${params.detail}` : ''}). Resume work on staff node \`${token.nodeId}\` and explicitly hand off or complete token \`${token.id}\` when ready.`;
	return {
		ok: true,
		state: {
			...state,
			tokens: nextTokens,
			nodeStates: {
				...state.nodeStates,
				[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
			},
			updatedAt: now,
		},
		effects: [{
			kind: 'wakeup_blocked',
			missionId: state.missionId,
			nodeId: token.nodeId,
			tokenId: token.id,
			holderAgentId: state.nodeAgentIds[token.nodeId] ?? token.holderAgentId,
			message,
		}],
	};
}

// ============================================================================
// 4. Runtime Dynamic Subordinate Creation, Removal & In-Flight Token Reclamation
// ============================================================================

export interface ICreateSubordinatePlan {
	readonly ok: boolean;
	readonly error?: string;
	readonly code?: 'FORBIDDEN' | 'DUPLICATE_EMPLOYEE' | 'INVALID_RANK' | 'INVALID_GRAPH' | 'RANK_SKIP_FORBIDDEN' | 'CROSS_DEPARTMENT_FORBIDDEN';
	readonly newNodeId?: string;
	readonly resolvedRank?: IAdeRankDefinition;
	readonly orchestrationText?: string;
}

/**
 * Pure planner & validator for dynamic runtime subordinate creation on the Orchestration canvas:
 * - Superior (tier T) may create ONLY an immediate next-tier subordinate (no rank-skipping!)
 *   within their own department (no cross-department staffing!), auto-wired via `<-->` by default.
 * - Human User (L-1) and Secretary (L0) may create staff at any configured tier/department.
 * - Enforces strict employee uniqueness on the Orchestration canvas.
 */
export function planDynamicSubordinateCreation(
	rawOrchestrationText: string,
	config: IAdeOrganizationConfig,
	params: {
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
	},
): ICreateSubordinatePlan {
	const parsed = parseOrchestrationGraph(rawOrchestrationText);
	if (parsed.error && rawOrchestrationText.trim().length > 0) {
		return { ok: false, code: 'INVALID_GRAPH', error: parsed.error };
	}

	const sortedRanks = [...config.ranks].sort((a, b) => a.tier - b.tier);
	if (sortedRanks.length === 0) {
		return { ok: false, code: 'INVALID_RANK', error: 'Organization schema has no configured ranks.' };
	}

	const callerNode = params.callerNodeId ? parsed.nodes.find(n => n.id === params.callerNodeId && n.kind === 'staff') : undefined;
	const effectiveCallerTier = params.isHumanUser ? -1 : params.isSecretary ? 0 : (params.callerTier ?? callerNode?.tier);
	const immediateNextRank = effectiveCallerTier !== undefined
		? sortedRanks.find(r => r.tier > effectiveCallerTier)
		: sortedRanks[0];

	if (!params.isHumanUser && !params.isSecretary) {
		if (effectiveCallerTier === undefined) {
			return { ok: false, code: 'FORBIDDEN', error: 'Unable to determine caller rank tier for subordinate creation.' };
		}
		const callerRankDef = sortedRanks.find(r => r.tier === effectiveCallerTier);
		const lowestTier = sortedRanks[sortedRanks.length - 1].tier;
		if (effectiveCallerTier >= lowestTier || !immediateNextRank || (callerRankDef && !callerRankDef.canHaveSubordinates)) {
			return {
				ok: false,
				code: 'FORBIDDEN',
				error: `Rank L${effectiveCallerTier}${callerRankDef ? ` (${callerRankDef.name})` : ''} cannot dynamically create lower-tier subordinates.`,
			};
		}
	}

	// Resolve target subordinate rank
	let resolvedRank: IAdeRankDefinition | undefined;
	if (params.targetRankIdOrTier !== undefined && String(params.targetRankIdOrTier).trim() !== '') {
		const raw = String(params.targetRankIdOrTier).trim();
		const tierMatch = /^L?(\d+)$/i.exec(raw);
		if (tierMatch) {
			const t = Number.parseInt(tierMatch[1], 10);
			resolvedRank = sortedRanks.find(r => r.tier === t);
		} else {
			resolvedRank = sortedRanks.find(r => r.id.toLowerCase() === raw.toLowerCase() || r.name.toLowerCase() === raw.toLowerCase());
		}
		if (!resolvedRank) {
			return { ok: false, code: 'INVALID_RANK', error: `Unknown target rank "${raw}".` };
		}
	} else {
		resolvedRank = immediateNextRank ?? sortedRanks[sortedRanks.length - 1];
	}

	if (!params.isHumanUser && !params.isSecretary && effectiveCallerTier !== undefined) {
		if (resolvedRank.tier <= effectiveCallerTier) {
			return {
				ok: false,
				code: 'FORBIDDEN',
				error: `Hierarchy violation: caller (L${effectiveCallerTier}) can only create strictly lower-tier subordinates (requested L${resolvedRank.tier} ${resolvedRank.name}).`,
			};
		}
		if (immediateNextRank && resolvedRank.tier !== immediateNextRank.tier) {
			return {
				ok: false,
				code: 'RANK_SKIP_FORBIDDEN',
				error: `RANK_SKIP_FORBIDDEN: caller (L${effectiveCallerTier}) cannot skip ranks to create L${resolvedRank.tier} (${resolvedRank.name}); immediate subordinate tier is L${immediateNextRank.tier} (${immediateNextRank.name}).`,
			};
		}
	}

	const requestedDept = params.department?.trim();
	const callerDept = callerNode?.department?.trim();
	if (
		!params.isHumanUser
		&& !params.isSecretary
		&& callerDept
		&& !isCompanyWideExecutiveDept(callerDept)
		&& requestedDept
		&& requestedDept.toLowerCase() !== callerDept.toLowerCase()
	) {
		return {
			ok: false,
			code: 'CROSS_DEPARTMENT_FORBIDDEN',
			error: `CROSS_DEPARTMENT_FORBIDDEN: staff "${callerNode?.id}" in department "${callerDept}" cannot create subordinates in foreign department "${requestedDept}".`,
		};
	}

	const department = requestedDept || callerDept;
	const added = addStaffNodeToOrchestration(rawOrchestrationText, {
		id: params.id,
		name: params.name,
		roleLabel: params.roleLabel?.trim() || resolvedRank.name,
		tier: resolvedRank.tier,
		rankId: resolvedRank.id,
		department,
		engineId: params.engineId,
		model: params.model,
		thinking: params.thinking,
		hostAlias: params.hostAlias,
		rolePrompt: params.rolePrompt,
		allowedPaths: params.allowedPaths,
		checks: params.checks,
		color: params.color,
		direction: parsed.direction,
	});
	if (!added.ok || !added.nodeId || !added.orchestrationText) {
		return {
			ok: false,
			code: added.error?.includes('already exists') ? 'DUPLICATE_EMPLOYEE' : 'INVALID_GRAPH',
			error: added.error ?? 'Failed to add subordinate staff node.',
		};
	}

	let finalText = added.orchestrationText;
	if (callerNode) {
		const wired = connectOrchestrationEdge(finalText, callerNode.id, added.nodeId, {
			bidirectional: params.bidirectional !== false,
			label: params.edgeLabel?.trim() || undefined,
		});
		if (wired.ok && wired.orchestrationText) {
			finalText = wired.orchestrationText;
		}
	}

	return {
		ok: true,
		newNodeId: added.nodeId,
		resolvedRank,
		orchestrationText: finalText,
	};
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

/**
 * Pure planner & validator for dynamic runtime subordinate removal on the Orchestration canvas:
 * - Enforces superior-only removal, no self-removal, NO rank-skipping (`target.tier === immediateNextTier`),
 *   NO cross-department removal, direct-subordinate verification, and active-subordinate guard.
 * - Re-serializes the graph cleanly via `serializeOrchestrationGraph` (zero fragile regex corruption).
 */
export function planDynamicSubordinateRemoval(
	rawOrchestrationText: string,
	config: IAdeOrganizationConfig,
	params: {
		readonly targetNodeId: string;
		readonly callerNodeId?: string;
		readonly callerTier?: number;
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly force?: boolean;
		readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
	},
): IRemoveSubordinatePlan {
	const parsed = parseOrchestrationGraph(rawOrchestrationText);
	if (parsed.error) {
		return { ok: false, code: 'INVALID_GRAPH', error: parsed.error };
	}
	const targetId = params.targetNodeId.trim();
	const targetNode = parsed.nodes.find(n => n.id === targetId && n.kind === 'staff');
	if (!targetNode) {
		return { ok: false, code: 'NOT_FOUND', error: `Staff node "${targetId}" not found on Orchestration canvas.` };
	}
	if (params.callerNodeId && params.callerNodeId.trim() === targetId && !params.isHumanUser && !params.isSecretary) {
		return { ok: false, code: 'FORBIDDEN', error: `Staff node "${targetId}" cannot remove itself.` };
	}

	const sortedRanks = [...config.ranks].sort((a, b) => a.tier - b.tier);
	const callerNode = params.callerNodeId ? parsed.nodes.find(n => n.id === params.callerNodeId && n.kind === 'staff') : undefined;
	const effectiveCallerTier = params.isHumanUser ? -1 : params.isSecretary ? 0 : (params.callerTier ?? callerNode?.tier);

	if (!params.isHumanUser && !params.isSecretary) {
		if (effectiveCallerTier === undefined) {
			return { ok: false, code: 'FORBIDDEN', error: 'Unable to determine caller rank tier for subordinate removal.' };
		}
		const callerRankDef = sortedRanks.find(r => r.tier === effectiveCallerTier);
		const immediateNextRank = sortedRanks.find(r => r.tier > effectiveCallerTier);
		if (!immediateNextRank || (callerRankDef && !callerRankDef.canHaveSubordinates)) {
			return {
				ok: false,
				code: 'FORBIDDEN',
				error: `Rank L${effectiveCallerTier}${callerRankDef ? ` (${callerRankDef.name})` : ''} cannot remove subordinates.`,
			};
		}
		if (targetNode.tier !== undefined) {
			if (targetNode.tier <= effectiveCallerTier) {
				return {
					ok: false,
					code: 'FORBIDDEN',
					error: `Hierarchy violation: caller (L${effectiveCallerTier}) cannot remove equal/higher-rank staff "${targetId}" (L${targetNode.tier}).`,
				};
			}
			if (targetNode.tier !== immediateNextRank.tier) {
				return {
					ok: false,
					code: 'RANK_SKIP_FORBIDDEN',
					error: `RANK_SKIP_FORBIDDEN: caller (L${effectiveCallerTier}) cannot skip ranks to remove "${targetId}" (L${targetNode.tier}); only immediate subordinate tier L${immediateNextRank.tier} (${immediateNextRank.name}) may be removed.`,
				};
			}
		}
		const callerDept = callerNode?.department?.trim();
		const targetDept = targetNode.department?.trim();
		if (
			callerDept
			&& !isCompanyWideExecutiveDept(callerDept)
			&& (!targetDept || targetDept.toLowerCase() !== callerDept.toLowerCase())
		) {
			return {
				ok: false,
				code: 'CROSS_DEPARTMENT_FORBIDDEN',
				error: `CROSS_DEPARTMENT_FORBIDDEN: staff "${callerNode?.id}" in department "${callerDept}" cannot remove "${targetId}" in department "${targetDept || 'Unassigned'}".`,
			};
		}
		if (callerNode) {
			const hasDirectManagementEdge = parsed.edges.some(e => e.from === callerNode.id && e.to === targetId);
			const otherSuperiors = parsed.edges.filter(e => {
				if (e.to !== targetId || e.from === callerNode.id) {
					return false;
				}
				const src = parsed.nodes.find(n => n.id === e.from && n.kind === 'staff');
				return Boolean(src && src.tier !== undefined && targetNode.tier !== undefined && src.tier < targetNode.tier);
			});
			if (!hasDirectManagementEdge && otherSuperiors.length > 0) {
				return {
					ok: false,
					code: 'FORBIDDEN',
					error: `Staff "${targetId}" does not report directly to "${callerNode.id}".`,
				};
			}
		}
	}

	// Guard against orphaning active subordinates beneath a removed middle manager
	const activeSubordinateIds = parsed.edges
		.filter(e => e.from === targetId)
		.map(e => parsed.nodes.find(n => n.id === e.to && n.kind === 'staff'))
		.filter((n): n is IOrchestrationGraphNode => Boolean(
			n
			&& n.id !== targetId
			&& (targetNode.tier === undefined || n.tier === undefined || n.tier > targetNode.tier),
		))
		.map(n => n.id);
	const uniqueSubordinateIds = [...new Set(activeSubordinateIds)];
	if (uniqueSubordinateIds.length > 0 && !(params.force && params.isHumanUser)) {
		return {
			ok: false,
			code: 'HAS_ACTIVE_SUBORDINATES',
			activeSubordinateIds: uniqueSubordinateIds,
			error: `HAS_ACTIVE_SUBORDINATES: cannot remove "${targetId}" while it still manages lower-tier subordinate(s): ${uniqueSubordinateIds.join(', ')}. Remove or reassign subordinates first.`,
		};
	}

	const nextNodes = parsed.nodes.filter(n => n.id !== targetId);
	const nextEdges = parsed.edges.filter(e => e.from !== targetId && e.to !== targetId);
	const nextPositions = parsed.positions
		? Object.fromEntries(Object.entries(parsed.positions).filter(([k]) => k !== targetId))
		: undefined;
	const nextText = serializeOrchestrationGraph({
		direction: parsed.direction,
		layoutMode: parsed.layoutMode,
		nodes: nextNodes,
		edges: nextEdges,
		departments: parsed.departments,
		whiteboards: params.whiteboards,
		positions: nextPositions,
		includeAgentIds: true,
	});

	return {
		ok: true,
		removedNode: targetNode,
		orchestrationText: nextText,
	};
}

/**
 * Cleanly reclaims every in-flight token (`active` / `blocked` / `waiting_join`) held by a removed staff node:
 * - Marks each held token `'reclaimed'` with audit trail.
 * - Automatically settles any waiting join barrier (never deadlocking the superior!).
 * - For non-barrier tokens, bounces a recovery baton back to the surviving dispatching superior carrying
 *   ALL existing lightweight pointers (`contextRefs`, `whiteboardPointers`, `taskNodeId`) so zero work vanishes.
 * - Purges the removed node from `nodeStates`, `nodeAgentIds`, and `nodeReadCursors`.
 */
export function reclaimOrchestrationTokensForRemovedNode(
	state: IOrchestrationRuntimeState,
	graphAfterRemoval: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly removedNodeId: string;
		readonly reclaimedBy?: string;
		readonly reason?: string;
		readonly fallbackSupervisorNodeId?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{
	readonly reclaimedTokenIds: readonly string[];
	readonly recoveryTokenIds: readonly string[];
	readonly settledBarrierIds: readonly string[];
	readonly reparentedTokenIds: readonly string[];
}> {
	const removedId = params.removedNodeId.trim();
	const now = params.now ?? Date.now();
	const reason = params.reason?.trim() || `Staff node "${removedId}" removed at runtime`;
	const survivingStaffIds = new Set(graphAfterRemoval.nodes.filter(n => n.kind === 'staff').map(n => n.id));

	let workingState: IOrchestrationRuntimeState = state;
	const allEffects: OrchestrationEngineEffect[] = [];
	const reclaimedTokenIds: string[] = [];
	const recoveryTokenIds: string[] = [];
	const settledBarrierIds: string[] = [];
	const reparentedTokenIds: string[] = [];

	const inFlightHeld = Object.values(state.tokens).filter(
		t => t.nodeId === removedId && (t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join'),
	);

	for (const tok of inFlightHeld) {
		const liveTok = workingState.tokens[tok.id];
		if (!liveTok) {
			continue;
		}
		reclaimedTokenIds.push(liveTok.id);
		const traceSeq = workingState.traceSeq + 1;
		const reclaimTracePtr = `otrc-${traceSeq}`;
		const nextHop = (liveTok.hopIndex ?? Math.max(0, (liveTok.hopLog?.length ?? 1) - 1)) + 1;
		const headline = buildCompactHeadline(`Reclaimed from removed staff "${removedId}": ${reason}`).headline;
		const reclaimedToken: IOrchestrationToken = {
			...liveTok,
			status: 'reclaimed',
			blocked: undefined,
			joinBarrierId: undefined,
			reclaimedReason: reason,
			...(params.reclaimedBy ? { reclaimedBy: params.reclaimedBy } : {}),
			hopIndex: nextHop,
			hopLog: [...(liveTok.hopLog ?? []), {
				hop: nextHop,
				tokenId: liveTok.id,
				fromNodeId: removedId,
				toNodeId: removedId,
				event: 'reclaim',
				headline,
				timestamp: now,
			}],
			lastActivityAt: now,
		};

		// Also abort any waiting join barrier owned by the removed node itself
		const nextBarriers: Record<string, IOrchestrationJoinBarrier> = { ...(workingState.joinBarriers ?? {}) };
		if (liveTok.joinBarrierId && nextBarriers[liveTok.joinBarrierId]?.status === 'waiting') {
			nextBarriers[liveTok.joinBarrierId] = {
				...nextBarriers[liveTok.joinBarrierId],
				status: 'aborted',
			};
		}

		workingState = {
			...workingState,
			tokens: {
				...workingState.tokens,
				[liveTok.id]: reclaimedToken,
			},
			joinBarriers: nextBarriers,
			traces: {
				...workingState.traces,
				[reclaimTracePtr]: {
					ptr: reclaimTracePtr,
					parentPtrs: [liveTok.tracePtr],
					nodeId: removedId,
					employeeId: liveTok.holderAgentId,
					waveId: liveTok.waveId,
					event: 'recall',
					summary: headline,
					timestamp: now,
				},
			},
			traceSeq,
			updatedAt: now,
		};

		// Case 1: Token belonged to an upstream join barrier -> settle the barrier cleanly!
		if (liveTok.parentJoinBarrierId && workingState.joinBarriers?.[liveTok.parentJoinBarrierId]?.status === 'waiting') {
			const settled = settleJoinBarrierIfApplicable(workingState, graphAfterRemoval, whiteboards, config, {
				childToken: reclaimedToken,
				outcome: 'reclaimed',
				summary: headline,
				now,
			});
			workingState = settled.state;
			allEffects.push(...settled.effects);
			if (settled.barrierSatisfied) {
				settledBarrierIds.push(liveTok.parentJoinBarrierId);
			}
			continue;
		}

		// Case 2: Non-barrier token -> bounce recovery baton to surviving superior so context/work is never lost!
		const candidateSuperiors = [
			params.fallbackSupervisorNodeId,
			liveTok.returnToNodeId,
			liveTok.originNodeId !== 'User' ? liveTok.originNodeId : undefined,
			liveTok.fromNodeId,
			findHighestRankStaffNode(graphAfterRemoval)?.id,
		].filter((id): id is string => Boolean(id && id !== removedId && survivingStaffIds.has(id)));
		const targetSupervisorId = candidateSuperiors[0];
		if (targetSupervisorId) {
			const supNode = graphAfterRemoval.nodes.find(n => n.id === targetSupervisorId && n.kind === 'staff')!;
			const supAgentId = workingState.nodeAgentIds[targetSupervisorId] ?? supNode.agentId;
			const nextTokenSeq = workingState.tokenSeq + 1;
			const nextTraceSeq = workingState.traceSeq + 1;
			const recoveryTokenId = `otok-${nextTokenSeq}`;
			const recoveryTracePtr = `otrc-${nextTraceSeq}`;
			const recoveryHeadline = buildCompactHeadline(`[Reclaimed from removed ${removedId}] ${liveTok.lastSummary}`).headline;
			const recoveryHop: IOrchestrationHopLedgerEntry = {
				hop: nextHop + 1,
				tokenId: recoveryTokenId,
				fromNodeId: removedId,
				toNodeId: targetSupervisorId,
				event: 'reclaim',
				headline: recoveryHeadline,
				...(liveTok.payloadPtr ? { payloadPtr: liveTok.payloadPtr } : {}),
				timestamp: now,
			};
			const recoveryToken: IOrchestrationToken = {
				id: recoveryTokenId,
				waveId: liveTok.waveId,
				nodeId: targetSupervisorId,
				fromNodeId: removedId,
				holderAgentId: supAgentId,
				status: 'active',
				parentTokenId: liveTok.id,
				rootTokenId: liveTok.rootTokenId ?? liveTok.id,
				originNodeId: liveTok.originNodeId,
				dispatchKind: 'return',
				...(liveTok.taskNodeId ? { taskNodeId: liveTok.taskNodeId } : {}),
				...(liveTok.taskNodeIds ? { taskNodeIds: liveTok.taskNodeIds } : {}),
				hopIndex: nextHop + 1,
				lastSummary: recoveryHeadline,
				...(liveTok.payloadPtr ? { payloadPtr: liveTok.payloadPtr } : {}),
				hopLog: [...(reclaimedToken.hopLog ?? []), recoveryHop],
				contextRefs: liveTok.contextRefs ?? [],
				compressedHistory: liveTok.compressedHistory,
				historyState: liveTok.historyState,
				tracePtr: recoveryTracePtr,
				...(liveTok.whiteboardPointers ? { whiteboardPointers: liveTok.whiteboardPointers } : {}),
				arrivedAt: now,
				lastActivityAt: now,
				nudgeCount: 0,
			};
			const nextTokens = { ...workingState.tokens, [recoveryTokenId]: recoveryToken };
			workingState = {
				...workingState,
				tokens: nextTokens,
				nodeStates: {
					...workingState.nodeStates,
					[targetSupervisorId]: recomputeOrchestrationNodeState(nextTokens, targetSupervisorId),
				},
				traces: {
					...workingState.traces,
					[recoveryTracePtr]: {
						ptr: recoveryTracePtr,
						parentPtrs: [reclaimTracePtr],
						nodeId: targetSupervisorId,
						employeeId: supAgentId,
						waveId: liveTok.waveId,
						event: 'mint',
						summary: recoveryHeadline,
						timestamp: now,
					},
				},
				tokenSeq: nextTokenSeq,
				traceSeq: nextTraceSeq,
				updatedAt: now,
			};
			recoveryTokenIds.push(recoveryTokenId);
			const delta = buildOrchestrationTokenDeltaView(workingState, recoveryToken, whiteboards);
			const outgoingStaffIds = graphAfterRemoval.edges
				.filter(e => e.from === targetSupervisorId && graphAfterRemoval.nodes.some(n => n.id === e.to && n.kind === 'staff'))
				.map(e => e.to);
			const subordinateTargetIds = outgoingStaffIds.filter(outId => {
				const outNode = graphAfterRemoval.nodes.find(n => n.id === outId && n.kind === 'staff');
				return Boolean(outNode && (supNode.tier === undefined || outNode.tier === undefined || outNode.tier > supNode.tier));
			});
			const highest = getHighestRankInSchema(config);
			const isHighest = supNode.tier !== undefined ? supNode.tier === highest.tier : supNode.id === findHighestRankStaffNode(graphAfterRemoval)?.id;
			allEffects.push({
				kind: 'dispatch_token',
				missionId: workingState.missionId,
				nodeId: targetSupervisorId,
				tokenId: recoveryTokenId,
				holderAgentId: supAgentId,
				prompt: composeOrchestrationTokenWakeupPrompt(workingState.missionId, supNode, recoveryToken, outgoingStaffIds, isHighest, delta, { subordinateTargetIds }),
			});
		}
	}

	// Re-parent any surviving child tokens held by lower-tier staff whose return target or join barrier belonged to `removedId`
	const removedOwnedBarrierIds = new Set(
		Object.values(workingState.joinBarriers ?? {})
			.filter(b => b.ownerNodeId === removedId)
			.map(b => b.id),
	);
	const defaultFallbackSupervisorId = [
		params.fallbackSupervisorNodeId,
		...inFlightHeld.map(t => t.returnToNodeId),
		...inFlightHeld.map(t => (t.originNodeId && t.originNodeId !== 'User' ? t.originNodeId : undefined)),
		...inFlightHeld.map(t => t.fromNodeId),
		findHighestRankStaffNode(graphAfterRemoval)?.id,
	].find((id): id is string => Boolean(id && id !== removedId && survivingStaffIds.has(id)));

	let reparentedTokensMap: Record<string, IOrchestrationToken> | undefined;
	for (const tok of Object.values(workingState.tokens)) {
		if (tok.nodeId === removedId || (tok.status !== 'active' && tok.status !== 'blocked' && tok.status !== 'waiting_join')) {
			continue;
		}
		const orphanedReturn = tok.returnToNodeId === removedId;
		const orphanedOrigin = tok.originNodeId === removedId;
		const orphanedBarrier = Boolean(tok.parentJoinBarrierId && removedOwnedBarrierIds.has(tok.parentJoinBarrierId));
		if (!orphanedReturn && !orphanedOrigin && !orphanedBarrier) {
			continue;
		}
		const reparentTarget = [
			defaultFallbackSupervisorId,
			...[...(tok.hopLog ?? [])].reverse().map(h => h.fromNodeId),
			findHighestRankStaffNode(graphAfterRemoval)?.id,
		].find((id): id is string => Boolean(id && id !== removedId && id !== tok.nodeId && survivingStaffIds.has(id)));

		reparentedTokensMap ??= { ...workingState.tokens };
		reparentedTokensMap[tok.id] = {
			...tok,
			...(reparentTarget ? { returnToNodeId: reparentTarget } : { returnToNodeId: undefined }),
			...(orphanedOrigin ? { originNodeId: reparentTarget ?? 'User' } : {}),
			...(orphanedBarrier ? { parentJoinBarrierId: undefined } : {}),
			lastActivityAt: now,
		};
		reparentedTokenIds.push(tok.id);
	}
	if (reparentedTokensMap) {
		workingState = {
			...workingState,
			tokens: reparentedTokensMap,
			updatedAt: now,
		};
	}

	// Purge removed node from nodeStates, nodeAgentIds, and nodeReadCursors
	const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = {};
	for (const [k, v] of Object.entries(workingState.nodeStates)) {
		if (k !== removedId) {
			nextNodeStates[k] = v;
		}
	}
	const nextNodeAgentIds: Record<string, string> = {};
	for (const [k, v] of Object.entries(workingState.nodeAgentIds)) {
		if (k !== removedId) {
			nextNodeAgentIds[k] = v;
		}
	}
	const nextCursors: Record<string, IOrchestrationNodeReadCursor> = {};
	for (const [k, v] of Object.entries(workingState.nodeReadCursors ?? {})) {
		if (!k.endsWith(`:${removedId}`)) {
			nextCursors[k] = v;
		}
	}

	return {
		ok: true,
		state: {
			...workingState,
			nodeStates: nextNodeStates,
			nodeAgentIds: nextNodeAgentIds,
			nodeReadCursors: nextCursors,
			updatedAt: now,
		},
		effects: allEffects,
		data: {
			reclaimedTokenIds,
			recoveryTokenIds,
			settledBarrierIds,
			reparentedTokenIds,
		},
	};
}

// ============================================================================
// 5. State Bloat Governance: Cold Blob Externalization & Terminal History Archiving
// ============================================================================

export type IOrchestrationArchiveEntry =
	| { readonly kind: 'token'; readonly archivedAt: number; readonly token: IOrchestrationToken }
	| { readonly kind: 'trace'; readonly archivedAt: number; readonly trace: IMissionTraceNode };

export interface IOrchestrationCompactionResult {
	readonly compactedState: IOrchestrationRuntimeState;
	readonly blobsToExternalize: readonly IOrchestrationContextBlob[];
	readonly archiveEntries: readonly IOrchestrationArchiveEntry[];
	readonly didCompact: boolean;
}

const DEFAULT_HOT_BLOB_MAX_CHARS = 1024;
const DEFAULT_MAX_HOT_TERMINAL_TOKENS = 80;
const DEFAULT_MAX_HOT_TRACES = 200;

/**
 * Governs Orchestration JSON state size by:
 * 1. Extracting cold/large `payloadStore` blobs into `blobsToExternalize` (stored individually under
 *    `<adeHome>/missions/<safe>.blobs/<ptr>.json`) while preserving lightweight index metadata in
 *    `state.externalizedBlobIndex[ptr]` for transparent cold reads.
 * 2. Archiving excess terminal tokens (`handed_off`/`completed`/`failed`/`reclaimed`/`aborted`) and
 *    old traces beyond hot retention budgets into `archiveEntries` (appended to `.archive.jsonl`).
 */
export function compactOrchestrationRuntimeState(
	state: IOrchestrationRuntimeState,
	options?: {
		readonly hotBlobMaxChars?: number;
		readonly maxHotTerminalTokens?: number;
		readonly maxHotTraces?: number;
		readonly now?: number;
	},
): IOrchestrationCompactionResult {
	const hotBlobMaxChars = options?.hotBlobMaxChars ?? DEFAULT_HOT_BLOB_MAX_CHARS;
	const maxHotTerminalTokens = options?.maxHotTerminalTokens ?? DEFAULT_MAX_HOT_TERMINAL_TOKENS;
	const maxHotTraces = options?.maxHotTraces ?? DEFAULT_MAX_HOT_TRACES;
	const now = options?.now ?? Date.now();

	const activePtrs = new Set<string>();
	const activeTracePtrs = new Set<string>();
	for (const tok of Object.values(state.tokens)) {
		if (tok.status === 'active' || tok.status === 'blocked' || tok.status === 'waiting_join') {
			if (tok.payloadPtr) { activePtrs.add(tok.payloadPtr); }
			if (tok.tracePtr) { activeTracePtrs.add(tok.tracePtr); }
			for (const ref of tok.contextRefs ?? []) {
				if (ref.kind !== 'whiteboard') {
					activePtrs.add(ref.ptr);
				}
			}
		}
	}

	// 1. Externalize cold or large payloadStore blobs
	const nextPayloadStore: Record<string, IOrchestrationContextBlob> = {};
	const nextExtIndex: Record<string, IOrchestrationExternalizedBlobMeta> = { ...(state.externalizedBlobIndex ?? {}) };
	const blobsToExternalize: IOrchestrationContextBlob[] = [];
	for (const [ptr, blob] of Object.entries(state.payloadStore ?? {})) {
		const isColdOrLarge = (!activePtrs.has(ptr) && blob.sizeChars >= 256) || blob.sizeChars > hotBlobMaxChars;
		if (isColdOrLarge) {
			blobsToExternalize.push(blob);
			nextExtIndex[ptr] = {
				ptr: blob.ptr,
				kind: blob.kind,
				title: blob.title,
				sizeChars: blob.sizeChars,
				digest: blob.digest,
				...(blob.authorNodeId ? { authorNodeId: blob.authorNodeId } : {}),
				...(blob.authorAgentId ? { authorAgentId: blob.authorAgentId } : {}),
				hop: blob.hop,
				waveId: blob.waveId,
				createdAt: blob.createdAt,
			};
		} else {
			nextPayloadStore[ptr] = blob;
		}
	}

	// 2. Archive excess terminal tokens beyond hot retention
	const archiveEntries: IOrchestrationArchiveEntry[] = [];
	const allTokens = Object.values(state.tokens);
	const terminalTokens = allTokens
		.filter(t => t.status !== 'active' && t.status !== 'blocked' && t.status !== 'waiting_join')
		.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
	const archiveTokenIds = new Set<string>();
	if (terminalTokens.length > maxHotTerminalTokens) {
		const excess = terminalTokens.length - maxHotTerminalTokens;
		for (let i = 0; i < excess; i++) {
			archiveTokenIds.add(terminalTokens[i].id);
			archiveEntries.push({ kind: 'token', archivedAt: now, token: terminalTokens[i] });
		}
	}
	const nextTokens: Record<string, IOrchestrationToken> = {};
	for (const [tid, tok] of Object.entries(state.tokens)) {
		if (!archiveTokenIds.has(tid)) {
			nextTokens[tid] = tok;
		}
	}

	// 3. Archive excess old traces not referenced by active tokens
	const allTraces = Object.values(state.traces);
	const archiveTracePtrs = new Set<string>();
	if (allTraces.length > maxHotTraces) {
		const candidates = allTraces
			.filter(tr => !activeTracePtrs.has(tr.ptr))
			.sort((a, b) => a.timestamp - b.timestamp);
		const excess = allTraces.length - maxHotTraces;
		for (let i = 0; i < Math.min(excess, candidates.length); i++) {
			archiveTracePtrs.add(candidates[i].ptr);
			archiveEntries.push({ kind: 'trace', archivedAt: now, trace: candidates[i] });
		}
	}
	const nextTraces: Record<string, IMissionTraceNode> = {};
	for (const [ptr, tr] of Object.entries(state.traces)) {
		if (!archiveTracePtrs.has(ptr)) {
			nextTraces[ptr] = tr;
		}
	}

	const didCompact = blobsToExternalize.length > 0 || archiveEntries.length > 0;
	if (!didCompact) {
		return { compactedState: state, blobsToExternalize: [], archiveEntries: [], didCompact: false };
	}

	return {
		compactedState: {
			...state,
			tokens: nextTokens,
			traces: nextTraces,
			payloadStore: nextPayloadStore,
			externalizedBlobIndex: nextExtIndex,
			archivedTokenCount: (state.archivedTokenCount ?? 0) + archiveTokenIds.size,
			archivedTraceCount: (state.archivedTraceCount ?? 0) + archiveTracePtrs.size,
		},
		blobsToExternalize,
		archiveEntries,
		didCompact: true,
	};
}

export function planDynamicWhiteboardCreation(
	rawOrchestrationText: string,
	params: {
		readonly id?: string;
		readonly title: string;
		readonly department: string;
		readonly connectFromNodeId?: string;
	},
): { readonly ok: boolean; readonly whiteboardId?: string; readonly orchestrationText?: string; readonly error?: string } {
	const added = addWhiteboardNodeToOrchestration(rawOrchestrationText, {
		id: params.id,
		title: params.title,
		department: params.department,
	});
	if (!added.ok || !added.whiteboardId || !added.orchestrationText) {
		return added;
	}
	let finalText = added.orchestrationText;
	if (params.connectFromNodeId?.trim()) {
		const wired = connectOrchestrationEdge(finalText, params.connectFromNodeId.trim(), added.whiteboardId, {
			label: 'whiteboard',
		});
		if (wired.ok && wired.orchestrationText) {
			finalText = wired.orchestrationText;
		}
	}
	return {
		ok: true,
		whiteboardId: added.whiteboardId,
		orchestrationText: finalText,
	};
}

/**
 * Helper to verify that a serialized Orchestration token payload contains ZERO full body text
 * from either Department Whiteboards or `payloadStore` blobs (strict lightweight pointer invariant).
 */
export function isLightweightOrchestrationToken(
	token: IOrchestrationToken,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	payloadStore?: Readonly<Record<string, IOrchestrationContextBlob>>,
): boolean {
	if (token.lastSummary.length > ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS + 4) {
		return false;
	}
	for (const ref of token.contextRefs ?? []) {
		if ('content' in (ref as unknown as Record<string, unknown>)) {
			return false;
		}
	}
	for (const ptr of token.whiteboardPointers ?? []) {
		if ('content' in (ptr as unknown as Record<string, unknown>)) {
			return false;
		}
		if (whiteboards) {
			const wb = whiteboards[ptr.whiteboardId];
			if (wb && wb.content.length >= 24 && token.lastSummary.includes(wb.content)) {
				return false;
			}
		}
	}
	if (payloadStore) {
		for (const ref of token.contextRefs ?? []) {
			if (ref.kind === 'whiteboard') {
				continue;
			}
			const blob = payloadStore[ref.ptr];
			if (blob && blob.content.length > ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS && token.lastSummary.includes(blob.content)) {
				return false;
			}
		}
	}
	return true;
}

export { parseOrchestrationGraph };
