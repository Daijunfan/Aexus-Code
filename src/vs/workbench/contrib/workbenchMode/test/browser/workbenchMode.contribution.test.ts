/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { IMenuService, isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IPaneComposite } from '../../../../common/panecomposite.js';
import { Extensions, ICustomViewDescriptor, IViewContainerModel, IViewContainersRegistry, IViewDescriptor, IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../../common/views.js';
import { IExtensionService, nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IWorkbenchModeService, WorkbenchMode } from '../../../../services/workbenchMode/common/workbenchMode.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { AdeProjectsService } from '../../../ade/browser/adeProjectsService.js';
import { ADE_INSPECTOR_CONTAINER_ID, IAdeProjectsService } from '../../../ade/common/ade.js';
import { ExtensionState, IExtension, IExtensionsWorkbenchService } from '../../../extensions/common/extensions.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../../files/browser/projectNavigationService.js';
import { PluginSidebarProjectContribution, WorkbenchModeLayoutContribution } from '../../browser/workbenchMode.contribution.js';

interface PluginPick extends IQuickPickItem {
	extension: IExtension;
	container: ViewContainer | undefined;
}

suite('Installed plugin picker', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function extension(id: string, isBuiltin = false, state = ExtensionState.Installed): IExtension {
		return new class extends mock<IExtension>() {
			override readonly identifier = { id };
			override readonly displayName = id;
			override readonly name = id;
			override readonly isBuiltin = isBuiltin;
			override readonly state = state;
		}();
	}

	function container(id: string, owner?: string): ViewContainer {
		return new class extends mock<ViewContainer>() {
			override readonly id = id;
			override readonly extensionId = owner ? new ExtensionIdentifier(owner) : undefined;
		}();
	}

	function setup(installed: IExtension[], selected?: string, mode: WorkbenchMode = 'ide') {
		const instantiation = workbenchInstantiationService(undefined, store);
		const models = new Map<ViewContainer, IViewContainerModel>();
		const locations = new Map<ViewContainer, ViewContainerLocation>();
		const opened: string[] = [];
		const moved: string[] = [];
		const bound: string[] = [];
		let picks: PluginPick[] = [];
		instantiation.stub(IExtensionService, { extensions: [], whenInstalledExtensionsRegistered: async () => true });
		instantiation.stub(IExtensionsWorkbenchService, { queryLocal: async () => installed, open: async (ext: IExtension) => { opened.push(`details:${ext.identifier.id}`); } });
		instantiation.stub(IQuickInputService, 'pick', async (items: PluginPick[]) => { picks = items; return items.find(item => item.extension.identifier.id === selected); });
		instantiation.stub(IWorkbenchModeService, { mode });
		instantiation.stub(IAdeProjectsService, { selectedProject: undefined });
		instantiation.stub(IProjectNavigationService, { bindCodingAgentProject: (id: string) => { bound.push(id); } });
		instantiation.stub(ICommandService, {
			onWillExecuteCommand: Event.None,
			onDidExecuteCommand: Event.None,
			executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
				const registered = CommandsRegistry.getCommand(id);
				if (registered) {
					return instantiation.invokeFunction(registered.handler, ...args) as T;
				}
				return undefined as T;
			},
		});
		instantiation.stub(IViewDescriptorService, {
			get viewContainers() { return [...models.keys()]; },
			getViewContainerModel: (c: ViewContainer) => models.get(c)!,
			getViewContainerLocation: (c: ViewContainer) => locations.get(c) ?? null,
			moveViewContainerToLocation: (c: ViewContainer, location: ViewContainerLocation) => { locations.set(c, location); moved.push(c.id); },
			moveViewToLocation: (view: IViewDescriptor, location: ViewContainerLocation) => { assert.strictEqual(location, ViewContainerLocation.AuxiliaryBar); moved.push(view.id); },
		});
		instantiation.stub(IViewsService, {
			openViewContainer: async (id: string) => { opened.push(id); return null; },
			openView: async (id: string) => { opened.push(id); return null; },
		});
		return {
			opened, moved, bound, locations,
			get picks() { return picks; },
			addContainer: (c: ViewContainer, views: IViewDescriptor[] = [], active = true, location = ViewContainerLocation.AuxiliaryBar) => {
				models.set(c, new class extends mock<IViewContainerModel>() {
					override readonly allViewDescriptors = views;
					override readonly activeViewDescriptors = active ? views : [];
				}());
				locations.set(c, location);
			},
			run: () => instantiation.invokeFunction(CommandsRegistry.getCommand('workbench.action.aexus.showPlugins')!.handler),
		};
	}

	test('lists installed user extensions once, including plugins without panels', async () => {
		const subject = setup([extension('test.formatter'), extension('TEST.FORMATTER'), extension('test.system', true), extension('test.removed', false, ExtensionState.Uninstalled)]);
		subject.addContainer(container('workbench.view.extensions'));
		subject.addContainer(container('workbench.view.search'));
		await subject.run();
		assert.deepStrictEqual({ plugins: subject.picks.map(pick => pick.extension.identifier.id), opened: subject.opened }, { plugins: ['test.formatter'], opened: [] });
	});

	test('opens the installed plugin details when it has no sidebar view', async () => {
		const subject = setup([extension('test.formatter')], 'test.formatter');
		await subject.run();
		assert.deepStrictEqual(subject.opened, ['details:test.formatter']);
	});

	test('selects the active secondary panel without duplicate entries, including in ADE', async () => {
		const subject = setup([extension('test.agent')], 'test.agent', 'ade');
		const inactive = container('agent.primary', 'test.agent');
		const active = container('agent.secondary', 'test.agent');
		const view = new class extends mock<ICustomViewDescriptor>() { override readonly id = 'agent.view'; override readonly extensionId = new ExtensionIdentifier('test.agent'); }();
		subject.addContainer(inactive, [view], false);
		subject.addContainer(active, [view], true, ViewContainerLocation.Panel);
		await subject.run();
		assert.deepStrictEqual({ count: subject.picks.length, opened: subject.opened, location: subject.locations.get(active) }, { count: 1, opened: ['agent.secondary'], location: ViewContainerLocation.AuxiliaryBar });
	});

	test('opens an extension view hosted inside a built-in container in the right sidebar', async () => {
		const subject = setup([extension('test.agent')], 'test.agent');
		const view = new class extends mock<ICustomViewDescriptor>() { override readonly id = 'agent.view'; override readonly extensionId = new ExtensionIdentifier('test.agent'); }();
		subject.addContainer(container('workbench.view.explorer'), [view], true, ViewContainerLocation.Sidebar);
		await subject.run();
		assert.deepStrictEqual({ moved: subject.moved, opened: subject.opened }, { moved: ['agent.view'], opened: ['agent.view'] });
	});

	test('prefers the native secondary sidebar over a separate active sessions list', async () => {
		const subject = setup([extension('test.agent')], 'test.agent');
		const registry = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);
		const sessions = registry.registerViewContainer(container('test.agent.sessions', 'test.agent'), ViewContainerLocation.Sidebar);
		const secondary = registry.registerViewContainer(container('test.agent.secondary', 'test.agent'), ViewContainerLocation.AuxiliaryBar);
		store.add({ dispose: () => { registry.deregisterViewContainer(sessions); registry.deregisterViewContainer(secondary); } });
		const view = new class extends mock<ICustomViewDescriptor>() { override readonly id = 'agent.view'; override readonly extensionId = new ExtensionIdentifier('test.agent'); }();
		subject.addContainer(sessions, [view]);
		subject.addContainer(secondary, [view]);
		await subject.run();
		assert.deepStrictEqual({ count: subject.picks.length, opened: subject.opened }, { count: 1, opened: ['test.agent.secondary'] });
	});

	test('pins Coding Agents at the top of Plugins menu and launches panel-less Coding Agents via command', async () => {
		let launchedOpenCode = false;
		store.add(CommandsRegistry.registerCommand('opencode.openNewTerminal', () => {
			launchedOpenCode = true;
		}));
		const subject = setup([
			extension('zlib.linter'),
			extension('openai.chatgpt'),
			extension('alpha.formatter'),
			extension('sst-dev.opencode'),
			extension('anthropic.claude-code'),
		], 'sst-dev.opencode');
		subject.addContainer(container('claude-sidebar', 'anthropic.claude-code'));
		subject.addContainer(container('codexViewContainer', 'openai.chatgpt'));
		await subject.run();
		assert.deepStrictEqual({
			order: subject.picks.map(pick => pick.extension.identifier.id),
			bound: subject.bound,
			opened: subject.opened,
			launchedOpenCode,
		}, {
			order: [
				'anthropic.claude-code',
				'openai.chatgpt',
				'sst-dev.opencode',
				'alpha.formatter',
				'zlib.linter',
			],
			bound: ['sst-dev.opencode'],
			opened: [],
			launchedOpenCode: true,
		});
	});
});

suite('Plugin sidebar project context', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const alpha = URI.file('/projects/Alpha');
	const beta = URI.file('/projects/Beta');
	const command = 'workbench.action.aexus.selectPluginProject';

	function setup() {
		const instantiation = workbenchInstantiationService(undefined, store);
		instantiation.stub(IWorkspaceContextService, { getWorkspace: () => new Workspace('home', [toWorkspaceFolder(alpha), toWorkspaceFolder(beta)]), onDidChangeWorkspaceFolders: Event.None });
		const projects = store.add(instantiation.createInstance(ProjectNavigationService));
		instantiation.stub(IProjectNavigationService, projects);
		const ade = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, ade);
		let mode: WorkbenchMode = 'ide';
		let owner: string | undefined;
		const modeChanges = store.add(new Emitter<WorkbenchMode>());
		const paneChanges = store.add(new Emitter());
		instantiation.stub(IWorkbenchModeService, { get mode() { return mode; }, onDidChangeMode: modeChanges.event });
		instantiation.stub(IPaneCompositePartService, {});
		instantiation.stub(IPaneCompositePartService, 'getActivePaneComposite', () => owner ? { getId: () => 'test.active' } : undefined);
		instantiation.stub(IPaneCompositePartService, 'onDidPaneCompositeOpen', paneChanges.event);
		instantiation.stub(IPaneCompositePartService, 'onDidPaneCompositeClose', Event.None);
		instantiation.stub(IViewDescriptorService, {});
		instantiation.stub(IViewDescriptorService, 'getViewContainerById', () => new class extends mock<ViewContainer>() { override readonly extensionId = owner ? new ExtensionIdentifier(owner) : undefined; }());
		instantiation.stub(IExtensionService, { extensions: ['openai.chatgpt', 'anthropic.claude-code'].map(id => ({ ...nullExtensionDescription, identifier: new ExtensionIdentifier(id) })) });
		store.add(instantiation.createInstance(PluginSidebarProjectContribution));
		return {
			projects, ade, instantiation,
			showPlugin: (id: string) => { owner = id; paneChanges.fire(undefined); },
			setMode: (value: WorkbenchMode) => { mode = value; modeChanges.fire(value); },
			label: () => {
				const item = MenuRegistry.getMenuItems(MenuId.AuxiliaryBarTitle).filter(isIMenuItem).find(entry => entry.command.id === command)!;
				return typeof item.command.title === 'string' ? item.command.title : item.command.title.value;
			},
			selectProject: async (resource?: URI) => {
				instantiation.stub(IQuickInputService, 'pick', async (items: { uri: URI }[]) => items.find(item => item.uri.toString() === resource?.toString()));
				await instantiation.invokeFunction(CommandsRegistry.getCommand(command)!.handler);
			},
		};
	}

	test('shows each active plugin binding and follows the selected project for other plugins', () => {
		const subject = setup();
		subject.projects.selectProject(alpha);
		subject.projects.bindCodingAgentProject('openai.chatgpt');
		subject.projects.selectProject(beta);
		subject.projects.bindCodingAgentProject('anthropic.claude-code');
		const labels: string[] = [];
		subject.showPlugin('openai.chatgpt'); labels.push(subject.label());
		subject.showPlugin('anthropic.claude-code'); labels.push(subject.label());
		subject.showPlugin('test.formatter'); labels.push(subject.label());
		subject.projects.selectProject(alpha); labels.push(subject.label());
		assert.deepStrictEqual(labels, ['Alpha', 'Beta', 'Beta', 'Alpha']);
	});

	test('selecting a project retargets only the active coding plugin', async () => {
		const subject = setup();
		subject.projects.enterProject(alpha);
		subject.projects.bindCodingAgentProject('openai.chatgpt');
		subject.projects.bindCodingAgentProject('anthropic.claude-code');
		subject.showPlugin('anthropic.claude-code');
		await subject.selectProject(beta);
		assert.deepStrictEqual({
			label: subject.label(),
			focused: subject.projects.focusedProject?.name,
			bindings: [...subject.projects.codingAgentProjects].map(([id, uri]) => [id, uri.toString()]),
		}, {
			label: 'Beta',
			focused: 'Beta',
			bindings: [['openai.chatgpt', alpha.toString()], ['anthropic.claude-code', beta.toString()]],
		});
	});

	test('canceling a project choice preserves the current context', async () => {
		const subject = setup();
		subject.projects.selectProject(alpha);
		await subject.selectProject();
		assert.deepStrictEqual({ label: subject.label(), bindings: subject.projects.codingAgentProjects.size }, { label: 'Alpha', bindings: 0 });
	});

	test('tracks ADE selection and child sessions without reusing the IDE project label', async () => {
		const subject = setup();
		subject.projects.selectProject(alpha);
		const first = subject.ade.addProject(URI.file('/ade/First'));
		const second = subject.ade.addProject(URI.file('/ade/Second'));
		const child = subject.ade.addAgent(first.id, 'Review');
		subject.setMode('ade');
		subject.ade.selectAgent(child.id);
		const childLabel = subject.label();
		await subject.selectProject(second.projectUri);
		const secondLabel = subject.label();
		subject.setMode('ide');
		assert.deepStrictEqual({ childLabel, secondLabel, ideLabel: subject.label() }, { childLabel: 'First', secondLabel: 'Second', ideLabel: 'Alpha' });
	});

	test('renders a shared plugin button and updates the visible project in the right header', async () => {
		const subject = setup();
		subject.projects.selectProject(alpha);
		subject.instantiation.stub(IContextKeyService, store.add(subject.instantiation.createInstance(ContextKeyService)));
		subject.instantiation.stub(IMenuService, store.add(subject.instantiation.createInstance(MenuService)));
		const element = append(document.body, $('.plugin-sidebar-test'));
		store.add({ dispose: () => element.remove() });
		const toolbar = store.add(subject.instantiation.createInstance(MenuWorkbenchToolBar, element, MenuId.AuxiliaryBarTitle, {}));
		const first = element.textContent;
		const changed = Event.toPromise(toolbar.onDidChangeMenuItems);
		subject.projects.selectProject(beta);
		await changed;
		assert.deepStrictEqual({ first: first?.includes('Alpha'), current: element.textContent?.includes('Beta'), plugins: !!element.querySelector('.codicon-extensions') }, { first: true, current: true, plugins: true });
	});
});

suite('ADE inspector right sidebar routing', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('opens Project Inspector in ADE mode without startup auto-hide race and restores IDE coding agent sidebar on return', () => {
		const instantiation = workbenchInstantiationService(undefined, store);
		let mode: WorkbenchMode = 'ade';
		const modeChanges = store.add(new Emitter<WorkbenchMode>());
		let activeAuxId: string | undefined;
		let auxHidden = true;
		const openedContainers: string[] = [];

		instantiation.stub(IWorkbenchModeService, { get mode() { return mode; }, onDidChangeMode: modeChanges.event });
		instantiation.stub(IExtensionService, {
			extensions: [{ ...nullExtensionDescription, identifier: new ExtensionIdentifier('anthropic.claude-code') }],
			whenInstalledExtensionsRegistered: async () => true,
		});
		instantiation.stub(IViewDescriptorService, {
			onDidChangeViewContainers: Event.None,
			getViewContainersByLocation: () => [],
			getViewContainerById: (id: string) => new class extends mock<ViewContainer>() {
				override readonly id = id;
				override readonly extensionId = id === 'claude.sidebar' ? new ExtensionIdentifier('anthropic.claude-code') : undefined;
			}(),
			getViewContainerModel: () => new class extends mock<IViewContainerModel>() {
				override readonly allViewDescriptors = [];
				override readonly activeViewDescriptors = [];
			}(),
			getViewDescriptorById: () => null,
		});
		instantiation.stub(IViewsService, {
			onDidChangeViewVisibility: Event.None,
			openViewContainer: async (id: string) => {
				openedContainers.push(id);
				if (id === ADE_INSPECTOR_CONTAINER_ID || id === 'claude.sidebar') {
					activeAuxId = id;
				}
				return null;
			},
		});
		instantiation.stub(IWorkbenchLayoutService, 'setPartHidden', (hidden: boolean, part: Parts) => {
			if (part === Parts.AUXILIARYBAR_PART) {
				auxHidden = hidden;
			}
		});
		instantiation.stub(IPaneCompositePartService, {
			getActivePaneComposite: (loc: ViewContainerLocation) => loc === ViewContainerLocation.AuxiliaryBar && activeAuxId
				? new class extends mock<IPaneComposite>() { override getId() { return activeAuxId!; } }()
				: undefined,
			hideActivePaneComposite: (loc: ViewContainerLocation) => {
				if (loc === ViewContainerLocation.AuxiliaryBar) {
					activeAuxId = undefined;
					auxHidden = true;
				}
			},
			onDidPaneCompositeOpen: Event.None,
			onDidPaneCompositeClose: Event.None,
		});

		store.add(instantiation.createInstance(WorkbenchModeLayoutContribution));
		const startupAde = { auxHidden, activeAuxId };

		// Return to IDE when no previous IDE container existed -> hides inspector
		mode = 'ide';
		modeChanges.fire('ide');
		const backToEmptyIde = { auxHidden, activeAuxId };

		// Open Claude coding agent in IDE, switch to ADE -> swaps to ADE inspector, then switch back to IDE -> restores Claude
		activeAuxId = 'claude.sidebar';
		auxHidden = false;
		mode = 'ade';
		modeChanges.fire('ade');
		const switchedToAde = { auxHidden, activeAuxId };

		mode = 'ide';
		modeChanges.fire('ide');
		const restoredInIde = { auxHidden, activeAuxId };

		assert.deepStrictEqual({ startupAde, backToEmptyIde, switchedToAde, restoredInIde }, {
			startupAde: { auxHidden: false, activeAuxId: ADE_INSPECTOR_CONTAINER_ID },
			backToEmptyIde: { auxHidden: true, activeAuxId: undefined },
			switchedToAde: { auxHidden: false, activeAuxId: ADE_INSPECTOR_CONTAINER_ID },
			restoredInIde: { auxHidden: false, activeAuxId: 'claude.sidebar' },
		});
		const storage = instantiation.get(IStorageService);
		assert.strictEqual(storage.getBoolean('chat.tools.global.autoApprove.optIn', StorageScope.APPLICATION), true);
		assert.strictEqual(storage.getBoolean('chat.permissions.autoApprove.dontShowWarningAgain', StorageScope.APPLICATION), true);
		assert.strictEqual(storage.getBoolean('chat.tools.terminal.autoApprove.warningAccepted', StorageScope.APPLICATION), true);

		const defaults = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationDefaultsOverrides();
		assert.strictEqual(defaults.get('chat.permissions.default')?.value, 'autoApprove');
		assert.strictEqual(defaults.get('chat.tools.global.autoApprove')?.value, true);
		assert.strictEqual(defaults.get('chat.tools.terminal.enableAutoApprove')?.value, true);
		assert.strictEqual(defaults.get('security.workspace.trust.enabled')?.value, false);
		assert.strictEqual(defaults.get('claudeCode.initialPermissionMode')?.value, 'bypassPermissions');
	});
});
