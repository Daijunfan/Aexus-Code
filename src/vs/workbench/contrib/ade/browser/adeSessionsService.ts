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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IChatSessionItem, IChatSessionsService } from '../../chat/common/chatSessionsService.js';
import { IAdeSession } from '../common/ade.js';

export interface IAdeEngine {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly icon?: URI | ThemeIcon;
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
	getEngines(): Promise<readonly IAdeEngine[]>;
	create(engineId: string, projectUri: URI): Promise<IAdeEngineSession>;
	attach?(engineId: string, nativeId: string, projectUri?: URI): Promise<IAdeEngineSession>;
	list(engineId: string, projectUri?: URI): Promise<readonly IAdeEngineSession[]>;
	rename(session: IAdeSession, label: string): Promise<void>;
	delete(session: IAdeSession): Promise<void>;
	deleteProjectSessions?(projectUri: URI): Promise<number>;
	ensureSecretary?(engineId?: string, projectUri?: URI, forceReset?: boolean): Promise<IAdeSession | undefined>;
	getSessionInfo?(session: IAdeSession): Promise<{ nativeId?: string; provisional?: boolean; unmaterialized?: boolean; engine?: string } | undefined>;
}

interface IBuiltinEngine {
	id: string;
	name: string;
	available: boolean;
}

/** Adapts engine-owned sessions to the ADE catalog without owning transcripts or engine configuration. */
export class AdeSessionsService implements IAdeSessionsService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IChatSessionsService private readonly sessions: IChatSessionsService,
		@ICommandService private readonly commands: ICommandService,
		@IExtensionService private readonly extensions: IExtensionService,
		@IUriIdentityService private readonly identity: IUriIdentityService,
	) { }

	get onDidChangeEngines(): Event<void> {
		return Event.any(this.sessions.onDidChangeAvailability, Event.map(this.sessions.onDidChangeItemsProviders, () => { }));
	}

	getIcon(engineId: string): URI | ThemeIcon | undefined {
		const contribution = this.sessions.getChatSessionContribution(engineId);
		if (contribution?.icon) {
			return contribution.icon;
		}
		const owner = this.extensions.extensions.find(extension => {
			const contributes = extension.contributes as { chatSessions?: readonly { type: string }[] } | undefined;
			return contributes?.chatSessions?.some(session => session.type === engineId);
		});
		return owner?.icon ? joinPath(owner.extensionLocation, owner.icon) : undefined;
	}

	getEngineName(engineId: string): string {
		return this.sessions.getChatSessionContribution(engineId)?.displayName ?? engineId;
	}

	async getEngines(): Promise<readonly IAdeEngine[]> {
		await this.extensions.whenInstalledExtensionsRegistered();
		const builtin = await this.commands.executeCommand<IBuiltinEngine[]>('aexus.agentEngines.list');
		const availability = new Map((builtin ?? []).map(engine => [engine.id, engine.available]));
		return this.sessions.getAllChatSessionContributions()
			.filter(contribution => contribution.type !== 'local' && contribution.type !== 'aexus-secretary' && contribution.type !== 'openai-codex' && (!contribution.hideFromSessionTypePicker || availability.has(contribution.type)) && !contribution.isReadOnly && (!availability.has(contribution.type) || availability.get(contribution.type)))
			.map(contribution => ({ id: contribution.type, name: contribution.displayName, description: contribution.description, icon: this.getIcon(contribution.type) }));
	}

	private binding(engineId: string, item: IChatSessionItem): IAdeEngineSession | undefined {
		const cwd = item.metadata?.workingDirectoryPath ?? item.metadata?.repositoryPath;
		return cwd ? { engineId, resource: item.resource, projectUri: URI.file(cwd), label: item.label, updated: item.timing.lastRequestEnded ?? item.timing.created } : undefined;
	}

	async create(engineId: string, projectUri: URI): Promise<IAdeEngineSession> {
		if (engineId.startsWith('aexus-')) {
			if (projectUri.scheme !== Schemas.file) {
				throw new Error(localize('nativeEngineNeedsLocalProject', "This engine runs on this computer. Select a local project folder or use a session provider for the remote host."));
			}
			const created = await this.commands.executeCommand<IAdeEngineSession>('aexus.agentEngines.create', engineId, projectUri);
			if (!created) {
				throw new Error(localize('engineSessionNotCreated', "The engine did not create a conversation."));
			}
			return { ...created, resource: URI.revive(created.resource), parentResource: URI.revive(created.parentResource), projectUri: URI.revive(created.projectUri) };
		}
		await this.sessions.activateChatSessionItemProvider(engineId);
		const item = await this.sessions.createNewChatSessionItem(engineId, { prompt: '' }, CancellationToken.None);
		const result = item && this.binding(engineId, item);
		if (!result || !this.identity.extUri.isEqual(result.projectUri, projectUri)) {
			throw new Error(localize('engineProjectNotReported', "This engine did not create a session in the selected project. Create it in the engine first, then choose Open Existing Session."));
		}
		return result;
	}

	async attach(engineId: string, nativeId: string, projectUri?: URI): Promise<IAdeEngineSession> {
		if (engineId.startsWith('aexus-')) {
			const attached = await this.commands.executeCommand<IAdeEngineSession>('aexus.agentEngines.attach', engineId, nativeId, projectUri);
			if (!attached) {
				throw new Error(localize('engineSessionNotAttached', "Could not attach conversation {0}.", nativeId));
			}
			return { ...attached, resource: URI.revive(attached.resource), parentResource: URI.revive(attached.parentResource), projectUri: URI.revive(attached.projectUri) };
		}
		const items = await this.list(engineId, projectUri);
		const found = items.find(item => item.resource.path.endsWith(`/${nativeId}`) || item.resource.toString().includes(nativeId));
		if (!found) {
			throw new Error(localize('engineSessionNotAttached', "Could not attach conversation {0}.", nativeId));
		}
		return found;
	}

	async list(engineId: string, projectUri?: URI): Promise<readonly IAdeEngineSession[]> {
		if (engineId.startsWith('aexus-')) {
			const result = await this.commands.executeCommand<IAdeEngineSession[]>('aexus.agentEngines.sessions', engineId, projectUri);
			return (result ?? []).map(session => ({ ...session, resource: URI.revive(session.resource), parentResource: URI.revive(session.parentResource), projectUri: URI.revive(session.projectUri) }));
		}
		await this.sessions.activateChatSessionItemProvider(engineId);
		const result: IAdeEngineSession[] = [];
		for await (const group of this.sessions.getChatSessionItems([engineId], CancellationToken.None)) {
			for (const item of group.items) {
				const session = this.binding(engineId, item);
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

	async deleteProjectSessions(projectUri: URI): Promise<number> {
		if (projectUri.scheme !== Schemas.file) {
			return 0;
		}
		await this.extensions.whenInstalledExtensionsRegistered();
		return (await this.commands.executeCommand<number>('aexus.agentEngines.deleteProjectSessions', projectUri).catch(() => 0)) ?? 0;
	}

	async ensureSecretary(engineId?: string, projectUri?: URI, forceReset?: boolean): Promise<IAdeSession | undefined> {
		await this.extensions.whenInstalledExtensionsRegistered();
		const res = await this.commands.executeCommand<{ engineId: string; resource: URI } | undefined>('aexus.agentEngines.ensureSecretary', engineId, projectUri, forceReset).catch(() => undefined);
		return res ? { engineId: res.engineId, resource: URI.revive(res.resource) } : undefined;
	}

	async getSessionInfo(session: IAdeSession): Promise<{ nativeId?: string; provisional?: boolean; unmaterialized?: boolean; engine?: string } | undefined> {
		if (!session.engineId.startsWith('aexus-')) {
			return undefined;
		}
		return this.commands.executeCommand<{ nativeId?: string; provisional?: boolean; unmaterialized?: boolean; engine?: string }>('aexus.agentEngines.info', session.resource).catch(() => undefined);
	}
}
