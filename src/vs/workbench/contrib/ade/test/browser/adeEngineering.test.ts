/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ADE_CONTROL_EXECUTE_COMMAND_ID,
	ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID,
} from '../../../../../platform/ade/common/adeControl.js';
import {
	ADE_WATCHDOG_TIMEOUT_CONFIG_KEY,
	AdeEngineeringNodePhase,
	IAdeEngineeringBackendService,
	IAdeEngineeringService,
	IAdeInboxItem,
	IAdeInboxService,
	IAdeStoredEngineeringRecord,
	IAdeWorkerTurnChanges,
	IAdeWorkspaceSnapshot,
} from '../../../../../platform/ade/common/adeEngineering.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IConfirmation, IConfirmationResult, IDialogService, IPrompt, IPromptResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IViewContainerModel, IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../../common/views.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchModeService } from '../../../../services/workbenchMode/common/workbenchMode.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../../files/browser/projectNavigationService.js';
import '../../browser/ade.css';
import '../../browser/ade.contribution.js';
import '../../browser/adeControlHandler.js';
import {
	AdeEngineeringEditorInput,
	AdeEngineeringEditorPane,
} from '../../browser/adeEngineeringEditorPane.js';
import {
	ADE_WORKER_HEARTBEAT_COMMAND_ID,
	AdeEngineeringWorkbenchService,
	AdeExistingSubordinatesError,
	AdeInboxService,
} from '../../browser/adeEngineeringWorkbenchService.js';
import { AdeInboxPanel } from '../../browser/adeInboxView.js';
import { AdeProjectsService } from '../../browser/adeProjectsService.js';
import { AdeProjectsDragAndDrop, AdeProjectsView } from '../../browser/adeProjectsView.js';
import { AdeSessionEditorInput } from '../../browser/adeSessionEditor.js';
import { IAdeEngineSession, IAdeSessionsService } from '../../browser/adeSessionsService.js';
import {
	ADE_OPEN_ENGINEERING_COMMAND_ID,
	ADE_PROJECTS_VIEW_ID,
	ADE_SECRETARY_ID,
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectsService,
	IAdeSession,
} from '../../common/ade.js';

interface IDispatchedTurnRecord {
	readonly resource: string;
	readonly prompt: string;
	readonly agentId?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly pureWorker?: boolean;
	readonly callerRole?: string;
	readonly cwdOverride?: string;
}

suite('ADE Engineering Workflow, State Machine, CLI, Inbox & Visual DAG Canvas', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const projectUri = URI.file('/projects/AexusEngineering');

	async function waitForNodePhase(
		engineering: IAdeEngineeringService,
		govId: string,
		nodeId: string,
		expectedPhase: AdeEngineeringNodePhase,
	): Promise<void> {
		while (engineering.getTreeSnapshot(govId)?.state.nodes[nodeId]?.phase !== expectedPhase) {
			await Event.toPromise(engineering.onDidChangeTree);
		}
	}

	function createEngineeringHarness() {
		const instantiation = workbenchInstantiationService(undefined, store);
		const folders = [toWorkspaceFolder(projectUri)];
		const workspace = new Workspace('ade-eng-test', folders);
		const onFoldersChanged = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		instantiation.stub(IWorkspaceContextService, {
			getWorkspace: () => new Workspace(workspace.id, folders),
			onDidChangeWorkspaceFolders: onFoldersChanged.event,
		});

		const configService = new TestConfigurationService({
			[ADE_WATCHDOG_TIMEOUT_CONFIG_KEY]: 10,
		});
		instantiation.stub(IConfigurationService, configService);

		let currentMode: 'ade' | 'ide' = 'ade';
		const onModeChange = store.add(new Emitter<'ade' | 'ide'>());
		instantiation.stub(IWorkbenchModeService, new class extends mock<IWorkbenchModeService>() {
			override get mode() { return currentMode; }
			override readonly onDidChangeMode = onModeChange.event;
			override setMode(mode: 'ade' | 'ide'): void {
				currentMode = mode;
				onModeChange.fire(mode);
			}
		}());

		const navigation = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, navigation);

		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, projects);

		let sessionCounter = 0;
		const createdSessions: Array<{ engineId: string; resource: string; projectPath: string }> = [];
		const deletedSessions: string[] = [];
		const killedSessions: string[] = [];
		const stoppedSessions: string[] = [];
		const dispatchedTurns: IDispatchedTurnRecord[] = [];
		const openedLog: Array<{ kind: string; target: string }> = [];
		let activeEditor: EditorInput | undefined;

		let nextWorkerTurnReply = 'Implemented requested changes cleanly and verified all tests.';
		let holdNextTurnDeferred: { started: DeferredPromise<void>; reply: DeferredPromise<string> } | undefined;
		let nextConfirmSignal: DeferredPromise<void> | undefined;
		let nextOpenAgentSignal: DeferredPromise<string> | undefined;
		let nextPromptChoice: unknown = 'relocate';
		let nextConfirmChoice = true;
		let confirmCallCount = 0;
		let promptCallCount = 0;

		instantiation.stub(IDialogService, new class extends mock<IDialogService>() {
			override async prompt<T>(prompt: IPrompt<T>): Promise<IPromptResult<T>> {
				promptCallCount++;
				if (nextPromptChoice === undefined) {
					return { result: undefined };
				}
				const btn = prompt.buttons?.find(b => {
					const val = b.run({ checkboxChecked: false });
					return val === nextPromptChoice;
				});
				const res = btn ? await btn.run({ checkboxChecked: false }) : (nextPromptChoice as T);
				return { result: res };
			}
			override async confirm(_confirmation: IConfirmation): Promise<IConfirmationResult> {
				confirmCallCount++;
				nextConfirmSignal?.complete();
				return { confirmed: nextConfirmChoice };
			}
		}());

		const sessionsStub: IAdeSessionsService = {
			_serviceBrand: undefined,
			onDidChangeEngines: Event.None,
			getIcon: engineId => engineId === 'aexus-codex' ? Codicon.terminal : Codicon.hubot,
			getEngineName: engineId => engineId === 'aexus-codex' ? 'Codex' : 'Claude Code',
			getEngines: async () => [
				{ id: 'aexus-claude', name: 'Claude Code', description: 'Claude Code CLI', icon: Codicon.hubot },
				{ id: 'aexus-codex', name: 'Codex', description: 'Codex CLI', icon: Codicon.terminal },
			],
			create: async (engineId: string, folderUri: URI): Promise<IAdeEngineSession> => {
				sessionCounter++;
				const resource = URI.parse(`${engineId}:/eng-session-${sessionCounter}`);
				createdSessions.push({ engineId, resource: resource.toString(), projectPath: folderUri.fsPath });
				return {
					engineId,
					resource,
					projectUri: folderUri,
					label: `Session ${sessionCounter}`,
				};
			},
			list: async () => [],
			rename: async () => { },
			delete: async (session: IAdeSession) => {
				deletedSessions.push(session.resource.toString());
			},
		};
		instantiation.stub(IAdeSessionsService, sessionsStub);

		const storedRecords = new Map<string, IAdeStoredEngineeringRecord>();
		let storedInbox: IAdeInboxItem[] = [];
		const simulatedDiffSummary = '+++ src/auth.ts (+42 -3)';

		const backendStub: IAdeEngineeringBackendService = {
			_serviceBrand: undefined,
			listStoredTrees: async treeType => {
				const all = [...storedRecords.values()];
				return treeType ? all.filter(r => r.treeType === treeType) : all;
			},
			loadTree: async govId => storedRecords.get(govId),
			saveTree: async record => { storedRecords.set(record.governorSessionId, record); },
			deleteTree: async govId => { storedRecords.delete(govId); },
			loadInbox: async () => [...storedInbox],
			saveInbox: async items => { storedInbox = [...items]; },
			captureWorkspaceSnapshot: async (cwd: string): Promise<IAdeWorkspaceSnapshot> => ({
				workspacePath: cwd,
				capturedAt: Date.now(),
				files: {},
			}),
			computeWorkerTurnChanges: async (): Promise<IAdeWorkerTurnChanges> => ({
				touchedFiles: [{ relativePath: 'src/auth.ts', kind: 'modified' }],
				unifiedDiff: simulatedDiffSummary,
				truncated: false,
			}),
			ensureSegmentWorktree: async (govId, projectPath, segmentId) => ({
				worktree: {
					segmentId,
					branchName: `ade-eng/${govId}/${segmentId}`,
					worktreePath: `${projectPath}/.worktrees/${segmentId}`,
					createdAt: Date.now(),
				},
			}),
			commitSegmentWorktree: async () => 'abc1234',
			mergeSegmentsIntoProject: async () => ({ ok: true, conflictedFiles: [], summary: 'Merged cleanly' }),
			cleanupTreeWorktrees: async () => { },
		};
		instantiation.stub(IAdeEngineeringBackendService, backendStub);

		const editorsStub: IAdeEditorService = {
			_serviceBrand: undefined,
			get activeEditor() { return activeEditor; },
			isSessionActive: () => false,
			openAgent: async (id: string) => {
				const agent = projects.getAgent(id);
				if (agent && !agent.session && agent.preferredEngineId) {
					const created = await sessionsStub.create(
						agent.preferredEngineId,
						agent.workingDirectoryOverride ? URI.file(agent.workingDirectoryOverride) : agent.projectUri,
					);
					projects.bindSession(agent.id, { engineId: created.engineId, resource: created.resource });
				}
				projects.selectAgent(id);
				projects.markRead(id);
				activeEditor = store.add(instantiation.createInstance(AdeSessionEditorInput, id));
				openedLog.push({ kind: 'agent', target: id });
				nextOpenAgentSignal?.complete(id);
			},
			openEngineering: async (governorId: string) => {
				activeEditor = store.add(instantiation.createInstance(AdeEngineeringEditorInput, governorId));
				openedLog.push({ kind: 'engineering', target: governorId });
			},
			openSecretary: async () => {
				openedLog.push({ kind: 'secretary', target: ADE_SECRETARY_ID });
			},
			closeAgents: async () => { },
			openFile: async (resource: URI) => {
				openedLog.push({ kind: 'file', target: resource.toString() });
			},
			openDiff: async (_orig: URI, mod: URI) => {
				openedLog.push({ kind: 'diff', target: mod.toString() });
			},
		};
		instantiation.stub(IAdeEditorService, editorsStub);

		// Intercept real extension-host command signatures (`dispatchEngineeringTurn(uri, prompt, options)`, `killSession(uri)`, `stop(uri)`)
		const baseCommandService: ICommandService = {
			_serviceBrand: undefined,
			onWillExecuteCommand: Event.None,
			onDidExecuteCommand: Event.None,
			executeCommand: async <T = unknown>(id: string, ...args: unknown[]): Promise<T> => {
				if (id === 'aexus.agentEngines.dispatchEngineeringTurn') {
					const uri = args[0] as URI;
					const prompt = String(args[1] ?? '');
					const opts = (args[2] ?? {}) as {
						agentId?: string;
						model?: string;
						thinking?: string;
						pureWorker?: boolean;
						callerRole?: string;
						cwdOverride?: string;
					};
					const resolvedRole = opts.pureWorker ? 'worker' : (opts.callerRole ?? 'employee');
					dispatchedTurns.push({
						resource: URI.isUri(uri) ? uri.toString() : String(uri),
						prompt,
						agentId: opts.agentId,
						model: opts.model,
						thinking: opts.thinking,
						pureWorker: opts.pureWorker,
						callerRole: resolvedRole,
						cwdOverride: opts.cwdOverride,
					});
					if (opts.pureWorker && holdNextTurnDeferred) {
						const held = holdNextTurnDeferred;
						holdNextTurnDeferred = undefined;
						held.started.complete();
						const replyText = await held.reply.p;
						return { reply: replyText } as T;
					}
					return {
						reply: opts.pureWorker ? nextWorkerTurnReply : 'Acknowledged.',
					} as T;
				}
				if (id === 'aexus.agentEngines.killSession') {
					const uri = args[0] as URI;
					killedSessions.push(URI.isUri(uri) ? uri.toString() : String(uri));
					return { killed: true } as T;
				}
				if (id === 'aexus.agentEngines.stop') {
					const uri = args[0] as URI;
					stoppedSessions.push(URI.isUri(uri) ? uri.toString() : String(uri));
					return { stopped: true } as T;
				}
				const registered = CommandsRegistry.getCommand(id);
				if (!registered) {
					throw new Error(`Unregistered command in test: ${id}`);
				}
				return instantiation.invokeFunction(registered.handler, ...args) as Promise<T>;
			},
		};
		instantiation.stub(ICommandService, baseCommandService);

		const inbox = store.add(instantiation.createInstance(AdeInboxService));
		instantiation.stub(IAdeInboxService, inbox);

		const engineering = store.add(instantiation.createInstance(AdeEngineeringWorkbenchService));
		instantiation.stub(IAdeEngineeringService, engineering);

		return {
			instantiation,
			configService,
			navigation,
			projects,
			inbox,
			engineering,
			commandService: baseCommandService,
			createdSessions,
			deletedSessions,
			killedSessions,
			stoppedSessions,
			dispatchedTurns,
			openedLog,
			get confirmCallCount() { return confirmCallCount; },
			get promptCallCount() { return promptCallCount; },
			setNextPromptChoice: (choice: unknown) => { nextPromptChoice = choice; },
			setNextConfirmChoice: (confirmed: boolean) => { nextConfirmChoice = confirmed; },
			setNextWorkerReply: (reply: string) => { nextWorkerTurnReply = reply; },
			holdNextWorkerTurn: () => {
				const holder = {
					started: new DeferredPromise<void>(),
					reply: new DeferredPromise<string>(),
				};
				holdNextTurnDeferred = holder;
				return holder;
			},
			waitForNextConfirm: () => {
				nextConfirmSignal = new DeferredPromise<void>();
				return nextConfirmSignal.p;
			},
			waitForNextOpenAgent: () => {
				nextOpenAgentSignal = new DeferredPromise<string>();
				return nextOpenAgentSignal.p;
			},
		};
	}

	async function createGovernor(projects: IAdeProjectsService, sessions: IAdeSessionsService, label = 'Lead Governor'): Promise<IAdeAgent> {
		const session = await sessions.create('aexus-claude', projectUri);
		return projects.addSession(projectUri, session, label, { role: 'governor' });
	}

	test('Governor initialization handles existing subordinates (relocate vs delete), pre-creates lazy Manager/Employee/Worker hierarchy with 0 CLI spawns, and locks sidebar topology', async () => {
		const h = createEngineeringHarness();
		await h.engineering.whenReady();
		const sessions = h.instantiation.get(IAdeSessionsService);

		const gov1 = await createGovernor(h.projects, sessions, 'Gov Relocate');
		const freeChild1 = h.projects.addSession(projectUri, await sessions.create('aexus-codex', projectUri), 'Free Sub 1', {
			parentId: gov1.id,
			role: 'employee',
		});
		const freeChild2 = h.projects.addSession(projectUri, await sessions.create('aexus-codex', projectUri), 'Free Sub 2', {
			parentId: gov1.id,
		});

		// Direct init without specifying onChildren must fail cleanly
		await assert.rejects(
			() => h.engineering.initTree({ governorSessionId: gov1.id }),
			(err: unknown) => err instanceof AdeExistingSubordinatesError,
		);

		// UI OpenAdeEngineeringAction prompts user -> 'relocate' moves existing children to independent top-level sessions
		h.setNextPromptChoice('relocate');
		await h.commandService.executeCommand(ADE_OPEN_ENGINEERING_COMMAND_ID, gov1.id);
		assert.strictEqual(h.promptCallCount, 1);
		assert.strictEqual(h.projects.getAgent(freeChild1.id)?.parentId, undefined, 'Relocated child 1 must become top-level');
		assert.strictEqual(h.projects.getAgent(freeChild2.id)?.parentId, undefined, 'Relocated child 2 must become top-level');
		assert.strictEqual(h.projects.getAgent(gov1.id)?.treeType, 'engineering');
		assert.ok(h.openedLog.some(entry => entry.kind === 'engineering' && entry.target === gov1.id));

		// Second Governor: test 'delete' option
		const gov2 = await createGovernor(h.projects, sessions, 'Gov Delete');
		const doomedChild = h.projects.addSession(projectUri, await sessions.create('aexus-codex', projectUri), 'Doomed Sub', {
			parentId: gov2.id,
		});
		h.setNextPromptChoice('delete');
		await h.commandService.executeCommand(ADE_OPEN_ENGINEERING_COMMAND_ID, gov2.id);
		assert.strictEqual(h.projects.getAgent(doomedChild.id), undefined, 'Deleted child must be removed');
		assert.ok(h.engineering.hasTree(gov2.id));

		// Apply a Diamond + Gate Blueprint on gov1 and verify Maximal Non-Branching Path Manager Partitioning + Lazy Loading (0 CLI spawns!)
		const spawnsBeforeApply = h.createdSessions.length;
		const diamondBlueprint = [
			'---',
			'version: 1',
			'treeType: engineering',
			'workspaceIsolation: shared',
			'---',
			'',
			'```mermaid',
			'graph LR',
			'  A["Task A"] --> B["Task B"]',
			'  A --> C["Task C"]',
			'  B --> D["Task D"]',
			'  C --> D',
			'  D --> U1{{"Gate U1"}}',
			'  U1 --> E["Task E"]',
			'```',
			'',
			...(['A', 'B', 'C', 'D', 'E'].flatMap(id => [
				`## Node: ${id}`,
				`- Title: Task ${id}`,
				'- Type: task',
				`- Critical: ${id === 'D' ? 'true' : 'false'}`,
				'- Employee: engine=claude-code, thinking=medium',
				'- Worker: engine=codex, thinking=high',
				'### Goal',
				`Implement ${id}`,
				'### Acceptance Criteria',
				`${id} passes`,
				'',
			])),
			'## Node: U1',
			'- Title: Gate U1',
			'- Type: user_gate',
			'### Description',
			'Verify A-D before E',
		].join('\n');

		const snap = await h.engineering.applyBlueprint({
			governorSessionId: gov1.id,
			blueprintText: diamondBlueprint,
		});

		assert.strictEqual(h.createdSessions.length, spawnsBeforeApply, 'Pre-creating sidebar tree MUST NOT spawn any CLI sessions eagerly');
		assert.strictEqual(snap.blueprint.managers.length, 5, 'A->(B,C)->D->U1->E must partition into 5 Manager segments ([A], [B], [C], [D], [E])');

		const managers = h.projects.getDirectSubordinates(gov1.id);
		assert.strictEqual(managers.length, 5);
		const firstMgr = managers[0];
		const firstEmp = h.projects.getDirectSubordinates(firstMgr.id)[0];
		const firstWrk = h.projects.getDirectSubordinates(firstEmp.id)[0];
		assert.ok(firstEmp && firstWrk);
		assert.strictEqual(firstMgr.session, undefined, 'Lazy Manager has no materialized CLI session yet');
		assert.strictEqual(firstEmp.session, undefined, 'Lazy Employee has no materialized CLI session yet');
		assert.strictEqual(firstWrk.session, undefined, 'Lazy Worker has no materialized CLI session yet');
		assert.strictEqual(firstWrk.preferredEngineId, 'aexus-codex');
		assert.strictEqual(firstWrk.preferredThinking, 'high');

		// Verify strict sidebar & CLI topology locks (Spec 2.1 & 2.4)
		assert.strictEqual(h.projects.isLockedByWorkTree?.(gov1.id), true);
		assert.strictEqual(h.projects.isLockedByWorkTree?.(firstMgr.id), true);
		assert.strictEqual(h.projects.isLockedByWorkTree?.(firstEmp.id), true);
		assert.strictEqual(h.projects.isLockedByWorkTree?.(firstWrk.id), true);
		assert.strictEqual(h.projects.canReparentAgent(firstWrk.id, undefined, projectUri), false);
		assert.strictEqual(h.projects.canReparentAgent(freeChild1.id, gov1.id), false, 'Free session cannot be dragged into Engineering Governor');

		const dnd = store.add(new AdeProjectsDragAndDrop(h.projects, h.navigation, () => { }));
		assert.strictEqual(dnd.getDragURI({ kind: 'agent', agent: firstWrk }), null, 'Engineering nodes cannot be dragged in sidebar');

		await assert.rejects(
			() => h.commandService.executeCommand(ADE_CONTROL_EXECUTE_COMMAND_ID, 'session.reparent', { id: firstWrk.id, parentId: null }),
			/locked/i,
		);
		await assert.rejects(
			() => h.commandService.executeCommand(ADE_CONTROL_EXECUTE_COMMAND_ID, 'session.create', { parentId: gov1.id, engine: 'codex' }),
			/locked/i,
		);
		await assert.rejects(
			() => h.commandService.executeCommand(ADE_CONTROL_EXECUTE_COMMAND_ID, 'session.delete', { id: firstWrk.id }),
			/locked/i,
		);
	});

	test('Startup permission gate blocks Governor self-start, preserves 100% pure Worker context, and drives Employee 1-3 internal rework + 4th-chance Manager escalation', async () => {
		const h = createEngineeringHarness();
		await h.engineering.whenReady();
		const sessions = h.instantiation.get(IAdeSessionsService);
		const gov = await createGovernor(h.projects, sessions, 'Pure Context Gov');
		await h.engineering.initTree({ governorSessionId: gov.id });

		// Two linear non-critical tasks in a single Manager segment: N1 -> N2
		const linearBp = [
			'---',
			'version: 1',
			'treeType: engineering',
			'workspaceIsolation: shared',
			'---',
			'',
			'```mermaid',
			'graph LR',
			'  N1["Implement Parser"] --> N2["Add CLI Flags"]',
			'```',
			'',
			'## Node: N1',
			'- Title: Implement Parser',
			'- Type: task',
			'- Critical: false',
			'- Employee: engine=claude-code, thinking=medium',
			'- Worker: engine=codex, model=gpt-5-codex, thinking=high',
			'### Goal',
			'Write clean parser in src/parser.ts.',
			'### Acceptance Criteria',
			'All edge cases handled.',
			'',
			'## Node: N2',
			'- Title: Add CLI Flags',
			'- Type: task',
			'- Critical: false',
			'- Employee: engine=claude-code, thinking=medium',
			'- Worker: engine=codex, thinking=medium',
			'### Goal',
			'Wire CLI flags to parser.',
			'### Acceptance Criteria',
			'CLI help works.',
		].join('\n');

		await h.engineering.applyBlueprint({ governorSessionId: gov.id, blueprintText: linearBp });

		// Spec 3.1: Governor MUST NOT be allowed to start execution!
		await assert.rejects(
			() => h.engineering.runTree(gov.id, 'governor'),
			/Governor/i,
		);
		await assert.rejects(
			() => h.commandService.executeCommand(ADE_CONTROL_EXECUTE_COMMAND_ID, 'engineering.run', { id: gov.id, caller: 'governor' }),
			/Governor/i,
		);

		// Secretary IS authorized to start execution via CLI / control command!
		h.dispatchedTurns.length = 0;
		await h.commandService.executeCommand(ADE_CONTROL_EXECUTE_COMMAND_ID, 'engineering.run', { id: gov.id, caller: 'secretary' });
		await waitForNodePhase(h.engineering, gov.id, 'N1', 'employee_review');

		const workerTurns = h.dispatchedTurns.filter(t => t.callerRole === 'worker');
		assert.strictEqual(workerTurns.length, 1, 'Root Worker N1 must be woken once');
		const firstWorkerTurn = workerTurns[0];
		assert.strictEqual(firstWorkerTurn.pureWorker, true);
		assert.strictEqual(firstWorkerTurn.model, 'gpt-5-codex');
		assert.strictEqual(firstWorkerTurn.thinking, 'high');

		// Redline 1.2: Verify ZERO ADE role/CLI/report pollution in Worker prompt AND prompt-context resolver!
		assert.ok(!/aexus-ade/i.test(firstWorkerTurn.prompt), 'Worker prompt must contain ZERO aexus-ade references');
		assert.ok(!/Governor|Manager|Employee/i.test(firstWorkerTurn.prompt), 'Worker prompt must contain ZERO hierarchy rank words');
		assert.ok(!/write a report/i.test(firstWorkerTurn.prompt), 'Worker prompt must NOT ask Worker to write a report');

		const mgr = h.projects.getDirectSubordinates(gov.id)[0];
		const empN1 = h.projects.getDirectSubordinates(mgr.id).find(a => a.treeNodeId === 'N1')!;
		const wrkN1 = h.projects.getDirectSubordinates(empN1.id)[0];
		const workerPromptCtx = await h.commandService.executeCommand<string | undefined>(ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID, {
			resource: wrkN1.session!.resource.toString(),
		});
		assert.strictEqual(workerPromptCtx, undefined, 'Worker native session must receive 0% ADE role prompt injection');

		const empPromptCtx = await h.commandService.executeCommand<string | undefined>(ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID, {
			agentId: empN1.id,
		});
		assert.ok(empPromptCtx?.includes('engineering review'), 'Employee L3 must receive Engineering review CLI instructions');

		const firstWorkerResource = wrkN1.session!.resource.toString();

		// Employee Internal Rejection #1 -> Re-wakes SAME Worker session, visualStatus stays 'running' (NOT amber!)
		await h.engineering.submitReview({
			governorSessionId: gov.id,
			nodeId: 'N1',
			role: 'employee',
			verdict: 'reject',
			feedback: 'Missing null check on line 12',
		});
		await waitForNodePhase(h.engineering, gov.id, 'N1', 'employee_review');
		let snap = h.engineering.getTreeSnapshot(gov.id)!;
		assert.strictEqual(snap.state.nodes.N1.employeeRejectCount, 1);
		assert.strictEqual(snap.state.nodes.N1.formalFailureCount, 0);
		assert.strictEqual(h.projects.getAgent(wrkN1.id)?.session?.resource.toString(), firstWorkerResource, 'Must reuse original Worker session');
		assert.strictEqual(snap.nodes.find(n => n.node.id === 'N1')?.visualStatus, 'running', 'Internal rework 1 must stay green running, not amber');

		// Employee Internal Rejection #2 -> Re-wakes SAME Worker session, visualStatus still 'running'
		await h.engineering.submitReview({
			governorSessionId: gov.id,
			nodeId: 'N1',
			role: 'employee',
			verdict: 'reject',
			feedback: 'Still missing empty-input test',
		});
		await waitForNodePhase(h.engineering, gov.id, 'N1', 'employee_review');
		snap = h.engineering.getTreeSnapshot(gov.id)!;
		assert.strictEqual(snap.state.nodes.N1.employeeRejectCount, 2);
		assert.strictEqual(snap.nodes.find(n => n.node.id === 'N1')?.visualStatus, 'running');

		// Employee Internal Rejection #3 -> Escalates to Segment Manager (`manager_escalation`) without waking Worker yet!
		const workerCountBefore3rd = h.dispatchedTurns.filter(t => t.callerRole === 'worker').length;
		snap = await h.engineering.submitReview({
			governorSessionId: gov.id,
			nodeId: 'N1',
			role: 'employee',
			verdict: 'reject',
			feedback: '3rd internal rejection — stuck on tokenizer',
		});
		assert.strictEqual(snap.state.nodes.N1.phase, 'manager_escalation');
		assert.strictEqual(h.dispatchedTurns.filter(t => t.callerRole === 'worker').length, workerCountBefore3rd, 'Must wait for Manager guidance on 3rd Employee rejection');
		assert.ok(h.dispatchedTurns.some(t => t.callerRole === 'manager'), 'Segment Manager must be woken on 3rd internal rejection');

		// Segment Manager grants 4th chance via `verdict: 'guidance'`!
		await h.engineering.submitReview({
			governorSessionId: gov.id,
			nodeId: 'N1',
			role: 'manager',
			verdict: 'guidance',
			feedback: 'Clear previous regex assumption and use state-machine scanner.',
		});
		await waitForNodePhase(h.engineering, gov.id, 'N1', 'employee_review');

		// Employee now passes N1 (non-critical, non-tail) -> immediately advances to N2 WITHOUT waking Manager!
		const managerTurnsBeforePass = h.dispatchedTurns.filter(t => t.callerRole === 'manager').length;
		await h.engineering.submitReview({
			governorSessionId: gov.id,
			nodeId: 'N1',
			role: 'employee',
			verdict: 'pass',
			report: 'Implemented state-machine parser in src/parser.ts with full edge-case tests.',
		});
		await waitForNodePhase(h.engineering, gov.id, 'N2', 'employee_review');
		snap = h.engineering.getTreeSnapshot(gov.id)!;
		assert.strictEqual(snap.state.nodes.N1.completed, true);
		assert.strictEqual(h.dispatchedTurns.filter(t => t.callerRole === 'manager').length, managerTurnsBeforePass, 'Non-critical non-tail node pass must NOT wake Manager');
	});

	test('Manager 3-tier formal failure ladder (Light Amber -> Deep Amber -> Red Circuit Breaker) wakes Governor and posts to ADE Inbox', async () => {
		const h = createEngineeringHarness();
		await h.engineering.whenReady();
		const sessions = h.instantiation.get(IAdeSessionsService);
		const gov = await createGovernor(h.projects, sessions, 'Circuit Breaker Gov');
		await h.engineering.initTree({ governorSessionId: gov.id });

		const singleCritBp = [
			'---',
			'version: 1',
			'treeType: engineering',
			'workspaceIsolation: shared',
			'---',
			'',
			'```mermaid',
			'graph LR',
			'  N1["Critical Payment Core"]',
			'```',
			'',
			'## Node: N1',
			'- Title: Critical Payment Core',
			'- Type: task',
			'- Critical: true',
			'- Employee: engine=claude-code, thinking=high',
			'- Worker: engine=codex, thinking=max',
			'### Goal',
			'Implement idempotent ledger settlement.',
			'### Acceptance Criteria',
			'Zero double-spend under concurrency.',
		].join('\n');

		await h.engineering.applyBlueprint({ governorSessionId: gov.id, blueprintText: singleCritBp });
		await h.engineering.runTree(gov.id, 'user');
		await waitForNodePhase(h.engineering, gov.id, 'N1', 'employee_review');

		// Employee passes #1 -> enters Manager secondary review
		let snap = await h.engineering.submitReview({
			governorSessionId: gov.id,
			nodeId: 'N1',
			role: 'employee',
			verdict: 'pass',
			report: 'Attempt 1 ledger report',
		});
		assert.strictEqual(snap.state.nodes.N1.phase, 'manager_review');

		// 1st Manager Formal Rejection -> failure_1 (Light Amber!)
		snap = await h.engineering.submitReview({
			governorSessionId: gov.id,
			nodeId: 'N1',
			role: 'manager',
			verdict: 'reject',
			feedback: 'Formal Failure 1: Missing advisory lock around balance transfer.',
		});
		assert.strictEqual(snap.state.nodes.N1.formalFailureCount, 1);
		assert.strictEqual(snap.nodes.find(n => n.node.id === 'N1')?.visualStatus, 'failure_1', '1st Manager failure must render Light Amber (failure_1)');
		await waitForNodePhase(h.engineering, gov.id, 'N1', 'employee_review');

		// Employee passes #2 -> Manager Formal Rejection #2 -> failure_2 (Deep Amber!)
		await h.engineering.submitReview({
			governorSessionId: gov.id,
			nodeId: 'N1',
			role: 'employee',
			verdict: 'pass',
			report: 'Attempt 2 ledger report',
		});
		snap = await h.engineering.submitReview({
			governorSessionId: gov.id,
			nodeId: 'N1',
			role: 'manager',
			verdict: 'reject',
			feedback: 'Formal Failure 2: Deadlock possible when accounts ordered inversely.',
		});
		assert.strictEqual(snap.state.nodes.N1.formalFailureCount, 2);
		assert.strictEqual(snap.nodes.find(n => n.node.id === 'N1')?.visualStatus, 'failure_2', '2nd Manager failure must render Deep Amber (failure_2)');
		await waitForNodePhase(h.engineering, gov.id, 'N1', 'employee_review');

		// Employee passes #3 -> Manager Formal Rejection #3 -> failure_3 (Red Circuit Breaker + wakes Governor!)
		const govTurnsBefore = h.dispatchedTurns.filter(t => t.callerRole === 'governor').length;
		await h.engineering.submitReview({
			governorSessionId: gov.id,
			nodeId: 'N1',
			role: 'employee',
			verdict: 'pass',
			report: 'Attempt 3 ledger report',
		});
		snap = await h.engineering.submitReview({
			governorSessionId: gov.id,
			nodeId: 'N1',
			role: 'manager',
			verdict: 'reject',
			feedback: 'Formal Failure 3: Isolation level still READ COMMITTED instead of SERIALIZABLE.',
		});
		assert.strictEqual(snap.state.nodes.N1.formalFailureCount, 3);
		assert.strictEqual(snap.state.nodes.N1.phase, 'circuit_broken');
		assert.strictEqual(snap.state.runStatus, 'circuit_broken');
		assert.strictEqual(snap.nodes.find(n => n.node.id === 'N1')?.visualStatus, 'failure_3', '3rd Manager failure must render Crimson Red (failure_3)');
		assert.strictEqual(h.dispatchedTurns.filter(t => t.callerRole === 'governor').length, govTurnsBefore + 1, 'Circuit breaker MUST wake Governor');

		// Governor escalates to ADE Inbox via control CLI command `inbox.post`
		const postRes = await h.commandService.executeCommand<IAdeInboxItem>(ADE_CONTROL_EXECUTE_COMMAND_ID, 'inbox.post', {
			governorId: gov.id,
			nodeId: 'N1',
			title: 'Circuit Broken on N1',
			message: 'Need human confirmation whether CockroachDB SERIALIZABLE is enabled in prod.',
		});
		assert.strictEqual(postRes.kind, 'governor_message');
		assert.strictEqual(h.inbox.unreadCount, 1);
	});

	test('User Acceptance Gate blocks downstream, supports Surgical Partial Rollback preserving parallel branches, overwrites stale reports, and deduplicates diamond report chains', async () => {
		const h = createEngineeringHarness();
		await h.engineering.whenReady();
		const sessions = h.instantiation.get(IAdeSessionsService);
		const gov = await createGovernor(h.projects, sessions, 'Surgical Gate Gov');
		await h.engineering.initTree({ governorSessionId: gov.id });

		// Topology:
		//   A -> B -> C -> U1 -> E
		//   A -> D ------------> E
		// Rolling back U1 to A MUST reset {A, B, C, U1} while keeping parallel task D 100% completed & untouched!
		const bp = [
			'---',
			'version: 1',
			'treeType: engineering',
			'workspaceIsolation: shared',
			'---',
			'',
			'```mermaid',
			'graph LR',
			'  A["Task A"] --> B["Task B"]',
			'  B --> C["Task C"]',
			'  C --> U1{{"Gate U1"}}',
			'  U1 --> E["Task E"]',
			'  A --> D["Parallel D"]',
			'  D --> E',
			'```',
			'',
			...(['A', 'B', 'C', 'D', 'E'].flatMap(id => [
				`## Node: ${id}`,
				`- Title: Task ${id}`,
				'- Type: task',
				'- Critical: false',
				'- Employee: engine=claude-code, thinking=medium',
				'- Worker: engine=codex, thinking=high',
				'### Goal',
				`Implement ${id}`,
				'### Acceptance Criteria',
				`${id} works`,
				'',
			])),
			'## Node: U1',
			'- Title: Gate U1',
			'- Type: user_gate',
			'### Description',
			'Inspect A->B->C deliverables',
		].join('\n');

		await h.engineering.applyBlueprint({ governorSessionId: gov.id, blueprintText: bp });
		await h.engineering.runTree(gov.id, 'user');
		await waitForNodePhase(h.engineering, gov.id, 'A', 'employee_review');

		// Complete A after 1 Manager formal failure so we also verify surgical rollback resets formalFailureCount cleanly!
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'A', role: 'employee', verdict: 'pass', report: 'Report A-v0' });
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'A', role: 'manager', verdict: 'reject', feedback: 'Add signature check' });
		await waitForNodePhase(h.engineering, gov.id, 'A', 'employee_review');
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'A', role: 'employee', verdict: 'pass', report: 'Report A-v1' });
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'A', role: 'manager', verdict: 'pass' });

		// Wait for both parallel branches B (segment [B->C]) and D (segment [D]) to finish their Worker turns
		await waitForNodePhase(h.engineering, gov.id, 'B', 'employee_review');
		await waitForNodePhase(h.engineering, gov.id, 'D', 'employee_review');

		// Complete D ('Report D-v1')
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'D', role: 'employee', verdict: 'pass', report: 'Report D-v1' });
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'D', role: 'manager', verdict: 'pass' });

		// Complete B ('Report B-v1') -> starts C; complete C ('Report C-v1') + Manager pass on segment [B->C]
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'B', role: 'employee', verdict: 'pass', report: 'Report B-v1' });
		await waitForNodePhase(h.engineering, gov.id, 'C', 'employee_review');
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'C', role: 'employee', verdict: 'pass', report: 'Report C-v1' });
		let snap = await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'C', role: 'manager', verdict: 'pass' });

		// Gate U1 must now be active (`waiting_user_gate`), E must still be idle, and ADE Inbox must have an unread `user_gate` todo!
		assert.strictEqual(snap.state.nodes.U1.phase, 'waiting_user_gate');
		assert.strictEqual(snap.state.nodes.E.phase, 'idle');
		const gateInbox = h.inbox.list({ unreadOnly: true }).find(i => i.kind === 'user_gate' && i.nodeId === 'U1');
		assert.ok(gateInbox, 'User Gate U1 must post an unread approval card to ADE Inbox');

		// Trigger Surgical Partial Rollback from U1 back to A!
		snap = await h.engineering.submitGateVerdict({
			governorSessionId: gov.id,
			nodeId: 'U1',
			verdict: 'rollback',
			targetNodeId: 'A',
			feedback: 'Update token format to JWT v2',
		});

		// Verify A, B, C, U1 are rolled back (with fresh formalFailureCount = 0), while parallel D stays 100% completed with 'Report D-v1'!
		assert.strictEqual(snap.state.nodes.D.completed, true, 'Parallel branch D MUST NOT be reset by U1->A partial rollback');
		assert.strictEqual(snap.state.reports.D?.summary, 'Report D-v1');
		assert.strictEqual(snap.state.nodes.A.formalFailureCount, 0, 'Rolled-back node A must reset formalFailureCount to 0');
		assert.strictEqual(snap.state.nodes.B.completed, false, 'Path node B must be reset');
		assert.strictEqual(snap.state.nodes.C.completed, false, 'Path node C must be reset');
		assert.strictEqual(snap.state.nodes.U1.completed, false, 'Gate U1 must be reset');

		// Complete rework of A ('Report A-v2'), B ('Report B-v2'), C ('Report C-v2')
		await waitForNodePhase(h.engineering, gov.id, 'A', 'employee_review');
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'A', role: 'employee', verdict: 'pass', report: 'Report A-v2' });
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'A', role: 'manager', verdict: 'pass' });
		await waitForNodePhase(h.engineering, gov.id, 'B', 'employee_review');
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'B', role: 'employee', verdict: 'pass', report: 'Report B-v2' });
		await waitForNodePhase(h.engineering, gov.id, 'C', 'employee_review');
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'C', role: 'employee', verdict: 'pass', report: 'Report C-v2' });
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'C', role: 'manager', verdict: 'pass' });
		assert.strictEqual(h.engineering.getTreeSnapshot(gov.id)?.state.nodes.U1.phase, 'waiting_user_gate');

		// Approve U1 via CLI command `engineering.gate`!
		h.dispatchedTurns.length = 0;
		await h.commandService.executeCommand(ADE_CONTROL_EXECUTE_COMMAND_ID, 'engineering.gate', {
			id: gov.id,
			nodeId: 'U1',
			verdict: 'pass',
		});
		await waitForNodePhase(h.engineering, gov.id, 'E', 'employee_review');
		snap = h.engineering.getTreeSnapshot(gov.id)!;
		assert.strictEqual(snap.state.nodes.U1.completed, true);

		// Inspect Worker E's prompt: must contain deduplicated topological upstream reports A-v2, B-v2, C-v2, D-v1 (and NEVER stale A-v1!)
		const eWorkerTurn = h.dispatchedTurns.find(t => t.callerRole === 'worker');
		assert.ok(eWorkerTurn);
		assert.ok(eWorkerTurn.prompt.includes('Report A-v2'), 'Must include overwritten Report A-v2');
		assert.ok(!eWorkerTurn.prompt.includes('Report A-v1'), 'Must NEVER include overwritten stale Report A-v1');
		assert.ok(eWorkerTurn.prompt.includes('Report B-v2'));
		assert.ok(eWorkerTurn.prompt.includes('Report C-v2'));
		assert.ok(eWorkerTurn.prompt.includes('Report D-v1'), 'Must include preserved parallel Report D-v1');
		const occurrencesOfAv2 = eWorkerTurn.prompt.split('Report A-v2').length - 1;
		assert.strictEqual(occurrencesOfAv2, 1, 'Diamond ancestor report A-v2 must be deduplicated cleanly');
	});

	test('Watchdog heartbeat monitor wakes Segment Manager on timeout and kill-restart terminates stalled process & re-dispatches pure Worker', async () => {
		const h = createEngineeringHarness();
		await h.engineering.whenReady();
		const sessions = h.instantiation.get(IAdeSessionsService);
		const gov = await createGovernor(h.projects, sessions, 'Watchdog Gov');
		await h.engineering.initTree({ governorSessionId: gov.id });

		// Hold the Worker turn open so node N1 stays actively in `worker_running`!
		const heldTurn = h.holdNextWorkerTurn();
		await h.engineering.runTree(gov.id, 'user');
		await heldTurn.started.p;
		assert.strictEqual(h.dispatchedTurns.length, 1);

		const mgr = h.projects.getDirectSubordinates(gov.id)[0];
		const emp = h.projects.getDirectSubordinates(mgr.id)[0];
		const wrk = h.projects.getDirectSubordinates(emp.id)[0];
		const workerResource = wrk.session!.resource.toString();

		// Verify heartbeat command updates `lastStreamActivityAt`
		const hbTs = 1_700_000_000_000;
		await h.commandService.executeCommand(ADE_WORKER_HEARTBEAT_COMMAND_ID, workerResource, hbTs);
		const snapAfterHb = h.engineering.getTreeSnapshot(gov.id)!;
		assert.strictEqual(snapAfterHb.state.nodes.N1.lastStreamActivityAt, hbTs);

		// Simulate 15 minutes of inactivity -> Watchdog sweep wakes Segment Manager!
		await h.engineering.runWatchdogSweep(hbTs + 15 * 60_000);
		assert.ok(h.dispatchedTurns.some(t => t.callerRole === 'manager' && t.prompt.includes('Watchdog Timeout Alert')), 'Watchdog timeout must wake Segment Manager');

		// Manager executes `watchdog-action --action kill-restart` on stalled N1
		await h.commandService.executeCommand(
			ADE_CONTROL_EXECUTE_COMMAND_ID,
			'engineering.watchdogAction',
			{ id: gov.id, nodeId: 'N1', watchdogAction: 'kill-restart' },
		);

		// Unblock the old stale turn — runToken guard must ignore it while the restarted Worker turn advances N1 to `employee_review`!
		heldTurn.reply.complete('stale output from killed process');
		await waitForNodePhase(h.engineering, gov.id, 'N1', 'employee_review');

		assert.ok(h.killedSessions.includes(workerResource), 'Watchdog kill-restart must kill stalled Worker subprocess');
		assert.strictEqual(h.engineering.getTreeSnapshot(gov.id)?.state.nodes.N1.phase, 'employee_review');
	});

	test('Visual DOM verification: AdeEngineeringEditorPane concentric nodes, pistol cursor, hover drawer, single-click jump, draft lock/confirm & AdeProjectsView Inbox switcher', async () => {
		const host = append(mainWindow.document.body, $('div.monaco-workbench', { style: 'position:fixed;left:0;top:0;width:1100px;height:720px;' }));
		const sidebarHost = append(mainWindow.document.body, $('div.monaco-workbench', { style: 'position:fixed;left:0;top:0;width:300px;height:640px;' }));
		const inboxStandaloneHost = append(mainWindow.document.body, $('div.monaco-workbench', { style: 'position:fixed;left:0;top:0;width:320px;height:520px;' }));
		store.add({
			dispose: () => {
				host.remove();
				sidebarHost.remove();
				inboxStandaloneHost.remove();
			},
		});

		const h = createEngineeringHarness();
		await h.engineering.whenReady();
		const sessions = h.instantiation.get(IAdeSessionsService);
		const gov = await createGovernor(h.projects, sessions, 'Visual Craft Gov');
		await h.engineering.initTree({ governorSessionId: gov.id });

		// Apply a 3-node workflow: N1 (Critical Task) -> U1 (User Gate) -> N2 (Task)
		const visualBp = [
			'---',
			'version: 1',
			'treeType: engineering',
			'workspaceIsolation: shared',
			'---',
			'',
			'```mermaid',
			'graph LR',
			'  N1["Architecture & Core Contracts"] --> U1{{"User Gate"}}',
			'  U1 --> N2["UI Implementation"]',
			'```',
			'',
			'## Node: N1',
			'- Title: Architecture & Core Contracts',
			'- Type: task',
			'- Critical: true',
			'- Employee: engine=claude-code, thinking=high',
			'- Worker: engine=codex, thinking=high',
			'### Goal',
			'Design core contracts.',
			'### Acceptance Criteria',
			'Types compile cleanly.',
			'',
			'## Node: U1',
			'- Title: User Gate',
			'- Type: user_gate',
			'### Description',
			'Inspect contracts before UI.',
			'',
			'## Node: N2',
			'- Title: UI Implementation',
			'- Type: task',
			'- Critical: false',
			'- Employee: engine=claude-code, thinking=medium',
			'- Worker: engine=codex, thinking=high',
			'### Goal',
			'Implement UI.',
			'### Acceptance Criteria',
			'UI renders cleanly.',
		].join('\n');
		await h.engineering.applyBlueprint({ governorSessionId: gov.id, blueprintText: visualBp });

		// Mount AdeEngineeringEditorPane in real Chromium DOM
		const fakeGroup = new class extends mock<IEditorGroup>() {
			override readonly id = 1;
		}();
		const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, fakeGroup));
		pane.create(host);
		pane.layout({ width: 1100, height: 720, top: 0, left: 0 } as never);

		const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, gov.id));
		await pane.setInput(input, undefined, {}, CancellationToken.None);

		// 1. Verify Dual-Core Concentric Task Nodes, User Gate Node, Pistol Cursor, Manager Segment Halos & Computed CSS Geometry
		const concentricNodes = host.querySelectorAll('.ade-eng-concentric.ade-pistol-cursor');
		assert.strictEqual(concentricNodes.length, 2, 'Renders 2 dual-core concentric task nodes with pistol cursor');
		assert.ok(host.querySelector('.ade-eng-outer-ring-svg'), 'Outer Employee status ring SVG rendered');
		assert.ok(host.querySelector('.ade-eng-inner-core .ade-eng-engine-glyph'), 'Inner Worker native engine glyph rendered');
		assert.ok(host.querySelector('.ade-eng-emp-satellite .ade-eng-engine-glyph'), 'Outer Employee satellite engine glyph rendered');
		assert.ok(host.querySelector('.ade-eng-critical-badge'), 'Critical ★ badge rendered on critical node');
		assert.ok(host.querySelector('.ade-eng-gate-body.ade-pistol-cursor'), 'Hexagonal User Gate node rendered with pistol cursor');
		assert.strictEqual(host.querySelectorAll('.ade-eng-segment-halo').length, 2, 'Auto-partitioned Manager segment halos rendered');

		const computedPistolCursor = mainWindow.getComputedStyle(concentricNodes[0] as HTMLElement).cursor;
		assert.ok(computedPistolCursor.includes('data:image/svg+xml'), 'Pistol cursor custom SVG data-URI is applied in computed CSS');
		const concRect = (concentricNodes[0] as HTMLElement).getBoundingClientRect();
		const n1PortOut = host.querySelector('.ade-eng-node[data-node-id="N1"] .ade-eng-port.port-out') as HTMLElement;
		const portOutRect = n1PortOut.getBoundingClientRect();
		assert.ok(Math.abs((concRect.top + concRect.height / 2) - (portOutRect.top + portOutRect.height / 2)) <= 1.5, 'Output port Y aligns pixel-perfectly with concentric circle center');

		// 2. Verify Zero-Click Hover automatically opens Slide-Out Right Drawer!
		const nodeN1El = host.querySelector('.ade-eng-node[data-node-id="N1"]') as HTMLElement;
		assert.ok(nodeN1El);
		const drawerEl = host.querySelector('.ade-eng-drawer') as HTMLElement;
		assert.ok(!drawerEl.classList.contains('open'), 'Drawer starts closed');

		nodeN1El.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
		assert.ok(drawerEl.classList.contains('open'), 'Hovering node must open Right Drawer with zero clicks');
		assert.ok(drawerEl.textContent?.includes('Architecture & Core Contracts'));

		// 3. Verify Single Left-Click on Task Node jumps directly to Worker session!
		h.openedLog.length = 0;
		const openedSessionPromise = h.waitForNextOpenAgent();
		nodeN1El.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 200, clientY: 240, bubbles: true }));
		nodeN1El.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 200, clientY: 240, bubbles: true }));
		await openedSessionPromise;
		assert.strictEqual(h.openedLog.length, 1, 'Single left-click on task node must open its Coding Agent session');
		assert.strictEqual(h.openedLog[0].kind, 'agent');

		// 4. Verify Draft Authoring + Cancel Revert
		const addTaskBtn = Array.from(host.querySelectorAll('.ade-eng-tool-btn')).find(b => b.textContent?.includes('Task')) as HTMLButtonElement;
		assert.ok(addTaskBtn);
		addTaskBtn.click();
		assert.ok(host.querySelector('.ade-eng-draft-badge'), 'Adding node enters Draft Unsaved mode');
		assert.strictEqual(host.querySelectorAll('.ade-eng-node').length, 4);

		const cancelBtn = Array.from(host.querySelectorAll('.ade-eng-action-btn')).find(b => b.textContent === 'Cancel') as HTMLButtonElement;
		assert.ok(cancelBtn);
		cancelBtn.click();
		assert.strictEqual(host.querySelector('.ade-eng-draft-badge'), null, 'Cancel reverts draft cleanly');
		assert.strictEqual(host.querySelectorAll('.ade-eng-node').length, 3);

		// 5. Verify Running-Node Animated Edge, Force-Stop Confirmation Prompt, and Completed-Node Lock!
		await h.engineering.runTree(gov.id, 'user');
		await waitForNodePhase(h.engineering, gov.id, 'N1', 'employee_review');
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'N1', role: 'employee', verdict: 'pass', report: 'N1 complete' });
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'N1', role: 'manager', verdict: 'pass' });

		const lockedN1El = host.querySelector('.ade-eng-node[data-node-id="N1"]') as HTMLElement;
		assert.ok(lockedN1El.classList.contains('status-completed') && lockedN1El.classList.contains('locked'), 'Completed N1 renders green completed + locked');
		const runningEdgeEl = host.querySelector('.ade-eng-edge-path.status-running');
		assert.ok(runningEdgeEl, 'Edge feeding active User Gate U1 renders animated green dashed status-running path');

		// Inspect N1 Configure tab -> inputs must be disabled!
		lockedN1El.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
		const configTabBtn = Array.from(drawerEl.querySelectorAll('.ade-eng-drawer-tab')).find(b => b.textContent?.includes('Configure')) as HTMLButtonElement;
		configTabBtn.click();
		const lockedTitleInput = drawerEl.querySelector('input.ade-eng-input') as HTMLInputElement;
		assert.strictEqual(lockedTitleInput.disabled, true, 'Completed node configuration inputs must be strictly locked');

		// Approve U1 via standalone AdeInboxPanel while holding N2's Worker turn so N2 is actively `worker_running`!
		const inboxPanel = store.add(new AdeInboxPanel(inboxStandaloneHost, h.inbox, h.engineering, h.instantiation.get(IAdeEditorService)));
		inboxPanel.setVisible(true);
		const heldN2 = h.holdNextWorkerTurn();
		const approveGateBtn = Array.from(inboxStandaloneHost.querySelectorAll('.ade-inbox-btn.primary')).find(b => b.textContent?.includes('Approve')) as HTMLButtonElement;
		assert.ok(approveGateBtn, 'ADE Inbox renders interactive Approve button for User Gate U1');
		approveGateBtn.click();

		await heldN2.started.p;
		assert.strictEqual(h.engineering.getTreeSnapshot(gov.id)?.state.nodes.N2?.phase, 'worker_running');

		// Edit running node N2's title in Draft mode and click Confirm -> must trigger IDialogService.confirm!
		const nodeN2El = host.querySelector('.ade-eng-node[data-node-id="N2"]') as HTMLElement;
		nodeN2El.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
		const n2TitleInput = drawerEl.querySelector('input.ade-eng-input') as HTMLInputElement;
		assert.strictEqual(n2TitleInput.disabled, false);
		n2TitleInput.value = 'Updated Running Task N2';
		n2TitleInput.dispatchEvent(new mainWindow.Event('change'));

		h.setNextConfirmChoice(true);
		const confirmDone = h.waitForNextConfirm();
		const confirmBtn = Array.from(host.querySelectorAll('.ade-eng-action-btn.confirm'))[0] as HTMLButtonElement;
		assert.ok(confirmBtn);
		confirmBtn.click();

		heldN2.reply.complete('stopped');
		await confirmDone;
		assert.strictEqual(h.confirmCallCount, 1, 'Confirming draft changes that affect a running node MUST prompt user confirmation');

		pane.clearInput();

		// 6. Mount AdeProjectsView and verify `Engineering` badge + `Projects | Inbox` segmented switcher!
		const dummySidebar = { id: 'ade' } as ViewContainer;
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
		const sidebarView = store.add(h.instantiation.createInstance(AdeProjectsView, {
			id: ADE_PROJECTS_VIEW_ID,
			title: 'Sessions',
		}));
		sidebarView.render();
		append(sidebarHost, sidebarView.element);
		sidebarView.setVisible(true);
		sidebarView.orthogonalSize = 300;
		sidebarView.layout(600);
		h.navigation.enterProject(projectUri);
		await sidebarView.refresh();

		const segBtns = sidebarHost.querySelectorAll('.ade-sidebar-seg-btn');
		assert.strictEqual(segBtns.length, 2, 'Sidebar renders Projects | Inbox segmented tabs');
		const worktreeBadge = sidebarHost.querySelector('.ade-worktree-badge:not([hidden])') as HTMLElement | null;
		assert.ok(worktreeBadge && worktreeBadge.textContent === 'Engineering', 'Governor row displays Engineering badge');

		sidebarView.setSidebarMode('inbox');
		const embeddedInbox = sidebarHost.querySelector('.ade-inbox-panel') as HTMLElement | null;
		assert.ok(embeddedInbox && !embeddedInbox.hidden, 'Switching to Inbox tab reveals embedded ADE Inbox panel');
	});
});
