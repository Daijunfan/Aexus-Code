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

export function resolveInitialCloudHostDirectory(host: Pick<IAdeCloudHost, 'os' | 'user' | 'defaultDirectory' | 'recentDirectories' | 'lastTestStatus'>): string {
	const explicit = host.defaultDirectory?.trim()
		|| host.recentDirectories[0]?.trim()
		|| host.lastTestStatus?.remoteHome?.trim();
	if (explicit) {
		return normalizeRemoteProjectPath(explicit, host.os);
	}
	if (host.os === 'windows') {
		return host.user ? normalizeRemoteProjectPath(`/C:/Users/${host.user}`, 'windows') : '/C:';
	}
	if (host.os === 'macos') {
		return host.user ? normalizeRemoteProjectPath(`/Users/${host.user}`, 'macos') : '/Users';
	}
	if (host.user === 'root') {
		return '/root';
	}
	return host.user ? normalizeRemoteProjectPath(`/home/${host.user}`, 'linux') : '/';
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
	let s = rawInput.replace(/\\/g, '/').trimStart();
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
