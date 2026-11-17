/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { MockContextKeyService } from '../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IExtensionService, nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { IStatusbarEntry, IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { WorkbenchModeService } from '../../../services/workbenchMode/browser/workbenchModeService.js';
import { TestStorageService } from '../../../test/common/workbenchTestServices.js';
import { ExtensionStatusBarItemService, IExtensionStatusBarItemChangeEvent, StatusBarUpdateKind } from '../../browser/statusBarExtensionPoint.js';

suite('Extension status bar mode visibility', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const agent: IExtensionDescription = {
		...nullExtensionDescription,
		identifier: new ExtensionIdentifier('test.agent'),
		contributes: { chatParticipants: [{ id: 'agent', name: 'agent', fullName: 'Agent', isDefault: true }] },
	};
	let rendered: Map<string, IStatusbarEntry>;
	let mode: WorkbenchModeService;
	let registered: Emitter<void>;
	let extensions: IExtensionService & { extensions: IExtensionDescription[] };
	let service: ExtensionStatusBarItemService;

	setup(() => {
		rendered = new Map();
		mode = store.add(new WorkbenchModeService(store.add(new TestStorageService()), store.add(new MockContextKeyService())));
		registered = store.add(new Emitter<void>());
		extensions = new class extends mock<IExtensionService>() {
			override extensions = [agent];
			override onDidRegisterExtensions = registered.event;
			override onDidChangeExtensions = Event.None;
		};
		service = store.add(new ExtensionStatusBarItemService(new class extends mock<IStatusbarService>() {
			override addEntry(entry: IStatusbarEntry, id: string) {
				rendered.set(id, entry);
				const disposable = toDisposable(() => rendered.delete(id));
				return { update: (entry: IStatusbarEntry) => rendered.set(id, entry), dispose: () => disposable.dispose() };
			}
		}, mode, extensions));
	});

	function set(id: string, extensionId: string, text: string) {
		return service.setOrUpdateEntry(id, id, extensionId, id, text, undefined, undefined, undefined, undefined, true, 10, undefined);
	}

	test('hides only Agent UI and restores the latest entry without changing its extension lifetime', () => {
		const changes: IExtensionStatusBarItemChangeEvent[] = [];
		store.add(service.onDidChange(change => changes.push(change)));
		assert.strictEqual(set('agent.status', 'test.agent', 'Ready'), StatusBarUpdateKind.DidDefine);
		set('tool.status', 'test.tool', 'Tool');
		assert.deepStrictEqual([...rendered.keys()], ['agent.status', 'tool.status']);

		mode.setMode('ade');
		assert.deepStrictEqual([...rendered.keys()], ['tool.status']);
		assert.strictEqual(changes.length, 2);
		assert.strictEqual(set('agent.status', 'test.agent', 'Working'), StatusBarUpdateKind.DidUpdate);
		assert.strictEqual([...service.getEntries()].length, 2);

		mode.setMode('ide');
		assert.strictEqual(rendered.get('agent.status')?.text, 'Working');
		assert.strictEqual(changes.length, 2);
		mode.setMode('ade');
		service.unsetEntry('agent.status');
		mode.setMode('ide');
		assert.deepStrictEqual([...rendered.keys()], ['tool.status']);
		assert.deepStrictEqual(changes.at(-1), { removed: 'agent.status' });
	});

	test('applies ADE visibility to new entries and after extension registration', () => {
		mode.setMode('ade');
		set('agent.status', 'test.agent', 'Ready');
		assert.strictEqual(rendered.size, 0);
		extensions.extensions = [];
		registered.fire();
		assert.strictEqual(rendered.size, 1);
		extensions.extensions = [agent];
		registered.fire();
		assert.strictEqual(rendered.size, 0);
		service.dispose();
		mode.setMode('ide');
		assert.strictEqual(rendered.size, 0);
	});
});
