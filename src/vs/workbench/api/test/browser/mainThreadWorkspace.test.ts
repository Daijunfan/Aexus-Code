/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MainThreadWorkspace } from '../../browser/mainThreadWorkspace.js';
import { SingleProxyRPCProtocol } from '../common/testRPCProtocol.js';
import { IFileQuery, ISearchService } from '../../../services/search/common/search.js';
import { TestEditorInput, workbenchInstantiationService } from '../../../test/browser/workbenchTestServices.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { IWorkspaceContextService, toWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../test/common/workbenchTestServices.js';
import { IProjectNavigationService } from '../../../contrib/files/browser/projectNavigationService.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

suite('MainThreadWorkspace', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let configService: TestConfigurationService;
	let instantiationService: TestInstantiationService;

	setup(() => {
		instantiationService = workbenchInstantiationService(undefined, disposables) as TestInstantiationService;

		configService = instantiationService.get(IConfigurationService) as TestConfigurationService;
		configService.setUserConfiguration('search', {});
	});

	test('keeps the selected project when IDE resumes its unchanged editor', async () => {
		const alpha = URI.file('/projects/Alpha');
		const beta = URI.file('/projects/Beta');
		const context = instantiationService.get(IWorkspaceContextService) as TestContextService;
		context.setWorkspace(new Workspace('projects', [toWorkspaceFolder(alpha), toWorkspaceFolder(beta)]));
		const navigation = instantiationService.get(IProjectNavigationService);
		navigation.selectProject(beta);
		let editor = disposables.add(new TestEditorInput(URI.joinPath(alpha, 'one.txt'), 'test'));
		const editorChanged = disposables.add(new Emitter<void>());
		instantiationService.stub(IEditorService, { get activeEditor() { return editor; }, onDidActiveEditorChange: editorChanged.event });
		const updates: (string | undefined)[] = [];
		disposables.add(instantiationService.createInstance(MainThreadWorkspace, SingleProxyRPCProtocol({
			$initializeWorkspace: () => { },
			$acceptCodingAgentProject: (project: UriComponents | undefined) => updates.push(URI.revive(project)?.path),
		})));
		await Promise.resolve();
		const modes = instantiationService.get(IWorkbenchModeService);
		modes.setMode('ade');
		editorChanged.fire();
		modes.setMode('ide');
		editorChanged.fire();
		const resumed = navigation.selectedProject?.name;
		editor = disposables.add(new TestEditorInput(URI.joinPath(alpha, 'two.txt'), 'test'));
		editorChanged.fire();
		assert.deepStrictEqual({ resumed, selected: navigation.selectedProject?.name, updates }, { resumed: 'Beta', selected: 'Alpha', updates: ['/projects/Beta', '/projects/Alpha'] });
	});

	test('simple', () => {
		instantiationService.stub(ISearchService, {
			fileSearch(query: IFileQuery) {
				assert.strictEqual(query.folderQueries.length, 1);
				assert.strictEqual(query.folderQueries[0].disregardIgnoreFiles, true);

				assert.deepStrictEqual({ ...query.includePattern }, { 'foo': true });
				assert.strictEqual(query.maxResults, 10);

				return Promise.resolve({ results: [], messages: [] });
			}
		});

		const mtw = disposables.add(instantiationService.createInstance(MainThreadWorkspace, SingleProxyRPCProtocol({ $initializeWorkspace: () => { }, $acceptCodingAgentProject: () => { } })));
		return mtw.$startFileSearch(null, { maxResults: 10, includePattern: 'foo', disregardSearchExcludeSettings: true }, CancellationToken.None);
	});

	test('exclude defaults', () => {
		configService.setUserConfiguration('search', {
			'exclude': { 'searchExclude': true }
		});
		configService.setUserConfiguration('files', {
			'exclude': { 'filesExclude': true }
		});

		instantiationService.stub(ISearchService, {
			fileSearch(query: IFileQuery) {
				assert.strictEqual(query.folderQueries.length, 1);
				assert.strictEqual(query.folderQueries[0].disregardIgnoreFiles, true);
				assert.strictEqual(query.folderQueries[0].excludePattern?.length, 1);
				assert.deepStrictEqual(query.folderQueries[0].excludePattern[0].pattern, { 'filesExclude': true });

				return Promise.resolve({ results: [], messages: [] });
			}
		});

		const mtw = disposables.add(instantiationService.createInstance(MainThreadWorkspace, SingleProxyRPCProtocol({ $initializeWorkspace: () => { }, $acceptCodingAgentProject: () => { } })));
		return mtw.$startFileSearch(null, { maxResults: 10, includePattern: '', disregardSearchExcludeSettings: true }, CancellationToken.None);
	});

	test('disregard excludes', () => {
		configService.setUserConfiguration('search', {
			'exclude': { 'searchExclude': true }
		});
		configService.setUserConfiguration('files', {
			'exclude': { 'filesExclude': true }
		});

		instantiationService.stub(ISearchService, {
			fileSearch(query: IFileQuery) {
				assert.deepStrictEqual(query.folderQueries[0].excludePattern, []);
				assert.deepStrictEqual(query.excludePattern, undefined);

				return Promise.resolve({ results: [], messages: [] });
			}
		});

		const mtw = disposables.add(instantiationService.createInstance(MainThreadWorkspace, SingleProxyRPCProtocol({ $initializeWorkspace: () => { }, $acceptCodingAgentProject: () => { } })));
		return mtw.$startFileSearch(null, { maxResults: 10, includePattern: '', disregardSearchExcludeSettings: true, disregardExcludeSettings: true }, CancellationToken.None);
	});

	test('do not disregard anything if disregardExcludeSettings is true', () => {
		configService.setUserConfiguration('search', {
			'exclude': { 'searchExclude': true }
		});
		configService.setUserConfiguration('files', {
			'exclude': { 'filesExclude': true }
		});

		instantiationService.stub(ISearchService, {
			fileSearch(query: IFileQuery) {
				assert.strictEqual(query.folderQueries.length, 1);
				assert.strictEqual(query.folderQueries[0].disregardIgnoreFiles, true);
				assert.deepStrictEqual(query.folderQueries[0].excludePattern, []);

				return Promise.resolve({ results: [], messages: [] });
			}
		});

		const mtw = disposables.add(instantiationService.createInstance(MainThreadWorkspace, SingleProxyRPCProtocol({ $initializeWorkspace: () => { }, $acceptCodingAgentProject: () => { } })));
		return mtw.$startFileSearch(null, { maxResults: 10, includePattern: '', disregardExcludeSettings: true, disregardSearchExcludeSettings: false }, CancellationToken.None);
	});

	test('exclude string', () => {
		instantiationService.stub(ISearchService, {
			fileSearch(query: IFileQuery) {
				assert.deepStrictEqual(query.folderQueries[0].excludePattern, []);
				assert.deepStrictEqual({ ...query.excludePattern }, { 'exclude/**': true });

				return Promise.resolve({ results: [], messages: [] });
			}
		});

		const mtw = disposables.add(instantiationService.createInstance(MainThreadWorkspace, SingleProxyRPCProtocol({ $initializeWorkspace: () => { }, $acceptCodingAgentProject: () => { } })));
		return mtw.$startFileSearch(null, { maxResults: 10, includePattern: '', excludePattern: [{ pattern: 'exclude/**' }], disregardSearchExcludeSettings: true }, CancellationToken.None);
	});
	test('Valid revived URI after moving to EH', () => {
		const uriComponents: UriComponents = {
			scheme: 'test',
			path: '/Users/username/Downloads',
		};
		instantiationService.stub(ISearchService, {
			fileSearch(query: IFileQuery) {
				assert.strictEqual(query.folderQueries?.length, 1);
				assert.ok(URI.isUri(query.folderQueries[0].folder));
				assert.strictEqual(query.folderQueries[0].folder.path, '/Users/username/Downloads');
				assert.strictEqual(query.folderQueries[0].folder.scheme, 'test');

				return Promise.resolve({ results: [], messages: [] });
			}
		});

		const mtw = disposables.add(instantiationService.createInstance(MainThreadWorkspace, SingleProxyRPCProtocol({ $initializeWorkspace: () => { }, $acceptCodingAgentProject: () => { } })));
		return mtw.$startFileSearch(uriComponents, { filePattern: '*.md' }, CancellationToken.None);
	});
});
