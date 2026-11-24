/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	addWhiteboardNodeToOrchestration,
	connectOrchestrationEdge,
	IOrchestrationGraphParseResult,
} from './adeOrchestrationGraph.js';
import {
	getHighestRankInSchema,
	IMutateDepartmentWhiteboardResult,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationWhiteboard,
	IOrchestrationWhiteboardPointer,
	IOrchestrationWhiteboardSectionHeading,
	isCompanyWideExecutiveDept,
	isHighestRankTaskCompleter,
	IWhiteboardAttachmentValidationResult,
	IWhiteboardSliceOptions,
	IWhiteboardSliceResult,
	resolveEffectiveStaffTier,
} from './adeOrchestrationTypes.js';
import { IAdeOrganizationConfig } from './adeRoleSchema.js';

export function canCallerAccessWhiteboard(
	graph: IOrchestrationGraphParseResult,
	whiteboard: IOrchestrationWhiteboard,
	config: IAdeOrganizationConfig,
	caller: {
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerTier?: number;
		readonly callerNodeId?: string;
		readonly access?: 'read' | 'write';
		readonly state?: IOrchestrationRuntimeState;
	},
): boolean {
	if (caller.isHumanUser || caller.isSecretary || isHighestRankTaskCompleter(config, caller)) {
		return true;
	}
	if (!caller.callerNodeId) {
		return false;
	}
	const staffNode = graph.nodes.find(n => n.id === caller.callerNodeId && n.kind === 'staff');
	if (!staffNode) {
		return false;
	}
	if (staffNode.department && whiteboard.department && staffNode.department.trim().toLowerCase() === whiteboard.department.trim().toLowerCase()) {
		return true;
	}
	if (graph.edges.some(e =>
		(e.from === staffNode.id && e.to === whiteboard.id)
		|| (e.to === staffNode.id && e.from === whiteboard.id),
	)) {
		return true;
	}
	if (caller.access === 'read') {
		// 0. Unassigned / General whiteboards are readable by all mission staff (writes still require dept match, edge, or executive rank!)
		if (!whiteboard.department || whiteboard.department.trim().toLowerCase() === 'general') {
			return true;
		}
		// 1. Company-wide executive whiteboards are readable by all mission staff
		if (isCompanyWideExecutiveDept(whiteboard.department)) {
			return true;
		}
		// 2. Whiteboards living in a top-rank (L1) staff node's department (e.g. Architecture spec boards) are readable by all mission staff
		const highestTier = getHighestRankInSchema(config)?.tier;
		if (highestTier !== undefined && whiteboard.department) {
			const wbDeptLower = whiteboard.department.trim().toLowerCase();
			const isTopRankDept = graph.nodes.some(n => {
				if (n.kind !== 'staff' || !n.department) {
					return false;
				}
				const tier = resolveEffectiveStaffTier(n, config);
				return tier !== undefined && tier <= highestTier && n.department.trim().toLowerCase() === wbDeptLower;
			});
			if (isTopRankDept) {
				return true;
			}
		}
		// 3. Active-token-only read grant: ONLY if this staff node currently holds a live (active/blocked/waiting_join) token referencing this whiteboard pointer
		if (caller.state) {
			const wbPtr = `wb:${whiteboard.id}`;
			const grantedByToken = Object.values(caller.state.tokens).some(tok => {
				if (tok.nodeId !== staffNode.id) {
					return false;
				}
				if (tok.status !== 'active' && tok.status !== 'blocked' && tok.status !== 'waiting_join') {
					return false;
				}
				if (tok.whiteboardPointers?.some(wp => wp.whiteboardId === whiteboard.id)) {
					return true;
				}
				return Boolean(tok.contextRefs?.some(ref => ref.ptr === wbPtr || (ref.kind === 'whiteboard' && ref.ptr === whiteboard.id)));
			});
			if (grantedByToken) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Strictly validates all `--whiteboard` / `wb:<id>` token attachments before any state mutation:
 * 1. Rejects inline document text pasted into `--whiteboard` (enforcing pointer-only discipline).
 * 2. Rejects nonexistent whiteboard IDs (`NOT_FOUND`).
 * 3. Enforces department / graph-edge whiteboard scoping (`FORBIDDEN`) via `canCallerAccessWhiteboard`.
 */
export function validateTokenWhiteboardAttachments(
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	caller: {
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerTier?: number;
		readonly callerNodeId?: string;
		readonly state?: IOrchestrationRuntimeState;
	},
	whiteboardIds?: readonly string[],
	refPtrs?: readonly string[],
): IWhiteboardAttachmentValidationResult {
	const rawIds: string[] = [];
	for (const raw of whiteboardIds ?? []) {
		const trimmed = raw.trim();
		if (!trimmed) {
			continue;
		}
		rawIds.push(trimmed.startsWith('wb:') ? trimmed.slice(3).trim() : trimmed);
	}
	for (const rawPtr of refPtrs ?? []) {
		const trimmed = rawPtr.trim();
		if (!trimmed) {
			continue;
		}
		if (trimmed.startsWith('wb:')) {
			const wbId = trimmed.slice(3).trim();
			if (wbId) {
				rawIds.push(wbId);
			}
		} else if (whiteboards && Object.prototype.hasOwnProperty.call(whiteboards, trimmed)) {
			// Also validate unprefixed whiteboard IDs passed via --ref so callers cannot bypass whiteboard RBAC!
			rawIds.push(trimmed);
		}
	}
	if (rawIds.length === 0) {
		return { ok: true, normalizedIds: [] };
	}

	const normalizedIds: string[] = [];
	const seen = new Set<string>();
	for (const id of rawIds) {
		if (seen.has(id)) {
			continue;
		}
		const wb = whiteboards?.[id];
		if (!wb) {
			if (/[\r\n]/.test(id) || id.length > 96 || (/\s/.test(id) && id.length > 24)) {
				return {
					ok: false,
					normalizedIds: [],
					code: 'INVALID_STATE',
					error: `INVALID_WHITEBOARD_POINTER: "--whiteboard" accepts ONLY lightweight whiteboard IDs (e.g. "WB_ARCH"), never inline document text. Write content via "aexus-ade whiteboard write" first, then pass its ID.`,
				};
			}
			return {
				ok: false,
				normalizedIds: [],
				code: 'NOT_FOUND',
				error: `Whiteboard "${id}" does not exist. Create it first via "aexus-ade whiteboard create" or inspect available IDs via "aexus-ade whiteboard list".`,
			};
		}
		if (!canCallerAccessWhiteboard(graph, wb, config, { ...caller, access: 'read' })) {
			return {
				ok: false,
				normalizedIds: [],
				code: 'FORBIDDEN',
				error: `FORBIDDEN: staff "${caller.callerNodeId ?? 'caller'}" cannot attach whiteboard "${wb.id}" (Department: "${wb.department}") to token.`,
			};
		}
		seen.add(id);
		normalizedIds.push(id);
	}
	return { ok: true, normalizedIds };
}

export function buildWhiteboardPointers(
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	whiteboardIds: readonly string[] | undefined,
): readonly IOrchestrationWhiteboardPointer[] {
	if (!whiteboards || !whiteboardIds || whiteboardIds.length === 0) {
		return [];
	}
	const seen = new Set<string>();
	const pointers: IOrchestrationWhiteboardPointer[] = [];
	for (const rawId of whiteboardIds) {
		const id = rawId.trim();
		if (!id || seen.has(id)) {
			continue;
		}
		const wb = whiteboards[id];
		if (!wb) {
			continue;
		}
		seen.add(id);
		pointers.push({
			whiteboardId: wb.id,
			department: wb.department,
			title: wb.title,
			version: wb.version,
		});
	}
	return pointers;
}

function normalizeSingleLineWhiteboardField(raw?: string): string {
	return raw ? raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

export function upsertDepartmentWhiteboard(
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	params: {
		readonly id: string;
		readonly title?: string;
		readonly department?: string;
		readonly content?: string;
		readonly appendContent?: string;
		readonly updatedBy?: string;
		readonly updatedByLabel?: string;
		readonly existingVersionHint?: number;
		readonly now?: number;
	},
): { readonly whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>>; readonly whiteboard: IOrchestrationWhiteboard } {
	const existingMap = whiteboards ?? {};
	const id = params.id.trim();
	const prev = existingMap[id];
	const now = params.now ?? Date.now();

	let nextContent: string;
	if (params.appendContent !== undefined) {
		const prevText = prev?.content ?? '';
		nextContent = prevText ? `${prevText.replace(/\s+$/, '')}\n\n${params.appendContent}` : params.appendContent;
	} else if (params.content !== undefined) {
		nextContent = params.content;
	} else {
		nextContent = prev?.content ?? '';
	}

	const baseVersion = Math.max(prev?.version ?? 0, params.existingVersionHint ?? 0);
	const whiteboard: IOrchestrationWhiteboard = {
		id,
		title: normalizeSingleLineWhiteboardField(params.title) || normalizeSingleLineWhiteboardField(prev?.title) || id,
		department: normalizeSingleLineWhiteboardField(params.department) || normalizeSingleLineWhiteboardField(prev?.department) || 'General',
		content: nextContent,
		version: baseVersion + 1,
		createdAt: prev?.createdAt ?? now,
		updatedAt: now,
		...(params.updatedBy ? { updatedBy: params.updatedBy } : (prev?.updatedBy ? { updatedBy: prev.updatedBy } : {})),
		...(params.updatedByLabel ? { updatedByLabel: params.updatedByLabel } : (prev?.updatedByLabel ? { updatedByLabel: prev.updatedByLabel } : {})),
	};

	return {
		whiteboards: {
			...existingMap,
			[id]: whiteboard,
		},
		whiteboard,
	};
}

/**
 * Validated Department Shared Whiteboard mutator supporting create/write separation and optimistic locking.
 */
export function mutateDepartmentWhiteboard(
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	params: {
		readonly id: string;
		readonly title?: string;
		readonly department?: string;
		readonly content?: string;
		readonly appendContent?: string;
		readonly updatedBy?: string;
		readonly updatedByLabel?: string;
		readonly mode?: 'create' | 'write' | 'upsert';
		readonly allowDepartmentRelocation?: boolean;
		readonly expectedVersion?: number;
		readonly existingVersionHint?: number;
		readonly now?: number;
	},
): IMutateDepartmentWhiteboardResult {
	const id = params.id.trim();
	if (!id) {
		return { ok: false, code: 'INVALID_STATE', error: 'Whiteboard ID is required.' };
	}
	const existingMap = whiteboards ?? {};
	const prev = existingMap[id];
	const currentVersion = prev ? prev.version : (params.existingVersionHint ?? 0);
	const exists = Boolean(prev || (params.existingVersionHint !== undefined && params.existingVersionHint > 0));

	if (params.mode === 'create' && exists) {
		return {
			ok: false,
			code: 'ALREADY_EXISTS',
			currentVersion,
			...(prev?.updatedByLabel ? { updatedByLabel: prev.updatedByLabel } : {}),
			error: `ALREADY_EXISTS: Department whiteboard "${id}" already exists (v${currentVersion}). Use "aexus-ade whiteboard write ${id}" to update it.`,
		};
	}

	const requestedDept = normalizeSingleLineWhiteboardField(params.department);
	const prevDept = normalizeSingleLineWhiteboardField(prev?.department);
	if (params.mode === 'write' && !params.allowDepartmentRelocation && prevDept && requestedDept) {
		if (requestedDept.toLowerCase() !== prevDept.toLowerCase()) {
			return {
				ok: false,
				code: 'INVALID_STATE',
				currentVersion,
				error: `INVALID_STATE: Cannot relocate whiteboard "${id}" from department "${prevDept}" to "${requestedDept}" during write.`,
			};
		}
	}

	if (params.expectedVersion !== undefined) {
		if (!Number.isInteger(params.expectedVersion) || params.expectedVersion < 0) {
			return {
				ok: false,
				code: 'INVALID_STATE',
				error: `Invalid expectedVersion "${String(params.expectedVersion)}": must be a non-negative integer.`,
			};
		}
		if (currentVersion !== params.expectedVersion) {
			const lastAuthor = prev?.updatedByLabel || prev?.updatedBy || 'unknown';
			return {
				ok: false,
				code: 'VERSION_CONFLICT',
				currentVersion,
				...(prev?.updatedByLabel ? { updatedByLabel: prev.updatedByLabel } : {}),
				error: `VERSION_CONFLICT: Whiteboard "${id}" is at v${currentVersion} (last updated by ${lastAuthor}), expected v${params.expectedVersion}. Re-read via "aexus-ade whiteboard read ${id}" before retrying.`,
			};
		}
	}

	const upserted = upsertDepartmentWhiteboard(existingMap, params);
	return {
		ok: true,
		whiteboards: upserted.whiteboards,
		whiteboard: upserted.whiteboard,
	};
}

/**
 * Prunes dangling `wb:<id>` references from live (`active`/`blocked`/`waiting_join`) tokens
 * after a whiteboard is removed so re-woken staff never carry dead whiteboard pointers.
 */
export function pruneRemovedWhiteboardFromState(
	state: IOrchestrationRuntimeState,
	whiteboardId: string,
	now = Date.now(),
): { readonly state: IOrchestrationRuntimeState; readonly prunedTokenIds: readonly string[] } {
	const id = whiteboardId.trim();
	if (!id) {
		return { state, prunedTokenIds: [] };
	}
	const ptr = `wb:${id}`;
	let changed = false;
	const prunedTokenIds: string[] = [];
	const nextTokens: Record<string, IOrchestrationToken> = { ...state.tokens };
	for (const [tid, tok] of Object.entries(state.tokens)) {
		if (tok.status !== 'active' && tok.status !== 'blocked' && tok.status !== 'waiting_join') {
			continue;
		}
		const hadPointer = Boolean(tok.whiteboardPointers?.some(p => p.whiteboardId === id));
		const hadRef = Boolean(tok.contextRefs?.some(r => r.ptr === ptr || (r.kind === 'whiteboard' && r.ptr === id)));
		if (!hadPointer && !hadRef) {
			continue;
		}
		changed = true;
		prunedTokenIds.push(tid);
		const nextPointers = tok.whiteboardPointers?.filter(p => p.whiteboardId !== id);
		const nextRefs = tok.contextRefs?.filter(r => r.ptr !== ptr && !(r.kind === 'whiteboard' && r.ptr === id));
		nextTokens[tid] = {
			...tok,
			...(nextPointers && nextPointers.length > 0 ? { whiteboardPointers: nextPointers } : { whiteboardPointers: undefined }),
			...(nextRefs ? { contextRefs: nextRefs } : {}),
		};
	}
	if (!changed) {
		return { state, prunedTokenIds: [] };
	}
	return {
		state: {
			...state,
			tokens: nextTokens,
			stateRevision: (state.stateRevision ?? 0) + 1,
			updatedAt: now,
		},
		prunedTokenIds,
	};
}

function slugifyWhiteboardHeading(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[`*_~[\]()]/g, '')
		.replace(/[^\p{L}\p{N}\s_-]+/gu, '')
		.replace(/[\s_]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Parses Markdown `#..####` headings from a whiteboard or text blob (ignoring fenced code blocks)
 * into a compact section outline with 1-based line ranges and character counts.
 */
export function parseWhiteboardSections(content: string): readonly IOrchestrationWhiteboardSectionHeading[] {
	const text = content ?? '';
	if (!text) {
		return [];
	}
	const lines = text.split(/\r?\n/);
	const rawHeads: { readonly level: number; readonly title: string; readonly slug: string; readonly startIdx: number }[] = [];
	let openFence: { readonly char: string; readonly len: number } | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trimStart();
		if (openFence) {
			const trimmedBoth = trimmed.trimEnd();
			if (
				trimmedBoth.length >= openFence.len
				&& [...trimmedBoth].every(ch => ch === openFence!.char)
			) {
				openFence = undefined;
			}
			continue;
		}
		const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			const info = fenceMatch[2] ?? '';
			// Per CommonMark, backtick code fence info strings may not contain backticks
			if (marker[0] !== '`' || !info.includes('`')) {
				openFence = { char: marker[0], len: marker.length };
				continue;
			}
		}
		const headMatch = /^(#{1,4})\s+(.+?)\s*#*$/.exec(trimmed);
		if (headMatch) {
			const title = headMatch[2].trim();
			if (title) {
				rawHeads.push({
					level: headMatch[1].length,
					title,
					slug: slugifyWhiteboardHeading(title),
					startIdx: i,
				});
			}
		}
	}
	if (rawHeads.length === 0) {
		return [];
	}
	const headings: IOrchestrationWhiteboardSectionHeading[] = [];
	for (let idx = 0; idx < rawHeads.length; idx++) {
		const cur = rawHeads[idx];
		let endIdx = lines.length - 1;
		for (let j = idx + 1; j < rawHeads.length; j++) {
			if (rawHeads[j].level <= cur.level) {
				endIdx = rawHeads[j].startIdx - 1;
				break;
			}
		}
		const sliceText = lines.slice(cur.startIdx, endIdx + 1).join('\n');
		headings.push({
			level: cur.level,
			title: cur.title,
			slug: cur.slug,
			startLine: cur.startIdx + 1,
			endLine: endIdx + 1,
			chars: sliceText.length,
		});
	}
	return headings;
}

function findMatchingWhiteboardSection(
	headings: readonly IOrchestrationWhiteboardSectionHeading[],
	query: string,
	options?: { readonly exactOnly?: boolean },
): IOrchestrationWhiteboardSectionHeading | undefined {
	const needle = query.trim().replace(/^#+\s*/, '');
	if (!needle) {
		return undefined;
	}
	const lower = needle.toLowerCase();
	const slugNeedle = slugifyWhiteboardHeading(needle);
	const exact = headings.find(h =>
		h.title.toLowerCase() === lower
		|| (slugNeedle !== '' && h.slug !== '' && h.slug === slugNeedle),
	);
	if (exact || options?.exactOnly) {
		return exact;
	}
	return headings.find(h =>
		h.title.toLowerCase().includes(lower)
		|| (slugNeedle !== '' && h.slug !== '' && h.slug.includes(slugNeedle)),
	);
}

function sliceOnLineBoundary(text: string, startOffset: number, maxChars: number): {
	readonly sliced: string;
	readonly truncated: boolean;
	readonly nextOffset?: number;
} {
	const safeStart = Math.max(0, Math.min(text.length, Math.floor(startOffset)));
	const safeMax = Math.max(1, Math.floor(maxChars));
	const rawEnd = safeStart + safeMax;
	if (rawEnd >= text.length) {
		return {
			sliced: text.slice(safeStart),
			truncated: safeStart > 0,
		};
	}
	let cut = rawEnd;
	const lastNewline = text.lastIndexOf('\n', rawEnd);
	if (lastNewline > safeStart + Math.floor(safeMax * 0.5)) {
		cut = lastNewline;
	}
	const nextOffset = text[cut] === '\n' ? cut + 1 : cut;
	return {
		sliced: text.slice(safeStart, cut),
		truncated: true,
		nextOffset: nextOffset < text.length ? nextOffset : undefined,
	};
}

/**
 * Budgeted / section-sliced whiteboard & pointer reader (`whiteboard.read` & `token.read`):
 * - `toc` / `summaryOnly`: returns compact Markdown TOC + heading list (`isPartialSlice: true`).
 * - `section`: extracts only the matching heading subtree (returns `availableSections` on miss).
 * - `tailChars`: extracts the trailing window on a clean line boundary (ideal for append-only logs).
 * - `maxChars` + `offset`: deterministic paginated char windowing.
 */
export function sliceWhiteboardContent(
	content: string,
	options?: IWhiteboardSliceOptions,
): IWhiteboardSliceResult {
	const text = content ?? '';
	const totalChars = text.length;
	const lines = text ? text.split(/\r?\n/) : [];
	const lineCount = lines.length;
	const headings = parseWhiteboardSections(text);

	const wantsToc = Boolean(options?.toc || options?.summaryOnly);
	const sectionQuery = options?.section?.trim() || undefined;
	const rawMaxChars = typeof options?.maxChars === 'number' && Number.isFinite(options.maxChars) && options.maxChars > 0
		? Math.floor(options.maxChars)
		: undefined;
	const rawOffset = typeof options?.offset === 'number' && Number.isFinite(options.offset) && options.offset > 0
		? Math.floor(options.offset)
		: 0;
	const rawTail = typeof options?.tailChars === 'number' && Number.isFinite(options.tailChars) && options.tailChars > 0
		? Math.floor(options.tailChars)
		: undefined;

	if (wantsToc) {
		const tocLines = headings.length > 0
			? headings.map(h => `${'  '.repeat(Math.max(0, h.level - 1))}- ${'#'.repeat(h.level)} ${h.title} (L${h.startLine}-L${h.endLine}, ${h.chars} chars)`)
			: [`(No Markdown headings; ${totalChars} chars across ${lineCount} line(s))`];
		return {
			content: tocLines.join('\n'),
			truncated: totalChars > 0,
			totalChars,
			lineCount,
			offset: 0,
			headings,
			isPartialSlice: true,
		};
	}

	let workingText = text;
	let matchedSection: string | undefined;
	let sectionSliced = false;

	if (sectionQuery) {
		const match = findMatchingWhiteboardSection(headings, sectionQuery);
		if (!match) {
			return {
				content: '',
				truncated: totalChars > 0,
				totalChars,
				lineCount,
				offset: 0,
				headings,
				availableSections: headings.map(h => h.title),
				isPartialSlice: true,
			};
		}
		matchedSection = match.title;
		workingText = lines.slice(match.startLine - 1, match.endLine).join('\n');
		sectionSliced = workingText.length < totalChars || headings.length > 1;
	}

	if (rawTail !== undefined) {
		if (workingText.length <= rawTail) {
			return {
				content: workingText,
				truncated: sectionSliced,
				totalChars,
				lineCount,
				offset: 0,
				...(matchedSection ? { matchedSection } : {}),
				headings,
				isPartialSlice: sectionSliced,
			};
		}
		let start = Math.max(0, workingText.length - rawTail);
		const nextNl = workingText.indexOf('\n', start);
		if (nextNl >= 0 && nextNl < start + Math.floor(rawTail * 0.25) && nextNl + 1 < workingText.length) {
			start = nextNl + 1;
		}
		return {
			content: workingText.slice(start),
			truncated: true,
			totalChars,
			lineCount,
			offset: start,
			...(matchedSection ? { matchedSection } : {}),
			headings,
			isPartialSlice: true,
		};
	}

	if (rawMaxChars !== undefined || rawOffset > 0) {
		const effectiveMax = rawMaxChars ?? Math.max(64, workingText.length - rawOffset);
		const win = sliceOnLineBoundary(workingText, rawOffset, effectiveMax);
		const isPartial = sectionSliced || win.truncated || rawOffset > 0 || win.nextOffset !== undefined;
		return {
			content: win.sliced,
			truncated: sectionSliced || win.truncated,
			totalChars,
			lineCount,
			offset: Math.min(rawOffset, workingText.length),
			...(win.nextOffset !== undefined ? { nextOffset: win.nextOffset } : {}),
			...(matchedSection ? { matchedSection } : {}),
			headings,
			isPartialSlice: isPartial,
		};
	}

	return {
		content: workingText,
		truncated: sectionSliced,
		totalChars,
		lineCount,
		offset: 0,
		...(matchedSection ? { matchedSection } : {}),
		headings,
		isPartialSlice: sectionSliced,
	};
}

/**
 * Surgically replaces or appends a single Markdown heading section inside a whiteboard
 * without rewriting unrelated sections (appends a new `## <sectionHeading>` section if absent).
 */
export function upsertWhiteboardSection(
	existingContent: string,
	sectionHeading: string,
	body: string,
	mode: 'replace' | 'append' = 'replace',
): string {
	const cleanHeading = sectionHeading.replace(/[\r\n]+/g, ' ').replace(/^#+\s*/, '').trim();
	const cleanBody = body.replace(/\r\n/g, '\n').trim();
	if (!cleanHeading) {
		return existingContent;
	}
	const prev = (existingContent ?? '').replace(/\r\n/g, '\n');
	if (!prev.trim()) {
		return cleanBody ? `## ${cleanHeading}\n\n${cleanBody}` : `## ${cleanHeading}`;
	}
	const headings = parseWhiteboardSections(prev);
	const matched = findMatchingWhiteboardSection(headings, cleanHeading, { exactOnly: true });
	const lines = prev.split('\n');
	if (!matched) {
		const suffix = cleanBody ? `## ${cleanHeading}\n\n${cleanBody}` : `## ${cleanHeading}`;
		return `${prev.replace(/\s+$/, '')}\n\n${suffix}`;
	}
	const startIdx = matched.startLine - 1;
	const endIdx = matched.endLine - 1;
	const headerLine = lines[startIdx];
	const beforeLines = lines.slice(0, startIdx);
	const afterLines = lines.slice(endIdx + 1);
	let nextSectionBlock: string;
	if (mode === 'append') {
		const existingBody = lines.slice(startIdx + 1, endIdx + 1).join('\n').trim();
		const combinedBody = existingBody && cleanBody
			? `${existingBody}\n\n${cleanBody}`
			: (existingBody || cleanBody);
		nextSectionBlock = combinedBody ? `${headerLine}\n\n${combinedBody}` : headerLine;
	} else {
		nextSectionBlock = cleanBody ? `${headerLine}\n\n${cleanBody}` : headerLine;
	}
	const beforeText = beforeLines.join('\n').replace(/\s+$/, '');
	const afterText = afterLines.join('\n').replace(/^\s+/, '');
	const parts: string[] = [];
	if (beforeText) { parts.push(beforeText); }
	parts.push(nextSectionBlock);
	if (afterText) { parts.push(afterText); }
	return parts.join('\n\n');
}

export function planDynamicWhiteboardCreation(
	rawOrchestrationText: string,
	params: {
		readonly id?: string;
		readonly title: string;
		readonly department: string;
		readonly connectFromNodeId?: string;
	},
): { readonly ok: boolean; readonly whiteboardId?: string; readonly orchestrationText?: string; readonly error?: string } {
	const added = addWhiteboardNodeToOrchestration(rawOrchestrationText, {
		id: params.id,
		title: params.title,
		department: params.department,
	});
	if (!added.ok || !added.whiteboardId || !added.orchestrationText) {
		return added;
	}
	let finalText = added.orchestrationText;
	if (params.connectFromNodeId?.trim()) {
		const wired = connectOrchestrationEdge(finalText, params.connectFromNodeId.trim(), added.whiteboardId, {
			label: 'whiteboard',
		});
		if (wired.ok && wired.orchestrationText) {
			finalText = wired.orchestrationText;
		}
	}
	return {
		ok: true,
		whiteboardId: added.whiteboardId,
		orchestrationText: finalText,
	};
}
