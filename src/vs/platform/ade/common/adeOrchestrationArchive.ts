/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMissionTraceNode } from './adeMissionEngine.js';
import { IOrchestrationGraphParseResult } from './adeOrchestrationGraph.js';
import {
	buildOrchestrationTokenDeltaView,
	buildWhiteboardContextRef,
	IDereferencedOrchestrationPointer,
	IOrchestrationArchiveEntry,
	IOrchestrationCompactionResult,
	IOrchestrationContextBlob,
	IOrchestrationContextRef,
	IOrchestrationExternalizedBlobMeta,
	IOrchestrationHopLedgerEntry,
	IOrchestrationJoinBarrier,
	IOrchestrationNodeReadCursor,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationTokenDeltaView,
	IOrchestrationWhiteboard,
	isHighestRankTaskCompleter,
	IWhiteboardSliceOptions,
	ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS,
	recordNodeCursorObservation,
	refreshContextRefsWithLiveWhiteboards,
} from './adeOrchestrationTypes.js';
import { canCallerAccessWhiteboard, sliceWhiteboardContent } from './adeOrchestrationWhiteboards.js';
import { IAdeOrganizationConfig } from './adeRoleSchema.js';

function buildAllowedInternalPointersForNode(
	state: IOrchestrationRuntimeState,
	callerNodeId: string,
): ReadonlySet<string> {
	const allowed = new Set<string>();
	for (const tok of Object.values(state.tokens)) {
		const isRecipientOrSender = tok.nodeId === callerNodeId
			|| tok.fromNodeId === callerNodeId
			|| tok.returnToNodeId === callerNodeId;
		if (!isRecipientOrSender) {
			continue;
		}
		if (tok.payloadPtr) {
			allowed.add(tok.payloadPtr);
		}
		if (tok.tracePtr) {
			allowed.add(tok.tracePtr);
		}
		for (const ref of tok.contextRefs ?? []) {
			if (ref.kind !== 'whiteboard') {
				allowed.add(ref.ptr);
			}
		}
		for (const h of tok.hopLog ?? []) {
			if (h.payloadPtr) {
				allowed.add(h.payloadPtr);
			}
			for (const ap of h.attachedRefPtrs ?? []) {
				if (!ap.startsWith('wb:')) {
					allowed.add(ap);
				}
			}
		}
	}
	for (const barrier of Object.values(state.joinBarriers ?? {})) {
		if (barrier.ownerNodeId !== callerNodeId) {
			continue;
		}
		for (const child of Object.values(barrier.settledChildren)) {
			if (child.payloadPtr) {
				allowed.add(child.payloadPtr);
			}
			for (const ap of child.attachedRefPtrs ?? []) {
				if (!ap.startsWith('wb:')) {
					allowed.add(ap);
				}
			}
		}
	}
	return allowed;
}

/**
 * Batch on-demand pointer dereferencer (`token.read`):
 * Resolves `hop-N`, `art-N`, `dec-N`, `wb:<id>` (or raw whiteboard ID), and `otrc-N` in one round-trip,
 * enforces department whiteboard & pointer-lineage ACL scoping, and records observed pointer versions in `nodeReadCursors`.
 */
export function readOrchestrationTokenPointers(
	state: IOrchestrationRuntimeState,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	graph: IOrchestrationGraphParseResult,
	config: IAdeOrganizationConfig,
	params: {
		readonly ptrs: readonly string[];
		readonly readerNodeId?: string;
		readonly waveId?: string;
		readonly toc?: boolean;
		readonly summaryOnly?: boolean;
		readonly section?: string;
		readonly maxChars?: number;
		readonly offset?: number;
		readonly tailChars?: number;
		readonly slice?: IWhiteboardSliceOptions;
		readonly caller?: {
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerNodeId?: string;
		};
		readonly now?: number;
	},
): {
	readonly state: IOrchestrationRuntimeState;
	readonly items: readonly IDereferencedOrchestrationPointer[];
} {
	const now = params.now ?? Date.now();
	const items: IDereferencedOrchestrationPointer[] = [];
	const observedRefs: IOrchestrationContextRef[] = [];
	let maxObservedHop = -1;

	const sliceOpts: IWhiteboardSliceOptions | undefined = (
		params.slice
		|| params.toc !== undefined
		|| params.summaryOnly !== undefined
		|| params.section !== undefined
		|| params.maxChars !== undefined
		|| params.offset !== undefined
		|| params.tailChars !== undefined
	)
		? {
			toc: params.toc ?? params.slice?.toc,
			summaryOnly: params.summaryOnly ?? params.slice?.summaryOnly,
			section: params.section ?? params.slice?.section,
			maxChars: params.maxChars ?? params.slice?.maxChars,
			offset: params.offset ?? params.slice?.offset,
			tailChars: params.tailChars ?? params.slice?.tailChars,
		}
		: undefined;

	const enforcePointerAcl = Boolean(
		params.caller
		&& !isHighestRankTaskCompleter(config, params.caller),
	);
	const effectiveCallerNodeId = params.caller?.callerNodeId?.trim() || params.readerNodeId?.trim();
	const allowedInternalPtrs = enforcePointerAcl && effectiveCallerNodeId
		? buildAllowedInternalPointersForNode(state, effectiveCallerNodeId)
		: undefined;

	const canReadInternalPtr = (ptr: string, authorNodeId?: string, authorizedNodeIds?: readonly string[]): boolean => {
		if (!enforcePointerAcl) {
			return true;
		}
		if (!effectiveCallerNodeId) {
			return false;
		}
		if (authorNodeId && authorNodeId === effectiveCallerNodeId) {
			return true;
		}
		if (authorizedNodeIds && authorizedNodeIds.includes(effectiveCallerNodeId)) {
			return true;
		}
		return Boolean(allowedInternalPtrs?.has(ptr));
	};

	for (const raw of params.ptrs) {
		const ptr = raw.trim();
		if (!ptr) {
			continue;
		}
		const blob = state.payloadStore?.[ptr];
		if (blob) {
			if (!canReadInternalPtr(blob.ptr, blob.authorNodeId)) {
				items.push({
					ptr: blob.ptr,
					ok: false,
					kind: blob.kind,
					error: `FORBIDDEN: caller "${effectiveCallerNodeId ?? 'unknown'}" does not have lineage access to pointer "${blob.ptr}".`,
				});
				continue;
			}
			const sliced = sliceOpts ? sliceWhiteboardContent(blob.content, sliceOpts) : undefined;
			items.push({
				ptr: blob.ptr,
				ok: true,
				kind: blob.kind,
				title: blob.title,
				version: 1,
				authorNodeId: blob.authorNodeId,
				hop: blob.hop,
				sizeChars: blob.sizeChars,
				content: sliced ? sliced.content : blob.content,
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
			// Partial/sliced reads MUST NOT mark the full pointer as seen in `nodeReadCursors`!
			if (!sliced?.isPartialSlice) {
				observedRefs.push({
					ptr: blob.ptr,
					kind: blob.kind,
					title: blob.title,
					version: 1,
					updatedAtHop: blob.hop,
					...(blob.authorNodeId ? { authorNodeId: blob.authorNodeId } : {}),
					sizeChars: blob.sizeChars,
					digest: blob.digest,
				});
				maxObservedHop = Math.max(maxObservedHop, blob.hop);
			}
			continue;
		}

		const extMeta = state.externalizedBlobIndex?.[ptr];
		if (extMeta) {
			if (!canReadInternalPtr(extMeta.ptr, extMeta.authorNodeId, extMeta.authorizedNodeIds)) {
				items.push({
					ptr: extMeta.ptr,
					ok: false,
					kind: extMeta.kind,
					error: `FORBIDDEN: caller "${effectiveCallerNodeId ?? 'unknown'}" does not have lineage access to pointer "${extMeta.ptr}".`,
				});
				continue;
			}
			items.push({
				ptr: extMeta.ptr,
				ok: false,
				kind: extMeta.kind,
				title: extMeta.title,
				version: 1,
				authorNodeId: extMeta.authorNodeId,
				hop: extMeta.hop,
				sizeChars: extMeta.sizeChars,
				externalized: true,
				error: `Pointer "${ptr}" is externalized to cold blob storage.`,
			});
			continue;
		}

		const wbId = ptr.startsWith('wb:') ? ptr.slice(3) : ptr;
		const wb = whiteboards?.[wbId];
		if (wb) {
			if (params.caller && !canCallerAccessWhiteboard(graph, wb, config, { ...params.caller, access: 'read', state })) {
				items.push({
					ptr,
					ok: false,
					kind: 'whiteboard',
					error: `FORBIDDEN: caller cannot read whiteboard "${wb.id}" (Department: "${wb.department}").`,
				});
				continue;
			}
			const sliced = sliceOpts ? sliceWhiteboardContent(wb.content, sliceOpts) : undefined;
			items.push({
				ptr: `wb:${wb.id}`,
				ok: true,
				kind: 'whiteboard',
				title: wb.title,
				version: wb.version,
				department: wb.department,
				authorNodeId: wb.updatedByLabel,
				sizeChars: wb.content.length,
				content: sliced ? sliced.content : wb.content,
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
			if (!sliced?.isPartialSlice) {
				observedRefs.push(buildWhiteboardContextRef(wb, Math.max(0, maxObservedHop)));
			}
			continue;
		}

		const traceNode = state.traces[ptr];
		if (traceNode) {
			if (!canReadInternalPtr(traceNode.ptr, traceNode.nodeId)) {
				items.push({
					ptr: traceNode.ptr,
					ok: false,
					kind: 'trace',
					error: `FORBIDDEN: caller "${effectiveCallerNodeId ?? 'unknown'}" does not have lineage access to trace "${traceNode.ptr}".`,
				});
				continue;
			}
			const traceText = traceNode.summary ?? '';
			const sliced = sliceOpts ? sliceWhiteboardContent(traceText, sliceOpts) : undefined;
			items.push({
				ptr: traceNode.ptr,
				ok: true,
				kind: 'trace',
				title: `${traceNode.event} @ ${traceNode.nodeId}`,
				version: 1,
				authorNodeId: traceNode.nodeId,
				sizeChars: traceText.length,
				content: sliced ? sliced.content : traceText,
				...(sliced ? {
					truncated: sliced.truncated,
					lineCount: sliced.lineCount,
					offset: sliced.offset,
					...(sliced.nextOffset !== undefined ? { nextOffset: sliced.nextOffset } : {}),
					isPartialSlice: sliced.isPartialSlice,
				} : {}),
			});
			continue;
		}

		items.push({
			ptr,
			ok: false,
			error: ptr.startsWith('wb:')
				? `Whiteboard pointer "${ptr}" not found (removed or does not exist).`
				: `Pointer "${ptr}" not found in Orchestration payloadStore, whiteboards, or traces.`,
		});
	}

	let nextState = state;
	if (params.readerNodeId && params.waveId && observedRefs.length > 0) {
		const nextCursors = recordNodeCursorObservation(
			state.nodeReadCursors,
			params.waveId,
			params.readerNodeId,
			maxObservedHop,
			observedRefs,
			now,
		);
		nextState = {
			...state,
			nodeReadCursors: nextCursors,
			stateRevision: (state.stateRevision ?? 0) + 1,
			updatedAt: now,
		};
	}

	return { state: nextState, items };
}

/**
 * Advances `nodeReadCursors` after externalized cold-storage pointers are successfully hydrated from disk.
 */
export function recordExternalizedPointersRead(
	state: IOrchestrationRuntimeState,
	params: {
		readonly ptrs: readonly string[];
		readonly readerNodeId: string;
		readonly waveId: string;
		readonly now?: number;
	},
): IOrchestrationRuntimeState {
	const now = params.now ?? Date.now();
	const observedRefs: IOrchestrationContextRef[] = [];
	let maxHop = -1;
	for (const raw of params.ptrs) {
		const ptr = raw.trim();
		const meta = state.externalizedBlobIndex?.[ptr];
		if (!meta) {
			continue;
		}
		observedRefs.push({
			ptr: meta.ptr,
			kind: meta.kind,
			title: meta.title,
			version: 1,
			updatedAtHop: meta.hop,
			...(meta.authorNodeId ? { authorNodeId: meta.authorNodeId } : {}),
			sizeChars: meta.sizeChars,
			digest: meta.digest,
		});
		maxHop = Math.max(maxHop, meta.hop);
	}
	if (observedRefs.length === 0) {
		return state;
	}
	return {
		...state,
		nodeReadCursors: recordNodeCursorObservation(
			state.nodeReadCursors,
			params.waveId,
			params.readerNodeId,
			maxHop,
			observedRefs,
			now,
		),
		stateRevision: (state.stateRevision ?? 0) + 1,
		updatedAt: now,
	};
}

/**
 * Returns full pass-history timeline and typed pointer manifest for any Orchestration token
 * along with its Delta View relative to the holder.
 */
export function getOrchestrationTokenHistory(
	state: IOrchestrationRuntimeState,
	tokenId: string,
	whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>,
	options?: { readonly includeAll?: boolean },
): {
	readonly ok: boolean;
	readonly tokenId: string;
	readonly waveId?: string;
	readonly nodeId?: string;
	readonly currentHop?: number;
	readonly hopLog?: readonly IOrchestrationHopLedgerEntry[];
	readonly contextRefs?: readonly IOrchestrationContextRef[];
	readonly delta?: IOrchestrationTokenDeltaView;
	readonly error?: string;
} {
	const token = state.tokens[tokenId];
	if (!token) {
		return { ok: false, tokenId, error: `Orchestration token "${tokenId}" not found.` };
	}
	const delta = buildOrchestrationTokenDeltaView(state, token, whiteboards);
	const currentHop = token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1);
	const refreshedRefs = refreshContextRefsWithLiveWhiteboards(token.contextRefs, whiteboards, token.whiteboardPointers, currentHop);
	return {
		ok: true,
		tokenId: token.id,
		waveId: token.waveId,
		nodeId: token.nodeId,
		currentHop,
		hopLog: options?.includeAll !== false ? (token.hopLog ?? []) : delta.newHops,
		contextRefs: options?.includeAll !== false ? refreshedRefs : delta.newOrUpdatedRefs,
		delta,
	};
}

const DEFAULT_HOT_BLOB_MAX_CHARS = 1024;
const DEFAULT_MAX_HOT_TERMINAL_TOKENS = 80;
const DEFAULT_MAX_HOT_TRACES = 200;
const DEFAULT_MAX_HOT_TERMINAL_BARRIERS = 40;

/**
 * Governs Orchestration JSON state size by externalizing cold/large payload blobs,
 * archiving excess terminal tokens & traces beyond hot retention budgets,
 * and pruning settled barriers & stale wave read cursors.
 */
export function compactOrchestrationRuntimeState(
	state: IOrchestrationRuntimeState,
	options?: {
		readonly hotBlobMaxChars?: number;
		readonly maxHotTerminalTokens?: number;
		readonly maxHotTraces?: number;
		readonly maxHotTerminalBarriers?: number;
		readonly now?: number;
	},
): IOrchestrationCompactionResult {
	const hotBlobMaxChars = options?.hotBlobMaxChars ?? DEFAULT_HOT_BLOB_MAX_CHARS;
	const maxHotTerminalTokens = options?.maxHotTerminalTokens ?? DEFAULT_MAX_HOT_TERMINAL_TOKENS;
	const maxHotTraces = options?.maxHotTraces ?? DEFAULT_MAX_HOT_TRACES;
	const maxHotTerminalBarriers = options?.maxHotTerminalBarriers ?? DEFAULT_MAX_HOT_TERMINAL_BARRIERS;
	const now = options?.now ?? Date.now();

	const activePtrs = new Set<string>();
	const activeTracePtrs = new Set<string>();
	const liveWaveIds = new Set<string>();
	const protectedTokenIds = new Set<string>();

	for (const barrier of Object.values(state.joinBarriers ?? {})) {
		if (barrier.status === 'waiting') {
			liveWaveIds.add(barrier.waveId);
			protectedTokenIds.add(barrier.parentTokenId);
			for (const cid of barrier.childTokenIds) {
				protectedTokenIds.add(cid);
			}
		}
	}

	for (const tok of Object.values(state.tokens)) {
		const isLive = tok.status === 'active' || tok.status === 'blocked' || tok.status === 'waiting_join';
		const isUnresolvedFailure = tok.status === 'failed' && !tok.supersededByTokenId;
		if (isLive || isUnresolvedFailure || protectedTokenIds.has(tok.id)) {
			protectedTokenIds.add(tok.id);
			if (isLive) {
				liveWaveIds.add(tok.waveId);
			}
			if (tok.payloadPtr) { activePtrs.add(tok.payloadPtr); }
			if (tok.tracePtr) { activeTracePtrs.add(tok.tracePtr); }
			for (const ref of tok.contextRefs ?? []) {
				if (ref.kind !== 'whiteboard') {
					activePtrs.add(ref.ptr);
				}
			}
		}
	}

	// Collect lineage-authorized staff node IDs per pointer BEFORE archiving terminal tokens/barriers
	// so historical externalized artifacts stay readable to their true participants after compaction!
	const authorizedNodesByPtr = new Map<string, Set<string>>();
	const grantPtrNodes = (ptr: string | undefined, nodes: readonly (string | undefined)[]) => {
		if (!ptr || ptr.startsWith('wb:')) {
			return;
		}
		let set = authorizedNodesByPtr.get(ptr);
		if (!set) {
			set = new Set<string>();
			authorizedNodesByPtr.set(ptr, set);
		}
		for (const nid of nodes) {
			if (nid && nid !== 'User') {
				set.add(nid);
			}
		}
	};
	for (const tok of Object.values(state.tokens)) {
		const participants = [tok.nodeId, tok.fromNodeId, tok.returnToNodeId];
		grantPtrNodes(tok.payloadPtr, participants);
		for (const ref of tok.contextRefs ?? []) {
			if (ref.kind !== 'whiteboard') {
				grantPtrNodes(ref.ptr, participants);
			}
		}
		for (const h of tok.hopLog ?? []) {
			grantPtrNodes(h.payloadPtr, participants);
			for (const ap of h.attachedRefPtrs ?? []) {
				grantPtrNodes(ap, participants);
			}
		}
	}
	for (const barrier of Object.values(state.joinBarriers ?? {})) {
		for (const child of Object.values(barrier.settledChildren)) {
			grantPtrNodes(child.payloadPtr, [barrier.ownerNodeId, child.fromNodeId]);
			for (const ap of child.attachedRefPtrs ?? []) {
				grantPtrNodes(ap, [barrier.ownerNodeId, child.fromNodeId]);
			}
		}
	}

	const nextPayloadStore: Record<string, IOrchestrationContextBlob> = {};
	const nextExtIndex: Record<string, IOrchestrationExternalizedBlobMeta> = { ...(state.externalizedBlobIndex ?? {}) };
	const blobsToExternalize: IOrchestrationContextBlob[] = [];
	for (const [ptr, blob] of Object.entries(state.payloadStore ?? {})) {
		const isColdOrLarge = (!activePtrs.has(ptr) && blob.sizeChars >= 256) || blob.sizeChars > hotBlobMaxChars;
		if (isColdOrLarge) {
			blobsToExternalize.push(blob);
			const prevAuth = nextExtIndex[ptr]?.authorizedNodeIds ?? [];
			const mergedAuth = new Set<string>(prevAuth);
			if (blob.authorNodeId && blob.authorNodeId !== 'User') {
				mergedAuth.add(blob.authorNodeId);
			}
			for (const nid of authorizedNodesByPtr.get(ptr) ?? []) {
				mergedAuth.add(nid);
			}
			nextExtIndex[ptr] = {
				ptr: blob.ptr,
				kind: blob.kind,
				title: blob.title,
				sizeChars: blob.sizeChars,
				digest: blob.digest,
				...(blob.authorNodeId ? { authorNodeId: blob.authorNodeId } : {}),
				...(blob.authorAgentId ? { authorAgentId: blob.authorAgentId } : {}),
				...(mergedAuth.size > 0 ? { authorizedNodeIds: [...mergedAuth] } : {}),
				hop: blob.hop,
				waveId: blob.waveId,
				createdAt: blob.createdAt,
			};
		} else {
			nextPayloadStore[ptr] = blob;
		}
	}
	// Also enrich already-externalized entries with any newly observed hot participants before archiving tokens
	for (const [ptr, meta] of Object.entries(nextExtIndex)) {
		const newlySeen = authorizedNodesByPtr.get(ptr);
		if (newlySeen && newlySeen.size > 0) {
			const merged = new Set<string>(meta.authorizedNodeIds ?? []);
			const beforeSize = merged.size;
			for (const nid of newlySeen) {
				merged.add(nid);
			}
			if (merged.size > beforeSize) {
				nextExtIndex[ptr] = {
					...meta,
					authorizedNodeIds: [...merged],
				};
			}
		}
	}

	const archiveEntries: IOrchestrationArchiveEntry[] = [];
	const allTokens = Object.values(state.tokens);
	const terminalTokens = allTokens
		.filter(t => !protectedTokenIds.has(t.id))
		.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
	const archiveTokenIds = new Set<string>();
	if (terminalTokens.length > maxHotTerminalTokens) {
		const excess = terminalTokens.length - maxHotTerminalTokens;
		for (let i = 0; i < excess; i++) {
			archiveTokenIds.add(terminalTokens[i].id);
			archiveEntries.push({ kind: 'token', archivedAt: now, token: terminalTokens[i] });
		}
	}
	const nextTokens: Record<string, IOrchestrationToken> = {};
	for (const [tid, tok] of Object.entries(state.tokens)) {
		if (!archiveTokenIds.has(tid)) {
			nextTokens[tid] = tok;
		}
	}

	const allTraces = Object.values(state.traces);
	const archiveTracePtrs = new Set<string>();
	if (allTraces.length > maxHotTraces) {
		const candidates = allTraces
			.filter(tr => !activeTracePtrs.has(tr.ptr))
			.sort((a, b) => a.timestamp - b.timestamp);
		const excess = allTraces.length - maxHotTraces;
		for (let i = 0; i < Math.min(excess, candidates.length); i++) {
			archiveTracePtrs.add(candidates[i].ptr);
			archiveEntries.push({ kind: 'trace', archivedAt: now, trace: candidates[i] });
		}
	}
	const nextTraces: Record<string, IMissionTraceNode> = {};
	for (const [ptr, tr] of Object.entries(state.traces)) {
		if (!archiveTracePtrs.has(ptr)) {
			nextTraces[ptr] = tr;
		}
	}

	// Prune excess terminal joinBarriers whose wave/parent is no longer active
	let barriersPruned = false;
	let nextJoinBarriers = state.joinBarriers;
	if (state.joinBarriers) {
		const allBarriers = Object.values(state.joinBarriers);
		const terminalBarriers = allBarriers
			.filter(b => b.status !== 'waiting' && !liveWaveIds.has(b.waveId))
			.sort((a, b) => (a.satisfiedAt ?? a.createdAt) - (b.satisfiedAt ?? b.createdAt));
		if (terminalBarriers.length > maxHotTerminalBarriers) {
			const dropIds = new Set<string>();
			const excess = terminalBarriers.length - maxHotTerminalBarriers;
			for (let i = 0; i < excess; i++) {
				dropIds.add(terminalBarriers[i].id);
			}
			const keptBarriers: Record<string, IOrchestrationJoinBarrier> = {};
			for (const [bid, b] of Object.entries(state.joinBarriers)) {
				if (!dropIds.has(bid)) {
					keptBarriers[bid] = b;
				}
			}
			nextJoinBarriers = keptBarriers;
			barriersPruned = dropIds.size > 0;
		}
	}

	// Prune nodeReadCursors belonging to completely finished waves (zero live tokens/barriers)
	let cursorsPruned = false;
	let nextCursors = state.nodeReadCursors;
	if (state.nodeReadCursors) {
		const keptCursors: Record<string, IOrchestrationNodeReadCursor> = {};
		for (const [key, cursor] of Object.entries(state.nodeReadCursors)) {
			const colonIdx = key.indexOf(':');
			const waveId = colonIdx > 0 ? key.slice(0, colonIdx) : '';
			if (!waveId || liveWaveIds.has(waveId)) {
				keptCursors[key] = cursor;
			} else {
				cursorsPruned = true;
			}
		}
		if (cursorsPruned) {
			nextCursors = keptCursors;
		}
	}

	const didCompact = blobsToExternalize.length > 0 || archiveEntries.length > 0 || barriersPruned || cursorsPruned;
	if (!didCompact) {
		return { compactedState: state, blobsToExternalize: [], archiveEntries: [], didCompact: false };
	}

	return {
		compactedState: {
			...state,
			tokens: nextTokens,
			traces: nextTraces,
			...(nextJoinBarriers ? { joinBarriers: nextJoinBarriers } : {}),
			...(nextCursors ? { nodeReadCursors: nextCursors } : {}),
			payloadStore: nextPayloadStore,
			externalizedBlobIndex: nextExtIndex,
			archivedTokenCount: (state.archivedTokenCount ?? 0) + archiveTokenIds.size,
			archivedTraceCount: (state.archivedTraceCount ?? 0) + archiveTracePtrs.size,
			stateRevision: (state.stateRevision ?? 0) + 1,
		},
		blobsToExternalize,
		archiveEntries,
		didCompact: true,
	};
}

/**
 * Verifies that a serialized Orchestration token payload contains ZERO full body text
 * from either Department Whiteboards or `payloadStore` blobs.
 */
export function isLightweightOrchestrationToken(
	token: IOrchestrationToken,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	payloadStore?: Readonly<Record<string, IOrchestrationContextBlob>>,
): boolean {
	if (token.lastSummary.length > ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS + 4) {
		return false;
	}
	for (const ref of token.contextRefs ?? []) {
		if (Object.prototype.hasOwnProperty.call(ref, 'content')) {
			return false;
		}
	}
	for (const ptr of token.whiteboardPointers ?? []) {
		if (Object.prototype.hasOwnProperty.call(ptr, 'content')) {
			return false;
		}
		if (whiteboards) {
			const wb = whiteboards[ptr.whiteboardId];
			if (wb && wb.content.length >= 24 && token.lastSummary.includes(wb.content)) {
				return false;
			}
		}
	}
	if (payloadStore) {
		for (const ref of token.contextRefs ?? []) {
			if (ref.kind === 'whiteboard') {
				continue;
			}
			const blob = payloadStore[ref.ptr];
			if (blob && blob.content.length > ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS && token.lastSummary.includes(blob.content)) {
				return false;
			}
		}
	}
	return true;
}
