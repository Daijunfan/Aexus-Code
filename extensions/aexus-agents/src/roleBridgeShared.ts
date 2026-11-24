/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

export type AdeSessionRank = 'governor' | 'manager' | 'employee' | 'subordinate' | 'worker' | (string & {});

export const ROLE_CONTEXT_HEADER = '[Aexus Orchestrated Role Context]';
export const ROLE_INIT_MARKER = '[AEXUS_ADE_ROLE_INITIALIZATION]';
export const AEXUS_PREAMBLE_END_MARKER = '<!-- /AEXUS_ADE_PREAMBLE -->';
export const ADE_LIVE_ROLE_BINDINGS_HEADING = '### Live Role Bindings';
export const AEXUS_SYSTEM_TOKEN_ENVELOPE_HEADER = '[Aexus System · Baton Token]';
export const AEXUS_SYSTEM_ROLE_DM_ENVELOPE_HEADER = '[Aexus System · Direct Message from Role]';
export const AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER = '[Aexus System · Message from User (L-1)]';
export const ROLE_STATE_ENV_KEY = 'AEXUS_ADE_ROLE_STATE_FILE';
export const AGENT_AUTH_ENV_KEY = 'AEXUS_ADE_AGENT_AUTH_FILE';
export const AEXUS_AGENT_ID_ENV_KEY = 'AEXUS_ADE_AGENT_ID';
export const AEXUS_INTERNAL_RUNTIME_HEADER = 'x-aexus-internal-runtime';

export const ADE_ROLE_PREAMBLE_HEADERS = [
	'[Aexus Orchestrated Role Context]',
	'[Aexus Orchestrated Role Context Updated]',
	'[Aexus ADE · Engineering Staff Context]',
	'[Aexus ADE · Mission Node Employee]',
	'[Aexus ADE Live Viewport & Macro Control Context]',
] as const;

export function hasAexusSystemMessageEnvelope(text: string): boolean {
	const startsWithAnySystemEnvelope = (candidate: string): boolean =>
		candidate.startsWith(AEXUS_SYSTEM_TOKEN_ENVELOPE_HEADER)
		|| candidate.startsWith(AEXUS_SYSTEM_ROLE_DM_ENVELOPE_HEADER)
		|| candidate.startsWith(AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER);

	const trimmed = text.trimStart();
	if (startsWithAnySystemEnvelope(trimmed)) {
		return true;
	}
	const preambleIdx = text.indexOf(AEXUS_PREAMBLE_END_MARKER);
	if (preambleIdx >= 0) {
		const preamble = text.slice(0, preambleIdx);
		if (
			preamble.includes(AEXUS_SYSTEM_TOKEN_ENVELOPE_HEADER)
			|| preamble.includes(AEXUS_SYSTEM_ROLE_DM_ENVELOPE_HEADER)
			|| preamble.includes(AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER)
		) {
			return true;
		}
		const postMarker = text.slice(preambleIdx + AEXUS_PREAMBLE_END_MARKER.length).trimStart();
		return startsWithAnySystemEnvelope(postMarker);
	}
	return false;
}

/**
 * Returns true if `text` already contains any injected ADE role/staff/employee/viewport charter
 * (either at the start of the turn or inside a `<!-- /AEXUS_ADE_PREAMBLE -->` block), preventing
 * `nativeRoleBridge` from injecting a duplicate copy of `rolePrompt`.
 */
export function hasAnyAdeRolePreamble(text: string): boolean {
	if (!text) {
		return false;
	}
	const trimmed = text.trimStart();
	if (ADE_ROLE_PREAMBLE_HEADERS.some(header => trimmed.startsWith(header))) {
		return true;
	}
	const markerIdx = text.indexOf(AEXUS_PREAMBLE_END_MARKER);
	const searchWindow = markerIdx >= 0 ? text.slice(0, markerIdx) : text.slice(0, 4096);
	return ADE_ROLE_PREAMBLE_HEADERS.some(header => searchWindow.includes(header));
}

/**
 * Formats `rolePrompt` for turn-input injection without stacking duplicate `[Aexus ...]` headers
 * when `rolePrompt` already begins with a compiled role/staff/viewport header.
 */
export function formatRoleContextBlock(rolePrompt: string, updated = false): string {
	const trimmed = rolePrompt.trim();
	if (!trimmed) {
		return '';
	}
	const alreadyBracketed = ADE_ROLE_PREAMBLE_HEADERS.some(header => trimmed.startsWith(header));
	if (!updated) {
		return alreadyBracketed ? trimmed : `${ROLE_CONTEXT_HEADER}\n${trimmed}`;
	}
	if (trimmed.startsWith(`${ROLE_CONTEXT_HEADER}\n`)) {
		return `[Aexus Orchestrated Role Context Updated]\n${trimmed.slice(ROLE_CONTEXT_HEADER.length + 1)}`;
	}
	if (trimmed.startsWith('[Aexus Orchestrated Role Context Updated]')) {
		return trimmed;
	}
	return `[Aexus Orchestrated Role Context Updated]\n${trimmed}`;
}

export interface UserMessageRootBatonInfo {
	readonly tokenId: string;
	readonly missionId: string;
	readonly nodeId: string;
}

export function buildUserMessageSystemEnvelope(rootBaton?: UserMessageRootBatonInfo): string {
	return [
		AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER,
		'- Message Type: Direct message from the Human User (L-1 · Sovereign Operator — NOT from another agent role).',
		'- Channel: chat — prioritize and respond directly to the User.',
		...(rootBaton ? [
			`- Root Baton Issued: \`${rootBaton.tokenId}\` (Mission: \`${rootBaton.missionId}\`, Node: \`${rootBaton.nodeId}\`) — delegate downward via \`aexus-ade token mint|split ${rootBaton.tokenId} ... --wait-join\` or finish via \`aexus-ade token complete ${rootBaton.tokenId} --finish --summary "<facts>"\`.`,
		] : []),
	].join('\n');
}

export interface RoleSyncAgentEntry {
	readonly id: string;
	readonly label: string;
	readonly projectPath: string;
	readonly engineId?: string;
	readonly resource?: string;
	readonly nativeSessionId?: string;
	readonly rank: AdeSessionRank;
	readonly isOrchestrated: boolean;
	readonly isWorkTree?: boolean;
	readonly isMissionNode?: boolean;
	readonly rolePrompt?: string;
	readonly staticRoleCharter?: string;
	readonly staticRoleHash?: string;
	readonly preferredModel?: string;
	readonly sessionToken?: string;
	readonly controlSocketPath?: string;
	readonly preferredThinking?: string;
}

const LIVE_VIEWPORT_SNAPSHOT_MARKER = '- Live Viewport Snapshot:';
const LIVE_WORKSPACE_SNAPSHOT_HEADING = '### Live Workspace Snapshot';
const LIVE_VIEWPORT_SNAPSHOT_HEADING = '### Live Viewport Snapshot';

function findEarliestDynamicTailIndex(text: string): number {
	let best = -1;
	// Use the LAST match of `### Live Role Bindings` (#106 §2.3) so custom initPrompts mentioning the heading never truncate early.
	const bindingsGlobal = /\r?\n### Live Role Bindings(?:\r?\n|$)/g;
	let lastBindingsIdx = -1;
	let bm: RegExpExecArray | null;
	while ((bm = bindingsGlobal.exec(text)) !== null) {
		lastBindingsIdx = bm.index;
	}
	if (lastBindingsIdx >= 0) {
		best = lastBindingsIdx;
	}
	const otherPatterns = [
		/\r?\n### Live Workspace Snapshot(?:\r?\n|$)/,
		/\r?\n### Live Viewport Snapshot(?:\r?\n|$)/,
		/\r?\n- Live Viewport Snapshot:/,
	];
	for (const rx of otherPatterns) {
		const m = rx.exec(text);
		if (m && m.index >= 0 && (best < 0 || m.index < best)) {
			best = m.index;
		}
	}
	return best;
}

/**
 * Extracts the 100% invariant static role charter prefix (excluding `### Live Role Bindings`,
 * `- Live Viewport Snapshot:`, `### Live Workspace Snapshot`, and legacy `- Session:` lines)
 * for KV-cache prefix stability (C2).
 */
export function extractStaticRoleCharter(rolePrompt: string | undefined, explicitStaticCharter?: string): string {
	const normalizeStaticLines = (raw: string): string =>
		raw
			.split(/\r?\n/)
			.filter(line => !line.startsWith('- Session: ') || !line.includes('(id: '))
			.join('\n')
			.trim();
	const explicit = explicitStaticCharter?.trim();
	if (explicit) {
		return normalizeStaticLines(explicit);
	}
	const trimmed = (rolePrompt ?? '').trim();
	if (!trimmed) {
		return '';
	}
	const cutIdx = findEarliestDynamicTailIndex(trimmed);
	return normalizeStaticLines(cutIdx >= 0 ? trimmed.slice(0, cutIdx) : trimmed);
}

/**
 * Extracts only the dynamic tail (`### Live Role Bindings` or `- Live Viewport Snapshot:`) when the
 * static charter was already placed into `--append-system-prompt` or initialized on Turn 1.
 */
export function extractDynamicRoleBindingsTail(rolePrompt: string | undefined, explicitStaticCharter?: string): string {
	const trimmed = (rolePrompt ?? '').trim();
	if (!trimmed) {
		return '';
	}
	const cutIdx = findEarliestDynamicTailIndex(trimmed);
	if (cutIdx >= 0) {
		const tail = trimmed.slice(cutIdx).replace(/\r\n/g, '\n').trim();
		return tail.startsWith(LIVE_VIEWPORT_SNAPSHOT_MARKER)
			? `[ADE Live Viewport State]\n${tail}`
			: tail;
	}
	const staticCharter = explicitStaticCharter?.trim();
	if (staticCharter && trimmed.startsWith(staticCharter)) {
		return trimmed.slice(staticCharter.length).replace(/\r\n/g, '\n').trim();
	}
	return '';
}

export function computeStaticRolePromptHash(
	entry: { readonly rolePrompt?: string; readonly staticRoleCharter?: string; readonly staticRoleHash?: string } | undefined,
): string | undefined {
	const staticCharter = extractStaticRoleCharter(entry?.rolePrompt, entry?.staticRoleCharter);
	if (staticCharter) {
		return crypto.createHash('sha256').update(staticCharter, 'utf8').digest('hex');
	}
	const explicitHash = entry?.staticRoleHash?.trim();
	return explicitHash || undefined;
}

export interface RoleSyncSnapshot {
	readonly mode: 'ade' | 'ide';
	readonly activeAgentId?: string;
	readonly selectedAgentId?: string;
	readonly agents: readonly RoleSyncAgentEntry[];
	readonly secretarySessionToken?: string;
	readonly secretaryControlSocketPath?: string;
}

export interface DshDirectSpawnSpec {
	readonly command: string;
	readonly args: string[];
	readonly env: NodeJS.ProcessEnv;
}

export async function readRoleSyncSnapshot(stateFilePath: string | undefined): Promise<RoleSyncSnapshot | undefined> {
	if (!stateFilePath) {
		return undefined;
	}
	try {
		const raw = await fsPromises.readFile(stateFilePath, 'utf8');
		const parsed = JSON.parse(raw) as Partial<RoleSyncSnapshot>;
		if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.agents)) {
			return undefined;
		}
		return {
			mode: parsed.mode === 'ade' ? 'ade' : 'ide',
			activeAgentId: typeof parsed.activeAgentId === 'string' ? parsed.activeAgentId : undefined,
			selectedAgentId: typeof parsed.selectedAgentId === 'string' ? parsed.selectedAgentId : undefined,
			agents: parsed.agents,
		};
	} catch {
		return undefined;
	}
}

/* eslint-disable local/code-no-sync-fs -- child_process.spawn and stream write hooks run synchronously across extension hosts */
export function readRoleSyncSnapshotSync(
	stateFilePath: string | undefined,
	previousSignatureOrMtime: string | number = -1,
): { readonly snapshot: RoleSyncSnapshot; readonly mtimeMs: number; readonly statSignature: string } | undefined {
	if (!stateFilePath) {
		return undefined;
	}
	try {
		const stat = fs.statSync(stateFilePath);
		const statSignature = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
		if (
			(typeof previousSignatureOrMtime === 'string' && statSignature === previousSignatureOrMtime)
			|| (typeof previousSignatureOrMtime === 'number' && stat.mtimeMs === previousSignatureOrMtime)
		) {
			return undefined;
		}
		const raw = fs.readFileSync(stateFilePath, 'utf8');
		const parsed = JSON.parse(raw) as Partial<RoleSyncSnapshot>;
		if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.agents)) {
			return undefined;
		}
		return {
			mtimeMs: stat.mtimeMs,
			statSignature,
			snapshot: {
				mode: parsed.mode === 'ade' ? 'ade' : 'ide',
				activeAgentId: typeof parsed.activeAgentId === 'string' ? parsed.activeAgentId : undefined,
				selectedAgentId: typeof parsed.selectedAgentId === 'string' ? parsed.selectedAgentId : undefined,
				agents: parsed.agents,
			},
		};
	} catch {
		return undefined;
	}
}
/* eslint-enable local/code-no-sync-fs */

export function isPathWithinOrEqual(childPath: string, parentPath: string): boolean {
	const resolvedChild = path.resolve(childPath);
	const resolvedParent = path.resolve(parentPath);
	const normChild = process.platform === 'win32' ? resolvedChild.toLowerCase() : resolvedChild;
	const normParent = process.platform === 'win32' ? resolvedParent.toLowerCase() : resolvedParent;
	if (normChild === normParent) {
		return true;
	}
	const parentPrefix = normParent.endsWith(path.sep) ? normParent : normParent + path.sep;
	return normChild.startsWith(parentPrefix);
}

/**
 * Escapes a token for Windows `CreateProcess` + `cmd.exe /d /s /c "<innerCmd>"` (`windowsVerbatimArguments: true`).
 * The executable path (`isCommand = true`) MUST keep plain outer quotes (`"..."`, never `^"`) so `cmd.exe`
 * treats spaces in install/profile paths (`...\Aexus Code\bin\...`, `C:\Users\First Last\...`) as a single path,
 * while positional arguments (`isCommand = false`) `^`-escape `cmd.exe` metacharacters (`()%!^"<>&|`).
 */
export function escapeWinCmdToken(arg: string, isCommand = false): string {
	if (isCommand) {
		return `"${arg.replace(/"/g, '')}"`;
	}
	let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
	escaped = escaped.replace(/(\\+)$/, '$1$1');
	escaped = `"${escaped}"`;
	return escaped.replace(/[()%!^"<>&|]/g, '^$&');
}

export function resolveActiveEngineAgent(
	snapshot: RoleSyncSnapshot | undefined,
	shortEngine: string,
	cwd?: string,
	preferredAgentId?: string,
): RoleSyncAgentEntry | undefined {
	if (!snapshot || snapshot.mode !== 'ade') {
		return undefined;
	}
	const expectedEngineId = `aexus-${shortEngine}`;
	const sameEngine = snapshot.agents.filter(entry => entry.engineId === expectedEngineId);
	if (sameEngine.length === 0) {
		return undefined;
	}
	if (preferredAgentId) {
		const pinned = sameEngine.find(entry => entry.id === preferredAgentId);
		if (pinned) {
			return pinned;
		}
	}

	const matchesCwd = (entry: RoleSyncAgentEntry): boolean =>
		!cwd || !entry.projectPath || isPathWithinOrEqual(cwd, entry.projectPath) || isPathWithinOrEqual(entry.projectPath, cwd);

	if (cwd && sameEngine.length > 1) {
		const cwdMatches = sameEngine.filter(entry => entry.projectPath && isPathWithinOrEqual(cwd, entry.projectPath));
		if (cwdMatches.length === 1) {
			const onlyMatch = cwdMatches[0];
			const activeEntry = snapshot.activeAgentId ? sameEngine.find(e => e.id === snapshot.activeAgentId) : undefined;
			if (!activeEntry || !matchesCwd(activeEntry)) {
				return onlyMatch;
			}
		}
	}

	const active = snapshot.activeAgentId
		? sameEngine.find(entry => entry.id === snapshot.activeAgentId)
		: undefined;
	if (active && matchesCwd(active)) {
		return active;
	}

	const selected = snapshot.selectedAgentId
		? sameEngine.find(entry => entry.id === snapshot.selectedAgentId)
		: undefined;
	if (selected && matchesCwd(selected)) {
		return selected;
	}

	if (sameEngine.length === 1) {
		return sameEngine[0];
	}
	if (cwd && sameEngine.length > 1) {
		const cwdMatches = sameEngine.filter(entry => entry.projectPath && isPathWithinOrEqual(cwd, entry.projectPath));
		if (cwdMatches.length === 1) {
			return cwdMatches[0];
		}
	}
	return active ?? selected;
}

const PREAMBLE_START_PREFIXES = [
	'[Aexus Orchestrated Role Context]',
	'[Aexus Orchestrated Role Context Updated]',
	'[Aexus Role Cleared:',
	'[ADE Live Hierarchy State]',
	'[ADE Live Viewport State]',
	ADE_LIVE_ROLE_BINDINGS_HEADING,
	LIVE_WORKSPACE_SNAPSHOT_HEADING,
	LIVE_VIEWPORT_SNAPSHOT_HEADING,
	'[Aexus ADE Live Viewport & Macro Control Context]',
	'[Aexus ADE · Engineering Staff Context]',
	'[Aexus ADE · Mission Node Employee]',
	'[Aexus Cloud Host Project Context]',
	'[Autonomous Session Goal Active]',
	AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER,
	'[Mode: Plan Mode —',
] as const;

function stripLeadingPreambleBlock(text: string): string | undefined {
	const normalized = text.replace(/^\r?\n+/, '');
	if (!normalized) {
		return undefined;
	}

	// 1. Single-line notices
	const roleClearedMatch = normalized.match(/^\[Aexus Role Cleared:[^\n]*\]\r?\n*/);
	if (roleClearedMatch) {
		return normalized.slice(roleClearedMatch[0].length);
	}
	const planModeMatch = normalized.match(/^\[Mode: Plan Mode —[^\n]*\]\r?\n*/);
	if (planModeMatch) {
		return normalized.slice(planModeMatch[0].length);
	}

	// 2. [Autonomous Session Goal Active] (goal condition may span multiple paragraphs, ends with exact completion-marker rule)
	if (normalized.startsWith('[Autonomous Session Goal Active]')) {
		const goalEndRule = 'at the very end of your response.';
		const endIdx = normalized.indexOf(goalEndRule);
		if (endIdx >= 0) {
			let cut = endIdx + goalEndRule.length;
			while (cut < normalized.length && (normalized[cut] === '\r' || normalized[cut] === '\n')) {
				cut++;
			}
			return normalized.slice(cut);
		}
		const blankIdx = normalized.search(/\r?\n\r?\n/);
		if (blankIdx >= 0) {
			return normalized.slice(blankIdx).replace(/^\r?\n+/, '');
		}
	}

	// 3. [Aexus Cloud Host Project Context] (header + `- ...` lines)
	if (normalized.startsWith('[Aexus Cloud Host Project Context]')) {
		const lines = normalized.split(/\r?\n/);
		let idx = 1;
		while (idx < lines.length && /^-\s/.test(lines[idx])) {
			idx++;
		}
		if (idx > 1) {
			while (idx < lines.length && lines[idx].trim() === '') {
				idx++;
			}
			return lines.slice(idx).join('\n');
		}
	}

	// 4. [ADE Live Hierarchy State] / [ADE Live Viewport State] / ### Live Role Bindings / ### Live Workspace Snapshot / [Aexus System · Message from User (L-1)] (header + `- ...` lines)
	if (
		normalized.startsWith('[ADE Live Hierarchy State]')
		|| normalized.startsWith('[ADE Live Viewport State]')
		|| normalized.startsWith(ADE_LIVE_ROLE_BINDINGS_HEADING)
		|| normalized.startsWith(LIVE_WORKSPACE_SNAPSHOT_HEADING)
		|| normalized.startsWith(LIVE_VIEWPORT_SNAPSHOT_HEADING)
		|| normalized.startsWith(AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER)
	) {
		const lines = normalized.split(/\r?\n/);
		let idx = 1;
		while (idx < lines.length && (/^-\s/.test(lines[idx]) || /^ {2,}\S/.test(lines[idx]))) {
			idx++;
		}
		if (idx > 1) {
			while (idx < lines.length && lines[idx].trim() === '') {
				idx++;
			}
			return lines.slice(idx).join('\n');
		}
	}

	// 5. [Aexus Orchestrated Role Context] / [Aexus ADE · Engineering Staff Context] / [Aexus ADE · Mission Node Employee] / [Aexus ADE Live Viewport & Macro Control Context]
	if (ADE_ROLE_PREAMBLE_HEADERS.some(header => normalized.startsWith(header))) {
		const isDynamicRoleTailHeading = (candidate: string): boolean =>
			candidate.startsWith(ADE_LIVE_ROLE_BINDINGS_HEADING)
			|| candidate.startsWith(LIVE_WORKSPACE_SNAPSHOT_HEADING)
			|| candidate.startsWith(LIVE_VIEWPORT_SNAPSHOT_HEADING);
		const lines = normalized.split(/\r?\n/);
		let idx = 1;
		while (
			idx < lines.length
			&& ADE_ROLE_PREAMBLE_HEADERS.some(header => lines[idx] === header)
		) {
			idx++;
		}
		while (idx < lines.length) {
			const line = lines[idx];
			if (
				line.startsWith('You ARE an official orchestrated organizational agent session')
				|| /^You are the global \*\*Secretary(?:\s*\([^)]*\))?\*\* in \*\*Aexus Code ADE\*\*/.test(line)
				|| line.startsWith('You are an orchestrated ')
				|| isDynamicRoleTailHeading(line)
				|| line.startsWith('- ')
				|| /^ {2,}\S/.test(line)
			) {
				idx++;
				continue;
			}
			// Allow a single blank line directly before dynamic tail headings inside compiled role prompts (#97 / #100).
			if (line.trim() === '' && idx + 1 < lines.length && isDynamicRoleTailHeading(lines[idx + 1])) {
				idx++;
				continue;
			}
			break;
		}
		if (idx > 1) {
			while (idx < lines.length && lines[idx].trim() === '') {
				idx++;
			}
			return lines.slice(idx).join('\n');
		}
	}

	return undefined;
}

/**
 * Strips Aexus ADE internal role charters, live hierarchy/viewport deltas, SSH cloud-host
 * routing headers, and autonomous goal preambles from a persisted user turn so chat bubbles
 * and `aexus-ade session history` display only the user's clean message.
 */
export function stripInjectedAdeContextFromUserTurn(rawText: string): string {
	if (!rawText) {
		return rawText;
	}
	const trimmedStart = rawText.trimStart();
	const hasKnownPrefix = PREAMBLE_START_PREFIXES.some(prefix => trimmedStart.startsWith(prefix))
		|| rawText.includes(AEXUS_PREAMBLE_END_MARKER);
	if (!hasKnownPrefix) {
		return rawText;
	}

	let working = rawText;
	// Fast path for sentinel-delimited preambles: use `indexOf` (never `lastIndexOf`) so a user message
	// or baton quoting `<!-- /AEXUS_ADE_PREAMBLE -->` is never truncated (#125 #3a).
	const markerIdx = working.indexOf(AEXUS_PREAMBLE_END_MARKER);
	if (markerIdx >= 0 && PREAMBLE_START_PREFIXES.some(prefix => working.trimStart().startsWith(prefix))) {
		working = working.slice(markerIdx + AEXUS_PREAMBLE_END_MARKER.length).replace(/^\r?\n+/, '');
	}

	// Iteratively peel stacked legacy / nativeRoleBridge blocks in any order
	for (let guard = 0; guard < 12; guard++) {
		const next = stripLeadingPreambleBlock(working);
		if (next === undefined || next === working) {
			break;
		}
		working = next;
		const nestedMarkerIdx = working.indexOf(AEXUS_PREAMBLE_END_MARKER);
		if (nestedMarkerIdx === 0) {
			working = working.slice(AEXUS_PREAMBLE_END_MARKER.length).replace(/^\r?\n+/, '');
		}
	}

	return working.trim() ? working : rawText.trim();
}

export interface CleanableHistoryTurn {
	readonly id?: string;
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly isSystemInitiated?: boolean;
}

/**
 * Filters silent warmup turns (`[AEXUS_ADE_ROLE_INITIALIZATION]`), condenses autonomous
 * goal stop-check turns, and strips injected ADE context preambles from user turns.
 */
export function filterAndCleanHistoryTurns<T extends CleanableHistoryTurn>(turns: readonly T[]): T[] {
	const result: T[] = [];
	let skipNextAssistantAck = false;
	for (const turn of turns) {
		if (!turn.text) {
			continue;
		}
		if (turn.role === 'user') {
			const cleaned = stripInjectedAdeContextFromUserTurn(turn.text);
			if (cleaned.trimStart().startsWith(ROLE_INIT_MARKER)) {
				skipNextAssistantAck = true;
				continue;
			}
			skipNextAssistantAck = false;
			const goalStopMatch = cleaned.match(/^\[Autonomous Goal Stop-Check — Round (\d+\/\d+)\]/);
			if (goalStopMatch) {
				result.push({
					...turn,
					text: `[Autonomous Goal Verification · Round ${goalStopMatch[1]}]`,
					isSystemInitiated: true,
				});
				continue;
			}
			result.push(cleaned !== turn.text ? { ...turn, text: cleaned } : turn);
			continue;
		}
		if (skipNextAssistantAck && turn.role === 'assistant') {
			skipNextAssistantAck = false;
			continue;
		}
		skipNextAssistantAck = false;
		result.push(turn);
	}
	return result;
}

export function mergeRolePromptIntoText(existing: string | undefined, rolePrompt: string): { readonly changed: boolean; readonly text: string } {
	const trimmedPrompt = rolePrompt.trim();
	if (!trimmedPrompt) {
		return { changed: false, text: existing ?? '' };
	}
	if (!existing || !existing.trim()) {
		return { changed: true, text: trimmedPrompt };
	}
	let headerIndex = -1;
	for (const header of ADE_ROLE_PREAMBLE_HEADERS) {
		const idx = existing.indexOf(header);
		if (idx >= 0 && (headerIndex < 0 || idx < headerIndex)) {
			headerIndex = idx;
		}
	}
	const base = (headerIndex >= 0 ? existing.slice(0, headerIndex) : existing).trimEnd();
	const next = base ? `${base}\n\n${trimmedPrompt}` : trimmedPrompt;
	return { changed: next !== existing, text: next };
}

export function injectSessionServerSystemField(body: Record<string, unknown>, rolePrompt: string): boolean {
	if (body.noReply === true) {
		return false;
	}
	const existing = typeof body.system === 'string' ? body.system : undefined;
	const merged = mergeRolePromptIntoText(existing, rolePrompt);
	if (!merged.changed) {
		return false;
	}
	body.system = merged.text;
	return true;
}

function textHasAnyAdeRoleHeader(text: string): boolean {
	return ADE_ROLE_PREAMBLE_HEADERS.some(header => text.includes(header));
}

function updateTextPartsArray(parts: unknown[], rolePrompt: string): boolean {
	const trimmed = rolePrompt.trim();
	if (!trimmed) {
		return false;
	}
	for (const part of parts) {
		if (part && typeof part === 'object') {
			const record = part as Record<string, unknown>;
			if (typeof record.text === 'string' && textHasAnyAdeRoleHeader(record.text)) {
				const merged = mergeRolePromptIntoText(record.text, trimmed);
				if (merged.changed) {
					record.text = merged.text;
					return true;
				}
				return false;
			}
		}
	}
	parts.push({ type: 'text', text: trimmed });
	return true;
}

export function injectLlmPayloadSystemPrompt(url: string, body: Record<string, unknown>, rolePrompt: string): boolean {
	const trimmed = rolePrompt.trim();
	if (!trimmed) {
		return false;
	}

	// 1. OpenAI Responses API (/responses with instructions or input)
	if (typeof body.instructions === 'string' || (/\/responses\b/i.test(url) && Object.hasOwn(body, 'input'))) {
		const existing = typeof body.instructions === 'string' ? body.instructions : undefined;
		const merged = mergeRolePromptIntoText(existing, trimmed);
		if (!merged.changed) {
			return false;
		}
		body.instructions = merged.text;
		return true;
	}

	// 2. Gemini generateContent / streamGenerateContent API
	if (/generateContent|streamGenerateContent/i.test(url) && Array.isArray(body.contents)) {
		const existingInstr = (body.systemInstruction && typeof body.systemInstruction === 'object')
			? body.systemInstruction as Record<string, unknown>
			: undefined;
		const parts = Array.isArray(existingInstr?.parts) ? [...existingInstr.parts] : [];
		let updatedExisting = false;
		for (const part of parts) {
			if (part && typeof part === 'object') {
				const record = part as Record<string, unknown>;
				if (typeof record.text === 'string' && textHasAnyAdeRoleHeader(record.text)) {
					const merged = mergeRolePromptIntoText(record.text, trimmed);
					if (!merged.changed) {
						return false;
					}
					record.text = merged.text;
					updatedExisting = true;
					break;
				}
			}
		}
		if (!updatedExisting) {
			parts.push({ text: trimmed });
		}
		body.systemInstruction = {
			...(existingInstr ?? { role: 'user' }),
			parts,
		};
		return true;
	}

	// 3. Anthropic Messages API (/v1/messages)
	if ((Object.hasOwn(body, 'system') && Array.isArray(body.messages)) || (/\/messages\b/i.test(url) && !/\/chat\/completions\b/i.test(url) && Array.isArray(body.messages))) {
		if (Array.isArray(body.system)) {
			const next = [...body.system];
			if (!updateTextPartsArray(next, trimmed)) {
				return false;
			}
			body.system = next;
			return true;
		}
		const existing = typeof body.system === 'string' ? body.system : undefined;
		const merged = mergeRolePromptIntoText(existing, trimmed);
		if (!merged.changed) {
			return false;
		}
		body.system = merged.text;
		return true;
	}

	// 4. OpenAI-compatible Chat Completions (/chat/completions)
	if (Array.isArray(body.messages)) {
		for (const message of body.messages) {
			if (!message || typeof message !== 'object') {
				continue;
			}
			const msg = message as Record<string, unknown>;
			if (msg.role === 'system' || msg.role === 'developer') {
				if (typeof msg.content === 'string') {
					const merged = mergeRolePromptIntoText(msg.content, trimmed);
					if (!merged.changed) {
						return false;
					}
					msg.content = merged.text;
					return true;
				}
				if (Array.isArray(msg.content)) {
					const next = [...msg.content];
					if (!updateTextPartsArray(next, trimmed)) {
						return false;
					}
					msg.content = next;
					return true;
				}
				return false;
			}
		}
		body.messages = [{ role: 'system', content: trimmed }, ...body.messages];
		return true;
	}

	// 5. Dify / query-shaped chat endpoints (/chat-messages)
	if (/\/chat-messages\b/i.test(url) && typeof body.query === 'string') {
		const merged = mergeRolePromptIntoText(undefined, trimmed);
		if (!merged.changed || textHasAnyAdeRoleHeader(body.query)) {
			return false;
		}
		body.query = `${merged.text}\n\n${body.query}`;
		return true;
	}

	return false;
}

/* eslint-disable local/code-no-sync-fs -- child_process.spawn is synchronous and must rewrite DSH launcher args before returning ChildProcess */
function resolveCommandOnPathSync(command: string, envPath: string | undefined): string {
	if (!command || path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
		return command;
	}
	const dirs = (envPath ?? '').split(path.delimiter).map(d => d.trim().replace(/^"+|"+$/g, '')).filter(Boolean);
	const hasExt = /\.(exe|cmd|bat|com|ps1)$/i.test(command);
	const extensions = process.platform === 'win32'
		? (hasExt ? [''] : ['.exe', '.cmd', '.bat', '.com', ''])
		: [''];
	for (const dir of dirs) {
		for (const ext of extensions) {
			const candidate = path.join(dir, command + ext);
			try {
				if (fs.statSync(candidate).isFile()) {
					return candidate;
				}
			} catch {
				// Continue scanning PATH entries.
			}
		}
	}
	return command;
}

export function resolveDshDirectSpawn(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv | undefined,
	preloadPath: string,
	stateFilePath: string,
): DshDirectSpawnSpec | undefined {
	if (!command || !preloadPath || !fs.existsSync(preloadPath)) {
		return undefined;
	}
	const effectiveEnv = env ?? process.env;
	const resolvedCommand = resolveCommandOnPathSync(command, effectiveEnv.PATH ?? effectiveEnv.Path);
	let realCommand: string;
	try {
		realCommand = fs.realpathSync(resolvedCommand);
	} catch {
		realCommand = resolvedCommand;
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(realCommand);
	} catch {
		return undefined;
	}
	if (!stat.isFile()) {
		return undefined;
	}

	const nextEnv: NodeJS.ProcessEnv = {
		...(env ?? process.env),
		ELECTRON_RUN_AS_NODE: '1',
		[ROLE_STATE_ENV_KEY]: stateFilePath,
	};

	// Direct Electron binary path (e.g. .../DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness)
	if (/deepseek harness(?:\.exe)?$/i.test(path.basename(realCommand))) {
		const appAsarCli = path.resolve(path.dirname(realCommand), '../Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
		if (args.includes('--expose-internals')) {
			return {
				command: realCommand,
				args: args.includes(preloadPath) ? [...args] : ['--require', preloadPath, ...args],
				env: nextEnv,
			};
		}
		if (fs.existsSync(appAsarCli)) {
			return {
				command: realCommand,
				args: ['--require', preloadPath, '--expose-internals', appAsarCli, ...args],
				env: nextEnv,
			};
		}
	}

	if (stat.size > 64 * 1024) {
		return undefined;
	}

	let head: string;
	try {
		head = fs.readFileSync(realCommand, 'utf8');
	} catch {
		return undefined;
	}

	const match = head.match(/ELECTRON_RUN_AS_NODE=1\s+exec\s+"\$resources\/([^"]+)"\s+--expose-internals\s+"\$resources\/([^"]+)"/);
	if (match) {
		const resourcesDir = path.resolve(path.dirname(realCommand), '../../..');
		const electronBin = path.resolve(resourcesDir, match[1]);
		const cliEntry = path.resolve(resourcesDir, match[2]);
		if (fs.existsSync(electronBin)) {
			return {
				command: electronBin,
				args: ['--require', preloadPath, '--expose-internals', cliEntry, ...args],
				env: nextEnv,
			};
		}
	}

	if (/^#!.*\bnode\b/m.test(head) || /\.(?:c|m)?js$/i.test(realCommand)) {
		return {
			command: process.execPath,
			args: ['--require', preloadPath, realCommand, ...args],
			env: nextEnv,
		};
	}

	// Windows npm `.cmd` shim (e.g. `"%dp0%\node_modules\...\cli.js" %*` or `"%~dp0\...\cli.js" %*`)
	if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(realCommand)) {
		const cmdJsMatch = head.match(/"%(?:~)?dp0%?\\([^"]+\.(?:c|m)?js)"/i);
		if (cmdJsMatch) {
			const jsTarget = path.resolve(path.dirname(realCommand), cmdJsMatch[1].replace(/\\/g, path.sep));
			if (fs.existsSync(jsTarget)) {
				return {
					command: process.execPath,
					args: ['--require', preloadPath, jsTarget, ...args],
					env: nextEnv,
				};
			}
		}
	}

	return undefined;
}
/* eslint-enable local/code-no-sync-fs */

interface AgyHookInput {
	readonly conversationId?: string;
	readonly cwd?: string;
}

async function readJsonStringMap(filePath: string): Promise<Record<string, string>> {
	try {
		const raw = await fsPromises.readFile(filePath, 'utf8');
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === 'string') {
				result[key] = value;
			}
		}
		return result;
	} catch {
		return {};
	}
}

function deriveRoleStateSuffix(stateFilePath: string): string {
	const match = path.basename(stateFilePath).match(/^role-state-(.+)\.json$/);
	return match?.[1] || 'default';
}

interface AgyPerConvState {
	readonly conversationId: string;
	readonly agentId?: string;
	readonly injectedPrompt?: string;
}

function sanitizeAgyConvFileToken(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'default';
}

export function buildAgyPerConvFilePrefix(suffix: string): string {
	return `agy-conv-${suffix}-`;
}

async function readAgyPerConvState(filePath: string): Promise<AgyPerConvState | undefined> {
	try {
		const raw = await fsPromises.readFile(filePath, 'utf8');
		const parsed = JSON.parse(raw) as Partial<AgyPerConvState>;
		if (!parsed || typeof parsed !== 'object' || typeof parsed.conversationId !== 'string') {
			return undefined;
		}
		return {
			conversationId: parsed.conversationId,
			agentId: typeof parsed.agentId === 'string' && parsed.agentId ? parsed.agentId : undefined,
			injectedPrompt: typeof parsed.injectedPrompt === 'string' ? parsed.injectedPrompt : undefined,
		};
	} catch {
		return undefined;
	}
}

let sharedAtomicTmpSeq = 0;

async function writeAgyPerConvStateAtomic(filePath: string, state: AgyPerConvState): Promise<void> {
	try {
		await fsPromises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
		const tempPath = `${filePath}.${process.pid}.${Date.now()}.${++sharedAtomicTmpSeq}.tmp`;
		await fsPromises.writeFile(tempPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
		await fsPromises.rename(tempPath, filePath);
	} catch {
		// Best-effort persistence only.
	}
}

export async function readAgyConversationBindings(stateDir: string, suffix: string): Promise<Record<string, string>> {
	const bindingsPath = path.join(stateDir, `agy-bindings-${suffix}.json`);
	const merged = await readJsonStringMap(bindingsPath);
	const prefix = buildAgyPerConvFilePrefix(suffix);
	try {
		const entries = await fsPromises.readdir(stateDir);
		const convFiles = entries.filter(name => name.startsWith(prefix) && name.endsWith('.json'));
		const states = await Promise.all(convFiles.map(name => readAgyPerConvState(path.join(stateDir, name))));
		for (const st of states) {
			if (st?.conversationId && st.agentId) {
				merged[st.conversationId] = st.agentId;
			}
		}
	} catch {
		// Directory may not exist yet.
	}
	return merged;
}

function resolveAgyAgentForHook(
	snapshot: RoleSyncSnapshot,
	conversationId: string | undefined,
	boundAgentId: string | undefined,
	cwd: string | undefined,
): RoleSyncAgentEntry | undefined {
	const agyAgents = snapshot.agents.filter(entry => entry.engineId === 'aexus-antigravity');
	if (conversationId) {
		if (boundAgentId) {
			const bound = agyAgents.find(entry => entry.id === boundAgentId);
			if (bound) {
				return bound;
			}
		}
		const byNative = agyAgents.find(entry => entry.nativeSessionId === conversationId);
		if (byNative) {
			return byNative;
		}
	}
	return resolveActiveEngineAgent(snapshot, 'antigravity', cwd, process.env[AEXUS_AGENT_ID_ENV_KEY]);
}

export async function evaluateAgyPreInvocationHook(
	rawStdin: string,
	stateFilePath: string | undefined,
): Promise<Record<string, unknown>> {
	const snapshot = await readRoleSyncSnapshot(stateFilePath);
	if (!snapshot || !stateFilePath) {
		return {};
	}

	let hookInput: AgyHookInput = {};
	try {
		if (rawStdin.trim()) {
			hookInput = JSON.parse(rawStdin) as AgyHookInput;
		}
	} catch {
		return {};
	}

	const conversationId = typeof hookInput.conversationId === 'string' && hookInput.conversationId.trim()
		? hookInput.conversationId.trim()
		: undefined;
	const cwd = typeof hookInput.cwd === 'string' && hookInput.cwd.trim()
		? hookInput.cwd.trim()
		: undefined;
	const stateDir = path.dirname(stateFilePath);
	const suffix = deriveRoleStateSuffix(stateFilePath);
	const bindingsPath = path.join(stateDir, `agy-bindings-${suffix}.json`);

	// Per-conversation atomic state eliminates lost-update RMW races across parallel `token.split` Antigravity invocations.
	if (conversationId) {
		const convFilePath = path.join(stateDir, `${buildAgyPerConvFilePrefix(suffix)}${sanitizeAgyConvFileToken(conversationId)}.json`);
		const [convState, legacyBindings] = await Promise.all([
			readAgyPerConvState(convFilePath),
			readJsonStringMap(bindingsPath),
		]);
		const priorAgentId = convState?.agentId ?? legacyBindings[conversationId];
		const agent = resolveAgyAgentForHook(snapshot, conversationId, priorAgentId, cwd);

		if (!agent || !agent.isOrchestrated || !agent.rolePrompt) {
			if (convState?.injectedPrompt !== undefined || (agent && convState?.agentId !== agent.id)) {
				await writeAgyPerConvStateAtomic(convFilePath, {
					conversationId,
					agentId: agent?.id ?? priorAgentId,
				});
			}
			return {};
		}

		if (convState?.agentId === agent.id && convState?.injectedPrompt === agent.rolePrompt) {
			return {};
		}

		await writeAgyPerConvStateAtomic(convFilePath, {
			conversationId,
			agentId: agent.id,
			injectedPrompt: agent.rolePrompt,
		});
		return {
			injectSteps: [
				{
					systemMessage: {
						systemMessage: agent.rolePrompt,
					},
				},
			],
		};
	}

	// Fallback when Antigravity omits conversationId: isolate per-agent atomic state file.
	const agent = resolveAgyAgentForHook(snapshot, undefined, undefined, cwd);
	if (!agent || !agent.isOrchestrated || !agent.rolePrompt) {
		return {};
	}
	const agentFilePath = path.join(stateDir, `agy-agent-inj-${suffix}-${sanitizeAgyConvFileToken(agent.id)}.json`);
	const priorState = await readAgyPerConvState(agentFilePath);
	if (priorState?.injectedPrompt === agent.rolePrompt) {
		return {};
	}
	await writeAgyPerConvStateAtomic(agentFilePath, {
		conversationId: agent.id,
		agentId: agent.id,
		injectedPrompt: agent.rolePrompt,
	});

	return {
		injectSteps: [
			{
				systemMessage: {
					systemMessage: agent.rolePrompt,
				},
			},
		],
	};
}

// ---------------------------------------------------------------------------
// Antigravity Hub (agy --hub) ConnectRPC Protobuf & HTML Injection Helpers
// ---------------------------------------------------------------------------

export const AGY_ROLE_PROMPT_SECTION_TITLE = 'aexus_ade_role_context';

const AGY_FORCE_HTTP_CONNECT_SCRIPT = '<script id="aexus-ade-agy-connect">(function(){try{var u=new URL(window.location.href);var changed=false;if(u.searchParams.get("useWebSocket")!=="false"){u.searchParams.set("useWebSocket","false");changed=true;}if(u.searchParams.get("wsTransport")==="3"){u.searchParams.set("wsTransport","0");changed=true;}if(changed){window.history.replaceState(null,"",u.toString());}}catch(_){}})();</script>';

export function injectAgyHtmlForceHttpConnect(html: string): string {
	if (!html || html.includes('id="aexus-ade-agy-connect"')) {
		return html;
	}
	const headMatch = html.match(/<head(?:\s[^>]*)?>/i);
	if (headMatch && headMatch.index !== undefined) {
		const insertPos = headMatch.index + headMatch[0].length;
		return html.slice(0, insertPos) + AGY_FORCE_HTTP_CONNECT_SCRIPT + html.slice(insertPos);
	}
	return AGY_FORCE_HTTP_CONNECT_SCRIPT + html;
}

function encodeProtoVarint(value: number): Buffer {
	const bytes: number[] = [];
	let current = value >>> 0;
	while (current >= 0x80) {
		bytes.push((current & 0x7f) | 0x80);
		current >>>= 7;
	}
	bytes.push(current);
	return Buffer.from(bytes);
}

function encodeProtoBytesField(fieldNumber: number, payload: Buffer | string): Buffer {
	const tag = (fieldNumber << 3) | 2;
	const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
	return Buffer.concat([encodeProtoVarint(tag), encodeProtoVarint(data.length), data]);
}

function readProtoVarint(buf: Uint8Array, offset: number): readonly [number, number] | undefined {
	let result = 0;
	let shift = 0;
	let pos = offset;
	while (pos < buf.length) {
		const byte = buf[pos++];
		result += (byte & 0x7f) * (2 ** shift);
		if ((byte & 0x80) === 0) {
			return [result, pos] as const;
		}
		shift += 7;
		if (shift > 53) {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Extracts field #1 (`cascade_id`, string) from binary `SendUserCascadeMessageRequest` or `StartCascadeResponse`.
 */
export function extractAgyCascadeIdFromProto(buf: Uint8Array): string | undefined {
	let pos = 0;
	while (pos < buf.length) {
		const tagPair = readProtoVarint(buf, pos);
		if (!tagPair) {
			return undefined;
		}
		const [tag, afterTag] = tagPair;
		pos = afterTag;
		const fieldNumber = Math.floor(tag / 8);
		const wireType = tag & 0x07;
		if (wireType === 2) {
			const lenPair = readProtoVarint(buf, pos);
			if (!lenPair) {
				return undefined;
			}
			const [len, afterLen] = lenPair;
			if (len < 0 || afterLen + len > buf.length) {
				return undefined;
			}
			if (fieldNumber === 1) {
				const candidate = Buffer.from(buf.subarray(afterLen, afterLen + len)).toString('utf8').trim();
				return candidate || undefined;
			}
			pos = afterLen + len;
		} else if (wireType === 0) {
			const skip = readProtoVarint(buf, pos);
			if (!skip) {
				return undefined;
			}
			pos = skip[1];
		} else if (wireType === 5) {
			pos += 4;
		} else if (wireType === 1) {
			pos += 8;
		} else {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Builds a spec-compliant Protobuf message merge suffix for `SendUserCascadeMessageRequest`:
 * `cascade_config` (5) -> `planner_config` (1) -> `prompt_section_customization_config` (41)
 * -> `append_prompt_sections` (3) -> `PromptSection` { `title` (1), `content` (2) }.
 */
export function buildAgyRolePromptProtoSuffix(rolePrompt: string): Buffer {
	const trimmed = rolePrompt.trim();
	if (!trimmed) {
		return Buffer.alloc(0);
	}
	const promptSection = Buffer.concat([
		encodeProtoBytesField(1, AGY_ROLE_PROMPT_SECTION_TITLE),
		encodeProtoBytesField(2, trimmed),
	]);
	const customizationCfg = encodeProtoBytesField(3, promptSection);
	const plannerCfg = encodeProtoBytesField(41, customizationCfg);
	const cascadeCfg = encodeProtoBytesField(1, plannerCfg);
	return encodeProtoBytesField(5, cascadeCfg);
}

/**
 * Injects the ADE orchestrated role prompt into a JSON `SendUserCascadeMessageRequest` body.
 */
export function injectAgyConnectJsonRolePrompt(body: Record<string, unknown>, rolePrompt: string): boolean {
	const trimmed = rolePrompt.trim();
	if (!trimmed) {
		return false;
	}
	const cascadeConfig = (body.cascadeConfig && typeof body.cascadeConfig === 'object' && !Array.isArray(body.cascadeConfig))
		? { ...(body.cascadeConfig as Record<string, unknown>) }
		: {};
	const plannerConfig = (cascadeConfig.plannerConfig && typeof cascadeConfig.plannerConfig === 'object' && !Array.isArray(cascadeConfig.plannerConfig))
		? { ...(cascadeConfig.plannerConfig as Record<string, unknown>) }
		: {};
	const promptCustomization = (plannerConfig.promptSectionCustomizationConfig && typeof plannerConfig.promptSectionCustomizationConfig === 'object' && !Array.isArray(plannerConfig.promptSectionCustomizationConfig))
		? { ...(plannerConfig.promptSectionCustomizationConfig as Record<string, unknown>) }
		: {};
	const existingSections = Array.isArray(promptCustomization.appendPromptSections)
		? [...promptCustomization.appendPromptSections]
		: [];
	const filtered = existingSections.filter(item => !(item && typeof item === 'object' && (item as { title?: unknown }).title === AGY_ROLE_PROMPT_SECTION_TITLE));
	filtered.push({
		title: AGY_ROLE_PROMPT_SECTION_TITLE,
		content: trimmed,
	});
	promptCustomization.appendPromptSections = filtered;
	plannerConfig.promptSectionCustomizationConfig = promptCustomization;
	cascadeConfig.plannerConfig = plannerConfig;
	body.cascadeConfig = cascadeConfig;
	return true;
}

/**
 * Encodes a single unfragmented (`FIN=1`, `opcode=0x1`) RFC 6455 WebSocket text frame.
 * When `maskKey` (4 bytes) is supplied (client -> server frames), masks the UTF-8 payload per RFC 6455 Section 5.3.
 */
export function encodeWsTextFrame(text: string, maskKey?: Uint8Array): Buffer {
	const payload = Buffer.from(text, 'utf8');
	const len = payload.length;
	const hasMask = Boolean(maskKey && maskKey.length >= 4);
	const maskBit = hasMask ? 0x80 : 0x00;

	let header: Buffer;
	if (len < 126) {
		header = Buffer.from([0x81, maskBit | len]);
	} else if (len < 65536) {
		header = Buffer.allocUnsafe(4);
		header[0] = 0x81;
		header[1] = maskBit | 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.allocUnsafe(10);
		header[0] = 0x81;
		header[1] = maskBit | 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}

	if (!hasMask || !maskKey) {
		return Buffer.concat([header, payload]);
	}

	const maskedPayload = Buffer.allocUnsafe(len);
	for (let i = 0; i < len; i++) {
		maskedPayload[i] = payload[i] ^ maskKey[i & 3];
	}
	return Buffer.concat([header, Buffer.from(maskKey.subarray(0, 4)), maskedPayload]);
}

export interface WsFrameTransformerOptions {
	readonly onTextMessage: (text: string) => string | undefined;
	readonly shouldDecodeText?: () => boolean;
	readonly onChunkOut?: (chunk: Buffer) => void;
}

/**
 * Incremental RFC 6455 WebSocket frame parser/transformer for uncompressed streams
 * (`sec-websocket-extensions` stripped during loopback HTTP Upgrade).
 * If any reserved extension bits (`RSV1..3`) are encountered, falls back to raw passthrough immediately.
 */
export function createWsFrameTransformer(options: WsFrameTransformerOptions): { readonly push: (chunk: Buffer) => void } {
	let buf: Buffer = Buffer.alloc(0);
	let passthroughRaw = false;
	let fragOpcode = 0;
	let fragChunks: Buffer[] = [];
	let fragMaskKey: Buffer | undefined;

	const emit = (out: Buffer) => {
		if (out.length > 0) {
			options.onChunkOut?.(out);
		}
	};

	const unmaskBytes = (data: Uint8Array, maskKey: Uint8Array | undefined): Buffer => {
		if (!maskKey || maskKey.length < 4) {
			return Buffer.from(data);
		}
		const out = Buffer.allocUnsafe(data.length);
		for (let i = 0; i < data.length; i++) {
			out[i] = data[i] ^ maskKey[i & 3];
		}
		return out;
	};

	return {
		push(chunk: Buffer): void {
			if (chunk.length === 0) {
				return;
			}
			if (passthroughRaw) {
				emit(chunk);
				return;
			}
			buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

			while (buf.length >= 2) {
				const b0 = buf[0];
				const b1 = buf[1];
				const rsv = b0 & 0x70;
				if (rsv !== 0) {
					passthroughRaw = true;
					const rest = buf;
					buf = Buffer.alloc(0);
					fragChunks = [];
					fragOpcode = 0;
					emit(rest);
					return;
				}

				const fin = (b0 & 0x80) !== 0;
				const opcode = b0 & 0x0f;
				const masked = (b1 & 0x80) !== 0;
				const len7 = b1 & 0x7f;

				let offset = 2;
				let payloadLen = len7;
				if (len7 === 126) {
					if (buf.length < 4) {
						return;
					}
					payloadLen = buf.readUInt16BE(2);
					offset = 4;
				} else if (len7 === 127) {
					if (buf.length < 10) {
						return;
					}
					const bigLen = buf.readBigUInt64BE(2);
					if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
						passthroughRaw = true;
						const rest = buf;
						buf = Buffer.alloc(0);
						emit(rest);
						return;
					}
					payloadLen = Number(bigLen);
					offset = 10;
				}

				let maskKey: Buffer | undefined;
				if (masked) {
					if (buf.length < offset + 4) {
						return;
					}
					maskKey = Buffer.from(buf.subarray(offset, offset + 4));
					offset += 4;
				}

				const totalLen = offset + payloadLen;
				if (buf.length < totalLen) {
					return;
				}

				const rawFrame = buf.subarray(0, totalLen);
				const rawPayload = buf.subarray(offset, totalLen);
				buf = buf.subarray(totalLen);

				// Control frames (close=0x8, ping=0x9, pong=0xa) can be interleaved mid-fragment; forward untouched.
				if (opcode >= 0x8) {
					emit(rawFrame);
					continue;
				}

				const decodeEnabled = options.shouldDecodeText ? options.shouldDecodeText() : true;

				if (opcode === 0x1) {
					if (fin) {
						if (!decodeEnabled) {
							emit(rawFrame);
							continue;
						}
						const text = unmaskBytes(rawPayload, maskKey).toString('utf8');
						const nextText = options.onTextMessage(text);
						if (nextText === undefined || nextText === text) {
							emit(rawFrame);
						} else {
							emit(encodeWsTextFrame(nextText, maskKey));
						}
					} else {
						fragOpcode = 0x1;
						fragMaskKey = maskKey;
						fragChunks = [unmaskBytes(rawPayload, maskKey)];
					}
				} else if (opcode === 0x0 && fragOpcode === 0x1) {
					fragChunks.push(unmaskBytes(rawPayload, maskKey));
					if (fin) {
						const fullBuf = Buffer.concat(fragChunks);
						const effectiveMask = fragMaskKey ?? maskKey;
						fragOpcode = 0;
						fragChunks = [];
						fragMaskKey = undefined;
						const fullText = fullBuf.toString('utf8');
						const nextText = decodeEnabled ? options.onTextMessage(fullText) : undefined;
						emit(encodeWsTextFrame(nextText ?? fullText, effectiveMask));
					}
				} else {
					emit(rawFrame);
				}
			}
		},
	};
}

/**
 * Inspects/rewrites a Connect-over-WebSocket (`/connect-websocket`) client -> server JSON frame
 * for Antigravity (`agy --hub`). Tracks `/StartCascade` stream IDs and injects ADE role prompt
 * into `/SendUserCascadeMessage` payloads without disturbing WebSocket multiplexing.
 */
export function transformAgyConnectWsClientMessage(
	rawText: string,
	startCascadeStreams: Set<string>,
	resolveAgentAndBind: (cascadeId: string | undefined) => { readonly isOrchestrated: boolean; readonly rolePrompt?: string } | undefined,
): string | undefined {
	if (!rawText.includes('SendUserCascadeMessage') && !rawText.includes('StartCascade')) {
		return undefined;
	}
	try {
		const pkt = JSON.parse(rawText) as Record<string, unknown>;
		if (pkt.type !== 'start' || typeof pkt.procedure !== 'string') {
			return undefined;
		}
		if (pkt.procedure.endsWith('/StartCascade')) {
			if (typeof pkt.streamId === 'string' && pkt.streamId) {
				startCascadeStreams.add(pkt.streamId);
			}
			return undefined;
		}
		if (pkt.procedure.endsWith('/SendUserCascadeMessage') && pkt.payload && typeof pkt.payload === 'object' && !Array.isArray(pkt.payload)) {
			const payload = { ...(pkt.payload as Record<string, unknown>) };
			const cascadeId = typeof payload.cascadeId === 'string' && payload.cascadeId.trim()
				? payload.cascadeId.trim()
				: (typeof payload.cascade_id === 'string' && payload.cascade_id.trim() ? payload.cascade_id.trim() : undefined);
			const agent = resolveAgentAndBind(cascadeId);
			if (agent?.isOrchestrated && agent.rolePrompt && injectAgyConnectJsonRolePrompt(payload, agent.rolePrompt)) {
				pkt.payload = payload;
				return JSON.stringify(pkt);
			}
		}
	} catch {
		// Ignore malformed frames.
	}
	return undefined;
}

/**
 * Observes a Connect-over-WebSocket (`/connect-websocket`) server -> client JSON frame
 * to bind newly started `cascadeId`s from `/StartCascade` responses.
 */
export function observeAgyConnectWsServerMessage(
	rawText: string,
	startCascadeStreams: Set<string>,
	onCascadeStarted: (cascadeId: string) => void,
): void {
	if (startCascadeStreams.size === 0) {
		return;
	}
	try {
		const pkt = JSON.parse(rawText) as { streamId?: unknown; type?: unknown; payload?: unknown };
		if (typeof pkt.streamId !== 'string' || !startCascadeStreams.has(pkt.streamId)) {
			return;
		}
		if (pkt.type === 'data' && pkt.payload && typeof pkt.payload === 'object' && !Array.isArray(pkt.payload)) {
			const rec = pkt.payload as { cascadeId?: unknown; cascade_id?: unknown };
			const cascadeId = typeof rec.cascadeId === 'string' && rec.cascadeId.trim()
				? rec.cascadeId.trim()
				: (typeof rec.cascade_id === 'string' && rec.cascade_id.trim() ? rec.cascade_id.trim() : undefined);
			if (cascadeId) {
				onCascadeStarted(cascadeId);
			}
		} else if (pkt.type === 'end') {
			startCascadeStreams.delete(pkt.streamId);
		}
	} catch {
		// Ignore malformed frames.
	}
}

export const ADE_CAPABILITY_TOKEN_PREFIX = 'aexus-cap.';
export const ADE_MINT_SESSION_TOKEN_ACTION = 'auth.mintSessionToken';
export const ADE_PURE_WORKER_FALLBACK_DENY_TOKEN = 'aexus-cap.eyJzaWQiOiJwdXJlLXdvcmtlciIsInJhbmsiOiJ3b3JrZXIiLCJwdXJlIjp0cnVlLCJpYXQiOjB9.0000000000000000000000000000000000000000000000000000000000000000';

export const ADE_CONTROL_ENV_KEYS = [
	'AEXUS_ADE_CONTROL_FILE',
	'AEXUS_ADE_TOKEN',
	'AEXUS_ADE_SOCKET',
	'AEXUS_ADE_SESSION_TOKEN',
	'AEXUS_ADE_CALLER',
	'AEXUS_ADE_WINDOW_ID',
] as const;

const ADE_CONTROL_ENV_KEY_SET = new Set<string>(ADE_CONTROL_ENV_KEYS);

/**
 * Returns a shallow copy of `env` with all local ADE control-plane credentials and
 * routing variables removed (case-insensitively for Windows compatibility).
 */
export function stripAdeControlEnv<T extends Record<string, string | undefined>>(env: T): T {
	const cleaned: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!ADE_CONTROL_ENV_KEY_SET.has(key.toUpperCase())) {
			cleaned[key] = value;
		}
	}
	return cleaned as T;
}

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * Resolves the effective Codex sandbox mode. Local and cloud sessions default to
 * `'danger-full-access'` when `autonomousMode` is enabled (the default) unless
 * `autonomousMode` is explicitly set to `false` or the caller passes an explicit `sandboxMode`.
 */
export function resolveCodexSandboxMode(
	options?: { readonly automatedEngineering?: boolean; readonly sandboxMode?: string },
	explicitSandboxMode?: string,
	autonomousMode = true,
): CodexSandboxMode {
	switch ((explicitSandboxMode ?? options?.sandboxMode)?.trim()) {
		case 'read-only':
			return 'read-only';
		case 'workspace-write':
			return 'workspace-write';
		case 'danger-full-access':
			return 'danger-full-access';
		default:
			return autonomousMode ? 'danger-full-access' : 'workspace-write';
	}
}

export const SHARED_PURE_SCOPE_KEY = 'pure::shared';

export function normalizePoolCwd(cwd: string | undefined, platform: NodeJS.Platform = process.platform): string {
	const trimmed = cwd?.trim();
	if (!trimmed) {
		return '';
	}
	return platform === 'win32'
		? path.win32.normalize(trimmed).replace(/[\\/]+$/, '').toLowerCase()
		: path.posix.normalize(trimmed).replace(/\/+$/, '');
}

/**
 * Computes an isolated engine client-pool key incorporating `(cwd, sessionId, rank, pure)`
 * so changing a session's rank, purity, or working directory never reuses a stale pool
 * process carrying older capability credentials.
 */
export function computeAgentIdentityScopeKey(
	sessionId: string,
	identity?: AgentChildIdentity,
	cwd?: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const normCwd = normalizePoolCwd(cwd, platform);
	const sid = sessionId.trim() || 'session';
	const pure = isPureWorkerIdentity(identity);
	if (pure) {
		return `pure:${normCwd}:${sid}`;
	}
	const rank = identity?.callerRole?.trim().toLowerCase() || 'worker';
	if (identity?.isMissionNode === true) {
		return `mnode:${normCwd}:${sid}:${rank}`;
	}
	return `orch:${normCwd}:${sid}:${rank}`;
}

export interface AgentChildIdentity {
	readonly sessionId?: string;
	readonly callerRole?: string;
	readonly pureWorker?: boolean;
	readonly isMissionNode?: boolean;
}

export interface SingleAgentAuthRecord {
	readonly version: 1;
	readonly mode: 'ade' | 'ide';
	readonly agentId: string;
	readonly isOrchestrated: boolean;
	readonly isMissionNode?: boolean;
	readonly sessionToken: string;
	readonly controlSocketPath?: string;
}

const AGENT_AUTH_FILE_NONCES_SYMBOL = Symbol.for('aexus.ade.agentAuthFileNonces');

function getSharedAgentAuthFileNonces(): Map<string, string> {
	const host = globalThis as Record<PropertyKey, unknown>;
	let map = host[AGENT_AUTH_FILE_NONCES_SYMBOL] as Map<string, string> | undefined;
	if (!(map instanceof Map)) {
		map = new Map<string, string>();
		host[AGENT_AUTH_FILE_NONCES_SYMBOL] = map;
	}
	return map;
}

export function getExistingAgentAuthFilePath(bridgeDir: string, scopeId: string, agentId: string): string | undefined {
	const nonces = getSharedAgentAuthFileNonces();
	const safeScope = scopeId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || '0';
	const compositeKey = `${path.resolve(bridgeDir)}::${safeScope}::${agentId}`;
	const nonce = nonces.get(compositeKey);
	if (!nonce) {
		return undefined;
	}
	const agentHash = crypto.createHash('sha256').update(agentId, 'utf8').digest('hex').slice(0, 12);
	return path.join(bridgeDir, `agent-auth-${safeScope}-${agentHash}-${nonce}.json`);
}

export function getOrEnsureAgentAuthFilePath(bridgeDir: string, scopeId: string, agentId: string): string {
	const nonces = getSharedAgentAuthFileNonces();
	const safeScope = scopeId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || '0';
	const compositeKey = `${path.resolve(bridgeDir)}::${safeScope}::${agentId}`;
	let nonce = nonces.get(compositeKey);
	if (!nonce) {
		nonce = crypto.randomBytes(12).toString('hex');
		nonces.set(compositeKey, nonce);
	}
	const agentHash = crypto.createHash('sha256').update(agentId, 'utf8').digest('hex').slice(0, 12);
	return path.join(bridgeDir, `agent-auth-${safeScope}-${agentHash}-${nonce}.json`);
}

export async function writeSingleAgentAuthFile(filePath: string, payload: SingleAgentAuthRecord): Promise<void> {
	const dir = path.dirname(filePath);
	await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
	const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
	await fsPromises.writeFile(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
	if (process.platform !== 'win32') {
		await fsPromises.chmod(tmp, 0o600).catch(() => { });
	}
	await fsPromises.rename(tmp, filePath);
}

/* eslint-disable local/code-no-sync-fs -- child_process.spawn hook writes single-agent 0o600 auth file synchronously before exec */
export function writeSingleAgentAuthFileSync(filePath: string, payload: SingleAgentAuthRecord): void {
	try {
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
		if (process.platform !== 'win32') {
			try { fs.chmodSync(tmp, 0o600); } catch { }
		}
		fs.renameSync(tmp, filePath);
	} catch {
		// Best-effort sync auth materialization; spawn-time env token remains present as fallback.
	}
}
/* eslint-enable local/code-no-sync-fs */

export interface AgentChildEnvOptions extends AgentChildIdentity {
	readonly baseEnv?: NodeJS.ProcessEnv;
	readonly cliBinDirs?: readonly string[];
	readonly socketPath?: string;
	readonly sessionToken?: string;
	readonly agentAuthFile?: string;
	readonly platform?: NodeJS.Platform;
}

export function isRawPureRole(identity?: AgentChildIdentity): boolean {
	if (identity?.pureWorker === true) {
		return true;
	}
	const role = identity?.callerRole?.trim().toLowerCase();
	if (!role || role === 'worker' || role === 'pure-worker' || role === 'none') {
		return true;
	}
	return false;
}

export function isPureWorkerIdentity(identity?: AgentChildIdentity): boolean {
	// Pure-rank Mission nodes need scoped token-only CLI access (`token.*`, `whoami`, `docs.read`, `api.update`),
	// while standalone pure workers remain 100% isolated with zero CLI PATH or control socket access.
	if (identity?.isMissionNode === true) {
		return false;
	}
	return isRawPureRole(identity);
}

export function isPureWorkerDenyToken(token: string | undefined): boolean {
	if (!token || !token.startsWith(ADE_CAPABILITY_TOKEN_PREFIX)) {
		return false;
	}
	const body = token.slice(ADE_CAPABILITY_TOKEN_PREFIX.length);
	const dotIdx = body.indexOf('.');
	if (dotIdx <= 0) {
		return false;
	}
	try {
		const decoded = Buffer.from(body.slice(0, dotIdx), 'base64url').toString('utf8');
		const parsed = JSON.parse(decoded) as { pure?: unknown; missionNode?: unknown };
		return parsed?.pure === true && parsed?.missionNode !== true;
	} catch {
		return false;
	}
}

export function stripDirectoriesFromPath(
	rawPath: string | undefined,
	dirsToRemove: readonly string[],
	platform: NodeJS.Platform = process.platform,
): string {
	if (!rawPath) {
		return '';
	}
	const delimiter = platform === 'win32' ? ';' : ':';
	const normalizeDir = (value: string): string => {
		const trimmed = value.trim().replace(/^"+|"+$/g, '');
		if (!trimmed) {
			return '';
		}
		const resolved = platform === 'win32'
			? path.win32.normalize(trimmed).replace(/[\\/]+$/, '').toLowerCase()
			: path.posix.normalize(trimmed).replace(/\/+$/, '');
		return resolved;
	};
	const blocked = new Set(dirsToRemove.map(normalizeDir).filter(Boolean));
	if (blocked.size === 0) {
		return rawPath;
	}
	const kept: string[] = [];
	for (const segment of rawPath.split(delimiter)) {
		const trimmed = segment.trim().replace(/^"+|"+$/g, '');
		if (!trimmed) {
			continue;
		}
		const normalized = normalizeDir(trimmed);
		if (blocked.has(normalized)) {
			continue;
		}
		kept.push(trimmed);
	}
	return kept.join(delimiter);
}

/**
 * Central child-process environment sanitizer shared by all 8 Coding Agent engines.
 *
 * - Never leaks master `AEXUS_ADE_CONTROL_FILE` or `AEXUS_ADE_TOKEN` to any child agent.
 * - Orchestrated sessions receive `AEXUS_ADE_SOCKET`, server-signed `AEXUS_ADE_SESSION_TOKEN`,
 *   and `AEXUS_ADE_CALLER` (informational; authoritative rank is enforced server-side from the token).
 * - Pure Worker sessions have all ADE control-plane vars stripped, bundled `aexus-ade` CLI bin
 *   directories removed from `PATH`, and a `pure: true` deny capability token injected into
 *   `AEXUS_ADE_SESSION_TOKEN`.
 */
export function buildAgentChildEnv(options: AgentChildEnvOptions): NodeJS.ProcessEnv {
	const platform = options.platform ?? process.platform;
	const delimiter = platform === 'win32' ? ';' : ':';
	const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) };

	// Never expose the master control metadata path or master socket token to spawned agents.
	// Also strip any inherited AEXUS_ADE_WINDOW_ID so agents route via their freshly signed capability token `wid`.
	delete env.AEXUS_ADE_CONTROL_FILE;
	delete env.AEXUS_ADE_TOKEN;
	delete env.AEXUS_ADE_WINDOW_ID;
	delete env.AEXUS_ADE_ROLE_STATE_FILE;
	delete env.AEXUS_ADE_AGENT_AUTH_FILE;
	delete env.AEXUS_ADE_AGENT_ID;

	// Normalize case-variant PATH entries into a single canonical key.
	let existingPath: string | undefined;
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === 'path') {
			if (existingPath === undefined && typeof env[key] === 'string') {
				existingPath = env[key];
			}
			delete env[key];
		}
	}
	const canonicalPathKey = platform === 'win32' ? 'Path' : 'PATH';
	const cliBinDirs = (options.cliBinDirs ?? []).filter(Boolean);
	const pure = isPureWorkerIdentity(options);

	if (pure) {
		delete env.AEXUS_ADE_SOCKET;
		delete env.AEXUS_ADE_CALLER;
		env.AEXUS_ADE_SESSION_TOKEN = options.sessionToken?.trim() || ADE_PURE_WORKER_FALLBACK_DENY_TOKEN;
		const strippedPath = stripDirectoriesFromPath(existingPath, cliBinDirs, platform);
		env[canonicalPathKey] = strippedPath;
		if (platform !== 'win32') {
			env.PATH = strippedPath;
		}
		return env;
	}

	const normalizedRank = options.callerRole?.trim().toLowerCase() || 'worker';
	env.AEXUS_ADE_CALLER = normalizedRank;
	if (options.socketPath?.trim()) {
		env.AEXUS_ADE_SOCKET = options.socketPath.trim();
	}
	if (options.sessionToken?.trim()) {
		env.AEXUS_ADE_SESSION_TOKEN = options.sessionToken.trim();
	} else {
		delete env.AEXUS_ADE_SESSION_TOKEN;
	}
	if (options.agentAuthFile?.trim() && options.sessionId?.trim()) {
		env.AEXUS_ADE_AGENT_AUTH_FILE = options.agentAuthFile.trim();
		env.AEXUS_ADE_AGENT_ID = options.sessionId.trim();
	}

	const primaryBinDir = cliBinDirs[0];
	let nextPath = existingPath ?? '';
	if (primaryBinDir) {
		const normalizeSeg = (seg: string) => {
			const clean = seg.trim().replace(/^"+|"+$/g, '');
			return platform === 'win32' ? clean.toLowerCase() : clean;
		};
		const segments = nextPath ? nextPath.split(delimiter).filter(Boolean) : [];
		const targetNorm = normalizeSeg(primaryBinDir);
		if (!segments.some(seg => normalizeSeg(seg) === targetNorm)) {
			nextPath = nextPath ? `${primaryBinDir}${delimiter}${nextPath}` : primaryBinDir;
		}
	}
	env[canonicalPathKey] = nextPath;
	if (platform !== 'win32') {
		env.PATH = nextPath;
	}
	return env;
}

export function isNativeRoleBridgeDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.AEXUS_ADE_DISABLE_NATIVE_ROLE_BRIDGE?.trim().toLowerCase();
	return raw === '1' || raw === 'true' || raw === 'yes';
}
