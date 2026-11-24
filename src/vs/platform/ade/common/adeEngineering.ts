/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { IAdeDocsPaths } from './adeDocsCatalog.js';
import type { IMissionSourceTrigger, MissionRunStatus, MissionTokenStatus } from './adeMissionEngine.js';
import type { IAdeOrganizationConfig } from './adeRoleSchema.js';

export const ADE_ENGINEERING_BACKEND_CHANNEL_NAME = 'adeEngineeringBackend';
export const ADE_INBOX_FILE_NAME = 'inbox.json';

export type AdeWorkTreeType = 'engineering' | 'research' | 'mission';
export type AdeThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

export type AdeInboxItemKind = 'governor_message' | 'user_gate';
export type AdeInboxSenderRank = 'governor' | 'manager' | 'employee' | 'worker' | (string & {});
export type AdeInboxSeverity = 'critical' | 'gate' | 'info';

const ADE_INBOX_CIRCUIT_PATTERN = /circuit/i;

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
	readonly severity?: AdeInboxSeverity;
	readonly senderRank?: AdeInboxSenderRank;
	readonly senderAgentId?: string;
}

/**
 * CJK-aware token estimator used for previewing compiled role prompt sizes.
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

export interface IAdeApiDocReadResult {
	readonly ok: boolean;
	readonly target: string;
	readonly path?: string;
	readonly revision: number;
	readonly content?: string;
	readonly error?: string;
}

export function fnv1aHash32Hex(input: string, seed: number): string {
	let hash = seed >>> 0;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/**
 * Compact 64-bit content fingerprint (`<byteLen>:<h1><h2`) used for O(1) self-echo deduplication
 * without retaining full serialized JSON snapshots in memory.
 */
export function computeAdeStorageFingerprint(raw: string): string {
	const h1 = fnv1aHash32Hex(raw, 0x811c9dc5);
	const h2 = fnv1aHash32Hex(raw, 0x9e3779b9);
	return `${raw.length}:${h1}${h2}`;
}

/**
 * Deterministic filesystem-safe filename for per-Mission cold storage under `<adeHome>/missions/`.
 */
export function encodeAdeMissionStorageFileName(missionId: string): string {
	const trimmed = missionId.trim() || 'mission';
	const safeHead = trimmed.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 48) || 'mission';
	const h1 = fnv1aHash32Hex(trimmed, 0x811c9dc5);
	const h2 = fnv1aHash32Hex(`mission:${trimmed}`, 0x9e3779b9);
	return `${safeHead}-${h1}${h2.slice(0, 6)}.json`;
}

export interface IAdeMissionColdChangeEvent {
	readonly missionId: string;
	readonly updatedAt: number;
	readonly deleted?: boolean;
	readonly writerId?: string;
}

/**
 * Deterministic remote persistent session prefix shared identically with `extensions/aexus-agents/src/cloudTransport.ts`.
 */
export function buildAdeRemotePersistentPrefix(engineId: string, scopeOrSessionId: string): string {
	const normEngine = engineId.trim().toLowerCase().replace(/^aexus-/, '').replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'agent';
	const rawKey = scopeOrSessionId.trim() || 'session';
	const safeHead = rawKey.replace(/[^A-Za-z0-9]+/g, '').slice(0, 10) || 's';
	const h1 = fnv1aHash32Hex(rawKey, 0x811c9dc5);
	const h2 = fnv1aHash32Hex(`${normEngine}:${rawKey}`, 0x9e3779b9);
	const cleaned = `${normEngine}-${safeHead}-${h1}${h2.slice(0, 4)}`.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
	return (cleaned || 'session').slice(0, 64);
}

export interface IAdeWatchdogTokenSpec {
	readonly tokenId: string;
	readonly nodeId: string;
	readonly holderAgentId?: string;
	readonly status: MissionTokenStatus;
	readonly lastActivityAt: number;
	readonly lastNudgeAt?: number;
	/** Cloud host alias (`aexus-ssh` authority) when the token holder executes on a remote host. */
	readonly hostAlias?: string;
	/** Deterministic persistent session prefix (`buildAdeRemotePersistentPrefix`) for fast dead-session probing. */
	readonly remoteSessionPrefix?: string;
	readonly blocked?: {
		readonly reason: string;
		readonly startedAt: number;
		readonly maxDurationMs: number;
		readonly expiresAt: number;
		readonly watchPid?: number;
		readonly watchFile?: string;
		/** File mtime (ms on the target host's own clock) captured when blocked, or `null` if file did not exist yet (eliminates cross-host clock drift). */
		readonly initialFileMtime?: number | null;
		/** Optional sub-second/metadata file signature (`<mtimeMs>:<size>:<ino>`) for same-second overwrite detection. */
		readonly initialFileSignature?: string | null;
		readonly hostAlias?: string;
	};
}

export interface IAdeWatchdogBarrierSpec {
	readonly barrierId: string;
	readonly parentTokenId: string;
	readonly ownerNodeId: string;
	readonly ownerAgentId?: string;
	readonly deadlineAt: number;
}

export interface IAdeMissionWatchdogSnapshot {
	readonly missionId: string;
	readonly status: MissionRunStatus;
	readonly silenceTimeoutMinutes: number;
	readonly tokens: readonly IAdeWatchdogTokenSpec[];
	readonly triggers: readonly IMissionSourceTrigger[];
	/** Active orchestration join barriers with explicit deadlines monitored synchronously by Phase 1 watchdog ticks. */
	readonly barriers?: readonly IAdeWatchdogBarrierSpec[];
	/** Main-process IPC context (e.g. `window:<id>`) that currently owns watchdog execution for this Mission. */
	readonly ownerWindowCtx?: string;
	/** When true (e.g. passive window startup rehydration), keep any existing live owner instead of hijacking it. */
	readonly preserveExistingOwner?: boolean;
}

export interface IAdeWatchdogWakeupEvent {
	readonly missionId: string;
	readonly tokenId: string;
	readonly nodeId: string;
	readonly holderAgentId?: string;
	readonly reason: 'silence_timeout' | 'block_expired' | 'pid_exited' | 'file_ready' | 'agent_exited' | 'barrier_deadline_expired';
	readonly barrierId?: string;
	readonly detail?: string;
	readonly timestamp: number;
	readonly ownerWindowCtx?: string;
}

export interface IAdeMissionCheckpointMeta {
	readonly id: string;
	readonly missionId: string;
	readonly label?: string;
	readonly reason?: string;
	readonly createdBy?: string;
	readonly createdAt: number;
	readonly stateRevision: number;
	readonly activeTokenCount: number;
	readonly completedTaskCount: number;
	readonly totalCostUsd: number;
}

export interface IAdeSourceTriggerFireEvent {
	readonly missionId: string;
	readonly triggerId: string;
	readonly nodeId: string;
	readonly kind: IMissionSourceTrigger['kind'];
	readonly detail?: string;
	readonly timestamp: number;
	readonly ownerWindowCtx?: string;
}

export interface IAdeDeterministicCheckRequest {
	readonly checkId: string;
	readonly name?: string;
	readonly command?: string;
	readonly expectExitCode?: number;
	readonly cwd?: string;
	readonly hostAlias?: string;
	readonly expectFiles?: readonly string[];
	readonly expectOutputMatch?: string;
	readonly timeoutMs?: number;
}

export interface IAdeDeterministicCheckResponse {
	readonly checkId: string;
	readonly name?: string;
	readonly command?: string;
	readonly hostAlias: string;
	readonly cwd?: string;
	readonly passed: boolean;
	readonly exitCode: number;
	readonly expectedExitCode: number;
	readonly timedOut?: boolean;
	readonly durationMs: number;
	readonly missingFiles?: readonly string[];
	readonly outputMatchFailed?: boolean;
	readonly outputTail: string;
	readonly error?: string;
}

export type IAdeInboxMutation =
	| { readonly kind: 'upsert'; readonly item: IAdeInboxItem }
	| { readonly kind: 'markRead'; readonly id?: string }
	| { readonly kind: 'resolve'; readonly id: string; readonly resolution?: string; readonly resolvedAt: number }
	| { readonly kind: 'removeGovernor'; readonly governorSessionId: string };

export interface IAdeOrchestrationDaemonMissionSnapshot {
	readonly missionId: string;
	readonly status: 'running' | 'paused' | 'aborted';
	readonly activeTokenCount: number;
	readonly blockedTokenCount: number;
	readonly waitingJoinCount: number;
	readonly updatedAt: number;
	readonly pausedReason?: string;
	readonly ownerWindowCtx?: string;
}

export interface IAdeHeadlessControlResult {
	readonly handled: boolean;
	readonly result?: unknown;
	readonly error?: string;
}

export const IAdeEngineeringBackendService = createDecorator<IAdeEngineeringBackendService>('adeEngineeringBackendService');

/**
 * Node main-process backend for:
 * 1) Single-copy API docs sync & lazy read (`<adeHome>/docs/`)
 * 2) Lightweight Inbox JSON persistence (`<adeHome>/inbox.json`)
 * 3) Local Mission Watchdog Daemon & zero-token Source Trigger Monitor (local + remote SSH)
 * 4) Zero-token deterministic verification hooks (local + remote SSH)
 * 5) Cold per-Mission blob/archive storage & main-process headless Orchestration continuity
 */
export interface IAdeEngineeringBackendService {
	readonly _serviceBrand: undefined;
	readonly onDidWatchdogWakeup?: Event<IAdeWatchdogWakeupEvent>;
	readonly onDidSourceTriggerFire?: Event<IAdeSourceTriggerFireEvent>;
	readonly onDidInboxChange?: Event<readonly IAdeInboxItem[]>;
	/** Fired when a cold per-Mission file is saved or deleted under `<adeHome>/missions/`. */
	readonly onDidMissionRecordChange?: Event<IAdeMissionColdChangeEvent>;
	/** Fired when the OS resumes from sleep/suspend so renderer & extension host immediately heal SSH tunnels and reattach. */
	readonly onDidSystemResume?: Event<number>;

	loadInbox(): Promise<IAdeInboxItem[]>;
	saveInbox(items: readonly IAdeInboxItem[]): Promise<void>;
	mutateInbox?(mutation: IAdeInboxMutation): Promise<IAdeInboxItem[]>;
	loadMissionRecord?(missionId: string): Promise<string | undefined>;
	loadAllMissionRecords?(): Promise<Readonly<Record<string, string>>>;
	saveMissionRecord?(missionId: string, payloadJson: string, updatedAt: number, writerId?: string, expectedRevision?: number): Promise<void>;
	deleteMissionRecord?(missionId: string, writerId?: string): Promise<void>;
	saveMissionCheckpoint?(missionId: string, checkpointId: string, payloadJson: string, meta: IAdeMissionCheckpointMeta): Promise<void>;
	listMissionCheckpoints?(missionId: string): Promise<readonly IAdeMissionCheckpointMeta[]>;
	loadMissionCheckpoint?(missionId: string, checkpointId: string): Promise<string | undefined>;
	deleteMissionCheckpoint?(missionId: string, checkpointId: string): Promise<void>;
	saveOrchestrationBlobs?(missionId: string, blobs: readonly { readonly ptr: string; readonly payloadJson: string }[]): Promise<void>;
	readOrchestrationBlob?(missionId: string, ptr: string): Promise<string | undefined>;
	appendOrchestrationArchive?(missionId: string, lines: readonly string[]): Promise<void>;
	readOrchestrationArchive?(missionId: string, options?: { readonly limit?: number; readonly offset?: number }): Promise<readonly string[]>;
	syncOrchestrationDaemonState?(snapshot: IAdeOrchestrationDaemonMissionSnapshot): Promise<void>;
	getOrchestrationDaemonState?(missionId?: string): Promise<Readonly<Record<string, IAdeOrchestrationDaemonMissionSnapshot>>>;
	executeHeadlessOrchestrationControl?(action: string, params: Readonly<Record<string, unknown>>): Promise<IAdeHeadlessControlResult>;
	/** Tracks connected workbench renderer count so the main-process daemon persists headless watchdog transitions when 0 windows are open. */
	setActiveRendererWindowCount?(count: number): void;
	/** Tracks individual live renderer IPC contexts so multi-window ownership checks know which owner windows are alive. */
	registerLiveRendererContext?(ctxKey: string): void;
	unregisterLiveRendererContext?(ctxKey: string): void;
	/** Returns true when a 0-window watchdog wakeup is handled headlessly by the main-process daemon and must not also be queued in IPC pending buffers. */
	willHandleWatchdogWakeupHeadlessly?(ev: IAdeWatchdogWakeupEvent): boolean;
	/** Revokes live session capability tokens / headless control authority when a session is archived, deleted, or demoted. */
	revokeSession?(sessionId: string): Promise<void>;
	syncApiDocs?(config: IAdeOrganizationConfig): Promise<IAdeDocsPaths>;
	getApiDocsPaths?(rankCount: number): Promise<IAdeDocsPaths>;
	readApiDoc?(target: string, config?: IAdeOrganizationConfig): Promise<IAdeApiDocReadResult>;
	syncMissionWatchdog?(snapshot: IAdeMissionWatchdogSnapshot): Promise<void>;
	removeMissionWatchdog?(missionId: string): Promise<void>;
	/** Returns false only when another currently live window owns this Mission's watchdog, preventing multi-window duplicate auto-recovery. */
	canRecoverMission?(missionId: string): Promise<boolean>;
	notifySystemResume?(): Promise<void>;
	probeFileMtime?(hostAlias: string, filePath: string): Promise<number | null>;
	probeFileSignature?(hostAlias: string, filePath: string): Promise<string | null>;
	runDeterministicCheck?(request: IAdeDeterministicCheckRequest): Promise<IAdeDeterministicCheckResponse>;
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
	upsertUserGateTodo?(params: {
		readonly governorSessionId: string;
		readonly treeType: AdeWorkTreeType;
		readonly nodeId: string;
		readonly nodeTitle: string;
		readonly description: string;
		readonly upstreamSummary: string;
		readonly rollbackCandidates: readonly { readonly id: string; readonly title: string }[];
	}): Promise<IAdeInboxItem>;
	markRead(id?: string): Promise<void>;
	resolveItem(id: string, resolution?: string): Promise<IAdeInboxItem | undefined>;
	removeItemsForGovernor(governorSessionId: string): Promise<void>;
}
