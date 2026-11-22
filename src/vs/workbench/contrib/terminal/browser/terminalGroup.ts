/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TERMINAL_VIEW_ID, TerminalCommandId } from '../common/terminal.js';
import { Emitter } from '../../../../base/common/event.js';
import { IDisposable, Disposable, DisposableStore, dispose, toDisposable } from '../../../../base/common/lifecycle.js';
import { Orientation } from '../../../../base/browser/ui/splitview/splitview.js';
import { Direction as GridDirection, Grid, isGridBranchNode, IView as IGridView, Sizing as GridSizing } from '../../../../base/browser/ui/grid/grid.js';
import { isHorizontal, IWorkbenchLayoutService, Position } from '../../../services/layout/browser/layoutService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalInstance, Direction, ITerminalGroup, ITerminalInstanceService, ITerminalConfigurationService } from './terminal.js';
import { ViewContainerLocation, IViewDescriptorService } from '../../../common/views.js';
import { IShellLaunchConfig, ITerminalTabLayoutInfoById, TerminalLocation, TerminalSettingId, TerminalSplitDirection } from '../../../../platform/terminal/common/terminal.js';
import { TerminalStatus } from './terminalStatusList.js';
import * as dom from '../../../../base/browser/dom.js';
import { getWindow } from '../../../../base/browser/dom.js';
import { asArray } from '../../../../base/common/arrays.js';
import { hasKey, isNumber, type SingleOrMany } from '../../../../base/common/types.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { getTerminalOsTooltip, renderTerminalOsIcon, resolveTerminalOsIconKind } from './terminalOsIcon.js';

const enum Constants {
	/**
	 * The minimum width in pixels of a split pane.
	 */
	SplitPaneMinWidth = 100,
	/**
	 * The minimum height in pixels of a split pane.
	 */
	SplitPaneMinHeight = 68,
	/**
	 * The compact header height in pixels when 2+ panes are displayed in a grid.
	 */
	PaneHeaderHeight = 24,
	/**
	 * The number of cells the terminal gets added or removed when asked to increase or decrease
	 * the view size.
	 */
	ResizePartCellCount = 4
}

function toGridDirection(dir: TerminalSplitDirection | Direction): GridDirection {
	switch (dir) {
		case 'left':
		case Direction.Left:
			return GridDirection.Left;
		case 'right':
		case Direction.Right:
			return GridDirection.Right;
		case 'up':
		case Direction.Up:
			return GridDirection.Up;
		case 'down':
		case Direction.Down:
			return GridDirection.Down;
	}
}

interface ISplitPaneCallbacks {
	readonly onSwitchHost: (instance: ITerminalInstance) => void;
	readonly onSplit: (instance: ITerminalInstance, direction: TerminalSplitDirection) => void;
	readonly onToggleMaximize: (instance: ITerminalInstance) => void;
	readonly onClose: (instance: ITerminalInstance) => void;
	readonly onFocus: (instance: ITerminalInstance) => void;
}

class SplitPane extends Disposable implements IGridView {
	readonly minimumWidth: number = Constants.SplitPaneMinWidth;
	readonly maximumWidth: number = Number.MAX_VALUE;
	readonly minimumHeight: number = Constants.SplitPaneMinHeight;
	readonly maximumHeight: number = Number.MAX_VALUE;

	private readonly _onDidChange = this._register(new Emitter<{ width: number; height: number } | undefined>());
	readonly onDidChange = this._onDidChange.event;

	readonly element: HTMLElement;
	private readonly _headerElement: HTMLElement;
	private readonly _hostButton: HTMLButtonElement;
	private readonly _iconContainer: HTMLElement;
	private readonly _titleLabel: HTMLElement;
	private readonly _maximizeButton: HTMLButtonElement;
	private readonly _bodyElement: HTMLElement;

	private _showHeader = false;
	private _isActive = false;
	private _isMaximized = false;
	private _lastWidth = 0;
	private _lastHeight = 0;
	private _pendingLayout = false;
	private readonly _instanceDisposables = this._register(new DisposableStore());

	constructor(
		public instance: ITerminalInstance,
		private readonly _callbacks: ISplitPaneCallbacks,
	) {
		super();
		this.element = dom.$('.terminal-split-pane');
		this._headerElement = dom.append(this.element, dom.$('.terminal-grid-pane-header'));

		this._hostButton = dom.append(this._headerElement, dom.$('button.terminal-grid-pane-host', {
			type: 'button',
			title: localize('terminalGridSwitchPaneHostTooltip', "Switch Host or Project for this Pane"),
		})) as HTMLButtonElement;
		this._iconContainer = dom.append(this._hostButton, dom.$('span.terminal-grid-pane-os-icon'));
		this._titleLabel = dom.append(this._hostButton, dom.$('span.terminal-grid-pane-title'));
		dom.append(this._hostButton, dom.$('span.terminal-grid-pane-chevron' + ThemeIcon.asCSSSelector(Codicon.chevronDown)));

		const actions = dom.append(this._headerElement, dom.$('.terminal-grid-pane-actions'));
		const splitRightBtn = this._createHeaderButton(actions, Codicon.splitHorizontal, localize('terminalGridSplitRightBtn', "Split Pane Right"), () => {
			this._callbacks.onSplit(this.instance, 'right');
		});
		const splitDownBtn = this._createHeaderButton(actions, Codicon.splitVertical, localize('terminalGridSplitDownBtn', "Split Pane Down"), () => {
			this._callbacks.onSplit(this.instance, 'down');
		});
		this._maximizeButton = this._createHeaderButton(actions, Codicon.screenFull, localize('terminalGridMaximizeBtn', "Maximize / Restore Pane"), () => {
			this._callbacks.onToggleMaximize(this.instance);
		});
		const closeBtn = this._createHeaderButton(actions, Codicon.close, localize('terminalGridClosePaneBtn', "Close Pane"), () => {
			this._callbacks.onClose(this.instance);
		});
		void splitRightBtn;
		void splitDownBtn;
		void closeBtn;

		this._bodyElement = dom.append(this.element, dom.$('.terminal-grid-pane-body'));

		this._register(dom.addDisposableListener(this._hostButton, dom.EventType.CLICK, e => {
			e.stopPropagation();
			this._callbacks.onFocus(this.instance);
			this._callbacks.onSwitchHost(this.instance);
		}));
		this._register(dom.addDisposableListener(this._headerElement, dom.EventType.MOUSE_DOWN, () => {
			this._callbacks.onFocus(this.instance);
		}));
		this._register(dom.addDisposableListener(this._headerElement, dom.EventType.DBLCLICK, e => {
			if ((e.target as HTMLElement)?.closest('button')) {
				return;
			}
			this._callbacks.onToggleMaximize(this.instance);
		}));

		this._bindInstance(instance);
	}

	private _createHeaderButton(container: HTMLElement, icon: ThemeIcon, title: string, onClick: () => void): HTMLButtonElement {
		const btn = dom.append(container, dom.$('button.terminal-grid-pane-action', {
			type: 'button',
			title,
			'aria-label': title,
		})) as HTMLButtonElement;
		dom.append(btn, dom.$(`span${ThemeIcon.asCSSSelector(icon)}`));
		this._register(dom.addDisposableListener(btn, dom.EventType.CLICK, e => {
			e.stopPropagation();
			onClick();
		}));
		return btn;
	}

	private _bindInstance(instance: ITerminalInstance): void {
		this._instanceDisposables.clear();
		this.instance = instance;
		instance.attachToElement(this._bodyElement);
		this._refreshHeader();
		this._instanceDisposables.add(instance.onTitleChanged(() => this._refreshHeader()));
		this._instanceDisposables.add(instance.onIconChanged(() => this._refreshHeader()));
	}

	replaceInstance(newInstance: ITerminalInstance): void {
		this.instance.detachFromElement();
		this._bindInstance(newInstance);
		if (this._lastWidth > 0 && this._lastHeight > 0) {
			this.layout(this._lastWidth, this._lastHeight);
		}
	}

	private _refreshHeader(): void {
		const osKind = resolveTerminalOsIconKind(this.instance);
		renderTerminalOsIcon(this._iconContainer, osKind, getTerminalOsTooltip(this.instance, osKind));
		const hostLabel = this.instance.shellLaunchConfig.hostLabel;
		const title = this.instance.title || this.instance.shellLaunchConfig.name || localize('terminalGridUntitledPane', "Terminal");
		const display = hostLabel && !title.toLowerCase().includes(hostLabel.toLowerCase())
			? `${hostLabel} · ${title}`
			: title;
		this._titleLabel.textContent = display;
		this._hostButton.title = localize('terminalGridSwitchPaneHostWithCurrent', "{0} — Click to switch Host or Project", display);
	}

	setShowHeader(show: boolean): void {
		if (this._showHeader === show) {
			return;
		}
		this._showHeader = show;
		this.element.classList.toggle('has-grid-header', show);
		if (this._lastWidth > 0 && this._lastHeight > 0) {
			this.layout(this._lastWidth, this._lastHeight);
		}
	}

	setActive(active: boolean): void {
		this._isActive = active;
		this.element.classList.toggle('is-active-pane', active);
	}

	get isActive(): boolean {
		return this._isActive;
	}

	setMaximized(maximized: boolean): void {
		if (this._isMaximized === maximized) {
			return;
		}
		this._isMaximized = maximized;
		this.element.classList.toggle('is-maximized-pane', maximized);
		dom.reset(this._maximizeButton, dom.$(`span${ThemeIcon.asCSSSelector(maximized ? Codicon.screenNormal : Codicon.screenFull)}`));
		const label = maximized
			? localize('terminalGridRestorePaneBtn', "Restore Grid Layout")
			: localize('terminalGridMaximizePaneBtn', "Maximize Pane");
		this._maximizeButton.title = label;
		this._maximizeButton.setAttribute('aria-label', label);
	}

	layout(width: number, height: number): void {
		this._lastWidth = width;
		this._lastHeight = height;
		if (!width || !height) {
			return;
		}
		if (this.instance.disableLayout) {
			this._pendingLayout = true;
			return;
		}
		this._pendingLayout = false;
		const headerOffset = this._showHeader ? Constants.PaneHeaderHeight : 0;
		const bodyHeight = Math.max(32, height - headerOffset);
		this.instance.layout({ width, height: bodyHeight });
	}

	flushLayout(): void {
		if (this._pendingLayout && this._lastWidth > 0 && this._lastHeight > 0 && !this.instance.disableLayout) {
			this.layout(this._lastWidth, this._lastHeight);
		}
	}
}

class SplitPaneContainer extends Disposable {
	private _height: number;
	private _width: number;
	private _grid: Grid<SplitPane> | undefined;
	private readonly _gridDisposables = this._register(new DisposableStore());
	private _children: SplitPane[] = [];
	private _terminalToPane: Map<ITerminalInstance, SplitPane> = new Map();
	private _rows = 1;
	private _cols = 1;
	private _showHeadersSetting = true;
	private _activeInstance: ITerminalInstance | undefined;

	private readonly _onDidChangeMaximized = this._register(new Emitter<boolean>());
	readonly onDidChangeMaximized = this._onDidChangeMaximized.event;

	get gridDimensions(): { readonly rows: number; readonly cols: number } {
		return { rows: this._rows, cols: this._cols };
	}

	constructor(
		private _container: HTMLElement,
		public orientation: Orientation,
		private readonly _callbacks: ISplitPaneCallbacks,
		showHeaders: boolean,
	) {
		super();
		this._showHeadersSetting = showHeaders;
		this._width = this._container.offsetWidth;
		this._height = this._container.offsetHeight;
	}

	setShowHeadersSetting(show: boolean): void {
		if (this._showHeadersSetting === show) {
			return;
		}
		this._showHeadersSetting = show;
		this._updateHeaderVisibility();
		this._relayout();
	}

	setActiveInstance(instance: ITerminalInstance | undefined): void {
		this._activeInstance = instance;
		for (const child of this._children) {
			child.setActive(child.instance === instance);
		}
	}

	setBroadcastVisual(enabled: boolean): void {
		this._container.classList.toggle('terminal-group-broadcasting', enabled && this._children.length > 1);
	}

	private _createGrid(initialPane: SplitPane): void {
		this._gridDisposables.clear();
		this._grid = new Grid<SplitPane>(initialPane, { proportionalLayout: true });
		this._gridDisposables.add(this._grid);
		this._gridDisposables.add(this._grid.onDidChangeViewMaximized(maximized => {
			this._syncMaximizedVisuals();
			this._onDidChangeMaximized.fire(maximized);
		}));
		this._container.appendChild(this._grid.element);
		if (this._width > 0 && this._height > 0) {
			this._grid.layout(this._width, this._height);
		}
	}

	private _syncMaximizedVisuals(): void {
		if (!this._grid) {
			return;
		}
		const hasMax = this._grid.hasMaximizedView();
		for (const child of this._children) {
			child.setMaximized(hasMax && this._grid.isViewMaximized(child));
		}
	}

	private _updateHeaderVisibility(): void {
		const show = this._showHeadersSetting && this._children.length > 1;
		for (const child of this._children) {
			child.setShowHeader(show);
			child.setActive(child.instance === this._activeInstance);
		}
		this._container.classList.toggle('terminal-group-is-grid', this._children.length > 1);
		if (this._children.length <= 1) {
			this._container.classList.remove('terminal-group-broadcasting');
		}
	}

	private _relayout(): void {
		if (this._grid && this._width > 0 && this._height > 0) {
			this._grid.layout(this._width, this._height);
		}
		for (const child of this._children) {
			child.flushLayout();
		}
	}

	private _recomputeDimensions(): void {
		const count = this._children.length;
		if (count <= 1) {
			this._rows = 1;
			this._cols = 1;
			return;
		}
		if (!this._grid || this._width <= 0 || this._height <= 0) {
			if (this.orientation === Orientation.HORIZONTAL) {
				this._rows = 1;
				this._cols = count;
			} else {
				this._rows = count;
				this._cols = 1;
			}
			return;
		}
		const root = this._grid.getViews();
		const rowCounts = new Map<number, number>();
		const walk = (node: ReturnType<Grid<SplitPane>['getViews']> | { readonly view: SplitPane; readonly box: { top: number; left: number; width: number; height: number }; readonly cachedVisibleSize: number | undefined; readonly maximized: boolean }) => {
			if (isGridBranchNode(node)) {
				for (const child of node.children) {
					walk(child);
				}
			} else {
				const rowBucket = Math.round(node.box.top / 8);
				rowCounts.set(rowBucket, (rowCounts.get(rowBucket) ?? 0) + 1);
			}
		};
		walk(root);
		this._rows = Math.max(1, rowCounts.size);
		this._cols = Math.max(1, ...rowCounts.values());
	}

	split(instance: ITerminalInstance, index: number, referenceInstance?: ITerminalInstance, splitDirection?: TerminalSplitDirection): void {
		const child = new SplitPane(instance, this._callbacks);
		const insertIndex = isNumber(index) ? Math.max(0, Math.min(index, this._children.length)) : this._children.length;
		this._children.splice(insertIndex, 0, child);
		this._terminalToPane.set(instance, child);

		if (this._grid?.hasMaximizedView()) {
			this._grid.exitMaximizedView();
		}

		if (!this._grid) {
			this._withDisabledLayout(() => this._createGrid(child));
		} else {
			const explicitRef = referenceInstance && referenceInstance !== instance ? this._terminalToPane.get(referenceInstance) : undefined;
			const adjacentRef = insertIndex > 0 ? this._children[insertIndex - 1] : this._children[insertIndex + 1];
			const referencePane = explicitRef
				?? (adjacentRef && adjacentRef !== child ? adjacentRef : undefined)
				?? this._children.find(p => p !== child);
			const defaultDir: GridDirection = !explicitRef && insertIndex === 0
				? (this.orientation === Orientation.HORIZONTAL ? GridDirection.Left : GridDirection.Up)
				: (this.orientation === Orientation.HORIZONTAL ? GridDirection.Right : GridDirection.Down);
			const gridDir = splitDirection ? toGridDirection(splitDirection) : defaultDir;
			if (referencePane && referencePane !== child) {
				this._withDisabledLayout(() => this._grid!.addView(child, GridSizing.Distribute, referencePane, gridDir));
			}
		}

		this._updateHeaderVisibility();
		this._relayout();
		this._recomputeDimensions();
	}

	replaceInstance(oldInstance: ITerminalInstance, newInstance: ITerminalInstance): boolean {
		const pane = this._terminalToPane.get(oldInstance);
		if (!pane) {
			return false;
		}
		this._terminalToPane.delete(oldInstance);
		this._terminalToPane.set(newInstance, pane);
		pane.replaceInstance(newInstance);
		if (this._activeInstance === oldInstance) {
			this._activeInstance = newInstance;
			pane.setActive(true);
		}
		return true;
	}

	arrangeAsGrid(rows: number, cols: number): void {
		const count = this._children.length;
		if (count === 0) {
			this._rows = 1;
			this._cols = 1;
			return;
		}
		const targetCols = Math.max(1, Math.floor(cols));
		const targetRows = Math.max(1, Math.floor(rows));
		const panes = [...this._children];

		// Detach live SplitPane elements before disposing old grid so xterm canvases stay completely intact.
		for (const pane of panes) {
			pane.setMaximized(false);
			pane.element.remove();
		}
		this._gridDisposables.clear();
		this._grid = undefined;

		// Build a clean row-major 2D matrix: stack row anchors vertically, then append each row's columns to the right.
		const totalRows = Math.max(1, Math.min(count, Math.max(targetRows, Math.ceil(count / targetCols))));
		const rowBuckets: SplitPane[][] = [];
		let cursor = 0;
		for (let r = 0; r < totalRows && cursor < count; r++) {
			const remainingPanes = count - cursor;
			const remainingRows = totalRows - r;
			const cellsInRow = r < targetRows
				? Math.min(targetCols, remainingPanes - Math.max(0, remainingRows - 1))
				: Math.min(targetCols, remainingPanes);
			const actualCount = Math.max(1, cellsInRow);
			rowBuckets.push(panes.slice(cursor, cursor + actualCount));
			cursor += actualCount;
		}

		this._withDisabledLayout(() => {
			const firstPane = rowBuckets[0][0];
			this._createGrid(firstPane);
			const grid = this._grid!;
			// Stack subsequent row anchors downward first so every row spans full width.
			for (let r = 1; r < rowBuckets.length; r++) {
				grid.addView(rowBuckets[r][0], GridSizing.Distribute, rowBuckets[r - 1][0], GridDirection.Down);
			}
			// Populate columns within each row to the right.
			for (let r = 0; r < rowBuckets.length; r++) {
				const row = rowBuckets[r];
				for (let c = 1; c < row.length; c++) {
					grid.addView(row[c], GridSizing.Distribute, row[c - 1], GridDirection.Right);
				}
			}
			grid.distributeViewSizes();
		});

		this._rows = rowBuckets.length;
		this._cols = Math.max(...rowBuckets.map(r => r.length));
		this._updateHeaderVisibility();
		this._relayout();
	}

	equalizeGrid(): void {
		if (!this._grid || this._children.length <= 1) {
			return;
		}
		if (this._grid.hasMaximizedView()) {
			this._grid.exitMaximizedView();
		}
		this._grid.distributeViewSizes();
	}

	toggleMaximize(instance: ITerminalInstance): boolean {
		if (!this._grid || this._children.length <= 1) {
			return false;
		}
		const pane = this._terminalToPane.get(instance);
		if (!pane) {
			return false;
		}
		if (this._grid.isViewMaximized(pane)) {
			this._grid.exitMaximizedView();
			return false;
		}
		if (this._grid.hasMaximizedView()) {
			this._grid.exitMaximizedView();
		}
		this._grid.maximizeView(pane);
		return true;
	}

	isMaximized(instance?: ITerminalInstance): boolean {
		if (!this._grid) {
			return false;
		}
		if (!instance) {
			return this._grid.hasMaximizedView();
		}
		const pane = this._terminalToPane.get(instance);
		return pane ? this._grid.isViewMaximized(pane) : false;
	}

	getNeighborInstance(instance: ITerminalInstance, direction: Direction): ITerminalInstance | undefined {
		if (!this._grid || this._children.length <= 1 || this._width <= 0 || this._height <= 0) {
			return undefined;
		}
		const pane = this._terminalToPane.get(instance);
		if (!pane) {
			return undefined;
		}
		try {
			const neighbors = this._grid.getNeighborViews(pane, toGridDirection(direction), true);
			return neighbors[0]?.instance;
		} catch {
			return undefined;
		}
	}

	hasNeighborInDirection(instance: ITerminalInstance, direction: Direction): boolean {
		if (!this._grid || this._children.length <= 1 || this._width <= 0 || this._height <= 0) {
			return false;
		}
		const pane = this._terminalToPane.get(instance);
		if (!pane) {
			return false;
		}
		try {
			const forward = this._grid.getNeighborViews(pane, toGridDirection(direction), false);
			if (forward.length > 0) {
				return true;
			}
			const opp = direction === Direction.Left ? Direction.Right
				: direction === Direction.Right ? Direction.Left
					: direction === Direction.Up ? Direction.Down
						: Direction.Up;
			return this._grid.getNeighborViews(pane, toGridDirection(opp), false).length > 0;
		} catch {
			return false;
		}
	}

	resizePane(instance: ITerminalInstance, direction: Direction, amount: number): boolean {
		if (!this._grid || this._children.length <= 1) {
			return false;
		}
		const pane = this._terminalToPane.get(instance);
		if (!pane || !this.hasNeighborInDirection(instance, direction)) {
			return false;
		}
		const currentSize = this._grid.getViewSize(pane);
		const isHorizontalResize = direction === Direction.Left || direction === Direction.Right;
		if (isHorizontalResize) {
			const hasRightNeighbor = this._grid.getNeighborViews(pane, GridDirection.Right, false).length > 0;
			const delta = (hasRightNeighbor && direction === Direction.Left) || (!hasRightNeighbor && direction === Direction.Right) ? -amount : amount;
			const nextWidth = Math.max(Constants.SplitPaneMinWidth, currentSize.width + delta);
			this._grid.resizeView(pane, { width: nextWidth });
		} else {
			const hasDownNeighbor = this._grid.getNeighborViews(pane, GridDirection.Down, false).length > 0;
			const delta = (hasDownNeighbor && direction === Direction.Up) || (!hasDownNeighbor && direction === Direction.Down) ? -amount : amount;
			const nextHeight = Math.max(Constants.SplitPaneMinHeight, currentSize.height + delta);
			this._grid.resizeView(pane, { height: nextHeight });
		}
		return true;
	}

	resizePanes(relativeSizes: number[]): void {
		if (!this._grid || this._children.length <= 1 || this._rows > 1) {
			return;
		}
		const totalSize = this.orientation === Orientation.HORIZONTAL ? this._width : this._height;
		if (totalSize <= 0) {
			return;
		}
		const normalized = [...relativeSizes];
		if (normalized.length > 0) {
			normalized[normalized.length - 1] += 1 - normalized.reduce((acc, v) => acc + v, 0);
		}
		for (let i = 0; i < Math.min(this._children.length, normalized.length); i++) {
			const target = Math.max(
				this.orientation === Orientation.HORIZONTAL ? Constants.SplitPaneMinWidth : Constants.SplitPaneMinHeight,
				totalSize * normalized[i],
			);
			this._grid.resizeView(
				this._children[i],
				this.orientation === Orientation.HORIZONTAL ? { width: target } : { height: target },
			);
		}
	}

	getPaneSize(instance: ITerminalInstance): number {
		const pane = this._terminalToPane.get(instance);
		if (!pane || !this._grid) {
			return 0;
		}
		const size = this._grid.getViewSize(pane);
		return this.orientation === Orientation.HORIZONTAL ? size.width : size.height;
	}

	remove(instance: ITerminalInstance): void {
		const index = this._children.findIndex(c => c.instance === instance);
		if (index === -1) {
			return;
		}
		const [removed] = this._children.splice(index, 1);
		this._terminalToPane.delete(instance);
		if (this._grid) {
			if (this._grid.hasMaximizedView()) {
				this._grid.exitMaximizedView();
			}
			if (this._children.length === 0) {
				this._gridDisposables.clear();
				this._grid = undefined;
			} else {
				this._grid.removeView(removed, GridSizing.Distribute);
			}
		}
		instance.detachFromElement();
		removed.dispose();
		this._updateHeaderVisibility();
		this._relayout();
		this._recomputeDimensions();
	}

	layout(width: number, height: number): void {
		this._width = width;
		this._height = height;
		if (this._grid && width > 0 && height > 0) {
			this._grid.layout(width, height);
		}
	}

	setOrientation(orientation: Orientation): void {
		if (this.orientation === orientation) {
			return;
		}
		this.orientation = orientation;
		if (this._children.length <= 1) {
			return;
		}
		// Only rotate automatically if the user has a 1D split; preserve explicit 2D multi-row × multi-column layouts.
		if (this._rows === 1 || this._cols === 1) {
			if (orientation === Orientation.HORIZONTAL) {
				this.arrangeAsGrid(1, this._children.length);
			} else {
				this.arrangeAsGrid(this._children.length, 1);
			}
		}
	}

	private _withDisabledLayout(innerFunction: () => void): void {
		// Whenever manipulating views that are going to be changed immediately, disabling
		// layout/resize events in the terminal prevent bad dimensions going to the pty.
		this._children.forEach(c => c.instance.disableLayout = true);
		try {
			innerFunction();
		} finally {
			this._children.forEach(c => c.instance.disableLayout = false);
		}
	}

	override dispose(): void {
		for (const child of this._children) {
			child.dispose();
		}
		this._children = [];
		this._terminalToPane.clear();
		this._grid = undefined;
		super.dispose();
	}
}

export class TerminalGroup extends Disposable implements ITerminalGroup {
	private _terminalInstances: ITerminalInstance[] = [];
	private _splitPaneContainer: SplitPaneContainer | undefined;
	private _groupElement: HTMLElement | undefined;
	private _panelPosition: Position = Position.BOTTOM;
	private _terminalLocation: ViewContainerLocation = ViewContainerLocation.Panel;
	private _instanceDisposables: Map<number, IDisposable[]> = new Map();

	private _activeInstanceIndex: number = -1;
	private _broadcastInput = false;
	private readonly _broadcastSuppressedCount = new Map<number, number>();

	get terminalInstances(): ITerminalInstance[] { return this._terminalInstances; }

	get gridDimensions(): { readonly rows: number; readonly cols: number } {
		return this._splitPaneContainer?.gridDimensions ?? { rows: 1, cols: Math.max(1, this._terminalInstances.length) };
	}

	get broadcastInput(): boolean {
		return this._broadcastInput;
	}
	set broadcastInput(value: boolean) {
		const next = Boolean(value);
		if (this._broadcastInput === next) {
			return;
		}
		this._broadcastInput = next;
		this._splitPaneContainer?.setBroadcastVisual(next);
		this._onDidChangeBroadcastInput.fire(next);
	}

	private _hadFocusOnExit: boolean = false;
	get hadFocusOnExit(): boolean { return this._hadFocusOnExit; }

	private _initialRelativeSizes: number[] | undefined;
	private _visible: boolean = false;

	private readonly _onDidDisposeInstance: Emitter<ITerminalInstance> = this._register(new Emitter<ITerminalInstance>());
	readonly onDidDisposeInstance = this._onDidDisposeInstance.event;
	private readonly _onDidFocusInstance: Emitter<ITerminalInstance> = this._register(new Emitter<ITerminalInstance>());
	readonly onDidFocusInstance = this._onDidFocusInstance.event;
	private readonly _onDidChangeInstanceCapability: Emitter<ITerminalInstance> = this._register(new Emitter<ITerminalInstance>());
	readonly onDidChangeInstanceCapability = this._onDidChangeInstanceCapability.event;
	private readonly _onDisposed: Emitter<ITerminalGroup> = this._register(new Emitter<ITerminalGroup>());
	readonly onDisposed = this._onDisposed.event;
	private readonly _onInstancesChanged: Emitter<void> = this._register(new Emitter<void>());
	readonly onInstancesChanged = this._onInstancesChanged.event;
	private readonly _onDidChangeActiveInstance = this._register(new Emitter<ITerminalInstance | undefined>());
	readonly onDidChangeActiveInstance = this._onDidChangeActiveInstance.event;
	private readonly _onPanelOrientationChanged = this._register(new Emitter<Orientation>());
	readonly onPanelOrientationChanged = this._onPanelOrientationChanged.event;
	private readonly _onDidChangeBroadcastInput = this._register(new Emitter<boolean>());
	readonly onDidChangeBroadcastInput = this._onDidChangeBroadcastInput.event;
	private readonly _onDidChangePaneMaximized = this._register(new Emitter<boolean>());
	readonly onDidChangePaneMaximized = this._onDidChangePaneMaximized.event;

	constructor(
		private _container: HTMLElement | undefined,
		shellLaunchConfigOrInstance: IShellLaunchConfig | ITerminalInstance | undefined,
		@ITerminalConfigurationService private readonly _terminalConfigurationService: ITerminalConfigurationService,
		@ITerminalInstanceService private readonly _terminalInstanceService: ITerminalInstanceService,
		@IPaneCompositePartService private readonly _paneCompositePartService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IViewDescriptorService private readonly _viewDescriptorService: IViewDescriptorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		if (shellLaunchConfigOrInstance) {
			this.addInstance(shellLaunchConfigOrInstance);
		}
		if (this._container) {
			this.attachToElement(this._container);
		}
		this._onPanelOrientationChanged.fire(this._terminalLocation === ViewContainerLocation.Panel && isHorizontal(this._panelPosition) ? Orientation.HORIZONTAL : Orientation.VERTICAL);
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TerminalSettingId.ShowGridPaneHeaders)) {
				this._splitPaneContainer?.setShowHeadersSetting(this._readShowGridPaneHeaders());
			}
		}));
		this._register(toDisposable(() => {
			if (this._container && this._groupElement) {
				this._groupElement.remove();
				this._groupElement = undefined;
			}
		}));
	}

	private _readShowGridPaneHeaders(): boolean {
		return this._configurationService.getValue<boolean>(TerminalSettingId.ShowGridPaneHeaders) !== false;
	}

	addInstance(shellLaunchConfigOrInstance: IShellLaunchConfig | ITerminalInstance, parentTerminalId?: number, splitDirection?: TerminalSplitDirection): void {
		let instance: ITerminalInstance;
		// if a parent terminal is provided, find it
		// otherwise, parent is the active terminal
		const parentIndex = parentTerminalId !== undefined
			? this._terminalInstances.findIndex(t => t.instanceId === parentTerminalId)
			: this._activeInstanceIndex;
		const resolvedParentIndex = parentIndex >= 0 ? parentIndex : this._terminalInstances.length - 1;
		const referenceInstance = resolvedParentIndex >= 0 ? this._terminalInstances[resolvedParentIndex] : undefined;
		if (hasKey(shellLaunchConfigOrInstance, { instanceId: true })) {
			instance = shellLaunchConfigOrInstance;
		} else {
			instance = this._terminalInstanceService.createInstance(shellLaunchConfigOrInstance, TerminalLocation.Panel);
		}
		if (this._terminalInstances.length === 0) {
			this._terminalInstances.push(instance);
			this._activeInstanceIndex = 0;
		} else {
			this._terminalInstances.splice(resolvedParentIndex + 1, 0, instance);
		}
		this._initInstanceListeners(instance);

		if (this._splitPaneContainer) {
			this._splitPaneContainer.split(instance, resolvedParentIndex + 1, referenceInstance, splitDirection);
			this._splitPaneContainer.setActiveInstance(this.activeInstance);
			this._splitPaneContainer.setBroadcastVisual(this._broadcastInput);
		}

		this._onInstancesChanged.fire();
	}

	replaceInstance(oldInstance: ITerminalInstance, newInstance: ITerminalInstance): void {
		const index = this._terminalInstances.indexOf(oldInstance);
		if (index === -1) {
			return;
		}
		const oldDisposables = this._instanceDisposables.get(oldInstance.instanceId);
		if (oldDisposables) {
			dispose(oldDisposables);
			this._instanceDisposables.delete(oldInstance.instanceId);
		}
		this._terminalInstances[index] = newInstance;
		this._initInstanceListeners(newInstance);
		this._splitPaneContainer?.replaceInstance(oldInstance, newInstance);
		newInstance.setVisible(this._visible);
		this._splitPaneContainer?.setActiveInstance(this.activeInstance);
		this._onInstancesChanged.fire();
		if (index === this._activeInstanceIndex) {
			this._onDidChangeActiveInstance.fire(newInstance);
		}
	}

	arrangeAsGrid(rows: number, cols: number): void {
		this._splitPaneContainer?.arrangeAsGrid(rows, cols);
		this._splitPaneContainer?.setActiveInstance(this.activeInstance);
		this._splitPaneContainer?.setBroadcastVisual(this._broadcastInput);
		this._onInstancesChanged.fire();
	}

	equalizeGrid(): void {
		this._splitPaneContainer?.equalizeGrid();
	}

	toggleMaximizePane(instance?: ITerminalInstance): boolean {
		const target = instance ?? this.activeInstance;
		if (!target || !this._splitPaneContainer) {
			return false;
		}
		return this._splitPaneContainer.toggleMaximize(target);
	}

	isPaneMaximized(instance?: ITerminalInstance): boolean {
		return this._splitPaneContainer?.isMaximized(instance) ?? false;
	}

	focusPaneInDirection(direction: Direction): boolean {
		const active = this.activeInstance;
		if (!active || !this._splitPaneContainer) {
			return false;
		}
		const neighbor = this._splitPaneContainer.getNeighborInstance(active, direction);
		if (!neighbor) {
			return false;
		}
		const nextIndex = this._terminalInstances.indexOf(neighbor);
		if (nextIndex === -1) {
			return false;
		}
		this.setActiveInstanceByIndex(nextIndex);
		neighbor.focus(true);
		return true;
	}

	async broadcastText(text: string, shouldExecute = true): Promise<void> {
		const targets = this._terminalInstances.filter(inst => !inst.isDisposed);
		await Promise.all(targets.map(inst => {
			const prev = this._broadcastSuppressedCount.get(inst.instanceId) ?? 0;
			this._broadcastSuppressedCount.set(inst.instanceId, prev + 1);
			return inst.sendText(text, shouldExecute).finally(() => {
				const cur = (this._broadcastSuppressedCount.get(inst.instanceId) ?? 1) - 1;
				if (cur <= 0) {
					this._broadcastSuppressedCount.delete(inst.instanceId);
				} else {
					this._broadcastSuppressedCount.set(inst.instanceId, cur);
				}
			});
		}));
	}

	override dispose(): void {
		for (const disposables of this._instanceDisposables.values()) {
			dispose(disposables);
		}
		this._instanceDisposables.clear();
		this._terminalInstances = [];
		this._broadcastSuppressedCount.clear();
		this._onInstancesChanged.fire();
		this._splitPaneContainer?.dispose();
		super.dispose();
	}

	get activeInstance(): ITerminalInstance | undefined {
		if (this._terminalInstances.length === 0) {
			return undefined;
		}
		return this._terminalInstances[this._activeInstanceIndex];
	}

	getLayoutInfo(isActive: boolean): ITerminalTabLayoutInfoById {
		const instances = this.terminalInstances.filter(instance => isNumber(instance.persistentProcessId) && instance.shouldPersist);
		const totalSize = instances.map(t => this._splitPaneContainer?.getPaneSize(t) || 0).reduce((total, size) => total += size, 0);
		return {
			isActive: isActive,
			activePersistentProcessId: this.activeInstance ? this.activeInstance.persistentProcessId : undefined,
			terminals: instances.map(t => {
				return {
					relativeSize: totalSize > 0 ? this._splitPaneContainer!.getPaneSize(t) / totalSize : 0,
					terminal: t.persistentProcessId || 0
				};
			})
		};
	}

	private _initInstanceListeners(instance: ITerminalInstance) {
		this._instanceDisposables.set(instance.instanceId, [
			instance.onDisposed(disposedInstance => {
				this._onDidDisposeInstance.fire(disposedInstance);
				this._handleOnDidDisposeInstance(disposedInstance);
			}),
			instance.onDidFocus(focusedInstance => {
				this._setActiveInstance(focusedInstance);
				this._onDidFocusInstance.fire(focusedInstance);
			}),
			instance.onDidInputData(data => {
				this._handleBroadcastInput(instance, data);
			}),
			instance.capabilities.onDidChangeCapabilities(() => this._onDidChangeInstanceCapability.fire(instance)),
		]);
	}

	private _handleBroadcastInput(source: ITerminalInstance, data: string): void {
		if (!this._broadcastInput || this._terminalInstances.length <= 1) {
			return;
		}
		if (source !== this.activeInstance || (this._broadcastSuppressedCount.get(source.instanceId) ?? 0) > 0) {
			return;
		}
		for (const sibling of this._terminalInstances) {
			if (sibling === source || sibling.isDisposed) {
				continue;
			}
			const prev = this._broadcastSuppressedCount.get(sibling.instanceId) ?? 0;
			this._broadcastSuppressedCount.set(sibling.instanceId, prev + 1);
			void sibling.sendText(data, false).catch(() => undefined).finally(() => {
				const cur = (this._broadcastSuppressedCount.get(sibling.instanceId) ?? 1) - 1;
				if (cur <= 0) {
					this._broadcastSuppressedCount.delete(sibling.instanceId);
				} else {
					this._broadcastSuppressedCount.set(sibling.instanceId, cur);
				}
			});
		}
	}

	private _handleOnDidDisposeInstance(instance: ITerminalInstance) {
		this._removeInstance(instance);
	}

	removeInstance(instance: ITerminalInstance) {
		this._removeInstance(instance);
	}

	private _removeInstance(instance: ITerminalInstance) {
		const index = this._terminalInstances.indexOf(instance);
		if (index === -1) {
			return;
		}

		const wasActiveInstance = instance === this.activeInstance;
		this._terminalInstances.splice(index, 1);
		this._broadcastSuppressedCount.delete(instance.instanceId);

		// Adjust focus if the instance was active
		if (wasActiveInstance && this._terminalInstances.length > 0) {
			const newIndex = index < this._terminalInstances.length ? index : this._terminalInstances.length - 1;
			this.setActiveInstanceByIndex(newIndex);
			// TODO: Only focus the new instance if the group had focus?
			this.activeInstance?.focus(true);
		} else if (index < this._activeInstanceIndex) {
			// Adjust active instance index if needed
			this._activeInstanceIndex--;
		}

		this._splitPaneContainer?.remove(instance);
		this._splitPaneContainer?.setActiveInstance(this.activeInstance);

		if (this._terminalInstances.length <= 1 && this._broadcastInput) {
			this.broadcastInput = false;
		}

		// Fire events and dispose group if it was the last instance
		if (this._terminalInstances.length === 0) {
			this._hadFocusOnExit = instance.hadFocusOnExit;
			this._onDisposed.fire(this);
			this.dispose();
		} else {
			this._onInstancesChanged.fire();
		}

		// Dispose instance event listeners
		const disposables = this._instanceDisposables.get(instance.instanceId);
		if (disposables) {
			dispose(disposables);
			this._instanceDisposables.delete(instance.instanceId);
		}
	}

	moveInstance(instances: SingleOrMany<ITerminalInstance>, index: number, position: 'before' | 'after'): void {
		instances = asArray(instances);
		const hasInvalidInstance = instances.some(instance => !this.terminalInstances.includes(instance));
		if (hasInvalidInstance) {
			return;
		}
		const insertIndex = position === 'before' ? index : index + 1;
		this._terminalInstances.splice(insertIndex, 0, ...instances);
		for (const item of instances) {
			const originSourceGroupIndex = position === 'after' ? this._terminalInstances.indexOf(item) : this._terminalInstances.lastIndexOf(item);
			this._terminalInstances.splice(originSourceGroupIndex, 1);
		}
		if (this._splitPaneContainer) {
			const dims = this._splitPaneContainer.gridDimensions;
			for (const item of instances) {
				this._splitPaneContainer.remove(item);
			}
			for (let i = 0; i < instances.length; i++) {
				const item = instances[i];
				this._splitPaneContainer.split(item, index + (position === 'before' ? i : 0));
			}
			if (dims.rows > 1 && dims.cols > 1) {
				this._splitPaneContainer.arrangeAsGrid(dims.rows, dims.cols);
			}
		}
		this._onInstancesChanged.fire();
	}

	private _setActiveInstance(instance: ITerminalInstance) {
		this.setActiveInstanceByIndex(this._getIndexFromId(instance.instanceId));
	}

	private _getIndexFromId(terminalId: number): number {
		let terminalIndex = -1;
		this.terminalInstances.forEach((terminalInstance, i) => {
			if (terminalInstance.instanceId === terminalId) {
				terminalIndex = i;
			}
		});
		if (terminalIndex === -1) {
			throw new Error(`Terminal with ID ${terminalId} does not exist (has it already been disposed?)`);
		}
		return terminalIndex;
	}

	setActiveInstanceByIndex(index: number, force?: boolean): void {
		// Check for invalid value
		if (index < 0 || index >= this._terminalInstances.length) {
			return;
		}

		const oldActiveInstance = this.activeInstance;
		this._activeInstanceIndex = index;
		this._splitPaneContainer?.setActiveInstance(this.activeInstance);
		if (oldActiveInstance !== this.activeInstance || force) {
			this._onInstancesChanged.fire();
			this._onDidChangeActiveInstance.fire(this.activeInstance);
		}
	}

	attachToElement(element: HTMLElement): void {
		this._container = element;

		// If we already have a group element, we can reparent it
		if (!this._groupElement) {
			this._groupElement = document.createElement('div');
			this._groupElement.classList.add('terminal-group');
		}

		this._container.appendChild(this._groupElement);
		if (!this._splitPaneContainer) {
			this._panelPosition = this._layoutService.getPanelPosition();
			this._terminalLocation = this._viewDescriptorService.getViewLocationById(TERMINAL_VIEW_ID)!;
			const orientation = this._terminalLocation === ViewContainerLocation.Panel && isHorizontal(this._panelPosition) ? Orientation.HORIZONTAL : Orientation.VERTICAL;
			const callbacks: ISplitPaneCallbacks = {
				onSwitchHost: instance => {
					void this._commandService.executeCommand(TerminalCommandId.SwitchPaneHost, instance);
				},
				onSplit: (instance, direction) => {
					const cmdId = direction === 'down' ? TerminalCommandId.SplitDown : TerminalCommandId.SplitRight;
					void this._commandService.executeCommand(cmdId, { location: { parentTerminal: instance, splitDirection: direction } });
				},
				onToggleMaximize: instance => {
					this.toggleMaximizePane(instance);
				},
				onClose: instance => {
					instance.dispose();
				},
				onFocus: instance => {
					const idx = this._terminalInstances.indexOf(instance);
					if (idx !== -1) {
						this.setActiveInstanceByIndex(idx);
						instance.focus(true);
					}
				},
			};
			this._splitPaneContainer = this._instantiationService.createInstance(
				SplitPaneContainer,
				this._groupElement,
				orientation,
				callbacks,
				this._readShowGridPaneHeaders(),
			);
			this._register(this._splitPaneContainer.onDidChangeMaximized(max => this._onDidChangePaneMaximized.fire(max)));
			this.terminalInstances.forEach((instance, i) => {
				const prev = i > 0 ? this.terminalInstances[i - 1] : undefined;
				this._splitPaneContainer!.split(instance, i, prev);
			});
			this._splitPaneContainer.setActiveInstance(this.activeInstance);
			this._splitPaneContainer.setBroadcastVisual(this._broadcastInput);
		}
	}

	get title(): string {
		if (this._terminalInstances.length === 0) {
			// Normally consumers should not call into title at all after the group is disposed but
			// this is required when the group is used as part of a tree.
			return '';
		}
		let title = this.terminalInstances[0].title + this._getBellTitle(this.terminalInstances[0]);
		if (this.terminalInstances[0].description) {
			title += ` (${this.terminalInstances[0].description})`;
		}
		for (let i = 1; i < this.terminalInstances.length; i++) {
			const instance = this.terminalInstances[i];
			if (instance.title) {
				title += `, ${instance.title + this._getBellTitle(instance)}`;
				if (instance.description) {
					title += ` (${instance.description})`;
				}
			}
		}
		return title;
	}

	private _getBellTitle(instance: ITerminalInstance) {
		if (this._terminalConfigurationService.config.enableBell && instance.statusList.statuses.some(e => e.id === TerminalStatus.Bell)) {
			return '*';
		}
		return '';
	}

	setVisible(visible: boolean): void {
		this._visible = visible;
		if (this._groupElement) {
			this._groupElement.style.display = visible ? '' : 'none';
		}
		this.terminalInstances.forEach(i => i.setVisible(visible));
	}

	split(shellLaunchConfig: IShellLaunchConfig, direction?: TerminalSplitDirection): ITerminalInstance {
		const instance = this._terminalInstanceService.createInstance(shellLaunchConfig, TerminalLocation.Panel);
		this.addInstance(instance, shellLaunchConfig.parentTerminalId, direction ?? shellLaunchConfig.splitDirection);
		this._setActiveInstance(instance);
		return instance;
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}

	layout(width: number, height: number): void {
		if (this._splitPaneContainer) {
			// Check if the panel position changed and rotate 1D panes if so
			const newPanelPosition = this._layoutService.getPanelPosition();
			const newTerminalLocation = this._viewDescriptorService.getViewLocationById(TERMINAL_VIEW_ID)!;
			const terminalPositionChanged = newPanelPosition !== this._panelPosition || newTerminalLocation !== this._terminalLocation;
			if (terminalPositionChanged) {
				const newOrientation = newTerminalLocation === ViewContainerLocation.Panel && isHorizontal(newPanelPosition) ? Orientation.HORIZONTAL : Orientation.VERTICAL;
				this._splitPaneContainer.setOrientation(newOrientation);
				this._panelPosition = newPanelPosition;
				this._terminalLocation = newTerminalLocation;
				this._onPanelOrientationChanged.fire(this._splitPaneContainer.orientation);
			}
			this._splitPaneContainer.layout(width, height);
			if (this._initialRelativeSizes && this._visible) {
				this.resizePanes(this._initialRelativeSizes);
				this._initialRelativeSizes = undefined;
			}
		}
	}

	focusPreviousPane(): void {
		const newIndex = this._activeInstanceIndex === 0 ? this._terminalInstances.length - 1 : this._activeInstanceIndex - 1;
		this.setActiveInstanceByIndex(newIndex);
	}

	focusNextPane(): void {
		const newIndex = this._activeInstanceIndex === this._terminalInstances.length - 1 ? 0 : this._activeInstanceIndex + 1;
		this.setActiveInstanceByIndex(newIndex);
	}

	private _getPosition(): Position {
		switch (this._terminalLocation) {
			case ViewContainerLocation.Panel:
				return this._panelPosition;
			case ViewContainerLocation.Sidebar:
				return this._layoutService.getSideBarPosition();
			case ViewContainerLocation.AuxiliaryBar:
				return this._layoutService.getSideBarPosition() === Position.LEFT ? Position.RIGHT : Position.LEFT;
			default:
				return this._panelPosition;
		}
	}

	resizePane(direction: Direction): void {
		if (!this._splitPaneContainer) {
			return;
		}
		const active = this.activeInstance;
		const isHorizontalResize = (direction === Direction.Left || direction === Direction.Right);
		const font = this._terminalConfigurationService.getFont(getWindow(this._groupElement));
		const charSize = (isHorizontalResize ? font.charWidth : font.charHeight);
		if (!charSize) {
			return;
		}
		let resizeAmount = charSize * Constants.ResizePartCellCount;

		// Prefer resizing within the 2D grid whenever the active pane has a neighbor along this axis.
		if (active && this._splitPaneContainer.resizePane(active, direction, resizeAmount)) {
			return;
		}

		// Fall back to resizing the workbench part when at the outer boundary along this axis.
		const position = this._getPosition();
		const shouldShrink =
			(position === Position.LEFT && direction === Direction.Left) ||
			(position === Position.RIGHT && direction === Direction.Right) ||
			(position === Position.BOTTOM && direction === Direction.Down) ||
			(position === Position.TOP && direction === Direction.Up);

		if (shouldShrink) {
			resizeAmount *= -1;
		}

		this._layoutService.resizePart(this._paneCompositePartService.getPartId(this._terminalLocation), resizeAmount, resizeAmount);
	}

	resizePanes(relativeSizes: number[]): void {
		if (!this._splitPaneContainer) {
			this._initialRelativeSizes = relativeSizes;
			return;
		}

		this._splitPaneContainer.resizePanes(relativeSizes);
	}
}
