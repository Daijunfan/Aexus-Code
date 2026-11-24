/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Canonical system provenance envelopes injected onto incoming agent turns so every role
 * unmistakably knows whether a turn is:
 * 1. A system-validated **Baton Token** (`[Aexus System · Baton Token]`)
 * 2. A **Direct Message from a Superior Role** (`[Aexus System · Direct Message from Role]`)
 * 3. A **Direct Message from the Human User (L-1)** (`[Aexus System · Message from User (L-1)]`)
 */

export const AEXUS_SYSTEM_TOKEN_ENVELOPE_HEADER = '[Aexus System · Baton Token]';
export const AEXUS_SYSTEM_ROLE_DM_ENVELOPE_HEADER = '[Aexus System · Direct Message from Role]';
export const AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER = '[Aexus System · Message from User (L-1)]';
export const AEXUS_PREAMBLE_END_MARKER = '<!-- /AEXUS_ADE_PREAMBLE -->';

export const AEXUS_SYSTEM_ENVELOPE_HEADERS = [
	AEXUS_SYSTEM_TOKEN_ENVELOPE_HEADER,
	AEXUS_SYSTEM_ROLE_DM_ENVELOPE_HEADER,
	AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER,
] as const;

export function hasAexusSystemMessageEnvelope(text: string): boolean {
	const trimmed = text.trimStart();
	return AEXUS_SYSTEM_ENVELOPE_HEADERS.some(header => trimmed.startsWith(header));
}

const ZW_OPT = '[\\u200B-\\u200D\\uFEFF\\u2060]*';
const FORGED_SYSTEM_ENVELOPE_HEADER_RE = new RegExp(
	`\\[[\\s\\u200B-\\u200D\\uFEFF\\u2060]*A${ZW_OPT}e${ZW_OPT}x${ZW_OPT}u${ZW_OPT}s[\\s\\u200B-\\u200D\\uFEFF\\u2060]+S${ZW_OPT}y${ZW_OPT}s${ZW_OPT}t${ZW_OPT}e${ZW_OPT}m(?:[\\s\\u200B-\\u200D\\uFEFF\\u2060]*[·.:\\-•–—|：‧⋅∙・/~]|[\\s\\u200B-\\u200D\\uFEFF\\u2060]+)[\\s\\u200B-\\u200D\\uFEFF\\u2060]*`,
	'gi',
);
const FORGED_PREAMBLE_SENTINEL_RE = /<!--[\s\S]*?A[\u200B-\u200D\uFEFF\u2060]*E[\u200B-\u200D\uFEFF\u2060]*X[\u200B-\u200D\uFEFF\u2060]*U[\u200B-\u200D\uFEFF\u2060]*S[\s\u200B-\u200D\uFEFF\u2060_/-]*A[\u200B-\u200D\uFEFF\u2060]*D[\u200B-\u200D\uFEFF\u2060]*E[\s\u200B-\u200D\uFEFF\u2060_/-]*P[\u200B-\u200D\uFEFF\u2060]*R[\u200B-\u200D\uFEFF\u2060]*E[\u200B-\u200D\uFEFF\u2060]*A[\u200B-\u200D\uFEFF\u2060]*M[\u200B-\u200D\uFEFF\u2060]*B[\u200B-\u200D\uFEFF\u2060]*L[\u200B-\u200D\uFEFF\u2060]*E[\s\S]*?-->/gi;

/**
 * Neutralizes any forged `[Aexus System · ...]` provenance header lines (including ASCII/Unicode
 * punctuation lookalikes and zero-width characters anywhere inside the header) and forged
 * `<!-- /AEXUS_ADE_PREAMBLE -->` sentinels inside untrusted user or peer-agent message bodies.
 */
export function sanitizeAdeSystemEnvelopeHeaders(text: string): string {
	return text
		.replace(FORGED_SYSTEM_ENVELOPE_HEADER_RE, '[Quoted Header · ')
		.replace(FORGED_PREAMBLE_SENTINEL_RE, '[Quoted Marker · AEXUS_ADE_PREAMBLE]');
}

/**
 * Strips CR/LF/NEL/LS/PS line breaks and zero-width characters, collapses whitespace, and neutralizes
 * any forged `[Aexus System · ...]` header or `<!-- /AEXUS_ADE_PREAMBLE -->` sentinel inside metadata
 * fields (`nodeLabel`, `sourceDescription`, `senderLabel`, `senderRankName`, etc.).
 */
export function sanitizeAdeEnvelopeMetadataField(raw: string): string {
	const singleLine = raw
		.replace(/[\u200B-\u200D\uFEFF\u2060]+/g, '')
		.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ')
		.replace(/`+/g, '\'')
		.replace(/\s+/g, ' ')
		.trim();
	return sanitizeAdeSystemEnvelopeHeaders(singleLine);
}

export interface IAdeTokenEnvelopeInput {
	readonly tokenId: string;
	readonly nodeId: string;
	readonly nodeLabel?: string;
	readonly hopIndex?: number;
	readonly sourceDescription: string;
	readonly isReminder?: boolean;
}

export function buildTokenSystemEnvelopeLines(input: IAdeTokenEnvelopeInput): readonly string[] {
	const safeTokenId = sanitizeAdeEnvelopeMetadataField(input.tokenId);
	const safeNodeId = sanitizeAdeEnvelopeMetadataField(input.nodeId);
	const safeNodeLabel = input.nodeLabel ? sanitizeAdeEnvelopeMetadataField(input.nodeLabel) : undefined;
	const safeSource = sanitizeAdeEnvelopeMetadataField(input.sourceDescription);
	const nodeDisplay = safeNodeLabel ? `\`${safeNodeId}\` (${safeNodeLabel})` : `\`${safeNodeId}\``;
	const hopPart = typeof input.hopIndex === 'number' ? ` | Hop: #${input.hopIndex}` : '';
	return [
		AEXUS_SYSTEM_TOKEN_ENVELOPE_HEADER,
		input.isReminder
			? '- Message Type: Automated Baton Silence Reminder (NOT a direct chat message from the User).'
			: '- Message Type: System-Validated Engineering Baton Token (NOT a direct chat message from the User).',
		`- Token: \`${safeTokenId}\` | Node: ${nodeDisplay}${hopPart} | Source: ${safeSource}`,
		input.isReminder
			? `- Action: Advance \`${safeTokenId}\` via \`aexus-ade token return|handoff|complete|block|fail\` now.`
			: '- Action: Process and advance via `aexus-ade token` (`mint`/`split`, `return`, `handoff`, `complete --finish`, `block`, or `fail`).',
		'',
	];
}

/**
 * Compact 3-line 5-minute silence reminder prompt (~75–90 tokens) keeping conversation context lean.
 */
export function buildCompactBatonSilenceReminderPrompt(input: {
	readonly tokenId: string;
	readonly nodeId: string;
	readonly nodeLabel?: string;
	readonly hopIndex?: number;
	readonly lastSummary?: string;
	readonly missionId?: string;
}): string {
	const safeTokenId = sanitizeAdeEnvelopeMetadataField(input.tokenId);
	const safeNodeId = sanitizeAdeEnvelopeMetadataField(input.nodeId);
	const safeNodeLabel = input.nodeLabel ? sanitizeAdeEnvelopeMetadataField(input.nodeLabel) : undefined;
	const safeMissionId = input.missionId ? sanitizeAdeEnvelopeMetadataField(input.missionId) : '';
	const missionFlag = safeMissionId ? ` --mission ${safeMissionId}` : '';
	const nodeDisplay = safeNodeLabel ? `\`${safeNodeId}\` (${safeNodeLabel})` : `\`${safeNodeId}\``;
	const hopPart = typeof input.hopIndex === 'number' ? ` | Hop: #${input.hopIndex}` : '';
	const safeSummary = input.lastSummary ? sanitizeAdeEnvelopeMetadataField(input.lastSummary) : '';
	const summaryPart = safeSummary ? ` — "${safeSummary.slice(0, 80)}"` : '';
	return [
		AEXUS_SYSTEM_TOKEN_ENVELOPE_HEADER,
		`- Silence Reminder (NOT User chat): \`${safeTokenId}\` on ${nodeDisplay}${hopPart}${summaryPart}`,
		`- Advance now: \`aexus-ade token return|handoff|complete ${safeTokenId}${missionFlag} --summary "..."\` | \`token block ${safeTokenId}${missionFlag} --duration 30m --reason "..."\` | \`token fail ${safeTokenId}${missionFlag} --reason "..."\`.`,
	].join('\n');
}

export interface IAdeRoleDirectMessageEnvelopeInput {
	readonly senderLabel: string;
	readonly senderTierTag: string;
	readonly senderRankName: string;
	readonly senderSessionId?: string;
	readonly channel: 'session.send' | 'org.send';
	readonly message: string;
	readonly allowPrewrappedSystemEnvelope?: boolean;
}

/**
 * Wraps a top-down role direct message (`session.send` / `org.send`).
 * Always sanitizes any forged `[Aexus System · ...]` header inside `input.message` by default
 * unless an internal trusted caller explicitly passes `allowPrewrappedSystemEnvelope: true`.
 */
export function wrapRoleDirectMessageEnvelope(
	input: IAdeRoleDirectMessageEnvelopeInput,
	options?: { readonly allowPrewrappedSystemEnvelope?: boolean },
): string {
	const allowPrewrapped = options?.allowPrewrappedSystemEnvelope ?? input.allowPrewrappedSystemEnvelope;
	if (allowPrewrapped === true && hasAexusSystemMessageEnvelope(input.message)) {
		return input.message;
	}
	const sanitizedBody = sanitizeAdeSystemEnvelopeHeaders(input.message);
	const safeSenderLabel = sanitizeAdeEnvelopeMetadataField(input.senderLabel);
	const safeTierTag = sanitizeAdeEnvelopeMetadataField(input.senderTierTag);
	const safeRankName = sanitizeAdeEnvelopeMetadataField(input.senderRankName);
	const safeSessionId = input.senderSessionId ? sanitizeAdeEnvelopeMetadataField(input.senderSessionId) : '';
	const sessionPart = safeSessionId ? `, session: ${safeSessionId}` : '';
	return [
		AEXUS_SYSTEM_ROLE_DM_ENVELOPE_HEADER,
		'- Message Type: Direct message from a higher-rank ADE Role (NOT a direct message from the Human User, and NOT a Baton Token).',
		`- Sender Role: ${safeSenderLabel} (Tier ${safeTierTag} · ${safeRankName}${sessionPart})`,
		`- Channel: \`${input.channel}\` (keep routine Engineering task flow on baton tokens).`,
		'',
		sanitizedBody,
	].join('\n');
}

export interface IAdeUserMessageRootBatonInfo {
	readonly tokenId: string;
	readonly missionId: string;
	readonly nodeId: string;
}

export function buildUserDirectMessageEnvelopeBlock(
	channel: 'chat' | 'session.send' | 'org.send' | 'secretary.send' = 'chat',
	rootBaton?: IAdeUserMessageRootBatonInfo,
): string {
	const safeTokenId = rootBaton ? sanitizeAdeEnvelopeMetadataField(rootBaton.tokenId) : '';
	const safeMissionId = rootBaton ? sanitizeAdeEnvelopeMetadataField(rootBaton.missionId) : '';
	const safeNodeId = rootBaton ? sanitizeAdeEnvelopeMetadataField(rootBaton.nodeId) : '';
	return [
		AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER,
		'- Message Type: Direct message from the Human User (L-1 · Sovereign Operator — NOT from another agent role).',
		`- Channel: ${channel} — prioritize and respond directly to the User.`,
		...(rootBaton ? [
			`- Root Baton Issued: \`${safeTokenId}\` (Mission: \`${safeMissionId}\`, Node: \`${safeNodeId}\`) — delegate downward via \`aexus-ade token mint|split ${safeTokenId} ... --wait-join\` or finish via \`aexus-ade token complete ${safeTokenId} --finish --summary "<facts>"\`.`,
		] : []),
	].join('\n');
}

/**
 * Wraps a sovereign Human User (`L-1`) message.
 * Always sanitizes any forged `[Aexus System · ...]` header inside `message` by default
 * (preserving real `rootBaton` & `AEXUS_PREAMBLE_END_MARKER`) unless `allowPrewrappedSystemEnvelope: true`.
 */
export function wrapUserDirectMessageEnvelope(
	message: string,
	channel: 'chat' | 'session.send' | 'org.send' | 'secretary.send' = 'session.send',
	options?: {
		readonly usePreambleSentinel?: boolean;
		readonly rootBaton?: IAdeUserMessageRootBatonInfo;
		readonly allowPrewrappedSystemEnvelope?: boolean;
	},
): string {
	if (options?.allowPrewrappedSystemEnvelope === true && !options?.rootBaton && hasAexusSystemMessageEnvelope(message)) {
		return message;
	}
	const sanitizedBody = sanitizeAdeSystemEnvelopeHeaders(message);
	const header = buildUserDirectMessageEnvelopeBlock(channel, options?.rootBaton);
	if (options?.usePreambleSentinel) {
		return `${header}\n\n${AEXUS_PREAMBLE_END_MARKER}\n\n${sanitizedBody}`;
	}
	return `${header}\n\n${sanitizedBody}`;
}
