/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

export const SHARED_PURE_SCOPE_KEY = '__shared_ide_pure__';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface AgentChildIdentity {
	readonly sessionId?: string;
	readonly projectId?: string;
	readonly agentId?: string;
	readonly pureWorker?: boolean;
	readonly agentToken?: string;
	readonly controlSocketPath?: string;
	readonly remoteBridgeFile?: string;
	readonly remoteControlEndpoint?: string;
	readonly remoteBinDir?: string;
}

const STRIPPED_ADE_ENV_KEYS: readonly string[] = [
	'ADE_AGENT_TOKEN',
	'ADE_CONTROL_SOCKET',
	'ADE_CONTROL_ENDPOINT',
	'ADE_CONTROL_BRIDGE_FILE',
	'ADE_REMOTE_CLI_BIN_DIR',
	'ADE_INVOKED_CMD',
	'ADE_CLI_CMD',
	'AEXUS_ADE_TOKEN',
	'AEXUS_ADE_SESSION_TOKEN',
	'AEXUS_ADE_SOCKET',
	'AEXUS_ADE_TCP_PORT',
	'AEXUS_ADE_CONTROL_FILE',
	'AEXUS_ADE_CALLER',
	'AEXUS_ADE_WINDOW_ID',
	'AEXUS_ADE_WINDOW_KEY',
	'AEXUS_ADE_AGENTS_DIST_DIR',
	'AEXUS_ADE_AGENT_AUTH_FILE',
	'AEXUS_ADE_REMOTE_BRIDGE_SOCKET',
	'AEXUS_ADE_REMOTE_BRIDGE_PORT',
	'AEXUS_ADE_REMOTE_BRIDGE_FILE',
];

export function isPureIdeSessionIdentity(identity?: AgentChildIdentity): boolean {
	if (!identity) {
		return true;
	}
	if (identity.pureWorker === true) {
		return true;
	}
	return !(identity.projectId && identity.agentId && identity.agentToken);
}

/**
 * Computes a strictly isolated daemon slot key per ADE Project employee (`ade:${projectId}:${agentId}`),
 * preventing persistent engine daemons (`codex app-server`, `kilo serve`, `opencode serve`, `acp`) from
 * sharing `ADE_AGENT_TOKEN` across different employees in the same workspace folder.
 * Standalone IDE sessions share `SHARED_PURE_SCOPE_KEY` with zero ADE credentials.
 */
export function computeAgentIdentityScopeKey(
	_sessionId: string,
	identity?: AgentChildIdentity,
	_cwd?: string,
): string {
	if (identity?.projectId && identity?.agentId && !identity.pureWorker) {
		return `ade:${identity.projectId}:${identity.agentId}`;
	}
	return SHARED_PURE_SCOPE_KEY;
}

export function stripAdeControlEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...baseEnv };
	for (const key of Object.keys(out)) {
		if (STRIPPED_ADE_ENV_KEYS.includes(key) || key.startsWith('AEXUS_ADE_') || key.startsWith('ADE_CONTROL_') || key === 'ADE_AGENT_TOKEN') {
			delete out[key];
		}
	}
	return out;
}

export function stripDirectoriesFromPath(rawPath: string | undefined, dirsToRemove: readonly string[]): string {
	if (!rawPath) {
		return '';
	}
	const isWin = process.platform === 'win32';
	const normRemove = new Set(
		dirsToRemove
			.filter(Boolean)
			.map(d => {
				const resolved = path.resolve(d).replace(/[\\/]+$/, '');
				return isWin ? resolved.toLowerCase() : resolved;
			}),
	);
	if (normRemove.size === 0) {
		return rawPath;
	}
	return rawPath
		.split(path.delimiter)
		.filter(seg => {
			const trimmed = seg.trim().replace(/^"+|"+$/g, '');
			if (!trimmed) {
				return false;
			}
			const resolved = path.resolve(trimmed).replace(/[\\/]+$/, '');
			const key = isWin ? resolved.toLowerCase() : resolved;
			return !normRemove.has(key);
		})
		.join(path.delimiter);
}

export function buildAgentChildEnv(params: {
	readonly identity?: AgentChildIdentity;
	readonly baseEnv?: NodeJS.ProcessEnv;
	readonly cliBinDirs?: readonly string[];
}): NodeJS.ProcessEnv {
	const cleaned = stripAdeControlEnv(params.baseEnv ?? process.env);
	const cliDirs = params.cliBinDirs ?? [];
	const canonicalPathKey = process.platform === 'win32' ? 'Path' : 'PATH';
	const existingPath = cleaned.PATH ?? cleaned.Path ?? '';
	delete cleaned.PATH;
	delete cleaned.Path;

	if (isPureIdeSessionIdentity(params.identity)) {
		const strippedPath = stripDirectoriesFromPath(existingPath, cliDirs);
		cleaned[canonicalPathKey] = strippedPath;
		if (process.platform !== 'win32') {
			cleaned.PATH = strippedPath;
		}
		return cleaned;
	}

	const id = params.identity!;
	const prepend = cliDirs.filter(Boolean).join(path.delimiter);
	const withCliPath = prepend
		? (existingPath ? `${prepend}${path.delimiter}${existingPath}` : prepend)
		: existingPath;
	cleaned[canonicalPathKey] = withCliPath;
	if (process.platform !== 'win32') {
		cleaned.PATH = withCliPath;
	}
	if (id.agentToken) {
		cleaned.ADE_AGENT_TOKEN = id.agentToken;
	}
	if (id.controlSocketPath) {
		cleaned.ADE_CONTROL_SOCKET = id.controlSocketPath;
	}
	if (id.remoteControlEndpoint) {
		cleaned.ADE_CONTROL_ENDPOINT = id.remoteControlEndpoint;
	}
	if (id.remoteBridgeFile) {
		cleaned.ADE_CONTROL_BRIDGE_FILE = id.remoteBridgeFile;
	}
	return cleaned;
}

export function isPathWithinOrEqual(candidatePath: string, rootDir: string): boolean {
	const isWin = process.platform === 'win32';
	const absCand = path.resolve(candidatePath);
	const absRoot = path.resolve(rootDir);
	const normCand = isWin ? absCand.toLowerCase() : absCand;
	const normRoot = isWin ? absRoot.toLowerCase() : absRoot;
	if (normCand === normRoot) {
		return true;
	}
	const prefix = normRoot.endsWith(path.sep) ? normRoot : `${normRoot}${path.sep}`;
	return normCand.startsWith(prefix);
}

export function resolveCodexSandboxMode(
	options?: { readonly sandboxMode?: string },
	explicitSandboxMode?: string,
	autonomous = true,
): CodexSandboxMode {
	const raw = (explicitSandboxMode ?? options?.sandboxMode ?? '').trim();
	if (raw === 'read-only' || raw === 'workspace-write' || raw === 'danger-full-access') {
		return raw;
	}
	return autonomous ? 'danger-full-access' : 'workspace-write';
}
