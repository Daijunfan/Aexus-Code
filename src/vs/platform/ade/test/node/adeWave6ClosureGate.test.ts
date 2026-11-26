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
import { IAdeCloudHost, IAdeCloudHostBackendService } from '../../common/adeCloudHosts.js';
import { AdeControlCenterChannel, AdeControlCenterChannelClient, IAdeVerifiedCliCaller } from '../../common/adeControlCenterIpc.js';
import { AdeError, AdeOutboxDeliveryState } from '../../common/adeModels.js';
import {
	computeOrchestrationLayoutPositions,
	computeOrchestrationMultiAnchorRoutes,
	IOrchestrationGraphNode,
	ORCH_STAFF_CARD_HEIGHT,
	ORCH_STAFF_CARD_WIDTH,
} from '../../common/adeOrchestrationLayout.js';
import { AdeControlCenterService } from '../../node/adeControlCenterService.js';
import { AdeDynamicStorageEngine, IAdeStorageTransportAdapter } from '../../node/adeDynamicStorageEngine.js';
import { AdeSqliteStore } from '../../node/adeSqliteStore.js';
import { AdeSyspromptSyncService } from '../../node/adeSyspromptSyncService.js';

interface IMockHostSpec {
	readonly ip: string;
	readonly alias: string;
	readonly remoteHome: string;
}

function createLocalShTransport(
	hostsByKey: ReadonlyMap<string, IMockHostSpec>,
	options?: {
		readonly onBeforeStream?: (alias: string, remoteShCommand: string) => Promise<void> | void;
		readonly onStreamActiveChange?: (canonicalIp: string, activeCount: number) => void;
		readonly failDstWriteMidStreamExit255ForAlias?: ReadonlySet<string>;
	},
): IAdeStorageTransportAdapter {
	const activeByIp = new Map<string, number>();
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
			const nextActive = (activeByIp.get(h.ip) ?? 0) + 1;
			activeByIp.set(h.ip, nextActive);
			options?.onStreamActiveChange?.(h.ip, nextActive);

			let decremented = false;
			const decActive = () => {
				if (decremented) {
					return;
				}
				decremented = true;
				const rem = Math.max(0, (activeByIp.get(h.ip) ?? 1) - 1);
				activeByIp.set(h.ip, rem);
				options?.onStreamActiveChange?.(h.ip, rem);
			};

			try {
				await options?.onBeforeStream?.(alias, remoteShCommand);
			} catch (err) {
				decActive();
				throw err;
			}

			const effectiveScript = (options?.failDstWriteMidStreamExit255ForAlias?.has(alias) && remoteShCommand.includes('cat > "$tmp"'))
				? remoteShCommand.replace(
					'cat > "$tmp"',
					'dd bs=1024 count=2 > "$tmp" 2>/dev/null || true; echo "Simulated SSH reset mid-stream" >&2; exit 255',
				)
				: remoteShCommand;

			const child = spawn('/bin/sh', ['-c', effectiveScript], {
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env, HOME: h.remoteHome },
			});
			let stderr = '';
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (c: string) => { stderr += c; });
			const closePromise = new Promise<{ readonly exitCode: number | null; readonly stderr: string }>((resolve, reject) => {
				child.once('error', err => {
					decActive();
					reject(err);
				});
				child.once('close', exitCode => {
					decActive();
					resolve({ exitCode, stderr });
				});
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

function createNoopLogService(): ILogService {
	return {
		_serviceBrand: undefined,
		onDidChangeLogLevel: Event.None,
		setLevel(_level: LogLevel): void { },
		getLevel(): LogLevel { return LogLevel.Info; },
		trace(): void { },
		debug(): void { },
		info(): void { },
		warn(): void { },
		error(): void { },
		flush(): void { },
		dispose(): void { },
	};
}

function execLocalSh(script: string, envHome: string): Promise<{ readonly exitCode: number; readonly outputTail: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn('/bin/sh', ['-c', script], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, HOME: envHome },
		});
		let out = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (c: string) => { out += c; });
		child.stderr.on('data', (c: string) => { out += c; });
		child.once('error', reject);
		child.once('close', code => resolve({ exitCode: code ?? 1, outputTail: out }));
	});
}

async function waitUntil(pred: () => Promise<boolean>, timeoutMs = 8_000, intervalMs = 25): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await pred()) {
			return;
		}
		await new Promise<void>(r => setTimeout(r, intervalMs));
	}
	assert.strictEqual(await pred(), true, `Timed out after ${timeoutMs}ms waiting for condition`);
}

suite('Wave 6 Closure Gate (Track A: Dir Tombstone Pin Guard, CAS Migration Race Convergence, wb_grant --perm none, Canonical IP Semaphore & Sysprompt Cache, Outbox blocked_cli Replay)', function () {
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
		tempDir = await fs.promises.mkdtemp(path.join(baseTmp, 'ade-w6-'));
	});

	teardown(async () => {
		if (tempDir) {
			await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	test('1. [A1] protects pinned child files against is_dir=1 directory tombstones across alias/IP & ~/remoteHome paths, including concurrent ade_wb_delete and ade_destroy', async function () {
		if (isWindows) {
			this.skip();
		}

		const homeA = path.join(tempDir, 'a1-cloud-a');
		await fs.promises.mkdir(homeA, { recursive: true });
		const hostMap = new Map<string, IMockHostSpec>([
			['10.0.61.11', { ip: '10.0.61.11', alias: 'w6-a1', remoteHome: homeA }],
			['w6-a1', { ip: '10.0.61.11', alias: 'w6-a1', remoteHome: homeA }],
		]);

		// Part A: Direct storage engine cross-representation (`alias` + `~/` vs `ip` + `<remoteHome>`) pin guard & file-before-dir order
		const sqlDirect = trackSqliteStore(new AdeSqliteStore({ adeHomeDir: path.join(tempDir, 'a1-sql-direct') }));
		const dseDirect = trackStorageEngine(new AdeDynamicStorageEngine({
			sqliteStore: sqlDirect,
			customTransport: createLocalShTransport(hostMap),
			homedir: path.join(tempDir, 'a1-mac-home'),
		}));

		const ptr1 = await dseDirect.storeTextBlob({
			targetStorageHost: 'w6-a1',
			relSubdir: 'projA1_wbA1',
			filePrefix: 'msg_itm1',
			text: 'PINNED_CHILD_PAYLOAD_ALPHA',
		});
		const fileBaseName = path.posix.basename(ptr1.storage_path);
		const remoteBoardDirExpanded = path.posix.dirname(ptr1.storage_path);

		// Pin using SSH alias + `~/.ade_store/...` while directory tombstone uses canonical IP or vice-versa!
		const unpinAliasTilde = dseDirect.pinBlobForRead('w6-a1', `~/.ade_store/projA1_wbA1/${fileBaseName}`);
		await dseDirect.enqueueTombstones([
			// Enqueue directory tombstone FIRST to verify `is_dir ASC` sorting & child-pin prefix blocking
			{ projectId: 'projA1', storageHost: '10.0.61.11', storagePath: `~/.ade_store/projA1_wbA1`, isDir: true },
			{ projectId: 'projA1', storageHost: '10.0.61.11', storagePath: ptr1.storage_path, isDir: false },
		]);
		await dseDirect.drainTombstonesAsync();

		assert.strictEqual(
			await fs.promises.access(ptr1.storage_path).then(() => true, () => false),
			true,
			'Pinned child file must NOT be unlinked or rm -rf deleted by parent is_dir=1 tombstone',
		);
		assert.strictEqual(
			await dseDirect.readTextBlobVerified(ptr1),
			'PINNED_CHILD_PAYLOAD_ALPHA',
		);

		// Also verify reverse representation: pin with canonical IP + expanded path while tombstone uses alias + `~/`
		const ptr2 = await dseDirect.storeTextBlob({
			targetStorageHost: '10.0.61.11',
			relSubdir: 'projA1_wbA1',
			filePrefix: 'msg_itm2',
			text: 'PINNED_CHILD_PAYLOAD_BETA',
		});
		const unpinCanonicalExpanded = dseDirect.pinBlobForRead('10.0.61.11', ptr2.storage_path);
		await dseDirect.enqueueTombstones([
			{ projectId: 'projA1', storageHost: 'w6-a1', storagePath: `~/.ade_store/projA1_wbA1/${path.posix.basename(ptr2.storage_path)}` },
		]);

		// Unpin first file: directory STILL has `ptr2` pinned, so `ptr1` deletes while `projA1_wbA1` and `ptr2` survive!
		unpinAliasTilde();
		await dseDirect.waitForPendingGc();
		assert.strictEqual(await fs.promises.access(ptr1.storage_path).then(() => true, () => false), false);
		assert.strictEqual(await fs.promises.access(ptr2.storage_path).then(() => true, () => false), true);
		assert.strictEqual(await fs.promises.access(remoteBoardDirExpanded).then(() => true, () => false), true);

		// Unpin last child file: `unpin()` automatically triggers `drainTombstonesAsync()`, cleaning `ptr2` AND empty parent directory!
		unpinCanonicalExpanded();
		await dseDirect.waitForPendingGc();
		assert.strictEqual(await fs.promises.access(ptr2.storage_path).then(() => true, () => false), false);
		assert.strictEqual(
			await fs.promises.access(remoteBoardDirExpanded).then(() => true, () => false),
			false,
			'Parent directory tombstone must automatically drain once the last pinned child unpins',
		);
		const remTombs = await sqlDirect.catalog.get<{ cnt: number }>(`SELECT COUNT(1) AS cnt FROM remote_gc_tombstones`);
		assert.strictEqual(Number(remTombs?.cnt ?? 0), 0);

		// Part B: End-to-end `ade_wb_get_msg` + concurrent `ade_wb_delete` AND `ade_get_detail` + concurrent `ade_destroy`
		const hostChanged = store.add(new Emitter<void>());
		const mockHosts: IAdeCloudHost[] = [{
			id: 'ha1', name: 'CloudA1', alias: 'w6-a1', hostName: '10.0.61.11', user: 'dev', port: 22,
			os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
			lastTestStatus: { ok: true, checkedAt: 1, latencyMs: 1, remoteHome: homeA },
		}];
		const fakeCloud: Partial<IAdeCloudHostBackendService> = {
			onDidChangeHosts: hostChanged.event,
			listHosts: async () => mockHosts,
			getHost: async k => mockHosts.find(h => h.alias === k || h.hostName === k || h.id === k),
			remoteMkdir: async (_a, d) => { await fs.promises.mkdir(d, { recursive: true }); },
			remoteReadFile: async (_a, f) => VSBuffer.wrap(await fs.promises.readFile(f)),
			remoteWriteFile: async (_a, f, c) => {
				await fs.promises.mkdir(path.dirname(f), { recursive: true });
				await fs.promises.writeFile(f, c.buffer);
			},
		};

		let gateCatRead = false;
		let catEnteredSignal = new DeferredPromise<void>();
		let releaseCatSignal = new DeferredPromise<void>();

		const localWorkspace = path.join(tempDir, 'a1-workspace');
		await fs.promises.mkdir(localWorkspace, { recursive: true });
		const svc = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'a1-cc-home'),
			socketPath: path.join(tempDir, 'a1.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: fakeCloud as IAdeCloudHostBackendService,
			customStorageTransport: createLocalShTransport(hostMap, {
				onBeforeStream: async (_alias, cmd) => {
					if (gateCatRead && cmd.includes('cat --')) {
						gateCatRead = false;
						catEnteredSignal.complete();
						await releaseCatSignal.p;
					}
				},
			}),
			customLocalEngineProber: async () => ['claude', 'codex'],
			logService: createNoopLogService(),
		}));
		await svc.whenReady();

		const proj = await svc.createProject({ folderUri: URI.file(localWorkspace).toString(), name: 'A1Proj' });
		const l1 = await svc.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: null, level: 1, name: 'L1', roleSummary: 'Lead',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'medium',
		});
		const l2 = await svc.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: l1.agent_id, level: 2, name: 'L2', roleSummary: 'Worker',
			host: 'w6-a1', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'medium',
		});
		const cL1: IAdeVerifiedCliCaller = { projectId: proj.meta.project_id, agentId: l1.agent_id, host: 'local', tokenGen: l1.token_gen };
		const cL2: IAdeVerifiedCliCaller = { projectId: proj.meta.project_id, agentId: l2.agent_id, host: '10.0.61.11', tokenGen: l2.token_gen };

		const wbRes = await svc.executeCliCommand(cL1, 'ade_wb_create', { name: 'BoardA1', host: 'w6-a1' });
		const boardId = String(wbRes.board_id);
		await svc.executeCliCommand(cL1, 'ade_wb_grant', { boardId, to: l2.agent_id, perm: 'read' });
		const postRes = await svc.executeCliCommand(cL1, 'ade_wb_post_msg', {
			boardId, summary: 'Spec', stars: 3, detail: 'CONCURRENT_WB_DELETE_SAFE_DETAIL',
		});
		const itemId = String(postRes.item_id);

		gateCatRead = true;
		catEnteredSignal = new DeferredPromise<void>();
		releaseCatSignal = new DeferredPromise<void>();

		const pendingReadMsg = svc.executeCliCommand(cL2, 'ade_wb_get_msg', { boardId, itemId });
		await catEnteredSignal.p;

		// Concurrent `ade_wb_delete` runs while `ade_wb_get_msg` holds `pinBlobForRead(+1)`
		await svc.executeCliCommand(cL1, 'ade_wb_delete', { boardId });
		releaseCatSignal.complete();

		const readMsgOut = await pendingReadMsg;
		assert.strictEqual(readMsgOut.detail, 'CONCURRENT_WB_DELETE_SAFE_DETAIL');
		await svc.storageEngine.waitForPendingGc();
		assert.strictEqual(
			await fs.promises.access(path.posix.join(homeA, '.ade_store', `${proj.meta.project_id}_${boardId}`)).then(() => true, () => false),
			false,
			'Remote board directory must be cleaned after concurrent reader unpins',
		);

		// Same check for `ade_get_detail` + concurrent `ade_destroy` on remote ticket storage
		await svc.uiConfigureProjectTicketStorage(proj.meta.project_id, 'w6-a1');
		const tkRes = await svc.executeCliCommand(cL1, 'ade_create', {
			to: l2.agent_id, type: 'impl', title: 'TaskA1', summary: 'Sum', needReturn: false,
			detail: 'CONCURRENT_TICKET_DESTROY_SAFE_DETAIL',
		});
		const ticketId = String(tkRes.ticket_id);
		const taskId = String(tkRes.task_id);

		gateCatRead = true;
		catEnteredSignal = new DeferredPromise<void>();
		releaseCatSignal = new DeferredPromise<void>();

		try {
			const pendingTkDetail = svc.executeCliCommand(cL1, 'ade_detail', { ticketId, taskId });
			await catEnteredSignal.p;

			// `ade_destroy` called by current holder `cL2` reads detail (unblocked since `gateCatRead` flipped false on first stream), archives gzip, and enqueues `<pid>_tickets/<ticket_id>` dir tombstone
			await svc.executeCliCommand(cL2, 'ade_destroy', { ticketId });
			await svc.storageEngine.drainTombstonesAsync();
			assert.strictEqual(
				await fs.promises.access(path.posix.join(homeA, '.ade_store', `${proj.meta.project_id}_tickets`, ticketId)).then(() => true, () => false),
				true,
				'Ticket directory must remain intact while in-flight ade_detail holds pin',
			);

			releaseCatSignal.complete();
			const tkDetailOut = await pendingTkDetail;
			assert.strictEqual(tkDetailOut.detail, 'CONCURRENT_TICKET_DESTROY_SAFE_DETAIL');
		} finally {
			releaseCatSignal.complete();
		}
		await svc.storageEngine.waitForPendingGc();
		assert.strictEqual(
			await fs.promises.access(path.posix.join(homeA, '.ade_store', `${proj.meta.project_id}_tickets`, ticketId)).then(() => true, () => false),
			false,
			'Ticket directory must be cleaned once in-flight ade_get_detail unpins',
		);
	});

	test('2. [A2] enforces zero-migration instant switch & epoch preemption on CLI ade_wb_config --host, converges uiConfigureWhiteboard CAS migrations under concurrent edit/delete/destroy, and cleans remote <ticket_id> directories', async function () {
		if (isWindows) {
			this.skip();
		}

		const homeA = path.join(tempDir, 'a2-cloud-a');
		const homeB = path.join(tempDir, 'a2-cloud-b');
		const localWorkspace = path.join(tempDir, 'a2-workspace');
		await fs.promises.mkdir(homeA, { recursive: true });
		await fs.promises.mkdir(homeB, { recursive: true });
		await fs.promises.mkdir(localWorkspace, { recursive: true });

		const hostMap = new Map<string, IMockHostSpec>([
			['10.0.62.11', { ip: '10.0.62.11', alias: 'w6-a2', remoteHome: homeA }],
			['w6-a2', { ip: '10.0.62.11', alias: 'w6-a2', remoteHome: homeA }],
			['10.0.62.22', { ip: '10.0.62.22', alias: 'w6-b2', remoteHome: homeB }],
			['w6-b2', { ip: '10.0.62.22', alias: 'w6-b2', remoteHome: homeB }],
		]);
		const hostChanged = store.add(new Emitter<void>());
		const mockHosts: IAdeCloudHost[] = [
			{
				id: 'ha2', name: 'CloudA2', alias: 'w6-a2', hostName: '10.0.62.11', user: 'dev', port: 22,
				os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
				lastTestStatus: { ok: true, checkedAt: 1, latencyMs: 1, remoteHome: homeA },
			},
			{
				id: 'hb2', name: 'CloudB2', alias: 'w6-b2', hostName: '10.0.62.22', user: 'dev', port: 22,
				os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
				lastTestStatus: { ok: true, checkedAt: 1, latencyMs: 1, remoteHome: homeB },
			},
		];
		const fakeCloud: Partial<IAdeCloudHostBackendService> = {
			onDidChangeHosts: hostChanged.event,
			listHosts: async () => mockHosts,
			getHost: async k => mockHosts.find(h => h.alias === k || h.hostName === k || h.id === k),
			remoteMkdir: async (_a, d) => { await fs.promises.mkdir(d, { recursive: true }); },
			remoteReadFile: async (_a, f) => VSBuffer.wrap(await fs.promises.readFile(f)),
			remoteWriteFile: async (_a, f, c) => {
				await fs.promises.mkdir(path.dirname(f), { recursive: true });
				await fs.promises.writeFile(f, c.buffer);
			},
		};

		let pauseMigToA = false;
		let migToAEntered = new DeferredPromise<void>();
		let releaseMigToA = new DeferredPromise<void>();

		let pauseWbMigToB = false;
		let wbMigToBEntered = new DeferredPromise<void>();
		let releaseWbMigToB = new DeferredPromise<void>();

		let pauseTicketMigToB = false;
		let ticketMigToBEntered = new DeferredPromise<void>();
		let releaseTicketMigToB = new DeferredPromise<void>();

		const svc = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'a2-cc-home'),
			socketPath: path.join(tempDir, 'a2.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: fakeCloud as IAdeCloudHostBackendService,
			customStorageTransport: createLocalShTransport(hostMap, {
				onBeforeStream: async (alias, cmd) => {
					if (pauseMigToA && alias === 'w6-a2' && cmd.includes('cat > "$tmp"')) {
						pauseMigToA = false;
						migToAEntered.complete();
						await releaseMigToA.p;
					}
					if (pauseWbMigToB && alias === 'w6-b2' && cmd.includes('cat > "$tmp"')) {
						pauseWbMigToB = false;
						wbMigToBEntered.complete();
						await releaseWbMigToB.p;
					}
					if (pauseTicketMigToB && alias === 'w6-b2' && cmd.includes('cat > "$tmp"')) {
						pauseTicketMigToB = false;
						ticketMigToBEntered.complete();
						await releaseTicketMigToB.p;
					}
				},
			}),
			customLocalEngineProber: async () => ['claude', 'codex'],
			logService: createNoopLogService(),
		}));
		await svc.whenReady();

		const proj = await svc.createProject({ folderUri: URI.file(localWorkspace).toString(), name: 'A2Proj' });
		const pdb = svc.sqliteStore.openProjectDb(proj.meta.project_id);
		const l1 = await svc.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: null, level: 1, name: 'L1', roleSummary: 'Lead',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'medium',
		});
		const l2 = await svc.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: l1.agent_id, level: 2, name: 'L2', roleSummary: 'Sub',
			host: 'w6-a2', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'medium',
		});
		const cL1: IAdeVerifiedCliCaller = { projectId: proj.meta.project_id, agentId: l1.agent_id, host: 'local', tokenGen: l1.token_gen };
		const cL2: IAdeVerifiedCliCaller = { projectId: proj.meta.project_id, agentId: l2.agent_id, host: '10.0.62.11', tokenGen: l2.token_gen };

		// 2A (`plan.md` §5.5 #30 & §6.3 #2): CLI `ade_wb_config --host` switches default `storage_host` instantly WITHOUT migrating historical files,
		// AND preempts any prior unfinished UI migration (`migration_epoch + 1`, unfinished items -> `skipped`, `migration_state = 'idle'`).
		const cliWb = await svc.executeCliCommand(cL1, 'ade_wb_create', { name: 'CliNoMigWb', host: 'local' });
		const cliBoardId = String(cliWb.board_id);
		await svc.executeCliCommand(cL1, 'ade_wb_grant', { boardId: cliBoardId, to: l2.agent_id, perm: 'read_write' });
		const histItemId = String((await svc.executeCliCommand(cL1, 'ade_wb_post_msg', {
			boardId: cliBoardId, summary: 'HistLocal', stars: 3, detail: 'HIST_LOCAL_ONLY_PAYLOAD',
		})).item_id);
		const histLongNote = 'H'.repeat(340);
		const histNoteId = String((await svc.executeCliCommand(cL1, 'ade_wb_note_send', {
			boardId: cliBoardId, to: l2.agent_id, text: histLongNote,
		})).note_id);

		// Invalid `--host` rejects with ERR_INVALID_ARGS inside transaction without mutating epoch or host
		await assert.rejects(
			() => svc.executeCliCommand(cL1, 'ade_wb_config', { boardId: cliBoardId, host: '10.255.255.99' }),
			(err: unknown) => err instanceof AdeError && err.code === 'ERR_INVALID_ARGS',
		);

		const cliSwitchOut = await svc.executeCliCommand(cL1, 'ade_wb_config', { boardId: cliBoardId, host: 'w6-a2' });
		assert.strictEqual(cliSwitchOut.storage_host, '10.0.62.11');
		let snap = await svc.getProjectSnapshot(proj.meta.project_id);
		const cliBoardSnap1 = snap!.whiteboards.find(w => w.board_id === cliBoardId)!;
		assert.strictEqual(cliBoardSnap1.storage_host, '10.0.62.11');
		assert.strictEqual(cliBoardSnap1.migration_epoch, 1);
		assert.strictEqual(cliBoardSnap1.migration_state, 'idle');

		const cliEnqueuedRows = await pdb.all<{ migration_item_id: string }>(
			`SELECT migration_item_id FROM storage_migration_items WHERE scope_type = 'whiteboard' AND scope_id = ?`,
			[cliBoardId],
		);
		assert.strictEqual(cliEnqueuedRows.length, 0, 'CLI ade_wb_config --host MUST NEVER enqueue historical items into storage_migration_items');

		// Historical data stays on `local` while new writes go to `10.0.62.11`, and both remain transparently readable
		const newCloudItemId = String((await svc.executeCliCommand(cL1, 'ade_wb_post_msg', {
			boardId: cliBoardId, summary: 'NewCloudA', stars: 5, detail: 'NEW_CLOUD_A_PAYLOAD',
		})).item_id);
		const histPtrRow = await pdb.get<{ storage_host: string }>(`SELECT storage_host FROM whiteboard_items WHERE item_id = ?`, [histItemId]);
		const newPtrRow = await pdb.get<{ storage_host: string }>(`SELECT storage_host FROM whiteboard_items WHERE item_id = ?`, [newCloudItemId]);
		assert.strictEqual(histPtrRow?.storage_host, 'local');
		assert.strictEqual(newPtrRow?.storage_host, '10.0.62.11');
		assert.strictEqual((await svc.executeCliCommand(cL1, 'ade_wb_get_msg', { boardId: cliBoardId, itemId: histItemId })).detail, 'HIST_LOCAL_ONLY_PAYLOAD');
		assert.strictEqual((await svc.executeCliCommand(cL1, 'ade_wb_get_msg', { boardId: cliBoardId, itemId: newCloudItemId })).detail, 'NEW_CLOUD_A_PAYLOAD');
		assert.strictEqual((await svc.executeCliCommand(cL1, 'ade_wb_note_detail', { boardId: cliBoardId, noteId: histNoteId })).content, histLongNote);

		// Preemption check: start a Human UI migration (`uiConfigureWhiteboard` -> `w6-b2`, epoch 2) paused mid-stream, then invoke CLI `ade_wb_config --host local`!
		pauseWbMigToB = true;
		wbMigToBEntered = new DeferredPromise<void>();
		releaseWbMigToB = new DeferredPromise<void>();
		try {
			await svc.uiConfigureWhiteboard({ projectId: proj.meta.project_id, boardId: cliBoardId, targetStorageHost: 'w6-b2' });
			await wbMigToBEntered.p;

			snap = await svc.getProjectSnapshot(proj.meta.project_id);
			assert.strictEqual(snap!.whiteboards.find(w => w.board_id === cliBoardId)!.migration_state, 'transferring');

			const preemptOut = await svc.executeCliCommand(cL1, 'ade_wb_config', { boardId: cliBoardId, host: 'local' });
			assert.strictEqual(preemptOut.storage_host, 'local');

			snap = await svc.getProjectSnapshot(proj.meta.project_id);
			const cliBoardSnap3 = snap!.whiteboards.find(w => w.board_id === cliBoardId)!;
			assert.strictEqual(cliBoardSnap3.storage_host, 'local');
			assert.strictEqual(cliBoardSnap3.migration_epoch, 3);
			assert.strictEqual(cliBoardSnap3.migration_state, 'idle');

			const epoch2Rows = await pdb.all<{ phase: string; last_error: string | null }>(
				`SELECT phase, last_error FROM storage_migration_items WHERE scope_type = 'whiteboard' AND scope_id = ? AND epoch = 2`,
				[cliBoardId],
			);
			assert.ok(epoch2Rows.length >= 2);
			assert.strictEqual(epoch2Rows.every(r => r.phase === 'skipped' && r.last_error === null), true);

			const epoch3Rows = await pdb.all<{ migration_item_id: string }>(
				`SELECT migration_item_id FROM storage_migration_items WHERE scope_type = 'whiteboard' AND scope_id = ? AND epoch = 3`,
				[cliBoardId],
			);
			assert.strictEqual(epoch3Rows.length, 0, 'CLI preemption must NOT enqueue new epoch migration items');
		} finally {
			releaseWbMigToB.complete();
		}
		await svc.storageEngine.waitForPendingGc();
		snap = await svc.getProjectSnapshot(proj.meta.project_id);
		assert.strictEqual(snap!.whiteboards.find(w => w.board_id === cliBoardId)!.migration_state, 'idle');
		assert.strictEqual((await svc.executeCliCommand(cL1, 'ade_wb_get_msg', { boardId: cliBoardId, itemId: histItemId })).detail, 'HIST_LOCAL_ONLY_PAYLOAD');
		assert.strictEqual((await svc.executeCliCommand(cL1, 'ade_wb_get_msg', { boardId: cliBoardId, itemId: newCloudItemId })).detail, 'NEW_CLOUD_A_PAYLOAD');

		// 2B: Human UI `uiConfigureWhiteboard` triggers full-scan online CAS migration & converges cleanly under concurrent edit/delete!
		const wbRes = await svc.executeCliCommand(cL1, 'ade_wb_create', { name: 'RaceBoard', host: 'local' });
		const boardId = String(wbRes.board_id);
		await svc.executeCliCommand(cL1, 'ade_wb_grant', { boardId, to: l2.agent_id, perm: 'read_write' });

		const itmFirst = String((await svc.executeCliCommand(cL1, 'ade_wb_post_msg', { boardId, summary: 'First', stars: 3, detail: 'FIRST_MIG_DETAIL' })).item_id);
		const itmEdit = String((await svc.executeCliCommand(cL1, 'ade_wb_post_msg', { boardId, summary: 'EditMe', stars: 4, detail: 'OLD_V1_DETAIL' })).item_id);
		const itmCliDel = String((await svc.executeCliCommand(cL1, 'ade_wb_post_msg', { boardId, summary: 'CliDel', stars: 2, detail: 'CLI_DEL_DETAIL' })).item_id);
		const itmUiDel = String((await svc.executeCliCommand(cL1, 'ade_wb_post_msg', { boardId, summary: 'UiDel', stars: 2, detail: 'UI_DEL_DETAIL' })).item_id);
		const longNoteText = 'N'.repeat(360);
		const noteRes = await svc.executeCliCommand(cL1, 'ade_wb_note_send', { boardId, to: l2.agent_id, text: longNoteText });
		const noteId = String(noteRes.note_id);

		pauseMigToA = true;
		migToAEntered = new DeferredPromise<void>();
		releaseMigToA = new DeferredPromise<void>();

		const cfgOut = await svc.uiConfigureWhiteboard({ projectId: proj.meta.project_id, boardId, targetStorageHost: 'w6-a2' });
		assert.strictEqual(cfgOut.storage_host, '10.0.62.11');
		await migToAEntered.p;

		// Verify `uiConfigureWhiteboard` moved board into `migration_epoch = 1` & `migration_state = 'transferring'`
		snap = await svc.getProjectSnapshot(proj.meta.project_id);
		const migratingWb = snap!.whiteboards.find(w => w.board_id === boardId)!;
		assert.strictEqual(migratingWb.migration_epoch, 1);
		assert.strictEqual(migratingWb.migration_state, 'transferring');

		// Concurrently edit `itmEdit`, CLI-delete `itmCliDel`, and UI-delete `itmUiDel` while `itmFirst` is paused mid-stream!
		await svc.executeCliCommand(cL1, 'ade_wb_edit_item', { boardId, itemId: itmEdit, detail: 'NEW_V2_DETAIL_ON_CLOUD_A' });
		await svc.executeCliCommand(cL1, 'ade_wb_delete_item', { boardId, itemId: itmCliDel });
		await svc.uiManageWhiteboardItem({ projectId: proj.meta.project_id, boardId, itemId: itmUiDel, deleteItem: true });

		releaseMigToA.complete();

		await waitUntil(async () => {
			const s = await svc.getProjectSnapshot(proj.meta.project_id);
			const b = s?.whiteboards.find(w => w.board_id === boardId);
			return b?.migration_state === 'completed' || b?.migration_state === 'failed';
		});
		await svc.storageEngine.waitForPendingGc();

		snap = await svc.getProjectSnapshot(proj.meta.project_id);
		const finalWb = snap!.whiteboards.find(w => w.board_id === boardId)!;
		assert.strictEqual(finalWb.migration_state, 'completed', 'Concurrent edit/delete during CAS migration must converge to completed, NEVER failed');

		const migItems = await pdb.all<{ entity_pk_1: string; phase: string; last_error: string | null }>(
			`SELECT entity_pk_1, phase, last_error FROM storage_migration_items WHERE scope_type = 'whiteboard' AND scope_id = ? AND epoch = 1`,
			[boardId],
		);
		const phaseByPk = new Map(migItems.map(m => [m.entity_pk_1, m]));
		assert.strictEqual(phaseByPk.get(itmFirst)?.phase, 'cleaned');
		assert.strictEqual(phaseByPk.get(noteId)?.phase, 'cleaned');
		assert.strictEqual(phaseByPk.get(itmEdit)?.phase, 'skipped');
		assert.strictEqual(phaseByPk.get(itmEdit)?.last_error, null);
		assert.strictEqual(phaseByPk.get(itmCliDel)?.phase, 'skipped');
		assert.strictEqual(phaseByPk.get(itmUiDel)?.phase, 'skipped');

		assert.strictEqual((await svc.executeCliCommand(cL1, 'ade_wb_get_msg', { boardId, itemId: itmFirst })).detail, 'FIRST_MIG_DETAIL');
		assert.strictEqual((await svc.executeCliCommand(cL1, 'ade_wb_get_msg', { boardId, itemId: itmEdit })).detail, 'NEW_V2_DETAIL_ON_CLOUD_A');
		assert.strictEqual((await svc.executeCliCommand(cL1, 'ade_wb_note_detail', { boardId, noteId })).content, longNoteText);

		// Also test ENOENT catch fallback in `runCasMigrationLoop`: if copyBlobForMigration fails with ENOENT after target row was deleted concurrently, it classifies as `skipped` (not `failed`)!
		const itmRaceEnoent = String((await svc.executeCliCommand(cL1, 'ade_wb_post_msg', {
			boardId, summary: 'RaceEnoent', stars: 3, detail: 'RACE_ENOENT_PAYLOAD',
		})).item_id);
		let triggerEnoentDelete = false;
		const origCopy = svc.storageEngine.copyBlobForMigration.bind(svc.storageEngine);
		svc.storageEngine.copyBlobForMigration = async input => {
			if (triggerEnoentDelete && input.srcPath.includes(itmRaceEnoent)) {
				triggerEnoentDelete = false;
				await pdb.run(`DELETE FROM whiteboard_items WHERE item_id = ?`, [itmRaceEnoent]);
				const enoent = Object.assign(new Error('ENOENT: source unlinked concurrently'), { code: 'ENOENT' });
				throw enoent;
			}
			return origCopy(input);
		};
		try {
			triggerEnoentDelete = true;
			await svc.uiConfigureWhiteboard({ projectId: proj.meta.project_id, boardId, targetStorageHost: 'w6-b2' });
			await waitUntil(async () => {
				const s = await svc.getProjectSnapshot(proj.meta.project_id);
				const b = s?.whiteboards.find(w => w.board_id === boardId);
				return b?.migration_epoch === 2 && (b?.migration_state === 'completed' || b?.migration_state === 'failed');
			});
			const sAfterEnoent = await svc.getProjectSnapshot(proj.meta.project_id);
			const bAfterEnoent = sAfterEnoent!.whiteboards.find(w => w.board_id === boardId)!;
			assert.strictEqual(bAfterEnoent.migration_state, 'completed', 'ENOENT caused by concurrent target deletion must be skipped, not failed');
			const enoentMigRow = await pdb.get<{ phase: string; last_error: string | null }>(
				`SELECT phase, last_error FROM storage_migration_items WHERE scope_type = 'whiteboard' AND scope_id = ? AND epoch = 2 AND entity_pk_1 = ?`,
				[boardId, itmRaceEnoent],
			);
			assert.strictEqual(enoentMigRow?.phase, 'skipped');
			assert.strictEqual(enoentMigRow?.last_error, null);
		} finally {
			svc.storageEngine.copyBlobForMigration = origCopy;
		}

		// 2C: `handleCliTicketDestroy` during in-flight ticket CAS migration cleans `dst_path` AND remote `<pid>_tickets/<ticket_id>` directory!
		await svc.uiConfigureProjectTicketStorage(proj.meta.project_id, 'local');
		const tkRes = await svc.executeCliCommand(cL1, 'ade_create', {
			to: l2.agent_id, type: 'impl', title: 'MigDestroyTk', summary: 'Sum', needReturn: false,
			detail: 'TICKET_MIG_DESTROY_ARCHIVE_PAYLOAD',
		});
		const ticketId = String(tkRes.ticket_id);
		const taskId = String(tkRes.task_id);

		pauseTicketMigToB = true;
		ticketMigToBEntered = new DeferredPromise<void>();
		releaseTicketMigToB = new DeferredPromise<void>();

		try {
			await svc.uiConfigureProjectTicketStorage(proj.meta.project_id, 'w6-b2');
			await ticketMigToBEntered.p;

			// Destroy ticket as holder `cL2` WHILE `copyBlobForMigration` is writing to `w6-b2` (`<homeB>/.ade_store/<pid>_tickets/<ticketId>`)
			await svc.executeCliCommand(cL2, 'ade_destroy', { ticketId });
		} finally {
			releaseTicketMigToB.complete();
		}

		await waitUntil(async () => {
			const s = await svc.getProjectSnapshot(proj.meta.project_id);
			return s?.meta.ticket_migration_state === 'completed' || s?.meta.ticket_migration_state === 'failed';
		});
		await svc.storageEngine.waitForPendingGc();

		const postTkSnap = await svc.getProjectSnapshot(proj.meta.project_id);
		assert.strictEqual(postTkSnap!.meta.ticket_migration_state, 'completed');
		assert.strictEqual(
			await svc.readTicketTaskDetailForUi(proj.meta.project_id, ticketId, taskId),
			'TICKET_MIG_DESTROY_ARCHIVE_PAYLOAD',
		);
		const tkMigRow = await pdb.get<{ phase: string; last_error: string | null }>(
			`SELECT phase, last_error FROM storage_migration_items WHERE scope_type = 'ticket' AND entity_pk_1 = ?`,
			[ticketId],
		);
		assert.strictEqual(tkMigRow?.phase, 'skipped');
		assert.strictEqual(tkMigRow?.last_error, null);

		const remoteTicketDirOnB = path.posix.join(homeB, '.ade_store', `${proj.meta.project_id}_tickets`, ticketId);
		assert.strictEqual(
			await fs.promises.access(remoteTicketDirOnB).then(() => true, () => false),
			false,
			'Remote <pid>_tickets/<ticket_id> directory on destination host must NOT leak after ade_destroy',
		);
	});

	test('3. [A3] enforces assertCallerManagesTarget on ade_wb_grant when --perm !== none and allows idempotent owner revocation when --perm === none', async function () {
		const localWorkspace = path.join(tempDir, 'a3-workspace');
		await fs.promises.mkdir(localWorkspace, { recursive: true });
		const svc = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'a3-cc-home'),
			socketPath: path.join(tempDir, 'a3.sock'),
			persistIdempotencyLedger: false,
			customLocalEngineProber: async () => ['claude'],
			logService: createNoopLogService(),
		}));
		await svc.whenReady();

		const proj = await svc.createProject({ folderUri: URI.file(localWorkspace).toString(), name: 'A3Proj' });
		const l1 = await svc.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: null, level: 1, name: 'L1', roleSummary: 'Root',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'medium',
		});
		const l2A = await svc.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: l1.agent_id, level: 2, name: 'L2A', roleSummary: 'LeadA',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'medium',
		});
		const l3A = await svc.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: l2A.agent_id, level: 3, name: 'L3A', roleSummary: 'DevA',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'medium',
		});
		const l2B = await svc.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: l1.agent_id, level: 2, name: 'L2B', roleSummary: 'LeadB',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'medium',
		});
		const l3B = await svc.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: l2B.agent_id, level: 3, name: 'L3B', roleSummary: 'DevB',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'medium',
		});

		await svc.uiCreateDepartment(proj.meta.project_id, l2A.agent_id, 'DeptA');
		await svc.uiCreateDepartment(proj.meta.project_id, l2B.agent_id, 'DeptB');

		// Non-top L2 without an outer wrapping department (`l2Unwrapped`) cannot manage a subordinate inside an inner sub-department (`InnerDept` rooted at `l3InnerRoot`) -> ERR_CROSS_DEPT!
		const l2Unwrapped = await svc.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: l1.agent_id, level: 2, name: 'L2Unwrapped', roleSummary: 'MidMgr',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'medium',
		});
		const l3InnerRoot = await svc.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: l2Unwrapped.agent_id, level: 3, name: 'L3InnerRoot', roleSummary: 'SubDeptRoot',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'medium',
		});
		const cL1: IAdeVerifiedCliCaller = { projectId: proj.meta.project_id, agentId: l1.agent_id, host: 'local', tokenGen: l1.token_gen };
		const cL2A: IAdeVerifiedCliCaller = { projectId: proj.meta.project_id, agentId: l2A.agent_id, host: 'local', tokenGen: l2A.token_gen };
		const cL3A: IAdeVerifiedCliCaller = { projectId: proj.meta.project_id, agentId: l3A.agent_id, host: 'local', tokenGen: l3A.token_gen };
		const cL2Unwrapped: IAdeVerifiedCliCaller = { projectId: proj.meta.project_id, agentId: l2Unwrapped.agent_id, host: 'local', tokenGen: l2Unwrapped.token_gen };

		const wbRes = await svc.executeCliCommand(cL2A, 'ade_wb_create', { name: 'PrivateBoardA' });
		const boardId = String(wbRes.board_id);
		const wbUnwrappedId = String((await svc.executeCliCommand(cL2Unwrapped, 'ade_wb_create', { name: 'UnwrappedBoard' })).board_id);

		// Grant to `l3InnerRoot` BEFORE `InnerDept` isolates `l3InnerRoot` from `l2Unwrapped`, then create `InnerDept`
		await svc.executeCliCommand(cL2Unwrapped, 'ade_wb_grant', { boardId: wbUnwrappedId, to: l3InnerRoot.agent_id, perm: 'write' });
		await svc.uiCreateDepartment(proj.meta.project_id, l3InnerRoot.agent_id, 'InnerDept');

		// 0. Missing board -> ERR_BOARD_NOT_FOUND; non-owner (`cL1` or `cL3A`) -> strictly ERR_BOARD_NOT_OWNER (even with `--perm none`)
		await assert.rejects(
			() => svc.executeCliCommand(cL2A, 'ade_wb_grant', { boardId: 'wb_missing_404', to: l3A.agent_id, perm: 'none' }),
			(err: unknown) => err instanceof AdeError && err.code === 'ERR_BOARD_NOT_FOUND',
		);
		await assert.rejects(
			() => svc.executeCliCommand(cL1, 'ade_wb_grant', { boardId, to: l3A.agent_id, perm: 'none' }),
			(err: unknown) => err instanceof AdeError && err.code === 'ERR_BOARD_NOT_OWNER',
		);
		await assert.rejects(
			() => svc.executeCliCommand(cL3A, 'ade_wb_grant', { boardId, to: l3A.agent_id, perm: 'none' }),
			(err: unknown) => err instanceof AdeError && err.code === 'ERR_BOARD_NOT_OWNER',
		);

		// 1. `--perm !== 'none'` enforces `assertCallerManagesTarget`: unknown agent -> ERR_AGENT_NOT_FOUND
		await assert.rejects(
			() => svc.executeCliCommand(cL2A, 'ade_wb_grant', { boardId, to: 'agent_ghost_404', perm: 'read' }),
			(err: unknown) => err instanceof AdeError && err.code === 'ERR_AGENT_NOT_FOUND',
		);

		// 2. `--perm !== 'none'`: Superior (`L1`), self (`L2A`), or non-descendant peer (`L3B`) -> ERR_FORBIDDEN_HIERARCHY
		await assert.rejects(
			() => svc.executeCliCommand(cL2A, 'ade_wb_grant', { boardId, to: l1.agent_id, perm: 'read' }),
			(err: unknown) => err instanceof AdeError && err.code === 'ERR_FORBIDDEN_HIERARCHY',
		);
		await assert.rejects(
			() => svc.executeCliCommand(cL2A, 'ade_wb_grant', { boardId, to: l2A.agent_id, perm: 'write' }),
			(err: unknown) => err instanceof AdeError && err.code === 'ERR_FORBIDDEN_HIERARCHY',
		);
		await assert.rejects(
			() => svc.executeCliCommand(cL2A, 'ade_wb_grant', { boardId, to: l3B.agent_id, perm: 'read_write' }),
			(err: unknown) => err instanceof AdeError && err.code === 'ERR_FORBIDDEN_HIERARCHY',
		);

		// 3. `--perm !== 'none'`: Cross-department violation (`l2Unwrapped` lacks an outer wrapping department around `InnerDept`) -> ERR_CROSS_DEPT
		await assert.rejects(
			() => svc.executeCliCommand(cL2Unwrapped, 'ade_wb_grant', { boardId: wbUnwrappedId, to: l3InnerRoot.agent_id, perm: 'read' }),
			(err: unknown) => err instanceof AdeError && err.code === 'ERR_CROSS_DEPT',
		);

		// 4. `--perm === 'none'` (`plan.md` §4.4 #2 & §5.4 #25): as long as `caller === board.owner_id`, ALWAYS idempotently revokes & passes!
		await svc.executeCliCommand(cL2A, 'ade_wb_grant', { boardId, to: l3A.agent_id, perm: 'read' });
		let snap = await svc.getProjectSnapshot(proj.meta.project_id);
		assert.strictEqual(snap!.board_grants.some(g => g.board_id === boardId && g.agent_id === l3A.agent_id), true);

		const revokeRes = await svc.executeCliCommand(cL2A, 'ade_wb_grant', { boardId, to: l3A.agent_id, perm: 'none' });
		assert.deepStrictEqual(revokeRes, { ok: true, board_id: boardId, to: l3A.agent_id, perm: 'none' });
		snap = await svc.getProjectSnapshot(proj.meta.project_id);
		assert.strictEqual(snap!.board_grants.some(g => g.board_id === boardId && g.agent_id === l3A.agent_id), false);

		// Idempotent repeat & non-managed targets (`agent_ghost_404`, `l1`, `l2A`, `l3B`, `l3InnerRoot`) all succeed on `--perm none` for `board.owner_id`
		assert.deepStrictEqual(
			await svc.executeCliCommand(cL2A, 'ade_wb_grant', { boardId, to: l3A.agent_id, perm: 'none' }),
			{ ok: true, board_id: boardId, to: l3A.agent_id, perm: 'none' },
		);
		assert.deepStrictEqual(
			await svc.executeCliCommand(cL2A, 'ade_wb_grant', { boardId, to: 'agent_ghost_404', perm: 'none' }),
			{ ok: true, board_id: boardId, to: 'agent_ghost_404', perm: 'none' },
		);
		assert.deepStrictEqual(
			await svc.executeCliCommand(cL2A, 'ade_wb_grant', { boardId, to: l1.agent_id, perm: 'none' }),
			{ ok: true, board_id: boardId, to: l1.agent_id, perm: 'none' },
		);
		assert.deepStrictEqual(
			await svc.executeCliCommand(cL2A, 'ade_wb_grant', { boardId, to: l2A.agent_id, perm: 'none' }),
			{ ok: true, board_id: boardId, to: l2A.agent_id, perm: 'none' },
		);
		assert.deepStrictEqual(
			await svc.executeCliCommand(cL2A, 'ade_wb_grant', { boardId, to: l3B.agent_id, perm: 'none' }),
			{ ok: true, board_id: boardId, to: l3B.agent_id, perm: 'none' },
		);
		assert.deepStrictEqual(
			await svc.executeCliCommand(cL2Unwrapped, 'ade_wb_grant', { boardId: wbUnwrappedId, to: l3InnerRoot.agent_id, perm: 'none' }),
			{ ok: true, board_id: wbUnwrappedId, to: l3InnerRoot.agent_id, perm: 'none' },
		);
	});

	test('4. [A4] enforces canonical IP semaphore across alias/IP & download/temp-delete paths, 1-SSH batch cache in ensureRemoteSyspromptDocs, and Sequencer on managed-files.json', async function () {
		if (isWindows) {
			this.skip();
		}

		const homeSem = path.join(tempDir, 'a4-cloud-sem');
		await fs.promises.mkdir(homeSem, { recursive: true });
		const hostMap = new Map<string, IMockHostSpec>([
			['10.0.64.11', { ip: '10.0.64.11', alias: 'w6-sem', remoteHome: homeSem }],
			['w6-sem', { ip: '10.0.64.11', alias: 'w6-sem', remoteHome: homeSem }],
		]);

		// Part 1: Canonical IP semaphore (`maxDataStreamsPerHost = 2`) shared across `'w6-sem'` alias & `'10.0.64.11'` IP
		let maxObservedActive = 0;
		const failMidStreamAliases = new Set<string>();
		const sqlSem = trackSqliteStore(new AdeSqliteStore({ adeHomeDir: path.join(tempDir, 'a4-sql-sem') }));
		const dseSem = trackStorageEngine(new AdeDynamicStorageEngine({
			sqliteStore: sqlSem,
			maxDataStreamsPerHost: 2,
			homedir: path.join(tempDir, 'a4-mac-home'),
			customTransport: createLocalShTransport(hostMap, {
				onStreamActiveChange: (_ip, active) => {
					if (active > maxObservedActive) {
						maxObservedActive = active;
					}
				},
				onBeforeStream: async () => {
					await new Promise<void>(r => setTimeout(r, 25));
				},
				failDstWriteMidStreamExit255ForAlias: failMidStreamAliases,
			}),
		}));

		const remoteTmpFile = path.posix.join(homeSem, '.ade_tmp_stdin_test.txt');
		await fs.promises.writeFile(remoteTmpFile, 'TMP_STDIN', 'utf8');
		const remoteDownloadDir = path.posix.join(homeSem, 'downloads');
		await fs.promises.mkdir(remoteDownloadDir, { recursive: true });

		const seedPtr = await dseSem.storeTextBlob({
			targetStorageHost: '10.0.64.11',
			relSubdir: 'projSem_wbSem',
			filePrefix: 'seed',
			text: 'SEED_DATA_FOR_CONCURRENT_POOL',
		});
		maxObservedActive = 0;

		// Launch 6 concurrent operations mixing `'w6-sem'` (alias) and `'10.0.64.11'` (canonical IP) across all remote entrypoints
		await Promise.all([
			dseSem.storeTextBlob({ targetStorageHost: 'w6-sem', relSubdir: 'projSem_wbSem', filePrefix: 'p1', text: 'B1' }),
			dseSem.storeTextBlob({ targetStorageHost: '10.0.64.11', relSubdir: 'projSem_wbSem', filePrefix: 'p2', text: 'B2' }),
			dseSem.readTextBlobVerified({ ...seedPtr, storage_host: 'w6-sem' }),
			dseSem.readTextBlobVerified({ ...seedPtr, storage_host: '10.0.64.11' }),
			dseSem.downloadBlobToHost({
				ptr: { storage_host: 'local', storage_path: await (async () => {
					const lp = path.join(tempDir, 'local-dl-src.bin');
					const buf = Buffer.from('DL_BYTES', 'utf8');
					await fs.promises.writeFile(lp, buf);
					return lp;
				})(), size_bytes: 8, sha256: 'e0a6e63637b23c26d820263a02d0681fb17665c3fc6f321e5b3b1e87f7dc19d7' },
				fallbackFilename: 'out.bin',
				callerHost: 'w6-sem',
				rawDestPath: remoteDownloadDir,
				destIsDirHint: true,
			}).catch(() => undefined),
			dseSem.deleteTempFileBestEffort('w6-sem', remoteTmpFile),
		]);
		assert.strictEqual(
			maxObservedActive <= 2,
			true,
			`Expected unified canonical IP pool to cap concurrency at 2, observed ${maxObservedActive}`,
		);

		// Verify `maxDataStreamsPerHost = 1` mid-stream error catch temp-cleanup does NOT self-deadlock
		const dseCap1 = trackStorageEngine(new AdeDynamicStorageEngine({
			sqliteStore: sqlSem,
			maxDataStreamsPerHost: 1,
			homedir: path.join(tempDir, 'a4-mac-home-cap1'),
			customTransport: createLocalShTransport(hostMap, {
				failDstWriteMidStreamExit255ForAlias: failMidStreamAliases,
			}),
		}));
		failMidStreamAliases.add('w6-sem');
		await assert.rejects(() => dseCap1.storeTextBlob({
			targetStorageHost: 'w6-sem',
			relSubdir: 'projCap1_wb1',
			filePrefix: 'fail_no_deadlock',
			text: 'MUST_NOT_SELF_DEADLOCK_ON_CATCH_CLEANUP',
		}));
		failMidStreamAliases.delete('w6-sem');

		// Part 2: `AdeSyspromptSyncService` 1-SSH batch check + inflight coalescing + 60s TTL cache + invalidation + local ledger `Sequencer`
		const remoteSysHome = path.join(tempDir, 'a4-sysprompt-remote-home');
		await fs.promises.mkdir(remoteSysHome, { recursive: true });
		let sshExecCalls = 0;
		let sshWriteCalls = 0;
		let sshMkdirCalls = 0;

		const sysCloudMock = {
			onDidChangeHosts: Event.None,
			listHosts: async (): Promise<IAdeCloudHost[]> => [{
				id: 'hsys', name: 'SysCloud', alias: 'w6-sys', hostName: '10.0.64.99', user: 'dev', port: 22,
				os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
				lastTestStatus: { ok: true, checkedAt: 1, latencyMs: 1, remoteHome: remoteSysHome },
			}],
			getHost: async (k: string) => (k === 'w6-sys' || k === '10.0.64.99') ? {
				id: 'hsys', name: 'SysCloud', alias: 'w6-sys', hostName: '10.0.64.99', user: 'dev', port: 22,
				os: 'linux' as const, recentDirectories: [], source: 'user' as const, createdAt: 1, updatedAt: 1,
				lastTestStatus: { ok: true, checkedAt: 1, latencyMs: 1, remoteHome: remoteSysHome },
			} : undefined,
			remoteMkdir: async (_alias: string, dirPath: string) => {
				sshMkdirCalls++;
				await fs.promises.mkdir(dirPath, { recursive: true });
			},
			remoteReadFile: async (_alias: string, filePath: string) => VSBuffer.wrap(await fs.promises.readFile(filePath)),
			remoteWriteFile: async (_alias: string, filePath: string, content: VSBuffer) => {
				sshWriteCalls++;
				await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
				await fs.promises.writeFile(filePath, content.buffer);
			},
			remoteExecCommand: async (_alias: string, opts: { command: string }) => {
				sshExecCalls++;
				await new Promise<void>(r => setTimeout(r, 15));
				return execLocalSh(opts.command, remoteSysHome);
			},
		};

		const sysSyncAdeHome = path.join(tempDir, 'a4-sys-ade-home');
		const sysSync = new AdeSyspromptSyncService({
			adeHomeDir: sysSyncAdeHome,
			cloudHostService: sysCloudMock as unknown as IAdeCloudHostBackendService,
			remoteDocsCacheTtlMs: 60_000,
		});

		// Cold run populates missing 3 docs and sets 0444
		const coldRes = await sysSync.ensureRemoteSyspromptDocs('w6-sys', remoteSysHome, '10.0.64.99');
		assert.strictEqual(sshWriteCalls, 3);
		for (const fp of Object.values(coldRes.files)) {
			const st = await fs.promises.stat(fp);
			assert.strictEqual(st.mode & 0o777, 0o444);
		}

		// Clear memory cache while all 3 remote files are already intact & 0444:
		// 5 concurrent calls (mixing alias `'w6-sys'` and IP `'10.0.64.99'`) must coalesce into 1 single SSH round-trip & 0 writes!
		sysSync.invalidateRemoteSyspromptCache();
		sshExecCalls = 0;
		sshWriteCalls = 0;
		sshMkdirCalls = 0;

		await Promise.all([
			sysSync.ensureRemoteSyspromptDocs('w6-sys', remoteSysHome, '10.0.64.99'),
			sysSync.ensureRemoteSyspromptDocs('10.0.64.99', remoteSysHome, '10.0.64.99'),
			sysSync.ensureRemoteSyspromptDocs('w6-sys', remoteSysHome),
			sysSync.ensureRemoteSyspromptDocs('10.0.64.99', remoteSysHome),
			sysSync.ensureRemoteSyspromptDocs('w6-sys', remoteSysHome, '10.0.64.99'),
		]);
		assert.strictEqual(sshExecCalls, 1, 'Intact remote sysprompt docs must verify in exactly 1 coalesced SSH batch round-trip');
		assert.strictEqual(sshWriteCalls, 0);
		assert.strictEqual(sshMkdirCalls, 0);

		// Subsequent call within 60s TTL must hit memory cache with ZERO SSH round-trips!
		await sysSync.ensureRemoteSyspromptDocs('w6-sys', remoteSysHome, '10.0.64.99');
		assert.strictEqual(sshExecCalls, 1, 'TTL cache hit must execute 0 SSH commands');

		// Tamper with ONLY `ticket.md` and call `updateAllSyspromptDocs()` -> immediately invalidates cache & repairs ONLY `ticket.md`!
		await fs.promises.chmod(coldRes.files.ticket, 0o644);
		await fs.promises.writeFile(coldRes.files.ticket, 'CORRUPTED_TICKET_DOC', 'utf8');
		await sysSync.updateAllSyspromptDocs();

		sshExecCalls = 0;
		sshWriteCalls = 0;
		await sysSync.ensureRemoteSyspromptDocs('w6-sys', remoteSysHome, '10.0.64.99');
		assert.strictEqual(sshWriteCalls, 1, 'Only the corrupted ticket.md must be re-uploaded');
		const repairedStat = await fs.promises.stat(coldRes.files.ticket);
		assert.strictEqual(repairedStat.mode & 0o777, 0o444);

		// Concurrent `syncLocalWorkspaceRoutingFiles` across 12 workspaces must serialize `managed-files.json` writes without lost entries
		const workspaces = Array.from({ length: 12 }, (_, idx) => path.join(tempDir, `a4-ws-${idx}`));
		await Promise.all(workspaces.map((ws, idx) =>
			sysSync.syncLocalWorkspaceRoutingFiles(ws, {
				hasLegacyClaudeOrBedrock: idx % 2 === 0,
				hasAntigravityAgent: idx % 3 === 0,
			}),
		));
		const ledgerRaw = JSON.parse(await fs.promises.readFile(path.join(sysSyncAdeHome, 'managed-files.json'), 'utf8')) as {
			entries: Record<string, unknown>;
		};
		for (let idx = 0; idx < 12; idx++) {
			const ws = workspaces[idx];
			assert.strictEqual(Boolean(ledgerRaw.entries[path.join(ws, 'AGENTS.md')]), true, `Missing AGENTS.md ledger entry for ws ${idx}`);
			if (idx % 2 === 0) {
				assert.strictEqual(Boolean(ledgerRaw.entries[path.join(ws, '.claude', 'CLAUDE.md')]), true);
			}
			if (idx % 3 === 0) {
				assert.strictEqual(Boolean(ledgerRaw.entries[path.join(ws, '.agents', 'rules', 'ade-routing.md')]), true);
			}
		}
	});

	test('5. [A5] preserves blocked_cli deliveries on nack(..., true), rolls back unstarted agent, replays on engine edit or IPC requeueBlockedCliDeliveries, and blocks stale sessionResource schemes', async function () {
		const localWorkspace = path.join(tempDir, 'a5-workspace');
		await fs.promises.mkdir(localWorkspace, { recursive: true });
		const svc = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'a5-cc-home'),
			socketPath: path.join(tempDir, 'a5.sock'),
			persistIdempotencyLedger: false,
			customLocalEngineProber: async () => ['claude', 'codex', 'antigravity'],
			logService: createNoopLogService(),
		}));
		await svc.whenReady();

		// Wire IPC Channel <-> Client to verify locked cross-track IPC contract end-to-end
		const serverChannel = new AdeControlCenterChannel(svc);
		const ipcProxy: IChannel = {
			call: <T>(command: string, arg?: unknown) => serverChannel.call<T>('test', command, arg),
			listen: <T>(event: string, _arg?: unknown) => serverChannel.listen<T>('test', event),
		};
		const ipcClient = new AdeControlCenterChannelClient(ipcProxy);

		const enqueuedEvents: Array<{ projectId: string; targetAgentId: string }> = [];
		store.add(ipcClient.onDidEnqueueOutbox(ev => enqueuedEvents.push(ev)));

		const proj = await ipcClient.createProject({ folderUri: URI.file(localWorkspace).toString(), name: 'A5Proj' });
		const l1 = await ipcClient.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: null, level: 1, name: 'L1', roleSummary: 'Root',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'medium',
		});
		const l2 = await ipcClient.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: l1.agent_id, level: 2, name: 'L2UiSwitch', roleSummary: 'Worker1',
			host: 'local', engine: 'codex', model: 'gpt-5.3-codex', effort: 'medium',
		});
		const l3 = await ipcClient.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: l1.agent_id, level: 2, name: 'L3CliSwitch', roleSummary: 'Worker2',
			host: 'local', engine: 'codex', model: 'gpt-5.3-codex', effort: 'medium',
		});
		const cL1: IAdeVerifiedCliCaller = { projectId: proj.meta.project_id, agentId: l1.agent_id, host: 'local', tokenGen: l1.token_gen };

		// Send first ticket to `l2` and `l3`
		const tkL2 = await svc.executeCliCommand(cL1, 'ade_create', {
			to: l2.agent_id, type: 'impl', title: 'FirstTicketL2', summary: 'Do not lose me!', needReturn: true,
		});
		const tkL3 = await svc.executeCliCommand(cL1, 'ade_create', {
			to: l3.agent_id, type: 'impl', title: 'FirstTicketL3', summary: 'Do not lose me either!', needReturn: true,
		});

		// Claim both deliveries
		const winId = 101;
		const claimed1 = await ipcClient.claimPendingDeliveries(winId, 10);
		assert.strictEqual(claimed1.length, 2);
		const dlvL2 = claimed1.find(d => d.targetAgentId === l2.agent_id)!;
		const dlvL3 = claimed1.find(d => d.targetAgentId === l3.agent_id)!;
		assert.strictEqual(dlvL2.ticketId, tkL2.ticket_id);
		assert.strictEqual(dlvL3.ticketId, tkL3.ticket_id);

		// Simulate `codex` CLI missing for both `l2` and `l3`: `nackDeliveryFailed(..., true)` + `rollbackUnstartedIfCliMissing`
		await ipcClient.nackDeliveryFailed(dlvL2.deliveryId, winId, 'codex CLI not installed', true);
		await ipcClient.rollbackUnstartedIfCliMissing(proj.meta.project_id, l2.agent_id);
		await ipcClient.nackDeliveryFailed(dlvL3.deliveryId, winId, 'codex CLI not installed', true);
		await ipcClient.rollbackUnstartedIfCliMissing(proj.meta.project_id, l3.agent_id);

		// Verify rows were NOT deleted and transitioned to `blocked_cli` (`AdeOutboxDeliveryState`)
		const pdb = svc.sqliteStore.openProjectDb(proj.meta.project_id);
		const rowL2 = await pdb.get<{ state: AdeOutboxDeliveryState; claimed_by_window_id: number | null; leased_until: number | null; last_error: string | null }>(
			`SELECT state, claimed_by_window_id, leased_until, last_error FROM ticket_delivery_outbox WHERE delivery_id = ?`,
			[dlvL2.deliveryId],
		);
		assert.strictEqual(rowL2?.state, 'blocked_cli');
		assert.strictEqual(rowL2?.claimed_by_window_id, null);
		assert.strictEqual(rowL2?.leased_until, null);
		assert.strictEqual(rowL2?.last_error, 'codex CLI not installed');

		// Verify `claimPendingDeliveries` does NOT spin on `blocked_cli`
		assert.deepStrictEqual(await ipcClient.claimPendingDeliveries(winId, 10), []);

		// Verify both `l2` and `l3` rolled back to `session_phase = 'unstarted', session_started = false` despite `blocked_cli` rows!
		let snap = await ipcClient.getProjectSnapshot(proj.meta.project_id);
		const snapL2AfterRollback = snap!.agents.find(a => a.agent_id === l2.agent_id)!;
		const snapL3AfterRollback = snap!.agents.find(a => a.agent_id === l3.agent_id)!;
		assert.strictEqual(snapL2AfterRollback.session_phase, 'unstarted');
		assert.strictEqual(snapL2AfterRollback.session_started, false);
		assert.strictEqual(snapL3AfterRollback.session_phase, 'unstarted');
		assert.strictEqual(snapL3AfterRollback.session_started, false);

		// 1. Auto-replay via `uiEditAgent` switching `l2` engine `codex -> claude`
		enqueuedEvents.length = 0;
		await ipcClient.uiEditAgent({
			projectId: proj.meta.project_id,
			agentId: l2.agent_id,
			engine: 'claude',
			model: 'claude-sonnet-4-6',
		});
		assert.strictEqual(enqueuedEvents.some(e => e.projectId === proj.meta.project_id && e.targetAgentId === l2.agent_id), true);

		const replayedL2 = await ipcClient.claimPendingDeliveries(winId, 10);
		assert.strictEqual(replayedL2.length, 1);
		assert.strictEqual(replayedL2[0].deliveryId, dlvL2.deliveryId);
		assert.strictEqual(replayedL2[0].ticketId, tkL2.ticket_id);

		// Verify `markAgentSessionStarting` rejects stale `aexus-codex:` URI from old frontend tab and enforces `aexus-claude:`!
		await ipcClient.markAgentSessionStarting(
			proj.meta.project_id,
			l2.agent_id,
			`aexus-codex:/ade-${proj.meta.project_id}-${l2.agent_id}`,
		);
		snap = await ipcClient.getProjectSnapshot(proj.meta.project_id);
		const snapL2Started = snap!.agents.find(a => a.agent_id === l2.agent_id)!;
		assert.strictEqual(
			snapL2Started.session_resource,
			`aexus-claude:/ade-${proj.meta.project_id}-${l2.agent_id}`,
			'markAgentSessionStarting must reject stale engine scheme and enforce canonical URI matching current engine',
		);
		await ipcClient.ackDeliveryDispatched(dlvL2.deliveryId, winId);

		// 2. Auto-replay via CLI `ade_agent_edit` switching `l3` engine `codex -> claude`
		enqueuedEvents.length = 0;
		await svc.executeCliCommand(cL1, 'ade_agent_edit', {
			agentId: l3.agent_id,
			engine: 'claude',
			model: 'claude-sonnet-4-6',
		});
		assert.strictEqual(enqueuedEvents.some(e => e.projectId === proj.meta.project_id && e.targetAgentId === l3.agent_id), true);

		const replayedL3 = await ipcClient.claimPendingDeliveries(winId, 10);
		assert.strictEqual(replayedL3.length, 1);
		assert.strictEqual(replayedL3[0].deliveryId, dlvL3.deliveryId);

		// 3. Explicit replay via IPC `requeueBlockedCliDeliveries` (e.g. user installs missing CLI binary in PATH without changing engine)
		await ipcClient.nackDeliveryFailed(dlvL3.deliveryId, winId, 'claude binary temporarily missing', true);
		assert.deepStrictEqual(await ipcClient.claimPendingDeliveries(winId, 10), []);

		enqueuedEvents.length = 0;
		const scopedRequeue = await ipcClient.requeueBlockedCliDeliveries({ projectId: proj.meta.project_id, agentId: l3.agent_id });
		assert.strictEqual(scopedRequeue.requeuedCount, 1);
		assert.strictEqual(enqueuedEvents.some(e => e.projectId === proj.meta.project_id && e.targetAgentId === l3.agent_id), true);

		const replayedViaExplicit = await ipcClient.claimPendingDeliveries(winId, 10);
		assert.strictEqual(replayedViaExplicit.length, 1);
		assert.strictEqual(replayedViaExplicit[0].deliveryId, dlvL3.deliveryId);

		// Also verify unscoped `requeueBlockedCliDeliveries()` across all catalog projects
		await ipcClient.nackDeliveryFailed(dlvL3.deliveryId, winId, 'missing again', true);
		const globalRequeue = await ipcClient.requeueBlockedCliDeliveries();
		assert.strictEqual(globalRequeue.requeuedCount, 1);
		const replayedGlobal = await ipcClient.claimPendingDeliveries(winId, 10);
		assert.strictEqual(replayedGlobal.length, 1);
		await ipcClient.ackDeliveryDispatched(dlvL3.deliveryId, winId);
	});

	test('6. [Wave 7 C-3] build/win32/code.iss [InstallDelete] cleans legacy {app}\\bin launchers on Windows in-place upgrade', async function () {
		const appRoot = FileAccess.asFileUri('').fsPath;
		const baseName = path.basename(appRoot);
		const repoRoot = (baseName === 'out' || baseName === 'out-build') ? path.dirname(appRoot) : appRoot;
		const issPath = path.join(repoRoot, 'build', 'win32', 'code.iss');
		const issText = await fs.promises.readFile(issPath, 'utf8');

		const sectionMatch = /\[InstallDelete\]([\s\S]*?)(?:\r?\n\[|$)/.exec(issText);
		assert.ok(sectionMatch, 'Expected [InstallDelete] section in build/win32/code.iss');
		const installDeleteBody = sectionMatch[1];

		const legacyAdeBin = ['aexus-', 'ade'].join('');
		const legacySecBin = ['aexus-', 'secretary'].join('');
		assert.ok(
			installDeleteBody.includes(`Type: files; Name: "{app}\\bin\\${legacyAdeBin}*"`),
			`[InstallDelete] must remove legacy {app}\\bin\\${legacyAdeBin}* launchers`,
		);
		assert.ok(
			installDeleteBody.includes(`Type: files; Name: "{app}\\bin\\${legacySecBin}*"`),
			`[InstallDelete] must remove legacy {app}\\bin\\${legacySecBin}* launchers`,
		);
		assert.ok(
			issText.includes('Source: "bin\\_ade_runner"') && issText.includes('Source: "bin\\ade_*"'),
			'[Files] must bundle bin\\_ade_runner and bin\\ade_* launchers',
		);
	});

	test('7. [Wave 10 Convergence] prevents bounce-migration CAS file deletion (PEER1-HF-01), blocks control-char/parent-symlink escapes (HF-P4-04/PEER2-HF-04), guards root CLAUDE.md (PEER2-HF-05), and routes 16px face-contact & multi-ring RADIAL cleanly (HF-P3-01)', async function () {
		// Part A: PEER1-HF-01 bounce migration local -> HostA (stalled Epoch 1) -> HostB (Epoch 2) -> HostA (Epoch 3)
		const hostAHome = path.join(tempDir, 'w10-hostA');
		const hostBHome = path.join(tempDir, 'w10-hostB');
		const wsDir = path.join(tempDir, 'w10-ws');
		await fs.promises.mkdir(hostAHome, { recursive: true });
		await fs.promises.mkdir(hostBHome, { recursive: true });
		await fs.promises.mkdir(wsDir, { recursive: true });

		const preExistRootClaude = '# Custom Team Guide\nKeep me clean for non-Claude projects!\n';
		await fs.promises.writeFile(path.join(wsDir, 'CLAUDE.md'), preExistRootClaude, 'utf8');

		const hostsMap = new Map<string, IMockHostSpec>([
			['10.0.8.11', { ip: '10.0.8.11', alias: 'w10-a', remoteHome: hostAHome }],
			['w10-a', { ip: '10.0.8.11', alias: 'w10-a', remoteHome: hostAHome }],
			['10.0.8.22', { ip: '10.0.8.22', alias: 'w10-b', remoteHome: hostBHome }],
			['w10-b', { ip: '10.0.8.22', alias: 'w10-b', remoteHome: hostBHome }],
		]);

		let stallFirstHostAWrite = true;
		const epoch1ReachedGate = new DeferredPromise<void>();
		const releaseEpoch1Gate = new DeferredPromise<void>();
		const transport = createLocalShTransport(hostsMap, {
			onBeforeStream: async (alias, cmd) => {
				if (stallFirstHostAWrite && alias === 'w10-a' && cmd.includes('cat > "$tmp"')) {
					stallFirstHostAWrite = false;
					epoch1ReachedGate.complete();
					await releaseEpoch1Gate.p;
				}
			},
		});

		const mockCloudHosts: Partial<IAdeCloudHostBackendService> = {
			onDidChangeHosts: Event.None,
			listHosts: async () => [
				{ id: 'ha', name: 'HostA', alias: 'w10-a', hostName: '10.0.8.11', port: 22, os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1, lastTestStatus: { ok: true, checkedAt: 1, remoteHome: hostAHome, latencyMs: 1 } } as IAdeCloudHost,
				{ id: 'hb', name: 'HostB', alias: 'w10-b', hostName: '10.0.8.22', port: 22, os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1, lastTestStatus: { ok: true, checkedAt: 1, remoteHome: hostBHome, latencyMs: 1 } } as IAdeCloudHost,
			],
			getHost: async id => (id === '10.0.8.11' || id === 'w10-a')
				? ({ id: 'ha', name: 'HostA', alias: 'w10-a', hostName: '10.0.8.11', port: 22, os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1 } as IAdeCloudHost)
				: undefined,
			testConnection: async alias => ({ ok: true, checkedAt: 1, remoteHome: alias === 'w10-a' ? hostAHome : hostBHome, latencyMs: 1 }),
			getEffectiveSshConfigPath: async () => '/dev/null',
			remoteReadFile: async () => VSBuffer.alloc(0),
			remoteWriteFile: async () => undefined,
			remoteMkdir: async () => undefined,
		};

		const svc = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'w10-cc-home'),
			socketPath: path.join(tempDir, 'w10.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: mockCloudHosts as IAdeCloudHostBackendService,
			customStorageTransport: transport,
			customLocalEngineProber: async () => ['kilo', 'claude'],
			logService: createNoopLogService(),
		}));
		await svc.whenReady();

		const proj = await svc.createProject({ folderUri: URI.file(wsDir).toString(), name: 'W10Proj' });
		const l1Kilo = await svc.uiCreateAgent({
			projectId: proj.meta.project_id, parentId: null, level: 1, name: 'KiloRoot', roleSummary: 'Root',
			host: 'local', engine: 'kilo', model: 'default', effort: 'medium',
		});
		// PEER2-HF-05: kilo-only project must NOT inject managed block into pre-existing root CLAUDE.md!
		const rootClaudeAfterKilo = await fs.promises.readFile(path.join(wsDir, 'CLAUDE.md'), 'utf8');
		assert.strictEqual(rootClaudeAfterKilo, preExistRootClaude);

		const cL1: IAdeVerifiedCliCaller = { projectId: proj.meta.project_id, agentId: l1Kilo.agent_id, host: 'local', tokenGen: l1Kilo.token_gen };
		const wbCreated = await svc.executeCliCommand(cL1, 'ade_wb_create', { name: 'BounceWB', host: 'local' }) as { board_id: string };
		const detailPayload = ' Bounce-Migration-Integrity-Payload '.repeat(60);
		const posted = await svc.executeCliCommand(cL1, 'ade_wb_post_msg', {
			boardId: wbCreated.board_id, summary: 'S', stars: 5, detail: detailPayload,
		}) as { item_id: string };

		// Epoch 1: local -> 10.0.8.11 (stalls in copyBlobForMigration)
		await svc.uiConfigureWhiteboard({ projectId: proj.meta.project_id, boardId: wbCreated.board_id, targetStorageHost: '10.0.8.11' });
		await epoch1ReachedGate.p;

		// Epoch 2 -> Epoch 3: switch to 10.0.8.22 then back to 10.0.8.11 while Epoch 1 is still stalled
		await svc.uiConfigureWhiteboard({ projectId: proj.meta.project_id, boardId: wbCreated.board_id, targetStorageHost: '10.0.8.22' });
		await svc.uiConfigureWhiteboard({ projectId: proj.meta.project_id, boardId: wbCreated.board_id, targetStorageHost: '10.0.8.11' });

		// Release Epoch 1 and wait for all migrations + GC tombstones to settle
		releaseEpoch1Gate.complete();
		for (let i = 0; i < 60; i++) {
			const snap = await svc.getProjectSnapshot(proj.meta.project_id);
			const wbRow = snap?.whiteboards.find(w => w.board_id === wbCreated.board_id);
			if (wbRow?.migration_state === 'completed') {
				break;
			}
			await new Promise(r => setTimeout(r, 25));
		}
		await svc.storageEngine.drainTombstonesAsync();

		const msgRes = await svc.executeCliCommand(cL1, 'ade_wb_get_msg', { boardId: wbCreated.board_id, itemId: posted.item_id }) as { detail: string };
		assert.strictEqual(msgRes.detail, detailPayload, 'Epoch 3 committed file must survive stale Epoch 1 tombstone cleanup');

		// Part B: HF-P4-04 & PEER2-HF-04 control chars & parent symlink GC guard
		await assert.rejects(
			() => svc.storageEngine.validateAndResolveLocalDownloadDest(path.join(tempDir, 'safe\nevil'), 'a.bin'),
			(err: unknown) => err instanceof AdeError && err.code === 'ERR_INVALID_ARGS',
		);
		const outsideVictim = path.join(tempDir, 'outside-victim.txt');
		await fs.promises.writeFile(outsideVictim, 'keep-alive', 'utf8');
		const wsRoot = path.join(svc.sqliteStore.adeHomeDir, 'workspaces');
		await fs.promises.mkdir(wsRoot, { recursive: true });
		const symlinkSub = path.join(wsRoot, 'sym-escape');
		await fs.promises.symlink(tempDir, symlinkSub);
		await svc.storageEngine.enqueueTombstones([{
			projectId: proj.meta.project_id,
			storageHost: 'local',
			storagePath: path.join(symlinkSub, 'outside-victim.txt'),
		}]);
		await svc.storageEngine.drainTombstonesAsync().catch(() => undefined);
		assert.strictEqual(await fs.promises.readFile(outsideVictim, 'utf8'), 'keep-alive');

		// Part C: HF-P3-01 16px tight face-contact obstacle & multi-ring RADIAL non-overlap
		const faceNodes: IOrchestrationGraphNode[] = [
			{ id: 'p', label: 'P', kind: 'staff' },
			{ id: 'c', label: 'C', kind: 'staff', parentId: 'p' },
			{ id: 'blk', label: 'BLK', kind: 'staff', parentId: 'p' },
		];
		const facePositions = new Map([
			['p', { x: 1000, y: 1000 }],
			['blk', { x: 1000 + ORCH_STAFF_CARD_WIDTH + 16, y: 1000 }],
			['c', { x: 1000 + (ORCH_STAFF_CARD_WIDTH + 16) * 2, y: 1000 }],
		]);
		const faceRoutes = computeOrchestrationMultiAnchorRoutes(
			faceNodes,
			[{ id: 'e1', from: 'p', to: 'c' }],
			facePositions,
			{ direction: 'LR', layoutMode: 'lr' },
		);
		const rE1 = faceRoutes.get('e1')!;
		assert.notStrictEqual(rE1.fromAnchor.side, 'right', 'Anchor must switch away from 16px blocked right side');

		const radialNodes: IOrchestrationGraphNode[] = [
			{ id: 'ceo', label: 'CEO', kind: 'staff' },
			...Array.from({ length: 16 }, (_, i): IOrchestrationGraphNode => ({ id: `m_${i}`, label: `M${i}`, kind: 'staff', parentId: 'ceo' })),
			...Array.from({ length: 4 }, (_, i): IOrchestrationGraphNode => ({ id: `w_${i}`, label: `W${i}`, kind: 'staff', parentId: 'm_0' })),
		];
		const radialEdges = radialNodes.filter(n => Boolean(n.parentId)).map(n => ({ id: `${n.parentId}->${n.id}`, from: n.parentId!, to: n.id }));
		const radialPos = computeOrchestrationLayoutPositions(radialNodes, radialEdges, [], { mode: 'radial' });
		for (let i = 0; i < radialNodes.length; i++) {
			for (let j = i + 1; j < radialNodes.length; j++) {
				const pa = radialPos.get(radialNodes[i].id)!;
				const pb = radialPos.get(radialNodes[j].id)!;
				const overlap = Math.abs(pa.x - pb.x) < ORCH_STAFF_CARD_WIDTH && Math.abs(pa.y - pb.y) < ORCH_STAFF_CARD_HEIGHT;
				assert.strictEqual(overlap, false, `RADIAL cards ${radialNodes[i].id} and ${radialNodes[j].id} must never overlap`);
			}
		}
	});
});
