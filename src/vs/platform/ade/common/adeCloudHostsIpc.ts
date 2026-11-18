/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import {
	IAdeCloudHost,
	IAdeCloudHostBackendService,
	IAdeCloudHostConnectionCheck,
	IAdeCloudHostImportResult,
	IAdeCloudHostUpsertInput,
	IAdeRemoteDirEntry,
	IAdeRemoteFileStat,
	IAdeRemoteScmStatusEntry,
} from './adeCloudHosts.js';

export class AdeCloudHostBackendChannel implements IServerChannel<string> {
	constructor(private readonly service: IAdeCloudHostBackendService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		if (event === 'onDidChangeHosts') {
			return this.service.onDidChangeHosts as unknown as Event<T>;
		}
		return Event.None;
	}

	async call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'listHosts':
				return await this.service.listHosts() as unknown as T;
			case 'getHost':
				return await this.service.getHost(args[0] as string) as unknown as T;
			case 'upsertHost':
				return await this.service.upsertHost(args[0] as IAdeCloudHostUpsertInput) as unknown as T;
			case 'deleteHost':
				return await this.service.deleteHost(args[0] as string) as unknown as T;
			case 'recordRecentDirectory':
				return await this.service.recordRecentDirectory(args[0] as string, args[1] as string) as unknown as T;
			case 'importFromVsCodeAndSshConfig':
				return await this.service.importFromVsCodeAndSshConfig() as unknown as T;
			case 'testConnection':
				return await this.service.testConnection(args[0] as string) as unknown as T;
			case 'getEffectiveSshConfigPath':
				return await this.service.getEffectiveSshConfigPath() as unknown as T;
			case 'remoteStat':
				return await this.service.remoteStat(args[0] as string, args[1] as string) as unknown as T;
			case 'remoteReadDir':
				return await this.service.remoteReadDir(args[0] as string, args[1] as string) as unknown as T;
			case 'remoteReadFile':
				return await this.service.remoteReadFile(args[0] as string, args[1] as string) as unknown as T;
			case 'remoteWriteFile': {
				const rawBuf = args[2];
				const buf = rawBuf instanceof VSBuffer
					? rawBuf
					: (rawBuf instanceof Uint8Array
						? VSBuffer.wrap(rawBuf)
						: VSBuffer.fromString(typeof rawBuf === 'string' ? rawBuf : ''));
				await this.service.remoteWriteFile(
					args[0] as string,
					args[1] as string,
					buf,
					(args[3] as { create: boolean; overwrite: boolean }) ?? { create: true, overwrite: true },
				);
				return undefined as unknown as T;
			}
			case 'remoteMkdir':
				await this.service.remoteMkdir(args[0] as string, args[1] as string);
				return undefined as unknown as T;
			case 'remoteDelete':
				await this.service.remoteDelete(args[0] as string, args[1] as string, Boolean(args[2]));
				return undefined as unknown as T;
			case 'remoteRename':
				await this.service.remoteRename(args[0] as string, args[1] as string, args[2] as string, Boolean(args[3]));
				return undefined as unknown as T;
			case 'remoteCopy':
				await this.service.remoteCopy(args[0] as string, args[1] as string, args[2] as string, Boolean(args[3]));
				return undefined as unknown as T;
			case 'remoteGitStatus':
				return await this.service.remoteGitStatus(args[0] as string, args[1] as string) as unknown as T;
			case 'remoteGitShowHead':
				return await this.service.remoteGitShowHead(args[0] as string, args[1] as string, args[2] as string) as unknown as T;
			default:
				throw new Error(`Unsupported AdeCloudHostBackendChannel command: ${command}`);
		}
	}
}

export class AdeCloudHostBackendChannelClient implements IAdeCloudHostBackendService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeHosts: Event<void>;

	constructor(private readonly channel: IChannel) {
		this.onDidChangeHosts = this.channel.listen<void>('onDidChangeHosts');
	}

	listHosts(): Promise<readonly IAdeCloudHost[]> {
		return this.channel.call('listHosts', []);
	}

	getHost(idOrAlias: string): Promise<IAdeCloudHost | undefined> {
		return this.channel.call('getHost', [idOrAlias]);
	}

	upsertHost(input: IAdeCloudHostUpsertInput): Promise<IAdeCloudHost> {
		return this.channel.call('upsertHost', [input]);
	}

	deleteHost(idOrAlias: string): Promise<boolean> {
		return this.channel.call('deleteHost', [idOrAlias]);
	}

	recordRecentDirectory(idOrAlias: string, remotePath: string): Promise<IAdeCloudHost | undefined> {
		return this.channel.call('recordRecentDirectory', [idOrAlias, remotePath]);
	}

	importFromVsCodeAndSshConfig(): Promise<IAdeCloudHostImportResult> {
		return this.channel.call('importFromVsCodeAndSshConfig', []);
	}

	testConnection(idOrAlias: string): Promise<IAdeCloudHostConnectionCheck> {
		return this.channel.call('testConnection', [idOrAlias]);
	}

	getEffectiveSshConfigPath(): Promise<string> {
		return this.channel.call('getEffectiveSshConfigPath', []);
	}

	remoteStat(authority: string, remotePath: string): Promise<IAdeRemoteFileStat> {
		return this.channel.call('remoteStat', [authority, remotePath]);
	}

	remoteReadDir(authority: string, remotePath: string): Promise<readonly IAdeRemoteDirEntry[]> {
		return this.channel.call('remoteReadDir', [authority, remotePath]);
	}

	async remoteReadFile(authority: string, remotePath: string): Promise<VSBuffer> {
		const res = await this.channel.call<VSBuffer | Uint8Array>('remoteReadFile', [authority, remotePath]);
		if (res instanceof VSBuffer) {
			return res;
		}
		return VSBuffer.wrap(res);
	}

	remoteWriteFile(authority: string, remotePath: string, content: VSBuffer, options: { readonly create: boolean; readonly overwrite: boolean }): Promise<void> {
		return this.channel.call('remoteWriteFile', [authority, remotePath, content, options]);
	}

	remoteMkdir(authority: string, remotePath: string): Promise<void> {
		return this.channel.call('remoteMkdir', [authority, remotePath]);
	}

	remoteDelete(authority: string, remotePath: string, recursive: boolean): Promise<void> {
		return this.channel.call('remoteDelete', [authority, remotePath, recursive]);
	}

	remoteRename(authority: string, fromPath: string, toPath: string, overwrite: boolean): Promise<void> {
		return this.channel.call('remoteRename', [authority, fromPath, toPath, overwrite]);
	}

	remoteCopy(authority: string, fromPath: string, toPath: string, overwrite: boolean): Promise<void> {
		return this.channel.call('remoteCopy', [authority, fromPath, toPath, overwrite]);
	}

	remoteGitStatus(authority: string, projectPath: string): Promise<readonly IAdeRemoteScmStatusEntry[]> {
		return this.channel.call('remoteGitStatus', [authority, projectPath]);
	}

	remoteGitShowHead(authority: string, projectPath: string, relativePath: string): Promise<string> {
		return this.channel.call('remoteGitShowHead', [authority, projectPath, relativePath]);
	}
}
