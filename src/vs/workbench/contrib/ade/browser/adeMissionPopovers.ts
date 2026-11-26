/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	ADE_OS_ICON_LABELS,
	AdeOsIconKind,
	resolveAdeOsIconKind,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	IAdeUiCreateAgentInput,
	IAdeUiEditAgentInput,
} from '../../../../platform/ade/common/adeControlCenterIpc.js';
import {
	ADE_REGISTERED_ENGINES,
	AdeBoardPermission,
	IAdeAgentNode,
	IAdeDepartment,
	IAdeProjectSnapshot,
} from '../../../../platform/ade/common/adeModels.js';
import {
	ADE_NODE_COLOR_PRESETS,
	normalizeAdeNodeColor,
} from '../../../../platform/ade/common/adeNodeColors.js';
import { renderAdeLlmIcon } from '../../../browser/adeLlmIcon.js';
import { renderAdeOsIcon, resolveLocalOsIconKind } from '../../../browser/adeOsIcon.js';
import { IAdeAgent, normalizeAdeShortEngineId } from '../common/ade.js';
import { adeBi } from '../common/adeLocalization.js';
import { buildModelGlassSelectItem, IAdeGlassSelectItem } from './adeGlassSelect.js';
import {
	ICreateAgentPopoverOptions,
	ICreateDepartmentPopoverOptions,
	ICreateWhiteboardPopoverOptions,
	IEditAgentPopoverOptions,
	IEditDepartmentPopoverOptions,
	IMissionDetailPopoverHost,
	renderCreateAgentCascadePopover,
	renderCreateDepartmentPopover,
	renderCreateWhiteboardPopover,
	renderEditAgentPopover,
	renderEditDepartmentPopover,
} from './adeMissionCanvasDetailPopovers.js';
import {
	AdeMissionHostCatalog,
	applyMissionEngineIcon,
	MISSION_ENGINE_DEFAULT_MODELS,
	MISSION_ENGINE_FALLBACK_NAMES,
	MISSION_THINKING_LEVEL_OPTIONS,
	toPrefixedAdeEngineId,
} from './adeMissionHostCatalog.js';

export interface ICanvasContextMenuItem {
	readonly id: string;
	readonly label: string;
	readonly icon?: string;
	readonly danger?: boolean;
	readonly disabled?: boolean;
	readonly separatorBefore?: boolean;
	readonly run: () => void;
}

export interface IMissionPopoversDelegate {
	getProjectSnapshot(): IAdeProjectSnapshot | undefined;
	onCreateAgent(input: IAdeUiCreateAgentInput): Promise<unknown>;
	onEditAgent(input: IAdeUiEditAgentInput): Promise<unknown>;
	onDeleteAgent?(agentId: string): Promise<void>;
	onOpenAgentSession?(agentId: string, side: boolean): void;
	onManageCloudHosts?(): void;
	onCreateDepartment?(rootAgentId: string, name: string, colorToken?: string): Promise<unknown>;
	onEditDepartment?(deptId: string, patch: {
		readonly name?: string;
		readonly boardId?: string;
		readonly perm?: AdeBoardPermission;
		readonly colorToken?: string;
	}): Promise<unknown>;
	onToggleDepartmentMember?(deptId: string, agentId: string, action: 'in' | 'out'): Promise<unknown>;
	onDeleteDepartment?(deptId: string): Promise<unknown>;
	onCreateWhiteboard?(input: {
		readonly name: string;
		readonly ownerId?: string | null;
		readonly deptId?: string | null;
		readonly storageHost?: string;
		readonly tags?: readonly string[];
		readonly canvasX?: number;
		readonly canvasY?: number;
		readonly colorToken?: string;
	}): Promise<unknown>;
	onSetNodeColor?(nodeId: string, colorToken: string | undefined): Promise<void> | void;
	onActionFeedback?(message: string, kind: 'ok' | 'error' | 'info'): void;
}

interface IHostQuickCandidate {
	readonly value: string;
	readonly title: string;
	readonly subtitle: string;
	readonly osKind: AdeOsIconKind;
	readonly matchKeys: readonly string[];
}

function collectHostQuickCandidates(
	snapshot: IAdeProjectSnapshot | undefined,
	hostCatalog: AdeMissionHostCatalog,
	currentHost: string,
): readonly IHostQuickCandidate[] {
	const localOs = resolveLocalOsIconKind();
	const out: IHostQuickCandidate[] = [
		{
			value: 'local',
			title: adeBi(localize('adeQuickHostLocalTitle', "Local Machine"), '本机 (Local Mac)'),
			subtitle: `local · ${ADE_OS_ICON_LABELS[localOs]}`,
			osKind: localOs,
			matchKeys: ['local'],
		},
	];
	const seenLower = new Set<string>(['local']);

	const knownByKey = new Map<string, ReturnType<AdeMissionHostCatalog['getKnownCloudHosts']>[number]>();
	for (const ch of hostCatalog.getKnownCloudHosts()) {
		if (ch.alias) {
			knownByKey.set(ch.alias.toLowerCase(), ch);
		}
		if (ch.hostName) {
			knownByKey.set(ch.hostName.toLowerCase(), ch);
		}
	}

	for (const h of snapshot?.hosts ?? []) {
		const ip = h.ip.trim();
		const alias = (h.ssh_alias ?? '').trim();
		const primary = alias || ip;
		if (!primary || seenLower.has(primary.toLowerCase()) || (ip && seenLower.has(ip.toLowerCase()))) {
			continue;
		}
		const keys = Array.from(new Set([primary.toLowerCase(), ip.toLowerCase(), alias.toLowerCase()].filter(Boolean)));
		for (const k of keys) {
			seenLower.add(k);
		}
		const saved = (ip ? knownByKey.get(ip.toLowerCase()) : undefined) ?? (alias ? knownByKey.get(alias.toLowerCase()) : undefined);
		const osKind = resolveAdeOsIconKind({
			os: saved?.os,
			distribution: saved?.lastTestStatus?.remoteUname,
			hint: `${h.os_kind ?? ''} ${h.name ?? ''} ${alias} ${ip}`,
		});
		const targetDesc = alias && ip && alias.toLowerCase() !== ip.toLowerCase() ? `${alias} (${ip})` : primary;
		out.push({
			value: primary,
			title: h.name || alias || ip,
			subtitle: `${targetDesc} · ${ADE_OS_ICON_LABELS[osKind]}`,
			osKind,
			matchKeys: keys,
		});
	}

	for (const ch of hostCatalog.getKnownCloudHosts()) {
		const alias = (ch.alias ?? '').trim();
		const hostName = (ch.hostName ?? '').trim();
		const primary = alias || hostName;
		if (!primary || seenLower.has(primary.toLowerCase()) || (hostName && seenLower.has(hostName.toLowerCase()))) {
			continue;
		}
		const keys = Array.from(new Set([primary.toLowerCase(), alias.toLowerCase(), hostName.toLowerCase()].filter(Boolean)));
		for (const k of keys) {
			seenLower.add(k);
		}
		const osKind = resolveAdeOsIconKind({
			os: ch.os,
			distribution: ch.lastTestStatus?.remoteUname,
			hint: `${ch.name ?? ''} ${alias} ${ch.user ?? ''} ${hostName}`,
		});
		const targetDesc = alias && hostName && alias.toLowerCase() !== hostName.toLowerCase() ? `${alias} (${hostName})` : primary;
		out.push({
			value: primary,
			title: ch.name || alias || hostName,
			subtitle: `${targetDesc} · ${ADE_OS_ICON_LABELS[osKind]}`,
			osKind,
			matchKeys: keys,
		});
	}

	const trimmedCurrent = currentHost.trim();
	if (trimmedCurrent && !seenLower.has(trimmedCurrent.toLowerCase())) {
		const info = hostCatalog.resolveNodeHostAndOs(trimmedCurrent);
		out.push({
			value: trimmedCurrent,
			title: info.displayHost || trimmedCurrent,
			subtitle: `${trimmedCurrent} · ${info.osLabel}`,
			osKind: info.osKind,
			matchKeys: [trimmedCurrent.toLowerCase()],
		});
	}

	return out;
}

const EFFORT_DESCRIPTIONS: Readonly<Record<string, { readonly en: string; readonly zh: string }>> = {
	none: { en: 'No extended reasoning', zh: '关闭扩展思考' },
	off: { en: 'Direct fast response', zh: '关闭思考直出' },
	minimal: { en: 'Minimal reasoning budget', zh: '极简思考预算' },
	low: { en: 'Fast turn, light reasoning', zh: '轻量快速思考' },
	medium: { en: 'Balanced speed & depth', zh: '均衡推理深度' },
	high: { en: 'Deep multi-step analysis', zh: '深度多步推理' },
	'extra-high': { en: 'Extended deep reasoning', zh: '超深推理预算' },
	xhigh: { en: 'Extended deep reasoning', zh: '超深推理预算' },
	max: { en: 'Maximum reasoning budget', zh: '最大思考强度' },
	ultra: { en: 'Ultra exhaustive synthesis', zh: '极限深度推演' },
};

/**
 * Floating Popover Manager for Project Canvas nodes:
 * - In-place glassmorphic quick pickers for Host (`openHostPopover`), Engine (`openEnginePopover`),
 *   Model (`openModelPopover` with real probed models, search & 12-vendor groups), and Effort (`openEffortPopover`).
 * - 5-step cascade L1/subordinate creation, staff detail editing, department management, node colors, and context menus.
 * - Switching Host or Engine when `session_started === true` displays a clear session-reset notice and passes `allowSessionReset: true`.
 */
export class AdeMissionPopovers extends Disposable implements IMissionDetailPopoverHost {
	readonly popoverEl: HTMLElement;
	readonly popoverDisposables = this._register(new DisposableStore());

	private activeKind: 'none' | 'context-menu' | 'form' = 'none';
	private popGen = 0;

	constructor(
		private readonly bodyEl: HTMLElement,
		private readonly hostCatalog: AdeMissionHostCatalog,
		private readonly delegate: IMissionPopoversDelegate,
	) {
		super();
		this.popoverEl = append(this.bodyEl, $('.ade-mission-emp-popover', {
			role: 'dialog',
			'data-ade-mission-emp-popover': 'true',
		}));
		this.popoverEl.hidden = true;

		this._register(addDisposableListener(this.popoverEl, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this._register(addDisposableListener(this.popoverEl, EventType.WHEEL, e => e.stopPropagation(), { passive: false }));
		this._register(addDisposableListener(this.popoverEl, EventType.CLICK, e => e.stopPropagation()));
		this._register(addDisposableListener(this.popoverEl, EventType.DBLCLICK, e => e.stopPropagation()));
		this._register(addDisposableListener(this.popoverEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.close('escape');
			}
		}));

		const win = getWindow(this.bodyEl);
		this._register(addDisposableListener(win.document, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (!this.isOpen()) {
				return;
			}
			const target = e.target as Node | null;
			if (target && this.popoverEl.contains(target)) {
				return;
			}
			if (target instanceof Element && target.closest('[data-ade-select-portal="true"]')) {
				return;
			}
			this.close('dismiss');
		}));
	}

	get portalContainer(): HTMLElement {
		return this.bodyEl;
	}

	override dispose(): void {
		this.close('dismiss');
		this.popoverEl.remove();
		super.dispose();
	}

	isOpen(): boolean {
		return !this.popoverEl.hidden;
	}

	isContextMenuOpen(): boolean {
		return this.isOpen() && this.activeKind === 'context-menu';
	}

	close(_reason: 'dismiss' | 'escape' = 'dismiss'): void {
		this.popGen++;
		this.popoverDisposables.clear();
		this.activeKind = 'none';
		this.popoverEl.classList.remove(
			'is-model-popover',
			'is-effort-popover',
			'is-host-popover',
			'is-context-menu',
			'is-color-popover',
			'is-cascade-popover',
		);
		clearNode(this.popoverEl);
		this.popoverEl.hidden = true;
	}

	openAtAnchor(anchorEl: HTMLElement, extraClass?: string): void {
		this.popoverEl.classList.remove(
			'is-model-popover',
			'is-effort-popover',
			'is-host-popover',
			'is-context-menu',
			'is-color-popover',
			'is-cascade-popover',
		);
		if (extraClass) {
			this.popoverEl.classList.add(extraClass);
		}
		this.activeKind = extraClass === 'is-context-menu' ? 'context-menu' : 'form';
		this.popoverEl.hidden = false;

		const bodyRect = this.bodyEl.getBoundingClientRect();
		const anchorRect = anchorEl.getBoundingClientRect();
		const bodyW = bodyRect.width || this.bodyEl.clientWidth || 1280;
		const bodyH = bodyRect.height || this.bodyEl.clientHeight || 800;
		const popW = this.popoverEl.offsetWidth || 320;
		const popH = this.popoverEl.offsetHeight || 280;

		let left = anchorRect.left - bodyRect.left;
		let top = anchorRect.bottom - bodyRect.top + 8;
		if (left + popW > bodyW - 12) {
			left = Math.max(12, bodyW - popW - 12);
		}
		if (top + popH > bodyH - 12) {
			top = Math.max(12, anchorRect.top - bodyRect.top - popH - 8);
		}
		this.popoverEl.style.left = `${Math.round(Math.max(12, left))}px`;
		this.popoverEl.style.top = `${Math.round(Math.max(12, top))}px`;
	}

	openAtClientPoint(clientX: number, clientY: number, extraClass?: string): void {
		this.popoverEl.classList.remove(
			'is-model-popover',
			'is-effort-popover',
			'is-host-popover',
			'is-context-menu',
			'is-color-popover',
			'is-cascade-popover',
		);
		if (extraClass) {
			this.popoverEl.classList.add(extraClass);
		}
		this.activeKind = extraClass === 'is-context-menu' ? 'context-menu' : 'form';
		this.popoverEl.hidden = false;

		const bodyRect = this.bodyEl.getBoundingClientRect();
		const bodyW = bodyRect.width || this.bodyEl.clientWidth || 1280;
		const bodyH = bodyRect.height || this.bodyEl.clientHeight || 800;
		const popW = this.popoverEl.offsetWidth || 260;
		const popH = this.popoverEl.offsetHeight || 240;

		const left = Math.max(10, Math.min(bodyW - popW - 10, clientX - bodyRect.left));
		const top = Math.max(10, Math.min(bodyH - popH - 10, clientY - bodyRect.top));
		this.popoverEl.style.left = `${Math.round(left)}px`;
		this.popoverEl.style.top = `${Math.round(top)}px`;
	}

	openContextMenu(items: readonly ICanvasContextMenuItem[], clientX: number, clientY: number): void {
		this.popoverDisposables.clear();
		clearNode(this.popoverEl);

		const list = append(this.popoverEl, $('.ade-canvas-context-menu-list', {
			role: 'menu',
		}));
		for (const item of items) {
			if (item.separatorBefore) {
				append(list, $('.ade-canvas-context-menu-sep'));
			}
			const btn = append(list, $(`button.ade-canvas-context-menu-item${item.danger ? '.is-danger' : ''}`, {
				type: 'button',
				role: 'menuitem',
				'data-ade-menu-item': item.id,
			})) as HTMLButtonElement;
			btn.disabled = Boolean(item.disabled);
			if (item.icon) {
				append(btn, $(`span.codicon.codicon-${item.icon}`));
			}
			append(btn, $('span.ade-canvas-context-menu-label', {}, item.label));
			this.popoverDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				if (item.disabled) {
					return;
				}
				this.close('dismiss');
				item.run();
			}));
		}

		this.openAtClientPoint(clientX, clientY, 'is-context-menu');
	}

	openNodeColorPopover(
		nodeId: string,
		label: string,
		currentColor: string | undefined,
		anchorEl: HTMLElement,
	): void {
		this.popoverDisposables.clear();
		clearNode(this.popoverEl);

		const header = append(this.popoverEl, $('.ade-mission-popover-header'));
		append(header, $('.ade-mission-popover-title', {}, `${label}`));
		const closeBtn = append(header, $('button.ade-mission-popover-close', { type: 'button' }, '×')) as HTMLButtonElement;
		this.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.close()));

		const grid = append(this.popoverEl, $('.ade-popover-swatch-row'));
		const normCurrent = normalizeAdeNodeColor(currentColor);

		const clearBtn = append(grid, $('button.ade-popover-swatch-btn.is-default', {
			type: 'button',
			title: adeBi(localize('adeColorResetDefault', "Default"), '默认配色'),
		}, '×')) as HTMLButtonElement;
		clearBtn.classList.toggle('is-active', !normCurrent);
		this.popoverDisposables.add(addDisposableListener(clearBtn, EventType.CLICK, async () => {
			await this.delegate.onSetNodeColor?.(nodeId, undefined);
			this.close();
		}));

		for (const preset of ADE_NODE_COLOR_PRESETS) {
			const btn = append(grid, $('button.ade-popover-swatch-btn', {
				type: 'button',
				title: adeBi(preset.labelEn, preset.labelZh),
				'data-color-preset': preset.id,
			})) as HTMLButtonElement;
			btn.style.setProperty('--swatch-hex', preset.hex);
			btn.classList.toggle('is-active', normCurrent === preset.id);
			this.popoverDisposables.add(addDisposableListener(btn, EventType.CLICK, async () => {
				await this.delegate.onSetNodeColor?.(nodeId, preset.id);
				this.close();
			}));
		}

		this.openAtAnchor(anchorEl, 'is-color-popover');
	}

	/**
	 * In-place Glassmorphic Host Quick Selector (`openHostPopover`):
	 * - Displays `local` + all configured SSH Cloud Hosts (OS icon, name/IP, active checkmark) + bottom `Manage Cloud Hosts...` action.
	 * - When `session_started === true`, displays a clear session-reset notice and passes `allowSessionReset: true`.
	 */
	openHostPopover(
		nodeId: string,
		_linkedAgent: IAdeAgent | undefined,
		rawHost: string,
		anchorEl: HTMLElement,
		options?: { readonly staffLabel?: string; readonly currentEngine?: string; readonly currentModel?: string; readonly currentThinking?: string },
	): void {
		this.popoverDisposables.clear();
		clearNode(this.popoverEl);

		const snap = this.delegate.getProjectSnapshot();
		const agentNode = snap?.agents.find(a => a.agent_id === nodeId);
		const sessionStarted = Boolean(agentNode && (agentNode.session_started || agentNode.session_phase !== 'unstarted'));
		const currentHost = (agentNode?.host || rawHost || 'local').trim();
		const curShortEng = normalizeAdeShortEngineId(agentNode?.engine || options?.currentEngine || 'claude');
		const curModel = agentNode?.model || options?.currentModel || MISSION_ENGINE_DEFAULT_MODELS[curShortEng] || 'claude-sonnet-4-5';
		const curEffort = agentNode?.effort || options?.currentThinking || 'medium';

		const header = append(this.popoverEl, $('.ade-mission-popover-header'));
		const titleRow = append(header, $('.ade-mission-model-title-row'));
		append(titleRow, $('.ade-mission-popover-title', {}, adeBi(
			localize('adeHostQuickPickerTitle', "Host Machine"),
			'运行主机 (Host)',
		)));
		append(titleRow, $('span.ade-mission-model-current-pill', {}, currentHost));
		const closeBtn = append(header, $('button.ade-mission-popover-close', { type: 'button' }, '×')) as HTMLButtonElement;
		this.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.close()));

		if (sessionStarted) {
			append(this.popoverEl, $('.ade-popover-session-reset-notice', {
				'data-ade-session-reset-banner': 'true',
			}, adeBi(
				localize('adeQuickHostResetNotice', "Switching host will reset this employee's current session context."),
				'切换主机将重置当前员工会话上下文',
			)));
		}

		const listEl = append(this.popoverEl, $('.ade-popover-engine-list.ade-popover-host-list', {
			role: 'listbox',
			'data-ade-host-popover-list': 'true',
		}));
		const errorEl = append(this.popoverEl, $('.ade-popover-inline-error'));
		errorEl.hidden = true;

		const candidates = collectHostQuickCandidates(snap, this.hostCatalog, currentHost);
		for (const hostItem of candidates) {
			const isCurrent = hostItem.matchKeys.includes(currentHost.toLowerCase());
			const rowBtn = append(listEl, $(`button.ade-popover-engine-option${isCurrent ? '.is-active' : ''}`, {
				type: 'button',
				role: 'option',
				'aria-selected': isCurrent ? 'true' : 'false',
				'data-ade-host-option': hostItem.value,
			})) as HTMLButtonElement;

			const lead = append(rowBtn, $('.ade-mission-engine-option-lead'));
			const osIconEl = append(lead, $('span.ade-mission-os-icon'));
			renderAdeOsIcon(osIconEl, hostItem.osKind, { baseClass: 'ade-mission-os-icon', prefix: 'ade-os' });
			const textCol = append(lead, $('.ade-popover-option-texts'));
			append(textCol, $('span.ade-popover-option-primary', {}, hostItem.title));
			append(textCol, $('span.ade-popover-option-secondary', {}, hostItem.subtitle));

			const rightWrap = append(rowBtn, $('.ade-popover-option-right'));
			if (isCurrent) {
				append(rightWrap, $('span.codicon.codicon-check.ade-popover-option-check', { 'aria-hidden': 'true' }));
			}

			this.popoverDisposables.add(addDisposableListener(rowBtn, EventType.CLICK, async () => {
				if (!snap) {
					return;
				}
				if (isCurrent) {
					this.close();
					return;
				}
				rowBtn.disabled = true;
				errorEl.hidden = true;
				try {
					const probedEngines = await this.hostCatalog.probeControlCenterEngines(hostItem.value);
					const normEngines = probedEngines.map(id => normalizeAdeShortEngineId(id));
					const nextEng = normEngines.length === 0 || normEngines.includes(curShortEng)
						? curShortEng
						: normEngines[0];
					const probedModels = await this.hostCatalog.probeControlCenterModels(hostItem.value, nextEng);
					const nextModel = nextEng === curShortEng && probedModels.models.includes(curModel)
						? curModel
						: (probedModels.models[0] ?? MISSION_ENGINE_DEFAULT_MODELS[nextEng] ?? curModel);
					const nextEffort = probedModels.efforts.length === 0 || probedModels.efforts.includes(curEffort)
						? curEffort
						: (probedModels.efforts.includes('medium') ? 'medium' : probedModels.efforts[0]);

					await this.delegate.onEditAgent({
						projectId: snap.meta.project_id,
						agentId: nodeId,
						host: hostItem.value,
						...(nextEng !== curShortEng ? { engine: nextEng } : {}),
						model: nextModel,
						effort: nextEffort,
						...(sessionStarted ? { allowSessionReset: true } : {}),
					});
					this.close();
				} catch (err) {
					rowBtn.disabled = false;
					errorEl.textContent = err instanceof Error ? err.message : String(err);
					errorEl.hidden = false;
				}
			}));
		}

		const footer = append(this.popoverEl, $('.ade-popover-quick-footer'));
		const manageBtn = append(footer, $('button.ade-popover-manage-hosts-btn', {
			type: 'button',
			'data-ade-manage-cloud-hosts': 'true',
		})) as HTMLButtonElement;
		append(manageBtn, $('span.codicon.codicon-remote', { 'aria-hidden': 'true' }));
		append(manageBtn, $('span', {}, adeBi(
			localize('adeQuickManageCloudHostsBtn', "Manage Cloud Hosts..."),
			'管理云主机...',
		)));
		this.popoverDisposables.add(addDisposableListener(manageBtn, EventType.CLICK, () => {
			this.close();
			this.delegate.onManageCloudHosts?.();
		}));

		this.openAtAnchor(anchorEl, 'is-host-popover');
	}

	/**
	 * In-place Glassmorphic Engine Quick Selector (`openEnginePopover`):
	 * - Always interactive (`disabled = false` on all installed engines even when `session_started === true`).
	 * - Displays a session-reset notice when `session_started === true` and passes `allowSessionReset: true`.
	 */
	openEnginePopover(
		nodeId: string,
		_linkedAgent: IAdeAgent | undefined,
		rawEngineId: string,
		anchorEl: HTMLElement,
		options?: { readonly staffLabel?: string; readonly hostAlias?: string; readonly currentModel?: string; readonly currentThinking?: string },
	): void {
		this.popoverDisposables.clear();
		clearNode(this.popoverEl);
		const myGen = ++this.popGen;

		const snap = this.delegate.getProjectSnapshot();
		const agentNode = snap?.agents.find(a => a.agent_id === nodeId);
		const sessionStarted = Boolean(agentNode && (agentNode.session_started || agentNode.session_phase !== 'unstarted'));
		const hostKey = agentNode?.host || options?.hostAlias || 'local';
		const currentShort = normalizeAdeShortEngineId(agentNode?.engine ?? rawEngineId);

		const header = append(this.popoverEl, $('.ade-mission-popover-header'));
		const titleRow = append(header, $('.ade-mission-model-title-row'));
		append(titleRow, $('.ade-mission-popover-title', {}, adeBi(
			localize('adeEngineQuickPickerTitle', "Coding Engine"),
			'编码引擎 (Engine)',
		)));
		append(titleRow, $('span.ade-mission-model-current-pill', {}, MISSION_ENGINE_FALLBACK_NAMES[currentShort] ?? currentShort));
		const closeBtn = append(header, $('button.ade-mission-popover-close', { type: 'button' }, '×')) as HTMLButtonElement;
		this.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.close()));

		if (sessionStarted) {
			append(this.popoverEl, $('.ade-popover-session-reset-notice', {
				'data-ade-session-reset-banner': 'true',
			}, adeBi(
				localize('adeQuickEngineResetNotice', "Switching engine will reset this employee's current session context."),
				'切换引擎将重置当前员工会话上下文',
			)));
		}

		const listEl = append(this.popoverEl, $('.ade-popover-engine-list', {
			role: 'listbox',
			'data-ade-engine-popover-list': 'true',
		}));
		const errorEl = append(this.popoverEl, $('.ade-popover-inline-error'));
		errorEl.hidden = true;

		const renderList = (availableShorts: ReadonlySet<string> | undefined) => {
			clearNode(listEl);
			for (const shortEng of ADE_REGISTERED_ENGINES) {
				const isCurrent = shortEng === currentShort;
				const isInstalled = !availableShorts || availableShorts.size === 0 || availableShorts.has(shortEng);
				const rowBtn = append(listEl, $(`button.ade-popover-engine-option${isCurrent ? '.is-active' : ''}`, {
					type: 'button',
					role: 'option',
					'aria-selected': isCurrent ? 'true' : 'false',
					'data-ade-engine-option': shortEng,
				})) as HTMLButtonElement;
				rowBtn.disabled = !isInstalled && !isCurrent;

				const lead = append(rowBtn, $('.ade-mission-engine-option-lead'));
				const iconEl = append(lead, $('span.ade-mission-engine-icon'));
				applyMissionEngineIcon(iconEl, this.hostCatalog.getEngineIcon(toPrefixedAdeEngineId(shortEng)));
				append(lead, $('span', {}, `${MISSION_ENGINE_FALLBACK_NAMES[shortEng] ?? shortEng}`));

				const rightWrap = append(rowBtn, $('.ade-popover-option-right'));
				if (!isInstalled && !isCurrent) {
					append(rightWrap, $('span.ade-popover-engine-tag', {}, adeBi(localize('adeEngMissingTag', "Not Installed"), '未安装')));
				} else {
					append(rightWrap, $('span.ade-popover-engine-tag', {}, shortEng));
				}
				if (isCurrent) {
					append(rightWrap, $('span.codicon.codicon-check.ade-popover-option-check', { 'aria-hidden': 'true' }));
				}

				this.popoverDisposables.add(addDisposableListener(rowBtn, EventType.CLICK, async () => {
					if (!snap) {
						return;
					}
					if (isCurrent) {
						this.close();
						return;
					}
					rowBtn.disabled = true;
					errorEl.hidden = true;
					try {
						const probed = await this.hostCatalog.probeControlCenterModels(hostKey, shortEng);
						const nextModel = probed.models[0] ?? MISSION_ENGINE_DEFAULT_MODELS[shortEng] ?? 'claude-sonnet-4-5';
						const curEffort = agentNode?.effort || options?.currentThinking || 'medium';
						const nextEffort = probed.efforts.length > 0 && !probed.efforts.includes(curEffort)
							? (probed.efforts.includes('medium') ? 'medium' : probed.efforts[0])
							: curEffort;
						await this.delegate.onEditAgent({
							projectId: snap.meta.project_id,
							agentId: nodeId,
							engine: shortEng,
							model: nextModel,
							effort: nextEffort,
							...(sessionStarted ? { allowSessionReset: true } : {}),
						});
						this.close();
					} catch (err) {
						rowBtn.disabled = false;
						errorEl.textContent = err instanceof Error ? err.message : String(err);
						errorEl.hidden = false;
					}
				}));
			}
		};

		renderList(undefined);
		void this.hostCatalog.probeControlCenterEngines(hostKey).then(list => {
			if (myGen !== this.popGen || this.popoverDisposables.isDisposed) {
				return;
			}
			const shorts = new Set<string>(list.map(id => normalizeAdeShortEngineId(id)));
			renderList(shorts);
		});

		this.openAtAnchor(anchorEl, 'is-cascade-popover');
	}

	/**
	 * In-place Glassmorphic Model Quick Selector (`openModelPopover`):
	 * - Strictly displays ONLY real probed models for the employee's host + engine (zero fake placeholder catalog).
	 * - Supports real-time search filtering & 12-vendor group headers via `buildModelGlassSelectItem`, plus custom ID input.
	 */
	openModelPopover(
		nodeId: string,
		_linkedAgent: IAdeAgent | undefined,
		rawEngineId: string,
		anchorEl: HTMLElement,
		options?: { readonly currentModel?: string; readonly currentThinking?: string; readonly hostAlias?: string },
	): void {
		this.popoverDisposables.clear();
		clearNode(this.popoverEl);
		const myGen = ++this.popGen;

		const snap = this.delegate.getProjectSnapshot();
		const agentNode = snap?.agents.find(a => a.agent_id === nodeId);
		const shortEng = normalizeAdeShortEngineId(agentNode?.engine ?? rawEngineId);
		const hostKey = agentNode?.host || options?.hostAlias || 'local';
		let activeModel = agentNode?.model || options?.currentModel || MISSION_ENGINE_DEFAULT_MODELS[shortEng] || 'claude-sonnet-4-5';

		const header = append(this.popoverEl, $('.ade-mission-popover-header'));
		const titleRow = append(header, $('.ade-mission-model-title-row'));
		append(titleRow, $('.ade-mission-popover-title', {}, adeBi(
			localize('adeModelQuickPickerTitle', "Switch Model"),
			'切换模型 (Model)',
		)));
		append(titleRow, $('span.ade-mission-model-current-pill', {}, activeModel));
		const closeBtn = append(header, $('button.ade-mission-popover-close', { type: 'button' }, '×')) as HTMLButtonElement;
		this.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.close()));

		const body = append(this.popoverEl, $('.ade-popover-cascade-form'));

		const searchWrap = append(body, $('.ade-glass-select-search-wrap'));
		append(searchWrap, $('span.ade-glass-select-search-icon.codicon.codicon-search', { 'aria-hidden': 'true' }));
		const searchInput = append(searchWrap, $('input.ade-glass-select-search-input', {
			type: 'text',
			placeholder: adeBi(localize('adeQuickModelSearchPh', "Search model or vendor..."), '搜索模型或厂商…'),
			'data-ade-quick-model-search': 'true',
		})) as HTMLInputElement;

		const listEl = append(body, $('.ade-glass-select-list.ade-quick-model-grouped-list', {
			role: 'listbox',
			'data-ade-model-popover-list': 'true',
		}));

		const errorEl = append(body, $('.ade-popover-inline-error'));
		errorEl.hidden = true;

		let probedModelIds: readonly string[] = [activeModel];
		let filterQuery = '';

		const applyModelSelection = async (nextModel: string) => {
			if (!snap) {
				return;
			}
			errorEl.hidden = true;
			try {
				await this.delegate.onEditAgent({
					projectId: snap.meta.project_id,
					agentId: nodeId,
					model: nextModel,
				});
				this.close();
			} catch (err) {
				errorEl.textContent = err instanceof Error ? err.message : String(err);
				errorEl.hidden = false;
			}
		};

		const renderModelList = () => {
			clearNode(listEl);
			const dedupIds: string[] = [];
			const seen = new Set<string>();
			for (const id of [activeModel, ...probedModelIds]) {
				const trimmed = id?.trim();
				if (!trimmed || seen.has(trimmed.toLowerCase())) {
					continue;
				}
				seen.add(trimmed.toLowerCase());
				dedupIds.push(trimmed);
			}

			const allItems: IAdeGlassSelectItem[] = dedupIds.map(id => buildModelGlassSelectItem(id));
			const q = filterQuery.trim().toLowerCase();
			const filtered = q
				? allItems.filter(item => `${item.label} ${item.value} ${item.group ?? ''} ${item.description ?? ''} ${item.searchKeywords ?? ''}`.toLowerCase().includes(q))
				: allItems;

			if (filtered.length === 0) {
				append(listEl, $('.ade-glass-select-empty', {}, adeBi(localize('adeQuickModelNoMatches', "No matching models"), '无匹配模型')));
				return;
			}

			const groupOrder: string[] = [];
			const byGroup = new Map<string, IAdeGlassSelectItem[]>();
			for (const item of filtered) {
				const g = item.group || 'Custom';
				let bucket = byGroup.get(g);
				if (!bucket) {
					bucket = [];
					byGroup.set(g, bucket);
					groupOrder.push(g);
				}
				bucket.push(item);
			}

			groupOrder.forEach((groupName, gIdx) => {
				const groupItems = byGroup.get(groupName)!;
				const gHead = append(listEl, $(`.ade-glass-select-group-header${gIdx === 0 ? '.is-first' : ''}`, {
					'data-ade-select-group': groupName,
				}));
				append(gHead, $('span.ade-glass-select-group-title', {}, groupName));
				append(gHead, $('span.ade-glass-select-group-count', {}, String(groupItems.length)));

				for (const item of groupItems) {
					const isSelected = item.value === activeModel;
					const btn = append(listEl, $(`button.ade-glass-select-option${isSelected ? '.is-selected' : ''}`, {
						type: 'button',
						role: 'option',
						'aria-selected': isSelected ? 'true' : 'false',
						'data-ade-model-option': item.value,
					})) as HTMLButtonElement;

					const lead = append(btn, $('span.ade-glass-select-option-lead'));
					if (item.vendorIcon) {
						const ico = append(lead, $('span.ade-glass-select-option-icon'));
						renderAdeLlmIcon(ico, item.vendorIcon, {
							baseClass: 'ade-glass-select-option-icon',
							prefix: 'ade-llm',
						});
					}
					const texts = append(lead, $('span.ade-glass-select-option-texts'));
					append(texts, $('span.ade-glass-select-option-label', {}, item.label));
					if (item.description && item.description !== item.label) {
						append(texts, $('span.ade-glass-select-option-desc', {}, item.description));
					}

					const right = append(btn, $('span.ade-glass-select-option-right'));
					if (item.badge) {
						append(right, $('span.ade-glass-select-option-badge', {}, item.badge));
					}
					if (isSelected) {
						append(right, $('span.ade-glass-select-option-check.codicon.codicon-check', { 'aria-hidden': 'true' }));
					}

					this.popoverDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
						activeModel = item.value;
						void applyModelSelection(activeModel);
					}));
				}
			});
		};

		this.popoverDisposables.add(addDisposableListener(searchInput, EventType.INPUT, () => {
			filterQuery = searchInput.value;
			renderModelList();
		}));

		const customRow = append(body, $('.ade-popover-inline-input-row'));
		const customInput = append(customRow, $('input.ade-popover-input', {
			type: 'text',
			placeholder: adeBi(localize('adeQuickCustomModelPh', "Or enter custom model ID..."), '或输入自定义模型 ID…'),
			'data-ade-quick-model-input': 'true',
		})) as HTMLInputElement;
		const applyCustomBtn = append(customRow, $('button.ade-mission-token-action-btn.primary', {
			type: 'button',
		}, adeBi(localize('adeApplyModelBtn', "Apply"), '应用'))) as HTMLButtonElement;
		this.popoverDisposables.add(addDisposableListener(applyCustomBtn, EventType.CLICK, () => {
			const val = customInput.value.trim();
			if (val) {
				activeModel = val;
				void applyModelSelection(activeModel);
			}
		}));

		renderModelList();
		void this.hostCatalog.probeControlCenterModels(hostKey, shortEng).then(probed => {
			if (myGen !== this.popGen || this.popoverDisposables.isDisposed) {
				return;
			}
			probedModelIds = probed.models;
			renderModelList();
		});

		this.openAtAnchor(anchorEl, 'is-model-popover');
		searchInput.focus();
	}

	/**
	 * Dedicated In-place Thinking Effort Quick Selector (`openEffortPopover`):
	 * - Lists all thinking effort levels genuinely supported by the employee's active engine
	 *   (e.g. `low / medium / high / xhigh / max`), switching with a single click.
	 */
	openEffortPopover(
		nodeId: string,
		_linkedAgent: IAdeAgent | undefined,
		rawEngineId: string,
		anchorEl: HTMLElement,
		options?: { readonly currentThinking?: string; readonly hostAlias?: string },
	): void {
		this.popoverDisposables.clear();
		clearNode(this.popoverEl);
		const myGen = ++this.popGen;

		const snap = this.delegate.getProjectSnapshot();
		const agentNode = snap?.agents.find(a => a.agent_id === nodeId);
		const shortEng = normalizeAdeShortEngineId(agentNode?.engine ?? rawEngineId);
		const hostKey = agentNode?.host || options?.hostAlias || 'local';
		const activeEffort = agentNode?.effort || options?.currentThinking || 'medium';

		const header = append(this.popoverEl, $('.ade-mission-popover-header'));
		const titleRow = append(header, $('.ade-mission-model-title-row'));
		append(titleRow, $('.ade-mission-popover-title', {}, adeBi(
			localize('adeEffortQuickPickerTitle', "Thinking Effort"),
			'思考程度 (Effort)',
		)));
		append(titleRow, $('span.ade-mission-model-current-pill', {}, activeEffort));
		const closeBtn = append(header, $('button.ade-mission-popover-close', { type: 'button' }, '×')) as HTMLButtonElement;
		this.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.close()));

		const listEl = append(this.popoverEl, $('.ade-popover-engine-list.ade-popover-effort-list', {
			role: 'listbox',
			'data-ade-effort-popover-list': 'true',
		}));
		const errorEl = append(this.popoverEl, $('.ade-popover-inline-error'));
		errorEl.hidden = true;

		const renderEfforts = (efforts: readonly string[]) => {
			clearNode(listEl);
			const baseList = efforts.length > 0 ? [...efforts] : [...MISSION_THINKING_LEVEL_OPTIONS];
			if (activeEffort && !baseList.includes(activeEffort)) {
				baseList.unshift(activeEffort);
			}
			for (const eff of baseList) {
				const isCurrent = eff === activeEffort;
				const rowBtn = append(listEl, $(`button.ade-popover-engine-option.ade-popover-effort-option${isCurrent ? '.is-active' : ''}`, {
					type: 'button',
					role: 'option',
					'aria-selected': isCurrent ? 'true' : 'false',
					'data-ade-effort-option': eff,
				})) as HTMLButtonElement;

				const lead = append(rowBtn, $('.ade-mission-engine-option-lead'));
				append(lead, $('span.codicon.codicon-sparkle', { 'aria-hidden': 'true' }));
				const textCol = append(lead, $('.ade-popover-option-texts'));
				append(textCol, $('span.ade-popover-option-primary', {}, eff));
				const descMeta = EFFORT_DESCRIPTIONS[eff.toLowerCase()];
				if (descMeta) {
					append(textCol, $('span.ade-popover-option-secondary', {}, adeBi(descMeta.en, descMeta.zh)));
				}

				const rightWrap = append(rowBtn, $('.ade-popover-option-right'));
				if (isCurrent) {
					append(rightWrap, $('span.codicon.codicon-check.ade-popover-option-check', { 'aria-hidden': 'true' }));
				}

				this.popoverDisposables.add(addDisposableListener(rowBtn, EventType.CLICK, async () => {
					if (!snap) {
						return;
					}
					if (isCurrent) {
						this.close();
						return;
					}
					rowBtn.disabled = true;
					errorEl.hidden = true;
					try {
						await this.delegate.onEditAgent({
							projectId: snap.meta.project_id,
							agentId: nodeId,
							effort: eff,
						});
						this.close();
					} catch (err) {
						rowBtn.disabled = false;
						errorEl.textContent = err instanceof Error ? err.message : String(err);
						errorEl.hidden = false;
					}
				}));
			}
		};

		renderEfforts(MISSION_THINKING_LEVEL_OPTIONS);
		void this.hostCatalog.probeControlCenterModels(hostKey, shortEng).then(probed => {
			if (myGen !== this.popGen || this.popoverDisposables.isDisposed) {
				return;
			}
			renderEfforts(probed.efforts);
		});

		this.openAtAnchor(anchorEl, 'is-effort-popover');
	}

	openCreateAgentPopover(
		options: Omit<ICreateAgentPopoverOptions, 'onCreateAgent' | 'onFeedback'>,
		openTarget: { readonly anchorEl?: HTMLElement; readonly clientX?: number; readonly clientY?: number },
	): void {
		renderCreateAgentCascadePopover(this, this.hostCatalog, {
			...options,
			onCreateAgent: input => this.delegate.onCreateAgent(input),
			onFeedback: (msg, kind) => this.delegate.onActionFeedback?.(msg, kind),
		}, openTarget);
	}

	openEditAgentPopover(
		snapshot: IAdeProjectSnapshot,
		agent: IAdeAgentNode,
		anchorEl: HTMLElement,
	): void {
		const opts: IEditAgentPopoverOptions = {
			snapshot,
			agent,
			onEditAgent: input => this.delegate.onEditAgent(input),
			onDeleteAgent: this.delegate.onDeleteAgent ? id => this.delegate.onDeleteAgent!(id) : undefined,
			onOpenSession: this.delegate.onOpenAgentSession ? (id, side) => this.delegate.onOpenAgentSession!(id, side) : undefined,
			onFeedback: (msg, kind) => this.delegate.onActionFeedback?.(msg, kind),
		};
		renderEditAgentPopover(this, this.hostCatalog, opts, anchorEl);
	}

	openCreateDepartmentPopover(
		snapshot: IAdeProjectSnapshot,
		openTarget: { readonly anchorEl?: HTMLElement; readonly clientX?: number; readonly clientY?: number },
		defaultRootAgentId?: string,
	): void {
		if (!this.delegate.onCreateDepartment) {
			return;
		}
		const opts: ICreateDepartmentPopoverOptions = {
			snapshot,
			defaultRootAgentId,
			onCreateDepartment: (rootId, name, color) => this.delegate.onCreateDepartment!(rootId, name, color),
			onFeedback: (msg, kind) => this.delegate.onActionFeedback?.(msg, kind),
		};
		renderCreateDepartmentPopover(this, opts, openTarget);
	}

	openEditDepartmentPopover(
		snapshot: IAdeProjectSnapshot,
		department: IAdeDepartment,
		currentColorToken: string | undefined,
		openTarget: { readonly anchorEl?: HTMLElement; readonly clientX?: number; readonly clientY?: number },
	): void {
		if (!this.delegate.onEditDepartment || !this.delegate.onToggleDepartmentMember || !this.delegate.onDeleteDepartment) {
			return;
		}
		const opts: IEditDepartmentPopoverOptions = {
			snapshot,
			department,
			currentColorToken,
			onEditDepartment: (id, patch) => this.delegate.onEditDepartment!(id, patch),
			onToggleMember: (id, aid, act) => this.delegate.onToggleDepartmentMember!(id, aid, act),
			onDeleteDepartment: id => this.delegate.onDeleteDepartment!(id),
			onFeedback: (msg, kind) => this.delegate.onActionFeedback?.(msg, kind),
		};
		renderEditDepartmentPopover(this, opts, openTarget);
	}

	openCreateWhiteboardPopover(
		snapshot: IAdeProjectSnapshot,
		openTarget: { readonly anchorEl?: HTMLElement; readonly clientX?: number; readonly clientY?: number },
		defaults?: { readonly deptId?: string | null; readonly ownerId?: string | null; readonly canvasX?: number; readonly canvasY?: number },
	): void {
		if (!this.delegate.onCreateWhiteboard) {
			return;
		}
		const opts: ICreateWhiteboardPopoverOptions = {
			snapshot,
			defaultDeptId: defaults?.deptId,
			defaultOwnerId: defaults?.ownerId,
			canvasX: defaults?.canvasX,
			canvasY: defaults?.canvasY,
			onCreateWhiteboard: input => this.delegate.onCreateWhiteboard!(input),
			onFeedback: (msg, kind) => this.delegate.onActionFeedback?.(msg, kind),
		};
		renderCreateWhiteboardPopover(this, this.hostCatalog, opts, openTarget);
	}
}
