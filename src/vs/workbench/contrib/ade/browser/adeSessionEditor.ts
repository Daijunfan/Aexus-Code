/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension, EventType, findParentWithClass, getWindow } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
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
import { ADE_SECRETARY_ID, ADE_SESSION_SCHEME, IAdeProjectsService } from '../common/ade.js';
import { IAdeSessionsService } from './adeSessionsService.js';

export class AdeSessionEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeSession';
	override readonly resource: URI;

	constructor(readonly agentId: string, @IAdeProjectsService private readonly projects: IAdeProjectsService) {
		super();
		this.resource = URI.from({ scheme: ADE_SESSION_SCHEME, path: `/${agentId}` });
		this._register(projects.onDidChange(() => this._onDidChangeLabel.fire()));
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

export class AdeSessionEditor extends EditorPane {
	static readonly ID = 'workbench.editor.adeSession';
	private container!: HTMLElement;
	private draftInput: HTMLTextAreaElement | undefined;
	private readonly inputDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(AdeSessionEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.ade-session-editor', { tabindex: -1 }));
	}

	override async setInput(input: AdeSessionEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();
		clearNode(this.container);
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
		const heading = append(this.container, $('h2', {}, agent.label));
		this.inputDisposables.add(this.projects.onDidChange(() => {
			heading.textContent = this.projects.getAgent(agent.id)?.label ?? localize('agentSession', "Agent Session");
		}));
		append(this.container, $('p.ade-project-path', {}, agent.projectUri.fsPath));
		append(this.container, $('div.ade-agent-status', { role: 'status' }, localize('connectAgentDescription', "Connect this draft to a new or existing Coding Agent conversation. Your draft will be kept.")));
		append(this.container, $('div.ade-conversation-empty', {}, agent.parentId ? localize('emptyChildConversation', "This subordinate Agent has its own conversation and draft.") : localize('emptyConversation', "This is a project conversation. Subordinate Agent conversations appear nested beneath it.")));
		const composer = append(this.container, $('div.ade-composer'));
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
