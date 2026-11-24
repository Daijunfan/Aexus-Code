/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
import { registerEngineeringAndRoleBridge } from './extensionEngineeringDispatch';
import {
	buildMissingEngineMarkdown,
	buildMissingRemoteEngineMarkdown,
	computeMeasuredContextSegments,
	definitions,
	ENGINE_ALIASES,
	EngineDefinition,
	expandBuiltInWorkflowPrompt,
	extractAttachmentsAndRefs,
	formatMissingEngineMessage,
	formatMissingRemoteEngineMessage,
	formatRecordProjectLabel,
	GOAL_COMPLETE_MARKER,
	hashRolePrompt,
	MAX_GOAL_ROUNDS,
	parseOptionalUri,
	readNativeRoleBridgeEnabled,
	recordCloudAuthority,
	RecordEntry,
	recordProjectUri,
	remoteNativePathToCloudUri,
	resolveCliBinDir,
	resolveCompletedTurnUsage,
	resolveDefaultModeForEngine,
	resolveDefaultPermissionsForEngine,
	resolveDefaultSandboxForEngine,
	SECRETARY_TYPE,
	SECRETARY_URI,
	SecretaryState,
	toEngineType,
	toSendOptions,
	toSessionOptionsRecord,
	toVsCodeOptionGroups,
	withSafeDefaultConfig,
} from './extensionSessionHelpers';
import { createSlashCommandHandlers } from './extensionSlashCommands';
import { installNativeRoleBridge } from './nativeRoleBridge';
import {
	AEXUS_PREAMBLE_END_MARKER,
	buildUserMessageSystemEnvelope,
	computeStaticRolePromptHash,
	extractDynamicRoleBindingsTail,
	extractStaticRoleCharter,
	filterAndCleanHistoryTurns,
	hasAexusSystemMessageEnvelope,
	RoleSyncSnapshot,
} from './roleBridgeShared';
import {
	EngineRuntime,
	EngineRuntimeCapabilities,
	EngineTurnTokenUsage,
	findExecutable,
	getConfiguredEngineIdleStallTimeoutMs,
	getConfiguredEngineTurnTimeoutMs,
	HistoryEntry,
	isAutonomousModeEnabled,
	NativeSession,
	setCliBinDirectory,
} from './runtime';
import { SessionTurnCoordinator } from './turnCoordinator';
import { createStreamToolErrorScanner, detectToolErrorInProgressText, detectToolErrorInStreamPart } from './usageTracker';

const roleBridge = installNativeRoleBridge({ distDir: __dirname });
let refreshRoleSnapshotFromWorkbench: () => Promise<RoleSyncSnapshot | undefined> = async () => undefined;
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
	roleBridge.setEnabled(readNativeRoleBridgeEnabled());
	const cliBinDir = await resolveCliBinDir(context.extensionPath);
	setCliBinDirectory(cliBinDir);
	const currentEnvPath = process.env.PATH ?? '';
	if (!currentEnvPath.split(path.delimiter).includes(cliBinDir)) {
		process.env.PATH = currentEnvPath ? `${cliBinDir}${path.delimiter}${currentEnvPath}` : cliBinDir;
	}
	context.environmentVariableCollection.prepend('PATH', cliBinDir + path.delimiter);

	const records = new Map<string, RecordEntry>(Object.entries(context.globalState.get<Record<string, RecordEntry>>('nativeSessions', {})));
	for (const record of records.values()) {
		record.resourceId ??= record.id;
		if ((record.engine === 'codex' || record.engine === 'cline') && record.provisional === undefined && record.initialTitle && record.label === record.initialTitle) {
			record.provisional = true;
		}
	}
	let secretaryState = context.globalState.get<SecretaryState>('secretaryState');

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

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('aexus.ade.cliPaths')) {
			void refreshAvailableEngines();
		}
		if (event.affectsConfiguration('aexus.ade.remoteCliPaths') || event.affectsConfiguration('remote.SSH.path')) {
			clearCloudTransportCaches();
			disposeCloudRuntimesForAuthority();
			clearCloudCapsCache();
		}
		if (event.affectsConfiguration('aexus.ade.nativeExtensionRoleBridge.enabled')) {
			roleBridge.setEnabled(readNativeRoleBridgeEnabled());
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

	const key = (engine: string, id: string) => `${engine}:${id}`;
	const identity = (record: RecordEntry) => key(record.engine, record.resourceId ?? record.id);
	const isRecordBusy = (record: RecordEntry) => turnCoordinator.isBusy(identity(record));
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
		const nextMapKey = cloudAuth && ((records.has(nextPlainKey) && records.get(nextPlainKey) !== record) || oldMapKey?.startsWith('cloud:'))
			? `cloud:${cloudAuth}:${nextPlainKey}`
			: nextPlainKey;
		if (oldMapKey && oldMapKey !== nextMapKey) {
			records.delete(oldMapKey);
		} else {
			records.delete(key(record.engine, prevId));
		}
		records.set(nextMapKey, record);
		if (secretaryState && (secretaryState.recordKey === oldMapKey || secretaryState.recordKey === key(record.engine, prevId))) {
			secretaryState.recordKey = nextMapKey;
		}
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

	// Coalesce bursty session & capability globalState writes behind trailing timers with serialized in-flight chains and shutdown flush.
	const SAVE_DEBOUNCE_MS = 80;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let saveWaiters: Array<() => void> = [];
	let inFlightStateWrite: Promise<void> = Promise.resolve();
	let capsSaveTimer: ReturnType<typeof setTimeout> | undefined;
	let inFlightCapsWrite: Promise<void> = Promise.resolve();

	const writeStateNow = async (): Promise<void> => {
		await Promise.all([
			context.globalState.update('nativeSessions', Object.fromEntries(records)),
			context.globalState.update('secretaryState', secretaryState),
		]);
	};

	const enqueueStateWrite = (): Promise<void> => {
		const next = inFlightStateWrite.then(() => writeStateNow(), () => writeStateNow());
		inFlightStateWrite = next.catch(() => undefined);
		return next;
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
			void enqueueStateWrite().finally(() => {
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
		if (saveTimer !== undefined) {
			clearTimeout(saveTimer);
			saveTimer = undefined;
			const waiters = saveWaiters;
			saveWaiters = [];
			void enqueueStateWrite().finally(() => {
				for (const w of waiters) {
					w();
				}
			});
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

	const getSessionConfig = (record: RecordEntry, isSecretary: boolean): SessionConfigState => {
		if (isSecretary) {
			secretaryState ??= { engine: record.engine, recordKey: key(record.engine, record.id), perEngineConfig: {} };
			secretaryState.perEngineConfig ??= {};
			const perEng = secretaryState.perEngineConfig[record.engine] ?? record.sessionConfig ?? {};
			secretaryState.perEngineConfig[record.engine] = perEng;
			return {
				...perEng,
				secretaryEngineId: toEngineType(record.engine),
			};
		}
		record.sessionConfig ??= {};
		return record.sessionConfig;
	};

	const setGoalBannerInUi = (sessionUri: vscode.Uri, goalText: string | undefined) => {
		void Promise.resolve(vscode.commands.executeCommand('aexus.ade.setSessionGoalBanner', sessionUri, goalText)).catch(() => undefined);
	};

	// eslint-disable-next-line prefer-const
	let secretaryController: vscode.ChatSessionItemController | undefined;
	const refreshSecretaryItem = () => {
		if (!secretaryController) { return; }
		const record = secretaryState ? records.get(secretaryState.recordKey) : undefined;
		const secBusy = record ? isRecordBusy(record) : false;
		const engineDef = available.find(entry => entry.id === secretaryState?.engine);
		const secItem = secretaryController.createChatSessionItem(SECRETARY_URI, 'Secretary');
		secItem.description = engineDef?.name ?? 'Secretary';
		secItem.metadata = {
			workingDirectoryPath: record?.cwd ?? os.homedir(),
			nativeSessionId: record?.id ?? 'secretary',
			provisional: record?.provisional ?? true,
			secretaryEngine: secretaryState?.engine ? `aexus-${secretaryState.engine}` : undefined,
		};
		secItem.timing = { created: record?.created ?? Date.now(), lastRequestEnded: secBusy ? undefined : (record?.updated ?? Date.now()) };
		secItem.status = secBusy ? vscode.ChatSessionStatus.InProgress : vscode.ChatSessionStatus.Completed;
		secretaryController.items.replace([secItem]);
	};
	secretaryController = vscode.chat.createChatSessionItemController(SECRETARY_TYPE, async () => refreshSecretaryItem());

	const resolveShortEngine = (raw?: string, strict = false): string | undefined => {
		if (raw) {
			const normalized = raw.trim().toLowerCase();
			const aliased = ENGINE_ALIASES[normalized] ?? (normalized.startsWith('aexus-') ? normalized.slice('aexus-'.length) : normalized);
			const match = available.find(entry => entry.id === aliased && entry.command);
			if (match) { return match.id; }
			if (strict) { return undefined; }
		}
		return available.find(entry => entry.command)?.id;
	};

	const accept = (engine: string, session: NativeSession): RecordEntry => {
		const sessionKey = key(engine, session.id);
		const existing = records.get(sessionKey) ?? [...records.values()].find(record => record.engine === engine && record.id === session.id);
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
		if (secretaryState?.engine === engine) {
			refreshSecretaryItem();
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
			record.roleInit = undefined;
			record.lastDeltaContext = undefined;
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
		}
		return { caps: effective, changed };
	};

	const fetchRuntimeCaps = async (shortEngine: string, cwd: string, record?: RecordEntry): Promise<{ caps: EngineRuntimeCapabilities; changed: boolean }> => {
		const authority = recordCloudAuthority(record);
		const cacheKey = capsKeyFor(shortEngine, cwd, authority);
		const existingPending = runtimeCapsPending.get(cacheKey);
		if (existingPending) {
			return existingPending;
		}
		const prev = getCachedRuntimeCaps(shortEngine, cwd, authority);
		if (!authority) {
			const def = available.find(entry => entry.id === shortEngine && entry.command);
			if (!def) {
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
				} else {
					eng = runtime(shortEngine);
				}
				if (eng?.getRuntimeCapabilities) {
					let settled = false;
					const probePromise = eng.getRuntimeCapabilities(cwd, record).then(lateCaps => {
						if (settled && runtimeCapsGeneration.get(cacheKey) === generation) {
							const lateResult = commitRuntimeCaps(shortEngine, cwd, lateCaps, authority);
							if (lateResult.changed) {
								providerOptionsChangeEmitters.get(`aexus-${shortEngine}`)?.fire();
								if (!authority && secretaryState?.engine === shortEngine) {
									providerOptionsChangeEmitters.get(SECRETARY_TYPE)?.fire();
								}
							}
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

	const ensureSecretaryRecord = async (preferredEngine?: string, preferredProject?: vscode.Uri, forceNew = false): Promise<RecordEntry> => {
		if (preferredEngine) {
			const normalized = preferredEngine.trim().toLowerCase();
			const aliased = ENGINE_ALIASES[normalized] ?? (normalized.startsWith('aexus-') ? normalized.slice('aexus-'.length) : normalized);
			await ensureEngineCommand(aliased);
		} else if (!available.some(entry => entry.command)) {
			await refreshAvailableEngines();
		}
		const targetEngine = preferredEngine
			? resolveShortEngine(preferredEngine, true)
			: resolveShortEngine(secretaryState?.engine);
		if (!targetEngine) {
			if (preferredEngine) {
				const normalized = preferredEngine.trim().toLowerCase();
				const aliased = ENGINE_ALIASES[normalized] ?? (normalized.startsWith('aexus-') ? normalized.slice('aexus-'.length) : normalized);
				const msg = formatMissingEngineMessage(aliased, available);
				promptConfigureCliPaths(msg);
				throw new Error(msg);
			}
			const noCliMsg = vscode.l10n.t('No Coding Agent CLI is installed. Install Claude Code, Codex, Kilo, OpenCode, DSH, Antigravity, Cline, or Pi, or configure "aexus.ade.cliPaths" in Settings.');
			promptConfigureCliPaths(noCliMsg);
			throw new Error(noCliMsg);
		}
		const prevPerEngineConfig = secretaryState?.perEngineConfig ?? {};
		if (!forceNew && secretaryState && secretaryState.engine === targetEngine) {
			const existing = records.get(secretaryState.recordKey);
			if (existing) {
				if (preferredProject?.scheme === 'file') {
					existing.cwd = preferredProject.fsPath;
				}
				return existing;
			}
		}
		if (!forceNew) {
			const previousForTarget = [...records.values()]
				.filter(r => r.engine === targetEngine && r.label === 'Secretary' && r.customLabel)
				.sort((a, b) => b.updated - a.updated)[0];
			if (previousForTarget) {
				if (preferredProject?.scheme === 'file') {
					previousForTarget.cwd = preferredProject.fsPath;
				}
				secretaryState = { engine: targetEngine, recordKey: key(targetEngine, previousForTarget.id), perEngineConfig: prevPerEngineConfig };
				await save();
				refreshSecretaryItem();
				const secOpened = opened.get(SECRETARY_TYPE);
				if (secOpened) {
					const turns = await runtime(targetEngine).history(previousForTarget, secOpened.cancellation.token).catch(() => [] as HistoryEntry[]);
					secOpened.changed.fire(history(turns, SECRETARY_TYPE));
				}
				return previousForTarget;
			}
		}
		const cwd = preferredProject?.scheme === 'file'
			? preferredProject.fsPath
			: (vscode.workspace.workspaceFolders?.[0]?.uri.scheme === 'file' ? vscode.workspace.workspaceFolders[0].uri.fsPath : os.homedir());
		const native = await runtime(targetEngine).create(cwd);
		const recordKey = key(targetEngine, native.id);
		const record: RecordEntry = {
			...native,
			engine: targetEngine,
			label: 'Secretary',
			customLabel: true,
			resourceId: native.id,
			sessionConfig: prevPerEngineConfig[targetEngine] ?? {},
		};
		records.set(recordKey, record);
		secretaryState = { engine: targetEngine, recordKey, perEngineConfig: prevPerEngineConfig };
		await save();
		refreshSecretaryItem();
		const secOpened = opened.get(SECRETARY_TYPE);
		if (secOpened) {
			secOpened.changed.fire([]);
		}
		return record;
	};

	const list = async (engine: string, token: vscode.CancellationToken, projectCwd?: string): Promise<RecordEntry[]> => {
		for (const session of await runtime(engine).list(token, projectCwd)) {
			accept(engine, session);
		}
		refresh(engine);
		return [...records.values()].filter(record => record.engine === engine).sort((a, b) => b.updated - a.updated);
	};

	const findCachedRecord = (uri: vscode.Uri): RecordEntry | undefined => {
		if (uri.scheme === SECRETARY_TYPE) {
			return secretaryState ? records.get(secretaryState.recordKey) : undefined;
		}
		const engine = uri.scheme.slice('aexus-'.length);
		const id = uri.path.slice(1);
		return records.get(key(engine, id)) ?? [...records.values()].find(entry => entry.engine === engine && (entry.resourceId === id || entry.id === id));
	};

	const getRecord = async (uri: vscode.Uri, token: vscode.CancellationToken): Promise<RecordEntry> => {
		if (uri.scheme === SECRETARY_TYPE) {
			return ensureSecretaryRecord();
		}
		const engine = uri.scheme.slice('aexus-'.length);
		const id = uri.path.slice(1);
		let record = findCachedRecord(uri);
		if (!record) {
			record = (await list(engine, token)).find(entry => entry.id === id || entry.resourceId === id);
		}
		if (!record) { throw new Error(vscode.l10n.t('This engine conversation is no longer available.')); }
		return record;
	};

	const defaultCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.scheme === 'file'
		? vscode.workspace.workspaceFolders[0].uri.fsPath
		: os.homedir();

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
			if (secretaryState?.engine === shortEng) {
				addCustom(secretaryState.perEngineConfig?.[shortEng]?.model);
			}
			return out;
		}
		for (const rec of records.values()) {
			if (rec.engine === shortEng) {
				addCustom(rec.sessionConfig?.model);
			}
		}
		addCustom(secretaryState?.perEngineConfig?.[shortEng]?.model);
		return out;
	};

	const computeOptionGroupsForResource = async (sessionType: string, sessionUri?: vscode.Uri): Promise<vscode.ChatSessionProviderOptionGroup[]> => {
		const isSecretary = sessionType === SECRETARY_TYPE || sessionUri?.scheme === SECRETARY_TYPE;
		if (isSecretary) {
			const secRecord = findCachedRecord(SECRETARY_URI) ?? await ensureSecretaryRecord().catch(() => undefined);
			const shortEng = secRecord?.engine ?? resolveShortEngine() ?? 'claude';
			const cwd = secRecord?.cwd ?? defaultCwd();
			const rawCaps = getCachedRuntimeCaps(shortEng, cwd);
			const cfg = secRecord ? getSessionConfig(secRecord, true) : { secretaryEngineId: toEngineType(shortEng) };
			return toVsCodeOptionGroups(await buildOptionGroupsForSession('secretary', withSafeDefaultConfig(toEngineType(shortEng), cfg), cwd, {
				...rawCaps,
				customModels: collectSavedCustomModels(shortEng, secRecord),
			}), SECRETARY_TYPE);
		}
		const engineType = toEngineType(sessionType);
		const shortEng = engineType.slice('aexus-'.length);
		const rec = sessionUri ? findCachedRecord(sessionUri) : undefined;
		const authority = recordCloudAuthority(rec);
		const remoteTarget = rec?.cloudProjectUri ? await ensureRecordCloudReady(rec).catch(() => undefined) : undefined;
		const cwd = rec?.cwd ?? lastActiveCwdByType.get(engineType) ?? defaultCwd();
		const rawCaps = getCachedRuntimeCaps(shortEng, cwd, authority);
		const cfg = rec ? getSessionConfig(rec, false) : {};
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

	const lastNotifiedOptionsSig = new Map<string, string>();
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
		if (!force && (runtimeCapsPending.has(cacheKey) || (Date.now() - lastAt < cooldownMs))) {
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
			if (!authority && sessionType !== SECRETARY_TYPE && secretaryState?.engine === shortEng) {
				void notifySessionOptionsUpdated(SECRETARY_TYPE, SECRETARY_URI, true);
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
		const isSecretary = sessionType === SECRETARY_TYPE || sessionUri.scheme === SECRETARY_TYPE;
		let record = findCachedRecord(sessionUri);
		if (!record && isSecretary) {
			record = await ensureSecretaryRecord();
		}
		if (!record) {
			return;
		}

		let anyChanged = false;
		let engineSwitched = false;

		for (const { optionId, value: rawValue } of updates) {
			const value = typeof rawValue === 'string' ? rawValue : rawValue?.id;
			if (isSecretary && optionId === 'engine' && value) {
				const nextShort = resolveShortEngine(value);
				if (nextShort && nextShort !== record.engine) {
					record = await ensureSecretaryRecord(nextShort, vscode.Uri.file(record.cwd), false);
					engineSwitched = true;
					anyChanged = true;
					void fetchRuntimeCaps(nextShort, record.cwd, record).then(({ changed }) => {
						if (changed) {
							void notifySessionOptionsUpdated(SECRETARY_TYPE, SECRETARY_URI, true);
						}
					});
					if (syncToAde) {
						void Promise.resolve(vscode.commands.executeCommand('aexus.ade.syncSessionPreferences', {
							resource: SECRETARY_URI.toString(),
							engineId: `aexus-${nextShort}`,
						})).catch(() => undefined);
					}
					customizationChangedEmitter.fire();
				}
				continue;
			}

			const targetCfg = isSecretary
				? ((secretaryState ??= { engine: record.engine, recordKey: key(record.engine, record.id), perEngineConfig: {} }),
					(secretaryState.perEngineConfig ??= {}),
					(secretaryState.perEngineConfig[record.engine] ??= {}))
				: (record.sessionConfig ??= {});

			const engineType = toEngineType(record.engine);
			const autonomous = isAutonomousModeEnabled();
			const defaultModeForEngine = resolveDefaultModeForEngine(engineType, autonomous);
			const defaultPermissionsForEngine = resolveDefaultPermissionsForEngine(engineType, autonomous);
			const defaultSandboxForEngine = resolveDefaultSandboxForEngine(autonomous);

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

		if (!anyChanged && !engineSwitched) {
			return;
		}

		record.sessionConfig = isSecretary
			? { ...(secretaryState?.perEngineConfig?.[record.engine] ?? {}) }
			: record.sessionConfig;
		await save();

		if (!fromUiPicker || engineSwitched) {
			await notifySessionOptionsUpdated(sessionType, sessionUri, true);
		} else {
			providerOptionsChangeEmitters.get(sessionType)?.fire();
			const groups = await computeOptionGroupsForResource(sessionType, sessionUri);
			lastNotifiedOptionsSig.set(
				sessionUri.toString(),
				`${sessionType}:${groups.map(g => `${g.id}=${g.selected?.id ?? ''}[${g.items.length}]`).join('|')}`,
			);
		}

		if (syncToAde && !isSecretary) {
			const cfg = record.sessionConfig ?? {};
			void Promise.resolve(vscode.commands.executeCommand('aexus.ade.syncSessionPreferences', {
				resource: sessionUri.toString(),
				model: cfg.model,
				thinking: cfg.thinking,
			})).catch(() => undefined);
		}
	};

	const history = (turns: HistoryEntry[], participant: string): readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] => filterAndCleanHistoryTurns(turns).map(turn => turn.role === 'user'
		? new vscode.ChatRequestTurn2(turn.text, undefined, [], participant, [], undefined, turn.id, undefined, undefined, turn.isSystemInitiated)
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
		if (secretaryState && records.get(secretaryState.recordKey) === record) {
			const secEntry = opened.get(SECRETARY_TYPE);
			if (secEntry && !isRecordBusy(record)) {
				const resolved = await tryRuntimeForRecord(record);
				if (resolved) {
					const turns = await resolved.engine.history(record, secEntry.cancellation.token);
					if (opened.get(SECRETARY_TYPE) === secEntry) {
						secEntry.changed.fire(history(turns, SECRETARY_TYPE));
					}
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
		ensureSecretaryRecord,
		runtimeForRecord,
		tryRuntimeForRecord,
		resolveShortEngine: raw => resolveShortEngine(raw) ?? '',
		setGoalBannerInUi,
		save,
	});

	const send = async (
		record: RecordEntry,
		sessionUri: vscode.Uri,
		isSecretary: boolean,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult> => {
		if (record.readOnly) { throw new Error(vscode.l10n.t('Continue this subagent from its parent conversation.')); }
		record.resourceId ??= record.id;
		const recordKey = identity(record);
		const cloudTarget = !isSecretary && record.cloudProjectUri
			? await ensureRecordCloudReady(record)
			: undefined;

		const trimmedPrompt = request.prompt.trim();
		let parsedCmd = request.command?.trim().toLowerCase();
		let cmdArgText = trimmedPrompt;
		if (!parsedCmd && /^\/[a-zA-Z][\w:-]*(?:\s|$)/.test(trimmedPrompt)) {
			const spaceIdx = trimmedPrompt.indexOf(' ');
			parsedCmd = (spaceIdx === -1 ? trimmedPrompt.slice(1) : trimmedPrompt.slice(1, spaceIdx)).toLowerCase();
			cmdArgText = spaceIdx === -1 ? '' : trimmedPrompt.slice(spaceIdx + 1).trim();
		}

		if (parsedCmd === 'goal') {
			const goalArg = cmdArgText.trim();
			if (!goalArg) {
				if (record.activeGoal) {
					setGoalBannerInUi(sessionUri, record.activeGoal);
					stream.markdown(`### Active Session Goal\n\n> ${record.activeGoal}\n\n- Clear with \`/goal clear\` or set a new goal with \`/goal <condition>\`.`);
				} else {
					stream.markdown('### Autonomous Goal Mode (`/goal`)\n\n- **Set & execute a verified goal**: `/goal <objective or completion condition>`\n- **Clear active goal**: `/goal clear`\n\nWhen active, the session verifies all goal requirements before stopping until `<!-- GOAL_COMPLETE -->` is confirmed.');
				}
				return {};
			}
			if (['clear', 'off', 'none', 'cancel'].includes(goalArg.toLowerCase())) {
				record.activeGoal = undefined;
				setGoalBannerInUi(sessionUri, undefined);
				await save();
				stream.markdown('Cleared active session goal.');
				return {};
			}
			record.activeGoal = goalArg;
			setGoalBannerInUi(sessionUri, goalArg);
			await save();
		}

		if (parsedCmd && parsedCmd !== 'goal') {
			const handledDirectly = await handleDirectSlashCommand(parsedCmd, cmdArgText, record, sessionUri, isSecretary, stream, token, cloudTarget);
			if (handledDirectly) {
				return {};
			}
		}

		const forceKillRecord = async () => {
			const resolved = await tryRuntimeForRecord(record).catch(() => undefined);
			if (resolved) {
				await resolved.engine.killSession?.(record).catch(() => undefined);
			}
		};
		const lease = await turnCoordinator.acquire({
			key: recordKey,
			source: 'ui',
			createCts: () => new vscode.CancellationTokenSource(),
			externalToken: token,
			forceKill: forceKillRecord,
			onPreempt: (_prev, reason) => {
				if (reason === 'headless') {
					stream.progress(vscode.l10n.t('Switching from background task to your message…'));
				} else if (reason === 'cancelled' || reason === 'interrupted') {
					stream.progress(vscode.l10n.t('Stopping previous response…'));
				}
			},
			graceTimeoutMs: 2500,
			turnTimeoutMs: getConfiguredEngineTurnTimeoutMs(),
			idleStallTimeoutMs: getConfiguredEngineIdleStallTimeoutMs(),
		});
		if (!lease) {
			return {};
		}

		const turnCancellation = lease.cts;
		let link: vscode.Disposable | undefined;
		let interactiveTurnBinding: {
			readonly turnId?: string;
			readonly missionId?: string;
			readonly nodeId?: string;
			readonly tokenId?: string;
			readonly autoMintedRootToken?: boolean;
		} | undefined;
		try {
			link = token.onCancellationRequested(() => turnCancellation.cancel());
			if (token.isCancellationRequested) {
				turnCancellation.cancel();
				return {};
			}
			controllers.get(record.engine)?.items.add(item(record));
			if (isSecretary) {
				refreshSecretaryItem();
			}
			const engineType = toEngineType(record.engine);
			const cfg = getSessionConfig(record, isSecretary);
			const caps = getCachedRuntimeCaps(record.engine, record.cwd, cloudTarget?.authority);
			const discoveredCommands = await discoverSlashCommands(isSecretary ? 'secretary' : engineType, engineType, record.cwd, caps.commands, cloudTarget);

			let effectiveUserPrompt: string;
			if (parsedCmd === 'goal') {
				effectiveUserPrompt = cmdArgText;
			} else if (parsedCmd) {
				const matchedTemplateCmd = discoveredCommands.find(c => c.name.toLowerCase() === parsedCmd && c.filePath);
				const expandedTemplate = matchedTemplateCmd ? await readSkillOrCommandTemplate(matchedTemplateCmd, cmdArgText) : undefined;
				const expandedBuiltin = !expandedTemplate ? expandBuiltInWorkflowPrompt(parsedCmd, cmdArgText, engineType) : undefined;
				if (expandedTemplate) {
					effectiveUserPrompt = expandedTemplate;
				} else if (expandedBuiltin) {
					effectiveUserPrompt = expandedBuiltin;
				} else {
					effectiveUserPrompt = `/${parsedCmd}${cmdArgText ? ` ${cmdArgText}` : ''}`;
				}
			} else {
				effectiveUserPrompt = request.prompt;
			}

			const { attachments, fileLines } = extractAttachmentsAndRefs(request.references, cloudTarget);
			const userPromptWithRefs = fileLines.length
				? `${effectiveUserPrompt}\n\n${vscode.l10n.t('Attached files:')}\n${fileLines.join('\n')}`
				: effectiveUserPrompt;

			const preambleSections: string[] = [];
			const liveSnap = isSecretary ? undefined : await refreshRoleSnapshotFromWorkbench();
			const snapForContext = isSecretary ? undefined : (liveSnap ?? roleBridge.getSnapshot()).agents.find(a => a.resource === sessionUri.toString());
			const currentRankForContext = isSecretary
				? 'secretary'
				: ((snapForContext?.isOrchestrated || snapForContext?.isMissionNode) ? snapForContext.rank : undefined);
			let expectedPromptHash = !isSecretary
				? computeStaticRolePromptHash(snapForContext)
				: undefined;
			const alreadyInitializedForRank = Boolean(
				currentRankForContext
				&& record.roleInit
				&& record.roleInit.engine === record.engine
				&& record.roleInit.rank === currentRankForContext
				&& (
					expectedPromptHash
						? record.roleInit.promptHash === expectedPromptHash
						: Boolean(record.roleInit.promptHash)
				),
			);
			const injected = !currentRankForContext
				? undefined
				: await Promise.resolve(vscode.commands.executeCommand<string | undefined>(
					'aexus.ade.resolvePromptContext',
					alreadyInitializedForRank ? { resource: sessionUri, mode: 'delta' } : sessionUri,
				)).catch(() => undefined);
			const trimmedInjected = injected?.trim();
			const supportsSystemCharterFlag = record.engine === 'claude' || record.engine === 'pi';
			let interactiveStaticSystemCharter: string | undefined;
			if (currentRankForContext && supportsSystemCharterFlag) {
				const candidateCharter = isSecretary
					? (extractStaticRoleCharter(!alreadyInitializedForRank ? trimmedInjected : undefined) || record.roleInit?.staticSystemCharter)
					: (extractStaticRoleCharter(snapForContext?.rolePrompt ?? (!alreadyInitializedForRank ? trimmedInjected : undefined), snapForContext?.staticRoleCharter) || record.roleInit?.staticSystemCharter);
				if (candidateCharter) {
					interactiveStaticSystemCharter = candidateCharter;
					expectedPromptHash ??= hashRolePrompt(candidateCharter);
				}
			} else if (!alreadyInitializedForRank && !expectedPromptHash && trimmedInjected) {
				const extractedStatic = extractStaticRoleCharter(trimmedInjected);
				if (extractedStatic) {
					expectedPromptHash = hashRolePrompt(extractedStatic);
				}
			}
			let pendingDeltaContext: string | undefined;
			if (trimmedInjected) {
				const userTurnPreamble = (!alreadyInitializedForRank && interactiveStaticSystemCharter)
					? extractDynamicRoleBindingsTail(trimmedInjected, interactiveStaticSystemCharter)
					: trimmedInjected;
				if (userTurnPreamble && (!alreadyInitializedForRank || userTurnPreamble !== record.lastDeltaContext)) {
					preambleSections.push(userTurnPreamble);
					if (alreadyInitializedForRank) {
						pendingDeltaContext = userTurnPreamble;
					}
				}
			}

			if (record.activeGoal) {
				preambleSections.push([
					`[Autonomous Session Goal Active]`,
					`Goal Condition: ${record.activeGoal}`,
					`- Execute thoroughly and verify all requirements end-to-end before stopping.`,
					`- Only when EVERY requirement of the goal is 100% complete and verified, output the exact completion marker \`${GOAL_COMPLETE_MARKER}\` at the very end of your response.`,
				].join('\n'));
			}

			// Never wrap non-human Role DMs / Baton envelopes / agent-originated directives as `[Aexus System · Message from User (L-1)]`.
			const alreadyEnvelopedOrAgentDirective = hasAexusSystemMessageEnvelope(userPromptWithRefs)
				|| (isSecretary && /^\s*\[(?:Directive|Escalation|Handoff|Baton)\s+from\b/i.test(userPromptWithRefs));
			const shouldWrapAsUserMessage = Boolean(
				isSecretary
				|| snapForContext?.isOrchestrated
				|| snapForContext?.isMissionNode,
			);
			const isDirectUserChat = !isSecretary && !alreadyEnvelopedOrAgentDirective;
			interactiveTurnBinding = !isSecretary && (Boolean(snapForContext?.isMissionNode) || Boolean(snapForContext?.isOrchestrated))
				? await Promise.resolve(vscode.commands.executeCommand<{
					readonly turnId?: string;
					readonly missionId?: string;
					readonly nodeId?: string;
					readonly tokenId?: string;
					readonly autoMintedRootToken?: boolean;
				} | undefined>('aexus.ade.engineering.beginInteractiveTurn', {
					sessionResource: sessionUri.toString(),
					agentId: snapForContext?.id,
					...(isDirectUserChat ? { userPrompt: effectiveUserPrompt, isDirectUserChat: true } : {}),
				})).catch(() => undefined)
				: undefined;
			if (shouldWrapAsUserMessage && !alreadyEnvelopedOrAgentDirective) {
				const rootBaton = interactiveTurnBinding?.autoMintedRootToken
					&& interactiveTurnBinding.tokenId
					&& interactiveTurnBinding.missionId
					&& interactiveTurnBinding.nodeId
					? {
						tokenId: interactiveTurnBinding.tokenId,
						missionId: interactiveTurnBinding.missionId,
						nodeId: interactiveTurnBinding.nodeId,
					}
					: undefined;
				preambleSections.push(buildUserMessageSystemEnvelope(rootBaton));
			}

			const initialFullPrompt = preambleSections.length > 0
				? `${preambleSections.join('\n\n')}\n\n${AEXUS_PREAMBLE_END_MARKER}\n\n${userPromptWithRefs}`
				: userPromptWithRefs;

			if (turnCancellation.token.isCancellationRequested) {
				return {};
			}

			let engine: EngineRuntime;
			if (cloudTarget) {
				const remoteInfo = await resolveRemoteEngineInfo(record.engine, cloudTarget);
				syncRecordCwdWithTarget(record, remoteInfo.target);
				if (!remoteInfo.command) {
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
					stream.markdown(buildMissingEngineMarkdown(record.engine, available));
					promptConfigureCliPaths(formatMissingEngineMessage(record.engine, available));
					return {};
				}
				engine = runtime(record.engine);
			}
			const snapEntry = roleBridge.getSnapshot().agents.find(a => a.resource === sessionUri.toString()) ?? snapForContext;
			const isMissionNode = !isSecretary && Boolean(snapEntry?.isMissionNode);
			const callerRole = isSecretary
				? 'secretary'
				: (!snapEntry?.isOrchestrated && !isMissionNode ? undefined : snapEntry?.rank);
			let contextCompactedDuringTurn = false;
			const interactiveInjectedContract = (!alreadyInitializedForRank || pendingDeltaContext !== undefined) ? trimmedInjected : undefined;
			const interactiveReportedSoFar = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };
			let interactiveToolErrorCount = 0;
			let lastInteractiveInterimAt = 0;
			const reportInteractiveInterimUsage = isSecretary ? undefined : (cumulative: EngineTurnTokenUsage) => {
				const now = Date.now();
				if (now - lastInteractiveInterimAt < 1200) {
					return;
				}
				const delta = {
					inputTokens: Math.max(0, cumulative.inputTokens - interactiveReportedSoFar.inputTokens),
					outputTokens: Math.max(0, cumulative.outputTokens - interactiveReportedSoFar.outputTokens),
					cacheReadTokens: Math.max(0, (cumulative.cacheReadTokens ?? 0) - interactiveReportedSoFar.cacheReadTokens),
					cacheWriteTokens: Math.max(0, (cumulative.cacheWriteTokens ?? 0) - interactiveReportedSoFar.cacheWriteTokens),
					totalTokens: Math.max(0, cumulative.totalTokens - interactiveReportedSoFar.totalTokens),
				};
				if (delta.totalTokens === 0 && delta.inputTokens === 0 && delta.outputTokens === 0) {
					return;
				}
				lastInteractiveInterimAt = now;
				interactiveReportedSoFar.inputTokens += delta.inputTokens;
				interactiveReportedSoFar.outputTokens += delta.outputTokens;
				interactiveReportedSoFar.cacheReadTokens += delta.cacheReadTokens;
				interactiveReportedSoFar.cacheWriteTokens += delta.cacheWriteTokens;
				interactiveReportedSoFar.totalTokens += delta.totalTokens;
				let deltaCostUsd: number | undefined;
				if (typeof cumulative.costUsd === 'number' && Number.isFinite(cumulative.costUsd) && cumulative.costUsd > interactiveReportedSoFar.costUsd) {
					deltaCostUsd = Math.round((cumulative.costUsd - interactiveReportedSoFar.costUsd) * 1_000_000) / 1_000_000;
					interactiveReportedSoFar.costUsd = cumulative.costUsd;
				}
				const segments = computeMeasuredContextSegments({
					injectedContractText: interactiveInjectedContract,
					rawPrompt: userPromptWithRefs,
					finalPrompt: initialFullPrompt,
					appendSystemPrompt: interactiveStaticSystemCharter,
					usage: cumulative,
					isFirstTurn: !alreadyInitializedForRank,
				});
				const effectiveToolErrors = Math.max(interactiveToolErrorCount, cumulative.toolErrorCount ?? 0);
				const effectiveModel = cumulative.model || (cfg?.model && cfg.model !== 'default' ? cfg.model : undefined);
				void Promise.resolve(vscode.commands.executeCommand('aexus.ade.engineering.recordTurnUsage', {
					sessionResource: sessionUri.toString(),
					agentId: snapEntry?.id,
					...(interactiveTurnBinding?.turnId ? { turnId: interactiveTurnBinding.turnId } : {}),
					...(interactiveTurnBinding?.missionId ? { missionId: interactiveTurnBinding.missionId } : {}),
					...(interactiveTurnBinding?.nodeId ? { nodeId: interactiveTurnBinding.nodeId } : {}),
					...(interactiveTurnBinding?.tokenId ? { tokenId: interactiveTurnBinding.tokenId } : {}),
					usage: {
						...delta,
						...segments,
						...(deltaCostUsd !== undefined ? { costUsd: deltaCostUsd } : {}),
						...(effectiveToolErrors > 0 || cumulative.hadToolError ? { hadToolError: true, toolErrorCount: Math.max(1, effectiveToolErrors) } : {}),
						model: effectiveModel,
						engineId: record.engine,
						turns: 0,
						...(cumulative.estimated !== undefined ? { estimated: cumulative.estimated } : {}),
					},
				})).catch(() => undefined);
			};
			let lastHeartbeatSent = 0;
			const emitHeartbeat = () => {
				lease.touchActivity();
				const now = Date.now();
				if (now - lastHeartbeatSent >= 1500) {
					lastHeartbeatSent = now;
					void Promise.resolve(vscode.commands.executeCommand('aexus.ade.engineering.workerHeartbeat', sessionUri.toString(), now)).catch(() => undefined);
				}
			};
			const sendOptions = toSendOptions(cfg, {
				attachments,
				pureWorker: !isSecretary && !snapEntry?.isOrchestrated && !isMissionNode,
				callerRole,
				isMissionNode,
				adeSessionId: isSecretary ? '__secretary__' : snapEntry?.id,
				onInterimUsage: reportInteractiveInterimUsage,
				onContextCompacted: () => {
					contextCompactedDuringTurn = true;
					record.roleInit = undefined;
					record.lastDeltaContext = undefined;
				},
				abortSignal: lease.abortSignal,
				timeoutMs: getConfiguredEngineTurnTimeoutMs(),
				appendSystemPrompt: interactiveStaticSystemCharter,
				onStreamActivity: emitHeartbeat,
				onExternalWaitStart: () => lease.beginExternalWait(),
				onExternalWaitEnd: () => lease.endExternalWait(),
			});
			const prevId = record.id;
			if (engine.prepareSession) {
				await engine.prepareSession(record, sendOptions, turnCancellation.token);
				syncRecordStorageKey(record, prevId);
				await save();
			}
			if (turnCancellation.token.isCancellationRequested) {
				return {};
			}
			let streamedMarkdown = '';
			let roundMarkdown = '';
			let pendingGoalText = '';
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
			const findMarkerPrefixTailLength = (text: string): number => {
				const maxLen = Math.min(text.length, GOAL_COMPLETE_MARKER.length);
				for (let len = maxLen; len >= 1; len--) {
					const suffix = text.slice(text.length - len);
					if (GOAL_COMPLETE_MARKER.startsWith(suffix)) {
						return len;
					}
				}
				return 0;
			};
			const flushPendingGoalText = (finalFlush: boolean) => {
				if (!pendingGoalText) {
					return;
				}
				pendingGoalText = pendingGoalText.replace(new RegExp(`\\n*${GOAL_COMPLETE_MARKER}\\s*`, 'g'), '');
				if (!pendingGoalText) {
					return;
				}
				if (finalFlush || !record.activeGoal) {
					const out = pendingGoalText;
					pendingGoalText = '';
					if (out) {
						streamedMarkdown += out;
						stream.markdown(out);
					}
					return;
				}
				const holdLen = findMarkerPrefixTailLength(pendingGoalText);
				let totalHold = holdLen;
				if (holdLen > 0) {
					while (totalHold < pendingGoalText.length && totalHold - holdLen < 2 && pendingGoalText[pendingGoalText.length - totalHold - 1] === '\n') {
						totalHold++;
					}
				}
				const safeLen = pendingGoalText.length - totalHold;
				if (safeLen > 0) {
					const safeOut = pendingGoalText.slice(0, safeLen);
					pendingGoalText = pendingGoalText.slice(safeLen);
					streamedMarkdown += safeOut;
					stream.markdown(safeOut);
				}
			};
			const interactiveErrorScanner = createStreamToolErrorScanner();
			const proxyTarget: vscode.ChatResponseStream = Object.create(null);
			const wrappedStream: vscode.ChatResponseStream = new Proxy(proxyTarget, {
				get(_dummy, prop) {
					if (prop === 'markdown') {
						return (value: string | vscode.MarkdownString) => {
							const chunkText = typeof value === 'string' ? value : value.value;
							if (chunkText) {
								if (interactiveErrorScanner.scan(chunkText)) {
									interactiveToolErrorCount += 1;
								}
								roundMarkdown += chunkText;
								emitHeartbeat();
							}
							if (!record.activeGoal) {
								if (chunkText) {
									streamedMarkdown += chunkText;
								}
								stream.markdown(value);
								return;
							}
							if (typeof value === 'string') {
								pendingGoalText += value;
								flushPendingGoalText(false);
							} else {
								flushPendingGoalText(true);
								const cleaned = value.value.replace(new RegExp(`\\n*${GOAL_COMPLETE_MARKER}\\s*`, 'g'), '');
								if (cleaned) {
									streamedMarkdown += cleaned;
									const copy = new vscode.MarkdownString(cleaned, value.supportThemeIcons);
									copy.isTrusted = value.isTrusted;
									copy.supportHtml = value.supportHtml;
									copy.baseUri = value.baseUri;
									stream.markdown(copy);
								}
							}
						};
					}
					if (prop === 'progress') {
						return (value: string) => {
							if (detectToolErrorInProgressText(value)) {
								interactiveToolErrorCount += 1;
							}
							emitHeartbeat();
							emitThrottledCloudRefresh();
							stream.progress(value);
						};
					}
					if (prop === 'push') {
						return (part: vscode.ChatResponsePart) => {
							if (detectToolErrorInStreamPart(part)) {
								interactiveToolErrorCount += 1;
							}
							emitHeartbeat();
							stream.push(part);
						};
					}
					const val = Reflect.get(stream, prop, stream);
					return typeof val === 'function' ? val.bind(stream) : val;
				},
			});
			lastTurnErrors.delete(identity(record));
			if (isSecretary) {
				lastTurnErrors.delete(SECRETARY_TYPE);
			}

			const turnStartedAt = Date.now();
			const preSendId = record.id;
			await engine.send(record, initialFullPrompt, wrappedStream, turnCancellation.token, sendOptions);
			syncRecordStorageKey(record, preSendId);
			flushPendingGoalText(true);

			let accumulatedGoalUsage: EngineTurnTokenUsage | undefined;
			const mergeGoalRoundUsage = (prev: EngineTurnTokenUsage | undefined, next: EngineTurnTokenUsage): EngineTurnTokenUsage => !prev ? next : {
				inputTokens: prev.inputTokens + next.inputTokens,
				outputTokens: prev.outputTokens + next.outputTokens,
				cacheReadTokens: (prev.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
				cacheWriteTokens: (prev.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
				totalTokens: prev.totalTokens + next.totalTokens,
				durationMs: (prev.durationMs ?? 0) + (next.durationMs ?? 0),
				...(prev.costUsd !== undefined || next.costUsd !== undefined ? { costUsd: (prev.costUsd ?? 0) + (next.costUsd ?? 0) } : {}),
				...(prev.hadToolError || next.hadToolError ? { hadToolError: true, toolErrorCount: (prev.toolErrorCount ?? 0) + (next.toolErrorCount ?? 0) } : {}),
				model: next.model ?? prev.model,
				estimated: Boolean(prev.estimated && next.estimated),
			};

			let goalRound = 1;
			while (
				record.activeGoal
				&& !turnCancellation.token.isCancellationRequested
				&& !roundMarkdown.includes(GOAL_COMPLETE_MARKER)
				&& goalRound < MAX_GOAL_ROUNDS
			) {
				if (goalRound === 1) {
					accumulatedGoalUsage = resolveCompletedTurnUsage(engine, record.id, initialFullPrompt, roundMarkdown, turnStartedAt);
				}
				goalRound++;
				const currentGoal = record.activeGoal;
				stream.progress(`Verifying autonomous goal completion (Round ${goalRound}/${MAX_GOAL_ROUNDS})…`);
				stream.markdown(`\n\n---\n*Goal Check (Round ${goalRound}/${MAX_GOAL_ROUNDS})*\n\n`);
				roundMarkdown = '';
				const goalContextDelta = interactiveStaticSystemCharter ? pendingDeltaContext : injected?.trim();
				const continuationPrompt = [
					...(goalContextDelta ? [goalContextDelta, ''] : []),
					`[Autonomous Goal Stop-Check — Round ${goalRound}/${MAX_GOAL_ROUNDS}]`,
					`Active Goal: ${currentGoal}`,
					`You stopped without emitting \`${GOAL_COMPLETE_MARKER}\`.`,
					`1. Audit every requirement of the Active Goal against actual workspace state and verification results.`,
					`2. If ANY work, edge case, or verification remains incomplete, complete it right now.`,
					`3. Once 100% of the Active Goal is verified complete, summarize the final verified state and end with \`${GOAL_COMPLETE_MARKER}\`.`,
				].join('\n');
				const roundStartedAt = Date.now();
				const preGoalId = record.id;
				await engine.send(record, continuationPrompt, wrappedStream, turnCancellation.token, {
					...sendOptions,
					attachments: undefined,
				});
				syncRecordStorageKey(record, preGoalId);
				flushPendingGoalText(true);
				accumulatedGoalUsage = mergeGoalRoundUsage(
					accumulatedGoalUsage,
					resolveCompletedTurnUsage(engine, record.id, continuationPrompt, roundMarkdown, roundStartedAt),
				);
			}

			if (record.activeGoal && roundMarkdown.includes(GOAL_COMPLETE_MARKER)) {
				record.activeGoal = undefined;
				setGoalBannerInUi(sessionUri, undefined);
			}

			const turnUsage = accumulatedGoalUsage ?? resolveCompletedTurnUsage(engine, record.id, initialFullPrompt, streamedMarkdown, turnStartedAt);
			if (!isSecretary && turnUsage.totalTokens > 0) {
				const segments = computeMeasuredContextSegments({
					injectedContractText: interactiveInjectedContract,
					rawPrompt: userPromptWithRefs,
					finalPrompt: initialFullPrompt,
					appendSystemPrompt: interactiveStaticSystemCharter,
					usage: turnUsage,
					isFirstTurn: !alreadyInitializedForRank,
				});
				const finalCostUsd = typeof turnUsage.costUsd === 'number' && Number.isFinite(turnUsage.costUsd)
					? Math.max(0, Math.round((turnUsage.costUsd - interactiveReportedSoFar.costUsd) * 1_000_000) / 1_000_000)
					: undefined;
				const finalInteractiveToolErrors = Math.max(interactiveToolErrorCount, turnUsage.toolErrorCount ?? 0);
				const finalDeltaUsage = {
					inputTokens: Math.max(0, turnUsage.inputTokens - interactiveReportedSoFar.inputTokens),
					outputTokens: Math.max(0, turnUsage.outputTokens - interactiveReportedSoFar.outputTokens),
					cacheReadTokens: Math.max(0, (turnUsage.cacheReadTokens ?? 0) - interactiveReportedSoFar.cacheReadTokens),
					cacheWriteTokens: Math.max(0, (turnUsage.cacheWriteTokens ?? 0) - interactiveReportedSoFar.cacheWriteTokens),
					totalTokens: Math.max(0, turnUsage.totalTokens - interactiveReportedSoFar.totalTokens),
					...segments,
					durationMs: turnUsage.durationMs,
					...(finalCostUsd !== undefined ? { costUsd: finalCostUsd } : {}),
					...(finalInteractiveToolErrors > 0 || turnUsage.hadToolError ? { hadToolError: true, toolErrorCount: Math.max(1, finalInteractiveToolErrors) } : {}),
					model: turnUsage.model || (cfg?.model && cfg.model !== 'default' ? cfg.model : undefined),
					engineId: record.engine,
					turns: 1,
					estimated: turnUsage.estimated,
				};
				void Promise.resolve(vscode.commands.executeCommand('aexus.ade.engineering.recordTurnUsage', {
					sessionResource: sessionUri.toString(),
					agentId: snapEntry?.id,
					...(interactiveTurnBinding?.turnId ? { turnId: interactiveTurnBinding.turnId } : {}),
					...(interactiveTurnBinding?.missionId ? { missionId: interactiveTurnBinding.missionId } : {}),
					...(interactiveTurnBinding?.nodeId ? { nodeId: interactiveTurnBinding.nodeId } : {}),
					...(interactiveTurnBinding?.tokenId ? { tokenId: interactiveTurnBinding.tokenId } : {}),
					usage: finalDeltaUsage,
				})).catch(() => undefined);
			}

			if (streamedMarkdown.trim()) {
				lastTurnReplies.set(identity(record), streamedMarkdown.trim());
				if (isSecretary) {
					lastTurnReplies.set(SECRETARY_TYPE, streamedMarkdown.trim());
				}
			}
			if (parsedCmd === 'compact' || parsedCmd === 'smol' || contextCompactedDuringTurn) {
				record.roleInit = undefined;
				record.lastDeltaContext = undefined;
			} else if (!alreadyInitializedForRank && currentRankForContext && !turnCancellation.token.isCancellationRequested) {
				record.roleInit = {
					rank: currentRankForContext,
					engine: record.engine,
					promptHash: expectedPromptHash ?? hashRolePrompt(trimmedInjected),
					...(interactiveStaticSystemCharter ? { staticSystemCharter: interactiveStaticSystemCharter } : {}),
					initializedAt: Date.now(),
				};
				record.lastDeltaContext = undefined;
			} else if (pendingDeltaContext !== undefined && !turnCancellation.token.isCancellationRequested) {
				record.lastDeltaContext = pendingDeltaContext;
			}
			record.updated = Date.now();
			if (!isSecretary && !record.customLabel && record.initialTitle && record.label === record.initialTitle) {
				const titleSource = parsedCmd === 'goal' ? `/goal ${cmdArgText}` : effectiveUserPrompt;
				record.label = titleSource.split('\n')[0].slice(0, 100) || record.label;
			}
			void fetchRuntimeCaps(record.engine, record.cwd, record).then(({ changed }) => {
				if (changed) {
					void notifySessionOptionsUpdated(isSecretary ? SECRETARY_TYPE : engineType, sessionUri, true);
					customizationChangedEmitter.fire();
				}
			});
			return {};
		} catch (error) {
			if (token.isCancellationRequested || turnCancellation.token.isCancellationRequested || error instanceof vscode.CancellationError) { return {}; }
			const errText = error instanceof Error ? error.message : String(error);
			lastTurnErrors.set(identity(record), errText);
			if (isSecretary) {
				lastTurnErrors.set(SECRETARY_TYPE, errText);
			}
			throw error;
		} finally {
			if (interactiveTurnBinding?.turnId) {
				void Promise.resolve(vscode.commands.executeCommand('aexus.ade.engineering.endInteractiveTurn', { turnId: interactiveTurnBinding.turnId })).catch(() => undefined);
			}
			lease.markSettling();
			link?.dispose();
			turnCancellation.dispose();
			turnCoordinator.release(lease);
			if (records.has(key(record.engine, record.id)) || [...records.values()].includes(record)) {
				controllers.get(record.engine)?.items.add(item(record));
			}
			if (isSecretary) {
				refreshSecretaryItem();
			}
			notifyCloudProjectMutated(record.cloudProjectUri);
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
					const isSec = sessionType === SECRETARY_TYPE || sessionResource.scheme === SECRETARY_TYPE;
					const rec = findCachedRecord(sessionResource) ?? (isSec ? await ensureSecretaryRecord().catch(() => undefined) : undefined);
					const shortEng = rec?.engine ?? (isSec ? (resolveShortEngine() ?? 'claude') : sessionType.slice('aexus-'.length));
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

	const aexusAppIconUri = vscode.Uri.joinPath(context.extensionUri, 'resources/aexus-icon.svg');
	const secretaryOptEmitter = new vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent>();
	const secretaryProviderOptEmitter = new vscode.EventEmitter<void>();
	optionChangeEmitters.set(SECRETARY_TYPE, secretaryOptEmitter);
	providerOptionsChangeEmitters.set(SECRETARY_TYPE, secretaryProviderOptEmitter);
	context.subscriptions.push(secretaryOptEmitter, secretaryProviderOptEmitter);

	const secretaryParticipant = vscode.chat.createChatParticipant(SECRETARY_TYPE, async (request, _chatContext, stream, token) => {
		const secRecord = await ensureSecretaryRecord();
		return send(secRecord, SECRETARY_URI, true, request, stream, token);
	});
	secretaryParticipant.iconPath = { light: aexusAppIconUri, dark: aexusAppIconUri };
	secretaryController.getChatSessionInputState = async sessionResource => {
		const secRecord = findCachedRecord(SECRETARY_URI);
		const shortEng = secRecord?.engine ?? resolveShortEngine() ?? 'claude';
		scheduleRuntimeCapsRefresh(shortEng, secRecord?.cwd ?? defaultCwd(), secRecord, SECRETARY_TYPE, sessionResource ?? SECRETARY_URI);
		const groups = await computeOptionGroupsForResource(SECRETARY_TYPE, sessionResource ?? SECRETARY_URI);
		return trackInputState(SECRETARY_TYPE, secretaryController!, groups);
	};
	registerCustomizationProviderForType(SECRETARY_TYPE, 'Secretary', 'hubot');
	context.subscriptions.push(
		secretaryParticipant,
		secretaryController,
		vscode.chat.registerChatSessionContentProvider(SECRETARY_TYPE, {
			onDidChangeChatSessionOptions: secretaryOptEmitter.event,
			onDidChangeChatSessionProviderOptions: secretaryProviderOptEmitter.event,
			provideChatSessionProviderOptions: async () => {
				const secRecord = findCachedRecord(SECRETARY_URI);
				const shortEng = secRecord?.engine ?? resolveShortEngine() ?? 'claude';
				scheduleRuntimeCapsRefresh(shortEng, secRecord?.cwd ?? defaultCwd(), secRecord, SECRETARY_TYPE, SECRETARY_URI);
				const groups = await computeOptionGroupsForResource(SECRETARY_TYPE, SECRETARY_URI);
				return {
					optionGroups: groups,
					newSessionOptions: toSessionOptionsRecord(groups),
				};
			},
			provideHandleOptionsChange: (uri, updates) => {
				void applyOptionUpdates(SECRETARY_TYPE, uri, updates, true, true);
			},
			provideChatSessionContent: async (_uri, token) => {
				const secRecord = await ensureSecretaryRecord();
				const turns = (await ensureEngineCommand(secRecord.engine))
					? await runtime(secRecord.engine).history(secRecord, token).catch(() => [] as HistoryEntry[])
					: [];
				await save();
				scheduleRuntimeCapsRefresh(secRecord.engine, secRecord.cwd, secRecord, SECRETARY_TYPE, SECRETARY_URI, true);
				const groups = await computeOptionGroupsForResource(SECRETARY_TYPE, SECRETARY_URI);
				if (secRecord.activeGoal) {
					setTimeout(() => setGoalBannerInUi(SECRETARY_URI, secRecord.activeGoal), 80);
				}
				const entry = { changed: new vscode.EventEmitter<vscode.ChatSession['history']>(), cancellation: new vscode.CancellationTokenSource() };
				opened.set(SECRETARY_TYPE, entry);
				return {
					title: 'Secretary',
					options: toSessionOptionsRecord(groups),
					history: history(turns, SECRETARY_TYPE),
					onDidChangeHistory: entry.changed.event,
					requestHandler: async (request, _chatContext, stream, reqToken) => {
						const liveRecord = await ensureSecretaryRecord();
						return send(liveRecord, SECRETARY_URI, true, request, stream, reqToken);
					},
					dispose: () => {
						entry.cancellation.cancel();
						entry.cancellation.dispose();
						entry.changed.dispose();
						if (opened.get(SECRETARY_TYPE) === entry) { opened.delete(SECRETARY_TYPE); }
					},
				};
			},
		}, secretaryParticipant, { supportsInterruptions: true }),
	);
	refreshSecretaryItem();

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
			return send(await getRecord(uri, token), uri, false, request, stream, token);
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
				const sampleRec = [...records.values()].find(r => r.engine === definition.id && !r.unmaterialized && !r.provisional);
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
				if (record.cloudProjectUri) {
					await ensureRecordCloudReady(record).catch(() => undefined);
				} else {
					lastActiveCwdByType.set(definition.type, record.cwd);
				}
				const resolved = await tryRuntimeForRecord(record);
				const turns = resolved
					? await resolved.engine.history(record, token).catch(() => [] as HistoryEntry[])
					: [];
				await save();
				scheduleRuntimeCapsRefresh(record.engine, record.cwd, record, definition.type, uri, true);
				const groups = await computeOptionGroupsForResource(definition.type, uri);
				if (record.activeGoal) {
					setTimeout(() => setGoalBannerInUi(uri, record.activeGoal), 80);
				}
				const entry = { changed: new vscode.EventEmitter<vscode.ChatSession['history']>(), cancellation: new vscode.CancellationTokenSource() };
				opened.set(identity(record), entry);
				return {
					title: record.label,
					options: toSessionOptionsRecord(groups),
					history: history(turns, participantId),
					onDidChangeHistory: entry.changed.event,
					requestHandler: record.readOnly ? undefined : (request, _chatContext, stream, reqToken) => send(record, uri, false, request, stream, reqToken),
					dispose: () => {
						entry.cancellation.cancel();
						entry.cancellation.dispose();
						entry.changed.dispose();
						if (opened.get(identity(record)) === entry) { opened.delete(identity(record)); }
					},
				};
			},
		}, participant, { supportsInterruptions: true }));
		refresh(definition.id);
	}

	if (available.some(entry => entry.id === 'antigravity' && entry.command) && !(runtimeCapsCache.get('antigravity:*')?.models?.length)) {
		scheduleRuntimeCapsRefresh('antigravity', defaultCwd(), undefined, 'aexus-antigravity', undefined, true);
	}

	context.subscriptions.push(vscode.commands.registerCommand('aexus.agents.selectCustomModel', async (firstArg?: unknown, secondArg?: unknown) => {
		const sessionUri = firstArg instanceof vscode.Uri ? firstArg : undefined;
		const fallbackType = typeof firstArg === 'string' ? firstArg : typeof secondArg === 'string' ? secondArg : undefined;
		const sessionType = sessionUri
			? (sessionUri.scheme === SECRETARY_TYPE ? SECRETARY_TYPE : toEngineType(sessionUri.scheme))
			: (fallbackType ?? SECRETARY_TYPE);
		const targetUri = sessionUri ?? SECRETARY_URI;
		const isSec = sessionType === SECRETARY_TYPE || targetUri.scheme === SECRETARY_TYPE;
		const rec = findCachedRecord(targetUri) ?? (isSec ? await ensureSecretaryRecord().catch(() => undefined) : undefined);
		const currentCfg = rec ? getSessionConfig(rec, isSec) : undefined;
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
		await applyOptionUpdates(sessionType, targetUri, [{ optionId: 'model', value: normalized }], true, false);
	}));

	const engineeringBridge = registerEngineeringAndRoleBridge({
		context,
		roleBridge,
		records,
		controllers,
		turnCoordinator,
		lastTurnReplies,
		lastTurnErrors,
		getSecretaryState: () => secretaryState,
		defaultCwd,
		key,
		identity,
		item,
		syncRecordStorageKey,
		refreshSecretaryItem,
		findCachedRecord,
		getRecord,
		runtimeForRecord,
		tryRuntimeForRecord,
		getCachedRuntimeCaps,
		notifySessionOptionsUpdated,
		notifyCloudProjectMutated,
		publishHistory,
		save,
	});
	refreshRoleSnapshotFromWorkbench = engineeringBridge.refreshRoleSnapshotFromWorkbench;

	const deleteRecordAndDescendants = async (record: RecordEntry, token: vscode.CancellationToken, deletedKeys: Set<string>): Promise<number> => {
		const recordKey = key(record.engine, record.id);
		if (deletedKeys.has(recordKey) || recordKey === secretaryState?.recordKey) {
			return 0;
		}
		await turnCoordinator.forceRelease(identity(record));
		opened.get(identity(record))?.cancellation.cancel();
		const rootResolved = await tryRuntimeForRecord(record).catch(() => undefined);
		if (rootResolved) {
			await rootResolved.engine.delete(record, token).catch(() => { });
		}
		const removedIds = new Set<string>([record.id]);
		if (record.resourceId) { removedIds.add(record.resourceId); }
		let expanded = true;
		while (expanded) {
			expanded = false;
			for (const candidate of records.values()) {
				const candidateKey = key(candidate.engine, candidate.id);
				if (candidateKey === secretaryState?.recordKey) { continue; }
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
			if (entryKey === secretaryState?.recordKey) { continue; }
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
				engineeringBridge.evictSyncedAgentPrefs(candUriStr);
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
		vscode.commands.registerCommand('aexus.agentEngines.clearSessionGoal', async (rawUri?: vscode.Uri | string) => {
			if (!rawUri) {
				return;
			}
			const uri = typeof rawUri === 'string' ? vscode.Uri.parse(rawUri) : rawUri;
			const rec = findCachedRecord(uri);
			if (rec && rec.activeGoal) {
				rec.activeGoal = undefined;
				await save();
			}
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
		vscode.commands.registerCommand('aexus.agentEngines.ensureSecretary', async (rawEngineId?: string, project?: vscode.Uri, forceReset?: boolean) => {
			const secRecord = await ensureSecretaryRecord(rawEngineId, project, Boolean(forceReset));
			scheduleRuntimeCapsRefresh(secRecord.engine, secRecord.cwd, secRecord, SECRETARY_TYPE, SECRETARY_URI, true);
			void notifySessionOptionsUpdated(SECRETARY_TYPE, SECRETARY_URI, true);
			customizationChangedEmitter.fire();
			return {
				engineId: `aexus-${secRecord.engine}`,
				resource: SECRETARY_URI,
			};
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
						const remoteSessions = await runtimeForCloud(engine, effectiveTarget, info.command).list(token.token, remoteCwd).catch(err => {
							console.warn(`[aexus-agents] remote attach scan failed (${engine}@${effectiveTarget.alias}):`, err);
							return [] as NativeSession[];
						});
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
						const remoteSessions = await runtimeForCloud(engine, effectiveTarget, info.command).list(token.token, requestedRemoteCwd).catch(err => {
							console.warn(`[aexus-agents] remote session scan failed (${engine}@${effectiveTarget.alias}):`, err);
							return [] as NativeSession[];
						});
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
						.filter(record => record.engine === engine && !record.parentId && recordCloudAuthority(record) === effectiveTarget.authority)
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
					if (record.parentId) { continue; }
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
					activeGoal: record.activeGoal,
				};
			} finally { token.dispose(); }
		}),
		vscode.commands.registerCommand('aexus.agentEngines.history', async (uri: vscode.Uri, limit?: number) => {
			const token = new vscode.CancellationTokenSource();
			try {
				const record = await getRecord(uri, token.token);
				const resolved = await tryRuntimeForRecord(record);
				const rawTurns = resolved
					? await resolved.engine.history(record, token.token).catch(() => [] as HistoryEntry[])
					: [];
				const turns = filterAndCleanHistoryTurns(rawTurns);
				const messages = turns.map(entry => ({ role: entry.role, text: entry.text }));
				const cachedLast = uri.scheme === SECRETARY_TYPE
					? (lastTurnReplies.get(SECRETARY_TYPE) ?? lastTurnReplies.get(identity(record)))
					: lastTurnReplies.get(identity(record));
				const cachedNorm = cachedLast ? cachedLast.replace(/\s+/g, '') : '';
				let cachedAlreadyPresent = false;
				if (cachedNorm) {
					const norm = (s: string) => s.replace(/\s+/g, '');
					if (messages.some(m => m.role === 'assistant' && norm(m.text) === cachedNorm)) {
						cachedAlreadyPresent = true;
					} else {
						let lastUserIdx = -1;
						for (let i = messages.length - 1; i >= 0; i--) {
							if (messages[i].role === 'user') {
								lastUserIdx = i;
								break;
							}
						}
						const trailingAssistant = messages.slice(lastUserIdx + 1).filter(m => m.role === 'assistant');
						const trailingJoined = norm(trailingAssistant.map(m => m.text).join(''));
						if (
							trailingJoined.length > 0
							&& (
								trailingJoined === cachedNorm
								|| (trailingJoined.length >= cachedNorm.length * 0.85 && (trailingJoined.includes(cachedNorm) || cachedNorm.includes(trailingJoined)))
							)
						) {
							cachedAlreadyPresent = true;
						}
					}
				}
				if (cachedLast && !cachedAlreadyPresent) {
					messages.push({ role: 'assistant', text: cachedLast });
				}
				const cachedError = uri.scheme === SECRETARY_TYPE
					? (lastTurnErrors.get(SECRETARY_TYPE) ?? lastTurnErrors.get(identity(record)))
					: lastTurnErrors.get(identity(record));
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
			const stopped = await turnCoordinator.stop(identity(record), 2000);
			if (stopped) {
				controllers.get(record.engine)?.items.add(item(record));
				if (secretaryState && records.get(secretaryState.recordKey) === record) {
					refreshSecretaryItem();
				}
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
				if (engineName && sessionId) {
					const snapAgent = roleBridge.getSnapshot().agents.find(a => a.resource === uri.toString());
					const parsedSnapProject = snapAgent?.projectPath ? parseCloudProjectUri(snapAgent.projectPath) : undefined;
					const hostAlias = options?.hostAlias?.trim() || parsedSnapProject?.authority;
					if (hostAlias) {
						const target = await resolveCloudHostTarget(hostAlias).catch(() => undefined);
						if (target && target.os !== 'windows') {
							await terminateRemotePersistentSessionsByPrefix(
								target,
								buildRemotePersistentPrefix(engineName, sessionId),
								{ killTree: true },
							).catch(() => undefined);
							return { killed: true };
						}
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
			if (secretaryState && records.get(secretaryState.recordKey) === record) {
				refreshSecretaryItem();
			}
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
						if (key(candidate.engine, candidate.id) === secretaryState?.recordKey) { continue; }
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
					await Promise.allSettled(
						available
							.filter(entry => entry.command)
							.map(entry => Promise.race([
								list(entry.id, token.token).catch(() => []),
								new Promise<RecordEntry[]>(resolve => setTimeout(() => resolve([]), 3000)),
							])),
					);
					for (const candidate of records.values()) {
						if (key(candidate.engine, candidate.id) === secretaryState?.recordKey) { continue; }
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
