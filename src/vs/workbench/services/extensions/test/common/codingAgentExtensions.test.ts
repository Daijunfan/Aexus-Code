/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExtensionIdentifier, IExtensionContributions, IExtensionDescription } from '../../../../../platform/extensions/common/extensions.js';
import { nullExtensionDescription } from '../../common/extensions.js';
import { isCodingAgentExtension, isKnownCodingAgentId, shouldSuppressCodingAgentEditorTitleItem } from '../../common/codingAgentExtensions.js';

type Contributions = IExtensionContributions & { readonly chatSessions?: readonly { readonly type: string }[] };

function extension(id: string, contributes?: Contributions): IExtensionDescription {
	return { ...nullExtensionDescription, identifier: new ExtensionIdentifier(id), contributes };
}

suite('Coding Agent extension UI classification', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes session providers and default Agent providers', () => {
		assert.deepStrictEqual([
			isCodingAgentExtension(extension('test.sessions', { chatSessions: [{ type: 'test-agent' }] })),
			isCodingAgentExtension(extension('test.default', { chatParticipants: [{ id: 'test', name: 'test', fullName: 'Test Agent', isDefault: true }] })),
			isCodingAgentExtension(extension('ANTHROPIC.CLAUDE-CODE')),
			isCodingAgentExtension(extension('openai.chatgpt')),
			isCodingAgentExtension(extension('saoudrizwan.claude-dev')),
			isCodingAgentExtension(extension('rooveterinaryinc.roo-cline')),
			isCodingAgentExtension(extension('harcochen.dsh-vsc-integration')),
			isCodingAgentExtension(extension('kilocode.kilo-code')),
			isCodingAgentExtension(extension('fengze233.dsh-vscode-panel')),
			isCodingAgentExtension(extension('zgy.opencode-vscode-ui')),
			isCodingAgentExtension(extension('sst-dev.opencode')),
			isCodingAgentExtension(extension('google.google-antigravity')),
			isCodingAgentExtension(extension('yesho.pi-coding-agent-vscode')),
			isCodingAgentExtension(extension('pi0.pi-vscode')),
			isKnownCodingAgentId('OPENAI.CHATGPT'),
		], [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]);
	});

	test('keeps ordinary tools and non-default chat integrations available', () => {
		assert.deepStrictEqual([
			isCodingAgentExtension(extension('test.files')),
			isCodingAgentExtension(extension('test.empty', { chatSessions: [] })),
			isCodingAgentExtension(extension('test.remote', { chatParticipants: [{ id: 'remote', name: 'remote', fullName: 'Remote Tool' }] })),
		], [false, false, false]);
	});

	test('suppresses Coding Agent launcher buttons from editor/title while preserving contextual diff and tab actions', () => {
		assert.deepStrictEqual([
			shouldSuppressCodingAgentEditorTitleItem(extension('anthropic.claude-code'), '!config.claudeCode.useTerminal'),
			shouldSuppressCodingAgentEditorTitleItem(extension('fengze233.dsh-vscode-panel'), 'editorIsOpen'),
			shouldSuppressCodingAgentEditorTitleItem(extension('openai.chatgpt'), undefined),
			shouldSuppressCodingAgentEditorTitleItem(extension('kilocode.kilo-code'), 'true'),
			shouldSuppressCodingAgentEditorTitleItem(extension('sst-dev.opencode'), undefined),
			shouldSuppressCodingAgentEditorTitleItem(extension('anthropic.claude-code'), 'claude-vscode.viewingProposedDiff'),
			shouldSuppressCodingAgentEditorTitleItem(extension('kilocode.kilo-code'), 'activeWebviewPanelId == kilo-code.new.TabPanel && !kilo-code.new.isCursor'),
			shouldSuppressCodingAgentEditorTitleItem(extension('google.google-antigravity'), 'resourceScheme == file && antigravity.hasActiveDiff'),
			shouldSuppressCodingAgentEditorTitleItem(extension('ms-vscode.cmake-tools'), 'resourceLangId == cpp'),
		], [true, true, true, true, true, false, false, false, false]);
	});
});
