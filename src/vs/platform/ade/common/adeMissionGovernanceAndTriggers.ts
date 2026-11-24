/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { findParentSupervisorForEscalation, resolveSupervisorJurisdiction } from './adeMissionBoundary.js';
import { getMissionEdgeKind, IMissionDagParseResult, parseMissionMermaidDag } from './adeMissionDag.js';
import {
	appendTrace,
	checkMissionCompletion,
	cloneMutable,
	collectImpactedDownstreamJoins,
	collectValidUpstreamRollbackCandidates,
	computeWaveExpectedIncoming,
	deliverTokenToTarget,
	drainMissionConcurrencyQueue,
	freezeMutable,
	getIncomingEdges,
	getOutgoingEdges,
	IMissionEngineCaller,
	IMissionEngineTransitionResult,
	IMissionRuntimeState,
	IMissionSourceTrigger,
	IMissionToken,
	isValidUpstreamRollbackTarget,
	markBranchSkipped,
	materializeAndDispatchToken,
	recomputeNodeState,
	tryReleaseJoinBarrier,
} from './adeMissionEngine.js';
import { compressTokenHistoryState, mergeRollingHistoryStates } from './adeMissionFinOpsAndHistory.js';

/**
 * Off-graph supervisor escalates a failure or out-of-jurisdiction decision to its parent supervisor.
 * When `L1` (or top-most supervisor) escalates, the alert is delivered directly into Human `Inbox`.
 */
export function escalateMissionIssue(
	state: IMissionRuntimeState,
	params: {
		readonly callerSupervisorId: string;
		readonly reason: string;
		readonly tokenId?: string;
		readonly nodeId?: string;
		readonly ownerSessionId?: string;
		readonly isSecretary?: boolean;
		readonly isHumanUser?: boolean;
		readonly now?: number;
	},
): IMissionEngineTransitionResult<{ readonly escalatedToSupervisorId?: string; readonly escalatedToInbox: boolean }> {
	const isKnownSupervisor = state.boundary.supervisors.some(s => s.id === params.callerSupervisorId);
	const isOwner = Boolean(params.ownerSessionId && params.callerSupervisorId === params.ownerSessionId);
	if (!isKnownSupervisor && !isOwner && !params.isSecretary && !params.isHumanUser) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'FORBIDDEN',
			error: `Session "${params.callerSupervisorId}" is not a bound off-graph supervisor or owner of this Mission and cannot escalate.`,
		};
	}
	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	const parentSup = findParentSupervisorForEscalation(ctx.boundary, params.callerSupervisorId);
	const token = params.tokenId
		? ctx.tokens[params.tokenId]
		: (params.nodeId ? Object.values(ctx.tokens).find(t => t.nodeId === params.nodeId && (t.status === 'frozen_failed' || t.status === 'active')) : undefined);
	const nodeId = params.nodeId ?? token?.nodeId;
	const note = params.reason.trim() || 'Escalated by off-graph supervisor';

	if (parentSup) {
		if (token) {
			ctx.tokens[token.id] = {
				...token,
				failure: {
					reason: token.failure?.reason ?? note,
					failedAt: token.failure?.failedAt ?? now,
					escalatedToSupervisorId: parentSup.id,
					escalationHistory: [
						...(token.failure?.escalationHistory ?? []),
						{ fromId: params.callerSupervisorId, toId: parentSup.id, note, at: now },
					],
				},
			};
		}
		ctx.effects.push({
			kind: 'escalate_to_supervisor',
			missionId: state.missionId,
			supervisorId: parentSup.id,
			nodeId: nodeId ?? '',
			tokenId: token?.id ?? '',
			reason: `[Escalated from ${params.callerSupervisorId}] ${note}`,
		});
		return {
			ok: true,
			state: freezeMutable(state.missionId, ctx),
			effects: ctx.effects,
			data: { escalatedToSupervisorId: parentSup.id, escalatedToInbox: false },
		};
	}

	// Reached L1 / top-most off-graph level -> submit to Human Inbox!
	if (token) {
		ctx.tokens[token.id] = {
			...token,
			failure: {
				reason: token.failure?.reason ?? note,
				failedAt: token.failure?.failedAt ?? now,
				escalatedToInbox: true,
				escalationHistory: [
					...(token.failure?.escalationHistory ?? []),
					{ fromId: params.callerSupervisorId, toId: 'human-inbox', note, at: now },
				],
			},
		};
	}
	ctx.effects.push({
		kind: 'post_inbox',
		missionId: state.missionId,
		nodeId,
		tokenId: token?.id,
		title: nodeId ? `Mission Escalation (${nodeId})` : `Mission Escalation (${state.missionId})`,
		message: note,
		severity: 'critical',
		senderAgentId: params.callerSupervisorId,
	});
	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { escalatedToInbox: true },
	};
}

/**
 * Human resolves a waiting Gate node (`approve` advances downstream; `reject` bounces back).
 */
export function resolveMissionGate(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	params: {
		readonly nodeId: string;
		readonly decision: 'approve' | 'reject';
		readonly tokenId?: string;
		readonly note?: string;
		readonly rollbackNodeId?: string;
		readonly now?: number;
	},
): IMissionEngineTransitionResult<{ readonly nextTokenIds: readonly string[]; readonly resolvedTokenId?: string; readonly remainingQueuedGateCount?: number }> {
	if (state.status !== 'running' && state.status !== 'paused') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Mission is "${state.status}", not running or paused.` };
	}
	const waitingTokens = Object.values(state.tokens)
		.filter(t => t.nodeId === params.nodeId && t.status === 'waiting_gate')
		.sort((a, b) => a.arrivedAt - b.arrivedAt);
	const waitingToken = params.tokenId
		? waitingTokens.find(t => t.id === params.tokenId)
		: waitingTokens[0];
	if (!waitingToken) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'NOT_FOUND',
			error: params.tokenId
				? `Waiting gate token "${params.tokenId}" not found on Gate "${params.nodeId}".`
				: `No token is waiting at Gate "${params.nodeId}".`,
		};
	}
	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	ctx.tokens[waitingToken.id] = { ...waitingToken, status: 'completed', lastActivityAt: now };

	const surfaceNextQueuedGate = (): number => {
		const remaining = Object.values(ctx.tokens)
			.filter(t => t.nodeId === params.nodeId && t.status === 'waiting_gate')
			.sort((a, b) => a.arrivedAt - b.arrivedAt);
		if (remaining.length > 0) {
			const nextGateTok = remaining[0];
			const gateNode = graph.nodes.find(n => n.id === params.nodeId);
			const rollbackCandidates = collectValidUpstreamRollbackCandidates(ctx, graph, params.nodeId, nextGateTok.tracePtr, nextGateTok.fromNodeId).map(c => ({
				id: c.id,
				title: c.title,
			}));
			ctx.effects.push({
				kind: 'upsert_gate_inbox',
				missionId: state.missionId,
				nodeId: params.nodeId,
				tokenId: nextGateTok.id,
				nodeTitle: gateNode?.label ?? params.nodeId,
				upstreamSummary: nextGateTok.lastSummary,
				rollbackCandidates,
			});
		}
		return remaining.length;
	};

	if (params.decision === 'approve') {
		recomputeNodeState(ctx, params.nodeId, 'completed');
		const summary = params.note?.trim()
			? `[Gate ${params.nodeId} Approved] ${params.note.trim()}`
			: waitingToken.lastSummary;
		const approvePtr = appendTrace(ctx, {
			parentPtrs: [waitingToken.tracePtr],
			nodeId: params.nodeId,
			waveId: waitingToken.waveId,
			event: 'gate_approve',
			summary,
			timestamp: now,
		});
		const rolledHistory = compressTokenHistoryState(waitingToken.historyState, waitingToken.compressedHistory, waitingToken.lastSummary, waitingToken.fromNodeId);
		const nextTokenIds: string[] = [];
		// Untaken fail-branch edges from this approved Gate are marked skipped so downstream joins never deadlock.
		for (const failEdge of getOutgoingEdges(graph, params.nodeId, 'fail')) {
			markBranchSkipped(state.missionId, ctx, graph, waitingToken.waveId, params.nodeId, failEdge.to, now);
		}
		if (waitingToken.returnToNodeId && graph.nodes.some(n => n.id === waitingToken.returnToNodeId)) {
			const returnTarget = waitingToken.returnToNodeId;
			const outerReturnFrame = waitingToken.returnStack && waitingToken.returnStack.length > 0
				? waitingToken.returnStack[waitingToken.returnStack.length - 1]
				: undefined;
			const remainingReturnStack = waitingToken.returnStack && waitingToken.returnStack.length > 1
				? waitingToken.returnStack.slice(0, -1)
				: undefined;
			const allSuccessors = getOutgoingEdges(graph, params.nodeId, 'success');
			const onPathSuccessors = allSuccessors
				.filter(e => e.to === returnTarget || collectReachableNodes(graph, [e.to]).has(returnTarget));
			const onPathIds = new Set(onPathSuccessors.map(e => e.to));
			for (const offEdge of allSuccessors) {
				if (!onPathIds.has(offEdge.to)) {
					markBranchSkipped(state.missionId, ctx, graph, waitingToken.waveId, params.nodeId, offEdge.to, now);
				}
			}
			if (onPathSuccessors.length > 0) {
				for (const succEdge of onPathSuccessors) {
					const reachingReturnTarget = succEdge.to === returnTarget;
					const delivered = deliverTokenToTarget(state.missionId, ctx, graph, {
						targetNodeId: succEdge.to,
						fromNodeId: params.nodeId,
						waveId: waitingToken.waveId,
						lastSummary: summary,
						compressedHistory: rolledHistory.text,
						historyState: rolledHistory.state,
						tracePtr: approvePtr,
						now,
						returnToNodeId: reachingReturnTarget ? outerReturnFrame?.nodeId : returnTarget,
						returnWaveId: reachingReturnTarget ? outerReturnFrame?.waveId : waitingToken.returnWaveId,
						returnStack: reachingReturnTarget ? remainingReturnStack : waitingToken.returnStack,
						restoreWaveId: reachingReturnTarget ? waitingToken.returnWaveId : undefined,
					});
					if (delivered) {
						nextTokenIds.push(delivered.id);
					}
				}
			} else {
				const delivered = deliverTokenToTarget(state.missionId, ctx, graph, {
					targetNodeId: returnTarget,
					fromNodeId: params.nodeId,
					waveId: waitingToken.returnWaveId ?? waitingToken.waveId,
					lastSummary: summary,
					compressedHistory: rolledHistory.text,
					historyState: rolledHistory.state,
					tracePtr: approvePtr,
					now,
					bypassJoin: true,
					returnToNodeId: outerReturnFrame?.nodeId,
					returnWaveId: outerReturnFrame?.waveId,
					returnStack: remainingReturnStack,
				});
				if (delivered) {
					nextTokenIds.push(delivered.id);
				}
			}
		} else {
			for (const succEdge of getOutgoingEdges(graph, params.nodeId, 'success')) {
				const delivered = deliverTokenToTarget(state.missionId, ctx, graph, {
					targetNodeId: succEdge.to,
					fromNodeId: params.nodeId,
					waveId: waitingToken.waveId,
					lastSummary: summary,
					compressedHistory: rolledHistory.text,
					historyState: rolledHistory.state,
					tracePtr: approvePtr,
					now,
				});
				if (delivered) {
					nextTokenIds.push(delivered.id);
				}
			}
		}
		const remainingQueuedGateCount = surfaceNextQueuedGate();
		drainMissionConcurrencyQueue(state.missionId, ctx, now);
		checkMissionCompletion(ctx);
		return {
			ok: true,
			state: freezeMutable(state.missionId, ctx),
			effects: ctx.effects,
			data: { nextTokenIds, resolvedTokenId: waitingToken.id, remainingQueuedGateCount },
		};
	}

	// Gate reject -> bounce back to rollbackNodeId or direct upstream predecessor (strictly executed upstream ancestor)
	const explicitRollback = params.rollbackNodeId?.trim();
	const defaultRollback = (waitingToken.fromNodeId && isValidUpstreamRollbackTarget(state, graph, params.nodeId, waitingToken.fromNodeId, waitingToken.tracePtr))
		? waitingToken.fromNodeId
		: getIncomingEdges(graph, params.nodeId).map(e => e.from).find(fid => isValidUpstreamRollbackTarget(state, graph, params.nodeId, fid, waitingToken.tracePtr));
	const rollbackTarget = explicitRollback || defaultRollback;
	if (!rollbackTarget || !isValidUpstreamRollbackTarget(state, graph, params.nodeId, rollbackTarget, waitingToken.tracePtr)) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_STATE',
			error: explicitRollback
				? `Rollback target "${explicitRollback}" is not an executed upstream ancestor of Gate "${params.nodeId}".`
				: `No executed upstream rollback node found for Gate "${params.nodeId}" rejection.`,
		};
	}
	recomputeNodeState(ctx, params.nodeId, 'idle');
	ctx.waveSeq += 1;
	const reworkWaveId = `wave-${ctx.waveSeq}`;
	ctx.waveRoots[reworkWaveId] = [rollbackTarget];
	const note = params.note?.trim() || 'Rejected at Human Gate — revise and resubmit.';
	const rejPtr = appendTrace(ctx, {
		parentPtrs: [waitingToken.tracePtr],
		nodeId: params.nodeId,
		waveId: reworkWaveId,
		event: 'gate_reject',
		summary: `Gate rejected -> ${rollbackTarget}: ${note}`,
		timestamp: now,
	});
	const rolledRejectHistory = compressTokenHistoryState(waitingToken.historyState, waitingToken.compressedHistory, waitingToken.lastSummary, waitingToken.fromNodeId);
	const nextReturnStack = waitingToken.returnToNodeId
		? [...(waitingToken.returnStack ?? []), { nodeId: waitingToken.returnToNodeId, waveId: waitingToken.returnWaveId }]
		: waitingToken.returnStack;
	const bounced = deliverTokenToTarget(state.missionId, ctx, graph, {
		targetNodeId: rollbackTarget,
		fromNodeId: params.nodeId,
		waveId: reworkWaveId,
		lastSummary: `[Gate ${params.nodeId} Rejected] ${note}`,
		compressedHistory: rolledRejectHistory.text,
		historyState: rolledRejectHistory.state,
		tracePtr: rejPtr,
		now,
		isRejection: true,
		bypassJoin: true,
		returnToNodeId: params.nodeId,
		returnWaveId: waitingToken.waveId,
		returnStack: nextReturnStack,
	})!;
	const remainingQueuedGateCount = surfaceNextQueuedGate();
	drainMissionConcurrencyQueue(state.missionId, ctx, now);
	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { nextTokenIds: [bounced.id], resolvedTokenId: waitingToken.id, remainingQueuedGateCount },
	};
}

export function collectReachableNodes(graph: Pick<IMissionDagParseResult, 'edges'>, startIds: readonly string[]): Set<string> {
	const adj = new Map<string, string[]>();
	for (const e of graph.edges) {
		const list = adj.get(e.from) ?? [];
		list.push(e.to);
		adj.set(e.from, list);
	}
	const visited = new Set<string>();
	const queue = [...startIds];
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (visited.has(id)) { continue; }
		visited.add(id);
		for (const next of adj.get(id) ?? []) {
			if (!visited.has(next)) { queue.push(next); }
		}
	}
	return visited;
}

/**
 * Forcibly recalls active/blocked in-flight tokens within an off-graph supervisor's jurisdiction.
 * If requested nodes or affected parallel join branches exceed caller jurisdiction, blocks and
 * instructs escalation to the parent supervisor.
 */
export function recallMissionTokens(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	params: {
		readonly caller: IMissionEngineCaller;
		readonly nodeIds?: readonly string[];
		readonly branchRootNodeId?: string;
		readonly reason?: string;
		readonly now?: number;
	},
): IMissionEngineTransitionResult<{ readonly recalledTokenIds: readonly string[]; readonly affectedNodeIds: readonly string[] }> {
	const isOffGraph = Boolean(
		params.caller.isHumanUser
		|| params.caller.isSecretary
		|| (params.caller.tier !== undefined && params.caller.tier <= state.boundary.offGraphMaxTier),
	);
	if (!isOffGraph) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'FORBIDDEN',
			error: 'Only off-graph supervisors, L0 Secretary, or Human User may recall tokens.',
		};
	}

	const allNodeIds = graph.nodes.map(n => n.id);
	const jurisdiction = resolveSupervisorJurisdiction(
		state.boundary,
		params.caller.sessionId ?? '',
		allNodeIds,
		{ isHumanUser: params.caller.isHumanUser, isSecretary: params.caller.isSecretary, ownerSessionId: params.caller.ownerSessionId },
	);

	let targetNodeSet: Set<string>;
	if (params.branchRootNodeId) {
		targetNodeSet = collectReachableNodes(graph, [params.branchRootNodeId]);
	} else if (params.nodeIds && params.nodeIds.length > 0) {
		targetNodeSet = new Set(params.nodeIds);
	} else {
		targetNodeSet = new Set(
			Object.values(state.tokens)
				.filter(t => t.status === 'active' || t.status === 'queued' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'frozen_failed')
				.map(t => t.nodeId)
				.filter(nid => jurisdiction.hasFullJurisdiction || jurisdiction.nodeIds.has(nid)),
		);
	}

	const explicitNodeSet = new Set(params.nodeIds ?? []);
	if (!jurisdiction.hasFullJurisdiction) {
		const outOfScope = [...targetNodeSet].filter(nid => !jurisdiction.nodeIds.has(nid));
		// Check if any recalled branch feeds a join barrier (either already open or reachable downstream in an active wave) outside jurisdiction.
		for (const barrier of Object.values(state.joinBarriers)) {
			if (barrier.expectedFromNodeIds.some(fid => targetNodeSet.has(fid)) && !jurisdiction.nodeIds.has(barrier.targetNodeId)) {
				outOfScope.push(barrier.targetNodeId);
			}
		}
		const hasLiveInTarget = Object.values(state.tokens).some(t =>
			targetNodeSet.has(t.nodeId) && (t.status === 'active' || t.status === 'queued' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'waiting_join' || t.status === 'frozen_failed'),
		);
		if (hasLiveInTarget) {
			for (const joinNodeId of collectImpactedDownstreamJoins(graph, targetNodeSet)) {
				if (!jurisdiction.nodeIds.has(joinNodeId)) {
					outOfScope.push(joinNodeId);
				}
			}
		}
		if (outOfScope.length > 0) {
			const uniqueOut = [...new Set(outOfScope)];
			const parentSup = params.caller.sessionId ? findParentSupervisorForEscalation(state.boundary, params.caller.sessionId) : undefined;
			return {
				ok: false,
				state,
				effects: [],
				code: 'OUT_OF_JURISDICTION',
				outOfScopeNodeIds: uniqueOut,
				parentSupervisorId: parentSup?.id,
				error: `Recall touches node(s) outside your jurisdiction (${uniqueOut.join(', ')}). Escalate to ${parentSup ? `supervisor "${parentSup.id}"` : 'higher authority'} to coordinate recall.`,
			};
		}
	}

	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	const reason = params.reason?.trim() || 'Recalled by off-graph supervisor';
	const recalledTokenIds: string[] = [];
	const affectedNodeIds = new Set<string>();
	const recalledWavesByNode = new Map<string, Set<string>>();
	const recordRecalledBranchWave = (nodeId: string, waveId: string) => {
		let waves = recalledWavesByNode.get(nodeId);
		if (!waves) {
			waves = new Set<string>();
			recalledWavesByNode.set(nodeId, waves);
		}
		waves.add(waveId);
	};

	for (const [tid, tok] of Object.entries(ctx.tokens)) {
		if (!targetNodeSet.has(tok.nodeId)) {
			continue;
		}
		if (tok.status === 'active' || tok.status === 'queued' || tok.status === 'blocked' || tok.status === 'waiting_gate' || tok.status === 'waiting_join' || tok.status === 'frozen_failed') {
			// When recalling via `branchRootNodeId`, preserve uncontaminated sibling `waiting_join` arrivals
			// at a downstream join node (handled cleanly by join-barrier reconciliation below).
			if (tok.status === 'waiting_join' && params.branchRootNodeId && !explicitNodeSet.has(tok.nodeId) && tok.fromNodeId && !targetNodeSet.has(tok.fromNodeId)) {
				continue;
			}
			const liveHolder = ctx.boundary.nodeAssignments[tok.nodeId]?.agentId ?? tok.holderAgentId;
			const recPtr = appendTrace(ctx, {
				parentPtrs: [tok.tracePtr],
				nodeId: tok.nodeId,
				employeeId: liveHolder,
				waveId: tok.waveId,
				event: 'recall',
				summary: reason,
				timestamp: now,
			});
			ctx.tokens[tid] = { ...tok, status: 'recalled', blocked: undefined, queued: undefined, tracePtr: recPtr, lastActivityAt: now };
			if (tok.status !== 'waiting_join' || explicitNodeSet.has(tok.nodeId) || !params.branchRootNodeId) {
				recomputeNodeState(ctx, tok.nodeId, 'idle');
				recordRecalledBranchWave(tok.nodeId, tok.waveId);
			} else if (tok.fromNodeId) {
				recordRecalledBranchWave(tok.fromNodeId, tok.waveId);
			}
			recalledTokenIds.push(tid);
			affectedNodeIds.add(tok.nodeId);
			if (tok.status === 'active' || tok.status === 'blocked') {
				ctx.effects.push({
					kind: 'stop_agent',
					missionId: state.missionId,
					nodeId: tok.nodeId,
					tokenId: tok.id,
					holderAgentId: liveHolder,
					reason,
				});
			}
		}
	}

	// Reconcile existing join barriers:
	// - If a join target itself was explicitly recalled (or has no uncontaminated sibling arrivals), clear the barrier
	//   AND record `(barrier.targetNodeId, barrier.waveId)` so any nested downstream join barrier is marked skipped.
	// - If reached only via branchRootNodeId while an unrelated sibling already arrived at the join, preserve the sibling arrival.
	// - Purge any stale arrivals from recalled upstream nodes and record their (fromId, waveId) so downstream joins mark them skipped.
	for (const [bKey, barrier] of Object.entries(ctx.joinBarriers)) {
		const siblingArrivals = Object.entries(barrier.arrivedByFrom).filter(([fromId]) => !targetNodeSet.has(fromId));
		const explicitlyRecalledJoin = explicitNodeSet.has(barrier.targetNodeId) || (!params.branchRootNodeId && targetNodeSet.has(barrier.targetNodeId));
		if (targetNodeSet.has(barrier.targetNodeId) && (explicitlyRecalledJoin || siblingArrivals.length === 0)) {
			for (const arrivedTok of Object.values(barrier.arrivedByFrom)) {
				if (!recalledTokenIds.includes(arrivedTok.id)) {
					recalledTokenIds.push(arrivedTok.id);
				}
				if (ctx.tokens[arrivedTok.id]) {
					ctx.tokens[arrivedTok.id] = { ...ctx.tokens[arrivedTok.id], status: 'recalled', lastActivityAt: now };
				}
			}
			affectedNodeIds.add(barrier.targetNodeId);
			recordRecalledBranchWave(barrier.targetNodeId, barrier.waveId);
			delete ctx.joinBarriers[bKey];
			recomputeNodeState(ctx, barrier.targetNodeId, 'idle');
			continue;
		}
		let cleaned = false;
		const nextArrived: Record<string, IMissionToken> = {};
		for (const [fromId, arrivedTok] of Object.entries(barrier.arrivedByFrom)) {
			if (targetNodeSet.has(fromId)) {
				cleaned = true;
				if (!recalledTokenIds.includes(arrivedTok.id)) {
					recalledTokenIds.push(arrivedTok.id);
				}
				affectedNodeIds.add(fromId);
				recordRecalledBranchWave(fromId, barrier.waveId);
				if (ctx.tokens[arrivedTok.id]) {
					ctx.tokens[arrivedTok.id] = { ...ctx.tokens[arrivedTok.id], status: 'recalled', lastActivityAt: now };
				}
			} else {
				nextArrived[fromId] = arrivedTok;
			}
		}
		if (cleaned) {
			ctx.joinBarriers[bKey] = {
				...barrier,
				arrivedByFrom: nextArrived,
			};
			if (Object.keys(nextArrived).length === 0 && ctx.nodeStates[barrier.targetNodeId] === 'waiting_join') {
				ctx.nodeStates[barrier.targetNodeId] = 'idle';
			}
		}
	}

	// Anti-deadlock for single-branch recall: propagate skip marks from every recalled branch into downstream join barriers
	// so surviving parallel sibling branches never deadlock forever waiting on a recalled branch.
	for (const [recalledNodeId, waveIds] of recalledWavesByNode.entries()) {
		for (const waveId of waveIds) {
			for (const outEdge of getOutgoingEdges(graph, recalledNodeId)) {
				markBranchSkipped(state.missionId, ctx, graph, waveId, recalledNodeId, outEdge.to, now);
			}
		}
	}

	// Drop any deferred dispatches for recalled tokens
	if (recalledTokenIds.length > 0 && ctx.deferredEffects.length > 0) {
		const recalledSet = new Set(recalledTokenIds);
		ctx.deferredEffects = ctx.deferredEffects.filter(eff => !(eff.kind === 'dispatch_token' && recalledSet.has(eff.tokenId)));
	}

	drainMissionConcurrencyQueue(state.missionId, ctx, now);
	checkMissionCompletion(ctx);

	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { recalledTokenIds, affectedNodeIds: [...affectedNodeIds] },
	};
}

/**
 * Atomic safe Mermaid DAG patcher (`mission_plan.md` Section 4.3 #3):
 * 1. Strictly off-graph supervisors / L0 / Human only.
 * 2. Validates Mermaid syntax & DAG acyclicity.
 * 3. Protects already-completed nodes from deletion/rewriting and rejects new incoming edges into completed nodes.
 * 4. Enforces supervisor jurisdiction over all added/removed/modified nodes, relabeled edges & join interfaces;
 *    returns `OUT_OF_JURISDICTION` + `parentSupervisorId` when escalation is required.
 * 5. **Hard Anti-Dangling Connectivity Validation**:
 *    No surviving non-source downstream node may lose all reachable incoming paths
 *    (e.g., deleting sole upstream node A before providing an alternative path to B is rejected!).
 *    Multi-branch join pruning is allowed only when remaining branches still reach the join
 *    AND caller has jurisdiction over that join node.
 * 6. Prunes removed nodes from boundary & binds added nodes to caller supervisor, reconciles open join barriers,
 *    kicks off newly ready added/reconnected nodes with inherited wave & history, and emits `mermaid_patched`.
 */
export function applySafeMissionPatch(
	state: IMissionRuntimeState,
	currentGraph: IMissionDagParseResult,
	params: {
		readonly caller: IMissionEngineCaller;
		readonly newMermaidText: string;
		readonly reason?: string;
		readonly now?: number;
	},
): IMissionEngineTransitionResult<{
	readonly addedNodes: readonly string[];
	readonly removedNodes: readonly string[];
	readonly addedEdges: readonly string[];
	readonly removedEdges: readonly string[];
}> {
	const isOffGraph = Boolean(
		params.caller.isHumanUser
		|| params.caller.isSecretary
		|| (params.caller.tier !== undefined && params.caller.tier <= state.boundary.offGraphMaxTier),
	);
	if (!isOffGraph) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'FORBIDDEN',
			error: 'In-graph employees are strictly forbidden from patching the Mission DAG.',
		};
	}

	const nextGraph = parseMissionMermaidDag(params.newMermaidText);
	if (nextGraph.error || nextGraph.nodes.length === 0) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_DAG',
			error: nextGraph.error || 'Patched Mermaid DAG cannot be empty.',
		};
	}

	const oldNodeMap = new Map(currentGraph.nodes.map(n => [n.id, n]));
	const newNodeMap = new Map(nextGraph.nodes.map(n => [n.id, n]));
	const oldEdgeMap = new Map(currentGraph.edges.map(e => [e.id, e]));
	const newEdgeMap = new Map(nextGraph.edges.map(e => [e.id, e]));

	const addedNodes = nextGraph.nodes.filter(n => !oldNodeMap.has(n.id)).map(n => n.id);
	const removedNodes = currentGraph.nodes.filter(n => !newNodeMap.has(n.id)).map(n => n.id);
	const modifiedNodes = nextGraph.nodes
		.filter(n => {
			const prev = oldNodeMap.get(n.id);
			return prev && (prev.label !== n.label || prev.kind !== n.kind || prev.employeeKey !== n.employeeKey);
		})
		.map(n => n.id);
	const addedEdges = nextGraph.edges.filter(e => !oldEdgeMap.has(e.id)).map(e => e.id);
	const removedEdges = currentGraph.edges.filter(e => !newEdgeMap.has(e.id)).map(e => e.id);
	const modifiedEdges = nextGraph.edges
		.filter(e => {
			const prev = oldEdgeMap.get(e.id);
			return Boolean(prev && (getMissionEdgeKind(prev) !== getMissionEdgeKind(e) || prev.label !== e.label));
		})
		.map(e => e.id);

	// Completed-zone protection (no deleting/modifying completed nodes or adding/relabeling incoming edges into completed nodes)
	for (const nid of [...removedNodes, ...modifiedNodes]) {
		if (state.nodeStates[nid] === 'completed') {
			return {
				ok: false,
				state,
				effects: [],
				code: 'INVALID_STATE',
				error: `Cannot delete or modify already-completed node "${nid}". Only unfinished regions may be patched.`,
			};
		}
	}
	for (const eId of [...addedEdges, ...modifiedEdges]) {
		const e = newEdgeMap.get(eId)!;
		if (state.nodeStates[e.to] === 'completed') {
			return {
				ok: false,
				state,
				effects: [],
				code: 'INVALID_STATE',
				error: `Cannot add or modify incoming edge "${e.from} -> ${e.to}" targeting already-completed node "${e.to}".`,
			};
		}
	}

	// Compute old & new in-degrees
	const oldInDeg = new Map<string, number>();
	const newInDeg = new Map<string, number>();
	for (const n of currentGraph.nodes) { oldInDeg.set(n.id, 0); }
	for (const e of currentGraph.edges) { oldInDeg.set(e.to, (oldInDeg.get(e.to) ?? 0) + 1); }
	for (const n of nextGraph.nodes) { newInDeg.set(n.id, 0); }
	for (const e of nextGraph.edges) { newInDeg.set(e.to, (newInDeg.get(e.to) ?? 0) + 1); }

	// Jurisdiction check over all touched existing nodes, relabeled edges & join endpoints
	const allOldIds = currentGraph.nodes.map(n => n.id);
	const jurisdiction = resolveSupervisorJurisdiction(
		state.boundary,
		params.caller.sessionId ?? '',
		allOldIds,
		{ isHumanUser: params.caller.isHumanUser, isSecretary: params.caller.isSecretary, ownerSessionId: params.caller.ownerSessionId },
	);

	if (!jurisdiction.hasFullJurisdiction) {
		const touchedExisting = new Set<string>([...removedNodes, ...modifiedNodes]);
		for (const eId of removedEdges) {
			const e = oldEdgeMap.get(eId)!;
			if (state.nodeStates[e.from] !== 'completed') {
				touchedExisting.add(e.from);
			}
			touchedExisting.add(e.to);
		}
		for (const eId of modifiedEdges) {
			const e = newEdgeMap.get(eId)!;
			touchedExisting.add(e.from);
			touchedExisting.add(e.to);
		}
		for (const eId of addedEdges) {
			const e = newEdgeMap.get(eId)!;
			if (oldNodeMap.has(e.from) && state.nodeStates[e.from] !== 'completed') {
				touchedExisting.add(e.from);
			}
			if (oldNodeMap.has(e.to)) {
				touchedExisting.add(e.to);
			}
		}
		const outOfScope = [...touchedExisting].filter(nid => !jurisdiction.nodeIds.has(nid));
		if (outOfScope.length > 0) {
			const parentSup = params.caller.sessionId ? findParentSupervisorForEscalation(state.boundary, params.caller.sessionId) : undefined;
			return {
				ok: false,
				state,
				effects: [],
				code: 'OUT_OF_JURISDICTION',
				outOfScopeNodeIds: outOfScope,
				parentSupervisorId: parentSup?.id,
				error: `Patch touches node(s) outside your jurisdiction (${outOfScope.join(', ')}). Escalate to ${parentSup ? `supervisor "${parentSup.id}"` : 'higher authority'}.`,
			};
		}
	}

	// HARD ANTI-DANGLING CONNECTIVITY CHECK:
	// Any surviving unfinished node that previously had incoming edges MUST retain >= 1 incoming edge
	// AND remain reachable from valid entry sources (original source nodes, newly added source nodes, or completed nodes).
	// Completed anchors already succeeded, so only their `success` outgoing edges are live for reachability
	// (preventing a dead `-->|fail|` edge from an already-completed node from masking an orphaned downstream node).
	const validEntryStarts: string[] = [];
	for (const n of nextGraph.nodes) {
		const isOriginalSource = oldNodeMap.has(n.id) && (oldInDeg.get(n.id) ?? 0) === 0;
		const isNewlyAddedSource = !oldNodeMap.has(n.id) && (newInDeg.get(n.id) ?? 0) === 0;
		const isCompletedAnchor = state.nodeStates[n.id] === 'completed';
		if (isOriginalSource || isNewlyAddedSource || isCompletedAnchor) {
			validEntryStarts.push(n.id);
		}
	}
	const liveReachableEdges = nextGraph.edges.filter(
		e => state.nodeStates[e.from] !== 'completed' || getMissionEdgeKind(e) === 'success',
	);
	const reachableInNew = collectReachableNodes({ edges: liveReachableEdges }, validEntryStarts);
	const danglingNodeIds: string[] = [];
	for (const n of nextGraph.nodes) {
		const hadIncomingBefore = oldNodeMap.has(n.id) && (oldInDeg.get(n.id) ?? 0) > 0;
		if (hadIncomingBefore && state.nodeStates[n.id] !== 'completed') {
			if ((newInDeg.get(n.id) ?? 0) === 0 || !reachableInNew.has(n.id)) {
				danglingNodeIds.push(n.id);
			}
		}
	}
	if (danglingNodeIds.length > 0) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'DANGLING_NODE_VIOLATION',
			danglingNodeIds,
			error: `Anti-dangling violation: patching would orphan downstream node(s) [${danglingNodeIds.join(', ')}] with no incoming path. Atomically add a replacement route to these node(s) in the same patch.`,
		};
	}

	// Apply atomic patch!
	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);

	// 1. Clean up removed nodes' states, tokens (including waiting_join), deferred effects, triggers & boundary
	const removedSet = new Set(removedNodes);
	const removedRecalledTokens: IMissionToken[] = [];
	for (const rid of removedNodes) {
		delete ctx.nodeStates[rid];
		if (ctx.nodeTelemetry) {
			delete ctx.nodeTelemetry[rid];
		}
	}
	for (const [tid, tok] of Object.entries(ctx.tokens)) {
		if (removedSet.has(tok.nodeId) && (tok.status === 'active' || tok.status === 'queued' || tok.status === 'blocked' || tok.status === 'waiting_gate' || tok.status === 'waiting_join' || tok.status === 'frozen_failed')) {
			removedRecalledTokens.push(tok);
			ctx.tokens[tid] = { ...tok, status: 'recalled', blocked: undefined, queued: undefined, lastActivityAt: now };
			if (tok.status === 'active' || tok.status === 'blocked') {
				ctx.effects.push({
					kind: 'stop_agent',
					missionId: state.missionId,
					nodeId: tok.nodeId,
					tokenId: tok.id,
					holderAgentId: ctx.boundary.nodeAssignments[tok.nodeId]?.agentId ?? tok.holderAgentId,
					reason: params.reason || 'Node removed by atomic DAG patch',
				});
			}
		}
	}
	if (removedSet.size > 0 && ctx.deferredEffects.length > 0) {
		ctx.deferredEffects = ctx.deferredEffects.filter(eff => !(eff.kind === 'dispatch_token' && removedSet.has(eff.nodeId)));
	}
	ctx.triggers = ctx.triggers.filter(tr => !removedSet.has(tr.nodeId));

	// Boundary hygiene: prune removed nodes from nodeAssignments & supervisors, and grant addedNodes to partial caller supervisor
	if (removedSet.size > 0 || addedNodes.length > 0) {
		const nextAssignments: Record<string, typeof ctx.boundary.nodeAssignments[string]> = {};
		for (const [nid, assignment] of Object.entries(ctx.boundary.nodeAssignments)) {
			if (!removedSet.has(nid)) {
				nextAssignments[nid] = assignment;
			}
		}
		const callerSupId = params.caller.sessionId;
		const nextSupervisors = ctx.boundary.supervisors.map(sup => {
			let managed = sup.managedNodeIds.filter(nid => !removedSet.has(nid));
			if (addedNodes.length > 0 && callerSupId && sup.id === callerSupId && (sup.managedNodeIds.length > 0 || !jurisdiction.hasFullJurisdiction)) {
				const existingSet = new Set(managed);
				managed = [...managed, ...addedNodes.filter(aid => !existingSet.has(aid))];
			}
			return { ...sup, managedNodeIds: managed };
		});
		ctx.boundary = {
			...ctx.boundary,
			nodeAssignments: nextAssignments,
			supervisors: nextSupervisors,
		};
	}

	// 2. Initialize newly added nodes and register any newly added source nodes into active waves feeding open barriers
	for (const aid of addedNodes) {
		ctx.nodeStates[aid] = 'idle';
	}
	if (addedNodes.length > 0 && Object.keys(ctx.joinBarriers).length > 0) {
		const newSources = addedNodes.filter(aid => (newInDeg.get(aid) ?? 0) === 0 && !ctx.triggers.some(tr => tr.enabled && tr.nodeId === aid));
		for (const srcId of newSources) {
			const reachableFromSrc = collectReachableNodes(nextGraph, [srcId]);
			for (const barrier of Object.values(ctx.joinBarriers)) {
				if (reachableFromSrc.has(barrier.targetNodeId)) {
					const roots = ctx.waveRoots[barrier.waveId] ?? [];
					if (!roots.includes(srcId)) {
						ctx.waveRoots[barrier.waveId] = [...roots, srcId];
					}
				}
			}
		}
	}

	// 3. Reconcile open join barriers against the new edge set & wave roots!
	for (const [bKey, barrier] of Object.entries(ctx.joinBarriers)) {
		if (removedSet.has(barrier.targetNodeId)) {
			for (const arrivedTok of Object.values(barrier.arrivedByFrom)) {
				if (ctx.tokens[arrivedTok.id] && ctx.tokens[arrivedTok.id].status === 'waiting_join') {
					ctx.tokens[arrivedTok.id] = { ...ctx.tokens[arrivedTok.id], status: 'recalled', lastActivityAt: now };
				}
			}
			delete ctx.joinBarriers[bKey];
			continue;
		}
		const nextExpected = computeWaveExpectedIncoming(ctx, nextGraph, barrier.waveId, barrier.targetNodeId);
		const nextExpectedSet = new Set(nextExpected);
		const nextArrived: Record<string, IMissionToken> = {};
		for (const [fid, tok] of Object.entries(barrier.arrivedByFrom)) {
			if (nextExpectedSet.has(fid)) {
				nextArrived[fid] = tok;
			} else if (ctx.tokens[tok.id] && ctx.tokens[tok.id].status === 'waiting_join') {
				ctx.tokens[tok.id] = { ...ctx.tokens[tok.id], status: 'recalled', lastActivityAt: now };
			}
		}
		if (nextExpected.length === 0) {
			delete ctx.joinBarriers[bKey];
			recomputeNodeState(ctx, barrier.targetNodeId, 'idle');
			continue;
		}
		const nextSkipped = barrier.skippedFromNodeIds.filter(fid => nextExpectedSet.has(fid));
		ctx.joinBarriers[bKey] = {
			...barrier,
			expectedFromNodeIds: [...nextExpected],
			arrivedByFrom: nextArrived,
			skippedFromNodeIds: nextSkipped,
		};
		tryReleaseJoinBarrier(state.missionId, ctx, nextGraph, bKey, now);
	}

	// 4. Kick off newly added OR newly reconnected ready nodes (both while running and queued while paused),
	//    and replay already-completed upstream arrivals into newly added/rewired multi-branch joins so they never deadlock!
	if (ctx.status === 'running' || ctx.status === 'paused') {
		const addedNodeSet = new Set(addedNodes);
		const kickCandidates: string[] = [];
		const seenCandidates = new Set<string>();
		for (const aid of addedNodes) {
			if (!seenCandidates.has(aid)) {
				seenCandidates.add(aid);
				kickCandidates.push(aid);
			}
		}
		for (const eId of addedEdges) {
			const targetId = newEdgeMap.get(eId)?.to;
			if (targetId && !seenCandidates.has(targetId)) {
				seenCandidates.add(targetId);
				kickCandidates.push(targetId);
			}
		}

		const latestRemovedTok = [...removedRecalledTokens].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
		const findLatestCompletedTokenForNode = (nid: string): IMissionToken | undefined =>
			Object.values(ctx.tokens)
				.filter(t => t.nodeId === nid && t.status === 'completed')
				.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];

		for (const cid of kickCandidates) {
			if (ctx.nodeStates[cid] === 'completed') {
				continue;
			}
			const hasLiveOnNode = Object.values(ctx.tokens).some(t =>
				t.nodeId === cid && (t.status === 'active' || t.status === 'queued' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'frozen_failed'),
			);
			if (hasLiveOnNode) {
				continue;
			}
			const incoming = getIncomingEdges(nextGraph, cid);
			const isNewUntriggeredSource = incoming.length === 0 && addedNodeSet.has(cid) && !ctx.triggers.some(tr => tr.enabled && tr.nodeId === cid);
			if (isNewUntriggeredSource) {
				if (Object.values(ctx.joinBarriers).some(b => b.targetNodeId === cid)) {
					continue;
				}
				const reachableFromNewSrc = collectReachableNodes(nextGraph, [cid]);
				const feedingBarrier = Object.values(ctx.joinBarriers).find(b => reachableFromNewSrc.has(b.targetNodeId));
				let targetWaveId = feedingBarrier?.waveId ?? latestRemovedTok?.waveId;
				if (!targetWaveId) {
					ctx.waveSeq += 1;
					targetWaveId = `wave-${ctx.waveSeq}`;
				}
				const existingRoots = ctx.waveRoots[targetWaveId] ?? [];
				if (!existingRoots.includes(cid)) {
					ctx.waveRoots[targetWaveId] = [...existingRoots, cid];
				}
				const summaryText = params.reason
					? (latestRemovedTok?.lastSummary ? `[Patched Route: ${params.reason}] ${latestRemovedTok.lastSummary}` : `[Patched Route] ${params.reason}`)
					: (latestRemovedTok?.lastSummary || 'Patched replacement route activated.');
				const ptr = appendTrace(ctx, {
					parentPtrs: latestRemovedTok ? [latestRemovedTok.tracePtr] : [],
					nodeId: cid,
					employeeId: ctx.boundary.nodeAssignments[cid]?.agentId,
					waveId: targetWaveId,
					event: 'mint',
					summary: params.reason ? `Patched recovery path: ${params.reason}` : 'Patched recovery step started',
					timestamp: now,
				});
				materializeAndDispatchToken(state.missionId, ctx, nextGraph, {
					targetNodeId: cid,
					waveId: targetWaveId,
					lastSummary: summaryText,
					compressedHistory: latestRemovedTok?.compressedHistory ?? '',
					historyState: latestRemovedTok?.historyState,
					tracePtr: ptr,
					now,
				});
				continue;
			}

			// Replay already-completed upstream edges into `cid` (handles single-input kickoffs, multi-input all-completed merges,
			// AND partially-completed new/rewired join nodes whose remaining sibling branches are still in flight!).
			const allSuccessIncoming = incoming.filter(e => getMissionEdgeKind(e) === 'success');
			const completedSuccessEdges = allSuccessIncoming.filter(e => ctx.nodeStates[e.from] === 'completed');
			const completedFailEdges = incoming.filter(e => getMissionEdgeKind(e) === 'fail' && ctx.nodeStates[e.from] === 'completed');
			if (completedSuccessEdges.length === 0) {
				continue;
			}
			const existingBarrier = Object.values(ctx.joinBarriers).find(b => b.targetNodeId === cid);
			const edgesToReplay = existingBarrier
				? completedSuccessEdges.filter(e => !existingBarrier.arrivedByFrom[e.from])
				: completedSuccessEdges;
			if (edgesToReplay.length === 0) {
				continue;
			}

			const resolveUpstreamInfo = (fromNodeId: string) => {
				const upTok = findLatestCompletedTokenForNode(fromNodeId);
				const anchorTok = upTok ?? latestRemovedTok;
				const latestCompleteTrace = upTok
					? Object.values(ctx.traces)
						.filter(tr => tr.nodeId === upTok.nodeId && tr.waveId === upTok.waveId && tr.event === 'complete')
						.sort((a, b) => b.timestamp - a.timestamp)[0]
					: undefined;
				const inheritedSummary = latestCompleteTrace?.summary
					|| upTok?.lastSummary
					|| anchorTok?.lastSummary
					|| 'Patched replacement route activated.';
				const inheritedHistory = upTok
					? compressTokenHistoryState(upTok.historyState, upTok.compressedHistory, upTok.lastSummary, upTok.fromNodeId)
					: { text: anchorTok?.compressedHistory ?? '', state: anchorTok?.historyState };
				return { upTok, anchorTok, inheritedSummary, inheritedHistory };
			};

			// Determine canonical waveId across replayed completed edges
			const firstUpstreamTok = edgesToReplay
				.map(e => findLatestCompletedTokenForNode(e.from))
				.filter((t): t is IMissionToken => Boolean(t))
				.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
			let targetWaveId = existingBarrier?.waveId ?? firstUpstreamTok?.waveId ?? latestRemovedTok?.waveId;
			if (!targetWaveId) {
				ctx.waveSeq += 1;
				targetWaveId = `wave-${ctx.waveSeq}`;
			}
			// Mark untaken fail edges from already-completed predecessors skipped in this wave
			for (const fEdge of completedFailEdges) {
				markBranchSkipped(state.missionId, ctx, nextGraph, targetWaveId, fEdge.from, cid, now);
			}

			// When ALL incoming success branches are already completed (multi-inDegree patch merge),
			// merge EVERY completed upstream summary, rolling history, and trace pointer into one unified join token
			// instead of losing sibling branch context across waves.
			if (!existingBarrier && edgesToReplay.length > 1 && completedSuccessEdges.length === allSuccessIncoming.length) {
				const infos = edgesToReplay.map(edge => ({ edge, ...resolveUpstreamInfo(edge.from) }));
				const mergedSummaryBody = infos
					.map(info => `[${info.edge.from}] ${info.inheritedSummary}`.trim())
					.join('\n');
				const mergedSummary = params.reason
					? `[Patched Route: ${params.reason}]\n${mergedSummaryBody}`
					: mergedSummaryBody;
				const mergedHistory = mergeRollingHistoryStates(
					infos.map(info => ({
						compressedHistory: info.inheritedHistory.text,
						historyState: info.inheritedHistory.state,
					})),
				);
				const parentPtrs = [...new Set(infos.map(info => info.anchorTok?.tracePtr).filter((p): p is string => Boolean(p)))];
				const mergePtr = appendTrace(ctx, {
					parentPtrs,
					nodeId: cid,
					employeeId: ctx.boundary.nodeAssignments[cid]?.agentId,
					waveId: targetWaveId,
					event: 'join',
					summary: params.reason
						? `Patched merge (${infos.map(i => i.edge.from).join(', ')}): ${params.reason}`
						: `Patched merge of ${infos.length} completed branch(es): ${infos.map(i => i.edge.from).join(', ')}`,
					timestamp: now,
				});
				deliverTokenToTarget(state.missionId, ctx, nextGraph, {
					targetNodeId: cid,
					fromNodeId: infos[infos.length - 1].edge.from,
					waveId: targetWaveId,
					lastSummary: mergedSummary,
					compressedHistory: mergedHistory.text,
					historyState: mergedHistory.state,
					tracePtr: mergePtr,
					now,
					bypassJoin: true,
				});
				continue;
			}

			// Ensure waveRoots[targetWaveId] covers every replayed predecessor so partial multi-branch joins park cleanly.
			const curRoots = ctx.waveRoots[targetWaveId] ?? [];
			const nextRoots = [...curRoots];
			for (const edge of edgesToReplay) {
				const upTok = findLatestCompletedTokenForNode(edge.from);
				const upRoots = upTok ? (ctx.waveRoots[upTok.waveId] ?? [edge.from]) : [edge.from];
				for (const r of upRoots) {
					if (!nextRoots.includes(r)) {
						nextRoots.push(r);
					}
				}
			}
			if (nextRoots.length > curRoots.length) {
				ctx.waveRoots[targetWaveId] = nextRoots;
			}

			for (const edge of edgesToReplay) {
				const { anchorTok, inheritedSummary, inheritedHistory } = resolveUpstreamInfo(edge.from);
				const summaryText = params.reason
					? `[Patched Route: ${params.reason}] ${inheritedSummary}`
					: inheritedSummary;
				const ptr = appendTrace(ctx, {
					parentPtrs: anchorTok ? [anchorTok.tracePtr] : [],
					nodeId: cid,
					employeeId: ctx.boundary.nodeAssignments[cid]?.agentId,
					waveId: targetWaveId,
					event: 'mint',
					summary: params.reason ? `Patched recovery path: ${params.reason}` : 'Patched recovery step started',
					timestamp: now,
				});
				deliverTokenToTarget(state.missionId, ctx, nextGraph, {
					targetNodeId: cid,
					fromNodeId: edge.from,
					waveId: targetWaveId,
					lastSummary: summaryText,
					compressedHistory: inheritedHistory.text,
					historyState: inheritedHistory.state,
					tracePtr: ptr,
					now,
				});
			}
		}
	}

	ctx.effects.push({
		kind: 'mermaid_patched',
		missionId: state.missionId,
		newMermaidText: params.newMermaidText,
		reason: params.reason,
	});
	drainMissionConcurrencyQueue(state.missionId, ctx, now);
	checkMissionCompletion(ctx);

	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { addedNodes, removedNodes, addedEdges, removedEdges },
	};
}

const CRON_FIELD_BOUNDS: readonly { readonly name: string; readonly min: number; readonly max: number; readonly isDow: boolean }[] = [
	{ name: 'minute', min: 0, max: 59, isDow: false },
	{ name: 'hour', min: 0, max: 23, isDow: false },
	{ name: 'day-of-month', min: 1, max: 31, isDow: false },
	{ name: 'month', min: 1, max: 12, isDow: false },
	{ name: 'day-of-week', min: 0, max: 7, isDow: true },
];

function validateCronField(field: string, min: number, max: number, isDow: boolean): boolean {
	const parts = field.split(',');
	if (parts.length === 0) {
		return false;
	}
	for (const rawPart of parts) {
		const part = rawPart.trim();
		if (!part) {
			return false;
		}
		const slashParts = part.split('/');
		if (slashParts.length > 2) {
			return false;
		}
		const [rangePart, stepPart] = slashParts;
		if (stepPart !== undefined) {
			if (!/^\d+$/.test(stepPart)) {
				return false;
			}
			const step = Number.parseInt(stepPart, 10);
			if (!Number.isInteger(step) || step <= 0) {
				return false;
			}
		}
		if (rangePart === '*') {
			continue;
		}
		if (rangePart.includes('-')) {
			const dashParts = rangePart.split('-');
			if (dashParts.length !== 2 || !/^\d+$/.test(dashParts[0]) || !/^\d+$/.test(dashParts[1])) {
				return false;
			}
			const a = Number.parseInt(dashParts[0], 10);
			const b = Number.parseInt(dashParts[1], 10);
			if (a < min || a > max || b < min || b > max) {
				return false;
			}
			if (!isDow && a > b) {
				return false;
			}
			continue;
		}
		if (!/^\d+$/.test(rangePart)) {
			return false;
		}
		const exact = Number.parseInt(rangePart, 10);
		if (exact < min || exact > max) {
			return false;
		}
	}
	return true;
}

/**
 * Validates syntax and numeric bounds of a standard 5-field cron expression (`min hour dom month dow`).
 */
export function validateCronExpression(expr: string | undefined): string | undefined {
	if (!expr || !expr.trim()) {
		return 'Cron trigger requires a standard 5-field cron expression (e.g. "*/15 * * * *").';
	}
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		return 'Cron trigger requires a standard 5-field cron expression (e.g. "*/15 * * * *").';
	}
	for (let i = 0; i < 5; i++) {
		const bound = CRON_FIELD_BOUNDS[i];
		if (!validateCronField(fields[i], bound.min, bound.max, bound.isDow)) {
			return `Invalid cron ${bound.name} field "${fields[i]}" in "${expr.trim()}". Expected values in ${bound.min}..${bound.max}.`;
		}
	}
	return undefined;
}

/**
 * Validates that a trigger is attached strictly to a source generator node (`inDegree === 0 && outDegree >= 1`).
 */
export function validateSourceTrigger(
	graph: Pick<IMissionDagParseResult, 'nodes' | 'edges'>,
	trigger: Pick<IMissionSourceTrigger, 'nodeId' | 'kind' | 'cronExpr' | 'intervalMs' | 'fireAt' | 'eventType'>,
): string | undefined {
	if (!graph.nodes.some(n => n.id === trigger.nodeId)) {
		return `Trigger node "${trigger.nodeId}" does not exist in Mission DAG.`;
	}
	const inCount = graph.edges.filter(e => e.to === trigger.nodeId).length;
	const outCount = graph.edges.filter(e => e.from === trigger.nodeId).length;
	if (inCount !== 0 || outCount < 1) {
		return `Source trigger node "${trigger.nodeId}" must have inDegree = 0 and outDegree >= 1 (actual: in=${inCount}, out=${outCount}).`;
	}
	if (trigger.kind === 'cron') {
		const cronErr = validateCronExpression(trigger.cronExpr);
		if (cronErr) {
			return cronErr;
		}
	} else if (trigger.kind === 'interval') {
		if (!trigger.intervalMs || trigger.intervalMs < 5000) {
			return 'Interval trigger requires intervalMs >= 5000 (5 seconds).';
		}
	} else if (trigger.kind === 'once') {
		if (!trigger.fireAt || !Number.isFinite(trigger.fireAt)) {
			return 'One-shot trigger requires a valid fireAt timestamp.';
		}
	} else if (trigger.kind === 'event') {
		if (!trigger.eventType) {
			return 'Event trigger requires eventType (file_created | file_changed | git_updated | gpu_idle).';
		}
	}
	return undefined;
}

/**
 * Fires a source node trigger, minting a brand-new `wave_id` token at that source node.
 */
export function fireMissionSourceTrigger(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	params: { readonly triggerId: string; readonly payloadSummary?: string; readonly now?: number },
): IMissionEngineTransitionResult<{ readonly waveId: string; readonly tokenId: string }> {
	if (state.status !== 'running') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Mission is "${state.status}", not running.` };
	}
	const idx = state.triggers.findIndex(t => t.id === params.triggerId && t.enabled);
	if (idx < 0) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Enabled trigger "${params.triggerId}" not found.` };
	}
	const trigger = state.triggers[idx];
	const hasLiveTokenOnSource = Object.values(state.tokens).some(t =>
		t.nodeId === trigger.nodeId && (t.status === 'active' || t.status === 'blocked' || t.status === 'queued' || t.status === 'waiting_gate' || t.status === 'waiting_join'),
	);
	if (hasLiveTokenOnSource) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_STATE',
			error: `Source node "${trigger.nodeId}" already holds a live in-flight token; skipping trigger "${trigger.id}".`,
		};
	}
	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	ctx.waveSeq += 1;
	const waveId = `wave-${ctx.waveSeq}`;
	ctx.waveRoots[waveId] = [trigger.nodeId];
	const summary = params.payloadSummary?.trim() || `Triggered (${trigger.kind}) on source node ${trigger.nodeId}`;

	const ptr = appendTrace(ctx, {
		parentPtrs: [],
		nodeId: trigger.nodeId,
		employeeId: ctx.boundary.nodeAssignments[trigger.nodeId]?.agentId,
		waveId,
		event: 'trigger',
		summary,
		timestamp: now,
	});
	const tok = materializeAndDispatchToken(state.missionId, ctx, graph, {
		targetNodeId: trigger.nodeId,
		waveId,
		lastSummary: summary,
		compressedHistory: '',
		tracePtr: ptr,
		now,
	});
	ctx.triggers[idx] = {
		...trigger,
		lastFiredAt: now,
		fireCount: trigger.fireCount + 1,
		enabled: trigger.kind === 'once' ? false : trigger.enabled,
	};
	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { waveId, tokenId: tok.id },
	};
}

/**
 * Lightweight zero-dependency 5-field cron matcher (`min hour dom month dow`).
 * Supports 1-based step origins (`dom`, `month`), `N/step` start-offset steps (e.g. `5/15`),
 * Sunday as `0` or `7`, wrap-around `dow` ranges (e.g. `5-1`), and standard `dom`/`dow` OR semantics.
 */
export function matchesCronExpression(expr: string, date: Date): boolean {
	if (validateCronExpression(expr)) {
		return false;
	}
	const fields = expr.trim().split(/\s+/);
	const values = [
		date.getMinutes(),
		date.getHours(),
		date.getDate(),
		date.getMonth() + 1,
		date.getDay(),
	];
	const matchField = (field: string, value: number, minVal: number, maxVal: number, isDow: boolean): boolean => {
		const normalizeVal = (n: number) => (isDow && n === 7 ? 0 : n);
		for (const part of field.split(',')) {
			const trimmed = part.trim();
			if (!trimmed) { continue; }
			const [rangePart, stepPart] = trimmed.split('/');
			const step = stepPart !== undefined ? Number.parseInt(stepPart, 10) : 1;
			if (!Number.isInteger(step) || step <= 0) { continue; }
			if (rangePart === '*') {
				if ((value - minVal) % step === 0) { return true; }
				continue;
			}
			if (rangePart.includes('-')) {
				const [aStr, bStr] = rangePart.split('-');
				const a = Number.parseInt(aStr, 10);
				const b = Number.parseInt(bStr, 10);
				if (Number.isInteger(a) && Number.isInteger(b)) {
					if (isDow && a > b) {
						const aNorm = normalizeVal(a);
						const bNorm = normalizeVal(b);
						if (aNorm > bNorm) {
							const offset = (value - aNorm + 7) % 7;
							const span = (bNorm - aNorm + 7) % 7;
							if (offset <= span && offset % step === 0) {
								return true;
							}
						} else if (value >= aNorm && value <= bNorm && (value - aNorm) % step === 0) {
							return true;
						}
						continue;
					}
					if (isDow && b === 7 && value === 0 && (7 - a) % step === 0) {
						return true;
					}
					if (value >= a && value <= b && (value - a) % step === 0) {
						return true;
					}
				}
				continue;
			}
			const exact = Number.parseInt(rangePart, 10);
			if (!Number.isInteger(exact)) {
				continue;
			}
			if (stepPart !== undefined) {
				if (isDow) {
					for (let cur = exact; cur <= maxVal; cur += step) {
						if (normalizeVal(cur) === value) {
							return true;
						}
					}
				} else if (value >= exact && value <= maxVal && (value - exact) % step === 0) {
					return true;
				}
				continue;
			}
			if (normalizeVal(exact) === value) {
				return true;
			}
		}
		return false;
	};
	const minMatch = matchField(fields[0], values[0], CRON_FIELD_BOUNDS[0].min, CRON_FIELD_BOUNDS[0].max, false);
	const hourMatch = matchField(fields[1], values[1], CRON_FIELD_BOUNDS[1].min, CRON_FIELD_BOUNDS[1].max, false);
	const monthMatch = matchField(fields[3], values[3], CRON_FIELD_BOUNDS[3].min, CRON_FIELD_BOUNDS[3].max, false);
	if (!minMatch || !hourMatch || !monthMatch) {
		return false;
	}
	const domRestricted = !fields[2].startsWith('*');
	const dowRestricted = !fields[4].startsWith('*');
	const domMatch = matchField(fields[2], values[2], CRON_FIELD_BOUNDS[2].min, CRON_FIELD_BOUNDS[2].max, false);
	const dowMatch = matchField(fields[4], values[4], CRON_FIELD_BOUNDS[4].min, CRON_FIELD_BOUNDS[4].max, true);
	if (domRestricted && dowRestricted) {
		return domMatch || dowMatch;
	}
	return domMatch && dowMatch;
}

