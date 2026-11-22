/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { hasKey } from '../../../../../base/common/types.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { IAdeCloudHost, IAdeCloudHostBackendService } from '../../../../../platform/ade/common/adeCloudHosts.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IShellLaunchConfig, TerminalLocation, TerminalSettingId } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { ViewContainerLocation, IViewDescriptorService } from '../../../../common/views.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { AdeProjectsService } from '../../../ade/browser/adeProjectsService.js';
import { IAdeProjectsService } from '../../../ade/common/ade.js';
import { IProjectNavigationService, ProjectNavigationService } from '../../../files/browser/projectNavigationService.js';
import { IProjectTerminalService, ProjectTerminalService } from '../../browser/projectTerminalService.js';
import { ICreateTerminalOptions, ITerminalConfigurationService, ITerminalGroupService, ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../browser/terminal.js';
import { TerminalGridConfiguratorPopover } from '../../browser/terminalGridConfigurator.js';
import { TerminalGroup } from '../../browser/terminalGroup.js';
import {
	clampGridDimensions,
	computeOptimalGridForCount,
	ITerminalGridLayoutService,
	MAX_GRID_CELLS,
	normalizeGridPreset,
	resizeGridCells,
	TerminalGridLayoutService,
} from '../../browser/terminalGridLayoutService.js';

interface IFakeTerminalInstance extends ITerminalInstance {
	readonly sentTexts: Array<{ text: string; shouldExecute: boolean }>;
	readonly lastLayout: { width: number; height: number } | undefined;
	readonly fireInputData: (data: string) => void;
	readonly fireFocus: () => void;
	attachedContainer: HTMLElement | undefined;
}

function createFakeInstance(id: number, config: IShellLaunchConfig, store: Pick<DisposableStore, 'add'>): IFakeTerminalInstance {
	const onDisposed = store.add(new Emitter<ITerminalInstance>());
	const onDidFocus = store.add(new Emitter<ITerminalInstance>());
	const onDidInputData = store.add(new Emitter<string>());
	const onTitleChanged = store.add(new Emitter<ITerminalInstance>());
	const onIconChanged = store.add(new Emitter<{ instance: ITerminalInstance; userInitiated: boolean }>());
	const onDidChangeCapabilities = store.add(new Emitter<unknown>());
	const sentTexts: Array<{ text: string; shouldExecute: boolean }> = [];
	let disposed = false;
	let lastLayout: { width: number; height: number } | undefined;

	const inst = new class extends mock<ITerminalInstance>() {
		override readonly instanceId = id;
		override readonly title = config.name ?? `term-${id}`;
		override readonly shellLaunchConfig = config;
		override readonly onDisposed = onDisposed.event;
		override readonly onDidFocus = onDidFocus.event;
		override readonly onDidInputData = onDidInputData.event;
		override readonly onTitleChanged = onTitleChanged.event;
		override readonly onIconChanged = onIconChanged.event;
		override readonly capabilities = { onDidChangeCapabilities: onDidChangeCapabilities.event } as unknown as ITerminalInstance['capabilities'];
		override readonly statusList = { statuses: [] } as unknown as ITerminalInstance['statusList'];
		override disableLayout = false;
		attachedContainer: HTMLElement | undefined;
		readonly sentTexts = sentTexts;
		get lastLayout() { return lastLayout; }
		override get isDisposed() { return disposed; }
		override attachToElement(container: HTMLElement): void {
			this.attachedContainer = container;
		}
		override detachFromElement(): void {
			this.attachedContainer = undefined;
		}
		override layout(dim: { width: number; height: number }): void {
			if (!this.disableLayout) {
				lastLayout = dim;
			}
		}
		override setVisible(): void { }
		override focus(): void {
			onDidFocus.fire(this);
		}
		override async focusWhenReady(): Promise<void> {
			onDidFocus.fire(this);
		}
		override async sendText(text: string, shouldExecute: boolean): Promise<void> {
			sentTexts.push({ text, shouldExecute });
			onDidInputData.fire(text);
		}
		override dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			onDisposed.fire(this);
		}
		fireInputData(data: string): void {
			onDidInputData.fire(data);
		}
		fireFocus(): void {
			onDidFocus.fire(this);
		}
	}();
	return inst as unknown as IFakeTerminalInstance;
}

suite('Terminal 2D Grid Layout & Multi-Host Control', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('pure grid dimension helpers clamp bounds, compute balanced matrices, and preserve cell bindings', () => {
		assert.deepStrictEqual(clampGridDimensions(0, -3), { rows: 1, cols: 1 });
		assert.deepStrictEqual(clampGridDimensions(2, 3), { rows: 2, cols: 3 });
		const clampedHuge = clampGridDimensions(6, 6);
		assert.ok(clampedHuge.rows * clampedHuge.cols <= MAX_GRID_CELLS);

		assert.deepStrictEqual(computeOptimalGridForCount(1), { rows: 1, cols: 1 });
		assert.deepStrictEqual(computeOptimalGridForCount(2), { rows: 1, cols: 2 });
		assert.deepStrictEqual(computeOptimalGridForCount(3), { rows: 1, cols: 3 });
		assert.deepStrictEqual(computeOptimalGridForCount(4), { rows: 2, cols: 2 });
		assert.deepStrictEqual(computeOptimalGridForCount(5), { rows: 2, cols: 3 });
		assert.deepStrictEqual(computeOptimalGridForCount(6), { rows: 2, cols: 3 });
		assert.deepStrictEqual(computeOptimalGridForCount(9), { rows: 3, cols: 3 });

		const resized = resizeGridCells([{ targetUri: 'aexus-ssh://bupt208/home/dev', label: 'bupt208' }], 2, 2);
		assert.strictEqual(resized.length, 4);
		assert.strictEqual(resized[0].targetUri, 'aexus-ssh://bupt208/home/dev');
		assert.strictEqual(resized[1].targetUri, 'active');

		const normalized = normalizeGridPreset({
			name: 'GPU Cluster',
			rows: 2,
			cols: 2,
			broadcastInput: true,
			cells: [{ targetUri: 'aexus-ssh://gpu1/work' }, { targetUri: 'aexus-ssh://gpu2/work' }],
		});
		assert.ok(normalized);
		assert.strictEqual(normalized.rows, 2);
		assert.strictEqual(normalized.cols, 2);
		assert.strictEqual(normalized.cells.length, 4);
		assert.strictEqual(normalized.broadcastInput, true);
		assert.strictEqual(normalizeGridPreset({ rows: 2, cols: 2 }), undefined);
	});

	test('TerminalGroup supports 2D multi-row × multi-column splitting, arrangeAsGrid, replaceInstance, maximize, and loop-free broadcast', async () => {
		const services = workbenchInstantiationService(undefined, store);
		let nextId = 1;
		services.stub(ITerminalInstanceService, {
			createInstance: (cfg: IShellLaunchConfig) => createFakeInstance(nextId++, cfg, store),
		});
		services.stub(ITerminalConfigurationService, {
			config: { enableBell: false } as unknown as ITerminalConfigurationService['config'],
			getFont: () => ({ charWidth: 8, charHeight: 16 } as ReturnType<ITerminalConfigurationService['getFont']>),
		});
		services.stub(IWorkbenchLayoutService, {
			getPanelPosition: () => Position.BOTTOM,
			getSideBarPosition: () => Position.LEFT,
			resizePart: () => { },
		});
		services.stub(IViewDescriptorService, {
			getViewLocationById: () => ViewContainerLocation.Panel,
		});
		services.stub(IPaneCompositePartService, {
			getPartId: () => Parts.PANEL_PART,
		});

		const hostEl = document.createElement('div');
		hostEl.style.width = '800px';
		hostEl.style.height = '400px';
		document.body.appendChild(hostEl);
		store.add({ dispose: () => hostEl.remove() });

		const first = createFakeInstance(nextId++, { name: 'Local · App' }, store);
		const group = store.add(services.createInstance(TerminalGroup, hostEl, first));
		group.layout(800, 400);

		// Single pane should not show grid header; full 400px height goes to terminal
		assert.strictEqual(first.lastLayout?.height, 400);

		// Split Right -> 1×2, then Split Down -> 2 rows
		const second = group.split({ name: 'bupt208 · srv', hostLabel: 'bupt208', isRemotePty: true }, 'right') as IFakeTerminalInstance;
		const third = group.split({ name: 'gpu-1 · train', hostLabel: 'gpu-1', isRemotePty: true }, 'down') as IFakeTerminalInstance;
		const fourth = group.split({ name: 'gpu-2 · eval', hostLabel: 'gpu-2', isRemotePty: true }, 'right') as IFakeTerminalInstance;
		assert.strictEqual(group.terminalInstances.length, 4);

		// Arrange cleanly as 2×2 matrix without disposing any live instance
		group.arrangeAsGrid(2, 2);
		group.layout(800, 400);
		assert.deepStrictEqual(group.gridDimensions, { rows: 2, cols: 2 });
		assert.ok(group.terminalInstances.every(inst => !inst.isDisposed));
		// With 24px per-pane headers, each 200px tall cell hands ~176px to xterm
		assert.strictEqual(first.lastLayout?.width, 400);
		assert.strictEqual(first.lastLayout?.height, 176);

		// Maximize and restore a single cell
		assert.strictEqual(group.toggleMaximizePane(second), true);
		assert.strictEqual(group.isPaneMaximized(second), true);
		assert.strictEqual(group.toggleMaximizePane(second), false);
		assert.strictEqual(group.isPaneMaximized(), false);

		// In-place host replacement keeps exact 2×2 grid & index
		const replacement = createFakeInstance(nextId++, { name: 'prod-3 · api', hostLabel: 'prod-3', isRemotePty: true }, store);
		group.replaceInstance(third, replacement);
		assert.strictEqual(group.terminalInstances[2], replacement);
		assert.deepStrictEqual(group.gridDimensions, { rows: 2, cols: 2 });

		// Broadcast input forwards live active keystrokes to siblings with ZERO echo loops
		group.setActiveInstanceByIndex(0);
		group.broadcastInput = true;
		first.fireInputData('uptime\r');
		await Promise.resolve();
		assert.deepStrictEqual(second.sentTexts, [{ text: 'uptime\r', shouldExecute: false }]);
		assert.deepStrictEqual(replacement.sentTexts, [{ text: 'uptime\r', shouldExecute: false }]);
		assert.deepStrictEqual(fourth.sentTexts, [{ text: 'uptime\r', shouldExecute: false }]);
		assert.strictEqual(first.sentTexts.length, 0);

		// Verify uneven 5-pane grid (3 + 2) computes exact rows=2, cols=3 (never over-counting column offsets)
		const fifth = group.split({ name: 'gpu-3 · logs', hostLabel: 'gpu-3', isRemotePty: true }, 'right') as IFakeTerminalInstance;
		group.arrangeAsGrid(2, 3);
		group.layout(900, 400);
		assert.strictEqual(group.terminalInstances.length, 5);
		assert.deepStrictEqual(group.gridDimensions, { rows: 2, cols: 3 });

		// Verify moving an instance to index 0 ('before') still registers it cleanly in the Grid
		group.moveInstance(fifth, 0, 'before');
		assert.strictEqual(group.terminalInstances[0], fifth);
		assert.strictEqual(group.toggleMaximizePane(fifth), true);
		assert.strictEqual(group.toggleMaximizePane(fifth), false);

		// One-shot broadcastText delivers to every pane once
		await group.broadcastText('nvidia-smi', true);
		assert.strictEqual(first.sentTexts.length, 1);
		assert.strictEqual(first.sentTexts[0].text, 'nvidia-smi');
		assert.strictEqual(second.sentTexts.length, 2);
		assert.strictEqual(fifth.sentTexts.length, 1);
	});

	test('TerminalGridLayoutService persists custom presets, merges settings layouts, and builds multi-host cloud grids', async () => {
		const services = workbenchInstantiationService(undefined, store);
		const workspace = new Workspace('grid', [new WorkspaceFolder({ uri: URI.file('/projects/Aexus'), name: 'Aexus', index: 0 })]);
		services.stub(IWorkspaceContextService, { getWorkspace: () => workspace, onDidChangeWorkspaceFolders: Event.None });

		const mockHosts: IAdeCloudHost[] = [
			{ id: 'h1', name: 'BUPT 208', alias: 'bupt208', hostName: '10.0.0.1', user: 'djf', port: 22, os: 'linux', defaultDirectory: '/home/djf/work', recentDirectories: [], createdAt: 1, updatedAt: 1, source: 'user' },
			{ id: 'h2', name: 'GPU Node 2', alias: 'gpu-node2', hostName: '10.0.0.2', user: 'djf', port: 22, os: 'linux', defaultDirectory: '/srv/models', recentDirectories: [], createdAt: 1, updatedAt: 1, source: 'user' },
		];
		services.stub(IAdeCloudHostBackendService, {
			onDidChangeHosts: Event.None,
			listHosts: async () => mockHosts,
			getEffectiveSshConfigPath: async () => '/Users/test/.ssh/config',
		});

		const ide = store.add(services.createInstance(ProjectNavigationService));
		services.stub(IProjectNavigationService, ide);
		const ade = store.add(services.createInstance(AdeProjectsService));
		services.stub(IAdeProjectsService, ade);
		const projectTerminals = store.add(services.createInstance(ProjectTerminalService));
		services.stub(IProjectTerminalService, projectTerminals);

		const createdCalls: Array<{ config?: IShellLaunchConfig; location?: unknown }> = [];
		let nextId = 1;
		let activeGroup: TerminalGroup | undefined;
		const hostEl = document.createElement('div');
		hostEl.style.width = '900px';
		hostEl.style.height = '450px';
		document.body.appendChild(hostEl);
		store.add({ dispose: () => hostEl.remove() });

		services.stub(ITerminalInstanceService, {
			createInstance: (cfg: IShellLaunchConfig) => createFakeInstance(nextId++, cfg, store),
		});
		services.stub(ITerminalConfigurationService, {
			config: { enableBell: false } as unknown as ITerminalConfigurationService['config'],
			getFont: () => ({ charWidth: 8, charHeight: 16 } as ReturnType<ITerminalConfigurationService['getFont']>),
		});
		services.stub(IWorkbenchLayoutService, {
			getPanelPosition: () => Position.BOTTOM,
			getSideBarPosition: () => Position.LEFT,
			resizePart: () => { },
		});
		services.stub(IViewDescriptorService, {
			getViewLocationById: () => ViewContainerLocation.Panel,
		});
		services.stub(IPaneCompositePartService, {
			getPartId: () => Parts.PANEL_PART,
		});

		const groups: TerminalGroup[] = [];
		services.stub(ITerminalGroupService, {
			get activeGroup() { return activeGroup; },
			set activeGroup(g: TerminalGroup | undefined) { activeGroup = g; },
			get groups() { return groups; },
			getGroupForInstance: (inst: ITerminalInstance) => groups.find(g => g.terminalInstances.includes(inst)),
			showPanel: async () => { },
		});
		services.stub(ITerminalService, {
			createTerminal: async (opts?: ICreateTerminalOptions) => {
				const cfg = (opts?.config ?? {}) as IShellLaunchConfig;
				createdCalls.push({ config: cfg, location: opts?.location });
				if (opts?.location && typeof opts.location === 'object' && hasKey(opts.location as Record<string, unknown>, { parentTerminal: true })) {
					const parent = await (opts.location as { parentTerminal: ITerminalInstance }).parentTerminal;
					const g = groups.find(cand => cand.terminalInstances.includes(parent))!;
					return g.split(cfg, (opts.location as { splitDirection?: 'right' | 'down' }).splitDirection);
				}
				const inst = createFakeInstance(nextId++, cfg, store);
				const g = store.add(services.createInstance(TerminalGroup, hostEl, inst));
				g.layout(900, 450);
				groups.push(g);
				activeGroup = g;
				return inst;
			},
			setActiveInstance: () => { },
		});

		const cfgService = services.get(IConfigurationService) as TestConfigurationService;
		await cfgService.setUserConfiguration(TerminalSettingId.GridLayouts, [
			{ name: 'Settings 2x2', rows: 2, cols: 2, cells: [{ targetUri: 'aexus-ssh://bupt208/home/djf/work' }] },
		]);

		const gridService = store.add(services.createInstance(TerminalGridLayoutService));

		// Available targets include active + both Cloud Hosts + Local workspace project
		const targets = await gridService.getAvailableTargets();
		const cloudTargets = targets.filter(t => t.category === 'cloud');
		assert.deepStrictEqual(cloudTargets.map(t => t.host), ['bupt208', 'gpu-node2']);

		// Save + merge with settings.json presets + delete
		const saved = await gridService.saveLayout({
			name: 'Dual Cloud',
			rows: 1,
			cols: 2,
			cells: [
				{ targetUri: cloudTargets[0].uri!.toString(), label: 'bupt208' },
				{ targetUri: cloudTargets[1].uri!.toString(), label: 'gpu-node2' },
			],
		});
		assert.strictEqual(gridService.getSavedLayouts().length, 2);
		assert.ok(gridService.getSavedLayouts().some(l => l.name === 'Settings 2x2' && l.source === 'settings'));

		// Apply All Cloud Hosts Grid spawns one SSH terminal per cloud host into a 1×2 grid
		const cloudGroup = await gridService.applyAllCloudHostsGrid({ openInNewGroup: true });
		assert.ok(cloudGroup);
		assert.strictEqual(cloudGroup.terminalInstances.length, 2);
		assert.strictEqual(cloudGroup.terminalInstances[0].shellLaunchConfig.hostLabel, 'bupt208');
		assert.strictEqual(cloudGroup.terminalInstances[1].shellLaunchConfig.hostLabel, 'gpu-node2');

		// Capture and delete saved preset
		const captured = gridService.captureGroupAsLayout(cloudGroup, 'Captured');
		assert.strictEqual(captured.cells.length, 2);
		await gridService.deleteLayout(saved.id);
		assert.strictEqual(gridService.getSavedLayouts().length, 1);
		assert.ok(createdCalls.length >= 2);
		assert.strictEqual(TerminalLocation.Panel, TerminalLocation.Panel);

		// Verify TerminalGridConfiguratorPopover mounts, interacts with matrix cells, and disposes cleanly with zero leaks
		services.stub(ITerminalGridLayoutService, gridService);
		const anchor = document.createElement('button');
		document.body.appendChild(anchor);
		store.add({ dispose: () => anchor.remove() });
		let closed = false;
		const popover = store.add(services.createInstance(TerminalGridConfiguratorPopover, anchor, () => { closed = true; }));
		// Flush async _loadTargets()
		await new Promise(resolve => setTimeout(resolve, 0));
		const matrixBtns = document.querySelectorAll<HTMLButtonElement>('.terminal-grid-matrix-cell');
		assert.strictEqual(matrixBtns.length, 16);
		// Click 2x3 matrix cell (row 2, col 3 -> index 6)
		matrixBtns[6].click();
		const cellSelects = document.querySelectorAll<HTMLSelectElement>('.terminal-grid-cell-select');
		assert.strictEqual(cellSelects.length, 6);
		popover.close();
		assert.strictEqual(closed, true);
		assert.strictEqual(document.querySelector('.terminal-grid-config-overlay'), null);
	});
});
