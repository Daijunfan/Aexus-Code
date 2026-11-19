/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import {
	ADE_WATCHDOG_TIMEOUT_CONFIG_KEY,
	AdeEngineeringRunStatus,
	AdeInboxSeverity,
	AdeThinkingLevel,
	AdeWorkTreeType,
	DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
	IAdeApplyBlueprintOptions,
	IAdeEngineeringBackendService,
	IAdeEngineeringBlueprint,
	IAdeEngineeringBlueprintNode,
	IAdeEngineeringConfigureParams,
	IAdeEngineeringEventLogEntry,
	IAdeEngineeringGateParams,
	IAdeEngineeringManagerSegment,
	IAdeEngineeringNodeRuntimeState,
	IAdeEngineeringResetParams,
	IAdeEngineeringResolvedEdgeStatus,
	IAdeEngineeringResolvedNodeStatus,
	IAdeEngineeringReviewParams,
	IAdeEngineeringService,
	IAdeEngineeringTreeSnapshot,
	IAdeEngineeringTreeState,
	IAdeEngineeringTreeSummary,
	IAdeEngineeringWatchdogActionParams,
	IAdeInboxItem,
	IAdeInboxService,
	IAdeInitEngineeringOptions,
	IAdeIncrementalReportEntry,
	IAdeNodeRoleTokenBreakdown,
	IAdeStoredEngineeringRecord,
	IAdeTokenUsage,
	IAdeTreeTokenUsageSummary,
	IAdeWorkerTurnChanges,
	IAdeWorkspaceSnapshot,
	accumulateTokenUsage,
	createEmptyNodeRoleTokenBreakdown,
	createEmptyTreeTokenUsageSummary,
	resolveAdeInboxSeverity,
} from '../../../../platform/ade/common/adeEngineering.js';
import {
	AdeBlueprintValidationError,
	buildUpstreamReportChain,
	computeAutoLayoutPositions,
	computeEdgeVisualStatus,
	computeGateRollbackNodes,
	computeNodeVisualStatus,
	createStarterBlueprint,
	listUpstreamTaskAncestors,
	normalizeBlueprintEngine,
	parseEngineeringBlueprint,
	serializeEngineeringBlueprint,
	toAdeEngineId,
} from '../../../../platform/ade/common/adeEngineeringBlueprint.js';
import {
	computeTreeFinancialSummary,
	estimateTokenUsageCostUsd,
	formatUsdCost,
} from '../../../../platform/ade/common/adePricing.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { ISCMService } from '../../scm/common/scm.js';
import {
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectsService,
	IAdeWorkTreeSegmentSpec,
} from '../common/ade.js';
import { IAdeSessionsService } from './adeSessionsService.js';

export const ADE_WORKER_HEARTBEAT_COMMAND_ID = 'aexus.ade.engineering.workerHeartbeat';
export const ADE_RECORD_TURN_USAGE_COMMAND_ID = 'aexus.ade.engineering.recordTurnUsage';

export class AdeExistingSubordinatesError extends Error {
	constructor(
		readonly governorSessionId: string,
		readonly subordinateCount: number,
	) {
		super(localize(
			'adeEngineeringHasChildrenError',
			"Governor currently has {0} subordinate session(s). Relocate or delete existing subordinates before enabling Engineering.",
			subordinateCount,
		));
		this.name = 'AdeExistingSubordinatesError';
	}
}

export class AdeRunningNodesAffectedError extends Error {
	constructor(readonly affectedNodeIds: readonly string[]) {
		super(localize(
			'adeEngineeringRunningNodesError',
			"Active node(s) [{0}] are currently in progress. Confirm with forceStopRunning to stop active Worker(s) and apply changes.",
			affectedNodeIds.join(', '),
		));
		this.name = 'AdeRunningNodesAffectedError';
	}
}

/**
 * In-memory fallback backend used when `IMainProcessService` is absent (e.g. browser unit tests).
 */
class InMemoryEngineeringBackend implements IAdeEngineeringBackendService {
	declare readonly _serviceBrand: undefined;
	private readonly trees = new Map<string, IAdeStoredEngineeringRecord>();
	private inbox: IAdeInboxItem[] = [];

	async listStoredTrees(treeType?: AdeWorkTreeType): Promise<readonly IAdeStoredEngineeringRecord[]> {
		const all = [...this.trees.values()];
		return treeType ? all.filter(item => item.treeType === treeType) : all;
	}

	async loadTree(governorSessionId: string): Promise<IAdeStoredEngineeringRecord | undefined> {
		return this.trees.get(governorSessionId);
	}

	async saveTree(record: IAdeStoredEngineeringRecord): Promise<void> {
		this.trees.set(record.governorSessionId, record);
	}

	async deleteTree(governorSessionId: string): Promise<void> {
		this.trees.delete(governorSessionId);
	}

	async loadInbox(): Promise<readonly IAdeInboxItem[]> {
		return [...this.inbox];
	}

	async saveInbox(items: readonly IAdeInboxItem[]): Promise<void> {
		this.inbox = [...items];
	}

	async captureWorkspaceSnapshot(cwd: string): Promise<IAdeWorkspaceSnapshot> {
		return { rootPath: cwd, capturedAt: Date.now(), entries: {} };
	}

	async computeWorkerTurnChanges(): Promise<IAdeWorkerTurnChanges> {
		return { capturedAt: Date.now(), touchedFiles: [], combinedDiff: '' };
	}

	async ensureSegmentWorktree(governorSessionId: string, projectPath: string, segmentId: string) {
		return {
			worktree: {
				segmentId,
				branchName: `aexus-eng/${governorSessionId.slice(0, 8)}/${segmentId}`,
				worktreePath: `${projectPath}/.worktree-${segmentId}`,
			},
		};
	}

	async commitSegmentWorktree(): Promise<string | undefined> {
		return undefined;
	}

	async mergeSegmentsIntoProject() {
		return { ok: true, conflictedFiles: [], summary: '' };
	}

	async cleanupTreeWorktrees(): Promise<void> { }
}

const sharedFallbackBackend = new InMemoryEngineeringBackend();

function resolveOptionalBackend(instantiationService: IInstantiationService): IAdeEngineeringBackendService {
	return instantiationService.invokeFunction(accessor => {
		try {
			return accessor.get(IAdeEngineeringBackendService);
		} catch {
			return sharedFallbackBackend;
		}
	});
}

function resolveOptionalChatService(instantiationService: IInstantiationService): IChatService | undefined {
	return instantiationService.invokeFunction(accessor => {
		try {
			return accessor.get(IChatService);
		} catch {
			return undefined;
		}
	});
}

function resolveOptionalScmService(instantiationService: IInstantiationService): ISCMService | undefined {
	return instantiationService.invokeFunction(accessor => {
		try {
			return accessor.get(ISCMService);
		} catch {
			return undefined;
		}
	});
}

// ---------------------------------------------------------------------------
// ADE Inbox Service (Spec 6.5)
// ---------------------------------------------------------------------------

export class AdeInboxService extends Disposable implements IAdeInboxService {
	declare readonly _serviceBrand: undefined;

	private readonly backend: IAdeEngineeringBackendService;
	private _items: IAdeInboxItem[] = [];
	private readonly _readyPromise: Promise<void>;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	/** Governor session id -> node id of an un-escalated RED Circuit-Breaker trip. */
	private readonly circuitBreakerTrips = new Map<string, string>();

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
	) {
		super();
		this.backend = resolveOptionalBackend(instantiationService);
		this._readyPromise = this.loadInitial();
	}

	private async loadInitial(): Promise<void> {
		try {
			const loaded = await this.backend.loadInbox();
			if (loaded.length > 0 && this._items.length === 0) {
				this._items = [...loaded].sort((a, b) => b.createdAt - a.createdAt);
				this._onDidChange.fire();
			}
		} catch {
			// Ignore transient load error
		}
	}

	get items(): readonly IAdeInboxItem[] {
		return this._items;
	}

	noteCircuitBreakerTrip(governorSessionId: string, nodeId: string): void {
		this.circuitBreakerTrips.set(governorSessionId, nodeId);
	}

	get unreadCount(): number {
		return this._items.filter(item => item.unread && !item.resolved).length;
	}

	list(options?: { unreadOnly?: boolean; governorSessionId?: string; includeResolved?: boolean }): readonly IAdeInboxItem[] {
		const includeResolved = options?.includeResolved ?? true;
		return this._items.filter(item => {
			if (!includeResolved && item.resolved) {
				return false;
			}
			if (options?.unreadOnly && !item.unread) {
				return false;
			}
			if (options?.governorSessionId && item.governorSessionId !== options.governorSessionId) {
				return false;
			}
			return true;
		});
	}

	async postGovernorMessage(params: {
		readonly governorSessionId: string;
		readonly message: string;
		readonly title?: string;
		readonly nodeId?: string;
		readonly severity?: AdeInboxSeverity;
	}): Promise<IAdeInboxItem> {
		await this._readyPromise;
		const gov = this.projects.getAgent(params.governorSessionId);
		const projectUri = gov?.projectUri;
		const title = params.title?.trim() || localize('adeInboxGovernorMsgDefaultTitle', "Governor Escalation — Human Decision Needed");
		const trippedNodeId = this.circuitBreakerTrips.get(params.governorSessionId);
		const escalatesTrip = trippedNodeId !== undefined && (!params.nodeId || params.nodeId === trippedNodeId);
		if (escalatesTrip) {
			this.circuitBreakerTrips.delete(params.governorSessionId);
		}
		const severity: AdeInboxSeverity = params.severity
			?? (escalatesTrip ? 'critical' : resolveAdeInboxSeverity({ kind: 'governor_message', title }));
		const item: IAdeInboxItem = {
			id: generateUuid(),
			kind: 'governor_message',
			treeType: gov?.treeType ?? 'engineering',
			governorSessionId: params.governorSessionId,
			governorLabel: gov?.label ?? params.governorSessionId,
			projectPath: projectUri?.fsPath ?? '',
			projectName: projectUri ? this.projects.getProjectName(projectUri) : '',
			...(params.nodeId ? { nodeId: params.nodeId } : {}),
			title,
			message: params.message.trim(),
			unread: true,
			resolved: false,
			createdAt: Date.now(),
			severity,
		};
		this._items = [item, ...this._items];
		await this.backend.saveInbox(this._items);
		this._onDidChange.fire();
		return item;
	}

	async upsertUserGateTodo(params: {
		readonly governorSessionId: string;
		readonly treeType: AdeWorkTreeType;
		readonly nodeId: string;
		readonly nodeTitle: string;
		readonly description: string;
		readonly upstreamSummary: string;
		readonly rollbackCandidates: readonly { readonly id: string; readonly title: string }[];
	}): Promise<IAdeInboxItem> {
		await this._readyPromise;
		const gov = this.projects.getAgent(params.governorSessionId);
		const projectUri = gov?.projectUri;
		const existingIdx = this._items.findIndex(
			entry => entry.kind === 'user_gate'
				&& entry.governorSessionId === params.governorSessionId
				&& entry.nodeId === params.nodeId
				&& !entry.resolved,
		);

		const updated: IAdeInboxItem = {
			id: existingIdx >= 0 ? this._items[existingIdx].id : generateUuid(),
			kind: 'user_gate',
			treeType: params.treeType,
			governorSessionId: params.governorSessionId,
			governorLabel: gov?.label ?? params.governorSessionId,
			projectPath: projectUri?.fsPath ?? '',
			projectName: projectUri ? this.projects.getProjectName(projectUri) : '',
			nodeId: params.nodeId,
			nodeTitle: params.nodeTitle,
			title: localize('adeInboxGateTitle', "User Acceptance Gate: [{0}] {1}", params.nodeId, params.nodeTitle),
			message: params.description.trim() || localize('adeInboxGateDefaultDesc', "Upstream tasks completed. Please review and approve or roll back."),
			upstreamSummary: params.upstreamSummary,
			rollbackCandidates: params.rollbackCandidates,
			unread: true,
			resolved: false,
			createdAt: Date.now(),
			severity: 'gate',
		};

		if (existingIdx >= 0) {
			const next = [...this._items];
			next.splice(existingIdx, 1);
			this._items = [updated, ...next];
		} else {
			this._items = [updated, ...this._items];
		}
		await this.backend.saveInbox(this._items);
		this._onDidChange.fire();
		return updated;
	}

	async markRead(id?: string): Promise<void> {
		await this._readyPromise;
		let changed = false;
		this._items = this._items.map(item => {
			if ((!id || item.id === id) && item.unread) {
				changed = true;
				return { ...item, unread: false };
			}
			return item;
		});
		if (changed) {
			await this.backend.saveInbox(this._items);
			this._onDidChange.fire();
		}
	}

	async resolveItem(id: string, resolution?: string): Promise<IAdeInboxItem | undefined> {
		await this._readyPromise;
		let resolvedItem: IAdeInboxItem | undefined;
		this._items = this._items.map(item => {
			if (item.id === id) {
				resolvedItem = {
					...item,
					unread: false,
					resolved: true,
					resolution: resolution ?? item.resolution,
					resolvedAt: Date.now(),
				};
				return resolvedItem;
			}
			return item;
		});
		if (resolvedItem) {
			await this.backend.saveInbox(this._items);
			this._onDidChange.fire();
		}
		return resolvedItem;
	}

	async removeItemsForGovernor(governorSessionId: string): Promise<void> {
		await this._readyPromise;
		const next = this._items.filter(item => item.governorSessionId !== governorSessionId);
		if (next.length !== this._items.length) {
			this._items = next;
			await this.backend.saveInbox(this._items);
			this._onDidChange.fire();
		}
	}
}

// ---------------------------------------------------------------------------
// ADE Engineering Workbench Orchestrator & State Machine
// ---------------------------------------------------------------------------

interface ISiblingFileMutation {
	readonly nodeId: string;
	readonly sha1: string | null;
	readonly recordedAt: number;
}

interface IManagedTreeEntry {
	governorSessionId: string;
	treeType: AdeWorkTreeType;
	blueprintText: string;
	blueprint: IAdeEngineeringBlueprint;
	state: IAdeEngineeringTreeState;
	activeWorkerRunTokens: Map<string, number>;
	recentNodeFileMutations: Map<string, ISiblingFileMutation>;
	persistChain: Promise<void>;
	removed?: boolean;
}

export class AdeEngineeringWorkbenchService extends Disposable implements IAdeEngineeringService {
	declare readonly _serviceBrand: undefined;

	private readonly backend: IAdeEngineeringBackendService;
	private readonly chatService: IChatService | undefined;
	private readonly scmService: ISCMService | undefined;
	private readonly trees = new Map<string, IManagedTreeEntry>();
	private readonly readyPromise: Promise<void>;
	private nextRunToken = 1;
	private watchdogTimer: number | undefined;

	private readonly _onDidChangeTree = this._register(new Emitter<string | undefined>());
	readonly onDidChangeTree = this._onDidChangeTree.event;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
		@IAdeSessionsService private readonly sessions: IAdeSessionsService,
		@IAdeEditorService private readonly editors: IAdeEditorService,
		@IAdeInboxService private readonly inbox: IAdeInboxService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IWorkbenchModeService private readonly modeService: IWorkbenchModeService,
	) {
		super();
		this.backend = resolveOptionalBackend(instantiationService);
		this.chatService = resolveOptionalChatService(instantiationService);
		this.scmService = resolveOptionalScmService(instantiationService);
		this.readyPromise = this.hydrateFromDisk();

		if (projects.onDidRemoveAgents) {
			this._register(projects.onDidRemoveAgents(removed => {
				for (const agent of removed) {
					if (!agent.parentId && this.trees.has(agent.id)) {
						void this.cleanupDeletedGovernorTree(agent.id, agent.projectUri.fsPath, removed);
					}
				}
			}));
		}

		this.watchdogTimer = mainWindow.setInterval(() => {
			void this.runWatchdogSweep();
		}, 15_000);
	}

	override dispose(): void {
		if (this.watchdogTimer !== undefined) {
			mainWindow.clearInterval(this.watchdogTimer);
			this.watchdogTimer = undefined;
		}
		super.dispose();
	}

	whenReady(): Promise<void> {
		return this.readyPromise;
	}

	private async hydrateFromDisk(): Promise<void> {
		try {
			const stored = await this.backend.listStoredTrees();
			for (const record of stored) {
				const gov = this.projects.getAgent(record.governorSessionId);
				if (!gov) {
					continue;
				}
				try {
					const blueprint = parseEngineeringBlueprint(record.blueprintText, {
						governorSessionId: record.governorSessionId,
						treeType: record.treeType,
					});
					const recoveredNodes: Record<string, IAdeEngineeringNodeRuntimeState> = {};
					let hadInterruptedNodes = false;
					for (const [nid, nState] of Object.entries(record.state.nodes ?? {})) {
						if (
							!nState.completed
							&& (nState.phase === 'worker_running' || nState.phase === 'employee_review' || nState.phase === 'manager_review' || nState.phase === 'manager_escalation')
						) {
							hadInterruptedNodes = true;
							recoveredNodes[nid] = { ...nState, phase: 'idle' };
						} else {
							recoveredNodes[nid] = nState;
						}
					}
					const nextRunStatus: AdeEngineeringRunStatus = record.state.runStatus === 'running' && hadInterruptedNodes
						? 'paused'
						: record.state.runStatus;

					const entry: IManagedTreeEntry = {
						governorSessionId: record.governorSessionId,
						treeType: record.treeType,
						blueprintText: record.blueprintText,
						blueprint,
						state: {
							...record.state,
							runStatus: nextRunStatus,
							nodes: recoveredNodes,
						},
						activeWorkerRunTokens: new Map(),
						recentNodeFileMutations: new Map(),
						persistChain: Promise.resolve(),
					};
					this.trees.set(record.governorSessionId, entry);
					this.syncSidebarHierarchy(entry);
				} catch {
					// Skip corrupted blueprint file without crashing startup
				}
			}
			if (this.trees.size > 0) {
				this._onDidChangeTree.fire(undefined);
			}
		} catch {
			// Ignore hydration error
		}
	}

	private async cleanupDeletedGovernorTree(
		governorSessionId: string,
		projectPath: string,
		removedAgents?: readonly IAdeAgent[],
	): Promise<void> {
		const entry = this.trees.get(governorSessionId);
		if (!entry) {
			return;
		}
		entry.removed = true;
		entry.activeWorkerRunTokens.clear();
		this.trees.delete(governorSessionId);

		// Stop any active sessions belonging to this Governor's Engineering tree
		const resourcesToKill = new Map<string, URI>();
		if (removedAgents) {
			for (const member of removedAgents) {
				if ((member.id === governorSessionId || member.treeGovernorId === governorSessionId) && member.session) {
					resourcesToKill.set(member.session.resource.toString(), member.session.resource);
				}
			}
		}
		for (const agent of this.projects.agents) {
			if (agent.treeGovernorId === governorSessionId && agent.id !== governorSessionId) {
				if (agent.session) {
					resourcesToKill.set(agent.session.resource.toString(), agent.session.resource);
				}
				this.projects.removeAgent(agent.id);
			}
		}
		for (const resource of resourcesToKill.values()) {
			await this.commandService.executeCommand('aexus.agentEngines.killSession', resource).catch(() => undefined);
		}

		await this.backend.cleanupTreeWorktrees(governorSessionId, projectPath).catch(() => { });
		await this.backend.deleteTree(governorSessionId, entry.treeType).catch(() => { });
		await this.inbox.removeItemsForGovernor(governorSessionId).catch(() => { });
		this._onDidChangeTree.fire(governorSessionId);
	}

	hasTree(governorSessionId: string): boolean {
		return this.trees.has(governorSessionId);
	}

	getOwningGovernorId(agentId: string): string | undefined {
		const gov = this.projects.getWorkTreeGovernor?.(agentId);
		if (gov) {
			return gov.id;
		}
		return this.trees.has(agentId) ? agentId : undefined;
	}

	isAgentLockedByTree(agentId: string): boolean {
		return Boolean(this.getOwningGovernorId(agentId));
	}

	getTreeType(governorSessionId: string): AdeWorkTreeType | undefined {
		return this.trees.get(governorSessionId)?.treeType ?? this.projects.getAgent(governorSessionId)?.treeType;
	}

	listTrees(projectPath?: string, treeType?: AdeWorkTreeType): readonly IAdeEngineeringTreeSummary[] {
		const summaries: IAdeEngineeringTreeSummary[] = [];
		const filterUri = projectPath ? URI.file(projectPath) : undefined;
		for (const entry of this.trees.values()) {
			if (treeType && entry.treeType !== treeType) {
				continue;
			}
			const gov = this.projects.getAgent(entry.governorSessionId);
			if (!gov) {
				continue;
			}
			if (filterUri && !this.uriIdentityService.extUri.isEqual(gov.projectUri, filterUri)) {
				continue;
			}
			const snap = this.buildSnapshot(entry);
			summaries.push({
				governorSessionId: entry.governorSessionId,
				governorLabel: snap.governorLabel,
				projectPath: snap.projectPath,
				projectName: snap.projectName,
				treeType: entry.treeType,
				runStatus: entry.state.runStatus,
				workspaceIsolation: entry.blueprint.metadata.workspaceIsolation,
				managerCount: entry.blueprint.managers.length,
				totalNodes: snap.progress.totalNodes,
				completedNodes: snap.progress.completedNodes,
				runningNodes: snap.progress.runningNodes,
				failedNodes: snap.progress.failedNodes,
				waitingGates: snap.progress.waitingGates,
				tokenUsage: snap.tokenUsage.total,
				updatedAt: entry.state.updatedAt,
			});
		}
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	getBlueprintText(governorSessionId: string): string | undefined {
		return this.trees.get(governorSessionId)?.blueprintText;
	}

	getTreeSnapshot(governorSessionId: string): IAdeEngineeringTreeSnapshot | undefined {
		const entry = this.trees.get(governorSessionId);
		return entry ? this.buildSnapshot(entry) : undefined;
	}

	private buildSnapshot(entry: IManagedTreeEntry): IAdeEngineeringTreeSnapshot {
		const gov = this.projects.getAgent(entry.governorSessionId);
		const projectPath = gov?.projectUri.fsPath ?? entry.state.projectPath;
		const projectName = gov ? this.projects.getProjectName(gov.projectUri) : projectPath.split(/[\\/]/).pop() ?? '';

		const segmentByNode = new Map<string, { segmentId: string; isTail: boolean }>();
		for (const seg of entry.blueprint.managers) {
			const tailId = seg.nodeIds[seg.nodeIds.length - 1];
			for (const nid of seg.nodeIds) {
				segmentByNode.set(nid, { segmentId: seg.segmentId, isTail: nid === tailId });
			}
		}

		let completedNodes = 0;
		let totalTasks = 0;
		let completedTasks = 0;
		let runningNodes = 0;
		let failedNodes = 0;
		let waitingGates = 0;

		const resolvedNodes: IAdeEngineeringResolvedNodeStatus[] = entry.blueprint.nodes.map(node => {
			const segInfo = segmentByNode.get(node.id);
			const runtime: IAdeEngineeringNodeRuntimeState = entry.state.nodes[node.id] ?? {
				nodeId: node.id,
				phase: 'idle',
				completed: false,
				employeeRejectCount: 0,
				formalFailureCount: 0,
				segmentId: segInfo?.segmentId,
			};
			const visualStatus = computeNodeVisualStatus(node, runtime);
			if (node.type === 'task') {
				totalTasks++;
				if (runtime.completed) {
					completedTasks++;
				}
			}
			if (runtime.completed) {
				completedNodes++;
			}
			if (visualStatus === 'running') {
				runningNodes++;
			}
			if (visualStatus === 'failure_1' || visualStatus === 'failure_2' || visualStatus === 'failure_3') {
				failedNodes++;
			}
			if (runtime.phase === 'waiting_user_gate') {
				waitingGates++;
			}

			return {
				node,
				runtime,
				visualStatus,
				segmentId: segInfo?.segmentId,
				isSegmentTail: Boolean(segInfo?.isTail),
				report: entry.state.reports[node.id],
				upstreamReports: buildUpstreamReportChain(node.id, entry.blueprint, entry.state.reports),
			};
		});

		const resolvedEdges: IAdeEngineeringResolvedEdgeStatus[] = entry.blueprint.edges.map(edge => ({
			edge,
			visualStatus: computeEdgeVisualStatus(edge, entry.state.nodes),
		}));

		const resolvedTreeUsage = this.computeResolvedTreeTokenUsage(entry.state);

		return {
			governorSessionId: entry.governorSessionId,
			governorLabel: gov?.label ?? entry.governorSessionId,
			projectPath,
			projectName,
			treeType: entry.treeType,
			blueprintText: entry.blueprintText,
			blueprint: entry.blueprint,
			state: entry.state,
			nodes: resolvedNodes,
			edges: resolvedEdges,
			progress: {
				totalNodes: entry.blueprint.nodes.length,
				completedNodes,
				totalTasks,
				completedTasks,
				runningNodes,
				failedNodes,
				waitingGates,
			},
			tokenUsage: resolvedTreeUsage,
		};
	}

	private computeResolvedTreeTokenUsage(state: IAdeEngineeringTreeState): IAdeTreeTokenUsageSummary {
		if (state.tokenUsage) {
			return state.tokenUsage;
		}
		const empty = createEmptyTreeTokenUsageSummary();
		let worker = empty.worker;
		let employee = empty.employee;
		let manager = empty.manager;
		for (const nState of Object.values(state.nodes)) {
			if (!nState.tokenUsage) {
				continue;
			}
			worker = accumulateTokenUsage(worker, nState.tokenUsage.worker, false);
			employee = accumulateTokenUsage(employee, nState.tokenUsage.employee, false);
			manager = accumulateTokenUsage(manager, nState.tokenUsage.manager, false);
		}
		let total = accumulateTokenUsage(empty.total, worker, false);
		total = accumulateTokenUsage(total, employee, false);
		total = accumulateTokenUsage(total, manager, false);
		return {
			governor: empty.governor,
			manager,
			employee,
			worker,
			total,
		};
	}

	private applyTurnTokenUsage(
		entry: IManagedTreeEntry,
		role: 'worker' | 'employee' | 'manager' | 'governor',
		rawDelta: Partial<IAdeTokenUsage> | undefined,
		nodeId?: string,
	): boolean {
		if (!rawDelta) {
			return false;
		}
		let enrichedDelta: Partial<IAdeTokenUsage> = rawDelta;
		if (!(typeof rawDelta.costUsd === 'number' && Number.isFinite(rawDelta.costUsd) && rawDelta.costUsd > 0)) {
			const node = nodeId ? entry.blueprint.nodes.find(n => n.id === nodeId) : undefined;
			const seg = nodeId ? entry.blueprint.managers.find(m => m.nodeIds.includes(nodeId)) : entry.blueprint.managers[0];
			const roleCfg = role === 'worker'
				? node?.worker
				: role === 'employee'
					? node?.employee
					: seg?.config;
			const normalizedForCost = accumulateTokenUsage(undefined, rawDelta, true);
			const estimatedCost = estimateTokenUsageCostUsd(normalizedForCost, roleCfg);
			if (estimatedCost > 0) {
				enrichedDelta = { ...rawDelta, costUsd: estimatedCost, estimated: true };
			}
		}
		const prevTreeUsage = this.computeResolvedTreeTokenUsage(entry.state);
		const updatedRoleBucket = accumulateTokenUsage(prevTreeUsage[role], enrichedDelta, true);
		if (updatedRoleBucket === prevTreeUsage[role]) {
			return false;
		}
		const updatedTreeTotal = accumulateTokenUsage(prevTreeUsage.total, enrichedDelta, true);
		const nextTreeUsage: IAdeTreeTokenUsageSummary = {
			...prevTreeUsage,
			[role]: updatedRoleBucket,
			total: updatedTreeTotal,
		};

		let nextNodes = entry.state.nodes;
		if (nodeId && role !== 'governor' && entry.state.nodes[nodeId]) {
			const prevNodeState = entry.state.nodes[nodeId];
			const prevNodeUsage: IAdeNodeRoleTokenBreakdown = prevNodeState.tokenUsage ?? createEmptyNodeRoleTokenBreakdown();
			const nextNodeRole = accumulateTokenUsage(prevNodeUsage[role], enrichedDelta, true);
			const nextNodeTotal = accumulateTokenUsage(prevNodeUsage.total, enrichedDelta, true);
			nextNodes = {
				...entry.state.nodes,
				[nodeId]: {
					...prevNodeState,
					tokenUsage: {
						...prevNodeUsage,
						[role]: nextNodeRole,
						total: nextNodeTotal,
					},
				},
			};
		}

		entry.state = {
			...entry.state,
			nodes: nextNodes,
			tokenUsage: nextTreeUsage,
			updatedAt: Date.now(),
		};
		this.enforceBudgetCeilingIfNeeded(entry, nodeId);
		return true;
	}

	private enforceBudgetCeilingIfNeeded(entry: IManagedTreeEntry, nodeId?: string): void {
		const maxBudgetUsd = entry.blueprint.metadata.maxBudgetUsd;
		if (!(typeof maxBudgetUsd === 'number' && Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0)) {
			return;
		}
		if (entry.state.runStatus !== 'running') {
			return;
		}
		const fin = computeTreeFinancialSummary({
			blueprint: entry.blueprint,
			state: entry.state,
			tokenUsage: this.computeResolvedTreeTokenUsage(entry.state),
		});
		if (fin.totalCostUsd < maxBudgetUsd) {
			return;
		}
		entry.state = {
			...entry.state,
			runStatus: 'paused',
			updatedAt: Date.now(),
		};
		const detail = localize(
			'adeEngBudgetLimitReachedDetail',
			"Estimated spend {0} reached budget ceiling {1}. Execution paused automatically to prevent runaway API spend.",
			formatUsdCost(fin.totalCostUsd),
			formatUsdCost(maxBudgetUsd),
		);
		this.appendEvent(entry, 'warn', 'budget.limit_reached', { nodeId, detail });
		void this.inbox.postGovernorMessage({
			governorSessionId: entry.governorSessionId,
			nodeId,
			title: localize('adeEngBudgetPausedInboxTitle', "Budget Guardrail Paused DAG ({0} / {1})", formatUsdCost(fin.totalCostUsd), formatUsdCost(maxBudgetUsd)),
			message: detail,
			severity: 'critical',
		}).catch(() => undefined);
	}

	private syncSidebarHierarchy(entry: IManagedTreeEntry): void {
		if (!this.projects.syncWorkTreeHierarchy) {
			return;
		}
		const nodeById = new Map(entry.blueprint.nodes.map(n => [n.id, n]));
		const segmentSpecs: IAdeWorkTreeSegmentSpec[] = entry.blueprint.managers.map(seg => {
			const worktreePath = entry.state.worktrees?.[seg.segmentId]?.worktreePath;
			const tasks = seg.nodeIds
				.map(nid => nodeById.get(nid))
				.filter((n): n is IAdeEngineeringBlueprintNode => Boolean(n && n.type === 'task'))
				.map(node => {
					const rState = entry.state.nodes[node.id];
					return {
						nodeId: node.id,
						title: node.title,
						employeeEngineId: toAdeEngineId(node.employee?.engine, 'aexus-claude'),
						employeeModel: node.employee?.model,
						employeeThinking: node.employee?.thinking ?? 'medium',
						workerEngineId: toAdeEngineId(node.worker?.engine, 'aexus-codex'),
						workerModel: node.worker?.model,
						workerThinking: node.worker?.thinking ?? 'high',
						existingEmployeeAgentId: rState?.employeeAgentId,
						existingWorkerAgentId: rState?.workerAgentId,
						workingDirectoryOverride: worktreePath,
					};
				});
			return {
				segmentId: seg.segmentId,
				label: `Segment [${seg.segmentId}]`,
				managerEngineId: toAdeEngineId(seg.config.engine, 'aexus-claude'),
				managerModel: seg.config.model,
				managerThinking: seg.config.thinking,
				existingManagerAgentId: entry.state.managerAgentsBySegment[seg.segmentId],
				workingDirectoryOverride: worktreePath,
				tasks,
			};
		});

		const synced = this.projects.syncWorkTreeHierarchy(entry.governorSessionId, entry.treeType, segmentSpecs);
		for (const removed of synced.removedAgents) {
			if (removed.session) {
				void this.sessions.stop?.(removed.session)?.catch(() => undefined);
				void this.sessions.delete(removed.session).catch(() => undefined);
			}
		}
		const nextNodes: Record<string, IAdeEngineeringNodeRuntimeState> = { ...entry.state.nodes };
		for (const node of entry.blueprint.nodes) {
			const seg = entry.blueprint.managers.find(m => m.nodeIds.includes(node.id));
			const prev = nextNodes[node.id] ?? {
				nodeId: node.id,
				phase: 'idle',
				completed: false,
				employeeRejectCount: 0,
				formalFailureCount: 0,
			};
			nextNodes[node.id] = {
				...prev,
				segmentId: seg?.segmentId,
				managerAgentId: seg ? synced.managerAgentsBySegment[seg.segmentId] : undefined,
				employeeAgentId: synced.employeeAgentsByNode[node.id],
				workerAgentId: synced.workerAgentsByNode[node.id],
			};
		}
		entry.state = {
			...entry.state,
			managerAgentsBySegment: synced.managerAgentsBySegment,
			nodes: nextNodes,
		};
	}

	private appendEvent(
		entry: IManagedTreeEntry,
		level: 'info' | 'warn' | 'error',
		event: string,
		options?: { nodeId?: string; segmentId?: string; detail?: string },
	): void {
		const logItem: IAdeEngineeringEventLogEntry = {
			id: generateUuid(),
			timestamp: Date.now(),
			level,
			event,
			...(options?.nodeId ? { nodeId: options.nodeId } : {}),
			...(options?.segmentId ? { segmentId: options.segmentId } : {}),
			...(options?.detail ? { detail: options.detail } : {}),
		};
		const nextEvents = [...entry.state.events, logItem].slice(-250);
		entry.state = {
			...entry.state,
			updatedAt: logItem.timestamp,
			events: nextEvents,
		};
	}

	private async persistEntry(entry: IManagedTreeEntry): Promise<void> {
		if (entry.removed || !this.trees.has(entry.governorSessionId)) {
			return;
		}
		entry.state = {
			...entry.state,
			updatedAt: Date.now(),
		};
		const snapshotRecord: IAdeStoredEngineeringRecord = {
			governorSessionId: entry.governorSessionId,
			treeType: entry.treeType,
			blueprintText: entry.blueprintText,
			state: entry.state,
		};
		const nextWrite = entry.persistChain.then(async () => {
			if (entry.removed || !this.trees.has(entry.governorSessionId)) {
				return;
			}
			await this.backend.saveTree(snapshotRecord);
		}).catch(() => undefined);
		entry.persistChain = nextWrite;
		await nextWrite;
		if (!entry.removed && this.trees.has(entry.governorSessionId)) {
			this._onDidChangeTree.fire(entry.governorSessionId);
		}
	}

	async initTree(options: IAdeInitEngineeringOptions): Promise<IAdeEngineeringTreeSnapshot> {
		await this.readyPromise;
		const treeType: AdeWorkTreeType = options.treeType ?? 'engineering';
		const gov = this.projects.getAgent(options.governorSessionId);
		if (!gov) {
			throw new Error(localize('adeEngineeringGovNotFound', "Governor session '{0}' not found.", options.governorSessionId));
		}
		if (gov.parentId) {
			throw new Error(localize('adeEngineeringGovMustBeRoot', "Only a top-level Governor session can own an Engineering tree."));
		}

		// Spec 2.1(a): If already initialized for this treeType, return existing snapshot directly
		const existing = this.trees.get(gov.id);
		if (existing) {
			if (existing.treeType !== treeType) {
				throw new Error(localize(
					'adeEngineeringTreeTypeConflict',
					"Governor '{0}' is already bound to a '{1}' tree and cannot mix work tree types.",
					gov.label,
					existing.treeType,
				));
			}
			return this.buildSnapshot(existing);
		}

		// Spec 2.1(c): Intercept existing subordinate sessions before enabling Engineering
		const directChildren = this.projects.getDirectSubordinates(gov.id);
		if (directChildren.length > 0) {
			if (!options.onChildren) {
				throw new AdeExistingSubordinatesError(gov.id, directChildren.length);
			}
			if (options.onChildren === 'relocate') {
				const targetParent = options.relocateTargetParentId?.trim() || undefined;
				for (const child of [...directChildren]) {
					const moved = this.projects.reparentAgent(child.id, targetParent, gov.projectUri);
					if (!moved) {
						throw new Error(localize('adeEngineeringRelocateFailed', "Could not relocate subordinate '{0}'.", child.label));
					}
				}
			} else if (options.onChildren === 'delete') {
				const descendants = this.projects.getSubtree(gov.id).slice(1);
				for (const member of descendants) {
					if (member.session) {
						await this.sessions.delete(member.session).catch(() => { });
					}
				}
				await this.editors.closeAgents(descendants);
				for (const child of [...directChildren]) {
					this.projects.removeAgent(child.id);
				}
			}
		}

		// Ensure role is governor
		if (gov.role !== 'governor') {
			this.projects.setAgentRole(gov.id, 'governor');
		}

		const defaultEngine = normalizeBlueprintEngine(gov.session?.engineId ?? gov.preferredEngineId ?? 'claude-code');
		const starterBlueprint = createStarterBlueprint(gov.id, defaultEngine, treeType);
		const blueprintText = serializeEngineeringBlueprint(starterBlueprint);
		const now = Date.now();

		const entry: IManagedTreeEntry = {
			governorSessionId: gov.id,
			treeType,
			blueprintText,
			blueprint: starterBlueprint,
			state: {
				treeType,
				governorSessionId: gov.id,
				projectPath: gov.projectUri.fsPath,
				runStatus: 'idle',
				createdAt: now,
				updatedAt: now,
				managerAgentsBySegment: {},
				nodes: {},
				reports: {},
				events: [],
			},
			activeWorkerRunTokens: new Map(),
			recentNodeFileMutations: new Map(),
			persistChain: Promise.resolve(),
		};

		this.trees.set(gov.id, entry);
		this.syncSidebarHierarchy(entry);
		this.appendEvent(entry, 'info', 'tree.initialized', { detail: `Initialized ${treeType} tree for "${gov.label}"` });
		await this.persistEntry(entry);
		return this.buildSnapshot(entry);
	}

	async applyBlueprint(options: IAdeApplyBlueprintOptions): Promise<IAdeEngineeringTreeSnapshot> {
		await this.readyPromise;
		const entry = this.trees.get(options.governorSessionId);
		if (!entry) {
			throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", options.governorSessionId));
		}
		const gov = this.projects.getAgent(entry.governorSessionId);
		const defaultEngine = normalizeBlueprintEngine(gov?.session?.engineId ?? gov?.preferredEngineId ?? 'claude-code');

		const nextBlueprintRaw = parseEngineeringBlueprint(options.blueprintText, {
			governorSessionId: entry.governorSessionId,
			treeType: entry.treeType,
			defaultEngine,
		});

		// Assign auto-layout coordinates to any newly added nodes lacking canvas positions,
		// OR resolve cramped/overlapping LLM-authored `@pos` coordinates (< 175px center-to-center).
		const autoPositions = computeAutoLayoutPositions(nextBlueprintRaw);
		let hasOverlappingPositions = false;
		for (let i = 0; i < nextBlueprintRaw.nodes.length && !hasOverlappingPositions; i++) {
			const pi = nextBlueprintRaw.nodes[i].position;
			if (!pi) {
				continue;
			}
			for (let j = i + 1; j < nextBlueprintRaw.nodes.length; j++) {
				const pj = nextBlueprintRaw.nodes[j].position;
				if (pj && Math.hypot(pi.x - pj.x, pi.y - pj.y) < 175) {
					hasOverlappingPositions = true;
					break;
				}
			}
		}
		const positionedNodes = nextBlueprintRaw.nodes.map(node => (!node.position || hasOverlappingPositions)
			? { ...node, position: autoPositions.get(node.id) ?? node.position }
			: node,
		);
		const nextBlueprint: IAdeEngineeringBlueprint = {
			...nextBlueprintRaw,
			metadata: {
				...nextBlueprintRaw.metadata,
				governorSessionId: entry.governorSessionId,
				treeType: entry.treeType,
			},
			nodes: positionedNodes,
		};

		const oldNodeById = new Map(entry.blueprint.nodes.map(n => [n.id, n]));
		const nextNodeById = new Map(nextBlueprint.nodes.map(n => [n.id, n]));
		const oldIncomingByNode = new Map<string, string>();
		const nextIncomingByNode = new Map<string, string>();
		for (const n of entry.blueprint.nodes) {
			oldIncomingByNode.set(n.id, entry.blueprint.edges.filter(e => e.to === n.id).map(e => e.from).sort().join(','));
		}
		for (const n of nextBlueprint.nodes) {
			nextIncomingByNode.set(n.id, nextBlueprint.edges.filter(e => e.to === n.id).map(e => e.from).sort().join(','));
		}

		// Spec 6.4(a): Completed nodes are strictly locked (cannot delete or mutate core definition/incoming edges)
		for (const [nodeId, rState] of Object.entries(entry.state.nodes)) {
			if (!rState.completed) {
				continue;
			}
			const oldNode = oldNodeById.get(nodeId);
			const nextNode = nextNodeById.get(nodeId);
			if (!oldNode) {
				continue;
			}
			if (!nextNode) {
				throw new AdeBlueprintValidationError(localize('adeCompletedNodeDeleted', "Completed node '{0}' is locked and cannot be deleted.", nodeId));
			}
			const coreChanged = oldNode.type !== nextNode.type
				|| Boolean(oldNode.critical) !== Boolean(nextNode.critical)
				|| (oldNode.goal ?? '').trim() !== (nextNode.goal ?? '').trim()
				|| (oldNode.acceptance ?? '').trim() !== (nextNode.acceptance ?? '').trim()
				|| (oldNode.description ?? '').trim() !== (nextNode.description ?? '').trim()
				|| (oldIncomingByNode.get(nodeId) ?? '') !== (nextIncomingByNode.get(nodeId) ?? '');
			if (coreChanged) {
				throw new AdeBlueprintValidationError(localize('adeCompletedNodeLocked', "Completed node '{0}' is locked and cannot be modified.", nodeId));
			}
		}

		// Spec 6.4(c): Detect active in-progress nodes affected by draft edits
		const affectedRunningNodes: string[] = [];
		for (const [nodeId, rState] of Object.entries(entry.state.nodes)) {
			if (rState.completed || rState.phase === 'idle' || rState.phase === 'circuit_broken') {
				continue;
			}
			const oldNode = oldNodeById.get(nodeId);
			const nextNode = nextNodeById.get(nodeId);
			if (!oldNode) {
				continue;
			}
			if (!nextNode) {
				affectedRunningNodes.push(nodeId);
				continue;
			}
			const modified = oldNode.type !== nextNode.type
				|| oldNode.title !== nextNode.title
				|| Boolean(oldNode.critical) !== Boolean(nextNode.critical)
				|| (oldNode.goal ?? '').trim() !== (nextNode.goal ?? '').trim()
				|| (oldNode.acceptance ?? '').trim() !== (nextNode.acceptance ?? '').trim()
				|| (oldNode.description ?? '').trim() !== (nextNode.description ?? '').trim()
				|| oldNode.worker?.engine !== nextNode.worker?.engine
				|| oldNode.worker?.model !== nextNode.worker?.model
				|| oldNode.worker?.thinking !== nextNode.worker?.thinking
				|| oldNode.employee?.engine !== nextNode.employee?.engine
				|| oldNode.employee?.model !== nextNode.employee?.model
				|| oldNode.employee?.thinking !== nextNode.employee?.thinking
				|| (oldIncomingByNode.get(nodeId) ?? '') !== (nextIncomingByNode.get(nodeId) ?? '');
			if (modified) {
				affectedRunningNodes.push(nodeId);
			}
		}

		if (affectedRunningNodes.length > 0 && !options.forceStopRunning) {
			throw new AdeRunningNodesAffectedError(affectedRunningNodes);
		}

		// Force-stop affected active nodes if confirmed
		if (affectedRunningNodes.length > 0) {
			for (const nodeId of affectedRunningNodes) {
				await this.forceStopNodeAgents(entry, nodeId);
			}
		}

		const preservedNodesState: Record<string, IAdeEngineeringNodeRuntimeState> = {};
		const affectedSet = new Set(affectedRunningNodes);
		for (const node of nextBlueprint.nodes) {
			const prev = entry.state.nodes[node.id];
			if (prev && !affectedSet.has(node.id)) {
				preservedNodesState[node.id] = prev;
			} else if (prev && affectedSet.has(node.id)) {
				preservedNodesState[node.id] = {
					...prev,
					phase: 'idle',
					completed: false,
					employeeRejectCount: 0,
				};
			} else {
				preservedNodesState[node.id] = {
					nodeId: node.id,
					phase: 'idle',
					completed: false,
					employeeRejectCount: 0,
					formalFailureCount: 0,
				};
			}
		}

		const preservedReports: Record<string, IAdeIncrementalReportEntry> = {};
		for (const [nid, rep] of Object.entries(entry.state.reports)) {
			if (nextNodeById.has(nid)) {
				const incomingChanged = !preservedNodesState[nid]?.completed
					&& (oldIncomingByNode.get(nid) ?? '') !== (nextIncomingByNode.get(nid) ?? '');
				preservedReports[nid] = incomingChanged ? { ...rep, stale: true } : rep;
			}
		}

		const canonicalText = serializeEngineeringBlueprint(nextBlueprint);
		entry.blueprint = nextBlueprint;
		entry.blueprintText = canonicalText;
		entry.state = {
			...entry.state,
			nodes: preservedNodesState,
			reports: preservedReports,
		};

		this.syncSidebarHierarchy(entry);
		this.appendEvent(entry, 'info', 'blueprint.applied', {
			detail: `${nextBlueprint.nodes.length} node(s), ${nextBlueprint.managers.length} Manager segment(s)`,
		});
		await this.persistEntry(entry);

		if (entry.state.runStatus === 'running') {
			void this.scheduleReadyNodes(entry);
		}

		return this.buildSnapshot(entry);
	}

	async removeTree(governorSessionId: string): Promise<void> {
		await this.readyPromise;
		const entry = this.trees.get(governorSessionId);
		if (!entry) {
			return;
		}
		await this.stopTree(governorSessionId);
		entry.removed = true;
		const gov = this.projects.getAgent(governorSessionId);
		if (gov) {
			const descendants = this.projects.getSubtree(gov.id).slice(1);
			await this.editors.closeAgents(descendants);
			for (const child of this.projects.getDirectSubordinates(gov.id)) {
				this.projects.removeAgent(child.id);
			}
			this.projects.setAgentWorkTreeTag?.(gov.id, undefined);
		}
		this.trees.delete(governorSessionId);
		await this.backend.cleanupTreeWorktrees(governorSessionId, entry.state.projectPath).catch(() => { });
		await this.backend.deleteTree(governorSessionId, entry.treeType);
		await this.inbox.removeItemsForGovernor(governorSessionId);
		this._onDidChangeTree.fire(governorSessionId);
	}

	async configureTree(params: IAdeEngineeringConfigureParams): Promise<IAdeEngineeringTreeSnapshot> {
		await this.readyPromise;
		const entry = this.trees.get(params.governorSessionId);
		if (!entry) {
			throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", params.governorSessionId));
		}
		const targetRole = params.role ?? 'all';
		const normEngine = params.engine ? normalizeBlueprintEngine(params.engine) : undefined;
		const patchRoleCfg = (prev: { readonly engine: string; readonly model?: string; readonly thinking: AdeThinkingLevel }) => {
			const nextModel = params.clearModel ? undefined : (params.model !== undefined ? (params.model.trim() || undefined) : prev.model);
			return {
				engine: normEngine ?? prev.engine,
				...(nextModel ? { model: nextModel } : {}),
				thinking: params.thinking ?? prev.thinking,
			};
		};

		const nextNodes = entry.blueprint.nodes.map(node => {
			if (node.type !== 'task' || entry.state.nodes[node.id]?.completed) {
				return node;
			}
			if (params.nodeId && node.id !== params.nodeId) {
				return node;
			}
			return {
				...node,
				worker: (targetRole === 'worker' || targetRole === 'all')
					? patchRoleCfg(node.worker ?? { engine: 'claude-code', thinking: 'high' })
					: node.worker,
				employee: (targetRole === 'employee' || targetRole === 'all')
					? patchRoleCfg(node.employee ?? { engine: 'claude-code', thinking: 'medium' })
					: node.employee,
			};
		});

		const nextManagers = entry.blueprint.managers.map(mgr => {
			if (targetRole !== 'manager' && targetRole !== 'all') {
				return mgr;
			}
			if (params.nodeId && !mgr.nodeIds.includes(params.nodeId)) {
				return mgr;
			}
			return { ...mgr, config: patchRoleCfg(mgr.config) };
		});

		const nextBudgetUsd = params.clearBudget
			? undefined
			: (typeof params.maxBudgetUsd === 'number' && Number.isFinite(params.maxBudgetUsd)
				? (params.maxBudgetUsd > 0 ? Math.round(params.maxBudgetUsd * 100) / 100 : undefined)
				: entry.blueprint.metadata.maxBudgetUsd);
		const nextMetadata = {
			treeType: entry.blueprint.metadata.treeType,
			governorSessionId: entry.blueprint.metadata.governorSessionId,
			workspaceIsolation: params.workspaceIsolation ?? entry.blueprint.metadata.workspaceIsolation,
			watchdogTimeoutMinutes: entry.blueprint.metadata.watchdogTimeoutMinutes,
			...(entry.blueprint.metadata.flowDirection ? { flowDirection: entry.blueprint.metadata.flowDirection } : {}),
			...(nextBudgetUsd !== undefined ? { maxBudgetUsd: nextBudgetUsd } : {}),
		};
		const nextBp: IAdeEngineeringBlueprint = {
			...entry.blueprint,
			metadata: nextMetadata,
			managers: nextManagers,
			nodes: nextNodes,
		};
		return this.applyBlueprint({
			governorSessionId: params.governorSessionId,
			blueprintText: serializeEngineeringBlueprint(nextBp),
			forceStopRunning: params.forceStopRunning ?? false,
		});
	}

	async mergeTreeWorktrees(governorSessionId: string): Promise<{ readonly ok: boolean; readonly conflictedFiles: readonly string[]; readonly summary: string }> {
		await this.readyPromise;
		const entry = this.trees.get(governorSessionId);
		if (!entry) {
			throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", governorSessionId));
		}
		const worktrees = Object.values(entry.state.worktrees ?? {});
		if (worktrees.length === 0) {
			return { ok: true, conflictedFiles: [], summary: 'No isolated segment worktrees are active for this DAG.' };
		}
		for (const wt of worktrees) {
			await this.backend.commitSegmentWorktree(wt.worktreePath, `chore(ade): checkpoint segment ${wt.segmentId} before merge`).catch(() => undefined);
		}
		const branches = worktrees.map(wt => wt.branchName);
		const result = await this.backend.mergeSegmentsIntoProject(entry.state.projectPath, branches);
		this.appendEvent(entry, result.ok ? 'info' : 'warn', result.ok ? 'worktree.merged' : 'worktree.merge_conflict', {
			detail: result.summary,
		});
		if (!result.ok) {
			void this.inbox.postGovernorMessage({
				governorSessionId: entry.governorSessionId,
				title: localize('adeEngWorktreeMergeConflictTitle', "Worktree Merge Conflict ({0} file(s))", result.conflictedFiles.length),
				message: result.summary,
				severity: 'critical',
			}).catch(() => undefined);
		}
		await this.persistEntry(entry);
		return result;
	}

	async cleanupTreeWorktrees(governorSessionId: string): Promise<void> {
		await this.readyPromise;
		const entry = this.trees.get(governorSessionId);
		if (!entry) {
			throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", governorSessionId));
		}
		await this.backend.cleanupTreeWorktrees(governorSessionId, entry.state.projectPath);
		entry.state = {
			...entry.state,
			worktrees: {},
			updatedAt: Date.now(),
		};
		this.appendEvent(entry, 'info', 'worktree.cleaned', {
			detail: 'Pruned isolated Git worktrees for this DAG.',
		});
		await this.persistEntry(entry);
	}

	async resetTree(params: IAdeEngineeringResetParams): Promise<IAdeEngineeringTreeSnapshot> {
		await this.readyPromise;
		const entry = this.trees.get(params.governorSessionId);
		if (!entry) {
			throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", params.governorSessionId));
		}

		const resetSet = new Set<string>();
		if (params.nodeId?.trim()) {
			const startId = params.nodeId.trim();
			if (!entry.blueprint.nodes.some(n => n.id === startId)) {
				throw new Error(localize('adeEngineeringTaskNodeNotFound', "Task node '{0}' not found in blueprint.", startId));
			}
			const queue = [startId];
			while (queue.length > 0) {
				const cur = queue.shift()!;
				if (resetSet.has(cur)) {
					continue;
				}
				resetSet.add(cur);
				for (const edge of entry.blueprint.edges) {
					if (edge.from === cur && !resetSet.has(edge.to)) {
						queue.push(edge.to);
					}
				}
			}
		} else {
			for (const node of entry.blueprint.nodes) {
				if (params.keepCompleted && entry.state.nodes[node.id]?.completed) {
					continue;
				}
				resetSet.add(node.id);
			}
		}

		for (const nid of resetSet) {
			const rState = entry.state.nodes[nid];
			if (rState && rState.phase !== 'idle') {
				await this.forceStopNodeAgents(entry, nid);
			}
		}

		const nextNodes: Record<string, IAdeEngineeringNodeRuntimeState> = { ...entry.state.nodes };
		const nextReports: Record<string, IAdeIncrementalReportEntry> = { ...entry.state.reports };
		for (const nid of resetSet) {
			const prev = nextNodes[nid];
			nextNodes[nid] = {
				nodeId: nid,
				phase: 'idle',
				completed: false,
				employeeRejectCount: 0,
				formalFailureCount: 0,
				fourthChanceGranted: false,
				segmentId: prev?.segmentId,
				managerAgentId: prev?.managerAgentId,
				employeeAgentId: prev?.employeeAgentId,
				workerAgentId: prev?.workerAgentId,
			};
			delete nextReports[nid];
		}

		const fullReset = !params.nodeId?.trim() && !params.keepCompleted;
		if (fullReset) {
			await this.backend.cleanupTreeWorktrees(entry.governorSessionId, entry.state.projectPath).catch(() => { });
			await this.inbox.removeItemsForGovernor(entry.governorSessionId).catch(() => { });
		}

		entry.state = {
			...entry.state,
			runStatus: params.nodeId?.trim()
				? ((entry.state.runStatus === 'circuit_broken' || entry.state.runStatus === 'completed') ? 'idle' : entry.state.runStatus)
				: 'idle',
			nodes: nextNodes,
			reports: nextReports,
			...(fullReset ? { worktrees: {}, tokenUsage: createEmptyTreeTokenUsageSummary() } : {}),
		};
		this.appendEvent(entry, 'info', 'tree.reset', {
			nodeId: params.nodeId?.trim(),
			detail: params.nodeId?.trim() ? `Reset [${[...resetSet].join(', ')}]` : 'Reset entire Engineering tree',
		});
		await this.persistEntry(entry);
		return this.buildSnapshot(entry);
	}

	private assertStartAuthorized(caller: string | undefined): void {
		const normalized = (caller ?? 'user').trim().toLowerCase();
		if (
			normalized === 'governor' || normalized.startsWith('governor:')
			|| normalized === 'manager' || normalized.startsWith('manager:')
			|| normalized === 'employee' || normalized.startsWith('employee:')
			|| normalized === 'worker' || normalized.startsWith('worker:')
		) {
			throw new Error(localize(
				'adeEngineeringGovernorStartForbidden',
				"Permission denied: Orchestrated tree agents ({0}) cannot start Engineering execution directly. Only the User (via Engineering page) or Secretary may start execution.",
				normalized,
			));
		}
	}

	async runTree(governorSessionId: string, caller = 'user'): Promise<IAdeEngineeringTreeSnapshot> {
		await this.readyPromise;
		this.assertStartAuthorized(caller);
		const entry = this.trees.get(governorSessionId);
		if (!entry) {
			throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", governorSessionId));
		}

		const nextNodes: Record<string, IAdeEngineeringNodeRuntimeState> = { ...entry.state.nodes };
		for (const [nid, nState] of Object.entries(nextNodes)) {
			if (!nState.completed && (nState.phase === 'circuit_broken' || nState.formalFailureCount >= 3)) {
				nextNodes[nid] = {
					...nState,
					phase: 'idle',
					formalFailureCount: 0,
					employeeRejectCount: 0,
					fourthChanceGranted: false,
				};
			}
		}
		entry.state = {
			...entry.state,
			runStatus: 'running',
			nodes: nextNodes,
		};
		this.appendEvent(entry, 'info', 'tree.started', { detail: `Started by ${caller}` });
		await this.persistEntry(entry);
		await this.scheduleReadyNodes(entry);
		return this.buildSnapshot(entry);
	}

	async pauseTree(governorSessionId: string): Promise<IAdeEngineeringTreeSnapshot> {
		await this.readyPromise;
		const entry = this.trees.get(governorSessionId);
		if (!entry) {
			throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", governorSessionId));
		}
		for (const node of entry.blueprint.nodes) {
			const rState = entry.state.nodes[node.id];
			if (rState && !rState.completed && rState.phase !== 'idle' && rState.phase !== 'waiting_user_gate' && rState.phase !== 'circuit_broken') {
				await this.forceStopNodeAgents(entry, node.id);
			}
		}
		const pausedNodes: Record<string, IAdeEngineeringNodeRuntimeState> = {};
		for (const [nid, rState] of Object.entries(entry.state.nodes)) {
			pausedNodes[nid] = (!rState.completed && rState.phase !== 'idle' && rState.phase !== 'waiting_user_gate' && rState.phase !== 'circuit_broken')
				? { ...rState, phase: 'idle' }
				: rState;
		}
		entry.state = { ...entry.state, runStatus: 'paused', nodes: pausedNodes };
		this.appendEvent(entry, 'info', 'tree.paused');
		await this.persistEntry(entry);
		return this.buildSnapshot(entry);
	}

	async resumeTree(governorSessionId: string, caller = 'user'): Promise<IAdeEngineeringTreeSnapshot> {
		await this.readyPromise;
		this.assertStartAuthorized(caller);
		const entry = this.trees.get(governorSessionId);
		if (!entry) {
			throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", governorSessionId));
		}
		const nextNodes: Record<string, IAdeEngineeringNodeRuntimeState> = { ...entry.state.nodes };
		for (const [nid, nState] of Object.entries(nextNodes)) {
			if (!nState.completed && (nState.phase === 'circuit_broken' || nState.formalFailureCount >= 3)) {
				nextNodes[nid] = {
					...nState,
					phase: 'idle',
					formalFailureCount: 0,
					employeeRejectCount: 0,
					fourthChanceGranted: false,
				};
			}
		}
		entry.state = { ...entry.state, runStatus: 'running', nodes: nextNodes };
		this.appendEvent(entry, 'info', 'tree.resumed', { detail: `Resumed by ${caller}` });
		await this.persistEntry(entry);
		await this.scheduleReadyNodes(entry);
		return this.buildSnapshot(entry);
	}

	async stopTree(governorSessionId: string): Promise<IAdeEngineeringTreeSnapshot> {
		await this.readyPromise;
		const entry = this.trees.get(governorSessionId);
		if (!entry) {
			throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", governorSessionId));
		}
		for (const node of entry.blueprint.nodes) {
			const rState = entry.state.nodes[node.id];
			if (rState && !rState.completed && rState.phase !== 'idle') {
				await this.forceStopNodeAgents(entry, node.id);
			}
		}
		const resetActiveNodes: Record<string, IAdeEngineeringNodeRuntimeState> = {};
		for (const [nid, rState] of Object.entries(entry.state.nodes)) {
			resetActiveNodes[nid] = rState.completed ? rState : { ...rState, phase: 'idle' };
		}
		entry.state = {
			...entry.state,
			runStatus: 'idle',
			nodes: resetActiveNodes,
		};
		this.appendEvent(entry, 'warn', 'tree.stopped');
		await this.persistEntry(entry);
		return this.buildSnapshot(entry);
	}

	private async forceStopNodeAgents(entry: IManagedTreeEntry, nodeId: string): Promise<void> {
		entry.activeWorkerRunTokens.delete(nodeId);
		const rState = entry.state.nodes[nodeId];
		if (!rState) {
			return;
		}
		for (const aid of [rState.workerAgentId, rState.employeeAgentId, rState.managerAgentId]) {
			if (!aid) {
				continue;
			}
			const agent = this.projects.getAgent(aid);
			if (agent?.session) {
				await this.commandService.executeCommand('aexus.agentEngines.stop', agent.session.resource).catch(() => undefined);
			}
			this.projects.setAgentStatus(aid, 'idle');
		}
	}

	private async ensureAgentMaterialized(agentId: string, cwdOverride?: string): Promise<IAdeAgent> {
		let agent = this.projects.getAgent(agentId);
		if (!agent) {
			throw new Error(`ADE Engineering agent ${agentId} no longer exists.`);
		}
		if (agent.session) {
			return agent;
		}
		const engineId = agent.preferredEngineId || 'aexus-claude';
		const targetCwd = cwdOverride
			? URI.file(cwdOverride)
			: (agent.workingDirectoryOverride ? URI.file(agent.workingDirectoryOverride) : agent.projectUri);
		const created = await this.sessions.create(engineId, targetCwd);
		this.projects.bindSession(agent.id, { engineId: created.engineId, resource: created.resource });
		agent = this.projects.getAgent(agentId)!;
		return agent;
	}

	private async dispatchSessionTurn(
		agentId: string,
		prompt: string,
		options: {
			readonly model?: string;
			readonly thinking?: AdeThinkingLevel;
			readonly pureWorker: boolean;
			readonly cwdOverride?: string;
			readonly usageContext?: {
				readonly entry: IManagedTreeEntry;
				readonly role: 'worker' | 'employee' | 'manager' | 'governor';
				readonly nodeId?: string;
			};
		},
	): Promise<{ reply: string; stopped?: boolean }> {
		const agent = await this.ensureAgentMaterialized(agentId, options.cwdOverride);
		if (!agent.session) {
			return { reply: '' };
		}
		const resolvedCallerRole = options.pureWorker
			? 'worker'
			: (agent.role ?? 'employee');
		const turnStartedAt = Date.now();
		this.projects.setAgentStatus(agent.id, 'working');
		try {
			let extResult: { reply?: string; stopped?: boolean; usage?: Partial<IAdeTokenUsage> } | undefined;
			let commandMissing = false;
			try {
				extResult = await this.commandService.executeCommand<{ reply?: string; stopped?: boolean; usage?: Partial<IAdeTokenUsage> }>(
					'aexus.agentEngines.dispatchEngineeringTurn',
					agent.session.resource,
					prompt,
					{
						agentId: agent.id,
						model: options.model,
						thinking: options.thinking,
						pureWorker: options.pureWorker,
						callerRole: resolvedCallerRole,
						cwdOverride: options.cwdOverride,
					},
				);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				if (/command .* not found|Unregistered command/i.test(errMsg)) {
					commandMissing = true;
				} else {
					throw err;
				}
			}

			if (!commandMissing && extResult && typeof extResult === 'object') {
				const replyText = extResult.reply ?? '';
				if (options.usageContext) {
					const fallbackUsage: Partial<IAdeTokenUsage> = extResult.usage ?? {
						inputTokens: Math.ceil(prompt.length / 4),
						outputTokens: Math.ceil(replyText.length / 4),
						durationMs: Math.max(0, Date.now() - turnStartedAt),
						estimated: true,
					};
					if (this.applyTurnTokenUsage(options.usageContext.entry, options.usageContext.role, fallbackUsage, options.usageContext.nodeId)) {
						await this.persistEntry(options.usageContext.entry).catch(() => undefined);
					}
				}
				return {
					reply: replyText,
					stopped: extResult.stopped,
				};
			}

			// Fallback for unit-test harnesses where extension host command isn't registered
			if (this.chatService) {
				const existing = this.chatService.getSession?.(agent.session.resource);
				const loadedRef = !existing && this.chatService.acquireOrLoadSession
					? await this.chatService.acquireOrLoadSession(agent.session.resource, ChatAgentLocation.Chat, CancellationToken.None, 'adeEngineering')
					: undefined;
				try {
					const sent = await this.chatService.sendRequest(agent.session.resource, prompt);
					if (sent.kind === 'sent') {
						await sent.data.responseCompletePromise;
					} else if (sent.kind === 'queued') {
						await sent.deferred;
					}
				} finally {
					loadedRef?.dispose();
				}
				if (options.usageContext) {
					const fallbackSimUsage: Partial<IAdeTokenUsage> = {
						inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
						outputTokens: 16,
						durationMs: Math.max(0, Date.now() - turnStartedAt),
						estimated: true,
					};
					if (this.applyTurnTokenUsage(options.usageContext.entry, options.usageContext.role, fallbackSimUsage, options.usageContext.nodeId)) {
						await this.persistEntry(options.usageContext.entry).catch(() => undefined);
					}
				}
			}
			return { reply: '' };
		} finally {
			this.projects.setAgentStatus(agent.id, 'idle', true);
		}
	}

	private buildPureWorkerPrompt(
		node: IAdeEngineeringBlueprintNode,
		upstreamReports: readonly IAdeIncrementalReportEntry[],
		reworkInstruction?: { readonly source: 'employee' | 'manager' | 'user_gate' | 'watchdog'; readonly feedback: string },
		sharedWorkspace = false,
	): string {
		// STRICT COMPLIANCE (Spec 1.2 & 3.2):
		// Worker L4 context MUST remain 100% pure business code instructions.
		// Zero ADE role names, zero hierarchy info, zero `aexus-ade` commands, zero report requests!
		const sections: string[] = [];

		if (upstreamReports.length > 0) {
			sections.push([
				'## Completed Upstream Context',
				...upstreamReports.map(r => `- **${r.nodeTitle}** (\`${r.nodeId}\`): ${r.summary}`),
			].join('\n'));
		}

		sections.push([
			`## Task: ${node.title}`,
			(node.goal ?? '').trim() || `Implement ${node.title}.`,
			...(sharedWorkspace ? ['', 'Touch only files required for this task; leave any other files in the workspace untouched.'] : []),
		].join('\n'));

		if (node.acceptance?.trim()) {
			sections.push([
				'## Acceptance Requirements',
				node.acceptance.trim(),
			].join('\n'));
		}

		if (reworkInstruction?.feedback?.trim()) {
			sections.push([
				'## Required Revisions on Existing Code',
				'Modify the existing workspace code incrementally to address the following review feedback:',
				reworkInstruction.feedback.trim(),
			].join('\n'));
		}

		return sections.join('\n\n');
	}

	private buildSiblingSha1Filter(
		entry: IManagedTreeEntry,
		currentNodeId: string,
		turnStartedAt: number,
	): Readonly<Record<string, string | null>> | undefined {
		if (entry.blueprint.metadata.workspaceIsolation === 'worktree' || entry.recentNodeFileMutations.size === 0) {
			return undefined;
		}
		const filter: Record<string, string | null> = {};
		let count = 0;
		for (const [relPath, mut] of entry.recentNodeFileMutations.entries()) {
			if (mut.nodeId !== currentNodeId && mut.recordedAt >= turnStartedAt) {
				filter[relPath] = mut.sha1;
				count++;
			}
		}
		return count > 0 ? filter : undefined;
	}

	private recordNodeFileMutations(entry: IManagedTreeEntry, nodeId: string, changes: IAdeWorkerTurnChanges): void {
		if (entry.blueprint.metadata.workspaceIsolation === 'worktree') {
			return;
		}
		for (const f of changes.touchedFiles) {
			entry.recentNodeFileMutations.set(f.relativePath, {
				nodeId,
				sha1: f.kind === 'deleted' ? null : (f.afterSha1 ?? null),
				recordedAt: changes.capturedAt,
			});
		}
	}

	private async refreshProjectScmSilently(projectPath: string): Promise<void> {
		if (!this.scmService || !projectPath) {
			return;
		}
		try {
			const projectUri = URI.file(projectPath);
			let matched = [...this.scmService.repositories].find(
				repo => repo.provider.rootUri && this.uriIdentityService.extUri.isEqual(repo.provider.rootUri, projectUri),
			);
			if (!matched) {
				await this.commandService.executeCommand('git.openRepository', projectPath).catch(() => undefined);
				matched = [...this.scmService.repositories].find(
					repo => repo.provider.rootUri && this.uriIdentityService.extUri.isEqual(repo.provider.rootUri, projectUri),
				);
			}
			if (matched?.provider.rootUri) {
				await this.commandService.executeCommand('git.refresh', matched.provider.rootUri).catch(() => undefined);
			}
		} catch {
			// Ignore SCM refresh errors
		}
	}

	private formatUpstreamSummaryBlock(upstreamReports: readonly IAdeIncrementalReportEntry[]): string {
		if (upstreamReports.length === 0) {
			return '(None — root task)';
		}
		return upstreamReports.map(r => `- [${r.nodeId}] ${r.nodeTitle}: ${r.summary}`).join('\n');
	}

	private hasDownstreamTaskNode(fromNodeId: string, blueprint: IAdeEngineeringBlueprint): boolean {
		const visited = new Set<string>();
		const queue = [fromNodeId];
		while (queue.length > 0) {
			const cur = queue.shift()!;
			for (const e of blueprint.edges) {
				if (e.from !== cur || visited.has(e.to)) {
					continue;
				}
				visited.add(e.to);
				const dst = blueprint.nodes.find(n => n.id === e.to);
				if (dst?.type === 'task') {
					return true;
				}
				queue.push(e.to);
			}
		}
		return false;
	}

	private async scheduleReadyNodes(entry: IManagedTreeEntry): Promise<void> {
		if (entry.removed || entry.state.runStatus !== 'running') {
			return;
		}

		const allDone = entry.blueprint.nodes.length > 0
			&& entry.blueprint.nodes.every(n => Boolean(entry.state.nodes[n.id]?.completed));
		if (allDone) {
			if (entry.blueprint.metadata.workspaceIsolation === 'worktree' && entry.state.worktrees) {
				const terminalSegBranches = entry.blueprint.managers
					.filter(m => {
						const tailId = m.nodeIds[m.nodeIds.length - 1];
						return !this.hasDownstreamTaskNode(tailId, entry.blueprint);
					})
					.map(m => entry.state.worktrees?.[m.segmentId]?.branchName)
					.filter((b): b is string => Boolean(b));
				if (terminalSegBranches.length > 0) {
					const mergeRes = await this.backend.mergeSegmentsIntoProject(entry.state.projectPath, terminalSegBranches).catch(err => ({
						ok: false,
						conflictedFiles: [] as readonly string[],
						summary: err instanceof Error ? err.message : String(err),
					}));
					void this.refreshProjectScmSilently(entry.state.projectPath);
					if (!mergeRes.ok) {
						entry.state = { ...entry.state, runStatus: 'circuit_broken' };
						this.appendEvent(entry, 'error', 'worktree.project_merge_failed', {
							detail: `Conflict merging terminal branch(es): ${mergeRes.conflictedFiles.join(', ')} — ${mergeRes.summary}`,
						});
						await this.inbox.postGovernorMessage({
							governorSessionId: entry.governorSessionId,
							title: localize('adeEngMergeConflictInboxTitle', "Git Worktree Final Merge Conflict"),
							message: `${mergeRes.conflictedFiles.join(', ')}\n\n${mergeRes.summary}`,
							severity: 'critical',
						}).catch(() => undefined);
						await this.persistEntry(entry);
						return;
					}
				}
			}
			entry.state = { ...entry.state, runStatus: 'completed' };
			this.appendEvent(entry, 'info', 'tree.completed', { detail: 'All DAG nodes completed.' });
			await this.persistEntry(entry);
			return;
		}

		const incomingByNode = new Map<string, string[]>();
		for (const node of entry.blueprint.nodes) {
			incomingByNode.set(node.id, []);
		}
		for (const edge of entry.blueprint.edges) {
			incomingByNode.get(edge.to)?.push(edge.from);
		}

		const readyNodes = entry.blueprint.nodes.filter(node => {
			const rState = entry.state.nodes[node.id];
			if (!rState || rState.completed || rState.phase !== 'idle') {
				return false;
			}
			const preds = incomingByNode.get(node.id) ?? [];
			return preds.every(predId => Boolean(entry.state.nodes[predId]?.completed));
		});

		for (const node of readyNodes) {
			if (node.type === 'user_gate') {
				await this.activateUserGateNode(entry, node);
			} else {
				void this.activateTaskNodeWorker(entry, node);
			}
		}

		// Transition runStatus to 'waiting_gate' if at least one gate is waiting and zero other nodes are actively running
		const hasWaitingGate = Object.values(entry.state.nodes).some(s => !s.completed && s.phase === 'waiting_user_gate');
		const hasActiveWork = Object.values(entry.state.nodes).some(
			s => !s.completed && s.phase !== 'idle' && s.phase !== 'waiting_user_gate' && s.phase !== 'circuit_broken',
		);
		if (hasWaitingGate && !hasActiveWork && entry.state.runStatus === 'running') {
			entry.state = { ...entry.state, runStatus: 'waiting_gate' };
			await this.persistEntry(entry);
		}
	}

	private async activateUserGateNode(entry: IManagedTreeEntry, node: IAdeEngineeringBlueprintNode): Promise<void> {
		const upstreamReports = buildUpstreamReportChain(node.id, entry.blueprint, entry.state.reports);
		const rollbackCandidates = listUpstreamTaskAncestors(node.id, entry.blueprint).map(n => ({ id: n.id, title: n.title }));
		const prev = entry.state.nodes[node.id];
		const nextNodes = {
			...entry.state.nodes,
			[node.id]: {
				...(prev ?? { nodeId: node.id, completed: false, employeeRejectCount: 0, formalFailureCount: 0 }),
				phase: 'waiting_user_gate' as const,
				startedAt: Date.now(),
			},
		};

		const anyOtherActive = Object.values(nextNodes).some(
			s => s.nodeId !== node.id && !s.completed && s.phase !== 'idle' && s.phase !== 'waiting_user_gate' && s.phase !== 'circuit_broken',
		);
		entry.state = {
			...entry.state,
			runStatus: anyOtherActive ? entry.state.runStatus : 'waiting_gate',
			nodes: nextNodes,
		};

		await this.inbox.upsertUserGateTodo({
			governorSessionId: entry.governorSessionId,
			treeType: entry.treeType,
			nodeId: node.id,
			nodeTitle: node.title,
			description: node.description ?? '',
			upstreamSummary: this.formatUpstreamSummaryBlock(upstreamReports),
			rollbackCandidates,
		});
		this.appendEvent(entry, 'info', 'gate.waiting', { nodeId: node.id, detail: node.title });
		await this.persistEntry(entry);
	}

	private async resolveEffectiveWorkspaceDir(
		entry: IManagedTreeEntry,
		node: IAdeEngineeringBlueprintNode,
	): Promise<{ cwd: string; mergeConflict?: { conflictedFiles: readonly string[]; summary: string } }> {
		if (entry.blueprint.metadata.workspaceIsolation !== 'worktree') {
			return { cwd: entry.state.projectPath };
		}
		const seg = entry.blueprint.managers.find(m => m.nodeIds.includes(node.id));
		if (!seg) {
			return { cwd: entry.state.projectPath };
		}
		const isSegHead = seg.nodeIds[0] === node.id;
		const upstreamBranches: string[] = [];
		if (isSegHead) {
			const nodeById = new Map(entry.blueprint.nodes.map(n => [n.id, n]));
			const visited = new Set<string>();
			const queue = entry.blueprint.edges.filter(e => e.to === node.id).map(e => e.from);
			while (queue.length > 0) {
				const predId = queue.shift()!;
				if (visited.has(predId)) {
					continue;
				}
				visited.add(predId);
				const predNode = nodeById.get(predId);
				if (predNode?.type === 'user_gate') {
					for (const e of entry.blueprint.edges) {
						if (e.to === predId && !visited.has(e.from)) {
							queue.push(e.from);
						}
					}
					continue;
				}
				const predSeg = entry.blueprint.managers.find(m => m.nodeIds.includes(predId));
				const branch = predSeg ? entry.state.worktrees?.[predSeg.segmentId]?.branchName : undefined;
				if (branch && !upstreamBranches.includes(branch)) {
					upstreamBranches.push(branch);
				}
			}
		}
		const ensured = await this.backend.ensureSegmentWorktree(
			entry.governorSessionId,
			entry.state.projectPath,
			seg.segmentId,
			upstreamBranches,
		);
		entry.state = {
			...entry.state,
			worktrees: {
				...(entry.state.worktrees ?? {}),
				[seg.segmentId]: ensured.worktree,
			},
		};
		return {
			cwd: ensured.worktree.worktreePath,
			mergeConflict: ensured.mergeConflict,
		};
	}

	private async activateTaskNodeWorker(
		entry: IManagedTreeEntry,
		node: IAdeEngineeringBlueprintNode,
		reworkInstruction?: { readonly source: 'employee' | 'manager' | 'user_gate' | 'watchdog'; readonly feedback: string },
	): Promise<void> {
		if (entry.removed || entry.state.runStatus !== 'running') {
			return;
		}
		const rState = entry.state.nodes[node.id];
		if (!rState?.workerAgentId || rState.completed) {
			return;
		}
		// Prevent duplicate concurrent activation when no explicit rework instruction is overriding
		if (!reworkInstruction && entry.activeWorkerRunTokens.has(node.id)) {
			return;
		}

		const effectiveRework = reworkInstruction
			?? (rState.lastGateFeedback ? { source: 'user_gate' as const, feedback: rState.lastGateFeedback } : undefined);

		// Reserve synchronously BEFORE any await (eliminates duplicate scheduleReadyNodes activation race)
		const runToken = ++this.nextRunToken;
		entry.activeWorkerRunTokens.set(node.id, runToken);
		const reservedAt = Date.now();
		entry.state = {
			...entry.state,
			nodes: {
				...entry.state.nodes,
				[node.id]: {
					...rState,
					phase: 'worker_running',
					startedAt: rState.startedAt ?? reservedAt,
					lastStreamActivityAt: reservedAt,
					lastGateFeedback: undefined,
				},
			},
		};

		let effectiveCwd = entry.state.projectPath;
		try {
			const ws = await this.resolveEffectiveWorkspaceDir(entry, node);
			if (entry.removed || entry.activeWorkerRunTokens.get(node.id) !== runToken || entry.state.runStatus !== 'running') {
				return;
			}
			effectiveCwd = ws.cwd;
			if (ws.mergeConflict) {
				entry.activeWorkerRunTokens.delete(node.id);
				const curState = entry.state.nodes[node.id] ?? rState;
				// Spec 4.2: Wake segment Manager to resolve Git merge conflict before running Worker!
				entry.state = {
					...entry.state,
					nodes: {
						...entry.state.nodes,
						[node.id]: {
							...curState,
							phase: 'manager_escalation',
						},
					},
				};
				this.appendEvent(entry, 'warn', 'worktree.conflict', {
					nodeId: node.id,
					segmentId: curState.segmentId,
					detail: `Merge conflict on: ${ws.mergeConflict.conflictedFiles.join(', ')}`,
				});
				await this.persistEntry(entry);
				await this.wakeSegmentManagerForMergeConflict(entry, node, effectiveCwd, ws.mergeConflict);
				return;
			}
		} catch (err) {
			this.appendEvent(entry, 'warn', 'worktree.fallback', {
				nodeId: node.id,
				detail: err instanceof Error ? err.message : String(err),
			});
		}

		if (entry.removed || entry.activeWorkerRunTokens.get(node.id) !== runToken || entry.state.runStatus !== 'running') {
			return;
		}

		this.appendEvent(entry, 'info', effectiveRework ? `worker.rework.${effectiveRework.source}` : 'worker.dispatched', {
			nodeId: node.id,
			segmentId: rState.segmentId,
			detail: node.title,
		});
		await this.persistEntry(entry);

		const beforeSnapshot = await this.backend.captureWorkspaceSnapshot(effectiveCwd);
		if (entry.removed || entry.activeWorkerRunTokens.get(node.id) !== runToken || entry.state.runStatus !== 'running') {
			return;
		}
		const upstreamReports = buildUpstreamReportChain(node.id, entry.blueprint, entry.state.reports);
		const isSharedWorkspace = entry.blueprint.metadata.workspaceIsolation !== 'worktree';
		const purePrompt = this.buildPureWorkerPrompt(node, upstreamReports, effectiveRework, isSharedWorkspace);

		try {
			const turnRes = await this.dispatchSessionTurn(rState.workerAgentId, purePrompt, {
				model: node.worker?.model,
				thinking: node.worker?.thinking ?? 'high',
				pureWorker: true,
				cwdOverride: effectiveCwd,
				usageContext: { entry, role: 'worker', nodeId: node.id },
			});

			// Abort if removed, stopped, paused, or superseded by another runToken
			if (entry.removed || entry.activeWorkerRunTokens.get(node.id) !== runToken || turnRes.stopped || entry.state.runStatus !== 'running') {
				return;
			}
			entry.activeWorkerRunTokens.delete(node.id);

			const siblingFilter = this.buildSiblingSha1Filter(entry, node.id, beforeSnapshot.capturedAt);
			const changes = await this.backend.computeWorkerTurnChanges(effectiveCwd, beforeSnapshot, siblingFilter);
			this.recordNodeFileMutations(entry, node.id, changes);
			void this.refreshProjectScmSilently(entry.state.projectPath);
			await this.handleWorkerTurnCompleted(entry, node, effectiveCwd, turnRes.reply, changes);
		} catch (err) {
			if (entry.removed || entry.activeWorkerRunTokens.get(node.id) !== runToken || entry.state.runStatus !== 'running') {
				return;
			}
			entry.activeWorkerRunTokens.delete(node.id);
			const errMsg = err instanceof Error ? err.message : String(err);
			this.appendEvent(entry, 'error', 'worker.error', { nodeId: node.id, detail: errMsg });
			const siblingFilter = this.buildSiblingSha1Filter(entry, node.id, beforeSnapshot.capturedAt);
			const changes = await this.backend.computeWorkerTurnChanges(effectiveCwd, beforeSnapshot, siblingFilter).catch(() => ({
				capturedAt: Date.now(),
				touchedFiles: [],
				combinedDiff: '',
			}));
			this.recordNodeFileMutations(entry, node.id, changes);
			void this.refreshProjectScmSilently(entry.state.projectPath);
			await this.handleWorkerTurnCompleted(entry, node, effectiveCwd, `[Worker execution error]: ${errMsg}`, changes);
		}
	}

	private async handleWorkerTurnCompleted(
		entry: IManagedTreeEntry,
		node: IAdeEngineeringBlueprintNode,
		effectiveCwd: string,
		workerReply: string,
		changes: IAdeWorkerTurnChanges,
	): Promise<void> {
		const latest = entry.state.nodes[node.id];
		if (!latest || latest.completed) {
			return;
		}
		entry.state = {
			...entry.state,
			nodes: {
				...entry.state.nodes,
				[node.id]: {
					...latest,
					phase: 'employee_review',
					lastWorkerOutput: workerReply.slice(0, 6000),
					lastChanges: changes,
				},
			},
		};
		this.appendEvent(entry, 'info', 'employee.review_started', {
			nodeId: node.id,
			detail: `${changes.touchedFiles.length} file(s) touched`,
		});
		await this.persistEntry(entry);

		// Spec 3.3: Wake Employee (L3) to verify Worker's implementation & diff without writing code itself
		if (!latest.employeeAgentId) {
			return;
		}
		const upstreamReports = buildUpstreamReportChain(node.id, entry.blueprint, entry.state.reports);
		const touchedSummary = changes.touchedFiles.length > 0
			? changes.touchedFiles.map(f => `- [${f.kind.toUpperCase()}] ${f.relativePath}`).join('\n')
			: '(No workspace file mutations detected in snapshot)';

		const reviewPrompt = [
			`# Engineering Single-Node Review — [${node.id}] ${node.title}`,
			`You are the **Employee (L3 · Single-Node Acceptance Reviewer — NOT Worker [L4])** for task node \`${node.id}\` in Engineering tree \`${entry.governorSessionId}\`.`,
			'**STRICT ROLE BOUNDARY (`Employee ≠ Worker`)**: You are `Employee (L3)`, NOT `Worker (L4)`! NEVER write or modify business code yourself — your subordinate `Worker (L4)` executes all coding, while your sole responsibility is to audit your Worker\'s implementation against the Acceptance Criteria and submit your verdict & node report via `aexus-ade`.',
			...(entry.blueprint.metadata.workspaceIsolation !== 'worktree'
				? ['**Shared-Workspace Concurrency Rule**: Parallel DAG nodes may create or modify unrelated files in this shared repository simultaneously. Evaluate ONLY the files and behavior belonging to `' + node.id + '` — NEVER reject or ask your Worker to delete unrelated files created by parallel nodes!']
				: []),
			'',
			'## Node Goal',
			(node.goal ?? '').trim() || '(See node title)',
			'',
			'## Acceptance Criteria',
			(node.acceptance ?? '').trim() || 'Implementation is complete, clean, and free of build/test errors.',
			'',
			'## Upstream Incremental Reports',
			this.formatUpstreamSummaryBlock(upstreamReports),
			'',
			'## Worker Output Summary',
			workerReply.trim() ? workerReply.trim().slice(0, 4000) : '(No text summary returned by Worker)',
			'',
			'## Files Touched by Worker This Turn',
			touchedSummary,
			'',
			'## Unified Diff of Worker Changes',
			changes.combinedDiff ? `\`\`\`diff\n${changes.combinedDiff}\n\`\`\`` : '(Empty diff — you may run read-only `git status` / `git diff` or test commands if needed)',
			'',
			'## Required Action (Execute ONE command via bash/terminal tool)',
			`- **If PASS**: Write a concise summary of what this node accomplished and run:`,
			`  \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role employee --verdict pass --report "<concise summary for downstream nodes>"\``,
			latest.fourthChanceGranted
				? `- **If REJECT** (4th-chance final review — rejection routes directly to Segment Manager formal judgment): Provide specific actionable fix instructions and run:`
				: `- **If REJECT** (internal iteration ${(latest.employeeRejectCount ?? 0) + 1}/3): Provide specific actionable fix instructions for the original Worker and run:`,
			`  \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role employee --verdict reject --feedback "<specific issues & fix instructions>"\``,
		].join('\n');

		void this.dispatchReviewerWithNudge(entry, node.id, 'employee_review', latest.employeeAgentId, reviewPrompt, {
			model: node.employee?.model,
			thinking: node.employee?.thinking ?? 'medium',
			cwdOverride: effectiveCwd,
		}, [
			`IMPORTANT: Your Employee review turn for node \`${node.id}\` ended without executing the required \`aexus-ade engineering review\` command via Bash.`,
			`Execute ONE of the following commands immediately via your Bash tool so the Engineering DAG state machine records your verdict:`,
			`- Pass: \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role employee --verdict pass --report "<concise summary>"\``,
			`- Reject: \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role employee --verdict reject --feedback "<fix instructions>"\``,
		].join('\n'));
	}

	private async dispatchReviewerWithNudge(
		entry: IManagedTreeEntry,
		nodeId: string,
		expectedPhase: 'employee_review' | 'manager_review' | 'manager_escalation',
		reviewerAgentId: string,
		prompt: string,
		options: { readonly model?: string; readonly thinking?: AdeThinkingLevel; readonly cwdOverride?: string },
		nudgePrompt: string,
	): Promise<void> {
		const reviewerRole: 'employee' | 'manager' = expectedPhase === 'employee_review' ? 'employee' : 'manager';
		try {
			const res = await this.dispatchSessionTurn(reviewerAgentId, prompt, {
				model: options.model,
				thinking: options.thinking,
				pureWorker: false,
				cwdOverride: options.cwdOverride,
				usageContext: { entry, role: reviewerRole, nodeId },
			});
			if (
				!entry.removed
				&& !res.stopped
				&& res.reply.trim() !== 'Acknowledged.'
				&& entry.state.runStatus === 'running'
				&& entry.state.nodes[nodeId]?.phase === expectedPhase
			) {
				this.appendEvent(entry, 'warn', 'reviewer.nudge_missing_verdict', { nodeId, detail: expectedPhase });
				await this.dispatchSessionTurn(reviewerAgentId, nudgePrompt, {
					model: options.model,
					thinking: options.thinking,
					pureWorker: false,
					cwdOverride: options.cwdOverride,
					usageContext: { entry, role: reviewerRole, nodeId },
				});
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.appendEvent(entry, 'error', 'reviewer.error', { nodeId, detail: msg });
			await this.persistEntry(entry).catch(() => undefined);
		}
	}

	private async wakeSegmentManagerForSecondaryReview(
		entry: IManagedTreeEntry,
		node: IAdeEngineeringBlueprintNode,
		seg: IAdeEngineeringManagerSegment,
	): Promise<void> {
		const rState = entry.state.nodes[node.id];
		if (!rState?.managerAgentId) {
			return;
		}
		const effectiveCwd = entry.state.worktrees?.[seg.segmentId]?.worktreePath ?? entry.state.projectPath;
		const segReports = seg.nodeIds
			.map(nid => entry.state.reports[nid])
			.filter((r): r is IAdeIncrementalReportEntry => Boolean(r && !r.stale))
			.map(r => `- [${r.nodeId}] ${r.nodeTitle}: ${r.summary}`)
			.join('\n');

		const prompt = [
			`# Engineering Segment Secondary Review — Segment [${seg.segmentId}] · Node [${node.id}] ${node.title}`,
			`You are the **Manager (L2 · Critical Segment Lead)** responsible for segment \`${seg.segmentId}\` (\`${seg.nodeIds.join(' -> ')}\`) in Engineering tree \`${entry.governorSessionId}\`.`,
			`Node \`${node.id}\` (${node.critical ? '★Critical Gate' : 'Segment Tail Node'}) has passed Employee primary review and requires your secondary segment-level verification.`,
			...(entry.blueprint.metadata.workspaceIsolation !== 'worktree'
				? ['**Shared-Workspace Concurrency Rule**: Parallel DAG segments may create or modify unrelated files in this shared repository simultaneously. Verify ONLY the deliverables of segment `' + seg.segmentId + '` and leave unrelated parallel files intact.']
				: []),
			'',
			'## Node Goal & Acceptance Criteria',
			(node.goal ?? '').trim(),
			'',
			(node.acceptance ?? '').trim(),
			'',
			'## Segment Incremental Reports',
			segReports || '(None)',
			'',
			'## Latest Worker Diff',
			rState.lastChanges?.combinedDiff ? `\`\`\`diff\n${rState.lastChanges.combinedDiff}\n\`\`\`` : '(Inspect workspace via read-only git/test commands if needed)',
			'',
			`Current Formal Failure Count on \`${node.id}\`: ${rState.formalFailureCount}/3.`,
			'',
			'## Required Action',
			`- **Approve Segment Node**: \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role manager --verdict pass\``,
			`- **Formal Reject** (triggers Amber/Red failure escalation): \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role manager --verdict reject --feedback "<root cause & required fix>"\``,
		].join('\n');

		void this.dispatchReviewerWithNudge(entry, node.id, 'manager_review', rState.managerAgentId, prompt, {
			model: seg.config.model,
			thinking: seg.config.thinking,
			cwdOverride: effectiveCwd,
		}, [
			`IMPORTANT: Your Manager secondary review turn for node \`${node.id}\` ended without executing \`aexus-ade engineering review\`.`,
			`Execute ONE of the following commands immediately via your Bash tool:`,
			`- Pass: \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role manager --verdict pass\``,
			`- Reject: \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role manager --verdict reject --feedback "<reason>"\``,
		].join('\n'));
	}

	private async wakeSegmentManagerForEscalation(
		entry: IManagedTreeEntry,
		node: IAdeEngineeringBlueprintNode,
		seg: IAdeEngineeringManagerSegment,
		lastEmployeeFeedback: string,
	): Promise<void> {
		const rState = entry.state.nodes[node.id];
		if (!rState?.managerAgentId) {
			return;
		}
		const effectiveCwd = entry.state.worktrees?.[seg.segmentId]?.worktreePath ?? entry.state.projectPath;
		const prompt = [
			`# Engineering 3x Internal Rejection Escalation — Node [${node.id}] ${node.title}`,
			`You are the **Manager (L2)** for segment \`${seg.segmentId}\` in Engineering tree \`${entry.governorSessionId}\`.`,
			`Task node \`${node.id}\` failed Employee single-node review **3 consecutive times**.`,
			'',
			'## Latest Employee Rejection Feedback',
			lastEmployeeFeedback || '(No feedback provided)',
			'',
			'## Node Goal & Acceptance Criteria',
			(node.goal ?? '').trim(),
			(node.acceptance ?? '').trim(),
			'',
			'## Required Action (Spec 3.3c)',
			'Inspect the workspace state globally, clear the internal retry state, and provide architectural guidance to grant the original Worker & Employee a **4th chance** (or issue a formal Manager rejection if unrecoverable):',
			`- **Grant 4th Chance with Guidance**: \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role manager --verdict guidance --feedback "<clear architectural guidance for 4th attempt>"\``,
			`- **Formal Manager Failure**: \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role manager --verdict reject --feedback "<reason>"\``,
		].join('\n');

		void this.dispatchReviewerWithNudge(entry, node.id, 'manager_escalation', rState.managerAgentId, prompt, {
			model: seg.config.model,
			thinking: seg.config.thinking,
			cwdOverride: effectiveCwd,
		}, [
			`IMPORTANT: Your Manager escalation turn for node \`${node.id}\` ended without executing \`aexus-ade engineering review\`.`,
			`Execute ONE of the following commands immediately via your Bash tool:`,
			`- Grant 4th chance: \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role manager --verdict guidance --feedback "<guidance>"\``,
			`- Formal reject: \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role manager --verdict reject --feedback "<reason>"\``,
		].join('\n'));
	}

	private async wakeSegmentManagerForMergeConflict(
		entry: IManagedTreeEntry,
		node: IAdeEngineeringBlueprintNode,
		worktreePath: string,
		conflict: { readonly conflictedFiles: readonly string[]; readonly summary: string },
	): Promise<void> {
		const seg = entry.blueprint.managers.find(m => m.nodeIds.includes(node.id));
		const rState = entry.state.nodes[node.id];
		if (!seg || !rState?.managerAgentId) {
			return;
		}
		const prompt = [
			`# Git Worktree Merge Conflict Before Node [${node.id}] ${node.title}`,
			`You are the **Manager (L2)** for join segment \`${seg.segmentId}\` in isolated worktree \`${worktreePath}\`.`,
			`Merging upstream parallel segment branches produced conflicts in: ${conflict.conflictedFiles.join(', ')}.`,
			'',
			'## Conflict Output',
			conflict.summary,
			'',
			'Resolve the merge conflicts cleanly in the worktree, commit the merge (`git add -A && git commit --no-edit`), and then resume the Worker via:',
			`\`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role manager --verdict guidance --feedback "Upstream branches merged cleanly; proceed with task implementation."\``,
		].join('\n');

		void this.dispatchSessionTurn(rState.managerAgentId, prompt, {
			model: seg.config.model,
			thinking: seg.config.thinking,
			pureWorker: false,
			cwdOverride: worktreePath,
			usageContext: { entry, role: 'manager', nodeId: node.id },
		}).catch(() => undefined);
	}

	private async wakeGovernorOnCircuitBreaker(
		entry: IManagedTreeEntry,
		node: IAdeEngineeringBlueprintNode,
		seg: IAdeEngineeringManagerSegment | undefined,
		finalManagerFeedback: string,
	): Promise<void> {
		const gov = this.projects.getAgent(entry.governorSessionId);
		if (!gov) {
			return;
		}
		const prompt = [
			`# CIRCUIT BREAKER ALERT (3rd Manager Formal Failure) — Node [${node.id}] ${node.title}`,
			`You are the **Governor (L1 · Engineering Tree Owner)** for Engineering tree \`${entry.governorSessionId}\`.`,
			`Segment \`${seg?.segmentId ?? 'unknown'}\` at node \`${node.id}\` ("${node.title}") has failed **3 formal Manager acceptance reviews** and has entered **RED Circuit-Broken** pause state.`,
			'',
			'## Final Manager Rejection Feedback',
			finalManagerFeedback || '(None)',
			'',
			'## Available Governor Actions',
			`1. Inspect full DAG status: \`aexus-ade engineering status --governor ${entry.governorSessionId} --json\``,
			`2. Read & revise the blueprint if task decomposition needs adjustment: \`aexus-ade engineering blueprint get --governor ${entry.governorSessionId}\` -> \`aexus-ade engineering blueprint apply --governor ${entry.governorSessionId} --file <path>\``,
			`3. **If human decision or intervention is required (Spec 2.2 & 3.4)**, post an escalation alert to ADE Inbox:`,
			`   \`aexus-ade inbox post --from ${entry.governorSessionId} --message "<concise situation report & decision needed from user>"\``,
			'*(Note: Per Engineering governance rules, Governor cannot call `engineering run` directly; User or Secretary will resume execution once ready.)*',
		].join('\n');

		void this.dispatchSessionTurn(gov.id, prompt, {
			thinking: 'high',
			pureWorker: false,
			usageContext: { entry, role: 'governor', nodeId: node.id },
		}).catch(() => undefined);
	}

	async submitReview(params: IAdeEngineeringReviewParams): Promise<IAdeEngineeringTreeSnapshot> {
		await this.readyPromise;
		const entry = this.trees.get(params.governorSessionId);
		if (!entry) {
			throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", params.governorSessionId));
		}
		const node = entry.blueprint.nodes.find(n => n.id === params.nodeId);
		if (!node || node.type !== 'task') {
			throw new Error(localize('adeEngineeringTaskNodeNotFound', "Task node '{0}' not found in blueprint.", params.nodeId));
		}
		const seg = entry.blueprint.managers.find(m => m.nodeIds.includes(node.id));
		const isSegmentTail = Boolean(seg && seg.nodeIds[seg.nodeIds.length - 1] === node.id);
		const prev = entry.state.nodes[node.id] ?? {
			nodeId: node.id,
			phase: 'idle',
			completed: false,
			employeeRejectCount: 0,
			formalFailureCount: 0,
			segmentId: seg?.segmentId,
		};
		if (prev.completed) {
			return this.buildSnapshot(entry);
		}
		if (params.role === 'employee') {
			if (params.verdict !== 'pass' && params.verdict !== 'reject') {
				throw new AdeBlueprintValidationError(localize('adeInvalidEmpVerdict', "Employee review verdict must be 'pass' or 'reject'."));
			}
			if (prev.phase !== 'employee_review') {
				return this.buildSnapshot(entry);
			}
		} else if (params.role === 'manager') {
			if (prev.phase !== 'manager_review' && prev.phase !== 'manager_escalation') {
				return this.buildSnapshot(entry);
			}
		}

		if (params.role === 'employee') {
			if (params.verdict === 'pass') {
				const reportText = params.report?.trim() || localize('adeDefaultNodeReport', "Completed task '{0}'.", node.title);
				const nextReports: Record<string, IAdeIncrementalReportEntry> = {
					...entry.state.reports,
					[node.id]: {
						nodeId: node.id,
						nodeTitle: node.title,
						summary: reportText,
						updatedAt: Date.now(),
					},
				};

				// Spec 3.3(b): Tail node of Manager segment OR Critical node -> wake Manager for secondary review!
				if (isSegmentTail || node.critical) {
					entry.state = {
						...entry.state,
						reports: nextReports,
						nodes: {
							...entry.state.nodes,
							[node.id]: {
								...prev,
								phase: 'manager_review',
								employeeRejectCount: 0,
								lastEmployeeFeedback: undefined,
							},
						},
					};
					this.appendEvent(entry, 'info', 'employee.pass_to_manager', {
						nodeId: node.id,
						segmentId: seg?.segmentId,
						detail: reportText,
					});
					await this.persistEntry(entry);
					if (seg) {
						await this.wakeSegmentManagerForSecondaryReview(entry, node, seg);
					}
					return this.buildSnapshot(entry);
				}

				// Spec 3.3(a): Non-tail & non-critical -> directly mark completed (green) and advance downstream!
				entry.state = {
					...entry.state,
					reports: nextReports,
					nodes: {
						...entry.state.nodes,
						[node.id]: {
							...prev,
							phase: 'completed',
							completed: true,
							completedAt: Date.now(),
							employeeRejectCount: 0,
							fourthChanceGranted: false,
							lastEmployeeFeedback: undefined,
						},
					},
				};
				this.appendEvent(entry, 'info', 'node.completed', { nodeId: node.id, detail: reportText });
				await this.persistEntry(entry);
				if (entry.state.runStatus === 'running') {
					await this.scheduleReadyNodes(entry);
				}
				return this.buildSnapshot(entry);
			}

			// Employee verdict === 'reject' (Spec 3.3 Branch 2: Internal rework, NOT a formal failure!)
			const feedback = params.feedback?.trim() || 'Please verify all acceptance criteria and fix remaining issues.';

			// If this was already the 4th chance granted by Manager, route directly to Manager to render formal judgment
			if (prev.fourthChanceGranted && seg) {
				entry.state = {
					...entry.state,
					nodes: {
						...entry.state.nodes,
						[node.id]: {
							...prev,
							phase: 'manager_review',
							lastEmployeeFeedback: feedback,
						},
					},
				};
				this.appendEvent(entry, 'warn', 'employee.fourth_chance_rejected', { nodeId: node.id, detail: feedback });
				await this.persistEntry(entry);
				await this.wakeSegmentManagerForSecondaryReview(entry, node, seg);
				return this.buildSnapshot(entry);
			}

			const nextRejectCount = prev.employeeRejectCount + 1;
			// Spec 3.3(c): 3 consecutive Employee rejections -> escalate to Segment Manager!
			if (nextRejectCount >= 3 && seg) {
				entry.state = {
					...entry.state,
					nodes: {
						...entry.state.nodes,
						[node.id]: {
							...prev,
							phase: 'manager_escalation',
							employeeRejectCount: nextRejectCount,
							lastEmployeeFeedback: feedback,
						},
					},
				};
				this.appendEvent(entry, 'warn', 'employee.escalated_to_manager', {
					nodeId: node.id,
					segmentId: seg.segmentId,
					detail: `3 consecutive internal rejections; waking Manager`,
				});
				await this.persistEntry(entry);
				await this.wakeSegmentManagerForEscalation(entry, node, seg, feedback);
				return this.buildSnapshot(entry);
			}

			// Reuse same original Worker session for internal iteration 1 or 2!
			entry.state = {
				...entry.state,
				nodes: {
					...entry.state.nodes,
					[node.id]: {
						...prev,
						employeeRejectCount: nextRejectCount,
						lastEmployeeFeedback: feedback,
					},
				},
			};
			this.appendEvent(entry, 'info', 'employee.internal_rework', {
				nodeId: node.id,
				detail: `Internal rework ${nextRejectCount}/3: ${feedback}`,
			});
			await this.persistEntry(entry);
			if (entry.state.runStatus === 'running') {
				void this.activateTaskNodeWorker(entry, node, { source: 'employee', feedback });
			}
			return this.buildSnapshot(entry);
		}

		// Role === 'manager' (Spec 3.3c & 3.4)
		if (params.verdict === 'guidance') {
			const guidance = params.feedback?.trim() || 'Follow segment acceptance criteria carefully.';
			const wasEscalationFromEmployee = prev.employeeRejectCount >= 3;
			entry.state = {
				...entry.state,
				nodes: {
					...entry.state.nodes,
					[node.id]: {
						...prev,
						employeeRejectCount: 0,
						fourthChanceGranted: wasEscalationFromEmployee ? true : prev.fourthChanceGranted,
						lastManagerFeedback: guidance,
					},
				},
			};
			this.appendEvent(entry, 'info', 'manager.fourth_chance_granted', {
				nodeId: node.id,
				segmentId: seg?.segmentId,
				detail: guidance,
			});
			await this.persistEntry(entry);
			if (entry.state.runStatus === 'running') {
				void this.activateTaskNodeWorker(entry, node, { source: 'manager', feedback: guidance });
			}
			return this.buildSnapshot(entry);
		}

		if (params.verdict === 'pass') {
			const nextReports = { ...entry.state.reports };
			if (params.report?.trim()) {
				nextReports[node.id] = {
					nodeId: node.id,
					nodeTitle: node.title,
					summary: params.report.trim(),
					updatedAt: Date.now(),
				};
			}
			if (entry.blueprint.metadata.workspaceIsolation === 'worktree' && seg && isSegmentTail) {
				const wtPath = entry.state.worktrees?.[seg.segmentId]?.worktreePath;
				if (wtPath) {
					await this.backend.commitSegmentWorktree(wtPath, `feat(ade): complete segment ${seg.segmentId}`).catch(() => undefined);
				}
			}
			entry.state = {
				...entry.state,
				reports: nextReports,
				nodes: {
					...entry.state.nodes,
					[node.id]: {
						...prev,
						phase: 'completed',
						completed: true,
						completedAt: Date.now(),
						employeeRejectCount: 0,
						fourthChanceGranted: false,
						lastManagerFeedback: undefined,
					},
				},
			};
			this.appendEvent(entry, 'info', 'manager.approved', {
				nodeId: node.id,
				segmentId: seg?.segmentId,
				detail: node.title,
			});
			await this.persistEntry(entry);
			if (entry.state.runStatus === 'running') {
				await this.scheduleReadyNodes(entry);
			}
			return this.buildSnapshot(entry);
		}

		// Manager verdict === 'reject' -> ONLY Official Formal Failure Trigger (Spec 3.4)!
		const mgrFeedback = params.feedback?.trim() || 'Segment quality check failed; rework required.';
		const nextFailureCount = prev.formalFailureCount + 1;

		if (nextFailureCount >= 3) {
			// Spec 3.4: 3rd Manager Formal Failure -> RED Circuit Breaker + Wake Governor!
			entry.state = {
				...entry.state,
				runStatus: 'circuit_broken',
				nodes: {
					...entry.state.nodes,
					[node.id]: {
						...prev,
						phase: 'circuit_broken',
						completed: false,
						employeeRejectCount: 0,
						formalFailureCount: nextFailureCount,
						fourthChanceGranted: false,
						lastManagerFeedback: mgrFeedback,
					},
				},
			};
			this.appendEvent(entry, 'error', 'manager.circuit_breaker_tripped', {
				nodeId: node.id,
				segmentId: seg?.segmentId,
				detail: `3rd formal failure (RED): ${mgrFeedback}`,
			});
			await this.persistEntry(entry);
			this.inbox.noteCircuitBreakerTrip?.(entry.governorSessionId, node.id);
			await this.wakeGovernorOnCircuitBreaker(entry, node, seg, mgrFeedback);
			return this.buildSnapshot(entry);
		}

		// Formal Failure 1 (Light Amber) or 2 (Deep Amber) -> rework on original Worker!
		entry.state = {
			...entry.state,
			nodes: {
				...entry.state.nodes,
				[node.id]: {
					...prev,
					employeeRejectCount: 0,
					formalFailureCount: nextFailureCount,
					fourthChanceGranted: false,
					lastManagerFeedback: mgrFeedback,
				},
			},
		};
		this.appendEvent(entry, 'warn', `manager.formal_failure_${nextFailureCount}`, {
			nodeId: node.id,
			segmentId: seg?.segmentId,
			detail: mgrFeedback,
		});
		await this.persistEntry(entry);
		if (entry.state.runStatus === 'running') {
			void this.activateTaskNodeWorker(entry, node, { source: 'manager', feedback: mgrFeedback });
		}
		return this.buildSnapshot(entry);
	}

	async submitGateVerdict(params: IAdeEngineeringGateParams): Promise<IAdeEngineeringTreeSnapshot> {
		await this.readyPromise;
		const entry = this.trees.get(params.governorSessionId);
		if (!entry) {
			throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", params.governorSessionId));
		}
		const gateNode = entry.blueprint.nodes.find(n => n.id === params.nodeId && n.type === 'user_gate');
		if (!gateNode) {
			throw new Error(localize('adeEngineeringGateNodeNotFound', "User Acceptance Gate '{0}' not found.", params.nodeId));
		}

		const gatePrev = entry.state.nodes[gateNode.id];
		if (gatePrev?.completed || gatePrev?.phase !== 'waiting_user_gate') {
			return this.buildSnapshot(entry);
		}

		// Resolve matching Inbox todo card
		const matchingInbox = this.inbox.list({ governorSessionId: entry.governorSessionId, includeResolved: false })
			.find(item => item.kind === 'user_gate' && item.nodeId === gateNode.id);

		if (params.verdict === 'pass') {
			if (matchingInbox) {
				await this.inbox.resolveItem(matchingInbox.id, 'Approved');
			}
			const nextRunStatus: AdeEngineeringRunStatus = entry.state.runStatus === 'paused' ? 'paused' : 'running';
			const prev = entry.state.nodes[gateNode.id];
			entry.state = {
				...entry.state,
				runStatus: nextRunStatus,
				nodes: {
					...entry.state.nodes,
					[gateNode.id]: {
						...(prev ?? { nodeId: gateNode.id, employeeRejectCount: 0, formalFailureCount: 0 }),
						phase: 'completed',
						completed: true,
						completedAt: Date.now(),
					},
				},
			};
			this.appendEvent(entry, 'info', 'gate.approved', { nodeId: gateNode.id, detail: gateNode.title });
			await this.persistEntry(entry);
			await this.scheduleReadyNodes(entry);
			return this.buildSnapshot(entry);
		}

		// Gate verdict === 'rollback' (Spec 3.5: Surgical partial rollback ONLY along targetNode -> ... -> gateNode!)
		const upstreamTasks = listUpstreamTaskAncestors(gateNode.id, entry.blueprint);
		const targetNodeId = params.targetNodeId?.trim() || upstreamTasks[upstreamTasks.length - 1]?.id;
		if (!targetNodeId) {
			throw new AdeBlueprintValidationError(localize('adeGateNoRollbackTarget', "Specify an upstream task node (--target-node) to roll back to."));
		}

		const rollbackIds = computeGateRollbackNodes(gateNode.id, targetNodeId, entry.blueprint);
		const feedback = params.feedback?.trim() || 'User rejected at acceptance gate; revise implementation accordingly.';
		if (matchingInbox) {
			await this.inbox.resolveItem(matchingInbox.id, `Rolled back to ${targetNodeId}: ${feedback}`);
		}

		const nextNodes = { ...entry.state.nodes };
		const nextReports = { ...entry.state.reports };
			for (const rid of rollbackIds) {
				const prev = nextNodes[rid];
				nextNodes[rid] = {
					...(prev ?? { nodeId: rid }),
					phase: 'idle',
					completed: false,
					completedAt: undefined,
					employeeRejectCount: 0,
					formalFailureCount: 0,
					fourthChanceGranted: false,
					lastEmployeeFeedback: undefined,
					lastManagerFeedback: undefined,
					lastGateFeedback: feedback,
				};
				if (nextReports[rid]) {
					nextReports[rid] = { ...nextReports[rid], stale: true };
				}
			}

		entry.state = {
			...entry.state,
			runStatus: 'running',
			nodes: nextNodes,
			reports: nextReports,
		};
		this.appendEvent(entry, 'warn', 'gate.rollback', {
			nodeId: gateNode.id,
			detail: `Rolled back [${rollbackIds.join(' -> ')}]: ${feedback}`,
		});
		await this.persistEntry(entry);

		const targetNode = entry.blueprint.nodes.find(n => n.id === targetNodeId);
		if (targetNode && targetNode.type === 'task') {
			void this.activateTaskNodeWorker(entry, targetNode, { source: 'user_gate', feedback });
		}
		return this.buildSnapshot(entry);
	}

	recordWorkerStreamHeartbeat(sessionResource: string, timestamp = Date.now()): void {
		if (!sessionResource) {
			return;
		}
		for (const entry of this.trees.values()) {
			for (const [nid, rState] of Object.entries(entry.state.nodes)) {
				if (rState.phase !== 'worker_running' || !rState.workerAgentId) {
					continue;
				}
				const worker = this.projects.getAgent(rState.workerAgentId);
				if (worker?.session?.resource.toString() === sessionResource) {
					entry.state = {
						...entry.state,
						nodes: {
							...entry.state.nodes,
							[nid]: {
								...rState,
								lastStreamActivityAt: timestamp,
							},
						},
					};
					return;
				}
			}
		}
	}

	async runWatchdogSweep(now = Date.now()): Promise<void> {
		const configuredMinutes = this.configurationService.getValue<number>(ADE_WATCHDOG_TIMEOUT_CONFIG_KEY);
		const alertPromises: Promise<unknown>[] = [];
		for (const entry of this.trees.values()) {
			if (entry.state.runStatus !== 'running') {
				continue;
			}
			const timeoutMinutes = (typeof configuredMinutes === 'number' && configuredMinutes > 0)
				? configuredMinutes
				: (entry.blueprint.metadata.watchdogTimeoutMinutes || DEFAULT_WATCHDOG_TIMEOUT_MINUTES);
			const thresholdMs = timeoutMinutes * 60_000;

			for (const node of entry.blueprint.nodes) {
				const rState = entry.state.nodes[node.id];
				if (!rState || rState.phase !== 'worker_running') {
					continue;
				}
				const lastActive = rState.lastStreamActivityAt ?? rState.startedAt ?? now;
				if (now - lastActive < thresholdMs) {
					continue;
				}
				if (rState.lastWatchdogAlertAt && now - rState.lastWatchdogAlertAt < thresholdMs) {
					continue;
				}

				entry.state = {
					...entry.state,
					nodes: {
						...entry.state.nodes,
						[node.id]: {
							...rState,
							lastWatchdogAlertAt: now,
						},
					},
				};
				const seg = entry.blueprint.managers.find(m => m.nodeIds.includes(node.id));
				this.appendEvent(entry, 'warn', 'watchdog.timeout_alert', {
					nodeId: node.id,
					segmentId: seg?.segmentId,
					detail: `No stream output for ${timeoutMinutes} min`,
				});
				await this.persistEntry(entry);

				if (seg && rState.managerAgentId) {
					const alertPrompt = [
						`# Watchdog Timeout Alert — Worker Unresponsive on Node [${node.id}] ${node.title}`,
						`Active Worker (\`${rState.workerAgentId}\`) on segment \`${seg.segmentId}\` has produced **zero streaming output for ${timeoutMinutes} minutes**.`,
						'',
						'## Recommended Manager Action (Spec 3.7)',
						'Prefer sending a reminder nudge first; only kill-restart if the Worker remains completely deadlocked:',
						`- **Remind Worker (Default)**: \`aexus-ade engineering watchdog-action --governor ${entry.governorSessionId} --node ${node.id} --action remind --message "Please report progress or complete the current step."\``,
						`- **Force Kill & Restart Worker**: \`aexus-ade engineering watchdog-action --governor ${entry.governorSessionId} --node ${node.id} --action kill-restart --message "Continue task from current workspace state."\``,
					].join('\n');
					alertPromises.push(this.dispatchSessionTurn(rState.managerAgentId, alertPrompt, {
						model: seg.config.model,
						thinking: seg.config.thinking,
						pureWorker: false,
						usageContext: { entry, role: 'manager', nodeId: node.id },
					}).catch(() => undefined));
				}
			}
		}
		if (alertPromises.length > 0) {
			await Promise.allSettled(alertPromises);
		}
	}

	async executeWatchdogAction(params: IAdeEngineeringWatchdogActionParams): Promise<IAdeEngineeringTreeSnapshot> {
		await this.readyPromise;
		const entry = this.trees.get(params.governorSessionId);
		if (!entry) {
			throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", params.governorSessionId));
		}
		const node = entry.blueprint.nodes.find(n => n.id === params.nodeId && n.type === 'task');
		const rState = node ? entry.state.nodes[node.id] : undefined;
		if (!node || !rState?.workerAgentId) {
			throw new Error(localize('adeEngineeringTaskNodeNotFound', "Task node '{0}' not found in blueprint.", params.nodeId));
		}
		if (rState.completed || rState.phase !== 'worker_running') {
			return this.buildSnapshot(entry);
		}

		const worker = await this.ensureAgentMaterialized(rState.workerAgentId);
		const nudgeText = params.message?.trim() || 'Continue executing the task and complete all acceptance requirements.';

		if (params.action === 'kill-restart') {
			entry.activeWorkerRunTokens.delete(node.id);
			if (worker.session) {
				await this.commandService.executeCommand('aexus.agentEngines.killSession', worker.session.resource).catch(() => undefined);
			}
			this.appendEvent(entry, 'warn', 'watchdog.kill_restart', { nodeId: node.id, detail: nudgeText });
			entry.state = {
				...entry.state,
				nodes: {
					...entry.state.nodes,
					[node.id]: {
						...rState,
						lastStreamActivityAt: Date.now(),
						lastWatchdogAlertAt: undefined,
					},
				},
			};
			await this.persistEntry(entry);
			void this.activateTaskNodeWorker(entry, node, { source: 'watchdog', feedback: nudgeText });
			return this.buildSnapshot(entry);
		}

		// Default: 'remind'
		entry.state = {
			...entry.state,
			nodes: {
				...entry.state.nodes,
				[node.id]: {
					...rState,
					lastStreamActivityAt: Date.now(),
					lastWatchdogAlertAt: undefined,
				},
			},
		};
		this.appendEvent(entry, 'info', 'watchdog.remind', { nodeId: node.id, detail: nudgeText });
		await this.persistEntry(entry);

		// If no turn is currently active in-flight, dispatch reminder turn on the same Worker
		if (!entry.activeWorkerRunTokens.has(node.id)) {
			void this.activateTaskNodeWorker(entry, node, { source: 'watchdog', feedback: nudgeText });
		} else if (worker.session) {
			await this.commandService.executeCommand('aexus.agentEngines.nudgeSession', worker.session.resource, nudgeText).catch(() => undefined);
		}
		return this.buildSnapshot(entry);
	}

	recordSessionTurnUsage(params: {
		readonly sessionResource?: string;
		readonly agentId?: string;
		readonly usage: Partial<IAdeTokenUsage>;
	}): void {
		const resStr = params.sessionResource?.trim();
		const targetAgent = params.agentId
			? this.projects.getAgent(params.agentId)
			: (resStr ? this.projects.agents.find(a => a.session?.resource.toString() === resStr) : undefined);
		if (!targetAgent) {
			return;
		}
		const govId = this.getOwningGovernorId(targetAgent.id);
		const entry = govId ? this.trees.get(govId) : undefined;
		if (!entry) {
			return;
		}
		let role: 'worker' | 'employee' | 'manager' | 'governor' = 'worker';
		let nodeId: string | undefined;
		if (targetAgent.id === entry.governorSessionId) {
			role = 'governor';
		} else {
			for (const [nid, rState] of Object.entries(entry.state.nodes)) {
				if (rState.workerAgentId === targetAgent.id) {
					role = 'worker';
					nodeId = nid;
					break;
				}
				if (rState.employeeAgentId === targetAgent.id) {
					role = 'employee';
					nodeId = nid;
					break;
				}
				if (rState.managerAgentId === targetAgent.id) {
					role = 'manager';
					if (rState.phase === 'manager_review' || rState.phase === 'manager_escalation') {
						nodeId = nid;
						break;
					}
					nodeId ??= targetAgent.treeNodeId ?? nid;
				}
			}
			if (!nodeId && targetAgent.role === 'manager') {
				role = 'manager';
			} else if (!nodeId && targetAgent.role === 'employee') {
				role = 'employee';
			}
		}
		if (this.applyTurnTokenUsage(entry, role, params.usage, nodeId)) {
			void this.persistEntry(entry).catch(() => undefined);
		}
	}

	async openEngineeringEditor(governorSessionId: string, options?: { side?: boolean }): Promise<void> {
		await this.readyPromise;
		this.modeService.setMode('ade');
		await this.editors.openEngineering?.(governorSessionId, options);
	}

	async ensureNodeAgentSessionOpen(
		governorSessionId: string,
		nodeId: string,
		role: 'worker' | 'employee' | 'manager' = 'worker',
		options?: { side?: boolean },
	): Promise<string | undefined> {
		await this.readyPromise;
		const entry = this.trees.get(governorSessionId);
		const rState = entry?.state.nodes[nodeId];
		if (!entry || !rState) {
			return undefined;
		}
		const targetAgentId = role === 'manager'
			? rState.managerAgentId
			: role === 'employee'
				? rState.employeeAgentId
				: rState.workerAgentId;
		if (!targetAgentId) {
			return undefined;
		}
		await this.ensureAgentMaterialized(targetAgentId);
		this.modeService.setMode('ade');
		await this.editors.openAgent(targetAgentId, options);
		return targetAgentId;
	}
}

CommandsRegistry.registerCommand(ADE_WORKER_HEARTBEAT_COMMAND_ID, (accessor: ServicesAccessor, rawResource: unknown, rawTimestamp?: unknown) => {
	try {
		const eng = accessor.get(IAdeEngineeringService);
		const resStr = typeof rawResource === 'string'
			? rawResource
			: (URI.isUri(rawResource) ? rawResource.toString() : undefined);
		if (resStr) {
			eng.recordWorkerStreamHeartbeat(resStr, typeof rawTimestamp === 'number' ? rawTimestamp : Date.now());
		}
	} catch {
		// Ignore when engineering service is not yet instantiated
	}
});

CommandsRegistry.registerCommand(ADE_RECORD_TURN_USAGE_COMMAND_ID, (accessor: ServicesAccessor, rawPayload: unknown) => {
	try {
		if (!rawPayload || typeof rawPayload !== 'object') {
			return;
		}
		const p = rawPayload as { sessionResource?: unknown; agentId?: unknown; usage?: Partial<IAdeTokenUsage> };
		if (!p.usage || typeof p.usage !== 'object') {
			return;
		}
		const eng = accessor.get(IAdeEngineeringService);
		eng.recordSessionTurnUsage({
			sessionResource: typeof p.sessionResource === 'string'
				? p.sessionResource
				: (URI.isUri(p.sessionResource) ? p.sessionResource.toString() : undefined),
			agentId: typeof p.agentId === 'string' ? p.agentId : undefined,
			usage: p.usage,
		});
	} catch {
		// Ignore when engineering service is not yet instantiated
	}
});
