/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ProjectNavigationService } from '../../browser/projectNavigationService.js';

suite('IDE project navigation', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const alpha = URI.file('/projects/Alpha');
	const beta = URI.file('/projects/Beta');

	function setup(resources = [alpha, beta]) {
		let workspace = new Workspace('home', resources.map(toWorkspaceFolder));
		const foldersChanged = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IWorkspaceContextService, { getWorkspace: () => workspace, onDidChangeWorkspaceFolders: foldersChanged.event });
		const service = store.add(instantiationService.createInstance(ProjectNavigationService));
		return {
			service,
			workspace,
			context: instantiationService.get(IContextKeyService),
			restore: () => store.add(instantiationService.createInstance(ProjectNavigationService)),
			removeBeta: () => {
				const removed = workspace.folders[1];
				workspace = new Workspace('home', [toWorkspaceFolder(alpha)]);
				foldersChanged.fire({ added: [], removed: [removed], changed: [] });
			},
		};
	}

	test('starts at Home and enters and leaves a project without replacing workspace folders', () => {
		const { service, workspace, context } = setup();
		const changes: (string | undefined)[] = [];
		store.add(service.onDidChangeProject(project => changes.push(project?.name)));
		assert.deepStrictEqual({ focus: service.focusedProject }, { focus: undefined });
		service.enterProject(beta);
		service.enterProject(beta);
		assert.deepStrictEqual({ focus: service.focusedProject?.name, flag: context.getContextKeyValue('aexusIdeProjectFocused'), roots: workspace.folders.map(folder => folder.name) }, { focus: 'Beta', flag: true, roots: ['Alpha', 'Beta'] });
		service.goHome();
		service.goHome();
		assert.deepStrictEqual({ focus: service.focusedProject, flag: context.getContextKeyValue('aexusIdeProjectFocused'), changes }, { focus: undefined, flag: false, changes: ['Beta', undefined] });
	});

	test('only enters registered project roots and normalizes a trailing separator', () => {
		const { service } = setup();
		service.enterProject(URI.file('/projects/Beta/src'));
		assert.deepStrictEqual({ focus: service.focusedProject }, { focus: undefined });
		service.enterProject(URI.file('/projects/Beta/'));
		assert.strictEqual(service.focusedProject?.name, 'Beta');
	});

	test('returns Home if the focused project is removed', () => {
		const { service, removeBeta, context } = setup();
		service.enterProject(beta);
		removeBeta();
		assert.deepStrictEqual({ focus: service.focusedProject, flag: context.getContextKeyValue('aexusIdeProjectFocused') }, { focus: undefined, flag: false });
	});

	test('selects and restores a project independently of Home order and folder focus', () => {
		const { service, restore, removeBeta } = setup();
		const changes: (string | undefined)[] = [];
		store.add(service.onDidChangeSelectedProject(project => changes.push(project?.name)));
		service.selectProject(URI.joinPath(beta, 'src/index.ts'));
		service.selectProject(beta);
		service.moveProjects([beta], alpha, false);
		const restored = restore().selectedProject?.name;
		service.enterProject(alpha);
		service.selectProject(beta);
		const focused = service.selectedProject?.name;
		service.goHome();
		service.selectProject(beta);
		removeBeta();
		assert.deepStrictEqual({ restored, focused, selected: service.selectedProject?.name, changes }, { restored: 'Beta', focused: 'Alpha', selected: 'Alpha', changes: ['Beta', 'Alpha', 'Beta', 'Alpha'] });
	});

	test('recognizes a single project at startup without choosing an arbitrary multi-root project', () => {
		const single = setup([alpha]).service;
		const multiple = setup().service;
		assert.deepStrictEqual({ single: single.selectedProject?.name, multiple: multiple.selectedProject }, { single: 'Alpha', multiple: undefined });
	});

	test('returns Home and goes forward to the last focused project', () => {
		const { service, context, workspace } = setup();
		service.enterProject(beta);
		service.goHome();
		const home = { focused: service.focusedProject?.name, forward: service.canGoForward, context: context.getContextKeyValue('aexusIdeProjectCanGoForward') };
		service.goForward();
		assert.deepStrictEqual({ home, focused: service.focusedProject?.name, forward: service.canGoForward, roots: workspace.folders.map(folder => folder.name) }, {
			home: { focused: undefined, forward: true, context: true }, focused: 'Beta', forward: false, roots: ['Alpha', 'Beta'],
		});
	});

	test('focus on another project replaces the previous forward destination', () => {
		const { service } = setup();
		service.enterProject(alpha);
		service.goHome();
		service.enterProject(beta);
		const forwardWhileFocused = service.canGoForward;
		service.goHome();
		service.goForward();
		assert.deepStrictEqual({ forwardWhileFocused, focused: service.focusedProject?.name }, { forwardWhileFocused: false, focused: 'Beta' });
	});

	test('does not navigate forward to a project removed from Home', () => {
		const { service, removeBeta } = setup();
		service.enterProject(beta);
		service.goHome();
		removeBeta();
		service.goForward();
		assert.deepStrictEqual({ focused: service.focusedProject, forward: service.canGoForward }, { focused: undefined, forward: false });
	});
});
