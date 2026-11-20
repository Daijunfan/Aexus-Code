/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../base/common/path.js';
import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ADE_API_LATEST_REVISION } from '../common/adeApiRegistry.js';
import { buildAdeDocsPaths, IAdeDocsPaths } from '../common/adeDocsCatalog.js';
import {
	ADE_INBOX_FILE_NAME,
	IAdeApiDocReadResult,
	IAdeEngineeringBackendService,
	IAdeInboxItem,
	IAdeMissionWatchdogSnapshot,
	IAdeSourceTriggerFireEvent,
	IAdeWatchdogWakeupEvent,
} from '../common/adeEngineering.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, IAdeOrganizationConfig } from '../common/adeRoleSchema.js';
import { syncAdeApiDocsToDisk } from './adeDocsSync.js';
import { AdeMissionWatchdogService, IAdeRemoteWatchdogProbe } from './adeMissionWatchdogService.js';

export interface IAdeDocsBackendNodeServiceOptions {
	readonly baseDir?: string;
	readonly remoteProbe?: IAdeRemoteWatchdogProbe;
	readonly watchdogPollIntervalMs?: number;
}

/**
 * Node main-process backend for:
 * 1) Single-copy ADE API docs synchronization & lazy read (`<adeHome>/docs/`)
 * 2) ADE Inbox JSON persistence (`<adeHome>/inbox.json`)
 * 3) Local Mission Watchdog Daemon & zero-token Source Trigger Monitor
 */
export class AdeDocsBackendNodeService extends Disposable implements IAdeEngineeringBackendService {
	declare readonly _serviceBrand: undefined;

	private readonly baseDir: string;
	private readonly watchdog: AdeMissionWatchdogService;

	readonly onDidWatchdogWakeup: Event<IAdeWatchdogWakeupEvent>;
	readonly onDidSourceTriggerFire: Event<IAdeSourceTriggerFireEvent>;

	constructor(options?: IAdeDocsBackendNodeServiceOptions) {
		super();
		const envHome = process.env.AEXUS_ADE_HOME?.trim();
		this.baseDir = options?.baseDir || envHome || path.join(os.homedir(), '.aexus-code');
		this.watchdog = this._register(new AdeMissionWatchdogService({
			remoteProbe: options?.remoteProbe,
			pollIntervalMs: options?.watchdogPollIntervalMs,
		}));
		this.onDidWatchdogWakeup = this.watchdog.onDidWatchdogWakeup;
		this.onDidSourceTriggerFire = this.watchdog.onDidSourceTriggerFire;
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

	async readApiDoc(target: string, config?: IAdeOrganizationConfig): Promise<IAdeApiDocReadResult> {
		const normalized = (target || '').trim();
		const effectiveConfig = config ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const paths = buildAdeDocsPaths(this.baseDir, effectiveConfig.ranks.length);

		let filePath: string | undefined;
		let canonicalTarget = normalized;

		if (/^common$/i.test(normalized)) {
			filePath = paths.commonDoc;
			canonicalTarget = 'common';
		} else if (/^mission$/i.test(normalized)) {
			filePath = paths.missionDoc;
			canonicalTarget = 'mission';
		} else if (/^manifest$/i.test(normalized)) {
			filePath = paths.manifestFile;
			canonicalTarget = 'manifest';
		} else {
			const rankMatch = /^L(\d+)$/i.exec(normalized);
			if (rankMatch) {
				const tier = Number(rankMatch[1]);
				canonicalTarget = `L${tier}`;
				filePath = paths.rankDocs[canonicalTarget];
			}
		}

		if (!filePath) {
			return {
				ok: false,
				target: canonicalTarget || normalized,
				revision: ADE_API_LATEST_REVISION,
				error: `Unknown API doc target "${target}". Valid targets: common, mission, manifest, L0..L${effectiveConfig.ranks.length}.`,
			};
		}

		try {
			const content = await fs.promises.readFile(filePath, 'utf8');
			return {
				ok: true,
				target: canonicalTarget,
				path: filePath,
				revision: ADE_API_LATEST_REVISION,
				content,
			};
		} catch {
			// Single-copy store not yet materialized on disk: sync once lazily and retry.
			try {
				await syncAdeApiDocsToDisk(this.baseDir, effectiveConfig);
				const content = await fs.promises.readFile(filePath, 'utf8');
				return {
					ok: true,
					target: canonicalTarget,
					path: filePath,
					revision: ADE_API_LATEST_REVISION,
					content,
				};
			} catch (err) {
				return {
					ok: false,
					target: canonicalTarget,
					path: filePath,
					revision: ADE_API_LATEST_REVISION,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}
	}

	async syncMissionWatchdog(snapshot: IAdeMissionWatchdogSnapshot): Promise<void> {
		this.watchdog.syncMission(snapshot);
	}

	async removeMissionWatchdog(missionId: string): Promise<void> {
		this.watchdog.removeMission(missionId);
	}
}
