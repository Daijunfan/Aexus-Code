/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isNative } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceContextService, toWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../platform/workspace/test/common/testWorkspace.js';
import { ADD_ROOT_FOLDER_COMMAND_ID } from '../../../browser/actions/workspaceCommands.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { TestContextService } from '../../common/workbenchTestServices.js';
import { TestEnvironmentService, workbenchInstantiationService } from '../workbenchTestServices.js';

suite('Project folders', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const first = URI.file('/projects/first');
	const second = URI.file('/projects/second');

	function setup(workspace: Workspace, selected?: URI[]) {
		const created: { folders: string[]; path: URI | undefined }[] = [];
		const added: string[][] = [];
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IWorkspaceContextService, new TestContextService(workspace));
		instantiationService.stub(IFileDialogService, {
			defaultFolderPath: async () => first,
			showOpenDialog: async () => selected,
		});
		instantiationService.stub(IWorkspaceEditingService, {
			createAndEnterWorkspace: async (folders, path) => { created.push({ folders: folders.map(folder => folder.uri.toString()), path }); },
			addFolders: async folders => { added.push(folders.map(folder => folder.uri.toString())); },
		});
		const add = (folders?: URI[]) => instantiationService.invokeFunction(CommandsRegistry.getCommand(ADD_ROOT_FOLDER_COMMAND_ID)!.handler, folders);
		return { created, added, add };
	}

	test('adds selected projects to an existing workspace without replacing it', async () => {
		const { created, added, add } = setup(new Workspace('existing', [toWorkspaceFolder(first)], URI.file('/projects.code-workspace')));
		await add([second]);
		assert.deepStrictEqual({ created, added }, { created: [], added: [[second.toString()]] });
	});

	test('canceling the project picker keeps the workspace unchanged', async () => {
		const { created, added, add } = setup(new Workspace('empty'), undefined);
		await add();
		assert.deepStrictEqual({ created, added }, { created: [], added: [] });
	});

	(isNative ? test : test.skip)('saves the first project list in application data', async () => {
		const { created, added, add } = setup(new Workspace('empty'), [first, second]);
		await add();
		assert.deepStrictEqual({ created, added }, {
			created: [{ folders: [first.toString(), second.toString()], path: joinPath(TestEnvironmentService.untitledWorkspacesHome, '..', 'Projects', 'empty', 'projects.code-workspace') }],
			added: [],
		});
	});

	(isNative ? test : test.skip)('keeps the current folder when adding another project and ignores duplicates', async () => {
		const { created, added, add } = setup(new Workspace('single', [toWorkspaceFolder(first)]));
		await add([first]);
		await add([first, second, second]);
		assert.deepStrictEqual({ created, added }, {
			created: [{ folders: [first.toString(), second.toString()], path: joinPath(TestEnvironmentService.untitledWorkspacesHome, '..', 'Projects', 'single', 'projects.code-workspace') }],
			added: [],
		});
	});
});
