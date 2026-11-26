/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
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
import { IAdeControlCenterService } from '../../../../../platform/ade/common/adeControlCenterIpc.js';
import { AdeProjectsService } from '../../../ade/browser/adeProjectsService.js';
import { ADE_INSPECTOR_CONTAINER_ID, buildAdeEmployeeSessionUri, IAdeProjectsService } from '../../../ade/common/ade.js';
import { IAdeEngine, IAdeEngineSession, IAdeSessionsService } from '../../../ade/browser/adeSessionsService.js';
import { IAdeCloudHostBackendService } from '../../../../../platform/ade/common/adeCloudHosts.js';
import { IChatService, IChatModelReference } from '../../../chat/common/chatService/chatService.js';
import { IChatModel } from '../../../chat/common/model/chatModel.js';
import { ExtensionState, IExtension, IExtensionsWorkbenchService } from '../../../extensions/common/extensions.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../../files/browser/projectNavigationService.js';
import {
	filterPureNativeIdeSessions,
	IDE_AGENT_ENGINE_ICON,
	IDE_OPEN_SESSIONS_COMMAND_ID,
	IDE_SESSIONS_CONTAINER_ID,
	IDE_SESSIONS_VIEW_ID,
	IdeSessionsViewPane,
	IIdeEmbeddedChatWidget,
	IIdeNativeSessionItem,
} from '../../browser/ideSessionsView.js';
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

	test('does NOT pin Coding Agents at the top of Plugins menu (strictly decoupled alphabetical plugin list)', async () => {
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
			descriptions: subject.picks.map(pick => pick.description),
			opened: subject.opened,
		}, {
			order: [
				'alpha.formatter',
				'anthropic.claude-code',
				'openai.chatgpt',
				'sst-dev.opencode',
				'zlib.linter',
			],
			descriptions: [
				'alpha.formatter',
				'anthropic.claude-code',
				'openai.chatgpt',
				'sst-dev.opencode',
				'zlib.linter',
			],
			opened: ['details:sst-dev.opencode'],
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
		await subject.ade.whenReady();
		subject.projects.selectProject(alpha);
		const firstFolder = URI.file('/ade/First');
		const secondFolder = URI.file('/ade/Second');
		subject.ade.registerProject(firstFolder, 'First');
		subject.ade.registerProject(secondFolder, 'Second');
		const firstPage = await subject.ade.createProjectPage(firstFolder, 'First Page');
		const controlCenter = subject.instantiation.get(IAdeControlCenterService);
		const l1 = await controlCenter.uiCreateAgent({
			projectId: firstPage.meta.project_id,
			parentId: null,
			level: 1,
			name: 'Lead',
			roleSummary: 'Top lead',
			host: 'local',
			engine: 'claude',
			model: 'claude-sonnet-4-6',
			effort: 'medium',
		});
		const child = await controlCenter.uiCreateAgent({
			projectId: firstPage.meta.project_id,
			parentId: l1.agent_id,
			level: 2,
			name: 'Review',
			roleSummary: 'Code reviewer',
			host: 'local',
			engine: 'codex',
			model: 'gpt-5.2-codex',
			effort: 'medium',
		});
		const updatedSnap = await controlCenter.getProjectSnapshot(firstPage.meta.project_id);
		if (updatedSnap) {
			subject.ade.notifyProjectSnapshotLoaded(updatedSnap);
		}
		subject.setMode('ade');
		subject.ade.selectAgent(child.agent_id);
		const childLabel = subject.label();
		await subject.selectProject(secondFolder);
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

suite('IDE Pure-Native Cloud Sessions panel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const cloudFolder = URI.parse('aexus-ssh://ubuntu-target1/home/lab/bhce');
	const localFolder = URI.file('/projects/LocalApp');

	test('filterPureNativeIdeSessions excludes ADE employee sessions and unregistered legacy schemes, deduplicates, and sorts newest-first', () => {
		const adeDeterministicRes = buildAdeEmployeeSessionUri('claude', 'proj_alpha', 'agent_l1');
		const adeCustomBoundRes = URI.parse('aexus-claude://s/ade-worker-1');
		const legacyScheme = `aexus-${'sec'}${'retary'}`;
		const legacyRes = URI.parse(`${legacyScheme}://s/sec-1`);
		const nativeOlder = URI.parse('aexus-claude://s/native-old');
		const nativeNewer = URI.parse('aexus-codex://s/native-new');

		const items: IIdeNativeSessionItem[] = [
			{ engineId: 'aexus-claude', engineName: 'Claude Code', resource: adeDeterministicRes, projectUri: cloudFolder, label: 'ADE Deterministic Employee', updated: 7000, remoteHost: 'ubuntu-target1' },
			{ engineId: 'aexus-claude', engineName: 'Claude Code', resource: adeCustomBoundRes, projectUri: cloudFolder, label: 'ADE Worker Session', updated: 5000, remoteHost: 'ubuntu-target1' },
			{ engineId: legacyScheme, engineName: 'Legacy', resource: legacyRes, projectUri: cloudFolder, label: 'Legacy Assistant', updated: 6000, remoteHost: 'ubuntu-target1' },
			{ engineId: 'aexus-claude', engineName: 'Claude Code', resource: nativeOlder, projectUri: cloudFolder, label: 'Old Native Cloud Session', updated: 2000, remoteHost: 'ubuntu-target1' },
			{ engineId: 'aexus-codex', engineName: 'Codex', resource: nativeNewer, projectUri: cloudFolder, label: 'New Native Cloud Session', updated: 4000, remoteHost: 'ubuntu-target1' },
			{ engineId: 'aexus-codex', engineName: 'Codex', resource: nativeNewer, projectUri: cloudFolder, label: 'Duplicate Entry', updated: 4000, remoteHost: 'ubuntu-target1' },
		];

		const filtered = filterPureNativeIdeSessions(items, new Set([adeCustomBoundRes.toString()]));
		assert.deepStrictEqual(
			filtered.map(s => ({ resource: s.resource.toString(), label: s.label })),
			[
				{ resource: nativeNewer.toString(), label: 'New Native Cloud Session' },
				{ resource: nativeOlder.toString(), label: 'Old Native Cloud Session' },
			],
		);
	});

	test('lists cloud historical sessions in right sidebar, strictly excludes ADE sessions, enters embedded chat on click, and creates pure-native sessions without touching ADE', async () => {
		const instantiation = workbenchInstantiationService(undefined, store);
		instantiation.stub(IWorkspaceContextService, {
			getWorkspace: () => new Workspace('ide', [toWorkspaceFolder(cloudFolder), toWorkspaceFolder(localFolder)]),
			onDidChangeWorkspaceFolders: Event.None,
		});
		const projects = store.add(instantiation.createInstance(ProjectNavigationService));
		projects.selectProject(cloudFolder);
		instantiation.stub(IProjectNavigationService, projects);

		const ade = store.add(instantiation.createInstance(AdeProjectsService));
		await ade.whenReady();
		await ade.registerWorkspaceFolderAsync!(cloudFolder);
		const cloudPage = await ade.createProjectPage(cloudFolder, 'Cloud Page');
		const controlCenter = instantiation.get(IAdeControlCenterService);
		const adeAgent = await controlCenter.uiCreateAgent({
			projectId: cloudPage.meta.project_id,
			parentId: null,
			level: 1,
			name: 'Backend Lead',
			roleSummary: 'Cloud backend lead',
			host: 'ubuntu-target1',
			engine: 'claude',
			model: 'claude-sonnet-4-6',
			effort: 'medium',
		});
		const adeSnap = await controlCenter.getProjectSnapshot(cloudPage.meta.project_id);
		if (adeSnap) {
			ade.notifyProjectSnapshotLoaded(adeSnap);
		}
		const adeRoleRes = buildAdeEmployeeSessionUri('claude', cloudPage.meta.project_id, adeAgent.agent_id);
		instantiation.stub(IAdeProjectsService, ade);

		const cloudNativeRes1 = URI.parse('aexus-claude://s/cloud-native-1');
		const cloudNativeRes2 = URI.parse('aexus-codex://s/cloud-native-2');
		const createdRes = URI.parse('aexus-claude://s/cloud-native-created');

		const cloudEngines: IAdeEngine[] = [
			{ id: 'aexus-claude', name: 'Claude Code', description: 'Native on ubuntu-target1', remoteHost: 'ubuntu-target1', remoteOs: 'Ubuntu 24.04' },
			{ id: 'aexus-codex', name: 'Codex', description: 'Native on ubuntu-target1', remoteHost: 'ubuntu-target1', remoteOs: 'Ubuntu 24.04' },
		];
		const createdCalls: Array<{ engineId: string; uri: string }> = [];

		instantiation.stub(IAdeSessionsService, {
			onDidChangeEngines: Event.None,
			getIcon: () => undefined,
			getEngineName: (id: string) => id === 'aexus-codex' ? 'Codex' : 'Claude Code',
			getEngines: async () => cloudEngines,
			probeEnginesForProject: async () => ({ engines: cloudEngines, remoteHost: 'ubuntu-target1', remoteOs: 'Ubuntu 24.04' }),
			list: async (engineId: string): Promise<readonly IAdeEngineSession[]> => {
				if (engineId === 'aexus-claude') {
					return [
						{ engineId: 'aexus-claude', resource: adeRoleRes, projectUri: cloudFolder, label: 'ADE Backend Lead (Must Be Hidden)', updated: 9000 },
						{ engineId: 'aexus-claude', resource: cloudNativeRes1, projectUri: cloudFolder, label: 'Fix kernel module build', updated: 8000 },
					];
				}
				return [
					{ engineId: 'aexus-codex', resource: cloudNativeRes2, projectUri: cloudFolder, label: 'Inspect packet capture', updated: 7000 },
				];
			},
			create: async (engineId: string, projectUri: URI): Promise<IAdeEngineSession> => {
				createdCalls.push({ engineId, uri: projectUri.toString() });
				return { engineId, resource: createdRes, projectUri, label: 'Fresh Native Session', updated: 10000 };
			},
			rename: async () => undefined,
			delete: async () => undefined,
		});

		instantiation.stub(IAdeCloudHostBackendService, {
			onDidChangeHosts: Event.None,
			listHosts: async () => [{
				id: 'h1',
				name: 'Ubuntu Target 1',
				alias: 'ubuntu-target1',
				hostName: '10.0.0.5',
				port: 22,
				user: 'lab',
				os: 'linux',
				recentDirectories: ['/home/lab/bhce'],
				source: 'user',
				createdAt: 1000,
				updatedAt: 1000,
				lastTestStatus: { ok: true, remoteUname: 'Linux ubuntu-target1 6.8.0-ubuntu', checkedAt: Date.now(), latencyMs: 12 },
			}],
		});

		const dummyContainer = new class extends mock<ViewContainer>() {
			override readonly id = IDE_SESSIONS_CONTAINER_ID;
		}();
		instantiation.stub(IViewDescriptorService, {
			getViewLocationById: () => ViewContainerLocation.AuxiliaryBar,
			onDidChangeLocation: Event.None,
			getViewDescriptorById: () => null,
			getViewContainerByViewId: () => dummyContainer,
			getDefaultContainerById: () => dummyContainer,
			getViewContainerModel: () => new class extends mock<IViewContainerModel>() {
				override readonly title = 'Native Sessions';
				override readonly onDidChangeContainerInfo = Event.None;
			}(),
		});

		const acquiredResources: string[] = [];
		const boundModels: Array<IChatModel | undefined> = [];
		instantiation.stub(IChatService, {
			acquireOrLoadSession: async (resource: URI): Promise<IChatModelReference> => {
				acquiredResources.push(resource.toString());
				const fakeModel = { sessionResource: resource } as unknown as IChatModel;
				return { object: fakeModel, dispose: () => undefined };
			},
		});

		class TestIdeSessionsViewPane extends IdeSessionsViewPane {
			protected override createChatWidget(): IIdeEmbeddedChatWidget {
				return {
					render: () => undefined,
					setVisible: () => undefined,
					layout: () => undefined,
					setModel: (model: IChatModel | undefined) => { boundModels.push(model); },
					focusInput: () => undefined,
					dispose: () => undefined,
				};
			}
			renderInto(parent: HTMLElement): void {
				this.renderBody(parent);
			}
		}

		const pane = store.add(instantiation.createInstance(TestIdeSessionsViewPane, { id: IDE_SESSIONS_VIEW_ID, title: 'Native Sessions' }));
		const host = append(document.body, $('.ide-sessions-test-host'));
		store.add({ dispose: () => host.remove() });

		pane.renderInto(host);
		await pane.refreshSessions(false);

		const renderedRows = [...host.querySelectorAll<HTMLElement>('.aexus-ide-session-row')];
		const renderedResources = renderedRows.map(el => el.getAttribute('data-ide-session-resource'));
		assert.deepStrictEqual(renderedResources, [cloudNativeRes1.toString(), cloudNativeRes2.toString()]);
		assert.strictEqual(host.querySelector('[data-ide-pure-native="true"]')?.textContent, 'Pure Native');
		assert.strictEqual(host.querySelector('[data-ide-project-os]')?.getAttribute('data-ide-project-os'), 'ubuntu');

		// Filter by Codex engine chip -> only Codex session remains
		const codexChip = host.querySelector<HTMLButtonElement>('[data-ide-engine-filter="aexus-codex"]')!;
		codexChip.click();
		assert.deepStrictEqual(
			[...host.querySelectorAll<HTMLElement>('.aexus-ide-session-row')].map(el => el.getAttribute('data-ide-session-resource')),
			[cloudNativeRes2.toString()],
		);

		// Click the cloud session -> enters embedded right-sidebar conversation WITHOUT adding to ADE!
		const adeAgentCountBefore = ade.agents.length;
		const rowToOpen = host.querySelector<HTMLElement>('.aexus-ide-session-row')!;
		rowToOpen.click();
		await new Promise(resolve => setTimeout(resolve, 20));

		const listShell = host.querySelector<HTMLElement>('.aexus-ide-sessions-list-shell')!;
		const chatShell = host.querySelector<HTMLElement>('.aexus-ide-chat-shell')!;
		assert.strictEqual(listShell.hidden, true);
		assert.strictEqual(chatShell.hidden, false);
		assert.deepStrictEqual(acquiredResources, [cloudNativeRes2.toString()]);
		assert.strictEqual(boundModels.at(-1)?.sessionResource.toString(), cloudNativeRes2.toString());
		assert.strictEqual(ade.agents.length, adeAgentCountBefore);

		// Click Back -> exits conversation and returns to session list
		const backBtn = host.querySelector<HTMLButtonElement>('[data-ide-chat-back="true"]')!;
		backBtn.click();
		assert.strictEqual(listShell.hidden, false);
		assert.strictEqual(chatShell.hidden, true);
		assert.strictEqual(boundModels.at(-1), undefined);

		// Create new Pure Native session -> selects Claude via quick pick, creates on cloud host, NEVER touches ADE!
		host.querySelector<HTMLButtonElement>('[data-ide-engine-filter="all"]')!.click();
		instantiation.stub(IQuickInputService, 'pick', async (items: Array<{ engine: IAdeEngine }>) => items.find(i => i.engine.id === 'aexus-claude'));
		await pane.createNewNativeSession();

		assert.deepStrictEqual(createdCalls, [{ engineId: 'aexus-claude', uri: cloudFolder.toString() }]);
		assert.strictEqual(acquiredResources.at(-1), createdRes.toString());
		assert.strictEqual(ade.agents.length, adeAgentCountBefore);
	});

	test('OpenIdeSessionsAction opens right sidebar panel and auto-switches when selecting a cloud folder in IDE', async () => {
		const instantiation = workbenchInstantiationService(undefined, store);
		instantiation.stub(IWorkspaceContextService, {
			getWorkspace: () => new Workspace('ide', [toWorkspaceFolder(localFolder), toWorkspaceFolder(cloudFolder)]),
			onDidChangeWorkspaceFolders: Event.None,
		});
		const projects = store.add(instantiation.createInstance(ProjectNavigationService));
		projects.selectProject(localFolder);
		instantiation.stub(IProjectNavigationService, projects);

		const mode: WorkbenchMode = 'ide';
		const modeChanges = store.add(new Emitter<WorkbenchMode>());
		let activeAuxId: string | undefined = 'claude.sidebar';
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
				if (id === IDE_SESSIONS_CONTAINER_ID || id === ADE_INSPECTOR_CONTAINER_ID) {
					activeAuxId = id;
				}
				return null;
			},
			getActiveViewWithId: () => null,
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
			hideActivePaneComposite: () => undefined,
			onDidPaneCompositeOpen: Event.None,
			onDidPaneCompositeClose: Event.None,
		});

		store.add(instantiation.createInstance(WorkbenchModeLayoutContribution));

		// Selecting a cloud folder in IDE while Claude local plugin is active auto-switches to IDE_SESSIONS_CONTAINER_ID!
		projects.selectProject(cloudFolder);
		assert.strictEqual(openedContainers.includes(IDE_SESSIONS_CONTAINER_ID), true);

		// Explicit OpenIdeSessionsAction unhides AuxiliaryBar and opens IDE_SESSIONS_CONTAINER_ID
		auxHidden = true;
		await instantiation.invokeFunction(CommandsRegistry.getCommand(IDE_OPEN_SESSIONS_COMMAND_ID)!.handler, cloudFolder);
		assert.strictEqual(auxHidden, false);
		assert.strictEqual(activeAuxId, IDE_SESSIONS_CONTAINER_ID);

		// Right titlebar & view container icon must be Agent Engine icon (Codicon.robot), NOT Codicon.cloud
		const titleBarEntry = MenuRegistry.getMenuItems(MenuId.TitleBar)
			.filter(isIMenuItem)
			.find(entry => entry.command.id === IDE_OPEN_SESSIONS_COMMAND_ID);
		assert.ok(titleBarEntry, 'OpenIdeSessionsAction is registered in TitleBar');
		assert.ok(ThemeIcon.isThemeIcon(titleBarEntry.command.icon) && ThemeIcon.isEqual(titleBarEntry.command.icon, IDE_AGENT_ENGINE_ICON));
		assert.ok(ThemeIcon.isEqual(IDE_AGENT_ENGINE_ICON, Codicon.robot));
		const viewContainer = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry).get(IDE_SESSIONS_CONTAINER_ID);
		assert.ok(viewContainer && ThemeIcon.isThemeIcon(viewContainer.icon) && ThemeIcon.isEqual(viewContainer.icon, IDE_AGENT_ENGINE_ICON));
	});

	test('supports both Local & Cloud folders, adding existing/attached sessions, creating new sessions, and launching installed Coding Agent extensions from the right Agent button', async () => {
		const instantiation = workbenchInstantiationService(undefined, store);
		const otherLocalFolder = URI.file('/projects/OtherLocal');
		instantiation.stub(IWorkspaceContextService, {
			getWorkspace: () => new Workspace('ide', [toWorkspaceFolder(localFolder), toWorkspaceFolder(cloudFolder)]),
			onDidChangeWorkspaceFolders: Event.None,
		});
		const projects = store.add(instantiation.createInstance(ProjectNavigationService));
		projects.selectProject(localFolder);
		instantiation.stub(IProjectNavigationService, projects);

		const ade = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, ade);

		const localEngines: IAdeEngine[] = [
			{ id: 'aexus-claude', name: 'Claude Code', description: 'Local Claude Code CLI' },
			{ id: 'aexus-codex', name: 'Codex', description: 'Local Codex CLI' },
		];
		const localResExisting = URI.parse('aexus-claude://s/local-existing-1');
		const localOtherRes = URI.parse('aexus-codex://s/local-other-folder-2');
		const attachedRes = URI.parse('aexus-claude://s/attached-manual-99');
		const createdLocalRes = URI.parse('aexus-codex://s/local-created-3');

		const listQueries: Array<{ engineId: string; uri: string | undefined }> = [];
		const attachedCalls: Array<{ engineId: string; nativeId: string; uri?: string }> = [];
		const createdCalls: Array<{ engineId: string; uri: string }> = [];

		instantiation.stub(IAdeSessionsService, {
			onDidChangeEngines: Event.None,
			getIcon: () => undefined,
			getEngineName: (id: string) => id === 'aexus-codex' ? 'Codex' : 'Claude Code',
			getEngines: async () => localEngines,
			probeEnginesForProject: async () => ({ engines: localEngines }),
			list: async (engineId: string, projectUri?: URI): Promise<readonly IAdeEngineSession[]> => {
				listQueries.push({ engineId, uri: projectUri?.toString() });
				if (engineId === 'aexus-claude' && projectUri?.toString() === localFolder.toString()) {
					return [{ engineId: 'aexus-claude', resource: localResExisting, projectUri: localFolder, label: 'Local Refactor Thread', updated: 3000 }];
				}
				if (!projectUri) {
					return [{ engineId: 'aexus-codex', resource: localOtherRes, projectUri: otherLocalFolder, label: 'Cross-Folder Codex Session', updated: 4500 }];
				}
				return [];
			},
			create: async (engineId: string, projectUri: URI): Promise<IAdeEngineSession> => {
				createdCalls.push({ engineId, uri: projectUri.toString() });
				return { engineId, resource: createdLocalRes, projectUri, label: 'New Local Codex Session', updated: 6000 };
			},
			attach: async (engineId: string, nativeId: string, projectUri?: URI): Promise<IAdeEngineSession> => {
				attachedCalls.push({ engineId, nativeId, uri: projectUri?.toString() });
				return { engineId, resource: attachedRes, projectUri: projectUri ?? localFolder, label: `Attached ${nativeId}`, updated: 7000 };
			},
			rename: async () => undefined,
			delete: async () => undefined,
		});

		const acquiredResources: string[] = [];
		instantiation.stub(IChatService, {
			acquireOrLoadSession: async (resource: URI): Promise<IChatModelReference> => {
				acquiredResources.push(resource.toString());
				return { object: { sessionResource: resource } as unknown as IChatModel, dispose: () => undefined };
			},
		});

		let launchedOpenCode = false;
		store.add(CommandsRegistry.registerCommand('opencode.openNewTerminal', () => {
			launchedOpenCode = true;
		}));
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

		const dummyContainer = new class extends mock<ViewContainer>() { override readonly id = IDE_SESSIONS_CONTAINER_ID; }();
		instantiation.stub(IViewDescriptorService, {
			get viewContainers() { return []; },
			getViewLocationById: () => ViewContainerLocation.AuxiliaryBar,
			getViewContainerLocation: () => ViewContainerLocation.AuxiliaryBar,
			onDidChangeLocation: Event.None,
			getViewDescriptorById: () => null,
			getViewContainerByViewId: () => dummyContainer,
			getDefaultContainerById: () => dummyContainer,
			getViewContainerModel: () => new class extends mock<IViewContainerModel>() {
				override readonly title = 'Agent Engines';
				override readonly allViewDescriptors = [];
				override readonly activeViewDescriptors = [];
				override readonly onDidChangeContainerInfo = Event.None;
			}(),
		});

		const openCodeExt = new class extends mock<IExtension>() {
			override readonly identifier = { id: 'sst-dev.opencode' };
			override readonly displayName = 'OpenCode';
			override readonly name = 'opencode';
			override readonly isBuiltin = false;
			override readonly state = ExtensionState.Installed;
		}();
		const formatterExt = new class extends mock<IExtension>() {
			override readonly identifier = { id: 'alpha.formatter' };
			override readonly displayName = 'Alpha Formatter';
			override readonly name = 'formatter';
			override readonly isBuiltin = false;
			override readonly state = ExtensionState.Installed;
		}();
		instantiation.stub(IExtensionService, {
			extensions: [{ ...nullExtensionDescription, identifier: new ExtensionIdentifier('sst-dev.opencode') }],
			whenInstalledExtensionsRegistered: async () => true,
		});
		instantiation.stub(IExtensionsWorkbenchService, {
			queryLocal: async () => [formatterExt, openCodeExt],
			open: async () => undefined,
		});

		class TestLocalIdeSessionsViewPane extends IdeSessionsViewPane {
			protected override createChatWidget(): IIdeEmbeddedChatWidget {
				return {
					render: () => undefined,
					setVisible: () => undefined,
					layout: () => undefined,
					setModel: () => undefined,
					focusInput: () => undefined,
					dispose: () => undefined,
				};
			}
			renderInto(parent: HTMLElement): void {
				this.renderBody(parent);
			}
		}

		const pane = store.add(instantiation.createInstance(TestLocalIdeSessionsViewPane, { id: IDE_SESSIONS_VIEW_ID, title: 'Agent Sessions' }));
		const host = append(document.body, $('.ide-local-sessions-test-host'));
		store.add({ dispose: () => host.remove() });
		pane.renderInto(host);
		await pane.refreshSessions(false);

		// 1. Both Add Session & New Session buttons exist on Local project
		assert.ok(host.querySelector('[data-ide-sessions-add="true"]'), 'Add Session button rendered');
		assert.ok(host.querySelector('[data-ide-sessions-new="true"]'), 'New Session button rendered');
		assert.ok(host.querySelector('[data-ide-agent-extensions="true"]'), 'Installed Agent Extensions button rendered');
		assert.strictEqual(host.querySelector('[data-ide-project-remote]')?.getAttribute('data-ide-project-remote'), 'false');

		// 2. Add Existing Session -> strictly scoped to active project ONLY (never queries undefined/otherLocalFolder!)
		let addCandidateResources: string[] = [];
		instantiation.stub(IQuickInputService, 'pick', async (items: Array<{ kind?: string; session?: IIdeNativeSessionItem }>) => {
			addCandidateResources = items.filter(i => i.kind === 'session' && i.session).map(i => i.session!.resource.toString());
			return items.find(i => i.kind === 'session' && i.session?.resource.toString() === localResExisting.toString());
		});
		await pane.addExistingNativeSession();
		assert.deepStrictEqual(addCandidateResources, [localResExisting.toString()]);
		assert.strictEqual(listQueries.some(q => q.uri === undefined), false, 'Must NEVER query unscoped host-wide sessions');
		assert.strictEqual(acquiredResources.at(-1), localResExisting.toString());
		assert.strictEqual(ade.agents.length, 0);

		// 3. Add Existing Session -> Attach by ID -> attaches & opens Pure Native session
		let pickStep = 0;
		instantiation.stub(IQuickInputService, 'pick', async (items: Array<{ kind?: string; engine?: IAdeEngine }>) => {
			pickStep++;
			if (pickStep === 1) {
				return items.find(i => i.kind === 'attachById');
			}
			return items.find(i => i.engine?.id === 'aexus-claude');
		});
		instantiation.stub(IQuickInputService, 'input', async () => 'sess-manual-99');
		await pane.addExistingNativeSession();
		assert.deepStrictEqual(attachedCalls, [{ engineId: 'aexus-claude', nativeId: 'sess-manual-99', uri: localFolder.toString() }]);
		assert.strictEqual(acquiredResources.at(-1), attachedRes.toString());
		assert.strictEqual(ade.agents.length, 0);

		// 4. Refresh preserves manually added/attached sessions in the local project list
		pane.exitConversationView();
		await pane.refreshSessions(false);
		const listedAfterRefresh = [...host.querySelectorAll<HTMLElement>('.aexus-ide-session-row')].map(el => el.getAttribute('data-ide-session-resource'));
		assert.ok(listedAfterRefresh.includes(attachedRes.toString()), 'Attached session persists across refresh');
		assert.ok(listedAfterRefresh.includes(localResExisting.toString()), 'Discovered & added local folder session remains listed');
		assert.strictEqual(listedAfterRefresh.includes(localOtherRes.toString()), false, 'Unrelated cross-folder session must never appear');

		// 5. New Session -> creates a brand-new Local Pure Native session
		instantiation.stub(IQuickInputService, 'pick', async (items: Array<{ engine?: IAdeEngine }>) => items.find(i => i.engine?.id === 'aexus-codex'));
		await pane.createNewNativeSession();
		assert.deepStrictEqual(createdCalls, [{ engineId: 'aexus-codex', uri: localFolder.toString() }]);
		assert.strictEqual(acquiredResources.at(-1), createdLocalRes.toString());
		assert.strictEqual(ade.agents.length, 0);

		// 6. Right Agent button takes over installed Coding Agent extensions (only Coding Agents shown, NOT alpha.formatter) and launches panel-less OpenCode
		let seenExtIds: string[] = [];
		instantiation.stub(IQuickInputService, 'pick', async (items: Array<{ extension?: IExtension }>) => {
			seenExtIds = items.map(i => i.extension?.identifier.id ?? '');
			return items.find(i => i.extension?.identifier.id === 'sst-dev.opencode');
		});
		await pane.openInstalledAgentExtension();
		assert.deepStrictEqual(seenExtIds, ['sst-dev.opencode']);
		assert.strictEqual(launchedOpenCode, true);
		assert.strictEqual(projects.codingAgentProjects.get('sst-dev.opencode')?.toString(), localFolder.toString());
	});

	test('cloud Add Session strictly scopes to active cloud project and excludes sibling folders on the same host', async () => {
		const instantiation = workbenchInstantiationService(undefined, store);
		const cloudExp = URI.parse('aexus-ssh://bupt208/home/djf/develop/aexus-ide-cloud-exp');
		const cloudOther = URI.parse('aexus-ssh://bupt208/home/djf/develop/aexus-ide-cloud-other');
		instantiation.stub(IWorkspaceContextService, {
			getWorkspace: () => new Workspace('ide', [toWorkspaceFolder(cloudExp), toWorkspaceFolder(cloudOther)]),
			onDidChangeWorkspaceFolders: Event.None,
		});
		const projects = store.add(instantiation.createInstance(ProjectNavigationService));
		projects.selectProject(cloudExp);
		instantiation.stub(IProjectNavigationService, projects);

		const ade = store.add(instantiation.createInstance(AdeProjectsService));
		instantiation.stub(IAdeProjectsService, ade);

		const cloudEngines: IAdeEngine[] = [
			{ id: 'aexus-claude', name: 'Claude Code', description: 'Remote Claude Code CLI on bupt208' },
		];
		const expRes1 = URI.parse('aexus-claude:///89db1f44-cb97-4d2a-ba5d-e91d4bb03216');
		const expRes2 = URI.parse('aexus-claude:///0470fb47-e4c4-4b0c-ad92-e510370d6672');
		const otherRes = URI.parse('aexus-claude:///763c514b-fcf2-4eb0-86e7-49ed1bfc82d8');

		const queriedUris: string[] = [];
		instantiation.stub(IAdeSessionsService, {
			onDidChangeEngines: Event.None,
			getIcon: () => undefined,
			getEngineName: () => 'Claude Code',
			getEngines: async () => cloudEngines,
			probeEnginesForProject: async () => ({ engines: cloudEngines, remoteHost: 'bupt208' }),
			list: async (_engineId: string, projectUri?: URI): Promise<readonly IAdeEngineSession[]> => {
				queriedUris.push(projectUri?.toString() ?? 'undefined');
				if (projectUri?.toString() === cloudExp.toString()) {
					return [
						{ engineId: 'aexus-claude', resource: expRes1, projectUri: cloudExp, label: 'bupt208-claude-火星计划', updated: 5000 },
						{ engineId: 'aexus-claude', resource: expRes2, projectUri: cloudExp, label: 'bupt208-claude-星云调试', updated: 4000 },
					];
				}
				if (projectUri?.toString() === cloudOther.toString()) {
					return [
						{ engineId: 'aexus-claude', resource: otherRes, projectUri: cloudOther, label: 'bupt208-other-不应出现', updated: 9000 },
					];
				}
				return [];
			},
			create: async (_engineId: string, projectUri: URI) => ({ engineId: 'aexus-claude', resource: expRes1, projectUri, label: 'New', updated: 1 }),
			attach: async (_engineId: string, nativeId: string, projectUri?: URI) => ({ engineId: 'aexus-claude', resource: expRes1, projectUri: projectUri ?? cloudExp, label: nativeId, updated: 6000 }),
			rename: async () => undefined,
			delete: async () => undefined,
		});

		const openedResources: string[] = [];
		instantiation.stub(IChatService, {
			acquireOrLoadSession: async (resource: URI): Promise<IChatModelReference> => {
				openedResources.push(resource.toString());
				return { object: { sessionResource: resource } as unknown as IChatModel, dispose: () => undefined };
			},
		});

		const dummyCloudContainer = new class extends mock<ViewContainer>() { override readonly id = IDE_SESSIONS_CONTAINER_ID; }();
		instantiation.stub(IViewDescriptorService, {
			get viewContainers() { return []; },
			getViewLocationById: () => ViewContainerLocation.AuxiliaryBar,
			getViewContainerLocation: () => ViewContainerLocation.AuxiliaryBar,
			onDidChangeLocation: Event.None,
			getViewDescriptorById: () => null,
			getViewContainerByViewId: () => dummyCloudContainer,
			getDefaultContainerById: () => dummyCloudContainer,
			getViewContainerModel: () => new class extends mock<IViewContainerModel>() {
				override readonly title = 'Agent Engines';
				override readonly allViewDescriptors = [];
				override readonly activeViewDescriptors = [];
				override readonly onDidChangeContainerInfo = Event.None;
			}(),
		});

		class TestCloudScopePane extends IdeSessionsViewPane {
			protected override createChatWidget(): IIdeEmbeddedChatWidget {
				return {
					render: () => undefined,
					setVisible: () => undefined,
					layout: () => undefined,
					setModel: () => undefined,
					focusInput: () => undefined,
					dispose: () => undefined,
				};
			}
			renderInto(parent: HTMLElement): void {
				this.renderBody(parent);
			}
		}

		const pane = store.add(instantiation.createInstance(TestCloudScopePane, { id: IDE_SESSIONS_VIEW_ID, title: 'Agent Sessions' }));
		const host = append(document.body, $('.ide-cloud-scope-test-host'));
		store.add({ dispose: () => host.remove() });
		pane.renderInto(host);
		await pane.refreshSessions(false);

		queriedUris.length = 0;
		let candidateLabels: string[] = [];
		instantiation.stub(IQuickInputService, 'pick', async (items: Array<{ kind?: string; session?: IIdeNativeSessionItem }>) => {
			candidateLabels = items.filter(i => i.kind === 'session' && i.session).map(i => i.session!.label);
			return items.find(i => i.kind === 'session' && i.session?.label === 'bupt208-claude-火星计划');
		});
		await pane.addExistingNativeSession();

		assert.deepStrictEqual(queriedUris, [cloudExp.toString()], 'Add Session must query ONLY the active cloud project folder');
		assert.deepStrictEqual(candidateLabels, ['bupt208-claude-火星计划', 'bupt208-claude-星云调试']);
		assert.strictEqual(candidateLabels.includes('bupt208-other-不应出现'), false);
		assert.strictEqual(openedResources.at(-1), expRes1.toString());
	});
});
