/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ADE_CONTROL_EXECUTE_COMMAND_ID,
	ADE_GET_ROLE_SYNC_SNAPSHOT_COMMAND_ID,
	ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID,
	IAdeRoleSyncSnapshot,
} from '../../../../../platform/ade/common/adeControl.js';
import { IAdeCloudHost, IAdeCloudHostBackendService } from '../../../../../platform/ade/common/adeCloudHosts.js';
import {
	IAdeDeterministicCheckRequest,
	IAdeDeterministicCheckResponse,
	IAdeEngineeringBackendService,
	IAdeInboxService,
	IAdeWatchdogWakeupEvent,
} from '../../../../../platform/ade/common/adeEngineering.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IEditorService, SIDE_GROUP } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchModeService } from '../../../../services/workbenchMode/common/workbenchMode.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../../files/browser/projectNavigationService.js';
import '../../browser/adeControlHandler.js';
import { AdeInboxService } from '../../browser/adeInboxService.js';
import { AdeMissionRuntimeService, IAdeMissionRuntimeService } from '../../browser/adeMissionRuntime.js';
import { AdeMissionStoreService, IAdeMissionService } from '../../browser/adeMissionStore.js';
import { AdeProjectsService } from '../../browser/adeProjectsService.js';
import { IAdeEngineSession, IAdeSessionsService } from '../../browser/adeSessionsService.js';
import { IAdeAgent, IAdeEditorService, IAdeProjectsService } from '../../common/ade.js';
import { AdeRoleSchemaService, IAdeRoleSchemaService } from '../../common/adeRoleSchemaService.js';

suite('ADE Control Plane & Runtime Contracts (C2-C6, Parity & Security)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const alpha = URI.file('/projects/Alpha');

	function createHarness() {
		const instantiation = workbenchInstantiationService(undefined, store);
		let folders = [toWorkspaceFolder(alpha)];
		const workspace = new Workspace('ade-contracts-test', folders);
		const onFoldersChanged = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		instantiation.stub(IWorkspaceContextService, {
			getWorkspace: () => new Workspace(workspace.id, folders),
			onDidChangeWorkspaceFolders: onFoldersChanged.event,
		});
		instantiation.stub(IWorkspaceEditingService, new class extends mock<IWorkspaceEditingService>() {
			override async addFolders(toAdd: { uri: URI }[]): Promise<void> {
				folders = [...folders, ...toAdd.map(i => toWorkspaceFolder(i.uri))];
				onFoldersChanged.fire({ added: [], removed: [], changed: [] });
			}
		}());

		const navigation = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, navigation);
		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, projects);
		const roleSchema = store.add(instantiation.createInstance(AdeRoleSchemaService));
		instantiation.stub(IAdeRoleSchemaService, roleSchema);

		const watchdogWakeupEmitter = store.add(new Emitter<IAdeWatchdogWakeupEvent>());
		const deterministicCheckCalls: IAdeDeterministicCheckRequest[] = [];
		let nextCheckPasses = true;
		const backendStub: IAdeEngineeringBackendService = {
			_serviceBrand: undefined,
			onDidWatchdogWakeup: watchdogWakeupEmitter.event,
			loadInbox: async () => [],
			saveInbox: async () => undefined,
			syncApiDocs: async () => ({
				docsRoot: '/tmp/docs',
				commonDoc: '/tmp/docs/COMMON_API.md',
				engineeringDoc: '/tmp/docs/ENGINEERING.md',
				paradigmDoc: '/tmp/docs/PARADIGM.md',
				engineeringApiDoc: '/tmp/docs/ENGINEERING_API.md',
				ranksDir: '/tmp/docs/ranks',
				missionDir: '/tmp/docs/mission',
				missionDoc: '/tmp/docs/mission/MISSION_API.md',
				manifestFile: '/tmp/docs/api-manifest.json',
				rankDocs: {},
			}),
			readApiDoc: async () => ({ ok: true, target: 'common', revision: 1, content: '# Docs' }),
			syncMissionWatchdog: async () => undefined,
			removeMissionWatchdog: async () => undefined,
			runDeterministicCheck: async req => {
				deterministicCheckCalls.push(req);
				return {
					checkId: req.checkId,
					name: req.name,
					command: req.command,
					hostAlias: req.hostAlias ?? 'local',
					passed: nextCheckPasses,
					exitCode: nextCheckPasses ? 0 : 1,
					expectedExitCode: req.expectExitCode ?? 0,
					durationMs: 12,
					outputTail: nextCheckPasses ? 'OK' : 'FAIL',
					...(nextCheckPasses ? {} : { error: 'Mock check failed' }),
				} satisfies IAdeDeterministicCheckResponse;
			},
		};
		instantiation.stub(IAdeEngineeringBackendService, backendStub);

		const inbox = store.add(instantiation.createInstance(AdeInboxService));
		instantiation.stub(IAdeInboxService, inbox);
		const missions = store.add(instantiation.createInstance(AdeMissionStoreService));
		instantiation.stub(IAdeMissionService, missions);

		let sessionSeq = 0;
		const sessionsStub: IAdeSessionsService = {
			_serviceBrand: undefined,
			onDidChangeEngines: Event.None,
			getIcon: () => Codicon.hubot,
			getEngineName: () => 'Claude Code',
			getEngines: async () => [{ id: 'aexus-claude', name: 'Claude Code', description: 'Claude', icon: Codicon.hubot }],
			create: async (engineId: string, projectUri: URI): Promise<IAdeEngineSession> => ({
				engineId,
				resource: URI.parse(`${engineId}:/s-${++sessionSeq}`),
				projectUri,
				label: `Session ${sessionSeq}`,
			}),
			list: async () => [],
			rename: async () => undefined,
			stop: async () => undefined,
			delete: async () => undefined,
			deleteProjectSessions: async () => 0,
		};
		instantiation.stub(IAdeSessionsService, sessionsStub);

		const openedEditorInputs: Array<{ resource?: string; group?: unknown }> = [];
		instantiation.stub(IEditorService, {
			openEditor: async (editor: { resource?: URI }, group?: unknown) => {
				openedEditorInputs.push({ resource: editor?.resource?.toString(), group });
				return undefined;
			},
		} as unknown as IEditorService);

		const adeOpenedFiles: string[] = [];
		const editorsStub: IAdeEditorService = {
			_serviceBrand: undefined,
			activeEditor: undefined,
			isSessionActive: () => false,
			openAgent: async () => undefined,
			openSecretary: async () => undefined,
			closeAgents: async (_agents: readonly IAdeAgent[]) => undefined,
			openFile: async (resource: URI) => { adeOpenedFiles.push(resource.toString()); },
			openDiff: async (_a: URI, _b: URI, _l?: string, _p?: URI, _o?: IEditorOptions) => undefined,
		};
		instantiation.stub(IAdeEditorService, editorsStub);

		const hosts: IAdeCloudHost[] = [{
			id: 'h-gpu1',
			name: 'GPU Node 1',
			alias: 'gpu-1',
			hostName: '10.0.0.10',
			user: 'dev',
			port: 22,
			os: 'linux',
			source: 'user',
			defaultDirectory: '/workspace',
			recentDirectories: ['/workspace'],
			createdAt: 1000,
			updatedAt: 1000,
		}];
		instantiation.stub(IAdeCloudHostBackendService, {
			_serviceBrand: undefined,
			onDidChangeHosts: Event.None,
			listHosts: async () => hosts,
			getHost: async (idOrAlias: string) => hosts.find(h => h.id === idOrAlias || h.alias === idOrAlias),
			upsertHost: async () => hosts[0],
			removeHost: async () => true,
			testConnection: async () => ({ ok: true, latencyMs: 5, hostAlias: 'gpu-1' }),
			listDirectory: async () => ({ path: '/workspace', entries: [] }),
			detectEngines: async () => [],
			syncSshConfig: async () => undefined,
		} as unknown as IAdeCloudHostBackendService);

		const dispatchedTurns: Array<{ resource: string; prompt: string; meta?: Record<string, unknown> }> = [];
		instantiation.stub(ICommandService, {
			onWillExecuteCommand: Event.None,
			onDidExecuteCommand: Event.None,
			executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
				if (id === 'aexus.agentEngines.dispatchEngineeringTurn') {
					dispatchedTurns.push({
						resource: String(args[0]),
						prompt: String(args[1]),
						meta: args[2] as Record<string, unknown>,
					});
					return { reply: 'ack' } as T;
				}
				const registered = CommandsRegistry.getCommand(id);
				if (registered) {
					return instantiation.invokeFunction(registered.handler, ...args) as T;
				}
				return undefined as T;
			},
		});

		const runtime = store.add(instantiation.createInstance(AdeMissionRuntimeService));
		instantiation.stub(IAdeMissionRuntimeService, runtime);
		instantiation.get(IWorkbenchModeService).setMode('ade');
		navigation.enterProject(alpha);

		return {
			instantiation,
			projects,
			missions,
			runtime,
			inbox,
			watchdogWakeupEmitter,
			dispatchedTurns,
			deterministicCheckCalls,
			openedEditorInputs,
			adeOpenedFiles,
			setNextCheckPasses: (v: boolean) => { nextCheckPasses = v; },
			resolvePrompt: (target: URI | string | { agentId?: string; resource?: string | URI; mode?: 'delta' }) =>
				instantiation.invokeFunction(CommandsRegistry.getCommand(ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID)!.handler, target) as unknown as string | undefined,
			getRoleSyncSnapshot: () =>
				instantiation.invokeFunction(CommandsRegistry.getCommand(ADE_GET_ROLE_SYNC_SNAPSHOT_COMMAND_ID)!.handler) as unknown as IAdeRoleSyncSnapshot,
			control: <T = unknown>(action: string, params?: Record<string, unknown>) =>
				instantiation.invokeFunction(CommandsRegistry.getCommand(ADE_CONTROL_EXECUTE_COMMAND_ID)!.handler, { action, params }) as unknown as Promise<T>,
		};
	}

	test('C2 KV-cache staticRoleHash invariance across supervisor/label mutations & Secretary static-prefix ordering', async () => {
		const h = createHarness();
		const gov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/gov') }, 'CTO Alpha', { role: 'governor' });
		const mgr = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/mgr') }, 'Mgr Initial', { parentId: gov.id, role: 'manager' });
		h.projects.configureSecretary({ engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/sec') });

		const snap1 = h.getRoleSyncSnapshot();
		const entry1 = snap1.agents.find(e => e.id === mgr.id);
		assert.ok(entry1?.staticRoleCharter && entry1.staticRoleCharter.length > 40);
		assert.ok(entry1?.staticRoleHash && entry1.staticRoleHash.length >= 16);

		// Rename both supervisor and agent label -> staticRoleCharter & staticRoleHash MUST remain byte-identical!
		h.projects.renameAgent(gov.id, 'CTO Renamed Beta');
		h.projects.renameAgent(mgr.id, 'Mgr Renamed Gamma');
		const snap2 = h.getRoleSyncSnapshot();
		const entry2 = snap2.agents.find(e => e.id === mgr.id);
		assert.strictEqual(entry2?.staticRoleHash, entry1?.staticRoleHash);
		assert.strictEqual(entry2?.staticRoleCharter, entry1?.staticRoleCharter);
		assert.notStrictEqual(entry2?.rolePrompt, entry1?.rolePrompt, 'Dynamic Live Role Bindings tail must reflect new names');

		// Secretary prompt puts static Charter/CLI FIRST and Live Viewport Snapshot LAST, with fixed role set-tier syntax
		const secPrompt = h.resolvePrompt(URI.parse('aexus-claude:/sec')) ?? '';
		const cliIdx = secPrompt.indexOf('Complete ADE Macro Control CLI');
		const viewportIdx = secPrompt.indexOf('- Live Viewport Snapshot:');
		assert.ok(cliIdx > 0 && viewportIdx > cliIdx, 'Secretary static charter & CLI must strictly precede Live Viewport Snapshot');
		assert.ok(secPrompt.includes('role set-tier <sessionId> <rankId|worker|none>'));
	});

	test('C3/C4/C5/C6 renderer control plane: slicing, completionContract, scopePaths, diagnostics, checkpoints, barrier expiry, 3-nudge escalation, and parity', async () => {
		const h = createHarness();
		const lead = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/lead') }, 'Chief Lead', { role: 'governor' });
		const devA = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/deva') }, 'Dev A', { parentId: lead.id, role: 'employee' });
		const devB = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/devb') }, 'Dev B', { parentId: lead.id, role: 'employee' });
		const outsider = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/out') }, 'Outsider', { parentId: lead.id, role: 'employee' });

		const created = await h.control<{ readonly id: string }>('mission.create', {
			title: 'Renderer Contracts Mission',
			ownerSessionId: lead.id,
			mermaid: 'flowchart LR\n  T1[Implement]\n  T2[Review]\n  T1 --> T2',
		});
		const missionId = created.id;
		await h.control('orchestration.apply', {
			mission: missionId,
			text: [
				'flowchart LR',
				'  subgraph Core',
				'    Lead[L1: Chief Lead]',
				'    DevA[L3: Dev A]',
				'    DevB[L3: Dev B]',
				'    WB_CORE[("Core Spec")]',
				'  end',
				'  Lead <--> DevA',
				'  Lead <--> DevB',
				'  Lead -.-> WB_CORE',
				`%% staff Lead [agent=${lead.id}]`,
				`%% staff DevA [agent=${devA.id} allowed_paths=src/auth/**]`,
				`%% staff DevB [agent=${devB.id} allowed_paths=src/auth/**,src/api/**]`,
				'%% whiteboard WB_CORE [dept=Core]',
			].join('\n'),
		});

		const orchInit = h.runtime.getOrchestrationState(missionId);
		const devAId = orchInit.nodeAgentIds.DevA || devA.id;

		// Multi-tenant mission.list: outsider does NOT see Core mission, while devAId sees it with live status
		const listOutsider = await h.control<ReadonlyArray<{ readonly id: string }>>('mission.list', {
			caller: 'employee',
			_verifiedCaller: true,
			_callerSessionId: outsider.id,
		});
		assert.strictEqual(listOutsider.some(m => m.id === missionId), false);

		const listMember = await h.control<ReadonlyArray<{ readonly id: string; readonly orchestrationStatus?: string }>>('mission.list', {
			caller: 'employee',
			_verifiedCaller: true,
			_callerSessionId: devAId,
		});
		const memberEntry = listMember.find(m => m.id === missionId);
		assert.ok(memberEntry);

		// C3: whiteboard.write --section & whiteboard.read unsliced vs sliced
		await h.control('whiteboard.write', {
			mission: missionId,
			id: 'WB_CORE',
			content: '## Architecture\n\nModular design.\n\n## API\n\nGET /health\n',
		});
		await h.control('whiteboard.write', {
			mission: missionId,
			id: 'WB_CORE',
			section: 'API',
			content: 'GET /health\nPOST /tokens',
		});
		const fullWb = await h.control<{ readonly whiteboard: { readonly content: string }; readonly slice?: unknown }>('whiteboard.read', {
			mission: missionId,
			id: 'WB_CORE',
		});
		assert.strictEqual(fullWb.slice, undefined, 'Unsliced whiteboard.read must omit slice metadata');
		assert.ok(fullWb.whiteboard.content.includes('Modular design.'));
		assert.ok(fullWb.whiteboard.content.includes('POST /tokens'));

		const tocWb = await h.control<{ readonly slice?: { readonly headings?: ReadonlyArray<{ readonly title: string }>; readonly isPartialSlice?: boolean } }>('whiteboard.read', {
			mission: missionId,
			id: 'WB_CORE',
			toc: true,
		});
		assert.strictEqual(tocWb.slice?.isPartialSlice, true);
		assert.ok((tocWb.slice?.headings ?? []).some(hd => hd.title === 'Architecture'));

		// C4: completionContract + check-gating on mission.task.complete
		await h.control('mission.check.set', {
			mission: missionId,
			node: 'T1',
			cmd: 'echo ok',
		});
		await h.control('mission.task.update', {
			mission: missionId,
			node: 'T1',
			requireChecksPassed: true,
			minSummaryChars: 15,
		});
		h.setNextCheckPasses(false);
		await assert.rejects(
			() => h.control('mission.task.complete', { mission: missionId, node: 'T1', note: 'Complete with enough evidence text' }),
			/AUTOMATED_CHECK_FAILED|COMPLETION_CONTRACT_UNMET/i,
		);
		h.setNextCheckPasses(true);
		const completedT1 = await h.control<{ readonly ok: boolean }>('mission.task.complete', {
			mission: missionId,
			node: 'T1',
			note: 'All auth routes implemented and passing tests.',
		});
		assert.strictEqual(completedT1.ok, true);
		assert.ok(h.deterministicCheckCalls.length >= 2);

		// C5: orchestration.dispatch with refPtrs + token.mint scopePaths overlap rejection
		const disp = await h.control<{ readonly tokenId: string }>('orchestration.dispatch', {
			mission: missionId,
			target: 'Lead',
			prompt: 'Run parallel feature wave',
			refPtrs: ['wb:WB_CORE'],
		});
		await assert.rejects(
			() => h.control('token.mint', {
				mission: missionId,
				tokenId: disp.tokenId,
				conflictPolicy: 'reject',
				branches: [
					{ toNodeId: 'DevA', summary: 'Auth A', scopePaths: ['src/auth/**'] },
					{ toNodeId: 'DevB', summary: 'Auth B', scopePaths: ['src/auth/jwt.ts'] },
				],
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: lead.id,
			}),
			/SCOPE_CONFLICT|overlap/i,
		);

		const deadlineAt = Date.now() + 3_000;
		const minted = await h.control<{ readonly joinBarrierId: string; readonly mintedTokenIds: readonly string[] }>('token.mint', {
			mission: missionId,
			tokenId: disp.tokenId,
			conflictPolicy: 'reject',
			waitJoin: true,
			deadlineAt,
			branches: [
				{ toNodeId: 'DevA', summary: 'Auth', scopePaths: ['src/auth/**'] },
				{ toNodeId: 'DevB', summary: 'API', scopePaths: ['src/api/**'] },
			],
			caller: 'governor',
			_verifiedCaller: true,
			_callerSessionId: lead.id,
		});
		assert.ok(minted.joinBarrierId);

		// FinOps telemetry on recordNodeTurnUsage
		h.runtime.recordNodeTurnUsage(missionId, 'DevA', {
			inputTokens: 1000,
			outputTokens: 200,
			cacheReadTokens: 3000,
			costUsd: 0.05,
			model: 'claude-sonnet-4',
		});
		const orchAfterUsage = h.runtime.getOrchestrationState(missionId);
		assert.ok(orchAfterUsage.finOpsTelemetry && orchAfterUsage.finOpsTelemetry.cacheHitRatePct > 0);

		// C6: mission.diagnostics + checkpoint RBAC & restore
		const diag = await h.control<{ readonly ok: boolean; readonly grade: string }>('mission.diagnostics', {
			mission: missionId,
			caller: 'employee',
			_verifiedCaller: true,
			_callerSessionId: devAId,
		});
		assert.strictEqual(diag.ok, true);
		assert.ok(diag.grade);

		await assert.rejects(
			() => h.control('mission.checkpoint.create', {
				mission: missionId,
				label: 'blocked-l3',
				caller: 'employee',
				_verifiedCaller: true,
				_callerSessionId: devAId,
			}),
			/Permission denied|FORBIDDEN|not allowed|authority/i,
		);
		const ckpt = await h.control<{ readonly checkpoint: { readonly id: string } }>('mission.checkpoint.create', {
			mission: missionId,
			label: 'before-timeout',
			caller: 'governor',
			_verifiedCaller: true,
			_callerSessionId: lead.id,
		});

		// Fire 3 consecutive silence nudges on DevA's baton -> 3rd nudge auto-escalates to Lead
		const devATokId = minted.mintedTokenIds[0];
		const turnsBeforeEscalation = h.dispatchedTurns.length;
		for (let i = 1; i <= 3; i++) {
			h.watchdogWakeupEmitter.fire({
				missionId,
				tokenId: devATokId,
				nodeId: 'DevA',
				reason: 'silence_timeout',
				detail: `silent #${i}`,
				timestamp: Date.now() + i * 60_000,
			});
			await new Promise(r => setTimeout(r, 15));
		}
		assert.ok(
			h.dispatchedTurns.slice(turnsBeforeEscalation).some(t => t.prompt.includes('Engineering Escalation') && t.prompt.includes('DevA')),
			'3rd consecutive silence watchdog nudge must auto-escalate to superior',
		);

		// Fire barrier_deadline_expired -> expires barrier & wakes Lead
		h.watchdogWakeupEmitter.fire({
			missionId,
			tokenId: disp.tokenId,
			nodeId: 'Lead',
			reason: 'barrier_deadline_expired',
			barrierId: minted.joinBarrierId,
			detail: 'Join barrier deadline expired',
			timestamp: deadlineAt + 500,
		});
		await new Promise(r => setTimeout(r, 20));
		const stateAfterExpiry = h.runtime.getOrchestrationState(missionId);
		assert.strictEqual(stateAfterExpiry.joinBarriers?.[minted.joinBarrierId]?.timedOut, true);
		assert.strictEqual(stateAfterExpiry.tokens[disp.tokenId]?.status, 'active');

		// Checkpoint diff & restore preserving monotonic totalCostUsd
		const diff = await h.control<{ readonly diff: { readonly barrierChanges: ReadonlyArray<{ readonly barrierId: string }> } }>('mission.checkpoint.diff', {
			mission: missionId,
			id: ckpt.checkpoint.id,
		});
		assert.ok(diff.diff.barrierChanges.some(b => b.barrierId === minted.joinBarrierId));

		const restored = await h.control<{ readonly ok: boolean; readonly preRestoreCheckpointId?: string }>('mission.checkpoint.restore', {
			mission: missionId,
			id: ckpt.checkpoint.id,
			mode: 'full',
		});
		assert.strictEqual(restored.ok, true);
		assert.ok(restored.preRestoreCheckpointId);
		const stateAfterRestore = h.runtime.getOrchestrationState(missionId);
		assert.strictEqual(stateAfterRestore.joinBarriers?.[minted.joinBarrierId]?.status, 'waiting');
		assert.ok((stateAfterRestore.totalCostUsd ?? 0) >= 0.05, 'FinOps totalCostUsd must remain monotonic across checkpoint restore');

		// Parity checks: host.info alias, orchestration.limits read-only for L3, project.openFile side: true
		const hostInfo = await h.control<{ readonly alias: string }>('host.info', { host: 'gpu-1' });
		assert.strictEqual(hostInfo.alias, 'gpu-1');

		const limitsRead = await h.control<{ readonly ok: boolean }>('orchestration.limits', {
			mission: missionId,
			caller: 'employee',
			_verifiedCaller: true,
			_callerSessionId: devAId,
		});
		assert.strictEqual(limitsRead.ok, true);
		await assert.rejects(
			() => h.control('orchestration.limits', {
				mission: missionId,
				maxHops: 99,
				caller: 'employee',
				_verifiedCaller: true,
				_callerSessionId: devAId,
			}),
			/Permission denied|FORBIDDEN|authority/i,
		);

		await h.control('project.openFile', { path: '/projects/Alpha/README.md', side: true });
		assert.ok(
			h.openedEditorInputs.some(e => e.resource?.endsWith('/README.md') && e.group === SIDE_GROUP),
			'project.openFile with side: true must open in SIDE_GROUP',
		);

		// org.context default limit 6 and recentTraces cap <= 5
		const orgCtx = await h.control<{ readonly agentId: string; readonly nodeId?: string; readonly recentTraces?: ReadonlyArray<unknown> }>('org.context', {
			target: devAId,
			caller: 'governor',
			_verifiedCaller: true,
			_callerSessionId: lead.id,
		});
		assert.strictEqual(orgCtx.agentId, devAId);
		assert.strictEqual(orgCtx.nodeId, 'DevA');
		assert.ok((orgCtx.recentTraces?.length ?? 0) <= 5);

		// Stage 3 regressions:
		// (a) Renderer multi-tenant inbox isolation
		const otherGov = h.projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/gov-b') }, 'Other Gov', { role: 'governor' });
		const inbLead = await h.control<{ readonly id: string }>('inbox.post', {
			title: 'Lead Update',
			message: 'Private to Lead',
			caller: 'governor',
			_verifiedCaller: true,
			_callerSessionId: lead.id,
		});
		const inbOther = await h.control<{ readonly id: string }>('inbox.post', {
			title: 'Other Gov Secret',
			message: 'Private to Other Gov',
			caller: 'governor',
			_verifiedCaller: true,
			_callerSessionId: otherGov.id,
		});
		const leadInbox = await h.control<ReadonlyArray<{ readonly id: string }>>('inbox.list', {
			caller: 'governor',
			_verifiedCaller: true,
			_callerSessionId: lead.id,
		});
		assert.strictEqual(leadInbox.some(i => i.id === inbLead.id), true);
		assert.strictEqual(leadInbox.some(i => i.id === inbOther.id), false, 'Lead must not see Other Gov inbox items');
		await assert.rejects(
			() => h.control('inbox.resolve', {
				id: inbOther.id,
				resolution: 'blocked',
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: lead.id,
			}),
			/FORBIDDEN/i,
		);
		await h.control('inbox.markRead', {
			all: true,
			caller: 'governor',
			_verifiedCaller: true,
			_callerSessionId: lead.id,
		});
		const allInboxAsHuman = await h.control<ReadonlyArray<{ readonly id: string; readonly unread: boolean }>>('inbox.list', {});
		assert.strictEqual(allInboxAsHuman.find(i => i.id === inbLead.id)?.unread, false);
		assert.strictEqual(allInboxAsHuman.find(i => i.id === inbOther.id)?.unread, true, 'Tenant markRead --all must not clear foreign unread items');

		// (b) mission.check.run persists IMissionTaskCheckReceipt and mission.task.list/get expose completionContract & lastCheckReceipt
		await h.control('mission.check.set', { mission: missionId, node: 'T2', cmd: 'echo ok' });
		await h.control('mission.task.update', { mission: missionId, node: 'T2', requireChecksPassed: true, requireArtifact: true });
		await h.control('mission.check.run', { mission: missionId, node: 'T2' });
		const t2Detail = await h.control<{ readonly completionContract?: { readonly requireChecksPassed?: boolean; readonly requireArtifact?: boolean }; readonly lastCheckReceipt?: { readonly passed?: boolean } }>('mission.task.get', {
			mission: missionId,
			node: 'T2',
		});
		assert.strictEqual(t2Detail.completionContract?.requireChecksPassed, true);
		assert.strictEqual(t2Detail.completionContract?.requireArtifact, true);
		assert.strictEqual(t2Detail.lastCheckReceipt?.passed, true);

		// (c) Inline --artifact on token.complete --complete-task --finish on last remaining task succeeds in renderer
		const finishDisp = await h.control<{ readonly tokenId: string }>('orchestration.dispatch', {
			mission: missionId,
			target: 'Lead',
			prompt: 'Finish T2',
			taskNodeId: 'T2',
		});
		const finishedRes = await h.control<{ readonly ok: boolean; readonly finished?: boolean }>('token.complete', {
			mission: missionId,
			tokenId: finishDisp.tokenId,
			summary: 'Completed T2 with full evidence artifact.',
			artifacts: [{ title: 'Final Report', content: 'All checks passed.' }],
			completeTask: true,
			finish: true,
			caller: 'governor',
			_verifiedCaller: true,
			_callerSessionId: lead.id,
		});
		assert.strictEqual(finishedRes.ok, true);
		assert.strictEqual(finishedRes.finished, true);

		// (d) FinOps recordNodeTurnUsage never lowers orch.totalCostUsd or disarms budget circuit breaker
		await h.control('orchestration.limits', { mission: missionId, budgetLimitUsd: 0.04 });
		const beforeCost = h.runtime.getOrchestrationState(missionId).totalCostUsd ?? 0;
		h.runtime.recordNodeTurnUsage(missionId, 'DevA', { inputTokens: 100, outputTokens: 50, costUsd: 0.001, model: 'claude-sonnet-4' });
		const afterCost = h.runtime.getOrchestrationState(missionId).totalCostUsd ?? 0;
		assert.ok(afterCost >= beforeCost, 'totalCostUsd must remain strictly monotonic on subsequent turns');
		assert.strictEqual(h.runtime.getOrchestrationState(missionId).budgetCircuitTripped, true, 'Tripped budget breaker must not be disarmed by later turns');

		// (e) Live demotion to pure worker immediately revokes off-graph supervisor/owner control privileges
		h.projects.setAgentRole(otherGov.id, 'worker');
		await assert.rejects(
			() => h.control('mission.create', {
				title: 'Demoted Creation Attempt',
				caller: 'governor',
				_verifiedCaller: true,
				_callerSessionId: otherGov.id,
			}),
			/Permission denied|pure execution/i,
		);
	});
});
