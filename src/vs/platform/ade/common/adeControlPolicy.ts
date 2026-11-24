/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMissionDagParseResult, IMissionNodeCheckHook } from './adeMissionDag.js';
import {
	AEXUS_PREAMBLE_END_MARKER,
	AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER,
	wrapRoleDirectMessageEnvelope,
	wrapUserDirectMessageEnvelope,
} from './adeMessageEnvelope.js';
import { parseDurationMs } from './adeMissionEngine.js';
import { IOrchestrationCheckpointSnapshot } from './adeOrchestrationCheckpoints.js';
import { IOrchestrationGraphParseResult } from './adeOrchestrationGraph.js';
import {
	IMissionTaskStatusRecord,
	IOrchestrationJoinBarrier,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationWhiteboard,
	isHighestRankTaskCompleter,
	resolveEffectiveStaffTier,
} from './adeOrchestrationTypes.js';
import { ADE_LIVE_ROLE_BINDINGS_HEADING, IAdeOrganizationConfig } from './adeRoleSchema.js';

const STRICT_EXECUTIVE_DEPT_RE = /^(?:executive|hq|headquarters|leadership|company|all|root|管理层|高管|总部|决策层|总办|公司)$/i;

/**
 * Strict company-wide executive department check for control-plane authorization.
 * Unlike legacy heuristics, an empty/unassigned department (`undefined` or `""`)
 * or `'General'` NEVER grants company-wide executive administrative authority.
 */
export function isStrictCompanyWideExecutiveDept(dept: string | undefined): boolean {
	const clean = dept?.trim();
	return Boolean(clean && STRICT_EXECUTIVE_DEPT_RE.test(clean));
}

export interface IAdeMissionMembershipInput {
	readonly missionId: string;
	readonly isHumanUser?: boolean;
	readonly isSecretary?: boolean;
	readonly callerSessionId?: string;
	readonly callerTreeGovernorId?: string;
	readonly callerTreeNodeId?: string;
	readonly ownerSessionId?: string;
	readonly supervisorIds?: readonly string[];
	readonly nodeAssignmentAgentIds?: readonly string[];
	readonly orchNodeAgentIds?: Readonly<Record<string, string>>;
}

/**
 * Enforces strict multi-tenant mission membership.
 * Human (`L-1`) and Secretary (`L0`) hold global macro authority; all other callers (`L1..LN`)
 * MUST explicitly belong to this Mission (owner, bound supervisor, node assignee, orchestration staff,
 * or verified `treeGovernorId` member) BEFORE any rank-tier privilege is evaluated.
 */
export function isExplicitMissionMemberOrSupervisor(input: IAdeMissionMembershipInput): boolean {
	if (input.isHumanUser || input.isSecretary) {
		return true;
	}
	const sid = input.callerSessionId?.trim();
	if (!sid) {
		return false;
	}
	if (input.ownerSessionId && input.ownerSessionId === sid) {
		return true;
	}
	if (input.supervisorIds?.includes(sid)) {
		return true;
	}
	if (input.nodeAssignmentAgentIds?.includes(sid)) {
		return true;
	}
	if (input.orchNodeAgentIds && Object.values(input.orchNodeAgentIds).includes(sid)) {
		return true;
	}
	if (
		input.callerTreeNodeId
		&& input.callerTreeGovernorId
		&& (input.callerTreeGovernorId === input.missionId || (input.ownerSessionId && input.callerTreeGovernorId === input.ownerSessionId))
	) {
		return true;
	}
	return false;
}

/**
 * Single source of truth for pure-execution in-graph Engineering / Mission staff capability actions
 * shared identically across `AdeControlServer`, renderer `adeControlHandler`, and headless `adeDocsBackendService`.
 */
export const ADE_PURE_MISSION_NODE_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
	'whoami',
	'docs.read',
	'rank.docs',
	'mission.docs',
	'api.update',
	'rank.names',
	'rank.list',
	'rank.get',
	'token.current',
	'token.trace',
	'token.read',
	'token.history',
	'token.handoff',
	'token.return',
	'token.complete',
	'token.reject',
	'token.block',
	'token.fail',
	'mission.task.list',
	'mission.task.get',
	'mission.check.list',
	'mission.check.get',
	'mission.check.run',
	'mission.diagnostics',
	'mission.checkpoint.list',
	'mission.checkpoint.diff',
	'orchestration.checkpoint.list',
	'orchestration.checkpoint.diff',
	'orchestration.get',
	'orchestration.status',
	'orchestration.validate',
	'whiteboard.list',
	'whiteboard.read',
	'whiteboard.write',
	'org.escalate',
]);

/**
 * Actions permitted for any bound Mission / Orchestration member (including read-only `orchestration.limits`
 * queries handled separately when no mutating parameters are provided).
 */
export const ADE_IN_GRAPH_UNIVERSAL_ACTIONS: ReadonlySet<string> = ADE_PURE_MISSION_NODE_ALLOWED_ACTIONS;

/**
 * Scoped supervisory actions permitted for bound non-pure supervisory staff / partial-jurisdiction supervisors.
 */
export const ADE_PARTIAL_SUPERVISOR_MISSION_ACTIONS: ReadonlySet<string> = new Set([
	'mission.get',
	'mission.blueprint.get',
	'mission.status',
	'mission.diagnostics',
	'mission.boundary.get',
	'mission.checkpoint.list',
	'mission.checkpoint.diff',
	'orchestration.checkpoint.list',
	'orchestration.checkpoint.diff',
	'mission.recall',
	'mission.retry',
	'token.retry',
	'token.mint',
	'token.split',
	'mission.patch',
	'mission.trigger.list',
	'mission.host.bind',
	'mission.check.list',
	'mission.check.get',
	'mission.check.set',
	'mission.check.remove',
	'mission.check.run',
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
	'mission.export',
	'orchestration.get',
	'orchestration.export',
	'orchestration.validate',
	'orchestration.status',
	'orchestration.group.list',
	'orchestration.staff.create',
	'orchestration.staff.configure',
	'orchestration.staff.remove',
	'whiteboard.list',
	'whiteboard.create',
	'whiteboard.read',
	'whiteboard.write',
	'whiteboard.rename',
	'whiteboard.remove',
	'org.escalate',
]);

/**
 * Full-jurisdiction / Mission-owner / Top-rank (L1) orchestration lifecycle control actions.
 */
export const ADE_FULL_SUPERVISOR_MISSION_ACTIONS: ReadonlySet<string> = new Set([
	'mission.open',
	'mission.rename',
	'mission.blueprint.apply',
	'mission.setMermaid',
	'mission.trigger.set',
	'mission.trigger.remove',
	'mission.checkpoint.create',
	'mission.checkpoint.restore',
	'orchestration.checkpoint.create',
	'orchestration.checkpoint.restore',
	'mission.start',
	'mission.run',
	'mission.pause',
	'mission.resume',
	'mission.stop',
	'mission.timeout.set',
	'mission.budget.set',
	'orchestration.apply',
	'orchestration.import',
	'orchestration.load',
	'orchestration.layout.set',
	'orchestration.dispatch',
	'orchestration.pause',
	'orchestration.resume',
	'orchestration.abort',
	'orchestration.limits',
	'orchestration.group.create',
	'orchestration.group.rename',
	'orchestration.group.assign',
	'orchestration.group.remove',
	'orchestration.staff.rename',
	'orchestration.staff.remove',
	'orchestration.edge.connect',
	'orchestration.edge.label',
	'orchestration.edge.remove',
	'whiteboard.rename',
	'whiteboard.remove',
]);

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Validates an optional client-supplied idempotency key (`1..128` `[A-Za-z0-9._:-]+`).
 */
export function validateIdempotencyKey(raw: unknown): { readonly ok: true; readonly key?: string } | { readonly ok: false; readonly error: string } {
	if (raw === undefined || raw === null || raw === '') {
		return { ok: true };
	}
	if (typeof raw !== 'string') {
		return { ok: false, error: 'INVALID_IDEMPOTENCY_KEY: idempotencyKey must be a string (1..128 chars, [A-Za-z0-9._:-]+).' };
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		return { ok: true };
	}
	if (!IDEMPOTENCY_KEY_RE.test(trimmed)) {
		return { ok: false, error: `INVALID_IDEMPOTENCY_KEY: "${trimmed.slice(0, 32)}" must match /^[A-Za-z0-9._:-]{1,128}$/.` };
	}
	return { ok: true, key: trimmed };
}

/**
 * Deterministically serializes an arbitrary JSON-compatible value with sorted object keys
 * (excluding volatile transport-only keys) for SHA-256 idempotency conflict detection.
 */
export function canonicalizeJsonForHash(value: unknown, omitKeys?: ReadonlySet<string>): string {
	if (value === null || value === undefined) {
		return 'null';
	}
	if (typeof value !== 'object') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(v => canonicalizeJsonForHash(v, omitKeys)).join(',')}]`;
	}
	const rec = value as Record<string, unknown>;
	const keys = Object.keys(rec)
		.filter(k => rec[k] !== undefined && !(omitKeys?.has(k)))
		.sort();
	return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalizeJsonForHash(rec[k], omitKeys)}`).join(',')}}`;
}

/**
 * Strips `%% wb-body <id> ... %% wb-end` blocks from Orchestration Mermaid source for any
 * whiteboard ID not present in `allowedWhiteboardIds`, preventing cross-department exfiltration
 * through raw `orchestration.get`, `orchestration.export`, or `mission.export` responses.
 * Stays strictly in skipping mode until `%% wb-end` (or a new `%% wb-body` header) so blank or
 * unprefixed lines inside a foreign block can NEVER leak out.
 */
export function stripForeignWhiteboardBodiesFromOrchestrationText(
	rawText: string | undefined,
	allowedWhiteboardIds: ReadonlySet<string>,
): string {
	if (!rawText) {
		return '';
	}
	const lines = rawText.split(/\r?\n/);
	const out: string[] = [];
	let skippingBody = false;
	for (const line of lines) {
		const trimmed = line.trim();
		const bodyStart = trimmed.match(/^%%\s*wb-body\s+([^\s]+)(?:\s|$)/i);
		if (skippingBody) {
			if (/^%%\s*wb-end\b/i.test(trimmed)) {
				skippingBody = false;
				continue;
			}
			if (bodyStart) {
				const wbId = bodyStart[1].trim();
				if (allowedWhiteboardIds.has(wbId)) {
					skippingBody = false;
					out.push(line);
				}
				continue;
			}
			continue;
		}
		if (bodyStart) {
			const wbId = bodyStart[1].trim();
			if (!allowedWhiteboardIds.has(wbId)) {
				skippingBody = true;
				continue;
			}
		}
		out.push(line);
	}
	return out.join('\n');
}

/**
 * Canonical deterministic check hook resolution shared identically by headless and renderer paths.
 * Merge precedence (highest wins on identical check `id`):
 *   1. Record-level explicit `nodeChecks[nodeId]` (`mission.check.set`)
 *   2. Inline Orchestration `staffNode.checks`
 *   3. Inline Mission DAG `dagNode.checks`
 */
export function resolveMergedNodeCheckHooks(params: {
	readonly nodeIds: readonly string[];
	readonly recordNodeChecks?: Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
	readonly parsedOrch?: IOrchestrationGraphParseResult;
	readonly parsedDag?: IMissionDagParseResult;
	readonly onlyEnabled?: boolean;
}): readonly IMissionNodeCheckHook[] {
	const onlyEnabled = params.onlyEnabled ?? true;
	const byId = new Map<string, IMissionNodeCheckHook>();
	const order: string[] = [];

	const upsert = (hook: IMissionNodeCheckHook) => {
		if (!hook || !hook.id) {
			return;
		}
		if (!byId.has(hook.id)) {
			order.push(hook.id);
		}
		byId.set(hook.id, hook);
	};

	const uniqueNodeIds = [...new Set(params.nodeIds.map(n => n.trim()).filter(Boolean))];
	for (const nid of uniqueNodeIds) {
		const dagNode = params.parsedDag?.nodes.find(n => n.id === nid);
		for (const h of dagNode?.checks ?? []) {
			upsert(h);
		}
		const staffNode = params.parsedOrch?.nodes.find(n => n.id === nid && n.kind === 'staff');
		for (const h of staffNode?.checks ?? []) {
			upsert(h);
		}
		for (const h of params.recordNodeChecks?.[nid] ?? []) {
			upsert(h);
		}
	}

	const result: IMissionNodeCheckHook[] = [];
	for (const id of order) {
		const hook = byId.get(id);
		if (!hook) {
			continue;
		}
		if (onlyEnabled && hook.enabled === false) {
			continue;
		}
		result.push(hook);
	}
	return result;
}

export interface ICompactOrchestrationTokenView {
	readonly id: string;
	readonly waveId: string;
	readonly nodeId: string;
	readonly fromNodeId?: string;
	readonly holderAgentId?: string;
	readonly status: IOrchestrationToken['status'];
	readonly parentTokenId?: string;
	readonly rootTokenId?: string;
	readonly originNodeId?: string;
	readonly returnToNodeId?: string;
	readonly dispatchKind?: IOrchestrationToken['dispatchKind'];
	readonly joinBarrierId?: string;
	readonly parentJoinBarrierId?: string;
	readonly childTokenIds?: readonly string[];
	readonly taskNodeId?: string;
	readonly taskNodeIds?: readonly string[];
	readonly hopIndex?: number;
	readonly lastSummary: string;
	readonly payloadPtr?: string;
	readonly contextRefs?: IOrchestrationToken['contextRefs'];
	readonly whiteboardPointers?: IOrchestrationToken['whiteboardPointers'];
	readonly tracePtr: string;
	readonly arrivedAt: number;
	readonly lastActivityAt: number;
	readonly nudgeCount: number;
	readonly blocked?: IOrchestrationToken['blocked'];
	readonly failureReason?: string;
	readonly rejectionReason?: string;
	readonly delta?: unknown;
	readonly joinBarrier?: unknown;
}

/**
 * Projects an Orchestration baton token into a context-lean summary by default (omitting bulky
 * `hopLog`, `compressedHistory`, and `historyState` unless `full === true`).
 */
export function projectOrchestrationTokenView(
	tok: IOrchestrationToken,
	options?: { readonly full?: boolean; readonly delta?: unknown; readonly joinBarrier?: unknown },
): IOrchestrationToken | ICompactOrchestrationTokenView {
	if (options?.full) {
		return {
			...tok,
			...(options.delta !== undefined ? { delta: options.delta } : {}),
			...(options.joinBarrier !== undefined ? { joinBarrier: options.joinBarrier } : {}),
		};
	}
	const summary = typeof tok.lastSummary === 'string' && tok.lastSummary.length > 200
		? `${tok.lastSummary.slice(0, 197)}...`
		: tok.lastSummary;
	return {
		id: tok.id,
		waveId: tok.waveId,
		nodeId: tok.nodeId,
		...(tok.fromNodeId ? { fromNodeId: tok.fromNodeId } : {}),
		...(tok.holderAgentId ? { holderAgentId: tok.holderAgentId } : {}),
		status: tok.status,
		...(tok.parentTokenId ? { parentTokenId: tok.parentTokenId } : {}),
		...(tok.rootTokenId ? { rootTokenId: tok.rootTokenId } : {}),
		...(tok.originNodeId ? { originNodeId: tok.originNodeId } : {}),
		...(tok.returnToNodeId ? { returnToNodeId: tok.returnToNodeId } : {}),
		...(tok.dispatchKind ? { dispatchKind: tok.dispatchKind } : {}),
		...(tok.joinBarrierId ? { joinBarrierId: tok.joinBarrierId } : {}),
		...(tok.parentJoinBarrierId ? { parentJoinBarrierId: tok.parentJoinBarrierId } : {}),
		...(tok.childTokenIds && tok.childTokenIds.length > 0 ? { childTokenIds: tok.childTokenIds } : {}),
		...(tok.taskNodeId ? { taskNodeId: tok.taskNodeId } : {}),
		...(tok.taskNodeIds && tok.taskNodeIds.length > 0 ? { taskNodeIds: tok.taskNodeIds } : {}),
		...(tok.hopIndex !== undefined ? { hopIndex: tok.hopIndex } : {}),
		lastSummary: summary,
		...(tok.payloadPtr ? { payloadPtr: tok.payloadPtr } : {}),
		...(tok.contextRefs && tok.contextRefs.length > 0 ? { contextRefs: tok.contextRefs } : {}),
		...(tok.whiteboardPointers && tok.whiteboardPointers.length > 0 ? { whiteboardPointers: tok.whiteboardPointers } : {}),
		tracePtr: tok.tracePtr,
		arrivedAt: tok.arrivedAt,
		lastActivityAt: tok.lastActivityAt,
		nudgeCount: tok.nudgeCount,
		...(tok.blocked ? { blocked: tok.blocked } : {}),
		...(tok.failureReason ? { failureReason: tok.failureReason } : {}),
		...(tok.rejectionReason ? { rejectionReason: tok.rejectionReason } : {}),
		...(options?.delta !== undefined ? { delta: options.delta } : {}),
		...(options?.joinBarrier !== undefined ? { joinBarrier: options.joinBarrier } : {}),
	};
}

export function projectJoinBarrierSummary(barrier: IOrchestrationJoinBarrier, full = false): Record<string, unknown> {
	const settledCount = Object.keys(barrier.settledChildren ?? {}).length;
	if (full) {
		return {
			...barrier,
			settledCount,
			totalChildren: barrier.childTokenIds.length,
		};
	}
	return {
		id: barrier.id,
		parentTokenId: barrier.parentTokenId,
		ownerNodeId: barrier.ownerNodeId,
		mode: barrier.mode,
		status: barrier.status,
		settledCount,
		totalChildren: barrier.childTokenIds.length,
		pendingChildIds: barrier.childTokenIds.filter(cid => !Object.prototype.hasOwnProperty.call(barrier.settledChildren ?? {}, cid)),
	};
}

/**
 * Unified `orchestration.status` response builder guaranteeing 100% schema parity across
 * headless main-process daemon and live workbench renderer, while staying context-lean by default.
 */
export function buildUnifiedOrchestrationStatusResponse(params: {
	readonly missionId: string;
	readonly title?: string;
	readonly state: IOrchestrationRuntimeState;
	readonly staffCount?: number;
	readonly headless?: boolean;
	readonly full?: boolean;
}): Record<string, unknown> {
	const { missionId, title, state, headless, full = false } = params;
	const allTokens = Object.values(state.tokens ?? {});
	const activeTokensRaw = allTokens.filter(t => t.status === 'active');
	const blockedTokensRaw = allTokens.filter(t => t.status === 'blocked');
	const waitingJoinRaw = allTokens.filter(t => t.status === 'waiting_join');
	const liveTokensRaw = allTokens.filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join');
	const barriers = Object.values(state.joinBarriers ?? {});
	const openBarriers = barriers.filter(b => b.status === 'waiting');

	const compactTokenSummary = (t: IOrchestrationToken) => full
		? t
		: {
			id: t.id,
			waveId: t.waveId,
			nodeId: t.nodeId,
			...(t.fromNodeId ? { fromNodeId: t.fromNodeId } : {}),
			status: t.status,
			...(t.hopIndex !== undefined ? { hopIndex: t.hopIndex } : {}),
			...(t.taskNodeId ? { taskNodeId: t.taskNodeId } : {}),
			...(t.taskNodeIds && t.taskNodeIds.length > 0 ? { taskNodeIds: t.taskNodeIds } : {}),
			...(t.joinBarrierId ? { joinBarrierId: t.joinBarrierId } : {}),
			lastSummary: typeof t.lastSummary === 'string' && t.lastSummary.length > 160
				? `${t.lastSummary.slice(0, 157)}...`
				: t.lastSummary,
			...(t.blocked?.reason ? { blockedReason: t.blocked.reason } : {}),
			...(t.nudgeCount > 0 ? { nudgeCount: t.nudgeCount } : {}),
		};

	const displayedTokens = (full ? allTokens : liveTokensRaw).map(compactTokenSummary);

	const projectedBarriers: Record<string, Record<string, unknown>> = {};
	for (const b of (full ? barriers : openBarriers)) {
		projectedBarriers[b.id] = projectJoinBarrierSummary(b, full);
	}

	return {
		missionId,
		...(title ? { title } : {}),
		status: state.status ?? 'running',
		...(headless ? { headless: true } : {}),
		...(state.pausedAt !== undefined ? { pausedAt: state.pausedAt } : {}),
		...(state.pausedReason ? { pausedReason: state.pausedReason } : {}),
		...(params.staffCount !== undefined ? { staffCount: params.staffCount } : {}),
		activeTokenCount: activeTokensRaw.length,
		activeCount: activeTokensRaw.length,
		blockedTokenCount: blockedTokensRaw.length,
		blockedCount: blockedTokensRaw.length,
		waitingJoinCount: waitingJoinRaw.length,
		openJoinBarriers: openBarriers.length,
		totalTokens: allTokens.length,
		...(state.maxHops !== undefined ? { maxHops: state.maxHops } : {}),
		...(state.budgetLimitUsd !== undefined ? { budgetLimitUsd: state.budgetLimitUsd } : {}),
		...(state.totalCostUsd !== undefined ? { totalCostUsd: state.totalCostUsd } : {}),
		...(state.budgetCircuitTripped ? { budgetCircuitTripped: true } : {}),
		nodeStates: state.nodeStates ?? {},
		tokens: displayedTokens,
		joinBarriers: projectedBarriers,
		...(state.archivedTokenCount ? { archivedTokenCount: state.archivedTokenCount } : {}),
		...(state.archivedTraceCount ? { archivedTraceCount: state.archivedTraceCount } : {}),
		...(state.externalizedBlobIndex && Object.keys(state.externalizedBlobIndex).length > 0
			? { externalizedBlobCount: Object.keys(state.externalizedBlobIndex).length }
			: {}),
		updatedAt: state.updatedAt,
	};
}

const ORG_CONTEXT_PREAMBLE_HEADERS: readonly string[] = [
	'[Aexus Orchestrated Role Context]',
	'[Aexus Orchestrated Role Context Updated]',
	'[Aexus ADE · Engineering Staff Context]',
	'[Aexus ADE · Mission Node Employee]',
	'[Aexus ADE Live Viewport & Macro Control Context]',
	'[ADE Live Viewport State]',
	'[ADE Live Hierarchy State]',
	'[Autonomous Session Goal Active]',
	AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER,
];

const ORG_CONTEXT_LIVE_TAIL_HEADERS: readonly string[] = [
	ADE_LIVE_ROLE_BINDINGS_HEADING,
	'### Live Workspace Snapshot',
	'### Live Viewport Snapshot',
	'- Live Viewport Snapshot:',
];

/**
 * Strips injected `[Aexus ...]` system preambles (including `<!-- /AEXUS_ADE_PREAMBLE -->`
 * sentinel blocks and multi-paragraph headers) from historical messages surfaced in `org.context`
 * and caps per-message length unless `full === true`.
 *
 * Assistant messages are NEVER preamble-stripped (only length-capped when `!full`).
 */
export function sanitizeOrgContextMessage(rawText: string, full = false, maxChars = 400, role?: string): string {
	let cleaned = rawText ?? '';
	if (!full) {
		const isAssistant = typeof role === 'string' && role.trim().toLowerCase() === 'assistant';
		if (!isAssistant) {
			// Peel sentinel-terminated ADE preamble blocks strictly from the front using indexOf
			// (never lastIndexOf, which would truncate user messages quoting the sentinel).
			while (true) {
				const trimmedStart = cleaned.trimStart();
				if (!ORG_CONTEXT_PREAMBLE_HEADERS.some(h => trimmedStart.startsWith(h))) {
					break;
				}
				const sentinelIdx = cleaned.indexOf(AEXUS_PREAMBLE_END_MARKER);
				if (sentinelIdx < 0) {
					break;
				}
				const afterSentinel = cleaned.slice(sentinelIdx + AEXUS_PREAMBLE_END_MARKER.length).trimStart();
				if (!afterSentinel) {
					break;
				}
				cleaned = afterSentinel;
			}
			const lines = cleaned.split(/\r?\n/);
			let startIdx = 0;
			while (startIdx < lines.length) {
				const trimmed = lines[startIdx].trim();
				if (trimmed === '') {
					startIdx++;
					continue;
				}
				const isPreamble = ORG_CONTEXT_PREAMBLE_HEADERS.some(h => trimmed.startsWith(h));
				if (isPreamble) {
					startIdx++;
					while (startIdx < lines.length) {
						const cur = lines[startIdx].trim();
						if (cur === '') {
							startIdx++;
							const nextNonEmpty = lines.slice(startIdx).find(l => l.trim() !== '')?.trim() ?? '';
							if (ORG_CONTEXT_PREAMBLE_HEADERS.some(h => nextNonEmpty.startsWith(h))) {
								break;
							}
							if (ORG_CONTEXT_LIVE_TAIL_HEADERS.some(h => nextNonEmpty.startsWith(h))) {
								continue;
							}
							break;
						}
						if (cur.startsWith('[Aexus System') && !cur.startsWith(AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER)) {
							break;
						}
						startIdx++;
					}
					continue;
				}
				break;
			}
			cleaned = lines.slice(startIdx).join('\n').trim() || cleaned.trim();
		} else {
			cleaned = cleaned.trim();
		}
		if (cleaned.length > maxChars) {
			cleaned = `${cleaned.slice(0, Math.max(32, maxChars - 3))}...`;
		}
	}
	return cleaned;
}

export interface IParsedJoinBarrierOptions {
	readonly ok: boolean;
	readonly error?: string;
	readonly joinMode: 'all' | 'any' | 'quorum';
	readonly quorumCount?: number;
	readonly failFast?: boolean;
	readonly deadlineAt?: number;
	readonly conflictPolicy?: 'reject' | 'warn' | 'allow';
}

/**
 * Shared parser for `token.mint`/`token.split` join barrier & file-scope conflict options across
 * renderer and headless control paths (auto-selects `joinMode: 'quorum'` when `quorumCount` is given,
 * and parses epoch ms, ISO-8601, OR relative duration strings like `"15m"` for `deadlineAt`).
 */
export function parseJoinBarrierOptions(
	params: Readonly<Record<string, unknown>>,
	now = Date.now(),
): IParsedJoinBarrierOptions {
	const rawQuorum = params.quorumCount ?? params.quorum;
	let quorumCount: number | undefined;
	if (rawQuorum !== undefined && rawQuorum !== null && String(rawQuorum).trim() !== '') {
		quorumCount = parseStrictPositiveInt(rawQuorum);
		if (quorumCount === undefined) {
			return { ok: false, joinMode: 'all', error: `Invalid --quorum "${String(rawQuorum)}": expected a positive integer >= 1.` };
		}
	}
	const rawJoinMode = typeof params.joinMode === 'string' ? params.joinMode.trim().toLowerCase() : '';
	let joinMode: 'all' | 'any' | 'quorum';
	if (rawJoinMode === 'any') {
		joinMode = 'any';
	} else if (rawJoinMode === 'quorum') {
		joinMode = 'quorum';
	} else if (rawJoinMode === 'all') {
		joinMode = 'all';
	} else if (!rawJoinMode) {
		joinMode = quorumCount !== undefined ? 'quorum' : 'all';
	} else {
		return { ok: false, joinMode: 'all', error: `Invalid --join-mode "${rawJoinMode}": expected all, any, or quorum.` };
	}
	const failFast = params.failFast === true ? true : undefined;
	const rawDeadline = params.deadlineAt ?? params.deadline;
	let deadlineAt: number | undefined;
	if (rawDeadline !== undefined && rawDeadline !== null && String(rawDeadline).trim() !== '') {
		if (typeof rawDeadline === 'number' && Number.isFinite(rawDeadline) && rawDeadline > 0) {
			deadlineAt = Math.floor(rawDeadline);
		} else if (typeof rawDeadline === 'string') {
			const s = rawDeadline.trim();
			if (/^\d+$/.test(s)) {
				const n = Number(s);
				deadlineAt = Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
			} else {
				const relMs = parseDurationMs(s);
				if (relMs !== undefined && relMs > 0) {
					deadlineAt = now + relMs;
				} else {
					const parsedIso = Date.parse(s);
					if (Number.isFinite(parsedIso) && parsedIso > 0) {
						deadlineAt = Math.floor(parsedIso);
					}
				}
			}
		}
		if (deadlineAt === undefined) {
			return { ok: false, joinMode, error: `Invalid --deadline "${String(rawDeadline)}": expected epoch ms, ISO-8601 timestamp, or relative duration (e.g. "15m", "2h").` };
		}
	}
	const rawConflict = typeof (params.conflictPolicy ?? params.overlapPolicy) === 'string'
		? String(params.conflictPolicy ?? params.overlapPolicy).trim().toLowerCase()
		: '';
	let conflictPolicy: 'reject' | 'warn' | 'allow' | undefined;
	if (params.allowOverlap === true) {
		conflictPolicy = 'allow';
	} else if (rawConflict === 'reject' || rawConflict === 'warn' || rawConflict === 'allow') {
		conflictPolicy = rawConflict;
	} else if (rawConflict) {
		return { ok: false, joinMode, error: `Invalid --conflict-policy "${rawConflict}": expected reject, warn, or allow.` };
	}
	return {
		ok: true,
		joinMode,
		...(quorumCount !== undefined ? { quorumCount } : {}),
		...(failFast ? { failFast: true } : {}),
		...(deadlineAt !== undefined ? { deadlineAt } : {}),
		...(conflictPolicy ? { conflictPolicy } : {}),
	};
}

export interface IParsedWhiteboardSliceParams {
	readonly toc?: boolean;
	readonly summaryOnly?: boolean;
	readonly section?: string;
	readonly maxChars?: number;
	readonly offset?: number;
	readonly tailChars?: number;
	readonly hasSliceParams: boolean;
}

/**
 * Parses section-sliced / budgeted read options shared identically across `whiteboard.read`
 * and `token.read` on both renderer and headless paths.
 */
export function parseWhiteboardSliceParams(params: Readonly<Record<string, unknown>>): IParsedWhiteboardSliceParams {
	const toc = params.toc === true;
	const summaryOnly = params.summaryOnly === true || params.summary === true;
	const section = typeof (params.section ?? params.heading) === 'string' && String(params.section ?? params.heading).trim()
		? String(params.section ?? params.heading).trim()
		: undefined;
	const maxChars = parseStrictPositiveInt(params.maxChars ?? params.max_chars);
	const rawOffset = params.offset;
	const offset = typeof rawOffset === 'number' && Number.isInteger(rawOffset) && rawOffset >= 0
		? rawOffset
		: (typeof rawOffset === 'string' && /^\d+$/.test(rawOffset.trim()) ? Number.parseInt(rawOffset.trim(), 10) : undefined);
	const tailChars = parseStrictPositiveInt(params.tailChars ?? params.tail ?? params.tail_chars);
	const hasSliceParams = Boolean(toc || summaryOnly || section || maxChars !== undefined || offset !== undefined || tailChars !== undefined);
	return {
		...(toc ? { toc: true } : {}),
		...(summaryOnly ? { summaryOnly: true } : {}),
		...(section ? { section } : {}),
		...(maxChars !== undefined ? { maxChars } : {}),
		...(offset !== undefined ? { offset } : {}),
		...(tailChars !== undefined ? { tailChars } : {}),
		hasSliceParams,
	};
}

/**
 * Parses a positive integer PID from number or numeric string (`"4242"` -> `4242`).
 */
export function parseStrictPositiveInt(raw: unknown): number | undefined {
	if (typeof raw === 'number') {
		return Number.isInteger(raw) && raw > 0 ? raw : undefined;
	}
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (/^\d+$/.test(trimmed)) {
			const parsed = Number.parseInt(trimmed, 10);
			return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
		}
	}
	return undefined;
}

/**
 * Strictly parses `--min-tier` values (`1`, `"2"`, `"L2"`, `"l3"`, or clear markers on update).
 * Rejects malformed strings like `"L"`, `"L2x"`, `NaN`, or out-of-range numbers instead of coercing to 0/NaN.
 */
export function parseStrictMinTierParam(
	raw: unknown,
	options?: { readonly allowClear?: boolean },
): { readonly ok: true; readonly value?: number; readonly clear?: boolean } | { readonly ok: false; readonly error: string } {
	if (raw === undefined) {
		return { ok: true };
	}
	if (raw === null) {
		return options?.allowClear
			? { ok: true, clear: true }
			: { ok: false, error: 'INVALID_MIN_TIER: "--min-tier" must be a tier between L1 and L99 (e.g. L2 or 2).' };
	}
	if (typeof raw === 'number') {
		if (!Number.isInteger(raw) || raw < 1 || raw > 99) {
			return { ok: false, error: `INVALID_MIN_TIER: "${String(raw)}" is not a valid tier (expected integer 1..99 or L1..L99).` };
		}
		return { ok: true, value: raw };
	}
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed || /^(?:none|clear|off|null)$/i.test(trimmed)) {
			if (options?.allowClear) {
				return { ok: true, clear: true };
			}
			return { ok: false, error: `INVALID_MIN_TIER: "${raw}" is not a valid tier (expected L1..L99 or 1..99).` };
		}
		const match = trimmed.match(/^(?:L)?(\d{1,2})$/i);
		if (!match) {
			return { ok: false, error: `INVALID_MIN_TIER: "${raw}" is not a valid tier (expected L1..L99 or 1..99).` };
		}
		const tier = Number.parseInt(match[1], 10);
		if (!Number.isInteger(tier) || tier < 1 || tier > 99) {
			return { ok: false, error: `INVALID_MIN_TIER: "${raw}" out of range (expected L1..L99).` };
		}
		return { ok: true, value: tier };
	}
	return { ok: false, error: `INVALID_MIN_TIER: unsupported value type for "--min-tier".` };
}

export interface IParsedOrchestrationLimitsParams {
	readonly ok: boolean;
	readonly error?: string;
	readonly isReadOnlyQuery: boolean;
	readonly maxHops?: number;
	readonly clearMaxHops?: boolean;
	readonly budgetLimitUsd?: number;
	readonly clearBudgetLimit?: boolean;
	readonly totalCostUsd?: number;
	readonly silenceReminderMinutes?: number;
}

/**
 * Shared parser & FinOps tamper guard for `orchestration.limits` and `mission.budget.set`.
 * Blocks non-Human callers from spoofing/resetting `totalCostUsd`, validates `NaN`/negative numbers,
 * supports `'unlimited'`/`0`/`null` to clear budget caps, and detects read-only queries.
 */
export function parseOrchestrationLimitsRequest(
	params: Readonly<Record<string, unknown>>,
	options: { readonly isHumanUser?: boolean },
): IParsedOrchestrationLimitsParams {
	const rawMaxHops = params.maxHops !== undefined ? params.maxHops : params.max_hops;
	const hasMaxHops = rawMaxHops !== undefined;
	const rawBudget = params.budgetLimitUsd !== undefined
		? params.budgetLimitUsd
		: (params.budgetUsd !== undefined
			? params.budgetUsd
			: (params.budget !== undefined
				? params.budget
				: (params.limitUsd !== undefined ? params.limitUsd : params.limit)));
	const hasBudget = rawBudget !== undefined;
	const hasTotalCost = params.totalCostUsd !== undefined;
	const hasSilence = params.silenceReminderMinutes !== undefined || params.silenceMinutes !== undefined;

	if (!hasMaxHops && !hasBudget && !hasTotalCost && !hasSilence) {
		return { ok: true, isReadOnlyQuery: true };
	}

	if (hasTotalCost && !options.isHumanUser) {
		return {
			ok: false,
			isReadOnlyQuery: false,
			error: 'FORBIDDEN: agents cannot override or reset FinOps totalCostUsd spend; only Human User / system billing may update totalCostUsd.',
		};
	}

	let maxHops: number | undefined;
	let clearMaxHops = false;
	if (hasMaxHops) {
		if (rawMaxHops === null || rawMaxHops === '' || (typeof rawMaxHops === 'string' && /^(?:unlimited|none|off|clear|default)$/i.test(rawMaxHops.trim()))) {
			clearMaxHops = true;
		} else {
			const n = typeof rawMaxHops === 'number' ? rawMaxHops : Number(String(rawMaxHops).trim());
			if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 10_000) {
				return { ok: false, isReadOnlyQuery: false, error: `Invalid maxHops "${String(rawMaxHops)}": expected integer between 1 and 10000.` };
			}
			maxHops = n;
		}
	}

	let budgetLimitUsd: number | undefined;
	let clearBudgetLimit = false;
	if (hasBudget) {
		if (rawBudget === null || rawBudget === '' || (typeof rawBudget === 'string' && /^(?:unlimited|none|off|clear|inf|infinity)$/i.test(rawBudget.trim()))) {
			clearBudgetLimit = true;
		} else {
			const n = typeof rawBudget === 'number' ? rawBudget : Number(String(rawBudget).trim());
			if (!Number.isFinite(n) || n < 0) {
				return { ok: false, isReadOnlyQuery: false, error: `Invalid budgetLimitUsd "${String(rawBudget)}": expected non-negative number or "unlimited".` };
			}
			if (n === 0) {
				clearBudgetLimit = true;
			} else {
				budgetLimitUsd = n;
			}
		}
	}

	let totalCostUsd: number | undefined;
	if (hasTotalCost) {
		const n = typeof params.totalCostUsd === 'number' ? params.totalCostUsd : Number(String(params.totalCostUsd).trim());
		if (!Number.isFinite(n) || n < 0) {
			return { ok: false, isReadOnlyQuery: false, error: `Invalid totalCostUsd "${String(params.totalCostUsd)}": expected non-negative number.` };
		}
		totalCostUsd = n;
	}

	let silenceReminderMinutes: number | undefined;
	if (hasSilence) {
		const rawSil = params.silenceReminderMinutes ?? params.silenceMinutes;
		const n = typeof rawSil === 'number' ? rawSil : Number(String(rawSil).trim());
		if (!Number.isFinite(n) || n < 1 || n > 1440) {
			return { ok: false, isReadOnlyQuery: false, error: `Invalid silenceReminderMinutes "${String(rawSil)}": expected number between 1 and 1440.` };
		}
		silenceReminderMinutes = Math.floor(n);
	}

	return {
		ok: true,
		isReadOnlyQuery: false,
		...(maxHops !== undefined ? { maxHops } : {}),
		...(clearMaxHops ? { clearMaxHops: true } : {}),
		...(budgetLimitUsd !== undefined ? { budgetLimitUsd } : {}),
		...(clearBudgetLimit ? { clearBudgetLimit: true } : {}),
		...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
		...(silenceReminderMinutes !== undefined ? { silenceReminderMinutes } : {}),
	};
}

/**
 * Helper to check whether a caller holds top-rank (L1) privileges *within* a verified Mission membership.
 */
export function isTopRankMember(
	config: IAdeOrganizationConfig,
	graph: IOrchestrationGraphParseResult | undefined,
	caller: { readonly callerTier?: number; readonly callerNodeId?: string; readonly isMember: boolean },
): boolean {
	if (!caller.isMember) {
		return false;
	}
	const highestTier = config.ranks.length > 0 ? Math.min(...config.ranks.map(r => r.tier)) : 1;
	if (caller.callerTier !== undefined && caller.callerTier <= highestTier) {
		return true;
	}
	if (graph && caller.callerNodeId) {
		const staff = graph.nodes.find(n => n.id === caller.callerNodeId && n.kind === 'staff');
		const effTier = staff ? resolveEffectiveStaffTier(staff, config) : undefined;
		if (effTier !== undefined && effTier <= highestTier) {
			return true;
		}
	}
	return false;
}

/**
 * Filters a record of department whiteboards down to the subset readable by `caller`.
 */
export function filterWhiteboardsMapByAllowedIds(
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	allowedIds: ReadonlySet<string>,
): Readonly<Record<string, IOrchestrationWhiteboard>> {
	if (!whiteboards) {
		return {};
	}
	const out: Record<string, IOrchestrationWhiteboard> = {};
	for (const [id, wb] of Object.entries(whiteboards)) {
		if (allowedIds.has(id)) {
			out[id] = wb;
		}
	}
	return out;
}

export interface IOrchestrationLineageCaller {
	readonly isHumanUser?: boolean;
	readonly isSecretary?: boolean;
	readonly isMissionOwner?: boolean;
	readonly callerTier?: number;
	readonly callerNodeId?: string;
	readonly callerSessionId?: string;
}

export interface IOrchestrationTokenLineageLike {
	readonly id?: string;
	readonly nodeId?: string;
	readonly fromNodeId?: string;
	readonly returnToNodeId?: string;
	readonly originNodeId?: string;
	readonly parentTokenId?: string;
	readonly parentJoinBarrierId?: string;
	readonly holderAgentId?: string;
	readonly hopLog?: ReadonlyArray<{ readonly fromNodeId?: string; readonly toNodeId?: string }>;
}

function hasFullOrchestrationLineageVisibility(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult | undefined,
	config: IAdeOrganizationConfig,
	caller: IOrchestrationLineageCaller,
): { readonly full: boolean; readonly callerNodeId?: string } {
	if (caller.isHumanUser || caller.isSecretary || caller.isMissionOwner || isHighestRankTaskCompleter(config, caller)) {
		return { full: true };
	}
	let callerNodeId = caller.callerNodeId?.trim() || undefined;
	if (!callerNodeId && caller.callerSessionId && state.nodeAgentIds) {
		for (const [nid, aid] of Object.entries(state.nodeAgentIds)) {
			if (aid === caller.callerSessionId) {
				callerNodeId = nid;
				break;
			}
		}
	}
	if (callerNodeId && graph) {
		const staff = graph.nodes.find(n => n.id === callerNodeId && n.kind === 'staff');
		if (staff) {
			if (isStrictCompanyWideExecutiveDept(staff.department)) {
				return { full: true, callerNodeId };
			}
			const effTier = resolveEffectiveStaffTier(staff, config);
			if (effTier !== undefined && isHighestRankTaskCompleter(config, { callerTier: effTier })) {
				return { full: true, callerNodeId };
			}
		}
	}
	return { full: false, callerNodeId };
}

/**
 * Enforces per-caller lineage scoping on `token.history` (hot and archived tokens).
 * Human (L-1), Secretary (L0), Mission owner, top-rank leaders, and company-wide executive
 * departments have full visibility; other staff may only inspect tokens in their own lineage
 * (current/prior holder, direct dispatcher/return target, owned join barrier, or ancestor branch).
 */
export function canCallerInspectOrchestrationTokenHistory(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult | undefined,
	config: IAdeOrganizationConfig,
	token: IOrchestrationTokenLineageLike,
	caller: IOrchestrationLineageCaller,
): boolean {
	const vis = hasFullOrchestrationLineageVisibility(state, graph, config, caller);
	if (vis.full) {
		return true;
	}
	const callerNodeId = vis.callerNodeId;
	const callerSessionId = caller.callerSessionId?.trim() || undefined;
	if (!callerNodeId && !callerSessionId) {
		return false;
	}
	const matchesDirectly = (t: IOrchestrationTokenLineageLike): boolean => {
		if (callerSessionId && t.holderAgentId === callerSessionId) {
			return true;
		}
		if (!callerNodeId) {
			return false;
		}
		if (
			t.nodeId === callerNodeId
			|| t.fromNodeId === callerNodeId
			|| t.returnToNodeId === callerNodeId
			|| t.originNodeId === callerNodeId
		) {
			return true;
		}
		if (t.parentJoinBarrierId && state.joinBarriers?.[t.parentJoinBarrierId]?.ownerNodeId === callerNodeId) {
			return true;
		}
		if (t.hopLog?.some(h => h.fromNodeId === callerNodeId || h.toNodeId === callerNodeId)) {
			return true;
		}
		return false;
	};
	if (matchesDirectly(token)) {
		return true;
	}
	// Walk ancestor parentTokenId chain in live state so a department lead can inspect delegated sub-branches
	const visited = new Set<string>();
	if (token.id) {
		visited.add(token.id);
	}
	let cursorParentId = token.parentTokenId;
	while (cursorParentId && !visited.has(cursorParentId)) {
		visited.add(cursorParentId);
		const parentTok = state.tokens?.[cursorParentId];
		if (!parentTok) {
			break;
		}
		if (matchesDirectly(parentTok)) {
			return true;
		}
		cursorParentId = parentTok.parentTokenId;
	}
	return false;
}

/**
 * Enforces per-caller lineage scoping on `token.trace` for Orchestration traces (`otrc-*`).
 * Non-privileged staff may only expand trace pointers attached to their own node/session,
 * their lineage-visible tokens, or upstream ancestors of those traces — preventing sequential
 * enumeration of foreign department branches.
 */
export function canCallerInspectOrchestrationTrace(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult | undefined,
	config: IAdeOrganizationConfig,
	tracePtr: string,
	caller: IOrchestrationLineageCaller,
): boolean {
	const vis = hasFullOrchestrationLineageVisibility(state, graph, config, caller);
	if (vis.full) {
		return true;
	}
	const callerNodeId = vis.callerNodeId;
	const callerSessionId = caller.callerSessionId?.trim() || undefined;
	if (!callerNodeId && !callerSessionId) {
		return false;
	}
	const allowed = new Set<string>();
	const queue: string[] = [];
	const enqueue = (ptr: string | undefined): void => {
		if (ptr && !allowed.has(ptr)) {
			allowed.add(ptr);
			queue.push(ptr);
		}
	};
	for (const traceNode of Object.values(state.traces ?? {})) {
		if (
			(callerNodeId && traceNode.nodeId === callerNodeId)
			|| (callerSessionId && traceNode.employeeId === callerSessionId)
		) {
			enqueue(traceNode.ptr);
		}
	}
	for (const tok of Object.values(state.tokens ?? {})) {
		if (tok.tracePtr && canCallerInspectOrchestrationTokenHistory(state, graph, config, tok, caller)) {
			enqueue(tok.tracePtr);
		}
	}
	while (queue.length > 0) {
		const cur = queue.shift()!;
		if (cur === tracePtr) {
			return true;
		}
		const node = state.traces?.[cur];
		if (!node) {
			continue;
		}
		for (const parentPtr of node.parentPtrs ?? []) {
			enqueue(parentPtr);
		}
	}
	return allowed.has(tracePtr);
}

/**
 * Wraps `secretary.send` messages so sovereign Human (`L-1`) prompts get the User DM envelope
 * while non-human (`L0` / `L1..LN`) callers ALWAYS receive a `[Aexus System · Direct Message from Role]`
 * envelope (never bare text that downstream Secretary engines could auto-promote to `User (L-1)`).
 */
export function buildSecretarySendEnvelope(input: {
	readonly rawMessage: string;
	readonly isHumanUser: boolean;
	readonly isSecretaryCaller: boolean;
	readonly secretaryLabel?: string;
	readonly secretaryId?: string;
	readonly senderLabel?: string;
	readonly senderTierTag?: string;
	readonly senderRankName?: string;
	readonly senderSessionId?: string;
}): string {
	if (input.isHumanUser) {
		return wrapUserDirectMessageEnvelope(input.rawMessage, 'secretary.send', { usePreambleSentinel: true });
	}
	if (input.isSecretaryCaller) {
		return wrapRoleDirectMessageEnvelope({
			senderLabel: input.secretaryLabel || 'Secretary',
			senderTierTag: 'L0',
			senderRankName: 'Secretary',
			senderSessionId: input.secretaryId || '__secretary__',
			channel: 'session.send',
			message: input.rawMessage,
		});
	}
	return wrapRoleDirectMessageEnvelope({
		senderLabel: input.senderLabel || input.senderSessionId || input.senderRankName || 'Agent',
		senderTierTag: input.senderTierTag || 'L1',
		senderRankName: input.senderRankName || 'Role',
		senderSessionId: input.senderSessionId,
		channel: 'session.send',
		message: input.rawMessage,
	});
}

const READ_ONLY_ADE_CONTROL_ACTIONS: ReadonlySet<string> = new Set([
	'status',
	'whoami',
	'docs.read',
	'rank.docs',
	'rank.names',
	'rank.list',
	'rank.get',
	'role.schema.get',
	'role.apis',
	'role.presets',
	'mode.get',
	'view.get',
	'project.list',
	'project.changes',
	'engine.list',
	'host.list',
	'host.get',
	'host.info',
	'host.browse',
	'inbox.list',
	'session.list',
	'session.tree',
	'session.history',
	'org.subordinates',
	'org.context',
	'mission.list',
	'mission.get',
	'mission.blueprint.get',
	'mission.blueprint.validate',
	'mission.status',
	'mission.diagnostics',
	'mission.boundary.get',
	'mission.export',
	'mission.trigger.list',
	'mission.check.list',
	'mission.check.get',
	'mission.task.list',
	'mission.task.get',
	'mission.checkpoint.list',
	'mission.checkpoint.diff',
	'orchestration.get',
	'orchestration.export',
	'orchestration.validate',
	'orchestration.status',
	'orchestration.group.list',
	'orchestration.checkpoint.list',
	'orchestration.checkpoint.diff',
	'whiteboard.list',
	'whiteboard.read',
	'token.list',
	'token.get',
]);

/**
 * Returns true strictly when `action` is side-effect-free (safe to retry via headless
 * fallback even after a mid-flight renderer IPC disconnect).
 * Fail-closed: unknown actions and mutating actions return `false`.
 */
export function isReadOnlyAdeControlAction(
	action: string,
	params?: Readonly<Record<string, unknown>>,
): boolean {
	if (READ_ONLY_ADE_CONTROL_ACTIONS.has(action)) {
		return true;
	}
	if (action === 'orchestration.limits') {
		return parseOrchestrationLimitsRequest(params ?? {}, { isHumanUser: false }).isReadOnlyQuery;
	}
	return false;
}

/**
 * Canonical cross-path Mission Checkpoint disk bundle shared identically between
 * Workbench Renderer (`AdeMissionOrchestrationController`) and Main-Process Headless
 * Daemon (`adeHeadlessControlReadActions` / `adeHeadlessControlMutationActions`).
 */
export interface IUnifiedMissionCheckpointBundle {
	readonly schemaVersion: 2;
	readonly meta: {
		readonly id: string;
		readonly missionId: string;
		readonly createdAt: number;
		readonly stateRevision: number;
		readonly label?: string;
		readonly reason?: string;
		readonly createdBy?: string;
		readonly summary?: string;
	};
	readonly checkpointSnapshot: IOrchestrationCheckpointSnapshot;
	readonly mermaidText?: string;
	readonly orchestrationText?: string;
	readonly nodePrompts?: Readonly<Record<string, string>>;
	readonly nodeChecks?: Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
	readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
	readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
}

function isOrchestrationCheckpointSnapshotLike(val: unknown): val is IOrchestrationCheckpointSnapshot {
	if (!val || typeof val !== 'object') {
		return false;
	}
	const obj = val as Record<string, unknown>;
	return typeof obj.id === 'string'
		&& typeof obj.missionId === 'string'
		&& Boolean(obj.tokens && typeof obj.tokens === 'object');
}

export function serializeUnifiedMissionCheckpointBundle(input: {
	readonly meta: IUnifiedMissionCheckpointBundle['meta'];
	readonly checkpointSnapshot: IOrchestrationCheckpointSnapshot;
	readonly mermaidText?: string;
	readonly orchestrationText?: string;
	readonly nodePrompts?: Readonly<Record<string, string>>;
	readonly nodeChecks?: Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
	readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
	readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
}): string {
	const bundle: IUnifiedMissionCheckpointBundle = {
		schemaVersion: 2,
		meta: input.meta,
		checkpointSnapshot: input.checkpointSnapshot,
		...(typeof input.mermaidText === 'string' ? { mermaidText: input.mermaidText } : {}),
		...(typeof input.orchestrationText === 'string' ? { orchestrationText: input.orchestrationText } : {}),
		...(input.nodePrompts !== undefined ? { nodePrompts: input.nodePrompts } : {}),
		...(input.nodeChecks !== undefined ? { nodeChecks: input.nodeChecks } : {}),
		...(input.whiteboards !== undefined ? { whiteboards: input.whiteboards } : {}),
		...(input.taskStatuses !== undefined ? { taskStatuses: input.taskStatuses } : {}),
	};
	return JSON.stringify(bundle);
}

/**
 * Decodes any persisted Mission Checkpoint JSON bundle across:
 *   - Canonical v2 (`{ schemaVersion: 2, meta, checkpointSnapshot, ... }`)
 *   - Legacy headless v1 (`{ schemaVersion: 1, meta, checkpointSnapshot, snapshot: { ... } }`)
 *   - Legacy renderer (`{ snapshot: IOrchestrationCheckpointSnapshot, mermaidText?, orchestrationText? }`)
 *   - Raw `IOrchestrationCheckpointSnapshot`
 */
export function parseUnifiedMissionCheckpointBundle(raw: string): IUnifiedMissionCheckpointBundle | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const rec = parsed as Record<string, unknown>;
	let checkpointSnapshot: IOrchestrationCheckpointSnapshot | undefined;
	let legacyWrap: Record<string, unknown> | undefined;

	if (isOrchestrationCheckpointSnapshotLike(rec.checkpointSnapshot)) {
		checkpointSnapshot = rec.checkpointSnapshot;
		if (rec.snapshot && typeof rec.snapshot === 'object' && !isOrchestrationCheckpointSnapshotLike(rec.snapshot)) {
			legacyWrap = rec.snapshot as Record<string, unknown>;
		}
	} else if (isOrchestrationCheckpointSnapshotLike(rec.snapshot)) {
		checkpointSnapshot = rec.snapshot;
	} else if (isOrchestrationCheckpointSnapshotLike(rec)) {
		checkpointSnapshot = rec;
	}
	if (!checkpointSnapshot) {
		return undefined;
	}

	const rawMeta = (rec.meta && typeof rec.meta === 'object' ? rec.meta : undefined) as Record<string, unknown> | undefined;
	const meta: IUnifiedMissionCheckpointBundle['meta'] = {
		id: typeof rawMeta?.id === 'string' ? rawMeta.id : checkpointSnapshot.id,
		missionId: typeof rawMeta?.missionId === 'string' ? rawMeta.missionId : checkpointSnapshot.missionId,
		createdAt: typeof rawMeta?.createdAt === 'number' ? rawMeta.createdAt : checkpointSnapshot.createdAt,
		stateRevision: typeof rawMeta?.stateRevision === 'number' ? rawMeta.stateRevision : checkpointSnapshot.stateRevision,
		...(typeof rawMeta?.label === 'string' ? { label: rawMeta.label } : checkpointSnapshot.label ? { label: checkpointSnapshot.label } : {}),
		...(typeof rawMeta?.reason === 'string' ? { reason: rawMeta.reason } : checkpointSnapshot.reason ? { reason: checkpointSnapshot.reason } : {}),
		...(typeof rawMeta?.createdBy === 'string' ? { createdBy: rawMeta.createdBy } : checkpointSnapshot.createdBy ? { createdBy: checkpointSnapshot.createdBy } : {}),
		...(typeof rawMeta?.summary === 'string' ? { summary: rawMeta.summary } : {}),
	};

	const pickString = (k: 'mermaidText' | 'orchestrationText'): string | undefined => {
		if (typeof rec[k] === 'string') {
			return rec[k] as string;
		}
		if (legacyWrap && typeof legacyWrap[k] === 'string') {
			return legacyWrap[k] as string;
		}
		return undefined;
	};
	const pickRecord = <T>(k: 'nodePrompts' | 'nodeChecks' | 'whiteboards' | 'taskStatuses'): T | undefined => {
		if (rec[k] && typeof rec[k] === 'object') {
			return rec[k] as T;
		}
		if (legacyWrap && legacyWrap[k] && typeof legacyWrap[k] === 'object') {
			return legacyWrap[k] as T;
		}
		return undefined;
	};

	const mermaidText = pickString('mermaidText');
	const orchestrationText = pickString('orchestrationText');
	const nodePrompts = pickRecord<Readonly<Record<string, string>>>('nodePrompts');
	const nodeChecks = pickRecord<Readonly<Record<string, readonly IMissionNodeCheckHook[]>>>('nodeChecks');
	const whiteboards = pickRecord<Readonly<Record<string, IOrchestrationWhiteboard>>>('whiteboards') ?? checkpointSnapshot.whiteboards;
	const taskStatuses = pickRecord<Readonly<Record<string, IMissionTaskStatusRecord>>>('taskStatuses') ?? checkpointSnapshot.taskStatuses;

	return {
		schemaVersion: 2,
		meta,
		checkpointSnapshot,
		...(mermaidText !== undefined ? { mermaidText } : {}),
		...(orchestrationText !== undefined ? { orchestrationText } : {}),
		...(nodePrompts !== undefined ? { nodePrompts } : {}),
		...(nodeChecks !== undefined ? { nodeChecks } : {}),
		...(whiteboards !== undefined ? { whiteboards } : {}),
		...(taskStatuses !== undefined ? { taskStatuses } : {}),
	};
}
