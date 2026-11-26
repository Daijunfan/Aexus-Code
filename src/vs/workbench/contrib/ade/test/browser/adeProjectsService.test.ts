/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildCloudProjectUri } from '../../../../../platform/ade/common/adeCloudHosts.js';
import { IAdeControlCenterService } from '../../../../../platform/ade/common/adeControlCenterIpc.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestAdeControlCenterService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../../files/browser/projectNavigationService.js';
import { AdeProjectsService } from '../../browser/adeProjectsService.js';
import { AdeProjectsChangeKind, buildAdeEmployeeSessionUri } from '../../common/ade.js';

suite('ADE ProjectsService (1:N Project Pages & ControlCenter backing)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('hydrates from IAdeControlCenterService via whenReady(), supports unlimited 1:N Project Pages, and retains empty Workspace Folders on page deletion', async () => {
		const controlCenter = store.add(new TestAdeControlCenterService());
		const instantiation = workbenchInstantiationService({
			contextService: () => new TestContextService(new Workspace('ade-empty', [])),
			adeControlCenterService: () => controlCenter,
		}, store);
		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		await projects.whenReady();

		const localFolder = URI.file('/ade/repo-alpha');
		const cloudFolder = buildCloudProjectUri('gpu-box', '/srv/research', 'linux');

		await projects.registerWorkspaceFolderAsync!(localFolder, 'Repo Alpha');
		await projects.registerWorkspaceFolderAsync!(cloudFolder, 'GPU Research');
		assert.deepStrictEqual(projects.projects.map(p => p.name), ['Repo Alpha', 'GPU Research']);
		assert.strictEqual(projects.getProjectPagesForFolder(localFolder).length, 0);

		// Create 5 Project Pages under the same folder (zero upper cap)
		const createdIds: string[] = [];
		for (let i = 1; i <= 5; i++) {
			const snap = await projects.createProjectPage(localFolder, `Pipeline ${i}`);
			createdIds.push(snap.meta.project_id);
		}
		assert.strictEqual(projects.getProjectPagesForFolder(localFolder).length, 5);

		// Rename & intra-folder reorder
		await projects.renameProjectPage(createdIds[0], 'Core Pipeline');
		assert.strictEqual(projects.getProjectPage(createdIds[0])?.name, 'Core Pipeline');

		await projects.reorderProjectPage(createdIds[4], createdIds[0], false);
		const reorderedNames = projects.getProjectPagesForFolder(localFolder).map(p => p.name);
		assert.deepStrictEqual(reorderedNames, ['Pipeline 5', 'Core Pipeline', 'Pipeline 2', 'Pipeline 3', 'Pipeline 4']);

		// Delete ALL 5 Project Pages -> empty Workspace Folder MUST remain stably in left sidebar!
		for (const pid of createdIds) {
			await projects.deleteProjectPage(pid);
		}
		assert.strictEqual(projects.getProjectPagesForFolder(localFolder).length, 0);
		assert.deepStrictEqual(
			projects.projects.map(p => ({ name: p.name, uri: p.uri.toString() })),
			[
				{ name: 'Repo Alpha', uri: localFolder.toString() },
				{ name: 'GPU Research', uri: cloudFolder.toString() },
			],
		);
	});

	test('deduplicates folders, persists collapse & folder order, and cascades removeProject across pages and agents', async () => {
		const alpha = URI.file('/projects/Alpha');
		const beta = URI.file('/projects/Beta');
		const gamma = URI.file('/projects/Gamma');
		const controlCenter = store.add(new TestAdeControlCenterService());
		const ctxService = new TestContextService(new Workspace('ade-folders', [toWorkspaceFolder(alpha), toWorkspaceFolder(beta)]));
		const instantiation = workbenchInstantiationService({
			contextService: () => ctxService,
			adeControlCenterService: () => controlCenter,
		}, store);
		const nav = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, nav);

		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		await projects.whenReady();

		// Duplicate registration with trailing slash must not duplicate folder
		projects.registerProject(URI.file('/projects/Alpha/'));
		projects.registerProject(gamma, 'Gamma');
		assert.deepStrictEqual(projects.projects.map(p => p.name), ['Alpha', 'Beta', 'Gamma']);

		// Collapse persistence
		await projects.setFolderCollapsed!(alpha, true);
		assert.strictEqual(projects.projects.find(p => p.name === 'Alpha')?.collapsed, true);
		await projects.setFolderCollapsed!(alpha, false);
		assert.strictEqual(projects.projects.find(p => p.name === 'Alpha')?.collapsed, false);

		// Folder order moves
		const changes: (AdeProjectsChangeKind | void)[] = [];
		store.add(projects.onDidChange(kind => changes.push(kind)));
		projects.moveProjectFolder(gamma, alpha, false);
		assert.deepStrictEqual(projects.projects.map(p => p.name), ['Gamma', 'Alpha', 'Beta']);
		assert.ok(changes.includes('order'));

		// Populate Alpha with a Project Page & L1->L2 agents, then remove folder Alpha
		const alphaPage = await projects.createProjectPage(alpha, 'Alpha Arch');
		const cc = instantiation.get(IAdeControlCenterService);
		const l1 = await cc.uiCreateAgent({
			projectId: alphaPage.meta.project_id,
			parentId: null,
			level: 1,
			name: 'Alpha L1',
			roleSummary: 'Architect',
			host: 'local',
			engine: 'claude',
			model: 'claude-sonnet-4-6',
			effort: 'medium',
		});
		const l2 = await cc.uiCreateAgent({
			projectId: alphaPage.meta.project_id,
			parentId: l1.agent_id,
			level: 2,
			name: 'Alpha L2',
			roleSummary: 'Worker',
			host: 'local',
			engine: 'codex',
			model: 'gpt-5.2-codex',
			effort: 'medium',
		});
		const snap = await cc.getProjectSnapshot(alphaPage.meta.project_id);
		if (snap) {
			projects.notifyProjectSnapshotLoaded(snap);
		}
		projects.selectAgent(l2.agent_id);
		assert.strictEqual(projects.selectedProject?.name, 'Alpha');

		const removedAgents = projects.removeProject(alpha);
		await projects.removeWorkspaceFolderAsync!(alpha);
		assert.deepStrictEqual(removedAgents.map(a => a.id), [l1.agent_id, l2.agent_id]);
		assert.deepStrictEqual(projects.projects.map(p => p.name), ['Gamma', 'Beta']);
		assert.strictEqual(projects.getProjectPage(alphaPage.meta.project_id), undefined);
		assert.strictEqual(projects.selectedAgentId, undefined);
	});

	test('tracks allBoundSessionUris() and live working -> idle unread transitions via syncSessionItem', async () => {
		const folder = URI.file('/projects/Core');
		const controlCenter = store.add(new TestAdeControlCenterService());
		const instantiation = workbenchInstantiationService({ adeControlCenterService: () => controlCenter }, store);
		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		await projects.whenReady();

		await projects.registerWorkspaceFolderAsync!(folder, 'Core');
		const page = await projects.createProjectPage(folder, 'Core Team');
		const l1 = await controlCenter.uiCreateAgent({
			projectId: page.meta.project_id,
			parentId: null,
			level: 1,
			name: 'L1 Lead',
			roleSummary: 'Lead',
			host: 'local',
			engine: 'claude',
			model: 'claude-sonnet-4-6',
			effort: 'high',
		});
		const l2 = await controlCenter.uiCreateAgent({
			projectId: page.meta.project_id,
			parentId: l1.agent_id,
			level: 2,
			name: 'L2 Worker',
			roleSummary: 'Impl',
			host: 'local',
			engine: 'codex',
			model: 'gpt-5.2-codex',
			effort: 'medium',
		});
		const snap = await controlCenter.getProjectSnapshot(page.meta.project_id);
		assert.ok(snap);
		projects.notifyProjectSnapshotLoaded(snap);

		const l1Uri = buildAdeEmployeeSessionUri('claude', page.meta.project_id, l1.agent_id);
		const l2Uri = buildAdeEmployeeSessionUri('codex', page.meta.project_id, l2.agent_id);
		const boundSet = projects.allBoundSessionUris();
		assert.strictEqual(boundSet.has(l1Uri.toString()), true);
		assert.strictEqual(boundSet.has(l2Uri.toString()), true);

		// Background working -> idle marks unread; active in editor stays read
		projects.syncSessionItem(l1Uri, { status: 'working' }, true);
		projects.syncSessionItem(l2Uri, { status: 'working' }, false);
		assert.strictEqual(projects.getAgent(l1.agent_id)?.status, 'working');
		assert.strictEqual(projects.getAgent(l2.agent_id)?.status, 'working');

		projects.syncSessionItem(l1Uri, { status: 'idle' }, true);
		projects.syncSessionItem(l2Uri, { status: 'idle' }, false);
		assert.strictEqual(Boolean(projects.getAgent(l1.agent_id)?.unread), false);
		assert.strictEqual(Boolean(projects.getAgent(l2.agent_id)?.unread), true);

		projects.markRead(l2.agent_id);
		assert.strictEqual(Boolean(projects.getAgent(l2.agent_id)?.unread), false);

		const storage = instantiation.get(IStorageService);
		projects.selectProjectPage(page.meta.project_id);
		assert.strictEqual(storage.get('aexus.ade.selectedProjectPageId', StorageScope.PROFILE), page.meta.project_id);
	});

	test('scopes selectAgent(id, projectId) & markRead(id, projectId) per Project and syncs local file:// folder to ProjectNavigationService', async () => {
		const folderA = URI.file('/projects/RepoA');
		const folderB = URI.file('/projects/RepoB');
		const controlCenter = store.add(new TestAdeControlCenterService());
		const ctxService = new TestContextService(new Workspace('ade-dual', [toWorkspaceFolder(folderA), toWorkspaceFolder(folderB)]));
		const instantiation = workbenchInstantiationService({
			contextService: () => ctxService,
			adeControlCenterService: () => controlCenter,
		}, store);
		const nav = store.add(instantiation.createInstance(ProjectNavigationService));
		nav.selectProject(folderA);
		instantiation.stub(IProjectNavigationService, nav);

		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		await projects.whenReady();

		const pageA = await projects.createProjectPage(folderA, 'Page A');
		const pageB = await projects.createProjectPage(folderB, 'Page B');

		// Inject same-named `agent_shared_l1` into BOTH Project A and Project B snapshots
		const now = Date.now();
		const makeSharedSnap = (pid: string, fId: string, fUri: URI, label: string) => ({
			meta: {
				project_id: pid,
				folder_id: fId,
				folder_uri: fUri.toString(),
				name: label,
				cross_host_ticket_storage: 'local',
				ticket_migration_epoch: 0,
				ticket_migration_state: 'idle' as const,
				layout_direction: 'TD' as const,
				created_at: now,
				updated_at: now,
			},
			hosts: [],
			agents: [{
				agent_id: 'agent_shared_l1',
				project_id: pid,
				level: 1,
				is_top_role: true,
				parent_id: null,
				name: `${label} Lead`,
				role_summary: 'Lead',
				host: 'local',
				engine: 'claude',
				model: 'claude-sonnet-4-6',
				effort: 'high',
				session_phase: 'started' as const,
				session_started: true,
				excluded_dept_ids: [],
				last_read_doc_rev: 1,
				token_gen: 1,
				created_at: now,
				updated_at: now,
			}],
			deleted_agents: [],
			departments: [],
			whiteboards: [],
			board_grants: [],
			tickets: [],
			edge_latest_transfer_at: {},
		});

		const snapA = makeSharedSnap(pageA.meta.project_id, pageA.meta.folder_id, folderA, 'Page A');
		const snapB = makeSharedSnap(pageB.meta.project_id, pageB.meta.folder_id, folderB, 'Page B');
		controlCenter.seedTestProjectSnapshot(snapA);
		controlCenter.seedTestProjectSnapshot(snapB);
		projects.notifyProjectSnapshotLoaded(snapA);
		projects.notifyProjectSnapshotLoaded(snapB);

		const uriA = buildAdeEmployeeSessionUri('claude', pageA.meta.project_id, 'agent_shared_l1');
		const uriB = buildAdeEmployeeSessionUri('claude', pageB.meta.project_id, 'agent_shared_l1');

		// Mark BOTH same-ID agents unread via background working -> idle transition
		projects.syncSessionItem(uriA, { status: 'working' }, false);
		projects.syncSessionItem(uriB, { status: 'working' }, false);
		projects.syncSessionItem(uriA, { status: 'idle' }, false);
		projects.syncSessionItem(uriB, { status: 'idle' }, false);
		assert.strictEqual(projects.getAgent('agent_shared_l1', pageA.meta.project_id)?.unread, true);
		assert.strictEqual(projects.getAgent('agent_shared_l1', pageB.meta.project_id)?.unread, true);

		// Scoped markRead on Project A MUST NOT clear unread badge on Project B's same-ID agent!
		projects.markRead('agent_shared_l1', pageA.meta.project_id);
		assert.strictEqual(projects.getAgent('agent_shared_l1', pageA.meta.project_id)?.unread, false);
		assert.strictEqual(projects.getAgent('agent_shared_l1', pageB.meta.project_id)?.unread, true, 'Cross-project same agentId unread state must remain intact');

		// Selecting agent in Project A then switching via selectAgent(id, pageB) syncs ProjectNavigationService to local file:// folderB!
		projects.selectAgent('agent_shared_l1', pageA.meta.project_id);
		assert.strictEqual(projects.selectedProjectPageId, pageA.meta.project_id);
		assert.strictEqual(nav.selectedProject?.uri.toString(), folderA.toString());

		projects.selectAgent('agent_shared_l1', pageB.meta.project_id);
		assert.strictEqual(projects.selectedProjectPageId, pageB.meta.project_id);
		assert.strictEqual(projects.selectedProject?.uri.toString(), folderB.toString());
		assert.strictEqual(nav.selectedProject?.uri.toString(), folderB.toString(), 'selectAgent must sync ProjectNavigationService on local file:// folder switch');

		// Unscoped markRead defaults strictly to _selectedProjectPageId (pageB)
		projects.markRead('agent_shared_l1');
		assert.strictEqual(projects.getAgent('agent_shared_l1', pageB.meta.project_id)?.unread, false);

		// Deleting pageA (or removing folderA) while pageB + agent_shared_l1 is active MUST NOT clear pageB's _selectedAgentId!
		assert.strictEqual(projects.selectedProjectPageId, pageB.meta.project_id);
		assert.strictEqual(projects.selectedAgentId, 'agent_shared_l1');
		await projects.deleteProjectPage(pageA.meta.project_id);
		assert.strictEqual(projects.selectedProjectPageId, pageB.meta.project_id);
		assert.strictEqual(projects.selectedAgentId, 'agent_shared_l1', 'deleteProjectPage on proj_a must preserve _selectedAgentId on active proj_b');

		// Recreate another page under folderA with same agent_shared_l1, keep pageB active, then removeProject(folderA)
		const pageA2 = await projects.createProjectPage(folderA, 'Page A2');
		const snapA2 = makeSharedSnap(pageA2.meta.project_id, pageA2.meta.folder_id, folderA, 'Page A2');
		controlCenter.seedTestProjectSnapshot(snapA2);
		projects.notifyProjectSnapshotLoaded(snapA2);

		// Switching to an empty page without agent_shared_l1 must NOT leak selectedAgentId from pageA2/pageB
		const emptyPageB2 = await projects.createProjectPage(folderB, 'Empty Page B2');
		assert.strictEqual(projects.selectedProjectPageId, emptyPageB2.meta.project_id);
		assert.strictEqual(projects.selectedAgentId, undefined, 'selectedAgentId must be strictly scoped to selectedProjectPageId without cross-project fallback');
		await projects.deleteProjectPage(emptyPageB2.meta.project_id);

		projects.selectAgent('agent_shared_l1', pageB.meta.project_id);
		projects.removeProject(folderA);
		assert.strictEqual(projects.selectedProjectPageId, pageB.meta.project_id);
		assert.strictEqual(projects.selectedAgentId, 'agent_shared_l1', 'removeProject on folderA must preserve _selectedAgentId on active proj_b');

		// Deleting the currently active pageB clears _selectedAgentId cleanly
		await projects.deleteProjectPage(pageB.meta.project_id);
		assert.strictEqual(projects.selectedProjectPageId, undefined);
		assert.strictEqual(projects.selectedAgentId, undefined);
	});

	test('syncs ProjectNavigationService.selectedProject from undefined to folderA on first selectProjectPage(pageA) in multi-folder workspace', async () => {
		const folderA = URI.file('/projects/MultiRepoA');
		const folderB = URI.file('/projects/MultiRepoB');
		const controlCenter = store.add(new TestAdeControlCenterService());
		const ctxService = new TestContextService(new Workspace('ade-multi-init', [toWorkspaceFolder(folderA), toWorkspaceFolder(folderB)]));
		const instantiation = workbenchInstantiationService({
			contextService: () => ctxService,
			adeControlCenterService: () => controlCenter,
		}, store);
		const nav = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, nav);
		const getNavSelectedUri = () => nav.selectedProject?.uri.toString();

		// With 2 local folders, ProjectNavigationService starts with selectedProject === undefined
		assert.strictEqual(getNavSelectedUri(), undefined);

		const projects = store.add(instantiation.createInstance(AdeProjectsService));
		await projects.whenReady();

		// Hydrate pageA directly via ControlCenter + refreshCatalog so selectProjectPage has not run yet
		const pageA = await controlCenter.createProject({ folderUri: folderA.toString(), name: 'Multi Page A' });
		await projects.refreshCatalog();
		assert.strictEqual(projects.selectedProject?.uri.toString(), folderA.toString());
		assert.strictEqual(getNavSelectedUri(), undefined);

		// First selectProjectPage(pageA) must sync ProjectNavigationService even though _selectedFolderUri was optimistically folderA
		projects.selectProjectPage(pageA.meta.project_id);
		assert.strictEqual(projects.selectedProjectPageId, pageA.meta.project_id);
		assert.strictEqual(getNavSelectedUri(), folderA.toString());
	});
});
