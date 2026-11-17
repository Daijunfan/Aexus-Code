/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { WorkbenchModeService } from '../../browser/workbenchModeService.js';
import { WorkbenchMode } from '../../common/workbenchMode.js';

suite('Workbench development modes', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('restores the mode and publishes only actual changes', () => {
		const storage = store.add(new TestStorageService());
		const context = store.add(new MockContextKeyService());
		const service = store.add(new WorkbenchModeService(storage, context));
		const changes: WorkbenchMode[] = [];
		store.add(service.onDidChangeMode(mode => changes.push(mode)));
		service.setMode('ade');
		service.setMode('ade');
		const restored = store.add(new WorkbenchModeService(storage, context));
		assert.deepStrictEqual({ changes, mode: restored.mode, context: context.getContextKeyValue('aexusWorkbenchMode') }, { changes: ['ade'], mode: 'ade', context: 'ade' });
		service.setMode('ide');
		assert.deepStrictEqual(changes, ['ade', 'ide']);
	});
});
