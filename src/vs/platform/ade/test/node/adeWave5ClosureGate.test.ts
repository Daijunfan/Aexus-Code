/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { DeferredPromise } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { FileAccess } from '../../../../base/common/network.js';
import * as path from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogService, LogLevel } from '../../../log/common/log.js';
import { ADE_CLI_COMMANDS } from '../../common/adeCliManifest.js';
import { buildCloudProjectUri, IAdeCloudHost, IAdeCloudHostBackendService } from '../../common/adeCloudHosts.js';
import { AdeControlCenterChannel, AdeControlCenterChannelClient, IAdeVerifiedCliCaller } from '../../common/adeControlCenterIpc.js';
import { AdeError } from '../../common/adeModels.js';
import { AdeControlCenterService } from '../../node/adeControlCenterService.js';
import { AdeDynamicStorageEngine, IAdeStorageTransportAdapter } from '../../node/adeDynamicStorageEngine.js';
import { AdeSqliteStore } from '../../node/adeSqliteStore.js';

function resolveRepoRoot(): string {
	const appRoot = FileAccess.asFileUri('').fsPath;
	const baseName = path.basename(appRoot);
	if (baseName === 'out' || baseName === 'out-build') {
		return path.dirname(appRoot);
	}
	return appRoot;
}

function createLocalShTransport(
	hostsByKey: ReadonlyMap<string, { readonly ip: string; readonly alias: string; readonly remoteHome: string }>,
	options?: {
		readonly onBeforeStream?: (alias: string, remoteShCommand: string) => Promise<void> | void;
	},
): IAdeStorageTransportAdapter {
	return {
		async getEffectiveSshConfigPath() {
			return '/dev/null';
		},
		async resolveHost(ipOrAlias: string) {
			const h = hostsByKey.get(ipOrAlias);
			if (!h) {
				throw new AdeError('ERR_INVALID_ARGS', `Unknown mock cloud host: ${ipOrAlias}`);
			}
			return { ip: h.ip, alias: h.alias, os: 'linux', remoteHome: h.remoteHome };
		},
		async spawnSshStream(alias: string, remoteShCommand: string) {
			const h = hostsByKey.get(alias);
			if (!h) {
				throw new Error(`Unknown alias ${alias}`);
			}
			await fs.promises.mkdir(h.remoteHome, { recursive: true });
			await options?.onBeforeStream?.(alias, remoteShCommand);

			const child = spawn('/bin/sh', ['-c', remoteShCommand], {
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env, HOME: h.remoteHome },
			});
			let stderr = '';
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (c: string) => { stderr += c; });
			const closePromise = new Promise<{ readonly exitCode: number | null; readonly stderr: string }>((resolve, reject) => {
				child.once('error', reject);
				child.once('close', exitCode => resolve({ exitCode, stderr }));
			});
			return {
				stdin: child.stdin,
				stdout: child.stdout,
				waitClose: () => closePromise,
				kill: () => {
					try { child.kill('SIGKILL'); } catch { /* ignore */ }
				},
			};
		},
	};
}

function createSpyLogService(sink: string[]): ILogService {
	const fmt = (msg: string | Error, args: unknown[]) => [
		msg instanceof Error ? (msg.stack ?? msg.message) : msg,
		...args.map(a => a instanceof Error ? (a.stack ?? a.message) : String(a)),
	].join(' ');
	return {
		_serviceBrand: undefined,
		onDidChangeLogLevel: Event.None,
		setLevel(_level: LogLevel): void { },
		getLevel(): LogLevel { return LogLevel.Info; },
		trace(): void { },
		debug(): void { },
		info(): void { },
		warn(message: string, ...args: unknown[]): void { sink.push(fmt(message, args)); },
		error(message: string | Error, ...args: unknown[]): void { sink.push(fmt(message, args)); },
		flush(): void { },
		dispose(): void { },
	};
}

suite('Wave 5 Closure Gate (Track A: Anti-Resurrection, IPC Shutdown & Self-Heal, Board Delete Convergence, Symlink $HOME Dest Guard & 45-Command Preflight)', function () {
	let tempDir: string;
	const pendingAsyncCleanups: Array<() => Promise<void>> = [];

	const trackSqliteStore = (s: AdeSqliteStore): AdeSqliteStore => {
		pendingAsyncCleanups.push(async () => {
			await s.shutdownAll();
			s.dispose();
		});
		return s;
	};
	const trackStorageEngine = (e: AdeDynamicStorageEngine): AdeDynamicStorageEngine => {
		pendingAsyncCleanups.push(async () => {
			e.abortActiveStreamsForShutdown();
			await e.waitForPendingGc();
			e.dispose();
		});
		return e;
	};
	const trackControlCenter = (s: AdeControlCenterService): AdeControlCenterService => {
		pendingAsyncCleanups.push(async () => {
			await s.gracefulShutdown();
		});
		return s;
	};

	teardown(async () => {
		while (pendingAsyncCleanups.length > 0) {
			const fn = pendingAsyncCleanups.pop()!;
			await fn().catch(() => undefined);
		}
	});

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	setup(async () => {
		const baseTmp = isWindows ? os.tmpdir() : '/tmp';
		tempDir = await fs.promises.mkdtemp(path.join(baseTmp, 'ade-w5-'));
	});

	teardown(async () => {
		if (tempDir) {
			await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	test('1. [P0-1] prevents deleted project state.db resurrection, skips removed projects in cross-project polls, drains slow uploads/routing sync, and purges isolated workspaces', async function () {
		if (isWindows) {
			this.skip();
		}

		// Part A: AdeSqliteStore removedProjectIds tombstone blocks openProjectDb from auto-recreating projects/<pid>/state.db
		const storeHome = path.join(tempDir, 'sql-tomb-home');
		const sql = trackSqliteStore(new AdeSqliteStore({ adeHomeDir: storeHome }));
		const pdb = sql.openProjectDb('proj_dead');
		await pdb.run(
			`INSERT INTO project_meta (project_id, folder_id, folder_uri, name, cross_host_ticket_storage, ticket_migration_epoch, ticket_migration_state, layout_direction, created_at, updated_at)
			 VALUES ('proj_dead', 'f1', 'file:///tmp/x', 'DeadProj', 'local', 0, 'idle', 'TD', 1, 1)`,
		);
		const deadDir = sql.getProjectDir('proj_dead');
		assert.strictEqual(await fs.promises.access(deadDir).then(() => true, () => false), true);

		await sql.closeAndRemoveProjectDb('proj_dead');
		assert.strictEqual(sql.isProjectRemovedOrClosing('proj_dead'), true);
		assert.strictEqual(await sql.tryOpenActiveProjectDb('proj_dead'), undefined);
		assert.strictEqual(await fs.promises.access(deadDir).then(() => true, () => false), false);

		assert.throws(
			() => sql.openProjectDb('proj_dead'),
			(err: unknown) => err instanceof AdeError && err.code === 'ERR_INVALID_ARGS',
		);
		assert.strictEqual(
			await fs.promises.access(deadDir).then(() => true, () => false),
			false,
			'Blocked openProjectDb on removed project must NEVER mkdir or recreate orphan state.db',
		);

		sql.registerOrClearRemovedProject('proj_dead');
		assert.strictEqual(sql.isProjectRemovedOrClosing('proj_dead'), false);
		const reopened = sql.openProjectDb('proj_dead');
		await reopened.get('SELECT 1 AS ok');
		await sql.shutdownAll();

		// Part B: AdeControlCenterService deleteProject drains slow CLI uploads & routing sync, skips concurrent polls, and cleans local + remote isolated workspaces
		const homeA = path.join(tempDir, 'w5-cloud-a');
		const homeB = path.join(tempDir, 'w5-cloud-b');
		const remoteRepoOnA = path.posix.join(homeA, 'repo-main');
		await fs.promises.mkdir(remoteRepoOnA, { recursive: true });
		await fs.promises.mkdir(homeB, { recursive: true });

		const hostMap = new Map([
			['10.0.51.11', { ip: '10.0.51.11', alias: 'w5-a', remoteHome: homeA }],
			['w5-a', { ip: '10.0.51.11', alias: 'w5-a', remoteHome: homeA }],
			['10.0.51.22', { ip: '10.0.51.22', alias: 'w5-b', remoteHome: homeB }],
			['w5-b', { ip: '10.0.51.22', alias: 'w5-b', remoteHome: homeB }],
		]);
		const hostChangedEmitter = store.add(new Emitter<void>());
		const mockHosts: IAdeCloudHost[] = [
			{
				id: 'ha', name: 'CloudA', alias: 'w5-a', hostName: '10.0.51.11', user: 'dev', port: 22,
				os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
				lastTestStatus: { ok: true, checkedAt: 1, latencyMs: 1, remoteHome: homeA },
			},
			{
				id: 'hb', name: 'CloudB', alias: 'w5-b', hostName: '10.0.51.22', user: 'dev', port: 22,
				os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
				lastTestStatus: { ok: true, checkedAt: 1, latencyMs: 1, remoteHome: homeB },
			},
		];
		const fakeCloudService: Partial<IAdeCloudHostBackendService> = {
			onDidChangeHosts: hostChangedEmitter.event,
			listHosts: async () => mockHosts,
			getHost: async idOrAlias => mockHosts.find(h => h.alias === idOrAlias || h.hostName === idOrAlias || h.id === idOrAlias),
			remoteMkdir: async (_alias, dirPath) => {
				await fs.promises.mkdir(dirPath, { recursive: true });
			},
			remoteReadFile: async (_alias, filePath) => {
				const buf = await fs.promises.readFile(filePath);
				return VSBuffer.wrap(buf);
			},
			remoteWriteFile: async (_alias, filePath, content) => {
				await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
				await fs.promises.writeFile(filePath, content.buffer);
			},
		};

		let gateSlowUploads = false;
		let slowUploadsEntered = 0;
		const bothSlowUploadsInStream = new DeferredPromise<void>();
		const releaseSlowUploads = new DeferredPromise<void>();
		const loggedIssues: string[] = [];

		const adeHome = path.join(tempDir, 'ade-del-iso-home');
		const svc = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: adeHome,
			socketPath: path.join(tempDir, 'w5p1.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: fakeCloudService as IAdeCloudHostBackendService,
			customStorageTransport: createLocalShTransport(hostMap, {
				onBeforeStream: async (_alias, cmd) => {
					if (gateSlowUploads && cmd.includes('cat > "$tmp"')) {
						slowUploadsEntered++;
						if (slowUploadsEntered >= 2) {
							bothSlowUploadsInStream.complete();
						}
						await releaseSlowUploads.p;
					}
				},
			}),
			customLocalEngineProber: async () => ['claude', 'antigravity'],
			logService: createSpyLogService(loggedIssues),
		}));
		await svc.whenReady();

		const cloudFolderUri = buildCloudProjectUri('w5-a', remoteRepoOnA, 'linux').toString();
		const proj = await svc.createProject({ folderUri: cloudFolderUri, name: 'CloudIsoProj' });
		const pid = proj.meta.project_id;
		const projDbDir = svc.sqliteStore.getProjectDir(pid);

		// L1 on local (creates local isolated workspace ~/.aexus-code/workspaces/<pid>/<l1>)
		// L2 on 10.0.51.22 (different cloud host from folder w5-a -> creates remote isolated workspace ~/.ade_store/workspaces/<pid>/<l2>)
		const l1Local = await svc.uiCreateAgent({
			projectId: pid, parentId: null, level: 1, name: 'L1Local', roleSummary: 'Lead',
			host: 'local', engine: 'antigravity', model: 'gemini-2.5-pro', effort: 'medium',
		});
		const l2RemoteB = await svc.uiCreateAgent({
			projectId: pid, parentId: l1Local.agent_id, level: 2, name: 'L2RemoteB', roleSummary: 'Worker',
			host: '10.0.51.22', engine: 'antigravity', model: 'gemini-2.5-pro', effort: 'medium',
		});

		const localIsoProjDir = path.join(adeHome, 'workspaces', pid);
		const remoteIsoProjDirB = path.join(homeB, '.ade_store', 'workspaces', pid);
		assert.strictEqual(await fs.promises.access(localIsoProjDir).then(() => true, () => false), true, 'Expected local isolated workspace created');
		assert.strictEqual(await fs.promises.access(remoteIsoProjDirB).then(() => true, () => false), true, 'Expected remote isolated workspace created on CloudB');

		await svc.uiConfigureProjectTicketStorage(pid, '10.0.51.11');
		const wb = await svc.uiCreateWhiteboard({ projectId: pid, name: 'CloudBoardA', storageHost: '10.0.51.11' });
		const callerL1: IAdeVerifiedCliCaller = { projectId: pid, agentId: l1Local.agent_id, host: 'local', tokenGen: 1 };

		const detailSrc = path.join(tempDir, 'slow-detail.md');
		const wbFileSrc = path.join(tempDir, 'slow-wb.bin');
		await fs.promises.writeFile(detailSrc, 'SLOW_TICKET_DETAIL_PAYLOAD', 'utf8');
		await fs.promises.writeFile(wbFileSrc, 'SLOW_WB_UPLOAD_PAYLOAD', 'utf8');

		gateSlowUploads = true;
		const slowCreateP = svc.executeCliCommand(callerL1, 'ade_create', {
			to: l2RemoteB.agent_id,
			type: 'impl',
			title: 'SlowTask',
			summary: 'Slow upload during deleteProject',
			needReturn: 'true',
			detailFile: detailSrc,
		});
		void slowCreateP.catch(() => undefined);
		const slowWbUploadP = svc.executeCliCommand(callerL1, 'ade_wb_upload_file', {
			boardId: wb.board_id,
			file: wbFileSrc,
			summary: 'SlowWbFile',
			stars: '5',
		});
		void slowWbUploadP.catch(() => undefined);
		try {
			await bothSlowUploadsInStream.p;

			// Launch deleteProject concurrently with cross-project background polls while both slow uploads are mid-flight
			let delFinished = false;
			const delP = svc.deleteProject(pid).then(() => { delFinished = true; });
			await new Promise<void>(r => setTimeout(r, 20));
			assert.strictEqual(delFinished, false, 'deleteProject must drain in-flight CLI operations before closing project DB');

			const pollResults = await Promise.all([
				svc.claimPendingDeliveries(1),
				svc.listAllBoundSessionResources(),
				svc.resolveAgentBySessionResource(l1Local.session_resource ?? `aexus-antigravity:/ade-${pid}-${l1Local.agent_id}`),
				svc.releaseWindowDeliveries(1),
			]);
			assert.deepStrictEqual(pollResults[0], []);
			assert.strictEqual(pollResults[2], undefined);

			releaseSlowUploads.complete();
			await Promise.all([
				assert.rejects(() => slowCreateP, (err: unknown) => err instanceof AdeError && err.code === 'ERR_UNAUTHORIZED'),
				assert.rejects(() => slowWbUploadP, (err: unknown) => err instanceof AdeError && err.code === 'ERR_UNAUTHORIZED'),
			]);
			await delP;
		} finally {
			releaseSlowUploads.complete();
		}
		await svc.storageEngine.drainTombstonesAsync();

		// Run another round of cross-project polls + alias migration AFTER deleteProject completed -> state.db must NEVER resurrect!
		await svc.claimPendingDeliveries(2);
		await svc.listAllBoundSessionResources();
		await svc.resolveAgentBySessionResource(`aexus-antigravity:/ade-${pid}-${l1Local.agent_id}`);
		await svc.migrateCloudHostAlias('w5-a', 'w5-a-renamed');

		assert.strictEqual(await fs.promises.access(projDbDir).then(() => true, () => false), false, 'projects/<pid>/state.db must never be resurrected');
		assert.strictEqual(await fs.promises.access(localIsoProjDir).then(() => true, () => false), false, 'Local isolated workspace directory must be purged');
		assert.strictEqual(await fs.promises.access(remoteIsoProjDirB).then(() => true, () => false), false, 'Remote isolated workspace directory must be purged');
		assert.strictEqual(
			await fs.promises.access(path.join(homeA, '.ade_store', `${pid}_tickets`)).then(() => true, () => false),
			false,
			'Slow ade_create <pid>_tickets/<ticketId> & <pid>_tickets directories must be purged via cleanup tombstones',
		);
		assert.strictEqual(
			await fs.promises.access(path.join(homeA, '.ade_store', `${pid}_${wb.board_id}`)).then(() => true, () => false),
			false,
			'Slow ade_wb_upload_file <pid>_<boardId> directory must be purged via cleanup tombstones',
		);
		for (const issue of loggedIssues) {
			assert.strictEqual(issue.includes('SQLite database already closed'), false, `Unexpected closed DB log: ${issue}`);
		}
		await svc.gracefulShutdown();
	});

	test('2. [P0-2] drains in-flight IPC/service calls in gracefulShutdown Stage 1, guards releaseWindowDeliveries & Emitter after shutdown, and self-heals stale transferring state on startup', async function () {
		if (isWindows) {
			this.skip();
		}

		const homeCloud = path.join(tempDir, 'ipc-sd-cloud');
		await fs.promises.mkdir(homeCloud, { recursive: true });
		const hostMap = new Map([
			['10.0.52.11', { ip: '10.0.52.11', alias: 'ipc-cloud', remoteHome: homeCloud }],
			['ipc-cloud', { ip: '10.0.52.11', alias: 'ipc-cloud', remoteHome: homeCloud }],
		]);
		const hostChangedEmitter = store.add(new Emitter<void>());
		const mockHost: IAdeCloudHost = {
			id: 'h_ipc', name: 'IpcCloud', alias: 'ipc-cloud', hostName: '10.0.52.11', user: 'dev', port: 22,
			os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
		};

		let gateHostLookup = false;
		let hostLookupCount = 0;
		const bothLookupsPaused = new DeferredPromise<void>();
		const releaseHostLookup = new DeferredPromise<void>();

		const fakeCloudService: Partial<IAdeCloudHostBackendService> = {
			onDidChangeHosts: hostChangedEmitter.event,
			listHosts: async () => [],
			getHost: async idOrAlias => {
				if (gateHostLookup && idOrAlias === 'ipc-cloud') {
					hostLookupCount++;
					if (hostLookupCount >= 2) {
						bothLookupsPaused.complete();
					}
					await releaseHostLookup.p;
					return mockHost;
				}
				return (idOrAlias === 'ipc-cloud' || idOrAlias === '10.0.52.11') ? mockHost : undefined;
			},
		};

		const healAdeHome = path.join(tempDir, 'ade-ipc-heal-home');
		const svc1 = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: healAdeHome,
			socketPath: path.join(tempDir, 'w5ipc1.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: fakeCloudService as IAdeCloudHostBackendService,
			customStorageTransport: createLocalShTransport(hostMap),
			customLocalEngineProber: async () => ['claude'],
		}));
		await svc1.whenReady();

		const channel = new AdeControlCenterChannel(svc1);
		const ipcAdapter: IChannel = {
			listen: <T>(event: string) => channel.listen<T>('renderer', event),
			call: <T>(command: string, arg?: unknown) => channel.call<T>('renderer', command, arg),
		};
		const client = new AdeControlCenterChannelClient(ipcAdapter);

		const wsDir = path.join(tempDir, 'ws-ipc');
		await fs.promises.mkdir(wsDir, { recursive: true });
		const proj = await client.createProject({ folderUri: URI.file(wsDir).toString(), name: 'IpcDrainProj' });
		const pid = proj.meta.project_id;
		const l1 = await client.uiCreateAgent({
			projectId: pid, parentId: null, level: 1, name: 'L1', roleSummary: 'Lead',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'high',
		});
		const l2 = await client.uiCreateAgent({
			projectId: pid, parentId: l1.agent_id, level: 2, name: 'L2', roleSummary: 'Dev',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'high',
		});
		const wb = await client.uiCreateWhiteboard({ projectId: pid, name: 'IpcBoard', storageHost: 'local' });

		// Create an in-flight window delivery so releaseWindowDeliveries would normally fire onDidEnqueueOutbox if not shutting down
		const callerL1: IAdeVerifiedCliCaller = { projectId: pid, agentId: l1.agent_id, host: 'local', tokenGen: 1 };
		await client.executeCliCommand(callerL1, 'ade_create', {
			to: l2.agent_id, type: 'task', title: 'T1', summary: 'S1', needReturn: 'false', detail: 'D1',
		});
		const claimed = await client.claimPendingDeliveries(42);
		assert.strictEqual(claimed.length, 1);

		// Suspend both uiConfigureProjectTicketStorage & uiConfigureWhiteboard inside validateAndCanonicalizeHost
		gateHostLookup = true;
		const ticketCfgP = client.uiConfigureProjectTicketStorage(pid, 'ipc-cloud');
		void ticketCfgP.catch(() => undefined);
		const wbCfgP = client.uiConfigureWhiteboard({ projectId: pid, boardId: wb.board_id, targetStorageHost: 'ipc-cloud' });
		void wbCfgP.catch(() => undefined);
		await bothLookupsPaused.p;
		assert.ok(svc1.inflightServiceCallCount >= 2);
		assert.ok(channel.inflightCallCount >= 2);

		let postShutdownEvents = 0;
		const sub1 = svc1.onDidChangeProject(() => { postShutdownEvents++; });
		const sub2 = svc1.onDidEnqueueOutbox(() => { postShutdownEvents++; });
		try {
			let shutdownDone = false;
			const sdP = svc1.gracefulShutdown().then(() => { shutdownDone = true; });
			await new Promise<void>(r => setTimeout(r, 20));
			assert.strictEqual(shutdownDone, false, 'gracefulShutdown Stage 1 must wait for _inflightServiceCalls before closing SQLite');

			// Concurrent window close calling releaseWindowDeliveries during shutdown must resolve cleanly with zero Emitter fire
			await client.releaseWindowDeliveries(42);
			await svc1.releaseWindowDeliveries(42);

			// Other new IPC calls during shutdown reject cleanly with serialized ERR_UNAUTHORIZED AdeError
			await assert.rejects(
				() => client.getCatalogSnapshot(),
				(err: unknown) => err instanceof AdeError && err.code === 'ERR_UNAUTHORIZED',
			);

			releaseHostLookup.complete();
			await Promise.all([
				assert.rejects(
					() => ticketCfgP,
					(err: unknown) => err instanceof AdeError && err.code === 'ERR_UNAUTHORIZED',
				),
				assert.rejects(
					() => wbCfgP,
					(err: unknown) => err instanceof AdeError && err.code === 'ERR_UNAUTHORIZED',
				),
			]);
			await channel.drainInflightCalls();
			await sdP;
			assert.strictEqual(postShutdownEvents, 0, 'Zero Emitter events may fire after shuttingDown=true');
		} finally {
			releaseHostLookup.complete();
			sub1.dispose();
			sub2.dispose();
		}

		// Part 2: Simulate previous SIGKILL crash that left both ticket_migration_state='transferring' and whiteboards.migration_state='transferring'
		const stateDbPath = svc1.sqliteStore.getProjectDbPath(pid);
		const sqlite3Mod = await import('@vscode/sqlite3').then(m => (m.default ?? m) as typeof import('@vscode/sqlite3'));
		await new Promise<void>((resolve, reject) => {
			const raw = new sqlite3Mod.Database(stateDbPath, err => {
				if (err) { reject(err); return; }
				raw.exec(
					`UPDATE project_meta SET ticket_migration_state = 'transferring' WHERE project_id = '${pid}';
					 UPDATE whiteboards SET migration_state = 'transferring' WHERE board_id = '${wb.board_id}';
					 INSERT INTO storage_migration_items
					 (migration_item_id, scope_type, scope_id, epoch, entity_table, entity_pk_1, entity_pk_2, expected_rev, expected_sha256, size_bytes, src_host, src_path, dst_host, dst_path, phase, retry_count, updated_at)
					 VALUES ('mig_stale_wb', 'whiteboard', '${wb.board_id}', 1, 'whiteboard_items', 'itm_x', '', 1, '', 10, 'local', '/tmp/x', '10.0.52.11', '', 'pending', 0, 1);`,
					e2 => raw.close(() => (e2 ? reject(e2) : resolve())),
				);
			});
		});

		gateHostLookup = false;
		const svc2 = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: healAdeHome,
			socketPath: path.join(tempDir, 'w5ipc2.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: fakeCloudService as IAdeCloudHostBackendService,
			customStorageTransport: createLocalShTransport(hostMap),
			customLocalEngineProber: async () => ['claude'],
		}));
		await svc2.whenReady();

		const healedSnap = await svc2.getProjectSnapshot(pid);
		assert.ok(healedSnap);
		assert.strictEqual(healedSnap.meta.ticket_migration_state, 'failed', 'Orphaned project_meta.ticket_migration_state="transferring" must self-heal to "failed" on startup');
		const healedWb = healedSnap.whiteboards.find(w => w.board_id === wb.board_id);
		assert.strictEqual(healedWb?.migration_state, 'failed', 'Orphaned whiteboards.migration_state="transferring" must self-heal to "failed" on startup');

		const pdb2 = svc2.sqliteStore.openProjectDb(pid);
		const healedMigItem = await pdb2.get<{ phase: string }>(`SELECT phase FROM storage_migration_items WHERE migration_item_id = 'mig_stale_wb'`);
		assert.strictEqual(healedMigItem?.phase, 'failed');
		await svc2.gracefulShutdown();
	});

	test('3. [P1-3] converges in-flight whiteboard CAS migration on uiDeleteWhiteboard & ade_wb_delete and purges storage_migration_items src/dst & remote board directories', async function () {
		if (isWindows) {
			this.skip();
		}

		const homeCloud = path.join(tempDir, 'wb-del-conv-cloud');
		await fs.promises.mkdir(homeCloud, { recursive: true });
		const hostMap = new Map([
			['10.0.53.22', { ip: '10.0.53.22', alias: 'wbdel-c', remoteHome: homeCloud }],
			['wbdel-c', { ip: '10.0.53.22', alias: 'wbdel-c', remoteHome: homeCloud }],
		]);
		const hostChangedEmitter = store.add(new Emitter<void>());
		const mockHosts: IAdeCloudHost[] = [{
			id: 'h_wbd', name: 'WbDelCloud', alias: 'wbdel-c', hostName: '10.0.53.22', user: 'dev', port: 22,
			os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
		}];
		const fakeCloudService: Partial<IAdeCloudHostBackendService> = {
			onDidChangeHosts: hostChangedEmitter.event,
			listHosts: async () => mockHosts,
			getHost: async idOrAlias => mockHosts.find(h => h.alias === idOrAlias || h.hostName === idOrAlias || h.id === idOrAlias),
		};

		let gateOnStreamNth = 0;
		let seenMigrationStreams = 0;
		let streamPaused = new DeferredPromise<void>();
		let releasePausedStream = new DeferredPromise<void>();

		const svc = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'ade-wbdel-home'),
			socketPath: path.join(tempDir, 'w5wbdel.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: fakeCloudService as IAdeCloudHostBackendService,
			customStorageTransport: createLocalShTransport(hostMap, {
				onBeforeStream: async (_alias, cmd) => {
					if (gateOnStreamNth > 0 && cmd.includes('cat > "$tmp"')) {
						seenMigrationStreams++;
						if (seenMigrationStreams === gateOnStreamNth) {
							streamPaused.complete();
							await releasePausedStream.p;
						}
					}
				},
			}),
			customLocalEngineProber: async () => ['claude'],
		}));
		await svc.whenReady();

		const wsDir = path.join(tempDir, 'ws-wbdel');
		await fs.promises.mkdir(wsDir, { recursive: true });
		const f1 = path.join(wsDir, 'a.bin');
		const f2 = path.join(wsDir, 'b.bin');
		await fs.promises.writeFile(f1, 'BOARD_MIG_DATA_A', 'utf8');
		await fs.promises.writeFile(f2, 'BOARD_MIG_DATA_B', 'utf8');

		const proj = await svc.createProject({ folderUri: URI.file(wsDir).toString(), name: 'WbDelProj' });
		const pid = proj.meta.project_id;
		const l1 = await svc.uiCreateAgent({
			projectId: pid, parentId: null, level: 1, name: 'L1', roleSummary: 'Owner',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'high',
		});
		const l2 = await svc.uiCreateAgent({
			projectId: pid, parentId: l1.agent_id, level: 2, name: 'L2', roleSummary: 'Member',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'high',
		});
		const callerL1: IAdeVerifiedCliCaller = { projectId: pid, agentId: l1.agent_id, host: 'local', tokenGen: 1 };
		const callerL2: IAdeVerifiedCliCaller = { projectId: pid, agentId: l2.agent_id, host: 'local', tokenGen: 1 };

		// Case A: CLI ade_wb_delete rejects non-owner without aborting migration, then owner ade_wb_delete drains & purges remote dir
		const wbCli = await svc.uiCreateWhiteboard({ projectId: pid, name: 'CliDelBoard', ownerId: l1.agent_id, storageHost: 'local' });
		await svc.uiConfigureWhiteboard({
			projectId: pid, boardId: wbCli.board_id, grants: [{ agentId: l2.agent_id, perm: 'read_write' }],
		});
		await svc.executeCliCommand(callerL1, 'ade_wb_upload_file', { boardId: wbCli.board_id, file: f1, summary: 'A', stars: '5' });
		await svc.executeCliCommand(callerL1, 'ade_wb_upload_file', { boardId: wbCli.board_id, file: f2, summary: 'B', stars: '4' });

		seenMigrationStreams = 0;
		gateOnStreamNth = 1;
		streamPaused = new DeferredPromise<void>();
		releasePausedStream = new DeferredPromise<void>();
		await svc.uiConfigureWhiteboard({ projectId: pid, boardId: wbCli.board_id, targetStorageHost: '10.0.53.22' });
		await streamPaused.p;

		try {
			// Non-owner ade_wb_delete MUST fail with ERR_WB_NOT_OWNER before touching deletingWhiteboards
			await assert.rejects(
				() => svc.executeCliCommand(callerL2, 'ade_wb_delete', { boardId: wbCli.board_id }),
				(err: unknown) => err instanceof AdeError && err.code === 'ERR_WB_NOT_OWNER',
			);

			let cliDelDone = false;
			const cliDelP = svc.executeCliCommand(callerL1, 'ade_wb_delete', { boardId: wbCli.board_id }).then(() => { cliDelDone = true; });
			await new Promise<void>(r => setTimeout(r, 20));
			assert.strictEqual(cliDelDone, false, 'ade_wb_delete must await active whiteboard migration before deleting rows');

			releasePausedStream.complete();
			await cliDelP;
		} finally {
			releasePausedStream.complete();
		}
		await svc.storageEngine.drainTombstonesAsync();

		assert.strictEqual(
			await fs.promises.access(path.join(svc.sqliteStore.localStoreRootDir, `${pid}_${wbCli.board_id}`)).then(() => true, () => false),
			false,
		);
		assert.strictEqual(
			await fs.promises.access(path.join(homeCloud, '.ade_store', `${pid}_${wbCli.board_id}`)).then(() => true, () => false),
			false,
			'Remote {pid}_{boardId} directory & uncommitted copiedDst must be completely removed after ade_wb_delete',
		);

		// Case B: uiDeleteWhiteboard after item #1 already migrated to cloud & item #2 is in-flight -> collects storage_migration_items src/dst + both host dirs
		const wbUi = await svc.uiCreateWhiteboard({ projectId: pid, name: 'UiDelBoard', ownerId: l1.agent_id, storageHost: 'local' });
		await svc.executeCliCommand(callerL1, 'ade_wb_upload_file', { boardId: wbUi.board_id, file: f1, summary: 'U1', stars: '5' });
		await svc.executeCliCommand(callerL1, 'ade_wb_upload_file', { boardId: wbUi.board_id, file: f2, summary: 'U2', stars: '4' });

		seenMigrationStreams = 0;
		gateOnStreamNth = 2; // Let item #1 finish migrating to 10.0.53.22, pause on item #2!
		streamPaused = new DeferredPromise<void>();
		releasePausedStream = new DeferredPromise<void>();
		await svc.uiConfigureWhiteboard({ projectId: pid, boardId: wbUi.board_id, targetStorageHost: '10.0.53.22' });
		await streamPaused.p;

		const uiDelP = svc.uiDeleteWhiteboard(pid, wbUi.board_id);
		releasePausedStream.complete();
		await uiDelP;
		await svc.storageEngine.drainTombstonesAsync();

		assert.strictEqual(
			await fs.promises.access(path.join(svc.sqliteStore.localStoreRootDir, `${pid}_${wbUi.board_id}`)).then(() => true, () => false),
			false,
		);
		assert.strictEqual(
			await fs.promises.access(path.join(homeCloud, '.ade_store', `${pid}_${wbUi.board_id}`)).then(() => true, () => false),
			false,
			'uiDeleteWhiteboard must purge remote {pid}_{boardId} directory and all storage_migration_items blobs',
		);
		await svc.gracefulShutdown();
	});

	test('4. [P1-4] blocks symlinked $HOME & sensitive targets on local/remote ade_wb_download --dest with zero pre-validation mkdir -p pollution', async function () {
		if (isWindows) {
			this.skip();
		}

		// Set up physical homes accessed through symlinked $HOME paths on BOTH local and remote!
		const realLocalHome = path.join(tempDir, 'real-local-home');
		const symlinkLocalHome = path.join(tempDir, 'symlink-local-home');
		await fs.promises.mkdir(path.join(realLocalHome, '.ssh'), { recursive: true });
		await fs.promises.mkdir(path.join(realLocalHome, '.aexus-code'), { recursive: true });
		await fs.promises.mkdir(path.join(realLocalHome, '.ade_store'), { recursive: true });
		await fs.promises.symlink(realLocalHome, symlinkLocalHome);

		const realRemoteHome = path.join(tempDir, 'real-remote-home');
		const symlinkRemoteHome = path.join(tempDir, 'symlink-remote-home');
		await fs.promises.mkdir(path.join(realRemoteHome, '.ssh'), { recursive: true });
		await fs.promises.mkdir(path.join(realRemoteHome, '.aexus-code'), { recursive: true });
		await fs.promises.mkdir(path.join(realRemoteHome, '.ade_store'), { recursive: true });
		await fs.promises.symlink(realRemoteHome, symlinkRemoteHome);

		const hostMap = new Map([
			['10.0.54.11', { ip: '10.0.54.11', alias: 'sym-remote', remoteHome: symlinkRemoteHome }],
			['sym-remote', { ip: '10.0.54.11', alias: 'sym-remote', remoteHome: symlinkRemoteHome }],
		]);

		const sql = trackSqliteStore(new AdeSqliteStore({ adeHomeDir: path.join(symlinkLocalHome, '.aexus-code') }));
		const engine = trackStorageEngine(new AdeDynamicStorageEngine({
			sqliteStore: sql,
			customTransport: createLocalShTransport(hostMap),
			maxDataStreamsPerHost: 2,
			homedir: symlinkLocalHome,
		}));

		const ptr = await engine.storeTextBlob({
			targetStorageHost: 'local',
			relSubdir: 'proj_sym_wb',
			filePrefix: 'payload',
			text: 'VERIFIED_DOWNLOAD_CONTENT',
		});

		// 1. Local blocked destinations via BOTH symlinked $HOME and underlying physical path -> zero mkdir pollution!
		const localBlockedCases = [
			{
				dest: path.join(realLocalHome, '.ssh', 'never-mkdir-local-1', 'authorized_keys'),
				mustNotExistDir: path.join(realLocalHome, '.ssh', 'never-mkdir-local-1'),
				isDirHint: false,
			},
			{
				dest: path.join(realLocalHome, '.aexus-code', 'never-mkdir-local-2', 'evil.bin'),
				mustNotExistDir: path.join(realLocalHome, '.aexus-code', 'never-mkdir-local-2'),
				isDirHint: false,
			},
			{
				dest: path.join(realLocalHome, '.ade_store', 'never-mkdir-local-3', 'evil.bin'),
				mustNotExistDir: path.join(realLocalHome, '.ade_store', 'never-mkdir-local-3'),
				isDirHint: false,
			},
			{
				dest: path.join(realLocalHome, '.ssh'),
				mustNotExistDir: '',
				isDirHint: true,
			},
		];
		for (const tc of localBlockedCases) {
			await assert.rejects(
				() => engine.downloadBlobToHost({
					ptr,
					fallbackFilename: 'payload.txt',
					callerHost: 'local',
					rawDestPath: tc.dest,
					destIsDirHint: tc.isDirHint,
				}),
				(err: unknown) => err instanceof AdeError && err.code === 'ERR_INVALID_ARGS',
				`Expected local blocked dest to fail: ${tc.dest}`,
			);
			if (tc.mustNotExistDir) {
				assert.strictEqual(
					await fs.promises.access(tc.mustNotExistDir).then(() => true, () => false),
					false,
					`Local validation MUST NOT mkdir before blacklist check: ${tc.mustNotExistDir}`,
				);
			}
		}

		// 2. Remote blocked destinations via underlying physical path of symlinked $HOME, exact dir, and system dirs -> zero mkdir -p pollution!
		const remoteBlockedCases = [
			{
				dest: path.posix.join(realRemoteHome, '.ade_store', 'never-mkdir-remote-1', 'evil.bin'),
				mustNotExistDir: path.join(realRemoteHome, '.ade_store', 'never-mkdir-remote-1'),
				isDirHint: false,
			},
			{
				dest: path.posix.join(realRemoteHome, '.aexus-code', 'never-mkdir-remote-2', 'evil.bin'),
				mustNotExistDir: path.join(realRemoteHome, '.aexus-code', 'never-mkdir-remote-2'),
				isDirHint: false,
			},
			{
				dest: path.posix.join(realRemoteHome, '.ssh', 'never-mkdir-remote-3', 'id_ed25519'),
				mustNotExistDir: path.join(realRemoteHome, '.ssh', 'never-mkdir-remote-3'),
				isDirHint: false,
			},
			{
				dest: path.posix.join(realRemoteHome, '.ssh'),
				mustNotExistDir: '',
				isDirHint: true,
			},
			{
				dest: '/etc/ade-never-pollute-sub/evil.conf',
				mustNotExistDir: '/etc/ade-never-pollute-sub',
				isDirHint: false,
			},
			{
				dest: '/usr/bin/ade-evil-bin',
				mustNotExistDir: '',
				isDirHint: false,
			},
			{
				dest: '/sbin/ade-evil-sbin',
				mustNotExistDir: '',
				isDirHint: false,
			},
		];
		for (const tc of remoteBlockedCases) {
			await assert.rejects(
				() => engine.downloadBlobToHost({
					ptr,
					fallbackFilename: 'payload.txt',
					callerHost: '10.0.54.11',
					rawDestPath: tc.dest,
					destIsDirHint: tc.isDirHint,
				}),
				(err: unknown) => err instanceof AdeError && err.code === 'ERR_INVALID_ARGS',
				`Expected remote blocked dest to fail: ${tc.dest}`,
			);
			if (tc.mustNotExistDir) {
				assert.strictEqual(
					await fs.promises.access(tc.mustNotExistDir).then(() => true, () => false),
					false,
					`Remote validation MUST NOT mkdir -p before blacklist check: ${tc.mustNotExistDir}`,
				);
			}
		}

		// 3. Allowed normal nested subpaths outside blacklists DO create parent dir AFTER validation passes
		const localSafeOut = await engine.downloadBlobToHost({
			ptr,
			fallbackFilename: 'ok.txt',
			callerHost: 'local',
			rawDestPath: path.join(realLocalHome, 'safe-downloads', 'sub1', 'ok.txt'),
		});
		assert.strictEqual(await fs.promises.readFile(localSafeOut, 'utf8'), 'VERIFIED_DOWNLOAD_CONTENT');

		const remoteSafeOut = await engine.downloadBlobToHost({
			ptr,
			fallbackFilename: 'ok.txt',
			callerHost: '10.0.54.11',
			rawDestPath: '~/safe-remote-downloads/sub2/ok-remote.txt',
		});
		assert.strictEqual(await fs.promises.readFile(remoteSafeOut, 'utf8'), 'VERIFIED_DOWNLOAD_CONTENT');

		await sql.shutdownAll();
	});

	test('5. [P2-5] enforces exact 45-command set parity & pre-kill/pre-mirror preflight in scripts/aexus-install.{sh,ps1}', async function () {
		const repoRoot = resolveRepoRoot();
		const shPath = path.join(repoRoot, 'scripts', 'aexus-install.sh');
		const ps1Path = path.join(repoRoot, 'scripts', 'aexus-install.ps1');
		const shText = await fs.promises.readFile(shPath, 'utf8');
		const ps1Text = await fs.promises.readFile(ps1Path, 'utf8');

		const canonical45 = [...ADE_CLI_COMMANDS];
		assert.strictEqual(canonical45.length, 45);

		// 1. Exact 45 command list parity in aexus-install.sh
		const shListMatch = /EXPECTED_ADE_COMMANDS=\(\s*([\s\S]*?)\s*\)/.exec(shText);
		assert.ok(shListMatch, 'aexus-install.sh must define EXPECTED_ADE_COMMANDS=(...)');
		const shCommands = shListMatch[1].trim().split(/\s+/).filter(Boolean);
		assert.deepStrictEqual(shCommands, canonical45, 'aexus-install.sh EXPECTED_ADE_COMMANDS must match all 45 ADE_CLI_COMMANDS');

		// Verify source pre-flight runs strictly BEFORE pkill and BEFORE rsync --delete, and post-install runs AFTER rsync --delete
		const idxShPreflight = shText.indexOf('verify_ade_bin_dir "$source_app/Contents/Resources/app/bin"');
		const idxShPkill = shText.indexOf('pkill -TERM');
		const idxShRsync = shText.indexOf('rsync -ac --delete');
		const idxShPost = shText.indexOf('verify_ade_bin_dir "$target_app/Contents/Resources/app/bin"');
		assert.ok(idxShPreflight > 0, 'Missing source pre-flight verify_ade_bin_dir call in aexus-install.sh');
		assert.ok(idxShPreflight < idxShPkill, 'Source pre-flight check in aexus-install.sh MUST run BEFORE killing running processes');
		assert.ok(idxShPreflight < idxShRsync, 'Source pre-flight check in aexus-install.sh MUST run BEFORE rsync --delete');
		assert.ok(idxShPost > idxShRsync, 'Target post-install check in aexus-install.sh MUST run AFTER rsync --delete');

		// 2. Exact 45 command list parity & pre-flight ordering in aexus-install.ps1
		const ps1ListMatch = /\$ExpectedAdeCommands\s*=\s*@\(\s*([\s\S]*?)\s*\)/.exec(ps1Text);
		assert.ok(ps1ListMatch, 'aexus-install.ps1 must define $ExpectedAdeCommands = @(...)');
		const ps1Commands = Array.from(ps1ListMatch[1].matchAll(/'(ade_[a-z_]+)'/g), m => m[1]);
		assert.deepStrictEqual(ps1Commands, canonical45, 'aexus-install.ps1 $ExpectedAdeCommands must match all 45 ADE_CLI_COMMANDS');

		const idxPsPreflight = ps1Text.indexOf('Assert-AdeBinDirIntegrity -AppRootDir $builtDir');
		const idxPsStopProc = ps1Text.indexOf('Stop-Process');
		const idxPsRobocopy = ps1Text.indexOf('& robocopy');
		const idxPsPost = ps1Text.indexOf('Assert-AdeBinDirIntegrity -AppRootDir $targetDir');
		assert.ok(idxPsPreflight > 0, 'Missing source pre-flight Assert-AdeBinDirIntegrity call in aexus-install.ps1');
		assert.ok(idxPsPreflight < idxPsStopProc, 'Source pre-flight check in aexus-install.ps1 MUST run BEFORE Stop-Process');
		assert.ok(idxPsPreflight < idxPsRobocopy, 'Source pre-flight check in aexus-install.ps1 MUST run BEFORE robocopy /MIR');
		assert.ok(idxPsPost > idxPsRobocopy, 'Target post-install check in aexus-install.ps1 MUST run AFTER robocopy /MIR');

		// 3. Behavioral execution test of verify_ade_bin_dir extracted from aexus-install.sh (POSIX)
		if (!isWindows) {
			const fnStart = shText.indexOf('EXPECTED_ADE_COMMANDS=(');
			const fnEnd = shText.indexOf('\nbuild_dir=');
			assert.ok(fnStart > 0 && fnEnd > fnStart);
			const fnSnippet = shText.slice(fnStart, fnEnd);

			const runShVerifier = (binDir: string) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
				const child = spawn('bash', ['-c', `set -euo pipefail\n${fnSnippet}\nverify_ade_bin_dir "$1" "unit-test"`, '--', binDir]);
				let stderr = '';
				child.stderr.setEncoding('utf8');
				child.stderr.on('data', (c: string) => { stderr += c; });
				child.once('error', reject);
				child.once('close', code => resolve({ code, stderr }));
			});

			const mockBin = path.join(tempDir, 'mock-bin');
			await fs.promises.mkdir(mockBin, { recursive: true });
			const writeExec = async (name: string) => {
				const fp = path.join(mockBin, name);
				await fs.promises.writeFile(fp, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
				await fs.promises.chmod(fp, 0o755);
			};

			await writeExec('_ade_runner');
			for (const cmd of canonical45) {
				await writeExec(cmd);
			}

			// Valid 45 commands + _ade_runner -> exit 0
			const okRes = await runShVerifier(mockBin);
			assert.strictEqual(okRes.code, 0, `Expected valid bin dir to pass, stderr: ${okRes.stderr}`);

			// Replace 1 canonical command with an unknown 45th command (count is STILL 45!) -> MUST fail!
			await fs.promises.unlink(path.join(mockBin, 'ade_wb_unread_all'));
			await writeExec('ade_fake_command');
			const swappedRes = await runShVerifier(mockBin);
			assert.notStrictEqual(swappedRes.code, 0, 'Swapping a canonical command with a rogue 45th ade_* command must fail');

			// Restore canonical 45, add 46th extra unknown ade_* command -> MUST fail!
			await fs.promises.unlink(path.join(mockBin, 'ade_fake_command'));
			await writeExec('ade_wb_unread_all');
			await writeExec('ade_extra_unknown');
			const extraRes = await runShVerifier(mockBin);
			assert.notStrictEqual(extraRes.code, 0, 'Extra 46th unknown ade_* launcher must fail');
			await fs.promises.unlink(path.join(mockBin, 'ade_extra_unknown'));

			// Legacy prefix launcher -> MUST fail!
			const legacyLauncher = ['aexus-', 'ade-cli'].join('');
			await writeExec(legacyLauncher);
			const legacyRes = await runShVerifier(mockBin);
			assert.notStrictEqual(legacyRes.code, 0, 'Legacy prefix launcher must fail');
		}
	});
});
