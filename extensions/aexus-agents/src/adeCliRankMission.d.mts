/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export declare const RANK_SUBCOMMANDS: readonly ['list', 'names', 'get', 'docs', 'rename', 'set-count'];

export interface IRankMissionParsedInvocation {
	readonly help: boolean;
	readonly json: boolean;
	readonly windowId?: number;
	readonly action?: string;
	readonly fallbackAction?: string;
	readonly params?: Record<string, unknown>;
}

export declare function parseRankGroupCommand(
	tail: readonly string[],
	json: boolean,
	windowId: number | undefined,
	usageError: (message: string) => Error,
): IRankMissionParsedInvocation;

export declare function parseMissionDocsCommand(
	tail: readonly string[],
	json: boolean,
	windowId: number | undefined,
): IRankMissionParsedInvocation | undefined;
