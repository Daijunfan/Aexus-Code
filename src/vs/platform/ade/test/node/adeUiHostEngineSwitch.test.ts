/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import * as path from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IAdeCloudHost, IAdeCloudHostBackendService } from '../../common/adeCloudHosts.js';
import {
	AdeControlCenterChannel,
	AdeControlCenterChannelClient,
	IAdeAgentRuntimeDisposeEvent,
} from '../../common/adeControlCenterIpc.js';
import { AdeError, AdeErrorCode } from '../../common/adeModels.js';
import { AdeControlCenterService } from '../../node/adeControlCenterService.js';

async function assertRejectsAdeCode(fn: () => Promise<unknown>, expectedCode: AdeErrorCode): Promise<void> {
	let caught: unknown;
	try {
		await fn();
	} catch (err) {
		caught = err;
	}
	assert.ok(caught, `Expected call to reject with ${expectedCode}, but it resolved`);
	if (caught instanceof AdeError) {
		assert.strictEqual(caught.code, expectedCode, `Expected ${expectedCode} but got ${caught.code}: ${caught.message}`);
		return;
	}
	const msg = caught instanceof Error ? caught.message : String(caught);
	assert.ok(msg.includes(expectedCode), `Expected error containing ${expectedCode}, got: ${msg}`);
}

function createMockCloudHostService(hosts: readonly IAdeCloudHost[]): IAdeCloudHostBackendService {
	const partial: Partial<IAdeCloudHostBackendService> = {
		onDidChangeHosts: Event.None,
		listHosts: async () => [...hosts],
		getHost: async (idOrAlias: string) => hosts.find(
			h => h.id === idOrAlias || h.alias === idOrAlias || h.hostName === idOrAlias,
		),
		deleteHost: async () => true,
	};
	return partial as unknown as IAdeCloudHostBackendService;
}

suite('Track B3: Human UI uiEditAgent Live Host & Engine Switching with Safe Session Reset vs CLI Isolation', function () {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let tempDir: string;

	setup(async () => {
		const baseTmp = isWindows ? os.tmpdir() : '/tmp';
		tempDir = await fs.promises.mkdtemp(path.join(baseTmp, 'ade-b3-switch-'));
	});

	teardown(async () => {
		if (tempDir) {
			await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	test('1. Unstarted employee (session_started=0) switches host & engine via uiEditAgent (and IPC channel) with auto-probed default model and effort normalization', async () => {
		const wsDir = path.join(tempDir, 'ws-unstarted');
		await fs.promises.mkdir(wsDir, { recursive: true });

		const mockHosts: readonly IAdeCloudHost[] = [{
			id: 'host_gpu_01',
			name: 'GPU Builder',
			alias: 'gpu-box',
			hostName: '10.20.30.40',
			user: 'ubuntu',
			port: 22,
			os: 'linux',
			recentDirectories: [],
			source: 'user',
			createdAt: 1,
			updatedAt: 1,
			lastTestStatus: {
				ok: true,
				latencyMs: 5,
				checkedAt: Date.now(),
				remoteHome: '/home/ubuntu',
			},
		}];

		const svc = new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'ade-home-1'),
			socketPath: path.join(tempDir, 'cc1.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: createMockCloudHostService(mockHosts),
			customLocalEngineProber: async () => ['claude', 'codex', 'kilo'],
		});
		const localStore = new DisposableStore();
		store.add(localStore);
		localStore.add(svc);

		svc.engineProber.probeModels = async (hostRaw: string, engineRaw: string) => {
			if (hostRaw === 'local' && engineRaw === 'codex') {
				return {
					engine: 'codex',
					models: ['gpt-5.3-codex-probed', 'gpt-5-mini'],
					efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
					defaultEffort: 'medium',
				};
			}
			if ((hostRaw === '10.20.30.40' || hostRaw === 'gpu-box') && engineRaw === 'kilo') {
				return {
					engine: 'kilo',
					models: ['deepseek-remote/r2-pro', 'deepseek-remote/v3'],
					efforts: ['high', 'max'],
					defaultEffort: 'high',
				};
			}
			return svc.engineProber.getDefaultMetadata(engineRaw);
		};

		try {
			await svc.whenReady();
			const serverChannel = new AdeControlCenterChannel(svc);
			const ipcClient = new AdeControlCenterChannelClient({
				call: <T>(command: string, arg?: unknown) => serverChannel.call<T>('test-ctx', command, arg),
				listen: <T>(event: string) => serverChannel.listen<T>('test-ctx', event),
			});

			const proj = await ipcClient.createProject({
				folderUri: URI.file(wsDir).toString(),
				name: 'UnstartedSwitchProj',
			});
			const pid = proj.meta.project_id;

			const l1 = await ipcClient.uiCreateAgent({
				projectId: pid,
				parentId: null,
				level: 1,
				name: 'L1_Lead',
				roleSummary: 'Chief Architect',
				host: 'local',
				engine: 'claude',
				model: 'claude-sonnet-4-6',
				effort: 'low',
			});
			assert.strictEqual(l1.host, 'local');
			assert.strictEqual(l1.session_started, false);
			assert.strictEqual(l1.token_gen, 1);

			// Unknown host is strictly rejected with ERR_INVALID_ARGS
			await assertRejectsAdeCode(
				() => ipcClient.uiEditAgent({
					projectId: pid,
					agentId: l1.agent_id,
					host: 'unknown-cloud-host',
				}),
				'ERR_INVALID_ARGS',
			);

			// Switch engine claude -> codex on local without passing model -> auto-picks index-0 probed model
			const switchedCodex = await ipcClient.uiEditAgent({
				projectId: pid,
				agentId: l1.agent_id,
				engine: 'codex',
			});
			assert.strictEqual(switchedCodex.host, 'local');
			assert.strictEqual(switchedCodex.engine, 'codex');
			assert.strictEqual(switchedCodex.model, 'gpt-5.3-codex-probed');
			assert.strictEqual(switchedCodex.effort, 'low');
			assert.strictEqual(switchedCodex.session_started, false);
			assert.strictEqual(switchedCodex.session_resource, `aexus-codex:/ade-${pid}-${l1.agent_id}`);
			assert.strictEqual(switchedCodex.token_gen, 2);

			// Switch both host ('gpu-box' -> canonical IP '10.20.30.40') and engine ('codex' -> 'kilo') with empty model ->
			// auto-picks remote probed model and normalizes unsupported 'low' effort to kilo default 'high'
			const switchedRemoteKilo = await ipcClient.uiEditAgent({
				projectId: pid,
				agentId: l1.agent_id,
				host: 'gpu-box',
				engine: 'kilo',
				model: '   ',
			});
			assert.strictEqual(switchedRemoteKilo.host, '10.20.30.40');
			assert.strictEqual(switchedRemoteKilo.engine, 'kilo');
			assert.strictEqual(switchedRemoteKilo.model, 'deepseek-remote/r2-pro');
			assert.strictEqual(switchedRemoteKilo.effort, 'high');
			assert.strictEqual(switchedRemoteKilo.session_started, false);
			assert.strictEqual(switchedRemoteKilo.session_resource, `aexus-kilo:/ade-${pid}-${l1.agent_id}`);
			assert.strictEqual(switchedRemoteKilo.token_gen, 3);
		} finally {
			await svc.gracefulShutdown();
		}
	});

	test('2. Started employee (session_started=1): rejects host/engine edit without allowSessionReset (ERR_ENGINE_LOCKED), and atomically resets session + disposes old runtime + preserves active Tickets when allowSessionReset=true', async () => {
		const wsDir = path.join(tempDir, 'ws-started');
		await fs.promises.mkdir(wsDir, { recursive: true });

		const mockHosts: readonly IAdeCloudHost[] = [{
			id: 'host_cloud_02',
			name: 'Cloud Worker Node',
			alias: 'cloud-node',
			hostName: '172.16.10.88',
			user: 'root',
			port: 22,
			os: 'linux',
			recentDirectories: [],
			source: 'user',
			createdAt: 1,
			updatedAt: 1,
			lastTestStatus: {
				ok: true,
				latencyMs: 6,
				checkedAt: Date.now(),
				remoteHome: '/root',
			},
		}];

		const svc = new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'ade-home-2'),
			socketPath: path.join(tempDir, 'cc2.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: createMockCloudHostService(mockHosts),
			customLocalEngineProber: async () => ['claude', 'codex'],
		});
		const localStore = new DisposableStore();
		store.add(localStore);
		localStore.add(svc);

		svc.engineProber.probeModels = async (hostRaw: string, engineRaw: string) => {
			if ((hostRaw === '172.16.10.88' || hostRaw === 'cloud-node') && engineRaw === 'codex') {
				return {
					engine: 'codex',
					models: ['gpt-5.4-cloud-codex'],
					efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
					defaultEffort: 'medium',
				};
			}
			return svc.engineProber.getDefaultMetadata(engineRaw);
		};

		const disposedEvents: IAdeAgentRuntimeDisposeEvent[] = [];
		const enqueuedEvents: { projectId: string; targetAgentId: string }[] = [];
		localStore.add(svc.onDidDisposeAgentRuntime(ev => disposedEvents.push(ev)));
		localStore.add(svc.onDidEnqueueOutbox(ev => enqueuedEvents.push(ev)));

		try {
			await svc.whenReady();
			const proj = await svc.createProject({
				folderUri: URI.file(wsDir).toString(),
				name: 'StartedResetProj',
			});
			const pid = proj.meta.project_id;

			const l1 = await svc.uiCreateAgent({
				projectId: pid,
				parentId: null,
				level: 1,
				name: 'L1_Director',
				roleSummary: 'Director',
				host: 'local',
				engine: 'claude',
				model: 'claude-sonnet-4-6',
				effort: 'high',
			});
			const l2 = await svc.uiCreateAgent({
				projectId: pid,
				parentId: l1.agent_id,
				level: 2,
				name: 'L2_Engineer',
				roleSummary: 'Backend Engineer',
				host: 'local',
				engine: 'claude',
				model: 'claude-sonnet-4-6',
				effort: 'max',
			});

			// Create a live active reporting-tree Ticket from L1 -> L2
			const createTkRes = await svc.executeCliCommand(
				{ projectId: pid, agentId: l1.agent_id, host: 'local', tokenGen: l1.token_gen },
				'ade_create',
				{
					to: l2.agent_id,
					type: 'task',
					title: 'Hot Switch Verification',
					needReturn: true,
					summary: 'Implement host/engine hot switch',
					detail: 'Verify active Tickets on valid reporting edges are never frozen during session reset.',
				},
			);
			assert.strictEqual(createTkRes.ok, true);
			const ticketId = String(createTkRes.ticket_id);

			// Simulate Outbox CLI-missing block before manual start, then mark L2 session started with nativeSessionId
			const claimed = await svc.claimPendingDeliveries(77, 8);
			assert.strictEqual(claimed.length, 1);
			await svc.nackDeliveryFailed(claimed[0].deliveryId, 77, 'claude CLI missing', true);

			const oldClaudeUri = `aexus-claude:/ade-${pid}-${l2.agent_id}`;
			await svc.markAgentSessionStarted(pid, l2.agent_id, {
				sessionResource: oldClaudeUri,
				nativeSessionId: 'claude_native_session_abc123',
			});

			const snapBefore = await svc.getProjectSnapshot(pid);
			const l2Started = snapBefore?.agents.find(a => a.agent_id === l2.agent_id);
			assert.strictEqual(l2Started?.session_started, true);
			assert.strictEqual(l2Started?.session_phase, 'started');
			assert.strictEqual(l2Started?.native_session_id, 'claude_native_session_abc123');
			const tokenGenBeforeSwitch = l2Started!.token_gen;

			// Without allowSessionReset: true, both engine change AND host change MUST throw ERR_ENGINE_LOCKED!
			await assertRejectsAdeCode(
				() => svc.uiEditAgent({
					projectId: pid,
					agentId: l2.agent_id,
					engine: 'codex',
				}),
				'ERR_ENGINE_LOCKED',
			);
			await assertRejectsAdeCode(
				() => svc.uiEditAgent({
					projectId: pid,
					agentId: l2.agent_id,
					host: 'cloud-node',
				}),
				'ERR_ENGINE_LOCKED',
			);
			assert.strictEqual(disposedEvents.length, 0, 'Failed locked edits must NOT emit runtime dispose');

			// With allowSessionReset: true, switching host + engine succeeds atomically!
			enqueuedEvents.length = 0;
			const resetNode = await svc.uiEditAgent({
				projectId: pid,
				agentId: l2.agent_id,
				host: 'cloud-node',
				engine: 'codex',
				allowSessionReset: true,
			});

			assert.strictEqual(resetNode.host, '172.16.10.88');
			assert.strictEqual(resetNode.engine, 'codex');
			assert.strictEqual(resetNode.model, 'gpt-5.4-cloud-codex');
			assert.strictEqual(resetNode.effort, 'medium', 'Unsupported claude max effort normalizes to codex default medium');
			assert.strictEqual(resetNode.session_phase, 'unstarted');
			assert.strictEqual(resetNode.session_started, false);
			assert.strictEqual(resetNode.native_session_id, undefined);
			assert.strictEqual(resetNode.session_resource, undefined);
			assert.strictEqual(resetNode.token_gen, tokenGenBeforeSwitch + 1);

			// Old runtime slot was notified to dispose
			assert.strictEqual(disposedEvents.length, 1);
			assert.strictEqual(disposedEvents[0].projectId, pid);
			assert.strictEqual(disposedEvents[0].agentId, l2.agent_id);
			assert.strictEqual(disposedEvents[0].host, 'local');
			assert.strictEqual(disposedEvents[0].engine, 'claude');
			assert.strictEqual(disposedEvents[0].sessionResource, oldClaudeUri);

			// Old caller identity (tokenGenBeforeSwitch / local) is strictly invalidated
			await assertRejectsAdeCode(
				() => svc.executeCliCommand(
					{ projectId: pid, agentId: l2.agent_id, host: 'local', tokenGen: tokenGenBeforeSwitch },
					'ade_whoami',
					{},
				),
				'ERR_UNAUTHORIZED',
			);

			// Active reporting-tree Ticket MUST remain active (NOT frozen!) and blocked_cli outbox item is ready for replay!
			const snapAfter = await svc.getProjectSnapshot(pid);
			const activeTk = snapAfter?.tickets.find(t => t.ticket_id === ticketId);
			assert.strictEqual(activeTk?.status, 'active', 'Valid reporting-tree Ticket must NOT be frozen on session reset');
			assert.strictEqual(enqueuedEvents.some(e => e.projectId === pid && e.targetAgentId === l2.agent_id), true);
			const replayedClaim = await svc.claimPendingDeliveries(88, 8);
			assert.strictEqual(replayedClaim.length, 1);
			assert.strictEqual(replayedClaim[0].ticketId, ticketId);

			// Deterministic URI resolves cleanly even when session_resource column was reset to NULL
			const expectedNewCodexUri = `aexus-codex:/ade-${pid}-${l2.agent_id}`;
			const resolvedByUri = await svc.resolveAgentBySessionResource(expectedNewCodexUri);
			assert.strictEqual(resolvedByUri?.projectId, pid);
			assert.strictEqual(resolvedByUri?.agent.agent_id, l2.agent_id);
			assert.strictEqual(resolvedByUri?.agent.engine, 'codex');
			assert.strictEqual(resolvedByUri?.agent.host, '172.16.10.88');
			const allBound = await svc.listAllBoundSessionResources();
			assert.strictEqual(allBound.includes(expectedNewCodexUri), true);

			// Start session on remote cloud-node, then switch ONLY host back to 'local' (same engine 'codex') with allowSessionReset=true
			await svc.markAgentSessionStarted(pid, l2.agent_id, {
				sessionResource: expectedNewCodexUri,
				nativeSessionId: 'codex_remote_ses_777',
			});
			const backToLocal = await svc.uiEditAgent({
				projectId: pid,
				agentId: l2.agent_id,
				host: 'local',
				allowSessionReset: true,
			});
			assert.strictEqual(backToLocal.host, 'local');
			assert.strictEqual(backToLocal.engine, 'codex');
			assert.strictEqual(backToLocal.session_started, false);
			assert.strictEqual(backToLocal.session_phase, 'unstarted');
			assert.strictEqual(backToLocal.native_session_id, undefined);
			assert.strictEqual(backToLocal.session_resource, undefined);
			assert.strictEqual(disposedEvents.length, 2);
			assert.strictEqual(disposedEvents[1].host, '172.16.10.88');
			assert.strictEqual(disposedEvents[1].sshAlias, 'cloud-node');
			assert.strictEqual(disposedEvents[1].engine, 'codex');
		} finally {
			await svc.gracefulShutdown();
		}
	});

	test('3. Agent CLI ade_agent_edit contract remains 100% locked (ERR_ENGINE_LOCKED on started agent, --host & allowSessionReset forbidden)', async () => {
		const wsDir = path.join(tempDir, 'ws-cli-guard');
		await fs.promises.mkdir(wsDir, { recursive: true });

		const svc = new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'ade-home-3'),
			socketPath: path.join(tempDir, 'cc3.sock'),
			persistIdempotencyLedger: false,
			customLocalEngineProber: async () => ['claude', 'codex'],
		});
		const localStore = new DisposableStore();
		store.add(localStore);
		localStore.add(svc);

		try {
			await svc.whenReady();
			const proj = await svc.createProject({
				folderUri: URI.file(wsDir).toString(),
				name: 'CliContractProj',
			});
			const pid = proj.meta.project_id;

			const l1 = await svc.uiCreateAgent({
				projectId: pid,
				parentId: null,
				level: 1,
				name: 'L1_Supervisor',
				roleSummary: 'Supervisor',
				host: 'local',
				engine: 'claude',
				model: 'claude-sonnet-4-6',
				effort: 'medium',
			});
			const l2 = await svc.uiCreateAgent({
				projectId: pid,
				parentId: l1.agent_id,
				level: 2,
				name: 'L2_Sub',
				roleSummary: 'Subordinate',
				host: 'local',
				engine: 'claude',
				model: 'claude-sonnet-4-6',
				effort: 'medium',
			});

			const callerL1 = { projectId: pid, agentId: l1.agent_id, host: 'local', tokenGen: l1.token_gen };

			// 1) CLI ade_agent_edit rejects --host even when session_started === 0
			await assertRejectsAdeCode(
				() => svc.executeCliCommand(callerL1, 'ade_agent_edit', {
					agentId: l2.agent_id,
					host: 'local',
				}),
				'ERR_INVALID_ARGS',
			);

			// 2) CLI ade_agent_edit rejects allowSessionReset parameter
			await assertRejectsAdeCode(
				() => svc.executeCliCommand(callerL1, 'ade_agent_edit', {
					agentId: l2.agent_id,
					engine: 'codex',
					model: 'gpt-5.3-codex',
					allowSessionReset: true,
				}),
				'ERR_INVALID_ARGS',
			);

			// 3) Once L2 session is started, CLI ade_agent_edit --engine strictly throws ERR_ENGINE_LOCKED
			await svc.markAgentSessionStarted(pid, l2.agent_id, {
				sessionResource: `aexus-claude:/ade-${pid}-${l2.agent_id}`,
				nativeSessionId: 'ses_locked_cli',
			});
			await assertRejectsAdeCode(
				() => svc.executeCliCommand(callerL1, 'ade_agent_edit', {
					agentId: l2.agent_id,
					engine: 'codex',
					model: 'gpt-5.3-codex',
				}),
				'ERR_ENGINE_LOCKED',
			);

			// 4) Non-engine metadata edit via CLI still succeeds cleanly
			const okEdit = await svc.executeCliCommand(callerL1, 'ade_agent_edit', {
				agentId: l2.agent_id,
				role: 'Updated Role Summary',
				effort: 'high',
			});
			assert.strictEqual(okEdit.ok, true);
		} finally {
			await svc.gracefulShutdown();
		}
	});
});
