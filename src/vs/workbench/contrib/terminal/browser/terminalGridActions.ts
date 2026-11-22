/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { hasKey } from '../../../../base/common/types.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { TerminalSplitDirection } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { TerminalCommandId } from '../common/terminal.js';
import { TerminalContextKeys } from '../common/terminalContextKey.js';
import { Direction, ICreateTerminalOptions, ITerminalConfigurationService, ITerminalGroupService, ITerminalInstance, ITerminalService } from './terminal.js';
import { getCwdForSplit } from './terminalActions.js';
import { TerminalGridConfiguratorPopover } from './terminalGridConfigurator.js';
import { IApplyTerminalGridOptions, ITerminalGridLayoutService, ITerminalGridTargetOption } from './terminalGridLayoutService.js';

let activeConfigurator: TerminalGridConfiguratorPopover | undefined;

async function splitInDirection(accessor: ServicesAccessor, direction: TerminalSplitDirection, args?: unknown): Promise<void> {
	const terminalService = accessor.get(ITerminalService);
	const groupService = accessor.get(ITerminalGroupService);
	const configService = accessor.get(ITerminalConfigurationService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const commandService = accessor.get(ICommandService);

	const opts = (args && typeof args === 'object' ? args as ICreateTerminalOptions : undefined);
	let parent: ITerminalInstance | undefined;
	if (opts?.location && typeof opts.location === 'object' && hasKey(opts.location, { parentTerminal: true })) {
		parent = await opts.location.parentTerminal;
	}
	parent ??= groupService.activeInstance ?? terminalService.activeInstance;
	if (!parent) {
		const created = await terminalService.createTerminal();
		terminalService.setActiveInstance(created);
		await groupService.showPanel(true);
		return;
	}
	const cwd = opts?.cwd ?? await getCwdForSplit(parent, workspaceContextService.getWorkspace().folders, commandService, configService);
	const instance = await terminalService.createTerminal({
		location: { parentTerminal: parent, splitDirection: direction },
		config: opts?.config,
		cwd,
	});
	terminalService.setActiveInstance(instance);
	await groupService.showPanel(true);
	await instance.focusWhenReady(true);
}

export function registerTerminalGridActions(): void {
	const terminalCategory = localize2('terminalCategory', "Terminal");
	const processPrecondition = ContextKeyExpr.or(TerminalContextKeys.processSupported, TerminalContextKeys.webExtensionContributedProfile);

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.SplitRight,
				title: localize2('workbench.action.terminal.splitRight', "Split Terminal Right"),
				category: terminalCategory,
				icon: Codicon.splitHorizontal,
				f1: true,
				precondition: processPrecondition,
			});
		}
		override run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
			return splitInDirection(accessor, 'right', args);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.SplitDown,
				title: localize2('workbench.action.terminal.splitDown', "Split Terminal Down"),
				category: terminalCategory,
				icon: Codicon.splitVertical,
				f1: true,
				precondition: processPrecondition,
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Backslash,
					weight: KeybindingWeight.WorkbenchContrib,
					when: TerminalContextKeys.focus,
				},
			});
		}
		override run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
			return splitInDirection(accessor, 'down', args);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.ConfigureGridLayout,
				title: localize2('workbench.action.terminal.configureGridLayout', "Configure Multi-Row / Column Terminal Grid..."),
				shortTitle: localize('workbench.action.terminal.configureGridLayout.short', "Terminal Grid Layout"),
				category: terminalCategory,
				icon: Codicon.layout,
				f1: true,
				precondition: processPrecondition,
			});
		}
		override async run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
			// Support direct programmatic grid invocation: executeCommand(ConfigureGridLayout, { rows, cols, cells, openInNewGroup })
			if (args && typeof args === 'object' && hasKey(args as Record<string, unknown>, { rows: true, cols: true })) {
				const gridService = accessor.get(ITerminalGridLayoutService);
				await gridService.applyGridLayout(args as IApplyTerminalGridOptions);
				return;
			}
			const anchor = dom.isHTMLElement(args)
				? args
				: (args && typeof args === 'object' && hasKey(args as Record<string, unknown>, { anchor: true }) && dom.isHTMLElement((args as { anchor?: unknown }).anchor)
					? (args as { anchor: HTMLElement }).anchor
					: undefined);
			if (activeConfigurator) {
				activeConfigurator.close();
				activeConfigurator = undefined;
				return;
			}
			const instantiationService = accessor.get(IInstantiationService);
			activeConfigurator = instantiationService.createInstance(
				TerminalGridConfiguratorPopover,
				anchor,
				() => { activeConfigurator = undefined; },
			);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.OpenCloudHostGrid,
				title: localize2('workbench.action.terminal.openCloudHostGrid', "Open All Cloud Hosts in Terminal Grid"),
				category: terminalCategory,
				icon: Codicon.remoteExplorer,
				f1: true,
				precondition: processPrecondition,
			});
		}
		override async run(accessor: ServicesAccessor, options?: { includeLocal?: boolean; openInNewGroup?: boolean; broadcastInput?: boolean }): Promise<void> {
			const gridService = accessor.get(ITerminalGridLayoutService);
			await gridService.applyAllCloudHostsGrid(options);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.EqualizeGrid,
				title: localize2('workbench.action.terminal.equalizeGrid', "Equalize Terminal Grid Sizes"),
				category: terminalCategory,
				icon: Codicon.layoutPanelCenter,
				f1: true,
				precondition: TerminalContextKeys.splitTerminalActive,
			});
		}
		override run(accessor: ServicesAccessor): void {
			accessor.get(ITerminalGroupService).activeGroup?.equalizeGrid?.();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.ToggleGridBroadcast,
				title: localize2('workbench.action.terminal.toggleGridBroadcast', "Toggle Broadcast Input to Terminal Grid"),
				shortTitle: localize('workbench.action.terminal.toggleGridBroadcast.short', "Sync Input to Grid"),
				category: terminalCategory,
				icon: Codicon.broadcast,
				toggled: TerminalContextKeys.gridBroadcastActive,
				f1: true,
				precondition: TerminalContextKeys.splitTerminalActive,
			});
		}
		override run(accessor: ServicesAccessor): void {
			const group = accessor.get(ITerminalGroupService).activeGroup;
			if (!group || group.terminalInstances.length <= 1) {
				accessor.get(INotificationService).info(localize('terminalGridBroadcastNeedSplit', "Split the terminal into 2 or more panes to broadcast input across panes."));
				return;
			}
			group.broadcastInput = !group.broadcastInput;
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.BroadcastCommandToGrid,
				title: localize2('workbench.action.terminal.broadcastCommandToGrid', "Send Command to All Terminals in Grid..."),
				category: terminalCategory,
				icon: Codicon.broadcast,
				f1: true,
				precondition: TerminalContextKeys.splitTerminalActive,
			});
		}
		override async run(accessor: ServicesAccessor, rawCommand?: string): Promise<void> {
			const group = accessor.get(ITerminalGroupService).activeGroup;
			if (!group || group.terminalInstances.length === 0) {
				return;
			}
			const cmd = typeof rawCommand === 'string'
				? rawCommand
				: await accessor.get(IQuickInputService).input({
					title: localize('terminalGridBroadcastCmdTitle', "Broadcast Command to {0} Grid Terminals", group.terminalInstances.length),
					prompt: localize('terminalGridBroadcastCmdPrompt', "Enter a shell command to execute simultaneously in every pane of this grid"),
					placeHolder: 'e.g. git status, nvidia-smi, uptime',
				});
			if (cmd === undefined || !cmd.length) {
				return;
			}
			await group.broadcastText?.(cmd, true);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.ToggleMaximizePane,
				title: localize2('workbench.action.terminal.toggleMaximizePane', "Toggle Maximize Active Terminal Pane"),
				category: terminalCategory,
				icon: Codicon.screenFull,
				f1: true,
				precondition: TerminalContextKeys.splitTerminalActive,
			});
		}
		override run(accessor: ServicesAccessor, targetInstance?: ITerminalInstance): void {
			const groupService = accessor.get(ITerminalGroupService);
			const target = targetInstance ?? groupService.activeInstance;
			const group = target ? groupService.getGroupForInstance(target) : groupService.activeGroup;
			group?.toggleMaximizePane?.(target);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.SwitchPaneHost,
				title: localize2('workbench.action.terminal.switchPaneHost', "Switch Terminal Pane Host / Project..."),
				category: terminalCategory,
				icon: Codicon.serverEnvironment,
				f1: true,
				precondition: processPrecondition,
			});
		}
		override async run(accessor: ServicesAccessor, targetInstance?: ITerminalInstance): Promise<void> {
			const groupService = accessor.get(ITerminalGroupService);
			const gridService = accessor.get(ITerminalGridLayoutService);
			const quickInput = accessor.get(IQuickInputService);
			const commandService = accessor.get(ICommandService);

			const instance = targetInstance ?? groupService.activeInstance;
			if (!instance) {
				return;
			}
			const group = groupService.getGroupForInstance(instance);
			if (!group) {
				return;
			}

			const targets = await gridService.getAvailableTargets();
			interface IHostPickItem extends IQuickPickItem {
				readonly target?: ITerminalGridTargetOption;
				readonly manageHosts?: boolean;
			}
			const picks: Array<IHostPickItem | IQuickPickSeparator> = [];
			const addGroup = (heading: string, category: ITerminalGridTargetOption['category']) => {
				const items = targets.filter(t => t.category === category);
				if (items.length === 0) {
					return;
				}
				picks.push({ type: 'separator', label: heading });
				for (const t of items) {
					picks.push({
						label: t.label,
						description: t.host,
						detail: t.detail,
						target: t,
					} satisfies IHostPickItem);
				}
			};
			addGroup(localize('terminalGridPickCloud', "Cloud Hosts (SSH)"), 'cloud');
			addGroup(localize('terminalGridPickProjects', "Local & Workspace Projects"), 'project');
			addGroup(localize('terminalGridPickSsh', "Saved SSH Projects"), 'ssh');
			addGroup(localize('terminalGridPickDefault', "Default"), 'active');
			picks.push({ type: 'separator' });
			picks.push({
				label: `$(settings-gear) ${localize('terminalGridPickManageCloud', "Manage Cloud Hosts...")}`,
				description: localize('terminalGridPickManageCloudDesc', "Add or edit SSH Cloud Hosts"),
				manageHosts: true,
			} satisfies IHostPickItem);

			const picked = await quickInput.pick(picks, {
				title: localize('terminalGridSwitchHostTitle', "Switch Host / Project for Terminal Pane"),
				placeHolder: localize('terminalGridSwitchHostPlaceholder', "Select a Cloud Host or Local Project to run in this pane"),
				matchOnDescription: true,
				matchOnDetail: true,
			});
			if (!picked) {
				return;
			}
			if (picked.manageHosts) {
				await commandService.executeCommand('workbench.action.aexusCloudHosts.manage');
				return;
			}
			if (picked.target) {
				await gridService.switchCellTarget(group, instance, picked.target);
			}
		}
	});

	const focusDirs: ReadonlyArray<{ readonly id: TerminalCommandId; readonly title: ReturnType<typeof localize2>; readonly dir: Direction }> = [
		{ id: TerminalCommandId.FocusPaneUp, title: localize2('workbench.action.terminal.focusPaneUp', "Focus Terminal Pane Above"), dir: Direction.Up },
		{ id: TerminalCommandId.FocusPaneDown, title: localize2('workbench.action.terminal.focusPaneDown', "Focus Terminal Pane Below"), dir: Direction.Down },
		{ id: TerminalCommandId.FocusPaneLeft, title: localize2('workbench.action.terminal.focusPaneLeft', "Focus Terminal Pane Left"), dir: Direction.Left },
		{ id: TerminalCommandId.FocusPaneRight, title: localize2('workbench.action.terminal.focusPaneRight', "Focus Terminal Pane Right"), dir: Direction.Right },
	];
	for (const entry of focusDirs) {
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id: entry.id,
					title: entry.title,
					category: terminalCategory,
					f1: true,
					precondition: TerminalContextKeys.splitTerminalActive,
				});
			}
			override run(accessor: ServicesAccessor): void {
				accessor.get(ITerminalGroupService).activeGroup?.focusPaneInDirection?.(entry.dir);
			}
		});
	}
}
