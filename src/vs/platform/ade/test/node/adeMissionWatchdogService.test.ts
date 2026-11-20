/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ADE_API_LATEST_REVISION } from '../../common/adeApiRegistry.js';
import { buildAdeDocsPaths } from '../../common/adeDocsCatalog.js';
import {
	IAdeMissionWatchdogSnapshot,
	IAdeSourceTriggerFireEvent,
	IAdeWatchdogTokenSpec,
	IAdeWatchdogWakeupEvent,
} from '../../common/adeEngineering.js';
import { IMissionSourceTrigger } from '../../common/adeMissionEngine.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG } from '../../common/adeRoleSchema.js';
import { AdeDocsBackendNodeService } from '../../node/adeDocsBackendService.js';
import {
	AdeMissionWatchdogService,
	IAdeLocalWatchdogProbe,
	IAdeRemoteWatchdogProbe,
} from '../../node/adeMissionWatchdogService.js';

function createLocalProbe(overrides: Partial<IAdeLocalWatchdogProbe> = {}): IAdeLocalWatchdogProbe {
	return {
		isPidAlive: async () => true,
		fileStatMtime: async filePath => {
			try {
				return (await fs.promises.stat(filePath)).mtimeMs;
			} catch {
				return undefined;
			}
		},
		gitHeadCommit: async () => undefined,
		gpuUtilizationPct: async () => undefined,
		...overrides,
	};
}

function createRemoteProbe(overrides: Partial<IAdeRemoteWatchdogProbe> = {}): IAdeRemoteWatchdogProbe {
	return {
		remoteIsPidAlive: async () => true,
		remoteFileStatMtime: async () => undefined,
		remoteGitHeadCommit: async () => undefined,
		remoteGpuUtilizationPct: async () => undefined,
		...overrides,
	};
}

function createSnapshot(overrides: Partial<IAdeMissionWatchdogSnapshot> = {}): IAdeMissionWatchdogSnapshot {
	return {
		missionId: 'mission-1',
		status: 'running',
		silenceTimeoutMinutes: 5,
		tokens: [],
		triggers: [],
		...overrides,
	};
}

function createTrigger(overrides: Partial<IMissionSourceTrigger> = {}): IMissionSourceTrigger {
	return {
		id: 'trigger-1',
		nodeId: 'N1',
		kind: 'once',
		enabled: true,
		fireCount: 0,
		...overrides,
	};
}

function createBlockedToken(
	blocked: NonNullable<IAdeWatchdogTokenSpec['blocked']>,
	overrides: Partial<IAdeWatchdogTokenSpec> = {},
): IAdeWatchdogTokenSpec {
	return {
		tokenId: 'token-1',
		nodeId: 'N1',
		status: 'blocked',
		lastActivityAt: 0,
		blocked,
		...overrides,
	};
}

suite('AdeMissionWatchdogService — silence timeout', () => {
	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('active token stays silent below the threshold, then nudges once per threshold window', async () => {
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		let now = 10_000_000;
		const service = testDisposables.add(new AdeMissionWatchdogService({
			localProbe: createLocalProbe(),
			pollIntervalMs: 3_600_000,
			now: () => now,
		}));
		testDisposables.add(service.onDidWatchdogWakeup(e => wakeups.push(e)));

		const lastActivityAt = now - 4 * 60_000;
		service.syncMission(createSnapshot({
			tokens: [{ tokenId: 'token-1', nodeId: 'N1', holderAgentId: 'agent-1', status: 'active', lastActivityAt }],
		}));

		await service.runTick();
		assert.strictEqual(wakeups.length, 0, 'must stay silent before the 5m threshold');

		// Exactly at the threshold: one nudge.
		now = lastActivityAt + 5 * 60_000;
		await service.runTick();
		assert.strictEqual(wakeups.length, 1);
		assert.deepStrictEqual(
			{
				missionId: wakeups[0].missionId,
				tokenId: wakeups[0].tokenId,
				nodeId: wakeups[0].nodeId,
				holderAgentId: wakeups[0].holderAgentId,
				reason: wakeups[0].reason,
				timestamp: wakeups[0].timestamp,
			},
			{
				missionId: 'mission-1',
				tokenId: 'token-1',
				nodeId: 'N1',
				holderAgentId: 'agent-1',
				reason: 'silence_timeout',
				timestamp: now,
			},
		);

		// Cooldown: an immediate re-tick must not nudge again.
		await service.runTick();
		assert.strictEqual(wakeups.length, 1, 'cooldown must suppress an immediate second nudge');

		// Just shy of the next full window: still silent.
		now += 5 * 60_000 - 1;
		await service.runTick();
		assert.strictEqual(wakeups.length, 1);

		// Full window elapsed since the last nudge: second nudge allowed.
		now += 1;
		await service.runTick();
		assert.strictEqual(wakeups.length, 2);
		assert.strictEqual(wakeups[1].reason, 'silence_timeout');
	});

	test('paused, stopped and idle missions never emit silence wakeups', async () => {
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		const now = 20_000_000;
		const service = testDisposables.add(new AdeMissionWatchdogService({
			localProbe: createLocalProbe(),
			pollIntervalMs: 3_600_000,
			now: () => now,
		}));
		testDisposables.add(service.onDidWatchdogWakeup(e => wakeups.push(e)));

		for (const status of ['paused', 'stopped', 'idle'] as const) {
			service.syncMission(createSnapshot({
				missionId: `mission-${status}`,
				status,
				tokens: [{ tokenId: 'token-1', nodeId: 'N1', status: 'active', lastActivityAt: now - 60 * 60_000 }],
			}));
			await service.runTick();
			assert.strictEqual(wakeups.length, 0, `${status} mission must not emit silence wakeups`);
		}
	});

	test('blocked token is exempt from the silence timeout even far beyond the window', async () => {
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		const now = 30_000_000;
		const service = testDisposables.add(new AdeMissionWatchdogService({
			localProbe: createLocalProbe(),
			pollIntervalMs: 3_600_000,
			now: () => now,
		}));
		testDisposables.add(service.onDidWatchdogWakeup(e => wakeups.push(e)));

		service.syncMission(createSnapshot({
			tokens: [createBlockedToken({
				reason: 'waiting for CI',
				startedAt: now - 10 * 60_000,
				maxDurationMs: 60 * 60_000,
				expiresAt: now + 50 * 60_000,
			}, { lastActivityAt: now - 30 * 60_000 })],
		}));

		await service.runTick();
		assert.deepStrictEqual(wakeups, [], 'blocked tokens must not emit silence_timeout');
	});
});

suite('AdeMissionWatchdogService — blocked early wakeups', () => {
	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	let tmpDir: string;

	setup(async () => {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aexus-watchdog-'));
	});

	teardown(async () => {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	});

	test('emits block_expired exactly once when the blocked window expires', async () => {
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		let now = 40_000_000;
		const service = testDisposables.add(new AdeMissionWatchdogService({
			localProbe: createLocalProbe(),
			pollIntervalMs: 3_600_000,
			now: () => now,
		}));
		testDisposables.add(service.onDidWatchdogWakeup(e => wakeups.push(e)));

		const expiresAt = now + 60_000;
		service.syncMission(createSnapshot({
			tokens: [createBlockedToken({
				reason: 'waiting',
				startedAt: now,
				maxDurationMs: 60_000,
				expiresAt,
			})],
		}));

		await service.runTick();
		assert.strictEqual(wakeups.length, 0, 'must not expire before expiresAt');

		now = expiresAt;
		await service.runTick();
		assert.strictEqual(wakeups.length, 1);
		assert.strictEqual(wakeups[0].reason, 'block_expired');
		assert.ok(wakeups[0].detail?.includes('waiting'));

		now += 60 * 60_000;
		await service.runTick();
		assert.strictEqual(wakeups.length, 1, 'block_expired must not repeat');
	});

	test('emits pid_exited when the local watched PID is gone', async () => {
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		const probedPids: number[] = [];
		const now = 50_000_000;
		const service = testDisposables.add(new AdeMissionWatchdogService({
			localProbe: createLocalProbe({
				isPidAlive: async pid => {
					probedPids.push(pid);
					return false;
				},
			}),
			pollIntervalMs: 3_600_000,
			now: () => now,
		}));
		testDisposables.add(service.onDidWatchdogWakeup(e => wakeups.push(e)));

		service.syncMission(createSnapshot({
			tokens: [createBlockedToken({
				reason: 'waiting for process',
				startedAt: now,
				maxDurationMs: 60 * 60_000,
				expiresAt: now + 60 * 60_000,
				watchPid: 4242,
			})],
		}));

		await service.runTick();
		assert.deepStrictEqual(probedPids, [4242]);
		assert.strictEqual(wakeups.length, 1);
		assert.strictEqual(wakeups[0].reason, 'pid_exited');
		assert.ok(wakeups[0].detail?.includes('4242'));

		await service.runTick();
		assert.strictEqual(wakeups.length, 1, 'pid_exited must not repeat');
	});

	test('keeps the employee blocked when the local PID is still alive', async () => {
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		const now = 55_000_000;
		const service = testDisposables.add(new AdeMissionWatchdogService({
			localProbe: createLocalProbe({ isPidAlive: async () => true }),
			pollIntervalMs: 3_600_000,
			now: () => now,
		}));
		testDisposables.add(service.onDidWatchdogWakeup(e => wakeups.push(e)));

		service.syncMission(createSnapshot({
			tokens: [createBlockedToken({
				reason: 'still running',
				startedAt: now,
				maxDurationMs: 60 * 60_000,
				expiresAt: now + 60 * 60_000,
				watchPid: 4243,
			})],
		}));

		await service.runTick();
		assert.deepStrictEqual(wakeups, []);
	});

	test('routes remote watched PIDs through remoteProbe.remoteIsPidAlive', async () => {
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		const remoteCalls: { authority: string; pid: number }[] = [];
		let localProbeCalls = 0;
		const now = 60_000_000;
		const service = testDisposables.add(new AdeMissionWatchdogService({
			localProbe: createLocalProbe({
				isPidAlive: async () => {
					localProbeCalls++;
					return true;
				},
			}),
			remoteProbe: createRemoteProbe({
				remoteIsPidAlive: async (authority, pid) => {
					remoteCalls.push({ authority, pid });
					return false;
				},
			}),
			pollIntervalMs: 3_600_000,
			now: () => now,
		}));
		testDisposables.add(service.onDidWatchdogWakeup(e => wakeups.push(e)));

		service.syncMission(createSnapshot({
			tokens: [createBlockedToken({
				reason: 'remote process',
				startedAt: now,
				maxDurationMs: 60 * 60_000,
				expiresAt: now + 60 * 60_000,
				watchPid: 777,
				hostAlias: 'cloud-a',
			})],
		}));

		await service.runTick();
		assert.deepStrictEqual(remoteCalls, [{ authority: 'cloud-a', pid: 777 }]);
		assert.strictEqual(localProbeCalls, 0, 'local probe must not be used for a remote host');
		assert.strictEqual(wakeups.length, 1);
		assert.strictEqual(wakeups[0].reason, 'pid_exited');
		assert.ok(wakeups[0].detail?.includes('cloud-a'));
	});

	test('emits file_ready as soon as a local watched file appears (real temp file)', async () => {
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		const now = 70_000_000;
		const watchedFile = path.join(tmpDir, 'completion.flag');
		const service = testDisposables.add(new AdeMissionWatchdogService({
			localProbe: createLocalProbe(),
			pollIntervalMs: 3_600_000,
			now: () => now,
		}));
		testDisposables.add(service.onDidWatchdogWakeup(e => wakeups.push(e)));

		service.syncMission(createSnapshot({
			tokens: [createBlockedToken({
				reason: 'waiting for artifact',
				startedAt: now,
				maxDurationMs: 60 * 60_000,
				expiresAt: now + 60 * 60_000,
				watchFile: watchedFile,
			})],
		}));

		await service.runTick();
		assert.strictEqual(wakeups.length, 0, 'file_ready must not fire before the file exists');

		await fs.promises.writeFile(watchedFile, 'done', 'utf8');
		await service.runTick();
		assert.strictEqual(wakeups.length, 1);
		assert.strictEqual(wakeups[0].reason, 'file_ready');
		assert.ok(wakeups[0].detail?.includes(watchedFile));

		await service.runTick();
		assert.strictEqual(wakeups.length, 1, 'file_ready must not repeat');
	});

	test('routes remote watched files through remoteProbe.remoteFileStatMtime', async () => {
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		const remoteCalls: { authority: string; remotePath: string }[] = [];
		const mtimeRef: { value: number | undefined } = { value: undefined };
		const now = 80_000_000;
		const service = testDisposables.add(new AdeMissionWatchdogService({
			localProbe: createLocalProbe(),
			remoteProbe: createRemoteProbe({
				remoteFileStatMtime: async (authority, remotePath) => {
					remoteCalls.push({ authority, remotePath });
					return mtimeRef.value;
				},
			}),
			pollIntervalMs: 3_600_000,
			now: () => now,
		}));
		testDisposables.add(service.onDidWatchdogWakeup(e => wakeups.push(e)));

		service.syncMission(createSnapshot({
			tokens: [createBlockedToken({
				reason: 'remote artifact',
				startedAt: now,
				maxDurationMs: 60 * 60_000,
				expiresAt: now + 60 * 60_000,
				watchFile: '/remote/out/result.bin',
				hostAlias: 'cloud-b',
			})],
		}));

		await service.runTick();
		assert.deepStrictEqual(remoteCalls, [{ authority: 'cloud-b', remotePath: '/remote/out/result.bin' }]);
		assert.strictEqual(wakeups.length, 0, 'missing remote file must not wake the employee');

		mtimeRef.value = 70_000_000;
		await service.runTick();
		assert.strictEqual(wakeups.length, 0, 'stale pre-existing remote file older than blocked.startedAt must not wake the employee');

		mtimeRef.value = 80_005_000;
		await service.runTick();
		assert.strictEqual(wakeups.length, 1);
		assert.strictEqual(wakeups[0].reason, 'file_ready');
		assert.ok(wakeups[0].detail?.includes('cloud-b'));
	});
});

suite('AdeMissionWatchdogService — zero-token source triggers', () => {
	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	let tmpDir: string;

	setup(async () => {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aexus-triggers-'));
	});

	teardown(async () => {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	});

	function createHarness(options: {
		now: () => number;
		localProbe?: IAdeLocalWatchdogProbe;
		remoteProbe?: IAdeRemoteWatchdogProbe;
	}): { service: AdeMissionWatchdogService; fires: IAdeSourceTriggerFireEvent[] } {
		const fires: IAdeSourceTriggerFireEvent[] = [];
		const service = testDisposables.add(new AdeMissionWatchdogService({
			localProbe: options.localProbe ?? createLocalProbe(),
			remoteProbe: options.remoteProbe,
			pollIntervalMs: 3_600_000,
			now: options.now,
		}));
		testDisposables.add(service.onDidSourceTriggerFire(e => fires.push(e)));
		return { service, fires };
	}

	test('once trigger fires at fireAt and never re-fires', async () => {
		let now = 5_000_000;
		const { service, fires } = createHarness({ now: () => now });
		const fireAt = now + 1_000;
		service.syncMission(createSnapshot({ triggers: [createTrigger({ kind: 'once', fireAt })] }));

		await service.runTick();
		assert.strictEqual(fires.length, 0, 'must not fire before fireAt');

		now = fireAt;
		await service.runTick();
		assert.strictEqual(fires.length, 1);
		assert.deepStrictEqual(
			{
				missionId: fires[0].missionId,
				triggerId: fires[0].triggerId,
				nodeId: fires[0].nodeId,
				kind: fires[0].kind,
				timestamp: fires[0].timestamp,
			},
			{
				missionId: 'mission-1',
				triggerId: 'trigger-1',
				nodeId: 'N1',
				kind: 'once',
				timestamp: fireAt,
			},
		);

		now += 24 * 60 * 60_000;
		await service.runTick();
		assert.strictEqual(fires.length, 1, 'once trigger must never re-fire');
	});

	test('interval trigger baselines the first tick and fires once per elapsed cadence', async () => {
		const base = 6_000_000;
		let now = base;
		const { service, fires } = createHarness({ now: () => now });
		service.syncMission(createSnapshot({
			triggers: [createTrigger({ kind: 'interval', intervalMs: 10_000 })],
		}));

		await service.runTick();
		assert.strictEqual(fires.length, 0, 'first interval tick only records the baseline');

		now = base + 10_000;
		await service.runTick();
		assert.strictEqual(fires.length, 1);
		assert.ok(fires[0].detail?.includes('10000ms'));

		now = base + 15_000;
		await service.runTick();
		assert.strictEqual(fires.length, 1, 'must not fire before a full interval elapses since the last fire');

		now = base + 20_000;
		await service.runTick();
		assert.strictEqual(fires.length, 2);
	});

	test('cron trigger matches */5 * * * * once per matching minute bucket', async () => {
		const base = new Date(2026, 0, 1, 0, 5, 0, 0).getTime();
		let now = base;
		const { service, fires } = createHarness({ now: () => now });
		service.syncMission(createSnapshot({
			triggers: [createTrigger({ kind: 'cron', cronExpr: '*/5 * * * *' })],
		}));

		await service.runTick();
		assert.strictEqual(fires.length, 1);
		assert.ok(fires[0].detail?.includes('*/5 * * * *'));

		// Same minute bucket: no re-fire.
		await service.runTick();
		assert.strictEqual(fires.length, 1);

		// Next minute is not a multiple of 5: no fire.
		now = base + 60_000;
		await service.runTick();
		assert.strictEqual(fires.length, 1);

		// Next matching minute bucket fires again.
		now = base + 5 * 60_000;
		await service.runTick();
		assert.strictEqual(fires.length, 2);
	});

	test('file_created event fires when a real temp file appears after the baseline', async () => {
		const now = 7_000_000;
		const targetPath = path.join(tmpDir, 'source-input.txt');
		const { service, fires } = createHarness({ now: () => now });
		service.syncMission(createSnapshot({
			triggers: [createTrigger({ kind: 'event', eventType: 'file_created', targetPath })],
		}));

		await service.runTick();
		assert.strictEqual(fires.length, 0, 'baseline tick for a missing file must not fire');

		await fs.promises.writeFile(targetPath, 'created', 'utf8');
		await service.runTick();
		assert.strictEqual(fires.length, 1);
		assert.strictEqual(fires[0].kind, 'event');
		assert.ok(fires[0].detail?.includes(targetPath));
	});

	test('file_created event does not fire for a pre-existing file at the baseline tick', async () => {
		const now = 7_500_000;
		const targetPath = path.join(tmpDir, 'already-there.txt');
		await fs.promises.writeFile(targetPath, 'pre-existing', 'utf8');

		const { service, fires } = createHarness({ now: () => now });
		service.syncMission(createSnapshot({
			triggers: [createTrigger({ kind: 'event', eventType: 'file_created', targetPath })],
		}));

		await service.runTick();
		assert.strictEqual(fires.length, 0, 'baseline observation of an existing file must not count as creation');

		await service.runTick();
		assert.strictEqual(fires.length, 0, 'unchanged pre-existing file must never fire file_created');
	});

	test('busy source node with an active token skips firing its trigger', async () => {
		const now = 7_800_000;
		const { service, fires } = createHarness({ now: () => now });
		service.syncMission(createSnapshot({
			tokens: [{ tokenId: 'token-1', nodeId: 'N1', status: 'active', lastActivityAt: now }],
			triggers: [createTrigger({ kind: 'once', fireAt: now - 1_000 })],
		}));

		await service.runTick();
		assert.deepStrictEqual(fires, [], 'a live in-flight token on the source node must suppress the trigger');

		service.syncMission(createSnapshot({
			tokens: [{ tokenId: 'token-1', nodeId: 'N1', status: 'completed', lastActivityAt: now }],
			triggers: [createTrigger({ kind: 'once', fireAt: now - 1_000 })],
		}));
		await service.runTick();
		assert.strictEqual(fires.length, 1, 'trigger fires once the source node is no longer busy');
	});

	test('file_changed event fires when the real temp file mtime changes', async () => {
		const now = 8_000_000;
		const targetPath = path.join(tmpDir, 'watched-input.txt');
		await fs.promises.writeFile(targetPath, 'v1', 'utf8');
		await fs.promises.utimes(targetPath, new Date(2020, 0, 1), new Date(2020, 0, 1));

		const { service, fires } = createHarness({ now: () => now });
		service.syncMission(createSnapshot({
			triggers: [createTrigger({ kind: 'event', eventType: 'file_changed', targetPath })],
		}));

		await service.runTick();
		assert.strictEqual(fires.length, 0, 'first observation is just the baseline');

		await fs.promises.utimes(targetPath, new Date(2021, 0, 1), new Date(2021, 0, 1));
		await service.runTick();
		assert.strictEqual(fires.length, 1);
		assert.ok(fires[0].detail?.includes(targetPath));
	});

	test('git_updated event fires when the probed HEAD SHA changes', async () => {
		let now = 9_000_000;
		let head = 'aaaaaaa1';
		const { service, fires } = createHarness({
			now: () => now,
			localProbe: createLocalProbe({ gitHeadCommit: async () => head }),
		});
		service.syncMission(createSnapshot({
			triggers: [createTrigger({ kind: 'event', eventType: 'git_updated', targetPath: tmpDir })],
		}));

		await service.runTick();
		assert.strictEqual(fires.length, 0, 'first SHA observation is the baseline');

		now += 1_000;
		await service.runTick();
		assert.strictEqual(fires.length, 0, 'unchanged SHA must not fire');

		head = 'bbbbbbb2';
		now += 1_000;
		await service.runTick();
		assert.strictEqual(fires.length, 1);
		assert.ok(fires[0].detail?.includes('aaaaaaa'));
		assert.ok(fires[0].detail?.includes('bbbbbbb'));
	});

	test('remote gpu_idle event fires at or below threshold and respects the 60s cooldown', async () => {
		let now = 10_000_000;
		const probedAuthorities: string[] = [];
		const { service, fires } = createHarness({
			now: () => now,
			remoteProbe: createRemoteProbe({
				remoteGpuUtilizationPct: async authority => {
					probedAuthorities.push(authority);
					return 4;
				},
			}),
		});
		service.syncMission(createSnapshot({
			triggers: [createTrigger({
				kind: 'event',
				eventType: 'gpu_idle',
				hostAlias: 'gpu-host',
				gpuUtilThresholdPct: 10,
			})],
		}));

		await service.runTick();
		assert.deepStrictEqual(probedAuthorities, ['gpu-host']);
		assert.strictEqual(fires.length, 1);

		now += 30_000;
		await service.runTick();
		assert.strictEqual(fires.length, 1, 'cooldown blocks a fire inside 60s');

		now += 30_001;
		await service.runTick();
		assert.strictEqual(fires.length, 2, 'cooldown elapses after 60s');
		assert.ok(fires[1].detail?.includes('gpu-host'));
	});

	test('gpu_idle event does not fire above the utilization threshold', async () => {
		const now = 11_000_000;
		const { service, fires } = createHarness({
			now: () => now,
			remoteProbe: createRemoteProbe({ remoteGpuUtilizationPct: async () => 75 }),
		});
		service.syncMission(createSnapshot({
			triggers: [createTrigger({
				kind: 'event',
				eventType: 'gpu_idle',
				hostAlias: 'gpu-host',
				gpuUtilThresholdPct: 10,
			})],
		}));

		await service.runTick();
		assert.deepStrictEqual(fires, []);
	});

	test('disabled triggers are ignored and non-running missions run no triggers', async () => {
		const now = 12_000_000;
		const { service, fires } = createHarness({ now: () => now });

		service.syncMission(createSnapshot({
			tokens: [],
			triggers: [createTrigger({ kind: 'interval', intervalMs: 5_000, enabled: false })],
		}));
		await service.runTick();
		assert.deepStrictEqual(fires, [], 'disabled triggers must be ignored');

		service.syncMission(createSnapshot({
			missionId: 'mission-paused',
			status: 'paused',
			triggers: [createTrigger({ id: 'trigger-paused', kind: 'interval', intervalMs: 5_000 })],
		}));
		await service.runTick();
		assert.deepStrictEqual(fires, [], 'paused missions must not evaluate triggers');
	});
});

suite('AdeDocsBackendNodeService — single-copy API docs', () => {
	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	let baseDir: string;
	let service: AdeDocsBackendNodeService;

	setup(async () => {
		baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aexus-ade-docs-'));
		service = testDisposables.add(new AdeDocsBackendNodeService({ baseDir }));
	});

	teardown(async () => {
		await fs.promises.rm(baseDir, { recursive: true, force: true });
	});

	test('readApiDoc auto-syncs and returns common, L0, L2, mission and manifest docs', async () => {
		const docsPaths = buildAdeDocsPaths(baseDir, DEFAULT_ADE_ORGANIZATION_CONFIG.ranks.length);
		const targets = [
			{ target: 'common', canonical: 'common', expectedPath: docsPaths.commonDoc! },
			{ target: 'L0', canonical: 'L0', expectedPath: docsPaths.rankDocs.L0 },
			{ target: 'L2', canonical: 'L2', expectedPath: docsPaths.rankDocs.L2 },
			{ target: 'mission', canonical: 'mission', expectedPath: docsPaths.missionDoc },
			{ target: 'manifest', canonical: 'manifest', expectedPath: docsPaths.manifestFile! },
		];

		for (const { target, canonical, expectedPath } of targets) {
			// The very first read lazily materializes the single-copy store on disk.
			const result = await service.readApiDoc(target);
			assert.strictEqual(result.ok, true, `readApiDoc('${target}') should succeed: ${result.error}`);
			assert.strictEqual(result.target, canonical);
			assert.strictEqual(result.path, expectedPath);
			assert.strictEqual(result.revision, ADE_API_LATEST_REVISION);
			assert.ok(result.content && result.content.length > 0, `readApiDoc('${target}') should return content`);
			assert.strictEqual(await fs.promises.readFile(expectedPath, 'utf8'), result.content);
		}

		// Lazy sync writes the full bundle, not only the first requested file.
		assert.ok(fs.existsSync(docsPaths.commonDoc!));
		assert.ok(fs.existsSync(docsPaths.missionDoc));
		assert.ok(fs.existsSync(docsPaths.rankDocs.L1));
		assert.ok(fs.existsSync(docsPaths.rankDocs.L4));
	});

	test('readApiDoc normalizes whitespace and case for canonical targets', async () => {
		const result = await service.readApiDoc('  COMMON  ');
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.target, 'common');

		const rank = await service.readApiDoc(' l2 ');
		assert.strictEqual(rank.ok, true);
		assert.strictEqual(rank.target, 'L2');
	});

	test('readApiDoc rejects unknown targets', async () => {
		for (const target of ['bogus', 'L99', '']) {
			const result = await service.readApiDoc(target);
			assert.strictEqual(result.ok, false, `'${target}' should be rejected`);
			assert.strictEqual(result.path, undefined);
			assert.strictEqual(result.revision, ADE_API_LATEST_REVISION);
			assert.match(result.error ?? '', /Unknown API doc target/);
		}
	});
});
