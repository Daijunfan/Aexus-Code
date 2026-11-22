/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/ideSessionsView.css';
import { asCSSUrl } from '../../../../base/browser/cssValue.js';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	ADE_OS_ICON_LABELS,
	AEXUS_SSH_SCHEME,
	IAdeCloudHost,
	IAdeCloudHostBackendService,
	isCloudProjectUri,
	resolveAdeOsIconKind,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ExtensionIdentifier, ExtensionIdentifierSet } from '../../../../platform/extensions/common/extensions.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { editorBackground } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { renderAdeOsIcon, resolveLocalOsIconKind } from '../../../browser/adeOsIcon.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { SIDE_BAR_BACKGROUND, SIDE_BAR_FOREGROUND } from '../../../common/theme.js';
import { Extensions, ICustomViewDescriptor, IViewContainersRegistry, IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { isCodingAgentExtension, isKnownCodingAgentId } from '../../../services/extensions/common/codingAgentExtensions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID, IAdeProjectsService } from '../../ade/common/ade.js';
import { IAdeEngine, IAdeEngineProbeResult, IAdeEngineSession, IAdeSessionsService } from '../../ade/browser/adeSessionsService.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { IChatModelReference, IChatService } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { IChatModel } from '../../chat/common/model/chatModel.js';
import { ChatWidget } from '../../chat/browser/widget/chatWidget.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { ExtensionState, IExtension, IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';

export const IDE_SESSIONS_CONTAINER_ID = 'workbench.view.ideSessions';
export const IDE_SESSIONS_VIEW_ID = 'workbench.view.ideSessions.list';
export const IDE_OPEN_SESSIONS_COMMAND_ID = 'workbench.action.ide.openSessions';
export const IDE_AGENT_ENGINE_ICON = Codicon.robot;

const ADE_SECRETARY_SCHEME = 'aexus-secretary';
const IDE_ADDED_SESSIONS_STORAGE_KEY = 'aexus.ide.pureNativeAddedSessions.v1';

export const IDE_PANEL_LESS_AGENT_LAUNCH_COMMANDS = new Map<string, string>([
	['sst-dev.opencode', 'opencode.openNewTerminal'],
	['pi0.pi-vscode', 'pi-vscode.open'],
]);

export interface IIdeNativeSessionItem {
	readonly engineId: string;
	readonly engineName: string;
	readonly resource: URI;
	readonly projectUri: URI;
	readonly label: string;
	readonly updated: number;
	readonly remoteHost?: string;
}

interface IPersistedIdeSessionEntry {
	readonly engineId: string;
	readonly engineName: string;
	readonly resource: string;
	readonly projectUri: string;
	readonly label: string;
	readonly updated: number;
	readonly remoteHost?: string;
}

export interface IIdeInstalledAgentExtensionPick extends IQuickPickItem {
	readonly kind: 'extension';
	readonly extension: IExtension;
	readonly container: ViewContainer | undefined;
}

/**
 * Pure filter guaranteeing strict separation between IDE pure-native sessions and ADE role-based sessions.
 * Any session registered in ADE's org-chart (`IAdeProjectsService.agents`) or Secretary is excluded.
 */
export function filterPureNativeIdeSessions(
	sessions: readonly IIdeNativeSessionItem[],
	adeExcludedResources: ReadonlySet<string>,
): readonly IIdeNativeSessionItem[] {
	const seen = new Set<string>();
	const filtered: IIdeNativeSessionItem[] = [];
	for (const item of sessions) {
		if (item.resource.scheme === ADE_SECRETARY_SCHEME) {
			continue;
		}
		const key = item.resource.toString();
		if (adeExcludedResources.has(key) || seen.has(key)) {
			continue;
		}
		seen.add(key);
		filtered.push(item);
	}
	filtered.sort((a, b) => b.updated - a.updated);
	return filtered;
}

function formatRelativeTime(timestamp: number): string {
	if (!timestamp || !Number.isFinite(timestamp)) {
		return '';
	}
	const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (diffSec < 60) {
		return localize('ideSessionJustNow', "just now");
	}
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) {
		return localize('ideSessionMinutesAgo', "{0}m ago", diffMin);
	}
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) {
		return localize('ideSessionHoursAgo', "{0}h ago", diffHr);
	}
	const diffDay = Math.floor(diffHr / 24);
	if (diffDay < 30) {
		return localize('ideSessionDaysAgo', "{0}d ago", diffDay);
	}
	const d = new Date(timestamp);
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatProjectLocation(uri: URI): string {
	if (uri.scheme === AEXUS_SSH_SCHEME && uri.authority) {
		return `${uri.authority}:${uri.path || '/'}`;
	}
	return uri.fsPath;
}

function normalizeIdeProjectKey(uri: URI): string {
	if (uri.scheme === AEXUS_SSH_SCHEME && uri.authority) {
		const cleanedPath = (uri.path || '/').replace(/\/+$/, '') || '/';
		return uri.with({ authority: uri.authority.toLowerCase(), path: cleanedPath }).toString();
	}
	return uri.toString();
}

function applyEngineGlyph(el: HTMLElement, icon: URI | ThemeIcon | undefined): void {
	if (URI.isUri(icon)) {
		el.className = 'aexus-ide-engine-glyph is-svg';
		el.style.backgroundImage = asCSSUrl(icon);
	} else {
		const ti = icon ?? IDE_AGENT_ENGINE_ICON;
		el.className = `aexus-ide-engine-glyph ${ThemeIcon.asClassName(ti)}`;
		el.style.backgroundImage = '';
	}
}

export interface IIdeEmbeddedChatWidget {
	render(parent: HTMLElement): void;
	setVisible(visible: boolean): void;
	layout(height: number, width: number): void;
	setModel(model: IChatModel | undefined): void;
	focusInput(): void;
	dispose(): void;
}

export class IdeSessionsViewPane extends ViewPane {
	private rootEl: HTMLElement | undefined;
	private listShellEl: HTMLElement | undefined;
	private projectBarEl: HTMLElement | undefined;
	private searchInputEl: HTMLInputElement | undefined;
	private agentExtBtnEl: HTMLButtonElement | undefined;
	private engineFilterEl: HTMLElement | undefined;
	private listBodyEl: HTMLElement | undefined;

	private chatShellEl: HTMLElement | undefined;
	private chatHeaderEl: HTMLElement | undefined;
	private chatWidgetHostEl: HTMLElement | undefined;
	private chatWidget: IIdeEmbeddedChatWidget | undefined;
	private readonly chatModelRef = this._register(new MutableDisposable<IChatModelReference>());
	private readonly activeLoadCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly scanCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly filterDisposables = this._register(new DisposableStore());
	private readonly listDisposables = this._register(new DisposableStore());
	private readonly headerDisposables = this._register(new DisposableStore());
	private readonly chatHeaderDisposables = this._register(new DisposableStore());

	private readonly sessionsService: IAdeSessionsService | undefined;
	private readonly adeProjectsService: IAdeProjectsService | undefined;
	private readonly cloudHostService: IAdeCloudHostBackendService | undefined;
	private readonly chatService: IChatService | undefined;
	private readonly storageService: IStorageService | undefined;
	private readonly extensionService: IExtensionService | undefined;
	private readonly extensionsWorkbenchService: IExtensionsWorkbenchService | undefined;
	private readonly viewsService: IViewsService | undefined;

	private cloudHostsByAlias = new Map<string, IAdeCloudHost>();
	private addedSessionsByProject = new Map<string, IIdeNativeSessionItem[]>();
	private activeProjectOverride: URI | undefined;
	private lastScannedProjectKey: string | undefined;
	private discoveredEngines: readonly IAdeEngine[] = [];
	private allSessions: readonly IIdeNativeSessionItem[] = [];
	private activeEngineFilter = 'all';
	private searchQuery = '';
	private isLoadingList = false;
	private listError: string | undefined;
	private activeSession: IIdeNativeSessionItem | undefined;
	private activeChatLoading = false;
	private activeChatError: string | undefined;
	private scanGeneration = 0;
	private lastWidth = 0;
	private lastHeight = 0;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IProjectNavigationService private readonly projectNavigation: IProjectNavigationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		const tryGet = <T>(id: ServiceIdentifier<T>): T | undefined => instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(id);
			} catch {
				return undefined;
			}
		});
		this.sessionsService = tryGet(IAdeSessionsService);
		this.adeProjectsService = tryGet(IAdeProjectsService);
		this.cloudHostService = tryGet(IAdeCloudHostBackendService);
		this.chatService = tryGet(IChatService);
		this.storageService = tryGet(IStorageService);
		this.extensionService = tryGet(IExtensionService);
		this.extensionsWorkbenchService = tryGet(IExtensionsWorkbenchService);
		this.viewsService = tryGet(IViewsService);

		this.loadAddedSessionsFromStorage();

		if (this.cloudHostService) {
			const loadHosts = () => {
				void this.cloudHostService?.listHosts().then(hosts => {
					const map = new Map<string, IAdeCloudHost>();
					for (const h of hosts) {
						map.set(h.alias.toLowerCase(), h);
						if (h.name) {
							map.set(h.name.toLowerCase(), h);
						}
					}
					this.cloudHostsByAlias = map;
					this.renderProjectBanner();
				}).catch(() => undefined);
			};
			loadHosts();
			if (this.cloudHostService.onDidChangeHosts) {
				this._register(this.cloudHostService.onDidChangeHosts(() => loadHosts()));
			}
		}

		this._register(Event.any(
			this.projectNavigation.onDidChangeSelectedProject,
			this.projectNavigation.onDidChangeProject,
			this.projectNavigation.onDidChangeProjectOrder,
		)(() => {
			const active = this.resolveActiveProject();
			if (this.activeProjectOverride && !this.projectNavigation.orderedProjects.some(f => this.uriIdentityService.extUri.isEqual(f.uri, this.activeProjectOverride!))) {
				this.activeProjectOverride = undefined;
			}
			// If user switched projects in the left Explorer while on the session list, automatically follow that project!
			if (!this.activeSession) {
				this.activeProjectOverride = undefined;
				this.activeEngineFilter = 'all';
				void this.refreshSessions(false);
			} else if (active) {
				this.renderProjectBanner();
			}
		}));

		if (this.adeProjectsService) {
			this._register(this.adeProjectsService.onDidChange(() => {
				// Keep ADE role-based sessions strictly excluded whenever ADE sessions change.
				this.renderEngineFilters();
				this.renderSessionList();
			}));
		}

		this._register(this.onDidChangeBodyVisibility(visible => {
			this.chatWidget?.setVisible(visible && Boolean(this.activeSession));
			if (visible && !this.activeSession && this.allSessions.length === 0 && !this.isLoadingList) {
				void this.refreshSessions(false);
			}
		}));
	}

	private loadAddedSessionsFromStorage(): void {
		const raw = this.storageService?.get(IDE_ADDED_SESSIONS_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		try {
			const parsed = JSON.parse(raw) as Record<string, IPersistedIdeSessionEntry[]>;
			for (const [projectKey, entries] of Object.entries(parsed)) {
				if (!Array.isArray(entries)) {
					continue;
				}
				const restored: IIdeNativeSessionItem[] = [];
				for (const e of entries) {
					if (!e || typeof e.resource !== 'string' || typeof e.engineId !== 'string') {
						continue;
					}
					restored.push({
						engineId: e.engineId,
						engineName: e.engineName || e.engineId,
						resource: URI.parse(e.resource),
						projectUri: URI.parse(e.projectUri || projectKey),
						label: e.label || e.engineId,
						updated: typeof e.updated === 'number' ? e.updated : 0,
						...(e.remoteHost ? { remoteHost: e.remoteHost } : {}),
					});
				}
				if (restored.length > 0) {
					const normalizedKey = (() => {
						try {
							return normalizeIdeProjectKey(URI.parse(projectKey));
						} catch {
							return projectKey;
						}
					})();
					const existing = this.addedSessionsByProject.get(normalizedKey) ?? [];
					this.addedSessionsByProject.set(normalizedKey, [...existing, ...restored]);
				}
			}
		} catch {
			// Ignore malformed storage data
		}
	}

	private saveAddedSessionsToStorage(): void {
		if (!this.storageService) {
			return;
		}
		const payload: Record<string, IPersistedIdeSessionEntry[]> = {};
		for (const [projectKey, items] of this.addedSessionsByProject.entries()) {
			if (items.length === 0) {
				continue;
			}
			payload[projectKey] = items.map(s => ({
				engineId: s.engineId,
				engineName: s.engineName,
				resource: s.resource.toString(),
				projectUri: s.projectUri.toString(),
				label: s.label,
				updated: s.updated,
				...(s.remoteHost ? { remoteHost: s.remoteHost } : {}),
			}));
		}
		this.storageService.store(IDE_ADDED_SESSIONS_STORAGE_KEY, JSON.stringify(payload), StorageScope.WORKSPACE, StorageTarget.USER);
	}

	private getAddedSessionsForProject(projectUri: URI | undefined): readonly IIdeNativeSessionItem[] {
		if (!projectUri) {
			return [];
		}
		return this.addedSessionsByProject.get(normalizeIdeProjectKey(projectUri)) ?? [];
	}

	private rememberAddedSession(projectUri: URI, session: IIdeNativeSessionItem): void {
		const key = normalizeIdeProjectKey(projectUri);
		const existing = this.addedSessionsByProject.get(key) ?? [];
		const next = [session, ...existing.filter(s => s.resource.toString() !== session.resource.toString())];
		this.addedSessionsByProject.set(key, next);
		this.saveAddedSessionsToStorage();
	}

	async focusProject(projectUri?: URI, forceRefresh = false): Promise<void> {
		if (projectUri) {
			this.activeProjectOverride = projectUri;
		} else {
			this.activeProjectOverride = undefined;
		}
		this.activeEngineFilter = 'all';
		this.exitConversationView();
		const resolved = this.resolveActiveProject();
		const key = resolved ? normalizeIdeProjectKey(resolved.uri) : undefined;
		if (forceRefresh || !key || key !== this.lastScannedProjectKey) {
			await this.refreshSessions(forceRefresh);
		}
	}

	private resolveActiveProject(): { readonly name: string; readonly uri: URI } | undefined {
		const ordered = this.projectNavigation.orderedProjects;
		if (this.activeProjectOverride) {
			const match = ordered.find(f => this.uriIdentityService.extUri.isEqual(f.uri, this.activeProjectOverride!));
			if (match) {
				return { name: match.name, uri: match.uri };
			}
			const seg = this.activeProjectOverride.path.split('/').filter(Boolean).pop() || this.activeProjectOverride.authority || 'Project';
			return { name: seg, uri: this.activeProjectOverride };
		}
		const target = this.projectNavigation.focusedProject
			?? this.projectNavigation.selectedProject
			?? ordered[0];
		return target ? { name: target.name, uri: target.uri } : undefined;
	}

	private collectAdeExcludedResources(): ReadonlySet<string> {
		const excluded = new Set<string>();
		const adeProjects = this.adeProjectsService;
		if (!adeProjects) {
			return excluded;
		}
		for (const agent of adeProjects.agents) {
			if (agent.session?.resource) {
				excluded.add(agent.session.resource.toString());
			}
		}
		if (adeProjects.secretary?.session?.resource) {
			excluded.add(adeProjects.secretary.session.resource.toString());
		}
		return excluded;
	}

	private getMergedSessionsForActiveProject(): readonly IIdeNativeSessionItem[] {
		const project = this.resolveActiveProject();
		const added = this.getAddedSessionsForProject(project?.uri);
		if (added.length === 0) {
			return this.allSessions;
		}
		// Put live discovered sessions first so updated titles/timestamps win over cached storage entries.
		return [...this.allSessions, ...added];
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.rootEl = append(container, $('.aexus-ide-sessions-pane'));

		// 1. Session List Mode
		this.listShellEl = append(this.rootEl, $('.aexus-ide-sessions-list-shell'));
		this.projectBarEl = append(this.listShellEl, $('.aexus-ide-sessions-header'));

		// Row 1: Search + Installed Agent Extensions + Refresh
		const toolbar = append(this.listShellEl, $('.aexus-ide-sessions-toolbar'));
		const searchWrap = append(toolbar, $('.aexus-ide-search-wrap'));
		append(searchWrap, $('span.codicon.codicon-search.aexus-ide-search-ico', { 'aria-hidden': 'true' }));
		this.searchInputEl = append(searchWrap, $('input.aexus-ide-search-input', {
			type: 'text',
			placeholder: localize('ideSessionsSearchPlaceholder', "Filter folder sessions..."),
			'data-ide-sessions-search': 'true',
		})) as HTMLInputElement;
		this._register(addDisposableListener(this.searchInputEl, EventType.INPUT, () => {
			this.searchQuery = this.searchInputEl?.value ?? '';
			this.renderSessionList();
		}));

		this.agentExtBtnEl = append(toolbar, $('button.aexus-ide-tool-btn.icon-only', {
			type: 'button',
			title: localize('ideOpenAgentExtensionsTip', "Open Installed Agent Extension Panel"),
			'aria-label': localize('ideOpenAgentExtensionsAria', "Open Installed Agent Extension Panel"),
			'data-ide-agent-extensions': 'true',
		})) as HTMLButtonElement;
		append(this.agentExtBtnEl, $('span.codicon.codicon-robot', { 'aria-hidden': 'true' }));
		this._register(addDisposableListener(this.agentExtBtnEl, EventType.CLICK, () => {
			void this.openInstalledAgentExtension();
		}));

		const refreshBtn = append(toolbar, $('button.aexus-ide-tool-btn.icon-only', {
			type: 'button',
			title: localize('ideSessionsRefreshTip', "Refresh historical sessions from this local or cloud folder"),
			'aria-label': localize('ideSessionsRefreshAria', "Refresh sessions"),
			'data-ide-sessions-refresh': 'true',
		})) as HTMLButtonElement;
		append(refreshBtn, $('span.codicon.codicon-refresh', { 'aria-hidden': 'true' }));
		this._register(addDisposableListener(refreshBtn, EventType.CLICK, () => {
			void this.refreshSessions(true);
		}));

		// Row 2: Dual First-Class Actions — Add Existing Session + New Session (compatible with both Local & Cloud)
		const actionBar = append(this.listShellEl, $('.aexus-ide-sessions-action-bar'));

		const addBtn = append(actionBar, $('button.aexus-ide-tool-btn.action-half', {
			type: 'button',
			title: localize('ideSessionsAddTip', "Add or attach an existing session (local or cloud, separated from ADE)"),
			'data-ide-sessions-add': 'true',
		})) as HTMLButtonElement;
		append(addBtn, $('span.codicon.codicon-history', { 'aria-hidden': 'true' }));
		append(addBtn, $('span', {}, localize('ideSessionsAddLabel', "Add Session")));
		this._register(addDisposableListener(addBtn, EventType.CLICK, () => {
			void this.addExistingNativeSession();
		}));

		const newBtn = append(actionBar, $('button.aexus-ide-tool-btn.primary.action-half', {
			type: 'button',
			title: localize('ideSessionsNewTip', "Start a new Pure Native Agent session in this local or cloud folder"),
			'data-ide-sessions-new': 'true',
		})) as HTMLButtonElement;
		append(newBtn, $('span.codicon.codicon-add', { 'aria-hidden': 'true' }));
		append(newBtn, $('span', {}, localize('ideSessionsNewLabel', "New Session")));
		this._register(addDisposableListener(newBtn, EventType.CLICK, () => {
			void this.createNewNativeSession();
		}));

		this.engineFilterEl = append(this.listShellEl, $('.aexus-ide-engine-filters'));
		this.listBodyEl = append(this.listShellEl, $('.aexus-ide-sessions-scroll', {
			role: 'list',
			'data-ide-sessions-list': 'true',
		}));

		// 2. Embedded Pure-Native Chat Mode (inside the right sidebar)
		this.chatShellEl = append(this.rootEl, $('.aexus-ide-chat-shell'));
		this.chatShellEl.hidden = true;
		this.chatHeaderEl = append(this.chatShellEl, $('.aexus-ide-chat-header'));
		this.chatWidgetHostEl = append(this.chatShellEl, $('.aexus-ide-chat-widget-host'));

		this.renderProjectBanner();
		this.renderEngineFilters();
		this.renderSessionList();
		void this.refreshSessions(false);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.lastHeight = height;
		this.lastWidth = width;
		if (this.chatWidget && this.chatShellEl && !this.chatShellEl.hidden) {
			const headerH = this.chatHeaderEl?.offsetHeight || 38;
			this.chatWidget.layout(Math.max(80, height - headerH), Math.max(120, width));
		}
	}

	private renderProjectBanner(): void {
		if (!this.projectBarEl) {
			return;
		}
		this.headerDisposables.clear();
		clearNode(this.projectBarEl);

		const project = this.resolveActiveProject();
		const isRemote = Boolean(project && isCloudProjectUri(project.uri));
		const savedHost = isRemote && project ? this.cloudHostsByAlias.get(project.uri.authority.toLowerCase()) : undefined;
		const osKind = isRemote && project
			? resolveAdeOsIconKind({
				os: savedHost?.os,
				distribution: savedHost?.lastTestStatus?.remoteUname,
				hint: `${savedHost?.name ?? ''} ${savedHost?.alias ?? ''} ${savedHost?.user ?? ''} ${project.uri.authority} ${project.uri.path}`,
			})
			: resolveLocalOsIconKind();

		const projectBtn = append(this.projectBarEl, $(`button.aexus-ide-project-pill${isRemote ? '.is-remote' : '.is-local'}`, {
			type: 'button',
			'data-ide-project-os': osKind,
			'data-ide-project-remote': String(isRemote),
			title: project
				? localize('ideProjectSwitchTip', "{0}\n{1}\nClick to switch local or cloud project folder", project.name, formatProjectLocation(project.uri))
				: localize('ideNoProjectTip', "Open a local or Cloud Host folder in Explorer first"),
		})) as HTMLButtonElement;

		const osEl = append(projectBtn, $('span.aexus-ide-os-icon', { 'aria-hidden': 'true' }));
		renderAdeOsIcon(osEl, osKind, {
			baseClass: 'aexus-ide-os-icon',
			prefix: 'ade-os',
			tooltip: ADE_OS_ICON_LABELS[osKind],
		});

		const meta = append(projectBtn, $('.aexus-ide-project-meta'));
		append(meta, $('.aexus-ide-project-name', {}, project?.name ?? localize('ideNoProject', "No Project Selected")));
		append(meta, $('.aexus-ide-project-path', {}, project ? formatProjectLocation(project.uri) : localize('ideOpenFolderHint', "Select a folder in Explorer")));
		append(projectBtn, $('span.codicon.codicon-chevron-down.aexus-ide-project-chev', { 'aria-hidden': 'true' }));

		this.headerDisposables.add(addDisposableListener(projectBtn, EventType.CLICK, () => {
			void this.pickProjectFolder();
		}));

		append(this.projectBarEl, $('span.aexus-ide-native-badge', {
			'data-ide-pure-native': 'true',
			title: localize('idePureNativeBadgeTip', "Pure Native IDE Agent Sessions — zero ADE roles, compatible with both Local & Cloud folders"),
		}, localize('idePureNativeBadge', "Pure Native")));
	}

	private async pickProjectFolder(): Promise<void> {
		const folders = this.projectNavigation.orderedProjects;
		if (folders.length === 0) {
			return;
		}
		const picks = folders.map(f => ({
			label: f.name,
			description: formatProjectLocation(f.uri),
			uri: f.uri,
		}));
		const picked = await this.quickInputService.pick(picks, {
			placeHolder: localize('idePickProjectPlaceholder', "Choose a local or Cloud Host folder for Agent sessions"),
			matchOnDescription: true,
		});
		if (picked) {
			this.activeProjectOverride = picked.uri;
			this.projectNavigation.selectProject(picked.uri);
			this.activeEngineFilter = 'all';
			await this.refreshSessions(false);
		}
	}

	async refreshSessions(forceRefresh = false): Promise<void> {
		const gen = ++this.scanGeneration;
		this.scanCts.value?.cancel();
		const cts = this.scanCts.value = new CancellationTokenSource();

		const project = this.resolveActiveProject();
		this.renderProjectBanner();

		if (!project || !this.sessionsService) {
			this.lastScannedProjectKey = undefined;
			this.discoveredEngines = [];
			this.allSessions = [];
			this.listError = undefined;
			this.isLoadingList = false;
			this.renderEngineFilters();
			this.renderSessionList();
			return;
		}

		this.isLoadingList = true;
		this.listError = undefined;
		this.renderSessionList();

		try {
			const probe: IAdeEngineProbeResult = this.sessionsService.probeEnginesForProject
				? await this.sessionsService.probeEnginesForProject(project.uri, { forceRefresh })
				: { engines: await this.sessionsService.getEngines(project.uri, { forceRefresh }) };

			if (cts.token.isCancellationRequested || gen !== this.scanGeneration) {
				return;
			}
			if (probe.error) {
				this.lastScannedProjectKey = undefined;
				this.discoveredEngines = [];
				this.allSessions = [];
				this.listError = probe.error;
				return;
			}
			this.discoveredEngines = probe.engines;
			const remoteHost = isCloudProjectUri(project.uri) ? (probe.remoteHost || project.uri.authority) : undefined;

			const batches = await Promise.all(
				probe.engines.map(async engine => {
					const items = await this.sessionsService!.list(engine.id, project.uri).catch(() => [] as readonly IAdeEngineSession[]);
					return items.map((s): IIdeNativeSessionItem => ({
						engineId: engine.id,
						engineName: engine.name,
						resource: s.resource,
						projectUri: s.projectUri,
						label: s.label,
						updated: s.updated ?? 0,
						remoteHost,
					}));
				}),
			);

			if (cts.token.isCancellationRequested || gen !== this.scanGeneration) {
				return;
			}
			this.lastScannedProjectKey = normalizeIdeProjectKey(project.uri);
			this.allSessions = batches.flat();
		} catch (err) {
			if (cts.token.isCancellationRequested || gen !== this.scanGeneration) {
				return;
			}
			this.lastScannedProjectKey = undefined;
			this.listError = err instanceof Error ? err.message : String(err);
			this.allSessions = [];
		} finally {
			if (gen === this.scanGeneration) {
				this.isLoadingList = false;
				this.renderEngineFilters();
				this.renderSessionList();
			}
		}
	}

	private getVisiblePureSessions(): readonly IIdeNativeSessionItem[] {
		const excluded = this.collectAdeExcludedResources();
		const pure = filterPureNativeIdeSessions(this.getMergedSessionsForActiveProject(), excluded);
		const q = this.searchQuery.trim().toLowerCase();
		return pure.filter(item => {
			if (this.activeEngineFilter !== 'all' && item.engineId !== this.activeEngineFilter) {
				return false;
			}
			if (q && !item.label.toLowerCase().includes(q) && !item.engineName.toLowerCase().includes(q)) {
				return false;
			}
			return true;
		});
	}

	private renderEngineFilters(): void {
		if (!this.engineFilterEl) {
			return;
		}
		this.filterDisposables.clear();
		clearNode(this.engineFilterEl);
		const excluded = this.collectAdeExcludedResources();
		const pureAll = filterPureNativeIdeSessions(this.getMergedSessionsForActiveProject(), excluded);

		const countsByEngine = new Map<string, number>();
		for (const item of pureAll) {
			countsByEngine.set(item.engineId, (countsByEngine.get(item.engineId) ?? 0) + 1);
		}

		const addChip = (id: string, label: string, count: number, icon?: URI | ThemeIcon) => {
			const isActive = this.activeEngineFilter === id;
			const chip = append(this.engineFilterEl!, $(`button.aexus-ide-filter-chip${isActive ? '.active' : ''}`, {
				type: 'button',
				'data-ide-engine-filter': id,
			})) as HTMLButtonElement;
			if (icon) {
				const glyph = append(chip, $('span.aexus-ide-engine-glyph', { 'aria-hidden': 'true' }));
				applyEngineGlyph(glyph, icon);
			}
			append(chip, $('span.aexus-ide-filter-label', {}, label));
			append(chip, $('span.aexus-ide-filter-count', {}, String(count)));
			this.filterDisposables.add(addDisposableListener(chip, EventType.CLICK, () => {
				this.activeEngineFilter = id;
				this.renderEngineFilters();
				this.renderSessionList();
			}));
		};

		addChip('all', localize('ideFilterAll', "All"), pureAll.length);
		for (const eng of this.discoveredEngines) {
			const cnt = countsByEngine.get(eng.id) ?? 0;
			addChip(eng.id, eng.name, cnt, this.sessionsService?.getIcon(eng.id) ?? eng.icon);
		}
	}

	private renderSessionList(): void {
		if (!this.listBodyEl) {
			return;
		}
		this.listDisposables.clear();
		clearNode(this.listBodyEl);

		const project = this.resolveActiveProject();
		const isRemote = Boolean(project && isCloudProjectUri(project.uri));

		if (!project) {
			const empty = append(this.listBodyEl, $('.aexus-ide-empty-state'));
			append(empty, $('span.codicon.codicon-folder-opened.aexus-ide-empty-ico', { 'aria-hidden': 'true' }));
			append(empty, $('.aexus-ide-empty-title', {}, localize('ideNoFolderTitle', "No Folder Selected")));
			append(empty, $('.aexus-ide-empty-sub', {}, localize('ideNoFolderSub', "Select a local or Cloud Host folder in the left Explorer to browse, add, or create native Agent sessions.")));
			return;
		}

		if (this.isLoadingList) {
			const loading = append(this.listBodyEl, $('.aexus-ide-empty-state.is-loading'));
			append(loading, $('span.codicon.codicon-loading.codicon-modifier-spin.aexus-ide-empty-ico', { 'aria-hidden': 'true' }));
			append(loading, $('.aexus-ide-empty-title', {}, isRemote
				? localize('ideScanningCloudSessions', "Scanning Agent sessions on {0}...", project.uri.authority)
				: localize('ideScanningLocalSessions', "Loading local Agent sessions...")));
			append(loading, $('.aexus-ide-empty-sub', {}, formatProjectLocation(project.uri)));
			return;
		}

		if (this.listError) {
			const errBox = append(this.listBodyEl, $('.aexus-ide-empty-state.is-error'));
			append(errBox, $('span.codicon.codicon-warning.aexus-ide-empty-ico', { 'aria-hidden': 'true' }));
			append(errBox, $('.aexus-ide-empty-title', {}, localize('ideCloudScanFailed', "Could not load host sessions")));
			append(errBox, $('.aexus-ide-empty-sub', {}, this.listError));
			const actions = append(errBox, $('.aexus-ide-empty-actions'));
			const retryBtn = append(actions, $('button.aexus-ide-tool-btn.primary', { type: 'button' }, localize('ideRetryScan', "Retry"))) as HTMLButtonElement;
			this.listDisposables.add(addDisposableListener(retryBtn, EventType.CLICK, () => {
				void this.refreshSessions(true);
			}));
			if (isRemote) {
				const hostsBtn = append(actions, $('button.aexus-ide-tool-btn', { type: 'button' }, localize('ideManageCloudHosts', "Cloud Hosts"))) as HTMLButtonElement;
				this.listDisposables.add(addDisposableListener(hostsBtn, EventType.CLICK, () => {
					void this.commandService.executeCommand(ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID);
				}));
			}
			return;
		}

		const visible = this.getVisiblePureSessions();
		if (visible.length === 0) {
			const empty = append(this.listBodyEl, $('.aexus-ide-empty-state'));
			append(empty, $('span.codicon.codicon-robot.aexus-ide-empty-ico', { 'aria-hidden': 'true' }));
			append(empty, $('.aexus-ide-empty-title', {}, this.searchQuery.trim()
				? localize('ideNoMatchingSessions', "No matching sessions")
				: isRemote
					? localize('ideNoCloudSessionsTitle', "No historical sessions in this cloud folder")
					: localize('ideNoLocalSessionsTitle', "No historical sessions in this local folder")));
			append(empty, $('.aexus-ide-empty-sub', {}, localize('ideEmptyStartHint', "Sessions here are pure native (local & cloud) and completely separate from ADE.")));
			const actions = append(empty, $('.aexus-ide-empty-actions'));
			const addBtn = append(actions, $('button.aexus-ide-tool-btn', { type: 'button' }, localize('ideEmptyAddSessionBtn', "Add Session"))) as HTMLButtonElement;
			this.listDisposables.add(addDisposableListener(addBtn, EventType.CLICK, () => {
				void this.addExistingNativeSession();
			}));
			const createBtn = append(actions, $('button.aexus-ide-tool-btn.primary', { type: 'button' }, localize('ideStartNativeSessionBtn', "+ New Session"))) as HTMLButtonElement;
			this.listDisposables.add(addDisposableListener(createBtn, EventType.CLICK, () => {
				void this.createNewNativeSession();
			}));
			return;
		}

		for (const session of visible) {
			const row = append(this.listBodyEl, $('.aexus-ide-session-row', {
				role: 'listitem',
				tabindex: '0',
				'data-ide-session-resource': session.resource.toString(),
				'data-ide-session-engine': session.engineId,
				title: `${session.label}\n${session.engineName}${session.remoteHost ? ` · ${session.remoteHost}` : ''}`,
			}));

			const iconEl = append(row, $('span.aexus-ide-engine-glyph.is-row', { 'aria-hidden': 'true' }));
			applyEngineGlyph(iconEl, this.sessionsService?.getIcon(session.engineId));

			const content = append(row, $('.aexus-ide-session-content'));
			append(content, $('.aexus-ide-session-title', {}, session.label));
			const subRow = append(content, $('.aexus-ide-session-sub'));
			append(subRow, $('span.aexus-ide-session-engine', {}, session.engineName));
			const rel = formatRelativeTime(session.updated);
			if (rel) {
				append(subRow, $('span.aexus-ide-session-sep', { 'aria-hidden': 'true' }, '·'));
				append(subRow, $('span.aexus-ide-session-time', {}, rel));
			}
			if (session.remoteHost) {
				append(subRow, $('span.aexus-ide-session-host-tag', {}, session.remoteHost));
			}

			const popoutBtn = append(row, $('button.aexus-ide-row-popout', {
				type: 'button',
				title: localize('ideOpenSessionInEditorTab', "Open in Editor Tab (Pure Native)"),
				'data-ide-session-popout': session.resource.toString(),
			})) as HTMLButtonElement;
			append(popoutBtn, $('span.codicon.codicon-go-to-file', { 'aria-hidden': 'true' }));
			this.listDisposables.add(addDisposableListener(popoutBtn, EventType.CLICK, (e: MouseEvent) => {
				e.stopPropagation();
				void this.openSessionInEditorTab(session);
			}));

			this.listDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
				void this.openSessionInSidebar(session);
			}));
			this.listDisposables.add(addDisposableListener(row, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					void this.openSessionInSidebar(session);
				}
			}));
		}
	}

	protected createChatWidget(host: HTMLElement): IIdeEmbeddedChatWidget {
		const scopedContext = this._register(this.contextKeyService.createScoped(host));
		ChatContextKeys.inChatEditor.bindTo(scopedContext).set(false);
		const scopedInstantiation = this._register(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, scopedContext])));
		const widget = this._register(scopedInstantiation.createInstance(
			ChatWidget,
			ChatAgentLocation.Chat,
			{ viewId: this.id },
			{
				autoScroll: mode => mode !== ChatModeKind.Ask,
				renderFollowups: true,
				renderArtifactsWidget: false,
				supportsFileReferences: true,
				enableFind: true,
				rendererOptions: {
					renderTextEditsAsSummary: () => true,
					referencesExpandedWhenEmptyResponse: false,
					progressMessageAtBottomOfResponse: mode => mode !== ChatModeKind.Ask,
				},
				enableImplicitContext: true,
				enableWorkingSet: 'explicit',
				supportsChangingModes: true,
				enableSessionStateIndicator: true,
			},
			{
				listForeground: SIDE_BAR_FOREGROUND,
				listBackground: SIDE_BAR_BACKGROUND,
				overlayBackground: SIDE_BAR_BACKGROUND,
				inputEditorBackground: SIDE_BAR_BACKGROUND,
				resultEditorBackground: editorBackground,
			},
		));
		widget.render(host);
		return widget;
	}

	private ensureChatWidget(): IIdeEmbeddedChatWidget | undefined {
		if (this.chatWidget) {
			return this.chatWidget;
		}
		if (!this.chatWidgetHostEl) {
			return undefined;
		}
		this.chatWidget = this.createChatWidget(this.chatWidgetHostEl);
		return this.chatWidget;
	}

	async openSessionInSidebar(session: IIdeNativeSessionItem): Promise<void> {
		this.activeSession = session;
		this.activeChatError = undefined;
		this.activeChatLoading = true;
		if (this.listShellEl) {
			this.listShellEl.hidden = true;
		}
		if (this.chatShellEl) {
			this.chatShellEl.hidden = false;
		}
		this.renderActiveChatHeader();

		this.activeLoadCts.value?.cancel();
		const cts = this.activeLoadCts.value = new CancellationTokenSource();

		if (!this.chatService) {
			this.activeChatLoading = false;
			this.activeChatError = localize('ideChatServiceUnavailable', "Chat service is unavailable in this environment.");
			this.renderActiveChatHeader();
			return;
		}

		try {
			const widget = this.ensureChatWidget();
			widget?.setVisible(this.isBodyVisible());
			if (widget && this.lastWidth > 0 && this.lastHeight > 0) {
				const headerH = this.chatHeaderEl?.offsetHeight || 38;
				widget.layout(Math.max(80, this.lastHeight - headerH), Math.max(120, this.lastWidth));
			}

			const ref = await this.chatService.acquireOrLoadSession(session.resource, ChatAgentLocation.Chat, cts.token, 'IdeSessionsViewPane#openSessionInSidebar');
			if (cts.token.isCancellationRequested || this.activeSession?.resource.toString() !== session.resource.toString()) {
				ref?.dispose();
				return;
			}
			if (!ref) {
				throw new Error(localize('ideSessionLoadReturnedEmpty', "Could not load session history from host."));
			}
			this.chatModelRef.value = ref;
			widget?.setModel(ref.object);
			widget?.focusInput();
		} catch (err) {
			if (!cts.token.isCancellationRequested) {
				this.activeChatError = err instanceof Error ? err.message : String(err);
				this.notificationService.error(localize('ideOpenSessionFailed', "Failed to open native session: {0}", this.activeChatError));
			}
		} finally {
			if (!cts.token.isCancellationRequested && this.activeSession?.resource.toString() === session.resource.toString()) {
				this.activeChatLoading = false;
				this.renderActiveChatHeader();
			}
		}
	}

	async openSessionInEditorTab(session: IIdeNativeSessionItem): Promise<void> {
		// Plain ChatEditorInput (NOT AdeLineageChatEditorInput, NEVER registered in IAdeProjectsService) -> 100% pure native.
		const input = this.instantiationService.createInstance(ChatEditorInput, session.resource, {
			title: { preferred: session.label },
		});
		await this.editorService.openEditor(input, { pinned: true });
	}

	exitConversationView(): void {
		this.activeLoadCts.value?.cancel();
		this.activeSession = undefined;
		this.activeChatLoading = false;
		this.activeChatError = undefined;
		this.chatWidget?.setModel(undefined);
		this.chatWidget?.setVisible(false);
		this.chatModelRef.clear();
		if (this.chatShellEl) {
			this.chatShellEl.hidden = true;
		}
		if (this.listShellEl) {
			this.listShellEl.hidden = false;
		}
		this.renderProjectBanner();
		const activeProject = this.resolveActiveProject();
		if (activeProject && normalizeIdeProjectKey(activeProject.uri) !== this.lastScannedProjectKey) {
			void this.refreshSessions(false);
		} else {
			this.renderEngineFilters();
			this.renderSessionList();
		}
	}

	private renderActiveChatHeader(): void {
		if (!this.chatHeaderEl) {
			return;
		}
		this.chatHeaderDisposables.clear();
		clearNode(this.chatHeaderEl);
		const session = this.activeSession;
		if (!session) {
			return;
		}

		const backBtn = append(this.chatHeaderEl, $('button.aexus-ide-back-btn', {
			type: 'button',
			title: localize('ideBackToSessionsTip', "Back to Agent sessions"),
			'data-ide-chat-back': 'true',
		})) as HTMLButtonElement;
		append(backBtn, $('span.codicon.codicon-arrow-left', { 'aria-hidden': 'true' }));
		append(backBtn, $('span', {}, localize('ideBackToSessionsLabel', "Sessions")));
		this.chatHeaderDisposables.add(addDisposableListener(backBtn, EventType.CLICK, () => {
			this.exitConversationView();
		}));

		const titleWrap = append(this.chatHeaderEl, $('.aexus-ide-chat-title-wrap'));
		const iconEl = append(titleWrap, $('span.aexus-ide-engine-glyph', { 'aria-hidden': 'true' }));
		applyEngineGlyph(iconEl, this.sessionsService?.getIcon(session.engineId));
		append(titleWrap, $('span.aexus-ide-chat-title', { title: session.label }, session.label));
		if (this.activeChatLoading) {
			append(titleWrap, $('span.codicon.codicon-loading.codicon-modifier-spin.aexus-ide-chat-spinner', { 'aria-hidden': 'true' }));
		} else if (session.remoteHost) {
			append(titleWrap, $('span.aexus-ide-session-host-tag', {}, session.remoteHost));
		}

		const rightBtns = append(this.chatHeaderEl, $('.aexus-ide-chat-actions'));
		const tabBtn = append(rightBtns, $('button.aexus-ide-icon-btn', {
			type: 'button',
			title: localize('idePopoutSessionTip', "Open this pure-native session in an Editor Tab"),
			'data-ide-chat-popout': 'true',
		})) as HTMLButtonElement;
		append(tabBtn, $('span.codicon.codicon-go-to-file', { 'aria-hidden': 'true' }));
		this.chatHeaderDisposables.add(addDisposableListener(tabBtn, EventType.CLICK, () => {
			void this.openSessionInEditorTab(session);
		}));

		const addBtn = append(rightBtns, $('button.aexus-ide-icon-btn', {
			type: 'button',
			title: localize('ideAddExistingSessionFromChatTip', "Add or attach an existing session"),
			'data-ide-chat-add': 'true',
		})) as HTMLButtonElement;
		append(addBtn, $('span.codicon.codicon-history', { 'aria-hidden': 'true' }));
		this.chatHeaderDisposables.add(addDisposableListener(addBtn, EventType.CLICK, () => {
			void this.addExistingNativeSession();
		}));

		const newBtn = append(rightBtns, $('button.aexus-ide-icon-btn', {
			type: 'button',
			title: localize('ideNewNativeSessionFromChatTip', "Start a new Pure Native session"),
			'data-ide-chat-new': 'true',
		})) as HTMLButtonElement;
		append(newBtn, $('span.codicon.codicon-add', { 'aria-hidden': 'true' }));
		this.chatHeaderDisposables.add(addDisposableListener(newBtn, EventType.CLICK, () => {
			void this.createNewNativeSession();
		}));

		if (this.activeChatError) {
			const errBanner = append(this.chatHeaderEl, $('.aexus-ide-chat-error-bar', {}, this.activeChatError));
			errBanner.title = this.activeChatError;
		}
	}

	private async resolveEnginesForProject(projectUri: URI, forceRefresh = false): Promise<readonly IAdeEngine[] | undefined> {
		if (!this.sessionsService) {
			return undefined;
		}
		if (!forceRefresh && this.discoveredEngines.length > 0 && this.lastScannedProjectKey === normalizeIdeProjectKey(projectUri)) {
			return this.discoveredEngines;
		}
		const probe: IAdeEngineProbeResult = this.sessionsService.probeEnginesForProject
			? await this.sessionsService.probeEnginesForProject(projectUri, { forceRefresh })
			: { engines: await this.sessionsService.getEngines(projectUri, { forceRefresh }) };
		if (probe.error) {
			this.notificationService.error(probe.error);
			return undefined;
		}
		this.discoveredEngines = probe.engines;
		return probe.engines;
	}

	private async collectInstalledCodingAgentExtensions(): Promise<IIdeInstalledAgentExtensionPick[]> {
		if (!this.extensionService || !this.extensionsWorkbenchService) {
			return [];
		}
		const [installed] = await Promise.all([
			this.extensionsWorkbenchService.queryLocal(),
			this.extensionService.whenInstalledExtensionsRegistered(),
		]);
		const codingAgents = new ExtensionIdentifierSet(
			this.extensionService.extensions.filter(isCodingAgentExtension).map(ext => ext.identifier),
		);
		const containersRegistry = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);
		const seen = new ExtensionIdentifierSet();
		const picks: IIdeInstalledAgentExtensionPick[] = [];
		for (const ext of installed) {
			if (ext.isBuiltin || ext.state !== ExtensionState.Installed) {
				continue;
			}
			if (seen.has(ext.identifier.id)) {
				continue;
			}
			const isAgent = codingAgents.has(ext.identifier.id) || isKnownCodingAgentId(ext.identifier.id);
			if (!isAgent) {
				continue;
			}
			seen.add(ext.identifier.id);
			const containers = this.viewDescriptorService.viewContainers.filter(c =>
				(c.extensionId && ExtensionIdentifier.equals(c.extensionId, ext.identifier.id))
				|| this.viewDescriptorService.getViewContainerModel(c).allViewDescriptors.some(v => ExtensionIdentifier.equals((v as ICustomViewDescriptor).extensionId, ext.identifier.id)),
			);
			containers.sort((a, b) =>
				Number(this.viewDescriptorService.getViewContainerModel(b).activeViewDescriptors.length > 0) - Number(this.viewDescriptorService.getViewContainerModel(a).activeViewDescriptors.length > 0)
				|| Number(containersRegistry.getViewContainerLocation(b) === ViewContainerLocation.AuxiliaryBar) - Number(containersRegistry.getViewContainerLocation(a) === ViewContainerLocation.AuxiliaryBar)
				|| Number(this.viewDescriptorService.getViewContainerLocation(b) === ViewContainerLocation.AuxiliaryBar) - Number(this.viewDescriptorService.getViewContainerLocation(a) === ViewContainerLocation.AuxiliaryBar),
			);
			const container = containers[0];
			const icon = container ? this.viewDescriptorService.getViewContainerModel(container).icon : IDE_AGENT_ENGINE_ICON;
			const iconUri = ext.iconUrl ? URI.parse(ext.iconUrl) : URI.isUri(icon) ? icon : undefined;
			picks.push({
				kind: 'extension',
				label: ext.displayName || ext.name,
				description: localize('ideAgentExtensionDesc', "Installed Agent Extension · {0}", ext.identifier.id),
				extension: ext,
				container,
				iconClass: !iconUri && ThemeIcon.isThemeIcon(icon) ? ThemeIcon.asClassName(icon) : undefined,
				iconPath: iconUri ? { dark: iconUri, light: iconUri } : undefined,
			});
		}
		picks.sort((a, b) => Number(Boolean(b.container)) - Number(Boolean(a.container)) || a.label.localeCompare(b.label));
		return picks;
	}

	private async launchInstalledAgentExtension(pick: IIdeInstalledAgentExtensionPick): Promise<void> {
		this.projectNavigation.bindCodingAgentProject(pick.extension.identifier.id.toLowerCase());
		if (!pick.container) {
			const launchCmd = IDE_PANEL_LESS_AGENT_LAUNCH_COMMANDS.get(pick.extension.identifier.id.toLowerCase());
			if (launchCmd && (CommandsRegistry.getCommand(launchCmd) || this.extensionService?.extensions.some(ext => ExtensionIdentifier.equals(ext.identifier, pick.extension.identifier.id)))) {
				await this.commandService.executeCommand(launchCmd);
				return;
			}
			await this.extensionsWorkbenchService?.open(pick.extension);
			return;
		}
		if (pick.container.extensionId && ExtensionIdentifier.equals(pick.container.extensionId, pick.extension.identifier.id)) {
			this.viewDescriptorService.moveViewContainerToLocation(pick.container, ViewContainerLocation.AuxiliaryBar, undefined, IDE_OPEN_SESSIONS_COMMAND_ID);
			await this.viewsService?.openViewContainer(pick.container.id, true);
		} else {
			const view = this.viewDescriptorService.getViewContainerModel(pick.container).allViewDescriptors.find(
				item => ExtensionIdentifier.equals((item as ICustomViewDescriptor).extensionId, pick.extension.identifier.id),
			);
			if (view) {
				this.viewDescriptorService.moveViewToLocation(view, ViewContainerLocation.AuxiliaryBar, IDE_OPEN_SESSIONS_COMMAND_ID);
				await this.viewsService?.openView(view.id, true);
			}
		}
	}

	async openInstalledAgentExtension(): Promise<void> {
		const picks = await this.collectInstalledCodingAgentExtensions();
		if (picks.length === 0) {
			this.notificationService.info(localize('ideNoInstalledAgentExtensions', "No third-party Coding Agent extensions installed. Use Add Session or New Session for built-in local and cloud Agent engines."));
			return;
		}
		const project = this.resolveActiveProject();
		const picked = await this.quickInputService.pick(picks, {
			placeHolder: project
				? localize('idePickAgentExtensionForProject', "Open an installed Coding Agent extension for {0}", project.name)
				: localize('idePickAgentExtension', "Open an installed Coding Agent extension"),
			matchOnDescription: true,
		});
		if (picked) {
			await this.launchInstalledAgentExtension(picked);
		}
	}

	/**
	 * Add / attach an existing Pure Native session strictly scoped to the active project folder
	 * (works for BOTH local and cloud folders):
	 *  - Pick from discovered historical sessions belonging to this project (strictly excluding ADE role sessions),
	 *  - Attach an existing session by Engine + Session ID or Name (`sessionsService.attach`),
	 *  - Or open an installed local Coding Agent extension panel.
	 */
	async addExistingNativeSession(): Promise<void> {
		const project = this.resolveActiveProject();
		if (!project || !this.sessionsService) {
			return;
		}
		const isRemote = isCloudProjectUri(project.uri);
		const engines = await this.resolveEnginesForProject(project.uri, isRemote && this.discoveredEngines.length === 0);
		if (!engines) {
			return;
		}
		const remoteHost = isRemote ? project.uri.authority : undefined;
		const excluded = this.collectAdeExcludedResources();

		// Strictly scope discovery to the active project folder ONLY (never pull unrelated sibling projects or host-wide sessions).
		const candidateBatches = await Promise.all(
			engines.map(async engine => {
				const folderSessions = await this.sessionsService!.list(engine.id, project.uri).catch(() => [] as readonly IAdeEngineSession[]);
				return folderSessions.map((s): IIdeNativeSessionItem => ({
					engineId: engine.id,
					engineName: engine.name,
					resource: s.resource,
					projectUri: s.projectUri,
					label: s.label,
					updated: s.updated ?? 0,
					remoteHost,
				}));
			}),
		);
		const scannedProjectSessions = candidateBatches.flat();
		if (scannedProjectSessions.length > 0) {
			this.allSessions = scannedProjectSessions;
			this.lastScannedProjectKey = normalizeIdeProjectKey(project.uri);
			this.renderEngineFilters();
			this.renderSessionList();
		}
		const pureCandidates = filterPureNativeIdeSessions(scannedProjectSessions, excluded);

		type AddPick =
			| (IQuickPickItem & { readonly kind: 'session'; readonly session: IIdeNativeSessionItem })
			| (IQuickPickItem & { readonly kind: 'attachById' })
			| IIdeInstalledAgentExtensionPick;

		const items: Array<AddPick | IQuickPickSeparator> = [];

		if (this.sessionsService.attach && engines.length > 0) {
			items.push({
				kind: 'attachById',
				label: `$(plug) ${localize('ideAttachByIdLabel', "Attach Existing Session by ID or Name...")}`,
				description: isRemote
					? localize('ideAttachCloudByIdDesc', "Connect to an existing CLI session in {0} on {1}", project.name, project.uri.authority)
					: localize('ideAttachLocalByIdDesc', "Connect to an existing local CLI session in {0} by ID or name", project.name),
			});
		}

		if (pureCandidates.length > 0) {
			items.push({ type: 'separator', label: localize('ideExistingProjectSessionsSeparator', "Existing Sessions in {0}", project.name) });
			for (const session of pureCandidates) {
				const icon = this.sessionsService.getIcon(session.engineId);
				const rel = formatRelativeTime(session.updated);
				const descParts = [session.engineName];
				if (rel) {
					descParts.push(rel);
				}
				items.push({
					kind: 'session',
					session,
					label: session.label,
					description: descParts.join(' · '),
					iconClass: ThemeIcon.isThemeIcon(icon) ? ThemeIcon.asClassName(icon) : undefined,
					iconPath: URI.isUri(icon) ? { dark: icon, light: icon } : undefined,
				});
			}
		}

		if (!isRemote) {
			const extPicks = await this.collectInstalledCodingAgentExtensions();
			if (extPicks.length > 0) {
				items.push({ type: 'separator', label: localize('ideInstalledAgentExtensionsSeparator', "Installed Agent Extensions") });
				items.push(...extPicks);
			}
		}

		if (items.length === 0) {
			this.notificationService.warn(localize('ideNoAddableSessions', "No existing native sessions or Agent engines found for {0}.", formatProjectLocation(project.uri)));
			return;
		}

		const picked = await this.quickInputService.pick(items, {
			placeHolder: isRemote
				? localize('ideAddCloudSessionPlaceholder', "Add or attach a session for '{0}' on '{1}' (Pure Native)", project.name, project.uri.authority)
				: localize('ideAddLocalSessionPlaceholder', "Add or attach a local session for '{0}' (Pure Native)", project.name),
			matchOnDescription: true,
		});
		if (!picked) {
			return;
		}

		if (picked.kind === 'extension') {
			await this.launchInstalledAgentExtension(picked);
			return;
		}

		if (picked.kind === 'session') {
			const sessionToOpen: IIdeNativeSessionItem = {
				...picked.session,
				updated: picked.session.updated || Date.now(),
			};
			this.rememberAddedSession(project.uri, sessionToOpen);
			this.allSessions = [sessionToOpen, ...this.allSessions.filter(s => s.resource.toString() !== sessionToOpen.resource.toString())];
			this.renderEngineFilters();
			this.renderSessionList();
			await this.openSessionInSidebar(sessionToOpen);
			return;
		}

		// Attach by Session ID or Name
		await this.attachSessionById(project.uri, engines);
	}

	private async attachSessionById(projectUri: URI, engines: readonly IAdeEngine[]): Promise<void> {
		if (!this.sessionsService?.attach || engines.length === 0) {
			return;
		}
		let chosen: IAdeEngine | undefined;
		if (this.activeEngineFilter !== 'all') {
			chosen = engines.find(e => e.id === this.activeEngineFilter);
		}
		if (!chosen && engines.length === 1) {
			chosen = engines[0];
		}
		if (!chosen) {
			const enginePicks: (IQuickPickItem & { readonly engine: IAdeEngine })[] = engines.map(eng => ({
				label: eng.name,
				description: eng.description,
				engine: eng,
				iconClass: ThemeIcon.isThemeIcon(eng.icon) ? ThemeIcon.asClassName(eng.icon) : undefined,
				iconPath: URI.isUri(eng.icon) ? { dark: eng.icon, light: eng.icon } : undefined,
			}));
			const pickedEngine = await this.quickInputService.pick(enginePicks, {
				placeHolder: localize('ideAttachPickEngine', "Choose the Agent engine for the session to attach"),
			});
			chosen = pickedEngine?.engine;
		}
		if (!chosen) {
			return;
		}

		const rawId = await this.quickInputService.input({
			title: localize('ideAttachSessionIdTitle', "Attach Existing {0} Session", chosen.name),
			prompt: localize('ideAttachSessionIdPrompt', "Enter the native session ID (exact or prefix) or custom name on {0}", formatProjectLocation(projectUri)),
			placeHolder: localize('ideAttachSessionIdPlaceholder', "e.g. 5f8a2c10-... or session name"),
		});
		const nativeId = rawId?.trim();
		if (!nativeId) {
			return;
		}

		try {
			const attached = await this.sessionsService.attach(chosen.id, nativeId, projectUri);
			const remoteHost = isCloudProjectUri(projectUri) ? projectUri.authority : undefined;
			const item: IIdeNativeSessionItem = {
				engineId: chosen.id,
				engineName: chosen.name,
				resource: attached.resource,
				projectUri: attached.projectUri,
				label: attached.label,
				updated: attached.updated || Date.now(),
				remoteHost,
			};
			// Strictly do NOT register in IAdeProjectsService — keep 100% pure native & isolated from ADE!
			this.rememberAddedSession(projectUri, item);
			this.allSessions = [item, ...this.allSessions.filter(s => s.resource.toString() !== item.resource.toString())];
			this.renderEngineFilters();
			this.renderSessionList();
			await this.openSessionInSidebar(item);
		} catch (err) {
			this.notificationService.error(localize('ideAttachSessionFailed', "Failed to attach native session: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	async createNewNativeSession(): Promise<void> {
		const project = this.resolveActiveProject();
		if (!project || !this.sessionsService) {
			return;
		}
		const engines = await this.resolveEnginesForProject(project.uri);
		if (!engines) {
			return;
		}
		if (engines.length === 0) {
			this.notificationService.warn(localize('ideNoEnginesAvailable', "No Coding Agent CLI found for {0}.", formatProjectLocation(project.uri)));
			return;
		}

		let chosen: IAdeEngine | undefined;
		if (this.activeEngineFilter !== 'all') {
			chosen = engines.find(e => e.id === this.activeEngineFilter);
		}
		if (!chosen && engines.length === 1) {
			chosen = engines[0];
		}
		if (!chosen) {
			const picks: (IQuickPickItem & { readonly engine: IAdeEngine })[] = engines.map(eng => ({
				label: eng.name,
				description: eng.description,
				engine: eng,
				iconClass: ThemeIcon.isThemeIcon(eng.icon) ? ThemeIcon.asClassName(eng.icon) : undefined,
				iconPath: URI.isUri(eng.icon) ? { dark: eng.icon, light: eng.icon } : undefined,
			}));
			const picked = await this.quickInputService.pick(picks, {
				placeHolder: isCloudProjectUri(project.uri)
					? localize('idePickCloudEngine', "Choose a native Coding Agent on '{0}' (Pure Native, no ADE role)", project.uri.authority)
					: localize('idePickLocalEngine', "Choose a Coding Agent for '{0}' (Pure Native, no ADE role)", project.name),
			});
			chosen = picked?.engine;
		}
		if (!chosen) {
			return;
		}

		try {
			const created = await this.sessionsService.create(chosen.id, project.uri);
			const remoteHost = isCloudProjectUri(project.uri) ? project.uri.authority : undefined;
			const item: IIdeNativeSessionItem = {
				engineId: chosen.id,
				engineName: chosen.name,
				resource: created.resource,
				projectUri: created.projectUri,
				label: created.label,
				updated: created.updated || Date.now(),
				remoteHost,
			};
			// Strictly do NOT register in IAdeProjectsService — keep 100% pure native & isolated from ADE!
			this.allSessions = [item, ...this.allSessions.filter(s => s.resource.toString() !== item.resource.toString())];
			await this.openSessionInSidebar(item);
		} catch (err) {
			this.notificationService.error(localize('ideCreateNativeSessionFailed', "Failed to create native session: {0}", err instanceof Error ? err.message : String(err)));
		}
	}
}
