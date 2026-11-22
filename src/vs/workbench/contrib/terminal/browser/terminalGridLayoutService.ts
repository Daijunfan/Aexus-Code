/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AdeCloudHostOs, AdeOsIconKind, buildCloudProjectUri, resolveAdeOsIconKind } from '../../../../platform/ade/common/adeCloudHosts.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IShellLaunchConfig, TerminalLocation, TerminalSettingId } from '../../../../platform/terminal/common/terminal.js';
import { resolveLocalOsIconKind } from '../../../browser/adeOsIcon.js';
import { IProjectTerminalService, IProjectTerminalTarget, SSH_PROJECT_SCHEME } from './projectTerminalService.js';
import { ITerminalGroup, ITerminalGroupService, ITerminalInstance, ITerminalService } from './terminal.js';

export const MAX_GRID_ROWS = 6;
export const MAX_GRID_COLS = 6;
export const MAX_GRID_CELLS = 16;

export const TERMINAL_GRID_LAYOUTS_STORAGE_KEY = 'aexus.terminal.gridLayouts';

export interface ITerminalGridCellConfig {
	/** Target URI (`file://...`, `aexus-ssh://<alias>/<path>`), `'active'`, or undefined for active project. */
	readonly targetUri?: string;
	/** Optional display label override for this cell. */
	readonly label?: string;
	/** Optional working directory override. */
	readonly cwd?: string;
}

export interface ITerminalGridLayoutPreset {
	readonly id: string;
	readonly name: string;
	readonly rows: number;
	readonly cols: number;
	readonly cells: readonly ITerminalGridCellConfig[];
	readonly broadcastInput?: boolean;
	readonly source?: 'storage' | 'settings';
}

export interface ITerminalGridTargetOption {
	readonly id: string;
	readonly uri?: URI;
	readonly label: string;
	readonly host: string;
	readonly detail?: string;
	readonly osKind: AdeOsIconKind;
	readonly category: 'active' | 'cloud' | 'project' | 'ssh';
}

export interface IApplyTerminalGridOptions {
	readonly rows: number;
	readonly cols: number;
	readonly cells?: readonly ITerminalGridCellConfig[];
	readonly exactPaneCount?: number;
	readonly broadcastInput?: boolean;
	readonly openInNewGroup?: boolean;
}

export const ITerminalGridLayoutService = createDecorator<ITerminalGridLayoutService>('terminalGridLayoutService');

export interface ITerminalGridLayoutService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeLayouts: Event<void>;

	getSavedLayouts(): readonly ITerminalGridLayoutPreset[];
	saveLayout(preset: Omit<ITerminalGridLayoutPreset, 'id'> & { id?: string }): Promise<ITerminalGridLayoutPreset>;
	deleteLayout(id: string): Promise<void>;
	getAvailableTargets(): Promise<readonly ITerminalGridTargetOption[]>;
	applyGridLayout(options: IApplyTerminalGridOptions): Promise<ITerminalGroup | undefined>;
	applyAllCloudHostsGrid(options?: { includeLocal?: boolean; openInNewGroup?: boolean; broadcastInput?: boolean }): Promise<ITerminalGroup | undefined>;
	captureGroupAsLayout(group: ITerminalGroup, name: string): Omit<ITerminalGridLayoutPreset, 'id'>;
	switchCellTarget(group: ITerminalGroup, instance: ITerminalInstance, target: ITerminalGridTargetOption): Promise<ITerminalInstance>;
}

/**
 * Clamps requested rows and columns to safe visual bounds (`1..6` each, total panes <= `16`).
 */
export function clampGridDimensions(rows: number, cols: number): { rows: number; cols: number } {
	let r = Number.isFinite(rows) ? Math.floor(rows) : 1;
	let c = Number.isFinite(cols) ? Math.floor(cols) : 1;
	r = Math.max(1, Math.min(MAX_GRID_ROWS, r));
	c = Math.max(1, Math.min(MAX_GRID_COLS, c));
	while (r * c > MAX_GRID_CELLS) {
		if (c >= r && c > 1) {
			c--;
		} else if (r > 1) {
			r--;
		} else {
			break;
		}
	}
	return { rows: r, cols: c };
}

/**
 * Computes a clean, balanced `(rows, cols)` matrix for a given number of host/terminal targets.
 */
export function computeOptimalGridForCount(count: number): { rows: number; cols: number } {
	const n = Math.max(1, Math.min(MAX_GRID_CELLS, Math.floor(count)));
	if (n <= 1) {
		return { rows: 1, cols: 1 };
	}
	if (n === 2) {
		return { rows: 1, cols: 2 };
	}
	if (n === 3) {
		return { rows: 1, cols: 3 };
	}
	if (n === 4) {
		return { rows: 2, cols: 2 };
	}
	if (n <= 6) {
		return { rows: 2, cols: 3 };
	}
	if (n <= 9) {
		return { rows: 3, cols: 3 };
	}
	if (n <= 12) {
		return { rows: 3, cols: 4 };
	}
	return { rows: 4, cols: 4 };
}

/**
 * Resizes a row-major cell binding array to `rows * cols`, preserving existing assignments.
 */
export function resizeGridCells(cells: readonly ITerminalGridCellConfig[], rows: number, cols: number): ITerminalGridCellConfig[] {
	const clamped = clampGridDimensions(rows, cols);
	const total = clamped.rows * clamped.cols;
	const result: ITerminalGridCellConfig[] = [];
	for (let i = 0; i < total; i++) {
		const existing = cells[i];
		result.push(existing ? { ...existing } : { targetUri: 'active' });
	}
	return result;
}

/**
 * Validates and normalizes an untrusted persisted or user-configured grid layout preset.
 */
export function normalizeGridPreset(raw: unknown, fallbackIdPrefix = 'layout', source: 'storage' | 'settings' = 'storage'): ITerminalGridLayoutPreset | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	const name = typeof obj.name === 'string' ? obj.name.trim() : '';
	if (!name) {
		return undefined;
	}
	const rawRows = typeof obj.rows === 'number' ? obj.rows : Number(obj.rows);
	const rawCols = typeof obj.cols === 'number' ? obj.cols : Number(obj.cols);
	if (!Number.isFinite(rawRows) || !Number.isFinite(rawCols)) {
		return undefined;
	}
	const { rows, cols } = clampGridDimensions(rawRows, rawCols);
	const rawCells = Array.isArray(obj.cells) ? obj.cells : [];
	const cells: ITerminalGridCellConfig[] = [];
	const total = rows * cols;
	for (let i = 0; i < total; i++) {
		const entry = rawCells[i];
		if (entry && typeof entry === 'object') {
			const c = entry as Record<string, unknown>;
			const targetUri = typeof c.targetUri === 'string' && c.targetUri.trim() ? c.targetUri.trim() : undefined;
			const label = typeof c.label === 'string' && c.label.trim() ? c.label.trim() : undefined;
			const cwd = typeof c.cwd === 'string' && c.cwd.trim() ? c.cwd.trim() : undefined;
			cells.push({
				...(targetUri ? { targetUri } : {}),
				...(label ? { label } : {}),
				...(cwd ? { cwd } : {}),
			});
		} else {
			cells.push({});
		}
	}
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom';
	const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `${fallbackIdPrefix}-${slug}`;
	return {
		id,
		name,
		rows,
		cols,
		cells,
		broadcastInput: Boolean(obj.broadcastInput),
		source,
	};
}

function resolveTargetOsKind(target: IProjectTerminalTarget): AdeOsIconKind {
	if (target.uri.scheme === SSH_PROJECT_SCHEME || target.isCloudHost) {
		return resolveAdeOsIconKind({
			os: target.os as AdeCloudHostOs | undefined,
			hint: `${target.host} ${target.name} ${target.hostName ?? ''}`,
		});
	}
	return resolveLocalOsIconKind(target.name);
}

function extractTargetUriFromInstance(instance: ITerminalInstance, projectTerminals: IProjectTerminalService): string | undefined {
	const cfg = instance.shellLaunchConfig;
	if (cfg.isRemotePty && cfg.hostLabel) {
		const hostMeta = projectTerminals.getCachedCloudHost(cfg.hostLabel);
		const alias = hostMeta?.alias || cfg.hostLabel;
		const hostOs = hostMeta?.os ?? cfg.hostOs;
		const defaultDir = hostMeta?.defaultDirectory?.trim() || (hostOs === 'windows' ? '/C:/' : '/');
		return buildCloudProjectUri(alias, defaultDir, hostOs).toString();
	}
	if (URI.isUri(cfg.cwd)) {
		return cfg.cwd.toString();
	}
	if (typeof cfg.cwd === 'string' && cfg.cwd.trim()) {
		return URI.file(cfg.cwd.trim()).toString();
	}
	return undefined;
}

function canonicalizeTargetUri(raw: string | undefined): string | undefined {
	if (!raw || raw === 'active') {
		return raw;
	}
	try {
		const parsed = raw.includes('://') ? URI.parse(raw) : URI.file(raw);
		if (parsed.scheme === SSH_PROJECT_SCHEME) {
			return buildCloudProjectUri(parsed.authority, parsed.path || '/').toString().toLowerCase();
		}
		return parsed.toString().toLowerCase();
	} catch {
		return raw.toLowerCase();
	}
}

export class TerminalGridLayoutService extends Disposable implements ITerminalGridLayoutService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeLayouts = this._register(new Emitter<void>());
	readonly onDidChangeLayouts = this._onDidChangeLayouts.event;

	private _storedLayouts: ITerminalGridLayoutPreset[] = [];

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IProjectTerminalService private readonly _projectTerminals: IProjectTerminalService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ITerminalGroupService private readonly _terminalGroupService: ITerminalGroupService,
	) {
		super();
		this._storedLayouts = this._loadStoredLayouts();
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TerminalSettingId.GridLayouts)) {
				this._onDidChangeLayouts.fire();
			}
		}));
	}

	private _loadStoredLayouts(): ITerminalGridLayoutPreset[] {
		const raw = this._storageService.getObject<unknown[]>(TERMINAL_GRID_LAYOUTS_STORAGE_KEY, StorageScope.PROFILE, []);
		if (!Array.isArray(raw)) {
			return [];
		}
		const result: ITerminalGridLayoutPreset[] = [];
		const seen = new Set<string>();
		raw.forEach((item, idx) => {
			const normalized = normalizeGridPreset(item, `saved-${idx + 1}`, 'storage');
			if (normalized && !seen.has(normalized.id)) {
				seen.add(normalized.id);
				result.push(normalized);
			}
		});
		return result;
	}

	private _persistStoredLayouts(): void {
		const serializable = this._storedLayouts.map(({ id, name, rows, cols, cells, broadcastInput }) => ({
			id,
			name,
			rows,
			cols,
			cells,
			...(broadcastInput ? { broadcastInput: true } : {}),
		}));
		this._storageService.store(
			TERMINAL_GRID_LAYOUTS_STORAGE_KEY,
			JSON.stringify(serializable),
			StorageScope.PROFILE,
			StorageTarget.USER,
		);
	}

	getSavedLayouts(): readonly ITerminalGridLayoutPreset[] {
		const merged: ITerminalGridLayoutPreset[] = [];
		const seen = new Set<string>();
		for (const item of this._storedLayouts) {
			seen.add(item.id);
			merged.push(item);
		}
		const configured = this._configurationService.getValue<unknown>(TerminalSettingId.GridLayouts);
		if (Array.isArray(configured)) {
			configured.forEach((raw, idx) => {
				const normalized = normalizeGridPreset(raw, `cfg-${idx + 1}`, 'settings');
				if (normalized && !seen.has(normalized.id)) {
					seen.add(normalized.id);
					merged.push(normalized);
				}
			});
		}
		return merged;
	}

	async saveLayout(preset: Omit<ITerminalGridLayoutPreset, 'id'> & { id?: string }): Promise<ITerminalGridLayoutPreset> {
		const { rows, cols } = clampGridDimensions(preset.rows, preset.cols);
		const cells = resizeGridCells(preset.cells, rows, cols);
		const name = preset.name.trim() || localize('terminalGridDefaultPresetName', "Grid {0}×{1}", rows, cols);
		const id = preset.id?.trim() || `grid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		const next: ITerminalGridLayoutPreset = {
			id,
			name,
			rows,
			cols,
			cells,
			broadcastInput: Boolean(preset.broadcastInput),
			source: 'storage',
		};
		const existingIndex = this._storedLayouts.findIndex(item => item.id === id);
		if (existingIndex >= 0) {
			this._storedLayouts[existingIndex] = next;
		} else {
			this._storedLayouts.push(next);
		}
		this._persistStoredLayouts();
		this._onDidChangeLayouts.fire();
		return next;
	}

	async deleteLayout(id: string): Promise<void> {
		const before = this._storedLayouts.length;
		this._storedLayouts = this._storedLayouts.filter(item => item.id !== id);
		if (this._storedLayouts.length !== before) {
			this._persistStoredLayouts();
			this._onDidChangeLayouts.fire();
		}
	}

	async getAvailableTargets(): Promise<readonly ITerminalGridTargetOption[]> {
		const options: ITerminalGridTargetOption[] = [];
		const seenUris = new Set<string>();

		const current = this._projectTerminals.currentProject;
		options.push({
			id: 'active',
			uri: current?.uri,
			label: current
				? localize('terminalGridTargetActiveNamed', "Active Project ({0} · {1})", current.name, current.host)
				: localize('terminalGridTargetActiveLocal', "Local Shell"),
			host: current?.host ?? localize('localHost', "Local"),
			detail: current?.uri.path,
			osKind: current ? resolveTargetOsKind(current) : resolveLocalOsIconKind(),
			category: 'active',
		});

		const cloudHosts = await this._projectTerminals.listCloudHostTargets().catch(() => [] as readonly IProjectTerminalTarget[]);
		for (const target of cloudHosts) {
			const key = target.uri.toString();
			if (seenUris.has(key)) {
				continue;
			}
			seenUris.add(key);
			options.push({
				id: key,
				uri: target.uri,
				label: target.host,
				host: target.host,
				detail: target.hostName ? `${target.hostName} · ${target.uri.path}` : target.uri.path,
				osKind: resolveTargetOsKind(target),
				category: 'cloud',
			});
		}

		for (const target of this._projectTerminals.projects) {
			const key = target.uri.toString();
			if (seenUris.has(key)) {
				continue;
			}
			seenUris.add(key);
			options.push({
				id: key,
				uri: target.uri,
				label: `${target.name} · ${target.host}`,
				host: target.host,
				detail: target.uri.path,
				osKind: resolveTargetOsKind(target),
				category: target.uri.scheme === SSH_PROJECT_SCHEME ? 'cloud' : 'project',
			});
		}

		for (const target of this._projectTerminals.sshProjects) {
			const key = target.uri.toString();
			if (seenUris.has(key)) {
				continue;
			}
			seenUris.add(key);
			options.push({
				id: key,
				uri: target.uri,
				label: `${target.name} · ${target.host}`,
				host: target.host,
				detail: target.uri.path,
				osKind: resolveTargetOsKind(target),
				category: 'ssh',
			});
		}

		return options;
	}

	private async _resolveCellLaunchConfig(cell: ITerminalGridCellConfig | undefined): Promise<{ config: IShellLaunchConfig; cwd?: URI | string }> {
		const rawTarget = cell?.targetUri?.trim();
		if (rawTarget && rawTarget !== 'active') {
			try {
				const parsed = rawTarget.includes('://') ? URI.parse(rawTarget) : URI.file(rawTarget);
				const effectiveUri = cell?.cwd?.trim()
					? parsed.with({ path: cell.cwd.trim().startsWith('/') ? cell.cwd.trim() : `/${cell.cwd.trim()}` })
					: parsed;
				const config = await this._projectTerminals.resolveLaunchConfigForUri(effectiveUri, cell?.label);
				return { config, cwd: config.cwd };
			} catch {
				// Fall through to default local project launch config.
			}
		}
		const current = this._projectTerminals.currentProject;
		if (current) {
			const effectiveUri = cell?.cwd?.trim() && current.uri.scheme === Schemas.file
				? URI.file(cell.cwd.trim())
				: current.uri;
			const config = await this._projectTerminals.resolveLaunchConfigForUri(effectiveUri, cell?.label);
			return { config, cwd: config.cwd };
		}
		const localCwd = cell?.cwd?.trim() ? URI.file(cell.cwd.trim()) : undefined;
		// Always return an explicit non-remote launch config so splitting off an SSH anchor pane
		// never accidentally inherits the remote SSH host config for a Local Shell cell.
		return {
			config: {
				name: cell?.label?.trim() || localize('localHost', "Local"),
				...(localCwd ? { cwd: localCwd } : {}),
			},
			cwd: localCwd,
		};
	}

	async applyGridLayout(options: IApplyTerminalGridOptions): Promise<ITerminalGroup | undefined> {
		const { rows, cols } = clampGridDimensions(options.rows, options.cols);
		const desiredCount = options.exactPaneCount !== undefined
			? Math.max(1, Math.min(rows * cols, Math.floor(options.exactPaneCount)))
			: rows * cols;
		const cells = resizeGridCells(options.cells ?? [], rows, cols);

		let group: ITerminalGroup | undefined = options.openInNewGroup ? undefined : this._terminalGroupService.activeGroup;
		if (!group || group.terminalInstances.length === 0) {
			const firstLaunch = await this._resolveCellLaunchConfig(cells[0]);
			const firstInstance = await this._terminalService.createTerminal({
				config: firstLaunch.config,
				cwd: firstLaunch.cwd,
				location: TerminalLocation.Panel,
				skipContributedProfileCheck: true,
			});
			group = this._terminalGroupService.getGroupForInstance(firstInstance);
			if (!group) {
				return undefined;
			}
		} else {
			// If shrinking the grid, safely unsplit excess running terminals into their own tabs (no process killed).
			while (group.terminalInstances.length > desiredCount) {
				const excess = group.terminalInstances[group.terminalInstances.length - 1];
				this._terminalGroupService.unsplitInstance(excess);
			}

			// If explicit host bindings were provided for existing cells, switch mismatched cells in place.
			const existingCount = Math.min(group.terminalInstances.length, desiredCount);
			for (let i = 0; i < existingCount; i++) {
				const cell = cells[i];
				const rawTarget = cell?.targetUri?.trim();
				if (!rawTarget || rawTarget === 'active') {
					continue;
				}
				const existingInstance = group.terminalInstances[i];
				const existingCanonical = canonicalizeTargetUri(extractTargetUriFromInstance(existingInstance, this._projectTerminals));
				const desiredCanonical = canonicalizeTargetUri(rawTarget);
				if (existingCanonical && desiredCanonical && existingCanonical === desiredCanonical) {
					continue;
				}
				const launch = await this._resolveCellLaunchConfig(cell);
				const replacement = await this._createDetachedReplacement(launch.config);
				if (replacement && group.replaceInstance) {
					group.replaceInstance(existingInstance, replacement);
					existingInstance.dispose();
				}
			}
		}

		// Spawn additional terminals until the group holds all `rows * cols` panes.
		while (group.terminalInstances.length < desiredCount) {
			const cellIndex = group.terminalInstances.length;
			const cell = cells[cellIndex];
			const launch = await this._resolveCellLaunchConfig(cell);
			const anchor = group.terminalInstances[group.terminalInstances.length - 1];
			await this._terminalService.createTerminal({
				config: launch.config,
				cwd: launch.cwd,
				location: { parentTerminal: anchor, splitDirection: 'right' },
				skipContributedProfileCheck: true,
			});
		}

		group.arrangeAsGrid?.(rows, cols);
		if (options.broadcastInput !== undefined) {
			group.broadcastInput = options.broadcastInput;
		}
		this._terminalGroupService.activeGroup = group;
		if (group.terminalInstances[0]) {
			this._terminalService.setActiveInstance(group.terminalInstances[0]);
		}
		await this._terminalGroupService.showPanel(true);
		return group;
	}

	private async _createDetachedReplacement(launchConfig: IShellLaunchConfig): Promise<ITerminalInstance | undefined> {
		// Create via terminalService in a temporary group, detach from that temporary group, and return for in-place cell swap.
		const created = await this._terminalService.createTerminal({
			config: launchConfig,
			cwd: launchConfig.cwd,
			location: TerminalLocation.Panel,
			skipContributedProfileCheck: true,
		});
		const tempGroup = this._terminalGroupService.getGroupForInstance(created);
		tempGroup?.removeInstance(created);
		return created;
	}

	async applyAllCloudHostsGrid(options?: { includeLocal?: boolean; openInNewGroup?: boolean; broadcastInput?: boolean }): Promise<ITerminalGroup | undefined> {
		const cloudTargets = await this._projectTerminals.listCloudHostTargets();
		const cells: ITerminalGridCellConfig[] = [];
		if (options?.includeLocal) {
			const current = this._projectTerminals.currentProject;
			cells.push({
				targetUri: current?.uri.scheme === Schemas.file ? current.uri.toString() : 'active',
				label: current?.uri.scheme === Schemas.file ? current.name : undefined,
			});
		}
		for (const target of cloudTargets) {
			if (cells.length >= MAX_GRID_CELLS) {
				break;
			}
			cells.push({
				targetUri: target.uri.toString(),
				label: target.name,
			});
		}
		if (cells.length === 0) {
			// Fallback to 2x2 local grid when no cloud hosts are configured yet.
			return this.applyGridLayout({
				rows: 2,
				cols: 2,
				openInNewGroup: options?.openInNewGroup,
				broadcastInput: options?.broadcastInput,
			});
		}
		const { rows, cols } = computeOptimalGridForCount(cells.length);
		return this.applyGridLayout({
			rows,
			cols,
			cells,
			exactPaneCount: cells.length,
			openInNewGroup: options?.openInNewGroup ?? true,
			broadcastInput: options?.broadcastInput,
		});
	}

	captureGroupAsLayout(group: ITerminalGroup, name: string): Omit<ITerminalGridLayoutPreset, 'id'> {
		const dims = group.gridDimensions;
		const cells: ITerminalGridCellConfig[] = group.terminalInstances.map(instance => {
			const targetUri = extractTargetUriFromInstance(instance, this._projectTerminals);
			return {
				...(targetUri ? { targetUri } : { targetUri: 'active' }),
				...(instance.shellLaunchConfig.name ? { label: instance.shellLaunchConfig.name } : {}),
			};
		});
		const normalizedDims = dims.rows * dims.cols >= group.terminalInstances.length
			? dims
			: computeOptimalGridForCount(group.terminalInstances.length);
		return {
			name: name.trim() || localize('terminalGridSavedFallback', "Grid {0}×{1}", normalizedDims.rows, normalizedDims.cols),
			rows: normalizedDims.rows,
			cols: normalizedDims.cols,
			cells: resizeGridCells(cells, normalizedDims.rows, normalizedDims.cols),
			broadcastInput: group.broadcastInput,
		};
	}

	async switchCellTarget(group: ITerminalGroup, instance: ITerminalInstance, target: ITerminalGridTargetOption): Promise<ITerminalInstance> {
		const launch = await this._resolveCellLaunchConfig({
			targetUri: target.uri ? target.uri.toString() : 'active',
			label: target.category === 'cloud' ? target.host : undefined,
		});
		const replacement = launch.config
			? await this._createDetachedReplacement(launch.config)
			: undefined;
		if (!replacement) {
			return instance;
		}
		if (group.replaceInstance) {
			group.replaceInstance(instance, replacement);
			instance.dispose();
			this._terminalService.setActiveInstance(replacement);
			await replacement.focusWhenReady(true);
			return replacement;
		}
		return instance;
	}
}
