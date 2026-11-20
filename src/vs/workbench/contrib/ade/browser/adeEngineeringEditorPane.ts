/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, Dimension, EventType, getWindow } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	IAdeEngineeringBlueprint,
	IAdeEngineeringBlueprintNode,
	IAdeEngineeringEventLogEntry,
	IAdeEngineeringNodeRuntimeState,
	IAdeEngineeringService,
} from '../../../../platform/ade/common/adeEngineering.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ADE_ENGINEERING_SCHEME, IAdeProjectsService } from '../common/ade.js';
import './media/adeEngineeringStudio.css';

const MIN_WORLD_WIDTH = 4800;
const MIN_WORLD_HEIGHT = 3600;
const WORLD_MARGIN = 640;
const QUICK_SPAWN_DX = 410;
const QUICK_SPAWN_DY = 236;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

/** At most this many running edges get SMIL signal particles; beyond it edges fall back to the CSS dash flow. */
export const ADE_ENG_MAX_PARTICLE_EDGES = 24;
export const ADE_ENG_PARTICLES_PER_EDGE = 3;
/** Soft SLA: a live phase timer turns amber (`.over-sla`) after this many milliseconds. */
export const ADE_ENG_PHASE_SOFT_SLA_MS = 10 * 60 * 1000;

type PhaseRoleKind = 'wrk' | 'emp' | 'mgr';
type EventRoleKind = 'wrk' | 'emp' | 'mgr' | 'gate' | 'sys';

export function computeDiffLineStats(combinedDiff: string | undefined): { readonly added: number; readonly removed: number } {
	if (!combinedDiff) {
		return { added: 0, removed: 0 };
	}
	let added = 0;
	let removed = 0;
	for (const line of combinedDiff.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) {
			added++;
		} else if (line.startsWith('-') && !line.startsWith('---')) {
			removed++;
		}
	}
	return { added, removed };
}

/**
 * World (canvas) size grows beyond the 4800×3600 baseline so large graphs never clip their edges SVG.
 */
export function computeEngineeringWorldSize(nodes: readonly Pick<IAdeEngineeringBlueprintNode, 'position'>[]): { readonly width: number; readonly height: number } {
	let maxX = 0;
	let maxY = 0;
	for (const n of nodes) {
		maxX = Math.max(maxX, n.position?.x ?? 0);
		maxY = Math.max(maxY, n.position?.y ?? 0);
	}
	return {
		width: Math.max(MIN_WORLD_WIDTH, Math.ceil((maxX + WORLD_MARGIN) / 200) * 200),
		height: Math.max(MIN_WORLD_HEIGHT, Math.ceil((maxY + WORLD_MARGIN) / 200) * 200),
	};
}

/**
 * Pure position math shared by quick-spawn and hover spawn ghost preview.
 */
export function computeQuickSpawnPosition(
	bp: Pick<IAdeEngineeringBlueprint, 'nodes' | 'edges'>,
	sourceNodeId: string,
): { readonly x: number; readonly y: number } | undefined {
	const sourceNode = bp.nodes.find(n => n.id === sourceNodeId);
	if (!sourceNode?.position) {
		return undefined;
	}
	const existingDownstreamCount = bp.edges.filter(e => e.from === sourceNode.id).length;
	const offsetY = existingDownstreamCount === 0 ? 0 : (existingDownstreamCount % 2 === 1 ? 1 : -1) * Math.ceil(existingDownstreamCount / 2) * QUICK_SPAWN_DY;
	return {
		x: sourceNode.position.x + QUICK_SPAWN_DX,
		y: Math.max(150, sourceNode.position.y + offsetY),
	};
}

export function phaseRoleOf(phase: IAdeEngineeringNodeRuntimeState['phase'] | undefined): PhaseRoleKind | undefined {
	switch (phase) {
		case 'worker_running': return 'wrk';
		case 'employee_review': return 'emp';
		case 'manager_review':
		case 'manager_escalation': return 'mgr';
		default: return undefined;
	}
}

export function eventRoleOf(ev: Pick<IAdeEngineeringEventLogEntry, 'event' | 'level'>): EventRoleKind {
	const kind = ev.event.toLowerCase();
	if (kind.includes('gate') || kind.includes('circuit') || kind.includes('watchdog') || kind.includes('fail') || ev.level !== 'info') {
		return 'gate';
	}
	if (kind.includes('manager') || kind.includes('segment')) {
		return 'mgr';
	}
	if (kind.includes('employee') || kind.includes('node_passed')) {
		return 'emp';
	}
	if (kind.includes('worker')) {
		return 'wrk';
	}
	return 'sys';
}

/** Live tokens-per-minute rate computed from `(time, cumulativeTotal)` samples taken on each tree refresh. */
export function computeTokenRatePerMinute(samples: readonly { readonly t: number; readonly total: number }[]): number {
	if (samples.length < 2) {
		return 0;
	}
	const first = samples[0];
	const last = samples[samples.length - 1];
	const dtMin = (last.t - first.t) / 60_000;
	if (dtMin <= 1 / 60 || last.total <= first.total) {
		return 0;
	}
	return Math.round((last.total - first.total) / dtMin);
}

function matchBlueprintNodeHeading(rawLine: string): string | undefined {
	const trimmed = rawLine.trim();
	const bracketedH3 = /^###\s*\[([A-Za-z0-9_-]+)\](?:\s+.*)?$/.exec(trimmed);
	if (bracketedH3) {
		return bracketedH3[1];
	}
	const inlineH2 = /^##\s+Node\s*:\s*\[?([A-Za-z0-9_-]+)\]?(?:\s*[—:-]\s*.*)?$/i.exec(trimmed);
	return inlineH2?.[1];
}

/** Returns the `### [id]` or `## Node: id` section enclosing the given caret offset in raw Blueprint Markdown. */
export function blueprintNodeIdAtOffset(text: string, offset: number): string | undefined {
	const clamped = Math.max(0, Math.min(text.length, offset));
	const lineEnd = text.indexOf('\n', clamped);
	const sliceEnd = lineEnd === -1 ? text.length : lineEnd;
	const lines = text.slice(0, sliceEnd).split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const id = matchBlueprintNodeHeading(lines[i]);
		if (id) {
			return id;
		}
		if (/^```/.test(lines[i]) || /^---\s*$/.test(lines[i]) || /^##\s+(?!Nodes\b)/i.test(lines[i].trim())) {
			return undefined;
		}
	}
	return undefined;
}

/** Returns the zero-based line index of a node's `### [id]` or `## Node: id` heading, or -1. */
export function blueprintNodeSectionLine(text: string, nodeId: string): number {
	return text.split('\n').findIndex(line => matchBlueprintNodeHeading(line) === nodeId);
}

export class AdeEngineeringEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeEngineering';
	override readonly resource: URI;

	constructor(
		readonly governorSessionId: string,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
	) {
		super();
		this.resource = URI.from({ scheme: ADE_ENGINEERING_SCHEME, path: `/${governorSessionId}` });
		this._register(projects.onDidChange(() => this._onDidChangeLabel.fire()));
	}

	override get typeId(): string {
		return AdeEngineeringEditorInput.ID;
	}

	override getName(): string {
		const gov = this.projects.getAgent(this.governorSessionId);
		const base = gov?.label ?? localize('adeMissionFallbackOwner', "Mission");
		return localize('adeMissionTabTitle', "{0} · Mission", base);
	}

	override getIcon(): ThemeIcon {
		return Codicon.typeHierarchySub;
	}

	override matches(other: EditorInput): boolean {
		return other instanceof AdeEngineeringEditorInput && other.governorSessionId === this.governorSessionId;
	}
}

export class AdeEngineeringEditorSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof AdeEngineeringEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		return input instanceof AdeEngineeringEditorInput ? input.governorSessionId : undefined;
	}

	deserialize(instantiationService: IInstantiationService, governorSessionId: string): EditorInput | undefined {
		if (!governorSessionId) {
			return undefined;
		}
		return instantiationService.createInstance(AdeEngineeringEditorInput, governorSessionId);
	}
}

/**
 * Engineering workspace editor pane — stripped to a clean, infinite pannable/zoomable canvas.
 * Backend orchestration services and UI CSS/assets remain preserved for upcoming frontend rebuild.
 */
export class AdeEngineeringEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.adeEngineering';

	private rootEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private viewportEl!: HTMLElement;
	private worldEl!: HTMLElement;

	private activeGovernorId: string | undefined;
	private panX = 0;
	private panY = 0;
	private zoom = 1;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAdeEngineeringService private readonly engineering: IAdeEngineeringService,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
	) {
		super(AdeEngineeringEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.ade-eng-editor.mode-engineering', { tabindex: 0 }));
		this.bodyEl = append(this.rootEl, $('.ade-eng-body'));
		this.viewportEl = append(this.bodyEl, $('.ade-eng-viewport'));
		this.worldEl = append(this.viewportEl, $('.ade-eng-world'));
		this.installInfiniteCanvasInteractions();
		this.applyWorldTransform();
	}

	private syncRootModeClass(): void {
		if (!this.rootEl) {
			return;
		}
		const govAgent = this.activeGovernorId ? this.projects.getAgent(this.activeGovernorId) : undefined;
		const snap = this.activeGovernorId ? this.engineering.getTreeSnapshot(this.activeGovernorId) : undefined;
		const treeType = snap?.treeType ?? (govAgent?.treeType === 'research' ? 'research' : 'engineering');
		const isResearch = treeType === 'research';
		this.rootEl.classList.toggle('mode-research', isResearch);
		this.rootEl.classList.toggle('mode-engineering', !isResearch);
	}

	private applyWorldTransform(): void {
		if (!this.viewportEl || !this.worldEl) {
			return;
		}
		this.viewportEl.scrollLeft = 0;
		this.viewportEl.scrollTop = 0;
		const rx = Math.round(this.panX);
		const ry = Math.round(this.panY);
		this.worldEl.style.transform = `translate(${rx}px, ${ry}px) scale(${this.zoom})`;
		this.viewportEl.style.setProperty('--grid-x', `${rx}px`);
		this.viewportEl.style.setProperty('--grid-y', `${ry}px`);
		this.viewportEl.style.setProperty('--grid-scale', String(this.zoom));
		this.viewportEl.classList.toggle('zoom-compact', this.zoom < 0.58);
		this.viewportEl.classList.toggle('zoom-macro', this.zoom < 0.5);
	}

	private installInfiniteCanvasInteractions(): void {
		let panning = false;
		let startClientX = 0;
		let startClientY = 0;
		let startPanX = 0;
		let startPanY = 0;

		this._register(addDisposableListener(this.viewportEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0 && e.button !== 1) {
				return;
			}
			panning = true;
			startClientX = e.clientX;
			startClientY = e.clientY;
			startPanX = this.panX;
			startPanY = this.panY;
			this.viewportEl.classList.add('panning');
			try {
				this.viewportEl.setPointerCapture(e.pointerId);
			} catch { /* synthetic test events */ }
		}));

		this._register(addDisposableListener(this.viewportEl, EventType.POINTER_MOVE, (e: PointerEvent) => {
			if (!panning) {
				return;
			}
			this.panX = startPanX + (e.clientX - startClientX);
			this.panY = startPanY + (e.clientY - startClientY);
			this.applyWorldTransform();
		}));

		const stopPan = (e: PointerEvent) => {
			if (!panning) {
				return;
			}
			panning = false;
			this.viewportEl.classList.remove('panning');
			try {
				this.viewportEl.releasePointerCapture(e.pointerId);
			} catch { /* ignore */ }
		};
		this._register(addDisposableListener(this.viewportEl, EventType.POINTER_UP, stopPan));
		this._register(addDisposableListener(this.viewportEl, 'pointercancel', stopPan));

		this._register(addDisposableListener(this.viewportEl, EventType.WHEEL, (e: WheelEvent) => {
			e.preventDefault();
			if (e.ctrlKey || e.metaKey) {
				const rect = this.viewportEl.getBoundingClientRect();
				const cursorX = e.clientX - rect.left;
				const cursorY = e.clientY - rect.top;
				const worldX = (cursorX - this.panX) / this.zoom;
				const worldY = (cursorY - this.panY) / this.zoom;
				const factor = e.deltaY < 0 ? 1.08 : 0.92;
				const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
				this.zoom = Math.round(nextZoom * 100) / 100;
				this.panX = cursorX - worldX * this.zoom;
				this.panY = cursorY - worldY * this.zoom;
				this.applyWorldTransform();
			} else {
				this.panX -= e.deltaX;
				this.panY -= e.deltaY;
				this.applyWorldTransform();
			}
		}, { passive: false }));

		const win = getWindow(this.rootEl);
		this._register(addDisposableListener(win, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.code === 'Space' && this.rootEl?.contains(win.document.activeElement)) {
				this.viewportEl.classList.add('space-pan');
			}
		}));
		this._register(addDisposableListener(win, EventType.KEY_UP, (e: KeyboardEvent) => {
			if (e.code === 'Space') {
				this.viewportEl.classList.remove('space-pan');
			}
		}));
	}

	override async setInput(input: AdeEngineeringEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.activeGovernorId = input.governorSessionId;
		this.syncRootModeClass();
		this.applyWorldTransform();

		await this.engineering.whenReady();
		if (token.isCancellationRequested) {
			return;
		}
		const govAgent = this.projects.getAgent(input.governorSessionId);
		if (!this.engineering.hasTree(input.governorSessionId) && govAgent) {
			await this.engineering.initTree({
				governorSessionId: input.governorSessionId,
				treeType: govAgent.treeType === 'research' ? 'research' : 'engineering',
			}).catch(() => { /* ignore init error on blank canvas */ });
		}
		this.syncRootModeClass();
	}

	override clearInput(): void {
		this.activeGovernorId = undefined;
		super.clearInput();
	}

	togglePromptToDagBar(_open?: boolean): void {
		// Intentionally no-op while Engineering workspace frontend is reset to a blank infinite canvas.
	}

	override focus(): void {
		this.rootEl?.focus();
	}

	layout(dimension: Dimension): void {
		if (this.rootEl) {
			this.rootEl.style.width = `${dimension.width}px`;
			this.rootEl.style.height = `${dimension.height}px`;
		}
	}
}
