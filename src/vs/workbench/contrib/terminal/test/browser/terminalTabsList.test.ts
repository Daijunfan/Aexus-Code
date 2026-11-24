/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalGroup, ITerminalGroupService, ITerminalInstance } from '../../browser/terminal.js';
import { renderTerminalOsIcon, resolveTerminalOsIconKind } from '../../browser/terminalOsIcon.js';
import { TerminalTabsAccessibilityProvider } from '../../browser/terminalTabsList.js';

function createInstance(instanceId: number, title: string, hostLabel?: string, extra?: Partial<IShellLaunchConfig>): ITerminalInstance {
	return new class extends mock<ITerminalInstance>() {
		override readonly instanceId = instanceId;
		override readonly title = title;
		override readonly shellLaunchConfig: IShellLaunchConfig = { hostLabel, ...extra };
	};
}

suite('TerminalTabsAccessibilityProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('labels name the remote host a terminal runs on', () => {
		const local = createInstance(1, 'zsh');
		const remote = createInstance(2, 'bash', 'devbox');
		const split = [createInstance(3, 'node', 'devbox'), createInstance(4, 'zsh')];
		const provider = new TerminalTabsAccessibilityProvider(new class extends mock<ITerminalGroupService>() {
			override getGroupForInstance(instance: ITerminalInstance): ITerminalGroup {
				const terminalInstances = split.includes(instance) ? split : [instance];
				return new class extends mock<ITerminalGroup>() {
					override readonly terminalInstances = terminalInstances;
				};
			}
		});

		assert.deepStrictEqual([local, remote, ...split].map(instance => provider.getAriaLabel(instance)), [
			'Terminal 1 zsh',
			'Terminal 2 bash on devbox',
			'Terminal 3 node on devbox, split 1 of 2',
			'Terminal 4 zsh, split 2 of 2',
		]);
	});

	test('resolves and renders Aexus-Bot OS SVG icons for cloud and local terminals', () => {
		const ubuntu = createInstance(10, 'lab · ubuntu-target1', 'ubuntu-target1', { hostOs: 'linux', hostDistribution: 'Linux (ubuntu) ubuntu-target1', isRemotePty: true });
		const kali = createInstance(11, 'kali · kali-Linux1', 'kali-Linux1', { hostOs: 'linux', hostDistribution: 'kali-Linux1', isRemotePty: true });
		const win = createInstance(12, 'djf · BUPT-Windows', 'BUPT-Windows', { hostOs: 'windows', isRemotePty: true });
		const mac = createInstance(13, 'mac-mini', 'mac-mini', { hostOs: 'macos', isRemotePty: true });
		const debian = createInstance(14, 'deb · deb-node', 'deb-node', { hostOs: 'linux', hostDistribution: 'Linux (debian)', isRemotePty: true });
		const rhel = createInstance(15, 'ops · rocky-box', 'rocky-box', { hostOs: 'linux', hostDistribution: 'Linux (rocky)', isRemotePty: true });
		const generic = createInstance(16, 'dev · bupt208', 'bupt208', { hostOs: 'linux', isRemotePty: true });

		const kinds = [ubuntu, kali, win, mac, debian, rhel, generic].map(resolveTerminalOsIconKind);
		const container = mainWindow.document.createElement('span');
		const rendered = kinds.map(kind => {
			renderTerminalOsIcon(container, kind);
			const svg = container.querySelector('svg');
			return {
				os: container.dataset.os,
				hasClass: container.classList.contains(`terminal-os-${kind}`),
				hasSvg: Boolean(svg && svg.children.length > 0),
			};
		});

		assert.deepStrictEqual({ kinds, rendered }, {
			kinds: ['ubuntu', 'kali', 'windows', 'macos', 'ubuntu', 'ubuntu', 'ubuntu'],
			rendered: [
				{ os: 'ubuntu', hasClass: true, hasSvg: true },
				{ os: 'kali', hasClass: true, hasSvg: true },
				{ os: 'windows', hasClass: true, hasSvg: true },
				{ os: 'macos', hasClass: true, hasSvg: true },
				{ os: 'ubuntu', hasClass: true, hasSvg: true },
				{ os: 'ubuntu', hasClass: true, hasSvg: true },
				{ os: 'ubuntu', hasClass: true, hasSvg: true },
			],
		});
	});
});
