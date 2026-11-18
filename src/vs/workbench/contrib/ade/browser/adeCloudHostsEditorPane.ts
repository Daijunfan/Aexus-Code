/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, joinPath, removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	AdeCloudHostOs,
	buildCloudProjectUri,
	formatCloudHostTargetLabel,
	IAdeCloudHost,
	IAdeCloudHostBackendService,
	sanitizeSshAlias,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import {
	ADE_ADD_CLOUD_PROJECT_COMMAND_ID,
	ADE_CLOUD_HOSTS_SCHEME,
	IAdeProjectsService,
} from '../common/ade.js';
import { browseRemoteFolderOnCloudHost } from './adeCloudHostFileSystemProvider.js';
import { reconcileIdeWorkspaceWithCatalog } from './adeProjectManagement.js';

export class AdeCloudHostsEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeCloudHosts';
	override readonly resource = URI.from({ scheme: ADE_CLOUD_HOSTS_SCHEME, path: '/manager' });

	private _focusHostTarget: string | undefined;

	constructor(focusHostTarget?: string) {
		super();
		this._focusHostTarget = focusHostTarget;
	}

	get focusHostTarget(): string | undefined {
		return this._focusHostTarget;
	}

	setFocusHostTarget(target: string | undefined): void {
		this._focusHostTarget = target;
	}

	override get typeId(): string {
		return AdeCloudHostsEditorInput.ID;
	}

	override getName(): string {
		return localize('adeCloudHostsEditorTitle', "Cloud Hosts (SSH)");
	}

	override getIcon(): ThemeIcon {
		return Codicon.remote;
	}

	override matches(other: EditorInput): boolean {
		return other instanceof AdeCloudHostsEditorInput;
	}
}

export class AdeCloudHostsEditorSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof AdeCloudHostsEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		return input instanceof AdeCloudHostsEditorInput ? (input.focusHostTarget ?? '') : undefined;
	}

	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput | undefined {
		return instantiationService.createInstance(AdeCloudHostsEditorInput, raw || undefined);
	}
}

interface IDraftCloudHostForm {
	id?: string;
	name: string;
	alias: string;
	hostName: string;
	user: string;
	port: string;
	os: AdeCloudHostOs;
	identityFile: string;
	proxyJump: string;
	strictHostKeyChecking: '' | 'yes' | 'accept-new' | 'no';
	defaultDirectory: string;
	notes: string;
}

function emptyDraftForm(): IDraftCloudHostForm {
	return {
		name: '',
		alias: '',
		hostName: '',
		user: 'ubuntu',
		port: '22',
		os: 'linux',
		identityFile: '',
		proxyJump: '',
		strictHostKeyChecking: 'accept-new',
		defaultDirectory: '',
		notes: '',
	};
}

function hostToDraftForm(host: IAdeCloudHost): IDraftCloudHostForm {
	return {
		id: host.id,
		name: host.name,
		alias: host.alias,
		hostName: host.hostName,
		user: host.user ?? '',
		port: String(host.port || 22),
		os: host.os,
		identityFile: host.identityFile ?? '',
		proxyJump: host.proxyJump ?? '',
		strictHostKeyChecking: host.strictHostKeyChecking ?? '',
		defaultDirectory: host.defaultDirectory ?? '',
		notes: host.notes ?? '',
	};
}

export class AdeCloudHostsEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.adeCloudHosts';

	private rootEl!: HTMLElement;
	private listColEl!: HTMLElement;
	private listItemsEl!: HTMLElement;
	private detailColEl!: HTMLElement;
	private searchInputEl!: HTMLInputElement;

	private readonly renderListDisposables = this._register(new DisposableStore());
	private readonly renderDetailDisposables = this._register(new DisposableStore());

	private hosts: readonly IAdeCloudHost[] = [];
	private selectedHostId: string | '__new__' = '__new__';
	private draft: IDraftCloudHostForm = emptyDraftForm();
	private searchQuery = '';
	private testingHostId: string | undefined;
	private statusBanner: { readonly kind: 'ok' | 'err' | 'info'; readonly text: string } | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAdeCloudHostBackendService private readonly backend: IAdeCloudHostBackendService,
		@IAdeProjectsService private readonly adeProjects: IAdeProjectsService,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IUriIdentityService private readonly uriIdentity: IUriIdentityService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditing: IWorkspaceEditingService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(AdeCloudHostsEditorPane.ID, group, telemetryService, themeService, storageService);
		this._register(this.backend.onDidChangeHosts(() => {
			void this.reloadHosts(false);
		}));
	}

	protected createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.ade-ch-studio'));

		// Left Sidebar: Search + New / Import VS Code + Host List
		this.listColEl = append(this.rootEl, $('.ade-ch-sidebar'));
		const sideTop = append(this.listColEl, $('.ade-ch-sidebar-top'));
		const titleRow = append(sideTop, $('.ade-ch-sidebar-title-row'));
		const ico = append(titleRow, $('span.ade-ch-title-ico'));
		ico.classList.add(...ThemeIcon.asClassNameArray(Codicon.remote));
		append(titleRow, $('span.ade-ch-sidebar-title', {}, localize('adeChStudioHeading', "Cloud Hosts")));

		const topBtns = append(titleRow, $('.ade-ch-sidebar-btns'));
		const importBtn = append(topBtns, $('button.ade-ch-icon-btn', {
			type: 'button',
			title: localize('adeChImportVsCodeTooltip', "Sync / Import Cloud Hosts from VS Code & ~/.ssh/config"),
			'aria-label': localize('adeChImportVsCodeTooltip', "Sync / Import Cloud Hosts from VS Code & ~/.ssh/config"),
		}));
		importBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.sync));
		this._register(addDisposableListener(importBtn, EventType.CLICK, () => {
			void this.handleImportVsCode();
		}));

		const newBtn = append(topBtns, $('button.ade-ch-new-btn', {
			type: 'button',
			title: localize('adeChAddHostBtnTooltip', "Create a new SSH Cloud Host"),
		}));
		const plusIco = append(newBtn, $('span'));
		plusIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		append(newBtn, $('span', {}, localize('adeChNewShortBtn', "New Host")));
		this._register(addDisposableListener(newBtn, EventType.CLICK, () => {
			this.selectedHostId = '__new__';
			this.draft = emptyDraftForm();
			this.statusBanner = undefined;
			this.renderHostList();
			this.renderDetailPane();
		}));

		this.searchInputEl = append(sideTop, $('input.ade-ch-search-input', {
			type: 'search',
			placeholder: localize('adeChSearchPlaceholder', "Filter hosts by alias, IP, or OS..."),
			'aria-label': localize('adeChSearchAriaLabel', "Filter saved Cloud Hosts"),
		})) as HTMLInputElement;
		this._register(addDisposableListener(this.searchInputEl, EventType.INPUT, () => {
			this.searchQuery = this.searchInputEl.value.trim().toLowerCase();
			this.renderHostList();
		}));

		this.listItemsEl = append(this.listColEl, $('.ade-ch-host-list'));

		// Right Main Detail Column: Quick Actions + Host Editor Form + Recent VS Code Folders
		this.detailColEl = append(this.rootEl, $('.ade-ch-detail'));
	}

	override async setInput(input: AdeCloudHostsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this.reloadHosts(true, input.focusHostTarget);
	}

	async focusHost(targetIdOrAlias?: string): Promise<void> {
		await this.reloadHosts(true, targetIdOrAlias);
	}

	private async reloadHosts(resetDraftToSelected: boolean, preferredTarget?: string): Promise<void> {
		this.hosts = await this.backend.listHosts();
		if (preferredTarget) {
			const match = this.hosts.find(h =>
				h.id === preferredTarget
				|| h.alias.toLowerCase() === preferredTarget.toLowerCase()
				|| h.name.toLowerCase() === preferredTarget.toLowerCase(),
			);
			if (match) {
				this.selectedHostId = match.id;
				this.draft = hostToDraftForm(match);
			}
		} else if (this.selectedHostId === '__new__' && resetDraftToSelected && this.hosts.length > 0) {
			this.selectedHostId = this.hosts[0].id;
			this.draft = hostToDraftForm(this.hosts[0]);
		} else if (this.selectedHostId !== '__new__') {
			const current = this.hosts.find(h => h.id === this.selectedHostId);
			if (!current) {
				if (this.hosts.length > 0) {
					this.selectedHostId = this.hosts[0].id;
					this.draft = hostToDraftForm(this.hosts[0]);
				} else {
					this.selectedHostId = '__new__';
					this.draft = emptyDraftForm();
				}
			} else if (resetDraftToSelected) {
				this.draft = hostToDraftForm(current);
			}
		}
		this.renderHostList();
		this.renderDetailPane();
	}

	private async handleImportVsCode(): Promise<void> {
		try {
			const res = await this.backend.importFromVsCodeAndSshConfig();
			this.statusBanner = {
				kind: 'ok',
				text: localize(
					'adeChImportBannerSuccess',
					"Imported & synced {0} total Cloud Host(s) ({1} newly added, {2} updated, {3} recent folders) from VS Code & ~/.ssh/config.",
					res.totalHosts,
					res.importedCount,
					res.updatedCount,
					res.importedRecentFolders,
				),
			};
			await this.reloadHosts(false);
		} catch (err) {
			this.statusBanner = {
				kind: 'err',
				text: err instanceof Error ? err.message : String(err),
			};
			this.renderDetailPane();
		}
	}

	private async addRemoteFolderAsProject(host: IAdeCloudHost, remotePath: string): Promise<void> {
		const uri = buildCloudProjectUri(host.alias, remotePath, host.os);
		const normalized = removeTrailingPathSeparator(uri);
		const folderName = basename(normalized) || host.name;
		this.adeProjects.registerProject(normalized, folderName);
		await this.backend.recordRecentDirectory(host.id, normalized.path);
		await reconcileIdeWorkspaceWithCatalog({
			projects: this.adeProjects,
			contextService: this.contextService,
			workspaceEditing: this.workspaceEditing,
			environmentService: this.environmentService,
			fileService: this.fileService,
			uriIdentity: this.uriIdentity,
		});
		this.adeProjects.selectProject(normalized);
		this.notificationService.info(localize('adeChAddedCloudProjectToast', "Added Cloud Host project '{0}' ({1}:{2}).", folderName, host.alias, normalized.path));
	}

	private async openTerminalOnHost(host: IAdeCloudHost, remotePath?: string): Promise<void> {
		const targetDir = remotePath || host.defaultDirectory || host.recentDirectories[0] || (host.os === 'windows' ? '/C:/' : (host.user ? `/home/${host.user}` : '/'));
		const targetUri = buildCloudProjectUri(host.alias, targetDir, host.os);
		await this.commandService.executeCommand('workbench.action.terminal.new', { cwd: targetUri });
	}

	private renderHostList(): void {
		this.renderListDisposables.clear();
		clearNode(this.listItemsEl);

		const filtered = this.hosts.filter(h => {
			if (!this.searchQuery) {
				return true;
			}
			const hay = `${h.name} ${h.alias} ${h.hostName} ${h.user ?? ''} ${h.os} ${h.proxyJump ?? ''}`.toLowerCase();
			return hay.includes(this.searchQuery);
		});

		if (filtered.length === 0) {
			const empty = append(this.listItemsEl, $('.ade-ch-empty-list'));
			empty.textContent = this.hosts.length === 0
				? localize('adeChNoHostsSaved', "No Cloud Hosts saved yet. Click 'New Host' or sync from VS Code.")
				: localize('adeChNoHostsMatch', "No Cloud Hosts match your filter.");
			return;
		}

		for (const h of filtered) {
			const isSelected = h.id === this.selectedHostId;
			const item = append(this.listItemsEl, $(`button.ade-ch-host-item${isSelected ? '.selected' : ''}`, {
				type: 'button',
				'data-host-alias': h.alias,
			}));

			const topRow = append(item, $('.ade-ch-host-item-top'));
			const statusDotClass = h.lastTestStatus
				? (h.lastTestStatus.ok ? '.ok' : '.err')
				: '';
			append(topRow, $(`span.ade-ch-status-dot${statusDotClass}`));
			append(topRow, $('span.ade-ch-host-name', {}, h.name));
			append(topRow, $(`span.ade-ch-os-pill.os-${h.os}`, {}, h.os === 'windows' ? 'Win' : (h.os === 'macos' ? 'macOS' : 'Linux')));

			const subRow = append(item, $('.ade-ch-host-item-sub'));
			append(subRow, $('span.ade-ch-host-addr', {}, formatCloudHostTargetLabel(h)));
			if (h.proxyJump) {
				append(subRow, $('span.ade-ch-jump-pill', {}, `↪ ${h.proxyJump}`));
			}

			this.renderListDisposables.add(addDisposableListener(item, EventType.CLICK, () => {
				this.selectedHostId = h.id;
				this.draft = hostToDraftForm(h);
				this.statusBanner = undefined;
				this.renderHostList();
				this.renderDetailPane();
			}));
		}
	}

	private renderDetailPane(): void {
		this.renderDetailDisposables.clear();
		clearNode(this.detailColEl);

		const existingHost = this.selectedHostId !== '__new__'
			? this.hosts.find(h => h.id === this.selectedHostId)
			: undefined;

		const header = append(this.detailColEl, $('.ade-ch-detail-header'));
		const titleBlock = append(header, $('.ade-ch-detail-title-block'));
		append(titleBlock, $('h2.ade-ch-detail-title', {}, existingHost
			? `${existingHost.name} (${existingHost.alias})`
			: localize('adeChCreateHostTitle', "New Cloud Host")));
		append(titleBlock, $('div.ade-ch-detail-subtitle', {}, existingHost
			? `${formatCloudHostTargetLabel(existingHost)} · ${existingHost.source === 'vscode' ? localize('adeChSourceVsCode', "Migrated from VS Code") : (existingHost.source === 'ssh-config' ? localize('adeChSourceSsh', "Imported from ~/.ssh/config") : localize('adeChSourceManaged', "Managed by Aexus Code"))}`
			: localize('adeChCreateHostSubtitle', "Configure SSH connection, key authentication, jump host, and default workspace folder.")));

		if (existingHost) {
			const actionsBar = append(header, $('.ade-ch-quick-actions'));

			const addProjBtn = append(actionsBar, $('button.ade-ch-action-btn.primary', {
				type: 'button',
			}));
			const folderIco = append(addProjBtn, $('span'));
			folderIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.folderOpened));
			append(addProjBtn, $('span', {}, localize('adeChBrowseAddProjectBtn', "Add Project Folder...")));
			this.renderDetailDisposables.add(addDisposableListener(addProjBtn, EventType.CLICK, () => {
				void this.commandService.executeCommand(ADE_ADD_CLOUD_PROJECT_COMMAND_ID, existingHost.alias);
			}));

			const termBtn = append(actionsBar, $('button.ade-ch-action-btn.secondary', {
				type: 'button',
			}));
			const termIco = append(termBtn, $('span'));
			termIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.terminal));
			append(termBtn, $('span', {}, localize('adeChOpenTerminalBtn', "Open Terminal")));
			this.renderDetailDisposables.add(addDisposableListener(termBtn, EventType.CLICK, () => {
				void this.openTerminalOnHost(existingHost);
			}));

			const isTesting = this.testingHostId === existingHost.id;
			const testBtn = append(actionsBar, $('button.ade-ch-action-btn.secondary', {
				type: 'button',
				...(isTesting ? { disabled: 'disabled' } : {}),
			}));
			const pulseIco = append(testBtn, $('span'));
			pulseIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.plug));
			append(testBtn, $('span', {}, isTesting
				? localize('adeChTestingBtn', "Testing...")
				: localize('adeChTestConnBtn', "Test Connection")));
			this.renderDetailDisposables.add(addDisposableListener(testBtn, EventType.CLICK, async () => {
				this.testingHostId = existingHost.id;
				this.renderDetailPane();
				try {
					const check = await this.backend.testConnection(existingHost.id);
					this.statusBanner = check.ok
						? {
							kind: 'ok',
							text: localize(
								'adeChConnSuccessMsg',
								"Connected to {0} in {1}ms ({2}{3}).",
								existingHost.name,
								check.latencyMs,
								check.remoteUname ?? existingHost.os,
								check.remoteHome ? ` · Home: ${check.remoteHome}` : '',
							),
						}
						: {
							kind: 'err',
							text: localize('adeChConnFailMsg', "Connection check failed ({0}ms): {1}", check.latencyMs, check.error ?? localize('adeChUnknownSshError', "Unknown SSH error")),
						};
				} catch (err) {
					this.statusBanner = {
						kind: 'err',
						text: err instanceof Error ? err.message : String(err),
					};
				} finally {
					this.testingHostId = undefined;
				}
				await this.reloadHosts(false);
			}));

			const delBtn = append(actionsBar, $('button.ade-ch-action-btn.danger', {
				type: 'button',
				title: localize('adeChDeleteHostTooltip', "Delete Cloud Host"),
			}));
			const trashIco = append(delBtn, $('span'));
			trashIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.trash));
			append(delBtn, $('span', {}, localize('adeChDeleteBtn', "Delete")));
			this.renderDetailDisposables.add(addDisposableListener(delBtn, EventType.CLICK, async () => {
				const boundProjects = this.adeProjects.projects.filter(
					p => p.uri.scheme === 'aexus-ssh' && p.uri.authority.toLowerCase() === existingHost.alias.toLowerCase(),
				);
				const detailText = boundProjects.length > 0
					? localize(
						'adeChConfirmDeleteWithProjectsDetail',
						"This removes the saved Cloud Host entry AND unlinks {0} ADE project(s) bound to {1} ({2}). Your SSH private key files and remote directories on disk are never deleted.",
						boundProjects.length,
						existingHost.alias,
						boundProjects.map(p => p.name).join(', '),
					)
					: localize('adeChConfirmDeleteDetail', "This removes the saved Cloud Host entry from Aexus Code. Your SSH private key files on disk are never deleted.");
				const confirmed = await this.dialogService.confirm({
					type: 'warning',
					message: localize('adeChConfirmDeleteTitle', "Remove Cloud Host '{0}'?", existingHost.name),
					detail: detailText,
					primaryButton: localize('adeChConfirmDeleteBtn', "&&Delete Cloud Host"),
					custom: true,
				});
				if (!confirmed.confirmed) {
					return;
				}
				try {
					const deleted = await this.backend.deleteHost(existingHost.id);
					if (!deleted) {
						this.statusBanner = {
							kind: 'err',
							text: localize('adeChDeleteNotFoundBanner', "Cloud Host '{0}' was already removed.", existingHost.name),
						};
					} else {
						for (const proj of boundProjects) {
							this.adeProjects.unregisterProject(proj.uri);
						}
						this.statusBanner = {
							kind: 'info',
							text: localize('adeChDeletedBanner', "Removed Cloud Host '{0}'.", existingHost.name),
						};
					}
				} catch (err) {
					this.statusBanner = {
						kind: 'err',
						text: err instanceof Error ? err.message : String(err),
					};
				}
				await this.reloadHosts(true);
			}));
		}

		if (this.statusBanner) {
			append(this.detailColEl, $(`div.ade-ch-banner.${this.statusBanner.kind}`, {}, this.statusBanner.text));
		}

		// Form Card
		const scrollBody = append(this.detailColEl, $('.ade-ch-detail-scroll'));
		const formCard = append(scrollBody, $('.ade-ch-form-card'));
		const grid = append(formCard, $('.ade-ch-form-grid'));

		const makeField = (label: string, hint: string, fullWidth = false): HTMLElement => {
			const wrap = append(grid, $(`div.ade-ch-field${fullWidth ? '.full' : ''}`));
			append(wrap, $('label.ade-ch-label', {}, label));
			if (hint) {
				append(wrap, $('div.ade-ch-hint', {}, hint));
			}
			return wrap;
		};

		// 1. Display Name & SSH Alias
		const nameWrap = makeField(localize('adeChFieldName', "Display Name"), localize('adeChFieldNameHint', "Shown in Projects & Cloud Host lists"));
		const nameInput = append(nameWrap, $('input.ade-ch-input', {
			type: 'text',
			placeholder: 'GPU-server',
			value: this.draft.name,
		})) as HTMLInputElement;

		const aliasWrap = makeField(localize('adeChFieldAlias', "SSH Host Alias"), localize('adeChFieldAliasHint', "Used in aexus-ssh://<alias>/path & ssh <alias>"));
		const aliasInput = append(aliasWrap, $('input.ade-ch-input', {
			type: 'text',
			placeholder: 'GPU-server',
			value: this.draft.alias,
		})) as HTMLInputElement;

		this.renderDetailDisposables.add(addDisposableListener(nameInput, EventType.INPUT, () => {
			const prevAutoAlias = sanitizeSshAlias(this.draft.name);
			this.draft.name = nameInput.value;
			if (!this.draft.alias || this.draft.alias === prevAutoAlias) {
				this.draft.alias = sanitizeSshAlias(nameInput.value);
				aliasInput.value = this.draft.alias;
			}
		}));
		this.renderDetailDisposables.add(addDisposableListener(aliasInput, EventType.INPUT, () => {
			this.draft.alias = aliasInput.value;
		}));

		// 2. HostName / IP, User, Port, OS
		const hostWrap = makeField(localize('adeChFieldHostName', "HostName / IP Address"), localize('adeChFieldHostNameHint', "IPv4, IPv6, or domain (e.g. 203.0.113.10)"));
		const hostInput = append(hostWrap, $('input.ade-ch-input', {
			type: 'text',
			placeholder: '203.0.113.10',
			value: this.draft.hostName,
		})) as HTMLInputElement;
		this.renderDetailDisposables.add(addDisposableListener(hostInput, EventType.INPUT, () => {
			this.draft.hostName = hostInput.value;
		}));

		const userWrap = makeField(localize('adeChFieldUser', "SSH Username"), localize('adeChFieldUserHint', "Login user (e.g. ubuntu, root, djf)"));
		const userInput = append(userWrap, $('input.ade-ch-input', {
			type: 'text',
			placeholder: 'ubuntu',
			value: this.draft.user,
		})) as HTMLInputElement;
		this.renderDetailDisposables.add(addDisposableListener(userInput, EventType.INPUT, () => {
			this.draft.user = userInput.value;
		}));

		const portWrap = makeField(localize('adeChFieldPort', "SSH Port"), localize('adeChFieldPortHint', "Default 22"));
		const portInput = append(portWrap, $('input.ade-ch-input', {
			type: 'number',
			min: '1',
			max: '65535',
			value: this.draft.port,
		})) as HTMLInputElement;
		this.renderDetailDisposables.add(addDisposableListener(portInput, EventType.INPUT, () => {
			this.draft.port = portInput.value;
		}));

		const osWrap = makeField(localize('adeChFieldOs', "Remote OS Platform"), localize('adeChFieldOsHint', "Selects POSIX shell vs Windows PowerShell"));
		const osSelect = append(osWrap, $('select.ade-ch-select')) as HTMLSelectElement;
		for (const opt of [
			{ value: 'linux', label: 'Linux' },
			{ value: 'macos', label: 'macOS' },
			{ value: 'windows', label: 'Windows (OpenSSH)' },
		] as const) {
			const optEl = append(osSelect, $('option', { value: opt.value }, opt.label)) as HTMLOptionElement;
			optEl.selected = this.draft.os === opt.value;
		}
		this.renderDetailDisposables.add(addDisposableListener(osSelect, EventType.CHANGE, () => {
			this.draft.os = osSelect.value as AdeCloudHostOs;
		}));

		// 3. IdentityFile (with Browse button) & ProxyJump
		const keyWrap = makeField(
			localize('adeChFieldIdentityFile', "SSH Private Key (IdentityFile)"),
			localize('adeChFieldIdentityFileHint', "Leave blank to use default SSH agent / ~/.ssh keys"),
			true,
		);
		const keyRow = append(keyWrap, $('.ade-ch-inline-row'));
		const keyInput = append(keyRow, $('input.ade-ch-input', {
			type: 'text',
			placeholder: '~/.ssh/id_ed25519',
			value: this.draft.identityFile,
		})) as HTMLInputElement;
		this.renderDetailDisposables.add(addDisposableListener(keyInput, EventType.INPUT, () => {
			this.draft.identityFile = keyInput.value;
		}));
		const browseKeyBtn = append(keyRow, $('button.ade-ch-action-btn.secondary', {
			type: 'button',
		}, localize('adeChBrowseKeyBtn', "Browse...")));
		this.renderDetailDisposables.add(addDisposableListener(browseKeyBtn, EventType.CLICK, async () => {
			const home = await this.fileDialogService.defaultFolderPath(Schemas.file);
			const picked = await this.fileDialogService.showOpenDialog({
				title: localize('adeChBrowseKeyDialogTitle', "Select SSH Private Key"),
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				defaultUri: home ? joinPath(home, '.ssh') : undefined,
			});
			if (picked?.[0]) {
				this.draft.identityFile = picked[0].fsPath;
				keyInput.value = picked[0].fsPath;
			}
		}));

		const jumpWrap = makeField(localize('adeChFieldProxyJump', "ProxyJump / Bastion Host"), localize('adeChFieldProxyJumpHint', "Optional jump host alias (e.g. GPU-server)"));
		const jumpInput = append(jumpWrap, $('input.ade-ch-input', {
			type: 'text',
			placeholder: localize('adeChNoProxyJumpPh', "Direct connection (none)"),
			value: this.draft.proxyJump,
		})) as HTMLInputElement;
		this.renderDetailDisposables.add(addDisposableListener(jumpInput, EventType.INPUT, () => {
			this.draft.proxyJump = jumpInput.value;
		}));

		const strictWrap = makeField(localize('adeChFieldHostKeyPolicy', "Host Key Verification"), localize('adeChFieldHostKeyPolicyHint', "OpenSSH StrictHostKeyChecking policy"));
		const strictSelect = append(strictWrap, $('select.ade-ch-select')) as HTMLSelectElement;
		for (const opt of [
			{ value: '', label: localize('adeChHostKeyDefault', "Inherit ~/.ssh/config default") },
			{ value: 'accept-new', label: 'accept-new (Recommended)' },
			{ value: 'yes', label: 'yes (Strict)' },
			{ value: 'no', label: 'no (Lab / Ephemeral VMs)' },
		] as const) {
			const optEl = append(strictSelect, $('option', { value: opt.value }, opt.label)) as HTMLOptionElement;
			optEl.selected = this.draft.strictHostKeyChecking === opt.value;
		}
		this.renderDetailDisposables.add(addDisposableListener(strictSelect, EventType.CHANGE, () => {
			this.draft.strictHostKeyChecking = strictSelect.value as IDraftCloudHostForm['strictHostKeyChecking'];
		}));

		// 4. Default Project Directory & Notes
		const dirWrap = makeField(
			localize('adeChFieldDefaultDir', "Default Remote Project Directory"),
			localize('adeChFieldDefaultDirHint', "Initial directory when browsing projects or opening a Cloud Host terminal"),
			true,
		);
		const dirRow = append(dirWrap, $('.ade-ch-inline-row'));
		const dirInput = append(dirRow, $('input.ade-ch-input', {
			type: 'text',
			placeholder: this.draft.os === 'windows' ? '/C:/Users/Administrator' : '/home/ubuntu/develop',
			value: this.draft.defaultDirectory,
		})) as HTMLInputElement;
		this.renderDetailDisposables.add(addDisposableListener(dirInput, EventType.INPUT, () => {
			this.draft.defaultDirectory = dirInput.value;
		}));
		if (existingHost) {
			const browseDirBtn = append(dirRow, $('button.ade-ch-action-btn.secondary', {
				type: 'button',
			}, localize('adeChBrowseRemoteDirBtn', "Browse Remote...")));
			this.renderDetailDisposables.add(addDisposableListener(browseDirBtn, EventType.CLICK, async () => {
				const pickedUri = await this.instantiationService.invokeFunction(acc => browseRemoteFolderOnCloudHost(acc, existingHost));
				if (pickedUri) {
					this.draft.defaultDirectory = pickedUri.path;
					dirInput.value = pickedUri.path;
				}
			}));
		}

		const notesWrap = makeField(localize('adeChFieldNotes', "Notes (Optional)"), '', true);
		const notesInput = append(notesWrap, $('input.ade-ch-input', {
			type: 'text',
			placeholder: localize('adeChNotesPh', "Optional environment or GPU notes..."),
			value: this.draft.notes,
		})) as HTMLInputElement;
		this.renderDetailDisposables.add(addDisposableListener(notesInput, EventType.INPUT, () => {
			this.draft.notes = notesInput.value;
		}));

		const saveFooter = append(formCard, $('.ade-ch-form-footer'));
		const resetFormBtn = append(saveFooter, $('button.ade-ch-action-btn.secondary', {
			type: 'button',
		}, localize('adeChRevertChangesBtn', "Revert")));
		this.renderDetailDisposables.add(addDisposableListener(resetFormBtn, EventType.CLICK, () => {
			this.draft = existingHost ? hostToDraftForm(existingHost) : emptyDraftForm();
			this.renderDetailPane();
		}));

		const saveBtn = append(saveFooter, $('button.ade-ch-action-btn.primary.save-btn', {
			type: 'button',
		}));
		const checkIco = append(saveBtn, $('span'));
		checkIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.save));
		append(saveBtn, $('span', {}, existingHost
			? localize('adeChSaveChangesBtn', "Save Cloud Host")
			: localize('adeChCreateSaveBtn', "Create & Save Cloud Host")));
		this.renderDetailDisposables.add(addDisposableListener(saveBtn, EventType.CLICK, async () => {
			try {
				const parsedPort = Number(this.draft.port) || 22;
				const previousAlias = existingHost?.alias;
				const saved = await this.backend.upsertHost({
					id: existingHost?.id,
					name: this.draft.name.trim() || this.draft.hostName.trim(),
					alias: this.draft.alias.trim() || this.draft.name.trim() || this.draft.hostName.trim(),
					hostName: this.draft.hostName.trim(),
					user: this.draft.user.trim() || undefined,
					port: parsedPort,
					os: this.draft.os,
					identityFile: this.draft.identityFile,
					proxyJump: this.draft.proxyJump,
					strictHostKeyChecking: this.draft.strictHostKeyChecking || undefined,
					defaultDirectory: this.draft.defaultDirectory,
					notes: this.draft.notes,
				});
				if (previousAlias && previousAlias.toLowerCase() !== saved.alias.toLowerCase()) {
					this.adeProjects.migrateCloudHostAlias?.(previousAlias, saved.alias);
				}
				this.selectedHostId = saved.id;
				this.draft = hostToDraftForm(saved);
				this.statusBanner = {
					kind: 'ok',
					text: localize('adeChSavedHostMsg', "Saved Cloud Host '{0}' ({1}).", saved.name, formatCloudHostTargetLabel(saved)),
				};
				await this.reloadHosts(false);
			} catch (err) {
				this.statusBanner = {
					kind: 'err',
					text: err instanceof Error ? err.message : String(err),
				};
				this.renderDetailPane();
			}
		}));

		// 5. Recent & VS Code Migrated Remote Project Folders for 1-click Workspace Add or Terminal Open!
		if (existingHost && existingHost.recentDirectories.length > 0) {
			const recentCard = append(scrollBody, $('.ade-ch-recent-card'));
			append(recentCard, $('div.ade-ch-recent-heading', {}, localize('adeChRecentFoldersTitle', "Recent & VS Code Project Folders on {0}", existingHost.name)));
			for (const folderPath of existingHost.recentDirectories) {
				const row = append(recentCard, $('.ade-ch-recent-row'));
				const fIco = append(row, $('span.ade-ch-recent-ico'));
				fIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.folder));
				append(row, $('span.ade-ch-recent-path', {}, `${existingHost.alias}:${folderPath}`));

				const rowBtns = append(row, $('.ade-ch-recent-btns'));
				const openTermSmall = append(rowBtns, $('button.ade-ch-mini-btn', {
					type: 'button',
					title: localize('adeChOpenFolderTerminalTooltip', "Open SSH Terminal in {0}", folderPath),
				}, localize('adeChMiniTerminalBtn', "Terminal")));
				this.renderDetailDisposables.add(addDisposableListener(openTermSmall, EventType.CLICK, () => {
					void this.openTerminalOnHost(existingHost, folderPath);
				}));

				const addWsSmall = append(rowBtns, $('button.ade-ch-mini-btn.primary', {
					type: 'button',
					title: localize('adeChAddFolderToProjectsTooltip', "Add {0}:{1} to Projects", existingHost.alias, folderPath),
				}, localize('adeChMiniAddProjectBtn', "+ Add Project")));
				this.renderDetailDisposables.add(addDisposableListener(addWsSmall, EventType.CLICK, () => {
					void this.addRemoteFolderAsProject(existingHost, folderPath);
				}));
			}
		}
	}

	override focus(): void {
		this.searchInputEl?.focus();
	}

	layout(dimension: Dimension): void {
		this.rootEl.style.width = `${dimension.width}px`;
		this.rootEl.style.height = `${dimension.height}px`;
	}
}
