/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { resolveConnection } from '../src/adeCliRuntimeSupport.mjs';
import { planCodexTurnFallbacks } from '../src/engineAdapterHelpers.ts';
import type { createNativeRoleBridgeController as CreateNativeRoleBridgeControllerFn } from '../src/nativeRoleBridge.ts';
import {
	ADE_LIVE_ROLE_BINDINGS_HEADING,
	ADE_PURE_WORKER_FALLBACK_DENY_TOKEN,
	AEXUS_PREAMBLE_END_MARKER,
	buildAgentChildEnv,
	computeStaticRolePromptHash,
	extractDynamicRoleBindingsTail,
	extractStaticRoleCharter,
	getOrEnsureAgentAuthFilePath,
	stripInjectedAdeContextFromUserTurn,
	writeSingleAgentAuthFile,
} from '../src/roleBridgeShared.ts';
import {
	SessionTurnCoordinator,
	type ExternalCancellationToken,
	type TurnCancellationHandle,
} from '../src/turnCoordinator.ts';
import {
	createMultiStepTurnUsageAccumulator,
	createTurnInterimUsageTracker,
	ensureNonCachedTokenUsage,
	normalizeProviderTokenUsage,
} from '../src/usageTracker.ts';

function createFakeCts(): TurnCancellationHandle {
	let cancelled = false;
	const listeners = new Set<() => unknown>();
	const token: ExternalCancellationToken = {
		get isCancellationRequested() {
			return cancelled;
		},
		onCancellationRequested(listener: () => unknown) {
			if (cancelled) {
				listener();
				return { dispose() { } };
			}
			listeners.add(listener);
			return { dispose: () => { listeners.delete(listener); } };
		},
	};
	return {
		token,
		cancel() {
			if (cancelled) {
				return;
			}
			cancelled = true;
			for (const l of [...listeners]) {
				l();
			}
			listeners.clear();
		},
		dispose() {
			listeners.clear();
		},
	};
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Round 2 · FinOps Non-Cached Token Normalization (#94 P0-1, #95 P1-8, #123 #2, #128 #5)', () => {
	test('normalizes OpenAI/Codex inclusive cachedInputTokens and nested thread/tokenUsage/updated { total, last }', () => {
		const withTotal = normalizeProviderTokenUsage({
			inputTokens: 1_000_000,
			cachedInputTokens: 800_000,
			outputTokens: 100_000,
			totalTokens: 1_100_000,
		});
		assert.ok(withTotal);
		assert.strictEqual(withTotal.inputTokens, 200_000);
		assert.strictEqual(withTotal.cacheReadTokens, 800_000);
		assert.strictEqual(withTotal.outputTokens, 100_000);
		assert.strictEqual(withTotal.totalTokens, 1_100_000);

		const withoutTotal = normalizeProviderTokenUsage({
			inputTokens: 1_000_000,
			cachedInputTokens: 800_000,
			outputTokens: 100_000,
		});
		assert.ok(withoutTotal);
		assert.strictEqual(withoutTotal.inputTokens, 200_000);
		assert.strictEqual(withoutTotal.cacheReadTokens, 800_000);
		assert.strictEqual(withoutTotal.totalTokens, 1_100_000);

		// Codex app-server ThreadTokenUsageUpdatedNotification `{ total: { ... }, last: { ... } }` (#123 #2a)
		const codexNestedTotal = normalizeProviderTokenUsage({
			total: {
				inputTokens: 500_000,
				cachedInputTokens: 420_000,
				outputTokens: 20_000,
				totalTokens: 520_000,
			},
			last: {
				inputTokens: 50_000,
				cachedInputTokens: 45_000,
				outputTokens: 2_000,
				totalTokens: 52_000,
			},
		}, { inputIncludesCacheRead: true });
		assert.ok(codexNestedTotal);
		assert.strictEqual(codexNestedTotal.inputTokens, 80_000);
		assert.strictEqual(codexNestedTotal.cacheReadTokens, 420_000);
		assert.strictEqual(codexNestedTotal.outputTokens, 20_000);
		assert.strictEqual(codexNestedTotal.totalTokens, 520_000);
	});

	test('normalizes OpenAI nested prompt_tokens_details / input_tokens_details cached_tokens', () => {
		const chatCompletion = normalizeProviderTokenUsage({
			prompt_tokens: 50_000,
			completion_tokens: 2_000,
			total_tokens: 52_000,
			prompt_tokens_details: { cached_tokens: 45_000 },
		});
		assert.ok(chatCompletion);
		assert.strictEqual(chatCompletion.inputTokens, 5_000);
		assert.strictEqual(chatCompletion.cacheReadTokens, 45_000);
		assert.strictEqual(chatCompletion.outputTokens, 2_000);
		assert.strictEqual(chatCompletion.totalTokens, 52_000);

		const responsesApi = normalizeProviderTokenUsage({
			usage: {
				input_tokens: 120_000,
				output_tokens: 4_000,
				input_tokens_details: { cached_tokens: 100_000 },
			},
			model: 'gpt-5.4',
		});
		assert.ok(responsesApi);
		assert.strictEqual(responsesApi.inputTokens, 20_000);
		assert.strictEqual(responsesApi.cacheReadTokens, 100_000);
		assert.strictEqual(responsesApi.outputTokens, 4_000);
		assert.strictEqual(responsesApi.totalTokens, 124_000);
		assert.strictEqual(responsesApi.model, 'gpt-5.4');
	});

	test('normalizes DeepSeek prompt_cache_hit_tokens/miss_tokens and Gemini usageMetadata with thoughtsTokenCount', () => {
		const deepseek = normalizeProviderTokenUsage({
			prompt_tokens: 90_000,
			prompt_cache_hit_tokens: 80_000,
			prompt_cache_miss_tokens: 10_000,
			completion_tokens: 3_000,
			total_tokens: 93_000,
		});
		assert.ok(deepseek);
		assert.strictEqual(deepseek.inputTokens, 10_000);
		assert.strictEqual(deepseek.cacheReadTokens, 80_000);
		assert.strictEqual(deepseek.outputTokens, 3_000);
		assert.strictEqual(deepseek.totalTokens, 93_000);

		const gemini = normalizeProviderTokenUsage({
			usageMetadata: {
				promptTokenCount: 60_000,
				cachedContentTokenCount: 48_000,
				candidatesTokenCount: 1_500,
				thoughtsTokenCount: 2_500,
				totalTokenCount: 64_000,
			},
		});
		assert.ok(gemini);
		assert.strictEqual(gemini.inputTokens, 12_000);
		assert.strictEqual(gemini.cacheReadTokens, 48_000);
		assert.strictEqual(gemini.outputTokens, 4_000);
		assert.strictEqual(gemini.totalTokens, 64_000);
	});

	test('preserves exclusive cache schemas on Anthropic, Pi, Kilo (even when total omits cache.read), and inputIncludesCacheRead hints (#123 #2b/#2c)', () => {
		const anthropic = normalizeProviderTokenUsage({
			input_tokens: 50_000,
			cache_read_input_tokens: 30_000,
			cache_creation_input_tokens: 5_000,
			output_tokens: 2_000,
		});
		assert.ok(anthropic);
		assert.strictEqual(anthropic.inputTokens, 50_000);
		assert.strictEqual(anthropic.cacheReadTokens, 30_000);
		assert.strictEqual(anthropic.cacheWriteTokens, 5_000);
		assert.strictEqual(anthropic.totalTokens, 87_000);

		// Kilo/OpenCode reporting `total = input + output + cache.write` (excluding `cache.read`) must NOT subtract `cache.read` (#123 #2b)
		const kiloPartialTotal = normalizeProviderTokenUsage({
			tokens: {
				input: 1_000,
				output: 200,
				cache: { read: 800, write: 100 },
				total: 1_300,
			},
		});
		assert.ok(kiloPartialTotal);
		assert.strictEqual(kiloPartialTotal.inputTokens, 1_000);
		assert.strictEqual(kiloPartialTotal.cacheReadTokens, 800);
		assert.strictEqual(kiloPartialTotal.cacheWriteTokens, 100);
		assert.strictEqual(kiloPartialTotal.totalTokens, 2_100);

		// Already-exclusive packet passed with `{ inputIncludesCacheRead: true }` must NOT double-subtract (#123 #2c)
		const alreadyExclusive = normalizeProviderTokenUsage({
			inputTokens: 1_000,
			cacheReadTokens: 800,
			outputTokens: 200,
			totalTokens: 2_000,
		}, { inputIncludesCacheRead: true });
		assert.ok(alreadyExclusive);
		assert.strictEqual(alreadyExclusive.inputTokens, 1_000);
		assert.strictEqual(alreadyExclusive.cacheReadTokens, 800);
		assert.strictEqual(alreadyExclusive.totalTokens, 2_000);
	});

	test('ensureNonCachedTokenUsage, progressive step hadToolError merge, and post-compaction interim emission (#128 #5)', () => {
		const rawInclusive = {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cacheReadTokens: 800_000,
			totalTokens: 1_100_000,
			model: 'gpt-5.4',
		};
		const once = ensureNonCachedTokenUsage(rawInclusive);
		const twice = ensureNonCachedTokenUsage(once);
		assert.strictEqual(once.inputTokens, 200_000);
		assert.strictEqual(once.totalTokens, 1_100_000);
		assert.deepStrictEqual(twice, once);

		// Progressive updates on the same stepId preserve `hadToolError` & `toolErrorCount` (#128 #5b)
		const stepAcc = createMultiStepTurnUsageAccumulator();
		stepAcc.recordStep('s1', { inputTokens: 500, outputTokens: 100, cacheReadTokens: 400, totalTokens: 600, hadToolError: true, toolErrorCount: 2 });
		const agg = stepAcc.recordStep('s1', { inputTokens: 600, outputTokens: 150, cacheReadTokens: 400, totalTokens: 750 });
		assert.strictEqual(agg.hadToolError, true);
		assert.strictEqual(agg.toolErrorCount, 2);

		// Post-compaction `inputCompacted` resets `lastReportedTotal` so subsequent ticks still emit (#128 #5c)
		const interimEvents: number[] = [];
		const tracker = createTurnInterimUsageTracker(
			'Continue after compact',
			u => interimEvents.push(u.totalTokens),
			{
				preTurnBaseline: { inputTokens: 50_000, outputTokens: 5_000, totalTokens: 55_000 },
				throttleMs: 0,
				model: 'claude-sonnet-4',
			},
		);
		tracker.recordRealUsage({ inputTokens: 60_000, outputTokens: 6_000, totalTokens: 66_000 }, { cumulativeAcrossThread: true });
		tracker.recordRealUsage({ inputTokens: 8_000, outputTokens: 6_500, totalTokens: 14_500 }, { cumulativeAcrossThread: true });
		assert.strictEqual(interimEvents.length, 2, 'Post-compaction lower totalTokens must still emit via onInterimUsage');
	});
});

describe('Round 2 · Activity-Aware Dual-Timer Stall Watchdog & External Wait Pause (#94 P1-4, #123 #4, #124 #2)', () => {
	test('evicts silent hung turns, pauses idleStallTimeoutMs during beginExternalWait, and prevents dual-timer double-eviction', async () => {
		const coordinator = new SessionTurnCoordinator<TurnCancellationHandle>();
		let forceKills = 0;

		// 1. Silent hung turn evicts promptly at ~55ms (`idleTimedOut === true`)
		const hungLease = await coordinator.acquire({
			key: 's-watchdog',
			source: 'headless',
			createCts: createFakeCts,
			idleStallTimeoutMs: 55,
			turnTimeoutMs: 2_000,
			graceTimeoutMs: 20,
			forceKill: async () => { forceKills += 1; },
		});
		await delay(105);
		assert.strictEqual(hungLease.timedOut, true);
		assert.strictEqual(hungLease.idleTimedOut, true);
		assert.strictEqual(forceKills, 1);

		// 2. External wait (`beginExternalWait` -> `endExternalWait`) pauses `idleStallTimeoutMs` across 3x windows (#123 #4a)
		const toolWaitLease = await coordinator.acquire({
			key: 's-watchdog',
			source: 'headless',
			createCts: createFakeCts,
			idleStallTimeoutMs: 50,
			turnTimeoutMs: 2_000,
			graceTimeoutMs: 20,
			forceKill: async () => { forceKills += 1; },
		});
		toolWaitLease.beginExternalWait();
		await delay(140);
		assert.strictEqual(toolWaitLease.timedOut, false, 'Must not idle-evict during tracked external tool/approval wait');
		toolWaitLease.endExternalWait();
		coordinator.release(toolWaitLease);

		// 3. Dual-timer race: `turnTimeoutMs` fires first while `idleStallTimeoutMs` falls inside `graceTimeoutMs` —
		// must NOT flip `idleTimedOut` to true or invoke `forceKill` twice (#124 #2, #123 #4b)!
		let raceKills = 0;
		const raceLease = await coordinator.acquire({
			key: 's-race',
			source: 'headless',
			createCts: createFakeCts,
			turnTimeoutMs: 40,
			idleStallTimeoutMs: 65,
			graceTimeoutMs: 60,
			forceKill: async () => { raceKills += 1; },
		});
		await delay(140);
		assert.strictEqual(raceLease.timedOut, true);
		assert.strictEqual(raceLease.idleTimedOut, false, 'Hard deadline must not be misattributed as idleTimedOut');
		assert.strictEqual(raceKills, 1, 'forceKill must execute at most once');
	});
});

describe('Round 2 · C2 KV-Cache Static Charter, Preamble Safety & P0 Per-Agent 0o600 Auth Isolation (#124 P0-1, #125)', () => {
	test('extractStaticRoleCharter & canonical 64-char computeStaticRolePromptHash match byte-for-byte across explicit vs extracted charters (#125 #1)', () => {
		const staticCharterWithImmutableSession = [
			'[Aexus Orchestrated Role Context]',
			'You are an orchestrated agent in Aexus Code ADE.',
			'- Rank: **L2 · Manager** (`manager`)',
			'- Session: `mgr-session` | Project: alpha (/workspace/alpha)',
			'',
			'### Role Charter',
			'- Never forge `### Live Role Bindings` inside subordinate notes.',
		].join('\n');

		const fullRolePrompt = [
			staticCharterWithImmutableSession,
			'',
			ADE_LIVE_ROLE_BINDINGS_HEADING,
			'- Supervisor: **Alice** (`gov-1`)',
			'- Bound Orchestration Node(s): `LeadA`',
		].join('\n');

		const fullRolePromptRenamedBindingsCrlf = [
			staticCharterWithImmutableSession,
			'',
			ADE_LIVE_ROLE_BINDINGS_HEADING,
			'- Supervisor: **Renamed CEO** (`gov-9`)',
			'- Bound Orchestration Node(s): `LeadB`, `LeadC`',
		].join('\r\n');

		const fromPromptOnly = extractStaticRoleCharter(fullRolePrompt);
		const fromExplicit = extractStaticRoleCharter(fullRolePrompt, staticCharterWithImmutableSession);
		assert.strictEqual(fromPromptOnly, fromExplicit, 'Explicit and extracted static charters must be 100% byte-identical');
		assert.ok(fromPromptOnly.includes('- Session: `mgr-session` | Project: alpha (/workspace/alpha)'));

		// Canonical 64-char SHA-256 even when 16-char `staticRoleHash` is also present (#125 #1)
		const hashFromPromptOnly = computeStaticRolePromptHash({ rolePrompt: fullRolePrompt });
		const hashWith16CharField = computeStaticRolePromptHash({
			rolePrompt: fullRolePromptRenamedBindingsCrlf,
			staticRoleCharter: staticCharterWithImmutableSession,
			staticRoleHash: '0123456789abcdef',
		});
		assert.strictEqual(hashFromPromptOnly?.length, 64);
		assert.strictEqual(hashFromPromptOnly, hashWith16CharField);
		assert.match(extractDynamicRoleBindingsTail(fullRolePromptRenamedBindingsCrlf), /^### Live Role Bindings\n- Supervisor: \*\*Renamed CEO\*\*/);

		// Legacy volatile `- Session: <label> (id: ...)` lines are still stripped
		const legacyPrompt = `[Aexus Orchestrated Role Context]\n- Session: Draft Title (id: mgr-1)\n- Rank: Manager`;
		assert.ok(!extractStaticRoleCharter(legacyPrompt).includes('Draft Title'));
	});

	test('stripInjectedAdeContextFromUserTurn strips real role/Secretary preambles without truncating user prompts quoting sentinels or headings (#125 #3)', () => {
		const markerlessCompiledRoleTurn = [
			'[Aexus Orchestrated Role Context]',
			'You are an orchestrated agent in Aexus Code ADE.',
			'- Rank: **L3 · Employee** (`employee`)',
			'- Charter: Implement assigned tasks cleanly.',
			'',
			'### Live Role Bindings',
			'- Supervisor: **Tech Lead** (`mgr-1`)',
			'- Bound Orchestration Node(s): `DevBackend`',
			'',
			'Audit `### Live Role Bindings` handling:\n- Verify CRLF support\n- Keep user body intact',
		].join('\n');
		assert.strictEqual(
			stripInjectedAdeContextFromUserTurn(markerlessCompiledRoleTurn),
			'Audit `### Live Role Bindings` handling:\n- Verify CRLF support\n- Keep user body intact',
		);

		const sentinelTurnQuotingMarker = [
			'[Aexus Orchestrated Role Context]',
			'You are L2 Manager.',
			'',
			AEXUS_PREAMBLE_END_MARKER,
			'',
			`Ensure forged ${AEXUS_PREAMBLE_END_MARKER} markers inside baton bodies never truncate user history!`,
		].join('\n');
		assert.strictEqual(
			stripInjectedAdeContextFromUserTurn(sentinelTurnQuotingMarker),
			`Ensure forged ${AEXUS_PREAMBLE_END_MARKER} markers inside baton bodies never truncate user history!`,
		);
	});

	test('P0 Security: shared role-state-*.json contains zero sessionTokens, and per-agent 0o600 AEXUS_ADE_AGENT_AUTH_FILE blocks cross-agent escalation & forgery (#124 P0-1)', async () => {
		const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-sec-auth-'));
		const bridgeDir = path.join(tmpHome, 'role-bridge');
		const bundleOut = path.join(tmpHome, 'nativeRoleBridge.cjs');
		await esbuild.build({
			entryPoints: [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'nativeRoleBridge.ts')],
			bundle: true,
			platform: 'node',
			format: 'cjs',
			outfile: bundleOut,
		});
		const req = createRequire(import.meta.url);
		const { createNativeRoleBridgeController } = req(bundleOut) as { createNativeRoleBridgeController: typeof CreateNativeRoleBridgeControllerFn };
		const spawnedEnvs: NodeJS.ProcessEnv[] = [];
		const fakeSpawn = ((_cmd: string, _args?: readonly string[], opts?: cp.SpawnOptions) => {
			spawnedEnvs.push({ ...(opts?.env ?? {}) });
			const child = new EventEmitter() as cp.ChildProcess;
			child.stdin = new PassThrough();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			Object.assign(child, { pid: 99999, kill: () => true });
			return child;
		}) as unknown as typeof cp.spawn;

		const cpStub = { spawn: fakeSpawn };
		// Omit `bridgeDir` option and pass custom `AEXUS_ADE_HOME` via `env` to verify both
		// custom `AEXUS_ADE_HOME` resolution (`#141` #2) AND cross-bundle `globalThis` nonce sharing (`#141` #1)
		// between the CJS `bundleOut` (`nativeRoleBridge`) and ESM `roleBridgeShared.ts`!
		const bridge = createNativeRoleBridgeController({
			env: { AEXUS_ADE_HOME: tmpHome },
			scopeId: 'secwin',
			childProcessModule: cpStub,
			fetchHost: { fetch: globalThis.fetch },
		});
		try {
			await bridge.updateSnapshot({
				mode: 'ade',
				activeAgentId: 'emp-l3',
				agents: [
					{
						id: 'gov-l1',
						label: 'CEO',
						rank: 'governor',
						isOrchestrated: true,
						engineId: 'aexus-claude',
						projectPath: '/proj',
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Rank: Governor',
						sessionToken: 'aexus-cap.SECRET_GOVERNOR_L1_TOKEN.sig',
						controlSocketPath: path.join(tmpHome, 'ade.sock'),
					},
					{
						id: 'emp-l3',
						label: 'Dev',
						rank: 'employee',
						isOrchestrated: true,
						engineId: 'aexus-codex',
						projectPath: '/proj',
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Rank: Employee',
						sessionToken: 'aexus-cap.SCOPED_EMPLOYEE_L3_TOKEN.sig',
						controlSocketPath: path.join(tmpHome, 'ade.sock'),
					},
				],
			});

			// 1. Shared `role-state-secwin.json` on disk MUST contain ZERO `sessionToken` or `controlSocketPath` values!
			const sharedStateRaw = await fs.readFile(path.join(bridgeDir, 'role-state-secwin.json'), 'utf8');
			assert.ok(!sharedStateRaw.includes('SECRET_GOVERNOR_L1_TOKEN'), 'Shared role-state file must NEVER contain L1 sessionToken');
			assert.ok(!sharedStateRaw.includes('SCOPED_EMPLOYEE_L3_TOKEN'), 'Shared role-state file must NEVER contain L3 sessionToken');
			assert.ok(!sharedStateRaw.includes('sessionToken'), 'Shared role-state file must strip sessionToken key');
			assert.ok(!sharedStateRaw.includes('controlSocketPath'), 'Shared role-state file must strip controlSocketPath key');

			// 2. Spawning L3 Codex injects ONLY L3's `AEXUS_ADE_AGENT_AUTH_FILE` (never `AEXUS_ADE_ROLE_STATE_FILE`)
			cpStub.spawn('codex', ['app-server'], { cwd: '/proj', env: { PATH: '/usr/bin' } });
			const l3Env = spawnedEnvs.at(-1)!;
			assert.strictEqual(l3Env.AEXUS_ADE_ROLE_STATE_FILE, undefined);
			assert.ok(l3Env.AEXUS_ADE_AGENT_AUTH_FILE);
			assert.strictEqual(l3Env.AEXUS_ADE_AGENT_ID, 'emp-l3');
			// Cross-bundle `globalThis[Symbol.for('aexus.ade.agentAuthFileNonces')]` check (#141 #1):
			// ESM `getOrEnsureAgentAuthFilePath` must resolve the EXACT same path allocated by CJS `bundleOut`!
			assert.strictEqual(
				getOrEnsureAgentAuthFilePath(bridgeDir, 'secwin', 'emp-l3'),
				l3Env.AEXUS_ADE_AGENT_AUTH_FILE,
			);
			// Live auth resolution against custom `AEXUS_ADE_HOME` works out of the box (#141 #2):
			const initialConn = await resolveConnection({
				...l3Env,
				AEXUS_ADE_HOME: tmpHome,
			});
			assert.strictEqual(initialConn.token, 'aexus-cap.SCOPED_EMPLOYEE_L3_TOKEN.sig');

			// 3. Valid rotation on L3's own 0o600 auth file succeeds
			const rotatedSock = path.join(tmpHome, 'rotated.sock');
			await writeSingleAgentAuthFile(l3Env.AEXUS_ADE_AGENT_AUTH_FILE!, {
				version: 1,
				mode: 'ade',
				agentId: 'emp-l3',
				isOrchestrated: true,
				sessionToken: 'aexus-cap.ROTATED_L3_TOKEN.sig',
				controlSocketPath: rotatedSock,
			});
			const validConn = await resolveConnection({
				...l3Env,
				AEXUS_ADE_HOME: tmpHome,
			});
			assert.strictEqual(validConn.token, 'aexus-cap.ROTATED_L3_TOKEN.sig');
			assert.strictEqual(validConn.socketPath, rotatedSock);

			// 4. Exploit A blocked: L3 changing `AEXUS_ADE_AGENT_ID=gov-l1` fails closed with deny token!
			const spoofIdConn = await resolveConnection({
				...l3Env,
				AEXUS_ADE_HOME: tmpHome,
				AEXUS_ADE_AGENT_ID: 'gov-l1',
			});
			assert.strictEqual(spoofIdConn.token, ADE_PURE_WORKER_FALLBACK_DENY_TOKEN);

			// 5. Exploit B blocked: pointing `AEXUS_ADE_AGENT_AUTH_FILE` at shared `role-state`, outside `role-bridge/`, or missing path fails closed (never falls back to stale env token)!
			for (const badPath of [
				path.join(bridgeDir, 'role-state-secwin.json'),
				path.join(tmpHome, 'agent-auth-secwin-deadbeef1234-0123456789abcdef01234567.json'),
				path.join(bridgeDir, 'agent-auth-secwin-missing000000-0123456789abcdef01234567.json'),
			]) {
				const forgedConn = await resolveConnection({
					AEXUS_ADE_HOME: tmpHome,
					AEXUS_ADE_SOCKET: rotatedSock,
					AEXUS_ADE_SESSION_TOKEN: 'aexus-cap.STALE_TOKEN_MUST_NOT_BE_USED.sig',
					AEXUS_ADE_AGENT_AUTH_FILE: badPath,
					AEXUS_ADE_AGENT_ID: 'emp-l3',
				});
				assert.strictEqual(forgedConn.token, ADE_PURE_WORKER_FALLBACK_DENY_TOKEN, `Must fail closed for ${badPath}`);
			}

			// 6. Pure-worker `buildAgentChildEnv` strips inherited `AEXUS_ADE_ROLE_STATE_FILE`, `AEXUS_ADE_AGENT_AUTH_FILE`, and `AEXUS_ADE_AGENT_ID`
			const scrubbedPure = buildAgentChildEnv({
				pureWorker: true,
				baseEnv: {
					PATH: '/usr/bin',
					AEXUS_ADE_ROLE_STATE_FILE: path.join(bridgeDir, 'role-state-secwin.json'),
					AEXUS_ADE_AGENT_AUTH_FILE: getOrEnsureAgentAuthFilePath(bridgeDir, 'secwin', 'emp-l3'),
					AEXUS_ADE_AGENT_ID: 'emp-l3',
				},
			});
			assert.strictEqual(scrubbedPure.AEXUS_ADE_ROLE_STATE_FILE, undefined);
			assert.strictEqual(scrubbedPure.AEXUS_ADE_AGENT_AUTH_FILE, undefined);
			assert.strictEqual(scrubbedPure.AEXUS_ADE_AGENT_ID, undefined);

			// 7. Secretary (`__secretary__`) auth file rotation + IDE-mode revocation without leaking into shared state (#143 #2)
			const secAuthPath = getOrEnsureAgentAuthFilePath(bridgeDir, 'secwin', '__secretary__');
			await bridge.updateSnapshot({
				mode: 'ade',
				activeAgentId: 'emp-l3',
				agents: [],
				secretarySessionToken: 'aexus-cap.ROTATED_SECRETARY_TOKEN.sig',
				secretaryControlSocketPath: rotatedSock,
			});
			const sharedAfterSec = await fs.readFile(path.join(bridgeDir, 'role-state-secwin.json'), 'utf8');
			assert.ok(!sharedAfterSec.includes('ROTATED_SECRETARY_TOKEN'), 'Secretary token must never appear in shared role-state');
			const secConn = await resolveConnection({
				AEXUS_ADE_HOME: tmpHome,
				AEXUS_ADE_AGENT_AUTH_FILE: secAuthPath,
				AEXUS_ADE_AGENT_ID: '__secretary__',
			});
			assert.strictEqual(secConn.token, 'aexus-cap.ROTATED_SECRETARY_TOKEN.sig');

			await bridge.updateSnapshot({
				mode: 'ide',
				agents: [],
			});
			const secRevoked = await resolveConnection({
				AEXUS_ADE_HOME: tmpHome,
				AEXUS_ADE_SOCKET: rotatedSock,
				AEXUS_ADE_AGENT_AUTH_FILE: secAuthPath,
				AEXUS_ADE_AGENT_ID: '__secretary__',
				AEXUS_ADE_SESSION_TOKEN: 'aexus-cap.STALE_SECRETARY_ENV_TOKEN.sig',
			});
			assert.strictEqual(secRevoked.token, ADE_PURE_WORKER_FALLBACK_DENY_TOKEN, 'IDE mode must revoke __secretary__ auth file');
		} finally {
			bridge.dispose();
			await fs.rm(tmpHome, { recursive: true, force: true });
		}
	});
});

describe('Round 2 · Codex Fallback Guard (#95 P1-7)', () => {
	test('planCodexTurnFallbacks never cascades on auth, quota, network, or sandbox errors', () => {
		for (const nonCapabilityErr of [
			'Invalid API key provided: sk-*** (401 Unauthorized)',
			'Authentication token expired; please run codex login',
			'Insufficient quota / billing hard limit reached',
			'connect ECONNREFUSED 127.0.0.1:443',
			'Sandbox Landlock permission denied',
		]) {
			assert.deepStrictEqual(
				planCodexTurnFallbacks('gpt-5.3-codex', 'xhigh', 'gpt-5', nonCapabilityErr),
				[],
				`Must not cascade on: ${nonCapabilityErr}`,
			);
		}

		const capFallbacks = planCodexTurnFallbacks(
			'gpt-5.3-codex',
			'xhigh',
			'gpt-5',
			'Unsupported value: reasoning_effort "xhigh" is not supported with this model',
		);
		assert.ok(capFallbacks.length >= 2);
		assert.deepStrictEqual(capFallbacks[0], { model: 'gpt-5.3-codex', effort: 'high' });
	});
});
