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
		return os === 'windows' ? '/C:/' : '/';
	}
	if (os === 'windows') {
		trimmed = trimmed.replace(/\\/g, '/');
		if (/^[A-Za-z]:$/.test(trimmed)) {
			trimmed = `/${trimmed}/`;
		} else if (/^[A-Za-z]:\//.test(trimmed)) {
			trimmed = `/${trimmed}`;
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
		const m = /^\/([A-Za-z]:(?:\/.*)?)$/.exec(clean);
		if (m) {
			const winForward = m[1].length === 2 ? `${m[1]}/` : m[1];
			return winForward.replace(/\//g, '\\');
		}
	}
	return clean;
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
