/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Database } from '@vscode/sqlite3';
import * as crypto from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import * as os from 'os';
import { parse, ParseError, ParseOptions } from '../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../base/common/jsonEdit.js';
import * as path from '../../../base/common/path.js';
import { isMacintosh, isWindows } from '../../../base/common/platform.js';
import { ILogService } from '../../log/common/log.js';

export interface IDefaultVsCodePaths {
	readonly userDataDir: string;
	readonly extensionsDir: string;
}

export interface IMigrateVsCodeSettingsOptions {
	readonly vsCodeSettingsPath?: string;
	readonly aexusSettingsPath: string;
	readonly logService?: ILogService;
}

export interface IMigrateVsCodeStateAndExtensionsOptions {
	readonly vsCodeUserDataDir?: string;
	readonly vsCodeExtensionsDir?: string;
	readonly aexusGlobalStorageDir: string;
	readonly aexusExtensionsDir: string;
	readonly logService?: ILogService;
}

export interface IMigrateVsCodeStateAndExtensionsResult {
	readonly updatedStateKeys: string[];
	readonly copiedStorageFiles: number;
	readonly copiedExtensions: string[];
}

const REJECTED_SETTING_PREFIXES = [
	'chat.',
	'github.copilot',
	'workbench.secondarySideBar.',
	'workbench.sideBar.',
	'workbench.activityBar.',
	'workbench.panel.',
	'workbench.statusBar.',
	'window.titleBarStyle',
] as const;

const ALLOWED_SETTING_PREFIXES = [
	'http.',
	'antigravity.',
	'claudeCode.',
	'chatgpt.',
	'kilo-code.',
	'opencode-ui.',
	'opencode.',
	'dsh.',
	'piAgent.',
	'pi-vscode.',
	'cline.',
	'claude-dev.',
	'roo-cline.',
	'gemini.',
	'security.workspace.trust.',
	'workbench.editor.autoLockGroups',
	'terminal.integrated.',
	'remote.SSH.',
	'git.',
	'github.gitAuthentication',
	'explorer.',
	'python.',
	'python-envs.',
	'parallels-desktop.',
	'accessibility.signals.',
] as const;

const TARGET_STATE_KEYS = [
	'google.google-antigravity',
	'kilocode.kilo-code',
	'Anthropic.claude-code',
	'openai.chatgpt',
	'saoudrizwan.claude-dev',
	'Fengze233.dsh-vscode-panel',
	'zgy.opencode-vscode-ui',
	'yesho.pi-coding-agent-vscode',
	'sst-dev.opencode',
	'harcochen.dsh-vsc-integration',
	'ms-vscode-remote.remote-ssh',
	'ms-vscode.remote-explorer',
	'alefragnani.project-manager',
] as const;

const TARGET_STORAGE_EXTENSION_DIRS = [
	'anthropic.claude-code',
	'kilocode.kilo-code',
	'saoudrizwan.claude-dev',
	'fengze233.dsh-vscode-panel',
	'google.google-antigravity',
	'openai.chatgpt',
	'zgy.opencode-vscode-ui',
	'yesho.pi-coding-agent-vscode',
	'ms-vscode-remote.remote-ssh',
	'alefragnani.project-manager',
] as const;

const TARGET_CODING_AGENT_EXTENSION_IDS = [
	'anthropic.claude-code',
	'openai.chatgpt',
	'openai.codex-audio',
	'kilocode.kilo-code',
	'zgy.opencode-vscode-ui',
	'sst-dev.opencode',
	'saoudrizwan.claude-dev',
	'fengze233.dsh-vscode-panel',
	'google.google-antigravity',
	'yesho.pi-coding-agent-vscode',
	'ms-vscode-remote.remote-ssh',
	'ms-vscode-remote.remote-ssh-edit',
	'ms-vscode.remote-explorer',
	'alefragnani.project-manager',
] as const;

const MAX_STORAGE_FILE_BYTES = 50 * 1024 * 1024;
const SQLITE_BUSY_TIMEOUT_MS = 2000;

export function resolveDefaultVsCodePaths(homedir = os.homedir(), env: NodeJS.ProcessEnv = process.env): IDefaultVsCodePaths {
	let userDataDir: string;
	if (isMacintosh) {
		userDataDir = path.join(homedir, 'Library', 'Application Support', 'Code');
	} else if (isWindows) {
		userDataDir = path.join(env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), 'Code');
	} else {
		userDataDir = path.join(env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'Code');
	}
	return {
		userDataDir,
		extensionsDir: path.join(homedir, '.vscode', 'extensions'),
	};
}

function matchesPrefix(key: string, prefix: string): boolean {
	if (prefix.endsWith('.')) {
		return key.startsWith(prefix);
	}
	return key === prefix || key.startsWith(`${prefix}.`);
}

export function shouldMigrateVsCodeSettingKey(key: string): boolean {
	for (const rejected of REJECTED_SETTING_PREFIXES) {
		if (matchesPrefix(key, rejected)) {
			return false;
		}
	}
	for (const allowed of ALLOWED_SETTING_PREFIXES) {
		if (matchesPrefix(key, allowed)) {
			return true;
		}
	}
	return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mergeMissingJsonObject(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...target };
	for (const [key, sourceVal] of Object.entries(source)) {
		if (!Object.prototype.hasOwnProperty.call(result, key)) {
			result[key] = sourceVal;
			continue;
		}
		const targetVal = result[key];
		if (isPlainObject(targetVal) && isPlainObject(sourceVal)) {
			result[key] = mergeMissingJsonObject(targetVal, sourceVal);
		}
	}
	return result;
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
	await fs.writeFile(tempPath, content, 'utf8');
	await fs.rename(tempPath, filePath);
}

function parseJsoncObject(raw: string): Record<string, unknown> | undefined {
	const errors: ParseError[] = [];
	const parsed = parse(raw, errors, ParseOptions.DEFAULT);
	if (errors.length > 0 || !isPlainObject(parsed)) {
		return undefined;
	}
	return parsed;
}

export async function migrateVsCodeSettingsToAexus(options: IMigrateVsCodeSettingsOptions): Promise<{ updatedKeys: string[] }> {
	const defaultPaths = resolveDefaultVsCodePaths();
	const vsCodeSettingsPath = options.vsCodeSettingsPath ?? path.join(defaultPaths.userDataDir, 'User', 'settings.json');

	let vsRaw: string;
	try {
		vsRaw = await fs.readFile(vsCodeSettingsPath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { updatedKeys: [] };
		}
		options.logService?.warn(`[AdeMigration] Failed to read VS Code settings (${vsCodeSettingsPath}): ${error}`);
		return { updatedKeys: [] };
	}

	const vsObj = parseJsoncObject(vsRaw);
	if (!vsObj) {
		return { updatedKeys: [] };
	}

	let aexusContent: string;
	let aexusObj: Record<string, unknown>;
	try {
		const existingRaw = await fs.readFile(options.aexusSettingsPath, 'utf8');
		if (!existingRaw.trim()) {
			aexusContent = '{\n}\n';
			aexusObj = {};
		} else {
			const parsedExisting = parseJsoncObject(existingRaw);
			if (!parsedExisting) {
				options.logService?.warn(`[AdeMigration] Existing Aexus settings is not a valid JSON object; skipping settings migration.`);
				return { updatedKeys: [] };
			}
			aexusContent = existingRaw;
			aexusObj = parsedExisting;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			options.logService?.warn(`[AdeMigration] Failed to read Aexus settings (${options.aexusSettingsPath}): ${error}`);
			return { updatedKeys: [] };
		}
		aexusContent = '{\n}\n';
		aexusObj = {};
	}

	const updatedKeys: string[] = [];
	const formatOptions = { tabSize: 4, insertSpaces: false };

	for (const [key, vsVal] of Object.entries(vsObj)) {
		if (vsVal === undefined || !shouldMigrateVsCodeSettingKey(key)) {
			continue;
		}

		let nextVal: unknown;
		let shouldWrite = false;
		const hasExisting = Object.prototype.hasOwnProperty.call(aexusObj, key);

		if (key === 'terminal.integrated.commandsToSkipShell' && hasExisting && Array.isArray(aexusObj[key]) && Array.isArray(vsVal)) {
			const existingArr = (aexusObj[key] as unknown[]).filter((item): item is string => typeof item === 'string');
			const existingSet = new Set(existingArr);
			const additions = vsVal.filter((item): item is string => typeof item === 'string' && !existingSet.has(item));
			if (additions.length > 0) {
				nextVal = [...existingArr, ...additions];
				shouldWrite = true;
			}
		} else if (key === 'workbench.editor.autoLockGroups' && hasExisting && isPlainObject(aexusObj[key]) && isPlainObject(vsVal)) {
			const existingGroups = aexusObj[key] as Record<string, unknown>;
			const merged = mergeMissingJsonObject(existingGroups, vsVal);
			if (Object.keys(merged).length > Object.keys(existingGroups).length) {
				nextVal = merged;
				shouldWrite = true;
			}
		} else if (!hasExisting) {
			nextVal = vsVal;
			shouldWrite = true;
		}

		if (shouldWrite) {
			aexusContent = applyEdits(aexusContent, setProperty(aexusContent, [key], nextVal, formatOptions));
			aexusObj[key] = nextVal;
			updatedKeys.push(key);
		}
	}

	if (updatedKeys.length > 0) {
		await writeTextAtomic(options.aexusSettingsPath, aexusContent);
		options.logService?.info(`[AdeMigration] Migrated ${updatedKeys.length} VS Code setting(s): ${updatedKeys.join(', ')}`);
	}

	return { updatedKeys };
}

async function openSqliteDatabase(dbPath: string, mode: number): Promise<Database> {
	const sqlite3 = await import('@vscode/sqlite3');
	return new Promise<Database>((resolve, reject) => {
		const db = new sqlite3.default.Database(dbPath, mode, (error: Error | null) => {
			if (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== 'SQLITE_CANTOPEN') {
					db.close(() => reject(error));
				} else {
					reject(error);
				}
				return;
			}
			db.configure('busyTimeout', SQLITE_BUSY_TIMEOUT_MS);
			resolve(db);
		});
	});
}

function closeSqliteDatabase(db: Database): Promise<void> {
	return new Promise((resolve, reject) => {
		db.close((error: Error | null) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

function execSqlite(db: Database, sql: string): Promise<void> {
	return new Promise((resolve, reject) => {
		db.exec(sql, (error: Error | null) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

function allSqliteRows(db: Database, sql: string, params: readonly unknown[]): Promise<Array<{ key: string; value: string | Buffer }>> {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (error: Error | null, rows: unknown[]) => {
			if (error) {
				reject(error);
			} else {
				resolve(rows as Array<{ key: string; value: string | Buffer }>);
			}
		});
	});
}

function runSqliteStatement(db: Database, sql: string, params: readonly unknown[]): Promise<void> {
	return new Promise((resolve, reject) => {
		db.run(sql, params, (error: Error | null) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

function rowValueToString(value: string | Buffer | null | undefined): string | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}
	return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

async function migrateStateDbKeys(
	vsCodeDbPath: string,
	aexusDbPath: string,
	logService?: ILogService,
): Promise<string[]> {
	try {
		await fs.access(vsCodeDbPath);
	} catch {
		return [];
	}

	const sqlite3 = await import('@vscode/sqlite3');
	const placeholders = TARGET_STATE_KEYS.map(() => '?').join(', ');
	const selectSql = `SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`;

	let vsRows: Array<{ key: string; value: string | Buffer }> = [];
	const vsDb = await openSqliteDatabase(vsCodeDbPath, sqlite3.default.OPEN_READONLY).catch(() => undefined);
	if (!vsDb) {
		return [];
	}
	try {
		vsRows = await allSqliteRows(vsDb, selectSql, TARGET_STATE_KEYS).catch(() => []);
	} finally {
		await closeSqliteDatabase(vsDb).catch(() => undefined);
	}

	if (vsRows.length === 0) {
		return [];
	}

	await fs.mkdir(path.dirname(aexusDbPath), { recursive: true });
	const aexusDb = await openSqliteDatabase(aexusDbPath, sqlite3.default.OPEN_READWRITE | sqlite3.default.OPEN_CREATE);
	const updatedKeys: string[] = [];

	try {
		await execSqlite(aexusDb, 'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);');
		const existingRows = await allSqliteRows(aexusDb, selectSql, TARGET_STATE_KEYS);
		const existingMap = new Map<string, string>();
		for (const row of existingRows) {
			if (row.key.startsWith('secret://')) {
				continue;
			}
			const strVal = rowValueToString(row.value);
			if (strVal !== undefined) {
				existingMap.set(row.key, strVal);
			}
		}

		const pendingWrites: Array<{ key: string; value: string }> = [];
		for (const row of vsRows) {
			if (row.key.startsWith('secret://')) {
				continue;
			}
			const vsValStr = rowValueToString(row.value);
			if (!vsValStr) {
				continue;
			}
			let vsParsed: unknown;
			try {
				vsParsed = JSON.parse(vsValStr);
			} catch {
				continue;
			}
			if (!isPlainObject(vsParsed)) {
				continue;
			}

			const existingStr = existingMap.get(row.key);
			let existingParsed: Record<string, unknown> | undefined;
			if (existingStr !== undefined) {
				try {
					const parsed = JSON.parse(existingStr) as unknown;
					if (!isPlainObject(parsed)) {
						continue;
					}
					existingParsed = parsed;
				} catch {
					continue;
				}
			}

			let merged = existingParsed ? mergeMissingJsonObject(existingParsed, vsParsed) : { ...vsParsed };
			if (row.key === 'ms-vscode-remote.remote-ssh') {
				for (const subKey of Object.keys(merged)) {
					if (subKey.startsWith('auth-prompt-')) {
						delete merged[subKey];
					}
				}
			}
			if (row.key === 'saoudrizwan.claude-dev' && (existingParsed?.welcomeViewCompleted === true || vsParsed.welcomeViewCompleted === true)) {
				merged = { ...merged, welcomeViewCompleted: true };
			}

			const nextStr = JSON.stringify(merged);
			if (nextStr !== existingStr) {
				pendingWrites.push({ key: row.key, value: nextStr });
				updatedKeys.push(row.key);
			}
		}

		if (pendingWrites.length > 0) {
			await execSqlite(aexusDb, 'BEGIN TRANSACTION;');
			try {
				for (const item of pendingWrites) {
					await runSqliteStatement(aexusDb, 'INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?);', [item.key, item.value]);
				}
				await execSqlite(aexusDb, 'COMMIT;');
			} catch (error) {
				await execSqlite(aexusDb, 'ROLLBACK;').catch(() => undefined);
				throw error;
			}
			logService?.info(`[AdeMigration] Migrated ${updatedKeys.length} state.vscdb key(s): ${updatedKeys.join(', ')}`);
		}
	} finally {
		await closeSqliteDatabase(aexusDb);
	}

	return updatedKeys;
}

function shouldSkipStorageFilename(name: string): boolean {
	return name.startsWith('.#') || name.endsWith('.lock') || name.endsWith('.tmp') || name === '.DS_Store';
}

async function copyMissingStorageFiles(srcDir: string, dstDir: string): Promise<number> {
	let entries;
	try {
		entries = await fs.readdir(srcDir, { withFileTypes: true });
	} catch {
		return 0;
	}

	await fs.mkdir(dstDir, { recursive: true });
	let copiedCount = 0;

	for (const entry of entries) {
		if (entry.isSymbolicLink() || shouldSkipStorageFilename(entry.name)) {
			continue;
		}
		const srcPath = path.join(srcDir, entry.name);
		const dstPath = path.join(dstDir, entry.name);
		if (entry.isDirectory()) {
			copiedCount += await copyMissingStorageFiles(srcPath, dstPath);
			continue;
		}
		if (!entry.isFile()) {
			continue;
		}
		try {
			const stat = await fs.stat(srcPath);
			if (stat.size > MAX_STORAGE_FILE_BYTES) {
				continue;
			}
			await fs.copyFile(srcPath, dstPath, fsConstants.COPYFILE_EXCL);
			copiedCount++;
		} catch {
			// Skip files that already exist or cannot be copied safely.
		}
	}

	return copiedCount;
}

interface IExtensionRegistryEntry {
	readonly identifier?: {
		readonly id?: string;
		readonly uuid?: string;
	};
	readonly version?: string;
	readonly location?: {
		readonly $mid?: number;
		readonly path?: string;
		readonly scheme?: string;
	};
	readonly relativeLocation?: string;
	readonly metadata?: Record<string, unknown>;
	readonly [key: string]: unknown;
}

async function readExtensionsJson(extensionsDir: string): Promise<IExtensionRegistryEntry[]> {
	try {
		const raw = await fs.readFile(path.join(extensionsDir, 'extensions.json'), 'utf8');
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is IExtensionRegistryEntry => isPlainObject(item)) : [];
	} catch {
		return [];
	}
}

async function copyExtensionDirectory(srcDir: string, dstDir: string, rootDstDir: string = dstDir): Promise<void> {
	await fs.mkdir(dstDir, { recursive: true });
	const normalizedRoot = path.resolve(rootDstDir);
	const entries = await fs.readdir(srcDir, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = path.join(srcDir, entry.name);
		const dstPath = path.join(dstDir, entry.name);
		if (entry.isDirectory()) {
			await copyExtensionDirectory(srcPath, dstPath, normalizedRoot);
		} else if (entry.isFile()) {
			await fs.copyFile(srcPath, dstPath);
			const stat = await fs.lstat(srcPath);
			await fs.chmod(dstPath, stat.mode & 0o777).catch(() => undefined);
		} else if (entry.isSymbolicLink()) {
			const linkTarget = await fs.readlink(srcPath);
			if (!path.isAbsolute(linkTarget)) {
				const resolvedTarget = path.resolve(path.dirname(dstPath), linkTarget);
				const rel = path.relative(normalizedRoot, resolvedTarget);
				if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
					await fs.symlink(linkTarget, dstPath).catch(() => undefined);
				}
			}
		}
	}
}

async function migrateMissingCodingAgentExtensions(
	vsCodeExtensionsDir: string,
	aexusExtensionsDir: string,
	logService?: ILogService,
): Promise<string[]> {
	let vsDirEntries;
	try {
		vsDirEntries = await fs.readdir(vsCodeExtensionsDir, { withFileTypes: true });
	} catch {
		return [];
	}

	await fs.mkdir(aexusExtensionsDir, { recursive: true });
	const aexusDirEntries = await fs.readdir(aexusExtensionsDir, { withFileTypes: true }).catch(() => []);
	const vsRegistry = await readExtensionsJson(vsCodeExtensionsDir);
	const aexusRegistry = await readExtensionsJson(aexusExtensionsDir);

	const copiedExtensions: string[] = [];
	let registryDirty = false;

	for (const extId of TARGET_CODING_AGENT_EXTENSION_IDS) {
		const lowerId = extId.toLowerCase();
		const alreadyInDir = aexusDirEntries.some(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith(`${lowerId}-`));
		if (alreadyInDir) {
			continue;
		}

		const vsRegEntry = vsRegistry.find(entry => entry.identifier?.id?.toLowerCase() === lowerId);
		let relLocation = vsRegEntry?.relativeLocation;
		if (!relLocation || !vsDirEntries.some(entry => entry.isDirectory() && entry.name === relLocation)) {
			const candidates = vsDirEntries
				.filter(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith(`${lowerId}-`))
				.map(entry => entry.name)
				.sort()
				.reverse();
			relLocation = candidates[0];
		}

		if (!relLocation) {
			continue;
		}

		const srcExtDir = path.join(vsCodeExtensionsDir, relLocation);
		const dstExtDir = path.join(aexusExtensionsDir, relLocation);
		const tempExtDir = path.join(aexusExtensionsDir, `.${relLocation}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);

		try {
			await copyExtensionDirectory(srcExtDir, tempExtDir);
			await fs.rename(tempExtDir, dstExtDir);
			copiedExtensions.push(extId);

			const alreadyInAexusReg = aexusRegistry.some(entry => entry.identifier?.id?.toLowerCase() === lowerId);
			if (!alreadyInAexusReg) {
				let version = vsRegEntry?.version;
				if (!version) {
					try {
						const pkg = JSON.parse(await fs.readFile(path.join(dstExtDir, 'package.json'), 'utf8')) as { version?: string };
						version = pkg.version;
					} catch {
						// Ignore missing package.json version.
					}
				}
				const nextEntry: IExtensionRegistryEntry = vsRegEntry
					? {
						...vsRegEntry,
						relativeLocation: relLocation,
						location: {
							...(vsRegEntry.location ?? {}),
							$mid: 1,
							path: dstExtDir,
							scheme: 'file',
						},
					}
					: {
						identifier: { id: extId },
						...(version ? { version } : {}),
						location: {
							$mid: 1,
							path: dstExtDir,
							scheme: 'file',
						},
						relativeLocation: relLocation,
						metadata: { source: 'gallery' },
					};
				aexusRegistry.push(nextEntry);
				registryDirty = true;
			}
		} catch (error) {
			await fs.rm(tempExtDir, { recursive: true, force: true }).catch(() => undefined);
			logService?.warn(`[AdeMigration] Failed to copy extension ${extId}: ${error}`);
		}
	}

	if (registryDirty) {
		await writeTextAtomic(path.join(aexusExtensionsDir, 'extensions.json'), JSON.stringify(aexusRegistry));
	}
	if (copiedExtensions.length > 0) {
		logService?.info(`[AdeMigration] Migrated ${copiedExtensions.length} missing coding agent extension(s): ${copiedExtensions.join(', ')}`);
	}

	return copiedExtensions;
}

export async function migrateVsCodeStateAndExtensionsToAexus(
	options: IMigrateVsCodeStateAndExtensionsOptions,
): Promise<IMigrateVsCodeStateAndExtensionsResult> {
	const defaultPaths = resolveDefaultVsCodePaths();
	const vsCodeUserDataDir = options.vsCodeUserDataDir ?? defaultPaths.userDataDir;
	const vsCodeExtensionsDir = options.vsCodeExtensionsDir ?? defaultPaths.extensionsDir;

	const vsCodeDbPath = path.join(vsCodeUserDataDir, 'User', 'globalStorage', 'state.vscdb');
	const aexusDbPath = path.join(options.aexusGlobalStorageDir, 'state.vscdb');
	const updatedStateKeys = await migrateStateDbKeys(vsCodeDbPath, aexusDbPath, options.logService).catch(error => {
		options.logService?.warn(`[AdeMigration] Failed to migrate state.vscdb keys: ${error}`);
		return [] as string[];
	});

	let copiedStorageFiles = 0;
	for (const extDirName of TARGET_STORAGE_EXTENSION_DIRS) {
		const srcStorageDir = path.join(vsCodeUserDataDir, 'User', 'globalStorage', extDirName);
		const dstStorageDir = path.join(options.aexusGlobalStorageDir, extDirName);
		copiedStorageFiles += await copyMissingStorageFiles(srcStorageDir, dstStorageDir).catch(() => 0);
	}

	const copiedExtensions = await migrateMissingCodingAgentExtensions(vsCodeExtensionsDir, options.aexusExtensionsDir, options.logService).catch(error => {
		options.logService?.warn(`[AdeMigration] Failed to migrate missing extensions: ${error}`);
		return [] as string[];
	});

	return {
		updatedStateKeys,
		copiedStorageFiles,
		copiedExtensions,
	};
}
