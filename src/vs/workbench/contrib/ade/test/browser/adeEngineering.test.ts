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
import { IConfirmation, IConfirmationResult, IDialogService, IPrompt, IPromptResultWithCancel } from '../../../../../platform/dialogs/common/dialogs.js';
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
	ADE_ENG_MAX_PARTICLE_EDGES,
	ADE_ENG_PARTICLES_PER_EDGE,
	ADE_ENG_PHASE_SOFT_SLA_MS,
	AdeEngineeringEditorInput,
	AdeEngineeringEditorPane,
	blueprintNodeIdAtOffset,
	computeEngineeringWorldSize,
	computeQuickSpawnPosition,
	computeTokenRatePerMinute,
} from '../../browser/adeEngineeringEditorPane.js';
import {
	ADE_RECORD_TURN_USAGE_COMMAND_ID,
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

	async function waitForDomCondition(probe: () => boolean, timeoutMs = 2000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!probe()) {
			assert.ok(Date.now() < deadline, 'Timed out waiting for the Engineering DOM to re-render');
			await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 5));
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
			override async prompt<T>(prompt: IPrompt<T>): Promise<IPromptResultWithCancel<T>> {
				promptCallCount++;
				if (nextPromptChoice === undefined) {
					return { result: undefined as unknown as T };
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
				rootPath: cwd,
				capturedAt: Date.now(),
				entries: {},
			}),
			computeWorkerTurnChanges: async (): Promise<IAdeWorkerTurnChanges> => ({
				capturedAt: Date.now(),
				touchedFiles: [{ relativePath: 'src/auth.ts', kind: 'modified' }],
				combinedDiff: simulatedDiffSummary,
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
				return instantiation.invokeFunction(registered.handler, ...args) as unknown as Promise<T>;
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
		assert.ok(postRes);
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

	test('Visual DOM verification: AdeEngineeringEditorPane concentric nodes, pistol cursor, right-click popover, single-click jump, draft lock/confirm & AdeProjectsView Inbox switcher', async () => {
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

		// 0. Verify the Engineering toolbar renders the Token Consumption pill and starts empty before any turn runs
		const tokensPill = host.querySelector('.ade-eng-tokens-pill') as HTMLElement | null;
		assert.ok(tokensPill, 'Engineering toolbar renders the token consumption pill');
		assert.strictEqual(tokensPill.textContent, '0 tok', 'Token pill starts at 0 tokens before any turn executes');
		assert.strictEqual(tokensPill.classList.contains('has-usage'), false, 'Token pill has no usage class before any turn executes');

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

		// 2. Verify right-click (contextmenu) opens the Anchored Floating Option Popover, while hover NEVER auto-opens it (NO sidebar drawer!)
		const nodeN1El = host.querySelector('.ade-eng-node[data-node-id="N1"]') as HTMLElement;
		assert.ok(nodeN1El);
		const segHeaderEl = host.querySelector('.ade-eng-segment-header') as HTMLElement;
		assert.ok(segHeaderEl, 'Manager segment header rendered');
		assert.strictEqual(host.querySelector('.ade-eng-drawer'), null, 'Legacy right-hand sidebar drawer must not exist');
		const popoverEl = host.querySelector('.ade-eng-popover') as HTMLElement;
		assert.ok(popoverEl && !popoverEl.classList.contains('open'), 'Floating option popover starts closed');

		nodeN1El.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
		segHeaderEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
		assert.strictEqual(popoverEl.classList.contains('open'), false, 'Hovering a node or Manager segment header must NEVER auto-open the floating option popover');

		nodeN1El.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
		assert.strictEqual(popoverEl.classList.contains('open'), true, 'Right-clicking node must open adjacent floating option list');
		const popTitleInput = popoverEl.querySelector('input.ade-eng-pop-title-input') as HTMLInputElement;
		assert.strictEqual(popTitleInput.value, 'Architecture & Core Contracts');
		assert.strictEqual(popoverEl.querySelectorAll('.ade-eng-engine-opt').length, 8, 'All 8 Coding Agent engine options rendered in adjacent floating menu');

		// 2b. Verify the popover close icon button and Escape both dismiss it
		const closePopoverBtn = popoverEl.querySelector('.ade-eng-pop-icon-btn.close') as HTMLButtonElement | null;
		assert.ok(closePopoverBtn, 'Floating option popover exposes a close icon button');
		closePopoverBtn.click();
		assert.strictEqual(popoverEl.classList.contains('open'), false, 'Close icon button must close the floating option popover');

		nodeN1El.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
		assert.strictEqual(popoverEl.classList.contains('open'), true, 'Right-clicking node must re-open the floating option popover');
		popoverEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.strictEqual(popoverEl.classList.contains('open'), false, 'Escape key must close the floating option popover');

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

		// 5b. Verify Engineering Token Counting: recording a turn's usage accumulates onto the tree, the Worker role bucket and node N1
		const n1WorkerAgentId = h.engineering.getTreeSnapshot(gov.id)?.state.nodes.N1.workerAgentId;
		assert.ok(n1WorkerAgentId, 'Completed N1 exposes its Worker agent id for turn usage attribution');
		await h.commandService.executeCommand(ADE_RECORD_TURN_USAGE_COMMAND_ID, {
			agentId: n1WorkerAgentId,
			usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 500, totalTokens: 2000 },
		});

		const usageSnap = h.engineering.getTreeSnapshot(gov.id)!;
		assert.ok(usageSnap.tokenUsage.total.totalTokens >= 2000, 'Tree token total includes the recorded 2000-token turn');
		assert.ok(usageSnap.tokenUsage.worker.totalTokens >= 2000, 'Worker (L4) token bucket includes the recorded 2000-token turn');
		assert.ok((usageSnap.state.nodes.N1.tokenUsage?.total.totalTokens ?? 0) >= 2000, 'Node N1 token breakdown includes the recorded 2000-token turn');

		await waitForDomCondition(() => Boolean(
			host.querySelector('.ade-eng-tokens-pill.has-usage')
			&& host.querySelector('.ade-eng-node[data-node-id="N1"] .ade-eng-node-tokens'),
		));
		const refreshedTokensPill = host.querySelector('.ade-eng-tokens-pill') as HTMLElement;
		assert.ok(refreshedTokensPill.classList.contains('has-usage'), 'Toolbar token pill switches to has-usage once turns are accounted');
		assert.ok(host.querySelector('.ade-eng-node[data-node-id="N1"] .ade-eng-node-tokens'), 'Completed N1 caption renders its compact token count');
		const refreshedN1El = host.querySelector('.ade-eng-node[data-node-id="N1"]') as HTMLElement;

		// Inspect N1 Popover via right-click -> inputs & engine options must be disabled!
		refreshedN1El.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
		assert.strictEqual(popoverEl.classList.contains('open'), false, 'Hovering the completed node must not open the popover');
		refreshedN1El.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
		assert.strictEqual(popoverEl.classList.contains('open'), true, 'Right-clicking the completed node must open its popover');
		const lockedTitleInput = popoverEl.querySelector('input.ade-eng-input') as HTMLInputElement;
		assert.strictEqual(lockedTitleInput.disabled, true, 'Completed node configuration inputs must be strictly locked');
		const lockedEngineBtn = popoverEl.querySelector('button.ade-eng-engine-opt') as HTMLButtonElement;
		assert.strictEqual(lockedEngineBtn.disabled, true, 'Completed node engine options must be strictly locked');
		assert.ok(popoverEl.querySelector('.ade-eng-pop-tokens-card.has-usage'), 'Completed N1 popover renders the token consumption card with usage');
		assert.strictEqual(popoverEl.querySelectorAll('.ade-eng-pop-role-tok').length, 3, 'Token card renders Worker, Employee and Manager role breakdowns');

		// Clicking outside the popover on the canvas viewport must dismiss the open popover cleanly
		const viewportEl = host.querySelector('.ade-eng-viewport') as HTMLElement;
		viewportEl.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 20, bubbles: true }));
		viewportEl.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 20, clientY: 20, bubbles: true }));
		assert.strictEqual(popoverEl.classList.contains('open'), false, 'Clicking outside on the canvas must dismiss the open popover');

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
		nodeN2El.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
		assert.strictEqual(popoverEl.classList.contains('open'), false, 'Hovering the running node must not open the popover');
		nodeN2El.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
		assert.strictEqual(popoverEl.classList.contains('open'), true, 'Right-clicking the running node must open its popover');
		const n2TitleInput = popoverEl.querySelector('input.ade-eng-input') as HTMLInputElement;
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

	test('Unlocked role configuration via service & control commands, batch preset, draft edge deletion, blueprint sheet, verified report reset, and focus-preserving live token refresh', async () => {
		const host = append(mainWindow.document.body, $('div.monaco-workbench', { style: 'position:fixed;left:0;top:0;width:1200px;height:820px;' }));
		store.add({
			dispose: () => {
				host.remove();
			},
		});

		const h = createEngineeringHarness();
		await h.engineering.whenReady();
		const sessions = h.instantiation.get(IAdeSessionsService);
		const gov = await createGovernor(h.projects, sessions, 'Live Configuration Gov');
		await h.engineering.initTree({ governorSessionId: gov.id });

		const blueprintText = [
			'---',
			'version: 1',
			'treeType: engineering',
			'workspaceIsolation: shared',
			'---',
			'',
			'```mermaid',
			'graph LR',
			'  N1["Foundation Contracts"] --> N2["Service Layer"]',
			'  N2 --> N3["UI Polish"]',
			'```',
			'',
			'## Node: N1',
			'- Title: Foundation Contracts',
			'- Type: task',
			'- Critical: false',
			'- Employee: engine=claude-code, thinking=medium',
			'- Worker: engine=codex, thinking=high',
			'### Goal',
			'Define shared contracts.',
			'### Acceptance Criteria',
			'Contracts compile.',
			'',
			'## Node: N2',
			'- Title: Service Layer',
			'- Type: task',
			'- Critical: false',
			'- Employee: engine=claude-code, thinking=medium',
			'- Worker: engine=codex, thinking=high',
			'### Goal',
			'Implement the service layer.',
			'### Acceptance Criteria',
			'Service tests pass.',
			'',
			'## Node: N3',
			'- Title: UI Polish',
			'- Type: task',
			'- Critical: false',
			'- Employee: engine=claude-code, thinking=medium',
			'- Worker: engine=codex, thinking=high',
			'### Goal',
			'Polish the UI.',
			'### Acceptance Criteria',
			'UI renders cleanly.',
		].join('\n');
		await h.engineering.applyBlueprint({ governorSessionId: gov.id, blueprintText });

		const fakeGroup = new class extends mock<IEditorGroup>() {
			override readonly id = 1;
		}();
		const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, fakeGroup));
		pane.create(host);
		pane.layout({ width: 1200, height: 820, top: 0, left: 0 } as never);
		const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, gov.id));
		await pane.setInput(input, undefined, {}, CancellationToken.None);

		// 1. `engineering.configureTree` must patch every unlocked Worker, Employee and Manager segment config.
		const configured = await h.engineering.configureTree({
			governorSessionId: gov.id,
			engine: 'claude-code',
			model: 'deepseek-flash[1m]',
			thinking: 'off',
		});
		const taskNodes = configured.blueprint.nodes.filter(n => n.type === 'task');
		assert.strictEqual(taskNodes.length, 3);
		for (const node of taskNodes) {
			assert.deepStrictEqual(node.worker, { engine: 'claude-code', model: 'deepseek-flash[1m]', thinking: 'off' });
			assert.deepStrictEqual(node.employee, { engine: 'claude-code', model: 'deepseek-flash[1m]', thinking: 'off' });
		}
		assert.ok(configured.blueprint.managers.length > 0);
		for (const manager of configured.blueprint.managers) {
			assert.deepStrictEqual(manager.config, { engine: 'claude-code', model: 'deepseek-flash[1m]', thinking: 'off' });
		}

		// 2. Control CLI: blueprint validate / configure / reset work; session.connect & session.archive stay locked on Engineering subordinates.
		const validateRes = await h.commandService.executeCommand<{ valid: boolean; nodeCount: number; edgeCount: number }>(
			ADE_CONTROL_EXECUTE_COMMAND_ID,
			'engineering.blueprint.validate',
			{ text: blueprintText },
		);
		assert.ok(validateRes);
		assert.deepStrictEqual(
			{ valid: validateRes.valid, nodeCount: validateRes.nodeCount, edgeCount: validateRes.edgeCount },
			{ valid: true, nodeCount: 3, edgeCount: 2 },
		);

		const configureRes = await h.commandService.executeCommand<{
			nodes: readonly {
				id: string;
				worker?: { engine: string; model?: string; thinking: string };
				employee?: { engine: string; model?: string; thinking: string };
			}[];
		}>(ADE_CONTROL_EXECUTE_COMMAND_ID, 'engineering.configure', {
			governor: gov.id,
			all: true,
			engine: 'codex',
			model: 'gpt-5-codex',
			thinking: 'high',
		});
		assert.ok(configureRes);
		assert.strictEqual(configureRes.nodes.length, 3);
		for (const node of configureRes.nodes) {
			assert.deepStrictEqual(node.worker, { engine: 'codex', model: 'gpt-5-codex', thinking: 'high' });
			assert.deepStrictEqual(node.employee, { engine: 'codex', model: 'gpt-5-codex', thinking: 'high' });
		}

		const resetRes = await h.commandService.executeCommand<{ governorSessionId: string; runStatus: string }>(
			ADE_CONTROL_EXECUTE_COMMAND_ID,
			'engineering.reset',
			{ governor: gov.id, node: 'N3' },
		);
		assert.ok(resetRes);
		assert.deepStrictEqual(
			{ governorSessionId: resetRes.governorSessionId, runStatus: resetRes.runStatus },
			{ governorSessionId: gov.id, runStatus: 'idle' },
		);

		const managerAgent = h.projects.getDirectSubordinates(gov.id)[0];
		assert.ok(managerAgent, 'Engineering tree pre-creates a Manager subordinate');
		await assert.rejects(
			() => h.commandService.executeCommand(ADE_CONTROL_EXECUTE_COMMAND_ID, 'session.connect', { id: managerAgent.id, engine: 'codex', open: false }),
			/locked/i,
		);
		await assert.rejects(
			() => h.commandService.executeCommand(ADE_CONTROL_EXECUTE_COMMAND_ID, 'session.archive', { id: managerAgent.id }),
			/locked/i,
		);

		const popover = host.querySelector('.ade-eng-popover') as HTMLElement;
		assert.ok(popover, 'Engineering pane renders the floating option popover');

		// 3a. Clicking `.ade-eng-batch-apply-btn` applies Engine + Model + Thinking across every unlocked role.
		const nodeN2El = host.querySelector('.ade-eng-node[data-node-id="N2"]') as HTMLElement;
		assert.ok(nodeN2El);
		nodeN2El.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
		assert.strictEqual(popover.classList.contains('open'), true);

		const kiloBtn = Array.from(popover.querySelectorAll<HTMLButtonElement>('button.ade-eng-engine-opt')).find(b => b.title === 'Kilo Code');
		assert.ok(kiloBtn, 'Kilo Code engine option rendered for unlocked node');
		kiloBtn.click();

		const maxBtn = Array.from(popover.querySelectorAll<HTMLButtonElement>('button.ade-eng-think-opt')).find(b => b.textContent === 'Max');
		assert.ok(maxBtn, 'Max thinking option rendered for unlocked node');
		maxBtn.click();

		const modelInput = popover.querySelector('input.ade-eng-pop-model-input') as HTMLInputElement;
		assert.ok(modelInput);
		modelInput.value = 'deepseek-flash[1m]';
		modelInput.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));

		const batchBtn = popover.querySelector('button.ade-eng-batch-apply-btn') as HTMLButtonElement;
		assert.ok(batchBtn, 'Batch preset button rendered');
		batchBtn.click();
		assert.ok(host.querySelector('.ade-eng-draft-badge'), 'Batch preset enters Draft Unsaved mode');

		const batchConfirmBtn = host.querySelector('.ade-eng-toolbar .ade-eng-action-btn.confirm') as HTMLButtonElement;
		assert.ok(batchConfirmBtn);
		batchConfirmBtn.click();
		await waitForDomCondition(() => !host.querySelector('.ade-eng-draft-badge'));

		const batchSnap = h.engineering.getTreeSnapshot(gov.id)!;
		for (const id of ['N1', 'N2', 'N3']) {
			const node = batchSnap.blueprint.nodes.find(n => n.id === id)!;
			assert.deepStrictEqual(node.worker, { engine: 'kilo', model: 'deepseek-flash[1m]', thinking: 'max' });
			assert.deepStrictEqual(node.employee, { engine: 'kilo', model: 'deepseek-flash[1m]', thinking: 'max' });
		}
		for (const manager of batchSnap.blueprint.managers) {
			assert.deepStrictEqual(manager.config, { engine: 'kilo', model: 'deepseek-flash[1m]', thinking: 'max' });
		}

		// 3b. Clicking `.ade-eng-edge-del-btn` removes an unlocked edge while in draft mode.
		const edgeGroup = host.querySelector('.ade-eng-edge-item[data-edge="N2->N3"]') as SVGGElement | null;
		assert.ok(edgeGroup, 'Unlocked edge renders a delete affordance');
		const edgeDelBtn = edgeGroup.querySelector('.ade-eng-edge-del-btn') as SVGGElement;
		assert.ok(edgeDelBtn);
		edgeDelBtn.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true, cancelable: true }));
		assert.strictEqual(host.querySelector('.ade-eng-edge-item[data-edge="N2->N3"]'), null, 'Clicking × removes the unlocked draft edge');
		assert.ok(host.querySelector('.ade-eng-draft-badge'), 'Edge removal enters Draft Unsaved mode');

		const edgeConfirmBtn = host.querySelector('.ade-eng-toolbar .ade-eng-action-btn.confirm') as HTMLButtonElement;
		assert.ok(edgeConfirmBtn);
		edgeConfirmBtn.click();
		await waitForDomCondition(() => !host.querySelector('.ade-eng-draft-badge'));
		assert.ok(
			!h.engineering.getTreeSnapshot(gov.id)!.blueprint.edges.some(e => e.from === 'N2' && e.to === 'N3'),
			'Confirmed draft persists the removed edge',
		);

		// 3c. Toggling `.ade-eng-sheet-toggle` opens `.ade-eng-sheet.open` with the Blueprint Markdown editor.
		const sheetToggle = host.querySelector('.ade-eng-sheet-toggle') as HTMLButtonElement;
		assert.ok(sheetToggle);
		sheetToggle.click();
		const sheet = host.querySelector('.ade-eng-sheet') as HTMLElement;
		assert.ok(sheet.classList.contains('open'), 'Blueprint sheet toggles open');
		assert.ok(sheet.querySelector('textarea.ade-eng-blueprint-editor'), 'Open sheet renders the Blueprint Markdown editor');
		const sheetToggleAgain = host.querySelector('.ade-eng-sheet-toggle') as HTMLButtonElement;
		sheetToggleAgain.click();
		assert.strictEqual((host.querySelector('.ade-eng-sheet') as HTMLElement).classList.contains('open'), false, 'Toggling again closes the sheet');

		// 3d. Live token updates must refresh telemetry in place without stealing focus or losing an uncommitted input value.
		const n3WorkerAgentId = h.engineering.getTreeSnapshot(gov.id)!.state.nodes.N3.workerAgentId;
		assert.ok(n3WorkerAgentId, 'Unlocked N3 exposes its Worker agent id');
		const nodeN3El = host.querySelector('.ade-eng-node[data-node-id="N3"]') as HTMLElement;
		assert.ok(nodeN3El);
		nodeN3El.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
		assert.strictEqual(popover.classList.contains('open'), true);

		const titleInput = popover.querySelector('input.ade-eng-pop-title-input') as HTMLInputElement;
		assert.ok(titleInput && !titleInput.disabled);
		titleInput.focus();
		titleInput.value = 'Uncommitted N3 Title';
		assert.strictEqual(mainWindow.document.activeElement, titleInput, 'Popover input holds real DOM focus before the usage event');

		await h.commandService.executeCommand(ADE_RECORD_TURN_USAGE_COMMAND_ID, {
			agentId: n3WorkerAgentId,
			usage: { inputTokens: 3000, outputTokens: 1321, cacheReadTokens: 0, totalTokens: 4321 },
		});
		await waitForDomCondition(() => Boolean(popover.querySelector('.ade-eng-pop-tokens-card.has-usage')));
		assert.strictEqual(mainWindow.document.activeElement, titleInput, 'Live token refresh MUST NOT steal focus from the popover input');
		assert.strictEqual(titleInput.value, 'Uncommitted N3 Title', 'Live token refresh MUST preserve the uncommitted input value');
		assert.strictEqual(popover.classList.contains('open'), true, 'Popover stays open across live token refresh');
		assert.ok(
			popover.querySelector('.ade-eng-pop-tokens-total')?.textContent?.includes('4,321'),
			'Live token refresh updates the open popover token card in place',
		);

		popover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.strictEqual(popover.classList.contains('open'), false);

		// 3e. Run N1 to completion, then verify the Report tab, diff/reports commands and node-level reset.
		await h.engineering.runTree(gov.id, 'user');
		await waitForNodePhase(h.engineering, gov.id, 'N1', 'employee_review');
		await h.engineering.submitReview({
			governorSessionId: gov.id,
			nodeId: 'N1',
			role: 'employee',
			verdict: 'pass',
			report: 'Verified report for N1',
		});
		assert.strictEqual(h.engineering.getTreeSnapshot(gov.id)?.state.nodes.N1.completed, true);

		const diffRes = await h.commandService.executeCommand<{
			nodeId: string;
			touchedFiles: readonly { relativePath: string; kind: string }[];
			combinedDiff: string;
		}>(ADE_CONTROL_EXECUTE_COMMAND_ID, 'engineering.diff', { governor: gov.id, node: 'N1' });
		assert.ok(diffRes);
		assert.strictEqual(diffRes.nodeId, 'N1');
		assert.deepStrictEqual(diffRes.touchedFiles.map(f => f.relativePath), ['src/auth.ts']);
		assert.ok(diffRes.combinedDiff.includes('src/auth.ts'), 'Diff command returns the captured Worker diff');

		const reportsRes = await h.commandService.executeCommand<{
			reports: readonly { nodeId: string; summary: string }[];
		}>(ADE_CONTROL_EXECUTE_COMMAND_ID, 'engineering.reports', { governor: gov.id });
		assert.ok(reportsRes);
		assert.deepStrictEqual(reportsRes.reports.map(r => r.nodeId), ['N1']);
		assert.strictEqual(reportsRes.reports[0].summary, 'Verified report for N1');

		await waitForDomCondition(() => Boolean(host.querySelector('.ade-eng-node[data-node-id="N1"]')?.classList.contains('status-completed')));
		const nodeN1El = host.querySelector('.ade-eng-node[data-node-id="N1"]') as HTMLElement;
		nodeN1El.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
		assert.strictEqual(popover.classList.contains('open'), true);
		const reportTabBtn = Array.from(popover.querySelectorAll<HTMLButtonElement>('button.ade-eng-pop-role-tab')).find(b => b.textContent?.includes('Report'));
		assert.ok(reportTabBtn, 'Completed node popover exposes the Report tab');
		reportTabBtn.click();
		assert.ok(
			popover.querySelector('.ade-eng-report-card')?.textContent?.includes('Verified report for N1'),
			'Report tab renders the verified report',
		);
		const touchedFilePaths = Array.from(popover.querySelectorAll('.ade-eng-file-pill .ade-eng-file-path')).map(el => el.textContent);
		assert.deepStrictEqual(touchedFilePaths, ['src/auth.ts'], 'Report tab renders the touched files list');
		const resetNodeBtn = popover.querySelector('.ade-eng-pop-reset-node-btn') as HTMLButtonElement | null;
		assert.ok(resetNodeBtn && resetNodeBtn.textContent === '↺ Reset Node', 'Report tab renders the ↺ Reset Node action');

		pane.clearInput();
	});

	test('Nested Dual-Shell architecture (Employee outer shell physically enclosing Worker inner core), quick-spawn +, Undo/Redo, Minimap, Token Analytics & inline Gate Approve', async () => {
		const host = append(mainWindow.document.body, $('div.monaco-workbench', { style: 'position:fixed;left:0;top:0;width:1180px;height:760px;' }));
		store.add({
			dispose: () => {
				host.remove();
			},
		});

		const h = createEngineeringHarness();
		await h.engineering.whenReady();
		const sessions = h.instantiation.get(IAdeSessionsService);
		const gov = await createGovernor(h.projects, sessions, 'Dual-Shell UX Gov');
		await h.engineering.initTree({ governorSessionId: gov.id });

		const bpText = [
			'---',
			'version: 1',
			'treeType: engineering',
			'workspaceIsolation: shared',
			'---',
			'',
			'```mermaid',
			'graph LR',
			'  N1["Core Engine"] --> U1{{"Checkpoint"}}',
			'  U1 --> N2["UI Polish"]',
			'```',
			'',
			'## Node: N1',
			'- Title: Core Engine',
			'- Type: task',
			'- Critical: false',
			'- Employee: engine=claude-code, thinking=high',
			'- Worker: engine=codex, thinking=high',
			'### Goal',
			'Build core engine.',
			'### Acceptance Criteria',
			'Engine compiles.',
			'',
			'## Node: U1',
			'- Title: Checkpoint',
			'- Type: user_gate',
			'### Description',
			'Verify core engine.',
			'',
			'## Node: N2',
			'- Title: UI Polish',
			'- Type: task',
			'- Critical: false',
			'- Employee: engine=claude-code, thinking=medium',
			'- Worker: engine=codex, thinking=high',
			'### Goal',
			'Polish UI.',
			'### Acceptance Criteria',
			'UI renders.',
		].join('\n');
		await h.engineering.applyBlueprint({ governorSessionId: gov.id, blueprintText: bpText });

		const fakeGroup = new class extends mock<IEditorGroup>() {
			override readonly id = 1;
		}();
		const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, fakeGroup));
		pane.create(host);
		pane.layout({ width: 1180, height: 760, top: 0, left: 0 } as never);
		const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, gov.id));
		await pane.setInput(input, undefined, {}, CancellationToken.None);

		// 1. Verify Outer Employee Shell physically encloses Inner Worker Core on all 4 sides with explicit role tags
		const nodeN1El = host.querySelector('.ade-eng-node[data-node-id="N1"]') as HTMLElement;
		assert.ok(nodeN1El);
		const outerShell = nodeN1El.querySelector('.ade-eng-concentric') as HTMLElement;
		const empHeader = outerShell.querySelector('.ade-eng-emp-satellite') as HTMLElement;
		const innerWorkerCore = outerShell.querySelector('.ade-eng-inner-core') as HTMLElement;
		assert.ok(outerShell && empHeader && innerWorkerCore, 'Task pod renders outer Employee shell header and nested inner Worker core');
		assert.ok(empHeader.querySelector('.ade-eng-role-tag.emp')?.textContent?.includes('EMPLOYEE'), 'Outer Employee shell displays explicit EMPLOYEE · L3 role tag');
		assert.ok(innerWorkerCore.querySelector('.ade-eng-role-tag.wrk')?.textContent?.includes('WORKER'), 'Inner Worker core displays explicit WORKER · L4 role tag');
		assert.ok(host.querySelector('.ade-eng-segment-header .ade-eng-role-tag.mgr'), 'Manager lane header displays explicit MGR · L2 role tag');

		const outerRect = outerShell.getBoundingClientRect();
		const innerRect = innerWorkerCore.getBoundingClientRect();
		assert.ok(
			outerRect.top < innerRect.top
			&& outerRect.left < innerRect.left
			&& outerRect.bottom > innerRect.bottom
			&& outerRect.right > innerRect.right,
			'Outer Employee shell strictly encloses Inner Worker core on top, left, right, and bottom',
		);

		// 2. Verify Interactive Minimap & 4-Tier Token Analytics Popover
		const minimapEl = host.querySelector('.ade-eng-minimap') as HTMLElement;
		assert.ok(minimapEl && !minimapEl.hidden, 'Live DAG minimap rendered');
		const worldEl = host.querySelector('.ade-eng-world') as HTMLElement;
		const prevTransform = worldEl.style.transform;
		const mmRect = minimapEl.getBoundingClientRect();
		minimapEl.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: mmRect.left + 120, clientY: mmRect.top + 80, bubbles: true }));
		minimapEl.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: mmRect.left + 120, clientY: mmRect.top + 80, bubbles: true }));
		assert.notStrictEqual(worldEl.style.transform, prevTransform, 'Clicking minimap navigates the canvas world');

		const tokensPill = host.querySelector('.ade-eng-tokens-pill') as HTMLElement;
		const analyticsCard = host.querySelector('.ade-eng-token-analytics-card') as HTMLElement;
		assert.strictEqual(analyticsCard.hidden, true);
		tokensPill.click();
		assert.strictEqual(analyticsCard.hidden, false, 'Clicking toolbar token pill opens 4-tier Token Analytics card');
		tokensPill.click();
		assert.strictEqual(analyticsCard.hidden, true, 'Clicking again closes Token Analytics card');

		// 3. Verify explicit gear button opens popover while hover NEVER auto-opens it
		const popoverEl = host.querySelector('.ade-eng-popover') as HTMLElement;
		const gearBtn = nodeN1El.querySelector('.ade-eng-node-cfg-btn') as HTMLButtonElement;
		assert.ok(gearBtn, 'Explicit gear button rendered inside node');
		gearBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
		assert.strictEqual(popoverEl.classList.contains('open'), false, 'Hovering gear button never auto-opens popover');
		gearBtn.click();
		assert.strictEqual(popoverEl.classList.contains('open'), true, 'Clicking gear button opens popover');
		popoverEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.strictEqual(popoverEl.classList.contains('open'), false);

		// 4. Verify 1-Click Quick-Spawn `+` creates connected downstream task + Undo/Redo restores cleanly
		const quickSpawnBtn = host.querySelector('.ade-eng-node[data-node-id="N2"] .ade-eng-quick-spawn-btn') as HTMLButtonElement;
		assert.ok(quickSpawnBtn, 'Quick-spawn + button rendered');
		quickSpawnBtn.click();
		assert.strictEqual(host.querySelectorAll('.ade-eng-node').length, 4, 'Quick-spawn appends a 4th node');
		assert.ok(host.querySelector('.ade-eng-edge-item[data-edge="N2->N4"]'), 'Quick-spawn auto-wires N2 -> N4');

		const undoBtn = host.querySelector('.ade-eng-undo-btn') as HTMLButtonElement;
		assert.strictEqual(undoBtn.disabled, false);
		undoBtn.click();
		assert.strictEqual(host.querySelectorAll('.ade-eng-node').length, 3, 'Undo removes quick-spawned node');
		assert.strictEqual(host.querySelector('.ade-eng-draft-badge'), null, 'Undo to initial state clears Draft badge');
		const redoBtn = host.querySelector('.ade-eng-redo-btn') as HTMLButtonElement;
		assert.strictEqual(redoBtn.disabled, false);
		redoBtn.click();
		assert.strictEqual(host.querySelectorAll('.ade-eng-node').length, 4, 'Redo restores quick-spawned node');
		const cancelBtn = Array.from(host.querySelectorAll<HTMLButtonElement>('.ade-eng-action-btn')).find(b => b.textContent === 'Cancel')!;
		cancelBtn.click();

		// 5. Verify Inline 1-Click `✓ Approve` button directly on User Gate card when awaiting approval
		await h.engineering.runTree(gov.id, 'user');
		await waitForNodePhase(h.engineering, gov.id, 'N1', 'employee_review');
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'N1', role: 'employee', verdict: 'pass', report: 'N1 verified' });
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'N1', role: 'manager', verdict: 'pass' });
		await waitForDomCondition(() => Boolean(host.querySelector('.ade-eng-node[data-node-id="U1"] .ade-eng-gate-inline-approve')));

		const heldN2 = h.holdNextWorkerTurn();
		const inlineApproveBtn = host.querySelector('.ade-eng-node[data-node-id="U1"] .ade-eng-gate-inline-approve') as HTMLButtonElement;
		assert.ok(inlineApproveBtn, 'Awaiting User Gate renders inline 1-click ✓ Approve button');
		inlineApproveBtn.click();
		await heldN2.started.p;
		assert.strictEqual(h.engineering.getTreeSnapshot(gov.id)?.state.nodes.N2?.phase, 'worker_running', 'Inline Gate Approve advances downstream task N2 immediately');
		heldN2.reply.complete('done');

		pane.clearInput();
	});

	test('Wave 1: Mode theming (.mode-engineering vs .mode-research), dynamic world expansion, parallax grid vars, 268x172 armored pods with 4 clamps, ±0.5px port alignment, phase-manager ribbon, 3-pip failure ladder & over-SLA timer', async () => {
		const host = append(mainWindow.document.body, $('div.monaco-workbench', { style: 'position:fixed;left:0;top:0;width:1220px;height:780px;' }));
		store.add({ dispose: () => host.remove() });

		// 1. Dynamic world bounds helper expands beyond 4800×3600 for large graphs
		assert.deepStrictEqual(computeEngineeringWorldSize([{ position: { x: 240, y: 300 } }]), { width: 4800, height: 3600 });
		const expandedWorld = computeEngineeringWorldSize([{ position: { x: 5250, y: 3900 } }]);
		assert.ok(expandedWorld.width >= 5800 && expandedWorld.height >= 4500, 'World bounds expand past 4800×3600 for far nodes');

		const h = createEngineeringHarness();
		await h.engineering.whenReady();
		const sessions = h.instantiation.get(IAdeSessionsService);
		const engGov = await createGovernor(h.projects, sessions, 'Armored Eng Gov');
		await h.engineering.initTree({ governorSessionId: engGov.id, treeType: 'engineering' });

		const critBp = [
			'---',
			'version: 1',
			'treeType: engineering',
			'workspaceIsolation: shared',
			'---',
			'',
			'```mermaid',
			'graph LR',
			'  N1["Critical Core Pod"] --> U1{{"Gate Shield"}}',
			'  U1 --> N2["Far Horizon Pod"]',
			'```',
			'',
			'## Node: N1',
			'- Title: Critical Core Pod',
			'- Type: task',
			'- Critical: true',
			'- Position: 240, 300',
			'- Employee: engine=claude-code, thinking=high',
			'- Worker: engine=codex, thinking=high',
			'### Goal',
			'Build critical core.',
			'### Acceptance Criteria',
			'Passes audit.',
			'',
			'## Node: U1',
			'- Title: Gate Shield',
			'- Type: user_gate',
			'- Position: 660, 300',
			'### Description',
			'Human gate.',
			'',
			'## Node: N2',
			'- Title: Far Horizon Pod',
			'- Type: task',
			'- Critical: false',
			'- Position: 5200, 3900',
			'- Employee: engine=claude-code, thinking=medium',
			'- Worker: engine=codex, thinking=high',
			'### Goal',
			'Test world expansion.',
			'### Acceptance Criteria',
			'Renders cleanly.',
		].join('\n');
		await h.engineering.applyBlueprint({ governorSessionId: engGov.id, blueprintText: critBp });

		const fakeGroup = new class extends mock<IEditorGroup>() {
			override readonly id = 1;
		}();
		const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, fakeGroup));
		pane.create(host);
		pane.layout({ width: 1220, height: 780, top: 0, left: 0 } as never);

		const engInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, engGov.id));
		await pane.setInput(engInput, undefined, {}, CancellationToken.None);

		const editorEl = host.querySelector('.ade-eng-editor') as HTMLElement;
		assert.ok(editorEl.classList.contains('mode-engineering') && !editorEl.classList.contains('mode-research'), 'Engineering governor sets .mode-engineering on root');

		const viewportEl = host.querySelector('.ade-eng-viewport') as HTMLElement;
		assert.ok(viewportEl.style.getPropertyValue('--grid-x').endsWith('px'), 'Viewport sets --grid-x parallax var');
		assert.ok(viewportEl.style.getPropertyValue('--grid-y').endsWith('px'), 'Viewport sets --grid-y parallax var');
		assert.ok(Number(viewportEl.style.getPropertyValue('--grid-scale')) > 0, 'Viewport sets --grid-scale parallax var');

		const worldEl = host.querySelector('.ade-eng-world') as HTMLElement;
		const edgesSvg = host.querySelector('svg.ade-eng-edges-svg') as SVGSVGElement;
		assert.ok(parseInt(worldEl.style.width, 10) > 4800 && parseInt(worldEl.style.height, 10) > 3600, 'World div expands beyond 4800×3600 for large graphs');
		assert.strictEqual(edgesSvg.getAttribute('width'), String(parseInt(worldEl.style.width, 10)), 'Edges SVG width matches expanded world');

		// 2. Symmetric 268×172 armored dual-shell pod + 4 L-clamps + ±0.5px port-out center alignment + segment progress strip
		const n1El = host.querySelector('.ade-eng-node[data-node-id="N1"]') as HTMLElement;
		const conc = n1El.querySelector('.ade-eng-concentric') as HTMLElement;
		const core = conc.querySelector('.ade-eng-inner-core') as HTMLElement;
		const portOut = n1El.querySelector('.ade-eng-port.port-out') as HTMLElement;
		const concStyle = mainWindow.getComputedStyle(conc);
		assert.strictEqual(concStyle.width, '268px', 'Task pod width is 268px');
		assert.strictEqual(concStyle.height, '172px', 'Task pod height is 172px');
		assert.strictEqual(conc.querySelectorAll('.ade-eng-shell-clamp').length, 4, 'Task pod renders 4 L-corner clamps');
		for (const c of ['tl', 'tr', 'bl', 'br']) {
			assert.ok(conc.querySelector(`.ade-eng-shell-clamp.${c}`), `Clamp .${c} rendered`);
		}
		const concRect = conc.getBoundingClientRect();
		const coreRect = core.getBoundingClientRect();
		const portRect = portOut.getBoundingClientRect();
		assert.ok(
			concRect.top < coreRect.top && concRect.left < coreRect.left && concRect.right > coreRect.right && concRect.bottom > coreRect.bottom,
			'Armored Employee shell encloses sunken Worker core on all 4 sides',
		);
		assert.ok(
			Math.abs((concRect.top + concRect.height / 2) - (portRect.top + portRect.height / 2)) <= 0.5,
			'port-out vertical center aligns with 268×172 concentric center within ±0.5px',
		);
		assert.strictEqual(host.querySelectorAll('.ade-eng-segment-halo').length, 2);
		assert.strictEqual(host.querySelectorAll('.ade-eng-segment-halo .ade-eng-segment-progress').length, 2, 'Each MGR lane renders a segment progress strip');

		// 3. Phase progression: phase-worker -> phase-employee -> phase-manager ("MGR REVIEW") -> 3-pip failure ladder + "CIRCUIT BROKEN"
		const heldWrk1 = h.holdNextWorkerTurn();
		await h.engineering.runTree(engGov.id, 'user');
		await heldWrk1.started.p;
		await waitForDomCondition(() => Boolean(host.querySelector('.ade-eng-node[data-node-id="N1"].phase-worker')));
		const wrkPill = host.querySelector('.ade-eng-node[data-node-id="N1"] .ade-eng-live-phase-pill') as HTMLElement;
		assert.strictEqual(wrkPill.getAttribute('data-phase-role'), 'wrk', 'Live timer pill tags Worker role');

		// Advance simulated clock past soft SLA on a reload to verify .over-sla escalation
		const liveRec = h.engineering.getTreeSnapshot(engGov.id)!;
		assert.ok(liveRec.state.nodes.N1.startedAt);
		assert.strictEqual(wrkPill.classList.contains('over-sla'), false, 'Fresh active phase pill starts below SLA');
		const realNow = Date.now;
		try {
			Date.now = () => (liveRec.state.nodes.N1.startedAt ?? realNow()) + ADE_ENG_PHASE_SOFT_SLA_MS + 5_000;
			await pane.setInput(engInput, undefined, {}, CancellationToken.None);
			assert.ok(
				host.querySelector('.ade-eng-node[data-node-id="N1"] .ade-eng-live-phase-pill')?.classList.contains('over-sla'),
				'Live timer pill escalates to .over-sla once elapsed exceeds soft SLA',
			);
		} finally {
			Date.now = realNow;
		}

		heldWrk1.reply.complete('attempt 1');
		await waitForNodePhase(h.engineering, engGov.id, 'N1', 'employee_review');
		await waitForDomCondition(() => Boolean(host.querySelector('.ade-eng-node[data-node-id="N1"].phase-employee')));
		assert.strictEqual(
			host.querySelector('.ade-eng-node[data-node-id="N1"] .ade-eng-live-phase-pill')?.getAttribute('data-phase-role'),
			'emp',
			'Live timer pill tags Employee role during audit',
		);
		assert.ok(
			host.querySelector('.ade-eng-node[data-node-id="N1"] .ade-eng-handoff-chip')?.textContent?.includes('Auditing'),
			'Employee phase renders ↑ Auditing handoff chip',
		);

		// Employee pass on critical node N1 -> enters manager_review (.phase-manager + MGR REVIEW ribbon!)
		await h.engineering.submitReview({ governorSessionId: engGov.id, nodeId: 'N1', role: 'employee', verdict: 'pass', report: 'Attempt 1' });
		await waitForDomCondition(() => Boolean(host.querySelector('.ade-eng-node[data-node-id="N1"].phase-manager')));
		const mgrRibbon = host.querySelector('.ade-eng-node[data-node-id="N1"] .ade-eng-phase-ribbon.mgr-review') as HTMLElement | null;
		assert.ok(mgrRibbon && mgrRibbon.textContent === 'MGR REVIEW', 'Manager review phase renders MGR REVIEW ribbon');
		assert.strictEqual(
			host.querySelector('.ade-eng-node[data-node-id="N1"] .ade-eng-live-phase-pill')?.getAttribute('data-phase-role'),
			'mgr',
		);

		// Formal Failure 1 -> data-fail="1", 1/3 lit pip
		await h.engineering.submitReview({ governorSessionId: engGov.id, nodeId: 'N1', role: 'manager', verdict: 'reject', feedback: 'F1' });
		await waitForNodePhase(h.engineering, engGov.id, 'N1', 'employee_review');
		await waitForDomCondition(() => host.querySelector('.ade-eng-node[data-node-id="N1"]')?.getAttribute('data-fail') === '1');
		assert.strictEqual(host.querySelectorAll('.ade-eng-node[data-node-id="N1"] .ade-eng-fail-pips i.lit').length, 1, 'Failure 1 lights 1 of 3 pips');

		// Formal Failure 2 -> data-fail="2", 2/3 lit pips
		await h.engineering.submitReview({ governorSessionId: engGov.id, nodeId: 'N1', role: 'employee', verdict: 'pass', report: 'Attempt 2' });
		await h.engineering.submitReview({ governorSessionId: engGov.id, nodeId: 'N1', role: 'manager', verdict: 'reject', feedback: 'F2' });
		await waitForNodePhase(h.engineering, engGov.id, 'N1', 'employee_review');
		await waitForDomCondition(() => host.querySelector('.ade-eng-node[data-node-id="N1"]')?.getAttribute('data-fail') === '2');
		assert.strictEqual(host.querySelectorAll('.ade-eng-node[data-node-id="N1"] .ade-eng-fail-pips i.lit').length, 2, 'Failure 2 lights 2 of 3 pips');

		// Formal Failure 3 -> data-fail="3", 3/3 lit pips + CIRCUIT BROKEN ribbon
		await h.engineering.submitReview({ governorSessionId: engGov.id, nodeId: 'N1', role: 'employee', verdict: 'pass', report: 'Attempt 3' });
		await h.engineering.submitReview({ governorSessionId: engGov.id, nodeId: 'N1', role: 'manager', verdict: 'reject', feedback: 'F3' });
		await waitForDomCondition(() => host.querySelector('.ade-eng-node[data-node-id="N1"]')?.getAttribute('data-fail') === '3');
		assert.strictEqual(host.querySelectorAll('.ade-eng-node[data-node-id="N1"] .ade-eng-fail-pips i.lit').length, 3, 'Failure 3 lights all 3 pips');
		const cbRibbon = host.querySelector('.ade-eng-node[data-node-id="N1"] .ade-eng-phase-ribbon.circuit-broken') as HTMLElement | null;
		assert.ok(cbRibbon && cbRibbon.textContent === 'CIRCUIT BROKEN', 'Failure 3 renders CIRCUIT BROKEN ribbon');

		// 4. Switch pane input to a Research governor -> root switches to .mode-research
		const resGov = await createGovernor(h.projects, sessions, 'Research Lead Gov');
		await h.engineering.initTree({ governorSessionId: resGov.id, treeType: 'research' });
		const resInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, resGov.id));
		await pane.setInput(resInput, undefined, {}, CancellationToken.None);
		assert.ok(editorEl.classList.contains('mode-research') && !editorEl.classList.contains('mode-engineering'), 'Research governor switches root to .mode-research');

		pane.clearInput();
	});

	test('Wave 2: Capped SMIL edge particles, hover quick-spawn ghost (+ Alt gate morph) preserving T1 node count, floating 3-island toolbar, minimap legend + dblclick fit, HUD ? shortcuts, G/N hotkeys & focused-button Backspace guard', async () => {
		const host = append(mainWindow.document.body, $('div.monaco-workbench', { style: 'position:fixed;left:0;top:0;width:1200px;height:780px;' }));
		store.add({ dispose: () => host.remove() });

		const h = createEngineeringHarness();
		await h.engineering.whenReady();
		const sessions = h.instantiation.get(IAdeSessionsService);
		const gov = await createGovernor(h.projects, sessions, 'Living Canvas Gov');
		await h.engineering.initTree({ governorSessionId: gov.id });

		const bpText = [
			'---',
			'version: 1',
			'treeType: engineering',
			'workspaceIsolation: shared',
			'---',
			'',
			'```mermaid',
			'graph LR',
			'  N1["Seed Task"] --> U1{{"Checkpoint"}}',
			'  U1 --> N2["Downstream Task"]',
			'```',
			'',
			'## Node: N1',
			'- Title: Seed Task',
			'- Type: task',
			'- Critical: false',
			'- Employee: engine=claude-code, thinking=medium',
			'- Worker: engine=codex, thinking=high',
			'### Goal',
			'Seed.',
			'### Acceptance Criteria',
			'Seed passes.',
			'',
			'## Node: U1',
			'- Title: Checkpoint',
			'- Type: user_gate',
			'### Description',
			'Inspect seed.',
			'',
			'## Node: N2',
			'- Title: Downstream Task',
			'- Type: task',
			'- Critical: false',
			'- Employee: engine=claude-code, thinking=medium',
			'- Worker: engine=codex, thinking=high',
			'### Goal',
			'Downstream.',
			'### Acceptance Criteria',
			'Downstream passes.',
		].join('\n');
		await h.engineering.applyBlueprint({ governorSessionId: gov.id, blueprintText: bpText });

		const fakeGroup = new class extends mock<IEditorGroup>() {
			override readonly id = 1;
		}();
		const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, fakeGroup));
		pane.create(host);
		pane.layout({ width: 1200, height: 780, top: 0, left: 0 } as never);
		const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, gov.id));
		await pane.setInput(input, undefined, {}, CancellationToken.None);

		const rootEl = host.querySelector('.ade-eng-editor') as HTMLElement;
		const toolbarEl = host.querySelector('.ade-eng-toolbar') as HTMLElement;
		assert.strictEqual(rootEl.firstElementChild, toolbarEl, 'Floating toolbar remains rootEl.firstElementChild (T14)');
		assert.strictEqual(toolbarEl.querySelectorAll('.ade-eng-toolbar-group.island').length, 3, 'Toolbar renders 3 glassmorphic islands');

		// 1. Hovering quick-spawn + reveals .ade-eng-spawn-ghost + .ade-eng-spawn-ghost-edge WITHOUT changing .ade-eng-node count (T1); Alt morphs to gate
		const n2SpawnBtn = host.querySelector('.ade-eng-node[data-node-id="N2"] .ade-eng-quick-spawn-btn') as HTMLButtonElement;
		const ghostEl = host.querySelector('.ade-eng-spawn-ghost') as HTMLElement;
		const ghostEdgeEl = host.querySelector('.ade-eng-spawn-ghost-edge') as SVGPathElement;
		assert.strictEqual(ghostEl.hidden, true);
		n2SpawnBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, altKey: false }));
		assert.strictEqual(ghostEl.hidden, false, 'Hovering + reveals spawn ghost');
		assert.ok(ghostEl.classList.contains('type-task'), 'Default ghost previews a Task pod');
		assert.notStrictEqual(ghostEdgeEl.style.display, 'none', 'Ghost wiring spline is visible on + hover');
		assert.strictEqual(host.querySelectorAll('.ade-eng-node').length, 3, 'Spawn ghost NEVER carries .ade-eng-node (T1)');

		const snapBp = h.engineering.getTreeSnapshot(gov.id)!.blueprint;
		assert.ok(computeQuickSpawnPosition({
			...snapBp,
			nodes: snapBp.nodes.map(n => ({ ...n, position: n.position ?? { x: 204, y: 260 } })),
		}, 'N2'));

		n2SpawnBtn.dispatchEvent(new MouseEvent('mousemove', { bubbles: false, altKey: true }));
		assert.ok(ghostEl.classList.contains('type-user_gate'), 'Holding Alt morphs spawn ghost into a User Gate preview');
		n2SpawnBtn.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
		assert.strictEqual(ghostEl.hidden, true, 'Leaving + hides spawn ghost');

		// 2. Minimap legend + double-click to fit + HUD ? shortcuts card
		assert.strictEqual(host.querySelectorAll('.ade-eng-minimap-legend-item').length, 3, 'Minimap renders 3-item status legend');
		const minimapEl = host.querySelector('.ade-eng-minimap') as HTMLElement;
		const worldEl = host.querySelector('.ade-eng-world') as HTMLElement;
		const mmRect = minimapEl.getBoundingClientRect();
		minimapEl.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: mmRect.left + 150, clientY: mmRect.top + 95, bubbles: true }));
		minimapEl.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: mmRect.left + 150, clientY: mmRect.top + 95, bubbles: true }));
		const pannedTransform = worldEl.style.transform;
		host.classList.add('monaco-reduce-motion');
		minimapEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		assert.notStrictEqual(worldEl.style.transform, pannedTransform, 'Double-clicking minimap fits graph in viewport');
		host.classList.remove('monaco-reduce-motion');

		const shortcutsBtn = host.querySelector('.ade-eng-shortcuts-toggle') as HTMLButtonElement;
		const shortcutsCard = host.querySelector('.ade-eng-shortcuts-card') as HTMLElement;
		assert.strictEqual(shortcutsCard.hidden, true);
		shortcutsBtn.click();
		assert.strictEqual(shortcutsCard.hidden, false, 'Clicking HUD ? button opens shortcuts card');
		rootEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.strictEqual(shortcutsCard.hidden, true, 'Escape closes shortcuts card');

		// 3. Focused button Backspace guard + N quick-spawn hotkey
		const nodeN2El = host.querySelector('.ade-eng-node[data-node-id="N2"]') as HTMLElement;
		nodeN2El.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
		const popoverEl = host.querySelector('.ade-eng-popover') as HTMLElement;
		assert.strictEqual(popoverEl.classList.contains('open'), true);
		const critBtn = popoverEl.querySelector('button.ade-eng-pop-icon-btn.crit') as HTMLButtonElement;
		critBtn.focus();
		critBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
		assert.strictEqual(host.querySelectorAll('.ade-eng-node').length, 3, 'Backspace while a button holds focus MUST NOT delete the inspected node');

		rootEl.focus();
		rootEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
		assert.strictEqual(host.querySelectorAll('.ade-eng-node').length, 4, 'N hotkey spawns a connected task from inspected node');
		assert.ok(host.querySelector('.ade-eng-edge-item[data-edge="N2->N4"]'));
		(Array.from(host.querySelectorAll<HTMLButtonElement>('.ade-eng-action-btn')).find(b => b.textContent === 'Cancel'))!.click();

		// 4. Running edge renders 3 SMIL particles, respects monaco-reduce-motion, G jumps to waiting gate, and >24 running edges cap at 24*3
		await h.engineering.runTree(gov.id, 'user');
		await waitForNodePhase(h.engineering, gov.id, 'N1', 'employee_review');
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'N1', role: 'employee', verdict: 'pass', report: 'Seed ok' });
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'N1', role: 'manager', verdict: 'pass' });
		await waitForDomCondition(() => Boolean(host.querySelector('.ade-eng-node[data-node-id="U1"].awaiting-gate')));

		// Upstream badge visible on awaiting gate too
		assert.ok(host.querySelector('.ade-eng-node[data-node-id="U1"] .ade-eng-gate-up-badge')?.textContent?.includes('1 ✓'));
		const runningEdgeGroup = host.querySelector('.ade-eng-edge-item[data-edge="N1->U1"]') as SVGGElement;
		const particles = runningEdgeGroup.querySelectorAll('circle.ade-eng-edge-particle');
		assert.strictEqual(particles.length, ADE_ENG_PARTICLES_PER_EDGE, 'Running edge renders 3 SMIL signal particles');

		host.classList.add('monaco-reduce-motion');
		assert.strictEqual(mainWindow.getComputedStyle(particles[0]).display, 'none', 'Reduced motion hides SMIL edge particles');
		host.classList.remove('monaco-reduce-motion');

		// G shortcut jumps to waiting User Gate U1 and opens its inspector
		popoverEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		rootEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
		assert.strictEqual(popoverEl.classList.contains('open'), true, 'G shortcut opens waiting User Gate inspector');
		assert.strictEqual(popoverEl.querySelector('.ade-eng-pop-id')?.textContent, 'U1');

		// Verify ≤24 animated edge cap on a wide fan-out graph (28 running edges -> 72 particles max)
		const fanGov = await createGovernor(h.projects, sessions, 'Fanout Cap Gov');
		await h.engineering.initTree({ governorSessionId: fanGov.id });
		const gateCount = ADE_ENG_MAX_PARTICLE_EDGES + 4;
		const mermaidLines = Array.from({ length: gateCount }, (_, i) => `  N0["Hub"] --> G${i + 1}{{"Gate ${i + 1}"}}`);
		const gateSections = Array.from({ length: gateCount }, (_, i) => [
			`## Node: G${i + 1}`,
			`- Title: Gate ${i + 1}`,
			'- Type: user_gate',
			'### Description',
			'Fanout gate.',
		].join('\n'));
		const fanoutBp = [
			'---',
			'version: 1',
			'treeType: engineering',
			'workspaceIsolation: shared',
			'---',
			'',
			'```mermaid',
			'graph LR',
			...mermaidLines,
			'```',
			'',
			'## Node: N0',
			'- Title: Hub',
			'- Type: task',
			'- Critical: false',
			'- Employee: engine=claude-code, thinking=low',
			'- Worker: engine=codex, thinking=low',
			'### Goal',
			'Hub.',
			'### Acceptance Criteria',
			'Hub ok.',
			...gateSections,
		].join('\n');
		await h.engineering.applyBlueprint({ governorSessionId: fanGov.id, blueprintText: fanoutBp });
		const fanInput = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, fanGov.id));
		await pane.setInput(fanInput, undefined, {}, CancellationToken.None);
		await h.engineering.runTree(fanGov.id, 'user');
		await waitForNodePhase(h.engineering, fanGov.id, 'N0', 'employee_review');
		await h.engineering.submitReview({ governorSessionId: fanGov.id, nodeId: 'N0', role: 'employee', verdict: 'pass', report: 'Hub ok' });
		await h.engineering.submitReview({ governorSessionId: fanGov.id, nodeId: 'N0', role: 'manager', verdict: 'pass' });
		await waitForDomCondition(() => host.querySelectorAll('.ade-eng-edge-path.status-running').length === gateCount);
		assert.strictEqual(
			host.querySelectorAll('circle.ade-eng-edge-particle').length,
			ADE_ENG_MAX_PARTICLE_EDGES * ADE_ENG_PARTICLES_PER_EDGE,
			'SMIL edge particles cap cleanly at 24 running edges × 3 particles',
		);

		pane.clearInput();
	});

	test('Wave 3: 5-tab anchored inspector (caret, 32x20 podmap, ArrowLeft/Right nav, opt-in Pin), right-docked 4-tier analytics card, Split Blueprint editor with gutter & xref, and 3-lane Logs timeline with search & new-events pill', async () => {
		const host = append(mainWindow.document.body, $('div.monaco-workbench', { style: 'position:fixed;left:0;top:0;width:1220px;height:800px;' }));
		store.add({ dispose: () => host.remove() });

		assert.strictEqual(computeTokenRatePerMinute([{ t: 0, total: 1000 }, { t: 30_000, total: 4000 }]), 6000);
		assert.strictEqual(blueprintNodeIdAtOffset('## Node: N1\n### Goal\nHello\n## Node: N2\nWorld', 18), 'N1');

		const h = createEngineeringHarness();
		await h.engineering.whenReady();
		const sessions = h.instantiation.get(IAdeSessionsService);
		const gov = await createGovernor(h.projects, sessions, 'Mission Control Gov');
		await h.engineering.initTree({ governorSessionId: gov.id });

		const bpText = [
			'---',
			'version: 1',
			'treeType: engineering',
			'workspaceIsolation: shared',
			'---',
			'',
			'```mermaid',
			'graph LR',
			'  N1["API Layer"] --> N2["UI Shell"]',
			'```',
			'',
			'## Node: N1',
			'- Title: API Layer',
			'- Type: task',
			'- Critical: false',
			'- Employee: engine=claude-code, thinking=medium',
			'- Worker: engine=codex, thinking=high',
			'### Goal',
			'Build API.',
			'### Acceptance Criteria',
			'API tests pass.',
			'',
			'## Node: N2',
			'- Title: UI Shell',
			'- Type: task',
			'- Critical: false',
			'- Employee: engine=claude-code, thinking=medium',
			'- Worker: engine=codex, thinking=high',
			'### Goal',
			'Build UI.',
			'### Acceptance Criteria',
			'UI tests pass.',
		].join('\n');
		await h.engineering.applyBlueprint({ governorSessionId: gov.id, blueprintText: bpText });

		const fakeGroup = new class extends mock<IEditorGroup>() {
			override readonly id = 1;
		}();
		const pane = store.add(h.instantiation.createInstance(AdeEngineeringEditorPane, fakeGroup));
		pane.create(host);
		pane.layout({ width: 1220, height: 800, top: 0, left: 0 } as never);
		const input = store.add(h.instantiation.createInstance(AdeEngineeringEditorInput, gov.id));
		await pane.setInput(input, undefined, {}, CancellationToken.None);

		// 1. Anchored 5-tab Inspector: caret, 32×20 podmap, ←/→ keyboard switching, and opt-in Pin
		const nodeN1El = host.querySelector('.ade-eng-node[data-node-id="N1"]') as HTMLElement;
		const popoverEl = host.querySelector('.ade-eng-popover') as HTMLElement;
		nodeN1El.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
		assert.strictEqual(popoverEl.classList.contains('open'), true);
		assert.ok(popoverEl.querySelector('.ade-eng-pop-caret'), 'Inspector renders anchor caret');
		assert.ok(popoverEl.querySelector('.ade-eng-pop-podmap.active-worker'), '32×20 podmap highlights Worker core initially');
		assert.strictEqual(popoverEl.querySelector('input.ade-eng-input'), popoverEl.querySelector('input.ade-eng-pop-title-input'), 'First input in popover remains title input (T10)');

		popoverEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		assert.strictEqual(popoverEl.querySelector('.ade-eng-pop-role-tab.tab-employee')?.getAttribute('aria-selected'), 'true', 'ArrowRight switches to Employee tab');
		assert.ok(popoverEl.querySelector('.ade-eng-pop-podmap.active-employee'), 'Podmap highlights Employee shell on Employee tab');

		popoverEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		assert.strictEqual(popoverEl.querySelector('.ade-eng-pop-role-tab.tab-worker')?.getAttribute('aria-selected'), 'true', 'ArrowLeft returns to Worker tab');

		const pinBtn = popoverEl.querySelector('button.ade-eng-pop-icon-btn.pin') as HTMLButtonElement;
		assert.ok(pinBtn, 'Inspector exposes opt-in Pin button');
		pinBtn.click();
		assert.ok(popoverEl.classList.contains('pinned'), 'Clicking Pin marks inspector .pinned');

		const viewportEl = host.querySelector('.ade-eng-viewport') as HTMLElement;
		viewportEl.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 24, clientY: 200, bubbles: true }));
		viewportEl.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 24, clientY: 200, bubbles: true }));
		assert.strictEqual(popoverEl.classList.contains('open'), true, 'Pinned inspector stays open on outside canvas click');
		(popoverEl.querySelector('.ade-eng-pop-icon-btn.close') as HTMLButtonElement).click();
		assert.strictEqual(popoverEl.classList.contains('open'), false, 'Close button dismisses pinned inspector');

		// 2. Right-docked 4-tier Token Analytics card (.docked, never .ade-eng-drawer)
		const n1WrkId = h.engineering.getTreeSnapshot(gov.id)!.state.nodes.N1.workerAgentId!;
		const n1EmpId = h.engineering.getTreeSnapshot(gov.id)!.state.nodes.N1.employeeAgentId!;
		await h.commandService.executeCommand(ADE_RECORD_TURN_USAGE_COMMAND_ID, {
			agentId: n1WrkId,
			usage: { inputTokens: 1500, outputTokens: 500, cacheReadTokens: 0, totalTokens: 2000 },
		});
		await h.commandService.executeCommand(ADE_RECORD_TURN_USAGE_COMMAND_ID, {
			agentId: n1EmpId,
			usage: { inputTokens: 600, outputTokens: 200, cacheReadTokens: 0, totalTokens: 800 },
		});
		await waitForDomCondition(() => Boolean(
			host.querySelector('.ade-eng-tokens-pill.has-usage')
			&& host.querySelector('.ade-eng-node[data-node-id="N1"] .ade-eng-node-tokens'),
		));

		const tokensPill = host.querySelector('.ade-eng-tokens-pill') as HTMLElement;
		const analyticsCard = host.querySelector('.ade-eng-token-analytics-card.docked') as HTMLElement;
		assert.ok(analyticsCard, 'Right-docked .ade-eng-token-analytics-card.docked exists');
		assert.strictEqual(host.querySelector('.ade-eng-drawer'), null, '.ade-eng-drawer must remain null (T7)');
		assert.strictEqual(analyticsCard.hidden, true);
		tokensPill.click();
		assert.strictEqual(analyticsCard.hidden, false, 'Token pill opens docked analytics card');
		assert.strictEqual(analyticsCard.querySelectorAll('.ade-eng-ta-stack-seg').length, 4, '4-tier stacked bar rendered (Gov/Mgr/Emp/Wrk)');
		assert.ok(analyticsCard.querySelector('.ade-eng-ta-rate')?.textContent?.includes('tok/min'), 'Live tok/min rate KPI rendered');
		assert.ok(analyticsCard.querySelector('.ade-eng-ta-seg-row'), 'Per-segment telemetry row rendered');
		assert.ok(analyticsCard.querySelector('.ade-eng-ta-top-row[data-node-id="N1"]'), 'Clickable top-5 node row rendered');
		(host.querySelector('.ade-eng-tokens-pill') as HTMLElement).click();
		assert.strictEqual(analyticsCard.hidden, true);

		// 3. Blueprint Overlay ⇄ Split mode + synced line-number gutter + pod .xref cross-highlight
		const sheetToggle = host.querySelector('.ade-eng-sheet-toggle') as HTMLButtonElement;
		sheetToggle.click();
		const sheet = host.querySelector('.ade-eng-sheet') as HTMLElement;
		const bodyEl = host.querySelector('.ade-eng-body') as HTMLElement;
		assert.ok(sheet.classList.contains('open') && sheet.classList.contains('mode-overlay'));

		const modeBtn = sheet.querySelector('button.ade-eng-sheet-mode-btn') as HTMLButtonElement;
		assert.ok(modeBtn, 'Sheet header exposes Overlay ⇄ Split toggle');
		modeBtn.click();
		assert.ok(sheet.classList.contains('mode-split') && bodyEl.classList.contains('split-sheet'), 'Split toggle activates .ade-eng-sheet.mode-split and .ade-eng-body.split-sheet');

		const bpEditor = sheet.querySelector('textarea.ade-eng-blueprint-editor') as HTMLTextAreaElement;
		const gutterLines = sheet.querySelectorAll('.ade-eng-bp-gutter .ade-eng-bp-line');
		assert.strictEqual(gutterLines.length, bpEditor.value.split('\n').length, 'Line-number gutter matches Blueprint textarea line count');
		const n2Idx = bpEditor.value.indexOf('### [N2]');
		assert.ok(n2Idx >= 0, 'Serialized Blueprint contains ### [N2] heading');
		bpEditor.setSelectionRange(n2Idx + 4, n2Idx + 4);
		bpEditor.dispatchEvent(new mainWindow.Event('select'));
		assert.ok(host.querySelector('.ade-eng-node[data-node-id="N2"]')?.classList.contains('xref'), 'Caret inside ### [N2] section cross-highlights pod N2 with .xref');

		// 4. Role-filtered 3-lane Logs timeline + search input + "↓ new" pill
		const heldN1 = h.holdNextWorkerTurn();
		await h.engineering.runTree(gov.id, 'user');
		await heldN1.started.p;
		heldN1.reply.complete('API ready');
		await waitForNodePhase(h.engineering, gov.id, 'N1', 'employee_review');

		const logsTabBtn = Array.from(sheet.querySelectorAll<HTMLButtonElement>('.ade-eng-sheet-tab')).find(b => b.textContent?.includes('Logs'))!;
		logsTabBtn.click();
		const eventsBody = sheet.querySelector('.ade-eng-sheet-body.events.timeline') as HTMLElement;
		assert.ok(eventsBody, 'Logs tab renders 3-lane .timeline body');
		assert.ok(eventsBody.querySelector('.ade-eng-event-rail-dot'), 'Event rows render 3-lane rail dots');

		const searchInput = sheet.querySelector('input.ade-eng-event-search') as HTMLInputElement;
		assert.ok(searchInput, 'Logs filter bar renders search input');
		searchInput.focus();
		searchInput.value = 'xyznomatch';
		searchInput.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
		assert.strictEqual(mainWindow.document.activeElement, searchInput, 'Typing in log search preserves focus');
		assert.strictEqual(eventsBody.querySelectorAll('.ade-eng-event-row').length, 0);
		searchInput.value = '';
		searchInput.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
		assert.ok(eventsBody.querySelectorAll('.ade-eng-event-row').length > 0);

		// Pin scroll away from live bottom, emit a new event, and verify "↓ N new" pill
		eventsBody.dataset.pinnedScroll = '1';
		const heldN2 = h.holdNextWorkerTurn();
		await h.engineering.submitReview({ governorSessionId: gov.id, nodeId: 'N1', role: 'employee', verdict: 'pass', report: 'API verified' });
		await heldN2.started.p;
		await waitForDomCondition(() => {
			const pill = sheet.querySelector('.ade-eng-event-new-pill') as HTMLElement | null;
			return Boolean(pill && !pill.hidden);
		});
		const newPill = sheet.querySelector('.ade-eng-event-new-pill') as HTMLButtonElement;
		assert.ok(newPill.textContent?.includes('↓') && newPill.textContent?.includes('new'), 'Scrolled-away timeline displays "↓ N new" pill on fresh events');
		newPill.click();
		assert.strictEqual(newPill.hidden, true, 'Clicking "↓ N new" jumps to live edge and hides pill');
		heldN2.reply.complete('UI ready');

		pane.clearInput();
	});
});
