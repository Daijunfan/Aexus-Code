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
import { DEFAULT_ADE_ORGANIZATION_CONFIG, IAdeOrganizationConfig } from '../../../../../platform/ade/common/adeRoleSchema.js';
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
import { AdeEngineeringEditorInput, AdeEngineeringEditorPane, AdeEngineeringEditorSerializer, AdePageVisibilityAnimationGuard } from '../../browser/adeEngineeringEditorPane.js';
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
import { ADE_CHANGES_VIEW_ID, ADE_FILES_VIEW_ID, ADE_OPEN_CONFIG_COMMAND_ID, ADE_PROJECTS_VIEW_ID, ADE_SECRETARY_ID, encodeAdeEngineeringInputSpec, IAdeAgent, IAdeEditorService, IAdeProjectsService, IAdeSession } from '../../common/ade.js';
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
		const unboundGov = h.projects.addProject(alpha, 'Planned Chief');
		h.projects.setAgentRole(unboundGov.id, 'governor');
		const inheritedChild = h.projects.addAgent(gov.id, 'Inherited Sub', 'manager');
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
		const plannedRow = findRow('Planned Chief');
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
			genericLinuxUsesTuxNotTerminal: Boolean(
				cloudRow.querySelector('.ade-tree-item-icon-os svg circle[fill="#F5C211"]')
				&& !cloudRow.querySelector('.ade-tree-item-icon-os svg rect[fill="#26354d"]'),
			),
			plannedChiefUsesRankBadgeNotComment: Boolean(
				plannedRow.querySelector('.ade-tree-item-icon.ade-tree-item-icon-draft.role-color-amber.codicon-organization')
				&& !plannedRow.querySelector('.ade-tree-item-icon.codicon-comment')
				&& !plannedRow.querySelector('.ade-tree-item-icon.codicon-comment-discussion'),
			),
			addAgentInheritsParentEngine: inheritedChild.preferredEngineId === 'aexus-claude',
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
			govWorktreeText: 'Engineering',
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
			genericLinuxUsesTuxNotTerminal: true,
			plannedChiefUsesRankBadgeNotComment: true,
			addAgentInheritsParentEngine: true,
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
			qaCompiledReadOnlyPrompt: (qaPrompt.includes('Audit diffs for Alpha under Chief Tech Officer (CTO).')
				|| (qaPrompt.includes('Audit diffs for Alpha under CTO (CTO).') && qaPrompt.includes('Supervisor: Chief Tech Officer')))
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

		// Single-copy docs paths display sibling ranks/, engineering/, and mission/MISSION_API.md
		const ranksDocEl = configRoot.querySelector<HTMLElement>('[data-ade-docs-ranks]');
		const engDocEl = configRoot.querySelector<HTMLElement>('[data-ade-docs-engineering]');
		const missionDocEl = configRoot.querySelector<HTMLElement>('[data-ade-docs-mission]');
		assert.ok(ranksDocEl?.textContent?.endsWith('/docs/ranks'), 'Docs card displays ranks/ directory');
		assert.ok(engDocEl?.textContent?.endsWith('/docs/engineering'), 'Docs card displays sibling engineering/ directory');
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

		const missionDocs = await h.control<{
			readonly missionDoc: string;
			readonly ranksDir: string;
			readonly engineeringDir?: string;
			readonly engineeringParadigmDoc?: string;
			readonly engineeringApiDoc?: string;
		}>('mission.docs', {});
		assert.ok(missionDocs.missionDoc.endsWith('/docs/mission/MISSION_API.md'));
		assert.ok(missionDocs.ranksDir.endsWith('/docs/ranks'));
		assert.ok(missionDocs.engineeringDir?.endsWith('/docs/engineering'));
		assert.ok(missionDocs.engineeringParadigmDoc?.endsWith('/docs/engineering/ENGINEERING_PARADIGM.md'));
		assert.ok(missionDocs.engineeringApiDoc?.endsWith('/docs/engineering/ENGINEERING_API.md'));

		await h.control('rank.setCount', { count: 1 });
		const oneTier = await h.control<{ readonly rankCount: number; readonly namesByTier: Record<string, string> }>('rank.names', {});
		assert.strictEqual(oneTier.rankCount, 1);
		assert.deepStrictEqual(oneTier.namesByTier, { 'L-1': 'User', L0: 'Secretary', L1: 'Governor' });
		// Stepper decrement is disabled at min count 1
		assert.strictEqual(configRoot.querySelector<HTMLButtonElement>('button[data-ade-rank-dec]')?.disabled, true);

		// Test Engineering alias customization (Engineering -> Research -> Engineering) & dual-view tab titles
		const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
		h.instantiation.stub(IAdeMissionService, missionStore);
		const missionAliasInput = configRoot.querySelector<HTMLInputElement>('input[data-ade-mission-alias-input="true"]')!;
		assert.strictEqual(missionAliasInput.value, 'Engineering');
		missionAliasInput.value = 'Research';
		missionAliasInput.dispatchEvent(new missionAliasInput.ownerDocument.defaultView!.Event('input'));
		configRoot.querySelector<HTMLButtonElement>('button[data-ade-config-save]')!.click();
		await new Promise(resolve => setTimeout(resolve, 10));

		const renamedMissionNames = await h.control<{ readonly missionName: string }>('rank.names', {});
		assert.strictEqual(renamedMissionNames.missionName, 'Research');

		const createdMission = missionStore.createMission({ title: 'Core Release', mermaidText: '' });
		const missionInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(createdMission.id, 'mission')));
		const orchInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(createdMission.id, 'orchestration')));
		assert.strictEqual(missionInput.getName(), 'Core Release · Mission');
		assert.strictEqual(orchInput.getName(), 'Core Release · Orchestration');

		// Reset Engineering alias back to default Engineering
		await h.control('mission.renameAlias', { alias: 'Engineering' });
		const resetMissionNames = await h.control<{ readonly missionName: string }>('rank.names', {});
		assert.strictEqual(resetMissionNames.missionName, 'Engineering');

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

		// Pure Task DAG Mission canvas renders all 5 task/gate nodes cleanly with strictly 1 top-left button
		const mockGroup = upcastPartial<IEditorGroup>({ id: 1 });
		const canvasHost = append(document.body, $('.monaco-workbench.ade-reuse-canvas-test'));
		store.add({ dispose: () => canvasHost.remove() });
		const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, mockGroup));
		pane.create(canvasHost);
		const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(created.id, 'mission')));
		await pane.setInput(input, undefined, {}, CancellationToken.None);

		assert.strictEqual(canvasHost.querySelectorAll('.ade-mission-node').length, 5, 'Mission Task DAG renders all 5 task nodes cleanly');
		assert.strictEqual(canvasHost.querySelectorAll('[data-ade-mission-top-bar="true"] > *').length, 1, 'Minimalist Mission canvas keeps strictly 1 top-left button');
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

			// 2. docs.read -> single-copy sibling common / L0 / engineering / paradigm / engineering-api / mission documents
			for (const target of ['common', 'L0', 'engineering', 'paradigm', 'engineering-api', 'mission'] as const) {
				const doc = await h.control<{ readonly ok: boolean; readonly content: string }>('docs.read', { target });
				assert.strictEqual(doc.ok, true, `docs.read ${target} succeeds`);
				assert.ok(doc.content.length > 0, `docs.read ${target} returns non-empty content`);
			}

			// 3. whoami -> numeric tier / tierTag / factory side / Mission & node identity / sibling lazy docs entry
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
			assert.ok(
				me.docsEntry?.common
				&& me.docsEntry?.selfRank
				&& me.docsEntry?.engineeringParadigm
				&& me.docsEntry?.engineeringApi
				&& me.docsEntry?.mission
				&& me.docsEntry?.engineeringDir
				&& me.docsEntry?.update,
				'whoami exposes sibling Native Rank + Engineering docs entry map',
			);
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
			assert.ok(prompt!.includes('aexus-ade docs read L3'), 'Prompt points at native rank doc');
			assert.ok(prompt!.includes('aexus-ade docs read engineering'), 'Prompt points at sibling Engineering paradigm doc');
			assert.ok(prompt!.includes('aexus-ade api update'), 'Prompt points at api update');
			assert.ok(prompt!.length < 900, `In-graph prompt stays concise (was ${prompt!.length} chars)`);
			assert.ok(!prompt!.includes('N2'), 'Prompt is scoped to the employee node, not the whole DAG');
		});

		test('compiles Dual-Context Engineering init prompts (Native Rank + Engineering Paradigm) for Orchestration staff across tiers', async () => {
			const { h, roleSchema, missionRuntime } = createMissionHarness();
			const govOwner = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/dual-ctx-gov') }, 'VP Gov', { role: 'governor' });
			const created = await h.control<{ readonly id: string }>('mission.init', {
				owner: govOwner.id,
				title: 'Dual Context Engineering',
				mermaid: 'flowchart LR\n  T1["Build API"] --> T2["Verify"]',
			});

			const orchMermaid = [
				'flowchart LR',
				'  subgraph Backend ["Backend"]',
				'    G1["VP Gov"]',
				'    M1["Backend Lead"]',
				'    W1["Leaf Coder"]',
				'  end',
				'  G1 --> M1',
				'  M1 --> W1',
				'  %% staff G1 [tier=1, rank=governor, dept=Backend]',
				'  %% staff M1 [tier=2, rank=manager, dept=Backend]',
				'  %% staff W1 [tier=4, rank=worker, dept=Backend]',
			].join('\n');
			const applied = await h.control<{ readonly ok: boolean; readonly nodeAgentIds: Readonly<Record<string, string>> }>('orchestration.apply', {
				mission: created.id,
				text: orchMermaid,
			});
			assert.strictEqual(applied.ok, true);
			const govAgentId = applied.nodeAgentIds.G1;
			const mgrAgentId = applied.nodeAgentIds.M1;
			const wrkAgentId = applied.nodeAgentIds.W1;
			assert.ok(govAgentId && mgrAgentId && wrkAgentId, 'All three Orchestration staff nodes bind real agents');

			const govAgent = h.projects.getAgent(govAgentId)!;
			const mgrAgent = h.projects.getAgent(mgrAgentId)!;
			const wrkAgent = h.projects.getAgent(wrkAgentId)!;
			const standaloneWrk = h.projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/standalone-wrk') }, 'Standalone Worker', { role: 'worker' });

			const docsPaths = roleSchema.getDocsPaths();
			const mgrPrompt = buildAdeAgentRoleContext(h.projects, undefined, mgrAgent, roleSchema.getConfig(), docsPaths, missionRuntime)!;
			assert.ok(mgrPrompt.includes('[Aexus Orchestrated Role Context]'), 'Orchestrated staff on Orchestration keeps full Native Rank context (not short-circuited)');
			assert.ok(mgrPrompt.includes('Tier: L2'), 'L2 manager sees numeric tier');
			assert.ok(mgrPrompt.includes('docs/ranks/L2.md') && mgrPrompt.includes('aexus-ade docs read L2'), 'L2 manager gets Native Rank CLI doc pointer');
			assert.ok(mgrPrompt.includes('docs/engineering/ENGINEERING_PARADIGM.md') && mgrPrompt.includes('aexus-ade docs read engineering'), 'L2 manager gets Engineering Paradigm doc pointer');
			assert.ok(mgrPrompt.includes('docs/engineering/ENGINEERING_API.md') && mgrPrompt.includes('aexus-ade docs read engineering-api'), 'L2 manager gets Engineering CLI Cookbook pointer');
			assert.ok(mgrPrompt.includes('Engineering Dual-View Working Paradigm & Token Rules'), 'L2 manager gets inline Engineering paradigm summary');
			assert.ok(mgrPrompt.includes('Native Rank API Coexistence'), 'L2 manager gets coexistence etiquette for native org.*/session.* APIs');
			assert.ok(mgrPrompt.includes('aexus-ade token mint|split'), 'L2 manager gets downward token mint/split guidance');
			assert.ok(mgrPrompt.includes('department: Backend'), 'L2 manager sees bound department');
			assert.ok(!mgrPrompt.includes('per-node Pre-Prompts'), 'Zero legacy pre-prompt boilerplate');

			const govPrompt = buildAdeAgentRoleContext(h.projects, undefined, govAgent, roleSchema.getConfig(), docsPaths, missionRuntime)!;
			assert.ok(govPrompt.includes('docs/ranks/L1.md') && govPrompt.includes('docs/engineering/ENGINEERING_PARADIGM.md'));

			const wrkPrompt = buildAdeAgentRoleContext(h.projects, undefined, wrkAgent, roleSchema.getConfig(), docsPaths, missionRuntime)!;
			assert.ok(wrkPrompt.includes('[Aexus ADE · Engineering Staff Context]'), 'Pure leaf worker inside Engineering gets concise Engineering Staff context');
			assert.ok(wrkPrompt.includes('aexus-ade docs read L4'), 'Leaf worker gets its Native Rank doc pointer');
			assert.ok(wrkPrompt.includes('aexus-ade docs read engineering'), 'Leaf worker gets Engineering Paradigm doc pointer');
			assert.ok(wrkPrompt.includes('token return') && wrkPrompt.includes('whiteboard read|write'), 'Leaf worker gets permitted token & whiteboard commands');
			assert.ok(!wrkPrompt.includes('session subordinates'), 'Leaf worker gets zero management APIs');

			const standaloneWrkPrompt = buildAdeAgentRoleContext(h.projects, undefined, standaloneWrk, roleSchema.getConfig(), docsPaths, missionRuntime);
			assert.strictEqual(standaloneWrkPrompt, undefined, 'Pure leaf worker outside Engineering stays 100% clean (undefined)');

			const whoamiMgr = await h.control<{ readonly isOrchestrationStaff?: boolean; readonly department?: string; readonly docsEntry?: Record<string, string> }>('whoami', {
				caller: 'manager',
				_verifiedCaller: true,
				_callerSessionId: mgrAgent.id,
			});
			assert.strictEqual(whoamiMgr.isOrchestrationStaff, true);
			assert.strictEqual(whoamiMgr.department, 'Backend');
			assert.strictEqual(whoamiMgr.docsEntry?.selfRank, 'aexus-ade docs read L2');
			assert.strictEqual(whoamiMgr.docsEntry?.engineeringParadigm, 'aexus-ade docs read engineering');

			// Verify System Message Provenance Envelopes across all 3 channels:
			// 1) Human User (L-1) session.send -> [Aexus System · Message from User (L-1)]
			const sentStart = h.sentChatRequests.length;
			h.projects.bindSession(mgrAgent.id, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/env-mgr-live') });
			await h.control('session.send', { id: mgrAgent.id, message: 'User checking status' });
			const userSentMsg = h.sentChatRequests[sentStart]?.message ?? '';
			assert.ok(userSentMsg.startsWith('[Aexus System · Message from User (L-1)]'), `Expected User envelope, got: ${userSentMsg}`);
			assert.ok(userSentMsg.includes('User checking status'));

			// 2) Superior Role (L1 Governor) session.send -> [Aexus System · Direct Message from Role]
			const subOfGov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/env-sub-mgr') }, 'Direct Sub Mgr', { parentId: govOwner.id, role: 'manager' });
			const sentRoleIdx = h.sentChatRequests.length;
			await h.control('session.send', {
				id: subOfGov.id,
				message: 'Prioritize auth migration',
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: govOwner.id,
			});
			const roleSentMsg = h.sentChatRequests[sentRoleIdx]?.message ?? '';
			assert.ok(roleSentMsg.startsWith('[Aexus System · Direct Message from Role]'), `Expected Role DM envelope, got: ${roleSentMsg}`);
			assert.ok(roleSentMsg.includes('Tier L1 · Governor'));
			assert.ok(roleSentMsg.includes('Prioritize auth migration'));

			// 3) Standalone Pure Worker outside Engineering stays 100% clean (no envelope injection on session.send)
			const sentPureIdx = h.sentChatRequests.length;
			await h.control('session.send', { id: standaloneWrk.id, message: 'Run pytest' });
			assert.strictEqual(h.sentChatRequests[sentPureIdx]?.message, 'Run pytest', 'Standalone pure worker receives clean bare prompt');

			// 4) Engineering Baton Token dispatch -> [Aexus System · Baton Token]
			const dispatchesBefore = h.executedCommands.filter(c => c.id === 'aexus.agentEngines.dispatchEngineeringTurn').length;
			await h.control('orchestration.dispatch', { mission: created.id, prompt: 'Implement OAuth2 flow' });
			const tokenDispatch = h.executedCommands.filter(c => c.id === 'aexus.agentEngines.dispatchEngineeringTurn')[dispatchesBefore];
			const tokenPrompt = String(tokenDispatch?.args?.[1] ?? '');
			assert.ok(tokenPrompt.startsWith('[Aexus System · Baton Token]'), `Expected Baton Token envelope, got: ${tokenPrompt.slice(0, 120)}`);
			assert.ok(tokenPrompt.includes('System-Validated Engineering Baton Token'));
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

		test('supports case-insensitive model classification, proxy-prefix stripping, deduplication, and Other fallback', () => {
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

			// 1. Unrelated sidebar chat session mutations leave active Engineering canvas DOM completely untouched!
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

		test('FinOps pricing catalog & budget breaker work on non-Claude engines and honor custom & local zero-cost settings overrides', async () => {
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

			await missionRuntime.setBudgetLimit(created.id, 2.00);
			await missionRuntime.start(created.id);

			// 1. Local zero-cost override (`my-local-vllm/qwen3-32b`) reports huge tokens with $0.00 spend
			missionRuntime.recordNodeTurnUsage(created.id, 'N2', {
				inputTokens: 1_500_000,
				outputTokens: 300_000,
				model: 'my-local-vllm/qwen3-32b',
				engineId: 'aexus-opencode',
			});
			const n2Tel = missionRuntime.getRuntimeState(created.id).nodeTelemetry?.N2;
			assert.strictEqual(n2Tel?.costUsd, 0);
			assert.strictEqual(n2Tel?.costLocalFree, true);
			assert.strictEqual(missionRuntime.getRuntimeState(created.id).budgetCircuitTripped, false, 'Local zero-cost tokens never trip USD budget');

			// 2. Non-Claude Codex node (`gpt-5.3-codex`) omits costUsd -> auto-estimated ~$1.05 (200k in * 1.75 + 50k out * 14 = $1.05)
			missionRuntime.recordNodeTurnUsage(created.id, 'N1', {
				inputTokens: 200_000,
				outputTokens: 50_000,
				model: 'gpt-5.3-codex',
				engineId: 'aexus-codex',
			});
			const n1Tel = missionRuntime.getRuntimeState(created.id).nodeTelemetry?.N1;
			assert.strictEqual(n1Tel?.costEstimated, true);
			assert.ok(Math.abs((n1Tel?.costUsd ?? 0) - 1.05) < 0.01);

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
			rootEl.focus();

			// 1. Double-click edge on canvas to inline-edit edge label + Cmd+Z / Cmd+Shift+Z Undo/Redo
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

			// Cmd+Z undoes edge label edit; Cmd+Shift+Z redoes it
			rootEl.focus();
			mainWindow.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
			assert.strictEqual(
				host.querySelector<SVGGElement>('.ade-mission-edge-group[data-from="N1"][data-to="N2"]')?.getAttribute('data-edge-kind'),
				'success',
				'Cmd+Z restores previous edge label & polarity',
			);
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

		test('Audit #8: enforces pure EN / pure ZH-CN localization with zero mixed lines across all Engineering dual-view & workbench surfaces and unifies dynamic 1..N all-staff rank schema', async () => {
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

				// --- A. Engineering Mission & Orchestration Minimalist Top Bar + Drawers (EN vs ZH-CN) ---
				const created = missionStore.createMission({
					projectUri: alpha.toString(),
					title: 'Audit 8 Localization Engineering',
					mermaidText: 'flowchart LR\n  T1["Build API"] --> T2["Ship UI"]',
					orchestrationText: 'flowchart TD\n  CEO["@Alice (L1)"] <--> Lead["@Bob (L2)"]',
				});
				const mInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(created.id, 'mission')));
				const mHost = append(document.body, $('.monaco-workbench.ade-audit8-mission-host'));
				mHost.style.width = '1280px';
				mHost.style.height = '760px';
				store.add({ dispose: () => mHost.remove() });
				const mPane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
				mPane.create(mHost);
				mPane.layout(new Dimension(1280, 760));
				await mPane.setInput(mInput, undefined, {}, CancellationToken.None);

				// Open Mission 2-pane Drawer
				mHost.querySelector<HTMLButtonElement>('[data-ade-mission-file-btn="true"]')!.click();
				const topBar = mHost.querySelector<HTMLElement>('[data-ade-mission-top-bar="true"]')!;
				const drawer = mHost.querySelector<HTMLElement>('[data-ade-mission-drawer="true"]')!;
				assert.strictEqual(drawer.hidden, false);

				// 1. Pure EN verification: strictly 1 top-left button + ZERO CJK anywhere in Top Bar & 2-pane Mission Drawer!
				assert.strictEqual(topBar.children.length, 1, 'Minimalist Engineering top bar keeps strictly ONE top-left button');
				assert.strictEqual(cjkRe.test(topBar.textContent ?? ''), false, `Top bar must have 0 CJK in EN mode (got: "${topBar.textContent}")`);
				assert.strictEqual(cjkRe.test(drawer.textContent ?? ''), false, `Mission drawer must have 0 CJK in EN mode (got: "${drawer.textContent}")`);
				assert.ok((drawer.textContent ?? '').includes('Mermaid Task DAG (Strictly Acyclic)'));
				assert.ok((drawer.textContent ?? '').includes('Task Descriptions'));

				// 2. Switch to pure Simplified Chinese -> immediate live re-render across Mission Drawer!
				setAdeDisplayLanguageOverride('zh-cn');
				assert.ok((drawer.textContent ?? '').includes('Mermaid 任务流图（严格无环 DAG）'));
				assert.ok((drawer.textContent ?? '').includes('全部任务节点描述'));

				// 3. Switch to Orchestration view -> strictly 1-pane drawer in pure EN & pure ZH-CN!
				const oInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(created.id, 'orchestration')));
				await mPane.setInput(oInput, undefined, {}, CancellationToken.None);
				mHost.querySelector<HTMLButtonElement>('[data-ade-mission-file-btn="true"]')!.click();
				assert.strictEqual(drawer.hidden, false);
				assert.strictEqual(mHost.querySelector<HTMLElement>('[data-ade-mission-tasks-pane="true"]')?.hidden, true, 'Orchestration drawer hides right task descriptions pane');
				assert.ok((drawer.textContent ?? '').includes('声明式员工编排代码'));
				setAdeDisplayLanguageOverride('en');
				assert.strictEqual(cjkRe.test(drawer.textContent ?? ''), false, `Orchestration drawer must have 0 CJK in EN mode (got: "${drawer.textContent}")`);
				assert.ok((drawer.textContent ?? '').includes('Declarative Staff Topology'));

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

				// B1. Role Studio shows unified All-Staff 1..3 hierarchy bar (no off-graph Factory Wall cutoff!) + preserves Legacy v1 slots
				const studioHost = append(document.body, $('.monaco-workbench.ade-audit8-studio-host'));
				store.add({ dispose: () => studioHost.remove() });
				const studioPane = store.add(h.instantiation.createInstance(AdeRoleStudioEditorPane, upcastPartial<IEditorGroup>({ id: 2 })));
				studioPane.create(studioHost);
				const studioInput = store.add(h.instantiation.createInstance(AdeRoleStudioEditorInput, 'architect'));
				await studioPane.setInput(studioInput, undefined, {}, CancellationToken.None);

				const allStaffBar = studioHost.querySelector<HTMLElement>('[data-ade-rs-factory-wall-bar="true"]')!;
				assert.ok(allStaffBar, 'Role Studio renders unified Engineering All-Staff 1..N hierarchy bar');
				assert.strictEqual(allStaffBar.dataset.dynamicRankCount, '3', 'Hierarchy bar reflects 3 dynamic ranks');
				assert.strictEqual(allStaffBar.dataset.allStaffOnCanvas, 'true', 'All ranks enter the same Orchestration canvas');
				assert.strictEqual(studioHost.querySelector('[data-ade-rs-wall-cutoff="true"]'), null, 'Legacy off-graph Factory Wall cutoff selector is removed');
				assert.strictEqual(cjkRe.test(studioHost.textContent ?? ''), false, 'Role Studio has 0 CJK in EN mode');
				assert.ok((allStaffBar.textContent ?? '').includes('L1 · Chief Architect') && (allStaffBar.textContent ?? '').includes('L2 · Code Auditor') && (allStaffBar.textContent ?? '').includes('L3 · Pure Builder'));
				assert.ok(studioHost.querySelectorAll('.ade-rs-slot-select[data-slot]').length === 4, 'Legacy v1 slot compatibility selects remain intact');

				// Role Studio live locale switch to ZH-CN
				setAdeDisplayLanguageOverride('zh-cn');
				assert.ok((studioHost.textContent ?? '').includes('组织架构与角色工坊'));
				assert.ok((studioHost.textContent ?? '').includes('全员同场入画'));

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

		test('Audit #11: pauses all infinite CSS animations on Engineering dual-view canvas when page or editor tab is hidden', async () => {
			const { h, missionStore } = createMissionHarness();
			const created = missionStore.createMission({
				title: 'Audit 11 Visibility Engineering',
				projectUri: alpha.toString(),
				mermaidText: 'flowchart LR\n  A["Fetch"] --> B["Train"]',
				orchestrationText: 'flowchart TD\n  CEO["@Alice (L1)"] <--> Lead["@Bob (L2)"]',
			});
			const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(created.id, 'orchestration')));
			const host = append(document.body, $('.monaco-workbench.ade-audit11-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			await pane.setInput(input, undefined, {}, CancellationToken.None);

			const editorRoot = host.querySelector<HTMLElement>('.ade-mission-editor')!;
			assert.strictEqual(editorRoot.classList.contains('ade-animations-paused'), false);

			const doc = editorRoot.ownerDocument;
			const origHiddenDesc = Object.getOwnPropertyDescriptor(doc, 'hidden');
			const origVisDesc = Object.getOwnPropertyDescriptor(doc, 'visibilityState');
			try {
				Object.defineProperty(doc, 'hidden', { configurable: true, get: () => true });
				Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
				doc.dispatchEvent(new mainWindow.Event('visibilitychange'));

				assert.strictEqual(editorRoot.classList.contains('ade-animations-paused'), true, 'visibilitychange(hidden) sets ade-animations-paused on Engineering Canvas');
				assert.strictEqual(editorRoot.getAttribute('data-animations-paused'), 'true');
				assert.strictEqual(doc.documentElement.classList.contains('ade-page-hidden'), true, 'visibilitychange(hidden) sets ade-page-hidden on documentElement');

				Object.defineProperty(doc, 'hidden', { configurable: true, get: () => false });
				Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'visible' });
				doc.dispatchEvent(new mainWindow.Event('visibilitychange'));

				assert.strictEqual(editorRoot.classList.contains('ade-animations-paused'), false, 'visibilitychange(visible) resumes Engineering Canvas animations');
				assert.strictEqual(doc.documentElement.classList.contains('ade-page-hidden'), false);
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

			// Switching away from the Engineering editor tab (setVisible(false)) also pauses animations without hiding the OS window
			pane.setVisible(false);
			assert.strictEqual(editorRoot.classList.contains('ade-animations-paused'), true, 'Editor tab backgrounded pauses Engineering Canvas animations');
			pane.setVisible(true);
			assert.strictEqual(editorRoot.classList.contains('ade-animations-paused'), false, 'Editor tab foregrounded resumes Engineering Canvas animations');

			// Workbench-wide AdePageVisibilityAnimationGuard pauses global ADE animations even with ZERO Engineering panes open!
			pane.dispose();
			const globalGuard = store.add(new AdePageVisibilityAnimationGuard());
			assert.ok(globalGuard);
			const gDoc = mainWindow.document;
			const gOrigHidden = Object.getOwnPropertyDescriptor(gDoc, 'hidden');
			const gOrigVis = Object.getOwnPropertyDescriptor(gDoc, 'visibilityState');
			try {
				Object.defineProperty(gDoc, 'hidden', { configurable: true, get: () => true });
				Object.defineProperty(gDoc, 'visibilityState', { configurable: true, get: () => 'hidden' });
				gDoc.dispatchEvent(new mainWindow.Event('visibilitychange'));
				assert.strictEqual(gDoc.documentElement.classList.contains('ade-page-hidden'), true, 'Global visibility guard sets ade-page-hidden even when no Engineering pane is open');

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

		test('Audit #15: wide fan-out obeys multi-level concurrency semaphores and promotes queued nodes cleanly', async () => {
			const { missionStore, missionRuntime } = createMissionHarness();
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

			// Complete W1 -> W3 promotes to active, W4 shifts #2/3 -> #1/2, W5 shifts #3/3 -> #2/2
			const tokW1 = Object.values(rtAfterFanout.tokens).find(t => t.nodeId === 'W1' && t.status === 'active')!;
			const compW1 = await missionRuntime.completeToken(created.id, { tokenId: tokW1.id, summary: 'W1 done' });
			assert.strictEqual(compW1.ok, true, compW1.error);
			const rtAfterPromote = missionRuntime.getRuntimeState(created.id);
			assert.strictEqual(rtAfterPromote.nodeStates.W3, 'active');
			assert.strictEqual(rtAfterPromote.nodeStates.W4, 'queued');
			assert.strictEqual(rtAfterPromote.nodeStates.W5, 'queued');

			// Raising concurrency limit dynamically drains W4 & W5 immediately to active!
			const raised = await missionRuntime.setConcurrencyLimits(created.id, { maxGlobal: 8, maxLocalHost: 4, maxPerCloudHost: 2, maxPerProvider: 8 });
			assert.strictEqual(raised.ok, true, raised.error);
			const rtAfterRaise = missionRuntime.getRuntimeState(created.id);
			assert.strictEqual(rtAfterRaise.nodeStates.W4, 'active');
			assert.strictEqual(rtAfterRaise.nodeStates.W5, 'active');
			assert.strictEqual(missionRuntime.getMissionStatus(created.id).queuedTokenCount, 0);
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
			assert.strictEqual(rt2.nodeTelemetry?.A?.costUsd, 0.4, 'Run #2 tracks fresh $0.40 spend alongside archived Run #1');
		});

		test('tracks true per-model context windows and marks rework noise tokens on tool-error turns until distilled (Audit #24)', async () => {
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

			// 1. Active 64k model uses true 64k context window (NOT hardcoded 200k!)
			await missionRuntime.start(mission.id);
			missionRuntime.recordNodeTurnUsage(mission.id, 'N1', {
				inputTokens: 42_000,
				outputTokens: 6_000,
				model: 'deepseek-r1',
				engineId: 'aexus-dsh',
			});
			const tel1 = missionRuntime.getRuntimeState(mission.id).nodeTelemetry?.N1;
			assert.strictEqual(tel1?.contextWindowMax, 64_000);
			assert.strictEqual(tel1?.contextNoiseTokens ?? 0, 0);

			// 2. Tool-error turn (WITHOUT passing isNoiseTurn!) marks rework noise tokens automatically!
			missionRuntime.recordNodeTurnUsage(mission.id, 'N1', {
				inputTokens: 8_000,
				outputTokens: 2_000,
				hadToolError: true,
				toolErrorCount: 1,
				model: 'deepseek-r1',
				engineId: 'aexus-dsh',
			});
			const tel2 = missionRuntime.getRuntimeState(mission.id).nodeTelemetry?.N1;
			assert.strictEqual(tel2?.contextWindowMax, 64_000);
			assert.ok((tel2?.contextNoiseTokens ?? 0) >= 10_000, `Expected rework noise >=10000 tokens, got ${tel2?.contextNoiseTokens}`);

			// 3. Gemini 2.5 Pro uses 1M context window
			missionRuntime.recordNodeTurnUsage(mission.id, 'R1', {
				inputTokens: 50_000,
				outputTokens: 5_000,
				model: 'gemini-2.5-pro',
				engineId: 'aexus-antigravity',
			});
			assert.strictEqual(missionRuntime.getRuntimeState(mission.id).nodeTelemetry?.R1?.contextWindowMax, 1_000_000);

			// 4. Distill & Refresh clears rework noise back to 0
			await missionRuntime.distillNodeContext(mission.id, 'N1', { memo: 'Reset after tool error' });
			assert.strictEqual(missionRuntime.getRuntimeState(mission.id).nodeTelemetry?.N1?.contextNoiseTokens ?? 0, 0);
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

			const dispatchesBeforePar = dispatchedCalls.length;
			await missionRuntime.start(parMission.id);
			await timeout(10);
			const sTok = Object.values(missionRuntime.getRuntimeState(parMission.id).tokens).find(t => t.nodeId === 'S' && t.status === 'active')!;
			await missionRuntime.completeToken(parMission.id, { tokenId: sTok.id, summary: 'Forked' });
			dispatchedCalls[dispatchesBeforePar]?.resolve({ reply: 'Split done' });
			await timeout(15);

			// Only Branch A is dispatched & active; Branch B is queued with blockedBy="employee"
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

		test('Engineering Dual-View — View 1 (Mission Task DAG): minimalist 1-button chrome, 2-area drawer, inline task popover, right-click create, and highest-rank-only completion authority', async () => {
			const { h, missionStore } = createMissionHarness();
			const govL1 = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/eng-l1') }, 'CEO Alice', { role: 'governor' });
			const mgrL2 = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/eng-l2') }, 'Lead Bob', { parentId: govL1.id, role: 'manager' });

			const created = missionStore.createMission({
				title: 'Aexus Engine v2',
				ownerSessionId: govL1.id,
				ownerTier: 1,
				projectUri: alpha.toString(),
				mermaidText: [
					'flowchart LR',
					'  T1["Architecture Spec"] --> T2["Core Runtime"]',
					'  T2 --> T3["Release Verification"]',
				].join('\n'),
			});

			// Sibling inputs & serializer round-trip
			const serializer = new AdeEngineeringEditorSerializer();
			const missionInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(created.id, 'mission')));
			const orchInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(created.id, 'orchestration')));
			assert.strictEqual(missionInput.getName(), 'Aexus Engine v2 · Mission');
			assert.strictEqual(orchInput.getName(), 'Aexus Engine v2 · Orchestration');
			assert.strictEqual(missionInput.matches(orchInput), false, 'Mission and Orchestration sibling tabs stay distinct');
			const roundTripped = store.add(serializer.deserialize(h.instantiation, serializer.serialize(orchInput)!) as AdeEngineeringEditorInput);
			assert.strictEqual(roundTripped.viewMode, 'orchestration');
			assert.strictEqual(roundTripped.governorSessionId, created.id);

			const host = append(document.body, $('.monaco-workbench.ade-eng-mission-dualview-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			await pane.setInput(missionInput, undefined, {}, CancellationToken.None);

			const rootEl = host.querySelector<HTMLElement>('.ade-mission-editor')!;
			assert.strictEqual(rootEl.dataset.viewMode, 'mission');

			// Minimalist canvas chrome: STRICTLY 1 visible top-left button on Mission view (Layout button hidden on Mission!)
			const topBar = host.querySelector<HTMLElement>('[data-ade-mission-top-bar="true"]')!;
			const visibleMissionTopBtns = [...topBar.children].filter(el => !(el as HTMLElement).hidden);
			assert.strictEqual(visibleMissionTopBtns.length, 1, 'Mission view top bar keeps strictly ONE visible top-left button');
			assert.ok(topBar.querySelector('button[data-ade-mission-file-btn="true"]'));
			assert.strictEqual(host.querySelector('[data-ade-mission-run-bar]'), null);
			assert.strictEqual(host.querySelector('.ade-mission-viewport-bar'), null);
			assert.strictEqual(host.querySelector('[data-ade-mission-sup-legend]'), null);
			assert.strictEqual(host.querySelector('[data-ade-mission-revision-bar]'), null);
			assert.strictEqual(host.querySelectorAll('.ade-mission-node[data-node-kind="mission-task"]').length, 3);
			// Verify sculpted Mission Task DAG card UI (recessed well + structured footer, zero rectangular corner clamps)
			const firstTaskNode = host.querySelector<HTMLElement>('.ade-mission-node[data-node-kind="mission-task"]')!;
			const firstTaskCard = firstTaskNode.querySelector<HTMLElement>('.ade-mission-node-card')!;
			assert.strictEqual(firstTaskNode.getAttribute('data-node-shape'), 'sculpted-card', 'Mission Task node uses sculpted card DAG shape');
			assert.strictEqual(firstTaskCard.classList.contains('is-sculpted-task'), true, 'Mission Task card uses sculpted card styling');
			assert.strictEqual(firstTaskCard.querySelectorAll('.ade-mission-clamp').length, 0, 'Sculpted Mission Task card omits rectangular corner clamps');
			assert.ok(firstTaskCard.querySelector('.ade-mission-task-well'), 'Sculpted Mission Task card renders recessed task well');
			assert.ok(firstTaskCard.querySelector('.ade-mission-task-footer'), 'Sculpted Mission Task card renders structured footer');

			// Clicking top-left button opens strictly 2-area drawer: (a) Mermaid editor + (b) All task node descriptions
			host.querySelector<HTMLButtonElement>('button[data-ade-mission-file-btn="true"]')!.click();
			const drawer = host.querySelector<HTMLElement>('[data-ade-mission-drawer="true"]')!;
			assert.strictEqual(drawer.hidden, false);
			assert.strictEqual(host.querySelector<HTMLElement>('[data-ade-mission-mermaid-pane="true"]')?.hidden, false);
			assert.strictEqual(host.querySelector<HTMLElement>('[data-ade-mission-tasks-pane="true"]')?.hidden, false);
			assert.strictEqual(host.querySelectorAll('[data-ade-mission-task-desc-card]').length, 3, 'All 3 task nodes render individual description cards');

			// Editing task description in the drawer persists live
			const t1DescInput = host.querySelector<HTMLTextAreaElement>('textarea[data-ade-task-desc-input="T1"]')!;
			t1DescInput.value = 'Define cyclic orchestration protocol and lightweight whiteboard pointers.';
			t1DescInput.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
			assert.strictEqual(missionStore.getMission(created.id)?.nodePrompts?.T1, 'Define cyclic orchestration protocol and lightweight whiteboard pointers.');

			// Entering a cycle into Mission Mermaid editor is rejected (Mission stays strictly acyclic DAG!)
			const mermaidTa = host.querySelector<HTMLTextAreaElement>('textarea[data-ade-mission-mermaid-input="true"]')!;
			mermaidTa.value = 'flowchart LR\n  T1["A"] --> T2["B"]\n  T2 --> T1';
			mermaidTa.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
			await timeout(150);
			assert.strictEqual(host.querySelectorAll('.ade-mission-node[data-node-kind="mission-task"]').length, 3, 'Cyclic Mermaid is rejected without tearing down valid Task DAG');
			// Close drawer cleanly
			host.querySelector<HTMLButtonElement>('button[data-ade-drawer-close="true"]')!.click();
			assert.strictEqual(drawer.hidden, true);

			// Clicking a task card opens Task Details popover -> edit description & mark completed
			const t1Card = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="T1"]')!;
			t1Card.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 701, clientX: 200, clientY: 200, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 701, clientX: 200, clientY: 200, bubbles: true }));
			const taskPopDesc = host.querySelector<HTMLTextAreaElement>('textarea[data-ade-task-pop-desc="T1"]')!;
			assert.ok(taskPopDesc, 'Clicking task node opens task description editor popover');
			taskPopDesc.value = 'Updated spec with acceptance checks.';
			taskPopDesc.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
			assert.strictEqual(missionStore.getMission(created.id)?.nodePrompts?.T1, 'Updated spec with acceptance checks.');

			const completeBtn = host.querySelector<HTMLButtonElement>('button[data-ade-task-toggle-complete="T1"]')!;
			completeBtn.click();
			assert.strictEqual(host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="T1"]')?.getAttribute('data-task-status'), 'completed', 'Human User can mark task T1 completed directly');

			// Control-plane highest-rank-only enforcement: L2 Manager MUST be rejected; L1 Governor (highest rank) succeeds on T2!
			await assert.rejects(
				() => h.control('mission.task.complete', { mission: created.id, nodeId: 'T2', note: 'L2 attempt', caller: 'manager', _verifiedCaller: true, _callerSessionId: mgrL2.id }),
				/FORBIDDEN|highest-rank/i,
				'Non-highest-rank role L2 is forbidden from marking Mission tasks completed',
			);
			const l1Done = await h.control<{ readonly ok: boolean }>('mission.task.complete', {
				mission: created.id,
				nodeId: 'T2',
				note: 'Verified by highest rank L1',
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: govL1.id,
			});
			assert.strictEqual(l1Done.ok, true);
			assert.strictEqual(host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="T2"]')?.getAttribute('data-task-status'), 'completed', 'L1 highest-rank completion updates task card T2 on canvas');

			// Blank-canvas right-click creates a new Task Node directly on canvas!
			const viewportEl = host.querySelector<HTMLElement>('.ade-mission-viewport')!;
			viewportEl.dispatchEvent(new mainWindow.MouseEvent('contextmenu', { clientX: 480, clientY: 320, bubbles: true, cancelable: true }));
			const addTaskItem = host.querySelector<HTMLButtonElement>('button[data-ade-ctx-action="add-task"]')!;
			assert.ok(addTaskItem, 'Blank-canvas right-click opens New Task Node action');
			addTaskItem.click();
			assert.strictEqual(host.querySelectorAll('.ade-mission-node[data-node-kind="mission-task"]').length, 4, 'Right-click New Task Node creates 4th task on canvas');
		});

		test('Engineering Dual-View — View 2 (Orchestration All-Staff Cyclic Topology): single-pane real-time code drawer, 12 perimeter anchors, cyclic & bidirectional edges, Department Whiteboards, baton relay & runtime dynamic staff expansion', async () => {
			const { h, missionStore } = createMissionHarness();
			const orgGov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/orch-gov-l1') }, 'Alice', { role: 'governor' });
			const created = missionStore.createMission({
				title: 'Aexus Company Org',
				ownerSessionId: orgGov.id,
				ownerTier: 1,
				projectUri: alpha.toString(),
				mermaidText: 'flowchart LR\n  T1["Build Engine"] --> T2["Ship"]',
				orchestrationText: [
					'flowchart TD',
					'  CEO["@Alice · CEO (L1)"] <-->|align| Lead["@Bob · Backend Lead (L2)"]',
					'  subgraph Backend["Backend Dept"]',
					'    Lead -->|delegate| Dev["@Carol · Dev (L3)"]',
					'    Dev -->|review| QA["@Dave · QA (L3)"]',
					'    QA -->|feedback| Lead',
					'    WB_BE[("Whiteboard: Architecture")]',
					'  end',
				].join('\n'),
			});

			const orchInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(created.id, 'orchestration')));
			const host = append(document.body, $('.monaco-workbench.ade-eng-orch-dualview-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 2, index: 1 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			await pane.setInput(orchInput, undefined, {}, CancellationToken.None);

			const rootEl = host.querySelector<HTMLElement>('.ade-mission-editor')!;
			assert.strictEqual(rootEl.dataset.viewMode, 'orchestration');

			// 0. Tight 1:1 locked hierarchical sidebar sync: L2 Lead nests under L1 Governor, L3 Dev nests under L2 Lead, all locked!
			const syncedSubs = missionStore.getGeneratedEmployees(created.id);
			assert.strictEqual(syncedSubs.length, 3, 'All 3 subordinate staff nodes (Lead, Dev, QA) stay tightly synced in left sidebar under Governor');
			const leadAgent = syncedSubs.find(a => a.treeNodeIds?.includes('Lead'))!;
			const devAgent = syncedSubs.find(a => a.treeNodeIds?.includes('Dev'))!;
			assert.ok(leadAgent && devAgent);
			assert.strictEqual(leadAgent.parentId, orgGov.id, 'L2 Lead nests directly under L1 Governor in left sidebar');
			assert.strictEqual(devAgent.parentId, leadAgent.id, 'L3 Dev nests hierarchically under L2 Lead in left sidebar');
			assert.strictEqual(h.projects.isLockedByWorkTree?.(leadAgent.id), true, 'Sidebar Orchestration staff is strictly locked by Engineering');
			assert.strictEqual(h.projects.isLockedByWorkTree?.(devAgent.id), true, 'Nested L3 staff is strictly locked by Engineering');

			// 1. Minimalist chrome: ONLY 2 visible top-left buttons on Orchestration (Code Drawer + Presentation Layout Switcher)!
			const topBar = host.querySelector<HTMLElement>('[data-ade-mission-top-bar="true"]')!;
			const visibleOrchTopBtns = [...topBar.children].filter(el => !(el as HTMLElement).hidden);
			assert.strictEqual(visibleOrchTopBtns.length, 2, 'Orchestration view top bar keeps strictly TWO buttons: Code Drawer + Layout Mode Switcher');
			const layoutBtn = topBar.querySelector<HTMLButtonElement>('button[data-ade-orch-layout-btn="true"]')!;
			assert.ok(layoutBtn && !layoutBtn.hidden, 'Orchestration view exposes single Layout Mode Switcher button');

			// Verify switching among LR, TD, Core Radial, and Department Matrix changes node positions WITHOUT mutating orchestrationText!
			const beforeSwitchCode = missionStore.getMission(created.id)?.orchestrationText;
			const layoutMenu = host.querySelector<HTMLElement>('[data-ade-orch-layout-menu="true"]')!;
			assert.strictEqual(layoutMenu.hidden, true);
			layoutBtn.click();
			assert.strictEqual(layoutMenu.hidden, false, 'Clicking Layout button opens presentation layout picker menu');
			assert.strictEqual(layoutMenu.querySelectorAll('[data-ade-orch-layout-option]').length, 4, 'Layout menu provides 4 presentation modes (LR, TD, Radial, Grid)');
			const readCeoPos = () => {
				const el = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="CEO"]')!;
				return `${el.style.left},${el.style.top}`;
			};
			layoutMenu.querySelector<HTMLButtonElement>('[data-ade-orch-layout-option="lr"]')!.click();
			const ceoLr = readCeoPos();
			layoutBtn.click();
			layoutMenu.querySelector<HTMLButtonElement>('[data-ade-orch-layout-option="radial"]')!.click();
			const ceoRadial = readCeoPos();
			layoutBtn.click();
			layoutMenu.querySelector<HTMLButtonElement>('[data-ade-orch-layout-option="grid"]')!.click();
			const ceoGrid = readCeoPos();
			layoutBtn.click();
			layoutMenu.querySelector<HTMLButtonElement>('[data-ade-orch-layout-option="td"]')!.click();
			const ceoTd = readCeoPos();
			assert.notStrictEqual(ceoLr, ceoRadial, 'Switching LR -> Core Radial genuinely re-layouts cards');
			assert.notStrictEqual(ceoLr, ceoTd, 'Switching LR -> TD genuinely re-layouts cards');
			assert.notStrictEqual(ceoLr, ceoGrid, 'Switching LR -> Grid genuinely re-layouts cards');
			assert.strictEqual(missionStore.getMission(created.id)?.orchestrationText, beforeSwitchCode, 'Switching presentation layout NEVER mutates fixed Orchestration code');

			host.querySelector<HTMLButtonElement>('button[data-ade-mission-file-btn="true"]')!.click();
			const drawer = host.querySelector<HTMLElement>('[data-ade-mission-drawer="true"]')!;
			assert.strictEqual(drawer.hidden, false);
			assert.strictEqual(host.querySelector<HTMLElement>('[data-ade-mission-drawer-split="true"]')?.classList.contains('single-pane'), true, 'Orchestration drawer is strictly single-pane');
			assert.strictEqual(host.querySelector<HTMLElement>('[data-ade-mission-tasks-pane="true"]')?.hidden, true, 'Orchestration drawer hides right descriptions pane');
			const codeInput = host.querySelector<HTMLTextAreaElement>('textarea[data-ade-orchestration-code-input="true"]')!;
			assert.ok(codeInput && codeInput.value.includes('CEO["@Alice · CEO (L1)"]'));

			// 2. All ranks (L1 CEO, L2 Lead, L3 Dev, L3 QA) live on the SAME canvas + Whiteboard card + Department frame + 12 anchors per staff card!
			const staffCards = [...host.querySelectorAll<HTMLElement>('.ade-mission-node[data-node-kind="staff"]')];
			assert.strictEqual(staffCards.length, 4, 'All 4 staff ranks (L1..L3) enter the same Orchestration canvas');
			for (const card of staffCards) {
				assert.strictEqual(card.querySelectorAll('.ade-orch-anchor').length, 20, `Staff node ${card.dataset.nodeId} renders 4x5=20 perimeter anchors`);
				assert.strictEqual(card.querySelectorAll('.ade-mission-clamp').length, 4, `Staff node ${card.dataset.nodeId} preserves 4 Armored Pod L-corner clamps`);
				assert.ok(card.querySelector('.ade-mission-core-well'), `Staff node ${card.dataset.nodeId} preserves recessed midnight core well`);
				assert.ok(card.querySelector('.ade-mission-ctx-row'), `Staff node ${card.dataset.nodeId} preserves 4-color context usage bar`);
				assert.ok(card.querySelector('.ade-mission-node-footer'), `Staff node ${card.dataset.nodeId} preserves Engine + OS Host footer`);
			}
			assert.ok(host.querySelector('.ade-orch-dept-region[data-ade-dept-region="Backend Dept"]'), 'Backend Dept visual region frame renders on canvas');
			const wbCard = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="WB_BE"][data-node-kind="whiteboard"]')!;
			assert.ok(wbCard, 'Department Shared Whiteboard card renders on Orchestration canvas');
			assert.strictEqual(wbCard.querySelectorAll('.ade-mission-clamp').length, 4, 'Whiteboard card preserves 4 Armored Pod L-corner clamps');
			assert.ok(wbCard.querySelector('.ade-mission-core-well.wb-well'), 'Whiteboard card preserves recessed midnight core well');

			// Bidirectional edges & cycle back-edges render with semantic routing attributes
			assert.ok(host.querySelector('.ade-mission-edge-group[data-from="CEO"][data-to="Lead"][data-bidirectional="true"]'), 'CEO->Lead marked bidirectional');
			assert.ok(host.querySelector('.ade-mission-edge-group[data-from="Lead"][data-to="CEO"][data-bidirectional="true"]'), 'Lead->CEO marked bidirectional');
			assert.ok(host.querySelector('.ade-mission-edge-group[data-from="QA"][data-to="Lead"][data-cycle-back="true"]'), 'QA->Lead feedback edge marked cycle back-edge');

			// Strict 1:1 uniqueness: attempting duplicate @Alice in code editor is rejected cleanly
			const validOrchCode = codeInput.value;
			codeInput.value = `${validOrchCode}\n  Lead --> Dup["@Alice · Duplicate (L3)"]`;
			codeInput.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
			await timeout(150);
			assert.strictEqual(host.querySelectorAll('.ade-mission-node[data-node-kind="staff"]').length, 4, 'Duplicate @Alice is rejected while keeping valid 4 staff nodes on canvas');
			codeInput.value = validOrchCode;
			codeInput.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
			await timeout(150);
			host.querySelector<HTMLButtonElement>('button[data-ade-drawer-close="true"]')!.click();

			// 3. Click Whiteboard card -> edit & save content -> creates v1, second edit bumps to v2
			const wbCardLive = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="WB_BE"][data-node-kind="whiteboard"]')!;
			assert.strictEqual(wbCardLive.querySelector('.ade-orch-wb-ver-tag')?.textContent, 'v0');
			wbCardLive.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 711, clientX: 250, clientY: 250, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 711, clientX: 250, clientY: 250, bubbles: true }));
			const wbInput = host.querySelector<HTMLTextAreaElement>('textarea[data-ade-whiteboard-content-input="WB_BE"]')!;
			assert.ok(wbInput, 'Clicking Whiteboard card opens shared whiteboard editor popover');
			wbInput.value = 'API Contract v1: stateless relay tokens with whiteboard pointers only.';
			host.querySelector<HTMLButtonElement>('button[data-ade-whiteboard-save="WB_BE"]')!.click();
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="WB_BE"] .ade-orch-wb-ver-tag')?.textContent, 'v1', 'First whiteboard save creates v1 on card');

			const wbCardV1 = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="WB_BE"][data-node-kind="whiteboard"]')!;
			wbCardV1.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 712, clientX: 250, clientY: 250, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 712, clientX: 250, clientY: 250, bubbles: true }));
			const wbInput2 = host.querySelector<HTMLTextAreaElement>('textarea[data-ade-whiteboard-content-input="WB_BE"]')!;
			wbInput2.value = 'API Contract v2: stateless relay tokens with whiteboard pointers only.';
			host.querySelector<HTMLButtonElement>('button[data-ade-whiteboard-save="WB_BE"]')!.click();
			assert.strictEqual(host.querySelector('.ade-mission-node[data-node-id="WB_BE"] .ade-orch-wb-ver-tag')?.textContent, 'v2', 'Second whiteboard save bumps version to v2 on card');

			// 4. Corporate top-down dispatch -> baton token puck on CEO -> handoff to Lead with split pointers (detail + artifact + decision + whiteboard) -> lazy pointer preview & cyclic re-entry!
			const dispatched = await h.control<{ readonly ok: boolean; readonly tokenId: string; readonly targetNodeId: string }>('orchestration.dispatch', {
				mission: created.id,
				prompt: 'Ship dual-view Engineering architecture',
			});
			assert.strictEqual(dispatched.ok, true);
			assert.strictEqual(dispatched.targetNodeId, 'CEO');
			assert.ok(host.querySelector('[data-ade-orch-token-puck="CEO"]'), 'Live baton token puck mounts on CEO card');

			const handedOff = await h.control<{ readonly ok: boolean; readonly nextTokenIds: readonly string[]; readonly handedOffTo: readonly string[]; readonly payloadPtr?: string }>('token.handoff', {
				mission: created.id,
				tokenId: dispatched.tokenId,
				to: ['Lead'],
				summary: 'Implement cyclic backend engine',
				detail: 'HANDOFF_DETAIL_SECRET_PAYLOAD: Ensure O(1) delta cursors and strict directed edge enforcement.',
				artifacts: [{ title: 'Schema Spec', content: 'ARTIFACT_BODY_SECRET: hopLog + contextRefs manifest.' }],
				decisions: [{ title: 'Edge Policy', content: 'DECISION_BODY_SECRET: Return edges live in choreography.' }],
				whiteboardIds: ['WB_BE'],
			});
			assert.strictEqual(handedOff.ok, true);
			assert.deepStrictEqual(handedOff.handedOffTo, ['Lead']);
			assert.ok(handedOff.payloadPtr?.startsWith('hop-'), 'Handoff detail spills into independent hop-N pointer');

			// Click Lead's live baton puck -> shows pass history & typed pointer chips WITHOUT preloading bodies, and clicking a chip lazily opens [data-ade-ptr-preview]!
			const leadPuck = host.querySelector<HTMLButtonElement>('[data-ade-orch-token-puck="Lead"]')!;
			assert.ok(leadPuck, 'Handoff moves live baton puck onto Lead card');
			leadPuck.click();
			const popoverEl = host.querySelector<HTMLElement>('[data-ade-mission-emp-popover="true"]')!;
			const wbPointerBtn = popoverEl.querySelector<HTMLButtonElement>('button[data-ade-wb-pointer="WB_BE"]')!;
			const decPointerBtn = popoverEl.querySelector<HTMLButtonElement>('button[data-ptr-kind="decision"]')!;
			assert.ok(wbPointerBtn, 'Baton token popover surfaces lightweight whiteboard pointer WB_BE');
			assert.ok(decPointerBtn, 'Baton token popover surfaces split decision pointer chip');
			assert.ok(popoverEl.querySelector('[data-ade-orch-hop-history="true"]'), 'Baton token popover surfaces compact pass history trail');
			assert.ok(!(popoverEl.textContent ?? '').includes('stateless relay tokens'), 'Token popover displays pointer reference, NOT full whiteboard body text');
			assert.ok(!(popoverEl.textContent ?? '').includes('DECISION_BODY_SECRET'), 'Token popover does NOT preload decision body until clicked');

			// Click decision pointer chip -> lazily dereferences body inside [data-ade-ptr-preview]!
			const previewPane = popoverEl.querySelector<HTMLElement>('[data-ade-ptr-preview="true"]')!;
			assert.strictEqual(previewPane.hidden, true, 'Pointer preview stays collapsed before click');
			decPointerBtn.click();
			assert.strictEqual(previewPane.hidden, false, 'Clicking pointer chip lazily reveals preview pane');
			assert.ok((previewPane.textContent ?? '').includes('DECISION_BODY_SECRET'), 'Preview pane displays dereferenced decision content on demand');

			// Control-plane token.read & token.history work end-to-end
			const readRes = await h.control<{ readonly items: readonly { readonly ptr: string; readonly ok: boolean; readonly content?: string }[] }>('token.read', {
				mission: created.id,
				tokenId: handedOff.nextTokenIds[0],
				ptrs: [handedOff.payloadPtr!, decPointerBtn.dataset.adeContextPtr!],
			});
			assert.strictEqual(readRes.items.length, 2);
			assert.ok(readRes.items[0].ok && readRes.items[0].content?.includes('HANDOFF_DETAIL_SECRET_PAYLOAD'));
			assert.ok(readRes.items[1].ok && readRes.items[1].content?.includes('DECISION_BODY_SECRET'));

			// 5. Dynamic runtime subordinate expansion: Lead recruits a new L3 subordinate (Eve) on canvas & updates code editor bidirectionally!
			const hired = await h.control<{ readonly ok: boolean; readonly nodeId: string }>('orchestration.staff.create', {
				mission: created.id,
				callerNodeId: 'Lead',
				name: 'Eve',
				role: 'L3',
				department: 'Backend Dept',
				bidirectional: true,
			});
			assert.strictEqual(hired.ok, true);
			assert.strictEqual(host.querySelectorAll('.ade-mission-node[data-node-kind="staff"]').length, 5, 'Runtime subordinate creation adds 5th staff card directly onto canvas');
			assert.ok(host.querySelector(`.ade-mission-node[data-node-id="${hired.nodeId}"]`), 'Newly recruited subordinate renders on Orchestration canvas');
			assert.ok(codeInput.value.includes('Eve'), 'Declarative code editor syncs bidirectionally with dynamically created subordinate');

			// Cyclic re-entry: Lead hands baton back up to CEO -> CEO re-wakes with delta-collapsed history!
			const replyToCeo = await h.control<{ readonly ok: boolean; readonly nextTokenIds: readonly string[]; readonly handedOffTo: readonly string[] }>('token.handoff', {
				mission: created.id,
				tokenId: handedOff.nextTokenIds[0],
				to: ['CEO'],
				summary: 'Backend & Eve onboarded, ready for sign-off',
			});
			assert.strictEqual(replyToCeo.ok, true);
			assert.deepStrictEqual(replyToCeo.handedOffTo, ['CEO']);
			assert.ok(host.querySelector('[data-ade-orch-token-puck="CEO"]'), 'CEO re-wakes with baton puck on cyclic re-entry');

			const ceoDeltaHistory = await h.control<{ readonly ok: boolean; readonly delta?: { readonly isReentrantVisit: boolean; readonly earlierHops: readonly unknown[]; readonly newHops: readonly unknown[] } }>('token.history', {
				mission: created.id,
				tokenId: replyToCeo.nextTokenIds[0],
				includeAll: false,
			});
			assert.strictEqual(ceoDeltaHistory.ok, true);
			assert.strictEqual(ceoDeltaHistory.delta?.isReentrantVisit, true, 'CEO cyclic re-entry activates delta cursor');
			assert.ok((ceoDeltaHistory.delta?.earlierHops.length ?? 0) >= 2, 'CEO already-seen hops collapse into earlierHops');
			assert.strictEqual(ceoDeltaHistory.delta?.newHops.length, 1, 'CEO sees strictly the 1 new return hop from Lead');

			// Non-blocking authoring-time advisory: editing a one-way downward edge displays a tip in drawer status without blocking render!
			host.querySelector<HTMLButtonElement>('button[data-ade-mission-file-btn="true"]')!.click();
			const beforeOneWay = codeInput.value;
			codeInput.value = 'flowchart TD\n  CEO["@Alice · CEO (L1)"] --> Lead["@Bob · Backend Lead (L2)"]';
			codeInput.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
			await timeout(150);
			assert.strictEqual(host.querySelectorAll('.ade-mission-node[data-node-kind="staff"]').length, 2, 'One-way graph still renders cleanly (non-blocking)');
			const statusText = host.querySelector<HTMLElement>('.ade-mission-drawer-status')?.textContent ?? '';
			assert.ok(/<-->|one-way|单向/.test(statusText), `Expected non-blocking return-edge choreography tip in drawer status, got: ${statusText}`);
			codeInput.value = beforeOneWay;
			codeInput.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
			await timeout(150);
			host.querySelector<HTMLButtonElement>('button[data-ade-drawer-close="true"]')!.click();

			// 6. Blank-canvas right-click exposes Add Group, Add Staff & Add Whiteboard actions
			const viewportEl = host.querySelector<HTMLElement>('.ade-mission-viewport')!;
			viewportEl.dispatchEvent(new mainWindow.MouseEvent('contextmenu', { clientX: 520, clientY: 360, bubbles: true, cancelable: true }));
			assert.ok(host.querySelector('button[data-ade-ctx-action="add-group"]'), 'Orchestration blank-canvas menu offers New Group / Department');
			assert.ok(host.querySelector('button[data-ade-ctx-action="add-staff"]'), 'Orchestration blank-canvas menu offers New Staff Node');
			assert.ok(host.querySelector('button[data-ade-ctx-action="add-whiteboard"]'), 'Orchestration blank-canvas menu offers New Department Whiteboard');
			host.querySelector<HTMLButtonElement>('button[data-ade-ctx-action="add-group"]')!.click();
			const grpInput = host.querySelector<HTMLInputElement>('input[data-ade-orch-group-name="true"]')!;
			assert.ok(grpInput, 'Clicking New Group opens group creation popover');
			grpInput.value = 'Security Ops';
			host.querySelector<HTMLButtonElement>('button[data-ade-orch-group-submit="true"]')!.click();
			assert.ok(host.querySelector('.ade-orch-dept-region[data-ade-dept-region="Security Ops"]'), 'Newly created empty Group renders immediately on canvas');
			assert.ok((missionStore.getMission(created.id)?.orchestrationText ?? '').includes('subgraph Security_Ops["Security Ops"]'), 'Empty Group persists in Mermaid code');

			// 7. Interactive Group Pill Drag moves ALL member cards of Backend Dept simultaneously!
			const leadCardBefore = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="Lead"]')!;
			const wbCardBefore = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="WB_BE"]')!;
			const leadX0 = Number.parseFloat(leadCardBefore.style.left);
			const leadY0 = Number.parseFloat(leadCardBefore.style.top);
			const wbX0 = Number.parseFloat(wbCardBefore.style.left);
			const wbY0 = Number.parseFloat(wbCardBefore.style.top);
			const deptPill = host.querySelector<SVGGElement>('.ade-orch-dept-pill-group[data-ade-dept-pill="Backend"]')!;
			assert.ok(deptPill, 'Backend department exposes interactive draggable & renamable header pill');
			deptPill.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 801, clientX: 300, clientY: 200, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointermove', { button: 0, pointerId: 801, clientX: 380, clientY: 240, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 801, clientX: 380, clientY: 240, bubbles: true }));
			const leadCardAfter = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="Lead"]')!;
			const wbCardAfter = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="WB_BE"]')!;
			assert.ok(Number.parseFloat(leadCardAfter.style.left) > leadX0, 'Dragging group pill moves Lead staff card right');
			assert.ok(Number.parseFloat(leadCardAfter.style.top) > leadY0, 'Dragging group pill moves Lead staff card down');
			assert.ok(Number.parseFloat(wbCardAfter.style.left) > wbX0, 'Dragging group pill moves member Whiteboard card right simultaneously');
			assert.ok(Number.parseFloat(wbCardAfter.style.top) > wbY0, 'Dragging group pill moves member Whiteboard card down simultaneously');

			// 8. Interactive Double-Click Group Pill Inline Rename updates canvas, Mermaid subgraph, member dept & whiteboard dept!
			const deptPill2 = host.querySelector<SVGGElement>('.ade-orch-dept-pill-group[data-ade-dept-pill="Backend"]')!;
			deptPill2.dispatchEvent(new mainWindow.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
			const inlineGrpInput = host.querySelector<HTMLInputElement>('input[data-ade-inline-group-rename="Backend"]')!;
			assert.ok(inlineGrpInput, 'Double-clicking group pill opens inline group rename input');
			inlineGrpInput.value = 'Platform Core Dept';
			inlineGrpInput.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			assert.ok(host.querySelector('.ade-orch-dept-region[data-ade-dept-region="Platform Core Dept"]'), 'Renamed group updates immediately on canvas');
			const renamedCode = missionStore.getMission(created.id)?.orchestrationText ?? '';
			assert.ok(renamedCode.includes('subgraph Backend["Platform Core Dept"]'), 'Inline group rename updates Mermaid subgraph header');
			assert.ok(renamedCode.includes('API Contract v2: stateless relay tokens'), 'Lossless whiteboard Markdown body persists directly inside Mermaid code');
			assert.strictEqual(missionStore.getMission(created.id)?.whiteboards?.WB_BE?.department, 'Platform Core Dept', 'Renaming group syncs member whiteboard department');
		});

		test('100% lossless export/import migration and autonomous L1 Governor Engineering creation via CLI control plane', async () => {
			const { h } = createMissionHarness();
			const projUri = URI.file('/workspace/autonomous-eng');
			h.projects.addProject(projUri, 'autonomous-eng');
			const gov1 = h.projects.addSession(projUri, { engineId: 'aexus-claude', resource: URI.parse('ade://gov-auto-1') }, 'Chief Architect', { role: 'governor' });
			const gov2 = h.projects.addSession(projUri, { engineId: 'aexus-claude', resource: URI.parse('ade://gov-migrated-2') }, 'Migrated Architect', { role: 'governor' });

			// 1. L1 Governor autonomously builds an entire Engineering workspace (Mission DAG + Task Descriptions + Orchestration Groups + Staff + Edges + Multiline Whiteboards + Layout) using its own session caller identity!
			const govCaller = { caller: 'governor', _verifiedCaller: true, _callerSessionId: gov1.id };

			const initRes = await h.control<{ readonly id: string; readonly ownerSessionId?: string }>('mission.init', {
				...govCaller,
				title: 'Autonomous Cloud Platform',
			});
			assert.strictEqual(initRes.id, gov1.id);
			assert.strictEqual(initRes.ownerSessionId, gov1.id);

			await h.control('mission.blueprint.apply', {
				...govCaller,
				mission: gov1.id,
				text: 'flowchart LR\n  T1["Architecture Design"] --> T2["Service Implementation"]\n  T2 --> T3["Release Verification"]',
			});
			await h.control('mission.task.set', {
				...govCaller,
				mission: gov1.id,
				node: 'T1',
				description: 'Define API contracts and storage schema.',
			});
			await h.control('mission.task.complete', {
				...govCaller,
				mission: gov1.id,
				node: 'T1',
				note: 'Spec signed off by Chief Architect',
			});

			// Build Orchestration step-by-step via Group, Staff, Edge, Whiteboard & Layout CLI actions
			await h.control('orchestration.apply', {
				...govCaller,
				mission: gov1.id,
				text: [
					'flowchart LR',
					'  GOV["Chief Architect"]',
					'  %% staff GOV [tier=1, rank=governor, name="Chief Architect"]',
				].join('\n'),
			});
			const grpCreated = await h.control<{ readonly ok: boolean; readonly groupId: string }>('orchestration.group.create', {
				...govCaller,
				mission: gov1.id,
				name: 'Backend Team',
				groupId: 'BackendTeam',
			});
			assert.strictEqual(grpCreated.ok, true);
			assert.strictEqual(grpCreated.groupId, 'BackendTeam');

			const empCreated = await h.control<{ readonly ok: boolean; readonly nodeId: string; readonly agentId?: string }>('orchestration.staff.create', {
				...govCaller,
				mission: gov1.id,
				callerNodeId: 'GOV',
				id: 'BE_Lead',
				name: 'Backend Manager',
				rank: 'L2',
				department: 'Backend Team',
				bidirectional: true,
			});
			assert.strictEqual(empCreated.ok, true);
			assert.strictEqual(empCreated.nodeId, 'BE_Lead');

			// Strict no-rank-skip check: L1 Governor cannot skip L2 to directly recruit L3
			await assert.rejects(
				() => h.control('orchestration.staff.create', {
					...govCaller,
					mission: gov1.id,
					callerNodeId: 'GOV',
					id: 'BE_Eng_Skip',
					name: 'Skipped Engineer',
					rank: 'L3',
					department: 'Backend Team',
				}),
				/RANK_SKIP_FORBIDDEN/i,
			);

			// L2 Backend Manager legitimately recruits its own immediate L3 subordinate in the same department
			const beLeadCaller = { caller: 'manager', _verifiedCaller: true, _callerSessionId: empCreated.agentId };
			await h.control('orchestration.staff.create', {
				...beLeadCaller,
				mission: gov1.id,
				callerNodeId: 'BE_Lead',
				id: 'BE_Eng',
				name: 'Backend Engineer',
				rank: 'L3',
				department: 'Backend Team',
				bidirectional: true,
			});
			await h.control('orchestration.edge.label', {
				...govCaller,
				mission: gov1.id,
				from: 'GOV',
				to: 'BE_Lead',
				label: 'architecture',
			});
			const multilineWbContent = '# Backend Contract\n\n- Endpoint: `/v1/jobs`\n- Guard: `%% wb-end` literal preserved\n';
			await h.control('whiteboard.create', {
				...govCaller,
				mission: gov1.id,
				id: 'WB_BE',
				department: 'Backend Team',
				title: 'Backend Spec',
				content: multilineWbContent,
			});
			await h.control('whiteboard.rename', {
				...govCaller,
				mission: gov1.id,
				id: 'WB_BE',
				title: 'Backend Architecture Spec',
			});
			await h.control('orchestration.group.rename', {
				...govCaller,
				mission: gov1.id,
				group: 'BackendTeam',
				name: 'Backend Engineering',
			});
			await h.control('orchestration.group.create', {
				...govCaller,
				mission: gov1.id,
				name: 'Empty Future Squad',
			});
			await h.control('orchestration.layout.set', {
				...govCaller,
				mission: gov1.id,
				layoutMode: 'radial',
			});

			// 2. Lossless Export (both Orchestration Mermaid & Full Engineering Bundle)
			const orchExported = await h.control<{ readonly orchestrationText: string; readonly layoutMode: string; readonly groupCount: number }>('orchestration.export', {
				...govCaller,
				mission: gov1.id,
				withPositions: true,
			});
			assert.strictEqual(orchExported.layoutMode, 'radial');
			assert.strictEqual(orchExported.groupCount, 2);
			assert.ok(orchExported.orchestrationText.includes('%% layout radial'));
			assert.ok(orchExported.orchestrationText.includes('subgraph BackendTeam["Backend Engineering"]'));
			assert.ok(orchExported.orchestrationText.includes('subgraph Empty_Future_Squad["Empty Future Squad"]'));
			assert.ok(orchExported.orchestrationText.includes('%% wb-body WB_BE'));

			const bundleExported = await h.control<Record<string, unknown>>('mission.export', {
				...govCaller,
				mission: gov1.id,
				withPositions: true,
			});

			// 3. Migrate 100% losslessly into a brand-new L1 Governor session via `mission.import`!
			const gov2Caller = { caller: 'governor', _verifiedCaller: true, _callerSessionId: gov2.id };
			const imported = await h.control<{ readonly ok: boolean; readonly id: string; readonly taskCount: number; readonly groupCount: number; readonly staffCount: number; readonly whiteboardCount: number; readonly layoutMode: string }>('mission.import', {
				...gov2Caller,
				text: JSON.stringify(bundleExported),
			});
			assert.strictEqual(imported.ok, true);
			assert.strictEqual(imported.id, gov2.id);
			assert.strictEqual(imported.taskCount, 3);
			assert.strictEqual(imported.groupCount, 2, 'Both populated and empty groups migrated losslessly');
			assert.strictEqual(imported.staffCount, 3);
			assert.strictEqual(imported.whiteboardCount, 1);
			assert.strictEqual(imported.layoutMode, 'radial');

			// Verify migrated Mission DAG task status, description, and Whiteboard byte-for-byte fidelity!
			const migratedTask = await h.control<{ readonly description: string; readonly status: string }>('mission.task.get', {
				...gov2Caller,
				mission: gov2.id,
				node: 'T1',
			});
			assert.strictEqual(migratedTask.description, 'Define API contracts and storage schema.');
			assert.strictEqual(migratedTask.status, 'completed');

			const migratedWb = await h.control<{ readonly ok: boolean; readonly whiteboard: { readonly title: string; readonly department: string; readonly content: string } }>('whiteboard.read', {
				...gov2Caller,
				mission: gov2.id,
				id: 'WB_BE',
			});
			assert.strictEqual(migratedWb.ok, true);
			assert.strictEqual(migratedWb.whiteboard.title, 'Backend Architecture Spec');
			assert.strictEqual(migratedWb.whiteboard.department, 'Backend Engineering');
			assert.strictEqual(migratedWb.whiteboard.content, multilineWbContent, 'Whiteboard multiline Markdown body migrated byte-for-byte losslessly');

			// 4. Verify CLI remove/assign/rename operations on the migrated Engineering
			await h.control('orchestration.group.assign', {
				...gov2Caller,
				mission: gov2.id,
				node: 'BE_Eng',
				group: 'Empty Future Squad',
			});
			await h.control('orchestration.staff.rename', {
				...gov2Caller,
				mission: gov2.id,
				node: 'BE_Eng',
				label: 'Staff Platform Engineer',
			});
			await h.control('orchestration.edge.connect', {
				...gov2Caller,
				mission: gov2.id,
				from: 'GOV',
				to: 'BE_Eng',
				label: 'escalate',
				bidirectional: true,
			});
			await h.control('orchestration.edge.remove', {
				...gov2Caller,
				mission: gov2.id,
				from: 'GOV',
				to: 'BE_Eng',
				both: true,
			});
			await h.control('whiteboard.remove', {
				...gov2Caller,
				mission: gov2.id,
				id: 'WB_BE',
			});
			const wbsAfterRemove = await h.control<{ readonly whiteboards: readonly unknown[] }>('whiteboard.list', {
				...gov2Caller,
				mission: gov2.id,
			});
			assert.strictEqual(wbsAfterRemove.whiteboards.length, 0, 'whiteboard.remove deletes board cleanly from graph and store');

			// L1 Governor cannot rank-skip to remove L3 directly; Human operator (or direct L2 superior) can remove cleanly
			await assert.rejects(
				() => h.control('orchestration.staff.remove', {
					...gov2Caller,
					mission: gov2.id,
					node: 'BE_Eng',
				}),
				/RANK_SKIP_FORBIDDEN/i,
			);
			await h.control('orchestration.staff.remove', {
				mission: gov2.id,
				node: 'BE_Eng',
			});
			await h.control('orchestration.group.remove', {
				...gov2Caller,
				mission: gov2.id,
				group: 'Empty Future Squad',
			});
			const groupsFinal = await h.control<{ readonly groups: readonly { readonly name: string }[] }>('orchestration.group.list', {
				...gov2Caller,
				mission: gov2.id,
			});
			assert.deepStrictEqual(groupsFinal.groups.map(g => g.name), ['Backend Engineering']);
		});

		test('Items 5(3) & 8: renders Global Run Console, dual-view switcher, minimap, pre-launch unlocked staff config & session-reset engine switching', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const projUri = URI.file('/workspace/console-ui-test');
			h.projects.addProject(projUri, 'console-ui-test');
			const gov = h.projects.addSession(projUri, { engineId: 'aexus-claude', resource: URI.parse('ade://gov-ui-1') }, 'Chief Architect', { role: 'governor' });

			const created = missionStore.createMission({
				id: gov.id,
				ownerSessionId: gov.id,
				title: 'Global Console & Config Verification',
				projectUri: projUri.toString(),
				mermaidText: 'flowchart LR\n  T1["API Spec"] --> T2["Build API"]',
				orchestrationText: [
					'flowchart LR',
					'  CEO["Chief Architect @Alice"] <--> Lead["Backend Lead @Bob"]',
					'  %% staff CEO [tier=1, rank=governor, name="Alice", engine=aexus-claude, model=claude-opus-4-6]',
					'  %% staff Lead [tier=2, rank=manager, dept="Backend", name="Bob", engine=aexus-codex, model=gpt-5.4, thinking=high]',
				].join('\n'),
			});

			const host = append(mainWindow.document.body, $('.ade-eng-console-test-host'));
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			const orchInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(created.id, 'orchestration')));
			await pane.setInput(orchInput, undefined, {}, CancellationToken.None);

			// 1. Item 8: Global Console Bar, Dual-View Switcher, Split View button & Minimap are mounted and live!
			const consoleBar = host.querySelector<HTMLElement>('[data-ade-eng-console-bar="true"]')!;
			assert.ok(consoleBar && !consoleBar.hidden, 'Global console bar is visible');
			const orchTab = host.querySelector<HTMLButtonElement>('[data-ade-eng-view-btn="orchestration"]')!;
			const missionTab = host.querySelector<HTMLButtonElement>('[data-ade-eng-view-btn="mission"]')!;
			const splitBtn = host.querySelector<HTMLButtonElement>('[data-ade-eng-view-split="true"]')!;
			const pauseBtn = host.querySelector<HTMLButtonElement>('[data-ade-eng-pause-btn="true"]')!;
			const abortBtn = host.querySelector<HTMLButtonElement>('[data-ade-eng-abort-btn="true"]')!;
			const minimapBtn = host.querySelector<HTMLButtonElement>('[data-ade-eng-minimap-btn="true"]')!;
			const minimapEl = host.querySelector<HTMLElement>('[data-ade-mission-minimap="true"]')!;
			assert.ok(orchTab.classList.contains('is-active'), 'Orchestration view tab active');
			assert.ok(!missionTab.classList.contains('is-active'), 'Mission DAG tab inactive');
			assert.ok(splitBtn && pauseBtn && abortBtn && minimapBtn, 'All console controls present');
			assert.ok(minimapEl && !minimapEl.hidden, 'Minimap rendered for non-empty topology');

			// Toggle minimap off and back on
			minimapBtn.click();
			assert.strictEqual(minimapEl.hidden, true, 'Minimap hides when toggled off');
			minimapBtn.click();
			assert.strictEqual(minimapEl.hidden, false, 'Minimap reappears when toggled back on');

			// Dispatch a live token, verify in-flight counter updates, test Pause/Resume & 2-click Abort All!
			const disp = await missionRuntime.dispatchOrchestrationRequirement(created.id, { prompt: 'Ship billing v2', targetNodeId: 'CEO' });
			assert.strictEqual(disp.ok, true);
			const tokensPill = host.querySelector<HTMLElement>('[data-ade-eng-console-tokens="true"]')!;
			assert.ok(tokensPill.classList.contains('is-active'), 'Tokens pill reflects active in-flight baton');

			pauseBtn.click();
			await timeout(20);
			assert.strictEqual(missionRuntime.getOrchestrationState(created.id).status, 'paused', 'Pause button pauses orchestration');
			assert.ok(pauseBtn.classList.contains('is-paused'));

			pauseBtn.click();
			await timeout(20);
			assert.strictEqual(missionRuntime.getOrchestrationState(created.id).status, 'running', 'Second click resumes orchestration');

			// 2-click emergency Abort All confirmation
			abortBtn.click();
			assert.ok(abortBtn.classList.contains('is-confirming'), 'First click arms emergency abort confirmation');
			abortBtn.click();
			await timeout(20);
			const afterAbort = missionRuntime.getOrchestrationState(created.id);
			assert.strictEqual(afterAbort.tokens[disp.data!.tokenId].status, 'aborted', 'Second click aborts all active tokens');

			// 2. Item 5(3): Pre-launch staff card model & engine buttons are UNLOCKED before session spawn!
			const leadCard = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="Lead"]')!;
			const leadEngineBtn = leadCard.querySelector<HTMLButtonElement>('.ade-mission-engine-pill')!;
			const leadModelRow = leadCard.querySelector<HTMLElement>('.ade-mission-core-model-row')!;
			assert.strictEqual(leadEngineBtn.disabled, false, 'Pre-launch engine switcher must NOT be locked');
			assert.ok(leadEngineBtn.classList.contains('is-editable'));
			assert.ok(leadModelRow.classList.contains('is-editable'));
			assert.strictEqual(leadModelRow.dataset.nodeModel, 'gpt-5.4');
			assert.strictEqual(leadModelRow.dataset.nodeThinking, 'high');

			// 3. Session-reset engine switching via orchestration.staff.configure unbinds active session & persists new engine in code!
			const cfgRes = await h.control<{ readonly ok: boolean; readonly resetSession?: boolean }>('orchestration.staff.configure', {
				mission: created.id,
				node: 'CEO',
				engine: 'aexus-codex',
				model: 'gpt-5.4',
				thinking: 'high',
				resetSession: true,
			});
			assert.strictEqual(cfgRes.ok, true);
			assert.strictEqual(cfgRes.resetSession, true, 'Active session was reset during engine switch');
			assert.strictEqual(h.projects.getAgent(gov.id)?.session, undefined, 'Agent session cleanly unbound after reset');
			const updatedOrchText = missionStore.getMission(created.id)?.orchestrationText ?? '';
			assert.ok(updatedOrchText.includes('engine=aexus-codex'), 'New engine persisted into orchestration code');
			assert.ok(updatedOrchText.includes('model=gpt-5.4'), 'New model persisted into orchestration code');
		});

		test('enforces clean legacy retirement, whiteboard lifecycle & optimistic concurrency, anti-forgery staffing, native org.* on Orchestration, waiting_join visibility, and daemon sync', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const syncedDaemonSnapshots: { missionId: string; status: string; activeTokenCount: number; waitingJoinCount: number }[] = [];
			h.instantiation.stub(IAdeEngineeringBackendService, upcastPartial<IAdeEngineeringBackendService>({
				syncOrchestrationDaemonState: async snap => {
					syncedDaemonSnapshots.push({
						missionId: snap.missionId,
						status: snap.status,
						activeTokenCount: snap.activeTokenCount,
						waitingJoinCount: snap.waitingJoinCount,
					});
				},
			}));

			const projUri = URI.file('/workspace/hardened-eng');
			h.projects.addProject(projUri, 'hardened-eng');
			const gov = h.projects.addSession(projUri, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/hardened-gov') }, 'Chief Architect', { role: 'governor' });
			const govCaller = { caller: 'governor', _verifiedCaller: true, _callerSessionId: gov.id };

			const initRes = await h.control<{ readonly id: string }>('mission.init', {
				...govCaller,
				owner: gov.id,
				title: 'Hardened Engineering Backend',
				mermaid: 'flowchart LR\n  T1["API Spec"] --> T2["Auth Impl"]',
			});
			const missionId = initRes.id;

			await h.control('orchestration.apply', {
				...govCaller,
				mission: missionId,
				text: [
					'flowchart LR',
					'  CEO["@Alice · CEO (L1)"]',
					'  subgraph Backend["Backend Dept"]',
					'    BE_Lead["@Bob · Backend Lead (L2)"]',
					'    BE_Dev["@Dave · Backend Dev (L3)"]',
					'    WB_BE[("Whiteboard: Backend Spec")]',
					'  end',
					'  subgraph Frontend["Frontend Dept"]',
					'    FE_Lead["@Carol · Frontend Lead (L2)"]',
					'    WB_FE[("Whiteboard: Frontend Spec")]',
					'  end',
					'  CEO <--> BE_Lead',
					'  CEO <--> FE_Lead',
					'  BE_Lead <--> BE_Dev',
					'  %% staff CEO [tier=1, rank=governor, name="Alice"]',
					'  %% staff BE_Lead [tier=2, rank=manager, dept="Backend Dept", name="Bob"]',
					'  %% staff BE_Dev [tier=3, rank=worker, dept="Backend Dept", name="Dave"]',
					'  %% staff FE_Lead [tier=2, rank=manager, dept="Frontend Dept", name="Carol"]',
				].join('\n'),
			});
			missionStore.ensureOrchestrationStaffSynced(missionId);
			const orchInit = missionRuntime.getOrchestrationState(missionId);
			const beLeadAgentId = orchInit.nodeAgentIds.BE_Lead;
			const beDevAgentId = orchInit.nodeAgentIds.BE_Dev;
			assert.ok(beLeadAgentId && beDevAgentId, 'Orchestration staff agents synced');

			const beLeadCaller = { caller: 'manager', _verifiedCaller: true, _callerSessionId: beLeadAgentId };
			const beDevCaller = { caller: 'worker', _verifiedCaller: true, _callerSessionId: beDevAgentId };

			// L1: Legacy mission.prompt.* endpoints are retired with LEGACY_API_REMOVED
			for (const retiredAction of ['mission.prompt.list', 'mission.prompt.get', 'mission.prompt.set']) {
				await assert.rejects(
					() => h.control(retiredAction, { mission: missionId, node: 'T1', prompt: 'legacy' }),
					/LEGACY_API_REMOVED/i,
					`${retiredAction} must fail cleanly with LEGACY_API_REMOVED`,
				);
			}

			// L2: session.configure changing role on Orchestration staff does NOT trigger legacy Factory Wall error
			const roleUpdated = await h.control<{ readonly role?: string }>('session.configure', {
				id: beLeadAgentId,
				role: 'governor',
			});
			assert.strictEqual(roleUpdated.role, 'governor', 'Orchestration staff is exempt from legacy off-graph factory wall');
			await h.control('session.configure', { id: beLeadAgentId, role: 'manager' });

			// L3: Legacy static-Mission control actions are cleanly blocked on Orchestration-backed workspaces
			await assert.rejects(() => h.control('mission.boundary.set', { mission: missionId, offGraphMaxTier: 1 }), /LEGACY_API_REMOVED/i);
			await assert.rejects(() => h.control('mission.start', { mission: missionId }), /LEGACY_API_REMOVED/i);
			await assert.rejects(() => h.control('mission.recall', { mission: missionId }), /LEGACY_API_REMOVED/i);
			await assert.rejects(() => h.control('mission.retry', { mission: missionId, node: 'T1' }), /LEGACY_API_REMOVED/i);
			await assert.rejects(() => h.control('mission.patch', { mission: missionId, mermaid: 'flowchart LR\n  T1["A"]' }), /LEGACY_API_REMOVED/i);
			await assert.rejects(() => h.control('mission.gate', { mission: missionId, node: 'T1', decision: 'approve' }), /LEGACY_API_REMOVED/i);

			// W2/W3/W4: Whiteboards create/write optimistic concurrency, --department filter, dept-lead rename/remove, group.rename sync
			await h.control('whiteboard.write', { ...beLeadCaller, mission: missionId, id: 'WB_BE', content: 'BE v1' });
			await h.control('whiteboard.write', { mission: missionId, id: 'WB_FE', content: 'FE v1' });

			await assert.rejects(
				() => h.control('whiteboard.create', { ...beLeadCaller, mission: missionId, id: 'WB_BE', department: 'Backend Dept', title: 'Dup' }),
				/ALREADY_EXISTS/i,
			);
			await assert.rejects(
				() => h.control('whiteboard.write', { ...beLeadCaller, mission: missionId, id: 'WB_BE', content: 'stale', expectedVersion: 0 }),
				/VERSION_CONFLICT/i,
			);
			const wbOk = await h.control<{ readonly whiteboard: { readonly version: number } }>('whiteboard.write', {
				...beLeadCaller,
				mission: missionId,
				id: 'WB_BE',
				content: 'BE v2',
				expectedVersion: 1,
			});
			assert.strictEqual(wbOk.whiteboard.version, 2);

			const wbFiltered = await h.control<{ readonly whiteboards: readonly { readonly whiteboardId: string }[] }>('whiteboard.list', {
				mission: missionId,
				department: 'Backend Dept',
			});
			assert.deepStrictEqual(wbFiltered.whiteboards.map(w => w.whiteboardId), ['WB_BE']);

			// Department lead can rename its own department whiteboard, but NOT rename or remove a foreign department whiteboard!
			const beRenamed = await h.control<{ readonly ok: boolean; readonly whiteboard: { readonly title: string } }>('whiteboard.rename', {
				...beLeadCaller,
				mission: missionId,
				id: 'WB_BE',
				title: 'Backend Core Spec',
			});
			assert.strictEqual(beRenamed.ok, true);
			assert.strictEqual(beRenamed.whiteboard.title, 'Backend Core Spec');

			await assert.rejects(
				() => h.control('whiteboard.rename', { ...beLeadCaller, mission: missionId, id: 'WB_FE', title: 'Hijack' }),
				/CROSS_DEPARTMENT_FORBIDDEN/i,
			);
			await assert.rejects(
				() => h.control('whiteboard.remove', { ...beLeadCaller, mission: missionId, id: 'WB_FE' }),
				/CROSS_DEPARTMENT_FORBIDDEN/i,
			);

			// orchestration.group.rename syncs record.whiteboards[id].department
			await h.control('orchestration.group.rename', {
				...govCaller,
				mission: missionId,
				group: 'Backend',
				name: 'Backend Core',
			});
			assert.strictEqual(missionStore.getMission(missionId)?.whiteboards?.WB_BE?.department, 'Backend Core');

			// S1: Non-Human caller cannot forge callerNodeId on orchestration.staff.create or remove
			await assert.rejects(
				() => h.control('orchestration.staff.create', {
					...beLeadCaller,
					mission: missionId,
					callerNodeId: 'CEO',
					name: 'Forged Sub',
					rank: 'L2',
				}),
				/cannot impersonate staff node/i,
			);
			await assert.rejects(
				() => h.control('orchestration.staff.remove', {
					...beLeadCaller,
					mission: missionId,
					callerNodeId: 'CEO',
					node: 'FE_Lead',
				}),
				/cannot impersonate staff node/i,
			);

			// S3: Native org.subordinates discovers downward Orchestration staff WITHOUT legacy boundary.supervisors!
			const beSubs = await h.control<{
				readonly orchestrationSubordinates?: readonly { readonly nodeId: string; readonly agentId?: string }[];
				readonly missionJurisdictions: readonly { readonly missionId: string; readonly managedNodeIds: readonly string[] }[];
			}>('org.subordinates', { ...beLeadCaller, mission: missionId });
			assert.ok(beSubs.orchestrationSubordinates?.some(s => s.nodeId === 'BE_Dev' && s.agentId === beDevAgentId), 'L2 Manager sees BE_Dev via native org.subordinates');
			assert.ok(!beSubs.orchestrationSubordinates?.some(s => s.nodeId === 'CEO' || s.nodeId === 'FE_Lead'), 'Never exposes superiors or other departments');

			// Dispatch, mint with waitJoin, test S4 (token.current shows waiting_join + barrier), L3 (token.reject rejected on otok-*),
			// S5 (daemon sync invoked), org.context shows live Orchestration heldTokens, and L3 pure-execution staff can call token.return!
			const disp = await h.control<{ readonly tokenId: string }>('orchestration.dispatch', {
				...govCaller,
				mission: missionId,
				prompt: 'Ship Auth v2',
				task: 'T1',
				whiteboard: 'WB_BE',
			});
			assert.ok(syncedDaemonSnapshots.some(s => s.missionId === missionId && s.activeTokenCount === 1), 'commitOrchestrationState synced live daemon snapshot');

			// Root token with no prior sender requires explicit --target for token.reject (no longer fails with LEGACY_API_REMOVED)
			await assert.rejects(
				() => h.control('token.reject', { ...govCaller, mission: missionId, tokenId: disp.tokenId, reason: 'missing target' }),
				/Specify --target/i,
			);

			const mint1 = await h.control<{ readonly mintedTokenIds: readonly string[]; readonly joinBarrierId?: string }>('token.mint', {
				...govCaller,
				mission: missionId,
				tokenId: disp.tokenId,
				to: 'BE_Lead',
				summary: 'Lead backend auth spec',
				task: 'T1',
				waitJoin: true,
			});
			assert.ok(mint1.joinBarrierId, 'Join barrier created');

			// S4: CEO's token.current surfaces its waiting_join parent token WITH joinBarrier progress!
			const ceoCur = await h.control<{ readonly tokens: readonly { readonly id: string; readonly status: string; readonly joinBarrier?: { readonly id: string } }[] }>('token.current', {
				...govCaller,
				mission: missionId,
			});
			const waitingParent = ceoCur.tokens.find(t => t.id === disp.tokenId);
			assert.strictEqual(waitingParent?.status, 'waiting_join');
			assert.strictEqual(waitingParent?.joinBarrier?.id, mint1.joinBarrierId);

			// S1: Dynamic recruit + --mint-token keeps BE_Lead's parent token active!
			const recruited = await h.control<{ readonly ok: boolean; readonly nodeId: string; readonly nextTokenIds?: readonly string[] }>('orchestration.staff.create', {
				...beLeadCaller,
				mission: missionId,
				id: 'BE_QA',
				name: 'Backend QA',
				rank: 'L3',
				department: 'Backend Core',
				mintTokenId: mint1.mintedTokenIds[0],
				handoffSummary: 'Write auth integration tests',
			});
			assert.strictEqual(recruited.ok, true);
			assert.strictEqual(recruited.nextTokenIds?.length, 1);
			assert.strictEqual(missionRuntime.getOrchestrationState(missionId).tokens[mint1.mintedTokenIds[0]].status, 'active', 'Parent token stays active when using --mint-token');

			// BE_Lead also mints to BE_Dev; org.context sees BE_Dev's live Orchestration token; L3 pure-execution BE_Dev can call token.return!
			const mintDev = await h.control<{ readonly mintedTokenIds: readonly string[] }>('token.mint', {
				...beLeadCaller,
				mission: missionId,
				tokenId: mint1.mintedTokenIds[0],
				to: 'BE_Dev',
				summary: 'Implement JWT verifier',
				task: 'T1',
				whiteboard: 'WB_BE',
			});
			const devTokId = mintDev.mintedTokenIds[0];

			const devCtx = await h.control<{ readonly heldTokens: readonly { readonly id: string }[] }>('org.context', {
				...beLeadCaller,
				mission: missionId,
				target: 'BE_Dev',
			});
			assert.ok(devCtx.heldTokens.some(t => t.id === devTokId), 'Native org.context exposes live Orchestration heldTokens');

			// W4: Department lead removing WB_BE prunes dangling wb:WB_BE pointer from active tokens!
			const wbRemoved = await h.control<{ readonly ok: boolean; readonly prunedTokenIds?: readonly string[] }>('whiteboard.remove', {
				...beLeadCaller,
				mission: missionId,
				id: 'WB_BE',
			});
			assert.strictEqual(wbRemoved.ok, true);
			assert.ok(wbRemoved.prunedTokenIds?.includes(devTokId), 'Removing WB_BE prunes stale pointer from live dev token');
			assert.strictEqual(missionRuntime.getOrchestrationState(missionId).tokens[devTokId].whiteboardPointers, undefined);

			// Pure-execution L3 BE_Dev calls token.return through real control plane (verifying MISSION_UNIVERSAL_OR_TOKEN_ACTIONS fix!)
			const devRet = await h.control<{ readonly ok: boolean; readonly returnedToNodeId: string }>('token.return', {
				...beDevCaller,
				mission: missionId,
				tokenId: devTokId,
				summary: 'JWT verifier implemented and unit tested',
			});
			assert.strictEqual(devRet.ok, true);
			assert.strictEqual(devRet.returnedToNodeId, 'BE_Lead');
		});

		test('Per-node custom color picker (Context Menu -> Code Roundtrip -> Custom Card & Dept Accent) + persistent live baton edge comets', async () => {
			const { h, missionStore } = createMissionHarness();
			const orgGov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/color-gov-l1') }, 'Aria', { role: 'governor' });
			const created = missionStore.createMission({
				title: 'Hyperion Color Demo',
				ownerSessionId: orgGov.id,
				ownerTier: 1,
				projectUri: alpha.toString(),
				mermaidText: 'flowchart LR\n  T1["Spec"] --> T2["Build"]',
				orchestrationText: [
					'flowchart TD',
					'  %% layout radial',
					'  CEO["@Aria · Chief (L1)"] <--> AI["@Nova · AI Lead (L2)"]',
					'  subgraph AI_Dept["AI Kernel"]',
					'    AI <--> RAG["@Vex · Memory (L3)"]',
					'    WB_AI[("Whiteboard: AI Spec")]',
					'    %% whiteboard WB_AI [dept="AI Kernel", title="AI Spec", version=1]',
					'  end',
				].join('\n'),
			});

			const orchInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(created.id, 'orchestration')));
			const host = append(document.body, $('.monaco-workbench.ade-eng-color-picker-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 9, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			await pane.setInput(orchInput, undefined, {}, CancellationToken.None);

			// 1. Right-click CEO staff card -> inline Color Swatch Picker -> pick 'gold'
			const ceoEl = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="CEO"]')!;
			ceoEl.dispatchEvent(new mainWindow.MouseEvent('contextmenu', { clientX: 300, clientY: 220, bubbles: true, cancelable: true }));
			const goldSwatch = host.querySelector<HTMLButtonElement>('[data-ade-node-color-picker="true"] button[data-ade-color-swatch="gold"]')!;
			assert.ok(goldSwatch, 'Right-click context menu renders inline color swatch picker');
			goldSwatch.click();

			const updatedCeoEl = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="CEO"]')!;
			assert.strictEqual(updatedCeoEl.getAttribute('data-node-color'), 'gold');
			assert.ok(updatedCeoEl.classList.contains('has-custom-color'));
			assert.ok((missionStore.getMission(created.id)?.orchestrationText ?? '').includes('color=gold'), 'Node color persists losslessly in Orchestration code');

			// 2. Pick 'cyan' for AI Lead -> department frame harmonizes to cyan!
			const aiEl = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="AI"]')!;
			aiEl.dispatchEvent(new mainWindow.MouseEvent('contextmenu', { clientX: 400, clientY: 220, bubbles: true, cancelable: true }));
			host.querySelector<HTMLButtonElement>('[data-ade-node-color-picker="true"] button[data-ade-color-swatch="cyan"]')!.click();
			const deptRegion = host.querySelector<SVGGElement>('[data-ade-dept-region="AI Kernel"]')!;
			assert.ok(deptRegion.classList.contains('has-custom-dept-accent'), 'Department frame harmonizes accent color with its colored lead');

			// 3. Dispatch & mint a live token -> verify persistent glowing baton packet comet & waiting_join badge on canvas!
			const disp = await h.control<{ readonly tokenId: string }>('orchestration.dispatch', {
				mission: created.id,
				prompt: 'Build AI Kernel',
				target: 'CEO',
			});
			await h.control('token.mint', {
				mission: created.id,
				tokenId: disp.tokenId,
				to: 'AI',
				summary: 'Own AI Runtime',
				waitJoin: true,
			});
			await timeout(50);
			const ceoPuck = host.querySelector<HTMLElement>('[data-ade-orch-token-puck="CEO"]')!;
			assert.strictEqual(ceoPuck.getAttribute('data-token-status'), 'waiting_join', 'CEO displays live waiting_join baton badge');
			assert.ok(host.querySelector('[data-ade-orch-live-puck="CEO->AI"]'), 'Active token dispatch wire renders persistent glowing baton packet comet');

			// 4. Switch to Mission view & verify sculpted Task DAG cards (280x154, 14px radius, rectangular minimap) + pick 'rose' on Task T1 via context menu
			const missionInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(created.id, 'mission')));
			await pane.setInput(missionInput, undefined, {}, CancellationToken.None);
			const t1El = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="T1"]')!;
			assert.strictEqual(t1El.getAttribute('data-node-shape'), 'sculpted-card', 'Mission Task DAG node renders with sculpted card shape attribute');
			const t1Card = t1El.querySelector<HTMLElement>('.ade-mission-node-card.is-task-card.is-sculpted-task')!;
			assert.ok(t1Card, 'Mission Task DAG card uses sculpted task class');
			const t1CardStyle = mainWindow.getComputedStyle(t1Card);
			assert.strictEqual(t1CardStyle.width, '280px');
			assert.strictEqual(t1CardStyle.height, '154px');
			assert.strictEqual(t1CardStyle.borderRadius, '14px');
			assert.strictEqual(t1Card.querySelectorAll('.ade-mission-clamp').length, 0, 'Sculpted task card omits rectangular corner clamps');
			const t1Minimap = host.querySelector<SVGRectElement>('[data-minimap-node="T1"]');
			assert.strictEqual(t1Minimap?.getAttribute('data-minimap-shape'), 'rect', 'Minimap reflects rectangular Mission Task DAG node');
			t1El.dispatchEvent(new mainWindow.MouseEvent('contextmenu', { clientX: 280, clientY: 220, bubbles: true, cancelable: true }));
			host.querySelector<HTMLButtonElement>('[data-ade-node-color-picker="true"] button[data-ade-color-swatch="rose"]')!.click();
			const updatedT1 = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="T1"]')!;
			assert.strictEqual(updatedT1.getAttribute('data-node-color'), 'rose');
			assert.ok((missionStore.getMission(created.id)?.mermaidText ?? '').includes('color=rose'), 'Mission task color persists in Mermaid code');
		});

		test('Real End-to-End Autonomous Engineering Loop: User Chat -> L1 Root Split -> L2 Dynamic Staff/Config/Task Scope -> AllowedPaths -> Cold Blob Compaction -> Abort Stop -> Final Inbox Delivery', async () => {
			const storedBlobs = new Map<string, string>();
			const archivedLines: string[] = [];
			const stoppedResources: string[] = [];
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const inbox = h.instantiation.get(IAdeInboxService);
			const backendStub: IAdeEngineeringBackendService = {
				_serviceBrand: undefined,
				loadInbox: async () => [],
				saveInbox: async () => undefined,
				saveOrchestrationBlobs: async (_mid, blobs) => {
					for (const b of blobs) {
						storedBlobs.set(b.ptr, b.payloadJson);
					}
				},
				readOrchestrationBlob: async (_mid, ptr) => storedBlobs.get(ptr),
				appendOrchestrationArchive: async (_mid, lines) => {
					archivedLines.push(...lines);
				},
				readOrchestrationArchive: async () => archivedLines,
			};
			h.instantiation.stub(IAdeEngineeringBackendService, backendStub);
			const sessionsSvc = h.instantiation.get(IAdeSessionsService);
			const origStop = sessionsSvc.stop?.bind(sessionsSvc);
			(sessionsSvc as { stop?: typeof sessionsSvc.stop }).stop = async (session, opts) => {
				stoppedResources.push(session.resource.toString());
				if (origStop) {
					await origStop(session, opts);
				}
			};

			const govAgent = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/e2e-gov-l1') }, 'Aria', { role: 'governor' });
			const created = missionStore.createMission({
				title: 'Autonomous Shipping E2E',
				ownerSessionId: govAgent.id,
				ownerTier: 1,
				projectUri: alpha.toString(),
				mermaidText: [
					'flowchart LR',
					'  T_SPEC["Architecture Spec"] --> T_BE["Backend API"]',
					'  T_SPEC --> T_FE["Frontend UI"]',
					'  T_BE --> T_SHIP["Final Release"]',
					'  T_FE --> T_SHIP',
					'  %% task T_SPEC [owner=CEO, dept="Executive"]',
					'  %% task T_BE [owner=BE_Lead, dept="Backend", min_tier=2]',
					'  %% task T_FE [owner=FE_Lead, dept="Frontend", min_tier=2]',
					'  %% task T_SHIP [owner=CEO, dept="Executive"]',
				].join('\n'),
				orchestrationText: [
					'flowchart TD',
					'  CEO["@Aria · Chief Architect (L1)"] <--> BE_Lead["@Bob · Backend Lead (L2)"]',
					'  CEO <--> FE_Lead["@Carol · Frontend Lead (L2)"]',
					'  %% staff CEO [tier=1, dept="Executive", role_prompt="Own global architecture and verify final releases."]',
					'  subgraph Backend["Backend"]',
					'    BE_Lead <--> BE_Dev["@Dave · Backend Dev (L4)"]',
					'    %% staff BE_Dev [tier=4, dept="Backend", role_prompt="Implement backend handlers only.", paths="src/backend|tests/backend"]',
					'    WB_BE[("Whiteboard: Backend Spec")]',
					'    %% whiteboard WB_BE [dept="Backend", title="Backend Spec", version=1]',
					'  end',
					'  subgraph Frontend["Frontend"]',
					'    FE_Lead',
					'    WB_FE[("Whiteboard: Frontend Spec")]',
					'    %% whiteboard WB_FE [dept="Frontend", title="Frontend Spec", version=1]',
					'  end',
				].join('\n'),
			});
			const missionId = created.id;
			const orchState0 = missionRuntime.getOrchestrationState(missionId);
			const beLeadAgentId = orchState0.nodeAgentIds.BE_Lead!;
			const feLeadAgentId = orchState0.nodeAgentIds.FE_Lead!;
			const beDevAgentId = orchState0.nodeAgentIds.BE_Dev!;
			assert.ok(beLeadAgentId && feLeadAgentId && beDevAgentId, 'All Orchestration staff synced to unique agents');

			// 1. Verify staff node rolePrompt & allowedPaths are injected directly into resolveAdePromptContext (not wakeup-only!)
			const cmdService = h.instantiation.get(ICommandService);
			const ceoCtx = (await cmdService.executeCommand<string | undefined>(ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID, { agentId: govAgent.id })) ?? '';
			assert.ok(ceoCtx.includes('Own global architecture and verify final releases.'), 'L1 role context includes staff rolePrompt');
			const devCtx = (await cmdService.executeCommand<string | undefined>(ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID, { agentId: beDevAgentId })) ?? '';
			assert.ok(devCtx.includes('Implement backend handlers only.'), 'L4 pure staff role context includes staff rolePrompt');
			assert.ok(devCtx.includes('src/backend'), 'L4 pure staff role context includes allowedPaths');

			// 2. Human User chats directly with L1 Governor (session.send wraps with User envelope)
			const userSend = await h.control<{ readonly status: string }>('session.send', { id: govAgent.id, message: 'Ship the auth feature end-to-end.' });
			assert.strictEqual(userSend.status, 'sent');
			const lastUserPrompt = h.sentChatRequests[h.sentChatRequests.length - 1]?.message ?? '';
			assert.ok(lastUserPrompt.includes('[Aexus System · Message from User (L-1)]'));

			// 3. L1 Governor IMMEDIATELY splits work downward WITHOUT any pre-existing parentTokenId!
			const govCaller = { caller: 'governor', _verifiedCaller: true, _callerSessionId: govAgent.id };
			const beLeadCaller = { caller: 'manager', _verifiedCaller: true, _callerSessionId: beLeadAgentId };
			const beDevCaller = { caller: 'worker', _verifiedCaller: true, _callerSessionId: beDevAgentId };
			const feLeadCaller = { caller: 'manager', _verifiedCaller: true, _callerSessionId: feLeadAgentId };

			// Also verify L1 completes T_SPEC before downstream tasks run
			await h.control('mission.task.complete', { ...govCaller, mission: missionId, node: 'T_SPEC', note: 'Architecture approved' });

			const hugeSpec = 'A'.repeat(1600);
			const splitRes = await h.control<{
				readonly ok: boolean;
				readonly parentTokenId: string;
				readonly createdRootParent?: boolean;
				readonly reusedActiveRootParent?: boolean;
				readonly joinBarrierId?: string;
				readonly branches: readonly { readonly tokenId: string; readonly toNodeId: string; readonly payloadPtr?: string }[];
			}>('token.split', {
				...govCaller,
				mission: missionId,
				branchesJson: JSON.stringify([
					{ toNodeId: 'BE_Lead', summary: 'Build auth backend', detail: hugeSpec, taskNodeId: 'T_BE' },
					{ toNodeId: 'FE_Lead', summary: 'Build auth frontend', taskNodeId: 'T_FE' },
				]),
				waitJoin: true,
			});
			assert.strictEqual(splitRes.ok, true);
			assert.strictEqual(splitRes.reusedActiveRootParent, true, 'Omitted parentTokenId seamlessly adopts the active root baton auto-minted by User chat (zero orphan leak)');
			assert.ok(splitRes.joinBarrierId);
			const rootTokId = splitRes.parentTokenId;
			const beLeadTokId = splitRes.branches.find(b => b.toNodeId === 'BE_Lead')!.tokenId;
			const feLeadTokId = splitRes.branches.find(b => b.toNodeId === 'FE_Lead')!.tokenId;
			const specPtr = splitRes.branches.find(b => b.toNodeId === 'BE_Lead')!.payloadPtr!;

			// Wait microtasks for automatic disk-first cold compaction of hugeSpec (>1024 chars)!
			await timeout(30);
			assert.ok(storedBlobs.has(specPtr), 'automatic compaction externalized >1024-char blob to cold storage');
			assert.strictEqual(missionRuntime.getOrchestrationState(missionId).payloadStore?.[specPtr], undefined, 'externalized blob pruned from hot payloadStore');
			const readCold = await h.control<{ readonly items: readonly { readonly ok: boolean; readonly content?: string }[] }>('token.read', {
				...beLeadCaller,
				mission: missionId,
				tokenId: beLeadTokId,
				ptrs: [specPtr],
			});
			assert.strictEqual(readCold.items[0]?.ok, true);
			assert.strictEqual(readCold.items[0]?.content, hugeSpec, 'token.read transparently hydrates cold externalized blob');

			// 4. L2 BE_Lead can configure its own direct subordinate, create tasks in Backend, but CANNOT touch Frontend or L1!
			const cfgSub = await h.control<{ readonly ok: boolean }>('orchestration.staff.configure', {
				...beLeadCaller,
				mission: missionId,
				node: 'BE_Dev',
				model: 'deepseek-reasoner',
				color: 'cyan',
			});
			assert.strictEqual(cfgSub.ok, true, 'L2 Manager can configure direct subordinate in own department');
			await assert.rejects(
				() => h.control('orchestration.staff.configure', { ...beLeadCaller, mission: missionId, node: 'FE_Lead', model: 'gpt-5' }),
				/FORBIDDEN|CROSS_DEPARTMENT_FORBIDDEN/i,
			);
			await assert.rejects(
				() => h.control('mission.task.update', { ...beLeadCaller, mission: missionId, node: 'T_FE', title: 'Hijacked' }),
				/CROSS_DEPARTMENT_FORBIDDEN/i,
			);
			await assert.rejects(
				() => h.control('mission.task.set', { ...beDevCaller, mission: missionId, node: 'T_BE', description: 'Worker hijack' }),
				/FORBIDDEN|Permission denied/i,
			);

			// 5. Pure-execution L4 worker can call read-only rank.names as documented in ENGINEERING_API.md!
			const rankNames = await h.control<{ readonly namesByTier?: Record<string, string>; readonly rankCount?: number }>('rank.names', { ...beDevCaller });
			assert.ok(rankNames.namesByTier && Object.keys(rankNames.namesByTier).length >= 1, 'L4 Engineering staff can inspect live rank names');

			// 6. L2 BE_Lead delegates to L4 BE_Dev -> allowedPaths enforced on return -> L2 returns -> FE_Lead returns -> Join Barrier wakes L1!
			const devMint = await h.control<{ readonly mintedTokenIds: readonly string[] }>('token.mint', {
				...beLeadCaller,
				mission: missionId,
				parentTokenId: beLeadTokId,
				to: 'BE_Dev',
				summary: 'Write auth handler',
				waitJoin: false,
			});
			const devTokId = devMint.mintedTokenIds[0];
			await assert.rejects(
				() => h.control('token.return', { ...beDevCaller, mission: missionId, tokenId: devTokId, summary: 'Bad edit', modifiedFiles: ['src/frontend/index.ts'] }),
				/ALLOWED_PATHS_VIOLATION/i,
			);
			const devRet = await h.control<{ readonly ok: boolean }>('token.return', {
				...beDevCaller,
				mission: missionId,
				tokenId: devTokId,
				summary: 'Auth handler done',
				modifiedFiles: ['src/backend/auth.ts'],
			});
			assert.strictEqual(devRet.ok, true);

			await h.control('mission.task.complete', { ...beLeadCaller, mission: missionId, node: 'T_BE', note: 'Verified BE_Dev output' });
			await h.control('token.return', { ...beLeadCaller, mission: missionId, tokenId: beLeadTokId, summary: 'Backend API complete' });
			await h.control('mission.task.complete', { ...feLeadCaller, mission: missionId, node: 'T_FE', note: 'Verified UI' });
			const feRet = await h.control<{ readonly barrierSatisfied?: boolean }>('token.return', { ...feLeadCaller, mission: missionId, tokenId: feLeadTokId, summary: 'Frontend UI complete' });
			assert.strictEqual(feRet.barrierSatisfied, true);
			assert.strictEqual(missionRuntime.getOrchestrationState(missionId).tokens[rootTokId].status, 'active', 'Join Barrier re-activated L1 root token');

			// 7. L1 completes T_SHIP and concludes root wave -> User receives final completion message in ADE Inbox!
			await h.control('mission.task.complete', { ...govCaller, mission: missionId, node: 'T_SHIP', note: 'All checks green' });
			const finished = await h.control<{ readonly finished?: boolean }>('token.complete', {
				...govCaller,
				mission: missionId,
				tokenId: rootTokId,
				finish: true,
				summary: 'Auth feature shipped cleanly',
			});
			assert.strictEqual(finished.finished, true);
			const inboxItems = inbox.list({ includeResolved: false });
			assert.ok(inboxItems.some(i => i.title.includes('Engineering Delivery Completed') && i.message.includes('Auth feature shipped cleanly')), 'Final completion report posted to Human ADE Inbox');

			// 8. Verify orchestration.abort stops live running agent sessions!
			const beLeadAgent = h.projects.getAgent(beLeadAgentId)!;
			h.projects.bindSession(beLeadAgent.id, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/e2e-be-lead-live') });
			const wave2 = await h.control<{ readonly mintedTokenIds: readonly string[] }>('token.mint', {
				...govCaller,
				mission: missionId,
				to: 'BE_Lead',
				summary: 'Start hotfix wave',
				waitJoin: false,
			});
			assert.strictEqual(wave2.mintedTokenIds.length, 1);
			await assert.rejects(
				() => h.control('orchestration.abort', { ...beLeadCaller, mission: missionId, reason: 'Subordinate unauthorized abort' }),
				/Permission denied/i,
			);
			await h.control('orchestration.abort', { ...govCaller, mission: missionId, reason: 'Cancel hotfix' });
			assert.ok(stoppedResources.includes('aexus-claude:/e2e-be-lead-live'), 'orchestration.abort stops live running engine session for aborted token holder');
		});

		test('Core Reliability Regressions: omitted --mission --id disambiguation, cold engine/model/thinking/SSH inheritance, L2 escalate/host.bind/staff checks, and headless pendingEffects reload recovery', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();
			const govAgent = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/reg-gov-l1') }, 'Aria', { role: 'governor' });
			const created = missionStore.createMission({
				title: 'Core Reliability Regression Suite',
				ownerSessionId: govAgent.id,
				ownerTier: 1,
				projectUri: alpha.toString(),
				mermaidText: [
					'flowchart LR',
					'  T_API["Build API"]',
					'  %% task T_API [owner=BE_Lead, dept="Backend"]',
				].join('\n'),
				orchestrationText: [
					'flowchart TD',
					'  CEO["@Aria · Governor (L1)"] <--> BE_Lead["@Bob · Backend Lead (L2)"]',
					'  subgraph Backend["Backend"]',
					'    BE_Lead',
					'    WB_BE[("Whiteboard: Backend Spec")]',
					'    %% staff BE_Lead [tier=2, dept="Backend", engine="codex", model="gpt-5", thinking="medium", host="gpu-cluster"]',
					'    %% whiteboard WB_BE [dept="Backend", title="Backend Spec", version=1]',
					'  end',
				].join('\n'),
			});
			const missionId = created.id;

			// 1. Applying orchestration graph binds normalized short engine alias ('codex' -> 'aexus-codex'), model, thinking, and SSH hostAlias to cold subordinate staff!
			await h.control('orchestration.apply', {
				mission: missionId,
				text: created.orchestrationText!,
			});
			const orch0 = missionRuntime.getOrchestrationState(missionId);
			const beLeadAgentId = orch0.nodeAgentIds.BE_Lead!;
			const beLeadAgent = h.projects.getAgent(beLeadAgentId)!;
			assert.strictEqual(beLeadAgent.preferredEngineId, 'aexus-codex', 'Short engine alias normalized to aexus-codex on cold staff');
			assert.strictEqual(beLeadAgent.preferredModel, 'gpt-5', 'Cold subordinate inherits model from orchestration config');
			assert.strictEqual(beLeadAgent.preferredThinking, 'medium', 'Cold subordinate inherits thinking from orchestration config');
			assert.strictEqual(missionRuntime.getRuntimeState(missionId).boundary.nodeAssignments.BE_Lead?.hostAlias, 'gpu-cluster', 'Non-local hostAlias binds onto mission nodeAssignments');

			const beLeadCaller = { caller: 'manager', _verifiedCaller: true, _callerSessionId: beLeadAgentId };

			// 2. Omitting --mission with colliding --id works across whiteboard.write/read, mission.task.create, and orchestration.staff.create!
			const wbWriteNoMission = await h.control<{ readonly ok: boolean; readonly whiteboard: { readonly whiteboardId: string; readonly version: number } }>('whiteboard.write', {
				...beLeadCaller,
				id: 'WB_BE',
				content: 'Backend contract v2',
			});
			assert.strictEqual(wbWriteNoMission.ok, true);
			assert.strictEqual(wbWriteNoMission.whiteboard.whiteboardId, 'WB_BE');
			assert.strictEqual(wbWriteNoMission.whiteboard.version, 2);

			const wbReadNoMission = await h.control<{ readonly whiteboard: { readonly content: string } }>('whiteboard.read', {
				...beLeadCaller,
				id: 'WB_BE',
			});
			assert.strictEqual(wbReadNoMission.whiteboard.content, 'Backend contract v2');

			const taskCreateNoMission = await h.control<{ readonly ok: boolean; readonly nodeId?: string }>('mission.task.create', {
				...beLeadCaller,
				id: 'T_CACHE',
				title: 'Cache Layer',
				ownerNodeId: 'BE_Lead',
				department: 'Backend',
			});
			assert.strictEqual(taskCreateNoMission.ok, true);
			assert.ok(missionStore.getMission(missionId)?.mermaidText.includes('T_CACHE'));

			const staffCreateNoMission = await h.control<{ readonly ok: boolean; readonly nodeId: string; readonly agentId?: string }>('orchestration.staff.create', {
				...beLeadCaller,
				id: 'BE_Sub',
				name: 'Sub Eng',
				rank: 'L3',
				department: 'Backend',
				engineId: 'claude',
				model: 'claude-sonnet-4-6',
				thinking: 'high',
				hostAlias: 'gpu-sub-1',
			});
			assert.strictEqual(staffCreateNoMission.ok, true);
			assert.strictEqual(staffCreateNoMission.nodeId, 'BE_Sub');
			const beSubAgent = h.projects.getAgent(staffCreateNoMission.agentId!)!;
			assert.strictEqual(beSubAgent.preferredEngineId, 'aexus-claude', 'Dynamic recruit normalizes engine alias');
			assert.strictEqual(beSubAgent.preferredModel, 'claude-sonnet-4-6');
			assert.strictEqual(beSubAgent.preferredThinking, 'high');
			assert.strictEqual(missionRuntime.getRuntimeState(missionId).boundary.nodeAssignments.BE_Sub?.hostAlias, 'gpu-sub-1');

			// 3. Mid-tier L2 supervisor can configure Orchestration staff host & checks and escalate upward via org.escalate!
			const hostRebind = await h.control<{ readonly ok: boolean; readonly assignment?: { readonly hostAlias?: string } }>('mission.host.bind', {
				...beLeadCaller,
				mission: missionId,
				nodeId: 'BE_Sub',
				hostAlias: 'gpu-sub-2',
			});
			assert.strictEqual(hostRebind.ok, true);
			assert.strictEqual(hostRebind.assignment?.hostAlias, 'gpu-sub-2');

			const checkSet = await h.control<{ readonly nodeId: string; readonly checks: readonly { readonly id: string }[] }>('mission.check.set', {
				...beLeadCaller,
				mission: missionId,
				nodeId: 'BE_Sub',
				command: 'echo ok',
				label: 'Smoke check',
			});
			assert.strictEqual(checkSet.nodeId, 'BE_Sub');
			assert.strictEqual(checkSet.checks.length, 1);

			const escalateRes = await h.control<{ readonly ok: boolean; readonly escalatedTo?: string; readonly escalatedToNodeId?: string }>('org.escalate', {
				...beLeadCaller,
				mission: missionId,
				reason: 'Need executive approval on Redis cluster budget',
			});
			assert.strictEqual(escalateRes.ok, true);
			assert.strictEqual(escalateRes.escalatedToNodeId, 'CEO', 'L2 Orchestration org.escalate routes directly to L1 CEO superior');

			// 4. sanitizeMissionRecord preserves all rich live Task DAG fields across store updates
			missionStore.updateTaskStatuses(missionId, {
				T_API: {
					status: 'in_progress',
					updatedAt: 12345,
					assigneeNodeId: 'BE_Lead',
					assigneeLabel: '@Bob · Backend Lead (L2)',
					activeTokenIds: ['otok-9'],
					lastTokenId: 'otok-9',
					startedAt: 12000,
					durationMs: 345,
					artifactPtrs: ['art-1'],
					blockedReason: 'Waiting on schema',
					lastError: 'Transient timeout',
					completedByTier: 2,
				},
			});
			const persistedTask = missionStore.getMission(missionId)?.taskStatuses?.T_API;
			assert.strictEqual(persistedTask?.assigneeNodeId, 'BE_Lead');
			assert.strictEqual(persistedTask?.assigneeLabel, '@Bob · Backend Lead (L2)');
			assert.deepStrictEqual(persistedTask?.activeTokenIds, ['otok-9']);
			assert.strictEqual(persistedTask?.lastTokenId, 'otok-9');
			assert.strictEqual(persistedTask?.startedAt, 12000);
			assert.strictEqual(persistedTask?.durationMs, 345);
			assert.deepStrictEqual(persistedTask?.artifactPtrs, ['art-1']);
			assert.strictEqual(persistedTask?.blockedReason, 'Waiting on schema');
			assert.strictEqual(persistedTask?.lastError, 'Transient timeout');
			assert.strictEqual(persistedTask?.completedByTier, 2);

			// 5. Headless pendingHeadlessEffects drain & reload recovery dispatches queued CEO wakeup once without duplicate replay
			const prevDispatches = h.executedCommands.filter(c => c.id === 'aexus.agentEngines.dispatchEngineeringTurn').length;
			const curOrch = missionRuntime.getOrchestrationState(missionId);
			missionStore.updateOrchestrationRuntime(missionId, {
				...curOrch,
				status: 'running',
				tokenSeq: curOrch.tokenSeq + 1,
				tokens: {
					...curOrch.tokens,
					'otok-headless-1': {
						id: 'otok-headless-1',
						waveId: 'wave-headless',
						nodeId: 'CEO',
						holderAgentId: govAgent.id,
						status: 'active',
						lastSummary: 'Joined headlessly while window was closed',
						compressedHistory: 'BE_Lead returned headlessly.',
						tracePtr: 'otrc-headless-1',
						arrivedAt: Date.now() - 1000,
						lastActivityAt: Date.now(),
						nudgeCount: 0,
						hopIndex: 1,
						hopLog: [{ hop: 1, tokenId: 'otok-headless-1', event: 'join_resume', fromNodeId: 'BE_Lead', toNodeId: 'CEO', headline: 'Joined headlessly while window was closed', timestamp: Date.now() }],
					},
				},
				pendingHeadlessEffects: [{
					kind: 'dispatch_token',
					missionId,
					nodeId: 'CEO',
					tokenId: 'otok-headless-1',
					holderAgentId: govAgent.id,
					prompt: 'Headless join resume for CEO',
				}],
			});
			const resumed = await missionRuntime.recoverInterruptedActiveTokens(missionId);
			const afterDispatches = h.executedCommands.filter(c => c.id === 'aexus.agentEngines.dispatchEngineeringTurn').length;
			assert.strictEqual(resumed, 1, 'recoverInterruptedActiveTokens returns 1 drained headless wakeup');
			assert.strictEqual(afterDispatches - prevDispatches, 1, 'Recovery must dispatch pending headless wakeup exactly once without duplicate replay');
			assert.strictEqual(
				missionRuntime.getOrchestrationState(missionId).pendingHeadlessEffects,
				undefined,
				'pendingHeadlessEffects must be cleared after draining',
			);
		});

		test('Standalone User-created Orchestration: L1 has full blueprint apply/orchestrator slot, zero legacy prompt fallback & direct User chat auto-mints root otok baton', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();

			// 1. Human User creates a standalone Engineering workspace (ownerSessionId = undefined, ownerTier = -1)
			const created = await h.control<{ readonly id: string; readonly ownerSessionId?: string; readonly ownerTier: number }>('mission.init', {
				title: 'User Standalone Org',
				project: alpha.toString(),
			});
			assert.strictEqual(created.ownerSessionId, undefined, 'Standalone User workspace starts with empty ownerSessionId');
			assert.strictEqual(created.ownerTier, -1, 'Standalone User workspace starts with L-1 ownerTier');

			const orchMermaid = [
				'flowchart TD',
				'  CEO["@Aria · Chief Architect (L1)"] <--> BE["@Orion · Backend Lead (L2)"]',
				'  BE <--> W1["@Sora · Ledger Worker (L4)"]',
			].join('\n');
			const appliedOrch = await h.control<{ readonly ok: boolean }>('orchestration.apply', {
				mission: created.id,
				text: orchMermaid,
			});
			assert.strictEqual(appliedOrch.ok, true);

			const employees = missionStore.getGeneratedEmployees(created.id);
			const ceoAgent = employees.find(e => e.treeNodeId === 'CEO' || e.label.includes('Aria'))!;
			const beAgent = employees.find(e => e.treeNodeId === 'BE' || e.label.includes('Orion'))!;
			const workerAgent = employees.find(e => e.treeNodeId === 'W1' || e.label.includes('Sora'))!;
			assert.ok(ceoAgent && beAgent && workerAgent, 'All 3 standalone Orchestration staff synced to sidebar');
			assert.strictEqual(ceoAgent.treeType, 'engineering', 'Orchestration staff synced with treeType=engineering');
			assert.strictEqual(ceoAgent.role, 'governor', 'L1 CEO keeps governor rank without cutoff demotion');
			assert.strictEqual(beAgent.role, 'manager', 'L2 Backend Lead keeps manager rank');

			// 2. Prompt injection: ZERO fallback to legacy minimal `[Aexus ADE · Mission Node Employee]`, and ZERO L1 slot downgrade!
			const sessionsSvc = h.instantiation.get(IAdeSessionsService);
			const ceoPromptWithRuntime = buildAdeAgentRoleContext(h.projects, sessionsSvc, ceoAgent, DEFAULT_ADE_ORGANIZATION_CONFIG, undefined, missionRuntime, missionStore);
			const ceoPromptStoreOnly = buildAdeAgentRoleContext(h.projects, sessionsSvc, ceoAgent, DEFAULT_ADE_ORGANIZATION_CONFIG, undefined, undefined, missionStore);
			const bePrompt = buildAdeAgentRoleContext(h.projects, sessionsSvc, beAgent, DEFAULT_ADE_ORGANIZATION_CONFIG, undefined, undefined, missionStore);
			const workerPrompt = buildAdeAgentRoleContext(h.projects, sessionsSvc, workerAgent, DEFAULT_ADE_ORGANIZATION_CONFIG, undefined, undefined, missionStore);

			for (const p of [ceoPromptWithRuntime, ceoPromptStoreOnly]) {
				assert.ok(p?.includes('[Aexus Orchestrated Role Context]'), 'L1 receives full Orchestrated Role Context');
				assert.ok(!p?.includes('[Aexus ADE · Mission Node Employee]'), 'L1 must NEVER fall back to legacy minimal mission node prompt');
				assert.ok(p?.includes('Top Orchestrator'), 'L1 on standalone User Orchestration keeps top orchestrator slot (no segment_owner downgrade)');
				assert.ok(p?.includes(`mission blueprint apply --mission ${created.id}`), 'L1 prompt advertises full Task DAG blueprint apply capability');
			}
			assert.ok(bePrompt?.includes('[Aexus Orchestrated Role Context]') && !bePrompt?.includes('[Aexus ADE · Mission Node Employee]'), 'L2 receives full Engineering Orchestration prompt without legacy fallback');
			assert.ok(workerPrompt?.includes('[Aexus ADE · Engineering Staff Context]') && !workerPrompt?.includes('[Aexus ADE · Mission Node Employee]'), 'L4 leaf receives new Engineering Staff Context without legacy fallback');

			// 3. L1 on standalone User workspace CAN run mission.blueprint.apply (even omitting --mission!), mission.blueprint.get, mission.open & sees canOperate=true!
			const listAsCeo = await h.control<readonly { readonly id: string; readonly canOperate: boolean; readonly canRead: boolean }[]>('mission.list', {
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: ceoAgent.id,
			});
			const ceoMissionRow = listAsCeo.find(m => m.id === created.id);
			assert.strictEqual(ceoMissionRow?.canOperate, true, 'L1 top-rank staff sees canOperate=true on standalone User Orchestration');
			assert.strictEqual(ceoMissionRow?.canRead, true, 'L1 top-rank staff sees canRead=true on standalone User Orchestration');

			const bpApplyRes = await h.control<{ readonly id: string; readonly nodeCount: number }>('mission.blueprint.apply', {
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: ceoAgent.id,
				text: 'flowchart LR\n  T1["Design Billing API"] --> T2["Implement & Test"]',
			});
			assert.strictEqual(bpApplyRes.id, created.id, 'L1 resolves standalone mission automatically even when --mission is omitted');
			assert.strictEqual(bpApplyRes.nodeCount, 2, 'L1 applies Mission Task DAG blueprint with zero FORBIDDEN error');

			const bpGetAsCeo = await h.control<{ readonly id: string; readonly canOperate: boolean; readonly mermaidText: string }>('mission.blueprint.get', {
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: ceoAgent.id,
			});
			assert.strictEqual(bpGetAsCeo.id, created.id);
			assert.strictEqual(bpGetAsCeo.canOperate, true);
			assert.ok(bpGetAsCeo.mermaidText.includes('Design Billing API'));

			// L2 subordinate must still be denied structural blueprint.apply overwrite
			await assert.rejects(
				() => h.control('mission.blueprint.apply', {
					caller: 'manager',
					_verifiedCaller: true,
					_callerSessionId: beAgent.id,
					mission: created.id,
					text: 'flowchart LR\n  X1["Unauthorized"]',
				}),
				/Permission denied|FORBIDDEN/i,
				'Non-top-rank L2 staff must remain blocked from overwriting standalone mission blueprint',
			);

			// 4. Direct interactive User chat to L1 auto-mints a real root `otok-*` baton token!
			const firstTurn = missionRuntime.beginInteractiveTurn(ceoAgent.id, {
				userPrompt: 'Refactor billing module and run regression suite',
				isDirectUserChat: true,
			});
			assert.ok(firstTurn?.tokenId?.startsWith('otok-'), 'Direct User chat to L1 auto-mints a real root otok-* baton');
			assert.strictEqual(firstTurn?.autoMintedRootToken, true);
			assert.strictEqual(firstTurn?.missionId, created.id);
			assert.strictEqual(firstTurn?.nodeId, 'CEO');

			// Calling beginInteractiveTurn again while active reuses the active root baton (zero duplicate minting)
			const secondTurn = missionRuntime.beginInteractiveTurn(ceoAgent.id, {
				userPrompt: 'Also include edge cases',
				isDirectUserChat: true,
			});
			assert.strictEqual(secondTurn?.tokenId, firstTurn?.tokenId, 'Active root baton is reused on follow-up turn without double-minting');
			assert.strictEqual(secondTurn?.autoMintedRootToken, undefined);

			// L1 immediately sees the auto-minted root baton via `token.current` and can `token.split` downward from it!
			const currentTokens = await h.control<{ readonly tokens: readonly { readonly id: string; readonly nodeId: string }[] }>('token.current', {
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: ceoAgent.id,
			});
			assert.ok(currentTokens.tokens.some(t => t.id === firstTurn!.tokenId && t.nodeId === 'CEO'), 'L1 sees auto-minted root baton via token.current');

			const splitRes = await h.control<{ readonly ok: boolean; readonly mintedTokenIds: readonly string[]; readonly parentTokenId: string }>('token.split', {
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: ceoAgent.id,
				parentTokenId: firstTurn!.tokenId,
				to: ['BE'],
				summary: 'Implement billing refactor on T2',
				task: 'T2',
			});
			assert.strictEqual(splitRes.ok, true, 'L1 delegates downward directly from auto-minted root baton');
			assert.strictEqual(splitRes.parentTokenId, firstTurn!.tokenId);
			assert.strictEqual(splitRes.mintedTokenIds.length, 1);

			// L1 can also run full orchestration lifecycle controls (pause/resume) on standalone User workspace
			const paused = await h.control<{ readonly ok: boolean; readonly status?: string }>('orchestration.pause', {
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: ceoAgent.id,
			});
			assert.strictEqual(paused.ok, true, 'L1 can pause standalone User Orchestration without FORBIDDEN');
			const resumed = await h.control<{ readonly ok: boolean; readonly status?: string }>('orchestration.resume', {
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: ceoAgent.id,
			});
			assert.strictEqual(resumed.ok, true, 'L1 can resume standalone User Orchestration without FORBIDDEN');

			// 5. L2 returns child baton -> Join Barrier wakes L1 CEO -> L1 completes root baton -> Human User CLI `session.send` auto-mints a new root baton & embeds it in the User envelope!
			await h.control('token.return', {
				caller: 'manager',
				_verifiedCaller: true,
				_callerSessionId: beAgent.id,
				tokenId: splitRes.mintedTokenIds[0],
				summary: 'Billing refactor implemented and verified',
			});
			await h.control('token.complete', {
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: ceoAgent.id,
				tokenId: firstTurn!.tokenId,
				summary: 'First wave delivered and verified',
			});
			h.projects.bindSession(ceoAgent.id, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/standalone-ceo-session') });
			const userSendRes = await h.control<{ readonly status: string }>('session.send', {
				id: ceoAgent.id,
				message: 'Start phase 2 audit',
			});
			assert.strictEqual(userSendRes.status, 'sent');
			const deliveredPrompt = h.sentChatRequests[h.sentChatRequests.length - 1]?.message ?? '';
			assert.ok(deliveredPrompt.includes('[Aexus System · Message from User (L-1)]'), 'Human session.send wraps with User envelope');
			assert.ok(deliveredPrompt.includes('Root Baton Issued: `otok-'), 'Human session.send to L1 embeds auto-minted root otok-* baton in User envelope');

			// Direct User chat to non-top-rank L2 does NOT mint a root baton
			const beDirectTurn = missionRuntime.beginInteractiveTurn(beAgent.id, {
				userPrompt: 'Quick status question',
				isDirectUserChat: true,
			});
			assert.strictEqual(beDirectTurn?.autoMintedRootToken, undefined, 'Direct chat to L2 does not auto-mint a new root baton');
		});

		test('Unified otok Split/Join + Peer-Forwarded Barrier Continuity + First-Class token.reject (3 directions) + token.fail/retry + zero dual-track tok-* leakage', async () => {
			const { h, missionStore, missionRuntime } = createMissionHarness();

			const created = await h.control<{ readonly id: string }>('mission.init', {
				title: 'Unified Token Bus E2E',
				project: alpha.toString(),
			});
			const missionId = created.id;
			await h.control('orchestration.apply', {
				mission: missionId,
				text: [
					'flowchart TD',
					'  CEO["@Aria · Chief Architect (L1)"] <--> BE_Lead["@Bob · Backend Lead (L2)"]',
					'  CEO <--> FE_Lead["@Carol · Frontend Lead (L2)"]',
					'  subgraph Backend["Backend"]',
					'    BE_Lead <--> Dev["@Dave · Backend Dev (L4)"]',
					'    Dev <--> QA["@Eve · Backend QA (L4)"]',
					'    QA <--> BE_Lead',
					'  end',
				].join('\n'),
			});
			await h.control('mission.blueprint.apply', {
				mission: missionId,
				text: [
					'flowchart LR',
					'  T_BE["Backend API"] --> T_SHIP["Release"]',
					'  T_FE["Frontend UI"] --> T_SHIP',
				].join('\n'),
			});

			const orch0 = missionRuntime.getOrchestrationState(missionId);
			const ceoId = orch0.nodeAgentIds.CEO!;
			const beLeadId = orch0.nodeAgentIds.BE_Lead!;
			const feLeadId = orch0.nodeAgentIds.FE_Lead!;
			const devId = orch0.nodeAgentIds.Dev!;
			const qaId = orch0.nodeAgentIds.QA!;
			const ceoCaller = { caller: 'governor', _verifiedCaller: true, _callerSessionId: ceoId };
			const beCaller = { caller: 'manager', _verifiedCaller: true, _callerSessionId: beLeadId };
			const feCaller = { caller: 'manager', _verifiedCaller: true, _callerSessionId: feLeadId };
			const devCaller = { caller: 'worker', _verifiedCaller: true, _callerSessionId: devId };
			const qaCaller = { caller: 'worker', _verifiedCaller: true, _callerSessionId: qaId };

			// 1. Heterogeneous Split from L1 (`parentTokenId: 'new'`) creates root parent + Join Barrier across BE_Lead & FE_Lead
			const split = await h.control<{
				readonly ok: boolean;
				readonly parentTokenId: string;
				readonly createdRootParent?: boolean;
				readonly joinBarrierId?: string;
				readonly branches: readonly { readonly tokenId: string; readonly toNodeId: string; readonly taskNodeId?: string }[];
			}>('token.split', {
				...ceoCaller,
				mission: missionId,
				parentTokenId: 'new',
				branchesJson: JSON.stringify([
					{ toNodeId: 'BE_Lead', summary: 'Implement payment ledger API', taskNodeId: 'T_BE' },
					{ toNodeId: 'FE_Lead', summary: 'Implement checkout UI', taskNodeId: 'T_FE' },
				]),
				waitJoin: true,
			});
			assert.strictEqual(split.ok, true);
			assert.strictEqual(split.createdRootParent, true);
			assert.ok(split.joinBarrierId);
			const beTokId = split.branches.find(b => b.toNodeId === 'BE_Lead')!.tokenId;
			const feTokId = split.branches.find(b => b.toNodeId === 'FE_Lead')!.tokenId;

			// 2. BE_Lead delegates downward to Dev with waitJoin -> Dev hands off to peer QA -> QA calls `token.reject` back to Dev!
			const devMint = await h.control<{ readonly mintedTokenIds: readonly string[]; readonly joinBarrierId?: string }>('token.mint', {
				...beCaller,
				mission: missionId,
				parentTokenId: beTokId,
				to: 'Dev',
				summary: 'Code ledger endpoint',
				waitJoin: true,
			});
			const devTok1 = devMint.mintedTokenIds[0];
			const toQa = await h.control<{ readonly nextTokenIds: readonly string[] }>('token.handoff', {
				...devCaller,
				mission: missionId,
				tokenId: devTok1,
				to: 'QA',
				summary: 'Ready for review',
			});
			const qaTok1 = toQa.nextTokenIds[0];

			// Peer bounce via `token.reject` (auto-targets fromNodeId=Dev, preserves BE_Lead's Join Barrier!)
			const qaReject = await h.control<{
				readonly ok: boolean;
				readonly mode: string;
				readonly targetNodeId: string;
				readonly bouncedTokenId: string;
			}>('token.reject', {
				...qaCaller,
				mission: missionId,
				tokenId: qaTok1,
				reason: 'Missing idempotency key validation on retry',
			});
			assert.strictEqual(qaReject.ok, true);
			assert.strictEqual(qaReject.mode, 'peer_bounce');
			assert.strictEqual(qaReject.targetNodeId, 'Dev');
			const devTok2 = qaReject.bouncedTokenId;
			assert.strictEqual(
				missionRuntime.getOrchestrationState(missionId).tokens[devTok2].parentJoinBarrierId,
				devMint.joinBarrierId,
				'Peer handoff + peer reject preserve upstream Join Barrier without deadlock',
			);

			// Unauthorized upward reject from Dev directly to CEO is blocked (`UPWARD_TOKEN_FORBIDDEN`)
			await assert.rejects(
				() => h.control('token.reject', { ...devCaller, mission: missionId, tokenId: devTok2, target: 'CEO', reason: 'Bypass manager' }),
				/UPWARD_TOKEN_FORBIDDEN/i,
			);

			// 3. Dev reports failure via `token.fail` (settling BE_Lead's barrier -> waking BE_Lead!) then BE_Lead retries via `token.retry`!
			const devFail = await h.control<{ readonly ok: boolean; readonly barrierSatisfied?: boolean }>('token.fail', {
				...devCaller,
				mission: missionId,
				tokenId: devTok2,
				reason: 'Missing Stripe webhook test secret',
			});
			assert.strictEqual(devFail.ok, true);
			assert.strictEqual(devFail.barrierSatisfied, true, 'Failed child settles waiting Join Barrier so superior wakes up');
			assert.strictEqual(missionRuntime.getOrchestrationState(missionId).tokens[beTokId].status, 'active');

			// BE_Lead invokes `token.retry` on the failed `otok-*` token with guidance (NO LEGACY_API_REMOVED!)
			const retryRes = await h.control<{ readonly ok: boolean; readonly tokenId: string; readonly nodeId: string; readonly retriedFromTokenId: string }>('token.retry', {
				...beCaller,
				mission: missionId,
				tokenId: devTok2,
				guidance: 'Use local mock webhook signer in tests/fixtures',
			});
			assert.strictEqual(retryRes.ok, true);
			assert.strictEqual(retryRes.retriedFromTokenId, devTok2);
			assert.strictEqual(retryRes.nodeId, 'Dev');
			const devTok3 = retryRes.tokenId;

			// Dev finishes and returns -> merges cleanly into BE_Lead's active baton!
			const devDone = await h.control<{ readonly ok: boolean; readonly returnedTokenId?: string }>('token.return', {
				...devCaller,
				mission: missionId,
				tokenId: devTok3,
				summary: 'Implemented idempotency check with mock signer',
			});
			assert.strictEqual(devDone.ok, true);
			assert.strictEqual(devDone.returnedTokenId, beTokId);

			// 4. BE_Lead rejects downward to Dev via `token.reject` (downward_rework) — preserving BE_Lead's OWN `parentJoinBarrierId` to CEO!
			const leadReject = await h.control<{
				readonly ok: boolean;
				readonly mode: string;
				readonly targetNodeId: string;
				readonly bouncedTokenId: string;
				readonly joinBarrierId?: string;
			}>('token.reject', {
				...beCaller,
				mission: missionId,
				tokenId: beTokId,
				reason: 'Add edge-case test for duplicate currency code',
			});
			assert.strictEqual(leadReject.ok, true);
			assert.strictEqual(leadReject.mode, 'downward_rework');
			assert.strictEqual(leadReject.targetNodeId, 'Dev', 'BE_Lead downward reject auto-targets latest returning subordinate Dev');
			assert.ok(leadReject.joinBarrierId);
			assert.strictEqual(
				missionRuntime.getOrchestrationState(missionId).tokens[beTokId].parentJoinBarrierId,
				split.joinBarrierId,
				'Downward reject preserves BE_Lead upstream Join Barrier to CEO',
			);

			// Dev fixes & returns -> wakes BE_Lead -> BE_Lead & FE_Lead both return -> CEO Join Barrier converges 2/2!
			const devFixRet = await h.control<{ readonly barrierSatisfied?: boolean }>('token.return', {
				...devCaller,
				mission: missionId,
				tokenId: leadReject.bouncedTokenId,
				summary: 'Added duplicate currency edge-case test; suite green',
			});
			assert.strictEqual(devFixRet.barrierSatisfied, true);

			await h.control('token.return', { ...beCaller, mission: missionId, tokenId: beTokId, summary: 'Backend API verified & green' });
			const feRet = await h.control<{ readonly barrierSatisfied?: boolean }>('token.return', {
				...feCaller,
				mission: missionId,
				tokenId: feTokId,
				summary: 'Checkout UI verified & green',
			});
			assert.strictEqual(feRet.barrierSatisfied, true, 'Top-level CEO Join Barrier converges cleanly after full reject/fail/retry rework cycle');
			assert.strictEqual(missionRuntime.getOrchestrationState(missionId).tokens[split.parentTokenId].status, 'active');

			// 5. `token.trace` resolves `otrc-*` even when `--mission` is omitted, and `token.current` returns ONLY `otok-*` (zero dual-track leakage)
			const ceoTok = missionRuntime.getOrchestrationState(missionId).tokens[split.parentTokenId];
			const traceRes = await h.control<{ readonly missionId: string; readonly count: number }>('token.trace', {
				...ceoCaller,
				tracePtr: ceoTok.tracePtr,
			});
			assert.strictEqual(traceRes.missionId, missionId);
			assert.ok(traceRes.count >= 1, 'token.trace expands otrc-* cleanly without --mission');

			const curRes = await h.control<{ readonly tokens: readonly { readonly id: string }[] }>('token.current', {
				...ceoCaller,
				mission: missionId,
			});
			assert.ok(curRes.tokens.length === 1 && curRes.tokens[0].id === split.parentTokenId);
			assert.ok(curRes.tokens.every(t => t.id.startsWith('otok-')), 'Orchestration token.current returns pure otok-* tokens with zero legacy tok-* leakage');
			assert.ok(missionStore.getMission(missionId), 'Mission state committed cleanly');
		});

		test('Orchestration fault-tolerance guardrails: maxHops breaker, FinOps budget hard stop + resume gate, real pause/resume session stop & re-wake, bound Task DAG deterministic checks, and 429/502 transient retry', async () => {
			const h = createHarness([alpha]);
			h.modes.setMode('ade');

			const stoppedResources: string[] = [];
			const baseSessions = h.instantiation.get(IAdeSessionsService);
			h.instantiation.stub(IAdeSessionsService, Object.assign(Object.create(Object.getPrototypeOf(baseSessions)), baseSessions, {
				async stop(session: IAdeEngineSession): Promise<void> {
					stoppedResources.push(session.resource.toString());
				},
			}));

			let checkShouldPass = false;
			const executedChecks: string[] = [];
			h.instantiation.stub(IAdeEngineeringBackendService, upcastPartial<IAdeEngineeringBackendService>({
				_serviceBrand: undefined,
				onDidInboxChange: Event.None,
				onDidWatchdogWakeup: Event.None,
				onDidSourceTriggerFire: Event.None,
				onDidMissionRecordChange: Event.None,
				onDidSystemResume: Event.None,
				runDeterministicCheck: async req => {
					executedChecks.push(req.checkId);
					return {
						checkId: req.checkId,
						name: req.name,
						command: req.command,
						hostAlias: req.hostAlias ?? 'local',
						cwd: req.cwd,
						passed: checkShouldPass,
						exitCode: checkShouldPass ? 0 : 1,
						expectedExitCode: 0,
						durationMs: 5,
						outputTail: checkShouldPass ? 'ALL_TESTS_PASS' : 'FAIL: missing migration',
					};
				},
			}));

			let transientFailCount = 0;
			const dispatchedTurns: Array<{ readonly resource: string; readonly prompt: string }> = [];
			h.instantiation.stub(ICommandService, {
				onWillExecuteCommand: Event.None,
				onDidExecuteCommand: Event.None,
				executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
					if (id === 'aexus.agentEngines.dispatchEngineeringTurn') {
						dispatchedTurns.push({ resource: String(args[0]), prompt: String(args[1]) });
						if (transientFailCount > 0) {
							transientFailCount--;
							throw new Error('HTTP 502 Bad Gateway: upstream overloaded (429)');
						}
						return { reply: 'ok', usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, turns: 1 } } as T;
					}
					const registered = CommandsRegistry.getCommand(id);
					if (registered) {
						return h.instantiation.invokeFunction(registered.handler, ...args) as T;
					}
					return undefined as T;
				},
			});

			const inboxItems: IAdeInboxItem[] = [];
			const onInboxChanged = store.add(new Emitter<void>());
			let inboxSeq = 0;
			h.instantiation.stub(IAdeInboxService, upcastPartial<IAdeInboxService>({
				_serviceBrand: undefined,
				get items(): readonly IAdeInboxItem[] { return inboxItems; },
				get unreadCount(): number { return inboxItems.filter(i => i.unread && !i.resolved).length; },
				onDidChange: onInboxChanged.event,
				list: () => [...inboxItems],
				async postGovernorMessage(input): Promise<IAdeInboxItem> {
					const item: IAdeInboxItem = {
						id: `inb-ft-${++inboxSeq}`,
						kind: 'governor_message',
						treeType: 'engineering',
						governorSessionId: input.governorSessionId,
						governorLabel: 'Owner',
						projectPath: alpha.fsPath,
						projectName: 'alpha',
						nodeId: input.nodeId,
						title: input.title ?? 'Alert',
						message: input.message,
						severity: input.severity,
						senderAgentId: input.senderAgentId,
						createdAt: Date.now(),
						unread: true,
						resolved: false,
					};
					inboxItems.push(item);
					onInboxChanged.fire();
					return item;
				},
			}));

			const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
			h.instantiation.stub(IAdeRoleSchemaService, roleSchema);
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);
			missionRuntime.setTransientRetryBackoffsForTesting([15, 25]);

			const created = await h.control<{ readonly id: string }>('mission.init', {
				title: 'Fault-Tolerance Orchestration',
				project: alpha.toString(),
			});
			const missionId = created.id;
			await h.control('orchestration.apply', {
				mission: missionId,
				text: [
					'flowchart TD',
					'  CEO["@Aria · Chief Architect (L1)"] <--> Dev["@Dave · Backend Dev (L2)"]',
					'  Dev <--> QA["@Eve · QA Eng (L2)"]',
					'  QA <--> CEO',
				].join('\n'),
			});
			await h.control('mission.blueprint.apply', {
				mission: missionId,
				text: 'flowchart LR\n  T_API["Implement API"] --> T_SHIP["Release"]',
			});
			// Attach deterministic check onto bound Task DAG node T_API!
			await h.control('mission.check.set', {
				mission: missionId,
				nodeId: 'T_API',
				command: 'npm test',
				label: 'API unit tests',
			});

			const orch0 = missionRuntime.getOrchestrationState(missionId);
			const ceoId = orch0.nodeAgentIds.CEO!;
			const devId = orch0.nodeAgentIds.Dev!;
			const qaId = orch0.nodeAgentIds.QA!;
			h.projects.bindSession(ceoId, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/ft-ceo') });
			h.projects.bindSession(devId, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/ft-dev') });
			h.projects.bindSession(qaId, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/ft-qa') });
			const ceoCaller = { caller: 'governor', _verifiedCaller: true, _callerSessionId: ceoId };
			const devCaller = { caller: 'manager', _verifiedCaller: true, _callerSessionId: devId };
			const qaCaller = { caller: 'manager', _verifiedCaller: true, _callerSessionId: qaId };

			// 1. 429/502 transient retry automatically retries failing Orchestration dispatch and recovers!
			transientFailCount = 1;
			const beforeRetryDispatches = dispatchedTurns.length;
			const disp = await h.control<{ readonly ok: boolean; readonly tokenId: string }>('orchestration.dispatch', {
				mission: missionId,
				target: 'CEO',
				prompt: 'Ship payments API',
			});
			assert.strictEqual(disp.ok, true);
			await timeout(60);
			assert.strictEqual(
				dispatchedTurns.length - beforeRetryDispatches,
				2,
				'Transient 502/429 dispatch error must auto-retry and succeed without failing the otok-* baton',
			);
			assert.strictEqual(missionRuntime.getOrchestrationState(missionId).tokens[disp.tokenId].status, 'active');

			// 2. Deterministic verification check on bound Task DAG node T_API blocks Dev token.return until passing!
			const split = await h.control<{ readonly mintedTokenIds: readonly string[] }>('token.split', {
				...ceoCaller,
				mission: missionId,
				parentTokenId: disp.tokenId,
				to: 'Dev',
				summary: 'Build T_API',
				task: 'T_API',
				waitJoin: true,
			});
			const devTokId = split.mintedTokenIds[0];

			checkShouldPass = false;
			await assert.rejects(
				() => h.control('token.return', { ...devCaller, mission: missionId, tokenId: devTokId, summary: 'Ready without tests' }),
				/AUTOMATED_CHECK_FAILED|DETERMINISTIC_CHECK_FAILED/i,
				'Bound Task DAG deterministic check must block Orchestration token.return when failing',
			);
			assert.ok(executedChecks.length >= 1, 'Deterministic check hook actually executed');

			// 3. Real pause stops live active otok-* LLM session while keeping token active; real resume re-wakes active holder!
			stoppedResources.length = 0;
			const paused = await h.control<{ readonly ok: boolean; readonly status: string }>('orchestration.pause', {
				...ceoCaller,
				mission: missionId,
				reason: 'Manual inspection pause',
			});
			assert.strictEqual(paused.ok, true);
			assert.strictEqual(paused.status, 'paused');
			assert.ok(stoppedResources.includes('aexus-claude:/ft-dev'), 'Pause must actively stop live otok-* agent session');
			assert.strictEqual(missionRuntime.getOrchestrationState(missionId).tokens[devTokId].status, 'active');

			const beforeResumeDispatches = dispatchedTurns.length;
			const resumed = await h.control<{ readonly ok: boolean; readonly status: string }>('orchestration.resume', {
				...ceoCaller,
				mission: missionId,
			});
			assert.strictEqual(resumed.ok, true);
			assert.strictEqual(resumed.status, 'running');
			await timeout(20);
			assert.ok(
				dispatchedTurns.slice(beforeResumeDispatches).some(d => d.resource === 'aexus-claude:/ft-dev' && d.prompt.includes('Orchestration Resumed')),
				'Resume must re-wake idle active otok-* token holders immediately',
			);

			// 4. FinOps budget hard circuit-breaker trips on recordNodeTurnUsage -> stops live otok-* session, hard-pauses, blocks resume until budget raised!
			stoppedResources.length = 0;
			await h.control('orchestration.limits', { mission: missionId, budgetLimitUsd: 1.0 });
			missionRuntime.recordNodeTurnUsage(missionId, 'Dev', { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, turns: 1, costUsd: 1.25 });
			await timeout(20);
			const orchAfterBudget = missionRuntime.getOrchestrationState(missionId);
			assert.strictEqual(orchAfterBudget.budgetCircuitTripped, true);
			assert.strictEqual(orchAfterBudget.status, 'paused');
			assert.ok(stoppedResources.includes('aexus-claude:/ft-dev'), 'FinOps budget trip must stop live otok-* session');
			assert.ok(inboxItems.some(i => i.severity === 'critical' && /Budget Circuit-?Breaker/i.test(i.title)), 'Budget trip alerts Inbox');

			await assert.rejects(
				() => h.control('orchestration.resume', { ...ceoCaller, mission: missionId }),
				/BUDGET_EXCEEDED/,
				'Cannot resume Orchestration while FinOps budget circuit breaker is tripped',
			);

			// Raise budget ceiling -> unlatches breaker -> resume works!
			await h.control('orchestration.limits', { mission: missionId, budgetLimitUsd: 25.0 });
			const resumedAfterRaise = await h.control<{ readonly ok: boolean; readonly status: string }>('orchestration.resume', {
				...ceoCaller,
				mission: missionId,
			});
			assert.strictEqual(resumedAfterRaise.ok, true);
			assert.strictEqual(resumedAfterRaise.status, 'running');

			// 5. maxHops cycle circuit-breaker freezes runaway Dev <-> QA bounce and alerts Inbox!
			checkShouldPass = true;
			await h.control('orchestration.limits', { mission: missionId, maxHops: 2 });
			// devTokId is at hop 1 -> handoff to QA is hop 2 (ok) -> QA rejects to Dev is hop 3 (> maxHops=2 -> TRIPS!)
			const toQa = await h.control<{ readonly nextTokenIds: readonly string[] }>('token.handoff', {
				...devCaller,
				mission: missionId,
				tokenId: devTokId,
				to: 'QA',
				summary: 'Review hop 2',
			});
			const qaTokId = toQa.nextTokenIds[0];
			await assert.rejects(
				() => h.control('token.reject', { ...qaCaller, mission: missionId, tokenId: qaTokId, reason: 'Bounce hop 3 exceeds maxHops=2' }),
				/MAX_HOPS_EXCEEDED/,
				'Cyclic Dev <-> QA bounce exceeding maxHops must trip circuit breaker',
			);
			const orchAfterCycle = missionRuntime.getOrchestrationState(missionId);
			assert.strictEqual(orchAfterCycle.tokens[qaTokId].status, 'failed');
			assert.strictEqual(orchAfterCycle.tokens[disp.tokenId].status, 'active', 'Waiting CEO Join Barrier wakes up cleanly when cycle breaker trips');
			assert.ok(inboxItems.some(i => i.severity === 'critical' && /Cycle Circuit-Breaker/i.test(i.title)), 'Max-hops trip alerts Inbox');
		});

		test('Dual-view taskId binding & upstream completion guard + org.context/org.subordinates across Chinese/custom L1 subgraphs & intra-dept peer hops + zero-leak dynamic staff removal (staff.remove & orchestration.apply)', async () => {
			const h = createHarness([alpha]);
			h.modes.setMode('ade');

			const stoppedResources: string[] = [];
			const deletedResources: string[] = [];
			const baseSessions = h.instantiation.get(IAdeSessionsService);
			h.instantiation.stub(IAdeSessionsService, Object.assign(Object.create(Object.getPrototypeOf(baseSessions)), baseSessions, {
				async stop(session: IAdeEngineSession): Promise<void> {
					stoppedResources.push(session.resource.toString());
				},
				async delete(session: IAdeEngineSession): Promise<void> {
					deletedResources.push(session.resource.toString());
				},
			}));

			const roleSchema = store.add(h.instantiation.createInstance(AdeRoleSchemaService));
			h.instantiation.stub(IAdeRoleSchemaService, roleSchema);
			const missionStore = store.add(h.instantiation.createInstance(AdeMissionStoreService));
			h.instantiation.stub(IAdeMissionService, missionStore);
			const missionRuntime = store.add(h.instantiation.createInstance(AdeMissionRuntimeService));
			h.instantiation.stub(IAdeMissionRuntimeService, missionRuntime);

			// Topology puts L1 CEO inside a Chinese executive subgraph ("管理层"), BE_Lead -> Dev -> QA (same-tier peer chain in Backend), and FE_Lead in Frontend!
			const created = await h.control<{ readonly id: string }>('mission.init', {
				title: 'Dual-View & Org Authority E2E',
				project: alpha.toString(),
			});
			const missionId = created.id;
			await h.control('orchestration.apply', {
				mission: missionId,
				text: [
					'flowchart TD',
					'  subgraph Exec["管理层"]',
					'    CEO["@Aria · CTO (L1)"]',
					'  end',
					'  subgraph Backend["Backend Dept"]',
					'    BE_Lead["@Bob · Backend Lead (L2)"]',
					'    Dev["@Dave · Backend Dev (L3)"]',
					'    QA["@Eve · Backend QA (L3)"]',
					'    WB_BE[("Whiteboard: Backend Spec")]',
					'    BE_Lead <--> Dev',
					'    Dev <--> QA',
					'  end',
					'  subgraph Frontend["Frontend Dept"]',
					'    FE_Lead["@Carol · Frontend Lead (L2)"]',
					'    FE_Dev["@Frank · Frontend Dev (L3)"]',
					'    FE_Lead <--> FE_Dev',
					'  end',
					'  CEO <--> BE_Lead',
					'  CEO <--> FE_Lead',
					'  %% staff CEO [tier=1, rank=governor, dept="管理层"]',
					'  %% staff BE_Lead [tier=2, rank=manager, dept="Backend Dept"]',
					'  %% staff Dev [tier=3, rank=employee, dept="Backend Dept"]',
					'  %% staff QA [tier=3, rank=employee, dept="Backend Dept"]',
					'  %% staff FE_Lead [tier=2, rank=manager, dept="Frontend Dept"]',
					'  %% staff FE_Dev [tier=3, rank=employee, dept="Frontend Dept"]',
					'  %% whiteboard WB_BE [dept="Backend Dept", title="Backend Spec", version=1]',
				].join('\n'),
			});
			await h.control('mission.blueprint.apply', {
				mission: missionId,
				text: [
					'flowchart LR',
					'  T1["Schema Migration"] --> T2["Billing Endpoint"]',
					'  %% task T1 [owner=BE_Lead, dept="Backend Dept"]',
					'  %% task T2 [owner=BE_Lead, dept="Backend Dept"]',
				].join('\n'),
			});

			const orch0 = missionRuntime.getOrchestrationState(missionId);
			const ceoId = orch0.nodeAgentIds.CEO!;
			const beLeadId = orch0.nodeAgentIds.BE_Lead!;
			const devId = orch0.nodeAgentIds.Dev!;
			const qaId = orch0.nodeAgentIds.QA!;
			const feDevId = orch0.nodeAgentIds.FE_Dev!;
			h.projects.bindSession(devId, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/dv-dev') });
			h.projects.bindSession(qaId, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/dv-qa') });
			const ceoCaller = { caller: 'governor', _verifiedCaller: true, _callerSessionId: ceoId };
			const beCaller = { caller: 'manager', _verifiedCaller: true, _callerSessionId: beLeadId };

			// 1. Bind otok-* via `taskId` alias -> live sync updates Mission Task DAG immediately!
			const disp = await h.control<{ readonly ok: boolean; readonly tokenId: string }>('orchestration.dispatch', {
				mission: missionId,
				target: 'BE_Lead',
				prompt: 'Work on Billing Endpoint',
				taskId: 'T2',
			});
			assert.strictEqual(disp.ok, true);
			const taskAfterDisp = missionStore.getMission(missionId)?.taskStatuses?.T2;
			assert.strictEqual(taskAfterDisp?.status, 'in_progress');
			assert.strictEqual(taskAfterDisp?.assigneeNodeId, 'BE_Lead');
			assert.deepStrictEqual(taskAfterDisp?.activeTokenIds, [disp.tokenId]);

			// Premature terminal token.complete (both plain --finish AND --complete-task) MUST fail with INCOMPLETE_DEPENDENCIES while upstream T1 is incomplete!
			await assert.rejects(
				() => h.control('token.complete', { ...beCaller, mission: missionId, tokenId: disp.tokenId, summary: 'Done T2 early', finish: true }),
				/INCOMPLETE_DEPENDENCIES/i,
				'Cannot close otok-* bound to T2 while upstream T1 is incomplete',
			);
			await assert.rejects(
				() => h.control('token.complete', { ...beCaller, mission: missionId, tokenId: disp.tokenId, summary: 'Done T2 early', finish: true, completeTask: true }),
				/INCOMPLETE_DEPENDENCIES/i,
				'--complete-task must also reject while upstream T1 is incomplete',
			);

			// Complete upstream T1 -> now T2 token.complete --finish --complete-task succeeds & atomically marks T2 completed!
			await h.control('mission.task.complete', { ...beCaller, mission: missionId, node: 'T1', note: 'Schema done' });
			const okDone = await h.control<{ readonly ok: boolean; readonly completedTaskIds?: readonly string[] }>('token.complete', {
				...beCaller,
				mission: missionId,
				tokenId: disp.tokenId,
				summary: 'Billing endpoint delivered & verified',
				finish: true,
				completeTask: true,
			});
			assert.strictEqual(okDone.ok, true);
			assert.deepStrictEqual(okDone.completedTaskIds, ['T2']);
			assert.strictEqual(missionStore.getMission(missionId)?.taskStatuses?.T2?.status, 'completed');

			// 2. org.context & org.subordinates: L1 CEO inside Chinese subgraph "管理层" has ZERO false cross-department denials!
			const ceoSubs = await h.control<{ readonly orchestrationSubordinates?: readonly { readonly nodeId: string }[] }>('org.subordinates', { ...ceoCaller });
			const ceoSubNodeIds = (ceoSubs.orchestrationSubordinates ?? []).map(s => s.nodeId);
			assert.ok(ceoSubNodeIds.includes('BE_Lead') && ceoSubNodeIds.includes('QA') && ceoSubNodeIds.includes('FE_Dev'), 'L1 in "管理层" sees all lower-tier staff across departments');

			const ceoCtxQa = await h.control<{
				readonly agentId: string;
				readonly nodeId?: string;
				readonly department?: string;
				readonly missionId?: string;
				readonly heldTokens: readonly { readonly id: string }[];
				readonly whiteboardIds?: readonly string[];
			}>('org.context', { ...ceoCaller, target: 'QA' });
			assert.strictEqual(ceoCtxQa.agentId, qaId);
			assert.strictEqual(ceoCtxQa.nodeId, 'QA');
			assert.strictEqual(ceoCtxQa.department, 'Backend Dept');
			assert.strictEqual(ceoCtxQa.missionId, missionId);
			assert.ok(ceoCtxQa.whiteboardIds?.includes('WB_BE'), 'org.context surfaces accessible department whiteboards');

			// L2 BE_Lead can inspect intra-department peer-chained QA (BE_Lead -> Dev -> QA), while cross-department FE_Dev is strictly OUT_OF_JURISDICTION!
			const beSubs = await h.control<{ readonly orchestrationSubordinates?: readonly { readonly nodeId: string }[] }>('org.subordinates', { ...beCaller });
			const beSubIds = (beSubs.orchestrationSubordinates ?? []).map(s => s.nodeId);
			assert.ok(beSubIds.includes('Dev') && beSubIds.includes('QA'), 'BE_Lead sees Dev AND peer-chained QA in Backend Dept');
			assert.ok(!beSubIds.includes('FE_Dev'), 'BE_Lead does NOT see cross-department FE_Dev');

			const beCtxQa = await h.control<{ readonly agentId: string; readonly nodeId?: string }>('org.context', { ...beCaller, target: 'QA' });
			assert.strictEqual(beCtxQa.agentId, qaId);
			assert.strictEqual(beCtxQa.nodeId, 'QA');

			await assert.rejects(
				() => h.control('org.context', { ...beCaller, target: feDevId }),
				/OUT_OF_JURISDICTION/i,
				'L2 Backend Lead remains strictly blocked from cross-department Frontend Dev',
			);

			// Human User omitting --mission can resolve Orchestration staff node ID directly via org.context!
			const humanCtxDev = await h.control<{ readonly agentId: string; readonly nodeId?: string }>('org.context', { target: 'Dev' });
			assert.strictEqual(humanCtxDev.agentId, devId);
			assert.strictEqual(humanCtxDev.nodeId, 'Dev');

			// 3. Dynamic staff removal (`orchestration.staff.remove`) cleans up active session, in-flight otok-*, checks, positions, legacy assignments & Task DAG state with ZERO residue!
			await h.control('mission.check.set', { mission: missionId, nodeId: 'Dev', command: 'echo ok', label: 'Dev check' });
			await h.control('mission.host.bind', { mission: missionId, nodeId: 'Dev', hostAlias: 'gpu-dev-box' });
			missionStore.updateOrchestrationPositions(missionId, { Dev: { x: 120, y: 240 } });

			const splitWork = await h.control<{ readonly parentTokenId: string; readonly mintedTokenIds: readonly string[]; readonly joinBarrierId?: string }>('token.split', {
				...beCaller,
				mission: missionId,
				parentTokenId: 'new',
				to: 'Dev',
				summary: 'Active work on Dev before removal',
				waitJoin: true,
			});
			const devLiveTok = splitWork.mintedTokenIds[0];

			stoppedResources.length = 0;
			deletedResources.length = 0;
			const remRes = await h.control<{
				readonly ok: boolean;
				readonly removedNodeId: string;
				readonly reclaimedTokenIds: readonly string[];
				readonly settledBarrierIds: readonly string[];
				readonly stoppedAgentIds: readonly string[];
			}>('orchestration.staff.remove', {
				...beCaller,
				mission: missionId,
				node: 'Dev',
				reason: 'Reassigning workload',
			});
			assert.strictEqual(remRes.ok, true);
			assert.strictEqual(remRes.removedNodeId, 'Dev');
			assert.deepStrictEqual(remRes.reclaimedTokenIds, [devLiveTok]);
			assert.strictEqual(remRes.settledBarrierIds.length, 1, 'Waiting superior barrier settled cleanly on removal');
			assert.ok(stoppedResources.includes('aexus-claude:/dv-dev'), 'Active LLM session stopped on staff removal');
			assert.ok(deletedResources.includes('aexus-claude:/dv-dev'), 'Engine session deleted on staff removal');
			assert.strictEqual(h.projects.getAgent(devId), undefined, 'Removed staff agent purged from sidebar');

			const afterRec = missionStore.getMission(missionId)!;
			const afterOrch = missionRuntime.getOrchestrationState(missionId);
			assert.strictEqual(afterOrch.nodeAgentIds.Dev, undefined, 'nodeAgentIds purged');
			assert.strictEqual(afterOrch.nodeStates.Dev, undefined, 'nodeStates purged');
			assert.strictEqual(afterOrch.tokens[devLiveTok].status, 'reclaimed', 'In-flight token reclaimed');
			assert.strictEqual(afterRec.nodeChecks?.Dev, undefined, 'nodeChecks residue purged');
			assert.strictEqual(afterRec.orchestrationPositions?.Dev, undefined, 'orchestrationPositions residue purged');
			assert.strictEqual(afterRec.runtime?.boundary?.nodeAssignments?.Dev, undefined, 'Legacy nodeAssignments residue purged');

			// 4. Blueprint-level staff removal (`orchestration.apply` dropping QA) ALSO stops active session & purges all state!
			stoppedResources.length = 0;
			await h.control('orchestration.apply', {
				mission: missionId,
				text: [
					'flowchart TD',
					'  subgraph Exec["管理层"]',
					'    CEO["@Aria · CTO (L1)"]',
					'  end',
					'  subgraph Backend["Backend Dept"]',
					'    BE_Lead["@Bob · Backend Lead (L2)"]',
					'  end',
					'  CEO <--> BE_Lead',
				].join('\n'),
			});
			assert.ok(stoppedResources.includes('aexus-claude:/dv-qa'), 'Blueprint orchestration.apply removing QA stops active session');
			assert.strictEqual(missionRuntime.getOrchestrationState(missionId).nodeAgentIds.QA, undefined, 'Blueprint removal purges QA from nodeAgentIds');
			assert.strictEqual(h.projects.getAgent(qaId), undefined, 'Blueprint removal purges QA from sidebar');
		});

		test('Mission DAG Sculpted Task & Gate Cards render upstream readiness, department pills, and ready/completed edge states without overlap', async () => {
			const { h, missionStore } = createMissionHarness();
			const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/sculpted-gov') }, 'Sculpted Gov', { role: 'governor' });
			const created = missionStore.createMission({
				title: 'Sculpted Task Cards',
				ownerSessionId: gov.id,
				ownerTier: 1,
				projectUri: alpha.toString(),
				mermaidText: [
					'flowchart LR',
					'  T_A["Spec Freeze"] --> T_C{{"QA Gate"}}',
					'  T_B["Core Impl"] --> T_C',
					'  %% task T_A [owner=CEO, dept="Arch", min_tier=1]',
					'  %% task T_B [owner=Dev, dept="Core", min_tier=2]',
				].join('\n'),
			});

			const host = append(document.body, $('.monaco-workbench.ade-eng-mission-dualview-host'));
			host.style.width = '1280px';
			host.style.height = '760px';
			store.add({ dispose: () => host.remove() });
			const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, upcastPartial<IEditorGroup>({ id: 1, index: 0 })));
			pane.create(host);
			pane.layout(new Dimension(1280, 760));
			const missionInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, encodeAdeEngineeringInputSpec(created.id, 'mission')));
			await pane.setInput(missionInput, undefined, {}, CancellationToken.None);

			// Sculpted task card renders shape, department pill, and tier pill
			const tAEl = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="T_A"]')!;
			assert.strictEqual(tAEl.getAttribute('data-node-shape'), 'sculpted-card');
			assert.strictEqual(host.querySelector<HTMLElement>('[data-ade-task-dept="T_A"]')?.textContent, 'Arch');
			assert.strictEqual(tAEl.querySelector<HTMLElement>('.ade-mission-task-tier-pill')?.textContent, '≤L1');

			// Gate card renders gate shape, four corner clamps, and upstream readiness 0/2
			const tCEl = host.querySelector<HTMLElement>('.ade-mission-node[data-node-id="T_C"]')!;
			assert.strictEqual(tCEl.getAttribute('data-dag-node-kind'), 'gate');
			assert.strictEqual(tCEl.getAttribute('data-node-shape'), 'gate-card');
			assert.strictEqual(tCEl.classList.contains('is-gate-task'), true);
			assert.strictEqual(tCEl.querySelectorAll('.ade-mission-clamp').length, 4);
			assert.ok(host.querySelector<HTMLElement>('[data-ade-task-deps="T_C"]')?.textContent?.includes('0/2'));

			// Completing T_A promotes readiness to 1/2 and lights the T_A -> T_C edge as ready
			tAEl.dispatchEvent(new mainWindow.PointerEvent('pointerdown', { button: 0, pointerId: 811, clientX: 200, clientY: 200, bubbles: true }));
			mainWindow.dispatchEvent(new mainWindow.PointerEvent('pointerup', { button: 0, pointerId: 811, clientX: 200, clientY: 200, bubbles: true }));
			host.querySelector<HTMLButtonElement>('button[data-ade-task-toggle-complete="T_A"]')!.click();
			await timeout(30);
			assert.ok(host.querySelector<HTMLElement>('[data-ade-task-deps="T_C"]')?.textContent?.includes('1/2'));
			assert.strictEqual(host.querySelector('[data-from="T_A"][data-to="T_C"]')?.getAttribute('data-edge-state'), 'ready');
		});

	});
});
