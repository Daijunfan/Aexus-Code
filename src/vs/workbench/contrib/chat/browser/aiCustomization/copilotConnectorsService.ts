/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellationError } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { matchesFuzzy2 } from '../../../../../base/common/filters.js';
import { splitCustomizationSearchWords } from '../../common/aiCustomizationSearch.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { LRUCache } from '../../../../../base/common/map.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { CustomizationMarketplaceMediaType,ICustomizationMarketplaceEntry,ICustomizationMarketplaceProvider,ICustomizationMarketplaceSourcePage,ICustomizationMarketplaceSourceQuery } from '../../../../../platform/customizationMarketplace/common/customizationMarketplaceService.js';
import { CustomizationMarketplaceConfiguration,CustomizationMarketplaceSources } from '../../../../../platform/customizationMarketplace/common/customizationMarketplaceSources.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { AuthenticationSession } from '../../../../services/authentication/common/authentication.js';

const maxSearchQueryLength = 256;
const maxSearchWords = 16;
const fuzzyWindowSize = 128;

export class CopilotConnectorsError extends Error {
	constructor(message: string, readonly statusCode?: number) {
		super(message);
	}
}

export interface ICopilotConnectorMcpServer {
	readonly name: string;
	readonly type: string;
	readonly url?: URI;
}

export type CopilotConnectorConnectionStatus = 'unknown' | 'not_connected' | 'pending' | 'connected' | 'error';
export type CopilotConnectorConnectionStatusDetail = 'sign_in_required' | 'reconnect_required' | 'review_required' | 'retryable_error' | 'unavailable';

export interface ICopilotConnectorAuthor {
	readonly name?: string;
	readonly email?: string;
	readonly url?: URI;
}

export interface ICopilotConnector {
	readonly name: string;
	readonly displayName: string;
	readonly description: string;
	readonly icon?: URI;
	readonly documentation?: URI;
	readonly homepage?: URI;
	readonly version?: string;
	readonly author?: ICopilotConnectorAuthor;
	readonly repository?: URI;
	readonly license?: string;
	readonly tags: readonly string[];
	readonly keywords: readonly string[];
	readonly capabilities: readonly string[];
	readonly representativeQueries: readonly string[];
	readonly tier?: string;
	readonly releaseTag?: string;
	readonly isExportSupported?: boolean;
	readonly connectionStatus: CopilotConnectorConnectionStatus;
	readonly connectionStatusDetail?: CopilotConnectorConnectionStatusDetail;
	readonly connectionErrorMessage?: string;
	readonly protectedResourceMetadataUrl?: string;
	readonly scopes: readonly string[];
	readonly mcpServers: readonly ICopilotConnectorMcpServer[];
}

export interface IConnectedCopilotConnectorMcpServer {
	readonly id: string;
	readonly connector: ICopilotConnector;
	readonly serverName: string;
}

export interface ICopilotConnectorAccount {
	readonly providerId: string;
	readonly accountName: string;
	readonly enterprise: boolean;
}

interface ICopilotConnectorsSnapshot {
	readonly connectors: readonly ICopilotConnector[];
	readonly cacheToken: CancellationToken;
}

export const ICopilotConnectorsService = createDecorator<ICopilotConnectorsService>('copilotConnectorsService');

export interface ICopilotConnectorsService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly onDidChangeAccount: Event<void>;
	readonly onDidDisconnect: Event<string>;
	readonly account: ICopilotConnectorAccount | undefined;
	readonly connectors: readonly ICopilotConnector[];
	readonly connectionStateKnown: boolean;
	readonly connectedMcpServers: readonly IConnectedCopilotConnectorMcpServer[];
	readonly authorizationRequired: boolean;
	/** Signs in for catalog browsing without requesting connector permission. */
	signIn(token: CancellationToken): Promise<void>;
	/** Signs in if needed, then requests connector consent after an explicit user action. */
	/**
	 * Ensures the active account has a session that authorizes Copilot connectors while keeping its default
	 * scopes, requesting consent for that account when needed, and resolves to that session.
	 */
	authorize(token: CancellationToken): Promise<AuthenticationSession>;
	/**
	 * Reconciles live Agent Host sessions with the current Connector authorization. A named Connector also
	 * restarts its servers, so they use the session credential rebound by {@link authorize}.
	 */
	refreshAgentHostSessions(forceConnectorName?: string): Promise<void>;
	getConnectors(token: CancellationToken): Promise<readonly ICopilotConnector[]>;
	/** Reads the catalog and its source/account validity token atomically. */
	getConnectorsSnapshot(token: CancellationToken): Promise<ICopilotConnectorsSnapshot>;
	refresh(token: CancellationToken): Promise<readonly ICopilotConnector[]>;
	checkConnection(token: CancellationToken): Promise<void>;
	connect(name: string, token: CancellationToken): Promise<void>;
	disconnect(name: string, token: CancellationToken): Promise<void>;
}

export class CopilotConnectorsService extends Disposable implements ICopilotConnectorsService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChange = Event.None;
	readonly onDidChangeAccount = Event.None;
	readonly onDidDisconnect = Event.None;
	readonly account: ICopilotConnectorAccount | undefined = undefined;
	readonly connectors: readonly ICopilotConnector[] = [];
	readonly connectionStateKnown = true;
	readonly connectedMcpServers: readonly IConnectedCopilotConnectorMcpServer[] = [];
	readonly authorizationRequired = false;
	async signIn(_token: CancellationToken): Promise<void> { throw new Error('No connector provider is installed.'); }
	async authorize(_token: CancellationToken): Promise<AuthenticationSession> { throw new Error('No connector provider is installed.'); }
	async refreshAgentHostSessions(_name?: string): Promise<void> { }
	async getConnectors(_token: CancellationToken): Promise<readonly ICopilotConnector[]> { return []; }
	async getConnectorsSnapshot(_token: CancellationToken): Promise<ICopilotConnectorsSnapshot> { return { connectors: [], cacheToken: CancellationToken.None }; }
	async refresh(_token: CancellationToken): Promise<readonly ICopilotConnector[]> { return []; }
	async checkConnection(_token: CancellationToken): Promise<void> { }
	async connect(_name: string, _token: CancellationToken): Promise<void> { throw new Error('No connector provider is installed.'); }
	async disconnect(_name: string, _token: CancellationToken): Promise<void> { throw new Error('No connector provider is installed.'); }
}

interface IConnectorContinuation {
	readonly query: string;
	readonly mediaType?: CustomizationMarketplaceMediaType;
	readonly pageSize: number;
	readonly entries: readonly ICustomizationMarketplaceEntry[];
	readonly offset: number;
	readonly expiresAt: number;
	readonly cacheToken: CancellationToken;
}

export class CopilotConnectorsMarketplaceProvider implements ICustomizationMarketplaceProvider {
	readonly id = CustomizationMarketplaceSources.CopilotConnectors.id;
	private readonly continuations = new LRUCache<string, IConnectorContinuation>(32);

	constructor(
		private readonly service: ICopilotConnectorsService,
		private readonly configurationService: IConfigurationService,
	) { }

	async query(options: ICustomizationMarketplaceSourceQuery, token: CancellationToken): Promise<ICustomizationMarketplaceSourcePage> {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		if (this.configurationService.getValue<boolean>(CustomizationMarketplaceConfiguration.CopilotConnectorsEnabled) !== true ||
			(options.mediaType !== undefined && options.mediaType !== CustomizationMarketplaceMediaType.McpServer)) {
			if (options.cursor !== undefined) {
				throw invalidConnectorPage();
			}
			return { items: [], total: 0 };
		}
		const text = options.query?.trim() ?? '';
		const words = splitCustomizationSearchWords(text);
		const requestedPageSize = options.pageSize ?? 30;
		if (text.length > maxSearchQueryLength || words.length > maxSearchWords || !Number.isSafeInteger(requestedPageSize) || requestedPageSize <= 0) {
			throw new CopilotConnectorsError(localize('copilotConnectors.invalidQuery', "Use a positive page size and at most {0} characters and {1} words to search Copilot connectors.", maxSearchQueryLength, maxSearchWords));
		}
		const pageSize = Math.min(requestedPageSize, 100);
		for (const [key, value] of [...this.continuations]) {
			if (value.expiresAt <= Date.now() || value.cacheToken.isCancellationRequested) {
				this.continuations.delete(key);
			}
		}
		let continuation = options.cursor === undefined ? undefined : this.continuations.get(options.cursor);
		if (options.cursor !== undefined && (!continuation || continuation.query !== text || continuation.mediaType !== options.mediaType || continuation.pageSize !== pageSize)) {
			throw invalidConnectorPage();
		}
		if (!continuation) {
			const { connectors, cacheToken } = await raceCancellationError(this.service.getConnectorsSnapshot(token), token);
			if (this.service.authorizationRequired) {
				throw connectorSignInRequired();
			}
			const entries = words.length ? connectors.flatMap(connector => {
				const score = scoreConnector(connector, words);
				return score === undefined ? [] : [{ ...toCopilotConnectorMarketplaceEntry(connector), score }];
			}).sort((a, b) => b.score - a.score) : connectors.map(connector => toCopilotConnectorMarketplaceEntry(connector));
			continuation = { query: text, mediaType: options.mediaType, pageSize, entries, offset: 0, cacheToken, expiresAt: Date.now() + 30 * 60_000 };
		}
		if (continuation.cacheToken.isCancellationRequested) {
			throw invalidConnectorPage();
		}
		const page = continuation.entries.slice(continuation.offset, continuation.offset + pageSize);
		const offset = continuation.offset + page.length;
		const nextCursor = offset < continuation.entries.length ? generateUuid() : undefined;
		if (nextCursor) {
			this.continuations.set(nextCursor, { ...continuation, offset });
		}
		return {
			items: page,
			total: continuation.entries.length,
			nextCursor,
			cacheToken: continuation.cacheToken,
		};
	}
}

function invalidConnectorPage(): CopilotConnectorsError {
	return new CopilotConnectorsError(localize('copilotConnectors.invalidCursor', "The Copilot connectors page is invalid. Start a new search."));
}

function connectorSignInRequired(): CopilotConnectorsError {
	return new CopilotConnectorsError(localize('copilotConnectors.signInRequired', "Sign in to view connectors."));
}

/** Exact names score 100; otherwise average each word's best name (70-95), keyword (40-65), or descriptive (10-35) match. */
function scoreConnector(connector: ICopilotConnector, words: readonly string[]): number | undefined {
	const names = [connector.name, connector.displayName];
	if (names.some(name => splitCustomizationSearchWords(name).join(' ') === words.join(' '))) {
		return 100;
	}
	const fields = [
		{ values: names, weight: 70 },
		{ values: [...connector.keywords, ...connector.capabilities, ...connector.tags], weight: 40 },
		{ values: [connector.description, ...connector.representativeQueries], weight: 10 },
	];
	let total = 0;
	for (const word of words) {
		let best: number | undefined;
		for (const { values, weight } of fields) {
			for (const value of values) {
				const score = scoreConnectorField(word, value);
				if (score !== undefined) {
					best = Math.max(best ?? 0, weight + score);
				}
			}
			if (best !== undefined) {
				break;
			}
		}
		if (best === undefined) {
			return undefined;
		}
		total += best;
	}
	return Math.round(total / words.length);
}

function scoreConnectorField(word: string, value: string): number | undefined {
	const index = value.toLowerCase().indexOf(word);
	if (index >= 0) {
		return value.length === word.length ? 25 : index === 0 ? 20 : 15;
	}
	// The fuzzy helper truncates at 128 characters; longer words must match contiguously, never by a truncated prefix.
	if (word.length > fuzzyWindowSize) {
		return undefined;
	}
	let best: number | undefined;
	for (let start = 0; start < value.length; start += fuzzyWindowSize / 2) {
		const matches = matchesFuzzy2(word, value.slice(start, start + fuzzyWindowSize));
		if (matches?.length) {
			const span = matches[matches.length - 1].end - matches[0].start;
			best = Math.max(best ?? 0, Math.round(10 * word.length / span));
		}
	}
	return best;
}

export function toCopilotConnectorMarketplaceEntry(connector: ICopilotConnector): ICustomizationMarketplaceEntry {
	const publisherUrl = connector.homepage ?? connector.author?.url;
	return {
		identifier: connector.name,
		displayName: connector.displayName,
		description: connector.description,
		mediaType: CustomizationMarketplaceMediaType.McpServer,
		tags: connector.tags,
		capabilities: connector.capabilities,
		representativeQueries: connector.representativeQueries,
		connectorIds: [...new Set([connector.name, ...connector.mcpServers.map(server => server.name)])],
		url: connector.documentation,
		externalUrl: connector.documentation?.toString(true),
		icon: connector.icon,
		publisher: localize('copilotConnectors.publisher', "GitHub Copilot"),
		...(publisherUrl ? { publisherUrl } : {}),
		installation: { kind: 'copilotConnector', name: connector.name },
	};
}
