/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ADE_ENGINEERING_BACKEND_CHANNEL_NAME = 'adeEngineeringBackend';
export const ADE_ENGINEERING_DIR_NAME = 'engineering';
export const ADE_RESEARCH_DIR_NAME = 'research';
export const ADE_INBOX_FILE_NAME = 'inbox.json';
export const ADE_WATCHDOG_TIMEOUT_CONFIG_KEY = 'aexus.ade.engineering.watchdogTimeoutMinutes';
export const DEFAULT_WATCHDOG_TIMEOUT_MINUTES = 10;

/**
 * Top-level work tree category. Phase 1 implements `'engineering'`, while all
 * contracts, persistence paths, and sidebar tags reserve `'research'` for reuse.
 */
export type AdeWorkTreeType = 'engineering' | 'research';

export type AdeThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

export type AdeWorkspaceIsolationMode = 'shared' | 'worktree';

export type AdeEngineeringNodeType = 'task' | 'user_gate';

/**
 * Visual status matrix for DAG nodes (Spec 3.6):
 * - `pending`: Unstarted (slate gray)
 * - `running`: Active execution, including Employee internal rework loop (emerald green active)
 * - `completed`: Passed required reviews / user gate (emerald green completed)
 * - `failure_1`: 1st Manager formal rejection (light amber)
 * - `failure_2`: 2nd Manager formal rejection (deep amber)
 * - `failure_3`: 3rd Manager formal rejection — circuit broken (crimson red)
 */
export type AdeEngineeringNodeVisualStatus =
	| 'pending'
	| 'running'
	| 'completed'
	| 'failure_1'
	| 'failure_2'
	| 'failure_3';

/**
 * Fine-grained execution phase of a DAG node inside the state machine.
 */
export type AdeEngineeringNodePhase =
	| 'idle'
	| 'worker_running'
	| 'employee_review'
	| 'manager_review'
	| 'manager_escalation'
	| 'waiting_user_gate'
	| 'completed'
	| 'circuit_broken';

/**
 * Visual status matrix for DAG edges (Spec 3.6):
 * - `pending`: Solid gray
 * - `running`: Flowing animated green dashed line
 * - `completed`: Solid green
 * - `blocked`: Solid gray (failed / circuit-broken / blocked chain)
 */
export type AdeEngineeringEdgeVisualStatus =
	| 'pending'
	| 'running'
	| 'completed'
	| 'blocked';

export type AdeEngineeringRunStatus =
	| 'idle'
	| 'running'
	| 'paused'
	| 'waiting_gate'
	| 'circuit_broken'
	| 'completed';

export interface IAdeRoleModelConfig {
	readonly engine: string;
	readonly model?: string;
	readonly thinking: AdeThinkingLevel;
}

export interface IAdeNodeCanvasPosition {
	readonly x: number;
	readonly y: number;
}

export interface IAdeEngineeringBlueprintMetadata {
	readonly treeType: AdeWorkTreeType;
	readonly governorSessionId: string;
	readonly workspaceIsolation: AdeWorkspaceIsolationMode;
	readonly watchdogTimeoutMinutes: number;
	readonly flowDirection?: 'LR' | 'TD';
	/** Optional hard spend ceiling in USD; reaching it automatically pauses the DAG and posts an ADE Inbox alert. */
	readonly maxBudgetUsd?: number;
	/** Optional maximum number of concurrently executing task nodes (defaults to 4 in shared / 6 in worktree). */
	readonly maxConcurrency?: number;
	/** Optional default deterministic verification shell command run after Worker completion before LLM review. */
	readonly verify?: string;
	/** Optional recommended Organization Preset ID (e.g. 'default-4tier', 'security-audit', 'research-lab'). */
	readonly orgPreset?: string;
}

export interface IAdeEngineeringManagerSegment {
	readonly segmentId: string;
	readonly nodeIds: readonly string[];
	readonly config: IAdeRoleModelConfig;
}

export interface IAdeEngineeringBlueprintNode {
	readonly id: string;
	readonly title: string;
	readonly type: AdeEngineeringNodeType;
	readonly critical: boolean;
	readonly employee?: IAdeRoleModelConfig;
	readonly worker?: IAdeRoleModelConfig;
	readonly goal?: string;
	readonly acceptance?: string;
	readonly description?: string;
	/** Optional declared file/glob scope patterns for planning-time & runtime shared-workspace conflict avoidance. */
	readonly files?: readonly string[];
	/** Optional deterministic build/lint/test shell command run before waking Employee LLM review. */
	readonly verify?: string;
	readonly position?: IAdeNodeCanvasPosition;
}

export interface IAdeVerificationResult {
	readonly passed: boolean;
	readonly exitCode: number;
	readonly output: string;
	readonly durationMs: number;
}

export interface IAdeEngineeringBlueprintEdge {
	readonly from: string;
	readonly to: string;
	readonly label?: string;
}

export interface IAdeEngineeringBlueprint {
	readonly metadata: IAdeEngineeringBlueprintMetadata;
	readonly managers: readonly IAdeEngineeringManagerSegment[];
	readonly nodes: readonly IAdeEngineeringBlueprintNode[];
	readonly edges: readonly IAdeEngineeringBlueprintEdge[];
}

export interface IAdeIncrementalReportEntry {
	readonly nodeId: string;
	readonly nodeTitle: string;
	readonly summary: string;
	readonly updatedAt: number;
	readonly stale?: boolean;
}

export interface IAdeTouchedFileChange {
	readonly relativePath: string;
	readonly kind: 'added' | 'modified' | 'deleted';
	readonly afterSha1?: string;
	readonly diff?: string;
}

export interface IAdeWorkerTurnChanges {
	readonly capturedAt: number;
	readonly touchedFiles: readonly IAdeTouchedFileChange[];
	readonly combinedDiff: string;
	readonly truncated?: boolean;
}

export interface IAdeTokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly totalTokens: number;
	readonly turns: number;
	readonly durationMs: number;
	readonly costUsd?: number;
	readonly estimated?: boolean;
}

export interface IAdeNodeRoleTokenBreakdown {
	readonly worker: IAdeTokenUsage;
	readonly employee: IAdeTokenUsage;
	readonly manager: IAdeTokenUsage;
	readonly total: IAdeTokenUsage;
}

export interface IAdeTreeTokenUsageSummary {
	readonly governor: IAdeTokenUsage;
	readonly manager: IAdeTokenUsage;
	readonly employee: IAdeTokenUsage;
	readonly worker: IAdeTokenUsage;
	readonly total: IAdeTokenUsage;
}

export function createEmptyTokenUsage(): IAdeTokenUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		turns: 0,
		durationMs: 0,
	};
}

export function createEmptyNodeRoleTokenBreakdown(): IAdeNodeRoleTokenBreakdown {
	const z = createEmptyTokenUsage();
	return { worker: z, employee: z, manager: z, total: z };
}

export function createEmptyTreeTokenUsageSummary(): IAdeTreeTokenUsageSummary {
	const z = createEmptyTokenUsage();
	return { governor: z, manager: z, employee: z, worker: z, total: z };
}

export function normalizeTokenUsageDelta(raw: Partial<IAdeTokenUsage> | undefined, countTurn = true): IAdeTokenUsage {
	const inputTokens = Math.max(0, Math.round(Number(raw?.inputTokens) || 0));
	const outputTokens = Math.max(0, Math.round(Number(raw?.outputTokens) || 0));
	const cacheReadTokens = Math.max(0, Math.round(Number(raw?.cacheReadTokens) || 0));
	const cacheWriteTokens = Math.max(0, Math.round(Number(raw?.cacheWriteTokens) || 0));
	const computedTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
	const explicitTotal = Math.max(0, Math.round(Number(raw?.totalTokens) || 0));
	const totalTokens = Math.max(computedTotal, explicitTotal);
	const turns = raw?.turns !== undefined ? Math.max(0, Math.round(Number(raw.turns) || 0)) : (countTurn && totalTokens > 0 ? 1 : 0);
	const durationMs = Math.max(0, Math.round(Number(raw?.durationMs) || 0));
	const costUsd = typeof raw?.costUsd === 'number' && Number.isFinite(raw.costUsd) && raw.costUsd > 0 ? raw.costUsd : undefined;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens,
		turns,
		durationMs,
		...(costUsd !== undefined ? { costUsd } : {}),
		...(raw?.estimated ? { estimated: true } : {}),
	};
}

export function accumulateTokenUsage(base: IAdeTokenUsage | undefined, deltaRaw: Partial<IAdeTokenUsage> | undefined, countTurn = true): IAdeTokenUsage {
	const b = base ?? createEmptyTokenUsage();
	const d = normalizeTokenUsageDelta(deltaRaw, countTurn);
	if (d.totalTokens === 0 && d.turns === 0 && d.durationMs === 0) {
		return b;
	}
	const costSum = (b.costUsd ?? 0) + (d.costUsd ?? 0);
	return {
		inputTokens: b.inputTokens + d.inputTokens,
		outputTokens: b.outputTokens + d.outputTokens,
		cacheReadTokens: b.cacheReadTokens + d.cacheReadTokens,
		cacheWriteTokens: b.cacheWriteTokens + d.cacheWriteTokens,
		totalTokens: b.totalTokens + d.totalTokens,
		turns: b.turns + d.turns,
		durationMs: b.durationMs + d.durationMs,
		...(costSum > 0 ? { costUsd: Math.round(costSum * 1_000_000) / 1_000_000 } : {}),
		...((b.estimated || d.estimated) ? { estimated: Boolean(b.totalTokens === 0 ? d.estimated : (b.estimated && d.estimated)) } : {}),
	};
}

export function formatCompactTokenCount(tokens: number): string {
	const n = Math.max(0, Math.round(Number(tokens) || 0));
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
	}
	if (n >= 1_000) {
		return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
	}
	return String(n);
}

/**
 * CJK-aware fallback token estimator used only when an engine omits native usage telemetry.
 * CJK ideographs/kana/hangul/fullwidth symbols encode at ~1.0–1.5 tokens/char while ASCII/Latin
 * averages ~0.25 tokens/char; plain `length / 4` undercounts Chinese prompts by 3–4x.
 */
export function estimateTextTokens(text: string): number {
	if (!text) {
		return 0;
	}
	let cjkChars = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (
			(code >= 0x3000 && code <= 0x9FFF)
			|| (code >= 0xAC00 && code <= 0xD7AF)
			|| (code >= 0xF900 && code <= 0xFAFF)
			|| (code >= 0xFF00 && code <= 0xFFEF)
		) {
			cjkChars++;
		}
	}
	const nonCjkChars = text.length - cjkChars;
	return Math.max(1, Math.ceil(cjkChars * 1.15 + nonCjkChars / 4));
}

export interface IAdeEngineeringNodeRuntimeState {
	readonly nodeId: string;
	readonly phase: AdeEngineeringNodePhase;
	readonly completed: boolean;
	readonly employeeRejectCount: number;
	readonly formalFailureCount: number;
	readonly fourthChanceGranted?: boolean;
	readonly managerAgentId?: string;
	readonly employeeAgentId?: string;
	readonly workerAgentId?: string;
	readonly segmentId?: string;
	readonly lastWorkerOutput?: string;
	readonly lastEmployeeFeedback?: string;
	readonly lastManagerFeedback?: string;
	readonly lastGateFeedback?: string;
	readonly lastWatchdogAlertAt?: number;
	readonly lastStreamActivityAt?: number;
	readonly startedAt?: number;
	readonly completedAt?: number;
	readonly lastChanges?: IAdeWorkerTurnChanges;
	/** Cumulative diff from the node's initial baseline snapshot across all rework turns. */
	readonly cumulativeChanges?: IAdeWorkerTurnChanges;
	/** Number of Worker execution turns completed on the active session (0 on fresh or kill-restarted session). */
	readonly workerTurnCount?: number;
	/** Number of Employee review turns already dispatched on this node. */
	readonly employeeReviewCount?: number;
	/** Number of zero-token automatic Watchdog Worker nudges sent before escalating to LLM Manager. */
	readonly watchdogRemindCount?: number;
	/** Latest deterministic `verify` command summary (pass/fail output). */
	readonly lastVerifyOutput?: string;
	readonly tokenUsage?: IAdeNodeRoleTokenBreakdown;
}

export interface IAdeEngineeringEventLogEntry {
	readonly id: string;
	readonly timestamp: number;
	readonly level: 'info' | 'warn' | 'error';
	readonly nodeId?: string;
	readonly segmentId?: string;
	readonly event: string;
	readonly detail?: string;
}

export interface IAdeSegmentWorktreeInfo {
	readonly segmentId: string;
	readonly branchName: string;
	readonly worktreePath: string;
	readonly headCommit?: string;
}

export interface IAdeEngineeringTreeState {
	readonly treeType: AdeWorkTreeType;
	readonly governorSessionId: string;
	readonly projectPath: string;
	/** Canonical project URI (e.g. `file:///...`) used to guard non-local schemes such as `aexus-ssh://`. */
	readonly projectUri?: string;
	readonly runStatus: AdeEngineeringRunStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly managerAgentsBySegment: Readonly<Record<string, string>>;
	readonly nodes: Readonly<Record<string, IAdeEngineeringNodeRuntimeState>>;
	readonly reports: Readonly<Record<string, IAdeIncrementalReportEntry>>;
	readonly worktrees?: Readonly<Record<string, IAdeSegmentWorktreeInfo>>;
	readonly tokenUsage?: IAdeTreeTokenUsageSummary;
	readonly events: readonly IAdeEngineeringEventLogEntry[];
}

export interface IAdeEngineeringResolvedNodeStatus {
	readonly node: IAdeEngineeringBlueprintNode;
	readonly runtime: IAdeEngineeringNodeRuntimeState;
	readonly visualStatus: AdeEngineeringNodeVisualStatus;
	readonly segmentId?: string;
	readonly isSegmentTail: boolean;
	readonly report?: IAdeIncrementalReportEntry;
	readonly upstreamReports: readonly IAdeIncrementalReportEntry[];
}

export interface IAdeEngineeringResolvedEdgeStatus {
	readonly edge: IAdeEngineeringBlueprintEdge;
	readonly visualStatus: AdeEngineeringEdgeVisualStatus;
}

export interface IAdeEngineeringTreeSnapshot {
	readonly governorSessionId: string;
	readonly governorLabel: string;
	readonly projectPath: string;
	readonly projectName: string;
	readonly treeType: AdeWorkTreeType;
	readonly blueprintText: string;
	readonly blueprint: IAdeEngineeringBlueprint;
	readonly state: IAdeEngineeringTreeState;
	readonly nodes: readonly IAdeEngineeringResolvedNodeStatus[];
	readonly edges: readonly IAdeEngineeringResolvedEdgeStatus[];
	readonly progress: {
		readonly totalNodes: number;
		readonly completedNodes: number;
		readonly totalTasks: number;
		readonly completedTasks: number;
		readonly runningNodes: number;
		readonly failedNodes: number;
		readonly waitingGates: number;
	};
	readonly tokenUsage: IAdeTreeTokenUsageSummary;
}

export interface IAdeEngineeringTreeSummary {
	readonly governorSessionId: string;
	readonly governorLabel: string;
	readonly projectPath: string;
	readonly projectName: string;
	readonly treeType: AdeWorkTreeType;
	readonly runStatus: AdeEngineeringRunStatus;
	readonly workspaceIsolation: AdeWorkspaceIsolationMode;
	readonly managerCount: number;
	readonly totalNodes: number;
	readonly completedNodes: number;
	readonly runningNodes: number;
	readonly failedNodes: number;
	readonly waitingGates: number;
	readonly tokenUsage?: IAdeTokenUsage;
	readonly updatedAt: number;
}

export type AdeInboxItemKind = 'governor_message' | 'user_gate';

export type AdeInboxSenderRank = 'governor' | 'manager' | 'employee' | 'worker' | (string & {});

/**
 * Triage severity of an ADE Inbox item.
 * - `critical`: RED Circuit-Breaker trips and other run-halting escalations.
 * - `gate`: User Acceptance Gates awaiting a human decision.
 * - `info`: ordinary Governor updates.
 */
export type AdeInboxSeverity = 'critical' | 'gate' | 'info';

const ADE_INBOX_CIRCUIT_PATTERN = /circuit/i;

/**
 * Resolves the effective triage severity of an inbox item. Items persisted before
 * `severity` existed fall back to a `/circuit/i` title heuristic.
 */
export function resolveAdeInboxSeverity(item: Pick<IAdeInboxItem, 'kind' | 'title' | 'severity'>): AdeInboxSeverity {
	if (item.severity) {
		return item.severity;
	}
	if (item.kind === 'user_gate') {
		return 'gate';
	}
	return ADE_INBOX_CIRCUIT_PATTERN.test(item.title) ? 'critical' : 'info';
}

export interface IAdeInboxItem {
	readonly id: string;
	readonly kind: AdeInboxItemKind;
	readonly treeType: AdeWorkTreeType;
	readonly governorSessionId: string;
	readonly governorLabel: string;
	readonly projectPath: string;
	readonly projectName: string;
	readonly nodeId?: string;
	readonly nodeTitle?: string;
	readonly title: string;
	readonly message: string;
	readonly upstreamSummary?: string;
	readonly rollbackCandidates?: readonly { readonly id: string; readonly title: string }[];
	readonly unread: boolean;
	readonly resolved: boolean;
	readonly resolution?: string;
	readonly createdAt: number;
	readonly resolvedAt?: number;
	/** Optional triage severity; see {@link resolveAdeInboxSeverity} for the legacy fallback. */
	readonly severity?: AdeInboxSeverity;
	/** Optional sender rank for Inbox rank classification (defaults to `'governor'`). */
	readonly senderRank?: AdeInboxSenderRank;
	/** Optional sender agent session ID when distinct from `governorSessionId`. */
	readonly senderAgentId?: string;
}

export interface IAdeWorkspaceFileSnapshotEntry {
	readonly relativePath: string;
	readonly size: number;
	readonly mtimeMs: number;
	readonly sha1: string;
	readonly textPreview?: string;
}

export interface IAdeWorkspaceSnapshot {
	readonly rootPath: string;
	readonly capturedAt: number;
	readonly entries: Readonly<Record<string, IAdeWorkspaceFileSnapshotEntry>>;
	readonly truncated?: boolean;
	/** Present when snapshot was captured using Git-native dirty/untracked tracking instead of full directory scan. */
	readonly gitDirtyMode?: boolean;
	/** Repository HEAD SHA at snapshot capture time (empty string for unborn HEAD). */
	readonly gitHead?: string;
}

export interface IAdeStoredEngineeringRecord {
	readonly governorSessionId: string;
	readonly treeType: AdeWorkTreeType;
	readonly blueprintText: string;
	readonly state: IAdeEngineeringTreeState;
}

export const IAdeEngineeringBackendService = createDecorator<IAdeEngineeringBackendService>('adeEngineeringBackendService');

/**
 * Node-layer persistence, workspace snapshot/diff, and optional Git worktree sandbox service.
 * Persists exclusively under `~/.aexus-code/` so user project repositories stay 100% clean.
 */
export interface IAdeEngineeringBackendService {
	readonly _serviceBrand: undefined;

	listStoredTrees(treeType?: AdeWorkTreeType): Promise<readonly IAdeStoredEngineeringRecord[]>;
	loadTree(governorSessionId: string, treeType?: AdeWorkTreeType): Promise<IAdeStoredEngineeringRecord | undefined>;
	saveTree(record: IAdeStoredEngineeringRecord): Promise<void>;
	deleteTree(governorSessionId: string, treeType?: AdeWorkTreeType): Promise<void>;

	loadInbox(): Promise<readonly IAdeInboxItem[]>;
	saveInbox(items: readonly IAdeInboxItem[]): Promise<void>;

	captureWorkspaceSnapshot(cwd: string): Promise<IAdeWorkspaceSnapshot>;
	computeWorkerTurnChanges(
		cwd: string,
		before: IAdeWorkspaceSnapshot,
		ignoreSiblingSha1s?: Readonly<Record<string, string | null>>,
	): Promise<IAdeWorkerTurnChanges>;

	ensureSegmentWorktree(
		governorSessionId: string,
		projectPath: string,
		segmentId: string,
		upstreamBranches: readonly string[],
	): Promise<{
		readonly worktree: IAdeSegmentWorktreeInfo;
		readonly mergeConflict?: { readonly conflictedFiles: readonly string[]; readonly summary: string };
	}>;
	commitSegmentWorktree(worktreePath: string, message: string): Promise<string | undefined>;
	mergeSegmentsIntoProject(
		projectPath: string,
		branches: readonly string[],
	): Promise<{ readonly ok: boolean; readonly conflictedFiles: readonly string[]; readonly summary: string }>;
	cleanupTreeWorktrees(governorSessionId: string, projectPath: string, force?: boolean): Promise<void>;
	/** Runs an optional deterministic build/lint/test verification shell command before waking LLM review. */
	runNodeVerificationCommand?(cwd: string, command: string, timeoutMs?: number): Promise<IAdeVerificationResult>;
}

export interface IAdeInitEngineeringOptions {
	readonly governorSessionId: string;
	readonly treeType?: AdeWorkTreeType;
	readonly onChildren?: 'relocate' | 'delete';
	readonly relocateTargetParentId?: string;
}

export interface IAdeApplyBlueprintOptions {
	readonly governorSessionId: string;
	readonly blueprintText: string;
	readonly forceStopRunning?: boolean;
	/** Optional caller identity (e.g. `'user'`, `'secretary'`, or an agent rank ID) used by verify trust gating. */
	readonly caller?: string;
	/** Internal flag used only by zero-execution demo simulations or trusted internal re-serializations. */
	readonly trustedVerifyCommands?: boolean;
}

export interface IAdeEngineeringReviewParams {
	readonly governorSessionId: string;
	readonly nodeId: string;
	readonly role: 'employee' | 'manager';
	readonly verdict: 'pass' | 'reject' | 'guidance';
	readonly report?: string;
	readonly feedback?: string;
}

export interface IAdeEngineeringGateParams {
	readonly governorSessionId: string;
	readonly nodeId: string;
	readonly verdict: 'pass' | 'rollback';
	readonly targetNodeId?: string;
	readonly feedback?: string;
}

export interface IAdeEngineeringWatchdogActionParams {
	readonly governorSessionId: string;
	readonly nodeId: string;
	readonly action: 'remind' | 'kill-restart';
	readonly message?: string;
}

export interface IAdeEngineeringResetParams {
	readonly governorSessionId: string;
	readonly nodeId?: string;
	readonly keepCompleted?: boolean;
}

export interface IAdeEngineeringConfigureParams {
	readonly governorSessionId: string;
	readonly nodeId?: string;
	readonly role?: 'worker' | 'employee' | 'manager' | 'all';
	readonly engine?: string;
	readonly model?: string;
	readonly clearModel?: boolean;
	readonly thinking?: AdeThinkingLevel;
	readonly workspaceIsolation?: AdeWorkspaceIsolationMode;
	readonly maxBudgetUsd?: number;
	readonly clearBudget?: boolean;
	readonly forceStopRunning?: boolean;
}

export interface IAdeTrustedVerifyCommandEntry {
	readonly projectPath: string;
	readonly hash: string;
	readonly commandPreview?: string;
	readonly approvedAt?: number;
}

export const IAdeEngineeringService = createDecorator<IAdeEngineeringService>('adeEngineeringService');

export interface IAdeEngineeringService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeTree: Event<string | undefined>;

	whenReady(): Promise<void>;
	hasTree(governorSessionId: string): boolean;
	isAgentLockedByTree(agentId: string): boolean;
	getOwningGovernorId(agentId: string): string | undefined;
	getTreeType(governorSessionId: string): AdeWorkTreeType | undefined;

	listTrees(projectPath?: string, treeType?: AdeWorkTreeType): readonly IAdeEngineeringTreeSummary[];
	getTreeSnapshot(governorSessionId: string): IAdeEngineeringTreeSnapshot | undefined;
	getBlueprintText(governorSessionId: string): string | undefined;

	initTree(options: IAdeInitEngineeringOptions): Promise<IAdeEngineeringTreeSnapshot>;
	applyBlueprint(options: IAdeApplyBlueprintOptions): Promise<IAdeEngineeringTreeSnapshot>;
	configureTree(params: IAdeEngineeringConfigureParams): Promise<IAdeEngineeringTreeSnapshot>;
	resetTree(params: IAdeEngineeringResetParams): Promise<IAdeEngineeringTreeSnapshot>;
	removeTree(governorSessionId: string): Promise<void>;

	runTree(governorSessionId: string, caller?: 'user' | 'secretary' | string): Promise<IAdeEngineeringTreeSnapshot>;
	pauseTree(governorSessionId: string): Promise<IAdeEngineeringTreeSnapshot>;
	resumeTree(governorSessionId: string, caller?: 'user' | 'secretary' | string): Promise<IAdeEngineeringTreeSnapshot>;
	stopTree(governorSessionId: string): Promise<IAdeEngineeringTreeSnapshot>;

	submitReview(params: IAdeEngineeringReviewParams): Promise<IAdeEngineeringTreeSnapshot>;
	submitGateVerdict(params: IAdeEngineeringGateParams): Promise<IAdeEngineeringTreeSnapshot>;
	executeWatchdogAction(params: IAdeEngineeringWatchdogActionParams): Promise<IAdeEngineeringTreeSnapshot>;

	recordWorkerStreamHeartbeat(sessionResource: string, timestamp?: number): void;
	recordSessionTurnUsage(params: { readonly sessionResource?: string; readonly agentId?: string; readonly usage: Partial<IAdeTokenUsage> }): void;
	openEngineeringEditor(governorSessionId: string, options?: { side?: boolean }): Promise<void>;
	ensureNodeAgentSessionOpen(governorSessionId: string, nodeId: string, role?: 'worker' | 'employee' | 'manager', options?: { side?: boolean }): Promise<string | undefined>;
	mergeTreeWorktrees?(governorSessionId: string): Promise<{ readonly ok: boolean; readonly conflictedFiles: readonly string[]; readonly summary: string }>;
	cleanupTreeWorktrees?(governorSessionId: string): Promise<void>;
	startDemoSimulation?(governorSessionId: string): Promise<IAdeEngineeringTreeSnapshot>;
	isDemoSimulation?(governorSessionId: string): boolean;
	listTrustedVerifyCommands?(projectPath?: string): readonly IAdeTrustedVerifyCommandEntry[];
	revokeTrustedVerifyCommand?(projectPath: string, hash: string): boolean;
	revokeAllTrustedVerifyCommands?(projectPath?: string): number;
}

export const IAdeInboxService = createDecorator<IAdeInboxService>('adeInboxService');

export interface IAdeInboxService {
	readonly _serviceBrand: undefined;
	readonly items: readonly IAdeInboxItem[];
	readonly unreadCount: number;
	readonly onDidChange: Event<void>;

	list(options?: { unreadOnly?: boolean; governorSessionId?: string; includeResolved?: boolean }): readonly IAdeInboxItem[];
	postGovernorMessage(params: {
		readonly governorSessionId: string;
		readonly message: string;
		readonly title?: string;
		readonly nodeId?: string;
		readonly severity?: AdeInboxSeverity;
		readonly senderRank?: AdeInboxSenderRank;
		readonly senderAgentId?: string;
	}): Promise<IAdeInboxItem>;
	upsertUserGateTodo(params: {
		readonly governorSessionId: string;
		readonly treeType: AdeWorkTreeType;
		readonly nodeId: string;
		readonly nodeTitle: string;
		readonly description: string;
		readonly upstreamSummary: string;
		readonly rollbackCandidates: readonly { readonly id: string; readonly title: string }[];
	}): Promise<IAdeInboxItem>;
	/**
	 * Records that a RED Circuit-Breaker tripped on `nodeId`, so the Governor's next
	 * escalation for it is triaged as `critical`.
	 */
	noteCircuitBreakerTrip?(governorSessionId: string, nodeId: string): void;
	markRead(id?: string): Promise<void>;
	resolveItem(id: string, resolution?: string): Promise<IAdeInboxItem | undefined>;
	removeItemsForGovernor(governorSessionId: string): Promise<void>;
}
