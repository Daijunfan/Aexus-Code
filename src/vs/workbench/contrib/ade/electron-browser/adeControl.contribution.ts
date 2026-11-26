/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../browser/adeControlHandler.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ADE_GET_WINDOW_ID_COMMAND_ID } from '../../../../platform/ade/common/adeControl.js';
import { ADE_CLOUD_HOST_BACKEND_CHANNEL_NAME, IAdeCloudHostBackendService } from '../../../../platform/ade/common/adeCloudHosts.js';
import { AdeCloudHostBackendChannelClient } from '../../../../platform/ade/common/adeCloudHostsIpc.js';
import { ADE_CONTROL_CENTER_CHANNEL_NAME, AdeControlCenterChannelClient, IAdeControlCenterService } from '../../../../platform/ade/common/adeControlCenterIpc.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

class NativeAdeControlCenterService extends AdeControlCenterChannelClient {
	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super(mainProcessService.getChannel(ADE_CONTROL_CENTER_CHANNEL_NAME));
	}
}

class NativeAdeCloudHostBackendService extends AdeCloudHostBackendChannelClient {
	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super(mainProcessService.getChannel(ADE_CLOUD_HOST_BACKEND_CHANNEL_NAME));
	}
}

registerSingleton(IAdeControlCenterService, NativeAdeControlCenterService, InstantiationType.Delayed);
registerSingleton(IAdeCloudHostBackendService, NativeAdeCloudHostBackendService, InstantiationType.Delayed);

const ADE_CONTROL_RENDERER_CONTRIBUTION_ID = 'workbench.contrib.adeControlRenderer';

export class AdeControlRendererContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@INativeHostService nativeHostService: INativeHostService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand(ADE_GET_WINDOW_ID_COMMAND_ID, () => nativeHostService.windowId));
	}
}

registerWorkbenchContribution2(ADE_CONTROL_RENDERER_CONTRIBUTION_ID, AdeControlRendererContribution, WorkbenchPhase.BlockRestore);
