/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { RANK_SUBCOMMANDS } from './adeCliRankMission.mjs';

const execFileAsync = promisify(execFile);

export const ADE_CONTROL_DIR_NAME = '.aexus-code';
export const ADE_CONTROL_META_NAME = 'ade-control.json';
export const ADE_CLI_VERSION = '1.1.0';
export const ADE_CLI_SCHEMA_VERSION = 1;
export const ADE_ENGINE_BASELINE = '1.146.0';

const ADE_PURE_WORKER_FALLBACK_DENY_TOKEN = 'aexus-cap.eyJzaWQiOiJwdXJlLXdvcmtlciIsInJhbmsiOiJ3b3JrZXIiLCJwdXJlIjp0cnVlLCJpYXQiOjB9.0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Read-only / idempotent control actions that can safely retry once when the server closes the
 * socket before writing a response byte (e.g. transient bridge reset or socket contention).
 * Note: full `token.read` mutates `nodeReadCursors` (#95 P1-6), so only sliced/TOC `token.read`
 * is pure-read here; full `token.read` receives an automatic `idempotencyKey` instead (C1).
 */
const IDEMPOTENT_READ_ACTIONS = new Set([
	'status',
	'whoami',
	'docs.read',
	'api.update',
	'mode.get',
	'view.get',
	'rank.list',
	'rank.names',
	'rank.get',
	'rank.docs',
	'role.schema.get',
	'role.apis',
	'role.presets',
	'project.list',
	'project.changes',
	'project.files',
	'host.list',
	'host.get',
	'host.browse',
	'engine.list',
	'engine.sessions',
	'session.list',
	'session.info',
	'session.subordinates',
	'session.tree',
	'session.history',
	'secretary.status',
	'secretary.history',
	'mission.docs',
	'mission.list',
	'mission.get',
	'mission.export',
	'mission.status',
	'mission.diagnostics',
	'mission.checkpoint.list',
	'mission.checkpoint.diff',
	'mission.blueprint.get',
	'mission.blueprint.validate',
	'mission.boundary.get',
	'mission.trigger.list',
	'mission.prompt.list',
	'mission.prompt.get',
	'mission.check.list',
	'mission.check.get',
	'mission.task.list',
	'mission.task.get',
	'orchestration.get',
	'orchestration.export',
	'orchestration.status',
	'orchestration.diagnostics',
	'orchestration.validate',
	'orchestration.group.list',
	'orchestration.checkpoint.list',
	'orchestration.checkpoint.diff',
	'whiteboard.list',
	'whiteboard.read',
	'token.current',
	'token.history',
	'token.trace',
	'org.subordinates',
	'org.context',
	'inbox.list',
]);

export function isIdempotentReadRequest(action, params) {
	if (!action) {
		return false;
	}
	if (IDEMPOTENT_READ_ACTIONS.has(action)) {
		return true;
	}
	if (
		action === 'token.read'
		&& params
		&& Boolean(
			params.toc
			|| params.summaryOnly
			|| params.summary === true
			|| params.section
			|| params.heading
			|| params.maxChars !== undefined
			|| params.max_chars !== undefined
			|| params.offset !== undefined
			|| params.tailChars !== undefined
			|| params.tail !== undefined
			|| params.tail_chars !== undefined,
		)
	) {
		return true;
	}
	if (action === 'orchestration.limits' && (!params || Object.keys(params).every(k => k === 'missionId' || k === 'caller'))) {
		return true;
	}
	return false;
}

export function normalizeExplicitSocketPath(raw) {
	if (!raw) {
		return undefined;
	}
	if (process.platform === 'win32' || raw.startsWith('tcp://') || Buffer.byteLength(raw, 'utf8') <= 90) {
		return raw;
	}
	const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
	const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);
	return path.join('/tmp', `aexus-ade-${uid}`, `c-${hash}.sock`);
}

const AGENT_AUTH_BASENAME_RE = /^agent-auth-[A-Za-z0-9._-]+-[0-9a-f]{8,}-[0-9a-f]{16,}\.json$/;

async function readLiveAgentAuthFile(env) {
	if (!Object.prototype.hasOwnProperty.call(env, 'AEXUS_ADE_AGENT_AUTH_FILE') || env.AEXUS_ADE_AGENT_AUTH_FILE === undefined) {
		return undefined;
	}
	const denyClosed = () => ({ sessionToken: ADE_PURE_WORKER_FALLBACK_DENY_TOKEN, failClosed: true });
	const authFileRaw = String(env.AEXUS_ADE_AGENT_AUTH_FILE).trim();
	if (!authFileRaw) {
		return denyClosed();
	}
	try {
		const adeHome = env.AEXUS_ADE_HOME?.trim() || path.join(os.homedir(), ADE_CONTROL_DIR_NAME);
		const trustedBridgeDir = await fs.realpath(path.join(adeHome, 'role-bridge'));
		const resolvedFile = path.resolve(authFileRaw);
		if (!AGENT_AUTH_BASENAME_RE.test(path.basename(resolvedFile))) {
			return denyClosed();
		}
		const st = await fs.lstat(resolvedFile);
		if (!st.isFile() || st.isSymbolicLink()) {
			return denyClosed();
		}
		if (process.platform !== 'win32') {
			if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
				return denyClosed();
			}
			if ((st.mode & 0o077) !== 0) {
				return denyClosed();
			}
		}
		const realParent = await fs.realpath(path.dirname(resolvedFile));
		if (realParent !== trustedBridgeDir) {
			return denyClosed();
		}
		const parsed = JSON.parse(await fs.readFile(resolvedFile, 'utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.prototype.hasOwnProperty.call(parsed, 'agents')) {
			return denyClosed();
		}
		const fileAgentId = typeof parsed.agentId === 'string' ? parsed.agentId.trim() : '';
		const expectedAgentId = env.AEXUS_ADE_AGENT_ID?.trim();
		if (!fileAgentId || (expectedAgentId && fileAgentId !== expectedAgentId)) {
			return denyClosed();
		}
		if (parsed.mode !== 'ade' || (!parsed.isOrchestrated && !parsed.isMissionNode)) {
			return denyClosed();
		}
		if (typeof parsed.sessionToken === 'string' && parsed.sessionToken.trim()) {
			const socketPath = typeof parsed.controlSocketPath === 'string' && parsed.controlSocketPath.trim()
				? normalizeExplicitSocketPath(parsed.controlSocketPath.trim())
				: undefined;
			return { sessionToken: parsed.sessionToken.trim(), socketPath };
		}
		return denyClosed();
	} catch {
		// Fail closed whenever AEXUS_ADE_AGENT_AUTH_FILE is set in env but missing, unreadable, or forged (#124 P0-1).
		return denyClosed();
	}
}

export async function readRemoteBridgeFileEndpoint(env) {
	const bridgeFile = env.AEXUS_ADE_REMOTE_BRIDGE_FILE?.trim();
	if (!bridgeFile) {
		return undefined;
	}
	try {
		const raw = await fs.readFile(bridgeFile, 'utf8');
		const parsed = JSON.parse(raw);
		if (typeof parsed.socketPath === 'string' && parsed.socketPath.trim()) {
			return normalizeExplicitSocketPath(parsed.socketPath.trim());
		}
		if (typeof parsed.tcpPort === 'number' && Number.isInteger(parsed.tcpPort) && parsed.tcpPort > 0 && parsed.tcpPort <= 65535) {
			return `tcp://127.0.0.1:${parsed.tcpPort}`;
		}
	} catch {
		// Bridge metadata file may be mid-update or unavailable; fall back to env vars cleanly.
	}
	return undefined;
}

export async function resolveConnection(env) {
	const tcpPortRaw = env.AEXUS_ADE_TCP_PORT?.trim();
	const tcpPort = tcpPortRaw && /^\d+$/.test(tcpPortRaw) ? Number.parseInt(tcpPortRaw, 10) : undefined;
	const tcpEndpoint = tcpPort && tcpPort > 0 && tcpPort <= 65535 ? `tcp://127.0.0.1:${tcpPort}` : undefined;
	const envSocketOverride = normalizeExplicitSocketPath(env.AEXUS_ADE_SOCKET?.trim()) || tcpEndpoint;
	const liveRoleAuth = await readLiveAgentAuthFile(env);
	const sessionToken = liveRoleAuth
		? liveRoleAuth.sessionToken
		: env.AEXUS_ADE_SESSION_TOKEN?.trim();
	if (sessionToken) {
		const dynamicBridgeEndpoint = await readRemoteBridgeFileEndpoint(env);
		const socketOverride = dynamicBridgeEndpoint || liveRoleAuth?.socketPath || envSocketOverride;
		if (socketOverride) {
			return { socketPath: socketOverride, token: sessionToken, usingSessionToken: true };
		}
		const adeHomeDir = env.AEXUS_ADE_HOME?.trim() || path.join(os.homedir(), ADE_CONTROL_DIR_NAME);
		const controlFile = env.AEXUS_ADE_CONTROL_FILE?.trim() || path.join(adeHomeDir, ADE_CONTROL_META_NAME);
		let meta;
		try {
			meta = JSON.parse(await fs.readFile(controlFile, 'utf8'));
		} catch (error) {
			const detail = error.code === 'ENOENT'
				? `Control metadata file not found at ${controlFile}. Is Aexus Code running? (Run "aexus-ade doctor" to diagnose.)`
				: `Could not read ${controlFile}: ${error.message}`;
			throw new Error(detail);
		}
		const socketPath = normalizeExplicitSocketPath(meta?.socketPath);
		if (!socketPath) {
			throw new Error(`No socketPath found in ${controlFile}.`);
		}
		return { socketPath, token: sessionToken, usingSessionToken: true };
	}
	const socketOverride = envSocketOverride;
	const tokenOverride = env.AEXUS_ADE_TOKEN?.trim();
	if (socketOverride && tokenOverride !== undefined) {
		return { socketPath: socketOverride, token: tokenOverride, usingSessionToken: false };
	}
	const adeHomeDir = env.AEXUS_ADE_HOME?.trim() || path.join(os.homedir(), ADE_CONTROL_DIR_NAME);
	const controlFile = env.AEXUS_ADE_CONTROL_FILE?.trim() || path.join(adeHomeDir, ADE_CONTROL_META_NAME);
	let meta;
	try {
		meta = JSON.parse(await fs.readFile(controlFile, 'utf8'));
	} catch (error) {
		if (!socketOverride) {
			const detail = error.code === 'ENOENT'
				? `Control metadata file not found at ${controlFile}. Is Aexus Code running? (Run "aexus-ade doctor" to diagnose.)`
				: `Could not read ${controlFile}: ${error.message}`;
			throw new Error(detail);
		}
	}
	const socketPath = socketOverride || normalizeExplicitSocketPath(meta?.socketPath);
	const token = tokenOverride ?? meta?.token ?? '';
	if (!socketPath) {
		throw new Error(`No socketPath found in ${controlFile}.`);
	}
	return { socketPath, token, usingSessionToken: false };
}

export function sendSocketRequest(socketPath, payload) {
	return new Promise((resolve, reject) => {
		const tcpMatch = /^tcp:\/\/(127\.0\.0\.1|localhost):(\d+)$/i.exec(socketPath);
		const socket = tcpMatch
			? net.createConnection({ host: tcpMatch[1], port: Number.parseInt(tcpMatch[2], 10) })
			: net.createConnection(socketPath);
		if (tcpMatch) {
			socket.setNoDelay(true);
		}
		let buffer = '';
		let settled = false;
		let requestSent = false;
		const isWait = Boolean(payload.params && payload.params.wait === true);
		const isCheckGatedAction = payload.action === 'token.complete'
			|| payload.action === 'token.return'
			|| payload.action === 'token.handoff'
			|| payload.action === 'mission.check.run'
			|| payload.action === 'mission.task.complete'
			|| payload.action === 'mission.task.status';
		const rawParamTimeoutMs = Number(payload.params && payload.params.timeoutMs);
		const waitTimeoutMs = Math.max(
			935_000,
			(Number.isFinite(rawParamTimeoutMs) && rawParamTimeoutMs > 0 ? Math.floor(rawParamTimeoutMs) : 900_000) + 35_000,
		);
		const timeoutMs = isWait ? waitTimeoutMs : (isCheckGatedAction ? 315_000 : 125_000);
		const timer = setTimeout(() => {
			finish(() => reject(new Error(`ADE control request (${payload.action}) timed out after ${timeoutMs}ms on ${socketPath}.`)));
		}, timeoutMs);
		const finish = fn => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			fn();
		};
		socket.setEncoding('utf8');
		socket.on('connect', () => {
			requestSent = true;
			socket.write(JSON.stringify(payload) + '\n');
		});
		socket.on('data', chunk => {
			buffer += chunk;
			const newline = buffer.indexOf('\n');
			if (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				finish(() => {
					try {
						resolve(JSON.parse(line));
					} catch (error) {
						reject(new Error(`Invalid JSON response from ADE socket: ${error.message}`));
					}
				});
			}
		});
		const handlePrematureClose = () => {
			if (!settled && buffer.trim()) {
				finish(() => {
					try {
						resolve(JSON.parse(buffer.trim()));
					} catch (error) {
						reject(new Error(`Invalid JSON response from ADE socket: ${error.message}`));
					}
				});
			} else if (!settled) {
				const emptyEofErr = new Error(
					`ADE control socket (${socketPath}) closed without sending a response for "${payload.action}".`,
				);
				emptyEofErr.emptySocketEof = true;
				finish(() => reject(emptyEofErr));
			}
		};
		socket.on('end', handlePrematureClose);
		socket.on('close', handlePrematureClose);
		socket.on('error', error => {
			const wrapped = new Error(
				`Could not connect to ADE control socket (${socketPath}): ${error.message}. Ensure Aexus Code is running or check AEXUS_ADE_SOCKET.`,
			);
			const code = error.code;
			if (
				!requestSent
				&& (!code || code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'EAGAIN' || code === 'ENOTSOCK' || code === 'ECONNRESET' || code === 'ETIMEDOUT')
			) {
				wrapped.retryableConnectError = true;
			} else if (requestSent && buffer.length === 0 && (code === 'ECONNRESET' || code === 'EPIPE')) {
				wrapped.emptySocketEof = true;
			}
			finish(() => reject(wrapped));
		});
	});
}

function isRetryableControlError(error, payload) {
	if (!error || typeof error !== 'object') {
		return false;
	}
	if (error.retryableConnectError) {
		return true;
	}
	// Retry post-write `emptySocketEof` ONLY for pure read-only actions OR mutating requests carrying a
	// deduplicating `idempotencyKey` (paired with `AdeIdempotencyLedger` in C1).
	if (error.emptySocketEof && (isIdempotentReadRequest(payload?.action, payload?.params) || Boolean(payload?.idempotencyKey))) {
		return true;
	}
	return false;
}

export async function sendControlRequestWithRetry(env, initialSocketPath, payload, allowBridgeRetry) {
	// Always allow brief jittered retries on pre-write socket contention / window reload, and longer
	// backoff retries when healing SSH reverse tunnels on Cloud Hosts. Never retry non-existent explicit
	// local socket files (`AEXUS_ADE_SOCKET` without bridge file) more than once when offline so `doctor`/tests stay fast.
	const hasExplicitOfflineTestSocket = Boolean(env.AEXUS_ADE_SOCKET?.trim() && !env.AEXUS_ADE_REMOTE_BRIDGE_FILE?.trim() && !allowBridgeRetry);
	const baseBackoffsMs = allowBridgeRetry
		? [300, 700, 1_400, 2_400, 3_800]
		: (hasExplicitOfflineTestSocket ? [60, 140] : [90, 220, 500, 1_000]);
	let currentSocketPath = initialSocketPath;
	let currentPayload = payload;
	let lastError;
	for (let attempt = 0; attempt <= baseBackoffsMs.length; attempt++) {
		try {
			return await sendSocketRequest(currentSocketPath, currentPayload);
		} catch (err) {
			lastError = err;
			if (attempt >= baseBackoffsMs.length || !isRetryableControlError(err, currentPayload)) {
				throw err;
			}
			const jitter = Math.floor(Math.random() * 45);
			await new Promise(resolve => setTimeout(resolve, baseBackoffsMs[attempt] + jitter));
			const refreshed = await resolveConnection(env).catch(() => undefined);
			if (refreshed?.socketPath) {
				currentSocketPath = refreshed.socketPath;
			}
			if (refreshed?.token && refreshed.token !== currentPayload.token) {
				currentPayload = { ...currentPayload, token: refreshed.token };
			}
		}
	}
	throw lastError;
}

export function formatRawBlueprintOutput(result) {
	if (typeof result === 'string') {
		return result.endsWith('\n') ? result : `${result}\n`;
	}
	if (result && typeof result === 'object') {
		for (const key of ['text', 'markdown', 'content', 'blueprint', 'orchestrationText']) {
			const value = result[key];
			if (typeof value === 'string') {
				return value.endsWith('\n') ? value : `${value}\n`;
			}
		}
	}
	return `${formatHumanOutput('mission.blueprint.get', result)}\n`;
}

export function formatHumanOutput(action, result) {
	if (result === undefined || result === null) {
		return 'OK';
	}
	if (typeof result !== 'object') {
		return String(result);
	}
	const record = result;

	if (action === 'mission.blueprint.validate' && typeof record.valid === 'boolean') {
		if (record.valid) {
			return 'Blueprint is valid.';
		}
		const errors = Array.isArray(record.errors)
			? record.errors.map(error => typeof error === 'string' ? error : JSON.stringify(error))
			: [];
		return errors.length > 0
			? `Blueprint is invalid:\n${errors.map(error => `- ${error}`).join('\n')}`
			: 'Blueprint is invalid.';
	}

	const detachedOrDeletedId = typeof record.detached === 'string'
		? record.detached
		: typeof record.deleted === 'string'
			? record.deleted
			: undefined;
	if (detachedOrDeletedId !== undefined && typeof record.count === 'number') {
		const verb = action === 'session.delete' ? 'Deleted' : 'Detached';
		const subordinates = record.count - 1;
		if (subordinates > 0) {
			return `${verb} session '${detachedOrDeletedId}' and removed ${subordinates} subordinate session${subordinates === 1 ? '' : 's'}.`;
		}
		return `${verb} session '${detachedOrDeletedId}'.`;
	}

	if (action === 'role.schema.get' && Array.isArray(record.ranks)) {
		const lines = ['Organization Role Schema:'];
		for (const rawRank of record.ranks) {
			const id = String(rawRank.id ?? '');
			const name = String(rawRank.name ?? id);
			const tier = rawRank.tier !== undefined ? `L${rawRank.tier}` : '';
			const pure = rawRank.pureExecution ? ' [pure: 0 APIs]' : '';
			const apiList = Array.isArray(rawRank.allowedApis)
				? rawRank.allowedApis
				: (Array.isArray(rawRank.apis) ? rawRank.apis : undefined);
			const apis = apiList ? ` (${apiList.length} APIs)` : '';
			lines.push(`  - ${id}${tier ? ` (${tier})` : ''}: ${name}${pure || apis}`);
		}
		return lines.join('\n');
	}

	if (action === 'role.presets' && Array.isArray(result)) {
		const lines = ['Available Organization Presets:'];
		for (const rawPreset of result) {
			const id = String(rawPreset.id ?? '');
			const name = String(rawPreset.name ?? id);
			const desc = typeof rawPreset.description === 'string' && rawPreset.description ? ` — ${rawPreset.description}` : '';
			lines.push(`  - ${id}: ${name}${desc}`);
		}
		return lines.join('\n');
	}

	const whoTarget = action === 'whoami' && record.caller && typeof record.caller === 'object' && !Array.isArray(record.caller)
		? record.caller
		: record;
	if (
		action === 'whoami'
		&& (
			typeof whoTarget.id === 'string'
			|| typeof whoTarget.agentId === 'string'
			|| typeof whoTarget.sessionId === 'string'
			|| typeof whoTarget.rankId === 'string'
			|| typeof whoTarget.rank === 'string'
		)
	) {
		const id = whoTarget.id ?? whoTarget.agentId ?? whoTarget.sessionId ?? 'unknown';
		const tier = typeof whoTarget.tierTag === 'string' && whoTarget.tierTag
			? whoTarget.tierTag
			: (whoTarget.tier !== undefined ? `L${whoTarget.tier}` : '');
		const rank = whoTarget.rankId ?? whoTarget.rank ?? 'worker';
		const label = whoTarget.label ? ` "${whoTarget.label}"` : '';
		const mission = whoTarget.missionId ? ` mission=${whoTarget.missionId}` : '';
		const node = Array.isArray(whoTarget.nodeIds) && whoTarget.nodeIds.length > 0
			? (whoTarget.nodeIds.length === 1 ? ` node=${whoTarget.nodeIds[0]}` : ` nodes=${whoTarget.nodeIds.join(',')}`)
			: (whoTarget.nodeId ? ` node=${whoTarget.nodeId}` : '');
		const dept = whoTarget.department ? ` dept=${whoTarget.department}` : '';
		const tokens = Array.isArray(whoTarget.currentTokenIds) && whoTarget.currentTokenIds.length > 0
			? ` tokens=${whoTarget.currentTokenIds.join(',')}`
			: '';
		return `[${tier ? `${tier} · ` : ''}${rank}]${label} id=${id}${mission}${node}${dept}${tokens}`;
	}

	if (action === 'token.current' && Array.isArray(record.tokens)) {
		if (record.tokens.length === 0) {
			return `No active tokens${record.missionId ? ` (mission=${record.missionId})` : ''}.`;
		}
		const lines = [`Active tokens (${record.tokens.length})${record.missionId ? ` [mission=${record.missionId}]` : ''}:`];
		for (const tok of record.tokens) {
			const tid = tok.id ?? tok.tokenId ?? '?';
			const status = tok.status ?? 'active';
			const holder = tok.holderNodeId ?? tok.nodeId ?? '';
			const task = tok.taskNodeId ? ` task=${tok.taskNodeId}` : '';
			const rawSummary = tok.lastSummary ?? tok.summary;
			const summary = typeof rawSummary === 'string' && rawSummary ? ` — ${rawSummary}` : '';
			lines.push(`  - ${tid} [${status}]${holder ? ` @${holder}` : ''}${task}${summary}`);
		}
		return lines.join('\n');
	}

	if (
		typeof action === 'string'
		&& /^token\.(complete|handoff|return|mint|split|block|fail|reject|retry)$/.test(action)
		&& (
			record.tokenId || record.id
			|| Array.isArray(record.childTokenIds) || Array.isArray(record.mintedTokenIds)
			|| Array.isArray(record.nextTokenIds) || Array.isArray(record.reworkTokenIds)
			|| typeof record.returnedTokenId === 'string'
		)
	) {
		const tid = record.tokenId ?? record.id ?? record.parentTokenId ?? '';
		const status = record.status ? ` [${record.status}]` : '';
		const children = Array.isArray(record.childTokenIds)
			? record.childTokenIds
			: Array.isArray(record.mintedTokenIds)
				? record.mintedTokenIds
				: Array.isArray(record.nextTokenIds)
					? record.nextTokenIds
					: Array.isArray(record.reworkTokenIds)
						? record.reworkTokenIds
						: (typeof record.returnedTokenId === 'string' && record.returnedTokenId ? [record.returnedTokenId] : undefined);
		const targetArr = Array.isArray(record.toNodeIds)
			? record.toNodeIds
			: Array.isArray(record.handedOffTo)
				? record.handedOffTo
				: Array.isArray(record.rejectedToNodeIds)
					? record.rejectedToNodeIds
					: undefined;
		const singleTarget = typeof record.toNodeId === 'string'
			? record.toNodeId
			: (typeof record.returnedToNodeId === 'string' ? record.returnedToNodeId : undefined);
		const targets = targetArr?.length
			? ` -> ${targetArr.join(',')}`
			: (singleTarget ? ` -> ${singleTarget}` : '');
		const childPart = children?.length ? ` next=[${children.join(',')}]` : '';
		const warnings = Array.isArray(record.scopeOverlapWarnings) && record.scopeOverlapWarnings.length > 0
			? ` warnings=${record.scopeOverlapWarnings.length}`
			: (Array.isArray(record.fileConflicts) && record.fileConflicts.length > 0 ? ` conflicts=${record.fileConflicts.length}` : '');
		return `OK ${action}${tid ? ` ${tid}` : ''}${status}${targets}${childPart}${warnings}`;
	}

	if (action === 'mission.export' && record.format === 'markdown' && typeof record.content === 'string') {
		return record.content;
	}

	if (
		(action === 'mission.diagnostics' || action === 'orchestration.diagnostics')
		&& (
			typeof (record.grade ?? record.healthGrade) === 'string'
			|| Array.isArray(record.readyTaskIds)
			|| Array.isArray(record.recommendedActions)
			|| Array.isArray(record.recommendations)
		)
	) {
		const mid = record.missionId ?? 'current';
		const rawGrade = record.grade ?? record.healthGrade;
		const grade = rawGrade ? ` grade=${rawGrade}` : '';
		const ready = Array.isArray(record.readyTaskIds) ? ` ready=${record.readyTaskIds.length}` : '';
		const blocked = Array.isArray(record.blockedTasks) ? ` blocked=${record.blockedTasks.length}` : '';
		const stalled = Array.isArray(record.stalledTokens) ? ` stalled=${record.stalledTokens.length}` : '';
		const lines = [`Mission Diagnostics (${mid}):${grade}${ready}${blocked}${stalled}`];
		const cpNodes = Array.isArray(record.criticalPath)
			? record.criticalPath
			: (record.criticalPath && Array.isArray(record.criticalPath.nodeIds) ? record.criticalPath.nodeIds : undefined);
		if (cpNodes && cpNodes.length > 0) {
			lines.push(`  Critical path: ${cpNodes.join(' -> ')}`);
		}
		const recs = Array.isArray(record.recommendedActions)
			? record.recommendedActions
			: (Array.isArray(record.recommendations) ? record.recommendations : undefined);
		if (recs) {
			for (const act of recs.slice(0, 5)) {
				lines.push(`  - ${typeof act === 'string' ? act : JSON.stringify(act)}`);
			}
		}
		return lines.join('\n');
	}

	if ((action === 'mission.checkpoint.list' || action === 'orchestration.checkpoint.list') && (Array.isArray(result) || Array.isArray(record.checkpoints))) {
		const items = Array.isArray(result) ? result : record.checkpoints;
		if (items.length === 0) {
			return 'No checkpoints.';
		}
		const lines = [`Checkpoints (${items.length}):`];
		for (const cp of items) {
			const cid = cp.checkpointId ?? cp.id ?? '?';
			const label = cp.label ? ` "${cp.label}"` : '';
			const rev = cp.stateRevision !== undefined ? ` rev=${cp.stateRevision}` : '';
			lines.push(`  - ${cid}${label}${rev}`);
		}
		return lines.join('\n');
	}

	if (
		(action === 'mission.checkpoint.diff' || action === 'orchestration.checkpoint.diff')
		&& (record.diff || record.fromCheckpointId || record.fromId)
	) {
		const d = (record.diff && typeof record.diff === 'object') ? record.diff : record;
		const fromId = record.fromCheckpointId ?? d.fromId ?? record.checkpointId ?? '?';
		const toId = record.toCheckpointId ?? d.toId ?? 'live';
		const fromRev = d.fromStateRevision ?? d.fromRevision ?? record.fromStateRevision;
		const toRev = d.toStateRevision ?? d.toRevision ?? record.toStateRevision;
		const revDelta = fromRev !== undefined && toRev !== undefined ? ` rev=${fromRev}->${toRev}` : '';
		const tokCount = Array.isArray(d.tokenChanges)
			? d.tokenChanges.length
			: (Array.isArray(d.addedTokenIds) || Array.isArray(d.removedTokenIds) || Array.isArray(d.statusChangedTokens))
				? (Array.isArray(d.addedTokenIds) ? d.addedTokenIds.length : 0)
					+ (Array.isArray(d.removedTokenIds) ? d.removedTokenIds.length : 0)
					+ (Array.isArray(d.statusChangedTokens) ? d.statusChangedTokens.length : 0)
				: undefined;
		const tokChanges = tokCount !== undefined ? ` tokenChanges=${tokCount}` : '';
		const taskChanges = Array.isArray(d.taskStatusChanges) ? ` taskChanges=${d.taskStatusChanges.length}` : '';
		const wbArr = Array.isArray(d.whiteboardVersionChanges) ? d.whiteboardVersionChanges : (Array.isArray(d.whiteboardChanges) ? d.whiteboardChanges : undefined);
		const wbChanges = wbArr !== undefined ? ` wbChanges=${wbArr.length}` : '';
		const barrierChanges = Array.isArray(d.barrierChanges) ? ` barrierChanges=${d.barrierChanges.length}` : '';
		return `Checkpoint Diff (${fromId} -> ${toId}):${revDelta}${tokChanges}${taskChanges}${wbChanges}${barrierChanges}`;
	}

	if (
		(action === 'mission.checkpoint.create' || action === 'orchestration.checkpoint.create' || action === 'mission.checkpoint.restore' || action === 'orchestration.checkpoint.restore')
		&& (record.checkpointId || record.id || record.checkpoint || record.preRestoreCheckpointId || (record.diff && typeof record.diff === 'object'))
	) {
		const cpObj = (record.checkpoint && typeof record.checkpoint === 'object') ? record.checkpoint : record;
		const diffObj = (record.diff && typeof record.diff === 'object') ? record.diff : undefined;
		const cid = cpObj.checkpointId ?? cpObj.id ?? record.checkpointId ?? record.id ?? diffObj?.fromId ?? '';
		const label = cpObj.label ? ` "${cpObj.label}"` : '';
		const backup = record.preRestoreCheckpointId ? ` backup=${record.preRestoreCheckpointId}` : '';
		return `OK ${action}${cid ? ` ${cid}` : ''}${label}${backup}`;
	}

	if (action === 'mission.task.list' && Array.isArray(record.tasks)) {
		if (record.tasks.length === 0) {
			return 'No Mission tasks.';
		}
		const lines = [`Mission Tasks (${record.tasks.length}):`];
		for (const t of record.tasks) {
			const id = t.id ?? t.nodeId ?? '?';
			const status = t.status ?? 'pending';
			const title = t.title ?? t.label ?? id;
			const assignee = t.assigneeNodeId ? ` assignee=${t.assigneeNodeId}` : (t.ownerNodeId ? ` owner=${t.ownerNodeId}` : '');
			lines.push(`  - [${status}] ${id}: ${title}${assignee}`);
		}
		return lines.join('\n');
	}

	if (action === 'mission.status' && (record.missionId || record.id) && typeof record.status === 'string') {
		const mid = record.missionId ?? record.id;
		const title = record.title ? ` "${record.title}"` : '';
		const activeTokens = typeof record.activeTokenCount === 'number' ? ` activeTokens=${record.activeTokenCount}` : '';
		const completed = typeof record.completedTaskCount === 'number' && typeof record.totalTaskCount === 'number'
			? ` tasks=${record.completedTaskCount}/${record.totalTaskCount}`
			: '';
		return `Mission ${mid}${title}: status=${record.status}${completed}${activeTokens}`;
	}

	if (action === 'orchestration.status' && (record.missionId || record.state || record.status)) {
		const mid = record.missionId ?? 'current';
		const state = record.state ?? record.status ?? 'idle';
		const staffCount = Array.isArray(record.staff) ? record.staff.length : record.staffCount;
		const activeCount = Array.isArray(record.activeTokens) ? record.activeTokens.length : record.activeTokenCount;
		const hopVal = record.hopCount ?? record.activeHops ?? record.totalHops;
		const hops = hopVal !== undefined
			? ` hops=${hopVal}${record.maxHops ? `/${record.maxHops}` : ''}`
			: (record.maxHops !== undefined ? ` maxHops=${record.maxHops}` : '');
		return `Orchestration ${mid}: state=${state}${staffCount !== undefined ? ` staff=${staffCount}` : ''}${activeCount !== undefined ? ` activeTokens=${activeCount}` : ''}${hops}`;
	}

	if (action === 'whiteboard.list' && (Array.isArray(result) || Array.isArray(record.whiteboards))) {
		const items = Array.isArray(result) ? result : record.whiteboards;
		if (items.length === 0) {
			return 'No whiteboards.';
		}
		const lines = [`Whiteboards (${items.length}):`];
		for (const wb of items) {
			const wid = wb.whiteboardId ?? wb.id ?? '?';
			const ver = wb.version !== undefined ? ` v${wb.version}` : '';
			const dept = wb.department ? ` [${wb.department}]` : '';
			lines.push(`  - ${wid}${dept}${ver}: ${wb.title ?? wid}`);
		}
		return lines.join('\n');
	}

	const wbReadTarget = (record.whiteboard && typeof record.whiteboard === 'object' && !Array.isArray(record.whiteboard))
		? record.whiteboard
		: record;
	const wbSlice = (record.slice && typeof record.slice === 'object' && !Array.isArray(record.slice))
		? record.slice
		: wbReadTarget;
	if (
		action === 'whiteboard.read'
		&& Array.isArray(wbSlice.availableSections)
		&& !wbReadTarget.content
	) {
		const wid = wbReadTarget.whiteboardId ?? wbReadTarget.id ?? '';
		const header = `# ${wbReadTarget.title ?? (wid || 'Whiteboard')} (${wid}${wbReadTarget.department ? ` · ${wbReadTarget.department}` : ''}${wbReadTarget.version !== undefined ? ` · v${wbReadTarget.version}` : ''})`;
		const avail = wbSlice.availableSections.length > 0 ? wbSlice.availableSections.join(', ') : 'none';
		return `${header}\n(section not found; available sections: ${avail})`;
	}
	if (
		action === 'whiteboard.read'
		&& Array.isArray(wbSlice.headings)
		&& (wbReadTarget.toc === true || wbReadTarget.summaryOnly === true || (record.slice && !wbReadTarget.content))
	) {
		const wid = wbReadTarget.whiteboardId ?? wbReadTarget.id ?? '';
		const totalChars = wbSlice.totalChars ?? wbReadTarget.totalChars;
		const header = `# ${wbReadTarget.title ?? (wid || 'Whiteboard')} (${wid}${wbReadTarget.version !== undefined ? ` · v${wbReadTarget.version}` : ''}${totalChars !== undefined ? ` · ${totalChars} chars` : ''})`;
		if (wbSlice.headings.length === 0) {
			return `${header}\n(no markdown headings)`;
		}
		const lines = [header];
		for (const h of wbSlice.headings) {
			const lvl = h.level !== undefined ? `H${h.level}` : 'H';
			const ln = h.startLine !== undefined ? ` line=${h.startLine}` : '';
			const ch = (h.chars ?? h.charLength) !== undefined ? ` chars=${h.chars ?? h.charLength}` : '';
			lines.push(`  - [${lvl}] ${h.title ?? h.heading ?? ''}${ln}${ch}`);
		}
		return lines.join('\n');
	}
	if (action === 'whiteboard.read' && typeof wbReadTarget.content === 'string') {
		const wid = wbReadTarget.whiteboardId ?? wbReadTarget.id ?? '';
		const header = `# ${wbReadTarget.title ?? (wid || 'Whiteboard')} (${wid}${wbReadTarget.department ? ` · ${wbReadTarget.department}` : ''}${wbReadTarget.version !== undefined ? ` · v${wbReadTarget.version}` : ''})`;
		const isTocOutline = wbSlice.isPartialSlice === true
			&& Array.isArray(wbSlice.headings)
			&& wbSlice.matchedSection === undefined
			&& wbSlice.nextOffset === undefined
			&& /^\s*(?:-\s+#+|\(No Markdown headings)/.test(wbReadTarget.content);
		const isTruncated = !isTocOutline && (wbSlice.truncated === true || wbReadTarget.truncated === true);
		const sliceOffset = wbSlice.offset ?? wbReadTarget.offset ?? 0;
		const sliceNext = wbSlice.nextOffset ?? wbReadTarget.nextOffset;
		const sliceTotal = wbSlice.totalChars ?? wbReadTarget.totalChars;
		const sliceNote = isTruncated
			? `\n[truncated: offset=${sliceOffset}${sliceNext !== undefined ? ` nextOffset=${sliceNext}` : ''}${sliceTotal !== undefined ? ` totalChars=${sliceTotal}` : ''}]`
			: '';
		return wbReadTarget.content ? `${header}\n${wbReadTarget.content}${sliceNote}` : `${header}\n(empty)`;
	}

	if (
		action === 'org.subordinates'
		&& (
			Array.isArray(result)
			|| Array.isArray(record.subordinates)
			|| Array.isArray(record.directSubordinates)
			|| Array.isArray(record.orchestrationSubordinates)
			|| Array.isArray(record.missionJurisdictions)
		)
	) {
		const collected = [];
		const seenIds = new Set();
		const pushSub = s => {
			if (!s || typeof s !== 'object') {
				return;
			}
			const id = String(s.id ?? s.nodeId ?? s.sessionId ?? s.agentId ?? '?');
			if (seenIds.has(id)) {
				return;
			}
			seenIds.add(id);
			collected.push({ id, raw: s });
		};
		if (Array.isArray(result)) {
			for (const s of result) { pushSub(s); }
		} else {
			for (const arr of [record.subordinates, record.directSubordinates, record.orchestrationSubordinates]) {
				if (Array.isArray(arr)) {
					for (const s of arr) { pushSub(s); }
				}
			}
			if (Array.isArray(record.missionJurisdictions)) {
				for (const mj of record.missionJurisdictions) {
					if (mj && typeof mj === 'object') {
						for (const subArr of [mj.orchestrationSubordinates, mj.subordinates, mj.managedNodes]) {
							if (Array.isArray(subArr)) {
								for (const s of subArr) {
									pushSub(typeof s === 'string' ? { id: s, label: s } : s);
								}
							}
						}
					}
				}
			}
		}
		if (collected.length === 0) {
			return 'No managed subordinates.';
		}
		const lines = [`Subordinates (${collected.length}):`];
		for (const { id, raw: s } of collected) {
			const rank = s.rank ?? s.rankId ?? s.tierTag ?? (s.tier !== undefined ? `L${s.tier}` : 'staff');
			const status = s.status ? ` [${s.status}]` : '';
			const dept = s.department ? ` dept=${s.department}` : '';
			lines.push(`  - [${rank}] ${s.label ?? s.name ?? id} (${id})${dept}${status}`);
		}
		return lines.join('\n');
	}

	const historyEntries = (action === 'org.context' || action === 'session.history' || action === 'secretary.history')
		? (Array.isArray(result)
			? result
			: (Array.isArray(record.history)
				? record.history
				: (Array.isArray(record.messages) ? record.messages : undefined)))
		: undefined;
	if (historyEntries !== undefined) {
		if (historyEntries.length === 0) {
			return '(no messages)';
		}
		return historyEntries
			.map(m => `[${m.role ?? 'turn'}] ${String(m.text ?? m.content ?? '').trim()}`)
			.join('\n\n');
	}

	if (action === 'session.list' && Array.isArray(result)) {
		if (result.length === 0) {
			return 'No sessions.';
		}
		const lines = [`Sessions (${result.length}):`];
		for (const s of result) {
			const rank = s.rank ? `[${s.rank}] ` : '';
			const eng = s.engineName ?? s.engineId ?? 'draft';
			const st = s.status ? ` (${s.status})` : '';
			lines.push(`  - ${rank}${s.label ?? s.id} (${s.id}) — ${eng}${st}`);
		}
		return lines.join('\n');
	}

	return JSON.stringify(result);
}

export function computeDoctorExitCode(report, strict) {
	const hasFailure = report.checks.some(check => check.status === 'fail' || check.status === 'error');
	if (hasFailure) {
		return 1;
	}
	const hasWarning = report.checks.some(check => check.status === 'warn');
	if (strict && hasWarning) {
		return 2;
	}
	return 0;
}

const DOCTOR_ENGINES = [
	{ id: 'claude-code', label: 'Claude Code', binary: 'claude', installHint: 'npm i -g @anthropic-ai/claude-code' },
	{ id: 'codex', label: 'Codex', binary: 'codex', installHint: 'npm i -g @openai/codex' },
	{ id: 'antigravity', label: 'Google Antigravity', binary: 'agy', installHint: 'Install Antigravity CLI (agy)' },
	{ id: 'opencode', label: 'OpenCode', binary: 'opencode', installHint: 'npm i -g opencode-ai' },
	{ id: 'kilo', label: 'Kilo Code', binary: 'kilo', installHint: 'npm i -g @kilocode/cli' },
	{ id: 'dsh', label: 'DeepSeek Harness', binary: 'dsh', installHint: 'Install DeepSeek Harness (dsh)' },
	{ id: 'cline', label: 'Cline', binary: 'cline', installHint: 'npm i -g cline' },
	{ id: 'pi', label: 'Pi', binary: 'pi', installHint: 'npm i -g @mariozechner/pi-coding-agent' },
];

const PROJECT_RULE_CANDIDATES = [
	'AGENTS.md',
	'CLAUDE.md',
	'.cursorrules',
	'.cursor/rules',
	'.github/copilot-instructions.md',
	'.agents/skills',
	'AEXUS.md',
];

async function locateExecutable(binary, env) {
	const rawPath = env.PATH ?? env.Path ?? '';
	const pathDirs = rawPath.split(path.delimiter).map(s => s.trim()).filter(Boolean);
	if (process.platform !== 'win32') {
		for (const dir of pathDirs) {
			const candidate = path.join(dir, binary);
			try {
				const st = await fs.stat(candidate);
				if (st.isFile()) {
					await fs.access(candidate, fs.constants.X_OK);
					return candidate;
				}
			} catch {
				// Continue searching PATH entries.
			}
		}
		return undefined;
	}
	const locator = 'where';
	try {
		const { stdout } = await execFileAsync(locator, [binary], { env, timeout: 8000 });
		const firstLine = stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
		return firstLine || undefined;
	} catch {
		return undefined;
	}
}

async function probeCommandVersion(binary, args, env) {
	if (process.platform !== 'win32') {
		const resolved = await locateExecutable(binary, env);
		if (!resolved) {
			return undefined;
		}
		try {
			const { stdout, stderr } = await execFileAsync(resolved, [...args], { env, timeout: 8000 });
			const line = (stdout || stderr).split(/\r?\n/).map(s => s.trim()).find(Boolean);
			return line || undefined;
		} catch {
			return undefined;
		}
	}
	try {
		const { stdout, stderr } = await execFileAsync(binary, [...args], { env, timeout: 8000 });
		const line = (stdout || stderr).split(/\r?\n/).map(s => s.trim()).find(Boolean);
		return line || undefined;
	} catch {
		return undefined;
	}
}

export async function runDoctorDiagnostics(projectPath, env) {
	const [engines, gitVersion, sshVersion, controlPlane, detectedRules] = await Promise.all([
		Promise.all(DOCTOR_ENGINES.map(async e => {
			const resolved = await locateExecutable(e.binary, env);
			return {
				id: e.id,
				label: e.label,
				binary: e.binary,
				installed: Boolean(resolved),
				...(resolved ? { path: resolved } : {}),
				installHint: e.installHint,
			};
		})),
		probeCommandVersion('git', ['--version'], env),
		probeCommandVersion('ssh', ['-V'], env),
		(async () => {
			try {
				const conn = await resolveConnection(env);
				const res = await sendSocketRequest(conn.socketPath, { token: conn.token, action: 'status', params: {} });
				return { connected: Boolean(res.ok), socketPath: conn.socketPath, ...(res.ok ? {} : { error: res.error }) };
			} catch (err) {
				return { connected: false, error: err.message };
			}
		})(),
		Promise.all(PROJECT_RULE_CANDIDATES.map(async rel => {
			try {
				await fs.access(path.join(projectPath, rel));
				return rel;
			} catch {
				return undefined;
			}
		})),
	]);

	const projectRules = detectedRules.filter(Boolean);
	const enginesReady = engines.filter(e => e.installed).length;
	const checks = [
		{
			id: 'control-plane',
			label: 'ADE Control Plane',
			status: controlPlane.connected ? 'ok' : 'fail',
			detail: controlPlane.connected
				? (controlPlane.socketPath ?? 'connected')
				: (controlPlane.error || 'workbench not running'),
		},
		{
			id: 'engines',
			label: 'Coding Agent Engines',
			status: enginesReady > 0 ? 'ok' : 'fail',
			detail: `${enginesReady}/${engines.length} engines installed`,
		},
		{
			id: 'git',
			label: 'Git Worktree Tooling',
			status: gitVersion ? 'ok' : 'warn',
			detail: gitVersion ?? 'git not found (install git for worktree isolation)',
		},
		{
			id: 'ssh',
			label: 'OpenSSH Client',
			status: sshVersion ? 'ok' : 'warn',
			detail: sshVersion ?? 'ssh not found (install OpenSSH for aexus-ssh:// Cloud Hosts)',
		},
	];
	return {
		schemaVersion: ADE_CLI_SCHEMA_VERSION,
		aexusVersion: ADE_CLI_VERSION,
		platform: process.platform,
		arch: process.arch,
		nodeVersion: process.version,
		projectPath,
		controlPlane,
		tooling: {
			git: { installed: Boolean(gitVersion), ...(gitVersion ? { version: gitVersion } : {}), worktreeReady: Boolean(gitVersion) },
			ssh: { installed: Boolean(sshVersion), ...(sshVersion ? { version: sshVersion } : {}) },
		},
		projectRules,
		engines,
		checks,
		summary: { enginesReady, enginesTotal: engines.length },
	};
}

export function shouldUseColor(env, isTTY) {
	const noColor = env.NO_COLOR;
	if (noColor !== undefined && noColor !== '') {
		return false;
	}
	const forceColor = env.FORCE_COLOR;
	if (forceColor !== undefined) {
		return forceColor !== '0' && forceColor.toLowerCase() !== 'false';
	}
	return isTTY;
}

export function createColorizer(enabled) {
	const paint = (code, text) => enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
	return {
		bold: text => paint(1, text),
		dim: text => paint(2, text),
		red: text => paint(31, text),
		green: text => paint(32, text),
		yellow: text => paint(33, text),
		cyan: text => paint(36, text),
	};
}

export function formatDoctorHuman(report, color) {
	const lines = [];
	lines.push(color.bold(color.cyan('Aexus Code · ADE Environment Doctor')));
	lines.push(color.dim('==================================='));
	lines.push(`${color.bold('Aexus Version:')} ${report.aexusVersion} (Code - OSS ${ADE_ENGINE_BASELINE})`);
	lines.push(`${color.bold('Platform:')}      ${report.platform}/${report.arch} (Node ${report.nodeVersion})`);
	lines.push(`${color.bold('Project:')}       ${report.projectPath}`);
	lines.push(`${color.bold('Control Plane:')} ${report.controlPlane.connected ? color.green(`CONNECTED (${report.controlPlane.socketPath})`) : color.red(`OFFLINE (${report.controlPlane.error || 'workbench not running'})`)}`);
	lines.push(`${color.bold('Git Worktree:')}  ${report.tooling.git.installed ? color.green(`READY (${report.tooling.git.version})`) : color.yellow('MISSING (install git for worktree isolation)')}`);
	lines.push(`${color.bold('OpenSSH:')}       ${report.tooling.ssh.installed ? color.green(`READY (${report.tooling.ssh.version})`) : color.yellow('MISSING (install OpenSSH for aexus-ssh:// Cloud Hosts)')}`);
	lines.push(`${color.bold('Project Rules:')} ${report.projectRules.length > 0 ? report.projectRules.join(', ') : color.dim('(none detected — supports AGENTS.md, CLAUDE.md, .cursorrules)')}`);
	lines.push('');
	lines.push(color.bold(`Native Coding Engines (${report.summary.enginesReady}/${report.summary.enginesTotal} installed):`));
	for (const e of report.engines) {
		const mark = e.installed ? color.green('[OK]  ') : color.dim('[--]  ');
		const detail = e.installed ? (e.path ?? e.binary) : color.yellow(`not found (${e.installHint})`);
		lines.push(`  ${mark} ${e.label.padEnd(20)} ${e.binary.padEnd(10)} ${detail}`);
	}
	return lines.join('\n');
}

export const TOP_LEVEL_COMMANDS = [
	'doctor', 'completion', 'status', 'whoami', 'docs', 'api', 'mode', 'view', 'rank', 'role',
	'project', 'host', 'engine', 'session', 'secretary', 'mission', 'orchestration', 'whiteboard', 'token', 'org', 'inbox', 'version',
];

export const ROLE_SUBCOMMANDS = [
	'list', 'apis', 'presets', 'preset', 'apply-preset', 'set-tier', 'reset', 'studio',
];

export const MISSION_SUBCOMMANDS = [
	'docs', 'list', 'init', 'rename', 'export', 'import', 'open', 'blueprint', 'task', 'prompt', 'check', 'diagnostics', 'checkpoint', 'start', 'run', 'status', 'pause', 'resume', 'stop',
	'timeout', 'boundary', 'recall', 'retry', 'patch', 'gate', 'trigger', 'host', 'remove',
];

export const ORCHESTRATION_SUBCOMMANDS = [
	'get', 'validate', 'load', 'apply', 'export', 'import', 'layout', 'group', 'status', 'diagnostics', 'checkpoint', 'limits', 'pause', 'resume', 'abort', 'dispatch', 'staff', 'edge',
];

export const WHITEBOARD_SUBCOMMANDS = [
	'list', 'create', 'read', 'toc', 'write', 'append', 'rename', 'remove',
];

export const TOKEN_SUBCOMMANDS = [
	'current', 'read', 'history', 'trace', 'mint', 'split', 'return', 'handoff', 'complete', 'reject', 'block', 'fail', 'retry',
];

export const ORG_SUBCOMMANDS = [
	'subordinates', 'send', 'context', 'escalate',
];

export const SESSION_SUBCOMMANDS = [
	'list', 'info', 'subordinates', 'tree', 'create', 'configure', 'attach', 'connect', 'open', 'select', 'close',
	'mark-read', 'draft', 'rename', 'role', 'move', 'nest', 'reorder', 'send', 'history', 'stop', 'archive', 'unarchive', 'detach', 'delete',
];

const COMPLETION_SHELLS = ['bash', 'zsh', 'fish', 'powershell'];

function buildBashCompletion() {
	return [
		'# bash completion for aexus-ade',
		'_aexus_ade() {',
		'\tlocal cur',
		'\tcur="${COMP_WORDS[COMP_CWORD]}"',
		'',
		`\tlocal top_level="${TOP_LEVEL_COMMANDS.join(' ')}"`,
		`\tlocal rank_subcommands="${RANK_SUBCOMMANDS.join(' ')}"`,
		`\tlocal role_subcommands="${ROLE_SUBCOMMANDS.join(' ')}"`,
		`\tlocal mission_subcommands="${MISSION_SUBCOMMANDS.join(' ')}"`,
		`\tlocal orchestration_subcommands="${ORCHESTRATION_SUBCOMMANDS.join(' ')}"`,
		`\tlocal whiteboard_subcommands="${WHITEBOARD_SUBCOMMANDS.join(' ')}"`,
		`\tlocal token_subcommands="${TOKEN_SUBCOMMANDS.join(' ')}"`,
		`\tlocal org_subcommands="${ORG_SUBCOMMANDS.join(' ')}"`,
		`\tlocal session_subcommands="${SESSION_SUBCOMMANDS.join(' ')}"`,
		'',
		'\tcase "${COMP_WORDS[1]}" in',
		'\t\tcompletion)',
		`\t\t\tCOMPREPLY=( $(compgen -W "${COMPLETION_SHELLS.join(' ')}" -- "$cur") )`,
		'\t\t\treturn 0',
		'\t\t\t;;',
		'\t\trank|ranks)',
		'\t\t\tif [ "$COMP_CWORD" -eq 2 ]; then',
		'\t\t\t\tCOMPREPLY=( $(compgen -W "$rank_subcommands" -- "$cur") )',
		'\t\t\tfi',
		'\t\t\treturn 0',
		'\t\t\t;;',
		'\t\trole|roles)',
		'\t\t\tif [ "$COMP_CWORD" -eq 2 ]; then',
		'\t\t\t\tCOMPREPLY=( $(compgen -W "$role_subcommands" -- "$cur") )',
		'\t\t\tfi',
		'\t\t\treturn 0',
		'\t\t\t;;',
		'\t\torg)',
		'\t\t\tif [ "$COMP_CWORD" -eq 2 ]; then',
		'\t\t\t\tCOMPREPLY=( $(compgen -W "$org_subcommands" -- "$cur") )',
		'\t\t\tfi',
		'\t\t\treturn 0',
		'\t\t\t;;',
		'\t\ttoken|tokens)',
		'\t\t\tif [ "$COMP_CWORD" -eq 2 ]; then',
		'\t\t\t\tCOMPREPLY=( $(compgen -W "$token_subcommands" -- "$cur") )',
		'\t\t\tfi',
		'\t\t\treturn 0',
		'\t\t\t;;',
		'\t\tmission)',
		'\t\t\tif [ "$COMP_CWORD" -eq 2 ]; then',
		'\t\t\t\tCOMPREPLY=( $(compgen -W "$mission_subcommands" -- "$cur") )',
		'\t\t\tfi',
		'\t\t\treturn 0',
		'\t\t\t;;',
		'\t\torchestration|orch)',
		'\t\t\tif [ "$COMP_CWORD" -eq 2 ]; then',
		'\t\t\t\tCOMPREPLY=( $(compgen -W "$orchestration_subcommands" -- "$cur") )',
		'\t\t\tfi',
		'\t\t\treturn 0',
		'\t\t\t;;',
		'\t\twhiteboard|whiteboards|wb)',
		'\t\t\tif [ "$COMP_CWORD" -eq 2 ]; then',
		'\t\t\t\tCOMPREPLY=( $(compgen -W "$whiteboard_subcommands" -- "$cur") )',
		'\t\t\tfi',
		'\t\t\treturn 0',
		'\t\t\t;;',
		'\t\tsession)',
		'\t\t\tif [ "$COMP_CWORD" -eq 2 ]; then',
		'\t\t\t\tCOMPREPLY=( $(compgen -W "$session_subcommands" -- "$cur") )',
		'\t\t\tfi',
		'\t\t\treturn 0',
		'\t\t\t;;',
		'\tesac',
		'',
		'\tif [ "$COMP_CWORD" -eq 1 ]; then',
		'\t\tCOMPREPLY=( $(compgen -W "$top_level" -- "$cur") )',
		'\tfi',
		'\treturn 0',
		'}',
		'',
		'complete -F _aexus_ade aexus-ade',
		'',
	].join('\n');
}

function buildZshCompletion() {
	return [
		'#compdef aexus-ade',
		'',
		'_aexus_ade() {',
		'\tlocal -a top_level rank_subcommands role_subcommands mission_subcommands orchestration_subcommands whiteboard_subcommands token_subcommands org_subcommands session_subcommands',
		'\ttop_level=(',
		`\t\t'doctor:Diagnose the ADE environment'`,
		`\t\t'completion:Emit a shell completion script'`,
		`\t\t'status:Show workbench status'`,
		`\t\t'whoami:Inspect caller session identity and tier'`,
		`\t\t'docs:Read single-copy ADE API documentation'`,
		`\t\t'api:Query immutable API changelog diff'`,
		`\t\t'mode:Get or set ADE/IDE mode'`,
		`\t\t'view:Inspect or change the ADE view'`,
		`\t\t'rank:Inspect or hot-update rank tiers, aliases, and single-copy docs'`,
		`\t\t'role:Manage organization roles and presets'`,
		`\t\t'project:Manage projects'`,
		`\t\t'host:Manage Cloud Hosts'`,
		`\t\t'engine:List engines and sessions'`,
		`\t\t'session:Manage sessions'`,
		`\t\t'secretary:Control the secretary session'`,
		`\t\t'mission:Manage Missions, Task DAGs, prompts, and runtime'`,
		`\t\t'orchestration:Manage cyclic all-staff Orchestration topology and runtime'`,
		`\t\t'whiteboard:Manage Department Shared Whiteboards'`,
		`\t\t'token:In-graph Mission Token Bus commands'`,
		`\t\t'org:Off-graph strictly top-down supervision commands'`,
		`\t\t'inbox:Manage the ADE Inbox'`,
		`\t\t'version:Print the CLI version'`,
		'\t)',
		'\trank_subcommands=(',
		`\t\t'list:List L0 and L1..LN live rank directory'`,
		`\t\t'names:Print hot-updated tier alias map'`,
		`\t\t'get:Inspect a specific tier or alias'`,
		`\t\t'docs:Show canonical single-copy docs paths'`,
		`\t\t'rename:Hot-update display alias for a tier'`,
		`\t\t'mission-name:Set custom display alias for Missions'`,
		`\t\t'set-count:Resize rank tier count (>= 1)'`,
		'\t)',
		'\trole_subcommands=(',
		`\t\t'list:Show active organization role schema'`,
		`\t\t'apis:List available ADE control API primitives'`,
		`\t\t'presets:List built-in organization presets'`,
		`\t\t'preset:Apply an organization preset'`,
		`\t\t'apply-preset:Apply an organization preset'`,
		`\t\t'set-tier:Assign a session role tier'`,
		`\t\t'reset:Reset organization roles to default'`,
		`\t\t'studio:Open Organization and Roles Studio'`,
		'\t)',
		'\tmission_subcommands=(',
		`\t\t'docs:Locate sibling MISSION_API.md documentation'`,
		`\t\t'list:List Missions'`,
		`\t\t'init:Initialize a Mission'`,
		`\t\t'rename:Rename an existing Mission'`,
		`\t\t'export:Export a lossless Engineering bundle'`,
		`\t\t'import:Import a lossless Engineering bundle'`,
		`\t\t'open:Open a Mission canvas'`,
		`\t\t'blueprint:Get, apply, or validate a Mermaid DAG blueprint'`,
		`\t\t'task:List, create, update, or complete Mission Task DAG nodes'`,
		`\t\t'prompt:List, get, set, or clear per-node pre-prompts'`,
		`\t\t'check:Configure, inspect, remove, or dry-run verification hooks'`,
		`\t\t'start:Start Mission execution'`,
		`\t\t'run:Start Mission execution'`,
		`\t\t'status:Show live Mission runtime status'`,
		`\t\t'diagnostics:Inspect Mission critical path, stalls, and rework diagnostics'`,
		`\t\t'checkpoint:List, create, diff, or restore Orchestration checkpoints'`,
		`\t\t'pause:Pause Mission execution'`,
		`\t\t'resume:Resume Mission execution'`,
		`\t\t'stop:Stop Mission execution'`,
		`\t\t'timeout:Set Watchdog silence timeout in minutes'`,
		`\t\t'boundary:Get or set off-graph tier boundary and supervisors'`,
		`\t\t'recall:Recall in-flight tokens in jurisdiction'`,
		`\t\t'retry:Retry a frozen/failed token in place'`,
		`\t\t'patch:Atomically patch unfinished DAG topology'`,
		`\t\t'gate:Approve or reject a waiting Human Gate'`,
		`\t\t'trigger:List, set, or remove zero-token source triggers'`,
		`\t\t'host:Bind a Mission node to Local or a Cloud Host'`,
		`\t\t'remove:Remove a Mission and generated employees'`,
		'\t)',
		'\torchestration_subcommands=(',
		`\t\t'get:Inspect current Orchestration Mermaid topology'`,
		`\t\t'validate:Validate an Orchestration JSON/MJS/Mermaid manifest'`,
		`\t\t'load:Load an Orchestration JSON/MJS/Mermaid manifest'`,
		`\t\t'apply:Apply an Orchestration Mermaid topology'`,
		`\t\t'export:Export Orchestration topology or manifest'`,
		`\t\t'import:Import Orchestration Mermaid topology'`,
		`\t\t'layout:Set Orchestration canvas layout mode'`,
		`\t\t'group:Manage Department subgraphs'`,
		`\t\t'status:Show live Orchestration status'`,
		`\t\t'diagnostics:Inspect Mission and Orchestration diagnostics'`,
		`\t\t'checkpoint:List, create, diff, or restore Orchestration checkpoints'`,
		`\t\t'limits:Inspect or set max-hops and USD budget guardrails'`,
		`\t\t'pause:Pause Orchestration token routing'`,
		`\t\t'resume:Resume Orchestration token routing'`,
		`\t\t'abort:Abort active Orchestration tokens'`,
		`\t\t'dispatch:Dispatch a root requirement baton'`,
		`\t\t'staff:Create, configure, rename, or remove staff nodes'`,
		`\t\t'edge:Connect, relabel, or remove communication edges'`,
		'\t)',
		'\twhiteboard_subcommands=(',
		`\t\t'list:List Department Shared Whiteboards'`,
		`\t\t'create:Create a Department Shared Whiteboard'`,
		`\t\t'read:Read a Shared Whiteboard'`,
		`\t\t'toc:Show Shared Whiteboard Markdown table of contents'`,
		`\t\t'write:Write or append to a Shared Whiteboard'`,
		`\t\t'append:Append content to a Shared Whiteboard'`,
		`\t\t'rename:Rename or move a Shared Whiteboard'`,
		`\t\t'remove:Delete a Shared Whiteboard'`,
		'\t)',
		'\ttoken_subcommands=(',
		`\t\t'current:Inspect active tokens held by this node'`,
		`\t\t'read:Batch-dereference lightweight token pointers'`,
		`\t\t'history:Inspect pointer-indexed pass history and cyclic delta view'`,
		`\t\t'trace:Expand a token trace pointer'`,
		`\t\t'mint:Actively mint sub-task token(s) downward to subordinate(s)'`,
		`\t\t'split:Split into heterogeneous subordinate branches with join barrier'`,
		`\t\t'return:Return a completed downward baton upward to its superior'`,
		`\t\t'handoff:Hand off an Orchestration baton token along a connected edge'`,
		`\t\t'complete:Complete a token with a 1-line headline and optional pointers'`,
		`\t\t'reject:Reject or bounce a token with actionable feedback'`,
		`\t\t'block:Declare a long-running blocked token with optional wakeup watch'`,
		`\t\t'fail:Report failure on a token'`,
		`\t\t'retry:Retry a failed token'`,
		'\t)',
		'\torg_subcommands=(',
		`\t\t'subordinates:List managed subordinates and Mission jurisdictions'`,
		`\t\t'send:Send a top-down directive to a managed subordinate'`,
		`\t\t'context:Pull recent conversation transcript of a managed subordinate'`,
		`\t\t'escalate:Escalate an unresolved failure upward'`,
		'\t)',
		'\tsession_subcommands=(',
		`\t\t'list:List ADE sessions'`,
		`\t\t'info:Inspect session metadata'`,
		`\t\t'subordinates:List subordinate sessions'`,
		`\t\t'tree:Show session hierarchy tree'`,
		`\t\t'create:Create a new session'`,
		`\t\t'configure:Configure engine, model, thinking, or role'`,
		`\t\t'attach:Attach an existing native engine conversation'`,
		`\t\t'connect:Connect a draft session to an engine'`,
		`\t\t'open:Open session in workbench'`,
		`\t\t'send:Send a prompt to a session'`,
		`\t\t'history:Read session conversation history'`,
		`\t\t'stop:Stop active turn on a session'`,
		`\t\t'delete:Delete session and subordinates'`,
		'\t)',
		'',
		'\tif (( CURRENT == 2 )); then',
		`\t\t_describe -t commands 'aexus-ade command' top_level`,
		'\telif [[ ${words[2]} == completion ]]; then',
		`\t\t_values 'shell' ${COMPLETION_SHELLS.join(' ')}`,
		'\telif [[ ( ${words[2]} == rank || ${words[2]} == ranks ) && CURRENT == 3 ]]; then',
		`\t\t_describe -t commands 'rank command' rank_subcommands`,
		'\telif [[ ( ${words[2]} == role || ${words[2]} == roles ) && CURRENT == 3 ]]; then',
		`\t\t_describe -t commands 'role command' role_subcommands`,
		'\telif [[ ${words[2]} == org && CURRENT == 3 ]]; then',
		`\t\t_describe -t commands 'org command' org_subcommands`,
		'\telif [[ ( ${words[2]} == token || ${words[2]} == tokens ) && CURRENT == 3 ]]; then',
		`\t\t_describe -t commands 'token command' token_subcommands`,
		'\telif [[ ${words[2]} == mission && CURRENT == 3 ]]; then',
		`\t\t_describe -t commands 'mission command' mission_subcommands`,
		'\telif [[ ( ${words[2]} == orchestration || ${words[2]} == orch ) && CURRENT == 3 ]]; then',
		`\t\t_describe -t commands 'orchestration command' orchestration_subcommands`,
		'\telif [[ ( ${words[2]} == whiteboard || ${words[2]} == whiteboards || ${words[2]} == wb ) && CURRENT == 3 ]]; then',
		`\t\t_describe -t commands 'whiteboard command' whiteboard_subcommands`,
		'\telif [[ ${words[2]} == session && CURRENT == 3 ]]; then',
		`\t\t_describe -t commands 'session command' session_subcommands`,
		'\tfi',
		'}',
		'',
		`_aexus_ade "$@"`,
		'',
	].join('\n');
}

function buildFishCompletion() {
	const lines = [
		'# fish completion for aexus-ade',
		'complete -c aexus-ade -f',
	];
	const descriptions = {
		doctor: 'Diagnose the ADE environment',
		completion: 'Emit a shell completion script',
		status: 'Show workbench status',
		whoami: 'Inspect caller session identity and tier',
		docs: 'Read single-copy ADE API documentation',
		api: 'Query immutable API changelog diff',
		mode: 'Get or set ADE/IDE mode',
		view: 'Inspect or change the ADE view',
		rank: 'Inspect or hot-update rank tiers, aliases, and single-copy docs',
		role: 'Manage organization roles and presets',
		project: 'Manage projects',
		host: 'Manage Cloud Hosts',
		engine: 'List engines and sessions',
		session: 'Manage sessions',
		secretary: 'Control the secretary session',
		mission: 'Manage Engineering Missions, Task DAGs, and runtime',
		orchestration: 'Manage cyclic all-staff Orchestration topology and dynamic expansion',
		whiteboard: 'Manage Department Shared Whiteboards (lightweight token pointers)',
		token: 'Token Bus and Orchestration relay handoff commands',
		org: 'Off-graph strictly top-down supervision commands',
		inbox: 'Manage the ADE Inbox',
		version: 'Print the CLI version',
	};
	for (const command of TOP_LEVEL_COMMANDS) {
		lines.push(`complete -c aexus-ade -n '__fish_use_subcommand' -a ${command} -d '${descriptions[command]}'`);
	}
	lines.push(`complete -c aexus-ade -n '__fish_seen_subcommand_from completion' -a '${COMPLETION_SHELLS.join(' ')}'`);
	for (const command of RANK_SUBCOMMANDS) {
		lines.push(`complete -c aexus-ade -n '__fish_seen_subcommand_from rank' -a ${command}`);
	}
	for (const command of ROLE_SUBCOMMANDS) {
		lines.push(`complete -c aexus-ade -n '__fish_seen_subcommand_from role' -a ${command}`);
	}
	for (const command of MISSION_SUBCOMMANDS) {
		lines.push(`complete -c aexus-ade -n '__fish_seen_subcommand_from mission' -a ${command}`);
	}
	for (const command of ORCHESTRATION_SUBCOMMANDS) {
		lines.push(`complete -c aexus-ade -n '__fish_seen_subcommand_from orchestration' -a ${command}`);
	}
	for (const command of WHITEBOARD_SUBCOMMANDS) {
		lines.push(`complete -c aexus-ade -n '__fish_seen_subcommand_from whiteboard' -a ${command}`);
	}
	for (const command of TOKEN_SUBCOMMANDS) {
		lines.push(`complete -c aexus-ade -n '__fish_seen_subcommand_from token' -a ${command}`);
	}
	for (const command of ORG_SUBCOMMANDS) {
		lines.push(`complete -c aexus-ade -n '__fish_seen_subcommand_from org' -a ${command}`);
	}
	for (const command of SESSION_SUBCOMMANDS) {
		lines.push(`complete -c aexus-ade -n '__fish_seen_subcommand_from session' -a ${command}`);
	}
	lines.push('');
	return lines.join('\n');
}

function buildPowerShellCompletion() {
	const quoteList = items => items.map(item => `'${item}'`).join(', ');
	return [
		'# PowerShell completion for aexus-ade',
		`Register-ArgumentCompleter -Native -CommandName aexus-ade -ScriptBlock {`,
		'\tparam($wordToComplete, $commandAst, $cursorPosition)',
		'\t$tokens = $commandAst.CommandElements | ForEach-Object { $_.Extent.Text }',
		`\t$topLevel = @(${quoteList(TOP_LEVEL_COMMANDS)})`,
		`\t$shells = @(${quoteList(COMPLETION_SHELLS)})`,
		`\t$roleSubcommands = @(${quoteList(ROLE_SUBCOMMANDS)})`,
		`\t$rankSubcommands = @(${quoteList(RANK_SUBCOMMANDS)})`,
		`\t$missionSubcommands = @(${quoteList(MISSION_SUBCOMMANDS)})`,
		`\t$orchestrationSubcommands = @(${quoteList(ORCHESTRATION_SUBCOMMANDS)})`,
		`\t$whiteboardSubcommands = @(${quoteList(WHITEBOARD_SUBCOMMANDS)})`,
		`\t$tokenSubcommands = @(${quoteList(TOKEN_SUBCOMMANDS)})`,
		`\t$orgSubcommands = @(${quoteList(ORG_SUBCOMMANDS)})`,
		`\t$sessionSubcommands = @(${quoteList(SESSION_SUBCOMMANDS)})`,
		'\t$candidates = @()',
		'\tif ($tokens.Count -le 2 -and ($tokens.Count -eq 1 -or $wordToComplete)) {',
		'\t\t$candidates = $topLevel',
		'\t} elseif ($tokens.Count -ge 2) {',
		'\t\tswitch ($tokens[1]) {',
		'\t\t\t\'completion\' { $candidates = $shells }',
		'\t\t\t{ $_ -in @(\'rank\', \'ranks\') } { $candidates = $rankSubcommands }',
		'\t\t\t{ $_ -in @(\'role\', \'roles\') } { $candidates = $roleSubcommands }',
		'\t\t\t\'org\' { $candidates = $orgSubcommands }',
		'\t\t\t{ $_ -in @(\'token\', \'tokens\') } { $candidates = $tokenSubcommands }',
		'\t\t\t\'mission\' { $candidates = $missionSubcommands }',
		'\t\t\t{ $_ -in @(\'orchestration\', \'orch\') } { $candidates = $orchestrationSubcommands }',
		'\t\t\t{ $_ -in @(\'whiteboard\', \'whiteboards\', \'wb\') } { $candidates = $whiteboardSubcommands }',
		'\t\t\t\'session\' { $candidates = $sessionSubcommands }',
		'\t\t}',
		'\t}',
		`\t$candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {`,
		`\t\t[System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)`,
		'\t}',
		'}',
		'',
	].join('\n');
}

export function buildCompletionScript(shell) {
	switch (shell) {
		case 'bash': return buildBashCompletion();
		case 'zsh': return buildZshCompletion();
		case 'fish': return buildFishCompletion();
		case 'powershell': return buildPowerShellCompletion();
	}
}

export const HELP_TEXT = `Usage: aexus-ade [options] <command> [args]

Control the running Aexus Code ADE workbench over its local control socket.

Global Options:
  -h, --help                Show this help message and exit
  -v, --version             Print the CLI and engine baseline version
  --json                    Print structured JSON output (compact on non-TTY; --pretty to indent)
  --pretty                  Pretty-print JSON output with 2-space indentation
  --window <id>             Target a specific workbench window ID (alias: --window-id <id>)
  --idempotency-key <key>   Explicit mutation deduplication key (1..128 [A-Za-z0-9._:-]+; auto-UUIDv4 by default)

Organizational Ranks (numeric tiers L-1 User > L0 Secretary > L1..LN; live aliases via aexus-ade rank names --json):
  L1 (default: governor)  Top orchestrator; owns architecture, Engineering Orchestration & Mission Task DAGs, and downward token delegation.
  L2 (default: manager)   Mid-level lead; splits sub-tasks downward via tokens, manages immediate next-tier staff within department, returns verified results.
  L3 (default: employee)  Mid-lower orchestrated rank; executes/reviews baton tokens in Engineering or supervises lower tiers top-down.
  L4 (default: worker)    Pure execution leaf rank; 100% clean native Coding Agent context outside Engineering, token/whiteboard bus inside Engineering.

Commands:
  status
  version
  whoami
  docs read <common|L0..LN|engineering|paradigm|engineering-api|mission|manifest>
  api update [--since <rev>] [--scope <all|common|in_graph|off_graph|mission>]
  doctor [--project <path>] [--strict]
  completion <bash|zsh|fish|powershell>
  mode [get | set <ade|ide>]
  view [status | --archived <true|false|toggle> | --inspector <changes|files|hide> | --refresh]

  rank list
  rank names
  rank get <L-1|L0|L1..LN|rankId|alias>
  rank docs [common|L0|L1..LN|engineering|engineering-api|mission]
  rank rename <L1..LN|rankId> "<alias>" [--short <tag>]
  rank mission-name "<displayName>"
  rank set-count <N>

  role list
  role apis
  role presets
  role apply-preset <presetId>    (alias: role preset <presetId>)
  role set-tier <sessionId> <rankId|worker|none>
  role reset
  role studio [rankId]

  project list
  project add <path|aexus-ssh://host/path|host:/path...> [--name <label>]
  project select <target>
  project remove <target>
  project delete <target> [--sessions] [--files] [--permanent]
  project focus <target>
  project home
  project forward
  project move <source> (--before <target> | --after <target>)
  project changes [target]
  project files [target] [--path <subpath>] [--depth <n>]
  project open-file <file> [--project <target>] [--side]
  project open-diff <file> [--project <target>]

  host list
  host info <alias|id>
  host add [alias] --host <addr> [--name <label>] [--alias <alias>] [--user <user>] [--port <n>] [--os <linux|macos|windows>] [--identity <keyPath>] [--jump <proxyJump>] [--default-dir <remotePath>]
  host update <alias|id> [--host <addr>] [--name <label>] [--alias <alias>] [--user <user>] [--port <n>] [--os <linux|macos|windows>] [--identity <keyPath>] [--jump <proxyJump>] [--default-dir <remotePath>]
  host remove <alias|id>
  host test <alias|id>
  host browse <alias|id> [--path <remotePath>]
  host import-vscode
  host open [alias|id]

  engine list
  engine sessions <engine> [--project <target>] [--limit <n>]

  session list [--project <p>] [--parent <id|root>] [--role <L1..LN|rankId>] [--engine <e>] [--status <idle|working|pending|draft>] [--unread] [--archived] [--all]
  session info <id>
  session subordinates [id] [--recursive]
  session tree [id]
  session create [--project <p>] [--engine <e>] [--title <t>] [--parent <id>] [--role <L1..LN|rankId>] [--model <m>] [--thinking <lvl>] [--draft [text]] [--side] [--no-open]
  session configure <id> [--engine <e>] [--model <m>] [--thinking <off|low|medium|high|xhigh|max>] [--role <r>]
  session attach --engine <e> --native-id <nativeId> [--project <p>] [--title <t>] [--parent <id>] [--role <L1..LN|rankId>] [--side] [--no-open]
  session connect <id> --engine <e> [--native-id <nativeId>] [--side] [--no-open]
  session open <id> [--side]
  session select <id>
  session close <id>
  session mark-read (<id> | --all)
  session draft <id> [<text> | --clear]
  session rename <id> <title>
  session role <id> <L1..LN|rankId|none>
  session move <id> <parentId|none> [--project <p>]
  session nest <id> <parentId|none> [--project <p>]
  session reorder <id> (--before <targetId> | --after <targetId>)
  session send <id> (<prompt> | --prompt-file <path|->) [--wait]
  session history <id> [--limit <n>]
  session stop <id>
  session archive <id>
  session unarchive <id>
  session detach|remove <id>
  session delete <id> [--force]

  secretary [status]
  secretary open [--side]
  secretary engine <e>
  secretary reset [--engine <e>]
  secretary send (<prompt> | --prompt-file <path|->) [--wait]
  secretary history [--limit <n>]
  secretary stop
  secretary draft [<text> | --clear]
  secretary mark-read

  mission docs
  mission list [--project <path>]
  mission init [--mission <id> | --owner <id>] [--title "<name>"] [--open] [--side]
  mission rename <missionId> "<newTitle>"
  mission export [--mission <id>] [--format json|markdown] [--with-positions] [--file <outPath>]
  mission import [--owner <id>] [--project <path>] [--title "<name>"] (--file <path|-> | --text <bundleJson>) [--open] [--side]
  mission open --mission <id> [--view <mission|orchestration|both>] [--side]
  mission blueprint get --mission <id> [--raw]
  mission blueprint apply --mission <id> (--file <path|-> | --text <mermaid>)
  mission blueprint validate (--file <path|-> | --text <mermaid>)
  mission task list|get|create|update|set|remove|complete|status|edge [--mission <id>] [--node <taskId>] [--title <title>] [--description <text>] [--owner <staffId>] [--assignee <staffId>] [--min-tier <n>] [--after <upId>] [--require-checks] [--require-artifact] [--require-files] [--require-whiteboard <wbId,...>] [--min-summary <chars>] [--evidence <text>] [--full] [--force]
  mission check list|get|set|remove|run [--mission <id>] [--node <nodeId>] ...
  mission diagnostics [--mission <id>]
  mission checkpoint list|create|diff|restore [--mission <id>] [--label "<name>"] [--checkpoint <id>]
  mission trigger list|set|remove [--mission <id>] ...
  mission host bind [--mission <id>] --node <id> --host <local|alias> [--path <remotePath>]
  mission status [--mission <id>]
  mission remove --mission <id>

  orchestration get [--mission <id>] [--raw]
  orchestration validate (--file <path.json|mjs|mmd|-> | --text <mermaid>)
  orchestration load [--mission <id>] --file <path.json|mjs|mmd|->
  orchestration apply [--mission <id>] (--file <path|-> | --text <mermaid>)
  orchestration export [--mission <id>] [--format mermaid|json] [--with-positions] [--raw] [--file <outPath>]
  orchestration import [--mission <id>] (--file <path|-> | --text <mermaid>)
  orchestration layout set <lr|td|radial|grid> [--mission <id>] [--persist-in-code]
  orchestration group list|create|rename|assign|remove [--mission <id>] ...
  orchestration status [--mission <id>] [--full]
  orchestration diagnostics [--mission <id>]
  orchestration checkpoint list|create|diff|restore [--mission <id>] [--label "<name>"] [--checkpoint <id>]
  orchestration limits [--mission <id>] [--max-hops <N|none|off>] [--budget <usd|none|off|inf>] [--silence <1..1440>] [--total-cost <usd|off>]
  orchestration pause|resume|abort [--mission <id>] [--reason <text>]
  orchestration dispatch [--mission <id>] --prompt <text> [--detail <text|-> | --detail-file <path>] [--task <taskId>] [--artifact <title=body>] [--decision <title=body>] [--ref <ptr[,...]>] [--to <staffNodeId>] [--whiteboard <wbId>]
  orchestration staff create|rename|config|remove [--mission <id>] ...
  orchestration edge connect|label|remove [--mission <id>] <fromId> <toId> ...

  whiteboard list [--mission <id>] [--department <Dept>]
  whiteboard create [--mission <id>] --department <Dept> --title <Title> [--id <wbId>] [--content <text|-> | --file <path|->]
  whiteboard read <wbId> [--mission <id>] [--toc | --summary-only] [--section "<Heading>"] [--max-chars <N>] [--offset <N> | --tail <N>]
  whiteboard write <wbId> [--mission <id>] [--section "<Heading>"] (--content <text|-> | --append <text|-> | --file <path|-> | --append-file <path|->) [--expected-version <n>]
  whiteboard rename <wbId> "<New Title>" [--department <Dept>] [--mission <id>]
  whiteboard remove <wbId> [--mission <id>]

  token current [--mission <id>] [--agent <id>] [--full]
  token read <ptr1[,ptr2...]> [--mission <id>] [--token <tokenId>] [--toc | --summary-only] [--section "<Heading>"] [--max-chars <N>] [--offset <N> | --tail <N>]
  token history <tokenId> [--mission <id>] [--all | --delta]
  token trace <tracePtr> [--mission <id>] [--limit <n>]
  token mint [parentTokenId] --to <subNodeId> --summary <text> [--detail <text|-> | --detail-file <path>] [--task <taskId>] [--scope-paths <glob[,...]>] [--conflict-policy reject|warn|allow | --allow-overlap] [--wave-summary <text>] [--branches-json <json|-> | --branches-file <path>] [--wait-join | --no-wait-join] [--join-mode all|any|quorum] [--quorum <n>] [--fail-fast] [--deadline <dur|ms|iso>] [--from <staffNodeId>] [--mission <id>]
  token split [parentTokenId] (--branches-json <json|-> | --branches-file <path> | --branch <json>) [--scope-paths <glob[,...]>] [--conflict-policy reject|warn|allow | --allow-overlap] [--wave-summary <text>] [--wait-join | --no-wait-join] [--join-mode all|any|quorum] [--quorum <n>] [--fail-fast] [--deadline <dur|ms|iso>] [--from <staffNodeId>] [--mission <id>]
  token return <tokenId> --summary <text> [--to <superiorNodeId>] [--detail <text|-> | --detail-file <path>] [--task <taskId>] [--complete-task] [--evidence <text>] [--artifact <title=body>] [--decision <title=body>] [--whiteboard <wbId>] [--files <p1,p2>] [--mission <id>]
  token handoff <tokenId> --to <nodeId[,nodeId2]> --summary <text> [--detail <text|-> | --detail-file <path>] [--task <taskId>] [--artifact <title=body>] [--decision <title=body>] [--ref <ptr[,...]>] [--whiteboard <wbId[,...]>] [--files <p1,p2>] [--mission <id>]
  token complete <tokenId> --summary <text> [--detail <text|-> | --detail-file <path>] [--task <taskId>] [--complete-task] [--evidence <text>] [--artifact <title=body>] [--decision <title=body>] [--ref <ptr[,...]>] [--to <nodeId[,...]>] [--whiteboard <wbId[,...]>] [--files <p1,p2>] [--finish] [--mission <id>]
  token reject <tokenId> --reason <text> [--category <defect|spec|test|env|scope|security|other>] [--to <nodeId[,nodeId2]>] [--wait-join | --no-wait-join] [--detail <text|-> | --detail-file <path>] [--whiteboard <wbId>] [--mission <id>]
  token block <tokenId> --duration <duration> [--reason <text>] [--watch-pid <pid> | --wake-on-pid-exit <pid>] [--watch-file <path> | --wake-on-file <path>] [--host <alias>]
  token fail <tokenId> --reason <text> [--category <defect|spec|test|env|scope|security|other>] [--detail <text|-> | --detail-file <path>] [--mission <id>]
  token retry (<tokenId> | --node <nodeId>) [--guidance <text>] [--wait-join | --no-wait-join] [--mission <id>]

  org subordinates [supervisorId] [--mission <id>]
  org send <nodeOrSessionId> (<message> | --message-file <path|->) [--mission <id>] [--wait]
  org context <nodeOrSessionId> [--limit <n>] [--full] [--mission <id>]
  org escalate --reason <text> [--mission <id>] [--token <tokenId>] [--node <nodeId>]

  inbox list [--unread-only] [--governor <id>]
  inbox post --from <governorId> --message <text> [--title <title>] [--node <nodeId>]
  inbox resolve --id <msgId> [--resolution <text>]
  inbox mark-read [--id <msgId> | --all]
`;
