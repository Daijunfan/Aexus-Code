/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension, EventType, findParentWithClass, getWindow } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ExtensionKeyedWebviewOriginStore, IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../webview/browser/webview.js';
import { WebviewWindowDragMonitor } from '../../webview/browser/webviewWindowDragMonitor.js';
import { IWebviewViewService, WebviewView } from '../../webviewView/browser/webviewViewService.js';
import { formatProjectDisplayPath } from '../../../../platform/ade/common/adeCloudHosts.js';
import { ADE_SECRETARY_ID, ADE_SESSION_SCHEME, AdeSessionRank, IAdeAgent, IAdeEditorService, IAdeProjectsService, resolveAdeAgentRank } from '../common/ade.js';
import { IAdeSessionsService } from './adeSessionsService.js';

/** Ordered steps shown while a lazy Agent session is materialized. */
export type AdeSessionWarmupStep = 'spawning' | 'binding' | 'syncing';

export const ADE_SESSION_WARMUP_STEPS: readonly AdeSessionWarmupStep[] = ['spawning', 'binding', 'syncing'];

export interface IAdeSessionWarmupState {
	/** The active step, or `error` when materialization failed. */
	readonly step: AdeSessionWarmupStep | 'error';
	/** The step that was running when the failure happened. */
	readonly failedStep?: AdeSessionWarmupStep;
	readonly engineName?: string;
	readonly error?: string;
}

export function formatAdeRankLabel(rank: AdeSessionRank): string {
	switch (rank) {
		case 'governor':
			return localize('adeSessionRankGovernor', "Governor");
		case 'manager':
			return localize('adeSessionRankManager', "Manager");
		case 'employee':
			return localize('adeSessionRankEmployee', "Employee");
		case 'subordinate':
			return localize('adeSessionRankMember', "Member");
		case 'worker':
			return localize('adeSessionRankWorker', "Worker");
	}
}

function formatAdeRankTier(rank: AdeSessionRank): string {
	switch (rank) {
		case 'governor':
			return 'L1';
		case 'manager':
			return 'L2';
		case 'employee':
		case 'subordinate':
			return 'L3';
		case 'worker':
			return 'L4';
	}
}

export interface IAdeAgentLineage {
	readonly projectName: string;
	/** Supervisors from the top-level session down to the direct parent. */
	readonly ancestors: readonly IAdeAgent[];
	readonly rank: AdeSessionRank;
}

export function resolveAdeAgentLineage(projects: IAdeProjectsService, agent: IAdeAgent): IAdeAgentLineage {
	const ancestors: IAdeAgent[] = [];
	const seen = new Set<string>([agent.id]);
	for (let cursor = agent.parentId ? projects.getAgent(agent.parentId) : undefined; cursor && !seen.has(cursor.id); cursor = cursor.parentId ? projects.getAgent(cursor.parentId) : undefined) {
		seen.add(cursor.id);
		ancestors.unshift(cursor);
	}
	return {
		projectName: projects.getProjectName(agent.projectUri),
		ancestors,
		rank: resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id)),
	};
}

/** Formats the compact `Project › Supervisor › Role` lineage used for editor descriptions and tooltips. */
export function formatAdeAgentLineage(projects: IAdeProjectsService, agent: IAdeAgent): string {
	const lineage = resolveAdeAgentLineage(projects, agent);
	const parts = [lineage.projectName];
	const supervisor = lineage.ancestors.at(-1);
	if (supervisor) {
		parts.push(supervisor.label);
	}
	parts.push(formatAdeRankLabel(lineage.rank));
	return parts.filter(Boolean).join(' \u203A ');
}

export class AdeSessionEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeSession';
	override readonly resource: URI;

	private _warmup: IAdeSessionWarmupState | undefined;
	private readonly _onDidChangeWarmup = this._register(new Emitter<void>());
	/** Fires whenever the lazy warm-up state changes. */
	readonly onDidChangeWarmup = this._onDidChangeWarmup.event;
	private retryHandler: (() => void) | undefined;

	constructor(readonly agentId: string, @IAdeProjectsService private readonly projects: IAdeProjectsService) {
		super();
		this.resource = URI.from({ scheme: ADE_SESSION_SCHEME, path: `/${agentId}` });
		this._register(projects.onDidChange(() => this._onDidChangeLabel.fire()));
	}

	get warmup(): IAdeSessionWarmupState | undefined {
		return this._warmup;
	}

	get canRetry(): boolean {
		return Boolean(this.retryHandler);
	}

	setWarmup(state: IAdeSessionWarmupState | undefined, retry?: () => void): void {
		this._warmup = state;
		this.retryHandler = state?.step === 'error' ? retry : undefined;
		this._onDidChangeWarmup.fire();
		this._onDidChangeLabel.fire();
	}

	retry(): void {
		const handler = this.retryHandler;
		this.retryHandler = undefined;
		handler?.();
	}

	override getDescription(): string | undefined {
		if (!this.agentId || this.agentId === ADE_SECRETARY_ID) {
			return undefined;
		}
		const agent = this.projects.getAgent(this.agentId);
		return agent ? formatAdeAgentLineage(this.projects, agent) : undefined;
	}

	override get typeId(): string {
		return AdeSessionEditorInput.ID;
	}

	override getName(): string {
		if (this.agentId === ADE_SECRETARY_ID) {
			return this.projects.secretary.label;
		}
		return this.agentId ? this.projects.getAgent(this.agentId)?.label ?? localize('agentSession', "Agent Session") : localize('ade', "ADE");
	}

	override matches(other: EditorInput): boolean {
		return other instanceof AdeSessionEditorInput && other.agentId === this.agentId;
	}
}

export class AdeSessionEditorSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof AdeSessionEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		return input instanceof AdeSessionEditorInput ? input.agentId : undefined;
	}

	deserialize(instantiationService: IInstantiationService, agentId: string): EditorInput {
		return instantiationService.createInstance(AdeSessionEditorInput, agentId);
	}
}

function formatWarmupStep(step: AdeSessionWarmupStep): string {
	switch (step) {
		case 'spawning':
			return localize('adeWarmupStepSpawning', "Spawning engine");
		case 'binding':
			return localize('adeWarmupStepBinding', "Binding session");
		case 'syncing':
			return localize('adeWarmupStepSyncing', "Syncing role context");
	}
}

export class AdeSessionEditor extends EditorPane {
	static readonly ID = 'workbench.editor.adeSession';
	private container!: HTMLElement;
	private draftInput: HTMLTextAreaElement | undefined;
	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly sessions: IAdeSessionsService | undefined;
	private readonly adeEditors: IAdeEditorService | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(AdeSessionEditor.ID, group, telemetryService, themeService, storageService);
		[this.sessions, this.adeEditors] = instantiationService.invokeFunction(accessor => {
			let sessions: IAdeSessionsService | undefined;
			let editors: IAdeEditorService | undefined;
			try { sessions = accessor.get(IAdeSessionsService); } catch { sessions = undefined; }
			try { editors = accessor.get(IAdeEditorService); } catch { editors = undefined; }
			return [sessions, editors] as const;
		});
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.ade-session-editor', { tabindex: -1 }));
	}

	override async setInput(input: AdeSessionEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();
		clearNode(this.container);
		this.container.classList.remove('has-header');
		this.draftInput = undefined;

		if (input.agentId === ADE_SECRETARY_ID) {
			this.renderSecretaryDraft();
			return;
		}

		const agent = this.projects.getAgent(input.agentId);
		if (!agent) {
			append(this.container, $('h2', {}, localize('ade', "ADE")));
			append(this.container, $('p', {}, input.agentId ? localize('sessionRemoved', "This Agent session has been removed.") : localize('adeWelcome', "Start a session in the left sidebar to begin.")));
			return;
		}
		this.container.classList.add('has-header');
		const header = append(this.container, $('div.ade-session-header'));
		this.renderLineageHeader(header, agent.id);
		this.inputDisposables.add(this.projects.onDidChange(() => {
			if (this.projects.getAgent(agent.id)) {
				this.renderLineageHeader(header, agent.id);
			}
		}));
		const body = append(this.container, $('div.ade-session-body'));
		const heading = append(body, $('h2', {}, agent.label));
		this.inputDisposables.add(this.projects.onDidChange(() => {
			heading.textContent = this.projects.getAgent(agent.id)?.label ?? localize('agentSession', "Agent Session");
		}));
		append(body, $('p.ade-project-path', {}, formatProjectDisplayPath(agent.projectUri)));

		const warmupHost = append(body, $('div.ade-session-warmup-host'));
		const renderWarmup = () => this.renderWarmup(warmupHost, input);
		renderWarmup();
		this.inputDisposables.add(input.onDidChangeWarmup(renderWarmup));

		const statusEl = append(body, $('div.ade-agent-status', { role: 'status' }, localize('connectAgentDescription', "Connect this draft to a new or existing Coding Agent conversation. Your draft will be kept.")));
		const syncStatusVisibility = () => { statusEl.hidden = Boolean(input.warmup); };
		syncStatusVisibility();
		this.inputDisposables.add(input.onDidChangeWarmup(syncStatusVisibility));
		append(body, $('div.ade-conversation-empty', {}, agent.parentId ? localize('emptyChildConversation', "This subordinate Agent has its own conversation and draft.") : localize('emptyConversation', "This is a project conversation. Subordinate Agent conversations appear nested beneath it.")));
		const composer = append(body, $('div.ade-composer'));
		const draft = this.draftInput = append(composer, $('textarea.ade-draft', {
			'aria-label': localize('agentDraft', "Agent Message Draft"),
			placeholder: localize('agentDraftPlaceholder', "Write a task for this Agent…"),
		}));
		draft.value = agent.draft;
		this.inputDisposables.add(addDisposableListener(draft, EventType.INPUT, () => this.projects.setDraft(agent.id, draft.value)));
		const connect = this.inputDisposables.add(new Button(composer, defaultButtonStyles));
		connect.label = localize('connectConversation', "Connect Conversation...");
		this.inputDisposables.add(connect.onDidClick(() => {
			void this.commandService.executeCommand('workbench.action.ade.connectAgent', agent.id);
		}));
	}

	private renderLineageHeader(header: HTMLElement, agentId: string): void {
		clearNode(header);
		const agent = this.projects.getAgent(agentId);
		if (!agent) {
			return;
		}
		const lineage = resolveAdeAgentLineage(this.projects, agent);
		const crumbs = append(header, $('nav.ade-session-breadcrumbs', { 'aria-label': localize('adeSessionLineageAria', "Session Lineage") }));
		const addSeparator = () => append(crumbs, $('span.ade-session-crumb-sep', { 'aria-hidden': 'true' }, '\u203A'));
		const projectCrumb = append(crumbs, $('span.ade-session-crumb.project', { title: formatProjectDisplayPath(agent.projectUri) }));
		const projectIcon = append(projectCrumb, $('span.ade-session-crumb-icon', { 'aria-hidden': 'true' }));
		projectIcon.classList.add(...ThemeIcon.asClassNameArray(agent.projectUri.scheme === 'file' ? Codicon.folder : Codicon.remote));
		append(projectCrumb, $('span', {}, lineage.projectName));

		// Collapse the middle of deep chains: Project › Top › … › Parent › Current
		const ancestors = lineage.ancestors;
		const visible: (IAdeAgent | 'ellipsis')[] = ancestors.length > 2
			? [ancestors[0], 'ellipsis', ancestors[ancestors.length - 1]]
			: [...ancestors];
		for (const entry of visible) {
			addSeparator();
			if (entry === 'ellipsis') {
				const hidden = ancestors.slice(1, -1).map(a => a.label).join(' \u203A ');
				append(crumbs, $('span.ade-session-crumb.ellipsis', { title: hidden }, '\u2026'));
				continue;
			}
			const ancestorRank = resolveAdeAgentRank(entry, this.projects.hasSubordinates(entry.id));
			const crumb = append(crumbs, $(`button.ade-session-crumb.ancestor.rank-${ancestorRank}`, {
				type: 'button',
				title: localize('adeSessionOpenAncestor', "Open {0} ({1})", entry.label, formatAdeRankLabel(ancestorRank)),
			}, entry.label));
			this.inputDisposables.add(addDisposableListener(crumb, EventType.CLICK, () => {
				void this.adeEditors?.openAgent(entry.id);
			}));
		}
		addSeparator();
		append(crumbs, $(`span.ade-session-crumb.current.rank-${lineage.rank}`, { 'aria-current': 'page' }, agent.label));

		append(header, $(`span.ade-session-rank-pill.rank-${lineage.rank}`, { 'data-tier': formatAdeRankTier(lineage.rank) }, formatAdeRankLabel(lineage.rank)));

		const trailing = append(header, $('div.ade-session-header-trailing'));
		const engineId = agent.session?.engineId ?? agent.preferredEngineId;
		if (engineId) {
			const engineName = this.sessions?.getEngineName(engineId) ?? engineId;
			const chip = append(trailing, $(`span.ade-session-engine-chip.status-${agent.status}`, {
				title: agent.session
					? localize('adeSessionEngineConnected', "{0} · Connected", engineName)
					: localize('adeSessionEngineLazy', "{0} · Starts on first open", engineName),
			}));
			append(chip, $('span.ade-session-engine-dot', { 'aria-hidden': 'true' }));
			append(chip, $('span', {}, engineName));
		}
		const subordinates = this.projects.getDirectSubordinates(agent.id).length;
		if (subordinates > 0) {
			const subPill = append(trailing, $('span.ade-session-subordinates-pill'));
			const subIcon = append(subPill, $('span', { 'aria-hidden': 'true' }));
			subIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.typeHierarchySub));
			append(subPill, $('span', {}, subordinates === 1
				? localize('adeSessionOneSubordinate', "1 subordinate")
				: localize('adeSessionSubordinates', "{0} subordinates", subordinates)));
		}
	}

	private renderWarmup(host: HTMLElement, input: AdeSessionEditorInput): void {
		clearNode(host);
		const state = input.warmup;
		host.hidden = !state;
		if (!state) {
			return;
		}
		const isError = state.step === 'error';
		const panel = append(host, $(`div.ade-session-warmup${isError ? '.error' : ''}`, {
			role: isError ? 'alert' : 'status',
			'aria-live': 'polite',
		}));
		const title = append(panel, $('div.ade-session-warmup-title'));
		const titleIcon = append(title, $('span.ade-session-warmup-title-icon', { 'aria-hidden': 'true' }));
		titleIcon.classList.add(...ThemeIcon.asClassNameArray(isError ? Codicon.error : ThemeIcon.modify(Codicon.loading, 'spin')));
		append(title, $('span', {}, isError
			? localize('adeWarmupFailedTitle', "Couldn't start this session")
			: state.engineName
				? localize('adeWarmupTitleEngine', "Starting {0}…", state.engineName)
				: localize('adeWarmupTitle', "Starting session…")));

		const activeStep = isError ? state.failedStep : state.step;
		const activeIndex = activeStep ? ADE_SESSION_WARMUP_STEPS.indexOf(activeStep) : -1;
		const steps = append(panel, $('ol.ade-session-warmup-steps'));
		ADE_SESSION_WARMUP_STEPS.forEach((step, index) => {
			const status = index < activeIndex ? 'done' : index === activeIndex ? (isError ? 'failed' : 'active') : 'pending';
			const li = append(steps, $(`li.ade-session-warmup-step.${status}`, status === 'active' ? { 'aria-current': 'step' } : {}));
			const marker = append(li, $('span.ade-session-warmup-step-marker', { 'aria-hidden': 'true' }));
			if (status === 'done') {
				marker.classList.add(...ThemeIcon.asClassNameArray(Codicon.check));
			} else if (status === 'failed') {
				marker.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
			} else {
				marker.textContent = String(index + 1);
			}
			append(li, $('span.ade-session-warmup-step-label', {}, formatWarmupStep(step)));
		});
		if (!isError) {
			append(panel, $('div.ade-session-warmup-bar', { 'aria-hidden': 'true' }));
			return;
		}
		if (state.error) {
			append(panel, $('div.ade-session-warmup-error', {}, state.error));
		}
		const actions = append(panel, $('div.ade-session-warmup-actions'));
		if (input.canRetry) {
			const retry = this.inputDisposables.add(new Button(actions, defaultButtonStyles));
			retry.label = localize('adeWarmupRetry', "Retry");
			this.inputDisposables.add(retry.onDidClick(() => input.retry()));
		}
		const connect = this.inputDisposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		connect.label = localize('adeWarmupConnectOther', "Connect Another Conversation...");
		this.inputDisposables.add(connect.onDidClick(() => {
			void this.commandService.executeCommand('workbench.action.ade.connectAgent', input.agentId);
		}));
	}

	private renderSecretaryDraft(): void {
		append(this.container, $('h2', {}, this.projects.secretary.label));
		append(this.container, $('p.ade-project-path', {}, localize('secretarySubtitle', "Global ADE Viewport & Macro Controller")));
		append(this.container, $('div.ade-agent-status', { role: 'status' }, localize('connectSecretaryDescription', "Connect Secretary to a Coding Agent engine to inspect live ADE viewport state, manage ADE projects and inspector views, and orchestrate ADE sessions and organizational hierarchies via aexus-ade.")));
		append(this.container, $('div.ade-conversation-empty', {}, localize('secretaryDraftHint', "Write instructions below or connect an engine to begin.")));
		const composer = append(this.container, $('div.ade-composer'));
		const draft = this.draftInput = append(composer, $('textarea.ade-draft', {
			'aria-label': localize('secretaryDraft', "Secretary Message Draft"),
			placeholder: localize('secretaryDraftPlaceholder', "Ask Secretary to inspect projects, organize sessions, or coordinate work…"),
		}));
		draft.value = this.projects.secretary.draft;
		this.inputDisposables.add(addDisposableListener(draft, EventType.INPUT, () => this.projects.setSecretaryDraft(draft.value)));
		const connect = this.inputDisposables.add(new Button(composer, defaultButtonStyles));
		connect.label = localize('connectSecretaryEngine', "Connect Secretary Engine...");
		this.inputDisposables.add(connect.onDidClick(() => {
			void this.commandService.executeCommand('workbench.action.ade.configureSecretary');
		}));
	}

	override clearInput(): void {
		this.inputDisposables.clear();
		this.draftInput = undefined;
		super.clearInput();
	}

	override focus(): void {
		(this.draftInput ?? this.container).focus();
	}

	layout(dimension: Dimension): void {
		this.container.style.height = `${dimension.height}px`;
		this.container.style.width = `${dimension.width}px`;
	}
}

export class AdeExtensionWebviewEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeExtensionWebview';
	override readonly resource: URI;

	constructor(
		readonly agentId: string,
		readonly viewId: string,
		readonly extensionId: string,
		readonly engineId: string,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
		@IAdeSessionsService private readonly sessions: IAdeSessionsService,
	) {
		super();
		this.resource = URI.from({ scheme: ADE_SESSION_SCHEME, authority: 'native-webview', path: `/${agentId}` });
		this._register(projects.onDidChange(() => this._onDidChangeLabel.fire()));
	}

	override get typeId(): string {
		return AdeExtensionWebviewEditorInput.ID;
	}

	override getName(): string {
		return this.projects.getAgent(this.agentId)?.label ?? localize('agentNativeSession', "Agent Session");
	}

	override getIcon(): ThemeIcon | URI | undefined {
		return this.sessions.getIcon(this.engineId);
	}

	override matches(other: EditorInput): boolean {
		return other instanceof AdeExtensionWebviewEditorInput && other.agentId === this.agentId && other.viewId === this.viewId;
	}
}

interface ISerializedExtensionWebview {
	readonly agentId: string;
	readonly viewId: string;
	readonly extensionId: string;
	readonly engineId: string;
}

export class AdeExtensionWebviewEditorSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof AdeExtensionWebviewEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		if (!(input instanceof AdeExtensionWebviewEditorInput)) {
			return undefined;
		}
		const payload: ISerializedExtensionWebview = {
			agentId: input.agentId,
			viewId: input.viewId,
			extensionId: input.extensionId,
			engineId: input.engineId,
		};
		return JSON.stringify(payload);
	}

	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput | undefined {
		try {
			const parsed = JSON.parse(raw) as ISerializedExtensionWebview;
			if (!parsed.agentId || !parsed.viewId || !parsed.extensionId) {
				return undefined;
			}
			return instantiationService.createInstance(AdeExtensionWebviewEditorInput, parsed.agentId, parsed.viewId, parsed.extensionId, parsed.engineId ?? '');
		} catch {
			return undefined;
		}
	}
}

export class AdeExtensionWebviewEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.adeExtensionWebview';
	private static originStore?: ExtensionKeyedWebviewOriginStore;

	private static getOriginStore(storageService: IStorageService): ExtensionKeyedWebviewOriginStore {
		this.originStore ??= new ExtensionKeyedWebviewOriginStore('webviewViews.origins', storageService);
		return this.originStore;
	}

	private container!: HTMLElement;
	private rootContainer: HTMLElement | undefined;
	private readonly webview = this._register(new MutableDisposable<IOverlayWebview>());
	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly visibilityEmitter = this._register(new Emitter<boolean>());
	private readonly disposeEmitter = this._register(new Emitter<void>());
	private activeViewKey: string | undefined;
	private isTearingDown = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IWebviewViewService private readonly webviewViewService: IWebviewViewService,
	) {
		super(AdeExtensionWebviewEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.ade-native-webview-host', { tabindex: 0, role: 'document' }));
		this._register(addDisposableListener(this.container, EventType.FOCUS, event => {
			if (event.target === this.container) {
				this.webview.value?.focus();
			}
		}));
	}

	override async setInput(input: AdeExtensionWebviewEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const nextKey = `${input.agentId}:${input.viewId}`;
		if (this.activeViewKey === nextKey && this.webview.value) {
			this.webview.value.claim(this, getWindow(this.container), undefined);
			this.layoutWebview();
			return;
		}

		this.teardownWebview();
		this.activeViewKey = nextKey;

		const extId = new ExtensionIdentifier(input.extensionId);
		const origin = AdeExtensionWebviewEditorPane.getOriginStore(this.storageService).getOrigin(input.viewId, extId);
		const overlay = this.webviewService.createWebviewOverlay({
			origin,
			providedViewType: input.viewId,
			title: input.getName(),
			options: { purpose: WebviewContentPurpose.WebviewView, retainContextWhenHidden: true },
			contentOptions: {},
			extension: { id: extId },
		});
		const stateKey = `aexus.ade.webviewState.${input.agentId}.${input.viewId}`;
		overlay.state = this.storageService.get(stateKey, StorageScope.PROFILE);
		this.webview.value = overlay;
		this.inputDisposables.add(toDisposable(() => overlay.release(this)));
		this.inputDisposables.add(overlay.onDidUpdateState(() => {
			if (overlay.state !== undefined) {
				this.storageService.store(stateKey, overlay.state, StorageScope.PROFILE, StorageTarget.MACHINE);
			}
		}));
		this.inputDisposables.add(new WebviewWindowDragMonitor(getWindow(this.container), () => this.webview.value));

		overlay.claim(this, getWindow(this.container), undefined);
		this.layoutWebview();

		const cts = this.inputDisposables.add(new CancellationTokenSource(token));
		this.inputDisposables.add(toDisposable(() => cts.cancel()));

		try {
			await this.extensionService.activateByEvent(`onView:${input.viewId}`);
			if (cts.token.isCancellationRequested) {
				return;
			}

			let currentTitle: string | undefined = input.getName();
			let currentDescription: string | undefined;
			const webviewView: WebviewView = {
				webview: overlay,
				onDidChangeVisibility: this.visibilityEmitter.event,
				onDispose: this.disposeEmitter.event,
				get title() { return currentTitle; },
				set title(val: string | undefined) { currentTitle = val; },
				get description() { return currentDescription; },
				set description(val: string | undefined) { currentDescription = val; },
				get badge() { return undefined; },
				set badge(_val) { },
				dispose: () => this.resetWebviewState(),
				show: () => overlay.focus(),
			};

			await this.webviewViewService.resolve(input.viewId, webviewView, cts.token);
		} catch {
			// Ignore resolution or activation cancellation errors while switching editors.
		}
		this.layoutWebview();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.visibilityEmitter.fire(visible);
		if (visible) {
			this.webview.value?.claim(this, getWindow(this.container), undefined);
			this.layoutWebview();
		} else {
			this.webview.value?.release(this);
		}
	}

	private resetWebviewState(): void {
		this.activeViewKey = undefined;
		this.inputDisposables.clear();
		this.webview.clear();
	}

	private teardownWebview(): void {
		if (this.isTearingDown) {
			return;
		}
		const hadWebview = Boolean(this.webview.value || this.activeViewKey);
		this.isTearingDown = true;
		try {
			if (hadWebview) {
				this.disposeEmitter.fire();
			}
			this.resetWebviewState();
		} finally {
			this.isTearingDown = false;
		}
	}

	override clearInput(): void {
		this.teardownWebview();
		super.clearInput();
	}

	override focus(): void {
		this.webview.value?.focus();
	}

	private layoutWebview(): void {
		const overlay = this.webview.value;
		if (!this.container || !overlay) {
			return;
		}
		if (!this.rootContainer || !this.rootContainer.isConnected) {
			this.rootContainer = findParentWithClass(this.container, 'monaco-scrollable-element') ?? undefined;
		}
		overlay.setAnchorElement(this.container, this.rootContainer);
	}

	layout(dimension: Dimension): void {
		this.container.style.width = `${dimension.width}px`;
		this.container.style.height = `${dimension.height}px`;
		this.layoutWebview();
	}

	override dispose(): void {
		this.teardownWebview();
		super.dispose();
	}
}
