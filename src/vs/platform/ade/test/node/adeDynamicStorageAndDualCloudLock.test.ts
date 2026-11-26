/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { PassThrough } from 'stream';
import { DeferredPromise } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import * as path from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogService, LogLevel } from '../../../log/common/log.js';
import { buildCloudProjectUri, IAdeCloudHost, IAdeCloudHostBackendService } from '../../common/adeCloudHosts.js';
import { IAdeVerifiedCliCaller } from '../../common/adeControlCenterIpc.js';
import { AdeError } from '../../common/adeModels.js';
import { AdeControlCenterService } from '../../node/adeControlCenterService.js';
import {
	AdeDynamicStorageEngine,
	IAdeStorageTransportAdapter,
	resolveTicketDetailStorageHost,
	verifySshStreamIntegrityGate,
} from '../../node/adeDynamicStorageEngine.js';
import { AdeSqliteStore } from '../../node/adeSqliteStore.js';

function createLocalShCustomTransport(
	hostsByKey: ReadonlyMap<string, { readonly ip: string; readonly alias: string; readonly remoteHome: string }>,
	options?: {
		readonly onCommand?: (alias: string, cmd: string) => void;
		readonly failCatWithExit255ForAlias?: Set<string>;
		readonly failDstWriteMidStreamExit255ForAlias?: Set<string>;
		readonly delayMs?: number;
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
			options?.onCommand?.(alias, remoteShCommand);
			const h = hostsByKey.get(alias);
			if (!h) {
				throw new Error(`Unknown alias ${alias}`);
			}
			await fs.promises.mkdir(h.remoteHome, { recursive: true });
			if (options?.delayMs) {
				await new Promise<void>(r => setTimeout(r, options.delayMs));
			}

			// Simulate destination SSH disconnecting mid-stream (exit 255) after creating partial "$tmp"
			if (options?.failDstWriteMidStreamExit255ForAlias?.has(alias) && remoteShCommand.includes('cat > "$tmp"')) {
				const failScript = remoteShCommand.replace(
					'cat > "$tmp"',
					'dd bs=1024 count=4 > "$tmp" 2>/dev/null || true; echo "SSH destination reset mid-stream" >&2; exit 255',
				);
				const child = spawn('/bin/sh', ['-c', failScript], {
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
			}

			// Simulate OpenSSH mid-stream `exit 255` truncation after emitting partial stdout + `end`
			if (options?.failCatWithExit255ForAlias?.has(alias) && remoteShCommand.includes('cat --')) {
				const stdin = new PassThrough();
				const stdout = new PassThrough();
				setImmediate(() => {
					stdout.write(Buffer.from('PARTIAL_TRUNCATED'));
					stdout.end();
				});
				return {
					stdin,
					stdout,
					waitClose: async () => ({ exitCode: 255, stderr: 'Connection reset by peer' }),
					kill: () => { stdout.destroy(); },
				};
			}

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

suite('adeDynamicStorageAndDualCloudLock Gate (plan.md §6 & §9.2.5)', function () {
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
		tempDir = await fs.promises.mkdtemp(path.join(baseTmp, 'ade-dse-'));
	});

	teardown(async () => {
		if (tempDir) {
			await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	test('verifies 4-quadrant routing matrix & 3-way SSH integrity gate (blocks exit 255 pseudo-EOF)', () => {
		assert.strictEqual(resolveTicketDetailStorageHost('local', 'local', '10.0.1.12'), 'local');
		assert.strictEqual(resolveTicketDetailStorageHost('10.0.1.12', '10.0.1.12', 'local'), '10.0.1.12');
		assert.strictEqual(resolveTicketDetailStorageHost('local', '10.0.1.12', 'local'), 'local');
		assert.strictEqual(resolveTicketDetailStorageHost('10.0.1.12', '10.0.1.99', '10.0.1.12'), '10.0.1.12');

		const sha = 'a'.repeat(64);
		assert.strictEqual(verifySshStreamIntegrityGate({
			exitCode: 0, actualBytes: 128, expectedBytes: 128, actualSha256: sha, expectedSha256: sha,
		}), true);
		assert.strictEqual(verifySshStreamIntegrityGate({
			exitCode: 255, actualBytes: 128, expectedBytes: 128, actualSha256: sha, expectedSha256: sha,
		}), false);
		assert.strictEqual(verifySshStreamIntegrityGate({
			exitCode: 0, actualBytes: 64, expectedBytes: 128, actualSha256: sha, expectedSha256: sha,
		}), false);
	});

	test('prevents AB-BA deadlock under maxDataStreamsPerHost=1, enforces zero-round-trip same-cloud copy, blocks exit 255 & symlink/sensitive paths, and honors pinBlobForRead(+1)', async function () {
		if (isWindows) {
			this.skip();
		}
		const homeA = path.join(tempDir, 'cloud-a-home');
		const homeB = path.join(tempDir, 'cloud-b-home');
		await fs.promises.mkdir(homeA, { recursive: true });
		await fs.promises.mkdir(homeB, { recursive: true });

		const hostMap = new Map([
			['10.0.1.11', { ip: '10.0.1.11', alias: 'cloud-a', remoteHome: homeA }],
			['cloud-a', { ip: '10.0.1.11', alias: 'cloud-a', remoteHome: homeA }],
			['10.0.1.22', { ip: '10.0.1.22', alias: 'cloud-b', remoteHome: homeB }],
			['cloud-b', { ip: '10.0.1.22', alias: 'cloud-b', remoteHome: homeB }],
		]);

		const executedCommands: Array<{ alias: string; cmd: string }> = [];
		const failSet = new Set<string>();
		const sql = trackSqliteStore(new AdeSqliteStore({ adeHomeDir: path.join(tempDir, 'ade-home') }));
		const engine = trackStorageEngine(new AdeDynamicStorageEngine({
			sqliteStore: sql,
			customTransport: createLocalShCustomTransport(hostMap, {
				onCommand: (alias, cmd) => executedCommands.push({ alias, cmd }),
				failCatWithExit255ForAlias: failSet,
				delayMs: 15,
			}),
			maxDataStreamsPerHost: 1,
			homedir: path.join(tempDir, 'mac-home'),
		}));

		try {
			// 1. Same-cloud Quadrant 2 (`10.0.1.11 -> 10.0.1.11`): single SSH remote copy with zero round-trip
			const sameCloudSrc = path.join(homeA, 'dataset.csv');
			await fs.promises.writeFile(sameCloudSrc, 'col1,col2\n1,2\n', 'utf8');
			executedCommands.length = 0;
			const samePtr = await engine.storeFileFromHost({
				sourceHost: '10.0.1.11',
				sourcePath: sameCloudSrc,
				targetStorageHost: '10.0.1.11',
				relSubdir: 'proj1_wb1',
				filePrefix: 'file_itm1',
				displayFilename: 'dataset.csv',
			});
			assert.strictEqual(samePtr.storage_host, '10.0.1.11');
			assert.strictEqual(executedCommands.length, 1, 'Same-cloud copy must execute in a single remote SSH command');

			// 2. Concurrent bidirectional `10.0.1.11 -> 10.0.1.22` AND `10.0.1.22 -> 10.0.1.11` with `maxDataStreamsPerHost = 1`:
			// `acquireOrderedDualHostSlots` locks lexicographically (`10.0.1.11` then `10.0.1.22`) -> 100% zero AB-BA deadlock!
			const srcOnB = path.join(homeB, 'weights.bin');
			await fs.promises.writeFile(srcOnB, 'WEIGHTS_PAYLOAD_B_TO_A', 'utf8');
			const [abPtr, baPtr] = await Promise.all([
				engine.storeFileFromHost({
					sourceHost: '10.0.1.11',
					sourcePath: sameCloudSrc,
					targetStorageHost: '10.0.1.22',
					relSubdir: 'proj1_wb1',
					filePrefix: 'ab',
					displayFilename: 'dataset.csv',
				}),
				engine.storeFileFromHost({
					sourceHost: '10.0.1.22',
					sourcePath: srcOnB,
					targetStorageHost: '10.0.1.11',
					relSubdir: 'proj1_wb1',
					filePrefix: 'ba',
					displayFilename: 'weights.bin',
				}),
			]);
			assert.strictEqual(await engine.readTextBlobVerified(abPtr), 'col1,col2\n1,2\n');
			assert.strictEqual(await engine.readTextBlobVerified(baPtr), 'WEIGHTS_PAYLOAD_B_TO_A');

			// 3. Simulated SSH `exit 255` mid-stream disconnect during download -> rejected & leaves zero partial file!
			failSet.add('cloud-b');
			const brokenDest = path.join(tempDir, 'should-not-exist.csv');
			await assert.rejects(() => engine.downloadBlobToHost({
				ptr: abPtr,
				fallbackFilename: 'dataset.csv',
				callerHost: 'local',
				rawDestPath: brokenDest,
				destIsDirHint: false,
			}));
			const brokenExists = await fs.promises.access(brokenDest).then(() => true, () => false);
			assert.strictEqual(brokenExists, false, 'Truncated SSH exit 255 download must never leave dirty destination file');
			failSet.delete('cloud-b');

			// 4. Sensitive directory & symlink escape guard on `--dest` -> ERR_INVALID_ARGS
			const macHome = path.join(tempDir, 'mac-home');
			await fs.promises.mkdir(path.join(macHome, '.ssh'), { recursive: true });
			const symlinkEscape = path.join(tempDir, 'escape-link');
			await fs.promises.symlink(path.join(macHome, '.ssh'), symlinkEscape);

			await assert.rejects(
				() => engine.downloadBlobToHost({
					ptr: abPtr,
					fallbackFilename: 'authorized_keys',
					callerHost: 'local',
					rawDestPath: path.join(symlinkEscape, 'authorized_keys'),
					destIsDirHint: false,
				}),
				(err: unknown) => err instanceof AdeError && err.code === 'ERR_INVALID_ARGS',
			);

			// 5. Synchronous `pinBlobForRead(+1)` protects active download from concurrent tombstone GC deletion!
			const localPtr = await engine.storeTextBlob({
				targetStorageHost: 'local',
				relSubdir: 'proj1_wb1',
				filePrefix: 'pinned_msg',
				text: 'Pinned content protected during slow download',
			});
			const unpin = engine.pinBlobForRead('local', localPtr.storage_path);
			await engine.enqueueTombstones([{
				projectId: 'proj1',
				storageHost: 'local',
				storagePath: localPtr.storage_path,
			}]);
			await engine.drainTombstonesAsync();

			// While pinned, physical file MUST still exist and be readable!
			assert.strictEqual(await engine.readTextBlobVerified(localPtr), 'Pinned content protected during slow download');

			// Once unpinned, draining tombstones physically deletes the file!
			unpin();
			await engine.drainTombstonesAsync();
			const existsAfterUnpin = await fs.promises.access(localPtr.storage_path).then(() => true, () => false);
			assert.strictEqual(existsAfterUnpin, false);
		} finally {
			await sql.shutdownAll();
		}
	});

	test('converges multi-hop CAS online storage migration (local -> cloudA -> cloudB) and purges old source copies', async function () {
		if (isWindows) {
			this.skip();
		}
		const homeA = path.join(tempDir, 'mig-cloud-a');
		const homeB = path.join(tempDir, 'mig-cloud-b');
		await fs.promises.mkdir(homeA, { recursive: true });
		await fs.promises.mkdir(homeB, { recursive: true });

		const hostMap = new Map([
			['10.0.2.11', { ip: '10.0.2.11', alias: 'mig-a', remoteHome: homeA }],
			['mig-a', { ip: '10.0.2.11', alias: 'mig-a', remoteHome: homeA }],
			['10.0.2.22', { ip: '10.0.2.22', alias: 'mig-b', remoteHome: homeB }],
			['mig-b', { ip: '10.0.2.22', alias: 'mig-b', remoteHome: homeB }],
		]);

		const hostChangedEmitter = store.add(new Emitter<void>());
		const mockHosts: IAdeCloudHost[] = [
			{
				id: 'h1', name: 'CloudA', alias: 'mig-a', hostName: '10.0.2.11', user: 'dev', port: 22,
				os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
			},
			{
				id: 'h2', name: 'CloudB', alias: 'mig-b', hostName: '10.0.2.22', user: 'dev', port: 22,
				os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
			},
		];
		const fakeCloudService: Partial<IAdeCloudHostBackendService> = {
			onDidChangeHosts: hostChangedEmitter.event,
			listHosts: async () => mockHosts,
			getHost: async idOrAlias => mockHosts.find(h => h.alias === idOrAlias || h.hostName === idOrAlias || h.id === idOrAlias),
		};
		const rawFakeCloud: unknown = fakeCloudService;

		const svc = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'ade-mig-home'),
			socketPath: path.join(tempDir, 'm.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: rawFakeCloud as IAdeCloudHostBackendService,
			customStorageTransport: createLocalShCustomTransport(hostMap, { delayMs: 25 }),
			customLocalEngineProber: async () => ['claude'],
		}));
		await svc.whenReady();

		try {
			const wsDir = path.join(tempDir, 'ws-mig');
			await fs.promises.mkdir(wsDir, { recursive: true });
			const f1 = path.join(wsDir, 'part1.txt');
			const f2 = path.join(wsDir, 'part2.txt');
			await fs.promises.writeFile(f1, 'PART_ONE_DATA', 'utf8');
			await fs.promises.writeFile(f2, 'PART_TWO_DATA', 'utf8');

			const proj = await svc.createProject({ folderUri: URI.file(wsDir).toString(), name: 'MigProj' });
			const pid = proj.meta.project_id;
			const l1 = await svc.uiCreateAgent({
				projectId: pid, parentId: null, level: 1, name: 'L1', roleSummary: 'Lead',
				host: 'local', engine: 'claude', model: 'claude-sonnet-4-5', effort: 'high',
			});
			const caller: IAdeVerifiedCliCaller = { projectId: pid, agentId: l1.agent_id, host: 'local', tokenGen: 1 };

			const wb = await svc.executeCliCommand(caller, 'ade_wb_create', { name: 'MigBoard', host: 'local' });
			const boardId = String(wb.board_id);

			const it1 = String((await svc.executeCliCommand(caller, 'ade_wb_upload_file', { boardId, file: f1, summary: 'P1', stars: '5' })).item_id);
			const it2 = String((await svc.executeCliCommand(caller, 'ade_wb_upload_file', { boardId, file: f2, summary: 'P2', stars: '4' })).item_id);

			// Wait event-driven via `onDidChangeProject` for background CAS migration to converge to `completed`
			const migrationDone = new DeferredPromise<void>();
			const checkConverged = async () => {
				const snap = await svc.getProjectSnapshot(pid);
				const curWb = snap?.whiteboards.find(w => w.board_id === boardId);
				if (curWb?.migration_state === 'completed' && curWb.storage_host === '10.0.2.22') {
					migrationDone.complete();
				}
			};
			const sub = svc.onDidChangeProject(ev => {
				if (ev.projectId === pid) {
					void checkConverged();
				}
			});
			try {
				await svc.uiConfigureWhiteboard({ projectId: pid, boardId, targetStorageHost: '10.0.2.11' });
				await new Promise<void>(r => setTimeout(r, 15));
				await svc.uiConfigureWhiteboard({ projectId: pid, boardId, targetStorageHost: '10.0.2.22' });
				await checkConverged();
				await migrationDone.p;
			} finally {
				sub.dispose();
			}
			await svc.storageEngine.drainTombstonesAsync();

			const finalSnap = await svc.getProjectSnapshot(pid);
			const finalWb = finalSnap!.whiteboards.find(w => w.board_id === boardId)!;
			assert.strictEqual(finalWb.storage_host, '10.0.2.22');
			assert.strictEqual(finalWb.migration_state, 'completed');

			// Verify both files now live on `10.0.2.22` (cloudB), are intact when downloaded, and old local copies were purged!
			const pdb = svc.sqliteStore.openProjectDb(pid);
			const rows = await pdb.all<{ item_id: string; storage_host: string; storage_path: string }>(
				`SELECT item_id, storage_host, storage_path FROM whiteboard_items WHERE board_id = ?`,
				[boardId],
			);
			assert.strictEqual(rows.length, 2);
			for (const r of rows) {
				assert.strictEqual(r.storage_host, '10.0.2.22');
				assert.ok(r.storage_path.startsWith(homeB));
			}

			const out1 = path.join(tempDir, 'out1.txt');
			const out2 = path.join(tempDir, 'out2.txt');
			await svc.executeCliCommand(caller, 'ade_wb_download', { boardId, itemId: it1, dest: out1 });
			await svc.executeCliCommand(caller, 'ade_wb_download', { boardId, itemId: it2, dest: out2 });
			assert.strictEqual(await fs.promises.readFile(out1, 'utf8'), 'PART_ONE_DATA');
			assert.strictEqual(await fs.promises.readFile(out2, 'utf8'), 'PART_TWO_DATA');

			const localWbDir = path.join(svc.sqliteStore.localStoreRootDir, `${pid}_${boardId}`);
			const leftoverLocal = await fs.promises.readdir(localWbDir).catch(() => [] as string[]);
			assert.deepStrictEqual(leftoverLocal, [], 'Old local copies must be purged via tombstones after migrating to cloudB');
		} finally {
			await svc.gracefulShutdown();
		}
	});

	test('blocks shell command injection in remote download fallbackFilename ($(...), backticks, quotes)', async function () {
		if (isWindows) {
			this.skip();
		}
		const homeA = path.join(tempDir, 'rce-cloud-a');
		const dlDir = path.join(homeA, 'downloads');
		await fs.promises.mkdir(dlDir, { recursive: true });

		const pwnCmdSub = path.join(tempDir, 'pwn_cmdsub');
		const pwnBacktick = path.join(tempDir, 'pwn_backtick');
		const pwnQuote = path.join(tempDir, 'pwn_quote');

		const hostMap = new Map([
			['10.0.3.11', { ip: '10.0.3.11', alias: 'rce-a', remoteHome: homeA }],
			['rce-a', { ip: '10.0.3.11', alias: 'rce-a', remoteHome: homeA }],
		]);
		const sql = trackSqliteStore(new AdeSqliteStore({ adeHomeDir: path.join(tempDir, 'ade-rce-home') }));
		const engine = trackStorageEngine(new AdeDynamicStorageEngine({
			sqliteStore: sql,
			customTransport: createLocalShCustomTransport(hostMap),
			maxDataStreamsPerHost: 2,
			homedir: path.join(tempDir, 'mac-rce-home'),
		}));

		try {
			const ptr = await engine.storeTextBlob({
				targetStorageHost: 'local',
				relSubdir: 'proj_rce_wb',
				filePrefix: 'rce_blob',
				text: 'SAFE_PAYLOAD_BODY',
			});

			const maliciousNames = [
				`report-$(touch ${path.basename(pwnCmdSub)}).txt`,
				`notes-\`touch ${path.basename(pwnBacktick)}\`.md`,
				`quote"; touch ${path.basename(pwnQuote)}; echo ".log`,
				`$(touch ${pwnCmdSub})`,
			];

			for (const badName of maliciousNames) {
				const savedAt = await engine.downloadBlobToHost({
					ptr,
					fallbackFilename: badName,
					callerHost: '10.0.3.11',
					rawDestPath: '~/downloads/',
					destIsDirHint: true,
				});
				assert.strictEqual(await fs.promises.readFile(savedAt, 'utf8'), 'SAFE_PAYLOAD_BODY');
			}

			for (const pwnTarget of [
				pwnCmdSub,
				pwnBacktick,
				pwnQuote,
				path.join(homeA, path.basename(pwnCmdSub)),
				path.join(homeA, path.basename(pwnBacktick)),
				path.join(homeA, path.basename(pwnQuote)),
			]) {
				const triggered = await fs.promises.access(pwnTarget).then(() => true, () => false);
				assert.strictEqual(triggered, false, `Remote command injection must NEVER execute: ${pwnTarget}`);
			}
		} finally {
			await sql.shutdownAll();
		}
	});

	test('migrates whiteboard msg items with non-empty --detail across hosts (including legacy NULL detail_size defense) and cleans remote board directory on delete', async function () {
		if (isWindows) {
			this.skip();
		}
		const homeCloud = path.join(tempDir, 'wb-msg-cloud');
		await fs.promises.mkdir(homeCloud, { recursive: true });

		// 1. Verify idempotent ALTER TABLE migration on a legacy state.db missing `detail_size`
		const legacyAdeHome = path.join(tempDir, 'ade-legacy-db-home');
		const legacyDbDir = path.join(legacyAdeHome, 'control-center', 'projects', 'proj_legacy');
		await fs.promises.mkdir(legacyDbDir, { recursive: true });
		const sqlite3Mod = await import('@vscode/sqlite3').then(m => (m.default ?? m) as typeof import('@vscode/sqlite3'));
		const legacyDbPath = path.join(legacyDbDir, 'state.db');
		await new Promise<void>((resolve, reject) => {
			const raw = new sqlite3Mod.Database(legacyDbPath, err => {
				if (err) {
					reject(err);
					return;
				}
				raw.exec(
					`CREATE TABLE whiteboard_items (
					   item_id TEXT PRIMARY KEY,
					   board_id TEXT NOT NULL,
					   item_type TEXT NOT NULL,
					   author_id TEXT NOT NULL,
					   summary TEXT NOT NULL,
					   stars INTEGER NOT NULL,
					   tags TEXT NOT NULL DEFAULT '[]',
					   is_pinned INTEGER NOT NULL DEFAULT 0,
					   has_detail INTEGER NOT NULL DEFAULT 0,
					   file_filename TEXT,
					   file_size INTEGER,
					   blob_id TEXT,
					   storage_host TEXT,
					   storage_path TEXT,
					   sha256 TEXT,
					   content_rev INTEGER NOT NULL DEFAULT 1,
					   created_at INTEGER NOT NULL,
					   updated_at INTEGER NOT NULL
					 );`,
					e2 => raw.close(() => (e2 ? reject(e2) : resolve())),
				);
			});
		});
		const legacyStore = trackSqliteStore(new AdeSqliteStore({ adeHomeDir: legacyAdeHome }));
		try {
			const migratedPdb = legacyStore.openProjectDb('proj_legacy');
			const cols = await migratedPdb.all<{ name: string }>('PRAGMA table_info(whiteboard_items)');
			assert.strictEqual(cols.some(c => c.name === 'detail_size'), true, 'Legacy whiteboard_items must auto-add detail_size column on open');
		} finally {
			await legacyStore.shutdownAll();
		}

		// 2. End-to-end online CAS migration of msg items with --detail (plus simulated legacy detail_size = NULL row) & cloud board deletion
		const hostMap = new Map([
			['10.0.4.22', { ip: '10.0.4.22', alias: 'msg-cloud', remoteHome: homeCloud }],
			['msg-cloud', { ip: '10.0.4.22', alias: 'msg-cloud', remoteHome: homeCloud }],
		]);
		const hostChangedEmitter = store.add(new Emitter<void>());
		const mockHosts: IAdeCloudHost[] = [{
			id: 'h_msg', name: 'MsgCloud', alias: 'msg-cloud', hostName: '10.0.4.22', user: 'dev', port: 22,
			os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
		}];
		const fakeCloudService: Partial<IAdeCloudHostBackendService> = {
			onDidChangeHosts: hostChangedEmitter.event,
			listHosts: async () => mockHosts,
			getHost: async idOrAlias => mockHosts.find(h => h.alias === idOrAlias || h.hostName === idOrAlias || h.id === idOrAlias),
		};

		const svc = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'ade-msg-mig-home'),
			socketPath: path.join(tempDir, 'msgmig.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: fakeCloudService as IAdeCloudHostBackendService,
			customStorageTransport: createLocalShCustomTransport(hostMap),
			customLocalEngineProber: async () => ['claude'],
		}));
		await svc.whenReady();

		try {
			const wsDir = path.join(tempDir, 'ws-msg-mig');
			await fs.promises.mkdir(wsDir, { recursive: true });
			const proj = await svc.createProject({ folderUri: URI.file(wsDir).toString(), name: 'MsgMigProj' });
			const pid = proj.meta.project_id;
			const l1 = await svc.uiCreateAgent({
				projectId: pid, parentId: null, level: 1, name: 'L1', roleSummary: 'Lead',
				host: 'local', engine: 'claude', model: 'claude-sonnet-4-5', effort: 'high',
			});
			const caller: IAdeVerifiedCliCaller = { projectId: pid, agentId: l1.agent_id, host: 'local', tokenGen: 1 };

			const wb = await svc.executeCliCommand(caller, 'ade_wb_create', { name: 'ArchBoard', host: 'local' });
			const boardId = String(wb.board_id);

			const detailText1 = 'Detailed architectural proof for msg item 1 (UTF-8 中文校验 🚀).';
			const detailText2Updated = 'Updated detailed design after ade_wb_edit_item — non-zero byte length.';
			const msg1 = String((await svc.executeCliCommand(caller, 'ade_wb_post_msg', {
				boardId, summary: 'Msg1', stars: '5', detail: detailText1,
			})).item_id);
			const msg2 = String((await svc.executeCliCommand(caller, 'ade_wb_post_msg', {
				boardId, summary: 'Msg2', stars: '4', detail: 'Initial draft',
			})).item_id);
			await svc.executeCliCommand(caller, 'ade_wb_edit_item', {
				boardId, itemId: msg2, detail: detailText2Updated,
			});

			const pdb = svc.sqliteStore.openProjectDb(pid);
			const preRow2 = await pdb.get<{ detail_size: number | null }>('SELECT detail_size FROM whiteboard_items WHERE item_id = ?', [msg2]);
			assert.strictEqual(preRow2?.detail_size, Buffer.byteLength(detailText2Updated, 'utf8'));

			// Simulate a pre-migration legacy msg1 row where `detail_size` was NULL -> forces `expectedBytes = 0` defense!
			await pdb.run('UPDATE whiteboard_items SET detail_size = NULL WHERE item_id = ?', [msg1]);

			const converged = new DeferredPromise<void>();
			const checkState = async () => {
				const snap = await svc.getProjectSnapshot(pid);
				const b = snap?.whiteboards.find(w => w.board_id === boardId);
				if (b && b.storage_host === '10.0.4.22' && (b.migration_state === 'completed' || b.migration_state === 'failed')) {
					converged.complete();
				}
			};
			const sub = svc.onDidChangeProject(ev => {
				if (ev.projectId === pid) {
					void checkState();
				}
			});
			try {
				await svc.uiConfigureWhiteboard({ projectId: pid, boardId, targetStorageHost: '10.0.4.22' });
				await checkState();
				await converged.p;
			} finally {
				sub.dispose();
			}
			await svc.storageEngine.drainTombstonesAsync();

			const snapAfter = await svc.getProjectSnapshot(pid);
			const wbAfter = snapAfter!.whiteboards.find(w => w.board_id === boardId)!;
			assert.strictEqual(wbAfter.migration_state, 'completed', 'Whiteboard msg CAS migration must succeed (never fail on size_bytes=0)');

			const read1 = await svc.executeCliCommand(caller, 'ade_wb_get_msg', { boardId, itemId: msg1 });
			assert.strictEqual(read1.detail, detailText1);
			assert.strictEqual(await svc.uiReadWhiteboardItemDetail(pid, boardId, msg2), detailText2Updated);

			const postRow1 = await pdb.get<{ storage_host: string; detail_size: number | null }>('SELECT storage_host, detail_size FROM whiteboard_items WHERE item_id = ?', [msg1]);
			assert.strictEqual(postRow1?.storage_host, '10.0.4.22');
			assert.strictEqual(postRow1?.detail_size, Buffer.byteLength(detailText1, 'utf8'));

			// Verify remote directory exists before deleting the cloud whiteboard, and is physically removed after deletion!
			const remoteBoardDir = path.join(homeCloud, '.ade_store', `${pid}_${boardId}`);
			assert.strictEqual(await fs.promises.access(remoteBoardDir).then(() => true, () => false), true);

			await svc.uiDeleteWhiteboard(pid, boardId);
			await svc.storageEngine.drainTombstonesAsync();
			assert.strictEqual(
				await fs.promises.access(remoteBoardDir).then(() => true, () => false),
				false,
				'Deleting a cloud whiteboard must enqueue isDir=true tombstone and remove remote ~/.ade_store/<proj>_<board> directory',
			);
		} finally {
			await svc.gracefulShutdown();
		}
	});

	test('prevents backpressure deadlock when destination SSH exits 255 mid-stream in Case C (IP_A -> IP_B), preserves existing dstPath, cleans .tmp, and releases all semaphore slots', async function () {
		if (isWindows) {
			this.skip();
		}
		const homeA = path.join(tempDir, 'deadlock-a');
		const homeB = path.join(tempDir, 'deadlock-b');
		await fs.promises.mkdir(homeA, { recursive: true });
		await fs.promises.mkdir(path.join(homeB, 'downloads'), { recursive: true });

		const hostMap = new Map([
			['10.0.5.11', { ip: '10.0.5.11', alias: 'dl-a', remoteHome: homeA }],
			['dl-a', { ip: '10.0.5.11', alias: 'dl-a', remoteHome: homeA }],
			['10.0.5.22', { ip: '10.0.5.22', alias: 'dl-b', remoteHome: homeB }],
			['dl-b', { ip: '10.0.5.22', alias: 'dl-b', remoteHome: homeB }],
		]);

		const failDstSet = new Set<string>(['dl-b']);
		const sql = trackSqliteStore(new AdeSqliteStore({ adeHomeDir: path.join(tempDir, 'ade-dl-home') }));
		const engine = trackStorageEngine(new AdeDynamicStorageEngine({
			sqliteStore: sql,
			customTransport: createLocalShCustomTransport(hostMap, {
				failDstWriteMidStreamExit255ForAlias: failDstSet,
			}),
			maxDataStreamsPerHost: 1,
			homedir: path.join(tempDir, 'mac-dl-home'),
		}));

		try {
			// 2MB source file on cloud-a (>30x 64KB highWaterMark so bare .pipe() would stall forever if dst dies!)
			const largeSrc = path.join(homeA, 'large-2mb.bin');
			const largeBuf = Buffer.alloc(2 * 1024 * 1024, 0x41);
			await fs.promises.writeFile(largeSrc, largeBuf);
			const srcPtr = await engine.storeFileFromHost({
				sourceHost: '10.0.5.11',
				sourcePath: largeSrc,
				targetStorageHost: '10.0.5.11',
				relSubdir: 'proj_dl_wb',
				filePrefix: 'big',
				displayFilename: 'large-2mb.bin',
			});

			// Pre-existing formal destination file on cloud-b MUST NOT be deleted when tmp write fails!
			const existingFormalDst = path.join(homeB, 'downloads', 'target.bin');
			await fs.promises.writeFile(existingFormalDst, 'EXISTING_IMPORTANT_DATA', 'utf8');

			let timer1: ReturnType<typeof setTimeout> | undefined;
			try {
				await assert.rejects(() => Promise.race([
					engine.downloadBlobToHost({
						ptr: srcPtr,
						fallbackFilename: 'target.bin',
						callerHost: '10.0.5.22',
						rawDestPath: existingFormalDst,
					}),
					new Promise<never>((_, reject) => {
						timer1 = setTimeout(() => reject(new Error('Deadlock detected: Case C hung on destination exit 255!')), 5_000);
					}),
				]));
			} finally {
				if (timer1 !== undefined) {
					clearTimeout(timer1);
				}
			}

			// 1. Existing formal dstPath was NOT mistakenly deleted!
			assert.strictEqual(await fs.promises.readFile(existingFormalDst, 'utf8'), 'EXISTING_IMPORTANT_DATA');

			// 2. Partial .tmp.* file on cloud-b WAS cleaned up!
			const dlEntries = await fs.promises.readdir(path.join(homeB, 'downloads'));
			assert.deepStrictEqual(dlEntries, ['target.bin'], `Leftover .tmp files must be cleaned: ${dlEntries.join(', ')}`);

			// 3. With maxDataStreamsPerHost=1, both host semaphore slots MUST be returned immediately!
			failDstSet.clear();
			let timer2: ReturnType<typeof setTimeout> | undefined;
			let recoveredOut: string;
			try {
				recoveredOut = await Promise.race([
					engine.downloadBlobToHost({
						ptr: srcPtr,
						fallbackFilename: 'target.bin',
						callerHost: '10.0.5.22',
						rawDestPath: path.join(homeB, 'downloads', 'recovered.bin'),
					}),
					new Promise<never>((_, reject) => {
						timer2 = setTimeout(() => reject(new Error('Semaphore slot leak detected after failed Case C transfer!')), 5_000);
					}),
				]);
			} finally {
				if (timer2 !== undefined) {
					clearTimeout(timer2);
				}
			}
			const recoveredStat = await fs.promises.stat(recoveredOut);
			assert.strictEqual(recoveredStat.size, largeBuf.byteLength);
		} finally {
			await sql.shutdownAll();
		}
	});

	test('serializes 4-stage gracefulShutdown & dispose() during active CAS migration without "AdeSqliteStore is shutting down" and reentrantly converges WAL on shutdownAll()', async function () {
		if (isWindows) {
			this.skip();
		}

		// Part A: AdeSqliteStore.shutdownAll() shares a single in-flight Promise across concurrent/dispose calls and truncates WAL before resolving
		const reentrantAdeHome = path.join(tempDir, 'ade-reentrant-sql');
		const reentrantStore = trackSqliteStore(new AdeSqliteStore({ adeHomeDir: reentrantAdeHome }));
		const projDbA = reentrantStore.openProjectDb('proj_wal_a');
		const projDbB = reentrantStore.openProjectDb('proj_wal_b');
		await reentrantStore.catalog.run(
			`INSERT INTO workspace_folders (folder_id, folder_uri, display_name, host, sort_order, collapsed, created_at, updated_at)
			 VALUES ('f1', 'file:///tmp/w1', 'W1', 'local', 0, 0, 1, 1)`,
		);
		await projDbA.run(
			`INSERT INTO project_meta (project_id, folder_id, folder_uri, name, cross_host_ticket_storage, ticket_migration_epoch, ticket_migration_state, layout_direction, created_at, updated_at)
			 VALUES ('proj_wal_a', 'f1', 'file:///tmp/w1', 'WalA', 'local', 0, 'idle', 'TD', 1, 1)`,
		);
		await projDbB.run(
			`INSERT INTO project_meta (project_id, folder_id, folder_uri, name, cross_host_ticket_storage, ticket_migration_epoch, ticket_migration_state, layout_direction, created_at, updated_at)
			 VALUES ('proj_wal_b', 'f1', 'file:///tmp/w1', 'WalB', 'local', 0, 'idle', 'TD', 1, 1)`,
		);

		const p1 = reentrantStore.shutdownAll();
		reentrantStore.dispose();
		const p2 = reentrantStore.shutdownAll();
		assert.strictEqual(p1, p2, 'Concurrent/repeated shutdownAll() must return the exact same pending Promise');
		await Promise.all([p1, p2]);

		for (const dbFile of [
			path.join(reentrantStore.controlCenterDir, 'catalog.db'),
			reentrantStore.getProjectDbPath('proj_wal_a'),
			reentrantStore.getProjectDbPath('proj_wal_b'),
		]) {
			const walStat = await fs.promises.stat(`${dbFile}-wal`).catch(() => undefined);
			assert.ok(!walStat || walStat.size === 0, `Expected WAL truncated/removed after shutdownAll() for ${dbFile}, got size=${walStat?.size}`);
		}

		// Part B: AdeControlCenterService.dispose() + concurrent gracefulShutdown() during active CAS migration
		const homeCloud = path.join(tempDir, 'shutdown-mig-cloud');
		await fs.promises.mkdir(homeCloud, { recursive: true });
		const hostMap = new Map([
			['10.0.6.22', { ip: '10.0.6.22', alias: 'sd-cloud', remoteHome: homeCloud }],
			['sd-cloud', { ip: '10.0.6.22', alias: 'sd-cloud', remoteHome: homeCloud }],
		]);
		const hostChangedEmitter = store.add(new Emitter<void>());
		const mockHosts: IAdeCloudHost[] = [{
			id: 'h_sd', name: 'SdCloud', alias: 'sd-cloud', hostName: '10.0.6.22', user: 'dev', port: 22,
			os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
		}];
		const fakeCloudService: Partial<IAdeCloudHostBackendService> = {
			onDidChangeHosts: hostChangedEmitter.event,
			listHosts: async () => mockHosts,
			getHost: async idOrAlias => mockHosts.find(h => h.alias === idOrAlias || h.hostName === idOrAlias || h.id === idOrAlias),
		};

		const loggedIssues: string[] = [];
		const formatLogArgs = (msg: string | Error, args: unknown[]) => [
			msg instanceof Error ? (msg.stack ?? msg.message) : msg,
			...args.map(a => a instanceof Error ? (a.stack ?? a.message) : String(a)),
		].join(' ');
		const spyLogService: ILogService = {
			_serviceBrand: undefined,
			onDidChangeLogLevel: Event.None,
			setLevel(_level: LogLevel): void { },
			getLevel(): LogLevel { return LogLevel.Info; },
			trace(): void { },
			debug(): void { },
			info(): void { },
			warn(message: string, ...args: unknown[]): void {
				loggedIssues.push(formatLogArgs(message, args));
			},
			error(message: string | Error, ...args: unknown[]): void {
				loggedIssues.push(formatLogArgs(message, args));
			},
			flush(): void { },
			dispose(): void { },
		};

		const enteredSlowUpload = new DeferredPromise<void>();
		const slowTransport: IAdeStorageTransportAdapter = {
			async getEffectiveSshConfigPath() {
				return '/dev/null';
			},
			async resolveHost(ipOrAlias: string) {
				const h = hostMap.get(ipOrAlias);
				if (!h) {
					throw new AdeError('ERR_INVALID_ARGS', `Unknown host ${ipOrAlias}`);
				}
				return { ip: h.ip, alias: h.alias, os: 'linux', remoteHome: h.remoteHome };
			},
			async spawnSshStream(alias: string, remoteShCommand: string) {
				const h = hostMap.get(alias)!;
				await fs.promises.mkdir(h.remoteHome, { recursive: true });
				// Hold the destination cat stream open until aborted by abortActiveStreamsForShutdown()
				if (remoteShCommand.includes('cat > "$tmp"')) {
					const stallScript = remoteShCommand.replace('cat > "$tmp"', 'touch "$tmp"; sleep 30');
					const child = spawn('/bin/sh', ['-c', stallScript], {
						stdio: ['pipe', 'pipe', 'pipe'],
						env: { ...process.env, HOME: h.remoteHome },
					});
					enteredSlowUpload.complete();
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
							try { child.kill('SIGTERM'); } catch { /* ignore */ }
						},
					};
				}
				return createLocalShCustomTransport(hostMap).spawnSshStream!(alias, remoteShCommand);
			},
		};

		const sdAdeHome = path.join(tempDir, 'ade-sd-mig-home');
		const svc = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: sdAdeHome,
			socketPath: path.join(tempDir, 'sdmig.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: fakeCloudService as IAdeCloudHostBackendService,
			customStorageTransport: slowTransport,
			customLocalEngineProber: async () => ['claude'],
			logService: spyLogService,
		}));
		await svc.whenReady();

		const wsDir = path.join(tempDir, 'ws-sd-mig');
		await fs.promises.mkdir(wsDir, { recursive: true });
		const f1 = path.join(wsDir, 'mig1.txt');
		const f2 = path.join(wsDir, 'mig2.txt');
		await fs.promises.writeFile(f1, 'MIG_PAYLOAD_ONE', 'utf8');
		await fs.promises.writeFile(f2, 'MIG_PAYLOAD_TWO', 'utf8');

		const proj = await svc.createProject({ folderUri: URI.file(wsDir).toString(), name: 'ShutdownMigProj' });
		const pid = proj.meta.project_id;
		const stateDbPath = svc.sqliteStore.getProjectDbPath(pid);
		const l1 = await svc.uiCreateAgent({
			projectId: pid, parentId: null, level: 1, name: 'L1', roleSummary: 'Lead',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-5', effort: 'high',
		});
		const caller: IAdeVerifiedCliCaller = { projectId: pid, agentId: l1.agent_id, host: 'local', tokenGen: 1 };
		const wb = await svc.executeCliCommand(caller, 'ade_wb_create', { name: 'ShutdownBoard', host: 'local' });
		const boardId = String(wb.board_id);
		await svc.executeCliCommand(caller, 'ade_wb_upload_file', { boardId, file: f1, summary: 'F1', stars: '5' });
		await svc.executeCliCommand(caller, 'ade_wb_upload_file', { boardId, file: f2, summary: 'F2', stars: '4' });

		await svc.uiConfigureWhiteboard({ projectId: pid, boardId, targetStorageHost: '10.0.6.22' });
		await enteredSlowUpload.p;

		// Call synchronous dispose() FIRST (previously triggered super.dispose() & sqliteStore.dispose() prematurely!),
		// followed immediately by concurrent gracefulShutdown() calls.
		svc.dispose();
		const gs1 = svc.gracefulShutdown();
		const gs2 = svc.gracefulShutdown();
		assert.strictEqual(gs1, gs2, 'dispose() and concurrent gracefulShutdown() must share the exact same shutdownPromise');
		await Promise.all([gs1, gs2]);

		for (const issue of loggedIssues) {
			assert.strictEqual(issue.includes('AdeSqliteStore is shutting down'), false, `Unexpected premature sqlite shutdown error: ${issue}`);
			assert.strictEqual(issue.includes('SQLite database already closed'), false, `Unexpected closed DB race during shutdown: ${issue}`);
		}

		const stateWalStat = await fs.promises.stat(`${stateDbPath}-wal`).catch(() => undefined);
		assert.ok(!stateWalStat || stateWalStat.size === 0, `state.db WAL must be checkpointed & truncated on gracefulShutdown, got size=${stateWalStat?.size}`);

		const sqlite3Mod = await import('@vscode/sqlite3').then(m => (m.default ?? m) as typeof import('@vscode/sqlite3'));
		const persistedState = await new Promise<string | undefined>((resolve, reject) => {
			const raw = new sqlite3Mod.Database(stateDbPath, sqlite3Mod.OPEN_READONLY, err => {
				if (err) {
					reject(err);
					return;
				}
				raw.get(`SELECT migration_state FROM whiteboards WHERE board_id = ?`, [boardId], (qErr, row?: { migration_state?: string }) => {
					raw.close(() => (qErr ? reject(qErr) : resolve(row?.migration_state)));
				});
			});
		});
		assert.strictEqual(persistedState, 'failed', 'Aborted active migration must durably record migration_state="failed" before SQLite WAL close');
	});

	test('cleans remote dstPath.tmp.uuid via POSIX trap on SIGHUP/ENOSPC and via bestEffortDeleteTempFile in Node catch across all remote write/copy paths', async function () {
		if (isWindows) {
			this.skip();
		}
		const homeA = path.join(tempDir, 'trap-cloud-a');
		const homeB = path.join(tempDir, 'trap-cloud-b');
		await fs.promises.mkdir(path.join(homeA, 'dl'), { recursive: true });
		await fs.promises.mkdir(path.join(homeB, 'dl'), { recursive: true });

		const hostMap = new Map([
			['10.0.7.11', { ip: '10.0.7.11', alias: 'trap-a', remoteHome: homeA }],
			['trap-a', { ip: '10.0.7.11', alias: 'trap-a', remoteHome: homeA }],
			['10.0.7.22', { ip: '10.0.7.22', alias: 'trap-b', remoteHome: homeB }],
			['trap-b', { ip: '10.0.7.22', alias: 'trap-b', remoteHome: homeB }],
		]);

		const capturedScripts: string[] = [];
		const cleanupCommands: string[] = [];
		let injectFailureMode: 'none' | 'sighup_offline' | 'sigkill_online' = 'none';
		let hostOfflineAfterDrop = false;

		const trapTransport: IAdeStorageTransportAdapter = {
			async getEffectiveSshConfigPath() {
				return '/dev/null';
			},
			async resolveHost(ipOrAlias: string) {
				const h = hostMap.get(ipOrAlias);
				if (!h) {
					throw new AdeError('ERR_INVALID_ARGS', `Unknown host ${ipOrAlias}`);
				}
				return { ip: h.ip, alias: h.alias, os: 'linux', remoteHome: h.remoteHome };
			},
			async spawnSshStream(alias: string, remoteShCommand: string) {
				const h = hostMap.get(alias)!;
				await fs.promises.mkdir(h.remoteHome, { recursive: true });
				if (remoteShCommand.includes('tmp="$d.tmp.$u"')) {
					capturedScripts.push(remoteShCommand);
				}
				if (remoteShCommand.includes('if [ -f "$p" ] && [ ! -L "$p" ]; then rm -f -- "$p"; fi')) {
					cleanupCommands.push(remoteShCommand);
					if (hostOfflineAfterDrop) {
						throw new Error('SSH connection unreachable after SIGHUP drop');
					}
				}

				let effectiveScript = remoteShCommand;
				if (injectFailureMode !== 'none' && remoteShCommand.includes('tmp="$d.tmp.$u"')) {
					const failAction = injectFailureMode === 'sighup_offline'
						? 'printf "PARTIAL_TMP" > "$tmp"; kill -HUP $$'
						: 'printf "PARTIAL_TMP" > "$tmp"; kill -9 $$';
					if (injectFailureMode === 'sighup_offline') {
						hostOfflineAfterDrop = true;
					}
					if (effectiveScript.includes('cp -f -- "$s" "$tmp"')) {
						effectiveScript = effectiveScript.replace('cp -f -- "$s" "$tmp"', failAction);
					} else if (effectiveScript.includes('cat > "$tmp"')) {
						effectiveScript = effectiveScript.replace('cat > "$tmp"', failAction);
					}
				}

				const child = spawn('/bin/sh', ['-c', effectiveScript], {
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

		const sql = trackSqliteStore(new AdeSqliteStore({ adeHomeDir: path.join(tempDir, 'ade-trap-home') }));
		const engine = trackStorageEngine(new AdeDynamicStorageEngine({
			sqliteStore: sql,
			customTransport: trapTransport,
			maxDataStreamsPerHost: 2,
			homedir: path.join(tempDir, 'mac-trap-home'),
		}));

		try {
			const srcRemote = path.join(homeA, 'origin.txt');
			const srcLocal = path.join(tempDir, 'local-origin.txt');
			await fs.promises.writeFile(srcRemote, 'REMOTE_ORIGIN_PAYLOAD', 'utf8');
			await fs.promises.writeFile(srcLocal, 'LOCAL_ORIGIN_PAYLOAD', 'utf8');

			// 1. Happy path across all 4 remote tmp scripts: verify trap 'rm -f -- "$tmp"' EXIT INT TERM HUP is present in every script
			capturedScripts.length = 0;
			const sameRemotePtr = await engine.storeFileFromHost({
				sourceHost: '10.0.7.11', sourcePath: srcRemote, targetStorageHost: '10.0.7.11',
				relSubdir: 'sub_same', filePrefix: 'same', displayFilename: 'origin.txt',
			});
			await engine.storeTextBlob({
				targetStorageHost: '10.0.7.11', relSubdir: 'sub_buf', filePrefix: 'buf', text: 'INLINE_REMOTE_TEXT',
			});
			await engine.storeFileFromHost({
				sourceHost: 'local', sourcePath: srcLocal, targetStorageHost: '10.0.7.11',
				relSubdir: 'sub_caseb', filePrefix: 'caseb', displayFilename: 'local-origin.txt',
			});
			await engine.storeFileFromHost({
				sourceHost: '10.0.7.11', sourcePath: sameRemotePtr.storage_path, targetStorageHost: '10.0.7.22',
				relSubdir: 'sub_casec', filePrefix: 'casec', displayFilename: 'origin.txt',
			});
			assert.strictEqual(capturedScripts.length, 4, 'Expected all 4 remote tmp-writing paths to be exercised');
			for (const sc of capturedScripts) {
				assert.ok(
					sc.includes(`tmp="$d.tmp.$u"; trap 'rm -f -- "$tmp"' EXIT INT TERM HUP`),
					`Remote write/copy script missing immediate trap guard: ${sc}`,
				);
			}

			// 2. SIGHUP with immediate SSH network loss (bestEffortDeleteTempFile cannot reach host -> remote shell trap MUST self-clean!)
			const formalSameDst = path.join(homeA, 'dl', 'formal-same.txt');
			await fs.promises.writeFile(formalSameDst, 'KEEP_FORMAL_SAME', 'utf8');
			injectFailureMode = 'sighup_offline';
			hostOfflineAfterDrop = false;
			await assert.rejects(() => engine.downloadBlobToHost({
				ptr: sameRemotePtr, fallbackFilename: 'formal-same.txt', callerHost: '10.0.7.11', rawDestPath: formalSameDst,
			}));
			assert.strictEqual(await fs.promises.readFile(formalSameDst, 'utf8'), 'KEEP_FORMAL_SAME');
			assert.deepStrictEqual(await fs.promises.readdir(path.join(homeA, 'dl')), ['formal-same.txt'], 'Same-remote SIGHUP trap must leave zero .tmp files');

			hostOfflineAfterDrop = false;
			await assert.rejects(() => engine.storeTextBlob({
				targetStorageHost: '10.0.7.11', relSubdir: 'sub_hup_buf', filePrefix: 'hupbuf', text: 'DROP_ME',
			}));
			const hupBufEntries = await fs.promises.readdir(path.join(homeA, '.ade_store', 'sub_hup_buf')).catch(() => [] as string[]);
			assert.deepStrictEqual(hupBufEntries, [], 'streamBufferToRemoteVerified SIGHUP trap must leave zero .tmp files');

			hostOfflineAfterDrop = false;
			await assert.rejects(() => engine.storeFileFromHost({
				sourceHost: 'local', sourcePath: srcLocal, targetStorageHost: '10.0.7.11',
				relSubdir: 'sub_hup_caseb', filePrefix: 'hupb', displayFilename: 'local-origin.txt',
			}));
			const hupCaseBEntries = await fs.promises.readdir(path.join(homeA, '.ade_store', 'sub_hup_caseb')).catch(() => [] as string[]);
			assert.deepStrictEqual(hupCaseBEntries, [], 'Case B SIGHUP trap must leave zero .tmp files');

			// 3. SIGKILL (bypasses shell trap) while host remains reachable -> Node catch bestEffortDeleteTempFile cleans .tmp on copySameRemoteToRemoteVerified & streamBufferToRemoteVerified!
			injectFailureMode = 'sigkill_online';
			hostOfflineAfterDrop = false;
			cleanupCommands.length = 0;

			await assert.rejects(() => engine.downloadBlobToHost({
				ptr: sameRemotePtr, fallbackFilename: 'formal-same.txt', callerHost: '10.0.7.11', rawDestPath: formalSameDst,
			}));
			assert.strictEqual(cleanupCommands.length, 1, 'copySameRemoteToRemoteVerified catch must invoke bestEffortDeleteTempFile');
			assert.deepStrictEqual(await fs.promises.readdir(path.join(homeA, 'dl')), ['formal-same.txt']);

			await assert.rejects(() => engine.storeTextBlob({
				targetStorageHost: '10.0.7.11', relSubdir: 'sub_kill_buf', filePrefix: 'killbuf', text: 'KILL_ME',
			}));
			assert.strictEqual(cleanupCommands.length, 2, 'streamBufferToRemoteVerified catch must invoke bestEffortDeleteTempFile');
			const killBufEntries = await fs.promises.readdir(path.join(homeA, '.ade_store', 'sub_kill_buf')).catch(() => [] as string[]);
			assert.deepStrictEqual(killBufEntries, []);
		} finally {
			injectFailureMode = 'none';
			hostOfflineAfterDrop = false;
			await sql.shutdownAll();
		}
	});

	test('blocks post-await migration SSH spawn & reverse bestEffortDeleteTempFile during shutdown, immediately rejects queued hostDataPools waiters, and deduplicates syncProjectWorkspaceRoutingRules', async function () {
		if (isWindows) {
			this.skip();
		}

		// Part 1: AdeDynamicStorageEngine.abortActiveStreamsForShutdown() immediately rejects queued hostDataPools waiters & blocks new transfers
		const waiterSql = trackSqliteStore(new AdeSqliteStore({ adeHomeDir: path.join(tempDir, 'ade-waiter-sql') }));
		const waiterEngine = trackStorageEngine(new AdeDynamicStorageEngine({
			sqliteStore: waiterSql,
			maxDataStreamsPerHost: 1,
			homedir: path.join(tempDir, 'mac-waiter-home'),
		}));
		const releaseSlot1 = await waiterEngine.acquireSingleHostDataSlot('10.0.8.11');
		const queuedWaiterPromise = waiterEngine.acquireSingleHostDataSlot('10.0.8.11');
		waiterEngine.abortActiveStreamsForShutdown();
		await assert.rejects(() => queuedWaiterPromise, /shutting down/);
		releaseSlot1();
		await assert.rejects(() => waiterEngine.acquireSingleHostDataSlot('10.0.8.11'), /shutting down/);
		await assert.rejects(() => waiterEngine.acquireSingleHostDataSlot('local'), /shutting down/);
		const dummyLocalSrc = path.join(tempDir, 'dummy-local.txt');
		await fs.promises.writeFile(dummyLocalSrc, 'DUMMY', 'utf8');
		await assert.rejects(() => waiterEngine.storeFileFromHost({
			sourceHost: 'local',
			sourcePath: dummyLocalSrc,
			targetStorageHost: 'local',
			relSubdir: 'sub',
			filePrefix: 'p',
		}), /shutting down/);

		// Part 2: Shutdown during active migration never spawns reverse bestEffortDeleteTempFile SSH or starts item #2 after await,
		// AND deduplicates syncProjectWorkspaceRoutingRules per (alias, remoteCwd)
		const homeCloud = path.join(tempDir, 'race-sd-cloud');
		const remoteRepoDir = path.posix.join(homeCloud, 'workspace-repo');
		await fs.promises.mkdir(remoteRepoDir, { recursive: true });
		const hostMap = new Map([
			['10.0.8.22', { ip: '10.0.8.22', alias: 'race-cloud', remoteHome: homeCloud }],
			['race-cloud', { ip: '10.0.8.22', alias: 'race-cloud', remoteHome: homeCloud }],
		]);
		const hostChangedEmitter = store.add(new Emitter<void>());
		const mockHosts: IAdeCloudHost[] = [{
			id: 'h_race', name: 'RaceCloud', alias: 'race-cloud', hostName: '10.0.8.22', user: 'dev', port: 22,
			os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
			lastTestStatus: { ok: true, checkedAt: 1, latencyMs: 1, remoteHome: homeCloud },
		}];

		let remoteMkdirCount = 0;
		const remoteFiles = new Map<string, string>();
		const fakeCloudService: Partial<IAdeCloudHostBackendService> = {
			onDidChangeHosts: hostChangedEmitter.event,
			listHosts: async () => mockHosts,
			getHost: async idOrAlias => mockHosts.find(h => h.alias === idOrAlias || h.hostName === idOrAlias || h.id === idOrAlias),
			remoteMkdir: async (_alias, dirPath) => {
				if (dirPath === remoteRepoDir) {
					remoteMkdirCount++;
				}
			},
			remoteReadFile: async (_alias, filePath) => {
				const hit = remoteFiles.get(filePath);
				if (hit === undefined) {
					throw new Error('ENOENT');
				}
				return VSBuffer.fromString(hit);
			},
			remoteWriteFile: async (_alias, filePath, content) => {
				remoteFiles.set(filePath, content.toString());
			},
		};

		let isShuttingDownInTest = false;
		const postShutdownSpawnedCommands: string[] = [];
		const item1EnteredStream = new DeferredPromise<void>();
		let uploadStreamCount = 0;

		const raceTransport: IAdeStorageTransportAdapter = {
			async getEffectiveSshConfigPath() {
				return '/dev/null';
			},
			async resolveHost(ipOrAlias: string) {
				const h = hostMap.get(ipOrAlias);
				if (!h) {
					throw new AdeError('ERR_INVALID_ARGS', `Unknown host ${ipOrAlias}`);
				}
				return { ip: h.ip, alias: h.alias, os: 'linux', remoteHome: h.remoteHome };
			},
			async spawnSshStream(alias: string, remoteShCommand: string) {
				if (isShuttingDownInTest) {
					postShutdownSpawnedCommands.push(remoteShCommand);
				}
				const h = hostMap.get(alias)!;
				await fs.promises.mkdir(h.remoteHome, { recursive: true });
				if (remoteShCommand.includes('cat > "$tmp"')) {
					uploadStreamCount++;
					const stallScript = remoteShCommand.replace('cat > "$tmp"', 'touch "$tmp"; sleep 30');
					const child = spawn('/bin/sh', ['-c', stallScript], {
						stdio: ['pipe', 'pipe', 'pipe'],
						env: { ...process.env, HOME: h.remoteHome },
					});
					item1EnteredStream.complete();
					const closePromise = new Promise<{ readonly exitCode: number | null; readonly stderr: string }>((resolve, reject) => {
						child.once('error', reject);
						child.once('close', exitCode => resolve({ exitCode, stderr: '' }));
					});
					return {
						stdin: child.stdin,
						stdout: child.stdout,
						waitClose: () => closePromise,
						kill: () => {
							try { child.kill('SIGTERM'); } catch { /* ignore */ }
						},
					};
				}
				return createLocalShCustomTransport(hostMap).spawnSshStream!(alias, remoteShCommand);
			},
		};

		const svc = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'ade-race-sd-home'),
			socketPath: path.join(tempDir, 'racesd.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: fakeCloudService as IAdeCloudHostBackendService,
			customStorageTransport: raceTransport,
			customLocalEngineProber: async () => ['claude', 'codex', 'antigravity'],
		}));
		await svc.whenReady();

		const cloudUri = buildCloudProjectUri('race-cloud', remoteRepoDir, 'linux').toString();
		const proj = await svc.createProject({ folderUri: cloudUri, name: 'CloudDedupAndRaceProj' });
		const pid = proj.meta.project_id;

		// Create 3 cloud agents on the same (alias, remoteCwd): L1 claude, L2 codex, L3 antigravity
		const l1 = await svc.uiCreateAgent({
			projectId: pid, parentId: null, level: 1, name: 'L1_Claude', roleSummary: 'Lead',
			host: '10.0.8.22', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'high',
		});
		const l2 = await svc.uiCreateAgent({
			projectId: pid, parentId: l1.agent_id, level: 2, name: 'L2_Codex', roleSummary: 'Dev',
			host: '10.0.8.22', engine: 'codex', model: 'gpt-5.2-codex', effort: 'medium',
		});
		remoteMkdirCount = 0;
		await svc.uiCreateAgent({
			projectId: pid, parentId: l2.agent_id, level: 3, name: 'L3_Agy', roleSummary: 'UI',
			host: '10.0.8.22', engine: 'antigravity', model: 'gemini-2.5-pro', effort: 'medium',
		});
		// All 3 cloud agents share (race-cloud, remoteRepoDir) -> syncRemoteWorkspaceRoutingFiles ran ONCE for the 3-agent snapshot!
		assert.strictEqual(remoteMkdirCount, 1, 'syncProjectWorkspaceRoutingRules must deduplicate (alias, remoteCwd) into a single remote sync');
		assert.strictEqual(remoteFiles.has(path.posix.join(remoteRepoDir, '.agents', 'rules', 'ade-routing.md')), true);

		// Create local whiteboard with 2 items, trigger migration to 10.0.8.22, then shut down once item #1 enters stream
		const localF1 = path.join(tempDir, 'race1.txt');
		const localF2 = path.join(tempDir, 'race2.txt');
		await fs.promises.writeFile(localF1, 'RACE_DATA_1', 'utf8');
		await fs.promises.writeFile(localF2, 'RACE_DATA_2', 'utf8');
		const wb = await svc.uiCreateWhiteboard({ projectId: pid, name: 'RaceBoard', storageHost: 'local' });
		const lLocal = await svc.uiCreateAgent({
			projectId: pid, parentId: l1.agent_id, level: 2, name: 'L2_Local', roleSummary: 'LocalOps',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'high',
		});
		await svc.uiConfigureWhiteboard({
			projectId: pid,
			boardId: wb.board_id,
			grants: [{ agentId: lLocal.agent_id, perm: 'read_write' }],
		});
		const localCaller: IAdeVerifiedCliCaller = { projectId: pid, agentId: lLocal.agent_id, host: 'local', tokenGen: 1 };
		await svc.executeCliCommand(localCaller, 'ade_wb_upload_file', { boardId: wb.board_id, file: localF1, summary: 'R1', stars: '5' });
		await svc.executeCliCommand(localCaller, 'ade_wb_upload_file', { boardId: wb.board_id, file: localF2, summary: 'R2', stars: '4' });

		await svc.uiConfigureWhiteboard({ projectId: pid, boardId: wb.board_id, targetStorageHost: '10.0.8.22' });
		await item1EnteredStream.p;

		isShuttingDownInTest = true;
		const shutdownPromise = svc.gracefulShutdown();
		// executeCliCommand must immediately reject while shuttingDown is true
		await assert.rejects(
			() => svc.executeCliCommand(localCaller, 'ade_whoami', {}),
			(err: unknown) => err instanceof AdeError && err.code === 'ERR_UNAUTHORIZED',
		);
		await shutdownPromise;

		assert.strictEqual(uploadStreamCount, 1, 'Migration loop must break after item #1 abort and never start item #2 during shutdown');
		assert.deepStrictEqual(
			postShutdownSpawnedCommands,
			[],
			`Shutdown must never spawn reverse bestEffortDeleteTempFile or new SSH streams: ${postShutdownSpawnedCommands.join(' | ')}`,
		);

		// Part 3: When copyBlobForMigration finishes producing copiedDst right as shuttingDown becomes true (before CAS commit),
		// runCasMigrationLoop enqueues copiedDst into catalog.db.remote_gc_tombstones and records migration_state='failed' (never 'completed')!
		const homeCloudP3 = path.join(tempDir, 'race-p3-cloud');
		await fs.promises.mkdir(homeCloudP3, { recursive: true });
		const hostMapP3 = new Map([
			['10.0.8.33', { ip: '10.0.8.33', alias: 'p3-cloud', remoteHome: homeCloudP3 }],
			['p3-cloud', { ip: '10.0.8.33', alias: 'p3-cloud', remoteHome: homeCloudP3 }],
		]);
		const hostChangedP3 = store.add(new Emitter<void>());
		const mockHostsP3: IAdeCloudHost[] = [{
			id: 'h_p3', name: 'P3Cloud', alias: 'p3-cloud', hostName: '10.0.8.33', user: 'dev', port: 22,
			os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
		}];
		const fakeCloudP3: Partial<IAdeCloudHostBackendService> = {
			onDidChangeHosts: hostChangedP3.event,
			listHosts: async () => mockHostsP3,
			getHost: async idOrAlias => mockHostsP3.find(h => h.alias === idOrAlias || h.hostName === idOrAlias || h.id === idOrAlias),
		};

		const p3Holder: { svc?: AdeControlCenterService } = {};
		const shutdownTriggeredP3 = new DeferredPromise<Promise<void>>();
		const p3Transport: IAdeStorageTransportAdapter = {
			async getEffectiveSshConfigPath() {
				return '/dev/null';
			},
			async resolveHost(ipOrAlias: string) {
				const h = hostMapP3.get(ipOrAlias)!;
				return { ip: h.ip, alias: h.alias, os: 'linux', remoteHome: h.remoteHome };
			},
			async spawnSshStream(alias: string, remoteShCommand: string) {
				const inner = await createLocalShCustomTransport(hostMapP3).spawnSshStream!(alias, remoteShCommand);
				if (!remoteShCommand.includes('cat > "$tmp"')) {
					return inner;
				}
				return {
					stdin: inner.stdin,
					stdout: inner.stdout,
					kill: inner.kill,
					waitClose: async () => {
						const res = await inner.waitClose();
						// Trigger shutdown right as destination write succeeds (so copiedDst is returned while shuttingDown === true!)
						if (p3Holder.svc && !shutdownTriggeredP3.isSettled) {
							shutdownTriggeredP3.complete(p3Holder.svc.gracefulShutdown());
						}
						return res;
					},
				};
			},
		};

		const p3AdeHome = path.join(tempDir, 'ade-p3-home');
		const svcP3 = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: p3AdeHome,
			socketPath: path.join(tempDir, 'p3.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: fakeCloudP3 as IAdeCloudHostBackendService,
			customStorageTransport: p3Transport,
			customLocalEngineProber: async () => ['claude'],
		}));
		p3Holder.svc = svcP3;
		await svcP3.whenReady();

		const wsP3 = path.join(tempDir, 'ws-p3');
		await fs.promises.mkdir(wsP3, { recursive: true });
		const singleSrc = path.join(wsP3, 'single.txt');
		await fs.promises.writeFile(singleSrc, 'UNCOMMITTED_COPIED_DST_DATA', 'utf8');
		const projP3 = await svcP3.createProject({ folderUri: URI.file(wsP3).toString(), name: 'P3Proj' });
		const pidP3 = projP3.meta.project_id;
		const p3StateDb = svcP3.sqliteStore.getProjectDbPath(pidP3);
		const p3CatalogDb = path.join(svcP3.sqliteStore.controlCenterDir, 'catalog.db');

		const l1P3 = await svcP3.uiCreateAgent({
			projectId: pidP3, parentId: null, level: 1, name: 'L1', roleSummary: 'Lead',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'high',
		});
		const callerP3: IAdeVerifiedCliCaller = { projectId: pidP3, agentId: l1P3.agent_id, host: 'local', tokenGen: 1 };
		const wbP3 = await svcP3.executeCliCommand(callerP3, 'ade_wb_create', { name: 'P3Board', host: 'local' });
		const boardIdP3 = String(wbP3.board_id);
		await svcP3.executeCliCommand(callerP3, 'ade_wb_upload_file', { boardId: boardIdP3, file: singleSrc, summary: 'S1', stars: '5' });

		await svcP3.uiConfigureWhiteboard({ projectId: pidP3, boardId: boardIdP3, targetStorageHost: '10.0.8.33' });
		const shutdownPromiseP3 = await shutdownTriggeredP3.p;
		await shutdownPromiseP3;

		const sqlite3Mod = await import('@vscode/sqlite3').then(m => (m.default ?? m) as typeof import('@vscode/sqlite3'));
		const p3BoardState = await new Promise<string | undefined>((resolve, reject) => {
			const raw = new sqlite3Mod.Database(p3StateDb, sqlite3Mod.OPEN_READONLY, err => {
				if (err) { reject(err); return; }
				raw.get(`SELECT migration_state FROM whiteboards WHERE board_id = ?`, [boardIdP3], (qErr, row?: { migration_state?: string }) => {
					raw.close(() => (qErr ? reject(qErr) : resolve(row?.migration_state)));
				});
			});
		});
		assert.strictEqual(p3BoardState, 'failed', 'Interrupted single-item migration before CAS commit must NOT be marked completed');

		const p3Tombstones = await new Promise<Array<{ storage_host: string; storage_path: string }>>((resolve, reject) => {
			const raw = new sqlite3Mod.Database(p3CatalogDb, sqlite3Mod.OPEN_READONLY, err => {
				if (err) { reject(err); return; }
				raw.all(`SELECT storage_host, storage_path FROM remote_gc_tombstones WHERE project_id = ?`, [pidP3], (qErr, rows?: Array<{ storage_host: string; storage_path: string }>) => {
					raw.close(() => (qErr ? reject(qErr) : resolve(rows ?? [])));
				});
			});
		});
		assert.strictEqual(
			p3Tombstones.some(t => t.storage_host === '10.0.8.33' && t.storage_path.startsWith(homeCloudP3)),
			true,
			'Uncommitted copiedDst produced right as shutdown begins must be enqueued in remote_gc_tombstones',
		);
	});

	test('drains in-flight activeMigrations in deleteProject(projectId) with zero closed-SQLite errors and zero orphan destination/source files leaked', async function () {
		if (isWindows) {
			this.skip();
		}
		const homeCloud = path.join(tempDir, 'delproj-mig-cloud');
		await fs.promises.mkdir(homeCloud, { recursive: true });
		const hostMap = new Map([
			['10.0.9.22', { ip: '10.0.9.22', alias: 'del-cloud', remoteHome: homeCloud }],
			['del-cloud', { ip: '10.0.9.22', alias: 'del-cloud', remoteHome: homeCloud }],
		]);
		const hostChangedEmitter = store.add(new Emitter<void>());
		const mockHosts: IAdeCloudHost[] = [{
			id: 'h_del', name: 'DelCloud', alias: 'del-cloud', hostName: '10.0.9.22', user: 'dev', port: 22,
			os: 'linux', recentDirectories: [], source: 'user', createdAt: 1, updatedAt: 1,
		}];
		const fakeCloudService: Partial<IAdeCloudHostBackendService> = {
			onDidChangeHosts: hostChangedEmitter.event,
			listHosts: async () => mockHosts,
			getHost: async idOrAlias => mockHosts.find(h => h.alias === idOrAlias || h.hostName === idOrAlias || h.id === idOrAlias),
		};

		const loggedIssues: string[] = [];
		const spyLogService: ILogService = {
			_serviceBrand: undefined,
			onDidChangeLogLevel: Event.None,
			setLevel(_level: LogLevel): void { },
			getLevel(): LogLevel { return LogLevel.Info; },
			trace(): void { },
			debug(): void { },
			info(): void { },
			warn(message: string, ...args: unknown[]): void {
				loggedIssues.push([message, ...args.map(a => a instanceof Error ? (a.stack ?? a.message) : String(a))].join(' '));
			},
			error(message: string | Error, ...args: unknown[]): void {
				loggedIssues.push([message instanceof Error ? (message.stack ?? message.message) : message, ...args.map(a => a instanceof Error ? (a.stack ?? a.message) : String(a))].join(' '));
			},
			flush(): void { },
			dispose(): void { },
		};

		const copyStarted = new DeferredPromise<void>();
		const allowCopyFinish = new DeferredPromise<void>();
		const gatedTransport: IAdeStorageTransportAdapter = {
			async getEffectiveSshConfigPath() {
				return '/dev/null';
			},
			async resolveHost(ipOrAlias: string) {
				const h = hostMap.get(ipOrAlias);
				if (!h) {
					throw new AdeError('ERR_INVALID_ARGS', `Unknown host ${ipOrAlias}`);
				}
				return { ip: h.ip, alias: h.alias, os: 'linux', remoteHome: h.remoteHome };
			},
			async spawnSshStream(alias: string, remoteShCommand: string) {
				if (remoteShCommand.includes('cat > "$tmp"')) {
					copyStarted.complete();
					await allowCopyFinish.p;
				}
				return createLocalShCustomTransport(hostMap).spawnSshStream!(alias, remoteShCommand);
			},
		};

		const svc = trackControlCenter(new AdeControlCenterService({
			adeHomeDir: path.join(tempDir, 'ade-delproj-home'),
			socketPath: path.join(tempDir, 'delproj.sock'),
			persistIdempotencyLedger: false,
			cloudHostService: fakeCloudService as IAdeCloudHostBackendService,
			customStorageTransport: gatedTransport,
			customLocalEngineProber: async () => ['claude'],
			logService: spyLogService,
		}));
		await svc.whenReady();

		const wsDir = path.join(tempDir, 'ws-delproj');
		await fs.promises.mkdir(wsDir, { recursive: true });
		const f1 = path.join(wsDir, 'orphan-candidate-1.bin');
		const f2 = path.join(wsDir, 'orphan-candidate-2.bin');
		await fs.promises.writeFile(f1, 'ORPHAN_CANDIDATE_PAYLOAD_1', 'utf8');
		await fs.promises.writeFile(f2, 'ORPHAN_CANDIDATE_PAYLOAD_2', 'utf8');

		const proj = await svc.createProject({ folderUri: URI.file(wsDir).toString(), name: 'DeleteDuringMigProj' });
		const pid = proj.meta.project_id;
		const projectDir = svc.sqliteStore.getProjectDir(pid);
		const l1 = await svc.uiCreateAgent({
			projectId: pid, parentId: null, level: 1, name: 'L1', roleSummary: 'Lead',
			host: 'local', engine: 'claude', model: 'claude-sonnet-4-6', effort: 'high',
		});
		const caller: IAdeVerifiedCliCaller = { projectId: pid, agentId: l1.agent_id, host: 'local', tokenGen: 1 };
		const wb = await svc.executeCliCommand(caller, 'ade_wb_create', { name: 'DelBoard', host: 'local' });
		const boardId = String(wb.board_id);
		await svc.executeCliCommand(caller, 'ade_wb_upload_file', { boardId, file: f1, summary: 'C1', stars: '5' });
		await svc.executeCliCommand(caller, 'ade_wb_upload_file', { boardId, file: f2, summary: 'C2', stars: '4' });

		// Start CAS migration local -> 10.0.9.22 and pause right when item #1 enters destination SSH write
		await svc.uiConfigureWhiteboard({ projectId: pid, boardId, targetStorageHost: '10.0.9.22' });
		await copyStarted.p;

		// Trigger deleteProject(pid) concurrently WHILE item #1 copyBlobForMigration is in flight!
		let deleteDone = false;
		const delPromise = svc.deleteProject(pid).then(() => { deleteDone = true; });
		await new Promise<void>(r => setTimeout(r, 20));
		assert.strictEqual(deleteDone, false, 'deleteProject must await in-flight activeMigrations before closing DB');

		// Allow in-flight copyBlobForMigration to complete writing copiedDst onto 10.0.9.22
		allowCopyFinish.complete();
		await delPromise;
		await svc.storageEngine.drainTombstonesAsync();

		// 1. Zero SQLite closed/shutting-down errors logged
		for (const issue of loggedIssues) {
			assert.strictEqual(issue.includes('SQLite database already closed'), false, `Unexpected closed DB error: ${issue}`);
			assert.strictEqual(issue.includes('AdeSqliteStore is shutting down'), false, `Unexpected shutting down error: ${issue}`);
		}

		// 2. Project removed from catalog & project state.db directory completely removed
		assert.strictEqual(await svc.getProjectSnapshot(pid), undefined);
		assert.strictEqual((await svc.getCatalogSnapshot()).projects.some(p => p.project_id === pid), false);
		assert.strictEqual(await fs.promises.access(projectDir).then(() => true, () => false), false, 'Project state.db directory must be removed');

		// 3. Zero orphan files left on EITHER local store OR remote 10.0.9.22 ~/.ade_store!
		const localBoardDir = path.join(svc.sqliteStore.localStoreRootDir, `${pid}_${boardId}`);
		const remoteBoardDir = path.join(homeCloud, '.ade_store', `${pid}_${boardId}`);
		assert.strictEqual(await fs.promises.access(localBoardDir).then(() => true, () => false), false, 'Local board directory must be purged');
		assert.strictEqual(await fs.promises.access(remoteBoardDir).then(() => true, () => false), false, 'Remote board directory & uncommitted copiedDst must be purged');
	});
});
