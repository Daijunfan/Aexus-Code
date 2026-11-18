/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IWorkspaceContextService, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IWorkbenchModeService } from '../../../../services/workbenchMode/common/workbenchMode.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { AdeProjectsService } from '../../../ade/browser/adeProjectsService.js';
import { IAdeProjectsService } from '../../../ade/common/ade.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../../files/browser/projectNavigationService.js';
import { ProjectTerminalService } from '../../browser/projectTerminalService.js';

suite('Project terminal targets', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	function setup() {
		const services = workbenchInstantiationService(undefined, store);
		const workspace = new Workspace('terminals', ['Alpha', 'Beta'].map((name, index) => new WorkspaceFolder({ uri: URI.file(`/projects/${name}`), name, index })));
		services.stub(IWorkspaceContextService, { getWorkspace: () => workspace, onDidChangeWorkspaceFolders: Event.None });
		const ide = store.add(services.createInstance(ProjectNavigationService));
		services.stub(IProjectNavigationService, ide);
		const ade = store.add(services.createInstance(AdeProjectsService));
		services.stub(IAdeProjectsService, ade);
		return { services, ide, ade, modes: services.get(IWorkbenchModeService), terminals: store.add(services.createInstance(ProjectTerminalService)) };
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
});
