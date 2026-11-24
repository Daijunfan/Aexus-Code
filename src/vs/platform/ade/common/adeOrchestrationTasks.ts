/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMissionDagNode, IMissionDagParseResult } from './adeMissionDag.js';
import { IOrchestrationGraphNode, IOrchestrationGraphParseResult } from './adeOrchestrationGraph.js';
import {
	getHighestRankInSchema,
	IMissionTaskCheckReceipt,
	IMissionTaskStatusRecord,
	IMissionTaskStatusTransitionResult,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationWhiteboard,
	isCompanyWideExecutiveDept,
	isHighestRankTaskCompleter,
	ITaskBindingValidationResult,
	MissionTaskStatus,
	resolveEffectiveStaffTier,
} from './adeOrchestrationTypes.js';
import { IAdeOrganizationConfig } from './adeRoleSchema.js';

/**
 * Evaluates fine-grained per-node Mission Task DAG completion authority:
 * 1. Human User (L-1) or highest-rank role (normally L1) is ALWAYS permitted.
 * 2. Explicit per-node allowlist (`allowedCompleterNodeIds`) or `ownerNodeId` matches `callerNodeId`.
 * 3. Explicit per-node `minCompleterTier` allows any rank with `callerTier <= minCompleterTier`
 *    (scoped to `taskNode.department` when both task & caller specify non-executive departments).
 * 4. Direct or transitive Orchestration superior of the task's `assigneeNodeId` within department scope.
 */
export function canCallerCompleteMissionTask(
	config: IAdeOrganizationConfig,
	taskNode: IMissionDagNode,
	caller: {
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
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
	const staffById = new Map<string, IOrchestrationGraphNode>();
	for (const n of orchGraph?.nodes ?? []) {
		if (n.kind === 'staff') {
			staffById.set(n.id, n);
		}
	}
	const callerNode = callerNodeId ? staffById.get(callerNodeId) : undefined;
	const effectiveTier = (callerNode ? resolveEffectiveStaffTier(callerNode, config) : undefined) ?? caller.callerTier;

	if (callerNodeId && taskNode.allowedCompleterNodeIds?.includes(callerNodeId)) {
		return true;
	}
	if (callerNodeId && taskNode.ownerNodeId && taskNode.ownerNodeId === callerNodeId) {
		return true;
	}
	if (taskNode.minCompleterTier !== undefined) {
		if (effectiveTier === undefined || effectiveTier > taskNode.minCompleterTier) {
			return false;
		}
		if (taskNode.department) {
			const callerDept = callerNode?.department?.trim();
			if (!callerDept) {
				return false;
			}
			if (
				!isCompanyWideExecutiveDept(callerDept)
				&& taskNode.department.trim().toLowerCase() !== callerDept.toLowerCase()
			) {
				return false;
			}
		}
		return true;
	}
	const effectiveAssigneeId = currentRecord?.assigneeNodeId ?? taskNode.assigneeNodeId;
	if (callerNodeId && effectiveAssigneeId && orchGraph && effectiveTier !== undefined) {
		const callerRank = config.ranks.find(r => r.tier === effectiveTier);
		if (callerRank && !callerRank.pureExecution && callerRank.canHaveSubordinates) {
			const assigneeNode = staffById.get(effectiveAssigneeId);
			const assigneeTier = assigneeNode ? resolveEffectiveStaffTier(assigneeNode, config) : undefined;
			const strictlyHigher = assigneeTier !== undefined && effectiveTier < assigneeTier;
			const callerDept = callerNode?.department?.trim();
			const assigneeDept = assigneeNode?.department?.trim();
			const deptOk = !assigneeDept
				|| Boolean(
					callerDept
					&& (isCompanyWideExecutiveDept(callerDept) || callerDept.toLowerCase() === assigneeDept.toLowerCase()),
				);
			if (assigneeNode && strictlyHigher && deptOk) {
				const outgoingByNode = new Map<string, string[]>();
				for (const e of orchGraph.edges) {
					if (!staffById.has(e.from) || !staffById.has(e.to)) {
						continue;
					}
					let list = outgoingByNode.get(e.from);
					if (!list) {
						list = [];
						outgoingByNode.set(e.from, list);
					}
					list.push(e.to);
				}
				const visited = new Set<string>([callerNodeId]);
				const queue: string[] = [callerNodeId];
				while (queue.length > 0) {
					const cur = queue.shift()!;
					const curNode = staffById.get(cur);
					const curTier = curNode ? resolveEffectiveStaffTier(curNode, config) : undefined;
					for (const nxtId of outgoingByNode.get(cur) ?? []) {
						if (visited.has(nxtId)) {
							continue;
						}
						const nxt = staffById.get(nxtId);
						if (!nxt) {
							continue;
						}
						const nxtTier = resolveEffectiveStaffTier(nxt, config);
						if (curTier !== undefined && nxtTier !== undefined && nxtTier <= curTier) {
							continue;
						}
						if (
							callerDept
							&& !isCompanyWideExecutiveDept(callerDept)
							&& nxt.department
							&& nxt.department.trim().toLowerCase() !== callerDept.toLowerCase()
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

export interface ITaskCompletionContractEvaluationResult {
	readonly ok: boolean;
	readonly unmetRequirements: readonly string[];
	readonly error?: string;
}

/**
 * Evaluates a Mission Task DAG node's deterministic completion contract (`completionContract` + declared `checks`)
 * before marking the task `completed`. Prevents agents from hallucinating completion without passing checks
 * or attaching required deliverables/whiteboards/files.
 */
export function evaluateTaskCompletionContract(params: {
	readonly taskNode: IMissionDagNode;
	readonly statusRecord?: IMissionTaskStatusRecord;
	readonly hasConfiguredChecks?: boolean;
	readonly checkReceipt?: IMissionTaskCheckReceipt;
	readonly evidenceSummary?: string;
	readonly artifactPtrs?: readonly string[];
	readonly touchedFiles?: readonly string[];
	readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
}): ITaskCompletionContractEvaluationResult {
	const { taskNode, statusRecord } = params;
	const contract = taskNode.completionContract;
	const hasChecks = Boolean(params.hasConfiguredChecks || (taskNode.checks && taskNode.checks.some(c => c.enabled !== false)));
	const requireChecks = contract?.requireChecksPassed !== undefined
		? contract.requireChecksPassed
		: (hasChecks && contract?.requireChecksPassed !== false);
	const unmet: string[] = [];

	if (requireChecks) {
		const receipt = params.checkReceipt ?? statusRecord?.lastCheckReceipt;
		if (!receipt) {
			unmet.push(`deterministic check(s) on "${taskNode.id}" have not been executed and passed yet`);
		} else if (!receipt.passed) {
			unmet.push(`latest deterministic check on "${taskNode.id}" FAILED (${receipt.summary || 'failed'})`);
		} else if (!params.checkReceipt && statusRecord?.lastReworkAt !== undefined && receipt.checkedAt < statusRecord.lastReworkAt) {
			unmet.push(`latest passing check receipt on "${taskNode.id}" predates subsequent rework/failure — re-run deterministic checks before completing`);
		}
	}

	if (contract?.requireArtifact) {
		const mergedArtifacts = [
			...(statusRecord?.artifactPtrs ?? []),
			...(params.artifactPtrs ?? []),
		].filter(Boolean);
		if (mergedArtifacts.length === 0) {
			unmet.push(`at least one --artifact or --decision pointer is required before completing "${taskNode.id}"`);
		}
	}

	if (contract?.requireFiles) {
		const mergedFiles = [
			...(statusRecord?.touchedFiles ?? []),
			...(params.touchedFiles ?? []),
		].filter(Boolean);
		if (mergedFiles.length === 0) {
			unmet.push(`at least one modified file (--files) must be reported before completing "${taskNode.id}"`);
		}
	}

	if (contract?.requiredWhiteboardIds && contract.requiredWhiteboardIds.length > 0) {
		for (const rawWbId of contract.requiredWhiteboardIds) {
			const wbId = rawWbId.trim().replace(/^wb:/i, '');
			if (!wbId) {
				continue;
			}
			const wb = params.whiteboards?.[wbId];
			if (!wb || !wb.content.trim()) {
				unmet.push(`required whiteboard "${wbId}" must exist with non-empty content`);
			}
		}
	}

	if (contract?.minSummaryChars && contract.minSummaryChars > 0) {
		const summaryText = (params.evidenceSummary?.trim() || statusRecord?.note || '').trim();
		if (summaryText.length < contract.minSummaryChars) {
			unmet.push(`completion summary/evidence must be at least ${contract.minSummaryChars} chars (got ${summaryText.length})`);
		}
	}

	if (unmet.length > 0) {
		return {
			ok: false,
			unmetRequirements: unmet,
			error: `COMPLETION_CONTRACT_UNMET: cannot complete Mission task "${taskNode.id}": ${unmet.join('; ')}.`,
		};
	}
	return { ok: true, unmetRequirements: [] };
}

/**
 * Persists a deterministic check suite verification receipt onto a Mission Task DAG node's status record.
 */
export function recordMissionTaskCheckReceipt(
	currentStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined,
	nodeId: string,
	receipt: IMissionTaskCheckReceipt,
): Readonly<Record<string, IMissionTaskStatusRecord>> {
	const existing = currentStatuses ?? {};
	const cleanId = nodeId.trim();
	if (!cleanId) {
		return existing;
	}
	const prev = existing[cleanId];
	return {
		...existing,
		[cleanId]: {
			...(prev ?? { status: 'pending' as const, updatedAt: receipt.checkedAt }),
			lastCheckReceipt: receipt,
			updatedAt: receipt.checkedAt,
		},
	};
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
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerSessionId?: string;
			readonly callerLabel?: string;
			readonly callerNodeId?: string;
		};
		readonly orchGraph?: IOrchestrationGraphParseResult;
		readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
		readonly hasConfiguredChecks?: boolean;
		readonly checkReceipt?: IMissionTaskCheckReceipt;
		readonly artifactPtrs?: readonly string[];
		readonly touchedFiles?: readonly string[];
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
	const callerNodeId = params.caller.callerNodeId?.trim();

	// Status rollback protection: non-completers cannot reset an already-completed task back to pending/in_progress/blocked
	if (prevRecord?.status === 'completed' && params.status !== 'completed') {
		const canRollback = params.caller.isHumanUser
			|| params.caller.isSecretary
			|| canCallerCompleteMissionTask(config, targetNode, params.caller, params.orchGraph, prevRecord);
		if (!canRollback) {
			return {
				ok: false,
				taskStatuses: existing,
				code: 'FORBIDDEN',
				error: `FORBIDDEN: Mission task "${nodeId}" is already completed; only an authorized task completer, Secretary, or Human User may reopen/reset its status.`,
			};
		}
	}

	// Gate approval guard: kind === 'gate' requires Human/Secretary unless explicitly allowlisted or forced by highest rank
	if (params.status === 'completed' && targetNode.kind === 'gate') {
		const explicitlyAllowed = Boolean(callerNodeId && targetNode.allowedCompleterNodeIds?.includes(callerNodeId));
		const gateAuthorized = Boolean(
			params.caller.isHumanUser
			|| params.caller.isSecretary
			|| explicitlyAllowed
			|| (params.force && isHighestRankTaskCompleter(config, params.caller)),
		);
		if (!gateAuthorized) {
			return {
				ok: false,
				taskStatuses: existing,
				code: 'FORBIDDEN',
				error: `FORBIDDEN: Human approval gate "${nodeId}" may only be completed by Human User, Secretary, or an explicitly allowlisted approver.`,
			};
		}
	}

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

	if (params.status === 'completed' && incompleteUpstreamTaskIds.length > 0 && !(params.force && (params.caller.isHumanUser || params.caller.isSecretary))) {
		return {
			ok: false,
			taskStatuses: existing,
			incompleteUpstreamTaskIds,
			code: 'INCOMPLETE_DEPENDENCIES',
			error: `INCOMPLETE_DEPENDENCIES: cannot mark Mission task "${nodeId}" completed while upstream prerequisite(s) are incomplete: ${incompleteUpstreamTaskIds.join(', ')}.`,
		};
	}

	if (params.status === 'completed' && !(params.force && (params.caller.isHumanUser || params.caller.isSecretary))) {
		const contractCheck = evaluateTaskCompletionContract({
			taskNode: targetNode,
			statusRecord: prevRecord,
			hasConfiguredChecks: params.hasConfiguredChecks,
			checkReceipt: params.checkReceipt,
			evidenceSummary: params.note,
			artifactPtrs: params.artifactPtrs,
			touchedFiles: params.touchedFiles,
			whiteboards: params.whiteboards,
		});
		if (!contractCheck.ok) {
			return {
				ok: false,
				taskStatuses: existing,
				unmetRequirements: contractCheck.unmetRequirements,
				code: 'COMPLETION_CONTRACT_UNMET',
				error: contractCheck.error,
			};
		}
	}

	const startedAt = prevRecord?.startedAt ?? (params.status === 'in_progress' ? now : undefined);
	const durationMs = params.status === 'completed' && startedAt !== undefined
		? Math.max(0, now - startedAt)
		: prevRecord?.durationMs;
	const mergedArtifacts = [...new Set([...(prevRecord?.artifactPtrs ?? []), ...(params.artifactPtrs ?? [])])];
	const mergedTouched = [...new Set([...(prevRecord?.touchedFiles ?? []), ...(params.touchedFiles ?? [])])];
	const nextReceipt = params.checkReceipt ?? prevRecord?.lastCheckReceipt;

	const nextRecord: IMissionTaskStatusRecord = {
		...(prevRecord ? {
			...(prevRecord.assigneeNodeId ? { assigneeNodeId: prevRecord.assigneeNodeId } : {}),
			...(prevRecord.assigneeLabel ? { assigneeLabel: prevRecord.assigneeLabel } : {}),
			...(prevRecord.activeTokenIds ? { activeTokenIds: prevRecord.activeTokenIds } : {}),
			...(prevRecord.lastTokenId ? { lastTokenId: prevRecord.lastTokenId } : {}),
		} : {}),
		...(mergedArtifacts.length > 0 ? { artifactPtrs: mergedArtifacts } : {}),
		...(mergedTouched.length > 0 ? { touchedFiles: mergedTouched } : {}),
		...(nextReceipt ? { lastCheckReceipt: nextReceipt } : {}),
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

function sameStringArray(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	const al = a?.length ?? 0;
	const bl = b?.length ?? 0;
	if (al !== bl) {
		return false;
	}
	if (al === 0) {
		return true;
	}
	for (let i = 0; i < al; i++) {
		if (a![i] !== b![i]) {
			return false;
		}
	}
	return true;
}

function compactTaskStatusRecord(rec: IMissionTaskStatusRecord): IMissionTaskStatusRecord {
	return {
		status: rec.status,
		...(rec.completedBy !== undefined ? { completedBy: rec.completedBy } : {}),
		...(rec.completedByLabel !== undefined ? { completedByLabel: rec.completedByLabel } : {}),
		...(rec.completedByTier !== undefined ? { completedByTier: rec.completedByTier } : {}),
		...(rec.completedAt !== undefined ? { completedAt: rec.completedAt } : {}),
		...(rec.note !== undefined ? { note: rec.note } : {}),
		...(rec.assigneeNodeId !== undefined ? { assigneeNodeId: rec.assigneeNodeId } : {}),
		...(rec.assigneeLabel !== undefined ? { assigneeLabel: rec.assigneeLabel } : {}),
		...(rec.activeTokenIds !== undefined && rec.activeTokenIds.length > 0 ? { activeTokenIds: rec.activeTokenIds } : {}),
		...(rec.lastTokenId !== undefined ? { lastTokenId: rec.lastTokenId } : {}),
		...(rec.startedAt !== undefined ? { startedAt: rec.startedAt } : {}),
		...(rec.durationMs !== undefined ? { durationMs: rec.durationMs } : {}),
		...(rec.artifactPtrs !== undefined && rec.artifactPtrs.length > 0 ? { artifactPtrs: rec.artifactPtrs } : {}),
		...(rec.touchedFiles !== undefined && rec.touchedFiles.length > 0 ? { touchedFiles: rec.touchedFiles } : {}),
		...(rec.lastCheckReceipt !== undefined ? { lastCheckReceipt: rec.lastCheckReceipt } : {}),
		...(rec.lastReworkAt !== undefined ? { lastReworkAt: rec.lastReworkAt } : {}),
		...(rec.blockedReason !== undefined ? { blockedReason: rec.blockedReason } : {}),
		...(rec.lastError !== undefined ? { lastError: rec.lastError } : {}),
		updatedAt: rec.updatedAt,
	};
}

function areTaskStatusRecordsEquivalent(a: IMissionTaskStatusRecord | undefined, b: IMissionTaskStatusRecord): boolean {
	if (!a) {
		return false;
	}
	return a.status === b.status
		&& a.assigneeNodeId === b.assigneeNodeId
		&& a.assigneeLabel === b.assigneeLabel
		&& a.lastTokenId === b.lastTokenId
		&& a.startedAt === b.startedAt
		&& a.completedBy === b.completedBy
		&& a.completedByLabel === b.completedByLabel
		&& a.completedByTier === b.completedByTier
		&& a.completedAt === b.completedAt
		&& a.note === b.note
		&& a.blockedReason === b.blockedReason
		&& a.lastError === b.lastError
		&& a.lastCheckReceipt?.passed === b.lastCheckReceipt?.passed
		&& a.lastCheckReceipt?.checkedAt === b.lastCheckReceipt?.checkedAt
		&& a.lastReworkAt === b.lastReworkAt
		&& sameStringArray(a.activeTokenIds, b.activeTokenIds)
		&& sameStringArray(a.artifactPtrs, b.artifactPtrs)
		&& sameStringArray(a.touchedFiles, b.touchedFiles);
}

/**
 * Bidirectional Mission Task DAG ↔ Orchestration Runtime synchronizer:
 * Automatically reflects live token bindings (`taskNodeId` / `taskNodeIds`) onto each Mission DAG
 * task card while strictly preserving authorized superior sign-off for `'completed'`.
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
		const hasOrchRoster = Boolean(orchGraph && !orchGraph.error && staffById.size > 0);
		if (!boundTokens || boundTokens.length === 0) {
			const prevAssigneeAlive = !prev?.assigneeNodeId || !hasOrchRoster || staffById.has(prev.assigneeNodeId);
			const staticAssigneeAlive = Boolean(taskNode.assigneeNodeId && (!hasOrchRoster || staffById.has(taskNode.assigneeNodeId)));
			const needsStaleClear = Boolean((prev?.activeTokenIds && prev.activeTokenIds.length > 0) || !prevAssigneeAlive);
			if (needsStaleClear) {
				const fallbackAssigneeId = staticAssigneeAlive ? taskNode.assigneeNodeId : undefined;
				const fallbackStaff = fallbackAssigneeId ? staffById.get(fallbackAssigneeId) : undefined;
				const nextClean: IMissionTaskStatusRecord = {
					...(prev ?? { status: 'pending', updatedAt: now }),
					status: prev?.status ?? 'pending',
					activeTokenIds: undefined,
					...(prevAssigneeAlive
						? {}
						: (fallbackAssigneeId
							? { assigneeNodeId: fallbackAssigneeId, ...(fallbackStaff ? { assigneeLabel: fallbackStaff.employeeName || fallbackStaff.label } : { assigneeLabel: undefined }) }
							: { assigneeNodeId: undefined, assigneeLabel: undefined })),
					updatedAt: now,
				};
				next[taskNode.id] = compactTaskStatusRecord(nextClean);
				changed = true;
			} else if (staticAssigneeAlive && taskNode.assigneeNodeId && !prev?.assigneeNodeId) {
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

		const extractSeq = (id: string): number => {
			const m = /(\d+)$/.exec(id);
			return m ? Number.parseInt(m[1], 10) : 0;
		};
		boundTokens.sort((a, b) =>
			(a.arrivedAt - b.arrivedAt)
			|| (a.lastActivityAt - b.lastActivityAt)
			|| (extractSeq(a.id) - extractSeq(b.id))
			|| a.id.localeCompare(b.id),
		);
		const activeTokens = boundTokens.filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join');
		const blockedTokens = boundTokens.filter(t => t.status === 'blocked');
		const latestToken = boundTokens[boundTokens.length - 1];
		const primaryActive = activeTokens[activeTokens.length - 1];
		const earliestArrived = boundTokens[0]?.arrivedAt;
		const unresolvedLatestWaveFailures = boundTokens.filter(t =>
			t.status === 'failed'
			&& !t.supersededByTokenId
			&& (!latestToken || t.waveId === latestToken.waveId),
		);

		const artifactPtrSet = new Set<string>(prev?.artifactPtrs ?? []);
		const touchedFileSet = new Set<string>(prev?.touchedFiles ?? []);
		for (const tok of boundTokens) {
			for (const ref of tok.contextRefs ?? []) {
				if (ref.kind === 'artifact' || ref.kind === 'decision') {
					artifactPtrSet.add(ref.ptr);
				}
			}
			for (const f of tok.touchedFiles ?? []) {
				if (f.trim()) {
					touchedFileSet.add(f.trim());
				}
			}
		}
		const artifactPtrs = [...artifactPtrSet];
		const touchedFiles = [...touchedFileSet];
		const activeTokenIds = activeTokens.map(t => t.id);

		const isStaffAlive = (nid: string | undefined): boolean => Boolean(nid && (!hasOrchRoster || staffById.has(nid)));
		const assigneeNodeId = [
			primaryActive?.nodeId,
			latestToken?.status !== 'reclaimed' && latestToken?.status !== 'aborted' ? latestToken?.nodeId : undefined,
			prev?.assigneeNodeId,
			taskNode.assigneeNodeId,
		].find(nid => isStaffAlive(nid));
		const assigneeStaff = assigneeNodeId ? staffById.get(assigneeNodeId) : undefined;
		const assigneeLabel = assigneeNodeId
			? (assigneeStaff ? (assigneeStaff.employeeName || assigneeStaff.label) : prev?.assigneeLabel)
			: undefined;

		let nextStatus: MissionTaskStatus = prev?.status ?? 'pending';
		let blockedReason: string | undefined = prev?.blockedReason;
		let lastError: string | undefined = prev?.lastError;
		const allTerminalCancelled = activeTokens.length === 0
			&& boundTokens.every(t => t.status === 'aborted' || t.status === 'reclaimed');

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
		} else if (unresolvedLatestWaveFailures.length > 0) {
			const failedTok = unresolvedLatestWaveFailures[unresolvedLatestWaveFailures.length - 1];
			nextStatus = 'blocked';
			lastError = failedTok.failureReason ?? 'Token failed';
			blockedReason = lastError;
		} else if (allTerminalCancelled) {
			nextStatus = 'pending';
			blockedReason = undefined;
			lastError = undefined;
		} else if (prev?.status === 'pending' && boundTokens.length > 0) {
			nextStatus = 'in_progress';
		}

		const startedAt = prev?.startedAt ?? earliestArrived;
		const durationMs = nextStatus === 'completed'
			? (prev?.durationMs ?? (startedAt !== undefined && prev?.completedAt !== undefined ? Math.max(0, prev.completedAt - startedAt) : undefined))
			: (startedAt !== undefined ? Math.max(0, now - startedAt) : prev?.durationMs);

		let latestReworkAt = prev?.lastReworkAt;
		for (const t of boundTokens) {
			if (t.dispatchKind === 'reject' || t.dispatchKind === 'retry') {
				latestReworkAt = Math.max(latestReworkAt ?? 0, t.arrivedAt);
			}
			if (t.status === 'failed') {
				latestReworkAt = Math.max(latestReworkAt ?? 0, t.lastActivityAt);
			}
			if (t.reworkHistory && t.reworkHistory.length > 0) {
				const lastEntryTs = t.reworkHistory[t.reworkHistory.length - 1].timestamp;
				latestReworkAt = Math.max(latestReworkAt ?? 0, lastEntryTs);
			}
		}

		const candidate: IMissionTaskStatusRecord = {
			...(prev ?? { status: nextStatus, updatedAt: now }),
			status: nextStatus,
			...(assigneeNodeId ? { assigneeNodeId } : { assigneeNodeId: undefined }),
			...(assigneeLabel ? { assigneeLabel } : { assigneeLabel: undefined }),
			...(activeTokenIds.length > 0 ? { activeTokenIds } : { activeTokenIds: undefined }),
			...(latestToken ? { lastTokenId: latestToken.id } : {}),
			...(startedAt !== undefined ? { startedAt } : {}),
			...(durationMs !== undefined ? { durationMs } : {}),
			...(artifactPtrs.length > 0 ? { artifactPtrs } : {}),
			...(touchedFiles.length > 0 ? { touchedFiles } : {}),
			...(prev?.lastCheckReceipt ? { lastCheckReceipt: prev.lastCheckReceipt } : {}),
			...(latestReworkAt !== undefined ? { lastReworkAt: latestReworkAt } : {}),
			...(blockedReason ? { blockedReason } : { blockedReason: undefined }),
			...(lastError ? { lastError } : { lastError: undefined }),
			updatedAt: prev?.updatedAt ?? now,
		};

		const cleanCandidate = compactTaskStatusRecord(candidate);
		if (!areTaskStatusRecordsEquivalent(prev, cleanCandidate)) {
			next[taskNode.id] = { ...cleanCandidate, updatedAt: now };
			changed = true;
		}
	}

	return { taskStatuses: changed ? next : existing, changed };
}

/**
 * Validates explicit `--task <taskId>` bindings against the Mission Task DAG when present.
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

/**
 * Checks whether any bound Mission Task DAG node still has incomplete non-fail upstream prerequisites.
 */
export function findIncompleteUpstreamTaskIds(
	taskGraph: IMissionDagParseResult | undefined,
	taskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined,
	taskIds: readonly string[],
): readonly { readonly taskId: string; readonly missingUpstreamIds: readonly string[] }[] {
	if (!taskGraph || taskGraph.error || taskIds.length === 0) {
		return [];
	}
	const existing = taskStatuses ?? {};
	const violations: { readonly taskId: string; readonly missingUpstreamIds: readonly string[] }[] = [];
	const seen = new Set<string>();
	for (const raw of taskIds) {
		const tid = raw.trim();
		if (!tid || seen.has(tid)) {
			continue;
		}
		seen.add(tid);
		const missingUpstreamIds = taskGraph.edges
			.filter(e => e.to === tid && e.edgeKind !== 'fail')
			.map(e => e.from)
			.filter(upId => existing[upId]?.status !== 'completed');
		if (missingUpstreamIds.length > 0) {
			violations.push({ taskId: tid, missingUpstreamIds: [...new Set(missingUpstreamIds)] });
		}
	}
	return violations;
}
