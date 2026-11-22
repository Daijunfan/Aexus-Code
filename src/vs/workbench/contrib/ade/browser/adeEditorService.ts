/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Verbosity } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { ChatModeKind } from '../../chat/common/constants.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import { ADE_SECRETARY_ID, IAdeAgent, IAdeEditorService, IAdeProjectsService } from '../common/ade.js';
import { onDidChangeAdeLocale } from '../common/adeLocalization.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { buildAdeRoleSyncSnapshot } from './adeControlHandler.js';
import { AdeCloudHostsEditorInput, AdeCloudHostsEditorPane } from './adeCloudHostsEditorPane.js';
import { AdeEngineeringEditorInput } from './adeEngineeringEditorPane.js';
import { AdeConfigEditorInput } from './adeConfigEditorPane.js';
import { AdeRoleStudioEditorInput, AdeRoleStudioEditorPane } from './adeRoleStudioEditorPane.js';
import { AdeExtensionWebviewEditorInput, AdeSessionEditorInput, AdeSessionWarmupStep, formatAdeAgentLineage } from './adeSessionEditor.js';
import { IAdeSessionsService } from './adeSessionsService.js';

/**
 * A {@link ChatEditorInput} for an ADE Agent session that surfaces the session's org-chart
 * lineage (`Project › Supervisor › Role`) as the editor description and in the tab tooltip.
 */
export class AdeLineageChatEditorInput extends ChatEditorInput {
	private lineageProvider: (() => string | undefined) | undefined;

	setLineageProvider(provider: (() => string | undefined) | undefined): void {
		this.lineageProvider = provider;
		this._onDidChangeLabel.fire();
	}

	refreshLineage(): void {
		this._onDidChangeLabel.fire();
	}

	override getDescription(verbosity?: Verbosity): string | undefined {
		return this.lineageProvider?.() ?? super.getDescription(verbosity);
	}

	override getTitle(verbosity?: Verbosity): string {
		const title = super.getTitle(verbosity);
		const lineage = verbosity === Verbosity.LONG ? this.lineageProvider?.() : undefined;
		return lineage ? `${title} \u2014 ${lineage}` : title;
	}
}

export class AdeEditorService extends Disposable implements IAdeEditorService {
	declare readonly _serviceBrand: undefined;
	private readonly editorToAgentId = new WeakMap<EditorInput, string>();
	private readonly agentIdToEditor = new Map<string, EditorInput>();
	private readonly activeSingletonAgentByView = new Map<string, string>();
	private isSelectingFromEditor = false;
	private roleSyncTimer: ReturnType<typeof setTimeout> | undefined;
	private lastSyncedSnapshotKey: string | undefined;
	private readonly roleSchemaService: IAdeRoleSchemaService | undefined;

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
	) {
		super();
		this.roleSchemaService = instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(IAdeRoleSchemaService);
			} catch {
				return undefined;
			}
		});
		this._register({
			dispose: () => {
				if (this.roleSyncTimer !== undefined) {
					clearTimeout(this.roleSyncTimer);
					this.roleSyncTimer = undefined;
				}
			},
		});
		if (this.roleSchemaService) {
			this._register(this.roleSchemaService.onDidChangeSchema(() => {
				this.updateTitles();
				this.scheduleRoleContextSync();
			}));
		}
		this._register(onDidChangeAdeLocale(() => this.updateTitles()));
		this._register(projects.onDidChange(change => {
			if (change !== 'selection') {
				this.updateTitles();
			}
			this.scheduleRoleContextSync();
		}));
		this._register(modeService.onDidChangeMode(mode => {
			if (mode === 'ade') {
				this.updateTitles();
			}
			this.scheduleRoleContextSync();
		}));
		this._register(this.editorService.onDidActiveEditorChange(() => this.handleActiveEditorChanged()));
		this.scheduleRoleContextSync();
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
		if (editor instanceof AdeEngineeringEditorInput) {
			return this.projects.getAgent(editor.governorSessionId) ? editor.governorSessionId : undefined;
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

	private scheduleRoleContextSync(): void {
		if (this.roleSyncTimer !== undefined) {
			clearTimeout(this.roleSyncTimer);
		}
		this.roleSyncTimer = setTimeout(() => {
			this.roleSyncTimer = undefined;
			void this.syncRoleContextToExtHost();
		}, 120);
	}

	private async syncRoleContextToExtHost(explicitActiveAgentId?: string): Promise<void> {
		if (this.roleSyncTimer !== undefined) {
			clearTimeout(this.roleSyncTimer);
			this.roleSyncTimer = undefined;
		}
		try {
			const snapshot = buildAdeRoleSyncSnapshot(this.modeService, this.projects, this, this.sessions, explicitActiveAgentId, this.roleSchemaService?.getConfig());
			const snapshotKey = JSON.stringify(snapshot);
			if (!explicitActiveAgentId && snapshotKey === this.lastSyncedSnapshotKey) {
				return;
			}
			this.lastSyncedSnapshotKey = snapshotKey;
			const extId = new ExtensionIdentifier('aexus.aexus-agents');
			await this.extensionService.activateById(extId, { startup: false, extensionId: extId, activationEvent: 'api' }).catch(() => undefined);
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
					if (editor instanceof AdeLineageChatEditorInput) {
						editor.refreshLineage();
					}
				}
			}
		}
	}

	private findOpenChatEditor(sessionResource: URI): { readonly editor: ChatEditorInput; readonly group: IEditorGroup } | undefined {
		const targetKey = sessionResource.toString();
		for (const group of this.editorGroupsService.mainPart.groups) {
			for (const editor of group.editors) {
				if (editor instanceof ChatEditorInput && !editor.isDisposed() && editor.sessionResource?.toString() === targetKey) {
					return { editor, group };
				}
			}
		}
		return undefined;
	}

	private formatLineageForSession(sessionResource: URI): string | undefined {
		const key = sessionResource.toString();
		const agent = this.projects.agents.find(item => item.session?.resource.toString() === key);
		return agent ? formatAdeAgentLineage(this.projects, agent, this.roleSchemaService?.getConfig()) : undefined;
	}

	private createAgentChatInput(agent: IAdeAgent & { readonly session: NonNullable<IAdeAgent['session']> }): ChatEditorInput {
		const resource = agent.session.resource;
		const input = this.instantiationService.createInstance(AdeLineageChatEditorInput, resource, {
			title: { preferred: agent.label, override: agent.labelIsCustom !== false ? agent.label : undefined },
			modelInputState: agent.draft ? { attachments: [], mode: { id: 'agent', kind: ChatModeKind.Agent }, selectedModel: undefined, inputText: agent.draft, selections: [], contrib: {} } : undefined,
		});
		input.setLineageProvider(() => this.formatLineageForSession(resource));
		return input;
	}

	/**
	 * Materializes a lazy Agent session while an {@link AdeSessionEditorInput} shows a 3-step
	 * warm-up stepper. Failures stay visible on that editor with a Retry action instead of being
	 * swallowed. Returns the warm-up editor's group when it should host the connected chat.
	 */
	private async warmUpLazyAgent(agent: IAdeAgent, engineId: string, options?: { side?: boolean }): Promise<{ readonly ok: boolean; readonly group: IEditorGroup }> {
		const group = this.resolveTargetGroup(options?.side);
		const warmInput = this.instantiationService.createInstance(AdeSessionEditorInput, agent.id);
		const engineName = this.sessions.getEngineName?.(engineId) ?? engineId;
		warmInput.setWarmup({ step: 'spawning', engineName });
		await this.editorService.openEditor(warmInput, { pinned: true }, group.id);
		// The editor group may hand back an already-open equivalent input; drive the one that is shown.
		const shown = group.editors.find((editor): editor is AdeSessionEditorInput => editor instanceof AdeSessionEditorInput && editor.matches(warmInput)) ?? warmInput;
		if (shown !== warmInput) {
			shown.setWarmup({ step: 'spawning', engineName });
			if (!group.editors.includes(warmInput)) {
				warmInput.dispose();
			}
		}

		let step: AdeSessionWarmupStep = 'spawning';
		try {
			const targetCwd = agent.workingDirectoryOverride ? URI.file(agent.workingDirectoryOverride) : agent.projectUri;
			const materialized = await this.sessions.create(engineId, targetCwd);
			if (!materialized) {
				throw new Error(localize('adeWarmupNoSession', "{0} did not return a session.", engineName));
			}
			step = 'binding';
			shown.setWarmup({ step, engineName });
			this.projects.bindSession(agent.id, { engineId: materialized.engineId, resource: materialized.resource });
			step = 'syncing';
			shown.setWarmup({ step, engineName });
			return { ok: true, group };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error ?? '');
			shown.setWarmup({ step: 'error', failedStep: step, engineName, error: message || undefined }, () => {
				void this.openAgent(agent.id, options);
			});
			return { ok: false, group };
		}
	}

	async openAgent(id: string, options?: { side?: boolean }): Promise<void> {
		let agent = this.projects.getAgent(id);
		let warmGroup: IEditorGroup | undefined;
		if (agent && !agent.session && agent.preferredEngineId) {
			const result = await this.warmUpLazyAgent(agent, agent.preferredEngineId, options);
			agent = this.projects.getAgent(id);
			if (!result.ok) {
				if (agent) {
					this.projects.selectAgent(id);
					this.projects.markRead(id);
				}
				return;
			}
			warmGroup = result.group;
		}
		if (agent) {
			this.projects.selectAgent(id);
			this.projects.markRead(id);
			await this.syncRoleContextToExtHost(agent.id);
		}

		// Close any legacy 3rd-party extension webview tabs bound to this agent so ADE stays 100% unified.
		await this.closeEditors(editor =>
			(editor instanceof AdeExtensionWebviewEditorInput && editor.agentId === id)
			|| (this.editorToAgentId.get(editor) === id && !(editor instanceof ChatEditorInput))
		);

		if (agent?.session && !options?.side && !agent.draft) {
			const existing = this.findOpenChatEditor(agent.session.resource);
			if (existing) {
				await this.editorService.openEditor(existing.editor, { pinned: true }, existing.group.id);
				this.updateTitles();
				await this.closeEditors(editor => editor instanceof AdeSessionEditorInput && (!editor.agentId || editor.agentId === id));
				await this.syncRoleContextToExtHost(agent.id);
				return;
			}
		}

		const targetGroup = warmGroup ?? this.resolveTargetGroup(options?.side);
		const session = agent?.session;
		const input = agent && session
			? this.createAgentChatInput({ ...agent, session })
			: this.instantiationService.createInstance(AdeSessionEditorInput, id);
		await this.editorService.openEditor(input, { pinned: true }, targetGroup.id);
		this.updateTitles();
		if (agent?.session && agent.draft) {
			this.projects.setDraft(agent.id, '');
		}
		if (agent) {
			await this.closeEditors(editor => editor instanceof AdeSessionEditorInput && (!editor.agentId || (Boolean(agent.session) && editor.agentId === id)));
			await this.syncRoleContextToExtHost(agent.id);
		}
	}

	async openEngineering(governorId: string, options?: { side?: boolean }): Promise<void> {
		const gov = this.projects.getAgent(governorId);
		if (gov) {
			this.projects.selectProject(gov.projectUri);
		}
		const targetGroup = this.resolveTargetGroup(options?.side);
		const input = this.instantiationService.createInstance(AdeEngineeringEditorInput, governorId);
		await this.editorService.openEditor(input, { pinned: true }, targetGroup.id);
	}

	async openCloudHosts(hostIdOrAlias?: string, options?: { side?: boolean }): Promise<void> {
		for (const group of this.editorGroupsService.mainPart.groups) {
			for (const editor of group.editors) {
				if (editor instanceof AdeCloudHostsEditorInput && !editor.isDisposed()) {
					editor.setFocusHostTarget(hostIdOrAlias);
					const pane = await this.editorService.openEditor(editor, { pinned: true }, group.id);
					if (pane instanceof AdeCloudHostsEditorPane) {
						await pane.focusHost(hostIdOrAlias);
					}
					return;
				}
			}
		}
		const targetGroup = this.resolveTargetGroup(options?.side);
		const input = this.instantiationService.createInstance(AdeCloudHostsEditorInput, hostIdOrAlias);
		await this.editorService.openEditor(input, { pinned: true }, targetGroup.id);
	}

	async openRoleStudio(focusRankId?: string, options?: { side?: boolean }): Promise<void> {
		for (const group of this.editorGroupsService.mainPart.groups) {
			for (const editor of group.editors) {
				if (editor instanceof AdeRoleStudioEditorInput) {
					if (focusRankId !== undefined) {
						editor.setFocusRankId(focusRankId);
					}
					const pane = await this.editorService.openEditor(editor, { pinned: true }, group.id);
					if (pane instanceof AdeRoleStudioEditorPane) {
						pane.focusRank(focusRankId);
					}
					return;
				}
			}
		}
		const targetGroup = this.resolveTargetGroup(options?.side);
		const input = this.instantiationService.createInstance(AdeRoleStudioEditorInput, focusRankId);
		await this.editorService.openEditor(input, { pinned: true }, targetGroup.id);
	}

	async openAdeConfig(options?: { side?: boolean }): Promise<void> {
		for (const group of this.editorGroupsService.mainPart.groups) {
			for (const editor of group.editors) {
				if (editor instanceof AdeConfigEditorInput) {
					await this.editorService.openEditor(editor, { pinned: true }, group.id);
					return;
				}
			}
		}
		const targetGroup = this.resolveTargetGroup(options?.side);
		const input = this.instantiationService.createInstance(AdeConfigEditorInput);
		await this.editorService.openEditor(input, { pinned: true }, targetGroup.id);
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
			if (editor instanceof AdeEngineeringEditorInput) {
				return ids.has(editor.governorSessionId);
			}
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
