/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Database } from '@vscode/sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import { Sequencer } from '../../../base/common/async.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { ADE_CONTROL_DIR_NAME } from '../common/adeControl.js';
import { AdeError } from '../common/adeModels.js';

export const CATALOG_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS workspace_folders (
	folder_id    TEXT PRIMARY KEY,
	folder_uri   TEXT NOT NULL UNIQUE,
	display_name TEXT NOT NULL,
	host         TEXT NOT NULL,
	sort_order   INTEGER NOT NULL DEFAULT 0,
	collapsed    INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects_index (
	project_id TEXT PRIMARY KEY,
	folder_id  TEXT NOT NULL REFERENCES workspace_folders(folder_id) ON DELETE CASCADE,
	folder_uri TEXT NOT NULL,
	name       TEXT NOT NULL,
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_index_folder ON projects_index(folder_id, sort_order ASC);

CREATE TABLE IF NOT EXISTS remote_gc_tombstones (
	tombstone_id  TEXT PRIMARY KEY,
	project_id    TEXT NOT NULL,
	storage_host  TEXT NOT NULL,
	storage_path  TEXT NOT NULL,
	is_dir        INTEGER NOT NULL DEFAULT 0 CHECK (is_dir IN (0, 1)),
	sha256        TEXT,
	retry_count   INTEGER NOT NULL DEFAULT 0,
	next_retry_at INTEGER NOT NULL DEFAULT 0,
	last_error    TEXT,
	created_at    INTEGER NOT NULL,
	UNIQUE (storage_host, storage_path)
);
CREATE INDEX IF NOT EXISTS idx_remote_gc_due ON remote_gc_tombstones(storage_host, next_retry_at ASC);
`;

export const PROJECT_STATE_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS project_meta (
	project_id                TEXT PRIMARY KEY,
	folder_id                 TEXT NOT NULL,
	folder_uri                TEXT NOT NULL,
	name                      TEXT NOT NULL,
	cross_host_ticket_storage TEXT NOT NULL DEFAULT 'local',
	ticket_migration_epoch    INTEGER NOT NULL DEFAULT 0,
	ticket_migration_state    TEXT NOT NULL DEFAULT 'idle' CHECK (ticket_migration_state IN ('idle', 'transferring', 'completed', 'failed')),
	layout_direction          TEXT NOT NULL DEFAULT 'TD' CHECK (layout_direction IN ('TD', 'LR', 'RADIAL', 'GRID')),
	created_at                INTEGER NOT NULL,
	updated_at                INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_hosts (
	host_id     TEXT PRIMARY KEY,
	ip          TEXT NOT NULL UNIQUE,
	name        TEXT NOT NULL,
	ssh_alias   TEXT NOT NULL,
	os_kind     TEXT NOT NULL DEFAULT 'linux' CHECK (os_kind IN ('linux', 'macos', 'windows')),
	remote_home TEXT,
	created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
	agent_id          TEXT PRIMARY KEY,
	project_id        TEXT NOT NULL REFERENCES project_meta(project_id) ON DELETE CASCADE,
	level             INTEGER NOT NULL CHECK (level >= 1),
	is_top_role       INTEGER NOT NULL CHECK (is_top_role IN (0, 1)),
	parent_id         TEXT REFERENCES agents(agent_id) DEFERRABLE INITIALLY DEFERRED,
	name              TEXT NOT NULL,
	role_summary      TEXT NOT NULL,
	host              TEXT NOT NULL,
	engine            TEXT NOT NULL,
	model             TEXT NOT NULL,
	effort            TEXT NOT NULL,
	session_phase     TEXT NOT NULL DEFAULT 'unstarted' CHECK (session_phase IN ('unstarted', 'starting', 'started')),
	session_started   INTEGER NOT NULL DEFAULT 0 CHECK (
		(session_phase = 'unstarted' AND session_started = 0) OR
		(session_phase IN ('starting', 'started') AND session_started = 1)
	),
	excluded_dept_ids TEXT NOT NULL DEFAULT '[]',
	session_resource  TEXT,
	native_session_id TEXT,
	last_read_doc_rev INTEGER NOT NULL DEFAULT 0,
	token_gen         INTEGER NOT NULL DEFAULT 1,
	canvas_x          REAL,
	canvas_y          REAL,
	color_token       TEXT,
	created_at        INTEGER NOT NULL,
	updated_at        INTEGER NOT NULL,
	CHECK ((is_top_role = 1 AND parent_id IS NULL AND level = 1) OR (is_top_role = 0 AND parent_id IS NOT NULL AND level > 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_agents_single_top ON agents(project_id) WHERE is_top_role = 1;
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_id);

CREATE TABLE IF NOT EXISTS deleted_agents_archive (
	agent_id     TEXT PRIMARY KEY,
	project_id   TEXT NOT NULL,
	name         TEXT NOT NULL,
	level        INTEGER NOT NULL,
	role_summary TEXT NOT NULL,
	host         TEXT NOT NULL,
	deleted_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
	dept_id           TEXT PRIMARY KEY,
	project_id        TEXT NOT NULL REFERENCES project_meta(project_id) ON DELETE CASCADE,
	name              TEXT NOT NULL,
	root_agent_id     TEXT NOT NULL UNIQUE REFERENCES agents(agent_id),
	parent_dept_id    TEXT REFERENCES departments(dept_id) ON DELETE SET NULL,
	board_permissions TEXT NOT NULL DEFAULT '{}',
	created_by        TEXT NOT NULL,
	created_at        INTEGER NOT NULL,
	updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_departments_parent ON departments(parent_dept_id);

CREATE TABLE IF NOT EXISTS whiteboards (
	board_id        TEXT PRIMARY KEY,
	project_id      TEXT NOT NULL REFERENCES project_meta(project_id) ON DELETE CASCADE,
	name            TEXT NOT NULL,
	owner_id        TEXT REFERENCES agents(agent_id) ON DELETE SET NULL,
	dept_id         TEXT REFERENCES departments(dept_id) ON DELETE SET NULL,
	storage_host    TEXT NOT NULL,
	tag_categories  TEXT NOT NULL DEFAULT '[]',
	migration_epoch INTEGER NOT NULL DEFAULT 0,
	migration_state TEXT NOT NULL DEFAULT 'idle' CHECK (migration_state IN ('idle', 'transferring', 'completed', 'failed')),
	canvas_x        REAL,
	canvas_y        REAL,
	created_at      INTEGER NOT NULL,
	updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wb_dept ON whiteboards(dept_id) WHERE dept_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS board_grants (
	board_id   TEXT NOT NULL REFERENCES whiteboards(board_id) ON DELETE CASCADE,
	agent_id   TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	permission TEXT NOT NULL CHECK (permission IN ('read', 'write', 'read_write')),
	granted_by TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (board_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_board_grants_agent ON board_grants(agent_id);

CREATE TABLE IF NOT EXISTS tickets (
	ticket_id              TEXT PRIMARY KEY,
	project_id             TEXT NOT NULL REFERENCES project_meta(project_id) ON DELETE CASCADE,
	creator_id             TEXT NOT NULL,
	peer_id                TEXT NOT NULL,
	ticket_level           INTEGER NOT NULL CHECK (ticket_level >= 1),
	from_id                TEXT NOT NULL,
	to_id                  TEXT NOT NULL,
	holder_id              TEXT REFERENCES agents(agent_id) ON DELETE SET NULL,
	delivery_mode          TEXT NOT NULL DEFAULT 'queue' CHECK (delivery_mode IN ('queue', 'steer')),
	need_return            INTEGER NOT NULL CHECK (need_return IN (0, 1)),
	current_task_id        TEXT NOT NULL,
	current_task_type      TEXT NOT NULL,
	current_task_title     TEXT NOT NULL,
	current_task_summary   TEXT NOT NULL,
	current_has_detail_ref INTEGER NOT NULL DEFAULT 0 CHECK (current_has_detail_ref IN (0, 1)),
	has_history_ref        INTEGER NOT NULL DEFAULT 0 CHECK (has_history_ref IN (0, 1)),
	status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen_orphan', 'destroyed')),
	created_at             INTEGER NOT NULL,
	updated_at             INTEGER NOT NULL,
	frozen_at              INTEGER,
	destroyed_at           INTEGER,
	CHECK ((status = 'active' AND holder_id IS NOT NULL AND holder_id = to_id) OR (status != 'active' AND holder_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_tickets_holder_active ON tickets(holder_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_tickets_pair ON tickets(creator_id, peer_id, status);

CREATE TABLE IF NOT EXISTS ticket_tasks (
	ticket_id            TEXT NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
	task_id              TEXT NOT NULL,
	seq                  INTEGER NOT NULL,
	is_archived          INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
	from_id              TEXT NOT NULL,
	to_id                TEXT NOT NULL,
	delivery_mode        TEXT NOT NULL CHECK (delivery_mode IN ('queue', 'steer')),
	need_return          INTEGER NOT NULL CHECK (need_return IN (0, 1)),
	task_type            TEXT NOT NULL,
	task_title           TEXT NOT NULL,
	summary              TEXT NOT NULL,
	has_detail_ref       INTEGER NOT NULL DEFAULT 0 CHECK (has_detail_ref IN (0, 1)),
	blob_id              TEXT,
	storage_host         TEXT,
	storage_path         TEXT,
	size_bytes           INTEGER,
	sha256               TEXT,
	content_rev          INTEGER NOT NULL DEFAULT 1,
	archived_detail_gzip BLOB,
	detail_truncated     INTEGER NOT NULL DEFAULT 0 CHECK (detail_truncated IN (0, 1)),
	created_at           INTEGER NOT NULL,
	PRIMARY KEY (ticket_id, task_id),
	UNIQUE (ticket_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_ticket_tasks_history ON ticket_tasks(ticket_id, is_archived, seq ASC);

CREATE TABLE IF NOT EXISTS edge_ticket_transfers (
	transfer_id    TEXT PRIMARY KEY,
	project_id     TEXT NOT NULL REFERENCES project_meta(project_id) ON DELETE CASCADE,
	edge_pair_key  TEXT NOT NULL,
	hop_from_id    TEXT NOT NULL,
	hop_to_id      TEXT NOT NULL,
	hop_seq        INTEGER NOT NULL DEFAULT 1,
	total_hops     INTEGER NOT NULL DEFAULT 1,
	origin_from_id TEXT NOT NULL,
	target_to_id   TEXT NOT NULL,
	ticket_id      TEXT NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
	task_id        TEXT NOT NULL,
	action_kind    TEXT NOT NULL CHECK (action_kind IN ('create', 'edit')),
	task_type      TEXT NOT NULL,
	task_title     TEXT NOT NULL,
	summary        TEXT NOT NULL,
	has_detail_ref INTEGER NOT NULL CHECK (has_detail_ref IN (0, 1)),
	transferred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edge_transfers_pair_time ON edge_ticket_transfers(edge_pair_key, transferred_at DESC);

CREATE TABLE IF NOT EXISTS whiteboard_items (
	item_id        TEXT PRIMARY KEY,
	board_id       TEXT NOT NULL REFERENCES whiteboards(board_id) ON DELETE CASCADE,
	item_type      TEXT NOT NULL CHECK (item_type IN ('msg', 'file')),
	author_id      TEXT NOT NULL,
	summary        TEXT NOT NULL,
	stars          INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
	tags           TEXT NOT NULL DEFAULT '[]',
	is_pinned      INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
	has_detail     INTEGER NOT NULL DEFAULT 0 CHECK (has_detail IN (0, 1)),
	file_filename  TEXT,
	file_size      INTEGER,
	detail_size    INTEGER,
	blob_id        TEXT,
	storage_host   TEXT,
	storage_path   TEXT,
	sha256         TEXT,
	content_rev    INTEGER NOT NULL DEFAULT 1,
	created_at     INTEGER NOT NULL,
	updated_at     INTEGER NOT NULL,
	CHECK ((item_type = 'msg' AND file_filename IS NULL AND file_size IS NULL)
		OR (item_type = 'file' AND has_detail = 0 AND file_filename IS NOT NULL AND file_size IS NOT NULL AND detail_size IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_wb_items_time ON whiteboard_items(board_id, is_pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wb_items_stars ON whiteboard_items(board_id, is_pinned DESC, stars DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wb_items_author ON whiteboard_items(board_id, author_id, is_pinned DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS whiteboard_notes (
	note_id         TEXT PRIMARY KEY,
	board_id        TEXT NOT NULL REFERENCES whiteboards(board_id) ON DELETE CASCADE,
	from_id         TEXT NOT NULL,
	to_id           TEXT NOT NULL,
	content_preview TEXT NOT NULL,
	has_detail      INTEGER NOT NULL DEFAULT 0 CHECK (has_detail IN (0, 1)),
	blob_id         TEXT,
	storage_host    TEXT,
	storage_path    TEXT,
	size_bytes      INTEGER,
	sha256          TEXT,
	content_rev     INTEGER NOT NULL DEFAULT 1,
	is_read         INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
	created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wb_notes_unread ON whiteboard_notes(board_id, to_id, is_read, created_at ASC);

CREATE TABLE IF NOT EXISTS ticket_delivery_outbox (
	delivery_id          TEXT PRIMARY KEY,
	ticket_id            TEXT NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
	task_id              TEXT NOT NULL,
	target_agent_id      TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	delivery_mode        TEXT NOT NULL CHECK (delivery_mode IN ('queue', 'steer')),
	payload_text         TEXT NOT NULL,
	state                TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'in_flight', 'dead_letter')),
	claimed_by_window_id INTEGER,
	leased_until         INTEGER,
	attempts             INTEGER NOT NULL DEFAULT 0,
	next_retry_at        INTEGER NOT NULL DEFAULT 0,
	last_error           TEXT,
	created_at           INTEGER NOT NULL,
	UNIQUE (ticket_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON ticket_delivery_outbox(state, next_retry_at ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_outbox_window ON ticket_delivery_outbox(claimed_by_window_id) WHERE state = 'in_flight';

CREATE TABLE IF NOT EXISTS storage_migration_items (
	migration_item_id TEXT PRIMARY KEY,
	scope_type        TEXT NOT NULL CHECK (scope_type IN ('whiteboard', 'ticket')),
	scope_id          TEXT NOT NULL,
	epoch             INTEGER NOT NULL,
	entity_table      TEXT NOT NULL CHECK (entity_table IN ('whiteboard_items', 'whiteboard_notes', 'ticket_tasks')),
	entity_pk_1       TEXT NOT NULL,
	entity_pk_2       TEXT NOT NULL DEFAULT '',
	expected_rev      INTEGER NOT NULL,
	expected_sha256   TEXT NOT NULL,
	size_bytes        INTEGER NOT NULL,
	src_host          TEXT NOT NULL,
	src_path          TEXT NOT NULL,
	dst_host          TEXT NOT NULL,
	dst_path          TEXT NOT NULL,
	phase             TEXT NOT NULL DEFAULT 'pending' CHECK (phase IN ('pending', 'copied', 'switched', 'cleaned', 'skipped', 'failed')),
	retry_count       INTEGER NOT NULL DEFAULT 0,
	last_error        TEXT,
	updated_at        INTEGER NOT NULL,
	UNIQUE (scope_type, scope_id, epoch, entity_table, entity_pk_1, entity_pk_2)
);
CREATE INDEX IF NOT EXISTS idx_migration_active ON storage_migration_items(scope_type, scope_id, epoch, phase);
`;

let cachedSqliteModPromise: Promise<typeof import('@vscode/sqlite3')> | undefined;

async function loadVscodeSqlite3(): Promise<typeof import('@vscode/sqlite3')> {
	if (!cachedSqliteModPromise) {
		cachedSqliteModPromise = import('@vscode/sqlite3').then(mod => (mod.default ?? mod) as typeof import('@vscode/sqlite3'));
	}
	return cachedSqliteModPromise;
}

export interface IAdeSqlRunner {
	exec(sql: string): Promise<void>;
	run(sql: string, params?: readonly unknown[]): Promise<{ readonly lastID: number; readonly changes: number }>;
	get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
	all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

/**
 * Single read/write SQLite connection serialized by a `Sequencer` with `BEGIN IMMEDIATE` transactions.
 */
export class AdeSingleSqliteDatabase implements IAdeSqlRunner {
	private readonly sequencer = new Sequencer();
	private dbPromise: Promise<Database> | undefined;
	private rawDb: Database | undefined;
	private closePromise: Promise<void> | undefined;
	private closed = false;

	constructor(
		public readonly dbPath: string,
		private readonly schemaDdl: string,
	) { }

	private ensureOpen(): Promise<Database> {
		if (this.closed) {
			return Promise.reject(new Error(`SQLite database already closed: ${this.dbPath}`));
		}
		if (!this.dbPromise) {
			this.dbPromise = this.doOpen().catch(err => {
				this.dbPromise = undefined;
				throw err;
			});
		}
		return this.dbPromise;
	}

	private async doOpen(): Promise<Database> {
		if (this.closed) {
			throw new Error(`SQLite database already closed: ${this.dbPath}`);
		}
		if (this.dbPath !== ':memory:') {
			const dir = path.dirname(this.dbPath);
			await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
			if (!isWindows) {
				await fs.promises.chmod(dir, 0o700).catch(() => undefined);
			}
		}
		const sqlite3 = await loadVscodeSqlite3();
		const db = await new Promise<Database>((resolve, reject) => {
			const instance = new sqlite3.Database(this.dbPath, err => {
				if (err) {
					reject(err);
				} else {
					resolve(instance);
				}
			});
		});

		try {
			await this.rawExec(db, 'PRAGMA busy_timeout = 5000;');
			let walOk = false;
			try {
				const modeRow = await this.rawGet<{ journal_mode?: string }>(db, 'PRAGMA journal_mode = WAL;');
				walOk = String(modeRow?.journal_mode ?? '').toLowerCase() === 'wal';
			} catch {
				walOk = false;
			}
			if (!walOk) {
				await this.rawExec(db, 'PRAGMA journal_mode = TRUNCATE;').catch(() => undefined);
			}
			await this.rawExec(db, 'PRAGMA synchronous = NORMAL;');
			await this.rawExec(db, 'PRAGMA foreign_keys = ON;');
			await this.rawExec(db, this.schemaDdl);
			const wbItemCols = await this.rawAll<{ name?: string }>(db, 'PRAGMA table_info(whiteboard_items);');
			if (wbItemCols.length > 0 && !wbItemCols.some(col => col.name === 'detail_size')) {
				await this.rawExec(db, 'ALTER TABLE whiteboard_items ADD COLUMN detail_size INTEGER;');
			}
			if (this.dbPath !== ':memory:' && !isWindows) {
				await fs.promises.chmod(this.dbPath, 0o600).catch(() => undefined);
			}
			this.rawDb = db;
			return db;
		} catch (err) {
			await new Promise<void>(resolve => db.close(() => resolve()));
			throw err;
		}
	}

	private rawExec(db: Database, sql: string): Promise<void> {
		return new Promise((resolve, reject) => {
			db.exec(sql, err => (err ? reject(err) : resolve()));
		});
	}

	private rawRun(db: Database, sql: string, params: readonly unknown[] = []): Promise<{ readonly lastID: number; readonly changes: number }> {
		return new Promise((resolve, reject) => {
			db.run(sql, [...params], function (err) {
				if (err) {
					reject(err);
				} else {
					resolve({ lastID: this.lastID ?? 0, changes: this.changes ?? 0 });
				}
			});
		});
	}

	private rawGet<T>(db: Database, sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
		return new Promise((resolve, reject) => {
			db.get(sql, [...params], (err, row) => (err ? reject(err) : resolve(row as T | undefined)));
		});
	}

	private rawAll<T>(db: Database, sql: string, params: readonly unknown[] = []): Promise<T[]> {
		return new Promise((resolve, reject) => {
			db.all(sql, [...params], (err, rows) => (err ? reject(err) : resolve((rows ?? []) as T[])));
		});
	}

	exec(sql: string): Promise<void> {
		return this.sequencer.queue(async () => {
			const db = await this.ensureOpen();
			await this.rawExec(db, sql);
		});
	}

	run(sql: string, params: readonly unknown[] = []): Promise<{ readonly lastID: number; readonly changes: number }> {
		return this.sequencer.queue(async () => {
			const db = await this.ensureOpen();
			return this.rawRun(db, sql, params);
		});
	}

	get<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
		return this.sequencer.queue(async () => {
			const db = await this.ensureOpen();
			return this.rawGet<T>(db, sql, params);
		});
	}

	all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
		return this.sequencer.queue(async () => {
			const db = await this.ensureOpen();
			return this.rawAll<T>(db, sql, params);
		});
	}

	/**
	 * Executes `fn` inside a serialized `Sequencer` slot WITHOUT starting a transaction
	 * (useful for atomic multi-query read snapshots + synchronous `pinBlobForRead(+1)`).
	 */
	withLock<T>(fn: (runner: IAdeSqlRunner) => Promise<T>): Promise<T> {
		return this.sequencer.queue(async () => {
			const db = await this.ensureOpen();
			const runner: IAdeSqlRunner = {
				exec: sql => this.rawExec(db, sql),
				run: (sql, params) => this.rawRun(db, sql, params),
				get: <R>(sql: string, params?: readonly unknown[]) => this.rawGet<R>(db, sql, params),
				all: <R>(sql: string, params?: readonly unknown[]) => this.rawAll<R>(db, sql, params),
			};
			return fn(runner);
		});
	}

	/**
	 * Executes `fn` inside a serialized `BEGIN IMMEDIATE ... COMMIT` transaction (`ROLLBACK` on throw).
	 */
	transaction<T>(fn: (tx: IAdeSqlRunner) => Promise<T>): Promise<T> {
		return this.sequencer.queue(async () => {
			const db = await this.ensureOpen();
			await this.rawExec(db, 'BEGIN IMMEDIATE;');
			const tx: IAdeSqlRunner = {
				exec: sql => this.rawExec(db, sql),
				run: (sql, params) => this.rawRun(db, sql, params),
				get: <R>(sql: string, params?: readonly unknown[]) => this.rawGet<R>(db, sql, params),
				all: <R>(sql: string, params?: readonly unknown[]) => this.rawAll<R>(db, sql, params),
			};
			try {
				const result = await fn(tx);
				await this.rawExec(db, 'COMMIT;');
				return result;
			} catch (err) {
				await this.rawExec(db, 'ROLLBACK;').catch(() => undefined);
				throw err;
			}
		});
	}

	async listTables(): Promise<string[]> {
		const rows = await this.all<{ name: string }>(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`,
		);
		return rows.map(r => r.name);
	}

	checkpointAndClose(): Promise<void> {
		if (!this.closePromise) {
			this.closePromise = this.sequencer.queue(async () => {
				this.closed = true;
				const db = this.rawDb ?? (this.dbPromise ? await this.dbPromise.catch(() => undefined) : undefined);
				this.rawDb = undefined;
				this.dbPromise = undefined;
				if (!db) {
					return;
				}
				await this.rawExec(db, 'PRAGMA wal_checkpoint(TRUNCATE);').catch(() => undefined);
				await new Promise<void>(resolve => db.close(() => resolve()));
			});
		}
		return this.closePromise;
	}
}

export interface IAdeSqliteStoreOptions {
	/** Root `~/.aexus-code` directory override (isolated per test suite). */
	readonly adeHomeDir?: string;
}

/**
 * Dual-tier SQLite WAL store:
 * - Tier 1: `<adeHomeDir>/control-center/catalog.db` (3 global tables)
 * - Tier 2: `<adeHomeDir>/control-center/projects/<project_id>/state.db` (14 per-project tables)
 */
export class AdeSqliteStore extends Disposable {
	readonly adeHomeDir: string;
	readonly controlCenterDir: string;
	readonly projectsRootDir: string;
	readonly localStoreRootDir: string;
	readonly catalog: AdeSingleSqliteDatabase;

	private readonly projectDbs = new Map<string, AdeSingleSqliteDatabase>();
	private readonly removedProjectIds = new Set<string>();
	private readonly projectCloseLocks = new Map<string, Promise<void>>();
	private shuttingDown = false;
	private shutdownPromise: Promise<void> | undefined;

	constructor(options?: IAdeSqliteStoreOptions) {
		super();
		this.adeHomeDir = options?.adeHomeDir ?? path.join(os.homedir(), ADE_CONTROL_DIR_NAME);
		this.controlCenterDir = path.join(this.adeHomeDir, 'control-center');
		this.projectsRootDir = path.join(this.controlCenterDir, 'projects');
		this.localStoreRootDir = path.join(this.adeHomeDir, 'ade-store');
		this.catalog = new AdeSingleSqliteDatabase(
			path.join(this.controlCenterDir, 'catalog.db'),
			CATALOG_SCHEMA_DDL,
		);
	}

	getProjectDir(projectId: string): string {
		const safeId = projectId.replace(/[^A-Za-z0-9_.-]/g, '_');
		return path.join(this.projectsRootDir, safeId);
	}

	getProjectDbPath(projectId: string): string {
		return path.join(this.getProjectDir(projectId), 'state.db');
	}

	/**
	 * Explicitly clears any prior deletion tombstone for `projectId` when creating a brand-new project.
	 */
	registerOrClearRemovedProject(projectId: string): void {
		this.removedProjectIds.delete(projectId);
	}

	isProjectRemovedOrClosing(projectId: string): boolean {
		return this.removedProjectIds.has(projectId) || this.projectCloseLocks.has(projectId);
	}

	async hasProjectDbOnDiskOrOpen(projectId: string): Promise<boolean> {
		if (this.shuttingDown || this.isProjectRemovedOrClosing(projectId)) {
			return false;
		}
		if (this.projectDbs.has(projectId)) {
			return true;
		}
		const exists = await fs.promises.stat(this.getProjectDbPath(projectId)).then(st => st.isFile(), () => false);
		return exists && !this.shuttingDown && !this.isProjectRemovedOrClosing(projectId);
	}

	/**
	 * Safe non-resurrecting accessor for cross-project polling loops (`claimPendingDeliveries`,
	 * `listAllBoundSessionResources`, `resolveAgentBySessionResource`, `migrateCloudHostAlias`, etc.).
	 * Returns `undefined` when the store is shutting down, the project is removed/closing, or its `state.db` is absent.
	 */
	async tryOpenActiveProjectDb(projectId: string): Promise<AdeSingleSqliteDatabase | undefined> {
		if (this.shuttingDown || this.isProjectRemovedOrClosing(projectId)) {
			return undefined;
		}
		if (!this.projectDbs.has(projectId) && !(await this.hasProjectDbOnDiskOrOpen(projectId))) {
			return undefined;
		}
		if (this.shuttingDown || this.isProjectRemovedOrClosing(projectId)) {
			return undefined;
		}
		return this.openProjectDb(projectId);
	}

	openProjectDb(projectId: string): AdeSingleSqliteDatabase {
		if (this.shuttingDown) {
			throw new Error('AdeSqliteStore is shutting down');
		}
		if (this.removedProjectIds.has(projectId) || this.projectCloseLocks.has(projectId)) {
			throw new AdeError('ERR_INVALID_ARGS', `项目数据库已删除或正在关闭，拒绝重新创建: ${projectId}`);
		}
		let db = this.projectDbs.get(projectId);
		if (!db) {
			db = new AdeSingleSqliteDatabase(this.getProjectDbPath(projectId), PROJECT_STATE_SCHEMA_DDL);
			this.projectDbs.set(projectId, db);
		}
		return db;
	}

	closeAndRemoveProjectDb(projectId: string): Promise<void> {
		this.removedProjectIds.add(projectId);
		let pendingClose = this.projectCloseLocks.get(projectId);
		if (!pendingClose) {
			const closeTask = (async () => {
				const db = this.projectDbs.get(projectId);
				this.projectDbs.delete(projectId);
				if (db) {
					await db.checkpointAndClose().catch(() => undefined);
				}
				const dir = this.getProjectDir(projectId);
				await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
			})().finally(() => {
				this.projectCloseLocks.delete(projectId);
			});
			this.projectCloseLocks.set(projectId, closeTask);
			pendingClose = closeTask;
		}
		return pendingClose;
	}

	shutdownAll(): Promise<void> {
		if (!this.shutdownPromise) {
			this.shuttingDown = true;
			this.shutdownPromise = (async () => {
				if (this.projectCloseLocks.size > 0) {
					await Promise.allSettled([...this.projectCloseLocks.values()]);
				}
				const dbs = [...this.projectDbs.values()];
				this.projectDbs.clear();
				await Promise.all(dbs.map(d => d.checkpointAndClose().catch(() => undefined)));
				await this.catalog.checkpointAndClose().catch(() => undefined);
			})();
		}
		return this.shutdownPromise;
	}

	override dispose(): void {
		void this.shutdownAll();
		super.dispose();
	}
}
