/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared Orchestration Pipeline Primitives:
 * - Fail-closed holder identity verification (`assertOrchestrationTokenHolder`)
 * - O(1) staff graph index (`buildStaffGraphIndex`)
 * - Unified content-addressed context staging with hot + externalized blob fallback (`stageTransitionContext`)
 * - Context-Economy v2 token wakeup prompt composer (`composeOrchestrationTokenWakeupPrompt`)
 * - Unified dispatch effect builder (`buildOrchestrationDispatchEffect`)
 */

import { buildTokenSystemEnvelopeLines, sanitizeAdeSystemEnvelopeHeaders } from './adeMessageEnvelope.js';
import { IMissionDagParseResult } from './adeMissionDag.js';
import { IOrchestrationGraphNode, IOrchestrationGraphParseResult } from './adeOrchestrationGraph.js';
import { canCallerCompleteMissionTask, syncMissionTaskStatusesFromOrchestration } from './adeOrchestrationTasks.js';
import {
	buildCompactHeadline,
	buildOrchestrationTokenDeltaView,
	buildWhiteboardContextRef,
	computeOrchestrationContentDigest,
	getHighestRankInSchema,
	IMissionTaskStatusRecord,
	IOrchestrationBarrierFileConflict,
	IOrchestrationContextBlob,
	IOrchestrationContextBlobInput,
	IOrchestrationContextRef,
	IOrchestrationExternalizedBlobMeta,
	IOrchestrationJoinBarrier,
	IOrchestrationJoinBarrierChildResult,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationTokenDeltaView,
	IOrchestrationWhiteboard,
	IOrchestrationWhiteboardPointer,
	ORCHESTRATION_SILENCE_REMINDER_MINUTES,
	OrchestrationEngineEffect,
	OrchestrationNodeRuntimeStatus,
	OrchestrationRefKind,
	refreshContextRefsWithLiveWhiteboards,
	resolveEffectiveStaffTier,
} from './adeOrchestrationTypes.js';
import { buildWhiteboardPointers } from './adeOrchestrationWhiteboards.js';
import { IAdeOrganizationConfig } from './adeRoleSchema.js';

export interface IOrchestrationStaffGraphIndex {
	readonly staffById: ReadonlyMap<string, IOrchestrationGraphNode>;
	readonly outgoingStaffByNode: ReadonlyMap<string, readonly string[]>;
	readonly topStaffId?: string;
}

export interface IBoundTaskCompletionAuthority {
	readonly canComplete: boolean;
	readonly isHumanGate?: boolean;
	readonly ownerNodeId?: string;
	readonly minCompleterTier?: number;
}

export function findHighestRankStaffNode(
	graph: IOrchestrationGraphParseResult,
): IOrchestrationGraphNode | undefined {
	const staff = graph.nodes.filter(n => n.kind === 'staff');
	if (staff.length === 0) {
		return undefined;
	}
	const inDeg = new Map<string, number>();
	for (const e of graph.edges) {
		if (!e.isCycleBackEdge) {
			inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
		}
	}
	const sorted = [...staff].sort((a, b) => {
		const ta = a.tier ?? 99;
		const tb = b.tier ?? 99;
		if (ta !== tb) {
			return ta - tb;
		}
		return (inDeg.get(a.id) ?? 0) - (inDeg.get(b.id) ?? 0);
	});
	return sorted[0];
}

export function buildStaffGraphIndex(graph: IOrchestrationGraphParseResult): IOrchestrationStaffGraphIndex {
	const staffById = new Map<string, IOrchestrationGraphNode>();
	const outgoingMap = new Map<string, string[]>();
	for (const n of graph.nodes) {
		if (n.kind === 'staff') {
			staffById.set(n.id, n);
			outgoingMap.set(n.id, []);
		}
	}
	const seenEdge = new Set<string>();
	for (const e of graph.edges) {
		if (!staffById.has(e.from) || !staffById.has(e.to)) {
			continue;
		}
		const key = `${e.from}->${e.to}`;
		if (seenEdge.has(key)) {
			continue;
		}
		seenEdge.add(key);
		outgoingMap.get(e.from)!.push(e.to);
	}
	return {
		staffById,
		outgoingStaffByNode: outgoingMap,
		topStaffId: findHighestRankStaffNode(graph)?.id,
	};
}

/**
 * Fail-closed holder identity verification for token mutations.
 * - When `callerAgentId === undefined` (Human / headless system / unit tests), returns `{ ok: true }`.
 * - Whenever `callerAgentId` IS provided, resolves `nodeAgentIds[nodeId] ?? token.holderAgentId ?? graphNode?.agentId`
 *   and FAILS CLOSED if no bound agent exists or if it differs from `callerAgentId`.
 */
export function assertOrchestrationTokenHolder(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	token: IOrchestrationToken,
	callerAgentId: string | undefined,
): { readonly ok: true } | { readonly ok: false; readonly code: 'FORBIDDEN'; readonly error: string } {
	if (callerAgentId === undefined) {
		return { ok: true };
	}
	const graphNode = graph.nodes.find(n => n.id === token.nodeId && n.kind === 'staff');
	const boundHolder = state.nodeAgentIds[token.nodeId] ?? token.holderAgentId ?? graphNode?.agentId;
	if (!boundHolder) {
		return {
			ok: false,
			code: 'FORBIDDEN',
			error: `FORBIDDEN: Token "${token.id}" on staff "${token.nodeId}" has no bound agent session; caller "${callerAgentId}" is not authorized to mutate it.`,
		};
	}
	if (boundHolder !== callerAgentId) {
		return {
			ok: false,
			code: 'FORBIDDEN',
			error: `Token "${token.id}" is held by "${boundHolder}", not caller "${callerAgentId}".`,
		};
	}
	return { ok: true };
}

export function buildPayloadDigestIndex(
	store: Readonly<Record<string, IOrchestrationContextBlob>>,
): Map<string, IOrchestrationContextBlob[]> {
	const index = new Map<string, IOrchestrationContextBlob[]>();
	for (const blob of Object.values(store)) {
		const key = `${blob.kind}:${blob.digest}:${blob.sizeChars}`;
		let bucket = index.get(key);
		if (!bucket) {
			bucket = [];
			index.set(key, bucket);
		}
		bucket.push(blob);
	}
	return index;
}

export function storeOrReuseContextBlob(
	store: Record<string, IOrchestrationContextBlob>,
	seqRef: { value: number },
	params: {
		readonly kind: Exclude<OrchestrationRefKind, 'whiteboard'>;
		readonly title: string;
		readonly content: string;
		readonly authorNodeId?: string;
		readonly authorAgentId?: string;
		readonly hop: number;
		readonly waveId: string;
		readonly now: number;
	},
	externalizedIndex?: Readonly<Record<string, IOrchestrationExternalizedBlobMeta>>,
	digestIndex?: Map<string, IOrchestrationContextBlob[]>,
): IOrchestrationContextRef {
	const cleanContent = params.content.trim();
	const cleanTitle = params.title.replace(/\s+/g, ' ').trim().slice(0, 100) || `${params.kind} #${params.hop}`;
	const digest = computeOrchestrationContentDigest(cleanContent);
	const key = `${params.kind}:${digest}:${cleanContent.length}`;

	// O(1) content-addressed deduplication against hot payloadStore
	if (digestIndex) {
		const bucket = digestIndex.get(key);
		if (bucket) {
			for (const existing of bucket) {
				if (existing.content === cleanContent) {
					return {
						ptr: existing.ptr,
						kind: existing.kind,
						title: existing.title,
						version: 1,
						updatedAtHop: params.hop,
						...(existing.authorNodeId ? { authorNodeId: existing.authorNodeId } : {}),
						sizeChars: existing.sizeChars,
						digest: existing.digest,
					};
				}
			}
		}
	} else {
		for (const existing of Object.values(store)) {
			if (existing.kind === params.kind && existing.digest === digest && existing.content === cleanContent) {
				return {
					ptr: existing.ptr,
					kind: existing.kind,
					title: existing.title,
					version: 1,
					updatedAtHop: params.hop,
					...(existing.authorNodeId ? { authorNodeId: existing.authorNodeId } : {}),
					sizeChars: existing.sizeChars,
					digest: existing.digest,
				};
			}
		}
	}

	// Fallback deduplication against externalized cold blob index (matches kind + digest + length + title)
	if (externalizedIndex) {
		for (const meta of Object.values(externalizedIndex)) {
			if (
				meta.kind === params.kind
				&& meta.digest === digest
				&& meta.sizeChars === cleanContent.length
				&& meta.title === cleanTitle
			) {
				return {
					ptr: meta.ptr,
					kind: meta.kind,
					title: meta.title,
					version: 1,
					updatedAtHop: params.hop,
					...(meta.authorNodeId ? { authorNodeId: meta.authorNodeId } : {}),
					sizeChars: meta.sizeChars,
					digest: meta.digest,
				};
			}
		}
	}

	seqRef.value += 1;
	const prefix = params.kind === 'handoff' ? 'hop' : params.kind === 'artifact' ? 'art' : 'dec';
	const ptr = `${prefix}-${seqRef.value}`;
	const blob: IOrchestrationContextBlob = {
		ptr,
		kind: params.kind,
		title: cleanTitle,
		content: cleanContent,
		sizeChars: cleanContent.length,
		digest,
		...(params.authorNodeId ? { authorNodeId: params.authorNodeId } : {}),
		...(params.authorAgentId ? { authorAgentId: params.authorAgentId } : {}),
		hop: params.hop,
		waveId: params.waveId,
		createdAt: params.now,
	};
	store[ptr] = blob;
	if (digestIndex) {
		let bucket = digestIndex.get(key);
		if (!bucket) {
			bucket = [];
			digestIndex.set(key, bucket);
		}
		bucket.push(blob);
	}
	return {
		ptr,
		kind: blob.kind,
		title: blob.title,
		version: 1,
		updatedAtHop: params.hop,
		...(blob.authorNodeId ? { authorNodeId: blob.authorNodeId } : {}),
		sizeChars: blob.sizeChars,
		digest: blob.digest,
	};
}

export interface IStagedTransitionContext {
	readonly headline: string;
	readonly rawDetail: string;
	readonly payloadPtr?: string;
	readonly contextRefs: readonly IOrchestrationContextRef[];
	readonly whiteboardPointers: readonly IOrchestrationWhiteboardPointer[];
	readonly attachedRefPtrs: readonly string[];
	readonly allObservedRefs: readonly IOrchestrationContextRef[];
}

/**
 * Unified context staging for all token transitions (dispatch, handoff, mint, return, complete, reject):
 * - Spills long summary or explicit `detail` into an independent `hop-N` pointer (kept on `payloadPtr` & `hopLog`, NOT bloating `contextRefs`).
 * - Stores artifacts (`art-N`) and decisions (`dec-N`) with content-addressed deduplication (hot + externalized).
 * - Re-pins `refPtrs` from BOTH hot `payloadStore` AND cold `externalizedBlobIndex` plus validated whiteboards.
 * - Refreshes & merges lightweight `whiteboardPointers` with live whiteboard metadata.
 */
export function stageTransitionContext(params: {
	readonly payloadStore: Record<string, IOrchestrationContextBlob>;
	readonly payloadSeqRef: { value: number };
	readonly externalizedBlobIndex?: Readonly<Record<string, IOrchestrationExternalizedBlobMeta>>;
	readonly digestIndex?: Map<string, IOrchestrationContextBlob[]>;
	readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
	readonly baseRefs?: readonly IOrchestrationContextRef[];
	readonly baseWhiteboardPointers?: readonly IOrchestrationWhiteboardPointer[];
	readonly summary: string;
	readonly detail?: string;
	readonly detailTitle: string;
	readonly authorNodeId?: string;
	readonly authorAgentId?: string;
	readonly hop: number;
	readonly waveId: string;
	readonly now: number;
	readonly artifacts?: readonly IOrchestrationContextBlobInput[];
	readonly decisions?: readonly IOrchestrationContextBlobInput[];
	readonly refPtrs?: readonly string[];
	readonly normalizedWhiteboardIds?: readonly string[];
	readonly defaultArtifactTitle?: string;
	readonly defaultDecisionTitle?: string;
}): IStagedTransitionContext {
	const { headline, wasTruncated } = buildCompactHeadline(params.summary);
	const rawDetail = params.detail?.trim() || (wasTruncated ? params.summary.trim() : '');
	const digestIndex = params.digestIndex ?? buildPayloadDigestIndex(params.payloadStore);

	const refreshedBaseRefs = refreshContextRefsWithLiveWhiteboards(
		params.baseRefs,
		params.whiteboards,
		params.baseWhiteboardPointers,
		params.hop,
	);
	const mergedRefMap = new Map<string, IOrchestrationContextRef>();
	const observedRefMap = new Map<string, IOrchestrationContextRef>();
	for (const ref of refreshedBaseRefs) {
		mergedRefMap.set(ref.ptr, ref);
		observedRefMap.set(ref.ptr, ref);
	}

	const newlyAttachedPtrs: string[] = [];
	let payloadPtr: string | undefined;
	if (rawDetail) {
		const hopRef = storeOrReuseContextBlob(
			params.payloadStore,
			params.payloadSeqRef,
			{
				kind: 'handoff',
				title: params.detailTitle,
				content: rawDetail,
				authorNodeId: params.authorNodeId,
				authorAgentId: params.authorAgentId,
				hop: params.hop,
				waveId: params.waveId,
				now: params.now,
			},
			params.externalizedBlobIndex,
			digestIndex,
		);
		payloadPtr = hopRef.ptr;
		observedRefMap.set(hopRef.ptr, hopRef);
	}

	for (const art of params.artifacts ?? []) {
		if (art.content.trim()) {
			const ref = storeOrReuseContextBlob(
				params.payloadStore,
				params.payloadSeqRef,
				{
					kind: 'artifact',
					title: art.title || params.defaultArtifactTitle || (params.authorNodeId ? `Artifact from ${params.authorNodeId}` : 'Artifact'),
					content: art.content,
					authorNodeId: params.authorNodeId,
					authorAgentId: params.authorAgentId,
					hop: params.hop,
					waveId: params.waveId,
					now: params.now,
				},
				params.externalizedBlobIndex,
				digestIndex,
			);
			mergedRefMap.set(ref.ptr, ref);
			observedRefMap.set(ref.ptr, ref);
			newlyAttachedPtrs.push(ref.ptr);
		}
	}

	for (const dec of params.decisions ?? []) {
		if (dec.content.trim()) {
			const ref = storeOrReuseContextBlob(
				params.payloadStore,
				params.payloadSeqRef,
				{
					kind: 'decision',
					title: dec.title || params.defaultDecisionTitle || (params.authorNodeId ? `Decision by ${params.authorNodeId}` : 'Decision'),
					content: dec.content,
					authorNodeId: params.authorNodeId,
					authorAgentId: params.authorAgentId,
					hop: params.hop,
					waveId: params.waveId,
					now: params.now,
				},
				params.externalizedBlobIndex,
				digestIndex,
			);
			mergedRefMap.set(ref.ptr, ref);
			observedRefMap.set(ref.ptr, ref);
			newlyAttachedPtrs.push(ref.ptr);
		}
	}

	// Re-pin explicitly referenced pointers from hot payloadStore, cold externalizedBlobIndex, or whiteboards
	const extraWbIds: string[] = [];
	for (const rawPtr of params.refPtrs ?? []) {
		const ptr = rawPtr.trim();
		if (!ptr || mergedRefMap.has(ptr)) {
			continue;
		}
		const blob = params.payloadStore[ptr];
		if (blob) {
			const ref: IOrchestrationContextRef = {
				ptr: blob.ptr,
				kind: blob.kind,
				title: blob.title,
				version: 1,
				updatedAtHop: blob.hop,
				...(blob.authorNodeId ? { authorNodeId: blob.authorNodeId } : {}),
				sizeChars: blob.sizeChars,
				digest: blob.digest,
			};
			mergedRefMap.set(ptr, ref);
			observedRefMap.set(ptr, ref);
			newlyAttachedPtrs.push(ptr);
			continue;
		}
		const extMeta = params.externalizedBlobIndex?.[ptr];
		if (extMeta) {
			const ref: IOrchestrationContextRef = {
				ptr: extMeta.ptr,
				kind: extMeta.kind,
				title: extMeta.title,
				version: 1,
				updatedAtHop: extMeta.hop,
				...(extMeta.authorNodeId ? { authorNodeId: extMeta.authorNodeId } : {}),
				sizeChars: extMeta.sizeChars,
				digest: extMeta.digest,
			};
			mergedRefMap.set(ptr, ref);
			observedRefMap.set(ptr, ref);
			newlyAttachedPtrs.push(ptr);
			continue;
		}
		const wbId = ptr.startsWith('wb:') ? ptr.slice(3) : ptr;
		if (params.whiteboards?.[wbId]) {
			extraWbIds.push(wbId);
		}
	}

	const newPointers = buildWhiteboardPointers(params.whiteboards, [...(params.normalizedWhiteboardIds ?? []), ...extraWbIds]);
	const mergedPointerMap = new Map<string, IOrchestrationWhiteboardPointer>();
	for (const p of params.baseWhiteboardPointers ?? []) {
		const liveWb = params.whiteboards?.[p.whiteboardId];
		mergedPointerMap.set(p.whiteboardId, liveWb
			? { whiteboardId: liveWb.id, department: liveWb.department, title: liveWb.title, version: liveWb.version }
			: p);
	}
	for (const p of newPointers) {
		mergedPointerMap.set(p.whiteboardId, p);
		const liveWb = params.whiteboards?.[p.whiteboardId];
		const wbRef = liveWb
			? buildWhiteboardContextRef(liveWb, params.hop)
			: { ptr: `wb:${p.whiteboardId}`, kind: 'whiteboard' as const, title: p.title, version: p.version, updatedAtHop: params.hop, department: p.department, sizeChars: 0 };
		mergedRefMap.set(wbRef.ptr, wbRef);
		observedRefMap.set(wbRef.ptr, wbRef);
		newlyAttachedPtrs.push(wbRef.ptr);
	}

	return {
		headline,
		rawDetail,
		...(payloadPtr ? { payloadPtr } : {}),
		contextRefs: [...mergedRefMap.values()],
		whiteboardPointers: [...mergedPointerMap.values()],
		attachedRefPtrs: [...new Set(newlyAttachedPtrs)],
		allObservedRefs: [...observedRefMap.values()],
	};
}

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * Canonicalizes a repo-relative POSIX path or glob pattern, failing closed on control chars/NUL/newlines,
 * absolute paths, home-relative paths (`~`), Windows drive prefixes (even after `./`), or `..` traversal segments.
 */
export function normalizeRepoRelativePath(
	raw: string,
	options?: { readonly allowGlobWildcards?: boolean; readonly allowNegation?: boolean },
): { readonly ok: true; readonly path: string; readonly negated?: boolean } | { readonly ok: false; readonly reason: string } {
	if (CONTROL_CHAR_RE.test(raw)) {
		return { ok: false, reason: `Path contains illegal control character or newline.` };
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		return { ok: false, reason: 'Path must be non-empty.' };
	}
	let negated = false;
	let body = trimmed;
	if (options?.allowNegation && body.startsWith('!')) {
		negated = true;
		body = body.slice(1).trim();
		if (!body) {
			return { ok: false, reason: `Negated scope pattern "${raw}" is empty.` };
		}
	}
	const posix = body.replace(/\\/g, '/');
	if (posix.startsWith('/') || posix.startsWith('~') || WINDOWS_DRIVE_RE.test(posix)) {
		return { ok: false, reason: `Absolute or home-relative path "${raw}" is forbidden; use repo-relative paths only.` };
	}
	const rawSegments = posix.split('/');
	const cleanSegments: string[] = [];
	for (const seg of rawSegments) {
		if (!seg || seg === '.') {
			continue;
		}
		if (seg === '..') {
			return { ok: false, reason: `Path traversal segment ".." in "${raw}" is forbidden.` };
		}
		cleanSegments.push(seg);
	}
	if (cleanSegments.length === 0) {
		if (options?.allowGlobWildcards && (posix === '.' || posix === './')) {
			return { ok: true, path: '.', ...(negated ? { negated: true } : {}) };
		}
		return { ok: false, reason: `Path "${raw}" resolves to empty repo root.` };
	}
	// Re-check first normalized segment after stripping leading `./` to defeat `./C:/...` and `./~/...` bypasses
	const firstSeg = cleanSegments[0];
	if (firstSeg.startsWith('~') || WINDOWS_DRIVE_RE.test(firstSeg) || firstSeg.includes(':')) {
		return { ok: false, reason: `Absolute, drive-prefixed, or home-relative path "${raw}" is forbidden.` };
	}
	return { ok: true, path: cleanSegments.join('/'), ...(negated ? { negated: true } : {}) };
}

function escapeRegExpChar(ch: string): string {
	return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function collapseRedundantGlobWildcards(normPattern: string): string {
	return normPattern
		.replace(/\*{3,}/g, '**')
		.replace(/(?:\*\*\/)+/g, '**/')
		.replace(/(?:\/\*\*)+/g, '/**');
}

function compileSingleGlobRegex(normPattern: string): RegExp {
	const collapsed = collapseRedundantGlobWildcards(normPattern);
	if (collapsed === '.' || collapsed === '**') {
		return /^.+$/;
	}
	const hasWildcard = collapsed.includes('*') || collapsed.includes('?');
	if (!hasWildcard) {
		const escaped = [...collapsed].map(escapeRegExpChar).join('');
		return new RegExp(`^${escaped}(?:/.*)?$`);
	}
	let regexStr = '^';
	let i = 0;
	while (i < collapsed.length) {
		if (collapsed[i] === '*' && collapsed[i + 1] === '*') {
			if (collapsed[i + 2] === '/') {
				regexStr += '(?:.+/)?';
				i += 3;
			} else {
				// Keep preceding `/` intact so `src/**` matches files under `src/` (not bare file `src`),
				// `src/**.ts` never matches root `src.ts`, and `**/**` never corrupts `(?:.+/)?`!
				regexStr += '.*';
				i += 2;
			}
		} else if (collapsed[i] === '*') {
			regexStr += '[^/]*';
			i += 1;
		} else if (collapsed[i] === '?') {
			regexStr += '[^/]';
			i += 1;
		} else {
			regexStr += escapeRegExpChar(collapsed[i]);
			i += 1;
		}
	}
	regexStr += '$';
	return new RegExp(regexStr);
}

/**
 * Deterministic POSIX repo-relative glob matcher supporting `*`, `**`, `?`, and bare directory prefixes.
 * Always fails closed on `..` traversal, absolute paths, or NUL bytes.
 */
export function matchRepoScopeGlob(filePath: string, globPattern: string): boolean {
	const normFile = normalizeRepoRelativePath(filePath);
	if (!normFile.ok) {
		return false;
	}
	const normPat = normalizeRepoRelativePath(globPattern, { allowGlobWildcards: true });
	if (!normPat.ok) {
		return false;
	}
	return compileSingleGlobRegex(normPat.path).test(normFile.path);
}

/**
 * Evaluates a repo-relative file path against an ordered list of scope patterns supporting `!negation`.
 * If only negated patterns are provided, starts from implicit `**` and excludes negated matches.
 */
export function matchesRepoScopePatterns(filePath: string, patterns: readonly string[]): boolean {
	const normFile = normalizeRepoRelativePath(filePath);
	if (!normFile.ok) {
		return false;
	}
	const parsed: { readonly path: string; readonly negated: boolean }[] = [];
	for (const raw of patterns) {
		const norm = normalizeRepoRelativePath(raw, { allowGlobWildcards: true, allowNegation: true });
		if (norm.ok) {
			parsed.push({ path: norm.path, negated: Boolean(norm.negated) });
		}
	}
	if (parsed.length === 0) {
		return false;
	}
	const hasPositive = parsed.some(p => !p.negated);
	let matched = !hasPositive;
	for (const entry of parsed) {
		const hit = compileSingleGlobRegex(entry.path).test(normFile.path);
		if (!entry.negated && hit) {
			matched = true;
		} else if (entry.negated && hit) {
			matched = false;
		}
	}
	return matched;
}

/**
 * Normalizes and validates reported modified files, failing closed on any traversal or absolute path.
 */
export function normalizeModifiedFiles(
	files: readonly string[] | undefined,
): { readonly ok: true; readonly files: readonly string[] } | { readonly ok: false; readonly invalidPaths: readonly string[]; readonly error: string } {
	if (!files || files.length === 0) {
		return { ok: true, files: [] };
	}
	const normalized: string[] = [];
	const invalidPaths: string[] = [];
	for (const raw of files) {
		if (!raw || !raw.trim()) {
			continue;
		}
		const res = normalizeRepoRelativePath(raw);
		if (!res.ok) {
			invalidPaths.push(raw.trim());
		} else {
			normalized.push(res.path);
		}
	}
	if (invalidPaths.length > 0) {
		return {
			ok: false,
			invalidPaths,
			error: `ALLOWED_PATHS_VIOLATION: invalid or escaping file path(s) rejected: ${invalidPaths.join(', ')}.`,
		};
	}
	return { ok: true, files: [...new Set(normalized)] };
}

function looksLikeConcreteFilePath(normPattern: string, rawPattern?: string): boolean {
	if (rawPattern && /[\\/]\s*$/.test(rawPattern)) {
		return false;
	}
	if (normPattern === '.' || normPattern.includes('*') || normPattern.includes('?')) {
		return false;
	}
	const lastSlash = normPattern.lastIndexOf('/');
	const basename = lastSlash >= 0 ? normPattern.slice(lastSlash + 1) : normPattern;
	return basename.length > 2 && /^[^.].*\.[^.]+$/.test(basename);
}

function buildPatternWitnesses(normPattern: string, rawPattern?: string): readonly string[] {
	if (normPattern === '.' || normPattern === '**') {
		return ['__w_root__', '__w_dir__/__w_sub__/__w_file__.txt'];
	}
	const hasWildcard = normPattern.includes('*') || normPattern.includes('?');
	if (!hasWildcard) {
		if (looksLikeConcreteFilePath(normPattern, rawPattern)) {
			return [normPattern];
		}
		return [normPattern, `${normPattern}/__w_sub__/__w_file__.txt`];
	}
	const shallow = normPattern
		.replace(/\*\*\//g, '')
		.replace(/\/\*\*/g, '/__w_leaf__')
		.replace(/\*\*/g, '__w_leaf__')
		.replace(/\*/g, '__w_tok__')
		.replace(/\?/g, 'x');
	const deep = normPattern
		.replace(/\*\*\//g, '__w_d1__/__w_d2__/')
		.replace(/\/\*\*/g, '/__w_d1__/__w_d2__/__w_leaf__.bin')
		.replace(/\*\*/g, '__w_d1__/__w_d2__/__w_leaf__.bin')
		.replace(/\*/g, '__w_tok2__')
		.replace(/\?/g, 'y');
	return [...new Set([shallow, deep].filter(w => normalizeRepoRelativePath(w).ok))];
}

function intersectGlobSegment(segA: string, segB: string, fillerChar = 'a'): string | undefined {
	const memo = new Map<number, string | null>();
	const cols = segB.length + 1;
	const solve = (ia: number, ib: number): string | null => {
		const key = ia * cols + ib;
		const cached = memo.get(key);
		if (cached !== undefined) {
			return cached;
		}
		let res: string | null = null;
		if (ia === segA.length && ib === segB.length) {
			res = '';
		} else if (ia < segA.length && segA[ia] === '*') {
			// Skip '*' first (minimal witness), else consume one char from B
			const skipA = solve(ia + 1, ib);
			if (skipA !== null) {
				res = skipA;
			} else if (ib < segB.length) {
				if (segB[ib] === '*') {
					res = solve(ia, ib + 1);
				} else if (segB[ib] === '?') {
					const rest = solve(ia, ib + 1);
					res = rest !== null ? `${fillerChar}${rest}` : null;
				} else {
					const rest = solve(ia, ib + 1);
					res = rest !== null ? `${segB[ib]}${rest}` : null;
				}
			}
		} else if (ib < segB.length && segB[ib] === '*') {
			const skipB = solve(ia, ib + 1);
			if (skipB !== null) {
				res = skipB;
			} else if (ia < segA.length) {
				if (segA[ia] === '?') {
					const rest = solve(ia + 1, ib);
					res = rest !== null ? `${fillerChar}${rest}` : null;
				} else {
					const rest = solve(ia + 1, ib);
					res = rest !== null ? `${segA[ia]}${rest}` : null;
				}
			}
		} else if (ia < segA.length && ib < segB.length) {
			const ca = segA[ia];
			const cb = segB[ib];
			if (ca === '?' && cb === '?') {
				const rest = solve(ia + 1, ib + 1);
				res = rest !== null ? `${fillerChar}${rest}` : null;
			} else if (ca === '?') {
				const rest = solve(ia + 1, ib + 1);
				res = rest !== null ? `${cb}${rest}` : null;
			} else if (cb === '?') {
				const rest = solve(ia + 1, ib + 1);
				res = rest !== null ? `${ca}${rest}` : null;
			} else if (ca === cb) {
				const rest = solve(ia + 1, ib + 1);
				res = rest !== null ? `${ca}${rest}` : null;
			}
		}
		memo.set(key, res);
		return res;
	};
	const ans = solve(0, 0);
	if (ans === null) {
		return undefined;
	}
	if (!ans || ans === '.' || ans === '..') {
		// Ensure non-empty legal POSIX segment when wildcards matched empty string
		if (segA.includes('*') && segB.includes('*')) {
			return `${fillerChar}__w`;
		}
		return undefined;
	}
	return ans;
}

function toGlobSegments(normPattern: string, rawPattern?: string): readonly string[] {
	if (normPattern === '.' || normPattern === '**') {
		return ['**'];
	}
	const rawSegs = normPattern.split('/');
	const hasWildcard = normPattern.includes('*') || normPattern.includes('?');
	if (!hasWildcard && !looksLikeConcreteFilePath(normPattern, rawPattern)) {
		return [...rawSegs, '**'];
	}
	return rawSegs;
}

/**
 * Memoized segment-level glob intersection synthesizer:
 * Finds concrete repo-relative witness path(s) matching BOTH `patA` and `patB` across `*`, `**`, `?`,
 * and bare directory prefixes (catching cross-wildcard overlaps like `**\/*.ts` vs `src/**` and `src/*\/index.ts` vs `src/api/*.ts`).
 */
function synthesizeGlobIntersectionWitnesses(patA: string, patB: string, rawA?: string, rawB?: string): readonly string[] {
	const segsA = toGlobSegments(patA, rawA);
	const segsB = toGlobSegments(patB, rawB);
	const witnesses = new Set<string>();
	const runWithFiller = (filler: string, preferDeep: boolean) => {
		const memo = new Map<number, string[] | null>();
		const cols = segsB.length + 1;
		const solve = (ia: number, ib: number): string[] | null => {
			const key = ia * cols + ib;
			const cached = memo.get(key);
			if (cached !== undefined) {
				return cached;
			}
			let res: string[] | null = null;
			if (ia === segsA.length && ib === segsB.length) {
				res = [];
			} else if (ia < segsA.length && segsA[ia] === '**') {
				const branches: Array<() => string[] | null> = [
					// Consume one segment from B under A's '**'
					() => {
						if (ib >= segsB.length) {
							return null;
						}
						if (segsB[ib] === '**') {
							const rest = solve(ia + 1, ib + 1);
							return rest !== null ? [preferDeep ? `__w_${filler}1__` : `__w_${filler}__`, ...rest] : null;
						}
						const concrete = intersectGlobSegment('*', segsB[ib], filler);
						if (!concrete) {
							return null;
						}
						const rest = solve(ia, ib + 1);
						return rest !== null ? [concrete, ...rest] : null;
					},
					// Skip '**' (zero segments)
					() => solve(ia + 1, ib),
				];
				for (const fn of (preferDeep ? branches : [...branches].reverse())) {
					const cand = fn();
					if (cand !== null) {
						res = cand;
						break;
					}
				}
			} else if (ib < segsB.length && segsB[ib] === '**') {
				const branches: Array<() => string[] | null> = [
					() => {
						if (ia >= segsA.length) {
							return null;
						}
						const concrete = intersectGlobSegment(segsA[ia], '*', filler);
						if (!concrete) {
							return null;
						}
						const rest = solve(ia + 1, ib);
						return rest !== null ? [concrete, ...rest] : null;
					},
					() => solve(ia, ib + 1),
				];
				for (const fn of (preferDeep ? branches : [...branches].reverse())) {
					const cand = fn();
					if (cand !== null) {
						res = cand;
						break;
					}
				}
			} else if (ia < segsA.length && ib < segsB.length) {
				const seg = intersectGlobSegment(segsA[ia], segsB[ib], filler);
				if (seg) {
					const rest = solve(ia + 1, ib + 1);
					if (rest !== null) {
						res = [seg, ...rest];
					}
				}
			}
			memo.set(key, res);
			return res;
		};
		const parts = solve(0, 0);
		if (parts && parts.length > 0) {
			const candidate = parts.join('/');
			if (normalizeRepoRelativePath(candidate).ok) {
				witnesses.add(candidate);
			}
		}
	};
	runWithFiller('a', false);
	runWithFiller('z', true);
	return [...witnesses];
}

/**
 * Checks whether a branch `scopePattern` is validly contained within a staff node's `allowedPaths`.
 */
export function isScopePatternSubsetOfAllowed(
	scopePattern: string,
	allowedPaths: readonly string[] | undefined,
): boolean {
	const normScope = normalizeRepoRelativePath(scopePattern, { allowGlobWildcards: true, allowNegation: true });
	if (!normScope.ok) {
		return false;
	}
	if (!allowedPaths || allowedPaths.length === 0) {
		return true;
	}
	// Negation patterns only narrow scope further
	if (normScope.negated) {
		return true;
	}
	const witnesses = buildPatternWitnesses(normScope.path, scopePattern);
	return witnesses.length > 0 && witnesses.every(w => matchesRepoScopePatterns(w, allowedPaths));
}

/**
 * Validates that an entire branch `scopePatterns` list is strictly contained within `allowedPaths`,
 * including negation-only scopes (implicit `**`) and `!negation` exclusions in `allowedPaths`.
 */
export function areScopePatternsSubsetOfAllowed(
	scopePatterns: readonly string[],
	allowedPaths: readonly string[] | undefined,
): boolean {
	if (!allowedPaths || allowedPaths.length === 0 || scopePatterns.length === 0) {
		return true;
	}
	const parsedScope = scopePatterns
		.map(raw => ({ raw, norm: normalizeRepoRelativePath(raw, { allowGlobWildcards: true, allowNegation: true }) }));
	if (parsedScope.some(e => !e.norm.ok)) {
		return false;
	}
	const validScope = parsedScope as { readonly raw: string; readonly norm: { readonly ok: true; readonly path: string; readonly negated?: boolean } }[];
	const posScope = validScope.filter(e => !e.norm.negated);
	const effectivePos = posScope.length > 0
		? posScope
		: [{ raw: '**', norm: { ok: true as const, path: '**' } }];

	// 1. Every witness of every effective positive scope pattern that matches scopePatterns must match allowedPaths
	for (const p of effectivePos) {
		for (const w of buildPatternWitnesses(p.norm.path, p.raw)) {
			if (matchesRepoScopePatterns(w, scopePatterns) && !matchesRepoScopePatterns(w, allowedPaths)) {
				return false;
			}
		}
	}

	// 2. Any `!neg` exclusion in allowedPaths intersecting scopePatterns must also be excluded by scopePatterns
	const negAllowed = allowedPaths
		.map(raw => ({ raw, norm: normalizeRepoRelativePath(raw, { allowGlobWildcards: true, allowNegation: true }) }))
		.filter((e): e is { readonly raw: string; readonly norm: { readonly ok: true; readonly path: string; readonly negated?: boolean } } => e.norm.ok && Boolean(e.norm.negated));
	for (const neg of negAllowed) {
		const negWitnesses = new Set<string>(buildPatternWitnesses(neg.norm.path, neg.raw.replace(/^!\s*/, '')));
		for (const p of effectivePos) {
			for (const w of synthesizeGlobIntersectionWitnesses(p.norm.path, neg.norm.path, p.raw, neg.raw.replace(/^!\s*/, ''))) {
				negWitnesses.add(w);
			}
		}
		for (const w of negWitnesses) {
			if (matchesRepoScopePatterns(w, scopePatterns) && !matchesRepoScopePatterns(w, allowedPaths)) {
				return false;
			}
		}
	}
	return true;
}

/**
 * Detects pairwise glob/prefix overlaps between two parallel branch scope lists.
 * Supports `*`, `**`, `?`, `!negation`, negation-only scopes (implicit `**`), and cross-wildcard
 * segment intersection (`**\/*.ts` vs `src/**`, `src/*\/index.ts` vs `src/api/*.ts`).
 */
export function detectScopePathsOverlap(
	scopeA: readonly string[],
	scopeB: readonly string[],
): readonly string[] {
	const parsedA = scopeA
		.map(raw => ({ raw, norm: normalizeRepoRelativePath(raw, { allowGlobWildcards: true, allowNegation: true }) }))
		.filter((e): e is { readonly raw: string; readonly norm: { readonly ok: true; readonly path: string; readonly negated?: boolean } } => e.norm.ok);
	const parsedB = scopeB
		.map(raw => ({ raw, norm: normalizeRepoRelativePath(raw, { allowGlobWildcards: true, allowNegation: true }) }))
		.filter((e): e is { readonly raw: string; readonly norm: { readonly ok: true; readonly path: string; readonly negated?: boolean } } => e.norm.ok);
	if (parsedA.length === 0 || parsedB.length === 0) {
		return [];
	}
	const posA = parsedA.filter(e => !e.norm.negated);
	const posB = parsedB.filter(e => !e.norm.negated);
	// Match `matchesRepoScopePatterns` semantics: negation-only scope starts from implicit `**`
	const effectivePosA = posA.length > 0 ? posA : [{ raw: '**', norm: { ok: true as const, path: '**' } }];
	const effectivePosB = posB.length > 0 ? posB : [{ raw: '**', norm: { ok: true as const, path: '**' } }];

	const overlaps = new Set<string>();
	for (const a of effectivePosA) {
		for (const w of buildPatternWitnesses(a.norm.path, a.raw)) {
			if (matchesRepoScopePatterns(w, scopeA) && matchesRepoScopePatterns(w, scopeB)) {
				overlaps.add(a.norm.path);
			}
		}
	}
	for (const b of effectivePosB) {
		for (const w of buildPatternWitnesses(b.norm.path, b.raw)) {
			if (matchesRepoScopePatterns(w, scopeB) && matchesRepoScopePatterns(w, scopeA)) {
				overlaps.add(b.norm.path);
			}
		}
	}
	for (const a of effectivePosA) {
		for (const b of effectivePosB) {
			for (const w of synthesizeGlobIntersectionWitnesses(a.norm.path, b.norm.path, a.raw, b.raw)) {
				if (matchesRepoScopePatterns(w, scopeA) && matchesRepoScopePatterns(w, scopeB)) {
					overlaps.add(a.norm.path === '**' ? b.norm.path : a.norm.path);
				}
			}
		}
	}
	return [...overlaps].sort();
}

/**
 * Validates explicitly reported modified files against BOTH the staff node's `allowedPaths`
 * AND the active token's parallel branch `scopePaths` (failing closed on `..` traversal or absolute paths).
 */
export function validateScopedPaths(
	node: IOrchestrationGraphNode | undefined,
	tokenScopePaths: readonly string[] | undefined,
	modifiedFiles: readonly string[] | undefined,
): { readonly ok: boolean; readonly normalizedFiles?: readonly string[]; readonly violations?: readonly string[]; readonly error?: string } {
	const normFiles = normalizeModifiedFiles(modifiedFiles);
	if (!normFiles.ok) {
		return { ok: false, violations: normFiles.invalidPaths, error: normFiles.error };
	}
	if (normFiles.files.length === 0) {
		return { ok: true, normalizedFiles: [] };
	}
	const allowed = (node?.allowedPaths ?? []).map(p => p.trim()).filter(Boolean);
	if (allowed.length > 0) {
		const staffViolations = normFiles.files.filter(f => !matchesRepoScopePatterns(f, allowed));
		if (staffViolations.length > 0) {
			return {
				ok: false,
				violations: staffViolations,
				error: `ALLOWED_PATHS_VIOLATION: staff "${node?.id}" modified out-of-scope file(s): ${staffViolations.join(', ')}. Allowed paths: ${allowed.join(', ')}.`,
			};
		}
	}
	const tokenScope = (tokenScopePaths ?? []).map(p => p.trim()).filter(Boolean);
	if (tokenScope.length > 0) {
		const branchViolations = normFiles.files.filter(f => !matchesRepoScopePatterns(f, tokenScope));
		if (branchViolations.length > 0) {
			return {
				ok: false,
				violations: branchViolations,
				error: `ALLOWED_PATHS_VIOLATION: token on staff "${node?.id}" modified file(s) outside branch scopePaths: ${branchViolations.join(', ')}. Branch scope: ${tokenScope.join(', ')}.`,
			};
		}
	}
	return { ok: true, normalizedFiles: normFiles.files };
}

/**
 * Validates explicitly reported modified files against a staff node's configured `allowedPaths`.
 * Returns `ok: true` when no `allowedPaths` boundary is configured or no files were reported (still rejects `..` traversal!).
 */
export function validateStaffAllowedPaths(
	node: IOrchestrationGraphNode | undefined,
	modifiedFiles: readonly string[] | undefined,
): { readonly ok: boolean; readonly violations?: readonly string[]; readonly error?: string } {
	return validateScopedPaths(node, undefined, modifiedFiles);
}

/**
 * Computes deterministic file-level overlap conflicts across settled sibling branches of a Join Barrier.
 */
export function computeJoinBarrierFileConflicts(
	settledChildren: Readonly<Record<string, IOrchestrationJoinBarrierChildResult>>,
): readonly IOrchestrationBarrierFileConflict[] {
	const byPath = new Map<string, { tokenIds: Set<string>; fromNodeIds: Set<string> }>();
	for (const child of Object.values(settledChildren)) {
		for (const rawFile of child.touchedFiles ?? []) {
			const norm = normalizeRepoRelativePath(rawFile);
			const key = norm.ok ? norm.path : rawFile.trim();
			if (!key) {
				continue;
			}
			let entry = byPath.get(key);
			if (!entry) {
				entry = { tokenIds: new Set<string>(), fromNodeIds: new Set<string>() };
				byPath.set(key, entry);
			}
			entry.tokenIds.add(child.tokenId);
			entry.fromNodeIds.add(child.fromNodeId);
		}
	}
	const conflicts: IOrchestrationBarrierFileConflict[] = [];
	for (const [path, info] of byPath.entries()) {
		if (info.tokenIds.size >= 2) {
			conflicts.push({
				path,
				tokenIds: [...info.tokenIds].sort(),
				fromNodeIds: [...info.fromNodeIds].sort(),
			});
		}
	}
	return conflicts.sort((a, b) => a.path.localeCompare(b.path));
}

export function isOrchestrationBudgetTripped(state: IOrchestrationRuntimeState): boolean {
	return Boolean(
		state.budgetCircuitTripped
		|| (state.budgetLimitUsd !== undefined && (state.totalCostUsd ?? 0) >= state.budgetLimitUsd),
	);
}

export function formatBudgetExceededError(state: IOrchestrationRuntimeState, actionLabel: string): string {
	const spent = (state.totalCostUsd ?? 0).toFixed(4);
	const limit = state.budgetLimitUsd !== undefined ? `$${state.budgetLimitUsd.toFixed(2)}` : 'configured limit';
	return `BUDGET_EXCEEDED: cannot ${actionLabel} because Orchestration hit its FinOps budget ceiling ($${spent} / ${limit}). Raise or clear the budget limit and resume.`;
}

export function recomputeOrchestrationNodeState(
	tokens: Readonly<Record<string, IOrchestrationToken>>,
	nodeId: string,
): OrchestrationNodeRuntimeStatus {
	let hasBlocked = false;
	let hasWaitingJoin = false;
	for (const t of Object.values(tokens)) {
		if (t.nodeId !== nodeId) {
			continue;
		}
		if (t.status === 'active') {
			return 'active';
		}
		if (t.status === 'blocked') {
			hasBlocked = true;
		}
		if (t.status === 'waiting_join') {
			hasWaitingJoin = true;
		}
	}
	return hasBlocked ? 'blocked' : hasWaitingJoin ? 'waiting_join' : 'idle';
}

export function hasDownwardLineageFrom(token: IOrchestrationToken, targetNodeId: string): boolean {
	if (token.returnToNodeId === targetNodeId || token.originNodeId === targetNodeId) {
		return true;
	}
	const hopLog = token.hopLog ?? [];
	if (hopLog.length === 0) {
		return token.fromNodeId === targetNodeId
			&& token.dispatchKind !== 'return'
			&& token.dispatchKind !== 'reject';
	}
	for (const entry of hopLog) {
		if (
			(entry.event === 'dispatch' || entry.event === 'mint' || entry.event === 'handoff')
			&& entry.fromNodeId === targetNodeId
		) {
			return true;
		}
	}
	return false;
}

/**
 * Walks up `parentTokenId` lineage (cycle-safe) to locate the nearest active/blocked ancestor baton
 * held by `targetNodeId` so multi-hop peer handoffs, rejections, and retries merge back into the
 * superior's live parent baton instead of spawning duplicate competing batons.
 */
export function findActiveAncestorTokenOnNode(
	state: IOrchestrationRuntimeState,
	token: IOrchestrationToken,
	targetNodeId: string,
): IOrchestrationToken | undefined {
	const visited = new Set<string>([token.id]);
	let curId = token.parentTokenId;
	while (curId && !visited.has(curId)) {
		visited.add(curId);
		const ancestor = state.tokens[curId];
		if (!ancestor) {
			break;
		}
		if (ancestor.nodeId === targetNodeId && (ancestor.status === 'active' || ancestor.status === 'blocked')) {
			return ancestor;
		}
		curId = ancestor.parentTokenId;
	}
	return undefined;
}

/**
 * Walks up `parentTokenId` lineage (cycle-safe) to locate a `waiting_join` ancestor baton held by
 * `targetNodeId` so a returning non-barrier child merges its deliverables cleanly into the waiting
 * ancestor without spawning a split-brain second active baton on the same superior.
 */
export function findWaitingJoinAncestorTokenOnNode(
	state: IOrchestrationRuntimeState,
	token: IOrchestrationToken,
	targetNodeId: string,
): IOrchestrationToken | undefined {
	const visited = new Set<string>([token.id]);
	let curId = token.parentTokenId;
	while (curId && !visited.has(curId)) {
		visited.add(curId);
		const ancestor = state.tokens[curId];
		if (!ancestor) {
			break;
		}
		if (ancestor.nodeId === targetNodeId && ancestor.status === 'waiting_join') {
			return ancestor;
		}
		curId = ancestor.parentTokenId;
	}
	return undefined;
}

export function normalizeBoundTaskIds(taskNodeId?: string, taskNodeIds?: readonly string[]): {
	readonly taskNodeId?: string;
	readonly taskNodeIds?: readonly string[];
} {
	const list = [...new Set([
		...(taskNodeId?.trim() ? [taskNodeId.trim()] : []),
		...(taskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
	])];
	if (list.length === 0) {
		return {};
	}
	return {
		taskNodeId: list[0],
		...(list.length > 1 ? { taskNodeIds: list } : {}),
	};
}

export function incrementEdgeBounceCounts(
	prevCounts: Readonly<Record<string, number>> | undefined,
	fromNodeId: string,
	toNodeId: string,
): Readonly<Record<string, number>> {
	const key = `${fromNodeId}->${toNodeId}`;
	return {
		...(prevCounts ?? {}),
		[key]: (prevCounts?.[key] ?? 0) + 1,
	};
}

export function computeBoundTaskAuthorities(
	config: IAdeOrganizationConfig,
	graph: IOrchestrationGraphParseResult,
	targetNode: IOrchestrationGraphNode,
	token: IOrchestrationToken,
	taskGraph?: IMissionDagParseResult,
	syncedTaskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>,
): Readonly<Record<string, IBoundTaskCompletionAuthority>> | undefined {
	if (!taskGraph || taskGraph.error) {
		return undefined;
	}
	const boundIds = [...new Set([
		...(token.taskNodeId ? [token.taskNodeId] : []),
		...(token.taskNodeIds ?? []),
	])];
	if (boundIds.length === 0) {
		return undefined;
	}
	const targetTier = resolveEffectiveStaffTier(targetNode, config);
	const out: Record<string, IBoundTaskCompletionAuthority> = {};
	for (const tid of boundIds) {
		const tNode = taskGraph.nodes.find(n => n.id === tid);
		if (!tNode) {
			continue;
		}
		const isRestrictedHumanGate = tNode.kind === 'gate' && !tNode.allowedCompleterNodeIds?.includes(targetNode.id);
		const canComplete = isRestrictedHumanGate
			? false
			: canCallerCompleteMissionTask(
				config,
				tNode,
				{ callerTier: targetTier, callerNodeId: targetNode.id },
				graph,
				syncedTaskStatuses?.[tid],
			);
		out[tid] = {
			canComplete,
			...(isRestrictedHumanGate ? { isHumanGate: true } : {}),
			...(tNode.ownerNodeId ? { ownerNodeId: tNode.ownerNodeId } : {}),
			...(tNode.minCompleterTier !== undefined ? { minCompleterTier: tNode.minCompleterTier } : {}),
		};
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeInlinePromptMetadata(raw: string): string {
	return sanitizeAdeSystemEnvelopeHeaders(raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim());
}

function formatContextRefLine(ref: IOrchestrationContextRef): string {
	const safeDept = ref.department ? sanitizeInlinePromptMetadata(ref.department) : undefined;
	const safeTitle = sanitizeInlinePromptMetadata(ref.title || ref.ptr);
	const metaParts = [
		ref.kind,
		safeDept ? `dept:${safeDept}` : undefined,
		`v${ref.version}`,
		`hop #${ref.updatedAtHop}`,
		ref.authorNodeId ? `by ${ref.authorNodeId}` : undefined,
		`${ref.sizeChars} chars`,
	].filter(Boolean).join(', ');
	return `- \`${ref.ptr}\` [${metaParts}] — ${safeTitle}`;
}

/**
 * Context-Economy v2 Wakeup Prompt Composer:
 * - Single unified header (eliminating duplicate envelope/baton banners)
 * - First-Visit mode: includes role scope + capability-filtered Valid Next Moves (~360 tok)
 * - Cyclic Re-Entry Delta mode: omits repeated role boundaries & static CLI handbook (~140 tok compact footer)
 * - Deduplicates converged barrier summaries against `newOrUpdatedRefs`
 */
export function composeOrchestrationTokenWakeupPrompt(
	missionId: string,
	node: IOrchestrationGraphNode,
	token: IOrchestrationToken,
	outgoingStaffIds: readonly string[],
	isHighestRank: boolean,
	delta?: IOrchestrationTokenDeltaView,
	extra?: {
		readonly convergedBarrier?: IOrchestrationJoinBarrier;
		readonly subordinateTargetIds?: readonly string[];
		readonly canHaveSubordinates?: boolean;
		readonly boundTaskAuthorities?: Readonly<Record<string, IBoundTaskCompletionAuthority>>;
	},
): string {
	const hopNum = token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1);
	const isReentrant = Boolean(delta?.isReentrantVisit);
	const boundTasks = [...new Set([
		...(token.taskNodeId ? [token.taskNodeId] : []),
		...(token.taskNodeIds ?? []),
	])];
	const sourceDescription = extra?.convergedBarrier
		? `Join Barrier \`${extra.convergedBarrier.id}\` converged (${Object.keys(extra.convergedBarrier.settledChildren).length}/${extra.convergedBarrier.childTokenIds.length} child tokens settled)`
		: token.dispatchKind === 'reject'
			? `Rejection / revision requested by \`${token.fromNodeId ?? 'reviewer'}\``
			: token.dispatchKind === 'retry'
				? `Retry dispatched${token.fromNodeId ? ` by \`${token.fromNodeId}\`` : ''} with updated guidance`
				: !token.fromNodeId
					? 'User (L-1) top-level requirement dispatch into Orchestration'
					: token.dispatchKind === 'mint'
						? `Downward sub-task minted by superior \`${token.fromNodeId}\``
						: token.dispatchKind === 'return'
							? `Upward return from subordinate \`${token.fromNodeId}\``
							: `Relay handoff from staff \`${token.fromNodeId}\``;

	const lines: string[] = [
		...buildTokenSystemEnvelopeLines({
			tokenId: token.id,
			nodeId: node.id,
			nodeLabel: node.label,
			hopIndex: hopNum,
			sourceDescription,
		}),
		token.fromNodeId
			? `- Wave \`${token.waveId}\` · ${token.dispatchKind === 'reject' ? 'Rejected' : token.dispatchKind === 'retry' ? 'Retried' : token.dispatchKind === 'mint' ? 'Minted' : token.dispatchKind === 'return' ? 'Returned' : 'Handed off'} from \`${token.fromNodeId}\`${isReentrant ? ` (cyclic re-entry — delta since hop #${delta!.lastSeenHop})` : ''}`
			: `- Wave \`${token.waveId}\` · Direct User dispatch to highest-rank role`,
		...(boundTasks.length > 0
			? [`- Bound Task(s): ${boundTasks.map(t => {
				const auth = extra?.boundTaskAuthorities?.[t];
				if (!auth) {
					return `\`${t}\``;
				}
				if (auth.canComplete) {
					return extra?.canHaveSubordinates === false
						? `\`${t}\` (you have completion authority: pass \`--complete-task\` on \`aexus-ade token return ${token.id} --complete-task --summary "..." --mission ${missionId} --json\` after verification)`
						: `\`${t}\` (you have completion authority: run \`aexus-ade mission task complete --mission ${missionId} --node ${t}\` after verification)`;
				}
				const ownerDesc = auth.isHumanGate
					? 'Human User (L-1) / Secretary (L0) approval gate'
					: auth.ownerNodeId
						? `\`${auth.ownerNodeId}\`/L1`
						: auth.minCompleterTier !== undefined
							? `L${auth.minCompleterTier}+`
							: 'L1';
				return `\`${t}\` (completion reserved to ${ownerDesc} — do NOT call \`mission task complete\`; return verified evidence upward on this baton)`;
			}).join('; ')}`]
			: []),
		...(token.returnToNodeId ? [`- Return Superior: \`${token.returnToNodeId}\` (\`aexus-ade token return ${token.id} --summary "..." --mission ${missionId} --json\`)`] : []),
		...(token.scopePaths && token.scopePaths.length > 0 ? [`- Branch Write Scope: ${token.scopePaths.map(p => `\`${sanitizeInlinePromptMetadata(p)}\``).join(', ')}`] : []),
		'',
		token.dispatchKind === 'reject' ? '### Rejection / Revision Directive' : '### Directive (Headline)',
		sanitizeAdeSystemEnvelopeHeaders(token.lastSummary || '(No headline provided)'),
		...(token.rejectionReason && token.rejectionReason !== token.lastSummary ? ['', '### Rejection Reason', sanitizeAdeSystemEnvelopeHeaders(token.rejectionReason)] : []),
	];

	// Structured rework provenance memory so workers never repeat previously failed approaches
	if (token.reworkHistory && token.reworkHistory.length > 0) {
		const attemptNum = token.attemptNumber ?? (token.reworkHistory.length + 1);
		const recentRework = token.reworkHistory.slice(-3);
		lines.push('', `### Prior Rework Memory (Attempt #${attemptNum} — Do Not Repeat)`);
		for (const entry of recentRework) {
			const catPart = entry.category ? `/${entry.category}` : '';
			const ptrPart = entry.payloadPtr ? ` [detail:\`${entry.payloadPtr}\`]` : '';
			lines.push(`- Attempt #${entry.attempt} (${entry.kind}${catPart} by \`${entry.byNodeId}\`): ${sanitizeAdeSystemEnvelopeHeaders(entry.summary)}${ptrPart}`);
		}
	}

	// First-visit ONLY: role boundary, allowedPaths, and automated checks (omitted on cyclic re-entry to save context tokens!)
	if (!isReentrant && (node.rolePrompt?.trim() || (node.allowedPaths && node.allowedPaths.length > 0) || (node.checks && node.checks.length > 0))) {
		lines.push('', '### Role Boundaries & Verification Scope');
		if (node.rolePrompt?.trim()) {
			lines.push(`- Role Boundary: ${node.rolePrompt.trim()}`);
		}
		if (node.allowedPaths && node.allowedPaths.length > 0) {
			lines.push(`- Allowed Read/Write Paths: ${node.allowedPaths.map(p => `\`${p}\``).join(', ')}`);
		}
		if (node.checks && node.checks.length > 0) {
			lines.push(`- Automated Verification Gates (${node.checks.length}): ${node.checks.map(c => (c.name && c.command ? `${c.name}: \`${c.command}\`` : (c.command || c.name || c.id))).join(' | ')}`);
		}
	}

	if (extra?.convergedBarrier) {
		const settledList = Object.values(extra.convergedBarrier.settledChildren);
		const timeoutTag = extra.convergedBarrier.timedOut ? ' · TIMED OUT' : '';
		lines.push(
			'',
			`### Converged Sub-Task Results (Join Barrier \`${extra.convergedBarrier.id}\` · ${settledList.length}/${extra.convergedBarrier.childTokenIds.length} settled${timeoutTag})`,
		);
		for (const child of settledList) {
			const ptrPart = child.payloadPtr ? ` [detail:\`${child.payloadPtr}\`]` : '';
			const taskPart = child.taskNodeId ? ` [task:\`${child.taskNodeId}\`]` : '';
			lines.push(`- \`${child.tokenId}\` from \`${child.fromNodeId}\` (${child.outcome})${taskPart}: ${sanitizeAdeSystemEnvelopeHeaders(child.summary ?? '')}${ptrPart}`);
		}
		if (extra.convergedBarrier.fileConflicts && extra.convergedBarrier.fileConflicts.length > 0) {
			lines.push('', `### Parallel File Overlap Detected (${extra.convergedBarrier.fileConflicts.length} file(s) — Reconcile Before Merge)`);
			for (const conflict of extra.convergedBarrier.fileConflicts) {
				lines.push(`- \`${sanitizeInlinePromptMetadata(conflict.path)}\` modified by ${conflict.fromNodeIds.map(n => `\`${n}\``).join(', ')} (${conflict.tokenIds.map(t => `\`${t}\``).join(', ')})`);
			}
		}
	}

	// Only show detail pointer line when it's not already completely inlined as a converged barrier summary
	if (token.payloadPtr && !extra?.convergedBarrier) {
		lines.push(`- Detail pointer: \`${token.payloadPtr}\` → \`aexus-ade token read ${token.payloadPtr} --mission ${missionId} --token ${token.id} --json\``);
	}

	const rawNewOrUpdatedRefs = delta ? delta.newOrUpdatedRefs : (token.contextRefs ?? []);
	// Avoid duplicating synthetic convergenceRef when convergedBarrier already inlines child results
	const newOrUpdatedRefs = extra?.convergedBarrier && token.payloadPtr
		? rawNewOrUpdatedRefs.filter(r => r.ptr !== token.payloadPtr)
		: rawNewOrUpdatedRefs;
	const unchangedRefs = delta ? delta.unchangedRefs : [];

	if (newOrUpdatedRefs.length > 0) {
		lines.push(
			'',
			isReentrant
				? '### New / Updated Pointers (Read Only What You Need)'
				: '### Context Pointers (Read On Demand)',
		);
		for (const ref of newOrUpdatedRefs) {
			lines.push(formatContextRefLine(ref));
		}
		const batchPtrs = newOrUpdatedRefs.slice(0, 4).map(r => r.ptr).join(',');
		lines.push(`- Read: \`aexus-ade token read <ptr1,ptr2> --mission ${missionId} --token ${token.id} --json\` (e.g. \`${batchPtrs}\`)`);
	}

	if (unchangedRefs.length > 0) {
		lines.push(
			'',
			`### Unchanged Pointers Already In Your Context (${unchangedRefs.length} skipped)`,
			`- ${unchangedRefs.map(r => `\`${r.ptr}@v${r.version}\` (${sanitizeInlinePromptMetadata(r.title || r.ptr)})`).join(', ')}`,
		);
	} else if (!delta && token.whiteboardPointers && token.whiteboardPointers.length > 0 && newOrUpdatedRefs.length === 0) {
		lines.push('', '### Department Whiteboards (Read On Demand)');
		for (const ptr of token.whiteboardPointers) {
			const safeDept = sanitizeInlinePromptMetadata(ptr.department || 'General');
			const safeTitle = sanitizeInlinePromptMetadata(ptr.title || ptr.whiteboardId);
			lines.push(`- \`wb:${ptr.whiteboardId}\` [${safeDept}, "${safeTitle}", v${ptr.version}] → \`aexus-ade token read wb:${ptr.whiteboardId} --mission ${missionId} --json\``);
		}
	}

	const newHops = delta ? delta.newHops : (token.hopLog ?? []);
	const earlierHops = delta ? delta.earlierHops : [];
	// Avoid duplicating the single arriving hop when it carries no extra refs beyond the Directive block above
	const isRedundantSingleArrivingHop = earlierHops.length === 0
		&& newHops.length === 1
		&& newHops[0].hop === hopNum
		&& !(newHops[0].attachedRefPtrs && newHops[0].attachedRefPtrs.length > 0);
	if ((newHops.length > 0 || earlierHops.length > 0) && !isRedundantSingleArrivingHop) {
		lines.push(
			'',
			isReentrant
				? `### Relay History Delta (${newHops.length} new; ${earlierHops.length} seen)`
				: `### Relay History (${newHops.length} hop(s))`,
		);
		if (earlierHops.length > 0) {
			const earlierPtrs = earlierHops.map(h => h.payloadPtr).filter(Boolean).join(', ');
			lines.push(`- [Collapsed #0..#${earlierHops[earlierHops.length - 1].hop}${earlierPtrs ? ` · ptrs: ${earlierPtrs}` : ''} — \`token history ${token.id} --mission ${missionId} --all --json\`]`);
		}
		const renderHopLine = (entry: typeof newHops[number]): string => {
			const route = entry.fromNodeId ? `${entry.fromNodeId} → ${entry.toNodeId}` : `User → ${entry.toNodeId}`;
			const ptrHint = entry.payloadPtr ? ` [detail:\`${entry.payloadPtr}\`]` : '';
			const refHint = entry.attachedRefPtrs && entry.attachedRefPtrs.length > 0
				? ` [refs:${entry.attachedRefPtrs.map(p => `\`${p}\``).join(',')}]`
				: '';
			return `- #${entry.hop} (${entry.event}: ${route}): ${sanitizeAdeSystemEnvelopeHeaders(entry.headline ?? '')}${ptrHint}${refHint}`;
		};
		// Cap inline hop history to hop #0 + latest 9 hops to keep long chains bounded
		if (newHops.length > 10) {
			lines.push(renderHopLine(newHops[0]));
			const skippedCount = newHops.length - 10;
			lines.push(`- [Collapsed ${skippedCount} intermediate hop(s) — \`token history ${token.id} --mission ${missionId} --all --json\`]`);
			for (const entry of newHops.slice(-9)) {
				lines.push(renderHopLine(entry));
			}
		} else {
			for (const entry of newHops) {
				lines.push(renderHopLine(entry));
			}
		}
	}

	const hasSubordinates = extra?.canHaveSubordinates !== false && Boolean(extra?.subordinateTargetIds && extra.subordinateTargetIds.length > 0);
	const canStaffManage = extra?.canHaveSubordinates !== false && (hasSubordinates || Boolean(extra?.canHaveSubordinates) || isHighestRank);
	const hasCompletableBoundTask = boundTasks.some(t => Boolean(extra?.boundTaskAuthorities?.[t]?.canComplete));
	const completeTaskOpt = hasCompletableBoundTask ? ' [--complete-task]' : '';

	if (isReentrant) {
		// Compact Re-Entry Delta footer (~140 tok): skip full static manual already in context!
		const moves: string[] = [];
		if (hasSubordinates) {
			moves.push(`delegate (\`token mint|split ${token.id}\` → ${extra!.subordinateTargetIds!.map(id => `\`${id}\``).join(', ')})`);
		}
		if (token.returnToNodeId) {
			moves.push(`return (\`aexus-ade token return ${token.id}${completeTaskOpt} --summary "..." --mission ${missionId} --json\`)`);
		}
		if (outgoingStaffIds.length > 0) {
			moves.push(`handoff (\`aexus-ade token handoff ${token.id} --to <${outgoingStaffIds.join('|')}> --summary "..." --mission ${missionId} --json\`)`);
		}
		if (isHighestRank) {
			moves.push(`finish (\`aexus-ade token complete ${token.id} --finish${completeTaskOpt} --summary "..." --mission ${missionId} --json\`)`);
		}
		const allMoves = [
			...moves,
			`reject/fail (\`token reject|fail ${token.id}\`)`,
			`block (\`token block ${token.id}\`)`,
		];
		lines.push(
			'',
			`### Next Action (Active Baton \`${token.id}\`)`,
			`- Valid moves: ${allMoves.join(' | ')}.`,
			`- Keep \`--summary\` 1-line; pass long text via \`--detail - <<'EOF'\` or \`--whiteboard <wbId>\`.`,
		);
		return lines.join('\n');
	}

	// First-Visit Capability-Filtered Valid Next Moves (concise concrete targets; full flags via `docs read engineering-api`)
	lines.push('', `### Valid Next Moves (Active Baton \`${token.id}\` · ${ORCHESTRATION_SILENCE_REMINDER_MINUTES}m silence reminder)`);
	lines.push(`- Hygiene: 1-line \`--summary\`; long text via \`--detail - <<'EOF'\`, \`--artifact "Title=Body"\`, or \`--whiteboard <wbId>\`.`);
	if (hasSubordinates) {
		lines.push(`- Delegate (${extra!.subordinateTargetIds!.map(id => `\`${id}\``).join(', ')}): \`token mint ${token.id} --to <subId> --summary "..." [--wait-join]\` | \`token split ${token.id} --branches-json - <<'EOF'\` | \`token retry <id>\` (\`--mission ${missionId} --json\`)`);
	}
	if (token.returnToNodeId) {
		lines.push(`- Return to \`${token.returnToNodeId}\`: \`aexus-ade token return ${token.id}${completeTaskOpt} --summary "..." --mission ${missionId} --json\``);
	}
	if (outgoingStaffIds.length > 0) {
		lines.push(`- Handoff (${outgoingStaffIds.map(id => `\`${id}\``).join(', ')}): \`aexus-ade token handoff ${token.id} --to <nodeId> --summary "..." --mission ${missionId} --json\``);
	} else if (!token.returnToNodeId) {
		lines.push(`- No outgoing staff edges connected on canvas; finish if authorized or request a return edge.`);
	}
	lines.push(`- Control: \`token reject ${token.id} --reason "..." [--to <nodeId>]\` | \`token fail ${token.id} --reason "..."\` | \`token block ${token.id} --duration <30m|2h> --reason "..."\` | \`token read <ptrs> --token ${token.id}\` | \`whiteboard ${canStaffManage ? 'create|read|write' : 'list|read|write'}\` (\`--mission ${missionId} --json\`)`);
	if (canStaffManage) {
		lines.push(`- Staff: \`aexus-ade orchestration staff create|remove --mission ${missionId} ...\``);
	}
	if (isHighestRank) {
		lines.push(`- Finish / Tasks: \`mission task create|update|complete --mission ${missionId} --node <id>\` | \`aexus-ade token complete ${token.id} --finish${completeTaskOpt} --summary "..." --mission ${missionId} --json\``);
	}
	lines.push(`- Full CLI flags: \`aexus-ade docs read engineering-api --json\`.`);
	return lines.join('\n');
}

/**
 * Unified dispatch wakeup effect builder shared by ALL orchestration wakeup paths:
 * - Resolves effective tier consistently via `resolveEffectiveStaffTier`
 * - Uses O(1) staff index lookups
 * - Evaluates `boundTaskAuthorities` with optional pre-synced task statuses
 */
export function buildOrchestrationDispatchEffect(params: {
	readonly state: IOrchestrationRuntimeState;
	readonly graph: IOrchestrationGraphParseResult;
	readonly staffIndex?: IOrchestrationStaffGraphIndex;
	readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
	readonly config: IAdeOrganizationConfig;
	readonly targetNode: IOrchestrationGraphNode;
	readonly token: IOrchestrationToken;
	readonly holderAgentId?: string;
	readonly convergedBarrier?: IOrchestrationJoinBarrier;
	readonly taskGraph?: IMissionDagParseResult;
	readonly syncedTaskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
	readonly rawTaskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
}): OrchestrationEngineEffect {
	const index = params.staffIndex ?? buildStaffGraphIndex(params.graph);
	const outgoingStaffIds = index.outgoingStaffByNode.get(params.targetNode.id) ?? [];
	const targetTier = resolveEffectiveStaffTier(params.targetNode, params.config);
	const subordinateTargetIds = outgoingStaffIds.filter(outId => {
		const outNode = index.staffById.get(outId);
		if (!outNode) {
			return false;
		}
		const outTier = resolveEffectiveStaffTier(outNode, params.config);
		return targetTier === undefined || outTier === undefined || outTier > targetTier;
	});
	const highest = getHighestRankInSchema(params.config);
	const isHighest = targetTier !== undefined
		? (highest ? targetTier <= highest.tier : false)
		: (index.staffById.has(params.targetNode.id) ? params.targetNode.id === index.topStaffId : !params.token.parentTokenId);
	const targetRank = targetTier !== undefined ? params.config.ranks.find(r => r.tier === targetTier) : undefined;
	const canHaveSubordinates = Boolean(targetRank && !targetRank.pureExecution && targetRank.canHaveSubordinates);
	const effectiveTaskStatuses = params.syncedTaskStatuses
		?? (params.taskGraph && !params.taskGraph.error
			? syncMissionTaskStatusesFromOrchestration(params.rawTaskStatuses, params.taskGraph, params.state, params.graph).taskStatuses
			: params.rawTaskStatuses);
	const boundTaskAuthorities = computeBoundTaskAuthorities(
		params.config,
		params.graph,
		params.targetNode,
		params.token,
		params.taskGraph,
		effectiveTaskStatuses,
	);
	const delta = buildOrchestrationTokenDeltaView(params.state, params.token, params.whiteboards);
	const holderAgentId = params.holderAgentId ?? params.state.nodeAgentIds[params.targetNode.id] ?? params.targetNode.agentId;

	return {
		kind: 'dispatch_token',
		missionId: params.state.missionId,
		nodeId: params.targetNode.id,
		tokenId: params.token.id,
		holderAgentId,
		prompt: composeOrchestrationTokenWakeupPrompt(
			params.state.missionId,
			params.targetNode,
			params.token,
			outgoingStaffIds,
			isHighest,
			delta,
			{
				...(params.convergedBarrier ? { convergedBarrier: params.convergedBarrier } : {}),
				subordinateTargetIds,
				canHaveSubordinates,
				...(boundTaskAuthorities ? { boundTaskAuthorities } : {}),
			},
		),
	};
}
