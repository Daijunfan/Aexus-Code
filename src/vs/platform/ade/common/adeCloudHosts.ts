/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { Schemas } from '../../../base/common/network.js';
import { posix } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const AEXUS_SSH_SCHEME = 'aexus-ssh';
export const AEXUS_SSH_GIT_HEAD_SCHEME = 'aexus-ssh-git-head';
export const ADE_CLOUD_HOST_BACKEND_CHANNEL_NAME = 'adeCloudHostBackend';

export type AdeCloudHostOs = 'linux' | 'macos' | 'windows';
export type AdeCloudHostSource = 'user' | 'vscode' | 'ssh-config' | 'aexus-legacy';
export type AdeOsIconKind = 'windows' | 'macos' | 'kali' | 'ubuntu' | 'debian' | 'enterprise-linux' | 'linux';

export const ADE_OS_ICON_LABELS: Readonly<Record<AdeOsIconKind, string>> = {
	windows: 'Windows',
	macos: 'macOS',
	kali: 'Kali',
	ubuntu: 'Ubuntu',
	debian: 'Debian',
	'enterprise-linux': 'Enterprise Linux',
	linux: 'Linux',
};

export function resolveAdeOsIconKind(input: {
	readonly os?: AdeCloudHostOs;
	readonly distribution?: string;
	readonly hint?: string;
}): AdeOsIconKind {
	const source = `${input.distribution ?? ''} ${input.hint ?? ''}`;
	if (input.os === 'windows' || (!input.os && /\b(win32|win64|windows)\b/i.test(source))) {
		return 'windows';
	}
	if (input.os === 'macos' || (!input.os && /\b(macos|darwin|osx)\b/i.test(source))) {
		return 'macos';
	}
	if (/\bkali\b/i.test(source)) {
		return 'kali';
	}
	if (/\bubuntu\b/i.test(source)) {
		return 'ubuntu';
	}
	if (/\bdebian\b/i.test(source)) {
		return 'debian';
	}
	if (/\b(centos|rocky|alma|rhel|redhat|fedora)\b/i.test(source)) {
		return 'enterprise-linux';
	}
	return 'linux';
}

export interface IAdeCloudHostConnectionCheck {
	readonly ok: boolean;
	readonly checkedAt: number;
	readonly remoteHome?: string;
	readonly remoteUname?: string;
	readonly os?: AdeCloudHostOs;
	readonly latencyMs: number;
	readonly error?: string;
}

export interface IAdeCloudHost {
	readonly id: string;
	readonly name: string;
	readonly alias: string;
	readonly hostName: string;
	readonly user?: string;
	readonly port: number;
	readonly os: AdeCloudHostOs;
	readonly identityFile?: string;
	readonly proxyJump?: string;
	readonly hostKeyAlias?: string;
	readonly knownHostsFile?: string;
	readonly strictHostKeyChecking?: 'yes' | 'accept-new' | 'no';
	readonly defaultDirectory?: string;
	readonly recentDirectories: readonly string[];
	readonly source: AdeCloudHostSource;
	readonly notes?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly lastTestStatus?: IAdeCloudHostConnectionCheck;
}

export interface IAdeCloudHostUpsertInput {
	readonly id?: string;
	readonly name: string;
	readonly alias?: string;
	readonly hostName: string;
	readonly user?: string;
	readonly port?: number;
	readonly os?: AdeCloudHostOs;
	readonly identityFile?: string;
	readonly proxyJump?: string;
	readonly hostKeyAlias?: string;
	readonly knownHostsFile?: string;
	readonly strictHostKeyChecking?: 'yes' | 'accept-new' | 'no';
	readonly defaultDirectory?: string;
	readonly recentDirectories?: readonly string[];
	readonly notes?: string;
}

export interface IAdeCloudHostImportResult {
	readonly importedCount: number;
	readonly updatedCount: number;
	readonly totalHosts: number;
	readonly importedRecentFolders: number;
	readonly hosts: readonly IAdeCloudHost[];
}

export interface IAdeRemoteFileStat {
	readonly type: 'file' | 'directory' | 'symlink' | 'unknown';
	readonly ctime: number;
	readonly mtime: number;
	readonly size: number;
	readonly readonly?: boolean;
}

export interface IAdeRemoteDirEntry {
	readonly name: string;
	readonly type: 'file' | 'directory' | 'symlink' | 'unknown';
}

export interface IAdeRemoteScmStatusEntry {
	readonly relativePath: string;
	readonly status: 'M' | 'A' | 'D' | 'U' | 'R';
	readonly staged: boolean;
}

export function sanitizeSshAlias(raw: string): string {
	const cleaned = raw.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._@-]/g, '-').replace(/^-+/, '');
	return cleaned || 'cloud-host';
}

export function normalizeRemoteProjectPath(rawPath: string, os: AdeCloudHostOs = 'linux'): string {
	let trimmed = rawPath.trim();
	if (!trimmed) {
		return os === 'windows' ? '/C:' : '/';
	}
	if (os === 'windows') {
		trimmed = trimmed.replace(/\\/g, '/');
		if (trimmed === '/') {
			return '/';
		}
		if (/^\/\/[^/]+/.test(trimmed)) {
			const uncRest = posix.normalize(trimmed.slice(1));
			const unc = `/${uncRest}`;
			return unc.length > 2 && unc.endsWith('/') ? unc.slice(0, -1) : unc;
		}
		if (/^[A-Za-z]:$/.test(trimmed)) {
			trimmed = `/${trimmed.toUpperCase()}/`;
		} else if (/^[A-Za-z]:\//.test(trimmed)) {
			trimmed = `/${trimmed[0].toUpperCase()}${trimmed.slice(1)}`;
		} else if (/^\/[A-Za-z]:(?:\/|$)/.test(trimmed)) {
			trimmed = `/${trimmed[1].toUpperCase()}${trimmed.slice(2)}`;
		} else if (!trimmed.startsWith('/')) {
			trimmed = `/${trimmed}`;
		}
	} else if (!trimmed.startsWith('/')) {
		trimmed = `/${trimmed}`;
	}
	const normalized = posix.normalize(trimmed);
	return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function toRemoteNativePath(uriPath: string, os: AdeCloudHostOs = 'linux'): string {
	const clean = uriPath || '/';
	if (os === 'windows') {
		if (clean === '/') {
			return '/';
		}
		if (/^\/\/[^/]+/.test(clean)) {
			return clean.replace(/\//g, '\\');
		}
		const m = /^\/([A-Za-z]:(?:\/.*)?)$/.exec(clean);
		if (m) {
			const winForward = m[1].length === 2 ? `${m[1]}/` : m[1];
			return winForward.replace(/\//g, '\\');
		}
	}
	return clean;
}

export interface IParsedLiveRemotePathInput {
	readonly browseDir: string;
	readonly filterPrefix: string;
	readonly targetPath: string;
	readonly parentDir: string | undefined;
	readonly isWindowsDriveRoot: boolean;
	readonly omitLeadingSlashOnWindows: boolean;
}

export function isShallowRemoteRootPath(rawPath: string | undefined, os: AdeCloudHostOs = 'linux'): boolean {
	if (!rawPath?.trim()) {
		return true;
	}
	const norm = normalizeRemoteProjectPath(rawPath, os);
	return norm === '/' || (os === 'windows' && /^\/[A-Za-z]:$/.test(norm));
}

export function guessRemoteUserHomeDirectory(os: AdeCloudHostOs, rawUser?: string): string | undefined {
	const trimmed = rawUser?.trim();
	if (!trimmed) {
		return undefined;
	}
	// Strip AD/Windows domain qualifiers such as "administrator@ad.vmlab.test" or "DOMAIN\\user"
	const withoutDomainPrefix = trimmed.includes('\\')
		? trimmed.slice(trimmed.lastIndexOf('\\') + 1).trim()
		: trimmed;
	const baseUser = withoutDomainPrefix.includes('@')
		? withoutDomainPrefix.split('@')[0].trim()
		: withoutDomainPrefix;
	if (!baseUser) {
		return undefined;
	}
	if (os === 'windows') {
		return normalizeRemoteProjectPath(`/C:/Users/${baseUser}`, 'windows');
	}
	if (os === 'macos') {
		return normalizeRemoteProjectPath(`/Users/${baseUser}`, 'macos');
	}
	if (baseUser === 'root') {
		return '/root';
	}
	return normalizeRemoteProjectPath(`/home/${baseUser}`, 'linux');
}

export function resolveInitialCloudHostDirectory(host: Pick<IAdeCloudHost, 'os' | 'user' | 'defaultDirectory' | 'recentDirectories' | 'lastTestStatus'>): string {
	// Prefer a non-root saved default, non-root recent folder, or probed remote home before falling back to guessed user home.
	const explicitDefault = host.defaultDirectory?.trim();
	if (explicitDefault && !isShallowRemoteRootPath(explicitDefault, host.os)) {
		return normalizeRemoteProjectPath(explicitDefault, host.os);
	}
	const nonRootRecent = host.recentDirectories.find(dir => dir.trim() && !isShallowRemoteRootPath(dir, host.os));
	if (nonRootRecent) {
		return normalizeRemoteProjectPath(nonRootRecent, host.os);
	}
	const discoveredHome = host.lastTestStatus?.remoteHome?.trim();
	if (discoveredHome && !isShallowRemoteRootPath(discoveredHome, host.os)) {
		return normalizeRemoteProjectPath(discoveredHome, host.os);
	}
	const guessedHome = guessRemoteUserHomeDirectory(host.os, host.user);
	if (guessedHome) {
		return guessedHome;
	}
	const fallbackExplicit = explicitDefault || host.recentDirectories[0]?.trim() || discoveredHome;
	if (fallbackExplicit) {
		return normalizeRemoteProjectPath(fallbackExplicit, host.os);
	}
	if (host.os === 'windows') {
		return '/C:';
	}
	if (host.os === 'macos') {
		return '/Users';
	}
	return '/';
}

export function formatLiveRemoteDirInput(
	dirPath: string,
	os: AdeCloudHostOs = 'linux',
	omitLeadingSlashOnWindows = false,
): string {
	if (os === 'windows') {
		if (!dirPath || dirPath === '/') {
			return '/';
		}
		const norm = normalizeRemoteProjectPath(dirPath, 'windows');
		if (norm === '/') {
			return '/';
		}
		const display = omitLeadingSlashOnWindows && norm.startsWith('/') ? norm.slice(1) : norm;
		return display.endsWith('/') ? display : `${display}/`;
	}
	const norm = normalizeRemoteProjectPath(dirPath, os);
	return norm === '/' ? '/' : `${norm}/`;
}

export function parseLiveRemotePathInput(
	rawInput: string,
	os: AdeCloudHostOs = 'linux',
	remoteHome?: string,
): IParsedLiveRemotePathInput {
	let s = (os === 'windows' ? rawInput.replace(/\\/g, '/') : rawInput).trimStart();
	if (s === '~' || s.startsWith('~/')) {
		const homeBase = remoteHome
			? normalizeRemoteProjectPath(remoteHome, os)
			: (os === 'windows' ? '/C:' : '/');
		s = s === '~'
			? (homeBase === '/' ? '/' : `${homeBase}/`)
			: `${homeBase === '/' ? '' : homeBase}/${s.slice(2)}`;
	}

	if (os === 'windows') {
		const omitLeadingSlashOnWindows = /^[A-Za-z]:/.test(s);
		if (!s || s === '/') {
			return {
				browseDir: '/',
				filterPrefix: '',
				targetPath: '/',
				parentDir: undefined,
				isWindowsDriveRoot: true,
				omitLeadingSlashOnWindows: false,
			};
		}
		const bareDriveMatch = /^\/?([A-Za-z]):?$/.exec(s);
		if (bareDriveMatch) {
			const letter = bareDriveMatch[1].toUpperCase();
			return {
				browseDir: '/',
				filterPrefix: bareDriveMatch[1],
				targetPath: `/${letter}:`,
				parentDir: undefined,
				isWindowsDriveRoot: true,
				omitLeadingSlashOnWindows,
			};
		}
		const withSlash = s.startsWith('/') ? s : `/${s}`;
		const collapsed = withSlash.replace(/\/+/g, '/');
		const endsWithSlash = collapsed.length > 1 && collapsed.endsWith('/');
		let browseDir: string;
		let filterPrefix: string;
		let targetPath: string;
		if (endsWithSlash) {
			browseDir = normalizeRemoteProjectPath(collapsed.slice(0, -1), 'windows');
			filterPrefix = '';
			targetPath = browseDir;
		} else {
			const lastSlash = collapsed.lastIndexOf('/');
			const dirPart = lastSlash <= 0 ? '/' : collapsed.slice(0, lastSlash);
			browseDir = dirPart === '/' ? '/' : normalizeRemoteProjectPath(dirPart, 'windows');
			filterPrefix = collapsed.slice(lastSlash + 1);
			targetPath = normalizeRemoteProjectPath(collapsed, 'windows');
		}
		let parentDir: string | undefined;
		if (browseDir === '/') {
			parentDir = undefined;
		} else if (/^\/[A-Za-z]:$/.test(browseDir)) {
			parentDir = '/';
		} else {
			const p = posix.dirname(browseDir);
			parentDir = p === browseDir ? '/' : p;
		}
		return {
			browseDir,
			filterPrefix,
			targetPath,
			parentDir,
			isWindowsDriveRoot: browseDir === '/',
			omitLeadingSlashOnWindows,
		};
	}

	if (!s || s === '/') {
		return {
			browseDir: '/',
			filterPrefix: '',
			targetPath: '/',
			parentDir: undefined,
			isWindowsDriveRoot: false,
			omitLeadingSlashOnWindows: false,
		};
	}

	const withSlash = s.startsWith('/') ? s : `/${s}`;
	const collapsed = withSlash.replace(/\/+/g, '/');
	const endsWithSlash = collapsed.length > 1 && collapsed.endsWith('/');
	let browseDir: string;
	let filterPrefix: string;
	let targetPath: string;
	if (endsWithSlash) {
		browseDir = normalizeRemoteProjectPath(collapsed.slice(0, -1), os);
		filterPrefix = '';
		targetPath = browseDir;
	} else {
		const lastSlash = collapsed.lastIndexOf('/');
		const dirPart = lastSlash <= 0 ? '/' : collapsed.slice(0, lastSlash);
		browseDir = dirPart === '/' ? '/' : normalizeRemoteProjectPath(dirPart, os);
		filterPrefix = collapsed.slice(lastSlash + 1);
		targetPath = normalizeRemoteProjectPath(collapsed, os);
	}
	const parentDir = browseDir === '/' ? undefined : posix.dirname(browseDir);
	return {
		browseDir,
		filterPrefix,
		targetPath,
		parentDir,
		isWindowsDriveRoot: false,
		omitLeadingSlashOnWindows: false,
	};
}

export function buildCloudProjectUri(hostAlias: string, remotePath: string, os: AdeCloudHostOs = 'linux'): URI {
	return URI.from({
		scheme: AEXUS_SSH_SCHEME,
		authority: sanitizeSshAlias(hostAlias),
		path: normalizeRemoteProjectPath(remotePath, os),
	});
}

export function isCloudProjectUri(uri: URI | undefined): boolean {
	return Boolean(uri && uri.scheme === AEXUS_SSH_SCHEME && uri.authority);
}

export function formatProjectDisplayPath(uri: URI): string {
	if (uri.scheme === Schemas.file) {
		return uri.fsPath;
	}
	if (uri.scheme === AEXUS_SSH_SCHEME) {
		return `${uri.authority}:${uri.path || '/'}`;
	}
	if (uri.authority) {
		return `${uri.scheme}://${uri.authority}${uri.path}`;
	}
	return uri.toString();
}

export function formatCloudHostTargetLabel(host: Pick<IAdeCloudHost, 'user' | 'hostName' | 'port'>): string {
	const userPrefix = host.user ? `${host.user}@` : '';
	const portSuffix = host.port && host.port !== 22 ? `:${host.port}` : '';
	return `${userPrefix}${host.hostName}${portSuffix}`;
}

export const IAdeCloudHostBackendService = createDecorator<IAdeCloudHostBackendService>('adeCloudHostBackendService');

export interface IAdeCloudHostBackendService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeHosts: Event<void>;

	listHosts(): Promise<readonly IAdeCloudHost[]>;
	getHost(idOrAlias: string): Promise<IAdeCloudHost | undefined>;
	upsertHost(input: IAdeCloudHostUpsertInput): Promise<IAdeCloudHost>;
	deleteHost(idOrAlias: string): Promise<boolean>;
	recordRecentDirectory(idOrAlias: string, remotePath: string): Promise<IAdeCloudHost | undefined>;
	importFromVsCodeAndSshConfig(): Promise<IAdeCloudHostImportResult>;
	testConnection(idOrAlias: string): Promise<IAdeCloudHostConnectionCheck>;
	getEffectiveSshConfigPath(): Promise<string>;

	remoteStat(authority: string, remotePath: string): Promise<IAdeRemoteFileStat>;
	remoteReadDir(authority: string, remotePath: string): Promise<readonly IAdeRemoteDirEntry[]>;
	remoteReadFile(authority: string, remotePath: string): Promise<VSBuffer>;
	remoteWriteFile(authority: string, remotePath: string, content: VSBuffer, options: { readonly create: boolean; readonly overwrite: boolean }): Promise<void>;
	remoteMkdir(authority: string, remotePath: string): Promise<void>;
	remoteDelete(authority: string, remotePath: string, recursive: boolean): Promise<void>;
	remoteRename(authority: string, fromPath: string, toPath: string, overwrite: boolean): Promise<void>;
	remoteCopy(authority: string, fromPath: string, toPath: string, overwrite: boolean): Promise<void>;
	remoteGitStatus(authority: string, projectPath: string): Promise<readonly IAdeRemoteScmStatusEntry[]>;
	remoteGitShowHead(authority: string, projectPath: string, relativePath: string): Promise<string>;
}
