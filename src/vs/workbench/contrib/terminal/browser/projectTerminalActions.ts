/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IProjectTerminalService, IProjectTerminalTarget } from './projectTerminalService.js';
import { ITerminalGroupService, ITerminalService } from './terminal.js';

function createLauncher(accessor: ServicesAccessor): (target: IProjectTerminalTarget) => Promise<void> {
	const projects = accessor.get(IProjectTerminalService);
	const terminals = accessor.get(ITerminalService);
	const groups = accessor.get(ITerminalGroupService);
	return async target => {
		const config = await projects.resolveLaunchConfigForUri(target.uri, target.name);
		const instance = await terminals.createTerminal({ config, cwd: config.cwd, location: TerminalLocation.Panel, skipContributedProfileCheck: true });
		terminals.setActiveInstance(instance);
		await groups.showPanel(true);
	};
}

export function registerProjectTerminalActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: 'workbench.action.terminal.newProjectTerminal', title: localize2('newProjectTerminal', "New Project Terminal..."), category: localize2('terminal', "Terminal"), f1: true, menu: { id: MenuId.TerminalNewDropdownContext, group: '2_project', order: 0 } });
		}
		async run(accessor: ServicesAccessor, uri?: URI): Promise<void> {
			const service = accessor.get(IProjectTerminalService);
			const launch = createLauncher(accessor);
			const targets = [...service.projects, ...service.sshProjects];
			const target = URI.isUri(uri) ? targets.find(target => target.uri.toString() === uri.toString()) : (await accessor.get(IQuickInputService).pick(targets.map(target => ({ label: target.name, description: target.host, detail: target.uri.path, target })), { placeHolder: localize('chooseProjectTerminal', "Select the project and host for this terminal"), matchOnDescription: true }))?.target;
			if (target) {
				await launch(target);
			}
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: 'workbench.action.terminal.newSSHProjectTerminal', title: localize2('newSSHProjectTerminal', "New SSH Project Terminal..."), category: localize2('terminal', "Terminal"), f1: true, menu: { id: MenuId.TerminalNewDropdownContext, group: '2_project', order: 1 } });
		}
		async run(accessor: ServicesAccessor, target?: { host: string; path: string; name?: string }): Promise<void> {
			const input = accessor.get(IQuickInputService);
			const service = accessor.get(IProjectTerminalService);
			const launch = createLauncher(accessor);
			if (!target) {
				const host = await input.input({ prompt: localize('sshProjectHost', "SSH Host Alias or user@hostname"), validateInput: async value => value.trim() && !/\s/.test(value.trim()) && !value.trim().startsWith('-') ? undefined : localize('sshHostRequired', "Enter an SSH host alias or user@hostname.") });
				if (!host) { return; }
				const path = await input.input({ prompt: localize('sshProjectPath', "Absolute Project Folder on the SSH Host"), placeHolder: '/home/user/project', validateInput: async value => value.startsWith('/') ? undefined : localize('sshPathRequired', "Enter an absolute project folder path.") });
				if (!path) { return; }
				const name = await input.input({ prompt: localize('sshProjectName', "Project Name"), value: path.split('/').filter(Boolean).at(-1) || host });
				if (name === undefined) { return; }
				target = { host: host.trim(), path, name: name.trim() || undefined };
			}
			await launch(service.addSSHProject(target.host, target.path, target.name));
		}
	});
}
