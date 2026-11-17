/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export const ProjectFocusedContext = new RawContextKey<boolean>('aexusIdeProjectFocused', false);
export const ProjectForwardContext = new RawContextKey<boolean>('aexusIdeProjectCanGoForward', false);
export const IProjectNavigationService = createDecorator<IProjectNavigationService>('projectNavigationService');

export interface IProjectNavigationService {
	readonly _serviceBrand: undefined;
	readonly focusedProject: IWorkspaceFolder | undefined;
	readonly selectedProject: IWorkspaceFolder | undefined;
	readonly onDidChangeSelectedProject: Event<IWorkspaceFolder | undefined>;
	readonly codingAgentProjects: ReadonlyMap<string, URI>;
	readonly onDidBindCodingAgentProject: Event<{ extensionId: string; project: URI }>;
	bindCodingAgentProject(extensionId: string): void;
	selectProject(resource: URI): void;
	readonly onDidChangeProject: Event<IWorkspaceFolder | undefined>;
	readonly orderedProjects: readonly IWorkspaceFolder[];
	readonly onDidChangeProjectOrder: Event<void>;
	moveProjects(resources: readonly URI[], target: URI | undefined, after: boolean): void;
	enterProject(resource: URI): void;
	goHome(): void;
	readonly canGoForward: boolean;
	goForward(): void;
}

export class ProjectNavigationService extends Disposable implements IProjectNavigationService {
	declare readonly _serviceBrand: undefined;
	private focusedResource: URI | undefined;
	private selectedResource: URI | undefined;
	private forwardResource: URI | undefined;
	private readonly selectedEmitter = this._register(new Emitter<IWorkspaceFolder | undefined>());
	readonly onDidChangeSelectedProject = this.selectedEmitter.event;
	readonly codingAgentProjects: Map<string, URI>;
	private readonly bindingEmitter = this._register(new Emitter<{ extensionId: string; project: URI }>());
	readonly onDidBindCodingAgentProject = this.bindingEmitter.event;
	private readonly focusedContext: IContextKey<boolean>;
	private readonly forwardContext: IContextKey<boolean>;
	private readonly changeEmitter = this._register(new Emitter<IWorkspaceFolder | undefined>());
	readonly onDidChangeProject = this.changeEmitter.event;
	private readonly orderEmitter = this._register(new Emitter<void>());
	readonly onDidChangeProjectOrder = this.orderEmitter.event;
	private ordered: IWorkspaceFolder[];

	constructor(
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.focusedContext = ProjectFocusedContext.bindTo(contextKeyService);
		this.forwardContext = ProjectForwardContext.bindTo(contextKeyService);
		const selected = storageService.get('aexus.ide.selectedProject', StorageScope.WORKSPACE);
		this.selectedResource = selected ? URI.parse(selected) : undefined;
		this.codingAgentProjects = new Map(storageService.getObject<[string, string][]>('aexus.ide.codingAgentProjects', StorageScope.WORKSPACE, []).map(([id, resource]) => [id, URI.parse(resource)]));
		this.ordered = this.sortProjects(storageService.getObject<string[]>('aexus.ide.projectOrder', StorageScope.WORKSPACE, []));
		if (!this.selectedProject && this.ordered.length === 1) { this.setSelectedProject(this.ordered[0]); }
		this._register(contextService.onDidChangeWorkspaceFolders(() => {
			this.ordered = this.sortProjects(this.ordered.map(folder => this.projectKey(folder.uri)));
			this.saveOrder();
			const activeKeys = new Set(this.ordered.map(folder => this.projectKey(folder.uri)));
			let prunedBindings = false;
			for (const [id, uri] of [...this.codingAgentProjects]) {
				if (!activeKeys.has(this.projectKey(uri))) {
					this.codingAgentProjects.delete(id);
					prunedBindings = true;
				}
			}
			if (prunedBindings) {
				this.storageService.store('aexus.ide.codingAgentProjects', JSON.stringify([...this.codingAgentProjects].map(([id, resource]) => [id, resource.toString()])), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
			if (this.focusedResource && !this.focusedProject) {
				this.goHome();
			}
			if (this.forwardResource && !this.canGoForward) { this.forwardResource = undefined; this.forwardContext.set(false); }
			if (!this.selectedProject) {
				this.setSelectedProject(this.ordered.length === 1 ? this.ordered[0] : undefined);
			}
			this.orderEmitter.fire();
		}));
	}

	get orderedProjects(): readonly IWorkspaceFolder[] { return this.ordered; }

	private projectKey(resource: URI): string { return this.uriIdentityService.extUri.getComparisonKey(resource); }

	private sortProjects(order: string[]): IWorkspaceFolder[] {
		const positions = new Map(order.map((key, index) => [key, index]));
		return [...this.contextService.getWorkspace().folders].sort((a, b) => (positions.get(this.projectKey(a.uri)) ?? positions.size + a.index) - (positions.get(this.projectKey(b.uri)) ?? positions.size + b.index));
	}

	moveProjects(resources: readonly URI[], target: URI | undefined, after: boolean): void {
		const keys = new Set(resources.map(resource => this.projectKey(resource)));
		const moving = this.ordered.filter(folder => keys.has(this.projectKey(folder.uri)));
		if (!moving.length || target && keys.has(this.projectKey(target))) {
			return;
		}
		const remaining = this.ordered.filter(folder => !keys.has(this.projectKey(folder.uri)));
		let index = target ? remaining.findIndex(folder => this.uriIdentityService.extUri.isEqual(folder.uri, target)) : remaining.length;
		if (index < 0) {
			return;
		}
		if (target && after) {
			index++;
		}
		remaining.splice(index, 0, ...moving);
		if (remaining.every((folder, index) => folder === this.ordered[index])) {
			return;
		}
		this.ordered = remaining;
		this.saveOrder();
		this.orderEmitter.fire();
	}

	private saveOrder(): void {
		this.storageService.store('aexus.ide.projectOrder', JSON.stringify(this.ordered.map(folder => this.projectKey(folder.uri))), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	get focusedProject(): IWorkspaceFolder | undefined {
		return this.focusedResource ? this.contextService.getWorkspace().folders.find(folder => this.uriIdentityService.extUri.isEqual(folder.uri, this.focusedResource)) : undefined;
	}

	get selectedProject(): IWorkspaceFolder | undefined {
		return this.focusedProject ?? this.contextService.getWorkspace().folders.find(folder => this.uriIdentityService.extUri.isEqual(folder.uri, this.selectedResource));
	}

	bindCodingAgentProject(extensionId: string): void {
		const project = this.selectedProject;
		extensionId = extensionId.toLowerCase();
		if (!project || this.uriIdentityService.extUri.isEqual(this.codingAgentProjects.get(extensionId), project.uri)) { return; }
		this.codingAgentProjects.set(extensionId, project.uri);
		this.storageService.store('aexus.ide.codingAgentProjects', JSON.stringify([...this.codingAgentProjects].map(([id, resource]) => [id, resource.toString()])), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.bindingEmitter.fire({ extensionId, project: project.uri });
	}

	selectProject(resource: URI): void {
		const project = this.focusedProject ?? this.contextService.getWorkspace().folders
			.filter(folder => this.uriIdentityService.extUri.isEqualOrParent(resource, folder.uri))
			.sort((a, b) => b.uri.path.length - a.uri.path.length)[0];
		if (project) {
			this.setSelectedProject(project);
		}
	}

	private setSelectedProject(project: IWorkspaceFolder | undefined): void {
		if (this.uriIdentityService.extUri.isEqual(project?.uri, this.selectedResource)) {
			return;
		}
		this.selectedResource = project?.uri;
		this.storageService.store('aexus.ide.selectedProject', project?.uri.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.selectedEmitter.fire(project);
	}

	enterProject(resource: URI): void {
		const project = this.contextService.getWorkspace().folders.find(folder => this.uriIdentityService.extUri.isEqual(folder.uri, removeTrailingPathSeparator(resource)));
		if (!project || this.uriIdentityService.extUri.isEqual(project.uri, this.focusedResource)) {
			return;
		}
		this.focusedResource = project.uri;
		this.forwardResource = undefined;
		this.forwardContext.set(false);
		this.setSelectedProject(project);
		this.focusedContext.set(true);
		this.changeEmitter.fire(project);
	}

	goHome(): void {
		if (!this.focusedResource) {
			return;
		}
		this.forwardResource = this.focusedResource;
		this.focusedResource = undefined;
		this.focusedContext.set(false);
		this.forwardContext.set(this.canGoForward);
		this.changeEmitter.fire(undefined);
	}

	get canGoForward(): boolean {
		return !this.focusedResource && !!this.forwardResource && this.ordered.some(project => this.uriIdentityService.extUri.isEqual(project.uri, this.forwardResource));
	}

	goForward(): void {
		if (this.canGoForward && this.forwardResource) { this.enterProject(this.forwardResource); }
	}
}

registerSingleton(IProjectNavigationService, ProjectNavigationService, InstantiationType.Delayed);
