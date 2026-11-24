/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IAdeCloudHostBackendService } from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	AdeThinkingLevel,
	IAdeEngineeringBackendService,
	IAdeInboxService,
	IAdeMissionCheckpointMeta,
} from '../../../../platform/ade/common/adeEngineering.js';
import {
	IMissionBoundaryConfig,
	IMissionNodeAssignment,
	IMissionSupervisorBinding,
	MissionNodeRoleKind,
	validateMissionFactoryBoundary,
} from '../../../../platform/ade/common/adeMissionBoundary.js';
import {
	IMissionDagParseResult,
	IMissionNodeCheckHook,
	IMissionNodeCheckSuiteResult,
} from '../../../../platform/ade/common/adeMissionDag.js';
import {
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
	MissionEngineEffect,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import { AdeModelPricingOverrides } from '../../../../platform/ade/common/adeModelPricing.js';
import {
	getOrchestrationTokenHistory,
	IDereferencedOrchestrationPointer,
	IMissionDiagnosticsReport,
	IMissionTaskCheckReceipt,
	IMissionTaskStatusTransitionResult,
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
	MissionTaskStatus,
	OrchestrationEngineEffect,
	OrchestrationReworkCategory,
	OrchestrationScopeConflictPolicy,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import { IOrchestrationGraphParseResult } from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { IAdeOrganizationConfig } from '../../../../platform/ade/common/adeRoleSchema.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IAdeAgent, IAdeProjectsService } from '../common/ade.js';
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
	beginInteractiveTurn?(
		sessionResourceOrAgentId: string,
		options?: {
			readonly userPrompt?: string;
			readonly isDirectUserChat?: boolean;
		},
	): {
		readonly turnId: string;
		readonly missionId: string;
		readonly nodeId: string;
		readonly tokenId?: string;
		readonly autoMintedRootToken?: boolean;
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
	}): IMissionTaskStatusTransitionResult;
	recordTaskCheckReceipt?(missionId: string, nodeId: string, receipt: IMissionTaskCheckReceipt): void;
	getMissionDiagnostics(missionId: string): IMissionDiagnosticsReport;
	createMissionCheckpoint(missionId: string, options?: {
		readonly label?: string;
		readonly reason?: string;
		readonly createdBy?: string;
	}): Promise<IAdeMissionCheckpointMeta & { readonly summary?: IOrchestrationCheckpointSummary }>;
	listMissionCheckpoints(missionId: string): Promise<readonly IAdeMissionCheckpointMeta[]>;
	diffMissionCheckpoint(missionId: string, fromCheckpointId: string, toCheckpointId?: string): Promise<IOrchestrationCheckpointDiff>;
	restoreMissionCheckpoint(missionId: string, checkpointId: string, options?: {
		readonly mode?: 'full' | 'tokens_only';
		readonly restoredBy?: string;
	}): Promise<IOrchestrationCheckpointRestoreResult & { readonly preRestoreCheckpointId?: string }>;
	getOrchestrationState(missionId: string): IOrchestrationRuntimeState;
	getCurrentOrchestrationTokens(agentId: string, missionId?: string): readonly IOrchestrationToken[];
	getOrchestrationTokenDelta(missionId: string, tokenId: string): IOrchestrationTokenDeltaView | undefined;
	getOrchestrationTokenHistory(missionId: string, tokenId: string, options?: { readonly includeAll?: boolean }): ReturnType<typeof getOrchestrationTokenHistory>;
	getOrchestrationTokenHistoryAsync?(missionId: string, tokenId: string, options?: { readonly includeAll?: boolean }): Promise<ReturnType<typeof getOrchestrationTokenHistory> & { readonly archived?: boolean }>;
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
	}): { readonly items: readonly IDereferencedOrchestrationPointer[] };
	readOrchestrationTokenPointersAsync?(missionId: string, params: {
		readonly ptrs: readonly string[];
		readonly tokenId?: string;
		readonly slice?: IWhiteboardSliceOptions;
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
		readonly refPtrs?: readonly string[];
	}): Promise<IOrchestrationTransitionResult<{ readonly tokenId: string; readonly targetNodeId: string; readonly payloadPtr?: string }>>;
	mintOrchestrationTokens(missionId: string, params: {
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
	}>>;
	returnOrchestrationToken(missionId: string, params: {
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
		readonly completeTask?: boolean;
		readonly force?: boolean;
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerTier?: number;
		readonly callerLabel?: string;
		readonly callerAgentId?: string;
		readonly skipChecks?: boolean;
	}): Promise<IOrchestrationTransitionResult<{ readonly nextTokenIds: readonly string[]; readonly finished?: boolean; readonly payloadPtr?: string; readonly barrierSatisfied?: boolean; readonly completedTaskIds?: readonly string[] }>>;
	failOrchestrationToken(missionId: string, params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly detail?: string;
		readonly category?: OrchestrationReworkCategory;
		readonly callerAgentId?: string;
	}): Promise<IOrchestrationTransitionResult<{ readonly barrierSatisfied?: boolean; readonly payloadPtr?: string; readonly notifiedSuperiorNodeId?: string; readonly recoveryTokenId?: string }>>;
	rejectOrchestrationToken(missionId: string, params: {
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
	}>>;
	retryOrchestrationToken(missionId: string, params: {
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
	}>>;
	pauseOrchestration(missionId: string, reason?: string): Promise<IOrchestrationTransitionResult<{ readonly status: 'paused' }>>;
	resumeOrchestration(missionId: string): Promise<IOrchestrationTransitionResult<{ readonly status: 'running'; readonly activeTokenIds: readonly string[] }>>;
	abortOrchestrationTokens(missionId: string, reason?: string): Promise<IOrchestrationTransitionResult<{ readonly abortedTokenIds: readonly string[]; readonly abortedBarrierIds: readonly string[] }>>;
	setOrchestrationLimits(missionId: string, params: {
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
	}>;
	setTransientRetryBackoffsForTesting?(backoffsMs: readonly number[]): void;
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
		readonly stoppedAgentIds?: readonly string[];
		readonly orchestrationText?: string;
		readonly error?: string;
		readonly code?: string;
	}>;
	reconcileRemovedOrchestrationStaff(missionId: string, removedNodeIds: readonly string[], options?: {
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
	}): { readonly ok: boolean; readonly whiteboard?: IOrchestrationWhiteboard; readonly orchestrationText?: string; readonly currentVersion?: number; readonly error?: string; readonly code?: string };
	removeOrchestrationWhiteboard(missionId: string, whiteboardId: string): {
		readonly ok: boolean;
		readonly removedWhiteboardId?: string;
		readonly prunedTokenIds?: readonly string[];
		readonly error?: string;
		readonly code?: string;
	};
}

export interface IMissionTurnAttribution {
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

export interface IPendingAgentDispatchOptions {
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
}

export interface IPendingAgentDispatch {
	readonly prompt: string;
	readonly options?: IPendingAgentDispatchOptions;
}

export interface IInMemoryCheckpointEntry {
	readonly meta: IAdeMissionCheckpointMeta;
	readonly snapshotJson: string;
}

export interface IAdeMissionRuntimeHost {
	readonly isDisposed: boolean;
	readonly missionService: IAdeMissionService | undefined;
	readonly projectsService: IAdeProjectsService | undefined;
	readonly sessionsService: IAdeSessionsService | undefined;
	readonly inboxService: IAdeInboxService | undefined;
	readonly backendService: IAdeEngineeringBackendService | undefined;
	readonly roleSchemaService: IAdeRoleSchemaService | undefined;
	readonly cloudHostService: IAdeCloudHostBackendService | undefined;
	readonly commandService: ICommandService | undefined;
	readonly configurationService: IConfigurationService | undefined;
	readonly orgConfig: IAdeOrganizationConfig;

	readonly lastHeartbeatSyncAt: Map<string, number>;
	readonly inMemoryAgentActivityAt: Map<string, number>;
	readonly unclosedTurnNudgeCount: Map<string, number>;
	readonly transientRetryCount: Map<string, number>;
	transientRetryBackoffsMs: readonly number[];
	engineeringTurnTimeoutMs: number;
	readonly transientCircuitFailuresByKey: Map<string, { count: number; lastFailureAt: number }>;
	readonly inFlightCheckTokens: Set<string>;
	readonly blockedFileSignatureByTokenKey: Map<string, string | null>;
	readonly activeTurnsByAgent: Map<string, number>;
	turnAttributionSeq: number;
	readonly turnAttributionById: Map<string, IMissionTurnAttribution>;
	readonly inFlightTurnByAgent: Map<string, IMissionTurnAttribution>;
	readonly inFlightTurnBySession: Map<string, IMissionTurnAttribution>;
	readonly lastTurnByAgent: Map<string, IMissionTurnAttribution>;
	readonly lastTurnBySession: Map<string, IMissionTurnAttribution>;
	readonly pendingDispatchesByAgent: Map<string, IPendingAgentDispatch[]>;
	readonly compactionChains: Map<string, Promise<void>>;
	readonly memoryCheckpointsByMission: Map<string, IInMemoryCheckpointEntry[]>;

	requireMission(missionId: string): IAdeMissionRecord;
	getModelPricingOverrides(): AdeModelPricingOverrides | undefined;
	getConfiguredConcurrencyLimits(): IMissionConcurrencyLimits | undefined;
	scheduleTrackedTimer(missionId: string | undefined, fn: () => void, delayMs: number): ReturnType<typeof setTimeout>;
	computeTransientRetryDelayMs(baseMs: number, circuitKey: string): number;
	teardownMission(missionId: string): void;
	fireDidChange(missionId: string): void;
	commitState(missionId: string, state: IMissionRuntimeState, options?: { readonly deferPersist?: boolean; readonly skipWatchdogSync?: boolean }): void;
	syncWatchdog(missionId: string, state: IMissionRuntimeState, options?: { readonly preserveExistingOwner?: boolean }): void;

	ensureSynchronizedState(rec: IAdeMissionRecord): IMissionRuntimeState;
	ensureSynchronizedOrchestrationState(rec: IAdeMissionRecord): IOrchestrationRuntimeState;
	commitOrchestrationState(missionId: string, state: IOrchestrationRuntimeState): void;
	resolveNodePricingOptions(state: IMissionRuntimeState, nodeId: string, fallbackAgent?: IAdeAgent): IMissionTurnUsagePricingOptions;
	computeEffectiveNodeChecks(rec: IAdeMissionRecord, parsed?: IMissionDagParseResult, onlyNodeId?: string): Record<string, readonly IMissionNodeCheckHook[]>;
	runNodeChecks(missionId: string, nodeId: string, options?: { readonly checkIds?: readonly string[] }): Promise<IMissionNodeCheckSuiteResult>;
	stopActiveAgentsOnBudgetTrip(state: IMissionRuntimeState, rec?: IAdeMissionRecord): Promise<void>;
	notifyBudgetCircuitTripped(rec: IAdeMissionRecord, state: IMissionRuntimeState): void;
	findMissionForAgent(agentId: string): ReturnType<IAdeMissionRuntimeService['findMissionForAgent']>;
	bindNodeHost(missionId: string, nodeId: string, options: Parameters<IAdeMissionRuntimeService['bindNodeHost']>[2]): ReturnType<IAdeMissionRuntimeService['bindNodeHost']>;
	setBudgetLimit(missionId: string, budgetLimitUsd: number | undefined): ReturnType<IAdeMissionRuntimeService['setBudgetLimit']>;
	failToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['failToken']>[1]): ReturnType<IAdeMissionRuntimeService['failToken']>;
	failOrchestrationToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['failOrchestrationToken']>[1]): ReturnType<IAdeMissionRuntimeService['failOrchestrationToken']>;
	escalate(missionId: string, params: Parameters<IAdeMissionRuntimeService['escalate']>[1]): ReturnType<IAdeMissionRuntimeService['escalate']>;
	touchAgentActivity(sessionResourceOrAgentId: string, timestamp?: number): void;
	flushNextQueuedDispatch(agentId: string): void;
	flushPendingDispatchesForReleasedAgents(prevState: IMissionRuntimeState, nextState: IMissionRuntimeState): void;
	flushPendingDispatchesForReleasedOrchAgents(prevState: IOrchestrationRuntimeState | undefined, nextState: IOrchestrationRuntimeState): void;
	dispatchPromptToAgent(agentId: string | undefined, prompt: string, options?: IPendingAgentDispatchOptions): Promise<boolean>;
	executeEffects(rec: IAdeMissionRecord, effects: readonly MissionEngineEffect[]): Promise<void>;
	executeOrchestrationEffects(rec: IAdeMissionRecord, effects: readonly OrchestrationEngineEffect[], options?: { readonly preferReattachForRemote?: boolean }): Promise<void>;
}
