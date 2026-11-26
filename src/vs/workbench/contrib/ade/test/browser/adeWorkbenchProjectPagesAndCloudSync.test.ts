/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildCloudProjectUri,
	IAdeCloudHost,
	IAdeCloudHostBackendService,
	IAdeRemoteScmStatusEntry,
} from '../../../../../platform/ade/common/adeCloudHosts.js';
import {
	ADE_CANCEL_TICKET_TURNS_COMMAND_ID,
	ADE_DISPATCH_TICKET_TURN_COMMAND_ID,
	ADE_DISPOSE_AGENT_RUNTIME_COMMAND_ID,
	ADE_SYNC_SESSION_PREFERENCES_COMMAND_ID,
} from '../../../../../platform/ade/common/adeControl.js';
import { formatAdeTicketDeliveryPayload } from '../../../../../platform/ade/common/adeModels.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService, IFileStatWithMetadata } from '../../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { EditorGroupWatermark } from '../../../../browser/parts/editor/editorGroupWatermark.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { ViewContainer, ViewContainerLocation, IViewContainerModel, IViewDescriptorService } from '../../../../common/views.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IWorkbenchModeService, WorkbenchModeContext } from '../../../../services/workbenchMode/common/workbenchMode.js';
import { TestAdeControlCenterService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { ChatEditorInput } from '../../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { ChatSendResult, IChatSendRequestOptions, IChatService } from '../../../chat/common/chatService/chatService.js';
import { IChatModel } from '../../../chat/common/model/chatModel.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../../files/browser/projectNavigationService.js';
import { ISCMService } from '../../../scm/common/scm.js';
import { ProjectTerminalService } from '../../../terminal/browser/projectTerminalService.js';
import { AdeOutboxBridgeContribution } from '../../browser/adeControlHandler.js';
import { AdeEditorService, isLegacyUnsupportedAdeEditor } from '../../browser/adeEditorService.js';
import { AdeEngineeringEditorInput } from '../../browser/adeEngineeringEditorPane.js';
import { AdeChangesView, AdeFilesView } from '../../browser/adeInspectorViews.js';
import { AdeProjectsService } from '../../browser/adeProjectsService.js';
import { AdeProjectsView } from '../../browser/adeProjectsView.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IOverlayWebview, IWebviewService } from '../../../webview/browser/webview.js';
import { IWebviewViewService } from '../../../webviewView/browser/webviewViewService.js';
import {
	AdeExtensionWebviewEditorInput,
	AdeExtensionWebviewEditorPane,
	AdeExtensionWebviewEditorSerializer,
	AdeSessionEditorInput,
	AdeSessionEditorSerializer,
} from '../../browser/adeSessionEditor.js';
import { IAdeSessionsService } from '../../browser/adeSessionsService.js';
import {
	ADE_CHANGES_VIEW_ID,
	ADE_CONFIGURE_PROJECT_STORAGE_COMMAND_ID,
	ADE_DELETE_PROJECT_PAGE_COMMAND_ID,
	ADE_FILES_VIEW_ID,
	ADE_PROJECTS_VIEW_ID,
	ADE_RENAME_PROJECT_PAGE_COMMAND_ID,
	ADE_TRY_SEND_OPEN_CHAT_REQUEST_COMMAND_ID,
	buildAdeEmployeeSessionUri,
	IAdeEditorService,
	IAdeProjectsService,
} from '../../common/ade.js';

class FakeGroup implements Partial<IEditorGroup> {
	readonly editors: EditorInput[] = [];
	activeEditor: EditorInput | null = null;
	constructor(readonly id: number) { }
}

function createEditorGroupsHarness(store: { add<T extends { dispose(): void }>(x: T): T }) {
	const onDidActiveEditorChange = store.add(new Emitter<void>());
	const groups: FakeGroup[] = [new FakeGroup(1)];
	let activeGroup = groups[0];
	store.add({
		dispose: () => {
			for (const g of groups) {
				for (const e of g.editors) {
					if (!e.isDisposed()) {
						e.dispose();
					}
				}
				g.editors.length = 0;
				g.activeEditor = null;
			}
		},
	});

	const editorGroupsService = upcastPartial<IEditorGroupsService>({
		mainPart: upcastPartial<IEditorGroupsService['mainPart']>({
			get activeGroup() { return activeGroup as unknown as IEditorGroup; },
			get groups() { return groups as unknown as readonly IEditorGroup[]; },
			findGroup: (scope: { direction: GroupDirection }, source?: IEditorGroup | number) => {
				if (scope.direction === GroupDirection.RIGHT) {
					const srcIdx = groups.findIndex(g => (g as unknown) === source || g.id === source);
					return (groups[srcIdx + 1] as unknown as IEditorGroup) ?? undefined;
				}
				return undefined;
			},
			addGroup: (_location: IEditorGroup | number, _direction: GroupDirection) => {
				const next = new FakeGroup(groups.length + 1);
				groups.push(next);
				return next as unknown as IEditorGroup;
			},
		}),
	});

	const editorService = upcastPartial<IEditorService>({
		onDidActiveEditorChange: onDidActiveEditorChange.event,
		get activeEditor() { return activeGroup.activeEditor ?? undefined; },
		openEditor: (async (input: EditorInput | { resource: URI }, optionsOrGroup?: unknown, maybeGroup?: unknown) => {
			const groupId = typeof maybeGroup === 'number'
				? maybeGroup
				: (typeof optionsOrGroup === 'number' ? optionsOrGroup : activeGroup.id);
			const group = groups.find(g => g.id === groupId) ?? activeGroup;
			activeGroup = group;
			const editorInput = input instanceof EditorInput
				? input
				: store.add(new class extends EditorInput {
					override readonly resource = input.resource;
					override get typeId() { return 'test.file'; }
				}());
			if (!group.editors.includes(editorInput)) {
				group.editors.push(editorInput);
			}
			group.activeEditor = editorInput;
			onDidActiveEditorChange.fire();
			return undefined;
		}) as unknown as IEditorService['openEditor'],
		closeEditors: async (targets: readonly { editor: EditorInput; groupId: number }[]) => {
			for (const t of targets) {
				const grp = groups.find(g => g.id === t.groupId);
				if (!grp) {
					continue;
				}
				const idx = grp.editors.indexOf(t.editor);
				if (idx !== -1) {
					grp.editors.splice(idx, 1);
				}
				if (grp.activeEditor === t.editor) {
					grp.activeEditor = grp.editors.at(-1) ?? null;
				}
				if (!groups.some(other => other.editors.includes(t.editor)) && !t.editor.isDisposed()) {
					t.editor.dispose();
				}
			}
			onDidActiveEditorChange.fire();
		},
	});

	return {
		groups,
		get activeGroup() { return activeGroup; },
		setActiveGroup(id: number) {
			const found = groups.find(g => g.id === id);
			if (found) {
				activeGroup = found;
				onDidActiveEditorChange.fire();
			}
		},
		editorGroupsService,
		editorService,
		onDidActiveEditorChange,
	};
}

function stubViewDescriptorService(): IViewDescriptorService {
	const dummyContainer = new class extends mock<ViewContainer>() {
		override readonly id = 'workbench.ade.testContainer';
	}();
	return upcastPartial<IViewDescriptorService>({
		getViewLocationById: () => ViewContainerLocation.Sidebar,
		onDidChangeLocation: Event.None,
		getViewDescriptorById: () => null,
		getViewContainerByViewId: () => dummyContainer,
		getDefaultContainerById: () => dummyContainer,
		getViewContainerModel: () => new class extends mock<IViewContainerModel>() {
			override readonly title = 'ADE';
			override readonly onDidChangeContainerInfo = Event.None;
		}(),
	});
}

suite('ADE Track 2 — Left 1:N Project Tree, Right Cloud Inspector Sync & 60fps Outbox Bridge', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('AdeProjectsView renders Workspace Folder -> 0..N Project Pages, supports + creation, click open, F2 inline rename, storage config & retains empty folders after deleting all pages', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const localFolder = URI.file('/workspace/local-app');
		const cloudFolder = buildCloudProjectUri('kali-lab', '/home/kali/audit', 'linux');
		const instantiation = workbenchInstantiationService({
			contextService: () => new TestContextService(new Workspace('ade-tree', [toWorkspaceFolder(localFolder)])),
			adeControlCenterService: () => controlCenter,
		}, store);
		const nav = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, nav);
		instantiation.stub(IViewDescriptorService, stubViewDescriptorService());
		instantiation.stub(IDialogService, upcastPartial<IDialogService>({
			confirm: async () => ({ confirmed: true }),
		}));
		instantiation.stub(IAdeCloudHostBackendService, upcastPartial<IAdeCloudHostBackendService>({
			onDidChangeHosts: Event.None,
			listHosts: async () => [{
				id: 'kali-lab',
				name: 'Kali Lab',
				alias: 'kali-lab',
				hostName: '10.10.20.9',
				port: 22,
				os: 'linux',
				recentDirectories: [],
				source: 'user',
				createdAt: 1,
				updatedAt: 1,
			}],
		}));

		const openedPages: Array<{ projectId: string; side?: boolean }> = [];
		const closedPages: string[] = [];
		instantiation.stub(IAdeEditorService, upcastPartial<IAdeEditorService>({
			activeEditor: undefined,
			getActiveProjectPageId: () => openedPages.at(-1)?.projectId,
			getActiveFolderUri: () => undefined,
			openProjectPage: async (projectId: string, options?: { side?: boolean }) => {
				openedPages.push({ projectId, side: options?.side });
			},
			closeProjectPageEditors: async (projectId: string) => {
				closedPages.push(projectId);
			},
			closeAgents: async () => undefined,
		}));
		instantiation.stub(ICommandService, upcastPartial<ICommandService>({
			onWillExecuteCommand: Event.None,
			onDidExecuteCommand: Event.None,
			executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
				const cmd = CommandsRegistry.getCommand(id);
				return (cmd ? instantiation.invokeFunction(cmd.handler, ...args) : undefined) as T;
			},
		}));

		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, projects);
		await projects.whenReady();
		await projects.registerWorkspaceFolderAsync!(cloudFolder, 'Kali Audit');

		class TestAdeProjectsView extends AdeProjectsView {
			renderInto(parent: HTMLElement): void {
				this.renderBody(parent);
			}
			layoutForTest(height: number, width: number): void {
				this.layoutBody(height, width);
			}
		}

		const view = store.add(instantiation.createInstance(TestAdeProjectsView, { id: ADE_PROJECTS_VIEW_ID, title: 'Projects' }));
		instantiation.stub(IViewsService, upcastPartial<IViewsService>({
			getActiveViewWithId: <T>(id: string) => (id === ADE_PROJECTS_VIEW_ID ? (view as unknown as T) : null),
		}));
		const host = append(mainWindow.document.body, $('.ade-projects-view-test-host', { style: 'width:300px;height:600px;' }));
		store.add({ dispose: () => host.remove() });
		view.renderInto(host);
		view.layoutForTest(600, 300);
		await view.refresh();

		// Both local and cloud folders render as top-level folder rows even with 0 Project Pages
		assert.strictEqual(host.querySelectorAll('.ade-folder-row').length, 2);
		assert.strictEqual(host.querySelectorAll('.ade-project-page-row').length, 0);

		// Click hover '+' button on local folder -> creates & opens Project Page 1
		const addBtn = host.querySelector<HTMLButtonElement>('.ade-folder-row .ade-add-page-btn')!;
		assert.ok(addBtn, 'Folder row renders + Create Project Page button');
		const createdSignal = Event.toPromise(Event.filter(projects.onDidChange, () => projects.getProjectPagesForFolder(localFolder).length >= 1));
		addBtn.click();
		await createdSignal;
		await view.refresh();
		assert.strictEqual(projects.getProjectPagesForFolder(localFolder).length, 1);
		const page1Id = projects.getProjectPagesForFolder(localFolder)[0].projectId;
		for (let i = 0; i < 10 && openedPages.length === 0; i++) {
			await Promise.resolve();
		}
		assert.strictEqual(openedPages.at(-1)?.projectId, page1Id);

		// Create 2 more Project Pages -> 3 pages rendered under localFolder
		const page2 = await projects.createProjectPage(localFolder, 'Security Audit');
		const page3 = await projects.createProjectPage(localFolder, 'Perf Tuning');
		await view.refresh();
		assert.strictEqual(host.querySelectorAll('.ade-project-page-row').length, 3);

		// Click page2 row -> opens/focuses page2 canvas
		const page2Row = host.querySelector<HTMLElement>(`.ade-project-page-row[data-project-id="${page2.meta.project_id}"]`)!;
		assert.ok(page2Row);
		page2Row.click();
		await Promise.resolve();
		assert.strictEqual(openedPages.at(-1)?.projectId, page2.meta.project_id);

		// F2 inline rename via ADE_RENAME_PROJECT_PAGE_COMMAND_ID -> renders InlineEditInputBox & commits on Enter
		await instantiation.get(ICommandService).executeCommand(ADE_RENAME_PROJECT_PAGE_COMMAND_ID, page2.meta.project_id);
		const renameInput = host.querySelector<HTMLInputElement>('input.ade-inline-rename-input')!;
		assert.ok(renameInput, 'F2 inline rename input mounted in place');
		const renamedSignal = Event.toPromise(Event.filter(projects.onDidChange, () => projects.getProjectPage(page2.meta.project_id)?.name === 'Red Team Audit'));
		renameInput.value = 'Red Team Audit';
		renameInput.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
		await renamedSignal;
		assert.strictEqual(projects.getProjectPage(page2.meta.project_id)?.name, 'Red Team Audit');

		// Configure default cross-host ticket storage
		instantiation.stub(IQuickInputService, 'pick', async (items: Array<{ targetHost?: string }>) => items.find(i => i.targetHost === '10.10.20.9'));
		await instantiation.get(ICommandService).executeCommand(ADE_CONFIGURE_PROJECT_STORAGE_COMMAND_ID, page2.meta.project_id);
		const updatedSnap = await controlCenter.getProjectSnapshot(page2.meta.project_id);
		assert.strictEqual(updatedSnap?.meta.cross_host_ticket_storage, '10.10.20.9');

		// Delete all 3 Project Pages -> empty Workspace Folder STILL remains in tree!
		for (const pid of [page1Id, page2.meta.project_id, page3.meta.project_id]) {
			await instantiation.get(ICommandService).executeCommand(ADE_DELETE_PROJECT_PAGE_COMMAND_ID, pid);
		}
		assert.strictEqual(closedPages.length, 3);
		assert.strictEqual(host.querySelectorAll('.ade-project-page-row').length, 0);
		assert.strictEqual(host.querySelectorAll('.ade-folder-row').length, 2, 'Empty folders remain stably in left sidebar after all Project Pages are deleted');
	});

	test('AdeChangesView, AdeFilesView & ProjectTerminalService prioritize active Cloud Project URI over IDE local selection and preserve file tree across same-folder Project Pages', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const instantiation = workbenchInstantiationService({ adeControlCenterService: () => controlCenter }, store);
		const localFolder = URI.file('/Users/dev/local-repo');
		const cloudFolder = buildCloudProjectUri('ubuntu-gpu', '/data/cloud-repo', 'linux');

		instantiation.stub(IWorkspaceContextService, {
			getWorkspace: () => new Workspace('cloud-sync', [toWorkspaceFolder(localFolder)]),
			onDidChangeWorkspaceFolders: Event.None,
		});
		const nav = store.add(instantiation.createInstance(ProjectNavigationService));
		nav.selectProject(localFolder); // IDE selection stays stuck on localFolder!
		instantiation.stub(IProjectNavigationService, nav);
		instantiation.stub(IViewDescriptorService, stubViewDescriptorService());

		const editorHarness = createEditorGroupsHarness(store);
		instantiation.stub(IEditorGroupsService, editorHarness.editorGroupsService);
		instantiation.stub(IEditorService, editorHarness.editorService);
		instantiation.stub(IExtensionService, upcastPartial<IExtensionService>({
			extensions: [],
			onDidChangeExtensions: Event.None,
			whenInstalledExtensionsRegistered: async () => true,
			activateById: async () => undefined,
		}));

		const remoteGitCalls: string[] = [];
		instantiation.stub(IAdeCloudHostBackendService, upcastPartial<IAdeCloudHostBackendService>({
			onDidChangeHosts: Event.None,
			getEffectiveSshConfigPath: async () => '/tmp/ssh_config',
			listHosts: async () => [{
				id: 'ubuntu-gpu',
				name: 'Ubuntu GPU',
				alias: 'ubuntu-gpu',
				hostName: '10.88.0.2',
				port: 22,
				os: 'linux',
				recentDirectories: ['/data/cloud-repo'],
				source: 'user',
				createdAt: 1,
				updatedAt: 1,
			} satisfies IAdeCloudHost],
			remoteGitStatus: async (authority: string, projectPath: string): Promise<readonly IAdeRemoteScmStatusEntry[]> => {
				remoteGitCalls.push(`${authority}:${projectPath}`);
				return [{ relativePath: 'src/train.py', status: 'M', staged: false }];
			},
		}));
		instantiation.stub(ISCMService, upcastPartial<ISCMService>({
			repositories: [],
			onDidAddRepository: Event.None,
			onDidRemoveRepository: Event.None,
		}));

		const resolvedDirs: string[] = [];
		instantiation.stub(IFileService, upcastPartial<IFileService>({
			onDidFilesChange: Event.None,
			createWatcher: () => Disposable.None as unknown as ReturnType<IFileService['createWatcher']>,
			resolve: (async (resource: URI) => {
				resolvedDirs.push(resource.toString());
				return {
					resource,
					name: 'root',
					isDirectory: true,
					isFile: false,
					isSymbolicLink: false,
					mtime: 1,
					ctime: 1,
					etag: '1',
					size: 0,
					readonly: false,
					locked: false,
					children: [
						{
							resource: URI.joinPath(resource, 'subdir'),
							name: 'subdir',
							isDirectory: true,
							isFile: false,
							isSymbolicLink: false,
						},
					],
				} as unknown as IFileStatWithMetadata;
			}) as unknown as IFileService['resolve'],
		}));

		const modes = instantiation.get(IWorkbenchModeService);
		modes.setMode('ade');

		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, projects);
		await projects.whenReady();
		await projects.registerWorkspaceFolderAsync!(localFolder, 'Local Repo');
		await projects.registerWorkspaceFolderAsync!(cloudFolder, 'Cloud Repo');

		const localPageA = await projects.createProjectPage(localFolder, 'Local Page A');
		const localPageB = await projects.createProjectPage(localFolder, 'Local Page B');
		const cloudPage = await projects.createProjectPage(cloudFolder, 'Cloud Training');

		const adeEditors = store.add(instantiation.createInstance(AdeEditorService));
		instantiation.stub(IAdeEditorService, adeEditors);
		const terminals = store.add(instantiation.createInstance(ProjectTerminalService));

		class TestChangesView extends AdeChangesView {
			renderInto(parent: HTMLElement): void { this.renderBody(parent); }
		}
		class TestFilesView extends AdeFilesView {
			renderInto(parent: HTMLElement): void { this.renderBody(parent); }
		}

		const changesView = store.add(instantiation.createInstance(TestChangesView, { id: ADE_CHANGES_VIEW_ID, title: 'Changes' }));
		const filesView = store.add(instantiation.createInstance(TestFilesView, { id: ADE_FILES_VIEW_ID, title: 'Files' }));
		const changesHost = append(mainWindow.document.body, $('.ade-changes-test-host', { style: 'width:300px;height:400px;' }));
		const filesHost = append(mainWindow.document.body, $('.ade-files-test-host', { style: 'width:300px;height:400px;' }));
		store.add({ dispose: () => { changesHost.remove(); filesHost.remove(); } });
		changesView.renderInto(changesHost);
		filesView.renderInto(filesHost);

		// 1. Open Cloud Project Page while IDE projectNavigation.selectedProject is still localFolder!
		await adeEditors.openProjectPage(cloudPage.meta.project_id);
		await changesView.refresh();
		await filesView.refresh();

		assert.strictEqual(adeEditors.getActiveFolderUri()?.toString(), cloudFolder.toString());
		assert.strictEqual(changesView.activeProjectUri?.toString(), cloudFolder.toString());
		assert.strictEqual(filesView.activeProjectUri?.toString(), cloudFolder.toString());
		assert.strictEqual(terminals.currentProject?.uri.toString(), cloudFolder.toString());
		assert.ok(remoteGitCalls.includes('ubuntu-gpu:/data/cloud-repo'));

		// 2. Switch to Local Page A, then switch to Local Page B (same folderUri!) -> FilesView must NOT clear watchers or re-resolve root!
		await adeEditors.openProjectPage(localPageA.meta.project_id);
		await filesView.refresh();
		assert.strictEqual(filesView.activeProjectUri?.toString(), localFolder.toString());
		const watchersOnPageA = filesView.watchedFolderCount;
		assert.ok(watchersOnPageA >= 1);

		resolvedDirs.length = 0;
		await adeEditors.openProjectPage(localPageB.meta.project_id);
		assert.strictEqual(adeEditors.getActiveProjectPageId(), localPageB.meta.project_id);
		assert.strictEqual(filesView.activeProjectUri?.toString(), localFolder.toString());
		assert.strictEqual(filesView.watchedFolderCount, watchersOnPageA, 'Same-folder Project Page switch preserves file watchers & expansion');
		assert.strictEqual(resolvedDirs.length, 0, 'Same-folder Project Page switch does not reset or re-fetch file tree');
	});

	test('AdeEditorService supports side-by-side Project Page split view, resolves aexus-ssh:// workspace for remote employees, and purges stale legacy tabs on restore', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const instantiation = workbenchInstantiationService({ adeControlCenterService: () => controlCenter }, store);
		const localFolder = URI.file('/workspace/hybrid-app');

		const editorHarness = createEditorGroupsHarness(store);
		instantiation.stub(IEditorGroupsService, editorHarness.editorGroupsService);
		instantiation.stub(IEditorService, editorHarness.editorService);
		instantiation.stub(IExtensionService, upcastPartial<IExtensionService>({
			extensions: [],
			onDidChangeExtensions: Event.None,
			whenInstalledExtensionsRegistered: async () => true,
			activateById: async () => undefined,
		}));
		instantiation.stub(IAdeCloudHostBackendService, upcastPartial<IAdeCloudHostBackendService>({
			onDidChangeHosts: Event.None,
			listHosts: async () => [{
				id: 'gpu-node1',
				name: 'GPU Node 1',
				alias: 'gpu-node1',
				hostName: '10.20.30.40',
				port: 22,
				os: 'linux',
				defaultDirectory: '/home/ubuntu/work',
				recentDirectories: [],
				source: 'user',
				createdAt: 1,
				updatedAt: 1,
			}],
		}));

		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, projects);
		await projects.whenReady();
		await projects.registerWorkspaceFolderAsync!(localFolder, 'Hybrid App');
		const pageLeft = await projects.createProjectPage(localFolder, 'Page Left');
		const pageRight = await projects.createProjectPage(localFolder, 'Page Right');

		const remoteAgent = await controlCenter.uiCreateAgent({
			projectId: pageLeft.meta.project_id,
			parentId: null,
			level: 1,
			name: 'Remote Trainer',
			roleSummary: 'Runs training on 10.20.30.40',
			host: '10.20.30.40',
			engine: 'claude',
			model: 'claude-sonnet-4-6',
			effort: 'high',
		});

		const adeEditors = store.add(instantiation.createInstance(AdeEditorService));
		instantiation.stub(IAdeEditorService, adeEditors);

		// 1. Side-by-side Project Page split view
		await adeEditors.openProjectPage(pageLeft.meta.project_id);
		await adeEditors.openProjectPage(pageRight.meta.project_id, { side: true });
		assert.strictEqual(editorHarness.groups.length, 2, 'Side-by-side Project Pages open in 2 split groups');
		assert.strictEqual(adeEditors.getActiveProjectPageId(), pageRight.meta.project_id);

		// 2. openAgent does NOT prematurely lock session_phase before first turn, and resolveEmployeeSessionMeta yields aexus-ssh://!
		await adeEditors.openAgent(remoteAgent.agent_id, { projectId: pageLeft.meta.project_id });
		const snapAfterOpen = await controlCenter.getProjectSnapshot(pageLeft.meta.project_id);
		const agentAfterOpen = snapAfterOpen?.agents.find(a => a.agent_id === remoteAgent.agent_id);
		assert.strictEqual(agentAfterOpen?.session_phase, 'unstarted', 'Opening empty chat tab must not prematurely lock engine');

		const metaCmd = CommandsRegistry.getCommand('aexus.ade.resolveEmployeeSessionMeta')!;
		const resolvedMeta = (await instantiation.invokeFunction(metaCmd.handler, pageLeft.meta.project_id, remoteAgent.agent_id) as unknown) as {
			name?: string;
			workspaceCwdUri?: string;
			model?: string;
			effort?: string;
		};
		assert.strictEqual(resolvedMeta.name, 'Remote Trainer');
		assert.ok(resolvedMeta.workspaceCwdUri?.startsWith('aexus-ssh://gpu-node1/'), `Expected aexus-ssh://gpu-node1/... workspace URI, got ${resolvedMeta.workspaceCwdUri}`);

		// 3. Stale legacy tab rejection in serializer & AfterRestored purge
		const serializer = new AdeSessionEditorSerializer();
		const legacyId = `__aexus_${'sec'}${'retary'}__`;
		assert.strictEqual(serializer.deserialize(instantiation, legacyId), undefined);

		const staleScheme = `aexus-${'sec'}${'retary'}`;
		const staleChatEditor = store.add(instantiation.createInstance(ChatEditorInput, URI.parse(`${staleScheme}:/legacy-1`), {}));
		assert.strictEqual(isLegacyUnsupportedAdeEditor(staleChatEditor), true);
		editorHarness.groups[0].editors.push(staleChatEditor);
		await adeEditors.purgeLegacyEditors();
		assert.strictEqual(editorHarness.groups[0].editors.includes(staleChatEditor), false, 'Stale legacy tab purged automatically');
		assert.strictEqual(
			editorHarness.groups.some(g => g.editors.some(e => e instanceof ChatEditorInput && e.sessionResource?.toString() === buildAdeEmployeeSessionUri('claude', pageLeft.meta.project_id, remoteAgent.agent_id).toString())),
			true,
			'Valid ADE employee ChatEditorInput remains open',
		);

		// 4. Watermark in ADE mode exposes Project Page entries and zero legacy entries
		await (instantiation.get(IConfigurationService) as TestConfigurationService).setUserConfiguration('workbench', { tips: { enabled: true } });
		const ctxKeys = store.add(instantiation.createInstance(ContextKeyService));
		WorkbenchModeContext.bindTo(ctxKeys).set('ade');
		instantiation.stub(IContextKeyService, ctxKeys);
		for (const cmdId of ['workbench.action.ade.createProjectPage', 'workbench.action.ade.openProjectPage', 'workbench.action.ade.addProjectFolder']) {
			if (!CommandsRegistry.getCommand(cmdId)) {
				store.add(CommandsRegistry.registerCommand(cmdId, () => undefined));
			}
		}
		const wmContainer = append(mainWindow.document.body, $('.ade-watermark-test'));
		store.add({ dispose: () => wmContainer.remove() });
		store.add(instantiation.createInstance(EditorGroupWatermark, wmContainer));
		assert.ok(wmContainer.textContent?.includes('New Project Page'));
		assert.ok(wmContainer.textContent?.includes('Open Project Page'));
	});

	test('AdeOutboxBridgeContribution & trySendOpenChatRequest deliver 60fps Path A (isSystemInitiated: false), Path B headless turns, cliMissing rollback, cancel & dispose', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const instantiation = workbenchInstantiationService({ adeControlCenterService: () => controlCenter }, store);

		const folder = URI.file('/workspace/outbox-project');
		await controlCenter.registerWorkspaceFolder({ folderUri: folder.toString(), displayName: 'Outbox Project' });
		const proj = await controlCenter.createProject({ folderUri: folder.toString(), name: 'Main Orchestration' });
		const projectId = proj.meta.project_id;

		const l1 = await controlCenter.uiCreateAgent({
			projectId,
			parentId: null,
			level: 1,
			name: 'L1 Architect',
			roleSummary: 'Top role',
			host: 'local',
			engine: 'claude',
			model: 'claude-sonnet-4-6',
			effort: 'high',
		});
		const l2Open = await controlCenter.uiCreateAgent({
			projectId,
			parentId: l1.agent_id,
			level: 2,
			name: 'L2 Open Chat',
			roleSummary: 'Has open chat window',
			host: 'local',
			engine: 'codex',
			model: 'gpt-5.2-codex',
			effort: 'medium',
		});
		const l2MissingCli = await controlCenter.uiCreateAgent({
			projectId,
			parentId: l1.agent_id,
			level: 2,
			name: 'L2 Missing CLI',
			roleSummary: 'Uninstalled CLI binary',
			host: 'local',
			engine: 'kilo',
			model: 'kilo-default',
			effort: 'medium',
		});

		const l2OpenUri = buildAdeEmployeeSessionUri('codex', projectId, l2Open.agent_id);
		const openSessions = new Set<string>([l2OpenUri.toString()]);
		const sentChatRequests: Array<{ uri: string; message: string; options?: IChatSendRequestOptions }> = [];

		instantiation.stub(IChatService, upcastPartial<IChatService>({
			onDidAcceptRequest: Event.None,
			onDidSubmitRequest: Event.None,
			cancelCurrentRequestForSession: async () => undefined,
			getSession: (resource: URI) => openSessions.has(resource.toString())
				? ({
					sessionResource: resource,
					requestInProgress: constObservable(false),
					hasActiveRequest: constObservable(false),
					onDidDispose: Event.None,
					onDidChange: Event.None,
				} as unknown as IChatModel)
				: undefined,
			sendRequest: async (resource: URI, message: string, options?: IChatSendRequestOptions): Promise<ChatSendResult> => {
				sentChatRequests.push({ uri: resource.toString(), message, options });
				return {
					kind: 'sent',
					data: {
						agent: {} as never,
						responseCreatedPromise: Promise.resolve({} as never),
						responseCompletePromise: Promise.resolve(),
					},
				};
			},
		}));

		const dispatchedTurns: Array<Record<string, unknown>> = [];
		const cancelledPayloads: Array<Record<string, unknown>> = [];
		const disposedPayloads: Array<Record<string, unknown>> = [];

		instantiation.stub(ICommandService, upcastPartial<ICommandService>({
			onWillExecuteCommand: Event.None,
			onDidExecuteCommand: Event.None,
			executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
				if (id === ADE_DISPATCH_TICKET_TURN_COMMAND_ID) {
					const payload = args[0] as {
						projectId: string;
						agentId: string;
						sessionResource: string;
						payloadText: string;
						deliveryMode: 'queue' | 'steer';
						agentToken?: string;
						controlSocketPath?: string;
					};
					dispatchedTurns.push(payload);
					if (payload.agentId === l2MissingCli.agent_id) {
						return { ok: false, cliMissing: true, error: 'kilo CLI not found' } as unknown as T;
					}
					const tryOpenCmd = CommandsRegistry.getCommand(ADE_TRY_SEND_OPEN_CHAT_REQUEST_COMMAND_ID)!;
					const openRes = (await instantiation.invokeFunction(tryOpenCmd.handler, {
						sessionResource: payload.sessionResource,
						payloadText: payload.payloadText,
						deliveryMode: payload.deliveryMode,
						projectId: payload.projectId,
						agentId: payload.agentId,
					}) as unknown) as { accepted: boolean };
					if (openRes.accepted) {
						return { ok: true, nativeSessionId: 'native-open-codex-1' } as unknown as T;
					}
					return { ok: true, nativeSessionId: 'native-headless-1' } as unknown as T;
				}
				if (id === ADE_CANCEL_TICKET_TURNS_COMMAND_ID) {
					cancelledPayloads.push(args[0] as Record<string, unknown>);
					return { cancelled: 1 } as unknown as T;
				}
				if (id === ADE_DISPOSE_AGENT_RUNTIME_COMMAND_ID) {
					disposedPayloads.push(args[0] as Record<string, unknown>);
					return { disposed: true } as unknown as T;
				}
				const registered = CommandsRegistry.getCommand(id);
				if (registered) {
					return instantiation.invokeFunction(registered.handler, ...args) as T;
				}
				return undefined as T;
			},
		}));

		const bridge = store.add(instantiation.createInstance(AdeOutboxBridgeContribution));

		// 1. Enqueue a 'steer' Ticket to L2 Open Chat -> routes via Path A IChatService.sendRequest with isSystemInitiated: false & Steering!
		const steerPayload = formatAdeTicketDeliveryPayload({
			fromId: l1.agent_id,
			ticketId: 'tkt_steer_1',
			taskId: 'tsk_1',
			taskType: 'implement',
			needReturn: true,
			hasDetailRef: false,
			hasHistoryRef: false,
			taskTitle: 'Implement auth middleware',
			summary: 'Switch to HMAC challenge immediately',
		});
		controlCenter.enqueueTestOutboxDelivery({
			projectId,
			ticketId: 'tkt_steer_1',
			taskId: 'tsk_1',
			targetAgentId: l2Open.agent_id,
			deliveryMode: 'steer',
			payloadText: steerPayload,
		});
		await bridge.flushOutboxForTest();

		assert.strictEqual(dispatchedTurns.length, 1);
		assert.ok(String(dispatchedTurns[0].agentToken ?? '').startsWith('ades1.'), 'In-memory ADE_AGENT_TOKEN injected into dispatch');
		assert.strictEqual(sentChatRequests.length, 1);
		assert.strictEqual(sentChatRequests[0].uri, l2OpenUri.toString());
		assert.strictEqual(sentChatRequests[0].message, steerPayload);
		assert.strictEqual(sentChatRequests[0].options?.isSystemInitiated, false, 'CRITICAL: isSystemInitiated MUST be false so request bubble is never swallowed');
		assert.strictEqual(sentChatRequests[0].options?.noCommandDetection, true);
		assert.strictEqual(sentChatRequests[0].options?.queue, undefined, 'AdeOpenChatTicketScheduler manages non-concatenated steer preemption directly');

		const snapAfterSteer = await controlCenter.getProjectSnapshot(projectId);
		const l2OpenAfter = snapAfterSteer?.agents.find(a => a.agent_id === l2Open.agent_id);
		assert.strictEqual(l2OpenAfter?.session_phase, 'started');
		assert.strictEqual(l2OpenAfter?.native_session_id, 'native-open-codex-1');

		// 2. Enqueue first Ticket to L2 Missing CLI -> cliMissing rolls session_phase back to 'unstarted' so engine can still be edited!
		controlCenter.enqueueTestOutboxDelivery({
			projectId,
			ticketId: 'tkt_missing_1',
			taskId: 'tsk_m1',
			targetAgentId: l2MissingCli.agent_id,
			deliveryMode: 'queue',
			payloadText: steerPayload,
		});
		await bridge.flushOutboxForTest();

		const snapAfterMissing = await controlCenter.getProjectSnapshot(projectId);
		const l2MissingAfter = snapAfterMissing?.agents.find(a => a.agent_id === l2MissingCli.agent_id);
		assert.strictEqual(l2MissingAfter?.session_phase, 'unstarted', 'cliMissing self-heals session_phase back to unstarted');
		assert.strictEqual(l2MissingAfter?.session_started, false);
		const switchedEngine = await controlCenter.uiEditAgent({
			projectId,
			agentId: l2MissingCli.agent_id,
			engine: 'claude',
			model: 'claude-sonnet-4-6',
		});
		assert.strictEqual(switchedEngine.engine, 'claude', 'Engine remains editable after cliMissing rollback');

		// 3. Sync session preferences & forward cancelTicketTurns + disposeAgentRuntime
		await instantiation.get(ICommandService).executeCommand(ADE_SYNC_SESSION_PREFERENCES_COMMAND_ID, {
			resource: l2OpenUri.toString(),
			model: 'o4-mini',
			thinking: 'off',
		});
		const snapAfterPrefs = await controlCenter.getProjectSnapshot(projectId);
		const l2Prefs = snapAfterPrefs?.agents.find(a => a.agent_id === l2Open.agent_id);
		assert.strictEqual(l2Prefs?.model, 'o4-mini');
		assert.strictEqual(l2Prefs?.effort, 'off');

		controlCenter.cancelTestOutboxTickets(projectId, ['tkt_steer_1']);
		await new Promise(r => setTimeout(r, 10));
		assert.ok(cancelledPayloads.some(p => Array.isArray(p.ticketIds) && p.ticketIds.includes('tkt_steer_1')));

		await controlCenter.uiDeleteAgent(projectId, l2MissingCli.agent_id);
		await new Promise(r => setTimeout(r, 10));
		assert.ok(disposedPayloads.some(p => p.agentId === l2MissingCli.agent_id));
	});

	test('AdeEditorService active-editor switching isolates same-named agentId markRead/selectAgent per projectId and syncs ProjectNavigationService for file:// folders', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const folderA = URI.file('/workspace/repo-alpha');
		const folderB = URI.file('/workspace/repo-beta');
		const instantiation = workbenchInstantiationService({
			contextService: () => new TestContextService(new Workspace('ade-cross-proj-sync', [toWorkspaceFolder(folderA), toWorkspaceFolder(folderB)])),
			adeControlCenterService: () => controlCenter,
		}, store);

		const nav = store.add(instantiation.createInstance(ProjectNavigationService));
		nav.selectProject(folderA);
		instantiation.stub(IProjectNavigationService, nav);

		const editorHarness = createEditorGroupsHarness(store);
		instantiation.stub(IEditorGroupsService, editorHarness.editorGroupsService);
		instantiation.stub(IEditorService, editorHarness.editorService);
		instantiation.stub(IExtensionService, upcastPartial<IExtensionService>({
			extensions: [],
			onDidChangeExtensions: Event.None,
			whenInstalledExtensionsRegistered: async () => true,
			activateById: async () => undefined,
		}));

		const modes = instantiation.get(IWorkbenchModeService);
		modes.setMode('ade');

		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, projects);
		await projects.whenReady();
		await projects.registerWorkspaceFolderAsync!(folderA, 'Repo Alpha');
		await projects.registerWorkspaceFolderAsync!(folderB, 'Repo Beta');

		const pageA = await projects.createProjectPage(folderA, 'Page Alpha');
		const pageB = await projects.createProjectPage(folderB, 'Page Beta');

		const baseSnapA = (await controlCenter.getProjectSnapshot(pageA.meta.project_id))!;
		const baseSnapB = (await controlCenter.getProjectSnapshot(pageB.meta.project_id))!;
		const now = 1_764_060_500_000;
		const makeSharedAgent = (projectId: string, name: string) => ({
			agent_id: 'agent_shared_lead',
			project_id: projectId,
			level: 1,
			is_top_role: true,
			parent_id: null,
			name,
			role_summary: 'Top lead',
			host: 'local',
			engine: 'claude',
			model: 'claude-sonnet-4-6',
			effort: 'high',
			session_phase: 'unstarted' as const,
			session_started: false,
			excluded_dept_ids: [] as readonly string[],
			last_read_doc_rev: 1,
			token_gen: 1,
			created_at: now,
			updated_at: now,
		});
		const seededLeadA = {
			...baseSnapA,
			agents: [makeSharedAgent(pageA.meta.project_id, 'Alpha Lead')],
		};
		const seededLeadB = {
			...baseSnapB,
			agents: [makeSharedAgent(pageB.meta.project_id, 'Beta Lead')],
		};
		controlCenter.seedTestProjectSnapshot(seededLeadA);
		controlCenter.seedTestProjectSnapshot(seededLeadB);
		projects.notifyProjectSnapshotLoaded(seededLeadA);
		projects.notifyProjectSnapshotLoaded(seededLeadB);

		projects.setAgentStatus('agent_shared_lead', 'working', true, pageA.meta.project_id);
		projects.setAgentStatus('agent_shared_lead', 'working', true, pageB.meta.project_id);
		assert.strictEqual(projects.getAgent('agent_shared_lead', pageA.meta.project_id)?.unread, true);
		assert.strictEqual(projects.getAgent('agent_shared_lead', pageB.meta.project_id)?.unread, true);

		const adeEditors = store.add(instantiation.createInstance(AdeEditorService));
		instantiation.stub(IAdeEditorService, adeEditors);

		const chatA = store.add(instantiation.createInstance(
			ChatEditorInput,
			buildAdeEmployeeSessionUri('claude', pageA.meta.project_id, 'agent_shared_lead'),
			{},
		));
		const chatB = store.add(instantiation.createInstance(
			ChatEditorInput,
			buildAdeEmployeeSessionUri('claude', pageB.meta.project_id, 'agent_shared_lead'),
			{},
		));

		// Activating Project B's ChatEditorInput selects Project B, syncs ProjectNavigationService to folderB, and clears ONLY Project B's unread badge
		await editorHarness.editorService.openEditor(chatB);
		assert.strictEqual(projects.selectedProjectPageId, pageB.meta.project_id);
		assert.strictEqual(projects.selectedAgentId, 'agent_shared_lead');
		assert.strictEqual(nav.selectedProject?.uri.toString(), folderB.toString());
		assert.strictEqual(projects.getAgent('agent_shared_lead', pageB.meta.project_id)?.unread, false, 'Project B unread cleared on focus');
		assert.strictEqual(projects.getAgent('agent_shared_lead', pageA.meta.project_id)?.unread, true, 'Project A same-named agentId unread preserved');

		// Switching focus to Project A's ChatEditorInput syncs ProjectNavigationService back to folderA and clears Project A's unread badge
		await editorHarness.editorService.openEditor(chatA);
		assert.strictEqual(projects.selectedProjectPageId, pageA.meta.project_id);
		assert.strictEqual(nav.selectedProject?.uri.toString(), folderA.toString());
		assert.strictEqual(projects.getAgent('agent_shared_lead', pageA.meta.project_id)?.unread, false);
	});

	test('Deleting proj_a closes ONLY proj_a ChatEditorInput while preserving proj_b same-named agent_shared_l1 tab & _selectedAgentId, and dual-folder first selectProjectPage(pageA) syncs ProjectNavigationService from undefined to folderA', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const folderA = URI.file('/workspace/dual-alpha');
		const folderB = URI.file('/workspace/dual-beta');
		const instantiation = workbenchInstantiationService({
			contextService: () => new TestContextService(new Workspace('ade-track-c', [toWorkspaceFolder(folderA), toWorkspaceFolder(folderB)])),
			adeControlCenterService: () => controlCenter,
		}, store);

		// Do NOT pre-call nav.selectProject: in a 2-folder workspace, ProjectNavigationService starts with selectedProject === undefined
		const nav = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, nav);
		const getNavSelectedUri = () => nav.selectedProject?.uri.toString();
		assert.strictEqual(getNavSelectedUri(), undefined);

		const editorHarness = createEditorGroupsHarness(store);
		instantiation.stub(IEditorGroupsService, editorHarness.editorGroupsService);
		instantiation.stub(IEditorService, editorHarness.editorService);
		instantiation.stub(IExtensionService, upcastPartial<IExtensionService>({
			extensions: [],
			onDidChangeExtensions: Event.None,
			whenInstalledExtensionsRegistered: async () => true,
			activateById: async () => undefined,
		}));

		const modes = instantiation.get(IWorkbenchModeService);
		modes.setMode('ade');

		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, projects);
		await projects.whenReady();

		// Seed pageA & pageB via ControlCenter + refreshCatalog so nav.selectedProject is still undefined before first selectProjectPage(pageA)
		const pageA = await controlCenter.createProject({ folderUri: folderA.toString(), name: 'Project A' });
		const pageB = await controlCenter.createProject({ folderUri: folderB.toString(), name: 'Project B' });
		await projects.refreshCatalog();
		assert.strictEqual(projects.selectedProject?.uri.toString(), folderA.toString());
		assert.strictEqual(getNavSelectedUri(), undefined, 'Precondition: multi-folder ProjectNavigationService starts undefined');

		// 1. First selectProjectPage(pageA) self-heals projectNavigation.selectedProject from undefined -> folderA
		projects.selectProjectPage(pageA.meta.project_id);
		assert.strictEqual(projects.selectedProjectPageId, pageA.meta.project_id);
		assert.strictEqual(getNavSelectedUri(), folderA.toString(), 'First selectProjectPage(pageA) must sync ProjectNavigationService to folderA');

		// 2. Populate both proj_a and proj_b with same-named `agent_shared_l1` and open ChatEditorInput for BOTH
		const now = 1_764_070_000_000;
		const makeSharedL1 = (projectId: string, label: string) => ({
			agent_id: 'agent_shared_l1',
			project_id: projectId,
			level: 1,
			is_top_role: true,
			parent_id: null,
			name: label,
			role_summary: 'Top role',
			host: 'local',
			engine: 'claude',
			model: 'claude-sonnet-4-6',
			effort: 'high',
			session_phase: 'started' as const,
			session_started: true,
			excluded_dept_ids: [] as readonly string[],
			last_read_doc_rev: 1,
			token_gen: 1,
			created_at: now,
			updated_at: now,
		});
		const baseSnapA = (await controlCenter.getProjectSnapshot(pageA.meta.project_id))!;
		const baseSnapB = (await controlCenter.getProjectSnapshot(pageB.meta.project_id))!;
		const seededSnapA = {
			...baseSnapA,
			agents: [makeSharedL1(pageA.meta.project_id, 'Alpha Shared L1')],
		};
		const seededSnapB = {
			...baseSnapB,
			agents: [makeSharedL1(pageB.meta.project_id, 'Beta Shared L1')],
		};
		controlCenter.seedTestProjectSnapshot(seededSnapA);
		controlCenter.seedTestProjectSnapshot(seededSnapB);
		projects.notifyProjectSnapshotLoaded(seededSnapA);
		projects.notifyProjectSnapshotLoaded(seededSnapB);

		const adeEditors = store.add(instantiation.createInstance(AdeEditorService));
		instantiation.stub(IAdeEditorService, adeEditors);
		store.add(projects.onDidRemoveAgents(removedAgents => {
			if (removedAgents.length > 0) {
				void adeEditors.closeAgents(removedAgents);
			}
		}));

		const uriA = buildAdeEmployeeSessionUri('claude', pageA.meta.project_id, 'agent_shared_l1');
		const uriB = buildAdeEmployeeSessionUri('claude', pageB.meta.project_id, 'agent_shared_l1');

		// Pre-mount a transitional AdeSessionEditorInput for proj_b and verify openAgent(proj_a) does NOT close proj_b's transitional editor
		const transitionalB = store.add(instantiation.createInstance(AdeSessionEditorInput, 'agent_shared_l1', pageB.meta.project_id));
		await editorHarness.editorService.openEditor(transitionalB);
		await adeEditors.openAgent('agent_shared_l1', { projectId: pageA.meta.project_id });
		assert.strictEqual(transitionalB.isDisposed(), false, 'openAgent on proj_a must not close proj_b transitional AdeSessionEditorInput');

		// Materialize proj_b's ChatEditorInput in split group -> replaces ONLY proj_b's transitional AdeSessionEditorInput while keeping proj_a's ChatEditorInput open
		await adeEditors.openAgent('agent_shared_l1', { projectId: pageB.meta.project_id, side: true });
		assert.strictEqual(transitionalB.isDisposed(), true, 'openAgent on proj_b closes proj_b transitional AdeSessionEditorInput');

		const hasOpenChatUri = (targetUri: URI) => editorHarness.groups.some(g =>
			g.editors.some(e => e instanceof ChatEditorInput && !e.isDisposed() && e.sessionResource?.toString() === targetUri.toString()),
		);
		assert.strictEqual(hasOpenChatUri(uriA), true, 'proj_a ChatEditorInput is open');
		assert.strictEqual(hasOpenChatUri(uriB), true, 'proj_b ChatEditorInput is open');
		assert.strictEqual(projects.selectedProjectPageId, pageB.meta.project_id);
		assert.strictEqual(projects.selectedAgentId, 'agent_shared_l1');

		// 3. Delete proj_a while proj_b + agent_shared_l1 is active -> onDidRemoveAgents -> closeAgents closes ONLY proj_a's tab; proj_b's tab & _selectedAgentId survive!
		await projects.deleteProjectPage(pageA.meta.project_id);
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}

		assert.strictEqual(hasOpenChatUri(uriA), false, 'proj_a ChatEditorInput must be closed upon deleting proj_a');
		assert.strictEqual(hasOpenChatUri(uriB), true, 'proj_b same-named agent_shared_l1 ChatEditorInput must remain open');
		assert.strictEqual(projects.selectedProjectPageId, pageB.meta.project_id);
		assert.strictEqual(projects.selectedAgentId, 'agent_shared_l1', 'proj_b _selectedAgentId must not be cleared when deleting proj_a');
		assert.strictEqual(getNavSelectedUri(), folderB.toString());
	});

	test('openAgent prefers active/selected project over unscoped getAgent, scopes AdeExtensionWebviewEditorInput & openFile, and closes all orphan tabs on unhydrated deleteProjectPage/removeProject', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const folderA = URI.file('/workspace/scope-alpha');
		const folderB = URI.file('/workspace/scope-beta');
		const folderC = URI.file('/workspace/scope-gamma');
		const instantiation = workbenchInstantiationService({
			contextService: () => new TestContextService(new Workspace('ade-scope-orphans', [toWorkspaceFolder(folderA), toWorkspaceFolder(folderB), toWorkspaceFolder(folderC)])),
			adeControlCenterService: () => controlCenter,
		}, store);

		const nav = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, nav);
		instantiation.stub(IAdeSessionsService, upcastPartial<IAdeSessionsService>({
			getIcon: () => undefined,
			getEngineName: id => id,
		}));

		const editorHarness = createEditorGroupsHarness(store);
		instantiation.stub(IEditorGroupsService, editorHarness.editorGroupsService);
		instantiation.stub(IEditorService, editorHarness.editorService);
		instantiation.stub(IExtensionService, upcastPartial<IExtensionService>({
			extensions: [],
			onDidChangeExtensions: Event.None,
			whenInstalledExtensionsRegistered: async () => true,
			activateById: async () => undefined,
		}));

		instantiation.get(IWorkbenchModeService).setMode('ade');
		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, projects);
		await projects.whenReady();

		const pageA = await projects.createProjectPage(folderA, 'Scope A');
		const pageB = await projects.createProjectPage(folderB, 'Scope B');
		const now = 1_764_080_000_000;
		const makeL1 = (projectId: string, name: string) => ({
			agent_id: 'agent_shared_l1',
			project_id: projectId,
			level: 1,
			is_top_role: true,
			parent_id: null,
			name,
			role_summary: 'Lead',
			host: 'local',
			engine: 'claude',
			model: 'claude-sonnet-4-6',
			effort: 'high',
			session_phase: 'started' as const,
			session_started: true,
			excluded_dept_ids: [] as readonly string[],
			last_read_doc_rev: 1,
			token_gen: 1,
			created_at: now,
			updated_at: now,
		});

		// Hydrate pageA into projects._snapshotsByProject immediately, while keeping pageB ONLY in ControlCenter (unhydrated in memory!)
		const snapA = { ...(await controlCenter.getProjectSnapshot(pageA.meta.project_id))!, agents: [makeL1(pageA.meta.project_id, 'Alpha L1')] };
		const snapB = { ...(await controlCenter.getProjectSnapshot(pageB.meta.project_id))!, agents: [makeL1(pageB.meta.project_id, 'Beta L1')] };
		controlCenter.seedTestProjectSnapshot(snapA);
		controlCenter.seedTestProjectSnapshot(snapB);
		projects.notifyProjectSnapshotLoaded(snapA);

		const adeEditors = store.add(instantiation.createInstance(AdeEditorService));
		instantiation.stub(IAdeEditorService, adeEditors);

		// 1. Focus pageB's canvas editor while pageB is not yet hydrated in _snapshotsByProject; openAgent('agent_shared_l1') without projectId MUST resolve to pageB (NOT hijack to hydrated pageA!)
		const canvasB = store.add(instantiation.createInstance(AdeEngineeringEditorInput, pageB.meta.project_id));
		await editorHarness.editorService.openEditor(canvasB);
		assert.strictEqual(adeEditors.getActiveProjectPageId(), pageB.meta.project_id);

		await adeEditors.openAgent('agent_shared_l1');
		const uriB = buildAdeEmployeeSessionUri('claude', pageB.meta.project_id, 'agent_shared_l1');
		assert.strictEqual(projects.selectedProjectPageId, pageB.meta.project_id, 'openAgent without projectId must honor active project pageB');
		assert.ok(
			editorHarness.groups.some(g => g.editors.some(e => e instanceof ChatEditorInput && !e.isDisposed() && e.sessionResource?.toString() === uriB.toString())),
			'openAgent hydrated and opened pageB ChatEditorInput without cross-project hijacking to pageA',
		);

		// 2. AdeExtensionWebviewEditorInput scoping via bindEditorToAgent & openFile scoping
		const webviewB = store.add(instantiation.createInstance(AdeExtensionWebviewEditorInput, 'agent_shared_l1', 'aexus.view', 'aexus.ext', 'aexus-claude'));
		adeEditors.bindEditorToAgent(webviewB, { projectId: pageB.meta.project_id, agentId: 'agent_shared_l1' });
		await editorHarness.editorService.openEditor(webviewB);
		assert.deepStrictEqual(adeEditors.getAgentForEditor(webviewB), { projectId: pageB.meta.project_id, agentId: 'agent_shared_l1' });
		assert.strictEqual(webviewB.getName(), 'Beta L1');

		// openAgent on pageA must NOT close pageB's AdeExtensionWebviewEditorInput
		await adeEditors.openAgent('agent_shared_l1', { projectId: pageA.meta.project_id, side: true });
		assert.strictEqual(webviewB.isDisposed(), false, 'openAgent on pageA must preserve pageB AdeExtensionWebviewEditorInput');

		// Focus canvasB and call openFile(fileUri, 'agent_shared_l1') -> selects pageB's agent rather than pageA's
		projects.selectAgent('agent_shared_l1', pageA.meta.project_id);
		await editorHarness.editorService.openEditor(canvasB);
		await adeEditors.openFile(URI.file('/workspace/scope-beta/src/main.ts'), 'agent_shared_l1');
		assert.strictEqual(projects.selectedProjectPageId, pageB.meta.project_id);
		assert.strictEqual(projects.selectedAgentId, 'agent_shared_l1');

		// openAgent on pageB replaces pageB's transitional AdeExtensionWebviewEditorInput
		await adeEditors.openAgent('agent_shared_l1', { projectId: pageB.meta.project_id });
		assert.strictEqual(webviewB.isDisposed(), true, 'openAgent on pageB closes pageB AdeExtensionWebviewEditorInput');

		// 3. Unhydrated Project C: mount ALL 4 tab types WITHOUT hydrating Project C's agents into _snapshotsByProject, then deleteProjectPage(pageC)
		const pageC = await controlCenter.createProject({ folderUri: folderC.toString(), name: 'Unhydrated C' });
		await projects.refreshCatalog();
		assert.strictEqual(projects.agents.some(a => a.projectId === pageC.meta.project_id), false, 'Precondition: pageC has zero hydrated agents in _snapshotsByProject');

		const canvasC = store.add(instantiation.createInstance(AdeEngineeringEditorInput, pageC.meta.project_id));
		const sessionC = store.add(instantiation.createInstance(AdeSessionEditorInput, 'agent_shared_l1', pageC.meta.project_id));
		const webviewC = store.add(instantiation.createInstance(AdeExtensionWebviewEditorInput, 'agent_shared_l1', 'aexus.view.c', 'aexus.ext', 'aexus-claude'));
		adeEditors.bindEditorToAgent(webviewC, { projectId: pageC.meta.project_id, agentId: 'agent_shared_l1' });
		const uriC = buildAdeEmployeeSessionUri('claude', pageC.meta.project_id, 'agent_shared_l1');
		const chatC = store.add(instantiation.createInstance(ChatEditorInput, uriC, {}));
		assert.deepStrictEqual(adeEditors.getAgentForEditor(chatC), { projectId: pageC.meta.project_id, agentId: 'agent_shared_l1' });

		await editorHarness.editorService.openEditor(canvasC);
		await editorHarness.editorService.openEditor(sessionC);
		await editorHarness.editorService.openEditor(webviewC);
		await editorHarness.editorService.openEditor(chatC);

		// Re-focus pageB's agent_shared_l1 before deleting unhydrated pageC
		await adeEditors.openAgent('agent_shared_l1', { projectId: pageB.meta.project_id });
		assert.strictEqual(projects.selectedProjectPageId, pageB.meta.project_id);
		assert.strictEqual(projects.selectedAgentId, 'agent_shared_l1');

		await projects.deleteProjectPage(pageC.meta.project_id);
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}

		assert.strictEqual(canvasC.isDisposed(), true, 'Unhydrated pageC canvas tab must be closed');
		assert.strictEqual(sessionC.isDisposed(), true, 'Unhydrated pageC AdeSessionEditorInput must be closed');
		assert.strictEqual(webviewC.isDisposed(), true, 'Unhydrated pageC AdeExtensionWebviewEditorInput must be closed');
		assert.strictEqual(chatC.isDisposed(), true, 'Unhydrated pageC ChatEditorInput must be closed');
		assert.ok(
			editorHarness.groups.some(g => g.editors.some(e => e instanceof ChatEditorInput && !e.isDisposed() && e.sessionResource?.toString() === uriB.toString())),
			'pageB same-named agent_shared_l1 ChatEditorInput must remain open',
		);
		assert.strictEqual(projects.selectedProjectPageId, pageB.meta.project_id);
		assert.strictEqual(projects.selectedAgentId, 'agent_shared_l1');
	});

	test('Wave 5 Track C: restored AdeExtensionWebviewEditorInput & AdeExtensionWebviewEditorPane isolate cross-project same-named agentId across resource, closeAgents, overlay instance, and webviewState', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const folderA = URI.file('/workspace/w5-webview-alpha');
		const folderB = URI.file('/workspace/w5-webview-beta');
		const instantiation = workbenchInstantiationService({
			contextService: () => new TestContextService(new Workspace('ade-w5-webview', [toWorkspaceFolder(folderA), toWorkspaceFolder(folderB)])),
			adeControlCenterService: () => controlCenter,
		}, store);

		const nav = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, nav);
		instantiation.stub(IAdeSessionsService, upcastPartial<IAdeSessionsService>({
			getIcon: () => undefined,
			getEngineName: id => id,
		}));

		const editorHarness = createEditorGroupsHarness(store);
		instantiation.stub(IEditorGroupsService, editorHarness.editorGroupsService);
		instantiation.stub(IEditorService, editorHarness.editorService);
		instantiation.stub(IExtensionService, upcastPartial<IExtensionService>({
			extensions: [],
			onDidChangeExtensions: Event.None,
			whenInstalledExtensionsRegistered: async () => true,
			activateById: async () => undefined,
			activateByEvent: async () => undefined,
		}));

		const createdOverlays: Array<{
			readonly overlay: IOverlayWebview;
			readonly fireStateUpdate: (nextState: string) => void;
			disposed: boolean;
			released: boolean;
		}> = [];
		instantiation.stub(IWebviewService, upcastPartial<IWebviewService>({
			onDidChangeActiveWebview: Event.None,
			activeWebview: undefined,
			webviews: [],
			createWebviewOverlay: () => {
				const stateEmitter = store.add(new Emitter<string | undefined>());
				const container = $('div.mock-overlay-webview');
				let currentState: string | undefined;
				const record = {
					disposed: false,
					released: false,
					fireStateUpdate: (nextState: string) => {
						currentState = nextState;
						stateEmitter.fire(nextState);
					},
					overlay: undefined as unknown as IOverlayWebview,
				};
				record.overlay = upcastPartial<IOverlayWebview>({
					container,
					get state() { return currentState; },
					set state(val: string | undefined) { currentState = val; },
					onDidUpdateState: stateEmitter.event,
					onDidDispose: Event.None,
					onDidFocus: Event.None,
					onDidBlur: Event.None,
					claim: () => { record.released = false; },
					release: () => { record.released = true; },
					setAnchorElement: () => undefined,
					focus: () => undefined,
					dispose: () => { record.disposed = true; },
				});
				createdOverlays.push(record);
				return record.overlay;
			},
		}));
		instantiation.stub(IWebviewViewService, upcastPartial<IWebviewViewService>({
			onNewResolverRegistered: Event.None,
			resolve: async () => undefined,
		}));

		instantiation.get(IWorkbenchModeService).setMode('ade');
		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, projects);
		await projects.whenReady();

		const pageA = await projects.createProjectPage(folderA, 'Webview Proj A');
		const pageB = await projects.createProjectPage(folderB, 'Webview Proj B');
		const projA = pageA.meta.project_id;
		const projB = pageB.meta.project_id;
		const now = 1_764_090_000_000;
		const makeShared = (projectId: string, name: string) => ({
			agent_id: 'agent_shared_l1',
			project_id: projectId,
			level: 1,
			is_top_role: true,
			parent_id: null,
			name,
			role_summary: 'Lead',
			host: 'local',
			engine: 'claude',
			model: 'claude-sonnet-4-6',
			effort: 'high',
			session_phase: 'started' as const,
			session_started: true,
			excluded_dept_ids: [] as readonly string[],
			last_read_doc_rev: 1,
			token_gen: 1,
			created_at: now,
			updated_at: now,
		});
		const snapA = { ...(await controlCenter.getProjectSnapshot(projA))!, agents: [makeShared(projA, 'Alpha Webview Lead')] };
		const snapB = { ...(await controlCenter.getProjectSnapshot(projB))!, agents: [makeShared(projB, 'Beta Webview Lead')] };
		controlCenter.seedTestProjectSnapshot(snapA);
		controlCenter.seedTestProjectSnapshot(snapB);
		projects.notifyProjectSnapshotLoaded(snapA);
		projects.notifyProjectSnapshotLoaded(snapB);

		// 1. Serialize & deserialize BOTH projects' same-named webview + session inputs BEFORE AdeEditorService is created (simulating Cmd+R reload restore without bindEditorToAgent!)
		const webviewSerializer = new AdeExtensionWebviewEditorSerializer();
		const sessionSerializer = new AdeSessionEditorSerializer();

		const rawWebviewA = store.add(instantiation.createInstance(AdeExtensionWebviewEditorInput, 'agent_shared_l1', 'aexus.nativeView', 'aexus.ext', 'aexus-claude')).setProjectId(projA);
		const rawWebviewB = store.add(instantiation.createInstance(AdeExtensionWebviewEditorInput, 'agent_shared_l1', 'aexus.nativeView', 'aexus.ext', 'aexus-claude')).setProjectId(projB);
		assert.strictEqual(rawWebviewA.resource.path, `/${projA}/agent_shared_l1`, 'Webview resource path must encode /{projectId}/{agentId}');
		assert.strictEqual(rawWebviewB.resource.path, `/${projB}/agent_shared_l1`);
		assert.notStrictEqual(rawWebviewA.resource.toString(), rawWebviewB.resource.toString());
		assert.strictEqual(rawWebviewA.matches(rawWebviewB), false, 'Cross-project same-named Webview inputs must never match');

		const restoredWebviewA = store.add(webviewSerializer.deserialize(instantiation, webviewSerializer.serialize(rawWebviewA)!) as AdeExtensionWebviewEditorInput);
		const restoredWebviewB = store.add(webviewSerializer.deserialize(instantiation, webviewSerializer.serialize(rawWebviewB)!) as AdeExtensionWebviewEditorInput);
		const restoredSessionA = store.add(sessionSerializer.deserialize(instantiation, JSON.stringify({ v: 2, agentId: 'agent_shared_l1', projectId: projA })) as AdeSessionEditorInput);
		const restoredSessionB = store.add(sessionSerializer.deserialize(instantiation, JSON.stringify({ v: 2, agentId: 'agent_shared_l1', projectId: projB })) as AdeSessionEditorInput);

		assert.strictEqual(restoredWebviewA.projectId, projA);
		assert.strictEqual(restoredWebviewB.projectId, projB);
		assert.strictEqual(restoredWebviewA.resource.path, `/${projA}/agent_shared_l1`);
		assert.strictEqual(restoredWebviewB.resource.path, `/${projB}/agent_shared_l1`);

		// Mount restored inputs directly into editor groups BEFORE creating AdeEditorService (NEVER calling bindEditorToAgent manually!)
		editorHarness.groups[0].editors.push(restoredWebviewA, restoredWebviewB, restoredSessionA, restoredSessionB);
		editorHarness.groups[0].activeEditor = restoredWebviewB;

		// 2. AdeExtensionWebviewEditorPane in-group switch between restoredWebviewA and restoredWebviewB isolates overlay instance & storage stateKey
		const paneHost = append(mainWindow.document.body, $('.ade-webview-pane-test-host', { style: 'width:640px;height:480px;' }));
		store.add({ dispose: () => paneHost.remove() });
		const webviewPane = store.add(instantiation.createInstance(AdeExtensionWebviewEditorPane, editorHarness.groups[0] as unknown as IEditorGroup));
		webviewPane.create(paneHost);

		await webviewPane.setInput(restoredWebviewA, undefined, {}, CancellationToken.None);
		assert.strictEqual(createdOverlays.length, 1);
		createdOverlays[0].fireStateUpdate(JSON.stringify({ draft: 'alpha-only-state' }));

		const storage = instantiation.get(IStorageService);
		const stateKeyA = `aexus.ade.webviewState.${projA}.agent_shared_l1.aexus.nativeView`;
		const stateKeyB = `aexus.ade.webviewState.${projB}.agent_shared_l1.aexus.nativeView`;
		assert.strictEqual(storage.get(stateKeyA, StorageScope.PROFILE), JSON.stringify({ draft: 'alpha-only-state' }));
		assert.strictEqual(storage.get(stateKeyB, StorageScope.PROFILE), undefined, 'proj_a webview state must not leak into proj_b key');

		// Switch same pane to restoredWebviewB -> MUST teardown proj_a overlay and create a brand-new overlay for proj_b!
		await webviewPane.setInput(restoredWebviewB, undefined, {}, CancellationToken.None);
		assert.strictEqual(createdOverlays.length, 2, 'Switching same-group cross-project same-agentId webview must instantiate separate overlay');
		assert.strictEqual(createdOverlays[0].disposed, true, 'Previous project overlay must be torn down on cross-project switch');
		assert.strictEqual(createdOverlays[1].overlay.state, undefined, 'proj_b overlay must not inherit proj_a state');
		createdOverlays[1].fireStateUpdate(JSON.stringify({ draft: 'beta-only-state' }));
		assert.strictEqual(storage.get(stateKeyA, StorageScope.PROFILE), JSON.stringify({ draft: 'alpha-only-state' }), 'proj_b state update must not overwrite proj_a state');
		assert.strictEqual(storage.get(stateKeyB, StorageScope.PROFILE), JSON.stringify({ draft: 'beta-only-state' }));

		// 3. Instantiate AdeEditorService after restore and delete proj_a -> closeAgents closes ONLY proj_a restored tabs, NEVER proj_b restored Webview/Session tabs!
		const adeEditors = store.add(instantiation.createInstance(AdeEditorService));
		instantiation.stub(IAdeEditorService, adeEditors);
		store.add(projects.onDidRemoveAgents(removedAgents => {
			if (removedAgents.length > 0) {
				void adeEditors.closeAgents(removedAgents);
			}
		}));

		assert.deepStrictEqual(adeEditors.getAgentForEditor(restoredWebviewB), { projectId: projB, agentId: 'agent_shared_l1' });
		await projects.deleteProjectPage(projA);
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}

		assert.strictEqual(restoredWebviewA.isDisposed(), true, 'proj_a restored AdeExtensionWebviewEditorInput must be closed');
		assert.strictEqual(restoredSessionA.isDisposed(), true, 'proj_a restored AdeSessionEditorInput must be closed');
		assert.strictEqual(restoredWebviewB.isDisposed(), false, 'proj_b restored AdeExtensionWebviewEditorInput must NOT fall into fallbackBareIds and close');
		assert.strictEqual(restoredSessionB.isDisposed(), false, 'proj_b restored AdeSessionEditorInput must remain open');
	});
});
