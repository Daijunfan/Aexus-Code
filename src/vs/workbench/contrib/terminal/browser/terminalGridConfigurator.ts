/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { renderAdeOsIcon } from '../../../browser/adeOsIcon.js';
import { TerminalCommandId } from '../common/terminal.js';
import { ITerminalGroupService } from './terminal.js';
import {
	clampGridDimensions,
	ITerminalGridCellConfig,
	ITerminalGridLayoutPreset,
	ITerminalGridLayoutService,
	ITerminalGridTargetOption,
	MAX_GRID_CELLS,
	MAX_GRID_COLS,
	MAX_GRID_ROWS,
	resizeGridCells,
} from './terminalGridLayoutService.js';

const $ = dom.$;

const QUICK_DIM_PRESETS: ReadonlyArray<{ readonly rows: number; readonly cols: number }> = [
	{ rows: 1, cols: 2 },
	{ rows: 2, cols: 1 },
	{ rows: 2, cols: 2 },
	{ rows: 2, cols: 3 },
	{ rows: 3, cols: 2 },
];

export class TerminalGridConfiguratorPopover extends Disposable {
	private readonly _overlay: HTMLElement;
	private readonly _card: HTMLElement;
	private readonly _contentDisposables = this._register(new DisposableStore());

	private _rows = 2;
	private _cols = 2;
	private _cells: ITerminalGridCellConfig[] = [];
	private _broadcastInput = false;
	private _hoverRows = 0;
	private _hoverCols = 0;
	private _targets: readonly ITerminalGridTargetOption[] = [];
	private _presets: readonly ITerminalGridLayoutPreset[] = [];
	private _isBusy = false;

	constructor(
		private readonly _anchorElement: HTMLElement | undefined,
		private readonly _onClose: () => void,
		@ITerminalGridLayoutService private readonly _gridService: ITerminalGridLayoutService,
		@ITerminalGroupService private readonly _terminalGroupService: ITerminalGroupService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();

		const activeGroup = this._terminalGroupService.activeGroup;
		if (activeGroup && activeGroup.terminalInstances.length > 1) {
			const captured = this._gridService.captureGroupAsLayout(activeGroup, '');
			this._rows = captured.rows;
			this._cols = captured.cols;
			this._cells = [...captured.cells];
			this._broadcastInput = Boolean(captured.broadcastInput);
		} else {
			this._rows = 2;
			this._cols = 2;
			this._cells = resizeGridCells([], 2, 2);
			this._broadcastInput = Boolean(activeGroup?.broadcastInput);
		}

		const targetWindow = _anchorElement ? dom.getWindow(_anchorElement) : dom.getActiveWindow();
		const doc = targetWindow.document;

		this._overlay = $('div.terminal-grid-config-overlay');
		this._card = dom.append(this._overlay, $('div.terminal-grid-config-popover', {
			role: 'dialog',
			'aria-label': localize('terminalGridConfigTitle', "Terminal Multi-Row / Multi-Column Grid"),
		}));
		doc.body.appendChild(this._overlay);

		this._register(dom.addDisposableListener(this._overlay, dom.EventType.MOUSE_DOWN, e => {
			if (e.target === this._overlay) {
				this.close();
			}
		}));
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.KEY_DOWN, e => {
			if (e.keyCode === KeyCode.Escape || e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.close();
			}
		}, true));
		this._register(this._gridService.onDidChangeLayouts(() => {
			this._presets = this._gridService.getSavedLayouts();
			this._render();
		}));

		this._presets = this._gridService.getSavedLayouts();
		this._render();
		this._positionCard(targetWindow);

		void this._loadTargets();
	}

	private async _loadTargets(): Promise<void> {
		try {
			this._targets = await this._gridService.getAvailableTargets();
		} catch {
			this._targets = [];
		}
		// If this is a brand-new single terminal, pre-populate cells with distinct Cloud Hosts if available for instant ergonomics.
		const activeGroup = this._terminalGroupService.activeGroup;
		if (!activeGroup || activeGroup.terminalInstances.length <= 1) {
			const cloudTargets = this._targets.filter(t => t.category === 'cloud');
			if (cloudTargets.length > 0 && this._cells.every(c => !c.targetUri || c.targetUri === 'active')) {
				const autoCells: ITerminalGridCellConfig[] = [];
				const total = this._rows * this._cols;
				for (let i = 0; i < total; i++) {
					const hostTarget = cloudTargets[i];
					autoCells.push(hostTarget?.uri
						? { targetUri: hostTarget.uri.toString(), label: hostTarget.host }
						: { targetUri: 'active' });
				}
				this._cells = autoCells;
			}
		}
		if (!this._store.isDisposed) {
			this._render();
			this._positionCard(dom.getWindow(this._overlay));
		}
	}

	private _positionCard(targetWindow: Window): void {
		const vw = targetWindow.innerWidth;
		const vh = targetWindow.innerHeight;
		const cardWidth = Math.min(460, vw - 24);
		this._card.style.width = `${cardWidth}px`;
		const rect = this._anchorElement?.getBoundingClientRect();
		const cardHeight = this._card.offsetHeight || 420;
		let left = rect ? rect.right - cardWidth : Math.round((vw - cardWidth) / 2);
		left = Math.max(12, Math.min(vw - cardWidth - 12, left));
		let top = rect ? rect.top - cardHeight - 8 : Math.round((vh - cardHeight) / 2);
		if (top < 16) {
			top = rect ? Math.min(vh - cardHeight - 12, rect.bottom + 8) : 16;
		}
		top = Math.max(12, Math.min(vh - Math.min(cardHeight, vh - 24) - 12, top));
		this._card.style.left = `${Math.round(left)}px`;
		this._card.style.top = `${Math.round(top)}px`;
	}

	private _setDimensions(rows: number, cols: number): void {
		const next = clampGridDimensions(rows, cols);
		this._rows = next.rows;
		this._cols = next.cols;
		this._cells = resizeGridCells(this._cells, this._rows, this._cols);
		this._render();
		this._positionCard(dom.getWindow(this._overlay));
	}

	private _fillCellsWithCloudHosts(): void {
		const cloudTargets = this._targets.filter(t => t.category === 'cloud');
		if (cloudTargets.length === 0) {
			return;
		}
		const total = this._rows * this._cols;
		const next: ITerminalGridCellConfig[] = [];
		for (let i = 0; i < total; i++) {
			const host = cloudTargets[i % cloudTargets.length];
			next.push({
				targetUri: host.uri?.toString() ?? 'active',
				label: host.host,
			});
		}
		this._cells = next;
		this._render();
	}

	private _render(): void {
		this._contentDisposables.clear();
		dom.clearNode(this._card);

		const activeGroup = this._terminalGroupService.activeGroup;
		const cloudTargets = this._targets.filter(t => t.category === 'cloud');

		// 1. Header bar
		const header = dom.append(this._card, $('.terminal-grid-config-header'));
		const titleWrap = dom.append(header, $('.terminal-grid-config-title-wrap'));
		dom.append(titleWrap, $(`span${ThemeIcon.asCSSSelector(Codicon.layout)}`));
		dom.append(titleWrap, $('span.terminal-grid-config-title', undefined, localize('terminalGridHeading', "Terminal Grid Matrix")));
		dom.append(titleWrap, $('span.terminal-grid-config-badge', undefined, `${this._rows} × ${this._cols} · ${this._rows * this._cols}`));

		const closeBtn = dom.append(header, $('button.terminal-grid-config-close', {
			type: 'button',
			title: localize('close', "Close"),
			'aria-label': localize('close', "Close"),
		})) as HTMLButtonElement;
		dom.append(closeBtn, $(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		this._contentDisposables.add(dom.addDisposableListener(closeBtn, dom.EventType.CLICK, () => this.close()));

		// 2. Quick Split & Broadcast bar
		const quickBar = dom.append(this._card, $('.terminal-grid-config-quickbar'));
		this._addQuickToolButton(quickBar, Codicon.splitHorizontal, localize('terminalGridQuickSplitRight', "Split Right"), () => {
			this.close();
			void this._commandService.executeCommand(TerminalCommandId.SplitRight);
		});
		this._addQuickToolButton(quickBar, Codicon.splitVertical, localize('terminalGridQuickSplitDown', "Split Down"), () => {
			this.close();
			void this._commandService.executeCommand(TerminalCommandId.SplitDown);
		});
		this._addQuickToolButton(quickBar, Codicon.layoutPanelCenter, localize('terminalGridQuickEqualize', "Equalize"), () => {
			activeGroup?.equalizeGrid?.();
			this.close();
		});
		const broadcastBtn = this._addQuickToolButton(
			quickBar,
			Codicon.broadcast,
			this._broadcastInput
				? localize('terminalGridBroadcastOn', "Sync Input: ON")
				: localize('terminalGridBroadcastOff', "Sync Input"),
			() => {
				this._broadcastInput = !this._broadcastInput;
				if (activeGroup && activeGroup.terminalInstances.length > 1) {
					activeGroup.broadcastInput = this._broadcastInput;
				}
				this._render();
			},
		);
		broadcastBtn.classList.toggle('is-active', this._broadcastInput);

		// 3. Matrix Dimension Picker (Visual 4x4 hover grid + Steppers + Quick Preset Pills)
		const dimSection = dom.append(this._card, $('.terminal-grid-config-section'));
		const dimHeader = dom.append(dimSection, $('.terminal-grid-config-section-head'));
		dom.append(dimHeader, $('span.terminal-grid-config-section-label', undefined, localize('terminalGridDimsLabel', "Rows × Columns")));
		const dimHint = dom.append(dimHeader, $('span.terminal-grid-config-section-hint', undefined,
			localize('terminalGridDimsMax', "Up to {0} panes", MAX_GRID_CELLS)));

		const dimRow = dom.append(dimSection, $('.terminal-grid-config-dim-row'));

		// Interactive 4x4 hover matrix
		const matrixWrap = dom.append(dimRow, $('.terminal-grid-matrix-picker'));
		const matrixCells: HTMLElement[] = [];
		const updateMatrixHighlight = () => {
			const rTarget = this._hoverRows || this._rows;
			const cTarget = this._hoverCols || this._cols;
			dimHint.textContent = `${rTarget} × ${cTarget} (${rTarget * cTarget})`;
			for (let r = 1; r <= 4; r++) {
				for (let c = 1; c <= 4; c++) {
					const el = matrixCells[(r - 1) * 4 + (c - 1)];
					const selected = r <= rTarget && c <= cTarget;
					el.classList.toggle('is-selected', selected);
					el.classList.toggle('is-hover', this._hoverRows > 0 && selected);
				}
			}
		};
		for (let r = 1; r <= 4; r++) {
			for (let c = 1; c <= 4; c++) {
				const cellBtn = dom.append(matrixWrap, $('button.terminal-grid-matrix-cell', {
					type: 'button',
					'aria-label': localize('terminalGridMatrixCellAria', "{0} rows by {1} columns", r, c),
				})) as HTMLButtonElement;
				matrixCells.push(cellBtn);
				this._contentDisposables.add(dom.addDisposableListener(cellBtn, dom.EventType.MOUSE_ENTER, () => {
					this._hoverRows = r;
					this._hoverCols = c;
					updateMatrixHighlight();
				}));
				this._contentDisposables.add(dom.addDisposableListener(cellBtn, dom.EventType.CLICK, () => {
					this._hoverRows = 0;
					this._hoverCols = 0;
					this._setDimensions(r, c);
				}));
			}
		}
		this._contentDisposables.add(dom.addDisposableListener(matrixWrap, dom.EventType.MOUSE_LEAVE, () => {
			this._hoverRows = 0;
			this._hoverCols = 0;
			updateMatrixHighlight();
		}));
		updateMatrixHighlight();

		// Right side: numeric steppers + quick presets
		const dimControls = dom.append(dimRow, $('.terminal-grid-dim-controls'));
		const steppers = dom.append(dimControls, $('.terminal-grid-steppers'));
		this._renderStepper(steppers, localize('terminalGridRows', "Rows"), this._rows, 1, MAX_GRID_ROWS, next => this._setDimensions(next, this._cols));
		this._renderStepper(steppers, localize('terminalGridCols', "Cols"), this._cols, 1, MAX_GRID_COLS, next => this._setDimensions(this._rows, next));

		const pills = dom.append(dimControls, $('.terminal-grid-preset-pills'));
		for (const preset of QUICK_DIM_PRESETS) {
			const pill = dom.append(pills, $('button.terminal-grid-pill', { type: 'button' }, `${preset.rows}×${preset.cols}`)) as HTMLButtonElement;
			pill.classList.toggle('is-selected', this._rows === preset.rows && this._cols === preset.cols);
			this._contentDisposables.add(dom.addDisposableListener(pill, dom.EventType.CLICK, () => {
				this._setDimensions(preset.rows, preset.cols);
			}));
		}
		if (cloudTargets.length > 0) {
			const allCloudBtn = dom.append(pills, $('button.terminal-grid-pill.is-cloud', {
				type: 'button',
				title: localize('terminalGridAllCloudHostsTooltip', "Open all {0} configured Cloud Hosts in one grid", cloudTargets.length),
			}, localize('terminalGridAllCloudHostsPill', "All Cloud ({0})", cloudTargets.length))) as HTMLButtonElement;
			this._contentDisposables.add(dom.addDisposableListener(allCloudBtn, dom.EventType.CLICK, () => {
				void this._runAction(async () => {
					await this._gridService.applyAllCloudHostsGrid({ openInNewGroup: false, broadcastInput: this._broadcastInput });
				});
			}));
		}

		// 4. Per-Cell Cloud Host / Project Assignment Preview Grid
		const cellsSection = dom.append(this._card, $('.terminal-grid-config-section'));
		const cellsHeader = dom.append(cellsSection, $('.terminal-grid-config-section-head'));
		dom.append(cellsHeader, $('span.terminal-grid-config-section-label', undefined, localize('terminalGridCellsLabel', "Pane Host Assignments")));
		if (cloudTargets.length > 0) {
			const autoFillBtn = dom.append(cellsHeader, $('button.terminal-grid-link-btn', { type: 'button' }, localize('terminalGridAutoFillCloud', "Auto-fill Cloud Hosts"))) as HTMLButtonElement;
			this._contentDisposables.add(dom.addDisposableListener(autoFillBtn, dom.EventType.CLICK, () => this._fillCellsWithCloudHosts()));
		}

		const cellGrid = dom.append(cellsSection, $('.terminal-grid-cells-editor'));
		cellGrid.style.gridTemplateColumns = `repeat(${this._cols}, minmax(0, 1fr))`;

		const totalCells = this._rows * this._cols;
		for (let i = 0; i < totalCells; i++) {
			const cell = this._cells[i] ?? { targetUri: 'active' };
			const selectedId = cell.targetUri || 'active';
			const matchedTarget = this._targets.find(t => t.id === selectedId) ?? this._targets[0];

			const cellCard = dom.append(cellGrid, $('.terminal-grid-cell-card'));
			const cellMeta = dom.append(cellCard, $('.terminal-grid-cell-card-head'));
			dom.append(cellMeta, $('span.terminal-grid-cell-index', undefined, `${i + 1}`));
			const osSlot = dom.append(cellMeta, $('span.terminal-grid-cell-os'));
			if (matchedTarget) {
				renderAdeOsIcon(osSlot, matchedTarget.osKind, { baseClass: 'terminal-os-icon', prefix: 'terminal-os' });
			}

			const select = dom.append(cellCard, $('select.terminal-grid-cell-select', {
				'aria-label': localize('terminalGridCellSelectAria', "Host or project for pane {0}", i + 1),
			})) as HTMLSelectElement;

			this._populateTargetSelect(select, selectedId);
			this._contentDisposables.add(dom.addDisposableListener(select, dom.EventType.CHANGE, () => {
				const val = select.value;
				const chosen = this._targets.find(t => t.id === val);
				this._cells[i] = {
					targetUri: val,
					...(chosen && chosen.category === 'cloud' ? { label: chosen.host } : {}),
				};
				if (chosen) {
					renderAdeOsIcon(osSlot, chosen.osKind, { baseClass: 'terminal-os-icon', prefix: 'terminal-os' });
				}
			}));
		}

		// 5. Primary Footer Actions
		const footer = dom.append(this._card, $('.terminal-grid-config-footer'));
		const applyBtn = dom.append(footer, $('button.terminal-grid-btn.primary', {
			type: 'button',
		}, localize('terminalGridApplyBtn', "Apply Grid"))) as HTMLButtonElement;
		applyBtn.disabled = this._isBusy;
		this._contentDisposables.add(dom.addDisposableListener(applyBtn, dom.EventType.CLICK, () => {
			void this._runAction(async () => {
				await this._gridService.applyGridLayout({
					rows: this._rows,
					cols: this._cols,
					cells: this._cells,
					broadcastInput: this._broadcastInput,
					openInNewGroup: false,
				});
			});
		}));

		const newTabBtn = dom.append(footer, $('button.terminal-grid-btn.secondary', {
			type: 'button',
		}, localize('terminalGridNewTabBtn', "New Grid Tab"))) as HTMLButtonElement;
		newTabBtn.disabled = this._isBusy;
		this._contentDisposables.add(dom.addDisposableListener(newTabBtn, dom.EventType.CLICK, () => {
			void this._runAction(async () => {
				await this._gridService.applyGridLayout({
					rows: this._rows,
					cols: this._cols,
					cells: this._cells,
					broadcastInput: this._broadcastInput,
					openInNewGroup: true,
				});
			});
		}));

		const saveBtn = dom.append(footer, $('button.terminal-grid-btn.ghost', {
			type: 'button',
			title: localize('terminalGridSavePresetTooltip', "Save this grid layout as a reusable preset"),
		}, localize('terminalGridSavePresetBtn', "Save…"))) as HTMLButtonElement;
		saveBtn.disabled = this._isBusy;
		this._contentDisposables.add(dom.addDisposableListener(saveBtn, dom.EventType.CLICK, () => {
			void this._promptSavePreset();
		}));

		// 6. Saved Custom Presets (if any)
		if (this._presets.length > 0) {
			const presetsSection = dom.append(this._card, $('.terminal-grid-config-section.terminal-grid-saved-section'));
			const presetsHead = dom.append(presetsSection, $('.terminal-grid-config-section-head'));
			dom.append(presetsHead, $('span.terminal-grid-config-section-label', undefined, localize('terminalGridSavedLayoutsLabel', "Saved Layouts")));
			const list = dom.append(presetsSection, $('.terminal-grid-saved-list'));
			for (const preset of this._presets) {
				const row = dom.append(list, $('.terminal-grid-saved-row'));
				const info = dom.append(row, $('.terminal-grid-saved-info'));
				dom.append(info, $('span.terminal-grid-saved-name', undefined, preset.name));
				dom.append(info, $('span.terminal-grid-saved-dims', undefined, `${preset.rows}×${preset.cols}`));
				const rowActions = dom.append(row, $('.terminal-grid-saved-actions'));
				const loadBtn = dom.append(rowActions, $('button.terminal-grid-saved-action', {
					type: 'button',
					title: localize('terminalGridLoadIntoEditor', "Apply layout"),
				}, localize('terminalGridApplyShort', "Apply"))) as HTMLButtonElement;
				this._contentDisposables.add(dom.addDisposableListener(loadBtn, dom.EventType.CLICK, () => {
					void this._runAction(async () => {
						await this._gridService.applyGridLayout({
							rows: preset.rows,
							cols: preset.cols,
							cells: preset.cells,
							broadcastInput: preset.broadcastInput,
							openInNewGroup: false,
						});
					});
				}));
				const tabBtn = dom.append(rowActions, $('button.terminal-grid-saved-icon-btn', {
					type: 'button',
					title: localize('terminalGridOpenNewTabShort', "Open in New Grid Tab"),
				})) as HTMLButtonElement;
				dom.append(tabBtn, $(`span${ThemeIcon.asCSSSelector(Codicon.add)}`));
				this._contentDisposables.add(dom.addDisposableListener(tabBtn, dom.EventType.CLICK, () => {
					void this._runAction(async () => {
						await this._gridService.applyGridLayout({
							rows: preset.rows,
							cols: preset.cols,
							cells: preset.cells,
							broadcastInput: preset.broadcastInput,
							openInNewGroup: true,
						});
					});
				}));
				if (preset.source !== 'settings') {
					const delBtn = dom.append(rowActions, $('button.terminal-grid-saved-icon-btn.danger', {
						type: 'button',
						title: localize('terminalGridDeletePreset', "Delete preset"),
					})) as HTMLButtonElement;
					dom.append(delBtn, $(`span${ThemeIcon.asCSSSelector(Codicon.trash)}`));
					this._contentDisposables.add(dom.addDisposableListener(delBtn, dom.EventType.CLICK, () => {
						void this._gridService.deleteLayout(preset.id);
					}));
				}
			}
		}
	}

	private _addQuickToolButton(container: HTMLElement, icon: ThemeIcon, label: string, onClick: () => void): HTMLButtonElement {
		const btn = dom.append(container, $('button.terminal-grid-quick-btn', { type: 'button' })) as HTMLButtonElement;
		dom.append(btn, $(`span${ThemeIcon.asCSSSelector(icon)}`));
		dom.append(btn, $('span', undefined, label));
		this._contentDisposables.add(dom.addDisposableListener(btn, dom.EventType.CLICK, onClick));
		return btn;
	}

	private _renderStepper(container: HTMLElement, label: string, value: number, min: number, max: number, onChange: (next: number) => void): void {
		const wrap = dom.append(container, $('.terminal-grid-stepper'));
		dom.append(wrap, $('span.terminal-grid-stepper-label', undefined, label));
		const dec = dom.append(wrap, $('button.terminal-grid-stepper-btn', { type: 'button', 'aria-label': `Decrease ${label}` }, '−')) as HTMLButtonElement;
		dec.disabled = value <= min;
		dom.append(wrap, $('span.terminal-grid-stepper-val', undefined, String(value)));
		const inc = dom.append(wrap, $('button.terminal-grid-stepper-btn', { type: 'button', 'aria-label': `Increase ${label}` }, '+')) as HTMLButtonElement;
		inc.disabled = value >= max;
		this._contentDisposables.add(dom.addDisposableListener(dec, dom.EventType.CLICK, () => onChange(value - 1)));
		this._contentDisposables.add(dom.addDisposableListener(inc, dom.EventType.CLICK, () => onChange(value + 1)));
	}

	private _populateTargetSelect(select: HTMLSelectElement, selectedId: string): void {
		const groups: Array<{ readonly label: string; readonly items: ITerminalGridTargetOption[] }> = [
			{ label: localize('terminalGridGroupDefault', "Default"), items: this._targets.filter(t => t.category === 'active') },
			{ label: localize('terminalGridGroupCloud', "Cloud Hosts (SSH)"), items: this._targets.filter(t => t.category === 'cloud') },
			{ label: localize('terminalGridGroupProjects', "Projects"), items: this._targets.filter(t => t.category === 'project') },
			{ label: localize('terminalGridGroupSsh', "Saved SSH"), items: this._targets.filter(t => t.category === 'ssh') },
		];
		let matched = false;
		for (const group of groups) {
			if (group.items.length === 0) {
				continue;
			}
			const optgroup = dom.append(select, $('optgroup', { label: group.label }));
			for (const item of group.items) {
				const opt = dom.append(optgroup, $('option', { value: item.id }, item.label)) as HTMLOptionElement;
				if (item.id === selectedId) {
					opt.selected = true;
					matched = true;
				}
			}
		}
		if (!matched) {
			const fallbackLabel = selectedId === 'active'
				? localize('terminalGridActiveDefault', "Active Project / Current")
				: selectedId;
			const customOpt = dom.append(select, $('option', { value: selectedId || 'active' }, fallbackLabel)) as HTMLOptionElement;
			customOpt.selected = true;
		}
	}

	private async _promptSavePreset(): Promise<void> {
		const rows = this._rows;
		const cols = this._cols;
		const cells = this._cells.map(c => ({ ...c }));
		const broadcastInput = this._broadcastInput;
		// Hide overlay while QuickInput is open so it doesn't intercept focus.
		this._overlay.style.display = 'none';
		try {
			const name = await this._quickInputService.input({
				title: localize('terminalGridSaveTitle', "Save Terminal Grid Layout"),
				prompt: localize('terminalGridSavePrompt', "Enter a name for this {0}×{1} terminal layout preset", rows, cols),
				placeHolder: localize('terminalGridSavePlaceholder', "e.g. Cloud Cluster 2×2"),
				value: localize('terminalGridDefaultName', "Grid {0}×{1}", rows, cols),
			});
			if (name?.trim()) {
				await this._gridService.saveLayout({ name: name.trim(), rows, cols, cells, broadcastInput });
			}
		} finally {
			if (!this._store.isDisposed) {
				this._overlay.style.display = '';
				this._render();
			}
		}
	}

	private async _runAction(fn: () => Promise<void>): Promise<void> {
		if (this._isBusy) {
			return;
		}
		this._isBusy = true;
		this.close();
		try {
			await fn();
		} finally {
			this._isBusy = false;
		}
	}

	close(): void {
		if (!this._store.isDisposed) {
			this._onClose();
			this.dispose();
		}
	}

	override dispose(): void {
		this._overlay.remove();
		super.dispose();
	}
}
