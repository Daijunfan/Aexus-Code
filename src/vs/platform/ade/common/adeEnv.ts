/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { posix, win32 } from '../../../base/common/path.js';

export interface IAdeHttpProxyConfiguration {
	readonly proxy?: unknown;
	readonly proxySupport?: unknown;
	readonly noProxy?: unknown;
	readonly systemCertificatesNode?: unknown;
}

export function getCodingAgentPathCandidates(userHomePath: string, isMacintosh: boolean, isWindows: boolean): string[] {
	const pathImpl = isWindows ? win32 : posix;
	const candidates = [
		pathImpl.join(userHomePath, '.npm-global', 'bin'),
		pathImpl.join(userHomePath, '.local', 'bin'),
		pathImpl.join(userHomePath, '.gemini', 'bin'),
		pathImpl.join(userHomePath, '.opencode', 'bin'),
	];
	if (!isWindows) {
		candidates.push('/opt/homebrew/bin', '/usr/local/bin');
	}
	if (isMacintosh) {
		candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin');
	}
	return candidates;
}

export function enrichCodingAgentPath(existingPath: string | undefined, userHomePath: string, isMacintosh: boolean, isWindows: boolean): string {
	const delimiter = isWindows ? ';' : ':';
	const candidates = getCodingAgentPathCandidates(userHomePath, isMacintosh, isWindows);
	const normalizeKey = (entry: string) => isWindows ? entry.toLowerCase() : entry;

	const seen = new Set<string>();
	const result: string[] = [];

	const addEntry = (rawEntry: string) => {
		const trimmed = rawEntry.trim();
		if (!trimmed) {
			return;
		}
		const key = normalizeKey(trimmed);
		if (!seen.has(key)) {
			seen.add(key);
			result.push(trimmed);
		}
	};

	if (existingPath) {
		for (const segment of existingPath.split(delimiter)) {
			addEntry(segment);
		}
	}
	for (const candidate of candidates) {
		addEntry(candidate);
	}

	return result.join(delimiter);
}

function parseNoProxyInput(value: unknown): string[] {
	if (typeof value === 'string') {
		return value.split(',').map(item => item.trim()).filter(Boolean);
	}
	if (Array.isArray(value)) {
		return value
			.filter((item): item is string => typeof item === 'string')
			.map(item => item.trim())
			.filter(Boolean);
	}
	return [];
}

export function applyHttpProxySettingsToEnv(env: Record<string, string | undefined>, httpConfig: IAdeHttpProxyConfiguration | undefined, isMacOrWin: boolean): void {
	const proxySupport = typeof httpConfig?.proxySupport === 'string' ? httpConfig.proxySupport.trim().toLowerCase() : undefined;

	if (proxySupport === 'off') {
		delete env.HTTP_PROXY;
		delete env.http_proxy;
		delete env.HTTPS_PROXY;
		delete env.https_proxy;
		delete env.ALL_PROXY;
		delete env.all_proxy;
		env.NO_PROXY = '*';
		env.no_proxy = '*';
	} else {
		const configuredProxy = typeof httpConfig?.proxy === 'string' && httpConfig.proxy.trim()
			? httpConfig.proxy.trim()
			: undefined;
		const existingProxy = [
			env.HTTPS_PROXY,
			env.https_proxy,
			env.HTTP_PROXY,
			env.http_proxy,
			env.ALL_PROXY,
			env.all_proxy,
		].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
		const effectiveProxy = configuredProxy ?? existingProxy;

		if (configuredProxy) {
			env.HTTP_PROXY = configuredProxy;
			env.http_proxy = configuredProxy;
			env.HTTPS_PROXY = configuredProxy;
			env.https_proxy = configuredProxy;
		} else if (existingProxy) {
			if (!env.HTTP_PROXY?.trim()) {
				env.HTTP_PROXY = existingProxy;
			}
			if (!env.http_proxy?.trim()) {
				env.http_proxy = existingProxy;
			}
			if (!env.HTTPS_PROXY?.trim()) {
				env.HTTPS_PROXY = existingProxy;
			}
			if (!env.https_proxy?.trim()) {
				env.https_proxy = existingProxy;
			}
		}

		const configNoProxy = parseNoProxyInput(httpConfig?.noProxy);
		if (effectiveProxy || configNoProxy.length > 0) {
			const existingNoProxy = [
				...parseNoProxyInput(env.NO_PROXY),
				...parseNoProxyInput(env.no_proxy),
			];
			const seen = new Set<string>();
			const merged: string[] = [];

			const addHost = (host: string) => {
				const lower = host.toLowerCase();
				if (!seen.has(lower)) {
					seen.add(lower);
					merged.push(host);
				}
			};

			for (const entry of existingNoProxy) {
				addHost(entry);
			}
			for (const entry of configNoProxy) {
				addHost(entry);
			}
			if (!seen.has('*')) {
				for (const loopback of ['localhost', '127.0.0.1', '::1']) {
					addHost(loopback);
				}
			}

			const joined = merged.join(',');
			env.NO_PROXY = joined;
			env.no_proxy = joined;
		}
	}

	if (isMacOrWin && httpConfig?.systemCertificatesNode !== false && !env.NODE_USE_SYSTEM_CA) {
		env.NODE_USE_SYSTEM_CA = '1';
	}
}
