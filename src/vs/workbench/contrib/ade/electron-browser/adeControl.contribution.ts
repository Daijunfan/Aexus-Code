/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ADE_CONTROL_CHANNEL_NAME, ADE_CONTROL_EXECUTE_COMMAND_ID, IAdeControlDispatchRequest } from '../../../../platform/ade/common/adeControl.js';
import { ADE_CLOUD_HOST_BACKEND_CHANNEL_NAME, IAdeCloudHostBackendService } from '../../../../platform/ade/common/adeCloudHosts.js';
import { AdeCloudHostBackendChannelClient } from '../../../../platform/ade/common/adeCloudHostsIpc.js';
import { ADE_ENGINEERING_BACKEND_CHANNEL_NAME, IAdeEngineeringBackendService } from '../../../../platform/ade/common/adeEngineering.js';
import { AdeEngineeringBackendChannelClient } from '../../../../platform/ade/common/adeEngineeringIpc.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';

class NativeAdeEngineeringBackendService extends AdeEngineeringBackendChannelClient {
	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super(mainProcessService.getChannel(ADE_ENGINEERING_BACKEND_CHANNEL_NAME));
	}
}

class NativeAdeCloudHostBackendService extends AdeCloudHostBackendChannelClient {
	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super(mainProcessService.getChannel(ADE_CLOUD_HOST_BACKEND_CHANNEL_NAME));
	}
}

registerSingleton(IAdeEngineeringBackendService, NativeAdeEngineeringBackendService, InstantiationType.Delayed);
registerSingleton(IAdeCloudHostBackendService, NativeAdeCloudHostBackendService, InstantiationType.Delayed);

const ADE_CONTROL_RENDERER_CONTRIBUTION_ID = 'workbench.contrib.adeControlRenderer';

export class AdeControlRendererContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@ICommandService private readonly commandService: ICommandService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super();

		if (environmentService.isSessionsWindow) {
			return;
		}

		const channel: IServerChannel<string> = {
			call: async <T>(_ctx: string, command: string, arg?: unknown): Promise<T> => {
				if (command !== 'execute') {
					throw new Error(`Unsupported ADE control command: ${command}`);
				}

				const request = arg as IAdeControlDispatchRequest | undefined;
				if (!request || typeof request.action !== 'string' || request.action.trim().length === 0) {
					throw new Error('Invalid ADE control dispatch request');
				}

				await this.lifecycleService.when(LifecyclePhase.Restored);
				const result = await this.commandService.executeCommand<T>(ADE_CONTROL_EXECUTE_COMMAND_ID, request.action, request.params ?? {});
				return result as T;
			},
			listen: <T>(): Event<T> => Event.None,
		};

		mainProcessService.registerChannel(ADE_CONTROL_CHANNEL_NAME, channel);
	}
}

registerWorkbenchContribution2(ADE_CONTROL_RENDERER_CONTRIBUTION_ID, AdeControlRendererContribution, WorkbenchPhase.BlockRestore);
