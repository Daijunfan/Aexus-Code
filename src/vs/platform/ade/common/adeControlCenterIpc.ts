/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { AdeCliCommandName } from './adeCliManifest.js';
import {
	AdeBoardPermission,
	AdeError,
	AdeErrorCode,
	AdeTicketDeliveryMode,
	IAdeAgentNode,
	IAdeBoardItemPublicSummary,
	IAdeBoardNotePublicItem,
	IAdeCatalogSnapshot,
	IAdeDepartment,
	IAdeEdgeTransferRecord,
	IAdeProjectSnapshot,
	IAdeTicketTransferAnimationEvent,
	IAdeUiCanvasLayoutPatch,
	IAdeUiTicketFullInspection,
	IAdeWhiteboard,
	IAdeWorkspaceFolder,
	isAdeError,
} from './adeModels.js';

export const ADE_CONTROL_CENTER_CHANNEL_NAME = 'adeControlCenter';
export const IAdeControlCenterService = createDecorator<IAdeControlCenterService>('adeControlCenterService');

export interface IAdeVerifiedCliCaller {
	readonly projectId: string;
	readonly agentId: string;
	readonly host: string;
	readonly tokenGen: number;
}

export interface IAdeUiCreateAgentInput {
	readonly projectId: string;
	readonly parentId: string | null;
	readonly level: number;
	readonly name: string;
	readonly roleSummary: string;
	readonly host: string;
	readonly engine: string;
	readonly model: string;
	readonly effort: string;
	readonly canvasX?: number;
	readonly canvasY?: number;
	readonly colorToken?: string;
}

export interface IAdeUiEditAgentInput {
	readonly projectId: string;
	readonly agentId: string;
	readonly name?: string;
	readonly roleSummary?: string;
	readonly host?: string;
	readonly engine?: string;
	readonly model?: string;
	readonly effort?: string;
	readonly colorToken?: string;
	readonly allowSessionReset?: boolean;
}

export interface IAdeWbItemsFilter {
	readonly sort?: 'time' | 'stars';
	readonly limit?: number;
	readonly author?: string;
	readonly tag?: string;
	readonly type?: 'all' | 'msg' | 'file';
	readonly stars?: string;
}

export interface IAdeUiWhiteboardInspection {
	readonly board: IAdeWhiteboard;
	readonly members: readonly {
		readonly agent_id: string;
		readonly name: string;
		readonly permission: 'owner' | AdeBoardPermission;
	}[];
	readonly items: readonly IAdeBoardItemPublicSummary[];
	readonly notes: readonly (IAdeBoardNotePublicItem & {
		readonly to_id: string;
		readonly is_read: boolean;
	})[];
}

export interface IAdeAgentLaunchBundle {
	readonly projectId: string;
	readonly agentId: string;
	readonly level: number;
	readonly name: string;
	readonly host: string;
	readonly sshAlias?: string;
	readonly engine: string;
	readonly model: string;
	readonly effort: string;
	readonly workspaceCwd: string;
	readonly sessionResource: string;
	readonly nativeSessionId?: string;
	readonly agentToken: string;
	readonly controlSocketPath: string;
	readonly remoteBridgeFile?: string;
	readonly remoteControlEndpoint?: string;
	readonly remoteBinDir?: string;
}

export interface IAdeOutboxDeliveryItem {
	readonly deliveryId: string;
	readonly projectId: string;
	readonly ticketId: string;
	readonly taskId: string;
	readonly targetAgentId: string;
	readonly deliveryMode: AdeTicketDeliveryMode;
	readonly payloadText: string;
	readonly createdAt: number;
}

export interface IAdeAgentRuntimeDisposeEvent {
	readonly projectId: string;
	readonly agentId: string;
	readonly host: string;
	readonly sshAlias?: string;
	readonly engine: string;
	readonly sessionResource?: string;
}

export interface IAdeControlCenterService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeCatalog: Event<void>;
	readonly onDidChangeProject: Event<{ readonly projectId: string }>;
	readonly onDidTransferTicket: Event<IAdeTicketTransferAnimationEvent>;
	readonly onDidEnqueueOutbox: Event<{ readonly projectId: string; readonly targetAgentId: string }>;
	readonly onDidCancelOutboxTickets: Event<{ readonly projectId: string; readonly ticketIds: readonly string[] }>;
	readonly onDidDisposeAgentRuntime: Event<IAdeAgentRuntimeDisposeEvent>;

	// Catalog & Project Pages (Left Sidebar 1..N)
	getCatalogSnapshot(): Promise<IAdeCatalogSnapshot>;
	registerWorkspaceFolder(input: { readonly folderUri: string; readonly displayName?: string; readonly host?: string }): Promise<IAdeWorkspaceFolder>;
	removeWorkspaceFolder(folderUri: string): Promise<void>;
	reorderWorkspaceFolder(sourceUri: string, targetUri: string | undefined, after: boolean): Promise<void>;
	setWorkspaceFolderCollapsed(folderUri: string, collapsed: boolean): Promise<void>;
	migrateCloudHostAlias(oldAlias: string, newAlias: string): Promise<number>;

	createProject(input: { readonly folderUri: string; readonly name?: string }): Promise<IAdeProjectSnapshot>;
	renameProject(projectId: string, name: string): Promise<void>;
	reorderProject(projectId: string, targetProjectId: string | undefined, after: boolean): Promise<void>;
	deleteProject(projectId: string): Promise<void>;
	getProjectSnapshot(projectId: string): Promise<IAdeProjectSnapshot | undefined>;
	listAllBoundSessionResources(): Promise<readonly string[]>;

	// Host & Engine Probing
	probeEngines(host: string): Promise<readonly string[]>;
	probeModels(host: string, engine: string): Promise<{ readonly models: readonly string[]; readonly efforts: readonly string[] }>;

	// Human UI Canvas Mutations
	uiCreateAgent(input: IAdeUiCreateAgentInput): Promise<IAdeAgentNode>;
	uiEditAgent(input: IAdeUiEditAgentInput): Promise<IAdeAgentNode>;
	uiMoveAgent(projectId: string, agentId: string, newParentId: string): Promise<IAdeAgentNode>;
	uiDeleteAgent(projectId: string, agentId: string): Promise<{ readonly frozenTicketIds: readonly string[] }>;
	uiUpdateCanvasLayout(projectId: string, patch: IAdeUiCanvasLayoutPatch): Promise<void>;

	uiCreateDepartment(projectId: string, rootAgentId: string, name: string): Promise<IAdeDepartment>;
	uiEditDepartment(projectId: string, deptId: string, patch: {
		readonly name?: string;
		readonly boardId?: string;
		readonly perm?: AdeBoardPermission;
	}): Promise<IAdeDepartment>;
	uiDeleteDepartment(projectId: string, deptId: string): Promise<void>;
	uiSetDepartmentMember(projectId: string, deptId: string, agentId: string, action: 'in' | 'out'): Promise<void>;

	uiConfigureProjectTicketStorage(projectId: string, targetHost: string): Promise<void>;
	uiCreateWhiteboard(input: {
		readonly projectId: string;
		readonly name: string;
		readonly ownerId?: string | null;
		readonly deptId?: string | null;
		readonly storageHost?: string;
		readonly tags?: readonly string[];
		readonly canvasX?: number;
		readonly canvasY?: number;
	}): Promise<IAdeWhiteboard>;
	uiConfigureWhiteboard(input: {
		readonly projectId: string;
		readonly boardId: string;
		readonly name?: string;
		readonly targetStorageHost?: string;
		readonly addTags?: readonly string[];
		readonly removeTags?: readonly string[];
		readonly grants?: readonly { readonly agentId: string; readonly perm: AdeBoardPermission | 'none' }[];
	}): Promise<IAdeWhiteboard>;
	uiDeleteWhiteboard(projectId: string, boardId: string): Promise<void>;
	uiManageWhiteboardItem(input: {
		readonly projectId: string;
		readonly boardId: string;
		readonly itemId: string;
		readonly pin?: boolean;
		readonly stars?: 1 | 2 | 3 | 4 | 5;
		readonly tags?: readonly string[];
		readonly deleteItem?: boolean;
	}): Promise<void>;
	uiInspectWhiteboard(projectId: string, boardId: string, filter?: IAdeWbItemsFilter): Promise<IAdeUiWhiteboardInspection>;
	uiReadWhiteboardItemDetail(projectId: string, boardId: string, itemId: string): Promise<string>;
	uiDownloadWhiteboardFile(projectId: string, boardId: string, itemId: string, destPath: string): Promise<string>;
	uiReadWhiteboardNoteDetail(projectId: string, boardId: string, noteId: string): Promise<string>;

	// Canvas Edge Hover & Click Inspection
	getEdgeLatestTransferTime(projectId: string, edgePairKey: string): Promise<number | null>;
	listEdgeTicketTransfers(projectId: string, edgePairKey: string): Promise<readonly IAdeEdgeTransferRecord[]>;
	inspectTicketFullDetailForUi(projectId: string, ticketId: string): Promise<IAdeUiTicketFullInspection | undefined>;
	readTicketTaskDetailForUi(projectId: string, ticketId: string, taskId: string): Promise<string>;

	// Agent Runtime Credentials, Session Phase & Outbox Delivery
	issueAgentLaunchBundle(projectId: string, agentId: string): Promise<IAdeAgentLaunchBundle>;
	resolveAgentBySessionResource(sessionResource: string): Promise<{ readonly projectId: string; readonly agent: IAdeAgentNode } | undefined>;
	markAgentSessionStarting(projectId: string, agentId: string, sessionResource?: string): Promise<void>;
	markAgentSessionStarted(projectId: string, agentId: string, info: { readonly sessionResource?: string; readonly nativeSessionId?: string }): Promise<void>;
	rollbackUnstartedIfCliMissing(projectId: string, agentId: string): Promise<boolean>;

	claimPendingDeliveries(windowId: number, limit?: number): Promise<readonly IAdeOutboxDeliveryItem[]>;
	ackDeliveryDispatched(deliveryId: string, windowId: number): Promise<void>;
	nackDeliveryFailed(deliveryId: string, windowId: number, error: string, cliMissing?: boolean): Promise<void>;
	releaseWindowDeliveries(windowId: number): Promise<void>;
	requeueBlockedCliDeliveries(req?: { readonly projectId?: string; readonly agentId?: string }): Promise<{ readonly requeuedCount: number }>;

	// 45 `ade_*` CLI Unified Dispatcher
	executeCliCommand(
		caller: IAdeVerifiedCliCaller,
		command: AdeCliCommandName,
		args: Readonly<Record<string, unknown>>,
		idempotencyKey?: string,
	): Promise<Record<string, unknown>>;
}

interface ISerializedAdeErrorWire {
	readonly __adeErr: true;
	readonly code: AdeErrorCode;
	readonly message: string;
}

function isSerializedAdeErrorWire(val: unknown): val is ISerializedAdeErrorWire {
	return Boolean(val && typeof val === 'object' && (val as { __adeErr?: unknown }).__adeErr === true);
}

const ALLOWED_ADE_CONTROL_CENTER_IPC_COMMANDS: ReadonlySet<string> = new Set<keyof IAdeControlCenterService & string>([
	'getCatalogSnapshot',
	'registerWorkspaceFolder',
	'removeWorkspaceFolder',
	'reorderWorkspaceFolder',
	'setWorkspaceFolderCollapsed',
	'migrateCloudHostAlias',
	'createProject',
	'renameProject',
	'reorderProject',
	'deleteProject',
	'getProjectSnapshot',
	'listAllBoundSessionResources',
	'probeEngines',
	'probeModels',
	'uiCreateAgent',
	'uiEditAgent',
	'uiMoveAgent',
	'uiDeleteAgent',
	'uiUpdateCanvasLayout',
	'uiCreateDepartment',
	'uiEditDepartment',
	'uiDeleteDepartment',
	'uiSetDepartmentMember',
	'uiConfigureProjectTicketStorage',
	'uiCreateWhiteboard',
	'uiConfigureWhiteboard',
	'uiDeleteWhiteboard',
	'uiManageWhiteboardItem',
	'uiInspectWhiteboard',
	'uiReadWhiteboardItemDetail',
	'uiDownloadWhiteboardFile',
	'uiReadWhiteboardNoteDetail',
	'getEdgeLatestTransferTime',
	'listEdgeTicketTransfers',
	'inspectTicketFullDetailForUi',
	'readTicketTaskDetailForUi',
	'issueAgentLaunchBundle',
	'resolveAgentBySessionResource',
	'markAgentSessionStarting',
	'markAgentSessionStarted',
	'rollbackUnstartedIfCliMissing',
	'claimPendingDeliveries',
	'ackDeliveryDispatched',
	'nackDeliveryFailed',
	'releaseWindowDeliveries',
	'requeueBlockedCliDeliveries',
	'executeCliCommand',
]);

export interface IAdeShutdownAwareControlCenterService extends IAdeControlCenterService {
	readonly isShuttingDown?: boolean;
	trackExternalIpcCall?<T>(fn: () => Promise<T>): Promise<T>;
}

export class AdeControlCenterChannel implements IServerChannel<string> {
	private readonly _inflightIpcCalls = new Set<Promise<unknown>>();

	constructor(private readonly service: IAdeShutdownAwareControlCenterService) { }

	get inflightCallCount(): number {
		return this._inflightIpcCalls.size;
	}

	async drainInflightCalls(): Promise<void> {
		while (this._inflightIpcCalls.size > 0) {
			await Promise.allSettled([...this._inflightIpcCalls]);
		}
	}

	listen<T>(_ctx: string, event: string): Event<T> {
		switch (event) {
			case 'onDidChangeCatalog': return this.service.onDidChangeCatalog as unknown as Event<T>;
			case 'onDidChangeProject': return this.service.onDidChangeProject as unknown as Event<T>;
			case 'onDidTransferTicket': return this.service.onDidTransferTicket as unknown as Event<T>;
			case 'onDidEnqueueOutbox': return this.service.onDidEnqueueOutbox as unknown as Event<T>;
			case 'onDidCancelOutboxTickets': return this.service.onDidCancelOutboxTickets as unknown as Event<T>;
			case 'onDidDisposeAgentRuntime': return this.service.onDidDisposeAgentRuntime as unknown as Event<T>;
			default: return Event.None;
		}
	}

	async call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const exec = async (): Promise<T> => {
			let envelope: unknown;
			try {
				if (!ALLOWED_ADE_CONTROL_CENTER_IPC_COMMANDS.has(command)) {
					throw new Error(`Unsupported AdeControlCenterChannel command: ${command}`);
				}
				if (this.service.isShuttingDown) {
					if (command === 'releaseWindowDeliveries') {
						envelope = { __ok: true, value: undefined };
					} else {
						throw new AdeError('ERR_UNAUTHORIZED', '控制中心正在关停，拒绝新 IPC 请求');
					}
				} else {
					const serviceMap: unknown = this.service;
					const fn = (serviceMap as Record<string, (...a: unknown[]) => Promise<unknown>>)[command];
					if (typeof fn !== 'function') {
						throw new Error(`Unsupported AdeControlCenterChannel command: ${command}`);
					}
					const invokeFn = () => fn.apply(this.service, args);
					const result = typeof this.service.trackExternalIpcCall === 'function'
						? await this.service.trackExternalIpcCall(invokeFn)
						: await invokeFn();
					envelope = { __ok: true, value: result };
				}
			} catch (err) {
				if (isAdeError(err)) {
					const wireErr: ISerializedAdeErrorWire = { __adeErr: true, code: err.code, message: err.message };
					envelope = { __ok: false, err: wireErr };
				} else {
					throw err;
				}
			}
			return envelope as T;
		};
		const p = exec().finally(() => {
			this._inflightIpcCalls.delete(p);
		});
		this._inflightIpcCalls.add(p);
		return p;
	}
}

export class AdeControlCenterChannelClient implements IAdeControlCenterService {
	declare readonly _serviceBrand: undefined;

	readonly onDidChangeCatalog: Event<void>;
	readonly onDidChangeProject: Event<{ readonly projectId: string }>;
	readonly onDidTransferTicket: Event<IAdeTicketTransferAnimationEvent>;
	readonly onDidEnqueueOutbox: Event<{ readonly projectId: string; readonly targetAgentId: string }>;
	readonly onDidCancelOutboxTickets: Event<{ readonly projectId: string; readonly ticketIds: readonly string[] }>;
	readonly onDidDisposeAgentRuntime: Event<IAdeAgentRuntimeDisposeEvent>;

	constructor(private readonly channel: IChannel) {
		this.onDidChangeCatalog = this.channel.listen('onDidChangeCatalog');
		this.onDidChangeProject = this.channel.listen('onDidChangeProject');
		this.onDidTransferTicket = this.channel.listen('onDidTransferTicket');
		this.onDidEnqueueOutbox = this.channel.listen('onDidEnqueueOutbox');
		this.onDidCancelOutboxTickets = this.channel.listen('onDidCancelOutboxTickets');
		this.onDidDisposeAgentRuntime = this.channel.listen('onDidDisposeAgentRuntime');
	}

	private async invoke<R>(command: string, args: unknown[] = []): Promise<R> {
		const wrapped = await this.channel.call<{ __ok: boolean; value?: R; err?: unknown }>(command, args);
		if (wrapped && typeof wrapped === 'object' && Object.prototype.hasOwnProperty.call(wrapped, '__ok')) {
			if (wrapped.__ok) {
				return wrapped.value as R;
			}
			if (isSerializedAdeErrorWire(wrapped.err)) {
				throw new AdeError(wrapped.err.code, wrapped.err.message);
			}
			throw new Error(String(wrapped.err ?? 'Unknown ADE Control Center IPC error'));
		}
		const fallback: unknown = wrapped;
		return fallback as R;
	}

	getCatalogSnapshot() { return this.invoke<IAdeCatalogSnapshot>('getCatalogSnapshot'); }
	registerWorkspaceFolder(input: { readonly folderUri: string; readonly displayName?: string; readonly host?: string }) {
		return this.invoke<IAdeWorkspaceFolder>('registerWorkspaceFolder', [input]);
	}
	removeWorkspaceFolder(folderUri: string) { return this.invoke<void>('removeWorkspaceFolder', [folderUri]); }
	reorderWorkspaceFolder(sourceUri: string, targetUri: string | undefined, after: boolean) {
		return this.invoke<void>('reorderWorkspaceFolder', [sourceUri, targetUri, after]);
	}
	setWorkspaceFolderCollapsed(folderUri: string, collapsed: boolean) {
		return this.invoke<void>('setWorkspaceFolderCollapsed', [folderUri, collapsed]);
	}
	migrateCloudHostAlias(oldAlias: string, newAlias: string) {
		return this.invoke<number>('migrateCloudHostAlias', [oldAlias, newAlias]);
	}

	createProject(input: { readonly folderUri: string; readonly name?: string }) {
		return this.invoke<IAdeProjectSnapshot>('createProject', [input]);
	}
	renameProject(projectId: string, name: string) { return this.invoke<void>('renameProject', [projectId, name]); }
	reorderProject(projectId: string, targetProjectId: string | undefined, after: boolean) {
		return this.invoke<void>('reorderProject', [projectId, targetProjectId, after]);
	}
	deleteProject(projectId: string) { return this.invoke<void>('deleteProject', [projectId]); }
	getProjectSnapshot(projectId: string) { return this.invoke<IAdeProjectSnapshot | undefined>('getProjectSnapshot', [projectId]); }
	listAllBoundSessionResources() { return this.invoke<readonly string[]>('listAllBoundSessionResources'); }

	probeEngines(host: string) { return this.invoke<readonly string[]>('probeEngines', [host]); }
	probeModels(host: string, engine: string) {
		return this.invoke<{ readonly models: readonly string[]; readonly efforts: readonly string[] }>('probeModels', [host, engine]);
	}

	uiCreateAgent(input: IAdeUiCreateAgentInput) { return this.invoke<IAdeAgentNode>('uiCreateAgent', [input]); }
	uiEditAgent(input: IAdeUiEditAgentInput) { return this.invoke<IAdeAgentNode>('uiEditAgent', [input]); }
	uiMoveAgent(projectId: string, agentId: string, newParentId: string) {
		return this.invoke<IAdeAgentNode>('uiMoveAgent', [projectId, agentId, newParentId]);
	}
	uiDeleteAgent(projectId: string, agentId: string) {
		return this.invoke<{ readonly frozenTicketIds: readonly string[] }>('uiDeleteAgent', [projectId, agentId]);
	}
	uiUpdateCanvasLayout(projectId: string, patch: IAdeUiCanvasLayoutPatch) {
		return this.invoke<void>('uiUpdateCanvasLayout', [projectId, patch]);
	}

	uiCreateDepartment(projectId: string, rootAgentId: string, name: string) {
		return this.invoke<IAdeDepartment>('uiCreateDepartment', [projectId, rootAgentId, name]);
	}
	uiEditDepartment(projectId: string, deptId: string, patch: {
		readonly name?: string;
		readonly boardId?: string;
		readonly perm?: AdeBoardPermission;
	}) {
		return this.invoke<IAdeDepartment>('uiEditDepartment', [projectId, deptId, patch]);
	}
	uiDeleteDepartment(projectId: string, deptId: string) {
		return this.invoke<void>('uiDeleteDepartment', [projectId, deptId]);
	}
	uiSetDepartmentMember(projectId: string, deptId: string, agentId: string, action: 'in' | 'out') {
		return this.invoke<void>('uiSetDepartmentMember', [projectId, deptId, agentId, action]);
	}

	uiConfigureProjectTicketStorage(projectId: string, targetHost: string) {
		return this.invoke<void>('uiConfigureProjectTicketStorage', [projectId, targetHost]);
	}
	uiCreateWhiteboard(input: {
		readonly projectId: string;
		readonly name: string;
		readonly ownerId?: string | null;
		readonly deptId?: string | null;
		readonly storageHost?: string;
		readonly tags?: readonly string[];
		readonly canvasX?: number;
		readonly canvasY?: number;
	}) {
		return this.invoke<IAdeWhiteboard>('uiCreateWhiteboard', [input]);
	}
	uiConfigureWhiteboard(input: {
		readonly projectId: string;
		readonly boardId: string;
		readonly name?: string;
		readonly targetStorageHost?: string;
		readonly addTags?: readonly string[];
		readonly removeTags?: readonly string[];
		readonly grants?: readonly { readonly agentId: string; readonly perm: AdeBoardPermission | 'none' }[];
	}) {
		return this.invoke<IAdeWhiteboard>('uiConfigureWhiteboard', [input]);
	}
	uiDeleteWhiteboard(projectId: string, boardId: string) {
		return this.invoke<void>('uiDeleteWhiteboard', [projectId, boardId]);
	}
	uiManageWhiteboardItem(input: {
		readonly projectId: string;
		readonly boardId: string;
		readonly itemId: string;
		readonly pin?: boolean;
		readonly stars?: 1 | 2 | 3 | 4 | 5;
		readonly tags?: readonly string[];
		readonly deleteItem?: boolean;
	}) {
		return this.invoke<void>('uiManageWhiteboardItem', [input]);
	}
	uiInspectWhiteboard(projectId: string, boardId: string, filter?: IAdeWbItemsFilter) {
		return this.invoke<IAdeUiWhiteboardInspection>('uiInspectWhiteboard', [projectId, boardId, filter]);
	}
	uiReadWhiteboardItemDetail(projectId: string, boardId: string, itemId: string) {
		return this.invoke<string>('uiReadWhiteboardItemDetail', [projectId, boardId, itemId]);
	}
	uiDownloadWhiteboardFile(projectId: string, boardId: string, itemId: string, destPath: string) {
		return this.invoke<string>('uiDownloadWhiteboardFile', [projectId, boardId, itemId, destPath]);
	}
	uiReadWhiteboardNoteDetail(projectId: string, boardId: string, noteId: string) {
		return this.invoke<string>('uiReadWhiteboardNoteDetail', [projectId, boardId, noteId]);
	}

	getEdgeLatestTransferTime(projectId: string, edgePairKey: string) {
		return this.invoke<number | null>('getEdgeLatestTransferTime', [projectId, edgePairKey]);
	}
	listEdgeTicketTransfers(projectId: string, edgePairKey: string) {
		return this.invoke<readonly IAdeEdgeTransferRecord[]>('listEdgeTicketTransfers', [projectId, edgePairKey]);
	}
	inspectTicketFullDetailForUi(projectId: string, ticketId: string) {
		return this.invoke<IAdeUiTicketFullInspection | undefined>('inspectTicketFullDetailForUi', [projectId, ticketId]);
	}
	readTicketTaskDetailForUi(projectId: string, ticketId: string, taskId: string) {
		return this.invoke<string>('readTicketTaskDetailForUi', [projectId, ticketId, taskId]);
	}

	issueAgentLaunchBundle(projectId: string, agentId: string) {
		return this.invoke<IAdeAgentLaunchBundle>('issueAgentLaunchBundle', [projectId, agentId]);
	}
	resolveAgentBySessionResource(sessionResource: string) {
		return this.invoke<{ readonly projectId: string; readonly agent: IAdeAgentNode } | undefined>('resolveAgentBySessionResource', [sessionResource]);
	}
	markAgentSessionStarting(projectId: string, agentId: string, sessionResource?: string) {
		return this.invoke<void>('markAgentSessionStarting', [projectId, agentId, sessionResource]);
	}
	markAgentSessionStarted(projectId: string, agentId: string, info: { readonly sessionResource?: string; readonly nativeSessionId?: string }) {
		return this.invoke<void>('markAgentSessionStarted', [projectId, agentId, info]);
	}
	rollbackUnstartedIfCliMissing(projectId: string, agentId: string) {
		return this.invoke<boolean>('rollbackUnstartedIfCliMissing', [projectId, agentId]);
	}

	claimPendingDeliveries(windowId: number, limit?: number) {
		return this.invoke<readonly IAdeOutboxDeliveryItem[]>('claimPendingDeliveries', [windowId, limit]);
	}
	ackDeliveryDispatched(deliveryId: string, windowId: number) {
		return this.invoke<void>('ackDeliveryDispatched', [deliveryId, windowId]);
	}
	nackDeliveryFailed(deliveryId: string, windowId: number, error: string, cliMissing?: boolean) {
		return this.invoke<void>('nackDeliveryFailed', [deliveryId, windowId, error, cliMissing]);
	}
	releaseWindowDeliveries(windowId: number) {
		return this.invoke<void>('releaseWindowDeliveries', [windowId]);
	}
	requeueBlockedCliDeliveries(req?: { readonly projectId?: string; readonly agentId?: string }) {
		return this.invoke<{ readonly requeuedCount: number }>('requeueBlockedCliDeliveries', req !== undefined ? [req] : []);
	}

	executeCliCommand(
		caller: IAdeVerifiedCliCaller,
		command: AdeCliCommandName,
		args: Readonly<Record<string, unknown>>,
		idempotencyKey?: string,
	) {
		return this.invoke<Record<string, unknown>>('executeCliCommand', [caller, command, args, idempotencyKey]);
	}
}
