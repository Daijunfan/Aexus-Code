/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import {
	AdeWorkTreeType,
	IAdeEngineeringBackendService,
	IAdeInboxItem,
	IAdeSegmentWorktreeInfo,
	IAdeStoredEngineeringRecord,
	IAdeWorkerTurnChanges,
	IAdeWorkspaceSnapshot,
} from './adeEngineering.js';

export class AdeEngineeringBackendChannel implements IServerChannel<string> {
	constructor(private readonly service: IAdeEngineeringBackendService) { }

	listen<T>(_ctx: string, _event: string): Event<T> {
		return Event.None;
	}

	async call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'listStoredTrees':
				return await this.service.listStoredTrees(args[0] as AdeWorkTreeType | undefined) as unknown as T;
			case 'loadTree':
				return await this.service.loadTree(args[0] as string, args[1] as AdeWorkTreeType | undefined) as unknown as T;
			case 'saveTree':
				await this.service.saveTree(args[0] as IAdeStoredEngineeringRecord);
				return undefined as unknown as T;
			case 'deleteTree':
				await this.service.deleteTree(args[0] as string, args[1] as AdeWorkTreeType | undefined);
				return undefined as unknown as T;
			case 'loadInbox':
				return await this.service.loadInbox() as unknown as T;
			case 'saveInbox':
				await this.service.saveInbox(args[0] as readonly IAdeInboxItem[]);
				return undefined as unknown as T;
			case 'captureWorkspaceSnapshot':
				return await this.service.captureWorkspaceSnapshot(args[0] as string) as unknown as T;
			case 'computeWorkerTurnChanges':
				return await this.service.computeWorkerTurnChanges(
					args[0] as string,
					args[1] as IAdeWorkspaceSnapshot,
					args[2] as Readonly<Record<string, string | null>> | undefined,
				) as unknown as T;
			case 'ensureSegmentWorktree':
				return await this.service.ensureSegmentWorktree(
					args[0] as string,
					args[1] as string,
					args[2] as string,
					args[3] as readonly string[],
				) as unknown as T;
			case 'commitSegmentWorktree':
				return await this.service.commitSegmentWorktree(args[0] as string, args[1] as string) as unknown as T;
			case 'mergeSegmentsIntoProject':
				return await this.service.mergeSegmentsIntoProject(args[0] as string, args[1] as readonly string[]) as unknown as T;
			case 'cleanupTreeWorktrees':
				await this.service.cleanupTreeWorktrees(args[0] as string, args[1] as string);
				return undefined as unknown as T;
			default:
				throw new Error(`Unsupported AdeEngineeringBackendChannel command: ${command}`);
		}
	}
}

export class AdeEngineeringBackendChannelClient implements IAdeEngineeringBackendService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly channel: IChannel) { }

	listStoredTrees(treeType?: AdeWorkTreeType): Promise<readonly IAdeStoredEngineeringRecord[]> {
		return this.channel.call('listStoredTrees', [treeType]);
	}

	loadTree(governorSessionId: string, treeType?: AdeWorkTreeType): Promise<IAdeStoredEngineeringRecord | undefined> {
		return this.channel.call('loadTree', [governorSessionId, treeType]);
	}

	saveTree(record: IAdeStoredEngineeringRecord): Promise<void> {
		return this.channel.call('saveTree', [record]);
	}

	deleteTree(governorSessionId: string, treeType?: AdeWorkTreeType): Promise<void> {
		return this.channel.call('deleteTree', [governorSessionId, treeType]);
	}

	loadInbox(): Promise<readonly IAdeInboxItem[]> {
		return this.channel.call('loadInbox', []);
	}

	saveInbox(items: readonly IAdeInboxItem[]): Promise<void> {
		return this.channel.call('saveInbox', [items]);
	}

	captureWorkspaceSnapshot(cwd: string): Promise<IAdeWorkspaceSnapshot> {
		return this.channel.call('captureWorkspaceSnapshot', [cwd]);
	}

	computeWorkerTurnChanges(
		cwd: string,
		before: IAdeWorkspaceSnapshot,
		ignoreSiblingSha1s?: Readonly<Record<string, string | null>>,
	): Promise<IAdeWorkerTurnChanges> {
		return this.channel.call('computeWorkerTurnChanges', [cwd, before, ignoreSiblingSha1s]);
	}

	ensureSegmentWorktree(
		governorSessionId: string,
		projectPath: string,
		segmentId: string,
		upstreamBranches: readonly string[],
	): Promise<{
		readonly worktree: IAdeSegmentWorktreeInfo;
		readonly mergeConflict?: { readonly conflictedFiles: readonly string[]; readonly summary: string };
	}> {
		return this.channel.call('ensureSegmentWorktree', [governorSessionId, projectPath, segmentId, upstreamBranches]);
	}

	commitSegmentWorktree(worktreePath: string, message: string): Promise<string | undefined> {
		return this.channel.call('commitSegmentWorktree', [worktreePath, message]);
	}

	mergeSegmentsIntoProject(
		projectPath: string,
		branches: readonly string[],
	): Promise<{ readonly ok: boolean; readonly conflictedFiles: readonly string[]; readonly summary: string }> {
		return this.channel.call('mergeSegmentsIntoProject', [projectPath, branches]);
	}

	cleanupTreeWorktrees(governorSessionId: string, projectPath: string): Promise<void> {
		return this.channel.call('cleanupTreeWorktrees', [governorSessionId, projectPath]);
	}
}
