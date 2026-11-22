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
	buildAdeRemotePersistentPrefix,
	IAdeInboxItem,
	IAdeMissionWatchdogSnapshot,
	IAdeSourceTriggerFireEvent,
	IAdeWatchdogTokenSpec,
	IAdeWatchdogWakeupEvent,
} from '../../common/adeEngineering.js';
import { AdeEngineeringBackendChannel } from '../../common/adeEngineeringIpc.js';
import { parseMissionMermaidDag } from '../../common/adeMissionDag.js';
import { createInitialMissionRuntimeState, IMissionSourceTrigger, recordWatchdogWakeup, startMissionRun } from '../../common/adeMissionEngine.js';
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

	test('remote gpu_idle event uses edge-triggered hysteresis, respects cooldown, and blocks duplicate waves while any downstream token is live', async () => {
		let now = 10_000_000;
		let gpuPct = 4;
		const probedAuthorities: string[] = [];
		const { service, fires } = createHarness({
			now: () => now,
			remoteProbe: createRemoteProbe({
				remoteGpuUtilizationPct: async authority => {
					probedAuthorities.push(authority);
					return gpuPct;
				},
			}),
		});
		const trigger = createTrigger({
			kind: 'event',
			eventType: 'gpu_idle',
			hostAlias: 'gpu-host',
			gpuUtilThresholdPct: 10,
		});
		service.syncMission(createSnapshot({ triggers: [trigger] }));

		// Initial idle observation fires Wave 1 and disarms the edge trigger.
		await service.runTick();
		assert.deepStrictEqual(probedAuthorities, ['gpu-host']);
		assert.strictEqual(fires.length, 1);

		// Staying idle inside cooldown AND even after 60s cooldown must NOT spawn duplicate waves!
		now += 30_000;
		await service.runTick();
		assert.strictEqual(fires.length, 1, 'cooldown blocks refire inside 60s');

		now += 35_000;
		await service.runTick();
		assert.strictEqual(fires.length, 1, 'edge-trigger hysteresis stays disarmed while GPU remains idle');

		// Downstream node N2 is running a wave: GPU goes busy (>10%, re-arming trigger) then dips to 4% while N2 is still active.
		service.syncMission(createSnapshot({
			tokens: [{ tokenId: 'tok-wave1-n2', nodeId: 'N2', status: 'active', lastActivityAt: now }],
			triggers: [trigger],
		}));
		gpuPct = 82;
		now += 10_000;
		await service.runTick();
		assert.strictEqual(fires.length, 1, 'busy GPU re-arms trigger without firing');

		gpuPct = 4;
		now += 10_000;
		await service.runTick();
		assert.strictEqual(fires.length, 1, 'Mission-wide live wave guard blocks Wave 2 while downstream N2 is still active');

		// Once Wave 1 finishes (no live tokens remain), idle GPU fires Wave 2 cleanly!
		service.syncMission(createSnapshot({ tokens: [], triggers: [trigger] }));
		now += 10_000;
		await service.runTick();
		assert.strictEqual(fires.length, 2, 're-armed trigger fires Wave 2 once previous wave finishes');
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

	test('remoteBatchProbe coalesces all probes for one host into a single SSH call while Phase-1 cron fires synchronously without blocking on slow SSH', async () => {
		// 2026-06-15 10:05:00 local time
		const now = new Date(2026, 5, 15, 10, 5, 0, 0).getTime();
		const batchCalls: Array<{ readonly authority: string; readonly spec: Parameters<NonNullable<IAdeRemoteWatchdogProbe['remoteBatchProbe']>>[1] }> = [];
		let resolveSlowBatch!: (value: Awaited<ReturnType<NonNullable<IAdeRemoteWatchdogProbe['remoteBatchProbe']>>>) => void;
		const slowBatchPromise = new Promise<Awaited<ReturnType<NonNullable<IAdeRemoteWatchdogProbe['remoteBatchProbe']>>>>(resolve => {
			resolveSlowBatch = resolve;
		});

		const { service, fires } = createHarness({
			now: () => now,
			remoteProbe: createRemoteProbe({
				remoteBatchProbe: async (authority, spec) => {
					batchCalls.push({ authority, spec });
					return slowBatchPromise;
				},
			}),
		});
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		testDisposables.add(service.onDidWatchdogWakeup(e => wakeups.push(e)));

		const prefix = buildAdeRemotePersistentPrefix('claude', 'sess-batch-1');
		service.syncMission(createSnapshot({
			missionId: 'm-batch',
			tokens: [
				createBlockedToken(
					{
						reason: 'training run',
						startedAt: now - 30_000,
						maxDurationMs: 630_000,
						expiresAt: now + 600_000,
						watchPid: 4242,
						hostAlias: 'gpu-cluster',
					},
					{ tokenId: 'tok-pid', nodeId: 'Train' },
				),
				createBlockedToken(
					{
						reason: 'wait checkpoint',
						startedAt: now - 20_000,
						maxDurationMs: 620_000,
						expiresAt: now + 600_000,
						watchFile: '/srv/run/ckpt.pt',
						initialFileMtime: 1_000,
						hostAlias: 'gpu-cluster',
					},
					{ tokenId: 'tok-file', nodeId: 'Eval' },
				),
				{
					tokenId: 'tok-active',
					nodeId: 'Serve',
					status: 'active',
					lastActivityAt: now - 40_000,
					hostAlias: 'gpu-cluster',
					remoteSessionPrefix: prefix,
				},
			],
			triggers: [
				createTrigger({ id: 'trig-cron', nodeId: 'CronSrc', kind: 'cron', cronExpr: '5 10 * * *' }),
				createTrigger({ id: 'trig-git', nodeId: 'GitSrc', kind: 'event', eventType: 'git_updated', targetPath: '/srv/repo', hostAlias: 'gpu-cluster' }),
				createTrigger({ id: 'trig-gpu', nodeId: 'GpuSrc', kind: 'event', eventType: 'gpu_idle', hostAlias: 'gpu-cluster', gpuUtilThresholdPct: 10 }),
			],
		}));

		// Start runTick WITHOUT resolving slowBatchPromise — Phase 1 must fire the cron trigger BEFORE slow SSH resolves!
		const tickPromise = service.runTick();
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(fires.length, 1, 'Phase-1 cron trigger must fire immediately before slow remote SSH resolves');
		assert.strictEqual(fires[0].triggerId, 'trig-cron');
		assert.strictEqual(batchCalls.length, 1, 'All probes for gpu-cluster must coalesce into ONE single remoteBatchProbe call');
		assert.strictEqual(batchCalls[0].authority, 'gpu-cluster');
		assert.deepStrictEqual(batchCalls[0].spec.pids, [4242]);
		assert.deepStrictEqual(batchCalls[0].spec.filePaths, ['/srv/run/ckpt.pt']);
		assert.deepStrictEqual(batchCalls[0].spec.gitPaths, ['/srv/repo']);
		assert.deepStrictEqual(batchCalls[0].spec.persistentPrefixes, [prefix]);
		assert.strictEqual(batchCalls[0].spec.checkGpu, true);

		// Now resolve the single batched SSH response and assert all 3 token wakeups fire!
		resolveSlowBatch({
			remoteNowMs: now,
			pidAlive: { 4242: false },
			fileMtime: { '/srv/run/ckpt.pt': 2_500 },
			gitHead: { '/srv/repo': 'abcdef12' },
			persistentSessions: { [prefix]: { aliveCount: 0, exitedCodes: [137] } },
			gpuUtilPct: 50,
		});
		await tickPromise;

		assert.strictEqual(wakeups.some(w => w.tokenId === 'tok-pid' && w.reason === 'pid_exited'), true);
		assert.strictEqual(wakeups.some(w => w.tokenId === 'tok-file' && w.reason === 'file_ready'), true);
		assert.strictEqual(wakeups.some(w => w.tokenId === 'tok-active' && w.reason === 'agent_exited'), true);
	});

	test('remoteNowMs clock-offset compensation wakes legacy --watch-file tokens even when remote clock trails local clock by 60s', async () => {
		const localNow = 20_000_000;
		const remoteNowMs = localNow - 60_000; // Remote host clock lags 60 seconds behind laptop
		const remoteFileMtime = remoteNowMs - 2_000; // Written 2s ago on remote (appears 62s behind localNow!)
		const { service } = createHarness({
			now: () => localNow,
			remoteProbe: createRemoteProbe({
				remoteBatchProbe: async () => ({
					remoteNowMs,
					pidAlive: {},
					fileMtime: { '/srv/run/done.json': remoteFileMtime },
					gitHead: {},
					persistentSessions: {},
				}),
			}),
		});
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		testDisposables.add(service.onDidWatchdogWakeup(e => wakeups.push(e)));

		service.syncMission(createSnapshot({
			tokens: [createBlockedToken({
				reason: 'legacy snapshot without initialFileMtime',
				startedAt: localNow - 10_000, // Started 10s ago on local clock
				maxDurationMs: 610_000,
				expiresAt: localNow + 600_000,
				watchFile: '/srv/run/done.json',
				hostAlias: 'lagging-cloud-box',
			})],
		}));

		await service.runTick();
		assert.strictEqual(wakeups.length, 1, 'remoteNowMs offset must prevent false miss caused by remote clock lag');
		assert.strictEqual(wakeups[0].reason, 'file_ready');
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

	test('runDeterministicCheck executes local shell commands, output matching, file assertions, timeouts, and remote SSH delegation at zero LLM cost', async () => {
		const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aexus-det-check-'));
		try {
			// 1. Passing local shell command + regex output match + non-empty file check
			await fs.promises.writeFile(path.join(workDir, 'artifact.txt'), 'compiled-ok\n', 'utf8');
			const passRes = await service.runDeterministicCheck({
				checkId: 'chk-pass',
				name: 'unit-pass',
				command: 'echo "42 passing, 0 failing"',
				cwd: workDir,
				expectOutputMatch: '/\\d+ passing/i',
				expectFiles: ['artifact.txt'],
			});
			assert.strictEqual(passRes.passed, true, passRes.error);
			assert.strictEqual(passRes.exitCode, 0);
			assert.ok(passRes.outputTail.includes('42 passing'));

			// 2. Failing local command captures exit code and stderr tail
			const failRes = await service.runDeterministicCheck({
				checkId: 'chk-fail',
				command: 'echo "AssertionError: expected 1 to equal 2" >&2 && exit 3',
				cwd: workDir,
			});
			assert.strictEqual(failRes.passed, false);
			assert.strictEqual(failRes.exitCode, 3);
			assert.ok(failRes.outputTail.includes('AssertionError'));

			// 3. Zero-subprocess file-only check rejects missing or empty files
			await fs.promises.writeFile(path.join(workDir, 'empty.txt'), '', 'utf8');
			const missingFileRes = await service.runDeterministicCheck({
				checkId: 'chk-files',
				cwd: workDir,
				expectFiles: ['empty.txt', 'missing.bin'],
			});
			assert.strictEqual(missingFileRes.passed, false);
			assert.deepStrictEqual(missingFileRes.missingFiles, ['empty.txt', 'missing.bin']);

			// 4. Output mismatch fails even when exit code is 0
			const mismatchRes = await service.runDeterministicCheck({
				checkId: 'chk-match',
				command: 'echo "skipped"',
				cwd: workDir,
				expectOutputMatch: 'ALL_OK',
			});
			assert.strictEqual(mismatchRes.passed, false);
			assert.strictEqual(mismatchRes.outputMatchFailed, true);

			// 5. Timeout cleanly kills long-running command
			const timeoutRes = await service.runDeterministicCheck({
				checkId: 'chk-timeout',
				command: 'sleep 5',
				cwd: workDir,
				timeoutMs: 1_000,
			});
			assert.strictEqual(timeoutRes.passed, false);
			assert.strictEqual(timeoutRes.timedOut, true);
			assert.strictEqual(timeoutRes.exitCode, 124);

			// 6. Remote host check routes cleanly through remoteProbe.remoteExecCommand + remoteStat
			const remoteCalls: string[] = [];
			const remoteService = testDisposables.add(new AdeDocsBackendNodeService({
				baseDir,
				remoteProbe: {
					remoteIsPidAlive: async () => true,
					remoteFileStatMtime: async () => Date.now(),
					remoteGitHeadCommit: async () => undefined,
					remoteGpuUtilizationPct: async () => undefined,
					remoteStat: async (authority, remotePath) => {
						remoteCalls.push(`stat:${authority}:${remotePath}`);
						return { type: 'file', size: 128, mtime: Date.now() };
					},
					remoteExecCommand: async (authority, opts) => {
						remoteCalls.push(`exec:${authority}:${opts.cwd}:${opts.command}`);
						return { exitCode: 0, outputTail: 'pytest: 18 passed', timedOut: false, durationMs: 42 };
					},
				},
			}));
			const remoteRes = await remoteService.runDeterministicCheck({
				checkId: 'chk-remote',
				hostAlias: 'gpu-box',
				cwd: '/srv/proj',
				command: 'pytest -q',
				expectFiles: ['dist/model.pt'],
				expectOutputMatch: '18 passed',
			});
			assert.strictEqual(remoteRes.passed, true, remoteRes.error);
			assert.deepStrictEqual(remoteCalls, [
				'exec:gpu-box:/srv/proj:pytest -q',
				'stat:gpu-box:/srv/proj/dist/model.pt',
			]);
		} finally {
			await fs.promises.rm(workDir, { recursive: true, force: true });
		}
	});

	test('serializes concurrent saveInbox writes without ENOENT race and broadcasts onDidInboxChange', async () => {
		const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ade-inbox-race-'));
		try {
			const service = testDisposables.add(new AdeDocsBackendNodeService({ baseDir }));
			const changeSnapshots: number[] = [];
			testDisposables.add(service.onDidInboxChange(items => changeSnapshots.push(items.length)));

			// Fire 20 parallel writes in the exact same tick (same Date.now() millisecond)
			const writes = Array.from({ length: 20 }, (_, i) => {
				const batch: IAdeInboxItem[] = Array.from({ length: i + 1 }, (__, j) => ({
					id: `item-${i}-${j}`,
					kind: 'governor_message',
					treeType: 'mission',
					governorSessionId: 'gov-1',
					governorLabel: 'Gov',
					projectPath: '/tmp/proj',
					projectName: 'Proj',
					title: `Alert ${i}-${j}`,
					message: 'parallel write test',
					unread: true,
					resolved: false,
					createdAt: 1_000 + i,
				}));
				return service.saveInbox(batch);
			});
			await Promise.all(writes);

			assert.strictEqual(changeSnapshots.length, 20, 'every serialized save fires onDidInboxChange');
			assert.strictEqual(changeSnapshots[19], 20, 'last serialized write wins cleanly');
			const loaded = await service.loadInbox();
			assert.strictEqual(loaded.length, 20, 'persisted inbox.json is intact and matches final write');

			// Concurrent cross-window atomic mutations (mutateInbox) never overwrite each other's items
			const [resA, resB] = await Promise.all([
				service.mutateInbox({
					kind: 'upsert',
					item: {
						id: 'win-a-alert',
						kind: 'governor_message',
						treeType: 'mission',
						governorSessionId: 'gov-1',
						governorLabel: 'Gov',
						projectPath: '/tmp/proj',
						projectName: 'Proj',
						title: 'Window A Escalation',
						message: 'from A',
						unread: true,
						resolved: false,
						createdAt: 9_001,
					},
				}),
				service.mutateInbox({
					kind: 'upsert',
					item: {
						id: 'win-b-alert',
						kind: 'governor_message',
						treeType: 'mission',
						governorSessionId: 'gov-1',
						governorLabel: 'Gov',
						projectPath: '/tmp/proj',
						projectName: 'Proj',
						title: 'Window B Escalation',
						message: 'from B',
						unread: true,
						resolved: false,
						createdAt: 9_002,
					},
				}),
			]);
			assert.ok(resA.some(i => i.id === 'win-a-alert'));
			assert.ok(resB.some(i => i.id === 'win-a-alert') && resB.some(i => i.id === 'win-b-alert'), 'atomic mutateInbox merges concurrent cross-window posts without losing either item');
			const finalDisk = await service.loadInbox();
			assert.ok(finalDisk.some(i => i.id === 'win-a-alert') && finalDisk.some(i => i.id === 'win-b-alert'));
		} finally {
			await fs.promises.rm(baseDir, { recursive: true, force: true });
		}
	});

	test('AdeEngineeringBackendChannel scopes watchdog wakeups and source triggers to owning window and fails over cleanly on disconnect', async () => {
		let now = 0;
		const watchdog = testDisposables.add(new AdeMissionWatchdogService({
			localProbe: createLocalProbe(),
			pollIntervalMs: 60_000,
			now: () => now,
		}));
		const channel = testDisposables.add(new AdeEngineeringBackendChannel({
			_serviceBrand: undefined,
			onDidWatchdogWakeup: watchdog.onDidWatchdogWakeup,
			onDidSourceTriggerFire: watchdog.onDidSourceTriggerFire,
			loadInbox: async () => [],
			saveInbox: async () => undefined,
			syncMissionWatchdog: async snap => watchdog.syncMission(snap),
			removeMissionWatchdog: async id => watchdog.removeMission(id),
		}));

		const win1Wakeups: IAdeWatchdogWakeupEvent[] = [];
		const win2Wakeups: IAdeWatchdogWakeupEvent[] = [];
		const win1Triggers: IAdeSourceTriggerFireEvent[] = [];
		const win2Triggers: IAdeSourceTriggerFireEvent[] = [];

		const win1WakeSub = channel.listen<IAdeWatchdogWakeupEvent>('window:1', 'onDidWatchdogWakeup')(e => win1Wakeups.push(e));
		testDisposables.add(channel.listen<IAdeWatchdogWakeupEvent>('window:2', 'onDidWatchdogWakeup')(e => win2Wakeups.push(e)));
		const win1TrigSub = channel.listen<IAdeSourceTriggerFireEvent>('window:1', 'onDidSourceTriggerFire')(e => win1Triggers.push(e));
		testDisposables.add(channel.listen<IAdeSourceTriggerFireEvent>('window:2', 'onDidSourceTriggerFire')(e => win2Triggers.push(e)));

		try {
			// Window 1 starts Mission m1
			await channel.call('window:1', 'syncMissionWatchdog', createSnapshot({
				missionId: 'm1',
				silenceTimeoutMinutes: 5,
				tokens: [{ tokenId: 'tok-1', nodeId: 'N1', status: 'active', lastActivityAt: 0 }],
				triggers: [createTrigger({ id: 'trig-1', nodeId: 'N2', kind: 'once', fireAt: 100_000 })],
			}));

			// Window 2 passively rehydrates m1 on startup -> preserveExistingOwner MUST NOT steal ownership from window:1
			await channel.call('window:2', 'syncMissionWatchdog', createSnapshot({
				missionId: 'm1',
				silenceTimeoutMinutes: 5,
				preserveExistingOwner: true,
				tokens: [{ tokenId: 'tok-1', nodeId: 'N1', status: 'active', lastActivityAt: 0 }],
				triggers: [createTrigger({ id: 'trig-1', nodeId: 'N2', kind: 'once', fireAt: 100_000 })],
			}));

			now = 6 * 60_000;
			await watchdog.runTick();
			assert.strictEqual(win1Wakeups.length, 1, 'owning window:1 receives silence wakeup');
			assert.strictEqual(win2Wakeups.length, 0, 'non-owning window:2 MUST NOT receive duplicate wakeup');
			assert.strictEqual(win1Triggers.length, 1, 'owning window:1 receives source trigger');
			assert.strictEqual(win2Triggers.length, 0, 'non-owning window:2 MUST NOT receive duplicate trigger');

			// Simulate Window 1 closing -> failover cleanly to live Window 2 on next timeout
			win1WakeSub.dispose();
			win1TrigSub.dispose();
			now = 12 * 60_000;
			await watchdog.runTick();
			assert.strictEqual(win2Wakeups.length, 1, 'live window:2 takes over wakeups once owner window:1 closes');
		} finally {
			win1WakeSub.dispose();
			win1TrigSub.dispose();
		}
	});

	test('runTick probes missions concurrently and isolates slow/hanging remote SSH probes without stalling local wakeups', async () => {
		const now = 50_000_000;
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		const watchdog = testDisposables.add(new AdeMissionWatchdogService({
			now: () => now,
			pollIntervalMs: 60_000,
			probeTimeoutMs: 120,
			localProbe: createLocalProbe({
				fileStatMtime: async () => now + 5_000,
			}),
			remoteProbe: createRemoteProbe({
				remoteFileStatMtime: async hostAlias => {
					if (hostAlias === 'hanging-gpu') {
						// Simulates a dead SSH socket that hangs for 10s+
						return new Promise(() => { /* never settles */ });
					}
					return now + 1_000;
				},
			}),
		}));
		testDisposables.add(watchdog.onDidWatchdogWakeup(ev => wakeups.push(ev)));

		watchdog.syncMission(createSnapshot({
			missionId: 'm-hang',
			tokens: [{
				tokenId: 'tok-hang',
				nodeId: 'N1',
				status: 'blocked',
				lastActivityAt: now,
				blocked: {
					reason: 'remote training',
					startedAt: now - 5_000,
					maxDurationMs: 3_600_000,
					expiresAt: now + 3_600_000,
					watchFile: '/srv/model.pt',
					initialFileMtime: null,
					hostAlias: 'hanging-gpu',
				},
			}],
		}));
		watchdog.syncMission(createSnapshot({
			missionId: 'm-fast',
			tokens: [
				{
					tokenId: 'tok-local',
					nodeId: 'N1',
					status: 'blocked',
					lastActivityAt: now,
					blocked: {
						reason: 'local build',
						startedAt: now - 5_000,
						maxDurationMs: 3_600_000,
						expiresAt: now + 3_600_000,
						watchFile: '/tmp/done.ok',
						initialFileMtime: null,
						hostAlias: 'local',
					},
				},
				{
					tokenId: 'tok-silence',
					nodeId: 'N2',
					status: 'active',
					lastActivityAt: now - 10 * 60_000,
				},
			],
		}));

		const t0 = Date.now();
		await watchdog.runTick();
		const elapsed = Date.now() - t0;

		assert.ok(elapsed < 1500, `Hanging SSH probe must be capped by probeTimeoutMs (took ${elapsed}ms)`);
		assert.ok(wakeups.some(w => w.missionId === 'm-fast' && w.tokenId === 'tok-local' && w.reason === 'file_ready'), 'local blocked wakeup fires despite hanging remote host');
		assert.ok(wakeups.some(w => w.missionId === 'm-fast' && w.tokenId === 'tok-silence' && w.reason === 'silence_timeout'), 'silence nudge fires synchronously despite hanging remote host');
		assert.strictEqual(wakeups.some(w => w.tokenId === 'tok-hang'), false);
	});

	test('checkBlockedWakeup uses host initialFileMtime baseline so remote clock drift never misses --watch-file', async () => {
		const localStartedAt = 1_700_000_000_000;
		const skewedRemoteMtime = localStartedAt - 60_000; // Remote host clock lags local host by 60 seconds!
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		let remoteMtime: number | undefined = undefined;
		const watchdog = testDisposables.add(new AdeMissionWatchdogService({
			now: () => localStartedAt + 5_000,
			pollIntervalMs: 60_000,
			localProbe: createLocalProbe(),
			remoteProbe: createRemoteProbe({
				remoteFileStatMtime: async () => remoteMtime,
			}),
		}));
		testDisposables.add(watchdog.onDidWatchdogWakeup(ev => wakeups.push(ev)));

		// Case 1: File did not exist at block time (initialFileMtime: null) -> appears with skewed mtime < startedAt -> wakes!
		watchdog.syncMission(createSnapshot({
			missionId: 'm-skew-1',
			tokens: [{
				tokenId: 'tok-skew-1',
				nodeId: 'N1',
				status: 'blocked',
				lastActivityAt: localStartedAt,
				blocked: {
					reason: 'wait new file',
					startedAt: localStartedAt,
					maxDurationMs: 600_000,
					expiresAt: localStartedAt + 600_000,
					watchFile: '/srv/out.json',
					initialFileMtime: null,
					hostAlias: 'gpu-skew',
				},
			}],
		}));
		await watchdog.runTick();
		assert.strictEqual(wakeups.length, 0, 'still missing -> no wakeup');

		remoteMtime = skewedRemoteMtime;
		await watchdog.runTick();
		assert.strictEqual(wakeups.length, 1, 'newly created remote file wakes even when remote clock lags local clock by 60s');
		assert.strictEqual(wakeups[0].reason, 'file_ready');

		// Case 2: File already existed at block time (initialFileMtime = skewedRemoteMtime) -> unchanged does NOT wake, updated +1s DOES wake!
		watchdog.syncMission(createSnapshot({
			missionId: 'm-skew-2',
			tokens: [{
				tokenId: 'tok-skew-2',
				nodeId: 'N1',
				status: 'blocked',
				lastActivityAt: localStartedAt,
				blocked: {
					reason: 'wait overwrite',
					startedAt: localStartedAt,
					maxDurationMs: 600_000,
					expiresAt: localStartedAt + 600_000,
					watchFile: '/srv/overwrite.json',
					initialFileMtime: skewedRemoteMtime,
					hostAlias: 'gpu-skew',
				},
			}],
		}));
		await watchdog.runTick();
		assert.strictEqual(wakeups.length, 1, 'unchanged mtime === initialFileMtime must not wake');

		remoteMtime = skewedRemoteMtime + 1_000;
		await watchdog.runTick();
		assert.strictEqual(wakeups.length, 2, 'changed mtime !== initialFileMtime wakes immediately despite mtime < local startedAt');
		assert.strictEqual(wakeups[1].tokenId, 'tok-skew-2');
	});

	test('persists triggerMemory across Watchdog restarts so file/git changes during IDE downtime still fire', async () => {
		const persistDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ade-wd-persist-'));
		const triggerStatePath = path.join(persistDir, 'watchdog-triggers.json');
		let headCommit = 'aaa1111';
		const now = 90_000_000;

		try {
			const wd1 = testDisposables.add(new AdeMissionWatchdogService({
				now: () => now,
				pollIntervalMs: 60_000,
				triggerStatePath,
				localProbe: createLocalProbe({ gitHeadCommit: async () => headCommit }),
			}));
			const fires1: IAdeSourceTriggerFireEvent[] = [];
			testDisposables.add(wd1.onDidSourceTriggerFire(ev => fires1.push(ev)));

			wd1.syncMission(createSnapshot({
				missionId: 'm-persist',
				triggers: [createTrigger({ id: 'tr-git', kind: 'event', eventType: 'git_updated', targetPath: persistDir })],
			}));
			await wd1.runTick();
			assert.strictEqual(fires1.length, 0, 'first tick establishes baseline on disk');
			assert.strictEqual(fs.existsSync(triggerStatePath), true, 'triggerStatePath persisted to disk');

			// Simulate IDE restart + git commit arriving while IDE was closed!
			wd1.dispose();
			headCommit = 'bbb2222';

			const wd2 = testDisposables.add(new AdeMissionWatchdogService({
				now: () => now + 60_000,
				pollIntervalMs: 60_000,
				triggerStatePath,
				localProbe: createLocalProbe({ gitHeadCommit: async () => headCommit }),
			}));
			const fires2: IAdeSourceTriggerFireEvent[] = [];
			testDisposables.add(wd2.onDidSourceTriggerFire(ev => fires2.push(ev)));

			wd2.syncMission(createSnapshot({
				missionId: 'm-persist',
				triggers: [createTrigger({ id: 'tr-git', kind: 'event', eventType: 'git_updated', targetPath: persistDir })],
			}));
			await wd2.runTick();
			assert.strictEqual(fires2.length, 1, 'restarted watchdog hydrates persisted baseline and immediately fires git_updated for downtime commit');
			assert.ok(fires2[0].detail?.includes('bbb2222'));
		} finally {
			await fs.promises.rm(persistDir, { recursive: true, force: true });
		}
	});

	test('AdeDocsBackendNodeService.readApiDoc validates manifest revision & rank config fingerprint instead of serving stale disk docs', async () => {
		const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ade-docs-stale-'));
		try {
			const service = testDisposables.add(new AdeDocsBackendNodeService({ baseDir }));
			const paths = buildAdeDocsPaths(baseDir, DEFAULT_ADE_ORGANIZATION_CONFIG.ranks.length);
			await fs.promises.mkdir(paths.commonDir!, { recursive: true });
			// Seed an outdated doc + stale manifest revision on disk
			await fs.promises.writeFile(paths.commonDoc!, '# STALE OLD COMMON DOC\n', 'utf8');
			await fs.promises.writeFile(paths.manifestFile!, JSON.stringify({
				currentRevision: ADE_API_LATEST_REVISION - 1,
				rankCount: 1,
				configFingerprint: 'stale-fp',
			}), 'utf8');

			const res = await service.readApiDoc('common', DEFAULT_ADE_ORGANIZATION_CONFIG);
			assert.strictEqual(res.revision, ADE_API_LATEST_REVISION);
			assert.strictEqual((res.content ?? '').includes('STALE OLD COMMON DOC'), false, 'readApiDoc must resync instead of returning stale cached disk doc');
			assert.ok((res.content ?? '').length > 100);
		} finally {
			await fs.promises.rm(baseDir, { recursive: true, force: true });
		}
	});

	test('AdeEngineeringBackendChannel buffers watchdog wakeups & source triggers while 0 windows are open and flushes once on reconnect', async () => {
		let now = 0;
		const watchdog = testDisposables.add(new AdeMissionWatchdogService({
			localProbe: createLocalProbe(),
			pollIntervalMs: 60_000,
			now: () => now,
		}));
		const channel = testDisposables.add(new AdeEngineeringBackendChannel({
			_serviceBrand: undefined,
			onDidWatchdogWakeup: watchdog.onDidWatchdogWakeup,
			onDidSourceTriggerFire: watchdog.onDidSourceTriggerFire,
			loadInbox: async () => [],
			saveInbox: async () => undefined,
			syncMissionWatchdog: async snap => watchdog.syncMission(snap),
			removeMissionWatchdog: async id => watchdog.removeMission(id),
		}));

		// Register Mission while window:1 is connected, then close ALL windows (0 listeners).
		await channel.call('window:1', 'syncMissionWatchdog', createSnapshot({
			missionId: 'm-zero-win',
			silenceTimeoutMinutes: 5,
			tokens: [{ tokenId: 'tok-zw', nodeId: 'N1', status: 'active', lastActivityAt: 0 }],
			triggers: [createTrigger({ id: 'trig-zw', nodeId: 'N2', kind: 'once', fireAt: 100_000 })],
		}));

		// Tick fires while 0 windows are listening (e.g. window reload / macOS background daemon mode).
		now = 6 * 60_000;
		await watchdog.runTick();

		const winReloadedWakeups: IAdeWatchdogWakeupEvent[] = [];
		const winReloadedTriggers: IAdeSourceTriggerFireEvent[] = [];
		const win2Wakeups: IAdeWatchdogWakeupEvent[] = [];
		const win2Triggers: IAdeSourceTriggerFireEvent[] = [];

		testDisposables.add(channel.listen<IAdeWatchdogWakeupEvent>('window:reloaded', 'onDidWatchdogWakeup')(e => winReloadedWakeups.push(e)));
		testDisposables.add(channel.listen<IAdeSourceTriggerFireEvent>('window:reloaded', 'onDidSourceTriggerFire')(e => winReloadedTriggers.push(e)));
		// Flush runs on microtask after listener attachment
		await Promise.resolve();

		assert.strictEqual(winReloadedWakeups.length, 1, 'buffered wakeup must flush immediately to reconnected window');
		assert.strictEqual(winReloadedWakeups[0].tokenId, 'tok-zw');
		assert.strictEqual(winReloadedTriggers.length, 1, 'buffered source trigger must flush immediately to reconnected window');
		assert.strictEqual(winReloadedTriggers[0].triggerId, 'trig-zw');

		// A second window attaching afterwards must NOT receive already-flushed events.
		testDisposables.add(channel.listen<IAdeWatchdogWakeupEvent>('window:second', 'onDidWatchdogWakeup')(e => win2Wakeups.push(e)));
		testDisposables.add(channel.listen<IAdeSourceTriggerFireEvent>('window:second', 'onDidSourceTriggerFire')(e => win2Triggers.push(e)));
		await Promise.resolve();
		assert.strictEqual(win2Wakeups.length, 0);
		assert.strictEqual(win2Triggers.length, 0);
	});

	test('persists running Mission Watchdog snapshots across restarts so main-process supervision survives before any window reconnects', async () => {
		const persistDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ade-wd-snap-'));
		const snapshotStatePath = path.join(persistDir, 'watchdog-snapshots.json');
		let now = 1_000;
		try {
			const wd1 = testDisposables.add(new AdeMissionWatchdogService({
				now: () => now,
				pollIntervalMs: 60_000,
				snapshotStatePath,
				localProbe: createLocalProbe(),
			}));
			wd1.syncMission(createSnapshot({
				missionId: 'm-daemon-snap',
				silenceTimeoutMinutes: 5,
				tokens: [{ tokenId: 'tok-snap', nodeId: 'N1', status: 'active', lastActivityAt: 1_000 }],
			}));
			await wd1.runTick();
			assert.strictEqual(fs.existsSync(snapshotStatePath), true, 'snapshotStatePath persisted to disk');
			wd1.dispose();

			// Restart Watchdog WITHOUT calling syncMission — must hydrate running snapshot from disk!
			now = 1_000 + 6 * 60_000;
			const wd2 = testDisposables.add(new AdeMissionWatchdogService({
				now: () => now,
				pollIntervalMs: 60_000,
				snapshotStatePath,
				localProbe: createLocalProbe(),
			}));
			const wakeups: IAdeWatchdogWakeupEvent[] = [];
			testDisposables.add(wd2.onDidWatchdogWakeup(ev => wakeups.push(ev)));
			await wd2.runTick();
			assert.strictEqual(wakeups.length, 1, 'hydrated daemon snapshot fires silence wakeup before any renderer calls syncMission');
			assert.strictEqual(wakeups[0].missionId, 'm-daemon-snap');
			assert.strictEqual(wakeups[0].tokenId, 'tok-snap');
		} finally {
			await fs.promises.rm(persistDir, { recursive: true, force: true });
		}
	});

	test('detects crashed/exited remote persistent session quickly via agent_exited instead of waiting 15 minutes', async () => {
		let now = 10_000;
		let remoteSessionStatus: { readonly aliveCount: number; readonly exitedCodes: readonly number[] } = { aliveCount: 1, exitedCodes: [] };
		const remoteProbe: IAdeRemoteWatchdogProbe = {
			remoteIsPidAlive: async () => true,
			remoteFileStatMtime: async () => undefined,
			remoteGitHeadCommit: async () => undefined,
			remoteGpuUtilizationPct: async () => undefined,
			remoteCheckPersistentSessions: async () => remoteSessionStatus,
		};
		const watchdog = testDisposables.add(new AdeMissionWatchdogService({
			now: () => now,
			pollIntervalMs: 60_000,
			remoteProbe,
			remoteSessionProbeGraceMs: 20_000,
			remoteSessionExitCooldownMs: 60_000,
		}));
		const wakeups: IAdeWatchdogWakeupEvent[] = [];
		testDisposables.add(watchdog.onDidWatchdogWakeup(ev => wakeups.push(ev)));

		const prefix = buildAdeRemotePersistentPrefix('claude', 'sess-remote-gpu-1');
		watchdog.syncMission(createSnapshot({
			missionId: 'm-remote-fast',
			silenceTimeoutMinutes: 5,
			tokens: [{
				tokenId: 'tok-gpu',
				nodeId: 'Train',
				holderAgentId: 'agent-gpu',
				status: 'active',
				lastActivityAt: now,
				hostAlias: 'gpu-a100',
				remoteSessionPrefix: prefix,
			}],
		}));

		// Remote persistent agent is alive at +30s -> zero false alerts.
		now += 30_000;
		await watchdog.runTick();
		assert.strictEqual(wakeups.length, 0, 'alive remote persistent session must not trigger agent_exited');

		// Remote agent gets OOM-killed (exit 137) at +40s (well before the 5m / 15m silence window!) -> immediate agent_exited!
		remoteSessionStatus = { aliveCount: 0, exitedCodes: [137] };
		now += 10_000;
		await watchdog.runTick();
		assert.strictEqual(wakeups.length, 1, 'exited remote persistent session must trigger immediate agent_exited wakeup');
		assert.strictEqual(wakeups[0].reason, 'agent_exited');
		assert.ok(wakeups[0].detail?.includes('137'));

		// Verify recordWatchdogWakeup handles agent_exited cleanly and escalates after max retries.
		const graph = parseMissionMermaidDag('flowchart LR\n  Train[Train] --> Eval[Eval]');
		const init = createInitialMissionRuntimeState('m-remote-fast', DEFAULT_ADE_ORGANIZATION_CONFIG, undefined, graph.nodes.map(n => n.id));
		const started = startMissionRun(init, graph, DEFAULT_ADE_ORGANIZATION_CONFIG, { now: 1_000 });
		assert.strictEqual(started.ok, true);
		const activeTok = Object.values(started.state.tokens)[0];
		const fastRecovery = recordWatchdogWakeup(started.state, {
			tokenId: activeTok.id,
			reason: 'agent_exited',
			detail: 'exited with code 137',
			graph,
			now: 50_000,
		});
		assert.strictEqual(fastRecovery.ok, true);
		assert.ok(fastRecovery.effects.some(e => e.kind === 'wakeup_agent' && e.wakeupReason === 'agent_exited'));
	});

	test('AdeDocsBackendNodeService.notifySystemResume broadcasts onDidSystemResume and wakes watchdog', async () => {
		const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ade-resume-'));
		try {
			const service = testDisposables.add(new AdeDocsBackendNodeService({ baseDir }));
			const resumeTimestamps: number[] = [];
			testDisposables.add(service.onDidSystemResume(ts => resumeTimestamps.push(ts)));
			await service.notifySystemResume();
			assert.strictEqual(resumeTimestamps.length, 1);
			assert.ok(resumeTimestamps[0] > 0);
		} finally {
			await fs.promises.rm(baseDir, { recursive: true, force: true });
		}
	});
});
