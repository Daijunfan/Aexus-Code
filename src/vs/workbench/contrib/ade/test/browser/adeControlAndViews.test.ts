/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append, Dimension } from '../../../../../base/browser/dom.js';
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
import { AEXUS_SSH_SCHEME, IAdeCloudHost, IAdeCloudHostBackendService } from '../../../../../platform/ade/common/adeCloudHosts.js';
import { ADE_API_LATEST_REVISION } from '../../../../../platform/ade/common/adeApiRegistry.js';
import { IAdeEngineeringBackendService, IAdeInboxItem, IAdeInboxService, resolveAdeInboxSeverity } from '../../../../../platform/ade/common/adeEngineering.js';
import { IAdeOrganizationConfig } from '../../../../../platform/ade/common/adeRoleSchema.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ADE_MODEL_PRICING_OVERRIDES_CONFIG_KEY } from '../../../../../platform/ade/common/adeModelPricing.js';
import { IDialogService, IPrompt } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IFileService, IFileStatWithMetadata } from '../../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, toWorkspaceFolder, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IAgentHostEnablementService } from '../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { API_OPEN_DIFF_EDITOR_COMMAND_ID } from '../../../../browser/parts/editor/editorCommands.js';
import { resolveAdeEngineModelCatalog, resolveAdePickerVendorByName } from '../../../../browser/adeLlmIcon.js';
import { Verbosity } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IViewContainerModel, IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../../common/views.js';
import { IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
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
import {
	ADE_TOGGLE_AUTONOMOUS_MODE_COMMAND_ID,
	AdeAutonomousModeStatusContribution,
} from '../../browser/ade.contribution.js';
import { buildAdeAgentRoleContext } from '../../browser/adeControlHandler.js';
import { AdeConfigEditorPane } from '../../browser/adeConfigEditorPane.js';
import { AdeEditorService, AdeLineageChatEditorInput } from '../../browser/adeEditorService.js';
import { AdeEngineeringEditorInput, AdeEngineeringEditorPane, AdePageVisibilityAnimationGuard } from '../../browser/adeEngineeringEditorPane.js';
import { AdeInboxService } from '../../browser/adeInboxService.js';
import { AdeInboxPanel, formatAdeInboxKindLabel, IAdeInboxMissionBridge } from '../../browser/adeInboxView.js';
import { AdeMissionRuntimeService, IAdeMissionRuntimeService } from '../../browser/adeMissionRuntime.js';
import {
	ADE_MISSION_RECORD_STORAGE_PREFIX,
	ADE_MISSIONS_INDEX_STORAGE_KEY,
	ADE_MISSIONS_LEGACY_STORAGE_KEY,
	AdeMissionStoreService,
	IAdeMissionService,
} from '../../browser/adeMissionStore.js';
import { AdeChangesView, AdeFilesView, findProjectScmRepository, openScmResourceInAde } from '../../browser/adeInspectorViews.js';
import { deleteProjectsWithModePrompt, reconcileIdeWorkspaceWithCatalog, removeProjectsSynchronized } from '../../browser/adeProjectManagement.js';
import { AdeProjectsService } from '../../browser/adeProjectsService.js';
import { AdeProjectsDragAndDrop, AdeProjectsView, AdeTreeItem } from '../../browser/adeProjectsView.js';
import { AdeRoleStudioEditorInput, AdeRoleStudioEditorPane } from '../../browser/adeRoleStudioEditorPane.js';
import { ChatEditorInput } from '../../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { AdeExtensionWebviewEditorInput, AdeExtensionWebviewEditorPane, AdeSessionEditor, AdeSessionEditorInput } from '../../browser/adeSessionEditor.js';
import { IAdeEngineSession, IAdeSessionsService } from '../../browser/adeSessionsService.js';
import { ADE_CHANGES_VIEW_ID, ADE_FILES_VIEW_ID, ADE_OPEN_CONFIG_COMMAND_ID, ADE_PROJECTS_VIEW_ID, ADE_SECRETARY_ID, IAdeAgent, IAdeEditorService, IAdeProjectsService, IAdeSession } from '../../common/ade.js';
import { setAdeDisplayLanguageOverride } from '../../common/adeLocalization.js';
import { AdeRoleSchemaService, IAdeRoleSchemaService } from '../../common/adeRoleSchemaService.js';

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
			getEngineName: engineId => {
				if (engineId === 'aexus-claude') { return 'Claude Code'; }
				if (engineId === 'aexus-antigravity') { return 'Google Antigravity'; }
				if (engineId === 'aexus-dsh') { return 'DeepSeek Harness'; }
				if (engineId === 'aexus-opencode') { return 'OpenCode'; }
				if (engineId === 'aexus-kilo') { return 'Kilo Code'; }
				return 'Codex';
			},
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
			govHasV2Entrypoints: Boolean(
				govContext?.includes('Tier: L1')
				&& govContext?.includes('aexus-ade whoami --json')
				&& govContext?.includes('aexus-ade docs read L1')
				&& govContext?.includes('aexus-ade api update --since 0 --json')
				&& govContext?.includes(`aexus-ade session info ${governor.id} --json`)
				&& !govContext?.includes('NEVER claim that you are "not an employee"')
				&& govByIdContext === govContext
			),
			govAutoGovernor: govContext?.includes('Role: Governor') && govContext?.includes('Backend Manager'),
			govHasSubordinateApi: Boolean(
				govContext?.includes('aexus-ade session subordinates')
				&& govContext?.includes('Backend Manager')
				&& govContext?.includes('Codex')
			),
			mgrShowsSupervisorAndSub: mgrContext?.includes('Supervisor: Platform Lead') && mgrContext?.includes('API Employee') && !mgrContext?.includes('report concise outcomes upward'),
			empShowsSupervisorAndCleanV2: Boolean(
				empContext?.includes('Role: Employee')
				&& empContext?.includes('Tier: L3')
				&& empContext?.includes('Supervisor: Backend Manager')
				&& empContext?.includes('aexus-ade docs read L3')
				&& !empContext?.includes('Employee ≠ Worker')
			),
			secCleanV2AndViewport: Boolean(
				secContext?.includes('[Aexus ADE Live Viewport & Macro Control Context]')
				&& secContext?.includes('aexus-ade whoami --json')
				&& secContext?.includes('aexus-ade docs read L0')
				&& secContext?.includes('aexus-ade api update --since 0 --json')
				&& !secContext?.includes('Employee [L3] ≠ Worker [L4]')
				&& secContext?.includes('Focused Project: Alpha (/projects/Alpha)')
				&& secContext?.includes('Session "Backend Manager"')
				&& secContext?.includes('aexus-ade status --json')
			),
		}, {
			pureIsClean: true,
			govHasRoleHeader: true,
			govHasV2Entrypoints: true,
			govAutoGovernor: true,
			govHasSubordinateApi: true,
			mgrShowsSupervisorAndSub: true,
			empShowsSupervisorAndCleanV2: true,
			secCleanV2AndViewport: true,
		});

		// Audit #1/#10/#11/#12/#16/#18: prompt must stay byte-identical across volatile subordinate status transitions,
		// avoid duplicating Direct Subordinates + Subtree, keep Work-Tree prompts lean & template-aware, and collapse work-tree sub-nodes in Secretary!
		const govPromptBeforeStatusFlip = h.resolvePrompt(governor.session!.resource)!;
		h.projects.setAgentStatus(manager.id, 'working');
		const govPromptAfterStatusFlip = h.resolvePrompt(governor.session!.resource)!;
		const backendMgrOccurrences = govPromptBeforeStatusFlip.split(manager.id).length - 1;

		const wtGov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/wt-gov') }, 'WT Governor', { role: 'governor' });
		h.projects.setAgentWorkTreeTag?.(wtGov.id, 'mission');
		const synced = h.projects.syncMissionMermaidEmployees?.(wtGov.id, [{ id: 'N1', title: 'Task N1', nodeIds: ['N1'] }]);
		const wtEmp = synced?.employeeAgentsByNode.N1;
		assert.ok(wtEmp, 'Mission sync should generate in-graph employee session under owner');
		h.projects.setAgentRole(wtEmp!.id, 'employee', { allowLockedMissionEmployee: true });
		const wtGovPrompt = h.resolvePrompt({ agentId: wtGov.id })!;
		const wtEmpPrompt = h.resolvePrompt({ agentId: wtEmp!.id })!;
		const wtEmpDelta = h.resolvePrompt({ agentId: wtEmp!.id, mode: 'delta' });
		const secWithWt = h.resolvePrompt(URI.parse('aexus-claude:/sec-live'))!;

		assert.deepStrictEqual({
			cacheStableAcrossStatusChange: govPromptBeforeStatusFlip === govPromptAfterStatusFlip,
			noDuplicateDirectSubordinates: backendMgrOccurrences === 1,
			wtGovHasLiveMissionCli: wtGovPrompt.includes('aexus-ade mission blueprint apply') && !wtGovPrompt.includes('engineering template'),
			wtGovOmitsSubtreeDump: !wtGovPrompt.includes(wtEmp!.id),
			wtEmpOmitsSubordinateSessionApi: !wtEmpPrompt.includes('aexus-ade session subordinates'),
			wtEmpUsesTokenBus: wtEmpPrompt.includes('[Aexus ADE · Mission Node Employee]') && wtEmpPrompt.includes('aexus-ade token complete'),
			wtDeltaIsUndefined: wtEmpDelta === undefined,
			secCollapsesManagedTreeNodes: secWithWt.includes('managed Mission employee(s)') && !secWithWt.includes(wtEmp!.id),
		}, {
			cacheStableAcrossStatusChange: true,
			noDuplicateDirectSubordinates: true,
			wtGovHasLiveMissionCli: true,
			wtGovOmitsSubtreeDump: true,
			wtEmpOmitsSubordinateSessionApi: true,
			wtEmpUsesTokenBus: true,
			wtDeltaIsUndefined: true,
			secCollapsesManagedTreeNodes: true,
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
			governorFullHasFullManual: governorFull?.includes('Authorized Aexus-Code Primitive APIs'),
			governorDeltaIsHierarchySummary: governorDelta?.startsWith('[ADE Live Hierarchy State]'),
			governorDeltaShowsSubordinate: governorDelta?.includes(`Delta Manager (${manager.id}, Manager)`),
			governorDeltaOmitsFullManual: !governorDelta?.includes('Authorized Aexus-Code Primitive APIs'),
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

	test('executes cloud-host control actions for aexus-ssh project.changes, engine.list projectUri forwarding, and host.upsert alias migration', async () => {
		const h = createHarness();
		const cloudProjectUri = 'aexus-ssh://gpu1/workspace/repo';
		const existingHost: IAdeCloudHost = {
			id: 'host-1',
			name: 'GPU Host',
			alias: 'gpu-old',
			hostName: 'gpu.example.com',
			port: 22,
			os: 'linux',
			recentDirectories: ['/workspace'],
			source: 'user',
			createdAt: 1,
			updatedAt: 2,
		};
		const remoteGitStatusCalls: Array<{ authority: string; projectPath: string }> = [];
		const upsertCalls: Array<{ id?: string; name?: string; alias?: string; hostName?: string }> = [];
		const migratedAliases: Array<{ from: string; to: string }> = [];

		h.instantiation.stub(IAdeCloudHostBackendService, upcastPartial<IAdeCloudHostBackendService>({
			_serviceBrand: undefined,
			onDidChangeHosts: Event.None,
			getHost: async () => existingHost,
			upsertHost: async input => {
				upsertCalls.push(input);
				return { ...existingHost, ...input, alias: input.alias ?? existingHost.alias };
			},
			remoteGitStatus: async (authority, projectPath) => {
				remoteGitStatusCalls.push({ authority, projectPath });
				return [
					{ relativePath: 'src/staged.ts', status: 'M', staged: true },
					{ relativePath: 'src/removed.ts', status: 'D', staged: false },
				];
			},
		}));

		const engineListCalls: Array<{ projectUri?: string; forceRefresh: boolean }> = [];
		h.instantiation.stub(IAdeSessionsService, upcastPartial<IAdeSessionsService>({
			_serviceBrand: undefined,
			getEngines: async (projectUri, options) => {
				engineListCalls.push({ projectUri: projectUri?.toString(), forceRefresh: options?.forceRefresh === true });
				return [{ id: 'aexus-claude', name: 'Claude Code', description: 'Anthropic Claude Code CLI', icon: Codicon.hubot }];
			},
		}));

		h.projects.migrateCloudHostAlias = (from, to) => {
			migratedAliases.push({ from, to });
			return 1;
		};

		const changes = await h.control<{
			project: string;
			totalChanges: number;
			groups: Array<{ id: string; label: string; count: number; resources: Array<{ path: string; relativePath: string; status: string; deleted: boolean }> }>;
		}>('project.changes', { target: cloudProjectUri });

		const engines = await h.control<Array<{ id: string; shortId: string }>>('engine.list', { project: cloudProjectUri, forceRefresh: true });

		const savedHost = await h.control<{ alias: string }>('host.upsert', { id: 'host-1', alias: 'gpu-new', host: 'gpu.example.com' });

		const invalidations = h.executedCommands
			.filter(command => command.id === 'aexus.agentEngines.invalidateCloudHost')
			.map(command => command.args);

		assert.deepStrictEqual({
			remoteGitStatusCalls,
			changesProject: changes.project,
			changesTotal: changes.totalChanges,
			changeGroups: changes.groups.map(group => ({
				id: group.id,
				label: group.label,
				count: group.count,
				resources: group.resources.map(resource => `${resource.relativePath}:${resource.status}:${resource.deleted}:${resource.path}`),
			})),
			engineListCalls,
			engines: engines.map(engine => `${engine.id}/${engine.shortId}`),
			savedAlias: savedHost.alias,
			upsert: upsertCalls.length === 1
				? { id: upsertCalls[0].id, name: upsertCalls[0].name, alias: upsertCalls[0].alias, hostName: upsertCalls[0].hostName }
				: upsertCalls,
			migratedAliases,
			invalidations,
		}, {
			remoteGitStatusCalls: [{ authority: 'gpu1', projectPath: '/workspace/repo' }],
			changesProject: 'repo',
			changesTotal: 2,
			changeGroups: [
				{ id: 'index', label: 'Staged Changes', count: 1, resources: ['src/staged.ts:M:false:gpu1:/workspace/repo/src/staged.ts'] },
				{ id: 'workingTree', label: 'Changes', count: 1, resources: ['src/removed.ts:D:true:gpu1:/workspace/repo/src/removed.ts'] },
			],
			engineListCalls: [{ projectUri: cloudProjectUri, forceRefresh: true }],
			engines: ['aexus-claude/claude'],
			savedAlias: 'gpu-new',
			upsert: { id: 'host-1', name: 'GPU Host', alias: 'gpu-new', hostName: 'gpu.example.com' },
			migratedAliases: [{ from: 'gpu-old', to: 'gpu-new' }],
			invalidations: [['gpu-old', 'gpu-new']],
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
			hasRemoveAndDeleteMenu: projectMenuIds.includes('ade.project.remove') && projectMenuIds.includes('ade.project.delete') && projectMenuIds.includes('ade.project.rename'),
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
			initialEmptyButtons: ['Add Project Folder...', 'Manage SSH Cloud Hosts...', 'Open Secretary'],
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

	test('renders 4-tier Org-Chart Deck tree channels, recycled lock hygiene, Cloud Host chip, sticky Focus banner, and Critical Inbox tab badge', async () => {
		const cloudProject = URI.from({ scheme: AEXUS_SSH_SCHEME, authority: 'gpu-a100', path: '/workspace/CloudRepo' });
		const ubuntuProject = URI.from({ scheme: AEXUS_SSH_SCHEME, authority: 'ubuntu-target1', path: '/home/lab' });
		const ubuntuSameName = URI.from({ scheme: AEXUS_SSH_SCHEME, authority: 'ubuntu-target1', path: '/home/ubuntu-target1' });
		const kaliProject = URI.from({ scheme: AEXUS_SSH_SCHEME, authority: 'kali-Linux1', path: '/home/kali' });
		const winProject = URI.from({ scheme: AEXUS_SSH_SCHEME, authority: 'BUPT-Windows', path: '/C:/Users/djf' });
		const h = createHarness([alpha, cloudProject, ubuntuProject, ubuntuSameName, kaliProject, winProject]);
		h.modes.setMode('ade');

		const lockedIds = new Set<string>();
		const origProjects = h.projects;
		origProjects.isLockedByWorkTree = (id: string) => lockedIds.has(id);

		const onInboxChanged = store.add(new Emitter<void>());
		let inboxItems: IAdeInboxItem[] = [];
		const inboxStub = new class extends mock<IAdeInboxService>() {
			override get items(): readonly IAdeInboxItem[] { return inboxItems; }
			override get unreadCount(): number { return inboxItems.filter(i => i.unread && !i.resolved).length; }
			override readonly onDidChange = onInboxChanged.event;
			override list(opts?: { includeResolved?: boolean }): readonly IAdeInboxItem[] {
				return opts?.includeResolved ? inboxItems : inboxItems.filter(i => !i.resolved);
			}
		}();
		h.instantiation.stub(IAdeInboxService, inboxStub);

		const editorState: { current?: EditorInput } = {};
		const onActiveEditorChange = store.add(new Emitter<void>());
		h.instantiation.stub(IEditorService, new class extends mock<IEditorService>() {
			override readonly onDidActiveEditorChange = onActiveEditorChange.event;
			override get activeEditor(): EditorInput | undefined { return editorState.current; }
		}());

		const dummySidebar = new class extends mock<ViewContainer>() { override readonly id = 'test.ade.deck'; }();
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

		const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/deck-gov') }, 'Gov Root', { role: 'governor' });
		h.projects.setAgentWorkTreeTag?.(gov.id, 'engineering');
		const mgr = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/deck-mgr') }, 'Mgr Lead', { parentId: gov.id, role: 'manager' });
		const emp = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/deck-emp') }, 'Emp Reviewer', { parentId: mgr.id, role: 'employee' });
		const wrk = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/deck-wrk') }, 'Wrk Leaf', { parentId: emp.id });
		h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/deck-free') }, 'Unlocked Worker');
		lockedIds.add(mgr.id);

		const host = append(document.body, $('.monaco-workbench.ade-deck-view-test-host'));
		store.add({ dispose: () => host.remove() });
		host.style.width = '280px';
		host.style.height = '600px';

		const view = store.add(h.instantiation.createInstance(AdeProjectsView, { id: ADE_PROJECTS_VIEW_ID, title: 'Sessions' }));
		view.render();
		host.appendChild(view.element);
		view.setVisible(true);
		view.orthogonalSize = 280;
		view.layout(600);
		await view.refresh();
		await view.revealAgent(wrk.id);

		const findRow = (labelText: string) => [...host.querySelectorAll<HTMLElement>('.ade-tree-row')]
			.find(el => el.querySelector('.label-name')?.textContent === labelText)!;

		const govRow = findRow('Gov Root');
		const mgrRow = findRow('Mgr Lead');
		const empRow = findRow('Emp Reviewer');
		const wrkRow = findRow('Wrk Leaf');
		const freeRow = findRow('Unlocked Worker');
		const cloudRow = findRow('CloudRepo');
		const alphaRow = findRow('Alpha');
		const ubuntuRow = findRow('lab');
		const ubuntuSameRow = findRow('ubuntu-target1');
		const kaliRow = findRow('kali');
		const winRow = findRow('djf');

		const viewBody = host.querySelector<HTMLElement>('.ade-projects-view-body')!;
		const badgesToggleBtn = host.querySelector<HTMLButtonElement>('.ade-badges-toggle-btn')!;
		const smartCalmDefaultCompact = !viewBody.classList.contains('ade-badges-expanded')
			&& badgesToggleBtn.getAttribute('aria-pressed') === 'false';
		badgesToggleBtn.click();
		const smartCalmExpandedOnClick = viewBody.classList.contains('ade-badges-expanded')
			&& badgesToggleBtn.getAttribute('aria-pressed') === 'true';
		badgesToggleBtn.click();
		const smartCalmCompactAfterSecondClick = !viewBody.classList.contains('ade-badges-expanded')
			&& badgesToggleBtn.getAttribute('aria-pressed') === 'false';

		const rowSnapshot = {
			govTier: govRow.querySelector('.ade-role-badge')?.getAttribute('data-tier'),
			govBadgeText: govRow.querySelector('.ade-role-badge')?.textContent,
			govBadgeHasOrgIcon: Boolean(govRow.querySelector('.ade-role-badge .codicon-organization')),
			govWorktreeText: govRow.querySelector('.ade-worktree-badge')?.textContent,
			govChildRank: govRow.getAttribute('data-child-rank'),
			mgrLocked: mgrRow.classList.contains('ade-worktree-locked') && !mgrRow.querySelector<HTMLElement>('.ade-lock-glyph')!.hidden,
			mgrBadgeLocked: Boolean(mgrRow.querySelector('.ade-role-badge.locked')),
			mgrChildRank: mgrRow.getAttribute('data-child-rank'),
			empTier: empRow.querySelector('.ade-role-badge')?.getAttribute('data-tier'),
			empBadgeText: empRow.querySelector('.ade-role-badge')?.textContent,
			empHasShieldIcon: Boolean(empRow.querySelector('.ade-role-badge .codicon-shield')),
			empChildRank: empRow.getAttribute('data-child-rank'),
			empChildLabel: empRow.getAttribute('data-child-label'),
			wrkTier: wrkRow.querySelector('.ade-role-badge')?.getAttribute('data-tier'),
			wrkBadgeText: wrkRow.querySelector('.ade-role-badge')?.textContent,
			wrkDepthClass: wrkRow.classList.contains('depth-4'),
			freeNotLocked: !freeRow.classList.contains('ade-worktree-locked') && freeRow.querySelector<HTMLElement>('.ade-lock-glyph')!.hidden,
			cloudChipText: cloudRow.querySelector('.ade-cloud-host-badge')?.textContent,
			cloudHasDot: Boolean(cloudRow.querySelector('.ade-cloud-host-badge .ade-cloud-host-dot')),
			cloudDistinctNotSame: !cloudRow.querySelector('.ade-cloud-host-badge')?.classList.contains('is-same-as-name'),
			cloudSameNameFlagged: Boolean(ubuntuSameRow.querySelector('.ade-cloud-host-badge')?.classList.contains('is-same-as-name')),
			smartCalmDefaultCompact,
			smartCalmExpandedOnClick,
			smartCalmCompactAfterSecondClick,
			localProjectOsHasSvg: Boolean(alphaRow.querySelector('.ade-tree-item-icon-os svg')),
			ubuntuProjectOs: ubuntuRow.querySelector('.ade-tree-item-icon-os')?.getAttribute('data-os'),
			kaliProjectOs: kaliRow.querySelector('.ade-tree-item-icon-os')?.getAttribute('data-os'),
			winProjectOs: winRow.querySelector('.ade-tree-item-icon-os')?.getAttribute('data-os'),
			genericCloudOs: cloudRow.querySelector('.ade-tree-item-icon-os')?.getAttribute('data-os'),
			agentHasNoOsSvg: !govRow.querySelector('.ade-tree-item-icon')?.hasAttribute('data-os') && !govRow.querySelector('.ade-tree-item-icon svg'),
			cloudHiddenRoleBadgeDisplay: mainWindow.getComputedStyle(cloudRow.querySelector<HTMLElement>('.ade-role-badge')!).display,
			cloudHiddenWorktreeBadgeDisplay: mainWindow.getComputedStyle(cloudRow.querySelector<HTMLElement>('.ade-worktree-badge')!).display,
			localProjectHiddenRoleBadgeDisplay: mainWindow.getComputedStyle(alphaRow.querySelector<HTMLElement>('.ade-role-badge')!).display,
			hiddenStatusDotDisplay: mainWindow.getComputedStyle(freeRow.querySelector<HTMLElement>('.ade-status-dot')!).display,
		};

		// Hygiene F1: clear lock on Mgr Lead and refresh -> recycled row MUST shed ade-worktree-locked and hide lock glyph
		lockedIds.clear();
		await view.refresh();
		const mgrUnlockedAfterRecycle = !findRow('Mgr Lead').classList.contains('ade-worktree-locked')
			&& findRow('Mgr Lead').querySelector<HTMLElement>('.ade-lock-glyph')!.hidden;

		// Secretary active bar + working chip + unread dot
		const secResource = URI.parse('aexus-secretary:/sec-deck');
		h.projects.configureSecretary({ engineId: 'aexus-claude', resource: secResource });
		h.projects.syncSessionItem(secResource, { status: 'working' }, false);
		h.projects.syncSessionItem(secResource, { status: 'idle' }, false);
		const secUnreadVisible = !host.querySelector<HTMLElement>('.ade-secretary-bar .ade-status-dot')!.hidden;
		const secEditor = store.add(h.instantiation.createInstance(AdeSessionEditorInput, ADE_SECRETARY_ID));
		editorState.current = secEditor;
		onActiveEditorChange.fire();
		h.projects.syncSessionItem(secResource, { status: 'working' }, true);
		const secBar = host.querySelector<HTMLElement>('.ade-secretary-bar')!;
		const secretaryActiveWorking = secUnreadVisible
			&& secBar.classList.contains('is-active')
			&& secBar.classList.contains('is-working')
			&& !secBar.querySelector<HTMLElement>('.ade-secretary-status-chip')!.hidden
			&& Boolean(secBar.querySelector('.ade-secretary-icon-wrap svg.ade-secretary-app-icon'));

		// Focus mode sticky banner outside .ade-sidebar-controls + Exit button returns Home
		const bannerBeforeFocusHidden = host.querySelector<HTMLElement>('.ade-focus-banner')!.hidden;
		h.navigation.enterProject(cloudProject);
		await view.refresh();
		const focusBanner = host.querySelector<HTMLElement>('.ade-focus-banner')!;
		const bannerInControls = Boolean(host.querySelector('.ade-sidebar-controls .ade-focus-banner'));
		const focusBannerVisibleWithCloud = !focusBanner.hidden
			&& focusBanner.querySelector('.ade-focus-banner-name')?.textContent === 'CloudRepo'
			&& focusBanner.querySelector('.ade-focus-banner-host')?.textContent === 'Cloud: gpu-a100';
		focusBanner.querySelector<HTMLButtonElement>('.ade-focus-banner-exit')!.click();
		await view.refresh();
		const bannerHiddenAfterExit = focusBanner.hidden && !h.navigation.focusedProject;

		// Critical Circuit-Breaker item turns Inbox tab badge critical
		inboxItems = [{
			id: 'cb-1',
			kind: 'governor_message',
			treeType: 'engineering',
			governorSessionId: gov.id,
			governorLabel: gov.label,
			projectPath: alpha.fsPath,
			projectName: 'Alpha',
			nodeId: 'N3',
			nodeTitle: 'Auth Service',
			title: 'Circuit Breaker on N3',
			message: '3 formal failures.',
			unread: false,
			resolved: false,
			createdAt: Date.now(),
		}];
		onInboxChanged.fire();
		const inboxBadge = host.querySelector<HTMLElement>('.ade-inbox-count-badge')!;
		const criticalBadgeRedEvenWhenRead = !inboxBadge.hidden && inboxBadge.classList.contains('critical') && inboxBadge.textContent === '1';

		assert.deepStrictEqual({
			...rowSnapshot,
			mgrUnlockedAfterRecycle,
			secretaryActiveWorking,
			bannerBeforeFocusHidden,
			bannerInControls,
			focusBannerVisibleWithCloud,
			bannerHiddenAfterExit,
			criticalBadgeRedEvenWhenRead,
		}, {
			govTier: 'L1',
			govBadgeText: 'Governor',
			govBadgeHasOrgIcon: true,
			govWorktreeText: 'Mission',
			govChildRank: 'manager',
			mgrLocked: true,
			mgrBadgeLocked: true,
			mgrChildRank: 'employee',
			empTier: 'L3',
			empBadgeText: 'Employee',
			empHasShieldIcon: true,
			empChildRank: 'worker',
			empChildLabel: '→ Worker',
			wrkTier: 'L4',
			wrkBadgeText: 'Worker',
			wrkDepthClass: true,
			freeNotLocked: true,
			cloudChipText: 'gpu-a100',
			cloudHasDot: true,
			cloudDistinctNotSame: true,
			cloudSameNameFlagged: true,
			smartCalmDefaultCompact: true,
			smartCalmExpandedOnClick: true,
			smartCalmCompactAfterSecondClick: true,
			localProjectOsHasSvg: true,
			ubuntuProjectOs: 'ubuntu',
			kaliProjectOs: 'kali',
			winProjectOs: 'windows',
			genericCloudOs: 'linux',
			agentHasNoOsSvg: true,
			cloudHiddenRoleBadgeDisplay: 'none',
			cloudHiddenWorktreeBadgeDisplay: 'none',
			localProjectHiddenRoleBadgeDisplay: 'none',
			hiddenStatusDotDisplay: 'none',
			mgrUnlockedAfterRecycle: true,
			secretaryActiveWorking: true,
			bannerBeforeFocusHidden: true,
			bannerInControls: false,
			focusBannerVisibleWithCloud: true,
			bannerHiddenAfterExit: true,
			criticalBadgeRedEvenWhenRead: true,
		});
	});

	test('groups ADE Inbox into Critical / Needs Decision / Updates / Resolved lanes with clickable lineage, clamp, and Circuit-Breaker actions', async () => {
		const h = createHarness([alpha]);
		const onInboxChanged = store.add(new Emitter<void>());
		const openedCanvases: string[] = [];
		const resolvedIds: string[] = [];
		let gateShouldThrow = true;

		const items: IAdeInboxItem[] = [
			{
				id: 'info-1',
				kind: 'governor_message',
				treeType: 'engineering',
				governorSessionId: 'gov-1',
				governorLabel: 'Alpha Gov',
				projectPath: alpha.fsPath,
				projectName: 'Alpha',
				title: 'Milestone status note',
				message: 'Line 1\nLine 2\nLine 3\nLine 4 extra details beyond three lines for message clamping.',
				unread: true,
				resolved: false,
				createdAt: Date.now() - 5000,
			},
			{
				id: 'gate-1',
				kind: 'user_gate',
				treeType: 'engineering',
				governorSessionId: 'gov-1',
				governorLabel: 'Alpha Gov',
				projectPath: alpha.fsPath,
				projectName: 'Alpha',
				nodeId: 'U1',
				nodeTitle: 'Release Signoff',
				title: 'User Acceptance Gate: [U1] Release Signoff',
				message: 'Ready for review.',
				unread: true,
				resolved: false,
				createdAt: Date.now() - 3000,
			},
			{
				id: 'crit-1',
				kind: 'governor_message',
				treeType: 'engineering',
				governorSessionId: 'gov-1',
				governorLabel: 'Alpha Gov',
				projectPath: alpha.fsPath,
				projectName: 'Alpha',
				nodeId: 'N3',
				nodeTitle: 'DB Migration',
				title: 'Escalation after halt',
				message: 'Circuit breaker tripped on N3.',
				severity: 'critical',
				unread: true,
				resolved: false,
				createdAt: Date.now() - 1000,
			},
			{
				id: 'done-1',
				kind: 'governor_message',
				treeType: 'engineering',
				governorSessionId: 'gov-1',
				governorLabel: 'Alpha Gov',
				projectPath: alpha.fsPath,
				projectName: 'Alpha',
				title: 'Earlier note',
				message: 'Already handled.',
				unread: false,
				resolved: true,
				resolution: 'Acknowledged',
				createdAt: Date.now() - 20_000,
			},
		];

		const inboxStub = new class extends mock<IAdeInboxService>() {
			override get items(): readonly IAdeInboxItem[] { return items; }
			override get unreadCount(): number { return items.filter(i => i.unread && !i.resolved).length; }
			override readonly onDidChange = onInboxChanged.event;
			override list(opts?: { includeResolved?: boolean }): readonly IAdeInboxItem[] {
				return opts?.includeResolved ? items : items.filter(i => !i.resolved);
			}
			override async markRead(): Promise<void> { }
			override async resolveItem(id: string): Promise<IAdeInboxItem | undefined> {
				resolvedIds.push(id);
				return items.find(i => i.id === id);
			}
		}();
		const engStub: IAdeInboxMissionBridge = {
			listTrees() {
				return [{ governorSessionId: 'gov-1', updatedAt: Date.now() }];
			},
			async openEngineeringEditor(govId: string): Promise<void> {
				openedCanvases.push(govId);
			},
			async submitGateVerdict(): Promise<never> {
				if (gateShouldThrow) {
					throw new Error('Backend gate timeout');
				}
				return undefined as never;
			},
		};

		const host = append(document.body, $('.monaco-workbench.ade-inbox-lanes-test-host'));
		store.add({ dispose: () => host.remove() });
		const panel = store.add(new AdeInboxPanel(host, inboxStub, engStub, h.editorsStub));

		const pendingLaneOrder = [...panel.element.querySelectorAll('.ade-inbox-lane-header .ade-inbox-lane-title')].map(el => el.textContent);
		const cardOrder = [...panel.element.querySelectorAll<HTMLElement>('.ade-inbox-card[data-inbox-id]')].map(el => el.getAttribute('data-inbox-id'));
		const criticalPrimaryText = panel.element.querySelector('[data-inbox-id="crit-1"] .ade-inbox-btn.danger')?.textContent;
		const gateApproveIncludesApprove = Boolean(panel.element.querySelector('[data-inbox-id="gate-1"] .ade-inbox-btn.primary')?.textContent?.includes('Approve'));

		// Clickable lineage jumps to canvas
		panel.element.querySelector<HTMLButtonElement>('[data-inbox-id="crit-1"] button.ade-inbox-lineage')!.click();

		// Message clamp + More toggle
		const infoMsgClampedInitially = Boolean(panel.element.querySelector('[data-inbox-id="info-1"] .ade-inbox-card-message.clamped'));
		panel.element.querySelector<HTMLButtonElement>('[data-inbox-id="info-1"] .ade-inbox-more')!.click();
		const infoMsgExpandedAfterMore = !panel.element.querySelector('[data-inbox-id="info-1"] .ade-inbox-card-message.clamped');

		// Gate error renders styled .ade-inbox-error-banner.sev-critical (Hygiene F3)
		panel.element.querySelector<HTMLButtonElement>('[data-inbox-id="gate-1"] .ade-inbox-btn.primary')!.click();
		await timeout(10);
		const errorBannerVisible = Boolean(panel.element.querySelector('.ade-inbox-error-banner.sev-critical'));
		gateShouldThrow = false;

		// Switch to "All" filter -> Resolved lane starts collapsed, clicking header expands it
		const filterBtns = [...panel.element.querySelectorAll<HTMLButtonElement>('.ade-inbox-filter-btn')];
		filterBtns.find(b => b.textContent === 'All')!.click();
		const resolvedCollapsedInitially = !panel.element.querySelector('[data-inbox-id="done-1"]');
		panel.element.querySelector<HTMLElement>('.ade-inbox-lane-header.lane-resolved')!.click();
		const resolvedVisibleAfterExpand = Boolean(panel.element.querySelector('[data-inbox-id="done-1"]'));

		// Severity fallback heuristic `/circuit/i` when `severity` is omitted
		const legacyCircuitSeverity = resolveAdeInboxSeverity({ kind: 'governor_message', title: 'CIRCUIT broken on N1' });

		assert.deepStrictEqual({
			pendingLaneOrder,
			cardOrder,
			criticalPrimaryText,
			gateApproveIncludesApprove,
			openedCanvases,
			infoMsgClampedInitially,
			infoMsgExpandedAfterMore,
			errorBannerVisible,
			resolvedCollapsedInitially,
			resolvedVisibleAfterExpand,
			legacyCircuitSeverity,
		}, {
			pendingLaneOrder: ['Critical', 'Needs Decision', 'Updates'],
			cardOrder: ['crit-1', 'gate-1', 'info-1'],
			criticalPrimaryText: 'Open Node ↗',
			gateApproveIncludesApprove: true,
			openedCanvases: ['gov-1'],
			infoMsgClampedInitially: true,
			infoMsgExpandedAfterMore: true,
			errorBannerVisible: true,
			resolvedCollapsedInitially: true,
			resolvedVisibleAfterExpand: true,
			legacyCircuitSeverity: 'critical',
		});
	});

	test('keeps Projects tree free of unread blue dots, surfaces unread agent replies in Inbox, and filters Inbox by rank (Governor / Manager / Employee / Worker)', async () => {
		const h = createHarness([alpha]);
		h.modes.setMode('ade');

		const gov = h.projects.addSession(alpha, { engineId: 'aexus-antigravity', resource: URI.parse('aexus-antigravity:/rank-gov') }, 'Arch Governor', { role: 'governor' });
		const mgr = h.projects.addSession(alpha, { engineId: 'aexus-cline', resource: URI.parse('aexus-cline:/rank-mgr') }, 'Backend Manager', { parentId: gov.id, role: 'manager' });
		const emp = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/rank-emp') }, 'Reviewer Employee', { parentId: mgr.id, role: 'employee' });
		const wrk = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/rank-wrk') }, 'Fix Worker', { parentId: emp.id });

		// Mark all four ranks unread in background (simulating completed replies)
		h.projects.setAgentStatus(gov.id, 'idle', true);
		h.projects.setAgentStatus(mgr.id, 'idle', true);
		h.projects.setAgentStatus(emp.id, 'idle', true);
		h.projects.setAgentStatus(wrk.id, 'idle', true);

		const onInboxChanged = store.add(new Emitter<void>());
		const formalItems: IAdeInboxItem[] = [
			{
				id: 'gov-alert-1',
				kind: 'governor_message',
				treeType: 'engineering',
				governorSessionId: gov.id,
				governorLabel: gov.label,
				projectPath: alpha.fsPath,
				projectName: 'Alpha',
				title: 'Architecture milestone ready',
				message: 'Ready for review.',
				unread: true,
				resolved: false,
				createdAt: Date.now() - 1000,
				senderRank: 'governor',
			},
			{
				id: 'mgr-alert-1',
				kind: 'governor_message',
				treeType: 'engineering',
				governorSessionId: gov.id,
				governorLabel: mgr.label,
				projectPath: alpha.fsPath,
				projectName: 'Alpha',
				title: 'Backend API report',
				message: 'Manager status update.',
				unread: true,
				resolved: false,
				createdAt: Date.now() - 500,
				senderRank: 'manager',
				senderAgentId: mgr.id,
			},
		];
		const markedFormalRead: string[] = [];
		const inboxStub = new class extends mock<IAdeInboxService>() {
			override get items(): readonly IAdeInboxItem[] { return formalItems; }
			override get unreadCount(): number { return formalItems.filter(i => i.unread && !i.resolved).length; }
			override readonly onDidChange = onInboxChanged.event;
			override list(opts?: { includeResolved?: boolean }): readonly IAdeInboxItem[] {
				return opts?.includeResolved ? formalItems : formalItems.filter(i => !i.resolved);
			}
			override async markRead(id?: string): Promise<void> {
				if (id) {
					markedFormalRead.push(id);
					const target = formalItems.find(i => i.id === id);
					if (target) { (target as { unread: boolean }).unread = false; }
				} else {
					markedFormalRead.push('*');
					for (const item of formalItems) { (item as { unread: boolean }).unread = false; }
				}
				onInboxChanged.fire();
			}
			override async resolveItem(): Promise<IAdeInboxItem | undefined> { return undefined; }
		}();
		h.instantiation.stub(IAdeInboxService, inboxStub);

		const dummySidebar = new class extends mock<ViewContainer>() { override readonly id = 'test.ade.rankinbox'; }();
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

		const host = append(document.body, $('.monaco-workbench.ade-rank-inbox-test-host'));
		store.add({ dispose: () => host.remove() });
		host.style.width = '280px';
		host.style.height = '600px';

		const view = store.add(h.instantiation.createInstance(AdeProjectsView, { id: ADE_PROJECTS_VIEW_ID, title: 'Sessions' }));
		view.render();
		host.appendChild(view.element);
		view.setVisible(true);
		view.orthogonalSize = 280;
		view.layout(600);
		await view.refresh();
		await view.revealAgent(wrk.id);

		// 1. Projects tree MUST NOT render any visible unread blue dot (so role badges stay aligned!)
		const projectsTreeUnreadDots = [...host.querySelectorAll<HTMLElement>('.ade-projects-tree .ade-status-dot.unread')]
			.filter(el => !el.hidden && mainWindow.getComputedStyle(el).display !== 'none').length;

		// 2. Inbox tab badge MUST reflect formal unread (2) + unread agent replies (4) = 6
		const inboxTabBadgeText = host.querySelector<HTMLElement>('.ade-inbox-count-badge')?.textContent;

		// 3. Switch to Inbox tab -> verify rank chips, rank counts, and reply priority ordering (L1 -> L2 -> L3 -> L4)
		view.setSidebarMode('inbox');
		const panelEl = host.querySelector<HTMLElement>('.ade-inbox-panel')!;
		const rankChipCounts = Object.fromEntries(
			[...panelEl.querySelectorAll<HTMLElement>('.ade-inbox-rank-chip')].map(el => [
				el.getAttribute('data-rank')!,
				el.querySelector('.ade-inbox-rank-count')?.textContent ?? '0',
			]),
		);
		const replyOrderAll = [...panelEl.querySelectorAll<HTMLElement>('.ade-inbox-card.kind-agent_reply')]
			.map(el => el.getAttribute('data-rank'));

		// 4. Filter to L1 Governor -> ONLY Governor formal item + Governor unread reply
		panelEl.querySelector<HTMLButtonElement>('.ade-inbox-rank-chip[data-rank="governor"]')!.click();
		const govFilteredFormalIds = [...panelEl.querySelectorAll<HTMLElement>('.ade-inbox-card[data-inbox-id]')].map(el => el.getAttribute('data-inbox-id'));
		const govFilteredAgentIds = [...panelEl.querySelectorAll<HTMLElement>('.ade-inbox-card[data-inbox-agent-id]')].map(el => el.getAttribute('data-inbox-agent-id'));

		// 5. Filter to L2 Manager -> ONLY Manager formal item + Manager unread reply
		panelEl.querySelector<HTMLButtonElement>('.ade-inbox-rank-chip[data-rank="manager"]')!.click();
		const mgrFilteredFormalIds = [...panelEl.querySelectorAll<HTMLElement>('.ade-inbox-card[data-inbox-id]')].map(el => el.getAttribute('data-inbox-id'));
		const mgrFilteredAgentIds = [...panelEl.querySelectorAll<HTMLElement>('.ade-inbox-card[data-inbox-agent-id]')].map(el => el.getAttribute('data-inbox-agent-id'));

		// 6. Click "Mark all read" while filtered to L2 Manager -> ONLY clears Manager unread (leaves Governor unread intact!)
		panelEl.querySelector<HTMLButtonElement>('.ade-inbox-toolbar .ade-inbox-link-btn')!.click();
		const mgrUnreadAfterScopedMarkRead = Boolean(h.projects.getAgent(mgr.id)?.unread);
		const govUnreadAfterScopedMarkRead = Boolean(h.projects.getAgent(gov.id)?.unread);
		const govFormalStillUnread = formalItems.find(i => i.id === 'gov-alert-1')!.unread;
		const mgrFormalNowRead = !formalItems.find(i => i.id === 'mgr-alert-1')!.unread;

		// 7. Clicking an unread reply card opens the agent and marks it read
		panelEl.querySelector<HTMLButtonElement>('.ade-inbox-rank-chip[data-rank="worker"]')!.click();
		panelEl.querySelector<HTMLElement>(`.ade-inbox-card[data-inbox-agent-id="${wrk.id}"]`)!.click();
		const wrkUnreadAfterClick = Boolean(h.projects.getAgent(wrk.id)?.unread);
		const emptyWorkerStateShown = Boolean(panelEl.querySelector('.ade-inbox-empty'));

		assert.deepStrictEqual({
			projectsTreeUnreadDots,
			inboxTabBadgeText,
			rankChipCounts,
			replyOrderAll,
			govFilteredFormalIds,
			govFilteredAgentIds,
			mgrFilteredFormalIds,
			mgrFilteredAgentIds,
			mgrUnreadAfterScopedMarkRead,
			govUnreadAfterScopedMarkRead,
			govFormalStillUnread,
			mgrFormalNowRead,
			wrkUnreadAfterClick,
			emptyWorkerStateShown,
			markedFormalRead,
		}, {
			projectsTreeUnreadDots: 0,
			inboxTabBadgeText: '6',
			rankChipCounts: { all: '6', governor: '2', manager: '2', employee: '1', worker: '1' },
			replyOrderAll: ['governor', 'manager', 'employee', 'worker'],
			govFilteredFormalIds: ['gov-alert-1'],
			govFilteredAgentIds: [gov.id],
			mgrFilteredFormalIds: ['mgr-alert-1'],
			mgrFilteredAgentIds: [mgr.id],
			mgrUnreadAfterScopedMarkRead: false,
			govUnreadAfterScopedMarkRead: true,
			govFormalStillUnread: true,
			mgrFormalNowRead: true,
			wrkUnreadAfterClick: false,
			emptyWorkerStateShown: true,
			markedFormalRead: ['mgr-alert-1'],
		});
	});

	test('warms up lazy sessions via AdeSessionEditor 3-step stepper with Retry on failure, and surfaces lineage on connected ChatEditorInput', async () => {
		const h = createHarness([alpha]);
		h.modes.setMode('ade');

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
		h.instantiation.stub(IExtensionService, new class extends mock<IExtensionService>() {
			override readonly extensions = [] as never;
			override async activateById(): Promise<void> { }
			override async activateByEvent(): Promise<void> { }
		}());
		h.instantiation.stub(IChatSessionsService, new class extends mock<IChatSessionsService>() {
			override getAllChatSessionContributions() { return []; }
		}());
		h.instantiation.stub(IAgentHostEnablementService, new class extends mock<IAgentHostEnablementService>() { }());

		let shouldFailSpawn = true;
		h.instantiation.stub(IAdeSessionsService, new class extends mock<IAdeSessionsService>() {
			override getEngineName(engineId: string): string { return engineId === 'aexus-claude' ? 'Claude Code' : engineId; }
			override async create(engineId: string): Promise<IAdeEngineSession> {
				if (shouldFailSpawn) {
					throw new Error('CLI daemon unreachable');
				}
				return {
					engineId,
					projectUri: alpha,
					resource: URI.parse('aexus-claude:/materialized-emp'),
					label: 'Materialized Emp',
				};
			}
		}());

		const realEditors = store.add(h.instantiation.createInstance(AdeEditorService));
		h.instantiation.stub(IAdeEditorService, realEditors);

		const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/lin-gov') }, 'Chief Gov', { role: 'governor' });
		const mgr = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/lin-mgr') }, 'Core Mgr', { parentId: gov.id, role: 'manager' });
		const lazyEmp = h.projects.addAgent(mgr.id, 'Lazy Reviewer', 'employee');
		h.projects.updateAgentEnginePreferences?.(lazyEmp.id, { preferredEngineId: 'aexus-claude' });

		// 1) First open fails -> stays on AdeSessionEditorInput in error state with Retry (never silently swallowed!)
		await realEditors.openAgent(lazyEmp.id);
		const failedInput = activeEditor;
		assert.ok(failedInput instanceof AdeSessionEditorInput);

		// Mount AdeSessionEditor pane on failedInput to verify 32px lineage header + stepper error + Retry button
		const paneHost = append(document.body, $('.monaco-workbench.ade-session-pane-test-host'));
		store.add({ dispose: () => paneHost.remove() });
		const pane = store.add(h.instantiation.createInstance(AdeSessionEditor, fakeGroup));
		pane.create(paneHost);
		await pane.setInput(failedInput, undefined, { newInGroup: true }, CancellationToken.None);

		const headerHeight = paneHost.querySelector<HTMLElement>('.ade-session-header')?.offsetHeight;
		const crumbTexts = [...paneHost.querySelectorAll('.ade-session-crumb')].map(el => el.textContent);
		const rankPillTier = paneHost.querySelector('.ade-session-rank-pill')?.getAttribute('data-tier');
		const stepCount = paneHost.querySelectorAll('.ade-session-warmup-step').length;
		const errorText = paneHost.querySelector('.ade-session-warmup-error')?.textContent;
		const retryBtn = [...paneHost.querySelectorAll<HTMLElement>('.ade-session-warmup-actions .monaco-button')].find(b => b.textContent === 'Retry');

		// 2) Flip spawn to succeed and click Retry -> swaps warm-up tab to AdeLineageChatEditorInput with rich lineage!
		shouldFailSpawn = false;
		retryBtn!.click();
		await timeout(30);

		const connectedInput = activeEditor;
		const isLineageChat = connectedInput instanceof AdeLineageChatEditorInput && connectedInput instanceof ChatEditorInput;
		const chatDescription = connectedInput?.getDescription();
		const chatLongTitle = connectedInput?.getTitle(Verbosity.LONG);
		const warmTabClosed = editors.every(e => !(e instanceof AdeSessionEditorInput));
		await realEditors.closeAgents([gov, mgr, h.projects.getAgent(lazyEmp.id)!]);

		assert.deepStrictEqual({
			headerHeight,
			crumbTexts,
			rankPillTier,
			stepCount,
			errorText,
			hasRetryBtn: Boolean(retryBtn),
			isLineageChat,
			chatDescription,
			chatLongTitleIncludesLineage: Boolean(chatLongTitle?.includes('Alpha › Core Mgr › Employee')),
			warmTabClosed,
		}, {
			headerHeight: 32,
			crumbTexts: ['Alpha', 'Chief Gov', 'Core Mgr', 'Lazy Reviewer'],
			rankPillTier: 'L3',
			stepCount: 3,
			errorText: 'CLI daemon unreachable',
			hasRetryBtn: true,
			isLineageChat: true,
			chatDescription: 'Alpha › Core Mgr › Employee',
			chatLongTitleIncludesLineage: true,
			warmTabClosed: true,
		});
	});

	test('renders AdeChangesView summary strip + gitDecoration letter pills + sibling empty actions, and prunes collapsed folder watchers in AdeFilesView', async () => {
		const h = createHarness([alpha, beta]);
		const addedUri = URI.file('/projects/Alpha/src/new.ts');
		const modifiedUri = URI.file('/projects/Alpha/src/app.ts');
		const deletedUri = URI.file('/projects/Alpha/src/old.ts');

		const groupHolder: { ref?: ISCMResourceGroup } = {};
		const mkRes = (uri: URI, tooltip: string, strikeThrough = false): ISCMResource => ({
			get resourceGroup() { return groupHolder.ref!; },
			sourceUri: uri,
			decorations: { tooltip, strikeThrough },
			contextValue: undefined,
			command: undefined,
			multiDiffEditorOriginalUri: undefined,
			multiDiffEditorModifiedUri: undefined,
			open: async () => { },
		});
		const provider = upcastPartial<ISCMProvider>({
			id: 'git-alpha',
			label: 'Git',
			rootUri: alpha,
			groups: [],
			onDidChangeResourceGroups: Event.None,
			onDidChangeResources: Event.None,
			getOriginalResource: async () => null,
		});
		const groupRef = upcastPartial<ISCMResourceGroup>({
			id: 'workingTree',
			label: 'Changes',
			provider,
			hideWhenEmpty: false,
			resources: [
				mkRes(addedUri, 'Index Added'),
				mkRes(modifiedUri, 'Modified'),
				mkRes(deletedUri, 'Deleted', true),
			],
			onDidChange: Event.None,
			onDidChangeResources: Event.None,
		});
		groupHolder.ref = groupRef;
		(provider.groups as ISCMResourceGroup[]).push(groupRef);
		const repo = upcastPartial<ISCMRepository>({ id: 'repo-alpha', provider });
		h.instantiation.stub(ISCMService, new class extends mock<ISCMService>() {
			override readonly repositories = [repo];
			override readonly onDidAddRepository = Event.None;
			override readonly onDidRemoveRepository = Event.None;
		}());

		const dummyInspector = new class extends mock<ViewContainer>() { override readonly id = 'test.ade.inspector2'; }();
		h.instantiation.stub(IViewDescriptorService, {
			getViewLocationById: () => ViewContainerLocation.AuxiliaryBar,
			onDidChangeLocation: Event.None,
			getViewDescriptorById: () => null,
			getViewContainerByViewId: () => dummyInspector,
			getDefaultContainerById: () => dummyInspector,
			getViewContainerModel: () => new class extends mock<IViewContainerModel>() {
				override readonly title = 'Project Inspector';
				override readonly onDidChangeContainerInfo = Event.None;
			}(),
			onDidChangeContainer: Event.None,
		});

		const host = append(document.body, $('.monaco-workbench.ade-inspector-upgrade-host'));
		store.add({ dispose: () => host.remove() });
		const changesView = store.add(h.instantiation.createInstance(AdeChangesView, { id: ADE_CHANGES_VIEW_ID, title: 'Changes' }));
		changesView.render();
		host.appendChild(changesView.element);
		changesView.orthogonalSize = 260;
		changesView.layout(320);

		h.navigation.selectProject(alpha);
		await changesView.refresh();
		const summaryText = host.querySelector('.ade-changes-summary')?.textContent;
		const rowLetters = [...host.querySelectorAll('.ade-scm-resource-row .ade-scm-letter')].map(el => el.textContent).sort();
		const titleCount = changesView.titleDescription;
		const emptyActionsHiddenWhenHasChanges = host.querySelector<HTMLElement>('.ade-inspector-empty-actions')?.hidden;

		// Beta has 0 changes -> exact .ade-inspector-empty textContent + visible sibling quick actions
		h.navigation.selectProject(beta);
		await changesView.refresh();
		const betaEmptyExact = host.querySelector('.ade-inspector-empty')?.textContent;
		const siblingQuickActions = [...host.querySelectorAll('.ade-inspector-empty-actions .ade-inspector-empty-action')].map(el => el.textContent);
		const titleCountClearedOnEmpty = changesView.titleDescription;

		// AdeFilesView watcher pruning on folder collapse
		let activeWatchers = 0;
		const subFolder = URI.file('/projects/Alpha/src');
		const nestedFolder = URI.file('/projects/Alpha/src/nested');
		h.instantiation.stub(IFileService, new class extends mock<IFileService>() {
			override readonly onDidFilesChange = Event.None;
			override readonly onDidRunOperation = Event.None;
			override createWatcher() {
				activeWatchers++;
				return {
					onDidChange: Event.None,
					dispose: () => { activeWatchers--; },
				};
			}
			override async resolve(resource: URI): Promise<IFileStatWithMetadata> {
				const children = resource.path === alpha.path
					? [{ resource: subFolder, name: 'src', isDirectory: true, isFile: false, isSymbolicLink: false }]
					: resource.path === subFolder.path
						? [{ resource: nestedFolder, name: 'nested', isDirectory: true, isFile: false, isSymbolicLink: false }]
						: [{ resource: URI.file('/projects/Alpha/src/nested/index.ts'), name: 'index.ts', isDirectory: false, isFile: true, isSymbolicLink: false }];
				return {
					resource,
					name: resource.path.split('/').pop() ?? '',
					isDirectory: true,
					isFile: false,
					isSymbolicLink: false,
					mtime: 0,
					ctime: 0,
					etag: '1',
					size: 0,
					locked: false,
					readonly: false,
					executable: false,
					children: children.map(c => ({ ...c, mtime: 0, ctime: 0, etag: '1', size: 0, locked: false, readonly: false, executable: false, children: undefined })),
				};
			}
		}());

		const filesHost = append(document.body, $('.monaco-workbench.ade-files-watcher-host'));
		store.add({ dispose: () => filesHost.remove() });
		const filesView = store.add(h.instantiation.createInstance(AdeFilesView, { id: ADE_FILES_VIEW_ID, title: 'Files' }));
		filesView.render();
		filesHost.appendChild(filesView.element);
		filesView.orthogonalSize = 260;
		filesView.layout(300);

		h.navigation.selectProject(alpha);
		await filesView.refresh(URI.file('/projects/Alpha/src/nested/index.ts'));
		const watchersAfterDeepExpand = { mapCount: filesView.watchedFolderCount, activeWatchers };

		// Click `src` folder row to collapse it -> watchers for `src` and `src/nested` MUST be disposed & pruned!
		const srcRow = [...filesHost.querySelectorAll<HTMLElement>('.monaco-list-row')].find(r => r.textContent?.trim() === 'src')!;
		srcRow.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true, button: 0, detail: 1 }));
		const treeTwistie = srcRow.querySelector<HTMLElement>('.monaco-tl-twistie')!;
		treeTwistie.dispatchEvent(new mainWindow.MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 }));
		treeTwistie.dispatchEvent(new mainWindow.MouseEvent('mouseup', { bubbles: true, button: 0, detail: 1 }));
		treeTwistie.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true, button: 0, detail: 1 }));
		await timeout(20);
		const watchersAfterCollapse = { mapCount: filesView.watchedFolderCount, activeWatchers };

		assert.deepStrictEqual({
			summaryText,
			rowLetters,
			titleCount,
			emptyActionsHiddenWhenHasChanges,
			betaEmptyExact,
			siblingQuickActions,
			titleCountClearedOnEmpty,
			watchersAfterDeepExpand,
			watchersAfterCollapse,
		}, {
			summaryText: '3 files·A1·M1·D1',
			rowLetters: ['A', 'D', 'M'],
			titleCount: '3',
			emptyActionsHiddenWhenHasChanges: true,
			betaEmptyExact: 'No changes in Beta',
			siblingQuickActions: ['Open Files', 'Refresh'],
			titleCountClearedOnEmpty: undefined,
			watchersAfterDeepExpand: { mapCount: 3, activeWatchers: 3 },
			watchersAfterCollapse: { mapCount: 1, activeWatchers: 1 },
		});
	});

	test('supports extensible custom organization ranks, user-authored prompts, kernel-enforced primitive APIs, dynamic Sidebar/Inbox badges, and visual Fill-in-the-Blank Role Studio', async () => {
		const h = createHarness();
		h.modes.setMode('ade');
		const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
		h.instantiation.stub(IAdeRoleSchemaService, roleSchema);

		// 1. Inspect fixed primitive APIs & presets, then apply a custom 3-tier org via control API
		const fixedApis = await h.control<Array<{ id: string }>>('role.apis');
		const presets = await h.control<Array<{ id: string }>>('role.presets');
		const customConfig: IAdeOrganizationConfig = {
			version: 1,
			presetId: 'custom',
			ranks: [
				{
					id: 'cto',
					name: 'CTO',
					shortName: 'CTO',
					tier: 1,
					color: 'amber',
					icon: 'rocket',
					summary: 'L1 CTO: Strategic technical lead.',
					initPrompt: 'You are {{rank.tier}} {{rank.name}} owning {{project.name}}.',
					pureExecution: false,
					canHaveSubordinates: true,
					defaultChildRankId: 'qa-auditor',
					allowedApis: ['session.read_context', 'session.message', 'session.manage', 'project.read', 'inbox.post'],
				},
				{
					id: 'qa-auditor',
					name: 'QA Auditor',
					shortName: 'QA',
					tier: 2,
					color: 'cyan',
					icon: 'eye',
					summary: 'L2 QA Auditor: Read-only audit lead.',
					initPrompt: 'Audit diffs for {{project.name}} under {{supervisor.label}} ({{supervisor.rank}}). Never code directly.',
					pureExecution: false,
					canHaveSubordinates: true,
					defaultChildRankId: 'coder',
					allowedApis: ['session.read_context', 'project.read', 'inbox.post'],
				},
				{
					id: 'coder',
					name: 'Coder',
					shortName: 'Cod',
					tier: 3,
					color: 'emerald',
					icon: 'tools',
					summary: 'L3 Pure Coder: 100% clean native context.',
					initPrompt: '',
					pureExecution: true,
					canHaveSubordinates: false,
					allowedApis: [],
				},
			],
		};
		await h.control('role.schema.set', { config: customConfig });

		// 2. Create sessions with custom ranks & verify compiled prompt + scoped CLI + pure leaf isolation
		const cto = await h.control<IAdeSessionSummary>('session.create', { project: alpha.fsPath, engine: 'claude', title: 'Chief Tech Officer', role: 'cto', open: false });
		const qa = await h.control<IAdeSessionSummary>('session.create', { parent: cto.id, engine: 'claude', title: 'Strict QA', role: 'qa-auditor', open: false });
		const coder = await h.control<IAdeSessionSummary>('session.create', { parent: qa.id, engine: 'codex', title: 'Leaf Coder', role: 'coder', open: false });

		const ctoPrompt = h.resolvePrompt({ agentId: cto.id })!;
		const qaPrompt = h.resolvePrompt({ agentId: qa.id })!;
		const coderPrompt = h.resolvePrompt({ agentId: coder.id });

		// 3. Kernel-enforced primitive API authorization check!
		const qaCanRead = await h.control<{ readonly session: IAdeSessionSummary }>('session.info', { id: cto.id, caller: 'qa-auditor' });
		let qaDeniedSend = false;
		try {
			await h.control('session.send', { id: coder.id, prompt: 'Run', caller: 'qa-auditor' });
		} catch (err) {
			qaDeniedSend = /QA Auditor/.test(String(err)) && /session\.message/.test(String(err));
		}
		let qaDeniedProjectDelete = false;
		try {
			await h.control('project.delete', { target: alpha.fsPath, caller: 'qa-auditor' });
		} catch (err) {
			qaDeniedProjectDelete = /project\.manage/.test(String(err));
		}

		// 4. Verify dynamic Inbox rank filter bar reflects custom ranks (All | CTO | QA | Cod)
		const inboxStub = upcastPartial<IAdeInboxService>({
			onDidChange: Event.None,
			items: [],
			unreadCount: 0,
			list: () => [],
			markRead: async () => { },
		});
		const engStub: IAdeInboxMissionBridge = {
			listTrees: () => [],
		};
		const inboxHost = append(document.body, $('.monaco-workbench.ade-custom-inbox-host'));
		store.add({ dispose: () => inboxHost.remove() });
		const inboxPanel = store.add(new AdeInboxPanel(inboxHost, inboxStub, engStub, h.editorsStub, undefined, h.projects, h.instantiation.get(IAdeSessionsService), roleSchema));
		inboxPanel.setVisible(true);
		const inboxRankChipLabels = [...inboxHost.querySelectorAll('.ade-inbox-rank-chip-label')].map(el => el.textContent);

		// 5. Verify Fill-in-the-Blank Visual Role Studio mounts, adds custom rank, toggles API, previews, and saves!
		const studioHost = append(document.body, $('.monaco-workbench.ade-role-studio-test-host'));
		store.add({ dispose: () => studioHost.remove() });
		const mockGroup = upcastPartial<IEditorGroup>({ id: 1 });
		const studioPane = store.add(h.instantiation.createInstance(AdeRoleStudioEditorPane, mockGroup));
		studioPane.create(studioHost);
		const studioInput = store.add(h.instantiation.createInstance(AdeRoleStudioEditorInput, 'qa-auditor'));
		await studioPane.setInput(studioInput, undefined, {}, CancellationToken.None);

		const addRankBtn = studioHost.querySelector<HTMLButtonElement>('.ade-rs-add-btn')!;
		addRankBtn.click();
		const msgCheckbox = studioHost.querySelector<HTMLInputElement>('input[type="checkbox"][data-api-id="inbox.post"]')!;
		msgCheckbox.checked = true;
		msgCheckbox.dispatchEvent(new mainWindow.Event('change', { bubbles: true }));
		const previewBeforeSave = studioHost.querySelector('.ade-rs-preview-pre')?.textContent ?? '';
		const saveBtn = studioHost.querySelector<HTMLButtonElement>('.ade-rs-toolbar .ade-rs-btn.primary')!;
		saveBtn.click();
		await timeout(15);

		assert.deepStrictEqual({
			hasFixedPrimitivesAndPresets: fixedApis.length >= 10 && presets.length >= 5,
			ctoCompiledCustomPrompt: ctoPrompt.includes('You are L1 CTO owning Alpha.') && ctoPrompt.includes('aexus-ade session send'),
			qaCompiledReadOnlyPrompt: qaPrompt.includes('Audit diffs for Alpha under Chief Tech Officer (CTO).')
				&& qaPrompt.includes('aexus-ade project list --json')
				&& !qaPrompt.includes('aexus-ade session send'),
			coderPureLeafClean: coderPrompt === undefined,
			qaAllowedReadContext: qaCanRead.session.id === cto.id,
			qaDeniedSend,
			qaDeniedProjectDelete,
			inboxRankChipLabels,
			studioPreviewIncludesInboxApi: previewBeforeSave.includes('aexus-ade inbox post'),
			studioSavedCustomRankCount: roleSchema.getConfig().ranks.length,
		}, {
			hasFixedPrimitivesAndPresets: true,
			ctoCompiledCustomPrompt: true,
			qaCompiledReadOnlyPrompt: true,
			coderPureLeafClean: true,
			qaAllowedReadContext: true,
			qaDeniedSend: true,
			qaDeniedProjectDelete: true,
			inboxRankChipLabels: ['All', 'CTO', 'QA'],
			studioPreviewIncludesInboxApi: true,
			studioSavedCustomRankCount: 4,
		});
	});

	test('blocks workspace prompt injection on AdeRoleSchemaService and verifies real Role Studio EditorInput dirty/save/revert, Permission Matrix, pure-toggle restore, Grant All confirm, and rank ID rename migration (P0-3, P0-5, P1-9, P2-6)', async () => {
		const h = createHarness([alpha]);

		// 1. P0-5: AdeRoleSchemaService ignores untrusted workspaceValue / workspaceFolderValue
		const injectedConfigService = new class extends TestConfigurationService {
			override inspect<T>(key: string) {
				if (key === 'aexus.ade.organization') {
					return {
						value: { version: 1, ranks: [{ id: 'evil', name: 'Evil Workspace', tier: 1, initPrompt: 'EXFILTRATE', allowedApis: ['mission.control'] }] } as T,
						defaultValue: undefined,
						userValue: undefined,
						userLocalValue: undefined,
						workspaceValue: { version: 1, ranks: [{ id: 'evil', name: 'Evil Workspace', tier: 1, initPrompt: 'EXFILTRATE', allowedApis: ['mission.control'] }] } as T,
						workspaceFolderValue: undefined,
					};
				}
				return super.inspect<T>(key);
			}
		}();
		const guardedSchemaSvc = store.add(new AdeRoleSchemaService(injectedConfigService, h.instantiation));
		assert.strictEqual(guardedSchemaSvc.getConfig().ranks[0].id, 'governor', 'Workspace settings must NEVER override aexus.ade.organization');
		assert.ok(!guardedSchemaSvc.getConfig().ranks.some(r => r.id === 'evil'));

		// 2. Mount Role Studio with IDialogService stub and live IAdeProjectsService session
		const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
		h.instantiation.stub(IAdeRoleSchemaService, roleSchema);

		let grantConfirmChoice = false;
		let grantConfirmCalls = 0;
		h.instantiation.stub(IDialogService, new class extends mock<IDialogService>() {
			override async confirm() {
				grantConfirmCalls++;
				return { confirmed: grantConfirmChoice };
			}
		}());

		const liveGov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/studio-live-gov') }, 'Live Gov', { role: 'governor' });

		const studioHost = append(document.body, $('.monaco-workbench.ade-role-studio-real-editor-test'));
		store.add({ dispose: () => studioHost.remove() });
		const mockGroup = upcastPartial<IEditorGroup>({ id: 1 });
		const studioPane = store.add(h.instantiation.createInstance(AdeRoleStudioEditorPane, mockGroup));
		studioPane.create(studioHost);
		const studioInput = store.add(h.instantiation.createInstance(AdeRoleStudioEditorInput, 'governor'));
		await studioPane.setInput(studioInput, undefined, {}, CancellationToken.None);

		// Verify P2-6 spelling fix
		assert.strictEqual(studioHost.querySelector('.ade-rs-philosophy-pill')?.textContent, 'Everything is Extensible');
		assert.strictEqual(studioInput.isDirty(), false);

		// 3. Test Pure Execution toggle preserves & restores initPrompt and allowedApis
		const initialPrompt = studioHost.querySelector<HTMLTextAreaElement>('#ade-rs-field-prompt')!.value;
		assert.ok(initialPrompt.length > 10);
		const pureCb = studioHost.querySelector<HTMLInputElement>('input[data-field="pure-execution"]')!;
		pureCb.checked = true;
		pureCb.dispatchEvent(new mainWindow.Event('change', { bubbles: true }));
		assert.strictEqual(studioInput.isDirty(), true, 'Toggling Pure Execution marks EditorInput dirty');
		assert.ok(studioHost.querySelector('.ade-rs-pure-banner'), 'Pure banner shown when pureExecution enabled');

		const pureCb2 = studioHost.querySelector<HTMLInputElement>('input[data-field="pure-execution"]')!;
		pureCb2.checked = false;
		pureCb2.dispatchEvent(new mainWindow.Event('change', { bubbles: true }));
		const restoredPrompt = studioHost.querySelector<HTMLTextAreaElement>('#ade-rs-field-prompt')!.value;
		assert.strictEqual(restoredPrompt, initialPrompt, 'Turning Pure Execution back off must restore pre-pure prompt');

		// 4. Test revert() discards unsaved edits and clears isDirty()
		await studioInput.revert(1);
		assert.strictEqual(studioInput.isDirty(), false, 'revert() must clear EditorInput dirty state');

		// 5. Test Grant All requires IDialogService.confirm (declined -> does not grant dangerous API)
		const grantAllBtn = studioHost.querySelector<HTMLButtonElement>('button[data-action="grant-all"]')!;
		grantConfirmChoice = false;
		grantAllBtn.click();
		await timeout(15);
		assert.strictEqual(grantConfirmCalls, 1, 'Grant All must prompt confirmation dialog');
		assert.strictEqual(
			studioHost.querySelector<HTMLInputElement>('input[data-api-id="mission.destroy"]')?.checked,
			false,
			'Declining Grant All must NOT grant High Privilege mission.destroy API',
		);

		// 6. Test Permission Matrix view toggle + High Privilege badges + in-place matrix toggle
		const matrixTab = studioHost.querySelector<HTMLButtonElement>('button.ade-rs-view-tab[data-view-mode="matrix"]')!;
		matrixTab.click();
		const matrixTable = studioHost.querySelector('table.ade-rs-matrix-table');
		assert.ok(matrixTable, 'Switching to Permission Matrix renders Rank x API grid');
		assert.ok(matrixTable!.querySelectorAll('.ade-rs-api-danger').length >= 4, 'Permission Matrix highlights High Privilege APIs');
		const mgrControlCb = matrixTable!.querySelector<HTMLInputElement>('input.ade-rs-matrix-cb[data-rank-id="manager"][data-api-id="mission.control"]')!;
		assert.strictEqual(mgrControlCb.checked, false);
		mgrControlCb.checked = true;
		mgrControlCb.dispatchEvent(new mainWindow.Event('change', { bubbles: true }));
		assert.strictEqual(studioInput.isDirty(), true, 'Toggling Permission Matrix marks EditorInput dirty');

		// 7. Switch back to Rank Editor, rename 'governor' -> 'director', and call real EditorInput.save() -> migrates live session!
		const editorTab = studioHost.querySelector<HTMLButtonElement>('button.ade-rs-view-tab[data-view-mode="editor"]')!;
		editorTab.click();
		const idInput = studioHost.querySelector<HTMLInputElement>('input[data-field="rank-id"]')!;
		idInput.value = 'director';
		idInput.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
		const savedInput = await studioInput.save(1);
		assert.strictEqual(savedInput, studioInput, 'EditorInput.save() resolves to saved input');
		assert.strictEqual(studioInput.isDirty(), false, 'EditorInput.save() clears dirty flag');
		assert.strictEqual(h.projects.getAgent(liveGov.id)?.role, 'director', 'Renaming rank ID in Role Studio migrates live session role');
		assert.ok(roleSchema.getConfig().ranks.find(r => r.id === 'manager')?.allowedApis.includes('mission.control'), 'Permission Matrix grant persisted');
	});

	test('enforces RBAC lineage, live rank intersection, and mission.destroy on tree-tagged roots (P0-01, P0-03, P1-04, P1-06)', async () => {
		const h = createHarness([alpha, beta]);
		const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
		h.instantiation.stub(IAdeRoleSchemaService, roleSchema);

		const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/rbac-gov') }, 'Gov Root', { role: 'governor' });
		h.projects.setAgentWorkTreeTag?.(gov.id, 'mission');
		const mgr = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/rbac-mgr') }, 'Mgr Sub', { parentId: gov.id, role: 'manager' });
		const emp = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/rbac-emp') }, 'Emp Sub', { parentId: mgr.id, role: 'employee' });
		const wrk = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/rbac-wrk') }, 'Wrk Leaf', { parentId: emp.id });
		const otherGov = h.projects.addSession(beta, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/rbac-other-gov') }, 'Other Gov', { role: 'governor' });
		const otherEmp = h.projects.addSession(beta, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/rbac-other-emp') }, 'Other Emp', { parentId: otherGov.id, role: 'employee' });

		const exec = <T = unknown>(action: string, params: Record<string, unknown> = {}) =>
			h.control<T>(action, params);

		// 1. P1-06: Secretary compiled prompt exposes rank, mission & role CLI docs
		h.projects.configureSecretary({ engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/rbac-sec') });
		const secPreamble = h.resolvePrompt({ resource: URI.parse('aexus-claude:/rbac-sec'), agentId: ADE_SECRETARY_ID });
		assert.ok(secPreamble?.includes('rank names'));
		assert.ok(secPreamble?.includes('docs read mission'));
		assert.ok(secPreamble?.includes('role apply-preset'));

		// 2. Archived / missing caller session rejected when _verifiedCaller is true
		await assert.rejects(
			() => exec('session.list', { caller: 'manager', _verifiedCaller: true, _callerSessionId: 'non-existent-session' }),
			/caller session no longer active/i,
		);

		// 3. session.create blocks omitting --parent (root spawn), peer/superior rank spawn, and cross-subtree spawn
		await assert.rejects(
			() => exec('session.create', { engine: 'claude', project: alpha.fsPath, caller: 'manager', _verifiedCaller: true, _callerSessionId: mgr.id }),
			/must specify '--parent'/i,
		);
		await assert.rejects(
			() => exec('session.create', { engine: 'claude', parent: mgr.id, role: 'manager', caller: 'manager', _verifiedCaller: true, _callerSessionId: mgr.id }),
			/cannot create rank/i,
		);
		await assert.rejects(
			() => exec('session.create', { engine: 'claude', parent: otherGov.id, role: 'employee', caller: 'manager', _verifiedCaller: true, _callerSessionId: mgr.id }),
			/outside your subordinate subtree/i,
		);
		const createdUnderMgr = await exec<IAdeSessionSummary>('session.create', {
			engine: 'claude',
			parent: mgr.id,
			role: 'employee',
			open: false,
			caller: 'manager',
			_verifiedCaller: true,
			_callerSessionId: mgr.id,
		});
		assert.strictEqual(createdUnderMgr?.parentId, mgr.id);

		// 4. session.role blocks self-promotion and promotion to peer/superior rank
		await assert.rejects(
			() => exec('session.role', { id: mgr.id, role: 'governor', caller: 'manager', _verifiedCaller: true, _callerSessionId: mgr.id }),
			/cannot change role of itself/i,
		);
		await assert.rejects(
			() => exec('session.role', { id: emp.id, role: 'manager', caller: 'manager', _verifiedCaller: true, _callerSessionId: mgr.id }),
			/cannot assign role rank/i,
		);

		// 5. session.move blocks detach-to-root and cross-subtree moves
		await assert.rejects(
			() => exec('session.move', { id: emp.id, parent: 'none', caller: 'manager', _verifiedCaller: true, _callerSessionId: mgr.id }),
			/top-level root/i,
		);
		await assert.rejects(
			() => exec('session.move', { id: otherEmp.id, parent: mgr.id, caller: 'manager', _verifiedCaller: true, _callerSessionId: mgr.id }),
			/outside your subordinate subtree/i,
		);

		// 6. session.send strictly enforces top-down communication (blocks direct parent, grandparent, lateral, self; allows descendants)
		await assert.rejects(
			() => exec('session.send', { id: gov.id, prompt: 'upward jump', caller: 'employee', _verifiedCaller: true, _callerSessionId: emp.id }),
			/cannot send messages to rank/i,
		);
		await assert.rejects(
			() => exec('session.send', { id: otherGov.id, prompt: 'lateral jump', caller: 'employee', _verifiedCaller: true, _callerSessionId: emp.id }),
			/cannot send messages to rank|outside your subordinate subtree/i,
		);
		await assert.rejects(
			() => exec('session.send', { id: emp.id, prompt: 'self msg', caller: 'employee', _verifiedCaller: true, _callerSessionId: emp.id }),
			/cannot send messages to itself/i,
		);
		// Direct parent send is now strictly blocked (Principle 7 top-down iron law)
		await assert.rejects(
			() => exec('session.send', { id: mgr.id, prompt: 'upward direct parent report', open: false, caller: 'employee', _verifiedCaller: true, _callerSessionId: emp.id }),
			/cannot send messages to rank/i,
		);
		// Descendant send succeeds
		await exec('session.send', { id: wrk.id, prompt: 'fix unit test', open: false, caller: 'employee', _verifiedCaller: true, _callerSessionId: emp.id });

		// 7. session.stop / session.archive / session.delete block targeting superior/unrelated and require mission.destroy on tree roots
		await assert.rejects(
			() => exec('session.stop', { id: gov.id, caller: 'manager', _verifiedCaller: true, _callerSessionId: mgr.id }),
			/cannot stop rank/i,
		);
		// Even a custom top-tier rank WITHOUT mission.destroy cannot wipe a Governor's Mission via session.delete --force
		await assert.rejects(
			() => exec('session.delete', { id: gov.id, force: true, caller: 'governor' }),
			/Permission denied/i,
		);
		await assert.rejects(
			() => exec('session.archive', { id: gov.id, caller: 'governor' }),
			/Permission denied/i,
		);

		// 8. Live rank intersection: demoting mgr to pure worker invalidates its stale 'manager' capability token immediately!
		h.projects.setAgentRole(mgr.id, undefined);
		const demotedSub = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/rbac-demoted') }, 'Demoted Leaf', { parentId: gov.id });
		await assert.rejects(
			() => exec('session.create', { engine: 'claude', parent: demotedSub.id, caller: 'manager', _verifiedCaller: true, _callerSessionId: demotedSub.id }),
			/Pure Execution/i,
		);
		// Restore mgr role
		h.projects.setAgentRole(mgr.id, 'manager');
		assert.ok(createdUnderMgr?.id);
		assert.ok(otherEmp?.id);
	});

	test('renders Role Studio 4-slot Work-Tree DAG mapping bar with dirty/save/revert and inline warnings (P1-02)', async () => {
		const h = createHarness([alpha]);
		const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
		h.instantiation.stub(IAdeRoleSchemaService, roleSchema);

		const studioHost = append(document.body, $('.monaco-workbench.ade-role-studio-slots-test'));
		store.add({ dispose: () => studioHost.remove() });
		const mockGroup = upcastPartial<IEditorGroup>({ id: 1 });
		const studioPane = store.add(h.instantiation.createInstance(AdeRoleStudioEditorPane, mockGroup));
		studioPane.create(studioHost);
		const studioInput = store.add(h.instantiation.createInstance(AdeRoleStudioEditorInput, 'governor'));
		await studioPane.setInput(studioInput, undefined, {}, CancellationToken.None);

		const getSelect = (slot: string) => studioHost.querySelector<HTMLSelectElement>(`select.ade-rs-slot-select[data-slot="${slot}"]`)!;
		assert.strictEqual(getSelect('orchestrator').value, 'governor');
		assert.strictEqual(getSelect('segment_owner').value, 'manager');
		assert.strictEqual(getSelect('reviewer').value, 'employee');
		assert.strictEqual(getSelect('executor').value, 'worker');
		assert.strictEqual(studioHost.querySelectorAll('.ade-rs-slot-warning').length, 0, 'Default 4-tier slots must have 0 warnings');

		// Set reviewer === executor -> marks dirty & shows self-review warning
		getSelect('reviewer').value = 'worker';
		getSelect('reviewer').dispatchEvent(new mainWindow.Event('change', { bubbles: true }));
		assert.strictEqual(studioInput.isDirty(), true);
		assert.ok(studioHost.querySelector('[data-slot-warning="reviewer-equals-executor"]'), 'Must warn when reviewer === executor');

		// Set executor to non-pure rank -> shows executor-not-pure warning
		getSelect('executor').value = 'employee';
		getSelect('executor').dispatchEvent(new mainWindow.Event('change', { bubbles: true }));
		assert.ok(studioHost.querySelector('[data-slot-warning="executor-not-pure"]'), 'Must warn when executor is not pureExecution');

		// Revert discards slot changes cleanly
		await studioInput.revert(1);
		assert.strictEqual(studioInput.isDirty(), false);
		assert.strictEqual(getSelect('reviewer').value, 'employee');
		assert.strictEqual(getSelect('executor').value, 'worker');
		assert.strictEqual(studioHost.querySelectorAll('.ade-rs-slot-warning').length, 0);

		// Save persists updated slot mapping
		getSelect('segment_owner').value = 'governor';
		getSelect('segment_owner').dispatchEvent(new mainWindow.Event('change', { bubbles: true }));
		await studioInput.save(1);
		assert.strictEqual(studioInput.isDirty(), false);
		assert.strictEqual(roleSchema.getConfig().slots?.segment_owner, 'governor');
	});

	test('maps Inbox alert kind badges accurately, hides 0-count pureExecution chips, and updates Safe/Autonomous status bar pill (P1-07, P1-09)', async () => {
		// 1. P1-07: formatAdeInboxKindLabel accuracy
		assert.strictEqual(formatAdeInboxKindLabel({ kind: 'user_gate', title: 'Gate U1' }, 'gate'), 'User Gate');
		assert.strictEqual(formatAdeInboxKindLabel({ kind: 'governor_message', title: '[Verify Gate] Blocked Untrusted Verify Command' }, 'critical'), 'Trust Gate');
		assert.strictEqual(formatAdeInboxKindLabel({ kind: 'governor_message', title: '[Budget Guardrail] Paused DAG ($2 / $2)' }, 'critical'), 'Budget Cap');
		assert.strictEqual(formatAdeInboxKindLabel({ kind: 'governor_message', title: '[Worktree Error] Creation failed' }, 'critical'), 'Worktree Alert');
		assert.strictEqual(formatAdeInboxKindLabel({ kind: 'governor_message', title: '[Persist Error] Disk full' }, 'critical'), 'Storage Alert');
		assert.strictEqual(formatAdeInboxKindLabel({ kind: 'governor_message', title: '[Circuit Breaker] Node N2 failed 3x' }, 'critical'), 'Circuit Breaker');
		assert.strictEqual(formatAdeInboxKindLabel({ kind: 'governor_message', title: 'Unexpected failure' }, 'critical'), 'Critical Alert');
		assert.strictEqual(formatAdeInboxKindLabel({ kind: 'governor_message', title: 'FYI update' }, 'info'), 'Governor Alert');

		// 2. P1-07: Hide 0-count pureExecution rank chip (Wrk) until a pure-rank item/reply exists
		const h = createHarness([alpha]);
		const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
		h.instantiation.stub(IAdeRoleSchemaService, roleSchema);
		const inboxStub = new class extends mock<IAdeInboxService>() {
			override readonly onDidChange = Event.None;
			override list() { return []; }
		}();
		const engStub: IAdeInboxMissionBridge = { listTrees: () => [] };
		const host = append(document.body, $('.ade-inbox-pure-filter-test'));
		store.add({ dispose: () => host.remove() });
		const panel = store.add(new AdeInboxPanel(host, inboxStub, engStub, h.editorsStub, undefined, h.projects, h.instantiation.get(IAdeSessionsService), roleSchema));
		panel.setVisible(true);
		assert.deepStrictEqual(
			[...host.querySelectorAll('.ade-inbox-rank-chip-label')].map(el => el.textContent),
			['All', 'Gov', 'Mgr', 'Emp'],
			'0-count pureExecution Wrk chip must stay hidden',
		);

		// When a pure Worker session has an unread reply, Wrk chip dynamically appears
		const wrkSess = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/unread-wrk') }, 'Pure Worker');
		h.projects.syncSessionItem(wrkSess.session!.resource, { status: 'idle' }, false);
		h.projects.syncSessionItem(wrkSess.session!.resource, { status: 'working' }, false);
		h.projects.syncSessionItem(wrkSess.session!.resource, { status: 'idle' }, false);
		panel.render();
		assert.deepStrictEqual(
			[...host.querySelectorAll('.ade-inbox-rank-chip-label')].map(el => el.textContent),
			['All', 'Gov', 'Mgr', 'Emp', 'Wrk'],
			'Pure Wrk chip must surface when count > 0',
		);

		// 3. P1-09: Safe vs Autonomous Status Bar pill defaults to Full Access (Autonomous) and reacts to aexus.ade.autonomousMode
		let latestEntry: IStatusbarEntry | undefined;
		const statusbarStub = new class extends mock<IStatusbarService>() {
			override addEntry(entry: IStatusbarEntry): IStatusbarEntryAccessor {
				latestEntry = entry;
				return {
					update: (next: IStatusbarEntry) => { latestEntry = next; },
					dispose: () => { },
				};
			}
		}();
		const defaultConfigService = new TestConfigurationService({});
		store.add(new AdeAutonomousModeStatusContribution(statusbarStub, defaultConfigService));
		assert.strictEqual(latestEntry?.text, '$(flame) ADE: Autonomous', 'ADE defaults to Full Access / Autonomous Mode when unset');
		assert.strictEqual(latestEntry?.kind, 'warning');

		const configService = new TestConfigurationService({ 'aexus.ade.autonomousMode': false });
		store.add(new AdeAutonomousModeStatusContribution(statusbarStub, configService));
		assert.strictEqual(latestEntry?.text, '$(shield) ADE: Safe Mode');
		assert.strictEqual(latestEntry?.kind, 'standard');
		assert.strictEqual(latestEntry?.command, ADE_TOGGLE_AUTONOMOUS_MODE_COMMAND_ID);

		await configService.setUserConfiguration('aexus.ade.autonomousMode', true);
		configService.onDidChangeConfigurationEmitter.fire({
			affectsConfiguration: (k: string) => k === 'aexus.ade.autonomousMode',
		} as never);
		assert.strictEqual(latestEntry?.text, '$(flame) ADE: Autonomous');
		assert.strictEqual(latestEntry?.kind, 'warning');
	});

	test('exposes ADE config with L0 Secretary, rank count >= 1, hot-reload aliases, single-copy docs, unified Mission labels, and infinite-canvas Mission pane', async () => {
		const configCommand = MenuRegistry.getMenuItems(MenuId.GlobalActivity)
			.filter(isIMenuItem)
			.find(item => item.command.id === ADE_OPEN_CONFIG_COMMAND_ID);
		assert.ok(configCommand, `${ADE_OPEN_CONFIG_COMMAND_ID} must be contributed to MenuId.GlobalActivity`);
		assert.strictEqual(
			typeof configCommand.command.title === 'string' ? configCommand.command.title : configCommand.command.title.value,
			'ADE config',
		);

		const h = createHarness([alpha]);
		const mockGroup = upcastPartial<IEditorGroup>({ id: 1 });

		const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
		h.instantiation.stub(IAdeRoleSchemaService, roleSchema);

		const configHost = append(document.body, $('.ade-config-pane-test-host'));
		store.add({ dispose: () => configHost.remove() });
		const configPane = store.add(h.instantiation.createInstance(AdeConfigEditorPane, mockGroup));
		configPane.create(configHost);
		const configRoot = configHost.querySelector<HTMLElement>('.ade-config-editor');
		assert.ok(configRoot, 'AdeConfigEditorPane renders .ade-config-editor');
		assert.strictEqual(configRoot.getAttribute('aria-label'), 'ADE config');

		// Shows L-1 User + L0 Secretary + default preset L1..L4 aliases
		assert.ok(configRoot.querySelector('[data-tier="L-1"]')?.textContent?.includes('User'), 'L-1 row shows User');
		assert.ok(configRoot.querySelector('[data-tier="L0"]')?.textContent?.includes('Secretary'), 'L0 row shows Secretary');
		assert.strictEqual(configRoot.querySelector<HTMLElement>('[data-ade-rank-count]')?.textContent, '4');
		assert.strictEqual(configRoot.querySelector<HTMLInputElement>('input[data-tier-alias="L1"]')?.value, 'Governor');
		assert.strictEqual(configRoot.querySelector<HTMLInputElement>('input[data-tier-alias="L2"]')?.value, 'Manager');
		assert.strictEqual(configRoot.querySelector<HTMLInputElement>('input[data-tier-alias="L3"]')?.value, 'Employee');
		assert.strictEqual(configRoot.querySelector<HTMLInputElement>('input[data-tier-alias="L4"]')?.value, 'Worker');

		// Single-copy docs paths display sibling ranks/ and mission/MISSION_API.md
		const ranksDocEl = configRoot.querySelector<HTMLElement>('[data-ade-docs-ranks]');
		const missionDocEl = configRoot.querySelector<HTMLElement>('[data-ade-docs-mission]');
		assert.ok(ranksDocEl?.textContent?.endsWith('/docs/ranks'), 'Docs card displays ranks/ directory');
		assert.ok(missionDocEl?.textContent?.endsWith('/docs/mission/MISSION_API.md'), 'Docs card displays sibling mission/MISSION_API.md');

		// Hot-edit L2 alias in ADE config and save -> live rank.names reflects update immediately
		const l2Input = configRoot.querySelector<HTMLInputElement>('input[data-tier-alias="L2"]')!;
		l2Input.value = 'Director';
		l2Input.dispatchEvent(new l2Input.ownerDocument.defaultView!.Event('input'));
		configRoot.querySelector<HTMLButtonElement>('button[data-ade-config-save]')!.click();
		await new Promise(resolve => setTimeout(resolve, 10));

		const liveNames = await h.control<{ readonly rankCount: number; readonly namesByTier: Record<string, string> }>('rank.names', {});
		assert.deepStrictEqual(liveNames.namesByTier, {
			'L-1': 'User',
			L0: 'Secretary',
			L1: 'Governor',
			L2: 'Director',
			L3: 'Employee',
			L4: 'Worker',
		});

		// Control plane hot-rename & rank.setCount >= 1 + mission.docs + rank.docs
		await h.control('rank.rename', { target: 'L3', alias: 'Reviewer', shortName: 'Rev' });
		const afterRename = await h.control<{ readonly namesByTier: Record<string, string> }>('rank.names', {});
		assert.strictEqual(afterRename.namesByTier.L3, 'Reviewer');

		const userInfo = await h.control<{ readonly tierTag: string; readonly alias: string; readonly isSystemUser?: boolean }>('rank.get', { target: 'L-1' });
		assert.strictEqual(userInfo.tierTag, 'L-1');
		assert.strictEqual(userInfo.alias, 'User');
		assert.strictEqual(userInfo.isSystemUser, true);

		const l0Info = await h.control<{ readonly tierTag: string; readonly alias: string; readonly isSystemL0?: boolean }>('rank.get', { target: 'L0' });
		assert.strictEqual(l0Info.tierTag, 'L0');
		assert.strictEqual(l0Info.alias, 'Secretary');
		assert.strictEqual(l0Info.isSystemL0, true);

		const missionDocs = await h.control<{ readonly missionDoc: string; readonly ranksDir: string }>('mission.docs', {});
		assert.ok(missionDocs.missionDoc.endsWith('/docs/mission/MISSION_API.md'));
		assert.ok(missionDocs.ranksDir.endsWith('/docs/ranks'));

		await h.control('rank.setCount', { count: 1 });
		const oneTier = await h.control<{ readonly rankCount: number; readonly namesByTier: Record<string, string> }>('rank.names', {});
		assert.strictEqual(oneTier.rankCount, 1);
		assert.deepStrictEqual(oneTier.namesByTier, { 'L-1': 'User', L0: 'Secretary', L1: 'Governor' });
		// Stepper decrement is disabled at min count 1
		assert.strictEqual(configRoot.querySelector<HTMLButtonElement>('button[data-ade-rank-dec]')?.disabled, true);

		// Test Mission alias customization (Mission -> Engineering -> Research) hot-updating tab titles & rank.names
		const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
		h.instantiation.stub(IAdeMissionService, missionStore);
		const missionAliasInput = configRoot.querySelector<HTMLInputElement>('input[data-ade-mission-alias-input="true"]')!;
		assert.strictEqual(missionAliasInput.value, 'Mission');
		missionAliasInput.value = 'Engineering';
		missionAliasInput.dispatchEvent(new missionAliasInput.ownerDocument.defaultView!.Event('input'));
		configRoot.querySelector<HTMLButtonElement>('button[data-ade-config-save]')!.click();
		await new Promise(resolve => setTimeout(resolve, 10));

		const renamedMissionNames = await h.control<{ readonly missionName: string }>('rank.names', {});
		assert.strictEqual(renamedMissionNames.missionName, 'Engineering');

		const createdMission = missionStore.createMission({ title: 'Core Release', mermaidText: '' });
		const missionInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, createdMission.id));
		assert.strictEqual(missionInput.getName(), 'Core Release · Engineering');

		// Reset Mission alias back to default Mission
		await h.control('mission.renameAlias', { alias: 'Mission' });
		assert.strictEqual(missionInput.getName(), 'Core Release · Mission');

		// Pure frontend Mission canvas: empty start -> top-left file icon -> Mermaid renders flat non-nested DAG -> hover lights up flowing dashed edges!
		const engHost = append(document.body, $('.monaco-workbench.ade-eng-pane-test-host'));
		store.add({ dispose: () => engHost.remove() });
		const engPane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
		engPane.create(engHost);
		await engPane.setInput(missionInput, undefined, {}, CancellationToken.None);

		const engRoot = engHost.querySelector<HTMLElement>('.ade-mission-editor');
		assert.ok(engRoot, 'Mission pane renders .ade-mission-editor');
		const fileBtn = engRoot.querySelector<HTMLButtonElement>('button[data-ade-mission-file-btn="true"]')!;
		assert.ok(fileBtn, 'Top-left Mermaid file icon button is present');
		const drawer = engRoot.querySelector<HTMLElement>('[data-ade-mission-drawer="true"]')!;
		assert.strictEqual(drawer.hidden, true, 'Drawer starts closed on empty Mission');
		assert.strictEqual(engRoot.querySelectorAll('.ade-mission-node').length, 0, 'Empty Mission starts with 0 rendered nodes');

		// Click top-left file icon -> enter Mermaid DAG -> flat non-nested nodes & smooth rounded orthogonal edges render
		fileBtn.click();
		assert.strictEqual(drawer.hidden, false, 'Clicking top-left file icon opens Mermaid file drawer');
		const textarea = engRoot.querySelector<HTMLTextAreaElement>('textarea[data-ade-mission-mermaid-input="true"]')!;
		textarea.value = 'flowchart LR\n  N1["API Spec"] --> N2["Core Engine"]\n  N2 --> N3["UI Canvas"]\n  N2 --> N4["Tests"]';
		textarea.dispatchEvent(new textarea.ownerDocument.defaultView!.Event('input'));
		await new Promise(resolve => setTimeout(resolve, 140));

		const renderedNodes = [...engRoot.querySelectorAll<HTMLElement>('.ade-mission-node')];
		assert.strictEqual(renderedNodes.length, 4, 'Renders 4 strictly flat non-nested DAG nodes');
		assert.strictEqual(engRoot.querySelectorAll('.ade-eng-segment-halo, .ade-eng-concentric').length, 0, 'Zero nested MGR/Employee containers');
		const renderedEdges = [...engRoot.querySelectorAll<SVGGElement>('.ade-mission-edge-group')];
		assert.strictEqual(renderedEdges.length, 3, 'Renders 3 smooth rounded orthogonal SVG edges');

		// Hover N2 -> incoming edge (N1->N2) gets is-hover-flow + is-incoming, outgoing edges (N2->N3, N2->N4) get is-hover-flow + is-outgoing!
		engPane.setHoveredNode('N2');
		assert.ok(engRoot.querySelector('.ade-mission-world')?.classList.contains('has-node-hover'));
		assert.ok(engRoot.querySelector('.ade-mission-node[data-node-id="N2"]')?.classList.contains('is-hovered'));
		assert.ok(engRoot.querySelector('.ade-mission-node[data-node-id="N1"]')?.classList.contains('is-upstream'));
		assert.ok(engRoot.querySelector('.ade-mission-node[data-node-id="N3"]')?.classList.contains('is-downstream'));
		assert.ok(engRoot.querySelector('.ade-mission-edge-group[data-edge-id="N1->N2"]')?.classList.contains('is-hover-flow'));
		assert.ok(engRoot.querySelector('.ade-mission-edge-group[data-edge-id="N1->N2"]')?.classList.contains('is-incoming'));
		assert.ok(engRoot.querySelector('.ade-mission-edge-group[data-edge-id="N2->N3"]')?.classList.contains('is-hover-flow'));
		assert.ok(engRoot.querySelector('.ade-mission-edge-group[data-edge-id="N2->N3"]')?.classList.contains('is-outgoing'));
		engPane.setHoveredNode(undefined);
		assert.strictEqual(engRoot.querySelectorAll('.ade-mission-edge-group.is-hover-flow').length, 0, 'Leaving node clears flowing dashed edges');
	});

	test('enforces Mission owner-only orchestration across any rank (L-1 User, L0 Secretary, L1..LN), locks Mermaid-generated sidebar employees, and removes them only with the entire Mission', async () => {
		const h = createHarness([alpha]);
		h.modes.setMode('ade');
		const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
		h.instantiation.stub(IAdeRoleSchemaService, roleSchema);
		const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
		h.instantiation.stub(IAdeMissionService, missionStore);

		const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/mo-gov') }, 'Gov L1', { role: 'governor' });
		const mgr = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/mo-mgr') }, 'Mgr L2', { parentId: gov.id, role: 'manager' });
		const mgrPeer = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/mo-mgr2') }, 'Mgr Peer', { parentId: gov.id, role: 'manager' });

		// 1. User (L-1) creates a Mission on nested L2 Manager session (`mgr`) — owner keeps its L2 role!
		const created = await h.control<{ readonly id: string; readonly ownerSessionId: string; readonly ownerTier: number; readonly ownerTierTag: string }>('mission.init', {
			owner: mgr.id,
			title: 'Payments Module',
		});
		assert.strictEqual(created.ownerSessionId, mgr.id);
		assert.strictEqual(created.ownerTier, 2);
		assert.strictEqual(created.ownerTierTag, 'L2');
		assert.strictEqual(h.projects.getAgent(mgr.id)?.role, 'manager', 'Creating a Mission on L2 must preserve its L2 rank');

		// 2. STRICT OWNER-ONLY ORCHESTRATION:
		//    - L1 Governor (higher rank!), L2 peer, and L0 Secretary are ALL blocked from operating mgr's Mission!
		const mermaidDag = 'flowchart LR\n  N1["API Schema"] --> N2["Checkout UI"]\n  N2 --> U1{{"Signoff"}}';
		await assert.rejects(
			() => h.control('mission.blueprint.apply', { id: created.id, text: mermaidDag, caller: 'governor', _verifiedCaller: true, _callerSessionId: gov.id }),
			/owned by.*L2/i,
		);
		await assert.rejects(
			() => h.control('mission.blueprint.apply', { id: created.id, text: mermaidDag, caller: 'manager', _verifiedCaller: true, _callerSessionId: mgrPeer.id }),
			/owned by.*L2/i,
		);
		await assert.rejects(
			() => h.control('mission.blueprint.apply', { id: created.id, text: mermaidDag, caller: 'secretary' }),
			/owned by.*L2/i,
		);
		await assert.rejects(
			() => h.control('mission.remove', { id: created.id, caller: 'secretary' }),
			/owned by.*L2/i,
		);
		await assert.rejects(
			() => h.control('mission.remove', { id: created.id, caller: 'governor', _verifiedCaller: true, _callerSessionId: gov.id }),
			/owned by.*L2/i,
		);

		//    - ONLY the exact L2 owner session (`mgr`) itself (and L-1 User) can apply Mermaid & orchestrate!
		const applied = await h.control<{ readonly nodeCount: number; readonly generatedEmployeeIds: string[] }>('mission.blueprint.apply', {
			id: created.id,
			text: mermaidDag,
			caller: 'manager',
			_verifiedCaller: true,
			_callerSessionId: mgr.id,
		});
		assert.strictEqual(applied.nodeCount, 3, '2 tasks + 1 gate parsed');
		assert.strictEqual(applied.generatedEmployeeIds.length, 2, 'Only the 2 task nodes generate sidebar employees (gate U1 does not)');

		// 3. Mermaid-generated employees are directly under `mgr`, assigned L3 (next lower tier), and LOCKED in left sidebar!
		const generated = missionStore.getGeneratedEmployees(created.id);
		assert.strictEqual(generated.length, 2);
		assert.deepStrictEqual(generated.map(g => g.label), ['[N1] API Schema', '[N2] Checkout UI']);
		for (const emp of generated) {
			assert.strictEqual(emp.parentId, mgr.id);
			assert.strictEqual(emp.role, 'employee', 'Employees generated under L2 owner default to L3');
			assert.strictEqual(h.projects.isLockedByWorkTree?.(emp.id), true, 'Mermaid-generated employee MUST be locked');
			assert.strictEqual(h.projects.canReparentAgent(emp.id, gov.id), false, 'Locked employee cannot be reparented');
		}
		assert.strictEqual(h.projects.isLockedByWorkTree?.(mgr.id), false, 'Mission owner itself is not locked as a child');

		// 4. Individual delete / remove / detach / archive / move / role-change on locked Mermaid employee MUST be blocked!
		const lockedN1 = generated[0];
		await assert.rejects(() => h.control('session.detach', { id: lockedN1.id }), /locked by a Mission/i);
		await assert.rejects(() => h.control('session.delete', { id: lockedN1.id, force: true }), /locked by a Mission/i);
		await assert.rejects(() => h.control('session.archive', { id: lockedN1.id }), /locked by a Mission/i);
		await assert.rejects(() => h.control('session.move', { id: lockedN1.id, parent: gov.id }), /locked/i);
		await assert.rejects(() => h.control('session.role', { id: lockedN1.id, role: 'worker' }), /locked/i);
		assert.ok(h.projects.getAgent(lockedN1.id), 'Locked Mermaid employee remains intact after rejected individual removals');

		// 5. Left sidebar view renders nested L2 owner Mission badge, locked glyph on generated children, and hides Remove/Delete on locked children!
		const dummySidebar = new class extends mock<ViewContainer>() { override readonly id = 'test.ade.mission.lock'; }();
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
		const viewHost = append(document.body, $('.monaco-workbench.ade-mission-lock-sidebar-test'));
		store.add({ dispose: () => viewHost.remove() });
		viewHost.style.width = '280px';
		viewHost.style.height = '500px';
		const view = store.add(h.instantiation.createInstance(AdeProjectsView, { id: ADE_PROJECTS_VIEW_ID, title: 'Sessions' }));
		view.render();
		viewHost.appendChild(view.element);
		view.setVisible(true);
		view.orthogonalSize = 280;
		view.layout(500);
		await view.refresh();
		await view.revealAgent(lockedN1.id);

		const findRow = (labelText: string) => [...viewHost.querySelectorAll<HTMLElement>('.ade-tree-row')]
			.find(el => el.querySelector('.label-name')?.textContent === labelText)!;
		const mgrRow = findRow('Mgr L2');
		const n1Row = findRow('[N1] API Schema');
		assert.strictEqual(mgrRow.querySelector<HTMLElement>('.ade-worktree-badge')?.hidden, false, 'Nested L2 Mission owner shows Mission badge');
		assert.strictEqual(n1Row.classList.contains('ade-worktree-locked'), true, 'Mermaid-generated employee row has locked class');
		assert.strictEqual(n1Row.querySelector<HTMLElement>('.ade-lock-glyph')?.hidden, false, 'Mermaid-generated employee shows lock icon');

		const lockedMenuIds = view.getAgentContextActions(lockedN1).map(a => a.id);
		assert.ok(lockedMenuIds.includes('ade.mission.openParent'), 'Locked employee context menu jumps to owning Mission');
		assert.ok(!lockedMenuIds.includes('ade.detach'), 'Locked employee cannot be individually removed from sidebar');
		assert.ok(!lockedMenuIds.includes('ade.deletePermanently'), 'Locked employee cannot be individually deleted');

		const ownerMenuIds = view.getAgentContextActions(h.projects.getAgent(mgr.id)!).map(a => a.id);
		assert.ok(ownerMenuIds.includes('ade.mission'), 'L2 Mission owner menu offers Open Mission');
		assert.ok(ownerMenuIds.includes('ade.removeMission'), 'L2 Mission owner menu offers Remove Mission & All Employees');

		// 6. Removing the ENTIRE Mission via its L2 owner removes the Mission AND all locked employees together, unlocking mgr!
		const removed = await h.control<{ readonly deleted: boolean; readonly removedEmployeeIds: string[] }>('mission.remove', {
			id: created.id,
			caller: 'manager',
			_verifiedCaller: true,
			_callerSessionId: mgr.id,
		});
		assert.strictEqual(removed.deleted, true);
		assert.strictEqual(removed.removedEmployeeIds.length, 2);
		assert.strictEqual(missionStore.getMission(created.id), undefined);
		assert.strictEqual(missionStore.getGeneratedEmployees(created.id).length, 0);
		assert.strictEqual(h.projects.getAgent(lockedN1.id), undefined, 'All generated employees removed with the Mission');
		assert.ok(h.projects.getAgent(mgr.id), 'Owner session itself survives when removing Mission & employees');
		assert.strictEqual(h.projects.getAgent(mgr.id)?.treeType, undefined, 'Owner Mission tag cleared');

		// 7. Secretary (L0) can create & own its OWN L0 Mission; L1 Governor is blocked from operating L0's Mission!
		const secMission = await h.control<{ readonly id: string; readonly ownerSessionId: string; readonly ownerTier: number; readonly ownerTierTag: string }>('mission.init', {
			caller: 'secretary',
			mermaid: 'flowchart LR\n  S1["Global Audit"] --> S2["Summary"]',
		});
		assert.strictEqual(secMission.ownerSessionId, ADE_SECRETARY_ID);
		assert.strictEqual(secMission.ownerTier, 0);
		assert.strictEqual(secMission.ownerTierTag, 'L0');
		assert.strictEqual(missionStore.getGeneratedEmployees(secMission.id).length, 2);
		await assert.rejects(
			() => h.control('mission.blueprint.apply', { id: secMission.id, text: 'flowchart LR\n  X["Hijack"]', caller: 'governor', _verifiedCaller: true, _callerSessionId: gov.id }),
			/owned by.*L0/i,
		);
		// User (L-1) retains full override to remove Secretary's Mission + all its generated employees together
		const userRemoved = await h.control<{ readonly deleted: boolean; readonly removedEmployeeIds: string[] }>('mission.remove', {
			id: secMission.id,
			caller: 'L-1',
		});
		assert.strictEqual(userRemoved.deleted, true);
		assert.strictEqual(userRemoved.removedEmployeeIds.length, 2);
		assert.strictEqual(missionStore.getGeneratedEmployees(secMission.id).length, 0);
	});

	test('reuses the same locked sidebar employee session across multiple DAG positions, highlights same-employee context ribbons on hover, and supports 1-click canvas reassignment', async () => {
		const h = createHarness([alpha]);
		h.modes.setMode('ade');
		const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
		h.instantiation.stub(IAdeRoleSchemaService, roleSchema);
		const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
		h.instantiation.stub(IAdeMissionService, missionStore);

		const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/reuse-gov') }, 'Lead L1', { role: 'governor' });
		const reuseMermaid = [
			'flowchart LR',
			'  N1["@Backend: API Contract"] --> N2["@Frontend: UI Canvas"]',
			'  N1 --> N3["@Backend: Core Engine"]',
			'  N2 --> N4["@Backend: Integration & Fix"]',
			'  N3 --> N4',
			'  N4 --> U1{{"Signoff"}}',
		].join('\n');

		const created = await h.control<{ readonly id: string; readonly generatedEmployeeCount: number }>('mission.init', {
			owner: gov.id,
			title: 'Shared Context Pipeline',
			mermaid: reuseMermaid,
		});

		// 4 task steps (N1, N2, N3, N4), but ONLY 2 unique locked sidebar employees (Backend reused 3x + Frontend 1x)!
		assert.strictEqual(created.generatedEmployeeCount, 2, 'Shared @Backend across 3 positions creates ONE reusable locked employee, not 3 duplicates');
		const genEmployees = missionStore.getGeneratedEmployees(created.id);
		const backendEmp = genEmployees.find(e => e.label === 'Backend')!;
		const frontendEmp = genEmployees.find(e => e.label === 'Frontend')!;
		assert.ok(backendEmp && frontendEmp);
		assert.deepStrictEqual(backendEmp.treeNodeIds, ['N1', 'N3', 'N4']);
		assert.deepStrictEqual(frontendEmp.treeNodeIds, ['N2']);
		assert.strictEqual(h.projects.isLockedByWorkTree?.(backendEmp.id), true);
		assert.strictEqual(h.projects.isLockedByWorkTree?.(frontendEmp.id), true);

		// Adding a 4th @Backend step reuses the EXACT SAME sidebar session ID (preserving conversation context!)
		const extendedMermaid = `${reuseMermaid}\n  N4 --> N5["@Backend: Perf Tuning"]`;
		await h.control('mission.blueprint.apply', { id: created.id, text: extendedMermaid, caller: 'governor', _verifiedCaller: true, _callerSessionId: gov.id });
		const afterExtend = missionStore.getGeneratedEmployees(created.id).find(e => e.label === 'Backend')!;
		assert.strictEqual(afterExtend.id, backendEmp.id, 'Adding another DAG step for @Backend must preserve the exact same session ID');
		assert.deepStrictEqual(afterExtend.treeNodeIds, ['N1', 'N3', 'N4', 'N5']);

		// Revert back to 3 steps for visual & canvas checks
		await h.control('mission.blueprint.apply', { id: created.id, text: reuseMermaid, caller: 'governor', _verifiedCaller: true, _callerSessionId: gov.id });

		// Left sidebar renders locked icon + ×3 reuse count pill on Backend!
		const dummySidebar = new class extends mock<ViewContainer>() { override readonly id = 'test.ade.reuse.sidebar'; }();
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
		const viewHost = append(document.body, $('.monaco-workbench.ade-reuse-sidebar-test'));
		store.add({ dispose: () => viewHost.remove() });
		viewHost.style.width = '280px';
		viewHost.style.height = '500px';
		const view = store.add(h.instantiation.createInstance(AdeProjectsView, { id: ADE_PROJECTS_VIEW_ID, title: 'Sessions' }));
		view.render();
		viewHost.appendChild(view.element);
		view.setVisible(true);
		view.orthogonalSize = 280;
		view.layout(500);
		await view.refresh();
		await view.revealAgent(backendEmp.id);

		const backendRow = [...viewHost.querySelectorAll<HTMLElement>('.ade-tree-row')].find(el => el.querySelector('.label-name')?.textContent === 'Backend')!;
		assert.strictEqual(backendRow.querySelector<HTMLElement>('.ade-reuse-badge')?.textContent, '×3');
		assert.strictEqual(backendRow.querySelector<HTMLElement>('.ade-reuse-badge')?.hidden, false);
		assert.strictEqual(backendRow.querySelector<HTMLElement>('.ade-lock-glyph')?.hidden, false);

		// Canvas renders #1/3, #2/3, #3/3 employee pills + hovering N3 illuminates same-employee peers (N1, N4) + orthogonal context ribbons!
		const mockGroup = upcastPartial<IEditorGroup>({ id: 1 });
		const canvasHost = append(document.body, $('.monaco-workbench.ade-reuse-canvas-test'));
		store.add({ dispose: () => canvasHost.remove() });
		const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
		pane.create(canvasHost);
		const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));
		await pane.setInput(input, undefined, {}, CancellationToken.None);

		assert.strictEqual(canvasHost.querySelector('[data-node-emp-btn="N1"] .ade-mission-emp-seq')?.textContent, '#1/3');
		assert.strictEqual(canvasHost.querySelector('[data-node-emp-btn="N3"] .ade-mission-emp-seq')?.textContent, '#2/3');
		assert.strictEqual(canvasHost.querySelector('[data-node-emp-btn="N4"] .ade-mission-emp-seq')?.textContent, '#3/3');

		// Every task card renders an engine badge naming the linked employee's engine (session.engineId inherited from the owner).
		const engineBadge = (nodeId: string) => canvasHost.querySelector<HTMLElement>(`.ade-mission-node[data-node-id="${nodeId}"] [data-node-engine-id]`);
		assert.strictEqual(engineBadge('N1')?.getAttribute('data-node-engine-id'), 'aexus-claude');
		assert.strictEqual(engineBadge('N1')?.querySelector('.ade-mission-engine-name')?.textContent, 'Claude Code');
		assert.strictEqual(engineBadge('N2')?.getAttribute('data-node-engine-id'), 'aexus-claude');

		// A per-employee preferredEngineId override is reflected by the reusable employee's badges.
		h.projects.updateAgentEnginePreferences(backendEmp.id, { preferredEngineId: 'aexus-codex' });
		assert.strictEqual(engineBadge('N1')?.getAttribute('data-node-engine-id'), 'aexus-codex');
		assert.strictEqual(engineBadge('N1')?.querySelector('.ade-mission-engine-name')?.textContent, 'Codex');
		assert.strictEqual(engineBadge('N3')?.getAttribute('data-node-engine-id'), 'aexus-codex');
		assert.strictEqual(engineBadge('N2')?.getAttribute('data-node-engine-id'), 'aexus-claude', 'Other employees keep their own engine');

		// Hovering N1 must light up the middle reuse node N3 as BOTH a downstream neighbor and a same-employee peer,
		// attaching exactly one context-port side for the shared ribbon lane.
		pane.setHoveredNode('N1');
		const middleNode = canvasHost.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N3"]')!;
		assert.strictEqual(middleNode.classList.contains('is-downstream'), true, 'N3 is a downstream neighbor of hovered N1');
		assert.strictEqual(middleNode.classList.contains('is-same-employee'), true, 'N3 is the same Backend employee as N1');
		const hasTopPort = middleNode.classList.contains('has-ctx-port-top');
		const hasBottomPort = middleNode.classList.contains('has-ctx-port-bottom');
		assert.ok(hasTopPort !== hasBottomPort, 'Middle same-employee neighbor must attach exactly one context-port side');

		pane.setHoveredNode('N3');
		assert.strictEqual(canvasHost.querySelector('.ade-mission-node[data-node-id="N1"]')?.classList.contains('is-same-employee'), true);
		assert.strictEqual(canvasHost.querySelector('.ade-mission-node[data-node-id="N4"]')?.classList.contains('is-same-employee'), true);
		assert.strictEqual(canvasHost.querySelector('.ade-mission-node[data-node-id="N2"]')?.classList.contains('is-same-employee'), false);
		assert.strictEqual(canvasHost.querySelectorAll('.ade-mission-context-edge').length, 2, 'Two orthogonal context-reuse ribbons link N1->N3->N4 on hover');

		pane.setHoveredNode(undefined);
		assert.strictEqual(canvasHost.querySelectorAll('.ade-mission-context-edge').length, 0, 'Context ribbons disappear cleanly on mouse leave');

		// 1-click canvas reuse popover: click N2's employee pill -> pick Backend -> merges into single Backend employee (×4)!
		canvasHost.querySelector<HTMLButtonElement>('[data-node-emp-btn="N2"]')!.click();
		const popover = canvasHost.querySelector<HTMLElement>('[data-ade-mission-emp-popover="true"]')!;
		assert.strictEqual(popover.hidden, false);
		popover.querySelector<HTMLButtonElement>('button[data-ade-emp-option="Backend"]')!.click();
		assert.strictEqual(missionStore.getGeneratedEmployees(created.id).length, 1, 'Merging N2 onto Backend leaves 1 shared locked employee');
		assert.deepStrictEqual(missionStore.getGeneratedEmployees(created.id)[0].treeNodeIds, ['N1', 'N2', 'N3', 'N4']);
		assert.strictEqual(canvasHost.querySelector('[data-node-emp-btn="N2"] .ade-mission-emp-seq')?.textContent, '#2/4');
	});

	suite('ADE Mission Runtime, Token Bus, Strictly Top-Down Org APIs & Safe Patch (mission_plan)', () => {

		function createMissionHarness() {
			const h = createHarness([alpha]);
			h.modes.setMode('ade');
			const onInboxChanged = store.add(new Emitter<void>());
			const inboxItems: IAdeInboxItem[] = [];
			let inboxSeq = 0;
			const inboxStub = upcastPartial<IAdeInboxService>({
				_serviceBrand: undefined,
				get items(): readonly IAdeInboxItem[] { return inboxItems; },
				get unreadCount(): number { return inboxItems.filter(i => i.unread && !i.resolved).length; },
				onDidChange: onInboxChanged.event,
				list(opts?: { includeResolved?: boolean }): readonly IAdeInboxItem[] {
					return opts?.includeResolved === false ? inboxItems.filter(i => !i.resolved) : [...inboxItems];
				},
				async postGovernorMessage(input): Promise<IAdeInboxItem> {
					const item: IAdeInboxItem = {
						id: `inb-${++inboxSeq}`,
						kind: 'governor_message',
						treeType: 'mission',
						governorSessionId: input.governorSessionId,
						governorLabel: 'Owner',
						projectPath: alpha.fsPath,
						projectName: 'alpha',
						nodeId: input.nodeId,
						title: input.title ?? 'Message',
						message: input.message,
						senderAgentId: input.senderAgentId,
						createdAt: Date.now(),
						unread: true,
						resolved: false,
					};
					inboxItems.push(item);
					onInboxChanged.fire();
					return item;
				},
				async upsertUserGateTodo(input): Promise<IAdeInboxItem> {
					const item: IAdeInboxItem = {
						id: `gate-${++inboxSeq}`,
						kind: 'user_gate',
						treeType: 'mission',
						governorSessionId: input.governorSessionId,
						governorLabel: 'Owner',
						projectPath: alpha.fsPath,
						projectName: 'alpha',
						nodeId: input.nodeId,
						nodeTitle: input.nodeTitle,
						title: input.nodeTitle,
						message: input.description,
						upstreamSummary: input.upstreamSummary,
						rollbackCandidates: input.rollbackCandidates,
						createdAt: Date.now(),
						unread: true,
						resolved: false,
					};
					inboxItems.push(item);
					onInboxChanged.fire();
					return item;
				},
				async resolveItem(id: string): Promise<IAdeInboxItem | undefined> {
					const idx = inboxItems.findIndex(i => i.id === id);
					if (idx < 0) {
						return undefined;
					}
					const updated: IAdeInboxItem = { ...inboxItems[idx], resolved: true, unread: false };
					inboxItems[idx] = updated;
					onInboxChanged.fire();
					return updated;
				},
			});
			h.instantiation.stub(IAdeInboxService, inboxStub);
			const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
			h.instantiation.stub(IAdeRoleSchemaService, roleSchema);
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);
			return { h, roleSchema, missionStore, missionRuntime };
		}

		async function seedMission(h: ReturnType<typeof createHarness>, title: string, mermaid: string) {
			const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
			const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse(`aexus-claude:/${slug}-gov`) }, 'Gov L1', { role: 'governor' });
			const mgr = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse(`aexus-claude:/${slug}-mgr`) }, 'Owner L2', { parentId: gov.id, role: 'manager' });
			const created = await h.control<{ readonly id: string; readonly generatedEmployeeCount: number }>('mission.init', {
				owner: mgr.id,
				title,
				mermaid,
			});
			return { gov, mgr, created };
		}

		function employeesByNode(missionStore: AdeMissionStoreService, missionId: string): Map<string, IAdeAgent> {
			const byNode = new Map<string, IAdeAgent>();
			for (const emp of missionStore.getGeneratedEmployees(missionId)) {
				if (emp.treeNodeId) {
					byNode.set(emp.treeNodeId, emp);
				}
			}
			return byNode;
		}

		test('serves universal common APIs (api.update / docs.read) and reports in-graph identity via whoami', async () => {
			const { h, missionStore } = createMissionHarness();
			const { created } = await seedMission(h, 'Common APIs', 'flowchart LR\n  N1["API Spec"] --> N2["Core Engine"]');
			assert.ok(created.generatedEmployeeCount >= 2);
			const empN1 = employeesByNode(missionStore, created.id).get('N1')!;
			assert.ok(empN1, 'Mission node N1 has a generated in-graph employee');

			// 1. api.update --since 0 -> immutable diff contract with non-empty additions
			const update = await h.control<{
				readonly contractVersion: 1;
				readonly currentRevision: number;
				readonly latestRevision?: number;
				readonly added: readonly unknown[];
			}>('api.update', { since: 0 });
			assert.strictEqual(update.contractVersion, 1, 'api.update contractVersion is frozen at 1');
			assert.strictEqual(update.latestRevision ?? update.currentRevision, ADE_API_LATEST_REVISION, 'api.update exposes the latest API revision');
			assert.ok(update.added.length > 0, 'api.update --since 0 reports non-empty additions');

			// 2. docs.read -> single-copy common / L0 / mission documents
			for (const target of ['common', 'L0', 'mission'] as const) {
				const doc = await h.control<{ readonly ok: boolean; readonly content: string }>('docs.read', { target });
				assert.strictEqual(doc.ok, true, `docs.read ${target} succeeds`);
				assert.ok(doc.content.length > 0, `docs.read ${target} returns non-empty content`);
			}

			// 3. whoami -> numeric tier / tierTag / factory side / Mission & node identity / lazy docs entry
			const me = await h.control<{
				readonly id: string;
				readonly tier: number;
				readonly tierTag: string;
				readonly factorySide: string;
				readonly missionId?: string;
				readonly nodeIds?: readonly string[];
				readonly docsEntry?: Record<string, string>;
			}>('whoami', { caller: 'employee', _verifiedCaller: true, _callerSessionId: empN1.id });
			assert.strictEqual(me.id, empN1.id);
			assert.strictEqual(me.tier, 3, 'Generated employee sits at L3');
			assert.strictEqual(me.tierTag, 'L3');
			assert.strictEqual(me.factorySide, 'in_graph');
			assert.strictEqual(me.missionId, created.id);
			assert.deepStrictEqual(me.nodeIds, ['N1']);
			assert.ok(me.docsEntry?.common && me.docsEntry?.selfRank && me.docsEntry?.mission && me.docsEntry?.update, 'whoami exposes the on-demand docs entry map');
		});

		test('compiles a clean, minimal in-graph initialization prompt (buildAdeAgentRoleContext)', async () => {
			const { h, roleSchema, missionStore } = createMissionHarness();
			const { created } = await seedMission(h, 'Prompt Context', 'flowchart LR\n  N1["API Spec"] --> N2["Core Engine"]');
			const empN1 = employeesByNode(missionStore, created.id).get('N1')!;

			const prompt = buildAdeAgentRoleContext(h.projects, undefined, empN1, roleSchema.getConfig());
			assert.ok(prompt, 'In-graph Mission node employee always gets an initialization prompt');
			assert.ok(prompt!.includes(empN1.id), 'Prompt includes the agent ID');
			assert.ok(prompt!.includes('L3'), 'Prompt identifies the numeric tier L3');
			assert.ok(prompt!.includes(created.id), 'Prompt includes the owning Mission ID');
			assert.ok(prompt!.includes('aexus-ade whoami'), 'Prompt points at whoami');
			assert.ok(prompt!.includes('aexus-ade docs read'), 'Prompt points at docs read');
			assert.ok(prompt!.includes('aexus-ade api update'), 'Prompt points at api update');
			assert.ok(prompt!.length < 900, `In-graph prompt stays concise (was ${prompt!.length} chars)`);
			assert.ok(!prompt!.includes('N2'), 'Prompt is scoped to the employee node, not the whole DAG');
		});

		test('drives the full Token Bus (join barrier, gate, block/complete/reject/fail escalation) through executeAdeControlRequest', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const { mgr, created } = await seedMission(h, 'Token Bus', [
				'flowchart LR',
				'  N1["API Spec"] --> U1{{"Signoff"}}',
				'  N2["Core Engine"] --> U1',
				'  U1 --> N3["Release"]',
			].join('\n'));
			const byNode = employeesByNode(missionStore, created.id);
			const empN1 = byNode.get('N1')!;
			const empN2 = byNode.get('N2')!;
			const empN3 = byNode.get('N3')!;
			assert.ok(empN1 && empN2 && empN3, 'Every task node gets an in-graph employee');

			const callAsEmployee = <T = unknown>(empId: string, action: string, params: Record<string, unknown> = {}) =>
				h.control<T>(action, { ...params, caller: 'employee', _verifiedCaller: true, _callerSessionId: empId });

			// 1. start -> running, silence timeout supplied & locked
			const started = await h.control<{ readonly status: string; readonly silenceTimeoutMinutes: number; readonly mintedTokenIds: readonly string[] }>('mission.start', {
				id: created.id,
				silenceTimeoutMinutes: 12,
			});
			assert.strictEqual(started.status, 'running');
			assert.strictEqual(started.silenceTimeoutMinutes, 12);
			assert.strictEqual(started.mintedTokenIds.length, 2, 'Both inDegree=0 source nodes mint active tokens');
			await assert.rejects(
				() => h.control('mission.timeout.set', { id: created.id, minutes: 20 }),
				/locked/i,
				'Mission timeout is locked once running',
			);

			// 2. token.current / token.block / token.complete on N1
			const n1Current = await callAsEmployee<{ readonly tokens: ReadonlyArray<{ readonly id: string; readonly status: string }> }>(empN1.id, 'token.current', { mission: created.id });
			assert.strictEqual(n1Current.tokens.length, 1);
			const n1TokenId = n1Current.tokens[0].id;
			const blocked = await callAsEmployee<{ readonly ok: boolean; readonly token: { readonly status: string } }>(empN1.id, 'token.block', {
				mission: created.id,
				tokenId: n1TokenId,
				max: '30m',
				reason: 'Long-running benchmark',
			});
			assert.strictEqual(blocked.ok, true);
			assert.strictEqual(blocked.token.status, 'blocked');

			const completedN1 = await callAsEmployee<{ readonly ok: boolean }>(empN1.id, 'token.complete', {
				mission: created.id,
				tokenId: n1TokenId,
				summary: 'API spec finalized',
			});
			assert.strictEqual(completedN1.ok, true);
			assert.strictEqual(Object.keys(missionRuntime.getRuntimeState(created.id).joinBarriers).length, 1, 'N1 completion parks a join barrier waiting for N2');

			// 3. N2 completes -> join barrier releases a waiting Gate token
			const n2Current = await callAsEmployee<{ readonly tokens: ReadonlyArray<{ readonly id: string }> }>(empN2.id, 'token.current', { mission: created.id });
			assert.strictEqual(n2Current.tokens.length, 1);
			const completedN2 = await callAsEmployee<{ readonly ok: boolean; readonly nextTokenIds?: readonly string[] }>(empN2.id, 'token.complete', {
				mission: created.id,
				tokenId: n2Current.tokens[0].id,
				summary: 'Core engine built',
			});
			assert.strictEqual(completedN2.ok, true);
			assert.strictEqual((completedN2.nextTokenIds ?? []).length, 1, 'Join barrier releases exactly one Gate token');
			assert.strictEqual(Object.keys(missionRuntime.getRuntimeState(created.id).joinBarriers).length, 0);

			const statusAtGate = await h.control<{ readonly waitingGateCount: number }>('mission.status', { mission: created.id });
			assert.strictEqual(statusAtGate.waitingGateCount, 1);

			// 4. Gate approve -> N3 token; employee reject -> bounced back to the Gate
			const gate1 = await h.control<{ readonly nextTokenIds: readonly string[] }>('mission.gate', { mission: created.id, node: 'U1', decision: 'approve', note: 'Ship it' });
			assert.strictEqual(gate1.nextTokenIds.length, 1);
			const n3First = await callAsEmployee<{ readonly tokens: ReadonlyArray<{ readonly id: string }> }>(empN3.id, 'token.current', { mission: created.id });
			assert.strictEqual(n3First.tokens.length, 1);
			const rejected = await callAsEmployee<{ readonly ok: boolean; readonly bouncedTokenId: string; readonly targetNodeId: string }>(empN3.id, 'token.reject', {
				mission: created.id,
				tokenId: n3First.tokens[0].id,
				reason: 'Release notes missing',
			});
			assert.strictEqual(rejected.ok, true);
			assert.strictEqual(rejected.targetNodeId, 'U1', 'Reject bounces upstream to the Gate without a backward Mermaid arrow');

			// 5. Gate approve again -> N3 token; employee fail -> freeze & escalate to off-graph supervisor
			const gate2 = await h.control<{ readonly nextTokenIds: readonly string[] }>('mission.gate', { mission: created.id, node: 'U1', decision: 'approve' });
			assert.strictEqual(gate2.nextTokenIds.length, 1);
			const n3Again = await callAsEmployee<{ readonly tokens: ReadonlyArray<{ readonly id: string }> }>(empN3.id, 'token.current', { mission: created.id });
			assert.strictEqual(n3Again.tokens.length, 1);
			const failed = await callAsEmployee<{
				readonly ok: boolean;
				readonly escalatedToSupervisorId?: string;
				readonly escalatedToInbox?: boolean;
			}>(empN3.id, 'token.fail', { mission: created.id, tokenId: n3Again.tokens[0].id, reason: 'Missing production credentials' });
			assert.strictEqual(failed.ok, true);
			assert.strictEqual(failed.escalatedToSupervisorId, mgr.id, 'Failure without a fail-edge escalates to the bound off-graph supervisor');
			assert.ok(!failed.escalatedToInbox);

			// 6. Off-graph recall clears the frozen failure
			const recalled = await h.control<{ readonly ok: boolean; readonly recalledTokenIds: readonly string[] }>('mission.recall', { mission: created.id, reason: 'Reset failed release node' });
			assert.strictEqual(recalled.ok, true);
			assert.ok(recalled.recalledTokenIds.includes(n3Again.tokens[0].id));

			// 7. Standalone non-Mission pure Worker is denied token & patch access
			const pureWorker = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/pure-runtime-worker') }, 'Pure Worker', { role: 'worker' });
			await assert.rejects(
				() => h.control('token.current', { mission: created.id, caller: 'worker', _verifiedCaller: true, _callerSessionId: pureWorker.id }),
				/pure execution|FORBIDDEN/i,
				'Standalone pure Worker cannot read Mission tokens',
			);
			await assert.rejects(
				() => h.control('mission.patch', {
					mission: created.id,
					mermaid: 'flowchart LR\n  N9["Hijack"]',
					caller: 'worker',
					_verifiedCaller: true,
					_callerSessionId: pureWorker.id,
				}),
				/Permission denied|FORBIDDEN/i,
				'Standalone pure Worker cannot patch the Mission DAG',
			);
		});

		test('enforces strictly top-down org.* APIs (org.send upward is forbidden; org.subordinates/org.context flow downward)', async () => {
			const { h } = createMissionHarness();
			const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/org-gov') }, 'Org Gov', { role: 'governor' });
			const mgr = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/org-mgr') }, 'Org Mgr', { parentId: gov.id, role: 'manager' });
			const emp = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/org-emp') }, 'Org Emp', { parentId: mgr.id, role: 'employee' });

			// Subordinate (L3) -> supervisor (L1) is an upward message and MUST be rejected.
			await assert.rejects(
				() => h.control('org.send', {
					target: gov.id,
					message: 'Status report',
					caller: 'employee',
					_verifiedCaller: true,
					_callerSessionId: emp.id,
				}),
				/UPWARD_MESSAGE_FORBIDDEN/,
				'Strictly top-down: an L3 employee cannot message an L1 governor',
			);

			// Supervisor (L1) -> downward inspection succeeds.
			const subs = await h.control<{ readonly supervisorId: string; readonly directSubordinates: ReadonlyArray<{ readonly id: string; readonly tier: number }> }>('org.subordinates', {
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: gov.id,
			});
			assert.strictEqual(subs.supervisorId, gov.id);
			assert.ok(subs.directSubordinates.some(sub => sub.id === mgr.id), 'L1 lists its direct L2 subordinate');
			assert.ok(!subs.directSubordinates.some(sub => sub.id === emp.id), 'L3 grandchild is not a direct subordinate');

			const ctx = await h.control<{ readonly agentId: string; readonly label: string; readonly role: string }>('org.context', {
				target: emp.id,
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: gov.id,
			});
			assert.strictEqual(ctx.agentId, emp.id);
			assert.strictEqual(ctx.label, 'Org Emp');
			assert.strictEqual(ctx.role, 'employee');
		});

		test('rejects dangling Mission patches atomically, then applies replacements, source triggers, and SSH host binding', async () => {
			const { h, missionStore } = createMissionHarness();
			const cloudHost: IAdeCloudHost = {
				id: 'host-gpu',
				name: 'GPU Host',
				alias: 'gpu-ssh',
				hostName: 'gpu.example.com',
				port: 22,
				os: 'linux',
				defaultDirectory: '/workspace/repo',
				recentDirectories: ['/workspace/repo'],
				source: 'user',
				createdAt: 1,
				updatedAt: 2,
			};
			h.instantiation.stub(IAdeCloudHostBackendService, upcastPartial<IAdeCloudHostBackendService>({
				_serviceBrand: undefined,
				onDidChangeHosts: Event.None,
				getHost: async () => cloudHost,
			}));

			const originalMermaid = 'flowchart LR\n  N1["Design"] --> N2["Build"]\n  N2 --> N3["Ship"]';
			const { created } = await seedMission(h, 'Safe Patch', originalMermaid);
			assert.strictEqual(missionStore.getMission(created.id)?.mermaidText, originalMermaid);

			// Removing intermediate N2 while leaving N3 without any incoming path is a hard anti-dangling violation.
			await assert.rejects(
				() => h.control('mission.patch', {
					mission: created.id,
					mermaid: 'flowchart LR\n  N1["Design"]\n  N3["Ship"]',
					reason: 'Drop intermediate build step',
				}),
				/DANGLING_NODE_VIOLATION|Anti-dangling/i,
			);
			assert.strictEqual(missionStore.getMission(created.id)?.mermaidText, originalMermaid, 'Rejected patch is atomic: Mission text is unchanged');

			// Atomic replacement patch: remove N2 and add N1 -> N3 in the same edit.
			const replacementMermaid = 'flowchart LR\n  N1["Design"] --> N3["Ship"]';
			const patched = await h.control<{
				readonly ok: boolean;
				readonly removedNodes: readonly string[];
				readonly addedEdges: readonly string[];
			}>('mission.patch', { mission: created.id, mermaid: replacementMermaid, reason: 'Atomic replacement route' });
			assert.strictEqual(patched.ok, true);
			assert.deepStrictEqual(patched.removedNodes, ['N2']);
			assert.ok(patched.addedEdges.includes('N1->N3'), 'Replacement edge N1->N3 is created in the same patch');
			assert.strictEqual(missionStore.getMission(created.id)?.mermaidText, replacementMermaid, 'Successful patch persists the new Mermaid text');

			// Source triggers only attach to inDegree === 0 generator nodes.
			const trigger = await h.control<{ readonly ok: boolean; readonly trigger: { readonly nodeId: string; readonly kind: string; readonly intervalMs?: number } }>('mission.trigger.set', {
				mission: created.id,
				node: 'N1',
				kind: 'interval',
				interval: '30s',
			});
			assert.strictEqual(trigger.ok, true);
			assert.strictEqual(trigger.trigger.nodeId, 'N1');
			assert.strictEqual(trigger.trigger.intervalMs, 30_000);
			await assert.rejects(
				() => h.control('mission.trigger.set', { mission: created.id, node: 'N3', kind: 'interval', interval: '30s' }),
				/inDegree = 0/i,
				'Downstream node N3 (inDegree > 0) cannot host a source trigger',
			);

			// Bind N1 to an SSH Cloud Host alias; the node employee's project URI becomes aexus-ssh://gpu-ssh/...
			const empN1 = employeesByNode(missionStore, created.id).get('N1')!;
			const bound = await h.control<{
				readonly ok: boolean;
				readonly assignment: { readonly agentId?: string; readonly hostAlias: string; readonly remoteProjectPath?: string };
			}>('mission.host.bind', { mission: created.id, node: 'N1', host: 'gpu-ssh' });
			assert.strictEqual(bound.ok, true);
			assert.strictEqual(bound.assignment.hostAlias, 'gpu-ssh');
			assert.strictEqual(bound.assignment.remoteProjectPath, '/workspace/repo');
			assert.strictEqual(bound.assignment.agentId, empN1.id);
			const boundAgent = h.projects.getAgent(empN1.id)!;
			assert.strictEqual(boundAgent.projectUri.scheme, AEXUS_SSH_SCHEME);
			assert.strictEqual(boundAgent.projectUri.authority, 'gpu-ssh');
			assert.strictEqual(boundAgent.projectUri.path, '/workspace/repo');
		});

		test('allows bound off-graph supervisors and L0 Secretary to read Mission blueprints (while keeping writes owner-only), injects v2 off-graph supervisor prompts, and dispatches the first token on newly patched live nodes', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const govOwner = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/sup-read-gov') }, 'Owner L1', { role: 'governor' });
			const mgrBound = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/sup-read-mgr-bound') }, 'Bound Sup L2', { parentId: govOwner.id, role: 'manager' });
			const mgrOutsider = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/sup-read-mgr-peer') }, 'Outsider L2', { parentId: govOwner.id, role: 'manager' });

			const initialMermaid = 'flowchart LR\n  P["Plan"] --> A["Build v1"]\n  A --> B["Verify"]';
			const created = await h.control<{ readonly id: string }>('mission.init', {
				owner: govOwner.id,
				title: 'Live Patch & Sup Read',
				mermaid: initialMermaid,
			});

			// Place initial generated in-graph employees strictly inside L3 (> offGraphMaxTier=2), then bind mgrBound as L2 off-graph supervisor
			for (const emp of missionStore.getGeneratedEmployees(created.id)) {
				h.projects.setAgentRole(emp.id, 'employee', { allowLockedMissionEmployee: true });
			}
			const boundarySet = await h.control<{ readonly ok: boolean }>('mission.boundary.set', {
				mission: created.id,
				offGraphMaxTier: 2,
				supervisors: [
					{ id: govOwner.id, tier: 1, managedNodeIds: ['P', 'A', 'B'] },
					{ id: mgrBound.id, tier: 2, managedNodeIds: ['A', 'B'], parentSupervisorId: govOwner.id },
				],
			});
			assert.strictEqual(boundarySet.ok, true);

			// 1. Bound off-graph supervisor (mgrBound) & L0 Secretary CAN read topology (`mission.get` & `mission.blueprint.get --raw`), even omitting --mission!
			const supRaw = await h.control<string>('mission.blueprint.get', {
				raw: true,
				caller: 'manager',
				_verifiedCaller: true,
				_callerSessionId: mgrBound.id,
			});
			assert.strictEqual(supRaw, initialMermaid, 'Bound off-graph supervisor can read Mermaid DAG without owner-only lockout');
			const supGet = await h.control<{ readonly id: string; readonly canOperate: boolean; readonly mermaidText: string }>('mission.get', {
				mission: created.id,
				caller: 'manager',
				_verifiedCaller: true,
				_callerSessionId: mgrBound.id,
			});
			assert.strictEqual(supGet.id, created.id);
			assert.strictEqual(supGet.canOperate, false);
			assert.strictEqual(supGet.mermaidText, initialMermaid);

			const secRead = await h.control<string>('mission.blueprint.get', {
				mission: created.id,
				raw: true,
				caller: 'secretary',
			});
			assert.strictEqual(secRead, initialMermaid, 'L0 Secretary can read Mission topology');

			// Owner-only structural writes remain blocked for non-owner bound supervisor; unrelated peers & in-graph employees remain denied reads!
			await assert.rejects(
				() => h.control('mission.blueprint.apply', { id: created.id, text: initialMermaid, caller: 'manager', _verifiedCaller: true, _callerSessionId: mgrBound.id }),
				/owned by/i,
			);
			await assert.rejects(
				() => h.control('mission.blueprint.get', { id: created.id, caller: 'manager', _verifiedCaller: true, _callerSessionId: mgrOutsider.id }),
				/Permission denied/i,
			);
			const empP = employeesByNode(missionStore, created.id).get('P')!;
			await assert.rejects(
				() => h.control('mission.blueprint.get', { id: created.id, caller: 'employee', _verifiedCaller: true, _callerSessionId: empP.id }),
				/Permission denied/i,
			);

			// 2. Bound off-graph supervisor (without treeType) receives clean v2 Off-Graph Supervisor prompt (zero v1 dogma)!
			const supPrompt = h.resolvePrompt({ agentId: mgrBound.id })!;
			assert.ok(supPrompt.includes('Off-Graph Supervisor (L2) Operations'), supPrompt);
			assert.ok(supPrompt.includes(`aexus-ade mission blueprint get --mission ${created.id} --raw`), supPrompt);
			assert.ok(supPrompt.includes('managed nodes: A, B'), supPrompt);
			assert.ok(supPrompt.includes('aexus-ade docs read L2'), supPrompt);
			assert.ok(supPrompt.includes('aexus-ade api update --since 0 --json'), supPrompt);
			assert.ok(!supPrompt.includes('Employee ≠ Worker'));
			assert.ok(!supPrompt.includes('module/segment delivery'));
			assert.ok(!supPrompt.includes('report concise outcomes upward'));

			// 3. LIVE PATCH ADDING A BRAND-NEW READY NODE (`A2`) MUST DISPATCH ITS FIRST TOKEN TO THE NEWLY CREATED EMPLOYEE (NEVER DROP IT)!
			await h.control('mission.start', { mission: created.id });
			const empA = employeesByNode(missionStore, created.id).get('A')!;
			const pTok = missionRuntime.getCurrentTokens(empP.id, created.id)[0];
			assert.ok(pTok, 'P holds initial active token');
			await h.control('token.complete', { mission: created.id, tokenId: pTok.id, summary: 'Plan ready', caller: 'employee', _verifiedCaller: true, _callerSessionId: empP.id });
			const aTok = missionRuntime.getCurrentTokens(empA.id, created.id)[0];
			assert.ok(aTok, 'A holds active token after P completes');
			await h.control('token.fail', { mission: created.id, tokenId: aTok.id, reason: 'Legacy build tool broken', caller: 'employee', _verifiedCaller: true, _callerSessionId: empA.id });

			const dispatchCountBeforePatch = h.executedCommands.filter(c => c.id === 'aexus.agentEngines.dispatchEngineeringTurn').length;
			const patchedMermaid = 'flowchart LR\n  P["Plan"] --> A2["Build v2"]\n  A2 --> B["Verify"]';
			const patched = await h.control<{ readonly ok: boolean; readonly addedNodes: readonly string[]; readonly removedNodes: readonly string[] }>('mission.patch', {
				mission: created.id,
				mermaid: patchedMermaid,
				reason: 'Replace failed A with brand-new A2',
				caller: 'manager',
				_verifiedCaller: true,
				_callerSessionId: mgrBound.id,
			});
			assert.strictEqual(patched.ok, true);
			assert.deepStrictEqual(patched.addedNodes, ['A2']);
			assert.deepStrictEqual(patched.removedNodes, ['A']);

			const empA2 = employeesByNode(missionStore, created.id).get('A2');
			assert.ok(empA2, 'Live patch synchronously creates sidebar employee for brand-new node A2');
			assert.strictEqual(empA2!.role, 'employee', 'Newly patched node employee respects offGraphMaxTier=2 and spawns at L3 (in-graph)');
			const a2Tokens = missionRuntime.getCurrentTokens(empA2!.id, created.id);
			assert.strictEqual(a2Tokens.length, 1, 'New node A2 holds its live first token (not dropped or frozen_failed)');
			assert.strictEqual(a2Tokens[0].status, 'active', 'A2 first token MUST remain active, never frozen_failed as unassigned');
			assert.strictEqual(a2Tokens[0].holderAgentId, empA2!.id, 'A2 token holderAgentId is hydrated with newly created employee ID');
			assert.ok(a2Tokens[0].lastSummary.includes('Plan ready'), 'A2 inherits completed upstream summary');

			const dispatchesAfterPatch = h.executedCommands
				.slice(dispatchCountBeforePatch)
				.filter(c => c.id === 'aexus.agentEngines.dispatchEngineeringTurn');
			const dispatchedToA2 = dispatchesAfterPatch.some(cmd => {
				const opts = cmd.args[2] as { agentId?: string; nodeId?: string } | undefined;
				return opts?.agentId === empA2!.id && opts?.nodeId === 'A2';
			});
			assert.strictEqual(dispatchedToA2, true, 'Live patch MUST actually dispatch the first token turn to newly created A2 employee');

			// Verify A2 employee can complete its first token and advance cleanly to B!
			const completeA2 = await h.control<{ readonly ok: boolean; readonly nextTokenIds: readonly string[] }>('token.complete', {
				mission: created.id,
				tokenId: a2Tokens[0].id,
				summary: 'Build v2 succeeded',
				caller: 'employee',
				_verifiedCaller: true,
				_callerSessionId: empA2!.id,
			});
			assert.strictEqual(completeA2.ok, true);
			assert.strictEqual(completeA2.nextTokenIds.length, 1);
			const empB = employeesByNode(missionStore, created.id).get('B')!;
			assert.strictEqual(missionRuntime.getCurrentTokens(empB.id, created.id)[0]?.status, 'active');
		});

		test('renders minimal Mission canvas run controls, locked timeout, fail edges, Gate popover, and auto-redraws on patch (Section 6)', async () => {
			const h = createHarness([URI.file('/workspace/ui-demo')]);
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);

			const mermaid = [
				'flowchart LR',
				'  N1["Build"] --> G1{"Release Gate"}',
				'  N1 -->|fail| F1["Fallback"]',
				'  F1 --> G1',
			].join('\n');
			const created = missionStore.createMission({ title: 'Minimal UI', mermaidText: mermaid });
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));

			const host = append(document.body, $('.monaco-workbench.ade-mission-runtime-ui-host'));
			store.add({ dispose: () => host.remove() });
			const mockGroup = upcastPartial<IEditorGroup>({ id: 1, index: 0 });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
			pane.create(host);
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			const runBar = host.querySelector<HTMLElement>('[data-ade-mission-run-bar="true"]')!;
			const primaryBtn = host.querySelector<HTMLButtonElement>('[data-ade-mission-run-primary="true"]')!;
			const stopBtn = host.querySelector<HTMLButtonElement>('[data-ade-mission-run-stop="true"]')!;
			const timeoutInput = host.querySelector<HTMLInputElement>('[data-ade-mission-timeout-input="true"]')!;
			const failEdge = host.querySelector<SVGGElement>('g[data-edge-kind="fail"]');
			assert.ok(runBar && primaryBtn && stopBtn && timeoutInput, 'Minimal run bar and drawer config controls exist');
			assert.ok(failEdge, 'Fail edge renders with data-edge-kind="fail"');
			assert.strictEqual(timeoutInput.disabled, false, 'Timeout input is editable before Mission starts');
			assert.strictEqual(stopBtn.hidden, true, 'Stop button is hidden while idle');

			// Start via runtime control -> run bar reflects Running, timeout locks, N1 enters state-active
			await missionRuntime.start(created.id, { silenceTimeoutMinutes: 7 });
			assert.strictEqual(runBar.dataset.status, 'running');
			assert.strictEqual(timeoutInput.value, '7');
			assert.strictEqual(timeoutInput.disabled, true, 'Silence timeout locks once Mission starts');
			assert.strictEqual(stopBtn.hidden, false);
			assert.ok(host.querySelector('.ade-mission-node[data-node-id="N1"].state-active'), 'Active node N1 receives state-active highlight');

			// Live DAG editing NEVER auto-commits on blur and NEVER wipes the user's draft on validation failure!
			// Explicit commit via Apply Patch / Cmd+Enter rejects dangling edits while preserving user draft until edited or explicitly Reverted.
			const textarea = host.querySelector<HTMLTextAreaElement>('[data-ade-mission-mermaid-input="true"]')!;
			const applyPatchBtn = host.querySelector<HTMLButtonElement>('[data-ade-mission-apply-patch="true"]')!;
			const revertPatchBtn = host.querySelector<HTMLButtonElement>('[data-ade-mission-revert-patch="true"]')!;
			const validBefore = missionStore.getMission(created.id)!.mermaidText;
			const danglingDraft = 'flowchart LR\n  N1["Build"]\n  G1{"Release Gate"}';
			textarea.value = danglingDraft;
			textarea.dispatchEvent(new (textarea.ownerDocument.defaultView!.Event)('input', { bubbles: true }));
			assert.strictEqual(missionStore.getMission(created.id)!.mermaidText, validBefore, 'Live keystroke must NOT mutate live Mission Mermaid');
			assert.strictEqual(textarea.value, danglingDraft, 'Live keystroke must NOT wipe user typing before explicit commit');
			// Blurring textarea must NOT auto-submit or overwrite user draft
			textarea.dispatchEvent(new (textarea.ownerDocument.defaultView!.Event)('blur'));
			await new Promise(resolve => setTimeout(resolve, 30));
			assert.strictEqual(missionStore.getMission(created.id)!.mermaidText, validBefore, 'Blur must NOT auto-commit live DAG patch');
			assert.strictEqual(textarea.value, danglingDraft, 'Blur must preserve unsaved live draft');
			// Explicit Apply Patch triggers patchMermaid -> dangling edit is rejected while preserving user draft for editing!
			applyPatchBtn.click();
			await new Promise(resolve => setTimeout(resolve, 30));
			assert.strictEqual(missionStore.getMission(created.id)!.mermaidText, validBefore, 'Dangling live edit must be rejected on explicit Apply Patch');
			assert.strictEqual(textarea.value, danglingDraft, 'Rejected live edit MUST preserve user draft in textarea instead of overwriting it');
			// Explicit Revert button restores the committed Mermaid graph cleanly
			revertPatchBtn.click();
			assert.strictEqual(textarea.value, validBefore, 'Explicit Revert restores committed Mermaid graph');

			// P1-12: Clicking node employee pill opens popover containing the compact Off-graph Supervisor selector
			const empPill = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"] .ade-mission-emp-pill');
			assert.ok(empPill, 'Node N1 renders employee pill');
			empPill.click();
			const supSelect = host.querySelector<HTMLSelectElement>('select[data-ade-node-supervisor-select="N1"]');
			assert.ok(supSelect, 'Node popover exposes compact Off-graph Supervisor selector (§6.1)');
			supSelect.value = ADE_SECRETARY_ID;
			supSelect.dispatchEvent(new (supSelect.ownerDocument.defaultView!.Event)('change', { bubbles: true }));
			await new Promise(resolve => setTimeout(resolve, 20));
			const boundSup = missionRuntime.getRuntimeState(created.id).boundary.supervisors.find(s => s.id === ADE_SECRETARY_ID);
			assert.ok(boundSup?.managedNodeIds.includes('N1'), 'Selecting a supervisor persists node binding in mission boundary');

			// Complete N1 -> Gate G1 transitions to state-waiting-gate; clicking G1 opens Approve/Reject popover
			const activeTok = Object.values(missionRuntime.getRuntimeState(created.id).tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
			await missionRuntime.completeToken(created.id, { tokenId: activeTok.id, summary: 'Build artifact verified.' });
			const gateEl = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="G1"].state-waiting-gate');
			assert.ok(gateEl, 'Waiting Gate card receives state-waiting-gate highlight');

			const win = gateEl.ownerDocument.defaultView!;
			gateEl.dispatchEvent(new win.PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 20, bubbles: true }));
			gateEl.dispatchEvent(new win.PointerEvent('pointerup', { button: 0, clientX: 20, clientY: 20, bubbles: true }));
			const approveBtn = host.querySelector<HTMLButtonElement>('button[data-ade-gate-approve="G1"]');
			assert.ok(approveBtn, 'Clicking waiting Gate card opens inline Approve/Reject popover');
			approveBtn.click();
			await new Promise(resolve => setTimeout(resolve, 15));
			assert.strictEqual(missionRuntime.getRuntimeState(created.id).status, 'completed', 'Approving Gate completes the Mission');

			// Patch Mermaid -> canvas automatically redraws new node N9 without manual refresh
			const patchedMermaid = `${mermaid}\n  G1 --> N9["Deploy"]`;
			await missionRuntime.patchMermaid(created.id, { caller: { isHumanUser: true }, newMermaidText: patchedMermaid, reason: 'Add deploy step' });
			assert.ok(host.querySelector('.ade-mission-node[data-node-id="N9"]'), 'Canvas auto-redraws newly patched node N9');
		});

		test('renders Armored Pod clamps, OS brand icons per host, cross-host edges, and 1-click host picker', async () => {
			const h = createHarness();
			const ubuntuHost: IAdeCloudHost = {
				id: 'h-ubuntu',
				name: 'ubuntu-target1',
				alias: 'ubuntu-target1',
				hostName: '10.0.0.11',
				port: 22,
				user: 'lab',
				os: 'linux',
				defaultDirectory: '/home/lab',
				recentDirectories: ['/home/lab'],
				source: 'user',
				createdAt: 1,
				updatedAt: 1,
				lastTestStatus: { ok: true, remoteUname: 'Linux (ubuntu)', checkedAt: 1, latencyMs: 12 },
			};
			const kaliHost: IAdeCloudHost = {
				id: 'h-kali',
				name: 'kali-Linux1',
				alias: 'kali-Linux1',
				hostName: '10.0.0.12',
				port: 22,
				user: 'kali',
				os: 'linux',
				defaultDirectory: '/home/kali',
				recentDirectories: ['/home/kali'],
				source: 'user',
				createdAt: 1,
				updatedAt: 1,
				lastTestStatus: { ok: true, remoteUname: 'Linux (kali)', checkedAt: 1, latencyMs: 15 },
			};
			const winHost: IAdeCloudHost = {
				id: 'h-win',
				name: 'BUPT-Windows',
				alias: 'BUPT-Windows',
				hostName: '10.0.0.13',
				port: 22,
				user: 'djf',
				os: 'windows',
				defaultDirectory: '/C:/Users/djf',
				recentDirectories: ['/C:/Users/djf'],
				source: 'user',
				createdAt: 1,
				updatedAt: 1,
			};
			const allHosts: readonly IAdeCloudHost[] = [ubuntuHost, kaliHost, winHost];
			h.instantiation.stub(IAdeCloudHostBackendService, upcastPartial<IAdeCloudHostBackendService>({
				listHosts: async () => allHosts,
				getHost: async (idOrAlias: string) => allHosts.find(x => x.alias === idOrAlias || x.id === idOrAlias),
			}));
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);

			const mermaid = [
				'flowchart LR',
				'  N1["@Architect: Spec"] --> N2["@Backend: API"]',
				'  N2 --> N3["@RedTeam: Audit"]',
				'  N2 --> N4["@WinClient: Native Build"]',
			].join('\n');
			const created = missionStore.createMission({ title: 'Cross-Cloud Armor', mermaidText: mermaid });
			await missionRuntime.bindNodeHost(created.id, 'N2', { hostAlias: 'ubuntu-target1' });
			await missionRuntime.bindNodeHost(created.id, 'N3', { hostAlias: 'kali-Linux1' });
			await missionRuntime.bindNodeHost(created.id, 'N4', { hostAlias: 'BUPT-Windows' });

			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));
			const host = append(document.body, $('.monaco-workbench.ade-mission-armor-test-host'));
			store.add({ dispose: () => host.remove() });
			const mockGroup = upcastPartial<IEditorGroup>({ id: 1, index: 0 });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
			pane.create(host);
			await pane.setInput(input, undefined, {}, CancellationToken.None);
			await new Promise(resolve => setTimeout(resolve, 25));

			// Armored Pod anatomy: 4 L-corner clamps + recessed core well + sculpted LLM brand icon tile (distinct from bottom-left Agent Engine pill)
			const n2El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			assert.ok(n2El, 'Node N2 renders');
			assert.strictEqual(n2El.querySelectorAll('.ade-mission-clamp').length, 4, 'Armored Pod renders 4 L-corner clamps');
			assert.ok(n2El.querySelector('.ade-mission-core-well .ade-mission-core-icon-well .ade-mission-llm-icon > svg'), 'Recessed core well renders sculpted driving LLM brand SVG icon');
			assert.ok(n2El.querySelector('.ade-mission-engine-pill .ade-mission-engine-icon'), 'Bottom-left pill preserves Agent Engine icon');
			assert.ok(n2El.querySelector('.ade-mission-rank-pill')?.textContent?.includes('L'), 'Armored Pod renders Rank/Tier pill');
			assert.ok(n2El.querySelector('.ade-mission-core-model-row')?.getAttribute('data-node-model'), 'Armored Pod renders Model ID');
			assert.ok(n2El.querySelector('.ade-mission-thinking-tag'), 'Armored Pod renders Thinking Effort tag');
			assert.strictEqual(n2El.querySelectorAll('.ade-mission-ctx-track .ade-ctx-seg').length, 4, 'Armored Pod renders 4-segment context progress bar');
			assert.strictEqual(n2El.querySelector('.ade-mission-host-name')?.textContent, 'ubuntu-target1', 'Host pill shows exact Cloud Host name');

			// Live turn usage updates the 4-color Context Window Progress Bar, model readout, and driving LLM brand icon in real time
			const n2AgentId = missionRuntime.getRuntimeState(created.id).boundary.nodeAssignments.N2?.agentId;
			assert.ok(n2AgentId, 'N2 is linked to a generated employee agent');
			missionRuntime.recordTurnUsageBySessionResource(n2AgentId, {
				inputTokens: 42_000,
				outputTokens: 6_000,
				totalTokens: 48_000,
				costUsd: 0.14,
				model: 'gpt-5.3-codex',
				summary: '分布式状态机与云端存储接口已就绪',
			});
			const n2AfterUsage = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			const ctxRow = n2AfterUsage.querySelector<HTMLElement>('.ade-mission-ctx-row')!;
			assert.strictEqual(Number(ctxRow.dataset.nodeContextMax), 400_000, 'gpt-5.3-codex uses real 400k context window');
			assert.strictEqual(Number(ctxRow.dataset.nodeContextPct), 12, `Context bar percentage updates live for 48k/400k (got ${ctxRow.dataset.nodeContextPct}%)`);
			assert.strictEqual(n2AfterUsage.querySelector('.ade-mission-core-model-row')?.getAttribute('data-node-model'), 'gpt-5.3-codex');
			assert.strictEqual(n2AfterUsage.querySelector('.ade-mission-core-icon-well')?.getAttribute('data-llm-provider'), 'openai', 'GPT model switches big core icon to OpenAI GPT brand icon');
			assert.strictEqual(n2AfterUsage.querySelector('.ade-mission-core-context')?.textContent, '分布式状态机与云端存储接口已就绪');

			// Clicking the big LLM core icon tile opens ONLY Model & Thinking popover (NO Agent Engine switcher, NO duplicate sections even on rapid double-click):
			// 1) For default Claude Code engine, ONLY Claude is lit & selectable; DeepSeek/GPT/Gemini/Qwen/Kimi/GLM/Grok are dimmed & disabled
			const n2CoreLlmTile = n2AfterUsage.querySelector<HTMLButtonElement>('.ade-mission-core-icon-well')!;
			n2CoreLlmTile.click();
			n2CoreLlmTile.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			assert.strictEqual(host.querySelector('[data-ade-mission-emp-popover="true"]')?.getAttribute('data-popover-kind'), 'model', 'Center LLM icon opens model-only popover');
			assert.strictEqual(host.querySelectorAll('button[data-ade-engine-option]').length, 0, 'Center LLM icon popover MUST NOT include Agent Engine options');
			assert.strictEqual(host.querySelectorAll('[data-ade-vendor-models-tray="true"]').length, 1, 'Rapid double-click NEVER duplicates popover sections');
			assert.strictEqual(host.querySelector('input[data-ade-model-input]'), null, 'Model picker has no manual text input');
			assert.strictEqual(host.querySelector('button[data-ade-model-dropdown]'), null, 'Model picker has no collapsible dropdown bar that causes popover jumping');
			const modelTray = host.querySelector<HTMLElement>('[data-ade-vendor-models-tray="true"]')!;
			assert.ok(modelTray && !modelTray.hidden, 'Scrollable concrete model window is visible immediately on open');
			assert.ok(host.querySelector('button[data-ade-model-option="claude-opus-4-6"]'), 'Scrollable window immediately shows native Claude models on open');

			const dsVendorOnClaude = host.querySelector<HTMLButtonElement>('button[data-ade-vendor="deepseek"]');
			const claudeVendorOnClaude = host.querySelector<HTMLButtonElement>('button[data-ade-vendor="anthropic"]');
			assert.ok(dsVendorOnClaude && dsVendorOnClaude.disabled && dsVendorOnClaude.classList.contains('is-unsupported'), 'Unsupported vendor DeepSeek is dimmed & disabled on Claude Code');
			assert.ok(claudeVendorOnClaude && !claudeVendorOnClaude.disabled && !claudeVendorOnClaude.classList.contains('is-unsupported'), 'Native vendor Claude is lit & selectable on Claude Code');

			// Verify zero icon/label clipping on all 8 vendor chips (especially DeepSeek whale icon + text)
			for (const vBtn of host.querySelectorAll<HTMLButtonElement>('button[data-ade-vendor]')) {
				const btnRect = vBtn.getBoundingClientRect();
				const icoRect = vBtn.querySelector<HTMLElement>('.ade-mission-llm-icon')!.getBoundingClientRect();
				const lblEl = vBtn.querySelector<HTMLElement>('.ade-mission-vendor-btn-label')!;
				assert.ok(icoRect.left >= btnRect.left - 0.5 && icoRect.right <= btnRect.right + 0.5, `Vendor ${vBtn.dataset.adeVendor} icon fits completely inside button without clipping`);
				assert.ok(lblEl.scrollWidth <= lblEl.clientWidth + 1, `Vendor ${vBtn.dataset.adeVendor} label ("${lblEl.textContent}") fits completely without truncation`);
			}

			// Selecting claude-sonnet-4-6 directly from the scrollable window updates the card live
			const sonnetOpt = host.querySelector<HTMLButtonElement>('button[data-ade-model-option="claude-sonnet-4-6"]');
			assert.ok(sonnetOpt && !sonnetOpt.disabled && sonnetOpt.dataset.adeModelSupported === 'true', 'Scrollable window exposes selectable concrete model claude-sonnet-4-6');
			sonnetOpt.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			const n2AfterSonnet = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			assert.strictEqual(n2AfterSonnet.querySelector('.ade-mission-core-model-row')?.getAttribute('data-node-model'), 'claude-sonnet-4-6');
			assert.strictEqual(n2AfterSonnet.querySelector('.ade-mission-core-icon-well')?.getAttribute('data-llm-provider'), 'anthropic');

			// 2) Switching N2 to Google Antigravity verifies full "Google Antigravity" name displays without ellipsis truncation,
			//    switching vendor tab inside the fixed-height scrollable window keeps popover top position rock-solid (zero upward jump!),
			//    and dims unsupported claude-haiku-4-5 inside Claude list
			h.projects.updateAgentEnginePreferences(n2AgentId, { preferredEngineId: 'aexus-antigravity', preferredModel: 'gemini-2.5-pro' });
			await new Promise(resolve => setTimeout(resolve, 25));
			const agyEngineNameEl = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"] .ade-mission-engine-name')!;
			assert.strictEqual(agyEngineNameEl.textContent, 'Google Antigravity');
			assert.ok(agyEngineNameEl.scrollWidth <= agyEngineNameEl.clientWidth + 1, 'Bottom-left Agent Engine pill displays full "Google Antigravity" without ellipsis truncation');
			host.querySelector<HTMLButtonElement>('.ade-mission-node[data-node-id="N2"] .ade-mission-core-icon-well')!.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			const popoverEl = host.querySelector<HTMLElement>('[data-ade-mission-emp-popover="true"]')!;
			const topBeforeSwitch = popoverEl.style.top;
			assert.strictEqual(host.querySelector<HTMLButtonElement>('button[data-ade-vendor="gemini"]')?.disabled, false, 'Antigravity natively supports Gemini');
			assert.strictEqual(host.querySelector<HTMLButtonElement>('button[data-ade-vendor="anthropic"]')?.disabled, false, 'Antigravity natively supports Claude');
			assert.strictEqual(host.querySelector<HTMLButtonElement>('button[data-ade-vendor="deepseek"]')?.disabled, true, 'Antigravity dims unsupported DeepSeek');
			host.querySelector<HTMLButtonElement>('button[data-ade-vendor="anthropic"]')!.click();
			assert.strictEqual(popoverEl.style.top, topBeforeSwitch, 'Switching vendor tab inside scrollable model window does NOT shift popover position upward');
			assert.strictEqual(host.querySelector<HTMLButtonElement>('button[data-ade-model-option="claude-opus-4-6"]')?.disabled, false, 'Antigravity supports claude-opus-4-6 inside Claude list');
			const haikuOnAgy = host.querySelector<HTMLButtonElement>('button[data-ade-model-option="claude-haiku-4-5"]');
			assert.ok(haikuOnAgy && haikuOnAgy.disabled && haikuOnAgy.classList.contains('is-unsupported'), 'Antigravity dims unsupported concrete model claude-haiku-4-5 inside Claude list');

			// 3) Switching N2 to multi-provider OpenCode lights up DeepSeek; clicking DeepSeek pops open DeepSeek models & selecting deepseek-r1 swaps big core icon to DeepSeek
			h.projects.updateAgentEnginePreferences(n2AgentId, { preferredEngineId: 'aexus-opencode', preferredModel: 'qwen3-coder' });
			await new Promise(resolve => setTimeout(resolve, 25));
			host.querySelector<HTMLButtonElement>('.ade-mission-node[data-node-id="N2"] .ade-mission-core-icon-well')!.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			const dsVendorOnOpenCode = host.querySelector<HTMLButtonElement>('button[data-ade-vendor="deepseek"]');
			assert.ok(dsVendorOnOpenCode && !dsVendorOnOpenCode.disabled, 'Multi-provider OpenCode lights up DeepSeek vendor');
			dsVendorOnOpenCode.click();
			const dsR1Opt = host.querySelector<HTMLButtonElement>('button[data-ade-model-option="deepseek-r1"]');
			assert.ok(dsR1Opt && !dsR1Opt.disabled, 'Clicking DeepSeek pops open concrete model deepseek-r1');
			dsR1Opt.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			const n2AfterDeepSeek = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			assert.strictEqual(n2AfterDeepSeek.querySelector('.ade-mission-core-model-row')?.getAttribute('data-node-model'), 'deepseek-r1');
			assert.strictEqual(n2AfterDeepSeek.querySelector('.ade-mission-core-icon-well')?.getAttribute('data-llm-provider'), 'deepseek', 'Switching model to deepseek-r1 swaps big core icon to DeepSeek');

			// Clicking middle LLM icon updates Thinking Effort live (still model-only popover)
			n2AfterDeepSeek.querySelector<HTMLButtonElement>('.ade-mission-core-icon-well')!.click();
			const highThinkingBtn = host.querySelector<HTMLButtonElement>('button[data-ade-thinking-option="high"]');
			assert.ok(highThinkingBtn, 'Center LLM icon popover exposes Thinking Effort level buttons');
			assert.strictEqual(host.querySelectorAll('button[data-ade-engine-option]').length, 0, 'Center LLM icon popover never renders Agent Engine options');
			highThinkingBtn.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			assert.strictEqual(
				host.querySelector('.ade-mission-node[data-node-id="N2"] .ade-mission-core-model-row')?.getAttribute('data-node-thinking'),
				'high',
				'Selecting high thinking updates node card live',
			);

			// Clicking bottom-left Engine pill when Idle opens ONLY Agent Engine switcher (NO model/thinking options, NO duplicate copies on rapid double-click)
			const n2EnginePillIdle = host.querySelector<HTMLButtonElement>('.ade-mission-node[data-node-id="N2"] .ade-mission-engine-pill')!;
			assert.strictEqual(n2EnginePillIdle.disabled, false, 'Engine pill is editable before Mission starts');
			n2EnginePillIdle.click();
			n2EnginePillIdle.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			assert.strictEqual(host.querySelector('[data-ade-mission-emp-popover="true"]')?.getAttribute('data-popover-kind'), 'engine', 'Bottom-left engine pill opens engine-only popover');
			assert.ok(host.querySelectorAll('button[data-ade-engine-option]').length > 0, 'Engine popover lists Agent Engines');
			assert.strictEqual(host.querySelectorAll('.ade-mission-emp-popover-title').length, 1, 'Rapid double-click on engine pill NEVER renders duplicate sections');
			assert.strictEqual(host.querySelectorAll('button[data-ade-model-option]').length, 0, 'Engine popover MUST NOT mix in Model options');
			assert.strictEqual(host.querySelectorAll('button[data-ade-thinking-option]').length, 0, 'Engine popover MUST NOT mix in Thinking options');
			host.querySelector<HTMLButtonElement>('button[data-ade-engine-option]')!.click();
			await new Promise(resolve => setTimeout(resolve, 25));

			// OS brand icons & host attributes resolve per machine
			const n2Latest = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			assert.strictEqual(n2Latest.dataset.nodeHost, 'ubuntu-target1');
			assert.strictEqual(n2Latest.dataset.nodeOs, 'ubuntu');
			assert.ok(n2Latest.querySelector('.ade-mission-host-pill .ade-mission-os-icon.ade-os-ubuntu > svg'), 'Ubuntu node renders Ubuntu SVG brand icon');

			const n3El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N3"]')!;
			assert.strictEqual(n3El.dataset.nodeOs, 'kali');
			assert.ok(n3El.querySelector('.ade-mission-host-pill .ade-mission-os-icon.ade-os-kali > svg'), 'Kali node renders Kali SVG brand icon');

			const n4El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N4"]')!;
			assert.strictEqual(n4El.dataset.nodeOs, 'windows');
			assert.ok(n4El.querySelector('.ade-mission-host-pill .ade-mission-os-icon.ade-os-windows > svg'), 'Windows node renders Windows SVG brand icon');

			const n1El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			assert.strictEqual(n1El.dataset.nodeHost, 'local');
			assert.ok(n1El.querySelector('.ade-mission-host-pill .ade-mission-os-icon > svg'), 'Local node renders local OS SVG brand icon');

			// Cross-host edges glow cyan via data-cross-host="true"
			const crossEdge = host.querySelector<SVGGElement>('g[data-from="N1"][data-to="N2"]');
			assert.strictEqual(crossEdge?.getAttribute('data-cross-host'), 'true', 'Edge from Local to Ubuntu is marked cross-host');
			assert.ok(crossEdge?.classList.contains('is-cross-host'), 'Cross-host edge carries is-cross-host class');

			// Verify Mission Split Drawer: Left = Mermaid Orchestration, Right = Per-Node Pre-Prompts, and wakeup packages Pre-Prompt + Token info together!
			const dispatchedTurns: Array<{ readonly resource: string; readonly prompt: string }> = [];
			h.instantiation.stub(ICommandService, {
				onWillExecuteCommand: Event.None,
				onDidExecuteCommand: Event.None,
				executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
					if (id === 'aexus.agentEngines.dispatchEngineeringTurn') {
						dispatchedTurns.push({ resource: String(args[0] ?? ''), prompt: String(args[1] ?? '') });
					}
					return undefined as T;
				},
			});

			const fileBtn = host.querySelector<HTMLButtonElement>('[data-ade-mission-file-btn="true"]')!;
			fileBtn.click();
			assert.ok(host.querySelector('[data-ade-mission-mermaid-pane="true"]'), 'Split drawer renders Left Mermaid Orchestration pane');
			assert.ok(host.querySelector('[data-ade-mission-prompts-pane="true"]'), 'Split drawer renders Right Node Pre-Prompts pane');
			const n1PromptItem = host.querySelector<HTMLButtonElement>('[data-ade-prompt-node-item="N1"]')!;
			const n2PromptItem = host.querySelector<HTMLButtonElement>('[data-ade-prompt-node-item="N2"]')!;
			assert.ok(n1PromptItem && n2PromptItem, 'Right pane lists all non-gate DAG nodes');

			// Edit N1 and N2 Pre-Prompts in the right-hand editor
			const promptInput = host.querySelector<HTMLTextAreaElement>('[data-ade-node-prompt-input="true"]')!;
			const DomEvent = promptInput.ownerDocument.defaultView!.Event;
			n1PromptItem.click();
			promptInput.value = '产出 OpenAPI 3.1 契约并执行 schema lint，完成后提交摘要。';
			promptInput.dispatchEvent(new DomEvent('input', { bubbles: true }));
			n2PromptItem.click();
			promptInput.value = '在 ubuntu-target1 上实现 Go gRPC 接口并通过 go test ./...。';
			promptInput.dispatchEvent(new DomEvent('input', { bubbles: true }));

			assert.strictEqual(missionStore.getMission(created.id)?.nodePrompts?.N1, '产出 OpenAPI 3.1 契约并执行 schema lint，完成后提交摘要。');
			assert.strictEqual(missionStore.getMission(created.id)?.nodePrompts?.N2, '在 ubuntu-target1 上实现 Go gRPC 接口并通过 go test ./...。');
			assert.strictEqual(host.querySelector('[data-ade-prompt-node-item="N2"]')?.getAttribute('data-has-prompt'), 'true');
			assert.ok(host.querySelector('[data-ade-mission-prompt-count="true"]')?.textContent?.includes('2/4'));

			// Verify every node card displays its live Pre-Prompt preview + clickable Prompt button,
			// and editing via Node Prompt Popover <-> Top-Left Split Drawer shares the exact same IAdeMissionService database in real time!
			assert.strictEqual(host.querySelector('[data-ade-node-prompt-btn="N1"]')?.getAttribute('data-has-prompt'), 'true', 'N1 card reflects prompt written in top-left drawer');
			assert.ok(host.querySelector('[data-ade-node-prompt-preview="N1"]')?.textContent?.includes('产出 OpenAPI 3.1 契约'), 'N1 card displays live Pre-Prompt preview');
			assert.ok(host.querySelector('[data-ade-node-prompt-preview="N2"]')?.textContent?.includes('在 ubuntu-target1 上实现 Go gRPC'), 'N2 card displays live Pre-Prompt preview');

			// Click N2's node card Prompt button -> opens inline Node Prompt Popover pre-loaded from the same DB
			const n2PromptBtn = host.querySelector<HTMLButtonElement>('[data-ade-node-prompt-btn="N2"]')!;
			n2PromptBtn.click();
			assert.strictEqual(host.querySelector('[data-ade-mission-emp-popover="true"]')?.getAttribute('data-popover-kind'), 'prompt', 'Clicking node Prompt button opens inline Pre-Prompt popover');
			const n2PopoverTextarea = host.querySelector<HTMLTextAreaElement>('[data-ade-node-prompt-popover-input="N2"]')!;
			assert.strictEqual(n2PopoverTextarea.value, '在 ubuntu-target1 上实现 Go gRPC 接口并通过 go test ./...。', 'Popover loads exact prompt from shared missionStore');

			// Edit in N2's Node Prompt Popover -> immediately syncs to missionStore DB, N2 node card preview, AND top-left split drawer textarea!
			n2PopoverTextarea.value = '在 ubuntu-target1 上实现 Go gRPC 接口并通过 go test ./... 与 race 检查。';
			n2PopoverTextarea.dispatchEvent(new DomEvent('input', { bubbles: true }));
			assert.strictEqual(missionStore.getMission(created.id)?.nodePrompts?.N2, '在 ubuntu-target1 上实现 Go gRPC 接口并通过 go test ./... 与 race 检查。');
			assert.ok(host.querySelector('[data-ade-node-prompt-preview="N2"]')?.textContent?.includes('race 检查'), 'Popover edit live-updates N2 node card preview');
			assert.strictEqual(promptInput.value, '在 ubuntu-target1 上实现 Go gRPC 接口并通过 go test ./... 与 race 检查。', 'Popover edit live-syncs to top-left split drawer textarea');

			// Clicking "Open in Split Drawer" inside popover closes popover and opens top-left drawer focused on N2
			host.querySelector<HTMLButtonElement>('[data-ade-prompt-pop-open-drawer="N2"]')!.click();
			assert.strictEqual(host.querySelector<HTMLElement>('[data-ade-mission-emp-popover="true"]')?.hidden, true);
			assert.strictEqual(promptInput.dataset.activeNodeId, 'N2');

			// Start Mission & complete N1 -> verify BOTH N1 and N2 wakeups package their Pre-Prompt + live Token info together!
			const startRes = await missionRuntime.start(created.id);
			assert.strictEqual(startRes.ok, true, `Mission starts cleanly: ${startRes.error ?? ''}`);
			// Runtime invariant: while Mission is running, Agent Engine pill is LOCKED, while center LLM icon STILL switches Model & Thinking live!
			const n2RunningEnginePill = host.querySelector<HTMLButtonElement>('.ade-mission-node[data-node-id="N2"] .ade-mission-engine-pill')!;
			assert.strictEqual(n2RunningEnginePill.disabled, true, 'Agent Engine pill MUST be locked & disabled while Mission is running');
			assert.strictEqual(n2RunningEnginePill.getAttribute('data-engine-locked'), 'true', 'Agent Engine pill exposes data-engine-locked="true" during runtime');
			const n2RunningModelTile = host.querySelector<HTMLButtonElement>('.ade-mission-node[data-node-id="N2"] .ade-mission-core-icon-well')!;
			assert.strictEqual(n2RunningModelTile.disabled, false, 'Center LLM icon MUST remain enabled during runtime for live model switching');
			n2RunningModelTile.click();
			assert.strictEqual(host.querySelector('[data-ade-mission-emp-popover="true"]')?.getAttribute('data-popover-kind'), 'model', 'Center LLM icon opens model-only popover during runtime');
			assert.strictEqual(host.querySelectorAll('button[data-ade-engine-option]').length, 0, 'Model popover during runtime never exposes engine switching');
			host.querySelector<HTMLButtonElement>('button[data-ade-thinking-option="max"]')!.click();
			assert.strictEqual(
				host.querySelector('.ade-mission-node[data-node-id="N2"] .ade-mission-core-model-row')?.getAttribute('data-node-thinking'),
				'max',
				'Model/Thinking can be switched live while Mission is running',
			);
			const n1Dispatch = dispatchedTurns.find(d => d.prompt.includes('Node: `N1`'));
			assert.ok(n1Dispatch, 'Starting Mission dispatches wakeup prompt to N1');
			assert.ok(n1Dispatch.prompt.includes('### Node Pre-Prompt (`pre_prompt`)'), 'N1 wakeup includes Node Pre-Prompt section');
			assert.ok(n1Dispatch.prompt.includes('产出 OpenAPI 3.1 契约并执行 schema lint'), 'N1 wakeup packages N1 pre-prompt text');
			assert.ok(n1Dispatch.prompt.includes('aexus-ade token complete '), 'N1 wakeup packages Token completion command alongside pre-prompt');

			const n1Token = Object.values(missionRuntime.getRuntimeState(created.id).tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
			const compRes = await missionRuntime.completeToken(created.id, { tokenId: n1Token.id, summary: 'OpenAPI 契约已定稿' });
			assert.strictEqual(compRes.ok, true);
			const n2Dispatch = dispatchedTurns.find(d => d.prompt.includes('Node: `N2`'));
			assert.ok(n2Dispatch, 'Completing N1 dispatches wakeup prompt to N2');
			assert.ok(n2Dispatch.prompt.includes('在 ubuntu-target1 上实现 Go gRPC 接口并通过 go test ./...'), 'N2 wakeup packages N2 authored Pre-Prompt');
			assert.ok(n2Dispatch.prompt.includes('OpenAPI 契约已定稿'), 'N2 wakeup simultaneously packages upstream Token summary');
			assert.ok(n2Dispatch.prompt.includes('Token: `tok-'), 'N2 wakeup packages live Token ID');

			// Control API roundtrip for mission.prompt.list / get / set
			const setViaControl = await h.control<{ readonly ok: boolean; readonly prompt: string }>('mission.prompt.set', {
				mission: created.id,
				nodeId: 'N3',
				prompt: '部署至 BUPT-Windows 并检查事件日志',
			});
			assert.strictEqual(setViaControl.ok, true);
			assert.strictEqual(setViaControl.prompt, '部署至 BUPT-Windows 并检查事件日志');
			assert.ok(host.querySelector('[data-ade-node-prompt-preview="N3"]')?.textContent?.includes('部署至 BUPT-Windows'), 'Control API prompt update live-syncs to N3 node card preview');
			const gotViaControl = await h.control<{ readonly prompt: string }>('mission.prompt.get', { mission: created.id, nodeId: 'N3' });
			assert.strictEqual(gotViaControl.prompt, '部署至 BUPT-Windows 并检查事件日志');
			const listViaControl = await h.control<{ readonly nodePrompts: Record<string, string> }>('mission.prompt.list', { mission: created.id });
			assert.strictEqual(listViaControl.nodePrompts.N1, '产出 OpenAPI 3.1 契约并执行 schema lint，完成后提交摘要。');
			assert.strictEqual(listViaControl.nodePrompts.N3, '部署至 BUPT-Windows 并检查事件日志');

			// Close drawer & stop test run cleanly before host-pill assertion
			fileBtn.click();
			await missionRuntime.stop(created.id);

			// Clicking host pill opens Host & OS quick picker and switching host updates OS icon live
			const n1HostPill = host.querySelector<HTMLButtonElement>('.ade-mission-node[data-node-id="N1"] .ade-mission-host-pill')!;
			n1HostPill.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			const winOpt = host.querySelector<HTMLButtonElement>('button[data-ade-host-option="BUPT-Windows"]');
			assert.ok(winOpt, 'Clicking host pill opens Host & OS quick picker with saved cloud hosts');
			winOpt.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			const n1Updated = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			assert.strictEqual(n1Updated.dataset.nodeHost, 'BUPT-Windows');
			assert.strictEqual(n1Updated.dataset.nodeOs, 'windows');
		});

		test('enforces honest live-tier factory wall, blocks upward bypasses/non-human Gates, supports pure-rank Mission nodes & live safe-patch guard', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/sec-gov') }, 'Gov L1', { role: 'governor' });
			const mgr = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/sec-mgr') }, 'Mgr L2', { parentId: gov.id, role: 'manager' });
			const emp = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/sec-emp') }, 'Emp L3', { parentId: mgr.id, role: 'employee' });

			// 1. User-owned Mission assigns generated employees strictly on in-graph side (tier > 1) so factory wall holds without artificial clamping (P0-1)
			const mermaid = 'flowchart LR\n  N1["Build"] --> G1{"Gate"}\n  G1 --> N2["Ship"]';
			const userMission = missionStore.createMission({ title: 'User Wall', mermaidText: mermaid });
			const userEmps = employeesByNode(missionStore, userMission.id);
			const uN1 = userEmps.get('N1')!;
			const uN1Tier = missionRuntime.getBoundary(userMission.id).boundary.nodeAssignments.N1?.tier;
			assert.ok(uN1Tier !== undefined && uN1Tier > 1, `User-owned Mission employee must be tier > 1 (got ${uN1Tier})`);
			assert.strictEqual(missionRuntime.getBoundary(userMission.id).validation.valid, true);

			// Moving cutoff to L2 when in-graph employees are live L2 MUST fail validation (no silent rewrite!)
			const badCutoff = await missionRuntime.setBoundary(userMission.id, { offGraphMaxTier: 2 });
			assert.strictEqual(badCutoff.ok, false, 'Raising offGraphMaxTier across live L2 node employees must fail honestly');

			// Spoofing supervisor tier or unknown supervisor ID MUST fail validation
			const spoofedSup = await missionRuntime.setBoundary(userMission.id, {
				offGraphMaxTier: 1,
				supervisors: [{ id: emp.id, tier: 1, managedNodeIds: ['N1'] }],
			});
			assert.strictEqual(spoofedSup.ok, false, 'Spoofing an L3 employee as tier-1 supervisor must be rejected using live rank');
			const unknownSup = await missionRuntime.setBoundary(userMission.id, {
				offGraphMaxTier: 1,
				supervisors: [{ id: 'does-not-exist', tier: 1, managedNodeIds: ['N1'] }],
			});
			assert.strictEqual(unknownSup.ok, false, 'Unknown supervisor ID must be rejected');

			// 2. Partial-branch supervisor cannot start/stop whole Mission, and non-Human cannot sign a Human Gate (P1-1)
			const okPartial = await missionRuntime.setBoundary(userMission.id, {
				offGraphMaxTier: 1,
				supervisors: [{ id: gov.id, tier: 1, managedNodeIds: ['N1'] }],
			});
			assert.strictEqual(okPartial.ok, true);
			await assert.rejects(
				() => h.control('mission.start', { mission: userMission.id, caller: 'governor', _verifiedCaller: true, _callerSessionId: gov.id }),
				/FORBIDDEN|Permission denied/i,
				'Partial-jurisdiction supervisor cannot start the entire Mission',
			);

			// Human starts Mission; Secretary cannot forge in-graph token.complete (P1-2); non-Human cannot approve Gate (P1-1)
			await h.control('mission.start', { mission: userMission.id });
			const tokN1 = Object.values(missionRuntime.getRuntimeState(userMission.id).tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
			await assert.rejects(
				() => h.control('token.complete', { mission: userMission.id, tokenId: tokN1.id, summary: 'forged', caller: 'secretary', _verifiedCaller: true, _callerSessionId: ADE_SECRETARY_ID }),
				/FORBIDDEN/i,
				'Secretary (off-graph L0) cannot mutate in-graph tokens',
			);
			// In-graph node employee CANNOT call org.escalate (P0-3b)
			await assert.rejects(
				() => h.control('org.escalate', { mission: userMission.id, reason: 'sneak to human inbox', caller: uN1.role ?? 'manager', _verifiedCaller: true, _callerSessionId: uN1.id }),
				/FORBIDDEN/i,
				'In-graph employee cannot invoke org.escalate to reach Human Inbox',
			);
			// Verified non-Human caller cannot spoof --from on inbox.post (P0-3c)
			const posted = await h.control<{ readonly senderAgentId?: string }>('inbox.post', {
				from: gov.id,
				message: 'Check sender identity',
				caller: 'manager',
				_verifiedCaller: true,
				_callerSessionId: mgr.id,
			});
			assert.strictEqual(posted.senderAgentId, mgr.id, 'inbox.post forces verified caller identity instead of spoofed --from');

			// Complete N1 -> waiting_gate -> non-Human mission.gate & inbox.resolve(user_gate) are blocked (P1-1, P2-9)
			await h.control('token.complete', { mission: userMission.id, tokenId: tokN1.id, summary: 'N1 ready', caller: uN1.role ?? 'manager', _verifiedCaller: true, _callerSessionId: uN1.id });
			await assert.rejects(
				() => h.control('mission.gate', { mission: userMission.id, node: 'G1', decision: 'approve', caller: 'secretary', _verifiedCaller: true, _callerSessionId: ADE_SECRETARY_ID }),
				/FORBIDDEN/i,
				'Secretary cannot sign a Human Gate',
			);
			const inboxItems = await h.control<ReadonlyArray<{ readonly id: string; readonly kind?: string; readonly nodeId?: string }>>('inbox.list', { includeResolved: false });
			const gateInbox = inboxItems.find(i => i.kind === 'user_gate' && i.nodeId === 'G1');
			if (gateInbox) {
				await assert.rejects(
					() => h.control('inbox.resolve', { id: gateInbox.id, caller: 'governor', _verifiedCaller: true, _callerSessionId: gov.id }),
					/FORBIDDEN/i,
					'Agents cannot close Human Gate Inbox items via inbox.resolve',
				);
			}

			// 3. Pure-rank Mission node (owned by L3 emp -> generated employees are L4 pure leaf 'worker') CAN run token.current & token.complete (P0-2)
			const leafMission = await h.control<{ readonly id: string }>('mission.init', {
				owner: emp.id,
				title: 'Pure Leaf Mission',
				open: false,
			});
			missionStore.updateMermaid(leafMission.id, 'flowchart LR\n  W1["Pure Build"] --> W2["Pure Test"]');
			const leafW1 = employeesByNode(missionStore, leafMission.id).get('W1')!;
			assert.strictEqual(leafW1.role, undefined, 'Employee generated under L3 owner inherits default pure-leaf rank (worker)');
			await missionRuntime.setBoundary(leafMission.id, { offGraphMaxTier: 3 });
			await h.control('mission.start', { mission: leafMission.id });
			const pureCur = await h.control<{ readonly tokens: ReadonlyArray<{ readonly id: string }> }>('token.current', {
				mission: leafMission.id,
				caller: 'worker',
				_verifiedCaller: true,
				_callerSessionId: leafW1.id,
			});
			assert.strictEqual(pureCur.tokens.length, 1, 'Pure-rank Mission node can read its active token');
			const pureDone = await h.control<{ readonly ok: boolean; readonly nextTokenIds: readonly string[] }>('token.complete', {
				mission: leafMission.id,
				tokenId: pureCur.tokens[0].id,
				summary: 'Compiled cleanly on pure-leaf worker',
				caller: 'worker',
				_verifiedCaller: true,
				_callerSessionId: leafW1.id,
			});
			assert.strictEqual(pureDone.ok, true);
			assert.strictEqual(pureDone.nextTokenIds.length, 1, 'Pure-rank Mission node advances token downstream cleanly');
		});

		test('auto-detects local & cloud Agent availability (disabling unavailable engines) and supports case-insensitive model classification, Other fallback, and persistent user icon recategorization', async () => {
			// 1. Pure catalog unit checks: case-insensitive deduplication, model-tail name recognition, and Other fallback
			assert.strictEqual(resolveAdePickerVendorByName('group-openai/DeepSeek-V4-Pro'), 'deepseek', 'Model tail name wins over proxy provider prefix');
			assert.strictEqual(resolveAdePickerVendorByName('CLAUDE-SONNET-4-6'), 'anthropic');
			assert.strictEqual(resolveAdePickerVendorByName('GPT-6-LUNA'), 'openai');
			assert.strictEqual(resolveAdePickerVendorByName('my-custom-coder-v2'), 'generic', 'Unrecognized models fall back to Other (generic)');
			assert.strictEqual(resolveAdePickerVendorByName('Llama-4-Maverick'), 'generic', 'Non-top-8 models fall back to Other (generic)');

			const dedupCatalog = resolveAdeEngineModelCatalog('aexus-opencode', [
				{ id: 'DeepSeek-R1', label: 'DeepSeek R1' },
				{ id: 'deepseek-r1', label: 'deepseek-r1' },
				{ id: 'DEEPSEEK-R1', label: 'DEEPSEEK-R1' },
				{ id: 'group-openai/GPT-6-Luna', label: 'GPT 6 Luna' },
				{ id: 'group-openai/gpt-6-luna', label: 'gpt-6-luna' },
				{ id: 'my-custom-coder-v2', label: 'My Custom Coder V2' },
				{ id: 'MY-CUSTOM-CODER-V2', label: 'MY-CUSTOM-CODER-V2' },
			]);
			const dsBucket = dedupCatalog.find(c => c.vendor === 'deepseek')!;
			assert.strictEqual(dsBucket.models.filter(m => m.id.toLowerCase() === 'deepseek-r1').length, 1, 'Case variants of deepseek-r1 deduplicate into ONE model');
			const openaiBucket = dedupCatalog.find(c => c.vendor === 'openai')!;
			assert.strictEqual(openaiBucket.models.filter(m => m.id.toLowerCase().endsWith('gpt-6-luna')).length, 1, 'Case variants of gpt-6-luna deduplicate into ONE model');
			const otherBucket = dedupCatalog.find(c => c.vendor === 'generic')!;
			assert.strictEqual(otherBucket.supported, true, 'Other category lights up when unrecognized models exist');
			assert.strictEqual(otherBucket.models.length, 1, 'Case variants of unrecognized custom model deduplicate into ONE Other entry');
			assert.strictEqual(otherBucket.models[0].id, 'my-custom-coder-v2');

			// 2. Mission Canvas live test: Local vs Cloud host engine availability + disabled unavailable engines + user model icon recategorization
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const buptHost: IAdeCloudHost = {
				id: 'h-bupt208',
				name: 'bupt208',
				alias: 'bupt208',
				hostName: '10.92.35.208',
				port: 22,
				user: 'djf',
				os: 'linux',
				defaultDirectory: '/home/djf/develop',
				recentDirectories: ['/home/djf/develop'],
				source: 'user',
				createdAt: 1,
				updatedAt: 1,
				lastTestStatus: { ok: true, remoteUname: 'Linux (ubuntu)', checkedAt: 1, latencyMs: 12 },
			};
			h.instantiation.stub(IAdeCloudHostBackendService, upcastPartial<IAdeCloudHostBackendService>({
				listHosts: async () => [buptHost],
				getHost: async (idOrAlias: string) => idOrAlias.toLowerCase() === 'bupt208' ? buptHost : undefined,
			}));

			const probedUris: string[] = [];
			h.instantiation.stub(IAdeSessionsService, upcastPartial<IAdeSessionsService>({
				onDidChangeEngines: Event.None,
				getIcon: () => undefined,
				getEngineName: (id: string) => id,
				probeEnginesForProject: async (projectUri?: URI) => {
					const uriStr = projectUri?.toString() ?? 'local';
					probedUris.push(uriStr);
					const isBupt = projectUri?.scheme === AEXUS_SSH_SCHEME && projectUri.authority.toLowerCase() === 'bupt208';
					const availableIds = isBupt
						? new Set(['aexus-claude', 'aexus-opencode', 'aexus-pi'])
						: new Set(['aexus-claude', 'aexus-codex']);
					const allIds: readonly [string, string][] = [
						['aexus-claude', 'Claude Code'],
						['aexus-codex', 'Codex'],
						['aexus-kilo', 'Kilo Code'],
						['aexus-opencode', 'OpenCode'],
						['aexus-dsh', 'DeepSeek Harness'],
						['aexus-antigravity', 'Google Antigravity'],
						['aexus-cline', 'Cline'],
						['aexus-pi', 'Pi'],
					];
					const allEngines = allIds.map(([id, name]) => ({
						id,
						name,
						description: name,
						available: availableIds.has(id),
					}));
					return {
						engines: allEngines.filter(e => e.available),
						allEngines,
						remoteHost: isBupt ? 'bupt208' : undefined,
					};
				},
				getEngines: async () => [{ id: 'aexus-claude', name: 'Claude Code', description: 'Claude Code' }],
			}));

			const configuredModelQueries: string[] = [];
			h.instantiation.stub(ICommandService, {
				onWillExecuteCommand: Event.None,
				onDidExecuteCommand: Event.None,
				executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
					if (id === 'aexus.agentEngines.listConfiguredModels') {
						const uri = args[0] as URI | undefined;
						configuredModelQueries.push(uri?.toString() ?? 'local');
						return {
							'aexus-opencode': [
								{ id: 'group-openai/GPT-6-Luna', label: 'GPT-6 Luna' },
								{ id: 'group-openai/gpt-6-luna', label: 'gpt-6-luna' },
								{ id: 'my-custom-coder-v2', label: 'My Custom Coder V2' },
								{ id: 'MY-CUSTOM-CODER-V2', label: 'MY-CUSTOM-CODER-V2' },
							],
						} as T;
					}
					return undefined as T;
				},
			});

			const mermaid = 'flowchart LR\n  N1["@LocalDev: Build"] --> N2["@CloudDev: Train"]';
			const created = missionStore.createMission({ title: 'Host Availability & Model Categorization', mermaidText: mermaid });
			await missionRuntime.bindNodeHost(created.id, 'N2', { hostAlias: 'bupt208' });
			const n2AgentId = missionRuntime.getRuntimeState(created.id).boundary.nodeAssignments.N2?.agentId!;
			// Assign N2 an engine (aexus-kilo) that is NOT installed on bupt208 to verify unavailable warning badge
			h.projects.updateAgentEnginePreferences(n2AgentId, { preferredEngineId: 'aexus-kilo' });

			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));
			const host = append(document.body, $('.monaco-workbench.ade-mission-avail-test-host'));
			store.add({ dispose: () => host.remove() });
			const mockGroup = upcastPartial<IEditorGroup>({ id: 1, index: 0 });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
			pane.create(host);
			await pane.setInput(input, undefined, {}, CancellationToken.None);
			await new Promise(resolve => setTimeout(resolve, 40));

			// Opening Mission view automatically pre-probed BOTH local AND bupt208 cloud host!
			assert.ok(probedUris.some(u => u.startsWith('aexus-ssh://bupt208')), `Opening Mission must auto-probe bound cloud host bupt208 (got ${JSON.stringify(probedUris)})`);
			assert.ok(probedUris.some(u => !u.startsWith('aexus-ssh://')), `Opening Mission must auto-probe local host (got ${JSON.stringify(probedUris)})`);

			// N2's engine pill reflects that aexus-kilo is unavailable on bupt208
			const n2EnginePill = host.querySelector<HTMLButtonElement>('.ade-mission-node[data-node-id="N2"] .ade-mission-engine-pill')!;
			assert.strictEqual(n2EnginePill.getAttribute('data-engine-available'), 'false', 'Assigned unavailable engine shows unavailable state on card');
			assert.ok(n2EnginePill.classList.contains('is-engine-unavailable'));

			// Clicking N2's engine pill shows bupt208's available engines clickable & unavailable engines dimmed + disabled!
			n2EnginePill.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			assert.strictEqual(host.querySelector('[data-ade-mission-emp-popover="true"]')?.getAttribute('data-popover-host'), 'bupt208');
			const kiloOptOnBupt = host.querySelector<HTMLButtonElement>('button[data-ade-engine-option="aexus-kilo"]')!;
			const opencodeOptOnBupt = host.querySelector<HTMLButtonElement>('button[data-ade-engine-option="aexus-opencode"]')!;
			assert.ok(kiloOptOnBupt && kiloOptOnBupt.disabled && kiloOptOnBupt.classList.contains('is-unavailable') && kiloOptOnBupt.dataset.adeEngineAvailable === 'false', 'Unavailable engine Kilo Code is dimmed & unclickable on bupt208');
			assert.ok(opencodeOptOnBupt && !opencodeOptOnBupt.disabled && opencodeOptOnBupt.dataset.adeEngineAvailable === 'true', 'Available engine OpenCode is enabled & clickable on bupt208');

			// Clicking disabled Kilo does nothing; clicking available OpenCode switches N2 cleanly
			kiloOptOnBupt.click();
			assert.strictEqual(h.projects.getAgent(n2AgentId)?.preferredEngineId, 'aexus-kilo', 'Clicking disabled unavailable engine does nothing');
			opencodeOptOnBupt.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			assert.strictEqual(h.projects.getAgent(n2AgentId)?.preferredEngineId, 'aexus-opencode');

			// Clicking N1's (Local) engine pill reflects LOCAL availability (Codex enabled, OpenCode disabled)
			host.querySelector<HTMLButtonElement>('.ade-mission-node[data-node-id="N1"] .ade-mission-engine-pill')!.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			assert.strictEqual(host.querySelector<HTMLButtonElement>('button[data-ade-engine-option="aexus-codex"]')?.disabled, false, 'Codex is enabled on Local');
			assert.strictEqual(host.querySelector<HTMLButtonElement>('button[data-ade-engine-option="aexus-opencode"]')?.disabled, true, 'OpenCode is disabled on Local');

			// 3. Open N2's Model & Thinking popover (on bupt208 + OpenCode): verify Other category shows my-custom-coder-v2 once,
			//    then user manually moves it into DeepSeek icon category -> updates tab + card icon + persists across reopen!
			host.querySelector<HTMLButtonElement>('.ade-mission-node[data-node-id="N2"] .ade-mission-core-icon-well')!.click();
			await new Promise(resolve => setTimeout(resolve, 35));
			assert.ok(configuredModelQueries.some(u => u.startsWith('aexus-ssh://bupt208')), 'Model discovery queries node-bound cloud host bupt208');

			const otherVendorBtn = host.querySelector<HTMLButtonElement>('button[data-ade-vendor="generic"]')!;
			assert.ok(otherVendorBtn && !otherVendorBtn.disabled, 'Other vendor chip lights up for unrecognized models on bupt208');
			const popoverEl = host.querySelector<HTMLElement>('[data-ade-mission-emp-popover="true"]')!;
			const topBeforeCat = popoverEl.style.top;
			otherVendorBtn.click();
			const customModelBtns = host.querySelectorAll<HTMLButtonElement>('button[data-ade-model-option="my-custom-coder-v2"]');
			assert.strictEqual(customModelBtns.length, 1, 'Case duplicates collapse to one row in Other');

			// Open inline category picker for my-custom-coder-v2 & move it into DeepSeek icon category!
			const catBtn = host.querySelector<HTMLButtonElement>('button[data-ade-model-categorize="my-custom-coder-v2"]')!;
			assert.ok(catBtn, 'Model row renders inline categorize button');
			catBtn.click();
			const assignDeepSeekBtn = host.querySelector<HTMLButtonElement>('[data-ade-model-cat-picker="my-custom-coder-v2"] button[data-ade-assign-vendor="deepseek"]')!;
			assert.ok(assignDeepSeekBtn, 'Inline category picker lists DeepSeek icon option');
			assignDeepSeekBtn.click();
			assert.strictEqual(popoverEl.style.top, topBeforeCat, 'Recategorizing model never shifts popover position');
			assert.strictEqual(host.querySelector('[data-ade-vendor-models-tray="true"]')?.getAttribute('data-vendor'), 'deepseek', 'Popover switches smoothly to DeepSeek tab where the model landed');
			assert.ok(host.querySelector('button[data-ade-model-option="my-custom-coder-v2"]'), 'my-custom-coder-v2 now lives inside DeepSeek icon group');
			assert.strictEqual(host.querySelector<HTMLButtonElement>('button[data-ade-vendor="generic"]')?.disabled, true, 'Other tab dims once its last model was moved out');

			// Select my-custom-coder-v2 -> node N2 center LLM icon now displays DeepSeek whale icon!
			host.querySelector<HTMLButtonElement>('button[data-ade-model-option="my-custom-coder-v2"]')!.click();
			await new Promise(resolve => setTimeout(resolve, 20));
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="N2"] .ade-mission-core-icon-well')?.getAttribute('data-llm-provider'), 'deepseek', 'Node card LLM icon reflects user manual categorization');

			// Verify persistence across a brand-new AdeEngineeringEditorPane instance sharing IStorageService!
			const host2 = append(document.body, $('.monaco-workbench.ade-mission-avail-test-host-2'));
			store.add({ dispose: () => host2.remove() });
			const pane2 = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
			pane2.create(host2);
			await pane2.setInput(input, undefined, {}, CancellationToken.None);
			await new Promise(resolve => setTimeout(resolve, 35));
			assert.strictEqual(host2.querySelector('.ade-mission-node[data-node-id="N2"] .ade-mission-core-icon-well')?.getAttribute('data-llm-provider'), 'deepseek', 'Manual category persists across Mission reopen');
		});

		test('patches live telemetry/state & SVG edges in place without DOM teardown and preserves live drag origin after Auto Layout', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const mission = missionStore.createMission({
				title: 'Perf In-Place Patch Mission',
				mermaidText: 'flowchart LR\n  N1["Build"] --> N2["Verify"]',
			});

			const host = append(document.body, $('.monaco-workbench.ade-mission-perf-test-host'));
			store.add({ dispose: () => host.remove() });
			const mockGroup = upcastPartial<IEditorGroup>({ id: 1 });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
			pane.create(host);
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, mission.id));
			await pane.setInput(input, undefined, {}, CancellationToken.None);
			await missionRuntime.start(mission.id);

			const n1Before = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			const edgeBefore = host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="N1"][data-to="N2"]')!;
			assert.ok(n1Before && edgeBefore, 'Initial node and SVG edge group rendered');

			// 1. Live runtime telemetry update patches DOM in place without recreating node elements
			missionRuntime.recordNodeTurnUsage(mission.id, 'N1', {
				inputTokens: 42000,
				outputTokens: 3000,
				contextWindowMax: 200000,
				costUsd: 0.12,
				summary: 'Compiled 42 modules',
			});
			const n1AfterTelemetry = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			assert.strictEqual(n1AfterTelemetry, n1Before, 'Telemetry tick must patch node DOM in place without tearing down the node');
			assert.strictEqual(n1AfterTelemetry.querySelector('.ade-mission-core-context')?.textContent, 'Compiled 42 modules');
			assert.ok(Number(n1AfterTelemetry.querySelector('.ade-mission-ctx-row')?.getAttribute('data-node-context-pct')) > 0);
			await missionRuntime.stop(mission.id);

			// 2. Save custom position, then trigger Auto Layout and verify subsequent drag starts from the live auto-laid-out position
			missionStore.updateNodePositions(mission.id, { N1: { x: 900, y: 800 } });
			host.querySelector<HTMLButtonElement>('button[data-ade-mission-file-btn="true"]')!.click();
			host.querySelector<HTMLButtonElement>('button[data-ade-mission-autolayout="true"]')!.click();
			const autoLeft = Number.parseFloat(host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!.style.left);
			assert.ok(Number.isFinite(autoLeft) && autoLeft !== 900, 'Auto Layout resets custom node position');

			const n1Live = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			const edgeBeforeDrag = host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="N1"][data-to="N2"]')!;
			n1Live.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
			n1Live.dispatchEvent(new mainWindow.PointerEvent('pointermove', { button: 0, clientX: 140, clientY: 120, bubbles: true }));
			n1Live.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, clientX: 140, clientY: 120, bubbles: true }));
			const draggedLeft = Number.parseFloat(n1Live.style.left);
			assert.ok(draggedLeft > autoLeft, `Drag after Auto Layout must start from live autoLeft (${autoLeft}), got ${draggedLeft}`);
			const edgeAfterDrag = host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="N1"][data-to="N2"]')!;
			assert.strictEqual(edgeAfterDrag, edgeBeforeDrag, 'Dragging updates SVG edge path in place without recreating <g> elements');
		});

		test('enforces zero-cost deterministic verification hooks on token.complete (bounce -> fix -> verified advance, worker forbidden from mutating/skipping checks, auto-fallback on retry exhaustion)', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();

			// Stub deterministic check runner in IAdeEngineeringBackendService
			let n1CheckShouldPass = false;
			const executedChecks: string[] = [];
			h.instantiation.stub(IAdeEngineeringBackendService, upcastPartial<IAdeEngineeringBackendService>({
				loadInbox: async () => [],
				saveInbox: async () => undefined,
				runDeterministicCheck: async req => {
					executedChecks.push(`${req.checkId}:${req.command ?? ''}`);
					if (req.checkId === 'chk-n1-test') {
						return n1CheckShouldPass
							? { checkId: req.checkId, name: req.name, command: req.command, hostAlias: req.hostAlias || 'local', passed: true, exitCode: 0, expectedExitCode: 0, durationMs: 85, outputTail: '12 passing' }
							: { checkId: req.checkId, name: req.name, command: req.command, hostAlias: req.hostAlias || 'local', passed: false, exitCode: 1, expectedExitCode: 0, durationMs: 92, outputTail: 'FAIL src/app.test.ts: expected true to equal false', error: 'Exit code 1 (expected 0)' };
					}
					// N2 inline Mermaid check always fails to exercise retry exhaustion -> on_fail fallback
					return { checkId: req.checkId, name: req.name, command: req.command, hostAlias: req.hostAlias || 'local', passed: false, exitCode: 2, expectedExitCode: 0, durationMs: 40, outputTail: 'lint failed', error: 'Exit code 2 (expected 0)' };
				},
			}));

			const dispatchedPrompts: { readonly agentId: string; readonly prompt: string }[] = [];
			h.instantiation.stub(ICommandService, {
				onWillExecuteCommand: Event.None,
				onDidExecuteCommand: Event.None,
				executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
					if (id === 'aexus.agentEngines.dispatchEngineeringTurn') {
						const opts = args[2] as { readonly agentId?: string } | undefined;
						dispatchedPrompts.push({ agentId: opts?.agentId ?? '', prompt: String(args[1] ?? '') });
						return { reply: 'ok' } as T;
					}
					return undefined as T;
				},
			});

			const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/gov-check') }, 'Gov Check', { role: 'governor' });
			const mission = missionStore.createMission({
				title: 'Deterministic Gate Mission',
				ownerSessionId: gov.id,
				ownerTier: 1,
				mermaidText: [
					'flowchart LR',
					'  N1["@Dev: Implement"] --> N2["@Rev: Lint & Review"]',
					'  N2 -->|fail| F1["@Fix: Auto Recovery"]',
					'  %% check N2 [name=lint, on_fail=bounce, max_retries=1]: pnpm lint',
				].join('\n'),
			});
			await missionRuntime.setBoundary(mission.id, {
				offGraphMaxTier: 1,
				supervisors: [{ id: gov.id, tier: 1, managedNodeIds: ['N1', 'N2', 'F1'] }],
			});
			// Bind mock sessions so dispatch works cleanly
			for (const emp of missionStore.getGeneratedEmployees(mission.id)) {
				h.projects.bindSession(emp.id, {
					resource: URI.parse(`aexus-claude:/${emp.id}`),
					engineId: 'aexus-claude',
				});
			}

			// 1. Off-graph Governor attaches a deterministic check hook to N1 via mission.check.set
			const setRes = await h.control<{ ok: boolean; checks: readonly { id: string }[] }>('mission.check.set', {
				missionId: mission.id,
				nodeId: 'N1',
				checkId: 'chk-n1-test',
				name: 'unit-tests',
				command: 'pnpm test',
				onFail: 'bounce',
				maxAutoRetries: 1,
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: gov.id,
			});
			assert.strictEqual(setRes.ok, true);
			assert.strictEqual(setRes.checks.length, 1);

			// List checks returns BOTH config check on N1 and Mermaid inline %% check on N2
			const listed = await h.control<{ nodeChecks: Record<string, readonly { id: string; source?: string }[]> }>('mission.check.list', {
				missionId: mission.id,
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: gov.id,
			});
			assert.strictEqual(listed.nodeChecks.N1?.length, 1);
			assert.strictEqual(listed.nodeChecks.N2?.length, 1);
			assert.strictEqual(listed.nodeChecks.N2?.[0].source, 'mermaid');

			// Start Mission -> N1 wakeup prompt discloses deterministic check gate & self-verify command
			await missionRuntime.start(mission.id);
			const rt0 = missionRuntime.getRuntimeState(mission.id);
			const n1AgentId = rt0.boundary.nodeAssignments.N1?.agentId!;
			const n1Tok = Object.values(rt0.tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
			const n1Prompt = dispatchedPrompts.find(d => d.agentId === n1AgentId)?.prompt ?? '';
			assert.ok(n1Prompt.includes('Deterministic Verification Gate'), 'worker wakeup prompt announces deterministic check gate');
			assert.ok(n1Prompt.includes('mission check run'), 'worker wakeup prompt includes self-check command');

			// 2. Worker CANNOT modify, delete, or skip deterministic verification hooks!
			await assert.rejects(
				() => h.control('mission.check.set', {
					missionId: mission.id,
					nodeId: 'N1',
					command: 'true',
					caller: 'employee',
					_verifiedCaller: true,
					_callerSessionId: n1AgentId,
				}),
				/FORBIDDEN|Permission denied/i,
			);
			await assert.rejects(
				() => h.control('mission.check.remove', {
					missionId: mission.id,
					nodeId: 'N1',
					caller: 'employee',
					_verifiedCaller: true,
					_callerSessionId: n1AgentId,
				}),
				/FORBIDDEN|Permission denied/i,
			);
			await assert.rejects(
				() => h.control('token.complete', {
					missionId: mission.id,
					tokenId: n1Tok.id,
					summary: 'trying to bypass',
					skipChecks: true,
					caller: 'employee',
					_verifiedCaller: true,
					_callerSessionId: n1AgentId,
				}),
				/FORBIDDEN.*--skip-checks/i,
			);

			// Worker CAN dry-run its own node checks via mission.check.run
			const dryRun = await h.control<{ ok: boolean; passed: boolean }>('mission.check.run', {
				missionId: mission.id,
				nodeId: 'N1',
				caller: 'employee',
				_verifiedCaller: true,
				_callerSessionId: n1AgentId,
			});
			assert.strictEqual(dryRun.ok, true);
			assert.strictEqual(dryRun.passed, false);

			// 3. Worker calls token.complete while test fails -> bounced (attempt 1/1), N1 stays active, N2 NOT woken!
			const dispatchesBefore = dispatchedPrompts.length;
			await assert.rejects(
				() => h.control('token.complete', {
					missionId: mission.id,
					tokenId: n1Tok.id,
					summary: 'Claimed done prematurely',
					caller: 'employee',
					_verifiedCaller: true,
					_callerSessionId: n1AgentId,
				}),
				/DETERMINISTIC_CHECK_FAILED.*attempt 1\/1/i,
			);
			const rtAfterBounce = missionRuntime.getRuntimeState(mission.id);
			assert.strictEqual(rtAfterBounce.tokens[n1Tok.id].status, 'active', 'bounced token stays active on N1');
			assert.strictEqual(rtAfterBounce.tokens[n1Tok.id].checkFailureCount, 1);
			assert.strictEqual(dispatchedPrompts.length, dispatchesBefore, 'zero LLM reviewer dispatch spent on failing build/test');

			// 4. Worker fixes the test -> token.complete passes verification & advances verified token to N2!
			n1CheckShouldPass = true;
			const completeRes = await h.control<{ ok: boolean; verified?: boolean; nextTokenIds: readonly string[] }>('token.complete', {
				missionId: mission.id,
				tokenId: n1Tok.id,
				summary: 'Fixed src/app.ts and verified tests',
				caller: 'employee',
				_verifiedCaller: true,
				_callerSessionId: n1AgentId,
			});
			assert.strictEqual(completeRes.ok, true);
			assert.strictEqual(completeRes.verified, true);
			assert.strictEqual(completeRes.nextTokenIds.length, 1);
			const n2Tok = missionRuntime.getRuntimeState(mission.id).tokens[completeRes.nextTokenIds[0]];
			assert.strictEqual(n2Tok.nodeId, 'N2');
			assert.ok(n2Tok.lastSummary.includes('[Verified: unit-tests'), 'downstream N2 receives deterministic verification proof');

			// 5. On N2 (Mermaid inline check with maxAutoRetries=1), failing twice auto-routes to fallback node F1!
			const n2AgentId = missionRuntime.getRuntimeState(mission.id).boundary.nodeAssignments.N2?.agentId!;
			await assert.rejects(
				() => h.control('token.complete', {
					missionId: mission.id,
					tokenId: n2Tok.id,
					summary: 'attempt 1',
					caller: 'employee',
					_verifiedCaller: true,
					_callerSessionId: n2AgentId,
				}),
				/attempt 1\/1/i,
			);
			await assert.rejects(
				() => h.control('token.complete', {
					missionId: mission.id,
					tokenId: n2Tok.id,
					summary: 'attempt 2',
					caller: 'employee',
					_verifiedCaller: true,
					_callerSessionId: n2AgentId,
				}),
				/DETERMINISTIC_CHECK_FAILED/i,
			);
			const rtFinal = missionRuntime.getRuntimeState(mission.id);
			assert.ok(Object.values(rtFinal.tokens).some(t => t.nodeId === 'F1' && t.status === 'active'), 'exhausted Mermaid check auto-routes to on_fail fallback F1');
			assert.ok(executedChecks.length >= 4);
		});

		test('AdeProjectsView Inbox Gate Approve and Roll Back drive real MissionRuntimeService.resolveGate and refuse fake-resolving without runtime', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const dummySidebar = new class extends mock<ViewContainer>() { override readonly id = 'test.ade.inbox.gate'; }();
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

			const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/gov-gate-inbox') }, 'Gov Gate', { role: 'governor' });
			const approveMission = missionStore.createMission({
				title: 'Inbox Gate Approve Mission',
				ownerSessionId: gov.id,
				ownerTier: 1,
				mermaidText: 'flowchart LR\n  N1["Build"] --> G1{"Release Gate"}\n  G1 --> N2["Deploy"]',
			});
			await missionRuntime.start(approveMission.id);
			const n1Tok = Object.values(missionRuntime.getRuntimeState(approveMission.id).tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
			await missionRuntime.completeToken(approveMission.id, { tokenId: n1Tok.id, summary: 'Build ready' });
			assert.strictEqual(missionRuntime.getRuntimeState(approveMission.id).nodeStates.G1, 'waiting_gate');

			// Render real AdeProjectsView and switch to its Inbox tab
			const host = append(document.body, $('.monaco-workbench.ade-projects-gate-test-host'));
			store.add({ dispose: () => host.remove() });
			host.style.width = '300px';
			host.style.height = '600px';
			const view = store.add(h.instantiation.createInstance(AdeProjectsView, { id: ADE_PROJECTS_VIEW_ID, title: 'Sessions' }));
			view.render();
			host.appendChild(view.element);
			view.setVisible(true);
			view.orthogonalSize = 300;
			view.layout(600);

			const inboxTabBtn = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => /inbox/i.test(b.textContent ?? ''));
			assert.ok(inboxTabBtn, 'AdeProjectsView renders Inbox tab button');
			inboxTabBtn.click();

			const approveBtn = host.querySelector<HTMLButtonElement>('.ade-inbox-card .ade-inbox-btn.primary');
			assert.ok(approveBtn, 'User Gate Approve button rendered inside AdeProjectsView Inbox panel');
			approveBtn.click();
			await timeout(30);

			const rtAfterApprove = missionRuntime.getRuntimeState(approveMission.id);
			assert.strictEqual(rtAfterApprove.nodeStates.G1, 'completed', 'Clicking Approve in Inbox MUST advance Gate out of waiting_gate');
			assert.ok(Object.values(rtAfterApprove.tokens).some(t => t.nodeId === 'N2' && t.status === 'active'), 'Downstream N2 MUST become active after Inbox Gate Approve');
			const inboxService = h.instantiation.invokeFunction(a => a.get(IAdeInboxService));
			assert.strictEqual(inboxService.list({ includeResolved: false }).filter(i => i.kind === 'user_gate').length, 0, 'Inbox gate item resolved after approve');

			// Part 2: Roll Back from Inbox bounces Gate back to upstream N1
			const rollbackMission = missionStore.createMission({
				title: 'Inbox Gate Rollback Mission',
				mermaidText: 'flowchart LR\n  N1["Draft"] --> G1{"Review Gate"}\n  G1 --> N2["Publish"]',
			});
			await missionRuntime.start(rollbackMission.id);
			const rbN1Tok = Object.values(missionRuntime.getRuntimeState(rollbackMission.id).tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
			await missionRuntime.completeToken(rollbackMission.id, { tokenId: rbN1Tok.id, summary: 'Draft v1' });
			assert.strictEqual(missionRuntime.getRuntimeState(rollbackMission.id).nodeStates.G1, 'waiting_gate');

			const rbToggleBtn = host.querySelector<HTMLButtonElement>('.ade-inbox-card .ade-inbox-btn.danger-outline');
			assert.ok(rbToggleBtn, 'Roll Back toggle button rendered for Gate with rollbackCandidates');
			rbToggleBtn.click();
			const confirmRbBtn = host.querySelector<HTMLButtonElement>('.ade-inbox-rollback-box .ade-inbox-btn.danger');
			assert.ok(confirmRbBtn, 'Confirm Partial Rollback button rendered');
			confirmRbBtn.click();
			await timeout(30);

			const rtAfterRollback = missionRuntime.getRuntimeState(rollbackMission.id);
			assert.notStrictEqual(rtAfterRollback.nodeStates.G1, 'waiting_gate', 'Roll Back MUST release Gate out of waiting_gate');
			assert.ok(Object.values(rtAfterRollback.tokens).some(t => t.nodeId === 'N1' && t.status === 'active'), 'Roll Back MUST reactivate upstream N1');

			// Part 3: AdeInboxPanel without submitGateVerdict MUST surface an error and MUST NOT fake-resolve the item
			const noRuntimeMission = missionStore.createMission({
				title: 'No Runtime Bridge Gate',
				mermaidText: 'flowchart LR\n  N1["Prep"] --> G1{"Signoff"}\n  G1 --> N2["Ship"]',
			});
			await missionRuntime.start(noRuntimeMission.id);
			const nrN1 = Object.values(missionRuntime.getRuntimeState(noRuntimeMission.id).tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
			await missionRuntime.completeToken(noRuntimeMission.id, { tokenId: nrN1.id, summary: 'Prep ok' });

			const panelHost = append(document.body, $('.ade-inbox-no-runtime-test'));
			store.add({ dispose: () => panelHost.remove() });
			const reportedErrors: string[] = [];
			const panel = store.add(new AdeInboxPanel(
				panelHost,
				inboxService,
				{ listMissions: () => missionStore.listMissions() },
				h.instantiation.invokeFunction(a => a.get(IAdeEditorService)),
				msg => reportedErrors.push(msg),
			));
			panel.setVisible(true);
			const orphanApprove = panelHost.querySelector<HTMLButtonElement>('.ade-inbox-card .ade-inbox-btn.primary');
			assert.ok(orphanApprove);
			orphanApprove.click();
			await timeout(20);
			assert.ok(reportedErrors.length > 0 && /unavailable/i.test(reportedErrors[0]), 'Missing submitGateVerdict reports explicit error');
			assert.strictEqual(inboxService.list({ includeResolved: false }).filter(i => i.kind === 'user_gate').length, 1, 'Gate card MUST remain unresolved when runtime bridge is missing');
		});

		test('incremental node dragging only re-routes affected edges and leaves distant unrelated SVG paths untouched', async () => {
			const { h, missionStore } = createMissionHarness();
			const mission = missionStore.createMission({
				title: 'Incremental Drag Reroute Mission',
				mermaidText: [
					'flowchart LR',
					'  A1["Top 1"] --> A2["Top 2"]',
					'  A2 --> A3["Top 3"]',
					'  B1["Bot 1"] --> B2["Bot 2"]',
					'  B2 --> B3["Bot 3"]',
				].join('\n'),
			});
			missionStore.updateNodePositions(mission.id, {
				A1: { x: 200, y: 150 },
				A2: { x: 600, y: 150 },
				A3: { x: 1000, y: 150 },
				B1: { x: 200, y: 950 },
				B2: { x: 600, y: 950 },
				B3: { x: 1000, y: 950 },
			});

			const host = append(document.body, $('.monaco-workbench.ade-mission-inc-drag-host'));
			store.add({ dispose: () => host.remove() });
			const mockGroup = upcastPartial<IEditorGroup>({ id: 1 });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
			pane.create(host);
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, mission.id));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			const a1Node = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="A1"]')!;
			const incidentPath = host.querySelector<SVGPathElement>('.ade-mission-edge-group[data-from="A1"][data-to="A2"] path')!;
			const distantPath = host.querySelector<SVGPathElement>('.ade-mission-edge-group[data-from="B1"][data-to="B2"] path')!;
			assert.ok(a1Node && incidentPath && distantPath);

			let incidentDUpdates = 0;
			let distantDUpdates = 0;
			const origIncidentSetAttr = incidentPath.setAttribute.bind(incidentPath);
			const origDistantSetAttr = distantPath.setAttribute.bind(distantPath);
			incidentPath.setAttribute = (name: string, value: string) => {
				if (name === 'd') {
					incidentDUpdates++;
				}
				return origIncidentSetAttr(name, value);
			};
			distantPath.setAttribute = (name: string, value: string) => {
				if (name === 'd') {
					distantDUpdates++;
				}
				return origDistantSetAttr(name, value);
			};

			// Drag A1 slightly during active pointermove frames (before pointerup flush)
			a1Node.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, clientX: 200, clientY: 150, bubbles: true }));
			a1Node.dispatchEvent(new mainWindow.PointerEvent('pointermove', { button: 0, clientX: 240, clientY: 190, bubbles: true }));
			await new Promise(resolve => mainWindow.requestAnimationFrame(() => mainWindow.requestAnimationFrame(resolve)));
			a1Node.dispatchEvent(new mainWindow.PointerEvent('pointermove', { button: 0, clientX: 260, clientY: 210, bubbles: true }));
			await new Promise(resolve => mainWindow.requestAnimationFrame(() => mainWindow.requestAnimationFrame(resolve)));

			assert.ok(incidentDUpdates >= 1, `Incident edge A1->A2 must update during drag (got ${incidentDUpdates})`);
			assert.strictEqual(distantDUpdates, 0, `Distant unrelated edge B1->B2 must NOT be recomputed/mutated during A1 drag frames (got ${distantDUpdates})`);

			a1Node.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, clientX: 260, clientY: 210, bubbles: true }));
			assert.strictEqual(distantDUpdates, 0, 'Unchanged distant edge avoids redundant DOM setAttribute even on drag-end flush');
		});

		test('AdeMissionStoreService and AdeInboxService synchronize updates across windows without self-echo overwrite', async () => {
			const h = createHarness([alpha]);
			const storeA = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			const storeB = store.add(h.instantiation.createInstance(AdeMissionStoreService));

			let storeBExternalEvents = 0;
			store.add(storeB.onDidChangeExternal(() => storeBExternalEvents++));

			const created = storeA.createMission({
				title: 'Cross-Window Mission',
				mermaidText: 'flowchart LR\n  N1 --> N2',
			});
			assert.strictEqual(storeB.getMission(created.id)?.title, 'Cross-Window Mission', 'Window B store reloads Mission written by Window A');
			assert.strictEqual(storeBExternalEvents, 1, 'Window B emits onDidChangeExternal once');

			storeA.renameMission(created.id, 'Renamed From Window A');
			assert.strictEqual(storeB.getMission(created.id)?.title, 'Renamed From Window A', 'Window B stays synced on subsequent updates');

			// Verify AdeInboxService cross-window sync via backend.onDidInboxChange
			const onBackendInboxChange = store.add(new Emitter<readonly IAdeInboxItem[]>());
			const savedBatches: (readonly IAdeInboxItem[])[] = [];
			h.instantiation.stub(IAdeEngineeringBackendService, upcastPartial<IAdeEngineeringBackendService>({
				onDidInboxChange: onBackendInboxChange.event,
				loadInbox: async () => [],
				saveInbox: async items => {
					savedBatches.push(items);
					onBackendInboxChange.fire(items);
				},
			}));
			const inboxA = store.add(h.instantiation.createInstance(AdeInboxService));
			const inboxB = store.add(h.instantiation.createInstance(AdeInboxService));

			await inboxA.postGovernorMessage({
				governorSessionId: 'gov-sync',
				title: 'Cross-Window Alert',
				message: 'Synced from Window A',
				severity: 'critical',
			});
			assert.strictEqual(savedBatches.length, 1);
			assert.strictEqual(inboxA.items.length, 1);
			assert.strictEqual(inboxB.items.length, 1, 'Window B AdeInboxService receives cross-window broadcast immediately');
			assert.strictEqual(inboxB.items[0].title, 'Cross-Window Alert');
		});

		test('manually bound pure-execution Worker (without treeNodeId) can complete tokens, restart recovery resumes active tokens, and telemetry persistence coalesces writes', async () => {
			const h = createHarness([alpha]);
			const dispatchedPrompts: Array<{ resource: string; prompt: string }> = [];
			h.instantiation.stub(ICommandService, {
				onWillExecuteCommand: Event.None,
				onDidExecuteCommand: Event.None,
				executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
					if (id === 'aexus.agentEngines.dispatchEngineeringTurn') {
						dispatchedPrompts.push({ resource: String(args[0]), prompt: String(args[1]) });
						return { reply: 'ok', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, turns: 1 } } as T;
					}
					const registered = CommandsRegistry.getCommand(id);
					if (registered) {
						return h.instantiation.invokeFunction(registered.handler, ...args) as T;
					}
					return undefined as T;
				},
			});
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);

			// Create a standalone pure-execution Worker with NO treeNodeId and manually bind it to node N1!
			const pureWorker = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/manual-pure-worker') }, 'Manual Worker', { role: 'worker' });
			assert.strictEqual(pureWorker.treeNodeId, undefined);

			const created = missionStore.createMission({
				title: 'Manual Bind Mission',
				mermaidText: 'flowchart LR\n  N1["Impl"] --> N2["Verify"]',
				projectUri: alpha.toString(),
			});
			await missionRuntime.bindNodeHost(created.id, 'N1', { agentId: pureWorker.id, hostAlias: 'local' });
			await missionRuntime.start(created.id);
			const n1Tok = Object.values(missionRuntime.getRuntimeState(created.id).tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
			assert.ok(n1Tok);

			// Role context and sync snapshot recognize manually bound Worker as an in-graph Mission node
			const roleCtx = h.resolvePrompt({ agentId: pureWorker.id });
			assert.ok(roleCtx && roleCtx.includes('aexus-ade token complete'), 'Manually bound pure Worker receives Mission Token CLI instructions');
			const syncSnap = h.instantiation.invokeFunction(CommandsRegistry.getCommand(ADE_GET_ROLE_SYNC_SNAPSHOT_COMMAND_ID)!.handler) as unknown as IAdeRoleSyncSnapshot;
			const workerSnap = syncSnap.agents.find(a => a.id === pureWorker.id);
			assert.strictEqual(workerSnap?.isMissionNode, true, 'Role sync snapshot flags manually bound Worker as isMissionNode=true');

			// Restart recovery resumes active token immediately without waiting for silence timeout
			dispatchedPrompts.length = 0;
			const recoveredCount = await missionRuntime.recoverInterruptedActiveTokens(created.id);
			assert.strictEqual(recoveredCount, 1, 'recoverInterruptedActiveTokens resumes active token on running Mission');
			assert.ok(dispatchedPrompts.some(p => p.prompt.includes('IDE Restart Auto-Recovery') && p.prompt.includes(n1Tok.id)));

			// Manually bound pure Worker can invoke token.complete via ADE control handler without being rejected!
			const completeRes = await h.control<{ ok?: boolean }>('token.complete', {
				missionId: created.id,
				tokenId: n1Tok.id,
				summary: 'Completed by manually bound pure worker',
				_verifiedCaller: true,
				_callerSessionId: pureWorker.id,
				caller: 'worker',
			});
			assert.strictEqual(completeRes.ok, true, 'Manually bound pure Worker must NOT be blocked from token.complete');

			// Deferred persistence coalesces rapid telemetry writes into a single storage write while updating memory synchronously
			const storageService = h.instantiation.get(IStorageService);
			let storageWriteCount = 0;
			const origStore = storageService.store.bind(storageService);
			storageService.store = ((key: string, value: unknown, scope: StorageScope, target: StorageTarget) => {
				if (key === `${ADE_MISSION_RECORD_STORAGE_PREFIX}${created.id}`) {
					storageWriteCount++;
				}
				return origStore(key, value as string, scope, target);
			}) as typeof storageService.store;

			const beforeTotal = missionRuntime.getRuntimeState(created.id).nodeTelemetry?.N1?.totalTokens ?? 0;
			for (let i = 0; i < 5; i++) {
				missionRuntime.recordNodeTurnUsage(created.id, 'N1', { inputTokens: 100, outputTokens: 20, totalTokens: 120, turns: 0 });
			}
			assert.strictEqual(missionRuntime.getRuntimeState(created.id).nodeTelemetry?.N1?.totalTokens, beforeTotal + 600, 'In-memory telemetry updates synchronously');
			assert.strictEqual(storageWriteCount, 0, 'Deferred telemetry writes must NOT synchronously hammer IStorageService on every tick');
			await new Promise(resolve => setTimeout(resolve, 320));
			assert.strictEqual(storageWriteCount, 1, '5 rapid telemetry ticks coalesce into 1 debounced storage write');
		});

		test('renders live token pucks, blocked countdown/PID/file strip, join barrier dots, token inspector (lastSummary/compressedHistory/lazy tracePtr), fail-route illumination, trace hover, and 1-click Retry/Recall in place', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const mermaid = [
				'flowchart LR',
				'  A["Prep A"] --> J["Join Review"]',
				'  B["Prep B"] --> J',
				'  J --> G1{"Release Gate"}',
				'  A -->|fail| F1["Fallback A"]',
				'  F1 --> J',
			].join('\n');
			const mission = missionStore.createMission({ title: 'Runtime Visibility Canvas', mermaidText: mermaid });

			const host = append(document.body, $('.monaco-workbench.ade-mission-visibility-host'));
			store.add({ dispose: () => host.remove() });
			const mockGroup = upcastPartial<IEditorGroup>({ id: 1, index: 0 });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
			pane.create(host);
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, mission.id));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			await missionRuntime.start(mission.id);

			const nodeABefore = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="A"]')!;
			const nodeJBefore = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="J"]')!;
			const puckA = host.querySelector<HTMLButtonElement>('button[data-ade-token-puck="A"]')!;
			assert.ok(puckA && !puckA.hidden, 'Active node A renders visible live token puck');
			assert.ok(puckA.textContent?.includes('W1'), `Token puck shows wave tag W1, got: ${puckA.textContent}`);

			// 1. Block node A with watchPid + watchFile + hostAlias -> renders blocked strip & countdown in place
			const tokA = Object.values(missionRuntime.getRuntimeState(mission.id).tokens).find(t => t.nodeId === 'A' && t.status === 'active')!;
			await missionRuntime.blockToken(mission.id, {
				tokenId: tokA.id,
				reason: 'Waiting for distributed training checkpoint',
				maxDuration: '30m',
				watchPid: 4242,
				watchFile: '/data/runs/model.pt',
				hostAlias: 'gpu-1',
			});
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="A"]'), nodeABefore, 'Blocked transition patches node A in place without DOM teardown');
			const blockedStripA = host.querySelector<HTMLElement>('[data-ade-blocked-strip="A"]')!;
			assert.strictEqual(blockedStripA.hidden, false, 'Blocked node A displays blocked watch strip');
			assert.ok(host.querySelector('[data-ade-blocked-countdown="A"]')?.textContent?.includes('⏳'), 'Blocked countdown displays hourglass remaining time');
			assert.strictEqual(host.querySelector('[data-ade-blocked-pid="A"]')?.textContent, 'PID 4242');
			assert.strictEqual(host.querySelector('[data-ade-blocked-file="A"]')?.textContent, 'model.pt');
			assert.strictEqual(host.querySelector<HTMLElement>('[data-ade-blocked-file="A"]')?.title, '/data/runs/model.pt');
			assert.strictEqual(host.querySelector('[data-ade-blocked-host="A"]')?.textContent, '@gpu-1');

			// 2. Complete branch B -> Join barrier capsule on J shows ● ○ 1/2 and illuminates B->J edge in place
			const tokB = Object.values(missionRuntime.getRuntimeState(mission.id).tokens).find(t => t.nodeId === 'B' && t.status === 'active')!;
			await missionRuntime.completeToken(mission.id, { tokenId: tokB.id, summary: 'Branch B integration tests green.' });
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="J"]'), nodeJBefore, 'Join arrival patches node J in place without DOM teardown');
			const joinCapsuleJ = host.querySelector<HTMLElement>('[data-ade-join-progress="J"]')!;
			assert.strictEqual(joinCapsuleJ.hidden, false, 'Multi-branch join node J displays join barrier progress capsule');
			assert.strictEqual(joinCapsuleJ.getAttribute('data-join-arrived'), '1');
			assert.strictEqual(joinCapsuleJ.querySelectorAll('.ade-mission-join-dot.is-arrived').length, 1);
			assert.ok(joinCapsuleJ.querySelectorAll('.ade-mission-join-dot.is-pending').length >= 1);
			const edgeBJ = host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="B"][data-to="J"]')!;
			assert.ok(edgeBJ.classList.contains('is-join-arrived'), 'Arrived join branch edge B->J highlights as arrived');

			// 3. Click A's token puck -> opens Token Inspector showing blocked info, lastSummary, compressedHistory & lazy tracePtr
			puckA.click();
			const popover = host.querySelector<HTMLElement>('[data-ade-mission-emp-popover="true"][data-popover-kind="token"]')!;
			assert.ok(popover && !popover.hidden, 'Clicking token puck opens Token Inspector popover');
			assert.ok(popover.querySelector('[data-ade-token-blocked-box="true"]')?.textContent?.includes('Waiting for distributed training checkpoint'));
			assert.strictEqual(popover.querySelector('[data-ade-inspector-pid="4242"]')?.textContent, 'PID 4242');
			assert.ok(popover.querySelector('[data-ade-token-last-summary="true"]'), 'Token Inspector displays lastSummary');
			assert.ok(popover.querySelector('[data-ade-token-compressed-history="true"]'), 'Token Inspector displays compressedHistory');
			const traceList = popover.querySelector<HTMLElement>('[data-ade-trace-list="true"]')!;
			assert.strictEqual(traceList.hidden, true, 'Trace list stays collapsed lazily until clicked');
			popover.querySelector<HTMLButtonElement>('[data-ade-expand-trace="true"]')!.click();
			assert.strictEqual(traceList.hidden, false, 'Clicking Expand Trace lazily expands tracePtr');
			assert.ok(traceList.querySelectorAll('.ade-mission-token-trace-row').length >= 1, 'Expanded trace renders chronological trace entries');

			// 4. Fail A -> routes over on_fail turnout edge A->F1 (illuminating is-fail-taken) and trace hover highlights ancestry
			await missionRuntime.failToken(mission.id, { tokenId: tokA.id, reason: 'OOM on primary worker' });
			const failEdgeAF1 = host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="A"][data-to="F1"]')!;
			assert.ok(failEdgeAF1.classList.contains('is-fail-taken'), 'Taken on_fail edge A->F1 illuminates with is-fail-taken');
			const puckF1 = host.querySelector<HTMLButtonElement>('button[data-ade-token-puck="F1"]')!;
			assert.ok(puckF1 && !puckF1.hidden, 'Fallback node F1 receives active token puck');
			const win = puckF1.ownerDocument.defaultView!;
			puckF1.dispatchEvent(new win.PointerEvent('pointerenter', { bubbles: false }));
			assert.ok(failEdgeAF1.classList.contains('is-trace-highlighted'), 'Hovering token puck highlights ancestor trace edge in gold');
			puckF1.dispatchEvent(new win.PointerEvent('pointerleave', { bubbles: false }));
			assert.strictEqual(failEdgeAF1.classList.contains('is-trace-highlighted'), false, 'Leaving token puck clears trace edge highlight');

			// 5. Fail F1 (no further fail edge -> frozen_failed) -> 1-click Retry & Recall buttons appear on canvas!
			const tokF1 = Object.values(missionRuntime.getRuntimeState(mission.id).tokens).find(t => t.nodeId === 'F1' && t.status === 'active')!;
			await missionRuntime.failToken(mission.id, { tokenId: tokF1.id, reason: 'Fallback also failed' });
			const retryBtnF1 = host.querySelector<HTMLButtonElement>('button[data-ade-node-retry="F1"]')!;
			const recallBtnF1 = host.querySelector<HTMLButtonElement>('button[data-ade-node-recall="F1"]')!;
			assert.strictEqual(retryBtnF1.hidden, false, 'Failed node F1 exposes one-click Retry button on canvas');
			assert.strictEqual(recallBtnF1.hidden, false, 'Failed node F1 exposes one-click Recall button on canvas');

			retryBtnF1.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			assert.strictEqual(missionRuntime.getRuntimeState(mission.id).nodeStates.F1, 'active', 'Clicking canvas Retry transitions failed node F1 back to active');

			// Open F1 Token Inspector and Recall the active token
			host.querySelector<HTMLButtonElement>('button[data-ade-token-puck="F1"]')!.click();
			const activeTokF1 = Object.values(missionRuntime.getRuntimeState(mission.id).tokens).find(t => t.nodeId === 'F1' && t.status === 'active')!;
			const recallPopBtn = host.querySelector<HTMLButtonElement>(`button[data-ade-popover-recall="${activeTokF1.id}"]`)!;
			assert.ok(recallPopBtn, 'Token Inspector exposes Recall action for active token');
			recallPopBtn.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			assert.strictEqual(missionRuntime.getRuntimeState(mission.id).tokens[activeTokF1.id]?.status, 'recalled', 'Clicking Recall transitions active token to recalled');
		});

		test('surfaces Start errors on floating canvas alert when File Drawer is closed and supports multi-wave Gate selection', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			// Create a valid 2-node DAG whose Start fails on a real Factory Boundary error while File Drawer is closed
			const badStartMission = missionStore.createMission({
				title: 'Start Error Alert Mission',
				mermaidText: 'flowchart LR\n  N1["Alpha"] --> N2["Beta"]',
			});
			// Set offGraphMaxTier above in-graph node tiers so validateMissionFactoryBoundary rejects Start
			const prevRt = missionRuntime.getRuntimeState(badStartMission.id);
			missionStore.updateRuntime(badStartMission.id, {
				...prevRt,
				boundary: {
					...prevRt.boundary,
					offGraphMaxTier: 9,
				},
			});

			const host = append(document.body, $('.monaco-workbench.ade-mission-alert-host'));
			store.add({ dispose: () => host.remove() });
			const mockGroup = upcastPartial<IEditorGroup>({ id: 1, index: 0 });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
			pane.create(host);
			const badInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, badStartMission.id));
			await pane.setInput(badInput, undefined, {}, CancellationToken.None);

			const drawer = host.querySelector<HTMLElement>('[data-ade-mission-drawer="true"]')!;
			assert.strictEqual(drawer.hidden, true, 'File Drawer starts closed');
			const startBtn = host.querySelector<HTMLButtonElement>('[data-ade-mission-run-primary="true"]')!;
			assert.strictEqual(startBtn.disabled, false, 'Start button is enabled for non-empty valid graph');

			// Click Start while File Drawer is closed -> floating Canvas Alert surfaces error immediately!
			startBtn.click();
			await new Promise(resolve => setTimeout(resolve, 25));
			const alertEl = host.querySelector<HTMLElement>('[data-ade-mission-canvas-alert="true"]')!;
			assert.strictEqual(alertEl.hidden, false, 'Start error must NOT be silent when File Drawer is closed');
			assert.strictEqual(alertEl.dataset.alertKind, 'error');
			const alertText = host.querySelector<HTMLElement>('[data-ade-mission-canvas-alert-text="true"]')?.textContent ?? '';
			assert.ok(alertText.length > 0, `Floating alert displays concrete start failure error, got: ${alertText}`);
			assert.strictEqual(host.querySelector<HTMLButtonElement>('[data-ade-mission-canvas-alert-open-file="true"]')?.hidden, false, 'Offers quick Open mission.mmd shortcut when drawer is closed');

			// Dismissing alert hides it cleanly
			host.querySelector<HTMLButtonElement>('[data-ade-mission-canvas-alert-dismiss="true"]')!.click();
			assert.strictEqual(alertEl.hidden, true, 'Dismiss button closes canvas alert');

			// Loading a cyclic Mermaid DAG while File Drawer is closed also surfaces the parse error on the floating alert
			const cycleMission = missionStore.createMission({
				title: 'Cycle Parse Error',
				mermaidText: 'flowchart LR\n  C1["A"] --> C2["B"]\n  C2 --> C1',
			});
			const cycleInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, cycleMission.id));
			await pane.setInput(cycleInput, undefined, {}, CancellationToken.None);
			assert.strictEqual(alertEl.hidden, false, 'Parse error surfaces on floating canvas alert when File Drawer is closed');
			assert.strictEqual(alertEl.dataset.alertKind, 'error');

			// Switch to Gate mission with 2 waiting waves -> Gate popover exposes wave switcher & summary preview
			const onTriggerFire = store.add(new Emitter<{ readonly missionId: string; readonly triggerId: string; readonly nodeId: string; readonly kind: 'interval'; readonly detail?: string; readonly timestamp: number }>());
			const gateH = createHarness([alpha]);
			gateH.modes.setMode('ade');
			gateH.instantiation.stub(IAdeEngineeringBackendService, upcastPartial<IAdeEngineeringBackendService>({
				onDidSourceTriggerFire: onTriggerFire.event,
				loadInbox: async () => [],
				saveInbox: async () => undefined,
			}));
			const gateRoleSchema = store.add(gateH.instantiation.createInstance(AdeRoleSchemaService));
			gateH.instantiation.stub(IAdeRoleSchemaService, gateRoleSchema);
			const gateMissionStore = store.add(gateH.instantiation.createInstance(AdeMissionStoreService));
			gateH.instantiation.stub(IAdeMissionService, gateMissionStore);
			const gateMissionRuntime = store.add(gateH.instantiation.createInstance(AdeMissionRuntimeService));
			gateH.instantiation.stub(IAdeMissionRuntimeService, gateMissionRuntime);

			const gateMission = gateMissionStore.createMission({
				title: 'Multi-Wave Gate',
				mermaidText: 'flowchart LR\n  N1["Build"] --> G1{"Release Gate"}',
			});
			const gateHost = append(document.body, $('.monaco-workbench.ade-mission-multiwave-gate-host'));
			store.add({ dispose: () => gateHost.remove() });
			const gatePane = store.add(gateH.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
			gatePane.create(gateHost);
			const gateInput = store.add(gateH.instantiation.createInstance(AdeEngineeringEditorInput, gateMission.id));
			await gatePane.setInput(gateInput, undefined, {}, CancellationToken.None);

			await gateMissionRuntime.setTrigger(gateMission.id, { nodeId: 'N1', kind: 'interval', intervalMs: 60000, enabled: true, autoStartOnMissionStart: true }, { isHumanUser: true });
			const triggerId = gateMissionRuntime.listTriggers(gateMission.id)[0].id;
			await gateMissionRuntime.start(gateMission.id);
			const w1Tok = Object.values(gateMissionRuntime.getRuntimeState(gateMission.id).tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
			await gateMissionRuntime.completeToken(gateMission.id, { tokenId: w1Tok.id, summary: 'Wave 1 build artifact ready' });

			// Fire a second wave via source trigger event and complete it to queue a second token on G1
			onTriggerFire.fire({ missionId: gateMission.id, triggerId, nodeId: 'N1', kind: 'interval', detail: 'Wave 2 trigger', timestamp: Date.now() });
			await new Promise(resolve => setTimeout(resolve, 20));
			const w2Tok = Object.values(gateMissionRuntime.getRuntimeState(gateMission.id).tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
			assert.ok(w2Tok, 'Source trigger fires Wave 2 active token on N1');
			await gateMissionRuntime.completeToken(gateMission.id, { tokenId: w2Tok.id, summary: 'Wave 2 hotfix artifact ready' });

			// Gate card shows multi-wave token puck (+1) and Gate popover lists both queued waves!
			const gatePuck = gateHost.querySelector<HTMLButtonElement>('button[data-ade-token-puck="G1"]')!;
			assert.strictEqual(gatePuck.getAttribute('data-live-token-count'), '2', 'Gate token puck reflects 2 concurrent waiting waves');
			const gateEl = gateHost.querySelector<HTMLElement>('.ade-mission-node[data-node-id="G1"].state-waiting-gate')!;
			const win = gateEl.ownerDocument.defaultView!;
			gateEl.dispatchEvent(new win.PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 20, bubbles: true }));
			gateEl.dispatchEvent(new win.PointerEvent('pointerup', { button: 0, clientX: 20, clientY: 20, bubbles: true }));
			const waveBtns = gateHost.querySelectorAll<HTMLButtonElement>('[data-ade-gate-wave-switcher="true"] button[data-ade-gate-wave-btn]');
			assert.strictEqual(waveBtns.length, 2, 'Multi-wave Gate popover lists both queued waves');
			assert.ok(gateHost.querySelector('[data-ade-gate-summary="true"]')?.textContent?.includes('Wave 1 build artifact ready'));
			waveBtns[1].click();
			assert.ok(gateHost.querySelector('[data-ade-gate-summary="true"]')?.textContent?.includes('Wave 2 hotfix artifact ready'), 'Switching wave in Gate popover updates preview to Wave 2');
			const w2GateTokenId = waveBtns[1].getAttribute('data-ade-gate-wave-btn')!;
			gateHost.querySelector<HTMLButtonElement>('button[data-ade-gate-approve="G1"]')!.click();
			await new Promise(resolve => setTimeout(resolve, 20));
			assert.strictEqual(gateMissionRuntime.getRuntimeState(gateMission.id).tokens[w2GateTokenId]?.status, 'completed', 'Approving selected Wave 2 resolves Wave 2 token specifically');
		});

		test('keeps only top-left File Drawer & Start pills on top bar, exposes Factory Wall cutoff in drawer, always-visible Supervisor pills & spotlight, Source Triggers studio from entry port, docked Node Inspector, and position-preserving Fit-to-View', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const openedAgents: Array<{ readonly id: string; readonly side?: boolean }> = [];
			h.instantiation.stub(IAdeEditorService, upcastPartial<IAdeEditorService>({
				openAgent: async (id: string, opts?: { side?: boolean }) => {
					openedAgents.push({ id, side: opts?.side });
				},
			}));

			const mission = missionStore.createMission({
				title: 'Command Center UX Mission',
				mermaidText: 'flowchart LR\n  N1["Data Ingest"] --> N2["Train Model"]',
			});
			const host = append(document.body, $('.monaco-workbench.ade-mission-command-ux-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const mockGroup = upcastPartial<IEditorGroup>({ id: 1, index: 0 });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, mission.id));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			// 1. Minimalist top bar exposes ONLY File Drawer toggle + Run Control pill; Cutoff lives inside File Drawer
			const topBar = host.querySelector<HTMLElement>('[data-ade-mission-top-bar="true"]')!;
			assert.strictEqual(topBar.children.length, 2, 'Top bar contains ONLY File Drawer toggle and Run Control pill');
			assert.ok(topBar.querySelector('[data-ade-mission-file-btn="true"]'));
			assert.ok(topBar.querySelector('[data-ade-mission-run-bar="true"]'));
			assert.strictEqual(host.querySelector<HTMLElement>('[data-ade-mission-drawer="true"]')?.hidden, true);
			host.querySelector<HTMLButtonElement>('[data-ade-mission-file-btn="true"]')!.click();
			const drawerCutoff = host.querySelector<HTMLSelectElement>('[data-ade-mission-cutoff-select="true"]')!;
			drawerCutoff.value = '1';
			drawerCutoff.dispatchEvent(new (drawerCutoff.ownerDocument.defaultView!.Event)('change', { bubbles: true }));
			await new Promise(resolve => setTimeout(resolve, 25));
			assert.strictEqual(missionRuntime.getRuntimeState(mission.id).boundary.offGraphMaxTier, 1);
			host.querySelector<HTMLButtonElement>('[data-ade-mission-file-btn="true"]')!.click();

			// 2. Always-visible Supervisor pill & jurisdiction legend + spotlight (no opacity:0 hunting!)
			const n1SupBtn = host.querySelector<HTMLButtonElement>('button[data-node-sup-btn="N1"]')!;
			assert.ok(n1SupBtn, 'Task card renders dedicated always-visible Supervisor pill');
			n1SupBtn.click();
			const secOpt = host.querySelector<HTMLButtonElement>(`button[data-ade-sup-option="${ADE_SECRETARY_ID}"]`)!;
			assert.ok(secOpt, 'Dedicated Supervisor popover lists eligible off-graph supervisors');
			secOpt.click();
			await new Promise(resolve => setTimeout(resolve, 25));

			const n1El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			const n2El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			assert.strictEqual(n1El.getAttribute('data-node-supervisor-id'), ADE_SECRETARY_ID, 'Bound supervisor is visibly tagged on node card');
			const legend = host.querySelector<HTMLElement>('[data-ade-mission-sup-legend="true"]')!;
			assert.strictEqual(legend.hidden, false, 'Supervisor Jurisdiction Legend appears once a supervisor is bound');
			const secLegendChip = legend.querySelector<HTMLButtonElement>(`button[data-ade-sup-legend-id="${ADE_SECRETARY_ID}"]`)!;
			assert.ok(secLegendChip, 'Legend renders Secretary jurisdiction chip');
			secLegendChip.click();
			assert.ok(host.querySelector('.ade-mission-world.has-supervisor-highlight'), 'Clicking legend chip spotlights managed nodes across canvas');
			assert.strictEqual(n1El.classList.contains('is-supervised-highlight'), true, 'Managed node N1 is spotlighted');
			assert.strictEqual(n2El.classList.contains('is-supervised-highlight'), false, 'Unmanaged node N2 is not spotlighted');
			secLegendChip.click();
			assert.strictEqual(host.querySelector('.ade-mission-world.has-supervisor-highlight'), null, 'Clicking again unpins spotlight');

			// 3. Zero-Token Source Triggers Studio opened directly from entry node Pacemaker port
			const n1PacemakerBtn = host.querySelector<HTMLButtonElement>('button[data-ade-pacemaker-port="N1"]')!;
			assert.ok(n1PacemakerBtn, 'Entry node exposes Pacemaker port to open Source Triggers studio');
			n1PacemakerBtn.click();
			const nodeSel = host.querySelector<HTMLSelectElement>('select[data-ade-trigger-node-select="true"]')!;
			assert.strictEqual(nodeSel.options.length, 1, 'Only inDegree===0 && outDegree>=1 entry node N1 is eligible for source triggers');
			assert.strictEqual(nodeSel.options[0].value, 'N1');
			const intervalInput = host.querySelector<HTMLInputElement>('input[data-ade-trigger-interval-input="true"]')!;
			intervalInput.value = '30s';
			host.querySelector<HTMLButtonElement>('button[data-ade-trigger-submit="true"]')!.click();
			await new Promise(resolve => setTimeout(resolve, 25));

			// Add a second GPU-idle event trigger too!
			const kindSel = host.querySelector<HTMLSelectElement>('select[data-ade-trigger-kind-select="true"]')!;
			kindSel.value = 'event';
			kindSel.dispatchEvent(new (kindSel.ownerDocument.defaultView!.Event)('change', { bubbles: true }));
			const evtSel = host.querySelector<HTMLSelectElement>('select[data-ade-trigger-event-type="true"]')!;
			evtSel.value = 'gpu_idle';
			evtSel.dispatchEvent(new (evtSel.ownerDocument.defaultView!.Event)('change', { bubbles: true }));
			host.querySelector<HTMLButtonElement>('button[data-ade-trigger-submit="true"]')!.click();
			await new Promise(resolve => setTimeout(resolve, 25));

			assert.strictEqual(missionRuntime.listTriggers(mission.id).length, 2, 'Both interval and gpu_idle triggers persisted');
			const n1TrigBadge = host.querySelector<HTMLButtonElement>('button[data-ade-node-trigger-badge="N1"]')!;
			assert.strictEqual(n1TrigBadge.hidden, false, 'Entry node N1 displays on-canvas Source Trigger badge');
			assert.strictEqual(n1TrigBadge.getAttribute('data-trigger-count'), '2');

			// Toggle pause and delete first trigger from studio
			const firstTrigId = missionRuntime.listTriggers(mission.id)[0].id;
			host.querySelector<HTMLButtonElement>(`button[data-ade-trigger-toggle="${firstTrigId}"]`)!.click();
			await new Promise(resolve => setTimeout(resolve, 20));
			assert.strictEqual(missionRuntime.listTriggers(mission.id).find(t => t.id === firstTrigId)?.enabled, false);
			host.querySelector<HTMLButtonElement>(`button[data-ade-trigger-delete="${firstTrigId}"]`)!.click();
			await new Promise(resolve => setTimeout(resolve, 20));
			assert.strictEqual(missionRuntime.listTriggers(mission.id).length, 1);

			// 4. Single-clicking task card stays on canvas & opens docked Node Command Drawer (never switches tab!)
			const win = n1El.ownerDocument.defaultView!;
			n1El.dispatchEvent(new win.PointerEvent('pointerdown', { button: 0, clientX: 50, clientY: 50, bubbles: true }));
			n1El.dispatchEvent(new win.PointerEvent('pointerup', { button: 0, clientX: 50, clientY: 50, bubbles: true }));
			assert.strictEqual(openedAgents.length, 0, 'Single-clicking task card MUST NOT switch away from Mission canvas into chat tab');
			assert.strictEqual(n1El.classList.contains('is-selected'), true, 'Clicked node N1 receives selected ring on canvas');
			const inspector = host.querySelector<HTMLElement>('[data-ade-mission-node-inspector="true"]')!;
			assert.strictEqual(inspector.hidden, false, 'Docked right-side Node Command Drawer opens in-canvas');
			assert.strictEqual(inspector.dataset.nodeId, 'N1');

			// Explicit Split Chat Beside opens chat in side pane; Open Tab switches directly
			const splitBtn = inspector.querySelector<HTMLButtonElement>('[data-ade-inspector-open-beside]')!;
			const tabBtn = inspector.querySelector<HTMLButtonElement>('[data-ade-inspector-open-tab]')!;
			assert.ok(splitBtn && tabBtn, 'Node Command Drawer exposes explicit Split Chat Beside and Open Tab actions');
			splitBtn.click();
			assert.strictEqual(openedAgents.length, 1);
			assert.strictEqual(openedAgents[0].side, true, 'Split Chat Beside opens Agent chat with { side: true }');
			tabBtn.click();
			assert.strictEqual(openedAgents.length, 2);
			assert.strictEqual(openedAgents[1].side, undefined, 'Open Tab opens Agent chat normally');

			// 5. Dedicated Fit-to-View button fits viewport WITHOUT wiping manual node coordinates!
			missionStore.updateNodePositions(mission.id, { N1: { x: 888, y: 666 } });
			await pane.setInput(input, undefined, {}, CancellationToken.None);
			assert.strictEqual(host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')?.style.left, '888px');
			host.querySelector<HTMLButtonElement>('[data-ade-mission-zoom-in="true"]')!.click();
			const zoomedLabel = host.querySelector('[data-ade-mission-zoom-label="true"]')?.textContent;
			assert.ok(zoomedLabel && zoomedLabel !== '100%', `Zoom In updates live zoom readout, got: ${zoomedLabel}`);
			host.querySelector<HTMLButtonElement>('[data-ade-mission-fit-view="true"]')!.click();
			assert.strictEqual(missionStore.getMission(mission.id)?.positions?.N1?.x, 888, 'Fit-to-View MUST preserve manually arranged node X coordinate');
			assert.strictEqual(missionStore.getMission(mission.id)?.positions?.N1?.y, 666, 'Fit-to-View MUST preserve manually arranged node Y coordinate');
			assert.strictEqual(host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')?.style.left, '888px', 'Fit-to-View does not reset manual node DOM coordinates');
		});

		test('routes flowchart TD vertically (bottom-out to top-in), sizes CJK edge labels without clipping, prevents negative coordinates on 7 parallel nodes, and renders Zoom Slider + interactive Minimap', async () => {
			const { h, missionStore } = createMissionHarness();
			// 1. Vertical TD graph with a Chinese edge label + 7 parallel sibling nodes in one layer!
			const tdMermaid = [
				'flowchart TD',
				'  ROOT["入口分发"] -->|审批不通过打回重做| P1["分支1"]',
				'  ROOT --> P2["分支2"]',
				'  ROOT --> P3["分支3"]',
				'  ROOT --> P4["分支4"]',
				'  ROOT --> P5["分支5"]',
				'  ROOT --> P6["分支6"]',
				'  ROOT --> P7["分支7"]',
			].join('\n');
			const tdMission = missionStore.createMission({ title: 'TD + CJK + Minimap Mission', mermaidText: tdMermaid });

			const host = append(document.body, $('.monaco-workbench.ade-mission-td-minimap-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const mockGroup = upcastPartial<IEditorGroup>({ id: 1, index: 0 });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			const tdInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, tdMission.id));
			await pane.setInput(tdInput, undefined, {}, CancellationToken.None);

			// World gets dir-td & data-dag-direction="TD"
			const worldEl = host.querySelector<HTMLElement>('.ade-mission-world')!;
			assert.strictEqual(worldEl.classList.contains('dir-td'), true, 'flowchart TD marks world with dir-td');
			assert.strictEqual(worldEl.dataset.dagDirection, 'TD');

			// All 8 nodes (including 7 parallel siblings in one row!) have strictly positive coordinates with safe left/top margins
			const nodeEls = Array.from(host.querySelectorAll<HTMLElement>('.ade-mission-node'));
			assert.strictEqual(nodeEls.length, 8);
			for (const el of nodeEls) {
				const x = Number.parseFloat(el.style.left);
				const y = Number.parseFloat(el.style.top);
				assert.ok(x >= 200, `Node ${el.dataset.nodeId} X (${x}) must never drift into negative/clipped region`);
				assert.ok(y >= 150, `Node ${el.dataset.nodeId} Y (${y}) must never drift into negative/clipped region`);
			}

			// Edge ROOT -> P1 starts at ROOT bottom-center (rootX, rootY + 110) and ends at P1 top-center (p1X, p1Y - 114)
			const rootEl = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="ROOT"]')!;
			const p1El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="P1"]')!;
			const rootX = Number.parseFloat(rootEl.style.left);
			const rootY = Number.parseFloat(rootEl.style.top);
			const p1X = Number.parseFloat(p1El.style.left);
			const p1Y = Number.parseFloat(p1El.style.top);
			const edgePath = host.querySelector<SVGPathElement>('.ade-mission-edge-group[data-from="ROOT"][data-to="P1"] path')!.getAttribute('d')!;
			assert.ok(edgePath.startsWith(`M ${rootX} ${rootY + 110}`), `TD edge must exit bottom-center (${rootX}, ${rootY + 110}), got: ${edgePath}`);
			assert.ok(edgePath.endsWith(`L ${p1X} ${p1Y - 114}`), `TD edge must enter top-center (${p1X}, ${p1Y - 114}), got: ${edgePath}`);

			// Chinese edge label ("审批不通过打回重做", 9 CJK chars) receives generous CJK-aware pill width (>= 120px, NOT cramped 79px!)
			const labelBg = host.querySelector<SVGRectElement>('.ade-mission-edge-group[data-from="ROOT"][data-to="P1"] .ade-mission-edge-label-bg')!;
			const labelWidth = Number.parseFloat(labelBg.getAttribute('width') ?? '0');
			assert.ok(labelWidth >= 120, `Chinese edge label pill must be wide enough for CJK glyphs (>=120px), got ${labelWidth}px`);

			// Zoom scale slider updates zoom & readout smoothly
			const zoomSlider = host.querySelector<HTMLInputElement>('input[data-ade-mission-zoom-slider="true"]')!;
			assert.ok(zoomSlider, 'Zoom scale slider renders in viewport controls bar');
			zoomSlider.value = '150';
			zoomSlider.dispatchEvent(new (zoomSlider.ownerDocument.defaultView!.Event)('input', { bubbles: true }));
			assert.strictEqual(host.querySelector('[data-ade-mission-zoom-label="true"]')?.textContent, '150%');

			// Interactive bottom-right Minimap renders all 8 nodes, live viewport rect, supports click-to-pan and toggle
			const minimapEl = host.querySelector<HTMLElement>('[data-ade-mission-minimap="true"]')!;
			assert.strictEqual(minimapEl.hidden, false, 'Minimap is visible by default for non-empty graph');
			assert.strictEqual(minimapEl.querySelectorAll('[data-minimap-node]').length, 8, 'Minimap renders miniature rect for every node');
			const vpRect = minimapEl.querySelector<SVGRectElement>('[data-ade-minimap-viewport="true"]')!;
			assert.ok(Number.parseFloat(vpRect.getAttribute('width') ?? '0') > 0, 'Minimap tracks live viewport rectangle');

			const toggleBtn = host.querySelector<HTMLButtonElement>('[data-ade-mission-minimap-toggle="true"]')!;
			toggleBtn.click();
			assert.strictEqual(minimapEl.hidden, true, 'Minimap toggle hides minimap cleanly');
			toggleBtn.click();
			assert.strictEqual(minimapEl.hidden, false, 'Minimap toggle restores minimap cleanly');
		});

		test('renders all 4 flagship capabilities: gliding edge pucks & pacemaker port, FinOps guardrail & budget circuit-breaker, Hold-Tab supervisor X-Ray & cross-cloud territory halos & v1->vN timeline replay, and 4-in-1 Inspector with distill & dblclick chat', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const openedAgents: Array<{ readonly id: string; readonly side?: boolean }> = [];
			h.instantiation.stub(IAdeEditorService, upcastPartial<IAdeEditorService>({
				openAgent: async (id: string, opts?: { side?: boolean }) => {
					openedAgents.push({ id, side: opts?.side });
				},
			}));
			h.instantiation.stub(IAdeCloudHostBackendService, upcastPartial<IAdeCloudHostBackendService>({
				listHosts: async () => [{
					id: 'h-ubuntu',
					name: 'Ubuntu H100',
					alias: 'ubuntu-h100',
					hostName: '10.0.0.88',
					user: 'root',
					port: 22,
					os: 'linux',
					recentDirectories: [],
					source: 'user',
					createdAt: 1,
					updatedAt: 1,
				}],
			}));

			const mission = missionStore.createMission({
				title: 'Flagship Studio Mission',
				mermaidText: 'flowchart LR\n  N1["Data Ingest"] --> N2["Train GPU"]',
			});
			// Bind N2 to cloud host ubuntu-h100 and bind Secretary as off-graph supervisor of N1
			await missionRuntime.setBoundary(mission.id, {
				supervisors: [{ id: ADE_SECRETARY_ID, tier: 0, managedNodeIds: ['N1'] }],
				nodeAssignments: {
					...missionRuntime.getRuntimeState(mission.id).boundary.nodeAssignments,
					N2: {
						...(missionRuntime.getRuntimeState(mission.id).boundary.nodeAssignments.N2 ?? { tier: 2 }),
						hostAlias: 'ubuntu-h100',
					},
				},
			});

			const host = append(document.body, $('.monaco-workbench.ade-mission-flagship-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const mockGroup = upcastPartial<IEditorGroup>({ id: 1, index: 0 });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, mission.id));
			await pane.setInput(input, undefined, {}, CancellationToken.None);
			await new Promise(resolve => setTimeout(resolve, 35));

			// 1. Source Pacemaker Pulse Port on entry node N1 (and NOT on downstream N2)
			const pacemakerN1 = host.querySelector<HTMLButtonElement>('button[data-ade-pacemaker-port="N1"]')!;
			assert.ok(pacemakerN1, 'Entry generator node N1 renders interactive Source Pacemaker Pulse Port');
			assert.strictEqual(host.querySelector('button[data-ade-pacemaker-port="N2"]'), null, 'Downstream node N2 does not render Source Pacemaker Port');

			// Cross-Cloud Compute Territory Contour Halos for @ubuntu-h100 and @local + toggle button
			assert.ok(host.querySelector('[data-cloud-territory="ubuntu-h100"]'), 'Renders dashed Cross-Cloud Territory halo for @ubuntu-h100');
			assert.ok(host.querySelector('[data-cloud-territory="local"]'), 'Renders Local Territory halo when mixed with cloud hosts');
			const haloToggleBtn = host.querySelector<HTMLButtonElement>('button[data-ade-mission-cloud-halo-toggle="true"]')!;
			haloToggleBtn.click();
			assert.strictEqual(host.querySelector('[data-cloud-territory="ubuntu-h100"]'), null, 'Cloud halo toggle hides territory contours');
			haloToggleBtn.click();
			assert.ok(host.querySelector('[data-cloud-territory="ubuntu-h100"]'), 'Cloud halo toggle restores territory contours');

			// Start Mission & advance token N1 -> N2 to activate physical gliding Token Puck along edge N1->N2
			const started = await missionRuntime.start(mission.id);
			assert.strictEqual(started.ok, true, started.error);
			const n1Tok = Object.values(missionRuntime.getRuntimeState(mission.id).tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
			const completedN1 = await missionRuntime.completeToken(mission.id, { tokenId: n1Tok.id, summary: 'Dataset prepared cleanly' });
			assert.strictEqual(completedN1.ok, true, completedN1.error);

			const edgePuck = host.querySelector<SVGGElement>('[data-ade-edge-puck]')!;
			assert.ok(edgePuck, 'Active edge N1->N2 spawns physical gliding Token Puck along SVG route');
			assert.ok(edgePuck.style.offsetPath.includes('path('), `Gliding puck uses GPU offset-path, got: ${edgePuck.style.offsetPath}`);
			const pacemakerN1Live = host.querySelector<HTMLButtonElement>('button[data-ade-pacemaker-port="N1"]')!;
			assert.strictEqual(pacemakerN1Live.getAttribute('data-pacemaker-armed'), 'true', 'Pacemaker pulses when Mission is running');

			// 2. FinOps Top-Bar Guardrail Pill + Per-Card $USD (zero DOM teardown!) + Budget Circuit-Breaker + Raise & Resume
			const n2ElBefore = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			missionRuntime.recordNodeTurnUsage(mission.id, 'N2', {
				inputTokens: 20_000,
				outputTokens: 5_000,
				cacheReadTokens: 80_000,
				totalTokens: 105_000,
				costUsd: 1.25,
				isNoiseTurn: true,
			});
			const n2ElAfter = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			assert.strictEqual(n2ElAfter, n2ElBefore, 'Live FinOps/telemetry tick patches per-card $USD in place with zero DOM teardown');
			const n2CostEl = n2ElAfter.querySelector<HTMLElement>('[data-node-cost-usd]')!;
			assert.strictEqual(n2CostEl.hidden, false);
			assert.strictEqual(n2CostEl.textContent, '$1.25');

			// Open 4-in-1 Inspector by clicking N2 and switching to FinOps Ledger tab
			const win = n2ElAfter.ownerDocument.defaultView!;
			n2ElAfter.dispatchEvent(new win.PointerEvent('pointerdown', { button: 0, clientX: 60, clientY: 60, bubbles: true }));
			n2ElAfter.dispatchEvent(new win.PointerEvent('pointerup', { button: 0, clientX: 60, clientY: 60, bubbles: true }));
			const inspector = host.querySelector<HTMLElement>('[data-ade-mission-node-inspector="true"]')!;
			assert.strictEqual(inspector.hidden, false);
			inspector.querySelector<HTMLButtonElement>('[data-ade-inspector-tab="finops"]')!.click();
			assert.strictEqual(inspector.dataset.activeTab, 'finops');
			assert.ok(inspector.querySelector('[data-ade-finops-by-tier="true"]')?.textContent?.includes('L2'));
			assert.ok(inspector.querySelector('[data-ade-finops-by-host="true"]')?.textContent?.includes('@ubuntu-h100'));

			// Setting budget ceiling below $1.25 trips real engine circuit-breaker and auto-pauses Mission!
			const budgetInput = inspector.querySelector<HTMLInputElement>('[data-ade-finops-budget-input="true"]')!;
			budgetInput.value = '1.00';
			budgetInput.dispatchEvent(new (budgetInput.ownerDocument.defaultView!.Event)('change', { bubbles: true }));
			await new Promise(resolve => setTimeout(resolve, 25));
			assert.strictEqual(missionRuntime.getRuntimeState(mission.id).status, 'paused', 'Budget ceiling auto-pauses Mission');
			assert.strictEqual(missionRuntime.getRuntimeState(mission.id).budgetCircuitTripped, true);
			assert.ok(inspector.querySelector('[data-ade-finops-tripped-banner="true"]'), 'Inspector shows tripped breaker alert');

			// Clicking "Raise & Resume" atomically increases limit and resumes Mission!
			inspector.querySelector<HTMLButtonElement>('[data-ade-finops-raise-resume="true"]')!.click();
			await new Promise(resolve => setTimeout(resolve, 35));
			assert.strictEqual(missionRuntime.getRuntimeState(mission.id).status, 'running', 'Raise & Resume restores running state');
			assert.strictEqual(missionRuntime.getRuntimeState(mission.id).budgetCircuitTripped, false);

			// 3. 4-in-1 Inspector tabs (Token + lazy trace_ptr, Distill one-click context refresh) + dblclick opens full chat tab
			assert.strictEqual(openedAgents.length, 0, 'Single-click stays on canvas');

			inspector.querySelector<HTMLButtonElement>('[data-ade-inspector-tab="token"]')!.click();
			assert.ok(inspector.querySelector('[data-ade-ni-last-summary="true"]')?.textContent?.includes('Dataset prepared cleanly'));
			inspector.querySelector<HTMLButtonElement>('[data-ade-ni-expand-trace="true"]')!.click();
			assert.ok(inspector.querySelectorAll('.ade-mission-token-trace-row').length >= 1, 'Lazy trace_ptr expands trace history inside Inspector');

			inspector.querySelector<HTMLButtonElement>('[data-ade-inspector-tab="distill"]')!.click();
			const memoInput = inspector.querySelector<HTMLInputElement>('[data-ade-ni-distill-memo="true"]')!;
			memoInput.value = 'Keep epoch checkpoint only';
			inspector.querySelector<HTMLButtonElement>('[data-ade-ni-distill="N2"]')!.click();
			await new Promise(resolve => setTimeout(resolve, 35));
			assert.strictEqual(missionRuntime.getRuntimeState(mission.id).nodeTelemetry?.N2?.contextNoiseTokens, 0, 'One-click Distill clears noisy context');
			assert.strictEqual(missionRuntime.getRuntimeState(mission.id).nodeTelemetry?.N2?.costUsd, 1.25, 'Distill keeps cumulative USD honest');

			n2ElAfter.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
			assert.strictEqual(openedAgents.length, 1, 'Double-clicking task card opens Agent chat');
			assert.strictEqual(openedAgents[0].side, undefined, 'Double-click opens full Agent chat tab');

			// 4. Hold-Tab Off-Graph Supervisor X-Ray Spotlight
			win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
			assert.ok(host.querySelector('.ade-mission-world.is-tab-spotlight-active'), 'Holding Tab activates Supervisor X-Ray mode');
			assert.strictEqual(host.querySelector<HTMLElement>('[data-ade-tab-spotlight-banner="true"]')?.hidden, false);
			assert.ok(host.querySelector(`[data-supervisor-beam="${ADE_SECRETARY_ID}"][data-target-node="N1"]`), 'Draws X-Ray command beam from off-graph Supervisor to managed node N1');
			win.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));
			assert.strictEqual(host.querySelector('.ade-mission-world.is-tab-spotlight-active'), null, 'Releasing Tab exits X-Ray cleanly');
			assert.strictEqual(host.querySelector<HTMLElement>('[data-ade-tab-spotlight-banner="true"]')?.hidden, true);
			assert.strictEqual(host.querySelector('[data-supervisor-beam]'), null);

			// 5. v1 -> vN Dynamic Patch Revision Timeline Replay (non-destructive!)
			const patched = await missionRuntime.patchMermaid(mission.id, {
				caller: { isHumanUser: true },
				newMermaidText: 'flowchart LR\n  N1["Data Ingest"] --> N2["Train GPU"]\n  N2 --> N3["Deploy"]',
				reason: 'Add Deploy step',
			});
			assert.strictEqual(patched.ok, true, patched.error);
			const revBar = host.querySelector<HTMLElement>('[data-ade-mission-revision-bar="true"]')!;
			assert.strictEqual(revBar.hidden, false, 'v1->vN Timeline Bar appears once ≥2 revisions exist');
			assert.strictEqual(host.querySelectorAll('.ade-mission-node').length, 3, 'Live v2 renders 3 nodes');

			revBar.querySelector<HTMLButtonElement>('button[data-ade-revision-btn="1"]')!.click();
			assert.strictEqual(host.querySelectorAll('.ade-mission-node').length, 2, 'Clicking v1 replays historical 2-node topology non-destructively');
			assert.ok(missionStore.getMission(mission.id)?.mermaidText.includes('N3'), 'Historical replay NEVER mutates live missionStore Mermaid');

			revBar.querySelector<HTMLButtonElement>('button[data-ade-revision-exit="true"]')!.click();
			assert.strictEqual(host.querySelectorAll('.ade-mission-node').length, 3, 'Exiting replay restores live 3-node topology');
		});

		test('Cloud Mission HA: window reload recovery passes preferReattach, Recall passes hostAlias to stop, and system resume wakes SSH bridges', async () => {
			const cloudProjUri = URI.parse('aexus-ssh://gpu-h100/srv/ml-train');
			const h = createHarness([cloudProjUri]);
			h.modes.setMode('ade');
			const resumeEmitter = store.add(new Emitter<number>());
			type WatchdogSnapshotArg = Parameters<NonNullable<IAdeEngineeringBackendService['syncMissionWatchdog']>>[0];
			const syncedSnapshots: WatchdogSnapshotArg[] = [];
			const executedCommands: Array<{ readonly id: string; readonly args: readonly unknown[] }> = [];
			const stopCalls: Array<{ readonly resource: string; readonly hostAlias?: string }> = [];

			const cloudAgent = h.projects.addSession(
				cloudProjUri,
				{
					engineId: 'aexus-claude',
					resource: URI.parse('aexus-claude:/sess-gpu-ha-1'),
				},
				'GPU Trainer',
				{ role: 'employee' },
			);

			h.instantiation.stub(IAdeEngineeringBackendService, upcastPartial<IAdeEngineeringBackendService>({
				onDidSystemResume: resumeEmitter.event,
				loadInbox: async () => [],
				saveInbox: async () => undefined,
				syncMissionWatchdog: async snap => { syncedSnapshots.push(snap); },
				removeMissionWatchdog: async () => undefined,
			}));
			h.instantiation.stub(IAdeSessionsService, upcastPartial<IAdeSessionsService>({
				onDidChangeEngines: Event.None,
				getIcon: () => undefined,
				getEngineName: () => 'Claude Code',
				getEngines: async () => [{ id: 'aexus-claude', name: 'Claude Code', description: '' }],
				create: async (engineId, projectUri) => ({
					engineId,
					resource: URI.parse(`${engineId}:/sess-new`),
					projectUri,
					label: 'New',
				}),
				list: async () => [],
				rename: async () => undefined,
				delete: async () => undefined,
				stop: async (session, options) => {
					stopCalls.push({ resource: session.resource.toString(), hostAlias: options?.hostAlias });
				},
			}));
			h.instantiation.stub(ICommandService, upcastPartial<ICommandService>({
				executeCommand: (async (id: string, ...args: unknown[]) => {
					executedCommands.push({ id, args });
					return { reply: 'reattached ok', stopped: false, reattached: true };
				}) as ICommandService['executeCommand'],
			}));

			const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
			h.instantiation.stub(IAdeRoleSchemaService, roleSchema);
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const runtime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, runtime);

			const mission = missionStore.createMission({
				title: 'Cloud HA Pipeline',
				mermaidText: 'flowchart LR\n  Train["Train GPU"] --> Eval["Eval"]',
				projectUri: cloudProjUri.toString(),
			});
			await runtime.setBoundary(mission.id, {
				nodeAssignments: {
					...runtime.getRuntimeState(mission.id).boundary.nodeAssignments,
					Train: {
						...(runtime.getRuntimeState(mission.id).boundary.nodeAssignments.Train ?? { tier: 2 }),
						agentId: cloudAgent.id,
						hostAlias: 'gpu-h100',
					},
				},
			});

			const started = await runtime.start(mission.id);
			assert.strictEqual(started.ok, true);
			await new Promise(resolve => setTimeout(resolve, 25));

			// 1. Watchdog snapshot includes hostAlias + deterministic remoteSessionPrefix for fast dead-session probing!
			const lastSnap = syncedSnapshots[syncedSnapshots.length - 1];
			assert.ok(lastSnap, 'Watchdog snapshot synced');
			const activeSnapToken = lastSnap.tokens.find(t => t.nodeId === 'Train');
			assert.strictEqual(activeSnapToken?.hostAlias, 'gpu-h100');
			assert.ok(activeSnapToken?.remoteSessionPrefix?.startsWith('claude-'), `Expected deterministic claude prefix, got: ${activeSnapToken?.remoteSessionPrefix}`);

			// 2. OS resume from laptop sleep immediately wakes extension-host SSH reattach / reverse bridge healing!
			resumeEmitter.fire(Date.now());
			assert.ok(
				executedCommands.some(c => c.id === 'aexus.agentEngines.notifySystemResume'),
				'onDidSystemResume must immediately trigger aexus.agentEngines.notifySystemResume',
			);

			// 3. Post-reload recovery passes preferReattach: true for cloud agents so live remote processes are reattached instead of duplicated!
			executedCommands.length = 0;
			const recovered = await runtime.recoverInterruptedActiveTokens(mission.id);
			assert.strictEqual(recovered, 1, 'recoverInterruptedActiveTokens must recover active cloud token immediately');
			const recoverDispatch = executedCommands.find(c => c.id === 'aexus.agentEngines.dispatchEngineeringTurn');
			assert.ok(recoverDispatch, 'Recovery dispatched turn');
			const dispatchOpts = recoverDispatch!.args[2] as { preferReattach?: boolean } | undefined;
			assert.strictEqual(dispatchOpts?.preferReattach, true, 'Cloud recovery MUST pass preferReattach: true');

			// 4. Recall passes hostAlias to sessionsService.stop so post-reload Recall kills remote GPU process trees!
			await runtime.recallTokens(mission.id, {
				caller: { isHumanUser: true },
				nodeIds: ['Train'],
				reason: 'Abort GPU run cleanly',
			});
			assert.ok(
				stopCalls.some(c => c.resource === 'aexus-claude:/sess-gpu-ha-1' && c.hostAlias === 'gpu-h100'),
				`Recall must pass hostAlias gpu-h100 to sessionsService.stop, got: ${JSON.stringify(stopCalls)}`,
			);
		});

		test('Mission Canvas patches lifecycle/model/engine-lock in-place (zero DOM teardown), ignores unrelated sidebar chats, and AdeMissionStoreService preserves locally dirty records across external storage events', async () => {
			const projUri = URI.file('/tmp/mission-perf-proj');
			const h = createHarness([projUri]);
			h.modes.setMode('ade');
			h.instantiation.stub(IAdeEngineeringBackendService, upcastPartial<IAdeEngineeringBackendService>({
				loadInbox: async () => [],
				saveInbox: async () => undefined,
				syncMissionWatchdog: async () => undefined,
				removeMissionWatchdog: async () => undefined,
			}));
			h.instantiation.stub(IAdeSessionsService, upcastPartial<IAdeSessionsService>({
				onDidChangeEngines: Event.None,
				getIcon: () => undefined,
				getEngineName: id => id === 'aexus-claude' ? 'Claude Code' : id,
				getEngines: async () => [{ id: 'aexus-claude', name: 'Claude Code', description: '' }],
				create: async (engineId, projectUri) => ({ engineId, resource: URI.parse(`${engineId}:/sess-perf`), projectUri, label: 'Perf' }),
				list: async () => [],
				rename: async () => undefined,
				delete: async () => undefined,
				stop: async () => undefined,
			}));
			h.instantiation.stub(ICommandService, upcastPartial<ICommandService>({
				executeCommand: (async () => ({ reply: 'ok', stopped: false })) as ICommandService['executeCommand'],
			}));

			const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
			h.instantiation.stub(IAdeRoleSchemaService, roleSchema);
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);

			const m1 = missionStore.createMission({
				id: 'm-perf-1',
				title: 'Perf Canvas Mission',
				mermaidText: 'flowchart LR\n  N1["Plan"] --> N2["Build"]',
				projectUri: projUri.toString(),
			});
			const m2 = missionStore.createMission({
				id: 'm-perf-2',
				title: 'Second Mission',
				mermaidText: 'flowchart LR\n  A["Step A"]',
				projectUri: projUri.toString(),
			});

			const host = document.createElement('div');
			host.style.width = '1100px';
			host.style.height = '700px';
			document.body.appendChild(host);
			store.add({ dispose: () => host.remove() });

			const pane = store.add(h.instantiation.createInstance(
				AdeEngineeringEditorPane,
				upcastPartial<IEditorGroup>({}),
			));
			pane.create(host);
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, m1.id));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			const n1Before = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			const n2Before = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			assert.ok(n1Before && n2Before, 'Initial canvas renders N1 and N2');

			// 1. Transition idle -> running -> paused -> running: ZERO DOM teardown!
			const started = await missionRuntime.start(m1.id);
			assert.strictEqual(started.ok, true);
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="N1"]'), n1Before, 'Start (idle->running) must NOT rebuild DOM');
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="N2"]'), n2Before, 'Start (idle->running) preserves N2 DOM node');
			assert.strictEqual(n1Before.querySelector<HTMLButtonElement>('.ade-mission-engine-pill')?.disabled, true, 'Engine pill locks in place when live');

			await missionRuntime.pause(m1.id);
			await missionRuntime.resume(m1.id);
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="N1"]'), n1Before, 'Pause/Resume must NOT rebuild DOM');

			// 2. First telemetry model arrival updates LLM icon + model label IN PLACE with zero DOM teardown!
			missionRuntime.recordNodeTurnUsage(m1.id, 'N1', {
				inputTokens: 12_000,
				outputTokens: 3_000,
				totalTokens: 15_000,
				costUsd: 0.42,
				model: 'gpt-5.3-codex',
			});
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="N1"]'), n1Before, 'First telemetry model arrival must NOT rebuild DOM');
			assert.strictEqual(n1Before.querySelector('.ade-mission-model-name')?.textContent, 'gpt-5.3-codex');
			assert.strictEqual(n1Before.querySelector('.ade-mission-core-model-row')?.getAttribute('data-node-model'), 'gpt-5.3-codex');

			// 3. Unrelated sidebar chat session mutations leave active Mission canvas DOM completely untouched!
			h.projects.addSession(
				projUri,
				{ engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/unrelated-chat-99') },
				'Unrelated Sidebar Chat',
				{ role: 'employee' },
			);
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="N1"]'), n1Before, 'Unrelated sidebar agent change must NOT rebuild canvas');

			// 4. AdeMissionStoreService incremental cache + compaction + external write dirty preservation (Bug #5)
			const hugeSummary = 'X'.repeat(4000);
			const rtM2 = missionRuntime.getRuntimeState(m2.id);
			const tokId = 'tok-huge';
			const compactedRt = {
				...rtM2,
				tokens: {
					[tokId]: {
						id: tokId,
						missionId: m2.id,
						waveId: 'wave-1',
						nodeId: 'A',
						status: 'active' as const,
						arrivedAt: Date.now(),
						lastActivityAt: Date.now(),
						nudgeCount: 0,
						lastSummary: hugeSummary,
						compressedHistory: '',
						tracePtr: 'tr-1',
					},
				},
			};
			const storageService = h.instantiation.get(IStorageService);
			// Mark m2 dirty via deferred persist (does not flush immediately to storageService yet)
			missionStore.updateRuntime(m2.id, compactedRt, { deferPersist: true });
			// Simulate another window updating ONLY m1 in per-Mission v2 storage + hot index BEFORE m2's deferred timer flushes!
			const m1Key = `${ADE_MISSION_RECORD_STORAGE_PREFIX}${m1.id}`;
			const m1Prev = JSON.parse(storageService.get(m1Key, StorageScope.APPLICATION) ?? '{}') as { id: string; title: string; updatedAt: number };
			const nextM1UpdatedAt = Date.now() + 5000;
			storageService.store(m1Key, JSON.stringify({ ...m1Prev, title: 'Updated By Window 2', updatedAt: nextM1UpdatedAt }), StorageScope.APPLICATION, StorageTarget.USER);
			const idxPrev = JSON.parse(storageService.get(ADE_MISSIONS_INDEX_STORAGE_KEY, StorageScope.APPLICATION) ?? '{"version":2,"entries":[]}') as {
				version: 2;
				entries: Array<{ id: string; title: string; updatedAt: number }>;
			};
			storageService.store(ADE_MISSIONS_INDEX_STORAGE_KEY, JSON.stringify({
				version: 2,
				writerId: 'external-win-2',
				coldBackend: 'storage',
				updatedIds: [m1.id],
				entries: idxPrev.entries.map(e => e.id === m1.id ? { ...e, title: 'Updated By Window 2', updatedAt: nextM1UpdatedAt } : e),
			}), StorageScope.APPLICATION, StorageTarget.USER);

			// External update to m1 is loaded, AND m2's locally buffered dirty runtime MUST survive!
			assert.strictEqual(missionStore.getMission(m1.id)?.title, 'Updated By Window 2', 'External update to untouched Mission m1 is applied');
			assert.ok(missionStore.getMission(m2.id)?.runtime?.tokens[tokId], 'Locally dirty buffered update to m2 must NOT be clobbered by external write');

			// Flush deferred persist and confirm huge lastSummary is capped in m2's isolated cold storage payload
			await new Promise(resolve => setTimeout(resolve, 320));
			const savedM2 = JSON.parse(storageService.get(`${ADE_MISSION_RECORD_STORAGE_PREFIX}${m2.id}`, StorageScope.APPLICATION) ?? '{}') as {
				id?: string;
				runtime?: { tokens?: Record<string, { lastSummary?: string }> };
			};
			assert.ok(savedM2.runtime?.tokens?.[tokId]?.lastSummary, 'm2 flushed to isolated cold storage');
			assert.ok((savedM2.runtime!.tokens![tokId].lastSummary!.length) <= 2005, 'Oversized lastSummary is capped during compaction');
		});

		test('Visual DAG authoring, supervisor parent hierarchy & guided retry, Reviewer & checks CRUD + Triggers standby, failed/blocked wave card telemetry, and Inbox Open Node deep-jump focus', async () => {
			const projUri = URI.file('/tmp/mission-ux-all4');
			const h = createHarness([projUri]);
			h.modes.setMode('ade');
			const dispatchedTurns: Array<{ readonly args: readonly unknown[] }> = [];
			const openedAgentCalls: Array<{ readonly agentId: string; readonly side?: boolean }> = [];
			const openedMissionCalls: Array<{ readonly id: string; readonly options?: unknown }> = [];

			h.instantiation.stub(IAdeEngineeringBackendService, upcastPartial<IAdeEngineeringBackendService>({
				loadInbox: async () => [],
				saveInbox: async () => undefined,
				syncMissionWatchdog: async () => undefined,
				removeMissionWatchdog: async () => undefined,
			}));
			h.instantiation.stub(IAdeSessionsService, upcastPartial<IAdeSessionsService>({
				onDidChangeEngines: Event.None,
				getIcon: () => undefined,
				getEngineName: id => id === 'aexus-claude' ? 'Claude Code' : id,
				getEngines: async () => [{ id: 'aexus-claude', name: 'Claude Code', description: '' }],
				create: async (engineId, projectUri) => ({ engineId, resource: URI.parse(`${engineId}:/sess-ux4-${Date.now()}`), projectUri, label: 'UX4' }),
				list: async () => [],
				rename: async () => undefined,
				delete: async () => undefined,
				stop: async () => undefined,
			}));
			h.instantiation.stub(ICommandService, upcastPartial<ICommandService>({
				executeCommand: (async (id: string, ...args: unknown[]) => {
					if (id === 'aexus.agentEngines.dispatchEngineeringTurn') {
						dispatchedTurns.push({ args });
					}
					return { reply: 'ok', stopped: false };
				}) as ICommandService['executeCommand'],
			}));
			h.instantiation.stub(IAdeEditorService, upcastPartial<IAdeEditorService>({
				openAgent: async (agentId, opts) => {
					openedAgentCalls.push({ agentId, side: opts?.side });
				},
				closeAgents: async () => undefined,
			}));

			const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
			h.instantiation.stub(IAdeRoleSchemaService, roleSchema);
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);

			// Add an L1 TechLead supervisor outside the graph (governor = L1 in default 3-tier org)
			const supLead = h.projects.addSession(
				projUri,
				{ engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/sup-lead-1') },
				'TechLead',
				{ role: 'governor' },
			);

			// Start with a BLANK Mission (empty Mermaid) to test clean empty onboarding & visual authoring
			const mission = missionStore.createMission({
				id: 'm-ux-all4',
				title: 'UX Complete Mission',
				mermaidText: '',
				projectUri: projUri.toString(),
			});

			const host = document.createElement('div');
			host.className = 'monaco-workbench';
			host.style.width = '1200px';
			host.style.height = '760px';
			document.body.appendChild(host);
			store.add({ dispose: () => host.remove() });

			const pane = store.add(h.instantiation.createInstance(
				AdeEngineeringEditorPane,
				upcastPartial<IEditorGroup>({}),
			));
			pane.create(host);
			pane.layout(new Dimension(1200, 760));
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, mission.id));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			// ── (1) Clean empty-canvas onboarding (zero templates/sandbox/doctor/prompt-to-dag clutter) + self-healing boundary ──
			const onboarding = host.querySelector<HTMLElement>('[data-ade-mission-empty-onboarding]');
			assert.ok(onboarding && !onboarding.hidden, 'Empty canvas shows minimalist authoring onboarding');
			assert.strictEqual(host.querySelector('[data-ade-template-card]'), null, 'Removed templates gallery is absent');
			assert.strictEqual(host.querySelector('[data-ade-empty-sandbox-demo]'), null, 'Removed sandbox CTA is absent');
			assert.strictEqual(host.querySelector('[data-ade-empty-doctor]'), null, 'Removed doctor CTA is absent');
			assert.strictEqual(host.querySelector('[data-ade-empty-prompt-input]'), null, 'Removed prompt-to-DAG form is absent');

			const researchMermaid = [
				'flowchart LR',
				'  R1["@PI: 文献调研与实验方案"] -->|spec| R2["@TrainA: 主实验 GPU 训练"]',
				'  R1 -->|spec| R3["@TrainB: 消融对比基线"]',
				'  R1 -->|spec| R4["@Bench: 基准评测与指标审稿"]',
				'  R2 -->|fail| F1["@Ops: 显存诊断与降参恢复"]',
				'  R2 --> U1{{"方法学人工审核 Gate"}}',
				'  R3 --> U1',
				'  R4 --> U1',
				'  F1 --> U1',
				'  U1 --> R5["@PI: 论文结论与实验报告"]',
				'  %% check R4 [name=metrics-json, expect_file=research/benchmarks/metrics.json, on_fail=bounce, max_retries=2]',
			].join('\n');
			missionStore.updateMermaid(mission.id, researchMermaid);
			missionStore.updateNodePrompts(mission.id, { R1: 'Write detailed research spec in research/spec.md' });
			await missionRuntime.bindNodeHost(mission.id, 'R4', { roleKind: 'reviewer' });
			await timeout(20);
			assert.strictEqual(onboarding.hidden, true, 'Onboarding hides after graph is populated');
			assert.ok(host.querySelector('.ade-mission-node[data-node-id="R1"]'), 'Renders R1');
			assert.ok(host.querySelector('.ade-mission-node[data-node-id="R4"]'), 'Renders R4');
			assert.ok(host.querySelector('.ade-mission-node[data-node-id="U1"]'), 'Renders Gate U1');
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="R4"]')?.getAttribute('data-node-role-kind'), 'reviewer', 'R4 marked as Reviewer');
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="R4"] .ade-mission-checks-pill')?.getAttribute('data-node-checks-count'), '1', 'Check directive shows ✓ 1 badge on R4');

			// Verify ensureSynchronizedState self-heals stale supervisor managedNodeIds when Mermaid nodes are deleted/replaced
			const bindAll7 = await missionRuntime.setBoundary(mission.id, {
				offGraphMaxTier: 1,
				supervisors: [{ id: supLead.id, tier: 1, managedNodeIds: ['R1', 'R2', 'R3', 'R4', 'F1', 'U1', 'R5'] }],
			});
			assert.strictEqual(bindAll7.ok, true, `bindAll7 failed: ${bindAll7.error}`);
			missionStore.updateMermaid(mission.id, 'flowchart LR\n  N1["Fresh A"] --> N2["Fresh B"]');
			const healedBoundary = missionRuntime.getBoundary(mission.id);
			assert.strictEqual(healedBoundary.validation.valid, true, 'Removing old DAG nodes must self-heal stale supervisor managedNodeIds without ghost unknown-node errors');
			assert.deepStrictEqual(healedBoundary.boundary.supervisors.find(s => s.id === supLead.id)?.managedNodeIds, [], 'Stale deleted node IDs are pruned from supervisor managedNodeIds');
			const explicitBadRes = await missionRuntime.setBoundary(mission.id, {
				supervisors: [{ id: supLead.id, tier: 1, managedNodeIds: ['NON_EXISTENT_NODE'] }],
			});
			assert.strictEqual(explicitBadRes.ok, false, 'Explicit setBoundary with unknown DAG node still rejects cleanly');

			// Restore research DAG so downstream assertions continue exercising R1..R5/F1/U1
			missionStore.updateMermaid(mission.id, researchMermaid);
			await missionRuntime.bindNodeHost(mission.id, 'R4', { roleKind: 'reviewer' });
			await timeout(20);
			assert.ok(host.querySelector('.ade-mission-node[data-node-id="R1"]'), 'Restored research DAG cleanly after self-heal test');

			// Canvas right-click -> Add Task Node here
			const viewport = host.querySelector<HTMLElement>('.ade-mission-viewport')!;
			const vpRect = viewport.getBoundingClientRect();
			viewport.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: vpRect.left + 880, clientY: vpRect.top + 320 }));
			assert.ok(host.querySelector('[data-ade-canvas-context-menu="true"]'), 'Right-clicking blank canvas opens context menu');
			host.querySelector<HTMLButtonElement>('[data-ade-ctx-action="add-task"]')!.click();
			assert.ok(host.querySelector('.ade-mission-node[data-node-id="N1"]'), 'Context menu adds new node N1');

			// Double-click node title -> inline rename (preserving card double-click for chat!)
			const n1TitleEl = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"] .ade-mission-node-title')!;
			n1TitleEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
			const renameInput = host.querySelector<HTMLInputElement>('[data-ade-inline-rename="N1"]');
			assert.ok(renameInput, 'Double-clicking node title opens inline rename input');
			renameInput!.value = 'Post-Hoc Eval';
			renameInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="N1"] .ade-mission-node-title')?.textContent, 'Post-Hoc Eval', 'Inline rename persists to Mermaid & DOM');

			// Card double-click (outside title) still opens full Agent chat
			const callsBeforeCardDbl = openedAgentCalls.length;
			host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="R1"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
			assert.strictEqual(openedAgentCalls.length, callsBeforeCardDbl + 1, 'Card double-click still opens bound Agent chat');

			// Drag output port from R5 to N1 -> connects directed edge R5 -> N1
			pane.fitGraphToViewport();
			const r5OutPort = host.querySelector<HTMLButtonElement>('[data-ade-connect-port="R5"]')!;
			const n1Rect = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!.getBoundingClientRect();
			const r5PortRect = r5OutPort.getBoundingClientRect();
			r5OutPort.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: r5PortRect.left + 4, clientY: r5PortRect.top + 4 }));
			mainWindow.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: n1Rect.left + n1Rect.width / 2, clientY: n1Rect.top + n1Rect.height / 2 }));
			mainWindow.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: n1Rect.left + n1Rect.width / 2, clientY: n1Rect.top + n1Rect.height / 2 }));
			assert.ok(host.querySelector('.ade-mission-edge-group[data-from="R5"][data-to="N1"]'), 'Dragging output port onto target node creates directed edge R5 -> N1');

			// ── (2) Off-graph parentSupervisorId hierarchy UI + Hold-Tab X-Ray golden beam ──
			const setSupRes = await missionRuntime.setBoundary(mission.id, {
				offGraphMaxTier: 1,
				supervisors: [
					{ id: supLead.id, tier: 1, managedNodeIds: ['R2'], parentSupervisorId: ADE_SECRETARY_ID },
					{ id: ADE_SECRETARY_ID, tier: 0, managedNodeIds: [] },
				],
			});
			assert.strictEqual(setSupRes.ok, true, `setBoundary failed: ${setSupRes.error}`);
			await timeout(20);

			const updatedBoundary = missionRuntime.getBoundary(mission.id);
			assert.strictEqual(updatedBoundary.validation.valid, true, 'Boundary remains valid after setting parentSupervisorId');
			assert.strictEqual(updatedBoundary.boundary.supervisors.find(s => s.id === supLead.id)?.parentSupervisorId, ADE_SECRETARY_ID);

			const supLegendChip = host.querySelector<HTMLElement>(`[data-ade-sup-legend-id="${supLead.id}"]`);
			assert.ok(supLegendChip, 'Supervisor legend displays bound supervisor');
			assert.strictEqual(supLegendChip!.getAttribute('data-ade-sup-parent-id'), ADE_SECRETARY_ID, 'Supervisor legend surfaces parentSupervisorId');
			assert.ok(supLegendChip!.textContent?.includes('Secretary'), 'Supervisor legend chip shows ↑ Secretary hierarchy');

			// Hold Tab X-Ray renders golden parent beam between TechLead and Secretary
			host.querySelector<HTMLElement>('.ade-mission-editor')!.focus();
			mainWindow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
			assert.ok(host.querySelector(`[data-supervisor-parent-beam="${supLead.id}->${ADE_SECRETARY_ID}"]`), 'Hold-Tab X-Ray renders golden hierarchy beam to parentSupervisorId');
			mainWindow.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));

			// ── (3) Reviewer role toggle, Deterministic Check Hooks CRUD & Triggers Standby UI ──
			// Select R1 -> Inspector overview -> toggle Reviewer role
			const r1El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="R1"]')!;
			r1El.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
			r1El.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
			const roleToggleBtn = host.querySelector<HTMLButtonElement>('[data-ade-inspector-role-btn="R1"]');
			assert.ok(roleToggleBtn, 'Inspector overview exposes Worker/Reviewer role toggle');
			roleToggleBtn!.click();
			await timeout(20);
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="R1"]')?.getAttribute('data-node-role-kind'), 'reviewer', 'Toggling Reviewer updates node card badge in place');

			// Switch to Inspector Distill/Checks tab -> Add + Delete deterministic check hook
			host.querySelector<HTMLButtonElement>('[data-ade-inspector-tab="distill"]')!.click();
			const chkName = host.querySelector<HTMLInputElement>('[data-ade-check-name-input="true"]')!;
			const chkCmd = host.querySelector<HTMLInputElement>('[data-ade-check-cmd-input="true"]')!;
			chkName.value = 'spec-lint';
			chkCmd.value = 'pnpm lint';
			host.querySelector<HTMLButtonElement>('[data-ade-check-submit="R1"]')!.click();
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="R1"] .ade-mission-checks-pill')?.getAttribute('data-node-checks-count'), '1', 'Adding check hook updates R1 ✓ 1 card badge');
			const delChkBtn = host.querySelector<HTMLButtonElement>('[data-ade-check-delete]')!;
			assert.ok(delChkBtn, 'Added check hook renders delete button');
			delChkBtn.click();
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="R1"] .ade-mission-checks-pill')?.getAttribute('data-node-checks-count'), '0', 'Deleting check hook clears R1 check badge');

			// Source Triggers Studio opened from entry node R1 pacemaker port: verify Standby -> Paused -> Armed states
			host.querySelector<HTMLButtonElement>('[data-ade-pacemaker-port="R1"]')!.click();
			host.querySelector<HTMLInputElement>('[data-ade-trigger-autostart="true"]')!.checked = true;
			const trigSubmit = host.querySelector<HTMLButtonElement>('[data-ade-trigger-submit="true"]')!;
			trigSubmit.click();
			await timeout(20);
			assert.strictEqual(host.querySelector('[data-ade-trigger-status]')?.getAttribute('data-trigger-state'), 'standby', 'Trigger shows standby status while Mission is idle');
			host.querySelector<HTMLButtonElement>('[data-ade-trigger-toggle]')!.click();
			await timeout(20);
			assert.strictEqual(host.querySelector('[data-ade-trigger-status]')?.getAttribute('data-trigger-state'), 'paused', 'Pausing trigger updates status chip to paused');
			host.querySelector<HTMLButtonElement>('[data-ade-trigger-toggle]')!.click();
			await timeout(20);
			mainWindow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

			// ── (4) Failed & Blocked Wave Card Telemetry + Guided Retry + Active Recall + Inbox Deep-Jump Focus ──
			const startRes = await missionRuntime.start(mission.id);
			assert.strictEqual(startRes.ok, true);
			assert.strictEqual(host.querySelector('[data-ade-pacemaker-port="R1"]')?.getAttribute('data-pacemaker-armed'), 'true', 'Entry node pacemaker switches to armed when Mission runs');

			// Complete R1 to spawn parallel active tokens on R2, R3, R4
			const r1Tok = Object.values(missionRuntime.getRuntimeState(mission.id).tokens).find(t => t.nodeId === 'R1' && t.status === 'active')!;
			await missionRuntime.completeToken(mission.id, { tokenId: r1Tok.id, summary: 'Spec ready', skipChecks: true });
			const rtRunning = missionRuntime.getRuntimeState(mission.id);
			const r2Tok = Object.values(rtRunning.tokens).find(t => t.nodeId === 'R2' && t.status === 'active')!;
			const r3Tok = Object.values(rtRunning.tokens).find(t => t.nodeId === 'R3' && t.status === 'active')!;

			// Active node R2 exposes Recall button directly on card
			const r2RecallBtn = host.querySelector<HTMLButtonElement>('[data-ade-node-recall="R2"]')!;
			assert.strictEqual(r2RecallBtn.hidden, false, 'Active node shows Recall button directly on card');

			// Block R3 with PID -> blocked strip shows wave tag + countdown + PID
			await missionRuntime.blockToken(mission.id, {
				tokenId: r3Tok.id,
				reason: 'Training epoch 3/10',
				maxDuration: '30m',
				watchPid: 42424,
			});
			const blockedStrip = host.querySelector<HTMLElement>('[data-ade-blocked-strip="R3"]')!;
			assert.strictEqual(blockedStrip.hidden, false, 'Blocked strip visible on R3');
			assert.strictEqual(host.querySelector('[data-ade-blocked-wave="R3"]')?.textContent, 'W1', 'Blocked strip displays wave_id (W1)');
			assert.ok(host.querySelector('[data-ade-blocked-pid="R3"]')?.textContent?.includes('42424'), 'Blocked strip displays watched PID');

			// Fail R2 (after removing fail edge or direct fail without fallback -> let's fail F1 or verify R2 failure):
			// Note: R2 has fail edge to F1, so fail F1 to make F1 frozen_failed (or fail R3/F1):
			await missionRuntime.failToken(mission.id, { tokenId: r2Tok.id, reason: 'CUDA OOM on rank 0' });
			const f1Tok = Object.values(missionRuntime.getRuntimeState(mission.id).tokens).find(t => t.nodeId === 'F1' && t.status === 'active')!;
			await missionRuntime.failToken(mission.id, { tokenId: f1Tok.id, reason: 'CUDA OOM even at batch_size=16' });

			const f1FailStrip = host.querySelector<HTMLElement>('[data-ade-failed-strip="F1"]')!;
			assert.strictEqual(f1FailStrip.hidden, false, 'Failed node F1 renders explicit failure telemetry strip on card');
			assert.ok(host.querySelector('[data-ade-failed-wave="F1"]')?.textContent?.includes('W1'), 'Failed strip displays wave_id');
			assert.ok(host.querySelector('[data-ade-failed-reason="F1"]')?.textContent?.includes('CUDA OOM'), 'Failed strip displays failure reason');

			// Guided Retry on F1 opens popover & submits guidance
			const guidedBtn = host.querySelector<HTMLButtonElement>('[data-ade-node-retry-guided="F1"]')!;
			assert.strictEqual(guidedBtn.hidden, false, 'Failed node exposes Guided Retry button on card');
			guidedBtn.click();
			const guidedInput = host.querySelector<HTMLTextAreaElement>('[data-ade-guided-retry-input="true"]')!;
			assert.ok(guidedInput, 'Guided Retry popover opens with guidance textarea');
			guidedInput.value = 'Switch to fp16 and batch_size=8';
			dispatchedTurns.length = 0;
			host.querySelector<HTMLButtonElement>(`[data-ade-guided-retry-submit="${f1Tok.id}"]`)!.click();
			await timeout(25);
			const f1ActiveRetryTok = Object.values(missionRuntime.getRuntimeState(mission.id).tokens).find(t => t.nodeId === 'F1' && t.status === 'active');
			assert.ok(f1ActiveRetryTok, 'Guided Retry spawns a fresh active retry token on F1');
			assert.ok(
				dispatchedTurns.some(t => String(t.args[1] ?? '').includes('Switch to fp16 and batch_size=8')),
				'Guided Retry dispatches user guidance into the revived Agent prompt',
			);

			// Inbox "Open Node ↗" deep-jump focuses node, pulses spotlight, opens Inspector token tab, and opens employee chat beside canvas!
			const inboxSvc = store.add(h.instantiation.createInstance(AdeInboxService));
			await inboxSvc.postGovernorMessage({
				governorSessionId: mission.id,
				title: 'F1 GPU OOM Escalation',
				message: 'Needs immediate attention on node F1',
				nodeId: 'F1',
				severity: 'critical',
			});
			const inboxHost = document.createElement('div');
			document.body.appendChild(inboxHost);
			store.add({ dispose: () => inboxHost.remove() });
			const missionBridge: IAdeInboxMissionBridge = {
				openMissionEditor: async (id, opts) => {
					openedMissionCalls.push({ id, options: opts });
					if (opts?.focusNodeId) {
						pane.focusNode(opts.focusNodeId, {
							inspectorTab: opts.inspectorTab,
							openAgentBeside: opts.openAgentBeside,
						});
					}
				},
			};
			const inboxPanel = store.add(new AdeInboxPanel(
				inboxHost,
				inboxSvc,
				missionBridge,
				h.instantiation.get(IAdeEditorService),
				undefined,
				h.projects,
				undefined,
				roleSchema,
			));
			inboxPanel.render();

			openedAgentCalls.length = 0;
			const openNodeBtn = inboxHost.querySelector<HTMLButtonElement>('[data-ade-inbox-open-node]')!;
			assert.ok(openNodeBtn, 'Inbox escalation card renders Open Node ↗ button');
			openNodeBtn.click();
			await timeout(20);

			assert.strictEqual(openedMissionCalls.length, 1, 'Open Node ↗ calls openMissionEditor');
			assert.deepStrictEqual(openedMissionCalls[0], {
				id: mission.id,
				options: { focusNodeId: 'F1', inspectorTab: 'token', openAgentBeside: true },
			});
			const f1CardEl = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="F1"]')!;
			assert.strictEqual(f1CardEl.getAttribute('data-inbox-focused'), 'true', 'Deep-jump highlights & pulses target node F1');
			assert.ok(f1CardEl.classList.contains('is-selected'), 'Deep-jump selects target node F1');
			assert.ok(host.querySelector('[data-ade-inspector-tab="token"].active'), 'Deep-jump opens Mission Inspector directly on Token tab');
			assert.ok(openedAgentCalls.some(c => c.side === true), 'Deep-jump also opens bound employee chat beside the canvas');
		});

		test('allows dragging a Mission node card from ANY surface (buttons, pills, prompt bar, LLM tile, model row, engine/host pills) without misfiring popovers while keeping clean clicks intact', async () => {
			const h = createHarness([alpha]);
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);

			const created = missionStore.createMission({
				title: 'Universal Node Drag',
				mermaidText: 'flowchart LR\n  N1["@Arch: Design"] --> N2["@Dev: Build"]',
			});
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));
			const host = append(document.body, $('.monaco-workbench.ade-mission-universal-drag-test-host'));
			host.style.width = '1200px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1200, 760));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			const n1El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			const popoverEl = host.querySelector<HTMLElement>('[data-ade-mission-emp-popover="true"]')!;
			const inspectorEl = host.querySelector<HTMLElement>('[data-ade-mission-node-inspector="true"]')!;

			// Every inner interactive control on the node card must support drag-to-move (>= 5px)
			// AND suppress the trailing click so no popover opens on mouseup.
			const dragSurfaces: Array<{ readonly label: string; readonly selector: string }> = [
				{ label: 'Supervisor pill', selector: '[data-node-sup-btn="N1"]' },
				{ label: 'Employee pill', selector: '[data-node-emp-btn="N1"]' },
				{ label: 'LLM core icon tile', selector: '.ade-mission-core-icon-well' },
				{ label: 'Model & thinking row', selector: '.ade-mission-core-model-row' },
				{ label: 'Pre-prompt bar', selector: '[data-ade-node-prompt-btn="N1"]' },
				{ label: 'Agent Engine pill', selector: '.ade-mission-engine-pill' },
				{ label: 'Host & OS pill', selector: '.ade-mission-host-pill' },
				{ label: 'Source Pacemaker port', selector: '[data-ade-pacemaker-port="N1"]' },
			];

			for (let idx = 0; idx < dragSurfaces.length; idx++) {
				const { label, selector } = dragSurfaces[idx];
				const surface = n1El.querySelector<HTMLElement>(selector)!;
				assert.ok(surface, `${label} exists on N1 card`);
				const beforeLeft = Number.parseFloat(n1El.style.left);
				const beforeTop = Number.parseFloat(n1El.style.top);
				const startX = 120 + idx * 10;
				const startY = 120 + idx * 10;

				surface.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: idx + 1, clientX: startX, clientY: startY, bubbles: true }));
				assert.strictEqual(n1El.classList.contains('dragging'), false, `${label}: pointerdown alone does not enter dragging state before threshold`);
				mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointermove', { button: 0, pointerId: idx + 1, clientX: startX + 36, clientY: startY + 24, bubbles: true }));
				assert.strictEqual(n1El.classList.contains('dragging'), true, `${label}: moving past 5px threshold activates node drag`);
				mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: idx + 1, clientX: startX + 36, clientY: startY + 24, bubbles: true }));

				// Simulate browser's trailing click dispatched synchronously on the button after pointerup
				surface.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true, cancelable: true }));

				const afterLeft = Number.parseFloat(n1El.style.left);
				const afterTop = Number.parseFloat(n1El.style.top);
				assert.ok(afterLeft > beforeLeft && afterTop > beforeTop, `${label}: dragging moved N1 from (${beforeLeft},${beforeTop}) to (${afterLeft},${afterTop})`);
				assert.strictEqual(n1El.classList.contains('dragging'), false, `${label}: pointerup clears dragging class`);
				assert.strictEqual(popoverEl.hidden, true, `${label}: trailing click after drag must NOT open popover`);
				assert.strictEqual(inspectorEl.hidden, true, `${label}: drag must NOT open Node Inspector`);
			}

			// Wait one macrotask so the 0ms post-drag click suppression resets, then verify clean clicks still work!
			await timeout(5);
			const promptBtn = n1El.querySelector<HTMLButtonElement>('[data-ade-node-prompt-btn="N1"]')!;
			promptBtn.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 99, clientX: 200, clientY: 200, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 99, clientX: 201, clientY: 201, bubbles: true }));
			promptBtn.click();
			assert.strictEqual(popoverEl.hidden, false, 'Clean click (< 5px) on Pre-prompt bar still opens popover');
			assert.strictEqual(inspectorEl.hidden, true, 'Clean click on inner button must NOT also open Node Inspector');

			// Clean click (< 5px) on non-interactive node title selects the node & opens Node Inspector
			const titleEl = n1El.querySelector<HTMLElement>('.ade-mission-node-title')!;
			titleEl.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 100, clientX: 210, clientY: 210, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 100, clientX: 211, clientY: 211, bubbles: true }));
			assert.strictEqual(inspectorEl.hidden, false, 'Clean click on node title selects node and opens Mission Inspector');

			// Disabled inner buttons (e.g. locked engine pill while running) expose pointer-events: none so drags fall through
			const enginePill = n1El.querySelector<HTMLButtonElement>('.ade-mission-engine-pill')!;
			enginePill.disabled = true;
			assert.strictEqual(mainWindow.getComputedStyle(enginePill).pointerEvents, 'none', 'Disabled buttons inside node cards pass pointer events through for dragging');

			// Out-port drag still connects edges instead of moving the node
			const n2El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			const n2BeforeLeft = Number.parseFloat(n2El.style.left);
			const n2OutPort = n2El.querySelector<HTMLButtonElement>('[data-ade-connect-port="N2"]')!;
			n2OutPort.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 101, clientX: 400, clientY: 200, bubbles: true, cancelable: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointermove', { button: 0, pointerId: 101, clientX: 460, clientY: 230, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 101, clientX: 460, clientY: 230, bubbles: true }));
			assert.strictEqual(Number.parseFloat(n2El.style.left), n2BeforeLeft, 'Dragging from connectable out-port does not drag the node card');

			// Deleting a node clears its prompt & checks so a newly added node reusing the same ID starts clean
			missionStore.updateNodePrompt(created.id, 'R1', 'Stale prompt from deleted template node');
			missionStore.updateNodeChecks(created.id, 'R1', [{ id: 'stale-chk', name: 'stale', command: 'echo 1', onFail: 'bounce', maxAutoRetries: 1 }]);
			const viewportEl = host.querySelector<HTMLElement>('.ade-mission-viewport')!;
			const vpRect = viewportEl.getBoundingClientRect();
			viewportEl.dispatchEvent(new mainWindow.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: vpRect.left + 80, clientY: vpRect.top + 80 }));
			const addReviewerItem = host.querySelector<HTMLButtonElement>('[data-ade-ctx-action="add-reviewer"]')!;
			addReviewerItem.click();
			assert.strictEqual(missionStore.getMission(created.id)?.nodePrompts?.R1, undefined, 'Newly added Reviewer node R1 does not ghost-inherit stale prompt');
			assert.strictEqual(missionStore.getMission(created.id)?.nodeChecks?.R1, undefined, 'Newly added Reviewer node R1 does not ghost-inherit stale checks');

			// Write a prompt on R1, delete R1 via context menu, and verify prompt is removed immediately
			missionStore.updateNodePrompt(created.id, 'R1', '核对接口返回格式并补充测试');
			missionStore.updateNodeChecks(created.id, 'R1', [
				{ id: 'c1', name: 'unit', command: 'pnpm test', onFail: 'bounce', maxAutoRetries: 1 },
				{ id: 'c2', name: 'lint', command: 'pnpm lint', onFail: 'bounce', maxAutoRetries: 1 },
			]);
			const longSup = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/long-sup') }, 'Aexus Governor Role Initialization', { role: 'governor' });
			await missionRuntime.setBoundary(created.id, {
				offGraphMaxTier: 1,
				supervisors: [{ id: longSup.id, tier: 1, managedNodeIds: ['R1'] }],
			});
			await missionRuntime.bindNodeHost(created.id, 'R1', { roleKind: 'reviewer', hostAlias: 'ubuntu-gpu-a100-cluster-01' });
			const r1El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="R1"]')!;
			const r1Card = r1El.querySelector<HTMLElement>('.ade-mission-node-card')!;
			const cardRect = r1Card.getBoundingClientRect();
			assert.ok(cardRect.width > 200, 'R1 node card has concrete rendered geometry');
			const boundedSelectors = [
				'.ade-mission-node-top',
				'.ade-mission-node-id-wrap',
				'.ade-mission-top-pills',
				'[data-node-sup-btn="R1"]',
				'[data-node-emp-btn="R1"]',
				'.ade-mission-core-well',
				'.ade-mission-core-title-row',
				'.ade-mission-node-title',
				'[data-node-role-badge="R1"]',
				'.ade-mission-checks-pill',
				'[data-ade-node-prompt-btn="R1"]',
				'.ade-mission-ctx-row',
				'.ade-mission-node-footer',
				'.ade-mission-engine-pill',
				'.ade-mission-host-pill',
			];
			for (const sel of boundedSelectors) {
				const el = r1Card.querySelector<HTMLElement>(sel);
				assert.ok(el && !el.hidden, `Expected visible element ${sel} inside R1 card`);
				const rect = el.getBoundingClientRect();
				assert.ok(
					rect.left >= cardRect.left - 0.5 && rect.right <= cardRect.right + 0.5 && rect.top >= cardRect.top - 0.5 && rect.bottom <= cardRect.bottom + 0.5,
					`${sel} must stay strictly inside .ade-mission-node-card bounds (el=[${rect.left.toFixed(1)},${rect.top.toFixed(1)},${rect.right.toFixed(1)},${rect.bottom.toFixed(1)}], card=[${cardRect.left.toFixed(1)},${cardRect.top.toFixed(1)},${cardRect.right.toFixed(1)},${cardRect.bottom.toFixed(1)}])`,
				);
			}

			const r1PromptBtn = host.querySelector<HTMLButtonElement>('[data-ade-node-prompt-btn="R1"]')!;
			r1PromptBtn.click();
			const hintText = host.querySelector<HTMLElement>('.ade-mission-prompt-hint-text')?.textContent ?? '';
			assert.ok(!hintText.includes('令牌') && !hintText.includes('唤醒'), `Prompt popover hint should use plain human copy, got: ${hintText}`);
			r1El.dispatchEvent(new mainWindow.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 180, clientY: 180 }));
			host.querySelector<HTMLButtonElement>('[data-ade-ctx-action="delete-node"]')!.click();
			assert.strictEqual(missionStore.getMission(created.id)?.nodePrompts?.R1, undefined, 'Deleting node R1 clears its stored prompt');
		});

		test('Mission Inspector patches 1Hz streaming telemetry in place without destroying forms, dropping focus, wiping drafts, interrupting FinOps slider drag, or resetting scroll', async () => {
			const h = createHarness([alpha]);
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);

			const created = missionStore.createMission({
				title: 'Inspector Zero-Teardown Telemetry',
				mermaidText: 'flowchart LR\n  N1["@Arch: Plan"] --> N2["@Dev: Implement"]',
			});
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));
			const host = append(document.body, $('.monaco-workbench.ade-mission-inspector-live-test-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			// Start mission and fail N1 so Token tab shows the Guided Retry input while N2/runtime stream telemetry
			await missionRuntime.start(created.id);
			const n1Tok = Object.values(missionRuntime.getRuntimeState(created.id).tokens).find(t => t.nodeId === 'N1' && t.status === 'active')!;
			await missionRuntime.failToken(created.id, { tokenId: n1Tok.id, reason: 'Compile error on step 1' });

			// Select N1 to open 4-in-1 Inspector
			const n1El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			n1El.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, clientX: 40, clientY: 40, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, clientX: 40, clientY: 40, bubbles: true }));

			const inspector = host.querySelector<HTMLElement>('[data-ade-mission-node-inspector="true"]')!;
			const bodyScroll = inspector.querySelector<HTMLElement>('.ade-mission-ni-body')!;
			assert.strictEqual(inspector.hidden, false, 'Inspector opens on N1');

			// 1. Overview tab: telemetry line patches in place without rebuilding DOM
			const overviewSupBtnBefore = inspector.querySelector<HTMLButtonElement>('[data-ade-inspector-sup-btn="N1"]')!;
			missionRuntime.recordNodeTurnUsage(created.id, 'N1', {
				inputTokens: 12000,
				outputTokens: 3000,
				totalTokens: 15000,
				costUsd: 0.45,
			});
			assert.strictEqual(inspector.querySelector<HTMLButtonElement>('[data-ade-inspector-sup-btn="N1"]'), overviewSupBtnBefore, 'Overview tab DOM is preserved across telemetry tick');
			assert.strictEqual(inspector.querySelector<HTMLElement>('.ade-mission-ni-body'), bodyScroll, 'Persistent scroll container is never recreated');
			assert.ok(inspector.querySelector('.ade-mission-ni-telemetry-line')?.textContent?.includes('$0.45'), 'Overview telemetry line patches live cost in place');

			// 2. Token tab: typing into Guided Retry input must survive multiple 1Hz telemetry ticks with focus & scroll intact
			inspector.querySelector<HTMLButtonElement>('[data-ade-inspector-tab="token"]')!.click();
			const guidanceInput = inspector.querySelector<HTMLInputElement>('[data-ade-ni-retry-guidance="true"]')!;
			assert.strictEqual(guidanceInput.hidden, false, 'Guided retry input is visible for frozen_failed token');
			guidanceInput.focus();
			guidanceInput.value = 'Fix missing import in parser.ts';
			guidanceInput.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
			Object.defineProperty(bodyScroll, 'scrollHeight', { value: 900, configurable: true });
			bodyScroll.scrollTop = 95;

			for (let tick = 1; tick <= 3; tick++) {
				missionRuntime.recordNodeTurnUsage(created.id, 'N1', {
					inputTokens: 5000,
					outputTokens: 1000,
					totalTokens: 6000,
					costUsd: 0.20,
				});
			}
			assert.strictEqual(inspector.querySelector<HTMLInputElement>('[data-ade-ni-retry-guidance="true"]'), guidanceInput, 'Guided retry input DOM node is never recreated during 1Hz ticks');
			assert.strictEqual(document.activeElement, guidanceInput, 'Guided retry input retains focus across 1Hz telemetry ticks');
			assert.strictEqual(guidanceInput.value, 'Fix missing import in parser.ts', 'Guided retry draft text is never wiped');
			assert.strictEqual(inspector.querySelector<HTMLElement>('.ade-mission-ni-body'), bodyScroll, 'Body scroll container stays mounted on Token tab');

			// 3. Distill tab: typing Distill memo + Check Hook form survives 1Hz ticks while thermal % updates live
			inspector.querySelector<HTMLButtonElement>('[data-ade-inspector-tab="distill"]')!.click();
			const memoInput = inspector.querySelector<HTMLInputElement>('[data-ade-ni-distill-memo="true"]')!;
			const chkName = inspector.querySelector<HTMLInputElement>('[data-ade-check-name-input="true"]')!;
			const chkCmd = inspector.querySelector<HTMLInputElement>('[data-ade-check-cmd-input="true"]')!;
			const chkFiles = inspector.querySelector<HTMLInputElement>('[data-ade-check-files-input="true"]')!;
			const chkOnFail = inspector.querySelector<HTMLSelectElement>('[data-ade-check-onfail-select="true"]')!;
			memoInput.value = 'Keep schema contract only';
			memoInput.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
			chkName.value = 'unit-suite';
			chkName.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
			chkFiles.value = 'dist/bundle.js';
			chkFiles.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
			chkOnFail.value = 'escalate';
			chkOnFail.dispatchEvent(new mainWindow.Event('change', { bubbles: true }));
			chkCmd.focus();
			chkCmd.value = 'pnpm test --run';
			chkCmd.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));

			const pctBefore = inspector.querySelector('.ade-mission-ni-section-head .ade-mission-token-status-badge')?.textContent;
			missionRuntime.recordNodeTurnUsage(created.id, 'N1', {
				inputTokens: 60000,
				outputTokens: 20000,
				totalTokens: 80000,
				costUsd: 1.05,
				isNoiseTurn: true,
			});

			assert.strictEqual(inspector.querySelector<HTMLInputElement>('[data-ade-ni-distill-memo="true"]'), memoInput, 'Distill memo input is never recreated on 1Hz telemetry tick');
			assert.strictEqual(inspector.querySelector<HTMLInputElement>('[data-ade-check-cmd-input="true"]'), chkCmd, 'Check hook form input is never recreated on 1Hz telemetry tick');
			assert.strictEqual(document.activeElement, chkCmd, 'Check hook cmd input retains focus across 1Hz telemetry tick');
			assert.strictEqual(memoInput.value, 'Keep schema contract only', 'Distill memo draft is preserved');
			assert.strictEqual(chkName.value, 'unit-suite', 'Check hook name draft is preserved');
			assert.strictEqual(chkCmd.value, 'pnpm test --run', 'Check hook cmd draft is preserved');
			assert.strictEqual(chkFiles.value, 'dist/bundle.js', 'Check hook files draft is preserved');
			assert.strictEqual(chkOnFail.value, 'escalate', 'Check hook select value is preserved');
			const pctAfter = inspector.querySelector('.ade-mission-ni-section-head .ade-mission-token-status-badge')?.textContent;
			assert.notStrictEqual(pctAfter, pctBefore, `Thermal context % patches live in place (${pctBefore} -> ${pctAfter})`);

			// 4. FinOps tab: dragging budget slider & editing budget USD input survive 1Hz spend ticks while hero spend patches in place
			inspector.querySelector<HTMLButtonElement>('[data-ade-inspector-tab="finops"]')!.click();
			const slider = inspector.querySelector<HTMLInputElement>('[data-ade-finops-budget-slider="true"]')!;
			const budgetInput = inspector.querySelector<HTMLInputElement>('[data-ade-finops-budget-input="true"]')!;

			slider.focus();
			slider.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, bubbles: true }));
			slider.value = '25';
			slider.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
			assert.strictEqual(budgetInput.value, '25', 'Dragging slider mirrors value into USD input');

			// Fire 1Hz spend ticks MID-DRAG (cumulative: 0.45 + 0.60 + 1.05 = 2.10 -> +1.35 +0.80 = $4.25)
			missionRuntime.recordNodeTurnUsage(created.id, 'N1', {
				inputTokens: 20000,
				outputTokens: 5000,
				totalTokens: 25000,
				costUsd: 1.35,
			});
			missionRuntime.recordNodeTurnUsage(created.id, 'N2', {
				inputTokens: 20000,
				outputTokens: 8000,
				totalTokens: 28000,
				costUsd: 0.80,
			});

			assert.strictEqual(inspector.querySelector<HTMLInputElement>('[data-ade-finops-budget-slider="true"]'), slider, 'FinOps slider DOM node is never recreated during drag');
			assert.strictEqual(document.activeElement, slider, 'FinOps slider retains focus during live spend ticks');
			assert.strictEqual(slider.value, '25', 'In-progress slider drag value is NOT overwritten by 1Hz spend ticks');
			assert.strictEqual(budgetInput.value, '25', 'Mirrored USD value is NOT overwritten mid-drag');
			assert.strictEqual(inspector.querySelector('[data-ade-finops-hero-spend="true"]')?.textContent, '$4.25', 'Hero spend patches live to $4.25 in place while dragging slider');

			// Release drag & test direct number input editing under live telemetry
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, bubbles: true }));
			slider.dispatchEvent(new mainWindow.Event('change', { bubbles: true }));
			await timeout(20);
			assert.strictEqual(missionRuntime.getRuntimeState(created.id).budgetLimitUsd, 25, 'Releasing slider commits $25 budget limit');

			budgetInput.focus();
			budgetInput.value = '42';
			missionRuntime.recordNodeTurnUsage(created.id, 'N2', {
				inputTokens: 5000,
				outputTokens: 2000,
				totalTokens: 7000,
				costUsd: 0.25,
			});
			assert.strictEqual(document.activeElement, budgetInput, 'Focused USD input retains focus across live spend tick');
			assert.strictEqual(budgetInput.value, '42', 'Focused USD input draft is NOT overwritten by live spend tick');
			assert.strictEqual(inspector.querySelector('[data-ade-finops-hero-spend="true"]')?.textContent, '$4.50', 'Hero spend updates in place to $4.50 while editing USD input');
		});

		test('FinOps Ledger & budget breaker work on non-Claude engines via pricing catalog, show estimated (~$) indicators, and honor custom & local zero-cost settings overrides', async () => {
			const h = createHarness([alpha]);
			h.instantiation.stub(IConfigurationService, new TestConfigurationService({
				[ADE_MODEL_PRICING_OVERRIDES_CONFIG_KEY]: {
					'my-local-vllm/*': { local: true },
					'custom-coder-xl': { inputPerMillion: 10, outputPerMillion: 20 },
				},
			}));
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);

			const created = missionStore.createMission({
				title: 'Multi-Engine FinOps Breaker',
				mermaidText: 'flowchart LR\n  N1["@Codex: Build"] --> N2["@Local: Bench"]\n  N1 --> N3["@Custom: Audit"]',
			});
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));
			const host = append(document.body, $('.monaco-workbench.ade-mission-finops-multiengine-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			await missionRuntime.setBudgetLimit(created.id, 2.00);
			await missionRuntime.start(created.id);

			// 1. Local zero-cost override (`my-local-vllm/qwen3-32b`) reports huge tokens with $0.00 spend & Local $0 badge
			missionRuntime.recordNodeTurnUsage(created.id, 'N2', {
				inputTokens: 1_500_000,
				outputTokens: 300_000,
				model: 'my-local-vllm/qwen3-32b',
				engineId: 'aexus-opencode',
			});
			const n2CostEl = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"] .ade-mission-ctx-cost')!;
			assert.strictEqual(n2CostEl.hidden, false, 'Local zero-cost model surfaces Local $0 chip');
			assert.strictEqual(n2CostEl.getAttribute('data-node-cost-local'), 'true');
			assert.strictEqual(n2CostEl.textContent, 'Local $0');
			assert.strictEqual(missionRuntime.getRuntimeState(created.id).budgetCircuitTripped, false, 'Local zero-cost tokens never trip USD budget');

			// 2. Non-Claude Codex node (`gpt-5.3-codex`) omits costUsd -> auto-estimated ~$1.05 (200k in * 1.75 + 50k out * 14 = $1.05)
			missionRuntime.recordNodeTurnUsage(created.id, 'N1', {
				inputTokens: 200_000,
				outputTokens: 50_000,
				model: 'gpt-5.3-codex',
				engineId: 'aexus-codex',
			});
			const n1CostEl = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"] .ade-mission-ctx-cost')!;
			assert.strictEqual(n1CostEl.hidden, false, 'Codex node displays estimated USD badge');
			assert.strictEqual(n1CostEl.getAttribute('data-node-cost-estimated'), 'true');
			assert.strictEqual(n1CostEl.textContent, '~$1.05');

			// Open FinOps Ledger Inspector via clicking N1 + FinOps tab and verify estimated badge + ~$ hero spend
			const n1Card = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			n1Card.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, clientX: 60, clientY: 60, bubbles: true }));
			n1Card.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, clientX: 60, clientY: 60, bubbles: true }));
			const inspector = host.querySelector<HTMLElement>('[data-ade-mission-node-inspector="true"]')!;
			inspector.querySelector<HTMLButtonElement>('[data-ade-inspector-tab="finops"]')!.click();
			const estBadge = inspector.querySelector<HTMLElement>('[data-ade-finops-estimated-badge="true"]')!;
			assert.strictEqual(estBadge.hidden, false, 'FinOps hero displays estimated (预估) badge');
			assert.strictEqual(inspector.querySelector('[data-ade-finops-hero-spend="true"]')?.textContent, '~$1.05');

			// 3. Custom pricing override (`custom-coder-xl`: $10/M in, $20/M out -> 50k in $0.50 + 50k out $1.00 = $1.50)
			//    Pushes total to ~$2.55 >= $2.00 -> trips hard budget circuit-breaker!
			missionRuntime.recordNodeTurnUsage(created.id, 'N3', {
				inputTokens: 50_000,
				outputTokens: 50_000,
				model: 'custom-coder-xl',
				engineId: 'aexus-dsh',
			});
			const rtAfter = missionRuntime.getRuntimeState(created.id);
			assert.strictEqual(rtAfter.budgetCircuitTripped, true, 'Estimated non-Claude spend trips hard budget circuit-breaker');
			assert.strictEqual(rtAfter.status, 'paused', 'Mission pauses when estimated spend breaches ceiling');
			assert.strictEqual(inspector.querySelector('[data-ade-finops-hero-spend="true"]')?.textContent, '~$2.55');
			assert.strictEqual(inspector.querySelector<HTMLElement>('[data-ade-finops-tripped-banner="true"]')?.hidden, false, 'Breaker banner renders after non-Claude breach');
		});

		test('Canvas editing ergonomics: 50-step Undo/Redo, Marquee multi-select & batch drag, snap alignment guides, Delete/Backspace node & edge removal, Cmd/Ctrl+F node search, and double-click edge label rename', async () => {
			const h = createHarness([alpha]);
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);

			const created = missionStore.createMission({
				title: 'Canvas Ergonomics Suite',
				mermaidText: 'flowchart LR\n  N1["@Arch: Plan"] --> N2["@Dev: Implement"]\n  N2 --> N3["@QA: Verify"]',
			});
			// Place nodes at known deterministic world positions for marquee, batch drag, and snap-guide assertions
			missionStore.updateNodePositions(created.id, {
				N1: { x: 200, y: 200 },
				N2: { x: 560, y: 200 },
				N3: { x: 200, y: 460 },
			});
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));
			const host = append(document.body, $('.monaco-workbench.ade-mission-ergonomics-test-host'));
			host.style.width = '1280px';
			host.style.height = '800px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 800));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			const rootEl = host.querySelector<HTMLElement>('.ade-mission-editor')!;
			const viewportEl = host.querySelector<HTMLElement>('.ade-mission-viewport')!;
			const undoBtn = host.querySelector<HTMLButtonElement>('[data-ade-mission-undo="true"]')!;
			const redoBtn = host.querySelector<HTMLButtonElement>('[data-ade-mission-redo="true"]')!;
			rootEl.focus();
			assert.strictEqual(undoBtn.disabled, true, 'Undo starts disabled');
			assert.strictEqual(redoBtn.disabled, true, 'Redo starts disabled');

			// 1. Double-click edge on canvas to inline-edit edge label + Undo/Redo
			const edgeN1N2 = host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="N1"][data-to="N2"]')!;
			edgeN1N2.dispatchEvent(new mainWindow.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
			const edgeInput = host.querySelector<HTMLInputElement>('[data-ade-inline-edge-rename="N1->N2"]')!;
			assert.ok(edgeInput, 'Double-clicking edge opens inline edge label input');
			edgeInput.value = 'fail';
			edgeInput.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

			assert.strictEqual(
				host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="N1"][data-to="N2"]')?.getAttribute('data-edge-kind'),
				'fail',
				'Inline edge edit updates edge label & switches to fail polarity',
			);
			assert.strictEqual(undoBtn.disabled, false, 'Edge edit pushes snapshot onto Undo stack');

			// Cmd+Z undoes edge label edit; Cmd+Shift+Z redoes it
			rootEl.focus();
			mainWindow.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
			assert.strictEqual(
				host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="N1"][data-to="N2"]')?.getAttribute('data-edge-kind'),
				'success',
				'Cmd+Z restores previous edge label & polarity',
			);
			assert.strictEqual(redoBtn.disabled, false, 'Redo becomes enabled after Undo');
			mainWindow.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
			assert.strictEqual(
				host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="N1"][data-to="N2"]')?.getAttribute('data-edge-kind'),
				'fail',
				'Cmd+Shift+Z redoes edge label change',
			);

			// 2. Click edge to select -> press Delete to remove edge -> Cmd+Z restores edge
			const edgeToSelect = host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="N1"][data-to="N2"]')!;
			edgeToSelect.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true, cancelable: true }));
			assert.strictEqual(edgeToSelect.getAttribute('data-edge-selected'), 'true', 'Clicking edge marks it selected');
			mainWindow.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
			assert.strictEqual(host.querySelector('.ade-mission-edge-group[data-from="N1"][data-to="N2"]'), null, 'Delete key removes selected edge');
			mainWindow.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
			assert.ok(host.querySelector('.ade-mission-edge-group[data-from="N1"][data-to="N2"]'), 'Cmd+Z restores deleted edge');

			// 3. Marquee Box Selection (Shift+Drag) + Batch Drag Move + Single-Step Undo
			const n1Rect = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!.getBoundingClientRect();
			const n2Rect = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!.getBoundingClientRect();
			const boxStartX = Math.min(n1Rect.left, n2Rect.left) - 20;
			const boxStartY = Math.min(n1Rect.top, n2Rect.top) - 20;
			const boxEndX = Math.max(n1Rect.right, n2Rect.right) + 20;
			const boxEndY = Math.max(n1Rect.bottom, n2Rect.bottom) + 20;

			viewportEl.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, shiftKey: true, pointerId: 11, clientX: boxStartX, clientY: boxStartY, bubbles: true }));
			viewportEl.dispatchEvent(new mainWindow.PointerEvent('pointermove', { button: 0, shiftKey: true, pointerId: 11, clientX: boxEndX, clientY: boxEndY, bubbles: true }));
			assert.strictEqual(host.querySelector<HTMLElement>('[data-ade-marquee-box="true"]')?.hidden, false, 'Marquee box overlay renders during Shift+Drag');
			viewportEl.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, shiftKey: true, pointerId: 11, clientX: boxEndX, clientY: boxEndY, bubbles: true }));

			const n1El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			const n2El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			const n3El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N3"]')!;
			assert.strictEqual(n1El.getAttribute('data-node-selected'), 'true', 'Marquee selects N1');
			assert.strictEqual(n2El.getAttribute('data-node-selected'), 'true', 'Marquee selects N2');
			assert.strictEqual(n3El.getAttribute('data-node-selected'), null, 'Marquee excludes N3 outside box');
			assert.strictEqual(host.querySelector<HTMLElement>('[data-ade-selection-hud="true"]')?.hidden, false, 'Multi-select HUD pill appears for >=2 nodes');

			// Drag N1 while both N1 & N2 are selected -> BOTH translate together!
			const n1LeftBefore = Number.parseFloat(n1El.style.left);
			const n2LeftBefore = Number.parseFloat(n2El.style.left);
			const n3LeftBefore = Number.parseFloat(n3El.style.left);
			n1El.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 12, clientX: 200, clientY: 200, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointermove', { button: 0, pointerId: 12, clientX: 260, clientY: 245, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 12, clientX: 260, clientY: 245, bubbles: true }));
			const n1LeftAfter = Number.parseFloat(n1El.style.left);
			const n2LeftAfter = Number.parseFloat(n2El.style.left);
			assert.ok(n1LeftAfter > n1LeftBefore + 20, 'Batch drag moved N1');
			assert.strictEqual(n2LeftAfter - n2LeftBefore, n1LeftAfter - n1LeftBefore, 'Batch drag translated N2 in exact lockstep with N1');
			assert.strictEqual(Number.parseFloat(n3El.style.left), n3LeftBefore, 'Unselected N3 stays stationary');

			// Single Cmd+Z undoes batch drag for BOTH nodes
			mainWindow.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
			assert.strictEqual(Number.parseFloat(host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!.style.left), n1LeftBefore, 'Cmd+Z restores N1 position');
			assert.strictEqual(Number.parseFloat(host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!.style.left), n2LeftBefore, 'Cmd+Z restores N2 position in same step');

			// 4. Drag Alignment Snap Guides: drag N3 slightly off N1's X (within 8px) -> snaps & renders guide line, clears on pointerup
			const n3Live = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N3"]')!;
			const n1CurX = Number.parseFloat(host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!.style.left);
			n3Live.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 13, clientX: 300, clientY: 300, bubbles: true }));
			// Move 3px horizontally and 24px vertically -> crosses 5px drag threshold while staying within 8px of N1's X!
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointermove', { button: 0, pointerId: 13, clientX: 303, clientY: 324, bubbles: true }));
			assert.strictEqual(Number.parseFloat(n3Live.style.left), n1CurX, 'Smart alignment snaps N3 X exactly onto N1 X');
			assert.ok(host.querySelector('[data-ade-align-guide="x"]'), 'Vertical alignment reference guide line renders during snapped drag');
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 13, clientX: 303, clientY: 324, bubbles: true }));
			assert.strictEqual(host.querySelector('[data-ade-align-guide="x"]'), null, 'Alignment guide lines clear immediately on pointerup');

			// 5. Cmd/Ctrl+F Large-DAG Node Search & Jump Locator
			rootEl.focus();
			mainWindow.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }));
			const searchBar = host.querySelector<HTMLElement>('[data-ade-canvas-search="true"]')!;
			const searchInput = host.querySelector<HTMLInputElement>('[data-ade-canvas-search-input="true"]')!;
			const searchCount = host.querySelector<HTMLElement>('[data-ade-canvas-search-count="true"]')!;
			assert.strictEqual(searchBar.hidden, false, 'Cmd+F opens floating node search bar');
			assert.strictEqual(document.activeElement, searchInput, 'Cmd+F focuses search input');

			searchInput.value = 'N';
			searchInput.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
			assert.strictEqual(searchCount.textContent, '1 / 3', 'Search matches all 3 nodes (N1, N2, N3)');
			assert.strictEqual(host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')?.getAttribute('data-search-active'), 'true');

			searchInput.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			assert.strictEqual(searchCount.textContent, '2 / 3', 'Enter cycles to next matching node');
			assert.strictEqual(host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')?.getAttribute('data-search-active'), 'true');

			// Typing Delete/Backspace inside search input MUST NOT delete canvas nodes!
			searchInput.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
			assert.strictEqual(host.querySelectorAll('.ade-mission-node').length, 3, 'Backspace inside search input never deletes canvas nodes');

			searchInput.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
			assert.strictEqual(searchBar.hidden, true, 'Escape closes search bar');
			assert.strictEqual(host.querySelector('[data-search-active="true"]'), null, 'Closing search clears search highlights');

			// 6. Batch Backspace deletion of multi-selected nodes + single-step Undo restore
			const n2ForDel = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			const n3ForDel = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N3"]')!;
			n2ForDel.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 20, clientX: 50, clientY: 50, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 20, clientX: 50, clientY: 50, bubbles: true }));
			n3ForDel.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, shiftKey: true, pointerId: 21, clientX: 50, clientY: 50, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, shiftKey: true, pointerId: 21, clientX: 50, clientY: 50, bubbles: true }));
			assert.strictEqual(host.querySelectorAll('.ade-mission-node[data-node-selected="true"]').length, 2, 'Shift+Click multi-selects N2 and N3');

			rootEl.focus();
			mainWindow.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
			assert.strictEqual(host.querySelectorAll('.ade-mission-node').length, 1, 'Backspace removes both multi-selected nodes atomically');
			assert.ok(host.querySelector('.ade-mission-node[data-node-id="N1"]'));

			mainWindow.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
			assert.strictEqual(host.querySelectorAll('.ade-mission-node').length, 3, 'Cmd+Z restores both batch-deleted nodes in one step');
		});

		test('Minimalist top bar keeps ONLY File Drawer & Start controls, HUD safe zones prevent overlap, wide screens allow dual drawers, opening Inspector auto-pans occluded nodes, and canvas drag-pan preserves Inspector', async () => {
			const h = createHarness([alpha]);
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);

			const created = missionStore.createMission({
				title: 'Minimalist Top Bar & HUD Safe Zones',
				mermaidText: 'flowchart LR\n  N1["@Arch: Plan"] --> N2["@Dev: Implement"]',
			});
			// Put N2 near the right edge so opening the 352px right Inspector initially overlaps it
			missionStore.updateNodePositions(created.id, {
				N1: { x: 220, y: 240 },
				N2: { x: 1060, y: 240 },
			});
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));
			const host = append(document.body, $('.monaco-workbench.ade-mission-hud-safezone-test-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			const topBarSlot = host.querySelector<HTMLElement>('[data-ade-mission-top-bar-slot="true"]')!;
			const topBar = host.querySelector<HTMLElement>('[data-ade-mission-top-bar="true"]')!;
			const fileBtn = host.querySelector<HTMLButtonElement>('[data-ade-mission-file-btn="true"]')!;
			const runBar = host.querySelector<HTMLElement>('[data-ade-mission-run-bar="true"]')!;
			const fileDrawer = host.querySelector<HTMLElement>('[data-ade-mission-drawer="true"]')!;
			const inspector = host.querySelector<HTMLElement>('[data-ade-mission-node-inspector="true"]')!;
			const viewportEl = host.querySelector<HTMLElement>('.ade-mission-viewport')!;
			const rootEl = host.querySelector<HTMLElement>('.ade-mission-editor')!;

			// 1. Minimalist top bar contains ONLY the two top-left controls (File Drawer toggle + Run Control pill)
			assert.strictEqual(topBar.children.length, 2, 'Top bar renders ONLY 2 top-left controls');
			assert.strictEqual(topBar.children[0], fileBtn);
			assert.strictEqual(topBar.children[1], runBar);
			for (const removedSel of [
				'[data-ade-mission-governance-btn]',
				'[data-ade-mission-triggers-btn]',
				'[data-ade-mission-add-node-btn]',
				'[data-ade-mission-ai-dag-btn]',
				'[data-ade-mission-templates-btn]',
				'[data-ade-mission-doctor-btn]',
				'[data-ade-mission-finops-btn]',
				'[data-ade-mission-topbar-more]',
				'[data-ade-prompt-to-dag-bar]',
				'[data-ade-mission-doctor-backdrop]',
				'[data-ade-mission-sandbox-banner]',
			]) {
				assert.strictEqual(host.querySelector(removedSel), null, `Removed UI ${removedSel} must not exist`);
			}
			assert.ok(topBar.scrollWidth <= topBarSlot.clientWidth + 1, `Top bar does not overflow wide container (${topBar.scrollWidth} <= ${topBarSlot.clientWidth})`);

			// 2. Auto-pan avoidance: place N2 into right-side Inspector zone (reset zoom to 100% and pan=0 via click on N2)
			host.querySelector<HTMLButtonElement>('[data-ade-mission-zoom-label="true"]')!.click();
			const n2El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			// Force N2 to be occluded on the right side by panning world so N2 sits under right 352px zone
			const n2BeforeRect = n2El.getBoundingClientRect();
			const vpRect = viewportEl.getBoundingClientRect();
			if (n2BeforeRect.right < vpRect.right - 360) {
				const shiftRight = (vpRect.right - 80) - n2BeforeRect.right;
				viewportEl.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 30, clientX: 200, clientY: 200, bubbles: true }));
				viewportEl.dispatchEvent(new mainWindow.PointerEvent('pointermove', { button: 0, pointerId: 30, clientX: 200 + shiftRight, clientY: 200, bubbles: true }));
				viewportEl.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 30, clientX: 200 + shiftRight, clientY: 200, bubbles: true }));
			}
			const n2OccludedRect = n2El.getBoundingClientRect();
			assert.ok(n2OccludedRect.right > vpRect.right - 352, 'Precondition: N2 is positioned inside right 352px Inspector zone');

			// Click N2 -> Inspector opens AND canvas auto-pans leftward so N2 is no longer occluded!
			n2El.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 31, clientX: 50, clientY: 50, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 31, clientX: 50, clientY: 50, bubbles: true }));
			assert.strictEqual(inspector.hidden, false, 'Clicking N2 opens right-side Inspector');
			const n2AfterRect = n2El.getBoundingClientRect();
			const inspectorRect = inspector.getBoundingClientRect();
			assert.ok(
				n2AfterRect.right <= inspectorRect.left + 2,
				`Opening Inspector auto-pans canvas so N2 (${Math.round(n2AfterRect.right)}) is clear of Inspector (${Math.round(inspectorRect.left)})`,
			);

			// 3. Drag-pan on empty canvas preserves open Inspector; stationary click on empty canvas closes it!
			viewportEl.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 32, clientX: 300, clientY: 300, bubbles: true }));
			viewportEl.dispatchEvent(new mainWindow.PointerEvent('pointermove', { button: 0, pointerId: 32, clientX: 380, clientY: 330, bubbles: true }));
			viewportEl.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 32, clientX: 380, clientY: 330, bubbles: true }));
			assert.strictEqual(inspector.hidden, false, 'Dragging empty canvas to pan MUST NOT close right-side Inspector');
			assert.strictEqual(n2El.getAttribute('data-node-selected'), 'true', 'Dragging empty canvas to pan preserves selected node');

			// 4. Wide screen (1280px >= 1120px): opening left File Drawer keeps right Inspector open with zero overlap!
			fileBtn.click();
			assert.strictEqual(fileDrawer.hidden, false, 'File Drawer opens on wide screen');
			assert.strictEqual(inspector.hidden, false, 'Wide screen preserves right Inspector alongside File Drawer');
			const drawerRect = fileDrawer.getBoundingClientRect();
			assert.ok(
				drawerRect.right <= inspectorRect.left - 4,
				`Left File Drawer (${Math.round(drawerRect.right)}) never overlaps Right Inspector (${Math.round(inspectorRect.left)})`,
			);

			// Close File Drawer, then verify non-overlapping HUD safe zones (Top Bar vs Sup Legend vs Canvas Alert vs Spotlight vs Search vs Revision Bar vs Viewport Bar)
			fileBtn.click();
			assert.strictEqual(fileDrawer.hidden, true);
			await missionRuntime.setBoundary(created.id, {
				supervisors: [{ id: ADE_SECRETARY_ID, tier: 0, managedNodeIds: ['N1', 'N2'] }],
			});
			await missionRuntime.start(created.id);
			// Apply a live v2 revision patch so Revision Timeline Bar renders alongside Viewport Bar
			const patchRes = await missionRuntime.patchMermaid(created.id, {
				caller: { isHumanUser: true },
				newMermaidText: 'flowchart LR\n  N1["@Arch: Plan"] --> N2["@Dev: Implement"]\n  N2 --> N3["@QA: Verify"]',
				reason: 'Add QA stage',
			});
			assert.strictEqual(patchRes.ok, true, 'Live revision patch creates v2 timeline bar');
			rootEl.focus();
			mainWindow.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }));
			// Trigger a live canvas alert toast via blank-canvas context menu add-task during live run
			viewportEl.dispatchEvent(new mainWindow.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: vpRect.left + 80, clientY: vpRect.top + 80 }));
			const addTaskItem = host.querySelector<HTMLButtonElement>('[data-ade-ctx-action="add-task"]');
			if (addTaskItem) {
				addTaskItem.click();
			}
			const topBarRect = topBarSlot.getBoundingClientRect();
			const supLegend = host.querySelector<HTMLElement>('[data-ade-mission-sup-legend="true"]')!;
			const searchBar = host.querySelector<HTMLElement>('[data-ade-canvas-search="true"]')!;
			const revBar = host.querySelector<HTMLElement>('[data-ade-mission-revision-bar="true"]')!;
			const vpBar = host.querySelector<HTMLElement>('.ade-mission-viewport-bar')!;
			const supRect = supLegend.getBoundingClientRect();
			const searchRect = searchBar.getBoundingClientRect();
			const revRect = revBar.getBoundingClientRect();
			const vpBarRect = vpBar.getBoundingClientRect();
			assert.strictEqual(revBar.hidden, false, 'Revision timeline bar visible after live patch');
			assert.ok(topBarRect.bottom <= supRect.top + 1, `Top Bar (${Math.round(topBarRect.bottom)}) never overlaps Supervisor Legend (${Math.round(supRect.top)})`);
			assert.ok(supRect.bottom <= searchRect.top + 1, `Supervisor Legend (${Math.round(supRect.bottom)}) never overlaps Search Bar (${Math.round(searchRect.top)})`);
			assert.ok(searchRect.right <= inspectorRect.left + 1, `Search Bar (${Math.round(searchRect.right)}) stays clear of Right Inspector (${Math.round(inspectorRect.left)})`);
			assert.ok(revRect.right <= vpBarRect.left + 1, `Wide Revision Bar (${Math.round(revRect.right)}) never collides with Bottom-Right Viewport Bar (${Math.round(vpBarRect.left)})`);
			const canvasAlert = host.querySelector<HTMLElement>('[data-ade-mission-canvas-alert="true"]')!;
			if (!canvasAlert.hidden) {
				const alertRect = canvasAlert.getBoundingClientRect();
				assert.ok(topBarRect.bottom <= alertRect.top + 1, `Canvas Alert (${Math.round(alertRect.top)}) sits strictly below Top Bar (${Math.round(topBarRect.bottom)})`);
				assert.ok(supRect.right <= alertRect.left + 1, `Canvas Alert (${Math.round(alertRect.left)}) never overlaps Supervisor Legend (${Math.round(supRect.right)})`);
				assert.ok(alertRect.right <= inspectorRect.left + 1, `Canvas Alert (${Math.round(alertRect.right)}) stays clear of Right Inspector (${Math.round(inspectorRect.left)})`);
			}
			mainWindow.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

			// Hold Tab X-Ray spotlight banner sits cleanly below Top Bar & Supervisor Legend
			rootEl.focus();
			mainWindow.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
			const spotBanner = host.querySelector<HTMLElement>('[data-ade-tab-spotlight-banner="true"]')!;
			assert.strictEqual(spotBanner.hidden, false);
			const spotRect = spotBanner.getBoundingClientRect();
			assert.ok(topBarRect.bottom <= spotRect.top + 1, `Tab Spotlight Banner (${Math.round(spotRect.top)}) sits strictly below Top Bar (${Math.round(topBarRect.bottom)})`);
			assert.ok(supRect.bottom <= spotRect.top + 1, `Tab Spotlight Banner (${Math.round(spotRect.top)}) sits strictly below Supervisor Legend (${Math.round(supRect.bottom)})`);
			mainWindow.dispatchEvent(new mainWindow.KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));

			// Stationary click (< 5px) on empty canvas DOES close Inspector cleanly!
			viewportEl.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 33, clientX: 300, clientY: 300, bubbles: true }));
			viewportEl.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 33, clientX: 301, clientY: 301, bubbles: true }));
			assert.strictEqual(inspector.hidden, true, 'Stationary click on empty canvas closes right-side Inspector');

			// 5. Intermediate laptop width (980px) & narrow split-pane width (620px): top bar stays clean, revision bar stacks cleanly above viewport bar, and narrow drawers auto-collapse mutually
			host.style.width = '980px';
			pane.layout(new Dimension(980, 760));
			assert.ok(topBar.scrollWidth <= topBarSlot.clientWidth + 1, `Top bar stays within 980px container without clipping (${topBar.scrollWidth} <= ${topBarSlot.clientWidth})`);

			host.style.width = '620px';
			pane.layout(new Dimension(620, 760));
			assert.ok(topBar.scrollWidth <= topBarSlot.clientWidth + 1, `Top bar stays within 620px container without clipping (${topBar.scrollWidth} <= ${topBarSlot.clientWidth})`);
			const narrowRevRect = revBar.getBoundingClientRect();
			const narrowVpBarRect = vpBar.getBoundingClientRect();
			assert.ok(narrowRevRect.bottom <= narrowVpBarRect.top + 1, `Narrow Revision Bar (${Math.round(narrowRevRect.bottom)}) stacks cleanly above Viewport Bar (${Math.round(narrowVpBarRect.top)})`);

			// At narrow width (620px < 1120px), opening File Drawer collapses Inspector
			const n2NarrowEl = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N2"]')!;
			n2NarrowEl.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 34, clientX: 50, clientY: 50, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 34, clientX: 50, clientY: 50, bubbles: true }));
			assert.strictEqual(inspector.hidden, false);
			fileBtn.click();
			assert.strictEqual(fileDrawer.hidden, false, 'File Drawer opens on narrow screen');
			assert.strictEqual(inspector.hidden, true, 'Narrow screen auto-closes Inspector when opening File Drawer');
		});

		test('Audit #8: enforces pure EN / pure ZH-CN localization with zero mixed lines across all 5 surfaces and unifies dynamic 1..N rank schema + Mission v2 Factory Wall', async () => {
			const cjkRe = /[\u4e00-\u9fff]/;
			try {
				setAdeDisplayLanguageOverride('en');

				const h = createHarness([alpha]);
				const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
				h.instantiation.stub(IAdeRoleSchemaService, roleSchema);
				const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
				h.instantiation.stub(IAdeMissionService, missionStore);
				const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
				h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);

				// --- A. Mission Top Bar, File Drawer & 4-in-1 Node Inspector (EN vs ZH-CN) ---
				const created = missionStore.createMission({
					projectUri: alpha.toString(),
					title: 'Audit 8 Localization Mission',
					mermaidText: 'flowchart LR\n  N1["@Backend: Build API"] --> N2["@Frontend: Ship UI"]',
				});
				const mInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));
				const mHost = append(document.body, $('.monaco-workbench.ade-audit8-mission-host'));
				mHost.style.width = '1280px';
				mHost.style.height = '760px';
				store.add({ dispose: () => mHost.remove() });
				const mPane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
				mPane.create(mHost);
				mPane.layout(new Dimension(1280, 760));
				await mPane.setInput(mInput, undefined, {}, CancellationToken.None);

				// Open File Drawer + Node Inspector (wide 1280px screen keeps both open simultaneously!)
				mHost.querySelector<HTMLButtonElement>('[data-ade-mission-file-btn="true"]')!.click();
				const n1Title = mHost.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"] .ade-mission-node-title')!;
				n1Title.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 301, clientX: 220, clientY: 220, bubbles: true }));
				mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 301, clientX: 221, clientY: 221, bubbles: true }));

				const topBar = mHost.querySelector<HTMLElement>('[data-ade-mission-top-bar="true"]')!;
				const drawer = mHost.querySelector<HTMLElement>('[data-ade-mission-drawer="true"]')!;
				const inspector = mHost.querySelector<HTMLElement>('[data-ade-mission-node-inspector="true"]')!;
				assert.strictEqual(drawer.hidden, false);
				assert.strictEqual(inspector.hidden, false);

				// 1. Pure EN verification: ZERO CJK anywhere in Top Bar, Split Drawer, and all 4 Inspector Tabs!
				assert.strictEqual(topBar.children.length, 2, 'Top bar has only File Drawer toggle + Run Control pill');
				assert.strictEqual(cjkRe.test(topBar.textContent ?? ''), false, `Top bar must have 0 CJK in EN mode (got: "${topBar.textContent}")`);
				assert.ok((topBar.textContent ?? '').includes('Idle') && (topBar.textContent ?? '').includes('Start'), 'Top bar renders pure EN Idle/Start labels');
				assert.strictEqual(cjkRe.test(drawer.textContent ?? ''), false, `File drawer must have 0 CJK in EN mode (got: "${drawer.textContent}")`);
				assert.ok((drawer.textContent ?? '').includes('Orchestration · Mermaid DAG'));
				assert.ok((drawer.textContent ?? '').includes('Node Prompts'));

				for (const tabId of ['overview', 'token', 'distill', 'finops'] as const) {
					inspector.querySelector<HTMLButtonElement>(`[data-ade-inspector-tab="${tabId}"]`)!.click();
					assert.strictEqual(cjkRe.test(inspector.textContent ?? ''), false, `Inspector tab "${tabId}" must have 0 CJK in EN mode (got: "${inspector.textContent}")`);
				}
				inspector.querySelector<HTMLButtonElement>('[data-ade-inspector-tab="overview"]')!.click();
				assert.ok((inspector.textContent ?? '').includes('Node Role'), 'Inspector overview renders pure EN Node Role row');
				assert.ok((inspector.textContent ?? '').includes('Worker · Executor'), 'Inspector overview renders pure EN role chip');

				// 2. Switch to pure Simplified Chinese -> immediate live re-render across Top Bar, Drawer, and all 4 Inspector Tabs!
				setAdeDisplayLanguageOverride('zh-cn');
				assert.ok((topBar.textContent ?? '').includes('待命') && (topBar.textContent ?? '').includes('启动'), 'Top bar switches live to ZH-CN 待命/启动');
				assert.ok(!(topBar.textContent ?? '').includes('Start') && !(topBar.textContent ?? '').includes('Idle'), 'Top bar has no leftover mixed English labels in ZH-CN');

				assert.ok((drawer.textContent ?? '').includes('统筹编排 · Mermaid 流图'));
				assert.ok((drawer.textContent ?? '').includes('节点提示词'));
				assert.ok((drawer.textContent ?? '').includes('催办超时 (分)'));
				assert.ok((drawer.textContent ?? '').includes('图外监工'));

				const zhOverviewText = inspector.textContent ?? '';
				assert.ok(zhOverviewText.includes('概览') && zhOverviewText.includes('令牌轨迹') && zhOverviewText.includes('提纯校验') && zhOverviewText.includes('费用账本'), 'Inspector tabs switch cleanly to ZH-CN');
				assert.ok(zhOverviewText.includes('所属监工') && zhOverviewText.includes('节点角色') && zhOverviewText.includes('执行者 · 任务节点'), 'Inspector overview KV rows switch cleanly to ZH-CN');
				assert.ok(!zhOverviewText.includes('Supervisor') && !zhOverviewText.includes('Split Chat Beside') && !zhOverviewText.includes('Worker ·'), 'Inspector overview has no mixed English labels in ZH-CN');

				// --- B. Dynamic 1..N Rank Schema Unity across Role Studio, Session Editor & Projects View ---
				setAdeDisplayLanguageOverride('en');

				const custom3TierConfig: IAdeOrganizationConfig = {
					version: 1,
					presetId: 'custom',
					ranks: [
						{ id: 'architect', name: 'Chief Architect', shortName: 'Arch', tier: 1, color: 'amber', icon: 'organization', summary: 'Top architect', initPrompt: 'You are L1 Chief Architect.', pureExecution: false, canHaveSubordinates: true, allowedApis: ['session.read_context', 'session.message', 'session.manage', 'project.read'] },
						{ id: 'auditor', name: 'Code Auditor', shortName: 'Aud', tier: 2, color: 'purple', icon: 'shield', summary: 'Mid auditor', initPrompt: 'You are L2 Code Auditor.', pureExecution: false, canHaveSubordinates: true, allowedApis: ['session.read_context', 'project.read'] },
						{ id: 'builder', name: 'Pure Builder', shortName: 'Bld', tier: 3, color: 'emerald', icon: 'tools', summary: 'Pure leaf builder', initPrompt: '', pureExecution: true, canHaveSubordinates: false, allowedApis: [] },
					],
				};
				await roleSchema.updateConfig(custom3TierConfig);

				// B1. Role Studio shows Mission v2 Dynamic 1..3 Tiers & interactive Factory Wall (offGraphMaxTier) bar + preserves Legacy v1 slots
				const studioHost = append(document.body, $('.monaco-workbench.ade-audit8-studio-host'));
				store.add({ dispose: () => studioHost.remove() });
				const studioPane = store.add(h.instantiation.createInstance(AdeRoleStudioEditorPane, upcastPartial<IEditorGroup>({ id: 2 })));
				studioPane.create(studioHost);
				const studioInput = store.add(h.instantiation.createInstance(AdeRoleStudioEditorInput, 'architect'));
				await studioPane.setInput(studioInput, undefined, {}, CancellationToken.None);

				const wallBar = studioHost.querySelector<HTMLElement>('[data-ade-rs-factory-wall-bar="true"]')!;
				assert.ok(wallBar, 'Role Studio renders Mission v2 Dynamic Ranks & Factory Wall bar');
				assert.strictEqual(wallBar.dataset.dynamicRankCount, '3', 'Factory Wall reflects 3 dynamic ranks');
				assert.strictEqual(cjkRe.test(studioHost.textContent ?? ''), false, 'Role Studio has 0 CJK in EN mode');
				assert.ok(studioHost.querySelectorAll('.ade-rs-slot-select[data-slot]').length === 4, 'Legacy v1 slot compatibility selects remain intact');

				// Change Factory Wall cutoff preview to L0..L1 -> L1 Chief Architect moves to Off-Graph Supervisors, L2/L3 stay In-Graph!
				const cutoffSelect = studioHost.querySelector<HTMLSelectElement>('[data-ade-rs-wall-cutoff="true"]')!;
				cutoffSelect.value = '1';
				cutoffSelect.dispatchEvent(new mainWindow.Event('change', { bubbles: true }));
				const offGraphZone = studioHost.querySelector<HTMLElement>('[data-ade-rs-wall-zone="off-graph"]')!;
				const inGraphZone = studioHost.querySelector<HTMLElement>('[data-ade-rs-wall-zone="in-graph"]')!;
				assert.ok((offGraphZone.textContent ?? '').includes('L1 · Chief Architect'), 'L1 rank moves into Off-Graph Supervisors when offGraphMaxTier=1');
				assert.ok((inGraphZone.textContent ?? '').includes('L2 · Code Auditor') && (inGraphZone.textContent ?? '').includes('L3 · Pure Builder'), 'L2..L3 stay in In-Graph Mission Nodes');

				// Role Studio live locale switch to ZH-CN
				setAdeDisplayLanguageOverride('zh-cn');
				assert.ok((studioHost.textContent ?? '').includes('组织架构与角色工坊'));
				assert.ok((studioHost.textContent ?? '').includes('厂外监工层') && (studioHost.textContent ?? '').includes('厂内执行节点'));

				// B2. Session Editor & Session EditorInput subscribe to IAdeRoleSchemaService (zero hardcoded 4-tier labels!)
				setAdeDisplayLanguageOverride('en');
				const archAgent = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/audit8-arch') }, 'Arch Lead', { role: 'architect' });
				const auditAgent = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/audit8-aud') }, 'Audit Lead', { parentId: archAgent.id, role: 'auditor' });
				const sessionInput = store.add(h.instantiation.createInstance(AdeSessionEditorInput, auditAgent.id));
				assert.strictEqual(sessionInput.getDescription(), 'Alpha › Arch Lead › Code Auditor', 'SessionEditorInput description reflects live dynamic rank name');

				const sessionHost = append(document.body, $('.monaco-workbench.ade-audit8-session-host'));
				store.add({ dispose: () => sessionHost.remove() });
				const sessionEditor = store.add(h.instantiation.createInstance(AdeSessionEditor, upcastPartial<IEditorGroup>({ id: 3 })));
				sessionEditor.create(sessionHost);
				await sessionEditor.setInput(sessionInput, undefined, {}, CancellationToken.None);

				const rankPill = sessionHost.querySelector<HTMLElement>('.ade-session-rank-pill')!;
				assert.strictEqual(rankPill.textContent, 'Code Auditor', 'Session Editor header pill renders dynamic rank name');
				assert.strictEqual(rankPill.getAttribute('data-tier'), 'L2', 'Session Editor header pill renders dynamic tier L2');
				assert.strictEqual(cjkRe.test(sessionHost.textContent ?? ''), false, 'Session Editor has 0 CJK in EN mode');

				setAdeDisplayLanguageOverride('zh-cn');
				assert.ok((sessionHost.textContent ?? '').includes('连接会话...'), 'Session Editor switches cleanly to ZH-CN');

				// B3. Projects View Empty State dynamically reflects 1..N tiers (no hardcoded "across 4 organizational tiers"!)
				setAdeDisplayLanguageOverride('en');
				const emptyHarness = createHarness([]);
				const emptyRoleSchema = store.add(emptyHarness.instantiation.createInstance(AdeRoleSchemaService));
				await emptyRoleSchema.updateConfig(custom3TierConfig);
				emptyHarness.instantiation.stub(IAdeRoleSchemaService, emptyRoleSchema);
				const dummySidebar = new class extends mock<ViewContainer>() { override readonly id = 'test.ade.audit8'; }();
				emptyHarness.instantiation.stub(IViewDescriptorService, {
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
				const pvHost = append(document.body, $('.monaco-workbench.ade-audit8-projects-host'));
				pvHost.style.width = '280px';
				pvHost.style.height = '500px';
				store.add({ dispose: () => pvHost.remove() });
				const pv = store.add(emptyHarness.instantiation.createInstance(AdeProjectsView, { id: ADE_PROJECTS_VIEW_ID, title: 'Sessions' }));
				pv.render();
				pvHost.appendChild(pv.element);
				pv.setVisible(true);
				pv.orthogonalSize = 280;
				pv.layout(500);
				await pv.refresh();

				const emptyTextEl = pvHost.querySelector<HTMLElement>('.ade-projects-empty-text')!;
				assert.strictEqual(emptyTextEl.dataset.dynamicTierCount, '3', 'Projects View empty state tracks live dynamic tier count (3)');
				assert.ok((emptyTextEl.textContent ?? '').includes('3 dynamic organizational tiers') && (emptyTextEl.textContent ?? '').includes('L1 Chief Architect → L2 Code Auditor → L3 Pure Builder'));
				assert.ok(!(emptyTextEl.textContent ?? '').includes('4 organizational tiers'), 'Projects View empty state no longer hardcodes 4 tiers');
				assert.strictEqual(cjkRe.test(pvHost.textContent ?? ''), false, 'Projects View has 0 CJK in EN mode');

				setAdeDisplayLanguageOverride('zh-cn');
				await timeout(10);
				assert.ok((emptyTextEl.textContent ?? '').includes('3 层动态组织职级'), 'Projects View empty state switches cleanly to ZH-CN');
				assert.ok((pvHost.textContent ?? '').includes('添加项目文件夹...'));
			} finally {
				setAdeDisplayLanguageOverride('auto');
			}
		});

		test('Audit #9: Gate card renders inline Approve / Reject quick actions and canvas Gate popover selects any executed upstream rollback target', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const created = missionStore.createMission({
				title: 'Audit 9 Gate Rollback Mission',
				projectUri: alpha.toString(),
				mermaidText: [
					'flowchart LR',
					'  A["Design Spec"] --> B["Implement"]',
					'  B --> C["Verify"]',
					'  C --> G1{"Release Gate"}',
					'  G1 --> D["Deploy"]',
					'  A --> X["Side Branch"]',
				].join('\n'),
			});
			await missionRuntime.start(created.id);
			const completeActive = async (nodeId: string, summary: string) => {
				const tok = Object.values(missionRuntime.getRuntimeState(created.id).tokens).find(t => t.nodeId === nodeId && t.status === 'active')!;
				assert.ok(tok, `Expected active token on ${nodeId}`);
				const res = await missionRuntime.completeToken(created.id, { tokenId: tok.id, summary });
				assert.strictEqual(res.ok, true, res.error);
			};

			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));
			const host = append(document.body, $('.monaco-workbench.ade-audit9-gate-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			// Before Gate is reached, inline quick-approval bar stays hidden
			const inlineBar = host.querySelector<HTMLElement>('[data-ade-gate-inline-actions="G1"]')!;
			assert.ok(inlineBar, 'Gate card mounts inline approval bar');
			assert.strictEqual(inlineBar.hidden, true, 'Inline Gate actions are hidden while Gate is idle');

			// Advance A -> B -> C -> G1
			await completeActive('A', 'Spec ready');
			await completeActive('B', 'Implementation ready');
			await completeActive('C', 'All tests green');
			assert.strictEqual(missionRuntime.getRuntimeState(created.id).nodeStates.G1, 'waiting_gate');

			// Inline Approve / Reject buttons become visible directly on the Gate card
			assert.strictEqual(inlineBar.hidden, false, 'Inline Gate Approve/Reject bar appears when Gate enters waiting_gate');
			const cardApproveBtn = host.querySelector<HTMLButtonElement>('[data-ade-gate-card-approve="G1"]')!;
			const cardRejectBtn = host.querySelector<HTMLButtonElement>('[data-ade-gate-card-reject="G1"]')!;
			assert.ok(cardApproveBtn && cardRejectBtn);

			// Dragging the Gate card starting on its inline Approve button must move the card and NOT accidentally approve!
			cardApproveBtn.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 401, clientX: 300, clientY: 300, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointermove', { button: 0, pointerId: 401, clientX: 335, clientY: 325, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 401, clientX: 335, clientY: 325, bubbles: true }));
			cardApproveBtn.click();
			await timeout(20);
			assert.strictEqual(missionRuntime.getRuntimeState(created.id).nodeStates.G1, 'waiting_gate', 'Dragging from inline Approve button must suppress click and NOT approve Gate');

			// Clean click on inline Reject opens the Gate decision popover with ALL executed upstream reachable targets (A, B, C)
			cardRejectBtn.click();
			const rollbackSelect = host.querySelector<HTMLSelectElement>('[data-ade-gate-rollback-select="true"]')!;
			assert.ok(rollbackSelect, 'Canvas Gate popover renders upstream rollback target dropdown');
			const optionValues = [...rollbackSelect.options].map(o => o.value);
			assert.deepStrictEqual(optionValues, ['A', 'B', 'C'], 'Dropdown lists all executed upstream reachable ancestors [A, B, C] and excludes downstream D / side branch X');
			assert.strictEqual(rollbackSelect.value, 'C', 'Dropdown defaults to direct predecessor C');

			// Choose earliest upstream ancestor A (not direct predecessor C!) + note -> Reject bounces directly to A
			rollbackSelect.value = 'A';
			rollbackSelect.dispatchEvent(new mainWindow.Event('change', { bubbles: true }));
			const noteInput = host.querySelector<HTMLInputElement>('[data-ade-gate-note="true"]')!;
			noteInput.value = 'Re-specify API contract from A';
			host.querySelector<HTMLButtonElement>('[data-ade-gate-reject="G1"]')!.click();
			await timeout(30);

			const rtAfterReject = missionRuntime.getRuntimeState(created.id);
			assert.notStrictEqual(rtAfterReject.nodeStates.G1, 'waiting_gate', 'Rejecting Gate releases waiting_gate');
			assert.ok(Object.values(rtAfterReject.tokens).some(t => t.nodeId === 'A' && t.status === 'active'), 'Reject with explicit rollbackNodeId=A bounces token directly to A');
			assert.ok(!Object.values(rtAfterReject.tokens).some(t => t.nodeId === 'C' && t.status === 'active'), 'Token did not default-bounce to direct predecessor C');
			assert.strictEqual(inlineBar.hidden, true, 'Inline Gate actions hide once Gate leaves waiting_gate');

			// Complete rework chain A -> B -> C -> returns to G1 waiting_gate (without touching sibling X) -> 1-click inline Approve!
			await completeActive('A', 'Spec v2 revised');
			await completeActive('B', 'Implementation v2 revised');
			await completeActive('C', 'Verification v2 green');
			assert.strictEqual(missionRuntime.getRuntimeState(created.id).nodeStates.G1, 'waiting_gate');
			assert.strictEqual(inlineBar.hidden, false, 'Inline Gate actions reappear when rework returns to G1');

			cardApproveBtn.click();
			await timeout(30);
			const rtAfterApprove = missionRuntime.getRuntimeState(created.id);
			assert.strictEqual(rtAfterApprove.nodeStates.G1, 'completed', '1-click inline Approve on Gate card completes Gate');
			assert.ok(Object.values(rtAfterApprove.tokens).some(t => t.nodeId === 'D' && t.status === 'active'), 'Inline Approve dispatches downstream node D');
			assert.strictEqual(inlineBar.hidden, true, 'Inline Gate actions hide after approval');
		});

		test('Audit #11: edge transit glider plays once for 800ms on cross-node hops (no infinite loop / double shadow) and pauses all infinite CSS animations when page or tab is hidden', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const created = missionStore.createMission({
				title: 'Audit 11 Transit & Visibility Mission',
				projectUri: alpha.toString(),
				mermaidText: [
					'flowchart LR',
					'  A["Fetch"] --> B["Train"]',
					'  B --> G1{"Release Gate"}',
					'  A --> C["Audit"]',
					'  G1 --> J["Merge"]',
					'  C --> J',
				].join('\n'),
			});
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));
			const host = append(document.body, $('.monaco-workbench.ade-audit11-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			const started = await missionRuntime.start(created.id);
			assert.strictEqual(started.ok, true, started.error);
			assert.strictEqual(host.querySelectorAll('[data-ade-edge-puck]').length, 0, 'Entry node mint spawns no incoming edge puck');

			// 1. Live cross-node hop A -> B & A -> C plays a single-shot 800ms edge glide
			const tokA = Object.values(missionRuntime.getRuntimeState(created.id).tokens).find(t => t.nodeId === 'A' && t.status === 'active')!;
			const compA = await missionRuntime.completeToken(created.id, { tokenId: tokA.id, summary: 'Fetched dataset' });
			assert.strictEqual(compA.ok, true, compA.error);

			const edgeAB = host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="A"][data-to="B"]')!;
			const edgeAC = host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="A"][data-to="C"]')!;
			assert.ok(edgeAB.classList.contains('is-token-flowing'), 'Incoming edge A->B briefly enters is-token-flowing right after cross-node hop');
			assert.ok(edgeAC.classList.contains('is-token-flowing'), 'Incoming edge A->C briefly enters is-token-flowing right after cross-node hop');

			const puckAB = host.querySelector<SVGGElement>(`[data-ade-edge-puck="${edgeAB.getAttribute('data-edge-id')}"]`)!;
			assert.ok(puckAB, 'Cross-node hop A->B spawns one-shot edge transit puck');
			assert.strictEqual(puckAB.getAttribute('data-transit-once'), 'true');
			assert.strictEqual(puckAB.getAttribute('data-transit-duration-ms'), '800');
			const puckStyle = mainWindow.getComputedStyle(puckAB);
			assert.strictEqual(puckStyle.animationIterationCount, '1', 'Edge puck animation plays once (never infinite)');
			assert.strictEqual(puckStyle.animationDuration, '0.8s', 'Edge puck animation duration is 800ms');
			const edgeABPathStyle = mainWindow.getComputedStyle(edgeAB.querySelector('.ade-mission-edge-path')!);
			assert.strictEqual(edgeABPathStyle.animationIterationCount, '1', 'Incoming edge flow dash plays once (never infinite)');

			// 2. Block B and advance C -> J (waiting_join), then wait past 800ms: all edge gliders & flowing states MUST clear (zero double shadow!)
			const tokB = Object.values(missionRuntime.getRuntimeState(created.id).tokens).find(t => t.nodeId === 'B' && t.status === 'active')!;
			await missionRuntime.blockToken(created.id, {
				tokenId: tokB.id,
				reason: 'Waiting GPU checkpoint',
				maxDuration: '15m',
				watchPid: 9101,
			});
			const tokC = Object.values(missionRuntime.getRuntimeState(created.id).tokens).find(t => t.nodeId === 'C' && t.status === 'active')!;
			const compC = await missionRuntime.completeToken(created.id, { tokenId: tokC.id, summary: 'Audit green' });
			assert.strictEqual(compC.ok, true, compC.error);
			const edgeCJ = host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="C"][data-to="J"]')!;
			assert.ok(edgeCJ.classList.contains('is-token-flowing'), 'Join arrival C->J plays brief transit immediately after hop');

			await timeout(880);
			assert.strictEqual(host.querySelectorAll('[data-ade-edge-puck]').length, 0, 'After 800ms, ALL edge pucks are removed even while B is blocked and J is waiting_join');
			assert.strictEqual(edgeAB.classList.contains('is-token-flowing'), false, 'Blocked incoming edge A->B stops flowing after 800ms');
			assert.strictEqual(edgeCJ.classList.contains('is-token-flowing'), false, 'Waiting-join incoming edge C->J stops flowing after 800ms');
			assert.strictEqual(edgeCJ.classList.contains('is-join-arrived'), true, 'Static join-arrived highlight persists cleanly without infinite animation');
			assert.strictEqual(host.querySelector<HTMLElement>('[data-ade-token-puck="B"]')?.hidden, false, 'Target node B still displays its own docked blocked token puck');

			// Subsequent 1Hz telemetry updates on blocked B must NOT respawn edge gliders or flowing dashes
			missionRuntime.recordNodeTurnUsage(created.id, 'B', { inputTokens: 1200, outputTokens: 200, totalTokens: 1400, costUsd: 0.02 });
			assert.strictEqual(host.querySelectorAll('[data-ade-edge-puck]').length, 0, '1Hz telemetry tick on blocked node does not respawn edge glider');
			assert.strictEqual(edgeAB.classList.contains('is-token-flowing'), false);

			// 3. Complete B -> G1 (waiting_gate): plays one fresh 800ms glide ONLY on B->G1, then clears while G1 stays waiting_gate
			const compB = await missionRuntime.completeToken(created.id, { tokenId: tokB.id, summary: 'Model trained' });
			assert.strictEqual(compB.ok, true, compB.error);
			assert.strictEqual(missionRuntime.getRuntimeState(created.id).nodeStates.G1, 'waiting_gate');
			const edgeBG1 = host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="B"][data-to="G1"]')!;
			assert.strictEqual(host.querySelectorAll('[data-ade-edge-puck]').length, 1, 'Only newly crossed edge B->G1 spawns an edge puck');
			assert.ok(host.querySelector(`[data-ade-edge-puck="${edgeBG1.getAttribute('data-edge-id')}"]`), 'Edge puck belongs to B->G1');
			assert.strictEqual(edgeAB.classList.contains('is-token-flowing'), false, 'Previously settled edge A->B does not replay');

			await timeout(880);
			assert.strictEqual(host.querySelectorAll('[data-ade-edge-puck]').length, 0, 'After 800ms, waiting_gate edge puck is removed (no infinite loop on Gate)');
			assert.strictEqual(edgeBG1.classList.contains('is-token-flowing'), false, 'Waiting-gate incoming edge stops flowing after 800ms');

			// 4. Cold-opening a Mission whose waiting_gate / waiting_join tokens are >800ms old spawns ZERO edge pucks
			const coldHost = append(document.body, $('.monaco-workbench.ade-audit11-cold-host'));
			coldHost.style.width = '1280px';
			coldHost.style.height = '760px';
			store.add({ dispose: () => coldHost.remove() });
			const coldInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));
			const coldPane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 2, index: 1 })));
			coldPane.create(coldHost);
			coldPane.layout(new Dimension(1280, 760));
			await coldPane.setInput(coldInput, undefined, {}, CancellationToken.None);
			assert.strictEqual(coldHost.querySelectorAll('[data-ade-edge-puck]').length, 0, 'Cold-opening stalled/waiting Mission spawns zero stale edge pucks');
			assert.strictEqual(coldHost.querySelectorAll('.ade-mission-edge-group.is-token-flowing').length, 0, 'Cold-opening stalled/waiting Mission leaves zero edges flowing');

			// 4b. Rework rollback G1 -> A -> B crosses the SAME edge A->B a second time and plays a fresh 800ms glide with a new token id
			const firstTokenIdAB = puckAB.getAttribute('data-token-id');
			const rejGate = await missionRuntime.resolveGate(created.id, { nodeId: 'G1', decision: 'reject', rollbackNodeId: 'A', note: 'Re-run A->B' });
			assert.strictEqual(rejGate.ok, true, rejGate.error);
			const tokA2 = Object.values(missionRuntime.getRuntimeState(created.id).tokens).find(t => t.nodeId === 'A' && t.status === 'active')!;
			const compA2 = await missionRuntime.completeToken(created.id, { tokenId: tokA2.id, summary: 'Re-fetched dataset v2' });
			assert.strictEqual(compA2.ok, true, compA2.error);
			const puckAB2 = host.querySelector<SVGGElement>(`[data-ade-edge-puck="${edgeAB.getAttribute('data-edge-id')}"]`)!;
			assert.ok(puckAB2, 'Second hop across the same edge A->B spawns a fresh one-shot puck');
			assert.notStrictEqual(puckAB2.getAttribute('data-token-id'), firstTokenIdAB, 'Second hop uses new token id and restarts animation');
			assert.strictEqual(edgeAB.classList.contains('is-token-flowing'), true);
			const tokB2 = Object.values(missionRuntime.getRuntimeState(created.id).tokens).find(t => t.nodeId === 'B' && t.status === 'active')!;
			const compB2 = await missionRuntime.completeToken(created.id, { tokenId: tokB2.id, summary: 'Re-trained model v2' });
			assert.strictEqual(compB2.ok, true, compB2.error);
			assert.strictEqual(missionRuntime.getRuntimeState(created.id).nodeStates.G1, 'waiting_gate');

			// 5. Approve G1 -> J becomes active; verify page visibilitychange & setVisible(false) pause ALL infinite CSS animations
			const resGate = await missionRuntime.resolveGate(created.id, { nodeId: 'G1', decision: 'approve' });
			assert.strictEqual(resGate.ok, true, resGate.error);
			assert.strictEqual(missionRuntime.getRuntimeState(created.id).nodeStates.J, 'active');

			const editorRoot = host.querySelector<HTMLElement>('.ade-mission-editor')!;
			const activeCoreWell = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="J"] .ade-mission-core-well')!;
			const activeStateDot = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="J"] .ade-mission-state-dot')!;
			const runDot = host.querySelector<HTMLElement>('.ade-mission-run-bar .ade-mission-run-dot')!;
			const pacemakerRing = host.querySelector<HTMLElement>('.ade-mission-port.port-in.is-pacemaker.is-armed .ade-mission-pacemaker-ring.ring-1')!;
			// Also illuminate a trace-highlighted edge (uses !important animation) to confirm pause overrides it!
			edgeBG1.classList.add('is-trace-highlighted');
			const traceEdgePath = edgeBG1.querySelector<SVGPathElement>('.ade-mission-edge-path')!;

			assert.strictEqual(editorRoot.classList.contains('ade-animations-paused'), false);
			assert.strictEqual(mainWindow.getComputedStyle(activeCoreWell).animationPlayState, 'running', 'Active node breath runs while visible');
			assert.strictEqual(mainWindow.getComputedStyle(activeStateDot).animationPlayState, 'running', 'Active state dot pulses while visible');
			assert.strictEqual(mainWindow.getComputedStyle(runDot).animationPlayState, 'running', 'Run bar dot pulses while visible');
			assert.strictEqual(mainWindow.getComputedStyle(pacemakerRing).animationPlayState, 'running', 'Pacemaker ring pulses while visible');
			assert.strictEqual(mainWindow.getComputedStyle(traceEdgePath).animationPlayState, 'running', 'Trace-highlighted edge flows while visible');

			const doc = editorRoot.ownerDocument;
			const origHiddenDesc = Object.getOwnPropertyDescriptor(doc, 'hidden');
			const origVisDesc = Object.getOwnPropertyDescriptor(doc, 'visibilityState');
			try {
				Object.defineProperty(doc, 'hidden', { configurable: true, get: () => true });
				Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
				doc.dispatchEvent(new mainWindow.Event('visibilitychange'));

				assert.strictEqual(editorRoot.classList.contains('ade-animations-paused'), true, 'visibilitychange(hidden) sets ade-animations-paused on Mission Canvas');
				assert.strictEqual(editorRoot.getAttribute('data-animations-paused'), 'true');
				assert.strictEqual(doc.documentElement.classList.contains('ade-page-hidden'), true, 'visibilitychange(hidden) sets ade-page-hidden on documentElement');
				assert.strictEqual(mainWindow.getComputedStyle(activeCoreWell).animationPlayState, 'paused', 'Active node breath pauses when page is hidden');
				assert.strictEqual(mainWindow.getComputedStyle(activeStateDot).animationPlayState, 'paused', 'Active state dot pauses when page is hidden');
				assert.strictEqual(mainWindow.getComputedStyle(runDot).animationPlayState, 'paused', 'Run bar dot pauses when page is hidden');
				assert.strictEqual(mainWindow.getComputedStyle(pacemakerRing).animationPlayState, 'paused', 'Pacemaker ring pauses when page is hidden');
				assert.strictEqual(mainWindow.getComputedStyle(traceEdgePath).animationPlayState, 'paused', 'Trace-highlighted edge (!important) pauses when page is hidden');

				Object.defineProperty(doc, 'hidden', { configurable: true, get: () => false });
				Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'visible' });
				doc.dispatchEvent(new mainWindow.Event('visibilitychange'));

				assert.strictEqual(editorRoot.classList.contains('ade-animations-paused'), false, 'visibilitychange(visible) resumes Mission Canvas animations');
				assert.strictEqual(doc.documentElement.classList.contains('ade-page-hidden'), false);
				assert.strictEqual(mainWindow.getComputedStyle(activeCoreWell).animationPlayState, 'running', 'Active node breath resumes when page returns visible');
			} finally {
				if (origHiddenDesc) {
					Object.defineProperty(doc, 'hidden', origHiddenDesc);
				} else {
					delete (doc as unknown as { hidden?: boolean }).hidden;
				}
				if (origVisDesc) {
					Object.defineProperty(doc, 'visibilityState', origVisDesc);
				} else {
					delete (doc as unknown as { visibilityState?: DocumentVisibilityState }).visibilityState;
				}
				doc.dispatchEvent(new mainWindow.Event('visibilitychange'));
			}

			// 6. Switching away from the Mission editor tab (setVisible(false)) also pauses animations without hiding the OS window
			pane.setVisible(false);
			assert.strictEqual(editorRoot.classList.contains('ade-animations-paused'), true, 'Editor tab backgrounded pauses Mission Canvas animations');
			assert.strictEqual(mainWindow.getComputedStyle(activeCoreWell).animationPlayState, 'paused');
			pane.setVisible(true);
			assert.strictEqual(editorRoot.classList.contains('ade-animations-paused'), false, 'Editor tab foregrounded resumes Mission Canvas animations');
			assert.strictEqual(mainWindow.getComputedStyle(activeCoreWell).animationPlayState, 'running');

			// 7. Workbench-wide AdePageVisibilityAnimationGuard pauses global ADE animations even with ZERO Mission panes open!
			pane.dispose();
			coldPane.dispose();
			const globalGuard = store.add(new AdePageVisibilityAnimationGuard());
			assert.ok(globalGuard);
			const gDoc = mainWindow.document;
			const gOrigHidden = Object.getOwnPropertyDescriptor(gDoc, 'hidden');
			const gOrigVis = Object.getOwnPropertyDescriptor(gDoc, 'visibilityState');
			try {
				Object.defineProperty(gDoc, 'hidden', { configurable: true, get: () => true });
				Object.defineProperty(gDoc, 'visibilityState', { configurable: true, get: () => 'hidden' });
				gDoc.dispatchEvent(new mainWindow.Event('visibilitychange'));
				assert.strictEqual(gDoc.documentElement.classList.contains('ade-page-hidden'), true, 'Global visibility guard sets ade-page-hidden even when no Mission pane is open');

				Object.defineProperty(gDoc, 'hidden', { configurable: true, get: () => false });
				Object.defineProperty(gDoc, 'visibilityState', { configurable: true, get: () => 'visible' });
				gDoc.dispatchEvent(new mainWindow.Event('visibilitychange'));
				assert.strictEqual(gDoc.documentElement.classList.contains('ade-page-hidden'), false, 'Global visibility guard clears ade-page-hidden on visible return');
			} finally {
				if (gOrigHidden) {
					Object.defineProperty(gDoc, 'hidden', gOrigHidden);
				} else {
					delete (gDoc as unknown as { hidden?: boolean }).hidden;
				}
				if (gOrigVis) {
					Object.defineProperty(gDoc, 'visibilityState', gOrigVis);
				} else {
					delete (gDoc as unknown as { visibilityState?: DocumentVisibilityState }).visibilityState;
				}
				gDoc.dispatchEvent(new mainWindow.Event('visibilitychange'));
			}
		});

		test('Audit #15: wide fan-out obeys multi-level concurrency semaphores, shows live FIFO queue ranks (#1/3..#3/3) on cards, and promotes queued nodes cleanly in place', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const created = missionStore.createMission({
				title: 'Audit 15 Wide Fan-Out Concurrency Mission',
				projectUri: alpha.toString(),
				mermaidText: [
					'flowchart LR',
					'  S["Dispatch Root"] --> W1["Worker 1"]',
					'  S --> W2["Worker 2"]',
					'  S --> W3["Worker 3"]',
					'  S --> W4["Worker 4"]',
					'  S --> W5["Worker 5"]',
				].join('\n'),
			});
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, created.id));
			const host = append(document.body, $('.monaco-workbench.ade-audit15-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			// Start with maxLocalHost=2 so a 5-way fan-out admits W1 & W2 immediately and queues W3, W4, W5 as #1/3, #2/3, #3/3!
			const started = await missionRuntime.start(created.id, {
				concurrencyLimits: { maxGlobal: 8, maxLocalHost: 2, maxPerCloudHost: 2, maxPerProvider: 8 },
			});
			assert.strictEqual(started.ok, true, started.error);
			const tokS = Object.values(missionRuntime.getRuntimeState(created.id).tokens).find(t => t.nodeId === 'S' && t.status === 'active')!;
			const compS = await missionRuntime.completeToken(created.id, { tokenId: tokS.id, summary: 'Root split 5 parallel jobs' });
			assert.strictEqual(compS.ok, true, compS.error);

			const rtAfterFanout = missionRuntime.getRuntimeState(created.id);
			assert.strictEqual(rtAfterFanout.nodeStates.W1, 'active');
			assert.strictEqual(rtAfterFanout.nodeStates.W2, 'active');
			assert.strictEqual(rtAfterFanout.nodeStates.W3, 'queued');
			assert.strictEqual(rtAfterFanout.nodeStates.W4, 'queued');
			assert.strictEqual(rtAfterFanout.nodeStates.W5, 'queued');

			const statusView = missionRuntime.getMissionStatus(created.id);
			assert.strictEqual(statusView.activeTokenCount, 2);
			assert.strictEqual(statusView.queuedTokenCount, 3);

			// Verify Mission Canvas node cards display live FIFO queue ranks #1/3, #2/3, #3/3
			const cardW3Before = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="W3"]')!;
			const cardW4Before = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="W4"]')!;
			const cardW5Before = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="W5"]')!;
			assert.strictEqual(cardW3Before.getAttribute('data-node-state'), 'queued');
			assert.strictEqual(cardW3Before.getAttribute('data-node-queue-position'), '1');
			assert.strictEqual(cardW3Before.getAttribute('data-node-queue-total'), '3');
			assert.strictEqual(cardW4Before.getAttribute('data-node-queue-position'), '2');
			assert.strictEqual(cardW5Before.getAttribute('data-node-queue-position'), '3');
			assert.ok(host.querySelector<HTMLElement>('[data-ade-token-puck="W3"]')?.textContent?.includes('#1/3'), 'W3 puck shows queue rank #1/3');
			assert.ok(host.querySelector<HTMLElement>('[data-ade-token-puck="W4"]')?.textContent?.includes('#2/3'), 'W4 puck shows queue rank #2/3');
			assert.ok(host.querySelector<HTMLElement>('[data-ade-token-puck="W5"]')?.textContent?.includes('#3/3'), 'W5 puck shows queue rank #3/3');
			assert.ok(cardW3Before.querySelector('.ade-mission-core-context')?.textContent?.includes('#1/3'), 'W3 card summary shows queue rank & saturated scope');

			// Complete W1 -> W3 promotes to active in place, W4 shifts #2/3 -> #1/2, W5 shifts #3/3 -> #2/2 (zero DOM teardown!)
			const tokW1 = Object.values(rtAfterFanout.tokens).find(t => t.nodeId === 'W1' && t.status === 'active')!;
			const compW1 = await missionRuntime.completeToken(created.id, { tokenId: tokW1.id, summary: 'W1 done' });
			assert.strictEqual(compW1.ok, true, compW1.error);
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="W3"]'), cardW3Before, 'Promotion patches W3 card in place without DOM teardown');
			assert.strictEqual(cardW3Before.getAttribute('data-node-state'), 'active', 'W3 promoted from queued to active');
			assert.strictEqual(cardW3Before.getAttribute('data-node-queue-position'), null, 'W3 queue rank cleared upon activation');
			assert.strictEqual(cardW4Before.getAttribute('data-node-queue-position'), '1', 'W4 shifted up to #1/2');
			assert.strictEqual(cardW4Before.getAttribute('data-node-queue-total'), '2');
			assert.strictEqual(cardW5Before.getAttribute('data-node-queue-position'), '2', 'W5 shifted up to #2/2');
			assert.ok(host.querySelector<HTMLElement>('[data-ade-token-puck="W4"]')?.textContent?.includes('#1/2'));
			assert.ok(host.querySelector<HTMLElement>('[data-ade-token-puck="W5"]')?.textContent?.includes('#2/2'));

			// Raising concurrency limit dynamically drains W4 & W5 immediately to active!
			const raised = await missionRuntime.setConcurrencyLimits(created.id, { maxGlobal: 8, maxLocalHost: 4, maxPerCloudHost: 2, maxPerProvider: 8 });
			assert.strictEqual(raised.ok, true, raised.error);
			const rtAfterRaise = missionRuntime.getRuntimeState(created.id);
			assert.strictEqual(rtAfterRaise.nodeStates.W4, 'active');
			assert.strictEqual(rtAfterRaise.nodeStates.W5, 'active');
			assert.strictEqual(missionRuntime.getMissionStatus(created.id).queuedTokenCount, 0);
			assert.strictEqual(cardW4Before.getAttribute('data-node-state'), 'active');
			assert.strictEqual(cardW5Before.getAttribute('data-node-state'), 'active');
		});

		test('Audit #18: separates cold per-Mission files from lightweight hot index, migrates legacy v1 blob, and renders multi-run FinOps comparison ledger', async () => {
			setAdeDisplayLanguageOverride('en');
			store.add({ dispose: () => setAdeDisplayLanguageOverride(undefined) });

			const h = createHarness([alpha]);
			const storageService = h.instantiation.get(IStorageService);

			// 1. Seed a legacy single-key v1 blob and attach a cold-file backend stub
			const coldFiles = new Map<string, string>();
			const savedCalls: Array<{ missionId: string; writerId?: string }> = [];
			const onColdChange = store.add(new Emitter<{ readonly missionId: string; readonly updatedAt: number; readonly deleted?: boolean; readonly writerId?: string }>());
			h.instantiation.stub(IAdeEngineeringBackendService, upcastPartial<IAdeEngineeringBackendService>({
				onDidMissionRecordChange: onColdChange.event,
				loadInbox: async () => [],
				saveInbox: async () => undefined,
				loadMissionRecord: async id => coldFiles.get(id),
				loadAllMissionRecords: async () => Object.fromEntries(coldFiles.entries()),
				saveMissionRecord: async (id, json, updatedAt, writerId) => {
					coldFiles.set(id, json);
					savedCalls.push({ missionId: id, writerId });
					onColdChange.fire({ missionId: id, updatedAt, writerId });
				},
				deleteMissionRecord: async (id, writerId) => {
					coldFiles.delete(id);
					onColdChange.fire({ missionId: id, updatedAt: Date.now(), deleted: true, writerId });
				},
			}));
			storageService.store(ADE_MISSIONS_LEGACY_STORAGE_KEY, JSON.stringify([
				{
					id: 'legacy-m1',
					title: 'Legacy Migrated Mission',
					mermaidText: 'flowchart LR\n  A["Plan"] --> B["Ship"]',
					positions: { A: { x: 10, y: 20 } },
					ownerTier: -1,
					createdAt: 1_000,
					updatedAt: 2_000,
				},
			]), StorageScope.APPLICATION, StorageTarget.USER);

			const storeA = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			await storeA.whenHydrated();

			// Legacy single-key blob migrated to independent cold file and purged from globalState!
			assert.strictEqual(storeA.getMission('legacy-m1')?.title, 'Legacy Migrated Mission');
			assert.ok(coldFiles.has('legacy-m1'), 'Legacy mission migrated to its own cold file');
			assert.strictEqual(storageService.get(ADE_MISSIONS_LEGACY_STORAGE_KEY, StorageScope.APPLICATION), undefined, 'Legacy monolithic v1 blob removed after migration');

			// Creating & mutating Mission 2 only writes Mission 2's cold file (NEVER touches legacy-m1!)
			const m2 = storeA.createMission({
				id: 'cold-m2',
				title: 'Multi-Run Mission',
				mermaidText: 'flowchart LR\n  A["Analyze"] --> B["Build"]',
				projectUri: alpha.toString(),
			});
			const savesBefore = savedCalls.length;
			storeA.renameMission(m2.id, 'Multi-Run Tuned');
			const newlySaved = savedCalls.slice(savesBefore).map(c => c.missionId);
			assert.deepStrictEqual(newlySaved, ['cold-m2'], 'Mutating m2 only writes m2 cold file without touching legacy-m1');

			// Hot index in IStorageService contains ONLY lightweight metadata (ZERO Mermaid/tokens/traces!)
			const hotIndexRaw = storageService.get(ADE_MISSIONS_INDEX_STORAGE_KEY, StorageScope.APPLICATION)!;
			assert.ok(hotIndexRaw && !hotIndexRaw.includes('flowchart LR'), 'Hot index must NOT inline Mermaid DAG or heavy payloads');
			assert.strictEqual(storageService.get(`${ADE_MISSION_RECORD_STORAGE_PREFIX}${m2.id}`, StorageScope.APPLICATION), undefined, 'Cold payload lives on disk, not duplicated in IStorageService');

			// Window B hydrates from cold files and receives targeted single-Mission updates on change
			const storeB = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			await storeB.whenHydrated();
			assert.strictEqual(storeB.getMission(m2.id)?.title, 'Multi-Run Tuned');
			storeA.updateNodePrompt(m2.id, 'A', 'Use cached AST summary');
			await new Promise(resolve => setTimeout(resolve, 25));
			assert.strictEqual(storeB.getMission(m2.id)?.nodePrompts?.A, 'Use cached AST summary');

			// 2. FinOps Ledger UI renders archived multi-run history & comparison delta across re-runs
			h.instantiation.stub(IAdeMissionService, storeA);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);

			const runStart1 = await missionRuntime.start(m2.id);
			assert.strictEqual(runStart1.ok, true, runStart1.error);
			missionRuntime.recordNodeTurnUsage(m2.id, 'A', { inputTokens: 30_000, outputTokens: 15_000, totalTokens: 45_000, costUsd: 1.0, turns: 2, model: 'claude-opus-4-6', engineId: 'claude' });
			await missionRuntime.stop(m2.id);

			// Re-run #2 archives Run #1 ($1.00) and records cheaper Run #2 ($0.40)
			const runStart2 = await missionRuntime.start(m2.id);
			assert.strictEqual(runStart2.ok, true, runStart2.error);
			missionRuntime.recordNodeTurnUsage(m2.id, 'A', { inputTokens: 12_000, outputTokens: 6_000, totalTokens: 18_000, costUsd: 0.4, turns: 1, model: 'claude-sonnet-4-6', engineId: 'claude' });
			const rt2 = missionRuntime.getRuntimeState(m2.id);
			assert.strictEqual(rt2.runHistory?.length, 1, 'Run #1 archived in runHistory');
			assert.strictEqual(rt2.runHistory![0].totalCostUsd, 1.0);

			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, m2.id));
			const host = append(document.body, $('.monaco-workbench.ade-audit18-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			// Open FinOps Ledger tab via Node Inspector
			pane.focusNode('A', { inspectorTab: 'finops' });
			const historySection = host.querySelector<HTMLElement>('[data-ade-finops-run-history="true"]')!;
			assert.ok(historySection && !historySection.hidden, 'Run History & Multi-Run Comparison section is visible');
			const deltaBanner = host.querySelector<HTMLElement>('[data-ade-finops-run-delta="true"]')!;
			assert.ok(deltaBanner && !deltaBanner.hidden);
			assert.ok(deltaBanner.textContent?.includes('Run #2 vs Run #1'), `Expected Run #2 vs Run #1 delta, got: ${deltaBanner.textContent}`);
			assert.ok(deltaBanner.textContent?.includes('-$0.60 (-60%)'), `Expected -$0.60 (-60%) savings delta, got: ${deltaBanner.textContent}`);
			assert.ok(host.querySelector('[data-ade-finops-run-row="1"][data-selected-baseline="true"]'), 'Archived Run #1 selected as comparison baseline');
		});

		test('renders true per-model context windows on idle/active cards and lights up crimson rework noise segment on tool-error & review rejection turns (Audit #24)', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/gov-audit24') }, 'Gov Audit24', { role: 'governor' });
			const mission = missionStore.createMission({
				title: 'Context Window & Noise Audit24',
				ownerSessionId: gov.id,
				ownerTier: 1,
				projectUri: alpha.toString(),
				mermaidText: [
					'flowchart LR',
					'  N1["@DeepWorker: Code"] --> R1["@GeminiRev: Review"]',
				].join('\n'),
			});
			await missionRuntime.setBoundary(mission.id, {
				offGraphMaxTier: 1,
				supervisors: [{ id: gov.id, tier: 1, managedNodeIds: ['N1', 'R1'] }],
			});
			const rtInit = missionRuntime.getRuntimeState(mission.id);
			const n1AgentId = rtInit.boundary.nodeAssignments.N1?.agentId!;
			const r1AgentId = rtInit.boundary.nodeAssignments.R1?.agentId!;
			h.projects.updateAgentEnginePreferences(n1AgentId, { preferredEngineId: 'aexus-dsh', preferredModel: 'deepseek-r1' });
			h.projects.updateAgentEnginePreferences(r1AgentId, { preferredEngineId: 'aexus-antigravity', preferredModel: 'gemini-2.5-pro' });
			await missionRuntime.bindNodeHost(mission.id, 'R1', { roleKind: 'reviewer' });

			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, mission.id));
			const host = append(document.body, $('.monaco-workbench.ade-audit24-host'));
			host.style.width = '1360px';
			host.style.height = '820px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1360, 820));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			// 1. Idle cards display true per-model windows (64k for deepseek-r1, 1.0M for gemini-2.5-pro — NOT 200k!)
			const n1Card = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			const r1Card = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="R1"]')!;
			const n1CtxRow = n1Card.querySelector<HTMLElement>('.ade-mission-ctx-row')!;
			const r1CtxRow = r1Card.querySelector<HTMLElement>('.ade-mission-ctx-row')!;
			assert.strictEqual(n1CtxRow.getAttribute('data-node-context-max'), '64000');
			assert.strictEqual(n1Card.querySelector('.ade-mission-ctx-tokens')?.textContent, '0/64k');
			assert.strictEqual(r1CtxRow.getAttribute('data-node-context-max'), '1000000');
			assert.strictEqual(r1Card.querySelector('.ade-mission-ctx-tokens')?.textContent, '0/1.0M');

			// 2. Active 64k model hitting 58k tokens triggers critical severity (91%) instead of being masked at 29%
			await missionRuntime.start(mission.id);
			missionRuntime.recordNodeTurnUsage(mission.id, 'N1', {
				inputTokens: 42_000,
				outputTokens: 6_000,
				model: 'deepseek-r1',
				engineId: 'aexus-dsh',
			});
			assert.strictEqual(n1CtxRow.getAttribute('data-node-context-max'), '64000');
			assert.strictEqual(n1CtxRow.getAttribute('data-node-context-pct'), '75');
			assert.strictEqual(n1CtxRow.getAttribute('data-node-context-noise-pct'), '0');

			// 3. Tool-error turn (WITHOUT passing isNoiseTurn!) lights up the crimson noise segment on card & Inspector!
			missionRuntime.recordNodeTurnUsage(mission.id, 'N1', {
				inputTokens: 8_000,
				outputTokens: 2_000,
				hadToolError: true,
				toolErrorCount: 1,
				model: 'deepseek-r1',
				engineId: 'aexus-dsh',
			});
			assert.strictEqual(n1CtxRow.getAttribute('data-node-context-pct'), '91');
			assert.ok(n1CtxRow.classList.contains('severity-critical'), '64k model at 58k tokens must render critical severity');
			const cardNoisePct = Number(n1CtxRow.getAttribute('data-node-context-noise-pct'));
			assert.ok(cardNoisePct >= 15, `Expected crimson noise segment >=15%, got ${cardNoisePct}%`);
			const cardNoiseSeg = n1Card.querySelector<HTMLElement>('.ade-ctx-seg.seg-noise')!;
			assert.ok(Number.parseFloat(cardNoiseSeg.style.width) > 0, `Card crimson noise segment width must be > 0%, got ${cardNoiseSeg.style.width}`);

			// 4. Open Node Inspector -> Distill tab reflects real 64k window & crimson noise segment
			n1Card.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
			n1Card.dispatchEvent(new mainWindow.PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
			host.querySelector<HTMLButtonElement>('[data-ade-inspector-tab="distill"]')!.click();
			const distillBadge = host.querySelector<HTMLElement>('[data-ade-distill-context-max]')!;
			assert.strictEqual(distillBadge.getAttribute('data-ade-distill-context-max'), '64000');
			assert.ok(Number(distillBadge.getAttribute('data-ade-distill-noise-pct')) >= 15);
			const distillNoiseSeg = host.querySelector<HTMLElement>('.ade-mission-ni-thermal-track .ade-ctx-seg.seg-noise')!;
			assert.ok(Number.parseFloat(distillNoiseSeg.style.width) > 0, 'Inspector Distill tab crimson noise bar must be > 0%');

			// 5. Distill & Refresh clears crimson rework noise back to 0%
			await missionRuntime.distillNodeContext(mission.id, 'N1', { memo: 'Reset after tool error' });
			assert.strictEqual(n1CtxRow.getAttribute('data-node-context-noise-pct'), '0');
			assert.strictEqual(Number.parseFloat(cardNoiseSeg.style.width), 0);
		});

		test('Audit #19: attributes delayed turn usage accurately across multi-node @Employee reuse (zero fallback to first node) and isolates parallel & blocked @Employee sessions', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const dispatchedCalls: Array<{
				readonly resource: string;
				readonly agentId?: string;
				readonly missionId?: string;
				readonly nodeId?: string;
				readonly tokenId?: string;
				readonly turnId?: string;
				readonly resolve: (res?: { readonly reply?: string; readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number; readonly turns?: number } }) => void;
			}> = [];
			h.instantiation.stub(ICommandService, {
				onWillExecuteCommand: Event.None,
				onDidExecuteCommand: Event.None,
				executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
					if (id === 'aexus.agentEngines.dispatchEngineeringTurn') {
						const opts = args[2] as {
							readonly agentId?: string;
							readonly missionId?: string;
							readonly nodeId?: string;
							readonly tokenId?: string;
							readonly turnId?: string;
						} | undefined;
						return await new Promise<T>(resolve => {
							dispatchedCalls.push({
								resource: String(args[0] ?? ''),
								agentId: opts?.agentId,
								missionId: opts?.missionId,
								nodeId: opts?.nodeId,
								tokenId: opts?.tokenId,
								turnId: opts?.turnId,
								resolve: res => resolve(res as T),
							});
						});
					}
					return undefined as T;
				},
			});

			const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/gov-audit19') }, 'Gov Audit19', { role: 'governor' });

			// ── Part A: Sequential multi-node @Alice reuse & delayed billing attribution ──
			const seqMission = missionStore.createMission({
				title: 'Reused Employee Billing Audit19',
				ownerSessionId: gov.id,
				ownerTier: 1,
				projectUri: alpha.toString(),
				mermaidText: [
					'flowchart LR',
					'  N1["@Alice: Spec"] --> N2["@Alice: Implement"]',
					'  N2 --> N3["@Alice: Polish"]',
				].join('\n'),
			});
			await missionRuntime.setBoundary(seqMission.id, {
				offGraphMaxTier: 1,
				supervisors: [{ id: gov.id, tier: 1, managedNodeIds: ['N1', 'N2', 'N3'] }],
			});
			const aliceAgentId = missionRuntime.getRuntimeState(seqMission.id).boundary.nodeAssignments.N1?.agentId!;
			const aliceSessionUri = URI.parse('aexus-claude:/alice-audit19');
			h.projects.bindSession(aliceAgentId, { engineId: 'aexus-claude', resource: aliceSessionUri });

			await missionRuntime.start(seqMission.id);
			await timeout(10);
			assert.strictEqual(dispatchedCalls.length, 1);
			const turn1 = dispatchedCalls[0];
			assert.strictEqual(turn1.nodeId, 'N1');
			assert.ok(turn1.turnId && turn1.tokenId, 'Dispatch binds immutable turnId and tokenId');

			// Employee completes N1 mid-turn (releasing N1 and activating N2) BEFORE Turn 1 finishes!
			await missionRuntime.completeToken(seqMission.id, { tokenId: turn1.tokenId!, summary: 'Spec done' });
			await timeout(10);
			// Even though N2 is now active in engine state, Turn 2 MUST wait in per-agent queue until Turn 1 finishes
			assert.strictEqual(dispatchedCalls.length, 1, 'Turn 2 waits for in-flight Turn 1 to finish');

			// Delayed interim usage arriving via sessionResource (NO turnId) while Turn 1 is still in flight lands on N1 (NOT N2!)
			missionRuntime.recordTurnUsageBySessionResource(aliceSessionUri.toString(), {
				inputTokens: 4_000,
				outputTokens: 1_000,
				costUsd: 0.11,
				turns: 0,
			});
			assert.strictEqual(missionRuntime.getRuntimeState(seqMission.id).nodeTelemetry?.N1?.costUsd, 0.11);
			assert.strictEqual(missionRuntime.getRuntimeState(seqMission.id).nodeTelemetry?.N2, undefined);

			// Finish Turn 1 -> records final Turn 1 usage to N1 BEFORE releasing slot to flush Turn 2 on N2!
			turn1.resolve({ reply: 'Spec finished', usage: { inputTokens: 2_000, outputTokens: 500, costUsd: 0.09, turns: 1 } });
			await timeout(15);
			assert.strictEqual(missionRuntime.getRuntimeState(seqMission.id).nodeTelemetry?.N1?.costUsd, 0.2);
			assert.strictEqual(dispatchedCalls.length, 2, 'Turn 2 flushes cleanly onto N2 after Turn 1 settles');
			const turn2 = dispatchedCalls[1];
			assert.strictEqual(turn2.nodeId, 'N2');
			assert.ok(turn2.turnId && turn2.turnId !== turn1.turnId);

			// Late callback carrying Turn 1's immutable turnId STILL bills N1 even while N2 is running!
			missionRuntime.recordTurnUsageBySessionResource(aliceSessionUri.toString(), {
				inputTokens: 1_000,
				outputTokens: 200,
				costUsd: 0.05,
				turns: 0,
			}, { turnId: turn1.turnId });
			assert.strictEqual(missionRuntime.getRuntimeState(seqMission.id).nodeTelemetry?.N1?.costUsd, 0.25);
			assert.strictEqual(missionRuntime.getRuntimeState(seqMission.id).nodeTelemetry?.N2, undefined);

			// Complete N2, finish Turn 2 -> dispatches N3
			await missionRuntime.completeToken(seqMission.id, { tokenId: turn2.tokenId!, summary: 'Impl done' });
			turn2.resolve({ reply: 'Impl done', usage: { inputTokens: 8_000, outputTokens: 2_000, costUsd: 0.4, turns: 1 } });
			await timeout(15);
			assert.strictEqual(missionRuntime.getRuntimeState(seqMission.id).nodeTelemetry?.N2?.costUsd, 0.4);
			assert.strictEqual(dispatchedCalls.length, 3);
			const turn3 = dispatchedCalls[2];
			assert.strictEqual(turn3.nodeId, 'N3');

			// Interactive turn binding on N3: beginInteractiveTurn -> complete N3 (Mission becomes 'completed') -> delayed usage bills N3, NEVER N1!
			const interactiveBinding = missionRuntime.beginInteractiveTurn!(aliceSessionUri.toString());
			assert.strictEqual(interactiveBinding?.nodeId, 'N3');
			await missionRuntime.completeToken(seqMission.id, { tokenId: turn3.tokenId!, summary: 'Polish done' });
			turn3.resolve({ reply: 'Polish done', usage: { inputTokens: 3_000, outputTokens: 800, costUsd: 0.15, turns: 1 } });
			await timeout(15);
			assert.strictEqual(missionRuntime.getRuntimeState(seqMission.id).status, 'completed');

			// Delayed interactive callback with turnId after Mission completed -> bills N3 accurately!
			missionRuntime.recordTurnUsageBySessionResource(aliceSessionUri.toString(), {
				inputTokens: 2_000,
				outputTokens: 600,
				costUsd: 0.35,
				turns: 1,
			}, { turnId: interactiveBinding!.turnId });
			missionRuntime.endInteractiveTurn!(interactiveBinding!.turnId);

			// Delayed legacy callback WITHOUT turnId arriving 50ms after N3 completed -> STILL bills N3 (NEVER falls back to N1 = assignedNodes[0]!)
			missionRuntime.recordTurnUsageBySessionResource(aliceSessionUri.toString(), {
				inputTokens: 1_500,
				outputTokens: 500,
				costUsd: 0.2,
				turns: 0,
			});
			const finalSeqRt = missionRuntime.getRuntimeState(seqMission.id);
			assert.strictEqual(finalSeqRt.nodeTelemetry?.N1?.costUsd, 0.25, 'N1 must NEVER absorb delayed bills from N2 or N3');
			assert.strictEqual(finalSeqRt.nodeTelemetry?.N2?.costUsd, 0.4, 'N2 keeps exact N2 spend');
			assert.strictEqual(finalSeqRt.nodeTelemetry?.N3?.costUsd, 0.7, 'N3 absorbs all N3 turns & delayed callbacks ($0.15 + $0.35 + $0.20)');

			// ── Part B: Parallel & Blocked @Employee Exclusive Queueing + Canvas UI ──
			const parMission = missionStore.createMission({
				title: 'Parallel Reuse Isolation Audit19',
				ownerSessionId: gov.id,
				ownerTier: 1,
				projectUri: alpha.toString(),
				mermaidText: [
					'flowchart LR',
					'  S["@Lead: Split"] --> A["@Alice: Backend"]',
					'  S --> B["@Alice: Frontend"]',
					'  A --> J["@Lead: Join"]',
					'  B --> J',
				].join('\n'),
			});
			await missionRuntime.setBoundary(parMission.id, {
				offGraphMaxTier: 1,
				supervisors: [{ id: gov.id, tier: 1, managedNodeIds: ['S', 'A', 'B', 'J'] }],
			});
			for (const emp of missionStore.getGeneratedEmployees(parMission.id)) {
				h.projects.bindSession(emp.id, { engineId: 'aexus-claude', resource: URI.parse(`aexus-claude:/${emp.id}`) });
			}

			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, parMission.id));
			const host = append(document.body, $('.monaco-workbench.ade-audit19-host'));
			host.style.width = '1360px';
			host.style.height = '820px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1360, 820));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			const dispatchesBeforePar = dispatchedCalls.length;
			await missionRuntime.start(parMission.id);
			await timeout(10);
			const sTok = Object.values(missionRuntime.getRuntimeState(parMission.id).tokens).find(t => t.nodeId === 'S' && t.status === 'active')!;
			await missionRuntime.completeToken(parMission.id, { tokenId: sTok.id, summary: 'Forked' });
			dispatchedCalls[dispatchesBeforePar]?.resolve({ reply: 'Split done' });
			await timeout(15);

			// Only Branch A is dispatched & active; Branch B is queued with data-node-queue-reason="employee"
			const parRt1 = missionRuntime.getRuntimeState(parMission.id);
			const tokA = Object.values(parRt1.tokens).find(t => t.nodeId === 'A')!;
			const tokB = Object.values(parRt1.tokens).find(t => t.nodeId === 'B')!;
			assert.strictEqual(tokA.status, 'active');
			assert.strictEqual(tokB.status, 'queued');
			assert.strictEqual(tokB.queued?.blockedBy, 'employee');
			assert.strictEqual(
				dispatchedCalls.slice(dispatchesBeforePar).filter(d => d.nodeId === 'B').length,
				0,
				'Branch B must NOT dispatch onto @Alice session while Branch A is active',
			);
			const cardB = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="B"]')!;
			assert.strictEqual(cardB.getAttribute('data-node-queue-reason'), 'employee');
			assert.ok(cardB.querySelector('.ade-mission-core-context')?.textContent?.includes('@Alice'), 'Queued card explains waiting on @Alice');

			// Block Branch A -> Branch B MUST stay queued & NOT contaminate @Alice's suspended session!
			// Also verify beginInteractiveTurn binds accurately to blocked Branch A while it is suspended.
			await missionRuntime.blockToken(parMission.id, { tokenId: tokA.id, reason: 'Waiting for build artifact', maxDuration: '30m', watchFile: '/tmp/a.out' });
			dispatchedCalls.find(d => d.missionId === parMission.id && d.nodeId === 'A')?.resolve({ reply: 'Blocked on build' });
			await timeout(15);
			const parAliceId = missionRuntime.getRuntimeState(parMission.id).boundary.nodeAssignments.A?.agentId!;
			const blockedInteractive = missionRuntime.beginInteractiveTurn!(parAliceId);
			assert.strictEqual(blockedInteractive?.nodeId, 'A', 'Interactive turn while Branch A is blocked binds to Branch A');
			missionRuntime.endInteractiveTurn!(blockedInteractive!.turnId);
			assert.strictEqual(missionRuntime.getRuntimeState(parMission.id).tokens[tokB.id].status, 'queued', 'Branch B stays queued while Branch A is blocked');
			assert.strictEqual(
				dispatchedCalls.slice(dispatchesBeforePar).filter(d => d.nodeId === 'B').length,
				0,
				'Branch B must NOT hijack @Alice session during Branch A blocked wait',
			);

			// Complete Branch A -> Branch B immediately promotes from queued -> active and dispatches!
			await missionRuntime.completeToken(parMission.id, { tokenId: tokA.id, summary: 'Backend ready' });
			await timeout(15);
			assert.strictEqual(missionRuntime.getRuntimeState(parMission.id).tokens[tokB.id].status, 'active');
			assert.strictEqual(
				dispatchedCalls.slice(dispatchesBeforePar).filter(d => d.nodeId === 'B').length,
				1,
				'Branch B dispatches cleanly once Branch A finishes and releases @Alice',
			);
			for (const call of dispatchedCalls) {
				call.resolve({ reply: 'cleanup' });
			}
		});

		test('patches Mission node bottom-left engine pill SVG icon in place once extensions register (never stuck on Codicon.hubot)', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const onEnginesChanged = store.add(new Emitter<void>());
			let agyIcon: URI | undefined = undefined;
			const darkAgySvg = URI.file('/ext/aexus-agents/resources/antigravity-dark.svg');
			const lightAgySvg = URI.file('/ext/aexus-agents/resources/antigravity-light.svg');
			h.instantiation.stub(IAdeSessionsService, upcastPartial<IAdeSessionsService>({
				onDidChangeEngines: onEnginesChanged.event,
				getIcon: (engineId: string) => engineId === 'aexus-antigravity' ? agyIcon : undefined,
				getEngineName: (engineId: string) => engineId === 'aexus-antigravity' ? 'Google Antigravity' : engineId,
				getEngines: async () => agyIcon
					? [{ id: 'aexus-antigravity', name: 'Google Antigravity', description: 'Antigravity', icon: agyIcon }]
					: [],
			}));

			const mission = missionStore.createMission({
				title: 'Engine Icon Hot Patch',
				projectUri: alpha.toString(),
				mermaidText: 'flowchart LR\n  N1["@Lead: Review"]',
			});
			const n1AgentId = missionRuntime.getRuntimeState(mission.id).boundary.nodeAssignments.N1?.agentId!;
			h.projects.updateAgentEnginePreferences(n1AgentId, { preferredEngineId: 'aexus-antigravity', preferredModel: 'gemini-2.5-pro' });

			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, mission.id));
			const host = append(document.body, $('.monaco-workbench.ade-engine-icon-patch-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			const n1CardBefore = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			const iconElBefore = n1CardBefore.querySelector<HTMLElement>('.ade-mission-engine-pill .ade-mission-engine-icon')!;
			assert.ok(iconElBefore.classList.contains('codicon-hubot'), 'Initial pre-registration fallback renders hubot');

			// Extension finishes registering -> onDidChangeEngines fires -> icon upgrades in place from hubot to antigravity-dark.svg!
			agyIcon = darkAgySvg;
			onEnginesChanged.fire();
			const n1CardAfter = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="N1"]')!;
			const iconElAfter = n1CardAfter.querySelector<HTMLElement>('.ade-mission-engine-pill .ade-mission-engine-icon')!;
			assert.strictEqual(n1CardAfter, n1CardBefore, 'Icon upgrade patches in place without rebuilding node DOM');
			assert.ok(!iconElAfter.classList.contains('codicon-hubot'), 'Hubot fallback must be cleared once brand SVG is registered');
...[truncated for diff preview]
