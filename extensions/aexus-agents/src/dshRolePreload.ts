/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import {
	AEXUS_AGENT_ID_ENV_KEY,
	injectLlmPayloadSystemPrompt,
	readRoleSyncSnapshot,
	resolveActiveEngineAgent,
	ROLE_STATE_ENV_KEY,
	type RoleSyncSnapshot,
} from './roleBridgeShared';

const PRELOAD_GUARD = Symbol.for('aexus.dshRolePreload.installed');

let cachedStatePath: string | undefined;
let cachedStatSignature = '';
let cachedSnapshot: RoleSyncSnapshot | undefined;

async function readCachedRoleSyncSnapshot(stateFilePath: string | undefined): Promise<RoleSyncSnapshot | undefined> {
	if (!stateFilePath) {
		return undefined;
	}
	try {
		const stat = await fs.stat(stateFilePath);
		const sig = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
		if (cachedStatePath === stateFilePath && sig === cachedStatSignature) {
			return cachedSnapshot;
		}
		const next = await readRoleSyncSnapshot(stateFilePath);
		cachedStatePath = stateFilePath;
		cachedStatSignature = sig;
		cachedSnapshot = next;
		return next;
	} catch {
		cachedStatePath = stateFilePath;
		cachedStatSignature = '';
		cachedSnapshot = undefined;
		return undefined;
	}
}

async function readRequestBodyText(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<string | undefined> {
	if (typeof init?.body === 'string') {
		return init.body;
	}
	if (init?.body instanceof Uint8Array || Buffer.isBuffer(init?.body)) {
		return Buffer.from(init.body).toString('utf8');
	}
	if (init?.body === undefined && typeof Request !== 'undefined' && input instanceof Request) {
		try {
			return await input.clone().text();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export function installDshRolePreload(): void {
	const g = globalThis as unknown as Record<symbol, unknown>;
	if (g[PRELOAD_GUARD] || typeof globalThis.fetch !== 'function') {
		return;
	}
	g[PRELOAD_GUARD] = true;

	const origFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const url = typeof input === 'string'
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
		const method = (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();

		if (method === 'POST' && /\/(?:chat\/completions|messages|responses|models\/[^/?#]+:(?:stream)?generateContent)(?:[?#]|$)/i.test(url)) {
			const snapshot = await readCachedRoleSyncSnapshot(process.env[ROLE_STATE_ENV_KEY]);
			const agent = resolveActiveEngineAgent(
				snapshot,
				'dsh',
				process.cwd(),
				process.env[AEXUS_AGENT_ID_ENV_KEY],
			);
			if (agent?.isOrchestrated && agent.rolePrompt) {
				const rawBody = await readRequestBodyText(input, init);
				if (rawBody && rawBody.trimStart().startsWith('{')) {
					try {
						const parsed = JSON.parse(rawBody) as Record<string, unknown>;
						if (injectLlmPayloadSystemPrompt(url, parsed, agent.rolePrompt)) {
							const nextBody = JSON.stringify(parsed);
							if (typeof Request !== 'undefined' && input instanceof Request && init?.body === undefined) {
								const nextHeaders = new Headers(input.headers);
								nextHeaders.delete('content-length');
								return origFetch(input.url, {
									method: input.method,
									headers: nextHeaders,
									body: nextBody,
									signal: init?.signal ?? input.signal,
								});
							}
							const nextHeaders = new Headers(init?.headers);
							nextHeaders.delete('content-length');
							return origFetch(input, { ...init, headers: nextHeaders, body: nextBody });
						}
					} catch {
						// Pass through unmodified if body is not valid JSON.
					}
				}
			}
		}

		return origFetch(input, init);
	};
}

installDshRolePreload();
