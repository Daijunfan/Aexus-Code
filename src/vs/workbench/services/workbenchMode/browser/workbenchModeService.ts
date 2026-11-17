/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchModeService, WorkbenchMode, WorkbenchModeContext } from '../common/workbenchMode.js';

export class WorkbenchModeService extends Disposable implements IWorkbenchModeService {
	declare readonly _serviceBrand: undefined;
	private readonly context: IContextKey<WorkbenchMode>;
	private readonly changeEmitter = this._register(new Emitter<WorkbenchMode>());
	readonly onDidChangeMode = this.changeEmitter.event;
	private currentMode: WorkbenchMode;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.currentMode = storageService.get('aexus.workbench.mode', StorageScope.WORKSPACE) === 'ade' ? 'ade' : 'ide';
		this.context = WorkbenchModeContext.bindTo(contextKeyService);
		this.context.set(this.currentMode);
	}

	get mode(): WorkbenchMode { return this.currentMode; }

	setMode(mode: WorkbenchMode): void {
		if (mode === this.currentMode) {
			return;
		}
		this.currentMode = mode;
		this.context.set(mode);
		this.storageService.store('aexus.workbench.mode', mode, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.changeEmitter.fire(mode);
	}
}

registerSingleton(IWorkbenchModeService, WorkbenchModeService, InstantiationType.Delayed);
