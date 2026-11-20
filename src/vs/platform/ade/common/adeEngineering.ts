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

export interface IAdeWatchdogTokenSpec {
	readonly tokenId: string;
	readonly nodeId: string;
	readonly holderAgentId?: string;
	readonly status: MissionTokenStatus;
	readonly lastActivityAt: number;
	readonly lastNudgeAt?: number;
	readonly blocked?: {
		readonly reason: string;
		readonly startedAt: number;
		readonly maxDurationMs: number;
		readonly expiresAt: number;
		readonly watchPid?: number;
		readonly watchFile?: string;
		readonly hostAlias?: string;
	};
}

export interface IAdeMissionWatchdogSnapshot {
	readonly missionId: string;
	readonly status: MissionRunStatus;
	readonly silenceTimeoutMinutes: number;
	readonly tokens: readonly IAdeWatchdogTokenSpec[];
	readonly triggers: readonly IMissionSourceTrigger[];
}

export interface IAdeWatchdogWakeupEvent {
	readonly missionId: string;
	readonly tokenId: string;
	readonly nodeId: string;
	readonly holderAgentId?: string;
	readonly reason: 'silence_timeout' | 'block_expired' | 'pid_exited' | 'file_ready';
	readonly detail?: string;
	readonly timestamp: number;
}

export interface IAdeSourceTriggerFireEvent {
	readonly missionId: string;
	readonly triggerId: string;
	readonly nodeId: string;
	readonly kind: IMissionSourceTrigger['kind'];
	readonly detail?: string;
	readonly timestamp: number;
}

export const IAdeEngineeringBackendService = createDecorator<IAdeEngineeringBackendService>('adeEngineeringBackendService');

/**
 * Node main-process backend for:
 * 1) Single-copy API docs sync & lazy read (`<adeHome>/docs/`)
 * 2) Lightweight Inbox JSON persistence (`<adeHome>/inbox.json`)
 * 3) Local Mission Watchdog Daemon & zero-token Source Trigger Monitor (local + remote SSH)
 */
export interface IAdeEngineeringBackendService {
	readonly _serviceBrand: undefined;
	readonly onDidWatchdogWakeup?: Event<IAdeWatchdogWakeupEvent>;
	readonly onDidSourceTriggerFire?: Event<IAdeSourceTriggerFireEvent>;

	loadInbox(): Promise<IAdeInboxItem[]>;
	saveInbox(items: readonly IAdeInboxItem[]): Promise<void>;
	syncApiDocs?(config: IAdeOrganizationConfig): Promise<IAdeDocsPaths>;
	getApiDocsPaths?(rankCount: number): Promise<IAdeDocsPaths>;
	readApiDoc?(target: string, config?: IAdeOrganizationConfig): Promise<IAdeApiDocReadResult>;
	syncMissionWatchdog?(snapshot: IAdeMissionWatchdogSnapshot): Promise<void>;
	removeMissionWatchdog?(missionId: string): Promise<void>;
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
