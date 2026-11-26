/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import {
	AEXUS_SSH_GIT_HEAD_SCHEME,
	AEXUS_SSH_SCHEME,
	buildCloudProjectUri,
	IAdeCloudHost,
	IAdeCloudHostBackendService,
	resolveInitialCloudHostDirectory,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import { IAdeControlCenterService } from '../../../../platform/ade/common/adeControlCenterIpc.js';
import { ADE_REGISTERED_ENGINES } from '../../../../platform/ade/common/adeModels.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService, ServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorExtensions, EditorInputCapabilities, IEditorFactoryRegistry, Verbosity } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import {
	ADE_CLOUD_HOSTS_SCHEME,
	ADE_SESSION_SCHEME,
	buildAdeEmployeeSessionUri,
	buildAdeProjectEditorUri,
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectOpenOptions,
	IAdeProjectsService,
	IAdeProjectSnapshot,
	normalizeAdeShortEngineId,
	parseAdeEmployeeSessionUri,
	parseAdeProjectEditorUri,
} from '../common/ade.js';
import { onDidChangeAdeLocale } from '../common/adeLocalization.js';
import { AdeCloudHostsEditorInput, AdeCloudHostsEditorPane } from './adeCloudHostsEditorPane.js';
import { resolveEmployeeWorkspaceCwdUri } from './adeControlHandler.js';
import { asAdeProjectsSelectionRouting } from './adeProjectsService.js';
import { AdeExtensionWebviewEditorInput, AdeSessionEditorInput, formatAdeAgentLineage } from './adeSessionEditor.js';

const AEXUS_AGENTS_EXTENSION_ID = new ExtensionIdentifier('aexus.aexus-agents');
const ADE_PROJECT_CANVAS_INPUT_ID = 'workbench.input.adeEngineering';

class AdeFallbackProjectEditorInput extends EditorInput {
	readonly projectId: string;
	override readonly resource: URI;
	private pendingFocus: unknown;

	constructor(projectId: string, private readonly projects?: IAdeProjectsService) {
		super();
		this.projectId = projectId;
		this.resource = buildAdeProjectEditorUri(projectId);
	}

	override get typeId(): string {
		return ADE_PROJECT_CANVAS_INPUT_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.CanSplitInGroup;
	}

	override getName(): string {
		return this.projects?.getProjectPage(this.projectId)?.name ?? this.projectId;
	}

	setPendingFocus(focus: unknown): void {
		this.pendingFocus = focus;
	}

	consumePendingFocus(): unknown {
		const next = this.pendingFocus;
		this.pendingFocus = undefined;
		return next;
	}

	override matches(otherInput: EditorInput): boolean {
		return super.matches(otherInput) || extractProjectPageIdFromEditor(otherInput) === this.projectId;
	}
}

/**
 * Extracts `projectId` from a Project Page canvas editor across both `ade-project://${projectId}`
 * URIs and `AdeEngineeringEditorInput` instances.
 */
export function extractProjectPageIdFromEditor(editor: EditorInput | undefined): string | undefined {
	if (!editor || editor.isDisposed()) {
		return undefined;
	}
	if (editor.typeId === ADE_PROJECT_CANVAS_INPUT_ID) {
		const candidate = editor as unknown as {
			readonly projectId?: string;
		};
		if (typeof candidate.projectId === 'string' && candidate.projectId.trim()) {
			return candidate.projectId.trim();
		}
		if (editor.resource?.authority) {
			const fromAuthority = parseAdeProjectEditorUri(editor.resource);
			if (fromAuthority) {
				return fromAuthority;
			}
		}
	}
	const fromUri = parseAdeProjectEditorUri(editor.resource);
	if (!fromUri) {
		return undefined;
	}
	const slashIdx = fromUri.indexOf('/');
	return slashIdx > 0 ? fromUri.slice(0, slashIdx) : fromUri;
}

/**
 * Identifies stale legacy tabs (e.g. deprecated global assistant schemes) on session restore
 * without embedding legacy scheme literals.
 */
export function isLegacyUnsupportedAdeEditor(editor: EditorInput | undefined): boolean {
	if (!editor || editor.isDisposed()) {
		return false;
	}
	if (editor instanceof AdeSessionEditorInput) {
		return !editor.agentId || editor.agentId.startsWith('__aexus_');
	}
	if (editor instanceof ChatEditorInput) {
		const uri = editor.sessionResource;
		if (!uri || !uri.scheme.startsWith('aexus-')) {
			return false;
		}
		const shortEng = normalizeAdeShortEngineId(uri.scheme);
		if (!(ADE_REGISTERED_ENGINES as readonly string[]).includes(shortEng)) {
			return true;
		}
		const rawPath = uri.path.replace(/^\/+/, '');
		if (rawPath.startsWith('__aexus_')) {
			return true;
		}
		return false;
	}
	const res = editor.resource;
	if (
		res
		&& res.scheme.startsWith('aexus-')
		&& res.scheme !== ADE_SESSION_SCHEME
		&& res.scheme !== ADE_CLOUD_HOSTS_SCHEME
		&& res.scheme !== AEXUS_SSH_SCHEME
		&& res.scheme !== AEXUS_SSH_GIT_HEAD_SCHEME
	) {
		const shortEng = normalizeAdeShortEngineId(res.scheme);
		if (!(ADE_REGISTERED_ENGINES as readonly string[]).includes(shortEng)) {
			return true;
		}
	}
	return false;
}

/**
 * A {@link ChatEditorInput} for an ADE employee session that surfaces the employee's
 * reporting lineage (`Project › Supervisor › LN`) as the editor description and tooltip.
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
	private readonly editorToAgentRef = new WeakMap<EditorInput, { readonly projectId: string; readonly agentId: string }>();
	private readonly editorBoundHost = new WeakMap<EditorInput, string>();
	private readonly pendingRuntimeRefreshAgents = new Set<string>();
	private readonly rebindingEditors = new Map<EditorInput, Promise<void>>();
	private readonly latestRebindSeqByProject = new Map<string, number>();
	private latestUnscopedRebindSeq = 0;
	private rebindOpSeq = 0;
	private readonly controlCenter: IAdeControlCenterService | undefined;
	private readonly cloudHosts: IAdeCloudHostBackendService | undefined;
	private readonly chatService: IChatService | undefined;
	private readonly uriIdentity: IUriIdentityService | undefined;
	private knownCloudHosts: readonly IAdeCloudHost[] = [];
	private readonly resolvedAgentCwdUriByKey = new Map<string, URI>();
	private readonly inflightAgentCwdProbes = new Set<string>();
	private isSelectingFromEditor = false;

	constructor(
		@IWorkbenchModeService private readonly modeService: IWorkbenchModeService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
		@IExtensionService private readonly extensionService: IExtensionService,
	) {
		super();
		const tryGet = <T>(id: ServiceIdentifier<T>): T | undefined => instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(id);
			} catch {
				return undefined;
			}
		});
		this.controlCenter = tryGet(IAdeControlCenterService);
		this.cloudHosts = tryGet(IAdeCloudHostBackendService);
		this.chatService = tryGet(IChatService);
		this.uriIdentity = tryGet(IUriIdentityService);
		const lifecycleService = tryGet(ILifecycleService);

		if (this.cloudHosts) {
			const reloadHosts = () => {
				void this.cloudHosts?.listHosts().then(hosts => {
					if (!this._store.isDisposed) {
						this.knownCloudHosts = hosts;
					}
				}).catch(() => undefined);
			};
			reloadHosts();
			if (typeof this.cloudHosts.onDidChangeHosts === 'function') {
				this._register(this.cloudHosts.onDidChangeHosts(() => reloadHosts()));
			}
		}

		this._register(onDidChangeAdeLocale(() => this.updateTitles()));
		this._register(projects.onDidChange(change => {
			if (change !== 'selection') {
				this.updateTitles();
				void this.rebindUnstartedAgentEditors();
			}
		}));
		if (this.controlCenter && typeof this.controlCenter.onDidChangeProject === 'function') {
			this._register(this.controlCenter.onDidChangeProject(evt => {
				void this.rebindUnstartedAgentEditors(evt.projectId);
			}));
		}
		if (this.controlCenter && typeof this.controlCenter.onDidDisposeAgentRuntime === 'function') {
			this._register(this.controlCenter.onDidDisposeAgentRuntime(evt => {
				if (evt.projectId && evt.agentId) {
					this.pendingRuntimeRefreshAgents.add(`${evt.projectId}\0${evt.agentId}`);
					void this.rebindUnstartedAgentEditors(evt.projectId);
				}
			}));
		}
		const maybeWithProjectRemoval = projects as IAdeProjectsService & {
			readonly onDidRemoveProjects?: (listener: (removedProjectIds: readonly string[]) => void) => { dispose(): void };
		};
		if (typeof maybeWithProjectRemoval.onDidRemoveProjects === 'function') {
			this._register(maybeWithProjectRemoval.onDidRemoveProjects(removedProjectIds => {
				for (const pid of removedProjectIds) {
					void this.closeEditorsForProject(pid);
				}
			}));
		}
		this._register(modeService.onDidChangeMode(mode => {
			if (mode === 'ade') {
				this.updateTitles();
				void this.purgeLegacyEditors();
			}
		}));
		this._register(this.editorService.onDidActiveEditorChange(() => this.handleActiveEditorChanged()));

		this.syncRestoredEditorBindings();
		if (lifecycleService) {
			void lifecycleService.when(LifecyclePhase.Restored).then(() => {
				if (!this._store.isDisposed) {
					this.syncRestoredEditorBindings();
					void this.purgeLegacyEditors();
				}
			});
		} else {
			queueMicrotask(() => {
				if (!this._store.isDisposed) {
					this.syncRestoredEditorBindings();
					void this.purgeLegacyEditors();
				}
			});
		}
	}

	private ensureEditorAgentBinding(editor: EditorInput | undefined): { readonly projectId: string; readonly agentId: string } | undefined {
		if (!editor || editor.isDisposed()) {
			return undefined;
		}
		const existing = this.editorToAgentRef.get(editor);
		if (existing) {
			return existing;
		}
		if (
			(editor instanceof AdeExtensionWebviewEditorInput || editor instanceof AdeSessionEditorInput)
			&& editor.projectId
			&& editor.agentId
			&& !editor.agentId.startsWith('__aexus_')
		) {
			const ref = { projectId: editor.projectId, agentId: editor.agentId };
			this.editorToAgentRef.set(editor, ref);
			return ref;
		}
		return undefined;
	}

	private syncRestoredEditorBindings(): void {
		for (const group of this.editorGroupsService.mainPart.groups) {
			for (const editor of group.editors) {
				this.ensureEditorAgentBinding(editor);
			}
		}
	}

	async purgeLegacyEditors(): Promise<void> {
		this.syncRestoredEditorBindings();
		await this.closeEditors(editor => isLegacyUnsupportedAdeEditor(editor));
	}

	get activeEditor(): EditorInput | undefined {
		return this.editorGroupsService.mainPart.activeGroup.activeEditor ?? undefined;
	}

	bindEditorToAgent(editor: EditorInput, ref: { readonly projectId: string; readonly agentId: string }): void {
		const projectId = ref.projectId.trim();
		const agentId = ref.agentId.trim();
		if (!projectId || !agentId) {
			return;
		}
		this.editorToAgentRef.set(editor, { projectId, agentId });
		if (editor instanceof AdeExtensionWebviewEditorInput) {
			editor.setProjectId(projectId);
		}
	}

	getAgentForEditor(editor: EditorInput | undefined): { readonly projectId: string; readonly agentId: string } | undefined {
		if (!editor || editor.isDisposed()) {
			return undefined;
		}
		const mapped = this.ensureEditorAgentBinding(editor);
		if (editor instanceof AdeSessionEditorInput) {
			if (!editor.agentId || editor.agentId.startsWith('__aexus_')) {
				return undefined;
			}
			const scopedProjectId = editor.projectId || mapped?.projectId;
			const found = this.projects.getAgent(editor.agentId, scopedProjectId);
			if (found) {
				return { projectId: found.projectId, agentId: found.id };
			}
			return scopedProjectId ? { projectId: scopedProjectId, agentId: editor.agentId } : undefined;
		}
		if (editor instanceof AdeExtensionWebviewEditorInput) {
			const ref = mapped
				?? (editor.projectId ? { projectId: editor.projectId, agentId: editor.agentId } : undefined);
			if (ref) {
				const found = this.projects.getAgent(ref.agentId, ref.projectId);
				return found
					? { projectId: found.projectId, agentId: found.id }
					: { projectId: ref.projectId, agentId: ref.agentId };
			}
			const found = this.projects.getAgent(editor.agentId);
			return found ? { projectId: found.projectId, agentId: found.id } : undefined;
		}
		if (editor instanceof ChatEditorInput) {
			const parsed = parseAdeEmployeeSessionUri(editor.sessionResource);
			if (parsed) {
				const found = this.projects.getAgent(parsed.agentId, parsed.projectId);
				return found
					? { projectId: found.projectId, agentId: found.id }
					: { projectId: parsed.projectId, agentId: parsed.agentId };
			}
			const sessionKey = editor.sessionResource?.toString();
			if (sessionKey) {
				const matched = this.projects.agents.find(item => item.session.resource.toString() === sessionKey);
				if (matched) {
					return { projectId: matched.projectId, agentId: matched.id };
				}
			}
		} else if (editor.resource) {
			const parsed = parseAdeEmployeeSessionUri(editor.resource);
			if (parsed) {
				const found = this.projects.getAgent(parsed.agentId, parsed.projectId);
				return found
					? { projectId: found.projectId, agentId: found.id }
					: { projectId: parsed.projectId, agentId: parsed.agentId };
			}
		}
		return this.editorToAgentRef.get(editor);
	}

	getAgentIdForEditor(editor: EditorInput | undefined): string | undefined {
		return this.getAgentForEditor(editor)?.agentId;
	}

	getActiveProjectPageId(): string | undefined {
		const active = this.activeEditor;
		const fromPage = extractProjectPageIdFromEditor(active);
		if (fromPage) {
			return fromPage;
		}
		const fromAgent = this.getAgentForEditor(active);
		if (fromAgent) {
			return fromAgent.projectId;
		}
		return this.projects.selectedProjectPageId;
	}

	private resolveFolderUriForProjectPage(projectId: string): URI | undefined {
		const folder = this.projects.getFolderForProjectPage(projectId);
		if (folder) {
			return folder.uri;
		}
		const page = this.projects.getProjectPage(projectId);
		return page?.folderUri;
	}

	private primeAgentWorkspaceCwdUri(projectId: string, agentId: string): void {
		if (!this.controlCenter) {
			return;
		}
		const key = `${projectId}\0${agentId}`;
		if (this.inflightAgentCwdProbes.has(key)) {
			return;
		}
		this.inflightAgentCwdProbes.add(key);
		void (async () => {
			try {
				const [snap, bundle] = await Promise.all([
					this.controlCenter?.getProjectSnapshot(projectId).catch(() => undefined),
					this.controlCenter?.issueAgentLaunchBundle(projectId, agentId).catch(() => undefined),
				]);
				if (this._store.isDisposed) {
					return;
				}
				const snapAgent = snap?.agents.find(a => a.agent_id === agentId);
				const projAgent = this.projects.getAgent(agentId, projectId);
				const host = (snapAgent?.host ?? bundle?.host ?? projAgent?.host ?? 'local').trim();
				if (!host || host.toLowerCase() === 'local') {
					this.resolvedAgentCwdUriByKey.delete(key);
					return;
				}
				const cwdUriStr = await resolveEmployeeWorkspaceCwdUri({
					host,
					folderUri: snap?.meta.folder_uri ?? projAgent?.projectUri.toString(),
					bundle,
					projectHosts: snap?.hosts,
					cloudHosts: this.cloudHosts,
				});
				if (!this._store.isDisposed && cwdUriStr) {
					this.resolvedAgentCwdUriByKey.set(key, URI.parse(cwdUriStr));
				}
			} catch {
				// Best effort background cache hydration
			} finally {
				this.inflightAgentCwdProbes.delete(key);
			}
		})();
	}

	private resolveRemoteAgentCwdUriSync(projectId: string, agentId: string): URI | undefined {
		const routing = asAdeProjectsSelectionRouting(this.projects);
		const snap = routing?.getCachedProjectSnapshot(projectId);
		const snapAgent = snap?.agents.find(a => a.agent_id === agentId);
		const projAgent = this.projects.getAgent(agentId, projectId);
		const rawHost = (snapAgent?.host ?? projAgent?.host ?? 'local').trim();
		if (!rawHost || rawHost.toLowerCase() === 'local') {
			return undefined;
		}
		const lowerHost = rawHost.toLowerCase();
		const projHost = snap?.hosts.find(h =>
			h.ip === rawHost
			|| h.host_id === rawHost
			|| h.ssh_alias.toLowerCase() === lowerHost,
		);
		const preferredAliasLower = (projHost?.ssh_alias || rawHost).toLowerCase();
		const matchedCloud = this.knownCloudHosts.find(h =>
			h.alias.toLowerCase() === preferredAliasLower
			|| h.id.toLowerCase() === lowerHost
			|| `${h.hostName.toLowerCase()}:${h.port || 22}` === lowerHost
			|| h.hostName.toLowerCase() === lowerHost,
		);
		const folderUri = this.resolveFolderUriForProjectPage(projectId)
			?? (snap?.meta.folder_uri ? URI.parse(snap.meta.folder_uri) : projAgent?.projectUri);
		const sshAlias = matchedCloud?.alias
			|| projHost?.ssh_alias
			|| (folderUri?.scheme === AEXUS_SSH_SCHEME && folderUri.authority ? folderUri.authority : rawHost);

		const cacheKey = `${projectId}\0${agentId}`;
		const cached = this.resolvedAgentCwdUriByKey.get(cacheKey);
		if (
			cached
			&& cached.scheme === AEXUS_SSH_SCHEME
			&& (cached.authority.toLowerCase() === sshAlias.toLowerCase() || cached.authority.toLowerCase() === lowerHost)
		) {
			return cached;
		}

		this.primeAgentWorkspaceCwdUri(projectId, agentId);

		const osKind = matchedCloud?.os ?? projHost?.os_kind ?? 'linux';
		let remoteDir: string;
		if (folderUri?.scheme === AEXUS_SSH_SCHEME && folderUri.authority.toLowerCase() === sshAlias.toLowerCase()) {
			remoteDir = folderUri.path || '/';
		} else if (matchedCloud) {
			remoteDir = resolveInitialCloudHostDirectory(matchedCloud);
		} else if (projHost?.remote_home) {
			remoteDir = projHost.remote_home;
		} else {
			remoteDir = '~';
		}
		return buildCloudProjectUri(sshAlias, remoteDir, osKind);
	}

	private resolveOwningWorkspaceFolderUri(fileResource: URI): URI {
		const candidates = this.projects.projects.filter(p => {
			if (this.uriIdentity) {
				return this.uriIdentity.extUri.isEqualOrParent(fileResource, p.uri);
			}
			return fileResource.scheme === p.uri.scheme
				&& fileResource.authority.toLowerCase() === p.uri.authority.toLowerCase()
				&& (fileResource.path === p.uri.path || fileResource.path.startsWith(`${p.uri.path}/`));
		});
		candidates.sort((a, b) => b.uri.path.length - a.uri.path.length);
		return candidates[0]?.uri ?? dirname(fileResource);
	}

	getActiveFolderUri(): URI | undefined {
		const routing = asAdeProjectsSelectionRouting(this.projects);
		// 1. Sidebar selection wins immediately so background canvas/chat tabs never hijack New Terminal
		if (routing?.lastSelectionSource === 'sidebar') {
			if (this.projects.selectedProjectPageId) {
				const fromSelectedPage = this.resolveFolderUriForProjectPage(this.projects.selectedProjectPageId);
				if (fromSelectedPage) {
					return fromSelectedPage;
				}
			}
			if (this.projects.selectedProject) {
				return this.projects.selectedProject.uri;
			}
		}

		const active = this.activeEditor;
		const activePane = this.editorService.activeEditorPane;

		// 2. Cloud Hosts Studio card / drawer selection
		if (activePane instanceof AdeCloudHostsEditorPane) {
			const paneHostUri = activePane.getSelectedCloudHostUri();
			if (paneHostUri) {
				return paneHostUri;
			}
		}
		if (active instanceof AdeCloudHostsEditorInput && routing?.selectedCloudHostUri) {
			return routing.selectedCloudHostUri;
		}
		if (routing?.lastSelectionSource === 'cloudHost' && routing.selectedCloudHostUri && active instanceof AdeCloudHostsEditorInput) {
			return routing.selectedCloudHostUri;
		}

		// 3. Employee Chat / Session editor (returns remote `aexus-ssh://<alias>/<remoteDir>` for cloud employees)
		const agentRef = this.getAgentForEditor(active);
		if (agentRef) {
			const remoteCwdUri = this.resolveRemoteAgentCwdUriSync(agentRef.projectId, agentRef.agentId);
			if (remoteCwdUri) {
				return remoteCwdUri;
			}
			const folderUri = this.resolveFolderUriForProjectPage(agentRef.projectId);
			if (folderUri) {
				return folderUri;
			}
			const agent = this.projects.getAgent(agentRef.agentId, agentRef.projectId);
			if (agent) {
				return agent.projectUri;
			}
		}

		// 4. Orchestration Canvas editor (returns selected remote employee's SSH cwd, else canvas project folder)
		const pageId = extractProjectPageIdFromEditor(active);
		if (pageId) {
			const selectedAgentOnCanvas = this.projects.selectedProjectPageId === pageId
				? this.projects.selectedAgentId
				: undefined;
			if (selectedAgentOnCanvas) {
				const remoteCanvasAgentUri = this.resolveRemoteAgentCwdUriSync(pageId, selectedAgentOnCanvas);
				if (remoteCanvasAgentUri) {
					return remoteCanvasAgentUri;
				}
			}
			const canvasFolderUri = this.resolveFolderUriForProjectPage(pageId);
			if (canvasFolderUri) {
				return canvasFolderUri;
			}
		}

		// 5. Ordinary code file editor -> owning workspace folder URI
		if (
			active?.resource
			&& (active.resource.scheme === Schemas.file || active.resource.scheme === AEXUS_SSH_SCHEME)
		) {
			return this.resolveOwningWorkspaceFolderUri(active.resource);
		}

		if (this.projects.selectedProjectPageId) {
			const fallbackPageFolder = this.resolveFolderUriForProjectPage(this.projects.selectedProjectPageId);
			if (fallbackPageFolder) {
				return fallbackPageFolder;
			}
		}
		return this.projects.selectedProject?.uri;
	}

	private handleActiveEditorChanged(): void {
		const active = this.activeEditor;
		if (!active) {
			return;
		}
		if (isLegacyUnsupportedAdeEditor(active)) {
			void this.purgeLegacyEditors();
			return;
		}
		if (this.modeService.mode !== 'ade' || this.isSelectingFromEditor) {
			return;
		}
		const routing = asAdeProjectsSelectionRouting(this.projects);
		this.isSelectingFromEditor = true;
		try {
			if (active instanceof AdeCloudHostsEditorInput) {
				const activePane = this.editorService.activeEditorPane;
				const selectedHostUri = activePane instanceof AdeCloudHostsEditorPane
					? activePane.getSelectedCloudHostUri()
					: routing?.selectedCloudHostUri;
				if (selectedHostUri) {
					routing?.setSelectionSource('cloudHost', selectedHostUri);
				} else {
					routing?.setSelectionSource('editor');
				}
				return;
			}
			const projectId = extractProjectPageIdFromEditor(active);
			if (projectId) {
				routing?.setSelectionSource('editor');
				if (this.projects.getProjectPage(projectId) && this.projects.selectedProjectPageId !== projectId) {
					this.projects.selectProjectPage(projectId);
				}
				return;
			}
			const agentRef = this.getAgentForEditor(active);
			if (agentRef) {
				routing?.setSelectionSource('editor');
				if (!this.projects.getProjectPage(agentRef.projectId) && !this.projects.getAgent(agentRef.agentId, agentRef.projectId)) {
					return;
				}
				if (this.projects.selectedProjectPageId !== agentRef.projectId) {
					this.projects.selectProjectPage(agentRef.projectId);
				}
				this.projects.selectAgent(agentRef.agentId, agentRef.projectId);
				this.projects.markRead(agentRef.agentId, agentRef.projectId);
				return;
			}
			if (active.resource && (active.resource.scheme === Schemas.file || active.resource.scheme === AEXUS_SSH_SCHEME)) {
				routing?.setSelectionSource('editor');
			}
		} finally {
			this.isSelectingFromEditor = false;
		}
	}

	isSessionActive(resource: URI): boolean {
		const target = resource.toString();
		return this.editorGroupsService.mainPart.groups.some(group => {
			const active = group.activeEditor;
			if (!active) {
				return false;
			}
			if (active instanceof ChatEditorInput && active.sessionResource?.toString() === target) {
				return true;
			}
			const agentRef = this.getAgentForEditor(active);
			return Boolean(agentRef && this.projects.getAgent(agentRef.agentId, agentRef.projectId)?.session.resource.toString() === target);
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
		for (const group of this.editorGroupsService.mainPart.groups) {
			for (const editor of group.editors) {
				this.ensureEditorAgentBinding(editor);
				if (editor instanceof ChatEditorInput) {
					const agentRef = this.getAgentForEditor(editor);
					const agent = agentRef ? this.projects.getAgent(agentRef.agentId, agentRef.projectId) : undefined;
					editor.setTitleOverride(agent ? agent.label : undefined);
					if (editor instanceof AdeLineageChatEditorInput) {
						editor.refreshLineage();
					}
				}
			}
		}
	}

	private findOpenChatEditor(sessionResource: URI, excludeGroup?: IEditorGroup): { readonly editor: ChatEditorInput; readonly group: IEditorGroup } | undefined {
		const targetKey = sessionResource.toString();
		for (const group of this.editorGroupsService.mainPart.groups) {
			if (excludeGroup && group === excludeGroup) {
				continue;
			}
			for (const editor of group.editors) {
				if (editor instanceof ChatEditorInput && !editor.isDisposed() && editor.sessionResource?.toString() === targetKey) {
					return { editor, group };
				}
			}
		}
		return undefined;
	}

	private findOpenProjectPageEditor(projectId: string, excludeGroup?: IEditorGroup): { readonly editor: EditorInput; readonly group: IEditorGroup } | undefined {
		for (const group of this.editorGroupsService.mainPart.groups) {
			if (excludeGroup && group === excludeGroup) {
				continue;
			}
			for (const editor of group.editors) {
				if (!editor.isDisposed() && extractProjectPageIdFromEditor(editor) === projectId) {
					return { editor, group };
				}
			}
		}
		return undefined;
	}

	private formatLineageForSession(sessionResource: URI): string | undefined {
		const parsed = parseAdeEmployeeSessionUri(sessionResource);
		const agent = parsed
			? this.projects.getAgent(parsed.agentId, parsed.projectId)
			: this.projects.agents.find(item => item.session.resource.toString() === sessionResource.toString());
		return agent ? formatAdeAgentLineage(this.projects, agent) : undefined;
	}

	private createAgentChatInput(agent: IAdeAgent, explicitResource?: URI, explicitHost?: string): ChatEditorInput {
		const resource = explicitResource ?? agent.session.resource;
		const input = this.instantiationService.createInstance(AdeLineageChatEditorInput, resource, {
			title: { preferred: agent.label, override: agent.label },
		});
		input.setLineageProvider(() => this.formatLineageForSession(resource));
		this.editorToAgentRef.set(input, { projectId: agent.projectId, agentId: agent.id });
		this.editorBoundHost.set(input, explicitHost ?? agent.host);
		return input;
	}

	private getLatestRequestedRebindSeq(projectId: string): number {
		return Math.max(this.latestUnscopedRebindSeq, this.latestRebindSeqByProject.get(projectId) ?? 0);
	}

	async rebindUnstartedAgentEditors(projectId?: string, snapshot?: IAdeProjectSnapshot): Promise<number> {
		if (this._store.isDisposed) {
			return 0;
		}
		const scopedProjectId = projectId?.trim() || undefined;
		const opSeq = ++this.rebindOpSeq;
		if (scopedProjectId) {
			this.latestRebindSeqByProject.set(scopedProjectId, opSeq);
		} else {
			this.latestUnscopedRebindSeq = opSeq;
		}

		// Never call this.projects.notifyProjectSnapshotLoaded(...) here — AdeProjectsService and
		// AdeMissionStore maintain their own single-flight snapshot coordinators, and feeding a
		// caller-cached snapshot back into AdeProjectsService would regress newer session_started / engine state.
		let initialSnapshot = snapshot;
		let initialSnapshotFreshlyFetched = false;
		if (!initialSnapshot && scopedProjectId && this.controlCenter) {
			initialSnapshot = await this.controlCenter.getProjectSnapshot(scopedProjectId).catch(() => undefined);
			initialSnapshotFreshlyFetched = true;
			if (this._store.isDisposed) {
				return 0;
			}
			if (opSeq < this.getLatestRequestedRebindSeq(scopedProjectId)) {
				await Promise.allSettled([...this.rebindingEditors.values()]);
				return 0;
			}
		}
		if (this._store.isDisposed) {
			return 0;
		}

		let reboundCount = 0;
		for (let pass = 0; pass < 4 && !this._store.isDisposed; pass++) {
			const passStartSeq = this.rebindOpSeq;
			const passAuthoritativeSnapshots = new Map<string, IAdeProjectSnapshot | undefined>();
			if (pass === 0 && initialSnapshotFreshlyFetched && scopedProjectId) {
				passAuthoritativeSnapshots.set(scopedProjectId, initialSnapshot);
			}

			const fetchAuthoritativeSnapshot = async (targetProjectId: string): Promise<IAdeProjectSnapshot | undefined> => {
				if (passAuthoritativeSnapshots.has(targetProjectId)) {
					return passAuthoritativeSnapshots.get(targetProjectId);
				}
				if (!this.controlCenter) {
					return initialSnapshot && initialSnapshot.meta.project_id === targetProjectId ? initialSnapshot : undefined;
				}
				const fetched = await this.controlCenter.getProjectSnapshot(targetProjectId).catch(() => undefined);
				passAuthoritativeSnapshots.set(targetProjectId, fetched);
				return fetched ?? (initialSnapshot && initialSnapshot.meta.project_id === targetProjectId ? initialSnapshot : undefined);
			};

			const pendingInflightPromises: Promise<void>[] = [];
			for (const group of [...this.editorGroupsService.mainPart.groups]) {
				for (const editor of [...group.editors]) {
					if (!(editor instanceof ChatEditorInput) || editor.isDisposed()) {
						continue;
					}
					const oldUri = editor.sessionResource;
					if (!oldUri || !oldUri.scheme.startsWith('aexus-')) {
						continue;
					}
					const parsed = parseAdeEmployeeSessionUri(oldUri);
					const agentRef = parsed
						? { projectId: parsed.projectId, agentId: parsed.agentId }
						: this.editorToAgentRef.get(editor);
					if (!agentRef) {
						continue;
					}
					if (scopedProjectId && agentRef.projectId !== scopedProjectId) {
						continue;
					}

					const activeRebind = this.rebindingEditors.get(editor);
					if (activeRebind) {
						pendingInflightPromises.push(activeRebind);
						continue;
					}

					// If a newer rebind request superseded this opSeq for this project, defer to the newer op
					// (unless we are running a trailing pass inside the surviving call).
					if (pass === 0 && opSeq < this.getLatestRequestedRebindSeq(agentRef.projectId)) {
						continue;
					}

					const agentKey = `${agentRef.projectId}\0${agentRef.agentId}`;

					// Fast pre-check before async work, followed by authoritative ControlCenter verification.
					const prelimSnapshot = passAuthoritativeSnapshots.get(agentRef.projectId)
						?? (initialSnapshot && initialSnapshot.meta.project_id === agentRef.projectId ? initialSnapshot : undefined);
					const prelimSnapAgent = prelimSnapshot?.agents.find(a => a.agent_id === agentRef.agentId);
					const projAgent = this.projects.getAgent(agentRef.agentId, agentRef.projectId);
					const prelimRawEngine = prelimSnapAgent?.engine ?? projAgent?.engine;
					if (prelimRawEngine && !this.controlCenter) {
						const prelimShort = normalizeAdeShortEngineId(prelimRawEngine);
						const prelimHost = prelimSnapAgent?.host ?? projAgent?.host;
						const prelimPrevHost = this.editorBoundHost.get(editor);
						const prelimHostSwitched = prelimPrevHost !== undefined
							&& prelimHost !== undefined
							&& prelimPrevHost !== prelimHost
							&& !(prelimSnapAgent ? prelimSnapAgent.session_started : projAgent?.sessionStarted);
						if (
							(ADE_REGISTERED_ENGINES as readonly string[]).includes(prelimShort)
							&& oldUri.scheme === `aexus-${prelimShort}`
							&& !this.pendingRuntimeRefreshAgents.has(agentKey)
							&& !prelimHostSwitched
						) {
							continue;
						}
					}

					const authSnapshot = await fetchAuthoritativeSnapshot(agentRef.projectId);
					if (this._store.isDisposed || editor.isDisposed() || this.rebindingEditors.has(editor)) {
						const concurrent = this.rebindingEditors.get(editor);
						if (concurrent) {
							pendingInflightPromises.push(concurrent);
						}
						continue;
					}
					if (pass === 0 && opSeq < this.getLatestRequestedRebindSeq(agentRef.projectId)) {
						continue;
					}

					const snapAgent = authSnapshot && authSnapshot.meta.project_id === agentRef.projectId
						? authSnapshot.agents.find(a => a.agent_id === agentRef.agentId)
						: undefined;
					// Any open ChatEditorInput whose scheme differs from the authoritative engine (or whose runtime/host
					// was reset via uiEditAgent allowSessionReset / host switch) must be rebound or refreshed in-place.
					const rawEngine = authSnapshot
						? snapAgent?.engine
						: (snapAgent?.engine ?? projAgent?.engine);
					if (!rawEngine) {
						this.pendingRuntimeRefreshAgents.delete(agentKey);
						continue;
					}
					const expectedShort = normalizeAdeShortEngineId(rawEngine);
					if (!(ADE_REGISTERED_ENGINES as readonly string[]).includes(expectedShort)) {
						continue;
					}
					const expectedScheme = `aexus-${expectedShort}`;
					const authoritativeHost = snapAgent?.host ?? projAgent?.host;
					const prevBoundHost = this.editorBoundHost.get(editor);
					const hasPendingRuntimeRefresh = this.pendingRuntimeRefreshAgents.has(agentKey);
					if (prevBoundHost === undefined && authoritativeHost && !hasPendingRuntimeRefresh) {
						this.editorBoundHost.set(editor, authoritativeHost);
					}
					const unstartedHostSwitched = prevBoundHost !== undefined
						&& authoritativeHost !== undefined
						&& prevBoundHost !== authoritativeHost
						&& !(snapAgent ? snapAgent.session_started : projAgent?.sessionStarted);
					const sameEngineNeedsRefresh = oldUri.scheme === expectedScheme && (hasPendingRuntimeRefresh || unstartedHostSwitched);
					if (oldUri.scheme === expectedScheme && !sameEngineNeedsRefresh) {
						continue;
					}

					let resolveEditorRebind!: () => void;
					const editorRebindPromise = new Promise<void>(resolve => {
						resolveEditorRebind = resolve;
					});
					this.rebindingEditors.set(editor, editorRebindPromise);
					try {
						await this.extensionService.activateById(AEXUS_AGENTS_EXTENSION_ID, {
							startup: false,
							extensionId: AEXUS_AGENTS_EXTENSION_ID,
							activationEvent: 'api',
						}).catch(() => undefined);
						if (this._store.isDisposed || editor.isDisposed()) {
							continue;
						}

						// Final monotonic + authoritative reconciliation right before mutating the workbench tab
						// so a slow earlier rebind never rolls a tab backwards if another engine edit arrived mid-flight.
						let finalShort = expectedShort;
						let finalSnapAgent = snapAgent;
						let finalSnapshot = authSnapshot;
						if (this.controlCenter && this.rebindOpSeq !== passStartSeq) {
							const latestSnap = await this.controlCenter.getProjectSnapshot(agentRef.projectId).catch(() => undefined);
							if (this._store.isDisposed || editor.isDisposed()) {
								continue;
							}
							if (latestSnap && latestSnap.meta.project_id === agentRef.projectId) {
								finalSnapshot = latestSnap;
								finalSnapAgent = latestSnap.agents.find(a => a.agent_id === agentRef.agentId);
								if (!finalSnapAgent?.engine) {
									this.pendingRuntimeRefreshAgents.delete(agentKey);
									continue;
								}
								const reconciledShort = normalizeAdeShortEngineId(finalSnapAgent.engine);
								if (!(ADE_REGISTERED_ENGINES as readonly string[]).includes(reconciledShort)) {
									continue;
								}
								finalShort = reconciledShort;
							}
						}
						const finalHost = finalSnapAgent?.host ?? authoritativeHost;
						const finalSameEngineNeedsRefresh = oldUri.scheme === `aexus-${finalShort}` && (
							this.pendingRuntimeRefreshAgents.has(agentKey)
							|| (
								prevBoundHost !== undefined
								&& finalHost !== undefined
								&& prevBoundHost !== finalHost
								&& !(finalSnapAgent ? finalSnapAgent.session_started : projAgent?.sessionStarted)
							)
						);
						if (oldUri.scheme === `aexus-${finalShort}` && !finalSameEngineNeedsRefresh) {
							continue;
						}
						this.pendingRuntimeRefreshAgents.delete(agentKey);

						if (finalHost) {
							await resolveEmployeeWorkspaceCwdUri({
								host: finalHost,
								folderUri: finalSnapshot?.meta.folder_uri ?? projAgent?.projectUri.toString(),
								projectHosts: finalSnapshot?.hosts,
								cloudHosts: this.cloudHosts,
							}).catch(() => undefined);
							if (this._store.isDisposed || editor.isDisposed()) {
								continue;
							}
						}

						const nextUri = buildAdeEmployeeSessionUri(finalShort, agentRef.projectId, agentRef.agentId);
						const wasActive = group.activeEditor === editor;
						const editorIndex = group.editors.indexOf(editor);
						const isPinned = typeof group.isPinned === 'function' ? group.isPinned(editor) : true;

						try {
							editor.releaseModel();
						} catch { /* ignore */ }
						const maybeClearChat = this.chatService as (IChatService & {
							readonly clearSession?: (resource: URI) => Promise<void> | void;
						}) | undefined;
						if (typeof maybeClearChat?.clearSession === 'function') {
							await Promise.resolve(maybeClearChat.clearSession(oldUri)).catch(() => undefined);
						}
						if (typeof this.chatService?.removeHistoryEntry === 'function') {
							await this.chatService.removeHistoryEntry(oldUri).catch(() => undefined);
						}
						if (this._store.isDisposed) {
							continue;
						}

						const currentProjAgent = this.projects.getAgent(agentRef.agentId, agentRef.projectId) ?? projAgent;
						const alreadyInGroup = group.editors.find(
							(candidate): candidate is ChatEditorInput => candidate !== editor && candidate instanceof ChatEditorInput && !candidate.isDisposed() && candidate.sessionResource?.toString() === nextUri.toString(),
						);
						if (alreadyInGroup) {
							if (finalHost) {
								this.editorBoundHost.set(alreadyInGroup, finalHost);
							}
							if (wasActive) {
								await this.editorService.openEditor(alreadyInGroup, { pinned: isPinned }, group.id);
								if (
									!alreadyInGroup.isDisposed()
									&& !alreadyInGroup.hasResolvedModel
									&& typeof this.chatService?.acquireOrLoadSession === 'function'
								) {
									await alreadyInGroup.resolve().catch(() => null);
								}
							}
							await this.editorService.closeEditors([{ editor, groupId: group.id }]);
						} else {
							const label = currentProjAgent?.label ?? finalSnapAgent?.name ?? agentRef.agentId;
							const replacementInput = currentProjAgent
								? this.createAgentChatInput(currentProjAgent, nextUri, finalHost)
								: (() => {
									const created = this.instantiationService.createInstance(AdeLineageChatEditorInput, nextUri, {
										title: { preferred: label, override: label },
									});
									created.setLineageProvider(() => this.formatLineageForSession(nextUri));
									this.editorToAgentRef.set(created, { projectId: agentRef.projectId, agentId: agentRef.agentId });
									if (finalHost) {
										this.editorBoundHost.set(created, finalHost);
									}
									return created;
								})();
							const replaceOptions: IEditorOptions = {
								pinned: isPinned,
								...(editorIndex >= 0 ? { index: editorIndex } : {}),
								preserveFocus: !wasActive,
								inactive: !wasActive,
							};
							if (typeof group.replaceEditors === 'function') {
								await group.replaceEditors([{
									editor,
									replacement: replacementInput,
									options: replaceOptions,
									forceReplaceDirty: true,
								}]);
							} else {
								await this.editorService.openEditor(replacementInput, replaceOptions, group.id);
								await this.editorService.closeEditors([{ editor, groupId: group.id }]);
							}
							if (
								wasActive
								&& !replacementInput.isDisposed()
								&& !replacementInput.hasResolvedModel
								&& typeof this.chatService?.acquireOrLoadSession === 'function'
							) {
								await replacementInput.resolve().catch(() => null);
							}
						}
						this.editorToAgentRef.delete(editor);
						if (!editor.isDisposed()) {
							editor.dispose();
						}
						reboundCount++;
					} finally {
						this.rebindingEditors.delete(editor);
						resolveEditorRebind();
					}
				}
			}

			if (pendingInflightPromises.length > 0) {
				await Promise.allSettled(pendingInflightPromises);
				continue;
			}
			if (this.rebindOpSeq !== passStartSeq) {
				continue;
			}
			break;
		}
		if (reboundCount > 0) {
			this.updateTitles();
		}
		return reboundCount;
	}

	async openProjectPage(projectId: string, options?: IAdeProjectOpenOptions): Promise<void> {
		const trimmed = projectId.trim();
		if (!trimmed) {
			return;
		}
		this.projects.selectProjectPage(trimmed);
		const page = this.projects.getProjectPage(trimmed);
		if (page) {
			this.projects.selectProject(page.folderUri);
		}

		const pendingFocus = options?.focusNodeId ? {
			nodeId: options.focusNodeId,
			highlightNodeIds: options.highlightNodeIds,
			openPopover: options.openPopover,
			openAgentBeside: options.openAgentBeside,
		} : undefined;

		const applyPendingFocus = (editor: EditorInput, pane: unknown): void => {
			if (!pendingFocus) {
				return;
			}
			const duckInput = editor as unknown as {
				setPendingFocus?: (focus: unknown) => void;
				consumePendingFocus?: () => { nodeId: string; highlightNodeIds?: readonly string[]; openPopover?: string; openAgentBeside?: boolean } | undefined;
			};
			const duckPane = pane as {
				focusNode?: (nodeId: string, opts?: Record<string, unknown>) => void;
			} | undefined;
			const unconsumed = typeof duckInput.consumePendingFocus === 'function' ? duckInput.consumePendingFocus() : pendingFocus;
			if (unconsumed && duckPane && typeof duckPane.focusNode === 'function') {
				duckPane.focusNode(unconsumed.nodeId, {
					highlightNodeIds: unconsumed.highlightNodeIds,
					openPopover: unconsumed.openPopover,
					openAgentBeside: unconsumed.openAgentBeside,
				});
			}
		};

		if (options?.preferExistingGroup !== false) {
			const activeGroup = this.editorGroupsService.mainPart.activeGroup;
			const existing = options?.side
				? this.findOpenProjectPageEditor(trimmed, activeGroup)
				: this.findOpenProjectPageEditor(trimmed);
			if (existing) {
				const duckInput = existing.editor as unknown as { setPendingFocus?: (focus: unknown) => void };
				if (pendingFocus && typeof duckInput.setPendingFocus === 'function') {
					duckInput.setPendingFocus(pendingFocus);
				}
				const pane = await this.editorService.openEditor(existing.editor, { pinned: true }, existing.group.id);
				applyPendingFocus(existing.editor, pane);
				return;
			}
		}

		const targetGroup = this.resolveTargetGroup(options?.side);
		const input = await this.createProjectPageEditorInput(trimmed);
		const duckInput = input as unknown as { setPendingFocus?: (focus: unknown) => void };
		if (pendingFocus && typeof duckInput.setPendingFocus === 'function') {
			duckInput.setPendingFocus(pendingFocus);
		}
		const pane = await this.editorService.openEditor(input, { pinned: true }, targetGroup.id);
		applyPendingFocus(input, pane);
	}

	private async createProjectPageEditorInput(projectId: string): Promise<EditorInput> {
		const serializer = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).getEditorSerializer(ADE_PROJECT_CANVAS_INPUT_ID);
		if (serializer) {
			const deserialized = serializer.deserialize(this.instantiationService, JSON.stringify({ v: 2, projectId }));
			if (deserialized) {
				return deserialized;
			}
		}
		try {
			const mod = await import('./adeEngineeringEditorPane.js');
			return this.instantiationService.createInstance(mod.AdeEngineeringEditorInput, projectId);
		} catch {
			return new AdeFallbackProjectEditorInput(projectId, this.projects);
		}
	}

	async closeEditorsForProject(projectId: string): Promise<void> {
		const trimmed = projectId.trim();
		if (!trimmed) {
			return;
		}
		await this.closeEditors(editor => {
			if (extractProjectPageIdFromEditor(editor) === trimmed) {
				return true;
			}
			const mapped = this.ensureEditorAgentBinding(editor);
			if (editor instanceof AdeSessionEditorInput) {
				const pid = editor.projectId || mapped?.projectId;
				return pid === trimmed;
			}
			if (editor instanceof AdeExtensionWebviewEditorInput) {
				const pid = mapped?.projectId || editor.projectId;
				return pid === trimmed;
			}
			if (editor instanceof ChatEditorInput) {
				if (mapped?.projectId) {
					return mapped.projectId === trimmed;
				}
				if (parseAdeEmployeeSessionUri(editor.sessionResource)?.projectId === trimmed) {
					return true;
				}
			}
			if (mapped) {
				return mapped.projectId === trimmed;
			}
			return this.getAgentForEditor(editor)?.projectId === trimmed;
		});
	}

	async closeProjectPageEditors(projectId: string): Promise<void> {
		await this.closeEditorsForProject(projectId);
	}

	async openAgent(id: string, options?: { readonly projectId?: string; readonly side?: boolean }): Promise<void> {
		const agentId = id.trim();
		if (!agentId || agentId.startsWith('__aexus_')) {
			return;
		}
		let resolvedProjectId = options?.projectId?.trim()
			|| this.getActiveProjectPageId()
			|| this.projects.selectedProjectPageId
			|| this.projects.getAgent(agentId)?.projectId;

		let agent = this.projects.getAgent(agentId, resolvedProjectId);
		if (!agent && resolvedProjectId && this.controlCenter) {
			const snap = await this.controlCenter.getProjectSnapshot(resolvedProjectId).catch(() => undefined);
			if (snap) {
				this.projects.notifyProjectSnapshotLoaded(snap);
				agent = this.projects.getAgent(agentId, resolvedProjectId);
			}
		}
		if (agent) {
			resolvedProjectId = agent.projectId;
			this.projects.selectProjectPage(agent.projectId);
			this.projects.selectAgent(agent.id, agent.projectId);
			this.projects.markRead(agent.id, agent.projectId);
		}

		let sessionUri = agent?.session.resource;
		if (resolvedProjectId && this.controlCenter) {
			const [bundle, snap] = await Promise.all([
				this.controlCenter.issueAgentLaunchBundle(resolvedProjectId, agentId).catch(() => undefined),
				agent ? Promise.resolve(undefined) : this.controlCenter.getProjectSnapshot(resolvedProjectId).catch(() => undefined),
			]);
			if (snap) {
				this.projects.notifyProjectSnapshotLoaded(snap);
				agent = this.projects.getAgent(agentId, resolvedProjectId);
			}
			if (bundle) {
				sessionUri = URI.parse(bundle.sessionResource);
				const resolvedCwd = await resolveEmployeeWorkspaceCwdUri({
					host: bundle.host,
					folderUri: snap?.meta.folder_uri ?? agent?.projectUri.toString(),
					bundle,
					projectHosts: snap?.hosts,
					cloudHosts: this.cloudHosts,
				}).catch(() => undefined);
				if (resolvedCwd && bundle.host.trim().toLowerCase() !== 'local') {
					this.resolvedAgentCwdUriByKey.set(`${resolvedProjectId}\0${agentId}`, URI.parse(resolvedCwd));
				} else {
					this.resolvedAgentCwdUriByKey.delete(`${resolvedProjectId}\0${agentId}`);
				}
			} else if (agent && !sessionUri) {
				sessionUri = buildAdeEmployeeSessionUri(agent.engine, agent.projectId, agent.id);
			}
		}

		await this.extensionService.activateById(AEXUS_AGENTS_EXTENSION_ID, {
			startup: false,
			extensionId: AEXUS_AGENTS_EXTENSION_ID,
			activationEvent: 'api',
		}).catch(() => undefined);

		const matchesTransitionalSessionEditor = (editor: EditorInput): boolean => {
			if (!(editor instanceof AdeSessionEditorInput)) {
				return false;
			}
			if (!editor.agentId) {
				return true;
			}
			if (editor.agentId !== agentId) {
				return false;
			}
			const mapped = this.ensureEditorAgentBinding(editor);
			const editorProjectId = editor.projectId || mapped?.projectId;
			return !resolvedProjectId || !editorProjectId || editorProjectId === resolvedProjectId;
		};

		await this.closeEditors(editor => {
			if (editor instanceof ChatEditorInput || editor instanceof AdeSessionEditorInput) {
				return false;
			}
			const mapped = this.ensureEditorAgentBinding(editor);
			if (editor instanceof AdeExtensionWebviewEditorInput) {
				const ref = mapped ?? (editor.projectId ? { projectId: editor.projectId, agentId: editor.agentId } : undefined);
				return ref
					? ref.projectId === resolvedProjectId && ref.agentId === agentId
					: editor.agentId === agentId;
			}
			if (mapped) {
				return mapped.agentId === agentId && (!resolvedProjectId || !mapped.projectId || mapped.projectId === resolvedProjectId);
			}
			return false;
		});

		if (sessionUri && !options?.side) {
			const existing = this.findOpenChatEditor(sessionUri);
			if (existing) {
				await this.editorService.openEditor(existing.editor, { pinned: true }, existing.group.id);
				this.updateTitles();
				await this.closeEditors(matchesTransitionalSessionEditor);
				return;
			}
		}

		const targetGroup = this.resolveTargetGroup(options?.side);
		let input: EditorInput;
		if (agent && sessionUri) {
			input = this.createAgentChatInput(agent, sessionUri);
		} else {
			const sessionInput = this.instantiationService.createInstance(AdeSessionEditorInput, agentId, resolvedProjectId);
			if (resolvedProjectId) {
				this.editorToAgentRef.set(sessionInput, { projectId: resolvedProjectId, agentId });
			}
			input = sessionInput;
		}
		await this.editorService.openEditor(input, { pinned: true }, targetGroup.id);
		this.updateTitles();
		if (agent && sessionUri) {
			await this.closeEditors(matchesTransitionalSessionEditor);
		}
	}

	async openCloudHosts(hostIdOrAlias?: string, options?: { readonly side?: boolean }): Promise<void> {
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

	private async closeEditors(matches: (editor: EditorInput) => boolean): Promise<void> {
		const targets = this.editorGroupsService.mainPart.groups.flatMap(group =>
			group.editors.filter(matches).map(editor => ({ editor, groupId: group.id })),
		);
		if (targets.length > 0) {
			await this.editorService.closeEditors(targets);
		}
	}

	async closeAgents(agents: readonly IAdeAgent[]): Promise<void> {
		if (agents.length === 0) {
			return;
		}
		const toCompositeKey = (projectId: string, agentId: string) => `${projectId}\0${agentId}`;
		const compositeKeys = new Set(agents.map(agent => toCompositeKey(agent.projectId, agent.id)));
		const fallbackBareIds = new Set(agents.map(agent => agent.id));
		const resources = new Set(agents.map(agent => agent.session.resource.toString()));
		await this.closeEditors(editor => {
			const mapped = this.ensureEditorAgentBinding(editor);
			if (editor instanceof AdeSessionEditorInput) {
				const pid = editor.projectId || mapped?.projectId;
				return pid
					? compositeKeys.has(toCompositeKey(pid, editor.agentId))
					: fallbackBareIds.has(editor.agentId);
			}
			if (editor instanceof AdeExtensionWebviewEditorInput) {
				const pid = mapped?.projectId || editor.projectId;
				return pid
					? compositeKeys.has(toCompositeKey(pid, editor.agentId))
					: fallbackBareIds.has(editor.agentId);
			}
			if (mapped) {
				const matchedMapped = mapped.projectId
					? compositeKeys.has(toCompositeKey(mapped.projectId, mapped.agentId))
					: fallbackBareIds.has(mapped.agentId);
				if (matchedMapped) {
					return true;
				}
			}
			if (editor instanceof ChatEditorInput && editor.sessionResource) {
				if (resources.has(editor.sessionResource.toString())) {
					return true;
				}
				const parsed = parseAdeEmployeeSessionUri(editor.sessionResource);
				if (parsed) {
					return parsed.projectId
						? compositeKeys.has(toCompositeKey(parsed.projectId, parsed.agentId))
						: fallbackBareIds.has(parsed.agentId);
				}
			}
			return false;
		});
	}

	async openFile(resource: URI, projectUriOrAgentId?: URI | string, options?: IEditorOptions): Promise<void> {
		if (URI.isUri(projectUriOrAgentId)) {
			this.projects.selectProject(projectUriOrAgentId);
		} else if (typeof projectUriOrAgentId === 'string') {
			this.projects.selectAgent(projectUriOrAgentId, this.getActiveProjectPageId());
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
