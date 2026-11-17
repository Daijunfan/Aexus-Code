/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IWorkspaceContextService, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { WorkbenchModeContext } from '../../../../services/workbenchMode/common/workbenchMode.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import '../../browser/fileActions.contribution.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../browser/projectNavigationService.js';
import { ExplorerFolderContext, ExplorerRootContext } from '../../common/files.js';

suite('Project Focus and titlebar navigation', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const alpha = URI.file('/projects/Alpha');
	const beta = URI.file('/projects/Beta');

	test('offers Focus on a project and switches the upper-left Home/Forward controls across IDE and ADE', async () => {
		const instantiation = workbenchInstantiationService(undefined, store);
		const context = store.add(instantiation.createInstance(ContextKeyService));
		instantiation.stub(IContextKeyService, context);
		const modeKey = WorkbenchModeContext.bindTo(context);
		modeKey.set('ide');
		ExplorerRootContext.bindTo(context).set(true);
		ExplorerFolderContext.bindTo(context).set(true);
		const workspace = new Workspace('projects', [toWorkspaceFolder(alpha), toWorkspaceFolder(beta)]);
		instantiation.stub(IWorkspaceContextService, new TestContextService(workspace));
		const navigation = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, navigation);
		const menus = store.add(instantiation.createInstance(MenuService));
		instantiation.stub(IMenuService, menus);
		const explorerMenu = store.add(menus.createMenu(MenuId.ExplorerContext, context));
		const explorerMenuActions = explorerMenu.getActions().flatMap(([, actions]) => actions);
		const focus = explorerMenuActions.find(action => action.id === 'workbench.action.projects.enter');
		const removeProject = explorerMenuActions.find(action => action.id === 'removeRootFolder');
		const deleteProject = explorerMenuActions.find(action => action.id === 'workbench.action.projects.delete');
		assert.deepStrictEqual({
			focus: focus?.label,
			removeProject: removeProject?.label,
			deleteProject: deleteProject?.label,
		}, {
			focus: 'Focus',
			removeProject: 'Remove Project',
			deleteProject: 'Delete Project...',
		});
		const left = append(document.body, $('.titlebar-left'));
		store.add({ dispose: () => left.remove() });
		const element = append(left, $('.project-navigation-toolbar'));
		const toolbar = store.add(instantiation.createInstance(MenuWorkbenchToolBar, element, MenuId.TitleBarProjectNavigation, {}));
		const state = () => ({ home: !!element.querySelector('.codicon-home'), forward: !!element.querySelector('.codicon-arrow-right'), project: navigation.focusedProject?.name });
		const states = [state()];
		const run = async (id: string, resource?: URI) => {
			const changed = Event.toPromise(toolbar.onDidChangeMenuItems);
			await instantiation.invokeFunction(CommandsRegistry.getCommand(id)!.handler, resource);
			await changed;
			states.push(state());
		};
		await run('workbench.action.projects.enter', beta);
		await run('workbench.action.projects.home');
		await run('workbench.action.projects.enter', alpha);
		modeKey.set('ade');
		states.push(state());
		await run('workbench.action.projects.home');
		await run('workbench.action.projects.forward');
		assert.deepStrictEqual({ states, projects: workspace.folders.map(folder => folder.name) }, {
			states: [
				{ home: false, forward: false, project: undefined },
				{ home: true, forward: false, project: 'Beta' },
				{ home: false, forward: true, project: undefined },
				{ home: true, forward: false, project: 'Alpha' },
				{ home: true, forward: false, project: 'Alpha' },
				{ home: false, forward: true, project: undefined },
				{ home: true, forward: false, project: 'Alpha' },
			],
			projects: ['Alpha', 'Beta'],
		});
	});
});
