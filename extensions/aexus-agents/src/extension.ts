/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	buildOptionGroupsForSession,
	discoverCustomizationFiles,
	discoverSlashCommands,
	readSkillOrCommandTemplate,
	registerRemoteCapabilitiesReader,
	SessionConfigState,
} from './capabilities';
import {
	buildRemotePersistentPrefix,
	clearCloudTransportCaches,
	CloudHostSshContext,
	CloudHostTarget,
	isCloudUri,
	isLegacyCloudBridgeCwd,
	normalizeCloudAuthority,
	normalizeCloudProjectUriString,
	normalizeRemoteCwdForCompare,
	notifySystemResume,
	parseCloudProjectUri,
	probeRemoteEngines,
	readRemoteTextFilesBatch,
	registerCloudTransportBridge,
	resolveCloudHostTarget,
	resolveRemoteRealpath,
	terminateRemotePersistentSessionsByPrefix,
	toRemoteNativePath,
} from './cloudTransport';
import { hasLocalClaudeTranscript } from './claude';
import { registerEngineeringDispatchBridge } from './extensionEngineeringDispatch';
import {
	buildMissingEngineMarkdown,
	buildMissingRemoteEngineMarkdown,
	definitions,
	ENGINE_ALIASES,
	EngineDefinition,
	extractAttachmentsAndRefs,
	formatMissingEngineMessage,
	formatMissingRemoteEngineMessage,
	formatRecordProjectLabel,
	parseAdeAgentResourceIds,
	parseOptionalUri,
	recordCloudAuthority,
	RecordEntry,
	recordProjectUri,
	remoteNativePathToCloudUri,
	resolveCliBinDir,
	resolveCompletedTurnUsage,
	resolveDefaultModeForEngine,
	resolveDefaultPermissionsForEngine,
	resolveDefaultSandboxForEngine,
	toEngineType,
	toSendOptions,
	toSessionOptionsRecord,
	toVsCodeOptionGroups,
	withSafeDefaultConfig,
} from './extensionSessionHelpers';
import { createSlashCommandHandlers } from './extensionSlashCommands';
import type { PiRuntime } from './pi';
import {
	EngineRuntime,
	EngineRuntimeCapabilities,
	findExecutable,
	getConfiguredEngineIdleStallTimeoutMs,
	getConfiguredEngineTurnTimeoutMs,
	HistoryEntry,
	isAutonomousModeEnabled,
	NativeSession,
	setCliBinDirectory,
} from './runtime';
import {
	formatTicketMessageDisplayMarkdown,
	isAdeTicketDeliveryMessage,
	parseTicketMessageEnvelope,
} from './ticketMessageFormat';
import { SessionTurnCoordinator } from './turnCoordinator';
import { createStreamToolErrorScanner, detectToolErrorInProgressText, detectToolErrorInStreamPart } from './usageTracker';

let flushPendingExtensionSaves: (() => Promise<void>) | undefined;

export async function deactivate(): Promise<void> {
	await flushPendingExtensionSaves?.();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	registerCloudTransportBridge({
		getCloudHostSshContext: async authority => Promise.resolve(
			vscode.commands.executeCommand<CloudHostSshContext | undefined>('aexus.ade.getCloudHostSshContext', authority),
		).catch(() => undefined),
		getConfiguredSshExecutable: () => vscode.workspace.getConfiguration('remote.SSH', null).get<string>('path')?.trim() || undefined,
		getConfiguredRemoteCliPaths: () => vscode.workspace.getConfiguration('aexus.ade', null).get<Record<string, Record<string, string>>>('remoteCliPaths', {}),
		createCancellationError: () => new vscode.CancellationError(),
	});
	registerRemoteCapabilitiesReader(readRemoteTextFilesBatch);
	const cliBinDir = await resolveCliBinDir(context.extensionPath);
	setCliBinDirectory(cliBinDir);

	const rawStoredRecords = context.globalState.get<Record<string, RecordEntry>>('nativeSessions', {});
	const records = new Map<string, RecordEntry>();
	for (const [storedKey, record] of Object.entries(rawStoredRecords)) {
		if (!record || typeof record !== 'object' || record.label === 'Secretary' && storedKey.includes('secretary')) {
			continue;
		}
		record.resourceId ??= record.id;
		const parsedIds = parseAdeAgentResourceIds(record.resourceId);
		if (parsedIds) {
			record.adeProjectId ??= parsedIds.projectId;
			record.adeAgentId ??= parsedIds.agentId;
			if (!record.provisional) {
				record.nativeId ??= record.id;
			}
		}
		delete record.preparingOrSending;
		if ((record.engine === 'codex' || record.engine === 'cline') && record.provisional === undefined && record.initialTitle && record.label === record.initialTitle) {
			record.provisional = true;
		}
		records.set(storedKey, record);
	}

	const runtimes = new Map<string, EngineRuntime>();
	const cloudRuntimes = new Map<string, { runtime: EngineRuntime; command: string; os: CloudHostTarget['os']; alias: string; authority: string }>();
	const runtimeCapsCache = new Map<string, EngineRuntimeCapabilities>();
	const runtimeCapsPending = new Map<string, Promise<{ caps: EngineRuntimeCapabilities; changed: boolean }>>();
	const runtimeCapsRefreshedAt = new Map<string, number>();
	const runtimeCapsGeneration = new Map<string, number>();
	const lastActiveCwdByType = new Map<string, string>();
	const PERSISTED_CAPS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
	const persistedCapsRaw = context.globalState.get<unknown>('runtimeCapsCache');
	if (persistedCapsRaw && typeof persistedCapsRaw === 'object' && !Array.isArray(persistedCapsRaw)) {
		const nowMs = Date.now();
		for (const [savedKey, savedCaps] of Object.entries(persistedCapsRaw as Record<string, EngineRuntimeCapabilities & { updatedAt?: number }>)) {
			if (!savedCaps || typeof savedCaps !== 'object') {
				continue;
			}
			if (typeof savedCaps.updatedAt === 'number' && nowMs - savedCaps.updatedAt > PERSISTED_CAPS_MAX_AGE_MS) {
				continue;
			}
			const wildcardKey = savedKey.endsWith(':*') ? savedKey : `${savedKey}:*`;
			runtimeCapsCache.set(wildcardKey, {
				defaultModel: typeof savedCaps.defaultModel === 'string' && savedCaps.defaultModel.trim() ? savedCaps.defaultModel.trim() : undefined,
				models: Array.isArray(savedCaps.models) ? savedCaps.models.map(m => ({ ...m })) : undefined,
				modes: Array.isArray(savedCaps.modes) ? savedCaps.modes.map(m => ({ ...m })) : undefined,
			});
		}
	}
	context.subscriptions.push({
		dispose: () => {
			for (const entry of cloudRuntimes.values()) {
				entry.runtime.dispose();
			}
			cloudRuntimes.clear();
		},
	});
	const disposeCloudRuntimesForAuthority = (authority?: string) => {
		const norm = authority ? normalizeCloudAuthority(authority) : undefined;
		for (const [poolKey, entry] of [...cloudRuntimes.entries()]) {
			if (!norm || entry.authority === norm) {
				entry.runtime.dispose();
				cloudRuntimes.delete(poolKey);
			}
		}
	};
	const clearCloudCapsCache = (authority?: string) => {
		const prefix = authority ? `cloud:${normalizeCloudAuthority(authority)}:` : 'cloud:';
		for (const k of [...runtimeCapsCache.keys()]) {
			if (k.startsWith(prefix)) {
				runtimeCapsCache.delete(k);
			}
		}
		for (const k of [...runtimeCapsRefreshedAt.keys()]) {
			if (k.startsWith(prefix)) {
				runtimeCapsRefreshedAt.delete(k);
			}
		}
	};

	const controllers = new Map<string, vscode.ChatSessionItemController>();
	const optionChangeEmitters = new Map<string, vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent>>();
	const providerOptionsChangeEmitters = new Map<string, vscode.EventEmitter<void>>();
	const inputStatesByType = new Map<string, Set<vscode.ChatSessionInputState>>();
	const customizationChangedEmitter = new vscode.EventEmitter<void>();
	context.subscriptions.push(customizationChangedEmitter);

	const turnCoordinator = new SessionTurnCoordinator<vscode.CancellationTokenSource>();
	const activeHeadlessTurnRef: { current?: (recordKey: string) => unknown } = {};
	const lastTurnReplies = new Map<string, string>();
	const lastTurnErrors = new Map<string, string>();
	const opened = new Map<string, { changed: vscode.EventEmitter<vscode.ChatSession['history']>; cancellation: vscode.CancellationTokenSource }>();
	const available: Array<EngineDefinition & { command: string | undefined }> = await Promise.all(
		definitions.map(async definition => ({ ...definition, command: await findExecutable(definition.executable) })),
	);

	const ensureEngineCommand = async (shortEngine: string): Promise<string | undefined> => {
		const entry = available.find(candidate => candidate.id === shortEngine);
		if (!entry) {
			return undefined;
		}
		if (entry.command) {
			return entry.command;
		}
		const discovered = await findExecutable(entry.executable);
		if (discovered) {
			entry.command = discovered;
		}
		return entry.command;
	};

	const refreshAvailableEngines = async (): Promise<void> => {
		await Promise.all(available.map(async entry => {
			const nextCmd = await findExecutable(entry.executable);
			if (entry.command !== nextCmd) {
				entry.command = nextCmd;
				const prevRuntime = runtimes.get(entry.id);
				if (prevRuntime) {
					prevRuntime.dispose();
					runtimes.delete(entry.id);
				}
			}
		}));
	};

	const CLI_MISSING_TOAST_COOLDOWN_MS = 15_000;
	const missingCliToastAtByEngine = new Map<string, number>();

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('aexus.ade.cliPaths') || event.affectsConfiguration('aexus.agentEngines')) {
			missingCliToastAtByEngine.clear();
			void refreshAvailableEngines();
		}
		if (event.affectsConfiguration('aexus.ade.remoteCliPaths') || event.affectsConfiguration('remote.SSH.path')) {
			missingCliToastAtByEngine.clear();
			clearCloudTransportCaches();
			disposeCloudRuntimesForAuthority();
			clearCloudCapsCache();
		}
		if (event.affectsConfiguration('aexus.ade.autonomousMode')) {
			for (const emitter of providerOptionsChangeEmitters.values()) {
				emitter.fire();
			}
		}
	}));

	const promptConfigureCliPaths = (message: string) => {
		const configureLabel = vscode.l10n.t('Configure CLI Paths…');
		void vscode.window.showWarningMessage(message, configureLabel).then(choice => {
			if (choice === configureLabel) {
				void vscode.commands.executeCommand('workbench.action.openSettings', 'aexus.ade.cliPaths');
			}
		});
	};

	const promptConfigureCloudHost = (message: string, hostAlias: string, isSshError: boolean) => {
		const actionLabel = isSshError
			? vscode.l10n.t('Manage Cloud Hosts…')
			: vscode.l10n.t('Configure Remote CLI Paths…');
		void vscode.window.showWarningMessage(message, actionLabel).then(choice => {
			if (choice === actionLabel) {
				if (isSshError) {
					void vscode.commands.executeCommand('workbench.action.aexusCloudHosts.manage', hostAlias);
				} else {
					void vscode.commands.executeCommand('workbench.action.openSettings', 'aexus.ade.remoteCliPaths');
				}
			}
		});
	};

	const notifyMissingEngineForTicket = (info: {
		readonly engineShort: string;
		readonly record: RecordEntry;
		readonly agentName: string;
		readonly ticketId?: string;
	}) => {
		const auth = recordCloudAuthority(info.record);
		const toastKey = auth ? `cloud:${auth}:${info.engineShort}` : `local:${info.engineShort}`;
		const now = Date.now();
		const lastAt = missingCliToastAtByEngine.get(toastKey) ?? 0;
		if (now - lastAt < CLI_MISSING_TOAST_COOLDOWN_MS) {
			return;
		}
		missingCliToastAtByEngine.set(toastKey, now);
		if (auth) {
			const parsedCloud = parseCloudProjectUri(info.record.cloudProjectUri);
			const hostLabel = parsedCloud?.authority || auth;
			const baseMsg = formatMissingRemoteEngineMessage(info.engineShort, hostLabel, available);
			const msg = info.ticketId
				? vscode.l10n.t('Ticket {0} for "{1}" is paused: {2}', info.ticketId, info.agentName, baseMsg)
				: baseMsg;
			promptConfigureCloudHost(msg, hostLabel, false);
			return;
		}
		const baseMsg = formatMissingEngineMessage(info.engineShort, available);
		const msg = info.ticketId
			? vscode.l10n.t('Ticket {0} for "{1}" is paused: {2}', info.ticketId, info.agentName, baseMsg)
			: baseMsg;
		promptConfigureCliPaths(msg);
	};

	const key = (engine: string, id: string) => `${engine}:${id}`;
	const identity = (record: RecordEntry) => key(record.engine, record.resourceId ?? record.id);
	const isRecordBusy = (record: RecordEntry) => turnCoordinator.isBusy(identity(record));
	const isRecordTurnActive = (record: RecordEntry): boolean => Boolean(
		record.preparingOrSending
		|| turnCoordinator.isBusy(identity(record))
		|| activeHeadlessTurnRef.current?.(identity(record)),
	);
	const syncRecordStorageKey = (record: RecordEntry, prevId: string) => {
		if (record.id === prevId) {
			return;
		}
		let oldMapKey: string | undefined;
		for (const [k, v] of records.entries()) {
			if (v === record) {
				oldMapKey = k;
				break;
			}
		}
		const nextPlainKey = key(record.engine, record.id);
		const cloudAuth = recordCloudAuthority(record);
		const nextMapKey = record.resourceId && record.resourceId.startsWith('ade-')
			? key(record.engine, record.resourceId)
			: (cloudAuth && ((records.has(nextPlainKey) && records.get(nextPlainKey) !== record) || oldMapKey?.startsWith('cloud:'))
				? `cloud:${cloudAuth}:${nextPlainKey}`
				: nextPlainKey);
		if (oldMapKey && oldMapKey !== nextMapKey) {
			records.delete(oldMapKey);
		} else if (nextMapKey !== key(record.engine, prevId)) {
			records.delete(key(record.engine, prevId));
		}
		records.set(nextMapKey, record);
	};
	const resource = (record: RecordEntry) => vscode.Uri.from({ scheme: `aexus-${record.engine}`, path: `/${record.resourceId ?? record.id}` });
	const parentResource = (record: RecordEntry) => record.parentId
		? resource([...records.values()].find(parent => parent.engine === record.engine && parent.id === record.parentId) ?? { ...record, id: record.parentId, resourceId: record.parentId })
		: undefined;
	const describe = (record: RecordEntry) => ({
		engineId: `aexus-${record.engine}`,
		resource: resource(record),
		parentResource: parentResource(record),
		projectUri: recordProjectUri(record),
		label: record.label,
		updated: record.updated,
		nativeId: record.id,
		provisional: Boolean(record.provisional),
	});

	const SAVE_DEBOUNCE_MS = 80;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let saveWaiters: Array<() => void> = [];
	let stateWriteRunning = false;
	let stateWriteDirty = false;
	let inFlightStateWrite: Promise<void> = Promise.resolve();
	let capsSaveTimer: ReturnType<typeof setTimeout> | undefined;
	let inFlightCapsWrite: Promise<void> = Promise.resolve();

	const writeStateNow = async (): Promise<void> => {
		const serialized: Record<string, RecordEntry> = {};
		for (const [k, rec] of records.entries()) {
			if (rec.preparingOrSending !== undefined) {
				const { preparingOrSending: _transient, ...rest } = rec;
				serialized[k] = rest;
			} else {
				serialized[k] = rec;
			}
		}
		await context.globalState.update('nativeSessions', serialized);
	};

	const pumpStateWrite = (): Promise<void> => {
		stateWriteDirty = true;
		if (stateWriteRunning) {
			return inFlightStateWrite;
		}
		stateWriteRunning = true;
		const run = (async () => {
			try {
				while (stateWriteDirty) {
					stateWriteDirty = false;
					try {
						await writeStateNow();
					} catch {
						// Keep serialized state writer healthy across transient storage errors.
					}
				}
			} finally {
				stateWriteRunning = false;
			}
		})();
		inFlightStateWrite = run;
		return run;
	};

	const triggerImmediateSave = (): Promise<void> => {
		if (saveTimer !== undefined) {
			clearTimeout(saveTimer);
			saveTimer = undefined;
		}
		const waiters = saveWaiters;
		saveWaiters = [];
		const writePromise = pumpStateWrite();
		if (waiters.length > 0) {
			void writePromise.finally(() => {
				for (const w of waiters) {
					w();
				}
			});
		}
		return writePromise;
	};

	const save = (): Promise<void> => new Promise<void>(resolve => {
		saveWaiters.push(resolve);
		if (saveTimer !== undefined) {
			return;
		}
		saveTimer = setTimeout(() => {
			saveTimer = undefined;
			const waiters = saveWaiters;
			saveWaiters = [];
			void pumpStateWrite().finally(() => {
				for (const w of waiters) {
					w();
				}
			});
		}, SAVE_DEBOUNCE_MS);
	});

	const writeRuntimeCapsNow = async (): Promise<void> => {
		const toSave: Record<string, EngineRuntimeCapabilities & { updatedAt: number }> = {};
		const nowMs = Date.now();
		for (const [cacheKey, val] of runtimeCapsCache.entries()) {
			if (!cacheKey.endsWith(':*')) {
				continue;
			}
			const persistedKey = cacheKey.startsWith('cloud:') ? cacheKey : cacheKey.slice(0, -2);
			if ((val.models && val.models.length > 0) || val.defaultModel || (val.modes && val.modes.length > 0)) {
				toSave[persistedKey] = {
					defaultModel: val.defaultModel,
					models: val.models?.map(m => ({ ...m })),
					modes: val.modes?.map(m => ({ ...m })),
					updatedAt: nowMs,
				};
			}
		}
		await context.globalState.update('runtimeCapsCache', toSave);
	};

	const enqueueCapsWrite = (): Promise<void> => {
		const next = inFlightCapsWrite.then(() => writeRuntimeCapsNow(), () => writeRuntimeCapsNow());
		inFlightCapsWrite = next.catch(() => undefined);
		return next;
	};

	const persistRuntimeCaps = (): void => {
		if (capsSaveTimer !== undefined) {
			return;
		}
		capsSaveTimer = setTimeout(() => {
			capsSaveTimer = undefined;
			void enqueueCapsWrite();
		}, 150);
	};

	const flushAllPendingSaves = async (): Promise<void> => {
		if (saveTimer !== undefined || stateWriteDirty) {
			void triggerImmediateSave().catch(() => undefined);
		}
		if (capsSaveTimer !== undefined) {
			clearTimeout(capsSaveTimer);
			capsSaveTimer = undefined;
			void enqueueCapsWrite();
		}
		await Promise.allSettled([inFlightStateWrite, inFlightCapsWrite]);
	};
	flushPendingExtensionSaves = flushAllPendingSaves;
	context.subscriptions.push({
		dispose: () => {
			void flushAllPendingSaves();
		},
	});

	const getSessionConfig = (record: RecordEntry): SessionConfigState => {
		record.sessionConfig ??= {};
		return record.sessionConfig;
	};

	const accept = (engine: string, session: NativeSession): RecordEntry => {
		const sessionKey = key(engine, session.id);
		const existing = records.get(sessionKey) ?? [...records.values()].find(record => record.engine === engine && record.id === session.id && !record.cloudProjectUri);
		if (existing) {
			const label = existing.customLabel ? existing.label : session.label;
			if (!existing.customLabel && session.label !== existing.initialTitle) { existing.initialTitle = undefined; }
			Object.assign(existing, session, { label, provisional: session.provisional ?? existing.provisional });
			return existing;
		}
		const record: RecordEntry = { ...session, engine, resourceId: session.id };
		records.set(sessionKey, record);
		return record;
	};

	const item = (record: RecordEntry): vscode.ChatSessionItem => {
		const result = controllers.get(record.engine)!.createChatSessionItem(resource(record), record.label);
		result.description = formatRecordProjectLabel(record);
		result.metadata = {
			workingDirectoryPath: record.cwd,
			...(record.cloudProjectUri ? { aexusProjectUri: record.cloudProjectUri } : {}),
			nativeSessionId: record.id,
			provisional: record.provisional ?? false,
			aexusParentSessionResource: parentResource(record)?.toString(),
			aexusSessionReadOnly: record.readOnly ?? false,
			...(record.adeProjectId ? { adeProjectId: record.adeProjectId } : {}),
			...(record.adeAgentId ? { adeAgentId: record.adeAgentId } : {}),
		};
		const recordBusy = isRecordBusy(record);
		result.timing = { created: record.created, lastRequestEnded: recordBusy ? undefined : record.updated };
		result.status = recordBusy ? vscode.ChatSessionStatus.InProgress : vscode.ChatSessionStatus.Completed;
		return result;
	};

	const refresh = (engine: string) => {
		const controller = controllers.get(engine);
		if (controller) {
			controller.items.replace([...records.values()].filter(record => record.engine === engine).map(item));
		}
	};

	const runtime = (engine: string): EngineRuntime => {
		const definition = available.find(entry => entry.id === engine);
		if (!definition?.command) {
			const msg = formatMissingEngineMessage(engine, available);
			promptConfigureCliPaths(msg);
			throw new Error(msg);
		}
		let result = runtimes.get(engine);
		if (!result) {
			result = definition.create(definition.command);
			runtimes.set(engine, result);
			context.subscriptions.push(result);
			if (result.onDidChangeSessions) {
				context.subscriptions.push(result.onDidChangeSessions(sessions => {
					const controller = controllers.get(engine);
					for (const session of sessions) {
						const record = accept(engine, session);
						if (controller) { controller.items.add(item(record)); }
						void publishHistory(record).catch(error => console.warn(error));
					}
					void save();
				}));
			}
		}
		return result;
	};

	const acceptCloud = (engine: string, session: NativeSession, target: CloudHostTarget, fallbackCloudUri?: string): RecordEntry => {
		const cloudKey = `cloud:${target.authority}:${key(engine, session.id)}`;
		const existingCloud = records.get(cloudKey)
			?? [...records.values()].find(record => record.engine === engine && record.id === session.id && recordCloudAuthority(record) === target.authority);
		const computedCloudUri = session.cwd?.trim()
			? remoteNativePathToCloudUri(target.alias, session.cwd, target.os)
			: fallbackCloudUri;
		if (existingCloud) {
			const label = existingCloud.customLabel ? existingCloud.label : session.label;
			if (!existingCloud.customLabel && session.label !== existingCloud.initialTitle) { existingCloud.initialTitle = undefined; }
			Object.assign(existingCloud, session, {
				label,
				provisional: session.provisional ?? existingCloud.provisional,
				cloudProjectUri: computedCloudUri ?? existingCloud.cloudProjectUri,
			});
			return existingCloud;
		}
		const localCollision = records.get(key(engine, session.id))
			?? [...records.values()].find(record => record.engine === engine && (record.resourceId === session.id || record.id === session.id) && !record.cloudProjectUri);
		const sessionKey = localCollision ? cloudKey : key(engine, session.id);
		const record: RecordEntry = {
			...session,
			engine,
			...(localCollision ? { resourceId: `cloud-${target.authority}-${session.id}` } : {}),
			cloudProjectUri: computedCloudUri,
		};
		records.set(sessionKey, record);
		return record;
	};

	const ensureRecordCloudReady = async (record: RecordEntry, forceRefresh = false): Promise<CloudHostTarget | undefined> => {
		if (!record.cloudProjectUri) {
			return undefined;
		}
		const parsed = parseCloudProjectUri(record.cloudProjectUri);
		if (!parsed) {
			return undefined;
		}
		const target = await resolveCloudHostTarget(parsed.authority, forceRefresh);
		const expectedRemoteCwd = toRemoteNativePath(parsed.path || '/', target.os, target.remoteHome);
		let mutated = false;
		if (isLegacyCloudBridgeCwd(record.cwd)) {
			record.cwd = expectedRemoteCwd;
			record.provisional = true;
			if (record.engine === 'codex' || record.engine === 'cline' || record.engine === 'dsh' || record.engine === 'antigravity' || record.engine === 'kilo' || record.engine === 'opencode') {
				record.unmaterialized = true;
			}
			record.file = undefined;
			mutated = true;
		} else if ((record.cwd.startsWith('~') || record.cwd.startsWith('/~')) && target.remoteHome) {
			record.cwd = expectedRemoteCwd;
			mutated = true;
		}
		if (mutated) {
			await save();
		}
		return target;
	};

	const resolveRemoteEngineInfo = async (
		shortEngine: string,
		target: CloudHostTarget,
		forceRefresh = false,
	): Promise<{ target: CloudHostTarget; command?: string; probeError?: string }> => {
		const probe = await probeRemoteEngines(target, forceRefresh);
		return {
			target: probe.target,
			command: probe.ok ? probe.executables[shortEngine] : undefined,
			probeError: probe.ok ? undefined : (probe.error || vscode.l10n.t('SSH connection failed')),
		};
	};

	const syncRecordCwdWithTarget = (record: RecordEntry, target: CloudHostTarget): void => {
		const parsed = parseCloudProjectUri(record.cloudProjectUri);
		if (!parsed) {
			return;
		}
		const nextRemoteCwd = toRemoteNativePath(parsed.path || '/', target.os, target.remoteHome);
		if (record.cwd !== nextRemoteCwd && (isLegacyCloudBridgeCwd(record.cwd) || record.cwd.startsWith('~') || record.cwd.startsWith('/~') || (target.os === 'windows' && record.cwd.startsWith('/')))) {
			record.cwd = nextRemoteCwd;
		}
	};

	const runtimeForCloud = (shortEngine: string, target: CloudHostTarget, command: string): EngineRuntime => {
		const definition = available.find(entry => entry.id === shortEngine);
		if (!definition) {
			throw new Error(`Unknown Coding Agent engine: ${shortEngine}`);
		}
		const poolKey = `${target.authority}::${shortEngine}`;
		const existing = cloudRuntimes.get(poolKey);
		if (existing && existing.command === command && existing.os === target.os && existing.alias === target.alias) {
			return existing.runtime;
		}
		if (existing) {
			existing.runtime.dispose();
			cloudRuntimes.delete(poolKey);
		}
		const created = definition.create(command, target);
		cloudRuntimes.set(poolKey, {
			runtime: created,
			command,
			os: target.os,
			alias: target.alias,
			authority: target.authority,
		});
		if (created.onDidChangeSessions) {
			context.subscriptions.push(created.onDidChangeSessions(sessions => {
				const controller = controllers.get(shortEngine);
				for (const session of sessions) {
					const record = acceptCloud(shortEngine, session, target);
					if (controller) { controller.items.add(item(record)); }
					void publishHistory(record).catch(error => console.warn(error));
				}
				void save();
			}));
		}
		return created;
	};

	const runtimeForRecord = async (record: RecordEntry, options?: { forceProbe?: boolean }): Promise<{ engine: EngineRuntime; remoteTarget?: CloudHostTarget }> => {
		if (!record.cloudProjectUri) {
			await ensureEngineCommand(record.engine);
			return { engine: runtime(record.engine) };
		}
		const target = await ensureRecordCloudReady(record, Boolean(options?.forceProbe));
		if (!target) {
			throw new Error(vscode.l10n.t('Invalid Cloud Project URI for this conversation.'));
		}
		const info = await resolveRemoteEngineInfo(record.engine, target, Boolean(options?.forceProbe));
		syncRecordCwdWithTarget(record, info.target);
		if (!info.command) {
			const msg = formatMissingRemoteEngineMessage(record.engine, info.target.alias, available, info.probeError);
			promptConfigureCloudHost(msg, info.target.alias, Boolean(info.probeError));
			throw new Error(msg);
		}
		return { engine: runtimeForCloud(record.engine, info.target, info.command), remoteTarget: info.target };
	};

	const tryRuntimeForRecord = async (record: RecordEntry): Promise<{ engine: EngineRuntime; remoteTarget?: CloudHostTarget } | undefined> => {
		if (!record.cloudProjectUri) {
			const cmd = await ensureEngineCommand(record.engine);
			if (!cmd) {
				return undefined;
			}
			return { engine: runtime(record.engine) };
		}
		const target = await ensureRecordCloudReady(record).catch(() => undefined);
		if (!target) {
			return undefined;
		}
		const info = await resolveRemoteEngineInfo(record.engine, target).catch(() => undefined);
		if (!info?.command) {
			return undefined;
		}
		syncRecordCwdWithTarget(record, info.target);
		return { engine: runtimeForCloud(record.engine, info.target, info.command), remoteTarget: info.target };
	};

	const notifyCloudProjectMutated = (cloudProjectUri: string | undefined) => {
		if (!cloudProjectUri) {
			return;
		}
		void Promise.resolve(vscode.commands.executeCommand('aexus.ade.cloudProjectDidMutate', cloudProjectUri)).catch(() => undefined);
	};

	const capsSignature = (c: EngineRuntimeCapabilities | undefined): string =>
		`${c?.defaultModel ?? ''}:${(c?.models ?? []).map(m => `${m.id}=${m.name}|${m.description ?? ''}`).join(',')}:${(c?.modes ?? []).map(m => `${m.id}=${m.name}|${m.description ?? ''}`).join(',')}:${(c?.commands ?? []).map(cmd => `${cmd.name}|${cmd.description ?? ''}`).join(',')}`;

	const mergeRuntimeCaps = (prev: EngineRuntimeCapabilities | undefined, next: EngineRuntimeCapabilities | undefined): EngineRuntimeCapabilities => ({
		defaultModel: next?.defaultModel?.trim() || prev?.defaultModel?.trim() || undefined,
		models: next?.models !== undefined
			? next.models.map(m => ({ ...m }))
			: (prev?.models !== undefined ? prev.models.map(m => ({ ...m })) : undefined),
		modes: next?.modes !== undefined
			? next.modes.map(m => ({ ...m }))
			: (prev?.modes !== undefined ? prev.modes.map(m => ({ ...m })) : undefined),
		commands: next?.commands !== undefined
			? next.commands.map(cmd => ({ ...cmd }))
			: (prev?.commands !== undefined ? prev.commands.map(cmd => ({ ...cmd })) : undefined),
	});

	const capsKeyFor = (shortEng: string, cwd: string, authority?: string): string =>
		authority ? `cloud:${normalizeCloudAuthority(authority)}:${shortEng}:${cwd}` : `${shortEng}:${cwd}`;

	const capsWildcardKeyFor = (shortEng: string, authority?: string): string =>
		authority ? `cloud:${normalizeCloudAuthority(authority)}:${shortEng}:*` : `${shortEng}:*`;

	const getCachedRuntimeCaps = (shortEng: string, cwd: string, authority?: string): EngineRuntimeCapabilities =>
		mergeRuntimeCaps(runtimeCapsCache.get(capsWildcardKeyFor(shortEng, authority)), runtimeCapsCache.get(capsKeyFor(shortEng, cwd, authority)));

	const commitRuntimeCaps = (shortEngine: string, cwd: string, incoming: EngineRuntimeCapabilities | undefined, authority?: string): { caps: EngineRuntimeCapabilities; changed: boolean } => {
		const cacheKey = capsKeyFor(shortEngine, cwd, authority);
		const wildcardKey = capsWildcardKeyFor(shortEngine, authority);
		const prevMerged = getCachedRuntimeCaps(shortEngine, cwd, authority);
		const prevSig = capsSignature(prevMerged);
		const mergedForCwd = mergeRuntimeCaps(runtimeCapsCache.get(cacheKey), incoming);
		const mergedWildcard = mergeRuntimeCaps(runtimeCapsCache.get(wildcardKey), incoming);
		runtimeCapsCache.set(cacheKey, mergedForCwd);
		runtimeCapsCache.set(wildcardKey, mergedWildcard);
		const effective = mergeRuntimeCaps(mergedWildcard, mergedForCwd);
		const nextSig = capsSignature(effective);
		const changed = nextSig !== prevSig;
		if (changed) {
			persistRuntimeCaps();
			const engineSessionType = `aexus-${shortEngine}`;
			providerOptionsChangeEmitters.get(engineSessionType)?.fire();
			const tracked = inputStatesByType.get(engineSessionType);
			if (tracked && tracked.size > 0) {
				void computeOptionGroupsForResource(engineSessionType).then(groups => {
					for (const inputState of tracked) {
						if (!inputState.sessionResource) {
							inputState.groups = groups;
						}
					}
				}).catch(() => undefined);
			}
		}
		return { caps: effective, changed };
	};

	const fetchRuntimeCaps = async (
		shortEngine: string,
		cwd: string,
		record?: RecordEntry,
		explicitRemoteTarget?: CloudHostTarget,
	): Promise<{ caps: EngineRuntimeCapabilities; changed: boolean }> => {
		const authority = explicitRemoteTarget?.authority ?? recordCloudAuthority(record);
		const cacheKey = capsKeyFor(shortEngine, cwd, authority);
		const existingPending = runtimeCapsPending.get(cacheKey);
		if (existingPending) {
			return existingPending;
		}
		const prev = getCachedRuntimeCaps(shortEngine, cwd, authority);
		if (!authority) {
			const cmd = await ensureEngineCommand(shortEngine);
			if (!cmd) {
				return { caps: prev, changed: false };
			}
		}
		const generation = (runtimeCapsGeneration.get(cacheKey) ?? 0) + 1;
		runtimeCapsGeneration.set(cacheKey, generation);
		const task = (async (): Promise<{ caps: EngineRuntimeCapabilities; changed: boolean }> => {
			try {
				let eng: EngineRuntime | undefined;
				if (record?.cloudProjectUri) {
					const resolved = await tryRuntimeForRecord(record);
					eng = resolved?.engine;
				} else if (explicitRemoteTarget) {
					const info = await resolveRemoteEngineInfo(shortEngine, explicitRemoteTarget).catch(() => undefined);
					if (info?.command) {
						eng = runtimeForCloud(shortEngine, info.target, info.command);
					}
				} else {
					eng = runtime(shortEngine);
				}
				if (eng?.getRuntimeCapabilities) {
					let settled = false;
					const probePromise = eng.getRuntimeCapabilities(cwd, record).then(lateCaps => {
						if (settled && runtimeCapsGeneration.get(cacheKey) === generation) {
							commitRuntimeCaps(shortEngine, cwd, lateCaps, authority);
						}
						return lateCaps;
					}).catch(() => undefined);
					let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
					const raced = await Promise.race([
						probePromise,
						new Promise<undefined>(resolve => {
							timeoutHandle = setTimeout(() => resolve(undefined), 12000);
						}),
					]).finally(() => {
						if (timeoutHandle !== undefined) {
							clearTimeout(timeoutHandle);
						}
					});
					settled = true;
					runtimeCapsRefreshedAt.set(cacheKey, Date.now());
					if (raced && runtimeCapsGeneration.get(cacheKey) === generation) {
						return commitRuntimeCaps(shortEngine, cwd, raced, authority);
					}
				}
			} catch { /* Fall back to cached runtime capabilities. */ }
			return { caps: getCachedRuntimeCaps(shortEngine, cwd, authority), changed: false };
		})().finally(() => {
			runtimeCapsPending.delete(cacheKey);
		});
		runtimeCapsPending.set(cacheKey, task);
		return task;
	};

	const list = async (engine: string, token: vscode.CancellationToken, projectCwd?: string): Promise<RecordEntry[]> => {
		for (const session of await runtime(engine).list(token, projectCwd)) {
			accept(engine, session);
		}
		refresh(engine);
		return [...records.values()].filter(record => record.engine === engine).sort((a, b) => b.updated - a.updated);
	};

	const defaultCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.scheme === 'file'
		? vscode.workspace.workspaceFolders[0].uri.fsPath
		: os.homedir();

	const findCachedRecord = (uri: vscode.Uri): RecordEntry | undefined => {
		const rawEngine = uri.scheme.startsWith('aexus-') ? uri.scheme.slice('aexus-'.length) : uri.scheme;
		const engine = ENGINE_ALIASES[rawEngine.toLowerCase()] ?? rawEngine;
		const id = uri.path.replace(/^\/+/, '');
		const direct = records.get(key(engine, id))
			?? [...records.values()].find(entry => entry.engine === engine && (entry.resourceId === id || entry.id === id));
		if (direct) {
			return direct;
		}
		const parsedAde = parseAdeAgentResourceIds(id);
		if (!parsedAde) {
			return undefined;
		}
		const migratedMatches = [...new Set(records.values())].filter(entry => {
			if (entry.adeProjectId && entry.adeAgentId) {
				return entry.adeProjectId === parsedAde.projectId && entry.adeAgentId === parsedAde.agentId;
			}
			const entryParsed = parseAdeAgentResourceIds(entry.resourceId ?? entry.id);
			return entryParsed?.projectId === parsedAde.projectId && entryParsed?.agentId === parsedAde.agentId;
		});
		return migratedMatches.length === 1 ? migratedMatches[0] : undefined;
	};

	const lastNotifiedOptionsSig = new Map<string, string>();

	const cleanupAndMigrateUnstartedRecordEngine = (record: RecordEntry, nextEngShort: string, fallbackResId?: string): string => {
		const oldEngine = record.engine;
		const oldIdentityKey = identity(record);
		const oldPlainKey = key(oldEngine, record.id);
		const oldResource = resource(record);
		for (const [k, v] of [...records.entries()]) {
			if (v === record) {
				records.delete(k);
			}
		}
		controllers.get(oldEngine)?.items.delete(oldResource);
		if (!turnCoordinator.isBusy(oldIdentityKey)) {
			const orphanOpened = opened.get(oldIdentityKey);
			if (orphanOpened) {
				orphanOpened.cancellation.cancel();
				orphanOpened.cancellation.dispose();
				orphanOpened.changed.dispose();
				opened.delete(oldIdentityKey);
			}
			lastTurnReplies.delete(oldIdentityKey);
			lastTurnErrors.delete(oldIdentityKey);
			lastTurnReplies.delete(oldPlainKey);
			lastTurnErrors.delete(oldPlainKey);
		}
		lastNotifiedOptionsSig.delete(oldResource.toString());
		record.id = randomUUID();
		record.engine = nextEngShort;
		record.provisional = true;
		record.nativeId = undefined;
		record.file = undefined;
		record.unmaterialized = true;
		record.initialTitle = undefined;
		const resId = fallbackResId
			?? record.resourceId
			?? (record.adeProjectId && record.adeAgentId ? `ade-${record.adeProjectId}-${record.adeAgentId}` : record.id);
		record.resourceId = resId;
		records.set(key(nextEngShort, resId), record);
		return oldEngine;
	};

	const teardownRecordRuntimeForSessionReset = async (snapshot: RecordEntry, previousHost?: string): Promise<void> => {
		const oldIdentityKey = identity(snapshot);
		if (!turnCoordinator.isBusy(oldIdentityKey)) {
			await turnCoordinator.forceRelease(oldIdentityKey).catch(() => undefined);
		}
		if (snapshot.cloudProjectUri) {
			const oldAuth = recordCloudAuthority(snapshot);
			const existingCloud = oldAuth ? cloudRuntimes.get(`${oldAuth}::${snapshot.engine}`)?.runtime : undefined;
			if (existingCloud) {
				await existingCloud.killSession?.(snapshot).catch(() => undefined);
			}
			const remoteAlias = oldAuth ?? (previousHost && previousHost !== 'local' ? previousHost : undefined);
			if (remoteAlias) {
				const target = await resolveCloudHostTarget(remoteAlias).catch(() => undefined);
				if (target && target.os !== 'windows') {
					await terminateRemotePersistentSessionsByPrefix(
						target,
						buildRemotePersistentPrefix(snapshot.engine, snapshot.id),
						{ killTree: true },
					).catch(() => undefined);
					if (snapshot.resourceId && snapshot.resourceId !== snapshot.id) {
						await terminateRemotePersistentSessionsByPrefix(
							target,
							buildRemotePersistentPrefix(snapshot.engine, snapshot.resourceId),
							{ killTree: true },
						).catch(() => undefined);
					}
				}
			}
			return;
		}
		const existingLocal = runtimes.get(snapshot.engine);
		if (existingLocal) {
			await existingLocal.killSession?.(snapshot).catch(() => undefined);
		}
	};

	const ensureEmployeeRecord = async (params: {
		readonly sessionUri: vscode.Uri;
		readonly engineShort: string;
		readonly workspaceCwdUri?: string;
		readonly label?: string;
		readonly projectId: string;
		readonly agentId: string;
		readonly host?: string;
		readonly model?: string;
		readonly effort?: string;
	}): Promise<RecordEntry> => {
		const resId = params.sessionUri.path.replace(/^\/+/, '') || `ade-${params.projectId}-${params.agentId}`;
		let record = findCachedRecord(params.sessionUri);
		const parsedCwdUri = parseOptionalUri(params.workspaceCwdUri);
		let cloudProjectUri: string | undefined;
		let resolvedCwd = defaultCwd();

		if (isCloudUri(parsedCwdUri)) {
			cloudProjectUri = normalizeCloudProjectUriString(parsedCwdUri);
			const target = await resolveCloudHostTarget(parsedCwdUri.authority).catch(() => undefined);
			resolvedCwd = toRemoteNativePath(parsedCwdUri.path || '/', target?.os ?? 'linux', target?.remoteHome);
		} else if (parsedCwdUri?.scheme === 'file') {
			resolvedCwd = parsedCwdUri.fsPath;
		}
		const inferredHost = params.host?.trim() || (cloudProjectUri ? recordCloudAuthority({ cloudProjectUri }) : 'local');

		if (!record) {
			const now = Date.now();
			record = {
				id: randomUUID(),
				resourceId: resId,
				engine: params.engineShort,
				cwd: resolvedCwd,
				label: params.label || params.agentId,
				customLabel: Boolean(params.label),
				created: now,
				updated: now,
				provisional: true,
				unmaterialized: true,
				...(cloudProjectUri ? { cloudProjectUri } : {}),
				adeProjectId: params.projectId,
				adeAgentId: params.agentId,
				...(inferredHost ? { adeHost: inferredHost } : {}),
				sessionConfig: {},
			};
			records.set(key(params.engineShort, resId), record);
		} else {
			record.adeProjectId = params.projectId;
			record.adeAgentId = params.agentId;
			if (!isRecordTurnActive(record)) {
				if (params.workspaceCwdUri) {
					record.cwd = resolvedCwd;
					record.cloudProjectUri = cloudProjectUri;
				}
				if (inferredHost) {
					record.adeHost = inferredHost;
				}
				if (record.engine !== params.engineShort && (record.provisional || !record.nativeId)) {
					cleanupAndMigrateUnstartedRecordEngine(record, params.engineShort, resId);
				}
			}
			if (params.label && (!record.customLabel || record.label !== params.label)) {
				record.label = params.label;
				record.customLabel = true;
			}
		}

		record.sessionConfig ??= {};
		if (params.model && params.model !== 'default') {
			record.sessionConfig.model = params.model;
		}
		if (params.effort && params.effort !== 'default') {
			record.sessionConfig.thinking = params.effort === 'none' ? 'off' : params.effort;
		}
		void triggerImmediateSave().catch(() => undefined);
		controllers.get(record.engine)?.items.add(item(record));
		return record;
	};

	const getRecord = async (uri: vscode.Uri, token: vscode.CancellationToken): Promise<RecordEntry> => {
		const engine = uri.scheme.slice('aexus-'.length);
		const id = uri.path.replace(/^\/+/, '');
		let record = findCachedRecord(uri);
		if (!record) {
			const parsedEmployee = parseAdeAgentResourceIds(id);
			if (parsedEmployee) {
				const meta = await Promise.resolve(
					vscode.commands.executeCommand<AdeResolvedEmployeeMeta | undefined>('aexus.ade.resolveEmployeeSessionMeta', parsedEmployee.projectId, parsedEmployee.agentId),
				).catch(() => undefined);
				record = await ensureEmployeeRecord({
					sessionUri: uri,
					engineShort: engine,
					workspaceCwdUri: meta?.workspaceCwdUri,
					label: meta?.name,
					projectId: parsedEmployee.projectId,
					agentId: parsedEmployee.agentId,
					host: meta?.host,
					model: meta?.model,
					effort: meta?.effort,
				});
				await applyResolvedEmployeeMetaToRecord(record, meta, uri);
				return record;
			}
			record = (await list(engine, token)).find(entry => entry.id === id || entry.resourceId === id);
		}
		if (!record) { throw new Error(vscode.l10n.t('This engine conversation is no longer available.')); }
		return record;
	};

	const collectSavedCustomModels = (shortEng: string, targetRecord?: RecordEntry): string[] => {
		const out: string[] = [];
		const seen = new Set<string>();
		const addCustom = (m?: string) => {
			const trimmed = m?.trim();
			if (trimmed && trimmed !== 'default' && !seen.has(trimmed)) {
				seen.add(trimmed);
				out.push(trimmed);
			}
		};
		if (targetRecord) {
			addCustom(targetRecord.sessionConfig?.model);
			return out;
		}
		for (const rec of records.values()) {
			if (rec.engine === shortEng) {
				addCustom(rec.sessionConfig?.model);
			}
		}
		return out;
	};

	const computeOptionGroupsForResource = async (sessionType: string, sessionUri?: vscode.Uri): Promise<vscode.ChatSessionProviderOptionGroup[]> => {
		const engineType = toEngineType(sessionType);
		const shortEng = engineType.slice('aexus-'.length);
		const rec = sessionUri ? findCachedRecord(sessionUri) : undefined;
		const authority = recordCloudAuthority(rec);
		const remoteTarget = rec?.cloudProjectUri ? await ensureRecordCloudReady(rec).catch(() => undefined) : undefined;
		const cwd = rec?.cwd ?? lastActiveCwdByType.get(engineType) ?? defaultCwd();
		const rawCaps = getCachedRuntimeCaps(shortEng, cwd, authority);
		const cfg = rec ? getSessionConfig(rec) : {};
		return toVsCodeOptionGroups(await buildOptionGroupsForSession(engineType, withSafeDefaultConfig(engineType, cfg), cwd, {
			...rawCaps,
			customModels: collectSavedCustomModels(shortEng, rec),
			remoteTarget,
		}), engineType);
	};

	const trackInputState = (sessionType: string, controller: vscode.ChatSessionItemController, groups: vscode.ChatSessionProviderOptionGroup[]): vscode.ChatSessionInputState => {
		const state = controller.createChatSessionInputState(groups);
		let set = inputStatesByType.get(sessionType);
		if (!set) {
			set = new Set();
			inputStatesByType.set(sessionType, set);
		}
		set.add(state);
		state.onDidDispose(() => set?.delete(state));
		return state;
	};

	const notifySessionOptionsUpdated = async (sessionType: string, sessionUri: vscode.Uri, refreshGroups = false) => {
		const groups = await computeOptionGroupsForResource(sessionType, sessionUri);
		const optionsMap = toSessionOptionsRecord(groups);
		const sig = `${sessionType}:${groups.map(g => `${g.id}=${g.selected?.id ?? ''}[${g.items.length}]`).join('|')}`;
		const resourceKey = sessionUri.toString();
		if (!refreshGroups && lastNotifiedOptionsSig.get(resourceKey) === sig) {
			return;
		}
		lastNotifiedOptionsSig.set(resourceKey, sig);
		if (refreshGroups) {
			providerOptionsChangeEmitters.get(sessionType)?.fire();
		}
		optionChangeEmitters.get(sessionType)?.fire({
			resource: sessionUri,
			updates: Object.entries(optionsMap).map(([optionId, value]) => ({ optionId, value })),
		});
		const tracked = inputStatesByType.get(sessionType);
		if (tracked) {
			for (const inputState of tracked) {
				if (!inputState.sessionResource || inputState.sessionResource.toString() === resourceKey) {
					inputState.groups = groups;
				}
			}
		}
	};

	const scheduleRuntimeCapsRefresh = (shortEng: string, cwd: string, record: RecordEntry | undefined, sessionType: string, sessionUri?: vscode.Uri, force = false): void => {
		const authority = recordCloudAuthority(record);
		const cacheKey = capsKeyFor(shortEng, cwd, authority);
		const cached = getCachedRuntimeCaps(shortEng, cwd, authority);
		const hasModels = Boolean(cached.models && cached.models.length > 0);
		const lastAt = runtimeCapsRefreshedAt.get(cacheKey) ?? 0;
		const cooldownMs = hasModels ? 30_000 : 5_000;
		const existingPending = runtimeCapsPending.get(cacheKey);
		if (existingPending) {
			void existingPending.then(({ changed }) => {
				if (!changed) {
					return;
				}
				if (sessionUri) {
					void notifySessionOptionsUpdated(sessionType, sessionUri, true);
				} else {
					providerOptionsChangeEmitters.get(sessionType)?.fire();
				}
			});
			return;
		}
		if (!force && (Date.now() - lastAt < cooldownMs)) {
			return;
		}
		void fetchRuntimeCaps(shortEng, cwd, record).then(({ changed }) => {
			if (!changed) {
				return;
			}
			if (sessionUri) {
				void notifySessionOptionsUpdated(sessionType, sessionUri, true);
			} else {
				providerOptionsChangeEmitters.get(sessionType)?.fire();
			}
			const engineSessionType = `aexus-${shortEng}`;
			if (sessionType !== engineSessionType) {
				providerOptionsChangeEmitters.get(engineSessionType)?.fire();
			}
		});
	};

	const applyOptionUpdates = async (
		sessionType: string,
		sessionUri: vscode.Uri,
		updates: ReadonlyArray<{ optionId: string; value: string | vscode.ChatSessionProviderOptionItem | undefined }>,
		syncToAde = true,
		fromUiPicker = false,
	): Promise<void> => {
		const record = findCachedRecord(sessionUri);
		if (!record) {
			return;
		}

		let anyChanged = false;
		const targetCfg = (record.sessionConfig ??= {});
		const engineType = toEngineType(record.engine);
		const autonomous = isAutonomousModeEnabled();
		const defaultModeForEngine = resolveDefaultModeForEngine(engineType, autonomous);
		const defaultPermissionsForEngine = resolveDefaultPermissionsForEngine(engineType, autonomous);
		const defaultSandboxForEngine = resolveDefaultSandboxForEngine(autonomous);

		for (const { optionId, value: rawValue } of updates) {
			const value = typeof rawValue === 'string' ? rawValue : rawValue?.id;
			switch (optionId) {
				case 'model': {
					const next = value || 'default';
					if ((targetCfg.model || 'default') !== next) {
						targetCfg.model = next;
						anyChanged = true;
					}
					break;
				}
				case 'thinking': {
					const next = value || 'default';
					if ((targetCfg.thinking || 'default') !== next) {
						targetCfg.thinking = next;
						anyChanged = true;
					}
					break;
				}
				case 'mode': {
					const next = value || defaultModeForEngine;
					const prev = targetCfg.mode && targetCfg.mode !== 'default' ? targetCfg.mode : defaultModeForEngine;
					if (prev !== next) {
						targetCfg.mode = next;
						anyChanged = true;
					}
					break;
				}
				case 'permissions': {
					const next = value || defaultPermissionsForEngine;
					const prev = targetCfg.permissionMode && targetCfg.permissionMode !== 'default' ? targetCfg.permissionMode : defaultPermissionsForEngine;
					if (prev !== next) {
						targetCfg.permissionMode = next;
						anyChanged = true;
					}
					break;
				}
				case 'sandbox': {
					const next = value || defaultSandboxForEngine;
					const prev = targetCfg.sandboxMode && targetCfg.sandboxMode !== 'default' ? targetCfg.sandboxMode : defaultSandboxForEngine;
					if (prev !== next) {
						targetCfg.sandboxMode = next;
						anyChanged = true;
					}
					break;
				}
				case 'webSearch': {
					const next = value || 'enabled';
					if ((targetCfg.webSearch || 'enabled') !== next) {
						targetCfg.webSearch = next;
						anyChanged = true;
					}
					break;
				}
			}
		}

		if (!anyChanged) {
			return;
		}

		await save();

		if (!fromUiPicker) {
			await notifySessionOptionsUpdated(sessionType, sessionUri, true);
		} else {
			providerOptionsChangeEmitters.get(sessionType)?.fire();
			const groups = await computeOptionGroupsForResource(sessionType, sessionUri);
			lastNotifiedOptionsSig.set(
				sessionUri.toString(),
				`${sessionType}:${groups.map(g => `${g.id}=${g.selected?.id ?? ''}[${g.items.length}]`).join('|')}`,
			);
		}

		if (syncToAde) {
			const cfg = record.sessionConfig ?? {};
			await Promise.resolve(vscode.commands.executeCommand('aexus.ade.syncSessionPreferences', {
				resource: sessionUri.toString(),
				projectId: record.adeProjectId,
				agentId: record.adeAgentId,
				model: cfg.model,
				thinking: cfg.thinking,
			})).catch(() => undefined);
		}
	};

	interface AdeResolvedEmployeeMeta {
		readonly agentId?: string;
		readonly name?: string;
		readonly host?: string;
		readonly engine?: string;
		readonly sessionStarted?: boolean;
		readonly sessionResource?: string;
		readonly workspaceCwdUri?: string;
		readonly model?: string;
		readonly effort?: string;
		readonly nativeSessionId?: string;
	}

	interface ApplyResolvedEmployeeMetaResult {
		readonly updated: boolean;
		readonly previousEngine?: string;
		readonly currentEngine: string;
	}

	const applyResolvedEmployeeMetaToRecord = async (
		record: RecordEntry,
		meta: AdeResolvedEmployeeMeta | undefined,
		sessionUriOverride?: vscode.Uri,
		deferSave = false,
	): Promise<ApplyResolvedEmployeeMetaResult> => {
		if (!meta) {
			return { updated: false, currentEngine: record.engine };
		}
		let itemChanged = false;
		let optionsChanged = false;
		let previousEngine: string | undefined;
		let didResetSession = false;
		const turnActive = isRecordTurnActive(record);

		const incomingNativeId = typeof meta.nativeSessionId === 'string' ? meta.nativeSessionId.trim() : '';
		const nextHost = typeof meta.host === 'string' && meta.host.trim() ? meta.host.trim() : undefined;
		let hasResolvedNextCwd = false;
		let nextCwd = record.cwd;
		let nextCloudUri = record.cloudProjectUri;

		if (!turnActive && meta.workspaceCwdUri) {
			const parsedCwdUri = parseOptionalUri(meta.workspaceCwdUri);
			if (isCloudUri(parsedCwdUri)) {
				nextCloudUri = normalizeCloudProjectUriString(parsedCwdUri);
				const target = await resolveCloudHostTarget(parsedCwdUri.authority).catch(() => undefined);
				nextCwd = toRemoteNativePath(parsedCwdUri.path || '/', target?.os ?? 'linux', target?.remoteHome);
				hasResolvedNextCwd = true;
			} else if (parsedCwdUri?.scheme === 'file') {
				nextCwd = parsedCwdUri.fsPath;
				nextCloudUri = undefined;
				hasResolvedNextCwd = true;
			}
		}

		let nextEngShort: string | undefined;
		if (!turnActive && meta.engine) {
			const rawEng = meta.engine.trim().toLowerCase();
			const cand = ENGINE_ALIASES[rawEng] ?? (rawEng.startsWith('aexus-') ? rawEng.slice('aexus-'.length) : rawEng);
			if (cand && definitions.some(d => d.id === cand)) {
				nextEngShort = cand;
			}
		}

		if (!turnActive) {
			const wasStartedOrMaterialized = !record.provisional
				|| record.unmaterialized === false
				|| Boolean(record.nativeId)
				|| Boolean(record.file);
			const cwdChanged = hasResolvedNextCwd && (record.cwd !== nextCwd || record.cloudProjectUri !== nextCloudUri);
			const hostChanged = Boolean(nextHost && record.adeHost && record.adeHost !== nextHost)
				|| Boolean(nextHost && !record.adeHost && ((nextHost === 'local') !== !record.cloudProjectUri));
			const engineChanged = Boolean(nextEngShort && record.engine !== nextEngShort);
			const backendResetToUnstarted = meta.sessionStarted === false && !incomingNativeId;
			const unlockedTargetSwitched = (cwdChanged || hostChanged || engineChanged)
				&& !incomingNativeId
				&& (meta.sessionStarted === false || record.provisional || !record.nativeId);

			if ((backendResetToUnstarted && (wasStartedOrMaterialized || cwdChanged || hostChanged || engineChanged)) || unlockedTargetSwitched) {
				const oldSnapshot: RecordEntry = { ...record };
				const oldHost = record.adeHost;
				const oldEngine = record.engine;
				const oldIdentityKey = identity(record);
				const oldPlainKey = key(oldEngine, record.id);
				const oldResource = resource(record);

				await teardownRecordRuntimeForSessionReset(oldSnapshot, oldHost);

				for (const [k, v] of [...records.entries()]) {
					if (v === record) {
						records.delete(k);
					}
				}
				lastTurnReplies.delete(oldIdentityKey);
				lastTurnErrors.delete(oldIdentityKey);
				lastTurnReplies.delete(oldPlainKey);
				lastTurnErrors.delete(oldPlainKey);
				lastNotifiedOptionsSig.delete(oldResource.toString());

				if (engineChanged && nextEngShort) {
					controllers.get(oldEngine)?.items.delete(oldResource);
					const orphanOpened = opened.get(oldIdentityKey);
					if (orphanOpened) {
						orphanOpened.cancellation.cancel();
						orphanOpened.cancellation.dispose();
						orphanOpened.changed.dispose();
						opened.delete(oldIdentityKey);
					}
					previousEngine = oldEngine;
					record.engine = nextEngShort;
				} else {
					opened.get(oldIdentityKey)?.changed.fire([]);
				}

				record.id = randomUUID();
				record.nativeId = undefined;
				record.file = undefined;
				record.provisional = true;
				record.unmaterialized = true;
				record.initialTitle = undefined;
				record.updated = Date.now();
				if (hasResolvedNextCwd) {
					record.cwd = nextCwd;
					record.cloudProjectUri = nextCloudUri;
				}
				if (nextHost) {
					record.adeHost = nextHost;
				} else if (hasResolvedNextCwd) {
					record.adeHost = nextCloudUri ? recordCloudAuthority({ cloudProjectUri: nextCloudUri }) : 'local';
				}
				const canonicalResId = record.adeProjectId && record.adeAgentId
					? `ade-${record.adeProjectId}-${record.adeAgentId}`
					: (record.resourceId ?? record.id);
				record.resourceId = canonicalResId;
				records.set(key(record.engine, canonicalResId), record);

				if (engineChanged && record.sessionConfig) {
					if (!meta.model || meta.model === 'default') {
						delete record.sessionConfig.model;
					}
					if (!meta.effort || meta.effort === 'default') {
						delete record.sessionConfig.thinking;
					}
					delete record.sessionConfig.mode;
					delete record.sessionConfig.permissionMode;
					delete record.sessionConfig.sandboxMode;
				}

				didResetSession = true;
				itemChanged = true;
				optionsChanged = true;
			} else {
				if (hasResolvedNextCwd && (record.cwd !== nextCwd || record.cloudProjectUri !== nextCloudUri)) {
					record.cwd = nextCwd;
					record.cloudProjectUri = nextCloudUri;
					itemChanged = true;
				}
				if (nextHost && record.adeHost !== nextHost) {
					record.adeHost = nextHost;
					itemChanged = true;
				}
				if (meta.sessionStarted === false && record.provisional && record.nativeId !== undefined) {
					record.nativeId = undefined;
					itemChanged = true;
				}
			}
		}

		if (!turnActive && incomingNativeId && meta.sessionStarted !== false && (record.provisional || !record.nativeId)) {
			if (record.id === incomingNativeId && record.provisional) {
				// Never flip a provisional record to false merely because meta.nativeSessionId echoed back its own placeholder UUID,
				// unless for local Claude Code a real non-empty .jsonl transcript file already exists on disk.
				if (record.engine === 'claude' && !record.cloudProjectUri && await hasLocalClaudeTranscript(incomingNativeId, record.cwd)) {
					record.nativeId = incomingNativeId;
					record.provisional = false;
					record.unmaterialized = false;
					itemChanged = true;
				}
			} else if (record.id !== incomingNativeId) {
				const prevId = record.id;
				record.id = incomingNativeId;
				record.nativeId = incomingNativeId;
				if (record.engine === 'claude' && !record.cloudProjectUri) {
					const hasTranscript = await hasLocalClaudeTranscript(incomingNativeId, record.cwd);
					record.provisional = !hasTranscript;
				} else {
					record.provisional = false;
				}
				record.unmaterialized = false;
				syncRecordStorageKey(record, prevId);
				itemChanged = true;
			} else if (!record.provisional && !record.nativeId) {
				record.nativeId = incomingNativeId;
				itemChanged = true;
			}
		}

		const trimmedName = meta.name?.trim();
		if (trimmedName && record.label !== trimmedName) {
			record.label = trimmedName;
			record.customLabel = true;
			record.initialTitle = undefined;
			itemChanged = true;
		}

		const cfg = (record.sessionConfig ??= {});
		if (meta.model && meta.model !== 'default' && cfg.model !== meta.model) {
			cfg.model = meta.model;
			optionsChanged = true;
		}
		if (meta.effort && meta.effort !== 'default') {
			const nextThinking = meta.effort === 'none' ? 'off' : meta.effort;
			if (cfg.thinking !== nextThinking) {
				cfg.thinking = nextThinking;
				optionsChanged = true;
			}
		}

		if (itemChanged || optionsChanged) {
			if (previousEngine && previousEngine !== record.engine) {
				refresh(previousEngine);
			}
			controllers.get(record.engine)?.items.add(item(record));
			if (didResetSession) {
				refresh(record.engine);
			}
			if (optionsChanged) {
				const targetUri = sessionUriOverride && sessionUriOverride.scheme === `aexus-${record.engine}`
					? sessionUriOverride
					: resource(record);
				await notifySessionOptionsUpdated(toEngineType(record.engine), targetUri, true);
			}
			if (!deferSave) {
				await triggerImmediateSave().catch(() => undefined);
			}
			return {
				updated: true,
				...(previousEngine ? { previousEngine } : {}),
				currentEngine: record.engine,
			};
		}
		return { updated: false, currentEngine: record.engine };
	};

	const syncEmployeeRecordFromControlCenter = async (record: RecordEntry, sessionUri?: vscode.Uri): Promise<void> => {
		record.resourceId ??= record.id;
		const parsed = parseAdeAgentResourceIds(record.resourceId);
		if (parsed) {
			record.adeProjectId ??= parsed.projectId;
			record.adeAgentId ??= parsed.agentId;
		}
		if (!record.adeProjectId || !record.adeAgentId) {
			return;
		}
		const meta = await Promise.resolve(
			vscode.commands.executeCommand<AdeResolvedEmployeeMeta | undefined>(
				'aexus.ade.resolveEmployeeSessionMeta',
				record.adeProjectId,
				record.adeAgentId,
			),
		).catch(() => undefined);
		await applyResolvedEmployeeMetaToRecord(record, meta, sessionUri);
	};

	const renderTurnPromptForChatHistory = (rawText: string): string => {
		const parsedTicket = parseTicketMessageEnvelope(rawText);
		return parsedTicket ? formatTicketMessageDisplayMarkdown(parsedTicket) : rawText;
	};

	const history = (turns: HistoryEntry[], participant: string): Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2> => turns.map(turn => turn.role === 'user'
		? new vscode.ChatRequestTurn2(renderTurnPromptForChatHistory(turn.text), undefined, [], participant, [], undefined, turn.id, undefined, undefined, turn.isSystemInitiated)
		: new vscode.ChatResponseTurn2([new vscode.ChatResponseMarkdownPart(turn.text)], {}, participant));

	const publishHistory = async (record: RecordEntry): Promise<void> => {
		const entry = opened.get(identity(record));
		if (entry && !isRecordBusy(record)) {
			const resolved = await tryRuntimeForRecord(record);
			if (resolved) {
				const turns = await resolved.engine.history(record, entry.cancellation.token);
				if (opened.get(identity(record)) === entry) {
					entry.changed.fire(history(turns, `aexus-${record.engine}`));
				}
			}
		}
	};

	const { handleDirectSlashCommand } = createSlashCommandHandlers({
		available,
		opened,
		identity,
		getSessionConfig,
		fetchRuntimeCaps,
		computeOptionGroupsForResource,
		applyOptionUpdates: (sessionType, sessionUri, updates) => applyOptionUpdates(sessionType, sessionUri, updates),
		runtimeForRecord,
		tryRuntimeForRecord,
		save,
	});

	const send = async (
		record: RecordEntry,
		sessionUri: vscode.Uri,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult> => {
		if (record.readOnly) { throw new Error(vscode.l10n.t('Continue this subagent from its parent conversation.')); }
		record.resourceId ??= record.id;
		const parsedResIds = parseAdeAgentResourceIds(record.resourceId);
		if (parsedResIds) {
			record.adeProjectId ??= parsedResIds.projectId;
			record.adeAgentId ??= parsedResIds.agentId;
		}
		const isAdeEmployee = Boolean(record.adeProjectId && record.adeAgentId);
		if (isAdeEmployee) {
			await syncEmployeeRecordFromControlCenter(record, sessionUri);
		}
		const recordKey = identity(record);
		const cloudTarget = record.cloudProjectUri
			? await ensureRecordCloudReady(record)
			: undefined;

		const parsedTicketEnv = parseTicketMessageEnvelope(request.prompt);
		const isTicketPayload = isAdeTicketDeliveryMessage(request.prompt);
		const trimmedPrompt = request.prompt.trim();
		let parsedCmd = !isTicketPayload ? request.command?.trim().toLowerCase() : undefined;
		let cmdArgText = trimmedPrompt;
		if (!isTicketPayload && !parsedCmd && /^\/[a-zA-Z][\w:-]*(?:\s|$)/.test(trimmedPrompt)) {
			const spaceIdx = trimmedPrompt.indexOf(' ');
			parsedCmd = (spaceIdx === -1 ? trimmedPrompt.slice(1) : trimmedPrompt.slice(1, spaceIdx)).toLowerCase();
			cmdArgText = spaceIdx === -1 ? '' : trimmedPrompt.slice(spaceIdx + 1).trim();
		}

		if (parsedCmd) {
			const handledDirectly = await handleDirectSlashCommand(parsedCmd, cmdArgText, record, sessionUri, stream, token, cloudTarget);
			if (handledDirectly) {
				return {};
			}
		}

		const interruptRecord = async () => {
			const resolved = await tryRuntimeForRecord(record).catch(() => undefined);
			if (resolved?.engine.interruptTurn) {
				await resolved.engine.interruptTurn(record).catch(() => undefined);
			}
		};
		const forceKillRecord = async () => {
			const resolved = await tryRuntimeForRecord(record).catch(() => undefined);
			if (resolved?.engine.killSession) {
				await resolved.engine.killSession(record).catch(() => undefined);
			}
		};
		const lease = await turnCoordinator.acquire({
			key: recordKey,
			source: isTicketPayload ? 'headless' : 'ui',
			createCts: () => new vscode.CancellationTokenSource(),
			externalToken: token,
			interruptActive: interruptRecord,
			forceKill: forceKillRecord,
			onPreempt: !isTicketPayload ? (_prev, reason) => {
				if (reason === 'headless') {
					stream.progress(vscode.l10n.t('Switching from background task to your message…'));
				} else if (reason === 'cancelled' || reason === 'interrupted') {
					stream.progress(vscode.l10n.t('Stopping previous response…'));
				}
			} : undefined,
			graceTimeoutMs: 2500,
			turnTimeoutMs: getConfiguredEngineTurnTimeoutMs(),
			idleStallTimeoutMs: getConfiguredEngineIdleStallTimeoutMs(),
			ticketId: parsedTicketEnv?.ticketId,
			taskId: parsedTicketEnv?.taskId,
		});
		if (!lease) {
			return {};
		}

		const turnCancellation = lease.cts;
		let link: vscode.Disposable | undefined;
		record.preparingOrSending = true;
		try {
			link = token.onCancellationRequested(() => turnCancellation.cancel());
			if (token.isCancellationRequested) {
				turnCancellation.cancel();
				return {};
			}
			controllers.get(record.engine)?.items.add(item(record));
			const engineType = toEngineType(record.engine);
			const cfg = getSessionConfig(record);
			const caps = getCachedRuntimeCaps(record.engine, record.cwd, cloudTarget?.authority);
			const discoveredCommands = await discoverSlashCommands(engineType, record.cwd, caps.commands, cloudTarget);

			// Zero hidden prompts: human chat messages (and Path A open-chat Ticket turns) pass verbatim!
			let effectiveUserPrompt: string;
			if (parsedCmd) {
				const matchedTemplateCmd = discoveredCommands.find(c => c.name.toLowerCase() === parsedCmd && c.filePath);
				const expandedTemplate = matchedTemplateCmd ? await readSkillOrCommandTemplate(matchedTemplateCmd, cmdArgText) : undefined;
				effectiveUserPrompt = expandedTemplate ?? `/${parsedCmd}${cmdArgText ? ` ${cmdArgText}` : ''}`;
			} else {
				effectiveUserPrompt = request.prompt;
			}

			const { attachments, fileLines } = extractAttachmentsAndRefs(request.references, cloudTarget);
			const barePromptToSend = fileLines.length
				? `${effectiveUserPrompt}\n\n${vscode.l10n.t('Attached files:')}\n${fileLines.join('\n')}`
				: effectiveUserPrompt;

			if (turnCancellation.token.isCancellationRequested) {
				return {};
			}

			let engine: EngineRuntime;
			if (cloudTarget) {
				const remoteInfo = await resolveRemoteEngineInfo(record.engine, cloudTarget);
				syncRecordCwdWithTarget(record, remoteInfo.target);
				if (!remoteInfo.command) {
					if (isAdeEmployee && record.adeProjectId && record.adeAgentId && !record.nativeId) {
						await Promise.resolve(
							vscode.commands.executeCommand('aexus.ade.rollbackUnstartedIfCliMissing', {
								projectId: record.adeProjectId,
								agentId: record.adeAgentId,
							}),
						).catch(() => undefined);
					}
					stream.markdown(buildMissingRemoteEngineMarkdown(record.engine, remoteInfo.target.alias, available, remoteInfo.probeError));
					promptConfigureCloudHost(
						formatMissingRemoteEngineMessage(record.engine, remoteInfo.target.alias, available, remoteInfo.probeError),
						remoteInfo.target.alias,
						Boolean(remoteInfo.probeError),
					);
					return {};
				}
				engine = runtimeForCloud(record.engine, remoteInfo.target, remoteInfo.command);
			} else {
				if (!await ensureEngineCommand(record.engine)) {
					if (isAdeEmployee && record.adeProjectId && record.adeAgentId && !record.nativeId) {
						await Promise.resolve(
							vscode.commands.executeCommand('aexus.ade.rollbackUnstartedIfCliMissing', {
								projectId: record.adeProjectId,
								agentId: record.adeAgentId,
							}),
						).catch(() => undefined);
					}
					stream.markdown(buildMissingEngineMarkdown(record.engine, available));
					promptConfigureCliPaths(formatMissingEngineMessage(record.engine, available));
					return {};
				}
				engine = runtime(record.engine);
			}

			const sendOptions = toSendOptions(cfg, {
				attachments,
				pureWorker: !isAdeEmployee,
				adeProjectId: record.adeProjectId,
				adeAgentId: record.adeAgentId,
				adeSessionResource: sessionUri.toString(),
				automatedEngineering: isAdeEmployee ? isAutonomousModeEnabled() : undefined,
				abortSignal: lease.abortSignal,
				timeoutMs: getConfiguredEngineTurnTimeoutMs(),
				onStreamActivity: () => lease.touchActivity(),
				onExternalWaitStart: () => lease.beginExternalWait(),
				onExternalWaitEnd: () => lease.endExternalWait(),
			});

			const wasUnstartedBeforeTurn = Boolean(record.provisional || record.unmaterialized);
			if (isAdeEmployee && record.adeProjectId && record.adeAgentId) {
				if (wasUnstartedBeforeTurn) {
					void Promise.resolve(
						vscode.commands.executeCommand(
							'aexus.ade.markAgentSessionStarting',
							record.adeProjectId,
							record.adeAgentId,
							sessionUri.toString(),
						),
					).catch(() => undefined);
				} else {
					record.nativeId = record.id;
					void Promise.resolve(
						vscode.commands.executeCommand(
							'aexus.ade.markAgentSessionStarted',
							record.adeProjectId,
							record.adeAgentId,
							record.id,
						),
					).catch(() => undefined);
				}
			}

			const prevId = record.id;
			if (engine.prepareSession) {
				await engine.prepareSession(record, sendOptions, turnCancellation.token);
				syncRecordStorageKey(record, prevId);
				await save();
			}
			if (turnCancellation.token.isCancellationRequested) {
				return {};
			}

			if (isAdeEmployee && record.adeProjectId && record.adeAgentId && wasUnstartedBeforeTurn && !record.unmaterialized && (!record.provisional || record.id !== prevId)) {
				record.nativeId = record.id;
				void Promise.resolve(
					vscode.commands.executeCommand(
						'aexus.ade.markAgentSessionStarted',
						record.adeProjectId,
						record.adeAgentId,
						record.id,
					),
				).catch(() => undefined);
			}

			let streamedMarkdown = '';
			let lastCloudRefreshSent = 0;
			const emitThrottledCloudRefresh = () => {
				if (!record.cloudProjectUri) {
					return;
				}
				const now = Date.now();
				if (now - lastCloudRefreshSent >= 4000) {
					lastCloudRefreshSent = now;
					notifyCloudProjectMutated(record.cloudProjectUri);
				}
			};
			const errorScanner = createStreamToolErrorScanner();
			const proxyTarget: vscode.ChatResponseStream = Object.create(null);
			const wrappedStream: vscode.ChatResponseStream = new Proxy(proxyTarget, {
				get(_dummy, prop) {
					if (prop === 'markdown') {
						return (value: string | vscode.MarkdownString) => {
							const chunkText = typeof value === 'string' ? value : value.value;
							if (chunkText) {
								errorScanner.scan(chunkText);
								streamedMarkdown += chunkText;
								lease.touchActivity();
							}
							stream.markdown(value);
						};
					}
					if (prop === 'progress') {
						return (value: string) => {
							detectToolErrorInProgressText(value);
							lease.touchActivity();
							emitThrottledCloudRefresh();
							stream.progress(value);
						};
					}
					if (prop === 'push') {
						return (part: vscode.ChatResponsePart) => {
							detectToolErrorInStreamPart(part);
							lease.touchActivity();
							stream.push(part);
						};
					}
					const val = Reflect.get(stream, prop, stream);
					return typeof val === 'function' ? val.bind(stream) : val;
				},
			});

			lastTurnErrors.delete(identity(record));
			const turnStartedAt = Date.now();
			const preSendId = record.id;
			await engine.send(record, barePromptToSend, wrappedStream, turnCancellation.token, sendOptions);
			syncRecordStorageKey(record, preSendId);
			record.provisional = false;
			record.unmaterialized = false;
			if (isAdeEmployee && record.adeProjectId && record.adeAgentId) {
				record.nativeId = record.id;
				void Promise.resolve(
					vscode.commands.executeCommand(
						'aexus.ade.markAgentSessionStarted',
						record.adeProjectId,
						record.adeAgentId,
						record.id,
					),
				).catch(() => undefined);
			}

			resolveCompletedTurnUsage(engine, record.id, barePromptToSend, streamedMarkdown, turnStartedAt);
			if (streamedMarkdown.trim()) {
				lastTurnReplies.set(identity(record), streamedMarkdown.trim());
			}
			record.updated = Date.now();
			if (!record.customLabel && record.initialTitle && record.label === record.initialTitle && !isTicketPayload) {
				record.label = effectiveUserPrompt.split('\n')[0].slice(0, 100) || record.label;
			}
			void fetchRuntimeCaps(record.engine, record.cwd, record).then(({ changed }) => {
				if (changed) {
					void notifySessionOptionsUpdated(engineType, sessionUri, true);
					customizationChangedEmitter.fire();
				}
			});
			return {};
		} catch (error) {
			if (token.isCancellationRequested || turnCancellation.token.isCancellationRequested || error instanceof vscode.CancellationError) { return {}; }
			const errText = error instanceof Error ? error.message : String(error);
			lastTurnErrors.set(identity(record), errText);
			throw error;
		} finally {
			record.preparingOrSending = false;
			lease.markSettling();
			link?.dispose();
			turnCancellation.dispose();
			turnCoordinator.release(lease);
			if (records.has(key(record.engine, record.id)) || [...records.values()].includes(record)) {
				controllers.get(record.engine)?.items.add(item(record));
			}
			notifyCloudProjectMutated(record.cloudProjectUri);
			await publishHistory(record).catch(() => undefined);
			await save();
		}
	};

	const registerCustomizationProviderForType = (sessionType: string, label: string, iconId?: string) => {
		const api = vscode.chat as typeof vscode.chat & {
			registerChatSessionCustomizationProvider?: (
				chatSessionType: string,
				metadata: vscode.ChatSessionCustomizationProviderMetadata,
				provider: vscode.ChatSessionCustomizationProvider,
			) => vscode.Disposable;
		};
		if (typeof api.registerChatSessionCustomizationProvider !== 'function') {
			return;
		}
		const mapCustomizationType = (rawType: string): vscode.ChatSessionCustomizationType => {
			switch (rawType) {
				case 'skill': return vscode.ChatSessionCustomizationType.Skill;
				case 'agent': return vscode.ChatSessionCustomizationType.Agent;
				case 'instructions': return vscode.ChatSessionCustomizationType.Instructions;
				case 'hook': return vscode.ChatSessionCustomizationType.Hook;
				case 'plugin': return vscode.ChatSessionCustomizationType.Plugins;
				default: return vscode.ChatSessionCustomizationType.Prompt;
			}
		};
		context.subscriptions.push(api.registerChatSessionCustomizationProvider(
			sessionType,
			{
				label,
				iconId,
				supportedTypes: [
					vscode.ChatSessionCustomizationType.Skill,
					vscode.ChatSessionCustomizationType.Prompt,
					vscode.ChatSessionCustomizationType.Agent,
					vscode.ChatSessionCustomizationType.Instructions,
					vscode.ChatSessionCustomizationType.Hook,
					vscode.ChatSessionCustomizationType.Plugins,
				],
			},
			{
				onDidChange: customizationChangedEmitter.event,
				provideChatSessionCustomizations: async (sessionResource, _token) => {
					const rec = findCachedRecord(sessionResource);
					const shortEng = rec?.engine ?? sessionType.slice('aexus-'.length);
					const effectiveEngineType = toEngineType(shortEng);
					const remoteTarget = rec?.cloudProjectUri ? await ensureRecordCloudReady(rec).catch(() => undefined) : undefined;
					const cwd = rec?.cwd ?? defaultCwd();
					const { caps } = await fetchRuntimeCaps(shortEng, cwd, rec);
					const files = await discoverCustomizationFiles(effectiveEngineType, cwd, caps.commands, remoteTarget);
					return files.map((entry): vscode.ChatSessionCustomizationItem => ({
						uri: entry.uriPath.startsWith('agent-builtin://') ? vscode.Uri.parse(entry.uriPath) : vscode.Uri.file(entry.uriPath),
						type: mapCustomizationType(entry.type),
						name: entry.name,
						description: entry.description,
						source: entry.source,
						userInvocable: entry.userInvocable ?? (entry.type === 'skill' || entry.type === 'prompt'),
					}));
				},
			},
		));
	};

	const engineeringBridge = registerEngineeringDispatchBridge({
		context,
		records,
		controllers,
		turnCoordinator,
		lastTurnReplies,
		lastTurnErrors,
		defaultCwd,
		key,
		identity,
		item,
		syncRecordStorageKey,
		findCachedRecord,
		ensureEmployeeRecord,
		runtimeForRecord,
		tryRuntimeForRecord,
		getCachedRuntimeCaps,
		fetchRuntimeCaps,
		notifyMissingEngineForTicket,
		notifyCloudProjectMutated,
		publishHistory,
		save,
	});
	activeHeadlessTurnRef.current = engineeringBridge.getActiveLiveTurn;

	for (const definition of available) {
		const participantId = definition.type;
		const optEmitter = new vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent>();
		const providerOptEmitter = new vscode.EventEmitter<void>();
		optionChangeEmitters.set(participantId, optEmitter);
		providerOptionsChangeEmitters.set(participantId, providerOptEmitter);
		context.subscriptions.push(optEmitter, providerOptEmitter);

		const participant = vscode.chat.createChatParticipant(participantId, async (request, chatContext, stream, token) => {
			if (!chatContext.chatSessionContext) { throw new Error(vscode.l10n.t('Open an ADE engine conversation first.')); }
			const uri = chatContext.chatSessionContext.chatSessionItem.resource;
			return send(await getRecord(uri, token), uri, request, stream, token);
		});
		participant.iconPath = definition.svgIcon
			? {
				light: vscode.Uri.joinPath(context.extensionUri, `resources/${definition.svgIcon}-light.svg`),
				dark: vscode.Uri.joinPath(context.extensionUri, `resources/${definition.svgIcon}-dark.svg`),
			}
			: new vscode.ThemeIcon(definition.themeIcon!);
		const controller = vscode.chat.createChatSessionItemController(definition.type, async () => refresh(definition.id));
		controllers.set(definition.id, controller);
		controller.getChatSessionInputState = async sessionResource => {
			const rec = sessionResource ? findCachedRecord(sessionResource) : undefined;
			const cwd = rec?.cwd ?? lastActiveCwdByType.get(definition.type) ?? defaultCwd();
			scheduleRuntimeCapsRefresh(definition.id, cwd, rec, definition.type, sessionResource);
			const groups = await computeOptionGroupsForResource(definition.type, sessionResource);
			return trackInputState(definition.type, controller, groups);
		};
		registerCustomizationProviderForType(definition.type, definition.name, definition.themeIcon);

		context.subscriptions.push(participant, controller, vscode.chat.registerChatSessionContentProvider(definition.type, {
			onDidChangeChatSessionOptions: optEmitter.event,
			onDidChangeChatSessionProviderOptions: providerOptEmitter.event,
			provideChatSessionProviderOptions: async () => {
				const cwd = lastActiveCwdByType.get(definition.type) ?? defaultCwd();
				const sampleRec = [...records.values()].find(r => r.engine === definition.id && !r.cloudProjectUri && !r.unmaterialized && !r.provisional)
					?? [...records.values()].find(r => r.engine === definition.id && !r.cloudProjectUri);
				scheduleRuntimeCapsRefresh(definition.id, cwd, sampleRec, definition.type);
				const groups = await computeOptionGroupsForResource(definition.type);
				return {
					optionGroups: groups,
					newSessionOptions: toSessionOptionsRecord(groups),
				};
			},
			provideHandleOptionsChange: (uri, updates) => {
				void applyOptionUpdates(definition.type, uri, updates, true, true);
			},
			provideChatSessionContent: async (uri, token) => {
				const record = await getRecord(uri, token);
				await syncEmployeeRecordFromControlCenter(record, uri);
				if (record.cloudProjectUri) {
					await ensureRecordCloudReady(record).catch(() => undefined);
				} else {
					lastActiveCwdByType.set(definition.type, record.cwd);
				}
				const skipUnstartedAdeHistory = Boolean(record.provisional && !record.file && record.adeProjectId && record.adeAgentId);
				const resolved = skipUnstartedAdeHistory ? undefined : await tryRuntimeForRecord(record);
				const liveTurnBefore = engineeringBridge.getActiveLiveTurn(identity(record));
				let turns = resolved
					? await resolved.engine.history(record, token).catch(() => [] as HistoryEntry[])
					: [];
				void triggerImmediateSave().catch(() => undefined);
				scheduleRuntimeCapsRefresh(record.engine, record.cwd, record, definition.type, uri, true);
				const groups = await computeOptionGroupsForResource(definition.type, uri);
				const entry = { changed: new vscode.EventEmitter<vscode.ChatSession['history']>(), cancellation: new vscode.CancellationTokenSource() };
				opened.set(identity(record), entry);

				const liveTurn = engineeringBridge.getActiveLiveTurn(identity(record));
				if (liveTurnBefore && !liveTurn && resolved) {
					turns = await resolved.engine.history(record, token).catch(() => turns);
				}
				let effectiveTurns = turns;
				if (liveTurn) {
					let lastMatchingUserIdx = -1;
					for (let i = turns.length - 1; i >= 0; i--) {
						if (turns[i].role === 'user') {
							if (turns[i].text === liveTurn.requestPrompt) {
								lastMatchingUserIdx = i;
							}
							break;
						}
					}
					if (lastMatchingUserIdx >= 0) {
						// Exclude partial assistant output persisted mid-flight so activeResponseCallback replays bufferedParts without duplication.
						effectiveTurns = turns.slice(0, lastMatchingUserIdx + 1);
					}
				}
				const historyItems = history(effectiveTurns, participantId);
				if (liveTurn) {
					const lastUserTurn = [...effectiveTurns].reverse().find(t => t.role === 'user');
					if (!lastUserTurn || lastUserTurn.text !== liveTurn.requestPrompt) {
						historyItems.push(
							new vscode.ChatRequestTurn2(
								renderTurnPromptForChatHistory(liveTurn.requestPrompt),
								undefined,
								[],
								participantId,
								[],
								undefined,
								liveTurn.requestId,
								undefined,
								undefined,
								false,
							),
						);
					}
				}

				const providedSession: vscode.ChatSession & { readonly interruptActiveResponse?: () => Promise<void> } = {
					title: record.label,
					options: toSessionOptionsRecord(groups),
					history: historyItems,
					onDidChangeHistory: entry.changed.event,
					...(liveTurn ? {
						activeResponseCallback: (stream, attachToken) => liveTurn.attach(stream, attachToken),
						interruptActiveResponse: () => liveTurn.interrupt(),
					} : {}),
					requestHandler: record.readOnly ? undefined : (request, _chatContext, stream, reqToken) => send(record, uri, request, stream, reqToken),
					dispose: () => {
						entry.cancellation.cancel();
						entry.cancellation.dispose();
						entry.changed.dispose();
						if (opened.get(identity(record)) === entry) { opened.delete(identity(record)); }
					},
				};
				return providedSession;
			},
		}, participant, { supportsInterruptions: true }));
		refresh(definition.id);
	}

	if (available.some(entry => entry.id === 'antigravity' && entry.command) && !(runtimeCapsCache.get('antigravity:*')?.models?.length)) {
		scheduleRuntimeCapsRefresh('antigravity', defaultCwd(), undefined, 'aexus-antigravity', undefined, true);
	}

	context.subscriptions.push(vscode.commands.registerCommand('aexus.agents.selectCustomModel', async (firstArg?: unknown, secondArg?: unknown) => {
		const sessionUri = firstArg instanceof vscode.Uri
			? firstArg
			: (firstArg && typeof firstArg === 'object' && Object.hasOwn(firstArg, 'sessionResource') && (firstArg as { sessionResource?: unknown }).sessionResource instanceof vscode.Uri
				? (firstArg as { sessionResource: vscode.Uri }).sessionResource
				: undefined);
		const fallbackType = typeof firstArg === 'string' ? firstArg : typeof secondArg === 'string' ? secondArg : 'aexus-claude';
		if (!sessionUri) {
			return;
		}
		const sessionType = toEngineType(sessionUri.scheme || fallbackType);
		const rec = findCachedRecord(sessionUri);
		const currentCfg = rec ? getSessionConfig(rec) : undefined;
		const entered = await vscode.window.showInputBox({
			title: vscode.l10n.t('Enter Custom Model ID'),
			prompt: vscode.l10n.t('Enter the exact model identifier supported by the active Coding Agent engine (leave "default" to use engine default)'),
			value: currentCfg?.model && currentCfg.model !== 'default' ? currentCfg.model : '',
			placeHolder: vscode.l10n.t('e.g. sonnet, gpt-5, deepseek-reasoner'),
			ignoreFocusOut: true,
		});
		if (entered === undefined) {
			return;
		}
		const normalized = entered.trim() || 'default';
		await applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'model', value: normalized }], true, false);
	}));

	const deleteRecordAndDescendants = async (record: RecordEntry, token: vscode.CancellationToken, deletedKeys: Set<string>): Promise<number> => {
		const recordKey = key(record.engine, record.id);
		if (deletedKeys.has(recordKey)) {
			return 0;
		}
		await turnCoordinator.forceRelease(identity(record));
		opened.get(identity(record))?.cancellation.cancel();
		const rootResolved = await tryRuntimeForRecord(record).catch(() => undefined);
		if (rootResolved) {
			await rootResolved.engine.killSession?.(record).catch(() => { });
			await rootResolved.engine.delete(record, token).catch(() => { });
		}
		const removedIds = new Set<string>([record.id]);
		if (record.resourceId) { removedIds.add(record.resourceId); }
		let expanded = true;
		while (expanded) {
			expanded = false;
			for (const candidate of records.values()) {
				if (candidate.engine === record.engine && candidate.parentId && removedIds.has(candidate.parentId) && !removedIds.has(candidate.id)) {
					removedIds.add(candidate.id);
					if (candidate.resourceId) { removedIds.add(candidate.resourceId); }
					expanded = true;
				}
			}
		}
		let count = 0;
		const controller = controllers.get(record.engine);
		for (const [entryKey, candidate] of [...records.entries()]) {
			if (candidate.engine === record.engine && (removedIds.has(candidate.id) || (candidate.resourceId && removedIds.has(candidate.resourceId)))) {
				deletedKeys.add(entryKey);
				const candIdKey = identity(candidate);
				await turnCoordinator.forceRelease(candIdKey);
				opened.get(candIdKey)?.cancellation.cancel();
				lastTurnReplies.delete(candIdKey);
				lastTurnErrors.delete(candIdKey);
				lastTurnReplies.delete(key(candidate.engine, candidate.id));
				lastTurnErrors.delete(key(candidate.engine, candidate.id));
				const candUriStr = resource(candidate).toString();
				lastNotifiedOptionsSig.delete(candUriStr);
				if (candidate !== record) {
					const childResolved = await tryRuntimeForRecord(candidate).catch(() => undefined);
					if (childResolved) {
						await childResolved.engine.killSession?.(candidate).catch(() => { });
						await childResolved.engine.delete(candidate, token).catch(() => { });
					}
				}
				records.delete(entryKey);
				controller?.items.delete(resource(candidate));
				count++;
			}
		}
		return count;
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('aexus.ade.syncCachedEmployeeMeta', async (rawPayload?: unknown) => {
			if (!rawPayload || typeof rawPayload !== 'object') {
				return { synced: 0, updated: false, migrations: [] };
			}
			const payload = rawPayload as {
				projectId?: unknown;
				agents?: unknown;
			};
			const projectId = typeof payload.projectId === 'string' ? payload.projectId.trim() : '';
			const agentsList = Array.isArray(payload.agents) ? (payload.agents as AdeResolvedEmployeeMeta[]) : [];
			if (!projectId || agentsList.length === 0) {
				return { synced: 0, updated: false, migrations: [] };
			}
			const metaByAgentId = new Map<string, AdeResolvedEmployeeMeta>();
			for (const entry of agentsList) {
				const agId = typeof entry?.agentId === 'string' ? entry.agentId.trim() : '';
				if (agId) {
					metaByAgentId.set(agId, entry);
				}
			}
			let synced = 0;
			const migrations: Array<{
				readonly agentId: string;
				readonly previousEngine: string;
				readonly currentEngine: string;
			}> = [];
			const snapshotRecords = [...new Set(records.values())];
			for (const rec of snapshotRecords) {
				const parsed = parseAdeAgentResourceIds(rec.resourceId ?? rec.id);
				const recProjId = rec.adeProjectId ?? parsed?.projectId;
				const recAgentId = rec.adeAgentId ?? parsed?.agentId;
				if (recProjId !== projectId || !recAgentId) {
					continue;
				}
				rec.adeProjectId = recProjId;
				rec.adeAgentId = recAgentId;
				const meta = metaByAgentId.get(recAgentId);
				if (meta) {
					const res = await applyResolvedEmployeeMetaToRecord(rec, meta, undefined, true);
					if (res.updated) {
						synced++;
						if (res.previousEngine && res.previousEngine !== res.currentEngine) {
							migrations.push({
								agentId: recAgentId,
								previousEngine: res.previousEngine,
								currentEngine: res.currentEngine,
							});
						}
					}
				}
			}
			if (synced > 0) {
				await triggerImmediateSave().catch(() => undefined);
			}
			return {
				synced,
				updated: synced > 0,
				migrations,
				...(migrations.length === 1 ? {
					previousEngine: migrations[0].previousEngine,
					currentEngine: migrations[0].currentEngine,
				} : {}),
			};
		}),
		vscode.commands.registerCommand('aexus.agentEngines.refreshCliPaths', async () => {
			missingCliToastAtByEngine.clear();
			clearCloudTransportCaches();
			disposeCloudRuntimesForAuthority();
			clearCloudCapsCache();
			await refreshAvailableEngines();
			return { ok: true };
		}),
		vscode.commands.registerCommand('aexus.ade.tryNativeInStreamSteer', async (rawParams?: unknown): Promise<{ readonly steered: boolean }> => {
			if (!rawParams || typeof rawParams !== 'object') {
				return { steered: false };
			}
			const params = rawParams as {
				sessionResource?: unknown;
				projectId?: unknown;
				agentId?: unknown;
				engine?: unknown;
				model?: unknown;
				reasoningEffort?: unknown;
				formattedMessage?: unknown;
			};
			const formattedMessage = typeof params.formattedMessage === 'string' ? params.formattedMessage : '';
			if (!formattedMessage) {
				return { steered: false };
			}
			const rawEng = typeof params.engine === 'string' ? params.engine.trim().toLowerCase() : '';
			const shortEng = ENGINE_ALIASES[rawEng] ?? (rawEng.startsWith('aexus-') ? rawEng.slice('aexus-'.length) : rawEng);
			if (shortEng !== 'pi') {
				return { steered: false };
			}

			let targetRecord: RecordEntry | undefined;
			const sessionResource = typeof params.sessionResource === 'string' ? params.sessionResource.trim() : '';
			if (sessionResource) {
				try {
					targetRecord = findCachedRecord(vscode.Uri.parse(sessionResource));
				} catch { /* ignore */ }
			}
			const projectId = typeof params.projectId === 'string' ? params.projectId.trim() : '';
			const agentId = typeof params.agentId === 'string' ? params.agentId.trim() : '';
			if (!targetRecord && projectId && agentId) {
				targetRecord = [...new Set(records.values())].find(r => {
					if (r.adeProjectId === projectId && r.adeAgentId === agentId) {
						return true;
					}
					const parsed = parseAdeAgentResourceIds(r.resourceId ?? r.id);
					return parsed?.projectId === projectId && parsed?.agentId === agentId;
				});
			}
			if (!targetRecord || targetRecord.engine !== 'pi') {
				return { steered: false };
			}

			const resolveActivePiRuntime = (): PiRuntime | undefined => {
				if (targetRecord!.cloudProjectUri) {
					const auth = recordCloudAuthority(targetRecord!);
					return auth ? (cloudRuntimes.get(`${auth}::pi`)?.runtime as PiRuntime | undefined) : undefined;
				}
				return runtimes.get('pi') as PiRuntime | undefined;
			};
			let activePiRuntime = resolveActivePiRuntime();
			const startupDeadline = Date.now() + 600;
			while (
				turnCoordinator.isBusy(identity(targetRecord))
				&& (!activePiRuntime || !activePiRuntime.hasActiveTurnForSession?.(targetRecord.id))
				&& Date.now() < startupDeadline
			) {
				await new Promise<void>(r => setTimeout(r, 15));
				activePiRuntime = resolveActivePiRuntime();
			}
			if (!activePiRuntime || typeof activePiRuntime.tryNativeInStreamSteer !== 'function') {
				return { steered: false };
			}

			const parsedTicket = parseTicketMessageEnvelope(formattedMessage);
			const streamNoticeMarkdown = parsedTicket
				? `\n\n> ⚡ **Steer Ticket from \`${parsedTicket.fromAgentId}\`** (\`${parsedTicket.ticketId}\` · \`${parsedTicket.taskId}\`)\n\n`
				: `\n\n> ⚡ **Steer message injected**\n\n`;
			const model = typeof params.model === 'string' ? params.model : undefined;
			const reasoningEffort = typeof params.reasoningEffort === 'string' ? params.reasoningEffort : undefined;

			const res = await activePiRuntime.tryNativeInStreamSteer(targetRecord, {
				model,
				reasoningEffort,
				formattedMessage,
				streamNoticeMarkdown,
			});
			if (!res.steered) {
				return { steered: false };
			}

			targetRecord.provisional = false;
			targetRecord.nativeId ??= targetRecord.id;
			targetRecord.updated = Date.now();
			if (reasoningEffort && reasoningEffort !== 'default') {
				(targetRecord.sessionConfig ??= {}).thinking = reasoningEffort === 'none' ? 'off' : reasoningEffort;
			}
			await save();
			return { steered: true };
		}),
		vscode.commands.registerCommand('aexus.agentEngines.invalidateCloudHost', async (rawAuthority?: string, rawNewAlias?: string) => {
			const authority = typeof rawAuthority === 'string' && rawAuthority.trim() ? rawAuthority.trim() : undefined;
			const newAlias = typeof rawNewAlias === 'string' && rawNewAlias.trim() ? rawNewAlias.trim() : undefined;
			clearCloudTransportCaches(authority);
			if (newAlias) {
				clearCloudTransportCaches(newAlias);
			}
			disposeCloudRuntimesForAuthority(authority);
			clearCloudCapsCache(authority);
			if (authority && newAlias && normalizeCloudAuthority(authority) !== normalizeCloudAuthority(newAlias)) {
				const oldNorm = normalizeCloudAuthority(authority);
				const affectedEngines = new Set<string>();
				for (const record of records.values()) {
					if (!record.cloudProjectUri) {
						continue;
					}
					const parsed = parseCloudProjectUri(record.cloudProjectUri);
					if (parsed && normalizeCloudAuthority(parsed.authority) === oldNorm) {
						const parsedVs = vscode.Uri.parse(record.cloudProjectUri);
						record.cloudProjectUri = normalizeCloudProjectUriString(parsedVs.with({ authority: newAlias }));
						affectedEngines.add(record.engine);
					}
				}
				if (affectedEngines.size > 0) {
					await save();
					for (const eng of affectedEngines) {
						refresh(eng);
					}
				}
			}
		}),
		vscode.commands.registerCommand('aexus.agentEngines.list', async (rawProject?: vscode.Uri | string, options?: { readonly forceRefresh?: boolean }) => {
			const projectUri = parseOptionalUri(rawProject);
			if (isCloudUri(projectUri)) {
				const target = await resolveCloudHostTarget(projectUri.authority, Boolean(options?.forceRefresh));
				const probe = await probeRemoteEngines(target, Boolean(options?.forceRefresh));
				return available.map(definition => ({
					id: definition.type,
					name: definition.name,
					available: Boolean(probe.ok && probe.executables[definition.id]),
					remoteHost: probe.target.alias,
					remoteOs: probe.os,
					...(probe.ok ? {} : { error: probe.error }),
				}));
			}
			if (options?.forceRefresh || available.some(entry => !entry.command)) {
				await refreshAvailableEngines();
			}
			return available.map(definition => ({ id: definition.type, name: definition.name, available: !!definition.command }));
		}),
		vscode.commands.registerCommand('aexus.agentEngines.create', async (engineId: string, project: vscode.Uri) => {
			const engine = engineId.slice('aexus-'.length);
			if (isCloudUri(project)) {
				const target = await resolveCloudHostTarget(project.authority);
				const info = await resolveRemoteEngineInfo(engine, target);
				if (!info.command) {
					const msg = formatMissingRemoteEngineMessage(engine, info.target.alias, available, info.probeError);
					promptConfigureCloudHost(msg, info.target.alias, Boolean(info.probeError));
					throw new Error(msg);
				}
				const remoteCwd = toRemoteNativePath(project.path || '/', info.target.os, info.target.remoteHome);
				const cloudProjectUri = normalizeCloudProjectUriString(project);
				const eng = runtimeForCloud(engine, info.target, info.command);
				const native = await eng.create(remoteCwd);
				const record: RecordEntry = {
					...native,
					engine,
					initialTitle: native.label,
					resourceId: native.id,
					sessionConfig: {},
					cloudProjectUri,
				};
				records.set(key(engine, native.id), record);
				await save();
				refresh(engine);
				return describe(record);
			}
			await ensureEngineCommand(engine);
			const native = await runtime(engine).create(project.fsPath);
			const record: RecordEntry = {
				...native,
				engine,
				initialTitle: native.label,
				resourceId: native.id,
				sessionConfig: {},
			};
			records.set(key(engine, native.id), record);
			await save();
			refresh(engine);
			return describe(record);
		}),
		vscode.commands.registerCommand('aexus.agentEngines.attach', async (engineId: string, nativeId: string, rawProject?: vscode.Uri | string) => {
			const project = parseOptionalUri(rawProject);
			const engine = engineId.startsWith('aexus-') ? engineId.slice('aexus-'.length) : (ENGINE_ALIASES[engineId.toLowerCase()] ?? engineId);
			const query = nativeId.trim();
			const queryLower = query.toLowerCase();
			const matchesRecord = (entry: RecordEntry): boolean =>
				entry.id === query
				|| entry.resourceId === query
				|| entry.id.toLowerCase().startsWith(queryLower)
				|| entry.label.trim().toLowerCase() === queryLower;
			const token = new vscode.CancellationTokenSource();
			try {
				if (isCloudUri(project)) {
					const target = await resolveCloudHostTarget(project.authority);
					const info = await resolveRemoteEngineInfo(engine, target);
					const effectiveTarget = info.target;
					const cloudProjectUri = normalizeCloudProjectUriString(project);
					const remoteCwd = toRemoteNativePath(project.path || '/', effectiveTarget.os, effectiveTarget.remoteHome);
					const resolvedRealCwd = await resolveRemoteRealpath(effectiveTarget, remoteCwd, token.token).catch(() => undefined);
					const acceptedNormCwds = new Set<string>([normalizeRemoteCwdForCompare(remoteCwd, effectiveTarget.os)]);
					if (resolvedRealCwd) {
						acceptedNormCwds.add(normalizeRemoteCwdForCompare(resolvedRealCwd, effectiveTarget.os));
					}
					if (info.command) {
						const remoteSessions = await runtimeForCloud(engine, effectiveTarget, info.command).list(token.token, remoteCwd).catch(() => [] as NativeSession[]);
						for (const s of remoteSessions) {
							const normalizedCwd = s.cwd ? normalizeRemoteCwdForCompare(s.cwd, effectiveTarget.os) : '';
							const mappedUri = acceptedNormCwds.has(normalizedCwd) ? cloudProjectUri : undefined;
							acceptCloud(engine, mappedUri ? { ...s, cwd: remoteCwd } : s, effectiveTarget, mappedUri ?? cloudProjectUri);
						}
					}
					let record = [...records.values()].find(entry =>
						entry.engine === engine
						&& recordCloudAuthority(entry) === effectiveTarget.authority
						&& (entry.cloudProjectUri === cloudProjectUri || (entry.cwd && acceptedNormCwds.has(normalizeRemoteCwdForCompare(entry.cwd, effectiveTarget.os))))
						&& matchesRecord(entry),
					) ?? [...records.values()].find(entry =>
						entry.engine === engine
						&& recordCloudAuthority(entry) === effectiveTarget.authority
						&& matchesRecord(entry),
					);
					if (!record) {
						const now = Date.now();
						record = acceptCloud(engine, {
							id: query,
							cwd: remoteCwd,
							label: vscode.l10n.t('{0} Session {1}', engine, query.slice(0, 8)),
							created: now,
							updated: now,
							provisional: false,
						}, effectiveTarget, cloudProjectUri);
					}
					record.cloudProjectUri = cloudProjectUri;
					record.resourceId ??= record.id;
					await save();
					refresh(engine);
					return describe(record);
				}
				const sessions = await list(engine, token.token, project?.scheme === 'file' ? project.fsPath : undefined);
				let record = sessions.find(entry => !entry.cloudProjectUri && matchesRecord(entry));
				if (!record) {
					if (!project || project.scheme !== 'file') {
						throw new Error(vscode.l10n.t('Conversation {0} was not found in {1}.', query, engine));
					}
					const now = Date.now();
					record = accept(engine, {
						id: query,
						cwd: project.fsPath,
						label: vscode.l10n.t('{0} Session {1}', engine, query.slice(0, 8)),
						created: now,
						updated: now,
						provisional: false,
					});
					record.resourceId ??= record.id;
					await save();
					refresh(engine);
				}
				return describe(record);
			} finally {
				token.dispose();
			}
		}),
		vscode.commands.registerCommand('aexus.agentEngines.sessions', async (engineId: string, rawProject?: vscode.Uri | string) => {
			const project = parseOptionalUri(rawProject);
			const engine = engineId.startsWith('aexus-') ? engineId.slice('aexus-'.length) : (ENGINE_ALIASES[engineId.toLowerCase()] ?? engineId);
			const token = new vscode.CancellationTokenSource();
			try {
				if (isCloudUri(project)) {
					const target = await resolveCloudHostTarget(project.authority);
					const info = await resolveRemoteEngineInfo(engine, target);
					const effectiveTarget = info.target;
					const requestedCloud = normalizeCloudProjectUriString(project);
					const requestedRemoteCwd = toRemoteNativePath(project.path || '/', effectiveTarget.os, effectiveTarget.remoteHome);
					const requestedNorm = normalizeRemoteCwdForCompare(requestedRemoteCwd, effectiveTarget.os);
					const resolvedRealCwd = await resolveRemoteRealpath(effectiveTarget, requestedRemoteCwd, token.token).catch(() => undefined);
					const acceptedNormCwds = new Set<string>([requestedNorm]);
					if (resolvedRealCwd) {
						acceptedNormCwds.add(normalizeRemoteCwdForCompare(resolvedRealCwd, effectiveTarget.os));
					}
					if (info.command) {
						const remoteSessions = await runtimeForCloud(engine, effectiveTarget, info.command).list(token.token, requestedRemoteCwd).catch(() => [] as NativeSession[]);
						for (const s of remoteSessions) {
							const normalizedCwd = s.cwd ? normalizeRemoteCwdForCompare(s.cwd, effectiveTarget.os) : '';
							const belongsToRequested = acceptedNormCwds.has(normalizedCwd);
							const accepted = acceptCloud(
								engine,
								belongsToRequested ? { ...s, cwd: requestedRemoteCwd } : s,
								effectiveTarget,
								belongsToRequested ? requestedCloud : undefined,
							);
							if (belongsToRequested) {
								accepted.cloudProjectUri = requestedCloud;
							}
						}
						await save();
						refresh(engine);
					}
					const result = [];
					const matching = [...records.values()]
						.filter(record => record.engine === engine && !record.parentId && !record.adeAgentId && recordCloudAuthority(record) === effectiveTarget.authority)
						.sort((a, b) => b.updated - a.updated);
					for (const record of matching) {
						const recCloudNorm = record.cloudProjectUri ? normalizeCloudProjectUriString(vscode.Uri.parse(record.cloudProjectUri)) : undefined;
						const recCwdNorm = record.cwd ? normalizeRemoteCwdForCompare(record.cwd, effectiveTarget.os) : undefined;
						if (recCloudNorm === requestedCloud || (recCwdNorm && acceptedNormCwds.has(recCwdNorm))) {
							result.push(describe(record));
						}
					}
					return result;
				}
				const sessions = await list(engine, token.token, project?.scheme === 'file' ? project.fsPath : undefined);
				const canonical = async (cwd: string) => fs.realpath(cwd).catch(() => path.resolve(cwd));
				const requestedCwd = project ? await canonical(project.fsPath) : undefined;
				const result = [];
				for (const record of sessions) {
					if (record.parentId || record.adeAgentId) { continue; }
					if (!project) {
						result.push(describe(record));
						continue;
					}
					if (record.cloudProjectUri) { continue; }
					if (requestedCwd && requestedCwd === await canonical(record.cwd)) {
						result.push(describe(record));
					}
				}
				return result;
			} finally {
				token.dispose();
			}
		}),
		vscode.commands.registerCommand('aexus.agentEngines.children', async (uri: vscode.Uri) => {
			const token = new vscode.CancellationTokenSource();
			try {
				const parent = await getRecord(uri, token.token);
				const resolved = await tryRuntimeForRecord(parent);
				const children = await resolved?.engine.children?.(parent, token.token) ?? [];
				const result = children.map(child => {
					const accepted = resolved?.remoteTarget
						? acceptCloud(parent.engine, child, resolved.remoteTarget, parent.cloudProjectUri)
						: accept(parent.engine, child);
					if (parent.cloudProjectUri && !accepted.cloudProjectUri) {
						accepted.cloudProjectUri = parent.cloudProjectUri;
					}
					return accepted;
				});
				for (const child of result) { await publishHistory(child); }
				await save();
				return result.map(describe);
			} finally { token.dispose(); }
		}),
		vscode.commands.registerCommand('aexus.agentEngines.info', async (uri: vscode.Uri) => {
			const token = new vscode.CancellationTokenSource();
			try {
				const record = await getRecord(uri, token.token);
				await save();
				return {
					projectUri: recordProjectUri(record),
					label: record.label,
					nativeId: record.id,
					provisional: Boolean(record.provisional),
					unmaterialized: Boolean(record.unmaterialized),
					engine: record.engine,
					sessionConfig: record.sessionConfig,
					adeProjectId: record.adeProjectId,
					adeAgentId: record.adeAgentId,
				};
			} finally { token.dispose(); }
		}),
		vscode.commands.registerCommand('aexus.agentEngines.history', async (uri: vscode.Uri, limit?: number) => {
			const token = new vscode.CancellationTokenSource();
			try {
				const record = await getRecord(uri, token.token);
				const resolved = await tryRuntimeForRecord(record);
				const turns = resolved
					? await resolved.engine.history(record, token.token).catch(() => [] as HistoryEntry[])
					: [];
				const messages = turns.map(entry => ({ role: entry.role, text: entry.text }));
				const cachedLast = lastTurnReplies.get(identity(record));
				const cachedNorm = cachedLast ? cachedLast.replace(/\s+/g, '') : '';
				let cachedAlreadyPresent = false;
				if (cachedNorm) {
					const norm = (s: string) => s.replace(/\s+/g, '');
					if (messages.some(m => m.role === 'assistant' && norm(m.text) === cachedNorm)) {
						cachedAlreadyPresent = true;
					}
				}
				if (cachedLast && !cachedAlreadyPresent) {
					messages.push({ role: 'assistant', text: cachedLast });
				}
				const cachedError = lastTurnErrors.get(identity(record));
				const slice = typeof limit === 'number' && limit > 0 ? messages.slice(-Math.floor(limit)) : messages;
				return {
					engine: record.engine,
					nativeId: record.id,
					messages: slice,
					...(cachedError ? { lastError: cachedError } : {}),
				};
			} finally { token.dispose(); }
		}),
		vscode.commands.registerCommand('aexus.agentEngines.stop', async (uri: vscode.Uri) => {
			const record = findCachedRecord(uri);
			if (!record) {
				return { stopped: false };
			}
			const stopped = await turnCoordinator.stop(identity(record), 2000, 3000, { cancelQueuedHeadless: false });
			if (stopped) {
				controllers.get(record.engine)?.items.add(item(record));
			}
			return { stopped };
		}),
		vscode.commands.registerCommand('aexus.agentEngines.notifySystemResume', async () => {
			notifySystemResume();
			return { ok: true };
		}),
		vscode.commands.registerCommand('aexus.agentEngines.killSession', async (uri: vscode.Uri, options?: { readonly hostAlias?: string }) => {
			const record = findCachedRecord(uri);
			if (!record) {
				const rawScheme = uri?.scheme || '';
				const engineName = rawScheme.startsWith('aexus-') ? rawScheme.slice('aexus-'.length) : '';
				const sessionId = (uri?.path || '').replace(/^\/+/, '');
				if (engineName && sessionId && options?.hostAlias?.trim()) {
					const target = await resolveCloudHostTarget(options.hostAlias.trim()).catch(() => undefined);
					if (target && target.os !== 'windows') {
						await terminateRemotePersistentSessionsByPrefix(
							target,
							buildRemotePersistentPrefix(engineName, sessionId),
							{ killTree: true },
						).catch(() => undefined);
						return { killed: true };
					}
				}
				return { killed: false };
			}
			await turnCoordinator.forceRelease(identity(record));
			const resolved = await tryRuntimeForRecord(record).catch(() => undefined);
			if (resolved) {
				await resolved.engine.killSession?.(record).catch(() => undefined);
				if (resolved.engine.remoteTarget && resolved.engine.remoteTarget.os !== 'windows' && record.resourceId && record.resourceId !== record.id) {
					await terminateRemotePersistentSessionsByPrefix(
						resolved.engine.remoteTarget,
						buildRemotePersistentPrefix(record.engine, record.resourceId),
						{ killTree: true },
					).catch(() => undefined);
				}
			} else if (options?.hostAlias?.trim()) {
				const target = await resolveCloudHostTarget(options.hostAlias.trim()).catch(() => undefined);
				if (target && target.os !== 'windows') {
					await terminateRemotePersistentSessionsByPrefix(
						target,
						buildRemotePersistentPrefix(record.engine, record.id),
						{ killTree: true },
					).catch(() => undefined);
				}
			}
			controllers.get(record.engine)?.items.add(item(record));
			return { killed: true };
		}),
		vscode.commands.registerCommand('aexus.agentEngines.delete', async (uri: vscode.Uri) => {
			const token = new vscode.CancellationTokenSource();
			try {
				let record: RecordEntry | undefined = findCachedRecord(uri);
				if (!record) {
					record = await getRecord(uri, token.token).catch(() => undefined);
				}
				if (!record) {
					return true;
				}
				await deleteRecordAndDescendants(record, token.token, new Set<string>());
				await save();
				return true;
			} finally { token.dispose(); }
		}),
		vscode.commands.registerCommand('aexus.agentEngines.deleteProjectSessions', async (project: vscode.Uri) => {
			const token = new vscode.CancellationTokenSource();
			try {
				const matching: RecordEntry[] = [];
				if (isCloudUri(project)) {
					const targetCloud = normalizeCloudProjectUriString(project);
					const targetAuth = normalizeCloudAuthority(project.authority);
					const resolvedTarget = await resolveCloudHostTarget(project.authority).catch(() => undefined);
					const targetRemoteNorm = resolvedTarget
						? normalizeRemoteCwdForCompare(toRemoteNativePath(project.path || '/', resolvedTarget.os, resolvedTarget.remoteHome), resolvedTarget.os)
						: undefined;
					for (const candidate of records.values()) {
						if (candidate.cloudProjectUri === targetCloud) {
							matching.push(candidate);
							continue;
						}
						if (targetRemoteNorm && resolvedTarget && recordCloudAuthority(candidate) === targetAuth && candidate.cwd && normalizeRemoteCwdForCompare(candidate.cwd, resolvedTarget.os) === targetRemoteNorm) {
							matching.push(candidate);
						}
					}
				} else {
					const canonical = async (cwd: string) => fs.realpath(cwd).catch(() => path.resolve(cwd));
					const targetCwd = await canonical(project.fsPath);
					for (const candidate of records.values()) {
						if (candidate.cloudProjectUri) { continue; }
						if (await canonical(candidate.cwd) === targetCwd) {
							matching.push(candidate);
						}
					}
				}
				const deletedKeys = new Set<string>();
				let deletedCount = 0;
				for (const candidate of matching) {
					deletedCount += await deleteRecordAndDescendants(candidate, token.token, deletedKeys);
				}
				if (deletedCount > 0) {
					await save();
				}
				return deletedCount;
			} finally { token.dispose(); }
		}),
		vscode.commands.registerCommand('aexus.agentEngines.rename', async (uri: vscode.Uri, label: string) => {
			const record = findCachedRecord(uri);
			if (!record) { return; }
			record.label = label;
			record.customLabel = true;
			record.initialTitle = undefined;
			const controller = controllers.get(record.engine);
			if (controller) { controller.items.add(item(record)); }
			await save();
		}),
	);
}
