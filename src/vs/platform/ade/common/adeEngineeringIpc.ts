/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { IAdeDocsPaths } from './adeDocsCatalog.js';
import {
	IAdeApiDocReadResult,
	IAdeEngineeringBackendService,
	IAdeInboxItem,
	IAdeMissionWatchdogSnapshot,
	IAdeSourceTriggerFireEvent,
	IAdeWatchdogWakeupEvent,
} from './adeEngineering.js';
import type { IAdeOrganizationConfig } from './adeRoleSchema.js';

export class AdeEngineeringBackendChannel implements IServerChannel {
	constructor(private readonly service: IAdeEngineeringBackendService) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		switch (event) {
			case 'onDidWatchdogWakeup':
				return (this.service.onDidWatchdogWakeup ?? Event.None) as Event<T>;
			case 'onDidSourceTriggerFire':
				return (this.service.onDidSourceTriggerFire ?? Event.None) as Event<T>;
			default:
				throw new Error(`Event not found: ${event}`);
		}
	}

	call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'loadInbox':
				return this.service.loadInbox() as Promise<T>;
			case 'saveInbox':
				return this.service.saveInbox(arg as readonly IAdeInboxItem[]) as Promise<T>;
			case 'syncApiDocs':
				return (this.service.syncApiDocs
					? this.service.syncApiDocs(arg as IAdeOrganizationConfig)
					: Promise.resolve(undefined)) as Promise<T>;
			case 'getApiDocsPaths':
				return (this.service.getApiDocsPaths
					? this.service.getApiDocsPaths(typeof arg === 'number' ? arg : 4)
					: Promise.resolve(undefined)) as Promise<T>;
			case 'readApiDoc': {
				const params = (arg && typeof arg === 'object')
					? arg as { target?: string; config?: IAdeOrganizationConfig }
					: { target: String(arg ?? '') };
				return (this.service.readApiDoc
					? this.service.readApiDoc(params.target ?? '', params.config)
					: Promise.resolve({ ok: false, target: params.target ?? '', revision: 0, error: 'readApiDoc unavailable' })) as Promise<T>;
			}
			case 'syncMissionWatchdog':
				return (this.service.syncMissionWatchdog
					? this.service.syncMissionWatchdog(arg as IAdeMissionWatchdogSnapshot)
					: Promise.resolve()) as Promise<T>;
			case 'removeMissionWatchdog':
				return (this.service.removeMissionWatchdog
					? this.service.removeMissionWatchdog(String(arg ?? ''))
					: Promise.resolve()) as Promise<T>;
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}
}

export class AdeEngineeringBackendChannelClient implements IAdeEngineeringBackendService {
	declare readonly _serviceBrand: undefined;

	readonly onDidWatchdogWakeup: Event<IAdeWatchdogWakeupEvent>;
	readonly onDidSourceTriggerFire: Event<IAdeSourceTriggerFireEvent>;

	constructor(private readonly channel: IChannel) {
		this.onDidWatchdogWakeup = this.channel.listen<IAdeWatchdogWakeupEvent>('onDidWatchdogWakeup');
		this.onDidSourceTriggerFire = this.channel.listen<IAdeSourceTriggerFireEvent>('onDidSourceTriggerFire');
	}

	loadInbox(): Promise<IAdeInboxItem[]> {
		return this.channel.call('loadInbox');
	}

	saveInbox(items: readonly IAdeInboxItem[]): Promise<void> {
		return this.channel.call('saveInbox', items);
	}

	syncApiDocs(config: IAdeOrganizationConfig): Promise<IAdeDocsPaths> {
		return this.channel.call('syncApiDocs', config);
	}

	getApiDocsPaths(rankCount: number): Promise<IAdeDocsPaths> {
		return this.channel.call('getApiDocsPaths', rankCount);
	}

	readApiDoc(target: string, config?: IAdeOrganizationConfig): Promise<IAdeApiDocReadResult> {
		return this.channel.call('readApiDoc', { target, config });
	}

	syncMissionWatchdog(snapshot: IAdeMissionWatchdogSnapshot): Promise<void> {
		return this.channel.call('syncMissionWatchdog', snapshot);
	}

	removeMissionWatchdog(missionId: string): Promise<void> {
		return this.channel.call('removeMissionWatchdog', missionId);
	}
}
