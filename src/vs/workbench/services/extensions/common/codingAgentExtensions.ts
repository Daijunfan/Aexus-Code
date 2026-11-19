/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionIdentifier, ExtensionIdentifierSet, IExtensionContributions, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';

/** The built-in ADE bridge owns explicit project sessions, independent of IDE workspaces. */
export function isWorkspaceIndependentExtension(extension: IExtensionDescription): boolean {
	return extension.isBuiltin && (
		ExtensionIdentifier.equals(extension.identifier, 'aexus.aexus-agents') ||
		ExtensionIdentifier.equals(extension.identifier, 'vscode.aexus-agents')
	);
}

export function getWorkspaceIndependentSessionTypes(extensions: readonly IExtensionDescription[]): ReadonlySet<string> {
	return new Set(extensions.filter(isWorkspaceIndependentExtension).flatMap(extension => {
		const contributes = extension.contributes as { chatSessions?: readonly { type: string }[] } | undefined;
		return contributes?.chatSessions?.map(session => session.type) ?? [];
	}));
}

const knownCodingAgentIds = new ExtensionIdentifierSet([
	'anthropic.claude-code',
	'openai.chatgpt',
	'saoudrizwan.claude-dev',
	'rooveterinaryinc.roo-cline',
	'harcochen.dsh-vsc-integration',
	'kilocode.kilo-code',
	'fengze233.dsh-vscode-panel',
	'zgy.opencode-vscode-ui',
	'sst-dev.opencode',
	'google.google-antigravity',
	'yesho.pi-coding-agent-vscode',
	'pi0.pi-vscode',
]);

export function isKnownCodingAgentId(id: ExtensionIdentifier | string): boolean {
	return knownCodingAgentIds.has(id);
}

/** Identifies Agent providers without treating every AI-related tool as a Coding Agent. */
export function isCodingAgentExtension(extension: IExtensionDescription): boolean {
	const sessions = (extension.contributes as IExtensionContributions & { readonly chatSessions?: readonly { readonly type: string }[] } | undefined)?.chatSessions;
	return knownCodingAgentIds.has(extension.identifier)
		|| !!sessions?.length
		|| !!extension.contributes?.chatParticipants?.some(participant => participant.isDefault);
}

const CONTEXTUAL_AGENT_EDITOR_TITLE_WHEN_RE = /\b(activeWebviewPanelId|viewingProposedDiff|hasActiveDiff|sideBySideReviewPending)\b/;

/**
 * Suppresses Coding Agent launcher icons from the Editor Title bar (in both IDE and ADE),
 * while preserving contextual actions scoped to an active diff review or the agent's own webview tab.
 */
export function shouldSuppressCodingAgentEditorTitleItem(extension: IExtensionDescription, rawWhen: string | undefined): boolean {
	if (!isCodingAgentExtension(extension)) {
		return false;
	}
	if (rawWhen && CONTEXTUAL_AGENT_EDITOR_TITLE_WHEN_RE.test(rawWhen)) {
		return false;
	}
	return true;
}
