/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/adeCloudHosts.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType, getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { toAction } from '../../../../base/common/actions.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, joinPath, removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	AdeCloudHostOs,
	AdeOsIconKind,
	buildCloudProjectUri,
	IAdeCloudHost,
	IAdeCloudHostBackendService,
	resolveAdeOsIconKind,
	resolveInitialCloudHostDirectory,
	sanitizeSshAlias,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import { renderAdeOsIcon } from '../../../browser/adeOsIcon.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
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

//#region Pure view-model helpers (exported for unit tests)

export interface IDraftCloudHostForm {
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

export function emptyDraftForm(): IDraftCloudHostForm {
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

export function hostToDraftForm(host: IAdeCloudHost): IDraftCloudHostForm {
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

export function isDraftFormEqual(a: IDraftCloudHostForm, b: IDraftCloudHostForm): boolean {
	return a.name === b.name
		&& a.alias === b.alias
		&& a.hostName === b.hostName
		&& a.user === b.user
		&& a.port === b.port
		&& a.os === b.os
		&& a.identityFile === b.identityFile
		&& a.proxyJump === b.proxyJump
		&& a.strictHostKeyChecking === b.strictHostKeyChecking
		&& a.defaultDirectory === b.defaultDirectory
		&& a.notes === b.notes;
}

export type AdeCloudHostStatus = 'ok' | 'err' | 'untested';
export type AdeCloudHostLatencyTier = 'good' | 'warn' | 'bad' | 'none';
export type AdeCloudHostOsFilter = 'all' | AdeCloudHostOs;
export type AdeCloudHostStatusFilter = 'all' | AdeCloudHostStatus;
export type AdeCloudHostSort = 'name' | 'latency' | 'checked';
export type AdeCloudHostView = 'grid' | 'list';

export const ADE_CLOUD_HOST_STALE_CHECK_MS = 24 * 60 * 60 * 1000;
export const ADE_CLOUD_HOST_MAX_PROJECT_CHIPS = 3;

export function getCloudHostStatus(host: Pick<IAdeCloudHost, 'lastTestStatus'>): AdeCloudHostStatus {
	if (!host.lastTestStatus) {
		return 'untested';
	}
	return host.lastTestStatus.ok ? 'ok' : 'err';
}

/** `ok && <80ms` good · `ok && <250ms` warn · `ok && >=250ms` or failed: bad · never tested: none. */
export function getCloudHostLatencyTier(host: Pick<IAdeCloudHost, 'lastTestStatus'>): AdeCloudHostLatencyTier {
	const check = host.lastTestStatus;
	if (!check) {
		return 'none';
	}
	if (!check.ok) {
		return 'bad';
	}
	if (check.latencyMs < 80) {
		return 'good';
	}
	return check.latencyMs < 250 ? 'warn' : 'bad';
}

export function isCloudHostCheckStale(host: Pick<IAdeCloudHost, 'lastTestStatus'>, now: number = Date.now()): boolean {
	return !!host.lastTestStatus && now - host.lastTestStatus.checkedAt > ADE_CLOUD_HOST_STALE_CHECK_MS;
}

/** Always includes the port so the badge is a copy-ready `user@host:port` target. */
export function formatCloudHostTargetBadge(host: Pick<IAdeCloudHost, 'user' | 'hostName' | 'port'>): string {
	const userPrefix = host.user ? `${host.user}@` : '';
	return `${userPrefix}${host.hostName}:${host.port || 22}`;
}

export function parseProxyJumpChain(proxyJump: string | undefined): string[] {
	if (!proxyJump) {
		return [];
	}
	return proxyJump.split(',').map(hop => hop.trim()).filter(hop => hop.length > 0);
}

function quoteShellArg(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Builds the live `ssh` command preview shown in the drawer and copied from cards. */
export function buildSshCommandPreview(draft: Pick<IDraftCloudHostForm, 'hostName' | 'user' | 'port' | 'identityFile' | 'proxyJump' | 'strictHostKeyChecking'>): string {
	const parts = ['ssh'];
	const port = Number(draft.port);
	if (port && port !== 22) {
		parts.push('-p', String(port));
	}
	const jump = parseProxyJumpChain(draft.proxyJump);
	if (jump.length) {
		parts.push('-J', quoteShellArg(jump.join(',')));
	}
	const identity = draft.identityFile.trim();
	if (identity) {
		parts.push('-i', quoteShellArg(identity));
	}
	if (draft.strictHostKeyChecking) {
		parts.push('-o', `StrictHostKeyChecking=${draft.strictHostKeyChecking}`);
	}
	const hostName = draft.hostName.trim() || '<host>';
	const user = draft.user.trim();
	parts.push(quoteShellArg(user ? `${user}@${hostName}` : hostName));
	return parts.join(' ');
}

export function hostToSshCommand(host: IAdeCloudHost): string {
	return buildSshCommandPreview(hostToDraftForm(host));
}

export interface IAdeCloudHostKpis {
	readonly total: number;
	readonly connected: number;
	readonly failing: number;
	readonly untested: number;
	readonly avgLatencyMs: number | undefined;
	readonly p95LatencyMs: number | undefined;
	readonly importedFromVsCode: number;
	readonly importedFromSshConfig: number;
}

export function computeCloudHostKpis(hosts: readonly IAdeCloudHost[]): IAdeCloudHostKpis {
	const latencies: number[] = [];
	let connected = 0;
	let failing = 0;
	let untested = 0;
	let importedFromVsCode = 0;
	let importedFromSshConfig = 0;
	for (const host of hosts) {
		const status = getCloudHostStatus(host);
		if (status === 'ok') {
			connected++;
			latencies.push(host.lastTestStatus!.latencyMs);
		} else if (status === 'err') {
			failing++;
		} else {
			untested++;
		}
		if (host.source === 'vscode') {
			importedFromVsCode++;
		} else if (host.source === 'ssh-config') {
			importedFromSshConfig++;
		}
	}
	latencies.sort((a, b) => a - b);
	const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : undefined;
	const p95LatencyMs = latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : undefined;
	return { total: hosts.length, connected, failing, untested, avgLatencyMs, p95LatencyMs, importedFromVsCode, importedFromSshConfig };
}

export function countCloudHostsByOs(hosts: readonly IAdeCloudHost[]): Record<AdeCloudHostOsFilter, number> {
	const counts: Record<AdeCloudHostOsFilter, number> = { all: hosts.length, linux: 0, macos: 0, windows: 0 };
	for (const host of hosts) {
		counts[host.os]++;
	}
	return counts;
}

export function countCloudHostsByStatus(hosts: readonly IAdeCloudHost[]): Record<AdeCloudHostStatusFilter, number> {
	const counts: Record<AdeCloudHostStatusFilter, number> = { all: hosts.length, ok: 0, err: 0, untested: 0 };
	for (const host of hosts) {
		counts[getCloudHostStatus(host)]++;
	}
	return counts;
}

export interface IAdeCloudHostQuery {
	readonly text: string;
	readonly os: AdeCloudHostOsFilter;
	readonly status: AdeCloudHostStatusFilter;
	readonly sort: AdeCloudHostSort;
}

export function filterAndSortCloudHosts(hosts: readonly IAdeCloudHost[], query: IAdeCloudHostQuery): IAdeCloudHost[] {
	const text = query.text.trim().toLowerCase();
	const filtered = hosts.filter(host => {
		if (query.os !== 'all' && host.os !== query.os) {
			return false;
		}
		if (query.status !== 'all' && getCloudHostStatus(host) !== query.status) {
			return false;
		}
		if (!text) {
			return true;
		}
		const hay = `${host.name} ${host.alias} ${host.hostName} ${host.user ?? ''} ${host.os} ${host.proxyJump ?? ''} ${host.notes ?? ''}`.toLowerCase();
		return hay.includes(text);
	});
	const byName = (a: IAdeCloudHost, b: IAdeCloudHost) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
	switch (query.sort) {
		case 'latency':
			// Connected hosts by ascending latency, then failing, then untested.
			return filtered.sort((a, b) => {
				const rank = (h: IAdeCloudHost) => getCloudHostStatus(h) === 'ok' ? 0 : getCloudHostStatus(h) === 'err' ? 1 : 2;
				return rank(a) - rank(b)
					|| (a.lastTestStatus?.ok && b.lastTestStatus?.ok ? a.lastTestStatus.latencyMs - b.lastTestStatus.latencyMs : 0)
					|| byName(a, b);
			});
		case 'checked':
			return filtered.sort((a, b) => (b.lastTestStatus?.checkedAt ?? 0) - (a.lastTestStatus?.checkedAt ?? 0) || byName(a, b));
		default:
			return filtered.sort(byName);
	}
}

//#endregion

interface ICardRefs {
	readonly host: IAdeCloudHost;
	readonly el: HTMLElement;
	latencyBadgeEl: HTMLElement;
	readonly testBtn: HTMLButtonElement;
	readonly focusRoles: ReadonlyMap<string, HTMLElement>;
}

function collectDrawerFocusables(container: HTMLElement, out: HTMLElement[] = []): HTMLElement[] {
	for (let i = 0; i < container.children.length; i++) {
		const child = container.children[i];
		if (!isHTMLElement(child)) {
			continue;
		}
		const tag = child.tagName;
		const isControl = (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') && !(child as HTMLButtonElement).disabled && child.tabIndex !== -1;
		if (isControl || child.getAttribute('tabindex') === '0') {
			if (child.offsetParent !== null || child === getActiveElement()) {
				out.push(child);
			}
		}
		collectDrawerFocusables(child, out);
	}
	return out;
}

interface IDrawerState {
	readonly hostId: string | undefined;
	readonly baseline: IDraftCloudHostForm;
	draft: IDraftCloudHostForm;
	externalChange: boolean;
}

const VIEW_STORAGE_KEY = 'ade.cloudHosts.view';
const SORT_STORAGE_KEY = 'ade.cloudHosts.sort';
const FLASH_DURATION_MS = 1600;
const BANNER_AUTO_DISMISS_MS = 6000;
const TEST_ALL_CONCURRENCY = 3;

export class AdeCloudHostsEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.adeCloudHosts';

	private rootEl!: HTMLElement;
	private searchInputEl!: HTMLInputElement;
	private sortSelectEl!: HTMLSelectElement;
	private kpiEls!: Record<'total' | 'connected' | 'latency' | 'imported', { value: HTMLElement; meta: HTMLElement }>;
	private osChipEls = new Map<AdeCloudHostOsFilter, { el: HTMLElement; count: HTMLElement }>();
	private statusChipEls = new Map<AdeCloudHostStatusFilter, { el: HTMLElement; count: HTMLElement }>();
	private viewBtnEls = new Map<AdeCloudHostView, HTMLElement>();
	private bannerHostEl!: HTMLElement;
	private gridEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private drawerEl!: HTMLElement;
	private drawerScrimEl!: HTMLElement;
	private drawerTitleEl!: HTMLElement;
	private drawerSubEl!: HTMLElement;
	private drawerBodyEl!: HTMLElement;
	private drawerFootEl!: HTMLElement;
	private drawerNoticeEl!: HTMLElement;
	private sshPreviewEl: HTMLElement | undefined;
	private dirtyDotEl: HTMLElement | undefined;
	private drawerTestBtn: HTMLButtonElement | undefined;
	private drawerFirstInputEl: HTMLInputElement | undefined;
	private drawerAliasInputEl: HTMLInputElement | undefined;

	private readonly renderGridDisposables = this._register(new DisposableStore());
	private readonly drawerDisposables = this._register(new DisposableStore());
	private readonly bannerDisposables = this._register(new DisposableStore());
	private readonly bannerTimer = this._register(new MutableDisposable());
	private readonly flashTimers = this._register(new DisposableStore());

	private hosts: readonly IAdeCloudHost[] = [];
	private readonly cards = new Map<string, ICardRefs>();
	private selectedHostId: string | undefined;
	private query: { text: string; os: AdeCloudHostOsFilter; status: AdeCloudHostStatusFilter; sort: AdeCloudHostSort } = { text: '', os: 'all', status: 'all', sort: 'name' };
	private view: AdeCloudHostView = 'grid';
	private readonly testingIds = new Set<string>();
	private readonly flashStates = new Map<string, 'ok' | 'err'>();
	private drawer: IDrawerState | undefined;
	private drawerReturnFocus: HTMLElement | undefined;
	private statusBanner: { readonly kind: 'ok' | 'err' | 'info'; readonly text: string } | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly chStorage: IStorageService,
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
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super(AdeCloudHostsEditorPane.ID, group, telemetryService, themeService, chStorage);
		const storedView = chStorage.get(VIEW_STORAGE_KEY, StorageScope.PROFILE);
		this.view = storedView === 'list' ? 'list' : 'grid';
		const storedSort = chStorage.get(SORT_STORAGE_KEY, StorageScope.PROFILE);
		this.query.sort = storedSort === 'latency' || storedSort === 'checked' ? storedSort : 'name';
		this._register(this.backend.onDidChangeHosts(() => {
			void this.reloadHosts();
		}));
	}

	//#region Skeleton

	protected createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.ade-ch-studio.ade-ch-console', { 'data-view': this.view }));
		this.createHeader(append(this.rootEl, $('header.ade-ch-header')));
		this.createKpiStrip(append(this.rootEl, $('section.ade-ch-kpi-strip', {
			role: 'list',
			'aria-label': localize('adeChKpiAria', "Cloud Host fleet summary"),
		})));
		this.createToolbar(append(this.rootEl, $('.ade-ch-toolbar')));
		this.bannerHostEl = append(this.rootEl, $('.ade-ch-banner-host'));

		const main = append(this.rootEl, $('.ade-ch-main'));
		this.gridEl = append(main, $('.ade-ch-grid', {
			role: 'list',
			'aria-label': localize('adeChGridAria', "Saved Cloud Hosts"),
		}));
		this.emptyEl = append(main, $('.ade-ch-empty'));

		this.drawerScrimEl = append(this.rootEl, $('.ade-ch-drawer-scrim'));
		this._register(addDisposableListener(this.drawerScrimEl, EventType.CLICK, () => this.closeDrawer()));
		this.createDrawerShell();

		this._register(addDisposableListener(this.rootEl, EventType.KEY_DOWN, e => this.onRootKeyDown(e)));
		this.renderAll();
	}

	private createIcon(parent: HTMLElement, icon: ThemeIcon, className = ''): HTMLElement {
		const el = append(parent, $(`span${className}`, { 'aria-hidden': 'true' }));
		el.classList.add(...ThemeIcon.asClassNameArray(icon));
		return el;
	}

	private createButton(parent: HTMLElement, className: string, label: string | undefined, icon: ThemeIcon | undefined, onClick: (e: MouseEvent) => void, store: DisposableStore | undefined = undefined, title?: string): HTMLButtonElement {
		const btn = append(parent, $(`button${className}`, { type: 'button' })) as HTMLButtonElement;
		if (icon) {
			this.createIcon(btn, icon, '.ade-ch-btn-ico');
		}
		if (label) {
			append(btn, $('span.ade-ch-btn-label', {}, label));
		}
		if (title) {
			btn.title = title;
			if (!label) {
				btn.setAttribute('aria-label', title);
			}
		}
		const listener = addDisposableListener(btn, EventType.CLICK, (e: MouseEvent) => onClick(e));
		if (store) {
			store.add(listener);
		} else {
			this._register(listener);
		}
		return btn;
	}

	private createHeader(header: HTMLElement): void {
		const title = append(header, $('.ade-ch-header-title'));
		this.createIcon(title, Codicon.remoteExplorer, '.ade-ch-header-ico');
		const titles = append(title, $('.ade-ch-header-titles'));
		append(titles, $('h1.ade-ch-h1', {}, localize('adeChStudioTitle', "Cloud Host Studio")));
		append(titles, $('span.ade-ch-header-sub', {}, localize('adeChStudioSub', "SSH servers, jump hosts and remote projects in one console")));

		const actions = append(header, $('.ade-ch-header-actions'));
		this.createButton(actions, '.ade-ch-btn.ghost.ade-ch-test-all', localize('adeChTestAll', "Test All"), Codicon.pulse, () => void this.testAllHosts(), undefined, localize('adeChTestAllTooltip', "Test every visible Cloud Host ({0} at a time)", TEST_ALL_CONCURRENCY));
		this.createButton(actions, '.ade-ch-btn.ghost.ade-ch-import', localize('adeChImportVsCode', "Import from VS Code"), Codicon.sync, () => void this.handleImportVsCode(), undefined, localize('adeChImportVsCodeTooltip', "Sync / Import Cloud Hosts from VS Code & ~/.ssh/config"));
		this.createButton(actions, '.ade-ch-btn.primary.ade-ch-new-host', localize('adeChNewShortBtn', "New Host"), Codicon.add, () => this.openDrawer(undefined), undefined, localize('adeChAddHostBtnTooltip', "Create a new SSH Cloud Host"));
	}

	private createKpiStrip(strip: HTMLElement): void {
		const make = (kind: 'total' | 'connected' | 'latency' | 'imported', icon: ThemeIcon, label: string) => {
			const kpi = append(strip, $('.ade-ch-kpi', { role: 'listitem', 'data-kpi': kind }));
			this.createIcon(kpi, icon, '.ade-ch-kpi-ico');
			const value = append(kpi, $('span.ade-ch-kpi-value'));
			append(kpi, $('span.ade-ch-kpi-label', {}, label));
			const meta = append(kpi, $('span.ade-ch-kpi-meta'));
			return { value, meta };
		};
		this.kpiEls = {
			total: make('total', Codicon.server, localize('adeChKpiTotal', "Total Hosts")),
			connected: make('connected', Codicon.passFilled, localize('adeChKpiConnected', "Connected")),
			latency: make('latency', Codicon.pulse, localize('adeChKpiLatency', "Avg Latency")),
			imported: make('imported', Codicon.cloudDownload, localize('adeChKpiImported', "Imported from VS Code")),
		};
	}

	private createToolbar(toolbar: HTMLElement): void {
		const search = append(toolbar, $('label.ade-ch-search'));
		this.createIcon(search, Codicon.search, '.ade-ch-search-ico');
		this.searchInputEl = append(search, $('input.ade-ch-search-input', {
			type: 'search',
			placeholder: localize('adeChSearchPlaceholder', "Filter hosts by alias, IP, or OS..."),
			'aria-label': localize('adeChSearchAriaLabel', "Filter saved Cloud Hosts"),
		})) as HTMLInputElement;
		append(search, $('kbd.ade-ch-kbd', { 'aria-hidden': 'true' }, '/'));
		this._register(addDisposableListener(this.searchInputEl, EventType.INPUT, () => {
			this.query.text = this.searchInputEl.value;
			this.renderGrid();
		}));
		this._register(addDisposableListener(this.searchInputEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const evt = new StandardKeyboardEvent(e);
			if (evt.keyCode === KeyCode.Escape && this.searchInputEl.value) {
				evt.preventDefault();
				evt.stopPropagation();
				this.searchInputEl.value = '';
				this.query.text = '';
				this.renderGrid();
			} else if (evt.keyCode === KeyCode.DownArrow) {
				evt.preventDefault();
				this.focusCardAt(0);
			}
		}));

		const osGroup = append(toolbar, $('.ade-ch-os-filter', { role: 'radiogroup', 'aria-label': localize('adeChOsFilterAria', "Filter by operating system") }));
		const osOptions: ReadonlyArray<{ value: AdeCloudHostOsFilter; label: string }> = [
			{ value: 'all', label: localize('adeChFilterAll', "All") },
			{ value: 'linux', label: localize('adeChOsLinux', "Linux") },
			{ value: 'macos', label: localize('adeChOsMac', "macOS") },
			{ value: 'windows', label: localize('adeChOsWindows', "Windows") },
		];
		for (const option of osOptions) {
			const chip = append(osGroup, $('button.ade-ch-os-chip', { type: 'button', role: 'radio', 'data-os': option.value }));
			append(chip, $('span.ade-ch-chip-label', {}, option.label));
			const count = append(chip, $('span.ade-ch-os-chip-count'));
			this._register(addDisposableListener(chip, EventType.CLICK, () => {
				this.query.os = option.value;
				this.renderGrid();
			}));
			this.osChipEls.set(option.value, { el: chip, count });
		}

		const statusGroup = append(toolbar, $('.ade-ch-status-filter', { role: 'radiogroup', 'aria-label': localize('adeChStatusFilterAria', "Filter by connection status") }));
		const statusOptions: ReadonlyArray<{ value: AdeCloudHostStatusFilter; label: string }> = [
			{ value: 'all', label: localize('adeChStatusAll', "Any status") },
			{ value: 'ok', label: localize('adeChStatusOk', "Connected") },
			{ value: 'err', label: localize('adeChStatusErr', "Failing") },
			{ value: 'untested', label: localize('adeChStatusUntested', "Untested") },
		];
		for (const option of statusOptions) {
			const chip = append(statusGroup, $('button.ade-ch-status-chip', { type: 'button', role: 'radio', 'data-status': option.value }));
			if (option.value !== 'all') {
				append(chip, $('i.ade-ch-status-chip-dot', { 'aria-hidden': 'true' }));
			}
			append(chip, $('span.ade-ch-chip-label', {}, option.label));
			const count = append(chip, $('span.ade-ch-os-chip-count'));
			this._register(addDisposableListener(chip, EventType.CLICK, () => {
				this.query.status = option.value;
				this.renderGrid();
			}));
			this.statusChipEls.set(option.value, { el: chip, count });
		}

		append(toolbar, $('.ade-ch-toolbar-spacer'));

		this.sortSelectEl = append(toolbar, $('select.ade-ch-select.ade-ch-sort', { 'aria-label': localize('adeChSortAria', "Sort Cloud Hosts") })) as HTMLSelectElement;
		const sortOptions: ReadonlyArray<{ value: AdeCloudHostSort; label: string }> = [
			{ value: 'name', label: localize('adeChSortName', "Sort: Name") },
			{ value: 'latency', label: localize('adeChSortLatency', "Sort: Latency") },
			{ value: 'checked', label: localize('adeChSortChecked', "Sort: Last checked") },
		];
		for (const option of sortOptions) {
			const optEl = append(this.sortSelectEl, $('option', { value: option.value }, option.label)) as HTMLOptionElement;
			optEl.selected = option.value === this.query.sort;
		}
		this._register(addDisposableListener(this.sortSelectEl, EventType.CHANGE, () => {
			this.query.sort = this.sortSelectEl.value as AdeCloudHostSort;
			this.chStorage.store(SORT_STORAGE_KEY, this.query.sort, StorageScope.PROFILE, StorageTarget.USER);
			this.renderGrid();
		}));

		const viewToggle = append(toolbar, $('.ade-ch-view-toggle', { role: 'radiogroup', 'aria-label': localize('adeChViewToggleAria', "Layout density") }));
		const viewOptions: ReadonlyArray<{ value: AdeCloudHostView; icon: ThemeIcon; label: string }> = [
			{ value: 'grid', icon: Codicon.layout, label: localize('adeChViewGrid', "Grid view") },
			{ value: 'list', icon: Codicon.listFlat, label: localize('adeChViewList', "List view") },
		];
		for (const option of viewOptions) {
			const btn = this.createButton(viewToggle, '.ade-ch-view-btn', undefined, option.icon, () => this.setView(option.value), undefined, option.label);
			btn.setAttribute('role', 'radio');
			btn.dataset.view = option.value;
			this.viewBtnEls.set(option.value, btn);
		}
	}

	private setView(view: AdeCloudHostView): void {
		if (this.view === view) {
			return;
		}
		this.view = view;
		this.rootEl.dataset.view = view;
		this.chStorage.store(VIEW_STORAGE_KEY, view, StorageScope.PROFILE, StorageTarget.USER);
		this.updateToolbarState();
	}

	//#endregion

	//#region Data

	override async setInput(input: AdeCloudHostsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this.reloadHosts(input.focusHostTarget);
	}

	async focusHost(targetIdOrAlias?: string): Promise<void> {
		await this.reloadHosts(targetIdOrAlias);
	}

	private async reloadHosts(preferredTarget?: string): Promise<void> {
		this.hosts = await this.backend.listHosts();
		if (preferredTarget) {
			const target = preferredTarget.toLowerCase();
			const match = this.hosts.find(h => h.id === preferredTarget || h.alias.toLowerCase() === target || h.name.toLowerCase() === target);
			if (match) {
				this.selectedHostId = match.id;
				if (this.query.os !== 'all' && this.query.os !== match.os) {
					this.query.os = 'all';
				}
				if (this.query.status !== 'all' && this.query.status !== getCloudHostStatus(match)) {
					this.query.status = 'all';
				}
			}
		}
		if (this.selectedHostId && !this.hosts.some(h => h.id === this.selectedHostId)) {
			this.selectedHostId = undefined;
		}
		for (const id of [...this.flashStates.keys()]) {
			if (!this.hosts.some(h => h.id === id)) {
				this.flashStates.delete(id);
			}
		}
		if (!this.rootEl) {
			return;
		}
		this.renderAll();
		this.syncDrawerWithHosts();
		if (preferredTarget && this.selectedHostId) {
			const card = this.cards.get(this.selectedHostId)?.el;
			card?.scrollIntoView?.({ block: 'nearest' });
			card?.focus();
		}
	}

	private renderAll(): void {
		this.renderKpis();
		this.renderGrid();
		this.renderBanner();
	}

	private renderKpis(): void {
		const kpis = computeCloudHostKpis(this.hosts);
		this.kpiEls.total.value.textContent = String(kpis.total);
		this.kpiEls.total.meta.textContent = kpis.untested
			? localize('adeChKpiUntestedMeta', "{0} untested", kpis.untested)
			: localize('adeChKpiAllTestedMeta', "all tested");
		this.kpiEls.connected.value.textContent = `${kpis.connected}/${kpis.total}`;
		this.kpiEls.connected.meta.textContent = kpis.failing
			? localize('adeChKpiFailingMeta', "{0} failing", kpis.failing)
			: localize('adeChKpiNoFailuresMeta', "no failures");
		this.kpiEls.connected.value.parentElement!.classList.toggle('has-failures', kpis.failing > 0);
		this.kpiEls.latency.value.textContent = kpis.avgLatencyMs === undefined
			? '\u2014'
			: localize('adeChLatencyMs', "{0} ms", kpis.avgLatencyMs);
		this.kpiEls.latency.meta.textContent = kpis.p95LatencyMs === undefined
			? localize('adeChKpiNoLatencyMeta', "test a host to measure")
			: localize('adeChKpiP95Meta', "p95 {0} ms", kpis.p95LatencyMs);
		this.kpiEls.imported.value.textContent = String(kpis.importedFromVsCode);
		this.kpiEls.imported.meta.textContent = kpis.importedFromSshConfig
			? localize('adeChKpiSshConfigMeta', "+ssh_config {0}", kpis.importedFromSshConfig)
			: localize('adeChKpiSyncMeta', "sync anytime");
	}

	private updateToolbarState(): void {
		const osCounts = countCloudHostsByOs(this.hosts);
		for (const [value, refs] of this.osChipEls) {
			refs.count.textContent = String(osCounts[value]);
			refs.el.setAttribute('aria-checked', String(this.query.os === value));
			refs.el.classList.toggle('checked', this.query.os === value);
		}
		const statusCounts = countCloudHostsByStatus(this.hosts);
		for (const [value, refs] of this.statusChipEls) {
			refs.count.textContent = String(statusCounts[value]);
			refs.el.setAttribute('aria-checked', String(this.query.status === value));
			refs.el.classList.toggle('checked', this.query.status === value);
		}
		for (const [value, btn] of this.viewBtnEls) {
			btn.setAttribute('aria-checked', String(this.view === value));
			btn.classList.toggle('checked', this.view === value);
		}
		this.rootEl.dataset.view = this.view;
	}

	//#endregion

	//#region Grid & cards

	private renderGrid(): void {
		const active = getActiveElement();
		const focusedCard = isHTMLElement(active) ? active.closest<HTMLElement>('.ade-ch-card') : null;
		const focusedHostId = focusedCard?.dataset.hostId;
		const focusedRole = isHTMLElement(active) && focusedCard ? active.dataset.focusRole : undefined;

		this.updateToolbarState();
		this.renderGridDisposables.clear();
		this.cards.clear();
		clearNode(this.gridEl);
		clearNode(this.emptyEl);

		const visible = filterAndSortCloudHosts(this.hosts, this.query);
		this.rootEl.classList.toggle('is-empty', this.hosts.length === 0);
		if (this.hosts.length === 0) {
			this.renderFirstRunEmptyState();
			return;
		}
		if (visible.length === 0) {
			const empty = append(this.emptyEl, $('.ade-ch-empty-list'));
			append(empty, $('span', {}, localize('adeChNoHostsMatch', "No Cloud Hosts match your filter.")));
			this.createButton(empty, '.ade-ch-btn.ghost.sm', localize('adeChClearFilters', "Clear filters"), Codicon.clearAll, () => {
				this.query = { ...this.query, text: '', os: 'all', status: 'all' };
				this.searchInputEl.value = '';
				this.renderGrid();
			}, this.renderGridDisposables);
			return;
		}

		const tabStopId = visible.some(h => h.id === this.selectedHostId) ? this.selectedHostId : visible[0].id;
		for (const host of visible) {
			this.cards.set(host.id, this.renderCard(host, host.id === tabStopId));
		}

		if (focusedHostId) {
			const cardRefs = this.cards.get(focusedHostId);
			const target = focusedRole ? cardRefs?.focusRoles.get(focusedRole) : cardRefs?.el;
			(target ?? cardRefs?.el)?.focus();
		}
	}

	private renderFirstRunEmptyState(): void {
		const empty = append(this.emptyEl, $('.ade-ch-empty-hero'));
		this.createIcon(empty, Codicon.remoteExplorer, '.ade-ch-empty-ico');
		append(empty, $('h2.ade-ch-empty-title', {}, localize('adeChEmptyTitle', "Bring your servers")));
		append(empty, $('p.ade-ch-empty-sub', {}, localize('adeChNoHostsSaved', "No Cloud Hosts saved yet. Import your VS Code Remote-SSH hosts and ~/.ssh/config, or add a host manually.")));
		const actions = append(empty, $('.ade-ch-empty-actions'));
		this.createButton(actions, '.ade-ch-btn.primary', localize('adeChEmptyImport', "Import from VS Code"), Codicon.sync, () => void this.handleImportVsCode(), this.renderGridDisposables);
		this.createButton(actions, '.ade-ch-btn', localize('adeChNewShortBtn', "New Host"), Codicon.add, () => this.openDrawer(undefined), this.renderGridDisposables);
	}

	private renderCard(host: IAdeCloudHost, isTabStop: boolean): ICardRefs {
		const store = this.renderGridDisposables;
		const status = getCloudHostStatus(host);
		const testing = this.testingIds.has(host.id);
		const card = append(this.gridEl, $('article.ade-ch-card', {
			role: 'listitem',
			tabindex: isTabStop ? '0' : '-1',
			'data-host-id': host.id,
			'data-host-alias': host.alias,
			'data-os': host.os,
			'data-status': testing ? 'testing' : (status === 'untested' ? 'unknown' : status),
			'aria-current': String(host.id === this.selectedHostId),
			'aria-label': localize('adeChCardAria', "{0}, {1}, {2}", host.name, formatCloudHostTargetBadge(host), this.describeStatus(host)),
		}));
		if (isCloudHostCheckStale(host)) {
			card.classList.add('is-stale');
		}

		// Head: OS badge · titles · latency · menu
		const head = append(card, $('header.ade-ch-card-head'));
		const osKind = resolveAdeOsIconKind({
			os: host.os,
			distribution: host.lastTestStatus?.remoteUname,
			hint: `${host.name} ${host.alias} ${host.hostName} ${host.notes ?? ''}`,
		});
		const osBadge = append(head, $(`span.ade-ch-os-badge.os-${host.os}.os-kind-${osKind}`));
		const glyph = append(osBadge, $('span.ade-ch-os-glyph', { 'aria-hidden': 'true' }));
		renderAdeOsIcon(glyph, osKind, { baseClass: 'ade-ch-os-glyph', prefix: 'ade-os' });
		osBadge.title = glyph.title;
		const titles = append(head, $('.ade-ch-card-titles'));
		append(titles, $('span.ade-ch-card-name', { title: host.name }, host.name));
		const subRow = append(titles, $('.ade-ch-card-subrow'));
		append(subRow, $('span.ade-ch-card-alias', {}, host.alias));
		append(subRow, $('span.ade-ch-source-tag', { 'data-source': host.source }, this.describeSource(host)));

		const latencyBadgeEl = append(head, this.renderLatencyBadge(host, testing));

		this.createButton(head, '.ade-ch-card-menu', undefined, Codicon.kebabVertical, e => {
			e.stopPropagation();
			this.showCardMenu(host, e.currentTarget as HTMLElement);
		}, store, localize('adeChCardMenu', "More actions for {0}", host.name));

		// Target badge
		const targetRow = append(card, $('.ade-ch-card-target'));
		const target = formatCloudHostTargetBadge(host);
		append(targetRow, $('code.ade-ch-target-badge', { title: target }, target));
		const copyBtn = this.createButton(targetRow, '.ade-ch-copy', undefined, Codicon.copy, e => {
			e.stopPropagation();
			void this.copyToClipboard(target, copyBtn);
		}, store, localize('adeChCopyTarget', "Copy {0}", target));

		// ProxyJump chain
		const hops = parseProxyJumpChain(host.proxyJump);
		if (hops.length) {
			const chain = append(card, $('.ade-ch-jump-chain', { 'aria-label': localize('adeChJumpChainAria', "Connects via {0}", hops.join(', ')) }));
			this.createIcon(chain, Codicon.debugDisconnect, '.ade-ch-jump-ico');
			for (const hop of hops) {
				append(chain, $('span.ade-ch-jump-hop', { title: hop }, hop));
				this.createIcon(chain, Codicon.arrowRight, '.ade-ch-jump-arrow');
			}
			append(chain, $('span.ade-ch-jump-hop.is-target', { title: host.alias }, host.alias));
		}

		// Recent remote project chips
		const projects = append(card, $('.ade-ch-card-projects'));
		if (host.recentDirectories.length) {
			for (const folderPath of host.recentDirectories.slice(0, ADE_CLOUD_HOST_MAX_PROJECT_CHIPS)) {
				const chip = append(projects, $('button.ade-ch-project-chip', {
					type: 'button',
					title: localize('adeChProjectChipTooltip', "{0}:{1}\nClick: add as project · {2}-click: open SSH terminal here", host.alias, folderPath, isMacintosh ? '\u2325' : 'Alt'),
				}));
				this.createIcon(chip, Codicon.folder, '.ade-ch-project-chip-ico');
				append(chip, $('span.ade-ch-project-chip-label', {}, folderPath.split('/').filter(Boolean).pop() || folderPath));
				store.add(addDisposableListener(chip, EventType.CLICK, (e: MouseEvent) => {
					e.stopPropagation();
					if (e.altKey) {
						void this.openTerminalOnHost(host, folderPath);
					} else {
						void this.addRemoteFolderAsProject(host, folderPath);
					}
				}));
			}
			const more = host.recentDirectories.length - ADE_CLOUD_HOST_MAX_PROJECT_CHIPS;
			if (more > 0) {
				append(projects, $('span.ade-ch-project-more', { title: host.recentDirectories.slice(ADE_CLOUD_HOST_MAX_PROJECT_CHIPS).join('\n') }, `+${more}`));
			}
		} else {
			append(projects, $('span.ade-ch-project-none', {}, localize('adeChNoRecentProjects', "No recent remote projects")));
		}

		// Actions
		const focusRoles = new Map<string, HTMLElement>();
		const actions = append(card, $('footer.ade-ch-card-actions'));
		const termBtn = this.createButton(actions, '.ade-ch-btn.primary.sm.ade-ch-terminal-btn', localize('adeChOpenSshTerminal', "Open SSH Terminal"), Codicon.terminal, e => {
			e.stopPropagation();
			void this.openTerminalOnHost(host);
		}, store);
		termBtn.dataset.focusRole = 'terminal';
		focusRoles.set('terminal', termBtn);
		const addBtn = this.createButton(actions, '.ade-ch-btn.sm.ade-ch-add-project-btn', localize('adeChAddProject', "Add Project"), Codicon.newFolder, e => {
			e.stopPropagation();
			void this.commandService.executeCommand(ADE_ADD_CLOUD_PROJECT_COMMAND_ID, host.alias);
		}, store);
		addBtn.dataset.focusRole = 'add';
		focusRoles.set('add', addBtn);
		const testBtn = this.createButton(actions, '.ade-ch-btn.ghost.sm.ade-ch-test-btn', undefined, undefined, e => {
			e.stopPropagation();
			void this.testHost(host);
		}, store);
		testBtn.dataset.focusRole = 'test';
		focusRoles.set('test', testBtn);
		this.applyTestButtonState(testBtn, host);
		append(actions, $('span.ade-ch-card-checked', {
			title: host.lastTestStatus ? new Date(host.lastTestStatus.checkedAt).toLocaleString() : '',
		}, host.lastTestStatus
			? localize('adeChCheckedAgo', "checked {0}", fromNow(host.lastTestStatus.checkedAt, true))
			: localize('adeChNeverChecked', "never checked")));

		store.add(addDisposableListener(card, EventType.CLICK, () => this.selectCard(host.id)));
		store.add(addDisposableListener(card, EventType.DBLCLICK, () => this.openDrawer(host)));
		store.add(addDisposableListener(card, EventType.FOCUS, () => this.setRovingTabStop(host.id)));
		return { host, el: card, latencyBadgeEl, testBtn, focusRoles };
	}

	private renderLatencyBadge(host: IAdeCloudHost, testing: boolean): HTMLElement {
		const tier = getCloudHostLatencyTier(host);
		const badge = $('span.ade-ch-latency', { 'data-tier': testing ? 'none' : tier });
		append(badge, $('i.ade-ch-latency-dot', { 'aria-hidden': 'true' }));
		let text: string;
		if (testing) {
			text = localize('adeChLatencyTesting', "testing");
		} else if (!host.lastTestStatus) {
			text = localize('adeChLatencyUntested', "untested");
		} else if (!host.lastTestStatus.ok) {
			text = localize('adeChLatencyFailed', "failed");
		} else {
			text = localize('adeChLatencyMs', "{0} ms", host.lastTestStatus.latencyMs);
		}
		append(badge, $('span.ade-ch-latency-text', {}, text));
		badge.title = host.lastTestStatus?.error ?? this.describeStatus(host);
		return badge;
	}

	private applyTestButtonState(btn: HTMLButtonElement, host: IAdeCloudHost): void {
		clearNode(btn);
		const testing = this.testingIds.has(host.id);
		const flash = this.flashStates.get(host.id);
		const state = testing ? 'testing' : (flash ?? 'idle');
		btn.dataset.state = state;
		btn.disabled = testing;
		btn.setAttribute('aria-busy', String(testing));
		const icon = state === 'testing' ? ThemeIcon.modify(Codicon.loading, 'spin') : state === 'ok' ? Codicon.check : state === 'err' ? Codicon.error : Codicon.plug;
		this.createIcon(btn, icon, '.ade-ch-btn-ico');
		append(btn, $('span.ade-ch-btn-label', {}, state === 'testing'
			? localize('adeChTestingBtn', "Testing...")
			: localize('adeChTestConnBtn', "Test Connection")));
	}

	/** Patches one card in place (status, latency and test button) without rebuilding the grid. */
	private patchCard(hostId: string): void {
		const refs = this.cards.get(hostId);
		if (!refs) {
			return;
		}
		const host = this.hosts.find(h => h.id === hostId) ?? refs.host;
		const testing = this.testingIds.has(hostId);
		const status = getCloudHostStatus(host);
		refs.el.dataset.status = testing ? 'testing' : (status === 'untested' ? 'unknown' : status);
		const nextBadge = this.renderLatencyBadge(host, testing);
		refs.latencyBadgeEl.replaceWith(nextBadge);
		refs.latencyBadgeEl = nextBadge;
		this.applyTestButtonState(refs.testBtn, host);
	}

	private describeStatus(host: IAdeCloudHost): string {
		const check = host.lastTestStatus;
		if (!check) {
			return localize('adeChStatusDescUntested', "Not tested yet");
		}
		return check.ok
			? localize('adeChStatusDescOk', "Connected in {0} ms", check.latencyMs)
			: localize('adeChStatusDescErr', "Connection failed: {0}", check.error ?? localize('adeChUnknownSshError', "Unknown SSH error"));
	}

	private describeSource(host: IAdeCloudHost): string {
		switch (host.source) {
			case 'vscode': return localize('adeChSourceVsCodeTag', "VS Code");
			case 'ssh-config': return localize('adeChSourceSshTag', "ssh_config");
			case 'aexus-legacy': return localize('adeChSourceLegacyTag', "Legacy");
			default: return localize('adeChSourceManagedTag', "Aexus");
		}
	}

	private selectCard(hostId: string): void {
		this.selectedHostId = hostId;
		for (const [id, refs] of this.cards) {
			refs.el.setAttribute('aria-current', String(id === hostId));
		}
		this.setRovingTabStop(hostId);
	}

	private setRovingTabStop(hostId: string): void {
		for (const [id, refs] of this.cards) {
			refs.el.tabIndex = id === hostId ? 0 : -1;
		}
	}

	private visibleCardEls(): HTMLElement[] {
		return [...this.cards.values()].map(refs => refs.el);
	}

	private focusCardAt(index: number): void {
		const cards = this.visibleCardEls();
		if (!cards.length) {
			return;
		}
		const target = cards[Math.max(0, Math.min(cards.length - 1, index))];
		this.setRovingTabStop(target.dataset.hostId!);
		target.focus();
	}

	private gridColumnCount(): number {
		if (this.view === 'list') {
			return 1;
		}
		const cards = this.visibleCardEls();
		if (cards.length < 2) {
			return 1;
		}
		const firstTop = cards[0].offsetTop;
		const idx = cards.findIndex(card => card.offsetTop !== firstTop);
		return idx === -1 ? cards.length : idx;
	}

	private onRootKeyDown(e: KeyboardEvent): void {
		const evt = new StandardKeyboardEvent(e);
		const target = e.target;
		const inField = isHTMLElement(target) && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);

		if (evt.keyCode === KeyCode.Escape && this.drawer) {
			evt.preventDefault();
			evt.stopPropagation();
			this.closeDrawer();
			return;
		}
		if (this.drawer && isHTMLElement(target) && this.drawerEl.contains(target)) {
			if (evt.keyCode === KeyCode.Tab) {
				this.trapDrawerFocus(evt);
			}
			return;
		}
		if (inField) {
			return;
		}
		if (e.key === '/' && !evt.ctrlKey && !evt.metaKey && !evt.altKey) {
			evt.preventDefault();
			this.searchInputEl.focus();
			this.searchInputEl.select();
			return;
		}
		const card = isHTMLElement(target) && target.classList.contains('ade-ch-card') ? target : undefined;
		if (!card) {
			return;
		}
		const cards = this.visibleCardEls();
		const index = cards.indexOf(card);
		const host = this.cards.get(card.dataset.hostId!)?.host;
		const columns = this.gridColumnCount();
		switch (evt.keyCode) {
			case KeyCode.RightArrow: evt.preventDefault(); this.focusCardAt(index + 1); return;
			case KeyCode.LeftArrow: evt.preventDefault(); this.focusCardAt(index - 1); return;
			case KeyCode.DownArrow: evt.preventDefault(); this.focusCardAt(index + columns); return;
			case KeyCode.UpArrow: evt.preventDefault(); this.focusCardAt(index - columns); return;
			case KeyCode.Home: evt.preventDefault(); this.focusCardAt(0); return;
			case KeyCode.End: evt.preventDefault(); this.focusCardAt(cards.length - 1); return;
		}
		if (!host) {
			return;
		}
		if (evt.keyCode === KeyCode.Enter && (evt.metaKey || evt.ctrlKey)) {
			evt.preventDefault();
			void this.openTerminalOnHost(host);
		} else if (evt.keyCode === KeyCode.Enter || evt.keyCode === KeyCode.Space) {
			evt.preventDefault();
			this.selectCard(host.id);
			this.openDrawer(host);
		} else if (evt.keyCode === KeyCode.KeyT && !evt.metaKey && !evt.ctrlKey && !evt.altKey) {
			evt.preventDefault();
			void this.testHost(host);
		}
	}

	private showCardMenu(host: IAdeCloudHost, anchor: HTMLElement): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				toAction({ id: 'ade.cloudHosts.edit', label: localize('adeChMenuEdit', "Edit Host..."), run: () => this.openDrawer(host) }),
				toAction({ id: 'ade.cloudHosts.duplicate', label: localize('adeChMenuDuplicate', "Duplicate"), run: () => this.duplicateHost(host) }),
				toAction({ id: 'ade.cloudHosts.copySsh', label: localize('adeChMenuCopySsh', "Copy ssh Command"), run: () => this.copyToClipboard(hostToSshCommand(host)) }),
				toAction({ id: 'ade.cloudHosts.test', label: localize('adeChMenuTest', "Test Connection"), enabled: !this.testingIds.has(host.id), run: () => this.testHost(host) }),
				toAction({ id: 'ade.cloudHosts.delete', label: localize('adeChMenuDelete', "Delete Host..."), run: () => this.deleteHost(host) }),
			],
		});
	}

	//#endregion

	//#region Commands

	private async copyToClipboard(text: string, feedbackEl?: HTMLElement): Promise<void> {
		await this.clipboardService.writeText(text);
		if (feedbackEl) {
			feedbackEl.classList.add('copied');
			this.flashTimers.add(disposableTimeout(() => feedbackEl.classList.remove('copied'), 1200));
		}
	}

	private async handleImportVsCode(): Promise<void> {
		try {
			const res = await this.backend.importFromVsCodeAndSshConfig();
			this.setBanner('ok', localize(
				'adeChImportBannerSuccess',
				"Imported & synced {0} total Cloud Host(s) ({1} newly added, {2} updated, {3} recent folders) from VS Code & ~/.ssh/config.",
				res.totalHosts,
				res.importedCount,
				res.updatedCount,
				res.importedRecentFolders,
			));
			await this.reloadHosts();
		} catch (err) {
			this.setBanner('err', err instanceof Error ? err.message : String(err));
		}
	}

	private async testHost(host: IAdeCloudHost): Promise<void> {
		if (this.testingIds.has(host.id)) {
			return;
		}
		this.testingIds.add(host.id);
		this.flashStates.delete(host.id);
		this.patchCard(host.id);
		this.updateDrawerFooter();
		let ok = false;
		try {
			const check = await this.backend.testConnection(host.id);
			ok = check.ok;
			if (!check.ok) {
				this.setBanner('err', localize('adeChConnFailMsg', "Connection check failed ({0}ms): {1}", check.latencyMs, check.error ?? localize('adeChUnknownSshError', "Unknown SSH error")));
			}
		} catch (err) {
			this.setBanner('err', err instanceof Error ? err.message : String(err));
		} finally {
			this.testingIds.delete(host.id);
		}
		this.flashStates.set(host.id, ok ? 'ok' : 'err');
		this.flashTimers.add(disposableTimeout(() => {
			this.flashStates.delete(host.id);
			this.patchCard(host.id);
		}, FLASH_DURATION_MS));
		this.hosts = await this.backend.listHosts();
		this.renderKpis();
		this.updateToolbarState();
		this.patchCard(host.id);
		this.updateDrawerFooter();
	}

	private async testAllHosts(): Promise<void> {
		const queue = filterAndSortCloudHosts(this.hosts, this.query).filter(h => !this.testingIds.has(h.id));
		const worker = async () => {
			for (let host = queue.shift(); host; host = queue.shift()) {
				await this.testHost(host);
			}
		};
		await Promise.all(Array.from({ length: Math.min(TEST_ALL_CONCURRENCY, queue.length) }, () => worker()));
	}

	private duplicateHost(host: IAdeCloudHost): void {
		const draft = hostToDraftForm(host);
		draft.id = undefined;
		draft.name = localize('adeChDuplicateName', "{0} (copy)", host.name);
		draft.alias = sanitizeSshAlias(`${host.alias}-copy`);
		this.openDrawer(undefined, draft);
	}

	private async deleteHost(host: IAdeCloudHost): Promise<void> {
		const boundProjects = this.adeProjects.projects.filter(
			p => p.uri.scheme === 'aexus-ssh' && p.uri.authority.toLowerCase() === host.alias.toLowerCase(),
		);
		const detailText = boundProjects.length > 0
			? localize(
				'adeChConfirmDeleteWithProjectsDetail',
				"This removes the saved Cloud Host entry AND unlinks {0} ADE project(s) bound to {1} ({2}). Your SSH private key files and remote directories on disk are never deleted.",
				boundProjects.length,
				host.alias,
				boundProjects.map(p => p.name).join(', '),
			)
			: localize('adeChConfirmDeleteDetail', "This removes the saved Cloud Host entry from Aexus Code. Your SSH private key files on disk are never deleted.");
		const confirmed = await this.dialogService.confirm({
			type: 'warning',
			message: localize('adeChConfirmDeleteTitle', "Remove Cloud Host '{0}'?", host.name),
			detail: detailText,
			primaryButton: localize('adeChConfirmDeleteBtn', "&&Delete Cloud Host"),
			custom: true,
		});
		if (!confirmed.confirmed) {
			return;
		}
		try {
			const deleted = await this.backend.deleteHost(host.id);
			if (!deleted) {
				this.setBanner('err', localize('adeChDeleteNotFoundBanner', "Cloud Host '{0}' was already removed.", host.name));
			} else {
				for (const proj of boundProjects) {
					this.adeProjects.unregisterProject(proj.uri);
				}
				void this.commandService?.executeCommand?.('aexus.agentEngines.invalidateCloudHost', host.alias);
				if (this.drawer?.hostId === host.id) {
					this.closeDrawer(false);
				}
				this.setBanner('info', localize('adeChDeletedBanner', "Removed Cloud Host '{0}'.", host.name));
			}
		} catch (err) {
			this.setBanner('err', err instanceof Error ? err.message : String(err));
		}
		await this.reloadHosts();
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
		const targetDir = remotePath || resolveInitialCloudHostDirectory(host);
		const targetUri = buildCloudProjectUri(host.alias, targetDir, host.os);
		await this.commandService.executeCommand('workbench.action.terminal.new', { cwd: targetUri });
	}

	//#endregion

	//#region Banner

	private setBanner(kind: 'ok' | 'err' | 'info', text: string): void {
		this.statusBanner = { kind, text };
		this.bannerTimer.clear();
		if (kind !== 'err') {
			this.bannerTimer.value = disposableTimeout(() => {
				this.statusBanner = undefined;
				this.renderBanner();
			}, BANNER_AUTO_DISMISS_MS);
		}
		this.renderBanner();
	}

	private renderBanner(): void {
		if (!this.bannerHostEl) {
			return;
		}
		this.bannerDisposables.clear();
		clearNode(this.bannerHostEl);
		if (!this.statusBanner) {
			return;
		}
		const banner = append(this.bannerHostEl, $(`div.ade-ch-banner.${this.statusBanner.kind}`, {
			role: this.statusBanner.kind === 'err' ? 'alert' : 'status',
			'aria-live': this.statusBanner.kind === 'err' ? 'assertive' : 'polite',
		}));
		this.createIcon(banner, this.statusBanner.kind === 'ok' ? Codicon.passFilled : this.statusBanner.kind === 'err' ? Codicon.error : Codicon.info, '.ade-ch-banner-ico');
		append(banner, $('span.ade-ch-banner-text', {}, this.statusBanner.text));
		const close = append(banner, $('button.ade-ch-banner-close', { type: 'button', 'aria-label': localize('adeChDismissBanner', "Dismiss") })) as HTMLButtonElement;
		close.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		this.bannerDisposables.add(addDisposableListener(close, EventType.CLICK, () => {
			this.statusBanner = undefined;
			this.bannerTimer.clear();
			this.renderBanner();
		}));
	}

	//#endregion

	//#region Drawer

	private createDrawerShell(): void {
		this.drawerEl = append(this.rootEl, $('aside.ade-ch-drawer', {
			role: 'dialog',
			'aria-modal': 'false',
			'aria-labelledby': 'ade-ch-drawer-title',
			'aria-hidden': 'true',
		}));
		this.drawerEl.inert = true;
		const head = append(this.drawerEl, $('header.ade-ch-drawer-head'));
		const titles = append(head, $('.ade-ch-drawer-titles'));
		this.drawerTitleEl = append(titles, $('h2.ade-ch-drawer-title', { id: 'ade-ch-drawer-title' }));
		this.drawerSubEl = append(titles, $('p.ade-ch-drawer-sub'));
		this.createButton(head, '.ade-ch-drawer-close', undefined, Codicon.close, () => this.closeDrawer(), undefined, localize('adeChCloseDrawer', "Close"));
		this.drawerNoticeEl = append(this.drawerEl, $('.ade-ch-drawer-notice', { role: 'status' }));
		this.drawerBodyEl = append(this.drawerEl, $('.ade-ch-drawer-body'));
		this.drawerFootEl = append(this.drawerEl, $('footer.ade-ch-drawer-foot'));
	}

	private openDrawer(host: IAdeCloudHost | undefined, draftOverride?: IDraftCloudHostForm): void {
		const active = getActiveElement();
		if (!this.drawer && isHTMLElement(active) && !this.drawerEl.contains(active)) {
			this.drawerReturnFocus = active;
		}
		const baseline = draftOverride ?? (host ? hostToDraftForm(host) : emptyDraftForm());
		this.drawer = { hostId: host?.id, baseline: { ...baseline }, draft: { ...baseline }, externalChange: false };
		if (host) {
			this.selectCard(host.id);
		}
		this.rootEl.toggleAttribute('data-drawer-open', true);
		this.drawerEl.setAttribute('aria-hidden', 'false');
		this.drawerEl.inert = false;
		this.renderDrawer();
		this.drawerFirstInputEl?.focus({ preventScroll: true });
		this.rootEl.scrollLeft = 0;
	}

	private closeDrawer(restoreFocus = true): void {
		if (!this.drawer) {
			return;
		}
		this.drawer = undefined;
		this.drawerDisposables.clear();
		this.rootEl.toggleAttribute('data-drawer-open', false);
		this.drawerEl.setAttribute('aria-hidden', 'true');
		this.drawerEl.inert = true;
		this.sshPreviewEl = undefined;
		this.dirtyDotEl = undefined;
		this.drawerTestBtn = undefined;
		this.drawerFirstInputEl = undefined;
		this.drawerAliasInputEl = undefined;
		if (restoreFocus) {
			const selected = this.selectedHostId ? this.cards.get(this.selectedHostId)?.el : undefined;
			const target = this.drawerReturnFocus?.isConnected ? this.drawerReturnFocus : selected;
			target?.focus({ preventScroll: true });
		}
		this.rootEl.scrollLeft = 0;
		this.drawerReturnFocus = undefined;
	}

	private trapDrawerFocus(evt: StandardKeyboardEvent): void {
		const focusables = collectDrawerFocusables(this.drawerEl);
		if (!focusables.length) {
			return;
		}
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = getActiveElement();
		if (evt.shiftKey && active === first) {
			evt.preventDefault();
			last.focus();
		} else if (!evt.shiftKey && active === last) {
			evt.preventDefault();
			first.focus();
		}
	}

	private get drawerHost(): IAdeCloudHost | undefined {
		return this.drawer?.hostId ? this.hosts.find(h => h.id === this.drawer!.hostId) : undefined;
	}

	private isDrawerDirty(): boolean {
		return !!this.drawer && !isDraftFormEqual(this.drawer.draft, this.drawer.baseline);
	}

	private syncDrawerWithHosts(): void {
		if (!this.drawer?.hostId) {
			return;
		}
		const host = this.drawerHost;
		if (!host) {
			this.closeDrawer(false);
			this.setBanner('info', localize('adeChDrawerHostRemoved', "The Cloud Host you were editing was removed."));
			return;
		}
		const fresh = hostToDraftForm(host);
		if (isDraftFormEqual(fresh, this.drawer.baseline)) {
			this.updateDrawerFooter();
			return;
		}
		if (this.isDrawerDirty()) {
			this.drawer.externalChange = true;
			this.renderDrawerNotice();
		} else {
			this.drawer = { hostId: host.id, baseline: { ...fresh }, draft: { ...fresh }, externalChange: false };
			this.renderDrawer();
		}
	}

	private renderDrawerNotice(): void {
		clearNode(this.drawerNoticeEl);
		if (!this.drawer?.externalChange) {
			return;
		}
		this.createIcon(this.drawerNoticeEl, Codicon.warning, '.ade-ch-drawer-notice-ico');
		append(this.drawerNoticeEl, $('span', {}, localize('adeChExternalChange', "This host changed outside the editor.")));
		this.createButton(this.drawerNoticeEl, '.ade-ch-btn.ghost.sm', localize('adeChReloadHost', "Reload"), Codicon.refresh, () => {
			const host = this.drawerHost;
			if (host) {
				this.openDrawer(host);
			}
		}, this.drawerDisposables);
	}

	private renderDrawer(): void {
		const drawer = this.drawer;
		if (!drawer) {
			return;
		}
		this.drawerDisposables.clear();
		clearNode(this.drawerBodyEl);
		clearNode(this.drawerFootEl);
		const host = this.drawerHost;
		const store = this.drawerDisposables;

		this.drawerTitleEl.textContent = host
			? localize('adeChEditHostTitle', "Edit {0}", host.name)
			: localize('adeChCreateHostTitle', "New Cloud Host");
		this.drawerSubEl.textContent = host
			? `${formatCloudHostTargetBadge(host)} \u00b7 ${host.source === 'vscode' ? localize('adeChSourceVsCode', "Migrated from VS Code") : (host.source === 'ssh-config' ? localize('adeChSourceSsh', "Imported from ~/.ssh/config") : localize('adeChSourceManaged', "Managed by Aexus Code"))}`
			: localize('adeChCreateHostSubtitle', "Configure SSH connection, key authentication, jump host, and default workspace folder.");
		this.renderDrawerNotice();

		const onChange = () => this.onDraftChanged();
		const makeFieldset = (legend: string, icon: ThemeIcon) => {
			const fs = append(this.drawerBodyEl, $('fieldset.ade-ch-fieldset'));
			const lg = append(fs, $('legend.ade-ch-legend'));
			this.createIcon(lg, icon, '.ade-ch-legend-ico');
			append(lg, $('span', {}, legend));
			return append(fs, $('.ade-ch-form-grid'));
		};
		let fieldSeq = 0;
		const makeField = (grid: HTMLElement, label: string, hint: string, fullWidth = false) => {
			const id = `ade-ch-field-${++fieldSeq}`;
			const wrap = append(grid, $(`div.ade-ch-field${fullWidth ? '.full' : ''}`));
			append(wrap, $('label.ade-ch-label', { for: id }, label));
			return { wrap, id, hint };
		};
		const appendHint = (wrap: HTMLElement, hint: string) => {
			if (hint) {
				append(wrap, $('div.ade-ch-hint', {}, hint));
			}
		};
		const textInput = (grid: HTMLElement, label: string, hint: string, key: 'name' | 'alias' | 'hostName' | 'user' | 'port' | 'identityFile' | 'proxyJump' | 'defaultDirectory', placeholder: string, opts: { fullWidth?: boolean; type?: string; withBrowse?: () => Promise<string | undefined> } = {}) => {
			const field = makeField(grid, label, hint, opts.fullWidth);
			const row = opts.withBrowse ? append(field.wrap, $('.ade-ch-inline-row')) : field.wrap;
			const input = append(row, $('input.ade-ch-input', {
				id: field.id,
				type: opts.type ?? 'text',
				placeholder,
				spellcheck: 'false',
				autocomplete: 'off',
				'data-field': key,
			})) as HTMLInputElement;
			input.value = drawer.draft[key];
			if (opts.type === 'number') {
				input.min = '1';
				input.max = '65535';
			}
			store.add(addDisposableListener(input, EventType.INPUT, () => {
				const previousAutoAlias = sanitizeSshAlias(drawer.draft.name);
				drawer.draft[key] = input.value;
				if (key === 'name' && (!drawer.draft.alias || drawer.draft.alias === previousAutoAlias)) {
					drawer.draft.alias = sanitizeSshAlias(input.value);
					if (this.drawerAliasInputEl) {
						this.drawerAliasInputEl.value = drawer.draft.alias;
					}
				}
				onChange();
			}));
			if (opts.withBrowse) {
				const browse = opts.withBrowse;
				this.createButton(row, '.ade-ch-btn.sm', localize('adeChBrowseBtn', "Browse..."), Codicon.folderOpened, async () => {
					const picked = await browse();
					if (picked !== undefined) {
						drawer.draft[key] = picked;
						input.value = picked;
						onChange();
					}
				}, store);
			}
			appendHint(field.wrap, field.hint);
			return input;
		};
		const segmented = <T extends string>(grid: HTMLElement, label: string, hint: string, options: ReadonlyArray<{ value: T; label: string; osIcon?: AdeOsIconKind }>, get: () => T, set: (value: T) => void) => {
			const field = makeField(grid, label, hint);
			const seg = append(field.wrap, $('.ade-ch-seg', { role: 'radiogroup', id: field.id, 'aria-label': label }));
			const buttons: HTMLElement[] = [];
			const sync = () => {
				for (const btn of buttons) {
					const checked = btn.dataset.value === get();
					btn.setAttribute('aria-checked', String(checked));
					btn.classList.toggle('checked', checked);
					btn.tabIndex = checked ? 0 : -1;
				}
			};
			for (const option of options) {
				const btn = append(seg, $('button.ade-ch-seg-btn', { type: 'button', role: 'radio', 'data-value': option.value }));
				if (option.osIcon) {
					const ico = append(btn, $('span.ade-ch-seg-os-ico'));
					renderAdeOsIcon(ico, option.osIcon, { baseClass: 'ade-ch-seg-os-ico', prefix: 'ade-os' });
				}
				append(btn, $('span', {}, option.label));
				buttons.push(btn);
				store.add(addDisposableListener(btn, EventType.CLICK, () => {
					set(option.value);
					sync();
					onChange();
				}));
				store.add(addDisposableListener(btn, EventType.KEY_DOWN, (e: KeyboardEvent) => {
					const evt = new StandardKeyboardEvent(e);
					const delta = evt.keyCode === KeyCode.RightArrow || evt.keyCode === KeyCode.DownArrow ? 1 : evt.keyCode === KeyCode.LeftArrow || evt.keyCode === KeyCode.UpArrow ? -1 : 0;
					if (!delta) {
						return;
					}
					evt.preventDefault();
					const next = options[(options.findIndex(o => o.value === get()) + delta + options.length) % options.length];
					set(next.value);
					sync();
					onChange();
					buttons.find(b => b.dataset.value === next.value)?.focus();
				}));
			}
			sync();
			appendHint(field.wrap, field.hint);
		};

		// 1. Connection
		const connection = makeFieldset(localize('adeChFieldsetConnection', "Connection"), Codicon.plug);
		this.drawerFirstInputEl = textInput(connection, localize('adeChFieldName', "Display Name"), localize('adeChFieldNameHint', "Shown in Projects & Cloud Host lists"), 'name', 'GPU-server');
		this.drawerAliasInputEl = textInput(connection, localize('adeChFieldAlias', "SSH Host Alias"), localize('adeChFieldAliasHint', "Used in aexus-ssh://<alias>/path & ssh <alias>"), 'alias', 'GPU-server');
		textInput(connection, localize('adeChFieldHostName', "HostName / IP Address"), localize('adeChFieldHostNameHint', "IPv4, IPv6, or domain (e.g. 203.0.113.10)"), 'hostName', '203.0.113.10', { fullWidth: true });
		textInput(connection, localize('adeChFieldUser', "SSH Username"), localize('adeChFieldUserHint', "Login user (e.g. ubuntu, root, djf)"), 'user', 'ubuntu');
		textInput(connection, localize('adeChFieldPort', "SSH Port"), localize('adeChFieldPortHint', "Default 22"), 'port', '22', { type: 'number' });
		segmented<AdeCloudHostOs>(connection, localize('adeChFieldOs', "Remote OS Platform"), localize('adeChFieldOsHint', "Selects POSIX shell vs Windows PowerShell"), [
			{ value: 'linux', label: localize('adeChOsLinux', "Linux"), osIcon: 'ubuntu' },
			{ value: 'macos', label: localize('adeChOsMac', "macOS"), osIcon: 'macos' },
			{ value: 'windows', label: localize('adeChOsWindows', "Windows"), osIcon: 'windows' },
		], () => drawer.draft.os, value => { drawer.draft.os = value; });

		// 2. Authentication
		const auth = makeFieldset(localize('adeChFieldsetAuth', "Authentication"), Codicon.key);
		textInput(auth, localize('adeChFieldIdentityFile', "SSH Private Key (IdentityFile)"), localize('adeChFieldIdentityFileHint', "Leave blank to use default SSH agent / ~/.ssh keys"), 'identityFile', '~/.ssh/id_ed25519', {
			fullWidth: true,
			withBrowse: async () => {
				const home = await this.fileDialogService.defaultFolderPath(Schemas.file);
				const picked = await this.fileDialogService.showOpenDialog({
					title: localize('adeChBrowseKeyDialogTitle', "Select SSH Private Key"),
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: false,
					defaultUri: home ? joinPath(home, '.ssh') : undefined,
				});
				return picked?.[0]?.fsPath;
			},
		});
		segmented<IDraftCloudHostForm['strictHostKeyChecking']>(auth, localize('adeChFieldHostKeyPolicy', "Host Key Verification"), localize('adeChFieldHostKeyPolicyHint', "OpenSSH StrictHostKeyChecking policy"), [
			{ value: 'accept-new', label: localize('adeChHostKeyAcceptNew', "accept-new") },
			{ value: 'yes', label: localize('adeChHostKeyYes', "yes") },
			{ value: 'no', label: localize('adeChHostKeyNo', "no") },
			{ value: '', label: localize('adeChHostKeyInherit', "inherit") },
		], () => drawer.draft.strictHostKeyChecking, value => { drawer.draft.strictHostKeyChecking = value; });

		// 3. Routing & Workspace
		const routing = makeFieldset(localize('adeChFieldsetRouting', "Routing & Workspace"), Codicon.debugDisconnect);
		textInput(routing, localize('adeChFieldProxyJump', "ProxyJump / Bastion Host"), localize('adeChFieldProxyJumpHint', "Optional jump host alias; separate multiple hops with commas"), 'proxyJump', localize('adeChNoProxyJumpPh', "Direct connection (none)"), { fullWidth: true });
		const existing = host;
		textInput(routing, localize('adeChFieldDefaultDir', "Default Remote Project Directory"), localize('adeChFieldDefaultDirHint', "Initial directory when browsing projects or opening a Cloud Host terminal"), 'defaultDirectory', drawer.draft.os === 'windows' ? '/C:/Users/Administrator' : '/home/ubuntu/develop', {
			fullWidth: true,
			withBrowse: existing ? async () => {
				const pickedUri = await this.instantiationService.invokeFunction(acc => browseRemoteFolderOnCloudHost(acc, existing));
				return pickedUri?.path;
			} : undefined,
		});
		const notesField = makeField(routing, localize('adeChFieldNotes', "Notes (Optional)"), '', true);
		const notes = append(notesField.wrap, $('textarea.ade-ch-input.ade-ch-textarea', {
			id: notesField.id,
			rows: '3',
			placeholder: localize('adeChNotesPh', "Optional environment or GPU notes..."),
		})) as HTMLTextAreaElement;
		notes.value = drawer.draft.notes;
		store.add(addDisposableListener(notes, EventType.INPUT, () => {
			drawer.draft.notes = notes.value;
			onChange();
		}));

		// Live ssh preview
		const preview = append(this.drawerBodyEl, $('.ade-ch-ssh-preview'));
		append(preview, $('span.ade-ch-ssh-preview-label', {}, localize('adeChSshPreview', "Equivalent command")));
		const previewRow = append(preview, $('.ade-ch-ssh-preview-row'));
		this.sshPreviewEl = append(previewRow, $('code.ade-ch-ssh-preview-code'));
		const copyPreview = this.createButton(previewRow, '.ade-ch-copy', undefined, Codicon.copy, () => {
			void this.copyToClipboard(buildSshCommandPreview(drawer.draft), copyPreview);
		}, store, localize('adeChCopySshCommand', "Copy ssh command"));

		// Footer
		this.dirtyDotEl = append(this.drawerFootEl, $('span.ade-ch-dirty-dot', { title: localize('adeChUnsaved', "Unsaved changes") }));
		append(this.drawerFootEl, $('span.ade-ch-foot-spacer'));
		if (host) {
			this.createButton(this.drawerFootEl, '.ade-ch-btn.ghost.danger', localize('adeChDeleteBtn', "Delete"), Codicon.trash, () => void this.deleteHost(host), store);
			this.drawerTestBtn = this.createButton(this.drawerFootEl, '.ade-ch-btn.ade-ch-drawer-test', localize('adeChTestConnBtn', "Test Connection"), Codicon.plug, () => {
				const current = this.drawerHost;
				if (current) {
					void this.testHost(current);
				}
			}, store);
		} else {
			this.drawerTestBtn = undefined;
		}
		this.createButton(this.drawerFootEl, '.ade-ch-btn.ade-ch-drawer-cancel', localize('adeChCancel', "Cancel"), undefined, () => this.closeDrawer(), store);
		this.createButton(this.drawerFootEl, '.ade-ch-btn.primary.save-btn', host ? localize('adeChSaveChangesBtn', "Save Cloud Host") : localize('adeChCreateSaveBtn', "Create & Save Cloud Host"), Codicon.save, () => void this.saveDrawer(), store);

		store.add(addDisposableListener(this.drawerBodyEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const evt = new StandardKeyboardEvent(e);
			if (evt.keyCode === KeyCode.Enter && (evt.metaKey || evt.ctrlKey)) {
				evt.preventDefault();
				void this.saveDrawer();
			}
		}));

		this.onDraftChanged();
	}

	private onDraftChanged(): void {
		if (!this.drawer) {
			return;
		}
		if (this.sshPreviewEl) {
			this.sshPreviewEl.textContent = buildSshCommandPreview(this.drawer.draft);
		}
		this.updateDrawerFooter();
	}

	private updateDrawerFooter(): void {
		if (!this.drawer) {
			return;
		}
		const dirty = this.isDrawerDirty();
		this.drawerEl.classList.toggle('is-dirty', dirty);
		this.dirtyDotEl?.classList.toggle('visible', dirty);
		if (this.drawerTestBtn) {
			const host = this.drawerHost;
			const testing = !!host && this.testingIds.has(host.id);
			this.drawerTestBtn.disabled = dirty || testing || !host;
			this.drawerTestBtn.title = dirty ? localize('adeChSaveToTest', "Save to test") : '';
			this.drawerTestBtn.dataset.state = testing ? 'testing' : (host && this.flashStates.get(host.id)) || 'idle';
		}
	}

	private async saveDrawer(): Promise<void> {
		const drawer = this.drawer;
		if (!drawer) {
			return;
		}
		const existingHost = this.drawerHost;
		const draft = drawer.draft;
		try {
			const parsedPort = Number(draft.port) || 22;
			const previousAlias = existingHost?.alias;
			const saved = await this.backend.upsertHost({
				id: existingHost?.id,
				name: draft.name.trim() || draft.hostName.trim(),
				alias: draft.alias.trim() || draft.name.trim() || draft.hostName.trim(),
				hostName: draft.hostName.trim(),
				user: draft.user.trim() || undefined,
				port: parsedPort,
				os: draft.os,
				identityFile: draft.identityFile,
				proxyJump: draft.proxyJump,
				strictHostKeyChecking: draft.strictHostKeyChecking || undefined,
				defaultDirectory: draft.defaultDirectory,
				notes: draft.notes,
			});
			if (previousAlias && previousAlias.toLowerCase() !== saved.alias.toLowerCase()) {
				this.adeProjects.migrateCloudHostAlias?.(previousAlias, saved.alias);
				void this.commandService?.executeCommand?.('aexus.agentEngines.invalidateCloudHost', previousAlias, saved.alias);
			} else {
				void this.commandService?.executeCommand?.('aexus.agentEngines.invalidateCloudHost', saved.alias);
			}
			this.selectedHostId = saved.id;
			const fresh = hostToDraftForm(saved);
			this.drawer = { hostId: saved.id, baseline: { ...fresh }, draft: { ...fresh }, externalChange: false };
			this.setBanner('ok', localize('adeChSavedHostMsg', "Saved Cloud Host '{0}' ({1}).", saved.name, formatCloudHostTargetBadge(saved)));
			await this.reloadHosts();
			if (this.drawer?.hostId === saved.id) {
				this.renderDrawer();
			}
		} catch (err) {
			this.setBanner('err', err instanceof Error ? err.message : String(err));
		}
	}

	//#endregion

	override focus(): void {
		super.focus();
		if (this.drawer) {
			this.drawerFirstInputEl?.focus({ preventScroll: true });
			this.rootEl.scrollLeft = 0;
			return;
		}
		const selected = this.selectedHostId ? this.cards.get(this.selectedHostId)?.el : undefined;
		(selected ?? this.searchInputEl)?.focus();
	}

	layout(dimension: Dimension): void {
		this.rootEl.style.width = `${dimension.width}px`;
		this.rootEl.style.height = `${dimension.height}px`;
	}
}
