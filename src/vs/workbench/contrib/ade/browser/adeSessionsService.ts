/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AEXUS_SSH_SCHEME } from '../../../../platform/ade/common/adeCloudHosts.js';
import { ADE_REGISTERED_ENGINES } from '../../../../platform/ade/common/adeModels.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IChatSessionItem, IChatSessionsService } from '../../chat/common/chatSessionsService.js';
import { IAdeSession, normalizeAdeShortEngineId } from '../common/ade.js';

export interface IAdeEngine {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly icon?: URI | ThemeIcon;
	readonly remoteHost?: string;
	readonly remoteOs?: string;
}

export interface IAdeEngineAvailability extends IAdeEngine {
	readonly available: boolean;
}

export interface IAdeEngineProbeResult {
	readonly engines: readonly IAdeEngine[];
	readonly allEngines?: readonly IAdeEngineAvailability[];
	readonly remoteHost?: string;
	readonly remoteOs?: string;
	readonly error?: string;
}

export interface IAdeEngineSession extends IAdeSession {
	readonly projectUri: URI;
	readonly label: string;
	readonly updated?: number;
	readonly parentResource?: URI;
}

export const IAdeSessionsService = createDecorator<IAdeSessionsService>('adeSessionsService');

export interface IAdeSessionsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeEngines: Event<void>;
	getIcon(engineId: string): URI | ThemeIcon | undefined;
	getEngineName(engineId: string): string;
	getEngines(projectUri?: URI, options?: { readonly forceRefresh?: boolean }): Promise<readonly IAdeEngine[]>;
	probeEnginesForProject?(projectUri?: URI, options?: { readonly forceRefresh?: boolean }): Promise<IAdeEngineProbeResult>;
	create(engineId: string, projectUri: URI): Promise<IAdeEngineSession>;
	attach?(engineId: string, nativeId: string, projectUri?: URI): Promise<IAdeEngineSession>;
	list(engineId: string, projectUri?: URI): Promise<readonly IAdeEngineSession[]>;
	rename(session: IAdeSession, label: string): Promise<void>;
	delete(session: IAdeSession): Promise<void>;
	stop?(session: IAdeSession, options?: { readonly hostAlias?: string }): Promise<void>;
	deleteProjectSessions?(projectUri: URI): Promise<number>;
	getSessionInfo?(session: IAdeSession): Promise<{ nativeId?: string; provisional?: boolean; unmaterialized?: boolean; engine?: string } | undefined>;
}

interface IBuiltinEngine {
	id: string;
	name: string;
	available: boolean;
	remoteHost?: string;
	remoteOs?: string;
	error?: string;
}

function isSupportedContributionType(type: string): boolean {
	if (type === 'local' || type === 'openai-codex') {
		return false;
	}
	if (type.startsWith('aexus-')) {
		const shortId = normalizeAdeShortEngineId(type);
		return (ADE_REGISTERED_ENGINES as readonly string[]).includes(shortId);
	}
	return true;
}

/** Adapts engine-owned sessions to the ADE catalog without owning transcripts or engine configuration. */
export class AdeSessionsService implements IAdeSessionsService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IChatSessionsService private readonly sessions: IChatSessionsService,
		@ICommandService private readonly commands: ICommandService,
		@IExtensionService private readonly extensions: IExtensionService,
		@IUriIdentityService private readonly identity: IUriIdentityService,
		@IThemeService private readonly themeService: IThemeService,
	) { }

	get onDidChangeEngines(): Event<void> {
		return Event.any(
			this.sessions.onDidChangeAvailability,
			Event.map(this.sessions.onDidChangeItemsProviders, () => { }),
			Event.map(this.extensions.onDidChangeExtensions, () => { }),
		);
	}

	private normalizeEngineId(engineId: string): string {
		const trimmed = engineId.trim();
		const shortId = normalizeAdeShortEngineId(trimmed);
		if ((ADE_REGISTERED_ENGINES as readonly string[]).includes(shortId)) {
			return `aexus-${shortId}`;
		}
		return trimmed;
	}

	getIcon(engineId: string): URI | ThemeIcon | undefined {
		const resolvedId = this.normalizeEngineId(engineId);
		const contribution = this.sessions.getChatSessionContribution(resolvedId) ?? this.sessions.getChatSessionContribution(engineId);
		if (contribution?.icon) {
			return contribution.icon;
		}
		type ContributedSessionEntry = {
			readonly type: string;
			readonly icon?: string | { readonly light?: string; readonly dark?: string };
		};
		for (const extension of this.extensions.extensions) {
			const contributes = extension.contributes as { chatSessions?: readonly ContributedSessionEntry[] } | undefined;
			const matched = contributes?.chatSessions?.find(session => session.type === resolvedId || session.type === engineId);
			if (!matched) {
				continue;
			}
			if (typeof matched.icon === 'string' && matched.icon.trim()) {
				const raw = matched.icon.trim();
				if (raw.startsWith('$(') && raw.endsWith(')')) {
					return ThemeIcon.fromString(raw) ?? ThemeIcon.fromId(raw.slice(2, -1));
				}
				return joinPath(extension.extensionLocation, raw);
			}
			if (matched.icon && typeof matched.icon === 'object') {
				const useDark = this.themeService ? isDark(this.themeService.getColorTheme().type) : true;
				const relPath = useDark ? (matched.icon.dark || matched.icon.light) : (matched.icon.light || matched.icon.dark);
				if (relPath) {
					return joinPath(extension.extensionLocation, relPath);
				}
			}
			return extension.icon ? joinPath(extension.extensionLocation, extension.icon) : undefined;
		}
		return undefined;
	}

	getEngineName(engineId: string): string {
		const resolvedId = this.normalizeEngineId(engineId);
		return this.sessions.getChatSessionContribution(resolvedId)?.displayName
			?? this.sessions.getChatSessionContribution(engineId)?.displayName
			?? engineId;
	}

	async probeEnginesForProject(projectUri?: URI, options?: { readonly forceRefresh?: boolean }): Promise<IAdeEngineProbeResult> {
		await this.extensions.whenInstalledExtensionsRegistered();
		const isCloud = projectUri?.scheme === AEXUS_SSH_SCHEME;
		const builtin = await this.commands.executeCommand<IBuiltinEngine[]>(
			'aexus.agentEngines.list',
			isCloud ? projectUri : undefined,
			options,
		);
		const byId = new Map((builtin ?? []).map(engine => [engine.id, engine]));
		const firstCloudMeta = isCloud ? (builtin ?? []).find(e => e.remoteHost || e.error) : undefined;
		const remoteHost = isCloud ? (firstCloudMeta?.remoteHost ?? projectUri?.authority) : undefined;
		const remoteOs = isCloud ? firstCloudMeta?.remoteOs : undefined;
		const error = isCloud ? firstCloudMeta?.error : undefined;

		const allContributions = this.sessions.getAllChatSessionContributions()
			.filter(contribution => isSupportedContributionType(contribution.type) && !contribution.isReadOnly);

		const engines = allContributions
			.filter(contribution => {
				const builtinEntry = byId.get(contribution.type);
				if (isCloud) {
					return Boolean(builtinEntry?.available);
				}
				return (!contribution.hideFromSessionTypePicker || byId.has(contribution.type))
					&& (!byId.has(contribution.type) || Boolean(builtinEntry?.available));
			})
			.map(contribution => ({
				id: contribution.type,
				name: contribution.displayName,
				description: isCloud && remoteHost
					? localize('adeCloudEngineDesc', "Native on {0}{1}", remoteHost, remoteOs ? ` (${remoteOs})` : '')
					: contribution.description,
				icon: this.getIcon(contribution.type),
				...(remoteHost ? { remoteHost } : {}),
				...(remoteOs ? { remoteOs } : {}),
			}));

		const allEngines: IAdeEngineAvailability[] = [];
		const seenAll = new Set<string>();
		for (const entry of builtin ?? []) {
			if (!entry?.id || seenAll.has(entry.id) || !isSupportedContributionType(entry.id)) {
				continue;
			}
			seenAll.add(entry.id);
			const contribution = allContributions.find(c => c.type === entry.id);
			allEngines.push({
				id: entry.id,
				name: contribution?.displayName ?? entry.name,
				description: isCloud && remoteHost
					? localize('adeCloudEngineDesc', "Native on {0}{1}", remoteHost, remoteOs ? ` (${remoteOs})` : '')
					: (contribution?.description ?? entry.name),
				icon: this.getIcon(entry.id),
				available: Boolean(entry.available && !error),
				...(remoteHost ? { remoteHost } : {}),
				...(remoteOs ? { remoteOs } : {}),
			});
		}
		for (const engine of engines) {
			if (!seenAll.has(engine.id)) {
				seenAll.add(engine.id);
				allEngines.push({ ...engine, available: true });
			}
		}

		return { engines, allEngines, remoteHost, remoteOs, error };
	}

	async getEngines(projectUri?: URI, options?: { readonly forceRefresh?: boolean }): Promise<readonly IAdeEngine[]> {
		const res = await this.probeEnginesForProject(projectUri, options);
		return res.engines;
	}

	private binding(engineId: string, item: IChatSessionItem): IAdeEngineSession | undefined {
		const rawCloudUri = typeof item.metadata?.aexusProjectUri === 'string' ? item.metadata.aexusProjectUri : undefined;
		if (rawCloudUri) {
			return { engineId, resource: item.resource, projectUri: URI.parse(rawCloudUri), label: item.label, updated: item.timing.lastRequestEnded ?? item.timing.created };
		}
		const cwd = item.metadata?.workingDirectoryPath ?? item.metadata?.repositoryPath;
		return cwd ? { engineId, resource: item.resource, projectUri: URI.file(cwd), label: item.label, updated: item.timing.lastRequestEnded ?? item.timing.created } : undefined;
	}

	async create(engineId: string, projectUri: URI): Promise<IAdeEngineSession> {
		const resolvedEngine = this.normalizeEngineId(engineId);
		if (resolvedEngine.startsWith('aexus-')) {
			if (projectUri.scheme !== Schemas.file && projectUri.scheme !== AEXUS_SSH_SCHEME) {
				throw new Error(localize('nativeEngineNeedsLocalProject', "This engine runs on this computer or an Aexus SSH Cloud Host. Select a local or Cloud Host project folder."));
			}
			const created = await this.commands.executeCommand<IAdeEngineSession>('aexus.agentEngines.create', resolvedEngine, projectUri);
			if (!created) {
				throw new Error(localize('engineSessionNotCreated', "The engine did not create a conversation."));
			}
			return { ...created, resource: URI.revive(created.resource), parentResource: URI.revive(created.parentResource), projectUri: URI.revive(created.projectUri) };
		}
		await this.sessions.activateChatSessionItemProvider(resolvedEngine);
		const item = await this.sessions.createNewChatSessionItem(resolvedEngine, { prompt: '' }, CancellationToken.None);
		const result = item && this.binding(resolvedEngine, item);
		if (!result || !this.identity.extUri.isEqual(result.projectUri, projectUri)) {
			throw new Error(localize('engineProjectNotReported', "This engine did not create a session in the selected project. Create it in the engine first, then choose Open Existing Session."));
		}
		return result;
	}

	async attach(engineId: string, nativeId: string, projectUri?: URI): Promise<IAdeEngineSession> {
		const resolvedEngine = this.normalizeEngineId(engineId);
		if (resolvedEngine.startsWith('aexus-')) {
			const attached = await this.commands.executeCommand<IAdeEngineSession>('aexus.agentEngines.attach', resolvedEngine, nativeId, projectUri);
			if (!attached) {
				throw new Error(localize('engineSessionNotAttached', "Could not attach conversation {0}.", nativeId));
			}
			return { ...attached, resource: URI.revive(attached.resource), parentResource: URI.revive(attached.parentResource), projectUri: URI.revive(attached.projectUri) };
		}
		const items = await this.list(resolvedEngine, projectUri);
		const found = items.find(item => item.resource.path.endsWith(`/${nativeId}`) || item.resource.toString().includes(nativeId));
		if (!found) {
			throw new Error(localize('engineSessionNotAttached', "Could not attach conversation {0}.", nativeId));
		}
		return found;
	}

	async list(engineId: string, projectUri?: URI): Promise<readonly IAdeEngineSession[]> {
		const resolvedEngine = this.normalizeEngineId(engineId);
		if (resolvedEngine.startsWith('aexus-')) {
			const result = await this.commands.executeCommand<IAdeEngineSession[]>('aexus.agentEngines.sessions', resolvedEngine, projectUri);
			return (result ?? []).map(session => ({ ...session, resource: URI.revive(session.resource), parentResource: URI.revive(session.parentResource), projectUri: URI.revive(session.projectUri) }));
		}
		await this.sessions.activateChatSessionItemProvider(resolvedEngine);
		const result: IAdeEngineSession[] = [];
		for await (const group of this.sessions.getChatSessionItems([resolvedEngine], CancellationToken.None)) {
			for (const item of group.items) {
				const session = this.binding(resolvedEngine, item);
				if (session && (!projectUri || this.identity.extUri.isEqual(projectUri, session.projectUri))) {
					result.push(session);
				}
			}
		}
		return result;
	}

	async rename(session: IAdeSession, label: string): Promise<void> {
		if (session.engineId.startsWith('aexus-')) {
			await this.commands.executeCommand('aexus.agentEngines.rename', session.resource, label);
		}
	}

	async delete(session: IAdeSession): Promise<void> {
		if (session.engineId.startsWith('aexus-')) {
			await this.commands.executeCommand('aexus.agentEngines.delete', session.resource);
		}
	}

	async stop(session: IAdeSession, options?: { readonly hostAlias?: string }): Promise<void> {
		if (session.engineId.startsWith('aexus-')) {
			await this.commands.executeCommand('aexus.agentEngines.killSession', session.resource, options).catch(() => undefined);
		}
	}

	async deleteProjectSessions(projectUri: URI): Promise<number> {
		if (projectUri.scheme !== Schemas.file && projectUri.scheme !== AEXUS_SSH_SCHEME) {
			return 0;
		}
		await this.extensions.whenInstalledExtensionsRegistered();
		return (await this.commands.executeCommand<number>('aexus.agentEngines.deleteProjectSessions', projectUri).catch(() => 0)) ?? 0;
	}

	async getSessionInfo(session: IAdeSession): Promise<{ nativeId?: string; provisional?: boolean; unmaterialized?: boolean; engine?: string } | undefined> {
		if (!session.engineId.startsWith('aexus-')) {
			return undefined;
		}
		return this.commands.executeCommand<{ nativeId?: string; provisional?: boolean; unmaterialized?: boolean; engine?: string }>('aexus.agentEngines.info', session.resource).catch(() => undefined);
	}
}
