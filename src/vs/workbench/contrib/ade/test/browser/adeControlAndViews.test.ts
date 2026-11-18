/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ElementsDragAndDropData, ListViewTargetSector } from '../../../../../base/browser/ui/list/listView.js';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ADE_CONTROL_EXECUTE_COMMAND_ID,
	ADE_GET_ROLE_SYNC_SNAPSHOT_COMMAND_ID,
	ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID,
	ADE_SET_SESSION_INITIALIZING_COMMAND_ID,
	ADE_SYNC_SESSION_PREFERENCES_COMMAND_ID,
	IAdeControlStatus,
	IAdeProjectSummary,
	IAdeRoleSyncSnapshot,
	IAdeSessionSummary,
	IAdeSessionTreeResult,
} from '../../../../../platform/ade/common/adeControl.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService, IPrompt } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, toWorkspaceFolder, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IAgentHostEnablementService } from '../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { API_OPEN_DIFF_EDITOR_COMMAND_ID } from '../../../../browser/parts/editor/editorCommands.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IViewContainerModel, IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../../common/views.js';
import { IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IWorkbenchModeService } from '../../../../services/workbenchMode/common/workbenchMode.js';
import { IWorkingCopyFileService } from '../../../../services/workingCopy/common/workingCopyFileService.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IChatWidget, IChatWidgetService } from '../../../chat/browser/chat.js';
import { ChatSendResult, IChatService } from '../../../chat/common/chatService/chatService.js';
import { IChatSessionsService } from '../../../chat/common/chatSessionsService.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../../files/browser/projectNavigationService.js';
import { ISCMProvider, ISCMRepository, ISCMResource, ISCMResourceGroup, ISCMService } from '../../../scm/common/scm.js';
import { IOverlayWebview, IWebviewService } from '../../../webview/browser/webview.js';
import { IWebviewViewService, WebviewView } from '../../../webviewView/browser/webviewViewService.js';
import '../../browser/ade.css';
import '../../browser/ade.contribution.js';
import '../../browser/adeControlHandler.js';
import { AdeEditorService } from '../../browser/adeEditorService.js';
import { AdeChangesView, findProjectScmRepository, openScmResourceInAde } from '../../browser/adeInspectorViews.js';
import { deleteProjectsWithModePrompt, reconcileIdeWorkspaceWithCatalog, removeProjectsSynchronized } from '../../browser/adeProjectManagement.js';
import { AdeProjectsService } from '../../browser/adeProjectsService.js';
import { AdeProjectsDragAndDrop, AdeProjectsView, AdeTreeItem } from '../../browser/adeProjectsView.js';
import { ChatEditorInput } from '../../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { AdeExtensionWebviewEditorInput, AdeExtensionWebviewEditorPane, AdeSessionEditorInput } from '../../browser/adeSessionEditor.js';
import { IAdeEngineSession, IAdeSessionsService } from '../../browser/adeSessionsService.js';
import { ADE_CHANGES_VIEW_ID, ADE_PROJECTS_VIEW_ID, ADE_SECRETARY_ID, IAdeAgent, IAdeEditorService, IAdeProjectsService, IAdeSession } from '../../common/ade.js';

suite('ADE Prompt Context, Control Handler, Inspector & Sidebar View', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const alpha = URI.file('/projects/Alpha');
	const beta = URI.file('/projects/Beta');

	function createHarness(initialFolders: readonly URI[] = [alpha, beta]) {
		const instantiation = workbenchInstantiationService(undefined, store);
		let folders = initialFolders.map(uri => toWorkspaceFolder(uri));
		const workspace = new Workspace('ade-test', folders);
		const onFoldersChanged = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		instantiation.stub(IWorkspaceContextService, {
			getWorkspace: () => new Workspace(workspace.id, folders),
			onDidChangeWorkspaceFolders: onFoldersChanged.event,
		});
		const navigation = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, navigation);
		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, projects);

		let sessionCounter = 0;
		const deletedResources: string[] = [];
		const deleteAttempts: string[] = [];
		const deleteFailures = new Set<string>();
		const stoppedResources: string[] = [];
		const deletedProjectSessions: string[] = [];
		const removedWorkspaceFolders: string[] = [];
		const renamedResources: Array<{ resource: string; label: string }> = [];
		const sentChatRequests: Array<{ resource: string; message: string }> = [];
		const openedLog: Array<{ kind: string; target: string; side?: boolean }> = [];
		const closedAgentIds: string[] = [];
		const openedDiffs: Array<{ original: string; modified: string; label?: string; project?: string }> = [];
		let activeEditor: EditorInput | undefined;

		instantiation.stub(IWorkspaceEditingService, new class extends mock<IWorkspaceEditingService>() {
			override async removeFolders(uris: URI[]): Promise<void> {
				const uriIdentity = instantiation.get(IUriIdentityService);
				removedWorkspaceFolders.push(...uris.map(u => u.toString()));
				const removed = folders.filter(f => uris.some(u => uriIdentity.extUri.isEqual(f.uri, u)));
				folders = folders.filter(f => !uris.some(u => uriIdentity.extUri.isEqual(f.uri, u)));
				if (removed.length > 0) {
					onFoldersChanged.fire({ added: [], removed, changed: [] });
				}
			}
			override async addFolders(toAdd: { uri: URI }[]): Promise<void> {
				const added = toAdd.map(item => toWorkspaceFolder(item.uri));
				folders = [...folders, ...added];
				if (added.length > 0) {
					onFoldersChanged.fire({ added, removed: [], changed: [] });
				}
			}
		}());

		const sessionsStub: IAdeSessionsService = {
			_serviceBrand: undefined,
			onDidChangeEngines: Event.None,
			getIcon: () => Codicon.hubot,
			getEngineName: engineId => engineId === 'aexus-claude' ? 'Claude Code' : 'Codex',
			getEngines: async () => [
				{ id: 'aexus-claude', name: 'Claude Code', description: 'Anthropic Claude Code CLI', icon: Codicon.hubot },
				{ id: 'aexus-codex', name: 'Codex', description: 'OpenAI Codex CLI', icon: Codicon.terminal },
			],
			create: async (engineId: string, projectUri: URI): Promise<IAdeEngineSession> => {
				sessionCounter++;
				return {
					engineId,
					resource: URI.parse(`${engineId}:/session-${sessionCounter}`),
					projectUri,
					label: `Session ${sessionCounter}`,
				};
			},
			list: async () => [],
			rename: async (session: IAdeSession, label: string) => {
				renamedResources.push({ resource: session.resource.toString(), label });
			},
			stop: async (session: IAdeSession) => {
				stoppedResources.push(session.resource.toString());
			},
			delete: async (session: IAdeSession) => {
				const resource = session.resource.toString();
				deleteAttempts.push(resource);
				if (deleteFailures.has(resource)) {
					throw new Error('Simulated engine history deletion failure');
				}
				deletedResources.push(resource);
			},
			deleteProjectSessions: async (projectUri: URI) => {
				deletedProjectSessions.push(projectUri.toString());
				return 1;
			},
		};
		instantiation.stub(IAdeSessionsService, sessionsStub);

		const editorsStub: IAdeEditorService = {
			_serviceBrand: undefined,
			get activeEditor() { return activeEditor; },
			isSessionActive: () => false,
			openAgent: async (id: string, options?: { side?: boolean }) => {
				projects.selectAgent(id);
				projects.markRead(id);
				activeEditor = store.add(instantiation.createInstance(AdeSessionEditorInput, id));
				openedLog.push({ kind: 'agent', target: id, side: options?.side });
			},
			openSecretary: async (options?: { side?: boolean }) => {
				projects.markSecretaryRead();
				activeEditor = store.add(instantiation.createInstance(AdeSessionEditorInput, ADE_SECRETARY_ID));
				openedLog.push({ kind: 'secretary', target: ADE_SECRETARY_ID, side: options?.side });
			},
			closeAgents: async (agents: readonly IAdeAgent[]) => {
				closedAgentIds.push(...agents.map(agent => agent.id));
			},
			openFile: async (resource: URI) => {
				openedLog.push({ kind: 'file', target: resource.toString() });
			},
			openDiff: async (original: URI, modified: URI, label?: string, projectUri?: URI, _options?: IEditorOptions) => {
				openedDiffs.push({ original: original.toString(), modified: modified.toString(), label, project: projectUri?.toString() });
			},
		};
		instantiation.stub(IAdeEditorService, editorsStub);

		instantiation.stub(IChatService, {
			getSession: () => undefined,
			acquireOrLoadSession: async () => ({ object: {} as never, dispose: () => { } }),
			sendRequest: async (resource: URI, message: string): Promise<ChatSendResult> => {
				sentChatRequests.push({ resource: resource.toString(), message });
				return {
					kind: 'sent',
					data: {
						agent: {} as never,
						responseCreatedPromise: Promise.resolve({} as never),
						responseCompletePromise: Promise.resolve(),
					},
				};
			},
		});

		const executedCommands: Array<{ id: string; args: unknown[] }> = [];
		instantiation.stub(ICommandService, {
			onWillExecuteCommand: Event.None,
			onDidExecuteCommand: Event.None,
			executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
				executedCommands.push({ id, args });
				const registered = CommandsRegistry.getCommand(id);
				if (registered) {
					return instantiation.invokeFunction(registered.handler, ...args) as T;
				}
				return undefined as T;
			},
		});

		return {
			instantiation,
			navigation,
			projects,
			modes: instantiation.get(IWorkbenchModeService),
			editorsStub,
			deletedResources,
			deleteAttempts,
			deleteFailures,
			stoppedResources,
			deletedProjectSessions,
			removedWorkspaceFolders,
			getFolders: () => folders,
			renamedResources,
			sentChatRequests,
			openedLog,
			closedAgentIds,
			openedDiffs,
			executedCommands,
			resolvePrompt: (target: URI | string | { agentId?: string; resource?: string | URI; mode?: 'delta' }) => instantiation.invokeFunction(CommandsRegistry.getCommand(ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID)!.handler, target) as unknown as string | undefined,
			control: <T = unknown>(action: string, params?: Record<string, unknown>) =>
				instantiation.invokeFunction(CommandsRegistry.getCommand(ADE_CONTROL_EXECUTE_COMMAND_ID)!.handler, { action, params }) as unknown as Promise<T>,
		};
	}

	test('keeps Pure Worker prompt context undefined while injecting Role Context and Secretary Viewport Context', async () => {
		const h = createHarness();
		h.modes.setMode('ade');
		h.navigation.enterProject(alpha);

		const pureWorker = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/pure-1') }, 'Standalone Worker');
		const governor = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/gov-1') }, 'Platform Lead');
		const manager = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/mgr-1') }, 'Backend Manager', {
			parentId: governor.id,
			role: 'manager',
		});
		const employee = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/emp-1') }, 'API Employee', {
			parentId: manager.id,
			role: 'employee',
		});
		h.projects.configureSecretary({ engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/sec-live') });
		await h.editorsStub.openAgent(manager.id);

		const pureContext = h.resolvePrompt(pureWorker.session!.resource);
		const govContext = h.resolvePrompt(governor.session!.resource);
		const govByIdContext = h.resolvePrompt({ agentId: governor.id });
		const pureByIdContext = h.resolvePrompt({ agentId: pureWorker.id });
		const mgrContext = h.resolvePrompt(manager.session!.resource);
		const empContext = h.resolvePrompt(employee.session!.resource);
		const secContext = h.resolvePrompt(URI.parse('aexus-claude:/sec-live'));

		assert.deepStrictEqual({
			pureIsClean: pureContext === undefined && pureByIdContext === undefined,
			govHasRoleHeader: govContext?.includes('[Aexus Orchestrated Role Context]'),
			govHasRankAuthority: Boolean(
				govContext?.includes('Governor')
				&& govContext?.includes('NEVER claim that you are "not an employee"')
				&& govContext?.includes(`aexus-ade session info ${governor.id} --json`)
				&& govByIdContext === govContext
			),
			govAutoGovernor: govContext?.includes('Role: Governor') && govContext?.includes('Backend Manager'),
			govHasSubordinateApi: Boolean(
				govContext?.includes('aexus-ade session subordinates')
				&& govContext?.includes('Backend Manager')
				&& govContext?.includes('Codex')
			),
			mgrShowsSupervisorAndSub: mgrContext?.includes('Supervisor: Platform Lead') && mgrContext?.includes('API Employee'),
			empShowsSupervisor: empContext?.includes('Role: Employee') && empContext?.includes('Supervisor: Backend Manager'),
			secHasViewportAndCli: Boolean(
				secContext?.includes('[Aexus ADE Live Viewport & Macro Control Context]')
				&& secContext?.includes('Focused Project: Alpha (/projects/Alpha)')
				&& secContext?.includes('Session "Backend Manager"')
				&& secContext?.includes('aexus-ade status --json')
			),
		}, {
			pureIsClean: true,
			govHasRoleHeader: true,
			govHasRankAuthority: true,
			govAutoGovernor: true,
			govHasSubordinateApi: true,
			mgrShowsSupervisorAndSub: true,
			empShowsSupervisor: true,
			secHasViewportAndCli: true,
		});
	});

	test('compacts prompt context in delta mode for orchestrated agents and Secretary', () => {
		const h = createHarness();
		h.modes.setMode('ade');
		h.navigation.enterProject(alpha);

		const loneGovernor = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/delta-lone') }, 'Lone Governor', { role: 'governor' });
		const governor = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/delta-gov') }, 'Delta Governor', { role: 'governor' });
		const manager = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/delta-mgr') }, 'Delta Manager', { parentId: governor.id, role: 'manager' });
		const secretaryResource = URI.parse('aexus-claude:/delta-sec');
		h.projects.configureSecretary({ engineId: 'aexus-claude', resource: secretaryResource });

		const loneDelta = h.resolvePrompt({ resource: loneGovernor.session!.resource, mode: 'delta' });
		const governorFull = h.resolvePrompt(governor.session!.resource);
		const governorDelta = h.resolvePrompt({ resource: governor.session!.resource, mode: 'delta' });
		const secretaryFull = h.resolvePrompt(secretaryResource);
		const secretaryDelta = h.resolvePrompt({ resource: secretaryResource, mode: 'delta' });

		assert.deepStrictEqual({
			loneChildlessDeltaIsUndefined: loneDelta === undefined,
			governorFullIsRoleContext: governorFull?.startsWith('[Aexus Orchestrated Role Context]'),
			governorFullHasFullManual: governorFull?.includes('Subordinate Control API'),
			governorDeltaIsHierarchySummary: governorDelta?.startsWith('[ADE Live Hierarchy State]'),
			governorDeltaShowsSubordinate: governorDelta?.includes(`Delta Manager (${manager.id}, Manager)`),
			governorDeltaOmitsFullManual: !governorDelta?.includes('Subordinate Control API'),
			secretaryFullHasFullManual: secretaryFull?.includes('Complete ADE Macro Control CLI'),
			secretaryDeltaIsViewportSummary: secretaryDelta?.startsWith('[ADE Live Viewport State]'),
			secretaryDeltaShowsFocus: secretaryDelta?.includes('Focused Project: Alpha'),
			secretaryDeltaOmitsFullManual: !secretaryDelta?.includes('aexus-ade'),
		}, {
			loneChildlessDeltaIsUndefined: true,
			governorFullIsRoleContext: true,
			governorFullHasFullManual: true,
			governorDeltaIsHierarchySummary: true,
			governorDeltaShowsSubordinate: true,
			governorDeltaOmitsFullManual: true,
			secretaryFullHasFullManual: true,
			secretaryDeltaIsViewportSummary: true,
			secretaryDeltaShowsFocus: true,
			secretaryDeltaOmitsFullManual: true,
		});
	});

	test('forwards session initializing state to the matching chat widget and clears it', async () => {
		const h = createHarness();
		const sessionResource = URI.parse('aexus-claude:/init-widget');
		const stateCalls: Array<string | undefined> = [];
		const widget = upcastPartial<IChatWidget>({
			setSessionInitializingState: message => stateCalls.push(message),
		});
		h.instantiation.stub(IChatWidgetService, upcastPartial<IChatWidgetService>({
			getAllWidgets: () => [],
			onDidAddWidget: Event.None,
			getWidgetBySessionResource: resource => resource.toString() === sessionResource.toString() ? widget : undefined,
		}));
		const commandService = h.instantiation.get(ICommandService);

		await commandService.executeCommand(ADE_SET_SESSION_INITIALIZING_COMMAND_ID, sessionResource, 'Initializing role documentation…');
		const stateWhileInitializing = [...stateCalls];
		await commandService.executeCommand(ADE_SET_SESSION_INITIALIZING_COMMAND_ID, sessionResource, undefined);

		assert.deepStrictEqual({
			stateWhileInitializing,
			stateAfterClear: stateCalls,
		}, {
			stateWhileInitializing: ['Initializing role documentation…'],
			stateAfterClear: ['Initializing role documentation…', undefined],
		});
	});

	test('executes full ADE control lifecycle for projects, hierarchy, archive, detach vs permanent delete, and Secretary', async () => {
		const h = createHarness();

		await h.control('mode.set', { mode: 'ade' });
		const addedProject = await h.control<IAdeProjectSummary>('project.add', { path: '/projects/Gamma', name: 'Gamma' });
		await h.control('project.focus', { name: 'Beta' });
		const focusedStatus = await h.control<IAdeControlStatus>('status');
		await h.control('project.home');
		const homeStatus = await h.control<IAdeControlStatus>('status');
		await h.control('project.forward');
		const forwardedStatus = await h.control<IAdeControlStatus>('status');
		await h.control('project.home');

		const root = await h.control<IAdeSessionSummary>('session.create', { project: 'Alpha', label: 'Lead Session' });
		const sub = await h.control<IAdeSessionSummary>('session.create', { parentId: root.id, role: 'manager', label: 'Sub Manager', open: false });
		const renamed = await h.control<IAdeSessionSummary>('session.rename', { id: sub.id, label: 'Core Manager' });
		await h.control('session.open', { id: sub.id, side: true });
		await h.control('session.send', { id: sub.id, message: 'Audit module boundaries' });

		// Archiving root hides entire subtree from default session.list
		await h.control('session.archive', { id: root.id, archived: true });
		const activeListWhileArchived = await h.control<IAdeSessionSummary[]>('session.list');
		await h.control('session.archive', { id: root.id, restore: true });
		const activeListAfterRestore = await h.control<IAdeSessionSummary[]>('session.list');

		// Detach removes from sidebar WITHOUT deleting from engine
		const tempSession = await h.control<IAdeSessionSummary>('session.create', { project: 'Beta', label: 'Temp Worker' });
		await h.control('session.detach', { id: tempSession.id });
		const deletesAfterDetach = [...h.deletedResources];

		// Delete permanently wipes every bound session in the subtree from engine
		await h.control('session.delete', { id: root.id });

		// Verify 4-tier auto-lower-rank hierarchy (Governor -> Manager -> Employee -> Worker) and Subordinate Query API
		const chainGov = await h.control<IAdeSessionSummary>('session.create', { project: 'Alpha', engine: 'claude', role: 'governor', label: 'Chain Gov', open: false });
		const chainMgr = await h.control<IAdeSessionSummary>('session.create', { parentId: chainGov.id, engine: 'codex', label: 'Chain Mgr', open: false });
		const chainEmp = await h.control<IAdeSessionSummary>('session.create', { parentId: chainMgr.id, engine: 'claude', label: 'Chain Emp', open: false });
		const chainWorker = await h.control<IAdeSessionSummary>('session.create', { parentId: chainEmp.id, engine: 'codex', label: 'Chain Worker', open: false });
		let workerSpawnRejected = false;
		try {
			await h.control('session.create', { parentId: chainWorker.id, engine: 'codex', label: 'Invalid Child', open: false });
		} catch {
			workerSpawnRejected = true;
		}
		const govSubsRes = await h.control<{ count: number; subordinates: IAdeSessionSummary[] }>('session.subordinates', { id: chainGov.id });
		const recursiveSubsRes = await h.control<{ count: number; subordinates: IAdeSessionSummary[] }>('session.subordinates', { id: chainGov.id, recursive: true });
		const workerFilterList = await h.control<IAdeSessionSummary[]>('session.list', { role: 'worker' });

		// Test short engine alias ('claude' -> 'aexus-claude') and multi-path project.add
		const batchProjects = await h.control<IAdeProjectSummary[]>('project.add', { paths: ['/projects/Delta', '/projects/Epsilon'] });
		await h.control('secretary.engine', { engine: 'claude', open: true, side: true });
		const firstSecResource = h.projects.secretary.session?.resource.toString();
		await h.control('secretary.send', { message: 'Summarize workspace status', wait: true });
		await h.control('secretary.reset', { engine: 'codex' });
		const secondSecResource = h.projects.secretary.session?.resource.toString();

		assert.deepStrictEqual({
			addedName: addedProject.name,
			batchAddedNames: batchProjects.map(item => item.name),
			focusedBeta: focusedStatus.navigation.focusedProject?.name,
			canGoForwardAtHome: homeStatus.navigation.canGoForward,
			forwardedTo: forwardedStatus.navigation.focusedProject?.name,
			autoPromotedRootRole: h.renamedResources.length === 1 && renamed.label === 'Core Manager',
			sideOpenRecorded: h.openedLog.some(entry => entry.kind === 'agent' && entry.target === sub.id && entry.side === true),
			sentCount: h.sentChatRequests.length,
			activeWhileArchived: activeListWhileArchived.length,
			activeAfterRestore: activeListAfterRestore.length,
			deletesAfterDetach,
			deletedSubtreeCount: h.deletedResources.length,
			chainRanks: [chainGov.rank, chainMgr.rank, chainEmp.rank, chainWorker.rank],
			workerHasNoRolePrompt: chainWorker.role === undefined && h.resolvePrompt(URI.parse(chainWorker.resource!)) === undefined,
			workerSpawnRejected,
			govDirectSubMeta: govSubsRes.count === 1 ? { rank: govSubsRes.subordinates[0].rank, engineName: govSubsRes.subordinates[0].engineName } : undefined,
			recursiveSubCount: recursiveSubsRes.count,
			workerFilterIds: workerFilterList.map(item => item.id),
			secretaryRotatedOnReset: Boolean(firstSecResource?.startsWith('aexus-claude:') && secondSecResource?.startsWith('aexus-codex:')),
		}, {
			addedName: 'Gamma',
			batchAddedNames: ['Delta', 'Epsilon'],
			focusedBeta: 'Beta',
			canGoForwardAtHome: true,
			forwardedTo: 'Beta',
			autoPromotedRootRole: true,
			sideOpenRecorded: true,
			sentCount: 2,
			activeWhileArchived: 0,
			activeAfterRestore: 2,
			deletesAfterDetach: [],
			deletedSubtreeCount: 2,
			chainRanks: ['governor', 'manager', 'employee', 'worker'],
			workerHasNoRolePrompt: true,
			workerSpawnRejected: true,
			govDirectSubMeta: { rank: 'manager', engineName: 'Codex' },
			recursiveSubCount: 3,
			workerFilterIds: [chainWorker.id],
			secretaryRotatedOnReset: true,
		});
	});

	test('resolves SCM repository roots accurately (including exact rootUri and nested repos) and opens diffs in ADE', async () => {
		const h = createHarness();
		const monoRoot = URI.file('/projects');
		const alphaSub = URI.file('/projects/Alpha');
		const changedFile = URI.file('/projects/Alpha/src/app.ts');
		const headFile = URI.parse('git:/projects/Alpha/src/app.ts?HEAD');

		const makeRepo = (id: string, rootUri: URI, resources: ISCMResource[] = []): ISCMRepository => {
			const group = new class extends mock<ISCMResourceGroup>() {
				override readonly id = 'workingTree';
				override readonly label = 'Changes';
				override readonly hideWhenEmpty = true;
				override readonly resources = resources;
				override readonly onDidChange = Event.None;
				override readonly onDidChangeResources = Event.None;
			}();
			const provider = new class extends mock<ISCMProvider>() {
				override readonly id = id;
				override readonly label = 'Git';
				override readonly name = id;
				override readonly rootUri = rootUri;
				override readonly groups = [group];
				override readonly onDidChangeResourceGroups = Event.None;
				override readonly onDidChangeResources = Event.None;
				override async getOriginalResource() { return headFile; }
			}();
			(group as { provider: ISCMProvider }).provider = provider;
			return new class extends mock<ISCMRepository>() {
				override readonly id = id;
				override readonly provider = provider;
			}();
		};

		const resource = new class extends mock<ISCMResource>() {
			override readonly sourceUri = changedFile;
			override readonly decorations = { tooltip: 'Modified' };
			override readonly command = {
				id: API_OPEN_DIFF_EDITOR_COMMAND_ID,
				title: 'Open Changes',
				arguments: [headFile, changedFile, 'app.ts (Working Tree)'],
			};
			override readonly multiDiffEditorOriginalUri = undefined;
			override readonly multiDiffEditorModifiedUri = undefined;
		}();

		const monoRepo = makeRepo('mono', monoRoot);
		const nestedAlphaRepo = makeRepo('alpha-git', alphaSub, [resource]);
		(resource as { resourceGroup: ISCMResourceGroup }).resourceGroup = nestedAlphaRepo.provider.groups[0];

		const scmStub = new class extends mock<ISCMService>() {
			override readonly repositories = [monoRepo, nestedAlphaRepo];
			override readonly onDidAddRepository = Event.None;
			override readonly onDidRemoveRepository = Event.None;
		}();
		h.instantiation.stub(ISCMService, scmStub);
		const dummyContainer = new class extends mock<ViewContainer>() { override readonly id = 'test.ade.inspector'; }();
		h.instantiation.stub(IViewDescriptorService, {
			getViewLocationById: () => ViewContainerLocation.AuxiliaryBar,
			onDidChangeLocation: Event.None,
			getViewDescriptorById: () => null,
			getViewContainerByViewId: () => dummyContainer,
			getDefaultContainerById: () => dummyContainer,
			getViewContainerModel: () => new class extends mock<IViewContainerModel>() {
				override readonly title = 'Project Inspector';
				override readonly onDidChangeContainerInfo = Event.None;
			}(),
			onDidChangeContainer: Event.None,
		});

		const matchedAlpha = findProjectScmRepository(scmStub, h.instantiation.get(IUriIdentityService), alphaSub);
		await openScmResourceInAde(h.editorsStub, resource, alphaSub);

		// Mount AdeChangesView and verify it renders changed file for Alpha and empty state for Beta
		const host = append(document.body, $('.ade-changes-test-host'));
		store.add({ dispose: () => host.remove() });
		const changesView = store.add(h.instantiation.createInstance(AdeChangesView, {
			id: ADE_CHANGES_VIEW_ID,
			title: 'Changes',
		}));
		changesView.render();
		host.appendChild(changesView.element);
		changesView.orthogonalSize = 260;
		changesView.layout(300);
		h.navigation.selectProject(alpha);
		await changesView.refresh();
		const alphaEmptyHidden = host.querySelector<HTMLElement>('.ade-inspector-empty')?.hidden;

		h.navigation.selectProject(beta);
		await changesView.refresh();
		const betaEmptyText = host.querySelector<HTMLElement>('.ade-inspector-empty')?.textContent;

		assert.deepStrictEqual({
			longestMatchId: matchedAlpha?.id,
			openedDiffs: h.openedDiffs,
			alphaEmptyHidden,
			betaEmptyText,
		}, {
			longestMatchId: 'alpha-git',
			openedDiffs: [{
				original: headFile.toString(),
				modified: changedFile.toString(),
				label: 'app.ts (Working Tree)',
				project: alphaSub.toString(),
			}],
			alphaEmptyHidden: true,
			betaEmptyText: 'No changes in Beta',
		});
	});

	test('renders Secretary bar, Focus single-root scoping, Dual Visual Identity badges, and seamless inline rename in AdeProjectsView', async () => {
		const h = createHarness();
		const onDidChangeLocation = store.add(new Emitter<{ views: never[]; from: ViewContainerLocation; to: ViewContainerLocation }>());
		const dummySidebar = new class extends mock<ViewContainer>() { override readonly id = 'test.ade.sidebar'; }();
		h.instantiation.stub(IViewDescriptorService, {
			getViewLocationById: () => ViewContainerLocation.Sidebar,
			onDidChangeLocation: onDidChangeLocation.event,
			getViewDescriptorById: () => null,
			getViewContainerByViewId: () => dummySidebar,
			getDefaultContainerById: () => dummySidebar,
			getViewContainerModel: () => new class extends mock<IViewContainerModel>() {
				override readonly title = 'Sessions';
				override readonly onDidChangeContainerInfo = Event.None;
			}(),
			onDidChangeContainer: Event.None,
		});

		const host = append(document.body, $('.monaco-workbench.ade-projects-view-test-host'));
		store.add({ dispose: () => host.remove() });
		host.style.width = '280px';
		host.style.height = '500px';

		const view = store.add(h.instantiation.createInstance(AdeProjectsView, {
			id: ADE_PROJECTS_VIEW_ID,
			title: 'Sessions',
		}));
		view.render();
		host.appendChild(view.element);
		view.setVisible(true);
		view.orthogonalSize = 280;
		view.layout(500);
		await view.refresh();

		// Verify empty-workspace state shows New Session & Open Existing Session, while [alpha, beta] workspace syncs 0-session project folders into ADE
		const emptyHarness = createHarness([]);
		emptyHarness.instantiation.stub(IViewDescriptorService, {
			getViewLocationById: () => ViewContainerLocation.Sidebar,
			onDidChangeLocation: onDidChangeLocation.event,
			getViewDescriptorById: () => null,
			getViewContainerByViewId: () => dummySidebar,
			getDefaultContainerById: () => dummySidebar,
			getViewContainerModel: () => new class extends mock<IViewContainerModel>() {
				override readonly title = 'Sessions';
				override readonly onDidChangeContainerInfo = Event.None;
			}(),
			onDidChangeContainer: Event.None,
		});
		const emptyHost = append(document.body, $('.monaco-workbench.ade-empty-view-test-host'));
		store.add({ dispose: () => emptyHost.remove() });
		const emptyView = store.add(emptyHarness.instantiation.createInstance(AdeProjectsView, { id: ADE_PROJECTS_VIEW_ID, title: 'Sessions' }));
		emptyView.render();
		emptyHost.appendChild(emptyView.element);
		emptyView.setVisible(true);
		emptyView.orthogonalSize = 280;
		emptyView.layout(500);
		await emptyView.refresh();
		const initialEmptyButtons = [...emptyHost.querySelectorAll('.ade-projects-empty .monaco-button')].map(btn => btn.textContent);

		const initialFolderRowCount = host.querySelectorAll('.ade-project-row').length;
		const projectMenuIds = view.getProjectContextActions({ uri: alpha, name: 'Alpha' }).map(action => action.id);
		const secretaryIconEl = host.querySelector<SVGSVGElement>('svg.ade-secretary-app-icon');
		const secretaryIconRect = secretaryIconEl?.getBoundingClientRect();
		const iconsIntact = Boolean(
			secretaryIconEl
			&& secretaryIconEl.querySelector('rect')
			&& secretaryIconEl.querySelector('path')
			&& secretaryIconRect?.width === 16
			&& secretaryIconRect?.height === 16
			&& host.querySelector('.ade-secretary-actions .codicon-split-horizontal')
			&& !host.querySelector('.ade-new-session-btn')
			&& host.querySelector('.ade-sidebar-actions .codicon-archive')
		);

		// Add sessions to Alpha -> Alpha auto-expands alongside synced Beta project folder
		const worker = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/w-1') }, 'Pure Task');
		const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/g-1') }, 'Team Governor', { role: 'governor' });
		await view.refresh();

		const homeFolderRowsWithSyncedBeta = host.querySelectorAll('.ade-project-row').length;
		const projectAddIconIntact = Boolean(host.querySelector('.ade-project-row .ade-project-add-btn.codicon.codicon-add'));
		const workerAddBtnHidden = host.querySelector<HTMLElement>('.ade-pure-worker .ade-project-add-btn')?.hidden === true;
		const govAddBtnAria = host.querySelector<HTMLElement>('.ade-orchestrated-agent .ade-project-add-btn')?.getAttribute('aria-label');
		const secretaryPillAtHome = host.querySelector('.ade-secretary-context')?.textContent;

		// Test multi-level session nesting & un-nesting via reparentAgent (and cycle + Worker-target rejection)
		const nestedOk = h.projects.reparentAgent(worker.id, gov.id);
		const cycleRejected = !h.projects.reparentAgent(gov.id, worker.id);
		const nestedParentMatches = h.projects.getAgent(worker.id)?.parentId === gov.id;
		const promotedBackOk = h.projects.reparentAgent(worker.id, undefined);
		const otherSession = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/other-1') }, 'Standalone Two');
		const reparentOntoWorkerRejected = !h.projects.reparentAgent(otherSession.id, worker.id);
		h.projects.removeAgent(otherSession.id);
		await view.refresh();

		// Add a session to Beta too -> still 2 synced root project folders
		h.projects.addSession(beta, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/b-1') }, 'Beta Task');
		await view.refresh();
		const homeFolderRowsWithBeta = host.querySelectorAll('.ade-project-row').length;

		// Focus Alpha -> only 1 root project folder shown and auto-expanded to reveal Worker & Orchestrated Governor badges!
		h.navigation.enterProject(alpha);
		await view.refresh();

		const focusedFolderRows = host.querySelectorAll('.ade-project-row').length;
		const secretaryPillFocused = host.querySelector('.ade-secretary-context')?.textContent;
		const workerBadgeEl = host.querySelector('.ade-pure-worker .ade-role-badge');
		const workerBadgeText = workerBadgeEl?.textContent;
		const workerBadgeVisible = Boolean(workerBadgeEl && !workerBadgeEl.hasAttribute('hidden'));
		const orchestratedBadgeText = host.querySelector('.ade-orchestrated-agent .ade-role-badge')?.textContent;

		// Start seamless inline rename on Pure Worker, trigger background change while editing, then confirm with Enter
		await view.startInlineRename(worker.id);
		const editingActive = view.isEditing;
		h.projects.setAgentStatus(gov.id, 'working');

		const inputEl = host.querySelector<HTMLInputElement>('.ade-tree-edit-host input');
		assert.ok(inputEl, 'Expected InlineEditInputBox input element to be mounted');
		inputEl.value = 'Refined Pure Task';
		inputEl.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
		inputEl.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
		await timeout(10);

		// Narrow sidebar layout check: Inbox/Radio removed, section title and Archive toggle button must fit without overlap
		h.projects.setAgentStatus(worker.id, 'idle', true);
		host.style.width = '175px';
		view.orthogonalSize = 175;
		view.layout(500);
		await view.refresh();
		const hasNoRadioToggle = !host.querySelector('.ade-sidebar-controls .monaco-custom-radio');
		const sectionTitleEl = host.querySelector<HTMLElement>('.ade-sidebar-controls .ade-sidebar-section-title');
		const archiveBtn = host.querySelector<HTMLElement>('.ade-sidebar-actions .codicon-archive');
		const sectionTitleRect = sectionTitleEl?.getBoundingClientRect();
		const archiveRect = archiveBtn?.getBoundingClientRect();
		const narrowControlsNoOverlap = Boolean(
			hasNoRadioToggle
			&& sectionTitleEl?.textContent === 'Projects'
			&& sectionTitleRect && archiveRect
			&& sectionTitleRect.width > 0
			&& archiveRect.width > 0
			&& sectionTitleRect.right <= archiveRect.left
		);
		host.style.width = '280px';
		view.orthogonalSize = 280;
		view.layout(500);

		assert.deepStrictEqual({
			initialEmptyButtons,
			initialFolderRowCount,
			hasRemoveAndDeleteMenu: projectMenuIds.includes('ade.project.remove') && projectMenuIds.includes('ade.project.delete'),
			iconsIntact,
			narrowControlsNoOverlap,
			homeFolderRowsWithSyncedBeta,
			projectAddIconIntact,
			workerAddBtnHidden,
			govAddBtnAria,
			nestedOk,
			cycleRejected,
			reparentOntoWorkerRejected,
			nestedParentMatches,
			promotedBackOk,
			homeFolderRowsWithBeta,
			secretaryPillAtHome,
			focusedFolderRows,
			secretaryPillFocused,
			workerBadgeVisible,
			workerBadgeText,
			orchestratedBadgeText,
			editingActive,
			editingFinished: !view.isEditing,
			renamedLabel: h.projects.getAgent(worker.id)?.label,
			engineRenameSynced: h.executedCommands.some(cmd => cmd.id === 'aexus.agentEngines.rename' && cmd.args[1] === 'Refined Pure Task'),
		}, {
			initialEmptyButtons: ['Add Project Folder...'],
			initialFolderRowCount: 2,
			hasRemoveAndDeleteMenu: true,
			iconsIntact: true,
			narrowControlsNoOverlap: true,
			homeFolderRowsWithSyncedBeta: 2,
			projectAddIconIntact: true,
			workerAddBtnHidden: true,
			govAddBtnAria: 'New Manager Sub-Session...',
			nestedOk: true,
			cycleRejected: true,
			reparentOntoWorkerRejected: true,
			nestedParentMatches: true,
			promotedBackOk: true,
			homeFolderRowsWithBeta: 2,
			secretaryPillAtHome: 'Home',
			focusedFolderRows: 1,
			secretaryPillFocused: 'Focus: Alpha',
			workerBadgeVisible: true,
			workerBadgeText: 'Worker',
			orchestratedBadgeText: 'Governor',
			editingActive: true,
			editingFinished: true,
			renamedLabel: 'Refined Pure Task',
			engineRenameSynced: true,
		});
	});

	test('supports session.tree, session.move hot-swapping, cross-project DnD, and non-recursive AdeExtensionWebviewEditorPane teardown', async () => {
		const h = createHarness();
		const reparentedIds: string[] = [];

		const rootGov = await h.control<IAdeSessionSummary>('session.create', { project: 'Alpha', engine: 'claude', role: 'governor', label: 'Root Gov', open: false });
		const mgrA = await h.control<IAdeSessionSummary>('session.create', { parentId: rootGov.id, engine: 'codex', role: 'manager', label: 'Manager A', open: false });
		const empA = await h.control<IAdeSessionSummary>('session.create', { parentId: mgrA.id, engine: 'claude', role: 'employee', label: 'Employee A', open: false });
		const betaGov = await h.control<IAdeSessionSummary>('session.create', { project: 'Beta', engine: 'antigravity', role: 'governor', label: 'Beta Gov', open: false });

		// Hot-swap Employee A from Alpha's Manager A under Beta Gov via session.move
		const movedEmp = await h.control<IAdeSessionSummary>('session.move', { id: empA.id, parentId: betaGov.id });
		await h.control('session.open', { id: betaGov.id });

		// Omitting id on session.tree / session.subordinates resolves the active editor session (betaGov)
		const activeTree = await h.control<IAdeSessionTreeResult>('session.tree');
		const explicitRootTree = await h.control<IAdeSessionTreeResult>('session.tree', { id: rootGov.id });
		const activeSubs = await h.control<{ count: number; subordinates: IAdeSessionSummary[] }>('session.subordinates');
		const betaPrompt = h.resolvePrompt(URI.parse(betaGov.resource!));

		// Cross-project drag-and-drop test on AdeProjectsDragAndDrop
		const dnd = store.add(new AdeProjectsDragAndDrop(
			h.projects,
			h.navigation,
			id => reparentedIds.push(id),
		));
		const empItem: AdeTreeItem = { kind: 'agent', agent: h.projects.getAgent(empA.id)! };
		const mgrAItem: AdeTreeItem = { kind: 'agent', agent: h.projects.getAgent(mgrA.id)! };
		const alphaFolderItem: AdeTreeItem = { kind: 'project', project: { uri: alpha, name: 'Alpha' } };
		const dragData = new ElementsDragAndDropData<AdeTreeItem>([empItem]);
		const overMgrReaction = dnd.onDragOver(dragData, mgrAItem, 0, ListViewTargetSector.CENTER_TOP);
		dnd.drop(dragData, mgrAItem, 0, ListViewTargetSector.CENTER_TOP);
		const afterDndParent = h.projects.getAgent(empA.id)?.parentId;
		const overAlphaFolderReaction = dnd.onDragOver(new ElementsDragAndDropData<AdeTreeItem>([mgrAItem]), alphaFolderItem, 0, ListViewTargetSector.CENTER_TOP);

		// AdeExtensionWebviewEditorPane teardown safety: simulate MainThreadWebviewsViews calling webviewView.dispose() synchronously inside onDispose
		const overlayEvents = store.add(new Emitter<string | undefined>());
		const mockOverlay = new class extends mock<IOverlayWebview>() {
			override readonly container = $('div.mock-webview-container');
			override readonly onDidUpdateState = overlayEvents.event;
			override state: string | undefined = undefined;
			override claim(): void { }
			override release(): void { }
			override setAnchorElement(): void { }
			override focus(): void { }
			override dispose(): void { }
		}();
		h.instantiation.stub(IWebviewService, new class extends mock<IWebviewService>() {
			override createWebviewOverlay(): IOverlayWebview {
				return mockOverlay;
			}
		}());
		let disposeCallbackInvokedCount = 0;
		h.instantiation.stub(IWebviewViewService, new class extends mock<IWebviewViewService>() {
			override async resolve(_viewType: string, webviewView: WebviewView): Promise<void> {
				const listener = webviewView.onDispose(() => {
					disposeCallbackInvokedCount++;
					listener.dispose();
					webviewView.dispose();
				});
			}
		}());
		h.instantiation.stub(IExtensionService, new class extends mock<IExtensionService>() {
			override async activateByEvent(): Promise<void> { }
		}());

		const agyAgent = h.projects.getAgent(betaGov.id)!;
		const dshAgent = h.projects.addSession(alpha, { engineId: 'aexus-dsh', resource: URI.parse('aexus-dsh:/d1') }, 'DSH Session');
		const inputAgy = store.add(h.instantiation.createInstance(AdeExtensionWebviewEditorInput, agyAgent.id, 'antigravity.panel', 'google.google-antigravity', 'aexus-antigravity'));
		const inputDsh = store.add(h.instantiation.createInstance(AdeExtensionWebviewEditorInput, dshAgent.id, 'dsh.panel', 'fengze233.dsh-vscode-panel', 'aexus-dsh'));

		const groupMock = new class extends mock<IEditorGroup>() { override readonly id = 1; }();
		const pane = store.add(h.instantiation.createInstance(AdeExtensionWebviewEditorPane, groupMock));
		const paneHost = append(document.body, $('.ade-webview-pane-host'));
		store.add({ dispose: () => paneHost.remove() });
		pane.create(paneHost);
		pane.setVisible(true);
		await pane.setInput(inputAgy, undefined, { newInGroup: false }, CancellationToken.None);
		await pane.setInput(inputDsh, undefined, { newInGroup: false }, CancellationToken.None);
		pane.clearInput();
		pane.dispose();

		assert.deepStrictEqual({
			movedParent: movedEmp.parentId,
			movedProject: movedEmp.projectName,
			activeTreeDirect: activeTree.directCount,
			activeTreeTotal: activeTree.totalSubordinates,
			activeTreeChildId: activeTree.root.children[0]?.session.id,
			explicitRootTotal: explicitRootTree.totalSubordinates,
			activeSubsIds: activeSubs.subordinates.map(s => s.id),
			betaPromptHasTree: Boolean(betaPrompt?.includes('Subtree Rooted at You:') && betaPrompt.includes('aexus-ade session tree') && betaPrompt.includes('Employee A')),
			overMgrAccepted: typeof overMgrReaction === 'object' && overMgrReaction.accept === true,
			afterDndParent,
			reparentedIds,
			overAlphaFolderAccepted: typeof overAlphaFolderReaction === 'object' && overAlphaFolderReaction.accept === true,
			disposeCallbackInvokedCount,
		}, {
			movedParent: betaGov.id,
			movedProject: 'Beta',
			activeTreeDirect: 1,
			activeTreeTotal: 1,
			activeTreeChildId: empA.id,
			explicitRootTotal: 1,
			activeSubsIds: [empA.id],
			betaPromptHasTree: true,
			overMgrAccepted: true,
			afterDndParent: mgrA.id,
			reparentedIds: [empA.id],
			overAlphaFolderAccepted: true,
			disposeCallbackInvokedCount: 2,
		});
	});

	test('synchronizes project removal across ADE & IDE and prompts with mode-specific Delete choices', async () => {
		const gamma = URI.file('/projects/Gamma');
		const delta = URI.file('/projects/Delta');
		const epsilon = URI.file('/projects/Epsilon');
		const h = createHarness([alpha, beta, gamma, delta, epsilon]);

		const diskFolders = new Set<string>([alpha.toString(), beta.toString(), gamma.toString(), delta.toString(), epsilon.toString()]);
		const deletedDiskFolders: string[] = [];
		const promptLog: Array<{ buttons: string[]; message: string }> = [];
		const nextChoices: Array<number | 'cancel'> = [];

		h.instantiation.stub(IFileService, new class extends mock<IFileService>() {
			override hasCapability(): boolean { return false; }
			override async exists(resource: URI): Promise<boolean> { return diskFolders.has(resource.toString()); }
			override async del(resource: URI): Promise<void> {
				deletedDiskFolders.push(resource.toString());
				diskFolders.delete(resource.toString());
			}
		}());
		h.instantiation.stub(IWorkingCopyFileService, new class extends mock<IWorkingCopyFileService>() {
			override getDirty() { return []; }
			override async delete(ops: Array<{ resource: URI }>): Promise<void> {
				for (const op of ops) {
					deletedDiskFolders.push(op.resource.toString());
					diskFolders.delete(op.resource.toString());
				}
			}
		}());
		h.instantiation.stub(IDialogService, new class extends mock<IDialogService>() {
			override async prompt<T>(prompt: IPrompt<T>) {
				promptLog.push({
					message: prompt.message,
					buttons: (prompt.buttons ?? []).map(button => button.label),
				});
				const action = nextChoices.shift();
				if (action === 'cancel' || action === undefined) {
					const cancelResult = typeof prompt.cancelButton === 'object' && prompt.cancelButton
						? await prompt.cancelButton.run({ checkboxChecked: false })
						: undefined;
					return { result: cancelResult };
				}
				return { result: await prompt.buttons![action].run({ checkboxChecked: false }) };
			}
		}());
		h.instantiation.stub(IQuickInputService, new class extends mock<IQuickInputService>() { }());

		const alphaAgent = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/p-alpha') }, 'Alpha Lead');
		const betaAgent = h.projects.addSession(beta, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/p-beta') }, 'Beta Lead');
		const gammaAgent = h.projects.addSession(gamma, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/p-gamma') }, 'Gamma Lead');
		const deltaAgent = h.projects.addSession(delta, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/p-delta') }, 'Delta Lead');
		const epsilonAgent = h.projects.addSession(epsilon, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/p-epsilon') }, 'Epsilon Lead');
		h.navigation.enterProject(alpha);

		// 1. Synchronized Remove on Alpha -> removes from both ADE & IDE, closes editors, exits Focus, deletes NO files/sessions
		await h.instantiation.invokeFunction(accessor => removeProjectsSynchronized(accessor, alpha));
		const afterRemove = {
			projects: h.projects.projects.map(p => p.name),
			folders: h.getFolders().map(f => f.name),
			focused: h.navigation.focusedProject,
			closedAlpha: h.closedAgentIds.includes(alphaAgent.id),
			deletedSessionsCount: h.deletedResources.length,
			deletedFilesCount: deletedDiskFolders.length,
		};

		// 2. ADE Delete Prompt -> Cancel on Beta leaves Beta intact
		nextChoices.push('cancel');
		await h.instantiation.invokeFunction(accessor => deleteProjectsWithModePrompt(accessor, 'ade', beta));
		const betaStillIntact = Boolean(h.projects.projects.find(p => p.name === 'Beta') && h.projects.getAgent(betaAgent.id));

		// 3. ADE Delete Prompt -> Option 0 ("&&Delete All Sessions"): deletes sessions ONLY, keeps disk files, removes from both ADE & IDE
		nextChoices.push(0);
		await h.instantiation.invokeFunction(accessor => deleteProjectsWithModePrompt(accessor, 'ade', beta));
		const afterAdeSessionsOnly = {
			deletedResources: [...h.deletedResources],
			deletedProjectSessions: [...h.deletedProjectSessions],
			deletedDiskFolders: [...deletedDiskFolders],
			projects: h.projects.projects.map(p => p.name),
			folders: h.getFolders().map(f => f.name),
		};

		// 4. ADE Delete Prompt -> Option 1 ("Delete Sessions &&and Files"): deletes sessions AND disk folder
		nextChoices.push(1);
		await h.instantiation.invokeFunction(accessor => deleteProjectsWithModePrompt(accessor, 'ade', gamma));
		const afterAdeBoth = {
			gammaSessionDeleted: h.deletedResources.includes(gammaAgent.session!.resource.toString()),
			gammaDiskDeleted: deletedDiskFolders.includes(gamma.toString()),
			gammaGoneInBoth: !h.projects.projects.some(p => p.name === 'Gamma') && !h.getFolders().some(f => f.name === 'Gamma'),
		};

		// 5. IDE Delete Prompt -> Option 0 ("&&Delete All Files"): deletes disk folder ONLY, keeps sessions, removes from both IDE & ADE
		const resBeforeIdeFilesOnly = h.deletedResources.length;
		const projSessBeforeIdeFilesOnly = h.deletedProjectSessions.length;
		nextChoices.push(0);
		await h.instantiation.invokeFunction(accessor => deleteProjectsWithModePrompt(accessor, 'ide', delta));
		const afterIdeFilesOnly = {
			deltaDiskDeleted: deletedDiskFolders.includes(delta.toString()),
			noNewSessionDeletes: h.deletedResources.length === resBeforeIdeFilesOnly && h.deletedProjectSessions.length === projSessBeforeIdeFilesOnly,
			deltaGoneInBoth: !h.projects.projects.some(p => p.name === 'Delta') && !h.getFolders().some(f => f.name === 'Delta'),
		};

		// 6. IDE Delete Prompt -> Option 1 ("Delete All Files &&and Sessions"): deletes disk folder AND sessions
		nextChoices.push(1);
		await h.instantiation.invokeFunction(accessor => deleteProjectsWithModePrompt(accessor, 'ide', epsilon));
		const afterIdeBoth = {
			epsilonDiskDeleted: deletedDiskFolders.includes(epsilon.toString()),
			epsilonSessionDeleted: h.deletedResources.includes(epsilonAgent.session!.resource.toString()) && h.deletedProjectSessions.includes(epsilon.toString()),
			epsilonGoneInBoth: h.projects.projects.length === 0 && h.getFolders().length === 0,
			deltaAgentStillRecordedUntilBoth: Boolean(deltaAgent.session),
		};

		assert.deepStrictEqual({
			afterRemove,
			betaStillIntact,
			adePromptButtons: promptLog[1].buttons,
			idePromptButtons: promptLog[3].buttons,
			afterAdeSessionsOnly,
			afterAdeBoth,
			afterIdeFilesOnly,
			afterIdeBoth,
		}, {
			afterRemove: {
				projects: ['Beta', 'Gamma', 'Delta', 'Epsilon'],
				folders: ['Beta', 'Gamma', 'Delta', 'Epsilon'],
				focused: undefined,
				closedAlpha: true,
				deletedSessionsCount: 0,
				deletedFilesCount: 0,
			},
			betaStillIntact: true,
			adePromptButtons: ['&&Delete All Sessions', 'Delete Sessions &&and Files'],
			idePromptButtons: ['&&Delete All Files', 'Delete All Files &&and Sessions'],
			afterAdeSessionsOnly: {
				deletedResources: [betaAgent.session!.resource.toString()],
				deletedProjectSessions: [beta.toString()],
				deletedDiskFolders: [],
				projects: ['Gamma', 'Delta', 'Epsilon'],
				folders: ['Gamma', 'Delta', 'Epsilon'],
			},
			afterAdeBoth: {
				gammaSessionDeleted: true,
				gammaDiskDeleted: true,
				gammaGoneInBoth: true,
			},
			afterIdeFilesOnly: {
				deltaDiskDeleted: true,
				noNewSessionDeletes: true,
				deltaGoneInBoth: true,
			},
			afterIdeBoth: {
				epsilonDiskDeleted: true,
				epsilonSessionDeleted: true,
				epsilonGoneInBoth: true,
				deltaAgentStillRecordedUntilBoth: true,
			},
		});
	});

	test('automatically reconciles IDE workspace folders across empty Dock windows, stale mirrors, and live bidirectional edits', async () => {
		const apps = URI.file('/Applications');
		const gamma = URI.file('/projects/Gamma');
		const delta = URI.file('/projects/Delta');

		const createReconcileWindow = (initialFolders: readonly URI[], workspaceConfig?: URI, seedCatalog = false) => {
			const instantiation = workbenchInstantiationService(undefined, store);
			const storage = instantiation.get(IStorageService);
			if (seedCatalog) {
				storage.store('aexus.ade.projects', JSON.stringify([
					{ uri: alpha.toString(), name: 'Alpha' },
					{ uri: beta.toString(), name: 'Beta' },
				]), StorageScope.PROFILE, StorageTarget.MACHINE);
				storage.store('aexus.ade.catalogInitialized', true, StorageScope.PROFILE, StorageTarget.MACHINE);
			}
			let folders = initialFolders.map(uri => toWorkspaceFolder(uri));
			const onFoldersChanged = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
			instantiation.stub(IWorkspaceContextService, {
				getWorkbenchState: () => workspaceConfig ? WorkbenchState.WORKSPACE : (folders.length ? WorkbenchState.FOLDER : WorkbenchState.EMPTY),
				getWorkspace: () => new Workspace('reconcile-win', folders, workspaceConfig ?? null),
				onDidChangeWorkspaceFolders: onFoldersChanged.event,
			});
			const nav = store.add(instantiation.createInstance(ProjectNavigationService));
			instantiation.stub(IProjectNavigationService, nav);
			const projects = store.add(instantiation.createInstance(AdeProjectsService));
			instantiation.stub(IAdeProjectsService, projects);

			const workspaceEditing = new class extends mock<IWorkspaceEditingService>() {
				override async removeFolders(uris: URI[]): Promise<void> {
					const uriIdentity = instantiation.get(IUriIdentityService);
					const removed = folders.filter(f => uris.some(u => uriIdentity.extUri.isEqual(f.uri, u)));
					folders = folders.filter(f => !uris.some(u => uriIdentity.extUri.isEqual(f.uri, u)));
					if (removed.length > 0) {
						onFoldersChanged.fire({ added: [], removed, changed: [] });
					}
				}
				override async addFolders(toAdd: { uri: URI }[]): Promise<void> {
					const added = toAdd.map(item => toWorkspaceFolder(item.uri));
					folders = [...folders, ...added];
					if (added.length > 0) {
						onFoldersChanged.fire({ added, removed: [], changed: [] });
					}
				}
			}();
			instantiation.stub(IWorkspaceEditingService, workspaceEditing);
			instantiation.stub(IFileService, new class extends mock<IFileService>() {
				override async exists(): Promise<boolean> { return true; }
			}());

			const runReconcile = () => reconcileIdeWorkspaceWithCatalog({
				projects,
				contextService: instantiation.get(IWorkspaceContextService),
				workspaceEditing,
				environmentService: undefined as unknown as IWorkbenchEnvironmentService,
				fileService: instantiation.get(IFileService),
				uriIdentity: instantiation.get(IUriIdentityService),
			});

			return { projects, workspaceEditing, runReconcile, getFolderNames: () => folders.map(f => f.name) };
		};

		// 1. Empty Dock window (`WorkbenchState.EMPTY`) automatically populates IDE workspace folders from ADE catalog
		const emptyWin = createReconcileWindow([], undefined, true);
		await emptyWin.runReconcile();
		const emptyWinFoldersAfterStartup = emptyWin.getFolderNames();

		// 2. Stale internal mirror workspace with extra `Applications` folder automatically prunes `Applications`
		const staleMirrorConfig = URI.file('/Users/test/Library/Application Support/Aexus Code/Projects/old-win/projects.code-workspace');
		const staleWin = createReconcileWindow([apps, alpha, beta], staleMirrorConfig, true);
		await staleWin.runReconcile();
		const staleWinFoldersAfterStartup = staleWin.getFolderNames();
		const staleWinProjectsAfterStartup = staleWin.projects.projects.map(p => p.name);

		// 3. Live bidirectional sync via projects.onDidChange
		let pendingSync = Promise.resolve();
		store.add(staleWin.projects.onDidChange(kind => {
			if (kind !== 'order') {
				pendingSync = staleWin.runReconcile();
			}
		}));

		// Add in ADE -> IDE gets Gamma
		staleWin.projects.registerProject(gamma, 'Gamma');
		await pendingSync;
		const foldersAfterAdeAdd = staleWin.getFolderNames();

		// Add in IDE -> ADE gets Delta
		await staleWin.workspaceEditing.addFolders([{ uri: delta }]);
		await pendingSync;
		const adeAfterIdeAdd = staleWin.projects.projects.map(p => p.name);

		// Remove in ADE -> IDE removes Gamma
		staleWin.projects.removeProject(gamma);
		await pendingSync;
		const foldersAfterAdeRemove = staleWin.getFolderNames();

		// Remove in IDE -> ADE removes Delta
		await staleWin.workspaceEditing.removeFolders([delta]);
		await pendingSync;
		const adeAfterIdeRemove = staleWin.projects.projects.map(p => p.name);

		assert.deepStrictEqual({
			emptyWinFoldersAfterStartup,
			staleWinFoldersAfterStartup,
			staleWinProjectsAfterStartup,
			foldersAfterAdeAdd,
			adeAfterIdeAdd,
			foldersAfterAdeRemove,
			adeAfterIdeRemove,
		}, {
			emptyWinFoldersAfterStartup: ['Alpha', 'Beta'],
			staleWinFoldersAfterStartup: ['Alpha', 'Beta'],
			staleWinProjectsAfterStartup: ['Alpha', 'Beta'],
			foldersAfterAdeAdd: ['Alpha', 'Beta', 'Gamma'],
			adeAfterIdeAdd: ['Alpha', 'Beta', 'Gamma', 'Delta'],
			foldersAfterAdeRemove: ['Alpha', 'Beta', 'Delta'],
			adeAfterIdeRemove: ['Alpha', 'Beta'],
		});
	});

	test('synchronizes native role snapshots, binds native tabs without duplicates, and reflects active native tab in status', async () => {
		const h = createHarness();
		h.modes.setMode('ade');

		class FakeNativeEditor extends EditorInput {
			readonly resource: URI | undefined = undefined;
			constructor(private readonly name: string, readonly key: string) {
				super();
			}
			override get typeId(): string { return 'workbench.input.fakeNative'; }
			override getName(): string { return this.name; }
			override matches(other: EditorInput): boolean { return other instanceof FakeNativeEditor && other.key === this.key; }
		}

		const editors: EditorInput[] = [];
		let activeEditor: EditorInput | undefined;
		const onActiveChange = store.add(new Emitter<void>());

		const fakeGroup = new class extends mock<IEditorGroup>() {
			override readonly id = 1;
			override get editors(): readonly EditorInput[] { return editors; }
			override get activeEditor(): EditorInput | null { return activeEditor ?? null; }
			override focus(): void { }
		}();
		const fakePart = {
			get activeGroup(): IEditorGroup { return fakeGroup; },
			get groups(): readonly IEditorGroup[] { return [fakeGroup]; },
			findGroup: () => undefined,
			addGroup: () => fakeGroup,
		} as unknown as IEditorPart;
		h.instantiation.stub(IEditorGroupsService, new class extends mock<IEditorGroupsService>() {
			override get mainPart(): IEditorPart { return fakePart; }
		}());

		h.instantiation.stub(IEditorService, new class extends mock<IEditorService>() {
			override readonly onDidActiveEditorChange = onActiveChange.event;
			override get activeEditor(): EditorInput | undefined { return activeEditor; }
			override openEditor = (async (editor: unknown): Promise<undefined> => {
				if (editor instanceof EditorInput) {
					if (!editors.includes(editor)) {
						editors.push(editor);
					}
					activeEditor = editor;
					onActiveChange.fire();
				}
				return undefined;
			}) as IEditorService['openEditor'];
			override async closeEditors(toClose: readonly { readonly editor: EditorInput; readonly groupId: number }[]): Promise<void> {
				for (const item of toClose) {
					const idx = editors.indexOf(item.editor);
					if (idx >= 0) {
						editors.splice(idx, 1);
					}
					if (activeEditor === item.editor) {
						activeEditor = editors.at(-1);
						onActiveChange.fire();
					}
					item.editor.dispose();
				}
			}
		}());

		h.instantiation.stub(IViewsService, new class extends mock<IViewsService>() {
			override closeView(): void { }
		}());
		h.instantiation.stub(IExtensionService, new class extends mock<IExtensionService>() {
			override readonly extensions = [
				{ identifier: new ExtensionIdentifier('anthropic.claude-code') },
			] as never;
			override async activateById(): Promise<void> { }
			override async activateByEvent(): Promise<void> { }
		}());
		h.instantiation.stub(IAdeSessionsService, new class extends mock<IAdeSessionsService>() {
			override getEngineName(engineId: string): string { return engineId === 'aexus-claude' ? 'Claude Code' : engineId; }
			override async getSessionInfo(session: IAdeSession) {
				return { nativeId: session.resource.path.slice(1), provisional: true, unmaterialized: false };
			}
		}());

		const syncedSnapshots: IAdeRoleSyncSnapshot[] = [];
		let claudeOpenCount = 0;
		h.instantiation.stub(ICommandService, new class extends mock<ICommandService>() {
			override async executeCommand<T>(id: string, ...args: unknown[]): Promise<T> {
				if (id === 'aexus.agentEngines.syncRoleContext' && args[0]) {
					syncedSnapshots.push(args[0] as IAdeRoleSyncSnapshot);
					return undefined as T;
				}
				if (id === 'claude-vscode.editor.open') {
					claudeOpenCount++;
					const tab = store.add(new FakeNativeEditor(`Claude Tab ${claudeOpenCount}`, `claude-${claudeOpenCount}`));
					editors.push(tab);
					activeEditor = tab;
					onActiveChange.fire();
					return undefined as T;
				}
				const registered = CommandsRegistry.getCommand(id);
				if (registered) {
					return h.instantiation.invokeFunction(registered.handler, ...args) as T;
				}
				return undefined as T;
			}
		}());

		h.instantiation.stub(IChatSessionsService, new class extends mock<IChatSessionsService>() { }());
		h.instantiation.stub(IAgentHostEnablementService, new class extends mock<IAgentHostEnablementService>() { }());

		const realEditors = store.add(h.instantiation.createInstance(AdeEditorService));
		h.instantiation.stub(IAdeEditorService, realEditors);

		const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/gov-native') }, 'Native Gov', { role: 'governor' });
		const wrk = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/wrk-native') }, 'Native Worker');

		// 1. Opening Governor syncs rolePrompt before opening and binds a unified ChatEditorInput tab
		await realEditors.openAgent(gov.id);
		const preOpenSnapshot = syncedSnapshots.find(s => s.activeAgentId === gov.id && s.agents.some(a => a.id === gov.id));
		const govEntry = preOpenSnapshot?.agents.find(a => a.id === gov.id);
		const wrkEntry = preOpenSnapshot?.agents.find(a => a.id === wrk.id);
		const govTab = activeEditor!;
		const govTabBoundId = realEditors.getAgentIdForEditor(govTab);
		const govSessionActive = realEditors.isSessionActive(gov.session!.resource);
		const statusWhileGovActive = await h.control<IAdeControlStatus>('status');
		const pulledSnapshot = h.instantiation.invokeFunction(CommandsRegistry.getCommand(ADE_GET_ROLE_SYNC_SNAPSHOT_COMMAND_ID)!.handler) as unknown as IAdeRoleSyncSnapshot;
		const editorsAfterGovOpen = editors.length;

		// 2. Re-opening Governor reuses the existing unified tab without ever opening a 3rd-party extension webview
		await realEditors.openAgent(gov.id);
		const claudeCountAfterReopen = claudeOpenCount;
		const editorsAfterReopen = editors.length;
		const activeAfterReopen = activeEditor;

		// 3. Opening Worker opens a distinct unified tab, keeps rolePrompt undefined, and switching tab directly syncs selectedAgentId
		await realEditors.openAgent(wrk.id);
		const wrkTab = activeEditor!;
		const wrkTabBoundId = realEditors.getAgentIdForEditor(wrkTab);
		activeEditor = govTab;
		onActiveChange.fire();
		const selectedAfterSwitchBack = h.projects.selectedAgentId;

		// 4. closeAgents closes the bound unified tab and clears the mapping
		await realEditors.closeAgents([gov]);
		const remainingEditors = editors.map(editor => editor === wrkTab ? 'worker' : 'other');
		await realEditors.closeAgents([wrk]);

		assert.deepStrictEqual({
			govEntryRole: govEntry?.rank,
			govEntryOrchestrated: govEntry?.isOrchestrated,
			govHasRolePrompt: Boolean(govEntry?.rolePrompt?.includes('[Aexus Orchestrated Role Context]') && govEntry.rolePrompt.includes('Role: Governor')),
			wrkEntryOrchestrated: wrkEntry?.isOrchestrated,
			wrkEntryPrompt: wrkEntry?.rolePrompt,
			govTabIsChatEditor: govTab instanceof ChatEditorInput,
			govTabSessionResource: govTab instanceof ChatEditorInput ? govTab.sessionResource?.toString() : undefined,
			govTabBoundId,
			govSessionActive,
			statusKind: statusWhileGovActive.activeEditor?.kind,
			statusAgentId: statusWhileGovActive.activeEditor?.agentId,
			statusRank: statusWhileGovActive.activeEditor?.rank,
			pulledActiveId: pulledSnapshot.activeAgentId,
			claudeCountAfterReopen,
			reopenReusedSameTab: activeAfterReopen === govTab && editorsAfterReopen === editorsAfterGovOpen,
			wrkTabIsChatEditor: wrkTab instanceof ChatEditorInput,
			wrkTabSessionResource: wrkTab instanceof ChatEditorInput ? wrkTab.sessionResource?.toString() : undefined,
			wrkTabBoundId,
			tabsDistinct: govTab !== wrkTab,
			selectedAfterSwitchBack,
			govTabDisposedOnClose: govTab.isDisposed(),
			govBoundClearedAfterClose: realEditors.getAgentIdForEditor(govTab),
			remainingEditors,
			wrkTabDisposedOnClose: wrkTab.isDisposed(),
			editorsAfterWorkerClose: editors.length,
		}, {
			govEntryRole: 'governor',
			govEntryOrchestrated: true,
			govHasRolePrompt: true,
			wrkEntryOrchestrated: false,
			wrkEntryPrompt: undefined,
			govTabIsChatEditor: true,
			govTabSessionResource: 'aexus-claude:/gov-native',
			govTabBoundId: gov.id,
			govSessionActive: true,
			statusKind: 'session',
			statusAgentId: gov.id,
			statusRank: 'governor',
			pulledActiveId: gov.id,
			claudeCountAfterReopen: 0,
			reopenReusedSameTab: true,
			wrkTabIsChatEditor: true,
			wrkTabSessionResource: 'aexus-claude:/wrk-native',
			wrkTabBoundId: wrk.id,
			tabsDistinct: true,
			selectedAfterSwitchBack: gov.id,
			govTabDisposedOnClose: true,
			govBoundClearedAfterClose: undefined,
			remainingEditors: ['worker'],
			wrkTabDisposedOnClose: true,
			editorsAfterWorkerClose: 0,
		});
	});

	test('syncs session preferences into Secretary engine and agent model/thinking while exposing them on the role sync snapshot', async () => {
		const h = createHarness();
		h.modes.setMode('ade');
		const agent = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/prefs-native') }, 'Prefs Agent');
		const syncPreferences = CommandsRegistry.getCommand(ADE_SYNC_SESSION_PREFERENCES_COMMAND_ID)!.handler;

		await h.instantiation.invokeFunction(syncPreferences, { resource: URI.parse('aexus-secretary:/main'), engineId: 'aexus-codex' });
		await h.instantiation.invokeFunction(syncPreferences, { resource: agent.session!.resource, model: 'claude-opus-4', thinking: 'high' });

		const secretary = h.projects.secretary;
		const updatedAgent = h.projects.getAgent(agent.id);
		const snapshot = await h.instantiation.invokeFunction(CommandsRegistry.getCommand(ADE_GET_ROLE_SYNC_SNAPSHOT_COMMAND_ID)!.handler) as unknown as IAdeRoleSyncSnapshot;
		const entry = snapshot.agents.find(item => item.id === agent.id);

		assert.deepStrictEqual({
			secretaryEngineId: secretary.session?.engineId,
			secretaryResource: secretary.session?.resource.toString(),
			agentPreferredModel: updatedAgent?.preferredModel,
			agentPreferredThinking: updatedAgent?.preferredThinking,
			snapshotPreferredModel: entry?.preferredModel,
			snapshotPreferredThinking: entry?.preferredThinking,
		}, {
			secretaryEngineId: 'aexus-codex',
			secretaryResource: 'aexus-secretary:/main',
			agentPreferredModel: 'claude-opus-4',
			agentPreferredThinking: 'high',
			snapshotPreferredModel: 'claude-opus-4',
			snapshotPreferredThinking: 'high',
		});
	});

	test('provides complete ADE control surface for Secretary while strictly blocking Secretary IDE mode switching', async () => {
		const h = createHarness();
		h.modes.setMode('ade');
		h.projects.configureSecretary({ engineId: 'aexus-claude', resource: URI.parse('aexus-secretary:/main') });

		const secPrompt = h.resolvePrompt(URI.parse('aexus-secretary:/main')) ?? '';

		// Secretary caller cannot switch workbench to IDE mode
		let ideSwitchBlocked = false;
		try {
			await h.control('mode.set', { mode: 'ide', caller: 'secretary' });
		} catch {
			ideSwitchBlocked = true;
		}

		// Project select, draft session creation, draft update, session connect, select, close, mark-read, reorder, Secretary draft/markRead/history/stop
		const selectedProj = await h.control<IAdeProjectSummary>('project.select', { name: 'Beta' });
		const draftGov = await h.control<IAdeSessionSummary>('session.create', {
			project: 'Beta',
			role: 'governor',
			title: 'Draft Gov',
			draft: true,
			draftText: 'Initial plan',
			open: false,
		});
		const draftRead = await h.control<{ draft: string }>('session.draft', { id: draftGov.id });
		const connectedGov = await h.control<IAdeSessionSummary>('session.connect', { id: draftGov.id, engine: 'codex', open: false });
		const peerSession = await h.control<IAdeSessionSummary>('session.create', { project: 'Beta', engine: 'claude', role: 'worker', title: 'Peer Worker', open: false });
		await h.control('session.reorder', { id: peerSession.id, before: connectedGov.id, target: connectedGov.id, position: 'before' });
		h.projects.setAgentStatus(connectedGov.id, 'idle', true);
		await h.control('session.markRead', { all: true });
		await h.control('session.select', { id: connectedGov.id });
		await h.control('session.close', { id: connectedGov.id });

		const viewBefore = await h.control<{ showArchived: boolean }>('view.get');
		const viewToggled = await h.control<{ showArchived: boolean }>('view.set', { archived: 'toggle' });
		await h.control('view.set', { archived: false });

		const secDraftSet = await h.control<{ draft: string }>('secretary.draft', { draft: 'Audit ADE hierarchy' });
		const secDraftCleared = await h.control<{ draft: string }>('secretary.draft', { clear: true });
		const secHistory = await h.control<{ configured: boolean; messages: unknown[] }>('secretary.history', { limit: 5 });
		const secStop = await h.control<{ stopped: boolean }>('secretary.stop');
		await h.control('secretary.markRead');

		assert.deepStrictEqual({
			secForbidsIde: secPrompt.includes('Operate STRICTLY inside **ADE**') && !secPrompt.includes('mode set ide'),
			secListsFullCli: secPrompt.includes('project changes') && secPrompt.includes('engine sessions') && secPrompt.includes('session attach') && secPrompt.includes('session connect'),
			ideSwitchBlocked,
			modeRemainedAde: h.modes.mode,
			selectedProjName: selectedProj.name,
			draftCreatedStatus: draftGov.status,
			draftReadText: draftRead.draft,
			connectedEngine: connectedGov.engineId,
			reorderedFirstId: h.projects.agents.filter(a => a.projectUri.toString() === beta.toString())[0]?.id,
			allMarkedRead: h.projects.agents.every(a => !a.unread),
			selectedAgentAfterSelect: h.projects.selectedAgentId,
			closedLogged: h.closedAgentIds.includes(connectedGov.id),
			viewBeforeArchived: viewBefore.showArchived,
			viewToggledArchived: viewToggled.showArchived,
			secDraftSet: secDraftSet.draft,
			secDraftCleared: secDraftCleared.draft,
			secHistoryConfigured: secHistory.configured,
			secStoppedBool: typeof secStop.stopped === 'boolean',
		}, {
			secForbidsIde: true,
			secListsFullCli: true,
			ideSwitchBlocked: true,
			modeRemainedAde: 'ade',
			selectedProjName: 'Beta',
			draftCreatedStatus: 'draft',
			draftReadText: 'Initial plan',
			connectedEngine: 'aexus-codex',
			reorderedFirstId: peerSession.id,
			allMarkedRead: true,
			selectedAgentAfterSelect: connectedGov.id,
			closedLogged: true,
			viewBeforeArchived: false,
			viewToggledArchived: true,
			secDraftSet: 'Audit ADE hierarchy',
			secDraftCleared: '',
			secHistoryConfigured: true,
			secStoppedBool: true,
		});
	});

	test('binds top ViewTitle + button on ADE sidebar to Add Project Folder while keeping session + on project rows', async () => {
		const h = createHarness();
		h.modes.setMode('ade');

		const adeViewTitleNavItems = MenuRegistry.getMenuItems(MenuId.ViewTitle)
			.filter(isIMenuItem)
			.filter(item => item.group === 'navigation' && item.when?.serialize().includes(ADE_PROJECTS_VIEW_ID))
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

		const gamma = URI.file('/projects/Gamma');
		const addFolderCmd = CommandsRegistry.getCommand('workbench.action.ade.addProjectFolder');
		assert.ok(addFolderCmd, 'workbench.action.ade.addProjectFolder must be registered');
		await h.instantiation.invokeFunction(addFolderCmd.handler, gamma);

		assert.deepStrictEqual({
			primaryPlusCommandId: adeViewTitleNavItems[0]?.command.id,
			hasNewSessionInViewTitleNav: adeViewTitleNavItems.some(item => item.command.id === 'workbench.action.ade.newSession'),
			gammaRegistered: h.projects.projects.some(p => p.uri.toString() === gamma.toString()),
			selectedProjectAfterAdd: h.projects.selectedProject?.uri.toString(),
		}, {
			primaryPlusCommandId: 'workbench.action.ade.addProjectFolder',
			hasNewSessionInViewTitleNav: false,
			gammaRegistered: true,
			selectedProjectAfterAdd: gamma.toString(),
		});
	});

	test('aligns sibling folder icons and sibling Agent engine icons (ThemeIcon & SVG, collapsible & childless) at identical X coordinates per tree level', async () => {
		const h = createHarness([alpha, beta]);
		h.modes.setMode('ade');

		// Stub getIcon so Claude returns ThemeIcon (Codicon) and Antigravity returns SVG URI
		const origSessions = h.instantiation.invokeFunction(acc => acc.get(IAdeSessionsService));
		h.instantiation.stub(IAdeSessionsService, {
			...origSessions,
			onDidChangeEngines: Event.None,
			getIcon: (engineId: string) => engineId === 'aexus-antigravity'
				? URI.parse('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>')
				: Codicon.sparkle,
			getEngineName: (id: string) => origSessions.getEngineName(id),
			getEngines: () => origSessions.getEngines(),
			create: (id: string, p: URI) => origSessions.create(id, p),
			list: (id: string, p?: URI) => origSessions.list(id, p),
			rename: (s: IAdeSession, l: string) => origSessions.rename(s, l),
			delete: (s: IAdeSession) => origSessions.delete(s),
		});

		const dummySidebar: ViewContainer = {
			id: 'workbench.view.ade.alignTest',
			title: { value: 'Sessions', original: 'Sessions' },
			icon: Codicon.commentDiscussion,
			ctorDescriptor: undefined!,
			storageId: 'ade.alignTest',
		};
		h.instantiation.stub(IViewDescriptorService, {
			getViewLocationById: () => ViewContainerLocation.Sidebar,
			onDidChangeLocation: Event.None,
			getViewDescriptorById: () => null,
			getViewContainerByViewId: () => dummySidebar,
			getDefaultContainerById: () => dummySidebar,
			getViewContainerModel: () => new class extends mock<IViewContainerModel>() {
				override readonly title = 'Sessions';
				override readonly onDidChangeContainerInfo = Event.None;
			}(),
			onDidChangeContainer: Event.None,
		});

		// Alpha has sessions (collapsible folder); Beta has 0 sessions (childless folder)!
		// Under Alpha: claudeGov has a child (collapsible ThemeIcon session); agyGov has 0 children (childless SVG session)!
		const claudeGov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/c-gov') }, 'Claude Gov', { role: 'governor' });
		const codexSub = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/c-mgr') }, 'Codex Sub', { parentId: claudeGov.id, role: 'manager' });
		h.projects.addSession(alpha, { engineId: 'aexus-antigravity', resource: URI.parse('aexus-antigravity:/a-gov') }, 'Antigravity Gov', { role: 'governor' });

		const host = append(document.body, $('.monaco-workbench.ade-align-test-host'));
		store.add({ dispose: () => host.remove() });
		host.style.width = '280px';
		host.style.height = '500px';

		const view = store.add(h.instantiation.createInstance(AdeProjectsView, { id: ADE_PROJECTS_VIEW_ID, title: 'Sessions' }));
		view.render();
		host.appendChild(view.element);
		// Force Seti-like align-icons-and-twisties class to ensure CSS override holds even when theme lacks folder icons
		host.querySelector('.ade-projects-tree')?.classList.add('align-icons-and-twisties');
		view.setVisible(true);
		view.orthogonalSize = 280;
		view.layout(500);
		await view.refresh();
		await view.revealAgent(codexSub.id);

		const findRowMetrics = (labelText: string) => {
			const row = [...host.querySelectorAll<HTMLElement>('.ade-tree-row')]
				.find(el => el.querySelector('.label-name')?.textContent === labelText);
			assert.ok(row, `Expected row "${labelText}" to be rendered`);
			const iconRect = row.querySelector<HTMLElement>('.ade-tree-item-icon')!.getBoundingClientRect();
			const labelRect = row.querySelector<HTMLElement>('.label-name')!.getBoundingClientRect();
			return {
				iconLeft: Math.round(iconRect.left * 10) / 10,
				iconWidth: Math.round(iconRect.width * 10) / 10,
				labelLeft: Math.round(labelRect.left * 10) / 10,
			};
		};

		const alphaMetrics = findRowMetrics('Alpha');
		const betaMetrics = findRowMetrics('Beta');
		const claudeMetrics = findRowMetrics('Claude Gov');
		const agyMetrics = findRowMetrics('Antigravity Gov');
		const subMetrics = findRowMetrics('Codex Sub');

		const indentStep = claudeMetrics.iconLeft - alphaMetrics.iconLeft;
		assert.deepStrictEqual({
			// Level 0: collapsible folder Alpha vs empty folder Beta align identically
			level0FoldersIconAligned: alphaMetrics.iconLeft === betaMetrics.iconLeft && alphaMetrics.iconWidth === 16 && betaMetrics.iconWidth === 16,
			level0FoldersLabelAligned: alphaMetrics.labelLeft === betaMetrics.labelLeft,
			// Level 1: collapsible ThemeIcon Claude Gov vs childless SVG Antigravity Gov align identically
			level1AgentsIconAligned: claudeMetrics.iconLeft === agyMetrics.iconLeft && claudeMetrics.iconWidth === 16 && agyMetrics.iconWidth === 16,
			level1AgentsLabelAligned: claudeMetrics.labelLeft === agyMetrics.labelLeft,
			// Hierarchy indentation: uniform positive step across levels
			uniformPositiveIndentStep: indentStep > 0 && (subMetrics.iconLeft - claudeMetrics.iconLeft) === indentStep,
		}, {
			level0FoldersIconAligned: true,
			level0FoldersLabelAligned: true,
			level1AgentsIconAligned: true,
			level1AgentsLabelAligned: true,
			uniformPositiveIndentStep: true,
		});
	});

	test('session.remove / session.detach cascade-stop, close tabs, and remove every descendant without deleting engine histories', async () => {
		const h = createHarness();
		h.modes.setMode('ade');

		const makeChain = (prefix: string) => {
			const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse(`aexus-claude:/${prefix}-gov`) }, `${prefix} Governor`, { role: 'governor' });
			const mgr = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse(`aexus-codex:/${prefix}-mgr`) }, `${prefix} Manager`, { parentId: gov.id, role: 'manager' });
			const emp = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse(`aexus-claude:/${prefix}-emp`) }, `${prefix} Employee`, { parentId: mgr.id, role: 'employee' });
			const wrk = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse(`aexus-codex:/${prefix}-wrk`) }, `${prefix} Worker`, { parentId: emp.id });
			return { gov, mgr, emp, wrk };
		};
		const resources = (...agents: IAdeAgent[]) => agents.map(agent => agent.session!.resource.toString());

		// Detach a full Governor -> Manager -> Employee -> Worker tree.
		const detachTree = makeChain('detach');
		await h.control('session.detach', { id: detachTree.gov.id });

		// Remove only the mid-tree Manager -> Employee -> Worker subtree, leaving its Governor intact.
		const removeTree = makeChain('remove');
		await h.control('session.remove', { id: removeTree.mgr.id });

		assert.deepStrictEqual({
			stopped: h.stoppedResources,
			closed: h.closedAgentIds,
			deleted: h.deletedResources,
			remainingIds: h.projects.agents.map(agent => agent.id),
			removeGovernorSurvives: Boolean(h.projects.getAgent(removeTree.gov.id)),
			removeGovernorSubtreeSize: h.projects.getSubtree(removeTree.gov.id).length,
		}, {
			stopped: [
				...resources(detachTree.gov, detachTree.mgr, detachTree.emp, detachTree.wrk),
				...resources(removeTree.mgr, removeTree.emp, removeTree.wrk),
			],
			closed: [
				detachTree.gov.id, detachTree.mgr.id, detachTree.emp.id, detachTree.wrk.id,
				removeTree.mgr.id, removeTree.emp.id, removeTree.wrk.id,
			],
			deleted: [],
			remainingIds: [removeTree.gov.id],
			removeGovernorSurvives: true,
			removeGovernorSubtreeSize: 1,
		});
	});

	test('session.delete tears down the whole multi-level subtree even when one engine history deletion throws', async () => {
		const h = createHarness();
		h.modes.setMode('ade');

		const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/del-gov') }, 'Governor', { role: 'governor' });
		const mgr = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/del-mgr') }, 'Manager', { parentId: gov.id, role: 'manager' });
		const emp = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/del-emp') }, 'Employee', { parentId: mgr.id, role: 'employee' });
		const wrk = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/del-wrk') }, 'Worker', { parentId: emp.id });
		const resources = [gov, mgr, emp, wrk].map(agent => agent.session!.resource.toString());

		// The Employee engine history deletion fails; teardown must still complete for every other member.
		h.deleteFailures.add(resources[2]);

		const result = await h.control<{ deletedIds: string[]; count: number }>('session.delete', { id: gov.id });

		assert.deepStrictEqual({
			deletedIds: result.deletedIds,
			count: result.count,
			stopCalls: h.stoppedResources,
			deleteAttempts: h.deleteAttempts,
			succeededDeletes: h.deletedResources,
			closedIds: h.closedAgentIds,
			remainingIds: h.projects.agents.map(agent => agent.id),
		}, {
			deletedIds: [gov.id, mgr.id, emp.id, wrk.id],
			count: 4,
			stopCalls: resources,
			deleteAttempts: resources,
			succeededDeletes: [resources[0], resources[1], resources[3]],
			closedIds: [gov.id, mgr.id, emp.id, wrk.id],
			remainingIds: [],
		});
	});

	test('first click on an unselected project in AdeProjectsView simultaneously selects it and toggles expand/collapse without resetting on status updates', async () => {
		const h = createHarness();
		const onDidChangeLocation = store.add(new Emitter<{ views: never[]; from: ViewContainerLocation; to: ViewContainerLocation }>());
		const dummySidebar = new class extends mock<ViewContainer>() { override readonly id = 'test.ade.sidebar.click'; }();
		h.instantiation.stub(IViewDescriptorService, {
			getViewLocationById: () => ViewContainerLocation.Sidebar,
			onDidChangeLocation: onDidChangeLocation.event,
			getViewDescriptorById: () => null,
			getViewContainerByViewId: () => dummySidebar,
			getDefaultContainerById: () => dummySidebar,
			getViewContainerModel: () => new class extends mock<IViewContainerModel>() {
				override readonly title = 'Sessions';
				override readonly onDidChangeContainerInfo = Event.None;
			}(),
			onDidChangeContainer: Event.None,
		});

		const alphaAgent = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/click-alpha') }, 'Alpha Session', { role: 'governor' });
		const betaAgent = h.projects.addSession(beta, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/click-beta') }, 'Beta Session', { role: 'governor' });
		h.projects.selectProject(alpha);

		const host = append(document.body, $('.monaco-workbench.ade-projects-click-test-host'));
		store.add({ dispose: () => host.remove() });
		host.style.width = '280px';
		host.style.height = '500px';

		const view = store.add(h.instantiation.createInstance(AdeProjectsView, {
			id: ADE_PROJECTS_VIEW_ID,
			title: 'Sessions',
		}));
		view.render();
		host.appendChild(view.element);
		view.setVisible(true);
		view.orthogonalSize = 280;
		view.layout(500);
		await view.refresh();

		const visibleLabels = () => Array.from(host.querySelectorAll<HTMLElement>('.monaco-list-row .label-name')).map(el => el.textContent?.trim());
		const findProjectRow = (name: string) => Array.from(host.querySelectorAll<HTMLElement>('.monaco-list-row')).find(row =>
			row.querySelector('.ade-project-row') && row.textContent?.includes(name)
		)!;

		const initialVisible = visibleLabels();

		// 1) Alpha is currently selected; Beta is unselected & expanded. First click on Beta's label MUST both select Beta AND collapse Beta immediately!
		const betaLabel = findProjectRow('Beta').querySelector<HTMLElement>('.ade-project-row')!;
		betaLabel.dispatchEvent(new mainWindow.MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 }));
		betaLabel.dispatchEvent(new mainWindow.MouseEvent('mouseup', { bubbles: true, button: 0, detail: 1 }));
		betaLabel.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true, button: 0, detail: 1 }));
		await timeout(20);
		const selectedAfterBetaFirstClick = h.projects.selectedProject?.name;
		const visibleAfterBetaCollapse = visibleLabels();

		// Background session status update on Alpha must NOT wipe out Beta's collapsed state!
		h.projects.syncSessionItem(alphaAgent.session!.resource, { status: 'working' }, false);
		await timeout(20);
		const visibleAfterStatusUpdate = visibleLabels();

		// 2) Select Alpha again (first click on Alpha's twistie must BOTH select Alpha AND collapse Alpha!)
		const alphaTwistie = findProjectRow('Alpha').querySelector<HTMLElement>('.monaco-tl-twistie')!;
		alphaTwistie.dispatchEvent(new mainWindow.MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 }));
		alphaTwistie.dispatchEvent(new mainWindow.MouseEvent('mouseup', { bubbles: true, button: 0, detail: 1 }));
		alphaTwistie.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true, button: 0, detail: 1 }));
		await timeout(20);
		const selectedAfterAlphaTwistieClick = h.projects.selectedProject?.name;
		const visibleAfterAlphaTwistieCollapse = visibleLabels();

		// 3) Now Alpha is selected & Beta is unselected + collapsed. First click on Beta's row MUST both select Beta AND expand Beta immediately!
		const betaRowAgain = findProjectRow('Beta').querySelector<HTMLElement>('.ade-project-row')!;
		betaRowAgain.dispatchEvent(new mainWindow.MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 }));
		betaRowAgain.dispatchEvent(new mainWindow.MouseEvent('mouseup', { bubbles: true, button: 0, detail: 1 }));
		betaRowAgain.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true, button: 0, detail: 1 }));
		await timeout(20);
		const selectedAfterBetaExpandClick = h.projects.selectedProject?.name;
		const visibleAfterBetaExpand = visibleLabels();
		void betaAgent;

		assert.deepStrictEqual({
			initialVisible,
			selectedAfterBetaFirstClick,
			visibleAfterBetaCollapse,
			visibleAfterStatusUpdate,
			selectedAfterAlphaTwistieClick,
			visibleAfterAlphaTwistieCollapse,
			selectedAfterBetaExpandClick,
			visibleAfterBetaExpand,
		}, {
			initialVisible: ['Alpha', 'Alpha Session', 'Beta', 'Beta Session'],
			selectedAfterBetaFirstClick: 'Beta',
			visibleAfterBetaCollapse: ['Alpha', 'Alpha Session', 'Beta'],
			visibleAfterStatusUpdate: ['Alpha', 'Alpha Session', 'Beta'],
			selectedAfterAlphaTwistieClick: 'Alpha',
			visibleAfterAlphaTwistieCollapse: ['Alpha', 'Beta'],
			selectedAfterBetaExpandClick: 'Beta',
			visibleAfterBetaExpand: ['Alpha', 'Beta', 'Beta Session'],
		});
	});
});
