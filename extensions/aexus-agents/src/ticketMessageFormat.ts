/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Exact, immutable prefix literal delivered by the Control Center on `ade_create` / `ade_edit`.
 * Recognizes Ticket messages in the chat UI strictly read-only without ever mutating message text.
 */
export const ADE_TICKET_MESSAGE_PREFIX_START = '[系统提示词: 此消息是来自Agent {';

export interface IParsedTicketMessageEnvelope {
	readonly fromAgentId: string;
	readonly ticketId?: string;
	readonly taskId?: string;
	readonly taskType?: string;
	readonly needReturn?: boolean;
	readonly hasDetailRef?: boolean;
	readonly hasHistoryRef?: boolean;
	readonly taskTitle?: string;
	readonly summary?: string;
}

export function isAdeTicketDeliveryMessage(text: string | undefined): boolean {
	return typeof text === 'string' && text.startsWith(ADE_TICKET_MESSAGE_PREFIX_START);
}

export function parseAdeTicketDeliveryMessage(text: string): IParsedTicketMessageEnvelope | undefined {
	if (!isAdeTicketDeliveryMessage(text)) {
		return undefined;
	}
	const lines = text.split(/\r?\n/);
	const headerMatch = /^\[系统提示词: 此消息是来自Agent \{([^}\r\n]+)\}的Ticket\] $/.exec(lines[0] ?? '');
	if (!headerMatch) {
		return undefined;
	}
	const fromAgentId = headerMatch[1];
	let ticketId: string | undefined;
	let taskId: string | undefined;
	let taskType: string | undefined;
	let needReturn: boolean | undefined;
	let hasDetailRef: boolean | undefined;
	let hasHistoryRef: boolean | undefined;
	let taskTitle: string | undefined;
	let summary: string | undefined;

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith('ticket_id:')) {
			for (const seg of line.split('|')) {
				const [k, v] = seg.split(':').map(s => s.trim());
				if (k === 'ticket_id') { ticketId = v; }
				else if (k === 'task_id') { taskId = v; }
				else if (k === 'task_type') { taskType = v; }
				else if (k === 'need_return') { needReturn = v === 'true'; }
			}
		} else if (line.startsWith('has_detail_ref:')) {
			for (const seg of line.split('|')) {
				const [k, v] = seg.split(':').map(s => s.trim());
				if (k === 'has_detail_ref') { hasDetailRef = v === 'true'; }
				else if (k === 'has_history_ref') { hasHistoryRef = v === 'true'; }
			}
		} else if (line.startsWith('task_title:')) {
			taskTitle = line.slice('task_title:'.length).trim();
		} else if (line.startsWith('summary:')) {
			summary = line.slice('summary:'.length).trim();
		}
	}

	return {
		fromAgentId,
		ticketId,
		taskId,
		taskType,
		needReturn,
		hasDetailRef,
		hasHistoryRef,
		taskTitle,
		summary,
	};
}

export const parseTicketMessageEnvelope = parseAdeTicketDeliveryMessage;

/**
 * Formats a parsed Ticket delivery message strictly for read-only ChatSession history display.
 * Never mutates the underlying engine prompt payload.
 */
export function formatTicketMessageDisplayMarkdown(env: IParsedTicketMessageEnvelope): string {
	const badges: string[] = [`Ticket from \`${env.fromAgentId}\``];
	if (env.ticketId) { badges.push(`\`${env.ticketId}\``); }
	if (env.taskId) { badges.push(`\`${env.taskId}\``); }
	if (env.taskType) { badges.push(`type: \`${env.taskType}\``); }
	if (env.needReturn !== undefined) { badges.push(`need_return: \`${String(env.needReturn)}\``); }
	const lines: string[] = [`**${badges.join(' · ')}**`];
	if (env.taskTitle) {
		lines.push(`- **Title**: ${env.taskTitle}`);
	}
	if (env.summary) {
		lines.push(`- **Summary**: ${env.summary}`);
	}
	if (env.hasDetailRef || env.hasHistoryRef) {
		lines.push(`- **Refs**: detail=\`${Boolean(env.hasDetailRef)}\` | history=\`${Boolean(env.hasHistoryRef)}\``);
	}
	return lines.join('\n');
}
