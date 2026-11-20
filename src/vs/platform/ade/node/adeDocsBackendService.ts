/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Disposable } from '../../../base/common/lifecycle.js';
import { buildAdeDocsPaths, IAdeDocsPaths } from '../common/adeDocsCatalog.js';
import {
	ADE_INBOX_FILE_NAME,
	IAdeEngineeringBackendService,
	IAdeInboxItem,
} from '../common/adeEngineering.js';
import type { IAdeOrganizationConfig } from '../common/adeRoleSchema.js';
import { syncAdeApiDocsToDisk } from './adeDocsSync.js';

export interface IAdeDocsBackendNodeServiceOptions {
	readonly baseDir?: string;
}

/**
 * Lightweight Node backend strictly for:
 * 1) Single-copy ADE API docs synchronization (`<adeHome>/docs/ranks/L0..LN.md` + `docs/mission/MISSION_API.md`)
 * 2) ADE Inbox JSON persistence (`<adeHome>/inbox.json`)
 *
 * Legacy Engineering runner/worktree/verify backend logic has been removed.
 */
export class AdeDocsBackendNodeService extends Disposable implements IAdeEngineeringBackendService {
	declare readonly _serviceBrand: undefined;

	private readonly baseDir: string;

	constructor(options?: IAdeDocsBackendNodeServiceOptions) {
		super();
		const envHome = process.env.AEXUS_ADE_HOME?.trim();
		this.baseDir = options?.baseDir || envHome || path.join(os.homedir(), '.aexus-code');
	}

	private get inboxPath(): string {
		return path.join(this.baseDir, ADE_INBOX_FILE_NAME);
	}

	async loadInbox(): Promise<IAdeInboxItem[]> {
		try {
			const raw = await fs.promises.readFile(this.inboxPath, 'utf8');
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed as IAdeInboxItem[] : [];
		} catch {
			return [];
		}
	}

	async saveInbox(items: readonly IAdeInboxItem[]): Promise<void> {
		await fs.promises.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
		const tmp = `${this.inboxPath}.tmp.${process.pid}.${Date.now()}`;
		await fs.promises.writeFile(tmp, JSON.stringify(items, null, 2), { encoding: 'utf8', mode: 0o600 });
		await fs.promises.rename(tmp, this.inboxPath);
	}

	async syncApiDocs(config: IAdeOrganizationConfig): Promise<IAdeDocsPaths> {
		return syncAdeApiDocsToDisk(this.baseDir, config);
	}

	async getApiDocsPaths(rankCount: number): Promise<IAdeDocsPaths> {
		return buildAdeDocsPaths(this.baseDir, rankCount);
	}
}
