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

export function getCodingAgentPathCandidates(
	userHomePath: string,
	isMacintosh: boolean,
	isWindows: boolean,
	extraBinDirs?: readonly string[],
	nvmNodeVersions?: readonly string[],
): string[] {
	const pathImpl = isWindows ? win32 : posix;
	const candidates: string[] = [];
	if (extraBinDirs) {
		for (const dir of extraBinDirs) {
			if (dir && dir.trim()) {
				candidates.push(dir.trim());
			}
		}
	}
	if (isWindows) {
		candidates.push(
			pathImpl.join(userHomePath, '.npm-global', 'bin'),
			pathImpl.join(userHomePath, '.local', 'bin'),
			pathImpl.join(userHomePath, '.local', 'node-current'),
			pathImpl.join(userHomePath, '.gemini', 'bin'),
			pathImpl.join(userHomePath, '.opencode', 'bin'),
			pathImpl.join(userHomePath, '.bun', 'bin'),
			pathImpl.join(userHomePath, '.volta', 'bin'),
			pathImpl.join(userHomePath, '.cargo', 'bin'),
		);
		return candidates;
	}
	candidates.push(
		pathImpl.join(userHomePath, '.npm-global', 'bin'),
		pathImpl.join(userHomePath, '.local', 'bin'),
		pathImpl.join(userHomePath, '.local', 'node-current', 'bin'),
		pathImpl.join(userHomePath, '.gemini', 'bin'),
		pathImpl.join(userHomePath, '.opencode', 'bin'),
		pathImpl.join(userHomePath, '.bun', 'bin'),
		pathImpl.join(userHomePath, '.volta', 'bin'),
		pathImpl.join(userHomePath, '.asdf', 'shims'),
		pathImpl.join(userHomePath, '.cargo', 'bin'),
	);
	if (nvmNodeVersions && nvmNodeVersions.length > 0) {
		const sortedVersions = [...nvmNodeVersions]
			.map(v => v.trim())
			.filter(Boolean)
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
		for (const ver of sortedVersions) {
			candidates.push(pathImpl.join(userHomePath, '.nvm', 'versions', 'node', ver, 'bin'));
		}
	}
	candidates.push('/opt/homebrew/bin', '/usr/local/bin');
	if (isMacintosh) {
		candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin');
	}
	return candidates;
}

export function enrichCodingAgentPath(
	existingPath: string | undefined,
	userHomePath: string,
	isMacintosh: boolean,
	isWindows: boolean,
	prependBinDirs?: readonly string[],
	nvmNodeVersions?: readonly string[],
): string {
	const delimiter = isWindows ? ';' : ':';
	const candidates = getCodingAgentPathCandidates(userHomePath, isMacintosh, isWindows, undefined, nvmNodeVersions);
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

	if (prependBinDirs) {
		for (const dir of prependBinDirs) {
			addEntry(dir);
		}
	}
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

export function stripDirectoryFromPath(existingPath: string | undefined, targetDir: string, isWindows: boolean): string {
	if (!existingPath) {
		return '';
	}
	const delimiter = isWindows ? ';' : ':';
	const normTarget = (isWindows ? targetDir.toLowerCase() : targetDir).replace(/[\\/]+$/, '');
	return existingPath
		.split(delimiter)
		.filter(seg => {
			const cleaned = (isWindows ? seg.trim().toLowerCase() : seg.trim()).replace(/[\\/]+$/, '');
			return Boolean(cleaned) && cleaned !== normTarget;
		})
		.join(delimiter);
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
				for (const loopback of ['127.0.0.1', 'localhost', '::1']) {
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
