/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installNativeRoleBridge } from './nativeRoleBridge';

installNativeRoleBridge({ distDir: __dirname, follower: true });
