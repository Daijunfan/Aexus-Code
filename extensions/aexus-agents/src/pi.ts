/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as vscode from 'vscode';
import {
	buildRemotePersistentPrefix,
	CloudHostTarget,
	encodePiProjectSlug,
	execRemoteShell,
	healAllRemoteControlBridges,
	inspectRemotePersistentSessionsByPrefix,
	joinRemotePath,
	posixQuote,
	psSingleQuote,
	readRemoteTextFile,
	readRemoteTextFilesBatch,
	resolveRemoteRealpath,
	terminateRemotePersistentSession,
	terminateRemotePersistentSessionsByPrefix,
} from './cloudTransport';
import { readPiModelsJson, readPiSettings } from './capabilities';
import { hasAdeEmployeeIdentity, isSafeAdeCliCommandInput } from './engineAdapterHelpers';
import { LineByteAccumulator } from './lineByteAccumulator';
import { agentIdentityScopeKey, createTurnInterimUsageTracker, EngineAttachment, EngineRuntime, EngineRuntimeCapabilities, EngineSendOptions, EngineTurnTokenUsage, emitThinkingProgress, getConfiguredEngineTurnTimeoutMs, HistoryEntry, identityFromSendOptions, isAutonomousModeEnabled, NativeSession, prepareAgentChildEnv, prepareRemoteAgentChildEnv, raceWithCancellation, REMOTE_REATTACH_BACKOFFS_MS, spawnEngine, stopEngine, stopEngineWithFallback, waitForBackoffOrResume, withTimeout } from './runtime';
import { createMultiStepTurnUsageAccumulator, normalizeProviderTokenUsage } from './usageTracker';

interface PiContentPart {
	type?: string;
	text?: string;
}

interface PiEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	cwd?: string;
	name?: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: string | PiContentPart[];
		stopReason?: string;
		errorMessage?: string;
	};
}

interface PiRpcPacket {
	type?: string;
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
	isError?: boolean;
	is_error?: boolean;
	exitCode?: number;
	toolCallId?: string;
	data?: Record<string, unknown>;
	name?: string;
	toolName?: string;
	method?: string;
	title?: string;
	message?: string | { role?: string; usage?: unknown; model?: string; provider?: string; stopReason?: string; errorMessage?: string };
	placeholder?: string;
	prefill?: string;
	options?: string[];
	messages?: { role?: string; usage?: unknown; model?: string; provider?: string; stopReason?: string; errorMessage?: string }[];
	finalError?: string;
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
		toolName?: string;
	};
	args?: Record<string, unknown>;
	usage?: unknown;
	tokens?: unknown;
}

function extractPiTurnUsage(value: unknown): EngineTurnTokenUsage | undefined {
	return normalizeProviderTokenUsage(value);
}

interface PiModelInfo { id: string; name: string; description?: string }
interface PiCommandInfo { name: string; description?: string }
interface PiToolMode { id: 'full' | 'readonly' | 'chat' }

const PI_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function modelEntries(value: unknown): PiModelInfo[] {
	const unwrapped = asRecord(value)?.data ?? value;
	const container = Array.isArray(unwrapped) ? unwrapped : (asRecord(unwrapped)?.models ?? unwrapped);
	const models: PiModelInfo[] = [];
	const seen = new Set<string>();
	const add = (provider: string | undefined, rawId: string | undefined, rawName: string | undefined, description?: string): void => {
		if (!rawId) {
			return;
		}
		const id = provider && !rawId.includes('/') ? `${provider}/${rawId}` : rawId;
		if (seen.has(id)) {
			return;
		}
		seen.add(id);
		models.push({ id, name: rawName || rawId, description });
	};
	if (Array.isArray(container)) {
		for (const item of container) {
			if (typeof item === 'string') {
				add(undefined, item, item);
				continue;
			}
			const record = asRecord(item);
			add(stringValue(record?.provider), stringValue(record?.id) ?? stringValue(record?.model), stringValue(record?.name) ?? stringValue(record?.label), stringValue(record?.description));
		}
	} else {
		const record = asRecord(container);
		if (record) {
			for (const [id, item] of Object.entries(record)) {
				const entry = asRecord(item);
				add(stringValue(entry?.provider), stringValue(entry?.id) ?? id, stringValue(entry?.name) ?? id, stringValue(entry?.description));
			}
		}
	}
	return models;
}

function commandEntries(value: unknown): PiCommandInfo[] {
	const container = Array.isArray(value) ? value : (asRecord(value)?.commands ?? value);
	const commands: PiCommandInfo[] = [];
	const seen = new Set<string>();
	const add = (name: string | undefined, description?: string): void => {
		const normalized = name?.trim().replace(/^\//, '');
		if (!normalized || seen.has(normalized)) {
			return;
		}
		seen.add(normalized);
		commands.push({ name: normalized, description });
	};
	if (Array.isArray(container)) {
		for (const item of container) {
			if (typeof item === 'string') {
				add(item);
				continue;
			}
			const record = asRecord(item);
			add(stringValue(record?.name) ?? stringValue(record?.id), stringValue(record?.description));
		}
	} else {
		const record = asRecord(container);
		if (record) {
			for (const [name, item] of Object.entries(record)) {
				add(name, stringValue(asRecord(item)?.description));
			}
		}
	}
	return commands;
}

function forkEntries(value: unknown): Array<{ entryId?: string; text: string }> {
	const container = Array.isArray(value) ? value : (asRecord(value)?.messages ?? []);
	const entries: Array<{ entryId?: string; text: string }> = [];
	if (!Array.isArray(container)) {
		return entries;
	}
	for (const item of container) {
		if (typeof item === 'string') {
			entries.push({ text: item });
			continue;
		}
		const record = asRecord(item);
		const text = stringValue(record?.text) ?? stringValue(record?.preview) ?? stringValue(record?.message) ?? '';
		const role = stringValue(record?.role);
		entries.push({
			entryId: stringValue(record?.entryId) ?? stringValue(record?.id),
			text: role ? `${role}: ${text}` : text || '—',
		});
	}
	return entries;
}

function displayValue(value: unknown): string {
	if (value === undefined || value === null || value === '') {
		return '—';
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	try {
		return JSON.stringify(value).slice(0, 160);
	} catch {
		return String(value);
	}
}

function modelName(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	const record = asRecord(value);
	return record ? stringValue(record.id) ?? stringValue(record.name) ?? stringValue(record.model) : undefined;
}

function piThinkingLevel(thinking: string | undefined): string | undefined {
	if (!thinking || thinking === 'default') {
		return undefined;
	}
	if (thinking === 'max' || thinking === 'extra-high') {
		return 'xhigh';
	}
	if (thinking === 'none') {
		return 'off';
	}
	return PI_THINKING_LEVELS.has(thinking) ? thinking : undefined;
}

function toolDetail(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) {
		return undefined;
	}
	for (const key of ['command', 'path', 'filePath', 'file', 'pattern', 'query', 'url', 'name']) {
		const value = stringValue(args[key]);
		if (value) {
			return value.length > 120 ? `${value.slice(0, 117)}…` : value;
		}
	}
	return undefined;
}

function piMessageText(content: string | PiContentPart[] | undefined): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text ?? '').join('\n');
	}
	return '';
}

export { encodePiProjectSlug };

export function arePiModelsEquivalent(
	requestedModel: string | undefined,
	slotCurrentModel: string | undefined,
): boolean {
	const trimmedReq = requestedModel?.trim();
	const normSlotModel = slotCurrentModel && slotCurrentModel.trim() && slotCurrentModel.trim() !== 'default'
		? slotCurrentModel.trim()
		: undefined;
	if (!trimmedReq) {
		return true;
	}
	if (trimmedReq === 'default') {
		return !normSlotModel;
	}
	return trimmedReq === normSlotModel || Boolean(
		normSlotModel && (
			(!trimmedReq.includes('/') && normSlotModel.endsWith(`/${trimmedReq}`)) ||
			(!normSlotModel.includes('/') && trimmedReq.endsWith(`/${normSlotModel}`))
		),
	);
}

interface PiActiveTurnDriver {
	settled: boolean;
	steeredInPlace: boolean;
	readonly settledPromise: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	readonly handlePacket: (packet: PiRpcPacket) => void;
	readonly onStreamProgress: (msg: string) => void;
	readonly onInStreamSteer?: (formattedMessage: string, noticeMarkdown?: string) => void;
	readonly cancellationToken: vscode.CancellationToken;
}

interface PiDaemonSlot {
	readonly slotKey: string;
	readonly sessionId: string;
	readonly scopeKey: string;
	readonly toolMode: PiToolMode['id'];
	readonly cwd: string;
	readonly customEnv: NodeJS.ProcessEnv;
	readonly spawnArgs: string[];
	readonly remotePersistentId?: string;
	child: ReturnType<typeof spawnEngine>;
	readonly stdoutLineAcc: LineByteAccumulator;
	stdoutBytesReceived: number;
	reattachAttempt: number;
	stderrText: string;
	nextReqId: number;
	readonly pendingRequests: Map<string, {
		readonly resolve: (data: Record<string, unknown> | undefined) => void;
		readonly reject: (error: Error) => void;
	}>;
	currentModel?: string;
	currentThinkingLevel?: string;
	activeTurn?: PiActiveTurnDriver;
	backendTurnActive: boolean;
	autoRetrying: boolean;
	agentEndFallbackTimer?: ReturnType<typeof setTimeout>;
	steerHandoffSafetyTimer?: ReturnType<typeof setTimeout>;
	readonly settledWaiters: Set<() => void>;
	dead: boolean;
	disposed: boolean;
}

export class PiRuntime implements EngineRuntime {
	readonly id = 'pi';
	readonly name = 'Pi';
	private readonly running = new Map<string, Set<ReturnType<typeof spawnEngine>>>();
	private readonly daemonSlots = new Map<string, PiDaemonSlot>();
	private readonly sessionSlotKeys = new Map<string, string>();
	private readonly activePersistentIdsBySession = new Map<string, Set<string>>();
	private readonly toolModes = new Map<string, PiToolMode['id']>();
	private readonly capabilityCache = new Map<string, { expiresAt: number; value: EngineRuntimeCapabilities }>();
	private readonly capabilityPending = new Map<string, Promise<EngineRuntimeCapabilities>>();
	private readonly lastTurnUsageBySession = new Map<string, EngineTurnTokenUsage>();
	private readonly lastRawSessionUsageBySession = new Map<string, EngineTurnTokenUsage>();
	private readonly syntheticHistoryBySession = new Map<string, HistoryEntry[]>();

	private appendSyntheticHistory(sessionId: string, entry: HistoryEntry): void {
		if (!entry.text.trim()) {
			return;
		}
		let list = this.syntheticHistoryBySession.get(sessionId);
		if (!list) {
			list = [];
			this.syntheticHistoryBySession.set(sessionId, list);
		}
		list.push({ ...entry });
		if (list.length > 256) {
			list.splice(0, list.length - 256);
		}
	}

	getActiveDaemonPid(sessionId: string): number | undefined {
		const slot = this.findLiveSlotForSession(sessionId);
		return slot?.child.pid;
	}

	hasActiveTurnForSession(sessionId: string): boolean {
		const slot = this.findLiveSlotForSession(sessionId);
		return Boolean(slot && (slot.backendTurnActive || (slot.activeTurn && !slot.activeTurn.settled)));
	}

	private findLiveSlotForSession(sessionId: string): PiDaemonSlot | undefined {
		const mappedKey = this.sessionSlotKeys.get(sessionId);
		if (mappedKey) {
			const slot = this.daemonSlots.get(mappedKey);
			if (slot && !slot.dead && !slot.disposed && slot.child.exitCode === null && !slot.child.stdin.destroyed) {
				return slot;
			}
		}
		for (const slot of this.daemonSlots.values()) {
			if (slot.sessionId === sessionId && !slot.dead && !slot.disposed && slot.child.exitCode === null && !slot.child.stdin.destroyed) {
				return slot;
			}
		}
		return undefined;
	}

	private notifySlotSettled(slot: PiDaemonSlot): void {
		if (slot.agentEndFallbackTimer !== undefined) {
			clearTimeout(slot.agentEndFallbackTimer);
			slot.agentEndFallbackTimer = undefined;
		}
		slot.backendTurnActive = false;
		slot.autoRetrying = false;
		for (const waiter of [...slot.settledWaiters]) {
			try { waiter(); } catch { /* ignore */ }
		}
		slot.settledWaiters.clear();
	}

	private waitForSlotSettled(slot: PiDaemonSlot, maxWaitMs = 2000): Promise<boolean> {
		if (!slot.backendTurnActive || slot.dead || slot.disposed) {
			return Promise.resolve(true);
		}
		return new Promise<boolean>(resolve => {
			let done = false;
			const finish = (settledCleanly: boolean) => {
				if (done) {
					return;
				}
				done = true;
				clearTimeout(timer);
				slot.settledWaiters.delete(onSettled);
				resolve(settledCleanly);
			};
			const onSettled = () => finish(true);
			const timer = setTimeout(() => finish(!slot.backendTurnActive || slot.dead), maxWaitMs);
			timer.unref?.();
			slot.settledWaiters.add(onSettled);
		});
	}

	private destroyDaemonSlot(slotKey: string, signal: NodeJS.Signals = 'SIGTERM', killTree = true): void {
		const slot = this.daemonSlots.get(slotKey);
		if (!slot) {
			return;
		}
		this.daemonSlots.delete(slotKey);
		if (this.sessionSlotKeys.get(slot.sessionId) === slotKey) {
			this.sessionSlotKeys.delete(slot.sessionId);
		}
		slot.disposed = true;
		slot.dead = true;
		if (slot.agentEndFallbackTimer !== undefined) {
			clearTimeout(slot.agentEndFallbackTimer);
			slot.agentEndFallbackTimer = undefined;
		}
		if (slot.steerHandoffSafetyTimer !== undefined) {
			clearTimeout(slot.steerHandoffSafetyTimer);
			slot.steerHandoffSafetyTimer = undefined;
		}
		const closedErr = new Error(vscode.l10n.t('Pi connection closed.'));
		for (const req of slot.pendingRequests.values()) {
			req.reject(closedErr);
		}
		slot.pendingRequests.clear();
		this.notifySlotSettled(slot);
		if (slot.activeTurn && !slot.activeTurn.settled) {
			slot.activeTurn.resolve();
			slot.activeTurn = undefined;
		}
		const runningSet = this.running.get(slot.sessionId);
		if (runningSet) {
			runningSet.delete(slot.child);
			if (runningSet.size === 0) {
				this.running.delete(slot.sessionId);
			}
		}
		try {
			if (!slot.child.stdin.destroyed) {
				slot.child.stdin.end();
			}
		} catch { /* ignore */ }
		stopEngine(slot.child, signal, { killTree });
	}

	private sendSlotCommand<T extends Record<string, unknown> | undefined = Record<string, unknown> | undefined>(
		slot: PiDaemonSlot,
		command: Record<string, unknown>,
		timeoutMs = 20_000,
	): Promise<T> {
		if (slot.dead || slot.disposed || slot.child.stdin.destroyed) {
			return Promise.reject(new Error(vscode.l10n.t('Pi connection closed unexpectedly.')));
		}
		const id = `req-${++slot.nextReqId}`;
		return new Promise<T>((resolve, reject) => {
			let done = false;
			const timer = setTimeout(() => {
				if (done) {
					return;
				}
				done = true;
				slot.pendingRequests.delete(id);
				reject(new Error(`Pi command "${String(command.type ?? '')}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
			slot.pendingRequests.set(id, {
				resolve: data => {
					if (!done) {
						done = true;
						clearTimeout(timer);
						resolve(data as T);
					}
				},
				reject: err => {
					if (!done) {
						done = true;
						clearTimeout(timer);
						reject(err);
					}
				},
			});
			try {
				slot.child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
			} catch (err) {
				if (!done) {
					done = true;
					clearTimeout(timer);
					slot.pendingRequests.delete(id);
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			}
		});
	}

	private async abortSlotTurnAndWait(slot: PiDaemonSlot, maxWaitMs = 2000): Promise<boolean> {
		if (slot.dead || slot.disposed) {
			return true;
		}
		if (slot.steerHandoffSafetyTimer !== undefined) {
			clearTimeout(slot.steerHandoffSafetyTimer);
			slot.steerHandoffSafetyTimer = undefined;
		}
		void this.sendSlotCommand(slot, { type: 'clear_queue' }, Math.min(1200, maxWaitMs)).catch(() => { });
		const abortReq = this.sendSlotCommand(slot, { type: 'abort' }, maxWaitMs).catch(() => undefined);
		const settledCleanly = await this.waitForSlotSettled(slot, maxWaitMs);
		await Promise.race([abortReq, new Promise<void>(r => setTimeout(r, 50))]);
		return settledCleanly;
	}

	private bindDaemonSlotStreams(slot: PiDaemonSlot, targetChild: ReturnType<typeof spawnEngine>): void {
		slot.child = targetChild;
		slot.stdoutLineAcc.reset();
		const dispatchPacket = (line: string) => {
			if (!line) {
				return;
			}
			let packet: PiRpcPacket;
			try {
				packet = JSON.parse(line) as PiRpcPacket;
			} catch {
				return;
			}
			if (packet.type === 'response' && packet.id) {
				const req = slot.pendingRequests.get(packet.id);
				if (req) {
					slot.pendingRequests.delete(packet.id);
					if (packet.success) {
						req.resolve(packet.data);
					} else {
						req.reject(new Error(packet.error || vscode.l10n.t('Pi command {0} failed.', packet.command ?? '')));
					}
				}
				return;
			}
			if (packet.type === 'agent_start' || packet.type === 'turn_start' || packet.type === 'message_start') {
				slot.backendTurnActive = true;
				if (slot.agentEndFallbackTimer !== undefined) {
					clearTimeout(slot.agentEndFallbackTimer);
					slot.agentEndFallbackTimer = undefined;
				}
			} else if (packet.type === 'auto_retry_start') {
				slot.autoRetrying = true;
				if (slot.agentEndFallbackTimer !== undefined) {
					clearTimeout(slot.agentEndFallbackTimer);
					slot.agentEndFallbackTimer = undefined;
				}
			} else if (packet.type === 'auto_retry_end' && packet.success === false) {
				slot.autoRetrying = false;
			}

			if (packet.type === 'agent_settled') {
				this.notifySlotSettled(slot);
				slot.activeTurn?.handlePacket(packet);
				return;
			}

			slot.activeTurn?.handlePacket(packet);

			if (packet.type === 'agent_end' && !slot.autoRetrying && slot.backendTurnActive) {
				if (slot.agentEndFallbackTimer !== undefined) {
					clearTimeout(slot.agentEndFallbackTimer);
				}
				slot.agentEndFallbackTimer = setTimeout(() => {
					slot.agentEndFallbackTimer = undefined;
					if (slot.backendTurnActive && !slot.autoRetrying) {
						this.notifySlotSettled(slot);
						slot.activeTurn?.handlePacket({ type: 'agent_settled' });
					}
				}, 80);
				slot.agentEndFallbackTimer.unref?.();
			}
		};

		targetChild.stderr.on('data', data => {
			slot.stderrText = (slot.stderrText + String(data)).slice(-8000);
		});
		targetChild.stdout.on('data', (chunk: Buffer | string) => {
			slot.stdoutLineAcc.push(
				chunk,
				(line, rawBytes) => {
					slot.stdoutBytesReceived += rawBytes;
					dispatchPacket(line);
				},
				droppedBytes => {
					slot.stdoutBytesReceived += droppedBytes;
				},
			);
		});
		targetChild.on('error', err => {
			if (slot.child !== targetChild || slot.disposed) {
				return;
			}
			slot.dead = true;
			const errorObj = err instanceof Error ? err : new Error(String(err));
			for (const req of slot.pendingRequests.values()) {
				req.reject(errorObj);
			}
			slot.pendingRequests.clear();
			this.notifySlotSettled(slot);
			const active = slot.activeTurn;
			slot.activeTurn = undefined;
			this.daemonSlots.delete(slot.slotKey);
			if (this.sessionSlotKeys.get(slot.sessionId) === slot.slotKey) {
				this.sessionSlotKeys.delete(slot.sessionId);
			}
			if (active && !active.settled) {
				active.reject(errorObj);
			}
		});
		targetChild.on('close', code => {
			if (slot.child !== targetChild || slot.disposed) {
				return;
			}
			if (slot.stdoutLineAcc.pendingBytes > 0 && code === 0) {
				slot.stdoutLineAcc.flushTail(
					(tail, rawBytes) => {
						slot.stdoutBytesReceived += rawBytes;
						dispatchPacket(tail);
					},
					droppedBytes => {
						slot.stdoutBytesReceived += droppedBytes;
					},
				);
			}
			const active = slot.activeTurn;
			if (
				slot.remotePersistentId
				&& this.remoteTarget
				&& active
				&& !active.settled
				&& !active.cancellationToken.isCancellationRequested
				&& code === 255
				&& slot.reattachAttempt < REMOTE_REATTACH_BACKOFFS_MS.length
			) {
				const backoffMs = REMOTE_REATTACH_BACKOFFS_MS[slot.reattachAttempt++] ?? 60_000;
				active.onStreamProgress(vscode.l10n.t('SSH connection interrupted; reattaching to persistent remote Pi session…'));
				void (async () => {
					await waitForBackoffOrResume(backoffMs, active.cancellationToken);
					if (slot.disposed || active.settled || active.cancellationToken.isCancellationRequested) {
						active.resolve();
						return;
					}
					await healAllRemoteControlBridges().catch(() => undefined);
					if (slot.disposed || active.settled || active.cancellationToken.isCancellationRequested) {
						active.resolve();
						return;
					}
					const runningSet = this.running.get(slot.sessionId);
					runningSet?.delete(targetChild);
					const nextChild = spawnEngine(this.executable, slot.spawnArgs, slot.cwd, slot.customEnv, this.remoteTarget, {
						persistentSessionId: slot.remotePersistentId,
						attachByteOffset: slot.stdoutBytesReceived,
						attachOnly: true,
					});
					runningSet?.add(nextChild);
					this.bindDaemonSlotStreams(slot, nextChild);
				})();
				return;
			}

			slot.dead = true;
			const runningSet = this.running.get(slot.sessionId);
			if (runningSet) {
				runningSet.delete(targetChild);
				if (runningSet.size === 0) {
					this.running.delete(slot.sessionId);
				}
			}
			this.untrackPersistentId(slot.sessionId, slot.remotePersistentId);
			this.daemonSlots.delete(slot.slotKey);
			if (this.sessionSlotKeys.get(slot.sessionId) === slot.slotKey) {
				this.sessionSlotKeys.delete(slot.sessionId);
			}
			const closeErr = new Error(slot.stderrText || vscode.l10n.t('Pi exited before finishing ({0}).', String(code)));
			for (const req of slot.pendingRequests.values()) {
				req.reject(closeErr);
			}
			slot.pendingRequests.clear();
			this.notifySlotSettled(slot);
			slot.activeTurn = undefined;
			if (active && !active.settled) {
				if (active.cancellationToken.isCancellationRequested || code === 0) {
					active.resolve();
				} else {
					active.reject(closeErr);
				}
			}
		});
	}

	private async ensureDaemonSlot(
		session: NativeSession,
		toolMode: PiToolMode['id'],
		modelOption: string | undefined,
		options?: EngineSendOptions,
	): Promise<{ readonly slot: PiDaemonSlot; readonly newlySpawned: boolean }> {
		const scopeKey = agentIdentityScopeKey(session.id, options, session.cwd);
		const slotKey = `${scopeKey}::${session.id}`;
		const prevSlotKey = this.sessionSlotKeys.get(session.id);
		if (prevSlotKey && prevSlotKey !== slotKey) {
			this.destroyDaemonSlot(prevSlotKey, 'SIGKILL', false);
		}
		const identity = identityFromSendOptions(session.id, options);
		const existing = this.daemonSlots.get(slotKey);
		if (existing) {
			if (
				!existing.dead
				&& !existing.disposed
				&& existing.child.exitCode === null
				&& !existing.child.stdin.destroyed
				&& existing.toolMode === toolMode
				&& existing.cwd === session.cwd
				&& (!identity.agentToken || existing.customEnv.ADE_AGENT_TOKEN === identity.agentToken)
			) {
				return { slot: existing, newlySpawned: false };
			}
			this.destroyDaemonSlot(slotKey, 'SIGKILL', false);
		}

		const args = [
			'--mode', 'rpc',
			...(modelOption ? ['--model', modelOption] : []),
			...(toolMode === 'readonly' ? ['--tools', 'read,grep,find,ls'] : toolMode === 'chat' ? ['--no-tools'] : []),
			...this.sessionArgs(session),
		];
		const customEnv = this.remoteTarget
			? await prepareRemoteAgentChildEnv(this.remoteTarget, identity)
			: await prepareAgentChildEnv(identity);
		const remotePersistentId = this.remoteTarget && this.remoteTarget.os !== 'windows'
			? `${buildRemotePersistentPrefix(this.id, session.id)}-${randomUUID().slice(0, 8)}`
			: undefined;
		this.trackPersistentId(session.id, remotePersistentId);
		const child = spawnEngine(
			this.executable,
			args,
			session.cwd,
			customEnv,
			this.remoteTarget,
			remotePersistentId ? { persistentSessionId: remotePersistentId } : undefined,
		);
		let sessionProcs = this.running.get(session.id);
		if (!sessionProcs) {
			sessionProcs = new Set();
			this.running.set(session.id, sessionProcs);
		}
		sessionProcs.add(child);

		const slot: PiDaemonSlot = {
			slotKey,
			sessionId: session.id,
			scopeKey,
			toolMode,
			cwd: session.cwd,
			customEnv,
			spawnArgs: args,
			remotePersistentId,
			child,
			stdoutLineAcc: new LineByteAccumulator(),
			stdoutBytesReceived: 0,
			reattachAttempt: 0,
			stderrText: '',
			nextReqId: 0,
			pendingRequests: new Map(),
			currentModel: modelOption,
			backendTurnActive: false,
			autoRetrying: false,
			settledWaiters: new Set(),
			dead: false,
			disposed: false,
		};
		this.bindDaemonSlotStreams(slot, child);
		this.daemonSlots.set(slotKey, slot);
		this.sessionSlotKeys.set(session.id, slotKey);
		return { slot, newlySpawned: true };
	}

	private async applySlotModel(
		slot: PiDaemonSlot,
		modelOption: string,
		token: vscode.CancellationToken,
	): Promise<void> {
		let provider: string | undefined;
		let modelId: string | undefined;
		const separator = modelOption.indexOf('/');
		if (separator > 0 && separator < modelOption.length - 1) {
			provider = modelOption.slice(0, separator);
			modelId = modelOption.slice(separator + 1);
		} else {
			const listing = await raceWithCancellation(
				this.sendSlotCommand<Record<string, unknown> | undefined>(slot, { type: 'get_available_models' }, 10_000),
				token,
			).catch(() => undefined);
			const match = modelEntries(listing).find(model => model.id === modelOption || model.id.endsWith(`/${modelOption}`) || model.name === modelOption);
			const matchSeparator = match ? match.id.indexOf('/') : -1;
			if (match && matchSeparator > 0) {
				provider = match.id.slice(0, matchSeparator);
				modelId = match.id.slice(matchSeparator + 1);
			}
		}
		if (!token.isCancellationRequested) {
			const setModelCmd = provider && modelId
				? { type: 'set_model', provider, modelId }
				: { type: 'set_model', modelId: modelOption };
			await raceWithCancellation(this.sendSlotCommand(slot, setModelCmd, 8_000), token).catch(() => undefined);
			slot.currentModel = modelOption;
		}
	}

	async prepareSteerPreemption(session: NativeSession, nextModel?: string): Promise<boolean> {
		const slot = this.findLiveSlotForSession(session.id);
		if (!slot || !slot.backendTurnActive) {
			return false;
		}
		const modelChanged = !arePiModelsEquivalent(nextModel, slot.currentModel);
		if (modelChanged) {
			const prev = slot.activeTurn;
			if (prev && !prev.settled) {
				prev.steeredInPlace = true;
				prev.resolve();
				slot.activeTurn = undefined;
			}
			const settledCleanly = await this.abortSlotTurnAndWait(slot, 2000);
			if (!settledCleanly && slot.backendTurnActive && !slot.dead) {
				this.destroyDaemonSlot(slot.slotKey, 'SIGINT', false);
			}
			return true;
		}

		// Same model while active: keep `slot.backendTurnActive === true` so incoming `send()` issues native `{"type":"steer"}`!
		const prev = slot.activeTurn;
		if (prev && !prev.settled) {
			prev.steeredInPlace = true;
			prev.resolve();
			slot.activeTurn = undefined;
		}
		if (slot.steerHandoffSafetyTimer !== undefined) {
			clearTimeout(slot.steerHandoffSafetyTimer);
		}
		slot.steerHandoffSafetyTimer = setTimeout(() => {
			slot.steerHandoffSafetyTimer = undefined;
			if (!slot.activeTurn && slot.backendTurnActive && !slot.dead) {
				void this.abortSlotTurnAndWait(slot, 1500);
			}
		}, 1500);
		slot.steerHandoffSafetyTimer.unref?.();
		return true;
	}

	async tryNativeInStreamSteer(
		session: NativeSession,
		params: {
			readonly model?: string;
			readonly reasoningEffort?: string;
			readonly formattedMessage: string;
			readonly streamNoticeMarkdown?: string;
		},
	): Promise<{ readonly steered: boolean }> {
		if (!params.formattedMessage) {
			return { steered: false };
		}
		const slot = this.findLiveSlotForSession(session.id);
		const isTurnActive = Boolean(slot && (slot.backendTurnActive || (slot.activeTurn && !slot.activeTurn.settled)));
		if (!slot || !isTurnActive) {
			return { steered: false };
		}
		if (!arePiModelsEquivalent(params.model, slot.currentModel)) {
			return { steered: false };
		}

		const nextPiLevel = piThinkingLevel(params.reasoningEffort);
		if (nextPiLevel && nextPiLevel !== slot.currentThinkingLevel) {
			void this.sendSlotCommand(slot, { type: 'set_thinking_level', level: nextPiLevel }, 3_000).then(
				() => { slot.currentThinkingLevel = nextPiLevel; },
				() => undefined,
			);
		}

		try {
			await this.sendSlotCommand(slot, { type: 'steer', message: params.formattedMessage }, 10_000);
		} catch {
			return { steered: false };
		}

		if (slot.activeTurn?.onInStreamSteer) {
			slot.activeTurn.onInStreamSteer(params.formattedMessage, params.streamNoticeMarkdown);
		} else {
			this.appendSyntheticHistory(session.id, { role: 'user', text: params.formattedMessage });
		}
		session.provisional = false;
		return { steered: true };
	}

	consumeLastTurnUsage(sessionId: string): EngineTurnTokenUsage | undefined {
		const usage = this.lastTurnUsageBySession.get(sessionId);
		this.lastTurnUsageBySession.delete(sessionId);
		return usage;
	}

	constructor(private readonly executable: string, readonly remoteTarget?: CloudHostTarget) { }

	private sessionsDir(): string {
		const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), '.pi', 'agent');
		return path.join(agentDir, 'sessions');
	}

	private parseSessionHistoryContent(content: string): HistoryEntry[] {
		const byId = new Map<string, PiEntry>();
		const ordered: PiEntry[] = [];
		for (const rawLine of content.split('\n')) {
			const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
			if (!line) { continue; }
			let entry: PiEntry;
			try { entry = JSON.parse(line) as PiEntry; } catch { continue; }
			if (entry.type === 'session') { continue; }
			ordered.push(entry);
			if (entry.id) {
				byId.set(entry.id, entry);
			}
		}

		if (ordered.length === 0) { return []; }
		let branch: PiEntry[];
		if (ordered.some(entry => Boolean(entry.parentId))) {
			branch = [];
			const visited = new Set<string>();
			let current: PiEntry | undefined = [...ordered].reverse().find(entry => entry.type === 'message' || Boolean(entry.parentId)) ?? ordered.at(-1);
			while (current) {
				if (current.id) {
					if (visited.has(current.id)) { break; }
					visited.add(current.id);
				}
				branch.push(current);
				current = current.parentId ? byId.get(current.parentId) : undefined;
			}
			branch.reverse();
		} else {
			branch = ordered;
		}

		const history: HistoryEntry[] = [];
		for (const entry of branch) {
			if (entry.type !== 'message') { continue; }
			const role = entry.message?.role;
			if (role !== 'user' && role !== 'assistant') { continue; }
			const text = piMessageText(entry.message?.content).trim();
			if (text) {
				history.push({ id: entry.id, role, text });
			}
		}
		return history;
	}

	private async listRemote(token: vscode.CancellationToken, projectCwd?: string): Promise<NativeSession[]> {
		if (!this.remoteTarget || token.isCancellationRequested) {
			return [];
		}
		const targetCwds: string[] = [];
		const targetSlugs: string[] = [];
		if (projectCwd?.trim()) {
			const canonical = projectCwd.trim();
			targetCwds.push(canonical);
			const realCwd = await resolveRemoteRealpath(this.remoteTarget, canonical, token).catch(() => undefined);
			if (realCwd && !targetCwds.includes(realCwd)) {
				targetCwds.push(realCwd);
			}
			for (const candidate of targetCwds) {
				const slug = encodePiProjectSlug(candidate);
				if (slug && !targetSlugs.includes(slug)) {
					targetSlugs.push(slug);
				}
			}
		}

		const pyPi = [
			`import glob, json, os, sys`,
			`root = os.path.join(os.environ.get("PI_CODING_AGENT_DIR") or os.path.expanduser("~/.pi/agent"), "sessions")`,
			`if not os.path.isdir(root): sys.exit(0)`,
			`target_slugs = json.loads(sys.argv[1])`,
			`canonical_cwd = sys.argv[2]`,
			`files = []`,
			`if target_slugs:`,
			`    seen = set()`,
			`    for slug in target_slugs:`,
			`        d = os.path.join(root, slug)`,
			`        if not os.path.isdir(d): continue`,
			`        for name in os.listdir(d):`,
			`            if not name.endswith(".jsonl"): continue`,
			`            fp = os.path.join(d, name)`,
			`            if fp in seen or not os.path.isfile(fp): continue`,
			`            seen.add(fp)`,
			`            try: st = os.stat(fp)`,
			`            except OSError: continue`,
			`            files.append((st.st_mtime, fp, True))`,
			`else:`,
			`    for fp in glob.glob(os.path.join(root, "*", "*.jsonl")):`,
			`        if not os.path.isfile(fp): continue`,
			`        try: st = os.stat(fp)`,
			`        except OSError: continue`,
			`        files.append((st.st_mtime, fp, False))`,
			`files.sort(key=lambda x: x[0], reverse=True)`,
			`for mtime, fp, in_target_slug in files[:150]:`,
			`    sid = None; cwd = None; created_ts = ""; sname = ""; raw_user = ""`,
			`    try:`,
			`        with open(fp, "r", encoding="utf-8", errors="replace") as f:`,
			`            for line in f:`,
			`                if not line.strip(): continue`,
			`                want = ('"session_info"' in line) or (not sid and '"type":"session"' in line) or (not sid and '"type": "session"' in line)`,
			`                if not want and not raw_user and len(line) < 524288 and ('"role":"user"' in line or '"role": "user"' in line):`,
			`                    want = True`,
			`                if not want: continue`,
			`                try: ev = json.loads(line)`,
			`                except Exception: continue`,
			`                if not isinstance(ev, dict): continue`,
			`                t = ev.get("type")`,
			`                if t == "session" and ev.get("id"):`,
			`                    sid = str(ev["id"])`,
			`                    if ev.get("cwd"): cwd = str(ev["cwd"])`,
			`                    if isinstance(ev.get("timestamp"), str): created_ts = ev["timestamp"]`,
			`                elif t == "session_info" and isinstance(ev.get("name"), str) and ev["name"].strip():`,
			`                    sname = ev["name"].strip()`,
			`                elif not raw_user and t == "message":`,
			`                    msg = ev.get("message")`,
			`                    if isinstance(msg, dict) and msg.get("role") == "user":`,
			`                        c = msg.get("content")`,
			`                        txt = c if isinstance(c, str) else ("\\n".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text" and isinstance(p.get("text"), str)) if isinstance(c, list) else "")`,
			`                        if txt.strip(): raw_user = txt.strip()[:2000]`,
			`    except OSError: continue`,
			`    eff_cwd = (canonical_cwd if (in_target_slug and canonical_cwd) else cwd)`,
			`    if sid and eff_cwd:`,
			`        print("__AEX_PI_J__\\t" + json.dumps({"id": sid, "cwd": eff_cwd, "name": sname, "rawUser": raw_user, "ts": created_ts, "mtime": int(mtime * 1000), "file": fp}, ensure_ascii=False))`,
		].join('\n');

		const canonicalArg = targetCwds[0] ?? '';
		const slugShellLoop = targetSlugs.length > 0
			? `for _slug in ${targetSlugs.map(posixQuote).join(' ')}; do for f in "$root/$_slug"/*.jsonl; do [ -f "$f" ] || continue; m=$(stat -c "%Y" "$f" 2>/dev/null || stat -f "%m" "$f" 2>/dev/null || echo 0); printf '%s\\t%s\\n' "$m" "$f"; done; done`
			: `for f in "$root"/*/*.jsonl; do [ -f "$f" ] || continue; m=$(stat -c "%Y" "$f" 2>/dev/null || stat -f "%m" "$f" 2>/dev/null || echo 0); printf '%s\\t%s\\n' "$m" "$f"; done`;
		const posixScript = [
			`if command -v python3 >/dev/null 2>&1; then`,
			`  python3 -c ${posixQuote(pyPi)} ${posixQuote(JSON.stringify(targetSlugs))} ${posixQuote(canonicalArg)}`,
			`  exit $?`,
			`fi`,
			`root="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"`,
			`[ -d "$root" ] || exit 0`,
			`${slugShellLoop} | sort -rn | head -n 120 | while IFS=$(printf '\\t') read -r m f; do`,
			`  [ -f "$f" ] || continue`,
			`  printf '__AEX_PI_F__\\t%s\\t%s\\n' "$m" "$f"`,
			`  head -n 60 -- "$f" 2>/dev/null || true`,
			`done`,
		].join('\n');
		const winSlugFilter = targetSlugs.length > 0
			? `@(${targetSlugs.map(psSingleQuote).join(', ')}) | ForEach-Object { $sd = Join-Path $root $_; if (Test-Path -LiteralPath $sd) { Get-ChildItem -LiteralPath $sd -Filter '*.jsonl' -File -ErrorAction SilentlyContinue } }`
			: `Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter '*.jsonl' -File -ErrorAction SilentlyContinue }`;
		const winScript = [
			`$base = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE '.pi\\agent' }`,
			`$root = Join-Path $base 'sessions'`,
			`if (Test-Path -LiteralPath $root) {`,
			`  ${winSlugFilter} | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 120 | ForEach-Object {`,
			`    $ms = [int64]([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeMilliseconds()`,
			`    Write-Output ("__AEX_PI_F__" + [char]9 + $ms + [char]9 + $_.FullName)`,
			`    Get-Content -LiteralPath $_.FullName -TotalCount 60 -Encoding UTF8 -ErrorAction SilentlyContinue`,
			`  }`,
			`}`,
		].join('; ');
		const res = await execRemoteShell(this.remoteTarget, posixScript, winScript, { timeoutMs: 20_000, token }).catch(() => undefined);
		if (!res || res.code !== 0) {
			return [];
		}
		const sessions: NativeSession[] = [];
		const seenIds = new Set<string>();
		let curFile: string | undefined;
		let curMtime = Date.now();
		let id: string | undefined;
		let cwd: string | undefined;
		let created = curMtime;
		let sessionName: string | undefined;
		let firstUserText: string | undefined;
		const flush = () => {
			const effCwd = (targetSlugs.length > 0 && canonicalArg) ? canonicalArg : cwd;
			if (curFile && id && effCwd && !seenIds.has(id)) {
				seenIds.add(id);
				sessions.push({
					id,
					cwd: effCwd,
					label: sessionName || firstUserText || vscode.l10n.t('Pi Session {0}', id.slice(0, 8)),
					created,
					updated: curMtime,
					file: curFile,
					provisional: false,
				});
			}
		};
		for (const rawLine of res.stdout.toString('utf8').split(/\r?\n/)) {
			if (rawLine.startsWith('__AEX_PI_J__\t')) {
				try {
					const row = JSON.parse(rawLine.slice('__AEX_PI_J__\t'.length)) as {
						id?: string; cwd?: string; name?: string; rawUser?: string; ts?: string; mtime?: number; file?: string;
					};
					if (row.id && row.cwd && !seenIds.has(row.id)) {
						seenIds.add(row.id);
						const mtime = typeof row.mtime === 'number' && row.mtime > 0 ? row.mtime : Date.now();
						const parsedTs = row.ts ? Date.parse(row.ts) : NaN;
						const cleanedMsg = row.rawUser ? row.rawUser.trim() : '';
						const userLabel = cleanedMsg ? cleanedMsg.split('\n')[0].slice(0, 100) : undefined;
						sessions.push({
							id: row.id,
							cwd: row.cwd,
							label: row.name?.trim() || userLabel || vscode.l10n.t('Pi Session {0}', row.id.slice(0, 8)),
							created: Number.isFinite(parsedTs) ? parsedTs : mtime,
							updated: mtime,
							file: row.file,
							provisional: false,
						});
					}
				} catch { /* ignore */ }
				continue;
			}
			if (rawLine.startsWith('__AEX_PI_F__\t')) {
				flush();
				const parts = rawLine.split('\t');
				const rawTs = Number(parts[1]) || 0;
				curMtime = rawTs > 1e11 ? rawTs : (rawTs > 0 ? rawTs * 1000 : Date.now());
				curFile = parts.slice(2).join('\t').trim() || undefined;
				id = undefined;
				cwd = undefined;
				created = curMtime;
				sessionName = undefined;
				firstUserText = undefined;
				continue;
			}
			if (!curFile || !rawLine) { continue; }
			let entry: PiEntry;
			try { entry = JSON.parse(rawLine) as PiEntry; } catch { continue; }
			if (entry.type === 'session' && entry.id && entry.cwd) {
				id = entry.id;
				cwd = entry.cwd;
				if (entry.timestamp) {
					const parsed = Date.parse(entry.timestamp);
					if (Number.isFinite(parsed)) { created = parsed; }
				}
			} else if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) {
				sessionName = entry.name.trim();
			} else if (!firstUserText && entry.type === 'message' && entry.message?.role === 'user') {
				const rawMsg = piMessageText(entry.message.content).trim();
				if (rawMsg) {
					firstUserText = rawMsg.split('\n')[0].slice(0, 100);
				}
			}
		}
		flush();
		return sessions;
	}

	async list(token: vscode.CancellationToken, projectCwd?: string): Promise<NativeSession[]> {
		if (this.remoteTarget) {
			return this.listRemote(token, projectCwd);
		}
		const root = this.sessionsDir();
		let groups: string[];
		if (projectCwd?.trim()) {
			const realCwd = await fs.realpath(projectCwd.trim()).catch(() => path.resolve(projectCwd.trim()));
			const targetSlugs = [...new Set([encodePiProjectSlug(projectCwd.trim()), encodePiProjectSlug(realCwd)].filter(Boolean))];
			groups = [];
			for (const slug of targetSlugs) {
				try {
					const st = await fs.stat(path.join(root, slug));
					if (st.isDirectory()) { groups.push(slug); }
				} catch { /* ignore absent slug dir */ }
			}
		} else {
			try {
				groups = await fs.readdir(root);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
				throw error;
			}
		}

		const files: { file: string; mtimeMs: number; birthtimeMs: number }[] = [];
		for (const group of groups) {
			if (token.isCancellationRequested) { break; }
			const groupPath = path.join(root, group);
			try {
				const groupStat = await fs.stat(groupPath);
				if (!groupStat.isDirectory()) { continue; }
				const entries = await fs.readdir(groupPath);
				for (const entry of entries) {
					if (!entry.endsWith('.jsonl')) { continue; }
					const filePath = path.join(groupPath, entry);
					try {
						const stat = await fs.stat(filePath);
						if (stat.isFile()) {
							files.push({ file: filePath, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs });
						}
					} catch { /* Ignore broken symlink or transient file. */ }
				}
			} catch { /* Ignore non-directory or broken symlink. */ }
		}

		files.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const sessions: NativeSession[] = [];
		for (const candidate of files.slice(0, 250)) {
			if (token.isCancellationRequested) { break; }
			let id: string | undefined;
			let cwd: string | undefined;
			let created = candidate.birthtimeMs;
			let sessionName: string | undefined;
			let firstUserText: string | undefined;
			const input = createReadStream(candidate.file, { encoding: 'utf8', highWaterMark: 32 * 1024 });
			const rl = readline.createInterface({ input, crlfDelay: Infinity });
			let scannedLines = 0;
			try {
				for await (const rawLine of rl) {
					if (token.isCancellationRequested) { break; }
					if ((id && cwd && (sessionName || firstUserText)) || ++scannedLines > 120) { break; }
					const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
					if (!line) { continue; }
					if (!line.includes('"session') && (firstUserText || !line.includes('"user"'))) { continue; }
					let entry: PiEntry;
					try { entry = JSON.parse(line) as PiEntry; } catch { continue; }
					if (entry.type === 'session' && entry.id && entry.cwd) {
						id = entry.id;
						cwd = entry.cwd;
						if (entry.timestamp) {
							const parsed = Date.parse(entry.timestamp);
							if (Number.isFinite(parsed)) { created = parsed; }
						}
					} else if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) {
						sessionName = entry.name.trim();
					} else if (!firstUserText && entry.type === 'message' && entry.message?.role === 'user') {
						const rawMsg = piMessageText(entry.message.content).trim();
						if (rawMsg) {
							firstUserText = rawMsg.split('\n')[0].slice(0, 100);
						}
					}
				}
			} catch {
				continue;
			} finally {
				rl.close();
				input.destroy();
			}
			if (id && cwd) {
				sessions.push({
					id,
					cwd,
					label: sessionName || firstUserText || vscode.l10n.t('Pi Session {0}', id.slice(0, 8)),
					created,
					updated: candidate.mtimeMs,
					file: candidate.file,
					provisional: false,
				});
			}
		}
		return sessions;
	}

	async create(cwd: string): Promise<NativeSession> {
		const now = Date.now();
		return {
			id: randomUUID(),
			cwd,
			label: vscode.l10n.t('New Pi Session'),
			created: now,
			updated: now,
			provisional: true,
		};
	}

	async history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
		if (token.isCancellationRequested) { return []; }
		const synthetic = this.syntheticHistoryBySession.get(session.id);
		let diskHistory: HistoryEntry[] = [];
		if (!session.provisional || session.file) {
			const file = session.file ?? (await this.list(token)).find(item => item.id === session.id)?.file;
			if (file) {
				session.file = file;
				let content: string | undefined;
				if (this.remoteTarget) {
					content = await readRemoteTextFile(this.remoteTarget, file, { bypassCache: true, timeoutMs: 20_000, token });
				} else {
					try {
						content = await fs.readFile(file, 'utf8');
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
							throw error;
						}
					}
				}
				if (content !== undefined) {
					diskHistory = this.parseSessionHistoryContent(content);
				}
			}
		}
		if (!synthetic || synthetic.length === 0) {
			return diskHistory;
		}
		if (diskHistory.length === 0) {
			return synthetic.map(entry => ({ ...entry }));
		}
		const diskUserTexts = new Set(diskHistory.filter(e => e.role === 'user').map(e => e.text.trim()));
		const missingSyntheticUser = synthetic.some(e => e.role === 'user' && !diskUserTexts.has(e.text.trim()));
		return missingSyntheticUser ? synthetic.map(entry => ({ ...entry })) : diskHistory;
	}

	private sessionArgs(session: NativeSession): string[] {
		return session.file ? ['--session', session.file] : ['--session-id', session.id];
	}

	/**
	 * Runs a short-lived RPC worker and sends each command once, returning the response data in order.
	 * Commands that fail or time out resolve to `undefined` so callers can degrade gracefully.
	 */
	private async runRpc(cwd: string, extraArgs: readonly string[], commands: ReadonlyArray<Record<string, unknown>>, timeoutMs: number, token?: vscode.CancellationToken): Promise<Array<Record<string, unknown> | undefined>> {
		const results: Array<Record<string, unknown> | undefined> = commands.map(() => undefined);
		if (token?.isCancellationRequested) {
			return results;
		}
		const rpcEnv = this.remoteTarget
			? undefined
			: await prepareAgentChildEnv({ sessionId: 'pi-rpc', pureWorker: true });
		const child = spawnEngine(this.executable, ['--mode', 'rpc', ...extraArgs], cwd, rpcEnv, this.remoteTarget);
		const pending = new Map<string, (data: Record<string, unknown> | undefined) => void>();
		let buffer = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			buffer += chunk;
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
				const rawLine = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
				if (!line) { continue; }
				let packet: PiRpcPacket;
				try { packet = JSON.parse(line) as PiRpcPacket; } catch { continue; }
				if (packet.type !== 'response' || !packet.id) { continue; }
				const resolve = pending.get(packet.id);
				if (resolve) {
					pending.delete(packet.id);
					resolve(packet.success ? packet.data : undefined);
				}
			}
		});
		const settleAll = () => {
			const waiting = [...pending.values()];
			pending.clear();
			for (const resolve of waiting) { resolve(undefined); }
		};
		child.on('error', settleAll);
		child.on('close', settleAll);
		const subscription = token?.onCancellationRequested(() => {
			stopEngine(child, 'SIGKILL');
			settleAll();
		});
		const requests = commands.map((command, index) => new Promise<void>(resolve => {
			const id = `rpc-${index}`;
			pending.set(id, data => {
				results[index] = data;
				resolve();
			});
			if (child.stdin.destroyed) {
				pending.delete(id);
				resolve();
				return;
			}
			try {
				child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
			} catch {
				pending.delete(id);
				resolve();
			}
		}));
		try {
			await withTimeout(Promise.all(requests), timeoutMs);
		} catch { /* Time out or exit; return whatever completed. */ }
		finally {
			subscription?.dispose();
			if (!child.stdin.destroyed) { child.stdin.end(); }
			stopEngine(child, 'SIGKILL');
		}
		return results;
	}

	private async readConfiguredPiModels(cwd: string): Promise<{ defaultModel?: string; models: PiModelInfo[] }> {
		const models: PiModelInfo[] = [];
		const seen = new Set<string>();
		let defaultModel: string | undefined;
		const pushModels = (items: ReadonlyArray<{ id: string; name: string; description?: string }>) => {
			for (const item of items) {
				if (!seen.has(item.id)) {
					seen.add(item.id);
					models.push({ id: item.id, name: item.name, ...(item.description ? { description: item.description } : {}) });
				}
			}
		};

		if (this.remoteTarget) {
			const rHome = this.remoteTarget.remoteHome;
			const settingsPaths = [
				joinRemotePath(this.remoteTarget.os, cwd, '.pi', 'settings.json'),
				...(rHome ? [joinRemotePath(this.remoteTarget.os, rHome, '.pi', 'agent', 'settings.json')] : []),
			];
			const modelPaths = [
				joinRemotePath(this.remoteTarget.os, cwd, '.pi', 'models.json'),
				...(rHome ? [joinRemotePath(this.remoteTarget.os, rHome, '.pi', 'agent', 'models.json')] : []),
				joinRemotePath(this.remoteTarget.os, cwd, '.pi', 'models-store.json'),
				...(rHome ? [joinRemotePath(this.remoteTarget.os, rHome, '.pi', 'agent', 'models-store.json')] : []),
			];
			const batch = await readRemoteTextFilesBatch(this.remoteTarget, [...settingsPaths, ...modelPaths]).catch(() => new Map<string, string | undefined>());
			for (const p of settingsPaths) {
				const txt = batch.get(p);
				if (txt !== undefined) {
					const read = readPiSettings(txt);
					defaultModel ??= read.defaultModel;
				}
			}
			for (const p of modelPaths) {
				const txt = batch.get(p);
				if (txt !== undefined) {
					pushModels(readPiModelsJson(txt).models);
				}
			}
			if (defaultModel && !seen.has(defaultModel)) {
				pushModels([{ id: defaultModel, name: defaultModel }]);
			}
			return { defaultModel, models };
		}

		const agentDirs = [...new Set([process.env.PI_CODING_AGENT_DIR?.trim(), path.join(os.homedir(), '.pi', 'agent')].filter((d): d is string => Boolean(d)))];
		const settingsPaths = [
			path.join(cwd, '.pi', 'settings.json'),
			...agentDirs.map(d => path.join(d, 'settings.json')),
		];
		const modelPaths = [
			path.join(cwd, '.pi', 'models.json'),
			...agentDirs.map(d => path.join(d, 'models.json')),
			path.join(cwd, '.pi', 'models-store.json'),
			...agentDirs.map(d => path.join(d, 'models-store.json')),
		];
		for (const p of settingsPaths) {
			try {
				const txt = await fs.readFile(p, 'utf8');
				const read = readPiSettings(txt);
				defaultModel ??= read.defaultModel;
			} catch { /* ignore absent settings.json */ }
		}
		for (const p of modelPaths) {
			try {
				const txt = await fs.readFile(p, 'utf8');
				pushModels(readPiModelsJson(txt).models);
			} catch { /* ignore absent models file */ }
		}
		if (defaultModel && !seen.has(defaultModel)) {
			pushModels([{ id: defaultModel, name: defaultModel }]);
		}
		return { defaultModel, models };
	}

	async getRuntimeCapabilities(cwd: string, _session?: NativeSession): Promise<EngineRuntimeCapabilities> {
		const cached = this.capabilityCache.get(cwd);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.value;
		}
		const pending = this.capabilityPending.get(cwd);
		if (pending) {
			return pending;
		}
		const load = (async (): Promise<EngineRuntimeCapabilities> => {
			const [configured, rpcResults] = await Promise.all([
				this.readConfiguredPiModels(cwd),
				this.runRpc(cwd, [], [{ type: 'get_available_models' }, { type: 'get_commands' }], 8000),
			]);
			const [models, commands] = rpcResults;
			const rpcModels = models !== undefined ? modelEntries(models) : [];
			const mergedModels: PiModelInfo[] = [];
			const seen = new Set<string>();
			for (const entry of [...configured.models, ...rpcModels]) {
				if (!seen.has(entry.id)) {
					seen.add(entry.id);
					mergedModels.push({ ...entry });
				}
			}
			const parsedModels = mergedModels.length > 0 ? mergedModels : (models !== undefined ? [] : undefined);
			const parsedCommands = commands !== undefined ? commandEntries(commands) : undefined;
			const value: EngineRuntimeCapabilities = {
				defaultModel: configured.defaultModel,
				models: parsedModels?.map(m => ({ ...m })),
				commands: parsedCommands?.map(c => ({ ...c })),
			};
			const ttl = (parsedModels && parsedModels.length > 0) || (parsedCommands && parsedCommands.length > 0) ? 15_000 : 2_000;
			this.capabilityCache.set(cwd, { expiresAt: Date.now() + ttl, value });
			return {
				defaultModel: value.defaultModel,
				models: value.models?.map(m => ({ ...m })),
				commands: value.commands?.map(c => ({ ...c })),
			};
		})();
		this.capabilityPending.set(cwd, load);
		try {
			return await load;
		} finally {
			this.capabilityPending.delete(cwd);
		}
	}

	private async readImages(attachments?: readonly EngineAttachment[]): Promise<Array<{ type: string; mimeType: string; data: string }>> {
		const images: Array<{ type: string; mimeType: string; data: string }> = [];
		for (const attachment of attachments ?? []) {
			const isImage = attachment.kind === 'image' || Boolean(attachment.mimeType?.startsWith('image/'));
			if (!isImage || attachment.remote) {
				continue;
			}
			try {
				const data = await fs.readFile(attachment.filePath);
				images.push({ type: 'image', mimeType: attachment.mimeType || 'image/png', data: data.toString('base64') });
			} catch { /* Skip attachments that cannot be read. */ }
		}
		return images;
	}

	private describeToolCall(packet: PiRpcPacket): string {
		const toolName = stringValue(packet.toolName) ?? this.name;
		const detail = toolDetail(packet.args);
		return detail ? `${toolName}: ${detail}` : toolName;
	}

	private async runSessionOrTransientRpc(
		session: NativeSession,
		commands: ReadonlyArray<Record<string, unknown>>,
		timeoutMs: number,
		token?: vscode.CancellationToken,
	): Promise<Array<Record<string, unknown> | undefined>> {
		const liveSlot = this.findLiveSlotForSession(session.id);
		if (liveSlot && !liveSlot.backendTurnActive && !liveSlot.activeTurn) {
			const out: Array<Record<string, unknown> | undefined> = [];
			for (const cmd of commands) {
				if (token?.isCancellationRequested) {
					out.push(undefined);
					continue;
				}
				const data = await this.sendSlotCommand(liveSlot, cmd, timeoutMs).catch(() => undefined);
				out.push(data);
			}
			return out;
		}
		return this.runRpc(session.cwd, this.sessionArgs(session), commands, timeoutMs, token);
	}

	private async compactSession(session: NativeSession, argsText: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
		if (session.provisional && !session.file && !this.findLiveSlotForSession(session.id)) {
			stream.markdown(vscode.l10n.t('This session has no messages to compact yet.'));
			return;
		}
		const customInstructions = argsText.trim();
		const [data] = await this.runSessionOrTransientRpc(session, [{ type: 'compact', ...(customInstructions ? { customInstructions } : {}) }], 90000, token);
		if (!data) {
			stream.markdown(vscode.l10n.t('Pi did not report a compaction summary. The conversation may still be compacted.'));
			return;
		}
		const summary = stringValue(data.summary) ?? stringValue(data.text) ?? stringValue(data.result);
		stream.markdown(summary
			? vscode.l10n.t('Compacted the conversation.\n\n{0}', summary)
			: vscode.l10n.t('Compacted the conversation to free up context.'));
	}

	private async showStats(session: NativeSession, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
		const [statsData, stateData] = await this.runSessionOrTransientRpc(session, [{ type: 'get_session_stats' }, { type: 'get_state' }], 20000, token);
		const stats = asRecord(statsData) ?? {};
		const state = asRecord(stateData) ?? {};
		const tokenTotals = asRecord(stats.tokens);
		const messages = stats.messageCount ?? stats.totalMessages ?? stats.message_count ?? (Array.isArray(stats.messages) ? stats.messages.length : undefined);
		const tokens = stats.totalTokens ?? stats.tokenCount ?? tokenTotals?.total;
		const cost = stats.cost ?? stats.totalCost;
		const model = modelName(state.model) ?? modelName(stats.model);
		const thinking = state.thinkingLevel ?? state.thinking;
		const autoCompaction = state.autoCompaction ?? state.autoCompactionEnabled;
		const costText = typeof cost === 'number' ? `$${cost.toFixed(4)}` : displayValue(cost);
		const rows = [
			`| ${vscode.l10n.t('Messages')} | ${displayValue(messages)} |`,
			`| ${vscode.l10n.t('Tokens')} | ${displayValue(tokens)} |`,
			`| ${vscode.l10n.t('Cost')} | ${costText} |`,
			`| ${vscode.l10n.t('Model')} | ${displayValue(model)} |`,
			`| ${vscode.l10n.t('Thinking level')} | ${displayValue(thinking)} |`,
			`| ${vscode.l10n.t('Auto compaction')} | ${displayValue(autoCompaction)} |`,
		];
		stream.markdown([`| ${vscode.l10n.t('Metric')} | ${vscode.l10n.t('Value')} |`, '| --- | --- |', ...rows].join('\n'));
	}

	private async showTree(session: NativeSession, fork: boolean, argsText: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
		const [forkData] = await this.runSessionOrTransientRpc(session, [{ type: 'get_fork_messages' }], 15000, token);
		const entries = forkEntries(forkData);
		if (entries.length === 0) {
			stream.markdown(vscode.l10n.t('This session has no messages to show yet.'));
			return;
		}
		if (!fork) {
			const lines = entries.map((entry, index) => entry.entryId
				? `${index + 1}. ${entry.text} (${entry.entryId})`
				: `${index + 1}. ${entry.text}`);
			stream.markdown([`### ${vscode.l10n.t('Conversation tree')}`, '', ...lines].join('\n'));
			return;
		}
		const requested = argsText.trim();
		const entryId = requested || [...entries].reverse().find(entry => entry.entryId)?.entryId;
		if (!entryId) {
			stream.markdown(vscode.l10n.t('There is no message to fork from yet.'));
			return;
		}
		const [forked] = await this.runSessionOrTransientRpc(session, [{ type: 'fork', entryId }], 30000, token);
		if (!forked) {
			stream.markdown(vscode.l10n.t('Pi could not fork the conversation at {0}.', entryId));
			return;
		}
		const newSession = stringValue(forked.sessionId) ?? stringValue(forked.newSessionId) ?? stringValue(forked.sessionFile) ?? stringValue(forked.file);
		stream.markdown(newSession
			? vscode.l10n.t('Forked the conversation into {0}.', newSession)
			: vscode.l10n.t('Forked the conversation.'));
	}

	async executeCommand(session: NativeSession, command: string, argsText: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, _options?: EngineSendOptions): Promise<boolean> {
		const name = command.trim().replace(/^\//, '').toLowerCase();
		if (!['compact', 'stats', 'cost', 'tree', 'fork', 'reload'].includes(name)) {
			return false;
		}
		if (token.isCancellationRequested) {
			return true;
		}
		switch (name) {
			case 'compact':
				await this.compactSession(session, argsText, stream, token);
				return true;
			case 'stats':
			case 'cost':
				await this.showStats(session, stream, token);
				return true;
			case 'tree':
				await this.showTree(session, false, argsText, stream, token);
				return true;
			case 'fork':
				await this.showTree(session, true, argsText, stream, token);
				return true;
			case 'reload': {
				await this.killSession(session);
				const [state] = await this.runRpc(session.cwd, this.sessionArgs(session), [{ type: 'get_state' }], 10000, token);
				stream.markdown(state
					? vscode.l10n.t('Reloaded Pi. Skills, extensions, and settings will be picked up by the next message.')
					: vscode.l10n.t('Restarted Pi, but the fresh worker did not report its state. The next message will retry the connection.'));
				return true;
			}
		}
		return false;
	}

	private async handleUiRequest(child: ReturnType<typeof spawnEngine>, packet: PiRpcPacket, session: NativeSession, token: vscode.CancellationToken, autoApprove: boolean, hasAdeIdentity = false): Promise<void> {
		if (!packet.id || child.stdin.destroyed) { return; }
		const respond = (payload: Record<string, unknown>) => {
			if (!child.stdin.destroyed) {
				child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: packet.id, ...payload }) + '\n');
			}
		};
		if (autoApprove) {
			if (packet.method === 'confirm') {
				respond({ confirmed: true });
			} else if (packet.method === 'select') {
				respond(packet.options && packet.options.length > 0 ? { value: packet.options[0] } : { cancelled: true });
			} else if (packet.method === 'input' || packet.method === 'editor') {
				respond(packet.prefill !== undefined ? { value: packet.prefill } : { cancelled: true });
			}
			return;
		}
		if (hasAdeIdentity && packet.method === 'confirm' && typeof packet.message === 'string' && isSafeAdeCliCommandInput(packet.message)) {
			respond({ confirmed: true });
			return;
		}
		const title = packet.title ? vscode.l10n.t('Pi — {0}', packet.title) : 'Pi';
		if (packet.method === 'select') {
			const picked = await vscode.window.showQuickPick(packet.options ?? [], {
				title,
				placeHolder: `${session.label} (${session.cwd})`,
				ignoreFocusOut: true,
			}, token);
			respond(picked !== undefined ? { value: picked } : { cancelled: true });
		} else if (packet.method === 'confirm') {
			const confirmLabel = vscode.l10n.t('Allow Once');
			const picked = await vscode.window.showQuickPick([confirmLabel, vscode.l10n.t('Deny')], {
				title,
				placeHolder: typeof packet.message === 'string' && packet.message ? `${session.cwd}: ${packet.message}` : session.cwd,
				ignoreFocusOut: true,
			}, token);
			respond(picked !== undefined ? { confirmed: picked === confirmLabel } : { cancelled: true });
		} else if (packet.method === 'input' || packet.method === 'editor') {
			const value = await vscode.window.showInputBox({
				title,
				prompt: packet.placeholder || `${session.label} (${session.cwd})`,
				value: packet.prefill,
				ignoreFocusOut: true,
			}, token);
			respond(value !== undefined ? { value } : { cancelled: true });
		}
	}

	async interruptTurn(session: NativeSession): Promise<void> {
		const liveSlot = this.findLiveSlotForSession(session.id);
		if (liveSlot) {
			if (liveSlot.steerHandoffSafetyTimer !== undefined) {
				return;
			}
			const settledCleanly = await this.abortSlotTurnAndWait(liveSlot, 2000);
			if (!settledCleanly && liveSlot.backendTurnActive && !liveSlot.dead) {
				stopEngineWithFallback(liveSlot.child, 'SIGINT', 1500, { killTree: false });
				this.destroyDaemonSlot(liveSlot.slotKey, 'SIGINT', false);
			}
			return;
		}
		const active = this.running.get(session.id);
		if (active) {
			for (const child of active) {
				if (!child.stdin.destroyed) {
					try { child.stdin.write(JSON.stringify({ type: 'abort', id: 'interrupt' }) + '\n'); } catch { /* ignore */ }
				}
				stopEngineWithFallback(child, 'SIGINT', 1500, { killTree: false });
			}
		}
		if (this.remoteTarget && this.remoteTarget.os !== 'windows') {
			const trackedIds = this.activePersistentIdsBySession.get(session.id);
			const prefix = buildRemotePersistentPrefix(this.id, session.id);
			const stops: Promise<void>[] = [
				terminateRemotePersistentSessionsByPrefix(this.remoteTarget, prefix, { killTree: false }),
			];
			if (trackedIds) {
				for (const pid of trackedIds) {
					if (!pid.startsWith(prefix)) {
						stops.push(terminateRemotePersistentSession(this.remoteTarget, pid, { killTree: false }));
					}
				}
			}
			await Promise.all(stops);
		}
	}

	async killSession(session: NativeSession): Promise<void> {
		for (const [slotKey, slot] of [...this.daemonSlots.entries()]) {
			if (slot.sessionId === session.id) {
				this.destroyDaemonSlot(slotKey, 'SIGKILL', true);
			}
		}
		this.sessionSlotKeys.delete(session.id);
		const active = this.running.get(session.id);
		if (active) {
			for (const child of active) {
				stopEngine(child, 'SIGKILL', { killTree: true });
			}
			this.running.delete(session.id);
		}
		if (this.remoteTarget && this.remoteTarget.os !== 'windows') {
			const trackedIds = this.activePersistentIdsBySession.get(session.id);
			this.activePersistentIdsBySession.delete(session.id);
			const prefix = buildRemotePersistentPrefix(this.id, session.id);
			const kills: Promise<void>[] = [
				terminateRemotePersistentSessionsByPrefix(this.remoteTarget, prefix, { killTree: true }),
			];
			if (trackedIds) {
				for (const pid of trackedIds) {
					if (!pid.startsWith(prefix)) {
						kills.push(terminateRemotePersistentSession(this.remoteTarget, pid, { killTree: true }));
					}
				}
			}
			await Promise.all(kills);
		}
	}

	private trackPersistentId(sessionId: string, persistentId: string | undefined): void {
		if (!persistentId) { return; }
		let set = this.activePersistentIdsBySession.get(sessionId);
		if (!set) {
			set = new Set();
			this.activePersistentIdsBySession.set(sessionId, set);
		}
		set.add(persistentId);
	}

	private untrackPersistentId(sessionId: string, persistentId: string | undefined): void {
		if (!persistentId) { return; }
		const set = this.activePersistentIdsBySession.get(sessionId);
		if (set) {
			set.delete(persistentId);
			if (set.size === 0) {
				this.activePersistentIdsBySession.delete(sessionId);
			}
		}
	}

	async reattachIfRunning(session: NativeSession, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<'reattached' | 'not_running'> {
		if (!this.remoteTarget || this.remoteTarget.os === 'windows' || token.isCancellationRequested) {
			return 'not_running';
		}
		const prefix = buildRemotePersistentPrefix(this.id, session.id);
		const candidates = await inspectRemotePersistentSessionsByPrefix(this.remoteTarget, prefix).catch(() => []);
		const liveOrUnread = candidates.find(c => c.alive || c.exitCode !== undefined);
		if (!liveOrUnread) {
			return 'not_running';
		}
		const customEnv = await prepareRemoteAgentChildEnv(this.remoteTarget, identityFromSendOptions(session.id, options));
		const remotePersistentId = liveOrUnread.id;
		this.trackPersistentId(session.id, remotePersistentId);
		let stdoutBytesReceived = 0;
		let sawAgentEnd = false;
		let sessionMissing = false;
		let turnError: string | undefined;
		let stderrText = '';
		const maxAttachAttempts = REMOTE_REATTACH_BACKOFFS_MS.length + 1;
		try {
			for (let attempt = 0; attempt < maxAttachAttempts; attempt++) {
				const child = spawnEngine(this.executable, [], session.cwd, customEnv, this.remoteTarget, {
					persistentSessionId: remotePersistentId,
					attachByteOffset: stdoutBytesReceived,
					attachOnly: true,
				});
				let sessionProcs = this.running.get(session.id);
				if (!sessionProcs) {
					sessionProcs = new Set();
					this.running.set(session.id, sessionProcs);
				}
				sessionProcs.add(child);
				const lineAcc = new LineByteAccumulator();
				child.stderr.on('data', data => stderrText = (stderrText + String(data)).slice(-8000));
				child.stdout.on('data', (chunk: Buffer | string) => {
					lineAcc.push(chunk, (line, rawBytes) => {
						stdoutBytesReceived += rawBytes;
						if (!line) { return; }
						let packet: PiRpcPacket;
						try { packet = JSON.parse(line) as PiRpcPacket; } catch { return; }
						if (packet.type === 'message_update' && packet.assistantMessageEvent && !token.isCancellationRequested) {
							const ev = packet.assistantMessageEvent;
							if (ev.type === 'text_delta' && typeof ev.delta === 'string' && ev.delta) {
								stream.markdown(ev.delta);
							} else if (ev.type === 'thinking_delta' && typeof ev.delta === 'string' && ev.delta) {
								emitThinkingProgress(stream, ev.delta, 'pi-thinking');
							}
						} else if (packet.type === 'agent_end' && Array.isArray(packet.messages)) {
							const lastMsg = packet.messages.at(-1);
							if (lastMsg?.stopReason === 'error' && lastMsg.errorMessage) {
								turnError = lastMsg.errorMessage;
							}
						} else if (packet.type === 'agent_settled') {
							sawAgentEnd = true;
							void terminateRemotePersistentSession(this.remoteTarget!, remotePersistentId, { killTree: false }).catch(() => undefined);
						}
					}, droppedBytes => {
						stdoutBytesReceived += droppedBytes;
					});
				});
				const stopChild = () => {
					stopEngineWithFallback(child, 'SIGTERM', 1500, { killTree: false });
					void terminateRemotePersistentSession(this.remoteTarget!, remotePersistentId, { killTree: false }).catch(() => undefined);
				};
				const cancelSub = token.onCancellationRequested(stopChild);
				let closeCode: number | null = null;
				try {
					await raceWithCancellation(new Promise<void>((resolve, reject) => {
						child.on('error', reject);
						child.on('close', code => {
							closeCode = code;
							if (code === 44 && !sawAgentEnd) {
								sessionMissing = true;
								resolve();
								return;
							}
							if (token.isCancellationRequested || sawAgentEnd || code === 0) {
								if (turnError && !token.isCancellationRequested) { reject(new Error(turnError)); } else { resolve(); }
								return;
							}
							if (code === 255 && attempt + 1 < maxAttachAttempts) {
								resolve();
								return;
							}
							reject(new Error(turnError || stderrText || vscode.l10n.t('Pi exited before finishing ({0}).', String(code))));
						});
					}), token, 2000, stopChild).catch(err => {
						if (token.isCancellationRequested || err instanceof vscode.CancellationError) {
							stopEngine(child, 'SIGKILL', { killTree: false });
							return;
						}
						throw err;
					});
				} finally {
					cancelSub.dispose();
					sessionProcs.delete(child);
					if (sessionProcs.size === 0) {
						this.running.delete(session.id);
					}
				}
				if (sawAgentEnd || token.isCancellationRequested || closeCode === 0 || closeCode === 44 || closeCode !== 255 || attempt + 1 >= maxAttachAttempts) {
					break;
				}
				const backoffMs = REMOTE_REATTACH_BACKOFFS_MS[attempt] ?? 60_000;
				stream.progress(vscode.l10n.t('SSH connection interrupted; reattaching to persistent remote Pi session…'));
				await waitForBackoffOrResume(backoffMs, token);
				if (token.isCancellationRequested) { break; }
				await healAllRemoteControlBridges().catch(() => undefined);
			}
		} finally {
			this.untrackPersistentId(session.id, remotePersistentId);
		}
		return sessionMissing ? 'not_running' : 'reattached';
	}

	async send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}
		if (!session.provisional && !session.file && !this.findLiveSlotForSession(session.id)) {
			session.file = (await this.list(token)).find(item => item.id === session.id)?.file;
		}
		if (token.isCancellationRequested) {
			return;
		}
		const requestedMode = options?.mode?.trim().toLowerCase();
		const toolMode: PiToolMode['id'] = requestedMode === 'readonly' || requestedMode === 'chat' ? requestedMode : 'full';
		const previousMode = this.toolModes.get(session.id);
		this.toolModes.set(session.id, toolMode);
		if (previousMode && previousMode !== toolMode) {
			for (const [slotKey, existingSlot] of [...this.daemonSlots.entries()]) {
				if (existingSlot.sessionId === session.id) {
					this.destroyDaemonSlot(slotKey, 'SIGKILL', false);
				}
			}
		}

		const trimmedReqModel = options?.model?.trim();
		const modelOption = trimmedReqModel && trimmedReqModel !== 'default' ? trimmedReqModel : undefined;
		let ensured = await this.ensureDaemonSlot(session, toolMode, modelOption, options);
		let slot = ensured.slot;
		let newlySpawned = ensured.newlySpawned;

		if (slot.steerHandoffSafetyTimer !== undefined) {
			clearTimeout(slot.steerHandoffSafetyTimer);
			slot.steerHandoffSafetyTimer = undefined;
		}

		const explicitModelReset = trimmedReqModel === 'default' && !arePiModelsEquivalent('default', slot.currentModel);
		const modelChanged = !newlySpawned && !arePiModelsEquivalent(options?.model, slot.currentModel);
		const wasActiveOnSlot = !newlySpawned && Boolean((slot.activeTurn && !slot.activeTurn.settled) || slot.backendTurnActive);

		// If the session already has an active turn and the model was hot-switched,
		// send `abort`, wait up to 2000ms for convergence & flush, then issue `set_model`!
		if (wasActiveOnSlot && modelChanged) {
			const prev = slot.activeTurn;
			if (prev && !prev.settled) {
				prev.steeredInPlace = true;
				prev.resolve();
				slot.activeTurn = undefined;
			}
			const settledCleanly = await this.abortSlotTurnAndWait(slot, 2000);
			if (!settledCleanly && slot.backendTurnActive && !slot.dead) {
				this.destroyDaemonSlot(slot.slotKey, 'SIGINT', false);
			}
			if (slot.dead || slot.disposed) {
				ensured = await this.ensureDaemonSlot(session, toolMode, modelOption, options);
				slot = ensured.slot;
				newlySpawned = ensured.newlySpawned;
			}
		} else if (wasActiveOnSlot && !modelChanged) {
			// Active turn with unchanged model: supersede prior JS waiter cleanly so we issue native `{"type":"steer"}`!
			const prev = slot.activeTurn;
			if (prev && !prev.settled) {
				prev.steeredInPlace = true;
				prev.resolve();
				slot.activeTurn = undefined;
			}
		}

		const shouldSteerInPlace = wasActiveOnSlot && !modelChanged && !newlySpawned && !slot.dead;

		const usageTracker = createTurnInterimUsageTracker(text, options?.onInterimUsage, {
			model: modelOption ?? slot.currentModel,
		});
		const stepUsageAccumulator = createMultiStepTurnUsageAccumulator();
		let currentStepSeq = 0;
		let promptDispatched = false;
		let activePiToolsCount = 0;
		let turnError: string | undefined;
		let segmentMarkdown = '';

		let settleResolve!: () => void;
		let settleReject!: (error: Error) => void;
		const settledPromise = new Promise<void>((resolve, reject) => {
			settleResolve = resolve;
			settleReject = reject;
		});
		void settledPromise.catch(() => { });

		const hasAdeIdentity = hasAdeEmployeeIdentity(options);
		const driver: PiActiveTurnDriver = {
			settled: false,
			steeredInPlace: false,
			settledPromise,
			cancellationToken: token,
			onStreamProgress: (msg: string) => {
				if (!token.isCancellationRequested && !driver.settled) {
					stream.progress(msg);
				}
			},
			onInStreamSteer: (steeredMessage: string, noticeMarkdown?: string) => {
				try { options?.onStreamActivity?.(); } catch { /* ignore */ }
				if (segmentMarkdown.trim()) {
					this.appendSyntheticHistory(session.id, { role: 'assistant', text: segmentMarkdown.trim() });
					segmentMarkdown = '';
				}
				this.appendSyntheticHistory(session.id, { role: 'user', text: steeredMessage });
				if (noticeMarkdown && !token.isCancellationRequested && !driver.settled) {
					stream.markdown(noticeMarkdown);
				}
			},
			resolve: () => {
				if (driver.settled) {
					return;
				}
				driver.settled = true;
				settleResolve();
			},
			reject: (error: Error) => {
				if (driver.settled) {
					return;
				}
				driver.settled = true;
				settleReject(error);
			},
			handlePacket: (packet: PiRpcPacket) => {
				if (driver.settled) {
					return;
				}
				try { options?.onStreamActivity?.(); } catch { /* ignore */ }

				if (packet.type === 'tool_execution_end') {
					if (activePiToolsCount > 0) {
						activePiToolsCount -= 1;
						try { options?.onExternalWaitEnd?.(); } catch { /* ignore */ }
					}
					const toolFailed = packet.isError === true
						|| packet.is_error === true
						|| packet.data?.isError === true
						|| packet.data?.is_error === true
						|| Boolean(packet.error)
						|| (typeof packet.exitCode === 'number' && packet.exitCode !== 0)
						|| (typeof packet.data?.exitCode === 'number' && packet.data.exitCode !== 0);
					if (toolFailed) {
						usageTracker.recordToolError();
						const currentUsage = this.lastTurnUsageBySession.get(session.id);
						if (currentUsage) {
							this.lastTurnUsageBySession.set(session.id, {
								...currentUsage,
								hadToolError: true,
								toolErrorCount: Math.max(currentUsage.toolErrorCount ?? 0, usageTracker.getToolErrorCount()),
							});
						}
					}
				}

				if (packet.type === 'message_start' || packet.type === 'tool_execution_end') {
					currentStepSeq++;
				}

				const messageObj = asRecord(packet.message);
				const packetUsage = extractPiTurnUsage(packet.usage ?? packet.tokens ?? packet.data?.usage ?? messageObj ?? packet.data);
				if (packetUsage && promptDispatched && packet.type !== 'agent_end') {
					const stepId = typeof messageObj?.id === 'string' && messageObj.id
						? messageObj.id
						: typeof messageObj?.timestamp === 'number' || typeof messageObj?.timestamp === 'string'
							? `ts:${String(messageObj.timestamp)}`
							: `step:${currentStepSeq}`;
					const aggregated = stepUsageAccumulator.recordStep(stepId, packetUsage);
					const normalized = usageTracker.recordRealUsage(aggregated, { cumulativeAcrossThread: false });
					this.lastRawSessionUsageBySession.set(session.id, aggregated);
					this.lastTurnUsageBySession.set(session.id, normalized);
				}

				if (packet.type === 'message_update' && !token.isCancellationRequested) {
					const ame = packet.assistantMessageEvent;
					if (ame?.type === 'text_delta' && typeof ame.delta === 'string' && ame.delta) {
						segmentMarkdown += ame.delta;
						stream.markdown(ame.delta);
						usageTracker.recordStreamDelta(ame.delta);
					} else if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string' && ame.delta) {
						emitThinkingProgress(stream, ame.delta, 'pi-thinking');
						usageTracker.recordStreamDelta(ame.delta, { skipToolErrorScan: true });
					} else if (ame?.type === 'toolcall_start' && typeof ame.toolName === 'string') {
						stream.progress(ame.toolName);
					}
				} else if (packet.type === 'tool_execution_start' && !token.isCancellationRequested) {
					activePiToolsCount += 1;
					try { options?.onExternalWaitStart?.(); } catch { /* ignore */ }
					stream.progress(this.describeToolCall(packet));
				} else if (packet.type === 'session_info_changed' && typeof packet.name === 'string' && packet.name.trim()) {
					session.label = packet.name.trim();
				} else if (packet.type === 'auto_compaction_start' || packet.type === 'auto_compaction_end' || packet.type === 'compaction' || packet.type === 'compact_boundary' || packet.type === 'context_compacted') {
					try {
						options?.onContextCompacted?.();
					} catch { /* Compaction callback must never break the turn. */ }
				} else if (packet.type === 'extension_ui_request') {
					const requestedPerm = options?.permissionMode?.trim();
					const explicitBypass = requestedPerm === 'bypassPermissions' || requestedPerm === 'auto' || requestedPerm === 'never' || requestedPerm === 'danger-full-access';
					const autoApprove = Boolean(options?.automatedEngineering)
						|| (requestedPerm !== 'ask' && requestedPerm !== 'manual' && (explicitBypass || isAutonomousModeEnabled()));
					const isAutoAdeConfirm = hasAdeIdentity && packet.method === 'confirm' && typeof packet.message === 'string' && isSafeAdeCliCommandInput(packet.message);
					const skipWait = autoApprove || isAutoAdeConfirm;
					if (!skipWait) {
						try { options?.onExternalWaitStart?.(); } catch { /* ignore */ }
					}
					void this.handleUiRequest(slot.child, packet, session, token, autoApprove, hasAdeIdentity)
						.catch(() => { })
						.finally(() => {
							if (!skipWait) {
								try { options?.onExternalWaitEnd?.(); } catch { /* ignore */ }
							}
						});
				} else if (packet.type === 'agent_end' && Array.isArray(packet.messages)) {
					if (promptDispatched) {
						let sumIn = 0;
						let sumOut = 0;
						let sumCacheRead = 0;
						let sumCacheWrite = 0;
						let sumTotal = 0;
						let sumCost = 0;
						let hasCost = false;
						let detectedModel: string | undefined;
						for (const msg of packet.messages) {
							if (msg.role !== 'assistant') {
								continue;
							}
							const msgUsage = extractPiTurnUsage(msg);
							if (msgUsage) {
								sumIn += msgUsage.inputTokens;
								sumOut += msgUsage.outputTokens;
								sumCacheRead += msgUsage.cacheReadTokens ?? 0;
								sumCacheWrite += msgUsage.cacheWriteTokens ?? 0;
								sumTotal += msgUsage.totalTokens;
								if (msgUsage.costUsd !== undefined) {
									sumCost += msgUsage.costUsd;
									hasCost = true;
								}
								if (msgUsage.model) {
									detectedModel = msgUsage.model;
								}
							}
						}
						if (sumTotal > 0) {
							const agg: EngineTurnTokenUsage = {
								inputTokens: sumIn,
								outputTokens: sumOut,
								cacheReadTokens: sumCacheRead,
								cacheWriteTokens: sumCacheWrite,
								totalTokens: sumTotal,
								...(hasCost ? { costUsd: Math.round(sumCost * 1_000_000) / 1_000_000 } : {}),
								...(detectedModel ? { model: detectedModel } : {}),
								estimated: false,
							};
							const normalized = usageTracker.recordRealUsage(agg, { cumulativeAcrossThread: false });
							this.lastRawSessionUsageBySession.set(session.id, agg);
							this.lastTurnUsageBySession.set(session.id, normalized);
						}
					}
					const lastMsg = packet.messages.at(-1);
					if (lastMsg?.stopReason === 'error' && lastMsg.errorMessage) {
						turnError = lastMsg.errorMessage;
					}
				} else if (packet.type === 'auto_retry_end' && packet.success === false && packet.finalError) {
					turnError = packet.finalError;
				} else if (packet.type === 'agent_settled') {
					session.provisional = false;
					if (segmentMarkdown.trim()) {
						this.appendSyntheticHistory(session.id, { role: 'assistant', text: segmentMarkdown.trim() });
						segmentMarkdown = '';
					}
					if (turnError && !token.isCancellationRequested) {
						driver.reject(new Error(turnError));
					} else {
						driver.resolve();
					}
				}
			},
		};

		let cancelTriggered = false;
		const triggerPiCancel = () => {
			if (cancelTriggered || driver.settled || driver.steeredInPlace) {
				return;
			}
			cancelTriggered = true;
			void (async () => {
				const settledCleanly = await this.abortSlotTurnAndWait(slot, 2000);
				if (!settledCleanly && slot.backendTurnActive && !slot.dead) {
					stopEngineWithFallback(slot.child, 'SIGTERM', 1000, { killTree: false });
					if (slot.remotePersistentId && this.remoteTarget) {
						void terminateRemotePersistentSession(this.remoteTarget, slot.remotePersistentId, { killTree: false }).catch(() => undefined);
					}
					this.destroyDaemonSlot(slot.slotKey, 'SIGTERM', false);
				}
				driver.resolve();
			})();
		};
		const cancellation = token.onCancellationRequested(triggerPiCancel);
		options?.abortSignal?.addEventListener('abort', triggerPiCancel, { once: true });

		try {
			if (token.isCancellationRequested) {
				return;
			}
			if (!shouldSteerInPlace) {
				if ((session.provisional || !session.file) && newlySpawned) {
					const state = await raceWithCancellation(
						this.sendSlotCommand<{ sessionFile?: string }>(slot, { type: 'get_state' }, 10_000),
						token,
					).catch(() => undefined);
					if (state && typeof state.sessionFile === 'string' && state.sessionFile) {
						session.file = state.sessionFile;
					}
				}
				if (token.isCancellationRequested) {
					return;
				}
				if (modelOption && (newlySpawned || modelChanged)) {
					await this.applySlotModel(slot, modelOption, token);
				} else if (explicitModelReset) {
					slot.currentModel = undefined;
				}
				const piLevel = piThinkingLevel(options?.thinking);
				if (piLevel && piLevel !== slot.currentThinkingLevel && !token.isCancellationRequested) {
					await raceWithCancellation(
						this.sendSlotCommand(slot, { type: 'set_thinking_level', level: piLevel }, 8_000),
						token,
					).catch(() => undefined);
					slot.currentThinkingLevel = piLevel;
				}
			}

			if (token.isCancellationRequested) {
				return;
			}
			const images = await this.readImages(options?.attachments);
			if (token.isCancellationRequested) {
				return;
			}

			slot.activeTurn = driver;
			slot.backendTurnActive = true;
			promptDispatched = true;
			this.appendSyntheticHistory(session.id, { role: 'user', text });

			if (shouldSteerInPlace) {
				const steerCmd = { type: 'steer', message: text, ...(images.length > 0 ? { images } : {}) };
				await raceWithCancellation(
					this.sendSlotCommand(slot, steerCmd, 20_000).catch(async () => {
						// Graceful fallback if the backend turn settled in the microsecond before `steer` arrived on stdin
						return this.sendSlotCommand(slot, { type: 'prompt', message: text, ...(images.length > 0 ? { images } : {}) }, 20_000);
					}),
					token,
					1500,
					triggerPiCancel,
				);
			} else {
				await raceWithCancellation(
					this.sendSlotCommand(slot, { type: 'prompt', message: text, ...(images.length > 0 ? { images } : {}) }, 20_000),
					token,
					1500,
					triggerPiCancel,
				);
			}

			if (token.isCancellationRequested) {
				triggerPiCancel();
			}
			const effectiveTimeoutMs = options?.timeoutMs ?? getConfiguredEngineTurnTimeoutMs();
			await raceWithCancellation(withTimeout(settledPromise, effectiveTimeoutMs), token, 1500, triggerPiCancel).catch(err => {
				if (driver.steeredInPlace || token.isCancellationRequested || options?.abortSignal?.aborted || err instanceof vscode.CancellationError) {
					return;
				}
				throw err;
			});

			if (!session.file && !token.isCancellationRequested && !driver.steeredInPlace && !slot.dead && !slot.backendTurnActive) {
				const state = await this.sendSlotCommand<{ sessionFile?: string }>(slot, { type: 'get_state' }, 5_000).catch(() => undefined);
				if (state && typeof state.sessionFile === 'string' && state.sessionFile) {
					session.file = state.sessionFile;
				}
			}
		} finally {
			while (activePiToolsCount > 0) {
				activePiToolsCount -= 1;
				try { options?.onExternalWaitEnd?.(); } catch { /* ignore */ }
			}
			options?.abortSignal?.removeEventListener('abort', triggerPiCancel);
			cancellation.dispose();
			if (slot.activeTurn === driver) {
				slot.activeTurn = undefined;
			}
			if (slot.dead && this.daemonSlots.has(slot.slotKey)) {
				this.destroyDaemonSlot(slot.slotKey, 'SIGKILL', false);
			}
		}
	}

	async delete(session: NativeSession, token: vscode.CancellationToken): Promise<void> {
		this.toolModes.delete(session.id);
		this.lastTurnUsageBySession.delete(session.id);
		this.lastRawSessionUsageBySession.delete(session.id);
		this.syntheticHistoryBySession.delete(session.id);
		for (const [slotKey, slot] of [...this.daemonSlots.entries()]) {
			if (slot.sessionId === session.id) {
				this.destroyDaemonSlot(slotKey, 'SIGTERM', true);
			}
		}
		this.sessionSlotKeys.delete(session.id);
		const active = this.running.get(session.id);
		if (active) {
			for (const child of active) { stopEngine(child); }
			this.running.delete(session.id);
		}
		const file = session.file ?? (!session.provisional ? (await this.list(token)).find(item => item.id === session.id)?.file : undefined);
		if (file) {
			if (this.remoteTarget) {
				await execRemoteShell(
					this.remoteTarget,
					`rm -f -- ${posixQuote(file)}`,
					`Remove-Item -LiteralPath ${psSingleQuote(file)} -Force -ErrorAction SilentlyContinue`,
					{ timeoutMs: 10_000, token },
				).catch(() => undefined);
			} else {
				await fs.rm(file, { force: true });
			}
		}
	}

	dispose(): void {
		for (const slotKey of [...this.daemonSlots.keys()]) {
			this.destroyDaemonSlot(slotKey, 'SIGTERM', true);
		}
		this.daemonSlots.clear();
		this.sessionSlotKeys.clear();
		for (const procs of this.running.values()) {
			for (const child of procs) { stopEngine(child); }
		}
		this.running.clear();
		if (this.remoteTarget && this.remoteTarget.os !== 'windows') {
			for (const set of this.activePersistentIdsBySession.values()) {
				for (const pid of set) {
					void terminateRemotePersistentSession(this.remoteTarget, pid, { killTree: true }).catch(() => undefined);
				}
			}
		}
		this.activePersistentIdsBySession.clear();
		this.lastTurnUsageBySession.clear();
		this.lastRawSessionUsageBySession.clear();
		this.syntheticHistoryBySession.clear();
	}
}
