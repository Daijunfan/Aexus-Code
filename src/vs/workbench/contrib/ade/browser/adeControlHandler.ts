/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import {
	AdeCloudHostOs,
	AEXUS_SSH_SCHEME,
	buildCloudProjectUri,
	IAdeCloudHost,
	IAdeCloudHostBackendService,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	ADE_CANCEL_TICKET_TURNS_COMMAND_ID,
	ADE_DISPATCH_TICKET_TURN_COMMAND_ID,
	ADE_DISPOSE_AGENT_RUNTIME_COMMAND_ID,
	ADE_GET_WINDOW_ID_COMMAND_ID,
	ADE_SYNC_SESSION_PREFERENCES_COMMAND_ID,
} from '../../../../platform/ade/common/adeControl.js';
import {
	IAdeAgentLaunchBundle,
	IAdeAgentRuntimeDisposeEvent,
	IAdeControlCenterService,
	IAdeOutboxDeliveryItem,
} from '../../../../platform/ade/common/adeControlCenterIpc.js';
import {
	AdeTicketDeliveryMode,
	IAdeProjectHostEntry,
	isAdeEffortLevel,
} from '../../../../platform/ade/common/adeModels.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService, ServiceIdentifier, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IChatService, ResponseModelState } from '../../chat/common/chatService/chatService.js';
import { IChatModel } from '../../chat/common/model/chatModel.js';
import {
	ADE_TRY_NATIVE_IN_STREAM_STEER_COMMAND_ID,
	ADE_TRY_SEND_OPEN_CHAT_REQUEST_COMMAND_ID,
	buildAdeEmployeeSessionUri,
	IAdeEditorService,
	normalizeAdeShortEngineId,
	parseAdeEmployeeSessionUri,
} from '../common/ade.js';
import {
	clearAdeAgentContextUsage,
	IAdeTurnTokenUsagePayload,
	recordAdeTurnContextUsage,
} from './adeContextUsageTracker.js';

const AEXUS_AGENTS_EXTENSION_ID = new ExtensionIdentifier('aexus.aexus-agents');
const EXT_DISPATCH_TICKET_TURN_CMD = 'aexus.agentEngines.dispatchTicketTurn';
const EXT_CANCEL_TICKET_TURNS_CMD = 'aexus.agentEngines.cancelTicketTurns';
const EXT_DISPOSE_AGENT_RUNTIME_CMD = 'aexus.agentEngines.disposeAgentRuntime';
const EXT_SYNC_CACHED_EMPLOYEE_META_CMD = 'aexus.ade.syncCachedEmployeeMeta';
const EXT_REFRESH_CLI_PATHS_CMD = 'aexus.agentEngines.refreshCliPaths';

function tryGetService<T>(accessor: ServicesAccessor, id: ServiceIdentifier<T>): T | undefined {
	try {
		return accessor.get(id);
	} catch {
		return undefined;
	}
}

function registerCommandSafe(id: string, handler: (accessor: ServicesAccessor, ...args: unknown[]) => unknown): void {
	if (!CommandsRegistry.getCommand(id)) {
		CommandsRegistry.registerCommand(id, handler);
	}
}

function toUri(raw: unknown): URI | undefined {
	if (!raw) {
		return undefined;
	}
	if (URI.isUri(raw)) {
		return raw;
	}
	if (typeof raw === 'string' && raw.trim()) {
		try {
			return URI.parse(raw.trim());
		} catch {
			return undefined;
		}
	}
	if (typeof raw === 'object') {
		try {
			return URI.revive(raw as URI);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function areOpenChatPiModelsEquivalent(a: string | undefined, b: string | undefined): boolean {
	const norm = (v: string | undefined): string | undefined => {
		const t = v?.trim().toLowerCase();
		return !t || t === 'default' ? undefined : t;
	};
	const na = norm(a);
	const nb = norm(b);
	if (!na || !nb || na === nb) {
		return true;
	}
	const slashA = na.indexOf('/');
	const slashB = nb.indexOf('/');
	if ((slashA >= 0) !== (slashB >= 0)) {
		const bareA = slashA >= 0 ? na.slice(slashA + 1) : na;
		const bareB = slashB >= 0 ? nb.slice(slashB + 1) : nb;
		return Boolean(bareA && bareA === bareB);
	}
	return false;
}

function mapThinkingEffort(rawThinking: unknown): string | undefined {
	if (typeof rawThinking !== 'string') {
		return undefined;
	}
	const norm = rawThinking.trim().toLowerCase();
	if (!norm || norm === 'default') {
		return undefined;
	}
	if (isAdeEffortLevel(norm)) {
		return norm;
	}
	return norm;
}

/**
 * Resolves the workspace folder/cwd URI for an ADE employee (`file://` on local host,
 * `aexus-ssh://<alias>/...` on remote SSH Cloud Hosts, even if the parent Project folder is local).
 */
export async function resolveEmployeeWorkspaceCwdUri(input: {
	readonly host: string;
	readonly folderUri?: string;
	readonly bundle?: IAdeAgentLaunchBundle;
	readonly projectHosts?: readonly IAdeProjectHostEntry[];
	readonly cloudHosts?: IAdeCloudHostBackendService;
}): Promise<string> {
	const rawHost = (input.bundle?.host || input.host || 'local').trim();
	const parsedFolder = input.folderUri ? toUri(input.folderUri) : undefined;

	if (!rawHost || rawHost === 'local') {
		if (parsedFolder?.scheme === Schemas.file) {
			return parsedFolder.toString();
		}
		if (input.bundle?.workspaceCwd) {
			return URI.file(input.bundle.workspaceCwd).toString();
		}
		return parsedFolder?.toString() ?? URI.file('/').toString();
	}

	const lowerHost = rawHost.toLowerCase();
	const projHost = input.projectHosts?.find(h =>
		h.ip === rawHost
		|| h.host_id === rawHost
		|| h.ssh_alias.toLowerCase() === lowerHost,
	);
	let matchedCloud: IAdeCloudHost | undefined;
	if (input.cloudHosts) {
		const all = await input.cloudHosts.listHosts().catch(() => [] as readonly IAdeCloudHost[]);
		const preferredAlias = (input.bundle?.sshAlias || projHost?.ssh_alias || rawHost).toLowerCase();
		matchedCloud = all.find(h =>
			h.alias.toLowerCase() === preferredAlias
			|| h.hostName === rawHost
			|| h.id === rawHost,
		);
	}
	const explicitBundleAlias = input.bundle?.sshAlias && input.bundle.sshAlias !== rawHost
		? input.bundle.sshAlias
		: undefined;
	const sshAlias = explicitBundleAlias
		|| matchedCloud?.alias
		|| projHost?.ssh_alias
		|| input.bundle?.sshAlias
		|| (parsedFolder?.scheme === AEXUS_SSH_SCHEME && parsedFolder.authority ? parsedFolder.authority : rawHost);
	const osKind: AdeCloudHostOs = matchedCloud?.os ?? projHost?.os_kind ?? 'linux';

	let remoteDir: string;
	if (input.bundle?.workspaceCwd && (input.bundle.sshAlias || !parsedFolder || parsedFolder.scheme === AEXUS_SSH_SCHEME || !input.bundle.workspaceCwd.startsWith('/Users/'))) {
		remoteDir = input.bundle.workspaceCwd;
	} else if (parsedFolder?.scheme === AEXUS_SSH_SCHEME && parsedFolder.authority.toLowerCase() === sshAlias.toLowerCase()) {
		remoteDir = parsedFolder.path || '/';
	} else if (input.bundle?.workspaceCwd) {
		remoteDir = input.bundle.workspaceCwd;
	} else if (matchedCloud?.defaultDirectory) {
		remoteDir = matchedCloud.defaultDirectory;
	} else if (projHost?.remote_home) {
		remoteDir = projHost.remote_home;
	} else {
		remoteDir = '/';
	}

	return buildCloudProjectUri(sshAlias, remoteDir, osKind).toString();
}

async function activateAgentsExtension(extensionService: IExtensionService | undefined): Promise<void> {
	if (!extensionService) {
		return;
	}
	await extensionService.activateById(AEXUS_AGENTS_EXTENSION_ID, {
		startup: false,
		extensionId: AEXUS_AGENTS_EXTENSION_ID,
		activationEvent: 'api',
	}).catch(() => undefined);
}

registerCommandSafe('aexus.ade.getCloudHostSshContext', async (accessor: ServicesAccessor, rawAlias?: unknown) => {
	const cloudHosts = tryGetService(accessor, IAdeCloudHostBackendService);
	if (!cloudHosts) {
		return undefined;
	}
	const configService = tryGetService(accessor, IConfigurationService);
	const configuredSshPath = configService?.getValue<string>('remote.SSH.path')?.trim() || undefined;
	const alias = typeof rawAlias === 'string' ? rawAlias.trim() : '';
	const [effectiveSshConfigPath, matched] = await Promise.all([
		cloudHosts.getEffectiveSshConfigPath().catch(() => undefined),
		alias ? cloudHosts.getHost(alias).catch(() => undefined) : Promise.resolve(undefined),
	]);
	return {
		effectiveSshConfigPath,
		alias: matched?.alias || alias || undefined,
		os: matched?.os ?? 'linux',
		strictHostKeyChecking: matched?.strictHostKeyChecking,
		remoteHome: matched?.lastTestStatus?.remoteHome,
		hostName: matched?.hostName,
		user: matched?.user,
		port: matched?.port,
		sshExecutable: configuredSshPath,
	};
});

registerCommandSafe('aexus.ade.issueAgentLaunchBundle', async (accessor: ServicesAccessor, rawProjectId?: unknown, rawAgentId?: unknown) => {
	const controlCenter = tryGetService(accessor, IAdeControlCenterService);
	const projectId = typeof rawProjectId === 'string' ? rawProjectId.trim() : '';
	const agentId = typeof rawAgentId === 'string' ? rawAgentId.trim() : '';
	if (!controlCenter || !projectId || !agentId) {
		return undefined;
	}
	return controlCenter.issueAgentLaunchBundle(projectId, agentId);
});

registerCommandSafe('aexus.ade.resolveEmployeeSessionMeta', async (accessor: ServicesAccessor, rawProjectId?: unknown, rawAgentId?: unknown) => {
	const controlCenter = tryGetService(accessor, IAdeControlCenterService);
	const cloudHosts = tryGetService(accessor, IAdeCloudHostBackendService);
	const projectId = typeof rawProjectId === 'string' ? rawProjectId.trim() : '';
	const agentId = typeof rawAgentId === 'string' ? rawAgentId.trim() : '';
	if (!controlCenter || !projectId || !agentId) {
		return undefined;
	}
	const [snapshot, bundle] = await Promise.all([
		controlCenter.getProjectSnapshot(projectId).catch(() => undefined),
		controlCenter.issueAgentLaunchBundle(projectId, agentId).catch(() => undefined),
	]);
	const agent = snapshot?.agents.find(a => a.agent_id === agentId);
	if (!agent && !bundle) {
		return undefined;
	}
	const host = agent?.host ?? bundle?.host ?? 'local';
	const workspaceCwdUri = await resolveEmployeeWorkspaceCwdUri({
		host,
		folderUri: snapshot?.meta.folder_uri,
		bundle,
		projectHosts: snapshot?.hosts,
		cloudHosts,
	});
	const sessionStarted = agent ? agent.session_started : undefined;
	return {
		agentId: agent?.agent_id ?? agentId,
		name: agent?.name ?? bundle?.name,
		host,
		engine: agent?.engine ?? bundle?.engine,
		sessionStarted,
		sessionResource: agent?.session_resource ?? bundle?.sessionResource,
		workspaceCwdUri,
		model: agent?.model ?? bundle?.model,
		effort: agent?.effort ?? bundle?.effort,
		nativeSessionId: sessionStarted === false
			? (agent?.native_session_id ?? undefined)
			: (agent?.native_session_id ?? bundle?.nativeSessionId),
	};
});

registerCommandSafe('aexus.ade.markAgentSessionStarting', async (accessor: ServicesAccessor, rawProjectId?: unknown, rawAgentId?: unknown, rawSessionResource?: unknown) => {
	const controlCenter = tryGetService(accessor, IAdeControlCenterService);
	const projectId = typeof rawProjectId === 'string' ? rawProjectId.trim() : '';
	const agentId = typeof rawAgentId === 'string' ? rawAgentId.trim() : '';
	if (!controlCenter || !projectId || !agentId) {
		return;
	}
	const sessionResource = typeof rawSessionResource === 'string' && rawSessionResource.trim() ? rawSessionResource.trim() : undefined;
	await controlCenter.markAgentSessionStarting(projectId, agentId, sessionResource);
});

registerCommandSafe('aexus.ade.markAgentSessionStarted', async (accessor: ServicesAccessor, rawProjectId?: unknown, rawAgentId?: unknown, rawInfo?: unknown) => {
	const controlCenter = tryGetService(accessor, IAdeControlCenterService);
	const projectId = typeof rawProjectId === 'string' ? rawProjectId.trim() : '';
	const agentId = typeof rawAgentId === 'string' ? rawAgentId.trim() : '';
	if (!controlCenter || !projectId || !agentId) {
		return;
	}
	let sessionResource: string | undefined;
	let nativeSessionId: string | undefined;
	if (typeof rawInfo === 'string' && rawInfo.trim()) {
		nativeSessionId = rawInfo.trim();
	} else if (rawInfo && typeof rawInfo === 'object') {
		const obj = rawInfo as { sessionResource?: unknown; nativeSessionId?: unknown };
		if (typeof obj.sessionResource === 'string' && obj.sessionResource.trim()) {
			sessionResource = obj.sessionResource.trim();
		}
		if (typeof obj.nativeSessionId === 'string' && obj.nativeSessionId.trim()) {
			nativeSessionId = obj.nativeSessionId.trim();
		}
	}
	await controlCenter.markAgentSessionStarted(projectId, agentId, {
		...(sessionResource ? { sessionResource } : {}),
		...(nativeSessionId ? { nativeSessionId } : {}),
	});
});

registerCommandSafe('aexus.ade.rollbackUnstartedIfCliMissing', async (accessor: ServicesAccessor, firstArg?: unknown, secondArg?: unknown) => {
	const controlCenter = tryGetService(accessor, IAdeControlCenterService);
	let projectId = '';
	let agentId = '';
	if (firstArg && typeof firstArg === 'object') {
		const obj = firstArg as { projectId?: unknown; agentId?: unknown };
		projectId = typeof obj.projectId === 'string' ? obj.projectId.trim() : '';
		agentId = typeof obj.agentId === 'string' ? obj.agentId.trim() : '';
	} else {
		projectId = typeof firstArg === 'string' ? firstArg.trim() : '';
		agentId = typeof secondArg === 'string' ? secondArg.trim() : '';
	}
	if (!controlCenter || !projectId || !agentId) {
		return false;
	}
	return controlCenter.rollbackUnstartedIfCliMissing(projectId, agentId);
});

registerCommandSafe(ADE_SYNC_SESSION_PREFERENCES_COMMAND_ID, async (accessor: ServicesAccessor, rawPayload?: unknown) => {
	if (!rawPayload || typeof rawPayload !== 'object') {
		return;
	}
	const controlCenter = tryGetService(accessor, IAdeControlCenterService);
	if (!controlCenter) {
		return;
	}
	const payload = rawPayload as {
		resource?: unknown;
		projectId?: unknown;
		agentId?: unknown;
		model?: unknown;
		thinking?: unknown;
	};
	const uri = toUri(payload.resource);
	const parsed = parseAdeEmployeeSessionUri(uri);
	let projectId = typeof payload.projectId === 'string' && payload.projectId.trim()
		? payload.projectId.trim()
		: parsed?.projectId;
	let agentId = typeof payload.agentId === 'string' && payload.agentId.trim()
		? payload.agentId.trim()
		: parsed?.agentId;
	if ((!projectId || !agentId) && uri) {
		const resolved = await controlCenter.resolveAgentBySessionResource(uri.toString()).catch(() => undefined);
		if (resolved) {
			projectId = resolved.projectId;
			agentId = resolved.agent.agent_id;
		}
	}
	if (!projectId || !agentId) {
		return;
	}
	const model = typeof payload.model === 'string' && payload.model.trim() && payload.model.trim() !== 'default'
		? payload.model.trim()
		: undefined;
	const effort = mapThinkingEffort(payload.thinking);
	if (!model && !effort) {
		return;
	}
	await controlCenter.uiEditAgent({
		projectId,
		agentId,
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
	}).catch(() => undefined);
});

export const ADE_TICKET_PREFIX_START = '[系统提示词: 此消息是来自Agent {';
const ADE_RENDERED_TICKET_HISTORY_PREFIX = '**Ticket from `';

export function isAdeOpenChatTicketPrompt(text: string | undefined): boolean {
	if (typeof text !== 'string') {
		return false;
	}
	return text.startsWith(ADE_TICKET_PREFIX_START) || text.startsWith(ADE_RENDERED_TICKET_HISTORY_PREFIX);
}

export interface IAdeOpenChatTicketDispatchInput {
	readonly sessionUri: URI;
	readonly payloadText: string;
	readonly deliveryMode: AdeTicketDeliveryMode;
	readonly projectId?: string;
	readonly agentId?: string;
	readonly engine?: string;
	readonly model?: string;
	readonly reasoningEffort?: string;
	readonly ticketId?: string;
	readonly taskId?: string;
}

export interface IAdeOpenChatDispatchOutcome {
	readonly accepted: boolean;
	readonly ok?: boolean;
	readonly stopped?: boolean;
	readonly steeredInStream?: boolean;
	readonly abortedByWindowDispose?: boolean;
	readonly error?: string;
}

interface IQueuedOpenChatTicketEntry {
	readonly enqueuedSeq: number;
	readonly sessionUri: URI;
	readonly payloadText: string;
	readonly deliveryMode: AdeTicketDeliveryMode;
	readonly projectId?: string;
	readonly agentId?: string;
	readonly engine?: string;
	readonly model?: string;
	readonly reasoningEffort?: string;
	readonly ticketId?: string;
	readonly taskId?: string;
	readonly deferred: DeferredPromise<IAdeOpenChatDispatchOutcome>;
	nativeSteerTriedTurnKey?: string;
	cancelled: boolean;
}

interface IActiveOpenChatTicketEntry {
	readonly item: IQueuedOpenChatTicketEntry;
	readonly startedSeq: number;
	preemptedBySteer: boolean;
	cancelledByControl: boolean;
}

interface IAgentOpenChatQueueState {
	readonly queue: IQueuedOpenChatTicketEntry[];
	readonly wakeListeners: Set<() => void>;
	activeItem?: IActiveOpenChatTicketEntry;
	cancellingStartedSeq?: number;
	pumping: boolean;
}

/**
 * Per-employee Path A open-chat Ticket scheduler (`plan.md` §7.2 & §7.3):
 * - Enforces `human_ui > ticket_steer > ticket_queue` without relying on `ChatRequestQueueKind.Steering`
 *   (which neither cancels an in-flight Ticket nor keeps multiple `steer` Tickets separate from `\n\n` merging).
 * - Never interrupts an active human direct-chat turn (`!isAdeOpenChatTicketPrompt`).
 * - Immediately cancels an in-flight Ticket turn via `chatService.cancelCurrentRequestForSession` when a newer
 *   `steer` Ticket arrives, and dispatches queued `steer` / `queue` Tickets strictly one-by-one in FIFO order.
 * - Resolves ONLY after the dispatched Ticket turn finishes (or is explicitly preempted/cancelled/aborted),
 *   so SQLite `ticket_delivery_outbox` records are never prematurely deleted while parked in memory.
 */
export class AdeOpenChatTicketScheduler {
	private readonly states = new Map<string, IAgentOpenChatQueueState>();
	private nextEventSeq = 0;
	private disposed = false;

	private computeAgentKey(sessionUri: URI, projectId?: string, agentId?: string): string {
		if (projectId && agentId) {
			return `${projectId}:${agentId}`;
		}
		const parsed = parseAdeEmployeeSessionUri(sessionUri);
		if (parsed) {
			return `${parsed.projectId}:${parsed.agentId}`;
		}
		return sessionUri.toString();
	}

	private getOrCreateState(agentKey: string): IAgentOpenChatQueueState {
		let state = this.states.get(agentKey);
		if (!state) {
			state = {
				queue: [],
				wakeListeners: new Set(),
				pumping: false,
			};
			this.states.set(agentKey, state);
		}
		return state;
	}

	private wakeState(state: IAgentOpenChatQueueState): void {
		for (const fn of [...state.wakeListeners]) {
			try { fn(); } catch { /* ignore */ }
		}
	}

	getQueuedCount(projectId: string, agentId: string): number {
		return this.states.get(`${projectId}:${agentId}`)?.queue.length ?? 0;
	}

	private inspectLiveSession(
		liveSession: IChatModel,
		state: IAgentOpenChatQueueState,
	): { readonly busy: boolean; readonly isTicketTurn: boolean; readonly activeStartedSeq: number; readonly activeTurnKey: string } {
		const lastReq = liveSession.lastRequest;
		const lastRespIncomplete = Boolean(lastReq?.response && !lastReq.response.isComplete);
		const modelBusy = Boolean(liveSession.hasActiveRequest?.get?.() ?? liveSession.requestInProgress.get());
		const busy = Boolean(state.activeItem) || lastRespIncomplete || modelBusy;
		if (!busy) {
			return { busy: false, isTicketTurn: false, activeStartedSeq: 0, activeTurnKey: '' };
		}
		if (state.activeItem) {
			return {
				busy: true,
				isTicketTurn: true,
				activeStartedSeq: state.activeItem.startedSeq,
				activeTurnKey: `pathA:${state.activeItem.startedSeq}`,
			};
		}
		const lastPromptText = lastReq?.message?.text;
		const isTicketTurn = isAdeOpenChatTicketPrompt(lastPromptText);
		const reqId = (lastReq as { readonly id?: string } | undefined)?.id ?? 'active';
		return {
			busy: true,
			isTicketTurn,
			activeStartedSeq: 0,
			activeTurnKey: `ext:${reqId}:${isTicketTurn ? 'ticket' : 'human'}`,
		};
	}

	private waitForSessionOrWake(liveSession: IChatModel, state: IAgentOpenChatQueueState): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		return new Promise<void>(resolve => {
			let settled = false;
			const store = new DisposableStore();
			const finish = () => {
				if (settled) {
					return;
				}
				settled = true;
				store.dispose();
				resolve();
			};

			state.wakeListeners.add(finish);
			store.add(toDisposable(() => state.wakeListeners.delete(finish)));
			store.add(liveSession.onDidDispose(finish));
			store.add(liveSession.onDidChange(evt => {
				if (evt.kind === 'completedRequest' || evt.kind === 'removeRequest') {
					finish();
				}
			}));
			const activeResp = liveSession.lastRequest?.response;
			if (activeResp) {
				if (activeResp.isComplete) {
					finish();
					return;
				}
				store.add(activeResp.onDidChange(() => {
					if (activeResp.isComplete) {
						finish();
					}
				}));
			}
			let firstObservation = true;
			store.add(autorun(reader => {
				const busy = Boolean(liveSession.hasActiveRequest ? liveSession.hasActiveRequest.read(reader) : liveSession.requestInProgress.read(reader));
				if (!firstObservation && !busy) {
					finish();
				}
				firstObservation = false;
			}));
		});
	}

	async dispatchTicket(
		input: IAdeOpenChatTicketDispatchInput,
		chatService: IChatService | undefined,
		controlCenter?: IAdeControlCenterService,
		commandService?: ICommandService,
	): Promise<IAdeOpenChatDispatchOutcome> {
		if (this.disposed) {
			return { accepted: true, ok: false, abortedByWindowDispose: true };
		}
		if (!chatService || !input.payloadText) {
			return { accepted: false };
		}
		const initialSession = chatService.getSession(input.sessionUri);
		if (!initialSession) {
			return { accepted: false };
		}

		const parsed = parseAdeEmployeeSessionUri(input.sessionUri);
		const projectId = input.projectId || parsed?.projectId;
		const agentId = input.agentId || parsed?.agentId;
		const engine = normalizeAdeShortEngineId(input.engine || parsed?.engine || '');
		const agentKey = this.computeAgentKey(input.sessionUri, projectId, agentId);
		const state = this.getOrCreateState(agentKey);

		const entry: IQueuedOpenChatTicketEntry = {
			enqueuedSeq: ++this.nextEventSeq,
			sessionUri: input.sessionUri,
			payloadText: input.payloadText,
			deliveryMode: input.deliveryMode === 'steer' ? 'steer' : 'queue',
			projectId,
			agentId,
			...(engine ? { engine } : {}),
			...(input.model ? { model: input.model } : {}),
			...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
			ticketId: input.ticketId,
			taskId: input.taskId,
			deferred: new DeferredPromise<IAdeOpenChatDispatchOutcome>(),
			cancelled: false,
		};

		if (entry.deliveryMode === 'steer') {
			let insertIdx = 0;
			while (insertIdx < state.queue.length && state.queue[insertIdx].deliveryMode === 'steer') {
				insertIdx++;
			}
			state.queue.splice(insertIdx, 0, entry);
		} else {
			state.queue.push(entry);
		}

		this.wakeState(state);
		void this.pumpAgentQueue(agentKey, state, chatService, controlCenter, commandService);
		return entry.deferred.p;
	}

	private async pumpAgentQueue(
		agentKey: string,
		state: IAgentOpenChatQueueState,
		chatService: IChatService,
		controlCenter?: IAdeControlCenterService,
		commandService?: ICommandService,
	): Promise<void> {
		if (state.pumping) {
			return;
		}
		state.pumping = true;
		try {
			while (!this.disposed && state.queue.length > 0) {
				const head = state.queue[0];
				if (head.cancelled) {
					state.queue.shift();
					head.deferred.complete({ accepted: true, ok: false, stopped: true });
					continue;
				}

				let liveSession = chatService.getSession(head.sessionUri);
				if (!liveSession) {
					// Panel was closed while waiting in queue -> fall back to headless Path B (`LiveTurnRunner`).
					state.queue.shift();
					head.deferred.complete({ accepted: false });
					continue;
				}

				let status = this.inspectLiveSession(liveSession, state);
				if (status.busy) {
					if (!status.isTicketTurn) {
						// Active HUMAN turn: strictly forbidden to interrupt (including pi native in-stream steer)!
						await this.waitForSessionOrWake(liveSession, state);
						continue;
					}
					const targetEngine = normalizeAdeShortEngineId(head.engine || parseAdeEmployeeSessionUri(head.sessionUri)?.engine || '');
					if (
						head.deliveryMode === 'steer'
						&& targetEngine === 'pi'
						&& commandService
						&& head.nativeSteerTriedTurnKey !== status.activeTurnKey
						&& state.cancellingStartedSeq !== status.activeStartedSeq
					) {
						head.nativeSteerTriedTurnKey = status.activeTurnKey;
						const steerRes = await Promise.resolve(
							commandService.executeCommand<{ readonly steered?: boolean } | undefined>(
								ADE_TRY_NATIVE_IN_STREAM_STEER_COMMAND_ID,
								{
									sessionResource: head.sessionUri.toString(),
									projectId: head.projectId ?? '',
									agentId: head.agentId ?? '',
									engine: 'pi',
									model: head.model ?? 'default',
									...(head.reasoningEffort ? { reasoningEffort: head.reasoningEffort } : {}),
									formattedMessage: head.payloadText,
								},
							),
						).catch(() => undefined);
						if (this.disposed) {
							break;
						}
						if (head.cancelled) {
							continue;
						}
						if (steerRes?.steered === true) {
							const idx = state.queue.indexOf(head);
							if (idx >= 0) {
								state.queue.splice(idx, 1);
							}
							head.deferred.complete({ accepted: true, ok: true, steeredInStream: true });
							continue;
						}
						liveSession = chatService.getSession(head.sessionUri);
						if (!liveSession) {
							const idx = state.queue.indexOf(head);
							if (idx >= 0) {
								state.queue.splice(idx, 1);
							}
							head.deferred.complete({ accepted: false });
							continue;
						}
						status = this.inspectLiveSession(liveSession, state);
						if (!status.busy) {
							continue;
						}
						if (!status.isTicketTurn) {
							await this.waitForSessionOrWake(liveSession, state);
							continue;
						}
					}

					// Active Ticket turn (either Path A `state.activeItem` or Path B `LiveTurnRunner` mirrored turn):
					if (head.deliveryMode === 'steer' && head.enqueuedSeq > status.activeStartedSeq) {
						if (state.activeItem && state.activeItem.startedSeq === status.activeStartedSeq) {
							state.activeItem.preemptedBySteer = true;
						}
						if (state.cancellingStartedSeq !== status.activeStartedSeq) {
							state.cancellingStartedSeq = status.activeStartedSeq;
							await chatService.cancelCurrentRequestForSession(head.sessionUri).catch(() => undefined);
						}
					}
					await this.waitForSessionOrWake(liveSession, state);
					continue;
				}

				state.cancellingStartedSeq = undefined;
				const nextItem = state.queue.shift()!;
				if (nextItem.cancelled) {
					nextItem.deferred.complete({ accepted: true, ok: false, stopped: true });
					continue;
				}
				const candidateStartedSeq = ++this.nextEventSeq;

				if (controlCenter && nextItem.projectId && nextItem.agentId) {
					await controlCenter.markAgentSessionStarting(
						nextItem.projectId,
						nextItem.agentId,
						nextItem.sessionUri.toString(),
					).catch(() => undefined);
				}
				if (this.disposed) {
					nextItem.deferred.complete({ accepted: true, ok: false, abortedByWindowDispose: true });
					break;
				}
				if (nextItem.cancelled) {
					nextItem.deferred.complete({ accepted: true, ok: false, stopped: true });
					continue;
				}
				if (!chatService.getSession(nextItem.sessionUri)) {
					nextItem.deferred.complete({ accepted: false });
					continue;
				}

				const activeEntry: IActiveOpenChatTicketEntry = {
					item: nextItem,
					startedSeq: candidateStartedSeq,
					preemptedBySteer: false,
					cancelledByControl: false,
				};
				state.activeItem = activeEntry;

				// Check if a newer `steer` arrived asynchronously during `markAgentSessionStarting`
				const newerQueuedSteer = state.queue.find(q => !q.cancelled && q.deliveryMode === 'steer' && q.enqueuedSeq > candidateStartedSeq);
				const nextEngShort = normalizeAdeShortEngineId(nextItem.engine || parseAdeEmployeeSessionUri(nextItem.sessionUri)?.engine || '');
				const canDeferToInStreamPiSteer = Boolean(
					nextEngShort === 'pi'
					&& commandService
					&& newerQueuedSteer
					&& areOpenChatPiModelsEquivalent(newerQueuedSteer.model, nextItem.model),
				);
				if (nextItem.deliveryMode === 'queue' && newerQueuedSteer && !canDeferToInStreamPiSteer) {
					state.activeItem = undefined;
					let idx = 0;
					while (idx < state.queue.length && state.queue[idx].deliveryMode === 'steer') {
						idx++;
					}
					state.queue.splice(idx, 0, nextItem);
					continue;
				}

				let sendRes: Awaited<ReturnType<IChatService['sendRequest']>>;
				try {
					sendRes = await chatService.sendRequest(nextItem.sessionUri, nextItem.payloadText, {
						isSystemInitiated: false,
						noCommandDetection: true,
					});
				} catch (err) {
					state.activeItem = undefined;
					if (this.disposed) {
						nextItem.deferred.complete({ accepted: true, ok: false, abortedByWindowDispose: true });
						break;
					}
					const errMsg = err instanceof Error ? err.message : String(err ?? 'sendRequest failed');
					nextItem.deferred.complete({ accepted: true, ok: false, error: errMsg });
					continue;
				}

				if (sendRes.kind === 'rejected') {
					state.activeItem = undefined;
					const currentSession = chatService.getSession(nextItem.sessionUri);
					if (!currentSession) {
						nextItem.deferred.complete({ accepted: false });
						continue;
					}
					if (sendRes.reason === 'Request already in progress') {
						// Human submitted a request concurrently; re-insert at front of its priority lane and wait politely.
						if (nextItem.deliveryMode === 'steer') {
							state.queue.unshift(nextItem);
						} else {
							let idx = 0;
							while (idx < state.queue.length && state.queue[idx].deliveryMode === 'steer') {
								idx++;
							}
							state.queue.splice(idx, 0, nextItem);
						}
						await this.waitForSessionOrWake(currentSession, state);
						continue;
					}
					nextItem.deferred.complete({ accepted: true, ok: false, error: sendRes.reason });
					continue;
				}

				if (sendRes.kind === 'queued') {
					// Defensive fallback if a custom mock returns `queued`: wait for deferred sent outcome.
					const settledQueued = await sendRes.deferred.catch(() => ({ kind: 'rejected' as const, reason: 'Queued request failed' }));
					if (settledQueued.kind === 'rejected') {
						state.activeItem = undefined;
						nextItem.deferred.complete({ accepted: true, ok: false, error: settledQueued.reason });
						continue;
					}
					if (settledQueued.kind === 'sent') {
						await settledQueued.data.responseCompletePromise.catch(() => undefined);
					}
					state.activeItem = undefined;
					if (this.disposed) {
						nextItem.deferred.complete({ accepted: true, ok: false, abortedByWindowDispose: true });
						break;
					}
					nextItem.deferred.complete({ accepted: true, ok: true });
					continue;
				}

				if (activeEntry.cancelledByControl) {
					void chatService.cancelCurrentRequestForSession(nextItem.sessionUri).catch(() => undefined);
				}

				const sentData = sendRes.data;
				void (async () => {
					await sentData.responseCompletePromise.catch(() => undefined);
					if (state.activeItem === activeEntry) {
						state.activeItem = undefined;
						if (state.cancellingStartedSeq === activeEntry.startedSeq) {
							state.cancellingStartedSeq = undefined;
						}
					}
					if (this.disposed) {
						nextItem.deferred.complete({ accepted: true, ok: false, abortedByWindowDispose: true });
						return;
					}
					const settledResp = await Promise.race([
						sentData.responseCreatedPromise.catch(() => undefined),
						Promise.resolve(undefined),
					]);
					const wasCanceled = Boolean(activeEntry.preemptedBySteer || activeEntry.cancelledByControl || settledResp?.isCanceled);
					if (settledResp?.state === ResponseModelState.Failed && !wasCanceled) {
						const errText = settledResp.result?.errorDetails?.message || 'Open chat Ticket turn failed.';
						nextItem.deferred.complete({ accepted: true, ok: false, error: errText });
					} else {
						nextItem.deferred.complete({
							accepted: true,
							ok: !wasCanceled || activeEntry.preemptedBySteer,
							stopped: wasCanceled,
						});
					}
					this.wakeState(state);
					if (!this.disposed && state.queue.length > 0) {
						void this.pumpAgentQueue(agentKey, state, chatService, controlCenter, commandService);
					} else if (state.queue.length === 0 && !state.activeItem && !state.pumping) {
						this.states.delete(agentKey);
					}
				})();

				if (state.queue.length === 0) {
					break;
				}
			}
		} finally {
			state.pumping = false;
			if (!this.disposed && state.queue.length > 0 && !state.activeItem) {
				void this.pumpAgentQueue(agentKey, state, chatService, controlCenter, commandService);
			} else if (state.queue.length === 0 && !state.activeItem) {
				this.states.delete(agentKey);
			}
		}
	}

	async cancelTickets(
		projectId: string,
		ticketIds: readonly string[],
		chatService?: IChatService,
	): Promise<number> {
		if (ticketIds.length === 0) {
			return 0;
		}
		const targetSet = new Set(ticketIds);
		let cancelledCount = 0;
		const cancelPromises: Promise<unknown>[] = [];

		for (const [key, state] of this.states.entries()) {
			if (projectId && !key.startsWith(`${projectId}:`)) {
				continue;
			}
			for (let i = state.queue.length - 1; i >= 0; i--) {
				const q = state.queue[i];
				if (q.ticketId && targetSet.has(q.ticketId)) {
					q.cancelled = true;
					state.queue.splice(i, 1);
					q.deferred.complete({ accepted: true, ok: false, stopped: true });
					cancelledCount++;
				}
			}
			if (state.activeItem?.item.ticketId && targetSet.has(state.activeItem.item.ticketId)) {
				state.activeItem.cancelledByControl = true;
				cancelledCount++;
				if (chatService) {
					cancelPromises.push(chatService.cancelCurrentRequestForSession(state.activeItem.item.sessionUri).catch(() => undefined));
				}
			}
			this.wakeState(state);
		}

		if (cancelPromises.length > 0) {
			await Promise.all(cancelPromises);
		}
		return cancelledCount;
	}

	async disposeAgent(
		projectId: string,
		agentId: string,
		chatService?: IChatService,
	): Promise<void> {
		const state = this.states.get(`${projectId}:${agentId}`);
		if (!state) {
			return;
		}
		while (state.queue.length > 0) {
			const q = state.queue.shift()!;
			q.cancelled = true;
			q.deferred.complete({ accepted: true, ok: false, stopped: true });
		}
		if (state.activeItem) {
			state.activeItem.cancelledByControl = true;
			if (chatService) {
				await chatService.cancelCurrentRequestForSession(state.activeItem.item.sessionUri).catch(() => undefined);
			}
		}
		this.wakeState(state);
	}

	/**
	 * Aborts all queued/in-flight Path A waiters on window unload (`Cmd+R` reload or close)
	 * WITHOUT acknowledging or failing them in SQLite Outbox so `releaseWindowDeliveries` replays them cleanly.
	 */
	abortForWindowDispose(): void {
		this.disposed = true;
		for (const state of this.states.values()) {
			while (state.queue.length > 0) {
				const q = state.queue.shift()!;
				q.deferred.complete({ accepted: true, ok: false, abortedByWindowDispose: true });
			}
			this.wakeState(state);
		}
		this.states.clear();
	}
}

let activeWindowOpenChatScheduler = new AdeOpenChatTicketScheduler();

/**
 * Path A 60fps open-chat streaming bridge (`plan.md` §7.2 & §7.3):
 * Routes through `AdeOpenChatTicketScheduler` so `human_ui > ticket_steer > ticket_queue` priority,
 * non-concatenated `steer` preemption, and deferred Outbox settlement hold across open chat tabs.
 */
registerCommandSafe(ADE_TRY_SEND_OPEN_CHAT_REQUEST_COMMAND_ID, async (accessor: ServicesAccessor, rawPayload?: unknown) => {
	if (!rawPayload || typeof rawPayload !== 'object') {
		return { accepted: false };
	}
	const payload = rawPayload as {
		sessionResource?: unknown;
		payloadText?: unknown;
		deliveryMode?: unknown;
		projectId?: unknown;
		agentId?: unknown;
		engine?: unknown;
		model?: unknown;
		effort?: unknown;
		reasoningEffort?: unknown;
		ticketId?: unknown;
		taskId?: unknown;
	};
	const sessionUri = toUri(payload.sessionResource);
	const payloadText = typeof payload.payloadText === 'string' ? payload.payloadText : '';
	const chatService = tryGetService(accessor, IChatService);
	if (!chatService || !sessionUri || !payloadText) {
		return { accepted: false };
	}
	const controlCenter = tryGetService(accessor, IAdeControlCenterService);
	const commandService = tryGetService(accessor, ICommandService);
	const rawEffort = typeof payload.reasoningEffort === 'string' && payload.reasoningEffort.trim()
		? payload.reasoningEffort.trim()
		: (typeof payload.effort === 'string' && payload.effort.trim() ? payload.effort.trim() : undefined);
	return activeWindowOpenChatScheduler.dispatchTicket(
		{
			sessionUri,
			payloadText,
			deliveryMode: payload.deliveryMode === 'steer' ? 'steer' : 'queue',
			projectId: typeof payload.projectId === 'string' && payload.projectId.trim() ? payload.projectId.trim() : undefined,
			agentId: typeof payload.agentId === 'string' && payload.agentId.trim() ? payload.agentId.trim() : undefined,
			engine: typeof payload.engine === 'string' && payload.engine.trim() ? payload.engine.trim() : undefined,
			model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined,
			reasoningEffort: rawEffort,
			ticketId: typeof payload.ticketId === 'string' && payload.ticketId.trim() ? payload.ticketId.trim() : undefined,
			taskId: typeof payload.taskId === 'string' && payload.taskId.trim() ? payload.taskId.trim() : undefined,
		},
		chatService,
		controlCenter,
		commandService,
	);
});

registerCommandSafe(ADE_DISPATCH_TICKET_TURN_COMMAND_ID, async (accessor: ServicesAccessor, payload?: unknown) => {
	const extensionService = tryGetService(accessor, IExtensionService);
	const commandService = accessor.get(ICommandService);
	await activateAgentsExtension(extensionService);
	return commandService.executeCommand(EXT_DISPATCH_TICKET_TURN_CMD, payload);
});

registerCommandSafe(ADE_CANCEL_TICKET_TURNS_COMMAND_ID, async (accessor: ServicesAccessor, payload?: unknown) => {
	const extensionService = tryGetService(accessor, IExtensionService);
	const commandService = accessor.get(ICommandService);
	await activateAgentsExtension(extensionService);
	return commandService.executeCommand(EXT_CANCEL_TICKET_TURNS_CMD, payload);
});

registerCommandSafe(ADE_DISPOSE_AGENT_RUNTIME_COMMAND_ID, async (accessor: ServicesAccessor, payload?: unknown) => {
	const extensionService = tryGetService(accessor, IExtensionService);
	const commandService = accessor.get(ICommandService);
	await activateAgentsExtension(extensionService);
	return commandService.executeCommand(EXT_DISPOSE_AGENT_RUNTIME_CMD, payload);
});

export interface IAdeDispatchedTurnResult {
	readonly ok?: boolean;
	readonly stopped?: boolean;
	readonly abortedByWindowDispose?: boolean;
	readonly cliMissing?: boolean;
	readonly error?: string;
	readonly nativeSessionId?: string;
	readonly usage?: IAdeTurnTokenUsagePayload;
}

/**
 * Pure Outbox consumer loop + lifecycle event bridge (`plan.md` §7.2 & §7.3).
 */
export class AdeOutboxBridgeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.adeOutboxBridge';

	private readonly controlCenter: IAdeControlCenterService | undefined;
	private readonly cloudHosts: IAdeCloudHostBackendService | undefined;
	private readonly chatService: IChatService | undefined;
	private readonly configurationService: IConfigurationService | undefined;
	private readonly adeEditors: IAdeEditorService | undefined;
	private readonly openChatScheduler: AdeOpenChatTicketScheduler;
	private windowIdPromise: Promise<number> | undefined;
	private resolvedWindowId: number | undefined;
	private isPumping = false;
	private pumpRequestedAgain = false;
	private readonly inFlightDeliveries = new Set<Promise<void>>();
	private readonly inflightMetaSyncByProject = new Map<string, Promise<void>>();
	private readonly pendingTrailingMetaSyncProjects = new Set<string>();
	private readonly lastSyncedEngineByAgent = new Map<string, string>();
	private readonly lastSyncedHostByAgent = new Map<string, string>();
	private readonly inflightDisposalsByProject = new Map<string, Set<Promise<void>>>();

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.openChatScheduler = new AdeOpenChatTicketScheduler();
		activeWindowOpenChatScheduler = this.openChatScheduler;
		[this.controlCenter, this.cloudHosts, this.chatService, this.configurationService, this.adeEditors] = instantiationService.invokeFunction(accessor => [
			tryGetService(accessor, IAdeControlCenterService),
			tryGetService(accessor, IAdeCloudHostBackendService),
			tryGetService(accessor, IChatService),
			tryGetService(accessor, IConfigurationService),
			tryGetService(accessor, IAdeEditorService),
		] as const);

		if (this.chatService?.onDidAcceptRequest) {
			this._register(this.chatService.onDidAcceptRequest(evt => {
				const parsed = parseAdeEmployeeSessionUri(evt.chatSessionResource);
				if (parsed && this.controlCenter) {
					void this.controlCenter.markAgentSessionStarting(
						parsed.projectId,
						parsed.agentId,
						evt.chatSessionResource.toString(),
					).catch(() => undefined);
				}
			}));
		} else if (this.chatService?.onDidSubmitRequest) {
			this._register(this.chatService.onDidSubmitRequest(evt => {
				const parsed = parseAdeEmployeeSessionUri(evt.chatSessionResource);
				if (parsed && this.controlCenter) {
					void this.controlCenter.markAgentSessionStarting(
						parsed.projectId,
						parsed.agentId,
						evt.chatSessionResource.toString(),
					).catch(() => undefined);
				}
			}));
		}

		if (this.configurationService && typeof this.configurationService.onDidChangeConfiguration === 'function') {
			this._register(this.configurationService.onDidChangeConfiguration(evt => {
				if (
					evt.affectsConfiguration('aexus.agentEngines')
					|| evt.affectsConfiguration('aexus.ade.cliPaths')
					|| evt.affectsConfiguration('aexus.ade.remoteCliPaths')
					|| evt.affectsConfiguration('remote.SSH.path')
				) {
					void this.handleAgentEnginesConfigurationChanged();
				}
			}));
		}

		if (this.controlCenter) {
			if (typeof this.controlCenter.onDidChangeProject === 'function') {
				this._register(this.controlCenter.onDidChangeProject(evt => {
					void this.handleSyncProjectEmployeeMeta(evt.projectId);
				}));
			}
			this._register(this.controlCenter.onDidEnqueueOutbox(() => {
				void this.pumpOutbox();
			}));
			this._register(this.controlCenter.onDidCancelOutboxTickets(evt => {
				void this.handleCancelOutboxTickets(evt);
			}));
			this._register(this.controlCenter.onDidDisposeAgentRuntime(evt => {
				clearAdeAgentContextUsage(evt.projectId, evt.agentId);
				this.enqueueDisposeAgentRuntime(evt);
			}));
			void this.pumpOutbox();
		}
	}

	get scheduler(): AdeOpenChatTicketScheduler {
		return this.openChatScheduler;
	}

	private async getWindowId(): Promise<number> {
		if (this.resolvedWindowId !== undefined) {
			return this.resolvedWindowId;
		}
		if (!this.windowIdPromise) {
			this.windowIdPromise = Promise.resolve(
				this.commandService.executeCommand<number>(ADE_GET_WINDOW_ID_COMMAND_ID),
			).then(
				id => (typeof id === 'number' && Number.isFinite(id) && id > 0 ? id : 1),
				() => 1,
			);
		}
		this.resolvedWindowId = await this.windowIdPromise;
		return this.resolvedWindowId;
	}

	async pumpOutbox(): Promise<void> {
		if (!this.controlCenter || this._store.isDisposed) {
			return;
		}
		if (this.isPumping) {
			this.pumpRequestedAgain = true;
			return;
		}
		this.isPumping = true;
		try {
			const windowId = await this.getWindowId();
			do {
				this.pumpRequestedAgain = false;
				if (this._store.isDisposed) {
					break;
				}
				const claimed = await this.controlCenter.claimPendingDeliveries(windowId, 16).catch(() => [] as readonly IAdeOutboxDeliveryItem[]);
				if (claimed.length === 0) {
					break;
				}
				for (const item of claimed) {
					const task = this.deliverClaimedItem(windowId, item);
					this.inFlightDeliveries.add(task);
					void task.finally(() => {
						this.inFlightDeliveries.delete(task);
					});
				}
			} while (this.pumpRequestedAgain && !this._store.isDisposed);
		} finally {
			this.isPumping = false;
		}
	}

	private collectInflightDisposals(projectId?: string): Promise<void>[] {
		if (projectId) {
			const set = this.inflightDisposalsByProject.get(projectId);
			return set ? [...set] : [];
		}
		const all: Promise<void>[] = [];
		for (const set of this.inflightDisposalsByProject.values()) {
			all.push(...set);
		}
		return all;
	}

	/** Waits for all active claims and in-flight Ticket turn dispatches to settle (for deterministic tests). */
	async flushOutboxForTest(): Promise<void> {
		await this.pumpOutbox();
		while (
			this.inFlightDeliveries.size > 0
			|| this.isPumping
			|| this.inflightMetaSyncByProject.size > 0
			|| this.collectInflightDisposals().length > 0
		) {
			await Promise.allSettled([
				...this.inFlightDeliveries,
				...this.inflightMetaSyncByProject.values(),
				...this.collectInflightDisposals(),
			]);
			if (this.pumpRequestedAgain && !this.isPumping) {
				await this.pumpOutbox();
			}
		}
	}

	private async deliverClaimedItem(windowId: number, item: IAdeOutboxDeliveryItem): Promise<void> {
		const controlCenter = this.controlCenter;
		if (!controlCenter || this._store.isDisposed) {
			return;
		}
		try {
			const pendingDisposals = this.collectInflightDisposals(item.projectId);
			if (pendingDisposals.length > 0) {
				await Promise.allSettled(pendingDisposals);
				if (this._store.isDisposed) {
					return;
				}
			}
			const inflightMetaSync = this.inflightMetaSyncByProject.get(item.projectId);
			if (inflightMetaSync) {
				await inflightMetaSync.catch(() => undefined);
				if (this._store.isDisposed) {
					return;
				}
			}
			let [bundle, snapshot] = await Promise.all([
				controlCenter.issueAgentLaunchBundle(item.projectId, item.targetAgentId),
				controlCenter.getProjectSnapshot(item.projectId).catch(() => undefined),
			]);
			if (this._store.isDisposed) {
				return;
			}
			const bundleShortEng = normalizeAdeShortEngineId(bundle.engine);
			const bundleHost = bundle.host || 'local';
			const agentSyncKey = `${item.projectId}:${item.targetAgentId}`;
			const prevSyncedEng = this.lastSyncedEngineByAgent.get(agentSyncKey);
			const prevSyncedHost = this.lastSyncedHostByAgent.get(agentSyncKey);
			const activeEditorUri = this.adeEditors?.activeEditor
				? ((this.adeEditors.activeEditor as { readonly sessionResource?: URI }).sessionResource ?? this.adeEditors.activeEditor.resource)
				: undefined;
			const parsedActive = parseAdeEmployeeSessionUri(activeEditorUri);
			const hasActiveSchemeMismatch = Boolean(
				parsedActive
				&& parsedActive.projectId === item.projectId
				&& parsedActive.agentId === item.targetAgentId
				&& normalizeAdeShortEngineId(parsedActive.engine) !== bundleShortEng,
			);
			if (
				this.inflightMetaSyncByProject.has(item.projectId)
				|| (prevSyncedEng !== undefined && prevSyncedEng !== bundleShortEng)
				|| (prevSyncedHost !== undefined && prevSyncedHost !== bundleHost)
				|| hasActiveSchemeMismatch
				|| (prevSyncedEng === undefined && Boolean(this.adeEditors) && !bundle.nativeSessionId)
			) {
				await this.syncProjectEmployeeMetaSerialized(item.projectId).catch(() => undefined);
				if (this._store.isDisposed) {
					return;
				}
				[bundle, snapshot] = await Promise.all([
					controlCenter.issueAgentLaunchBundle(item.projectId, item.targetAgentId),
					controlCenter.getProjectSnapshot(item.projectId).catch(() => undefined),
				]);
				if (this._store.isDisposed) {
					return;
				}
			}
			const workspaceCwdUri = await resolveEmployeeWorkspaceCwdUri({
				host: bundle.host,
				folderUri: snapshot?.meta.folder_uri,
				bundle,
				projectHosts: snapshot?.hosts,
				cloudHosts: this.cloudHosts,
			});
			await controlCenter.markAgentSessionStarting(
				item.projectId,
				item.targetAgentId,
				bundle.sessionResource,
			).catch(() => undefined);
			if (this._store.isDisposed) {
				return;
			}

			const res = await this.commandService.executeCommand<IAdeDispatchedTurnResult | undefined>(
				ADE_DISPATCH_TICKET_TURN_COMMAND_ID,
				{
					deliveryId: item.deliveryId,
					projectId: item.projectId,
					agentId: item.targetAgentId,
					agentName: bundle.name,
					sessionResource: bundle.sessionResource,
					workspaceCwdUri,
					engine: bundle.engine,
					model: bundle.model,
					effort: bundle.effort,
					ticketId: item.ticketId,
					taskId: item.taskId,
					deliveryMode: item.deliveryMode,
					payloadText: item.payloadText,
					agentToken: bundle.agentToken,
					controlSocketPath: bundle.controlSocketPath,
					remoteControlEndpoint: bundle.remoteControlEndpoint,
					remoteBridgeFile: bundle.remoteBridgeFile,
				},
			);

			// Never acknowledge or nack items aborted by window reload/unload (`Cmd+R`);
			// `releaseWindowDeliveries` resets their Outbox state from `in_flight` back to `pending`.
			if (this._store.isDisposed || res?.abortedByWindowDispose) {
				return;
			}

			if (res?.cliMissing) {
				await controlCenter.nackDeliveryFailed(
					item.deliveryId,
					windowId,
					res.error || 'Engine CLI binary is not installed on target host.',
					true,
				);
				await controlCenter.rollbackUnstartedIfCliMissing(item.projectId, item.targetAgentId).catch(() => false);
				return;
			}
			if (res && res.ok === false && !res.stopped) {
				await controlCenter.nackDeliveryFailed(
					item.deliveryId,
					windowId,
					res.error || 'Ticket turn dispatch failed.',
					false,
				);
				return;
			}
			if (res?.usage) {
				recordAdeTurnContextUsage({
					projectId: item.projectId,
					agentId: item.targetAgentId,
					nativeSessionId: res.nativeSessionId ?? bundle.nativeSessionId,
					usage: res.usage,
				});
			}
			if (res?.nativeSessionId) {
				await controlCenter.markAgentSessionStarted(item.projectId, item.targetAgentId, {
					sessionResource: bundle.sessionResource,
					nativeSessionId: res.nativeSessionId,
				}).catch(() => undefined);
			}
			if (!this._store.isDisposed) {
				await controlCenter.ackDeliveryDispatched(item.deliveryId, windowId);
			}
		} catch (err) {
			if (this._store.isDisposed) {
				return;
			}
			const errMsg = err instanceof Error ? err.message : String(err ?? 'Unknown Outbox dispatch error');
			await controlCenter.nackDeliveryFailed(item.deliveryId, windowId, errMsg, false).catch(() => undefined);
		}
	}

	private async handleCancelOutboxTickets(evt: { readonly projectId: string; readonly ticketIds: readonly string[] }): Promise<void> {
		if (!this.controlCenter || evt.ticketIds.length === 0) {
			return;
		}
		await this.openChatScheduler.cancelTickets(evt.projectId, evt.ticketIds, this.chatService).catch(() => 0);
		const snapshot = await this.controlCenter.getProjectSnapshot(evt.projectId).catch(() => undefined);
		const agents = snapshot?.agents ?? [];
		if (agents.length === 0) {
			await this.commandService.executeCommand(ADE_CANCEL_TICKET_TURNS_COMMAND_ID, {
				projectId: evt.projectId,
				ticketIds: evt.ticketIds,
			}).catch(() => undefined);
			return;
		}
		await Promise.all(agents.map(ag => {
			const sessionResource = ag.session_resource ?? buildAdeEmployeeSessionUri(ag.engine, evt.projectId, ag.agent_id).toString();
			return this.commandService.executeCommand(ADE_CANCEL_TICKET_TURNS_COMMAND_ID, {
				projectId: evt.projectId,
				agentId: ag.agent_id,
				sessionResource,
				ticketIds: evt.ticketIds,
			}).catch(() => undefined);
		}));
	}

	async syncProjectEmployeeMetaSerialized(projectId: string): Promise<void> {
		const trimmed = projectId?.trim();
		if (!this.controlCenter || !trimmed || this._store.isDisposed) {
			return;
		}
		const existing = this.inflightMetaSyncByProject.get(trimmed);
		if (existing) {
			this.pendingTrailingMetaSyncProjects.add(trimmed);
			return existing;
		}
		const runPromise: Promise<void> = (async () => {
			do {
				this.pendingTrailingMetaSyncProjects.delete(trimmed);
				await this.runSingleProjectEmployeeMetaSync(trimmed);
			} while (this.pendingTrailingMetaSyncProjects.has(trimmed) && !this._store.isDisposed);
		})().finally(() => {
			if (this.inflightMetaSyncByProject.get(trimmed) === runPromise) {
				this.inflightMetaSyncByProject.delete(trimmed);
			}
			this.pendingTrailingMetaSyncProjects.delete(trimmed);
		});
		this.inflightMetaSyncByProject.set(trimmed, runPromise);
		return runPromise;
	}

	private async handleSyncProjectEmployeeMeta(projectId: string): Promise<void> {
		await this.syncProjectEmployeeMetaSerialized(projectId);
	}

	private async runSingleProjectEmployeeMetaSync(projectId: string): Promise<void> {
		if (!this.controlCenter || !projectId || this._store.isDisposed) {
			return;
		}
		const pendingDisposals = this.collectInflightDisposals(projectId);
		if (pendingDisposals.length > 0) {
			await Promise.allSettled(pendingDisposals);
			if (this._store.isDisposed) {
				return;
			}
		}
		const snapshot = await this.controlCenter.getProjectSnapshot(projectId).catch(() => undefined);
		if (!snapshot || this._store.isDisposed || this.pendingTrailingMetaSyncProjects.has(projectId)) {
			return;
		}
		const agents = await Promise.all(snapshot.agents.map(async ag => {
			const workspaceCwdUri = await resolveEmployeeWorkspaceCwdUri({
				host: ag.host,
				folderUri: snapshot.meta.folder_uri,
				projectHosts: snapshot.hosts,
				cloudHosts: this.cloudHosts,
			}).catch(() => undefined);
			return {
				agentId: ag.agent_id,
				name: ag.name,
				host: ag.host,
				engine: ag.engine,
				model: ag.model,
				effort: ag.effort,
				sessionStarted: ag.session_started,
				sessionResource: ag.session_resource ?? buildAdeEmployeeSessionUri(ag.engine, projectId, ag.agent_id).toString(),
				nativeSessionId: ag.native_session_id,
				workspaceCwdUri,
			};
		}));
		if (this._store.isDisposed || this.pendingTrailingMetaSyncProjects.has(projectId)) {
			return;
		}
		await this.commandService.executeCommand(EXT_SYNC_CACHED_EMPLOYEE_META_CMD, {
			projectId,
			agents,
		}).catch(() => undefined);
		if (this._store.isDisposed || this.pendingTrailingMetaSyncProjects.has(projectId)) {
			return;
		}
		for (const ag of snapshot.agents) {
			const syncKey = `${projectId}:${ag.agent_id}`;
			this.lastSyncedEngineByAgent.set(syncKey, normalizeAdeShortEngineId(ag.engine));
			this.lastSyncedHostByAgent.set(syncKey, ag.host || 'local');
		}
		await this.adeEditors?.rebindUnstartedAgentEditors?.(projectId, snapshot).catch(() => 0);
	}

	private async handleAgentEnginesConfigurationChanged(): Promise<void> {
		if (this._store.isDisposed || !this.controlCenter) {
			return;
		}
		await Promise.resolve(this.commandService.executeCommand(EXT_REFRESH_CLI_PATHS_CMD)).catch(() => undefined);
		if (this._store.isDisposed) {
			return;
		}
		const maybeRequeue = (this.controlCenter as IAdeControlCenterService & {
			readonly requeueBlockedCliDeliveries?: (req?: { readonly projectId?: string; readonly agentId?: string }) => Promise<{ readonly requeuedCount: number }>;
		}).requeueBlockedCliDeliveries;
		if (typeof maybeRequeue === 'function') {
			const res = await maybeRequeue.call(this.controlCenter, {}).catch(() => ({ requeuedCount: 0 }));
			if (res.requeuedCount > 0 && !this._store.isDisposed) {
				void this.pumpOutbox();
			}
		}
	}

	private enqueueDisposeAgentRuntime(evt: IAdeAgentRuntimeDisposeEvent): void {
		const projId = evt.projectId?.trim();
		let preserveRecordForReset = false;
		const runPromise = (async () => {
			preserveRecordForReset = await this.handleDisposeAgentRuntime(evt);
		})();
		let set = projId ? this.inflightDisposalsByProject.get(projId) : undefined;
		if (projId && !set) {
			set = new Set<Promise<void>>();
			this.inflightDisposalsByProject.set(projId, set);
		}
		const tracked = runPromise.finally(() => {
			if (projId && set) {
				set.delete(tracked);
				if (set.size === 0 && this.inflightDisposalsByProject.get(projId) === set) {
					this.inflightDisposalsByProject.delete(projId);
				}
			}
		});
		if (set) {
			set.add(tracked);
		}
		void tracked.then(() => {
			if (preserveRecordForReset && projId && !this._store.isDisposed) {
				void this.syncProjectEmployeeMetaSerialized(projId).catch(() => undefined);
			}
		});
	}

	private async handleDisposeAgentRuntime(evt: IAdeAgentRuntimeDisposeEvent): Promise<boolean> {
		await this.openChatScheduler.disposeAgent(evt.projectId, evt.agentId, this.chatService).catch(() => undefined);
		const snapshot = evt.projectId && this.controlCenter
			? await this.controlCenter.getProjectSnapshot(evt.projectId).catch(() => undefined)
			: undefined;
		const matchingAgent = snapshot?.agents.find(a => a.agent_id === evt.agentId);
		const preserveRecordForReset = Boolean(matchingAgent && !matchingAgent.session_started && !matchingAgent.native_session_id);
		const sessionResource = evt.sessionResource ?? buildAdeEmployeeSessionUri(evt.engine, evt.projectId, evt.agentId).toString();
		const hostAlias = evt.sshAlias ?? (evt.host && evt.host !== 'local' ? evt.host : undefined);
		await this.commandService.executeCommand(ADE_DISPOSE_AGENT_RUNTIME_COMMAND_ID, {
			projectId: evt.projectId,
			agentId: evt.agentId,
			sessionResource,
			...(hostAlias ? { hostAlias } : {}),
			...(preserveRecordForReset ? { preserveRecordForReset: true } : {}),
		}).catch(() => undefined);
		return preserveRecordForReset;
	}

	override dispose(): void {
		this.openChatScheduler.abortForWindowDispose();
		const winId = this.resolvedWindowId;
		if (winId !== undefined && this.controlCenter) {
			void this.controlCenter.releaseWindowDeliveries(winId).catch(() => undefined);
		}
		super.dispose();
	}
}

registerWorkbenchContribution2(AdeOutboxBridgeContribution.ID, AdeOutboxBridgeContribution, WorkbenchPhase.AfterRestored);
