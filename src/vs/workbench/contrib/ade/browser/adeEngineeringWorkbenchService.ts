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
	estimateTextTokens,
	resolveAdeInboxSeverity,
} from '../../../../platform/ade/common/adeEngineering.js';
import {
	AdeBlueprintValidationError,
	buildLayeredUpstreamReports,
	buildUpstreamReportChain,
	computeAutoLayoutPositions,
	computeCriticalPathPriorities,
	computeEdgeVisualStatus,
	computeGateRollbackNodes,
	computeNodeVisualStatus,
	createStarterBlueprint,
	detectSharedWorkspaceScopeConflicts,
	doFileScopesOverlap,
	listUpstreamTaskAncestors,
	normalizeBlueprintEngine,
	parseEngineeringBlueprint,
	serializeEngineeringBlueprint,
	toAdeEngineId,
} from '../../../../platform/ade/common/adeEngineeringBlueprint.js';
import {
	ADE_PRICING_CONFIG_KEY,
	ADE_PRICING_SUBSCRIPTION_MODE_CONFIG_KEY,
	AdeCustomPricingMap,
	IAdePricingOptions,
	computeTreeFinancialSummary,
	estimateTokenUsageCostUsd,
	formatUsdCost,
} from '../../../../platform/ade/common/adePricing.js';
import {
	ADE_ORGANIZATION_CONFIG_KEY,
	IAdeOrganizationConfig,
	normalizeAdeOrganizationConfig,
	resolveRankWorkTreeSlots,
	resolveWorkTreeSlotRank,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { buildBlueprintFromTemplate } from '../../../../platform/ade/common/adeBlueprintTemplates.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
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
import { IAdeRoleSchemaService, readTrustedApplicationConfigValue } from '../common/adeRoleSchemaService.js';
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

function resolveOptionalService<T>(instantiationService: IInstantiationService, id: { (...args: unknown[]): unknown; toString(): string }): T | undefined {
	return instantiationService.invokeFunction(accessor => {
		try {
			return accessor.get(id as never) as T;
		} catch {
			return undefined;
		}
	});
}

const ADE_TRUSTED_VERIFY_HASHES_STORAGE_KEY = 'aexus.ade.engineering.trustedVerifyHashes';
const PERSIST_ERROR_INBOX_THROTTLE_MS = 30_000;

const SHA256_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256HexFallback(bytes: Uint8Array): string {
	let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
	let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
	const bitLen = bytes.length * 8;
	const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLen);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
	view.setUint32(paddedLen - 4, bitLen >>> 0, false);
	const w = new Uint32Array(64);
	for (let offset = 0; offset < paddedLen; offset += 64) {
		for (let i = 0; i < 16; i++) {
			w[i] = view.getUint32(offset + i * 4, false);
		}
		for (let i = 16; i < 64; i++) {
			const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
			const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}
		let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
		for (let i = 0; i < 64; i++) {
			const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			const ch = (e & f) ^ ((~e) & g);
			const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
			const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) >>> 0;
			h = g; g = f; f = e; e = (d + t1) >>> 0;
			d = c; c = b; b = a; a = (t1 + t2) >>> 0;
		}
		h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
	}
	return [h0, h1, h2, h3, h4, h5, h6, h7].map(n => n.toString(16).padStart(8, '0')).join('');
}

async function computeVerifyCommandSha256(command: string): Promise<string> {
	const bytes = new TextEncoder().encode(command.trim());
	if (typeof globalThis.crypto?.subtle?.digest === 'function') {
		try {
			const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
			return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
		} catch {
			// Fall back to deterministic pure-JS SHA-256
		}
	}
	return sha256HexFallback(bytes);
}

function collectBlueprintVerifyCommands(blueprint: IAdeEngineeringBlueprint): string[] {
	const seen = new Set<string>();
	const cmds: string[] = [];
	const push = (raw: string | undefined) => {
		const trimmed = raw?.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			cmds.push(trimmed);
		}
	};
	push(blueprint.metadata.verify);
	for (const node of blueprint.nodes) {
		if (node.type === 'task') {
			push(node.verify);
		}
	}
	return cmds;
}

function isInteractiveHumanCaller(caller: string | undefined): boolean {
	if (caller === undefined) {
		return true;
	}
	const norm = caller.trim().toLowerCase();
	return !norm || norm === 'user' || norm === 'human';
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
		readonly senderRank?: string;
		readonly senderAgentId?: string;
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
			senderRank: params.senderRank ?? gov?.role ?? 'governor',
			...(params.senderAgentId ? { senderAgentId: params.senderAgentId } : {}),
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
	/** Per-node initial workspace snapshot taken before Turn 1 so rework re-reviews see cumulative node diffs. */
	nodeInitialSnapshots: Map<string, IAdeWorkspaceSnapshot>;
	/** Per-segment initial workspace snapshot taken before the segment head's Turn 1 so Manager sees cumulative segment diffs. */
	segmentInitialSnapshots: Map<string, IAdeWorkspaceSnapshot>;
	/** SHA-256 hashes of verify commands explicitly declined by the user during this session. */
	declinedVerifyHashes: Set<string>;
	/** Timestamp of last persist-failure Inbox notification (rate-limited). */
	lastPersistErrorAlertAt?: number;
	persistChain: Promise<void>;
	removed?: boolean;
}

export class AdeEngineeringWorkbenchService extends Disposable implements IAdeEngineeringService {
	declare readonly _serviceBrand: undefined;

	private readonly backend: IAdeEngineeringBackendService;
	private readonly chatService: IChatService | undefined;
	private readonly scmService: ISCMService | undefined;
	private readonly roleSchemaService: IAdeRoleSchemaService | undefined;
	private readonly storageService: IStorageService | undefined;
	private readonly dialogService: IDialogService | undefined;
	private readonly notificationService: INotificationService | undefined;
	private readonly trustedVerifyHashesByProject = new Map<string, Set<string>>();
	private readonly trees = new Map<string, IManagedTreeEntry>();
	private readonly demoTimers = new Map<string, number[]>();
	private readonly demoActive = new Set<string>();
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
		this.roleSchemaService = resolveOptionalService<IAdeRoleSchemaService>(instantiationService, IAdeRoleSchemaService);
		this.storageService = resolveOptionalService<IStorageService>(instantiationService, IStorageService);
		this.dialogService = resolveOptionalService<IDialogService>(instantiationService, IDialogService);
		this.notificationService = resolveOptionalService<INotificationService>(instantiationService, INotificationService);
		this.loadTrustedVerifyHashesFromStorage();
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
		for (const govId of [...this.demoTimers.keys()]) {
			this.clearDemoSimulation(govId);
		}
		if (this.watchdogTimer !== undefined) {
			mainWindow.clearInterval(this.watchdogTimer);
			this.watchdogTimer = undefined;
		}
		super.dispose();
	}

	private clearDemoSimulation(governorSessionId: string): void {
		const handles = this.demoTimers.get(governorSessionId);
		if (handles) {
			for (const h of handles) {
				mainWindow.clearTimeout(h);
			}
			this.demoTimers.delete(governorSessionId);
		}
		this.demoActive.delete(governorSessionId);
	}

	private scheduleDemoStep(governorSessionId: string, delayMs: number, fn: () => void): void {
		const handle = mainWindow.setTimeout(() => {
			if (!this.demoActive.has(governorSessionId)) {
				return;
			}
			fn();
		}, delayMs);
		const arr = this.demoTimers.get(governorSessionId) ?? [];
		arr.push(handle);
		this.demoTimers.set(governorSessionId, arr);
	}

	isDemoSimulation(governorSessionId: string): boolean {
		return this.demoActive.has(governorSessionId);
	}

	async startDemoSimulation(governorSessionId: string): Promise<IAdeEngineeringTreeSnapshot> {
		await this.readyPromise;
		const existing = this.trees.get(governorSessionId);
		if (!existing) {
			throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", governorSessionId));
		}

		// Apply the canonical Full-Stack Feature Ship recipe cleanly first (resets old demo timers too).
		const builtBlueprint = buildBlueprintFromTemplate('feature-ship', {
			governorSessionId,
			preset: 'balanced',
			defaultEngine: 'claude-code',
			secondaryEngine: 'codex',
			workspaceIsolation: 'worktree',
			maxBudgetUsd: 5,
		});
		await this.applyBlueprint({
			governorSessionId,
			blueprintText: serializeEngineeringBlueprint(builtBlueprint),
			forceStopRunning: true,
			trustedVerifyCommands: true,
		});

		const entry = this.trees.get(governorSessionId)!;
		this.demoActive.add(governorSessionId);
		const t0 = Date.now();
		const mkTok = (inp: number, out: number, cr: number, cw: number, turns: number, costUsd: number): IAdeTokenUsage => ({
			inputTokens: inp,
			outputTokens: out,
			cacheReadTokens: cr,
			cacheWriteTokens: cw,
			totalTokens: inp + out + cr + cw,
			turns,
			durationMs: turns * 14_000,
			costUsd,
		});

		const demoDiffN1 = [
			'diff --git a/src/engine/contracts.ts b/src/engine/contracts.ts',
			'--- a/src/engine/contracts.ts',
			'+++ b/src/engine/contracts.ts',
			'@@ -1,4 +1,11 @@',
			'+export interface IBudgetGuardrail {',
			'+  readonly maxBudgetUsd: number;',
			'+  readonly onExceeded: "pause_and_alert";',
			'+}',
			'+',
			' export interface ISchedulerTask {',
			'   readonly id: string;',
			'+  readonly laneBranch?: string;',
			' }',
		].join('\n');

		const demoDiffN2 = [
			'diff --git a/src/engine/finops.ts b/src/engine/finops.ts',
			'--- /dev/null',
			'+++ b/src/engine/finops.ts',
			'@@ -0,0 +1,9 @@',
			'+export function checkBudgetCeiling(spendUsd: number, capUsd?: number): boolean {',
			'+  if (!capUsd || capUsd <= 0) {',
			'+    return false;',
			'+  }',
			'+  return spendUsd >= capUsd;',
			'+}',
		].join('\n');

		// Initial running state — zero real CLI spawns, zero real git commands!
		entry.state = {
			...entry.state,
			runStatus: 'running',
			updatedAt: t0,
			worktrees: {
				N2: { segmentId: 'N2', branchName: 'ade/demo-N2-backend', worktreePath: `${entry.state.projectPath}/.worktrees/demo-N2`, headCommit: 'a4f82e19' },
				N3: { segmentId: 'N3', branchName: 'ade/demo-N3-ui', worktreePath: `${entry.state.projectPath}/.worktrees/demo-N3`, headCommit: '9c1d4b72' },
				N4: { segmentId: 'N4', branchName: 'ade/demo-N4-tests', worktreePath: `${entry.state.projectPath}/.worktrees/demo-N4`, headCommit: '7e23fa10' },
			},
			tokenUsage: {
				governor: mkTok(8_000, 1_800, 28_000, 2_000, 1, 0.06),
				manager: createEmptyTreeTokenUsageSummary().manager,
				employee: createEmptyTreeTokenUsageSummary().employee,
				worker: createEmptyTreeTokenUsageSummary().worker,
				total: mkTok(8_000, 1_800, 28_000, 2_000, 1, 0.06),
			},
			nodes: {
				...entry.state.nodes,
				N1: { ...entry.state.nodes.N1, phase: 'worker_running', completed: false, startedAt: t0 },
			},
			events: [],
		};
		this.appendEvent(entry, 'info', 'demo.started', { nodeId: 'N1', detail: 'Interactive Demo (0 API tokens spent) — N1 Worker L4 coding contracts' });
		this._onDidChangeTree.fire(governorSessionId);

		// Beat 1 (1.1s): N1 enters Employee L3 adversarial audit
		this.scheduleDemoStep(governorSessionId, 1100, () => {
			const now = Date.now();
			entry.state = {
				...entry.state,
				updatedAt: now,
				tokenUsage: {
					governor: mkTok(10_000, 2_400, 36_000, 3_000, 2, 0.09),
					manager: mkTok(6_000, 1_500, 22_000, 1_500, 1, 0.05),
					employee: mkTok(12_000, 3_100, 52_000, 2_500, 2, 0.11),
					worker: mkTok(32_000, 9_800, 140_000, 6_000, 5, 0.34),
					total: mkTok(60_000, 16_800, 250_000, 13_000, 10, 0.59),
				},
				nodes: {
					...entry.state.nodes,
					N1: {
						...entry.state.nodes.N1,
						phase: 'employee_review',
						tokenUsage: {
							worker: mkTok(32_000, 9_800, 140_000, 6_000, 5, 0.34),
							employee: mkTok(12_000, 3_100, 52_000, 2_500, 2, 0.11),
							manager: mkTok(6_000, 1_500, 22_000, 1_500, 1, 0.05),
							total: mkTok(50_000, 14_400, 214_000, 10_000, 8, 0.50),
						},
						lastChanges: {
							capturedAt: now,
							touchedFiles: [
								{ relativePath: 'src/engine/contracts.ts', kind: 'added' },
								{ relativePath: 'src/engine/scheduler.ts', kind: 'modified' },
							],
							combinedDiff: demoDiffN1,
						},
					},
				},
			};
			this.appendEvent(entry, 'info', 'employee.review_started', { nodeId: 'N1', detail: 'Employee · L3 auditing N1 contract schemas & diff' });
			this._onDidChangeTree.fire(governorSessionId);
		});

		// Beat 2 (2.2s): N1 approved -> 3-way parallel Git Worktree fan-out (N2, N3, N4)!
		this.scheduleDemoStep(governorSessionId, 2200, () => {
			const now = Date.now();
			entry.state = {
				...entry.state,
				updatedAt: now,
				reports: {
					...entry.state.reports,
					N1: {
						nodeId: 'N1',
						nodeTitle: 'Interface & Data Contract',
						summary: 'Frozen TypeScript contracts in src/engine/contracts.ts with zero circular dependencies and strict typecheck pass.',
						updatedAt: now,
					},
				},
				nodes: {
					...entry.state.nodes,
					N1: { ...entry.state.nodes.N1, phase: 'completed', completed: true, completedAt: now },
					N2: { ...entry.state.nodes.N2, phase: 'worker_running', completed: false, startedAt: now },
					N3: { ...entry.state.nodes.N3, phase: 'worker_running', completed: false, startedAt: now },
					N4: { ...entry.state.nodes.N4, phase: 'worker_running', completed: false, startedAt: now },
				},
			};
			this.appendEvent(entry, 'info', 'employee.passed', { nodeId: 'N1', detail: 'N1 approved — fanning out 3 parallel Git Worktree lanes (N2, N3, N4)' });
			this._onDidChangeTree.fire(governorSessionId);
		});

		// Beat 3 (3.7s): N2 completes Manager sign-off; N3 auditing; N4 catches realistic adversarial failure_1 rework!
		this.scheduleDemoStep(governorSessionId, 3700, () => {
			const now = Date.now();
			entry.state = {
				...entry.state,
				updatedAt: now,
				tokenUsage: {
					governor: mkTok(14_000, 3_200, 48_000, 4_000, 3, 0.12),
					manager: mkTok(18_000, 4_400, 78_000, 5_000, 4, 0.17),
					employee: mkTok(34_000, 9_600, 160_000, 9_000, 7, 0.34),
					worker: mkTok(96_000, 31_200, 420_000, 20_000, 15, 1.12),
					total: mkTok(162_000, 48_400, 706_000, 38_000, 29, 1.75),
				},
				reports: {
					...entry.state.reports,
					N2: {
						nodeId: 'N2',
						nodeTitle: 'Core Backend & Services',
						summary: 'Implemented FinOps budget guardrail and scheduler ring buffer on ade/demo-N2-backend (18/18 unit tests passing).',
						updatedAt: now,
					},
				},
				nodes: {
					...entry.state.nodes,
					N2: {
						...entry.state.nodes.N2,
						phase: 'completed',
						completed: true,
						completedAt: now,
						tokenUsage: {
							worker: mkTok(42_000, 13_400, 190_000, 8_000, 6, 0.49),
							employee: mkTok(16_000, 4_800, 78_000, 4_000, 3, 0.16),
							manager: mkTok(7_000, 1_900, 34_000, 2_000, 2, 0.07),
							total: mkTok(65_000, 20_100, 302_000, 14_000, 11, 0.72),
						},
						lastChanges: {
							capturedAt: now,
							touchedFiles: [
								{ relativePath: 'src/engine/finops.ts', kind: 'added' },
								{ relativePath: 'src/engine/ringBuffer.ts', kind: 'modified' },
							],
							combinedDiff: demoDiffN2,
						},
					},
					N3: {
						...entry.state.nodes.N3,
						phase: 'employee_review',
						tokenUsage: {
							worker: mkTok(26_000, 9_600, 110_000, 6_000, 4, 0.33),
							employee: mkTok(15_000, 4_600, 70_000, 5_000, 3, 0.15),
							manager: mkTok(5_000, 1_000, 22_000, 1_500, 1, 0.05),
							total: mkTok(46_000, 15_200, 202_000, 12_500, 8, 0.53),
						},
						lastChanges: {
							capturedAt: now,
							touchedFiles: [
								{ relativePath: 'src/ui/recipeGallery.ts', kind: 'added' },
								{ relativePath: 'src/ui/finopsCard.css', kind: 'modified' },
							],
							combinedDiff: demoDiffN1,
						},
					},
					N4: {
						...entry.state.nodes.N4,
						phase: 'worker_running',
						employeeRejectCount: 1,
						formalFailureCount: 1,
						lastEmployeeFeedback: 'Missing concurrent budget-cap race test — Worker L4 adding deterministic stress assertion.',
						tokenUsage: {
							worker: mkTok(18_000, 5_800, 80_000, 4_000, 3, 0.22),
							employee: mkTok(6_000, 1_800, 28_000, 1_500, 1, 0.06),
							manager: createEmptyNodeRoleTokenBreakdown().manager,
							total: mkTok(24_000, 7_600, 108_000, 5_500, 4, 0.28),
						},
					},
				},
			};
			this.appendEvent(entry, 'info', 'manager.approved', { nodeId: 'N2', detail: 'Manager · L2 signed off segment N2 (18/18 tests green)' });
			this.appendEvent(entry, 'warn', 'employee.rejected', { nodeId: 'N4', detail: 'Adversarial QA caught missing race test — Worker L4 auto-reworking in-place' });
			this._onDidChangeTree.fire(governorSessionId);
		});

		// Beat 4 (5.2s): N3 & N4 pass -> Release Readiness Gate U1 glows amber + posts to ADE Inbox!
		this.scheduleDemoStep(governorSessionId, 5200, () => {
			const now = Date.now();
			entry.state = {
				...entry.state,
				updatedAt: now,
				tokenUsage: {
					governor: mkTok(14_000, 3_200, 48_000, 4_000, 3, 0.12),
					manager: mkTok(22_000, 5_400, 96_000, 6_000, 5, 0.21),
					employee: mkTok(45_000, 12_800, 210_000, 12_000, 9, 0.44),
					worker: mkTok(118_000, 38_600, 520_000, 24_000, 18, 1.38),
					total: mkTok(199_000, 60_000, 874_000, 46_000, 35, 2.15),
				},
				reports: {
					...entry.state.reports,
					N3: {
						nodeId: 'N3',
						nodeTitle: 'UI & Interactive Surface',
						summary: 'Verified Dark/Light theme parity, keyboard focus rings, and zero pod overlaps.',
						updatedAt: now,
					},
					N4: {
						nodeId: 'N4',
						nodeTitle: 'Automated Test & Regression Suite',
						summary: 'Resolved concurrency race assertion on attempt 2; 25/25 unit & regression tests passing.',
						updatedAt: now,
					},
				},
				nodes: {
					...entry.state.nodes,
					N3: { ...entry.state.nodes.N3, phase: 'completed', completed: true, completedAt: now },
					N4: {
						...entry.state.nodes.N4,
						phase: 'completed',
						completed: true,
						completedAt: now,
						formalFailureCount: 0,
						lastChanges: {
							capturedAt: now,
							touchedFiles: [{ relativePath: 'test/finops.test.ts', kind: 'added' }],
							combinedDiff: demoDiffN2,
						},
					},
					U1: { ...entry.state.nodes.U1, phase: 'waiting_user_gate', completed: false, startedAt: now },
				},
			};
			this.appendEvent(entry, 'info', 'gate.waiting', { nodeId: 'U1', detail: 'Release Readiness Gate awaiting your ✓ Approve (or Rollback…) — $0.00 real spend!' });
			void this.inbox.upsertUserGateTodo({
				governorSessionId,
				treeType: entry.treeType,
				nodeId: 'U1',
				nodeTitle: 'Release Readiness Gate (Demo)',
				description: 'Interactive Demo paused at Human Acceptance Gate U1. Click Approve to finish N5 & generate a PR Verification Report.',
				upstreamSummary: 'N1 Contract · N2 Backend (18/18 tests) · N3 UI (Dark+Light) · N4 Regression (25/25 tests) all verified.',
				rollbackCandidates: [
					{ id: 'N2', title: 'Core Backend & Services' },
					{ id: 'N3', title: 'UI & Interactive Surface' },
					{ id: 'N4', title: 'Automated Test & Regression Suite' },
				],
			});
			this._onDidChangeTree.fire(governorSessionId);
		});

		return this.buildSnapshot(entry);
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
						nodeInitialSnapshots: new Map(),
						segmentInitialSnapshots: new Map(),
						declinedVerifyHashes: new Set(),
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

	private getOrganizationConfig(): IAdeOrganizationConfig {
		if (this.roleSchemaService) {
			return this.roleSchemaService.getConfig();
		}
		const raw = readTrustedApplicationConfigValue<unknown>(this.configurationService, ADE_ORGANIZATION_CONFIG_KEY);
		return normalizeAdeOrganizationConfig(raw);
	}

	private getPricingOptions(): IAdePricingOptions | undefined {
		const rawCustom = readTrustedApplicationConfigValue<unknown>(this.configurationService, ADE_PRICING_CONFIG_KEY);
		const customPricing = rawCustom && typeof rawCustom === 'object' && !Array.isArray(rawCustom)
			? rawCustom as AdeCustomPricingMap
			: undefined;
		const subscriptionMode = readTrustedApplicationConfigValue<boolean>(this.configurationService, ADE_PRICING_SUBSCRIPTION_MODE_CONFIG_KEY) === true;
		if (!customPricing && !subscriptionMode) {
			return undefined;
		}
		return {
			...(customPricing ? { customPricing } : {}),
			...(subscriptionMode ? { subscriptionMode: true } : {}),
		};
	}

	private loadTrustedVerifyHashesFromStorage(): void {
		if (!this.storageService) {
			return;
		}
		const stored = this.storageService.getObject<Record<string, unknown>>(ADE_TRUSTED_VERIFY_HASHES_STORAGE_KEY, StorageScope.PROFILE, {});
		if (!stored || typeof stored !== 'object') {
			return;
		}
		for (const [projectKey, rawHashes] of Object.entries(stored)) {
			if (!Array.isArray(rawHashes)) {
				continue;
			}
			const valid = rawHashes.filter((h): h is string => typeof h === 'string' && h.length === 64);
			if (valid.length > 0) {
				this.trustedVerifyHashesByProject.set(projectKey, new Set(valid));
			}
		}
	}

	private saveTrustedVerifyHashesToStorage(): void {
		if (!this.storageService) {
			return;
		}
		const serialized: Record<string, string[]> = {};
		for (const [projectKey, hashes] of this.trustedVerifyHashesByProject.entries()) {
			if (hashes.size > 0) {
				serialized[projectKey] = [...hashes].sort();
			}
		}
		this.storageService.store(ADE_TRUSTED_VERIFY_HASHES_STORAGE_KEY, JSON.stringify(serialized), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private getProjectTrustKey(projectPath: string): string {
		return projectPath.trim();
	}

	private async isVerifyCommandTrusted(projectPath: string, command: string): Promise<{ readonly trusted: boolean; readonly hash: string }> {
		const hash = await computeVerifyCommandSha256(command);
		const key = this.getProjectTrustKey(projectPath);
		const trusted = Boolean(this.trustedVerifyHashesByProject.get(key)?.has(hash));
		return { trusted, hash };
	}

	private trustVerifyCommandHashes(projectPath: string, hashes: readonly string[]): void {
		if (hashes.length === 0) {
			return;
		}
		const key = this.getProjectTrustKey(projectPath);
		let set = this.trustedVerifyHashesByProject.get(key);
		if (!set) {
			set = new Set<string>();
			this.trustedVerifyHashesByProject.set(key, set);
		}
		let changed = false;
		for (const h of hashes) {
			if (!set.has(h)) {
				set.add(h);
				changed = true;
			}
		}
		if (changed) {
			this.saveTrustedVerifyHashesToStorage();
		}
	}

	private async promptApproveVerifyCommands(
		projectPath: string,
		commands: readonly { readonly command: string; readonly hash: string }[],
	): Promise<boolean> {
		if (!this.dialogService || commands.length === 0) {
			return false;
		}
		const cmdList = commands.map((c, idx) => `${idx + 1}. ${c.command}`).join('\n');
		const confirmation = await this.dialogService.confirm({
			type: 'warning',
			message: localize(
				'adeEngVerifyTrustConfirmTitle',
				"Approve {0} blueprint verification shell command(s) for this project?",
				commands.length,
			),
			detail: localize(
				'adeEngVerifyTrustConfirmDetail',
				"Project: {0}\n\nThese shell commands will run automatically after Worker turns (SHA-256 hash-pinned per project):\n\n{1}",
				projectPath,
				cmdList,
			),
			primaryButton: localize('adeEngVerifyTrustApproveBtn', "&&Trust & Run"),
		});
		if (confirmation.confirmed) {
			this.trustVerifyCommandHashes(projectPath, commands.map(c => c.hash));
			return true;
		}
		return false;
	}

	/**
	 * Atomic read-modify-write helper for per-node runtime state: ALWAYS re-reads the latest
	 * `entry.state.nodes[nodeId]` immediately before applying a patch so concurrent updates
	 * (e.g. `recordSessionTurnUsage` or stream heartbeats arriving across an `await`) are never clobbered.
	 */
	private updateNodeState(
		entry: IManagedTreeEntry,
		nodeId: string,
		updater: (current: IAdeEngineeringNodeRuntimeState) => IAdeEngineeringNodeRuntimeState,
		extraStatePatch?: Partial<Omit<IAdeEngineeringTreeState, 'nodes'>>,
	): IAdeEngineeringNodeRuntimeState | undefined {
		const fresh = entry.state.nodes[nodeId];
		if (!fresh) {
			return undefined;
		}
		const next = updater(fresh);
		entry.state = {
			...entry.state,
			...(extraStatePatch ?? {}),
			nodes: {
				...entry.state.nodes,
				[nodeId]: next,
			},
		};
		return next;
	}

	private isBudgetExceeded(entry: IManagedTreeEntry): { readonly exceeded: boolean; readonly totalCostUsd: number; readonly maxBudgetUsd?: number } {
		const maxBudgetUsd = entry.blueprint.metadata.maxBudgetUsd;
		if (!(typeof maxBudgetUsd === 'number' && Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0)) {
			return { exceeded: false, totalCostUsd: 0 };
		}
		const fin = computeTreeFinancialSummary(
			{
				blueprint: entry.blueprint,
				state: entry.state,
				tokenUsage: this.computeResolvedTreeTokenUsage(entry.state),
			},
			this.getPricingOptions(),
		);
		return {
			exceeded: fin.totalCostUsd >= maxBudgetUsd,
			totalCostUsd: fin.totalCostUsd,
			maxBudgetUsd,
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
		const pricingOptions = this.getPricingOptions();
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
			const estimatedCost = estimateTokenUsageCostUsd(normalizedForCost, roleCfg, pricingOptions);
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
		if (entry.state.runStatus !== 'running') {
			return;
		}
		const budgetCheck = this.isBudgetExceeded(entry);
		if (!budgetCheck.exceeded || budgetCheck.maxBudgetUsd === undefined) {
			return;
		}
		// Immediately invalidate in-flight worker run tokens & transition to paused so no concurrent dispatch slips through,
		// then route through pauseTree() to stop active agent processes and cleanly reset active nodes to 'idle'.
		entry.activeWorkerRunTokens.clear();
		entry.state = {
			...entry.state,
			runStatus: 'paused',
			updatedAt: Date.now(),
		};
		const detail = localize(
			'adeEngBudgetLimitReachedDetail',
			"Estimated spend {0} reached budget ceiling {1}. Execution paused automatically to prevent runaway API spend.",
			formatUsdCost(budgetCheck.totalCostUsd),
			formatUsdCost(budgetCheck.maxBudgetUsd),
		);
		this.appendEvent(entry, 'warn', 'budget.limit_reached', { nodeId, detail });
		void this.inbox.postGovernorMessage({
			governorSessionId: entry.governorSessionId,
			nodeId,
			title: localize('adeEngBudgetPausedInboxTitle', "Budget Guardrail Paused DAG ({0} / {1})", formatUsdCost(budgetCheck.totalCostUsd), formatUsdCost(budgetCheck.maxBudgetUsd)),
			message: detail,
			severity: 'critical',
		}).catch(() => undefined);
		void this.pauseTree(entry.governorSessionId).catch(() => undefined);
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
			try {
				await this.backend.saveTree(snapshotRecord);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				this.appendEvent(entry, 'error', 'state.persist_failed', {
					detail: `Failed to persist Engineering tree state: ${errMsg}`,
				});
				const now = Date.now();
				if (!entry.lastPersistErrorAlertAt || now - entry.lastPersistErrorAlertAt >= PERSIST_ERROR_INBOX_THROTTLE_MS) {
					entry.lastPersistErrorAlertAt = now;
					this.notificationService?.error(localize(
						'adeEngPersistFailedNotification',
						"Failed to save ADE Engineering state: {0}",
						errMsg,
					));
					void this.inbox.postGovernorMessage({
						governorSessionId: entry.governorSessionId,
						title: localize('adeEngPersistFailedInboxTitle', "Failed to Save Engineering State"),
						message: localize(
							'adeEngPersistFailedInboxMessage',
							"Could not write blueprint.md / state.json to disk: {0}. Check available disk space and filesystem permissions.",
							errMsg,
						),
						severity: 'critical',
					}).catch(() => undefined);
				}
			}
		});
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

		// Ensure role matches the configured orchestrator Work-Tree slot (e.g. 'governor', 'tech-lead', 'coordinator')
		const orchestratorRankId = resolveWorkTreeSlotRank(this.getOrganizationConfig(), 'orchestrator').id;
		if (gov.role !== orchestratorRankId) {
			this.projects.setAgentRole(gov.id, orchestratorRankId);
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
			nodeInitialSnapshots: new Map(),
			segmentInitialSnapshots: new Map(),
			declinedVerifyHashes: new Set(),
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
		this.clearDemoSimulation(options.governorSessionId);
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

		// P0-6: Hash-pinned verify command trust gate before applying blueprint
		const blueprintVerifyCmds = collectBlueprintVerifyCommands(nextBlueprint);
		const untrustedVerifyCmds: Array<{ readonly command: string; readonly hash: string }> = [];
		for (const cmd of blueprintVerifyCmds) {
			const status = await this.isVerifyCommandTrusted(entry.state.projectPath, cmd);
			if (!status.trusted) {
				untrustedVerifyCmds.push({ command: cmd, hash: status.hash });
			}
		}
		if (untrustedVerifyCmds.length > 0) {
			if (options.trustedVerifyCommands === true) {
				this.trustVerifyCommandHashes(entry.state.projectPath, untrustedVerifyCmds.map(c => c.hash));
				for (const c of untrustedVerifyCmds) {
					entry.declinedVerifyHashes.delete(c.hash);
				}
			} else if (isInteractiveHumanCaller(options.caller) && this.dialogService) {
				const approved = await this.promptApproveVerifyCommands(entry.state.projectPath, untrustedVerifyCmds);
				if (approved) {
					for (const c of untrustedVerifyCmds) {
						entry.declinedVerifyHashes.delete(c.hash);
					}
				} else {
					for (const c of untrustedVerifyCmds) {
						entry.declinedVerifyHashes.add(c.hash);
					}
					this.appendEvent(entry, 'warn', 'verify.untrusted_declined', {
						detail: `User declined trusting ${untrustedVerifyCmds.length} verification command(s); execution will refuse to run unapproved verify commands.`,
					});
				}
			} else {
				// Non-interactive agent caller (e.g. Governor / Secretary CLI apply): NEVER auto-trust shell verify commands!
				this.appendEvent(entry, 'warn', 'verify.approval_required', {
					detail: `Blueprint applied by "${options.caller ?? 'agent'}" contains ${untrustedVerifyCmds.length} unapproved verify command(s); human approval required before execution.`,
				});
			}
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
		const scopeConflicts = detectSharedWorkspaceScopeConflicts(nextBlueprint, { treatMissingAsWholeRepo: true });
		for (const c of scopeConflicts) {
			this.appendEvent(entry, 'warn', 'blueprint.scope_conflict', {
				nodeId: c.nodeA,
				detail: `Parallel nodes [${c.nodeA}] & [${c.nodeB}] have overlapping file scopes in shared workspace; scheduler will serialize them automatically (or switch to workspace_isolation: worktree).`,
			});
		}
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
		this.clearDemoSimulation(params.governorSessionId);

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

		const fullReset = !params.nodeId?.trim() && !params.keepCompleted;
		if (fullReset) {
			entry.nodeInitialSnapshots.clear();
			entry.segmentInitialSnapshots.clear();
			await this.backend.cleanupTreeWorktrees(entry.governorSessionId, entry.state.projectPath).catch(() => { });
			await this.inbox.removeItemsForGovernor(entry.governorSessionId).catch(() => { });
		}

		// Re-read fresh entry.state.nodes & reports AFTER all awaits (eliminates stale RMW window)
		const nextNodes: Record<string, IAdeEngineeringNodeRuntimeState> = { ...entry.state.nodes };
		const nextReports: Record<string, IAdeIncrementalReportEntry> = { ...entry.state.reports };
		for (const nid of resetSet) {
			if (params.keepCompleted && !params.nodeId?.trim() && nextNodes[nid]?.completed) {
				continue;
			}
			const prev = nextNodes[nid];
			entry.nodeInitialSnapshots.delete(nid);
			if (prev?.segmentId) {
				entry.segmentInitialSnapshots.delete(prev.segmentId);
			}
			nextNodes[nid] = {
				nodeId: nid,
				phase: 'idle',
				completed: false,
				employeeRejectCount: 0,
				formalFailureCount: 0,
				fourthChanceGranted: false,
				workerTurnCount: 0,
				employeeReviewCount: 0,
				watchdogRemindCount: 0,
				segmentId: prev?.segmentId,
				managerAgentId: prev?.managerAgentId,
				employeeAgentId: prev?.employeeAgentId,
				workerAgentId: prev?.workerAgentId,
			};
			delete nextReports[nid];
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
		if (!normalized || normalized === 'user' || normalized === 'human' || normalized === 'secretary') {
			return;
		}
		const baseCaller = normalized.includes(':') ? normalized.slice(0, normalized.indexOf(':')) : normalized;
		const orgConfig = this.getOrganizationConfig();
		const configuredRank = orgConfig.ranks.find(r => r.id.toLowerCase() === baseCaller);
		if (configuredRank) {
			if (!configuredRank.pureExecution && configuredRank.allowedApis.includes('engineering.control')) {
				return;
			}
			throw new Error(localize(
				'adeEngineeringGovernorStartForbidden',
				"Permission denied: Orchestrated tree agents ({0}) cannot start Engineering execution directly. Only the User (via Engineering page) or Secretary may start execution.",
				normalized,
			));
		}
		if (
			baseCaller === 'governor'
			|| baseCaller === 'manager'
			|| baseCaller === 'employee'
			|| baseCaller === 'worker'
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
		this.clearDemoSimulation(governorSessionId);
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
	): Promise<{ reply: string; stopped?: boolean; skipReviewerNudge?: boolean }> {
		const agent = await this.ensureAgentMaterialized(agentId, options.cwdOverride);
		if (!agent.session) {
			return { reply: '' };
		}
		const orgConfig = this.getOrganizationConfig();
		const resolvedCallerRole = options.pureWorker
			? resolveWorkTreeSlotRank(orgConfig, 'executor').id
			: (agent.role ?? resolveWorkTreeSlotRank(orgConfig, 'reviewer').id);
		const turnStartedAt = Date.now();
		this.projects.setAgentStatus(agent.id, 'working');
		try {
			let extResult: { reply?: string; stopped?: boolean; skipReviewerNudge?: boolean; usage?: Partial<IAdeTokenUsage> } | undefined;
			let commandMissing = false;
			try {
				extResult = await this.commandService.executeCommand<{ reply?: string; stopped?: boolean; skipReviewerNudge?: boolean; usage?: Partial<IAdeTokenUsage> }>(
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
						inputTokens: estimateTextTokens(prompt),
						outputTokens: estimateTextTokens(replyText),
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
					skipReviewerNudge: extResult.skipReviewerNudge,
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
						inputTokens: Math.max(1, estimateTextTokens(prompt)),
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

	private formatLayeredUpstreamSummaryBlock(layered: {
		readonly direct: readonly IAdeIncrementalReportEntry[];
		readonly distant: readonly IAdeIncrementalReportEntry[];
	}): string {
		if (layered.direct.length === 0 && layered.distant.length === 0) {
			return '(None — root task)';
		}
		const lines: string[] = [];
		const recentDistant = layered.distant.slice(-6);
		if (layered.distant.length > recentDistant.length) {
			lines.push(`- ... (${layered.distant.length - recentDistant.length} earlier ancestor report(s) omitted)`);
		}
		for (const r of recentDistant) {
			const headline = r.summary.replace(/\s+/g, ' ').trim();
			const clipped = headline.length > 140 ? `${headline.slice(0, 137)}...` : headline;
			lines.push(`- [${r.nodeId}] ${r.nodeTitle} *(ancestor)*: ${clipped}`);
		}
		for (const r of layered.direct) {
			lines.push(`- **[${r.nodeId}] ${r.nodeTitle}**: ${r.summary}`);
		}
		return lines.join('\n');
	}

	private buildPureWorkerPrompt(
		node: IAdeEngineeringBlueprintNode,
		layeredUpstream: { readonly direct: readonly IAdeIncrementalReportEntry[]; readonly distant: readonly IAdeIncrementalReportEntry[] },
		reworkInstruction?: { readonly source: 'employee' | 'manager' | 'user_gate' | 'watchdog' | 'verify'; readonly feedback: string },
		sharedWorkspace = false,
		isIncrementalRework = false,
	): string {
		// STRICT COMPLIANCE (Spec 1.2 & 3.2):
		// Worker L4 context MUST remain 100% pure business code instructions.
		// Zero ADE role names, zero hierarchy info, zero `aexus-ade` commands, zero report requests!
		if (isIncrementalRework && reworkInstruction?.feedback?.trim()) {
			return [
				`## Required Revisions — ${node.title}`,
				'Modify the existing workspace code incrementally to address the feedback below while satisfying the original task & acceptance criteria already in your conversation history:',
				reworkInstruction.feedback.trim(),
				...(sharedWorkspace ? ['', 'Touch only files required for this task; leave unrelated workspace files untouched.'] : []),
			].join('\n\n');
		}

		const sections: string[] = [];

		if (layeredUpstream.direct.length > 0 || layeredUpstream.distant.length > 0) {
			sections.push([
				'## Completed Upstream Context',
				this.formatLayeredUpstreamSummaryBlock(layeredUpstream),
			].join('\n'));
		}

		sections.push([
			`## Task: ${node.title}`,
			(node.goal ?? '').trim() || `Implement ${node.title}.`,
			...(node.files && node.files.length > 0 ? ['', `Target file scope: ${node.files.join(', ')}`] : []),
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

		// Activate ready user gates immediately (0 Worker concurrency slots)
		for (const node of readyNodes) {
			if (node.type === 'user_gate') {
				await this.activateUserGateNode(entry, node);
			}
		}

		// Schedule ready task nodes by critical-path priority within maxConcurrency & shared-workspace scope isolation
		const isSharedWorkspace = entry.blueprint.metadata.workspaceIsolation !== 'worktree';
		const maxConcurrency = entry.blueprint.metadata.maxConcurrency ?? (isSharedWorkspace ? 4 : 6);
		const nodeById = new Map(entry.blueprint.nodes.map(n => [n.id, n]));
		const activeTaskNodes: IAdeEngineeringBlueprintNode[] = [];
		for (const [nid, s] of Object.entries(entry.state.nodes)) {
			if (!s.completed && s.phase !== 'idle' && s.phase !== 'waiting_user_gate' && s.phase !== 'circuit_broken') {
				const n = nodeById.get(nid);
				if (n && n.type === 'task') {
					activeTaskNodes.push(n);
				}
			}
		}

		const readyTaskNodes = readyNodes.filter(n => n.type === 'task');
		if (readyTaskNodes.length > 1) {
			const priorities = computeCriticalPathPriorities(entry.blueprint);
			readyTaskNodes.sort((a, b) => (priorities.get(b.id) ?? 0) - (priorities.get(a.id) ?? 0));
		}

		if (this.isBudgetExceeded(entry).exceeded) {
			this.enforceBudgetCeilingIfNeeded(entry);
			return;
		}

		let runningSlots = activeTaskNodes.length;
		for (const node of readyTaskNodes) {
			if (runningSlots >= maxConcurrency) {
				break;
			}
			if (isSharedWorkspace) {
				const conflictsActive = activeTaskNodes.some(active => doFileScopesOverlap(node.files, active.files, { treatMissingAsWholeRepo: true }));
				if (conflictsActive) {
					continue;
				}
			}
			activeTaskNodes.push(node);
			runningSlots++;
			void this.activateTaskNodeWorker(entry, node);
		}

		// Finalize runStatus if zero active tasks remain (waiting on a User Gate or blocked by a circuit-broken branch)
		const hasWaitingGate = Object.values(entry.state.nodes).some(s => !s.completed && s.phase === 'waiting_user_gate');
		const hasActiveWork = Object.values(entry.state.nodes).some(
			s => !s.completed && s.phase !== 'idle' && s.phase !== 'waiting_user_gate' && s.phase !== 'circuit_broken',
		);
		const hasCircuitBroken = Object.values(entry.state.nodes).some(s => !s.completed && s.phase === 'circuit_broken');
		if (!hasActiveWork && entry.state.runStatus === 'running') {
			if (hasWaitingGate) {
				entry.state = { ...entry.state, runStatus: 'waiting_gate' };
				await this.persistEntry(entry);
			} else if (hasCircuitBroken) {
				entry.state = { ...entry.state, runStatus: 'circuit_broken' };
				await this.persistEntry(entry);
			}
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
		reworkInstruction?: { readonly source: 'employee' | 'manager' | 'user_gate' | 'watchdog' | 'verify'; readonly feedback: string },
	): Promise<void> {
		if (entry.removed || entry.state.runStatus !== 'running') {
			return;
		}
		// Pre-dispatch budget admission guardrail: refuse new turns once ceiling is reached.
		if (this.isBudgetExceeded(entry).exceeded) {
			this.enforceBudgetCeilingIfNeeded(entry, node.id);
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
		this.updateNodeState(entry, node.id, fresh => ({
			...fresh,
			phase: 'worker_running',
			startedAt: fresh.startedAt ?? reservedAt,
			lastStreamActivityAt: reservedAt,
			lastGateFeedback: undefined,
		}));

		let effectiveCwd = entry.state.projectPath;
		try {
			const ws = await this.resolveEffectiveWorkspaceDir(entry, node);
			if (entry.removed || entry.activeWorkerRunTokens.get(node.id) !== runToken || entry.state.runStatus !== 'running') {
				return;
			}
			effectiveCwd = ws.cwd;
			if (ws.mergeConflict) {
				entry.activeWorkerRunTokens.delete(node.id);
				const updatedConflict = this.updateNodeState(entry, node.id, fresh => ({
					...fresh,
					phase: 'manager_escalation',
				}));
				// Spec 4.2: Wake segment Manager to resolve Git merge conflict before running Worker!
				this.appendEvent(entry, 'warn', 'worktree.conflict', {
					nodeId: node.id,
					segmentId: updatedConflict?.segmentId ?? rState.segmentId,
					detail: `Merge conflict on: ${ws.mergeConflict.conflictedFiles.join(', ')}`,
				});
				await this.persistEntry(entry);
				await this.wakeSegmentManagerForMergeConflict(entry, node, effectiveCwd, ws.mergeConflict);
				return;
			}
		} catch (err) {
			entry.activeWorkerRunTokens.delete(node.id);
			const errMsg = err instanceof Error ? err.message : String(err);
			this.appendEvent(entry, 'error', 'worktree.creation_failed', {
				nodeId: node.id,
				segmentId: rState.segmentId,
				detail: `Git worktree isolation failed for [${node.id}]: ${errMsg}. Paused execution instead of silently falling back to shared workspace.`,
			});
			void this.inbox.postGovernorMessage({
				governorSessionId: entry.governorSessionId,
				nodeId: node.id,
				title: localize('adeEngWorktreeFailedInboxTitle', "Git Worktree Creation Failed — Execution Paused"),
				message: localize(
					'adeEngWorktreeFailedInboxMsg',
					"Could not prepare isolated Git worktree for node [{0}]: {1}\n\nExecution was paused to prevent unisolated parallel edits in the shared repository root. Fix the Git repository state or switch workspace_isolation to shared explicitly.",
					node.id,
					errMsg,
				),
				severity: 'critical',
			}).catch(() => undefined);
			await this.pauseTree(entry.governorSessionId);
			return;
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
		if (!entry.nodeInitialSnapshots.has(node.id)) {
			entry.nodeInitialSnapshots.set(node.id, beforeSnapshot);
		}
		const owningSeg = entry.blueprint.managers.find(m => m.nodeIds.includes(node.id));
		if (owningSeg && !entry.segmentInitialSnapshots.has(owningSeg.segmentId)) {
			entry.segmentInitialSnapshots.set(owningSeg.segmentId, beforeSnapshot);
		}
		const layeredUpstream = buildLayeredUpstreamReports(node.id, entry.blueprint, entry.state.reports);
		const isSharedWorkspace = entry.blueprint.metadata.workspaceIsolation !== 'worktree';
		const prevTurnCount = entry.state.nodes[node.id]?.workerTurnCount ?? 0;
		const isIncrementalRework = Boolean(effectiveRework && prevTurnCount > 0);
		const purePrompt = this.buildPureWorkerPrompt(node, layeredUpstream, effectiveRework, isSharedWorkspace, isIncrementalRework);

		const computeTurnAndCumulative = async (): Promise<{ turnChanges: IAdeWorkerTurnChanges; cumulativeChanges: IAdeWorkerTurnChanges }> => {
			const siblingFilter = this.buildSiblingSha1Filter(entry, node.id, beforeSnapshot.capturedAt);
			const turnChanges = await this.backend.computeWorkerTurnChanges(effectiveCwd, beforeSnapshot, siblingFilter);
			const nodeBaseline = entry.nodeInitialSnapshots.get(node.id);
			if (!nodeBaseline || nodeBaseline === beforeSnapshot) {
				return { turnChanges, cumulativeChanges: turnChanges };
			}
			const cumulativeSiblingFilter = this.buildSiblingSha1Filter(entry, node.id, nodeBaseline.capturedAt);
			const cumulativeChanges = await this.backend.computeWorkerTurnChanges(effectiveCwd, nodeBaseline, cumulativeSiblingFilter)
				.catch(() => turnChanges);
			return { turnChanges, cumulativeChanges };
		};

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

			const { turnChanges, cumulativeChanges } = await computeTurnAndCumulative();
			this.recordNodeFileMutations(entry, node.id, turnChanges);
			void this.refreshProjectScmSilently(entry.state.projectPath);
			await this.handleWorkerTurnCompleted(entry, node, effectiveCwd, turnRes.reply, turnChanges, cumulativeChanges);
		} catch (err) {
			if (entry.removed || entry.activeWorkerRunTokens.get(node.id) !== runToken || entry.state.runStatus !== 'running') {
				return;
			}
			entry.activeWorkerRunTokens.delete(node.id);
			const errMsg = err instanceof Error ? err.message : String(err);
			this.appendEvent(entry, 'error', 'worker.error', { nodeId: node.id, detail: errMsg });
			const fallbackEmpty: IAdeWorkerTurnChanges = { capturedAt: Date.now(), touchedFiles: [], combinedDiff: '' };
			const { turnChanges, cumulativeChanges } = await computeTurnAndCumulative().catch(() => ({
				turnChanges: fallbackEmpty,
				cumulativeChanges: fallbackEmpty,
			}));
			this.recordNodeFileMutations(entry, node.id, turnChanges);
			void this.refreshProjectScmSilently(entry.state.projectPath);
			await this.handleWorkerTurnCompleted(entry, node, effectiveCwd, `[Worker execution error]: ${errMsg}`, turnChanges, cumulativeChanges);
		}
	}

	private async handleWorkerTurnCompleted(
		entry: IManagedTreeEntry,
		node: IAdeEngineeringBlueprintNode,
		effectiveCwd: string,
		workerReply: string,
		changes: IAdeWorkerTurnChanges,
		cumulativeChanges?: IAdeWorkerTurnChanges,
	): Promise<void> {
		const initialLatest = entry.state.nodes[node.id];
		if (!initialLatest || initialLatest.completed) {
			return;
		}
		const effectiveCumulative = cumulativeChanges ?? changes;

		// Deterministic pre-review verification gate (skip LLM Reviewer completely on obvious build/lint/test failures)
		const verifyCmd = node.verify?.trim() || entry.blueprint.metadata.verify?.trim();
		let verifyPassLine: string | undefined;
		if (verifyCmd && this.backend.runNodeVerificationCommand) {
			const trustCheck = await this.isVerifyCommandTrusted(entry.state.projectPath, verifyCmd);
			if (entry.removed || entry.state.runStatus !== 'running') {
				return;
			}
			let commandApproved = trustCheck.trusted;
			if (!commandApproved && !entry.declinedVerifyHashes.has(trustCheck.hash) && this.dialogService) {
				commandApproved = await this.promptApproveVerifyCommands(entry.state.projectPath, [{ command: verifyCmd, hash: trustCheck.hash }]);
				if (!commandApproved) {
					entry.declinedVerifyHashes.add(trustCheck.hash);
				}
			}
			if (entry.removed || entry.state.runStatus !== 'running') {
				return;
			}
			if (!commandApproved) {
				const blockDetail = localize(
					'adeEngVerifyBlockedUntrustedDetail',
					"Refused to execute unapproved verification command `{0}` on node [{1}]. Execution paused until the command is explicitly trusted.",
					verifyCmd,
					node.id,
				);
				this.appendEvent(entry, 'error', 'verify.blocked_untrusted', {
					nodeId: node.id,
					detail: blockDetail,
				});
				void this.inbox.postGovernorMessage({
					governorSessionId: entry.governorSessionId,
					nodeId: node.id,
					title: localize('adeEngVerifyBlockedInboxTitle', "Blocked Untrusted Verify Command on [{0}]", node.id),
					message: blockDetail,
					severity: 'critical',
				}).catch(() => undefined);
				await this.pauseTree(entry.governorSessionId);
				return;
			}

			const verifyRes = await this.backend.runNodeVerificationCommand(effectiveCwd, verifyCmd).catch(err => ({
				passed: false,
				exitCode: 1,
				output: err instanceof Error ? err.message : String(err),
				durationMs: 0,
			}));
			if (entry.removed || entry.state.runStatus !== 'running') {
				return;
			}
			const trimmedOut = verifyRes.output.trim().slice(0, 4000);
			if (!verifyRes.passed) {
				const verifyFeedback = `Deterministic verification command \`${verifyCmd}\` failed (exit ${verifyRes.exitCode}):\n\`\`\`\n${trimmedOut || '(no output)'}\n\`\`\``;
				this.appendEvent(entry, 'warn', 'verify.failed', {
					nodeId: node.id,
					detail: `${verifyCmd} (exit ${verifyRes.exitCode})`,
				});
				const seg = entry.blueprint.managers.find(m => m.nodeIds.includes(node.id));
				// Re-read fresh node state AFTER verify await via updateNodeState so concurrent tokenUsage/heartbeat updates are never clobbered!
				const freshAfterVerify = entry.state.nodes[node.id];
				if (!freshAfterVerify || freshAfterVerify.completed) {
					return;
				}
				const nextRejectCount = (freshAfterVerify.employeeRejectCount ?? 0) + 1;
				const buildCommonPatch = (fresh: IAdeEngineeringNodeRuntimeState): IAdeEngineeringNodeRuntimeState => ({
					...fresh,
					workerTurnCount: (fresh.workerTurnCount ?? 0) + 1,
					watchdogRemindCount: 0,
					lastWorkerOutput: workerReply.slice(0, 6000),
					lastChanges: changes,
					cumulativeChanges: effectiveCumulative,
					lastVerifyOutput: trimmedOut,
					lastEmployeeFeedback: verifyFeedback,
				});
				if (freshAfterVerify.fourthChanceGranted && seg) {
					this.updateNodeState(entry, node.id, fresh => ({ ...buildCommonPatch(fresh), phase: 'manager_review' }));
					await this.persistEntry(entry);
					await this.wakeSegmentManagerForSecondaryReview(entry, node, seg);
					return;
				}
				if (nextRejectCount >= 3 && seg) {
					this.updateNodeState(entry, node.id, fresh => ({ ...buildCommonPatch(fresh), phase: 'manager_escalation', employeeRejectCount: nextRejectCount }));
					await this.persistEntry(entry);
					await this.wakeSegmentManagerForEscalation(entry, node, seg, verifyFeedback);
					return;
				}
				this.updateNodeState(entry, node.id, fresh => ({ ...buildCommonPatch(fresh), employeeRejectCount: nextRejectCount }));
				await this.persistEntry(entry);
				void this.activateTaskNodeWorker(entry, node, { source: 'verify', feedback: verifyFeedback });
				return;
			}
			this.appendEvent(entry, 'info', 'verify.passed', {
				nodeId: node.id,
				detail: `${verifyCmd} (${verifyRes.durationMs}ms)`,
			});
			verifyPassLine = `PASSED (\`${verifyCmd}\`, ${verifyRes.durationMs}ms)`;
		}

		// Re-read fresh node state AFTER any verify/trust await before entering review (P1-2)
		const freshBeforeReview = entry.state.nodes[node.id];
		if (!freshBeforeReview || freshBeforeReview.completed) {
			return;
		}
		const prevReviewCount = freshBeforeReview.employeeReviewCount ?? 0;
		const isIncrementalReview = prevReviewCount > 0;
		const latest = this.updateNodeState(entry, node.id, fresh => ({
			...fresh,
			phase: 'employee_review',
			workerTurnCount: (fresh.workerTurnCount ?? 0) + 1,
			employeeReviewCount: (fresh.employeeReviewCount ?? 0) + 1,
			watchdogRemindCount: 0,
			lastWorkerOutput: workerReply.slice(0, 6000),
			lastChanges: changes,
			cumulativeChanges: effectiveCumulative,
			lastVerifyOutput: verifyPassLine,
		}))!;
		this.appendEvent(entry, 'info', 'employee.review_started', {
			nodeId: node.id,
			detail: `${changes.touchedFiles.length} file(s) touched (${effectiveCumulative.touchedFiles.length} cumulative)`,
		});
		await this.persistEntry(entry);

		// Spec 3.3: Wake Employee (L3) to verify Worker's implementation & diff without writing code itself
		if (!latest.employeeAgentId) {
			return;
		}
		const touchedSummary = changes.touchedFiles.length > 0
			? changes.touchedFiles.map(f => `- [${f.kind.toUpperCase()}] ${f.relativePath}`).join('\n')
			: '(No workspace file mutations detected in snapshot)';
		const hasDistinctCumulative = effectiveCumulative !== changes && effectiveCumulative.combinedDiff !== changes.combinedDiff;
		const cumulativeTouchedSummary = effectiveCumulative.touchedFiles.length > 0
			? effectiveCumulative.touchedFiles.map(f => `- [${f.kind.toUpperCase()}] ${f.relativePath}`).join('\n')
			: touchedSummary;

		const actionLines = [
			'## Required Action (Execute ONE command via bash/terminal tool)',
			`- **If PASS**: \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role employee --verdict pass --report "<concise summary for downstream nodes>"\``,
			latest.fourthChanceGranted
				? `- **If REJECT** (4th-chance final review — routes to Segment Manager): \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role employee --verdict reject --feedback "<fix instructions>"\``
				: `- **If REJECT** (internal iteration ${(latest.employeeRejectCount ?? 0) + 1}/3): \`aexus-ade engineering review --governor ${entry.governorSessionId} --node ${node.id} --role employee --verdict reject --feedback "<fix instructions>"\``,
		];

		let reviewPrompt: string;
		if (isIncrementalReview) {
			reviewPrompt = [
				`# Re-Review (Attempt #${prevReviewCount + 1}) — [${node.id}] ${node.title}`,
				`Role: **Employee (L3 Reviewer, \`Employee ≠ Worker\`)** — audit only; NEVER edit business code yourself. Original goal, acceptance criteria & upstream context are in your prior turn.`,
				...(verifyPassLine ? ['', `## Deterministic Verification: ${verifyPassLine}`] : []),
				'',
				'## Latest Worker Output',
				workerReply.trim() ? workerReply.trim().slice(0, 3000) : '(No text summary returned by Worker)',
				'',
				'## This Turn\'s Incremental Diff',
				changes.combinedDiff ? `\`\`\`diff\n${changes.combinedDiff}\n\`\`\`` : '(Empty turn diff)',
				...(hasDistinctCumulative ? [
					'',
					'## Cumulative Node Changes (All Touched Files Since Node Start)',
					cumulativeTouchedSummary,
					'',
					effectiveCumulative.combinedDiff ? `\`\`\`diff\n${effectiveCumulative.combinedDiff.slice(0, 16_000)}\n\`\`\`` : '(Same as turn diff)',
				] : []),
				'',
				...actionLines,
			].join('\n');
		} else {
			const layeredUpstream = buildLayeredUpstreamReports(node.id, entry.blueprint, entry.state.reports);
			reviewPrompt = [
				`# Engineering Single-Node Review — [${node.id}] ${node.title}`,
				`Role: **Employee (L3 Reviewer, \`Employee ≠ Worker\`)** for node \`${node.id}\` in tree \`${entry.governorSessionId}\`. Audit only — NEVER write or modify business code yourself.`,
				...(entry.blueprint.metadata.workspaceIsolation !== 'worktree'
					? ['**Shared-Workspace Rule**: Parallel DAG nodes may touch unrelated files concurrently. Evaluate ONLY files/behavior for `' + node.id + '` — never ask your Worker to delete unrelated parallel files.']
					: []),
				...(verifyPassLine ? ['', `## Deterministic Verification: ${verifyPassLine}`] : []),
				'',
				'## Node Goal',
				(node.goal ?? '').trim() || '(See node title)',
				'',
				'## Acceptance Criteria',
				(node.acceptance ?? '').trim() || 'Implementation is complete, clean, and free of build/test errors.',
				'',
				'## Upstream Context',
				this.formatLayeredUpstreamSummaryBlock(layeredUpstream),
				'',
				'## Worker Output Summary',
				workerReply.trim() ? workerReply.trim().slice(0, 4000) : '(No text summary returned by Worker)',
				'',
				'## Files Touched by Worker',
				touchedSummary,
				'',
				'## Unified Diff of Worker Changes',
				changes.combinedDiff ? `\`\`\`diff\n${changes.combinedDiff}\n\`\`\`` : '(Empty diff — run read-only `git status` / `git diff` or test commands if needed)',
				'',
				...actionLines,
			].join('\n');
		}

		void this.dispatchReviewerWithNudge(entry, node.id, 'employee_review', latest.employeeAgentId, reviewPrompt, {
			model: node.employee?.model,
			thinking: node.employee?.thinking ?? 'medium',
			cwdOverride: effectiveCwd,
		}, [
			`IMPORTANT: Your Employee review turn for node \`${node.id}\` ended without executing \`aexus-ade engineering review\`.`,
			`Execute ONE command immediately via Bash:`,
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
				&& !res.skipReviewerNudge
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

		// Compute cumulative diff across the entire segment (not just the last node's last turn)
		let segmentDiffText = '';
		let segmentTouchedLines = '';
		const segBaseline = entry.segmentInitialSnapshots.get(seg.segmentId);
		if (segBaseline) {
			const segChanges = await this.backend.computeWorkerTurnChanges(effectiveCwd, segBaseline).catch(() => undefined);
			if (segChanges && (segChanges.touchedFiles.length > 0 || segChanges.combinedDiff)) {
				segmentTouchedLines = segChanges.touchedFiles.map(f => `- [${f.kind.toUpperCase()}] ${f.relativePath}`).join('\n');
				segmentDiffText = segChanges.combinedDiff;
			}
		}
		if (!segmentDiffText) {
			const touchedMap = new Map<string, string>();
			const diffParts: string[] = [];
			for (const nid of seg.nodeIds) {
				const ch = entry.state.nodes[nid]?.cumulativeChanges ?? entry.state.nodes[nid]?.lastChanges;
				if (!ch) { continue; }
				for (const f of ch.touchedFiles) {
					touchedMap.set(f.relativePath, f.kind);
				}
				if (ch.combinedDiff) {
					diffParts.push(`# [${nid}]\n${ch.combinedDiff}`);
				}
			}
			segmentTouchedLines = [...touchedMap.entries()].map(([p, k]) => `- [${k.toUpperCase()}] ${p}`).join('\n');
			segmentDiffText = diffParts.join('\n\n');
		}
		const cappedSegDiff = segmentDiffText.length > 20_000
			? `${segmentDiffText.slice(0, 20_000)}\n... (diff truncated; run \`aexus-ade engineering diff --governor ${entry.governorSessionId} --node ${node.id}\` or \`git diff\`)`
			: segmentDiffText;

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
			...(segmentTouchedLines ? ['', '## Cumulative Segment Touched Files', segmentTouchedLines] : []),
			'',
			'## Cumulative Segment Diff',
			cappedSegDiff ? `\`\`\`diff\n${cappedSegDiff}\n\`\`\`` : '(Inspect workspace via read-only git/test commands if needed)',
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
			if (entry.blueprint.metadata.workspaceIsolation === 'worktree' && seg && isSegmentTail) {
				const wtPath = entry.state.worktrees?.[seg.segmentId]?.worktreePath;
				if (wtPath) {
					await this.backend.commitSegmentWorktree(wtPath, `feat(ade): complete segment ${seg.segmentId}`).catch(() => undefined);
				}
			}
			// Re-read fresh reports & node state AFTER commitSegmentWorktree await (P1-2)
			const nextReports = { ...entry.state.reports };
			if (params.report?.trim()) {
				nextReports[node.id] = {
					nodeId: node.id,
					nodeTitle: node.title,
					summary: params.report.trim(),
					updatedAt: Date.now(),
				};
			}
			this.updateNodeState(
				entry,
				node.id,
				fresh => ({
					...fresh,
					phase: 'completed',
					completed: true,
					completedAt: Date.now(),
					employeeRejectCount: 0,
					fourthChanceGranted: false,
					lastManagerFeedback: undefined,
				}),
				{ reports: nextReports },
			);
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
			// Branch-isolated RED Circuit Breaker: block this node & its dependents while allowing independent parallel branches to finish
			const updatedNodes: Record<string, IAdeEngineeringNodeRuntimeState> = {
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
			};
			const hasOtherActiveWork = Object.entries(updatedNodes).some(
				([nid, s]) => nid !== node.id && !s.completed && s.phase !== 'idle' && s.phase !== 'waiting_user_gate' && s.phase !== 'circuit_broken',
			);
			const incomingByNode = new Map<string, string[]>();
			for (const bn of entry.blueprint.nodes) { incomingByNode.set(bn.id, []); }
			for (const e of entry.blueprint.edges) { incomingByNode.get(e.to)?.push(e.from); }
			const hasOtherRunnableReady = entry.blueprint.nodes.some(bn => {
				if (bn.id === node.id) { return false; }
				const s = updatedNodes[bn.id];
				if (!s || s.completed || s.phase !== 'idle') { return false; }
				return (incomingByNode.get(bn.id) ?? []).every(predId => Boolean(updatedNodes[predId]?.completed));
			});
			const keepIndependentBranchesRunning = entry.state.runStatus === 'running' && (hasOtherActiveWork || hasOtherRunnableReady);
			entry.state = {
				...entry.state,
				runStatus: keepIndependentBranchesRunning ? 'running' : 'circuit_broken',
				nodes: updatedNodes,
			};
			this.appendEvent(entry, 'error', 'manager.circuit_breaker_tripped', {
				nodeId: node.id,
				segmentId: seg?.segmentId,
				detail: `3rd formal failure (RED${keepIndependentBranchesRunning ? '; independent branches continue' : ''}): ${mgrFeedback}`,
			});
			await this.persistEntry(entry);
			this.inbox.noteCircuitBreakerTrip?.(entry.governorSessionId, node.id);
			await this.wakeGovernorOnCircuitBreaker(entry, node, seg, mgrFeedback);
			if (keepIndependentBranchesRunning) {
				await this.scheduleReadyNodes(entry);
			}
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
			if (this.demoActive.has(entry.governorSessionId)) {
				const now = Date.now();
				const n5 = entry.state.nodes.N5;
				if (n5) {
					entry.state = {
						...entry.state,
						updatedAt: now,
						nodes: {
							...entry.state.nodes,
							N5: { ...n5, phase: 'worker_running', completed: false, startedAt: now },
						},
					};
					this._onDidChangeTree.fire(entry.governorSessionId);
					this.scheduleDemoStep(entry.governorSessionId, 950, () => {
						const doneAt = Date.now();
						entry.state = {
							...entry.state,
							runStatus: 'completed',
							updatedAt: doneAt,
							reports: {
								...entry.state.reports,
								N5: {
									nodeId: 'N5',
									nodeTitle: 'Integration & Smoke Verification',
									summary: 'Merged 3 isolated worktree lanes cleanly; smoke build & regression suite 100% green ($0.00 real spend).',
									updatedAt: doneAt,
								},
							},
							nodes: {
								...entry.state.nodes,
								N5: { ...entry.state.nodes.N5, phase: 'completed', completed: true, completedAt: doneAt },
							},
						};
						this.appendEvent(entry, 'info', 'demo.completed', { nodeId: 'N5', detail: 'Interactive Demo complete (6/6 verified, $0.00 real spend) — Try Copy PR Report or Export SVG!' });
						this.clearDemoSimulation(entry.governorSessionId);
						this._onDidChangeTree.fire(entry.governorSessionId);
					});
				}
				return this.buildSnapshot(entry);
			}
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
		if (this.demoActive.has(entry.governorSessionId)) {
			if (targetNode) {
				entry.state = {
					...entry.state,
					nodes: {
						...entry.state.nodes,
						[targetNode.id]: { ...entry.state.nodes[targetNode.id], phase: 'worker_running', startedAt: Date.now() },
					},
				};
				this._onDidChangeTree.fire(entry.governorSessionId);
				this.scheduleDemoStep(entry.governorSessionId, 1100, () => {
					const doneAt = Date.now();
					entry.state = {
						...entry.state,
						updatedAt: doneAt,
						nodes: {
							...entry.state.nodes,
							[targetNode.id]: { ...entry.state.nodes[targetNode.id], phase: 'completed', completed: true, completedAt: doneAt },
							[gateNode.id]: { ...entry.state.nodes[gateNode.id], phase: 'waiting_user_gate', completed: false, startedAt: doneAt },
						},
					};
					this.appendEvent(entry, 'info', 'gate.waiting', { nodeId: gateNode.id, detail: `Rolled-back ${targetNode.id} re-verified — Gate ${gateNode.id} ready again` });
					this._onDidChangeTree.fire(entry.governorSessionId);
				});
			}
			return this.buildSnapshot(entry);
		}
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
								watchdogRemindCount: 0,
							},
						},
					};
					return;
				}
			}
		}
	}

	async runWatchdogSweep(now = Date.now()): Promise<void> {
		const configuredMinutes = readTrustedApplicationConfigValue<number>(this.configurationService, ADE_WATCHDOG_TIMEOUT_CONFIG_KEY);
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

				const seg = entry.blueprint.managers.find(m => m.nodeIds.includes(node.id));
				const prevRemindCount = rState.watchdogRemindCount ?? 0;

				// Stage 1 (Zero LLM tokens): automatically nudge the stalled Worker deterministically first!
				if (prevRemindCount === 0 && rState.workerAgentId) {
					const autoNudge = `No progress output detected for ${timeoutMinutes} minutes. Please report your current step or complete the remaining acceptance requirements.`;
					entry.state = {
						...entry.state,
						nodes: {
							...entry.state.nodes,
							[node.id]: {
								...rState,
								lastWatchdogAlertAt: now,
								watchdogRemindCount: 1,
							},
						},
					};
					this.appendEvent(entry, 'warn', 'watchdog.auto_reminded', {
						nodeId: node.id,
						segmentId: seg?.segmentId,
						detail: `No stream output for ${timeoutMinutes} min — sent zero-token automatic Worker reminder`,
					});
					await this.persistEntry(entry);
					const worker = this.projects.getAgent(rState.workerAgentId);
					if (entry.activeWorkerRunTokens.has(node.id) && worker?.session) {
						alertPromises.push(
							this.commandService.executeCommand('aexus.agentEngines.nudgeSession', worker.session.resource, autoNudge).catch(() => undefined),
						);
					} else {
						void this.activateTaskNodeWorker(entry, node, { source: 'watchdog', feedback: autoNudge });
					}
					continue;
				}

				// Stage 2: Worker stayed unresponsive even after automatic reminder -> wake LLM Segment Manager for kill-restart / escalation!
				entry.state = {
					...entry.state,
					nodes: {
						...entry.state.nodes,
						[node.id]: {
							...rState,
							lastWatchdogAlertAt: now,
							watchdogRemindCount: prevRemindCount + 1,
						},
					},
				};
				this.appendEvent(entry, 'warn', 'watchdog.timeout_alert', {
					nodeId: node.id,
					segmentId: seg?.segmentId,
					detail: `Still silent after automatic reminder (${timeoutMinutes} min) — escalating to Manager`,
				});
				await this.persistEntry(entry);

				if (seg && rState.managerAgentId) {
					const alertPrompt = [
						`# Watchdog Timeout Alert — Worker Unresponsive on Node [${node.id}] ${node.title}`,
						`Active Worker (\`${rState.workerAgentId}\`) on segment \`${seg.segmentId}\` remained unresponsive for **${timeoutMinutes} minutes** even after an automatic Watchdog reminder.`,
						'',
						'## Recommended Manager Action (Spec 3.7)',
						'Inspect status or force kill-restart the deadlocked Worker subprocess:',
						`- **Force Kill & Restart Worker (Recommended)**: \`aexus-ade engineering watchdog-action --governor ${entry.governorSessionId} --node ${node.id} --action kill-restart --message "Continue task from current workspace state."\``,
						`- **Send Another Reminder**: \`aexus-ade engineering watchdog-action --governor ${entry.governorSessionId} --node ${node.id} --action remind --message "Please report progress or complete the current step."\``,
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
			this.updateNodeState(entry, node.id, fresh => ({
				...fresh,
				lastStreamActivityAt: Date.now(),
				lastWatchdogAlertAt: undefined,
				watchdogRemindCount: 0,
				workerTurnCount: 0,
			}));
			await this.persistEntry(entry);
			void this.activateTaskNodeWorker(entry, node, { source: 'watchdog', feedback: nudgeText });
			return this.buildSnapshot(entry);
		}

		// Default: 'remind'
		this.updateNodeState(entry, node.id, fresh => ({
			...fresh,
			lastStreamActivityAt: Date.now(),
			lastWatchdogAlertAt: undefined,
		}));
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
			if (!nodeId && targetAgent.role) {
				const slots = resolveRankWorkTreeSlots(this.getOrganizationConfig(), targetAgent.role);
				if (targetAgent.role === 'manager' || slots.includes('segment_owner')) {
					role = 'manager';
				} else if (targetAgent.role === 'employee' || slots.includes('reviewer')) {
					role = 'employee';
				}
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
