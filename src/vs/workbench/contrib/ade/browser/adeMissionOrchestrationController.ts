/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AEXUS_SSH_SCHEME } from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	IUnifiedMissionCheckpointBundle,
	parseUnifiedMissionCheckpointBundle,
	serializeUnifiedMissionCheckpointBundle,
} from '../../../../platform/ade/common/adeControlPolicy.js';
import {
	AdeThinkingLevel,
	IAdeMissionCheckpointMeta,
} from '../../../../platform/ade/common/adeEngineering.js';
import { IMissionNodeAssignment } from '../../../../platform/ade/common/adeMissionBoundary.js';
import {
	IMissionNodeCheckHook,
	IMissionNodeCheckSuiteResult,
	parseMissionMermaidDag,
} from '../../../../platform/ade/common/adeMissionDag.js';
import {
	computeMissionTotalCostUsd,
	createInitialMissionRuntimeState,
	IMissionRuntimeState,
	IMissionToken,
	IMissionTraceNode,
	parseDurationMs,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import {
	abortOrchestrationTokens,
	applyOrchestrationCheckpointRestore,
	blockOrchestrationToken,
	buildOrchestrationTokenDeltaView,
	canCallerAccessWhiteboard,
	compactOrchestrationRuntimeState,
	completeOrchestrationToken,
	computeMissionDiagnostics,
	computeOrchestrationCheckpointDiff,
	createInitialOrchestrationRuntimeState,
	createOrchestrationCheckpointSnapshot,
	dispatchRequirementToOrchestration,
	failOrchestrationToken,
	findHighestRankStaffNode,
	getOrchestrationTokenHistory,
	handoffOrchestrationToken,
	IDereferencedOrchestrationPointer,
	IMissionDiagnosticsReport,
	IMissionTaskCheckReceipt,
	IMissionTaskStatusRecord,
	IMissionTaskStatusTransitionResult,
	IOrchestrationArchiveEntry,
	IOrchestrationCheckpointDiff,
	IOrchestrationCheckpointRestoreResult,
	IOrchestrationCheckpointSummary,
	IOrchestrationContextBlobInput,
	IOrchestrationMintBranch,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationTokenDeltaView,
	IOrchestrationTransitionResult,
	IOrchestrationWhiteboard,
	IWhiteboardSliceOptions,
	MAX_HOT_ORCHESTRATION_CHECKPOINTS,
	mintOrchestrationTokens,
	MissionTaskStatus,
	mutateDepartmentWhiteboard,
	OrchestrationEngineEffect,
	OrchestrationReworkCategory,
	OrchestrationScopeConflictPolicy,
	pauseOrchestration,
	planDynamicSubordinateCreation,
	planDynamicSubordinateRemoval,
	planDynamicWhiteboardCreation,
	pruneRemovedWhiteboardFromState,
	readOrchestrationTokenPointers,
	reclaimOrchestrationTokensForRemovedNode,
	recordExternalizedPointersRead,
	recordMissionTaskCheckReceipt,
	rejectOrchestrationToken,
	resolveEffectiveStaffTier,
	resumeOrchestration,
	retryOrchestrationToken,
	returnOrchestrationToken,
	setOrchestrationGuardrails,
	sliceWhiteboardContent,
	summarizeOrchestrationCheckpoint,
	syncMissionTaskStatusesFromOrchestration,
	updateMissionTaskNodeStatus,
	upsertWhiteboardSection,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	IOrchestrationGraphParseResult,
	parseOrchestrationGraph,
	removeOrchestrationNode,
	upsertOrchestrationStaffMetaInCode,
	upsertOrchestrationWhiteboardInCode,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { normalizeAdeEngineId } from '../../../../platform/ade/common/adeRoleSchema.js';
import { ADE_SECRETARY_ID, IAdeAgent } from '../common/ade.js';
import { IAdeMissionRecord } from './adeMissionStore.js';
import type { IAdeMissionRuntimeHost } from './adeMissionRuntimeTypes.js';

export class AdeMissionOrchestrationController {
	constructor(
		private readonly host: IAdeMissionRuntimeHost,
	) { }

	setMissionTaskStatus(missionId: string, params: {
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
		readonly hasConfiguredChecks?: boolean;
		readonly checkReceipt?: IMissionTaskCheckReceipt;
		readonly artifactPtrs?: readonly string[];
		readonly touchedFiles?: readonly string[];
		readonly force?: boolean;
		readonly note?: string;
	}): IMissionTaskStatusTransitionResult {
		const rec = this.host.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const orchGraph = rec.orchestrationText?.trim() ? parseOrchestrationGraph(rec.orchestrationText) : undefined;
		const callerNodeId = params.caller.callerNodeId ?? this.resolveCallerOrchestrationNodeId(rec, params.caller.callerSessionId);
		const res = updateMissionTaskNodeStatus(rec.taskStatuses, graph, this.host.orgConfig, {
			...params,
			caller: {
				...params.caller,
				...(callerNodeId ? { callerNodeId } : {}),
			},
			...(orchGraph && !orchGraph.error ? { orchGraph } : {}),
			...(rec.whiteboards ? { whiteboards: rec.whiteboards } : {}),
		});
		if (res.ok) {
			this.host.missionService?.updateTaskStatuses(rec.id, res.taskStatuses as Readonly<Record<string, IMissionTaskStatusRecord>>);
			this.host.fireDidChange(rec.id);
		}
		return res;
	}

	recordTaskCheckReceipt(missionId: string, nodeId: string, receipt: IMissionTaskCheckReceipt): void {
		const rec = this.host.missionService?.getMission(missionId);
		if (!rec) {
			return;
		}
		const updated = recordMissionTaskCheckReceipt(rec.taskStatuses, nodeId, receipt);
		this.host.missionService?.updateTaskStatuses(rec.id, updated);
		this.host.fireDidChange(rec.id);
	}

	getMissionDiagnostics(missionId: string): IMissionDiagnosticsReport {
		const rec = this.host.requireMission(missionId);
		const taskGraph = rec.mermaidText?.trim() ? parseMissionMermaidDag(rec.mermaidText) : undefined;
		const orchGraph = rec.orchestrationText?.trim() ? parseOrchestrationGraph(rec.orchestrationText) : undefined;
		const orchState = this.ensureSynchronizedOrchestrationState(rec);
		const rtState = rec.runtime;
		const totalCostUsd = Math.max(orchState.totalCostUsd ?? 0, rtState ? computeMissionTotalCostUsd(rtState) : 0);
		return computeMissionDiagnostics({
			missionId: rec.id,
			...(taskGraph && !taskGraph.error ? { taskGraph } : {}),
			taskStatuses: rec.taskStatuses,
			...(orchGraph && !orchGraph.error ? { orchGraph } : {}),
			orchState,
			finOpsSummary: {
				totalCostUsd,
				...(orchState.finOpsTelemetry ? {
					totalTokens: orchState.finOpsTelemetry.totalInputTokens + orchState.finOpsTelemetry.totalOutputTokens + orchState.finOpsTelemetry.totalCacheReadTokens + orchState.finOpsTelemetry.totalCacheWriteTokens,
					cacheHitRatePct: orchState.finOpsTelemetry.cacheHitRatePct,
					reworkTokens: orchState.finOpsTelemetry.reworkTokens,
				} : {}),
			},
		});
	}

	async createMissionCheckpoint(missionId: string, options?: {
		readonly label?: string;
		readonly reason?: string;
		readonly createdBy?: string;
	}): Promise<IAdeMissionCheckpointMeta & { readonly summary?: IOrchestrationCheckpointSummary }> {
		const rec = this.host.requireMission(missionId);
		const orchState = this.ensureSynchronizedOrchestrationState(rec);
		const snapshot = createOrchestrationCheckpointSnapshot(orchState, {
			label: options?.label,
			reason: options?.reason,
			createdBy: options?.createdBy,
			taskStatuses: rec.taskStatuses,
			whiteboards: rec.whiteboards,
		});
		const summary = summarizeOrchestrationCheckpoint(snapshot);
		const completedTaskCount = summary.completedTasks
			?? Object.values(rec.taskStatuses ?? {}).filter(t => t.status === 'completed').length;
		const totalCostUsd = Math.max(orchState.totalCostUsd ?? 0, rec.runtime ? computeMissionTotalCostUsd(rec.runtime) : 0);
		const meta: IAdeMissionCheckpointMeta = {
			id: snapshot.id,
			missionId: rec.id,
			...(snapshot.label ? { label: snapshot.label } : {}),
			...(snapshot.reason ? { reason: snapshot.reason } : {}),
			...(options?.createdBy ? { createdBy: options.createdBy } : {}),
			stateRevision: snapshot.stateRevision,
			createdAt: snapshot.createdAt,
			activeTokenCount: summary.activeTokens,
			completedTaskCount,
			totalCostUsd,
		};
		const snapshotJson = serializeUnifiedMissionCheckpointBundle({
			meta,
			checkpointSnapshot: snapshot,
			mermaidText: rec.mermaidText ?? '',
			orchestrationText: rec.orchestrationText ?? '',
			nodePrompts: rec.nodePrompts ?? {},
			nodeChecks: rec.nodeChecks ?? {},
			whiteboards: rec.whiteboards,
			taskStatuses: rec.taskStatuses,
		});
		if (this.host.backendService?.saveMissionCheckpoint) {
			await this.host.backendService.saveMissionCheckpoint(rec.id, meta.id, snapshotJson, meta);
		}
		const memList = this.host.memoryCheckpointsByMission.get(rec.id) ?? [];
		const nextMem = [...memList.filter(e => e.meta.id !== meta.id), { meta, snapshotJson }].slice(-MAX_HOT_ORCHESTRATION_CHECKPOINTS);
		this.host.memoryCheckpointsByMission.set(rec.id, nextMem);
		return { ...meta, summary };
	}

	async listMissionCheckpoints(missionId: string): Promise<readonly IAdeMissionCheckpointMeta[]> {
		const rec = this.host.requireMission(missionId);
		if (this.host.backendService?.listMissionCheckpoints) {
			try {
				return await this.host.backendService.listMissionCheckpoints(rec.id);
			} catch {
				// Fallback to in-memory checkpoints only if backend IPC fails
			}
		}
		const mem = this.host.memoryCheckpointsByMission.get(rec.id) ?? [];
		return [...mem].map(e => e.meta).sort((a, b) => b.createdAt - a.createdAt || b.stateRevision - a.stateRevision);
	}

	private async loadCheckpointBundle(missionId: string, checkpointId: string): Promise<IUnifiedMissionCheckpointBundle | undefined> {
		let raw: string | undefined;
		if (this.host.backendService?.loadMissionCheckpoint) {
			raw = await this.host.backendService.loadMissionCheckpoint(missionId, checkpointId).catch(() => undefined);
		}
		if (!raw) {
			raw = this.host.memoryCheckpointsByMission.get(missionId)?.find(e => e.meta.id === checkpointId)?.snapshotJson;
		}
		if (!raw) {
			return undefined;
		}
		return parseUnifiedMissionCheckpointBundle(raw);
	}

	async diffMissionCheckpoint(missionId: string, fromCheckpointId: string, toCheckpointId?: string): Promise<IOrchestrationCheckpointDiff> {
		const rec = this.host.requireMission(missionId);
		const fromBundle = await this.loadCheckpointBundle(rec.id, fromCheckpointId);
		if (!fromBundle) {
			throw new Error(`Checkpoint "${fromCheckpointId}" not found for Mission "${rec.id}".`);
		}
		if (toCheckpointId) {
			const toBundle = await this.loadCheckpointBundle(rec.id, toCheckpointId);
			if (!toBundle) {
				throw new Error(`Target checkpoint "${toCheckpointId}" not found for Mission "${rec.id}".`);
			}
			return computeOrchestrationCheckpointDiff(fromBundle.checkpointSnapshot, toBundle.checkpointSnapshot);
		}
		const orchState = this.ensureSynchronizedOrchestrationState(rec);
		return computeOrchestrationCheckpointDiff(fromBundle.checkpointSnapshot, {
			id: 'live',
			orchState,
			taskStatuses: rec.taskStatuses,
			whiteboards: rec.whiteboards,
		});
	}

	async restoreMissionCheckpoint(missionId: string, checkpointId: string, options?: {
		readonly mode?: 'full' | 'tokens_only';
		readonly restoredBy?: string;
	}): Promise<IOrchestrationCheckpointRestoreResult & { readonly preRestoreCheckpointId?: string }> {
		const rec = this.host.requireMission(missionId);
		const targetBundle = await this.loadCheckpointBundle(rec.id, checkpointId);
		if (!targetBundle) {
			throw new Error(`Checkpoint "${checkpointId}" not found for Mission "${rec.id}".`);
		}
		const currentState = this.ensureSynchronizedOrchestrationState(rec);
		const mode = options?.mode ?? 'full';
		const restored = applyOrchestrationCheckpointRestore(currentState, targetBundle.checkpointSnapshot, {
			mode,
			currentTaskStatuses: rec.taskStatuses,
			currentWhiteboards: rec.whiteboards,
			restoredBy: options?.restoredBy,
		});
		if (!restored.ok) {
			throw new Error(restored.error ?? `Failed to restore checkpoint "${checkpointId}".`);
		}
		const preRestore = await this.createMissionCheckpoint(rec.id, {
			reason: `pre_restore:${checkpointId}`,
			createdBy: options?.restoredBy,
		}).catch(() => undefined);

		const freshRec = this.host.requireMission(rec.id);
		if (mode === 'full') {
			if (targetBundle.mermaidText !== undefined && targetBundle.mermaidText !== (freshRec.mermaidText ?? '')) {
				this.host.missionService?.updateMermaid(freshRec.id, targetBundle.mermaidText);
			}
			if (targetBundle.orchestrationText !== undefined && targetBundle.orchestrationText !== (freshRec.orchestrationText ?? '')) {
				this.host.missionService?.updateOrchestrationText(freshRec.id, targetBundle.orchestrationText);
			}
			if (targetBundle.nodePrompts !== undefined) {
				this.host.missionService?.replaceNodePrompts?.(freshRec.id, targetBundle.nodePrompts);
			}
			if (targetBundle.nodeChecks !== undefined) {
				this.host.missionService?.replaceAllNodeChecks?.(freshRec.id, targetBundle.nodeChecks);
			}
			if (restored.whiteboards) {
				this.host.missionService?.updateWhiteboards(freshRec.id, restored.whiteboards);
			}
			if (restored.taskStatuses) {
				this.host.missionService?.updateTaskStatuses(freshRec.id, restored.taskStatuses, { deferPersist: true, silent: true });
			}
		}
		this.commitOrchestrationState(freshRec.id, restored.state);
		return {
			...restored,
			...(preRestore ? { preRestoreCheckpointId: preRestore.id } : {}),
		};
	}

	ensureSynchronizedOrchestrationState(rec: IAdeMissionRecord): IOrchestrationRuntimeState {
		const parsed = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const staffNodes = parsed.nodes.filter(n => n.kind === 'staff');
		const base = rec.orchestrationRuntime ?? createInitialOrchestrationRuntimeState(rec.id, staffNodes.map(n => n.id));
		const generatedEmployees = this.host.missionService?.getGeneratedEmployees(rec.id) ?? [];
		const byNodeId = new Map<string, IAdeAgent>();
		for (const emp of generatedEmployees) {
			if (emp.treeNodeId) {
				byNodeId.set(emp.treeNodeId, emp);
			}
			for (const nid of emp.treeNodeIds ?? []) {
				byNodeId.set(nid, emp);
			}
		}

		const ownerAgent = rec.ownerSessionId && rec.ownerSessionId !== ADE_SECRETARY_ID
			? this.host.projectsService?.getAgent(rec.ownerSessionId)
			: undefined;
		const rootStaffNode = ownerAgent && !parsed.error ? findHighestRankStaffNode(parsed) : undefined;
		const nextNodeAgentIds: Record<string, string> = { ...base.nodeAgentIds };
		const nextNodeStates: Record<string, IOrchestrationRuntimeState['nodeStates'][string]> = { ...base.nodeStates };
		let changed = !rec.orchestrationRuntime;
		if (!parsed.error) {
			const liveStaffIds = new Set(staffNodes.map(n => n.id));
			for (const staleKey of Object.keys(nextNodeAgentIds)) {
				if (!liveStaffIds.has(staleKey)) {
					delete nextNodeAgentIds[staleKey];
					changed = true;
				}
			}
			for (const staleKey of Object.keys(nextNodeStates)) {
				if (!liveStaffIds.has(staleKey)) {
					delete nextNodeStates[staleKey];
					changed = true;
				}
			}
			for (const node of staffNodes) {
				const matched = (rootStaffNode && node.id === rootStaffNode.id ? ownerAgent : undefined) ?? byNodeId.get(node.id);
				const resolvedAgentId = matched?.id ?? node.agentId ?? nextNodeAgentIds[node.id];
				if (resolvedAgentId && nextNodeAgentIds[node.id] !== resolvedAgentId) {
					nextNodeAgentIds[node.id] = resolvedAgentId;
					changed = true;
				}
				if (!Object.hasOwn(nextNodeStates, node.id)) {
					nextNodeStates[node.id] = 'idle';
					changed = true;
				}
			}
		}

		const nextTokens: Record<string, IOrchestrationToken> = { ...base.tokens };
		for (const [tid, tok] of Object.entries(base.tokens)) {
			if (tok.status === 'active' || tok.status === 'blocked') {
				const liveAgent = nextNodeAgentIds[tok.nodeId];
				if (liveAgent && tok.holderAgentId !== liveAgent) {
					nextTokens[tid] = { ...tok, holderAgentId: liveAgent };
					changed = true;
				}
			}
		}

		if (!changed) {
			return base;
		}
		return {
			...base,
			nodeAgentIds: nextNodeAgentIds,
			nodeStates: nextNodeStates,
			tokens: nextTokens,
		};
	}

	commitOrchestrationState(missionId: string, state: IOrchestrationRuntimeState): void {
		const prevRec = this.host.missionService?.getMission(missionId);
		const prevOrch = prevRec?.orchestrationRuntime;
		let syncedTaskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined;
		if (prevRec && prevRec.mermaidText?.trim()) {
			const taskGraph = parseMissionMermaidDag(prevRec.mermaidText);
			if (!taskGraph.error && taskGraph.nodes.length > 0) {
				const orchGraph = prevRec.orchestrationText?.trim() ? parseOrchestrationGraph(prevRec.orchestrationText) : undefined;
				const synced = syncMissionTaskStatusesFromOrchestration(prevRec.taskStatuses, taskGraph, state, orchGraph);
				if (synced.changed) {
					syncedTaskStatuses = synced.taskStatuses;
				}
			}
		}
		if (syncedTaskStatuses) {
			this.host.missionService?.updateOrchestrationRuntime(missionId, state, { deferPersist: true, silent: true });
			this.host.missionService?.updateTaskStatuses(missionId, syncedTaskStatuses);
		} else {
			this.host.missionService?.updateOrchestrationRuntime(missionId, state);
		}
		this.host.flushPendingDispatchesForReleasedOrchAgents(prevOrch, state);
		const freshRec = this.host.missionService?.getMission(missionId);
		this.host.syncWatchdog(missionId, freshRec?.runtime ?? createInitialMissionRuntimeState(missionId, this.host.orgConfig));
		if (this.host.backendService?.syncOrchestrationDaemonState) {
			const tokens = Object.values(state.tokens);
			void this.host.backendService.syncOrchestrationDaemonState({
				missionId,
				status: state.status ?? 'running',
				activeTokenCount: tokens.filter(t => t.status === 'active').length,
				blockedTokenCount: tokens.filter(t => t.status === 'blocked').length,
				waitingJoinCount: tokens.filter(t => t.status === 'waiting_join').length,
				updatedAt: state.updatedAt,
				...(state.pausedReason ? { pausedReason: state.pausedReason } : {}),
			}).catch(() => undefined);
		}
		this.scheduleOrchestrationCompactionIfNeeded(missionId, state);
		this.host.fireDidChange(missionId);
	}

	private scheduleOrchestrationCompactionIfNeeded(missionId: string, state: IOrchestrationRuntimeState): void {
		const backend = this.host.backendService;
		if (!backend?.saveOrchestrationBlobs || !backend?.appendOrchestrationArchive) {
			return;
		}
		const hasCompactableBlob = Object.values(state.payloadStore ?? {}).some(b => b.sizeChars >= 256);
		const terminalTokenCount = Object.values(state.tokens).filter(t => t.status !== 'active' && t.status !== 'blocked' && t.status !== 'waiting_join').length;
		const traceCount = Object.keys(state.traces).length;
		if (!hasCompactableBlob && terminalTokenCount <= 80 && traceCount <= 200) {
			return;
		}
		const prev = this.host.compactionChains.get(missionId) ?? Promise.resolve();
		const run = prev.then(async () => {
			if (this.host.isDisposed) {
				return;
			}
			const liveRec = this.host.missionService?.getMission(missionId);
			const liveOrch = liveRec?.orchestrationRuntime;
			if (!liveOrch) {
				return;
			}
			const compacted = compactOrchestrationRuntimeState(liveOrch);
			if (!compacted.didCompact) {
				return;
			}
			const persistedBlobPtrs = new Set<string>();
			if (compacted.blobsToExternalize.length > 0) {
				try {
					await backend.saveOrchestrationBlobs!(
						missionId,
						compacted.blobsToExternalize.map(blob => ({ ptr: blob.ptr, payloadJson: JSON.stringify(blob) })),
					);
					for (const blob of compacted.blobsToExternalize) {
						persistedBlobPtrs.add(blob.ptr);
					}
				} catch {
					// Keep blobs in hot store if cold write fails so zero data is ever lost
				}
			}
			let archivePersisted = compacted.archiveEntries.length === 0;
			if (compacted.archiveEntries.length > 0) {
				try {
					const lines = compacted.archiveEntries.map(entry => JSON.stringify(entry));
					await backend.appendOrchestrationArchive!(missionId, lines);
					archivePersisted = true;
				} catch {
					archivePersisted = false;
				}
			}
			if (this.host.isDisposed || (persistedBlobPtrs.size === 0 && !archivePersisted)) {
				return;
			}
			const freshest = this.host.missionService?.getMission(missionId)?.orchestrationRuntime;
			if (!freshest) {
				return;
			}
			const archivedTokIds = new Set(
				archivePersisted
					? compacted.archiveEntries.filter((e): e is Extract<IOrchestrationArchiveEntry, { readonly kind: 'token' }> => e.kind === 'token').map(e => e.token.id)
					: [],
			);
			const archivedTracePtrs = new Set(
				archivePersisted
					? compacted.archiveEntries.filter((e): e is Extract<IOrchestrationArchiveEntry, { readonly kind: 'trace' }> => e.kind === 'trace').map(e => e.trace.ptr)
					: [],
			);
			const nextPayloadStore: Record<string, typeof freshest.payloadStore extends Readonly<Record<string, infer V>> | undefined ? V : never> = {};
			const nextExtIndex = { ...(freshest.externalizedBlobIndex ?? {}) };
			let prunedBlobs = 0;
			for (const [ptr, blob] of Object.entries(freshest.payloadStore ?? {})) {
				if (persistedBlobPtrs.has(ptr)) {
					nextExtIndex[ptr] = compacted.compactedState.externalizedBlobIndex?.[ptr] ?? {
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
					prunedBlobs++;
				} else {
					nextPayloadStore[ptr] = blob;
				}
			}
			const nextTokens: Record<string, IOrchestrationToken> = {};
			let prunedTokens = 0;
			for (const [tid, tok] of Object.entries(freshest.tokens)) {
				if (archivedTokIds.has(tid) && tok.status !== 'active' && tok.status !== 'blocked' && tok.status !== 'waiting_join') {
					prunedTokens++;
				} else {
					nextTokens[tid] = tok;
				}
			}
			const nextTraces: Record<string, IMissionTraceNode> = {};
			let prunedTraces = 0;
			for (const [ptr, tr] of Object.entries(freshest.traces)) {
				if (archivedTracePtrs.has(ptr)) {
					prunedTraces++;
				} else {
					nextTraces[ptr] = tr;
				}
			}
			if (prunedBlobs === 0 && prunedTokens === 0 && prunedTraces === 0) {
				return;
			}
			this.host.missionService?.updateOrchestrationRuntime(missionId, {
				...freshest,
				tokens: nextTokens,
				traces: nextTraces,
				payloadStore: nextPayloadStore,
				externalizedBlobIndex: nextExtIndex,
				archivedTokenCount: (freshest.archivedTokenCount ?? 0) + prunedTokens,
				archivedTraceCount: (freshest.archivedTraceCount ?? 0) + prunedTraces,
			}, { deferPersist: true });
		}).catch(() => undefined);
		this.host.compactionChains.set(missionId, run);
	}

	getOrchestrationState(missionId: string): IOrchestrationRuntimeState {
		const rec = this.host.requireMission(missionId);
		return this.ensureSynchronizedOrchestrationState(rec);
	}

	getCurrentOrchestrationTokens(agentId: string, missionId?: string): readonly IOrchestrationToken[] {
		const missions = missionId
			? [this.host.missionService?.getMission(missionId) ?? this.host.missionService?.getMissionByLinkedSession(missionId)].filter((m): m is IAdeMissionRecord => Boolean(m))
			: (this.host.missionService?.listMissions() ?? []);
		const out: IOrchestrationToken[] = [];
		for (const rec of missions) {
			if (!rec.orchestrationRuntime || Object.keys(rec.orchestrationRuntime.tokens).length === 0) {
				continue;
			}
			const orch = this.ensureSynchronizedOrchestrationState(rec);
			for (const tok of Object.values(orch.tokens)) {
				const assigned = orch.nodeAgentIds[tok.nodeId];
				if ((tok.holderAgentId === agentId || assigned === agentId) && (tok.status === 'active' || tok.status === 'blocked' || tok.status === 'waiting_join')) {
					out.push(tok);
				}
			}
		}
		return out;
	}

	getOrchestrationTokenDelta(missionId: string, tokenId: string): IOrchestrationTokenDeltaView | undefined {
		const rec = this.host.requireMission(missionId);
		const orch = this.ensureSynchronizedOrchestrationState(rec);
		const tok = orch.tokens[tokenId];
		if (!tok) {
			return undefined;
		}
		return buildOrchestrationTokenDeltaView(orch, tok, rec.whiteboards);
	}

	getOrchestrationTokenHistory(missionId: string, tokenId: string, options?: { readonly includeAll?: boolean }): ReturnType<typeof getOrchestrationTokenHistory> {
		const rec = this.host.requireMission(missionId);
		const orch = this.ensureSynchronizedOrchestrationState(rec);
		return getOrchestrationTokenHistory(orch, tokenId, rec.whiteboards, options);
	}

	async getOrchestrationTokenHistoryAsync(missionId: string, tokenId: string, options?: { readonly includeAll?: boolean }): Promise<ReturnType<typeof getOrchestrationTokenHistory> & { readonly archived?: boolean }> {
		const hot = this.getOrchestrationTokenHistory(missionId, tokenId, options);
		if (hot.ok || !this.host.backendService?.readOrchestrationArchive) {
			return hot;
		}
		const rec = this.host.requireMission(missionId);
		const lines = await this.host.backendService.readOrchestrationArchive(rec.id).catch(() => []);
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const parsed = JSON.parse(lines[i]) as IOrchestrationArchiveEntry;
				if (parsed.kind === 'token' && parsed.token?.id === tokenId) {
					const orch = this.ensureSynchronizedOrchestrationState(rec);
					const syntheticState: IOrchestrationRuntimeState = {
						...orch,
						tokens: { ...orch.tokens, [parsed.token.id]: parsed.token },
					};
					return {
						...getOrchestrationTokenHistory(syntheticState, tokenId, rec.whiteboards, options),
						archived: true,
					};
				}
			} catch {
				// Skip malformed archive line
			}
		}
		return hot;
	}

	readOrchestrationTokenPointers(missionId: string, params: {
		readonly ptrs: readonly string[];
		readonly tokenId?: string;
		readonly slice?: IWhiteboardSliceOptions;
		readonly caller?: {
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerAgentId?: string;
		};
	}): { readonly items: readonly IDereferencedOrchestrationPointer[] } {
		const rec = this.host.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const orch = this.ensureSynchronizedOrchestrationState(rec);
		const callerNodeId = this.resolveCallerOrchestrationNodeId(rec, params.caller?.callerAgentId);
		const token = params.tokenId ? orch.tokens[params.tokenId] : undefined;
		const isExternalObserver = Boolean(params.caller?.isHumanUser || params.caller?.isSecretary);
		const readerNodeId = isExternalObserver ? undefined : (callerNodeId ?? token?.nodeId);
		const waveId = token?.waveId ?? (readerNodeId
			? Object.values(orch.tokens).find(t => t.nodeId === readerNodeId && (t.status === 'active' || t.status === 'blocked'))?.waveId
			: undefined);
		const res = readOrchestrationTokenPointers(orch, rec.whiteboards, graph, this.host.orgConfig, {
			ptrs: params.ptrs,
			readerNodeId,
			waveId,
			...(params.slice ? { slice: params.slice } : {}),
			caller: params.caller
				? {
					isHumanUser: params.caller.isHumanUser,
					isSecretary: params.caller.isSecretary,
					callerTier: params.caller.callerTier,
					callerNodeId,
				}
				: undefined,
		});
		if (res.state !== orch) {
			this.commitOrchestrationState(rec.id, res.state);
		}
		return { items: res.items };
	}

	async readOrchestrationTokenPointersAsync(missionId: string, params: {
		readonly ptrs: readonly string[];
		readonly tokenId?: string;
		readonly slice?: IWhiteboardSliceOptions;
		readonly caller?: {
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerAgentId?: string;
		};
	}): Promise<{ readonly items: readonly IDereferencedOrchestrationPointer[] }> {
		const base = this.readOrchestrationTokenPointers(missionId, params);
		const backend = this.host.backendService;
		if (!backend?.readOrchestrationBlob || !base.items.some(i => i.externalized)) {
			return base;
		}
		const rec = this.host.requireMission(missionId);
		const hydrated: IDereferencedOrchestrationPointer[] = [];
		const fullHydratedPtrs: string[] = [];
		for (const item of base.items) {
			if (!item.externalized) {
				hydrated.push(item);
				continue;
			}
			const rawJson = await backend.readOrchestrationBlob(rec.id, item.ptr).catch(() => undefined);
			if (!rawJson) {
				hydrated.push(item);
				continue;
			}
			try {
				const parsed = JSON.parse(rawJson) as { content?: string; title?: string; kind?: IDereferencedOrchestrationPointer['kind']; authorNodeId?: string; hop?: number; sizeChars?: number };
				const rawContent = typeof parsed.content === 'string' ? parsed.content : '';
				const sliced = params.slice ? sliceWhiteboardContent(rawContent, params.slice) : undefined;
				if (!sliced?.isPartialSlice) {
					fullHydratedPtrs.push(item.ptr);
				}
				hydrated.push({
					ptr: item.ptr,
					ok: true,
					kind: parsed.kind ?? item.kind,
					title: parsed.title ?? item.title,
					version: 1,
					authorNodeId: parsed.authorNodeId ?? item.authorNodeId,
					hop: parsed.hop ?? item.hop,
					sizeChars: parsed.sizeChars ?? rawContent.length,
					content: sliced ? sliced.content : rawContent,
					...(sliced ? {
						truncated: sliced.truncated,
						lineCount: sliced.lineCount,
						offset: sliced.offset,
						...(sliced.nextOffset !== undefined ? { nextOffset: sliced.nextOffset } : {}),
						...(sliced.matchedSection ? { matchedSection: sliced.matchedSection } : {}),
						...(sliced.headings.length > 0 ? { headings: sliced.headings } : {}),
						...(sliced.availableSections ? { availableSections: sliced.availableSections } : {}),
						isPartialSlice: sliced.isPartialSlice,
					} : {}),
				});
			} catch {
				hydrated.push(item);
			}
		}
		if (fullHydratedPtrs.length > 0) {
			const freshRec = this.host.requireMission(rec.id);
			const freshOrch = this.ensureSynchronizedOrchestrationState(freshRec);
			const callerNodeId = this.resolveCallerOrchestrationNodeId(freshRec, params.caller?.callerAgentId);
			const token = params.tokenId ? freshOrch.tokens[params.tokenId] : undefined;
			const isExternalObserver = Boolean(params.caller?.isHumanUser || params.caller?.isSecretary);
			const readerNodeId = isExternalObserver ? undefined : (callerNodeId ?? token?.nodeId);
			const waveId = token?.waveId ?? (readerNodeId
				? Object.values(freshOrch.tokens).find(t => t.nodeId === readerNodeId && (t.status === 'active' || t.status === 'blocked'))?.waveId
				: undefined);
			if (readerNodeId && waveId) {
				const cursorUpdated = recordExternalizedPointersRead(freshOrch, {
					ptrs: fullHydratedPtrs,
					readerNodeId,
					waveId,
				});
				if (cursorUpdated !== freshOrch) {
					this.commitOrchestrationState(freshRec.id, cursorUpdated);
				}
			}
		}
		return { items: hydrated };
	}

	private async runOrchestrationStaffChecksIfNeeded(
		rec: IAdeMissionRecord,
		nodeId: string,
		options?: {
			readonly skipChecks?: boolean;
			readonly tokenId?: string;
			readonly holderAgentId?: string;
			readonly extraTaskNodeIds?: readonly string[];
		},
	): Promise<{ readonly passed: boolean; readonly error?: string; readonly receiptsByNodeId?: Readonly<Record<string, IMissionTaskCheckReceipt>> }> {
		if (options?.skipChecks) {
			return { passed: true };
		}
		const targetNodes = [...new Set([
			nodeId,
			...(options?.extraTaskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
		])];
		const parsedDag = parseMissionMermaidDag(rec.mermaidText);
		const dagTaskIds = new Set(parsedDag.nodes.filter(n => n.kind === 'task').map(n => n.id));
		const nodesWithChecks: string[] = [];
		for (const nid of targetNodes) {
			const hooks = this.host.computeEffectiveNodeChecks(rec, parsedDag, nid)[nid] ?? [];
			if (hooks.some(h => h.enabled !== false)) {
				nodesWithChecks.push(nid);
			}
		}
		if (nodesWithChecks.length === 0) {
			return { passed: true };
		}
		const lockKey = `orch-check:${rec.id}:${options?.tokenId ?? nodeId}`;
		if (this.host.inFlightCheckTokens.has(lockKey)) {
			return { passed: false, error: `Automated verification checks for "${nodeId}" are already running; wait for completion.` };
		}
		this.host.inFlightCheckTokens.add(lockKey);
		if (options?.holderAgentId) {
			this.host.touchAgentActivity(options.holderAgentId, Date.now());
		}
		const failedSuites: { readonly nid: string; readonly suite: IMissionNodeCheckSuiteResult }[] = [];
		const receiptsByNodeId: Record<string, IMissionTaskCheckReceipt> = {};
		try {
			const ranCheckIds = new Set<string>();
			for (const nid of nodesWithChecks) {
				const hooks = (this.host.computeEffectiveNodeChecks(rec, parsedDag, nid)[nid] ?? []).filter(h => h.enabled !== false && !ranCheckIds.has(h.id));
				if (hooks.length === 0) {
					continue;
				}
				for (const h of hooks) {
					ranCheckIds.add(h.id);
				}
				const suite = await this.host.runNodeChecks(rec.id, nid, { checkIds: hooks.map(h => h.id) });
				const receipt: IMissionTaskCheckReceipt = {
					checkedAt: Date.now(),
					passed: suite.passed,
					checkCount: suite.results.length,
					summary: suite.summary,
					...(options?.tokenId ? { tokenId: options.tokenId } : {}),
					byNodeId: nodeId,
				};
				receiptsByNodeId[nid] = receipt;
				if (dagTaskIds.has(nid)) {
					this.recordTaskCheckReceipt(rec.id, nid, receipt);
				}
				if (!suite.passed) {
					failedSuites.push({ nid, suite });
				}
			}
		} finally {
			this.host.inFlightCheckTokens.delete(lockKey);
			if (options?.holderAgentId) {
				this.host.touchAgentActivity(options.holderAgentId, Date.now());
			}
		}
		if (failedSuites.length === 0) {
			return { passed: true, receiptsByNodeId };
		}
		const failLines = failedSuites.flatMap(({ nid, suite }) =>
			suite.results
				.filter(r => !r.passed)
				.map(r => `[${nid}/${r.name || r.checkId}] ${r.error || `exit=${r.exitCode}`}${r.outputTail ? `\n${r.outputTail.slice(-600)}` : ''}`),
		).join('\n');
		return {
			passed: false,
			receiptsByNodeId,
			error: `AUTOMATED_CHECK_FAILED on "${nodesWithChecks.join(', ')}": ${failedSuites.map(f => f.suite.summary).join(' | ')}\n${failLines}`,
		};
	}

	async dispatchOrchestrationRequirement(missionId: string, params: {
		readonly prompt: string;
		readonly detail?: string;
		readonly targetNodeId?: string;
		readonly taskNodeId?: string;
		readonly taskNodeIds?: readonly string[];
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
		readonly refPtrs?: readonly string[];
	}): Promise<IOrchestrationTransitionResult<{ readonly tokenId: string; readonly targetNodeId: string; readonly payloadPtr?: string }>> {
		this.host.missionService?.ensureOrchestrationStaffSynced?.(missionId);
		const rec = this.host.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const taskGraph = rec.mermaidText?.trim() ? parseMissionMermaidDag(rec.mermaidText) : undefined;
		const res = dispatchRequirementToOrchestration(state, graph, rec.whiteboards, this.host.orgConfig, {
			...params,
			...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses: rec.taskStatuses } : {}),
		});
		if (res.ok) {
			this.commitOrchestrationState(rec.id, res.state);
			await this.host.executeOrchestrationEffects(rec, res.effects);
		}
		return res;
	}

	async mintOrchestrationTokens(missionId: string, params: {
		readonly parentTokenId?: string;
		readonly fromNodeId?: string;
		readonly waveSummary?: string;
		readonly branches: readonly IOrchestrationMintBranch[];
		readonly waitJoin?: boolean;
		readonly joinMode?: 'all' | 'any' | 'quorum';
		readonly quorumCount?: number;
		readonly failFast?: boolean;
		readonly deadlineAt?: number;
		readonly conflictPolicy?: OrchestrationScopeConflictPolicy;
		readonly callerAgentId?: string;
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
	}): Promise<IOrchestrationTransitionResult<{
		readonly parentTokenId: string;
		readonly mintedTokenIds: readonly string[];
		readonly joinBarrierId?: string;
		readonly createdRootParent?: boolean;
		readonly reusedActiveRootParent?: boolean;
		readonly branches: readonly { readonly tokenId: string; readonly toNodeId: string; readonly taskNodeId?: string; readonly payloadPtr?: string }[];
	}>> {
		this.host.missionService?.ensureOrchestrationStaffSynced?.(missionId);
		const rec = this.host.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const taskGraph = rec.mermaidText?.trim() ? parseMissionMermaidDag(rec.mermaidText) : undefined;
		const res = mintOrchestrationTokens(state, graph, rec.whiteboards, this.host.orgConfig, {
			...params,
			...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses: rec.taskStatuses } : {}),
		});
		if (res.ok || res.code === 'MAX_HOPS_EXCEEDED') {
			this.commitOrchestrationState(rec.id, res.state);
			await this.host.executeOrchestrationEffects(rec, res.effects);
		}
		return res;
	}

	private validateAndComputeCompleteTasksForToken(
		rec: IAdeMissionRecord,
		orchGraph: IOrchestrationGraphParseResult,
		tok: IOrchestrationToken | undefined,
		params: {
			readonly taskNodeId?: string;
			readonly taskNodeIds?: readonly string[];
			readonly completeTask?: boolean;
			readonly force?: boolean;
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerAgentId?: string;
			readonly callerLabel?: string;
			readonly summary?: string;
			readonly modifiedFiles?: readonly string[];
			readonly artifacts?: readonly IOrchestrationContextBlobInput[];
			readonly decisions?: readonly IOrchestrationContextBlobInput[];
			readonly refPtrs?: readonly string[];
			readonly receiptsByNodeId?: Readonly<Record<string, IMissionTaskCheckReceipt>>;
		},
	): { readonly ok: true; readonly nextTaskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>; readonly completedTaskIds: readonly string[] } | { readonly ok: false; readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_STATE' | 'INCOMPLETE_DEPENDENCIES'; readonly error: string } {
		if (!params.completeTask) {
			return { ok: true, completedTaskIds: [] };
		}
		const targetTaskIds = [...new Set([
			...(params.taskNodeId?.trim() ? [params.taskNodeId.trim()] : []),
			...(params.taskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
			...(tok?.taskNodeId?.trim() ? [tok.taskNodeId.trim()] : []),
			...(tok?.taskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
		])];
		if (targetTaskIds.length === 0) {
			return { ok: true, completedTaskIds: [] };
		}
		const taskGraph = rec.mermaidText?.trim() ? parseMissionMermaidDag(rec.mermaidText) : undefined;
		if (!taskGraph || taskGraph.error || taskGraph.nodes.length === 0) {
			return { ok: false, code: 'NOT_FOUND', error: `Cannot complete bound task(s) (${targetTaskIds.join(', ')}): Mission Task DAG is missing or invalid.` };
		}
		let workingStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> = rec.taskStatuses ?? {};
		const completedTaskIds: string[] = [];
		const callerNodeId = tok?.nodeId ?? this.resolveCallerOrchestrationNodeId(rec, params.callerAgentId);
		const callerStaff = callerNodeId ? orchGraph.nodes.find(n => n.id === callerNodeId && n.kind === 'staff') : undefined;
		const effectiveCallerTier = params.callerTier ?? (callerStaff ? resolveEffectiveStaffTier(callerStaff, this.host.orgConfig) : undefined);
		const artifactPtrs = [
			...(tok?.contextRefs ?? []).filter(r => r.kind === 'artifact' || r.kind === 'decision').map(r => r.ptr),
			...(params.artifacts ?? []).map((a, i) => `inline:art-${i}:${a.title || 'artifact'}`),
			...(params.decisions ?? []).map((d, i) => `inline:dec-${i}:${d.title || 'decision'}`),
			...(params.refPtrs ?? []).filter(p => /^(?:art|dec)-/i.test(p)),
		];
		for (const tid of targetTaskIds) {
			if (workingStatuses[tid]?.status === 'completed') {
				continue;
			}
			const enabledChecks = (this.host.computeEffectiveNodeChecks(rec, taskGraph, tid)[tid] ?? []).filter(h => h.enabled !== false);
			const checkReceipt = params.receiptsByNodeId?.[tid] ?? workingStatuses[tid]?.lastCheckReceipt;
			const trans = updateMissionTaskNodeStatus(workingStatuses, taskGraph, this.host.orgConfig, {
				nodeId: tid,
				status: 'completed',
				caller: {
					isHumanUser: params.isHumanUser,
					isSecretary: params.isSecretary,
					callerTier: effectiveCallerTier,
					callerSessionId: params.callerAgentId,
					callerLabel: params.callerLabel ?? callerStaff?.label,
					callerNodeId,
				},
				orchGraph: !orchGraph.error ? orchGraph : undefined,
				...(rec.whiteboards ? { whiteboards: rec.whiteboards } : {}),
				hasConfiguredChecks: enabledChecks.length > 0,
				...(checkReceipt ? { checkReceipt } : {}),
				...(artifactPtrs.length > 0 ? { artifactPtrs } : {}),
				...(params.modifiedFiles && params.modifiedFiles.length > 0 ? { touchedFiles: params.modifiedFiles } : {}),
				force: params.force,
				note: params.summary,
			});
			if (!trans.ok) {
				const mappedCode = trans.code === 'INCOMPLETE_DEPENDENCIES'
					? 'INCOMPLETE_DEPENDENCIES'
					: trans.code === 'FORBIDDEN'
						? 'FORBIDDEN'
						: trans.code === 'NOT_FOUND'
							? 'NOT_FOUND'
							: 'INVALID_STATE';
				return { ok: false, code: mappedCode, error: trans.error ?? `Cannot mark task "${tid}" completed.` };
			}
			workingStatuses = trans.taskStatuses;
			completedTaskIds.push(tid);
		}
		return { ok: true, nextTaskStatuses: completedTaskIds.length > 0 ? workingStatuses : undefined, completedTaskIds };
	}

	async returnOrchestrationToken(missionId: string, params: {
		readonly tokenId: string;
		readonly toNodeId?: string;
		readonly summary: string;
		readonly detail?: string;
		readonly taskNodeId?: string;
		readonly taskNodeIds?: readonly string[];
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
		readonly refPtrs?: readonly string[];
		readonly modifiedFiles?: readonly string[];
		readonly callerAgentId?: string;
		readonly skipChecks?: boolean;
		readonly completeTask?: boolean;
		readonly force?: boolean;
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerTier?: number;
		readonly callerLabel?: string;
	}): Promise<IOrchestrationTransitionResult<{
		readonly returnedToNodeId: string;
		readonly returnedTokenId?: string;
		readonly barrierId?: string;
		readonly barrierSatisfied?: boolean;
		readonly payloadPtr?: string;
		readonly attachedRefPtrs?: readonly string[];
		readonly completedTaskIds?: readonly string[];
	}>> {
		const rec = this.host.requireMission(missionId);
		const initialState = this.ensureSynchronizedOrchestrationState(rec);
		const tok = initialState.tokens[params.tokenId];
		const boundHolder = tok ? (initialState.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId) : undefined;
		const callerOwnsToken = params.callerAgentId === undefined
			|| (boundHolder ? boundHolder === params.callerAgentId : Boolean(tok && this.resolveCallerOrchestrationNodeId(rec, params.callerAgentId) === tok.nodeId));
		let receiptsByNodeId: Readonly<Record<string, IMissionTaskCheckReceipt>> | undefined;
		if (initialState.status !== 'paused' && !initialState.budgetCircuitTripped && tok && (tok.status === 'active' || tok.status === 'blocked') && callerOwnsToken && params.summary.trim().length > 0) {
			const extraTaskNodeIds = [
				...(params.taskNodeId ? [params.taskNodeId] : []),
				...(params.taskNodeIds ?? []),
				...(tok.taskNodeId ? [tok.taskNodeId] : []),
				...(tok.taskNodeIds ?? []),
			];
			const checkGate = await this.runOrchestrationStaffChecksIfNeeded(rec, tok.nodeId, {
				skipChecks: params.skipChecks,
				tokenId: tok.id,
				holderAgentId: boundHolder,
				extraTaskNodeIds,
			});
			receiptsByNodeId = checkGate.receiptsByNodeId;
			if (!checkGate.passed) {
				return { ok: false, state: initialState, effects: [], code: 'INVALID_STATE', error: checkGate.error };
			}
		}
		const freshRec = this.host.requireMission(missionId);
		const graph = parseOrchestrationGraph(freshRec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(freshRec);
		const freshTok = state.tokens[params.tokenId];
		const taskCompletePrecheck = this.validateAndComputeCompleteTasksForToken(freshRec, graph, freshTok, {
			...params,
			...(receiptsByNodeId ? { receiptsByNodeId } : {}),
		});
		if (!taskCompletePrecheck.ok) {
			return { ok: false, state, effects: [], code: taskCompletePrecheck.code, error: taskCompletePrecheck.error };
		}
		const taskGraph = freshRec.mermaidText?.trim() ? parseMissionMermaidDag(freshRec.mermaidText) : undefined;
		const effectiveTaskStatuses = taskCompletePrecheck.nextTaskStatuses ?? freshRec.taskStatuses;
		const res = returnOrchestrationToken(state, graph, freshRec.whiteboards, this.host.orgConfig, {
			...params,
			...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses: effectiveTaskStatuses } : {}),
		});
		if (res.ok || res.code === 'MAX_HOPS_EXCEEDED') {
			if (res.ok && taskCompletePrecheck.nextTaskStatuses) {
				this.host.missionService?.updateTaskStatuses(freshRec.id, taskCompletePrecheck.nextTaskStatuses, { deferPersist: true, silent: true });
			}
			this.commitOrchestrationState(freshRec.id, res.state);
			await this.host.executeOrchestrationEffects(this.host.requireMission(freshRec.id), res.effects);
		}
		if (res.ok && res.data && taskCompletePrecheck.completedTaskIds.length > 0) {
			return { ...res, data: { ...res.data, completedTaskIds: taskCompletePrecheck.completedTaskIds } };
		}
		return res;
	}

	async handoffOrchestrationToken(missionId: string, params: {
		readonly tokenId: string;
		readonly toNodeIds: readonly string[];
		readonly summary: string;
		readonly detail?: string;
		readonly taskNodeId?: string;
		readonly taskNodeIds?: readonly string[];
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
		readonly refPtrs?: readonly string[];
		readonly modifiedFiles?: readonly string[];
		readonly callerAgentId?: string;
		readonly skipChecks?: boolean;
	}): Promise<IOrchestrationTransitionResult<{ readonly nextTokenIds: readonly string[]; readonly handedOffTo: readonly string[]; readonly payloadPtr?: string; readonly attachedRefPtrs?: readonly string[]; readonly barrierSatisfied?: boolean }>> {
		const rec = this.host.requireMission(missionId);
		const initialGraph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const initialState = this.ensureSynchronizedOrchestrationState(rec);
		const tok = initialState.tokens[params.tokenId];
		const boundHolder = tok ? (initialState.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId) : undefined;
		const callerOwnsToken = params.callerAgentId === undefined
			|| (boundHolder ? boundHolder === params.callerAgentId : Boolean(tok && this.resolveCallerOrchestrationNodeId(rec, params.callerAgentId) === tok.nodeId));
		if (initialState.status !== 'paused' && !initialState.budgetCircuitTripped && tok && (tok.status === 'active' || tok.status === 'blocked') && callerOwnsToken && params.summary.trim().length > 0 && params.toNodeIds.length > 0) {
			const holderNode = initialGraph.nodes.find(n => n.id === tok.nodeId && n.kind === 'staff');
			const holderTier = resolveEffectiveStaffTier(holderNode, this.host.orgConfig);
			const allDownward = params.toNodeIds.every(tid => {
				const target = initialGraph.nodes.find(n => n.id === tid.trim() && n.kind === 'staff');
				const targetTier = resolveEffectiveStaffTier(target, this.host.orgConfig);
				return Boolean(holderTier !== undefined && targetTier !== undefined && targetTier > holderTier);
			});
			if (!allDownward) {
				const extraTaskNodeIds = [
					...(tok.taskNodeId ? [tok.taskNodeId] : []),
					...(tok.taskNodeIds ?? []),
				];
				const checkGate = await this.runOrchestrationStaffChecksIfNeeded(rec, tok.nodeId, {
					skipChecks: params.skipChecks,
					tokenId: tok.id,
					holderAgentId: boundHolder,
					extraTaskNodeIds,
				});
				if (!checkGate.passed) {
					return { ok: false, state: initialState, effects: [], code: 'INVALID_STATE', error: checkGate.error };
				}
			}
		}
		const freshRec = this.host.requireMission(missionId);
		const graph = parseOrchestrationGraph(freshRec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(freshRec);
		const taskGraph = freshRec.mermaidText?.trim() ? parseMissionMermaidDag(freshRec.mermaidText) : undefined;
		const res = handoffOrchestrationToken(state, graph, freshRec.whiteboards, this.host.orgConfig, {
			...params,
			...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses: freshRec.taskStatuses } : {}),
		});
		if (res.ok || res.code === 'MAX_HOPS_EXCEEDED') {
			this.commitOrchestrationState(freshRec.id, res.state);
			await this.host.executeOrchestrationEffects(freshRec, res.effects);
		}
		return res;
	}

	async completeOrchestrationToken(missionId: string, params: {
		readonly tokenId: string;
		readonly summary: string;
		readonly detail?: string;
		readonly toNodeIds?: readonly string[];
		readonly taskNodeId?: string;
		readonly taskNodeIds?: readonly string[];
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
		readonly refPtrs?: readonly string[];
		readonly modifiedFiles?: readonly string[];
		readonly finish?: boolean;
		readonly completeTask?: boolean;
		readonly force?: boolean;
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerTier?: number;
		readonly callerLabel?: string;
		readonly callerAgentId?: string;
		readonly skipChecks?: boolean;
	}): Promise<IOrchestrationTransitionResult<{ readonly nextTokenIds: readonly string[]; readonly finished?: boolean; readonly payloadPtr?: string; readonly barrierSatisfied?: boolean; readonly completedTaskIds?: readonly string[] }>> {
		const rec = this.host.requireMission(missionId);
		const initialGraph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const initialState = this.ensureSynchronizedOrchestrationState(rec);
		const tok = initialState.tokens[params.tokenId];
		const boundHolder = tok ? (initialState.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId) : undefined;
		const callerOwnsToken = params.callerAgentId === undefined
			|| (boundHolder ? boundHolder === params.callerAgentId : Boolean(tok && this.resolveCallerOrchestrationNodeId(rec, params.callerAgentId) === tok.nodeId));
		let receiptsByNodeId: Readonly<Record<string, IMissionTaskCheckReceipt>> | undefined;
		if (initialState.status !== 'paused' && !initialState.budgetCircuitTripped && tok && (tok.status === 'active' || tok.status === 'blocked') && callerOwnsToken && params.summary.trim().length > 0) {
			const holderNode = initialGraph.nodes.find(n => n.id === tok.nodeId && n.kind === 'staff');
			const holderTier = resolveEffectiveStaffTier(holderNode, this.host.orgConfig);
			const allDownward = Boolean(params.toNodeIds && params.toNodeIds.length > 0 && params.toNodeIds.every(tid => {
				const target = initialGraph.nodes.find(n => n.id === tid.trim() && n.kind === 'staff');
				const targetTier = resolveEffectiveStaffTier(target, this.host.orgConfig);
				return Boolean(holderTier !== undefined && targetTier !== undefined && targetTier > holderTier);
			}));
			if (!allDownward) {
				const extraTaskNodeIds = [
					...(params.taskNodeId ? [params.taskNodeId] : []),
					...(params.taskNodeIds ?? []),
					...(tok.taskNodeId ? [tok.taskNodeId] : []),
					...(tok.taskNodeIds ?? []),
				];
				const checkGate = await this.runOrchestrationStaffChecksIfNeeded(rec, tok.nodeId, {
					skipChecks: params.skipChecks,
					tokenId: tok.id,
					holderAgentId: boundHolder,
					extraTaskNodeIds,
				});
				receiptsByNodeId = checkGate.receiptsByNodeId;
				if (!checkGate.passed) {
					return { ok: false, state: initialState, effects: [], code: 'INVALID_STATE', error: checkGate.error };
				}
			}
		}
		const freshRec = this.host.requireMission(missionId);
		const graph = parseOrchestrationGraph(freshRec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(freshRec);
		const freshTok = state.tokens[params.tokenId];
		const taskCompletePrecheck = this.validateAndComputeCompleteTasksForToken(freshRec, graph, freshTok, {
			...params,
			...(receiptsByNodeId ? { receiptsByNodeId } : {}),
		});
		if (!taskCompletePrecheck.ok) {
			return { ok: false, state, effects: [], code: taskCompletePrecheck.code, error: taskCompletePrecheck.error };
		}
		const taskGraph = freshRec.mermaidText?.trim() ? parseMissionMermaidDag(freshRec.mermaidText) : undefined;
		const effectiveTaskStatuses = taskCompletePrecheck.nextTaskStatuses ?? freshRec.taskStatuses;
		const res = completeOrchestrationToken(state, graph, freshRec.whiteboards, this.host.orgConfig, {
			...params,
			...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses: effectiveTaskStatuses } : {}),
		});
		if (res.ok || res.code === 'MAX_HOPS_EXCEEDED') {
			if (res.ok && taskCompletePrecheck.nextTaskStatuses) {
				this.host.missionService?.updateTaskStatuses(freshRec.id, taskCompletePrecheck.nextTaskStatuses, { deferPersist: true, silent: true });
			}
			this.commitOrchestrationState(freshRec.id, res.state);
			await this.host.executeOrchestrationEffects(this.host.requireMission(freshRec.id), res.effects);
		}
		if (res.ok && res.data && taskCompletePrecheck.completedTaskIds.length > 0) {
			return { ...res, data: { ...res.data, completedTaskIds: taskCompletePrecheck.completedTaskIds } };
		}
		return res;
	}

	async failOrchestrationToken(missionId: string, params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly detail?: string;
		readonly category?: OrchestrationReworkCategory;
		readonly callerAgentId?: string;
	}): Promise<IOrchestrationTransitionResult<{ readonly barrierSatisfied?: boolean; readonly payloadPtr?: string; readonly notifiedSuperiorNodeId?: string; readonly recoveryTokenId?: string }>> {
		const rec = this.host.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const res = failOrchestrationToken(state, graph, rec.whiteboards, this.host.orgConfig, params);
		if (res.ok) {
			this.commitOrchestrationState(rec.id, res.state);
			await this.host.executeOrchestrationEffects(rec, res.effects);
		}
		return res;
	}

	async rejectOrchestrationToken(missionId: string, params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly detail?: string;
		readonly category?: OrchestrationReworkCategory;
		readonly targetNodeId?: string;
		readonly targetNodeIds?: readonly string[];
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
		readonly refPtrs?: readonly string[];
		readonly waitJoin?: boolean;
		readonly callerAgentId?: string;
	}): Promise<IOrchestrationTransitionResult<{
		readonly rejectedTokenId: string;
		readonly bouncedTokenId?: string;
		readonly nextTokenIds: readonly string[];
		readonly targetNodeId: string;
		readonly targetNodeIds: readonly string[];
		readonly mode: 'downward_rework' | 'peer_bounce' | 'upward_reject';
		readonly joinBarrierId?: string;
		readonly barrierSatisfied?: boolean;
		readonly payloadPtr?: string;
		readonly attachedRefPtrs?: readonly string[];
	}>> {
		this.host.missionService?.ensureOrchestrationStaffSynced?.(missionId);
		const rec = this.host.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const res = rejectOrchestrationToken(state, graph, rec.whiteboards, this.host.orgConfig, params);
		if (res.ok || res.code === 'MAX_HOPS_EXCEEDED') {
			this.commitOrchestrationState(rec.id, res.state);
			await this.host.executeOrchestrationEffects(rec, res.effects);
		}
		return res;
	}

	async retryOrchestrationToken(missionId: string, params: {
		readonly tokenId?: string;
		readonly nodeId?: string;
		readonly guidance?: string;
		readonly waitJoin?: boolean;
		readonly caller?: {
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerNodeId?: string;
			readonly callerAgentId?: string;
		};
	}): Promise<IOrchestrationTransitionResult<{
		readonly retriedFromTokenId: string;
		readonly tokenId: string;
		readonly nodeId: string;
		readonly joinBarrierId?: string;
		readonly payloadPtr?: string;
	}>> {
		this.host.missionService?.ensureOrchestrationStaffSynced?.(missionId);
		const rec = this.host.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const res = retryOrchestrationToken(state, graph, rec.whiteboards, this.host.orgConfig, params);
		if (res.ok || res.code === 'MAX_HOPS_EXCEEDED') {
			this.commitOrchestrationState(rec.id, res.state);
			await this.host.executeOrchestrationEffects(rec, res.effects);
		}
		return res;
	}

	async pauseOrchestration(missionId: string, reason?: string): Promise<IOrchestrationTransitionResult<{ readonly status: 'paused' }>> {
		const rec = this.host.requireMission(missionId);
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const res = pauseOrchestration(state, { reason });
		if (res.ok) {
			this.commitOrchestrationState(rec.id, res.state);
			if (this.host.projectsService && this.host.sessionsService?.stop) {
				const agentsToStop = new Set<string>();
				for (const tok of Object.values(state.tokens)) {
					if (tok.status === 'active') {
						const holder = state.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId;
						if (holder) {
							agentsToStop.add(holder);
						}
					}
				}
				for (const aid of agentsToStop) {
					const agent = this.host.projectsService.getAgent(aid);
					if (agent?.session) {
						const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
						await this.host.sessionsService.stop(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
						this.host.projectsService.setAgentStatus(agent.id, 'idle');
					}
				}
			}
		}
		return res;
	}

	async resumeOrchestration(missionId: string): Promise<IOrchestrationTransitionResult<{ readonly status: 'running'; readonly activeTokenIds: readonly string[] }>> {
		const rec = this.host.requireMission(missionId);
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const res = resumeOrchestration(state);
		if (res.ok) {
			this.commitOrchestrationState(rec.id, res.state);
			for (const agentId of new Set(Object.values(res.state.nodeAgentIds))) {
				this.host.flushNextQueuedDispatch(agentId);
			}
			const freshRec = this.host.missionService?.getMission(rec.id) ?? rec;
			const orchGraph = parseOrchestrationGraph(freshRec.orchestrationText ?? '');
			for (const tokId of res.data?.activeTokenIds ?? []) {
				const tok = res.state.tokens[tokId];
				if (!tok || tok.status !== 'active') {
					continue;
				}
				const targetAgentId = res.state.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId;
				if (!targetAgentId || (this.host.activeTurnsByAgent.get(targetAgentId) ?? 0) > 0) {
					continue;
				}
				const queued = this.host.pendingDispatchesByAgent.get(targetAgentId);
				if (queued?.some(item => item.options?.tokenId === tok.id && item.options?.missionId === rec.id)) {
					continue;
				}
				const agent = this.host.projectsService?.getAgent(targetAgentId);
				if (!agent) {
					continue;
				}
				const staffNode = orchGraph.nodes.find(n => n.id === tok.nodeId && n.kind === 'staff');
				const resumePrompt = [
					`[Orchestration Resumed · Staff \`${tok.nodeId}\` (${staffNode?.label ?? tok.nodeId}) · Token \`${tok.id}\`]`,
					`Engineering Orchestration has resumed while you hold active baton \`${tok.id}\` (wave \`${tok.waveId}\`).`,
					tok.lastSummary ? `- Current directive headline: ${tok.lastSummary}` : '',
					tok.payloadPtr ? `- Read detail pointer: \`aexus-ade token read ${tok.payloadPtr} --mission ${rec.id} --token ${tok.id} --json\`` : '',
					`Continue advancing your work and explicitly submit via \`token return\`, \`token handoff\`, \`token mint\`, \`token reject\`, or \`token complete --finish\`.`,
				].filter(Boolean).join('\n');
				void this.host.dispatchPromptToAgent(targetAgentId, resumePrompt, {
					autonomousApproved: true,
					missionId: rec.id,
					tokenId: tok.id,
					nodeId: tok.nodeId,
					dedupeKey: `resume-orch:${rec.id}:${tok.id}:${res.state.updatedAt}`,
				}).catch(() => undefined);
			}
		}
		return res;
	}

	async abortOrchestrationTokens(missionId: string, reason?: string): Promise<IOrchestrationTransitionResult<{ readonly abortedTokenIds: readonly string[]; readonly abortedBarrierIds: readonly string[] }>> {
		const rec = this.host.requireMission(missionId);
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const res = abortOrchestrationTokens(state, { reason });
		if (res.ok) {
			const abortedSet = new Set(res.data?.abortedTokenIds ?? []);
			const agentsToStop = new Set<string>();
			for (const tid of abortedSet) {
				const prevTok = state.tokens[tid];
				if (prevTok && (prevTok.status === 'active' || prevTok.status === 'blocked')) {
					const holder = state.nodeAgentIds[prevTok.nodeId] ?? prevTok.holderAgentId;
					if (holder) {
						agentsToStop.add(holder);
					}
				}
			}
			for (const [agentId, queue] of this.host.pendingDispatchesByAgent.entries()) {
				const kept = queue.filter(item => !(item.options?.missionId === rec.id && item.options?.tokenId && abortedSet.has(item.options.tokenId)));
				if (kept.length === 0) {
					this.host.pendingDispatchesByAgent.delete(agentId);
				} else {
					this.host.pendingDispatchesByAgent.set(agentId, kept);
				}
			}
			this.commitOrchestrationState(rec.id, res.state);
			if (this.host.projectsService && this.host.sessionsService?.stop) {
				for (const aid of agentsToStop) {
					const agent = this.host.projectsService.getAgent(aid);
					if (agent?.session) {
						const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
						await this.host.sessionsService.stop(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
						this.host.projectsService.setAgentStatus(agent.id, 'idle');
					}
				}
			}
			this.host.teardownMission(rec.id);
		}
		return res;
	}

	async setOrchestrationLimits(missionId: string, params: {
		readonly maxHops?: number | null;
		readonly budgetLimitUsd?: number | null;
		readonly totalCostUsd?: number;
		readonly silenceReminderMinutes?: number;
	}): Promise<{
		readonly ok: boolean;
		readonly maxHops?: number;
		readonly budgetLimitUsd?: number;
		readonly totalCostUsd?: number;
		readonly budgetCircuitTripped?: boolean;
		readonly silenceReminderMinutes?: number;
		readonly status?: string;
	}> {
		const rec = this.host.requireMission(missionId);
		if (params.budgetLimitUsd !== undefined) {
			await this.host.setBudgetLimit(rec.id, params.budgetLimitUsd === null ? undefined : params.budgetLimitUsd);
		}
		const freshRec = this.host.requireMission(rec.id);
		const curOrch = this.ensureSynchronizedOrchestrationState(freshRec);
		const runtimeState = freshRec.runtime ?? this.host.ensureSynchronizedState(freshRec);
		const synced = setOrchestrationGuardrails(curOrch, {
			...(params.maxHops !== undefined ? { maxHops: params.maxHops } : {}),
			...(params.budgetLimitUsd !== undefined ? { budgetLimitUsd: params.budgetLimitUsd } : {}),
			totalCostUsd: params.totalCostUsd !== undefined ? params.totalCostUsd : computeMissionTotalCostUsd(runtimeState),
		});
		const nextState = params.silenceReminderMinutes !== undefined
			? { ...synced.state, silenceReminderMinutes: params.silenceReminderMinutes }
			: synced.state;
		this.commitOrchestrationState(freshRec.id, nextState);
		if (synced.budgetTrippedNow) {
			void this.host.stopActiveAgentsOnBudgetTrip(runtimeState, this.host.missionService?.getMission(freshRec.id) ?? freshRec);
			this.host.notifyBudgetCircuitTripped(freshRec, runtimeState);
		}
		return {
			ok: true,
			maxHops: nextState.maxHops,
			budgetLimitUsd: nextState.budgetLimitUsd,
			totalCostUsd: nextState.totalCostUsd,
			budgetCircuitTripped: nextState.budgetCircuitTripped,
			silenceReminderMinutes: nextState.silenceReminderMinutes,
			status: nextState.status,
		};
	}

	private purgeInMemoryRuntimeTrackingForRemovedStaff(
		missionId: string,
		removedNodeIds: readonly string[],
		removedAgentIds: readonly string[],
		reclaimedTokenIds: readonly string[],
	): void {
		const agentSet = new Set(removedAgentIds);
		const nodeSet = new Set(removedNodeIds);
		for (const aid of agentSet) {
			this.host.pendingDispatchesByAgent.delete(aid);
			this.host.activeTurnsByAgent.delete(aid);
			this.host.inMemoryAgentActivityAt.delete(aid);
		}
		for (const [turnId, attr] of this.host.turnAttributionById.entries()) {
			if ((attr.agentId && agentSet.has(attr.agentId)) || (attr.missionId === missionId && attr.nodeId && nodeSet.has(attr.nodeId))) {
				this.host.turnAttributionById.delete(turnId);
			}
		}
		for (const tokId of reclaimedTokenIds) {
			const key = `${missionId}:${tokId}`;
			this.host.transientRetryCount.delete(key);
			this.host.unclosedTurnNudgeCount.delete(key);
			this.host.inFlightCheckTokens.delete(`orch-check:${missionId}:${tokId}`);
			this.host.inFlightCheckTokens.delete(`${missionId}:${tokId}`);
		}
		for (const nid of nodeSet) {
			this.host.inFlightCheckTokens.delete(`orch-check:${missionId}:${nid}`);
		}
	}

	private pruneLegacyRuntimeResidueForRemovedStaff(missionId: string, removedNodeIds: readonly string[]): void {
		const rec = this.host.missionService?.getMission(missionId);
		if (!rec || removedNodeIds.length === 0) {
			return;
		}
		const drop = new Set(removedNodeIds);
		for (const nid of drop) {
			this.host.missionService?.removeNodeCheck(missionId, nid);
		}
		this.host.missionService?.removeOrchestrationPositions?.(missionId, [...drop]);

		if (!rec.runtime) {
			return;
		}
		const rt = rec.runtime;
		let rtChanged = false;
		const nextAssignments: Record<string, IMissionNodeAssignment> = {};
		for (const [k, v] of Object.entries(rt.boundary.nodeAssignments ?? {})) {
			if (drop.has(k)) {
				rtChanged = true;
			} else {
				nextAssignments[k] = v;
			}
		}
		const nextNodeStates: Record<string, IMissionRuntimeState['nodeStates'][string]> = {};
		for (const [k, v] of Object.entries(rt.nodeStates ?? {})) {
			if (drop.has(k)) {
				rtChanged = true;
			} else {
				nextNodeStates[k] = v;
			}
		}
		const nextTelemetry: Record<string, NonNullable<IMissionRuntimeState['nodeTelemetry']>[string]> = {};
		for (const [k, v] of Object.entries(rt.nodeTelemetry ?? {})) {
			if (drop.has(k)) {
				rtChanged = true;
			} else {
				nextTelemetry[k] = v;
			}
		}
		const nextLegacyTokens: Record<string, IMissionToken> = { ...rt.tokens };
		for (const [tid, tok] of Object.entries(rt.tokens)) {
			if (drop.has(tok.nodeId) && (tok.status === 'active' || tok.status === 'blocked' || tok.status === 'queued' || tok.status === 'waiting_gate')) {
				nextLegacyTokens[tid] = { ...tok, status: 'recalled', lastActivityAt: Date.now() };
				rtChanged = true;
			}
		}
		if (rtChanged) {
			this.host.missionService?.updateRuntime(missionId, {
				...rt,
				boundary: {
					...rt.boundary,
					nodeAssignments: nextAssignments,
				},
				nodeStates: nextNodeStates,
				nodeTelemetry: nextTelemetry,
				tokens: nextLegacyTokens,
				updatedAt: Date.now(),
			});
		}
	}

	async reconcileRemovedOrchestrationStaff(missionId: string, removedNodeIds: readonly string[], options?: {
		readonly preState?: IOrchestrationRuntimeState;
		readonly preGraph?: IOrchestrationGraphParseResult;
		readonly callerNodeId?: string;
		readonly isHumanUser?: boolean;
		readonly reason?: string;
	}): Promise<{
		readonly reclaimedTokenIds: readonly string[];
		readonly recoveryTokenIds: readonly string[];
		readonly settledBarrierIds: readonly string[];
		readonly reparentedTokenIds: readonly string[];
		readonly stoppedAgentIds: readonly string[];
	}> {
		const cleanIds = [...new Set(removedNodeIds.map(s => s.trim()).filter(Boolean))];
		if (cleanIds.length === 0) {
			return { reclaimedTokenIds: [], recoveryTokenIds: [], settledBarrierIds: [], reparentedTokenIds: [], stoppedAgentIds: [] };
		}
		const rec = this.host.requireMission(missionId);
		let workingState = options?.preState ?? this.ensureSynchronizedOrchestrationState(rec);
		const graphAfterRemoval = parseOrchestrationGraph(rec.orchestrationText ?? '');

		const removedAgentIds = new Set<string>();
		const preGenerated = this.host.missionService?.getGeneratedEmployees(rec.id) ?? [];
		for (const nid of cleanIds) {
			const fromOrch = workingState.nodeAgentIds[nid];
			if (fromOrch) { removedAgentIds.add(fromOrch); }
			const fromPreGraph = options?.preGraph?.nodes.find(n => n.id === nid && n.kind === 'staff')?.agentId;
			if (fromPreGraph) { removedAgentIds.add(fromPreGraph); }
			const fromLegacy = rec.runtime?.boundary?.nodeAssignments?.[nid]?.agentId;
			if (fromLegacy) { removedAgentIds.add(fromLegacy); }
			for (const emp of preGenerated) {
				if (emp.treeNodeId === nid || emp.treeNodeIds?.includes(nid)) {
					removedAgentIds.add(emp.id);
				}
			}
		}

		const stoppedAgentIds: string[] = [];
		for (const aid of removedAgentIds) {
			void this.host.backendService?.revokeSession?.(aid).catch(() => undefined);
			this.host.pendingDispatchesByAgent.delete(aid);
			this.host.activeTurnsByAgent.delete(aid);
			this.host.inMemoryAgentActivityAt.delete(aid);
			const removedAgent = this.host.projectsService?.getAgent(aid);
			if (removedAgent?.session && this.host.sessionsService) {
				const hostAlias = removedAgent.projectUri.scheme === AEXUS_SSH_SCHEME ? removedAgent.projectUri.authority : undefined;
				await this.host.sessionsService.stop?.(removedAgent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
				await this.host.sessionsService.delete(removedAgent.session).catch(() => undefined);
				stoppedAgentIds.push(aid);
			}
		}

		const reclaimedTokenIds: string[] = [];
		const recoveryTokenIds: string[] = [];
		const settledBarrierIds: string[] = [];
		const reparentedTokenIds: string[] = [];
		const allEffects: OrchestrationEngineEffect[] = [];
		for (const nid of cleanIds) {
			const reclaimRes = reclaimOrchestrationTokensForRemovedNode(workingState, graphAfterRemoval, rec.whiteboards, this.host.orgConfig, {
				removedNodeId: nid,
				reclaimedBy: options?.callerNodeId ?? (options?.isHumanUser ? 'User' : undefined),
				reason: options?.reason,
				fallbackSupervisorNodeId: options?.callerNodeId,
			});
			workingState = reclaimRes.state;
			reclaimedTokenIds.push(...(reclaimRes.data?.reclaimedTokenIds ?? []));
			recoveryTokenIds.push(...(reclaimRes.data?.recoveryTokenIds ?? []));
			settledBarrierIds.push(...(reclaimRes.data?.settledBarrierIds ?? []));
			reparentedTokenIds.push(...(reclaimRes.data?.reparentedTokenIds ?? []));
			allEffects.push(...reclaimRes.effects);
		}

		this.purgeInMemoryRuntimeTrackingForRemovedStaff(rec.id, cleanIds, [...removedAgentIds], reclaimedTokenIds);
		this.pruneLegacyRuntimeResidueForRemovedStaff(rec.id, cleanIds);
		this.commitOrchestrationState(rec.id, workingState);
		if (allEffects.length > 0) {
			await this.host.executeOrchestrationEffects(this.host.requireMission(rec.id), allEffects);
		}

		return {
			reclaimedTokenIds,
			recoveryTokenIds,
			settledBarrierIds,
			reparentedTokenIds,
			stoppedAgentIds,
		};
	}

	async removeOrchestrationSubordinate(missionId: string, params: {
		readonly targetNodeId: string;
		readonly callerNodeId?: string;
		readonly callerTier?: number;
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly force?: boolean;
		readonly reason?: string;
	}): Promise<{
		readonly ok: boolean;
		readonly removedNodeId?: string;
		readonly reclaimedTokenIds?: readonly string[];
		readonly recoveryTokenIds?: readonly string[];
		readonly settledBarrierIds?: readonly string[];
		readonly reparentedTokenIds?: readonly string[];
		readonly stoppedAgentIds?: readonly string[];
		readonly orchestrationText?: string;
		readonly error?: string;
		readonly code?: string;
	}> {
		const rec = this.host.requireMission(missionId);
		const preGraph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const plan = planDynamicSubordinateRemoval(rec.orchestrationText ?? '', this.host.orgConfig, {
			...params,
			whiteboards: rec.whiteboards,
		});
		if (!plan.ok || !plan.orchestrationText || !plan.removedNode) {
			return { ok: false, error: plan.error, code: plan.code };
		}

		const targetId = plan.removedNode.id;
		const preState = this.ensureSynchronizedOrchestrationState(rec);

		const preAgentIds = new Set<string>();
		if (preState.nodeAgentIds[targetId]) { preAgentIds.add(preState.nodeAgentIds[targetId]); }
		if (plan.removedNode.agentId) { preAgentIds.add(plan.removedNode.agentId); }
		const fromLegacy = rec.runtime?.boundary?.nodeAssignments?.[targetId]?.agentId;
		if (fromLegacy) { preAgentIds.add(fromLegacy); }
		for (const emp of this.host.missionService?.getGeneratedEmployees(rec.id) ?? []) {
			if (emp.treeNodeId === targetId || emp.treeNodeIds?.includes(targetId)) {
				preAgentIds.add(emp.id);
			}
		}
		const preStoppedAgentIds: string[] = [];
		for (const aid of preAgentIds) {
			void this.host.backendService?.revokeSession?.(aid).catch(() => undefined);
			this.host.pendingDispatchesByAgent.delete(aid);
			this.host.activeTurnsByAgent.delete(aid);
			this.host.inMemoryAgentActivityAt.delete(aid);
			const removedAgent = this.host.projectsService?.getAgent(aid);
			if (removedAgent?.session && this.host.sessionsService) {
				const hostAlias = removedAgent.projectUri.scheme === AEXUS_SSH_SCHEME ? removedAgent.projectUri.authority : undefined;
				await this.host.sessionsService.stop?.(removedAgent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
				await this.host.sessionsService.delete(removedAgent.session).catch(() => undefined);
				preStoppedAgentIds.push(aid);
			}
		}

		this.host.missionService?.updateOrchestrationText(rec.id, plan.orchestrationText);

		const reconciled = await this.reconcileRemovedOrchestrationStaff(rec.id, [targetId], {
			preState,
			preGraph,
			callerNodeId: params.callerNodeId,
			isHumanUser: params.isHumanUser,
			reason: params.reason,
		});
		const allStopped = [...new Set([...preStoppedAgentIds, ...reconciled.stoppedAgentIds])];
		return {
			ok: true,
			removedNodeId: targetId,
			reclaimedTokenIds: reconciled.reclaimedTokenIds,
			recoveryTokenIds: reconciled.recoveryTokenIds,
			settledBarrierIds: reconciled.settledBarrierIds,
			reparentedTokenIds: reconciled.reparentedTokenIds,
			stoppedAgentIds: allStopped,
			orchestrationText: plan.orchestrationText,
		};
	}

	async updateOrchestrationStaffConfig(missionId: string, nodeId: string, patch: {
		readonly engineId?: string | null;
		readonly model?: string | null;
		readonly thinking?: AdeThinkingLevel | string | null;
		readonly hostAlias?: string | null;
		readonly rolePrompt?: string | null;
		readonly allowedPaths?: readonly string[] | null;
		readonly color?: string | null;
		readonly resetSession?: boolean;
	}): Promise<{ readonly ok: boolean; readonly nodeId: string; readonly agentId?: string; readonly resetSession?: boolean; readonly error?: string }> {
		const rec = this.host.requireMission(missionId);
		const cleanNodeId = nodeId.trim();
		const normalizedEnginePatch = patch.engineId === null
			? null
			: (patch.engineId !== undefined ? (normalizeAdeEngineId(patch.engineId) ?? patch.engineId) : undefined);
		const codeUpdate = upsertOrchestrationStaffMetaInCode(rec.orchestrationText ?? '', cleanNodeId, {
			engineId: normalizedEnginePatch,
			model: patch.model,
			thinking: patch.thinking,
			hostAlias: patch.hostAlias,
			rolePrompt: patch.rolePrompt,
			allowedPaths: patch.allowedPaths,
			color: patch.color,
		});
		if (!codeUpdate.ok || !codeUpdate.orchestrationText) {
			return { ok: false, nodeId: cleanNodeId, error: codeUpdate.error ?? `Staff node "${cleanNodeId}" not found.` };
		}
		if (codeUpdate.orchestrationText !== (rec.orchestrationText ?? '')) {
			this.host.missionService?.updateOrchestrationText(rec.id, codeUpdate.orchestrationText);
		}

		if (patch.hostAlias !== undefined) {
			await this.host.bindNodeHost(rec.id, cleanNodeId, { hostAlias: patch.hostAlias ?? 'local' }).catch(() => undefined);
		}

		const freshRec = this.host.requireMission(rec.id);
		const orchState = this.ensureSynchronizedOrchestrationState(freshRec);
		const agentId = orchState.nodeAgentIds[cleanNodeId];
		let didResetSession = false;
		if (agentId && this.host.projectsService) {
			const agent = this.host.projectsService.getAgent(agentId);
			if (agent) {
				if (patch.resetSession && agent.session) {
					this.host.pendingDispatchesByAgent.delete(agent.id);
					if (this.host.sessionsService) {
						const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
						await this.host.sessionsService.stop?.(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
						await this.host.sessionsService.delete(agent.session).catch(() => undefined);
					}
					this.host.projectsService.unbindSession?.(agent.id);
					didResetSession = true;
				}
				const prefPatch: {
					preferredEngineId?: string;
					preferredModel?: string;
					preferredThinking?: AdeThinkingLevel;
				} = {};
				if (normalizedEnginePatch !== undefined) { prefPatch.preferredEngineId = normalizedEnginePatch ?? undefined; }
				if (patch.model !== undefined) { prefPatch.preferredModel = patch.model ?? undefined; }
				if (patch.thinking !== undefined) {
					prefPatch.preferredThinking = (patch.thinking === 'off' || patch.thinking === 'low' || patch.thinking === 'medium' || patch.thinking === 'high' || patch.thinking === 'max')
						? patch.thinking
						: undefined;
				}
				if (Object.keys(prefPatch).length > 0) {
					this.host.projectsService.updateAgentEnginePreferences?.(agent.id, prefPatch);
				}
			}
		}
		this.host.fireDidChange(rec.id);
		return {
			ok: true,
			nodeId: cleanNodeId,
			...(agentId ? { agentId } : {}),
			...(didResetSession ? { resetSession: true } : {}),
		};
	}

	async blockOrchestrationToken(missionId: string, params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly maxDuration: string | number;
		readonly watchPid?: number;
		readonly watchFile?: string;
		readonly hostAlias?: string;
		readonly callerAgentId?: string;
	}): Promise<IOrchestrationTransitionResult> {
		const rec = this.host.requireMission(missionId);
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const durationMs = parseDurationMs(params.maxDuration);
		if (!durationMs) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'INVALID_STATE',
				error: `Invalid maxDuration "${String(params.maxDuration)}". Use formats like "30m", "2h", or milliseconds.`,
			};
		}
		let initialFileMtime: number | null | undefined;
		let initialFileSignature: string | null | undefined;
		if (params.watchFile?.trim() && (this.host.backendService?.probeFileMtime || this.host.backendService?.probeFileSignature)) {
			const host = params.hostAlias || 'local';
			const trimmedWatch = params.watchFile.trim();
			let probeTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				const probeResult = await Promise.race([
					Promise.all([
						this.host.backendService.probeFileMtime
							? this.host.backendService.probeFileMtime(host, trimmedWatch).catch(() => undefined)
							: Promise.resolve(undefined),
						this.host.backendService.probeFileSignature
							? this.host.backendService.probeFileSignature(host, trimmedWatch).catch(() => undefined)
							: Promise.resolve(undefined),
					]),
					new Promise<readonly [undefined, undefined]>(resolve => {
						probeTimer = setTimeout(() => resolve([undefined, undefined] as const), 4_000);
					}),
				]);
				initialFileMtime = probeResult[0];
				initialFileSignature = probeResult[1];
			} finally {
				if (probeTimer !== undefined) {
					clearTimeout(probeTimer);
				}
			}
		}
		const freshRec = this.host.requireMission(missionId);
		const freshState = this.ensureSynchronizedOrchestrationState(freshRec);
		const res = blockOrchestrationToken(freshState, {
			tokenId: params.tokenId,
			reason: params.reason,
			maxDurationMs: durationMs,
			watchPid: params.watchPid,
			watchFile: params.watchFile,
			...(initialFileMtime !== undefined ? { initialFileMtime } : {}),
			hostAlias: params.hostAlias,
			callerAgentId: params.callerAgentId,
		});
		if (res.ok) {
			if (params.watchFile?.trim() && initialFileSignature !== undefined) {
				this.host.blockedFileSignatureByTokenKey.set(`${freshRec.id}:${params.tokenId}`, initialFileSignature);
			}
			this.commitOrchestrationState(freshRec.id, res.state);
		}
		return res;
	}

	async createOrchestrationSubordinate(missionId: string, params: {
		readonly callerNodeId?: string;
		readonly callerAgentId?: string;
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
		readonly handoffTokenId?: string;
		readonly mintTokenId?: string;
		readonly handoffSummary?: string;
		readonly whiteboardIds?: readonly string[];
		readonly createWhiteboard?: boolean;
		readonly whiteboardTitle?: string;
	}): Promise<{
		readonly ok: boolean;
		readonly newNodeId?: string;
		readonly agentId?: string;
		readonly department?: string;
		readonly createdDepartment?: boolean;
		readonly whiteboardId?: string;
		readonly nextTokenIds?: readonly string[];
		readonly orchestrationText?: string;
		readonly error?: string;
		readonly code?: string;
	}> {
		const rec = this.host.requireMission(missionId);
		const normalizedEngineId = normalizeAdeEngineId(params.engineId);
		const plan = planDynamicSubordinateCreation(rec.orchestrationText ?? '', this.host.orgConfig, {
			...params,
			...(normalizedEngineId ? { engineId: normalizedEngineId } : {}),
		});
		if (!plan.ok || !plan.newNodeId || !plan.orchestrationText) {
			return { ok: false, error: plan.error, code: plan.code };
		}
		this.host.missionService?.updateOrchestrationText(rec.id, plan.orchestrationText);
		const updatedRec = this.host.requireMission(rec.id);
		if (params.callerNodeId && updatedRec.orchestrationPositions?.[params.callerNodeId]) {
			const parentPos = updatedRec.orchestrationPositions[params.callerNodeId];
			const siblingCount = Object.keys(updatedRec.orchestrationPositions).length;
			this.host.missionService?.updateOrchestrationPositions(rec.id, {
				...updatedRec.orchestrationPositions,
				[plan.newNodeId]: {
					x: parentPos.x + 360,
					y: parentPos.y + ((siblingCount % 3) - 1) * 220,
				},
			});
		}
		if (params.hostAlias && params.hostAlias.trim() && params.hostAlias.trim().toLowerCase() !== 'local') {
			await this.host.bindNodeHost(rec.id, plan.newNodeId, { hostAlias: params.hostAlias.trim() }).catch(() => undefined);
		}
		const synced = this.ensureSynchronizedOrchestrationState(this.host.requireMission(rec.id));
		this.commitOrchestrationState(rec.id, synced);
		const agentId = synced.nodeAgentIds[plan.newNodeId];
		if (agentId && this.host.projectsService && (normalizedEngineId || params.model || params.thinking)) {
			const prefPatch: { preferredEngineId?: string; preferredModel?: string; preferredThinking?: AdeThinkingLevel } = {};
			if (normalizedEngineId) { prefPatch.preferredEngineId = normalizedEngineId; }
			if (params.model) { prefPatch.preferredModel = params.model; }
			if (params.thinking === 'off' || params.thinking === 'low' || params.thinking === 'medium' || params.thinking === 'high' || params.thinking === 'max') {
				prefPatch.preferredThinking = params.thinking;
			}
			if (Object.keys(prefPatch).length > 0) {
				this.host.projectsService.updateAgentEnginePreferences?.(agentId, prefPatch);
			}
		}

		let createdWhiteboardId: string | undefined;
		let latestOrchestrationText = this.host.requireMission(rec.id).orchestrationText ?? plan.orchestrationText;
		if ((params.createWhiteboard === true || Boolean(params.whiteboardTitle?.trim())) && plan.department) {
			const wbRes = this.upsertOrchestrationWhiteboard(rec.id, {
				title: params.whiteboardTitle?.trim() || `${plan.department} Whiteboard`,
				department: plan.department,
				mode: 'create',
				connectFromNodeId: plan.newNodeId,
				caller: {
					isHumanUser: params.isHumanUser,
					isSecretary: params.isSecretary,
					callerTier: params.callerTier,
					callerAgentId: params.callerAgentId,
				},
			});
			if (wbRes.ok && wbRes.whiteboard) {
				createdWhiteboardId = wbRes.whiteboard.id;
				if (wbRes.orchestrationText) {
					latestOrchestrationText = wbRes.orchestrationText;
				}
			}
		}

		const effectiveWhiteboardIds = createdWhiteboardId
			? [...new Set([...(params.whiteboardIds ?? []), createdWhiteboardId])]
			: params.whiteboardIds;

		let nextTokenIds: readonly string[] | undefined;
		if (params.mintTokenId?.trim()) {
			const mintRes = await this.mintOrchestrationTokens(rec.id, {
				parentTokenId: params.mintTokenId.trim(),
				branches: [{
					toNodeId: plan.newNodeId,
					summary: params.handoffSummary?.trim() || `Subtask minted to newly created subordinate ${params.name}`,
					whiteboardIds: effectiveWhiteboardIds,
				}],
				callerAgentId: params.callerAgentId,
			});
			if (!mintRes.ok) {
				return {
					ok: false,
					newNodeId: plan.newNodeId,
					agentId,
					...(plan.department ? { department: plan.department } : {}),
					...(plan.createdDepartment !== undefined ? { createdDepartment: plan.createdDepartment } : {}),
					...(createdWhiteboardId ? { whiteboardId: createdWhiteboardId } : {}),
					orchestrationText: latestOrchestrationText,
					error: mintRes.error,
					code: mintRes.code,
				};
			}
			nextTokenIds = mintRes.data?.mintedTokenIds;
		} else if (params.handoffTokenId?.trim()) {
			const handoffRes = await this.handoffOrchestrationToken(rec.id, {
				tokenId: params.handoffTokenId.trim(),
				toNodeIds: [plan.newNodeId],
				summary: params.handoffSummary?.trim() || `Subtask delegated to newly created subordinate ${params.name}`,
				whiteboardIds: effectiveWhiteboardIds,
				callerAgentId: params.callerAgentId,
			});
			if (!handoffRes.ok) {
				return {
					ok: false,
					newNodeId: plan.newNodeId,
					agentId,
					...(plan.department ? { department: plan.department } : {}),
					...(plan.createdDepartment !== undefined ? { createdDepartment: plan.createdDepartment } : {}),
					...(createdWhiteboardId ? { whiteboardId: createdWhiteboardId } : {}),
					orchestrationText: latestOrchestrationText,
					error: handoffRes.error,
					code: handoffRes.code,
				};
			}
			nextTokenIds = handoffRes.data?.nextTokenIds;
		}
		return {
			ok: true,
			newNodeId: plan.newNodeId,
			agentId,
			...(plan.department ? { department: plan.department } : {}),
			...(plan.createdDepartment !== undefined ? { createdDepartment: plan.createdDepartment } : {}),
			...(createdWhiteboardId ? { whiteboardId: createdWhiteboardId } : {}),
			...(nextTokenIds ? { nextTokenIds } : {}),
			orchestrationText: latestOrchestrationText,
		};
	}

	private resolveCallerOrchestrationNodeId(rec: IAdeMissionRecord, callerAgentId?: string): string | undefined {
		if (!callerAgentId) {
			return undefined;
		}
		const orch = this.ensureSynchronizedOrchestrationState(rec);
		for (const [nid, aid] of Object.entries(orch.nodeAgentIds)) {
			if (aid === callerAgentId) {
				return nid;
			}
		}
		const agent = this.host.projectsService?.getAgent(callerAgentId);
		if (agent?.treeNodeId && agent.treeGovernorId && (agent.treeGovernorId === rec.id || (rec.ownerSessionId && agent.treeGovernorId === rec.ownerSessionId))) {
			return agent.treeNodeId;
		}
		return undefined;
	}

	listOrchestrationWhiteboards(missionId: string, caller?: {
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerTier?: number;
		readonly callerAgentId?: string;
	}): readonly IOrchestrationWhiteboard[] {
		const rec = this.host.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const merged: Record<string, IOrchestrationWhiteboard> = { ...(rec.whiteboards ?? {}) };
		for (const node of graph.nodes) {
			if (node.kind === 'whiteboard' && !merged[node.id]) {
				merged[node.id] = {
					id: node.id,
					title: node.label,
					department: node.department || 'General',
					content: '',
					version: 0,
					createdAt: rec.createdAt,
					updatedAt: rec.updatedAt,
				};
			}
		}
		const all = Object.values(merged);
		if (!caller || caller.isHumanUser || caller.isSecretary) {
			return all;
		}
		const callerNodeId = this.resolveCallerOrchestrationNodeId(rec, caller.callerAgentId);
		return all.filter(wb => canCallerAccessWhiteboard(graph, wb, this.host.orgConfig, {
			isHumanUser: caller.isHumanUser,
			isSecretary: caller.isSecretary,
			callerTier: caller.callerTier,
			callerNodeId,
			access: 'read',
			state: rec.orchestrationRuntime,
		}));
	}

	readOrchestrationWhiteboard(missionId: string, whiteboardId: string, caller?: {
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerTier?: number;
		readonly callerAgentId?: string;
	}): { readonly ok: boolean; readonly whiteboard?: IOrchestrationWhiteboard; readonly error?: string; readonly code?: string } {
		const rec = this.host.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const id = whiteboardId.trim();
		const graphWb = graph.nodes.find(n => n.kind === 'whiteboard' && n.id === id);
		const existing = rec.whiteboards?.[id] ?? (graphWb
			? {
				id: graphWb.id,
				title: graphWb.label,
				department: graphWb.department || 'General',
				content: '',
				version: 0,
				createdAt: rec.createdAt,
				updatedAt: rec.updatedAt,
			}
			: undefined);
		if (!existing) {
			return { ok: false, code: 'NOT_FOUND', error: `Department whiteboard "${id}" not found.` };
		}
		if (caller && !caller.isHumanUser && !caller.isSecretary) {
			const callerNodeId = this.resolveCallerOrchestrationNodeId(rec, caller.callerAgentId);
			if (!canCallerAccessWhiteboard(graph, existing, this.host.orgConfig, {
				isHumanUser: caller.isHumanUser,
				isSecretary: caller.isSecretary,
				callerTier: caller.callerTier,
				callerNodeId,
				access: 'read',
				state: rec.orchestrationRuntime,
			})) {
				return {
					ok: false,
					code: 'FORBIDDEN',
					error: `FORBIDDEN: caller does not belong to department "${existing.department}" and is not connected to whiteboard "${existing.id}".`,
				};
			}
		}
		return { ok: true, whiteboard: existing };
	}

	upsertOrchestrationWhiteboard(missionId: string, params: {
		readonly id?: string;
		readonly title?: string;
		readonly department?: string;
		readonly content?: string;
		readonly appendContent?: string;
		readonly section?: string;
		readonly sectionMode?: 'replace' | 'append';
		readonly mode?: 'create' | 'write' | 'upsert';
		readonly allowDepartmentRelocation?: boolean;
		readonly expectedVersion?: number;
		readonly connectFromNodeId?: string;
		readonly caller?: {
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerAgentId?: string;
			readonly callerLabel?: string;
		};
	}): { readonly ok: boolean; readonly whiteboard?: IOrchestrationWhiteboard; readonly orchestrationText?: string; readonly currentVersion?: number; readonly error?: string; readonly code?: string } {
		const rec = this.host.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const callerNodeId = this.resolveCallerOrchestrationNodeId(rec, params.caller?.callerAgentId);
		const callerNode = callerNodeId ? graph.nodes.find(n => n.id === callerNodeId && n.kind === 'staff') : undefined;
		const resolvedDept = params.department?.trim() || callerNode?.department || 'General';

		let wbId = params.id?.trim();
		let nextOrchestrationText = rec.orchestrationText;
		const existsInGraph = Boolean(wbId && graph.nodes.some(n => n.kind === 'whiteboard' && n.id === wbId));
		const existsInStore = Boolean(wbId && rec.whiteboards?.[wbId]);
		let existingContent = '';

		if (existsInStore || existsInGraph) {
			const existing = rec.whiteboards?.[wbId!] ?? {
				id: wbId!,
				title: graph.nodes.find(n => n.id === wbId)?.label || wbId!,
				department: graph.nodes.find(n => n.id === wbId)?.department || resolvedDept,
				content: '',
				version: 0,
				createdAt: rec.createdAt,
				updatedAt: rec.updatedAt,
			};
			existingContent = existing.content;
			if (params.mode === 'create') {
				return {
					ok: false,
					code: 'ALREADY_EXISTS',
					currentVersion: existing.version,
					error: `ALREADY_EXISTS: Department whiteboard "${existing.id}" already exists (v${existing.version}). Use "aexus-ade whiteboard write ${existing.id}" to update it.`,
				};
			}
			if (params.caller && !params.caller.isHumanUser && !params.caller.isSecretary) {
				if (!canCallerAccessWhiteboard(graph, existing, this.host.orgConfig, {
					isHumanUser: params.caller.isHumanUser,
					isSecretary: params.caller.isSecretary,
					callerTier: params.caller.callerTier,
					callerNodeId,
					access: 'write',
				})) {
					return {
						ok: false,
						code: 'FORBIDDEN',
						error: `FORBIDDEN: caller cannot write to department "${existing.department}" whiteboard "${existing.id}".`,
					};
				}
			}
		} else {
			if (params.expectedVersion !== undefined && params.expectedVersion !== 0) {
				return {
					ok: false,
					code: 'VERSION_CONFLICT',
					currentVersion: 0,
					error: `VERSION_CONFLICT: Whiteboard "${wbId ?? '(new)'}" does not exist yet (v0), expected v${params.expectedVersion}.`,
				};
			}
			if (params.caller && !params.caller.isHumanUser && !params.caller.isSecretary && params.department?.trim()) {
				const highestTier = Math.min(...this.host.orgConfig.ranks.map(r => r.tier));
				const isTopRank = params.caller.callerTier !== undefined && params.caller.callerTier <= highestTier;
				const isOwner = Boolean(params.caller.callerAgentId && rec.ownerSessionId && params.caller.callerAgentId === rec.ownerSessionId);
				if (!isTopRank && !isOwner && callerNode?.department && callerNode.department.toLowerCase() !== resolvedDept.toLowerCase()) {
					return {
						ok: false,
						code: 'FORBIDDEN',
						error: `FORBIDDEN: caller in department "${callerNode.department}" cannot create a whiteboard inside foreign department "${resolvedDept}".`,
					};
				}
			}
			const planned = planDynamicWhiteboardCreation(rec.orchestrationText ?? '', {
				id: wbId,
				title: params.title?.trim() || `${resolvedDept} Whiteboard`,
				department: resolvedDept,
				connectFromNodeId: params.connectFromNodeId ?? callerNodeId,
			});
			if (!planned.ok || !planned.whiteboardId || !planned.orchestrationText) {
				return { ok: false, code: 'INVALID_GRAPH', error: planned.error ?? 'Failed to create Department Whiteboard.' };
			}
			wbId = planned.whiteboardId;
			nextOrchestrationText = planned.orchestrationText;
		}

		// Contract C3: Surgical heading-section replace/append without rewriting unrelated sections.
		let effectiveContent = params.content;
		let effectiveAppendContent = params.appendContent;
		if (params.section?.trim()) {
			const sectionBody = params.appendContent !== undefined ? params.appendContent : (params.content ?? '');
			const sectionOpMode: 'replace' | 'append' = params.sectionMode ?? (params.appendContent !== undefined ? 'append' : 'replace');
			effectiveContent = upsertWhiteboardSection(existingContent, params.section.trim(), sectionBody, sectionOpMode);
			effectiveAppendContent = undefined;
		}

		const mutated = mutateDepartmentWhiteboard(rec.whiteboards, {
			id: wbId!,
			title: params.title,
			department: existsInStore ? params.department : resolvedDept,
			content: effectiveContent,
			appendContent: effectiveAppendContent,
			mode: params.mode,
			...(params.allowDepartmentRelocation ? { allowDepartmentRelocation: true } : {}),
			expectedVersion: params.expectedVersion,
			...(existsInGraph && !existsInStore ? { existingVersionHint: 0 } : {}),
			updatedBy: params.caller?.callerAgentId ?? (params.caller?.isHumanUser ? 'human' : undefined),
			updatedByLabel: params.caller?.callerLabel ?? (params.caller?.isHumanUser ? 'User' : undefined),
		});
		if (!mutated.ok || !mutated.whiteboard || !mutated.whiteboards) {
			return {
				ok: false,
				code: mutated.code,
				...(mutated.currentVersion !== undefined ? { currentVersion: mutated.currentVersion } : {}),
				error: mutated.error ?? 'Failed to mutate Department Whiteboard.',
			};
		}
		const syncedCode = upsertOrchestrationWhiteboardInCode(nextOrchestrationText ?? '', {
			id: mutated.whiteboard.id,
			title: mutated.whiteboard.title,
			department: mutated.whiteboard.department,
			content: mutated.whiteboard.content,
			version: mutated.whiteboard.version,
		});
		nextOrchestrationText = syncedCode;
		this.host.missionService?.updateWhiteboards(rec.id, mutated.whiteboards);
		if (syncedCode !== (rec.orchestrationText ?? '')) {
			this.host.missionService?.updateOrchestrationText(rec.id, syncedCode);
		}
		this.host.fireDidChange(rec.id);
		return {
			ok: true,
			whiteboard: mutated.whiteboard,
			orchestrationText: nextOrchestrationText,
		};
	}

	removeOrchestrationWhiteboard(missionId: string, whiteboardId: string): {
		readonly ok: boolean;
		readonly removedWhiteboardId?: string;
		readonly prunedTokenIds?: readonly string[];
		readonly error?: string;
		readonly code?: string;
	} {
		const rec = this.host.requireMission(missionId);
		const wbId = whiteboardId.trim();
		if (!wbId) {
			return { ok: false, code: 'INVALID_STATE', error: 'Whiteboard ID is required.' };
		}
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const existed = Boolean(rec.whiteboards?.[wbId]) || graph.nodes.some(n => n.id === wbId && n.kind === 'whiteboard');
		if (!existed) {
			return { ok: false, code: 'NOT_FOUND', error: `Department whiteboard "${wbId}" not found.` };
		}
		const nextWbs: Record<string, IOrchestrationWhiteboard> = { ...(rec.whiteboards ?? {}) };
		delete nextWbs[wbId];
		const nextCode = removeOrchestrationNode(rec.orchestrationText ?? '', wbId);
		this.host.missionService?.updateWhiteboards(rec.id, nextWbs);
		if (nextCode !== (rec.orchestrationText ?? '')) {
			this.host.missionService?.updateOrchestrationText(rec.id, nextCode);
		}
		let prunedTokenIds: readonly string[] = [];
		if (rec.orchestrationRuntime) {
			const pruned = pruneRemovedWhiteboardFromState(this.ensureSynchronizedOrchestrationState(this.host.requireMission(rec.id)), wbId);
			prunedTokenIds = pruned.prunedTokenIds;
			if (pruned.prunedTokenIds.length > 0) {
				this.commitOrchestrationState(rec.id, pruned.state);
			} else {
				this.host.fireDidChange(rec.id);
			}
		} else {
			this.host.fireDidChange(rec.id);
		}
		return { ok: true, removedWhiteboardId: wbId, prunedTokenIds };
	}
}
