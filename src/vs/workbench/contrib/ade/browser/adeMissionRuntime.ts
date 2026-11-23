/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import * as path from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { AEXUS_SSH_SCHEME, buildCloudProjectUri, IAdeCloudHostBackendService } from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	AdeThinkingLevel,
	buildAdeRemotePersistentPrefix,
	IAdeEngineeringBackendService,
	IAdeInboxService,
	IAdeMissionWatchdogSnapshot,
	IAdeSourceTriggerFireEvent,
	IAdeWatchdogWakeupEvent,
} from '../../../../platform/ade/common/adeEngineering.js';
import {
	IMissionBoundaryConfig,
	IMissionNodeAssignment,
	IMissionSupervisorBinding,
	MissionNodeRoleKind,
	resolveSupervisorJurisdiction,
	validateMissionFactoryBoundary,
} from '../../../../platform/ade/common/adeMissionBoundary.js';
import {
	IMissionNodeCheckExecutionResult,
	IMissionNodeCheckHook,
	IMissionNodeCheckSuiteResult,
	parseMissionMermaidDag,
} from '../../../../platform/ade/common/adeMissionDag.js';
import {
	ADE_MISSION_CONCURRENCY_CONFIG_KEY,
	appendMissionDagRevision,
	applySafeMissionPatch,
	blockMissionToken,
	completeMissionToken,
	computeMissionTotalCostUsd,
	createInitialMissionRuntimeState,
	distillMissionNodeContext,
	escalateMissionIssue,
	expandTracePointer,
	failMissionToken,
	fireMissionSourceTrigger,
	IMissionConcurrencyLimits,
	IMissionEngineCaller,
	IMissionEngineTransitionResult,
	IMissionNodeTelemetry,
	IMissionRuntimeState,
	IMissionSourceTrigger,
	IMissionToken,
	IMissionTraceNode,
	IMissionTurnUsageInput,
	IMissionTurnUsagePricingOptions,
	inferMissionConcurrencyProvider,
	MissionEngineEffect,
	normalizeMissionConcurrencyLimits,
	parseDurationMs,
	pauseMissionRun,
	recallMissionTokens,
	recordMissionNodeTurnUsage,
	recordTokenCheckResult,
	recordWatchdogWakeup,
	rejectMissionToken,
	resolveMissionGate,
	resumeMissionRun,
	retryMissionToken,
	setMissionBudgetLimit,
	setMissionConcurrencyLimits,
	setMissionSilenceTimeout,
	startMissionRun,
	stopMissionRun,
	validateSourceTrigger,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import {
	ADE_MODEL_PRICING_OVERRIDES_CONFIG_KEY,
	AdeModelPricingOverrides,
} from '../../../../platform/ade/common/adeModelPricing.js';
import {
	abortOrchestrationTokens,
	blockOrchestrationToken,
	buildOrchestrationTokenDeltaView,
	canCallerAccessWhiteboard,
	compactOrchestrationRuntimeState,
	completeOrchestrationToken,
	createInitialOrchestrationRuntimeState,
	dispatchRequirementToOrchestration,
	failOrchestrationToken,
	findHighestRankStaffNode,
	getOrchestrationTokenHistory,
	handoffOrchestrationToken,
	hasActiveOrchestrationTokens,
	IDereferencedOrchestrationPointer,
	IMissionTaskStatusRecord,
	IMissionTaskStatusTransitionResult,
	IOrchestrationArchiveEntry,
	IOrchestrationContextBlobInput,
	IOrchestrationMintBranch,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationTokenDeltaView,
	IOrchestrationTransitionResult,
	IOrchestrationWhiteboard,
	mintOrchestrationTokens,
	MissionTaskStatus,
	mutateDepartmentWhiteboard,
	ORCHESTRATION_SILENCE_REMINDER_MINUTES,
	OrchestrationEngineEffect,
	pauseOrchestration,
	planDynamicSubordinateCreation,
	planDynamicSubordinateRemoval,
	planDynamicWhiteboardCreation,
	pruneRemovedWhiteboardFromState,
	readOrchestrationTokenPointers,
	reclaimOrchestrationTokensForRemovedNode,
	recordOrchestrationSilenceReminder,
	resolveEffectiveStaffTier,
	resumeOrchestration,
	returnOrchestrationToken,
	syncMissionTaskStatusesFromOrchestration,
	updateMissionTaskNodeStatus,
	wakeBlockedOrchestrationToken,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	parseOrchestrationGraph,
	removeOrchestrationNode,
	upsertOrchestrationStaffMetaInCode,
	upsertOrchestrationWhiteboardInCode,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import {
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	IAdeOrganizationConfig,
	normalizeAdeEngineId,
	resolveEffectiveRankDefinition,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator, IInstantiationService, ServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ADE_SECRETARY_ID, IAdeAgent, IAdeProjectsService } from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { IAdeMissionRecord, IAdeMissionService } from './adeMissionStore.js';
import { IAdeSessionsService } from './adeSessionsService.js';

export const IAdeMissionRuntimeService = createDecorator<IAdeMissionRuntimeService>('adeMissionRuntimeService');

export interface IMissionStatusView {
	readonly missionId: string;
	readonly title: string;
	readonly status: IMissionRuntimeState['status'];
	readonly silenceTimeoutMinutes: number;
	readonly silenceTimeoutLocked: boolean;
	readonly boundary: IMissionBoundaryConfig;
	readonly boundaryValidation: ReturnType<typeof validateMissionFactoryBoundary>;
	readonly nodeStates: IMissionRuntimeState['nodeStates'];
	readonly tokens: readonly IMissionToken[];
	readonly activeTokenCount: number;
	readonly queuedTokenCount?: number;
	readonly blockedTokenCount: number;
	readonly waitingGateCount: number;
	readonly waitingJoinCount?: number;
	readonly failedTokenCount: number;
	readonly concurrencyLimits?: IMissionConcurrencyLimits;
	readonly triggers: readonly IMissionSourceTrigger[];
	readonly nodeChecks?: Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
	readonly nodeTelemetry?: Readonly<Record<string, IMissionNodeTelemetry>>;
	readonly waveSeq: number;
	readonly startedAt?: number;
	readonly completedAt?: number;
	readonly updatedAt: number;
}

export interface IAdeMissionRuntimeService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<string>;

	getRuntimeState(missionId: string): IMissionRuntimeState;
	getMissionStatus(missionId: string): IMissionStatusView;
	findMissionForAgent(agentId: string): {
		readonly mission: IAdeMissionRecord;
		readonly runtime: IMissionRuntimeState;
		readonly nodeIds: readonly string[];
		readonly isOffGraphSupervisor?: boolean;
		readonly isOrchestrationStaff?: boolean;
		readonly department?: string;
		readonly managedNodeIds?: readonly string[];
	} | undefined;

	start(missionId: string, options?: { readonly silenceTimeoutMinutes?: number; readonly initialPrompt?: string; readonly concurrencyLimits?: IMissionConcurrencyLimits }): Promise<IMissionEngineTransitionResult>;
	pause(missionId: string): Promise<IMissionEngineTransitionResult>;
	resume(missionId: string): Promise<IMissionEngineTransitionResult>;
	stop(missionId: string): Promise<IMissionEngineTransitionResult>;
	setSilenceTimeout(missionId: string, minutes: number): Promise<IMissionEngineTransitionResult>;
	setConcurrencyLimits(missionId: string, limits: IMissionConcurrencyLimits | undefined): Promise<IMissionEngineTransitionResult>;
	setBudgetLimit(missionId: string, budgetLimitUsd: number | undefined): Promise<{ readonly ok: boolean; readonly state: IMissionRuntimeState; readonly error?: string }>;
	distillNodeContext(missionId: string, nodeId: string, options?: { readonly memo?: string }): Promise<IMissionEngineTransitionResult>;

	getBoundary(missionId: string): { readonly boundary: IMissionBoundaryConfig; readonly validation: ReturnType<typeof validateMissionFactoryBoundary> };
	setBoundary(missionId: string, patch: {
		readonly offGraphMaxTier?: number;
		readonly supervisors?: readonly IMissionSupervisorBinding[];
		readonly nodeAssignments?: Readonly<Record<string, IMissionNodeAssignment>>;
	}): Promise<{ readonly ok: boolean; readonly boundary: IMissionBoundaryConfig; readonly validation: ReturnType<typeof validateMissionFactoryBoundary>; readonly error?: string }>;

	bindNodeHost(missionId: string, nodeId: string, options: {
		readonly hostAlias?: string;
		readonly remoteProjectPath?: string;
		readonly agentId?: string;
		readonly roleKind?: MissionNodeRoleKind;
	}): Promise<{ readonly ok: boolean; readonly assignment?: IMissionNodeAssignment; readonly error?: string }>;

	getCurrentTokens(agentId: string, missionId?: string): readonly IMissionToken[];
	expandTrace(missionId: string, tracePtr: string, maxEntries?: number): readonly IMissionTraceNode[];
	getEffectiveNodeChecks(missionId: string, nodeId?: string): Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
	runNodeChecks(missionId: string, nodeId: string, options?: { readonly checkIds?: readonly string[] }): Promise<IMissionNodeCheckSuiteResult>;
	completeToken(missionId: string, params: { readonly tokenId: string; readonly summary: string; readonly callerAgentId?: string; readonly skipChecks?: boolean }): Promise<IMissionEngineTransitionResult>;
	rejectToken(missionId: string, params: { readonly tokenId: string; readonly reason: string; readonly targetNodeId?: string; readonly callerAgentId?: string }): Promise<IMissionEngineTransitionResult>;
	blockToken(missionId: string, params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly maxDuration: string | number;
		readonly watchPid?: number;
		readonly watchFile?: string;
		readonly hostAlias?: string;
		readonly callerAgentId?: string;
	}): Promise<IMissionEngineTransitionResult>;
	failToken(missionId: string, params: { readonly tokenId: string; readonly reason: string; readonly callerAgentId?: string }): Promise<IMissionEngineTransitionResult>;
	retryToken(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly tokenId?: string; readonly nodeId?: string; readonly guidance?: string }): Promise<IMissionEngineTransitionResult>;
	escalate(missionId: string, params: { readonly callerSupervisorId: string; readonly reason: string; readonly tokenId?: string; readonly nodeId?: string; readonly isSecretary?: boolean; readonly isHumanUser?: boolean }): Promise<IMissionEngineTransitionResult>;
	resolveGate(missionId: string, params: { readonly nodeId: string; readonly decision: 'approve' | 'reject'; readonly tokenId?: string; readonly note?: string; readonly rollbackNodeId?: string }): Promise<IMissionEngineTransitionResult>;
	recallTokens(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly nodeIds?: readonly string[]; readonly branchRootNodeId?: string; readonly reason?: string }): Promise<IMissionEngineTransitionResult>;
	patchMermaid(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly newMermaidText: string; readonly reason?: string }): Promise<IMissionEngineTransitionResult>;
	recoverInterruptedActiveTokens(missionId?: string): Promise<number>;

	listTriggers(missionId: string): readonly IMissionSourceTrigger[];
	setTrigger(missionId: string, triggerInput: Partial<IMissionSourceTrigger> & { readonly nodeId: string; readonly kind: IMissionSourceTrigger['kind'] }, caller: IMissionEngineCaller): Promise<{ readonly ok: boolean; readonly trigger?: IMissionSourceTrigger; readonly error?: string; readonly code?: string }>;
	removeTrigger(missionId: string, triggerId: string, caller: IMissionEngineCaller): Promise<{ readonly ok: boolean; readonly removedId?: string; readonly error?: string; readonly code?: string }>;

	touchAgentActivity(sessionResourceOrAgentId: string, timestamp?: number): void;
	beginInteractiveTurn?(sessionResourceOrAgentId: string): {
		readonly turnId: string;
		readonly missionId: string;
		readonly nodeId: string;
		readonly tokenId?: string;
	} | undefined;
	endInteractiveTurn?(turnId: string): void;
	recordTurnUsageBySessionResource(
		sessionResource: string,
		usage: IMissionTurnUsageInput,
		options?: {
			readonly turnId?: string;
			readonly missionId?: string;
			readonly nodeId?: string;
			readonly tokenId?: string;
		},
	): void;
	recordNodeTurnUsage(missionId: string, nodeId: string, usage: IMissionTurnUsageInput): void;

	// Engineering Dual-View: Mission Task DAG + All-Staff Cyclic Orchestration + Shared Whiteboards
	setMissionTaskStatus(missionId: string, params: {
		readonly nodeId: string;
		readonly status: MissionTaskStatus;
		readonly caller: {
			readonly isHumanUser?: boolean;
			readonly callerTier?: number;
			readonly callerSessionId?: string;
			readonly callerLabel?: string;
			readonly callerNodeId?: string;
		};
		readonly force?: boolean;
		readonly note?: string;
	}): IMissionTaskStatusTransitionResult;
	getOrchestrationState(missionId: string): IOrchestrationRuntimeState;
	getCurrentOrchestrationTokens(agentId: string, missionId?: string): readonly IOrchestrationToken[];
	getOrchestrationTokenDelta(missionId: string, tokenId: string): IOrchestrationTokenDeltaView | undefined;
	getOrchestrationTokenHistory(missionId: string, tokenId: string, options?: { readonly includeAll?: boolean }): ReturnType<typeof getOrchestrationTokenHistory>;
	getOrchestrationTokenHistoryAsync?(missionId: string, tokenId: string, options?: { readonly includeAll?: boolean }): Promise<ReturnType<typeof getOrchestrationTokenHistory> & { readonly archived?: boolean }>;
	readOrchestrationTokenPointers(missionId: string, params: {
		readonly ptrs: readonly string[];
		readonly tokenId?: string;
		readonly caller?: {
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerAgentId?: string;
		};
	}): { readonly items: readonly IDereferencedOrchestrationPointer[] };
	readOrchestrationTokenPointersAsync?(missionId: string, params: {
		readonly ptrs: readonly string[];
		readonly tokenId?: string;
		readonly caller?: {
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerAgentId?: string;
		};
	}): Promise<{ readonly items: readonly IDereferencedOrchestrationPointer[] }>;
	dispatchOrchestrationRequirement(missionId: string, params: {
		readonly prompt: string;
		readonly detail?: string;
		readonly targetNodeId?: string;
		readonly taskNodeId?: string;
		readonly taskNodeIds?: readonly string[];
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
	}): Promise<IOrchestrationTransitionResult<{ readonly tokenId: string; readonly targetNodeId: string; readonly payloadPtr?: string }>>;
	mintOrchestrationTokens(missionId: string, params: {
		readonly parentTokenId?: string;
		readonly fromNodeId?: string;
		readonly waveSummary?: string;
		readonly branches: readonly IOrchestrationMintBranch[];
		readonly waitJoin?: boolean;
		readonly joinMode?: 'all' | 'any';
		readonly callerAgentId?: string;
	}): Promise<IOrchestrationTransitionResult<{
		readonly parentTokenId: string;
		readonly mintedTokenIds: readonly string[];
		readonly joinBarrierId?: string;
		readonly createdRootParent?: boolean;
		readonly branches: readonly { readonly tokenId: string; readonly toNodeId: string; readonly taskNodeId?: string; readonly payloadPtr?: string }[];
	}>>;
	returnOrchestrationToken(missionId: string, params: {
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
		readonly skipChecks?: boolean;
	}): Promise<IOrchestrationTransitionResult<{
		readonly returnedToNodeId: string;
		readonly returnedTokenId?: string;
		readonly barrierId?: string;
		readonly barrierSatisfied?: boolean;
		readonly payloadPtr?: string;
		readonly attachedRefPtrs?: readonly string[];
	}>>;
	handoffOrchestrationToken(missionId: string, params: {
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
	}): Promise<IOrchestrationTransitionResult<{ readonly nextTokenIds: readonly string[]; readonly handedOffTo: readonly string[]; readonly payloadPtr?: string; readonly attachedRefPtrs?: readonly string[]; readonly barrierSatisfied?: boolean }>>;
	completeOrchestrationToken(missionId: string, params: {
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
		readonly callerAgentId?: string;
		readonly skipChecks?: boolean;
	}): Promise<IOrchestrationTransitionResult<{ readonly nextTokenIds: readonly string[]; readonly finished?: boolean; readonly payloadPtr?: string; readonly barrierSatisfied?: boolean }>>;
	failOrchestrationToken(missionId: string, params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly callerAgentId?: string;
	}): Promise<IOrchestrationTransitionResult<{ readonly barrierSatisfied?: boolean }>>;
	pauseOrchestration(missionId: string, reason?: string): Promise<IOrchestrationTransitionResult<{ readonly status: 'paused' }>>;
	resumeOrchestration(missionId: string): Promise<IOrchestrationTransitionResult<{ readonly status: 'running'; readonly activeTokenIds: readonly string[] }>>;
	abortOrchestrationTokens(missionId: string, reason?: string): Promise<IOrchestrationTransitionResult<{ readonly abortedTokenIds: readonly string[]; readonly abortedBarrierIds: readonly string[] }>>;
	blockOrchestrationToken(missionId: string, params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly maxDuration: string | number;
		readonly watchPid?: number;
		readonly watchFile?: string;
		readonly hostAlias?: string;
		readonly callerAgentId?: string;
	}): Promise<IOrchestrationTransitionResult>;
	removeOrchestrationSubordinate(missionId: string, params: {
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
		readonly orchestrationText?: string;
		readonly error?: string;
		readonly code?: string;
	}>;
	updateOrchestrationStaffConfig(missionId: string, nodeId: string, patch: {
		readonly engineId?: string | null;
		readonly model?: string | null;
		readonly thinking?: AdeThinkingLevel | string | null;
		readonly hostAlias?: string | null;
		readonly rolePrompt?: string | null;
		readonly allowedPaths?: readonly string[] | null;
		readonly color?: string | null;
		readonly resetSession?: boolean;
	}): Promise<{ readonly ok: boolean; readonly nodeId: string; readonly agentId?: string; readonly resetSession?: boolean; readonly error?: string }>;
	createOrchestrationSubordinate(missionId: string, params: {
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
	}): Promise<{
		readonly ok: boolean;
		readonly newNodeId?: string;
		readonly agentId?: string;
		readonly nextTokenIds?: readonly string[];
		readonly orchestrationText?: string;
		readonly error?: string;
		readonly code?: string;
	}>;
	listOrchestrationWhiteboards(missionId: string, caller?: {
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerTier?: number;
		readonly callerAgentId?: string;
	}): readonly IOrchestrationWhiteboard[];
	readOrchestrationWhiteboard(missionId: string, whiteboardId: string, caller?: {
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerTier?: number;
		readonly callerAgentId?: string;
	}): { readonly ok: boolean; readonly whiteboard?: IOrchestrationWhiteboard; readonly error?: string; readonly code?: string };
	upsertOrchestrationWhiteboard(missionId: string, params: {
		readonly id?: string;
		readonly title?: string;
		readonly department?: string;
		readonly content?: string;
		readonly appendContent?: string;
		readonly mode?: 'create' | 'write' | 'upsert';
		readonly expectedVersion?: number;
		readonly caller?: {
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerAgentId?: string;
			readonly callerLabel?: string;
		};
	}): { readonly ok: boolean; readonly whiteboard?: IOrchestrationWhiteboard; readonly orchestrationText?: string; readonly currentVersion?: number; readonly error?: string; readonly code?: string };
	removeOrchestrationWhiteboard(missionId: string, whiteboardId: string): {
		readonly ok: boolean;
		readonly removedWhiteboardId?: string;
		readonly prunedTokenIds?: readonly string[];
		readonly error?: string;
		readonly code?: string;
	};
}

interface IMissionTurnAttribution {
	readonly turnId: string;
	readonly missionId: string;
	readonly nodeId: string;
	readonly tokenId?: string;
	readonly agentId: string;
	readonly sessionResource?: string;
	readonly source: 'dispatch' | 'interactive';
	readonly startedAt: number;
	finishedAt?: number;
}

const MAX_RETAINED_TURN_ATTRIBUTIONS = 512;
const DELAYED_TURN_USAGE_GRACE_MS = 60_000;

export class AdeMissionRuntimeService extends Disposable implements IAdeMissionRuntimeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;

	private readonly lastHeartbeatSyncAt = new Map<string, number>();
	private readonly inMemoryAgentActivityAt = new Map<string, number>();
	private readonly unclosedTurnNudgeCount = new Map<string, number>();
	private readonly transientRetryCount = new Map<string, number>();
	private readonly inFlightCheckTokens = new Set<string>();
	private readonly pendingTurnNudgeTimers = new Set<ReturnType<typeof setTimeout>>();
	private readonly activeTurnsByAgent = new Map<string, number>();
	private turnAttributionSeq = 0;
	private readonly turnAttributionById = new Map<string, IMissionTurnAttribution>();
	private readonly inFlightTurnByAgent = new Map<string, IMissionTurnAttribution>();
	private readonly inFlightTurnBySession = new Map<string, IMissionTurnAttribution>();
	private readonly lastTurnByAgent = new Map<string, IMissionTurnAttribution>();
	private readonly lastTurnBySession = new Map<string, IMissionTurnAttribution>();
	private readonly pendingDispatchesByAgent = new Map<string, Array<{
		readonly prompt: string;
		readonly options?: {
			readonly autonomousApproved?: boolean;
			readonly missionId?: string;
			readonly tokenId?: string;
			readonly nodeId?: string;
			readonly requireLiveDelivery?: boolean;
			readonly dedupeKey?: string;
			readonly retryAttempt?: number;
			readonly preferReattach?: boolean;
			readonly isNoiseTurn?: boolean;
			readonly onDispatchError?: (reason: string) => void;
		};
	}>>();
	/** Serialized per-mission cold-compaction chains so disk writes & hot-store pruning never race. */
	private readonly compactionChains = new Map<string, Promise<void>>();

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register({
			dispose: () => {
				for (const timer of this.pendingTurnNudgeTimers) {
					clearTimeout(timer);
				}
				this.pendingTurnNudgeTimers.clear();
			},
		});
		this.bindBackendEvents();
		// Rehydrate watchdog registrations (preserving any active owner window) and subscribe to cross-window Mission sync.
		queueMicrotask(() => {
			if (this._store.isDisposed) {
				return;
			}
			const cfg = this.configurationService;
			if (cfg?.onDidChangeConfiguration) {
				this._register(cfg.onDidChangeConfiguration(e => {
					if (e.affectsConfiguration(ADE_MISSION_CONCURRENCY_CONFIG_KEY)) {
						void this.applyConfiguredConcurrencyLimitsToRunningMissions();
					}
				}));
			}
			const projects = this.projectsService;
			if (projects?.onDidChange) {
				this._register(projects.onDidChange(() => {
					void this.reconcileRunningMissionConcurrencyQueues();
				}));
			}
			const missions = this.missionService;
			if (missions?.onDidChangeExternal) {
				this._register(missions.onDidChangeExternal(() => {
					for (const rec of this.missionService?.listMissions() ?? []) {
						this._onDidChange.fire(rec.id);
					}
				}));
			}
			void (async () => {
				try {
					await missions?.whenHydrated?.();
				} catch {
					// Proceed with whatever state is currently loaded
				}
				if (this._store.isDisposed) {
					return;
				}
				let hasRunningMissions = false;
				for (const rec of missions?.listMissions() ?? []) {
					const hasPendingHeadless = Boolean(rec.orchestrationRuntime?.pendingHeadlessEffects && rec.orchestrationRuntime.pendingHeadlessEffects.length > 0);
					const hasLiveOrch = Boolean(rec.orchestrationRuntime && rec.orchestrationRuntime.status !== 'paused' && (hasActiveOrchestrationTokens(rec.orchestrationRuntime) || hasPendingHeadless));
					const hasPausedOrch = Boolean(rec.orchestrationRuntime && rec.orchestrationRuntime.status === 'paused' && hasActiveOrchestrationTokens(rec.orchestrationRuntime));
					if (rec.runtime?.status === 'running' || hasLiveOrch || hasPausedOrch) {
						hasRunningMissions = true;
						if (rec.runtime?.status === 'running' || hasLiveOrch) {
							this.syncWatchdog(rec.id, rec.runtime ?? this.ensureSynchronizedState(rec), { preserveExistingOwner: true });
						}
					}
				}
				// After IDE restart & cold-file hydration, automatically resume interrupted active tokens instead of waiting for silence timeout.
				if (hasRunningMissions) {
					const recoveryTimer = setTimeout(() => {
						this.pendingTurnNudgeTimers.delete(recoveryTimer);
						if (this._store.isDisposed) {
							return;
						}
						void this.recoverInterruptedActiveTokens().catch(() => undefined);
					}, 1500);
					this.pendingTurnNudgeTimers.add(recoveryTimer);
				}
			})();
		});
	}

	private tryGet<T>(id: ServiceIdentifier<T>): T | undefined {
		try {
			return this.instantiationService.invokeFunction(accessor => accessor.get(id));
		} catch {
			return undefined;
		}
	}

	private get missionService(): IAdeMissionService | undefined {
		return this.tryGet(IAdeMissionService);
	}

	private get projectsService(): IAdeProjectsService | undefined {
		return this.tryGet(IAdeProjectsService);
	}

	private get sessionsService(): IAdeSessionsService | undefined {
		return this.tryGet(IAdeSessionsService);
	}

	private get inboxService(): IAdeInboxService | undefined {
		return this.tryGet(IAdeInboxService);
	}

	private get backendService(): IAdeEngineeringBackendService | undefined {
		return this.tryGet(IAdeEngineeringBackendService);
	}

	private get roleSchemaService(): IAdeRoleSchemaService | undefined {
		return this.tryGet(IAdeRoleSchemaService);
	}

	private get cloudHostService(): IAdeCloudHostBackendService | undefined {
		return this.tryGet(IAdeCloudHostBackendService);
	}

	private get commandService(): ICommandService | undefined {
		return this.tryGet(ICommandService);
	}

	private get configurationService(): IConfigurationService | undefined {
		return this.tryGet(IConfigurationService);
	}

	private getModelPricingOverrides(): AdeModelPricingOverrides | undefined {
		const raw = this.configurationService?.getValue<unknown>(ADE_MODEL_PRICING_OVERRIDES_CONFIG_KEY);
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as AdeModelPricingOverrides) : undefined;
	}

	private getConfiguredConcurrencyLimits(): IMissionConcurrencyLimits | undefined {
		const raw = this.configurationService?.getValue<unknown>(ADE_MISSION_CONCURRENCY_CONFIG_KEY);
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? normalizeMissionConcurrencyLimits(raw as IMissionConcurrencyLimits) : undefined;
	}

	private async reconcileRunningMissionConcurrencyQueues(): Promise<void> {
		const missions = this.missionService;
		if (!missions) {
			return;
		}
		for (const rec of missions.listMissions()) {
			if (rec.runtime?.status !== 'running') {
				continue;
			}
			const hasQueued = Object.values(rec.runtime.tokens).some(t => t.status === 'queued');
			if (!hasQueued) {
				continue;
			}
			const synced = this.ensureSynchronizedState(rec);
			const res = setMissionConcurrencyLimits(synced, synced.concurrencyLimits);
			if (res.ok && (res.data?.promotedTokenIds.length ?? 0) > 0) {
				this.commitState(rec.id, res.state);
				if (res.effects.length > 0) {
					await this.executeEffects(rec, res.effects);
				}
			}
		}
	}

	private async applyConfiguredConcurrencyLimitsToRunningMissions(): Promise<void> {
		const missions = this.missionService;
		if (!missions) {
			return;
		}
		const configured = this.getConfiguredConcurrencyLimits();
		for (const rec of missions.listMissions()) {
			if (rec.runtime?.status === 'running' || rec.runtime?.status === 'paused') {
				const res = setMissionConcurrencyLimits(this.ensureSynchronizedState(rec), configured);
				if (res.ok) {
					this.commitState(rec.id, res.state);
					if (res.effects.length > 0) {
						await this.executeEffects(this.requireMission(rec.id), res.effects);
					}
				}
			}
		}
	}

	private resolveNodePricingOptions(state: IMissionRuntimeState, nodeId: string, fallbackAgent?: IAdeAgent): IMissionTurnUsagePricingOptions {
		const assignedAgentId = state.boundary.nodeAssignments[nodeId]?.agentId;
		const agent = fallbackAgent ?? (assignedAgentId ? this.projectsService?.getAgent(assignedAgentId) : undefined);
		const fallbackModel = agent?.preferredModel?.trim() && agent.preferredModel.trim().toLowerCase() !== 'default'
			? agent.preferredModel.trim()
			: undefined;
		const fallbackEngineId = agent?.session?.engineId || agent?.preferredEngineId;
		return {
			overrides: this.getModelPricingOverrides(),
			fallbackModel,
			fallbackEngineId,
		};
	}

	private get orgConfig(): IAdeOrganizationConfig {
		return this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
	}

	private bindBackendEvents(): void {
		const backend = this.backendService;
		if (!backend) {
			return;
		}
		if (backend.onDidWatchdogWakeup) {
			this._register(backend.onDidWatchdogWakeup(ev => {
				void this.handleWatchdogWakeup(ev);
			}));
		}
		if (backend.onDidSourceTriggerFire) {
			this._register(backend.onDidSourceTriggerFire(ev => {
				void this.handleSourceTriggerFire(ev);
			}));
		}
		if (backend.onDidSystemResume) {
			this._register(backend.onDidSystemResume(() => {
				// Wake sleeping SSH reattach loops & heal dropped reverse control bridges immediately on OS wake.
				void this.commandService?.executeCommand('aexus.agentEngines.notifySystemResume').catch(() => undefined);
			}));
		}
	}

	private requireMission(missionId: string): IAdeMissionRecord {
		const missions = this.missionService;
		if (!missions) {
			throw new Error('ADE Mission service is not available.');
		}
		const rec = missions.getMission(missionId) ?? missions.getMissionByLinkedSession(missionId);
		if (!rec) {
			throw new Error(`Mission not found: ${missionId}`);
		}
		return rec;
	}

	private ensureSynchronizedState(rec: IAdeMissionRecord): IMissionRuntimeState {
		const parsed = parseMissionMermaidDag(rec.mermaidText);
		const nodeIds = parsed.nodes.map(n => n.id);
		const org = this.orgConfig;
		const base = rec.runtime ?? createInitialMissionRuntimeState(
			rec.id,
			org,
			{ ownerSessionId: rec.ownerSessionId, ownerTier: rec.ownerTier },
			nodeIds,
			5,
		);

		const generatedEmployees = this.missionService?.getGeneratedEmployees(rec.id) ?? [];
		const byNodeId = new Map<string, IAdeAgent>();
		for (const emp of generatedEmployees) {
			if (emp.treeNodeId) {
				byNodeId.set(emp.treeNodeId, emp);
			}
			for (const nid of emp.treeNodeIds ?? []) {
				byNodeId.set(nid, emp);
			}
		}

		const isLiveRun = base.status === 'running' || base.status === 'paused';
		const isExplicitEmpty = rec.mermaidText.trim().length === 0;
		// Only prune stale node references when Mermaid parses cleanly AND is not mid-typing a header-only draft
		// AND the Mission is not actively running/paused (live runs mutate topology atomically via patchMermaid).
		const parsedOrch = rec.orchestrationText?.trim() ? parseOrchestrationGraph(rec.orchestrationText) : undefined;
		const orchStaffNodeIds = parsedOrch && !parsedOrch.error
			? parsedOrch.nodes.filter(n => n.kind === 'staff').map(n => n.id)
			: [];
		const canPruneStaleNodes = !parsed.error && !isLiveRun && (nodeIds.length > 0 || orchStaffNodeIds.length > 0 || isExplicitEmpty);
		const validNodeIdSet = new Set([...nodeIds, ...orchStaffNodeIds]);
		const validTaskNodeIdSet = new Set([
			...parsed.nodes.filter(n => n.kind !== 'gate').map(n => n.id),
			...orchStaffNodeIds,
		]);
		const defaultInGraphTier = Math.min(org.ranks.length, Math.max(1, base.boundary.offGraphMaxTier + 1));
		const nextAssignments: Record<string, IMissionNodeAssignment> = { ...base.boundary.nodeAssignments };
		let assignmentsChanged = false;
		if (canPruneStaleNodes) {
			for (const existingNodeId of Object.keys(nextAssignments)) {
				if (!validTaskNodeIdSet.has(existingNodeId)) {
					delete nextAssignments[existingNodeId];
					assignmentsChanged = true;
				}
			}
		}
		if (!parsed.error) {
			for (const node of parsed.nodes) {
				if (node.kind === 'gate') {
					continue;
				}
				const existing = nextAssignments[node.id];
				const matchedAgent = byNodeId.get(node.id);
				const existingAgent = existing?.agentId ? this.projectsService?.getAgent(existing.agentId) : undefined;
				// Preserve explicit manual agent bindings (e.g. standalone pure Workers bound via `mission host bind --agent`
				// or `mission boundary set`), while still following Mermaid/popover reassignment among Mission-generated employees.
				const hasManualOverride = Boolean(existingAgent && !existingAgent.treeNodeId && (!existingAgent.treeNodeIds || existingAgent.treeNodeIds.length === 0));
				const resolvedAgentId = hasManualOverride ? existingAgent!.id : (matchedAgent?.id ?? existing?.agentId);
				const resolvedAgent = hasManualOverride ? existingAgent : (matchedAgent ?? existingAgent);
				// Resolve real live rank tier with ZERO artificial clamping so factory boundary checks are honest.
				const resolvedTier = resolvedAgent
					? resolveEffectiveRankDefinition(org, resolvedAgent.role, this.projectsService?.hasSubordinates(resolvedAgent.id) ?? false).tier
					: (existing?.tier ?? defaultInGraphTier);
				const resolvedHost = existing?.hostAlias ?? (resolvedAgent?.projectUri.scheme === 'aexus-ssh' ? resolvedAgent.projectUri.authority : 'local');
				const resolvedRemotePath = existing?.remoteProjectPath ?? (resolvedAgent?.projectUri.scheme === 'aexus-ssh' ? resolvedAgent.projectUri.path : undefined);
				const hasLiveModelOrEngine = Boolean(
					resolvedAgent && (resolvedAgent.preferredModel || resolvedAgent.session?.engineId || resolvedAgent.preferredEngineId),
				);
				const resolvedProvider = hasLiveModelOrEngine
					? inferMissionConcurrencyProvider(
						resolvedAgent?.preferredModel,
						resolvedAgent?.session?.engineId ?? resolvedAgent?.preferredEngineId,
					)
					: existing?.provider;
				if (!existing || existing.agentId !== resolvedAgentId || existing.tier !== resolvedTier || existing.provider !== resolvedProvider) {
					nextAssignments[node.id] = {
						agentId: resolvedAgentId,
						tier: resolvedTier,
						roleKind: existing?.roleKind ?? 'worker',
						hostAlias: resolvedHost,
						...(resolvedRemotePath ? { remoteProjectPath: resolvedRemotePath } : {}),
						...(resolvedProvider ? { provider: resolvedProvider } : {}),
					};
					assignmentsChanged = true;
				}
			}
		}

		// Prune stale deleted-node references (when safe) and sync live supervisor tiers
		// so deleting/replacing DAG nodes never leaves ghost "references unknown DAG node" boundary errors.
		let supervisorsChanged = false;
		const nextSupervisors = base.boundary.supervisors.map(sup => {
			let nextSup = sup;
			if (canPruneStaleNodes) {
				const filteredNodes = sup.managedNodeIds.filter(nid => validNodeIdSet.has(nid));
				if (filteredNodes.length !== sup.managedNodeIds.length) {
					supervisorsChanged = true;
					nextSup = { ...nextSup, managedNodeIds: filteredNodes };
				}
			}
			if (nextSup.id === ADE_SECRETARY_ID) {
				if (nextSup.tier !== 0) {
					supervisorsChanged = true;
					return { ...nextSup, tier: 0 };
				}
				return nextSup;
			}
			const supAgent = this.projectsService?.getAgent(nextSup.id);
			if (supAgent) {
				const liveTier = resolveEffectiveRankDefinition(org, supAgent.role, this.projectsService?.hasSubordinates(supAgent.id) ?? false).tier;
				if (nextSup.tier !== liveTier) {
					supervisorsChanged = true;
					return { ...nextSup, tier: liveTier };
				}
			}
			return nextSup;
		});

		const nextNodeStates: Record<string, IMissionRuntimeState['nodeStates'][string]> = { ...base.nodeStates };
		let statesChanged = false;
		if (canPruneStaleNodes) {
			for (const existingStateNodeId of Object.keys(nextNodeStates)) {
				if (!validNodeIdSet.has(existingStateNodeId)) {
					delete nextNodeStates[existingStateNodeId];
					statesChanged = true;
				}
			}
		}
		if (!parsed.error) {
			for (const node of parsed.nodes) {
				if (!Object.hasOwn(nextNodeStates, node.id)) {
					nextNodeStates[node.id] = 'idle';
					statesChanged = true;
				}
			}
		}

		// Keep live active/queued/blocked token holderAgentId and deferred dispatch effects synchronized with current node assignment.
		let tokensChanged = false;
		const nextTokens: Record<string, IMissionToken> = { ...base.tokens };
		for (const [tid, tok] of Object.entries(base.tokens)) {
			if (tok.status === 'active' || tok.status === 'queued' || tok.status === 'blocked') {
				const currentAssigned = nextAssignments[tok.nodeId]?.agentId;
				if (currentAssigned && tok.holderAgentId !== currentAssigned) {
					nextTokens[tid] = { ...tok, holderAgentId: currentAssigned };
					tokensChanged = true;
				}
			}
		}

		let deferredChanged = false;
		const nextDeferredEffects = base.deferredEffects?.map(eff => {
			if (eff.kind === 'dispatch_token' || eff.kind === 'wakeup_agent') {
				const currentAssigned = nextAssignments[eff.nodeId]?.agentId ?? nextTokens[eff.tokenId]?.holderAgentId;
				if (currentAssigned && eff.holderAgentId !== currentAssigned) {
					deferredChanged = true;
					return { ...eff, holderAgentId: currentAssigned };
				}
			}
			return eff;
		});

		if (!assignmentsChanged && !supervisorsChanged && !statesChanged && !tokensChanged && !deferredChanged && rec.runtime) {
			return base;
		}
		return {
			...base,
			nodeStates: nextNodeStates,
			tokens: nextTokens,
			...(nextDeferredEffects ? { deferredEffects: nextDeferredEffects } : {}),
			boundary: {
				...base.boundary,
				supervisors: nextSupervisors,
				nodeAssignments: nextAssignments,
			},
		};
	}

	private commitState(missionId: string, state: IMissionRuntimeState, options?: { readonly deferPersist?: boolean; readonly skipWatchdogSync?: boolean }): void {
		this.missionService?.updateRuntime(missionId, state, options?.deferPersist ? { deferPersist: true } : undefined);
		if (!options?.skipWatchdogSync) {
			this.syncWatchdog(missionId, state);
		}
		this._onDidChange.fire(missionId);
	}

	private syncWatchdog(missionId: string, state: IMissionRuntimeState, options?: { readonly preserveExistingOwner?: boolean }): void {
		const backend = this.backendService;
		if (!backend?.syncMissionWatchdog) {
			return;
		}
		const rec = this.missionService?.getMission(missionId);
		const orch = rec?.orchestrationRuntime;
		const isOrchPaused = orch?.status === 'paused';
		const hasOrchActive = Boolean(orch && !isOrchPaused && hasActiveOrchestrationTokens(orch));
		if (orch && backend.syncOrchestrationDaemonState) {
			const allOrchTokens = Object.values(orch.tokens);
			void backend.syncOrchestrationDaemonState({
				missionId,
				status: orch.status ?? 'running',
				activeTokenCount: allOrchTokens.filter(t => t.status === 'active').length,
				blockedTokenCount: allOrchTokens.filter(t => t.status === 'blocked').length,
				waitingJoinCount: allOrchTokens.filter(t => t.status === 'waiting_join').length,
				updatedAt: orch.updatedAt,
				...(orch.pausedReason ? { pausedReason: orch.pausedReason } : {}),
			}).catch(() => undefined);
		}
		const isLegacyRunning = state.status === 'running';
		if (!isLegacyRunning && !hasOrchActive) {
			void backend.removeMissionWatchdog?.(missionId).catch(() => undefined);
			return;
		}
		const mapTokenForWatchdog = (t: {
			readonly id: string;
			readonly nodeId: string;
			readonly holderAgentId?: string;
			readonly status: string;
			readonly lastActivityAt: number;
			readonly lastNudgeAt?: number;
			readonly blocked?: IMissionToken['blocked'];
		}) => {
			const memActivity = t.holderAgentId ? (this.inMemoryAgentActivityAt.get(t.holderAgentId) ?? 0) : 0;
			const holderAgent = t.holderAgentId ? this.projectsService?.getAgent(t.holderAgentId) : undefined;
			const hostAlias = holderAgent?.projectUri?.scheme === AEXUS_SSH_SCHEME && holderAgent.projectUri.authority
				? holderAgent.projectUri.authority
				: undefined;
			const sessionId = holderAgent?.session?.resource?.path?.replace(/^\/+/, '');
			const remoteSessionPrefix = hostAlias && holderAgent?.session?.engineId && sessionId
				? buildAdeRemotePersistentPrefix(holderAgent.session.engineId, sessionId)
				: undefined;
			return {
				tokenId: t.id,
				nodeId: t.nodeId,
				holderAgentId: t.holderAgentId,
				status: (t.status === 'blocked' ? 'blocked' : 'active') as 'active' | 'blocked',
				lastActivityAt: Math.max(t.lastActivityAt, memActivity),
				lastNudgeAt: t.lastNudgeAt,
				...(hostAlias ? { hostAlias } : {}),
				...(remoteSessionPrefix ? { remoteSessionPrefix } : {}),
				...(t.blocked ? { blocked: t.blocked } : {}),
			};
		};
		const legacyTokens = isLegacyRunning
			? Object.values(state.tokens).filter(t => t.status === 'active' || t.status === 'blocked').map(mapTokenForWatchdog)
			: [];
		const orchTokens = hasOrchActive && orch
			? Object.values(orch.tokens).filter(t => t.status === 'active' || t.status === 'blocked').map(mapTokenForWatchdog)
			: [];
		const silenceTimeoutMinutes = isLegacyRunning
			? state.silenceTimeoutMinutes
			: (orch?.silenceReminderMinutes || ORCHESTRATION_SILENCE_REMINDER_MINUTES);
		const snapshot: IAdeMissionWatchdogSnapshot = {
			missionId,
			status: 'running',
			silenceTimeoutMinutes,
			tokens: [...legacyTokens, ...orchTokens],
			triggers: isLegacyRunning ? state.triggers : [],
			...(options?.preserveExistingOwner ? { preserveExistingOwner: true } : {}),
		};
		void backend.syncMissionWatchdog(snapshot).catch(() => undefined);
	}

	getRuntimeState(missionId: string): IMissionRuntimeState {
		const rec = this.requireMission(missionId);
		return this.ensureSynchronizedState(rec);
	}

	getMissionStatus(missionId: string): IMissionStatusView {
		const rec = this.requireMission(missionId);
		const state = this.ensureSynchronizedState(rec);
		const parsed = parseMissionMermaidDag(rec.mermaidText);
		const validation = validateMissionFactoryBoundary(this.orgConfig, state.boundary, parsed);
		const tokens = Object.values(state.tokens);
		const nodeChecks = this.computeEffectiveNodeChecks(rec, parsed);
		return {
			missionId: rec.id,
			title: rec.title,
			status: state.status,
			silenceTimeoutMinutes: state.silenceTimeoutMinutes,
			silenceTimeoutLocked: state.silenceTimeoutLocked,
			boundary: state.boundary,
			boundaryValidation: validation,
			nodeStates: state.nodeStates,
			tokens,
			activeTokenCount: tokens.filter(t => t.status === 'active').length,
			queuedTokenCount: tokens.filter(t => t.status === 'queued').length,
			blockedTokenCount: tokens.filter(t => t.status === 'blocked').length,
			waitingGateCount: tokens.filter(t => t.status === 'waiting_gate').length,
			waitingJoinCount: tokens.filter(t => t.status === 'waiting_join').length,
			failedTokenCount: tokens.filter(t => t.status === 'frozen_failed').length,
			...(state.concurrencyLimits ? { concurrencyLimits: state.concurrencyLimits } : {}),
			triggers: state.triggers,
			...(Object.keys(nodeChecks).length > 0 ? { nodeChecks } : {}),
			...(state.nodeTelemetry ? { nodeTelemetry: state.nodeTelemetry } : {}),
			waveSeq: state.waveSeq,
			startedAt: state.startedAt,
			completedAt: state.completedAt,
			updatedAt: state.updatedAt,
		};
	}

	findMissionForAgent(agentId: string): {
		readonly mission: IAdeMissionRecord;
		readonly runtime: IMissionRuntimeState;
		readonly nodeIds: readonly string[];
		readonly isOffGraphSupervisor?: boolean;
		readonly isOrchestrationStaff?: boolean;
		readonly department?: string;
		readonly managedNodeIds?: readonly string[];
	} | undefined {
		const missions = this.missionService?.listMissions() ?? [];
		for (const rec of missions) {
			const state = this.ensureSynchronizedState(rec);
			// 1. Check Orchestration staff node bindings (all ranks on canvas — zero off-graph barrier!)
			if (rec.orchestrationText?.trim()) {
				const orchState = this.ensureSynchronizedOrchestrationState(rec);
				const orchNodes = Object.entries(orchState.nodeAgentIds)
					.filter(([, aid]) => aid === agentId)
					.map(([nid]) => nid);
				if (orchNodes.length > 0) {
					const orchGraph = parseOrchestrationGraph(rec.orchestrationText);
					const matchedNode = orchGraph.nodes.find(n => n.id === orchNodes[0]);
					return {
						mission: rec,
						runtime: state,
						nodeIds: orchNodes,
						isOffGraphSupervisor: false,
						isOrchestrationStaff: true,
						...(matchedNode?.department ? { department: matchedNode.department } : {}),
					};
				}
			}
			// 2. Check bound off-graph supervisors / Mission owner (legacy compatibility)
			const boundSup = state.boundary.supervisors.find(s => s.id === agentId);
			if (boundSup || rec.ownerSessionId === agentId) {
				const graph = parseMissionMermaidDag(rec.mermaidText);
				const jur = resolveSupervisorJurisdiction(state.boundary, agentId, graph.nodes.map(n => n.id), { ownerSessionId: rec.ownerSessionId });
				return {
					mission: rec,
					runtime: state,
					nodeIds: [],
					isOffGraphSupervisor: true,
					managedNodeIds: Array.from(jur.nodeIds),
				};
			}
			// 3. Check in-graph DAG node assignments
			const matchedNodes: string[] = [];
			for (const [nid, assign] of Object.entries(state.boundary.nodeAssignments)) {
				if (assign.agentId === agentId) {
					matchedNodes.push(nid);
				}
			}
			if (matchedNodes.length > 0) {
				return { mission: rec, runtime: state, nodeIds: matchedNodes, isOffGraphSupervisor: false };
			}
		}
		// Fallback to sidebar tree metadata
		const agent = this.projectsService?.getAgent(agentId);
		if (agent?.treeGovernorId) {
			const rec = this.missionService?.getMission(agent.treeGovernorId) ?? this.missionService?.getMissionByLinkedSession(agent.treeGovernorId);
			if (rec) {
				const nodeIds = agent.treeNodeIds && agent.treeNodeIds.length > 0
					? agent.treeNodeIds
					: (agent.treeNodeId ? [agent.treeNodeId] : []);
				return { mission: rec, runtime: this.ensureSynchronizedState(rec), nodeIds, isOffGraphSupervisor: false };
			}
		}
		return undefined;
	}

	async start(missionId: string, options?: { readonly silenceTimeoutMinutes?: number; readonly initialPrompt?: string; readonly concurrencyLimits?: IMissionConcurrencyLimits }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const state = this.ensureSynchronizedState(rec);
		const effectiveConcurrency = options?.concurrencyLimits ?? state.concurrencyLimits ?? this.getConfiguredConcurrencyLimits();
		const result = startMissionRun(state, graph, this.orgConfig, {
			...options,
			...(effectiveConcurrency ? { concurrencyLimits: effectiveConcurrency } : {}),
			requireAssignedNodes: Boolean(this.projectsService),
		});
		if (result.ok) {
			const withInitialRev = appendMissionDagRevision(result.state, rec.mermaidText, 'Mission started (v1)', undefined, graph);
			this.commitState(rec.id, withInitialRev);
			await this.executeEffects(rec, result.effects);
			return { ...result, state: withInitialRev };
		}
		return result;
	}

	async setConcurrencyLimits(missionId: string, limits: IMissionConcurrencyLimits | undefined): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const result = setMissionConcurrencyLimits(this.ensureSynchronizedState(rec), limits);
		if (result.ok) {
			this.commitState(rec.id, result.state);
			if (result.effects.length > 0) {
				await this.executeEffects(this.requireMission(rec.id), result.effects);
			}
		}
		return result;
	}

	async pause(missionId: string): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const result = pauseMissionRun(this.ensureSynchronizedState(rec));
		if (result.ok) {
			this.commitState(rec.id, result.state);
		}
		return result;
	}

	async resume(missionId: string): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const result = resumeMissionRun(this.ensureSynchronizedState(rec));
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
			// Re-flush any queued per-agent dispatches that were preserved while this Mission was paused.
			for (const agentId of Array.from(this.pendingDispatchesByAgent.keys())) {
				const queue = this.pendingDispatchesByAgent.get(agentId);
				if (queue?.some(item => item.options?.missionId === rec.id)) {
					this.flushNextQueuedDispatch(agentId);
				}
			}
		}
		return result;
	}

	async stop(missionId: string): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const prevState = this.ensureSynchronizedState(rec);
		const result = stopMissionRun(prevState);
		if (result.ok) {
			this.commitState(rec.id, result.state);
			this.flushPendingDispatchesForReleasedAgents(prevState, result.state);
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async setSilenceTimeout(missionId: string, minutes: number): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const result = setMissionSilenceTimeout(this.ensureSynchronizedState(rec), minutes);
		if (result.ok) {
			this.commitState(rec.id, result.state);
		}
		return result;
	}

	async setBudgetLimit(missionId: string, budgetLimitUsd: number | undefined): Promise<{ readonly ok: boolean; readonly state: IMissionRuntimeState; readonly error?: string }> {
		const rec = this.requireMission(missionId);
		const prev = this.ensureSynchronizedState(rec);
		const next = setMissionBudgetLimit(prev, budgetLimitUsd);
		this.commitState(rec.id, next);
		if (next.budgetCircuitTripped && !prev.budgetCircuitTripped) {
			void this.stopActiveAgentsOnBudgetTrip(next);
			this.notifyBudgetCircuitTripped(rec, next);
		}
		return { ok: true, state: next };
	}

	async distillNodeContext(missionId: string, nodeId: string, options?: { readonly memo?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const state = this.ensureSynchronizedState(rec);
		const result = distillMissionNodeContext(state, graph, nodeId, options);
		if (!result.ok) {
			return result;
		}
		this.commitState(rec.id, result.state);
		// Stop any bloated session (resolved via nodeAssignment or token holder) and rotate to a clean session before re-dispatching.
		const stopEff = result.effects.find(e => e.kind === 'stop_agent');
		const agentId = result.state.boundary.nodeAssignments[nodeId]?.agentId
			?? (stopEff?.kind === 'stop_agent' ? stopEff.holderAgentId : undefined);
		if (agentId && this.projectsService) {
			const agent = this.projectsService.getAgent(agentId);
			if (agent?.session) {
				const engineId = agent.session.engineId ?? agent.preferredEngineId ?? 'aexus-claude';
				const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
				await this.sessionsService?.stop?.(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
				this.projectsService.setAgentStatus(agent.id, 'idle');
				if (this.sessionsService?.create) {
					const fresh = await this.sessionsService.create(engineId, agent.projectUri).catch(() => undefined);
					if (fresh) {
						this.projectsService.bindSession(agent.id, fresh);
					}
				}
			}
		}
		const nonStopEffects = result.effects.filter(e => e.kind !== 'stop_agent');
		if (nonStopEffects.length > 0) {
			await this.executeEffects(this.requireMission(rec.id), nonStopEffects);
		}
		return result;
	}

	private async stopActiveAgentsOnBudgetTrip(state: IMissionRuntimeState): Promise<void> {
		if (!this.projectsService || !this.sessionsService?.stop) {
			return;
		}
		const agentIds = new Set<string>();
		for (const tok of Object.values(state.tokens)) {
			if (tok.status === 'active' || tok.status === 'blocked') {
				const aid = tok.holderAgentId ?? state.boundary.nodeAssignments[tok.nodeId]?.agentId;
				if (aid) {
					agentIds.add(aid);
				}
			}
		}
		for (const aid of agentIds) {
			const agent = this.projectsService.getAgent(aid);
			if (agent?.session) {
				const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
				await this.sessionsService.stop(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
				this.projectsService.setAgentStatus(agent.id, 'idle');
			}
		}
	}

	private notifyBudgetCircuitTripped(rec: IAdeMissionRecord, state: IMissionRuntimeState): void {
		const spent = computeMissionTotalCostUsd(state);
		const limit = state.budgetLimitUsd ?? 0;
		const hasEstimated = Object.values(state.nodeTelemetry ?? {}).some(t => Boolean(t.costEstimated || (t.estimatedCostUsd ?? 0) > 0));
		const spentLabel = hasEstimated ? `~$${spent.toFixed(2)} (estimated)` : `$${spent.toFixed(2)}`;
		void this.inboxService?.postGovernorMessage?.({
			governorSessionId: rec.ownerSessionId ?? rec.id,
			title: `FinOps Budget Circuit-Breaker Tripped (${rec.title})`,
			message: `Mission "${rec.title}" automatically paused after spending ${spentLabel} against the $${limit.toFixed(2)} FinOps budget ceiling. Raise the budget limit in the FinOps Ledger to resume.`,
			severity: 'critical',
		}).catch(() => undefined);
	}

	getBoundary(missionId: string): { readonly boundary: IMissionBoundaryConfig; readonly validation: ReturnType<typeof validateMissionFactoryBoundary> } {
		const rec = this.requireMission(missionId);
		const state = this.ensureSynchronizedState(rec);
		const parsed = parseMissionMermaidDag(rec.mermaidText);
		return {
			boundary: state.boundary,
			validation: validateMissionFactoryBoundary(this.orgConfig, state.boundary, parsed),
		};
	}

	async setBoundary(missionId: string, patch: {
		readonly offGraphMaxTier?: number;
		readonly supervisors?: readonly IMissionSupervisorBinding[];
		readonly nodeAssignments?: Readonly<Record<string, IMissionNodeAssignment>>;
	}): Promise<{ readonly ok: boolean; readonly boundary: IMissionBoundaryConfig; readonly validation: ReturnType<typeof validateMissionFactoryBoundary>; readonly error?: string }> {
		const rec = this.requireMission(missionId);
		const state = this.ensureSynchronizedState(rec);
		const parsed = parseMissionMermaidDag(rec.mermaidText);

		const nextOffGraphMax = patch.offGraphMaxTier !== undefined ? patch.offGraphMaxTier : state.boundary.offGraphMaxTier;
		const org = this.orgConfig;
		const projects = this.projectsService;

		// Resolve live session tiers for every node assignment (no artificial clamping or silent rewriting).
		const rawAssignments = patch.nodeAssignments ?? state.boundary.nodeAssignments;
		const nextAssignments: Record<string, IMissionNodeAssignment> = {};
		for (const [nid, assign] of Object.entries(rawAssignments)) {
			const agent = assign.agentId ? projects?.getAgent(assign.agentId) : undefined;
			const liveTier = agent
				? resolveEffectiveRankDefinition(org, agent.role, projects?.hasSubordinates(agent.id) ?? false).tier
				: assign.tier;
			nextAssignments[nid] = { ...assign, tier: liveTier };
		}

		// Resolve live session tiers for every supervisor binding and reject unknown session IDs.
		const rawSupervisors = patch.supervisors ?? state.boundary.supervisors;
		const resolvedSupervisors: IMissionSupervisorBinding[] = [];
		for (const sup of rawSupervisors) {
			const supId = sup.id?.trim();
			if (!supId) {
				const errMsg = 'Supervisor binding requires a non-empty session ID.';
				return { ok: false, boundary: state.boundary, validation: { valid: false, errors: [errMsg], offGraphTiers: [], inGraphTiers: [] }, error: errMsg };
			}
			if (supId === ADE_SECRETARY_ID) {
				resolvedSupervisors.push({ ...sup, id: supId, tier: 0 });
				continue;
			}
			if (projects) {
				const supAgent = projects.getAgent(supId);
				if (!supAgent) {
					const errMsg = `Unknown supervisor session ID "${supId}".`;
					return { ok: false, boundary: state.boundary, validation: { valid: false, errors: [errMsg], offGraphTiers: [], inGraphTiers: [] }, error: errMsg };
				}
				const liveTier = resolveEffectiveRankDefinition(org, supAgent.role, projects.hasSubordinates(supAgent.id)).tier;
				resolvedSupervisors.push({ ...sup, id: supId, tier: liveTier });
			} else {
				resolvedSupervisors.push({ ...sup, id: supId });
			}
		}

		const candidate: IMissionBoundaryConfig = {
			offGraphMaxTier: nextOffGraphMax,
			supervisors: resolvedSupervisors,
			nodeAssignments: nextAssignments,
		};
		const validation = validateMissionFactoryBoundary(org, candidate, parsed);
		if (!validation.valid) {
			return {
				ok: false,
				boundary: state.boundary,
				validation,
				error: validation.errors.join(' '),
			};
		}
		const nextState: IMissionRuntimeState = {
			...state,
			boundary: candidate,
			updatedAt: Date.now(),
		};
		if (nextState.status === 'running' && Object.values(nextState.tokens).some(t => t.status === 'queued')) {
			const drained = setMissionConcurrencyLimits(nextState, nextState.concurrencyLimits);
			this.commitState(rec.id, drained.state);
			if (drained.effects.length > 0) {
				await this.executeEffects(rec, drained.effects);
			}
		} else {
			this.commitState(rec.id, nextState);
		}
		return { ok: true, boundary: candidate, validation };
	}

	async bindNodeHost(missionId: string, nodeId: string, options: {
		readonly hostAlias?: string;
		readonly remoteProjectPath?: string;
		readonly agentId?: string;
		readonly roleKind?: MissionNodeRoleKind;
	}): Promise<{ readonly ok: boolean; readonly assignment?: IMissionNodeAssignment; readonly error?: string }> {
		const initialRec = this.requireMission(missionId);
		const parsed = parseMissionMermaidDag(initialRec.mermaidText);
		const parsedOrch = parseOrchestrationGraph(initialRec.orchestrationText ?? '');
		const node = parsed.nodes.find(n => n.id === nodeId);
		const orchStaffNode = parsedOrch.nodes.find(n => n.id === nodeId && n.kind === 'staff');
		if (!node && !orchStaffNode) {
			return { ok: false, error: `Node "${nodeId}" not found in Mission "${initialRec.id}".` };
		}
		const initialState = this.ensureSynchronizedState(initialRec);
		const initialExisting = initialState.boundary.nodeAssignments[nodeId];
		const hostAlias = (options.hostAlias?.trim() || 'local');
		let remoteProjectPath = options.remoteProjectPath?.trim() || initialExisting?.remoteProjectPath;

		let resolvedUri: URI | undefined;
		if (hostAlias !== 'local') {
			const host = await this.cloudHostService?.getHost(hostAlias).catch(() => undefined);
			if (host && !remoteProjectPath) {
				remoteProjectPath = host.defaultDirectory || host.recentDirectories[0] || '/';
			}
			resolvedUri = buildCloudProjectUri(host?.alias ?? hostAlias, remoteProjectPath || '/', host?.os);
		} else if (initialRec.projectUri) {
			resolvedUri = URI.parse(initialRec.projectUri);
			remoteProjectPath = undefined;
		}

		// Re-read freshest runtime state AFTER awaiting cloudHostService to avoid lost updates on concurrent token transitions!
		const freshRec = this.requireMission(missionId);
		const freshState = this.ensureSynchronizedState(freshRec);
		const freshOrchState = orchStaffNode ? this.ensureSynchronizedOrchestrationState(freshRec) : undefined;
		const existing = freshState.boundary.nodeAssignments[nodeId];
		const targetAgentId = options.agentId?.trim() || freshOrchState?.nodeAgentIds[nodeId] || existing?.agentId;
		if (targetAgentId && resolvedUri && this.projectsService?.updateAgentEnginePreferences) {
			this.projectsService.updateAgentEnginePreferences(targetAgentId, { projectUri: resolvedUri });
		}
		// Persist host alias back into Orchestration Mermaid `%% staff ID [host=...]` for pre-launch & portable config!
		if (orchStaffNode && freshRec.orchestrationText) {
			const updatedCode = upsertOrchestrationStaffMetaInCode(freshRec.orchestrationText, nodeId, { hostAlias });
			if (updatedCode.ok && updatedCode.orchestrationText && updatedCode.orchestrationText !== freshRec.orchestrationText) {
				this.missionService?.updateOrchestrationText(freshRec.id, updatedCode.orchestrationText);
			}
		}
		const targetAgent = targetAgentId ? this.projectsService?.getAgent(targetAgentId) : undefined;
		const resolvedTier = targetAgent
			? resolveEffectiveRankDefinition(this.orgConfig, targetAgent.role, this.projectsService?.hasSubordinates(targetAgent.id) ?? false).tier
			: (existing?.tier ?? Math.min(this.orgConfig.ranks.length, Math.max(1, freshState.boundary.offGraphMaxTier + 1)));

		const hasLiveTargetMeta = Boolean(
			targetAgent && (targetAgent.preferredModel || targetAgent.session?.engineId || targetAgent.preferredEngineId),
		);
		const resolvedProvider = hasLiveTargetMeta
			? inferMissionConcurrencyProvider(
				targetAgent?.preferredModel,
				targetAgent?.session?.engineId ?? targetAgent?.preferredEngineId,
			)
			: existing?.provider;
		const updatedAssignment: IMissionNodeAssignment = {
			agentId: targetAgentId,
			tier: resolvedTier,
			roleKind: options.roleKind ?? existing?.roleKind ?? 'worker',
			hostAlias,
			...(hostAlias !== 'local' && remoteProjectPath ? { remoteProjectPath } : {}),
			...(resolvedProvider ? { provider: resolvedProvider } : {}),
		};
		const nextState: IMissionRuntimeState = {
			...freshState,
			boundary: {
				...freshState.boundary,
				nodeAssignments: {
					...freshState.boundary.nodeAssignments,
					[nodeId]: updatedAssignment,
				},
			},
			updatedAt: Date.now(),
		};
		if (nextState.status === 'running' && Object.values(nextState.tokens).some(t => t.status === 'queued')) {
			const drained = setMissionConcurrencyLimits(nextState, nextState.concurrencyLimits);
			this.commitState(freshRec.id, drained.state);
			if (drained.effects.length > 0) {
				await this.executeEffects(freshRec, drained.effects);
			}
		} else {
			this.commitState(freshRec.id, nextState);
		}
		return { ok: true, assignment: updatedAssignment };
	}

	getCurrentTokens(agentId: string, missionId?: string): readonly IMissionToken[] {
		const missions = missionId
			? [this.missionService?.getMission(missionId) ?? this.missionService?.getMissionByLinkedSession(missionId)].filter((m): m is IAdeMissionRecord => Boolean(m))
			: (this.missionService?.listMissions() ?? []);
		const out: IMissionToken[] = [];
		for (const rec of missions) {
			const state = this.ensureSynchronizedState(rec);
			for (const tok of Object.values(state.tokens)) {
				const assignedAgent = state.boundary.nodeAssignments[tok.nodeId]?.agentId;
				const matchesHolder = tok.holderAgentId === agentId || assignedAgent === agentId;
				if (matchesHolder && (tok.status === 'active' || tok.status === 'blocked' || tok.status === 'frozen_failed' || tok.status === 'waiting_gate')) {
					out.push(tok);
				}
			}
		}
		return out;
	}

	expandTrace(missionId: string, tracePtr: string, maxEntries = 100): readonly IMissionTraceNode[] {
		const rec = this.requireMission(missionId);
		const orch = rec.orchestrationRuntime;
		if (orch?.traces[tracePtr]) {
			const out: IMissionTraceNode[] = [];
			const visited = new Set<string>();
			const queue: string[] = [tracePtr];
			while (queue.length > 0 && out.length < maxEntries) {
				const ptr = queue.shift()!;
				if (visited.has(ptr)) {
					continue;
				}
				visited.add(ptr);
				const node = orch.traces[ptr];
				if (!node) {
					continue;
				}
				out.push(node);
				for (const parentPtr of node.parentPtrs) {
					if (!visited.has(parentPtr)) {
						queue.push(parentPtr);
					}
				}
			}
			return out;
		}
		const state = this.ensureSynchronizedState(rec);
		return expandTracePointer(state, tracePtr, maxEntries);
	}

	private computeEffectiveNodeChecks(
		rec: IAdeMissionRecord,
		parsed = parseMissionMermaidDag(rec.mermaidText),
		onlyNodeId?: string,
	): Record<string, readonly IMissionNodeCheckHook[]> {
		const parsedOrch = rec.orchestrationText?.trim() ? parseOrchestrationGraph(rec.orchestrationText) : undefined;
		const out: Record<string, readonly IMissionNodeCheckHook[]> = {};
		const nodeIds = onlyNodeId
			? [onlyNodeId]
			: [...new Set([
				...parsed.nodes.filter(n => n.kind === 'task').map(n => n.id),
				...(parsedOrch?.nodes.filter(n => n.kind === 'staff').map(n => n.id) ?? []),
				...Object.keys(rec.nodeChecks ?? {}),
			])];

		for (const nid of nodeIds) {
			const dagNode = parsed.nodes.find(n => n.id === nid);
			if (dagNode?.kind === 'gate') {
				continue;
			}
			const orchNode = parsedOrch?.nodes.find(n => n.id === nid && n.kind === 'staff');
			const mermaidHooks = dagNode?.checks ?? [];
			const orchHooks = orchNode?.checks ?? [];
			const configHooks = rec.nodeChecks?.[nid] ?? [];
			const mergedById = new Map<string, IMissionNodeCheckHook>();
			for (const mh of mermaidHooks) {
				mergedById.set(mh.id, mh);
			}
			for (const oh of orchHooks) {
				mergedById.set(oh.id, oh);
			}
			for (const ch of configHooks) {
				mergedById.set(ch.id, ch);
			}
			const combined = [...mergedById.values()];
			if (combined.length > 0) {
				out[nid] = combined;
			}
		}
		return out;
	}

	getEffectiveNodeChecks(missionId: string, nodeId?: string): Readonly<Record<string, readonly IMissionNodeCheckHook[]>> {
		const rec = this.requireMission(missionId);
		return this.computeEffectiveNodeChecks(rec, parseMissionMermaidDag(rec.mermaidText), nodeId);
	}

	private resolveCheckExecutionTarget(
		rec: IAdeMissionRecord,
		state: IMissionRuntimeState,
		nodeId: string,
		hook: IMissionNodeCheckHook,
	): { readonly hostAlias: string; readonly cwd?: string } {
		const orchGraph = rec.orchestrationText?.trim() ? parseOrchestrationGraph(rec.orchestrationText) : undefined;
		const orchStaffNode = orchGraph && !orchGraph.error
			? orchGraph.nodes.find(n => n.id === nodeId && n.kind === 'staff')
			: undefined;
		const orchState = orchStaffNode ? this.ensureSynchronizedOrchestrationState(rec) : undefined;
		const orchAgentId = orchState?.nodeAgentIds[nodeId] ?? orchStaffNode?.agentId;
		const assignment = state.boundary.nodeAssignments[nodeId];
		const agentId = orchAgentId ?? assignment?.agentId;
		const agent = agentId ? this.projectsService?.getAgent(agentId) : undefined;
		const hostAlias = hook.hostAlias?.trim()
			|| orchStaffNode?.hostAlias?.trim()
			|| assignment?.hostAlias?.trim()
			|| (agent?.projectUri.scheme === 'aexus-ssh' ? agent.projectUri.authority : 'local');
		const isRemote = hostAlias !== 'local';

		let baseDir: string | undefined;
		if (isRemote) {
			baseDir = (agent?.projectUri.scheme === 'aexus-ssh' ? agent.projectUri.path : undefined)
				|| assignment?.remoteProjectPath?.trim();
		} else if (agent?.projectUri.scheme === 'file') {
			baseDir = agent.projectUri.fsPath;
		} else if (rec.projectUri) {
			const parsedUri = URI.parse(rec.projectUri);
			if (parsedUri.scheme === 'file') {
				baseDir = parsedUri.fsPath;
			}
		}

		const rawCwd = hook.cwd?.trim();
		let cwd: string | undefined;
		if (!rawCwd) {
			cwd = baseDir;
		} else if (isRemote) {
			cwd = rawCwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawCwd)
				? rawCwd
				: (baseDir ? path.posix.join(baseDir, rawCwd) : rawCwd);
		} else {
			cwd = path.isAbsolute(rawCwd)
				? rawCwd
				: (baseDir ? path.join(baseDir, rawCwd) : rawCwd);
		}
		return { hostAlias, cwd };
	}

	async runNodeChecks(
		missionId: string,
		nodeId: string,
		options?: { readonly checkIds?: readonly string[] },
	): Promise<IMissionNodeCheckSuiteResult> {
		const rec = this.requireMission(missionId);
		const state = this.ensureSynchronizedState(rec);
		const allHooks = this.computeEffectiveNodeChecks(rec, parseMissionMermaidDag(rec.mermaidText), nodeId)[nodeId] ?? [];
		const filterSet = options?.checkIds && options.checkIds.length > 0 ? new Set(options.checkIds) : undefined;
		const enabledHooks = allHooks.filter(h => h.enabled !== false && (!filterSet || filterSet.has(h.id)));

		if (enabledHooks.length === 0) {
			return {
				nodeId,
				passed: true,
				totalDurationMs: 0,
				results: [],
				summary: `No enabled deterministic checks configured for node ${nodeId}.`,
			};
		}

		const backend = this.backendService;
		const results: IMissionNodeCheckExecutionResult[] = [];
		let totalDurationMs = 0;
		let allPassed = true;

		for (const hook of enabledHooks) {
			const target = this.resolveCheckExecutionTarget(rec, state, nodeId, hook);
			let res: IMissionNodeCheckExecutionResult;
			if (!backend?.runDeterministicCheck) {
				res = {
					checkId: hook.id,
					...(hook.name ? { name: hook.name } : {}),
					...(hook.command ? { command: hook.command } : {}),
					hostAlias: target.hostAlias,
					...(target.cwd ? { cwd: target.cwd } : {}),
					passed: false,
					exitCode: -1,
					expectedExitCode: hook.expectExitCode ?? 0,
					durationMs: 0,
					outputTail: '',
					error: 'Deterministic check backend service is unavailable.',
				};
			} else {
				res = await backend.runDeterministicCheck({
					checkId: hook.id,
					name: hook.name,
					command: hook.command,
					expectExitCode: hook.expectExitCode,
					cwd: target.cwd,
					hostAlias: target.hostAlias,
					expectFiles: hook.expectFiles,
					expectOutputMatch: hook.expectOutputMatch,
					timeoutMs: hook.timeoutMs,
				});
			}
			results.push(res);
			totalDurationMs += res.durationMs;
			if (!res.passed) {
				allPassed = false;
				// Fail-fast in declared hook order (e.g. skip test suite when build/typecheck already failed)
				break;
			}
		}

		const summary = allPassed
			? `[Verified: ${results.map(r => `${r.name || r.command || r.checkId} (ok, ${r.durationMs}ms)`).join('; ')}]`
			: (() => {
				const failed = results.find(r => !r.passed)!;
				return `[Check Failed: ${failed.name || failed.command || failed.checkId} — ${failed.error || `exit ${failed.exitCode}`}]`;
			})();

		return {
			nodeId,
			passed: allPassed,
			totalDurationMs,
			results,
			summary,
		};
	}

	async completeToken(missionId: string, params: { readonly tokenId: string; readonly summary: string; readonly callerAgentId?: string; readonly skipChecks?: boolean }): Promise<IMissionEngineTransitionResult> {
		const initialRec = this.requireMission(missionId);
		const initialGraph = parseMissionMermaidDag(initialRec.mermaidText);
		const initialState = this.ensureSynchronizedState(initialRec);

		// Validate basic preconditions & holder authority BEFORE executing any shell verification hook!
		if (initialState.status !== 'running' && initialState.status !== 'paused') {
			return { ok: false, state: initialState, effects: [], code: 'INVALID_STATE', error: `Mission is "${initialState.status}", not running.` };
		}
		const initialToken = initialState.tokens[params.tokenId];
		if (!initialToken || (initialToken.status !== 'active' && initialToken.status !== 'blocked')) {
			return { ok: false, state: initialState, effects: [], code: 'NOT_FOUND', error: `Active token "${params.tokenId}" not found.` };
		}
		if (params.callerAgentId !== undefined) {
			const assignedHolder = initialState.boundary.nodeAssignments[initialToken.nodeId]?.agentId ?? initialToken.holderAgentId;
			if (!assignedHolder || assignedHolder !== params.callerAgentId) {
				return { ok: false, state: initialState, effects: [], code: 'FORBIDDEN', error: `Token "${params.tokenId}" is not held by caller "${params.callerAgentId}".` };
			}
		}
		if (!params.summary.trim()) {
			return { ok: false, state: initialState, effects: [], code: 'INVALID_STATE', error: 'A concrete plain-text summary is required to complete a token.' };
		}

		const nodeHooks = (this.computeEffectiveNodeChecks(initialRec, initialGraph, initialToken.nodeId)[initialToken.nodeId] ?? [])
			.filter(h => h.enabled !== false);
		const allowSkip = Boolean(params.skipChecks && params.callerAgentId === undefined);

		let verificationNote: string | undefined;
		let checkSuite: IMissionNodeCheckSuiteResult | undefined;

		if (nodeHooks.length > 0 && !allowSkip) {
			const lockKey = `${initialRec.id}:${params.tokenId}`;
			if (this.inFlightCheckTokens.has(lockKey)) {
				return {
					ok: false,
					state: initialState,
					effects: [],
					code: 'INVALID_STATE',
					error: `Deterministic verification is already running for token "${params.tokenId}". Wait for it to finish.`,
				};
			}
			this.inFlightCheckTokens.add(lockKey);
			const activeHolderId = initialState.boundary.nodeAssignments[initialToken.nodeId]?.agentId ?? initialToken.holderAgentId;
			if (activeHolderId) {
				this.touchAgentActivity(activeHolderId, Date.now());
			}
			try {
				checkSuite = await this.runNodeChecks(initialRec.id, initialToken.nodeId);
			} finally {
				this.inFlightCheckTokens.delete(lockKey);
				if (activeHolderId) {
					this.touchAgentActivity(activeHolderId, Date.now());
				}
			}

			// Re-read freshest Mission state AFTER awaiting deterministic checks (avoid lost updates or stale completion after stop/recall!)
			const freshRec = this.requireMission(initialRec.id);
			const freshGraph = parseMissionMermaidDag(freshRec.mermaidText);
			const freshState = this.ensureSynchronizedState(freshRec);
			const failedResult = checkSuite.results.find(r => !r.passed);
			const failedHook = failedResult ? nodeHooks.find(h => h.id === failedResult.checkId) : nodeHooks[0];

			const checkTransition = recordTokenCheckResult(freshState, freshGraph, {
				tokenId: params.tokenId,
				suiteResult: checkSuite,
				onFail: failedHook?.onFail ?? 'bounce',
				maxAutoRetries: failedHook?.maxAutoRetries ?? 2,
				callerAgentId: params.callerAgentId,
				owner: { ownerSessionId: freshRec.ownerSessionId, ownerTier: freshRec.ownerTier },
			});
			this.commitState(freshRec.id, checkTransition.state);
			if (checkTransition.effects.length > 0) {
				await this.executeEffects(freshRec, checkTransition.effects);
			}
			if (!checkTransition.ok) {
				return checkTransition;
			}
			verificationNote = checkSuite.summary;
		}

		const latestRec = this.requireMission(initialRec.id);
		const latestGraph = parseMissionMermaidDag(latestRec.mermaidText);
		const prevCompleteState = this.ensureSynchronizedState(latestRec);
		const result = completeMissionToken(prevCompleteState, latestGraph, {
			tokenId: params.tokenId,
			summary: params.summary,
			callerAgentId: params.callerAgentId,
			...(verificationNote ? { verificationNote } : {}),
		});
		if (result.ok) {
			this.commitState(latestRec.id, result.state);
			this.flushPendingDispatchesForReleasedAgents(prevCompleteState, result.state);
			await this.executeEffects(latestRec, result.effects);
			if (checkSuite) {
				return {
					...result,
					data: {
						...(result.data as Record<string, unknown> ?? {}),
						verified: true,
						checkSuite,
					},
				};
			}
		}
		return result;
	}

	async rejectToken(missionId: string, params: { readonly tokenId: string; readonly reason: string; readonly targetNodeId?: string; readonly callerAgentId?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const prevState = this.ensureSynchronizedState(rec);
		const result = rejectMissionToken(prevState, graph, params);
		if (result.ok) {
			this.commitState(rec.id, result.state);
			this.flushPendingDispatchesForReleasedAgents(prevState, result.state);
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async blockToken(missionId: string, params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly maxDuration: string | number;
		readonly watchPid?: number;
		readonly watchFile?: string;
		readonly hostAlias?: string;
		readonly callerAgentId?: string;
	}): Promise<IMissionEngineTransitionResult> {
		const initialRec = this.requireMission(missionId);
		const initialState = this.ensureSynchronizedState(initialRec);
		const durationMs = parseDurationMs(params.maxDuration);
		if (!durationMs) {
			return {
				ok: false,
				state: initialState,
				effects: [],
				code: 'INVALID_STATE',
				error: `Invalid maxDuration "${String(params.maxDuration)}". Use formats like "30m", "2h", "10h", or milliseconds.`,
			};
		}
		const initialToken = initialState.tokens[params.tokenId];
		const inferredHost = params.hostAlias
			?? (initialToken ? initialState.boundary.nodeAssignments[initialToken.nodeId]?.hostAlias : undefined);

		// Capture baseline mtime directly on the target host at block time so remote clock skew / 1s truncation
		// never causes `--watch-file` / `--wake-on-file` to miss a newly written output file.
		let initialFileMtime: number | null | undefined;
		if (params.watchFile?.trim() && this.backendService?.probeFileMtime) {
			let probeTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				initialFileMtime = await Promise.race([
					this.backendService.probeFileMtime(inferredHost || 'local', params.watchFile.trim()).catch(() => undefined),
					new Promise<undefined>(resolve => {
						probeTimer = setTimeout(() => resolve(undefined), 4_000);
					}),
				]);
			} finally {
				if (probeTimer !== undefined) {
					clearTimeout(probeTimer);
				}
			}
		}

		// Re-read freshest runtime state after async remote mtime probe to avoid clobbering concurrent token transitions.
		const freshRec = this.requireMission(missionId);
		const freshState = this.ensureSynchronizedState(freshRec);
		const result = blockMissionToken(freshState, {
			tokenId: params.tokenId,
			reason: params.reason,
			maxDurationMs: durationMs,
			watchPid: params.watchPid,
			watchFile: params.watchFile,
			...(initialFileMtime !== undefined ? { initialFileMtime } : {}),
			hostAlias: inferredHost,
			callerAgentId: params.callerAgentId,
		});
		if (result.ok) {
			this.commitState(freshRec.id, result.state);
			if (result.effects.length > 0) {
				await this.executeEffects(this.requireMission(freshRec.id), result.effects);
			}
		}
		return result;
	}

	async failToken(missionId: string, params: { readonly tokenId: string; readonly reason: string; readonly callerAgentId?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const prevState = this.ensureSynchronizedState(rec);
		const result = failMissionToken(prevState, graph, {
			...params,
			owner: { ownerSessionId: rec.ownerSessionId, ownerTier: rec.ownerTier },
		});
		if (result.ok) {
			this.commitState(rec.id, result.state);
			this.flushPendingDispatchesForReleasedAgents(prevState, result.state);
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async retryToken(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly tokenId?: string; readonly nodeId?: string; readonly guidance?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = retryMissionToken(this.ensureSynchronizedState(rec), graph, params);
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async escalate(missionId: string, params: { readonly callerSupervisorId: string; readonly reason: string; readonly tokenId?: string; readonly nodeId?: string; readonly isSecretary?: boolean; readonly isHumanUser?: boolean }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		// Orchestration-backed Mission escalation: route upward to direct higher-tier Orchestration superior,
		// or to Human ADE Inbox when top-rank / no higher Orchestration superior exists.
		if (rec.orchestrationText?.trim() && !params.isHumanUser && !params.isSecretary) {
			const orchGraph = parseOrchestrationGraph(rec.orchestrationText);
			if (!orchGraph.error && orchGraph.nodes.some(n => n.kind === 'staff')) {
				const orchState = this.ensureSynchronizedOrchestrationState(rec);
				const callerNodeId = Object.entries(orchState.nodeAgentIds).find(([, aid]) => aid === params.callerSupervisorId)?.[0];
				const callerNode = callerNodeId ? orchGraph.nodes.find(n => n.id === callerNodeId && n.kind === 'staff') : undefined;
				if (callerNode) {
					const callerTier = resolveEffectiveStaffTier(callerNode, this.orgConfig) ?? 99;
					const higherSuperiors = orchGraph.edges
						.filter(e => e.to === callerNode.id)
						.map(e => orchGraph.nodes.find(n => n.id === e.from && n.kind === 'staff'))
						.filter((n): n is NonNullable<typeof n> => {
							if (!n || n.id === callerNode.id) { return false; }
							const supTier = resolveEffectiveStaffTier(n, this.orgConfig);
							return supTier !== undefined && supTier < callerTier;
						})
						.sort((a, b) => (resolveEffectiveStaffTier(b, this.orgConfig) ?? 0) - (resolveEffectiveStaffTier(a, this.orgConfig) ?? 0));
					const targetSupNode = higherSuperiors[0];
					const targetSupAgentId = targetSupNode ? (orchState.nodeAgentIds[targetSupNode.id] ?? targetSupNode.agentId) : undefined;
					const state = this.ensureSynchronizedState(rec);
					if (targetSupNode && targetSupAgentId && targetSupAgentId !== params.callerSupervisorId) {
						await this.executeEffects(rec, [{
							kind: 'escalate_to_supervisor',
							missionId: rec.id,
							supervisorId: targetSupAgentId,
							nodeId: params.nodeId || callerNode.id,
							tokenId: params.tokenId || '',
							reason: `[Escalated by ${callerNode.id} (${callerNode.label})] ${params.reason}`,
						}]);
						return {
							ok: true,
							state,
							effects: [],
							data: { escalatedTo: targetSupAgentId, escalatedToNodeId: targetSupNode.id },
						};
					}
					await this.executeEffects(rec, [{
						kind: 'post_inbox',
						missionId: rec.id,
						nodeId: params.nodeId || callerNode.id,
						title: `Engineering Escalation (${callerNode.id})`,
						message: `Escalated by \`${callerNode.id}\` (${callerNode.label})${params.tokenId ? ` for token \`${params.tokenId}\`` : ''}:\n\n${params.reason}`,
						severity: 'critical',
						senderAgentId: params.callerSupervisorId,
					}]);
					return {
						ok: true,
						state,
						effects: [],
						data: { escalatedTo: 'human_inbox' },
					};
				}
			}
		}
		const result = escalateMissionIssue(this.ensureSynchronizedState(rec), {
			...params,
			ownerSessionId: rec.ownerSessionId,
		});
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async resolveGate(missionId: string, params: { readonly nodeId: string; readonly decision: 'approve' | 'reject'; readonly tokenId?: string; readonly note?: string; readonly rollbackNodeId?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = resolveMissionGate(this.ensureSynchronizedState(rec), graph, params);
		if (result.ok) {
			this.commitState(rec.id, result.state);
			// Mark matching unresolved Inbox gate todos resolved when no queued wave remains (or for the resolved token).
			const inbox = this.inboxService;
			if (inbox) {
				const resolvedData = result.data as { readonly resolvedTokenId?: string; readonly remainingQueuedGateCount?: number } | undefined;
				const remainingQueued = resolvedData?.remainingQueuedGateCount ?? 0;
				const openGates = inbox.list({ includeResolved: false }).filter(item =>
					item.kind === 'user_gate'
					&& item.nodeId === params.nodeId
					&& (item.governorSessionId === rec.ownerSessionId || item.governorSessionId === rec.id)
				);
				const resolutionText = `${params.decision}${params.note ? `: ${params.note}` : ''}`;
				for (const openGate of openGates) {
					if (remainingQueued === 0 || !resolvedData?.resolvedTokenId || openGate.message.includes(resolvedData.resolvedTokenId)) {
						await inbox.resolveItem(openGate.id, resolutionText).catch(() => undefined);
					}
				}
			}
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async recoverInterruptedActiveTokens(missionId?: string): Promise<number> {
		const missions = this.missionService;
		const projects = this.projectsService;
		if (!missions || !projects || !this.commandService) {
			return 0;
		}
		const targetRecords = missionId
			? [missions.getMission(missionId) ?? missions.getMissionByLinkedSession(missionId)].filter((m): m is IAdeMissionRecord => Boolean(m))
			: missions.listMissions();
		let resumedCount = 0;
		for (const rec of targetRecords) {
			const isLegacyRunning = rec.runtime?.status === 'running';
			const hasPendingHeadless = Boolean(rec.orchestrationRuntime?.pendingHeadlessEffects && rec.orchestrationRuntime.pendingHeadlessEffects.length > 0);
			const hasOrchTokens = Boolean(rec.orchestrationRuntime && (hasActiveOrchestrationTokens(rec.orchestrationRuntime) || hasPendingHeadless));
			if (!isLegacyRunning && !hasOrchTokens) {
				continue;
			}
			// On automatic startup recovery (missionId omitted), skip Missions currently owned by another
			// live Electron window so opening a second window never injects duplicate turns into live agents!
			if (!missionId && this.backendService?.canRecoverMission) {
				const canRecover = await this.backendService.canRecoverMission(rec.id).catch(() => true);
				if (!canRecover) {
					continue;
				}
			}
			if (isLegacyRunning) {
				const state = this.ensureSynchronizedState(rec);
				const graph = parseMissionMermaidDag(rec.mermaidText);
				const recoveredTokenIds: string[] = [];
				for (const tok of Object.values(state.tokens)) {
					if (tok.status !== 'active') {
						continue;
					}
					const targetAgentId = state.boundary.nodeAssignments[tok.nodeId]?.agentId ?? tok.holderAgentId;
					if (!targetAgentId) {
						continue;
					}
					if ((this.activeTurnsByAgent.get(targetAgentId) ?? 0) > 0) {
						continue;
					}
					const dedupeKey = `recover:${rec.id}:${tok.id}`;
					const queued = this.pendingDispatchesByAgent.get(targetAgentId);
					if (queued?.some(item => item.options?.tokenId === tok.id && item.options?.missionId === rec.id)) {
						continue;
					}
					const agent = projects.getAgent(targetAgentId);
					if (!agent) {
						continue;
					}
					const isRemoteAgent = agent.projectUri.scheme === AEXUS_SSH_SCHEME;
					const dagNode = graph.nodes.find(n => n.id === tok.nodeId);
					const nodeLabel = dagNode?.label ?? tok.nodeId;
					const recoveryPrompt = [
						`[IDE Restart Auto-Recovery · Node \`${tok.nodeId}\` (${nodeLabel}) · Token \`${tok.id}\`]`,
						`Aexus Code restarted while you held active token \`${tok.id}\` (wave \`${tok.waveId}\`).`,
						`Inspect your workspace (preserve any deliverables already written), complete remaining work and checks, and close the token via \`aexus-ade token complete ${tok.id} --summary "..."\` (or \`token block\` / \`token fail\`).`,
						tok.lastSummary ? `\n### Previous Step Summary (\`last_summary\`)\n${tok.lastSummary}` : '',
					].filter(Boolean).join('\n');
					const dispatched = await this.dispatchPromptToAgent(targetAgentId, recoveryPrompt, {
						autonomousApproved: true,
						missionId: rec.id,
						tokenId: tok.id,
						nodeId: tok.nodeId,
						dedupeKey,
						...(isRemoteAgent ? { preferReattach: true } : {}),
					});
					if (dispatched) {
						resumedCount++;
						this.inMemoryAgentActivityAt.set(targetAgentId, Date.now());
						recoveredTokenIds.push(tok.id);
					}
				}
				// Re-read freshest runtime AFTER awaits so concurrent completions/pauses/stops are never overwritten.
				if (recoveredTokenIds.length > 0) {
					const latestRec = missions.getMission(rec.id);
					if (latestRec?.runtime?.status === 'running') {
						const latestState = this.ensureSynchronizedState(latestRec);
						const now = Date.now();
						let updatedTokens: Record<string, IMissionToken> | undefined;
						for (const tid of recoveredTokenIds) {
							const liveTok = latestState.tokens[tid];
							if (liveTok?.status === 'active') {
								updatedTokens ??= { ...latestState.tokens };
								updatedTokens[tid] = { ...liveTok, lastActivityAt: now };
							}
						}
						if (updatedTokens) {
							this.commitState(latestRec.id, { ...latestState, tokens: updatedTokens, updatedAt: now });
						}
					}
				}
			}

			// Recover interrupted active Orchestration (`otok-*`) tokens across window reload/restart!
			// First reconcile against main-process headless daemon state (pause/resume/abort) and drain any pending headless effects.
			if (hasOrchTokens) {
				let latestOrchRec = missions.getMission(rec.id) ?? rec;
				if (this.backendService?.getOrchestrationDaemonState) {
					const daemonMap = await this.backendService.getOrchestrationDaemonState(rec.id).catch(() => undefined);
					const daemonSnap = daemonMap?.[rec.id];
					const localUpdatedAt = latestOrchRec.orchestrationRuntime?.updatedAt ?? 0;
					if (daemonSnap && daemonSnap.updatedAt > localUpdatedAt) {
						const curOrch = this.ensureSynchronizedOrchestrationState(latestOrchRec);
						if (daemonSnap.status === 'paused' || daemonSnap.status === 'aborted') {
							const reconciled = daemonSnap.status === 'paused'
								? pauseOrchestration(curOrch, { reason: daemonSnap.pausedReason, now: daemonSnap.updatedAt })
								: abortOrchestrationTokens(curOrch, { reason: daemonSnap.pausedReason || 'Aborted via headless daemon', now: daemonSnap.updatedAt });
							if (reconciled.ok) {
								this.commitOrchestrationState(rec.id, reconciled.state);
							}
							continue;
						} else if (daemonSnap.status === 'running' && curOrch.status === 'paused') {
							const reconciled = resumeOrchestration(curOrch, { now: daemonSnap.updatedAt });
							if (reconciled.ok) {
								this.commitOrchestrationState(rec.id, reconciled.state);
							}
						}
					}
				}
				latestOrchRec = missions.getMission(rec.id) ?? rec;
				const orchState = this.ensureSynchronizedOrchestrationState(latestOrchRec);
				if (orchState.status === 'paused' || orchState.status === 'aborted') {
					continue;
				}
				// Drain durable effects queued while 0 workbench windows were open (e.g. headless token return / Join Barrier wakeup / Inbox delivery).
				const freshlyDispatchedTokenIds = new Set<string>();
				if (orchState.pendingHeadlessEffects && orchState.pendingHeadlessEffects.length > 0) {
					const queuedEffects = [...orchState.pendingHeadlessEffects];
					const drainedState: IOrchestrationRuntimeState = {
						...orchState,
						pendingHeadlessEffects: undefined,
						updatedAt: Math.max(Date.now(), orchState.updatedAt + 1),
					};
					this.commitOrchestrationState(latestOrchRec.id, drainedState);
					for (const eff of queuedEffects) {
						if (eff.kind === 'dispatch_token') {
							freshlyDispatchedTokenIds.add(eff.tokenId);
						}
					}
					await this.executeOrchestrationEffects(latestOrchRec, queuedEffects);
					resumedCount += queuedEffects.filter(e => e.kind === 'dispatch_token').length;
				}
				latestOrchRec = missions.getMission(rec.id) ?? latestOrchRec;
				const postDrainOrch = this.ensureSynchronizedOrchestrationState(latestOrchRec);
				const orchGraph = parseOrchestrationGraph(latestOrchRec.orchestrationText ?? '');
				const recoveredOrchTokenIds: string[] = [];
				for (const tok of Object.values(postDrainOrch.tokens)) {
					if (tok.status !== 'active' || freshlyDispatchedTokenIds.has(tok.id)) {
						continue;
					}
					const targetAgentId = postDrainOrch.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId;
					if (!targetAgentId || (this.activeTurnsByAgent.get(targetAgentId) ?? 0) > 0) {
						continue;
					}
					const queued = this.pendingDispatchesByAgent.get(targetAgentId);
					if (queued?.some(item => item.options?.tokenId === tok.id && item.options?.missionId === rec.id)) {
						continue;
					}
					const agent = projects.getAgent(targetAgentId);
					if (!agent) {
						continue;
					}
					const staffNode = orchGraph.nodes.find(n => n.id === tok.nodeId && n.kind === 'staff');
					const isRemoteAgent = agent.projectUri.scheme === AEXUS_SSH_SCHEME;
					const recoveryPrompt = [
						`[Orchestration Restart Auto-Recovery · Staff \`${tok.nodeId}\` (${staffNode?.label ?? tok.nodeId}) · Token \`${tok.id}\`]`,
						`Aexus Code restarted/reloaded while you held active Orchestration baton \`${tok.id}\` (wave \`${tok.waveId}\`).`,
						tok.lastSummary ? `- Current directive headline: ${tok.lastSummary}` : '',
						tok.payloadPtr ? `- Read detail pointer: \`aexus-ade token read ${tok.payloadPtr} --mission ${rec.id} --token ${tok.id} --json\`` : '',
						`Continue advancing your work and explicitly submit via \`token return\`, \`token handoff\`, \`token mint\`, or \`token complete --finish\`.`,
					].filter(Boolean).join('\n');
					const dispatched = await this.dispatchPromptToAgent(targetAgentId, recoveryPrompt, {
						autonomousApproved: true,
						missionId: rec.id,
						tokenId: tok.id,
						nodeId: tok.nodeId,
						dedupeKey: `recover-orch:${rec.id}:${tok.id}`,
						...(isRemoteAgent ? { preferReattach: true } : {}),
					});
					if (dispatched) {
						resumedCount++;
						this.inMemoryAgentActivityAt.set(targetAgentId, Date.now());
						recoveredOrchTokenIds.push(tok.id);
					}
				}
				if (recoveredOrchTokenIds.length > 0) {
					const freshRec = missions.getMission(rec.id);
					if (freshRec?.orchestrationRuntime && freshRec.orchestrationRuntime.status !== 'paused') {
						const latestOrch = this.ensureSynchronizedOrchestrationState(freshRec);
						const now = Date.now();
						let updatedOrchTokens: Record<string, IOrchestrationToken> | undefined;
						for (const tid of recoveredOrchTokenIds) {
							const liveTok = latestOrch.tokens[tid];
							if (liveTok?.status === 'active') {
								updatedOrchTokens ??= { ...latestOrch.tokens };
								updatedOrchTokens[tid] = { ...liveTok, lastActivityAt: now };
							}
						}
						if (updatedOrchTokens) {
							this.commitOrchestrationState(freshRec.id, { ...latestOrch, tokens: updatedOrchTokens, updatedAt: now });
						}
					}
				}
			}
		}
		return resumedCount;
	}

	async recallTokens(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly nodeIds?: readonly string[]; readonly branchRootNodeId?: string; readonly reason?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const prevState = this.ensureSynchronizedState(rec);
		const result = recallMissionTokens(prevState, graph, params);
		if (result.ok) {
			this.commitState(rec.id, result.state);
			this.flushPendingDispatchesForReleasedAgents(prevState, result.state);
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async patchMermaid(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly newMermaidText: string; readonly reason?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const prevState = this.ensureSynchronizedState(rec);
		const result = applySafeMissionPatch(prevState, graph, params);
		if (result.ok) {
			// Apply new Mermaid first so locked sidebar employees are created for any added nodes,
			// then synchronize runtime assignments/tokens and hydrate newly minted dispatch effects before executing!
			this.missionService?.updateMermaid(rec.id, params.newMermaidText);
			const refreshed = this.requireMission(rec.id);
			const nextGraph = parseMissionMermaidDag(params.newMermaidText);
			const synchronizedBase = this.ensureSynchronizedState({ ...refreshed, runtime: result.state });
			const withBaseline = (synchronizedBase.revisions?.length ?? 0) === 0
				? appendMissionDagRevision(synchronizedBase, rec.mermaidText, 'Initial topology (v1)', undefined, graph)
				: synchronizedBase;
			const synchronized = appendMissionDagRevision(
				withBaseline,
				params.newMermaidText,
				params.reason ?? 'Dynamic DAG patch',
				graph,
				nextGraph,
			);
			this.commitState(rec.id, synchronized);
			this.flushPendingDispatchesForReleasedAgents(prevState, synchronized);
			const latest = this.requireMission(rec.id);
			const hydratedEffects: MissionEngineEffect[] = result.effects
				.filter(e => e.kind !== 'mermaid_patched')
				.map(eff => {
					if (eff.kind === 'dispatch_token' || eff.kind === 'wakeup_agent') {
						const boundAgentId = synchronized.boundary.nodeAssignments[eff.nodeId]?.agentId
							?? synchronized.tokens[eff.tokenId]?.holderAgentId
							?? eff.holderAgentId;
						return boundAgentId !== eff.holderAgentId ? { ...eff, holderAgentId: boundAgentId } : eff;
					}
					return eff;
				});
			await this.executeEffects(latest, hydratedEffects);
			return { ...result, state: synchronized, effects: hydratedEffects };
		}
		return result;
	}

	listTriggers(missionId: string): readonly IMissionSourceTrigger[] {
		const rec = this.requireMission(missionId);
		return this.ensureSynchronizedState(rec).triggers;
	}

	async setTrigger(
		missionId: string,
		triggerInput: Partial<IMissionSourceTrigger> & { readonly nodeId: string; readonly kind: IMissionSourceTrigger['kind'] },
		caller: IMissionEngineCaller,
	): Promise<{ readonly ok: boolean; readonly trigger?: IMissionSourceTrigger; readonly error?: string; readonly code?: string }> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const state = this.ensureSynchronizedState(rec);

		const jurisdiction = resolveSupervisorJurisdiction(
			state.boundary,
			caller.sessionId ?? '',
			graph.nodes.map(n => n.id),
			{ isHumanUser: caller.isHumanUser, isSecretary: caller.isSecretary, ownerSessionId: rec.ownerSessionId },
		);
		if (!jurisdiction.hasFullJurisdiction && !jurisdiction.nodeIds.has(triggerInput.nodeId)) {
			return {
				ok: false,
				code: 'OUT_OF_JURISDICTION',
				error: `Caller lacks off-graph jurisdiction to configure triggers on source node "${triggerInput.nodeId}".`,
			};
		}

		const candidate: IMissionSourceTrigger = {
			id: triggerInput.id?.trim() || `trig-${generateUuid().slice(0, 8)}`,
			nodeId: triggerInput.nodeId.trim(),
			kind: triggerInput.kind,
			enabled: triggerInput.enabled !== false,
			...(triggerInput.fireAt !== undefined ? { fireAt: triggerInput.fireAt } : {}),
			...(triggerInput.intervalMs !== undefined ? { intervalMs: triggerInput.intervalMs } : {}),
			...(triggerInput.cronExpr ? { cronExpr: triggerInput.cronExpr.trim() } : {}),
			...(triggerInput.eventType ? { eventType: triggerInput.eventType } : {}),
			...(triggerInput.targetPath ? { targetPath: triggerInput.targetPath.trim() } : {}),
			...(triggerInput.hostAlias ? { hostAlias: triggerInput.hostAlias.trim() } : {}),
			...(triggerInput.gpuUtilThresholdPct !== undefined ? { gpuUtilThresholdPct: triggerInput.gpuUtilThresholdPct } : {}),
			...(triggerInput.autoStartOnMissionStart !== undefined ? { autoStartOnMissionStart: triggerInput.autoStartOnMissionStart } : {}),
			lastFiredAt: triggerInput.lastFiredAt,
			fireCount: triggerInput.fireCount ?? 0,
		};

		const validationErr = validateSourceTrigger(graph, candidate);
		if (validationErr) {
			return { ok: false, code: 'INVALID_DAG', error: validationErr };
		}

		const existingIdx = state.triggers.findIndex(t => t.id === candidate.id);
		const nextTriggers = existingIdx >= 0
			? state.triggers.map((t, idx) => idx === existingIdx ? candidate : t)
			: [...state.triggers, candidate];
		const nextState: IMissionRuntimeState = {
			...state,
			triggers: nextTriggers,
			updatedAt: Date.now(),
		};
		this.commitState(rec.id, nextState);
		return { ok: true, trigger: candidate };
	}

	async removeTrigger(
		missionId: string,
		triggerId: string,
		caller: IMissionEngineCaller,
	): Promise<{ readonly ok: boolean; readonly removedId?: string; readonly error?: string; readonly code?: string }> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const state = this.ensureSynchronizedState(rec);
		const existing = state.triggers.find(t => t.id === triggerId);
		if (!existing) {
			return { ok: false, code: 'NOT_FOUND', error: `Trigger "${triggerId}" not found.` };
		}
		const jurisdiction = resolveSupervisorJurisdiction(
			state.boundary,
			caller.sessionId ?? '',
			graph.nodes.map(n => n.id),
			{ isHumanUser: caller.isHumanUser, isSecretary: caller.isSecretary, ownerSessionId: rec.ownerSessionId },
		);
		if (!jurisdiction.hasFullJurisdiction && !jurisdiction.nodeIds.has(existing.nodeId)) {
			return {
				ok: false,
				code: 'OUT_OF_JURISDICTION',
				error: `Caller lacks off-graph jurisdiction to remove trigger "${triggerId}" on node "${existing.nodeId}".`,
			};
		}
		const nextState: IMissionRuntimeState = {
			...state,
			triggers: state.triggers.filter(t => t.id !== triggerId),
			updatedAt: Date.now(),
		};
		this.commitState(rec.id, nextState);
		return { ok: true, removedId: triggerId };
	}

	touchAgentActivity(sessionResourceOrAgentId: string, timestamp = Date.now()): void {
		const projects = this.projectsService;
		const missions = this.missionService;
		if (!projects || !missions || !sessionResourceOrAgentId) {
			return;
		}
		const agent = projects.getAgent(sessionResourceOrAgentId)
			?? projects.agents.find(a => a.session?.resource.toString() === sessionResourceOrAgentId);
		if (!agent) {
			return;
		}
		// Keep activity timestamps strictly in memory and forward throttled updates to the watchdog daemon
		// without rewriting full Mission storage every 5s.
		this.inMemoryAgentActivityAt.set(agent.id, timestamp);
		const lastSync = this.lastHeartbeatSyncAt.get(agent.id) ?? 0;
		if (timestamp - lastSync < 5_000) {
			return;
		}
		this.lastHeartbeatSyncAt.set(agent.id, timestamp);

		for (const rec of missions.listMissions()) {
			const hasLegacyActive = rec.runtime?.status === 'running' && Object.values(rec.runtime.tokens).some(tok => {
				const assigned = rec.runtime!.boundary.nodeAssignments[tok.nodeId]?.agentId;
				return tok.status === 'active' && (tok.holderAgentId === agent.id || assigned === agent.id);
			});
			const hasOrchActive = Boolean(rec.orchestrationRuntime && Object.values(rec.orchestrationRuntime.tokens).some(tok => {
				const assigned = rec.orchestrationRuntime!.nodeAgentIds[tok.nodeId];
				return tok.status === 'active' && (tok.holderAgentId === agent.id || assigned === agent.id);
			}));
			if (hasLegacyActive || hasOrchActive) {
				this.syncWatchdog(rec.id, rec.runtime ?? this.ensureSynchronizedState(rec));
			}
		}
	}

	recordNodeTurnUsage(missionId: string, nodeId: string, usage: IMissionTurnUsageInput): void {
		const missions = this.missionService;
		if (!missions || !missionId || !nodeId) {
			return;
		}
		const rec = missions.getMission(missionId);
		if (!rec) {
			return;
		}
		const state = rec.runtime ?? (rec.orchestrationRuntime ? this.ensureSynchronizedState(rec) : undefined);
		if (!state) {
			return;
		}
		const nextState = recordMissionNodeTurnUsage(state, nodeId, usage, this.resolveNodePricingOptions(state, nodeId));
		const trippedNow = Boolean(nextState.budgetCircuitTripped && !state.budgetCircuitTripped);
		this.commitState(rec.id, nextState, trippedNow ? undefined : { deferPersist: true, skipWatchdogSync: true });
		if (trippedNow) {
			void this.stopActiveAgentsOnBudgetTrip(nextState);
			this.notifyBudgetCircuitTripped(rec, nextState);
		}
	}

	private registerTurnAttribution(entry: IMissionTurnAttribution): void {
		this.turnAttributionById.set(entry.turnId, entry);
		if (this.turnAttributionById.size > MAX_RETAINED_TURN_ATTRIBUTIONS) {
			const oldestKey = this.turnAttributionById.keys().next().value;
			if (oldestKey) {
				this.turnAttributionById.delete(oldestKey);
			}
		}
		this.inFlightTurnByAgent.set(entry.agentId, entry);
		if (entry.sessionResource) {
			this.inFlightTurnBySession.set(entry.sessionResource, entry);
		}
	}

	private finalizeTurnAttribution(turnId: string | undefined, now = Date.now()): void {
		if (!turnId) {
			return;
		}
		const entry = this.turnAttributionById.get(turnId);
		if (!entry) {
			return;
		}
		entry.finishedAt = now;
		if (this.inFlightTurnByAgent.get(entry.agentId)?.turnId === turnId) {
			this.inFlightTurnByAgent.delete(entry.agentId);
		}
		if (entry.sessionResource && this.inFlightTurnBySession.get(entry.sessionResource)?.turnId === turnId) {
			this.inFlightTurnBySession.delete(entry.sessionResource);
		}
		this.lastTurnByAgent.set(entry.agentId, entry);
		if (this.lastTurnByAgent.size > MAX_RETAINED_TURN_ATTRIBUTIONS) {
			const oldestAgent = this.lastTurnByAgent.keys().next().value;
			if (oldestAgent) {
				this.lastTurnByAgent.delete(oldestAgent);
			}
		}
		if (entry.sessionResource) {
			this.lastTurnBySession.set(entry.sessionResource, entry);
			if (this.lastTurnBySession.size > MAX_RETAINED_TURN_ATTRIBUTIONS) {
				const oldestSession = this.lastTurnBySession.keys().next().value;
				if (oldestSession) {
					this.lastTurnBySession.delete(oldestSession);
				}
			}
		}
	}

	private hasBlockingTokenForAgent(agentId: string, targetMissionId?: string, targetNodeId?: string): boolean {
		const missions = this.missionService;
		if (!missions || !agentId) {
			return false;
		}
		for (const rec of missions.listMissions()) {
			const state = rec.runtime;
			if (state && (state.status === 'running' || state.status === 'paused')) {
				for (const tok of Object.values(state.tokens)) {
					if (tok.status !== 'blocked' && tok.status !== 'active') {
						continue;
					}
					const holder = state.boundary.nodeAssignments[tok.nodeId]?.agentId ?? tok.holderAgentId;
					if (holder !== agentId) {
						continue;
					}
					if (targetMissionId && targetNodeId && rec.id === targetMissionId && tok.nodeId === targetNodeId) {
						continue;
					}
					return true;
				}
			}
			const orch = rec.orchestrationRuntime;
			if (orch && orch.status !== 'paused' && orch.status !== 'aborted') {
				for (const tok of Object.values(orch.tokens)) {
					if (tok.status !== 'blocked' && tok.status !== 'active') {
						continue;
					}
					const holder = orch.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId;
					if (holder !== agentId) {
						continue;
					}
					if (targetMissionId && targetNodeId && rec.id === targetMissionId && tok.nodeId === targetNodeId) {
						continue;
					}
					return true;
				}
			}
		}
		return false;
	}

	private flushPendingDispatchesForReleasedOrchAgents(prevState: IOrchestrationRuntimeState | undefined, nextState: IOrchestrationRuntimeState): void {
		if (!prevState || this.pendingDispatchesByAgent.size === 0) {
			return;
		}
		const collectLiveAgents = (state: IOrchestrationRuntimeState): Set<string> => {
			const live = new Set<string>();
			if (state.status === 'paused' || state.status === 'aborted') {
				return live;
			}
			for (const tok of Object.values(state.tokens)) {
				if (tok.status === 'active' || tok.status === 'blocked') {
					const holder = state.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId;
					if (holder) {
						live.add(holder);
					}
				}
			}
			return live;
		};
		const prevLive = collectLiveAgents(prevState);
		const nextLive = collectLiveAgents(nextState);
		for (const aid of prevLive) {
			if (!nextLive.has(aid) && this.pendingDispatchesByAgent.has(aid)) {
				this.flushNextQueuedDispatch(aid);
			}
		}
	}

	private flushPendingDispatchesForReleasedAgents(prevState: IMissionRuntimeState, nextState: IMissionRuntimeState): void {
		if (this.pendingDispatchesByAgent.size === 0) {
			return;
		}
		const collectLiveAgents = (state: IMissionRuntimeState): Set<string> => {
			const live = new Set<string>();
			if (state.status !== 'running' && state.status !== 'paused') {
				return live;
			}
			for (const tok of Object.values(state.tokens)) {
				if (tok.status === 'active' || tok.status === 'blocked') {
					const holder = state.boundary.nodeAssignments[tok.nodeId]?.agentId ?? tok.holderAgentId;
					if (holder) {
						live.add(holder);
					}
				}
			}
			return live;
		};
		const prevLive = collectLiveAgents(prevState);
		const nextLive = collectLiveAgents(nextState);
		for (const aid of prevLive) {
			if (!nextLive.has(aid) && this.pendingDispatchesByAgent.has(aid)) {
				this.flushNextQueuedDispatch(aid);
			}
		}
	}

	beginInteractiveTurn(sessionResourceOrAgentId: string): {
		readonly turnId: string;
		readonly missionId: string;
		readonly nodeId: string;
		readonly tokenId?: string;
	} | undefined {
		const projects = this.projectsService;
		const missions = this.missionService;
		const key = sessionResourceOrAgentId?.trim();
		if (!projects || !missions || !key) {
			return undefined;
		}
		const agent = projects.getAgent(key)
			?? projects.agents.find(a => a.session?.resource.toString() === key);
		if (!agent) {
			return undefined;
		}
		let blockedMatch: { readonly missionId: string; readonly nodeId: string; readonly tokenId: string } | undefined;
		for (const rec of missions.listMissions()) {
			const orch = rec.orchestrationRuntime;
			if (orch && orch.status !== 'paused' && orch.status !== 'aborted') {
				const activeOrchTok = Object.values(orch.tokens).find(tok => {
					const assigned = orch.nodeAgentIds[tok.nodeId];
					return tok.status === 'active' && (assigned === agent.id || (!assigned && tok.holderAgentId === agent.id));
				});
				if (activeOrchTok) {
					const now = Date.now();
					const turnId = `interactive-${++this.turnAttributionSeq}-${now.toString(36)}`;
					this.registerTurnAttribution({
						turnId,
						missionId: rec.id,
						nodeId: activeOrchTok.nodeId,
						tokenId: activeOrchTok.id,
						agentId: agent.id,
						sessionResource: agent.session?.resource.toString() ?? (key.includes(':') ? key : undefined),
						source: 'interactive',
						startedAt: now,
					});
					return {
						turnId,
						missionId: rec.id,
						nodeId: activeOrchTok.nodeId,
						tokenId: activeOrchTok.id,
					};
				}
				if (!blockedMatch) {
					const blockedOrchTok = Object.values(orch.tokens).find(tok => {
						const assigned = orch.nodeAgentIds[tok.nodeId];
						return tok.status === 'blocked' && (assigned === agent.id || (!assigned && tok.holderAgentId === agent.id));
					});
					if (blockedOrchTok) {
						blockedMatch = { missionId: rec.id, nodeId: blockedOrchTok.nodeId, tokenId: blockedOrchTok.id };
					}
				}
			}
			const state = rec.runtime;
			if (!state || state.status === 'completed' || state.status === 'stopped' || state.status === 'failed') {
				continue;
			}
			const activeTok = Object.values(state.tokens).find(tok => {
				const assigned = state.boundary.nodeAssignments[tok.nodeId]?.agentId;
				return tok.status === 'active' && (assigned === agent.id || (!assigned && tok.holderAgentId === agent.id));
			});
			if (activeTok) {
				const now = Date.now();
				const turnId = `interactive-${++this.turnAttributionSeq}-${now.toString(36)}`;
				this.registerTurnAttribution({
					turnId,
					missionId: rec.id,
					nodeId: activeTok.nodeId,
					tokenId: activeTok.id,
					agentId: agent.id,
					sessionResource: agent.session?.resource.toString() ?? (key.includes(':') ? key : undefined),
					source: 'interactive',
					startedAt: now,
				});
				return {
					turnId,
					missionId: rec.id,
					nodeId: activeTok.nodeId,
					tokenId: activeTok.id,
				};
			}
			if (!blockedMatch) {
				const blockedTok = Object.values(state.tokens).find(tok => {
					const assigned = state.boundary.nodeAssignments[tok.nodeId]?.agentId;
					return tok.status === 'blocked' && (assigned === agent.id || (!assigned && tok.holderAgentId === agent.id));
				});
				if (blockedTok) {
					blockedMatch = { missionId: rec.id, nodeId: blockedTok.nodeId, tokenId: blockedTok.id };
				}
			}
		}
		if (blockedMatch) {
			const now = Date.now();
			const turnId = `interactive-${++this.turnAttributionSeq}-${now.toString(36)}`;
			this.registerTurnAttribution({
				turnId,
				missionId: blockedMatch.missionId,
				nodeId: blockedMatch.nodeId,
				tokenId: blockedMatch.tokenId,
				agentId: agent.id,
				sessionResource: agent.session?.resource.toString() ?? (key.includes(':') ? key : undefined),
				source: 'interactive',
				startedAt: now,
			});
			return {
				turnId,
				missionId: blockedMatch.missionId,
				nodeId: blockedMatch.nodeId,
				tokenId: blockedMatch.tokenId,
			};
		}
		return undefined;
	}

	endInteractiveTurn(turnId: string): void {
		this.finalizeTurnAttribution(turnId?.trim());
	}

	recordTurnUsageBySessionResource(
		sessionResource: string,
		usage: IMissionTurnUsageInput,
		options?: {
			readonly turnId?: string;
			readonly missionId?: string;
			readonly nodeId?: string;
			readonly tokenId?: string;
		},
	): void {
		const missions = this.missionService;
		if (!missions) {
			return;
		}
		const explicitTurnId = options?.turnId?.trim() || usage.turnId?.trim();
		if (explicitTurnId) {
			const bound = this.turnAttributionById.get(explicitTurnId);
			if (bound) {
				this.recordNodeTurnUsage(bound.missionId, bound.nodeId, usage);
				return;
			}
		}
		const explicitMissionId = options?.missionId?.trim();
		const explicitNodeId = options?.nodeId?.trim();
		if (explicitMissionId && explicitNodeId) {
			this.recordNodeTurnUsage(explicitMissionId, explicitNodeId, usage);
			return;
		}
		const explicitTokenId = options?.tokenId?.trim() || usage.tokenId?.trim();
		if (explicitTokenId) {
			for (const rec of missions.listMissions()) {
				const tok = rec.runtime?.tokens[explicitTokenId];
				if (tok) {
					this.recordNodeTurnUsage(rec.id, tok.nodeId, usage);
					return;
				}
				const orchTok = rec.orchestrationRuntime?.tokens[explicitTokenId];
				if (orchTok) {
					this.recordNodeTurnUsage(rec.id, orchTok.nodeId, usage);
					return;
				}
			}
		}

		const projects = this.projectsService;
		if (!projects || !sessionResource) {
			return;
		}
		const key = sessionResource.trim();
		const agent = projects.getAgent(key)
			?? projects.agents.find(a => a.session?.resource.toString() === key);
		if (!agent) {
			return;
		}
		const agentSessionUri = agent.session?.resource.toString();

		// Priority 4: An in-flight bound turn for this session/agent always owns incoming usage deltas
		// (even if the employee already called `token complete` mid-turn and another node became active!).
		const inFlight = (agentSessionUri ? this.inFlightTurnBySession.get(agentSessionUri) : undefined)
			?? this.inFlightTurnBySession.get(key)
			?? this.inFlightTurnByAgent.get(agent.id);
		if (inFlight) {
			this.recordNodeTurnUsage(inFlight.missionId, inFlight.nodeId, usage);
			return;
		}

		// Priority 5: Active token OR recently-finished turn/token within delayed-callback grace window.
		// Never fall back to `assignedNodes[0]` when this employee actually executed a later node!
		const now = Date.now();
		const allMissions = missions.listMissions();
		let activeMatch: { readonly missionId: string; readonly nodeId: string; readonly arrivedAt: number } | undefined;
		let recentFinishedToken: { readonly missionId: string; readonly nodeId: string; readonly lastActivityAt: number } | undefined;

		for (const rec of allMissions) {
			const orch = rec.orchestrationRuntime;
			if (orch) {
				for (const oTok of Object.values(orch.tokens)) {
					const assigned = orch.nodeAgentIds[oTok.nodeId];
					if (oTok.holderAgentId !== agent.id && assigned !== agent.id) {
						continue;
					}
					if (oTok.status === 'active') {
						if (!activeMatch || oTok.arrivedAt >= activeMatch.arrivedAt) {
							activeMatch = { missionId: rec.id, nodeId: oTok.nodeId, arrivedAt: oTok.arrivedAt };
						}
					} else if ((now - oTok.lastActivityAt) <= DELAYED_TURN_USAGE_GRACE_MS) {
						if (!recentFinishedToken || oTok.lastActivityAt >= recentFinishedToken.lastActivityAt) {
							recentFinishedToken = { missionId: rec.id, nodeId: oTok.nodeId, lastActivityAt: oTok.lastActivityAt };
						}
					}
				}
			}
			const state = rec.runtime;
			if (!state) {
				continue;
			}
			const isLiveMission = state.status !== 'completed' && state.status !== 'stopped' && state.status !== 'failed';
			for (const tok of Object.values(state.tokens)) {
				const assigned = state.boundary.nodeAssignments[tok.nodeId]?.agentId;
				if (tok.holderAgentId !== agent.id && assigned !== agent.id) {
					continue;
				}
				if (isLiveMission && tok.status === 'active') {
					if (!activeMatch || tok.arrivedAt >= activeMatch.arrivedAt) {
						activeMatch = { missionId: rec.id, nodeId: tok.nodeId, arrivedAt: tok.arrivedAt };
					}
				} else if (
					(tok.status === 'completed' || tok.status === 'blocked' || tok.status === 'frozen_failed' || tok.status === 'recalled')
					&& (now - tok.lastActivityAt) <= DELAYED_TURN_USAGE_GRACE_MS
				) {
					if (!recentFinishedToken || tok.lastActivityAt >= recentFinishedToken.lastActivityAt) {
						recentFinishedToken = { missionId: rec.id, nodeId: tok.nodeId, lastActivityAt: tok.lastActivityAt };
					}
				}
			}
		}

		if (activeMatch) {
			this.recordNodeTurnUsage(activeMatch.missionId, activeMatch.nodeId, usage);
			return;
		}

		const lastBound = (agentSessionUri ? this.lastTurnBySession.get(agentSessionUri) : undefined)
			?? this.lastTurnBySession.get(key)
			?? this.lastTurnByAgent.get(agent.id);
		const lastBoundTime = lastBound?.finishedAt ?? lastBound?.startedAt ?? 0;
		const hasFreshLastBound = Boolean(lastBound && (now - lastBoundTime) <= DELAYED_TURN_USAGE_GRACE_MS);

		if (hasFreshLastBound && (!recentFinishedToken || lastBoundTime >= recentFinishedToken.lastActivityAt)) {
			this.recordNodeTurnUsage(lastBound!.missionId, lastBound!.nodeId, usage);
			return;
		}
		if (recentFinishedToken) {
			this.recordNodeTurnUsage(recentFinishedToken.missionId, recentFinishedToken.nodeId, usage);
			return;
		}

		// Priority 6: Unambiguous fallback ONLY when the employee owns a single node (or Mission is idle pre-run).
		// NEVER guess `assignedNodes[0]` on a live (`running`/`paused`) multi-node reused @Employee!
		for (const rec of allMissions) {
			const state = rec.runtime;
			if (!state || state.status === 'completed' || state.status === 'stopped' || state.status === 'failed') {
				continue;
			}
			const assignedNodes = Object.entries(state.boundary.nodeAssignments)
				.filter(([, assign]) => assign.agentId === agent.id)
				.map(([nid]) => nid);
			if (assignedNodes.length === 1 || (state.status === 'idle' && assignedNodes.length > 0)) {
				this.recordNodeTurnUsage(rec.id, assignedNodes[0], usage);
				return;
			}
		}
	}

	private async handleWatchdogWakeup(ev: IAdeWatchdogWakeupEvent): Promise<void> {
		const rec = this.missionService?.getMission(ev.missionId);
		if (!rec) {
			return;
		}
		// 1. Check Orchestration cyclic re-entrant token watchdog first (5-minute repeating reminder; never freezes/destroys!).
		if (rec.orchestrationRuntime?.tokens[ev.tokenId]) {
			const orchState = this.ensureSynchronizedOrchestrationState(rec);
			const result = (ev.reason === 'block_expired' || ev.reason === 'pid_exited' || ev.reason === 'file_ready')
				? wakeBlockedOrchestrationToken(orchState, {
					tokenId: ev.tokenId,
					reason: ev.reason,
					detail: ev.detail,
					now: ev.timestamp,
				})
				: recordOrchestrationSilenceReminder(orchState, {
					tokenId: ev.tokenId,
					detail: ev.detail,
					now: ev.timestamp,
				});
			if (result.ok) {
				this.commitOrchestrationState(rec.id, result.state);
				await this.executeOrchestrationEffects(rec, result.effects);
			}
			return;
		}
		// 2. Legacy Mission DAG watchdog path
		if (rec.runtime?.status !== 'running') {
			return;
		}
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = recordWatchdogWakeup(rec.runtime, {
			tokenId: ev.tokenId,
			reason: ev.reason,
			detail: ev.detail,
			graph,
			owner: { ownerSessionId: rec.ownerSessionId, ownerTier: rec.ownerTier },
			now: ev.timestamp,
		});
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
	}

	private async handleSourceTriggerFire(ev: IAdeSourceTriggerFireEvent): Promise<void> {
		const rec = this.missionService?.getMission(ev.missionId);
		if (!rec || rec.runtime?.status !== 'running') {
			return;
		}
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = fireMissionSourceTrigger(rec.runtime, graph, {
			triggerId: ev.triggerId,
			payloadSummary: ev.detail,
			now: ev.timestamp,
		});
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
	}

	private async ensureAgentSessionReady(agent: IAdeAgent): Promise<URI | undefined> {
		if (agent.session?.resource) {
			return agent.session.resource;
		}
		const sessions = this.sessionsService;
		const projects = this.projectsService;
		if (!sessions || !projects) {
			return undefined;
		}
		const available = await sessions.getEngines(agent.projectUri).catch(() => []);
		const engineId = normalizeAdeEngineId(agent.preferredEngineId) || available[0]?.id;
		if (!engineId) {
			return undefined;
		}
		const created = await sessions.create(engineId, agent.projectUri).catch(() => undefined);
		if (!created) {
			return undefined;
		}
		projects.bindSession(agent.id, created);
		return created.resource;
	}

	private isTransientDispatchError(errMsg: string): boolean {
		return /\b(502|503|504|429|520|522|524)\b|upstream connection failed|urlerror|tls handshake timeout|econnreset|etimedout|econnrefused|epipe|socket hang up|context deadline exceeded|temporarily unavailable|overloaded|rate limit|network error|\beof\b|exited with code 255|exit code 255|broken pipe|connection closed by remote host|client_loop|ssh_exchange_identification|kex_exchange_identification|network is unreachable|no route to host|host is down|connection timed out/i.test(errMsg);
	}

	private flushNextQueuedDispatch(agentId: string): void {
		if ((this.activeTurnsByAgent.get(agentId) ?? 0) > 0) {
			return;
		}
		const queue = this.pendingDispatchesByAgent.get(agentId);
		if (!queue || queue.length === 0) {
			return;
		}
		const deferredPaused: typeof queue = [];
		while (queue.length > 0) {
			const next = queue.shift()!;
			if (next.options?.missionId && next.options?.tokenId) {
				const rec = this.missionService?.getMission(next.options.missionId);
				const orchTok = rec?.orchestrationRuntime?.tokens[next.options.tokenId];
				if (orchTok) {
					if (rec?.orchestrationRuntime?.status === 'paused') {
						deferredPaused.push(next);
						continue;
					}
					if (orchTok.status !== 'active') {
						continue;
					}
				} else {
					const tok = rec?.runtime?.tokens[next.options.tokenId];
					if (!rec || !tok || tok.status !== 'active') {
						continue;
					}
					if (rec.runtime?.status === 'paused') {
						// Preserve queued turns for paused Missions so resume() dispatches them immediately.
						deferredPaused.push(next);
						continue;
					}
					if (rec.runtime?.status !== 'running') {
						continue;
					}
				}
			}
			// Respect cross-mission blocked-token session exclusivity: never inject a prompt into an employee
			// whose underlying session is currently suspended in another Mission's `blocked` node.
			if (this.hasBlockingTokenForAgent(agentId, next.options?.missionId, next.options?.nodeId)) {
				deferredPaused.push(next);
				continue;
			}
			if (deferredPaused.length > 0) {
				queue.unshift(...deferredPaused);
			}
			if (queue.length === 0) {
				this.pendingDispatchesByAgent.delete(agentId);
			}
			void this.dispatchPromptToAgent(agentId, next.prompt, next.options).then(dispatched => {
				if (dispatched) {
					return;
				}
				if (next.options?.onDispatchError) {
					next.options.onDispatchError(`Queued dispatch failed: agent "${agentId}" or its session is unavailable.`);
				} else if (next.options?.missionId && next.options?.tokenId) {
					const failReason = `Unable to dispatch queued token ${next.options.tokenId} on node ${next.options.nodeId ?? ''} (agent "${agentId}" unavailable).`;
					if (next.options.tokenId.startsWith('otok-')) {
						void this.failOrchestrationToken(next.options.missionId, { tokenId: next.options.tokenId, reason: failReason }).catch(() => undefined);
					} else {
						void this.failToken(next.options.missionId, { tokenId: next.options.tokenId, reason: failReason }).catch(() => undefined);
					}
				}
			}, err => {
				const reason = err instanceof Error ? err.message : String(err ?? 'Queued dispatch error');
				if (next.options?.onDispatchError) {
					next.options.onDispatchError(reason);
				} else if (next.options?.missionId && next.options?.tokenId) {
					const failReason = `Queued dispatch error on node ${next.options.nodeId ?? ''}: ${reason.slice(0, 300)}`;
					if (next.options.tokenId.startsWith('otok-')) {
						void this.failOrchestrationToken(next.options.missionId, { tokenId: next.options.tokenId, reason: failReason }).catch(() => undefined);
					} else {
						void this.failToken(next.options.missionId, { tokenId: next.options.tokenId, reason: failReason }).catch(() => undefined);
					}
				}
			});
			return;
		}
		if (deferredPaused.length > 0) {
			this.pendingDispatchesByAgent.set(agentId, deferredPaused);
		} else {
			this.pendingDispatchesByAgent.delete(agentId);
		}
	}

	private async dispatchPromptToAgent(
		agentId: string | undefined,
		prompt: string,
		options?: {
			readonly autonomousApproved?: boolean;
			readonly missionId?: string;
			readonly tokenId?: string;
			readonly nodeId?: string;
			readonly requireLiveDelivery?: boolean;
			readonly dedupeKey?: string;
			readonly retryAttempt?: number;
			readonly preferReattach?: boolean;
			readonly isNoiseTurn?: boolean;
			readonly onDispatchError?: (reason: string) => void;
		},
	): Promise<boolean> {
		if (!agentId || !this.projectsService || !this.commandService) {
			return false;
		}
		if (agentId === ADE_SECRETARY_ID) {
			const secSession = this.projectsService.secretary.session;
			if (!secSession) {
				this.projectsService.setSecretaryDraft(prompt);
				// Never hide critical escalations behind an unread draft when a live delivery is required.
				return options?.requireLiveDelivery ? false : true;
			}
			void this.commandService.executeCommand('aexus.agentEngines.dispatchEngineeringTurn', secSession.resource, prompt, {
				agentId: ADE_SECRETARY_ID,
				pureWorker: false,
				callerRole: 'secretary',
				autonomousApproved: options?.autonomousApproved ?? true,
			}).catch(err => {
				const errMsg = err instanceof Error ? err.message : String(err ?? 'Unknown Secretary dispatch error');
				options?.onDispatchError?.(errMsg);
			});
			return true;
		}
		const agent = this.projectsService.getAgent(agentId);
		if (!agent) {
			return false;
		}
		const trackedMissionId = options?.missionId;
		const trackedTokenId = options?.tokenId;
		const trackedNodeId = options?.nodeId;
		const dedupeKey = options?.dedupeKey ?? (trackedMissionId && trackedTokenId ? `${trackedMissionId}:${trackedTokenId}` : undefined);

		const enqueueForAgent = () => {
			const queue = this.pendingDispatchesByAgent.get(agent.id) ?? [];
			const alreadyQueued = dedupeKey
				? queue.some(item => (item.options?.dedupeKey ?? (item.options?.missionId && item.options?.tokenId ? `${item.options.missionId}:${item.options.tokenId}` : undefined)) === dedupeKey)
				: false;
			if (!alreadyQueued) {
				queue.push({ prompt, options });
				this.pendingDispatchesByAgent.set(agent.id, queue);
			}
		};

		// Serialize ALL dispatches onto the same agent (both multi-position Mission tokens, cross-mission
		// blocked-session protection, AND concurrent supervisor/Governor escalations!) so a second arrival
		// NEVER force-cancels an in-flight turn or contaminates a suspended blocked session.
		if (
			(this.activeTurnsByAgent.get(agent.id) ?? 0) > 0
			|| this.hasBlockingTokenForAgent(agent.id, trackedMissionId, trackedNodeId)
		) {
			enqueueForAgent();
			return true;
		}

		// Reserve the agent's slot BEFORE awaiting async session creation so concurrent calls arriving
		// within milliseconds (e.g., two parallel nodes failing simultaneously) queue cleanly instead of racing!
		this.activeTurnsByAgent.set(agent.id, 1);
		let slotClaimed = true;
		const releaseSlot = () => {
			if (!slotClaimed) {
				return;
			}
			slotClaimed = false;
			const remaining = Math.max(0, (this.activeTurnsByAgent.get(agent.id) ?? 1) - 1);
			if (remaining === 0) {
				this.activeTurnsByAgent.delete(agent.id);
				this.projectsService?.setAgentStatus(agent.id, 'idle');
				this.flushNextQueuedDispatch(agent.id);
			} else {
				this.activeTurnsByAgent.set(agent.id, remaining);
			}
		};

		let resource: URI | undefined;
		try {
			resource = await this.ensureAgentSessionReady(agent);
		} catch {
			releaseSlot();
			return false;
		}
		if (!resource) {
			releaseSlot();
			return false;
		}

		// Re-validate Mission/Orchestration & token liveness after async session creation so stopped/paused/recalled tokens never fire stale turns.
		if (trackedMissionId && trackedTokenId) {
			const freshRec = this.missionService?.getMission(trackedMissionId);
			const freshOrchTok = freshRec?.orchestrationRuntime?.tokens[trackedTokenId];
			if (freshOrchTok) {
				if (freshOrchTok.status !== 'active') {
					releaseSlot();
					return true;
				}
			} else {
				const freshTok = freshRec?.runtime?.tokens[trackedTokenId];
				if (!freshRec || freshRec.runtime?.status !== 'running' || !freshTok || freshTok.status !== 'active') {
					releaseSlot();
					return true;
				}
			}
		}

		const rankDef = resolveEffectiveRankDefinition(this.orgConfig, agent.role, this.projectsService.hasSubordinates(agent.id));
		const boundTurnId = trackedMissionId && trackedNodeId
			? `dispatch-${++this.turnAttributionSeq}-${Date.now().toString(36)}`
			: undefined;
		if (boundTurnId && trackedMissionId && trackedNodeId) {
			this.registerTurnAttribution({
				turnId: boundTurnId,
				missionId: trackedMissionId,
				nodeId: trackedNodeId,
				tokenId: trackedTokenId,
				agentId: agent.id,
				sessionResource: resource.toString(),
				source: 'dispatch',
				startedAt: Date.now(),
			});
		}
		this.projectsService.setAgentStatus(agent.id, 'working');
		void this.commandService.executeCommand<{
			readonly reply?: string;
			readonly stopped?: boolean;
			readonly usage?: IMissionTurnUsageInput;
		} | undefined>('aexus.agentEngines.dispatchEngineeringTurn', resource, prompt, {
			agentId: agent.id,
			missionId: trackedMissionId,
			nodeId: trackedNodeId,
			tokenId: trackedTokenId,
			turnId: boundTurnId,
			model: agent.preferredModel,
			thinking: agent.preferredThinking,
			pureWorker: false,
			isMissionNode: Boolean(trackedNodeId || agent.treeNodeId || (agent.treeNodeIds && agent.treeNodeIds.length > 0)),
			callerRole: rankDef.id,
			autonomousApproved: options?.autonomousApproved ?? true,
			...(options?.preferReattach ? { preferReattach: true } : {}),
		}).then(
			turnRes => {
				if (trackedMissionId && trackedTokenId) {
					this.transientRetryCount.delete(`${trackedMissionId}:${trackedTokenId}`);
				}
				// Record this turn's final usage BEFORE releasing the agent's slot / flushing the next queued turn
				// so delayed or sequential handoff turns never race or cross-bill onto the wrong node.
				if (turnRes && typeof turnRes === 'object') {
					const latestAgent = this.projectsService?.getAgent(agent.id) ?? agent;
					const conciseReply = typeof turnRes.reply === 'string' && turnRes.reply.trim()
						? turnRes.reply.trim().split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 120)
						: undefined;
					if (turnRes.usage || conciseReply) {
						const payload: IMissionTurnUsageInput = {
							...(turnRes.usage ?? {}),
							...(boundTurnId ? { turnId: boundTurnId } : {}),
							...(trackedTokenId ? { tokenId: trackedTokenId } : {}),
							...(turnRes.usage?.isNoiseTurn === undefined && options?.isNoiseTurn ? { isNoiseTurn: true } : {}),
							model: turnRes.usage?.model || latestAgent.preferredModel,
							engineId: turnRes.usage?.engineId || latestAgent.session?.engineId || latestAgent.preferredEngineId,
							...(conciseReply ? { summary: conciseReply } : {}),
						};
						if (trackedMissionId && trackedNodeId) {
							this.recordNodeTurnUsage(trackedMissionId, trackedNodeId, payload);
						} else {
							this.recordTurnUsageBySessionResource(resource.toString(), payload, {
								turnId: boundTurnId,
								tokenId: trackedTokenId,
							});
						}
					}
				}
				this.finalizeTurnAttribution(boundTurnId);
				releaseSlot();
				// If this was a Mission node turn and the agent finished without closing its active token,
				// send a fast follow-up reminder (up to 2x) so low-thinking workers don't stall for the full silence window.
				if (trackedMissionId && trackedTokenId && trackedNodeId && !turnRes?.stopped) {
					this.scheduleUnclosedTokenCheck(trackedMissionId, trackedTokenId, trackedNodeId, agent.id);
				}
			},
			err => {
				this.finalizeTurnAttribution(boundTurnId);
				releaseSlot();
				const errMsg = err instanceof Error ? err.message : String(err ?? 'Unknown engine dispatch error');
				const isTransient = this.isTransientDispatchError(errMsg);

				// Auto-retry transient upstream/gateway errors (502/503/504/429/URLError/TLS timeout) with exponential backoff
				// before failing an Orchestration baton or freezing a Mission node.
				if (trackedMissionId && trackedTokenId) {
					const retryKey = `${trackedMissionId}:${trackedTokenId}`;
					const rec = this.missionService?.getMission(trackedMissionId);
					const orchTok = rec?.orchestrationRuntime?.tokens[trackedTokenId];
					if (orchTok) {
						if (rec?.orchestrationRuntime?.status !== 'paused' && orchTok.status === 'active') {
							const prevAttempts = this.transientRetryCount.get(retryKey) ?? 0;
							const backoffsMs = [8_000, 20_000, 45_000];
							if (isTransient && prevAttempts < backoffsMs.length) {
								const attempt = prevAttempts + 1;
								const delayMs = backoffsMs[prevAttempts];
								this.transientRetryCount.set(retryKey, attempt);
								this.touchAgentActivity(agent.id, Date.now());
								const retryTimer = setTimeout(() => {
									this.pendingTurnNudgeTimers.delete(retryTimer);
									const latestRec = this.missionService?.getMission(trackedMissionId);
									const latestOrch = latestRec?.orchestrationRuntime;
									const latestTok = latestOrch?.tokens[trackedTokenId];
									if (!latestRec || !latestOrch || latestOrch.status === 'paused' || !latestTok || latestTok.status !== 'active') {
										this.transientRetryCount.delete(retryKey);
										return;
									}
									this.touchAgentActivity(agent.id, Date.now());
									const retryPrompt = [
										`[Automatic Transient Error Recovery #${attempt}/${backoffsMs.length} · Staff \`${trackedNodeId ?? latestTok.nodeId}\` · Baton \`${trackedTokenId}\`]`,
										`Your previous turn was interrupted by a transient gateway/network error (\`${errMsg.slice(0, 220)}\`).`,
										`Inspect your workspace (keep any files you already wrote), finish remaining work, and advance baton \`${trackedTokenId}\` via \`aexus-ade token return|handoff|mint|complete --mission ${trackedMissionId}\`.`,
									].join('\n');
									void this.dispatchPromptToAgent(agent.id, retryPrompt, {
										...options,
										retryAttempt: attempt,
										isNoiseTurn: true,
									});
								}, delayMs);
								this.pendingTurnNudgeTimers.add(retryTimer);
								return;
							}
							this.transientRetryCount.delete(retryKey);
							this.unclosedTurnNudgeCount.delete(retryKey);
							void this.failOrchestrationToken(trackedMissionId, {
								tokenId: trackedTokenId,
								reason: `Engine dispatch error on staff ${trackedNodeId ?? orchTok.nodeId}: ${errMsg.slice(0, 400)}`,
							}).catch(() => undefined);
						}
						return;
					}
					const tok = rec?.runtime?.tokens[trackedTokenId];
					if (rec?.runtime?.status === 'running' && tok?.status === 'active') {
						const prevAttempts = this.transientRetryCount.get(retryKey) ?? 0;
						const backoffsMs = [8_000, 20_000, 45_000];
						if (isTransient && prevAttempts < backoffsMs.length) {
							const attempt = prevAttempts + 1;
							const delayMs = backoffsMs[prevAttempts];
							this.transientRetryCount.set(retryKey, attempt);
							this.touchAgentActivity(agent.id, Date.now());
							const retryTimer = setTimeout(() => {
								this.pendingTurnNudgeTimers.delete(retryTimer);
								const latestRec = this.missionService?.getMission(trackedMissionId);
								const latestTok = latestRec?.runtime?.tokens[trackedTokenId];
								if (!latestRec || latestRec.runtime?.status !== 'running' || !latestTok || latestTok.status !== 'active') {
									this.transientRetryCount.delete(retryKey);
									return;
								}
								this.touchAgentActivity(agent.id, Date.now());
								const retryPrompt = [
									`[Automatic Transient Error Recovery #${attempt}/${backoffsMs.length} · Node \`${trackedNodeId ?? latestTok.nodeId}\` · Token \`${trackedTokenId}\`]`,
									`Your previous turn was interrupted by a transient gateway/network error (\`${errMsg.slice(0, 220)}\`).`,
									`Inspect your workspace (keep any files you already wrote), finish remaining deliverables & tests, and close token \`${trackedTokenId}\` via \`aexus-ade token complete ${trackedTokenId} --summary "..."\`.`,
								].join('\n');
								void this.dispatchPromptToAgent(agent.id, retryPrompt, {
									...options,
									retryAttempt: attempt,
									isNoiseTurn: true,
								});
							}, delayMs);
							this.pendingTurnNudgeTimers.add(retryTimer);
							return;
						}
						this.transientRetryCount.delete(retryKey);
						this.unclosedTurnNudgeCount.delete(retryKey);
						void this.failToken(trackedMissionId, {
							tokenId: trackedTokenId,
							reason: `Engine dispatch error on node ${trackedNodeId ?? tok.nodeId}: ${errMsg.slice(0, 400)}`,
						}).catch(() => undefined);
					}
					return;
				}

				const escAttempt = options?.retryAttempt ?? 0;
				const escBackoffsMs = [10_000, 25_000];
				if (isTransient && options?.requireLiveDelivery && escAttempt < escBackoffsMs.length) {
					const delayMs = escBackoffsMs[escAttempt];
					const retryTimer = setTimeout(() => {
						this.pendingTurnNudgeTimers.delete(retryTimer);
						void this.dispatchPromptToAgent(agent.id, prompt, {
							...options,
							retryAttempt: escAttempt + 1,
						});
					}, delayMs);
					this.pendingTurnNudgeTimers.add(retryTimer);
					return;
				}

				options?.onDispatchError?.(errMsg);
			},
		);
		return true;
	}

	private scheduleUnclosedTokenCheck(missionId: string, tokenId: string, nodeId: string, agentId: string): void {
		const nudgeKey = `${missionId}:${tokenId}`;
		// Orchestration baton tokens: send ONE fast post-turn nudge (8s) if the employee ended its turn
		// without advancing an active baton (and isn't waiting on live async child tokens), then hand off
		// to the 5-minute repeating silence watchdog — NEVER aggressively auto-fail!
		if (tokenId.startsWith('otok-')) {
			if ((this.unclosedTurnNudgeCount.get(nudgeKey) ?? 0) >= 1) {
				return;
			}
			const timer = setTimeout(() => {
				this.pendingTurnNudgeTimers.delete(timer);
				const rec = this.missionService?.getMission(missionId);
				const orch = rec?.orchestrationRuntime;
				if (!rec || !orch || orch.status === 'paused' || orch.status === 'aborted') {
					this.unclosedTurnNudgeCount.delete(nudgeKey);
					return;
				}
				const tok = orch.tokens[tokenId];
				if (!tok || tok.status !== 'active' || tok.nodeId !== nodeId) {
					this.unclosedTurnNudgeCount.delete(nudgeKey);
					return;
				}
				// Skip if the superior already minted live async child tokens (`--no-wait-join`).
				const hasLiveChildren = (tok.childTokenIds ?? []).some(cid => {
					const child = orch.tokens[cid];
					return Boolean(child && (child.status === 'active' || child.status === 'blocked' || child.status === 'waiting_join'));
				});
				if (hasLiveChildren || (this.activeTurnsByAgent.get(agentId) ?? 0) > 0) {
					return;
				}
				this.unclosedTurnNudgeCount.set(nudgeKey, 1);
				const nextHint = tok.returnToNodeId
					? `- Return completed work upward: \`aexus-ade token return ${tokenId} --summary "<1-line delivery>" --mission ${missionId} --json\``
					: `- Mint/split downward (\`aexus-ade token mint|split ${tokenId} ...\`), hand off (\`aexus-ade token handoff ${tokenId} --to <nodeId> --summary "..."\`), or conclude (\`aexus-ade token complete ${tokenId} --finish --summary "..."\`).`;
				const reminder = [
					`[Aexus System · Baton Token Reminder · Staff \`${nodeId}\` · Baton \`${tokenId}\`]`,
					`Your previous turn ended while Orchestration baton \`${tokenId}\` is still ACTIVE.`,
					`You MUST advance the baton via shell CLI right now so the workflow does not stall:`,
					nextHint,
					`- If waiting on a long-running build/job: \`aexus-ade token block ${tokenId} --duration <30m|2h> --reason "<why>" --mission ${missionId} --json\``,
					`- If blocked/unrecoverable: \`aexus-ade token fail ${tokenId} --reason "<root cause>" --mission ${missionId} --json\``,
				].join('\n');
				void this.dispatchPromptToAgent(agentId, reminder, {
					autonomousApproved: true,
					missionId,
					tokenId,
					nodeId,
					dedupeKey: `orch-fast-nudge:${missionId}:${tokenId}`,
					isNoiseTurn: true,
				});
			}, 8_000);
			this.pendingTurnNudgeTimers.add(timer);
			return;
		}
		const timer = setTimeout(() => {
			this.pendingTurnNudgeTimers.delete(timer);
			const rec = this.missionService?.getMission(missionId);
			if (!rec || rec.runtime?.status !== 'running') {
				this.unclosedTurnNudgeCount.delete(nudgeKey);
				return;
			}
			const tok = rec.runtime.tokens[tokenId];
			if (!tok || tok.status !== 'active' || tok.nodeId !== nodeId) {
				this.unclosedTurnNudgeCount.delete(nudgeKey);
				return;
			}
			const count = (this.unclosedTurnNudgeCount.get(nudgeKey) ?? 0) + 1;
			this.unclosedTurnNudgeCount.set(nudgeKey, count);
			if (count <= 2) {
				const checkHintLines = tok.lastCheckFailure
					? [
						`Last deterministic verification FAILED (attempt ${tok.lastCheckFailure.attempt}/${tok.lastCheckFailure.maxAutoRetries}): ${tok.lastCheckFailure.summary}`,
						`Fix the failure, self-check with \`aexus-ade mission check run --mission ${missionId} --node ${nodeId} --json\`, then call \`aexus-ade token complete ${tokenId} --summary "..."\`.`,
					]
					: [
						`You MUST close this token via the shell right now so downstream nodes can proceed:`,
						`- If finished: \`aexus-ade token complete ${tokenId} --summary "<concise factual summary of deliverables & test results>"\``,
						`- If blocked/unrecoverable: \`aexus-ade token fail ${tokenId} --reason "<exact failure reason>"\``,
					];
				const reminder = [
					`[Mission Token Reminder #${count}/2 · Node \`${nodeId}\` · Token \`${tokenId}\`]`,
					`Your previous turn ended while token \`${tokenId}\` is still ACTIVE.`,
					...checkHintLines,
					`Run the command immediately without repeating completed work.`,
				].join('\n');
				void this.dispatchPromptToAgent(agentId, reminder, {
					autonomousApproved: true,
					missionId,
					tokenId,
					nodeId,
					isNoiseTurn: true,
				});
			} else {
				this.unclosedTurnNudgeCount.delete(nudgeKey);
				void this.failToken(missionId, {
					tokenId,
					reason: `Node ${nodeId} ended its turn ${count} times without closing token ${tokenId} via aexus-ade token complete/fail.`,
				}).catch(() => undefined);
			}
		}, 1500);
		this.pendingTurnNudgeTimers.add(timer);
	}

	private async executeEffects(rec: IAdeMissionRecord, effects: readonly MissionEngineEffect[]): Promise<void> {
		for (const effect of effects) {
			switch (effect.kind) {
				case 'dispatch_token': {
					// Package the node's latest authored Pre-Prompt together with its live Token info on wakeup,
					// and always resolve the live bound employee ID so newly patched / reassigned nodes never lose their first token!
					const latestRec = this.missionService?.getMission(rec.id) ?? rec;
					const liveState = this.ensureSynchronizedState(latestRec);
					const targetAgentId = liveState.boundary.nodeAssignments[effect.nodeId]?.agentId
						?? liveState.tokens[effect.tokenId]?.holderAgentId
						?? effect.holderAgentId;
					const nodeChecks = (this.computeEffectiveNodeChecks(latestRec, parseMissionMermaidDag(latestRec.mermaidText), effect.nodeId)[effect.nodeId] ?? [])
						.filter(h => h.enabled !== false);
					let wakeupPrompt = effect.prompt;
					if (nodeChecks.length > 0) {
						const checkLines = nodeChecks.map(h => {
							const parts: string[] = [];
							if (h.command) { parts.push(`\`${h.command}\``); }
							if (h.expectFiles && h.expectFiles.length > 0) { parts.push(`files: ${h.expectFiles.join(', ')}`); }
							return `- ${h.name || h.id}: ${parts.join(' + ')}`;
						});
						wakeupPrompt += `\n\n### Deterministic Verification Gate (Auto-Run on \`token complete\`)\n${checkLines.join('\n')}\n- Self-verify anytime (0 review cost): \`aexus-ade mission check run --mission ${rec.id} --node ${effect.nodeId} --json\``;
					}
					const dispatched = await this.dispatchPromptToAgent(targetAgentId, wakeupPrompt, {
						autonomousApproved: true,
						missionId: rec.id,
						tokenId: effect.tokenId,
						nodeId: effect.nodeId,
					});
					if (!dispatched) {
						await this.failToken(rec.id, {
							tokenId: effect.tokenId,
							reason: `Unable to dispatch token ${effect.tokenId} to node ${effect.nodeId} (agent "${targetAgentId ?? 'unassigned'}" unavailable).`,
						}).catch(() => undefined);
					}
					break;
				}
				case 'wakeup_agent': {
					const latestRec = this.missionService?.getMission(rec.id) ?? rec;
					const liveState = this.ensureSynchronizedState(latestRec);
					const targetAgentId = liveState.boundary.nodeAssignments[effect.nodeId]?.agentId
						?? liveState.tokens[effect.tokenId]?.holderAgentId
						?? effect.holderAgentId;
					const dispatched = await this.dispatchPromptToAgent(targetAgentId, effect.message, {
						autonomousApproved: true,
						missionId: rec.id,
						tokenId: effect.tokenId,
						nodeId: effect.nodeId,
					});
					if (!dispatched) {
						await this.failToken(rec.id, {
							tokenId: effect.tokenId,
							reason: `Unable to wake agent "${targetAgentId ?? 'unassigned'}" for node ${effect.nodeId} (${effect.wakeupReason}).`,
						}).catch(() => undefined);
					}
					break;
				}
				case 'stop_agent': {
					if (effect.holderAgentId) {
						const agent = this.projectsService?.getAgent(effect.holderAgentId);
						if (agent?.session) {
							const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
							await this.sessionsService?.stop?.(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
							this.projectsService?.setAgentStatus(agent.id, 'idle');
						}
					}
					break;
				}
				case 'upsert_gate_inbox': {
					const govId = rec.ownerSessionId ?? rec.id;
					await this.inboxService?.upsertUserGateTodo?.({
						governorSessionId: govId,
						treeType: 'mission',
						nodeId: effect.nodeId,
						nodeTitle: effect.nodeTitle,
						description: `Human Gate "${effect.nodeTitle}" (token ${effect.tokenId}) requires Approve / Reject sign-off.`,
						upstreamSummary: effect.upstreamSummary,
						rollbackCandidates: effect.rollbackCandidates,
					}).catch(() => undefined);
					break;
				}
				case 'escalate_to_supervisor': {
					const latestRec = this.missionService?.getMission(rec.id) ?? rec;
					const failedAgentId = effect.nodeId
						? latestRec.runtime?.boundary.nodeAssignments[effect.nodeId]?.agentId
						: undefined;
					const prompt = [
						`[Engineering Escalation · ${rec.title} (${rec.id})]`,
						`- Node: ${effect.nodeId || '(unknown)'} | Token: ${effect.tokenId || '(unknown)'}${failedAgentId ? ` | Subordinate Agent: \`${failedAgentId}\`` : ''}`,
						`- Failure / Escalation Reason: ${effect.reason}`,
						`- Next Actions:`,
						`  1. Inspect subordinate context via \`aexus-ade org context ${failedAgentId || '<agentId>'} --json\`.`,
						`  2. Mint or hand off a recovery baton (\`aexus-ade token mint|handoff\`), remove/replace stalled subordinate (\`aexus-ade orchestration staff remove --mission ${rec.id} --node ${effect.nodeId || '<nodeId>'} --force\`), or pause/abort the wave (\`aexus-ade orchestration pause|abort --mission ${rec.id}\`).`,
						`  3. Escalate further upward if needed via \`aexus-ade org escalate --mission ${rec.id} --token ${effect.tokenId} --reason "..."\`.`,
					].join('\n');
					const postInboxFallback = (detail: string) => {
						const govId = rec.ownerSessionId ?? rec.id;
						void this.inboxService?.postGovernorMessage({
							governorSessionId: govId,
							title: `Mission Escalation (${effect.nodeId || rec.id})`,
							message: `Supervisor "${effect.supervisorId}" could not handle escalation for token \`${effect.tokenId}\` (${detail}).\n\n${effect.reason}`,
							nodeId: effect.nodeId || undefined,
							severity: 'critical',
						}).catch(() => undefined);
					};
					const delivered = await this.dispatchPromptToAgent(effect.supervisorId, prompt, {
						autonomousApproved: true,
						requireLiveDelivery: true,
						dedupeKey: `escalate:${rec.id}:${effect.tokenId || effect.nodeId}`,
						onDispatchError: errMsg => postInboxFallback(`dispatch failed: ${errMsg.slice(0, 300)}`),
					});
					if (!delivered) {
						postInboxFallback('supervisor session unavailable');
					}
					break;
				}
				case 'post_inbox': {
					const govId = rec.ownerSessionId ?? rec.id;
					await this.inboxService?.postGovernorMessage({
						governorSessionId: govId,
						title: effect.title,
						message: effect.message,
						nodeId: effect.nodeId,
						severity: effect.severity,
						senderAgentId: effect.senderAgentId,
					}).catch(() => undefined);
					break;
				}
				case 'mermaid_patched': {
					this.missionService?.updateMermaid(rec.id, effect.newMermaidText);
					break;
				}
			}
		}
	}

	// =========================================================================
	// Engineering Dual-View: Mission Task DAG + Cyclic All-Staff Orchestration
	// =========================================================================

	setMissionTaskStatus(missionId: string, params: {
		readonly nodeId: string;
		readonly status: MissionTaskStatus;
		readonly caller: {
			readonly isHumanUser?: boolean;
			readonly callerTier?: number;
			readonly callerSessionId?: string;
			readonly callerLabel?: string;
			readonly callerNodeId?: string;
		};
		readonly force?: boolean;
		readonly note?: string;
	}): IMissionTaskStatusTransitionResult {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const orchGraph = rec.orchestrationText?.trim() ? parseOrchestrationGraph(rec.orchestrationText) : undefined;
		const callerNodeId = params.caller.callerNodeId ?? this.resolveCallerOrchestrationNodeId(rec, params.caller.callerSessionId);
		const res = updateMissionTaskNodeStatus(rec.taskStatuses, graph, this.orgConfig, {
			...params,
			caller: {
				...params.caller,
				...(callerNodeId ? { callerNodeId } : {}),
			},
			...(orchGraph && !orchGraph.error ? { orchGraph } : {}),
		});
		if (res.ok) {
			this.missionService?.updateTaskStatuses(rec.id, res.taskStatuses as Readonly<Record<string, IMissionTaskStatusRecord>>);
			this._onDidChange.fire(rec.id);
		}
		return res;
	}

	private ensureSynchronizedOrchestrationState(rec: IAdeMissionRecord): IOrchestrationRuntimeState {
		const parsed = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const staffNodes = parsed.nodes.filter(n => n.kind === 'staff');
		const base = rec.orchestrationRuntime ?? createInitialOrchestrationRuntimeState(rec.id, staffNodes.map(n => n.id));
		const generatedEmployees = this.missionService?.getGeneratedEmployees(rec.id) ?? [];
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
			? this.projectsService?.getAgent(rec.ownerSessionId)
			: undefined;
		const rootStaffNode = ownerAgent && !parsed.error ? findHighestRankStaffNode(parsed) : undefined;
		const nextNodeAgentIds: Record<string, string> = { ...base.nodeAgentIds };
		const nextNodeStates: Record<string, IOrchestrationRuntimeState['nodeStates'][string]> = { ...base.nodeStates };
		let changed = !rec.orchestrationRuntime;
		if (!parsed.error) {
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

	private commitOrchestrationState(missionId: string, state: IOrchestrationRuntimeState): void {
		const prevRec = this.missionService?.getMission(missionId);
		const prevOrch = prevRec?.orchestrationRuntime;
		this.missionService?.updateOrchestrationRuntime(missionId, state);
		this.flushPendingDispatchesForReleasedOrchAgents(prevOrch, state);
		const rec = this.missionService?.getMission(missionId);
		if (rec && rec.mermaidText?.trim()) {
			const taskGraph = parseMissionMermaidDag(rec.mermaidText);
			if (!taskGraph.error && taskGraph.nodes.length > 0) {
				const orchGraph = rec.orchestrationText?.trim() ? parseOrchestrationGraph(rec.orchestrationText) : undefined;
				const synced = syncMissionTaskStatusesFromOrchestration(rec.taskStatuses, taskGraph, state, orchGraph);
				if (synced.changed) {
					this.missionService?.updateTaskStatuses(missionId, synced.taskStatuses);
				}
			}
		}
		const freshRec = this.missionService?.getMission(missionId);
		this.syncWatchdog(missionId, freshRec?.runtime ?? createInitialMissionRuntimeState(missionId, this.orgConfig));
		if (this.backendService?.syncOrchestrationDaemonState) {
			const tokens = Object.values(state.tokens);
			void this.backendService.syncOrchestrationDaemonState({
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
		this._onDidChange.fire(missionId);
	}

	private scheduleOrchestrationCompactionIfNeeded(missionId: string, state: IOrchestrationRuntimeState): void {
		const backend = this.backendService;
		if (!backend?.saveOrchestrationBlobs || !backend?.appendOrchestrationArchive) {
			return;
		}
		const hasCompactableBlob = Object.values(state.payloadStore ?? {}).some(b => b.sizeChars >= 256);
		const terminalTokenCount = Object.values(state.tokens).filter(t => t.status !== 'active' && t.status !== 'blocked' && t.status !== 'waiting_join').length;
		const traceCount = Object.keys(state.traces).length;
		if (!hasCompactableBlob && terminalTokenCount <= 80 && traceCount <= 200) {
			return;
		}
		const prev = this.compactionChains.get(missionId) ?? Promise.resolve();
		const run = prev.then(async () => {
			if (this._store.isDisposed) {
				return;
			}
			const liveRec = this.missionService?.getMission(missionId);
			const liveOrch = liveRec?.orchestrationRuntime;
			if (!liveOrch) {
				return;
			}
			const compacted = compactOrchestrationRuntimeState(liveOrch);
			if (!compacted.didCompact) {
				return;
			}
			// Disk-first persistence: ONLY strip blobs/tokens/traces from hot JSON AFTER cold writes succeed!
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
			if (this._store.isDisposed || (persistedBlobPtrs.size === 0 && !archivePersisted)) {
				return;
			}
			// Re-read freshest state after async disk I/O and prune ONLY the persisted items without clobbering concurrent mutations!
			const freshest = this.missionService?.getMission(missionId)?.orchestrationRuntime;
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
			this.missionService?.updateOrchestrationRuntime(missionId, {
				...freshest,
				tokens: nextTokens,
				traces: nextTraces,
				payloadStore: nextPayloadStore,
				externalizedBlobIndex: nextExtIndex,
				archivedTokenCount: (freshest.archivedTokenCount ?? 0) + prunedTokens,
				archivedTraceCount: (freshest.archivedTraceCount ?? 0) + prunedTraces,
			}, { deferPersist: true });
		}).catch(() => undefined);
		this.compactionChains.set(missionId, run);
	}

	private async executeOrchestrationEffects(rec: IAdeMissionRecord, effects: readonly OrchestrationEngineEffect[]): Promise<void> {
		if (effects.length > 0) {
			this.missionService?.ensureOrchestrationStaffSynced?.(rec.id);
		}
		for (const eff of effects) {
			if (eff.kind === 'post_inbox') {
				const govId = rec.ownerSessionId ?? rec.id;
				await this.inboxService?.postGovernorMessage({
					governorSessionId: govId,
					title: eff.title,
					message: eff.message,
					nodeId: eff.nodeId,
					severity: eff.severity,
					senderAgentId: eff.senderAgentId,
				}).catch(() => undefined);
				if (rec.ownerSessionId && rec.ownerSessionId !== ADE_SECRETARY_ID) {
					this.projectsService?.setAgentStatus(rec.ownerSessionId, 'idle', true);
				}
				continue;
			}
			const latestRec = this.missionService?.getMission(rec.id) ?? rec;
			const orchState = this.ensureSynchronizedOrchestrationState(latestRec);
			const targetAgentId = orchState.nodeAgentIds[eff.nodeId] ?? eff.holderAgentId;
			if (!targetAgentId) {
				if (eff.kind === 'dispatch_token') {
					await this.failOrchestrationToken(rec.id, {
						tokenId: eff.tokenId,
						reason: `No bound agent session found for staff node "${eff.nodeId}".`,
					}).catch(() => undefined);
				}
				continue;
			}
			const promptText = eff.kind === 'dispatch_token' ? eff.prompt : eff.message;
			const dispatched = await this.dispatchPromptToAgent(targetAgentId, promptText, {
				autonomousApproved: true,
				missionId: rec.id,
				tokenId: eff.tokenId,
				nodeId: eff.nodeId,
				...(eff.kind === 'silence_reminder' ? { dedupeKey: `orch-nudge:${rec.id}:${eff.tokenId}:${eff.nudgeCount}` } : {}),
			});
			if (!dispatched && eff.kind === 'dispatch_token') {
				await this.failOrchestrationToken(rec.id, {
					tokenId: eff.tokenId,
					reason: `Unable to dispatch baton ${eff.tokenId} to staff "${eff.nodeId}" (agent "${targetAgentId}" session/engine unavailable).`,
				}).catch(() => undefined);
			}
		}
	}

	getOrchestrationState(missionId: string): IOrchestrationRuntimeState {
		const rec = this.requireMission(missionId);
		return this.ensureSynchronizedOrchestrationState(rec);
	}

	getCurrentOrchestrationTokens(agentId: string, missionId?: string): readonly IOrchestrationToken[] {
		const missions = missionId
			? [this.missionService?.getMission(missionId) ?? this.missionService?.getMissionByLinkedSession(missionId)].filter((m): m is IAdeMissionRecord => Boolean(m))
			: (this.missionService?.listMissions() ?? []);
		const out: IOrchestrationToken[] = [];
		for (const rec of missions) {
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
		const rec = this.requireMission(missionId);
		const orch = this.ensureSynchronizedOrchestrationState(rec);
		const tok = orch.tokens[tokenId];
		if (!tok) {
			return undefined;
		}
		return buildOrchestrationTokenDeltaView(orch, tok, rec.whiteboards);
	}

	getOrchestrationTokenHistory(missionId: string, tokenId: string, options?: { readonly includeAll?: boolean }): ReturnType<typeof getOrchestrationTokenHistory> {
		const rec = this.requireMission(missionId);
		const orch = this.ensureSynchronizedOrchestrationState(rec);
		return getOrchestrationTokenHistory(orch, tokenId, rec.whiteboards, options);
	}

	async getOrchestrationTokenHistoryAsync(missionId: string, tokenId: string, options?: { readonly includeAll?: boolean }): Promise<ReturnType<typeof getOrchestrationTokenHistory> & { readonly archived?: boolean }> {
		const hot = this.getOrchestrationTokenHistory(missionId, tokenId, options);
		if (hot.ok || !this.backendService?.readOrchestrationArchive) {
			return hot;
		}
		const rec = this.requireMission(missionId);
		const lines = await this.backendService.readOrchestrationArchive(rec.id).catch(() => []);
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
		readonly caller?: {
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerAgentId?: string;
		};
	}): { readonly items: readonly IDereferencedOrchestrationPointer[] } {
		const rec = this.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const orch = this.ensureSynchronizedOrchestrationState(rec);
		const callerNodeId = this.resolveCallerOrchestrationNodeId(rec, params.caller?.callerAgentId);
		const token = params.tokenId ? orch.tokens[params.tokenId] : undefined;
		// Human/Secretary UI inspection must NEVER silently advance an employee's read cursor!
		const isExternalObserver = Boolean(params.caller?.isHumanUser || params.caller?.isSecretary);
		const readerNodeId = isExternalObserver ? undefined : (callerNodeId ?? token?.nodeId);
		const waveId = token?.waveId ?? (readerNodeId
			? Object.values(orch.tokens).find(t => t.nodeId === readerNodeId && (t.status === 'active' || t.status === 'blocked'))?.waveId
			: undefined);
		const res = readOrchestrationTokenPointers(orch, rec.whiteboards, graph, this.orgConfig, {
			ptrs: params.ptrs,
			readerNodeId,
			waveId,
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
		readonly caller?: {
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerAgentId?: string;
		};
	}): Promise<{ readonly items: readonly IDereferencedOrchestrationPointer[] }> {
		const base = this.readOrchestrationTokenPointers(missionId, params);
		const backend = this.backendService;
		if (!backend?.readOrchestrationBlob || !base.items.some(i => i.externalized)) {
			return base;
		}
		const rec = this.requireMission(missionId);
		const hydrated: IDereferencedOrchestrationPointer[] = [];
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
				hydrated.push({
					ptr: item.ptr,
					ok: true,
					kind: parsed.kind ?? item.kind,
					title: parsed.title ?? item.title,
					version: 1,
					authorNodeId: parsed.authorNodeId ?? item.authorNodeId,
					hop: parsed.hop ?? item.hop,
					sizeChars: parsed.sizeChars ?? (typeof parsed.content === 'string' ? parsed.content.length : item.sizeChars),
					content: typeof parsed.content === 'string' ? parsed.content : '',
				});
			} catch {
				hydrated.push(item);
			}
		}
		return { items: hydrated };
	}

	private async runOrchestrationStaffChecksIfNeeded(
		rec: IAdeMissionRecord,
		nodeId: string,
		options?: { readonly skipChecks?: boolean; readonly tokenId?: string; readonly holderAgentId?: string },
	): Promise<{ readonly passed: boolean; readonly error?: string }> {
		if (options?.skipChecks) {
			return { passed: true };
		}
		const hooks = this.computeEffectiveNodeChecks(rec, parseMissionMermaidDag(rec.mermaidText), nodeId)[nodeId] ?? [];
		const enabled = hooks.filter(h => h.enabled !== false);
		if (enabled.length === 0) {
			return { passed: true };
		}
		const lockKey = `orch-check:${rec.id}:${options?.tokenId ?? nodeId}`;
		if (this.inFlightCheckTokens.has(lockKey)) {
			return { passed: false, error: `Automated verification checks for "${nodeId}" are already running; wait for completion.` };
		}
		this.inFlightCheckTokens.add(lockKey);
		if (options?.holderAgentId) {
			this.touchAgentActivity(options.holderAgentId, Date.now());
		}
		let suite: IMissionNodeCheckSuiteResult;
		try {
			suite = await this.runNodeChecks(rec.id, nodeId);
		} finally {
			this.inFlightCheckTokens.delete(lockKey);
			if (options?.holderAgentId) {
				this.touchAgentActivity(options.holderAgentId, Date.now());
			}
		}
		if (suite.passed) {
			return { passed: true };
		}
		const failLines = suite.results
			.filter(r => !r.passed)
			.map(r => `[${r.name || r.checkId}] ${r.error || `exit=${r.exitCode}`}${r.outputTail ? `\n${r.outputTail.slice(-600)}` : ''}`)
			.join('\n');
		return {
			passed: false,
			error: `AUTOMATED_CHECK_FAILED on staff node "${nodeId}": ${suite.summary}\n${failLines}`,
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
	}): Promise<IOrchestrationTransitionResult<{ readonly tokenId: string; readonly targetNodeId: string; readonly payloadPtr?: string }>> {
		this.missionService?.ensureOrchestrationStaffSynced?.(missionId);
		const rec = this.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const taskGraph = rec.mermaidText?.trim() ? parseMissionMermaidDag(rec.mermaidText) : undefined;
		const res = dispatchRequirementToOrchestration(state, graph, rec.whiteboards, this.orgConfig, {
			...params,
			...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses: rec.taskStatuses } : {}),
		});
		if (res.ok) {
			this.commitOrchestrationState(rec.id, res.state);
			await this.executeOrchestrationEffects(rec, res.effects);
		}
		return res;
	}

	async mintOrchestrationTokens(missionId: string, params: {
		readonly parentTokenId?: string;
		readonly fromNodeId?: string;
		readonly waveSummary?: string;
		readonly branches: readonly IOrchestrationMintBranch[];
		readonly waitJoin?: boolean;
		readonly joinMode?: 'all' | 'any';
		readonly callerAgentId?: string;
	}): Promise<IOrchestrationTransitionResult<{
		readonly parentTokenId: string;
		readonly mintedTokenIds: readonly string[];
		readonly joinBarrierId?: string;
		readonly createdRootParent?: boolean;
		readonly branches: readonly { readonly tokenId: string; readonly toNodeId: string; readonly taskNodeId?: string; readonly payloadPtr?: string }[];
	}>> {
		this.missionService?.ensureOrchestrationStaffSynced?.(missionId);
		const rec = this.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const taskGraph = rec.mermaidText?.trim() ? parseMissionMermaidDag(rec.mermaidText) : undefined;
		const res = mintOrchestrationTokens(state, graph, rec.whiteboards, this.orgConfig, {
			...params,
			...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses: rec.taskStatuses } : {}),
		});
		if (res.ok) {
			this.commitOrchestrationState(rec.id, res.state);
			await this.executeOrchestrationEffects(rec, res.effects);
		}
		return res;
	}

	async returnOrchestrationToken(missionId: string, params: {
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
		readonly skipChecks?: boolean;
	}): Promise<IOrchestrationTransitionResult<{
		readonly returnedToNodeId: string;
		readonly returnedTokenId?: string;
		readonly barrierId?: string;
		readonly barrierSatisfied?: boolean;
		readonly payloadPtr?: string;
		readonly attachedRefPtrs?: readonly string[];
	}>> {
		const rec = this.requireMission(missionId);
		const initialState = this.ensureSynchronizedOrchestrationState(rec);
		const tok = initialState.tokens[params.tokenId];
		const boundHolder = tok ? (initialState.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId) : undefined;
		const callerOwnsToken = params.callerAgentId === undefined || !boundHolder || boundHolder === params.callerAgentId;
		if (initialState.status !== 'paused' && tok && (tok.status === 'active' || tok.status === 'blocked') && callerOwnsToken && params.summary.trim().length > 0) {
			const checkGate = await this.runOrchestrationStaffChecksIfNeeded(rec, tok.nodeId, {
				skipChecks: params.skipChecks,
				tokenId: tok.id,
				holderAgentId: boundHolder,
			});
			if (!checkGate.passed) {
				return { ok: false, state: initialState, effects: [], code: 'INVALID_STATE', error: checkGate.error };
			}
		}
		const freshRec = this.requireMission(missionId);
		const graph = parseOrchestrationGraph(freshRec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(freshRec);
		const res = returnOrchestrationToken(state, graph, freshRec.whiteboards, this.orgConfig, params);
		if (res.ok) {
			this.commitOrchestrationState(freshRec.id, res.state);
			await this.executeOrchestrationEffects(freshRec, res.effects);
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
		const rec = this.requireMission(missionId);
		const initialGraph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const initialState = this.ensureSynchronizedOrchestrationState(rec);
		const tok = initialState.tokens[params.tokenId];
		const boundHolder = tok ? (initialState.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId) : undefined;
		const callerOwnsToken = params.callerAgentId === undefined || !boundHolder || boundHolder === params.callerAgentId;
		if (initialState.status !== 'paused' && tok && (tok.status === 'active' || tok.status === 'blocked') && callerOwnsToken && params.summary.trim().length > 0 && params.toNodeIds.length > 0) {
			// Run automated checks when returning/delivering (non-downward handoff); never block superior delegating downward!
			const holderNode = initialGraph.nodes.find(n => n.id === tok.nodeId && n.kind === 'staff');
			const holderTier = resolveEffectiveStaffTier(holderNode, this.orgConfig);
			const allDownward = params.toNodeIds.every(tid => {
				const target = initialGraph.nodes.find(n => n.id === tid.trim() && n.kind === 'staff');
				const targetTier = resolveEffectiveStaffTier(target, this.orgConfig);
				return Boolean(holderTier !== undefined && targetTier !== undefined && targetTier > holderTier);
			});
			if (!allDownward) {
				const checkGate = await this.runOrchestrationStaffChecksIfNeeded(rec, tok.nodeId, {
					skipChecks: params.skipChecks,
					tokenId: tok.id,
					holderAgentId: boundHolder,
				});
				if (!checkGate.passed) {
					return { ok: false, state: initialState, effects: [], code: 'INVALID_STATE', error: checkGate.error };
				}
			}
		}
		const freshRec = this.requireMission(missionId);
		const graph = parseOrchestrationGraph(freshRec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(freshRec);
		const taskGraph = freshRec.mermaidText?.trim() ? parseMissionMermaidDag(freshRec.mermaidText) : undefined;
		const res = handoffOrchestrationToken(state, graph, freshRec.whiteboards, this.orgConfig, {
			...params,
			...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses: freshRec.taskStatuses } : {}),
		});
		if (res.ok) {
			this.commitOrchestrationState(freshRec.id, res.state);
			await this.executeOrchestrationEffects(freshRec, res.effects);
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
		readonly callerAgentId?: string;
		readonly skipChecks?: boolean;
	}): Promise<IOrchestrationTransitionResult<{ readonly nextTokenIds: readonly string[]; readonly finished?: boolean; readonly payloadPtr?: string; readonly barrierSatisfied?: boolean }>> {
		const rec = this.requireMission(missionId);
		const initialGraph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const initialState = this.ensureSynchronizedOrchestrationState(rec);
		const tok = initialState.tokens[params.tokenId];
		const boundHolder = tok ? (initialState.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId) : undefined;
		const callerOwnsToken = params.callerAgentId === undefined || !boundHolder || boundHolder === params.callerAgentId;
		if (initialState.status !== 'paused' && tok && (tok.status === 'active' || tok.status === 'blocked') && callerOwnsToken && params.summary.trim().length > 0) {
			const holderNode = initialGraph.nodes.find(n => n.id === tok.nodeId && n.kind === 'staff');
			const holderTier = resolveEffectiveStaffTier(holderNode, this.orgConfig);
			const allDownward = Boolean(params.toNodeIds && params.toNodeIds.length > 0 && params.toNodeIds.every(tid => {
				const target = initialGraph.nodes.find(n => n.id === tid.trim() && n.kind === 'staff');
				const targetTier = resolveEffectiveStaffTier(target, this.orgConfig);
				return Boolean(holderTier !== undefined && targetTier !== undefined && targetTier > holderTier);
			}));
			if (!allDownward) {
				const checkGate = await this.runOrchestrationStaffChecksIfNeeded(rec, tok.nodeId, {
					skipChecks: params.skipChecks,
					tokenId: tok.id,
					holderAgentId: boundHolder,
				});
				if (!checkGate.passed) {
					return { ok: false, state: initialState, effects: [], code: 'INVALID_STATE', error: checkGate.error };
				}
			}
		}
		const freshRec = this.requireMission(missionId);
		const graph = parseOrchestrationGraph(freshRec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(freshRec);
		const taskGraph = freshRec.mermaidText?.trim() ? parseMissionMermaidDag(freshRec.mermaidText) : undefined;
		const res = completeOrchestrationToken(state, graph, freshRec.whiteboards, this.orgConfig, {
			...params,
			...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses: freshRec.taskStatuses } : {}),
		});
		if (res.ok) {
			this.commitOrchestrationState(freshRec.id, res.state);
			await this.executeOrchestrationEffects(freshRec, res.effects);
		}
		return res;
	}

	async failOrchestrationToken(missionId: string, params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly callerAgentId?: string;
	}): Promise<IOrchestrationTransitionResult<{ readonly barrierSatisfied?: boolean }>> {
		const rec = this.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const res = failOrchestrationToken(state, graph, rec.whiteboards, this.orgConfig, params);
		if (res.ok) {
			this.commitOrchestrationState(rec.id, res.state);
			await this.executeOrchestrationEffects(rec, res.effects);
		}
		return res;
	}

	async pauseOrchestration(missionId: string, reason?: string): Promise<IOrchestrationTransitionResult<{ readonly status: 'paused' }>> {
		const rec = this.requireMission(missionId);
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const res = pauseOrchestration(state, { reason });
		if (res.ok) {
			this.commitOrchestrationState(rec.id, res.state);
		}
		return res;
	}

	async resumeOrchestration(missionId: string): Promise<IOrchestrationTransitionResult<{ readonly status: 'running'; readonly activeTokenIds: readonly string[] }>> {
		const rec = this.requireMission(missionId);
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const res = resumeOrchestration(state);
		if (res.ok) {
			this.commitOrchestrationState(rec.id, res.state);
			for (const agentId of new Set(Object.values(res.state.nodeAgentIds))) {
				this.flushNextQueuedDispatch(agentId);
			}
		}
		return res;
	}

	async abortOrchestrationTokens(missionId: string, reason?: string): Promise<IOrchestrationTransitionResult<{ readonly abortedTokenIds: readonly string[]; readonly abortedBarrierIds: readonly string[] }>> {
		const rec = this.requireMission(missionId);
		const state = this.ensureSynchronizedOrchestrationState(rec);
		const res = abortOrchestrationTokens(state, { reason });
		if (res.ok) {
			// Drop any queued dispatches AND stop live running agent sessions for all aborted tokens!
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
			for (const [agentId, queue] of this.pendingDispatchesByAgent.entries()) {
				const kept = queue.filter(item => !(item.options?.missionId === rec.id && item.options?.tokenId && abortedSet.has(item.options.tokenId)));
				if (kept.length === 0) {
					this.pendingDispatchesByAgent.delete(agentId);
				} else {
					this.pendingDispatchesByAgent.set(agentId, kept);
				}
			}
			this.commitOrchestrationState(rec.id, res.state);
			if (this.projectsService && this.sessionsService?.stop) {
				for (const aid of agentsToStop) {
					const agent = this.projectsService.getAgent(aid);
					if (agent?.session) {
						const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
						await this.sessionsService.stop(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
						this.projectsService.setAgentStatus(agent.id, 'idle');
					}
				}
			}
		}
		return res;
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
		readonly orchestrationText?: string;
		readonly error?: string;
		readonly code?: string;
	}> {
		const rec = this.requireMission(missionId);
		const plan = planDynamicSubordinateRemoval(rec.orchestrationText ?? '', this.orgConfig, {
			...params,
			whiteboards: rec.whiteboards,
		});
		if (!plan.ok || !plan.orchestrationText || !plan.removedNode) {
			return { ok: false, error: plan.error, code: plan.code };
		}

		const targetId = plan.removedNode.id;
		const preState = this.ensureSynchronizedOrchestrationState(rec);
		const removedAgentId = preState.nodeAgentIds[targetId];
		if (removedAgentId) {
			// Clear pending dispatches & close active session cleanly
			this.pendingDispatchesByAgent.delete(removedAgentId);
			const removedAgent = this.projectsService?.getAgent(removedAgentId);
			if (removedAgent?.session && this.sessionsService) {
				const hostAlias = removedAgent.projectUri.scheme === AEXUS_SSH_SCHEME ? removedAgent.projectUri.authority : undefined;
				await this.sessionsService.stop?.(removedAgent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
				await this.sessionsService.delete(removedAgent.session).catch(() => undefined);
			}
		}

		// Update topology first (this also syncs/removes locked generated employee in sidebar!)
		this.missionService?.updateOrchestrationText(rec.id, plan.orchestrationText);
		const updatedRec = this.requireMission(rec.id);
		const graphAfterRemoval = parseOrchestrationGraph(updatedRec.orchestrationText ?? '');
		const reclaimRes = reclaimOrchestrationTokensForRemovedNode(preState, graphAfterRemoval, updatedRec.whiteboards, this.orgConfig, {
			removedNodeId: targetId,
			reclaimedBy: params.callerNodeId ?? (params.isHumanUser ? 'User' : undefined),
			reason: params.reason,
			fallbackSupervisorNodeId: params.callerNodeId,
		});
		this.commitOrchestrationState(updatedRec.id, reclaimRes.state);
		if (reclaimRes.effects.length > 0) {
			await this.executeOrchestrationEffects(updatedRec, reclaimRes.effects);
		}
		return {
			ok: true,
			removedNodeId: targetId,
			reclaimedTokenIds: reclaimRes.data?.reclaimedTokenIds ?? [],
			recoveryTokenIds: reclaimRes.data?.recoveryTokenIds ?? [],
			settledBarrierIds: reclaimRes.data?.settledBarrierIds ?? [],
			reparentedTokenIds: reclaimRes.data?.reparentedTokenIds ?? [],
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
		const rec = this.requireMission(missionId);
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
			this.missionService?.updateOrchestrationText(rec.id, codeUpdate.orchestrationText);
		}

		// Sync host binding if changed
		if (patch.hostAlias !== undefined) {
			await this.bindNodeHost(rec.id, cleanNodeId, { hostAlias: patch.hostAlias ?? 'local' }).catch(() => undefined);
		}

		// Sync live agent preferences (and optionally reset existing session so engine can be switched cleanly!)
		const freshRec = this.requireMission(rec.id);
		const orchState = this.ensureSynchronizedOrchestrationState(freshRec);
		const agentId = orchState.nodeAgentIds[cleanNodeId];
		let didResetSession = false;
		if (agentId && this.projectsService) {
			const agent = this.projectsService.getAgent(agentId);
			if (agent) {
				if (patch.resetSession && agent.session) {
					this.pendingDispatchesByAgent.delete(agent.id);
					if (this.sessionsService) {
						const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
						await this.sessionsService.stop?.(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
						await this.sessionsService.delete(agent.session).catch(() => undefined);
					}
					this.projectsService.unbindSession?.(agent.id);
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
					this.projectsService.updateAgentEnginePreferences?.(agent.id, prefPatch);
				}
			}
		}
		this._onDidChange.fire(rec.id);
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
		const rec = this.requireMission(missionId);
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
		if (params.watchFile?.trim() && this.backendService?.probeFileMtime) {
			initialFileMtime = await this.backendService.probeFileMtime(params.hostAlias || 'local', params.watchFile.trim()).catch(() => undefined);
		}
		const freshRec = this.requireMission(missionId);
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
	}): Promise<{
		readonly ok: boolean;
		readonly newNodeId?: string;
		readonly agentId?: string;
		readonly nextTokenIds?: readonly string[];
		readonly orchestrationText?: string;
		readonly error?: string;
		readonly code?: string;
	}> {
		const rec = this.requireMission(missionId);
		const normalizedEngineId = normalizeAdeEngineId(params.engineId);
		const plan = planDynamicSubordinateCreation(rec.orchestrationText ?? '', this.orgConfig, {
			...params,
			...(normalizedEngineId ? { engineId: normalizedEngineId } : {}),
		});
		if (!plan.ok || !plan.newNodeId || !plan.orchestrationText) {
			return { ok: false, error: plan.error, code: plan.code };
		}
		this.missionService?.updateOrchestrationText(rec.id, plan.orchestrationText);
		// Position newly expanded subordinate cleanly near its creator node if manual positions exist.
		const updatedRec = this.requireMission(rec.id);
		if (params.callerNodeId && updatedRec.orchestrationPositions?.[params.callerNodeId]) {
			const parentPos = updatedRec.orchestrationPositions[params.callerNodeId];
			const siblingCount = Object.keys(updatedRec.orchestrationPositions).length;
			this.missionService?.updateOrchestrationPositions(rec.id, {
				...updatedRec.orchestrationPositions,
				[plan.newNodeId]: {
					x: parentPos.x + 360,
					y: parentPos.y + ((siblingCount % 3) - 1) * 220,
				},
			});
		}
		// Bind remote SSH host BEFORE minting/handing off an initial token so cold sessions launch on the right host!
		if (params.hostAlias && params.hostAlias.trim() && params.hostAlias.trim().toLowerCase() !== 'local') {
			await this.bindNodeHost(rec.id, plan.newNodeId, { hostAlias: params.hostAlias.trim() }).catch(() => undefined);
		}
		const synced = this.ensureSynchronizedOrchestrationState(this.requireMission(rec.id));
		this.commitOrchestrationState(rec.id, synced);
		const agentId = synced.nodeAgentIds[plan.newNodeId];
		if (agentId && this.projectsService && (normalizedEngineId || params.model || params.thinking)) {
			const prefPatch: { preferredEngineId?: string; preferredModel?: string; preferredThinking?: AdeThinkingLevel } = {};
			if (normalizedEngineId) { prefPatch.preferredEngineId = normalizedEngineId; }
			if (params.model) { prefPatch.preferredModel = params.model; }
			if (params.thinking === 'off' || params.thinking === 'low' || params.thinking === 'medium' || params.thinking === 'high' || params.thinking === 'max') {
				prefPatch.preferredThinking = params.thinking;
			}
			if (Object.keys(prefPatch).length > 0) {
				this.projectsService.updateAgentEnginePreferences?.(agentId, prefPatch);
			}
		}

		let nextTokenIds: readonly string[] | undefined;
		if (params.mintTokenId?.trim()) {
			const mintRes = await this.mintOrchestrationTokens(rec.id, {
				parentTokenId: params.mintTokenId.trim(),
				branches: [{
					toNodeId: plan.newNodeId,
					summary: params.handoffSummary?.trim() || `Subtask minted to newly created subordinate ${params.name}`,
					whiteboardIds: params.whiteboardIds,
				}],
				callerAgentId: params.callerAgentId,
			});
			if (!mintRes.ok) {
				return {
					ok: false,
					newNodeId: plan.newNodeId,
					agentId,
					orchestrationText: plan.orchestrationText,
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
				whiteboardIds: params.whiteboardIds,
				callerAgentId: params.callerAgentId,
			});
			if (!handoffRes.ok) {
				return {
					ok: false,
					newNodeId: plan.newNodeId,
					agentId,
					orchestrationText: plan.orchestrationText,
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
			...(nextTokenIds ? { nextTokenIds } : {}),
			orchestrationText: plan.orchestrationText,
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
		const agent = this.projectsService?.getAgent(callerAgentId);
		return agent?.treeNodeId;
	}

	listOrchestrationWhiteboards(missionId: string, caller?: {
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerTier?: number;
		readonly callerAgentId?: string;
	}): readonly IOrchestrationWhiteboard[] {
		const rec = this.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const merged: Record<string, IOrchestrationWhiteboard> = { ...(rec.whiteboards ?? {}) };
		// Ensure whiteboard nodes declared in Orchestration Mermaid text appear even before first write.
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
		return all.filter(wb => canCallerAccessWhiteboard(graph, wb, this.orgConfig, {
			isHumanUser: caller.isHumanUser,
			isSecretary: caller.isSecretary,
			callerTier: caller.callerTier,
			callerNodeId,
		}));
	}

	readOrchestrationWhiteboard(missionId: string, whiteboardId: string, caller?: {
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerTier?: number;
		readonly callerAgentId?: string;
	}): { readonly ok: boolean; readonly whiteboard?: IOrchestrationWhiteboard; readonly error?: string; readonly code?: string } {
		const rec = this.requireMission(missionId);
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
			if (!canCallerAccessWhiteboard(graph, existing, this.orgConfig, {
				isHumanUser: caller.isHumanUser,
				isSecretary: caller.isSecretary,
				callerTier: caller.callerTier,
				callerNodeId,
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
		readonly mode?: 'create' | 'write' | 'upsert';
		readonly expectedVersion?: number;
		readonly caller?: {
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerAgentId?: string;
			readonly callerLabel?: string;
		};
	}): { readonly ok: boolean; readonly whiteboard?: IOrchestrationWhiteboard; readonly orchestrationText?: string; readonly currentVersion?: number; readonly error?: string; readonly code?: string } {
		const rec = this.requireMission(missionId);
		const graph = parseOrchestrationGraph(rec.orchestrationText ?? '');
		const callerNodeId = this.resolveCallerOrchestrationNodeId(rec, params.caller?.callerAgentId);
		const callerNode = callerNodeId ? graph.nodes.find(n => n.id === callerNodeId && n.kind === 'staff') : undefined;
		const resolvedDept = params.department?.trim() || callerNode?.department || 'General';

		let wbId = params.id?.trim();
		let nextOrchestrationText = rec.orchestrationText;
		const existsInGraph = Boolean(wbId && graph.nodes.some(n => n.kind === 'whiteboard' && n.id === wbId));
		const existsInStore = Boolean(wbId && rec.whiteboards?.[wbId]);

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
			if (params.mode === 'create') {
				return {
					ok: false,
					code: 'ALREADY_EXISTS',
					currentVersion: existing.version,
					error: `ALREADY_EXISTS: Department whiteboard "${existing.id}" already exists (v${existing.version}). Use "aexus-ade whiteboard write ${existing.id}" to update it.`,
				};
			}
			if (params.caller && !params.caller.isHumanUser && !params.caller.isSecretary) {
				if (!canCallerAccessWhiteboard(graph, existing, this.orgConfig, {
					isHumanUser: params.caller.isHumanUser,
					isSecretary: params.caller.isSecretary,
					callerTier: params.caller.callerTier,
					callerNodeId,
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
			// Enforce department scoping on new whiteboard creation for non-highest-rank in-graph employees.
			if (params.caller && !params.caller.isHumanUser && !params.caller.isSecretary && params.department?.trim()) {
				const highestTier = Math.min(...this.orgConfig.ranks.map(r => r.tier));
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
			// Creating a brand new Department Whiteboard: also add it to the Orchestration canvas graph!
			const planned = planDynamicWhiteboardCreation(rec.orchestrationText ?? '', {
				id: wbId,
				title: params.title?.trim() || `${resolvedDept} Whiteboard`,
				department: resolvedDept,
				connectFromNodeId: callerNodeId,
			});
			if (!planned.ok || !planned.whiteboardId || !planned.orchestrationText) {
				return { ok: false, code: 'INVALID_GRAPH', error: planned.error ?? 'Failed to create Department Whiteboard.' };
			}
			wbId = planned.whiteboardId;
			nextOrchestrationText = planned.orchestrationText;
		}

		const mutated = mutateDepartmentWhiteboard(rec.whiteboards, {
			id: wbId!,
			title: params.title,
			department: existsInStore ? params.department : resolvedDept,
			content: params.content,
			appendContent: params.appendContent,
			mode: params.mode,
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
		// Keep orchestrationText 100% losslessly synchronized with whiteboard metadata & Markdown body!
		const syncedCode = upsertOrchestrationWhiteboardInCode(nextOrchestrationText ?? '', {
			id: mutated.whiteboard.id,
			title: mutated.whiteboard.title,
			department: mutated.whiteboard.department,
			content: mutated.whiteboard.content,
			version: mutated.whiteboard.version,
		});
		nextOrchestrationText = syncedCode;
		this.missionService?.updateWhiteboards(rec.id, mutated.whiteboards);
		if (syncedCode !== (rec.orchestrationText ?? '')) {
			this.missionService?.updateOrchestrationText(rec.id, syncedCode);
		}
		this._onDidChange.fire(rec.id);
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
		const rec = this.requireMission(missionId);
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
		this.missionService?.updateWhiteboards(rec.id, nextWbs);
		if (nextCode !== (rec.orchestrationText ?? '')) {
			this.missionService?.updateOrchestrationText(rec.id, nextCode);
		}
		let prunedTokenIds: readonly string[] = [];
		if (rec.orchestrationRuntime) {
			const pruned = pruneRemovedWhiteboardFromState(this.ensureSynchronizedOrchestrationState(this.requireMission(rec.id)), wbId);
			prunedTokenIds = pruned.prunedTokenIds;
			if (pruned.prunedTokenIds.length > 0) {
				this.commitOrchestrationState(rec.id, pruned.state);
			} else {
				this._onDidChange.fire(rec.id);
			}
		} else {
			this._onDidChange.fire(rec.id);
		}
		return { ok: true, removedWhiteboardId: wbId, prunedTokenIds };
	}
}
