/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IRankMissionParsedInvocation } from './adeCliRankMission.mjs';

export declare function parseWhoamiCommand(
	tail: readonly string[],
	json: boolean,
	windowId: number | undefined,
	usageError: (message: string) => Error,
): IRankMissionParsedInvocation;

export declare function parseDocsCommand(
	tail: readonly string[],
	json: boolean,
	windowId: number | undefined,
	usageError: (message: string) => Error,
): IRankMissionParsedInvocation;

export declare function parseApiCommand(
	tail: readonly string[],
	json: boolean,
	windowId: number | undefined,
	usageError: (message: string) => Error,
): IRankMissionParsedInvocation;

export declare function parseTokenGroupCommand(
	tail: readonly string[],
	json: boolean,
	windowId: number | undefined,
	usageError: (message: string) => Error,
): IRankMissionParsedInvocation;

export declare function parseOrgCommandIfRuntime(
	tail: readonly string[],
	json: boolean,
	windowId: number | undefined,
	usageError: (message: string) => Error,
): IRankMissionParsedInvocation | undefined;

export declare function parseMissionRuntimeSubcommand(
	tail: readonly string[],
	json: boolean,
	windowId: number | undefined,
	usageError: (message: string) => Error,
): IRankMissionParsedInvocation | undefined;
