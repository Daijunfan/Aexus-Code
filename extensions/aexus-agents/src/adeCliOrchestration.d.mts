/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IRankMissionParsedInvocation } from './adeCliRankMission.mjs';

export declare function consumeSliceReadFlag(
	arg: string,
	args: readonly string[],
	ref: { i: number },
	params: Record<string, unknown>,
	usageError: (message: string) => Error,
): boolean;

export declare function parseCheckpointGroupCommand(
	args: readonly string[],
	json: boolean,
	windowId: number | undefined,
	usageError: (message: string) => Error,
	actionPrefix?: string,
): IRankMissionParsedInvocation;

export declare function parseOrchestrationGroupCommand(
	tail: readonly string[],
	json: boolean,
	windowId: number | undefined,
	usageError: (message: string) => Error,
): IRankMissionParsedInvocation;

export declare function parseWhiteboardGroupCommand(
	tail: readonly string[],
	json: boolean,
	windowId: number | undefined,
	usageError: (message: string) => Error,
): IRankMissionParsedInvocation;
