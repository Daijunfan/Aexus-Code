/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildTokenSystemEnvelopeLines } from './adeMessageEnvelope.js';
import { IMissionDagParseResult } from './adeMissionDag.js';
import { IMissionTraceNode } from './adeMissionEngine.js';
import { IOrchestrationGraphNode, IOrchestrationGraphParseResult } from './adeOrchestrationGraph.js';
import {
	handoffOrchestrationToken,
	returnOrchestrationToken,
	settleJoinBarrierIfApplicable,
} from './adeOrchestrationEngine.js';
import {
	assertOrchestrationTokenHolder,
	buildOrchestrationDispatchEffect,
	buildStaffGraphIndex,
	computeJoinBarrierFileConflicts,
	findActiveAncestorTokenOnNode,
	findHighestRankStaffNode,
	formatBudgetExceededError,
	isOrchestrationBudgetTripped,
	normalizeBoundTaskIds,
	recomputeOrchestrationNodeState,
	stageTransitionContext,
	storeOrReuseContextBlob,
	validateScopedPaths,
} from './adeOrchestrationPipeline.js';
import { findIncompleteUpstreamTaskIds, validateTokenTaskBindings } from './adeOrchestrationTasks.js';
import {
	buildCompactHeadline,
	getHighestRankInSchema,
	IMissionTaskStatusRecord,
	IOrchestrationContextBlob,
	IOrchestrationContextBlobInput,
	IOrchestrationContextRef,
	IOrchestrationHopLedgerEntry,
	IOrchestrationJoinBarrier,
	IOrchestrationJoinBarrierChildResult,
	IOrchestrationNodeReadCursor,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationTransitionResult,
	IOrchestrationWhiteboard,
	IOrchestrationWhiteboardPointer,
	ORCHESTRATION_SILENCE_REMINDER_MINUTES,
	OrchestrationEngineEffect,
	OrchestrationNodeRuntimeStatus,
	refreshContextRefsWithLiveWhiteboards,
	resolveEffectiveStaffTier,
} from './adeOrchestrationTypes.js';
import { validateTokenWhiteboardAttachments } from './adeOrchestrationWhiteboards.js';
import { IAdeOrganizationConfig } from './adeRoleSchema.js';

/**
 * Explicitly submits/completes an Orchestration token:
 * - If `toNodeIds` is provided, delegates to `handoffOrchestrationToken`.
 * - If `finish === true` (or highest-rank role with no target), closes the token cleanly and settles any barrier.
 * - Otherwise auto-returns to `returnToNodeId`, or auto-hands off along a single unique outgoing edge.
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
		readonly force?: boolean;
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerAgentId?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{ readonly nextTokenIds: readonly string[]; readonly finished?: boolean; readonly payloadPtr?: string; readonly barrierSatisfied?: boolean }> {
	if (isOrchestrationBudgetTripped(state)) {
		return { ok: false, state, effects: [], code: 'BUDGET_EXCEEDED', error: formatBudgetExceededError(state, 'complete tokens') };
	}
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
	const holderCheck = assertOrchestrationTokenHolder(state, graph, token, params.callerAgentId);
	if (!holderCheck.ok) {
		return { ok: false, state, effects: [], code: holderCheck.code, error: holderCheck.error };
	}
	const summary = params.summary.trim();
	if (!summary) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'A concrete --summary is required.' };
	}

	const staffIndex = buildStaffGraphIndex(graph);
	const uniqueOut = [...(staffIndex.outgoingStaffByNode.get(token.nodeId) ?? [])];
	const holderNode = staffIndex.staffById.get(token.nodeId);
	const completePathCheck = validateScopedPaths(holderNode, token.scopePaths, params.modifiedFiles);
	if (!completePathCheck.ok) {
		return { ok: false, state, effects: [], code: 'ALLOWED_PATHS_VIOLATION', error: completePathCheck.error };
	}
	const mergedTouchedFiles = [...new Set([
		...(token.touchedFiles ?? []),
		...(completePathCheck.normalizedFiles ?? []),
	])];
	const holderTier = resolveEffectiveStaffTier(holderNode, config);
	const highest = getHighestRankInSchema(config);
	const isHighest = holderTier !== undefined
		? (highest ? holderTier <= highest.tier : false)
		: holderNode?.id === staffIndex.topStaffId;

	if (!params.finish && !isHighest && token.returnToNodeId) {
		const ret = returnOrchestrationToken(state, graph, whiteboards, config, {
			tokenId: params.tokenId,
			toNodeId: token.returnToNodeId,
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
		{ callerNodeId: token.nodeId, callerTier: holderTier, state },
		params.whiteboardIds,
		params.refPtrs,
	);
	if (!wbCheck.ok) {
		return { ok: false, state, effects: [], code: wbCheck.code ?? 'INVALID_STATE', error: wbCheck.error };
	}

	const explicitCompleteTaskIds = [
		...(params.taskNodeId?.trim() ? [params.taskNodeId.trim()] : []),
		...(params.taskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
	];
	if (explicitCompleteTaskIds.length > 0) {
		const completeTaskCheck = validateTokenTaskBindings(params.taskGraph, params.taskStatuses, explicitCompleteTaskIds, { allowCompleted: true });
		if (!completeTaskCheck.ok) {
			return { ok: false, state, effects: [], code: completeTaskCheck.code ?? 'INVALID_STATE', error: completeTaskCheck.error };
		}
	}
	const mergedCompleteTasks = normalizeBoundTaskIds(
		params.taskNodeId ?? token.taskNodeId,
		[...(token.taskNodeIds ?? []), ...(params.taskNodeIds ?? [])],
	);
	const allCompleteTaskIds = [
		...(mergedCompleteTasks.taskNodeId ? [mergedCompleteTasks.taskNodeId] : []),
		...(mergedCompleteTasks.taskNodeIds ?? []),
	];
	if (allCompleteTaskIds.length > 0 && params.taskGraph && !params.taskGraph.error && !(params.force && (params.isHumanUser || params.isSecretary))) {
		const depViolations = findIncompleteUpstreamTaskIds(params.taskGraph, params.taskStatuses, allCompleteTaskIds);
		if (depViolations.length > 0) {
			const detailStr = depViolations.map(v => `${v.taskId} waits on [${v.missingUpstreamIds.join(', ')}]`).join('; ');
			return {
				ok: false,
				state,
				effects: [],
				code: 'INCOMPLETE_DEPENDENCIES',
				error: `INCOMPLETE_DEPENDENCIES: cannot close token "${token.id}" while bound Mission Task DAG prerequisite(s) are incomplete (${detailStr}). Complete upstream tasks first.`,
			};
		}
	}

	const now = params.now ?? Date.now();
	const traceSeq = state.traceSeq + 1;
	const donePtr = `otrc-${traceSeq}`;
	const prevHopIndex = token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1);
	const doneHop = prevHopIndex + 1;
	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const staged = stageTransitionContext({
		payloadStore,
		payloadSeqRef,
		externalizedBlobIndex: state.externalizedBlobIndex,
		whiteboards,
		baseRefs: token.contextRefs,
		baseWhiteboardPointers: token.whiteboardPointers,
		summary,
		detail: params.detail,
		detailTitle: `Hop #${doneHop}: Final Completion by ${token.nodeId}`,
		authorNodeId: token.nodeId,
		authorAgentId: token.holderAgentId,
		hop: doneHop,
		waveId: token.waveId,
		now,
		artifacts: params.artifacts,
		decisions: params.decisions,
		refPtrs: params.refPtrs,
		normalizedWhiteboardIds: wbCheck.normalizedIds,
	});

	const doneHopEntry: IOrchestrationHopLedgerEntry = {
		hop: doneHop,
		tokenId: token.id,
		fromNodeId: token.nodeId,
		toNodeId: token.nodeId,
		event: 'complete',
		headline: staged.headline,
		...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
		...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
		timestamp: now,
	};
	const completedToken: IOrchestrationToken = {
		...token,
		status: 'completed',
		blocked: undefined,
		...(mergedCompleteTasks.taskNodeId ? { taskNodeId: mergedCompleteTasks.taskNodeId } : {}),
		...(mergedCompleteTasks.taskNodeIds ? { taskNodeIds: mergedCompleteTasks.taskNodeIds } : {}),
		...(mergedTouchedFiles.length > 0 ? { touchedFiles: mergedTouchedFiles } : {}),
		hopIndex: doneHop,
		lastSummary: staged.headline,
		...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
		hopLog: [...(token.hopLog ?? []), doneHopEntry],
		contextRefs: staged.contextRefs,
		...(staged.whiteboardPointers.length > 0 ? { whiteboardPointers: staged.whiteboardPointers } : {}),
		lastActivityAt: now,
	};
	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[token.id]: completedToken,
	};
	// Record trailing completion in already-satisfied barriers (`any`/`quorum`) for full observability
	let nextBarriers = state.joinBarriers;
	const existingBarrier = token.parentJoinBarrierId ? state.joinBarriers?.[token.parentJoinBarrierId] : undefined;
	if (existingBarrier && existingBarrier.status === 'satisfied' && state.joinBarriers) {
		nextBarriers = {
			...state.joinBarriers,
			[existingBarrier.id]: {
				...existingBarrier,
				settledChildren: {
					...existingBarrier.settledChildren,
					[token.id]: {
						tokenId: token.id,
						fromNodeId: token.nodeId,
						outcome: 'completed',
						summary: staged.headline,
						...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
						...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
						...(completedToken.taskNodeId ? { taskNodeId: completedToken.taskNodeId } : {}),
						...(completedToken.scopePaths && completedToken.scopePaths.length > 0 ? { scopePaths: completedToken.scopePaths } : {}),
						...(mergedTouchedFiles.length > 0 ? { touchedFiles: mergedTouchedFiles } : {}),
						settledAt: now,
					},
				},
			},
		};
	}

	const preBarrierState: IOrchestrationRuntimeState = {
		...state,
		tokens: nextTokens,
		nodeStates: {
			...state.nodeStates,
			[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
		},
		...(nextBarriers ? { joinBarriers: nextBarriers } : {}),
		traces: {
			...state.traces,
			[donePtr]: {
				ptr: donePtr,
				parentPtrs: [token.tracePtr],
				nodeId: token.nodeId,
				employeeId: token.holderAgentId,
				waveId: token.waveId,
				event: 'complete',
				summary: staged.headline,
				timestamp: now,
			},
		},
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		traceSeq,
		stateRevision: (state.stateRevision ?? 0) + 1,
		updatedAt: now,
	};
	const settled = settleJoinBarrierIfApplicable(preBarrierState, graph, whiteboards, config, {
		childToken: completedToken,
		outcome: 'completed',
		summary: staged.headline,
		payloadPtr: staged.payloadPtr,
		attachedRefPtrs: staged.attachedRefPtrs,
		extraContextRefs: staged.contextRefs,
		extraWhiteboardPointers: staged.whiteboardPointers,
		taskGraph: params.taskGraph,
		taskStatuses: params.taskStatuses,
		now,
	});
	const completionEffects: OrchestrationEngineEffect[] = [...settled.effects];
	const isRootOrTopCompletion = isHighest || (!completedToken.returnToNodeId && completedToken.originNodeId === 'User');
	if (!completedToken.parentJoinBarrierId && !settled.barrierSatisfied && isRootOrTopCompletion && (isHighest || params.finish)) {
		const artifactPtrs = staged.contextRefs.filter(r => r.kind === 'artifact' || r.kind === 'decision').map(r => r.ptr);
		const detailLines = [
			`Wave \`${completedToken.waveId}\` completed by \`${completedToken.nodeId}\`${holderNode?.label ? ` (${holderNode.label})` : ''} (token \`${completedToken.id}\`).`,
			'',
			`Summary: ${summary}`,
			...(staged.rawDetail && staged.rawDetail !== summary ? ['', staged.rawDetail.slice(0, 1200)] : []),
			...(staged.payloadPtr ? [`\nDetail pointer: \`${staged.payloadPtr}\``] : []),
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
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			...(settled.barrierSatisfied ? { barrierSatisfied: true } : {}),
		},
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
			stateRevision: (state.stateRevision ?? 0) + 1,
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
	if (isOrchestrationBudgetTripped(state)) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'BUDGET_EXCEEDED',
			error: formatBudgetExceededError(state, 'resume Orchestration'),
		};
	}
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
			stateRevision: (state.stateRevision ?? 0) + 1,
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

	const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = { ...state.nodeStates };
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
			stateRevision: (state.stateRevision ?? 0) + 1,
			updatedAt: now,
		},
		effects: [],
		data: { abortedTokenIds, abortedBarrierIds },
	};
}

/**
 * 5-Minute Repeating Silence Reminder.
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
		`You still hold active baton \`${token.id}\` on \`${token.nodeId}\` (silent ${intervalMin}m${params.detail ? `: ${params.detail}` : ''}). Continue advancing work, then explicitly run \`token return ${token.id}\`, \`token handoff ${token.id}\`, \`token complete ${token.id}\`, or \`token block ${token.id}\`.`,
	].join('\n');

	return {
		ok: true,
		state: {
			...state,
			tokens: {
				...state.tokens,
				[token.id]: updatedToken,
			},
			stateRevision: (state.stateRevision ?? 0) + 1,
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
		readonly graph?: IOrchestrationGraphParseResult;
		readonly now?: number;
	},
): IOrchestrationTransitionResult {
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before blocking tokens.' };
	}
	if (!Number.isFinite(params.maxDurationMs) || params.maxDurationMs <= 0) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'A positive finite maxDurationMs is required to block a token.' };
	}
	const token = state.tokens[params.tokenId];
	if (!token || (token.status !== 'active' && token.status !== 'blocked')) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active Orchestration token "${params.tokenId}" not found.` };
	}
	if (params.callerAgentId !== undefined) {
		const graphNodeAgentId = params.graph?.nodes.find(n => n.id === token.nodeId && n.kind === 'staff')?.agentId;
		const boundHolder = state.nodeAgentIds[token.nodeId] ?? token.holderAgentId ?? graphNodeAgentId;
		if (!boundHolder || boundHolder !== params.callerAgentId) {
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
			stateRevision: (state.stateRevision ?? 0) + 1,
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
	if (isOrchestrationBudgetTripped(state)) {
		return { ok: false, state, effects: [], code: 'BUDGET_EXCEEDED', error: formatBudgetExceededError(state, 'wake blocked tokens') };
	}
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before waking blocked tokens.' };
	}
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
	const message = [
		...buildTokenSystemEnvelopeLines({
			tokenId: token.id,
			nodeId: token.nodeId,
			hopIndex: token.hopIndex,
			sourceDescription: `Orchestration Watchdog Wakeup (${params.reason})`,
			isReminder: true,
		}),
		`[Orchestration Watchdog Wakeup · Token \`${token.id}\`] Blocked condition triggered (${params.reason}${params.detail ? `: ${params.detail}` : ''}). Resume work on staff node \`${token.nodeId}\` and explicitly hand off, return, or complete token \`${token.id}\` when ready.`,
	].join('\n');
	return {
		ok: true,
		state: {
			...state,
			tokens: nextTokens,
			nodeStates: {
				...state.nodeStates,
				[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
			},
			stateRevision: (state.stateRevision ?? 0) + 1,
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

/**
 * Enforces `barrier.deadlineAt` expiration for a waiting Join Barrier (Contract C6):
 * - Recursively aborts nested waiting child barriers and reclaims every unsettled child/grandchild token.
 * - Marks the barrier `status: 'satisfied'`, `timedOut: true`, `timedOutAt: now` with partial results + file conflict digest.
 * - Wakes the `waiting_join` owner token ONCE so deadlocked/timed-out parallel fan-outs never hang indefinitely.
 */
export function expireOrchestrationJoinBarrier(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly barrierId: string;
		readonly reason?: string;
		readonly force?: boolean;
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{
	readonly barrierId: string;
	readonly parentTokenId: string;
	readonly reclaimedTokenIds: readonly string[];
	readonly abortedNestedBarrierIds: readonly string[];
}> {
	if (isOrchestrationBudgetTripped(state)) {
		return { ok: false, state, effects: [], code: 'BUDGET_EXCEEDED', error: formatBudgetExceededError(state, 'expire join barriers') };
	}
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before expiring join barriers.' };
	}
	const barrier = state.joinBarriers?.[params.barrierId];
	if (!barrier) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Join barrier "${params.barrierId}" not found.` };
	}
	if (barrier.status !== 'waiting') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Join barrier "${barrier.id}" is "${barrier.status}", not waiting.` };
	}
	const now = params.now ?? Date.now();
	if (!params.force && (barrier.deadlineAt === undefined || now < barrier.deadlineAt)) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_STATE',
			error: barrier.deadlineAt === undefined
				? `Join barrier "${barrier.id}" has no deadlineAt configured; pass force=true to expire manually.`
				: `Join barrier "${barrier.id}" has not reached deadlineAt (${barrier.deadlineAt} > ${now}).`,
		};
	}

	const timeoutReason = params.reason?.trim() || `Join barrier "${barrier.id}" exceeded deadlineAt`;
	const nextTokens: Record<string, IOrchestrationToken> = { ...state.tokens };
	const nextBarriers: Record<string, IOrchestrationJoinBarrier> = { ...(state.joinBarriers ?? {}) };
	const nextTraces: Record<string, IMissionTraceNode> = { ...state.traces };
	let traceSeq = state.traceSeq;
	const touchedNodes = new Set<string>();
	const reclaimedTokenIds: string[] = [];
	const abortedNestedBarrierIds: string[] = [];
	const nextSettled: Record<string, IOrchestrationJoinBarrierChildResult> = { ...barrier.settledChildren };

	// Recursively abort nested waiting child barriers and reclaim all unsettled descendants
	const directUnsettled = new Set<string>();
	const reclaimQueue: string[] = [];
	for (const cid of barrier.childTokenIds) {
		if (!nextSettled[cid]) {
			directUnsettled.add(cid);
			reclaimQueue.push(cid);
		}
	}
	const visited = new Set<string>();
	while (reclaimQueue.length > 0) {
		const cid = reclaimQueue.shift()!;
		if (visited.has(cid)) {
			continue;
		}
		visited.add(cid);
		const child = nextTokens[cid];
		if (!child) {
			if (directUnsettled.has(cid)) {
				nextSettled[cid] = {
					tokenId: cid,
					fromNodeId: 'unknown',
					outcome: 'reclaimed',
					summary: `TIMED OUT: ${buildCompactHeadline(timeoutReason).headline}`,
					settledAt: now,
				};
			}
			continue;
		}
		const nestedBarrierId = child.joinBarrierId;
		if (nestedBarrierId) {
			const nestedBarrier = nextBarriers[nestedBarrierId];
			if (nestedBarrier && nestedBarrier.status === 'waiting') {
				nextBarriers[nestedBarrierId] = { ...nestedBarrier, status: 'aborted' };
				abortedNestedBarrierIds.push(nestedBarrierId);
				for (const gcid of nestedBarrier.childTokenIds) {
					if (!nestedBarrier.settledChildren[gcid]) {
						reclaimQueue.push(gcid);
					}
				}
			}
		}
		// Also recursively reclaim any active non-barrier children spawned under this timed-out branch (`waitJoin: false`)
		for (const gcid of child.childTokenIds ?? []) {
			reclaimQueue.push(gcid);
		}
		if (child.status === 'active' || child.status === 'blocked' || child.status === 'waiting_join') {
			const childHop = (child.hopIndex ?? Math.max(0, (child.hopLog?.length ?? 1) - 1)) + 1;
			const reclaimHeadline = buildCompactHeadline(`TIMED OUT: ${timeoutReason}`).headline;
			traceSeq += 1;
			const recallTracePtr = `otrc-${traceSeq}`;
			nextTokens[cid] = {
				...child,
				status: 'reclaimed',
				blocked: undefined,
				joinBarrierId: undefined,
				reclaimedReason: reclaimHeadline,
				reclaimedBy: barrier.ownerNodeId,
				hopIndex: childHop,
				hopLog: [...(child.hopLog ?? []), {
					hop: childHop,
					tokenId: child.id,
					fromNodeId: barrier.ownerNodeId,
					toNodeId: child.nodeId,
					event: 'reclaim',
					headline: reclaimHeadline,
					timestamp: now,
				}],
				lastActivityAt: now,
			};
			nextTraces[recallTracePtr] = {
				ptr: recallTracePtr,
				parentPtrs: [child.tracePtr],
				nodeId: child.nodeId,
				employeeId: child.holderAgentId,
				waveId: child.waveId,
				event: 'recall',
				summary: reclaimHeadline,
				timestamp: now,
			};
			reclaimedTokenIds.push(cid);
			touchedNodes.add(child.nodeId);
		}
		if (directUnsettled.has(cid)) {
			nextSettled[cid] = {
				tokenId: child.id,
				fromNodeId: child.nodeId,
				outcome: 'reclaimed',
				summary: `TIMED OUT: ${buildCompactHeadline(timeoutReason).headline}`,
				...(child.payloadPtr ? { payloadPtr: child.payloadPtr } : {}),
				...(child.taskNodeId ? { taskNodeId: child.taskNodeId } : {}),
				...(child.scopePaths && child.scopePaths.length > 0 ? { scopePaths: child.scopePaths } : {}),
				...(child.touchedFiles && child.touchedFiles.length > 0 ? { touchedFiles: child.touchedFiles } : {}),
				settledAt: now,
			};
		}
	}

	const fileConflicts = computeJoinBarrierFileConflicts(nextSettled);
	const updatedBarrier: IOrchestrationJoinBarrier = {
		...barrier,
		settledChildren: nextSettled,
		status: 'satisfied',
		timedOut: true,
		timedOutAt: now,
		satisfiedAt: now,
		...(fileConflicts.length > 0 ? { fileConflicts } : {}),
	};
	nextBarriers[barrier.id] = updatedBarrier;

	const parentToken = nextTokens[barrier.parentTokenId];
	if (!parentToken || parentToken.status !== 'waiting_join') {
		const nextNodeStates = { ...state.nodeStates };
		for (const nid of touchedNodes) {
			nextNodeStates[nid] = recomputeOrchestrationNodeState(nextTokens, nid);
		}
		return {
			ok: true,
			state: {
				...state,
				tokens: nextTokens,
				nodeStates: nextNodeStates,
				traces: nextTraces,
				joinBarriers: nextBarriers,
				traceSeq,
				stateRevision: (state.stateRevision ?? 0) + 1,
				updatedAt: now,
			},
			effects: [],
			data: {
				barrierId: barrier.id,
				parentTokenId: barrier.parentTokenId,
				reclaimedTokenIds,
				abortedNestedBarrierIds,
			},
		};
	}

	const nextHop = (parentToken.hopIndex ?? Math.max(0, (parentToken.hopLog?.length ?? 1) - 1)) + 1;
	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const settledEntries = barrier.childTokenIds
		.map(cid => nextSettled[cid])
		.filter((r): r is IOrchestrationJoinBarrierChildResult => Boolean(r));
	const convergenceLines = [
		`Join barrier ${barrier.id} TIMED OUT (${timeoutReason}): ${settledEntries.filter(r => r.outcome !== 'reclaimed').length}/${barrier.childTokenIds.length} completed before deadline.`,
		...settledEntries.map(r =>
			`- ${r.tokenId} (${r.fromNodeId}, ${r.outcome}${r.taskNodeId ? `, task:${r.taskNodeId}` : ''}): ${r.summary}${r.payloadPtr ? ` [detail:${r.payloadPtr}]` : ''}`,
		),
		...(fileConflicts.length > 0
			? ['', `Parallel File Overlaps (${fileConflicts.length}):`, ...fileConflicts.map(c => `- ${c.path}: touched by ${c.fromNodeIds.join(', ')} (${c.tokenIds.join(', ')})`)]
			: []),
	];
	const convergenceSummary = buildCompactHeadline(
		`Join barrier ${barrier.id} TIMED OUT (${reclaimedTokenIds.length} branch(es) reclaimed): ${settledEntries.map(r => `${r.fromNodeId}=${r.outcome}`).join(', ')}`,
	).headline;
	const convergenceRef = storeOrReuseContextBlob(
		payloadStore,
		payloadSeqRef,
		{
			kind: 'handoff',
			title: `Join Barrier ${barrier.id} Timeout Convergence`,
			content: convergenceLines.join('\n'),
			authorNodeId: barrier.ownerNodeId,
			hop: nextHop,
			waveId: parentToken.waveId,
			now,
		},
		state.externalizedBlobIndex,
	);

	const refMap = new Map<string, IOrchestrationContextRef>();
	for (const ref of refreshContextRefsWithLiveWhiteboards(parentToken.contextRefs, whiteboards, parentToken.whiteboardPointers, nextHop)) {
		refMap.set(ref.ptr, ref);
	}
	for (const cid of barrier.childTokenIds) {
		for (const ref of nextTokens[cid]?.contextRefs ?? []) {
			refMap.set(ref.ptr, ref);
		}
	}
	const wbMap = new Map<string, IOrchestrationWhiteboardPointer>();
	for (const wp of parentToken.whiteboardPointers ?? []) { wbMap.set(wp.whiteboardId, wp); }
	for (const cid of barrier.childTokenIds) {
		for (const wp of nextTokens[cid]?.whiteboardPointers ?? []) { wbMap.set(wp.whiteboardId, wp); }
	}

	traceSeq += 1;
	const resumeTracePtr = `otrc-${traceSeq}`;
	const resumeHop: IOrchestrationHopLedgerEntry = {
		hop: nextHop,
		tokenId: parentToken.id,
		fromNodeId: barrier.ownerNodeId,
		toNodeId: parentToken.nodeId,
		event: 'join_resume',
		headline: convergenceSummary,
		payloadPtr: convergenceRef.ptr,
		timestamp: now,
	};
	const mergedTouchedFiles = [...new Set([
		...(parentToken.touchedFiles ?? []),
		...settledEntries.flatMap(r => r.touchedFiles ?? []),
	])];
	const resumedParent: IOrchestrationToken = {
		...parentToken,
		status: 'active',
		joinBarrierId: undefined,
		hopIndex: nextHop,
		relayDepth: parentToken.relayDepth ?? 0,
		lastSummary: convergenceSummary,
		payloadPtr: convergenceRef.ptr,
		hopLog: [...(parentToken.hopLog ?? []), resumeHop],
		contextRefs: [...refMap.values()],
		...(wbMap.size > 0 ? { whiteboardPointers: [...wbMap.values()] } : {}),
		...(mergedTouchedFiles.length > 0 ? { touchedFiles: mergedTouchedFiles } : {}),
		lastActivityAt: now,
		lastNudgeAt: undefined,
		nudgeCount: 0,
	};
	nextTokens[parentToken.id] = resumedParent;
	touchedNodes.add(parentToken.nodeId);

	const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = { ...state.nodeStates };
	for (const nid of touchedNodes) {
		nextNodeStates[nid] = recomputeOrchestrationNodeState(nextTokens, nid);
	}
	nextTraces[resumeTracePtr] = {
		ptr: resumeTracePtr,
		parentPtrs: [parentToken.tracePtr, ...barrier.childTokenIds.map(cid => nextTokens[cid]?.tracePtr).filter((p): p is string => Boolean(p))],
		nodeId: parentToken.nodeId,
		employeeId: state.nodeAgentIds[parentToken.nodeId] ?? parentToken.holderAgentId,
		waveId: parentToken.waveId,
		event: 'mint',
		summary: convergenceSummary,
		timestamp: now,
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
		stateRevision: (state.stateRevision ?? 0) + 1,
		updatedAt: now,
	};

	const effects: OrchestrationEngineEffect[] = [];
	const staffIndex = buildStaffGraphIndex(graph);
	const parsedOwnerNode = staffIndex.staffById.get(parentToken.nodeId);
	const resolvedOwnerAgentId = state.nodeAgentIds[parentToken.nodeId] ?? resumedParent.holderAgentId;
	const ownerNode: IOrchestrationGraphNode | undefined = parsedOwnerNode
		?? (resolvedOwnerAgentId
			? { id: parentToken.nodeId, kind: 'staff', label: parentToken.nodeId, agentId: resolvedOwnerAgentId }
			: undefined);
	if (ownerNode) {
		effects.push(buildOrchestrationDispatchEffect({
			state: nextState,
			graph,
			staffIndex,
			whiteboards,
			config,
			targetNode: ownerNode,
			token: resumedParent,
			holderAgentId: resolvedOwnerAgentId,
			convergedBarrier: updatedBarrier,
			taskGraph: params.taskGraph,
			rawTaskStatuses: params.taskStatuses,
		}));
	}

	return {
		ok: true,
		state: nextState,
		effects,
		data: {
			barrierId: barrier.id,
			parentTokenId: parentToken.id,
			reclaimedTokenIds,
			abortedNestedBarrierIds,
		},
	};
}

/**
 * Batch-expires every waiting Join Barrier whose `deadlineAt <= now` (sorted earliest deadline first).
 */
export function expireTimedOutJoinBarriers(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params?: {
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{
	readonly expiredBarrierIds: readonly string[];
	readonly reclaimedTokenIds: readonly string[];
	readonly wokenParentTokenIds: readonly string[];
}> {
	if (isOrchestrationBudgetTripped(state)) {
		return { ok: false, state, effects: [], code: 'BUDGET_EXCEEDED', error: formatBudgetExceededError(state, 'expire join barriers') };
	}
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before expiring join barriers.' };
	}
	const now = params?.now ?? Date.now();
	const dueIds = Object.values(state.joinBarriers ?? {})
		.filter(b => b.status === 'waiting' && b.deadlineAt !== undefined && now >= b.deadlineAt)
		.sort((a, b) => (a.deadlineAt ?? 0) - (b.deadlineAt ?? 0) || a.id.localeCompare(b.id))
		.map(b => b.id);

	let workingState = state;
	const allEffects: OrchestrationEngineEffect[] = [];
	const expiredBarrierIds: string[] = [];
	const reclaimedTokenIds: string[] = [];
	const wokenParentTokenIds: string[] = [];

	for (const barrierId of dueIds) {
		if (workingState.joinBarriers?.[barrierId]?.status !== 'waiting') {
			continue;
		}
		const res = expireOrchestrationJoinBarrier(workingState, graph, whiteboards, config, {
			barrierId,
			taskGraph: params?.taskGraph,
			taskStatuses: params?.taskStatuses,
			now,
		});
		if (res.ok && res.data) {
			workingState = res.state;
			allEffects.push(...res.effects);
			expiredBarrierIds.push(res.data.barrierId);
			reclaimedTokenIds.push(...res.data.reclaimedTokenIds);
			if (res.effects.some(e => e.kind === 'dispatch_token' && e.tokenId === res.data!.parentTokenId)) {
				wokenParentTokenIds.push(res.data.parentTokenId);
			}
		}
	}

	// Drop any stale dispatch_token wakeup for an inner barrier owner that was subsequently reclaimed by an outer barrier!
	const filteredEffects = allEffects.filter(eff =>
		eff.kind !== 'dispatch_token' || workingState.tokens[eff.tokenId]?.status === 'active',
	);
	const filteredWokenParentIds = wokenParentTokenIds.filter(tid => workingState.tokens[tid]?.status === 'active');

	return {
		ok: true,
		state: workingState,
		effects: filteredEffects,
		data: {
			expiredBarrierIds,
			reclaimedTokenIds,
			wokenParentTokenIds: filteredWokenParentIds,
		},
	};
}

/**
 * Cleanly reclaims every in-flight token (`active` / `blocked` / `waiting_join`) held by a removed staff node:
 * - Marks each held token `'reclaimed'` with audit trail.
 * - Settles waiting join barriers; records trailing reclaims on already-satisfied barriers without bogus recovery bounces.
 * - For non-barrier tokens, merges into an existing active ancestor baton when present (avoiding duplicate batons).
 * - Suppresses wakeup `dispatch_token` effects when Orchestration is paused or over budget.
 * - Purges the removed node from `nodeStates`, `nodeAgentIds`, `nodeReadCursors`, and `pendingHeadlessEffects`.
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
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
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
	const staffIndex = buildStaffGraphIndex(graphAfterRemoval);
	const survivingStaffIds = new Set(staffIndex.staffById.keys());
	const suppressWakeups = state.status === 'paused' || isOrchestrationBudgetTripped(state);

	let workingState: IOrchestrationRuntimeState = state;
	const allEffects: OrchestrationEngineEffect[] = [];
	const reclaimedTokenIds: string[] = [];
	const recoveryTokenIds: string[] = [];
	const settledBarrierIds: string[] = [];
	const reparentedTokenIds: string[] = [];
	const splicedGrandchildSet = new Set<string>();

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

		const nextBarriers: Record<string, IOrchestrationJoinBarrier> = { ...(workingState.joinBarriers ?? {}) };
		const nextTokensForStep: Record<string, IOrchestrationToken> = {
			...workingState.tokens,
			[liveTok.id]: reclaimedToken,
		};
		const ownedChildBarrier = liveTok.joinBarrierId ? nextBarriers[liveTok.joinBarrierId] : undefined;
		if (ownedChildBarrier && ownedChildBarrier.status === 'waiting') {
			nextBarriers[ownedChildBarrier.id] = {
				...ownedChildBarrier,
				status: 'aborted',
			};
		}

		// Re-parent surviving unsettled grandchildren of `removedId`'s aborted barrier directly into
		// `liveTok`'s waiting parent barrier (splicing them in place of `liveTok.id`) BEFORE settling
		// the parent barrier so a parent never wakes prematurely or suffers quorum skew!
		let splicedIntoParentBarrier = false;
		const parentBarrier = liveTok.parentJoinBarrierId ? nextBarriers[liveTok.parentJoinBarrierId] : undefined;
		if (
			ownedChildBarrier
			&& ownedChildBarrier.status === 'waiting'
			&& parentBarrier
			&& parentBarrier.status === 'waiting'
			&& parentBarrier.ownerNodeId !== removedId
			&& survivingStaffIds.has(parentBarrier.ownerNodeId)
		) {
			const survivingGrandchildIds = ownedChildBarrier.childTokenIds.filter(gcid => {
				if (ownedChildBarrier.settledChildren[gcid]) {
					return false;
				}
				const gc = nextTokensForStep[gcid];
				return Boolean(gc && gc.nodeId !== removedId && (gc.status === 'active' || gc.status === 'blocked' || gc.status === 'waiting_join'));
			});
			if (survivingGrandchildIds.length > 0) {
				splicedIntoParentBarrier = true;
				const replacedChildren = parentBarrier.childTokenIds.flatMap(cid =>
					cid === liveTok.id ? survivingGrandchildIds : [cid],
				);
				nextBarriers[parentBarrier.id] = {
					...parentBarrier,
					childTokenIds: [...new Set(replacedChildren)],
				};
				const waitingParentTok = nextTokensForStep[parentBarrier.parentTokenId];
				if (waitingParentTok) {
					nextTokensForStep[waitingParentTok.id] = {
						...waitingParentTok,
						childTokenIds: [...new Set([...(waitingParentTok.childTokenIds ?? []), ...survivingGrandchildIds])],
						lastActivityAt: now,
					};
				}
				for (const gcid of survivingGrandchildIds) {
					const gc = nextTokensForStep[gcid]!;
					nextTokensForStep[gcid] = {
						...gc,
						parentTokenId: parentBarrier.parentTokenId,
						parentJoinBarrierId: parentBarrier.id,
						returnToNodeId: parentBarrier.ownerNodeId,
						...(gc.originNodeId === removedId ? { originNodeId: parentBarrier.ownerNodeId } : {}),
						...(gc.fromNodeId === removedId ? { fromNodeId: parentBarrier.ownerNodeId } : {}),
						lastActivityAt: now,
					};
					splicedGrandchildSet.add(gcid);
					reparentedTokenIds.push(gcid);
				}
			}
		}

		// Record trailing child reclaim on already-satisfied barriers without bouncing a bogus recovery baton!
		if (parentBarrier && parentBarrier.status === 'satisfied') {
			nextBarriers[parentBarrier.id] = {
				...parentBarrier,
				settledChildren: {
					...parentBarrier.settledChildren,
					[liveTok.id]: {
						tokenId: liveTok.id,
						fromNodeId: removedId,
						outcome: 'reclaimed',
						summary: headline,
						...(liveTok.payloadPtr ? { payloadPtr: liveTok.payloadPtr } : {}),
						...(liveTok.taskNodeId ? { taskNodeId: liveTok.taskNodeId } : {}),
						settledAt: now,
					},
				},
			};
		}

		workingState = {
			...workingState,
			tokens: nextTokensForStep,
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

		if (splicedIntoParentBarrier || (parentBarrier && parentBarrier.status === 'satisfied')) {
			continue;
		}

		// Case 1: Token belonged to an upstream waiting join barrier -> settle cleanly!
		if (liveTok.parentJoinBarrierId && workingState.joinBarriers?.[liveTok.parentJoinBarrierId]?.status === 'waiting') {
			const settled = settleJoinBarrierIfApplicable(workingState, graphAfterRemoval, whiteboards, config, {
				childToken: reclaimedToken,
				outcome: 'reclaimed',
				summary: headline,
				taskGraph: params.taskGraph,
				taskStatuses: params.taskStatuses,
				now,
			});
			workingState = settled.state;
			if (!suppressWakeups) {
				allEffects.push(...settled.effects);
			}
			if (settled.barrierSatisfied) {
				settledBarrierIds.push(liveTok.parentJoinBarrierId);
			}
			continue;
		}

		// Case 2: Non-barrier token -> merge into active ancestor baton if present, else bounce recovery baton!
		const candidateSuperiors = [
			params.fallbackSupervisorNodeId,
			liveTok.returnToNodeId,
			liveTok.originNodeId !== 'User' ? liveTok.originNodeId : undefined,
			liveTok.fromNodeId,
			findHighestRankStaffNode(graphAfterRemoval)?.id,
		].filter((id): id is string => Boolean(id && id !== removedId && survivingStaffIds.has(id)));
		const targetSupervisorId = candidateSuperiors[0];
		if (targetSupervisorId) {
			const supNode = staffIndex.staffById.get(targetSupervisorId)!;
			const supAgentId = workingState.nodeAgentIds[targetSupervisorId] ?? supNode.agentId;
			const recoveryHeadline = buildCompactHeadline(`[Reclaimed from removed ${removedId}] ${liveTok.lastSummary}`).headline;
			const activeAncestor = findActiveAncestorTokenOnNode(workingState, liveTok, targetSupervisorId);

			if (activeAncestor) {
				const nextTraceSeq = workingState.traceSeq + 1;
				const recoveryTracePtr = `otrc-${nextTraceSeq}`;
				const ancestorHop = Math.max(nextHop + 1, (activeAncestor.hopIndex ?? Math.max(0, (activeAncestor.hopLog?.length ?? 1) - 1)) + 1);
				const refMap = new Map<string, IOrchestrationContextRef>();
				for (const r of refreshContextRefsWithLiveWhiteboards(activeAncestor.contextRefs, whiteboards, activeAncestor.whiteboardPointers, ancestorHop)) {
					refMap.set(r.ptr, r);
				}
				for (const r of liveTok.contextRefs ?? []) { refMap.set(r.ptr, r); }
				const wbMap = new Map<string, IOrchestrationWhiteboardPointer>();
				for (const wp of activeAncestor.whiteboardPointers ?? []) { wbMap.set(wp.whiteboardId, wp); }
				for (const wp of liveTok.whiteboardPointers ?? []) { wbMap.set(wp.whiteboardId, wp); }
				const mergedAncestor: IOrchestrationToken = {
					...activeAncestor,
					status: 'active',
					blocked: undefined,
					fromNodeId: removedId,
					holderAgentId: supAgentId,
					hopIndex: ancestorHop,
					relayDepth: activeAncestor.relayDepth ?? 0,
					lastSummary: recoveryHeadline,
					...(liveTok.payloadPtr ? { payloadPtr: liveTok.payloadPtr } : {}),
					hopLog: [...(activeAncestor.hopLog ?? []), {
						hop: ancestorHop,
						tokenId: activeAncestor.id,
						fromNodeId: removedId,
						toNodeId: targetSupervisorId,
						event: 'reclaim',
						headline: recoveryHeadline,
						...(liveTok.payloadPtr ? { payloadPtr: liveTok.payloadPtr } : {}),
						timestamp: now,
					}],
					contextRefs: [...refMap.values()],
					...(wbMap.size > 0 ? { whiteboardPointers: [...wbMap.values()] } : {}),
					lastActivityAt: now,
					lastNudgeAt: undefined,
					nudgeCount: 0,
				};
				const nextTokens = { ...workingState.tokens, [activeAncestor.id]: mergedAncestor };
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
							parentPtrs: [reclaimTracePtr, activeAncestor.tracePtr],
							nodeId: targetSupervisorId,
							employeeId: supAgentId,
							waveId: liveTok.waveId,
							event: 'mint',
							summary: recoveryHeadline,
							timestamp: now,
						},
					},
					traceSeq: nextTraceSeq,
					updatedAt: now,
				};
				recoveryTokenIds.push(activeAncestor.id);
				if (!suppressWakeups) {
					allEffects.push(buildOrchestrationDispatchEffect({
						state: workingState,
						graph: graphAfterRemoval,
						staffIndex,
						whiteboards,
						config,
						targetNode: supNode,
						token: mergedAncestor,
						holderAgentId: supAgentId,
						taskGraph: params.taskGraph,
						rawTaskStatuses: params.taskStatuses,
					}));
				}
				continue;
			}

			const nextTokenSeq = workingState.tokenSeq + 1;
			const nextTraceSeq = workingState.traceSeq + 1;
			const recoveryTokenId = `otok-${nextTokenSeq}`;
			const recoveryTracePtr = `otrc-${nextTraceSeq}`;
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
				relayDepth: liveTok.relayDepth ?? 0,
				lastSummary: recoveryHeadline,
				...(liveTok.payloadPtr ? { payloadPtr: liveTok.payloadPtr } : {}),
				hopLog: [...(reclaimedToken.hopLog ?? []), recoveryHop],
				contextRefs: liveTok.contextRefs ?? [],
				compressedHistory: '',
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
			if (!suppressWakeups) {
				allEffects.push(buildOrchestrationDispatchEffect({
					state: workingState,
					graph: graphAfterRemoval,
					staffIndex,
					whiteboards,
					config,
					targetNode: supNode,
					token: recoveryToken,
					holderAgentId: supAgentId,
					taskGraph: params.taskGraph,
					rawTaskStatuses: params.taskStatuses,
				}));
			}
		}
	}

	// Abort ANY remaining waiting join barriers owned by `removedId`
	const removedOwnedBarrierIds = new Set<string>();
	let abortedExtraBarriers: Record<string, IOrchestrationJoinBarrier> | undefined;
	for (const [bid, barrier] of Object.entries(workingState.joinBarriers ?? {})) {
		if (barrier.ownerNodeId === removedId) {
			removedOwnedBarrierIds.add(bid);
			if (barrier.status === 'waiting') {
				abortedExtraBarriers ??= { ...(workingState.joinBarriers ?? {}) };
				abortedExtraBarriers[bid] = { ...barrier, status: 'aborted' };
			}
		}
	}
	if (abortedExtraBarriers) {
		workingState = {
			...workingState,
			joinBarriers: abortedExtraBarriers,
			updatedAt: now,
		};
	}

	// Re-parent surviving child tokens whose return target, origin, fromNodeId, or join barrier belonged to `removedId`
	const defaultFallbackSupervisorId = [
		params.fallbackSupervisorNodeId,
		...inFlightHeld.map(t => t.returnToNodeId),
		...inFlightHeld.map(t => (t.originNodeId && t.originNodeId !== 'User' ? t.originNodeId : undefined)),
		...inFlightHeld.map(t => t.fromNodeId),
		findHighestRankStaffNode(graphAfterRemoval)?.id,
	].find((id): id is string => Boolean(id && id !== removedId && survivingStaffIds.has(id)));

	let reparentedTokensMap: Record<string, IOrchestrationToken> | undefined;
	let reparentedBarriersMap: Record<string, IOrchestrationJoinBarrier> | undefined;
	for (const tok of Object.values(workingState.tokens)) {
		if (splicedGrandchildSet.has(tok.id) || tok.nodeId === removedId || (tok.status !== 'active' && tok.status !== 'blocked' && tok.status !== 'waiting_join')) {
			continue;
		}
		const orphanedReturn = tok.returnToNodeId === removedId;
		const orphanedOrigin = tok.originNodeId === removedId;
		const orphanedFrom = tok.fromNodeId === removedId;
		const orphanedBarrier = Boolean(tok.parentJoinBarrierId && removedOwnedBarrierIds.has(tok.parentJoinBarrierId));
		if (!orphanedReturn && !orphanedOrigin && !orphanedFrom && !orphanedBarrier) {
			continue;
		}
		const reparentTarget = [
			defaultFallbackSupervisorId,
			...[...(tok.hopLog ?? [])].reverse().map(h => h.fromNodeId),
			findHighestRankStaffNode(graphAfterRemoval)?.id,
		].find((id): id is string => Boolean(id && id !== removedId && id !== tok.nodeId && survivingStaffIds.has(id)));

		// If `reparentTarget` is currently parked on a `waiting` join barrier in the same wave,
		// attach `tok` directly into that barrier so returning `tok` never spawns a split-brain
		// concurrent active baton alongside `reparentTarget`'s `waiting_join` baton.
		const currentBarriers = reparentedBarriersMap ?? workingState.joinBarriers ?? {};
		const targetWaitingBarrier = reparentTarget
			? Object.values(currentBarriers).find(b => b.status === 'waiting' && b.ownerNodeId === reparentTarget && b.waveId === tok.waveId)
			: undefined;

		reparentedTokensMap ??= { ...workingState.tokens };
		if (targetWaitingBarrier) {
			reparentedBarriersMap ??= { ...(workingState.joinBarriers ?? {}) };
			const existingChildren = targetWaitingBarrier.childTokenIds;
			if (!existingChildren.includes(tok.id)) {
				reparentedBarriersMap[targetWaitingBarrier.id] = {
					...targetWaitingBarrier,
					childTokenIds: [...existingChildren, tok.id],
				};
			}
			const waitingParent = reparentedTokensMap[targetWaitingBarrier.parentTokenId];
			if (waitingParent && !(waitingParent.childTokenIds ?? []).includes(tok.id)) {
				reparentedTokensMap[waitingParent.id] = {
					...waitingParent,
					childTokenIds: [...(waitingParent.childTokenIds ?? []), tok.id],
					lastActivityAt: now,
				};
			}
			reparentedTokensMap[tok.id] = {
				...tok,
				parentTokenId: targetWaitingBarrier.parentTokenId,
				returnToNodeId: reparentTarget,
				...(orphanedOrigin ? { originNodeId: reparentTarget } : {}),
				...(orphanedFrom ? { fromNodeId: reparentTarget } : {}),
				parentJoinBarrierId: targetWaitingBarrier.id,
				lastActivityAt: now,
			};
		} else {
			reparentedTokensMap[tok.id] = {
				...tok,
				...(orphanedReturn ? (reparentTarget ? { returnToNodeId: reparentTarget } : { returnToNodeId: undefined }) : {}),
				...(orphanedOrigin ? { originNodeId: reparentTarget ?? 'User' } : {}),
				...(orphanedFrom ? (reparentTarget ? { fromNodeId: reparentTarget } : { fromNodeId: undefined }) : {}),
				...(orphanedBarrier ? { parentJoinBarrierId: undefined } : {}),
				lastActivityAt: now,
			};
		}
		reparentedTokenIds.push(tok.id);
	}
	if (reparentedTokensMap || reparentedBarriersMap) {
		workingState = {
			...workingState,
			...(reparentedTokensMap ? { tokens: reparentedTokensMap } : {}),
			...(reparentedBarriersMap ? { joinBarriers: reparentedBarriersMap } : {}),
			updatedAt: now,
		};
	}

	// Purge removed node from nodeStates, nodeAgentIds, nodeReadCursors, and pendingHeadlessEffects
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
	const reclaimedSet = new Set(reclaimedTokenIds);
	const nextPendingEffects = workingState.pendingHeadlessEffects
		? workingState.pendingHeadlessEffects.filter(eff => {
			if (eff.kind === 'post_inbox') {
				return true;
			}
			if (eff.nodeId === removedId) {
				return false;
			}
			const effTokenId = (eff as { readonly tokenId?: string }).tokenId;
			if (effTokenId && reclaimedSet.has(effTokenId)) {
				return false;
			}
			return true;
		})
		: undefined;

	return {
		ok: true,
		state: {
			...workingState,
			nodeStates: nextNodeStates,
			nodeAgentIds: nextNodeAgentIds,
			nodeReadCursors: nextCursors,
			pendingHeadlessEffects: nextPendingEffects && nextPendingEffects.length > 0 ? nextPendingEffects : undefined,
			stateRevision: Math.max(workingState.stateRevision ?? 0, state.stateRevision ?? 0) + 1,
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
