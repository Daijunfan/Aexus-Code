/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as os from 'os';
import { promisify } from 'util';
import * as zlib from 'zlib';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import * as path from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { ILogService } from '../../log/common/log.js';
import { AEXUS_SSH_SCHEME, IAdeCloudHostBackendService } from '../common/adeCloudHosts.js';
import {
	AdeCliCommandName,
	normalizeAdeEngineId,
	projectBoardItemPublicSummary,
	projectBoardNoteUnreadItem,
	projectTicketPublicView,
} from '../common/adeCliManifest.js';
import { ADE_CONTROL_DIR_NAME, ADE_REMOTE_STORE_DIR_NAME } from '../common/adeControl.js';
import * as fs from 'fs';
import {
	IAdeAgentLaunchBundle,
	IAdeAgentRuntimeDisposeEvent,
	IAdeOutboxDeliveryItem,
	IAdeShutdownAwareControlCenterService,
	IAdeUiCreateAgentInput,
	IAdeUiEditAgentInput,
	IAdeUiWhiteboardInspection,
	IAdeVerifiedCliCaller,
	IAdeWbItemsFilter,
} from '../common/adeControlCenterIpc.js';
import {
	applyAgentMove,
	applyDeptMemberAction,
	assertCallerManagesDept,
	assertCallerManagesTarget,
	assertCanCreateDepartment,
	assertCanDeleteDept,
	assertTicketAccess,
	assertWhiteboardAccess,
	canCallerManageDept,
	canCallerManageTarget,
	canReadBoardPerm,
	computeTreeTransferHops,
	freezeInvalidatedActiveTickets,
	getEffectiveDeptIds,
	IAdePolicyAgent,
	IAdePolicyBoardGrant,
	IAdePolicyDepartment,
	IAdePolicyProjectState,
	IAdePolicyTicket,
	IAdePolicyWhiteboard,
	recomputeAllParentDeptIds,
	reconcileTopologySideEffects,
	resolveWhiteboardPermission,
	transferAgentWhiteboardsOnDelete,
} from '../common/adeJurisdictionPolicy.js';
import {
	AdeBoardPermission,
	AdeError,
	AdeLayoutDirection,
	AdeMigrationState,
	AdeSessionPhase,
	AdeTicketDeliveryMode,
	AdeTicketLifecycleStatus,
	canonicalEdgePairKey,
	formatAdeTicketDeliveryPayload,
	formatLevelLabel,
	IAdeAgentNode,
	IAdeBoardGrant,
	IAdeBoardItemPublicSummary,
	IAdeCatalogSnapshot,
	IAdeDeletedAgentArchive,
	IAdeDepartment,
	IAdeEdgeTransferRecord,
	IAdeProjectHostEntry,
	IAdeProjectSnapshot,
	IAdeProjectSummaryItem,
	IAdeTicketSummaryCard,
	IAdeTicketTransferAnimationEvent,
	IAdeUiCanvasLayoutPatch,
	IAdeUiTicketFullInspection,
	IAdeUiTicketTaskRecord,
	IAdeWhiteboard,
	IAdeWorkspaceFolder,
	parseLevelInput,
} from '../common/adeModels.js';
import {
	ADE_SYSPROMPT_DOC_REV,
	ADE_SYSPROMPT_MODULE_KEYS,
	AdeSyspromptModuleKey,
	computeAdeSyspromptUpdate,
} from '../common/adeSyspromptCatalog.js';
import { AdeControlServer } from './adeControlServer.js';
import {
	AdeDynamicStorageEngine,
	IAdeStorageTransportAdapter,
	resolveTicketDetailStorageHost,
} from './adeDynamicStorageEngine.js';
import { AdeEngineProbeService } from './adeEngineProbeService.js';
import { AdeSingleSqliteDatabase, AdeSqliteStore, IAdeSqlRunner } from './adeSqliteStore.js';
import { AdeSyspromptSyncService } from './adeSyspromptSyncService.js';

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

const MAX_ARCHIVED_DETAIL_BYTES = 2 * 1024 * 1024;
const TRUNCATED_SLICE_BYTES = 128 * 1024;
const OUTBOX_LEASE_MS = 120_000;

function genId(prefix: string): string {
	return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function parseJsonArrayStrings(raw: unknown): string[] {
	if (typeof raw !== 'string' || !raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

function parseBoardPermsJson(raw: unknown): Record<string, AdeBoardPermission> {
	if (typeof raw !== 'string' || !raw) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}
		const out: Record<string, AdeBoardPermission> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (v === 'read' || v === 'write' || v === 'read_write') {
				out[k] = v;
			}
		}
		return out;
	} catch {
		return {};
	}
}

function parseBooleanArg(raw: unknown, flagName: string): boolean {
	if (typeof raw === 'boolean') {
		return raw;
	}
	if (typeof raw === 'string') {
		const low = raw.trim().toLowerCase();
		if (low === 'true') {
			return true;
		}
		if (low === 'false') {
			return false;
		}
	}
	throw new AdeError('ERR_INVALID_ARGS', `${flagName} 参数必须为 true 或 false`);
}

function parseStarsValue(raw: unknown): 1 | 2 | 3 | 4 | 5 {
	const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^[1-5]$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : NaN);
	if (!Number.isInteger(n) || n < 1 || n > 5) {
		throw new AdeError('ERR_INVALID_ARGS', '--stars 必须为 1 到 5 之间的整数');
	}
	return n as 1 | 2 | 3 | 4 | 5;
}

function parseStarsFilterRange(raw: unknown): { readonly min: number; readonly max: number } | undefined {
	if (raw === undefined || raw === null || raw === '') {
		return undefined;
	}
	const str = String(raw).trim();
	const single = /^([1-5])$/.exec(str);
	if (single) {
		const v = Number.parseInt(single[1], 10);
		return { min: v, max: v };
	}
	const range = /^([1-5])-([1-5])$/.exec(str);
	if (range) {
		const a = Number.parseInt(range[1], 10);
		const b = Number.parseInt(range[2], 10);
		if (a > b) {
			throw new AdeError('ERR_INVALID_ARGS', `--stars 区间下界不可大于上界: ${str}`);
		}
		return { min: a, max: b };
	}
	throw new AdeError('ERR_INVALID_ARGS', `非法的 --stars 筛选格式: ${str}（支持 1..5 或 M-N）`);
}

function parseTagListInput(raw: unknown): string[] {
	if (raw === undefined || raw === null) {
		return [];
	}
	if (Array.isArray(raw)) {
		return Array.from(new Set(raw.map(x => String(x).trim()).filter(Boolean)));
	}
	const s = String(raw).trim();
	if (!s) {
		return [];
	}
	return Array.from(new Set(s.split(',').map(t => t.trim()).filter(Boolean)));
}

function requireNonEmptyString(raw: unknown, fieldLabel: string): string {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		throw new AdeError('ERR_INVALID_ARGS', `缺少必填参数或参数为空: ${fieldLabel}`);
	}
	return raw.trim();
}

function assertAllowedArgKeys(args: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const set = new Set(allowed);
	for (const k of Object.keys(args)) {
		if (!set.has(k)) {
			throw new AdeError('ERR_INVALID_ARGS', `存在不支持的参数项: ${k}`);
		}
	}
}

export interface IAdeControlCenterServiceOptions {
	readonly adeHomeDir?: string;
	readonly socketPath?: string;
	readonly persistIdempotencyLedger?: boolean;
	readonly cloudHostService?: IAdeCloudHostBackendService;
	readonly customStorageTransport?: IAdeStorageTransportAdapter;
	readonly maxDataStreamsPerHost?: number;
	readonly customLocalEngineProber?: () => Promise<readonly ('claude' | 'codex' | 'kilo' | 'opencode' | 'dsh' | 'antigravity' | 'cline' | 'pi')[]>;
	readonly logService?: ILogService;
}

interface IRawAgentRow {
	agent_id: string;
	project_id: string;
	level: number;
	is_top_role: number;
	parent_id: string | null;
	name: string;
	role_summary: string;
	host: string;
	engine: string;
	model: string;
	effort: string;
	session_phase: AdeSessionPhase;
	session_started: number;
	excluded_dept_ids: string;
	session_resource: string | null;
	native_session_id: string | null;
	last_read_doc_rev: number;
	token_gen: number;
	canvas_x: number | null;
	canvas_y: number | null;
	color_token: string | null;
	created_at: number;
	updated_at: number;
}

interface IRawDepartmentRow {
	dept_id: string;
	project_id: string;
	name: string;
	root_agent_id: string;
	parent_dept_id: string | null;
	board_permissions: string;
	created_by: string;
	created_at: number;
	updated_at: number;
}

interface IRawWhiteboardRow {
	board_id: string;
	project_id: string;
	name: string;
	owner_id: string | null;
	dept_id: string | null;
	storage_host: string;
	tag_categories: string;
	migration_epoch: number;
	migration_state: AdeMigrationState;
	canvas_x: number | null;
	canvas_y: number | null;
	created_at: number;
	updated_at: number;
}

interface IRawBoardGrantRow {
	board_id: string;
	agent_id: string;
	permission: AdeBoardPermission;
	granted_by: string;
	updated_at: number;
}

interface IRawTicketRow {
	ticket_id: string;
	project_id: string;
	creator_id: string;
	peer_id: string;
	ticket_level: number;
	from_id: string;
	to_id: string;
	holder_id: string | null;
	delivery_mode: AdeTicketDeliveryMode;
	need_return: number;
	current_task_id: string;
	current_task_type: string;
	current_task_title: string;
	current_task_summary: string;
	current_has_detail_ref: number;
	has_history_ref: number;
	status: AdeTicketLifecycleStatus;
	created_at: number;
	updated_at: number;
	frozen_at: number | null;
	destroyed_at: number | null;
}

export class AdeControlCenterService extends Disposable implements IAdeShutdownAwareControlCenterService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeCatalog = this._register(new Emitter<void>());
	readonly onDidChangeCatalog = this._onDidChangeCatalog.event;

	private readonly _onDidChangeProject = this._register(new Emitter<{ readonly projectId: string }>());
	readonly onDidChangeProject = this._onDidChangeProject.event;

	private readonly _onDidTransferTicket = this._register(new Emitter<IAdeTicketTransferAnimationEvent>());
	readonly onDidTransferTicket = this._onDidTransferTicket.event;

	private readonly _onDidEnqueueOutbox = this._register(new Emitter<{ readonly projectId: string; readonly targetAgentId: string }>());
	readonly onDidEnqueueOutbox = this._onDidEnqueueOutbox.event;

	private readonly _onDidCancelOutboxTickets = this._register(new Emitter<{ readonly projectId: string; readonly ticketIds: readonly string[] }>());
	readonly onDidCancelOutboxTickets = this._onDidCancelOutboxTickets.event;

	private readonly _onDidDisposeAgentRuntime = this._register(new Emitter<IAdeAgentRuntimeDisposeEvent>());
	readonly onDidDisposeAgentRuntime = this._onDidDisposeAgentRuntime.event;

	readonly adeHomeDir: string;
	readonly sqliteStore: AdeSqliteStore;
	readonly storageEngine: AdeDynamicStorageEngine;
	readonly syspromptSync: AdeSyspromptSyncService;
	readonly engineProber: AdeEngineProbeService;
	readonly controlServer: AdeControlServer;

	private readonly cloudHosts?: IAdeCloudHostBackendService;
	private readonly logService?: ILogService;
	private readonly _inflightServiceCalls = new Set<Promise<unknown>>();
	private readonly inflightProjectOps = new Map<string, Set<Promise<unknown>>>();
	private readonly activeDeleteProjects = new Map<string, Promise<void>>();
	private readonly activeMigrations = new Map<string, Promise<void>>();
	private readonly deletingProjects = new Set<string>();
	private readonly deletingWhiteboards = new Set<string>();
	private readonly healedProjectDbs = new Map<string, Promise<void>>();
	private startupHealPromise: Promise<void> | undefined;
	private shuttingDown = false;
	private _isDisposed = false;
	private shutdownPromise: Promise<void> | undefined;
	private readonly initDocsPromise: Promise<unknown>;

	constructor(options?: IAdeControlCenterServiceOptions) {
		super();
		this.adeHomeDir = options?.adeHomeDir ?? path.join(os.homedir(), ADE_CONTROL_DIR_NAME);
		this.cloudHosts = options?.cloudHostService;
		this.logService = options?.logService;

		this.sqliteStore = new AdeSqliteStore({ adeHomeDir: this.adeHomeDir });
		this.storageEngine = new AdeDynamicStorageEngine({
			sqliteStore: this.sqliteStore,
			cloudHostService: this.cloudHosts,
			customTransport: options?.customStorageTransport,
			maxDataStreamsPerHost: options?.maxDataStreamsPerHost,
			homedir: os.homedir(),
			logService: this.logService,
		});
		this.syspromptSync = new AdeSyspromptSyncService({
			adeHomeDir: this.adeHomeDir,
			cloudHostService: this.cloudHosts,
		});
		this.engineProber = new AdeEngineProbeService({
			cloudHostService: this.cloudHosts,
			customLocalProber: options?.customLocalEngineProber,
		});
		this.controlServer = new AdeControlServer(
			(caller, command, args, idempKey) => this.executeCliCommand(caller, command, args, idempKey),
			{
				controlDir: this.adeHomeDir,
				socketPath: options?.socketPath,
				persistIdempotencyLedger: options?.persistIdempotencyLedger,
				logService: this.logService,
			},
		);

		this.initDocsPromise = this.syspromptSync.ensureLocalSyspromptDocs().catch(err => {
			this.logService?.warn('[AdeControlCenter] Failed to pre-sync local 0444 sysprompt docs', err);
		});

		if (this.cloudHosts) {
			this._register(this.cloudHosts.onDidChangeHosts(() => {
				this.engineProber.invalidateCache();
				this.storageEngine.invalidateHostMappingCache();
				this.syspromptSync.invalidateRemoteSyspromptCache();
				void this.storageEngine.drainTombstonesAsync().catch(() => undefined);
			}));
		}
	}

	get isShuttingDown(): boolean {
		return this.shuttingDown || this._isDisposed;
	}

	get inflightServiceCallCount(): number {
		return this._inflightServiceCalls.size;
	}

	trackExternalIpcCall<T>(fn: () => Promise<T>): Promise<T> {
		return this.trackServiceCall(fn);
	}

	private trackServiceCall<T>(fn: () => Promise<T>): Promise<T> {
		const p = Promise.resolve().then(fn).finally(() => {
			this._inflightServiceCalls.delete(p);
		});
		this._inflightServiceCalls.add(p);
		return p;
	}

	private async drainInflightServiceCalls(): Promise<void> {
		while (this._inflightServiceCalls.size > 0) {
			await Promise.allSettled([...this._inflightServiceCalls]);
		}
	}

	private trackProjectOp<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
		let set = this.inflightProjectOps.get(projectId);
		if (!set) {
			set = new Set();
			this.inflightProjectOps.set(projectId, set);
		}
		const targetSet = set;
		const p = Promise.resolve().then(fn).finally(() => {
			targetSet.delete(p);
			if (targetSet.size === 0 && this.inflightProjectOps.get(projectId) === targetSet) {
				this.inflightProjectOps.delete(projectId);
			}
		});
		targetSet.add(p);
		return p;
	}

	private assertNotShuttingDown(): void {
		if (this.shuttingDown || this._isDisposed) {
			throw new AdeError('ERR_UNAUTHORIZED', '控制中心正在关停，拒绝新命令请求');
		}
	}

	private isProjectDeletingOrRemoved(projectId: string): boolean {
		return this.deletingProjects.has(projectId) || this.sqliteStore.isProjectRemovedOrClosing(projectId);
	}

	private makeBoardDeleteKey(projectId: string, boardId: string): string {
		return `${projectId}:${boardId}`;
	}

	private isWhiteboardDeleting(projectId: string, boardId: string): boolean {
		return this.deletingWhiteboards.has(this.makeBoardDeleteKey(projectId, boardId));
	}

	private isMigrationScopeDeleting(projectId: string, scopeType: 'whiteboard' | 'ticket', scopeId: string): boolean {
		return this.isProjectDeletingOrRemoved(projectId)
			|| (scopeType === 'whiteboard' && this.isWhiteboardDeleting(projectId, scopeId));
	}

	private canEmitEvents(): boolean {
		return !this.shuttingDown && !this._isDisposed && !this._store.isDisposed;
	}

	private fireDidChangeCatalog(): void {
		if (this.canEmitEvents()) {
			this._onDidChangeCatalog.fire();
		}
	}

	private fireDidChangeProject(projectId: string): void {
		if (this.canEmitEvents()) {
			this._onDidChangeProject.fire({ projectId });
		}
	}

	private fireDidTransferTicket(ev: IAdeTicketTransferAnimationEvent): void {
		if (this.canEmitEvents()) {
			this._onDidTransferTicket.fire(ev);
		}
	}

	private fireDidEnqueueOutbox(ev: { readonly projectId: string; readonly targetAgentId: string }): void {
		if (this.canEmitEvents()) {
			this._onDidEnqueueOutbox.fire(ev);
		}
	}

	private fireDidCancelOutboxTickets(ev: { readonly projectId: string; readonly ticketIds: readonly string[] }): void {
		if (this.canEmitEvents()) {
			this._onDidCancelOutboxTickets.fire(ev);
		}
	}

	private fireDidDisposeAgentRuntime(ev: IAdeAgentRuntimeDisposeEvent): void {
		if (this.canEmitEvents()) {
			this._onDidDisposeAgentRuntime.fire(ev);
		}
	}

	private hasActiveMigrationScope(projectId: string, scopeType: 'whiteboard' | 'ticket', scopeId: string): boolean {
		const prefix = `${projectId}:${scopeType}:${scopeId}:`;
		for (const key of this.activeMigrations.keys()) {
			if (key.startsWith(prefix)) {
				return true;
			}
		}
		return false;
	}

	private ensureProjectDbHealed(projectId: string, pdb: AdeSingleSqliteDatabase): Promise<void> {
		if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
			return Promise.resolve();
		}
		let healTask = this.healedProjectDbs.get(projectId);
		if (!healTask) {
			healTask = this.healStaleTransferringInDb(projectId, pdb).catch(err => {
				this.healedProjectDbs.delete(projectId);
				throw err;
			});
			this.healedProjectDbs.set(projectId, healTask);
		}
		return healTask;
	}

	private async ensureOutboxSupportsBlockedCliInTx(tx: IAdeSqlRunner): Promise<void> {
		const row = await tx.get<{ sql?: string }>(
			`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ticket_delivery_outbox'`,
		);
		if (!row?.sql || row.sql.includes('blocked_cli')) {
			return;
		}
		await tx.exec(`
			CREATE TABLE ticket_delivery_outbox_v2 (
				delivery_id          TEXT PRIMARY KEY,
				ticket_id            TEXT NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
				task_id              TEXT NOT NULL,
				target_agent_id      TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
				delivery_mode        TEXT NOT NULL CHECK (delivery_mode IN ('queue', 'steer')),
				payload_text         TEXT NOT NULL,
				state                TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'in_flight', 'claimed', 'acked', 'failed', 'dead_letter', 'blocked_cli')),
				claimed_by_window_id INTEGER,
				leased_until         INTEGER,
				attempts             INTEGER NOT NULL DEFAULT 0,
				next_retry_at        INTEGER NOT NULL DEFAULT 0,
				last_error           TEXT,
				created_at           INTEGER NOT NULL,
				UNIQUE (ticket_id, task_id)
			);
			INSERT INTO ticket_delivery_outbox_v2 (
				delivery_id, ticket_id, task_id, target_agent_id, delivery_mode, payload_text,
				state, claimed_by_window_id, leased_until, attempts, next_retry_at, last_error, created_at
			)
			SELECT
				delivery_id, ticket_id, task_id, target_agent_id, delivery_mode, payload_text,
				state, claimed_by_window_id, leased_until, attempts, next_retry_at, last_error, created_at
			FROM ticket_delivery_outbox;
			DROP TABLE ticket_delivery_outbox;
			ALTER TABLE ticket_delivery_outbox_v2 RENAME TO ticket_delivery_outbox;
			CREATE INDEX IF NOT EXISTS idx_outbox_pending ON ticket_delivery_outbox(state, next_retry_at ASC, created_at ASC);
			CREATE INDEX IF NOT EXISTS idx_outbox_window ON ticket_delivery_outbox(claimed_by_window_id) WHERE state = 'in_flight';
		`);
	}

	private async tryOpenHealedActiveProjectDb(projectId: string): Promise<AdeSingleSqliteDatabase | undefined> {
		const pdb = await this.sqliteStore.tryOpenActiveProjectDb(projectId);
		if (!pdb) {
			return undefined;
		}
		await this.ensureProjectDbHealed(projectId, pdb).catch(() => undefined);
		if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
			return undefined;
		}
		return pdb;
	}

	private async healStaleTransferringInDb(projectId: string, pdb: AdeSingleSqliteDatabase): Promise<void> {
		if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
			return;
		}
		let changed = false;
		await pdb.transaction(async tx => {
			await this.ensureOutboxSupportsBlockedCliInTx(tx);
			const now = Date.now();
			const meta = await tx.get<{ ticket_migration_state: string }>(
				`SELECT ticket_migration_state FROM project_meta WHERE project_id = ?`,
				[projectId],
			);
			if (meta?.ticket_migration_state === 'transferring' && !this.hasActiveMigrationScope(projectId, 'ticket', projectId)) {
				await tx.run(
					`UPDATE project_meta SET ticket_migration_state = 'failed', updated_at = ? WHERE project_id = ? AND ticket_migration_state = 'transferring'`,
					[now, projectId],
				);
				await tx.run(
					`UPDATE storage_migration_items
					 SET phase = 'failed', last_error = COALESCE(last_error, 'Recovered stale transferring state on startup'), updated_at = ?
					 WHERE scope_type = 'ticket' AND scope_id = ? AND phase = 'pending'`,
					[now, projectId],
				);
				changed = true;
			}
			const staleBoards = await tx.all<{ board_id: string }>(
				`SELECT board_id FROM whiteboards WHERE migration_state = 'transferring'`,
			);
			for (const wb of staleBoards) {
				if (!this.hasActiveMigrationScope(projectId, 'whiteboard', wb.board_id)) {
					await tx.run(
						`UPDATE whiteboards SET migration_state = 'failed', updated_at = ? WHERE board_id = ? AND migration_state = 'transferring'`,
						[now, wb.board_id],
					);
					await tx.run(
						`UPDATE storage_migration_items
						 SET phase = 'failed', last_error = COALESCE(last_error, 'Recovered stale transferring state on startup'), updated_at = ?
						 WHERE scope_type = 'whiteboard' AND scope_id = ? AND phase = 'pending'`,
						[now, wb.board_id],
					);
					changed = true;
				}
			}
		});
		if (changed && !this.isProjectDeletingOrRemoved(projectId)) {
			this.fireDidChangeProject(projectId);
		}
	}

	private ensureStartupSelfHeal(): Promise<void> {
		if (!this.startupHealPromise) {
			this.startupHealPromise = (async () => {
				if (this.shuttingDown || this._isDisposed) {
					return;
				}
				const catalogDbPath = path.join(this.sqliteStore.controlCenterDir, 'catalog.db');
				const exists = await fs.promises.stat(catalogDbPath).then(st => st.isFile(), () => false);
				if (!exists || this.shuttingDown || this._isDisposed) {
					return;
				}
				const rows = await this.sqliteStore.catalog.all<{ project_id: string }>(`SELECT project_id FROM projects_index`).catch(() => []);
				for (const r of rows) {
					if (this.shuttingDown || this._isDisposed) {
						break;
					}
					if (this.isProjectDeletingOrRemoved(r.project_id)) {
						continue;
					}
					const pdb = await this.sqliteStore.tryOpenActiveProjectDb(r.project_id);
					if (pdb) {
						await this.ensureProjectDbHealed(r.project_id, pdb).catch(err => {
							this.logService?.warn(`[AdeControlCenter] Startup migration self-heal warning (${r.project_id})`, err);
						});
					}
				}
			})();
		}
		return this.startupHealPromise;
	}

	async whenReady(): Promise<void> {
		await Promise.all([
			this.controlServer.whenReady(),
			this.initDocsPromise,
			this.ensureStartupSelfHeal(),
		]);
	}

	async notifySystemResume(): Promise<void> {
		if (this.shuttingDown || this._isDisposed) {
			return;
		}
		return this.trackServiceCall(async () => {
			if (this.shuttingDown || this._isDisposed) {
				return;
			}
			this.engineProber.invalidateCache();
			this.storageEngine.invalidateHostMappingCache();
			this.syspromptSync.invalidateRemoteSyspromptCache();
			await this.storageEngine.drainTombstonesAsync().catch(() => undefined);
		});
	}

	gracefulShutdown(): Promise<void> {
		if (!this.shutdownPromise) {
			this.shuttingDown = true;
			this.shutdownPromise = (async () => {
				try {
					await Promise.allSettled([
						this.controlServer.stopAndClose().catch(() => undefined),
						this.drainInflightServiceCalls(),
					]);
					this.storageEngine.abortActiveStreamsForShutdown();
					while (this.activeMigrations.size > 0) {
						await Promise.allSettled([...this.activeMigrations.values()]);
					}
					await this.storageEngine.waitForPendingGc();
					await this.sqliteStore.shutdownAll().catch(() => undefined);
				} finally {
					this._isDisposed = true;
					this.controlServer.dispose();
					this.storageEngine.dispose();
					this.sqliteStore.dispose();
					super.dispose();
				}
			})();
		}
		return this.shutdownPromise;
	}

	// =========================================================================
	// Catalog & Project Pages (Left Sidebar 1..N)
	// =========================================================================

	async getCatalogSnapshot(): Promise<IAdeCatalogSnapshot> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.sqliteStore.catalog.withLock(async runner => {
			const folderRows = await runner.all<{
				folder_id: string;
				folder_uri: string;
				display_name: string;
				host: string;
				sort_order: number;
				collapsed: number;
				created_at: number;
				updated_at: number;
			}>(`SELECT * FROM workspace_folders ORDER BY sort_order ASC, created_at ASC`);
			const projectRows = await runner.all<{
				project_id: string;
				folder_id: string;
				folder_uri: string;
				name: string;
				sort_order: number;
				created_at: number;
				updated_at: number;
			}>(`SELECT * FROM projects_index ORDER BY sort_order ASC, created_at ASC`);

			const folders: IAdeWorkspaceFolder[] = folderRows.map(r => ({
				folder_id: r.folder_id,
				folder_uri: r.folder_uri,
				display_name: r.display_name,
				host: r.host,
				sort_order: r.sort_order,
				collapsed: r.collapsed === 1,
				created_at: r.created_at,
				updated_at: r.updated_at,
			}));
			const projects: IAdeProjectSummaryItem[] = projectRows
				.filter(r => !this.isProjectDeletingOrRemoved(r.project_id))
				.map(r => ({
					project_id: r.project_id,
					folder_id: r.folder_id,
					folder_uri: r.folder_uri,
					name: r.name,
					sort_order: r.sort_order,
					created_at: r.created_at,
					updated_at: r.updated_at,
				}));
			return { folders, projects };
		}));
	}

	private async resolveFolderHostAndLabel(folderUriStr: string, explicitHost?: string, explicitName?: string): Promise<{
		readonly normUri: string;
		readonly displayName: string;
		readonly host: string;
	}> {
		const parsed = URI.parse(folderUriStr.trim());
		const normUri = parsed.toString();
		const baseLabel = explicitName?.trim() || path.posix.basename(parsed.path.replace(/\/+$/, '')) || parsed.authority || normUri;
		if (explicitHost?.trim()) {
			return { normUri, displayName: baseLabel, host: explicitHost.trim() };
		}
		if (parsed.scheme === AEXUS_SSH_SCHEME && parsed.authority) {
			if (this.cloudHosts) {
				const h = await this.cloudHosts.getHost(parsed.authority);
				if (h?.hostName) {
					return { normUri, displayName: baseLabel, host: h.hostName };
				}
			}
			return { normUri, displayName: baseLabel, host: parsed.authority };
		}
		return { normUri, displayName: baseLabel, host: 'local' };
	}

	private async registerWorkspaceFolderInternal(input: { readonly folderUri: string; readonly displayName?: string; readonly host?: string }): Promise<IAdeWorkspaceFolder> {
		this.assertNotShuttingDown();
		const { normUri, displayName, host } = await this.resolveFolderHostAndLabel(input.folderUri, input.host, input.displayName);
		this.assertNotShuttingDown();
		const now = Date.now();
		const folder = await this.sqliteStore.catalog.transaction(async tx => {
			this.assertNotShuttingDown();
			const existing = await tx.get<{
				folder_id: string;
				folder_uri: string;
				display_name: string;
				host: string;
				sort_order: number;
				collapsed: number;
				created_at: number;
				updated_at: number;
			}>(`SELECT * FROM workspace_folders WHERE folder_uri = ?`, [normUri]);
			if (existing) {
				return {
					folder_id: existing.folder_id,
					folder_uri: existing.folder_uri,
					display_name: existing.display_name,
					host: existing.host,
					sort_order: existing.sort_order,
					collapsed: existing.collapsed === 1,
					created_at: existing.created_at,
					updated_at: existing.updated_at,
				} satisfies IAdeWorkspaceFolder;
			}
			const maxRow = await tx.get<{ m: number | null }>(`SELECT MAX(sort_order) AS m FROM workspace_folders`);
			const sortOrder = (maxRow?.m ?? -1) + 1;
			const folderId = genId('fld');
			await tx.run(
				`INSERT INTO workspace_folders (folder_id, folder_uri, display_name, host, sort_order, collapsed, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
				[folderId, normUri, displayName, host, sortOrder, now, now],
			);
			return {
				folder_id: folderId,
				folder_uri: normUri,
				display_name: displayName,
				host,
				sort_order: sortOrder,
				collapsed: false,
				created_at: now,
				updated_at: now,
			} satisfies IAdeWorkspaceFolder;
		});
		this.fireDidChangeCatalog();
		return folder;
	}

	async registerWorkspaceFolder(input: { readonly folderUri: string; readonly displayName?: string; readonly host?: string }): Promise<IAdeWorkspaceFolder> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.registerWorkspaceFolderInternal(input));
	}

	async removeWorkspaceFolder(folderUri: string): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(async () => {
			this.assertNotShuttingDown();
			const normUri = URI.parse(folderUri.trim()).toString();
			const projectIds = await this.sqliteStore.catalog.all<{ project_id: string }>(
				`SELECT project_id FROM projects_index WHERE folder_uri = ?`,
				[normUri],
			);
			for (const p of projectIds) {
				this.assertNotShuttingDown();
				await this.deleteProjectInternal(p.project_id);
			}
			this.assertNotShuttingDown();
			await this.sqliteStore.catalog.run(`DELETE FROM workspace_folders WHERE folder_uri = ?`, [normUri]);
			this.fireDidChangeCatalog();
		});
	}

	async reorderWorkspaceFolder(sourceUri: string, targetUri: string | undefined, after: boolean): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(async () => {
			this.assertNotShuttingDown();
			const normSrc = URI.parse(sourceUri.trim()).toString();
			const normTgt = targetUri ? URI.parse(targetUri.trim()).toString() : undefined;
			await this.sqliteStore.catalog.transaction(async tx => {
				this.assertNotShuttingDown();
				const rows = await tx.all<{ folder_id: string; folder_uri: string }>(
					`SELECT folder_id, folder_uri FROM workspace_folders ORDER BY sort_order ASC, created_at ASC`,
				);
				const srcIdx = rows.findIndex(r => r.folder_uri === normSrc);
				if (srcIdx < 0) {
					return;
				}
				const [moved] = rows.splice(srcIdx, 1);
				if (!normTgt) {
					rows.push(moved);
				} else {
					const tgtIdx = rows.findIndex(r => r.folder_uri === normTgt);
					if (tgtIdx < 0) {
						rows.push(moved);
					} else {
						rows.splice(after ? tgtIdx + 1 : tgtIdx, 0, moved);
					}
				}
				const now = Date.now();
				for (let i = 0; i < rows.length; i++) {
					await tx.run(`UPDATE workspace_folders SET sort_order = ?, updated_at = ? WHERE folder_id = ?`, [i, now, rows[i].folder_id]);
				}
			});
			this.fireDidChangeCatalog();
		});
	}

	async setWorkspaceFolderCollapsed(folderUri: string, collapsed: boolean): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(async () => {
			this.assertNotShuttingDown();
			const normUri = URI.parse(folderUri.trim()).toString();
			await this.sqliteStore.catalog.run(
				`UPDATE workspace_folders SET collapsed = ?, updated_at = ? WHERE folder_uri = ?`,
				[collapsed ? 1 : 0, Date.now(), normUri],
			);
			this.fireDidChangeCatalog();
		});
	}

	async migrateCloudHostAlias(oldAlias: string, newAlias: string): Promise<number> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(async () => {
			this.assertNotShuttingDown();
			const oldPrefix = `${AEXUS_SSH_SCHEME}://${oldAlias.trim()}/`;
			const newPrefix = `${AEXUS_SSH_SCHEME}://${newAlias.trim()}/`;
			if (oldPrefix === newPrefix) {
				return 0;
			}
			let updatedCount = 0;
			const affectedProjects: Array<{ project_id: string; next_uri: string }> = [];
			await this.sqliteStore.catalog.transaction(async tx => {
				this.assertNotShuttingDown();
				const folders = await tx.all<{ folder_id: string; folder_uri: string }>(
					`SELECT folder_id, folder_uri FROM workspace_folders WHERE folder_uri LIKE ?`,
					[`${oldPrefix}%`],
				);
				const now = Date.now();
				for (const f of folders) {
					const nextUri = `${newPrefix}${f.folder_uri.slice(oldPrefix.length)}`;
					await tx.run(`UPDATE workspace_folders SET folder_uri = ?, updated_at = ? WHERE folder_id = ?`, [nextUri, now, f.folder_id]);
					updatedCount++;
				}
				const projs = await tx.all<{ project_id: string; folder_uri: string }>(
					`SELECT project_id, folder_uri FROM projects_index WHERE folder_uri LIKE ?`,
					[`${oldPrefix}%`],
				);
				for (const p of projs) {
					if (this.isProjectDeletingOrRemoved(p.project_id)) {
						continue;
					}
					const nextUri = `${newPrefix}${p.folder_uri.slice(oldPrefix.length)}`;
					await tx.run(`UPDATE projects_index SET folder_uri = ?, updated_at = ? WHERE project_id = ?`, [nextUri, now, p.project_id]);
					affectedProjects.push({ project_id: p.project_id, next_uri: nextUri });
				}
			});
			for (const ap of affectedProjects) {
				if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(ap.project_id)) {
					continue;
				}
				await this.trackProjectOp(ap.project_id, async () => {
					if (this.isProjectDeletingOrRemoved(ap.project_id)) {
						return;
					}
					const pdb = await this.sqliteStore.tryOpenActiveProjectDb(ap.project_id);
					if (!pdb) {
						return;
					}
					await pdb.run(`UPDATE project_meta SET folder_uri = ?, updated_at = ? WHERE project_id = ?`, [ap.next_uri, Date.now(), ap.project_id]).catch(() => undefined);
					if (!this.isProjectDeletingOrRemoved(ap.project_id)) {
						this.fireDidChangeProject(ap.project_id);
					}
				});
			}
			if (updatedCount > 0 || affectedProjects.length > 0) {
				this.storageEngine.invalidateHostMappingCache();
				this.syspromptSync.invalidateRemoteSyspromptCache();
				this.fireDidChangeCatalog();
			}
			return updatedCount;
		});
	}

	async createProject(input: { readonly folderUri: string; readonly name?: string }): Promise<IAdeProjectSnapshot> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(async () => {
			const folder = await this.registerWorkspaceFolderInternal({ folderUri: input.folderUri });
			this.assertNotShuttingDown();
			const projectId = genId('proj');
			const now = Date.now();

			return this.trackProjectOp(projectId, async () => {
				this.sqliteStore.registerOrClearRemovedProject(projectId);
				const projectName = await this.sqliteStore.catalog.transaction(async tx => {
					this.assertNotShuttingDown();
					const siblings = await tx.all<{ name: string; sort_order: number }>(
						`SELECT name, sort_order FROM projects_index WHERE folder_id = ? ORDER BY sort_order ASC`,
						[folder.folder_id],
					);
					let chosenName = input.name?.trim();
				if (!chosenName) {
						const base = siblings.length === 0 ? folder.display_name : `${folder.display_name} (${siblings.length + 1})`;
						chosenName = base;
					}
					const maxSort = siblings.reduce((m, s) => Math.max(m, s.sort_order), -1);
					await tx.run(
						`INSERT INTO projects_index (project_id, folder_id, folder_uri, name, sort_order, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?)`,
						[projectId, folder.folder_id, folder.folder_uri, chosenName, maxSort + 1, now, now],
					);
					return chosenName;
				});

				const pdb = this.sqliteStore.openProjectDb(projectId);
				const defaultTicketHost = folder.host !== 'local' ? folder.host : 'local';
				await pdb.transaction(async tx => {
					await this.ensureOutboxSupportsBlockedCliInTx(tx);
					await tx.run(
						`INSERT INTO project_meta
						 (project_id, folder_id, folder_uri, name, cross_host_ticket_storage, ticket_migration_epoch, ticket_migration_state, layout_direction, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, 0, 'idle', 'TD', ?, ?)`,
						[projectId, folder.folder_id, folder.folder_uri, projectName, defaultTicketHost, now, now],
					);
					await this.syncProjectHostsTableInTx(tx);
				});
				this.healedProjectDbs.set(projectId, Promise.resolve());

				this.fireDidChangeCatalog();
				this.fireDidChangeProject(projectId);
				return (await this.getProjectSnapshotInternal(projectId))!;
			});
		});
	}

	async renameProject(projectId: string, name: string): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			this.assertNotShuttingDown();
			if (this.isProjectDeletingOrRemoved(projectId)) {
				throw new AdeError('ERR_INVALID_ARGS', `指定的项目不存在: ${projectId}`);
			}
			const cleanName = requireNonEmptyString(name, 'name');
			const now = Date.now();
			const res = await this.sqliteStore.catalog.run(
				`UPDATE projects_index SET name = ?, updated_at = ? WHERE project_id = ?`,
				[cleanName, now, projectId],
			);
			if (res.changes === 0 || this.isProjectDeletingOrRemoved(projectId)) {
				throw new AdeError('ERR_INVALID_ARGS', `指定的项目不存在: ${projectId}`);
			}
			const pdb = await this.requireProjectDb(projectId);
			await pdb.run(`UPDATE project_meta SET name = ?, updated_at = ? WHERE project_id = ?`, [cleanName, now, projectId]);
			this.fireDidChangeCatalog();
			this.fireDidChangeProject(projectId);
		}));
	}

	async reorderProject(projectId: string, targetProjectId: string | undefined, after: boolean): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			this.assertNotShuttingDown();
			if (this.isProjectDeletingOrRemoved(projectId)) {
				return;
			}
			await this.sqliteStore.catalog.transaction(async tx => {
				this.assertNotShuttingDown();
				const src = await tx.get<{ folder_id: string }>(`SELECT folder_id FROM projects_index WHERE project_id = ?`, [projectId]);
				if (!src) {
					return;
				}
				const siblings = await tx.all<{ project_id: string }>(
					`SELECT project_id FROM projects_index WHERE folder_id = ? ORDER BY sort_order ASC, created_at ASC`,
					[src.folder_id],
				);
				const idx = siblings.findIndex(s => s.project_id === projectId);
				if (idx < 0) {
					return;
				}
				const [moved] = siblings.splice(idx, 1);
				if (!targetProjectId) {
					siblings.push(moved);
				} else {
					const tIdx = siblings.findIndex(s => s.project_id === targetProjectId);
				if (tIdx < 0) {
						siblings.push(moved);
					} else {
						siblings.splice(after ? tIdx + 1 : tIdx, 0, moved);
					}
				}
				const now = Date.now();
				for (let i = 0; i < siblings.length; i++) {
					await tx.run(`UPDATE projects_index SET sort_order = ?, updated_at = ? WHERE project_id = ?`, [i, now, siblings[i].project_id]);
				}
			});
			this.fireDidChangeCatalog();
		}));
	}

	async deleteProject(projectId: string): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.deleteProjectInternal(projectId));
	}

	private deleteProjectInternal(projectId: string): Promise<void> {
		const existingDelete = this.activeDeleteProjects.get(projectId);
		if (existingDelete) {
			return existingDelete;
		}
		const runDelete = (async () => {
			const idxRow = await this.sqliteStore.catalog.get<{ project_id: string; folder_uri: string }>(
				`SELECT project_id, folder_uri FROM projects_index WHERE project_id = ?`,
				[projectId],
			);
			if (!idxRow && !(await this.sqliteStore.hasProjectDbOnDiskOrOpen(projectId))) {
				return;
			}

			this.deletingProjects.add(projectId);
			try {
				this.controlServer.revokeAgentTokens(projectId);

				// Immediately isolate visibility in catalog.db so concurrent snapshot/polling loops skip this project
				await this.sqliteStore.catalog.run(`DELETE FROM projects_index WHERE project_id = ?`, [projectId]);
				this.fireDidChangeCatalog();

				// Drain ALL in-flight per-project business operations (CLI, UI mutations, routing sync) AND active migrations
				const migPrefix = `${projectId}:`;
				while (true) {
					const pending: Promise<unknown>[] = [];
					const projOps = this.inflightProjectOps.get(projectId);
					if (projOps && projOps.size > 0) {
						pending.push(...projOps);
					}
					for (const [key, p] of this.activeMigrations.entries()) {
						if (key.startsWith(migPrefix)) {
							pending.push(p);
						}
					}
					if (pending.length === 0) {
						break;
					}
					await Promise.allSettled(pending);
				}

				const pdb = (await this.sqliteStore.hasProjectDbOnDiskOrOpen(projectId))
					? this.sqliteStore.openProjectDb(projectId)
					: undefined;
				const agents = pdb ? await pdb.all<IRawAgentRow>(`SELECT * FROM agents`).catch(() => []) : [];
				const deletedAgents = pdb ? await pdb.all<{ host: string }>(`SELECT host FROM deleted_agents_archive`).catch(() => []) : [];
				const wbBlobs = pdb ? await pdb.all<{ storage_host: string | null; storage_path: string | null }>(
					`SELECT storage_host, storage_path FROM whiteboard_items WHERE storage_path IS NOT NULL
					 UNION ALL
					 SELECT storage_host, storage_path FROM whiteboard_notes WHERE storage_path IS NOT NULL
					 UNION ALL
					 SELECT storage_host, storage_path FROM ticket_tasks WHERE storage_path IS NOT NULL`,
				).catch(() => []) : [];
				const boardItemHosts = pdb ? await pdb.all<{ board_id: string; storage_host: string | null }>(
					`SELECT DISTINCT board_id, storage_host FROM whiteboard_items WHERE storage_host IS NOT NULL
					 UNION
					 SELECT DISTINCT board_id, storage_host FROM whiteboard_notes WHERE storage_host IS NOT NULL`,
				).catch(() => []) : [];
				const migBlobs = pdb ? await pdb.all<{ scope_type: string; scope_id: string; src_host: string; src_path: string; dst_host: string; dst_path: string }>(
					`SELECT scope_type, scope_id, src_host, src_path, dst_host, dst_path FROM storage_migration_items`,
				).catch(() => []) : [];
				const boards = pdb ? await pdb.all<{ board_id: string; storage_host: string }>(`SELECT board_id, storage_host FROM whiteboards`).catch(() => []) : [];

				for (const ag of agents) {
					const sshAlias = ag.host !== 'local' ? await this.tryLookupHostAlias(ag.host) : undefined;
					this.fireDidDisposeAgentRuntime({
						projectId,
						agentId: ag.agent_id,
						host: ag.host,
						sshAlias,
						engine: ag.engine,
						sessionResource: ag.session_resource ?? this.buildDeterministicSessionResource(ag.engine, projectId, ag.agent_id),
					});
				}

				const tombstones: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> = [];
				const ticketDirHosts = new Set<string>(['local']);
				const remoteWorkspaceHosts = new Set<string>();
				const boardDirHostsByBoard = new Map<string, Set<string>>();
				const addBoardDirHost = (boardId: string, host: string | null | undefined) => {
					const norm = (host || 'local').trim() || 'local';
					let set = boardDirHostsByBoard.get(boardId);
					if (!set) {
						set = new Set<string>();
						boardDirHostsByBoard.set(boardId, set);
					}
					set.add(norm);
				};

				for (const ag of agents) {
					const h = (ag.host || 'local').trim();
					if (h && h !== 'local') {
						ticketDirHosts.add(h);
						remoteWorkspaceHosts.add(h);
					}
				}
				for (const da of deletedAgents) {
					const h = (da.host || 'local').trim();
					if (h && h !== 'local') {
						ticketDirHosts.add(h);
						remoteWorkspaceHosts.add(h);
					}
				}

				for (const b of wbBlobs) {
					if (b.storage_path) {
						const host = (b.storage_host || 'local').trim() || 'local';
						tombstones.push({ projectId, storageHost: host, storagePath: b.storage_path });
					}
				}
				for (const bih of boardItemHosts) {
					addBoardDirHost(bih.board_id, bih.storage_host);
				}
				for (const m of migBlobs) {
					if (m.src_path) {
						tombstones.push({ projectId, storageHost: m.src_host || 'local', storagePath: m.src_path });
					}
					if (m.dst_path) {
						tombstones.push({ projectId, storageHost: m.dst_host || 'local', storagePath: m.dst_path });
					}
					if (m.scope_type === 'ticket') {
						if (m.src_host) {
							ticketDirHosts.add(m.src_host);
						}
						if (m.dst_host) {
							ticketDirHosts.add(m.dst_host);
						}
					} else if (m.scope_type === 'whiteboard' && m.scope_id) {
						addBoardDirHost(m.scope_id, m.src_host);
						addBoardDirHost(m.scope_id, m.dst_host);
					}
				}

				const metaTicketHostRow = pdb
					? await pdb.get<{ cross_host_ticket_storage: string }>(`SELECT cross_host_ticket_storage FROM project_meta WHERE project_id = ?`, [projectId]).catch(() => undefined)
					: undefined;
				if (metaTicketHostRow?.cross_host_ticket_storage) {
					ticketDirHosts.add(metaTicketHostRow.cross_host_ticket_storage);
				}
				for (const host of ticketDirHosts) {
					if (host === 'local') {
						tombstones.push({
							projectId,
							storageHost: 'local',
							storagePath: path.join(this.sqliteStore.localStoreRootDir, `${projectId}_tickets`),
							isDir: true,
						});
					} else if (host) {
						tombstones.push({
							projectId,
							storageHost: host,
							storagePath: `~/${ADE_REMOTE_STORE_DIR_NAME}/${projectId}_tickets`,
							isDir: true,
						});
					}
				}

				for (const wb of boards) {
					addBoardDirHost(wb.board_id, wb.storage_host);
				}
				for (const [boardId, hosts] of boardDirHostsByBoard.entries()) {
					for (const host of hosts) {
						if (host === 'local') {
							tombstones.push({
								projectId,
								storageHost: 'local',
								storagePath: path.join(this.sqliteStore.localStoreRootDir, `${projectId}_${boardId}`),
								isDir: true,
							});
						} else if (host) {
							tombstones.push({
								projectId,
								storageHost: host,
								storagePath: `~/${ADE_REMOTE_STORE_DIR_NAME}/${projectId}_${boardId}`,
								isDir: true,
							});
						}
					}
				}

				// Clean isolated routing rule workspaces (local workspaces/<projectId> & remote ~/.ade_store/workspaces/<projectId>)
				const safePid = projectId.replace(/[^A-Za-z0-9_.-]/g, '_');
				tombstones.push({
					projectId,
					storageHost: 'local',
					storagePath: path.join(this.adeHomeDir, 'workspaces', projectId),
					isDir: true,
				});
				if (safePid !== projectId) {
					tombstones.push({
						projectId,
						storageHost: 'local',
						storagePath: path.join(this.adeHomeDir, 'workspaces', safePid),
						isDir: true,
					});
				}
				for (const remoteHost of remoteWorkspaceHosts) {
					tombstones.push({
						projectId,
						storageHost: remoteHost,
						storagePath: `~/${ADE_REMOTE_STORE_DIR_NAME}/workspaces/${safePid}`,
						isDir: true,
					});
				}

				await this.storageEngine.enqueueTombstones(tombstones);

				this.healedProjectDbs.delete(projectId);
				for (const wbKey of [...this.deletingWhiteboards]) {
					if (wbKey.startsWith(migPrefix)) {
						this.deletingWhiteboards.delete(wbKey);
					}
				}
				await this.sqliteStore.closeAndRemoveProjectDb(projectId);
				this.fireDidChangeCatalog();
				this.fireDidChangeProject(projectId);
			} finally {
				this.deletingProjects.delete(projectId);
			}
		})().finally(() => {
			this.activeDeleteProjects.delete(projectId);
		});
		this.activeDeleteProjects.set(projectId, runDelete);
		return runDelete;
	}

	async getProjectSnapshot(projectId: string): Promise<IAdeProjectSnapshot | undefined> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.getProjectSnapshotInternal(projectId));
	}

	private async getProjectSnapshotInternal(projectId: string): Promise<IAdeProjectSnapshot | undefined> {
		if (this.isProjectDeletingOrRemoved(projectId)) {
			return undefined;
		}
		return this.trackProjectOp(projectId, async () => {
			if (this.isProjectDeletingOrRemoved(projectId)) {
				return undefined;
			}
			const exists = await this.sqliteStore.catalog.get<{ project_id: string }>(
				`SELECT project_id FROM projects_index WHERE project_id = ?`,
				[projectId],
			);
			if (!exists || this.isProjectDeletingOrRemoved(projectId)) {
				return undefined;
			}
			const pdb = await this.sqliteStore.tryOpenActiveProjectDb(projectId);
			if (!pdb) {
				return undefined;
			}
			await this.ensureProjectDbHealed(projectId, pdb);
			if (this.isProjectDeletingOrRemoved(projectId)) {
				return undefined;
			}
			return pdb.withLock(async runner => {
			const metaRow = await runner.get<{
				project_id: string;
				folder_id: string;
				folder_uri: string;
				name: string;
				cross_host_ticket_storage: string;
				ticket_migration_epoch: number;
				ticket_migration_state: AdeMigrationState;
				layout_direction: AdeLayoutDirection;
				created_at: number;
				updated_at: number;
			}>(`SELECT * FROM project_meta WHERE project_id = ?`, [projectId]);
			if (!metaRow) {
				return undefined;
			}
			await this.syncProjectHostsTableInTx(runner);
			const hostRows = await runner.all<{
				host_id: string;
				ip: string;
				name: string;
				ssh_alias: string;
				os_kind: 'linux' | 'macos' | 'windows';
				remote_home: string | null;
			}>(`SELECT * FROM project_hosts ORDER BY name ASC`);
			const agentRows = await runner.all<IRawAgentRow>(`SELECT * FROM agents ORDER BY level ASC, created_at ASC`);
			const delRows = await runner.all<{
				agent_id: string;
				project_id: string;
				name: string;
				level: number;
				role_summary: string;
				host: string;
				deleted_at: number;
			}>(`SELECT * FROM deleted_agents_archive ORDER BY deleted_at DESC`);
			const deptRows = await runner.all<IRawDepartmentRow>(`SELECT * FROM departments ORDER BY created_at ASC`);
			const wbRows = await runner.all<IRawWhiteboardRow>(`SELECT * FROM whiteboards ORDER BY created_at ASC`);
			const grantRows = await runner.all<IRawBoardGrantRow>(`SELECT * FROM board_grants ORDER BY board_id ASC, agent_id ASC`);
			const ticketRows = await runner.all<IRawTicketRow>(`SELECT * FROM tickets WHERE status != 'destroyed' ORDER BY updated_at DESC`);
			const edgeRows = await runner.all<{ edge_pair_key: string; latest_at: number }>(
				`SELECT edge_pair_key, MAX(transferred_at) AS latest_at FROM edge_ticket_transfers GROUP BY edge_pair_key`,
			);
			const migRows = await runner.all<{
				scope_id: string;
				epoch: number;
				total_cnt: number;
				done_cnt: number;
				last_err: string | null;
			}>(
				`SELECT scope_id, epoch, COUNT(*) AS total_cnt,
				        SUM(CASE WHEN phase IN ('switched', 'cleaned', 'skipped') THEN 1 ELSE 0 END) AS done_cnt,
				        MAX(last_error) AS last_err
				 FROM storage_migration_items
				 WHERE scope_type = 'whiteboard'
				 GROUP BY scope_id, epoch`,
			);
			const migMap = new Map<string, { total_items: number; completed_items: number; last_error?: string }>();
			for (const mr of migRows) {
				migMap.set(`${mr.scope_id}:${mr.epoch}`, {
					total_items: Number(mr.total_cnt || 0),
					completed_items: Number(mr.done_cnt || 0),
					...(mr.last_err ? { last_error: mr.last_err } : {}),
				});
			}

			const edgeLatest: Record<string, number> = {};
			for (const er of edgeRows) {
				edgeLatest[er.edge_pair_key] = er.latest_at;
			}

			const hosts: IAdeProjectHostEntry[] = hostRows.map(h => ({
				host_id: h.host_id,
				ip: h.ip,
				name: h.name,
				ssh_alias: h.ssh_alias,
				os_kind: h.os_kind,
				...(h.remote_home ? { remote_home: h.remote_home } : {}),
			}));

			const agents: IAdeAgentNode[] = agentRows.map(r => this.mapAgentRow(r));
			const deleted_agents: IAdeDeletedAgentArchive[] = delRows.map(d => ({
				agent_id: d.agent_id,
				project_id: d.project_id,
				name: d.name,
				level: d.level,
				role_summary: d.role_summary,
				host: d.host,
				deleted_at: d.deleted_at,
			}));
			const departments: IAdeDepartment[] = deptRows.map(d => ({
				dept_id: d.dept_id,
				project_id: d.project_id,
				name: d.name,
				root_agent_id: d.root_agent_id,
				parent_dept_id: d.parent_dept_id,
				board_permissions: parseBoardPermsJson(d.board_permissions),
				created_by: d.created_by,
				created_at: d.created_at,
				updated_at: d.updated_at,
			}));
			const whiteboards: IAdeWhiteboard[] = wbRows.map(w => {
				const prog = migMap.get(`${w.board_id}:${w.migration_epoch}`);
				return {
					board_id: w.board_id,
					project_id: w.project_id,
					name: w.name,
					owner_id: w.owner_id,
					dept_id: w.dept_id,
					storage_host: w.storage_host,
					tag_categories: parseJsonArrayStrings(w.tag_categories),
					migration_epoch: w.migration_epoch,
					migration_state: w.migration_state,
					...(prog ? { migration_progress: prog } : {}),
					...(w.canvas_x !== null ? { canvas_x: w.canvas_x } : {}),
					...(w.canvas_y !== null ? { canvas_y: w.canvas_y } : {}),
					created_at: w.created_at,
					updated_at: w.updated_at,
				};
			});
			const board_grants: IAdeBoardGrant[] = grantRows.map(g => ({
				board_id: g.board_id,
				agent_id: g.agent_id,
				permission: g.permission,
				granted_by: g.granted_by,
				updated_at: g.updated_at,
			}));
			const tickets: IAdeTicketSummaryCard[] = ticketRows.map(t => ({
				ticket_id: t.ticket_id,
				creator_id: t.creator_id,
				peer_id: t.peer_id,
				ticket_level: t.ticket_level,
				from_id: t.from_id,
				to_id: t.to_id,
				holder_id: t.holder_id,
				delivery_mode: t.delivery_mode,
				need_return: t.need_return === 1,
				current_task_id: t.current_task_id,
				current_task_type: t.current_task_type,
				current_task_title: t.current_task_title,
				current_task_summary: t.current_task_summary,
				current_has_detail_ref: t.current_has_detail_ref === 1,
				has_history_ref: t.has_history_ref === 1,
				status: t.status,
				created_at: t.created_at,
				updated_at: t.updated_at,
			}));

				return {
					meta: metaRow,
					hosts,
					agents,
					deleted_agents,
					departments,
					whiteboards,
					board_grants,
					tickets,
					edge_latest_transfer_at: edgeLatest,
				};
			});
		});
	}

	async listAllBoundSessionResources(): Promise<readonly string[]> {
		if (this.shuttingDown || this._isDisposed) {
			return [];
		}
		return this.trackServiceCall(async () => {
			if (this.shuttingDown || this._isDisposed) {
				return [];
			}
			const projs = await this.sqliteStore.catalog.all<{ project_id: string }>(`SELECT project_id FROM projects_index`).catch(() => []);
			const uris = new Set<string>();
			for (const p of projs) {
				if (this.shuttingDown || this._isDisposed) {
					break;
				}
				if (this.isProjectDeletingOrRemoved(p.project_id)) {
					continue;
				}
				await this.trackProjectOp(p.project_id, async () => {
					if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(p.project_id)) {
						return;
					}
					const pdb = await this.sqliteStore.tryOpenActiveProjectDb(p.project_id);
					if (!pdb) {
						return;
					}
					const rows = await pdb.all<{ agent_id: string; engine: string; session_resource: string | null }>(
						`SELECT agent_id, engine, session_resource FROM agents`,
					).catch(() => []);
					if (this.isProjectDeletingOrRemoved(p.project_id)) {
						return;
					}
					for (const r of rows) {
						uris.add(r.session_resource || this.buildDeterministicSessionResource(r.engine, p.project_id, r.agent_id));
					}
				});
			}
			return [...uris];
		});
	}

	// =========================================================================
	// Probing
	// =========================================================================

	async probeEngines(host: string): Promise<readonly string[]> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.engineProber.probeEngines(host));
	}

	async probeModels(host: string, engine: string): Promise<{ readonly models: readonly string[]; readonly efforts: readonly string[] }> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(async () => {
			const res = await this.engineProber.probeModels(host, engine);
			return { models: res.models, efforts: res.efforts };
		});
	}

	// =========================================================================
	// Human UI Canvas Mutations
	// =========================================================================

	async uiCreateAgent(input: IAdeUiCreateAgentInput): Promise<IAdeAgentNode> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(input.projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(input.projectId);
			const engine = normalizeAdeEngineId(input.engine);
			const cleanName = requireNonEmptyString(input.name, 'name');
			const cleanRole = requireNonEmptyString(input.roleSummary, 'roleSummary');
			const cleanModel = requireNonEmptyString(input.model, 'model');
			const cleanEffort = requireNonEmptyString(input.effort, 'effort').toLowerCase();
			const meta = this.engineProber.getDefaultMetadata(engine);
			if (!this.engineProber.isCompatibleEffort(engine, cleanEffort)) {
				throw new AdeError('ERR_INVALID_ARGS', `引擎 ${engine} 不支持思考程度档位 "${cleanEffort}"（可选: ${meta.efforts.join(', ')}）`);
			}
			const canonicalHost = await this.validateAndCanonicalizeHost(input.host, pdb);
			this.assertNotShuttingDown();
			if (this.isProjectDeletingOrRemoved(input.projectId)) {
				throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${input.projectId}`);
			}
			const level = parseLevelInput(input.level);
			const now = Date.now();

			const created = await pdb.transaction(async tx => {
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(input.projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${input.projectId}`);
				}
				const existingAgents = await tx.all<IRawAgentRow>(`SELECT * FROM agents`);
				const isTop = input.parentId === null;
				if (isTop) {
					if (existingAgents.some(a => a.is_top_role === 1)) {
						throw new AdeError('ERR_FORBIDDEN_HIERARCHY', '每个项目仅允许存在唯一一个顶级 L1 负责人节点');
					}
					if (level !== 1) {
						throw new AdeError('ERR_FORBIDDEN_HIERARCHY', '项目唯一顶级根节点职级必须固定为 L1');
					}
				} else {
					const parent = existingAgents.find(a => a.agent_id === input.parentId);
					if (!parent) {
						throw new AdeError('ERR_AGENT_NOT_FOUND', '指定的直属上级节点不存在');
					}
					if (level <= parent.level) {
						throw new AdeError('ERR_FORBIDDEN_HIERARCHY', `新员工职级 L${level} 必须严格低于上级 L${parent.level}`);
					}
				}

				const agentId = genId(`agent_l${level}`);
				const sessionResource = this.buildDeterministicSessionResource(engine, input.projectId, agentId);
				await tx.run(
					`INSERT INTO agents
					 (agent_id, project_id, level, is_top_role, parent_id, name, role_summary, host, engine, model, effort,
					  session_phase, session_started, excluded_dept_ids, session_resource, last_read_doc_rev, token_gen,
					  canvas_x, canvas_y, color_token, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unstarted', 0, '[]', ?, 0, 1, ?, ?, ?, ?, ?)`,
					[
						agentId, input.projectId, level, isTop ? 1 : 0, input.parentId,
						cleanName, cleanRole, canonicalHost, engine, cleanModel, cleanEffort,
						sessionResource, input.canvasX ?? null, input.canvasY ?? null, input.colorToken ?? null, now, now,
					],
				);

				// If sole L1 is created, automatically adopt any escrowed (owner_id IS NULL) whiteboards!
				if (isTop) {
					await tx.run(
						`UPDATE whiteboards SET owner_id = ?, updated_at = ? WHERE project_id = ? AND owner_id IS NULL`,
						[agentId, now, input.projectId],
					);
				}

				const row = await tx.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [agentId]);
				return this.mapAgentRow(row!);
			});

			await this.syncProjectWorkspaceRoutingRules(input.projectId).catch(err => {
				this.logService?.warn('[AdeControlCenter] Routing rules sync warning', err);
			});
			this.fireDidChangeProject(input.projectId);
			return created;
		}));
	}

	async uiEditAgent(input: IAdeUiEditAgentInput): Promise<IAdeAgentNode> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(input.projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(input.projectId);
			const requestedHost = input.host !== undefined
				? await this.validateAndCanonicalizeHost(requireNonEmptyString(input.host, 'host'), pdb)
				: undefined;
			this.assertNotShuttingDown();
			if (this.isProjectDeletingOrRemoved(input.projectId)) {
				throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${input.projectId}`);
			}

			const preCur = await pdb.withLock(runner => runner.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [input.agentId]));
			if (!preCur) {
				throw new AdeError('ERR_AGENT_NOT_FOUND', '目标员工节点不存在');
			}
			const preNextHost = requestedHost ?? preCur.host;
			const preNextEngine = input.engine !== undefined ? normalizeAdeEngineId(input.engine) : preCur.engine;
			const preHostOrEngineChanged = preNextHost !== preCur.host || preNextEngine !== preCur.engine;
			if (preHostOrEngineChanged && preCur.session_started === 1 && input.allowSessionReset !== true) {
				throw new AdeError(
					'ERR_ENGINE_LOCKED',
					preNextEngine !== preCur.engine
						? '该员工会话已启动并产生上下文，禁止修改引擎'
						: '该员工会话已启动并产生上下文，禁止修改运行主机',
				);
			}

			let probedDefaultModel: string | undefined;
			let probedEfforts: readonly string[] | undefined;
			let probedDefaultEffort: string | undefined;
			if (preHostOrEngineChanged && (input.model === undefined || input.model.trim() === '')) {
				const fallbackMeta = this.engineProber.getDefaultMetadata(preNextEngine);
				const probed = await this.engineProber.probeModels(preNextHost, preNextEngine).catch(() => fallbackMeta);
				probedDefaultModel = probed.models[0] ?? fallbackMeta.models[0];
				probedEfforts = probed.efforts.length > 0 ? probed.efforts : fallbackMeta.efforts;
				probedDefaultEffort = probed.defaultEffort || fallbackMeta.defaultEffort;
			}
			const oldSshAlias = (preHostOrEngineChanged && preCur.session_started === 1 && input.allowSessionReset === true && preCur.host !== 'local')
				? await this.tryLookupHostAlias(preCur.host)
				: undefined;
			this.assertNotShuttingDown();
			if (this.isProjectDeletingOrRemoved(input.projectId)) {
				throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${input.projectId}`);
			}

			let hostOrEngineChangedOuter = false;
			let disposedRuntimeOuter: IAdeAgentRuntimeDisposeEvent | undefined;

			const updated = await pdb.transaction(async tx => {
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(input.projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${input.projectId}`);
				}
				const cur = await tx.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [input.agentId]);
				if (!cur) {
					throw new AdeError('ERR_AGENT_NOT_FOUND', '目标员工节点不存在');
				}
				const nextHost = requestedHost ?? cur.host;
				const nextEngine = input.engine !== undefined ? normalizeAdeEngineId(input.engine) : cur.engine;
				const hostChanged = nextHost !== cur.host;
				const engineChanged = nextEngine !== cur.engine;
				const hostOrEngineChanged = hostChanged || engineChanged;

				if (hostOrEngineChanged && cur.session_started === 1 && input.allowSessionReset !== true) {
					throw new AdeError(
						'ERR_ENGINE_LOCKED',
						engineChanged
							? '该员工会话已启动并产生上下文，禁止修改引擎'
							: '该员工会话已启动并产生上下文，禁止修改运行主机',
					);
				}

				const finalMeta = this.engineProber.getDefaultMetadata(nextEngine);
				let nextModel: string;
				if (input.model !== undefined && (!hostOrEngineChanged || input.model.trim() !== '')) {
					nextModel = requireNonEmptyString(input.model, 'model');
				} else if (hostOrEngineChanged) {
					nextModel = (nextEngine === preNextEngine && nextHost === preNextHost && probedDefaultModel)
						? probedDefaultModel
						: finalMeta.models[0];
				} else {
					nextModel = cur.model;
				}

				const supportedEfforts = (nextEngine === preNextEngine && nextHost === preNextHost && probedEfforts)
					? probedEfforts
					: finalMeta.efforts;
				const targetDefaultEffort = (nextEngine === preNextEngine && nextHost === preNextHost && probedDefaultEffort)
					? probedDefaultEffort
					: finalMeta.defaultEffort;
				let nextEffort: string;
				if (input.effort !== undefined && (!hostOrEngineChanged || input.effort.trim() !== '')) {
					nextEffort = requireNonEmptyString(input.effort, 'effort').toLowerCase();
				} else if (hostOrEngineChanged) {
					const curEffortLower = cur.effort.toLowerCase();
					nextEffort = supportedEfforts.includes(curEffortLower)
						? curEffortLower
						: targetDefaultEffort;
				} else {
					nextEffort = cur.effort.toLowerCase();
				}

				if (!this.engineProber.isCompatibleEffort(nextEngine, nextEffort)) {
					throw new AdeError('ERR_INVALID_ARGS', `引擎 ${nextEngine} 不支持思考程度档位 "${nextEffort}"（可选: ${finalMeta.efforts.join(', ')}）`);
				}

				const nextName = input.name !== undefined ? requireNonEmptyString(input.name, 'name') : cur.name;
				const nextRole = input.roleSummary !== undefined ? requireNonEmptyString(input.roleSummary, 'roleSummary') : cur.role_summary;
				const nextColor = input.colorToken !== undefined ? (input.colorToken || null) : cur.color_token;

				// If an active session is being reset on host/engine switch, invoke runtime teardown hook
				// for the previous runtime slot right before atomically committing the reset row.
				if (hostOrEngineChanged && cur.session_started === 1 && input.allowSessionReset === true) {
					const resolvedOldAlias = cur.host === preCur.host ? oldSshAlias : undefined;
					disposedRuntimeOuter = {
						projectId: input.projectId,
						agentId: cur.agent_id,
						host: cur.host,
						...(resolvedOldAlias ? { sshAlias: resolvedOldAlias } : {}),
						engine: cur.engine,
						sessionResource: cur.session_resource ?? this.buildDeterministicSessionResource(cur.engine, input.projectId, cur.agent_id),
					};
				}

				hostOrEngineChangedOuter = hostOrEngineChanged;
				const now = Date.now();
				if (hostOrEngineChanged && cur.session_started === 1 && input.allowSessionReset === true) {
					await tx.run(
						`UPDATE agents
						 SET name = ?, role_summary = ?, host = ?, engine = ?, model = ?, effort = ?, color_token = ?,
						     session_phase = 'unstarted', session_started = 0, native_session_id = NULL, session_resource = NULL,
						     token_gen = ?, updated_at = ?
						 WHERE agent_id = ?`,
						[nextName, nextRole, nextHost, nextEngine, nextModel, nextEffort, nextColor, cur.token_gen + 1, now, input.agentId],
					);
					await tx.run(
						`UPDATE ticket_delivery_outbox
						 SET state = 'pending', claimed_by_window_id = NULL, leased_until = NULL, next_retry_at = 0, last_error = NULL
						 WHERE target_agent_id = ? AND state IN ('blocked_cli', 'in_flight')`,
						[input.agentId],
					);
				} else {
					const nextSessionRes = engineChanged
						? this.buildDeterministicSessionResource(nextEngine, input.projectId, cur.agent_id)
						: cur.session_resource;
					const nextTokenGen = hostOrEngineChanged ? cur.token_gen + 1 : cur.token_gen;
					await tx.run(
						`UPDATE agents
						 SET name = ?, role_summary = ?, host = ?, engine = ?, model = ?, effort = ?, color_token = ?,
						     session_resource = ?, token_gen = ?, updated_at = ?
						 WHERE agent_id = ?`,
						[nextName, nextRole, nextHost, nextEngine, nextModel, nextEffort, nextColor, nextSessionRes, nextTokenGen, now, input.agentId],
					);
					if (hostOrEngineChanged) {
						await tx.run(
							`UPDATE ticket_delivery_outbox
							 SET state = 'pending', claimed_by_window_id = NULL, leased_until = NULL, next_retry_at = 0, last_error = NULL
							 WHERE target_agent_id = ? AND state = 'blocked_cli'`,
							[input.agentId],
						);
					}
				}
				return this.mapAgentRow((await tx.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [input.agentId]))!);
			});

			if (hostOrEngineChangedOuter) {
				this.controlServer.revokeAgentTokens(input.projectId, input.agentId);
			}
			if (disposedRuntimeOuter) {
				this.fireDidDisposeAgentRuntime(disposedRuntimeOuter);
			}
			await this.syncProjectWorkspaceRoutingRules(input.projectId).catch(() => undefined);
			this.fireDidChangeProject(input.projectId);
			if (hostOrEngineChangedOuter) {
				this.fireDidEnqueueOutbox({ projectId: input.projectId, targetAgentId: input.agentId });
			}
			return updated;
		}));
	}

	async uiMoveAgent(projectId: string, agentId: string, newParentId: string): Promise<IAdeAgentNode> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(projectId);
			let cancelledTickets: string[] = [];
			const moved = await pdb.transaction(async tx => {
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
				}
				const state = await this.loadPolicyStateInTx(tx, projectId);
				const topAgent = Object.values(state.agents).find(a => a.is_top_role);
			if (!topAgent) {
					throw new AdeError('ERR_AGENT_NOT_FOUND', '当前项目不存在根节点');
				}
				applyAgentMove(state, topAgent.agent_id, agentId, newParentId);
				reconcileTopologySideEffects(state);
				cancelledTickets = freezeInvalidatedActiveTickets(state);
				await this.persistPolicySideEffectsInTx(tx, state, cancelledTickets);
				return this.mapAgentRow((await tx.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [agentId]))!);
			});
			if (cancelledTickets.length > 0) {
				this.fireDidCancelOutboxTickets({ projectId, ticketIds: cancelledTickets });
			}
			this.fireDidChangeProject(projectId);
			return moved;
		}));
	}

	async uiDeleteAgent(projectId: string, agentId: string): Promise<{ readonly frozenTicketIds: readonly string[] }> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(projectId);
			let frozenTicketIds: string[] = [];
			let deletedRow: IRawAgentRow | undefined;

			await pdb.transaction(async tx => {
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
				}
				const state = await this.loadPolicyStateInTx(tx, projectId);
				const target = await tx.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [agentId]);
				if (!target) {
					throw new AdeError('ERR_AGENT_NOT_FOUND', '指定的员工节点不存在');
				}
				const hasChildren = Object.values(state.agents).some(a => a.parent_id === agentId);
				if (hasChildren) {
					throw new AdeError('ERR_HAS_SUBORDINATES', '该员工名下仍存在直接下属，请先转移或删除下属后再删除');
				}
				if (Object.values(state.departments).some(d => d.root_agent_id === agentId)) {
					throw new AdeError('ERR_IS_DEPT_ROOT', '该员工是活跃部门根节点，请先解散对应部门');
				}
				deletedRow = target;
				transferAgentWhiteboardsOnDelete(state, agentId);
				const now = Date.now();
				await tx.run(
					`INSERT OR REPLACE INTO deleted_agents_archive (agent_id, project_id, name, level, role_summary, host, deleted_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[target.agent_id, projectId, target.name, target.level, target.role_summary, target.host, now],
				);
				delete state.agents[agentId];
				reconcileTopologySideEffects(state);
				frozenTicketIds = freezeInvalidatedActiveTickets(state);
				await this.persistPolicySideEffectsInTx(tx, state, frozenTicketIds);
				await tx.run(`DELETE FROM agents WHERE agent_id = ?`, [agentId]);
			});

			this.controlServer.revokeAgentTokens(projectId, agentId);
			if (deletedRow) {
				const sshAlias = deletedRow.host !== 'local' ? await this.tryLookupHostAlias(deletedRow.host) : undefined;
				this.fireDidDisposeAgentRuntime({
					projectId,
					agentId: deletedRow.agent_id,
					host: deletedRow.host,
					sshAlias,
					engine: deletedRow.engine,
					sessionResource: deletedRow.session_resource ?? this.buildDeterministicSessionResource(deletedRow.engine, projectId, deletedRow.agent_id),
				});
			}
			if (frozenTicketIds.length > 0) {
				this.fireDidCancelOutboxTickets({ projectId, ticketIds: frozenTicketIds });
			}
			this.fireDidChangeProject(projectId);
			return { frozenTicketIds };
		}));
	}

	async uiUpdateCanvasLayout(projectId: string, patch: IAdeUiCanvasLayoutPatch): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(projectId);
			await pdb.transaction(async tx => {
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
				}
				const now = Date.now();
				if (patch.layoutDirection) {
					await tx.run(`UPDATE project_meta SET layout_direction = ?, updated_at = ? WHERE project_id = ?`, [patch.layoutDirection, now, projectId]);
				}
				if (patch.resetPinnedPositions === true) {
					await tx.run(`UPDATE agents SET canvas_x = NULL, canvas_y = NULL, updated_at = ? WHERE project_id = ?`, [now, projectId]);
					await tx.run(`UPDATE whiteboards SET canvas_x = NULL, canvas_y = NULL, updated_at = ? WHERE project_id = ?`, [now, projectId]);
				}
				if (patch.nodePositions) {
					for (const [id, pos] of Object.entries(patch.nodePositions)) {
						if (id.startsWith('wb:') || id.startsWith('wb_')) {
							const wbId = id.startsWith('wb:') ? id.slice(3) : id;
							await tx.run(`UPDATE whiteboards SET canvas_x = ?, canvas_y = ?, updated_at = ? WHERE board_id = ?`, [pos.x, pos.y, now, wbId]);
						} else {
							if (pos.color !== undefined) {
								await tx.run(`UPDATE agents SET canvas_x = ?, canvas_y = ?, color_token = ?, updated_at = ? WHERE agent_id = ?`, [pos.x, pos.y, pos.color || null, now, id]);
							} else {
								await tx.run(`UPDATE agents SET canvas_x = ?, canvas_y = ?, updated_at = ? WHERE agent_id = ?`, [pos.x, pos.y, now, id]);
							}
						}
					}
				}
			});
			this.fireDidChangeProject(projectId);
		}));
	}

	async uiCreateDepartment(projectId: string, rootAgentId: string, name: string): Promise<IAdeDepartment> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(projectId);
			const cleanName = requireNonEmptyString(name, 'name');
			let frozenTickets: string[] = [];
			const created = await pdb.transaction(async tx => {
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
				}
				const state = await this.loadPolicyStateInTx(tx, projectId);
				const top = Object.values(state.agents).find(a => a.is_top_role);
				if (!top) {
					throw new AdeError('ERR_AGENT_NOT_FOUND', '请先创建顶层 L1 负责人节点');
				}
				assertCanCreateDepartment(state, top.agent_id, rootAgentId);
				const deptId = genId('dept');
				const now = Date.now();
				state.departments[deptId] = {
					dept_id: deptId,
					project_id: projectId,
					name: cleanName,
					root_agent_id: rootAgentId,
					parent_dept_id: null,
					board_permissions: {},
					created_by: top.agent_id,
				};
				recomputeAllParentDeptIds(state);
				await tx.run(
					`INSERT INTO departments (dept_id, project_id, name, root_agent_id, parent_dept_id, board_permissions, created_by, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
					[deptId, projectId, cleanName, rootAgentId, state.departments[deptId].parent_dept_id, top.agent_id, now, now],
				);
				reconcileTopologySideEffects(state);
				frozenTickets = freezeInvalidatedActiveTickets(state);
				await this.persistPolicySideEffectsInTx(tx, state, frozenTickets);
				return {
					dept_id: deptId,
					project_id: projectId,
					name: cleanName,
					root_agent_id: rootAgentId,
					parent_dept_id: state.departments[deptId].parent_dept_id,
					board_permissions: {},
					created_by: top.agent_id,
					created_at: now,
					updated_at: now,
				} satisfies IAdeDepartment;
			});
			if (frozenTickets.length > 0) {
				this.fireDidCancelOutboxTickets({ projectId, ticketIds: frozenTickets });
			}
			this.fireDidChangeProject(projectId);
			return created;
		}));
	}

	async uiEditDepartment(projectId: string, deptId: string, patch: {
		readonly name?: string;
		readonly boardId?: string;
		readonly perm?: AdeBoardPermission;
	}): Promise<IAdeDepartment> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(projectId);
			const edited = await pdb.transaction(async tx => {
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
				}
				const row = await tx.get<IRawDepartmentRow>(`SELECT * FROM departments WHERE dept_id = ?`, [deptId]);
				if (!row) {
					throw new AdeError('ERR_INVALID_ARGS', '指定的部门不存在');
				}
				const perms = parseBoardPermsJson(row.board_permissions);
				if (patch.boardId) {
					const wb = await tx.get<IRawWhiteboardRow>(`SELECT * FROM whiteboards WHERE board_id = ?`, [patch.boardId]);
					if (!wb || wb.dept_id !== deptId) {
						throw new AdeError('ERR_BOARD_NOT_IN_DEPT', '目标白板尚未划分进该部门');
					}
					if (patch.perm) {
						perms[patch.boardId] = patch.perm;
					}
				}
				const nextName = patch.name !== undefined ? requireNonEmptyString(patch.name, 'name') : row.name;
				const now = Date.now();
				await tx.run(
					`UPDATE departments SET name = ?, board_permissions = ?, updated_at = ? WHERE dept_id = ?`,
					[nextName, JSON.stringify(perms), now, deptId],
				);
				return {
					dept_id: row.dept_id,
					project_id: row.project_id,
					name: nextName,
					root_agent_id: row.root_agent_id,
					parent_dept_id: row.parent_dept_id,
					board_permissions: perms,
					created_by: row.created_by,
					created_at: row.created_at,
					updated_at: now,
				} satisfies IAdeDepartment;
			});
			this.fireDidChangeProject(projectId);
			return edited;
		}));
	}

	async uiDeleteDepartment(projectId: string, deptId: string): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(projectId);
			let frozenTickets: string[] = [];
			await pdb.transaction(async tx => {
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
				}
				const state = await this.loadPolicyStateInTx(tx, projectId);
				if (!state.departments[deptId]) {
					return;
				}
				for (const wb of Object.values(state.whiteboards)) {
					if (wb.dept_id === deptId) {
						wb.dept_id = null;
					}
				}
				delete state.departments[deptId];
				for (const ag of Object.values(state.agents)) {
					ag.excluded_dept_ids = ag.excluded_dept_ids.filter(id => id !== deptId);
				}
				await tx.run(`UPDATE whiteboards SET dept_id = NULL, updated_at = ? WHERE dept_id = ?`, [Date.now(), deptId]);
				await tx.run(`DELETE FROM departments WHERE dept_id = ?`, [deptId]);
				recomputeAllParentDeptIds(state);
				reconcileTopologySideEffects(state);
				frozenTickets = freezeInvalidatedActiveTickets(state);
				await this.persistPolicySideEffectsInTx(tx, state, frozenTickets);
			});
			if (frozenTickets.length > 0) {
				this.fireDidCancelOutboxTickets({ projectId, ticketIds: frozenTickets });
			}
			this.fireDidChangeProject(projectId);
		}));
	}

	async uiSetDepartmentMember(projectId: string, deptId: string, agentId: string, action: 'in' | 'out'): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(projectId);
			let frozenTickets: string[] = [];
			await pdb.transaction(async tx => {
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
				}
				const state = await this.loadPolicyStateInTx(tx, projectId);
				const top = Object.values(state.agents).find(a => a.is_top_role);
				if (!top) {
					throw new AdeError('ERR_AGENT_NOT_FOUND', '缺少顶层节点');
				}
				applyDeptMemberAction(state, top.agent_id, deptId, agentId, action);
				reconcileTopologySideEffects(state);
				frozenTickets = freezeInvalidatedActiveTickets(state);
				await this.persistPolicySideEffectsInTx(tx, state, frozenTickets);
			});
			if (frozenTickets.length > 0) {
				this.fireDidCancelOutboxTickets({ projectId, ticketIds: frozenTickets });
			}
			this.fireDidChangeProject(projectId);
		}));
	}

	async uiConfigureProjectTicketStorage(projectId: string, targetHost: string): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(projectId);
			const canonicalTargetHost = await this.validateAndCanonicalizeHost(targetHost, pdb);
			this.assertNotShuttingDown();
			if (this.isProjectDeletingOrRemoved(projectId)) {
				throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
			}
			let nextEpoch = 0;
			let queuedCount = 0;

			await pdb.transaction(async tx => {
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
				}
				const meta = await tx.get<{ ticket_migration_epoch: number }>(`SELECT ticket_migration_epoch FROM project_meta WHERE project_id = ?`, [projectId]);
				if (!meta) {
					throw new AdeError('ERR_INVALID_ARGS', '指定的项目不存在');
				}
				nextEpoch = meta.ticket_migration_epoch + 1;
				const now = Date.now();
				await tx.run(
					`UPDATE storage_migration_items
					 SET phase = 'skipped', last_error = NULL, updated_at = ?
					 WHERE scope_type = 'ticket' AND scope_id = ? AND epoch < ? AND phase IN ('pending', 'failed')`,
					[now, projectId, nextEpoch],
				);

				// Scan ALL active cross-host Ticket task blobs with storage_host !== canonicalTargetHost (supports multi-hop A -> B(50%) -> C!)
				const candidates = await tx.all<{
					ticket_id: string;
					task_id: string;
					from_id: string;
					to_id: string;
					storage_host: string;
					storage_path: string;
					size_bytes: number;
					sha256: string;
					content_rev: number;
				}>(
					`SELECT tt.ticket_id, tt.task_id, tt.from_id, tt.to_id, tt.storage_host, tt.storage_path, tt.size_bytes, tt.sha256, tt.content_rev
					 FROM ticket_tasks tt
					 JOIN tickets t ON t.ticket_id = tt.ticket_id
					 WHERE t.status != 'destroyed' AND tt.has_detail_ref = 1 AND tt.storage_path IS NOT NULL AND tt.storage_host != ?`,
					[canonicalTargetHost],
				);

				const agentsMap = new Map<string, string>();
				for (const a of await tx.all<{ agent_id: string; host: string }>(`SELECT agent_id, host FROM agents`)) {
					agentsMap.set(a.agent_id, a.host);
				}
				for (const d of await tx.all<{ agent_id: string; host: string }>(`SELECT agent_id, host FROM deleted_agents_archive`)) {
					if (!agentsMap.has(d.agent_id)) {
						agentsMap.set(d.agent_id, d.host);
					}
				}

				for (const c of candidates) {
					const hA = agentsMap.get(c.from_id) ?? 'local';
					const hB = agentsMap.get(c.to_id) ?? 'local';
					// Only cross-host tickets follow cross_host_ticket_storage (local<->local stays local; IP_A<->IP_A stays IP_A)
					if ((hA === 'local' && hB === 'local') || (hA !== 'local' && hA === hB)) {
						continue;
					}
					await tx.run(
						`INSERT OR REPLACE INTO storage_migration_items
						 (migration_item_id, scope_type, scope_id, epoch, entity_table, entity_pk_1, entity_pk_2,
						  expected_rev, expected_sha256, size_bytes, src_host, src_path, dst_host, dst_path, phase, retry_count, updated_at)
						 VALUES (?, 'ticket', ?, ?, 'ticket_tasks', ?, ?, ?, ?, ?, ?, ?, ?, '', 'pending', 0, ?)`,
						[
							genId('mig'), projectId, nextEpoch, c.ticket_id, c.task_id,
							c.content_rev, c.sha256, c.size_bytes, c.storage_host, c.storage_path, canonicalTargetHost, now,
						],
					);
					queuedCount++;
				}

				await tx.run(
					`UPDATE project_meta
					 SET cross_host_ticket_storage = ?, ticket_migration_epoch = ?, ticket_migration_state = ?, updated_at = ?
					 WHERE project_id = ?`,
					[canonicalTargetHost, nextEpoch, queuedCount > 0 ? 'transferring' : 'completed', now, projectId],
				);
			});

			if (this.shuttingDown || this._isDisposed) {
				if (queuedCount > 0) {
					await pdb.run(
						`UPDATE project_meta SET ticket_migration_state = 'failed', updated_at = ? WHERE project_id = ? AND ticket_migration_state = 'transferring'`,
						[Date.now(), projectId],
					).catch(() => undefined);
				}
				throw new AdeError('ERR_UNAUTHORIZED', '控制中心正在关停，拒绝新命令请求');
			}

			this.fireDidChangeProject(projectId);
			if (queuedCount > 0) {
				this.triggerBackgroundCasMigration(projectId, 'ticket', projectId, nextEpoch);
			}
		}));
	}

	async uiCreateWhiteboard(input: {
		readonly projectId: string;
		readonly name: string;
		readonly ownerId?: string | null;
		readonly deptId?: string | null;
		readonly storageHost?: string;
		readonly tags?: readonly string[];
		readonly canvasX?: number;
		readonly canvasY?: number;
	}): Promise<IAdeWhiteboard> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(input.projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(input.projectId);
			const cleanName = requireNonEmptyString(input.name, 'name');
			const tags = parseTagListInput(input.tags);
			const canonicalHost = await this.validateAndCanonicalizeHost(input.storageHost ?? 'local', pdb);
			this.assertNotShuttingDown();
			if (this.isProjectDeletingOrRemoved(input.projectId)) {
				throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${input.projectId}`);
			}
			const now = Date.now();

			const wb = await pdb.transaction(async tx => {
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(input.projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${input.projectId}`);
				}
				const top = await tx.get<IRawAgentRow>(`SELECT * FROM agents WHERE is_top_role = 1`);
				if (!top) {
					throw new AdeError('ERR_AGENT_NOT_FOUND', '请先创建顶层 L1 负责人节点后再创建白板');
				}
				let ownerId = input.ownerId ?? top.agent_id;
				if (input.deptId) {
					const dept = await tx.get<IRawDepartmentRow>(`SELECT * FROM departments WHERE dept_id = ?`, [input.deptId]);
					if (!dept) {
						throw new AdeError('ERR_INVALID_ARGS', '指定的绑定部门不存在');
					}
					const dup = await tx.get<{ board_id: string }>(`SELECT board_id FROM whiteboards WHERE dept_id = ?`, [input.deptId]);
					if (dup) {
						throw new AdeError('ERR_DEPT_BOARD_EXISTS', '该部门已绑定有一块白板（违反部门一板制）');
					}
					ownerId = input.ownerId ?? dept.root_agent_id;
					const boardId = genId('wb');
					await tx.run(
						`INSERT INTO whiteboards
						 (board_id, project_id, name, owner_id, dept_id, storage_host, tag_categories, migration_epoch, migration_state, canvas_x, canvas_y, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'idle', ?, ?, ?, ?)`,
						[boardId, input.projectId, cleanName, ownerId, input.deptId, canonicalHost, JSON.stringify(tags), input.canvasX ?? null, input.canvasY ?? null, now, now],
					);
					const perms = parseBoardPermsJson(dept.board_permissions);
					perms[boardId] = 'read_write';
					await tx.run(`UPDATE departments SET board_permissions = ?, updated_at = ? WHERE dept_id = ?`, [JSON.stringify(perms), now, input.deptId]);
					return {
						board_id: boardId,
						project_id: input.projectId,
						name: cleanName,
						owner_id: ownerId,
						dept_id: input.deptId,
						storage_host: canonicalHost,
						tag_categories: tags,
						migration_epoch: 0,
						migration_state: 'idle' as const,
						...(input.canvasX !== undefined ? { canvas_x: input.canvasX } : {}),
						...(input.canvasY !== undefined ? { canvas_y: input.canvasY } : {}),
						created_at: now,
						updated_at: now,
					} satisfies IAdeWhiteboard;
				}

				const boardId = genId('wb');
				await tx.run(
					`INSERT INTO whiteboards
					 (board_id, project_id, name, owner_id, dept_id, storage_host, tag_categories, migration_epoch, migration_state, canvas_x, canvas_y, created_at, updated_at)
					 VALUES (?, ?, ?, ?, NULL, ?, ?, 0, 'idle', ?, ?, ?, ?)`,
					[boardId, input.projectId, cleanName, ownerId, canonicalHost, JSON.stringify(tags), input.canvasX ?? null, input.canvasY ?? null, now, now],
				);
				return {
					board_id: boardId,
					project_id: input.projectId,
					name: cleanName,
					owner_id: ownerId,
					dept_id: null,
					storage_host: canonicalHost,
					tag_categories: tags,
					migration_epoch: 0,
					migration_state: 'idle' as const,
					...(input.canvasX !== undefined ? { canvas_x: input.canvasX } : {}),
					...(input.canvasY !== undefined ? { canvas_y: input.canvasY } : {}),
					created_at: now,
					updated_at: now,
				} satisfies IAdeWhiteboard;
			});

			this.fireDidChangeProject(input.projectId);
			return wb;
		}));
	}

	private async enqueueWhiteboardCasMigrationInTx(
		tx: IAdeSqlRunner,
		projectId: string,
		boardId: string,
		oldEpoch: number,
		canonicalTargetHost: string,
		emptyMigrationState: 'idle' | 'completed',
		staleTombstones: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }>,
		now: number,
	): Promise<{ readonly nextEpoch: number; readonly nextState: AdeMigrationState; readonly triggerEpoch?: number }> {
		const nextEpoch = oldEpoch + 1;
		const oldUnfinished = await tx.all<{ dst_host: string | null; dst_path: string | null }>(
			`SELECT dst_host, dst_path
			 FROM storage_migration_items
			 WHERE scope_type = 'whiteboard' AND scope_id = ? AND epoch < ? AND phase IN ('pending', 'failed') AND dst_path != ''`,
			[boardId, nextEpoch],
		);
		for (const m of oldUnfinished) {
			if (m.dst_path) {
				staleTombstones.push({
					projectId,
					storageHost: (m.dst_host || 'local').trim() || 'local',
					storagePath: m.dst_path,
				});
			}
		}
		await tx.run(
			`UPDATE storage_migration_items
			 SET phase = 'skipped', last_error = NULL, updated_at = ?
			 WHERE scope_type = 'whiteboard' AND scope_id = ? AND epoch < ? AND phase IN ('pending', 'failed')`,
			[now, boardId, nextEpoch],
		);

		// Multi-hop full scan: select EVERY active CAS item & note whose storage_host !== canonicalTargetHost
		const itemCandidates = await tx.all<{
			item_id: string;
			item_type: 'msg' | 'file';
			storage_host: string;
			storage_path: string;
			file_size: number | null;
			detail_size: number | null;
			sha256: string;
			content_rev: number;
		}>(
			`SELECT item_id, item_type, storage_host, storage_path, file_size, detail_size, sha256, content_rev
			 FROM whiteboard_items
			 WHERE board_id = ? AND storage_path IS NOT NULL AND storage_host != ?`,
			[boardId, canonicalTargetHost],
		);
		const noteCandidates = await tx.all<{
			note_id: string;
			storage_host: string;
			storage_path: string;
			size_bytes: number | null;
			sha256: string;
			content_rev: number;
		}>(
			`SELECT note_id, storage_host, storage_path, size_bytes, sha256, content_rev
			 FROM whiteboard_notes
			 WHERE board_id = ? AND has_detail = 1 AND storage_path IS NOT NULL AND storage_host != ?`,
			[boardId, canonicalTargetHost],
		);

		let queued = 0;
		for (const it of itemCandidates) {
			const itemSizeBytes = it.item_type === 'file'
				? Number(it.file_size ?? 0)
				: Number(it.detail_size ?? 0);
			await tx.run(
				`INSERT OR REPLACE INTO storage_migration_items
				 (migration_item_id, scope_type, scope_id, epoch, entity_table, entity_pk_1, entity_pk_2,
				  expected_rev, expected_sha256, size_bytes, src_host, src_path, dst_host, dst_path, phase, retry_count, updated_at)
				 VALUES (?, 'whiteboard', ?, ?, 'whiteboard_items', ?, '', ?, ?, ?, ?, ?, ?, '', 'pending', 0, ?)`,
				[
					genId('mig'), boardId, nextEpoch, it.item_id,
					it.content_rev, it.sha256 ?? '', itemSizeBytes,
					it.storage_host, it.storage_path, canonicalTargetHost, now,
				],
			);
			queued++;
		}
		for (const nt of noteCandidates) {
			await tx.run(
				`INSERT OR REPLACE INTO storage_migration_items
				 (migration_item_id, scope_type, scope_id, epoch, entity_table, entity_pk_1, entity_pk_2,
				  expected_rev, expected_sha256, size_bytes, src_host, src_path, dst_host, dst_path, phase, retry_count, updated_at)
				 VALUES (?, 'whiteboard', ?, ?, 'whiteboard_notes', ?, '', ?, ?, ?, ?, ?, ?, '', 'pending', 0, ?)`,
				[
					genId('mig'), boardId, nextEpoch, nt.note_id,
					nt.content_rev, nt.sha256 ?? '', Number(nt.size_bytes ?? 0),
					nt.storage_host, nt.storage_path, canonicalTargetHost, now,
				],
			);
			queued++;
		}

		const nextState: AdeMigrationState = queued > 0 ? 'transferring' : emptyMigrationState;
		return {
			nextEpoch,
			nextState,
			...(queued > 0 ? { triggerEpoch: nextEpoch } : {}),
		};
	}

	private async skipUnfinishedMigrationItemsForWbItemInTx(
		tx: IAdeSqlRunner,
		projectId: string,
		itemId: string,
		tombstones: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }>,
		now: number,
	): Promise<void> {
		const unfinishedWithDst = await tx.all<{ dst_host: string | null; dst_path: string | null }>(
			`SELECT dst_host, dst_path
			 FROM storage_migration_items
			 WHERE entity_table = 'whiteboard_items' AND entity_pk_1 = ? AND phase IN ('pending', 'failed') AND dst_path != ''`,
			[itemId],
		);
		for (const m of unfinishedWithDst) {
			if (m.dst_path) {
				tombstones.push({
					projectId,
					storageHost: (m.dst_host || 'local').trim() || 'local',
					storagePath: m.dst_path,
				});
			}
		}
		await tx.run(
			`UPDATE storage_migration_items
			 SET phase = 'skipped', last_error = NULL, updated_at = ?
			 WHERE entity_table = 'whiteboard_items' AND entity_pk_1 = ? AND phase IN ('pending', 'failed')`,
			[now, itemId],
		);
	}

	/**
	 * Human UI Whiteboard Configuration (uiConfigureWhiteboard):
	 * Changing targetStorageHost increments `migration_epoch`, marks prior-epoch unfinished items as `'skipped'`,
	 * and triggers background online CAS migration (`runCasMigrationLoop`) + source replica cleanup of all
	 * existing CAS items/notes with `storage_host !== targetStorageHost` (`plan.md` §6.3 #2; whereas CLI
	 * `ade_wb_config --host` performs a zero-migration instant switch of `storage_host`).
	 */
	async uiConfigureWhiteboard(input: {
		readonly projectId: string;
		readonly boardId: string;
		readonly name?: string;
		readonly targetStorageHost?: string;
		readonly addTags?: readonly string[];
		readonly removeTags?: readonly string[];
		readonly grants?: readonly { readonly agentId: string; readonly perm: AdeBoardPermission | 'none' }[];
	}): Promise<IAdeWhiteboard> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(input.projectId, async () => {
			this.assertNotShuttingDown();
			if (this.isWhiteboardDeleting(input.projectId, input.boardId)) {
				throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的白板不存在或已被删除');
			}
			const pdb = await this.requireProjectDb(input.projectId);
			const canonicalTargetHost = input.targetStorageHost !== undefined
				? await this.validateAndCanonicalizeHost(input.targetStorageHost, pdb)
				: undefined;
			this.assertNotShuttingDown();
			if (this.isProjectDeletingOrRemoved(input.projectId)) {
				throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${input.projectId}`);
			}
			if (this.isWhiteboardDeleting(input.projectId, input.boardId)) {
				throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的白板不存在或已被删除');
			}

			let triggerEpoch: number | undefined;
			const staleTombstones: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> = [];

			await pdb.transaction(async tx => {
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(input.projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${input.projectId}`);
				}
				if (this.isWhiteboardDeleting(input.projectId, input.boardId)) {
					throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的白板不存在或已被删除');
				}
				const wb = await tx.get<IRawWhiteboardRow>(`SELECT * FROM whiteboards WHERE board_id = ?`, [input.boardId]);
				if (!wb) {
					throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的白板不存在');
				}
				const now = Date.now();
				const nextName = input.name !== undefined ? requireNonEmptyString(input.name, 'name') : wb.name;
				let tags = parseJsonArrayStrings(wb.tag_categories);
				if (input.addTags?.length) {
					tags = Array.from(new Set([...tags, ...parseTagListInput(input.addTags)]));
				}
				if (input.removeTags?.length) {
					const rem = new Set(parseTagListInput(input.removeTags));
					tags = tags.filter(t => !rem.has(t));
					await this.stripRemovedTagsFromBoardItemsInTx(tx, input.boardId, rem);
				}

				if (input.grants?.length) {
					for (const g of input.grants) {
						if (g.perm === 'none') {
							await tx.run(`DELETE FROM board_grants WHERE board_id = ? AND agent_id = ?`, [input.boardId, g.agentId]);
						} else {
							await tx.run(
								`INSERT OR REPLACE INTO board_grants (board_id, agent_id, permission, granted_by, updated_at)
								 VALUES (?, ?, ?, ?, ?)`,
								[input.boardId, g.agentId, g.perm, wb.owner_id ?? 'human_ui', now],
							);
						}
					}
				}

				let nextHost = wb.storage_host;
				let nextEpoch = wb.migration_epoch;
				let nextState: AdeMigrationState = wb.migration_state;

				if (canonicalTargetHost !== undefined) {
					nextHost = canonicalTargetHost;
					const migPlan = await this.enqueueWhiteboardCasMigrationInTx(
						tx,
						input.projectId,
						input.boardId,
						wb.migration_epoch,
						canonicalTargetHost,
						'completed',
						staleTombstones,
						now,
					);
					nextEpoch = migPlan.nextEpoch;
					nextState = migPlan.nextState;
					triggerEpoch = migPlan.triggerEpoch;
				}

				await tx.run(
					`UPDATE whiteboards
					 SET name = ?, storage_host = ?, tag_categories = ?, migration_epoch = ?, migration_state = ?, updated_at = ?
					 WHERE board_id = ?`,
					[nextName, nextHost, JSON.stringify(tags), nextEpoch, nextState, now, input.boardId],
				);
			});

			if (staleTombstones.length > 0) {
				await this.storageEngine.enqueueTombstones(staleTombstones).catch(() => undefined);
			}

			if (this.shuttingDown || this._isDisposed) {
				if (triggerEpoch !== undefined) {
					await pdb.run(
						`UPDATE whiteboards SET migration_state = 'failed', updated_at = ? WHERE board_id = ? AND migration_state = 'transferring'`,
						[Date.now(), input.boardId],
					).catch(() => undefined);
				}
				throw new AdeError('ERR_UNAUTHORIZED', '控制中心正在关停，拒绝新命令请求');
			}

			this.fireDidChangeProject(input.projectId);
			if (triggerEpoch !== undefined) {
				this.triggerBackgroundCasMigration(input.projectId, 'whiteboard', input.boardId, triggerEpoch);
			}
			const snap = await this.getProjectSnapshotInternal(input.projectId);
			const found = snap?.whiteboards.find(w => w.board_id === input.boardId);
			if (!found) {
				throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的白板不存在或已被删除');
			}
			return found;
		}));
	}

	private async drainWhiteboardMigrationsForDelete(projectId: string, boardId: string): Promise<void> {
		const migPrefix = `${projectId}:whiteboard:${boardId}:`;
		while (true) {
			const pendingMigs: Promise<void>[] = [];
			for (const [key, p] of this.activeMigrations.entries()) {
				if (key.startsWith(migPrefix)) {
					pendingMigs.push(p);
				}
			}
			if (pendingMigs.length === 0) {
				break;
			}
			await Promise.allSettled(pendingMigs);
		}
	}

	async uiDeleteWhiteboard(projectId: string, boardId: string): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(projectId);
			const exists = await pdb.get<{ board_id: string }>(`SELECT board_id FROM whiteboards WHERE board_id = ?`, [boardId]);
			if (!exists) {
				throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
			}
			const delKey = this.makeBoardDeleteKey(projectId, boardId);
			this.deletingWhiteboards.add(delKey);
			try {
				await this.drainWhiteboardMigrationsForDelete(projectId, boardId);
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
				}
				const tombstones: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> = [];
				await pdb.transaction(async tx => {
					this.assertNotShuttingDown();
					await this.collectAndDeleteWhiteboardInTx(tx, projectId, boardId, tombstones);
				});
				await this.storageEngine.enqueueTombstones(tombstones);
				this.fireDidChangeProject(projectId);
			} finally {
				this.deletingWhiteboards.delete(delKey);
			}
		}));
	}

	async uiManageWhiteboardItem(input: {
		readonly projectId: string;
		readonly boardId: string;
		readonly itemId: string;
		readonly pin?: boolean;
		readonly stars?: 1 | 2 | 3 | 4 | 5;
		readonly tags?: readonly string[];
		readonly deleteItem?: boolean;
	}): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(input.projectId, async () => {
			this.assertNotShuttingDown();
			if (this.isWhiteboardDeleting(input.projectId, input.boardId)) {
				throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的白板不存在');
			}
			const pdb = await this.requireProjectDb(input.projectId);
			const tombstones: Array<{ projectId: string; storageHost: string; storagePath: string }> = [];
			await pdb.transaction(async tx => {
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(input.projectId) || this.isWhiteboardDeleting(input.projectId, input.boardId)) {
					throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的白板不存在');
				}
				const wb = await tx.get<IRawWhiteboardRow>(`SELECT * FROM whiteboards WHERE board_id = ?`, [input.boardId]);
				if (!wb) {
					throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的白板不存在');
				}
				const item = await tx.get<{
					item_id: string;
					stars: number;
					tags: string;
					is_pinned: number;
					storage_host: string | null;
					storage_path: string | null;
				}>(`SELECT item_id, stars, tags, is_pinned, storage_host, storage_path FROM whiteboard_items WHERE board_id = ? AND item_id = ?`, [input.boardId, input.itemId]);
				if (!item) {
					throw new AdeError('ERR_INVALID_ARGS', '指定的白板条目不存在');
				}
				if (input.deleteItem) {
					if (item.storage_path) {
						tombstones.push({ projectId: input.projectId, storageHost: item.storage_host || 'local', storagePath: item.storage_path });
					}
					await this.skipUnfinishedMigrationItemsForWbItemInTx(tx, input.projectId, input.itemId, tombstones, Date.now());
					await tx.run(`DELETE FROM whiteboard_items WHERE item_id = ?`, [input.itemId]);
					return;
				}
				const allowedTags = new Set(parseJsonArrayStrings(wb.tag_categories));
				let nextTags = parseJsonArrayStrings(item.tags);
				if (input.tags !== undefined) {
					nextTags = parseTagListInput(input.tags);
					for (const t of nextTags) {
						if (!allowedTags.has(t)) {
							throw new AdeError('ERR_INVALID_TAG', `标签 "${t}" 不在当前白板允许的标签类别池中`);
						}
					}
				}
				const nextPin = input.pin !== undefined ? (input.pin ? 1 : 0) : item.is_pinned;
				const nextStars = input.stars !== undefined ? parseStarsValue(input.stars) : item.stars;
				// Strictly preserves content_rev so in-flight CAS migration is uninterrupted!
				await tx.run(
					`UPDATE whiteboard_items SET is_pinned = ?, stars = ?, tags = ?, updated_at = ? WHERE item_id = ?`,
					[nextPin, nextStars, JSON.stringify(nextTags), Date.now(), input.itemId],
				);
			});
			if (tombstones.length > 0) {
				await this.storageEngine.enqueueTombstones(tombstones);
			}
			this.fireDidChangeProject(input.projectId);
		}));
	}

	async uiInspectWhiteboard(projectId: string, boardId: string, filter?: IAdeWbItemsFilter): Promise<IAdeUiWhiteboardInspection> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			if (this.isWhiteboardDeleting(projectId, boardId)) {
				throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的白板不存在');
			}
			const snap = await this.getProjectSnapshotInternal(projectId);
			const board = snap?.whiteboards.find(w => w.board_id === boardId);
			if (!snap || !board) {
				throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的白板不存在');
			}
			const pdb = await this.requireProjectDb(projectId);
			return pdb.withLock(async runner => {
				const state = await this.loadPolicyStateInTx(runner, projectId);
				const members = this.computeBoardMembersList(state, snap.agents, boardId);
				const items = await this.queryBoardItemsFiltered(runner, boardId, filter ?? {});
				const noteRows = await runner.all<{
					note_id: string;
					from_id: string;
					to_id: string;
					content_preview: string;
					has_detail: number;
					is_read: number;
					created_at: number;
				}>(`SELECT note_id, from_id, to_id, content_preview, has_detail, is_read, created_at FROM whiteboard_notes WHERE board_id = ? ORDER BY created_at DESC`, [boardId]);
				const notes = noteRows.map(n => ({
					...projectBoardNoteUnreadItem({
						note_id: n.note_id,
						from_id: n.from_id,
						content_preview: n.content_preview,
						has_detail: n.has_detail === 1,
						created_at: n.created_at,
					}),
					to_id: n.to_id,
					is_read: n.is_read === 1,
				}));
				return { board, members, items, notes };
			});
		}));
	}

	async uiReadWhiteboardItemDetail(projectId: string, boardId: string, itemId: string): Promise<string> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			const pdb = await this.requireProjectDb(projectId);
			let ptr!: { storage_host: string; storage_path: string; size_bytes: number; sha256: string };
			let unpin!: () => void;
			await pdb.withLock(async runner => {
				const row = await runner.get<{
					item_type: 'msg' | 'file';
					has_detail: number;
					detail_size: number | null;
					storage_host: string | null;
					storage_path: string | null;
					sha256: string | null;
				}>(`SELECT item_type, has_detail, detail_size, storage_host, storage_path, sha256 FROM whiteboard_items WHERE board_id = ? AND item_id = ?`, [boardId, itemId]);
				if (!row) {
					throw new AdeError('ERR_INVALID_ARGS', '白板条目不存在');
				}
				if (row.item_type === 'file') {
					throw new AdeError('ERR_FILE_NOT_READABLE', '备份文件不支持直读，请使用下载功能');
				}
				if (row.has_detail !== 1 || !row.storage_path) {
					throw new AdeError('ERR_DETAIL_NOT_FOUND', '该消息条目无附加详细内容');
				}
				const host = row.storage_host || 'local';
				unpin = this.storageEngine.pinBlobForRead(host, row.storage_path);
				ptr = { storage_host: host, storage_path: row.storage_path, size_bytes: Number(row.detail_size ?? 0), sha256: row.sha256 ?? '' };
			});
			try {
				return await this.storageEngine.readTextBlobVerified(ptr);
			} finally {
				unpin();
			}
		}));
	}

	async uiDownloadWhiteboardFile(projectId: string, boardId: string, itemId: string, destPath: string): Promise<string> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			const pdb = await this.requireProjectDb(projectId);
			let ptr!: { storage_host: string; storage_path: string; size_bytes: number; sha256: string; filename: string };
			let unpin!: () => void;
			await pdb.withLock(async runner => {
				const row = await runner.get<{
					item_type: 'msg' | 'file';
					file_filename: string | null;
					file_size: number | null;
					storage_host: string | null;
					storage_path: string | null;
					sha256: string | null;
				}>(`SELECT item_type, file_filename, file_size, storage_host, storage_path, sha256 FROM whiteboard_items WHERE board_id = ? AND item_id = ?`, [boardId, itemId]);
				if (!row || row.item_type !== 'file' || !row.storage_path) {
					throw new AdeError('ERR_INVALID_ARGS', '指定的白板备份文件条目不存在');
				}
				const host = row.storage_host || 'local';
				unpin = this.storageEngine.pinBlobForRead(host, row.storage_path);
				ptr = {
					storage_host: host,
					storage_path: row.storage_path,
					size_bytes: Number(row.file_size ?? 0),
					sha256: row.sha256 ?? '',
					filename: row.file_filename || 'download.bin',
				};
			});
			try {
				return await this.storageEngine.downloadBlobToHost({
					ptr,
					fallbackFilename: ptr.filename,
					callerHost: 'local',
					rawDestPath: destPath,
				});
			} finally {
				unpin();
			}
		}));
	}

	async uiReadWhiteboardNoteDetail(projectId: string, boardId: string, noteId: string): Promise<string> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			const pdb = await this.requireProjectDb(projectId);
			let ptr!: { storage_host: string; storage_path: string; size_bytes: number; sha256: string };
			let unpin!: () => void;
			await pdb.withLock(async runner => {
				const row = await runner.get<{
					has_detail: number;
					storage_host: string | null;
					storage_path: string | null;
					size_bytes: number | null;
					sha256: string | null;
				}>(`SELECT has_detail, storage_host, storage_path, size_bytes, sha256 FROM whiteboard_notes WHERE board_id = ? AND note_id = ?`, [boardId, noteId]);
				if (!row || row.has_detail !== 1 || !row.storage_path) {
					throw new AdeError('ERR_DETAIL_NOT_FOUND', '该留言无超长详述副本');
				}
				const host = row.storage_host || 'local';
				unpin = this.storageEngine.pinBlobForRead(host, row.storage_path);
				ptr = {
					storage_host: host,
					storage_path: row.storage_path,
					size_bytes: Number(row.size_bytes ?? 0),
					sha256: row.sha256 ?? '',
				};
			});
			try {
				return await this.storageEngine.readTextBlobVerified(ptr);
			} finally {
				unpin();
			}
		}));
	}

	// =========================================================================
	// Canvas Edge Hover & Click Inspection (active, archived, frozen_orphan, destroyed)
	// =========================================================================

	async getEdgeLatestTransferTime(projectId: string, edgePairKey: string): Promise<number | null> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			const pdb = await this.requireProjectDb(projectId);
			const row = await pdb.get<{ m: number | null }>(
				`SELECT MAX(transferred_at) AS m FROM edge_ticket_transfers WHERE edge_pair_key = ?`,
				[edgePairKey],
			);
			return row?.m ?? null;
		}));
	}

	async listEdgeTicketTransfers(projectId: string, edgePairKey: string): Promise<readonly IAdeEdgeTransferRecord[]> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			const pdb = await this.requireProjectDb(projectId);
			return pdb.withLock(async runner => {
			const namesMap = await this.loadAgentDisplayNamesInTx(runner);
			const rows = await runner.all<{
				transfer_id: string;
				project_id: string;
				edge_pair_key: string;
				hop_from_id: string;
				hop_to_id: string;
				hop_seq: number;
				total_hops: number;
				origin_from_id: string;
				target_to_id: string;
				ticket_id: string;
				task_id: string;
				action_kind: 'create' | 'edit';
				task_type: string;
				task_title: string;
				summary: string;
				has_detail_ref: number;
				transferred_at: number;
				ticket_status: AdeTicketLifecycleStatus;
			}>(
				`SELECT e.*, t.status AS ticket_status
				 FROM edge_ticket_transfers e
				 JOIN tickets t ON t.ticket_id = e.ticket_id
				 WHERE e.edge_pair_key = ?
				 ORDER BY e.transferred_at DESC, e.hop_seq DESC`,
				[edgePairKey],
			);
			return rows.map(r => ({
				transfer_id: r.transfer_id,
				project_id: r.project_id,
				edge_pair_key: r.edge_pair_key,
				hop_from_id: r.hop_from_id,
				hop_to_id: r.hop_to_id,
				hop_seq: r.hop_seq,
				total_hops: r.total_hops,
				origin_from_id: r.origin_from_id,
				origin_from_name: namesMap.get(r.origin_from_id) ?? r.origin_from_id,
				target_to_id: r.target_to_id,
				target_to_name: namesMap.get(r.target_to_id) ?? r.target_to_id,
				ticket_id: r.ticket_id,
				task_id: r.task_id,
				action_kind: r.action_kind,
				task_type: r.task_type,
				task_title: r.task_title,
				summary: r.summary,
				has_detail_ref: r.has_detail_ref === 1,
				ticket_status: r.ticket_status,
					transferred_at: r.transferred_at,
				}));
			});
		}));
	}

	async inspectTicketFullDetailForUi(projectId: string, ticketId: string): Promise<IAdeUiTicketFullInspection | undefined> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			const pdb = await this.requireProjectDb(projectId);
			return pdb.withLock(async runner => {
			const tk = await runner.get<IRawTicketRow>(`SELECT * FROM tickets WHERE ticket_id = ?`, [ticketId]);
			if (!tk) {
				return undefined;
			}
			const namesMap = await this.loadAgentDisplayNamesInTx(runner);
			const taskRows = await runner.all<{
				task_id: string;
				seq: number;
				is_archived: number;
				from_id: string;
				to_id: string;
				delivery_mode: AdeTicketDeliveryMode;
				need_return: number;
				task_type: string;
				task_title: string;
				summary: string;
				has_detail_ref: number;
				detail_truncated: number;
				created_at: number;
			}>(`SELECT task_id, seq, is_archived, from_id, to_id, delivery_mode, need_return, task_type, task_title, summary, has_detail_ref, detail_truncated, created_at FROM ticket_tasks WHERE ticket_id = ? ORDER BY seq ASC`, [ticketId]);

			const all_tasks: IAdeUiTicketTaskRecord[] = taskRows.map(tr => ({
				task_id: tr.task_id,
				seq: tr.seq,
				is_archived: tr.is_archived === 1,
				from_id: tr.from_id,
				from_name: namesMap.get(tr.from_id) ?? tr.from_id,
				to_id: tr.to_id,
				to_name: namesMap.get(tr.to_id) ?? tr.to_id,
				delivery_mode: tr.delivery_mode,
				need_return: tr.need_return === 1,
				task_type: tr.task_type,
				task_title: tr.task_title,
				summary: tr.summary,
				has_detail_ref: tr.has_detail_ref === 1,
				detail_truncated: tr.detail_truncated === 1,
				created_at: tr.created_at,
			}));

			return {
				public_ticket: projectTicketPublicView({
					...tk,
					need_return: tk.need_return === 1,
					current_has_detail_ref: tk.current_has_detail_ref === 1,
					has_history_ref: tk.has_history_ref === 1,
				}),
				status: tk.status,
				creator_name: namesMap.get(tk.creator_id) ?? tk.creator_id,
				peer_id: tk.peer_id,
				peer_name: namesMap.get(tk.peer_id) ?? tk.peer_id,
				created_at: tk.created_at,
				updated_at: tk.updated_at,
				...(tk.frozen_at !== null ? { frozen_at: tk.frozen_at } : {}),
				...(tk.destroyed_at !== null ? { destroyed_at: tk.destroyed_at } : {}),
					all_tasks,
				};
			});
		}));
	}

	async readTicketTaskDetailForUi(projectId: string, ticketId: string, taskId: string): Promise<string> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			const pdb = await this.requireProjectDb(projectId);
		let livePtr: { storage_host: string; storage_path: string; size_bytes: number; sha256: string } | undefined;
		let gzipBuf: Buffer | undefined;
		let isDestroyedOffline = false;
		let unpin: (() => void) | undefined;

		await pdb.withLock(async runner => {
			const row = await runner.get<{
				has_detail_ref: number;
				storage_host: string | null;
				storage_path: string | null;
				size_bytes: number | null;
				sha256: string | null;
				archived_detail_gzip: Buffer | null;
				status: AdeTicketLifecycleStatus;
			}>(
				`SELECT tt.has_detail_ref, tt.storage_host, tt.storage_path, tt.size_bytes, tt.sha256, tt.archived_detail_gzip, t.status
				 FROM ticket_tasks tt
				 JOIN tickets t ON t.ticket_id = tt.ticket_id
				 WHERE tt.ticket_id = ? AND tt.task_id = ?`,
				[ticketId, taskId],
			);
			if (!row || row.has_detail_ref !== 1) {
				throw new AdeError('ERR_DETAIL_NOT_FOUND', '该棒任务未附带详细描述');
			}
			if (row.archived_detail_gzip && Buffer.isBuffer(row.archived_detail_gzip)) {
				gzipBuf = row.archived_detail_gzip;
				return;
			}
			if (row.storage_path) {
				const host = row.storage_host || 'local';
				unpin = this.storageEngine.pinBlobForRead(host, row.storage_path);
				livePtr = {
					storage_host: host,
					storage_path: row.storage_path,
					size_bytes: Number(row.size_bytes ?? 0),
					sha256: row.sha256 ?? '',
				};
				return;
			}
			if (row.status === 'destroyed') {
				isDestroyedOffline = true;
			}
		});

		if (gzipBuf) {
			const plain = await gunzipAsync(gzipBuf, { maxOutputLength: 16 * 1024 * 1024 });
			return plain.toString('utf8');
		}
		if (livePtr && unpin) {
			try {
				return await this.storageEngine.readTextBlobVerified(livePtr);
			} finally {
				unpin();
			}
		}
			if (isDestroyedOffline) {
				return '[销毁时存储主机离线，原远端物理详述已按规回收]';
			}
			throw new AdeError('ERR_DETAIL_NOT_FOUND', '详述数据不可用');
		}));
	}

	// =========================================================================
	// Agent Runtime Launch Credentials, Session Phase & Outbox Delivery
	// =========================================================================

	async issueAgentLaunchBundle(projectId: string, agentId: string): Promise<IAdeAgentLaunchBundle> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			await this.whenReady();
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(projectId);
			const snap = await pdb.withLock(async runner => {
				const meta = await runner.get<{ folder_uri: string }>(`SELECT folder_uri FROM project_meta WHERE project_id = ?`, [projectId]);
				const ag = await runner.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [agentId]);
				return { meta, ag };
			});
			if (!snap.meta || !snap.ag) {
				throw new AdeError('ERR_AGENT_NOT_FOUND', '目标员工会话不存在');
			}
			const ag = snap.ag;
			const folderUri = URI.parse(snap.meta.folder_uri);
			const folderIsCloud = folderUri.scheme === AEXUS_SSH_SCHEME && Boolean(folderUri.authority);
			const folderCloudHost = folderIsCloud && this.cloudHosts ? await this.cloudHosts.getHost(folderUri.authority) : undefined;
			this.assertNotShuttingDown();
			if (this.isProjectDeletingOrRemoved(projectId)) {
				throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
			}
			const folderHostKey = folderIsCloud ? (folderCloudHost?.hostName ?? folderUri.authority) : 'local';

			let workspaceCwd: string;
			let sshAlias: string | undefined;
			let remoteBridgeFile: string | undefined;
			let remoteControlEndpoint: string | undefined;
			let remoteBinDir: string | undefined;

			if (ag.host === 'local') {
				workspaceCwd = folderUri.scheme === Schemas.file
					? folderUri.fsPath
					: path.join(this.adeHomeDir, 'workspaces', projectId, agentId);
			} else {
				const hostInfo = await this.storageEngine.resolveRemoteHostInfo(ag.host);
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(projectId)) {
					throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
				}
				sshAlias = hostInfo.alias;
				workspaceCwd = ag.host === folderHostKey && folderIsCloud
					? (folderUri.path || hostInfo.remoteHome)
					: this.syspromptSync.buildRemoteIsolatedAgentWorkspaceDir(hostInfo.remoteHome, projectId, agentId);

				const localLoopbackPort = await this.controlServer.ensureHostLoopbackPort(hostInfo.ip);
				this.assertNotShuttingDown();
				const hostHash = crypto.createHash('sha256').update(`${hostInfo.ip}:${process.pid}`, 'utf8').digest('hex').slice(0, 10);
				const cleanRemoteHome = hostInfo.remoteHome.replace(/[\\/]+$/, '');
				const joinRemote = hostInfo.os === 'windows' ? path.win32.join : path.posix.join;
				remoteBinDir = joinRemote(cleanRemoteHome, ADE_REMOTE_STORE_DIR_NAME, '_bin');
				remoteBridgeFile = joinRemote(cleanRemoteHome, ADE_REMOTE_STORE_DIR_NAME, '_run', `bridge-${hostHash}.json`);
				remoteControlEndpoint = `tcp:127.0.0.1:${localLoopbackPort}`;
				await this.syspromptSync.ensureRemoteSyspromptDocs(sshAlias, hostInfo.remoteHome, hostInfo.ip).catch(() => undefined);
			}

			this.assertNotShuttingDown();
			if (this.isProjectDeletingOrRemoved(projectId)) {
				throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
			}
			await this.syncProjectWorkspaceRoutingRules(projectId).catch(() => undefined);
			this.assertNotShuttingDown();
			if (this.isProjectDeletingOrRemoved(projectId)) {
				throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中: ${projectId}`);
			}

			const agentToken = this.controlServer.issueAgentSessionToken({
				projectId,
				agentId: ag.agent_id,
				host: ag.host,
				tokenGen: ag.token_gen,
			});
			const sessionResource = ag.session_resource ?? this.buildDeterministicSessionResource(ag.engine, projectId, ag.agent_id);

			return {
				projectId,
				agentId: ag.agent_id,
				level: ag.level,
				name: ag.name,
				host: ag.host,
				...(sshAlias ? { sshAlias } : {}),
				engine: ag.engine,
				model: ag.model,
				effort: ag.effort,
				workspaceCwd,
				sessionResource,
				...(ag.native_session_id ? { nativeSessionId: ag.native_session_id } : {}),
				agentToken,
				controlSocketPath: this.controlServer.socketPath,
				...(remoteBridgeFile ? { remoteBridgeFile } : {}),
				...(remoteControlEndpoint ? { remoteControlEndpoint } : {}),
				...(remoteBinDir ? { remoteBinDir } : {}),
			};
		}));
	}

	async resolveAgentBySessionResource(sessionResource: string): Promise<{ readonly projectId: string; readonly agent: IAdeAgentNode } | undefined> {
		if (this.shuttingDown || this._isDisposed) {
			return undefined;
		}
		return this.trackServiceCall(async () => {
			if (this.shuttingDown || this._isDisposed) {
				return undefined;
			}
			const target = sessionResource.trim();
			const projs = await this.sqliteStore.catalog.all<{ project_id: string }>(`SELECT project_id FROM projects_index`).catch(() => []);
			for (const p of projs) {
				if (this.shuttingDown || this._isDisposed) {
					return undefined;
				}
				if (this.isProjectDeletingOrRemoved(p.project_id)) {
					continue;
				}
				const matched = await this.trackProjectOp(p.project_id, async () => {
					if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(p.project_id)) {
						return undefined;
					}
					const pdb = await this.sqliteStore.tryOpenActiveProjectDb(p.project_id);
					if (!pdb) {
						return undefined;
					}
					const row = await pdb.get<IRawAgentRow>(
						`SELECT * FROM agents
						 WHERE session_resource = ?
						    OR (session_resource IS NULL AND ('aexus-' || engine || ':/ade-' || ? || '-' || agent_id) = ?)`,
						[target, p.project_id, target],
					).catch(() => undefined);
					if (row && !this.isProjectDeletingOrRemoved(p.project_id)) {
						return { projectId: p.project_id, agent: this.mapAgentRow(row) };
					}
					return undefined;
				});
				if (matched) {
					return matched;
				}
			}
			return undefined;
		});
	}

	async markAgentSessionStarting(projectId: string, agentId: string, sessionResource?: string): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(projectId);
			await pdb.transaction(async tx => {
				const ag = await tx.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [agentId]);
				if (!ag) {
					return;
				}
				const expectedPrefix = `aexus-${ag.engine}:`;
				const canonicalUri = this.buildDeterministicSessionResource(ag.engine, projectId, ag.agent_id);
				let nextSessionRes: string;
				const trimmedInput = sessionResource?.trim();
				if (trimmedInput) {
					nextSessionRes = trimmedInput.startsWith(expectedPrefix) ? trimmedInput : canonicalUri;
				} else {
					nextSessionRes = (ag.session_resource && ag.session_resource.startsWith(expectedPrefix))
						? ag.session_resource
						: canonicalUri;
				}
				await tx.run(
					`UPDATE agents
					 SET session_phase = CASE WHEN session_phase = 'started' THEN 'started' ELSE 'starting' END,
					     session_started = 1,
					     session_resource = ?,
					     updated_at = ?
					 WHERE agent_id = ?`,
					[nextSessionRes, Date.now(), agentId],
				);
			});
			this.fireDidChangeProject(projectId);
		}));
	}

	async markAgentSessionStarted(projectId: string, agentId: string, info: { readonly sessionResource?: string; readonly nativeSessionId?: string }): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.trackProjectOp(projectId, async () => {
			this.assertNotShuttingDown();
			const pdb = await this.requireProjectDb(projectId);
			await pdb.transaction(async tx => {
				const ag = await tx.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [agentId]);
				if (!ag) {
					return;
				}
				const expectedPrefix = `aexus-${ag.engine}:`;
				const canonicalUri = this.buildDeterministicSessionResource(ag.engine, projectId, ag.agent_id);
				const trimmedInput = info.sessionResource?.trim();
				let nextSessionRes: string;
				if (trimmedInput) {
					nextSessionRes = trimmedInput.startsWith(expectedPrefix)
						? trimmedInput
						: ((ag.session_resource && ag.session_resource.startsWith(expectedPrefix)) ? ag.session_resource : canonicalUri);
				} else {
					nextSessionRes = (ag.session_resource && ag.session_resource.startsWith(expectedPrefix))
						? ag.session_resource
						: canonicalUri;
				}
				await tx.run(
					`UPDATE agents
					 SET session_phase = 'started',
					     session_started = 1,
					     session_resource = ?,
					     native_session_id = COALESCE(?, native_session_id),
					     updated_at = ?
					 WHERE agent_id = ?`,
					[nextSessionRes, info.nativeSessionId ?? null, Date.now(), agentId],
				);
			});
			this.fireDidChangeProject(projectId);
		}));
	}

	private async rollbackUnstartedInDb(projectId: string, pdb: AdeSingleSqliteDatabase, agentId: string): Promise<boolean> {
		if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
			return false;
		}
		const rolledBack = await pdb.transaction(async tx => {
			const ag = await tx.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [agentId]);
			if (!ag) {
				return false;
			}
			if (ag.native_session_id !== null && ag.native_session_id.trim() !== '') {
				return false;
			}
			if (ag.session_phase === 'unstarted' && ag.session_started === 0) {
				return false;
			}
			const pendingCnt = await tx.get<{ c: number }>(
				`SELECT COUNT(*) AS c FROM ticket_delivery_outbox WHERE target_agent_id = ? AND state IN ('pending', 'in_flight', 'claimed')`,
				[agentId],
			);
			if ((pendingCnt?.c ?? 0) > 0) {
				return false;
			}
			await tx.run(
				`UPDATE agents SET session_phase = 'unstarted', session_started = 0, token_gen = token_gen + 1, updated_at = ? WHERE agent_id = ?`,
				[Date.now(), agentId],
			);
			return true;
		});
		if (rolledBack) {
			this.controlServer.revokeAgentTokens(projectId, agentId);
			this.fireDidChangeProject(projectId);
		}
		return rolledBack;
	}

	private async rollbackUnstartedIfCliMissingInternal(projectId: string, agentId: string): Promise<boolean> {
		if (this.isProjectDeletingOrRemoved(projectId)) {
			return false;
		}
		return this.trackProjectOp(projectId, async () => {
			if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
				return false;
			}
			const pdb = await this.requireProjectDb(projectId);
			return this.rollbackUnstartedInDb(projectId, pdb, agentId);
		});
	}

	async rollbackUnstartedIfCliMissing(projectId: string, agentId: string): Promise<boolean> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(() => this.rollbackUnstartedIfCliMissingInternal(projectId, agentId));
	}

	async claimPendingDeliveries(windowId: number, limit = 16): Promise<readonly IAdeOutboxDeliveryItem[]> {
		if (this.shuttingDown || this._isDisposed) {
			return [];
		}
		return this.trackServiceCall(async () => {
			if (this.shuttingDown || this._isDisposed) {
				return [];
			}
			const projs = await this.sqliteStore.catalog.all<{ project_id: string }>(`SELECT project_id FROM projects_index`).catch(() => []);
			const claimed: IAdeOutboxDeliveryItem[] = [];
			const now = Date.now();
			const leaseUntil = now + OUTBOX_LEASE_MS;

			for (const p of projs) {
				if (this.shuttingDown || this._isDisposed || claimed.length >= limit) {
					break;
				}
				if (this.isProjectDeletingOrRemoved(p.project_id)) {
					continue;
				}
				const batch = await this.trackProjectOp(p.project_id, async () => {
					if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(p.project_id)) {
						return [];
					}
					const pdb = await this.tryOpenHealedActiveProjectDb(p.project_id);
					if (!pdb) {
						return [];
					}
					return pdb.transaction(async tx => {
						if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(p.project_id)) {
							return [];
						}
						// Reclaim expired leases automatically
						await tx.run(
							`UPDATE ticket_delivery_outbox
							 SET state = 'pending', claimed_by_window_id = NULL, leased_until = NULL
							 WHERE state = 'in_flight' AND leased_until IS NOT NULL AND leased_until <= ?`,
							[now],
						);
						const rows = await tx.all<{
							delivery_id: string;
							ticket_id: string;
							task_id: string;
							target_agent_id: string;
							delivery_mode: AdeTicketDeliveryMode;
							payload_text: string;
							created_at: number;
						}>(
							`SELECT delivery_id, ticket_id, task_id, target_agent_id, delivery_mode, payload_text, created_at
							 FROM ticket_delivery_outbox
							 WHERE state = 'pending' AND next_retry_at <= ?
							 ORDER BY CASE WHEN delivery_mode = 'steer' THEN 0 ELSE 1 END ASC, created_at ASC
							 LIMIT ?`,
							[now, limit - claimed.length],
						);
						for (const r of rows) {
							await tx.run(
								`UPDATE ticket_delivery_outbox
								 SET state = 'in_flight', claimed_by_window_id = ?, leased_until = ?, attempts = attempts + 1
								 WHERE delivery_id = ?`,
								[windowId, leaseUntil, r.delivery_id],
							);
						}
						return rows.map(r => ({
							deliveryId: r.delivery_id,
							projectId: p.project_id,
							ticketId: r.ticket_id,
							taskId: r.task_id,
							targetAgentId: r.target_agent_id,
							deliveryMode: r.delivery_mode,
							payloadText: r.payload_text,
							createdAt: r.created_at,
						} satisfies IAdeOutboxDeliveryItem));
					}).catch(() => []);
				});
				claimed.push(...batch);
			}
			return claimed;
		});
	}

	async ackDeliveryDispatched(deliveryId: string, _windowId: number): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(async () => {
			if (this.shuttingDown || this._isDisposed) {
				return;
			}
			const projs = await this.sqliteStore.catalog.all<{ project_id: string }>(`SELECT project_id FROM projects_index`).catch(() => []);
			for (const p of projs) {
				if (this.shuttingDown || this._isDisposed) {
					return;
				}
				if (this.isProjectDeletingOrRemoved(p.project_id)) {
					continue;
				}
				const deleted = await this.trackProjectOp(p.project_id, async () => {
					if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(p.project_id)) {
						return false;
					}
					const pdb = await this.tryOpenHealedActiveProjectDb(p.project_id);
					if (!pdb) {
						return false;
					}
					const res = await pdb.run(`DELETE FROM ticket_delivery_outbox WHERE delivery_id = ?`, [deliveryId]).catch(() => ({ changes: 0 }));
					return res.changes > 0;
				});
				if (deleted) {
					return;
				}
			}
		});
	}

	async nackDeliveryFailed(deliveryId: string, _windowId: number, error: string, cliMissing?: boolean): Promise<void> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(async () => {
			if (this.shuttingDown || this._isDisposed) {
				return;
			}
			const projs = await this.sqliteStore.catalog.all<{ project_id: string }>(`SELECT project_id FROM projects_index`).catch(() => []);
			for (const p of projs) {
				if (this.shuttingDown || this._isDisposed) {
					return;
				}
				if (this.isProjectDeletingOrRemoved(p.project_id)) {
					continue;
				}
				const handled = await this.trackProjectOp(p.project_id, async () => {
					if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(p.project_id)) {
						return false;
					}
					const pdb = await this.tryOpenHealedActiveProjectDb(p.project_id);
					if (!pdb) {
						return false;
					}
					const target = await pdb.get<{ target_agent_id: string; attempts: number }>(
						`SELECT target_agent_id, attempts FROM ticket_delivery_outbox WHERE delivery_id = ?`,
						[deliveryId],
					).catch(() => undefined);
					if (!target) {
						return false;
					}
					if (cliMissing) {
						await pdb.run(
							`UPDATE ticket_delivery_outbox
							 SET state = 'blocked_cli', claimed_by_window_id = NULL, leased_until = NULL, last_error = ?
							 WHERE delivery_id = ?`,
							[error, deliveryId],
						);
						await this.rollbackUnstartedInDb(p.project_id, pdb, target.target_agent_id).catch(() => undefined);
						return true;
					}
					const nextState = target.attempts >= 5 ? 'dead_letter' : 'pending';
					const nextRetry = Date.now() + Math.min(30_000, 1_000 * Math.pow(2, target.attempts));
					await pdb.run(
						`UPDATE ticket_delivery_outbox
						 SET state = ?, claimed_by_window_id = NULL, leased_until = NULL, next_retry_at = ?, last_error = ?
						 WHERE delivery_id = ?`,
						[nextState, nextRetry, error, deliveryId],
					).catch(() => undefined);
					return true;
				});
				if (handled) {
					return;
				}
			}
		});
	}

	async releaseWindowDeliveries(windowId: number): Promise<void> {
		if (this.shuttingDown || this._isDisposed) {
			return;
		}
		return this.trackServiceCall(async () => {
			if (this.shuttingDown || this._isDisposed) {
				return;
			}
			const projs = await this.sqliteStore.catalog.all<{ project_id: string }>(`SELECT project_id FROM projects_index`).catch(() => []);
			if (this.shuttingDown || this._isDisposed) {
				return;
			}
			for (const p of projs) {
				if (this.shuttingDown || this._isDisposed) {
					return;
				}
				if (this.isProjectDeletingOrRemoved(p.project_id)) {
					continue;
				}
				await this.trackProjectOp(p.project_id, async () => {
					if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(p.project_id)) {
						return;
					}
					const pdb = await this.tryOpenHealedActiveProjectDb(p.project_id);
					if (!pdb) {
						return;
					}
					const released = await pdb.all<{ target_agent_id: string }>(
						`SELECT DISTINCT target_agent_id FROM ticket_delivery_outbox WHERE state = 'in_flight' AND claimed_by_window_id = ?`,
						[windowId],
					).catch(() => []);
					if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(p.project_id)) {
						return;
					}
					if (released.length > 0) {
						await pdb.run(
							`UPDATE ticket_delivery_outbox
							 SET state = 'pending', claimed_by_window_id = NULL, leased_until = NULL, next_retry_at = 0
							 WHERE state = 'in_flight' AND claimed_by_window_id = ?`,
							[windowId],
						).catch(() => undefined);
						if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(p.project_id)) {
							return;
						}
						for (const r of released) {
							this.fireDidEnqueueOutbox({ projectId: p.project_id, targetAgentId: r.target_agent_id });
						}
					}
				});
			}
		});
	}

	async requeueBlockedCliDeliveries(req?: { readonly projectId?: string; readonly agentId?: string }): Promise<{ readonly requeuedCount: number }> {
		this.assertNotShuttingDown();
		return this.trackServiceCall(async () => {
			if (this.shuttingDown || this._isDisposed) {
				return { requeuedCount: 0 };
			}
			const projectIdFilter = req?.projectId?.trim() || undefined;
			const agentIdFilter = req?.agentId?.trim() || undefined;
			const projs = projectIdFilter
				? [{ project_id: projectIdFilter }]
				: await this.sqliteStore.catalog.all<{ project_id: string }>(`SELECT project_id FROM projects_index`).catch(() => []);

			let requeuedCount = 0;
			for (const p of projs) {
				if (this.shuttingDown || this._isDisposed) {
					break;
				}
				if (this.isProjectDeletingOrRemoved(p.project_id)) {
					continue;
				}
				const batchRes = await this.trackProjectOp(p.project_id, async () => {
					if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(p.project_id)) {
						return { changes: 0, agentIds: [] as string[] };
					}
					const pdb = await this.tryOpenHealedActiveProjectDb(p.project_id);
					if (!pdb) {
						return { changes: 0, agentIds: [] as string[] };
					}
					return pdb.transaction(async tx => {
						const affected = agentIdFilter
							? await tx.all<{ target_agent_id: string }>(
								`SELECT DISTINCT target_agent_id FROM ticket_delivery_outbox WHERE state = 'blocked_cli' AND target_agent_id = ?`,
								[agentIdFilter],
							)
							: await tx.all<{ target_agent_id: string }>(
								`SELECT DISTINCT target_agent_id FROM ticket_delivery_outbox WHERE state = 'blocked_cli'`,
							);
						if (affected.length === 0) {
							return { changes: 0, agentIds: [] as string[] };
						}
						const upd = agentIdFilter
							? await tx.run(
								`UPDATE ticket_delivery_outbox
								 SET state = 'pending', claimed_by_window_id = NULL, leased_until = NULL, next_retry_at = 0, last_error = NULL
								 WHERE state = 'blocked_cli' AND target_agent_id = ?`,
								[agentIdFilter],
							)
							: await tx.run(
								`UPDATE ticket_delivery_outbox
								 SET state = 'pending', claimed_by_window_id = NULL, leased_until = NULL, next_retry_at = 0, last_error = NULL
								 WHERE state = 'blocked_cli'`,
							);
						return {
							changes: upd.changes,
							agentIds: affected.map(r => r.target_agent_id),
						};
					}).catch(() => ({ changes: 0, agentIds: [] as string[] }));
				});

				if (batchRes.changes > 0) {
					requeuedCount += batchRes.changes;
					for (const targetAgentId of batchRes.agentIds) {
						this.fireDidEnqueueOutbox({ projectId: p.project_id, targetAgentId });
					}
				}
			}
			return { requeuedCount };
		});
	}

	// =========================================================================
	// Unified 45 `ade_*` CLI Command Dispatcher
	// =========================================================================

	async executeCliCommand(
		caller: IAdeVerifiedCliCaller,
		command: AdeCliCommandName,
		args: Readonly<Record<string, unknown>>,
		idempotencyKey?: string,
	): Promise<Record<string, unknown>> {
		this.assertNotShuttingDown();
		if (this.isProjectDeletingOrRemoved(caller.projectId)) {
			throw new AdeError('ERR_UNAUTHORIZED', '所属项目不存在或已被删除');
		}
		return this.trackServiceCall(() => this.trackProjectOp(caller.projectId, () => this.executeCliCommandInternal(caller, command, args, idempotencyKey)));
	}

	private async executeCliCommandInternal(
		caller: IAdeVerifiedCliCaller,
		command: AdeCliCommandName,
		args: Readonly<Record<string, unknown>>,
		_idempotencyKey?: string,
	): Promise<Record<string, unknown>> {
		this.assertNotShuttingDown();
		if (this.isProjectDeletingOrRemoved(caller.projectId)) {
			throw new AdeError('ERR_UNAUTHORIZED', '所属项目不存在或已被删除');
		}
		const pdb = await this.requireProjectDbForCaller(caller.projectId);
		const callerAgent = await this.verifyActiveCallerNode(pdb, caller);

		switch (command) {
			// -------------------- Module 0: Base (3) --------------------
			case 'ade_whoami': {
				assertAllowedArgKeys(args, []);
				return pdb.withLock(async runner => {
					const ag = await this.verifyActiveCallerInRunner(runner, caller);
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					const heldRow = await runner.get<{ c: number }>(
						`SELECT COUNT(*) AS c FROM tickets WHERE holder_id = ? AND status = 'active'`,
						[ag.agent_id],
					);
					const wbUnreadTotal = await this.computeTotalReadableBoardUnreadsInTx(runner, state, ag.agent_id);
					return {
						ok: true,
						agent_id: ag.agent_id,
						project_id: ag.project_id,
						level: formatLevelLabel(ag.level),
						name: ag.name,
						role_summary: ag.role_summary,
						host: ag.host,
						held_ticket_count: Number(heldRow?.c ?? 0),
						wb_unread_total: wbUnreadTotal,
						current_doc_rev: ADE_SYSPROMPT_DOC_REV,
					};
				});
			}

			case 'ade_sysprompt_path': {
				assertAllowedArgKeys(args, ['module']);
				const modRaw = args.module === undefined ? 'all' : String(args.module).trim().toLowerCase();
				if (modRaw !== 'all' && !(ADE_SYSPROMPT_MODULE_KEYS as readonly string[]).includes(modRaw)) {
					throw new AdeError('ERR_INVALID_ARGS', `非法的 --module 参数: ${String(args.module)}`);
				}
				let synced: { doc_rev: number; base_dir: string; files: Readonly<Record<AdeSyspromptModuleKey, string>> };
				if (callerAgent.host === 'local') {
					synced = await this.syspromptSync.ensureLocalSyspromptDocs();
				} else {
					const info = await this.storageEngine.resolveRemoteHostInfo(callerAgent.host);
					synced = await this.syspromptSync.ensureRemoteSyspromptDocs(info.alias, info.remoteHome, info.ip);
				}
				await this.verifyActiveCallerNode(pdb, caller);
				const filesOut: Record<string, string> = modRaw === 'all'
					? { ...synced.files }
					: { [modRaw]: synced.files[modRaw as AdeSyspromptModuleKey] };
				return {
					ok: true,
					doc_rev: synced.doc_rev,
					base_dir: synced.base_dir,
					files: filesOut,
				};
			}

			case 'ade_sysprompt_update': {
				assertAllowedArgKeys(args, ['since']);
				let explicitSince: number | undefined;
				if (args.since !== undefined) {
					const parsed = typeof args.since === 'number'
						? args.since
						: (typeof args.since === 'string' && /^\d+$/.test(args.since.trim()) ? Number.parseInt(args.since.trim(), 10) : NaN);
					if (!Number.isInteger(parsed) || parsed < 0) {
						throw new AdeError('ERR_INVALID_ARGS', '--since 必须为非负整数');
					}
					explicitSince = parsed;
				}
				this.syspromptSync.invalidateRemoteSyspromptCache();
				return pdb.transaction(async tx => {
					const ag = await this.verifyActiveCallerInRunner(tx, caller);
					const fromRev = explicitSince !== undefined ? explicitSince : ag.last_read_doc_rev;
					const report = computeAdeSyspromptUpdate(fromRev);
					if (ag.last_read_doc_rev < ADE_SYSPROMPT_DOC_REV) {
						await tx.run(
							`UPDATE agents SET last_read_doc_rev = ?, updated_at = ? WHERE agent_id = ?`,
							[ADE_SYSPROMPT_DOC_REV, Date.now(), ag.agent_id],
						);
					}
					return { ok: true, ...report };
				});
			}

			// -------------------- Module 1: Ticket (7) --------------------
			case 'ade_create':
				return this.handleCliTicketCreate(pdb, caller, args);
			case 'ade_destroy':
				return this.handleCliTicketDestroy(pdb, caller, args);
			case 'ade_edit':
				return this.handleCliTicketEdit(pdb, caller, args);
			case 'ade_list': {
				assertAllowedArgKeys(args, []);
				return pdb.withLock(async runner => {
					await this.verifyActiveCallerInRunner(runner, caller);
					const rows = await runner.all<{ ticket_id: string; current_task_title: string; current_task_summary: string }>(
						`SELECT ticket_id, current_task_title, current_task_summary
						 FROM tickets
						 WHERE holder_id = ? AND status = 'active'
						 ORDER BY updated_at DESC`,
						[caller.agentId],
					);
					return {
						ok: true,
						tickets: rows.map(r => ({
							ticket_id: r.ticket_id,
							task_title: r.current_task_title,
							summary: r.current_task_summary,
						})),
					};
				});
			}
			case 'ade_get': {
				assertAllowedArgKeys(args, ['ticketId']);
				const ticketId = requireNonEmptyString(args.ticketId, 'ticket_id');
				return pdb.withLock(async runner => {
					await this.verifyActiveCallerInRunner(runner, caller);
					const tk = await runner.get<IRawTicketRow>(`SELECT * FROM tickets WHERE ticket_id = ?`, [ticketId]);
					assertTicketAccess(tk ? this.toPolicyTicket(tk) : undefined, caller.agentId, 'read');
					return {
						ok: true,
						ticket: projectTicketPublicView({
							...tk!,
							need_return: tk!.need_return === 1,
							current_has_detail_ref: tk!.current_has_detail_ref === 1,
							has_history_ref: tk!.has_history_ref === 1,
						}),
					};
				});
			}
			case 'ade_detail': {
				assertAllowedArgKeys(args, ['ticketId', 'taskId']);
				const ticketId = requireNonEmptyString(args.ticketId, 'ticket_id');
				const taskId = requireNonEmptyString(args.taskId, 'task_id');
				let ptr!: { storage_host: string; storage_path: string; size_bytes: number; sha256: string };
				let unpin!: () => void;
				await pdb.withLock(async runner => {
					await this.verifyActiveCallerInRunner(runner, caller);
					const tk = await runner.get<IRawTicketRow>(`SELECT * FROM tickets WHERE ticket_id = ?`, [ticketId]);
					assertTicketAccess(tk ? this.toPolicyTicket(tk) : undefined, caller.agentId, 'read');
					const tr = await runner.get<{
						has_detail_ref: number;
						storage_host: string | null;
						storage_path: string | null;
						size_bytes: number | null;
						sha256: string | null;
					}>(`SELECT has_detail_ref, storage_host, storage_path, size_bytes, sha256 FROM ticket_tasks WHERE ticket_id = ? AND task_id = ?`, [ticketId, taskId]);
					if (!tr || tr.has_detail_ref !== 1 || !tr.storage_path) {
						throw new AdeError('ERR_DETAIL_NOT_FOUND', '指定的 (ticket_id, task_id) 不存在或无详细描述');
					}
					const host = tr.storage_host || 'local';
					unpin = this.storageEngine.pinBlobForRead(host, tr.storage_path);
					ptr = {
						storage_host: host,
						storage_path: tr.storage_path,
						size_bytes: Number(tr.size_bytes ?? 0),
						sha256: tr.sha256 ?? '',
					};
				});
				try {
					const detail = await this.storageEngine.readTextBlobVerified(ptr);
					return { ok: true, ticket_id: ticketId, task_id: taskId, detail };
				} finally {
					unpin();
				}
			}
			case 'ade_history': {
				assertAllowedArgKeys(args, ['ticketId']);
				const ticketId = requireNonEmptyString(args.ticketId, 'ticket_id');
				return pdb.withLock(async runner => {
					await this.verifyActiveCallerInRunner(runner, caller);
					const tk = await runner.get<IRawTicketRow>(`SELECT * FROM tickets WHERE ticket_id = ?`, [ticketId]);
					assertTicketAccess(tk ? this.toPolicyTicket(tk) : undefined, caller.agentId, 'read');
					const rows = await runner.all<{ task_id: string; task_title: string; summary: string }>(
						`SELECT task_id, task_title, summary
						 FROM ticket_tasks
						 WHERE ticket_id = ? AND is_archived = 1
						 ORDER BY seq ASC`,
						[ticketId],
					);
					return {
						ok: true,
						ticket_id: ticketId,
						tasks: rows.map(r => ({
							task_id: r.task_id,
							task_title: r.task_title,
							summary: r.summary,
						})),
					};
				});
			}

			// -------------------- Module 2: Orchestration (15) --------------------
			case 'ade_host_list': {
				assertAllowedArgKeys(args, []);
				return pdb.transaction(async tx => {
					await this.verifyActiveCallerInRunner(tx, caller);
					await this.syncProjectHostsTableInTx(tx);
					const rows = await tx.all<{ name: string; ip: string }>(`SELECT name, ip FROM project_hosts ORDER BY name ASC`);
					return { ok: true, hosts: rows.map(r => ({ name: r.name, ip: r.ip })) };
				});
			}
			case 'ade_engine_list': {
				assertAllowedArgKeys(args, ['host']);
				const host = requireNonEmptyString(args.host, '--host');
				const canonicalHost = host === 'local' ? 'local' : await this.validateAndCanonicalizeHost(host, pdb);
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(caller.projectId)) {
					throw new AdeError('ERR_UNAUTHORIZED', '所属项目不存在或已被删除');
				}
				const engines = await this.engineProber.probeEngines(canonicalHost);
				await this.verifyActiveCallerNode(pdb, caller);
				return { ok: true, host: canonicalHost, engines: [...engines] };
			}
			case 'ade_model_list': {
				assertAllowedArgKeys(args, ['host', 'engine']);
				const host = requireNonEmptyString(args.host, '--host');
				const engineRaw = requireNonEmptyString(args.engine, '--engine');
				const canonicalHost = host === 'local' ? 'local' : await this.validateAndCanonicalizeHost(host, pdb);
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(caller.projectId)) {
					throw new AdeError('ERR_UNAUTHORIZED', '所属项目不存在或已被删除');
				}
				const probed = await this.engineProber.probeModels(canonicalHost, engineRaw);
				await this.verifyActiveCallerNode(pdb, caller);
				return {
					ok: true,
					host: canonicalHost,
					engine: probed.engine,
					models: [...probed.models],
					efforts: [...probed.efforts],
				};
			}
			case 'ade_agent_list':
				return this.handleCliAgentList(pdb, caller, args);
			case 'ade_agent_create':
				return this.handleCliAgentCreate(pdb, caller, args);
			case 'ade_agent_edit':
				return this.handleCliAgentEdit(pdb, caller, args);
			case 'ade_agent_move':
				return this.handleCliAgentMove(pdb, caller, args);
			case 'ade_agent_delete':
				return this.handleCliAgentDelete(pdb, caller, args);
			case 'ade_dept_create':
				return this.handleCliDeptCreate(pdb, caller, args);
			case 'ade_dept_edit':
				return this.handleCliDeptEdit(pdb, caller, args);
			case 'ade_dept_delete':
				return this.handleCliDeptDelete(pdb, caller, args);
			case 'ade_dept_member':
				return this.handleCliDeptMember(pdb, caller, args);
			case 'ade_dept_members':
				return this.handleCliDeptMembers(pdb, caller, args);
			case 'ade_dept_info':
				return this.handleCliDeptInfo(pdb, caller, args);
			case 'ade_wb_grant':
				return this.handleCliWbGrant(pdb, caller, args);

			// -------------------- Module 3: White Board (20) --------------------
			default:
				return this.handleCliWhiteboardCommand(pdb, caller, command, args);
		}
	}

	// =========================================================================
	// CLI Ticket Implementations
	// =========================================================================

	private async resolveDetailInputSpec(args: Readonly<Record<string, unknown>>): Promise<
		| { readonly kind: 'none' }
		| { readonly kind: 'inline'; readonly text: string }
		| { readonly kind: 'file'; readonly filePath: string; readonly isTempBypass: boolean }
	> {
		const hasInline = args.detail !== undefined;
		const hasFile = args.detailFile !== undefined;
		const hasTemp = args.detailTempFile !== undefined;
		const count = Number(hasInline) + Number(hasFile) + Number(hasTemp);
		if (count > 1) {
			throw new AdeError('ERR_INVALID_ARGS', '--detail、--detail-stdin 与 --detail-file 最多只能三选一');
		}
		if (hasInline) {
			const str = String(args.detail ?? '');
			return str.length > 0 ? { kind: 'inline', text: str } : { kind: 'none' };
		}
		if (hasFile) {
			const fp = requireNonEmptyString(args.detailFile, '--detail-file');
			return { kind: 'file', filePath: fp, isTempBypass: false };
		}
		if (hasTemp) {
			const fp = requireNonEmptyString(args.detailTempFile, '--detail-stdin');
			return { kind: 'file', filePath: fp, isTempBypass: true };
		}
		return { kind: 'none' };
	}

	private async handleCliTicketCreate(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['to', 'type', 'title', 'summary', 'needReturn', 'mode', 'detail', 'detailFile', 'detailTempFile']);
		const toId = requireNonEmptyString(args.to, '--to');
		const taskType = requireNonEmptyString(args.type, '--type');
		const taskTitle = requireNonEmptyString(args.title, '--title');
		const summary = requireNonEmptyString(args.summary, '--summary');
		const needReturn = parseBooleanArg(args.needReturn, '--need-return');
		const modeRaw = args.mode === undefined ? 'queue' : String(args.mode).trim();
		if (modeRaw !== 'queue' && modeRaw !== 'steer') {
			throw new AdeError('ERR_INVALID_ARGS', `--mode 仅支持 queue 或 steer，收到: ${modeRaw}`);
		}
		const deliveryMode: AdeTicketDeliveryMode = modeRaw;
		const detailSpec = await this.resolveDetailInputSpec(args);

		// Pre-validate jurisdiction and determine storage host BEFORE uploading blob
		const preCheck = await pdb.withLock(async runner => {
			const callerRow = await this.verifyActiveCallerInRunner(runner, caller);
			const state = await this.loadPolicyStateInTx(runner, caller.projectId);
			assertCallerManagesTarget(state, caller.agentId, toId, { forTicketCreate: true });
			const targetRow = await runner.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [toId]);
			const metaRow = await runner.get<{ cross_host_ticket_storage: string }>(`SELECT cross_host_ticket_storage FROM project_meta WHERE project_id = ?`, [caller.projectId]);
			return {
				callerRow,
				targetRow: targetRow!,
				crossHostDefault: metaRow?.cross_host_ticket_storage ?? 'local',
			};
		});

		const ticketId = genId('tk');
		const taskId = genId('tsk');
		const targetStorageHost = resolveTicketDetailStorageHost(
			preCheck.callerRow.host,
			preCheck.targetRow.host,
			preCheck.crossHostDefault,
		);

		let storedPtr: { blob_id: string; storage_host: string; storage_path: string; size_bytes: number; sha256: string } | undefined;
		let uploadedStorageHost: string | undefined;
		if (detailSpec.kind === 'inline') {
			storedPtr = await this.storageEngine.storeTextBlob({
				targetStorageHost,
				relSubdir: path.posix.join(`${caller.projectId}_tickets`, ticketId),
				filePrefix: taskId,
				text: detailSpec.text,
			});
			uploadedStorageHost = storedPtr.storage_host;
		} else if (detailSpec.kind === 'file') {
			const res = await this.storageEngine.storeFileFromHost({
				sourceHost: preCheck.callerRow.host,
				sourcePath: detailSpec.filePath,
				deleteSourceTempAfter: detailSpec.isTempBypass,
				targetStorageHost,
				relSubdir: path.posix.join(`${caller.projectId}_tickets`, ticketId),
				filePrefix: taskId,
			});
			uploadedStorageHost = res.storage_host;
			if (res.size_bytes > 0) {
				storedPtr = res;
			} else {
				await this.storageEngine.enqueueTombstones([{ projectId: caller.projectId, storageHost: res.storage_host, storagePath: res.storage_path }]);
			}
		}

		let animEvent!: IAdeTicketTransferAnimationEvent;
		try {
			await pdb.transaction(async tx => {
				const callerRow = await this.verifyActiveCallerInRunner(tx, caller);
				const state = await this.loadPolicyStateInTx(tx, caller.projectId);
				assertCallerManagesTarget(state, caller.agentId, toId, { forTicketCreate: true });

				const now = Date.now();
				const hasDetail = Boolean(storedPtr);
				await tx.run(
					`INSERT INTO tickets
					 (ticket_id, project_id, creator_id, peer_id, ticket_level, from_id, to_id, holder_id,
					  delivery_mode, need_return, current_task_id, current_task_type, current_task_title,
					  current_task_summary, current_has_detail_ref, has_history_ref, status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
					[
						ticketId, caller.projectId, callerRow.agent_id, toId, callerRow.level,
						callerRow.agent_id, toId, toId,
						deliveryMode, needReturn ? 1 : 0, taskId, taskType, taskTitle, summary,
						hasDetail ? 1 : 0, now, now,
					],
				);

				await tx.run(
					`INSERT INTO ticket_tasks
					 (ticket_id, task_id, seq, is_archived, from_id, to_id, delivery_mode, need_return,
					  task_type, task_title, summary, has_detail_ref, blob_id, storage_host, storage_path,
					  size_bytes, sha256, content_rev, detail_truncated, created_at)
					 VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
					[
						ticketId, taskId, callerRow.agent_id, toId, deliveryMode, needReturn ? 1 : 0,
						taskType, taskTitle, summary, hasDetail ? 1 : 0,
						storedPtr?.blob_id ?? null, storedPtr?.storage_host ?? null, storedPtr?.storage_path ?? null,
						storedPtr?.size_bytes ?? null, storedPtr?.sha256 ?? null, now,
					],
				);

				const hops = computeTreeTransferHops(state, callerRow.agent_id, toId);
				for (const hop of hops) {
					await tx.run(
						`INSERT INTO edge_ticket_transfers
						 (transfer_id, project_id, edge_pair_key, hop_from_id, hop_to_id, hop_seq, total_hops,
						  origin_from_id, target_to_id, ticket_id, task_id, action_kind, task_type, task_title, summary, has_detail_ref, transferred_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'create', ?, ?, ?, ?, ?)`,
						[
							genId('xfr'), caller.projectId, hop.edge_pair_key, hop.hop_from_id, hop.hop_to_id,
							hop.hop_seq, hop.total_hops, callerRow.agent_id, toId, ticketId, taskId,
							taskType, taskTitle, summary, hasDetail ? 1 : 0, now,
						],
					);
				}

				const payloadText = formatAdeTicketDeliveryPayload({
					fromId: callerRow.agent_id,
					ticketId,
					taskId,
					taskType,
					needReturn,
					hasDetailRef: hasDetail,
					hasHistoryRef: false,
					taskTitle,
					summary,
				});
				await tx.run(
					`INSERT INTO ticket_delivery_outbox
					 (delivery_id, ticket_id, task_id, target_agent_id, delivery_mode, payload_text, state, attempts, next_retry_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?)`,
					[genId('dlv'), ticketId, taskId, toId, deliveryMode, payloadText, now],
				);

				// Lock engine immediately once first Ticket is queued (`session_phase = 'starting'`)
				await tx.run(
					`UPDATE agents
					 SET session_phase = CASE WHEN session_phase = 'unstarted' THEN 'starting' ELSE session_phase END,
					     session_started = 1,
					     updated_at = ?
					 WHERE agent_id = ?`,
					[now, toId],
				);

				animEvent = {
					transfer_group_id: genId('anim'),
					project_id: caller.projectId,
					ticket_id: ticketId,
					task_id: taskId,
					origin_from_id: callerRow.agent_id,
					target_to_id: toId,
					transferred_at: now,
					hops,
				};
			});
		} catch (err) {
			const cleanupTombstones = this.buildTicketUploadCleanupTombstones(
				caller.projectId,
				ticketId,
				storedPtr?.storage_host ?? uploadedStorageHost,
				storedPtr?.storage_path,
				true,
			);
			if (cleanupTombstones.length > 0) {
				await this.storageEngine.enqueueTombstones(cleanupTombstones).catch(() => undefined);
			}
			throw err;
		}

		this.fireDidChangeProject(caller.projectId);
		this.fireDidTransferTicket(animEvent);
		this.fireDidEnqueueOutbox({ projectId: caller.projectId, targetAgentId: toId });
		return { ok: true, ticket_id: ticketId, task_id: taskId };
	}

	private async handleCliTicketEdit(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		if (Object.prototype.hasOwnProperty.call(args, 'from') || Object.prototype.hasOwnProperty.call(args, 'to')) {
			throw new AdeError('ERR_INVALID_ARGS', 'ade_edit 严禁传入 --from 或 --to，对端由控制中心自动推导');
		}
		assertAllowedArgKeys(args, ['ticketId', 'type', 'title', 'summary', 'needReturn', 'mode', 'detail', 'detailFile', 'detailTempFile']);
		const ticketId = requireNonEmptyString(args.ticketId, 'ticket_id');
		const taskType = requireNonEmptyString(args.type, '--type');
		const taskTitle = requireNonEmptyString(args.title, '--title');
		const summary = requireNonEmptyString(args.summary, '--summary');
		const needReturn = parseBooleanArg(args.needReturn, '--need-return');
		const modeRaw = args.mode === undefined ? 'queue' : String(args.mode).trim();
		if (modeRaw !== 'queue' && modeRaw !== 'steer') {
			throw new AdeError('ERR_INVALID_ARGS', `--mode 仅支持 queue 或 steer，收到: ${modeRaw}`);
		}
		const deliveryMode: AdeTicketDeliveryMode = modeRaw;
		const detailSpec = await this.resolveDetailInputSpec(args);

		const preCheck = await pdb.transaction(async tx => {
			const callerRow = await this.verifyActiveCallerInRunner(tx, caller);
			const state = await this.loadPolicyStateInTx(tx, caller.projectId);
			const tk = await tx.get<IRawTicketRow>(`SELECT * FROM tickets WHERE ticket_id = ?`, [ticketId]);
			assertTicketAccess(tk ? this.toPolicyTicket(tk) : undefined, caller.agentId, 'edit');

			const nextToId = caller.agentId === tk!.creator_id ? tk!.peer_id : tk!.creator_id;
			const creator = state.agents[tk!.creator_id];
			const peer = state.agents[tk!.peer_id];
			const stillValidPair = Boolean(
				creator && peer && (
					(creator.level < peer.level && canCallerManageTarget(state, creator.agent_id, peer.agent_id))
					|| (peer.level < creator.level && canCallerManageTarget(state, peer.agent_id, creator.agent_id))
				),
			);
			const nextTarget = stillValidPair
				? await tx.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [nextToId])
				: undefined;
			if (!stillValidPair || !nextTarget) {
				const now = Date.now();
				await tx.run(`UPDATE tickets SET status = 'frozen_orphan', holder_id = NULL, frozen_at = ?, updated_at = ? WHERE ticket_id = ?`, [now, now, ticketId]);
				await tx.run(`DELETE FROM ticket_delivery_outbox WHERE ticket_id = ?`, [ticketId]);
				return { frozenNow: true as const };
			}
			if (nextTarget.level < tk!.ticket_level) {
				throw new AdeError('ERR_LEVEL_EXCEEDED', '对端员工职级高于 Ticket 等级');
			}
			const metaRow = await tx.get<{ cross_host_ticket_storage: string }>(`SELECT cross_host_ticket_storage FROM project_meta WHERE project_id = ?`, [caller.projectId]);
			return {
				frozenNow: false as const,
				callerRow,
				nextTarget,
				nextToId,
				crossHostDefault: metaRow?.cross_host_ticket_storage ?? 'local',
			};
		});
		if (preCheck.frozenNow) {
			this.fireDidCancelOutboxTickets({ projectId: caller.projectId, ticketIds: [ticketId] });
			this.fireDidChangeProject(caller.projectId);
			throw new AdeError('ERR_TICKET_FROZEN', '该 Ticket 关联员工管辖或部门关系已失效，已自动移入无名冻结列表');
		}

		const taskId = genId('tsk');
		const targetStorageHost = resolveTicketDetailStorageHost(
			preCheck.callerRow.host,
			preCheck.nextTarget.host,
			preCheck.crossHostDefault,
		);

		let storedPtr: { blob_id: string; storage_host: string; storage_path: string; size_bytes: number; sha256: string } | undefined;
		let uploadedStorageHost: string | undefined;
		if (detailSpec.kind === 'inline') {
			storedPtr = await this.storageEngine.storeTextBlob({
				targetStorageHost,
				relSubdir: path.posix.join(`${caller.projectId}_tickets`, ticketId),
				filePrefix: taskId,
				text: detailSpec.text,
			});
			uploadedStorageHost = storedPtr.storage_host;
		} else if (detailSpec.kind === 'file') {
			const res = await this.storageEngine.storeFileFromHost({
				sourceHost: preCheck.callerRow.host,
				sourcePath: detailSpec.filePath,
				deleteSourceTempAfter: detailSpec.isTempBypass,
				targetStorageHost,
				relSubdir: path.posix.join(`${caller.projectId}_tickets`, ticketId),
				filePrefix: taskId,
			});
			uploadedStorageHost = res.storage_host;
			if (res.size_bytes > 0) {
				storedPtr = res;
			} else {
				await this.storageEngine.enqueueTombstones([{ projectId: caller.projectId, storageHost: res.storage_host, storagePath: res.storage_path }]);
			}
		}

		let animEvent!: IAdeTicketTransferAnimationEvent;
		let frozenConcurrently = false;
		const nextToId = preCheck.nextToId;
		try {
			await pdb.transaction(async tx => {
				const callerRow = await this.verifyActiveCallerInRunner(tx, caller);
				const state = await this.loadPolicyStateInTx(tx, caller.projectId);
				const tk = await tx.get<IRawTicketRow>(`SELECT * FROM tickets WHERE ticket_id = ?`, [ticketId]);
				assertTicketAccess(tk ? this.toPolicyTicket(tk) : undefined, caller.agentId, 'edit');

				const creator = state.agents[tk!.creator_id];
				const peer = state.agents[tk!.peer_id];
				const targetNode = state.agents[nextToId];
				if (!creator || !peer || !targetNode || !(
					(creator.level < peer.level && canCallerManageTarget(state, creator.agent_id, peer.agent_id))
					|| (peer.level < creator.level && canCallerManageTarget(state, peer.agent_id, creator.agent_id))
				)) {
					const now = Date.now();
					await tx.run(`UPDATE tickets SET status = 'frozen_orphan', holder_id = NULL, frozen_at = ?, updated_at = ? WHERE ticket_id = ?`, [now, now, ticketId]);
					await tx.run(`DELETE FROM ticket_delivery_outbox WHERE ticket_id = ?`, [ticketId]);
					frozenConcurrently = true;
					return;
				}
				if (targetNode.level < tk!.ticket_level) {
					throw new AdeError('ERR_LEVEL_EXCEEDED', '对端员工职级高于 Ticket 等级');
				}

				const now = Date.now();
				const hasDetail = Boolean(storedPtr);

				// Archive previous current_task into history chain
				await tx.run(`UPDATE ticket_tasks SET is_archived = 1 WHERE ticket_id = ? AND is_archived = 0`, [ticketId]);
				const seqRow = await tx.get<{ m: number | null }>(`SELECT MAX(seq) AS m FROM ticket_tasks WHERE ticket_id = ?`, [ticketId]);
				const nextSeq = (seqRow?.m ?? 1) + 1;

				await tx.run(
					`INSERT INTO ticket_tasks
					 (ticket_id, task_id, seq, is_archived, from_id, to_id, delivery_mode, need_return,
					  task_type, task_title, summary, has_detail_ref, blob_id, storage_host, storage_path,
					  size_bytes, sha256, content_rev, detail_truncated, created_at)
					 VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
					[
						ticketId, taskId, nextSeq, callerRow.agent_id, nextToId, deliveryMode, needReturn ? 1 : 0,
						taskType, taskTitle, summary, hasDetail ? 1 : 0,
						storedPtr?.blob_id ?? null, storedPtr?.storage_host ?? null, storedPtr?.storage_path ?? null,
						storedPtr?.size_bytes ?? null, storedPtr?.sha256 ?? null, now,
					],
				);

				await tx.run(
					`UPDATE tickets
					 SET from_id = ?, to_id = ?, holder_id = ?, delivery_mode = ?, need_return = ?,
					     current_task_id = ?, current_task_type = ?, current_task_title = ?, current_task_summary = ?,
					     current_has_detail_ref = ?, has_history_ref = 1, updated_at = ?
					 WHERE ticket_id = ?`,
					[
						callerRow.agent_id, nextToId, nextToId, deliveryMode, needReturn ? 1 : 0,
						taskId, taskType, taskTitle, summary, hasDetail ? 1 : 0, now, ticketId,
					],
				);

				const hops = computeTreeTransferHops(state, callerRow.agent_id, nextToId);
				for (const hop of hops) {
					await tx.run(
						`INSERT INTO edge_ticket_transfers
						 (transfer_id, project_id, edge_pair_key, hop_from_id, hop_to_id, hop_seq, total_hops,
						  origin_from_id, target_to_id, ticket_id, task_id, action_kind, task_type, task_title, summary, has_detail_ref, transferred_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'edit', ?, ?, ?, ?, ?)`,
						[
							genId('xfr'), caller.projectId, hop.edge_pair_key, hop.hop_from_id, hop.hop_to_id,
							hop.hop_seq, hop.total_hops, callerRow.agent_id, nextToId, ticketId, taskId,
							taskType, taskTitle, summary, hasDetail ? 1 : 0, now,
						],
					);
				}

				const payloadText = formatAdeTicketDeliveryPayload({
					fromId: callerRow.agent_id,
					ticketId,
					taskId,
					taskType,
					needReturn,
					hasDetailRef: hasDetail,
					hasHistoryRef: true,
					taskTitle,
					summary,
				});
				await tx.run(
					`INSERT INTO ticket_delivery_outbox
					 (delivery_id, ticket_id, task_id, target_agent_id, delivery_mode, payload_text, state, attempts, next_retry_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?)`,
					[genId('dlv'), ticketId, taskId, nextToId, deliveryMode, payloadText, now],
				);
				await tx.run(
					`UPDATE agents
					 SET session_phase = CASE WHEN session_phase = 'unstarted' THEN 'starting' ELSE session_phase END,
					     session_started = 1,
					     updated_at = ?
					 WHERE agent_id = ?`,
					[now, nextToId],
				);

				animEvent = {
					transfer_group_id: genId('anim'),
					project_id: caller.projectId,
					ticket_id: ticketId,
					task_id: taskId,
					origin_from_id: callerRow.agent_id,
					target_to_id: nextToId,
					transferred_at: now,
					hops,
				};
			});
			if (frozenConcurrently) {
				throw new AdeError('ERR_TICKET_FROZEN', '该 Ticket 已移入项目无名孤儿列表冻结');
			}
		} catch (err) {
			const cleanupTombstones = this.buildTicketUploadCleanupTombstones(
				caller.projectId,
				ticketId,
				storedPtr?.storage_host ?? uploadedStorageHost,
				storedPtr?.storage_path,
				false,
			);
			if (cleanupTombstones.length > 0) {
				await this.storageEngine.enqueueTombstones(cleanupTombstones).catch(() => undefined);
			}
			if (frozenConcurrently) {
				this.fireDidCancelOutboxTickets({ projectId: caller.projectId, ticketIds: [ticketId] });
				this.fireDidChangeProject(caller.projectId);
			}
			throw err;
		}

		this.fireDidChangeProject(caller.projectId);
		this.fireDidTransferTicket(animEvent);
		this.fireDidEnqueueOutbox({ projectId: caller.projectId, targetAgentId: nextToId });
		return { ok: true, ticket_id: ticketId, task_id: taskId, to_id: nextToId };
	}

	private async handleCliTicketDestroy(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['ticketId']);
		const ticketId = requireNonEmptyString(args.ticketId, 'ticket_id');

		// Step 1: Verify permission & pin any live detail blobs inside Sequencer lock
		const pinnedBlobs: Array<{
			readonly taskId: string;
			readonly storageHost: string;
			readonly storagePath: string;
			readonly sizeBytes: number;
			readonly sha256: string;
			readonly unpin: () => void;
		}> = [];

		await pdb.withLock(async runner => {
			await this.verifyActiveCallerInRunner(runner, caller);
			const tk = await runner.get<IRawTicketRow>(`SELECT * FROM tickets WHERE ticket_id = ?`, [ticketId]);
			assertTicketAccess(tk ? this.toPolicyTicket(tk) : undefined, caller.agentId, 'destroy');

			const tasks = await runner.all<{
				task_id: string;
				has_detail_ref: number;
				storage_host: string | null;
				storage_path: string | null;
				size_bytes: number | null;
				sha256: string | null;
			}>(`SELECT task_id, has_detail_ref, storage_host, storage_path, size_bytes, sha256 FROM ticket_tasks WHERE ticket_id = ?`, [ticketId]);
			for (const tr of tasks) {
				if (tr.has_detail_ref === 1 && tr.storage_path) {
					const host = tr.storage_host || 'local';
					const unpin = this.storageEngine.pinBlobForRead(host, tr.storage_path);
					pinnedBlobs.push({
						taskId: tr.task_id,
						storageHost: host,
						storagePath: tr.storage_path,
						sizeBytes: Number(tr.size_bytes ?? 0),
						sha256: tr.sha256 ?? '',
						unpin,
					});
				}
			}
		});

		// Step 2: Outside DB lock, read and gzip-compress each detail for UI historical inspection before physical deletion
		const archivedByTask = new Map<string, { readonly gzipBuf: Buffer | null; readonly truncated: number }>();
		try {
			for (const pb of pinnedBlobs) {
				try {
					const fullText = await this.storageEngine.readTextBlobVerified({
						storage_host: pb.storageHost,
						storage_path: pb.storagePath,
						size_bytes: pb.sizeBytes,
						sha256: pb.sha256,
					});
					const rawBuf = Buffer.from(fullText, 'utf8');
					let toCompress = rawBuf;
					let truncated = 0;
					if (rawBuf.byteLength > MAX_ARCHIVED_DETAIL_BYTES) {
						let headEnd = TRUNCATED_SLICE_BYTES;
						while (headEnd > 0 && (rawBuf[headEnd] & 0xc0) === 0x80) {
							headEnd--;
						}
						let tailStart = rawBuf.byteLength - TRUNCATED_SLICE_BYTES;
						while (tailStart < rawBuf.byteLength && (rawBuf[tailStart] & 0xc0) === 0x80) {
							tailStart++;
						}
						const head = rawBuf.subarray(0, headEnd).toString('utf8');
						const tail = rawBuf.subarray(tailStart).toString('utf8');
						toCompress = Buffer.from(`${head}\n\n...[详述超过 2MB，已截断中间部分]...\n\n${tail}`, 'utf8');
						truncated = 1;
					}
					const gz = await gzipAsync(toCompress, { level: zlib.constants.Z_BEST_SPEED });
					archivedByTask.set(pb.taskId, { gzipBuf: gz, truncated });
				} catch {
					// Remote host offline at destroy moment: do not block destroy; mark null for UI fallback notice
					archivedByTask.set(pb.taskId, { gzipBuf: null, truncated: 0 });
				}
			}
		} finally {
			for (const pb of pinnedBlobs) {
				pb.unpin();
			}
		}

		// Step 3: Atomically transition Ticket to `destroyed`, store `archived_detail_gzip`, clear pointers, and enqueue tombstones
		const tombstones: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> = [];
		await pdb.transaction(async tx => {
			await this.verifyActiveCallerInRunner(tx, caller);
			const tk = await tx.get<IRawTicketRow>(`SELECT * FROM tickets WHERE ticket_id = ?`, [ticketId]);
			assertTicketAccess(tk ? this.toPolicyTicket(tk) : undefined, caller.agentId, 'destroy');

			const currentTasks = await tx.all<{ task_id: string; storage_host: string | null; storage_path: string | null }>(
				`SELECT task_id, storage_host, storage_path FROM ticket_tasks WHERE ticket_id = ?`,
				[ticketId],
			);
			const seenFiles = new Set<string>();
			const seenDirs = new Set<string>();
			const pushFileTombstone = (rawHost: string | null | undefined, rawPath: string | null | undefined) => {
				const normPath = (rawPath || '').trim();
				if (!normPath) {
					return;
				}
				const host = (rawHost || 'local').trim() || 'local';
				const fileKey = `${host}\0${normPath}`;
				if (!seenFiles.has(fileKey)) {
					seenFiles.add(fileKey);
					tombstones.push({ projectId: caller.projectId, storageHost: host, storagePath: normPath });
				}
			};
			const pushTicketDirTombstone = (rawHost: string | null | undefined, explicitFilePath?: string | null) => {
				const host = (rawHost || 'local').trim() || 'local';
				const cleanFile = (explicitFilePath || '').trim();
				const dirPath = cleanFile
					? (host === 'local' ? path.dirname(cleanFile) : path.posix.dirname(cleanFile))
					: (host === 'local'
						? path.join(this.sqliteStore.localStoreRootDir, `${caller.projectId}_tickets`, ticketId)
						: `~/${ADE_REMOTE_STORE_DIR_NAME}/${caller.projectId}_tickets/${ticketId}`);
				const dirKey = `${host}\0${dirPath}`;
				if (!seenDirs.has(dirKey)) {
					seenDirs.add(dirKey);
					tombstones.push({ projectId: caller.projectId, storageHost: host, storagePath: dirPath, isDir: true });
				}
			};

			for (const ct of currentTasks) {
				if (ct.storage_path) {
					pushFileTombstone(ct.storage_host, ct.storage_path);
					pushTicketDirTombstone(ct.storage_host, ct.storage_path);
				}
				const arch = archivedByTask.get(ct.task_id);
				await tx.run(
					`UPDATE ticket_tasks
					 SET blob_id = NULL, storage_host = NULL, storage_path = NULL,
					     archived_detail_gzip = COALESCE(?, archived_detail_gzip),
					     detail_truncated = CASE WHEN ? = 1 THEN 1 ELSE detail_truncated END
					 WHERE ticket_id = ? AND task_id = ?`,
					[arch?.gzipBuf ?? null, arch?.truncated ?? 0, ticketId, ct.task_id],
				);
			}

			// Clean in-flight/historical migration target replicas & <pid>_tickets/<ticket_id> directories, and skip unfinished rows
			const migRows = await tx.all<{
				src_host: string | null;
				src_path: string | null;
				dst_host: string | null;
				dst_path: string | null;
			}>(
				`SELECT src_host, src_path, dst_host, dst_path
				 FROM storage_migration_items
				 WHERE (scope_type = 'ticket' OR entity_table = 'ticket_tasks') AND entity_pk_1 = ?`,
				[ticketId],
			);
			for (const mr of migRows) {
				if (mr.src_path?.trim()) {
					pushFileTombstone(mr.src_host, mr.src_path);
					pushTicketDirTombstone(mr.src_host, mr.src_path);
				} else if (mr.src_host?.trim()) {
					pushTicketDirTombstone(mr.src_host);
				}
				if (mr.dst_path?.trim()) {
					pushFileTombstone(mr.dst_host, mr.dst_path);
					pushTicketDirTombstone(mr.dst_host, mr.dst_path);
				} else if (mr.dst_host?.trim()) {
					pushTicketDirTombstone(mr.dst_host);
				}
			}

			const now = Date.now();
			await tx.run(
				`UPDATE storage_migration_items
				 SET phase = 'skipped', last_error = NULL, updated_at = ?
				 WHERE (scope_type = 'ticket' OR entity_table = 'ticket_tasks') AND entity_pk_1 = ? AND phase IN ('pending', 'failed')`,
				[now, ticketId],
			);
			await tx.run(
				`UPDATE tickets SET status = 'destroyed', holder_id = NULL, destroyed_at = ?, updated_at = ? WHERE ticket_id = ?`,
				[now, now, ticketId],
			);
			await tx.run(`DELETE FROM ticket_delivery_outbox WHERE ticket_id = ?`, [ticketId]);
		});

		await this.storageEngine.enqueueTombstones(tombstones);
		this.fireDidCancelOutboxTickets({ projectId: caller.projectId, ticketIds: [ticketId] });
		this.fireDidChangeProject(caller.projectId);
		return { ok: true, ticket_id: ticketId };
	}

	// =========================================================================
	// CLI Orchestration Implementations
	// =========================================================================

	private async handleCliAgentList(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['depth', 'depts']);
		let maxDepth = Number.POSITIVE_INFINITY;
		if (args.depth !== undefined) {
			const d = typeof args.depth === 'number'
				? args.depth
				: (typeof args.depth === 'string' && /^[1-9]\d*$/.test(args.depth.trim()) ? Number.parseInt(args.depth.trim(), 10) : NaN);
			if (!Number.isInteger(d) || d < 1) {
				throw new AdeError('ERR_INVALID_ARGS', '--depth 必须为正整数');
			}
			maxDepth = d;
		}
		const deptFilter = parseTagListInput(args.depts);

		return pdb.withLock(async runner => {
			await this.verifyActiveCallerInRunner(runner, caller);
			const state = await this.loadPolicyStateInTx(runner, caller.projectId);
			const rawRows = await runner.all<IRawAgentRow>(`SELECT * FROM agents ORDER BY level ASC, created_at ASC`);
			const rowById = new Map(rawRows.map(r => [r.agent_id, r]));
			const childrenByParent = new Map<string, IRawAgentRow[]>();
			for (const r of rawRows) {
				if (r.parent_id) {
					let arr = childrenByParent.get(r.parent_id);
					if (!arr) {
						arr = [];
						childrenByParent.set(r.parent_id, arr);
					}
					arr.push(r);
				}
			}

			const out: Array<{ level: string; agent_id: string; name: string; role_summary: string }> = [];
			const queue: Array<{ id: string; dist: number }> = [{ id: caller.agentId, dist: 0 }];
			const visited = new Set<string>([caller.agentId]);

			while (queue.length > 0) {
				const cur = queue.shift()!;
				if (cur.dist >= maxDepth) {
					continue;
				}
				const kids = childrenByParent.get(cur.id) ?? [];
				for (const child of kids) {
					if (visited.has(child.agent_id)) {
						continue;
					}
					visited.add(child.agent_id);
					queue.push({ id: child.agent_id, dist: cur.dist + 1 });
					if (!canCallerManageTarget(state, caller.agentId, child.agent_id)) {
						continue;
					}
					if (deptFilter.length > 0) {
						const effSet = new Set(getEffectiveDeptIds(state, child.agent_id));
						if (!deptFilter.every(d => effSet.has(d))) {
							continue;
						}
					}
					const row = rowById.get(child.agent_id)!;
					out.push({
						level: formatLevelLabel(row.level),
						agent_id: row.agent_id,
						name: row.name,
						role_summary: row.role_summary,
					});
				}
			}
			return { ok: true, agents: out };
		});
	}

	private async handleCliAgentCreate(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['host', 'engine', 'model', 'effort', 'level', 'name', 'role', 'parent']);
		const hostRaw = requireNonEmptyString(args.host, '--host');
		const engine = normalizeAdeEngineId(requireNonEmptyString(args.engine, '--engine'));
		const model = requireNonEmptyString(args.model, '--model');
		const effort = requireNonEmptyString(args.effort, '--effort').toLowerCase();
		const level = parseLevelInput(args.level as string | number);
		const name = requireNonEmptyString(args.name, '--name');
		const role = requireNonEmptyString(args.role, '--role');
		const parentId = args.parent !== undefined ? requireNonEmptyString(args.parent, '--parent') : caller.agentId;

		const canonicalHost = await this.validateAndCanonicalizeHost(hostRaw, pdb);
		this.assertNotShuttingDown();
		if (this.isProjectDeletingOrRemoved(caller.projectId)) {
			throw new AdeError('ERR_UNAUTHORIZED', '所属项目不存在或已被删除');
		}
		const meta = this.engineProber.getDefaultMetadata(engine);
		if (!this.engineProber.isCompatibleEffort(engine, effort)) {
			throw new AdeError('ERR_INVALID_ARGS', `引擎 ${engine} 不支持思考程度档位 "${effort}"（可选: ${meta.efforts.join(', ')}）`);
		}

		const result = await pdb.transaction(async tx => {
			await this.verifyActiveCallerInRunner(tx, caller);
			const state = await this.loadPolicyStateInTx(tx, caller.projectId);
			if (parentId !== caller.agentId) {
				assertCallerManagesTarget(state, caller.agentId, parentId);
			}
			const parentNode = state.agents[parentId];
			if (!parentNode) {
				throw new AdeError('ERR_AGENT_NOT_FOUND', '指定的上级节点不存在');
			}
			if (level <= parentNode.level) {
				throw new AdeError('ERR_FORBIDDEN_HIERARCHY', `新员工职级 L${level} 必须严格低于上级 L${parentNode.level}`);
			}

			const agentId = genId(`agent_l${level}`);
			const now = Date.now();
			const sessionResource = this.buildDeterministicSessionResource(engine, caller.projectId, agentId);
			await tx.run(
				`INSERT INTO agents
				 (agent_id, project_id, level, is_top_role, parent_id, name, role_summary, host, engine, model, effort,
				  session_phase, session_started, excluded_dept_ids, session_resource, last_read_doc_rev, token_gen, created_at, updated_at)
				 VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'unstarted', 0, '[]', ?, 0, 1, ?, ?)`,
				[agentId, caller.projectId, level, parentId, name, role, canonicalHost, engine, model, effort, sessionResource, now, now],
			);
			return {
				ok: true,
				agent_id: agentId,
				level: formatLevelLabel(level),
				parent_id: parentId,
			};
		});

		await this.syncProjectWorkspaceRoutingRules(caller.projectId).catch(() => undefined);
		this.fireDidChangeProject(caller.projectId);
		return result;
	}

	private async handleCliAgentEdit(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['agentId', 'name', 'role', 'engine', 'model', 'effort']);
		const targetId = requireNonEmptyString(args.agentId, 'agent_id');
		const hasEdit = ['name', 'role', 'engine', 'model', 'effort'].some(k => args[k] !== undefined);
		if (!hasEdit) {
			throw new AdeError('ERR_INVALID_ARGS', 'ade_agent_edit 至少需传入一项待修改属性');
		}

		let engineChangedOuter = false;
		await pdb.transaction(async tx => {
			await this.verifyActiveCallerInRunner(tx, caller);
			const state = await this.loadPolicyStateInTx(tx, caller.projectId);
			assertCallerManagesTarget(state, caller.agentId, targetId);
			const cur = await tx.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [targetId]);
			if (!cur) {
				throw new AdeError('ERR_AGENT_NOT_FOUND', '指定的员工节点不存在');
			}

			let nextEngine = cur.engine;
			const nextModel = args.model !== undefined ? requireNonEmptyString(args.model, '--model') : cur.model;
			let nextEffort = args.effort !== undefined ? requireNonEmptyString(args.effort, '--effort').toLowerCase() : cur.effort.toLowerCase();

			if (args.engine !== undefined) {
				if (cur.session_started === 1) {
					throw new AdeError('ERR_ENGINE_LOCKED', '目标员工会话已激活产生上下文，禁止修改 engine');
				}
				if (args.model === undefined) {
					throw new AdeError('ERR_INVALID_ARGS', '修改 --engine 时必须同时填入 --model');
				}
				const normEng = normalizeAdeEngineId(requireNonEmptyString(args.engine, '--engine'));
				if (normEng !== cur.engine) {
					nextEngine = normEng;
					const meta = this.engineProber.getDefaultMetadata(nextEngine);
					if (args.effort === undefined && !meta.efforts.includes(nextEffort)) {
						nextEffort = meta.defaultEffort;
					}
				}
			}
			const finalMeta = this.engineProber.getDefaultMetadata(nextEngine);
			if (!this.engineProber.isCompatibleEffort(nextEngine, nextEffort)) {
				throw new AdeError('ERR_INVALID_ARGS', `思考程度 "${nextEffort}" 不受引擎 ${nextEngine} 支持（可选: ${finalMeta.efforts.join(', ')}）`);
			}

			const nextName = args.name !== undefined ? requireNonEmptyString(args.name, '--name') : cur.name;
			const nextRole = args.role !== undefined ? requireNonEmptyString(args.role, '--role') : cur.role_summary;
			const engineChanged = nextEngine !== cur.engine;
			engineChangedOuter = engineChanged;
			const nextSessionRes = engineChanged
				? this.buildDeterministicSessionResource(nextEngine, caller.projectId, cur.agent_id)
				: cur.session_resource;
			const nextTokenGen = engineChanged ? cur.token_gen + 1 : cur.token_gen;

			await tx.run(
				`UPDATE agents
				 SET name = ?, role_summary = ?, engine = ?, model = ?, effort = ?, session_resource = ?, token_gen = ?, updated_at = ?
				 WHERE agent_id = ?`,
				[nextName, nextRole, nextEngine, nextModel, nextEffort, nextSessionRes, nextTokenGen, Date.now(), targetId],
			);
			if (engineChanged) {
				this.controlServer.revokeAgentTokens(caller.projectId, targetId);
				await tx.run(
					`UPDATE ticket_delivery_outbox
					 SET state = 'pending', claimed_by_window_id = NULL, leased_until = NULL, next_retry_at = 0, last_error = NULL
					 WHERE target_agent_id = ? AND state = 'blocked_cli'`,
					[targetId],
				);
			}
		});

		await this.syncProjectWorkspaceRoutingRules(caller.projectId).catch(() => undefined);
		this.fireDidChangeProject(caller.projectId);
		if (engineChangedOuter) {
			this.fireDidEnqueueOutbox({ projectId: caller.projectId, targetAgentId: targetId });
		}
		return { ok: true, agent_id: targetId };
	}

	private async handleCliAgentMove(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['agentId', 'toParent']);
		const agentId = requireNonEmptyString(args.agentId, 'agent_id');
		const newParentId = requireNonEmptyString(args.toParent, '--to-parent');
		let frozenTickets: string[] = [];

		await pdb.transaction(async tx => {
			await this.verifyActiveCallerInRunner(tx, caller);
			const state = await this.loadPolicyStateInTx(tx, caller.projectId);
			applyAgentMove(state, caller.agentId, agentId, newParentId);
			reconcileTopologySideEffects(state);
			frozenTickets = freezeInvalidatedActiveTickets(state);
			await this.persistPolicySideEffectsInTx(tx, state, frozenTickets);
		});

		if (frozenTickets.length > 0) {
			this.fireDidCancelOutboxTickets({ projectId: caller.projectId, ticketIds: frozenTickets });
		}
		this.fireDidChangeProject(caller.projectId);
		return { ok: true, agent_id: agentId, parent_id: newParentId };
	}

	private async handleCliAgentDelete(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['agentId']);
		const targetId = requireNonEmptyString(args.agentId, 'agent_id');
		let frozenTicketIds: string[] = [];
		let deletedRow: IRawAgentRow | undefined;

		await pdb.transaction(async tx => {
			await this.verifyActiveCallerInRunner(tx, caller);
			const state = await this.loadPolicyStateInTx(tx, caller.projectId);
			assertCallerManagesTarget(state, caller.agentId, targetId);

			if (Object.values(state.agents).some(a => a.parent_id === targetId)) {
				throw new AdeError('ERR_HAS_SUBORDINATES', '目标员工仍有下属，请先调用 ade_agent_move 转移下属后再删除');
			}
			if (Object.values(state.departments).some(d => d.root_agent_id === targetId)) {
				throw new AdeError('ERR_IS_DEPT_ROOT', '目标员工是活跃部门根节点，请先删除对应部门');
			}

			const rawTarget = await tx.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [targetId]);
			deletedRow = rawTarget;

			// 100% lossless upward whiteboard ownership transfer!
			transferAgentWhiteboardsOnDelete(state, targetId);

			const now = Date.now();
			if (rawTarget) {
				await tx.run(
					`INSERT OR REPLACE INTO deleted_agents_archive (agent_id, project_id, name, level, role_summary, host, deleted_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[rawTarget.agent_id, caller.projectId, rawTarget.name, rawTarget.level, rawTarget.role_summary, rawTarget.host, now],
				);
			}
			delete state.agents[targetId];
			reconcileTopologySideEffects(state);
			frozenTicketIds = freezeInvalidatedActiveTickets(state);
			await this.persistPolicySideEffectsInTx(tx, state, frozenTicketIds);
			await tx.run(`DELETE FROM agents WHERE agent_id = ?`, [targetId]);
		});

		this.controlServer.revokeAgentTokens(caller.projectId, targetId);
		if (deletedRow) {
			const sshAlias = deletedRow.host !== 'local' ? await this.tryLookupHostAlias(deletedRow.host) : undefined;
			this.fireDidDisposeAgentRuntime({
				projectId: caller.projectId,
				agentId: deletedRow.agent_id,
				host: deletedRow.host,
				sshAlias,
				engine: deletedRow.engine,
				sessionResource: deletedRow.session_resource ?? this.buildDeterministicSessionResource(deletedRow.engine, caller.projectId, deletedRow.agent_id),
			});
		}
		if (frozenTicketIds.length > 0) {
			this.fireDidCancelOutboxTickets({ projectId: caller.projectId, ticketIds: frozenTicketIds });
		}
		this.fireDidChangeProject(caller.projectId);
		return { ok: true, agent_id: targetId, frozen_ticket_ids: frozenTicketIds };
	}

	private async handleCliDeptCreate(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['root', 'name']);
		const rootId = requireNonEmptyString(args.root, '--root');
		const deptName = requireNonEmptyString(args.name, '--name');
		let frozenTickets: string[] = [];

		const res = await pdb.transaction(async tx => {
			await this.verifyActiveCallerInRunner(tx, caller);
			const state = await this.loadPolicyStateInTx(tx, caller.projectId);
			assertCanCreateDepartment(state, caller.agentId, rootId);

			const deptId = genId('dept');
			const now = Date.now();
			state.departments[deptId] = {
				dept_id: deptId,
				project_id: caller.projectId,
				name: deptName,
				root_agent_id: rootId,
				parent_dept_id: null,
				board_permissions: {},
				created_by: caller.agentId,
			};
			recomputeAllParentDeptIds(state);
			const parentDeptId = state.departments[deptId].parent_dept_id;

			await tx.run(
				`INSERT INTO departments (dept_id, project_id, name, root_agent_id, parent_dept_id, board_permissions, created_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
				[deptId, caller.projectId, deptName, rootId, parentDeptId, caller.agentId, now, now],
			);
			reconcileTopologySideEffects(state);
			frozenTickets = freezeInvalidatedActiveTickets(state);
			await this.persistPolicySideEffectsInTx(tx, state, frozenTickets);

			// Exact 3 business fields per Rebuild/orchestration.md (NO name field leaked!)
			return {
				ok: true,
				dept_id: deptId,
				root_agent_id: rootId,
				parent_dept_id: parentDeptId,
			};
		});

		if (frozenTickets.length > 0) {
			this.fireDidCancelOutboxTickets({ projectId: caller.projectId, ticketIds: frozenTickets });
		}
		this.fireDidChangeProject(caller.projectId);
		return res;
	}

	private async handleCliDeptEdit(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['deptId', 'name', 'board', 'perm']);
		const deptId = requireNonEmptyString(args.deptId, 'dept_id');
		const hasBoard = args.board !== undefined;
		const hasPerm = args.perm !== undefined;
		if (hasBoard !== hasPerm) {
			throw new AdeError('ERR_INVALID_ARGS', '--board 与 --perm 必须成对传入');
		}
		if (args.name === undefined && !hasBoard) {
			throw new AdeError('ERR_INVALID_ARGS', 'ade_dept_edit 至少需指定 --name 或 (--board + --perm)');
		}

		await pdb.transaction(async tx => {
			await this.verifyActiveCallerInRunner(tx, caller);
			const state = await this.loadPolicyStateInTx(tx, caller.projectId);
			const dept = state.departments[deptId];
			assertCallerManagesDept(state, caller.agentId, dept);

			if (args.name !== undefined) {
				dept.name = requireNonEmptyString(args.name, '--name');
			}
			if (hasBoard) {
				const boardId = requireNonEmptyString(args.board, '--board');
				const permRaw = requireNonEmptyString(args.perm, '--perm');
				if (permRaw !== 'read' && permRaw !== 'write' && permRaw !== 'read_write') {
					throw new AdeError('ERR_INVALID_ARGS', `--perm 仅支持 read、write 或 read_write`);
				}
				const wb = state.whiteboards[boardId];
				if (!wb || wb.dept_id !== deptId) {
					throw new AdeError('ERR_BOARD_NOT_IN_DEPT', '目标白板尚未划分进该部门');
				}
				dept.board_permissions[boardId] = permRaw;
			}
			await tx.run(
				`UPDATE departments SET name = ?, board_permissions = ?, updated_at = ? WHERE dept_id = ?`,
				[dept.name, JSON.stringify(dept.board_permissions), Date.now(), deptId],
			);
		});

		this.fireDidChangeProject(caller.projectId);
		return { ok: true, dept_id: deptId };
	}

	private async handleCliDeptDelete(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['deptId']);
		const deptId = requireNonEmptyString(args.deptId, 'dept_id');
		let frozenTickets: string[] = [];

		await pdb.transaction(async tx => {
			await this.verifyActiveCallerInRunner(tx, caller);
			const state = await this.loadPolicyStateInTx(tx, caller.projectId);
			const dept = state.departments[deptId];
			assertCanDeleteDept(state, caller.agentId, dept);

			for (const wb of Object.values(state.whiteboards)) {
				if (wb.dept_id === deptId) {
					wb.dept_id = null;
				}
			}
			delete state.departments[deptId];
			for (const ag of Object.values(state.agents)) {
				ag.excluded_dept_ids = ag.excluded_dept_ids.filter(id => id !== deptId);
			}
			await tx.run(`UPDATE whiteboards SET dept_id = NULL, updated_at = ? WHERE dept_id = ?`, [Date.now(), deptId]);
			await tx.run(`DELETE FROM departments WHERE dept_id = ?`, [deptId]);

			recomputeAllParentDeptIds(state);
			reconcileTopologySideEffects(state);
			frozenTickets = freezeInvalidatedActiveTickets(state);
			await this.persistPolicySideEffectsInTx(tx, state, frozenTickets);
		});

		if (frozenTickets.length > 0) {
			this.fireDidCancelOutboxTickets({ projectId: caller.projectId, ticketIds: frozenTickets });
		}
		this.fireDidChangeProject(caller.projectId);
		return { ok: true, dept_id: deptId };
	}

	private async handleCliDeptMember(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['deptId', 'agent', 'action']);
		const deptId = requireNonEmptyString(args.deptId, 'dept_id');
		const agentId = requireNonEmptyString(args.agent, '--agent');
		const act = requireNonEmptyString(args.action, '--action');
		if (act !== 'out' && act !== 'in') {
			throw new AdeError('ERR_INVALID_ARGS', '--action 仅支持 out 或 in');
		}
		let frozenTickets: string[] = [];

		await pdb.transaction(async tx => {
			await this.verifyActiveCallerInRunner(tx, caller);
			const state = await this.loadPolicyStateInTx(tx, caller.projectId);
			applyDeptMemberAction(state, caller.agentId, deptId, agentId, act);
			reconcileTopologySideEffects(state);
			frozenTickets = freezeInvalidatedActiveTickets(state);
			await this.persistPolicySideEffectsInTx(tx, state, frozenTickets);
		});

		if (frozenTickets.length > 0) {
			this.fireDidCancelOutboxTickets({ projectId: caller.projectId, ticketIds: frozenTickets });
		}
		this.fireDidChangeProject(caller.projectId);
		return { ok: true, dept_id: deptId, agent_id: agentId, action: act };
	}

	private async handleCliDeptMembers(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['deptId', 'depts']);
		const filterDepts = parseTagListInput(args.depts);

		return pdb.withLock(async runner => {
			await this.verifyActiveCallerInRunner(runner, caller);
			const state = await this.loadPolicyStateInTx(runner, caller.projectId);
			let deptId = typeof args.deptId === 'string' && args.deptId.trim() ? args.deptId.trim() : undefined;
			if (!deptId) {
				const callerEff = getEffectiveDeptIds(state, caller.agentId);
				deptId = callerEff.at(-1);
				if (!deptId) {
					throw new AdeError('ERR_INVALID_ARGS', '当前调用者不属于任何部门，请显式传入 <dept_id>');
				}
			}
			const dept = state.departments[deptId];
			if (!dept) {
				throw new AdeError('ERR_INVALID_ARGS', `指定的部门不存在: ${deptId}`);
			}
			const callerEffSet = new Set(getEffectiveDeptIds(state, caller.agentId));
			if (!callerEffSet.has(deptId) && !canCallerManageDept(state, caller.agentId, dept)) {
				throw new AdeError('ERR_CROSS_DEPT', '无权查看其他部门成员列表');
			}

			const allAgents = await runner.all<IRawAgentRow>(`SELECT * FROM agents ORDER BY level ASC, created_at ASC`);
			const members: Array<{ level: string; agent_id: string; name: string; role_summary: string }> = [];
			for (const row of allAgents) {
				const eff = new Set(getEffectiveDeptIds(state, row.agent_id));
				if (!eff.has(deptId)) {
					continue;
				}
				if (filterDepts.length > 0 && !filterDepts.every(d => eff.has(d))) {
					continue;
				}
				members.push({
					level: formatLevelLabel(row.level),
					agent_id: row.agent_id,
					name: row.name,
					role_summary: row.role_summary,
				});
			}
			return { ok: true, dept_id: deptId, members };
		});
	}

	private async handleCliDeptInfo(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['agent']);
		return pdb.withLock(async runner => {
			await this.verifyActiveCallerInRunner(runner, caller);
			const state = await this.loadPolicyStateInTx(runner, caller.projectId);
			const targetId = args.agent !== undefined ? requireNonEmptyString(args.agent, '--agent') : caller.agentId;
			if (targetId !== caller.agentId) {
				assertCallerManagesTarget(state, caller.agentId, targetId);
			}
			const effDeptIds = getEffectiveDeptIds(state, targetId);
			const departments = effDeptIds
				.map(id => state.departments[id])
				.filter((d): d is IAdePolicyDepartment => Boolean(d))
				.map(d => ({
					dept_id: d.dept_id,
					name: d.name,
					root_agent_id: d.root_agent_id,
					parent_dept_id: d.parent_dept_id,
				}));
			return { ok: true, agent_id: targetId, departments };
		});
	}

	private async handleCliWbGrant(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['boardId', 'to', 'perm']);
		const boardId = requireNonEmptyString(args.boardId, 'board_id');
		const toId = requireNonEmptyString(args.to, '--to');
		const perm = requireNonEmptyString(args.perm, '--perm');
		if (perm !== 'read' && perm !== 'write' && perm !== 'read_write' && perm !== 'none') {
			throw new AdeError('ERR_INVALID_ARGS', '--perm 仅支持 read、write、read_write 或 none');
		}
		if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
			throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
		}

		await pdb.transaction(async tx => {
			await this.verifyActiveCallerInRunner(tx, caller);
			if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
				throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
			}
			const state = await this.loadPolicyStateInTx(tx, caller.projectId);
			// Command #25 (`plan.md` §4.4 #2 & §5.4 #25): verify ERR_BOARD_NOT_FOUND & ERR_BOARD_NOT_OWNER (`owner_grant`);
			// `--perm !== 'none'` strictly enforces `assertCallerManagesTarget(caller, to)`, whereas `--perm === 'none'`
			// idempotently revokes any grant as long as `caller === board.owner_id`.
			assertWhiteboardAccess(state, boardId, caller.agentId, 'owner_grant');

			if (perm === 'none') {
				await tx.run(`DELETE FROM board_grants WHERE board_id = ? AND agent_id = ?`, [boardId, toId]);
			} else {
				assertCallerManagesTarget(state, caller.agentId, toId);
				await tx.run(
					`INSERT OR REPLACE INTO board_grants (board_id, agent_id, permission, granted_by, updated_at)
					 VALUES (?, ?, ?, ?, ?)`,
					[boardId, toId, perm, caller.agentId, Date.now()],
				);
			}
		});

		this.fireDidChangeProject(caller.projectId);
		return { ok: true, board_id: boardId, to: toId, perm };
	}

	// =========================================================================
	// CLI Whiteboard Implementations (20 commands; 17 return top-level `unread_count`)
	// =========================================================================

	private async handleCliWhiteboardCommand(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		command: AdeCliCommandName,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		switch (command) {
			case 'ade_wb_list': {
				assertAllowedArgKeys(args, []);
				return pdb.withLock(async runner => {
					await this.verifyActiveCallerInRunner(runner, caller);
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					const rows = await runner.all<{ board_id: string; name: string }>(`SELECT board_id, name FROM whiteboards ORDER BY created_at ASC`);
					const boards = rows.filter(r => canReadBoardPerm(resolveWhiteboardPermission(state, r.board_id, caller.agentId)));
					return { ok: true, boards };
				});
			}

			case 'ade_wb_my_perm': {
				assertAllowedArgKeys(args, ['boardId']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				return pdb.withLock(async runner => {
					await this.verifyActiveCallerInRunner(runner, caller);
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					const { perm } = assertWhiteboardAccess(state, boardId, caller.agentId, 'read');
					const unread_count = await this.getBoardUnreadCountInTx(runner, boardId, caller.agentId);
					return { ok: true, board_id: boardId, permission: perm, unread_count };
				});
			}

			case 'ade_wb_members': {
				assertAllowedArgKeys(args, ['boardId']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				return pdb.withLock(async runner => {
					await this.verifyActiveCallerInRunner(runner, caller);
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					assertWhiteboardAccess(state, boardId, caller.agentId, 'read');
					const agentRows = await runner.all<IRawAgentRow>(`SELECT * FROM agents ORDER BY level ASC, created_at ASC`);
					const members = this.computeBoardMembersList(state, agentRows.map(r => this.mapAgentRow(r)), boardId);
					const unread_count = await this.getBoardUnreadCountInTx(runner, boardId, caller.agentId);
					return { ok: true, board_id: boardId, unread_count, members };
				});
			}

			case 'ade_wb_create': {
				assertAllowedArgKeys(args, ['name', 'dept', 'host', 'tags']);
				const name = requireNonEmptyString(args.name, '--name');
				const deptId = args.dept !== undefined ? requireNonEmptyString(args.dept, '--dept') : null;
				const tags = parseTagListInput(args.tags);
				const callerRow = await this.verifyActiveCallerNode(pdb, caller);
				const storageHost = args.host !== undefined
					? await this.validateAndCanonicalizeHost(requireNonEmptyString(args.host, '--host'), pdb)
					: callerRow.host;
				this.assertNotShuttingDown();
				if (this.isProjectDeletingOrRemoved(caller.projectId)) {
					throw new AdeError('ERR_UNAUTHORIZED', '所属项目不存在或已被删除');
				}

				const created = await pdb.transaction(async tx => {
					await this.verifyActiveCallerInRunner(tx, caller);
					const state = await this.loadPolicyStateInTx(tx, caller.projectId);
					if (deptId) {
						const dept = state.departments[deptId];
						assertCallerManagesDept(state, caller.agentId, dept);
						const dup = await tx.get<{ board_id: string }>(`SELECT board_id FROM whiteboards WHERE dept_id = ?`, [deptId]);
						if (dup) {
							throw new AdeError('ERR_DEPT_BOARD_EXISTS', '该部门已存在绑定白板（违反一部门一板制）');
						}
					}
					const boardId = genId('wb');
					const now = Date.now();
					await tx.run(
						`INSERT INTO whiteboards
						 (board_id, project_id, name, owner_id, dept_id, storage_host, tag_categories, migration_epoch, migration_state, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'idle', ?, ?)`,
						[boardId, caller.projectId, name, caller.agentId, deptId, storageHost, JSON.stringify(tags), now, now],
					);
					if (deptId) {
						const deptRow = await tx.get<IRawDepartmentRow>(`SELECT * FROM departments WHERE dept_id = ?`, [deptId]);
						const perms = parseBoardPermsJson(deptRow?.board_permissions);
						perms[boardId] = 'read_write';
						await tx.run(`UPDATE departments SET board_permissions = ?, updated_at = ? WHERE dept_id = ?`, [JSON.stringify(perms), now, deptId]);
					}
					return { ok: true, board_id: boardId, storage_host: storageHost, unread_count: 0 };
				});

				this.fireDidChangeProject(caller.projectId);
				return created;
			}

			case 'ade_wb_config': {
				assertAllowedArgKeys(args, ['boardId', 'name', 'host']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				if (args.name === undefined && args.host === undefined) {
					throw new AdeError('ERR_INVALID_ARGS', 'ade_wb_config 至少需传入 --name 或 --host');
				}
				const rawNameArg = args.name !== undefined ? requireNonEmptyString(args.name, '--name') : undefined;
				const rawHostArg = args.host !== undefined ? requireNonEmptyString(args.host, '--host') : undefined;
				if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
					throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
				}
				if (rawHostArg !== undefined) {
					await pdb.withLock(async runner => {
						await this.verifyActiveCallerInRunner(runner, caller);
						const state = await this.loadPolicyStateInTx(runner, caller.projectId);
						assertWhiteboardAccess(state, boardId, caller.agentId, 'owner_wb');
					});
				}
				const canonicalHostArg = rawHostArg !== undefined
					? await this.validateAndCanonicalizeHost(rawHostArg, pdb)
					: undefined;

				const staleTombstones: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> = [];

				const out = await pdb.transaction(async tx => {
					await this.verifyActiveCallerInRunner(tx, caller);
					if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
						throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
					}
					const state = await this.loadPolicyStateInTx(tx, caller.projectId);
					assertWhiteboardAccess(state, boardId, caller.agentId, 'owner_wb');
					const wb = await tx.get<IRawWhiteboardRow>(`SELECT * FROM whiteboards WHERE board_id = ?`, [boardId]);
					const nextName = rawNameArg !== undefined ? rawNameArg : wb!.name;
					let nextHost = wb!.storage_host;
					let nextEpoch = wb!.migration_epoch;
					let nextState: AdeMigrationState = wb!.migration_state;
					if (canonicalHostArg !== undefined) {
						// `plan.md` §5.5 #30 & §6.3 #2: CLI `ade_wb_config --host` switches default `storage_host` instantly
						// WITHOUT scanning or migrating historical items (`runCasMigrationLoop` is NEVER triggered), while
						// bumping `migration_epoch`, skipping unfinished prior-epoch migration items, and resetting `migration_state = 'idle'`.
						nextHost = canonicalHostArg;
						nextEpoch = wb!.migration_epoch + 1;
						nextState = 'idle';
						const nowForSkip = Date.now();
						const oldUnfinished = await tx.all<{ dst_host: string | null; dst_path: string | null }>(
							`SELECT dst_host, dst_path
							 FROM storage_migration_items
							 WHERE scope_type = 'whiteboard' AND scope_id = ? AND epoch < ? AND phase IN ('pending', 'copied', 'failed') AND dst_path != ''`,
							[boardId, nextEpoch],
						);
						for (const m of oldUnfinished) {
							if (m.dst_path) {
								staleTombstones.push({
									projectId: caller.projectId,
									storageHost: (m.dst_host || 'local').trim() || 'local',
									storagePath: m.dst_path,
								});
							}
						}
						await tx.run(
							`UPDATE storage_migration_items
							 SET phase = 'skipped', last_error = NULL, updated_at = ?
							 WHERE scope_type = 'whiteboard' AND scope_id = ? AND epoch < ? AND phase IN ('pending', 'copied', 'failed')`,
							[nowForSkip, boardId, nextEpoch],
						);
					}
					const now = Date.now();
					await tx.run(
						`UPDATE whiteboards
						 SET name = ?, storage_host = ?, migration_epoch = ?, migration_state = ?, updated_at = ?
						 WHERE board_id = ?`,
						[nextName, nextHost, nextEpoch, nextState, now, boardId],
					);
					const unread_count = await this.getBoardUnreadCountInTx(tx, boardId, caller.agentId);
					return { ok: true, board_id: boardId, storage_host: nextHost, unread_count };
				});

				if (staleTombstones.length > 0) {
					await this.storageEngine.enqueueTombstones(staleTombstones).catch(() => undefined);
				}
				if (this.shuttingDown || this._isDisposed) {
					throw new AdeError('ERR_UNAUTHORIZED', '控制中心正在关停，拒绝新命令请求');
				}

				this.fireDidChangeProject(caller.projectId);
				return out;
			}

			case 'ade_wb_delete': {
				assertAllowedArgKeys(args, ['boardId']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				await pdb.withLock(async runner => {
					await this.verifyActiveCallerInRunner(runner, caller);
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					assertWhiteboardAccess(state, boardId, caller.agentId, 'owner_wb');
				});
				const delKey = this.makeBoardDeleteKey(caller.projectId, boardId);
				this.deletingWhiteboards.add(delKey);
				try {
					await this.drainWhiteboardMigrationsForDelete(caller.projectId, boardId);
					const tombstones: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> = [];
					await pdb.transaction(async tx => {
						await this.verifyActiveCallerInRunner(tx, caller);
						const state = await this.loadPolicyStateInTx(tx, caller.projectId);
						assertWhiteboardAccess(state, boardId, caller.agentId, 'owner_wb');
						await this.collectAndDeleteWhiteboardInTx(tx, caller.projectId, boardId, tombstones);
					});
					await this.storageEngine.enqueueTombstones(tombstones);
					this.fireDidChangeProject(caller.projectId);
					return { ok: true, board_id: boardId };
				} finally {
					this.deletingWhiteboards.delete(delKey);
				}
			}

			case 'ade_wb_tags': {
				assertAllowedArgKeys(args, ['boardId']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				return pdb.withLock(async runner => {
					await this.verifyActiveCallerInRunner(runner, caller);
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					assertWhiteboardAccess(state, boardId, caller.agentId, 'read');
					const wb = await runner.get<{ tag_categories: string }>(`SELECT tag_categories FROM whiteboards WHERE board_id = ?`, [boardId]);
					const unread_count = await this.getBoardUnreadCountInTx(runner, boardId, caller.agentId);
					return { ok: true, board_id: boardId, tags: parseJsonArrayStrings(wb?.tag_categories), unread_count };
				});
			}

			case 'ade_wb_tag_manage': {
				assertAllowedArgKeys(args, ['boardId', 'action', 'tags']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				const action = requireNonEmptyString(args.action, '--action');
				if (action !== 'add' && action !== 'remove') {
					throw new AdeError('ERR_INVALID_ARGS', '--action 仅支持 add 或 remove');
				}
				const inputTags = parseTagListInput(args.tags);
				if (inputTags.length === 0) {
					throw new AdeError('ERR_INVALID_ARGS', '必须提供非空的 --tags');
				}

				const out = await pdb.transaction(async tx => {
					await this.verifyActiveCallerInRunner(tx, caller);
					const state = await this.loadPolicyStateInTx(tx, caller.projectId);
					assertWhiteboardAccess(state, boardId, caller.agentId, 'owner_wb');
					const wb = await tx.get<{ tag_categories: string }>(`SELECT tag_categories FROM whiteboards WHERE board_id = ?`, [boardId]);
					let tags = parseJsonArrayStrings(wb?.tag_categories);
					if (action === 'add') {
						tags = Array.from(new Set([...tags, ...inputTags]));
					} else {
						const rem = new Set(inputTags);
						tags = tags.filter(t => !rem.has(t));
						await this.stripRemovedTagsFromBoardItemsInTx(tx, boardId, rem);
					}
					await tx.run(`UPDATE whiteboards SET tag_categories = ?, updated_at = ? WHERE board_id = ?`, [JSON.stringify(tags), Date.now(), boardId]);
					const unread_count = await this.getBoardUnreadCountInTx(tx, boardId, caller.agentId);
					return { ok: true, board_id: boardId, tags, unread_count };
				});

				this.fireDidChangeProject(caller.projectId);
				return out;
			}

			case 'ade_wb_post_msg': {
				assertAllowedArgKeys(args, ['boardId', 'summary', 'stars', 'tags', 'detail', 'detailFile', 'detailTempFile']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				const summary = requireNonEmptyString(args.summary, '--summary');
				const stars = parseStarsValue(args.stars);
				const tags = parseTagListInput(args.tags);
				const detailSpec = await this.resolveDetailInputSpec(args);
				if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
					throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
				}

				const pre = await pdb.withLock(async runner => {
					const callerRow = await this.verifyActiveCallerInRunner(runner, caller);
					if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
						throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
					}
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					assertWhiteboardAccess(state, boardId, caller.agentId, 'write');
					const wb = await runner.get<IRawWhiteboardRow>(`SELECT * FROM whiteboards WHERE board_id = ?`, [boardId]);
					const allowedTags = new Set(parseJsonArrayStrings(wb!.tag_categories));
					for (const t of tags) {
						if (!allowedTags.has(t)) {
							throw new AdeError('ERR_INVALID_TAG', `未定义的标签类别: ${t}`);
						}
					}
					return { callerHost: callerRow.host, storageHost: wb!.storage_host };
				});

				const itemId = genId('itm');
				let storedPtr: { blob_id: string; storage_host: string; storage_path: string; sha256: string; size_bytes: number } | undefined;
				let uploadedStorageHost: string | undefined;
				if (detailSpec.kind === 'inline') {
					storedPtr = await this.storageEngine.storeTextBlob({
						targetStorageHost: pre.storageHost,
						relSubdir: `${caller.projectId}_${boardId}`,
						filePrefix: `msg_${itemId}`,
						text: detailSpec.text,
					});
					uploadedStorageHost = storedPtr.storage_host;
				} else if (detailSpec.kind === 'file') {
					const res = await this.storageEngine.storeFileFromHost({
						sourceHost: pre.callerHost,
						sourcePath: detailSpec.filePath,
						deleteSourceTempAfter: detailSpec.isTempBypass,
						targetStorageHost: pre.storageHost,
						relSubdir: `${caller.projectId}_${boardId}`,
						filePrefix: `msg_${itemId}`,
					});
					uploadedStorageHost = res.storage_host;
					if (res.size_bytes > 0) {
						storedPtr = res;
					} else {
						await this.storageEngine.enqueueTombstones([{ projectId: caller.projectId, storageHost: res.storage_host, storagePath: res.storage_path }]);
					}
				}

				try {
					const out = await pdb.transaction(async tx => {
						await this.verifyActiveCallerInRunner(tx, caller);
						if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
							throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
						}
						const state = await this.loadPolicyStateInTx(tx, caller.projectId);
						assertWhiteboardAccess(state, boardId, caller.agentId, 'write');
						const wb = await tx.get<IRawWhiteboardRow>(`SELECT * FROM whiteboards WHERE board_id = ?`, [boardId]);
						const allowedTags = new Set(parseJsonArrayStrings(wb!.tag_categories));
						for (const t of tags) {
							if (!allowedTags.has(t)) {
								throw new AdeError('ERR_INVALID_TAG', `未定义的标签类别: ${t}`);
							}
						}
						const now = Date.now();
						await tx.run(
							`INSERT INTO whiteboard_items
							 (item_id, board_id, item_type, author_id, summary, stars, tags, is_pinned, has_detail,
							  file_filename, file_size, detail_size, blob_id, storage_host, storage_path, sha256, content_rev, created_at, updated_at)
							 VALUES (?, ?, 'msg', ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, ?, ?, ?, 1, ?, ?)`,
							[
								itemId, boardId, caller.agentId, summary, stars, JSON.stringify(tags),
								storedPtr ? 1 : 0, storedPtr?.size_bytes ?? null, storedPtr?.blob_id ?? null, storedPtr?.storage_host ?? null,
								storedPtr?.storage_path ?? null, storedPtr?.sha256 ?? null, now, now,
							],
						);
						const unread_count = await this.getBoardUnreadCountInTx(tx, boardId, caller.agentId);
						return { ok: true, board_id: boardId, item_id: itemId, unread_count };
					});
					this.fireDidChangeProject(caller.projectId);
					return out;
				} catch (err) {
					const cleanupTombstones = this.buildBoardUploadCleanupTombstones(
						caller.projectId,
						boardId,
						storedPtr?.storage_host ?? uploadedStorageHost,
						storedPtr?.storage_path,
						err,
					);
					if (cleanupTombstones.length > 0) {
						await this.storageEngine.enqueueTombstones(cleanupTombstones).catch(() => undefined);
					}
					throw err;
				}
			}

			case 'ade_wb_upload_file': {
				assertAllowedArgKeys(args, ['boardId', 'file', 'summary', 'stars', 'tags']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				const filePath = requireNonEmptyString(args.file, '--file');
				const summary = requireNonEmptyString(args.summary, '--summary');
				const stars = parseStarsValue(args.stars);
				const tags = parseTagListInput(args.tags);
				if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
					throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
				}

				const pre = await pdb.withLock(async runner => {
					const callerRow = await this.verifyActiveCallerInRunner(runner, caller);
					if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
						throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
					}
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					assertWhiteboardAccess(state, boardId, caller.agentId, 'write');
					const wb = await runner.get<IRawWhiteboardRow>(`SELECT * FROM whiteboards WHERE board_id = ?`, [boardId]);
					const allowedTags = new Set(parseJsonArrayStrings(wb!.tag_categories));
					for (const t of tags) {
						if (!allowedTags.has(t)) {
							throw new AdeError('ERR_INVALID_TAG', `未定义的标签类别: ${t}`);
						}
					}
					return { callerHost: callerRow.host, storageHost: wb!.storage_host };
				});

				const itemId = genId('itm');
				const stored = await this.storageEngine.storeFileFromHost({
					sourceHost: pre.callerHost,
				sourcePath: filePath,
					targetStorageHost: pre.storageHost,
					relSubdir: `${caller.projectId}_${boardId}`,
					filePrefix: `file_${itemId}`,
					displayFilename: path.posix.basename(filePath.replace(/\\/g, '/')),
				});

				try {
					const out = await pdb.transaction(async tx => {
						await this.verifyActiveCallerInRunner(tx, caller);
						if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
							throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
						}
						const state = await this.loadPolicyStateInTx(tx, caller.projectId);
						assertWhiteboardAccess(state, boardId, caller.agentId, 'write');
						const wb = await tx.get<IRawWhiteboardRow>(`SELECT * FROM whiteboards WHERE board_id = ?`, [boardId]);
						const allowedTags = new Set(parseJsonArrayStrings(wb!.tag_categories));
						for (const t of tags) {
							if (!allowedTags.has(t)) {
								throw new AdeError('ERR_INVALID_TAG', `未定义的标签类别: ${t}`);
							}
						}
						const now = Date.now();
						await tx.run(
							`INSERT INTO whiteboard_items
							 (item_id, board_id, item_type, author_id, summary, stars, tags, is_pinned, has_detail,
							  file_filename, file_size, detail_size, blob_id, storage_host, storage_path, sha256, content_rev, created_at, updated_at)
							 VALUES (?, ?, 'file', ?, ?, ?, ?, 0, 0, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?)`,
							[
								itemId, boardId, caller.agentId, summary, stars, JSON.stringify(tags),
								stored.filename, stored.size_bytes, stored.blob_id, stored.storage_host,
								stored.storage_path, stored.sha256, now, now,
							],
						);
						const unread_count = await this.getBoardUnreadCountInTx(tx, boardId, caller.agentId);
						return { ok: true, board_id: boardId, item_id: itemId, unread_count };
					});
					this.fireDidChangeProject(caller.projectId);
					return out;
				} catch (err) {
					const cleanupTombstones = this.buildBoardUploadCleanupTombstones(
						caller.projectId,
						boardId,
						stored.storage_host,
						stored.storage_path,
						err,
					);
					if (cleanupTombstones.length > 0) {
						await this.storageEngine.enqueueTombstones(cleanupTombstones).catch(() => undefined);
					}
					throw err;
				}
			}

			case 'ade_wb_items': {
				assertAllowedArgKeys(args, ['boardId', 'sort', 'limit', 'author', 'tag', 'type', 'stars']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				const sortRaw = args.sort === undefined ? 'time' : String(args.sort).trim();
				if (sortRaw !== 'time' && sortRaw !== 'stars') {
					throw new AdeError('ERR_INVALID_ARGS', '--sort 仅支持 time 或 stars');
				}
				const typeRaw = args.type === undefined ? 'all' : String(args.type).trim();
				if (typeRaw !== 'all' && typeRaw !== 'msg' && typeRaw !== 'file') {
					throw new AdeError('ERR_INVALID_ARGS', '--type 仅支持 all、msg 或 file');
				}
				let limit: number | undefined;
				if (args.limit !== undefined) {
					const lim = typeof args.limit === 'number'
						? args.limit
						: (typeof args.limit === 'string' && /^[1-9]\d*$/.test(args.limit.trim()) ? Number.parseInt(args.limit.trim(), 10) : NaN);
					if (!Number.isInteger(lim) || lim < 1) {
						throw new AdeError('ERR_INVALID_ARGS', '--limit 必须为正整数');
					}
					limit = lim;
				}
				parseStarsFilterRange(args.stars);

				return pdb.withLock(async runner => {
					await this.verifyActiveCallerInRunner(runner, caller);
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					assertWhiteboardAccess(state, boardId, caller.agentId, 'read');
					const items = await this.queryBoardItemsFiltered(runner, boardId, {
						sort: sortRaw,
						limit,
						author: typeof args.author === 'string' ? args.author.trim() : undefined,
						tag: typeof args.tag === 'string' ? args.tag.trim() : undefined,
						type: typeRaw,
						stars: args.stars !== undefined ? String(args.stars) : undefined,
					});
					const unread_count = await this.getBoardUnreadCountInTx(runner, boardId, caller.agentId);
					return { ok: true, board_id: boardId, unread_count, items };
				});
			}

			case 'ade_wb_get_msg': {
				assertAllowedArgKeys(args, ['boardId', 'itemId']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				const itemId = requireNonEmptyString(args.itemId, 'item_id');

				let ptr!: { storage_host: string; storage_path: string; size_bytes: number; sha256: string };
				let unreadCount = 0;
				let unpin!: () => void;

				await pdb.withLock(async runner => {
					await this.verifyActiveCallerInRunner(runner, caller);
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					// Mandatory order: check board existence & read access BEFORE querying itemId!
					assertWhiteboardAccess(state, boardId, caller.agentId, 'read');

					const item = await runner.get<{
						item_type: 'msg' | 'file';
						has_detail: number;
						detail_size: number | null;
						storage_host: string | null;
						storage_path: string | null;
						sha256: string | null;
					}>(`SELECT item_type, has_detail, detail_size, storage_host, storage_path, sha256 FROM whiteboard_items WHERE board_id = ? AND item_id = ?`, [boardId, itemId]);
					if (!item) {
						throw new AdeError('ERR_INVALID_ARGS', '指定的 item_id 不存在');
					}
					if (item.item_type === 'file') {
						throw new AdeError('ERR_FILE_NOT_READABLE', '文件条目不支持在线读取内容，请调用 ade_wb_download 下载');
					}
					if (item.has_detail !== 1 || !item.storage_path) {
						throw new AdeError('ERR_DETAIL_NOT_FOUND', '该消息条目没有附加详细内容');
					}
					const host = item.storage_host || 'local';
					unpin = this.storageEngine.pinBlobForRead(host, item.storage_path);
					ptr = { storage_host: host, storage_path: item.storage_path, size_bytes: Number(item.detail_size ?? 0), sha256: item.sha256 ?? '' };
					unreadCount = await this.getBoardUnreadCountInTx(runner, boardId, caller.agentId);
				});

				try {
					const detail = await this.storageEngine.readTextBlobVerified(ptr);
					return { ok: true, board_id: boardId, item_id: itemId, detail, unread_count: unreadCount };
				} finally {
					unpin();
				}
			}

			case 'ade_wb_download': {
				assertAllowedArgKeys(args, ['boardId', 'itemId', 'dest', 'destIsDirHint']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				const itemId = requireNonEmptyString(args.itemId, 'item_id');
				const dest = requireNonEmptyString(args.dest, '--dest');

				let ptr!: { storage_host: string; storage_path: string; size_bytes: number; sha256: string; filename: string };
				let callerHost = 'local';
				let unreadCount = 0;
				let unpin!: () => void;

				await pdb.withLock(async runner => {
					const callerRow = await this.verifyActiveCallerInRunner(runner, caller);
					callerHost = callerRow.host;
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					assertWhiteboardAccess(state, boardId, caller.agentId, 'read');

					const item = await runner.get<{
						item_type: 'msg' | 'file';
						file_filename: string | null;
						file_size: number | null;
						storage_host: string | null;
						storage_path: string | null;
						sha256: string | null;
					}>(`SELECT item_type, file_filename, file_size, storage_host, storage_path, sha256 FROM whiteboard_items WHERE board_id = ? AND item_id = ?`, [boardId, itemId]);
					if (!item || item.item_type !== 'file' || !item.storage_path) {
						throw new AdeError('ERR_INVALID_ARGS', '指定的白板备份文件条目不存在（仅限 item_type == "file"）');
					}
					const host = item.storage_host || 'local';
					unpin = this.storageEngine.pinBlobForRead(host, item.storage_path);
					ptr = {
						storage_host: host,
						storage_path: item.storage_path,
						size_bytes: Number(item.file_size ?? 0),
						sha256: item.sha256 ?? '',
						filename: item.file_filename || 'file.bin',
					};
					unreadCount = await this.getBoardUnreadCountInTx(runner, boardId, caller.agentId);
				});

				try {
					const saved_path = await this.storageEngine.downloadBlobToHost({
						ptr,
						fallbackFilename: ptr.filename,
						callerHost,
						rawDestPath: dest,
						destIsDirHint: Boolean(args.destIsDirHint),
					});
					return { ok: true, board_id: boardId, item_id: itemId, saved_path, unread_count: unreadCount };
				} finally {
					unpin();
				}
			}

			case 'ade_wb_edit_item':
				return this.handleCliWbEditItem(pdb, caller, args);

			case 'ade_wb_delete_item': {
				assertAllowedArgKeys(args, ['boardId', 'itemId']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				const itemId = requireNonEmptyString(args.itemId, 'item_id');
				if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
					throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在');
				}
				const tombstones: Array<{ projectId: string; storageHost: string; storagePath: string }> = [];

				const out = await pdb.transaction(async tx => {
					await this.verifyActiveCallerInRunner(tx, caller);
					if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
						throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在');
					}
					const state = await this.loadPolicyStateInTx(tx, caller.projectId);
					const wb = state.whiteboards[boardId];
					if (!wb) {
						throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在');
					}
					const isOwner = wb.owner_id === caller.agentId;
					if (!isOwner) {
						assertWhiteboardAccess(state, boardId, caller.agentId, 'write');
					}
					const item = await tx.get<{ author_id: string; storage_host: string | null; storage_path: string | null }>(
						`SELECT author_id, storage_host, storage_path FROM whiteboard_items WHERE board_id = ? AND item_id = ?`,
						[boardId, itemId],
					);
					if (!item) {
						throw new AdeError('ERR_INVALID_ARGS', '指定的白板条目不存在');
					}
					if (!isOwner && item.author_id !== caller.agentId) {
						throw new AdeError('ERR_ITEM_NOT_AUTHOR', '非白板所有者仅允许删除自己发布的条目');
					}
					if (item.storage_path) {
						tombstones.push({ projectId: caller.projectId, storageHost: item.storage_host || 'local', storagePath: item.storage_path });
					}
					await this.skipUnfinishedMigrationItemsForWbItemInTx(tx, caller.projectId, itemId, tombstones, Date.now());
					await tx.run(`DELETE FROM whiteboard_items WHERE item_id = ?`, [itemId]);
					const unread_count = await this.getBoardUnreadCountInTx(tx, boardId, caller.agentId);
					return { ok: true, board_id: boardId, item_id: itemId, unread_count };
				});

				if (tombstones.length > 0) {
					await this.storageEngine.enqueueTombstones(tombstones);
				}
				this.fireDidChangeProject(caller.projectId);
				return out;
			}

			case 'ade_wb_manage_item': {
				assertAllowedArgKeys(args, ['boardId', 'itemId', 'pin', 'stars', 'tags']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				const itemId = requireNonEmptyString(args.itemId, 'item_id');
				if (args.pin === undefined && args.stars === undefined && args.tags === undefined) {
					throw new AdeError('ERR_INVALID_ARGS', 'ade_wb_manage_item 至少需传入 --pin、--stars 或 --tags 之一');
				}
				if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
					throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在');
				}
				const nextPinBool = args.pin !== undefined ? parseBooleanArg(args.pin, '--pin') : undefined;
				const nextStarsVal = args.stars !== undefined ? parseStarsValue(args.stars) : undefined;

				const out = await pdb.transaction(async tx => {
					await this.verifyActiveCallerInRunner(tx, caller);
					if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
						throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在');
					}
					const state = await this.loadPolicyStateInTx(tx, caller.projectId);
					assertWhiteboardAccess(state, boardId, caller.agentId, 'owner_wb');
					const wb = await tx.get<IRawWhiteboardRow>(`SELECT * FROM whiteboards WHERE board_id = ?`, [boardId]);
					const item = await tx.get<{ stars: number; tags: string; is_pinned: number }>(
						`SELECT stars, tags, is_pinned FROM whiteboard_items WHERE board_id = ? AND item_id = ?`,
						[boardId, itemId],
					);
					if (!item) {
						throw new AdeError('ERR_INVALID_ARGS', '指定的白板条目不存在');
					}
					let nextTags = parseJsonArrayStrings(item.tags);
					if (args.tags !== undefined) {
						nextTags = parseTagListInput(args.tags);
						const allowed = new Set(parseJsonArrayStrings(wb!.tag_categories));
						for (const t of nextTags) {
							if (!allowed.has(t)) {
								throw new AdeError('ERR_INVALID_TAG', `未定义的标签类别: ${t}`);
							}
						}
					}
					await tx.run(
						`UPDATE whiteboard_items
						 SET is_pinned = ?, stars = ?, tags = ?, updated_at = ?
						 WHERE item_id = ?`,
						[
							nextPinBool !== undefined ? (nextPinBool ? 1 : 0) : item.is_pinned,
							nextStarsVal ?? item.stars,
							JSON.stringify(nextTags),
							Date.now(),
							itemId,
						],
					);
					const unread_count = await this.getBoardUnreadCountInTx(tx, boardId, caller.agentId);
					return { ok: true, board_id: boardId, item_id: itemId, unread_count };
				});

				this.fireDidChangeProject(caller.projectId);
				return out;
			}

			case 'ade_wb_note_send': {
				assertAllowedArgKeys(args, ['boardId', 'to', 'text', 'stdinTempFile']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				const toId = requireNonEmptyString(args.to, '--to');
				if ((args.text !== undefined && args.stdinTempFile !== undefined) || (args.text === undefined && args.stdinTempFile === undefined)) {
					throw new AdeError('ERR_INVALID_ARGS', '必须且仅能通过 --text 或 --stdin 之一提供留言文本');
				}
				if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
					throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
				}

				const pre = await pdb.withLock(async runner => {
					const callerRow = await this.verifyActiveCallerInRunner(runner, caller);
					if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
						throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
					}
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					assertWhiteboardAccess(state, boardId, caller.agentId, 'read');
					if (!state.agents[toId] || !canReadBoardPerm(resolveWhiteboardPermission(state, boardId, toId))) {
						throw new AdeError('ERR_NOTE_TARGET_INVALID', '指定的留言接收方不存在或对该白板无访问权限');
					}
					const wb = await runner.get<IRawWhiteboardRow>(`SELECT * FROM whiteboards WHERE board_id = ?`, [boardId]);
					return { callerHost: callerRow.host, storageHost: wb!.storage_host };
				});

				const noteId = genId('nt');
				let preview: string;
				let hasDetail: boolean;
				let storedPtr: { blob_id: string; storage_host: string; storage_path: string; size_bytes: number; sha256: string } | undefined;
				let uploadedStorageHost: string | undefined;

				if (args.stdinTempFile !== undefined) {
					const tempPath = requireNonEmptyString(args.stdinTempFile, '--stdin');
					if (pre.callerHost !== 'local' && pre.callerHost === pre.storageHost) {
						const headText = await this.storageEngine.readRemoteUtf8Prefix(pre.callerHost, tempPath, 2048);
						if (headText.trim().length === 0) {
							await this.storageEngine.deleteTempFileBestEffort(pre.callerHost, tempPath);
							throw new AdeError('ERR_INVALID_ARGS', '留言内容不能为空');
						}
						preview = Array.from(headText).slice(0, 300).join('');
						hasDetail = true;
						const copied = await this.storageEngine.storeFileFromHost({
							sourceHost: pre.callerHost,
							sourcePath: tempPath,
							deleteSourceTempAfter: true,
							targetStorageHost: pre.storageHost,
							relSubdir: `${caller.projectId}_${boardId}`,
							filePrefix: `note_${noteId}`,
						});
						storedPtr = copied;
						uploadedStorageHost = copied.storage_host;
					} else {
						let fullText: string;
						try {
							fullText = await this.storageEngine.readTextBlobVerified({
								storage_host: pre.callerHost,
								storage_path: tempPath,
								size_bytes: 0,
								sha256: '',
							});
						} finally {
							await this.storageEngine.deleteTempFileBestEffort(pre.callerHost, tempPath);
						}
						if (fullText.trim().length === 0) {
							throw new AdeError('ERR_INVALID_ARGS', '留言内容不能为空');
						}
						const cps = Array.from(fullText);
						hasDetail = cps.length > 300;
						preview = hasDetail ? cps.slice(0, 300).join('') : fullText;
						if (hasDetail) {
							storedPtr = await this.storageEngine.storeTextBlob({
								targetStorageHost: pre.storageHost,
								relSubdir: `${caller.projectId}_${boardId}`,
								filePrefix: `note_${noteId}`,
								text: fullText,
							});
							uploadedStorageHost = storedPtr.storage_host;
						}
					}
				} else {
					const fullText = String(args.text ?? '');
					if (fullText.trim().length === 0) {
						throw new AdeError('ERR_INVALID_ARGS', '留言内容不能为空');
					}
					const codePoints = Array.from(fullText);
					hasDetail = codePoints.length > 300;
					preview = hasDetail ? codePoints.slice(0, 300).join('') : fullText;
					if (hasDetail) {
						storedPtr = await this.storageEngine.storeTextBlob({
							targetStorageHost: pre.storageHost,
							relSubdir: `${caller.projectId}_${boardId}`,
							filePrefix: `note_${noteId}`,
							text: fullText,
						});
						uploadedStorageHost = storedPtr.storage_host;
					}
				}

				try {
					const out = await pdb.transaction(async tx => {
						await this.verifyActiveCallerInRunner(tx, caller);
						if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
							throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
						}
						const state = await this.loadPolicyStateInTx(tx, caller.projectId);
						assertWhiteboardAccess(state, boardId, caller.agentId, 'read');
						if (!state.agents[toId] || !canReadBoardPerm(resolveWhiteboardPermission(state, boardId, toId))) {
							throw new AdeError('ERR_NOTE_TARGET_INVALID', '指定的留言接收方不存在或对该白板无访问权限');
						}
						await tx.run(
							`INSERT INTO whiteboard_notes
							 (note_id, board_id, from_id, to_id, content_preview, has_detail, blob_id, storage_host, storage_path, size_bytes, sha256, content_rev, is_read, created_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
							[
								noteId, boardId, caller.agentId, toId, preview,
								hasDetail ? 1 : 0, storedPtr?.blob_id ?? null, storedPtr?.storage_host ?? null,
								storedPtr?.storage_path ?? null, storedPtr?.size_bytes ?? null, storedPtr?.sha256 ?? null, Date.now(),
							],
						);
						const unread_count = await this.getBoardUnreadCountInTx(tx, boardId, caller.agentId);
						return { ok: true, board_id: boardId, note_id: noteId, has_detail: hasDetail, unread_count };
					});
					this.fireDidChangeProject(caller.projectId);
					return out;
				} catch (err) {
					const cleanupTombstones = this.buildBoardUploadCleanupTombstones(
						caller.projectId,
						boardId,
						storedPtr?.storage_host ?? uploadedStorageHost,
						storedPtr?.storage_path,
						err,
					);
					if (cleanupTombstones.length > 0) {
						await this.storageEngine.enqueueTombstones(cleanupTombstones).catch(() => undefined);
					}
					throw err;
				}
			}

			case 'ade_wb_note_unread': {
				assertAllowedArgKeys(args, ['boardId']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				const out = await pdb.transaction(async tx => {
					await this.verifyActiveCallerInRunner(tx, caller);
					const state = await this.loadPolicyStateInTx(tx, caller.projectId);
					assertWhiteboardAccess(state, boardId, caller.agentId, 'read');
					const rows = await tx.all<{
						note_id: string;
						from_id: string;
						content_preview: string;
						has_detail: number;
						created_at: number;
					}>(
						`SELECT note_id, from_id, content_preview, has_detail, created_at
						 FROM whiteboard_notes
						 WHERE board_id = ? AND to_id = ? AND is_read = 0
						 ORDER BY created_at ASC`,
						[boardId, caller.agentId],
					);
					if (rows.length > 0) {
						// Marks read WITHOUT touching `content_rev`!
						await tx.run(
							`UPDATE whiteboard_notes SET is_read = 1 WHERE board_id = ? AND to_id = ? AND is_read = 0`,
							[boardId, caller.agentId],
						);
					}
					return {
						ok: true,
						board_id: boardId,
						unread_count: 0,
						notes: rows.map(r => projectBoardNoteUnreadItem({
							note_id: r.note_id,
							from_id: r.from_id,
							content_preview: r.content_preview,
							has_detail: r.has_detail === 1,
							created_at: r.created_at,
						})),
					};
				});
				this.fireDidChangeProject(caller.projectId);
				return out;
			}

			case 'ade_wb_note_detail': {
				assertAllowedArgKeys(args, ['boardId', 'noteId']);
				const boardId = requireNonEmptyString(args.boardId, 'board_id');
				const noteId = requireNonEmptyString(args.noteId, 'note_id');

				let ptr!: { storage_host: string; storage_path: string; size_bytes: number; sha256: string };
				let unreadCount = 0;
				let unpin!: () => void;

				await pdb.withLock(async runner => {
					await this.verifyActiveCallerInRunner(runner, caller);
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					// Mandatory order: check board access FIRST
					assertWhiteboardAccess(state, boardId, caller.agentId, 'read');

					const note = await runner.get<{
						from_id: string;
						to_id: string;
						has_detail: number;
						storage_host: string | null;
						storage_path: string | null;
						size_bytes: number | null;
						sha256: string | null;
					}>(`SELECT from_id, to_id, has_detail, storage_host, storage_path, size_bytes, sha256 FROM whiteboard_notes WHERE board_id = ? AND note_id = ?`, [boardId, noteId]);
					if (!note) {
						throw new AdeError('ERR_INVALID_ARGS', '指定的留言 note_id 不存在');
					}
					if (caller.agentId !== note.from_id && caller.agentId !== note.to_id) {
						throw new AdeError('ERR_WB_FORBIDDEN', '仅留言发送方或接收方本人有权查看留言详情');
					}
					if (note.has_detail !== 1 || !note.storage_path) {
						throw new AdeError('ERR_DETAIL_NOT_FOUND', '该留言 <= 300 字已直接内联，无额外详情指针文件');
					}
					const host = note.storage_host || 'local';
					unpin = this.storageEngine.pinBlobForRead(host, note.storage_path);
					ptr = {
						storage_host: host,
						storage_path: note.storage_path,
						size_bytes: Number(note.size_bytes ?? 0),
						sha256: note.sha256 ?? '',
					};
					unreadCount = await this.getBoardUnreadCountInTx(runner, boardId, caller.agentId);
				});

				try {
					const content = await this.storageEngine.readTextBlobVerified(ptr);
					return { ok: true, board_id: boardId, note_id: noteId, content, unread_count: unreadCount };
				} finally {
					unpin();
				}
			}

			case 'ade_wb_unread_all': {
				assertAllowedArgKeys(args, []);
				return pdb.withLock(async runner => {
					await this.verifyActiveCallerInRunner(runner, caller);
					const state = await this.loadPolicyStateInTx(runner, caller.projectId);
					const wbs = await runner.all<{ board_id: string; name: string }>(`SELECT board_id, name FROM whiteboards ORDER BY created_at ASC`);
					const boardsOut: Array<{ board_id: string; name: string; unread_count: number }> = [];
					let totalUnread = 0;
					for (const wb of wbs) {
						if (!canReadBoardPerm(resolveWhiteboardPermission(state, wb.board_id, caller.agentId))) {
							continue;
						}
						const cnt = await this.getBoardUnreadCountInTx(runner, wb.board_id, caller.agentId);
						totalUnread += cnt;
						if (cnt > 0) {
							boardsOut.push({ board_id: wb.board_id, name: wb.name, unread_count: cnt });
						}
					}
					return { ok: true, total_unread: totalUnread, boards: boardsOut };
				});
			}

			default:
				throw new AdeError('ERR_INVALID_ARGS', `不支持的白板命令: ${command}`);
		}
	}

	private async handleCliWbEditItem(
		pdb: AdeSingleSqliteDatabase,
		caller: IAdeVerifiedCliCaller,
		args: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		assertAllowedArgKeys(args, ['boardId', 'itemId', 'summary', 'stars', 'tags', 'detail', 'detailFile', 'detailTempFile', 'file']);
		const boardId = requireNonEmptyString(args.boardId, 'board_id');
		const itemId = requireNonEmptyString(args.itemId, 'item_id');
		const hasAny = ['summary', 'stars', 'tags', 'detail', 'detailFile', 'detailTempFile', 'file'].some(k => args[k] !== undefined);
		if (!hasAny) {
			throw new AdeError('ERR_INVALID_ARGS', 'ade_wb_edit_item 至少需传入一项修改内容');
		}
		const detailSpec = await this.resolveDetailInputSpec(args);
		const hasFileArg = args.file !== undefined;
		if (detailSpec.kind !== 'none' && hasFileArg) {
			throw new AdeError('ERR_INVALID_ARGS', '不能在同一条目上同时传入 --detail* 与 --file');
		}
		const nextStars = args.stars !== undefined ? parseStarsValue(args.stars) : undefined;
		const nextTags = args.tags !== undefined ? parseTagListInput(args.tags) : undefined;
		if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
			throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
		}

		const pre = await pdb.withLock(async runner => {
			const callerRow = await this.verifyActiveCallerInRunner(runner, caller);
			if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
				throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
			}
			const state = await this.loadPolicyStateInTx(runner, caller.projectId);
			// Mandatory order: check board access FIRST, then item existence, then author_id!
			assertWhiteboardAccess(state, boardId, caller.agentId, 'write');
			const wb = await runner.get<IRawWhiteboardRow>(`SELECT * FROM whiteboards WHERE board_id = ?`, [boardId]);
			const item = await runner.get<{
				item_type: 'msg' | 'file';
				author_id: string;
				content_rev: number;
			}>(`SELECT item_type, author_id, content_rev FROM whiteboard_items WHERE board_id = ? AND item_id = ?`, [boardId, itemId]);
			if (!item) {
				throw new AdeError('ERR_INVALID_ARGS', '指定的白板条目不存在');
			}
			// Even board owner MUST be rejected with ERR_ITEM_NOT_AUTHOR on `ade_wb_edit_item` if not the author!
			if (item.author_id !== caller.agentId) {
				throw new AdeError('ERR_ITEM_NOT_AUTHOR', 'ade_wb_edit_item 仅允许条目作者本人调用');
			}
			if (item.item_type === 'msg' && hasFileArg) {
				throw new AdeError('ERR_INVALID_ARGS', '消息条目不支持传入 --file');
			}
			if (item.item_type === 'file' && (detailSpec.kind !== 'none' || args.detail === '')) {
				throw new AdeError('ERR_INVALID_ARGS', '备份文件条目不支持传入 --detail*');
			}
			if (nextTags) {
				const allowed = new Set(parseJsonArrayStrings(wb!.tag_categories));
				for (const t of nextTags) {
					if (!allowed.has(t)) {
						throw new AdeError('ERR_INVALID_TAG', `未定义的标签类别: ${t}`);
					}
				}
			}
			return {
				callerHost: callerRow.host,
				storageHost: wb!.storage_host,
				itemType: item.item_type,
				nextRev: item.content_rev + 1,
			};
		});

		let newBlob: {
			readonly blob_id: string;
			readonly storage_host: string;
			readonly storage_path: string;
			readonly size_bytes: number;
			readonly sha256: string;
			readonly filename?: string;
		} | undefined;
		let clearDetailToEmpty = false;
		let uploadedStorageHost: string | undefined;

		if (pre.itemType === 'msg') {
			if (args.detail === '') {
				clearDetailToEmpty = true;
			} else if (detailSpec.kind === 'inline') {
				newBlob = await this.storageEngine.storeTextBlob({
					targetStorageHost: pre.storageHost,
					relSubdir: `${caller.projectId}_${boardId}`,
					filePrefix: `msg_${itemId}`,
					text: detailSpec.text,
					contentRev: pre.nextRev,
				});
				uploadedStorageHost = newBlob.storage_host;
			} else if (detailSpec.kind === 'file') {
				const res = await this.storageEngine.storeFileFromHost({
					sourceHost: pre.callerHost,
					sourcePath: detailSpec.filePath,
					deleteSourceTempAfter: detailSpec.isTempBypass,
					targetStorageHost: pre.storageHost,
					relSubdir: `${caller.projectId}_${boardId}`,
					filePrefix: `msg_${itemId}`,
					contentRev: pre.nextRev,
				});
				uploadedStorageHost = res.storage_host;
				if (res.size_bytes > 0) {
					newBlob = res;
				} else {
					clearDetailToEmpty = true;
					await this.storageEngine.enqueueTombstones([{ projectId: caller.projectId, storageHost: res.storage_host, storagePath: res.storage_path }]);
				}
			}
		} else if (hasFileArg) {
			const fp = requireNonEmptyString(args.file, '--file');
			newBlob = await this.storageEngine.storeFileFromHost({
				sourceHost: pre.callerHost,
				sourcePath: fp,
				targetStorageHost: pre.storageHost,
				relSubdir: `${caller.projectId}_${boardId}`,
				filePrefix: `file_${itemId}`,
				displayFilename: path.posix.basename(fp.replace(/\\/g, '/')),
				contentRev: pre.nextRev,
			});
			uploadedStorageHost = newBlob.storage_host;
		}

		const oldTombstones: Array<{ projectId: string; storageHost: string; storagePath: string }> = [];
		try {
			const out = await pdb.transaction(async tx => {
				await this.verifyActiveCallerInRunner(tx, caller);
				if (this.isWhiteboardDeleting(caller.projectId, boardId)) {
					throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
				}
				const state = await this.loadPolicyStateInTx(tx, caller.projectId);
				assertWhiteboardAccess(state, boardId, caller.agentId, 'write');
				const wb = await tx.get<IRawWhiteboardRow>(`SELECT * FROM whiteboards WHERE board_id = ?`, [boardId]);
				const cur = await tx.get<{
					author_id: string;
					summary: string;
					stars: number;
					tags: string;
					has_detail: number;
					file_filename: string | null;
					file_size: number | null;
					detail_size: number | null;
					blob_id: string | null;
					storage_host: string | null;
					storage_path: string | null;
					sha256: string | null;
					content_rev: number;
				}>(`SELECT * FROM whiteboard_items WHERE board_id = ? AND item_id = ?`, [boardId, itemId]);
				if (!cur) {
					throw new AdeError('ERR_INVALID_ARGS', '指定的白板条目不存在');
				}
				if (cur.author_id !== caller.agentId) {
					throw new AdeError('ERR_ITEM_NOT_AUTHOR', '仅作者本人可调用 ade_wb_edit_item');
				}
				if (nextTags) {
					const allowed = new Set(parseJsonArrayStrings(wb!.tag_categories));
					for (const t of nextTags) {
						if (!allowed.has(t)) {
							throw new AdeError('ERR_INVALID_TAG', `未定义的标签类别: ${t}`);
						}
					}
				}

				const summaryVal = args.summary !== undefined ? requireNonEmptyString(args.summary, '--summary') : cur.summary;
				const starsVal = nextStars ?? cur.stars;
				const tagsVal = nextTags ?? parseJsonArrayStrings(cur.tags);

				let hasDetailVal = cur.has_detail;
				let fileNameVal = cur.file_filename;
				let fileSizeVal = cur.file_size;
				let detailSizeVal = cur.detail_size ?? null;
				let blobIdVal = cur.blob_id;
				let hostVal = cur.storage_host;
				let pathVal = cur.storage_path;
				let shaVal = cur.sha256;
				let revVal = cur.content_rev;

				const now = Date.now();
				if (clearDetailToEmpty) {
					if (cur.storage_path) {
						oldTombstones.push({ projectId: caller.projectId, storageHost: cur.storage_host || 'local', storagePath: cur.storage_path });
					}
					await this.skipUnfinishedMigrationItemsForWbItemInTx(tx, caller.projectId, itemId, oldTombstones, now);
					hasDetailVal = 0;
					detailSizeVal = null;
					blobIdVal = null;
					hostVal = null;
					pathVal = null;
					shaVal = null;
					revVal = cur.content_rev + 1;
				} else if (newBlob) {
					if (cur.storage_path) {
						oldTombstones.push({ projectId: caller.projectId, storageHost: cur.storage_host || 'local', storagePath: cur.storage_path });
					}
					await this.skipUnfinishedMigrationItemsForWbItemInTx(tx, caller.projectId, itemId, oldTombstones, now);
					blobIdVal = newBlob.blob_id;
					hostVal = newBlob.storage_host;
					pathVal = newBlob.storage_path;
					shaVal = newBlob.sha256;
					revVal = cur.content_rev + 1;
					if (pre.itemType === 'msg') {
						hasDetailVal = 1;
						detailSizeVal = newBlob.size_bytes;
					} else {
						fileNameVal = newBlob.filename ?? cur.file_filename;
						fileSizeVal = newBlob.size_bytes;
						detailSizeVal = null;
					}
				}

				await tx.run(
					`UPDATE whiteboard_items
					 SET summary = ?, stars = ?, tags = ?, has_detail = ?, file_filename = ?, file_size = ?, detail_size = ?,
					     blob_id = ?, storage_host = ?, storage_path = ?, sha256 = ?, content_rev = ?, updated_at = ?
					 WHERE item_id = ?`,
					[
						summaryVal, starsVal, JSON.stringify(tagsVal), hasDetailVal, fileNameVal, fileSizeVal, detailSizeVal,
						blobIdVal, hostVal, pathVal, shaVal, revVal, now, itemId,
					],
				);

				const unread_count = await this.getBoardUnreadCountInTx(tx, boardId, caller.agentId);
				return { ok: true, board_id: boardId, item_id: itemId, unread_count };
			});

			if (oldTombstones.length > 0) {
				await this.storageEngine.enqueueTombstones(oldTombstones);
			}
			this.fireDidChangeProject(caller.projectId);
			return out;
		} catch (err) {
			const cleanupTombstones = this.buildBoardUploadCleanupTombstones(
				caller.projectId,
				boardId,
				newBlob?.storage_host ?? uploadedStorageHost,
				newBlob?.storage_path,
				err,
			);
			if (cleanupTombstones.length > 0) {
				await this.storageEngine.enqueueTombstones(cleanupTombstones).catch(() => undefined);
			}
			throw err;
		}
	}

	// =========================================================================
	// Background CAS Online Storage Migration Engine (`whiteboard` & `ticket`)
	// =========================================================================

	private buildTicketUploadCleanupTombstones(
		projectId: string,
		ticketId: string,
		storageHost: string | undefined,
		storagePath: string | undefined,
		alwaysCleanTicketDir: boolean,
	): Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> {
		const out: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> = [];
		if (!storageHost) {
			return out;
		}
		if (storagePath) {
			out.push({ projectId, storageHost, storagePath });
		}
		const projGone = this.isProjectDeletingOrRemoved(projectId);
		if (alwaysCleanTicketDir || projGone) {
			if (storageHost === 'local') {
				out.push({
					projectId,
					storageHost: 'local',
					storagePath: path.join(this.sqliteStore.localStoreRootDir, `${projectId}_tickets`, ticketId),
					isDir: true,
				});
				if (projGone) {
					out.push({
						projectId,
						storageHost: 'local',
						storagePath: path.join(this.sqliteStore.localStoreRootDir, `${projectId}_tickets`),
						isDir: true,
					});
				}
			} else {
				out.push({
					projectId,
					storageHost,
					storagePath: `~/${ADE_REMOTE_STORE_DIR_NAME}/${projectId}_tickets/${ticketId}`,
					isDir: true,
				});
				if (projGone) {
					out.push({
						projectId,
						storageHost,
						storagePath: `~/${ADE_REMOTE_STORE_DIR_NAME}/${projectId}_tickets`,
						isDir: true,
					});
				}
			}
		}
		return out;
	}

	private buildBoardUploadCleanupTombstones(
		projectId: string,
		boardId: string,
		storageHost: string | undefined,
		storagePath: string | undefined,
		err: unknown,
	): Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> {
		const out: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> = [];
		if (!storageHost) {
			return out;
		}
		if (storagePath) {
			out.push({ projectId, storageHost, storagePath });
		}
		const boardOrProjGone = this.isProjectDeletingOrRemoved(projectId)
			|| this.isWhiteboardDeleting(projectId, boardId)
			|| (err instanceof AdeError && err.code === 'ERR_BOARD_NOT_FOUND');
		if (boardOrProjGone) {
			out.push({
				projectId,
				storageHost,
				storagePath: storageHost === 'local'
					? path.join(this.sqliteStore.localStoreRootDir, `${projectId}_${boardId}`)
					: `~/${ADE_REMOTE_STORE_DIR_NAME}/${projectId}_${boardId}`,
				isDir: true,
			});
		}
		return out;
	}

	private buildAbortedMigrationTombstones(
		projectId: string,
		scopeType: 'whiteboard' | 'ticket',
		scopeId: string,
		entityPk1: string,
		canonicalDstHost: string,
		dstPath: string,
	): Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> {
		const out: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> = [
			{ projectId, storageHost: canonicalDstHost, storagePath: dstPath },
		];
		if (this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
			if (scopeType === 'whiteboard') {
				out.push({
					projectId,
					storageHost: canonicalDstHost,
					storagePath: canonicalDstHost === 'local'
						? path.join(this.sqliteStore.localStoreRootDir, `${projectId}_${scopeId}`)
						: `~/${ADE_REMOTE_STORE_DIR_NAME}/${projectId}_${scopeId}`,
					isDir: true,
				});
			} else if (this.isProjectDeletingOrRemoved(projectId)) {
				out.push(
					...this.buildTicketUploadCleanupTombstones(projectId, entityPk1, canonicalDstHost, undefined, true),
				);
			}
		}
		return out;
	}

	private triggerBackgroundCasMigration(
		projectId: string,
		scopeType: 'whiteboard' | 'ticket',
		scopeId: string,
		epoch: number,
	): void {
		if (this.shuttingDown || this._isDisposed || this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
			return;
		}
		const migKey = `${projectId}:${scopeType}:${scopeId}:${epoch}:${crypto.randomBytes(4).toString('hex')}`;
		const runPromise = this.runCasMigrationLoop(projectId, scopeType, scopeId, epoch)
			.catch(err => {
				this.logService?.warn(`[AdeControlCenter] CAS migration error (${migKey})`, err);
			})
			.finally(() => {
				this.activeMigrations.delete(migKey);
			});
		this.activeMigrations.set(migKey, runPromise);
	}

	private async checkMigrationTargetLiveInTx(
		runner: IAdeSqlRunner,
		item: {
			readonly entity_table: 'whiteboard_items' | 'whiteboard_notes' | 'ticket_tasks';
			readonly entity_pk_1: string;
			readonly entity_pk_2: string;
			readonly expected_rev: number;
			readonly src_host: string;
			readonly src_path: string;
		},
	): Promise<{ readonly live: boolean; readonly ticketDestroyed: boolean }> {
		if (item.entity_table === 'whiteboard_items') {
			const row = await runner.get<{ content_rev: number; storage_host: string | null; storage_path: string | null }>(
				`SELECT content_rev, storage_host, storage_path FROM whiteboard_items WHERE item_id = ?`,
				[item.entity_pk_1],
			);
			const live = Boolean(
				row
				&& row.content_rev === item.expected_rev
				&& row.storage_host === item.src_host
				&& row.storage_path === item.src_path,
			);
			return { live, ticketDestroyed: false };
		}
		if (item.entity_table === 'whiteboard_notes') {
			const row = await runner.get<{ content_rev: number; storage_host: string | null; storage_path: string | null }>(
				`SELECT content_rev, storage_host, storage_path FROM whiteboard_notes WHERE note_id = ?`,
				[item.entity_pk_1],
			);
			const live = Boolean(
				row
				&& row.content_rev === item.expected_rev
				&& row.storage_host === item.src_host
				&& row.storage_path === item.src_path,
			);
			return { live, ticketDestroyed: false };
		}
		const tkRow = await runner.get<{ status: string }>(
			`SELECT status FROM tickets WHERE ticket_id = ?`,
			[item.entity_pk_1],
		);
		if (!tkRow || tkRow.status === 'destroyed') {
			return { live: false, ticketDestroyed: true };
		}
		const taskRow = await runner.get<{ content_rev: number; storage_host: string | null; storage_path: string | null }>(
			`SELECT content_rev, storage_host, storage_path FROM ticket_tasks WHERE ticket_id = ? AND task_id = ?`,
			[item.entity_pk_1, item.entity_pk_2],
		);
		const live = Boolean(
			taskRow
			&& taskRow.content_rev === item.expected_rev
			&& taskRow.storage_host === item.src_host
			&& taskRow.storage_path === item.src_path,
		);
		return { live, ticketDestroyed: false };
	}

	private async runCasMigrationLoop(
		projectId: string,
		scopeType: 'whiteboard' | 'ticket',
		scopeId: string,
		taskEpoch: number,
	): Promise<void> {
		if (this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
			return;
		}
		const pdb = await this.tryOpenHealedActiveProjectDb(projectId);
		if (!pdb) {
			return;
		}
		let hadFailure = false;

		type IMigCandidateRow = {
			migration_item_id: string;
			entity_table: 'whiteboard_items' | 'whiteboard_notes' | 'ticket_tasks';
			entity_pk_1: string;
			entity_pk_2: string;
			expected_rev: number;
			expected_sha256: string;
			size_bytes: number;
			src_host: string;
			src_path: string;
			dst_host: string;
			dst_path: string;
		};

		while (!this.shuttingDown && !this._isDisposed && !this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
			const step = await pdb.transaction(async tx => {
				if (this.shuttingDown || this._isDisposed || this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
					return { kind: 'abort' as const };
				}
				const currentEpoch = await this.readCurrentMigrationEpochInTx(tx, scopeType, scopeId);
				if (currentEpoch !== taskEpoch) {
					return { kind: 'epoch_superseded' as const };
				}
				const candidate = await tx.get<IMigCandidateRow>(
					`SELECT migration_item_id, entity_table, entity_pk_1, entity_pk_2, expected_rev, expected_sha256, size_bytes, src_host, src_path, dst_host, dst_path
					 FROM storage_migration_items
					 WHERE scope_type = ? AND scope_id = ? AND epoch = ? AND phase = 'pending'
					 ORDER BY updated_at ASC
					 LIMIT 1`,
					[scopeType, scopeId, taskEpoch],
				);
				if (!candidate) {
					return { kind: 'done' as const };
				}

				const targetState = await this.checkMigrationTargetLiveInTx(tx, candidate);
				if (!targetState.live) {
					const staleTombstones: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> = [];
					const normDstHost = (candidate.dst_host || 'local').trim() || 'local';
					if (candidate.dst_path?.trim()) {
						staleTombstones.push({ projectId, storageHost: normDstHost, storagePath: candidate.dst_path.trim() });
					}
					if (candidate.entity_table === 'ticket_tasks' && targetState.ticketDestroyed && (candidate.dst_path?.trim() || candidate.dst_host?.trim())) {
						staleTombstones.push(
							...this.buildTicketUploadCleanupTombstones(projectId, candidate.entity_pk_1, normDstHost, undefined, true),
						);
					}
					await tx.run(
						`UPDATE storage_migration_items
						 SET phase = 'skipped', last_error = NULL, updated_at = ?
						 WHERE migration_item_id = ?`,
						[Date.now(), candidate.migration_item_id],
					);
					return { kind: 'skipped' as const, staleTombstones };
				}

				// Pin source blob atomically inside DB lock so concurrent GC cannot unlink before copy opens stream
				const unpinSrc = this.storageEngine.pinBlobForRead(candidate.src_host, candidate.src_path);
				return { kind: 'ready' as const, item: candidate, unpinSrc };
			});

			if (step.kind === 'abort' || step.kind === 'done') {
				break;
			}
			if (step.kind === 'epoch_superseded') {
				return;
			}
			if (step.kind === 'skipped') {
				if (step.staleTombstones.length > 0) {
					await this.storageEngine.enqueueTombstones(step.staleTombstones).catch(() => undefined);
				}
				if (!this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
					this.fireDidChangeProject(projectId);
				}
				continue;
			}

			const { item, unpinSrc } = step;
			let copiedDst: { canonicalDstHost: string; dstPath: string; sizeBytes: number } | undefined;
			try {
				if (this.shuttingDown || this._isDisposed || this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
					unpinSrc();
					break;
				}
				const relSubdir = scopeType === 'whiteboard'
					? `${projectId}_${scopeId}`
					: path.posix.join(`${projectId}_tickets`, item.entity_pk_1);
				copiedDst = await this.storageEngine.copyBlobForMigration({
					srcHost: item.src_host,
					srcPath: item.src_path,
					dstHost: item.dst_host,
					relSubdir,
					expectedBytes: item.size_bytes,
					expectedSha256: item.expected_sha256,
				});
			} catch (copyErr) {
				unpinSrc();
				if (this.isMigrationScopeDeleting(projectId, scopeType, scopeId) || this._isDisposed) {
					break;
				}
				const errTombstones: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> = [];
				let realFailure = true;
				await pdb.transaction(async tx => {
					const liveEpoch = await this.readCurrentMigrationEpochInTx(tx, scopeType, scopeId);
					const recheck = await this.checkMigrationTargetLiveInTx(tx, item);
					const now = Date.now();
					if (liveEpoch !== taskEpoch || !recheck.live) {
						realFailure = false;
						if (item.entity_table === 'ticket_tasks' && recheck.ticketDestroyed && item.dst_host?.trim()) {
							errTombstones.push(
								...this.buildTicketUploadCleanupTombstones(projectId, item.entity_pk_1, item.dst_host.trim(), undefined, true),
							);
						}
						await tx.run(
							`UPDATE storage_migration_items
							 SET phase = 'skipped', last_error = NULL, updated_at = ?
							 WHERE migration_item_id = ?`,
							[now, item.migration_item_id],
						);
					} else {
						realFailure = true;
						await tx.run(
							`UPDATE storage_migration_items
							 SET phase = 'failed', retry_count = retry_count + 1, last_error = ?, updated_at = ?
							 WHERE migration_item_id = ?`,
							[copyErr instanceof Error ? copyErr.message : String(copyErr), now, item.migration_item_id],
						);
					}
				}).catch(() => undefined);
				if (realFailure) {
					hadFailure = true;
				}
				if (errTombstones.length > 0) {
					await this.storageEngine.enqueueTombstones(errTombstones).catch(() => undefined);
				}
				if (!this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
					this.fireDidChangeProject(projectId);
				}
				if (this.shuttingDown || this._isDisposed || this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
					break;
				}
				continue;
			}
			unpinSrc();

			if (this.shuttingDown || this._isDisposed || this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
				await this.storageEngine.enqueueTombstones(
					this.buildAbortedMigrationTombstones(
						projectId,
						scopeType,
						scopeId,
						item.entity_pk_1,
						copiedDst.canonicalDstHost,
						copiedDst.dstPath,
					),
				).catch(() => undefined);
				break;
			}

			// CAS pointer switch inside Sequencer transaction:
			// Switch ONLY if `currentEpoch === taskEpoch && content_rev === expected_rev`!
			const tombstonesToClean: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }> = [];
			try {
				await pdb.transaction(async tx => {
					if (this.shuttingDown || this._isDisposed || this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
						tombstonesToClean.push(
							...this.buildAbortedMigrationTombstones(
								projectId,
								scopeType,
								scopeId,
								item.entity_pk_1,
								copiedDst!.canonicalDstHost,
								copiedDst!.dstPath,
							),
						);
						return;
					}
					const liveEpoch = await this.readCurrentMigrationEpochInTx(tx, scopeType, scopeId);
					const now = Date.now();
					if (liveEpoch !== taskEpoch) {
						const stillReferenced = item.entity_table === 'whiteboard_items'
							? Boolean(await tx.get(`SELECT 1 FROM whiteboard_items WHERE item_id = ? AND storage_host = ? AND storage_path = ?`, [item.entity_pk_1, copiedDst!.canonicalDstHost, copiedDst!.dstPath]))
							: (item.entity_table === 'whiteboard_notes'
								? Boolean(await tx.get(`SELECT 1 FROM whiteboard_notes WHERE note_id = ? AND storage_host = ? AND storage_path = ?`, [item.entity_pk_1, copiedDst!.canonicalDstHost, copiedDst!.dstPath]))
								: Boolean(await tx.get(`SELECT 1 FROM ticket_tasks WHERE ticket_id = ? AND task_id = ? AND storage_host = ? AND storage_path = ?`, [item.entity_pk_1, item.entity_pk_2, copiedDst!.canonicalDstHost, copiedDst!.dstPath])));
						if (!stillReferenced) {
							tombstonesToClean.push({ projectId, storageHost: copiedDst!.canonicalDstHost, storagePath: copiedDst!.dstPath });
						}
						if (item.entity_table === 'ticket_tasks') {
							const tkRow = await tx.get<{ status: string }>(`SELECT status FROM tickets WHERE ticket_id = ?`, [item.entity_pk_1]);
							if (!tkRow || tkRow.status === 'destroyed') {
								tombstonesToClean.push(
									...this.buildTicketUploadCleanupTombstones(projectId, item.entity_pk_1, copiedDst!.canonicalDstHost, undefined, true),
								);
							}
						}
						await tx.run(
							`UPDATE storage_migration_items SET dst_path = ?, phase = 'skipped', last_error = NULL, updated_at = ? WHERE migration_item_id = ?`,
							[copiedDst!.dstPath, now, item.migration_item_id],
						);
						return;
					}

					let switched = false;
					if (item.entity_table === 'whiteboard_items') {
						const r = await tx.run(
							`UPDATE whiteboard_items
							 SET storage_host = ?, storage_path = ?,
							     detail_size = CASE WHEN item_type = 'msg' THEN COALESCE(detail_size, ?) ELSE detail_size END
							 WHERE item_id = ? AND content_rev = ? AND storage_host = ? AND storage_path = ?`,
							[copiedDst!.canonicalDstHost, copiedDst!.dstPath, copiedDst!.sizeBytes, item.entity_pk_1, item.expected_rev, item.src_host, item.src_path],
						);
						switched = r.changes > 0;
					} else if (item.entity_table === 'whiteboard_notes') {
						const r = await tx.run(
							`UPDATE whiteboard_notes
							 SET storage_host = ?, storage_path = ?
							 WHERE note_id = ? AND content_rev = ? AND storage_host = ? AND storage_path = ?`,
							[copiedDst!.canonicalDstHost, copiedDst!.dstPath, item.entity_pk_1, item.expected_rev, item.src_host, item.src_path],
						);
						switched = r.changes > 0;
					} else {
						const r = await tx.run(
							`UPDATE ticket_tasks
							 SET storage_host = ?, storage_path = ?
							 WHERE ticket_id = ? AND task_id = ? AND content_rev = ? AND storage_host = ? AND storage_path = ?
							   AND EXISTS (SELECT 1 FROM tickets tk WHERE tk.ticket_id = ticket_tasks.ticket_id AND tk.status != 'destroyed')`,
							[copiedDst!.canonicalDstHost, copiedDst!.dstPath, item.entity_pk_1, item.entity_pk_2, item.expected_rev, item.src_host, item.src_path],
						);
						switched = r.changes > 0;
					}

					if (switched) {
						// Push old source copy to tombstones ("切到云端删本地，切到本地删云端")
						tombstonesToClean.push({ projectId, storageHost: item.src_host, storagePath: item.src_path });
						await tx.run(
							`UPDATE storage_migration_items SET dst_path = ?, phase = 'cleaned', last_error = NULL, updated_at = ? WHERE migration_item_id = ?`,
							[copiedDst!.dstPath, now, item.migration_item_id],
						);
					} else {
						// Concurrent edit/delete/destroy occurred during copy -> discard newly copied stale replica (& <ticket_id> dir if ticket destroyed)!
						const stillReferenced = item.entity_table === 'whiteboard_items'
							? Boolean(await tx.get(`SELECT 1 FROM whiteboard_items WHERE item_id = ? AND storage_host = ? AND storage_path = ?`, [item.entity_pk_1, copiedDst!.canonicalDstHost, copiedDst!.dstPath]))
							: (item.entity_table === 'whiteboard_notes'
								? Boolean(await tx.get(`SELECT 1 FROM whiteboard_notes WHERE note_id = ? AND storage_host = ? AND storage_path = ?`, [item.entity_pk_1, copiedDst!.canonicalDstHost, copiedDst!.dstPath]))
								: Boolean(await tx.get(`SELECT 1 FROM ticket_tasks WHERE ticket_id = ? AND task_id = ? AND storage_host = ? AND storage_path = ?`, [item.entity_pk_1, item.entity_pk_2, copiedDst!.canonicalDstHost, copiedDst!.dstPath])));
						if (!stillReferenced) {
							tombstonesToClean.push({ projectId, storageHost: copiedDst!.canonicalDstHost, storagePath: copiedDst!.dstPath });
						}
						if (item.entity_table === 'ticket_tasks') {
							const tkRow = await tx.get<{ status: string }>(`SELECT status FROM tickets WHERE ticket_id = ?`, [item.entity_pk_1]);
							if (!tkRow || tkRow.status === 'destroyed') {
								tombstonesToClean.push(
									...this.buildTicketUploadCleanupTombstones(projectId, item.entity_pk_1, copiedDst!.canonicalDstHost, undefined, true),
								);
							}
						}
						await tx.run(
							`UPDATE storage_migration_items SET dst_path = ?, phase = 'skipped', last_error = NULL, updated_at = ? WHERE migration_item_id = ?`,
							[copiedDst!.dstPath, now, item.migration_item_id],
						);
					}
				});
			} catch (txErr) {
				await this.storageEngine.enqueueTombstones(
					this.buildAbortedMigrationTombstones(
						projectId,
						scopeType,
						scopeId,
						item.entity_pk_1,
						copiedDst.canonicalDstHost,
						copiedDst.dstPath,
					),
				).catch(() => undefined);
				if (this.isMigrationScopeDeleting(projectId, scopeType, scopeId) || this.shuttingDown || this._isDisposed) {
					break;
				}
				throw txErr;
			}

			await this.storageEngine.enqueueTombstones(tombstonesToClean);
			if (!this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
				this.fireDidChangeProject(projectId);
			}
			if (this.shuttingDown || this._isDisposed || this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
				break;
			}
		}

		if (this.isMigrationScopeDeleting(projectId, scopeType, scopeId) || this._isDisposed) {
			return;
		}

		await pdb.transaction(async tx => {
			if (this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
				return;
			}
			const liveEpoch = await this.readCurrentMigrationEpochInTx(tx, scopeType, scopeId);
			if (liveEpoch !== taskEpoch) {
				return;
			}
			const unfinishedRow = await tx.get<{ cnt: number }>(
				`SELECT COUNT(1) AS cnt FROM storage_migration_items WHERE scope_type = ? AND scope_id = ? AND epoch = ? AND phase IN ('pending', 'failed')`,
				[scopeType, scopeId, taskEpoch],
			);
			const finalState: AdeMigrationState = (hadFailure || Number(unfinishedRow?.cnt ?? 0) > 0) ? 'failed' : 'completed';
			const now = Date.now();
			if (scopeType === 'whiteboard') {
				await tx.run(`UPDATE whiteboards SET migration_state = ?, updated_at = ? WHERE board_id = ?`, [finalState, now, scopeId]);
			} else {
				await tx.run(`UPDATE project_meta SET ticket_migration_state = ?, updated_at = ? WHERE project_id = ?`, [finalState, now, scopeId]);
			}
		}).catch(() => undefined);
		if (!this.isMigrationScopeDeleting(projectId, scopeType, scopeId)) {
			this.fireDidChangeProject(projectId);
		}
	}

	private async readCurrentMigrationEpochInTx(runner: IAdeSqlRunner, scopeType: 'whiteboard' | 'ticket', scopeId: string): Promise<number> {
		if (scopeType === 'whiteboard') {
			const row = await runner.get<{ migration_epoch: number }>(`SELECT migration_epoch FROM whiteboards WHERE board_id = ?`, [scopeId]);
			return row?.migration_epoch ?? -1;
		}
		const row = await runner.get<{ ticket_migration_epoch: number }>(`SELECT ticket_migration_epoch FROM project_meta WHERE project_id = ?`, [scopeId]);
		return row?.ticket_migration_epoch ?? -1;
	}

	// =========================================================================
	// Internal DB & Policy State Helpers
	// =========================================================================

	private buildDeterministicSessionResource(engine: string, projectId: string, agentId: string): string {
		return `aexus-${engine}:/ade-${projectId}-${agentId}`;
	}

	private mapAgentRow(r: IRawAgentRow): IAdeAgentNode {
		return {
			agent_id: r.agent_id,
			project_id: r.project_id,
			level: r.level,
			is_top_role: r.is_top_role === 1,
			parent_id: r.parent_id,
			name: r.name,
			role_summary: r.role_summary,
			host: r.host,
			engine: r.engine,
			model: r.model,
			effort: r.effort,
			session_phase: r.session_phase,
			session_started: r.session_started === 1,
			excluded_dept_ids: parseJsonArrayStrings(r.excluded_dept_ids),
			...(r.session_resource ? { session_resource: r.session_resource } : {}),
			...(r.native_session_id ? { native_session_id: r.native_session_id } : {}),
			last_read_doc_rev: r.last_read_doc_rev,
			token_gen: r.token_gen,
			...(r.canvas_x !== null ? { canvas_x: r.canvas_x } : {}),
			...(r.canvas_y !== null ? { canvas_y: r.canvas_y } : {}),
			...(r.color_token ? { color_token: r.color_token } : {}),
			created_at: r.created_at,
			updated_at: r.updated_at,
		};
	}

	private toPolicyTicket(r: IRawTicketRow): IAdePolicyTicket {
		return {
			ticket_id: r.ticket_id,
			project_id: r.project_id,
			creator_id: r.creator_id,
			peer_id: r.peer_id,
			ticket_level: r.ticket_level,
			from_id: r.from_id,
			to_id: r.to_id,
			holder_id: r.holder_id,
			need_return: r.need_return === 1,
			status: r.status,
		};
	}

	private async requireProjectDb(projectId: string): Promise<AdeSingleSqliteDatabase> {
		this.assertNotShuttingDown();
		if (this.isProjectDeletingOrRemoved(projectId)) {
			throw new AdeError('ERR_INVALID_ARGS', `指定的项目正在删除中或已移除: ${projectId}`);
		}
		const row = await this.sqliteStore.catalog.get<{ project_id: string }>(
			`SELECT project_id FROM projects_index WHERE project_id = ?`,
			[projectId],
		);
		this.assertNotShuttingDown();
		if (!row || this.isProjectDeletingOrRemoved(projectId)) {
			throw new AdeError('ERR_INVALID_ARGS', `指定的项目不存在: ${projectId}`);
		}
		const pdb = this.sqliteStore.openProjectDb(projectId);
		await this.ensureProjectDbHealed(projectId, pdb);
		return pdb;
	}

	private async requireProjectDbForCaller(projectId: string): Promise<AdeSingleSqliteDatabase> {
		this.assertNotShuttingDown();
		if (this.isProjectDeletingOrRemoved(projectId)) {
			throw new AdeError('ERR_UNAUTHORIZED', '所属项目不存在或已被删除');
		}
		const row = await this.sqliteStore.catalog.get<{ project_id: string }>(
			`SELECT project_id FROM projects_index WHERE project_id = ?`,
			[projectId],
		);
		this.assertNotShuttingDown();
		if (!row || this.isProjectDeletingOrRemoved(projectId)) {
			throw new AdeError('ERR_UNAUTHORIZED', '所属项目不存在或已被删除');
		}
		const pdb = this.sqliteStore.openProjectDb(projectId);
		await this.ensureProjectDbHealed(projectId, pdb);
		return pdb;
	}

	private async verifyActiveCallerNode(pdb: AdeSingleSqliteDatabase, caller: IAdeVerifiedCliCaller): Promise<IRawAgentRow> {
		return pdb.withLock(runner => this.verifyActiveCallerInRunner(runner, caller));
	}

	private async verifyActiveCallerInRunner(runner: IAdeSqlRunner, caller: IAdeVerifiedCliCaller): Promise<IRawAgentRow> {
		this.assertNotShuttingDown();
		if (this.isProjectDeletingOrRemoved(caller.projectId)) {
			throw new AdeError('ERR_UNAUTHORIZED', '所属项目不存在或已被删除');
		}
		const ag = await runner.get<IRawAgentRow>(`SELECT * FROM agents WHERE agent_id = ?`, [caller.agentId]);
		if (!ag || ag.project_id !== caller.projectId || ag.token_gen !== caller.tokenGen || ag.host !== caller.host) {
			throw new AdeError('ERR_UNAUTHORIZED', '当前调用者会话身份无效、宿主不匹配或已被吊销');
		}
		return ag;
	}

	private async syncProjectHostsTableInTx(runner: IAdeSqlRunner): Promise<void> {
		if (!this.cloudHosts) {
			return;
		}
		const hosts = await this.cloudHosts.listHosts().catch(() => []);
		const now = Date.now();
		for (const h of hosts) {
			if (!h.hostName?.trim()) {
				continue;
			}
			await runner.run(
				`INSERT OR REPLACE INTO project_hosts (host_id, ip, name, ssh_alias, os_kind, remote_home, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[h.id, h.hostName.trim(), h.name || h.alias, h.alias, h.os, h.lastTestStatus?.remoteHome ?? null, now],
			);
		}
	}

	private async validateAndCanonicalizeHost(rawHost: string, pdb: AdeSingleSqliteDatabase): Promise<string> {
		const trimmed = rawHost.trim();
		if (!trimmed) {
			throw new AdeError('ERR_INVALID_ARGS', '主机标识不能为空');
		}
		if (trimmed === 'local') {
			return 'local';
		}
		await pdb.transaction(tx => this.syncProjectHostsTableInTx(tx));
		const dbMatch = await pdb.get<{ ip: string }>(
			`SELECT ip FROM project_hosts WHERE ip = ? OR ssh_alias = ? OR name = ?`,
			[trimmed, trimmed, trimmed],
		);
		if (dbMatch) {
			return dbMatch.ip;
		}
		if (this.cloudHosts) {
			const h = await this.cloudHosts.getHost(trimmed);
			if (h?.hostName) {
				return h.hostName;
			}
		}
		throw new AdeError('ERR_INVALID_ARGS', `未知的远程云主机: ${trimmed}`);
	}

	private async tryLookupHostAlias(hostIp: string): Promise<string | undefined> {
		if (!this.cloudHosts) {
			return undefined;
		}
		const all = await this.cloudHosts.listHosts().catch(() => []);
		return all.find(h => h.hostName === hostIp || h.alias === hostIp)?.alias;
	}

	private async loadPolicyStateInTx(runner: IAdeSqlRunner, projectId: string): Promise<IAdePolicyProjectState> {
		const agentRows = await runner.all<IRawAgentRow>(`SELECT * FROM agents`);
		const deptRows = await runner.all<IRawDepartmentRow>(`SELECT * FROM departments`);
		const wbRows = await runner.all<IRawWhiteboardRow>(`SELECT * FROM whiteboards`);
		const grantRows = await runner.all<IRawBoardGrantRow>(`SELECT * FROM board_grants`);
		const ticketRows = await runner.all<IRawTicketRow>(`SELECT * FROM tickets WHERE status != 'destroyed'`);

		const agents: Record<string, IAdePolicyAgent> = {};
		for (const a of agentRows) {
			agents[a.agent_id] = {
				agent_id: a.agent_id,
				project_id: a.project_id,
				level: a.level,
				is_top_role: a.is_top_role === 1,
				parent_id: a.parent_id,
				excluded_dept_ids: parseJsonArrayStrings(a.excluded_dept_ids),
			};
		}

		const departments: Record<string, IAdePolicyDepartment> = {};
		for (const d of deptRows) {
			departments[d.dept_id] = {
				dept_id: d.dept_id,
				project_id: d.project_id,
				name: d.name,
				root_agent_id: d.root_agent_id,
				parent_dept_id: d.parent_dept_id,
				board_permissions: parseBoardPermsJson(d.board_permissions),
				created_by: d.created_by,
			};
		}

		const whiteboards: Record<string, IAdePolicyWhiteboard> = {};
		for (const w of wbRows) {
			whiteboards[w.board_id] = {
				board_id: w.board_id,
				project_id: w.project_id,
				owner_id: w.owner_id,
				dept_id: w.dept_id,
			};
		}

		const board_grants: IAdePolicyBoardGrant[] = grantRows.map(g => ({
			board_id: g.board_id,
			agent_id: g.agent_id,
			permission: g.permission,
			granted_by: g.granted_by,
		}));

		const tickets: Record<string, IAdePolicyTicket> = {};
		for (const t of ticketRows) {
			tickets[t.ticket_id] = this.toPolicyTicket(t);
		}

		return { project_id: projectId, agents, departments, whiteboards, board_grants, tickets };
	}

	private async persistPolicySideEffectsInTx(
		tx: IAdeSqlRunner,
		state: IAdePolicyProjectState,
		newlyFrozenTickets: readonly string[],
	): Promise<void> {
		const now = Date.now();
		for (const ag of Object.values(state.agents)) {
			await tx.run(
				`UPDATE agents SET parent_id = ?, excluded_dept_ids = ?, updated_at = ? WHERE agent_id = ?`,
				[ag.parent_id, JSON.stringify(ag.excluded_dept_ids), now, ag.agent_id],
			);
		}
		for (const dp of Object.values(state.departments)) {
			await tx.run(
				`UPDATE departments SET parent_dept_id = ?, board_permissions = ?, updated_at = ? WHERE dept_id = ?`,
				[dp.parent_dept_id, JSON.stringify(dp.board_permissions), now, dp.dept_id],
			);
		}
		for (const wb of Object.values(state.whiteboards)) {
			await tx.run(
				`UPDATE whiteboards SET owner_id = ?, dept_id = ?, updated_at = ? WHERE board_id = ?`,
				[wb.owner_id, wb.dept_id, now, wb.board_id],
			);
		}
		await tx.run(`DELETE FROM board_grants`);
		for (const g of state.board_grants) {
			await tx.run(
				`INSERT INTO board_grants (board_id, agent_id, permission, granted_by, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[g.board_id, g.agent_id, g.permission, g.granted_by, now],
			);
		}
		for (const tid of newlyFrozenTickets) {
			await tx.run(
				`UPDATE tickets SET status = 'frozen_orphan', holder_id = NULL, frozen_at = ?, updated_at = ? WHERE ticket_id = ?`,
				[now, now, tid],
			);
			await tx.run(`DELETE FROM ticket_delivery_outbox WHERE ticket_id = ?`, [tid]);
		}
	}

	private async getBoardUnreadCountInTx(runner: IAdeSqlRunner, boardId: string, agentId: string): Promise<number> {
		const r = await runner.get<{ c: number }>(
			`SELECT COUNT(*) AS c FROM whiteboard_notes WHERE board_id = ? AND to_id = ? AND is_read = 0`,
			[boardId, agentId],
		);
		return Number(r?.c ?? 0);
	}

	private async computeTotalReadableBoardUnreadsInTx(
		runner: IAdeSqlRunner,
		state: IAdePolicyProjectState,
		agentId: string,
	): Promise<number> {
		let total = 0;
		for (const boardId of Object.keys(state.whiteboards)) {
			if (!canReadBoardPerm(resolveWhiteboardPermission(state, boardId, agentId))) {
				continue;
			}
			total += await this.getBoardUnreadCountInTx(runner, boardId, agentId);
		}
		return total;
	}

	private computeBoardMembersList(
		state: IAdePolicyProjectState,
		orderedAgents: readonly IAdeAgentNode[],
		boardId: string,
	): Array<{ readonly agent_id: string; readonly name: string; readonly permission: 'owner' | AdeBoardPermission }> {
		const out: Array<{ agent_id: string; name: string; permission: 'owner' | AdeBoardPermission }> = [];
		for (const ag of orderedAgents) {
			const perm = resolveWhiteboardPermission(state, boardId, ag.agent_id);
			if (perm !== 'none') {
				out.push({ agent_id: ag.agent_id, name: ag.name, permission: perm });
			}
		}
		return out;
	}

	private async queryBoardItemsFiltered(
		runner: IAdeSqlRunner,
		boardId: string,
		filter: IAdeWbItemsFilter,
	): Promise<IAdeBoardItemPublicSummary[]> {
		const clauses: string[] = [`board_id = ?`];
		const params: unknown[] = [boardId];

		if (filter.author) {
			clauses.push(`author_id = ?`);
			params.push(filter.author);
		}
		if (filter.type === 'msg' || filter.type === 'file') {
			clauses.push(`item_type = ?`);
			params.push(filter.type);
		}
		const starsRange = parseStarsFilterRange(filter.stars);
		if (starsRange) {
			clauses.push(`stars BETWEEN ? AND ?`);
			params.push(starsRange.min, starsRange.max);
		}

		const orderSql = filter.sort === 'stars'
			? `ORDER BY is_pinned DESC, stars DESC, created_at DESC`
			: `ORDER BY is_pinned DESC, created_at DESC`;

		const rows = await runner.all<{
			item_id: string;
			item_type: 'msg' | 'file';
			author_id: string;
			summary: string;
			stars: number;
			tags: string;
			is_pinned: number;
			has_detail: number;
			file_filename: string | null;
			file_size: number | null;
			created_at: number;
		}>(`SELECT item_id, item_type, author_id, summary, stars, tags, is_pinned, has_detail, file_filename, file_size, created_at FROM whiteboard_items WHERE ${clauses.join(' AND ')} ${orderSql}`, params);

		const out: IAdeBoardItemPublicSummary[] = [];
		for (const r of rows) {
			const tags = parseJsonArrayStrings(r.tags);
			if (filter.tag && !tags.includes(filter.tag)) {
				continue;
			}
			out.push(projectBoardItemPublicSummary({
				item_id: r.item_id,
				item_type: r.item_type,
				author_id: r.author_id,
				summary: r.summary,
				stars: r.stars,
				tags,
				is_pinned: r.is_pinned === 1,
				has_detail: r.has_detail === 1,
				file_filename: r.file_filename,
				file_size: r.file_size,
				created_at: r.created_at,
			}));
			if (filter.limit !== undefined && out.length >= filter.limit) {
				break;
			}
		}
		return out;
	}

	private async stripRemovedTagsFromBoardItemsInTx(
		tx: IAdeSqlRunner,
		boardId: string,
		removedTags: ReadonlySet<string>,
	): Promise<void> {
		if (removedTags.size === 0) {
			return;
		}
		const rows = await tx.all<{ item_id: string; tags: string }>(
			`SELECT item_id, tags FROM whiteboard_items WHERE board_id = ?`,
			[boardId],
		);
		const now = Date.now();
		for (const r of rows) {
			const cur = parseJsonArrayStrings(r.tags);
			const next = cur.filter(t => !removedTags.has(t));
			if (next.length !== cur.length) {
				await tx.run(`UPDATE whiteboard_items SET tags = ?, updated_at = ? WHERE item_id = ?`, [JSON.stringify(next), now, r.item_id]);
			}
		}
	}

	private async collectAndDeleteWhiteboardInTx(
		tx: IAdeSqlRunner,
		projectId: string,
		boardId: string,
		tombstones: Array<{ projectId: string; storageHost: string; storagePath: string; isDir?: boolean }>,
	): Promise<void> {
		const wb = await tx.get<IRawWhiteboardRow>(`SELECT * FROM whiteboards WHERE board_id = ?`, [boardId]);
		if (!wb) {
			throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
		}
		const itemBlobs = await tx.all<{ storage_host: string | null; storage_path: string | null }>(
			`SELECT storage_host, storage_path FROM whiteboard_items WHERE board_id = ? AND storage_path IS NOT NULL`,
			[boardId],
		);
		const noteBlobs = await tx.all<{ storage_host: string | null; storage_path: string | null }>(
			`SELECT storage_host, storage_path FROM whiteboard_notes WHERE board_id = ? AND storage_path IS NOT NULL`,
			[boardId],
		);
		const migBlobs = await tx.all<{ src_host: string | null; src_path: string | null; dst_host: string | null; dst_path: string | null }>(
			`SELECT src_host, src_path, dst_host, dst_path FROM storage_migration_items WHERE scope_type = 'whiteboard' AND scope_id = ?`,
			[boardId],
		);
		const dirHosts = new Set<string>();
		const seenFileTombstones = new Set<string>();
		const pushFileTombstone = (rawHost: string | null | undefined, rawPath: string | null | undefined) => {
			const normPath = (rawPath || '').trim();
			if (!normPath) {
				return;
			}
			const normHost = (rawHost || 'local').trim() || 'local';
			dirHosts.add(normHost);
			const key = `${normHost}\0${normPath}`;
			if (!seenFileTombstones.has(key)) {
				seenFileTombstones.add(key);
				tombstones.push({ projectId, storageHost: normHost, storagePath: normPath });
			}
		};
		if (wb.storage_host) {
			dirHosts.add(wb.storage_host.trim() || 'local');
		}
		for (const b of [...itemBlobs, ...noteBlobs]) {
			pushFileTombstone(b.storage_host, b.storage_path);
		}
		for (const m of migBlobs) {
			if (m.src_host?.trim()) {
				dirHosts.add(m.src_host.trim());
			}
			if (m.dst_host?.trim()) {
				dirHosts.add(m.dst_host.trim());
			}
			pushFileTombstone(m.src_host, m.src_path);
			pushFileTombstone(m.dst_host, m.dst_path);
		}
		for (const host of dirHosts) {
			if (host === 'local') {
				tombstones.push({
					projectId,
					storageHost: 'local',
					storagePath: path.join(this.sqliteStore.localStoreRootDir, `${projectId}_${boardId}`),
					isDir: true,
				});
			} else {
				tombstones.push({
					projectId,
					storageHost: host,
					storagePath: `~/${ADE_REMOTE_STORE_DIR_NAME}/${projectId}_${boardId}`,
					isDir: true,
				});
			}
		}
		if (wb.dept_id) {
			const dept = await tx.get<IRawDepartmentRow>(`SELECT * FROM departments WHERE dept_id = ?`, [wb.dept_id]);
			if (dept) {
				const perms = parseBoardPermsJson(dept.board_permissions);
				delete perms[boardId];
				await tx.run(`UPDATE departments SET board_permissions = ?, updated_at = ? WHERE dept_id = ?`, [JSON.stringify(perms), Date.now(), wb.dept_id]);
			}
		}
		await tx.run(
			`DELETE FROM storage_migration_items WHERE scope_type = 'whiteboard' AND scope_id = ?`,
			[boardId],
		);
		await tx.run(`DELETE FROM whiteboards WHERE board_id = ?`, [boardId]);
	}

	private async loadAgentDisplayNamesInTx(runner: IAdeSqlRunner): Promise<Map<string, string>> {
		const map = new Map<string, string>();
		for (const d of await runner.all<{ agent_id: string; name: string }>(`SELECT agent_id, name FROM deleted_agents_archive`)) {
			map.set(d.agent_id, `${d.name} (已删除)`);
		}
		for (const a of await runner.all<{ agent_id: string; name: string }>(`SELECT agent_id, name FROM agents`)) {
			map.set(a.agent_id, a.name);
		}
		return map;
	}

	private async syncProjectWorkspaceRoutingRules(projectId: string): Promise<void> {
		if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
			return;
		}
		return this.trackProjectOp(projectId, async () => {
			if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
				return;
			}
			const pdb = await this.requireProjectDb(projectId);
			const snap = await pdb.withLock(async runner => {
				const meta = await runner.get<{ folder_uri: string }>(`SELECT folder_uri FROM project_meta WHERE project_id = ?`, [projectId]);
				const agents = await runner.all<IRawAgentRow>(`SELECT * FROM agents`);
				return { meta, agents };
			});
			if (!snap.meta || snap.agents.length === 0 || this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
				return;
			}

			const folderUri = URI.parse(snap.meta.folder_uri);
			const localAgents = snap.agents.filter(a => a.host === 'local');
			const hasLocalAntigravity = localAgents.some(a => a.engine === 'antigravity');
			const hasLocalClaude = localAgents.some(a => a.engine === 'claude');

			if (folderUri.scheme === Schemas.file && localAgents.length > 0) {
				const legacyClaudeLocal = hasLocalClaude ? await this.engineProber.doesHostClaudeNeedSubdirCopy('local') : false;
				if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
					return;
				}
				await this.syspromptSync.syncLocalWorkspaceRoutingFiles(folderUri.fsPath, {
					hasClaudeAgent: hasLocalClaude,
					hasLegacyClaudeOrBedrock: legacyClaudeLocal,
					hasAntigravityAgent: hasLocalAntigravity,
				});
			}

			if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
				return;
			}

			const folderIsCloud = folderUri.scheme === AEXUS_SSH_SCHEME && Boolean(folderUri.authority);
			const folderCloudHost = folderIsCloud && this.cloudHosts ? await this.cloudHosts.getHost(folderUri.authority) : undefined;
			if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
				return;
			}
			const folderHostKey = folderIsCloud ? (folderCloudHost?.hostName ?? folderUri.authority) : 'local';

			const remoteHostInfoCache = new Map<string, Awaited<ReturnType<AdeDynamicStorageEngine['resolveRemoteHostInfo']>>>();
			const claudeSubdirCache = new Map<string, boolean>();
			const checkLegacyClaude = async (hostKey: string): Promise<boolean> => {
				let cached = claudeSubdirCache.get(hostKey);
				if (cached === undefined) {
					cached = await this.engineProber.doesHostClaudeNeedSubdirCopy(hostKey);
					claudeSubdirCache.set(hostKey, cached);
				}
				return cached;
			};
			const remoteTargets = new Map<string, {
				alias: string;
				remoteCwd: string;
				hasClaudeAgent: boolean;
				hasLegacyClaudeOrBedrock: boolean;
				hasAntigravityAgent: boolean;
			}>();

			for (const ag of snap.agents) {
				if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
					return;
				}
				if (ag.host === 'local') {
					if (folderIsCloud) {
						const isolatedLocalDir = path.join(this.adeHomeDir, 'workspaces', projectId, ag.agent_id);
						const legacyClaudeLocal = ag.engine === 'claude' ? await checkLegacyClaude('local') : false;
						if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
							return;
						}
						await this.syspromptSync.syncLocalWorkspaceRoutingFiles(isolatedLocalDir, {
							hasClaudeAgent: ag.engine === 'claude',
							hasLegacyClaudeOrBedrock: legacyClaudeLocal,
							hasAntigravityAgent: ag.engine === 'antigravity',
						});
					}
					continue;
				}
				let info = remoteHostInfoCache.get(ag.host);
				if (!info) {
					info = await this.storageEngine.resolveRemoteHostInfo(ag.host);
					remoteHostInfoCache.set(ag.host, info);
				}
				if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
					return;
				}
				const legacyClaudeRemote = ag.engine === 'claude' ? await checkLegacyClaude(info.ip) : false;
				if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
					return;
				}
				const remoteCwd = (ag.host === folderHostKey || info.ip === folderHostKey) && folderIsCloud
					? (folderUri.path || info.remoteHome)
					: this.syspromptSync.buildRemoteIsolatedAgentWorkspaceDir(info.remoteHome, projectId, ag.agent_id);
				const dedupKey = `${info.alias}\0${remoteCwd}`;
				const existing = remoteTargets.get(dedupKey);
				if (existing) {
					existing.hasClaudeAgent = existing.hasClaudeAgent || ag.engine === 'claude';
					existing.hasLegacyClaudeOrBedrock = existing.hasLegacyClaudeOrBedrock || legacyClaudeRemote;
					existing.hasAntigravityAgent = existing.hasAntigravityAgent || ag.engine === 'antigravity';
				} else {
					remoteTargets.set(dedupKey, {
						alias: info.alias,
						remoteCwd,
						hasClaudeAgent: ag.engine === 'claude',
						hasLegacyClaudeOrBedrock: legacyClaudeRemote,
						hasAntigravityAgent: ag.engine === 'antigravity',
					});
				}
			}

			for (const target of remoteTargets.values()) {
				if (this.shuttingDown || this._isDisposed || this.isProjectDeletingOrRemoved(projectId)) {
					return;
				}
				await this.syspromptSync.syncRemoteWorkspaceRoutingFiles(target.alias, target.remoteCwd, {
					hasClaudeAgent: target.hasClaudeAgent,
					hasLegacyClaudeOrBedrock: target.hasLegacyClaudeOrBedrock,
					hasAntigravityAgent: target.hasAntigravityAgent,
				});
			}
		});
	}

	// eslint-disable-next-line local/code-must-use-super-dispose -- super.dispose() is invoked in gracefulShutdown() finally after 4-stage drain
	override dispose(): void {
		void this.gracefulShutdown();
	}
}

export { canonicalEdgePairKey };
