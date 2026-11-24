/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from '../../../base/common/path.js';
import { ADE_API_LATEST_REVISION, queryApiUpdateDiff } from '../common/adeApiRegistry.js';
import type { IAdeCloudHostBackendService } from '../common/adeCloudHosts.js';
import {
	ADE_FULL_SUPERVISOR_MISSION_ACTIONS,
	ADE_IN_GRAPH_UNIVERSAL_ACTIONS,
	ADE_PARTIAL_SUPERVISOR_MISSION_ACTIONS,
	buildUnifiedOrchestrationStatusResponse,
	canCallerInspectOrchestrationTokenHistory,
	canCallerInspectOrchestrationTrace,
	isExplicitMissionMemberOrSupervisor,
	isStrictCompanyWideExecutiveDept,
	parseOrchestrationLimitsRequest,
	parseUnifiedMissionCheckpointBundle,
	parseWhiteboardSliceParams,
	projectJoinBarrierSummary,
	projectOrchestrationTokenView,
	serializeUnifiedMissionCheckpointBundle,
	stripForeignWhiteboardBodiesFromOrchestrationText,
} from '../common/adeControlPolicy.js';
import { buildAdeDocsPaths, IAdeDocsPaths, normalizeAdeDocTargetKey } from '../common/adeDocsCatalog.js';
import {
	IAdeApiDocReadResult,
	IAdeDeterministicCheckRequest,
	IAdeDeterministicCheckResponse,
	IAdeHeadlessControlResult,
	IAdeInboxItem,
	IAdeInboxMutation,
	IAdeMissionCheckpointMeta,
	IAdeOrchestrationDaemonMissionSnapshot,
} from '../common/adeEngineering.js';
import { classifyTierFactorySide } from '../common/adeMissionBoundary.js';
import { IMissionNodeCheckHook, parseDualViewBlueprintMarkdown, parseMissionMermaidDag } from '../common/adeMissionDag.js';
import { computeMissionTotalCostUsd, IMissionRuntimeState } from '../common/adeMissionEngine.js';
import {
	computeOrchestrationCheckpointDiff,
	createOrchestrationCheckpointSnapshot,
	IOrchestrationCheckpointSnapshot,
	IOrchestrationCheckpointSummary,
	summarizeOrchestrationCheckpoint,
} from '../common/adeOrchestrationCheckpoints.js';
import { computeMissionDiagnostics } from '../common/adeOrchestrationDiagnostics.js';
import { exportToOrchestrationManifest, validateOrchestrationManifest } from '../common/adeOrchestrationConfig.js';
import {
	canCallerAccessWhiteboard,
	createInitialOrchestrationRuntimeState,
	findHighestRankStaffNode,
	IDereferencedOrchestrationPointer,
	IMissionTaskCheckReceipt,
	IMissionTaskStatusRecord,
	IOrchestrationRuntimeState,
	IOrchestrationWhiteboard,
	OrchestrationEngineEffect,
	readOrchestrationTokenPointers,
	recordExternalizedPointersRead,
	recordMissionTaskCheckReceipt,
	resolveEffectiveStaffTier,
	sliceWhiteboardContent,
} from '../common/adeOrchestrationEngine.js';
import { IOrchestrationGraphParseResult, parseOrchestrationGraph, serializeOrchestrationGraph } from '../common/adeOrchestrationGraph.js';
import { buildOrchestrationTokenDeltaView } from '../common/adeOrchestrationTypes.js';
import {
	ADE_SECRETARY_TIER,
	ADE_SECRETARY_TIER_TAG,
	ADE_USER_TIER,
	buildLiveRankDirectory,
	findRankByTierOrId,
	formatTierTag,
	parseTierNumber,
} from '../common/adeRankResize.js';
import { checkAdeApiPermission, IAdeOrganizationConfig, resolveEffectiveRankDefinition } from '../common/adeRoleSchema.js';

export const HEADLESS_SECRETARY_ID = '__secretary__';

export interface IAdeParsedMissionIndexEntry {
	readonly id: string;
	readonly title: string;
	readonly ownerSessionId?: string;
	readonly ownerTier?: number;
	readonly projectUri?: string;
	readonly updatedAt: number;
	readonly orchStatus?: string;
	readonly activeTokenCount: number;
	readonly nodeAgentIds: Readonly<Record<string, string>>;
	readonly tokenIds: ReadonlySet<string>;
	readonly tracePtrs: ReadonlySet<string>;
	readonly supervisorIds: readonly string[];
	readonly nodeAssignmentAgentIds: readonly string[];
	readonly mtimeMs: number;
	readonly size: number;
}

export interface IHeadlessCaller {
	readonly isHumanUser: boolean;
	readonly isSecretary: boolean;
	readonly callerSessionId: string | undefined;
	readonly callerTier: number | undefined;
	readonly callerNodeId: string | undefined;
}

export interface IHeadlessCheckSuiteOutcome {
	readonly ok: boolean;
	readonly error?: string;
	readonly receipt?: IMissionTaskCheckReceipt;
	readonly checkCount: number;
	readonly totalDurationMs: number;
	readonly results: readonly IAdeDeterministicCheckResponse[];
}

export interface IAdeHeadlessBackendHost {
	readonly baseDir: string;
	readonly cloudHostService?: IAdeCloudHostBackendService;
	isSessionRevoked(sessionId: string, tokenIat?: number): boolean;
	loadCachedOrgConfig(): Promise<IAdeOrganizationConfig>;
	loadInbox(): Promise<IAdeInboxItem[]>;
	mutateInbox(mutation: IAdeInboxMutation): Promise<IAdeInboxItem[]>;
	nextTmpSeq(): number;
	loadMissionRecord(missionId: string): Promise<string | undefined>;
	loadAllMissionRecords(): Promise<Readonly<Record<string, string>>>;
	getParsedMissionIndex(): Promise<ReadonlyMap<string, IAdeParsedMissionIndexEntry>>;
	withMissionLock<T>(missionId: string, op: () => Promise<T>): Promise<T>;
	saveMissionRecordUnlocked(missionId: string, payloadJson: string, updatedAt: number, writerId?: string, expectedRevision?: number): Promise<void>;
	saveMissionRecord(missionId: string, payloadJson: string, updatedAt: number, writerId?: string, expectedRevision?: number): Promise<void>;
	readOrchestrationBlob(missionId: string, ptr: string): Promise<string | undefined>;
	readOrchestrationArchive(missionId: string, options?: { readonly limit?: number; readonly offset?: number }): Promise<readonly string[]>;
	getOrchestrationDaemonState(missionId?: string): Promise<Readonly<Record<string, IAdeOrchestrationDaemonMissionSnapshot>>>;
	readApiDoc(target: string, config?: IAdeOrganizationConfig): Promise<IAdeApiDocReadResult>;
	syncApiDocs(config: IAdeOrganizationConfig): Promise<IAdeDocsPaths>;
	probeFileMtime(hostAlias: string, filePath: string): Promise<number | null>;
	probeFileSignature(hostAlias: string, filePath: string): Promise<string | null>;
	runDeterministicCheck(request: IAdeDeterministicCheckRequest): Promise<IAdeDeterministicCheckResponse>;
	persistHeadlessOrchStateRecord(
		missionId: string,
		record: Record<string, unknown>,
		parsedGraph: IOrchestrationGraphParseResult,
		nextOrchBase: IOrchestrationRuntimeState,
		emittedEffects: readonly OrchestrationEngineEffect[],
		nowTs: number,
		options?: { readonly alreadyLocked?: boolean },
	): Promise<IOrchestrationRuntimeState>;
	runHeadlessOrchestrationChecksIfNeeded(
		record: Record<string, unknown>,
		parsedGraph: IOrchestrationGraphParseResult,
		taskGraph: ReturnType<typeof parseMissionMermaidDag> | undefined,
		nodeId: string,
		extraTaskNodeIds: readonly string[],
		skipChecks: boolean,
		isHumanUser: boolean,
		tokenId?: string,
	): Promise<IHeadlessCheckSuiteOutcome>;
	resolveProjectCwdFromRecord(record: Record<string, unknown>): string | undefined;
	saveMissionCheckpoint(missionId: string, checkpointId: string, payloadJson: string, meta: IAdeMissionCheckpointMeta): Promise<void>;
	listMissionCheckpoints(missionId: string): Promise<readonly IAdeMissionCheckpointMeta[]>;
	loadMissionCheckpoint(missionId: string, checkpointId: string): Promise<string | undefined>;
	deleteMissionCheckpoint(missionId: string, checkpointId: string): Promise<void>;
	syncHeadlessWatchdogForRecord(missionId: string, record: Record<string, unknown>): void;
}

export interface IHeadlessMissionScopeContext {
	readonly host: IAdeHeadlessBackendHost;
	readonly missionId: string;
	readonly action: string;
	readonly params: Readonly<Record<string, unknown>>;
	readonly effectiveOrgConfig: IAdeOrganizationConfig;
	readonly isLocked: boolean;
	readonly record: Record<string, unknown>;
	readonly orch: IOrchestrationRuntimeState | undefined;
	readonly orchestrationText: string;
	readonly parsedGraph: IOrchestrationGraphParseResult;
	readonly caller: IHeadlessCaller;
	buildMergedWhiteboards(): Readonly<Record<string, IOrchestrationWhiteboard>>;
	isMissionMember(caller?: IHeadlessCaller): boolean;
	assertMissionMemberOrSupervisor(caller?: IHeadlessCaller): string | undefined;
	canOperateMission(caller?: IHeadlessCaller): boolean;
	saveCurrentRecord(nowTs: number): Promise<void>;
	collectEffectiveNodeChecks(filterNodeId?: string): Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
	filterWhiteboardsForCaller(caller?: IHeadlessCaller): {
		readonly visible: readonly IOrchestrationWhiteboard[];
		readonly allowedIds: ReadonlySet<string>;
		readonly safeOrchText: string;
	};
	persistHeadlessOrchState(
		nextOrchBase: IOrchestrationRuntimeState,
		emittedEffects: readonly OrchestrationEngineEffect[],
		nowTs: number,
	): Promise<IOrchestrationRuntimeState>;
}

export const HEADLESS_SUPPORTED_ACTIONS: ReadonlySet<string> = new Set([
	'whoami',
	'docs.read',
	'api.update',
	'rank.list',
	'rank.names',
	'rank.get',
	'rank.docs',
	'mission.docs',
	'inbox.list',
	'inbox.post',
	'inbox.markRead',
	'inbox.resolve',
	'host.list',
	'host.get',
	'host.info',
	'host.test',
	'host.browse',
	'mission.list',
	'mission.get',
	'mission.blueprint.get',
	'mission.blueprint.validate',
	'mission.blueprint.apply',
	'mission.export',
	'mission.diagnostics',
	'mission.checkpoint.create',
	'mission.checkpoint.list',
	'mission.checkpoint.diff',
	'mission.checkpoint.restore',
	'orchestration.checkpoint.create',
	'orchestration.checkpoint.list',
	'orchestration.checkpoint.diff',
	'orchestration.checkpoint.restore',
	'orchestration.get',
	'orchestration.export',
	'orchestration.validate',
	'orchestration.group.list',
	'orchestration.status',
	'orchestration.dispatch',
	'orchestration.pause',
	'orchestration.resume',
	'orchestration.abort',
	'orchestration.limits',
	'mission.budget.set',
	'token.current',
	'token.read',
	'token.history',
	'token.trace',
	'token.return',
	'token.handoff',
	'token.complete',
	'token.reject',
	'token.block',
	'token.fail',
	'token.retry',
	'token.mint',
	'token.split',
	'whiteboard.list',
	'whiteboard.read',
	'whiteboard.create',
	'whiteboard.write',
	'whiteboard.rename',
	'whiteboard.remove',
	'mission.task.list',
	'mission.task.get',
	'mission.task.set',
	'mission.task.create',
	'mission.task.update',
	'mission.task.remove',
	'mission.task.edge.add',
	'mission.task.edge.remove',
	'mission.task.complete',
	'mission.task.status',
	'mission.check.list',
	'mission.check.get',
	'mission.check.set',
	'mission.check.remove',
	'mission.check.run',
	'org.escalate',
]);

export const HEADLESS_MUTATING_MISSION_ACTIONS: ReadonlySet<string> = new Set([
	'token.return',
	'token.handoff',
	'token.complete',
	'token.reject',
	'token.block',
	'token.fail',
	'token.retry',
	'token.mint',
	'token.split',
	'token.read',
	'whiteboard.create',
	'whiteboard.write',
	'whiteboard.rename',
	'whiteboard.remove',
	'mission.task.set',
	'mission.task.create',
	'mission.task.update',
	'mission.task.remove',
	'mission.task.edge.add',
	'mission.task.edge.remove',
	'mission.task.complete',
	'mission.task.status',
	'mission.check.set',
	'mission.check.remove',
	'mission.check.run',
	'mission.blueprint.apply',
	'mission.checkpoint.create',
	'mission.checkpoint.restore',
	'orchestration.checkpoint.create',
	'orchestration.checkpoint.restore',
	'orchestration.dispatch',
	'orchestration.pause',
	'orchestration.resume',
	'orchestration.abort',
	'orchestration.limits',
	'mission.budget.set',
	'org.escalate',
]);

const HEADLESS_GLOBAL_PERMISSION_GATED: ReadonlySet<string> = new Set([
	'host.list',
	'host.get',
	'host.info',
	'host.test',
	'host.browse',
	'inbox.list',
	'inbox.post',
	'inbox.markRead',
	'inbox.resolve',
]);

export function isVerifiedHeadlessSecretary(params: Readonly<Record<string, unknown>>): boolean {
	const isVerified = params._verifiedCaller === true;
	const callerStr = typeof params.caller === 'string' ? params.caller.trim().toLowerCase() : '';
	const verifiedSid = isVerified && typeof params._callerSessionId === 'string' ? params._callerSessionId.trim() : '';
	if (isVerified) {
		return (verifiedSid === HEADLESS_SECRETARY_ID || verifiedSid === 'ade-secretary')
			&& (!callerStr || callerStr === 'secretary' || callerStr === 'l0');
	}
	return callerStr === 'secretary' || callerStr === 'l0';
}

export function resolveHeadlessCaller(
	params: Readonly<Record<string, unknown>>,
	orch: IOrchestrationRuntimeState | undefined,
	parsedGraph: IOrchestrationGraphParseResult,
	effectiveOrgConfig: IAdeOrganizationConfig,
): IHeadlessCaller {
	const isVerified = params._verifiedCaller === true;
	const callerStr = typeof params.caller === 'string' ? params.caller.trim().toLowerCase() : '';
	const verifiedSessionId = isVerified && typeof params._callerSessionId === 'string' ? params._callerSessionId.trim() : '';
	const fallbackSessionId = !isVerified && typeof params.callerSessionId === 'string' ? params.callerSessionId.trim() : '';
	const callerSessionId = verifiedSessionId || fallbackSessionId;
	const explicitNodeId = !isVerified && typeof params.callerNodeId === 'string' ? params.callerNodeId.trim() : '';
	if (!isVerified && !callerStr && !callerSessionId && !explicitNodeId) {
		return { isHumanUser: true, isSecretary: false, callerSessionId: undefined, callerTier: -1, callerNodeId: undefined };
	}
	if ((callerStr === 'secretary' || callerStr === 'l0') && (!isVerified || verifiedSessionId === HEADLESS_SECRETARY_ID || verifiedSessionId === 'ade-secretary')) {
		return { isHumanUser: false, isSecretary: true, callerSessionId: HEADLESS_SECRETARY_ID, callerTier: 0, callerNodeId: undefined };
	}
	let callerNodeId = explicitNodeId || undefined;
	if (!callerNodeId && callerSessionId && orch?.nodeAgentIds) {
		for (const [nid, aid] of Object.entries(orch.nodeAgentIds)) {
			if (aid === callerSessionId) {
				callerNodeId = nid;
				break;
			}
		}
	}
	const parsedTier = parseTierNumber(callerStr);
	const matchedRank = effectiveOrgConfig.ranks.find(
		r => r.id.toLowerCase() === callerStr || r.name.toLowerCase() === callerStr || (parsedTier !== undefined && r.tier === parsedTier),
	);
	const staffNode = callerNodeId ? parsedGraph.nodes.find(n => n.id === callerNodeId && n.kind === 'staff') : undefined;
	return {
		isHumanUser: false,
		isSecretary: false,
		callerSessionId: callerSessionId || undefined,
		callerTier: matchedRank?.tier ?? resolveEffectiveStaffTier(staffNode, effectiveOrgConfig),
		callerNodeId,
	};
}

export function buildHeadlessCheckpointSnapshot(
	missionId: string,
	record: Record<string, unknown>,
	options?: { readonly label?: string; readonly reason?: string; readonly createdBy?: string; readonly now?: number; readonly seq?: number },
): { readonly checkpointId: string; readonly meta: IAdeMissionCheckpointMeta; readonly summary: IOrchestrationCheckpointSummary; readonly payloadJson: string } {
	const now = options?.now ?? Date.now();
	const seq = options?.seq ?? 1;
	const checkpointId = `ckpt-${now.toString(36)}-${seq}`;
	const rawOrch = record.orchestrationRuntime as IOrchestrationRuntimeState | undefined;
	const orch = rawOrch ?? createInitialOrchestrationRuntimeState(missionId, []);
	const tokens = Object.values(orch.tokens ?? {});
	const activeTokenCount = tokens.filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join').length;
	const taskStatuses = (record.taskStatuses ?? {}) as Readonly<Record<string, IMissionTaskStatusRecord>>;
	const whiteboards = (record.whiteboards ?? {}) as Readonly<Record<string, IOrchestrationWhiteboard>>;
	const completedTaskCount = Object.values(taskStatuses).filter(s => s?.status === 'completed').length;
	const totalCostUsd = typeof orch.totalCostUsd === 'number' && Number.isFinite(orch.totalCostUsd) ? orch.totalCostUsd : 0;
	const stateRevision = typeof orch.stateRevision === 'number' && Number.isFinite(orch.stateRevision) ? orch.stateRevision : 0;
	const meta: IAdeMissionCheckpointMeta = {
		id: checkpointId,
		missionId,
		...(options?.label?.trim() ? { label: options.label.trim() } : {}),
		...(options?.reason?.trim() ? { reason: options.reason.trim() } : {}),
		...(options?.createdBy?.trim() ? { createdBy: options.createdBy.trim() } : {}),
		createdAt: now,
		stateRevision,
		activeTokenCount,
		completedTaskCount,
		totalCostUsd,
	};
	const checkpointSnapshot = createOrchestrationCheckpointSnapshot(orch, {
		id: checkpointId,
		label: options?.label,
		reason: options?.reason,
		createdBy: options?.createdBy,
		taskStatuses,
		whiteboards,
		now,
	});
	const summary = summarizeOrchestrationCheckpoint(checkpointSnapshot);
	const payloadJson = serializeUnifiedMissionCheckpointBundle({
		meta,
		checkpointSnapshot,
		mermaidText: typeof record.mermaidText === 'string' ? record.mermaidText : '',
		orchestrationText: typeof record.orchestrationText === 'string' ? record.orchestrationText : '',
		nodePrompts: (record.nodePrompts && typeof record.nodePrompts === 'object') ? record.nodePrompts as Readonly<Record<string, string>> : {},
		nodeChecks: (record.nodeChecks && typeof record.nodeChecks === 'object') ? record.nodeChecks as Readonly<Record<string, readonly IMissionNodeCheckHook[]>> : {},
		whiteboards,
		taskStatuses,
	});
	return { checkpointId, meta, summary, payloadJson };
}

export function computeHeadlessCheckpointDiff(
	baseRecord: Record<string, unknown>,
	targetRecord: Record<string, unknown>,
	options?: {
		readonly baseSnapshot?: IOrchestrationCheckpointSnapshot;
		readonly targetSnapshot?: IOrchestrationCheckpointSnapshot;
		readonly fromId?: string;
		readonly toId?: string;
	},
): Record<string, unknown> {
	const baseOrch = baseRecord.orchestrationRuntime as IOrchestrationRuntimeState | undefined;
	const targetOrch = targetRecord.orchestrationRuntime as IOrchestrationRuntimeState | undefined;
	const baseTasks = (baseRecord.taskStatuses ?? {}) as Readonly<Record<string, IMissionTaskStatusRecord>>;
	const targetTasks = (targetRecord.taskStatuses ?? {}) as Readonly<Record<string, IMissionTaskStatusRecord>>;
	const baseWbs = (baseRecord.whiteboards ?? {}) as Readonly<Record<string, IOrchestrationWhiteboard>>;
	const targetWbs = (targetRecord.whiteboards ?? {}) as Readonly<Record<string, IOrchestrationWhiteboard>>;

	const effectiveBaseSnap: IOrchestrationCheckpointSnapshot | undefined = options?.baseSnapshot
		?? (baseOrch ? createOrchestrationCheckpointSnapshot(baseOrch, { id: options?.fromId ?? 'from', taskStatuses: baseTasks, whiteboards: baseWbs }) : undefined);
	const canonicalDiff = effectiveBaseSnap
		? (options?.targetSnapshot
			? computeOrchestrationCheckpointDiff(effectiveBaseSnap, options.targetSnapshot)
			: targetOrch
				? computeOrchestrationCheckpointDiff(effectiveBaseSnap, {
					id: options?.toId ?? 'live',
					orchState: targetOrch,
					taskStatuses: targetTasks,
					whiteboards: targetWbs,
				})
				: undefined)
		: undefined;

	return {
		mermaidChanged: (baseRecord.mermaidText ?? '') !== (targetRecord.mermaidText ?? ''),
		orchestrationChanged: (baseRecord.orchestrationText ?? '') !== (targetRecord.orchestrationText ?? ''),
		fromStateRevision: baseOrch?.stateRevision ?? effectiveBaseSnap?.stateRevision ?? 0,
		toStateRevision: targetOrch?.stateRevision ?? options?.targetSnapshot?.stateRevision ?? 0,
		costDeltaUsd: Number(((targetOrch?.totalCostUsd ?? options?.targetSnapshot?.totalCostUsd ?? 0) - (baseOrch?.totalCostUsd ?? effectiveBaseSnap?.totalCostUsd ?? 0)).toFixed(6)),
		...(canonicalDiff ?? {
			fromId: options?.fromId ?? 'from',
			toId: options?.toId ?? 'live',
			addedTokenIds: [],
			removedTokenIds: [],
			statusChangedTokens: [],
			barrierChanges: [],
			taskStatusChanges: [],
			whiteboardVersionChanges: [],
		}),
	};
}

export function computeHeadlessMissionDiagnostics(
	missionId: string,
	record: Record<string, unknown>,
	parsedGraph: IOrchestrationGraphParseResult,
	now = Date.now(),
): Record<string, unknown> {
	const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
	const taskGraph = mermaidText.trim() ? parseMissionMermaidDag(mermaidText) : undefined;
	const taskStatuses = (record.taskStatuses ?? {}) as Readonly<Record<string, IMissionTaskStatusRecord>>;
	const orch = record.orchestrationRuntime as IOrchestrationRuntimeState | undefined;
	const legacyRt = record.runtime as IMissionRuntimeState | undefined;
	const legacyCost = legacyRt ? computeMissionTotalCostUsd(legacyRt) : 0;
	const effectiveCostUsd = Math.max(orch?.totalCostUsd ?? 0, legacyCost);
	const budgetLimitUsd = orch?.budgetLimitUsd ?? legacyRt?.budgetLimitUsd;
	const finOps = orch?.finOpsTelemetry;
	const report = computeMissionDiagnostics({
		missionId,
		taskGraph,
		taskStatuses,
		orchGraph: parsedGraph,
		orchState: orch,
		finOpsSummary: {
			totalCostUsd: effectiveCostUsd,
			...(budgetLimitUsd !== undefined ? { budgetLimitUsd } : {}),
			...(finOps ? {
				totalTokens: finOps.totalInputTokens + finOps.totalOutputTokens + finOps.totalCacheReadTokens + finOps.totalCacheWriteTokens,
				cacheHitRatePct: finOps.cacheHitRatePct,
				reworkTokens: finOps.reworkTokens,
			} : {}),
		},
		now,
	});
	return {
		headless: true,
		ok: true,
		...report,
	};
}

/**
 * Checks global (pre-mission) headless RBAC and handles mission-independent actions
 * (`api.update`, `inbox.*`, `host.*`, `mission.list`, `docs.read`, `rank.*`, `mission.docs`,
 * `whoami`, standalone `mission.blueprint.validate` & `orchestration.validate`).
 * Returns `undefined` when the action requires mission resolution.
 */
export async function tryExecuteHeadlessGlobalAction(
	host: IAdeHeadlessBackendHost,
	action: string,
	params: Readonly<Record<string, unknown>>,
	preConfig: IAdeOrganizationConfig,
): Promise<IAdeHeadlessControlResult | undefined> {
	const verifiedCallerSid = params._verifiedCaller === true && typeof params._callerSessionId === 'string'
		? params._callerSessionId.trim()
		: '';
	const callerTokenIat = typeof params._callerTokenIat === 'number' && Number.isFinite(params._callerTokenIat)
		? params._callerTokenIat
		: undefined;
	if (verifiedCallerSid && host.isSessionRevoked(verifiedCallerSid, callerTokenIat)) {
		return { handled: true, error: 'FORBIDDEN: caller session has been revoked or archived.' };
	}

	const rawCallerPre = typeof params.caller === 'string' ? params.caller.trim().toLowerCase() : '';
	const isVerifiedSec = isVerifiedHeadlessSecretary(params);
	const isPreHumanOrSec = (!params._verifiedCaller && (!rawCallerPre || rawCallerPre === 'human' || rawCallerPre === 'user' || rawCallerPre === 'l-1' || rawCallerPre === 'secretary' || rawCallerPre === 'l0'))
		|| isVerifiedSec;
	const isReadOnlyLimitsQuery = action === 'orchestration.limits'
		&& parseOrchestrationLimitsRequest(params, { isHumanUser: false }).isReadOnlyQuery;

	if (!isPreHumanOrSec && params._verifiedCaller === true && rawCallerPre) {
		const callerRankDefPre = resolveEffectiveRankDefinition(preConfig, rawCallerPre, false);
		if (callerRankDefPre.pureExecution && !ADE_IN_GRAPH_UNIVERSAL_ACTIONS.has(action) && !isReadOnlyLimitsQuery) {
			const perm = checkAdeApiPermission(preConfig, rawCallerPre, action);
			return { handled: true, error: `FORBIDDEN: ${perm.reason ?? `Permission denied: pure-execution rank "${callerRankDefPre.name}" cannot invoke "${action}".`}` };
		}
		if (HEADLESS_GLOBAL_PERMISSION_GATED.has(action)) {
			const perm = checkAdeApiPermission(preConfig, rawCallerPre, action);
			if (!perm.allowed) {
				return { handled: true, error: `FORBIDDEN: ${perm.reason ?? `Permission denied for action "${action}".`}` };
			}
		}
	}

	if (action === 'api.update') {
		const rawSince = params.since ?? params.from ?? params.revision;
		const sinceNum = typeof rawSince === 'number'
			? rawSince
			: (typeof rawSince === 'string' && rawSince.trim() ? Number(rawSince) : ADE_API_LATEST_REVISION);
		const scope = typeof params.scope === 'string' ? params.scope : undefined;
		return { handled: true, result: queryApiUpdateDiff(sinceNum, scope) };
	}

	if (action === 'inbox.list' || action === 'inbox.post' || action === 'inbox.markRead' || action === 'inbox.resolve') {
		const resolveAuthorizedInboxGovernors = async (): Promise<ReadonlySet<string> | undefined> => {
			if (isPreHumanOrSec) {
				return undefined;
			}
			const allowed = new Set<string>();
			if (verifiedCallerSid) {
				allowed.add(verifiedCallerSid);
				const index = await host.getParsedMissionIndex();
				for (const entry of index.values()) {
					const isOwner = entry.ownerSessionId === verifiedCallerSid;
					const isSupervisor = entry.supervisorIds.includes(verifiedCallerSid);
					const isStandaloneStaff = !entry.ownerSessionId
						&& (entry.ownerTier === undefined || entry.ownerTier <= ADE_USER_TIER)
						&& Object.values(entry.nodeAgentIds).includes(verifiedCallerSid);
					if (isOwner || isSupervisor || isStandaloneStaff) {
						allowed.add(entry.id);
						if (entry.ownerSessionId) {
							allowed.add(entry.ownerSessionId);
						}
					}
				}
			}
			return allowed;
		};
		if (action === 'inbox.list') {
			const allowedGovernors = await resolveAuthorizedInboxGovernors();
			const all = await host.loadInbox();
			const visibleScope = allowedGovernors
				? all.filter(item => allowedGovernors.has(item.governorSessionId))
				: all;
			const unreadOnly = params.unreadOnly === true;
			const includeResolved = params.includeResolved !== false;
			const govFilter = typeof (params.governor ?? params.governorSessionId ?? params.mission ?? params.missionId) === 'string'
				? String(params.governor ?? params.governorSessionId ?? params.mission ?? params.missionId).trim()
				: '';
			const filtered = visibleScope.filter(item => {
				if (!includeResolved && item.resolved) { return false; }
				if (unreadOnly && !item.unread) { return false; }
				if (govFilter && item.governorSessionId !== govFilter) { return false; }
				return true;
			});
			return { handled: true, result: { headless: true, count: filtered.length, unreadCount: visibleScope.filter(i => i.unread && !i.resolved).length, items: filtered } };
		}
		if (action === 'inbox.post') {
			const message = String(params.message ?? params.text ?? '').trim();
			if (!message) {
				return { handled: true, error: 'Message (--message) is required for inbox.post.' };
			}
			const nowTs = Date.now();
			// Verified non-Human/non-Secretary callers MUST NOT spoof `--from` to impersonate another governor/session.
			const fromId = (params._verifiedCaller === true && !isPreHumanOrSec && verifiedCallerSid)
				? verifiedCallerSid
				: String(params.from ?? params.governorSessionId ?? params.missionId ?? verifiedCallerSid ?? 'headless').trim();
			const title = String(params.title ?? 'ADE Inbox Notice').trim();
			const severity = params.severity === 'critical' || params.severity === 'gate' || params.severity === 'info' ? params.severity : 'info';
			const item: IAdeInboxItem = {
				id: `headless-inb-${fromId}-${nowTs}-${host.nextTmpSeq()}`,
				kind: 'governor_message',
				treeType: 'engineering',
				governorSessionId: fromId,
				governorLabel: (params._verifiedCaller === true && !isPreHumanOrSec && verifiedCallerSid) ? verifiedCallerSid : String(params.fromLabel ?? fromId),
				projectPath: String(params.projectPath ?? ''),
				projectName: String(params.projectName ?? fromId),
				...(typeof params.nodeId === 'string' && params.nodeId.trim() ? { nodeId: params.nodeId.trim() } : {}),
				title,
				message,
				severity,
				...(verifiedCallerSid ? { senderAgentId: verifiedCallerSid } : {}),
				createdAt: nowTs,
				unread: true,
				resolved: false,
			};
			await host.mutateInbox({ kind: 'upsert', item });
			return { handled: true, result: { ...item, headless: true, ok: true, item } };
		}
		if (action === 'inbox.markRead') {
			const allowedGovernors = await resolveAuthorizedInboxGovernors();
			const id = params.all === true ? undefined : (typeof params.id === 'string' && params.id.trim() ? params.id.trim() : undefined);
			if (allowedGovernors) {
				const existingItems = await host.loadInbox();
				if (id) {
					const targetItem = existingItems.find(i => i.id === id);
					if (!targetItem) {
						return { handled: true, error: `Inbox item "${id}" not found.` };
					}
					if (!allowedGovernors.has(targetItem.governorSessionId)) {
						return { handled: true, error: `FORBIDDEN: caller lacks authority to mark inbox item "${id}" belonging to another tenant as read.` };
					}
					const next = await host.mutateInbox({ kind: 'markRead', id });
					return { handled: true, result: { headless: true, ok: true, unreadCount: next.filter(i => allowedGovernors.has(i.governorSessionId) && i.unread && !i.resolved).length } };
				}
				const authorizedUnreadIds = existingItems
					.filter(i => allowedGovernors.has(i.governorSessionId) && i.unread)
					.map(i => i.id);
				let latest = existingItems;
				for (const itemId of authorizedUnreadIds) {
					latest = await host.mutateInbox({ kind: 'markRead', id: itemId });
				}
				return { handled: true, result: { headless: true, ok: true, unreadCount: latest.filter(i => allowedGovernors.has(i.governorSessionId) && i.unread && !i.resolved).length } };
			}
			const next = await host.mutateInbox({ kind: 'markRead', ...(id ? { id } : {}) });
			return { handled: true, result: { headless: true, ok: true, unreadCount: next.filter(i => i.unread && !i.resolved).length } };
		}
		const resolveId = String(params.id ?? '').trim();
		if (!resolveId) {
			return { handled: true, error: 'Inbox item ID (--id) is required for inbox.resolve.' };
		}
		const allowedGovernors = await resolveAuthorizedInboxGovernors();
		const existingItems = await host.loadInbox();
		const targetItem = existingItems.find(i => i.id === resolveId);
		if (!targetItem) {
			return { handled: true, error: `Inbox item "${resolveId}" not found.` };
		}
		if (allowedGovernors && !allowedGovernors.has(targetItem.governorSessionId)) {
			return { handled: true, error: `FORBIDDEN: caller lacks authority to resolve inbox item "${resolveId}" belonging to another tenant.` };
		}
		const isHumanCaller = !params._verifiedCaller && (!rawCallerPre || rawCallerPre === 'human' || rawCallerPre === 'user' || rawCallerPre === 'l-1');
		if (targetItem.kind === 'user_gate' && !isHumanCaller) {
			return { handled: true, error: `FORBIDDEN: Inbox item "${resolveId}" is a Human Approval Gate (user_gate) and may only be resolved by the Human User (L-1).` };
		}
		const next = await host.mutateInbox({
			kind: 'resolve',
			id: resolveId,
			resolution: typeof params.resolution === 'string' ? params.resolution : undefined,
			resolvedAt: Date.now(),
		});
		const item = next.find(i => i.id === resolveId);
		if (!item) {
			return { handled: true, error: `Inbox item "${resolveId}" not found.` };
		}
		return { handled: true, result: { ...item, headless: true, ok: true, item } };
	}

	if (action === 'host.list' || action === 'host.get' || action === 'host.info' || action === 'host.test' || action === 'host.browse') {
		if (!host.cloudHostService) {
			return { handled: false };
		}
		if (action === 'host.list') {
			const hosts = await host.cloudHostService.listHosts();
			return { handled: true, result: { headless: true, count: hosts.length, hosts } };
		}
		const target = String(params.alias ?? params.host ?? params.id ?? params.target ?? '').trim();
		if (!target) {
			return { handled: true, error: `Host alias is required for ${action}.` };
		}
		if (action === 'host.get' || action === 'host.info') {
			const found = await host.cloudHostService.getHost(target);
			if (!found) {
				return { handled: true, error: `Cloud host "${target}" not found.` };
			}
			return { handled: true, result: { headless: true, host: found } };
		}
		if (action === 'host.test') {
			const check = await host.cloudHostService.testConnection(target);
			return { handled: true, result: { headless: true, ...check } };
		}
		const foundHost = await host.cloudHostService.getHost(target);
		const browsePath = typeof params.path === 'string' && params.path.trim()
			? params.path.trim()
			: (foundHost?.defaultDirectory?.trim() || '/');
		const entries = await host.cloudHostService.remoteReadDir(target, browsePath);
		return { handled: true, result: { headless: true, alias: target, path: browsePath, entries } };
	}

	if (action === 'mission.list') {
		const index = await host.getParsedMissionIndex();
		const projectFilter = typeof params.project === 'string' && params.project.trim() ? params.project.trim().toLowerCase() : '';
		const isVerified = params._verifiedCaller === true;
		const isGlobal = !isVerified || isVerifiedSec;
		const missions: Array<Record<string, unknown>> = [];
		for (const entry of index.values()) {
			if (!isGlobal && !isExplicitMissionMemberOrSupervisor({
				missionId: entry.id,
				callerSessionId: verifiedCallerSid,
				ownerSessionId: entry.ownerSessionId,
				supervisorIds: entry.supervisorIds,
				nodeAssignmentAgentIds: entry.nodeAssignmentAgentIds,
				orchNodeAgentIds: entry.nodeAgentIds,
			})) {
				continue;
			}
			const projUri = entry.projectUri ?? '';
			if (projectFilter && !projUri.toLowerCase().includes(projectFilter)) {
				continue;
			}
			missions.push({
				id: entry.id,
				title: entry.title,
				...(projUri ? { projectUri: projUri } : {}),
				...(entry.ownerSessionId ? { ownerSessionId: entry.ownerSessionId } : {}),
				status: entry.orchStatus ?? 'idle',
				activeTokenCount: entry.activeTokenCount,
				updatedAt: entry.updatedAt,
			});
		}
		return { handled: true, result: missions };
	}

	if (action === 'docs.read' || action === 'rank.docs' || action === 'mission.docs' || action === 'rank.list' || action === 'rank.names' || action === 'rank.get' || action === 'whoami') {
		const config = preConfig;
		const docs = buildAdeDocsPaths(host.baseDir, config.ranks.length);
		if (action === 'rank.docs') {
			await host.syncApiDocs(config).catch(() => undefined);
			const rawTarget = typeof params.target === 'string' ? params.target.trim() : undefined;
			if (!rawTarget) {
				return { handled: true, result: docs };
			}
			const parsedKey = normalizeAdeDocTargetKey(rawTarget);
			if (parsedKey?.kind === 'common') {
				return { handled: true, result: { target: 'common', docPath: docs.commonDoc, docsRoot: docs.docsRoot, commonDir: docs.commonDir } };
			}
			if (parsedKey?.kind === 'engineering-paradigm') {
				return { handled: true, result: { target: 'engineering', docPath: docs.engineeringParadigmDoc, docsRoot: docs.docsRoot, engineeringDir: docs.engineeringDir } };
			}
			if (parsedKey?.kind === 'engineering-api') {
				return { handled: true, result: { target: 'engineering-api', docPath: docs.engineeringApiDoc, docsRoot: docs.docsRoot, engineeringDir: docs.engineeringDir } };
			}
			if (parsedKey?.kind === 'mission') {
				return { handled: true, result: { target: 'mission', docPath: docs.missionDoc, docsRoot: docs.docsRoot, missionDir: docs.missionDir } };
			}
			if (parsedKey?.kind === 'manifest') {
				return { handled: true, result: { target: 'manifest', docPath: docs.manifestFile, docsRoot: docs.docsRoot } };
			}
			const tierNum = parseTierNumber(rawTarget);
			if (tierNum === 0 || rawTarget.toLowerCase() === 'secretary') {
				return { handled: true, result: { target: ADE_SECRETARY_TIER_TAG, docPath: docs.rankDocs[ADE_SECRETARY_TIER_TAG], docsRoot: docs.docsRoot, ranksDir: docs.ranksDir } };
			}
			const matched = findRankByTierOrId(config, rawTarget);
			const tag = matched ? formatTierTag(matched.tier) : (tierNum !== undefined ? formatTierTag(tierNum) : undefined);
			if (!tag || !docs.rankDocs[tag]) {
				return { handled: true, error: `Rank doc not found for: ${rawTarget}` };
			}
			return { handled: true, result: { target: tag, docPath: docs.rankDocs[tag], docsRoot: docs.docsRoot, ranksDir: docs.ranksDir } };
		}
		if (action === 'mission.docs') {
			await host.syncApiDocs(config).catch(() => undefined);
			return {
				handled: true,
				result: {
					missionDoc: docs.missionDoc,
					missionDir: docs.missionDir,
					engineeringDir: docs.engineeringDir,
					engineeringParadigmDoc: docs.engineeringParadigmDoc,
					engineeringApiDoc: docs.engineeringApiDoc,
					commonDoc: docs.commonDoc,
					manifestFile: docs.manifestFile,
					docsRoot: docs.docsRoot,
					ranksDir: docs.ranksDir,
				},
			};
		}
		if (action === 'docs.read') {
			const rawTarget = String(params.target ?? params.doc ?? params.tier ?? 'common').trim() || 'common';
			const parsedKey = normalizeAdeDocTargetKey(rawTarget);
			let canonicalTarget = parsedKey?.canonicalTarget ?? rawTarget;
			if (!parsedKey) {
				const parsedTier = parseTierNumber(rawTarget);
				if (parsedTier !== undefined && parsedTier >= 0) {
					canonicalTarget = formatTierTag(parsedTier);
				} else if (/^secretary$/i.test(rawTarget)) {
					canonicalTarget = ADE_SECRETARY_TIER_TAG;
				} else {
					const matchedRank = findRankByTierOrId(config, rawTarget);
					if (matchedRank) {
						canonicalTarget = formatTierTag(matchedRank.tier);
					}
				}
			}
			const docRes = await host.readApiDoc(canonicalTarget, config);
			if (!docRes.ok) {
				return { handled: true, error: docRes.error ?? `API doc not found: ${rawTarget}` };
			}
			return { handled: true, result: docRes };
		}
		if (action === 'rank.list') {
			return { handled: true, result: buildLiveRankDirectory(config, docs) };
		}
		if (action === 'rank.names') {
			const dir = buildLiveRankDirectory(config, docs);
			return {
				handled: true,
				result: {
					rankCount: dir.rankCount,
					presetId: dir.presetId,
					missionName: dir.missionName,
					namesByTier: dir.namesByTier,
					tierByAlias: dir.tierByAlias,
				},
			};
		}
		if (action === 'rank.get') {
			const rawTarget = params.tier ?? params.rank ?? params.id ?? params.target;
			const dir = buildLiveRankDirectory(config, docs);
			const tierNum = parseTierNumber(rawTarget as string | number | undefined);
			const rawLower = typeof rawTarget === 'string' ? rawTarget.trim().toLowerCase() : '';
			if (tierNum === -1 || rawLower === 'user' || rawLower === 'human') {
				return { handled: true, result: dir.ranks.find(r => r.tier === -1) };
			}
			if (tierNum === 0 || rawLower === 'secretary') {
				return { handled: true, result: dir.ranks.find(r => r.tier === 0) };
			}
			const matched = findRankByTierOrId(config, rawTarget as string | number | undefined);
			if (!matched) {
				return { handled: true, error: `Rank not found: ${String(rawTarget ?? '')}` };
			}
			return { handled: true, result: dir.ranks.find(r => r.id === matched.id) };
		}
		// whoami
		const buildDocsEntry = (selfTierTag: string) => ({
			common: 'aexus-ade docs read common',
			selfRank: `aexus-ade docs read ${selfTierTag}`,
			engineeringParadigm: 'aexus-ade docs read engineering',
			engineeringApi: 'aexus-ade docs read engineering-api',
			mission: 'aexus-ade docs read mission',
			update: 'aexus-ade api update --since 0 --json',
			docsRoot: docs.docsRoot,
			ranksDir: docs.ranksDir,
			...(docs.engineeringDir ? { engineeringDir: docs.engineeringDir } : {}),
		});
		const isVerified = params._verifiedCaller === true;
		const callerStr = typeof params.caller === 'string' ? params.caller.trim().toLowerCase() : '';
		const sid = (isVerified && typeof params._callerSessionId === 'string' ? params._callerSessionId.trim() : '')
			|| (!isVerified && typeof params.callerSessionId === 'string' ? params.callerSessionId.trim() : '');
		if (!isVerified && !callerStr && !sid) {
			return {
				handled: true,
				result: {
					headless: true,
					id: 'human',
					tier: ADE_USER_TIER,
					tierTag: 'L-1',
					rankId: 'user',
					factorySide: 'off_graph',
					latestApiRevision: ADE_API_LATEST_REVISION,
					docsEntry: buildDocsEntry('L0'),
				},
			};
		}
		if (
			((callerStr === 'secretary' || callerStr === 'l0') && (!isVerified || sid === HEADLESS_SECRETARY_ID || sid === 'ade-secretary'))
			|| sid === HEADLESS_SECRETARY_ID
			|| sid === 'ade-secretary'
		) {
			return {
				handled: true,
				result: {
					headless: true,
					id: HEADLESS_SECRETARY_ID,
					tier: ADE_SECRETARY_TIER,
					tierTag: ADE_SECRETARY_TIER_TAG,
					rankId: 'secretary',
					factorySide: 'off_graph',
					latestApiRevision: ADE_API_LATEST_REVISION,
					docsEntry: buildDocsEntry('L0'),
				},
			};
		}
		let matchedMissionId: string | undefined;
		const nodeIds: string[] = [];
		const managedNodeIds: string[] = [];
		let department: string | undefined;
		let staffTier: number | undefined;
		let staffLabel: string | undefined;
		let isOrchestrationStaff = false;
		const currentTokens: Array<{ id: string; missionId: string; nodeId: string; waveId: string; status: string }> = [];
		if (sid) {
			const index = await host.getParsedMissionIndex();
			for (const entry of index.values()) {
				const boundNids = Object.entries(entry.nodeAgentIds)
					.filter(([, aid]) => aid === sid)
					.map(([nid]) => nid);
				if (entry.ownerSessionId !== sid && boundNids.length === 0) {
					continue;
				}
				matchedMissionId ??= entry.id;
				const raw = await host.loadMissionRecord(entry.id);
				if (!raw) {
					continue;
				}
				try {
					const rec = JSON.parse(raw) as { orchestrationText?: string; orchestrationRuntime?: IOrchestrationRuntimeState };
					const recOrch = rec.orchestrationRuntime;
					if (boundNids.length > 0) {
						isOrchestrationStaff = true;
						const pg = parseOrchestrationGraph(rec.orchestrationText ?? '');
						for (const nid of boundNids) {
							if (!nodeIds.includes(nid)) { nodeIds.push(nid); }
							const sn = pg.nodes.find(n => n.id === nid && n.kind === 'staff');
							if (sn) {
								department ??= sn.department;
								staffLabel ??= sn.label;
								staffTier ??= resolveEffectiveStaffTier(sn, config);
								const myTier = resolveEffectiveStaffTier(sn, config);
								for (const edge of pg.edges) {
									if (edge.from === nid) {
										const target = pg.nodes.find(n => n.id === edge.to && n.kind === 'staff');
										const tTier = target ? resolveEffectiveStaffTier(target, config) : undefined;
										if (target && myTier !== undefined && tTier !== undefined && tTier > myTier && !managedNodeIds.includes(target.id)) {
											managedNodeIds.push(target.id);
										}
									}
								}
							}
						}
					}
					for (const tok of Object.values(recOrch?.tokens ?? {})) {
						if ((tok.status === 'active' || tok.status === 'blocked' || tok.status === 'waiting_join') && (tok.holderAgentId === sid || boundNids.includes(tok.nodeId))) {
							currentTokens.push({ id: tok.id, missionId: entry.id, nodeId: tok.nodeId, waveId: tok.waveId, status: tok.status });
						}
					}
				} catch {
					// skip malformed cold record
				}
			}
		}
		const parsedCallerTier = parseTierNumber(callerStr);
		const rankDef = staffTier !== undefined
			? (config.ranks.find(r => r.tier === staffTier) ?? resolveEffectiveRankDefinition(config, callerStr, false))
			: (parsedCallerTier !== undefined
				? (config.ranks.find(r => r.tier === parsedCallerTier) ?? resolveEffectiveRankDefinition(config, callerStr, false))
				: resolveEffectiveRankDefinition(config, callerStr, false));
		const effectiveTier = staffTier ?? rankDef.tier;
		const tierTag = formatTierTag(effectiveTier);
		const supervisoryTiers = config.ranks.filter(r => !r.pureExecution && r.canHaveSubordinates).map(r => r.tier);
		const offGraphMax = supervisoryTiers.length > 0 ? Math.min(...supervisoryTiers) : Math.max(0, Math.min(1, config.ranks.length - 1));
		return {
			handled: true,
			result: {
				headless: true,
				id: sid || 'unknown',
				...(staffLabel ? { label: staffLabel } : {}),
				tier: effectiveTier,
				tierTag,
				rankId: rankDef.id,
				factorySide: classifyTierFactorySide(effectiveTier, offGraphMax),
				...(isOrchestrationStaff ? { isOrchestrationStaff: true } : {}),
				...(department ? { department } : {}),
				...(matchedMissionId ? { missionId: matchedMissionId, nodeIds } : {}),
				...(managedNodeIds.length > 0 ? { managedNodeIds } : {}),
				currentTokenIds: currentTokens.map(t => t.id),
				currentTokens,
				latestApiRevision: ADE_API_LATEST_REVISION,
				docsEntry: buildDocsEntry(tierTag),
			},
		};
	}

	if (action === 'mission.blueprint.validate' && typeof params.text === 'string' && params.text.trim()) {
		const parsedDual = parseDualViewBlueprintMarkdown(params.text);
		const dag = parseMissionMermaidDag(parsedDual.mermaidText);
		const orchRes = parsedDual.orchestrationText ? parseOrchestrationGraph(parsedDual.orchestrationText) : undefined;
		const errors: string[] = [];
		if (dag.error) { errors.push(dag.error); }
		if (orchRes?.error) { errors.push(orchRes.error); }
		return {
			handled: true,
			result: {
				headless: true,
				valid: errors.length === 0,
				errors,
				nodeCount: dag.nodes.length,
				edgeCount: dag.edges.length,
				...(orchRes ? { staffCount: orchRes.nodes.filter(n => n.kind === 'staff').length } : {}),
			},
		};
	}

	if (action === 'orchestration.validate' && (params.manifest !== undefined || (typeof params.text === 'string' && params.text.trim()))) {
		if (params.manifest !== undefined) {
			const val = validateOrchestrationManifest(params.manifest);
			return {
				handled: true,
				result: {
					headless: true,
					valid: val.valid,
					errors: val.errors,
					warnings: val.warnings,
					...(val.manifest ? {
						staffCount: val.manifest.staff.length,
						whiteboardCount: val.manifest.whiteboards?.length ?? 0,
						edgeCount: val.manifest.edges?.length ?? 0,
					} : {}),
				},
			};
		}
		const parsed = parseOrchestrationGraph(String(params.text));
		return {
			handled: true,
			result: {
				headless: true,
				valid: !parsed.error,
				...(parsed.error ? { errors: [parsed.error], error: parsed.error } : { errors: [] }),
				staffCount: parsed.nodes.filter(n => n.kind === 'staff').length,
				whiteboardCount: parsed.nodes.filter(n => n.kind === 'whiteboard').length,
				edgeCount: parsed.edges.length,
			},
		};
	}

	return undefined;
}

/**
 * Resolves the target Mission ID via O(1) parsed mission index cache (avoiding full-file JSON parsing).
 */
export async function resolveHeadlessMissionId(
	host: IAdeHeadlessBackendHost,
	action: string,
	params: Readonly<Record<string, unknown>>,
): Promise<{ readonly missionId?: string; readonly earlyResult?: IAdeHeadlessControlResult }> {
	const explicitId = typeof params.missionId === 'string' && params.missionId.trim()
		? params.missionId.trim()
		: (typeof params.mission === 'string' && params.mission.trim()
			? params.mission.trim()
			: (typeof params.id === 'string' && params.id.trim() && (action.startsWith('mission.') || action.startsWith('orchestration.')) ? params.id.trim() : ''));
	if (explicitId) {
		return { missionId: explicitId };
	}
	if (action === 'orchestration.status') {
		const daemonState = await host.getOrchestrationDaemonState();
		return { earlyResult: { handled: true, result: { headless: true, daemonMissions: daemonState } } };
	}
	const index = await host.getParsedMissionIndex();
	const lookupTokenId = typeof (params.tokenId ?? params.token ?? params.parentTokenId) === 'string'
		? String(params.tokenId ?? params.token ?? params.parentTokenId).trim()
		: '';
	const lookupTracePtr = typeof (params.tracePtr ?? params.ptr ?? params.trace) === 'string'
		? String(params.tracePtr ?? params.ptr ?? params.trace).trim()
		: '';
	const verifiedSid = params._verifiedCaller === true && typeof params._callerSessionId === 'string'
		? params._callerSessionId.trim()
		: '';
	const candidateIds: string[] = [];
	for (const entry of index.values()) {
		if (lookupTokenId && entry.tokenIds.has(lookupTokenId)) {
			return { missionId: entry.id };
		}
		if (lookupTracePtr && entry.tracePtrs.has(lookupTracePtr)) {
			return { missionId: entry.id };
		}
		if (verifiedSid) {
			const isMember = entry.ownerSessionId === verifiedSid
				|| Object.values(entry.nodeAgentIds).includes(verifiedSid)
				|| entry.supervisorIds.includes(verifiedSid)
				|| entry.nodeAssignmentAgentIds.includes(verifiedSid);
			if (isMember) {
				candidateIds.push(entry.id);
			}
		}
	}
	if (candidateIds.length === 1) {
		return { missionId: candidateIds[0] };
	}
	if (!verifiedSid && index.size === 1) {
		const sole = index.keys().next().value;
		if (sole) {
			return { missionId: sole };
		}
	}
	return { earlyResult: { handled: true, error: `Missing --mission <id> for headless "${action}".` } };
}

/**
 * Checks mission-scoped verified-caller RBAC using the canonical policy sets from `adeControlPolicy.ts`.
 */
export function checkHeadlessMissionRbac(ctx: IHeadlessMissionScopeContext): string | undefined {
	const { action, params, effectiveOrgConfig, record, parsedGraph, caller } = ctx;
	if (params._verifiedCaller !== true || caller.isHumanUser || caller.isSecretary) {
		return undefined;
	}
	const rawCallerStr = typeof params.caller === 'string' ? params.caller.trim().toLowerCase() : '';
	const callerNode = caller.callerNodeId
		? parsedGraph.nodes.find(n => n.id === caller.callerNodeId && n.kind === 'staff')
		: undefined;
	const liveRankCandidate = callerNode?.rankId || (caller.callerTier !== undefined ? `L${caller.callerTier}` : rawCallerStr);
	const liveRankDef = resolveEffectiveRankDefinition(effectiveOrgConfig, liveRankCandidate || rawCallerStr, false);
	const isMember = ctx.isMissionMember(caller);
	const ownerSid = typeof record.ownerSessionId === 'string' ? record.ownerSessionId.trim() : '';
	const isOwner = Boolean(ownerSid && caller.callerSessionId && ownerSid === caller.callerSessionId);
	const highestTier = effectiveOrgConfig.ranks.length > 0 ? Math.min(...effectiveOrgConfig.ranks.map(r => r.tier)) : 1;
	const isTopRank = isMember && caller.callerTier !== undefined && caller.callerTier <= highestTier;
	const isReadOnlyLimits = action === 'orchestration.limits'
		&& parseOrchestrationLimitsRequest(params, { isHumanUser: false }).isReadOnlyQuery === true;

	const allowedByUniversal = isMember && (ADE_IN_GRAPH_UNIVERSAL_ACTIONS.has(action) || isReadOnlyLimits);
	const allowedByPartialSup = isMember && !liveRankDef.pureExecution && liveRankDef.canHaveSubordinates && ADE_PARTIAL_SUPERVISOR_MISSION_ACTIONS.has(action);
	const allowedByFullSup = (isOwner || isTopRank) && (ADE_FULL_SUPERVISOR_MISSION_ACTIONS.has(action) || ADE_PARTIAL_SUPERVISOR_MISSION_ACTIONS.has(action));
	if (!allowedByUniversal && !allowedByPartialSup && !allowedByFullSup) {
		const perm = checkAdeApiPermission(effectiveOrgConfig, liveRankDef.id, action);
		if (!perm.allowed) {
			return `FORBIDDEN: ${perm.reason ?? `Permission denied for action "${action}".`}`;
		}
	}
	return undefined;
}

export function canHeadlessCallerOperateMission(
	record: Record<string, unknown>,
	parsedGraph: IOrchestrationGraphParseResult,
	config: IAdeOrganizationConfig,
	caller: IHeadlessCaller,
): boolean {
	if (caller.isHumanUser) {
		return true;
	}
	const ownerSid = typeof record.ownerSessionId === 'string' && record.ownerSessionId.trim()
		? record.ownerSessionId.trim()
		: (typeof record.linkedSessionId === 'string' && record.linkedSessionId.trim() ? record.linkedSessionId.trim() : undefined);
	const ownerTier = typeof record.ownerTier === 'number' && Number.isFinite(record.ownerTier)
		? Math.floor(record.ownerTier)
		: (ownerSid === HEADLESS_SECRETARY_ID ? 0 : ownerSid ? 1 : ADE_USER_TIER);
	const highestNode = findHighestRankStaffNode(parsedGraph);
	const highestTier = config.ranks.length > 0 ? Math.min(...config.ranks.map(r => r.tier)) : 1;
	const isTopRankStaff = Boolean(
		caller.callerNodeId
		&& parsedGraph.nodes.some(n => n.id === caller.callerNodeId && n.kind === 'staff')
		&& ((highestNode && highestNode.id === caller.callerNodeId) || (caller.callerTier !== undefined && caller.callerTier <= highestTier)),
	);
	const hasOrchText = typeof record.orchestrationText === 'string' && record.orchestrationText.trim().length > 0;
	if (isTopRankStaff && hasOrchText) {
		if (!ownerSid || ownerTier <= ADE_USER_TIER || (caller.callerSessionId && caller.callerSessionId === ownerSid)) {
			return true;
		}
	}
	if (ownerTier <= ADE_USER_TIER || !ownerSid) {
		return false;
	}
	if (caller.isSecretary) {
		return ownerSid === HEADLESS_SECRETARY_ID;
	}
	return Boolean(caller.callerSessionId && caller.callerSessionId === ownerSid);
}

/**
 * Handles all read/inspection/diagnostics/dry-run/checkpoint-read mission-scoped headless actions.
 * Returns `undefined` if `action` belongs to the mutating handler.
 */
export async function tryExecuteHeadlessMissionReadAction(
	ctx: IHeadlessMissionScopeContext,
): Promise<IAdeHeadlessControlResult | undefined> {
	const { host, missionId, action, params, effectiveOrgConfig, record, orch, orchestrationText, parsedGraph, caller } = ctx;

	if (action === 'mission.get' || action === 'mission.blueprint.get' || action === 'mission.blueprint.validate' || action === 'mission.export') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
		const taskGraph = parseMissionMermaidDag(mermaidText);
		if (action === 'mission.blueprint.validate') {
			const rawText = typeof params.text === 'string' && params.text.trim() ? params.text : mermaidText;
			const parsedDual = parseDualViewBlueprintMarkdown(rawText);
			const dag = parseMissionMermaidDag(parsedDual.mermaidText);
			const orchRes = parsedDual.orchestrationText ? parseOrchestrationGraph(parsedDual.orchestrationText) : undefined;
			const errors: string[] = [];
			if (dag.error) { errors.push(dag.error); }
			if (orchRes?.error) { errors.push(orchRes.error); }
			return { handled: true, result: { headless: true, missionId, valid: errors.length === 0, errors, nodeCount: dag.nodes.length, edgeCount: dag.edges.length } };
		}
		if (action === 'mission.blueprint.get') {
			if (params.raw === true) {
				return { handled: true, result: mermaidText };
			}
			return {
				handled: true,
				result: {
					headless: true,
					missionId,
					title: typeof record.title === 'string' ? record.title : missionId,
					mermaidText,
					nodeCount: taskGraph.nodes.length,
					edgeCount: taskGraph.edges.length,
					...(taskGraph.error ? { error: taskGraph.error } : {}),
				},
			};
		}
		if (action === 'mission.export') {
			const { visible, safeOrchText } = ctx.filterWhiteboardsForCaller();
			const format = typeof params.format === 'string' ? params.format.trim().toLowerCase() : 'json';
			const nodePrompts = (record.nodePrompts ?? {}) as Readonly<Record<string, string>>;
			if (format === 'markdown' || format === 'md') {
				const lines = [
					`# ${typeof record.title === 'string' ? record.title : missionId}`,
					'',
					'## Mission Task DAG',
					'```mermaid',
					mermaidText,
					'```',
				];
				if (safeOrchText.trim()) {
					lines.push('', '## Orchestration Team', '```mermaid', safeOrchText, '```');
				}
				const promptEntries = Object.entries(nodePrompts).filter(([, body]) => Boolean(body?.trim()));
				if (promptEntries.length > 0) {
					lines.push('', '## Task Specifications');
					for (const [nid, body] of promptEntries) {
						lines.push('', `### ${nid}`, body.trim());
					}
				}
				return { handled: true, result: { headless: true, format: 'markdown', missionId, content: lines.join('\n') } };
			}
			return {
				handled: true,
				result: {
					headless: true,
					schemaVersion: 1,
					exportedAt: Date.now(),
					missionId,
					id: missionId,
					title: typeof record.title === 'string' ? record.title : missionId,
					mermaidText,
					orchestrationText: safeOrchText,
					orchestrationLayoutMode: record.orchestrationLayoutMode ?? parsedGraph.layoutMode,
					nodePrompts,
					taskStatuses: record.taskStatuses ?? {},
					whiteboards: Object.fromEntries(visible.map(w => [w.id, w])),
				},
			};
		}
		return {
			handled: true,
			result: {
				headless: true,
				id: missionId,
				title: typeof record.title === 'string' ? record.title : missionId,
				...(typeof record.projectUri === 'string' ? { projectUri: record.projectUri } : {}),
				...(typeof record.ownerSessionId === 'string' ? { ownerSessionId: record.ownerSessionId } : {}),
				taskCount: taskGraph.nodes.length,
				staffCount: parsedGraph.nodes.filter(n => n.kind === 'staff').length,
				status: orch?.status ?? 'idle',
				updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
			},
		};
	}

	if (action === 'mission.diagnostics') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		return {
			handled: true,
			result: computeHeadlessMissionDiagnostics(missionId, record, parsedGraph, Date.now()),
		};
	}

	if (action === 'mission.checkpoint.list' || action === 'orchestration.checkpoint.list') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		const checkpoints = await host.listMissionCheckpoints(missionId);
		return {
			handled: true,
			result: {
				headless: true,
				ok: true,
				missionId,
				count: checkpoints.length,
				checkpoints,
			},
		};
	}

	if (action === 'mission.checkpoint.diff' || action === 'orchestration.checkpoint.diff') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		const fromId = String(params.from ?? params.checkpointId ?? params.id ?? '').trim();
		if (!fromId) {
			return { handled: true, error: 'Checkpoint ID (--id / --from) is required for mission.checkpoint.diff.' };
		}
		const rawFrom = await host.loadMissionCheckpoint(missionId, fromId);
		if (!rawFrom) {
			return { handled: true, error: `Checkpoint "${fromId}" not found for Mission "${missionId}".` };
		}
		const fromBundle = parseUnifiedMissionCheckpointBundle(rawFrom);
		if (!fromBundle) {
			return { handled: true, error: `Checkpoint "${fromId}" payload is malformed.` };
		}
		const fromSnapshot: Record<string, unknown> = {
			...(fromBundle.mermaidText !== undefined ? { mermaidText: fromBundle.mermaidText } : {}),
			...(fromBundle.orchestrationText !== undefined ? { orchestrationText: fromBundle.orchestrationText } : {}),
			...(fromBundle.taskStatuses ? { taskStatuses: fromBundle.taskStatuses } : {}),
			...(fromBundle.whiteboards ? { whiteboards: fromBundle.whiteboards } : {}),
		};
		const fromCkptSnap = fromBundle.checkpointSnapshot;
		const rawToId = params.to ?? params.againstCheckpointId;
		const toId = typeof rawToId === 'string' && rawToId.trim() ? rawToId.trim() : undefined;
		let toSnapshot: Record<string, unknown> = record;
		let toCkptSnap: IOrchestrationCheckpointSnapshot | undefined;
		if (toId) {
			const rawTo = await host.loadMissionCheckpoint(missionId, toId);
			if (!rawTo) {
				return { handled: true, error: `Target checkpoint "${toId}" not found for Mission "${missionId}".` };
			}
			const toBundle = parseUnifiedMissionCheckpointBundle(rawTo);
			if (!toBundle) {
				return { handled: true, error: `Target checkpoint "${toId}" payload is malformed.` };
			}
			toSnapshot = {
				...(toBundle.mermaidText !== undefined ? { mermaidText: toBundle.mermaidText } : {}),
				...(toBundle.orchestrationText !== undefined ? { orchestrationText: toBundle.orchestrationText } : {}),
				...(toBundle.taskStatuses ? { taskStatuses: toBundle.taskStatuses } : {}),
				...(toBundle.whiteboards ? { whiteboards: toBundle.whiteboards } : {}),
			};
			toCkptSnap = toBundle.checkpointSnapshot;
		}
		return {
			handled: true,
			result: {
				headless: true,
				ok: true,
				missionId,
				fromCheckpointId: fromId,
				toCheckpointId: toId ?? 'live',
				diff: computeHeadlessCheckpointDiff(fromSnapshot, toSnapshot, {
					baseSnapshot: fromCkptSnap,
					targetSnapshot: toCkptSnap,
					fromId,
					toId: toId ?? 'live',
				}),
			},
		};
	}

	if (action === 'orchestration.get' || action === 'orchestration.export' || action === 'orchestration.validate' || action === 'orchestration.group.list') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		if (action === 'orchestration.validate') {
			return {
				handled: true,
				result: {
					headless: true,
					missionId,
					valid: !parsedGraph.error,
					...(parsedGraph.error ? { errors: [parsedGraph.error], error: parsedGraph.error } : { errors: [] }),
					staffCount: parsedGraph.nodes.filter(n => n.kind === 'staff').length,
					whiteboardCount: parsedGraph.nodes.filter(n => n.kind === 'whiteboard').length,
					edgeCount: parsedGraph.edges.length,
				},
			};
		}
		if (action === 'orchestration.group.list') {
			return {
				handled: true,
				result: {
					headless: true,
					missionId,
					groups: parsedGraph.departments ?? [],
				},
			};
		}
		const { visible, allowedIds, safeOrchText } = ctx.filterWhiteboardsForCaller();
		if (action === 'orchestration.export') {
			const format = typeof params.format === 'string' ? params.format.trim().toLowerCase() : 'mermaid';
			const wbMap: Record<string, IOrchestrationWhiteboard> = Object.fromEntries(visible.map(w => [w.id, w]));
			if (format === 'json' || format === 'manifest') {
				const title = typeof record.title === 'string' ? record.title : missionId;
				const manifest = exportToOrchestrationManifest({
					name: title,
					orchestrationText: safeOrchText,
					whiteboards: wbMap,
					mermaidText: typeof record.mermaidText === 'string' ? record.mermaidText : undefined,
					nodePrompts: record.nodePrompts as Readonly<Record<string, string>> | undefined,
					nodeChecks: record.nodeChecks as Readonly<Record<string, readonly IMissionNodeCheckHook[]>> | undefined,
				});
				if (params.raw === true) {
					return { handled: true, result: JSON.stringify(manifest, null, 2) };
				}
				return {
					handled: true,
					result: {
						headless: true,
						missionId,
						title,
						format: 'json',
						manifest,
					},
				};
			}
			const withPositions = params.withPositions === true;
			const includeAgentIds = params.includeAgentIds === true;
			const serialized = serializeOrchestrationGraph({
				direction: parsedGraph.direction,
				layoutMode: (record.orchestrationLayoutMode as typeof parsedGraph.layoutMode | undefined) ?? parsedGraph.layoutMode,
				departments: parsedGraph.departments,
				nodes: parsedGraph.nodes,
				edges: parsedGraph.edges,
				whiteboards: wbMap,
				positions: withPositions ? ((record.orchestrationPositions as typeof parsedGraph.positions | undefined) ?? parsedGraph.positions) : undefined,
				includeAgentIds,
				allowedWhiteboardIds: (caller.isHumanUser || caller.isSecretary) ? undefined : allowedIds,
			});
			const safeExport = (caller.isHumanUser || caller.isSecretary)
				? serialized
				: stripForeignWhiteboardBodiesFromOrchestrationText(serialized, allowedIds);
			if (params.raw === true) {
				return { handled: true, result: safeExport };
			}
			return {
				handled: true,
				result: {
					headless: true,
					missionId,
					format: 'mermaid',
					layoutMode: record.orchestrationLayoutMode ?? parsedGraph.layoutMode,
					nodeCount: parsedGraph.nodes.length,
					staffCount: parsedGraph.nodes.filter(n => n.kind === 'staff').length,
					whiteboardCount: parsedGraph.nodes.filter(n => n.kind === 'whiteboard').length,
					edgeCount: parsedGraph.edges.length,
					groupCount: parsedGraph.departments.length,
					orchestrationText: safeExport,
				},
			};
		}
		if (params.raw === true) {
			return { handled: true, result: safeOrchText };
		}
		// Security: parse `safeOrchText` for non-Human/non-Secretary callers so `parsed.nodes[].whiteboardContent`
		// and `parsed.whiteboardContents` NEVER leak foreign department whiteboard bodies!
		const safeParsedGraph = (caller.isHumanUser || caller.isSecretary || safeOrchText === orchestrationText)
			? parsedGraph
			: parseOrchestrationGraph(safeOrchText);
		return {
			handled: true,
			result: {
				headless: true,
				missionId,
				title: typeof record.title === 'string' ? record.title : missionId,
				layoutMode: record.orchestrationLayoutMode ?? safeParsedGraph.layoutMode,
				orchestrationText: safeOrchText,
				parsed: safeParsedGraph,
				nodeAgentIds: orch?.nodeAgentIds ?? {},
				nodeStates: orch?.nodeStates ?? {},
				whiteboards: visible,
			},
		};
	}

	if (action === 'mission.task.list' || action === 'mission.task.get') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
		const taskGraph = parseMissionMermaidDag(mermaidText);
		const taskStatuses = (record.taskStatuses ?? {}) as Readonly<Record<string, IMissionTaskStatusRecord>>;
		const nodePrompts = (record.nodePrompts ?? {}) as Readonly<Record<string, string>>;
		if (action === 'mission.task.list') {
			const full = params.full === true || params.verbose === true;
			const tasks = taskGraph.nodes.map(n => {
				const st = taskStatuses[n.id];
				const fullDesc = nodePrompts[n.id] ?? '';
				const desc = (!full && fullDesc.length > 280) ? `${fullDesc.slice(0, 277)}...` : fullDesc;
				return {
					id: n.id,
					title: n.label,
					kind: n.kind,
					description: desc,
					...(!full && fullDesc.length > 280 ? { descriptionTruncated: true, descriptionChars: fullDesc.length } : {}),
					status: st?.status ?? 'pending',
					...(n.ownerNodeId ? { ownerNodeId: n.ownerNodeId } : {}),
					...(st?.assigneeNodeId ?? n.assigneeNodeId ? { assigneeNodeId: st?.assigneeNodeId ?? n.assigneeNodeId } : {}),
					...(st?.assigneeLabel ? { assigneeLabel: st.assigneeLabel } : {}),
					...(n.department ? { department: n.department } : {}),
					...(n.minCompleterTier !== undefined ? { minCompleterTier: n.minCompleterTier } : {}),
					...(n.allowedCompleterNodeIds ? { allowedCompleterNodeIds: n.allowedCompleterNodeIds } : {}),
					...(n.completionContract ? { completionContract: n.completionContract } : {}),
					...(st?.activeTokenIds && st.activeTokenIds.length > 0 ? { activeTokenIds: st.activeTokenIds } : {}),
					...(st?.lastTokenId ? { lastTokenId: st.lastTokenId } : {}),
					...(st?.startedAt !== undefined ? { startedAt: st.startedAt } : {}),
					...(st?.durationMs !== undefined ? { durationMs: st.durationMs } : {}),
					...(st?.artifactPtrs && st.artifactPtrs.length > 0 ? { artifactPtrs: st.artifactPtrs } : {}),
					...(st?.touchedFiles && st.touchedFiles.length > 0 ? { touchedFiles: st.touchedFiles } : {}),
					...(st?.lastCheckReceipt ? { lastCheckReceipt: st.lastCheckReceipt } : {}),
					...(st?.blockedReason ? { blockedReason: st.blockedReason } : {}),
					...(st?.lastError ? { lastError: st.lastError } : {}),
					...(st?.completedBy ? { completedBy: st.completedBy } : {}),
					...(st?.completedByLabel ? { completedByLabel: st.completedByLabel } : {}),
					...(st?.completedAt !== undefined ? { completedAt: st.completedAt } : {}),
					...(st?.note ? { note: st.note } : {}),
					upstreamIds: taskGraph.edges.filter(e => e.to === n.id).map(e => e.from),
					downstreamIds: taskGraph.edges.filter(e => e.from === n.id).map(e => e.to),
				};
			});
			return {
				handled: true,
				result: {
					headless: true,
					missionId,
					title: typeof record.title === 'string' ? record.title : missionId,
					tasks,
					...(taskGraph.error ? { error: taskGraph.error } : {}),
				},
			};
		}
		const nodeId = String(params.node ?? params.nodeId ?? '').trim();
		if (!nodeId) {
			return { handled: true, error: 'Task node ID (--node) is required for mission.task.get.' };
		}
		const node = taskGraph.nodes.find(n => n.id === nodeId);
		if (!node) {
			return { handled: true, error: `Task node "${nodeId}" not found in Mission "${missionId}".` };
		}
		const statusRec = taskStatuses[nodeId];
		return {
			handled: true,
			result: {
				headless: true,
				missionId,
				id: node.id,
				title: node.label,
				kind: node.kind,
				description: nodePrompts[nodeId] ?? '',
				...(node.ownerNodeId ? { ownerNodeId: node.ownerNodeId } : {}),
				...(statusRec?.assigneeNodeId ?? node.assigneeNodeId ? { assigneeNodeId: statusRec?.assigneeNodeId ?? node.assigneeNodeId } : {}),
				...(node.department ? { department: node.department } : {}),
				...(node.minCompleterTier !== undefined ? { minCompleterTier: node.minCompleterTier } : {}),
				...(node.allowedCompleterNodeIds ? { allowedCompleterNodeIds: node.allowedCompleterNodeIds } : {}),
				...(node.completionContract ? { completionContract: node.completionContract } : {}),
				status: statusRec?.status ?? 'pending',
				statusRecord: statusRec,
				upstreamIds: taskGraph.edges.filter(e => e.to === node.id).map(e => e.from),
				downstreamIds: taskGraph.edges.filter(e => e.from === node.id).map(e => e.to),
			},
		};
	}

	if (action === 'mission.check.list' || action === 'mission.check.get' || action === 'mission.check.run') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		if (action === 'mission.check.list') {
			const filterNodeId = typeof (params.node ?? params.nodeId) === 'string' && String(params.node ?? params.nodeId).trim()
				? String(params.node ?? params.nodeId).trim()
				: undefined;
			return {
				handled: true,
				result: { headless: true, missionId, nodeChecks: ctx.collectEffectiveNodeChecks(filterNodeId) },
			};
		}
		const nodeId = String(params.node ?? params.nodeId ?? '').trim();
		if (!nodeId) {
			return { handled: true, error: `Node ID (--node) is required for ${action}.` };
		}
		const checks = ctx.collectEffectiveNodeChecks(nodeId)[nodeId] ?? [];
		if (action === 'mission.check.get') {
			return { handled: true, result: { headless: true, missionId, nodeId, checks } };
		}
		const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
		const taskGraph = mermaidText.trim() ? parseMissionMermaidDag(mermaidText) : undefined;
		const staffNode = !parsedGraph.error ? parsedGraph.nodes.find(n => n.id === nodeId && n.kind === 'staff') : undefined;
		const taskNode = taskGraph && !taskGraph.error ? taskGraph.nodes.find(n => n.id === nodeId) : undefined;
		if (!staffNode && !taskNode) {
			return { handled: true, error: `Node "${nodeId}" not found in Mission "${missionId}".` };
		}
		if (!caller.isHumanUser && !caller.isSecretary) {
			const highestTier = effectiveOrgConfig.ranks.length > 0 ? Math.min(...effectiveOrgConfig.ranks.map(r => r.tier)) : 1;
			const ownerSid = typeof record.ownerSessionId === 'string' ? record.ownerSessionId.trim() : '';
			const callerStaff = caller.callerNodeId ? parsedGraph.nodes.find(n => n.id === caller.callerNodeId && n.kind === 'staff') : undefined;
			const callerTier = caller.callerTier ?? resolveEffectiveStaffTier(callerStaff, effectiveOrgConfig);
			const targetStaffTier = staffNode ? resolveEffectiveStaffTier(staffNode, effectiveOrgConfig) : undefined;
			const callerDept = callerStaff?.department?.trim();
			const isExecCaller = isStrictCompanyWideExecutiveDept(callerDept);
			const sameDeptStaff = !staffNode?.department || Boolean(callerDept && (isExecCaller || callerDept.toLowerCase() === staffNode.department.trim().toLowerCase()));
			const isStrictSubordinate = Boolean(
				caller.callerNodeId
				&& staffNode
				&& callerTier !== undefined
				&& targetStaffTier !== undefined
				&& targetStaffTier > callerTier
				&& sameDeptStaff
				&& parsedGraph.edges.some(e => e.from === caller.callerNodeId && e.to === nodeId),
			);
			const isOwnOrSup = Boolean(
				(callerTier !== undefined && callerTier <= highestTier)
				|| (ownerSid && caller.callerSessionId === ownerSid)
				|| caller.callerNodeId === nodeId
				|| isStrictSubordinate
				|| (caller.callerNodeId && taskNode && (taskNode.ownerNodeId === caller.callerNodeId || taskNode.assigneeNodeId === caller.callerNodeId)),
			);
			if (!isOwnOrSup) {
				return { handled: true, error: `FORBIDDEN: caller lacks jurisdiction or subordinate authority to run checks for node "${nodeId}".` };
			}
		}
		const filterCheckId = typeof (params.checkId ?? params.id) === 'string' && String(params.checkId ?? params.id).trim()
			? String(params.checkId ?? params.id).trim()
			: undefined;
		const runnable = checks.filter(h => h.enabled !== false && (!filterCheckId || h.id === filterCheckId));
		const projectCwd = host.resolveProjectCwdFromRecord(record);
		const runtimeBoundary = (record.runtime as { readonly boundary?: { readonly nodeAssignments?: Readonly<Record<string, { readonly hostAlias?: string }>> } } | undefined)?.boundary;
		const defaultHostAlias = staffNode?.hostAlias || runtimeBoundary?.nodeAssignments?.[nodeId]?.hostAlias || 'local';
		const results: IAdeDeterministicCheckResponse[] = [];
		const startedAt = Date.now();
		for (const chk of runnable) {
			const hostAlias = chk.hostAlias?.trim() || defaultHostAlias;
			const rawCheckCwd = chk.cwd?.trim();
			const resolvedCwd = rawCheckCwd
				? (hostAlias !== 'local'
					? (rawCheckCwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawCheckCwd) ? rawCheckCwd : (projectCwd ? path.posix.join(projectCwd, rawCheckCwd) : rawCheckCwd))
					: (path.isAbsolute(rawCheckCwd) ? rawCheckCwd : (projectCwd ? path.resolve(projectCwd, rawCheckCwd) : rawCheckCwd)))
				: projectCwd;
			const res = await host.runDeterministicCheck({
				checkId: chk.id,
				name: chk.name,
				command: chk.command,
				cwd: resolvedCwd,
				hostAlias,
				expectExitCode: chk.expectExitCode,
				expectFiles: chk.expectFiles,
				expectOutputMatch: chk.expectOutputMatch,
				timeoutMs: chk.timeoutMs,
			});
			results.push(res);
		}
		const totalDurationMs = Math.max(0, Date.now() - startedAt);
		const passedCount = results.filter(r => r.passed).length;
		const passed = results.every(r => r.passed);
		const summary = runnable.length === 0
			? `No enabled deterministic checks configured on "${nodeId}".`
			: `${passedCount}/${results.length} check(s) passed on "${nodeId}".`;
		if (taskNode && runnable.length > 0 && !filterCheckId) {
			const nowTs = Date.now();
			const receipt: IMissionTaskCheckReceipt = {
				passed,
				summary,
				checkedAt: nowTs,
				checkCount: results.length,
				...(caller.callerNodeId ? { byNodeId: caller.callerNodeId } : {}),
			};
			record.taskStatuses = recordMissionTaskCheckReceipt(
				record.taskStatuses as Readonly<Record<string, IMissionTaskStatusRecord>> | undefined,
				nodeId,
				receipt,
			);
			await ctx.saveCurrentRecord(nowTs);
		}
		return {
			handled: true,
			result: {
				headless: true,
				ok: true,
				missionId,
				nodeId,
				passed,
				totalDurationMs,
				summary,
				results,
			},
		};
	}

	if (action === 'whiteboard.list') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		const rawDept = typeof (params.department ?? params.dept) === 'string' ? String(params.department ?? params.dept).trim() : '';
		const deptFilter = rawDept ? rawDept.toLowerCase() : undefined;
		const allWbs = Object.values(ctx.buildMergedWhiteboards())
			.filter(wb => canCallerAccessWhiteboard(parsedGraph, wb, effectiveOrgConfig, { ...caller, access: 'read', state: orch }))
			.filter(wb => !deptFilter || wb.department.trim().toLowerCase() === deptFilter);
		return {
			handled: true,
			result: {
				headless: true,
				missionId,
				whiteboards: allWbs.map(wb => ({
					whiteboardId: wb.id,
					title: wb.title,
					department: wb.department,
					version: wb.version,
					contentLength: wb.content.length,
					updatedAt: wb.updatedAt,
					updatedByLabel: wb.updatedByLabel,
				})),
			},
		};
	}

	if (action === 'whiteboard.read') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		const id = String(params.id ?? params.whiteboardId ?? params.whiteboard ?? '').trim();
		if (!id) {
			return { handled: true, error: 'Whiteboard ID is required for whiteboard.read.' };
		}
		const wb = ctx.buildMergedWhiteboards()[id];
		if (!wb) {
			return { handled: true, error: `Department whiteboard "${id}" not found.` };
		}
		if (!canCallerAccessWhiteboard(parsedGraph, wb, effectiveOrgConfig, { ...caller, access: 'read', state: orch })) {
			return {
				handled: true,
				error: `FORBIDDEN: caller does not belong to department "${wb.department}" and is not connected to whiteboard "${wb.id}".`,
			};
		}
		const sliceOpts = parseWhiteboardSliceParams(params);
		if (!sliceOpts.hasSliceParams) {
			return { handled: true, result: { headless: true, ok: true, missionId, whiteboard: wb } };
		}
		const sliced = sliceWhiteboardContent(wb.content, sliceOpts);
		return {
			handled: true,
			result: {
				headless: true,
				ok: true,
				missionId,
				whiteboard: {
					...wb,
					content: sliced.content,
				},
				slice: {
					truncated: sliced.truncated,
					totalChars: sliced.totalChars,
					lineCount: sliced.lineCount,
					offset: sliced.offset,
					...(sliced.nextOffset !== undefined ? { nextOffset: sliced.nextOffset } : {}),
					...(sliced.matchedSection ? { matchedSection: sliced.matchedSection } : {}),
					headings: sliced.headings,
					...(sliced.availableSections ? { availableSections: sliced.availableSections } : {}),
					isPartialSlice: sliced.isPartialSlice,
				},
			},
		};
	}

	if (action === 'orchestration.status') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		if (!orch) {
			return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
		}
		const daemon = (await host.getOrchestrationDaemonState(missionId))[missionId];
		const full = params.full === true || params.verbose === true;
		const statusPayload = buildUnifiedOrchestrationStatusResponse({
			missionId,
			title: typeof record.title === 'string' ? record.title : missionId,
			state: orch,
			staffCount: parsedGraph.nodes.filter(n => n.kind === 'staff').length,
			headless: true,
			full,
		});
		return {
			handled: true,
			result: {
				...statusPayload,
				...(daemon ? { daemon } : {}),
			},
		};
	}

	if (action === 'token.read') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		if (!orch) {
			return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
		}
		const rawPtrSource = params.ptrs ?? params.pointers ?? params.ptr ?? params.pointer;
		const rawPtrs = Array.isArray(rawPtrSource)
			? rawPtrSource.map(p => String(p))
			: (typeof rawPtrSource === 'string' ? rawPtrSource.split(',') : []);
		const sliceOpts = parseWhiteboardSliceParams(params);
		const whiteboards = ctx.buildMergedWhiteboards();
		const tokenId = typeof (params.tokenId ?? params.token) === 'string' && String(params.tokenId ?? params.token).trim()
			? String(params.tokenId ?? params.token).trim()
			: undefined;
		const token = tokenId ? orch.tokens[tokenId] : undefined;
		const isExternalObserver = Boolean(caller.isHumanUser || caller.isSecretary);
		const readerNodeId = isExternalObserver ? undefined : (caller.callerNodeId ?? token?.nodeId);
		const waveId = token?.waveId ?? (readerNodeId
			? Object.values(orch.tokens).find(t => t.nodeId === readerNodeId && (t.status === 'active' || t.status === 'blocked'))?.waveId
			: undefined);
		const baseRead = readOrchestrationTokenPointers(orch, whiteboards, parsedGraph, effectiveOrgConfig, {
			ptrs: rawPtrs,
			readerNodeId,
			waveId,
			...(sliceOpts.hasSliceParams ? { slice: sliceOpts } : {}),
			caller: {
				isHumanUser: caller.isHumanUser,
				isSecretary: caller.isSecretary,
				callerTier: caller.callerTier,
				callerNodeId: caller.callerNodeId,
			},
		});
		let nextOrch = baseRead.state;
		const hydrated: IDereferencedOrchestrationPointer[] = [];
		const hydratedExternalPtrs: string[] = [];
		for (const item of baseRead.items) {
			if (!item.externalized) {
				hydrated.push(item);
				continue;
			}
			const coldBlobRaw = await host.readOrchestrationBlob(missionId, item.ptr);
			if (!coldBlobRaw) {
				hydrated.push(item);
				continue;
			}
			try {
				const parsedBlob = JSON.parse(coldBlobRaw) as { content?: string; title?: string; kind?: IDereferencedOrchestrationPointer['kind']; authorNodeId?: string; hop?: number; sizeChars?: number };
				const rawContent = typeof parsedBlob.content === 'string' ? parsedBlob.content : '';
				const sliced = sliceOpts.hasSliceParams ? sliceWhiteboardContent(rawContent, sliceOpts) : undefined;
				if (!sliced?.isPartialSlice) {
					hydratedExternalPtrs.push(item.ptr);
				}
				hydrated.push({
					ptr: item.ptr,
					ok: true,
					kind: parsedBlob.kind ?? item.kind,
					title: parsedBlob.title ?? item.title,
					version: 1,
					authorNodeId: parsedBlob.authorNodeId ?? item.authorNodeId,
					hop: parsedBlob.hop ?? item.hop,
					sizeChars: parsedBlob.sizeChars ?? rawContent.length,
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
		if (hydratedExternalPtrs.length > 0 && readerNodeId && waveId) {
			nextOrch = recordExternalizedPointersRead(nextOrch, {
				ptrs: hydratedExternalPtrs,
				readerNodeId,
				waveId,
			});
		}
		if (nextOrch !== orch) {
			const nowTs = Date.now();
			record.orchestrationRuntime = { ...nextOrch, updatedAt: nowTs };
			await ctx.saveCurrentRecord(nowTs);
		}
		return { handled: true, result: { headless: true, ok: true, missionId, count: hydrated.length, items: hydrated } };
	}

	if (action === 'token.history') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		if (!orch) {
			return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
		}
		const tokenId = typeof (params.tokenId ?? params.token ?? params.id) === 'string'
			? String(params.tokenId ?? params.token ?? params.id).trim()
			: '';
		const isMissionOwner = Boolean(typeof record.ownerSessionId === 'string' && record.ownerSessionId.trim() && record.ownerSessionId.trim() === caller.callerSessionId);
		const lineageCaller = {
			isHumanUser: caller.isHumanUser,
			isSecretary: caller.isSecretary,
			isMissionOwner,
			callerTier: caller.callerTier,
			callerNodeId: caller.callerNodeId,
			callerSessionId: caller.callerSessionId,
		};
		const includeAll = Boolean(params.all === true || params.includeAll === true || params.deltaOnly === false);
		const tok = tokenId ? orch.tokens?.[tokenId] : undefined;
		if (tok) {
			if (!canCallerInspectOrchestrationTokenHistory(orch, parsedGraph, effectiveOrgConfig, tok, lineageCaller)) {
				return { handled: true, error: `FORBIDDEN: caller "${caller.callerNodeId ?? caller.callerSessionId ?? 'unknown'}" does not have lineage access to token "${tok.id}".` };
			}
			const delta = buildOrchestrationTokenDeltaView(orch, tok, ctx.buildMergedWhiteboards());
			return {
				handled: true,
				result: {
					headless: true,
					ok: true,
					missionId,
					tokenId: tok.id,
					waveId: tok.waveId,
					nodeId: tok.nodeId,
					status: tok.status,
					delta,
					hopLog: includeAll ? (tok.hopLog ?? []) : delta.newHops,
					contextRefs: includeAll ? (tok.contextRefs ?? []) : delta.newOrUpdatedRefs,
					...(includeAll ? {} : { omittedEarlierHopCount: delta.earlierHops.length }),
				},
			};
		}
		const archivedLines = await host.readOrchestrationArchive(missionId);
		for (let i = archivedLines.length - 1; i >= 0; i--) {
			try {
				const entry = JSON.parse(archivedLines[i]) as {
					kind?: string;
					token?: {
						id?: string;
						waveId?: string;
						nodeId?: string;
						fromNodeId?: string;
						returnToNodeId?: string;
						originNodeId?: string;
						parentTokenId?: string;
						parentJoinBarrierId?: string;
						holderAgentId?: string;
						status?: string;
						hopLog?: Array<{ fromNodeId?: string; toNodeId?: string }>;
						contextRefs?: unknown[];
					};
				};
				if (entry.kind === 'token' && entry.token?.id === tokenId) {
					if (!canCallerInspectOrchestrationTokenHistory(orch, parsedGraph, effectiveOrgConfig, entry.token, lineageCaller)) {
						return { handled: true, error: `FORBIDDEN: caller "${caller.callerNodeId ?? caller.callerSessionId ?? 'unknown'}" does not have lineage access to archived token "${entry.token.id}".` };
					}
					return {
						handled: true,
						result: {
							headless: true,
							archived: true,
							ok: true,
							missionId,
							tokenId: entry.token.id,
							waveId: entry.token.waveId,
							nodeId: entry.token.nodeId,
							status: entry.token.status,
							hopLog: entry.token.hopLog ?? [],
							contextRefs: entry.token.contextRefs ?? [],
						},
					};
				}
			} catch {
				// skip malformed line
			}
		}
		return { handled: true, error: `Orchestration token "${tokenId}" not found.` };
	}

	if (action === 'token.current') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		if (!orch) {
			return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
		}
		const full = params.full === true || params.verbose === true;
		const whiteboards = ctx.buildMergedWhiteboards();
		const allLive = Object.values(orch.tokens ?? {}).filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join');
		const agentFilter = (caller.isHumanUser || caller.isSecretary) && typeof (params.agent ?? params.agentId) === 'string'
			? String(params.agent ?? params.agentId).trim()
			: '';
		const filtered = (caller.isHumanUser || caller.isSecretary)
			? (agentFilter
				? allLive.filter(t => t.nodeId === agentFilter || t.holderAgentId === agentFilter || orch.nodeAgentIds?.[t.nodeId] === agentFilter)
				: allLive)
			: allLive.filter(t => (caller.callerNodeId && t.nodeId === caller.callerNodeId) || (caller.callerSessionId && (t.holderAgentId === caller.callerSessionId || orch.nodeAgentIds?.[t.nodeId] === caller.callerSessionId)));
		const projected = filtered.map(tok => {
			const delta = buildOrchestrationTokenDeltaView(orch, tok, whiteboards);
			const jb = tok.joinBarrierId ? orch.joinBarriers?.[tok.joinBarrierId] : undefined;
			return projectOrchestrationTokenView(tok, {
				full,
				delta,
				...(jb ? { joinBarrier: projectJoinBarrierSummary(jb, full) } : {}),
			});
		});
		return { handled: true, result: { headless: true, missionId, tokens: projected } };
	}

	if (action === 'token.trace') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		if (!orch) {
			return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
		}
		const tracePtr = String(params.tracePtr ?? params.ptr ?? params.trace ?? '').trim();
		if (!tracePtr) {
			return { handled: true, error: 'Trace pointer (tracePtr) is required.' };
		}
		const isMissionOwner = Boolean(typeof record.ownerSessionId === 'string' && record.ownerSessionId.trim() && record.ownerSessionId.trim() === caller.callerSessionId);
		if (orch.traces?.[tracePtr] && !canCallerInspectOrchestrationTrace(orch, parsedGraph, effectiveOrgConfig, tracePtr, {
			isHumanUser: caller.isHumanUser,
			isSecretary: caller.isSecretary,
			isMissionOwner,
			callerTier: caller.callerTier,
			callerNodeId: caller.callerNodeId,
			callerSessionId: caller.callerSessionId,
		})) {
			return { handled: true, error: `FORBIDDEN: caller "${caller.callerNodeId ?? caller.callerSessionId ?? 'unknown'}" does not have lineage access to trace "${tracePtr}".` };
		}
		const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(200, Math.floor(params.limit))) : 50;
		const out: unknown[] = [];
		const visited = new Set<string>();
		const queue: string[] = [tracePtr];
		while (queue.length > 0 && out.length < limit) {
			const ptr = queue.shift()!;
			if (visited.has(ptr)) { continue; }
			visited.add(ptr);
			const node = orch.traces?.[ptr];
			if (!node) { continue; }
			out.push(node);
			for (const parentPtr of node.parentPtrs) {
				if (!visited.has(parentPtr)) { queue.push(parentPtr); }
			}
		}
		return { handled: true, result: { headless: true, missionId, tracePtr, count: out.length, entries: out } };
	}

	return undefined;
}
