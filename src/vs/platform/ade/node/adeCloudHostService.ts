/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import type { Database } from '@vscode/sqlite3';
import { existsSync, promises as fs } from 'fs';
import * as os from 'os';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Emitter } from '../../../base/common/event.js';
import { parse, ParseError, ParseOptions } from '../../../base/common/json.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { isMacintosh, isWindows } from '../../../base/common/platform.js';
import { ILogService } from '../../log/common/log.js';
import {
	AdeCloudHostOs,
	AdeCloudHostSource,
	IAdeCloudHost,
	IAdeCloudHostBackendService,
	IAdeCloudHostConnectionCheck,
	IAdeCloudHostImportResult,
	IAdeCloudHostUpsertInput,
	IAdeRemoteDirEntry,
	IAdeRemoteFileStat,
	IAdeRemoteScmStatusEntry,
	isShallowRemoteRootPath,
	normalizeRemoteProjectPath,
	sanitizeSshAlias,
	toRemoteNativePath,
} from '../common/adeCloudHosts.js';
import { stripAdeControlEnv } from '../common/adeControl.js';
import { resolveDefaultVsCodePaths } from './vscodeConfigMigration.js';

export interface IAdeCloudHostNodeServiceOptions {
	readonly userDataPath?: string;
	readonly homedir?: string;
	readonly vsCodeUserDataDir?: string;
	readonly sshConfigPath?: string;
	readonly syncUserSshDir?: boolean;
	readonly autoImportOnFirstLoad?: boolean;
	readonly sshExecutable?: string;
	readonly logService?: ILogService;
}

interface IParsedSshHostRecord {
	readonly alias: string;
	hostName?: string;
	user?: string;
	port?: number;
	identityFile?: string;
	proxyJump?: string;
	hostKeyAlias?: string;
	knownHostsFile?: string;
	strictHostKeyChecking?: 'yes' | 'accept-new' | 'no';
}

function defaultAexusUserDataPath(homedir: string): string {
	if (isMacintosh) {
		return path.join(homedir, 'Library', 'Application Support', 'Aexus Code');
	}
	if (isWindows) {
		return path.join(process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), 'Aexus Code');
	}
	return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'Aexus Code');
}

function expandTildePath(rawPath: string, homedir: string): string {
	const trimmed = rawPath.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
	if (trimmed === '~') {
		return homedir;
	}
	if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
		return path.join(homedir, trimmed.slice(2));
	}
	return trimmed;
}

function splitSshConfigLine(line: string): { key: string; value: string } | undefined {
	let cleaned = line.trim();
	if (!cleaned || cleaned.startsWith('#')) {
		return undefined;
	}
	// Strip inline unquoted comments
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < cleaned.length; i++) {
		const ch = cleaned[i];
		if (ch === '\'' && !inDouble) {
			inSingle = !inSingle;
		} else if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
		} else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(cleaned[i - 1]))) {
			cleaned = cleaned.slice(0, i).trim();
			break;
		}
	}
	if (!cleaned) {
		return undefined;
	}
	const match = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+)(.+)$/.exec(cleaned);
	if (!match) {
		return undefined;
	}
	return { key: match[1].toLowerCase(), value: match[2].trim() };
}

function tokenizeSshArgs(raw: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let quote: '"' | '\'' | undefined;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else {
				current += ch;
			}
		} else if (ch === '"' || ch === '\'') {
			quote = ch;
		} else if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = '';
			}
		} else {
			current += ch;
		}
	}
	if (current) {
		tokens.push(current);
	}
	return tokens;
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp(`^${escaped}$`);
}

async function expandIncludeGlob(rawPattern: string, sshDir: string, homedir: string): Promise<string[]> {
	const expanded = expandTildePath(rawPattern, homedir);
	const resolved = path.isAbsolute(expanded) ? expanded : path.join(sshDir, expanded);
	if (!resolved.includes('*') && !resolved.includes('?')) {
		try {
			const st = await fs.stat(resolved);
			return st.isFile() ? [resolved] : [];
		} catch {
			return [];
		}
	}
	const dir = path.dirname(resolved);
	const basePattern = path.basename(resolved);
	const rx = globToRegExp(basePattern);
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries
			.filter(e => e.isFile() && rx.test(e.name))
			.map(e => path.join(dir, e.name))
			.sort();
	} catch {
		return [];
	}
}

export async function parseOpenSshConfigFiles(
	entryConfigPath: string,
	homedir = os.homedir(),
): Promise<Map<string, IParsedSshHostRecord>> {
	const hosts = new Map<string, IParsedSshHostRecord>();
	const globalDefaults: Partial<IParsedSshHostRecord> = {};
	const visited = new Set<string>();
	const sshDir = path.dirname(entryConfigPath);

	const parseFile = async (filePath: string): Promise<void> => {
		const canonical = path.resolve(filePath);
		if (visited.has(canonical)) {
			return;
		}
		visited.add(canonical);

		let raw: string;
		try {
			raw = await fs.readFile(canonical, 'utf8');
		} catch {
			return;
		}

		let activeTargets: IParsedSshHostRecord[] = [];
		let inWildcardStar = false;

		for (const rawLine of raw.split(/\r?\n/)) {
			const kv = splitSshConfigLine(rawLine);
			if (!kv) {
				continue;
			}

			if (kv.key === 'include') {
				for (const pat of tokenizeSshArgs(kv.value)) {
					const includedFiles = await expandIncludeGlob(pat, sshDir, homedir);
					for (const inc of includedFiles) {
						await parseFile(inc);
					}
				}
				continue;
			}

			if (kv.key === 'match') {
				activeTargets = [];
				inWildcardStar = false;
				continue;
			}

			if (kv.key === 'host') {
				const patterns = tokenizeSshArgs(kv.value);
				activeTargets = [];
				inWildcardStar = patterns.length === 1 && patterns[0] === '*';
				for (const pat of patterns) {
					if (!pat || pat.startsWith('!') || pat.includes('*') || pat.includes('?')) {
						continue;
					}
					let rec = hosts.get(pat);
					if (!rec) {
						rec = { alias: pat };
						hosts.set(pat, rec);
					}
					activeTargets.push(rec);
				}
				continue;
			}

			const val = tokenizeSshArgs(kv.value)[0] ?? kv.value;
			const applyOption = (target: Partial<IParsedSshHostRecord>) => {
				// OpenSSH first-seen wins!
				switch (kv.key) {
					case 'hostname':
						if (target.hostName === undefined) {
							target.hostName = val;
						}
						break;
					case 'user':
						if (target.user === undefined) {
							target.user = val;
						}
						break;
					case 'port': {
						const p = Number(val);
						if (target.port === undefined && Number.isInteger(p) && p > 0 && p <= 65535) {
							target.port = p;
						}
						break;
					}
					case 'identityfile':
						if (target.identityFile === undefined) {
							target.identityFile = expandTildePath(val, homedir);
						}
						break;
					case 'proxyjump':
						if (target.proxyJump === undefined && val.toLowerCase() !== 'none') {
							target.proxyJump = val;
						}
						break;
					case 'hostkeyalias':
						if (target.hostKeyAlias === undefined && val.toLowerCase() !== 'none') {
							target.hostKeyAlias = val;
						}
						break;
					case 'userknownhostsfile':
						if (target.knownHostsFile === undefined) {
							target.knownHostsFile = expandTildePath(val, homedir);
						}
						break;
					case 'stricthostkeychecking': {
						const norm = val.toLowerCase();
						if (target.strictHostKeyChecking === undefined && (norm === 'yes' || norm === 'no' || norm === 'accept-new')) {
							target.strictHostKeyChecking = norm;
						}
						break;
					}
				}
			};

			if (inWildcardStar) {
				applyOption(globalDefaults);
			}
			for (const target of activeTargets) {
				applyOption(target);
			}
		}
	};

	await parseFile(entryConfigPath);

	// Deduplicate redundant IP aliases when an identical named alias already points to that IP (keep named aliases crisp, but still preserve standalone IP hosts)
	for (const rec of hosts.values()) {
		if (!rec.hostName) {
			rec.hostName = rec.alias;
		}
		if (rec.user === undefined && globalDefaults.user) {
			rec.user = globalDefaults.user;
		}
		if (rec.port === undefined) {
			rec.port = globalDefaults.port ?? 22;
		}
		if (rec.identityFile === undefined && globalDefaults.identityFile) {
			rec.identityFile = globalDefaults.identityFile;
		}
	}

	return hosts;
}

function decodeVsCodeSshAuthority(rawAuthority: string): { aliasOrHost: string; user?: string; port?: number } | undefined {
	let body = rawAuthority.trim();
	try {
		body = decodeURIComponent(body);
	} catch {
		// keep raw
	}
	if (body.startsWith('ssh-remote+')) {
		body = body.slice('ssh-remote+'.length);
	}
	if (!body) {
		return undefined;
	}
	// VS Code sometimes hex-encodes JSON objects or user@host strings in authority
	if (/^[0-9a-f]{16,}$/i.test(body) && body.length % 2 === 0) {
		try {
			const decoded = Buffer.from(body, 'hex').toString('utf8');
			if (decoded.startsWith('{')) {
				const parsed = JSON.parse(decoded) as { hostName?: string; user?: string; port?: number };
				if (typeof parsed.hostName === 'string' && parsed.hostName.trim()) {
					return {
						aliasOrHost: parsed.hostName.trim(),
						user: typeof parsed.user === 'string' && parsed.user.trim() ? parsed.user.trim() : undefined,
						port: typeof parsed.port === 'number' ? parsed.port : undefined,
					};
				}
			} else if (/^[\x21-\x7e]+$/.test(decoded)) {
				body = decoded;
			}
		} catch {
			// not hex JSON
		}
	}
	let user: string | undefined;
	let port: number | undefined;
	const atIdx = body.lastIndexOf('@');
	if (atIdx > 0) {
		user = body.slice(0, atIdx);
		body = body.slice(atIdx + 1);
	}
	if (body.startsWith('[')) {
		const closeBracket = body.indexOf(']');
		if (closeBracket > 0) {
			const rest = body.slice(closeBracket + 1);
			if (rest.startsWith(':') && /^\d+$/.test(rest.slice(1))) {
				port = Number(rest.slice(1));
			}
			body = body.slice(1, closeBracket);
		}
	} else if (body.indexOf(':') === body.lastIndexOf(':')) {
		const colonIdx = body.lastIndexOf(':');
		if (colonIdx > 0 && /^\d+$/.test(body.slice(colonIdx + 1))) {
			port = Number(body.slice(colonIdx + 1));
			body = body.slice(0, colonIdx);
		}
	}
	return body ? { aliasOrHost: body, user, port } : undefined;
}

function parseJsoncSafe(raw: string): unknown {
	const errors: ParseError[] = [];
	const parsed = parse(raw, errors, ParseOptions.DEFAULT);
	return errors.length === 0 ? parsed : undefined;
}

function posixQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function encodePowerShellScript(script: string): string {
	const withUtf8 = `$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`;
	return Buffer.from(withUtf8, 'utf16le').toString('base64');
}

/* eslint-disable local/code-no-sync-fs -- one-time ssh.exe path resolution on Windows service construction */
function resolveDefaultSshExecutable(): string {
	if (!isWindows) {
		return 'ssh';
	}
	const sysRoot = process.env['SystemRoot'] || 'C:\\Windows';
	const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
	const progFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
	const candidates = [
		path.win32.join(sysRoot, 'System32', 'OpenSSH', 'ssh.exe'),
		path.win32.join(sysRoot, 'Sysnative', 'OpenSSH', 'ssh.exe'),
		path.win32.join(progFiles, 'OpenSSH', 'ssh.exe'),
		path.win32.join(progFiles, 'Git', 'usr', 'bin', 'ssh.exe'),
		path.win32.join(progFiles86, 'Git', 'usr', 'bin', 'ssh.exe'),
	];
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) {
				return candidate;
			}
		} catch { /* ignore */ }
	}
	return 'ssh';
}
/* eslint-enable local/code-no-sync-fs */

export class AdeCloudHostNodeService extends Disposable implements IAdeCloudHostBackendService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeHosts = this._register(new Emitter<void>());
	readonly onDidChangeHosts = this._onDidChangeHosts.event;

	private readonly homedir: string;
	private readonly userDataPath: string;
	private readonly vsCodeUserDataDir: string;
	private readonly defaultSshConfigPath: string;
	private readonly syncUserSshDir: boolean;
	private readonly autoImportOnFirstLoad: boolean;
	private readonly sshExecutable: string;
	private readonly logService?: ILogService;

	private readonly storageFilePath: string;
	private readonly managedSshConfPath: string;
	private readonly effectiveSshConfPath: string;

	private hosts: IAdeCloudHost[] = [];
	private initPromise: Promise<void> | undefined;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(options: IAdeCloudHostNodeServiceOptions = {}) {
		super();
		this.homedir = options.homedir ?? os.homedir();
		this.userDataPath = options.userDataPath ?? defaultAexusUserDataPath(this.homedir);
		this.vsCodeUserDataDir = options.vsCodeUserDataDir ?? resolveDefaultVsCodePaths(this.homedir).userDataDir;
		this.defaultSshConfigPath = options.sshConfigPath ?? path.join(this.homedir, '.ssh', 'config');
		this.syncUserSshDir = options.syncUserSshDir ?? false;
		this.autoImportOnFirstLoad = options.autoImportOnFirstLoad ?? true;
		this.sshExecutable = options.sshExecutable ?? resolveDefaultSshExecutable();
		this.logService = options.logService;

		this.storageFilePath = path.join(this.userDataPath, 'cloud-hosts.json');
		const sshConfigDir = this.resolveSafeSshConfigDir();
		this.managedSshConfPath = path.join(sshConfigDir, 'aexus-managed-hosts.conf');
		this.effectiveSshConfPath = path.join(sshConfigDir, 'effective_ssh_config');
	}

	private resolveSafeSshConfigDir(): string {
		const candidate = path.join(this.userDataPath, 'ssh');
		// OpenSSH ProxyJump internally invokes `ssh -F <config> -W ...` via shell without quoting whitespace.
		// Keep a space-free directory so ProxyJump hosts never fail with "Can't open user config file .../Application".
		if (!/\s/.test(candidate)) {
			return candidate;
		}
		const homeCandidate = path.join(this.homedir, '.aexus-code', 'ssh');
		if (!/\s/.test(homeCandidate)) {
			return homeCandidate;
		}
		if (process.platform !== 'win32') {
			const myUid = typeof process.getuid === 'function' ? process.getuid() : 'u';
			return path.join('/tmp', `aexus-ssh-${myUid}`);
		}
		return candidate;
	}

	private ensureInitialized(): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = this.doInitialize().catch(err => {
				this.initPromise = undefined;
				throw err;
			});
		}
		return this.initPromise;
	}

	private async doInitialize(): Promise<void> {
		let loadedExisting = false;
		try {
			const raw = await fs.readFile(this.storageFilePath, 'utf8');
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				this.hosts = parsed.filter((h): h is IAdeCloudHost => Boolean(h && typeof h === 'object' && typeof h.alias === 'string' && typeof h.hostName === 'string'));
				loadedExisting = true;
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				this.logService?.warn(`[AdeCloudHosts] Failed to read ${this.storageFilePath}: ${err}`);
				await fs.copyFile(this.storageFilePath, `${this.storageFilePath}.corrupt-${Date.now()}`).catch(() => undefined);
			}
		}

		if (this.autoImportOnFirstLoad) {
			try {
				await this.doImportFromVsCodeAndSshConfig(!loadedExisting);
			} catch (err) {
				this.logService?.warn(`[AdeCloudHosts] Startup VS Code / SSH host import warning: ${err}`);
			}
		}
		try {
			await this.syncSshConfigFiles();
		} catch (err) {
			this.logService?.warn(`[AdeCloudHosts] Failed to sync SSH config files on startup: ${err}`);
		}
	}

	private enqueuePersist(): Promise<void> {
		const next = this.writeQueue.then(async () => {
			await fs.mkdir(path.dirname(this.storageFilePath), { recursive: true });
			const tmp = `${this.storageFilePath}.${process.pid}.${Date.now()}.tmp`;
			await fs.writeFile(tmp, JSON.stringify(this.hosts, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
			await fs.rename(tmp, this.storageFilePath);
			await this.syncSshConfigFiles();
		});
		this.writeQueue = next.catch(err => {
			this.logService?.warn(`[AdeCloudHosts] Failed to persist cloud-hosts.json: ${err}`);
		});
		return next;
	}

	private async resolveUserSshConfigPath(): Promise<string> {
		// Check Aexus & VS Code settings for custom `remote.SSH.configFile`
		for (const baseDir of [this.userDataPath, this.vsCodeUserDataDir]) {
			try {
				const raw = await fs.readFile(path.join(baseDir, 'User', 'settings.json'), 'utf8');
				const parsed = parseJsoncSafe(raw);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					const cfg = (parsed as Record<string, unknown>)['remote.SSH.configFile'];
					if (typeof cfg === 'string' && cfg.trim()) {
						return expandTildePath(cfg, this.homedir);
					}
				}
			} catch {
				// ignore
			}
		}
		return this.defaultSshConfigPath;
	}

	private sanitizeSshDirectiveValue(raw: string): string {
		return raw.replace(/[\r\n\0"]+/g, '').trim();
	}

	private formatManagedHostBlock(host: IAdeCloudHost): string {
		const safeAlias = sanitizeSshAlias(this.sanitizeSshDirectiveValue(host.alias));
		const safeHostName = this.sanitizeSshDirectiveValue(host.hostName);
		const lines: string[] = [`Host ${safeAlias}`];
		lines.push(`    HostName ${safeHostName.includes(' ') ? `"${safeHostName}"` : safeHostName}`);
		if (host.user) {
			const safeUser = this.sanitizeSshDirectiveValue(host.user);
			if (safeUser) {
				lines.push(`    User ${safeUser.includes(' ') ? `"${safeUser}"` : safeUser}`);
			}
		}
		if (host.port && host.port !== 22) {
			lines.push(`    Port ${host.port}`);
		} else {
			lines.push('    Port 22');
		}
		if (host.identityFile) {
			const safeIdentity = this.sanitizeSshDirectiveValue(host.identityFile);
			if (safeIdentity) {
				lines.push(`    IdentityFile "${safeIdentity}"`);
				lines.push('    IdentitiesOnly yes');
			}
		}
		if (host.proxyJump) {
			const safeJump = this.sanitizeSshDirectiveValue(host.proxyJump);
			if (safeJump) {
				lines.push(`    ProxyJump ${safeJump.includes(' ') ? `"${safeJump}"` : safeJump}`);
			}
		}
		if (host.hostKeyAlias) {
			const safeKeyAlias = this.sanitizeSshDirectiveValue(host.hostKeyAlias);
			if (safeKeyAlias) {
				lines.push(`    HostKeyAlias ${safeKeyAlias.includes(' ') ? `"${safeKeyAlias}"` : safeKeyAlias}`);
			}
		}
		if (host.knownHostsFile) {
			const safeKh = this.sanitizeSshDirectiveValue(host.knownHostsFile);
			if (safeKh) {
				lines.push(`    UserKnownHostsFile "${safeKh}"`);
			}
		}
		if (host.strictHostKeyChecking === 'yes' || host.strictHostKeyChecking === 'accept-new' || host.strictHostKeyChecking === 'no') {
			lines.push(`    StrictHostKeyChecking ${host.strictHostKeyChecking}`);
		}
		lines.push('    ServerAliveInterval 15');
		lines.push('    ServerAliveCountMax 3');
		return lines.join('\n');
	}

	private async syncSshConfigFiles(): Promise<void> {
		await fs.mkdir(path.dirname(this.managedSshConfPath), { recursive: true, mode: 0o700 });
		const header = '# Managed by Aexus Code Cloud Hosts. Private keys and credentials are never stored in this file.\n\n';
		const blocks = this.hosts.map(h => this.formatManagedHostBlock(h)).join('\n\n');
		const managedContent = blocks ? `${header}${blocks}\n` : header;

		const tmpManaged = `${this.managedSshConfPath}.${process.pid}.${Date.now()}.tmp`;
		await fs.writeFile(tmpManaged, managedContent, { encoding: 'utf8', mode: 0o600 });
		await fs.rename(tmpManaged, this.managedSshConfPath);

		const userSshCfg = await this.resolveUserSshConfigPath();
		const effectiveLines = [
			'# Effective SSH config generated by Aexus Code (Aexus managed hosts take precedence, then user ~/.ssh/config).',
			`Include "${this.managedSshConfPath}"`,
		];
		try {
			await fs.access(userSshCfg);
			effectiveLines.push(`Include "${userSshCfg}"`);
		} catch {
			// User ~/.ssh/config does not exist yet
		}
		// Fallback only when neither managed host config nor user ~/.ssh/config specifies StrictHostKeyChecking.
		// Because OpenSSH uses first-match-wins, any StrictHostKeyChecking in user ~/.ssh/config takes precedence.
		effectiveLines.push('', 'Host *', '    StrictHostKeyChecking accept-new');
		const tmpEffective = `${this.effectiveSshConfPath}.${process.pid}.${Date.now()}.tmp`;
		await fs.writeFile(tmpEffective, effectiveLines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
		await fs.rename(tmpEffective, this.effectiveSshConfPath);

		if (this.syncUserSshDir) {
			try {
				const sshDir = path.join(this.homedir, '.ssh');
				await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });
				const userAexusConf = path.join(sshDir, 'aexus-code-hosts.conf');
				const userCreatedOrEdited = this.hosts.filter(h => h.source === 'user' || h.source === 'aexus-legacy');
				if (userCreatedOrEdited.length > 0) {
					const userBlocks = userCreatedOrEdited.map(h => this.formatManagedHostBlock(h)).join('\n\n');
					const tmpUser = `${userAexusConf}.${process.pid}.${Date.now()}.tmp`;
					await fs.writeFile(tmpUser, `${header}${userBlocks}\n`, { encoding: 'utf8', mode: 0o600 });
					await fs.rename(tmpUser, userAexusConf);

					// Ensure ~/.ssh/config includes aexus-code-hosts.conf if ~/.ssh/config exists (preserving symlinks)
					try {
						const stat = await fs.lstat(userSshCfg);
						const targetCfgPath = stat.isSymbolicLink() ? await fs.realpath(userSshCfg) : userSshCfg;
						const existingMainCfg = await fs.readFile(targetCfgPath, 'utf8');
						if (!existingMainCfg.includes('aexus-code-hosts.conf')) {
							const includeLine = `Include "${userAexusConf}"\n\n`;
							const tmpCfg = `${targetCfgPath}.${process.pid}.${Date.now()}.tmp`;
							await fs.writeFile(tmpCfg, includeLine + existingMainCfg, { encoding: 'utf8', mode: 0o600 });
							await fs.rename(tmpCfg, targetCfgPath);
						}
					} catch {
						// Do not create ~/.ssh/config from scratch unless needed
					}
				}
			} catch (err) {
				this.logService?.warn(`[AdeCloudHosts] Could not sync ~/.ssh/aexus-code-hosts.conf: ${err}`);
			}
		}
	}

	async getEffectiveSshConfigPath(): Promise<string> {
		await this.ensureInitialized();
		return this.effectiveSshConfPath;
	}

	async listHosts(): Promise<readonly IAdeCloudHost[]> {
		await this.ensureInitialized();
		return [...this.hosts];
	}

	async getHost(idOrAlias: string): Promise<IAdeCloudHost | undefined> {
		await this.ensureInitialized();
		const needle = idOrAlias.trim();
		return this.hosts.find(h => h.id === needle || h.alias === needle || h.name === needle)
			?? this.hosts.find(h => h.alias.toLowerCase() === needle.toLowerCase() || h.name.toLowerCase() === needle.toLowerCase());
	}

	async upsertHost(input: IAdeCloudHostUpsertInput): Promise<IAdeCloudHost> {
		await this.ensureInitialized();
		const rawName = input.name?.trim() || input.alias?.trim() || input.hostName?.trim();
		if (!rawName) {
			throw new Error('Cloud Host name is required.');
		}
		let hostName = this.sanitizeSshDirectiveValue(input.hostName ?? '');
		let user = input.user ? (this.sanitizeSshDirectiveValue(input.user) || undefined) : undefined;
		let port = input.port && Number.isInteger(input.port) && input.port > 0 && input.port <= 65535 ? input.port : 22;

		// Allow user@host:port shorthand in hostName
		if (hostName.includes('@') && !user) {
			const atIdx = hostName.lastIndexOf('@');
			user = hostName.slice(0, atIdx).trim() || undefined;
			hostName = hostName.slice(atIdx + 1).trim();
		}
		const bracketedIpv6Match = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostName);
		if (bracketedIpv6Match) {
			hostName = bracketedIpv6Match[1].trim();
			if (bracketedIpv6Match[2] && !input.port) {
				port = Number(bracketedIpv6Match[2]);
			}
		} else {
			const portMatch = /^([^:]+):(\d+)$/.exec(hostName);
			if (portMatch && !input.port) {
				hostName = portMatch[1].trim();
				port = Number(portMatch[2]);
			}
		}
		if (!hostName) {
			throw new Error('Cloud Host address (HostName or IP) is required.');
		}

		const alias = sanitizeSshAlias(input.alias?.trim() || rawName);
		const existingIdx = this.hosts.findIndex(h =>
			(input.id && h.id === input.id) || h.alias.toLowerCase() === alias.toLowerCase(),
		);
		const now = Date.now();
		const prev = existingIdx >= 0 ? this.hosts[existingIdx] : undefined;
		const osKind: AdeCloudHostOs = input.os ?? prev?.os ?? 'linux';
		const defaultDir = input.defaultDirectory?.trim()
			? normalizeRemoteProjectPath(input.defaultDirectory.trim(), osKind)
			: prev?.defaultDirectory;
		const mergedRecents = Array.from(new Set([
			...(defaultDir ? [defaultDir] : []),
			...(input.recentDirectories ?? []),
			...(prev?.recentDirectories ?? []),
		].map(p => normalizeRemoteProjectPath(p, osKind))));

		const updated: IAdeCloudHost = {
			id: prev?.id ?? input.id ?? crypto.randomUUID(),
			name: rawName,
			alias,
			hostName,
			user,
			port,
			os: osKind,
			identityFile: input.identityFile !== undefined
				? (this.sanitizeSshDirectiveValue(input.identityFile) ? expandTildePath(this.sanitizeSshDirectiveValue(input.identityFile), this.homedir) : undefined)
				: prev?.identityFile,
			proxyJump: input.proxyJump !== undefined ? (this.sanitizeSshDirectiveValue(input.proxyJump) || undefined) : prev?.proxyJump,
			hostKeyAlias: input.hostKeyAlias !== undefined ? (this.sanitizeSshDirectiveValue(input.hostKeyAlias) || undefined) : prev?.hostKeyAlias,
			knownHostsFile: input.knownHostsFile !== undefined
				? (this.sanitizeSshDirectiveValue(input.knownHostsFile) ? expandTildePath(this.sanitizeSshDirectiveValue(input.knownHostsFile), this.homedir) : undefined)
				: prev?.knownHostsFile,
			strictHostKeyChecking: input.strictHostKeyChecking ?? prev?.strictHostKeyChecking,
			defaultDirectory: defaultDir,
			recentDirectories: mergedRecents.slice(0, 25),
			source: 'user',
			notes: input.notes !== undefined ? (input.notes.trim() || undefined) : prev?.notes,
			createdAt: prev?.createdAt ?? now,
			updatedAt: now,
			lastTestStatus: prev?.lastTestStatus,
		};

		if (existingIdx >= 0) {
			this.hosts[existingIdx] = updated;
		} else {
			this.hosts.push(updated);
		}
		await this.enqueuePersist();
		this._onDidChangeHosts.fire();
		return updated;
	}

	async deleteHost(idOrAlias: string): Promise<boolean> {
		await this.ensureInitialized();
		const before = this.hosts.length;
		const needle = idOrAlias.trim().toLowerCase();
		this.hosts = this.hosts.filter(h => h.id.toLowerCase() !== needle && h.alias.toLowerCase() !== needle && h.name.toLowerCase() !== needle);
		if (this.hosts.length === before) {
			return false;
		}
		await this.enqueuePersist();
		this._onDidChangeHosts.fire();
		return true;
	}

	async recordRecentDirectory(idOrAlias: string, remotePath: string): Promise<IAdeCloudHost | undefined> {
		await this.ensureInitialized();
		const idx = this.hosts.findIndex(h => h.id === idOrAlias || h.alias === idOrAlias || h.alias.toLowerCase() === idOrAlias.toLowerCase());
		if (idx < 0) {
			return undefined;
		}
		const cur = this.hosts[idx];
		const norm = normalizeRemoteProjectPath(remotePath, cur.os);
		const nextRecents = [norm, ...cur.recentDirectories.filter(p => p !== norm)].slice(0, 25);
		const updated: IAdeCloudHost = {
			...cur,
			defaultDirectory: cur.defaultDirectory ?? norm,
			recentDirectories: nextRecents,
			updatedAt: Date.now(),
		};
		this.hosts[idx] = updated;
		await this.enqueuePersist();
		this._onDidChangeHosts.fire();
		return updated;
	}

	async importFromVsCodeAndSshConfig(): Promise<IAdeCloudHostImportResult> {
		await this.ensureInitialized();
		const res = await this.doImportFromVsCodeAndSshConfig(true);
		await this.enqueuePersist();
		this._onDidChangeHosts.fire();
		return res;
	}

	private async doImportFromVsCodeAndSshConfig(persistIfChanged: boolean): Promise<IAdeCloudHostImportResult> {
		const userSshCfg = await this.resolveUserSshConfigPath();
		const sshHosts = await parseOpenSshConfigFiles(userSshCfg, this.homedir);

		// 1. Read VS Code & Aexus `remote.SSH.remotePlatform`
		const platformByHost = new Map<string, AdeCloudHostOs>();
		for (const baseDir of [this.vsCodeUserDataDir, this.userDataPath]) {
			try {
				const raw = await fs.readFile(path.join(baseDir, 'User', 'settings.json'), 'utf8');
				const parsed = parseJsoncSafe(raw);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					const platforms = (parsed as Record<string, unknown>)['remote.SSH.remotePlatform'];
					if (platforms && typeof platforms === 'object' && !Array.isArray(platforms)) {
						for (const [k, v] of Object.entries(platforms as Record<string, unknown>)) {
							if (v === 'windows' || v === 'macos' || v === 'linux') {
								if (!platformByHost.has(k)) {
									platformByHost.set(k, v);
								}
							}
						}
					}
				}
			} catch {
				// ignore
			}
		}

		// 2. Collect recent remote project folders per authority from VS Code state.vscdb, storage.json, and project-manager
		const recentFoldersByAuthority = new Map<string, string[]>();
		const extraAuthorities = new Map<string, { aliasOrHost: string; user?: string; port?: number }>();
		const addRecentFolder = (rawAuth: string, rawFolderPath: string) => {
			const decoded = decodeVsCodeSshAuthority(rawAuth);
			if (!decoded || !rawFolderPath?.trim()) {
				return;
			}
			extraAuthorities.set(decoded.aliasOrHost, decoded);
			const list = recentFoldersByAuthority.get(decoded.aliasOrHost) ?? [];
			if (!list.includes(rawFolderPath.trim())) {
				list.push(rawFolderPath.trim());
				recentFoldersByAuthority.set(decoded.aliasOrHost, list);
			}
		};

		const harvestRemoteUri = (uriStr: string) => {
			if (typeof uriStr !== 'string' || !uriStr.startsWith('vscode-remote://')) {
				return;
			}
			try {
				const withoutScheme = uriStr.slice('vscode-remote://'.length);
				const slashIdx = withoutScheme.indexOf('/');
				if (slashIdx <= 0) {
					return;
				}
				const authPart = withoutScheme.slice(0, slashIdx);
				const pathPart = decodeURIComponent(withoutScheme.slice(slashIdx));
				if (decodeURIComponent(authPart).startsWith('ssh-remote+')) {
					addRecentFolder(authPart, pathPart);
				}
			} catch {
				// ignore malformed URI
			}
		};

		// 2a. VS Code storage.json
		try {
			const storageRaw = await fs.readFile(path.join(this.vsCodeUserDataDir, 'User', 'globalStorage', 'storage.json'), 'utf8');
			const storageObj = JSON.parse(storageRaw) as Record<string, unknown>;
			const profWorkspaces = (storageObj.profileAssociations as Record<string, unknown> | undefined)?.workspaces;
			if (profWorkspaces && typeof profWorkspaces === 'object') {
				for (const uriKey of Object.keys(profWorkspaces)) {
					harvestRemoteUri(uriKey);
				}
			}
			const backupFolders = (storageObj.backupWorkspaces as Record<string, unknown> | undefined)?.folders;
			if (Array.isArray(backupFolders)) {
				for (const entry of backupFolders) {
					if (entry && typeof entry === 'object' && typeof (entry as { folderUri?: unknown }).folderUri === 'string') {
						harvestRemoteUri((entry as { folderUri: string }).folderUri);
					}
				}
			}
		} catch {
			// ignore
		}

		// 2b. VS Code Project Manager `projects.json`
		try {
			const pmRaw = await fs.readFile(path.join(this.vsCodeUserDataDir, 'User', 'globalStorage', 'alefragnani.project-manager', 'projects.json'), 'utf8');
			const pmArr = parseJsoncSafe(pmRaw);
			if (Array.isArray(pmArr)) {
				for (const item of pmArr) {
					if (item && typeof item === 'object' && typeof (item as { rootPath?: unknown }).rootPath === 'string') {
						harvestRemoteUri((item as { rootPath: string }).rootPath);
					}
				}
			}
		} catch {
			// ignore
		}

		// 2c. VS Code `state.vscdb` (`ms-vscode-remote.remote-ssh` `folder.history.v1` + `__$__isNewStorageMarker.ssh-remote+*`)
		try {
			const vscdbPath = path.join(this.vsCodeUserDataDir, 'User', 'globalStorage', 'state.vscdb');
			await fs.access(vscdbPath);
			const sqlite3Mod = await import('@vscode/sqlite3');
			const sqlite3 = sqlite3Mod.default ?? sqlite3Mod;
			await new Promise<void>((resolve) => {
				const db: Database = new sqlite3.Database(vscdbPath, sqlite3.OPEN_READONLY, err => {
					if (err) {
						resolve();
						return;
					}
					db.all(
						`SELECT key, value FROM ItemTable WHERE key = 'ms-vscode-remote.remote-ssh' OR key LIKE '__$__isNewStorageMarker.ssh-remote+%'`,
						(qErr, rows: { key: string; value: string }[] | undefined) => {
							if (!qErr && Array.isArray(rows)) {
								for (const row of rows) {
									if (row.key === 'ms-vscode-remote.remote-ssh' && typeof row.value === 'string') {
										try {
											const stateJson = JSON.parse(row.value) as Record<string, unknown>;
											const hist = stateJson['folder.history.v1'];
											if (hist && typeof hist === 'object' && !Array.isArray(hist)) {
												for (const [authKey, folders] of Object.entries(hist as Record<string, unknown>)) {
													if (Array.isArray(folders)) {
														for (const f of folders) {
															if (typeof f === 'string') {
																addRecentFolder(authKey, f);
															} else if (f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string') {
																addRecentFolder(authKey, (f as { path: string }).path);
															}
														}
													}
												}
											}
										} catch { /* ignore */ }
									} else if (row.key.startsWith('__$__isNewStorageMarker.')) {
										const decoded = decodeVsCodeSshAuthority(row.key.slice('__$__isNewStorageMarker.'.length));
										if (decoded) {
											extraAuthorities.set(decoded.aliasOrHost, decoded);
										}
									}
								}
							}
							db.close(() => resolve());
						},
					);
				});
			});
		} catch {
			// sqlite unavailable or locked
		}

		// 3. Legacy Aexus `<userDataPath>/hosts.json` & `workspaces.json` (strictly non-secret fields only!)
		const legacyByAlias = new Map<string, {
			id?: string;
			name: string;
			hostName: string;
			user?: string;
			port?: number;
			os?: AdeCloudHostOs;
			defaultDirectory?: string;
			identityFile?: string;
			knownHostsFile?: string;
		}>();
		const legacyById = new Map<string, string>();
		try {
			const legacyHostsRaw = await fs.readFile(path.join(this.userDataPath, 'hosts.json'), 'utf8');
			const legacyArr = JSON.parse(legacyHostsRaw);
			if (Array.isArray(legacyArr)) {
				for (const item of legacyArr) {
					if (!item || typeof item !== 'object') {
						continue;
					}
					const rec = item as Record<string, unknown>;
					const rawName = typeof rec.name === 'string' ? rec.name.trim() : '';
					const rawAlias = typeof rec.alias === 'string' && rec.alias.trim() ? rec.alias.trim() : rawName;
					const rawHost = typeof rec.host === 'string' ? rec.host.trim() : rawAlias;
					if (!rawAlias || !rawHost) {
						continue;
					}
					let user: string | undefined;
					let hostName = rawHost;
					if (rawHost.includes('@')) {
						const idx = rawHost.lastIndexOf('@');
						user = rawHost.slice(0, idx);
						hostName = rawHost.slice(idx + 1);
					}
					const alias = sanitizeSshAlias(rawAlias);
					if (typeof rec.id === 'string') {
						legacyById.set(rec.id, alias);
					}
					legacyByAlias.set(alias, {
						id: typeof rec.id === 'string' ? rec.id : undefined,
						name: rawName || alias,
						hostName,
						user,
						port: typeof rec.port === 'number' ? rec.port : undefined,
						os: rec.os === 'windows' || rec.os === 'macos' || rec.os === 'linux' ? rec.os : undefined,
						defaultDirectory: typeof rec.defaultDirectory === 'string' && rec.defaultDirectory.trim() ? rec.defaultDirectory.trim() : undefined,
						identityFile: typeof rec.identityFile === 'string' && rec.identityFile.trim() ? rec.identityFile.trim() : undefined,
						knownHostsFile: typeof rec.knownHosts === 'string' && rec.knownHosts.trim() ? rec.knownHosts.trim() : undefined,
					});
				}
			}
		} catch {
			// ignore
		}

		try {
			const legacyWsRaw = await fs.readFile(path.join(this.userDataPath, 'workspaces.json'), 'utf8');
			const legacyWs = JSON.parse(legacyWsRaw) as { entries?: Array<{ hostId?: string; directory?: string }> };
			if (Array.isArray(legacyWs?.entries)) {
				for (const entry of legacyWs.entries) {
					const alias = entry?.hostId ? legacyById.get(entry.hostId) : undefined;
					if (alias && typeof entry.directory === 'string' && entry.directory.trim()) {
						addRecentFolder(alias, entry.directory.trim());
					}
				}
			}
		} catch {
			// ignore
		}

		// 4. Merge all discovered hosts into `this.hosts`
		let importedCount = 0;
		let updatedCount = 0;
		let importedRecentFolders = 0;
		const now = Date.now();

		const candidateAliases = new Set<string>([
			...sshHosts.keys(),
			...legacyByAlias.keys(),
		]);
		// Also include hosts from `remote.SSH.remotePlatform` if they look like valid hostnames/IPs or have recent folders
		for (const key of platformByHost.keys()) {
			if (sshHosts.has(key) || legacyByAlias.has(key) || recentFoldersByAuthority.has(key) || /^\d+\.\d+\.\d+\.\d+$/.test(key)) {
				candidateAliases.add(key);
			}
		}

		// Skip duplicate raw IP alias if a named alias in sshHosts already has exact same HostName, User & Port AND the IP itself has no unique recent folders
		const namedAliases = [...candidateAliases].filter(a => !/^\d+\.\d+\.\d+\.\d+$/.test(a));

		for (const rawAlias of candidateAliases) {
			const sshRec = sshHosts.get(rawAlias);
			const legacyRec = legacyByAlias.get(rawAlias);
			const extraAuth = extraAuthorities.get(rawAlias);

			if (/^\d+\.\d+\.\d+\.\d+$/.test(rawAlias) && !recentFoldersByAuthority.has(rawAlias)) {
				const coveredByNamed = namedAliases.some(na => {
					const nSsh = sshHosts.get(na);
					return nSsh && nSsh.hostName === rawAlias && nSsh.user === sshRec?.user && (nSsh.port ?? 22) === (sshRec?.port ?? 22);
				});
				if (coveredByNamed) {
					continue;
				}
			}

			const alias = sanitizeSshAlias(rawAlias);
			const osKind: AdeCloudHostOs = platformByHost.get(rawAlias)
				?? platformByHost.get(alias)
				?? legacyRec?.os
				?? (/windows/i.test(rawAlias) ? 'windows' : 'linux');

			const rawRecents = [
				...(recentFoldersByAuthority.get(rawAlias) ?? []),
				...(sshRec?.hostName && sshRec.hostName !== rawAlias ? (recentFoldersByAuthority.get(sshRec.hostName) ?? []) : []),
				...(legacyRec?.defaultDirectory ? [legacyRec.defaultDirectory] : []),
			];
			const normRecents = Array.from(new Set(rawRecents.map(p => normalizeRemoteProjectPath(p, osKind)))).slice(0, 25);

			const existingIdx = this.hosts.findIndex(h => h.alias.toLowerCase() === alias.toLowerCase());
			if (existingIdx >= 0) {
				const prev = this.hosts[existingIdx];
				const combinedRecents = Array.from(new Set([...prev.recentDirectories, ...normRecents])).slice(0, 25);
				const addedFolders = combinedRecents.length - prev.recentDirectories.length;
				const shouldEnrichNonUser = prev.source !== 'user';
				const nextHost: IAdeCloudHost = {
					...prev,
					hostName: shouldEnrichNonUser ? (sshRec?.hostName ?? legacyRec?.hostName ?? prev.hostName) : prev.hostName,
					user: shouldEnrichNonUser ? (sshRec?.user ?? legacyRec?.user ?? extraAuth?.user ?? prev.user) : (prev.user ?? sshRec?.user),
					port: shouldEnrichNonUser ? (sshRec?.port ?? legacyRec?.port ?? extraAuth?.port ?? prev.port) : prev.port,
					os: prev.source === 'user' ? prev.os : osKind,
					identityFile: prev.identityFile ?? sshRec?.identityFile ?? legacyRec?.identityFile,
					proxyJump: prev.proxyJump ?? sshRec?.proxyJump,
					hostKeyAlias: prev.hostKeyAlias ?? sshRec?.hostKeyAlias,
					knownHostsFile: prev.knownHostsFile ?? sshRec?.knownHostsFile ?? legacyRec?.knownHostsFile,
					strictHostKeyChecking: prev.strictHostKeyChecking ?? sshRec?.strictHostKeyChecking,
					defaultDirectory: prev.defaultDirectory ?? (legacyRec?.defaultDirectory ? normalizeRemoteProjectPath(legacyRec.defaultDirectory, osKind) : normRecents[0]),
					recentDirectories: combinedRecents,
					updatedAt: addedFolders > 0 ? now : prev.updatedAt,
				};
				if (JSON.stringify(nextHost) !== JSON.stringify(prev)) {
					this.hosts[existingIdx] = nextHost;
					updatedCount++;
					importedRecentFolders += Math.max(0, addedFolders);
				}
			} else {
				const source: AdeCloudHostSource = platformByHost.has(rawAlias) || recentFoldersByAuthority.has(rawAlias)
					? 'vscode'
					: (sshRec ? 'ssh-config' : 'aexus-legacy');
				const created: IAdeCloudHost = {
					id: legacyRec?.id ?? crypto.randomUUID(),
					name: legacyRec?.name ?? rawAlias,
					alias,
					hostName: sshRec?.hostName ?? legacyRec?.hostName ?? extraAuth?.aliasOrHost ?? rawAlias,
					user: sshRec?.user ?? legacyRec?.user ?? extraAuth?.user,
					port: sshRec?.port ?? legacyRec?.port ?? extraAuth?.port ?? 22,
					os: osKind,
					identityFile: sshRec?.identityFile ?? legacyRec?.identityFile,
					proxyJump: sshRec?.proxyJump,
					hostKeyAlias: sshRec?.hostKeyAlias,
					knownHostsFile: sshRec?.knownHostsFile ?? legacyRec?.knownHostsFile,
					strictHostKeyChecking: sshRec?.strictHostKeyChecking,
					defaultDirectory: legacyRec?.defaultDirectory
						? normalizeRemoteProjectPath(legacyRec.defaultDirectory, osKind)
						: normRecents[0],
					recentDirectories: normRecents,
					source,
					createdAt: now,
					updatedAt: now,
				};
				this.hosts.push(created);
				importedCount++;
				importedRecentFolders += normRecents.length;
			}
		}

		if (persistIfChanged && (importedCount > 0 || updatedCount > 0)) {
			await this.enqueuePersist();
		}

		return {
			importedCount,
			updatedCount,
			totalHosts: this.hosts.length,
			importedRecentFolders,
			hosts: [...this.hosts],
		};
	}

	// =========================================================================
	// Multiplexed Non-Interactive SSH Transport (BatchMode=yes — ZERO popups!)
	// =========================================================================

	private async resolveHostTarget(authority: string): Promise<{ target: string; os: AdeCloudHostOs; host?: IAdeCloudHost }> {
		await this.ensureInitialized();
		const host = await this.getHost(authority);
		if (host) {
			return { target: host.alias, os: host.os, host };
		}
		return { target: authority, os: 'linux' };
	}

	private async runSshRaw(
		target: string,
		remoteCommand: string,
		options: { stdin?: Buffer; timeoutMs?: number; host?: IAdeCloudHost } = {},
	): Promise<{ code: number; stdout: Buffer; stderr: string }> {
		const timeoutMs = options.timeoutMs ?? 20_000;
		const sshArgs: string[] = [
			'-F', this.effectiveSshConfPath,
			'-T',
			'-o', 'BatchMode=yes',
			'-o', 'ConnectTimeout=8',
		];
		if (process.platform !== 'win32') {
			const myUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
			const uidTag = myUid !== undefined ? String(myUid) : 'u';
			// Use /tmp instead of macOS's long /var/folders/... TMPDIR so ControlPath + %C + temp suffix stays well under the 104-byte sockaddr_un limit.
			const muxDir = `/tmp/aexus-cm-${uidTag}`;
			try {
				await fs.mkdir(muxDir, { recursive: true, mode: 0o700 });
				const st = await fs.lstat(muxDir);
				if (st.isDirectory() && !st.isSymbolicLink() && (myUid === undefined || st.uid === myUid)) {
					await fs.chmod(muxDir, 0o700).catch(() => undefined);
					sshArgs.push(
						'-o', 'ControlMaster=auto',
						'-o', `ControlPath=${muxDir}/%C`,
						'-o', 'ControlPersist=60s',
					);
				}
			} catch {
				// Proceed without ControlMaster if private mux directory cannot be secured
			}
		}
		if (options.host?.strictHostKeyChecking === 'yes' || options.host?.strictHostKeyChecking === 'accept-new' || options.host?.strictHostKeyChecking === 'no') {
			sshArgs.push('-o', `StrictHostKeyChecking=${options.host.strictHostKeyChecking}`);
		}
		sshArgs.push('--', target, remoteCommand);

		return new Promise((resolve, reject) => {
			const child = spawn(this.sshExecutable, sshArgs, {
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: {
					...stripAdeControlEnv(process.env),
					SSH_ASKPASS_REQUIRE: 'never',
					DISPLAY: '',
				},
			});
			child.stdin.on('error', () => {
				// Prevent unhandled EPIPE if SSH exits before consuming stdin
			});

			const outChunks: Buffer[] = [];
			let stderr = '';
			let settled = false;

			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					child.kill('SIGKILL');
					reject(new Error(`SSH operation timed out after ${timeoutMs}ms (${target})`));
				}
			}, timeoutMs);

			child.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (chunk: string) => { stderr += chunk; });

			child.once('error', err => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(err);
				}
			});

			child.once('close', code => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve({
						code: code ?? 1,
						stdout: Buffer.concat(outChunks),
						stderr: stderr.trim(),
					});
				}
			});

			if (options.stdin) {
				child.stdin.end(options.stdin);
			} else {
				child.stdin.end();
			}
		});
	}

	async testConnection(idOrAlias: string): Promise<IAdeCloudHostConnectionCheck> {
		const startedAt = Date.now();
		const { target, os: declaredOs, host } = await this.resolveHostTarget(idOrAlias);
		const winProbeCmd = `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellScript(`$ErrorActionPreference='Stop'; Write-Output ('WINDOWS|' + $env:USERPROFILE)`)}`;
		const posixProbeCmd = `sh -c 'u=$(uname -s 2>/dev/null || echo Linux); d=""; if [ -r /etc/os-release ]; then d=$(. /etc/os-release 2>/dev/null && printf "%s" "\${ID:-}"); fi; if [ -n "$d" ]; then printf "%s (%s)|%s\\n" "$u" "$d" "$HOME"; else printf "%s|%s\\n" "$u" "$HOME"; fi'`;
		try {
			const primaryCmd = declaredOs === 'windows' ? winProbeCmd : posixProbeCmd;
			let res = await this.runSshRaw(target, primaryCmd, { timeoutMs: 12_000, host });
			if (res.code !== 0 && !/permission denied|connection refused|timed out|could not resolve|no route to host|host key verification failed/i.test(res.stderr)) {
				const altCmd = declaredOs === 'windows' ? posixProbeCmd : winProbeCmd;
				const altRes = await this.runSshRaw(target, altCmd, { timeoutMs: 10_000, host });
				if (altRes.code === 0) {
					res = altRes;
				}
			}
			const latencyMs = Date.now() - startedAt;
			if (res.code !== 0) {
				const check: IAdeCloudHostConnectionCheck = {
					ok: false,
					checkedAt: Date.now(),
					latencyMs,
					error: res.stderr || `SSH exited with code ${res.code}`,
				};
				await this.saveHostTestStatus(host?.id, check);
				return check;
			}
			const line = res.stdout.toString('utf8').trim().split(/\r?\n/).pop() ?? '';
			const [unameRaw, homeRaw] = line.split('|');
			const detectedOs: AdeCloudHostOs = /windows/i.test(unameRaw)
				? 'windows'
				: (/darwin/i.test(unameRaw) ? 'macos' : (/linux/i.test(unameRaw) ? 'linux' : declaredOs));
			const check: IAdeCloudHostConnectionCheck = {
				ok: true,
				checkedAt: Date.now(),
				remoteUname: unameRaw?.trim() || undefined,
				remoteHome: homeRaw?.trim() || undefined,
				os: detectedOs,
				latencyMs,
			};
			await this.saveHostTestStatus(host?.id, check, homeRaw?.trim());
			return check;
		} catch (err) {
			const check: IAdeCloudHostConnectionCheck = {
				ok: false,
				checkedAt: Date.now(),
				latencyMs: Date.now() - startedAt,
				error: err instanceof Error ? err.message : String(err),
			};
			await this.saveHostTestStatus(host?.id, check);
			return check;
		}
	}

	private async saveHostTestStatus(hostId: string | undefined, status: IAdeCloudHostConnectionCheck, discoveredHome?: string): Promise<void> {
		if (!hostId) {
			return;
		}
		const idx = this.hosts.findIndex(h => h.id === hostId);
		if (idx < 0) {
			return;
		}
		const cur = this.hosts[idx];
		const nextOs = status.os ?? cur.os;
		const existingDefaultIncompatible = Boolean(
			cur.defaultDirectory && (
				(nextOs === 'windows' && !/^\/[A-Za-z]:/.test(cur.defaultDirectory))
				|| (nextOs !== 'windows' && /^\/[A-Za-z]:/.test(cur.defaultDirectory))
			),
		);
		const nextDefaultDir = (!cur.defaultDirectory || existingDefaultIncompatible || isShallowRemoteRootPath(cur.defaultDirectory, nextOs))
			? (discoveredHome ? normalizeRemoteProjectPath(discoveredHome, nextOs) : cur.defaultDirectory)
			: cur.defaultDirectory;
		this.hosts[idx] = {
			...cur,
			os: nextOs,
			defaultDirectory: nextDefaultDir,
			lastTestStatus: status,
		};
		await this.enqueuePersist();
		this._onDidChangeHosts.fire();
	}

	private throwMappedRemoteError(res: { code: number; stdout: Buffer; stderr: string }, target: string, remotePath: string): never {
		const combined = `${res.stdout.toString('utf8')}\n${res.stderr}`;
		if (combined.includes('__AEXUS_ERR__:ENOENT')) {
			throw new Error(`[ENOENT] File or directory not found on ${target}: ${remotePath}`);
		}
		if (combined.includes('__AEXUS_ERR__:EEXIST')) {
			throw new Error(`[EEXIST] Target already exists on ${target}: ${remotePath}`);
		}
		if (combined.includes('__AEXUS_ERR__:EISDIR')) {
			throw new Error(`[EISDIR] Target is a directory on ${target}: ${remotePath}`);
		}
		if (combined.includes('__AEXUS_ERR__:ENOTDIR')) {
			throw new Error(`[ENOTDIR] Target is not a directory on ${target}: ${remotePath}`);
		}
		if (combined.includes('__AEXUS_ERR__:EACCES') || /permission denied/i.test(res.stderr)) {
			throw new Error(`[EACCES] Permission denied on ${target}: ${res.stderr || remotePath}`);
		}
		throw new Error(`SSH command failed on ${target} (${remotePath}): ${res.stderr || `exit ${res.code}`}`);
	}

	async remoteStat(authority: string, remotePath: string): Promise<IAdeRemoteFileStat> {
		const { target, os: hostOs, host } = await this.resolveHostTarget(authority);
		const norm = normalizeRemoteProjectPath(remotePath, hostOs);

		if (hostOs === 'windows') {
			if (norm === '/') {
				return { type: 'directory', ctime: 0, mtime: 0, size: 0 };
			}
			const winPath = toRemoteNativePath(norm, 'windows').replace(/'/g, `''`);
			const ps = [
				`$ErrorActionPreference='Stop';`,
				`$p='${winPath}';`,
				`if (-not (Test-Path -LiteralPath $p)) { Write-Output '__AEXUS_ERR__:ENOENT'; exit 2 }`,
				`$i = Get-Item -LiteralPath $p -Force;`,
				`$t = if ($i.PSIsContainer) { 'directory' } else { 'file' };`,
				`$m = [int64]([DateTimeOffset]$i.LastWriteTimeUtc).ToUnixTimeMilliseconds();`,
				`$c = [int64]([DateTimeOffset]$i.CreationTimeUtc).ToUnixTimeMilliseconds();`,
				`$s = if ($i.PSIsContainer) { 0 } else { [int64]$i.Length };`,
				`Write-Output "$t|$c|$m|$s"`,
			].join(' ');
			const res = await this.runSshRaw(target, `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellScript(ps)}`, { host });
			if (res.code !== 0) {
				this.throwMappedRemoteError(res, target, norm);
			}
			const [kind, cStr, mStr, sStr] = res.stdout.toString('utf8').trim().split(/\r?\n/).pop()!.split('|');
			return {
				type: kind === 'directory' ? 'directory' : 'file',
				ctime: Number(cStr) || Date.now(),
				mtime: Number(mStr) || Date.now(),
				size: Number(sStr) || 0,
			};
		}

		const q = posixQuote(norm);
		const script = [
			`p=${q};`,
			`if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo "__AEXUS_ERR__:ENOENT"; exit 2; fi;`,
			`is_link=0; if [ -L "$p" ]; then is_link=1; fi;`,
			`if [ -d "$p" ]; then kind="directory"; elif [ -f "$p" ]; then kind="file"; else kind="unknown"; fi;`,
			// Portable GNU stat (-c) & BSD/macOS stat (-f) fallback
			`meta=$(stat -c "%Y %s" "$p" 2>/dev/null || stat -f "%m %z" "$p" 2>/dev/null || echo "0 0");`,
			`printf "%s|%s|%s\\n" "$kind" "$is_link" "$meta"`,
		].join(' ');
		const res = await this.runSshRaw(target, `sh -c ${posixQuote(script)}`, { host });
		if (res.code !== 0) {
			this.throwMappedRemoteError(res, target, norm);
		}
		const line = res.stdout.toString('utf8').trim().split(/\r?\n/).pop() ?? '';
		const [kindRaw, , metaRaw] = line.split('|');
		const [mtimeSecStr, sizeStr] = (metaRaw ?? '0 0').trim().split(/\s+/);
		const mtimeMs = (Number(mtimeSecStr) || 0) * 1000;
		return {
			type: kindRaw === 'directory' ? 'directory' : (kindRaw === 'file' ? 'file' : 'unknown'),
			ctime: mtimeMs,
			mtime: mtimeMs,
			size: Number(sizeStr) || 0,
		};
	}

	async remoteReadDir(authority: string, remotePath: string): Promise<readonly IAdeRemoteDirEntry[]> {
		const { target, os: hostOs, host } = await this.resolveHostTarget(authority);
		const norm = normalizeRemoteProjectPath(remotePath, hostOs);

		if (hostOs === 'windows') {
			if (norm === '/') {
				const drivePs = `$ErrorActionPreference='Stop'; [IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady } | ForEach-Object { Write-Output ('directory' + [char]9 + $_.Name.TrimEnd('\\').TrimEnd('/')) }`;
				const driveRes = await this.runSshRaw(target, `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellScript(drivePs)}`, { host });
				if (driveRes.code !== 0) {
					this.throwMappedRemoteError(driveRes, target, norm);
				}
				return driveRes.stdout.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => {
					const tabIdx = line.indexOf('\t');
					const name = tabIdx >= 0 ? line.slice(tabIdx + 1).trim() : line.trim();
					return { name, type: 'directory' as const };
				}).filter(e => /^[A-Za-z]:$/.test(e.name));
			}
			const winPath = toRemoteNativePath(norm, 'windows').replace(/'/g, `''`);
			const ps = [
				`$ErrorActionPreference='Stop';`,
				`$p='${winPath}';`,
				`if (-not (Test-Path -LiteralPath $p)) { Write-Output '__AEXUS_ERR__:ENOENT'; exit 2 }`,
				`$root = Get-Item -LiteralPath $p -Force;`,
				`if (-not $root.PSIsContainer) { Write-Output '__AEXUS_ERR__:ENOTDIR'; exit 3 }`,
				`Get-ChildItem -LiteralPath $p -Force | ForEach-Object {`,
				`  $t = if ($_.PSIsContainer) { 'directory' } else { 'file' };`,
				`  Write-Output ($t + [char]9 + $_.Name)`,
				`}`,
			].join(' ');
			const res = await this.runSshRaw(target, `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellScript(ps)}`, { host });
			if (res.code !== 0) {
				this.throwMappedRemoteError(res, target, norm);
			}
			return res.stdout.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => {
				const tabIdx = line.indexOf('\t');
				const kind = line.slice(0, tabIdx);
				const name = line.slice(tabIdx + 1);
				return {
					name,
					type: kind === 'directory' ? 'directory' as const : 'file' as const,
				};
			}).filter(e => Boolean(e.name));
		}

		const q = posixQuote(norm);
		const script = [
			`p=${q};`,
			`if [ ! -e "$p" ]; then echo "__AEXUS_ERR__:ENOENT"; exit 2; fi;`,
			`if [ ! -d "$p" ]; then echo "__AEXUS_ERR__:ENOTDIR"; exit 3; fi;`,
			`cd -- "$p" || { echo "__AEXUS_ERR__:EACCES"; exit 4; };`,
			`for f in * .[!.]* ..?*; do`,
			`  [ -e "$f" ] || [ -L "$f" ] || continue;`,
			`  if [ -d "$f" ]; then t="directory"; elif [ -f "$f" ]; then t="file"; else t="unknown"; fi;`,
			`  printf "%s\\t%s\\0" "$t" "$f";`,
			`done`,
		].join(' ');
		const res = await this.runSshRaw(target, `sh -c ${posixQuote(script)}`, { host });
		if (res.code !== 0) {
			this.throwMappedRemoteError(res, target, norm);
		}
		const entries: IAdeRemoteDirEntry[] = [];
		for (const rec of res.stdout.toString('utf8').split('\0')) {
			if (!rec) {
				continue;
			}
			const tabIdx = rec.indexOf('\t');
			if (tabIdx <= 0) {
				continue;
			}
			const kind = rec.slice(0, tabIdx);
			const name = rec.slice(tabIdx + 1);
			if (!name || name === '.' || name === '..') {
				continue;
			}
			entries.push({
				name,
				type: kind === 'directory' ? 'directory' : (kind === 'file' ? 'file' : 'unknown'),
			});
		}
		return entries;
	}

	async remoteReadFile(authority: string, remotePath: string): Promise<VSBuffer> {
		const { target, os: hostOs, host } = await this.resolveHostTarget(authority);
		const norm = normalizeRemoteProjectPath(remotePath, hostOs);

		if (hostOs === 'windows') {
			const winPath = toRemoteNativePath(norm, 'windows').replace(/'/g, `''`);
			const ps = [
				`$ErrorActionPreference='Stop';`,
				`$p='${winPath}';`,
				`if (-not (Test-Path -LiteralPath $p)) { Write-Output '__AEXUS_ERR__:ENOENT'; exit 2 }`,
				`$i = Get-Item -LiteralPath $p -Force;`,
				`if ($i.PSIsContainer) { Write-Output '__AEXUS_ERR__:EISDIR'; exit 3 }`,
				`[Convert]::ToBase64String([IO.File]::ReadAllBytes($i.FullName))`,
			].join(' ');
			const res = await this.runSshRaw(target, `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellScript(ps)}`, { timeoutMs: 45_000, host });
			if (res.code !== 0) {
				this.throwMappedRemoteError(res, target, norm);
			}
			const b64 = res.stdout.toString('utf8').replace(/\s+/g, '');
			return VSBuffer.wrap(Buffer.from(b64, 'base64'));
		}

		const q = posixQuote(norm);
		const script = `p=${q}; if [ ! -e "$p" ]; then echo "__AEXUS_ERR__:ENOENT" >&2; exit 2; fi; if [ -d "$p" ]; then echo "__AEXUS_ERR__:EISDIR" >&2; exit 3; fi; cat -- "$p"`;
		const res = await this.runSshRaw(target, `sh -c ${posixQuote(script)}`, { timeoutMs: 45_000, host });
		if (res.code !== 0) {
			this.throwMappedRemoteError(res, target, norm);
		}
		return VSBuffer.wrap(res.stdout);
	}

	async remoteWriteFile(
		authority: string,
		remotePath: string,
		content: VSBuffer,
		options: { readonly create: boolean; readonly overwrite: boolean },
	): Promise<void> {
		const { target, os: hostOs, host } = await this.resolveHostTarget(authority);
		const norm = normalizeRemoteProjectPath(remotePath, hostOs);
		const rawBytes = Buffer.from(content.buffer);

		if (hostOs === 'windows') {
			const winPath = toRemoteNativePath(norm, 'windows').replace(/'/g, `''`);
			const b64 = rawBytes.toString('base64');
			const ps = [
				`$ErrorActionPreference='Stop';`,
				`$p='${winPath}';`,
				`$exists = Test-Path -LiteralPath $p;`,
				`if (-not $exists -and -not $${options.create ? 'true' : 'false'}) { Write-Output '__AEXUS_ERR__:ENOENT'; exit 2 }`,
				`if ($exists -and -not $${options.overwrite ? 'true' : 'false'}) { Write-Output '__AEXUS_ERR__:EEXIST'; exit 3 }`,
				`$dir = Split-Path -Parent $p; if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }`,
				`$b64 = [Console]::In.ReadToEnd().Trim();`,
				`[IO.File]::WriteAllBytes($p, [Convert]::FromBase64String($b64))`,
			].join(' ');
			const res = await this.runSshRaw(
				target,
				`powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellScript(ps)}`,
				{ stdin: Buffer.from(b64, 'utf8'), timeoutMs: 45_000, host },
			);
			if (res.code !== 0) {
				this.throwMappedRemoteError(res, target, norm);
			}
			return;
		}

		const q = posixQuote(norm);
		const script = [
			`p=${q};`,
			`if [ -d "$p" ]; then echo "__AEXUS_ERR__:EISDIR" >&2; exit 4; fi;`,
			options.create ? '' : `if [ ! -e "$p" ]; then echo "__AEXUS_ERR__:ENOENT" >&2; exit 2; fi;`,
			options.overwrite ? '' : `if [ -e "$p" ]; then echo "__AEXUS_ERR__:EEXIST" >&2; exit 3; fi;`,
			`dir=$(dirname -- "$p"); mkdir -p -- "$dir" || { echo "__AEXUS_ERR__:EACCES" >&2; exit 5; };`,
			`tmp="$p.aexus-tmp.$$";`,
			`cat > "$tmp" && mv -f -- "$tmp" "$p"`,
		].filter(Boolean).join(' ');
		const res = await this.runSshRaw(target, `sh -c ${posixQuote(script)}`, { stdin: rawBytes, timeoutMs: 45_000, host });
		if (res.code !== 0) {
			this.throwMappedRemoteError(res, target, norm);
		}
	}

	async remoteMkdir(authority: string, remotePath: string): Promise<void> {
		const { target, os: hostOs, host } = await this.resolveHostTarget(authority);
		const norm = normalizeRemoteProjectPath(remotePath, hostOs);
		if (hostOs === 'windows') {
			const winPath = toRemoteNativePath(norm, 'windows').replace(/'/g, `''`);
			const ps = `$ErrorActionPreference='Stop'; [IO.Directory]::CreateDirectory('${winPath}') | Out-Null`;
			const res = await this.runSshRaw(target, `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellScript(ps)}`, { host });
			if (res.code !== 0) {
				this.throwMappedRemoteError(res, target, norm);
			}
			return;
		}
		const res = await this.runSshRaw(target, `mkdir -p -- ${posixQuote(norm)}`, { host });
		if (res.code !== 0) {
			this.throwMappedRemoteError(res, target, norm);
		}
	}

	async remoteDelete(authority: string, remotePath: string, recursive: boolean): Promise<void> {
		const { target, os: hostOs, host } = await this.resolveHostTarget(authority);
		const norm = normalizeRemoteProjectPath(remotePath, hostOs);
		if (norm === '/' || /^\/[A-Za-z]:\/?$/.test(norm)) {
			throw new Error(`[EACCES] Refusing to delete filesystem root: ${norm}`);
		}
		if (hostOs === 'windows') {
			const winPath = toRemoteNativePath(norm, 'windows').replace(/'/g, `''`);
			const ps = `$ErrorActionPreference='Stop'; $p='${winPath}'; if (-not (Test-Path -LiteralPath $p)) { Write-Output '__AEXUS_ERR__:ENOENT'; exit 2 }; Remove-Item -LiteralPath $p -Force ${recursive ? '-Recurse' : ''}`;
			const res = await this.runSshRaw(target, `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellScript(ps)}`, { host });
			if (res.code !== 0) {
				this.throwMappedRemoteError(res, target, norm);
			}
			return;
		}
		const q = posixQuote(norm);
		const script = recursive
			? `p=${q}; if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo "__AEXUS_ERR__:ENOENT" >&2; exit 2; fi; rm -rf -- "$p"`
			: `p=${q}; if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo "__AEXUS_ERR__:ENOENT" >&2; exit 2; fi; if [ -d "$p" ]; then rmdir -- "$p"; else rm -f -- "$p"; fi`;
		const res = await this.runSshRaw(target, `sh -c ${posixQuote(script)}`, { host });
		if (res.code !== 0) {
			this.throwMappedRemoteError(res, target, norm);
		}
	}

	async remoteRename(authority: string, fromPath: string, toPath: string, overwrite: boolean): Promise<void> {
		const { target, os: hostOs, host } = await this.resolveHostTarget(authority);
		const src = normalizeRemoteProjectPath(fromPath, hostOs);
		const dst = normalizeRemoteProjectPath(toPath, hostOs);
		if (hostOs === 'windows') {
			const winSrc = toRemoteNativePath(src, 'windows').replace(/'/g, `''`);
			const winDst = toRemoteNativePath(dst, 'windows').replace(/'/g, `''`);
			const ps = `$ErrorActionPreference='Stop'; if (-not (Test-Path -LiteralPath '${winSrc}')) { Write-Output '__AEXUS_ERR__:ENOENT'; exit 2 }; if ((Test-Path -LiteralPath '${winDst}') -and -not $${overwrite ? 'true' : 'false'}) { Write-Output '__AEXUS_ERR__:EEXIST'; exit 3 }; Move-Item -LiteralPath '${winSrc}' -Destination '${winDst}' ${overwrite ? '-Force' : ''}`;
			const res = await this.runSshRaw(target, `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellScript(ps)}`, { host });
			if (res.code !== 0) {
				this.throwMappedRemoteError(res, target, src);
			}
			return;
		}
		const qs = posixQuote(src);
		const qd = posixQuote(dst);
		const script = [
			`s=${qs}; d=${qd};`,
			`if [ ! -e "$s" ] && [ ! -L "$s" ]; then echo "__AEXUS_ERR__:ENOENT" >&2; exit 2; fi;`,
			overwrite ? '' : `if [ -e "$d" ]; then echo "__AEXUS_ERR__:EEXIST" >&2; exit 3; fi;`,
			`mkdir -p -- "$(dirname -- "$d")" && mv -f -- "$s" "$d"`,
		].filter(Boolean).join(' ');
		const res = await this.runSshRaw(target, `sh -c ${posixQuote(script)}`, { host });
		if (res.code !== 0) {
			this.throwMappedRemoteError(res, target, src);
		}
	}

	async remoteCopy(authority: string, fromPath: string, toPath: string, overwrite: boolean): Promise<void> {
		const { target, os: hostOs, host } = await this.resolveHostTarget(authority);
		const src = normalizeRemoteProjectPath(fromPath, hostOs);
		const dst = normalizeRemoteProjectPath(toPath, hostOs);
		if (hostOs === 'windows') {
			const winSrc = toRemoteNativePath(src, 'windows').replace(/'/g, `''`);
			const winDst = toRemoteNativePath(dst, 'windows').replace(/'/g, `''`);
			const ps = `$ErrorActionPreference='Stop'; if (-not (Test-Path -LiteralPath '${winSrc}')) { Write-Output '__AEXUS_ERR__:ENOENT'; exit 2 }; if ((Test-Path -LiteralPath '${winDst}') -and -not $${overwrite ? 'true' : 'false'}) { Write-Output '__AEXUS_ERR__:EEXIST'; exit 3 }; Copy-Item -LiteralPath '${winSrc}' -Destination '${winDst}' -Recurse ${overwrite ? '-Force' : ''}`;
			const res = await this.runSshRaw(target, `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellScript(ps)}`, { host });
			if (res.code !== 0) {
				this.throwMappedRemoteError(res, target, src);
			}
			return;
		}
		const qs = posixQuote(src);
		const qd = posixQuote(dst);
		const script = [
			`s=${qs}; d=${qd};`,
			`if [ ! -e "$s" ] && [ ! -L "$s" ]; then echo "__AEXUS_ERR__:ENOENT" >&2; exit 2; fi;`,
			overwrite ? `rm -rf -- "$d";` : `if [ -e "$d" ]; then echo "__AEXUS_ERR__:EEXIST" >&2; exit 3; fi;`,
			`mkdir -p -- "$(dirname -- "$d")" && cp -R -- "$s" "$d"`,
		].join(' ');
		const res = await this.runSshRaw(target, `sh -c ${posixQuote(script)}`, { host });
		if (res.code !== 0) {
			this.throwMappedRemoteError(res, target, src);
		}
	}

	async remoteGitStatus(authority: string, projectPath: string): Promise<readonly IAdeRemoteScmStatusEntry[]> {
		const { target, os: hostOs, host } = await this.resolveHostTarget(authority);
		const norm = normalizeRemoteProjectPath(projectPath, hostOs);
		let res: { code: number | null; stdout: Buffer; stderr: string };
		if (hostOs === 'windows') {
			const winPath = toRemoteNativePath(norm, 'windows').replace(/'/g, `''`);
			const ps = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Set-Location -LiteralPath '${winPath}' -ErrorAction SilentlyContinue; if ($?) { git status --porcelain=v1 -z 2>$null }`;
			res = await this.runSshRaw(target, `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellScript(ps)}`, { timeoutMs: 12_000, host });
		} else {
			const script = `cd -- ${posixQuote(norm)} 2>/dev/null && git status --porcelain=v1 -z 2>/dev/null || true`;
			res = await this.runSshRaw(target, `sh -c ${posixQuote(script)}`, { timeoutMs: 12_000, host });
		}
		if (res.code !== 0 || res.stdout.length === 0) {
			return [];
		}
		const tokens = res.stdout.toString('utf8').split('\0');
		const items: IAdeRemoteScmStatusEntry[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const entry = tokens[i];
			if (entry.length < 4) {
				continue;
			}
			const x = entry[0];
			const y = entry[1];
			const relPath = entry.slice(3);
			if (x === 'R' || x === 'C') {
				i++; // skip rename source token in -z format
			}
			let status: IAdeRemoteScmStatusEntry['status'] = 'M';
			if (x === '?' || y === '?') {
				status = 'U';
			} else if (x === 'A' || y === 'A') {
				status = 'A';
			} else if (x === 'D' || y === 'D') {
				status = 'D';
			} else if (x === 'R' || y === 'R') {
				status = 'R';
			}
			items.push({
				relativePath: relPath,
				status,
				staged: x !== ' ' && x !== '?',
			});
		}
		return items;
	}

	async remoteGitShowHead(authority: string, projectPath: string, relativePath: string): Promise<string> {
		const { target, os: hostOs, host } = await this.resolveHostTarget(authority);
		const norm = normalizeRemoteProjectPath(projectPath, hostOs);
		const cleanRel = relativePath.replace(/^[\\/]+/, '').replace(/\\/g, '/');
		if (hostOs === 'windows') {
			const winPath = toRemoteNativePath(norm, 'windows').replace(/'/g, `''`);
			const escapedRel = cleanRel.replace(/'/g, `''`);
			const ps = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Set-Location -LiteralPath '${winPath}' -ErrorAction SilentlyContinue; if ($?) { git show ('HEAD:' + '${escapedRel}') 2>$null }`;
			const res = await this.runSshRaw(target, `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellScript(ps)}`, { timeoutMs: 12_000, host });
			return res.stdout.toString('utf8');
		}
		const script = `cd -- ${posixQuote(norm)} && git show ${posixQuote(`HEAD:${cleanRel}`)} 2>/dev/null || true`;
		const res = await this.runSshRaw(target, `sh -c ${posixQuote(script)}`, { timeoutMs: 12_000, host });
		return res.stdout.toString('utf8');
	}
}
