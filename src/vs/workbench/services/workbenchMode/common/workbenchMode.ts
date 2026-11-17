/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export type WorkbenchMode = 'ide' | 'ade';
export const WorkbenchModeContext = new RawContextKey<WorkbenchMode>('aexusWorkbenchMode', 'ide');
export const AdeEditorPartContext = new RawContextKey<boolean>('aexusAdeEditorPart', false);
export const WorkbenchModeViewContainers = {
	ide: 'workbench.view.explorer',
	ade: 'workbench.view.ade',
	adeInspector: 'workbench.view.adeInspector',
} as const;

export const IWorkbenchModeService = createDecorator<IWorkbenchModeService>('workbenchModeService');

export interface IWorkbenchModeService {
	readonly _serviceBrand: undefined;
	readonly mode: WorkbenchMode;
	readonly onDidChangeMode: Event<WorkbenchMode>;
	setMode(mode: WorkbenchMode): void;
}
