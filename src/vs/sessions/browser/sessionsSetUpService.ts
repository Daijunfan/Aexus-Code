/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { createDecorator } from '../../platform/instantiation/common/instantiation.js';

export const ISessionsSetUpService = createDecorator<ISessionsSetUpService>('sessionsSetUpService');

export interface ISessionsSetUpService {
	readonly _serviceBrand: undefined;
	readonly initialSignInDialogShown: boolean;
	/**
	 * Resolves when the welcome/setup flow has completed (or immediately
	 * if it is not currently active). Use this to defer work until after
	 * the user has finished the initial sign-in or setup dialog.
	 */
	whenWelcomeDone(): Promise<void>;
}


export class SessionsSetUpService extends Disposable implements ISessionsSetUpService {
	declare readonly _serviceBrand: undefined;
	readonly initialSignInDialogShown = false;
	async whenWelcomeDone(): Promise<void> { }
}
