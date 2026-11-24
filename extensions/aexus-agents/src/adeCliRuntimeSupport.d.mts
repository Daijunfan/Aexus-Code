/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export declare const ADE_CONTROL_DIR_NAME: '.aexus-code';
export declare const ADE_CONTROL_META_NAME: 'ade-control.json';
export declare const ADE_CLI_VERSION: '1.1.0';
export declare const ADE_CLI_SCHEMA_VERSION: 1;
export declare const ADE_ENGINE_BASELINE: '1.146.0';

export interface IAdeControlConnectionMetadata {
	readonly socketPath: string;
	readonly token: string;
	readonly pid: number;
	readonly tcpPort?: number;
}

export interface IAdeControlWireRequest {
	readonly token: string;
	readonly action: string;
	readonly params?: Record<string, unknown>;
	readonly windowId?: number;
	readonly idempotencyKey?: string;
}

export interface IAdeControlWireResponse<T = unknown> {
	readonly ok: boolean;
	readonly result?: T;
	readonly error?: string;
	readonly idempotentReplay?: boolean;
}

export type CompletionShell = 'bash' | 'zsh' | 'fish' | 'powershell';
export type DoctorCheckStatus = 'ok' | 'warn' | 'fail' | 'error';

export interface IDoctorCheck {
	readonly id: string;
	readonly label: string;
	readonly status: DoctorCheckStatus;
	readonly detail: string;
}

export interface IDoctorEngineCheck {
	readonly id: string;
	readonly label: string;
	readonly binary: string;
	readonly installed: boolean;
	readonly path?: string;
	readonly installHint: string;
}

export interface IDoctorReport {
	readonly schemaVersion: number;
	readonly aexusVersion: string;
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly nodeVersion: string;
	readonly projectPath: string;
	readonly controlPlane: { readonly connected: boolean; readonly socketPath?: string; readonly error?: string };
	readonly tooling: {
		readonly git: { readonly installed: boolean; readonly version?: string; readonly worktreeReady: boolean };
		readonly ssh: { readonly installed: boolean; readonly version?: string };
	};
	readonly projectRules: readonly string[];
	readonly engines: readonly IDoctorEngineCheck[];
	readonly checks: readonly IDoctorCheck[];
	readonly summary: { readonly enginesReady: number; readonly enginesTotal: number };
}

export interface ICliColorizer {
	readonly bold: (text: string) => string;
	readonly dim: (text: string) => string;
	readonly red: (text: string) => string;
	readonly green: (text: string) => string;
	readonly yellow: (text: string) => string;
	readonly cyan: (text: string) => string;
}

export declare function isIdempotentReadRequest(action: string | undefined, params?: Record<string, unknown>): boolean;
export declare function normalizeExplicitSocketPath(raw: string | undefined): string | undefined;
export declare function readRemoteBridgeFileEndpoint(env: NodeJS.ProcessEnv): Promise<string | undefined>;
export declare function resolveConnection(env: NodeJS.ProcessEnv): Promise<{ socketPath: string; token: string; usingSessionToken: boolean }>;
export declare function sendSocketRequest(socketPath: string, payload: IAdeControlWireRequest): Promise<IAdeControlWireResponse>;
export declare function sendControlRequestWithRetry(
	env: NodeJS.ProcessEnv,
	initialSocketPath: string,
	payload: IAdeControlWireRequest,
	allowBridgeRetry: boolean,
): Promise<IAdeControlWireResponse>;
export declare function formatRawBlueprintOutput(result: unknown): string;
export declare function formatHumanOutput(action: string | undefined, result: unknown): string;
export declare function computeDoctorExitCode(report: Pick<IDoctorReport, 'checks'>, strict: boolean): number;
export declare function runDoctorDiagnostics(projectPath: string, env: NodeJS.ProcessEnv): Promise<IDoctorReport>;
export declare function shouldUseColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean;
export declare function createColorizer(enabled: boolean): ICliColorizer;
export declare function formatDoctorHuman(report: IDoctorReport, color: ICliColorizer): string;

export declare const TOP_LEVEL_COMMANDS: readonly string[];
export declare const ROLE_SUBCOMMANDS: readonly string[];
export declare const MISSION_SUBCOMMANDS: readonly string[];
export declare const ORCHESTRATION_SUBCOMMANDS: readonly string[];
export declare const WHITEBOARD_SUBCOMMANDS: readonly string[];
export declare const TOKEN_SUBCOMMANDS: readonly string[];
export declare const ORG_SUBCOMMANDS: readonly string[];
export declare const SESSION_SUBCOMMANDS: readonly string[];

export declare function buildCompletionScript(shell: CompletionShell): string;
export declare const HELP_TEXT: string;
