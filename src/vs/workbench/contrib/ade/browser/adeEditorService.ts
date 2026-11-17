/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { ChatModeKind } from '../../chat/common/constants.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import { ADE_SECRETARY_ID, IAdeAgent, IAdeEditorService, IAdeProjectsService } from '../common/ade.js';
import { buildAdeRoleSyncSnapshot } from './adeControlHandler.js';
import { AdeExtensionWebviewEditorInput, AdeSessionEditorInput } from './adeSessionEditor.js';
import { IAdeSessionsService } from './adeSessionsService.js';

const NATIVE_EXTENSION_MAP: Record<string, { readonly extensionId: string; readonly webviewViewId?: string }> = {
	'aexus-claude': { extensionId: 'anthropic.claude-code' },
	'aexus-codex': { extensionId: 'openai.chatgpt' },
	'aexus-opencode': { extensionId: 'zgy.opencode-vscode-ui' },
	'aexus-kilo': { extensionId: 'kilocode.kilo-code' },
	'aexus-cline': { extensionId: 'saoudrizwan.claude-dev', webviewViewId: 'claude-dev.SidebarProvider' },
	'aexus-dsh': { extensionId: 'fengze233.dsh-vscode-panel', webviewViewId: 'dsh.panel' },
	'aexus-antigravity': { extensionId: 'google.google-antigravity', webviewViewId: 'antigravity.panel' },
	'aexus-pi': { extensionId: 'yesho.pi-coding-agent-vscode', webviewViewId: 'piAgent.chat' },
};

export class AdeEditorService extends Disposable implements IAdeEditorService {
	declare readonly _serviceBrand: undefined;
	private readonly syncedAntigravityAgents = new Set<string>();
	private readonly editorToAgentId = new WeakMap<EditorInput, string>();
	private readonly agentIdToEditor = new Map<string, EditorInput>();
	private readonly activeSingletonAgentByView = new Map<string, string>();
	private readonly editorBindingDisposables = this._register(new DisposableStore());
	private isSelectingFromEditor = false;

	constructor(
		@IWorkbenchModeService private readonly modeService: IWorkbenchModeService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
		@IAdeSessionsService private readonly sessions: IAdeSessionsService,
		@IProjectNavigationService private readonly projectNavigation: IProjectNavigationService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@ICommandService private readonly commandService: ICommandService,
		@IPathService private readonly pathService: IPathService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super();
		this._register(projects.onDidChange(() => {
			this.updateTitles();
			void this.syncRoleContextToExtHost();
		}));
		this._register(modeService.onDidChangeMode(mode => {
			if (mode === 'ade') {
				this.updateTitles();
			}
			void this.syncRoleContextToExtHost();
		}));
		this._register(this.editorService.onDidActiveEditorChange(() => this.handleActiveEditorChanged()));
		void this.syncRoleContextToExtHost();
	}

	get activeEditor(): EditorInput | undefined {
		return this.editorGroupsService.mainPart.activeGroup.activeEditor ?? undefined;
	}

	getAgentIdForEditor(editor: EditorInput | undefined): string | undefined {
		if (!editor || editor.isDisposed()) {
			return undefined;
		}
		if (editor instanceof AdeSessionEditorInput) {
			return editor.agentId && editor.agentId !== ADE_SECRETARY_ID && this.projects.getAgent(editor.agentId)
				? editor.agentId
				: undefined;
		}
		if (editor instanceof AdeExtensionWebviewEditorInput) {
			return this.projects.getAgent(editor.agentId) ? editor.agentId : undefined;
		}
		if (editor instanceof ChatEditorInput) {
			const sessionKey = editor.sessionResource?.toString();
			if (!sessionKey || editor.sessionResource?.scheme === 'aexus-secretary') {
				return undefined;
			}
			if (sessionKey === this.projects.secretary.session?.resource.toString()) {
				return undefined;
			}
			return this.projects.agents.find(item => item.session?.resource.toString() === sessionKey)?.id;
		}
		const mapped = this.editorToAgentId.get(editor);
		return mapped && this.projects.getAgent(mapped) ? mapped : undefined;
	}

	private handleActiveEditorChanged(): void {
		const active = this.activeEditor;
		if (this.modeService.mode === 'ade' && active) {
			const agentId = this.getAgentIdForEditor(active);
			if (agentId && !this.isSelectingFromEditor) {
				this.isSelectingFromEditor = true;
				try {
					if (this.projects.selectedAgentId !== agentId) {
						this.projects.selectAgent(agentId);
					}
					this.projects.markRead(agentId);
				} finally {
					this.isSelectingFromEditor = false;
				}
			} else if (
				(active instanceof AdeSessionEditorInput && active.agentId === ADE_SECRETARY_ID)
				|| (active instanceof ChatEditorInput && (active.sessionResource?.scheme === 'aexus-secretary' || active.sessionResource?.toString() === this.projects.secretary.session?.resource.toString()))
			) {
				this.projects.markSecretaryRead();
			}
		}
		void this.syncRoleContextToExtHost();
	}

	private findOpenNativeEditor(agentId: string): { readonly editor: EditorInput; readonly group: IEditorGroup } | undefined {
		const tracked = this.agentIdToEditor.get(agentId);
		if (tracked && !tracked.isDisposed()) {
			for (const group of this.editorGroupsService.mainPart.groups) {
				if (group.editors.includes(tracked)) {
					return { editor: tracked, group };
				}
			}
		}
		if (tracked?.isDisposed()) {
			this.agentIdToEditor.delete(agentId);
		}
		return undefined;
	}

	private bindEditorToAgent(editor: EditorInput, agentId: string): void {
		const previous = this.agentIdToEditor.get(agentId);
		if (previous && previous !== editor) {
			this.editorToAgentId.delete(previous);
		}
		this.editorToAgentId.set(editor, agentId);
		this.agentIdToEditor.set(agentId, editor);
		const disposeListener = editor.onWillDispose(() => {
			this.editorBindingDisposables.delete(disposeListener);
			this.editorToAgentId.delete(editor);
			if (this.agentIdToEditor.get(agentId) === editor) {
				this.agentIdToEditor.delete(agentId);
			}
			void this.syncRoleContextToExtHost();
		});
		this.editorBindingDisposables.add(disposeListener);
	}

	private async syncRoleContextToExtHost(explicitActiveAgentId?: string): Promise<void> {
		try {
			const extId = new ExtensionIdentifier('vscode.aexus-agents');
			await this.extensionService.activateById(extId, { startup: false, extensionId: extId, activationEvent: 'api' }).catch(() => undefined);
			const snapshot = buildAdeRoleSyncSnapshot(this.modeService, this.projects, this, this.sessions, explicitActiveAgentId);
			await this.commandService.executeCommand('aexus.agentEngines.syncRoleContext', snapshot);
		} catch {
			// Ignore synchronization failures when Extension Host is unavailable (e.g. unit tests).
		}
	}

	isSessionActive(resource: URI): boolean {
		const target = resource.toString();
		return this.editorGroupsService.mainPart.groups.some(group => {
			const active = group.activeEditor;
			if (!active) {
				return false;
			}
			if (active instanceof ChatEditorInput) {
				if (active.sessionResource?.toString() === target) {
					return true;
				}
				if (active.sessionResource?.scheme === 'aexus-secretary' && this.projects.secretary.session?.resource.toString() === target) {
					return true;
				}
			}
			const agentId = this.getAgentIdForEditor(active);
			return Boolean(agentId && this.projects.getAgent(agentId)?.session?.resource.toString() === target);
		});
	}

	private resolveTargetGroup(side?: boolean): IEditorGroup {
		const part = this.editorGroupsService.mainPart;
		if (!side) {
			return part.activeGroup;
		}
		return part.findGroup({ direction: GroupDirection.RIGHT }, part.activeGroup)
			?? part.addGroup(part.activeGroup, GroupDirection.RIGHT);
	}

	private hasExtension(extensionId: string): boolean {
		return this.extensionService.extensions.some(ext => ExtensionIdentifier.equals(ext.identifier, extensionId));
	}

	private bindExtensionProject(extensionId: string, projectUri: URI): void {
		this.projects.selectProject(projectUri);
		this.projectNavigation.selectProject(projectUri);
		this.projectNavigation.bindCodingAgentProject(ExtensionIdentifier.toKey(extensionId));
	}

	private updateTitles(): void {
		const secretaryResource = this.projects.secretary.session?.resource.toString();
		for (const group of this.editorGroupsService.mainPart.groups) {
			for (const editor of group.editors) {
				if (editor instanceof ChatEditorInput) {
					const sessionKey = editor.sessionResource?.toString();
					if (editor.sessionResource?.scheme === 'aexus-secretary' || (secretaryResource && sessionKey === secretaryResource)) {
						editor.setTitleOverride(this.projects.secretary.label);
						continue;
					}
					const agent = this.projects.agents.find(item => item.session?.resource.toString() === sessionKey);
					editor.setTitleOverride(agent && agent.labelIsCustom !== false ? agent.label : undefined);
				}
			}
		}
	}

	private async tryOpenNativeExtensionEditor(agent: IAdeAgent, targetGroup: IEditorGroup, side?: boolean): Promise<boolean> {
		if (!agent.session) {
			return false;
		}
		const mapping = NATIVE_EXTENSION_MAP[agent.session.engineId];
		if (!mapping || !this.hasExtension(mapping.extensionId)) {
			return false;
		}

		targetGroup.focus();
		this.bindExtensionProject(mapping.extensionId, agent.projectUri);
		await this.syncRoleContextToExtHost(agent.id);
		const info = await this.sessions.getSessionInfo?.(agent.session);

		try {
			if (!mapping.webviewViewId) {
				const existing = this.findOpenNativeEditor(agent.id);
				if (existing) {
					await this.editorService.openEditor(existing.editor, { pinned: true }, side ? targetGroup.id : existing.group.id);
					await this.syncRoleContextToExtHost(agent.id);
					return true;
				}
			}

			const beforeEditors = new Set<EditorInput>();
			for (const group of this.editorGroupsService.mainPart.groups) {
				for (const editor of group.editors) {
					beforeEditors.add(editor);
				}
			}

			const bindNewlyOpenedEditor = async (): Promise<void> => {
				let openedEditor: EditorInput | undefined;
				for (const group of this.editorGroupsService.mainPart.groups) {
					for (const editor of group.editors) {
						if (!beforeEditors.has(editor) && !this.editorToAgentId.has(editor) && !(editor instanceof AdeSessionEditorInput)) {
							openedEditor = editor;
							break;
						}
					}
					if (openedEditor) {
						break;
					}
				}
				if (!openedEditor) {
					const active = this.editorGroupsService.mainPart.activeGroup.activeEditor ?? undefined;
					if (active && !this.editorToAgentId.has(active) && !(active instanceof AdeSessionEditorInput)) {
						openedEditor = active;
					}
				}
				if (openedEditor) {
					this.bindEditorToAgent(openedEditor, agent.id);
				}
				await this.syncRoleContextToExtHost(agent.id);
			};

			if (agent.session.engineId === 'aexus-claude') {
				const extId = new ExtensionIdentifier(mapping.extensionId);
				await this.extensionService.activateById(extId, { startup: false, extensionId: extId, activationEvent: 'api' }).catch(() => undefined);
				const sessionArg = info?.provisional || info?.unmaterialized ? undefined : info?.nativeId;
				await this.commandService.executeCommand(
					'claude-vscode.editor.open',
					sessionArg,
					agent.draft || undefined,
					side ? -2 : -1,
					undefined,
					true,
					{ programmatic: 'pin-to-panel' },
				);
				await bindNewlyOpenedEditor();
				return true;
			}

			if (agent.session.engineId === 'aexus-codex') {
				await this.extensionService.activateByEvent('onCustomEditor:chatgpt.conversationEditor').catch(() => undefined);
				const codexUri = URI.from({
					scheme: 'openai-codex',
					authority: 'route',
					path: info?.provisional || info?.unmaterialized || !info?.nativeId ? '/new' : `/local/${info.nativeId}`,
				});
				await this.editorService.openEditor({
					resource: codexUri,
					options: { override: 'chatgpt.conversationEditor', pinned: true },
				}, targetGroup.id);
				await bindNewlyOpenedEditor();
				return true;
			}

			if (agent.session.engineId === 'aexus-opencode') {
				await this.extensionService.activateByEvent('onView:opencode-ui.sessions').catch(() => undefined);
				await this.commandService.executeCommand('opencode-ui.refresh').catch(() => undefined);
				const prevEditor = targetGroup.activeEditor;
				const prevCount = targetGroup.editors.length;
				if (!info?.unmaterialized && !info?.provisional && info?.nativeId) {
					await this.commandService.executeCommand(
						'opencode-ui.openSessionById',
						{ workspaceId: agent.projectUri.toString(), dir: agent.projectUri.fsPath },
						info.nativeId,
					);
				} else {
					await this.commandService.executeCommand(
						'opencode-ui.newSessionAndOpen',
						{ workspaceId: agent.projectUri.toString() },
					);
				}
				const opened = targetGroup.activeEditor !== prevEditor || targetGroup.editors.length > prevCount;
				if (opened) {
					await bindNewlyOpenedEditor();
				}
				return opened;
			}

			if (agent.session.engineId === 'aexus-kilo') {
				await this.extensionService.activateByEvent('onView:kilo-code.SidebarProvider').catch(() => undefined);
				const prevEditor = targetGroup.activeEditor;
				const prevCount = targetGroup.editors.length;
				await this.commandService.executeCommand('kilo-code.new.openInTab');
				const opened = targetGroup.activeEditor !== prevEditor || targetGroup.editors.length > prevCount;
				if (opened) {
					await bindNewlyOpenedEditor();
				}
				return opened;
			}

			if (mapping.webviewViewId) {
				const singletonViewId = mapping.webviewViewId;
				const prevAgentId = this.activeSingletonAgentByView.get(singletonViewId);
				this.activeSingletonAgentByView.set(singletonViewId, agent.id);
				await this.closeEditors(editor => editor instanceof AdeExtensionWebviewEditorInput && editor.viewId === singletonViewId && editor.agentId !== agent.id);
				this.viewsService.closeView(singletonViewId);
				const input = this.instantiationService.createInstance(
					AdeExtensionWebviewEditorInput,
					agent.id,
					singletonViewId,
					mapping.extensionId,
					agent.session.engineId,
				);
				await this.editorService.openEditor(input, { pinned: true }, targetGroup.id);
				if (agent.session.engineId === 'aexus-antigravity' && (!this.syncedAntigravityAgents.has(agent.id) || prevAgentId !== agent.id)) {
					this.syncedAntigravityAgents.add(agent.id);
					if (!info?.provisional && !info?.unmaterialized && info?.nativeId) {
						void this.commandService.executeCommand('antigravity.openConversation', info.nativeId).catch(() => undefined);
					} else {
						void this.commandService.executeCommand('antigravity.startNewConversation', agent.projectUri.toString()).catch(() => undefined);
					}
				} else if (prevAgentId && prevAgentId !== agent.id) {
					if (agent.session.engineId === 'aexus-pi') {
						void this.commandService.executeCommand('piAgent.newSession').catch(() => undefined);
					} else if (agent.session.engineId === 'aexus-cline' && info?.provisional) {
						void this.commandService.executeCommand('cline.plusButtonClicked').catch(() => undefined);
					}
				}
				await this.syncRoleContextToExtHost(agent.id);
				return true;
			}
		} catch {
			// Fall back smoothly to standard ChatEditorInput if native extension invocation fails.
		}

		return false;
	}

	async openAgent(id: string, options?: { side?: boolean }): Promise<void> {
		const agent = this.projects.getAgent(id);
		if (agent) {
			this.projects.selectAgent(id);
			this.projects.markRead(id);
		}
		const targetGroup = this.resolveTargetGroup(options?.side);

		if (agent?.session && await this.tryOpenNativeExtensionEditor(agent, targetGroup, options?.side)) {
			if (agent.draft) {
				this.projects.setDraft(agent.id, '');
			}
			await this.closeEditors(editor => editor instanceof AdeSessionEditorInput && editor.agentId === id);
			return;
		}

		const input = agent?.session ? this.instantiationService.createInstance(ChatEditorInput, agent.session.resource, {
			title: { preferred: agent.label, override: agent.labelIsCustom !== false ? agent.label : undefined },
			modelInputState: agent.draft ? { attachments: [], mode: { id: 'agent', kind: ChatModeKind.Agent }, selectedModel: undefined, inputText: agent.draft, selections: [], contrib: {} } : undefined,
		}) : this.instantiationService.createInstance(AdeSessionEditorInput, id);
		await this.editorService.openEditor(input, { pinned: true }, targetGroup.id);
		this.updateTitles();
		if (agent?.session && agent.draft) {
			this.projects.setDraft(agent.id, '');
		}
		if (agent) {
			await this.closeEditors(editor => editor instanceof AdeSessionEditorInput && (!editor.agentId || (Boolean(agent.session) && editor.agentId === id)));
		}
	}

	async openSecretary(options?: { side?: boolean }): Promise<void> {
		this.projects.markSecretaryRead();
		let secretary = this.projects.secretary;
		if ((!secretary.session || secretary.session.resource.scheme !== 'aexus-secretary') && this.sessions.ensureSecretary) {
			const localProject = [
				this.projectNavigation.focusedProject?.uri,
				this.projects.selectedProject?.uri,
				this.projectNavigation.selectedProject?.uri,
				...this.projects.projects.map(project => project.uri),
			].find((uri): uri is URI => Boolean(uri && uri.scheme === Schemas.file));
			const cwd = localProject ?? this.pathService.userHome({ preferLocal: true });
			const ensured = await this.sessions.ensureSecretary(secretary.session?.engineId, cwd, false).catch(() => undefined);
			if (ensured) {
				this.projects.configureSecretary(ensured);
				secretary = this.projects.secretary;
			}
		}

		const targetGroup = this.resolveTargetGroup(options?.side);
		const input = secretary.session
			? this.instantiationService.createInstance(ChatEditorInput, secretary.session.resource, {
				title: { preferred: secretary.label, override: secretary.label },
				modelInputState: secretary.draft ? { attachments: [], mode: { id: 'agent', kind: ChatModeKind.Agent }, selectedModel: undefined, inputText: secretary.draft, selections: [], contrib: {} } : undefined,
			})
			: this.instantiationService.createInstance(AdeSessionEditorInput, ADE_SECRETARY_ID);
		await this.editorService.openEditor(input, { pinned: true }, targetGroup.id);
		this.updateTitles();
		if (secretary.session && secretary.draft) {
			this.projects.setSecretaryDraft('');
		}
		if (secretary.session) {
			await this.closeEditors(editor => editor instanceof AdeSessionEditorInput && editor.agentId === ADE_SECRETARY_ID);
		}
	}

	private async closeEditors(matches: (editor: EditorInput) => boolean): Promise<void> {
		await this.editorService.closeEditors(this.editorGroupsService.mainPart.groups.flatMap(group => group.editors.filter(matches).map(editor => ({ editor, groupId: group.id }))) ?? []);
	}

	async closeAgents(agents: readonly IAdeAgent[]): Promise<void> {
		const ids = new Set(agents.map(agent => agent.id));
		const resources = new Set(agents.flatMap(agent => agent.session ? [agent.session.resource.toString()] : []));
		await this.closeEditors(editor => {
			if (editor instanceof AdeSessionEditorInput || editor instanceof AdeExtensionWebviewEditorInput) {
				return ids.has(editor.agentId);
			}
			const mappedId = this.editorToAgentId.get(editor);
			if (mappedId && ids.has(mappedId)) {
				return true;
			}
			return editor instanceof ChatEditorInput && Boolean(editor.sessionResource) && resources.has(editor.sessionResource!.toString());
		});
		for (const id of ids) {
			this.agentIdToEditor.delete(id);
			for (const [viewId, activeId] of this.activeSingletonAgentByView) {
				if (activeId === id) {
					this.activeSingletonAgentByView.delete(viewId);
				}
			}
		}
	}

	async openFile(resource: URI, projectUriOrAgentId?: URI | string, options?: IEditorOptions): Promise<void> {
		if (URI.isUri(projectUriOrAgentId)) {
			this.projects.selectProject(projectUriOrAgentId);
		} else if (typeof projectUriOrAgentId === 'string') {
			this.projects.selectAgent(projectUriOrAgentId);
		} else {
			this.projects.selectProject(resource);
		}
		await this.editorService.openEditor({ resource, options: { pinned: true, ...options } }, this.editorGroupsService.mainPart.activeGroup.id);
	}

	async openDiff(original: URI, modified: URI, label?: string, projectUri?: URI, options?: IEditorOptions): Promise<void> {
		this.projects.selectProject(projectUri ?? modified);
		await this.editorService.openEditor({
			original: { resource: original },
			modified: { resource: modified },
			label,
			options: { pinned: true, ...options },
		}, this.editorGroupsService.mainPart.activeGroup.id);
	}
}
