/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ADE_ORGANIZATION_CONFIG_KEY, ADE_ORGANIZATION_PRESETS } from '../../../../../platform/ade/common/adeRoleSchema.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, toWorkspaceFolder, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../../files/browser/projectNavigationService.js';
import { AdeProjectsService } from '../../browser/adeProjectsService.js';
import { AdeProjectsChangeKind } from '../../common/ade.js';

suite('ADE project sessions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('notifies project context when selecting a project or one of its children', () => {
		const instantiation = workbenchInstantiationService(undefined, store);
		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		const first = projects.addProject(URI.file('/ade/first'));
		const second = projects.addProject(URI.file('/ade/second'));
		const child = projects.addAgent(second.id, 'Review');
		const selected: (string | undefined)[] = [];
		store.add(projects.onDidChange(() => selected.push(projects.selectedProject?.name)));
		projects.selectAgent(first.id);
		projects.selectAgent(child.id);
		projects.selectAgent(second.id);
		assert.deepStrictEqual(selected, ['first', 'second']);
	});

	test('restores independent parent and child conversation drafts, roles, and Secretary state', () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const projects = store.add(instantiationService.createInstance(AdeProjectsService));
		const parent = projects.addProject(URI.file('/ade/project'));
		projects.setAgentRole(parent.id, 'governor');
		const manager = projects.addAgent(parent.id, 'Architecture', 'manager');
		const employee = projects.addAgent(manager.id, 'Tests', 'employee');
		projects.setDraft(parent.id, 'Plan the project');
		projects.setDraft(manager.id, 'Review the implementation');
		projects.renameAgent(manager.id, 'Code Review');
		projects.setSecretaryDraft('Inspect active workspace');
		projects.configureSecretary({ engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/sec-1') });

		const restored = store.add(instantiationService.createInstance(AdeProjectsService));
		assert.deepStrictEqual({
			agents: restored.agents.map(agent => ({
				id: agent.id,
				parentId: agent.parentId,
				path: agent.projectUri.path,
				label: agent.label,
				role: agent.role,
				draft: agent.draft,
			})),
			secretary: {
				engineId: restored.secretary.session?.engineId,
				resource: restored.secretary.session?.resource.toString(),
				draft: restored.secretary.draft,
			},
		}, {
			agents: [
				{ id: parent.id, parentId: undefined, path: '/ade/project', label: 'project', role: 'governor', draft: 'Plan the project' },
				{ id: manager.id, parentId: parent.id, path: '/ade/project', label: 'Code Review', role: 'manager', draft: 'Review the implementation' },
				{ id: employee.id, parentId: manager.id, path: '/ade/project', label: 'Tests', role: 'employee', draft: '' },
			],
			secretary: {
				engineId: 'aexus-claude',
				resource: 'aexus-claude:/sec-1',
				draft: 'Inspect active workspace',
			},
		});
	});

	test('deduplicates a project folder and removes multi-level Agent subtrees cleanly', () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const projects = store.add(instantiationService.createInstance(AdeProjectsService));
		const first = projects.addProject(URI.file('/ade/first'));
		const duplicate = projects.addProject(URI.file('/ade/first/'));
		const second = projects.addProject(URI.file('/ade/second'));
		const l2 = projects.addAgent(first.id, 'Manager', 'manager');
		const l3 = projects.addAgent(l2.id, 'Employee', 'employee');
		projects.addAgent(l3.id, 'Subordinate', 'subordinate');
		assert.strictEqual(projects.getSubtree(first.id).length, 4);
		projects.removeAgent(first.id);
		assert.deepStrictEqual({ duplicateId: duplicate.id, remaining: projects.agents.map(agent => agent.id) }, { duplicateId: first.id, remaining: [second.id] });
	});

	test('persists project order independently of conversation drafts and descendants', () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const projects = store.add(instantiationService.createInstance(AdeProjectsService));
		const first = projects.addProject(URI.file('/ade/first'));
		const child = projects.addAgent(first.id, 'Worker');
		projects.addAgent(child.id, 'Nested Worker');
		const second = projects.addProject(URI.file('/ade/second'));
		const third = projects.addProject(URI.file('/ade/third'));
		projects.setDraft(first.id, 'Keep this draft');
		projects.setDraft(child.id, 'Keep this child draft');
		const changes: (AdeProjectsChangeKind | void)[] = [];
		store.add(projects.onDidChange(change => changes.push(change)));
		const order = () => projects.agents.filter(agent => !agent.parentId).map(agent => agent.label);
		const orders: string[][] = [];
		projects.moveProject(third.id, first.id, false);
		orders.push(order());
		projects.moveProject(first.id, second.id, true);
		orders.push(order());
		projects.moveProject(third.id, undefined, true);
		orders.push(order());
		projects.moveProject(second.id, first.id, false);
		projects.moveProject(child.id, first.id, false);
		const restored = store.add(instantiationService.createInstance(AdeProjectsService));
		const drafts = restored.agents.filter(agent => agent.draft).map(agent => agent.draft);
		restored.removeAgent(first.id);
		assert.deepStrictEqual({ orders, changes, drafts, remaining: restored.agents.map(agent => agent.label) }, {
			orders: [['third', 'first', 'second'], ['third', 'second', 'first'], ['second', 'first', 'third']],
			changes: ['order', 'order', 'order'],
			drafts: ['Keep this draft', 'Keep this child draft'],
			remaining: ['second', 'third'],
		});
	});

	test('archives entire team subtrees and tracks live status and unread transitions', () => {
		const alpha = URI.file('/projects/Alpha');
		const beta = URI.file('/projects/Beta');
		const instantiation = workbenchInstantiationService(undefined, store);
		instantiation.stub(IWorkspaceContextService, {
			getWorkspace: () => new Workspace('ade-archive-status', [toWorkspaceFolder(alpha), toWorkspaceFolder(beta)]),
			onDidChangeWorkspaceFolders: Event.None,
		});
		const nav = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, nav);
		const projects = store.add(instantiation.createInstance(AdeProjectsService));

		const alphaRoot = projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/a1') }, 'Alpha Root');
		const alphaSub = projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/a2') }, 'Alpha Sub', { parentId: alphaRoot.id, role: 'employee' });
		const betaWorker = projects.addSession(beta, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/b1') }, 'Beta Worker');

		// Transition working -> idle while in background marks unread; active in editor stays read
		projects.syncSessionItem(URI.parse('aexus-codex:/a2'), { status: 'working' }, false);
		projects.syncSessionItem(URI.parse('aexus-claude:/b1'), { status: 'working' }, false);
		const workingFlags = {
			sub: projects.getAgent(alphaSub.id)?.status,
			beta: projects.getAgent(betaWorker.id)?.status,
		};

		projects.syncSessionItem(URI.parse('aexus-codex:/a2'), { status: 'idle' }, false);
		projects.syncSessionItem(URI.parse('aexus-claude:/b1'), { status: 'idle' }, true);
		const completionUnreadFlags = {
			subUnread: Boolean(projects.getAgent(alphaSub.id)?.unread),
			betaUnread: Boolean(projects.getAgent(betaWorker.id)?.unread),
		};

		// Archive Alpha Root -> entire Alpha subtree becomes archived and clears unread
		projects.setArchived(alphaRoot.id, true);
		const archivedFlags = {
			root: projects.isArchived(alphaRoot.id),
			sub: projects.isArchived(alphaSub.id),
			beta: projects.isArchived(betaWorker.id),
			subUnreadCleared: !projects.getAgent(alphaSub.id)?.unread,
		};

		projects.setArchived(alphaRoot.id, false);
		assert.deepStrictEqual({
			projectNames: projects.projects.map(project => project.name),
			workingFlags,
			completionUnreadFlags,
			archivedFlags,
			restoredRootArchived: projects.isArchived(alphaRoot.id),
		}, {
			projectNames: ['Alpha', 'Beta'],
			workingFlags: { sub: 'working', beta: 'working' },
			completionUnreadFlags: { subUnread: true, betaUnread: false },
			archivedFlags: { root: true, sub: true, beta: false, subUnreadCleared: true },
			restoredRootArchived: false,
		});
	});

	test('hot-swaps leaf workers and multi-level sub-teams across supervisors and projects while maintaining valid ranks and trees', () => {
		const alpha = URI.file('/projects/Alpha');
		const beta = URI.file('/projects/Beta');
		const instantiation = workbenchInstantiationService(undefined, store);
		const projects = store.add(instantiation.createInstance(AdeProjectsService));

		const govAlpha = projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/ga') }, 'Alpha Gov', { role: 'governor' });
		const mgrAlpha = projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/ma') }, 'Alpha Mgr', { parentId: govAlpha.id, role: 'manager' });
		const cleanWorker = projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/wa') }, 'Clean Worker', { parentId: mgrAlpha.id });

		const govBeta = projects.addSession(beta, { engineId: 'aexus-antigravity', resource: URI.parse('aexus-antigravity:/gb') }, 'Beta Gov', { role: 'governor' });
		const mgrBeta = projects.addSession(beta, { engineId: 'aexus-pi', resource: URI.parse('aexus-pi:/mb') }, 'Beta Mgr', { parentId: govBeta.id, role: 'manager' });

		// 1. Hot-swap leaf Worker directly under Beta Manager (moves across projects & keeps clean undefined Worker role)
		const movedWorkerOk = projects.reparentAgent(cleanWorker.id, mgrBeta.id);
		const workerAfterMove = projects.getAgent(cleanWorker.id)!;

		// 2. Hot-swap Alpha Mgr (with a nested child) under Beta Mgr (also has a sub-team) -> cascade steps down Alpha Mgr -> employee, child Worker stays clean
		const nestedEmp = projects.addSession(alpha, { engineId: 'aexus-dsh', resource: URI.parse('aexus-dsh:/na') }, 'Sub Lead', { parentId: mgrAlpha.id, role: 'employee' });
		const nestedLeaf = projects.addSession(alpha, { engineId: 'aexus-cline', resource: URI.parse('aexus-cline:/nl') }, 'Sub Leaf', { parentId: nestedEmp.id });
		const movedTeamOk = projects.reparentAgent(mgrAlpha.id, mgrBeta.id);

		const alphaGovTreeAfter = projects.getAgentTree(govAlpha.id)!;
		const betaGovTreeAfter = projects.getAgentTree(govBeta.id)!;
		const betaMgrDirectIds = projects.getDirectSubordinates(mgrBeta.id).map(a => a.id);

		// 3. Reject dropping under a leaf Worker or creating a cycle
		const workerTargetRejected = projects.canReparentAgent(nestedEmp.id, cleanWorker.id);
		const cycleRejected = projects.canReparentAgent(govBeta.id, nestedLeaf.id);

		assert.deepStrictEqual({
			movedWorkerOk,
			workerParent: workerAfterMove.parentId,
			workerRoleClean: workerAfterMove.role === undefined,
			workerProject: workerAfterMove.projectUri.path,
			movedTeamOk,
			alphaGovDirectCount: alphaGovTreeAfter.children.length,
			betaMgrDirectIds,
			cascadedMgrRole: projects.getAgent(mgrAlpha.id)?.role,
			cascadedTeamProjectPaths: [
				projects.getAgent(mgrAlpha.id)?.projectUri.path,
				projects.getAgent(nestedEmp.id)?.projectUri.path,
				projects.getAgent(nestedLeaf.id)?.projectUri.path,
			],
			betaTreeChildCount: betaGovTreeAfter.children[0].children.length,
			workerTargetRejected,
			cycleRejected,
		}, {
			movedWorkerOk: true,
			workerParent: mgrBeta.id,
			workerRoleClean: true,
			workerProject: '/projects/Beta',
			movedTeamOk: true,
			alphaGovDirectCount: 0,
			betaMgrDirectIds: [mgrAlpha.id, cleanWorker.id],
			cascadedMgrRole: 'employee',
			cascadedTeamProjectPaths: ['/projects/Beta', '/projects/Beta', '/projects/Beta'],
			betaTreeChildCount: 2,
			workerTargetRejected: false,
			cycleRejected: false,
		});
	});

	test('synchronizes removeProject and workspace folder removal across sessions, archived teams, and project list', () => {
		const alpha = URI.file('/projects/Alpha');
		const beta = URI.file('/projects/Beta');
		const alphaFolder = toWorkspaceFolder(alpha);
		const betaFolder = toWorkspaceFolder(beta);
		let activeFolders = [alphaFolder, betaFolder];
		const onFoldersChanged = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());

		const instantiation = workbenchInstantiationService(undefined, store);
		instantiation.stub(IWorkspaceContextService, {
			getWorkspace: () => new Workspace('sync-remove', activeFolders),
			onDidChangeWorkspaceFolders: onFoldersChanged.event,
		});
		const nav = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, nav);
		const projects = store.add(instantiation.createInstance(AdeProjectsService));

		const alphaLead = projects.addSession(alpha, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/al') }, 'Alpha Lead', { role: 'governor' });
		projects.addSession(alpha, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/as') }, 'Alpha Sub', { parentId: alphaLead.id });
		const betaLead = projects.addSession(beta, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/bl') }, 'Beta Lead');
		projects.setArchived(betaLead.id, true);
		projects.selectAgent(alphaLead.id);

		const removedByEvent: string[][] = [];
		store.add(projects.onDidRemoveAgents(removed => removedByEvent.push(removed.map(a => a.id))));

		// 1. IDE workspace folder removal event removes Alpha and its sessions from ADE
		activeFolders = [betaFolder];
		onFoldersChanged.fire({ added: [], removed: [alphaFolder], changed: [] });
		const projectsAfterAlphaRemoved = projects.projects.map(p => p.name);
		const remainingAgentsAfterAlpha = projects.agents.map(a => a.id);

		// 2. Explicit removeProject clears extra project and archived sessions, then workspace folder list updates cleanly
		const explicitRemoved = projects.removeProject(beta);
		activeFolders = [];
		onFoldersChanged.fire({ added: [], removed: [betaFolder], changed: [] });

		assert.deepStrictEqual({
			removedByEventCount: removedByEvent.length,
			firstRemovedLen: removedByEvent[0]?.length,
			projectsAfterAlphaRemoved,
			remainingAgentsAfterAlpha,
			explicitRemovedIds: explicitRemoved.map(a => a.id),
			finalProjectsCount: projects.projects.length,
			finalAgentsCount: projects.agents.length,
			selectedAfterRemove: projects.selectedAgentId,
		}, {
			removedByEventCount: 2,
			firstRemovedLen: 2,
			projectsAfterAlphaRemoved: ['Beta'],
			remainingAgentsAfterAlpha: [betaLead.id],
			explicitRemovedIds: [betaLead.id],
			finalProjectsCount: 0,
			finalAgentsCount: 0,
			selectedAfterRemove: undefined,
		});
	});

	test('persists IDE-added 0-session projects, prevents stale mirror resurrection, and syncs cross-window changes', () => {
		const alpha = URI.file('/projects/Alpha');
		const beta = URI.file('/projects/Beta');
		const gamma = URI.file('/projects/Gamma');
		const alphaFolder = toWorkspaceFolder(alpha);
		const betaFolder = toWorkspaceFolder(beta);
		const gammaFolder = toWorkspaceFolder(gamma);

		const instA = workbenchInstantiationService(undefined, store);
		const storageA = instA.get(IStorageService);
		let foldersA = [alphaFolder, betaFolder];
		const onFoldersChangedA = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		instA.stub(IWorkspaceContextService, {
			getWorkbenchState: () => WorkbenchState.WORKSPACE,
			getWorkspace: () => new Workspace('win-a', foldersA, URI.file('/Users/test/Library/Application Support/Aexus Code/Projects/win-a/projects.code-workspace')),
			onDidChangeWorkspaceFolders: onFoldersChangedA.event,
		});
		const navA = store.add(instA.createInstance(ProjectNavigationService));
		instA.stub(IProjectNavigationService, navA);
		const projectsA = store.add(instA.createInstance(AdeProjectsService));

		// Secondary live window B with its own renderer storage cache bridged via external = true IPC
		const instB = workbenchInstantiationService(undefined, store);
		const storageB = instB.get(IStorageService);
		const bridgeDisposables = store.add(new DisposableStore());
		bridgeDisposables.add(storageA.onDidChangeValue(StorageScope.PROFILE, undefined, bridgeDisposables)(e => {
			const val = storageA.get(e.key, StorageScope.PROFILE);
			storageB.storeAll([{ key: e.key, value: val, scope: StorageScope.PROFILE, target: e.target ?? StorageTarget.MACHINE }], true);
		}));
		const onFoldersChangedB = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		instB.stub(IWorkspaceContextService, {
			getWorkbenchState: () => WorkbenchState.WORKSPACE,
			getWorkspace: () => new Workspace('win-b', [alphaFolder, betaFolder, gammaFolder], URI.file('/Users/test/Library/Application Support/Aexus Code/Projects/win-b/projects.code-workspace')),
			onDidChangeWorkspaceFolders: onFoldersChangedB.event,
		});
		const navB = store.add(instB.createInstance(ProjectNavigationService));
		instB.stub(IProjectNavigationService, navB);
		const projectsB = store.add(instB.createInstance(AdeProjectsService));

		// 1. Adding a 0-session folder in IDE persists it to profile catalog & syncs to empty Dock window
		foldersA = [alphaFolder, betaFolder, gammaFolder];
		onFoldersChangedA.fire({ added: [gammaFolder], removed: [], changed: [] });

		const instEmpty = store.add(instA.createChild(new ServiceCollection()));
		instEmpty.stub(IStorageService, storageA);
		instEmpty.stub(IWorkspaceContextService, {
			getWorkbenchState: () => WorkbenchState.EMPTY,
			getWorkspace: () => new Workspace('dock-empty', []),
			onDidChangeWorkspaceFolders: Event.None,
		});
		const navEmpty = store.add(instEmpty.createInstance(ProjectNavigationService));
		instEmpty.stub(IProjectNavigationService, navEmpty);
		const projectsEmpty = store.add(instEmpty.createInstance(AdeProjectsService));
		const emptyWindowNames = projectsEmpty.projects.map(p => p.name);

		// 2. Removing Alpha in Window A immediately removes it from Window A, Window B, AND stale internal mirror restore
		projectsA.removeProject(alpha);
		const projectsAAfterRemove = projectsA.projects.map(p => p.name);
		const projectsBAfterRemove = projectsB.projects.map(p => p.name);

		const instStaleMirror = store.add(instA.createChild(new ServiceCollection()));
		instStaleMirror.stub(IStorageService, storageA);
		instStaleMirror.stub(IWorkspaceContextService, {
			getWorkbenchState: () => WorkbenchState.WORKSPACE,
			getWorkspace: () => new Workspace('stale-old', [alphaFolder, betaFolder, gammaFolder], URI.file('/Users/test/Library/Application Support/Aexus Code/Projects/stale-old/projects.code-workspace')),
			onDidChangeWorkspaceFolders: Event.None,
		});
		const navStale = store.add(instStaleMirror.createInstance(ProjectNavigationService));
		instStaleMirror.stub(IProjectNavigationService, navStale);
		const projectsStale = store.add(instStaleMirror.createInstance(AdeProjectsService));

		// 3. Reordering in Window A propagates order to Window B's navigation & projects
		projectsA.moveProjectFolder(gamma, beta, false);
		const orderB = projectsB.projects.map(p => p.name);
		const navOrderB = navB.orderedProjects.filter(p => p.name !== 'Alpha').map(p => p.name);

		assert.deepStrictEqual({
			emptyWindowNames,
			projectsAAfterRemove,
			projectsBAfterRemove,
			staleMirrorDidNotResurrect: projectsStale.projects.map(p => p.name),
			orderB,
			navOrderB,
		}, {
			emptyWindowNames: ['Alpha', 'Beta', 'Gamma'],
			projectsAAfterRemove: ['Beta', 'Gamma'],
			projectsBAfterRemove: ['Beta', 'Gamma'],
			staleMirrorDidNotResurrect: ['Beta', 'Gamma'],
			orderB: ['Gamma', 'Beta'],
			navOrderB: ['Gamma', 'Beta'],
		});
	});

	test('cascade-removes every level of a 4-level supervisor subtree, clears descendant selection, and prunes stored orphans on reload', () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const projects = store.add(instantiationService.createInstance(AdeProjectsService));
		const projectUri = URI.file('/ade/cascade');
		const governor = projects.addSession(projectUri, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/cascade-gov') }, 'Governor', { role: 'governor' });
		const manager = projects.addSession(projectUri, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/cascade-mgr') }, 'Manager', { parentId: governor.id, role: 'manager' });
		const employee = projects.addSession(projectUri, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/cascade-emp') }, 'Employee', { parentId: manager.id, role: 'employee' });
		const worker = projects.addSession(projectUri, { engineId: 'aexus-codex', resource: URI.parse('aexus-codex:/cascade-wrk') }, 'Worker', { parentId: employee.id });
		projects.selectAgent(worker.id);

		const removedEvents: string[][] = [];
		store.add(projects.onDidRemoveAgents(removed => removedEvents.push(removed.map(agent => agent.id))));

		const removed = projects.removeAgent(governor.id);

		// A stored subordinate whose parent no longer exists must not survive a reload.
		instantiationService.get(IStorageService).store('aexus.ade.agents', JSON.stringify([
			{ id: 'stored-root', projectUri: projectUri.toString(), label: 'Stored Root', draft: '' },
			{ id: 'stored-orphan', parentId: 'missing-supervisor', projectUri: projectUri.toString(), label: 'Stored Orphan', draft: '' },
		]), StorageScope.PROFILE, StorageTarget.MACHINE);
		const restored = store.add(instantiationService.createInstance(AdeProjectsService));

		assert.deepStrictEqual({
			removedIds: removed.map(agent => agent.id),
			remainingIds: projects.agents.map(agent => agent.id),
			selectedAgentId: projects.selectedAgentId,
			removedEvents,
			restoredIds: restored.agents.map(agent => agent.id),
		}, {
			removedIds: [governor.id, manager.id, employee.id, worker.id],
			remainingIds: [],
			selectedAgentId: undefined,
			removedEvents: [[governor.id, manager.id, employee.id, worker.id]],
			restoredIds: ['stored-root'],
		});
	});

	test('ignores workspace-level aexus.ade.organization overrides, syncs Work-Tree slots across 3-tier & 2-tier presets, and migrates renamed rank IDs (P0-3, P0-5)', () => {
		const instantiation = workbenchInstantiationService(undefined, store);
		const startup = ADE_ORGANIZATION_PRESETS.find(p => p.id === 'startup-3tier')!.config;
		const flat = ADE_ORGANIZATION_PRESETS.find(p => p.id === 'flat-swarm')!.config;

		// 1. P0-5: workspaceValue / workspaceFolderValue injection MUST be ignored
		let inspectedOverride: { userValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } = {
			userValue: undefined,
			workspaceValue: {
				version: 1,
				ranks: [{ id: 'evil-root', name: 'Evil', tier: 1, initPrompt: 'INJECTED', allowedApis: ['mission.control'] }],
			},
		};
		const configStub = new class extends TestConfigurationService {
			override inspect<T>(key: string) {
				if (key === ADE_ORGANIZATION_CONFIG_KEY) {
					return {
						value: (inspectedOverride.workspaceValue ?? inspectedOverride.userValue) as T,
						defaultValue: undefined,
						userValue: inspectedOverride.userValue as T,
						userLocalValue: inspectedOverride.userValue as T,
						workspaceValue: inspectedOverride.workspaceValue as T,
						workspaceFolderValue: inspectedOverride.workspaceFolderValue as T,
					};
				}
				return super.inspect<T>(key);
			}
		}();
		instantiation.stub(IConfigurationService, configStub);

		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		const projUri = URI.file('/ade/slots-project');
		const root = projects.addSession(projUri, { engineId: 'aexus-claude', resource: URI.parse('aexus-claude:/slot-root') }, 'Root', { role: 'governor' });

		// Even though workspaceValue tried to inject 'evil-root', default 4-tier applies!
		const sync4 = projects.syncMissionMermaidEmployees(root.id, [
			{ id: 'N1', title: 'Task 1', nodeIds: ['N1'] },
		]);
		assert.strictEqual(projects.getAgent(root.id)?.role, 'governor');
		assert.strictEqual(projects.getAgent(sync4.employeeAgentsByNode.N1.id)?.role, 'manager');

		// 2. Switch trusted user config to startup-3tier -> next lower tier under tech-lead resolves to reviewer
		inspectedOverride = { userValue: startup };
		projects.setAgentRole(root.id, 'tech-lead');
		const sync3 = projects.syncMissionMermaidEmployees(root.id, [
			{ id: 'N2', title: 'Task 2', nodeIds: ['N2'] },
		]);
		assert.strictEqual(projects.getAgent(root.id)?.role, 'tech-lead');
		assert.strictEqual(projects.getAgent(sync3.employeeAgentsByNode.N2.id)?.role, 'reviewer');

		// 3. Switch trusted user config to flat-swarm -> next lower tier under coordinator is pure leaf agent (undefined role)
		inspectedOverride = { userValue: flat };
		projects.setAgentRole(root.id, 'coordinator');
		const sync2 = projects.syncMissionMermaidEmployees(root.id, [
			{ id: 'N3', title: 'Task 3', nodeIds: ['N3'] },
		]);
		assert.strictEqual(projects.getAgent(root.id)?.role, 'coordinator');
		assert.strictEqual(projects.getAgent(sync2.employeeAgentsByNode.N3.id)?.role, undefined);

		// 4. Rank ID migration updates live sessions (including Mission-locked sessions) cleanly
		const migratedCount = projects.migrateRankId('coordinator', 'swarm-lead');
		assert.strictEqual(migratedCount, 1);
		assert.strictEqual(projects.getAgent(root.id)?.role, 'swarm-lead');
	});

	test('debounces per-keystroke agent & secretary draft persistence, flushes on dispose, and preserves dirty drafts across external reloads (Audit #18)', async () => {
		const instantiation = workbenchInstantiationService(undefined, store);
		const storage = instantiation.get(IStorageService);
		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		const agent = projects.addProject(URI.file('/ade/draft-debounce'));

		let agentStoreWrites = 0;
		let secretaryStoreWrites = 0;
		const origStore = storage.store.bind(storage);
		storage.store = ((key: string, value: unknown, scope: StorageScope, target: StorageTarget) => {
			if (key === 'aexus.ade.agents') {
				agentStoreWrites++;
			} else if (key === 'aexus.ade.secretary') {
				secretaryStoreWrites++;
			}
			return origStore(key, value as string, scope, target);
		}) as typeof storage.store;

		// Simulate typing 20 consecutive characters in both agent & secretary chat inputs
		let text = '';
		for (const ch of 'Hello debounced text') {
			text += ch;
			projects.setDraft(agent.id, text);
			projects.setSecretaryDraft(`sec:${text}`);
		}
		assert.strictEqual(projects.getAgent(agent.id)?.draft, 'Hello debounced text', 'In-memory draft reflects every keystroke immediately');
		assert.strictEqual(projects.secretary.draft, 'sec:Hello debounced text');
		assert.strictEqual(agentStoreWrites, 0, 'Rapid agent draft typing must NOT write full agents JSON on every keystroke');
		assert.strictEqual(secretaryStoreWrites, 0, 'Rapid secretary draft typing must NOT write secretary JSON on every keystroke');

		// Wait past 350ms trailing debounce -> coalesces into 1 write each
		await new Promise(resolve => setTimeout(resolve, 420));
		assert.strictEqual(agentStoreWrites, 1, '20 agent keystrokes coalesce into 1 debounced storage write');
		assert.strictEqual(secretaryStoreWrites, 1, '20 secretary keystrokes coalesce into 1 debounced storage write');

		// Pending draft before debounce timer fires is flushed immediately on dispose()
		projects.setDraft(agent.id, 'Unsaved before close');
		assert.strictEqual(agentStoreWrites, 1);
		projects.dispose();
		assert.strictEqual(agentStoreWrites, 2, 'Dispose flushes pending dirty drafts cleanly');

		const restored = store.add(instantiation.createInstance(AdeProjectsService));
		assert.strictEqual(restored.getAgent(agent.id)?.draft, 'Unsaved before close');
		assert.strictEqual(restored.secretary.draft, 'sec:Hello debounced text');
	});
});
