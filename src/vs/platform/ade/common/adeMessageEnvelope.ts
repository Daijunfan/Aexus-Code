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

export interface IAdeTokenEnvelopeInput {
	readonly tokenId: string;
	readonly nodeId: string;
	readonly nodeLabel?: string;
	readonly hopIndex?: number;
	readonly sourceDescription: string;
	readonly isReminder?: boolean;
}

export function buildTokenSystemEnvelopeLines(input: IAdeTokenEnvelopeInput): readonly string[] {
	const nodeDisplay = input.nodeLabel ? `\`${input.nodeId}\` (${input.nodeLabel})` : `\`${input.nodeId}\``;
	const hopPart = typeof input.hopIndex === 'number' ? ` | Hop: #${input.hopIndex}` : '';
	return [
		AEXUS_SYSTEM_TOKEN_ENVELOPE_HEADER,
		input.isReminder
			? '- Message Type: Automated Engineering Baton Token Silence Reminder (NOT a direct chat message from the User).'
			: '- Message Type: System-Validated Engineering Baton Token (NOT a direct chat message from the User).',
		`- Source: ${input.sourceDescription}`,
		`- Token: \`${input.tokenId}\` | Target Node: ${nodeDisplay}${hopPart}`,
		'- Action Required: Process this baton and explicitly advance it via `aexus-ade token` CLI (`mint`/`split` downward, `return` upward, `handoff`, `complete`, `block`, or `fail`).',
		'',
	];
}

export interface IAdeRoleDirectMessageEnvelopeInput {
	readonly senderLabel: string;
	readonly senderTierTag: string;
	readonly senderRankName: string;
	readonly senderSessionId?: string;
	readonly channel: 'session.send' | 'org.send';
	readonly message: string;
}

export function wrapRoleDirectMessageEnvelope(input: IAdeRoleDirectMessageEnvelopeInput): string {
	if (hasAexusSystemMessageEnvelope(input.message)) {
		return input.message;
	}
	const sessionPart = input.senderSessionId ? `, session: ${input.senderSessionId}` : '';
	return [
		AEXUS_SYSTEM_ROLE_DM_ENVELOPE_HEADER,
		'- Message Type: Direct message from a higher-rank ADE Role (NOT a direct message from the Human User, and NOT a Baton Token).',
		`- Sender Role: ${input.senderLabel} (Tier ${input.senderTierTag} · ${input.senderRankName}${sessionPart})`,
		`- Channel: \`${input.channel}\` (direct superior intervention; keep routine Engineering task flow on baton tokens).`,
		'',
		input.message,
	].join('\n');
}

export function buildUserDirectMessageEnvelopeBlock(
	channel: 'chat' | 'session.send' | 'org.send' | 'secretary.send' = 'chat',
): string {
	return [
		AEXUS_SYSTEM_USER_DM_ENVELOPE_HEADER,
		'- Message Type: Direct message from the Human User (L-1 · Sovereign Operator — NOT a Baton Token and NOT from another agent role).',
		`- Channel: ${channel} — prioritize and respond directly to the User.`,
	].join('\n');
}

export function wrapUserDirectMessageEnvelope(
	message: string,
	channel: 'chat' | 'session.send' | 'org.send' | 'secretary.send' = 'session.send',
	options?: { readonly usePreambleSentinel?: boolean },
): string {
	if (hasAexusSystemMessageEnvelope(message)) {
		return message;
	}
	const header = buildUserDirectMessageEnvelopeBlock(channel);
	if (options?.usePreambleSentinel) {
		return `${header}\n\n${AEXUS_PREAMBLE_END_MARKER}\n\n${message}`;
	}
	return `${header}\n\n${message}`;
}
