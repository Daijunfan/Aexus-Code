/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAdeCloudHost, IAdeCloudHostBackendService, resolveAdeOsIconKind } from '../../../../../platform/ade/common/adeCloudHosts.js';
import { IAdeControlCenterService } from '../../../../../platform/ade/common/adeControlCenterIpc.js';
import { IAdeCatalogSnapshot, IAdeProjectSnapshot } from '../../../../../platform/ade/common/adeModels.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IWorkspaceContextService, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IWorkbenchModeService } from '../../../../services/workbenchMode/common/workbenchMode.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { AdeCloudHostsEditorInput } from '../../../ade/browser/adeCloudHostsEditorPane.js';
import { AdeEditorService } from '../../../ade/browser/adeEditorService.js';
import { AdeProjectsService, asAdeProjectsSelectionRouting } from '../../../ade/browser/adeProjectsService.js';
import { buildAdeEmployeeSessionUri, buildAdeProjectEditorUri, IAdeEditorService, IAdeProjectsService } from '../../../ade/common/ade.js';
import { ChatEditorInput } from '../../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../../files/browser/projectNavigationService.js';
import { ProjectTerminalService } from '../../browser/projectTerminalService.js';

function createCloudHostFixture(overrides: Partial<IAdeCloudHost> & Pick<IAdeCloudHost, 'id' | 'name' | 'alias' | 'hostName'>): IAdeCloudHost {
	return {
		port: 22,
		os: 'linux',
		recentDirectories: [],
		source: 'user',
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

suite('Project terminal targets', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(customHosts: readonly IAdeCloudHost[] = []) {
		const services = workbenchInstantiationService(undefined, store);
		const workspace = new Workspace('terminals', ['Alpha', 'Beta'].map((name, index) => new WorkspaceFolder({ uri: URI.file(`/projects/${name}`), name, index })));
		services.stub(IWorkspaceContextService, { getWorkspace: () => workspace, onDidChangeWorkspaceFolders: Event.None });
		const hostsChanged = store.add(new Emitter<void>());
		if (customHosts.length > 0) {
			services.stub(IAdeCloudHostBackendService, {
				onDidChangeHosts: hostsChanged.event,
				listHosts: async () => customHosts,
				getEffectiveSshConfigPath: async () => '/tmp/aexus-effective-ssh.conf',
			} as Partial<IAdeCloudHostBackendService> as IAdeCloudHostBackendService);
		}
		const ide = store.add(services.createInstance(ProjectNavigationService));
		services.stub(IProjectNavigationService, ide);
		const ade = store.add(services.createInstance(AdeProjectsService));
		services.stub(IAdeProjectsService, ade);
		return {
			services,
			ide,
			ade,
			hostsChanged,
			modes: services.get(IWorkbenchModeService),
			terminals: store.add(services.createInstance(ProjectTerminalService)),
		};
	}

	test('synchronizes unified workspace project selection across IDE and ADE without retargeting existing launches', () => {
		const { terminals, ide, ade, modes } = setup();
		ide.selectProject(URI.file('/projects/Alpha'));
		const initial = terminals.getLaunchConfig(terminals.currentProject!);
		ade.selectProject(URI.file('/projects/Beta/src/file.ts'));
		modes.setMode('ade');
		const selectedAde = terminals.currentProject!;
		modes.setMode('ide');
		assert.deepStrictEqual({
			initial: URI.isUri(initial.cwd) ? initial.cwd.path : initial.cwd,
			ade: selectedAde.name,
			ide: terminals.currentProject?.name,
			adeProjects: terminals.projects.map(project => project.name),
			initialTitle: initial.name,
		}, {
			initial: '/projects/Alpha',
			ade: 'Beta',
			ide: 'Beta',
			adeProjects: ['Alpha', 'Beta'],
			initialTitle: 'Alpha · Local',
		});
	});

	test('persists distinct SSH host and project pairs without storing authentication', () => {
		const { terminals, services } = setup();
		terminals.addSSHProject('cloud-a', '/srv/app', 'API');
		terminals.addSSHProject('cloud-b', '/srv/app', 'Worker');
		terminals.addSSHProject('cloud-a', '/srv/app', 'Backend');
		const restored = store.add(services.createInstance(ProjectTerminalService));
		const launch = restored.getLaunchConfig(restored.sshProjects[1]);
		assert.deepStrictEqual({ targets: restored.sshProjects.map(target => ({ name: target.name, host: target.host, path: target.uri.path })), executable: launch.executable, host: launch.hostLabel, title: launch.name, localTransport: URI.isUri(launch.cwd) && launch.cwd.scheme === 'file', remotePty: launch.isRemotePty }, {
			targets: [{ name: 'Worker', host: 'cloud-b', path: '/srv/app' }, { name: 'Backend', host: 'cloud-a', path: '/srv/app' }], executable: 'ssh', host: 'cloud-a', title: 'Backend · cloud-a', localTransport: true, remotePty: true,
		});
	});

	test('honors the existing custom SSH config path', () => {
		const { terminals, services } = setup();
		const configuration = services.get(IConfigurationService) as TestConfigurationService;
		configuration.setUserConfiguration('remote.SSH.configFile', '~/.ssh/clouds');
		const target = terminals.addSSHProject('cloud', '/srv/project');
		const config = terminals.getLaunchConfig(target);
		const home = services.get(IPathService).userHome({ preferLocal: true });
		assert.deepStrictEqual({ prefix: Array.isArray(config.args) ? config.args.slice(0, 2) : config.args, host: config.hostLabel, waitOnFailure: config.waitOnExit }, {
			prefix: ['-F', URI.joinPath(home, '.ssh/clouds').fsPath], host: 'cloud', waitOnFailure: true,
		});
	});

	test('encodes Windows SSH project paths via UTF-16LE -EncodedCommand without shell expansion hazards', () => {
		const { terminals } = setup();
		const target = terminals.addSSHProject('win-host', '/C:/Users/dev/$FOO %TEMP%/app\'s');
		const config = terminals.getLaunchConfig(target);
		const args = Array.isArray(config.args) ? config.args : [];
		const remoteCmd = args.at(-1) ?? '';
		assert.ok(remoteCmd.startsWith('powershell -NoLogo -NoExit -EncodedCommand '), `Unexpected remote command: ${remoteCmd}`);
		const b64 = remoteCmd.slice('powershell -NoLogo -NoExit -EncodedCommand '.length);
		const decodedBytes = decodeBase64(b64).buffer;
		let decodedScript = '';
		for (let i = 0; i < decodedBytes.byteLength; i += 2) {
			decodedScript += String.fromCharCode(decodedBytes[i] | (decodedBytes[i + 1] << 8));
		}
		assert.strictEqual(decodedScript, `Set-Location -LiteralPath 'C:\\Users\\dev\\$FOO %TEMP%\\app''s'`);
	});

	test('normalizes raw IP and host IDs to canonical Kali alias with effective ssh_config and kali distribution tag', async () => {
		const kaliHost = createCloudHostFixture({
			id: 'host_kali_01',
			name: 'Kali RedTeam Box',
			alias: 'kali-Linux1',
			hostName: '10.20.30.40',
			port: 2222,
			user: 'kali',
			os: 'linux',
			defaultDirectory: '/home/kali/redteam',
		});
		const genericSameIp = createCloudHostFixture({
			id: 'host_generic_02',
			name: 'Fallback Jump',
			alias: '10.20.30.40',
			hostName: '10.20.30.40',
			port: 22,
			user: 'ubuntu',
			os: 'linux',
			source: 'ssh-config',
		});
		const { terminals } = setup([kaliHost, genericSameIp]);

		const fromRawIp = await terminals.resolveLaunchConfigForUri(URI.parse('aexus-ssh://10.20.30.40/home/kali/redteam'));
		const fromHostId = await terminals.resolveLaunchConfigForUri(URI.parse('aexus-ssh://host_kali_01/~'));

		assert.strictEqual(fromRawIp.hostLabel, 'kali-Linux1');
		assert.strictEqual(resolveAdeOsIconKind({ os: fromRawIp.hostOs, distribution: fromRawIp.hostDistribution }), 'kali');
		assert.deepStrictEqual(fromRawIp.args, [
			'-F',
			'/tmp/aexus-effective-ssh.conf',
			'-t',
			'--',
			'kali-Linux1',
			`cd -- '/home/kali/redteam' && exec "\${SHELL:-/bin/sh}" -l`,
		]);

		assert.strictEqual(fromHostId.hostLabel, 'kali-Linux1');
		assert.deepStrictEqual(fromHostId.args, [
			'-F',
			'/tmp/aexus-effective-ssh.conf',
			'-t',
			'--',
			'kali-Linux1',
			`cd && exec "\${SHELL:-/bin/sh}" -l`,
		]);
	});

	test('routes ADE New Terminal accurately across sidebar folders, remote employee sessions/canvases, and Cloud Host selection', async () => {
		const kaliHost = createCloudHostFixture({
			id: 'host_kali_99',
			name: 'Kali Offensive Lab',
			alias: 'kali-Linux1',
			hostName: '192.168.88.10',
			user: 'kali',
			os: 'linux',
			defaultDirectory: '/home/kali/ops',
		});
		const services = workbenchInstantiationService(undefined, store);
		const localAlphaUri = URI.file('/projects/Alpha');
		const localBetaUri = URI.file('/projects/Beta');
		const cloudKaliRepoUri = URI.parse('aexus-ssh://kali-linux1/home/kali/cloud-repo');

		const workspace = new Workspace('ade-routing', [
			new WorkspaceFolder({ uri: localAlphaUri, name: 'Alpha', index: 0 }),
			new WorkspaceFolder({ uri: localBetaUri, name: 'Beta', index: 1 }),
		]);
		services.stub(IWorkspaceContextService, { getWorkspace: () => workspace, onDidChangeWorkspaceFolders: Event.None });

		const catalog: IAdeCatalogSnapshot = {
			folders: [
				{ folder_id: 'fld_alpha', folder_uri: localAlphaUri.toString(), display_name: 'Alpha', host: 'local', sort_order: 10, collapsed: false, created_at: 1, updated_at: 1 },
				{ folder_id: 'fld_beta', folder_uri: localBetaUri.toString(), display_name: 'Beta', host: 'local', sort_order: 20, collapsed: false, created_at: 1, updated_at: 1 },
				{ folder_id: 'fld_kali', folder_uri: cloudKaliRepoUri.toString(), display_name: 'cloud-repo', host: 'kali-linux1', sort_order: 30, collapsed: false, created_at: 1, updated_at: 1 },
			],
			projects: [
				{ project_id: 'proj_alpha', folder_id: 'fld_alpha', folder_uri: localAlphaUri.toString(), name: 'Alpha Main', sort_order: 10, created_at: 1, updated_at: 1 },
			],
		};
		const alphaSnapshot: IAdeProjectSnapshot = {
			meta: {
				project_id: 'proj_alpha',
				folder_id: 'fld_alpha',
				folder_uri: localAlphaUri.toString(),
				name: 'Alpha Main',
				cross_host_ticket_storage: 'local',
				ticket_migration_epoch: 0,
				ticket_migration_state: 'idle',
				layout_direction: 'TD',
				created_at: 1,
				updated_at: 1,
			},
			hosts: [
				{ host_id: 'h_kali', name: 'Kali Offensive Lab', ip: '192.168.88.10', ssh_alias: 'kali-Linux1', os_kind: 'linux', remote_home: '/home/kali/ops' },
			],
			agents: [
				{
					agent_id: 'ag_lead',
					project_id: 'proj_alpha',
					parent_id: null,
					is_top_role: true,
					level: 1,
					name: 'Lead',
					role_summary: 'Architect',
					host: 'local',
					engine: 'claude',
					model: 'claude-sonnet-4-5',
					effort: 'medium',
					session_phase: 'started',
					session_started: true,
					session_resource: buildAdeEmployeeSessionUri('claude', 'proj_alpha', 'ag_lead').toString(),
					excluded_dept_ids: [],
					last_read_doc_rev: 1,
					token_gen: 1,
					canvas_x: 100,
					canvas_y: 100,
					created_at: 1,
					updated_at: 1,
				},
				{
					agent_id: 'ag_kali',
					project_id: 'proj_alpha',
					parent_id: 'ag_lead',
					is_top_role: false,
					level: 2,
					name: 'Kali Pentester',
					role_summary: 'Security Engineer',
					host: '192.168.88.10',
					engine: 'claude',
					model: 'claude-sonnet-4-5',
					effort: 'high',
					session_phase: 'started',
					session_started: true,
					session_resource: buildAdeEmployeeSessionUri('claude', 'proj_alpha', 'ag_kali').toString(),
					excluded_dept_ids: [],
					last_read_doc_rev: 1,
					token_gen: 1,
					canvas_x: 260,
					canvas_y: 260,
					created_at: 1,
					updated_at: 1,
				},
			],
			deleted_agents: [],
			departments: [],
			whiteboards: [],
			board_grants: [],
			tickets: [],
			edge_latest_transfer_at: {},
		};

		services.stub(IAdeControlCenterService, {
			onDidChangeCatalog: Event.None,
			onDidChangeProject: Event.None,
			registerWorkspaceFolder: async () => catalog.folders[0],
			getCatalogSnapshot: async () => catalog,
			listAllBoundSessionResources: async () => [],
			getProjectSnapshot: async (pid: string) => pid === 'proj_alpha' ? alphaSnapshot : undefined,
			issueAgentLaunchBundle: async (_pid: string, aid: string) => aid === 'ag_kali' ? {
				projectId: 'proj_alpha',
				agentId: 'ag_kali',
				name: 'Kali Pentester',
				host: '192.168.88.10',
				sshAlias: 'kali-Linux1',
				workspaceCwd: '/home/kali/ops',
				engine: 'claude',
				model: 'claude-sonnet-4-5',
				effort: 'high',
				sessionResource: buildAdeEmployeeSessionUri('claude', 'proj_alpha', 'ag_kali').toString(),
				systemPrompt: '',
			} : undefined,
		} as unknown as IAdeControlCenterService);

		services.stub(IAdeCloudHostBackendService, {
			onDidChangeHosts: Event.None,
			listHosts: async () => [kaliHost],
			getEffectiveSshConfigPath: async () => '/tmp/aexus-effective-ssh.conf',
		} as Partial<IAdeCloudHostBackendService> as IAdeCloudHostBackendService);

		let mockActiveEditor: EditorInput | undefined;
		const activeEditorChanged = store.add(new Emitter<void>());
		const mockGroup = {
			id: 1,
			get activeEditor() { return mockActiveEditor; },
			editors: [] as EditorInput[],
		};
		services.stub(IEditorGroupsService, {
			mainPart: {
				activeGroup: mockGroup,
				groups: [mockGroup],
			},
		} as unknown as IEditorGroupsService);
		services.stub(IEditorService, {
			onDidActiveEditorChange: activeEditorChanged.event,
			get activeEditor() { return mockActiveEditor; },
			activeEditorPane: undefined,
			closeEditors: async () => true,
		} as unknown as IEditorService);

		const ide = store.add(services.createInstance(ProjectNavigationService));
		services.stub(IProjectNavigationService, ide);
		const ade = store.add(services.createInstance(AdeProjectsService));
		services.stub(IAdeProjectsService, ade);
		await ade.whenReady();

		const modes = services.get(IWorkbenchModeService);
		modes.setMode('ade');

		const adeEditors = store.add(services.createInstance(AdeEditorService));
		services.stub(IAdeEditorService, adeEditors);
		const terminals = store.add(services.createInstance(ProjectTerminalService));
		await terminals.listCloudHostTargets();
		const routing = asAdeProjectsSelectionRouting(ade)!;

		// 1. Canvas active with remote employee selected -> routes to remote employee's SSH workspace
		const canvasInput = store.add(new class extends EditorInput {
			override readonly resource = buildAdeProjectEditorUri('proj_alpha');
			override get typeId() { return 'workbench.input.adeEngineering'; }
		}());
		mockActiveEditor = canvasInput;
		activeEditorChanged.fire();
		ade.selectAgent('ag_kali', 'proj_alpha');
		assert.strictEqual(terminals.currentProject?.uri.toString(), 'aexus-ssh://kali-linux1/home/kali/ops');
		assert.strictEqual(terminals.currentProject?.host, 'kali-Linux1');

		// 2. Selecting local folder Beta or SSH folder in sidebar overrides background canvas!
		ade.selectProject(localBetaUri);
		routing.setSelectionSource('sidebar');
		assert.strictEqual(ade.selectedProjectPageId, undefined, 'Cross-folder selectProject must clear stale selectedProjectPageId');
		assert.strictEqual(ade.selectedAgentId, undefined, 'Cross-folder selectProject must clear stale selectedAgentId');
		assert.strictEqual(terminals.currentProject?.uri.toString(), localBetaUri.toString());

		ade.selectProject(cloudKaliRepoUri);
		routing.setSelectionSource('sidebar');
		assert.strictEqual(ade.selectedProject?.uri.toString(), cloudKaliRepoUri.toString(), 'aexus-ssh:// folder selection updates ADE selectedProject');
		assert.strictEqual(terminals.currentProject?.uri.toString(), cloudKaliRepoUri.toString());

		// 3. Focusing remote employee ChatEditorInput -> routes to `aexus-ssh://kali-linux1/home/kali/ops` with case-preserved OpenSSH alias `kali-Linux1`
		const remoteChatInput = store.add(services.createInstance(ChatEditorInput, buildAdeEmployeeSessionUri('claude', 'proj_alpha', 'ag_kali'), {}));
		mockActiveEditor = remoteChatInput;
		activeEditorChanged.fire();
		assert.strictEqual(routing.lastSelectionSource, 'editor');
		assert.strictEqual(terminals.currentProject?.uri.toString(), 'aexus-ssh://kali-linux1/home/kali/ops');
		assert.strictEqual(terminals.currentProject?.host, 'kali-Linux1');

		// 4. Focusing Cloud Hosts Studio with selected host -> routes to `aexus-ssh://kali-linux1/home/kali/ops`
		const cloudHostsInput = store.add(new AdeCloudHostsEditorInput('kali-Linux1'));
		mockActiveEditor = cloudHostsInput;
		routing.setSelectionSource('cloudHost', URI.parse('aexus-ssh://kali-Linux1/home/kali/ops'));
		activeEditorChanged.fire();
		assert.strictEqual(terminals.currentProject?.uri.toString(), 'aexus-ssh://kali-linux1/home/kali/ops');
		assert.strictEqual(terminals.currentProject?.host, 'kali-Linux1');
	});
});
