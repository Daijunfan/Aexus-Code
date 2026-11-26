/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ADE_DISPATCH_TICKET_TURN_COMMAND_ID, ADE_GET_WINDOW_ID_COMMAND_ID } from '../../../../../platform/ade/common/adeControl.js';
import { IAdeControlCenterService } from '../../../../../platform/ade/common/adeControlCenterIpc.js';
import { formatAdeTicketDeliveryPayload } from '../../../../../platform/ade/common/adeModels.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService, IEditorReplacement } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IWorkbenchModeService } from '../../../../services/workbenchMode/common/workbenchMode.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ChatEditorInput } from '../../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { ChatSendResult, IChatService } from '../../../chat/common/chatService/chatService.js';
import { IChatModel } from '../../../chat/common/model/chatModel.js';
import { AdeOpenChatTicketScheduler, AdeOutboxBridgeContribution } from '../../browser/adeControlHandler.js';
import { AdeEditorService, AdeLineageChatEditorInput } from '../../browser/adeEditorService.js';
import { AdeProjectsService } from '../../browser/adeProjectsService.js';
import {
	ADE_TRY_NATIVE_IN_STREAM_STEER_COMMAND_ID,
	ADE_TRY_SEND_OPEN_CHAT_REQUEST_COMMAND_ID,
	IAdeEditorService,
	IAdeProjectsService,
	parseAdeEmployeeSessionUri,
} from '../../common/ade.js';
import { TestAdeControlCenterService } from '../common/testAdeControlCenterService.js';

class FakeGroupWithReplace implements Partial<IEditorGroup> {
	readonly editors: EditorInput[] = [];
	activeEditor: EditorInput | null = null;
	replaceCalls = 0;

	constructor(
		readonly id: number,
		private readonly onActiveChanged: () => void,
	) { }

	isPinned(): boolean {
		return true;
	}

	async replaceEditors(replacements: IEditorReplacement[]): Promise<void> {
		this.replaceCalls++;
		for (const rep of replacements) {
			const idx = this.editors.indexOf(rep.editor);
			const wasActive = this.activeEditor === rep.editor;
			if (idx >= 0) {
				this.editors.splice(idx, 1, rep.replacement);
			} else {
				this.editors.push(rep.replacement);
			}
			if (wasActive || !this.activeEditor) {
				this.activeEditor = rep.replacement;
			}
			if (!rep.editor.isDisposed()) {
				rep.editor.dispose();
			}
		}
		this.onActiveChanged();
	}
}

suite('ADE Wave 6 Track B — Native Pi In-Stream Steer, Unstarted Tab Rebinding, blocked_cli Config Replay & Double-Hyphen URIs', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('[Defect B4] parseAdeEmployeeSessionUri parses --, ::, and single-hyphen URIs without residual hyphens', () => {
		const cases: ReadonlyArray<readonly [string, string, string, string]> = [
			['aexus-pi:/ade-proj_a1b2c3d4--agent_5678ef01', 'pi', 'proj_a1b2c3d4', 'agent_5678ef01'],
			['aexus-claude:/ade-proj_a1b2c3d4--worker_1', 'claude', 'proj_a1b2c3d4', 'worker_1'],
			['aexus-codex:/ade-proj_a1b2c3d4-agent_5678ef01', 'codex', 'proj_a1b2c3d4', 'agent_5678ef01'],
			['aexus-kilo:/ade-proj_a1b2c3d4-worker_1', 'kilo', 'proj_a1b2c3d4', 'worker_1'],
			['aexus-dsh:/ade-proj_a1b2c3d4::worker_1', 'dsh', 'proj_a1b2c3d4', 'worker_1'],
		];

		for (const [raw, expectedEngine, expectedProj, expectedAgent] of cases) {
			const parsed = parseAdeEmployeeSessionUri(URI.parse(raw));
			assert.deepStrictEqual(parsed, {
				engine: expectedEngine,
				projectId: expectedProj,
				agentId: expectedAgent,
			});
		}
	});

	test('[Defect B3] AdeOpenChatTicketScheduler invokes aexus.ade.tryNativeInStreamSteer BEFORE cancelCurrentRequestForSession for pi and only cancels on { steered: false }', async () => {
		const scheduler = new AdeOpenChatTicketScheduler();
		store.add({ dispose: () => scheduler.abortForWindowDispose() });

		const piUri = URI.parse('aexus-pi:/ade-proj_1-agent_pi');
		const sessionChange = store.add(new Emitter<{ kind: 'completedRequest' | 'removeRequest' }>());
		let activeTurnDeferred: DeferredPromise<void> | undefined;
		let lastPromptText = '';
		let cancelCount = 0;

		const chatService = upcastPartial<IChatService>({
			getSession: (resource: URI) => {
				if (resource.toString() !== piUri.toString()) {
					return undefined;
				}
				const busy = Boolean(activeTurnDeferred && !activeTurnDeferred.isSettled);
				return upcastPartial<IChatModel>({
					sessionResource: piUri,
					lastRequest: lastPromptText ? ({
						id: 'req_1',
						message: { text: lastPromptText },
						response: {
							isComplete: !busy,
							onDidChange: Event.None,
						},
					} as unknown as IChatModel['lastRequest']) : undefined,
					hasActiveRequest: constObservable(busy),
					requestInProgress: constObservable(busy),
					onDidDispose: Event.None,
					onDidChange: sessionChange.event as unknown as IChatModel['onDidChange'],
				});
			},
			sendRequest: (async (_resource: URI, message: string): Promise<ChatSendResult> => {
				lastPromptText = message;
				const def = new DeferredPromise<void>();
				activeTurnDeferred = def;
				return {
					kind: 'sent',
					data: {
						responseCreatedPromise: def.p.then(() => undefined),
						responseCompletePromise: def.p.finally(() => {
							sessionChange.fire({ kind: 'completedRequest' });
						}),
					},
				} as unknown as ChatSendResult;
			}) as IChatService['sendRequest'],
			cancelCurrentRequestForSession: async () => {
				cancelCount++;
				activeTurnDeferred?.complete();
			},
		});

		const nativeSteerCalls: Array<Record<string, unknown>> = [];
		let shouldNativeSteerSucceed = true;
		const commandService = upcastPartial<ICommandService>({
			executeCommand: (async (id: string, ...args: unknown[]) => {
				if (id === ADE_TRY_NATIVE_IN_STREAM_STEER_COMMAND_ID) {
					nativeSteerCalls.push(args[0] as Record<string, unknown>);
					return { steered: shouldNativeSteerSucceed };
				}
				return undefined;
			}) as ICommandService['executeCommand'],
		});

		const ticket1 = formatAdeTicketDeliveryPayload({
			fromId: 'agent_l1',
			ticketId: 'tk_1',
			taskId: 'tsk_1',
			taskType: 'dev',
			needReturn: true,
			hasDetailRef: false,
			hasHistoryRef: false,
			taskTitle: 'Turn 1',
			summary: 'First pi turn',
		});
		const p1 = scheduler.dispatchTicket(
			{
				sessionUri: piUri,
				payloadText: ticket1,
				deliveryMode: 'queue',
				projectId: 'proj_1',
				agentId: 'agent_pi',
				engine: 'pi',
				model: 'anthropic/claude-sonnet-4-6',
				ticketId: 'tk_1',
				taskId: 'tsk_1',
			},
			chatService,
			undefined,
			commandService,
		);

		await new Promise<void>(r => setTimeout(r, 10));
		assert.strictEqual(Boolean(activeTurnDeferred && !activeTurnDeferred.isSettled), true);

		// 1. Same-model steer -> steered: true -> resolves immediately with ZERO cancelCurrentRequestForSession!
		const steerSameModel = formatAdeTicketDeliveryPayload({
			fromId: 'agent_l1',
			ticketId: 'tk_2',
			taskId: 'tsk_2',
			taskType: 'dev',
			needReturn: true,
			hasDetailRef: false,
			hasHistoryRef: false,
			taskTitle: 'Turn 2',
			summary: 'Steer same model',
		});
		const r2 = await scheduler.dispatchTicket(
			{
				sessionUri: piUri,
				payloadText: steerSameModel,
				deliveryMode: 'steer',
				projectId: 'proj_1',
				agentId: 'agent_pi',
				engine: 'pi',
				model: 'anthropic/claude-sonnet-4-6',
				reasoningEffort: 'high',
				ticketId: 'tk_2',
				taskId: 'tsk_2',
			},
			chatService,
			undefined,
			commandService,
		);
		assert.deepStrictEqual(r2, { accepted: true, ok: true, steeredInStream: true });
		assert.strictEqual(cancelCount, 0, 'Must NOT call cancelCurrentRequestForSession when tryNativeInStreamSteer returns steered:true');
		assert.strictEqual(nativeSteerCalls.length, 1);
		assert.strictEqual(nativeSteerCalls[0].model, 'anthropic/claude-sonnet-4-6');
		assert.strictEqual(Boolean(activeTurnDeferred && !activeTurnDeferred.isSettled), true, 'Original turn must continue uninterrupted');

		// 2. Model-switch steer -> steered: false -> falls back to cancelCurrentRequestForSession and dispatches new turn!
		shouldNativeSteerSucceed = false;
		const steerSwitchModel = formatAdeTicketDeliveryPayload({
			fromId: 'agent_l1',
			ticketId: 'tk_3',
			taskId: 'tsk_3',
			taskType: 'dev',
			needReturn: true,
			hasDetailRef: false,
			hasHistoryRef: false,
			taskTitle: 'Turn 3',
			summary: 'Steer switched model',
		});
		const p3 = scheduler.dispatchTicket(
			{
				sessionUri: piUri,
				payloadText: steerSwitchModel,
				deliveryMode: 'steer',
				projectId: 'proj_1',
				agentId: 'agent_pi',
				engine: 'pi',
				model: 'openai/gpt-5.4',
				ticketId: 'tk_3',
				taskId: 'tsk_3',
			},
			chatService,
			undefined,
			commandService,
		);

		const r1 = await p1;
		assert.strictEqual(r1.ok, true);
		assert.strictEqual(r1.stopped, true);
		assert.strictEqual(cancelCount, 1, 'Model switch returning steered:false must invoke cancelCurrentRequestForSession');

		await new Promise<void>(r => setTimeout(r, 15));
		activeTurnDeferred?.complete();
		const r3 = await p3;
		assert.strictEqual(r3.ok, true);
	});

	test('[Defect B2] AdeEditorService.rebindUnstartedAgentEditors replaces open ChatEditorInput in-place at same tab index and clears old session when unstarted employee switches engine', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const snap = await controlCenter.createProject({
			folderUri: URI.file('/workspace/rebind-proj').toString(),
			name: 'Rebind Project',
		});
		const agent = await controlCenter.uiCreateAgent({
			projectId: snap.meta.project_id,
			parentId: null,
			level: 1,
			name: 'Lead Architect',
			roleSummary: 'L1',
			host: 'local',
			engine: 'kilo',
			model: 'anthropic/claude-sonnet-4-6',
			effort: 'medium',
		});
		assert.strictEqual(agent.session_started, false);

		const onActiveChange = store.add(new Emitter<void>());
		const group1 = new FakeGroupWithReplace(1, () => onActiveChange.fire());
		const dummyFirstTab = store.add(new class extends EditorInput {
			override readonly resource = URI.file('/workspace/rebind-proj/README.md');
			override get typeId() { return 'test.readme'; }
		}());
		group1.editors.push(dummyFirstTab);

		const clearedUris: string[] = [];
		const removedHistoryUris: string[] = [];
		const chatService = upcastPartial<IChatService & { clearSession(uri: URI): void }>({
			clearSession: (uri: URI) => { clearedUris.push(uri.toString()); },
			removeHistoryEntry: async (uri: URI) => { removedHistoryUris.push(uri.toString()); },
		});

		const editorGroupsService = upcastPartial<IEditorGroupsService>({
			mainPart: upcastPartial<IEditorGroupsService['mainPart']>({
				get activeGroup() { return group1 as unknown as IEditorGroup; },
				get groups() { return [group1] as unknown as readonly IEditorGroup[]; },
				findGroup: () => undefined,
				addGroup: (_loc: IEditorGroup | number, _dir: GroupDirection) => group1 as unknown as IEditorGroup,
			}),
		});
		const editorService = upcastPartial<IEditorService>({
			onDidActiveEditorChange: onActiveChange.event,
			get activeEditor() { return group1.activeEditor ?? undefined; },
			openEditor: (async (input: EditorInput) => {
				if (!group1.editors.includes(input)) {
					group1.editors.push(input);
				}
				group1.activeEditor = input;
				onActiveChange.fire();
				return undefined;
			}) as unknown as IEditorService['openEditor'],
			closeEditors: async (targets: readonly { editor: EditorInput; groupId: number }[]) => {
				for (const t of targets) {
					const idx = group1.editors.indexOf(t.editor);
					if (idx >= 0) {
						group1.editors.splice(idx, 1);
					}
					if (!t.editor.isDisposed()) {
						t.editor.dispose();
					}
				}
				onActiveChange.fire();
			},
		});

		const insta = workbenchInstantiationService(undefined, store);
		insta.stub(IAdeControlCenterService, controlCenter);
		insta.stub(IChatService, chatService);
		insta.stub(IEditorGroupsService, editorGroupsService);
		insta.stub(IEditorService, editorService);
		insta.stub(IWorkbenchModeService, upcastPartial<IWorkbenchModeService>({
			mode: 'ade',
			onDidChangeMode: Event.None,
		}));
		insta.stub(IExtensionService, upcastPartial<IExtensionService>({
			activateById: async () => { },
		}));

		const projectsService = store.add(insta.createInstance(AdeProjectsService));
		insta.stub(IAdeProjectsService, projectsService);
		await projectsService.whenReady();

		const adeEditors = store.add(insta.createInstance(AdeEditorService));
		insta.stub(IAdeEditorService, adeEditors);
		store.add({
			dispose: () => {
				for (const e of [...group1.editors]) {
					if (!e.isDisposed()) {
						e.dispose();
					}
				}
				group1.editors.length = 0;
			},
		});

		await adeEditors.openAgent(agent.agent_id, { projectId: snap.meta.project_id });
		assert.strictEqual(group1.editors.length, 2);
		const oldChatTab = group1.editors[1] as AdeLineageChatEditorInput;
		assert.ok(oldChatTab instanceof ChatEditorInput);
		assert.strictEqual(oldChatTab.sessionResource?.toString(), `aexus-kilo:/ade-${snap.meta.project_id}-${agent.agent_id}`);

		await controlCenter.uiEditAgent({
			projectId: snap.meta.project_id,
			agentId: agent.agent_id,
			engine: 'claude',
			model: 'claude-opus-4-6',
		});

		await adeEditors.rebindUnstartedAgentEditors(snap.meta.project_id);
		await new Promise<void>(r => setTimeout(r, 15));

		assert.strictEqual(group1.editors.length, 2, 'Tab count in group must remain unchanged');
		assert.strictEqual(group1.editors[0], dummyFirstTab, 'Adjacent tabs must keep exact index');
		const reboundTab = group1.editors[1] as ChatEditorInput;
		assert.ok(reboundTab instanceof ChatEditorInput);
		assert.strictEqual(reboundTab.sessionResource?.toString(), `aexus-claude:/ade-${snap.meta.project_id}-${agent.agent_id}`);
		assert.strictEqual(group1.activeEditor, reboundTab);
		assert.strictEqual(oldChatTab.isDisposed(), true, 'Old aexus-kilo ChatEditorInput must be disposed');
		assert.strictEqual(group1.replaceCalls, 1);
		assert.deepStrictEqual(clearedUris, [`aexus-kilo:/ade-${snap.meta.project_id}-${agent.agent_id}`]);
		assert.deepStrictEqual(removedHistoryUris, [`aexus-kilo:/ade-${snap.meta.project_id}-${agent.agent_id}`]);
	});

	test('[Defect B1] TestAdeControlCenterService & AdeOutboxBridgeContribution hold cliMissing in blocked_cli and replay on aexus.agentEngines config change', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const snap = await controlCenter.createProject({
			folderUri: URI.file('/workspace/b1-proj').toString(),
			name: 'B1 Project',
		});
		const worker = await controlCenter.uiCreateAgent({
			projectId: snap.meta.project_id,
			parentId: null,
			level: 1,
			name: 'Dsh Lead',
			roleSummary: 'L1',
			host: 'local',
			engine: 'dsh',
			model: 'deepseek-reasoner',
			effort: 'high',
		});

		const cfgChange = store.add(new Emitter<IConfigurationChangeEvent>());
		const configService = new TestConfigurationService();
		Object.defineProperty(configService, 'onDidChangeConfiguration', { value: cfgChange.event });

		let cliInstalled = false;
		const dispatchedDeliveries: string[] = [];
		const commandService = upcastPartial<ICommandService>({
			executeCommand: (async (id: string, ...args: unknown[]) => {
				if (id === ADE_GET_WINDOW_ID_COMMAND_ID) {
					return 9;
				}
				if (id === ADE_DISPATCH_TICKET_TURN_COMMAND_ID) {
					const payload = args[0] as { deliveryId: string };
					dispatchedDeliveries.push(payload.deliveryId);
					if (!cliInstalled) {
						return { ok: false, cliMissing: true, error: 'dsh CLI missing' };
					}
					return { ok: true, nativeSessionId: 'dsh_ses_1' };
				}
				const reg = CommandsRegistry.getCommand(id);
				if (reg) {
					return insta.invokeFunction(reg.handler, ...args);
				}
				return undefined;
			}) as ICommandService['executeCommand'],
		});

		const insta = workbenchInstantiationService(undefined, store);
		insta.stub(IAdeControlCenterService, controlCenter);
		insta.stub(IConfigurationService, configService);
		insta.stub(ICommandService, commandService);

		const bridge = store.add(insta.createInstance(AdeOutboxBridgeContribution));

		const item = controlCenter.enqueueTestOutboxDelivery({
			projectId: snap.meta.project_id,
			ticketId: 'tk_b1',
			taskId: 'tsk_b1',
			targetAgentId: worker.agent_id,
			deliveryMode: 'queue',
			payloadText: 'First task',
		});
		await bridge.flushOutboxForTest();

		assert.strictEqual(dispatchedDeliveries.length, 1);
		const snapAfterFail = await controlCenter.getProjectSnapshot(snap.meta.project_id);
		assert.strictEqual(snapAfterFail?.agents[0].session_started, false, 'Missing CLI must roll back session_started to false');

		const emptyClaims = await controlCenter.claimPendingDeliveries(9, 16);
		assert.strictEqual(emptyClaims.length, 0);

		cliInstalled = true;
		cfgChange.fire({
			affectsConfiguration: (section: string) => section === 'aexus.agentEngines',
			affectedKeys: new Set(['aexus.agentEngines']),
			change: { keys: ['aexus.agentEngines'], overrides: [] },
			source: 2,
		} as unknown as IConfigurationChangeEvent);

		const deadline = Date.now() + 2000;
		while (dispatchedDeliveries.length < 2 && Date.now() < deadline) {
			await new Promise<void>(r => setTimeout(r, 15));
		}
		await bridge.flushOutboxForTest();

		assert.deepStrictEqual(dispatchedDeliveries, [item.deliveryId, item.deliveryId]);
		const snapAfterReplay = await controlCenter.getProjectSnapshot(snap.meta.project_id);
		assert.strictEqual(snapAfterReplay?.agents[0].session_started, true);
	});

	test('[Defect B-R1 & B-R2 #1] cliMissing rollback + open tab + delayed syncCachedEmployeeMeta rebinds tab BEFORE replay so first replayed Ticket routes 100% via Path A without regressing AdeProjectsService snapshot', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const snap = await controlCenter.createProject({
			folderUri: URI.file('/workspace/br1-proj').toString(),
			name: 'BR1 Project',
		});
		const worker = await controlCenter.uiCreateAgent({
			projectId: snap.meta.project_id,
			parentId: null,
			level: 1,
			name: 'Resilient Worker',
			roleSummary: 'L1',
			host: 'local',
			engine: 'kilo',
			model: 'claude-sonnet-4-6',
			effort: 'high',
		});

		const onActiveChange = store.add(new Emitter<void>());
		const group1 = new FakeGroupWithReplace(1, () => onActiveChange.fire());

		interface IMockOpenChatEntry {
			uri: URI;
			busy: boolean;
			lastPromptText: string;
			readonly onChange: Emitter<{ kind: 'completedRequest' | 'removeRequest' }>;
		}
		const openSessions = new Map<string, IMockOpenChatEntry>();
		const pathASentRequests: Array<{ uri: string; message: string }> = [];
		const pathBHeadlessDispatches: string[] = [];

		const ensureMockSession = (resource: URI): IMockOpenChatEntry => {
			let entry = openSessions.get(resource.toString());
			if (!entry) {
				entry = {
					uri: resource,
					busy: false,
					lastPromptText: '',
					onChange: store.add(new Emitter<{ kind: 'completedRequest' | 'removeRequest' }>()),
				};
				openSessions.set(resource.toString(), entry);
			}
			return entry;
		};

		const buildChatModelStub = (entry: IMockOpenChatEntry): IChatModel => upcastPartial<IChatModel>({
			sessionResource: entry.uri,
			title: 'Resilient Worker',
			hasCustomTitle: true,
			hasRequests: Boolean(entry.lastPromptText),
			lastRequest: entry.lastPromptText ? ({
				id: 'req_br1',
				message: { text: entry.lastPromptText },
				response: {
					isComplete: !entry.busy,
					onDidChange: Event.None,
				},
			} as unknown as IChatModel['lastRequest']) : undefined,
			hasActiveRequest: constObservable(entry.busy),
			requestInProgress: constObservable(entry.busy),
			onDidDispose: Event.None,
			onDidChange: entry.onChange.event as unknown as IChatModel['onDidChange'],
		});

		const chatService = upcastPartial<IChatService & { clearSession(uri: URI): void }>({
			getSession: (resource: URI) => {
				const entry = openSessions.get(resource.toString());
				return entry ? buildChatModelStub(entry) : undefined;
			},
			getSessionTitle: () => 'Resilient Worker',
			acquireOrLoadSession: (async (resource: URI) => {
				const entry = ensureMockSession(resource);
				return {
					object: buildChatModelStub(entry),
					dispose: () => { },
				};
			}) as unknown as IChatService['acquireOrLoadSession'],
			sendRequest: (async (resource: URI, message: string): Promise<ChatSendResult> => {
				const entry = openSessions.get(resource.toString());
				if (!entry) {
					return { kind: 'rejected', reason: 'Session not open' } as unknown as ChatSendResult;
				}
				entry.busy = true;
				entry.lastPromptText = message;
				pathASentRequests.push({ uri: resource.toString(), message });
				const completePromise = new Promise<void>(r => setTimeout(r, 15)).finally(() => {
					entry.busy = false;
					entry.onChange.fire({ kind: 'completedRequest' });
				});
				return {
					kind: 'sent',
					data: {
						responseCreatedPromise: completePromise.then(() => undefined),
						responseCompletePromise: completePromise,
					},
				} as unknown as ChatSendResult;
			}) as IChatService['sendRequest'],
			clearSession: (uri: URI) => {
				openSessions.delete(uri.toString());
			},
			removeHistoryEntry: async (uri: URI) => {
				openSessions.delete(uri.toString());
			},
		});

		const editorGroupsService = upcastPartial<IEditorGroupsService>({
			mainPart: upcastPartial<IEditorGroupsService['mainPart']>({
				get activeGroup() { return group1 as unknown as IEditorGroup; },
				get groups() { return [group1] as unknown as readonly IEditorGroup[]; },
				findGroup: () => undefined,
				addGroup: (_loc: IEditorGroup | number, _dir: GroupDirection) => group1 as unknown as IEditorGroup,
			}),
		});
		const editorService = upcastPartial<IEditorService>({
			onDidActiveEditorChange: onActiveChange.event,
			get activeEditor() { return group1.activeEditor ?? undefined; },
			openEditor: (async (input: EditorInput) => {
				if (!group1.editors.includes(input)) {
					group1.editors.push(input);
				}
				group1.activeEditor = input;
				if (input instanceof ChatEditorInput && !input.hasResolvedModel) {
					await input.resolve().catch(() => null);
				}
				onActiveChange.fire();
				return undefined;
			}) as unknown as IEditorService['openEditor'],
			closeEditors: async (targets: readonly { editor: EditorInput; groupId: number }[]) => {
				for (const t of targets) {
					const idx = group1.editors.indexOf(t.editor);
					if (idx >= 0) {
						group1.editors.splice(idx, 1);
					}
					if (!t.editor.isDisposed()) {
						t.editor.dispose();
					}
				}
				onActiveChange.fire();
			},
		});

		let syncMetaCalls = 0;
		const insta = workbenchInstantiationService(undefined, store);
		const commandService = upcastPartial<ICommandService>({
			executeCommand: (async (id: string, ...args: unknown[]) => {
				if (id === ADE_GET_WINDOW_ID_COMMAND_ID) {
					return 11;
				}
				if (id === 'aexus.ade.syncCachedEmployeeMeta') {
					syncMetaCalls++;
					// Inject 55ms async IPC delay to force the race against concurrent onDidEnqueueOutbox!
					await new Promise<void>(r => setTimeout(r, 55));
					return { updated: true };
				}
				if (id === ADE_DISPATCH_TICKET_TURN_COMMAND_ID) {
					const payload = args[0] as {
						deliveryId: string;
						projectId: string;
						agentId: string;
						engine: string;
						sessionResource: string;
						payloadText: string;
						deliveryMode: 'queue' | 'steer';
						model?: string;
						effort?: string;
						ticketId: string;
						taskId: string;
					};
					if (payload.engine === 'kilo') {
						return { ok: false, cliMissing: true, error: 'kilo CLI binary missing' };
					}
					const openChatReg = CommandsRegistry.getCommand(ADE_TRY_SEND_OPEN_CHAT_REQUEST_COMMAND_ID);
					const openChatRes = openChatReg
						? await insta.invokeFunction(openChatReg.handler, payload) as unknown as { accepted?: boolean; ok?: boolean }
						: { accepted: false };
					if (openChatRes?.accepted) {
						return { ok: openChatRes.ok !== false, routedViaOpenChat: true, nativeSessionId: 'claude_ses_path_a' };
					}
					pathBHeadlessDispatches.push(payload.deliveryId);
					return { ok: true, routedViaOpenChat: false, nativeSessionId: 'claude_ses_path_b' };
				}
				const reg = CommandsRegistry.getCommand(id);
				if (reg) {
					return insta.invokeFunction(reg.handler, ...args);
				}
				return undefined;
			}) as ICommandService['executeCommand'],
		});

		insta.stub(IAdeControlCenterService, controlCenter);
		insta.stub(IChatService, chatService);
		insta.stub(IEditorGroupsService, editorGroupsService);
		insta.stub(IEditorService, editorService);
		insta.stub(ICommandService, commandService);
		insta.stub(IWorkbenchModeService, upcastPartial<IWorkbenchModeService>({
			mode: 'ade',
			onDidChangeMode: Event.None,
		}));
		insta.stub(IExtensionService, upcastPartial<IExtensionService>({
			activateById: async () => { },
		}));

		const projectsService = store.add(insta.createInstance(AdeProjectsService));
		insta.stub(IAdeProjectsService, projectsService);
		await projectsService.whenReady();

		const adeEditors = store.add(insta.createInstance(AdeEditorService));
		insta.stub(IAdeEditorService, adeEditors);
		store.add({
			dispose: () => {
				for (const e of [...group1.editors]) {
					if (!e.isDisposed()) {
						e.dispose();
					}
				}
				group1.editors.length = 0;
			},
		});

		const bridge = store.add(insta.createInstance(AdeOutboxBridgeContribution));

		// 1. Open unstarted kilo tab -> send first Ticket -> fails with cliMissing and rolls back session_started to false
		await adeEditors.openAgent(worker.agent_id, { projectId: snap.meta.project_id });
		assert.strictEqual(group1.editors.length, 1);
		assert.strictEqual((group1.editors[0] as ChatEditorInput).sessionResource?.toString(), `aexus-kilo:/ade-${snap.meta.project_id}-${worker.agent_id}`);

		const ticketPayload = formatAdeTicketDeliveryPayload({
			fromId: 'agent_boss',
			ticketId: 'tk_br1',
			taskId: 'tsk_br1',
			taskType: 'dev',
			needReturn: true,
			hasDetailRef: false,
			hasHistoryRef: false,
			taskTitle: 'Switch recovery',
			summary: 'Deliver via Path A after engine switch',
		});
		controlCenter.enqueueTestOutboxDelivery({
			projectId: snap.meta.project_id,
			ticketId: 'tk_br1',
			taskId: 'tsk_br1',
			targetAgentId: worker.agent_id,
			deliveryMode: 'queue',
			payloadText: ticketPayload,
		});
		await bridge.flushOutboxForTest();

		const snapRolledBack = await controlCenter.getProjectSnapshot(snap.meta.project_id);
		assert.strictEqual(snapRolledBack?.agents[0].session_started, false);

		// 2. Edit engine kilo -> claude (simultaneously fires onDidChangeProject + requeueBlockedCliDeliveries -> onDidEnqueueOutbox)
		await controlCenter.uiEditAgent({
			projectId: snap.meta.project_id,
			agentId: worker.agent_id,
			engine: 'claude',
			model: 'claude-opus-4-6',
		});
		await bridge.flushOutboxForTest();
		await new Promise<void>(r => setTimeout(r, 25));

		const expectedClaudeUri = `aexus-claude:/ade-${snap.meta.project_id}-${worker.agent_id}`;
		assert.strictEqual(syncMetaCalls >= 1, true);
		assert.strictEqual(group1.editors.length, 1);
		assert.strictEqual((group1.editors[0] as ChatEditorInput).sessionResource?.toString(), expectedClaudeUri, 'Open tab must be rebound in-place to aexus-claude');
		assert.strictEqual(pathBHeadlessDispatches.length, 0, 'Replayed blocked_cli first Ticket MUST NOT fall back to headless Path B');
		assert.strictEqual(pathASentRequests.length, 1, 'Replayed blocked_cli first Ticket MUST route 100% via Path A open chat');
		assert.strictEqual(pathASentRequests[0].uri, expectedClaudeUri);

		// Also pass an older stale snapshot (session_started: false) into rebindUnstartedAgentEditors and verify AdeProjectsService is NEVER overwritten backwards!
		const staleSnapshot = {
			...snapRolledBack!,
			agents: snapRolledBack!.agents.map(a => ({ ...a, engine: 'claude' as const, session_started: false, session_phase: 'unstarted' as const })),
		};
		await adeEditors.rebindUnstartedAgentEditors(snap.meta.project_id, staleSnapshot);
		const projAgentAfter = projectsService.getAgent(worker.agent_id, snap.meta.project_id);
		assert.strictEqual(projAgentAfter?.engine, 'claude');
		assert.strictEqual(projAgentAfter?.sessionStarted, true, 'AdeProjectsService snapshot MUST NOT be regressed to session_started:false by rebindUnstartedAgentEditors');
	});

	test('[Defect B-R1 & B-R2 #2] rapid back-to-back engine edits kilo -> claude -> pi (first async slower than second) strictly converge open tab to aexus-pi without rolling back to aexus-claude', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const snap = await controlCenter.createProject({
			folderUri: URI.file('/workspace/br2-double-switch').toString(),
			name: 'Double Switch Project',
		});
		const agent = await controlCenter.uiCreateAgent({
			projectId: snap.meta.project_id,
			parentId: null,
			level: 1,
			name: 'Fast Switcher',
			roleSummary: 'L1',
			host: 'local',
			engine: 'kilo',
			model: 'default',
			effort: 'medium',
		});

		const onActiveChange = store.add(new Emitter<void>());
		const group1 = new FakeGroupWithReplace(1, () => onActiveChange.fire());
		const chatService = upcastPartial<IChatService & { clearSession(uri: URI): void }>({
			clearSession: () => { },
			removeHistoryEntry: async () => { },
		});
		const editorGroupsService = upcastPartial<IEditorGroupsService>({
			mainPart: upcastPartial<IEditorGroupsService['mainPart']>({
				get activeGroup() { return group1 as unknown as IEditorGroup; },
				get groups() { return [group1] as unknown as readonly IEditorGroup[]; },
				findGroup: () => undefined,
				addGroup: (_loc: IEditorGroup | number, _dir: GroupDirection) => group1 as unknown as IEditorGroup,
			}),
		});
		const editorService = upcastPartial<IEditorService>({
			onDidActiveEditorChange: onActiveChange.event,
			get activeEditor() { return group1.activeEditor ?? undefined; },
			openEditor: (async (input: EditorInput) => {
				if (!group1.editors.includes(input)) {
					group1.editors.push(input);
				}
				group1.activeEditor = input;
				onActiveChange.fire();
				return undefined;
			}) as unknown as IEditorService['openEditor'],
			closeEditors: async (targets: readonly { editor: EditorInput; groupId: number }[]) => {
				for (const t of targets) {
					const idx = group1.editors.indexOf(t.editor);
					if (idx >= 0) {
						group1.editors.splice(idx, 1);
					}
					if (!t.editor.isDisposed()) {
						t.editor.dispose();
					}
				}
				onActiveChange.fire();
			},
		});

		let activateCall = 0;
		const syncedEngines: string[] = [];
		const insta = workbenchInstantiationService(undefined, store);
		const commandService = upcastPartial<ICommandService>({
			executeCommand: (async (id: string, ...args: unknown[]) => {
				if (id === ADE_GET_WINDOW_ID_COMMAND_ID) {
					return 12;
				}
				if (id === 'aexus.ade.syncCachedEmployeeMeta') {
					const p = args[0] as { agents: ReadonlyArray<{ engine: string }> };
					const eng = p.agents[0]?.engine ?? '';
					syncedEngines.push(eng);
					if (eng === 'claude') {
						// First sync (claude) is intentionally much slower than second edit (pi)!
						await new Promise<void>(r => setTimeout(r, 70));
					} else {
						await new Promise<void>(r => setTimeout(r, 5));
					}
					return { updated: true };
				}
				const reg = CommandsRegistry.getCommand(id);
				if (reg) {
					return insta.invokeFunction(reg.handler, ...args);
				}
				return undefined;
			}) as ICommandService['executeCommand'],
		});

		insta.stub(IAdeControlCenterService, controlCenter);
		insta.stub(IChatService, chatService);
		insta.stub(IEditorGroupsService, editorGroupsService);
		insta.stub(IEditorService, editorService);
		insta.stub(ICommandService, commandService);
		insta.stub(IWorkbenchModeService, upcastPartial<IWorkbenchModeService>({
			mode: 'ade',
			onDidChangeMode: Event.None,
		}));
		insta.stub(IExtensionService, upcastPartial<IExtensionService>({
			activateById: async () => {
				activateCall++;
				// Make the first editor activation slower than the second edit!
				if (activateCall === 2) {
					await new Promise<void>(r => setTimeout(r, 55));
				}
			},
		}));

		const projectsService = store.add(insta.createInstance(AdeProjectsService));
		insta.stub(IAdeProjectsService, projectsService);
		await projectsService.whenReady();

		const adeEditors = store.add(insta.createInstance(AdeEditorService));
		insta.stub(IAdeEditorService, adeEditors);
		store.add({
			dispose: () => {
				for (const e of [...group1.editors]) {
					if (!e.isDisposed()) {
						e.dispose();
					}
				}
				group1.editors.length = 0;
			},
		});
		const bridge = store.add(insta.createInstance(AdeOutboxBridgeContribution));

		await adeEditors.openAgent(agent.agent_id, { projectId: snap.meta.project_id });
		assert.strictEqual((group1.editors[0] as ChatEditorInput).sessionResource?.toString(), `aexus-kilo:/ade-${snap.meta.project_id}-${agent.agent_id}`);

		// Edit 1: kilo -> claude
		await controlCenter.uiEditAgent({
			projectId: snap.meta.project_id,
			agentId: agent.agent_id,
			engine: 'claude',
		});
		const staleClaudeSnap = await controlCenter.getProjectSnapshot(snap.meta.project_id);

		// Immediately Edit 2 while Edit 1's async meta sync & activateById are still in-flight: claude -> pi
		await new Promise<void>(r => setTimeout(r, 8));
		await controlCenter.uiEditAgent({
			projectId: snap.meta.project_id,
			agentId: agent.agent_id,
			engine: 'pi',
		});

		await bridge.flushOutboxForTest();
		await new Promise<void>(r => setTimeout(r, 90));

		const expectedPiUri = `aexus-pi:/ade-${snap.meta.project_id}-${agent.agent_id}`;
		assert.strictEqual(group1.editors.length, 1);
		assert.strictEqual((group1.editors[0] as ChatEditorInput).sessionResource?.toString(), expectedPiUri, 'Open tab must strictly converge to aexus-pi');
		assert.strictEqual(syncedEngines.at(-1), 'pi', 'Trailing coalesced meta sync must converge on pi');

		// Even if a delayed caller passes staleClaudeSnap afterwards, authoritative reconciliation must keep aexus-pi!
		await adeEditors.rebindUnstartedAgentEditors(snap.meta.project_id, staleClaudeSnap);
		assert.strictEqual((group1.editors[0] as ChatEditorInput).sessionResource?.toString(), expectedPiUri, 'Stale claude snapshot must NEVER revert aexus-pi back to aexus-claude');
	});

	test('[Defect B-R2 #3] rebindUnstartedAgentEditors rebinds orphaned aexus-kilo tab in-place to aexus-claude even when authoritative snapshot already has session_started = true', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const snap = await controlCenter.createProject({
			folderUri: URI.file('/workspace/br2-started').toString(),
			name: 'Started Rebind Project',
		});
		const agent = await controlCenter.uiCreateAgent({
			projectId: snap.meta.project_id,
			parentId: null,
			level: 1,
			name: 'Locked Claude Lead',
			roleSummary: 'L1',
			host: 'local',
			engine: 'kilo',
			model: 'claude-sonnet-4-6',
			effort: 'medium',
		});

		const onActiveChange = store.add(new Emitter<void>());
		const group1 = new FakeGroupWithReplace(1, () => onActiveChange.fire());
		const clearedUris: string[] = [];
		const chatService = upcastPartial<IChatService & { clearSession(uri: URI): void }>({
			clearSession: (uri: URI) => { clearedUris.push(uri.toString()); },
			removeHistoryEntry: async () => { },
		});
		const editorGroupsService = upcastPartial<IEditorGroupsService>({
			mainPart: upcastPartial<IEditorGroupsService['mainPart']>({
				get activeGroup() { return group1 as unknown as IEditorGroup; },
				get groups() { return [group1] as unknown as readonly IEditorGroup[]; },
				findGroup: () => undefined,
				addGroup: (_loc: IEditorGroup | number, _dir: GroupDirection) => group1 as unknown as IEditorGroup,
			}),
		});
		const editorService = upcastPartial<IEditorService>({
			onDidActiveEditorChange: onActiveChange.event,
			get activeEditor() { return group1.activeEditor ?? undefined; },
			openEditor: (async (input: EditorInput) => {
				if (!group1.editors.includes(input)) {
					group1.editors.push(input);
				}
				group1.activeEditor = input;
				onActiveChange.fire();
				return undefined;
			}) as unknown as IEditorService['openEditor'],
			closeEditors: async (targets: readonly { editor: EditorInput; groupId: number }[]) => {
				for (const t of targets) {
					const idx = group1.editors.indexOf(t.editor);
					if (idx >= 0) {
						group1.editors.splice(idx, 1);
					}
					if (!t.editor.isDisposed()) {
						t.editor.dispose();
					}
				}
				onActiveChange.fire();
			},
		});

		const insta = workbenchInstantiationService(undefined, store);
		insta.stub(IAdeControlCenterService, controlCenter);
		insta.stub(IChatService, chatService);
		insta.stub(IEditorGroupsService, editorGroupsService);
		insta.stub(IEditorService, editorService);
		insta.stub(IWorkbenchModeService, upcastPartial<IWorkbenchModeService>({
			mode: 'ade',
			onDidChangeMode: Event.None,
		}));
		insta.stub(IExtensionService, upcastPartial<IExtensionService>({
			activateById: async () => { },
		}));

		const projectsService = store.add(insta.createInstance(AdeProjectsService));
		insta.stub(IAdeProjectsService, projectsService);
		await projectsService.whenReady();

		const adeEditors = store.add(insta.createInstance(AdeEditorService));
		insta.stub(IAdeEditorService, adeEditors);
		store.add({
			dispose: () => {
				for (const e of [...group1.editors]) {
					if (!e.isDisposed()) {
						e.dispose();
					}
				}
				group1.editors.length = 0;
			},
		});

		// Manually place a stale orphaned `aexus-kilo:/ade-...` ChatEditorInput in the group while
		// authoritative snapshot already transitioned to `engine = 'claude', session_started = true`!
		const orphanKiloUri = URI.parse(`aexus-kilo:/ade-${snap.meta.project_id}-${agent.agent_id}`);
		const orphanKiloTab = insta.createInstance(AdeLineageChatEditorInput, orphanKiloUri, {
			title: { preferred: agent.name, override: agent.name },
		});
		group1.editors.push(orphanKiloTab);
		group1.activeEditor = orphanKiloTab;

		await controlCenter.uiEditAgent({
			projectId: snap.meta.project_id,
			agentId: agent.agent_id,
			engine: 'claude',
		});
		await controlCenter.markAgentSessionStarted(snap.meta.project_id, agent.agent_id, {
			sessionResource: `aexus-claude:/ade-${snap.meta.project_id}-${agent.agent_id}`,
			nativeSessionId: 'claude_live_ses_99',
		});
		const startedSnap = await controlCenter.getProjectSnapshot(snap.meta.project_id);
		assert.strictEqual(startedSnap?.agents[0].engine, 'claude');
		assert.strictEqual(startedSnap?.agents[0].session_started, true);

		await adeEditors.rebindUnstartedAgentEditors(snap.meta.project_id, startedSnap);

		assert.strictEqual(group1.editors.length, 1);
		const activeRebound = group1.editors[0] as ChatEditorInput;
		assert.strictEqual(activeRebound.sessionResource?.toString(), `aexus-claude:/ade-${snap.meta.project_id}-${agent.agent_id}`);
		assert.strictEqual(orphanKiloTab.isDisposed(), true, 'Orphaned aexus-kilo tab must be disposed even when session_started is already true');
		assert.strictEqual(clearedUris.includes(orphanKiloUri.toString()), true);
	});

	test('[Wave 8 Hotfix Track B] AdeOpenChatTicketScheduler samples candidateStartedSeq before markAgentSessionStarting so steer arriving during starting window strictly preempts ahead of queue without dropping queue', async () => {
		const scheduler = new AdeOpenChatTicketScheduler();
		store.add({ dispose: () => scheduler.abortForWindowDispose() });

		const claudeUri = URI.parse('aexus-claude:/ade-proj_w8-agent_claude');
		const sessionChange = store.add(new Emitter<{ kind: 'completedRequest' | 'removeRequest' }>());
		let activeTurnDeferred: DeferredPromise<void> | undefined;
		let lastPromptText = '';
		const sentTicketOrder: string[] = [];

		const chatService = upcastPartial<IChatService>({
			getSession: (resource: URI) => {
				if (resource.toString() !== claudeUri.toString()) {
					return undefined;
				}
				const busy = Boolean(activeTurnDeferred && !activeTurnDeferred.isSettled);
				return upcastPartial<IChatModel>({
					sessionResource: claudeUri,
					lastRequest: lastPromptText ? ({
						id: `req_w8_${sentTicketOrder.length}`,
						message: { text: lastPromptText },
						response: {
							isComplete: !busy,
							onDidChange: Event.None,
						},
					} as unknown as IChatModel['lastRequest']) : undefined,
					hasActiveRequest: constObservable(busy),
					requestInProgress: constObservable(busy),
					onDidDispose: Event.None,
					onDidChange: sessionChange.event as unknown as IChatModel['onDidChange'],
				});
			},
			sendRequest: (async (_resource: URI, message: string): Promise<ChatSendResult> => {
				lastPromptText = message;
				const match = /ticket_id:\s*([^\s|]+)/.exec(message);
				sentTicketOrder.push(match ? match[1] : message);
				const def = new DeferredPromise<void>();
				activeTurnDeferred = def;
				return {
					kind: 'sent',
					data: {
						responseCreatedPromise: def.p.then(() => undefined),
						responseCompletePromise: def.p.finally(() => {
							sessionChange.fire({ kind: 'completedRequest' });
						}),
					},
				} as unknown as ChatSendResult;
			}) as IChatService['sendRequest'],
			cancelCurrentRequestForSession: async () => {
				activeTurnDeferred?.complete();
			},
		});

		const firstStartingEntered = new DeferredPromise<void>();
		const firstStartingGate = new DeferredPromise<void>();
		let startingCallCount = 0;

		const controlCenter = upcastPartial<IAdeControlCenterService>({
			markAgentSessionStarting: async () => {
				startingCallCount++;
				if (startingCallCount === 1) {
					firstStartingEntered.complete();
					await firstStartingGate.p;
				}
			},
		});

		const queueTicket = formatAdeTicketDeliveryPayload({
			fromId: 'agent_l1',
			ticketId: 'tk_w8_queue_1',
			taskId: 'tsk_w8_1',
			taskType: 'dev',
			needReturn: true,
			hasDetailRef: false,
			hasHistoryRef: false,
			taskTitle: 'Queued task',
			summary: 'Queue item popped before steer arrives',
		});
		const steerTicket = formatAdeTicketDeliveryPayload({
			fromId: 'agent_l1',
			ticketId: 'tk_w8_steer_1',
			taskId: 'tsk_w8_2',
			taskType: 'dev',
			needReturn: true,
			hasDetailRef: false,
			hasHistoryRef: false,
			taskTitle: 'Urgent steer',
			summary: 'Steer item arriving while markAgentSessionStarting is suspended',
		});

		let queueSettled = false;
		const pQueue = scheduler.dispatchTicket(
			{
				sessionUri: claudeUri,
				payloadText: queueTicket,
				deliveryMode: 'queue',
				projectId: 'proj_w8',
				agentId: 'agent_claude',
				engine: 'claude',
				ticketId: 'tk_w8_queue_1',
				taskId: 'tsk_w8_1',
			},
			chatService,
			controlCenter,
		).then(res => {
			queueSettled = true;
			return res;
		});

		await firstStartingEntered.p;
		// Enqueue `steer` during `markAgentSessionStarting` pending window!
		const pSteer = scheduler.dispatchTicket(
			{
				sessionUri: claudeUri,
				payloadText: steerTicket,
				deliveryMode: 'steer',
				projectId: 'proj_w8',
				agentId: 'agent_claude',
				engine: 'claude',
				ticketId: 'tk_w8_steer_1',
				taskId: 'tsk_w8_2',
			},
			chatService,
			controlCenter,
		);

		firstStartingGate.complete();
		await new Promise<void>(r => setTimeout(r, 15));

		assert.deepStrictEqual(sentTicketOrder, ['tk_w8_steer_1'], 'Steer arriving in markAgentSessionStarting window must execute BEFORE queue');
		assert.strictEqual(queueSettled, false, 'Queue item MUST NOT prematurely complete({ ok: true, stopped: true }) before running');
		assert.strictEqual(scheduler.getQueuedCount('proj_w8', 'agent_claude'), 1, 'Queue item must remain parked in state.queue behind steer');

		// Complete `steer` turn -> `queue` turn must now execute and complete normally!
		activeTurnDeferred?.complete();
		const steerRes = await pSteer;
		assert.strictEqual(steerRes.ok, true);
		assert.strictEqual(Boolean(steerRes.stopped), false);

		await new Promise<void>(r => setTimeout(r, 15));
		assert.deepStrictEqual(sentTicketOrder, ['tk_w8_steer_1', 'tk_w8_queue_1'], 'Queue item must execute immediately after steer finishes');
		assert.strictEqual(queueSettled, false);

		activeTurnDeferred?.complete();
		const queueRes = await pQueue;
		assert.strictEqual(queueRes.ok, true);
		assert.strictEqual(Boolean(queueRes.stopped), false, 'Queue item must complete normally without stopped:true');
	});
});
