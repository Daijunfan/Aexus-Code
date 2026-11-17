/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	injectLlmPayloadSystemPrompt,
	readRoleSyncSnapshot,
	resolveActiveEngineAgent,
	ROLE_STATE_ENV_KEY,
} from './roleBridgeShared';

const PRELOAD_GUARD = Symbol.for('aexus.dshRolePreload.installed');

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

		if (method === 'POST') {
			const snapshot = await readRoleSyncSnapshot(process.env[ROLE_STATE_ENV_KEY]);
			const agent = resolveActiveEngineAgent(snapshot, 'dsh');
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
