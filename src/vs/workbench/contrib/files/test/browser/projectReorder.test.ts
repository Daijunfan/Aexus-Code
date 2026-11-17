/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ElementsDragAndDropData, ListViewTargetSector } from '../../../../../base/browser/ui/list/listView.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { NullFilesConfigurationService, TestContextService, TestFileService } from '../../../../test/common/workbenchTestServices.js';
import { IExplorerService, IExplorerView } from '../../browser/files.js';
import { FileDragAndDrop, FileSorter } from '../../browser/views/explorerViewer.js';
import { ExplorerItem, ExplorerModel } from '../../common/explorerModel.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../browser/projectNavigationService.js';
import { ExplorerService } from '../../browser/explorerService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';
import { mock } from '../../../../../base/test/common/mock.js';

suite('IDE project ordering', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const configuration = new TestConfigurationService({ explorer: { enableDragAndDrop: true, confirmDragAndDrop: true } });
		const instantiationService = workbenchInstantiationService({ configurationService: () => configuration }, store);
		const folders = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((name, index) => new WorkspaceFolder({ uri: URI.file(`/projects/${name}`), name, index }));
		let workspace = new Workspace('project-order', folders);
		const changed = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		instantiationService.stub(IWorkspaceContextService, { getWorkspace: () => workspace, onDidChangeWorkspaceFolders: changed.event });
		const model = store.add(new ExplorerModel(instantiationService.get(IWorkspaceContextService), instantiationService.get(IUriIdentityService), instantiationService.get(IFileService), configuration, NullFilesConfigurationService));
		instantiationService.stub(IExplorerService, { roots: model.roots });
		const navigation = store.add(instantiationService.createInstance(ProjectNavigationService));
		instantiationService.stub(IProjectNavigationService, navigation);
		instantiationService.stub(IDialogService, { confirm: () => assert.fail('Project ordering must not prompt'), error: () => assert.fail('Project ordering failed') });
		const dnd = store.add(instantiationService.createInstance(FileDragAndDrop, () => true));
		return { model, dnd, navigation, workspace, restore: () => store.add(instantiationService.createInstance(ProjectNavigationService)), removeBeta: () => {
			workspace = new Workspace('project-order', folders.filter(folder => folder.name !== 'Beta'));
			changed.fire({ added: [], removed: [folders[1]], changed: [] });
		} };
	}

	for (const { sources, target, sector, expected } of [
		{ sources: [2], target: 0, sector: ListViewTargetSector.TOP, expected: ['Gamma', 'Alpha', 'Beta', 'Delta'] },
		{ sources: [0], target: 2, sector: ListViewTargetSector.BOTTOM, expected: ['Beta', 'Gamma', 'Alpha', 'Delta'] },
		{ sources: [0, 1], target: 2, sector: ListViewTargetSector.TOP, expected: undefined },
		{ sources: [0, 1], target: 2, sector: ListViewTargetSector.BOTTOM, expected: ['Gamma', 'Alpha', 'Beta', 'Delta'] },
		{ sources: [0], target: undefined, sector: undefined, expected: ['Beta', 'Gamma', 'Delta', 'Alpha'] },
	]) {
		test(`moves projects ${sources.join(',')} to ${target ?? 'the end'} at ${sector ?? 'background'}`, async () => {
			const { model, dnd, navigation, workspace, restore } = setup();
			let changes = 0;
			store.add(navigation.onDidChangeProjectOrder(() => changes++));
			const data = new ElementsDragAndDropData<ExplorerItem, ExplorerItem[]>(sources.map(index => model.roots[index]));
			await dnd.drop(data, target === undefined ? undefined : model.roots[target], target, sector, new DragEvent('drop'));
			assert.deepStrictEqual({ order: navigation.orderedProjects.map(folder => folder.name), restored: restore().orderedProjects.map(folder => folder.name), workspace: workspace.folders.map(folder => folder.name), changes }, {
				order: expected ?? ['Alpha', 'Beta', 'Gamma', 'Delta'], restored: expected ?? ['Alpha', 'Beta', 'Gamma', 'Delta'], workspace: ['Alpha', 'Beta', 'Gamma', 'Delta'], changes: expected ? 1 : 0,
			});
		});
	}

	test('keeps project focus during sorting and retains order after a project is removed', () => {
		const { model, navigation, removeBeta, restore } = setup();
		navigation.enterProject(model.roots[0].resource);
		navigation.moveProjects([model.roots[2].resource], model.roots[0].resource, false);
		removeBeta();
		assert.deepStrictEqual({ focus: navigation.focusedProject?.name, order: navigation.orderedProjects.map(folder => folder.name), restored: restore().orderedProjects.map(folder => folder.name) }, {
			focus: 'Alpha', order: ['Gamma', 'Alpha', 'Delta'], restored: ['Gamma', 'Alpha', 'Delta'],
		});
	});
});

suite('Explorer sibling ordering', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const configuration = new TestConfigurationService({ explorer: { enableDragAndDrop: true, confirmDragAndDrop: true, autoReveal: false, sortOrder: 'default' } });
		const fileService = store.add(new TestFileService());
		const instantiation = workbenchInstantiationService({ configurationService: () => configuration, fileService: () => fileService }, store);
		instantiation.stub(IWorkspaceContextService, new TestContextService(new Workspace('siblings', [new WorkspaceFolder({ uri: URI.file('/projects/Alpha'), name: 'Alpha', index: 0 })])));
		instantiation.stub(IHostService, { onDidChangeFocus: Event.None });
		instantiation.stub(IBulkEditService, { apply: () => assert.fail('Reordering must not change files on disk') });
		instantiation.stub(IDialogService, { confirm: () => assert.fail('Reordering must not prompt'), error: () => assert.fail('Reordering failed') });
		const explorer = store.add(instantiation.createInstance(ExplorerService));
		instantiation.stub(IExplorerService, explorer);
		const navigation = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, navigation);
		const refreshed: (ExplorerItem | undefined)[] = [];
		explorer.registerView(new class extends mock<IExplorerView>() { override async refresh(_recursive: boolean, item?: ExplorerItem): Promise<void> { refreshed.push(item); } }());
		const root = explorer.roots[0];
		const child = (name: string, directory = false, parent = root) => {
			const item = new ExplorerItem(URI.joinPath(parent.resource, name), fileService, configuration, NullFilesConfigurationService, parent, directory);
			parent.addChild(item);
			return item;
		};
		const docs = child('docs', true);
		const src = child('src', true);
		const first = child('a.txt');
		const last = child('z.txt');
		const sorter = instantiation.createInstance(FileSorter);
		const dnd = store.add(instantiation.createInstance(FileDragAndDrop, () => true));
		const drop = (items: ExplorerItem[], target: ExplorerItem, sector = ListViewTargetSector.TOP) => dnd.drop(new ElementsDragAndDropData<ExplorerItem, ExplorerItem[]>(items), target, 0, sector, new DragEvent('drop'));
		return { explorer, root, docs, src, first, last, child, drop, dnd, refreshed,
			order: () => [...root.children.values()].sort((a, b) => sorter.compare(a, b)).map(item => item.name),
			restoreOrder: () => {
				const restored = store.add(instantiation.createInstance(ExplorerService));
				return [...root.children.values()].sort((a, b) => (restored.getItemOrder(a.resource) ?? 999) - (restored.getItemOrder(b.resource) ?? 999)).map(item => item.name);
			},
		};
	}

	test('interleaves files and folders without moving resources and persists the display order', async () => {
		const subject = setup();
		const before = subject.order();
		await subject.drop([subject.last], subject.docs);
		assert.deepStrictEqual({ before, after: subject.order(), restored: subject.restoreOrder(), parent: subject.last.parent, refreshed: subject.refreshed }, {
			before: ['docs', 'src', 'a.txt', 'z.txt'], after: ['z.txt', 'docs', 'src', 'a.txt'], restored: ['z.txt', 'docs', 'src', 'a.txt'], parent: subject.root, refreshed: [subject.root],
		});
	});

	test('preserves visual order for multi-selection and inserts after the target', async () => {
		const subject = setup();
		await subject.drop([subject.last, subject.first], subject.docs, ListViewTargetSector.BOTTOM);
		assert.deepStrictEqual(subject.order(), ['docs', 'a.txt', 'z.txt', 'src']);
	});

	test('rejects cross-level, mixed-level and self drops without changing file parents', async () => {
		const subject = setup();
		const nested = subject.child('inside.txt', false, subject.src);
		const data = new ElementsDragAndDropData<ExplorerItem, ExplorerItem[]>([subject.last]);
		const reaction = subject.dnd.onDragOver(data, nested, 0, ListViewTargetSector.TOP, new DragEvent('dragover'));
		await subject.drop([subject.last], nested);
		await subject.drop([subject.last, nested], subject.first);
		await subject.drop([subject.last], subject.last);
		await subject.drop([subject.root], subject.docs);
		assert.deepStrictEqual({ reaction, order: subject.order(), parent: subject.last.parent, refreshed: subject.refreshed }, { reaction: false, order: ['docs', 'src', 'a.txt', 'z.txt'], parent: subject.root, refreshed: [] });
	});

	test('uses before/after feedback for folders and appends newly created siblings after manual items', async () => {
		const subject = setup();
		const data = new ElementsDragAndDropData<ExplorerItem, ExplorerItem[]>([subject.last]);
		const reaction = subject.dnd.onDragOver(data, subject.docs, 0, ListViewTargetSector.TOP, new DragEvent('dragover'));
		assert.ok(typeof reaction === 'object' && reaction.accept && !reaction.autoExpand);
		await subject.drop([subject.last], subject.docs);
		subject.child('aaa-new.txt');
		assert.deepStrictEqual(subject.order(), ['z.txt', 'docs', 'src', 'a.txt', 'aaa-new.txt']);
	});
});
