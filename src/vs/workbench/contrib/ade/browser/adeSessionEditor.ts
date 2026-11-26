/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension, EventType, findParentWithClass, getWindow } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { formatProjectDisplayPath } from '../../../../platform/ade/common/adeCloudHosts.js';
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
import { ADE_SESSION_SCHEME, formatLevelLabel, IAdeAgent, IAdeEditorService, IAdeProjectsService } from '../common/ade.js';
import { adeBi, onDidChangeAdeLocale } from '../common/adeLocalization.js';
import { IAdeSessionsService } from './adeSessionsService.js';

/** Ordered steps shown while a lazy Agent session is materialized. */
export type AdeSessionWarmupStep = 'spawning' | 'binding';

export const ADE_SESSION_WARMUP_STEPS: readonly AdeSessionWarmupStep[] = ['spawning', 'binding'];

export interface IAdeSessionWarmupState {
	/** The active step, or `error` when materialization failed. */
	readonly step: AdeSessionWarmupStep | 'error';
	/** The step that was running when the failure happened. */
	readonly failedStep?: AdeSessionWarmupStep;
	readonly engineName?: string;
	readonly error?: string;
}

export interface IAdeAgentLineage {
	readonly projectName: string;
	/** Supervisors from the top-level L1 node down to the direct parent. */
	readonly ancestors: readonly IAdeAgent[];
	readonly levelLabel: string;
}

export function resolveAdeAgentLineage(projects: IAdeProjectsService, agent: IAdeAgent): IAdeAgentLineage {
	const ancestors: IAdeAgent[] = [];
	const seen = new Set<string>([agent.id]);
	for (
		let cursor = agent.parentId ? projects.getAgent(agent.parentId, agent.projectId) : undefined;
		cursor && !seen.has(cursor.id);
		cursor = cursor.parentId ? projects.getAgent(cursor.parentId, agent.projectId) : undefined
	) {
		seen.add(cursor.id);
		ancestors.unshift(cursor);
	}
	const page = projects.getProjectPage(agent.projectId);
	return {
		projectName: page?.name || projects.getProjectName(agent.projectUri),
		ancestors,
		levelLabel: formatLevelLabel(agent.level),
	};
}

/** Formats the compact `Project › Supervisor › LN` lineage used for editor descriptions and tooltips. */
export function formatAdeAgentLineage(projects: IAdeProjectsService, agent: IAdeAgent): string {
	const lineage = resolveAdeAgentLineage(projects, agent);
	const parts = [lineage.projectName];
	const supervisor = lineage.ancestors.at(-1);
	if (supervisor) {
		parts.push(supervisor.label);
	}
	parts.push(lineage.levelLabel);
	return parts.filter(Boolean).join(' \u203A ');
}

export class AdeSessionEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeSession';
	override readonly resource: URI;
	readonly projectId: string | undefined;

	private _warmup: IAdeSessionWarmupState | undefined;
	private readonly _onDidChangeWarmup = this._register(new Emitter<void>());
	readonly onDidChangeWarmup = this._onDidChangeWarmup.event;
	private retryHandler: (() => void) | undefined;
	private readonly _projects: IAdeProjectsService;

	constructor(
		readonly agentId: string,
		projectIdOrProjects?: string | IAdeProjectsService,
		@IAdeProjectsService injectedProjects?: IAdeProjectsService,
	) {
		super();
		const explicitProjectId = typeof projectIdOrProjects === 'string' ? projectIdOrProjects : undefined;
		const projects = (typeof projectIdOrProjects === 'object' && projectIdOrProjects !== null ? projectIdOrProjects : injectedProjects)!;
		this.projectId = explicitProjectId;
		this.resource = URI.from({
			scheme: ADE_SESSION_SCHEME,
			authority: explicitProjectId || undefined,
			path: `/${agentId}`,
		});
		this._projects = projects;
		this._register(projects.onDidChange(() => this._onDidChangeLabel.fire()));
		this._register(onDidChangeAdeLocale(() => this._onDidChangeLabel.fire()));
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
		if (!this.agentId || this.agentId.startsWith('__aexus_')) {
			return undefined;
		}
		const agent = this._projects.getAgent(this.agentId, this.projectId);
		return agent ? formatAdeAgentLineage(this._projects, agent) : undefined;
	}

	override get typeId(): string {
		return AdeSessionEditorInput.ID;
	}

	override getName(): string {
		return this.agentId
			? this._projects.getAgent(this.agentId, this.projectId)?.label ?? adeBi(localize('agentSession', "Agent Session"), '智能体会话')
			: adeBi(localize('ade', "ADE"), 'ADE');
	}

	override matches(other: EditorInput): boolean {
		return other instanceof AdeSessionEditorInput
			&& other.agentId === this.agentId
			&& (!this.projectId || !other.projectId || other.projectId === this.projectId);
	}
}

export class AdeSessionEditorSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof AdeSessionEditorInput && Boolean(input.agentId) && !input.agentId.startsWith('__aexus_');
	}

	serialize(input: EditorInput): string | undefined {
		if (!(input instanceof AdeSessionEditorInput) || !input.agentId || input.agentId.startsWith('__aexus_')) {
			return undefined;
		}
		return JSON.stringify({
			v: 2,
			agentId: input.agentId,
			...(input.projectId ? { projectId: input.projectId } : {}),
		});
	}

	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput | undefined {
		const trimmed = raw?.trim() ?? '';
		if (!trimmed || trimmed.startsWith('__aexus_')) {
			return undefined;
		}
		if (trimmed.startsWith('{')) {
			try {
				const parsed = JSON.parse(trimmed) as { v?: number; agentId?: string; projectId?: string };
				if (parsed.v !== 2 || !parsed.agentId || parsed.agentId.startsWith('__aexus_')) {
					return undefined;
				}
				return instantiationService.createInstance(AdeSessionEditorInput, parsed.agentId, parsed.projectId);
			} catch {
				return undefined;
			}
		}
		return instantiationService.createInstance(AdeSessionEditorInput, trimmed, undefined);
	}
}

function formatWarmupStep(step: AdeSessionWarmupStep): string {
	switch (step) {
		case 'spawning':
			return adeBi(localize('adeWarmupStepSpawning', "Spawning engine"), '正在启动引擎');
		case 'binding':
			return adeBi(localize('adeWarmupStepBinding', "Binding session"), '正在绑定会话');
	}
}

export class AdeSessionEditor extends EditorPane {
	static readonly ID = 'workbench.editor.adeSession';
	private container!: HTMLElement;
	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly sessions: IAdeSessionsService | undefined;
	private readonly adeEditors: IAdeEditorService | undefined;
	private activeSessionInput: AdeSessionEditorInput | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
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
		this._register(onDidChangeAdeLocale(() => {
			if (this.activeSessionInput && this.container) {
				this.renderSessionInput(this.activeSessionInput);
			}
		}));
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.ade-session-editor', { tabindex: -1 }));
	}

	override async setInput(input: AdeSessionEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.activeSessionInput = input;
		this.renderSessionInput(input);
	}

	private renderSessionInput(input: AdeSessionEditorInput): void {
		this.inputDisposables.clear();
		clearNode(this.container);
		this.container.classList.remove('has-header');

		const agent = this.projects.getAgent(input.agentId, input.projectId);
		if (!agent) {
			append(this.container, $('h2', {}, adeBi(localize('ade', "ADE"), 'ADE')));
			append(this.container, $('p', {}, input.agentId
				? adeBi(localize('sessionRemoved', "This Agent session has been removed."), '该智能体会话已被移除。')
				: adeBi(localize('adeWelcome', "Open a Project Page in the left sidebar to begin."), '请在左侧边栏打开 Project 页面开始协作。')));
			return;
		}
		this.container.classList.add('has-header');
		const header = append(this.container, $('div.ade-session-header'));
		this.renderLineageHeader(header, agent.id, agent.projectId);
		this.inputDisposables.add(this.projects.onDidChange(() => {
			if (this.projects.getAgent(agent.id, agent.projectId)) {
				this.renderLineageHeader(header, agent.id, agent.projectId);
			}
		}));
		const body = append(this.container, $('div.ade-session-body'));
		const heading = append(body, $('h2', {}, agent.label));
		this.inputDisposables.add(this.projects.onDidChange(() => {
			heading.textContent = this.projects.getAgent(agent.id, agent.projectId)?.label ?? adeBi(localize('agentSession', "Agent Session"), '智能体会话');
		}));
		append(body, $('p.ade-project-path', {}, formatProjectDisplayPath(agent.projectUri)));

		const warmupHost = append(body, $('div.ade-session-warmup-host'));
		const renderWarmup = () => this.renderWarmup(warmupHost, input);
		renderWarmup();
		this.inputDisposables.add(input.onDidChangeWarmup(renderWarmup));

		const openActionWrap = append(body, $('div.ade-composer'));
		const openBtn = this.inputDisposables.add(new Button(openActionWrap, defaultButtonStyles));
		openBtn.label = adeBi(localize('openAgentConversation', "Open Conversation"), '打开对话');
		this.inputDisposables.add(openBtn.onDidClick(() => {
			void this.adeEditors?.openAgent(agent.id, { projectId: agent.projectId });
		}));
	}

	private renderLineageHeader(header: HTMLElement, agentId: string, projectId: string): void {
		clearNode(header);
		const agent = this.projects.getAgent(agentId, projectId);
		if (!agent) {
			return;
		}
		const lineage = resolveAdeAgentLineage(this.projects, agent);
		const crumbs = append(header, $('nav.ade-session-breadcrumbs', { 'aria-label': adeBi(localize('adeSessionLineageAria', "Session Lineage"), '会话汇报链') }));
		const addSeparator = () => append(crumbs, $('span.ade-session-crumb-sep', { 'aria-hidden': 'true' }, '\u203A'));
		const projectCrumb = append(crumbs, $('span.ade-session-crumb.project', { title: formatProjectDisplayPath(agent.projectUri) }));
		const projectIcon = append(projectCrumb, $('span.ade-session-crumb-icon', { 'aria-hidden': 'true' }));
		projectIcon.classList.add(...ThemeIcon.asClassNameArray(agent.projectUri.scheme === 'file' ? Codicon.folder : Codicon.remote));
		append(projectCrumb, $('span', {}, lineage.projectName));

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
			const ancestorLevel = formatLevelLabel(entry.level);
			const crumb = append(crumbs, $('button.ade-session-crumb.ancestor', {
				type: 'button',
				title: adeBi(localize('adeSessionOpenAncestor', "Open {0} ({1})", entry.label, ancestorLevel), '打开 {0}（{1}）', entry.label, ancestorLevel),
			}, entry.label));
			this.inputDisposables.add(addDisposableListener(crumb, EventType.CLICK, () => {
				void this.adeEditors?.openAgent(entry.id, { projectId: entry.projectId });
			}));
		}
		addSeparator();
		append(crumbs, $('span.ade-session-crumb.current', { 'aria-current': 'page' }, agent.label));

		const clampedTier = Math.min(4, Math.max(1, agent.level));
		append(header, $(`span.ade-session-rank-pill.tier-${clampedTier}`, {}, lineage.levelLabel));

		const trailing = append(header, $('div.ade-session-header-trailing'));
		const engineId = agent.session.engineId || agent.engine;
		if (engineId) {
			const engineName = this.sessions?.getEngineName(engineId) ?? engineId;
			const chip = append(trailing, $(`span.ade-session-engine-chip.status-${agent.status ?? 'idle'}`, {
				title: agent.sessionStarted
					? adeBi(localize('adeSessionEngineConnected', "{0} · Connected", engineName), '{0} · 已连接', engineName)
					: adeBi(localize('adeSessionEngineLazy', "{0} · Starts on first turn", engineName), '{0} · 首轮对话时启动', engineName),
			}));
			append(chip, $('span.ade-session-engine-dot', { 'aria-hidden': 'true' }));
			append(chip, $('span', {}, engineName));
		}
		const subordinates = this.projects.agents.filter(a => a.projectId === agent.projectId && a.parentId === agent.id).length;
		if (subordinates > 0) {
			const subPill = append(trailing, $('span.ade-session-subordinates-pill'));
			const subIcon = append(subPill, $('span', { 'aria-hidden': 'true' }));
			subIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.typeHierarchySub));
			append(subPill, $('span', {}, subordinates === 1
				? adeBi(localize('adeSessionOneSubordinate', "1 subordinate"), '1 个下级')
				: adeBi(localize('adeSessionSubordinates', "{0} subordinates", subordinates), '{0} 个下级', subordinates)));
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
			? adeBi(localize('adeWarmupFailedTitle', "Couldn't start this session"), '无法启动该会话')
			: state.engineName
				? adeBi(localize('adeWarmupTitleEngine', "Starting {0}…", state.engineName), '正在启动 {0}…', state.engineName)
				: adeBi(localize('adeWarmupTitle', "Starting session…"), '正在启动会话…')));

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
		if (input.canRetry) {
			const actions = append(panel, $('div.ade-session-warmup-actions'));
			const retry = this.inputDisposables.add(new Button(actions, defaultButtonStyles));
			retry.label = adeBi(localize('adeWarmupRetry', "Retry"), '重试');
			this.inputDisposables.add(retry.onDidClick(() => input.retry()));
		}
	}

	override clearInput(): void {
		this.activeSessionInput = undefined;
		this.inputDisposables.clear();
		super.clearInput();
	}

	override focus(): void {
		this.container.focus();
	}

	layout(dimension: Dimension): void {
		this.container.style.height = `${dimension.height}px`;
		this.container.style.width = `${dimension.width}px`;
	}
}

export class AdeExtensionWebviewEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeExtensionWebview';
	private _projectId: string | undefined;
	private _resource: URI;

	private static buildResource(projectId: string | undefined, agentId: string): URI {
		const trimmedProjectId = projectId?.trim();
		return URI.from({
			scheme: ADE_SESSION_SCHEME,
			authority: 'native-webview',
			path: trimmedProjectId ? `/${trimmedProjectId}/${agentId}` : `/${agentId}`,
		});
	}

	constructor(
		readonly agentId: string,
		readonly viewId: string,
		readonly extensionId: string,
		readonly engineId: string,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
		@IAdeSessionsService private readonly sessions: IAdeSessionsService,
	) {
		super();
		this._resource = AdeExtensionWebviewEditorInput.buildResource(undefined, agentId);
		this._register(projects.onDidChange(() => this._onDidChangeLabel.fire()));
	}

	override get resource(): URI {
		return this._resource;
	}

	get projectId(): string | undefined {
		return this._projectId;
	}

	setProjectId(projectId: string | undefined): this {
		const next = projectId?.trim() || undefined;
		const nextResource = AdeExtensionWebviewEditorInput.buildResource(next, this.agentId);
		if (this._projectId !== next || this._resource.toString() !== nextResource.toString()) {
			this._projectId = next;
			this._resource = nextResource;
			this._onDidChangeLabel.fire();
		}
		return this;
	}

	override get typeId(): string {
		return AdeExtensionWebviewEditorInput.ID;
	}

	override getName(): string {
		return this.projects.getAgent(this.agentId, this.projectId)?.label ?? localize('agentNativeSession', "Agent Session");
	}

	override getIcon(): ThemeIcon | URI | undefined {
		return this.sessions.getIcon(this.engineId);
	}

	override matches(other: EditorInput): boolean {
		return other instanceof AdeExtensionWebviewEditorInput
			&& other.agentId === this.agentId
			&& other.viewId === this.viewId
			&& (this.projectId ?? '') === (other.projectId ?? '');
	}
}

interface ISerializedExtensionWebview {
	readonly agentId: string;
	readonly viewId: string;
	readonly extensionId: string;
	readonly engineId: string;
	readonly projectId?: string;
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
			...(input.projectId ? { projectId: input.projectId } : {}),
		};
		return JSON.stringify(payload);
	}

	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput | undefined {
		try {
			const parsed = JSON.parse(raw) as ISerializedExtensionWebview;
			if (!parsed.agentId || !parsed.viewId || !parsed.extensionId || parsed.agentId.startsWith('__aexus_')) {
				return undefined;
			}
			const input = instantiationService.createInstance(AdeExtensionWebviewEditorInput, parsed.agentId, parsed.viewId, parsed.extensionId, parsed.engineId ?? '');
			const restoredProjectId = typeof parsed.projectId === 'string' ? parsed.projectId.trim() : '';
			if (restoredProjectId) {
				input.setProjectId(restoredProjectId);
			}
			return input;
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
		const nextKey = `${input.projectId ?? ''}:${input.agentId}:${input.viewId}`;
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
		const stateKey = `aexus.ade.webviewState.${input.projectId ? `${input.projectId}.` : ''}${input.agentId}.${input.viewId}`;
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
