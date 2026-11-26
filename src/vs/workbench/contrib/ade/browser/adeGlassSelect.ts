/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/adeGlassSelect.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AdeLlmProviderKind, renderAdeLlmIcon } from '../../../browser/adeLlmIcon.js';
import { AdeOsIconKind, renderAdeOsIcon } from '../../../browser/adeOsIcon.js';
import { adeBi } from '../common/adeLocalization.js';

export type AdeModelVendorGroup =
	| 'Anthropic'
	| 'OpenAI'
	| 'Google'
	| 'DeepSeek'
	| 'Qwen'
	| 'Moonshot'
	| 'Zhipu'
	| 'MiniMax'
	| 'xAI'
	| 'Meta'
	| 'Mistral'
	| 'Custom';

export interface IAdeGlassSelectItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
	readonly badge?: string;
	readonly group?: string;
	readonly icon?: string;
	readonly vendorIcon?: AdeLlmProviderKind;
	readonly osIcon?: AdeOsIconKind;
	readonly disabled?: boolean;
	readonly searchKeywords?: string;
}

export interface IAdeGlassSelectOptions {
	readonly container: HTMLElement;
	readonly portalContainer?: HTMLElement;
	readonly items?: readonly IAdeGlassSelectItem[];
	readonly value?: string;
	readonly placeholder?: string;
	readonly ariaLabel?: string;
	readonly className?: string;
	readonly attributes?: Readonly<Record<string, string>>;
	readonly disabled?: boolean;
	readonly searchable?: boolean;
	readonly searchPlaceholder?: string;
	readonly minMenuWidth?: number;
}

const AUTO_SEARCH_THRESHOLD = 8;

interface IClassifiedModelMeta {
	readonly group: AdeModelVendorGroup;
	readonly vendorIcon: AdeLlmProviderKind;
	readonly cleanSlug: string;
	readonly providerSegment?: string;
}

function matchModelVendorToken(token: string): { readonly group: AdeModelVendorGroup; readonly vendorIcon: AdeLlmProviderKind } | undefined {
	const lower = token.trim().toLowerCase();
	if (!lower) {
		return undefined;
	}
	if (/(^|[/:._\-\s])(anthropic|claude|sonnet|opus|haiku|fable|mythos)($|[/:._\-\s\d])/.test(lower) || lower.startsWith('claude')) {
		return { group: 'Anthropic', vendorIcon: 'anthropic' };
	}
	if (/(^|[/:._\-\s])(openai|gpt|chatgpt|codex|o1|o3|o4)($|[/:._\-\s\d])/.test(lower) || lower.startsWith('gpt-')) {
		return { group: 'OpenAI', vendorIcon: 'openai' };
	}
	if (/(^|[/:._\-\s])(google|gemini|gemma|vertex|learnlm|argon|neon|carbon|hydrogen)($|[/:._\-\s\d])/.test(lower) || lower.startsWith('gemini')) {
		return { group: 'Google', vendorIcon: 'gemini' };
	}
	if (/(^|[/:._\-\s])(deepseek|ds-r1|ds-v3|ds-v4|ds_r1|ds_v3|ds_v4)($|[/:._\-\s\d[])/.test(lower) || lower.includes('deepseek')) {
		return { group: 'DeepSeek', vendorIcon: 'deepseek' };
	}
	if (/(^|[/:._\-\s])(qwen|qwq|qvq|alibaba|dashscope|tongyi)($|[/:._\-\s\d])/.test(lower) || lower.startsWith('qwen')) {
		return { group: 'Qwen', vendorIcon: 'qwen' };
	}
	if (/(^|[/:._\-\s])(moonshot|kimi)($|[/:._\-\s\d])/.test(lower) || lower.startsWith('kimi')) {
		return { group: 'Moonshot', vendorIcon: 'kimi' };
	}
	if (/(^|[/:._\-\s])(zhipu|zai|bigmodel|glm|chatglm|codegeex)($|[/:._\-\s\d])/.test(lower) || lower.startsWith('glm')) {
		return { group: 'Zhipu', vendorIcon: 'glm' };
	}
	if (/(^|[/:._\-\s])(minimax|abab)($|[/:._\-\s\d])/.test(lower) || lower.includes('minimax')) {
		return { group: 'MiniMax', vendorIcon: 'minimax' };
	}
	if (/(^|[/:._\-\s])(xai|x-ai|grok)($|[/:._\-\s\d])/.test(lower) || lower.startsWith('grok')) {
		return { group: 'xAI', vendorIcon: 'grok' };
	}
	if (/(^|[/:._\-\s])(meta|meta-llama|llama|codellama)($|[/:._\-\s\d])/.test(lower) || lower.startsWith('llama')) {
		return { group: 'Meta', vendorIcon: 'meta' };
	}
	if (/(^|[/:._\-\s])(mistral|mistralai|mixtral|codestral|pixtral|ministral|devstral)($|[/:._\-\s\d])/.test(lower) || lower.includes('mistral')) {
		return { group: 'Mistral', vendorIcon: 'mistral' };
	}
	return undefined;
}

function classifyRawModelId(rawModelId: string): IClassifiedModelMeta {
	const trimmed = rawModelId.trim();
	let inspectTarget = trimmed;
	let providerSegment: string | undefined;

	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed) && typeof parsed[1] === 'string') {
				providerSegment = typeof parsed[0] === 'string' ? parsed[0] : undefined;
				inspectTarget = parsed[1].trim();
			}
		} catch {
			// Ignore malformed tuple string and fall back to raw string classification.
		}
	} else {
		const slashIdx = trimmed.indexOf('/');
		if (slashIdx > 0 && slashIdx < trimmed.length - 1) {
			providerSegment = trimmed.slice(0, slashIdx).trim();
			inspectTarget = trimmed.slice(slashIdx + 1).trim();
		}
	}

	if (providerSegment) {
		const byProvider = matchModelVendorToken(providerSegment);
		if (byProvider) {
			return {
				group: byProvider.group,
				vendorIcon: byProvider.vendorIcon,
				cleanSlug: inspectTarget,
				providerSegment,
			};
		}
	}

	const bySlug = matchModelVendorToken(inspectTarget) ?? matchModelVendorToken(trimmed);
	if (bySlug) {
		return {
			group: bySlug.group,
			vendorIcon: bySlug.vendorIcon,
			cleanSlug: inspectTarget,
			providerSegment,
		};
	}

	return {
		group: 'Custom',
		vendorIcon: 'generic',
		cleanSlug: inspectTarget || rawModelId,
		providerSegment,
	};
}

function inferModelCapabilityTag(slugLower: string): string | undefined {
	if (/(reasoner|thinking|\br1\b|\bo1\b|\bo3\b|\bo4\b|\bqwq\b)/.test(slugLower)) {
		return 'Reasoning';
	}
	if (/(codex|coder|codestral|devstral|codegeex|codellama)/.test(slugLower)) {
		return 'Coding';
	}
	if (/(haiku|flash|mini|nano|fast)/.test(slugLower)) {
		return 'Fast';
	}
	return undefined;
}

/**
 * Builds a structured `IAdeGlassSelectItem` from a raw model identifier while preserving
 * `.value === rawModelId` byte-for-byte without modification.
 */
export function buildModelGlassSelectItem(rawModelId: string): IAdeGlassSelectItem {
	const meta = classifyRawModelId(rawModelId);
	const capTag = inferModelCapabilityTag(meta.cleanSlug.toLowerCase());
	const hasDistinctProvider = Boolean(meta.providerSegment && meta.cleanSlug !== rawModelId);
	const subtitleParts: string[] = [];
	if (hasDistinctProvider) {
		subtitleParts.push(rawModelId);
	} else {
		subtitleParts.push(meta.group);
	}
	if (capTag) {
		subtitleParts.push(capTag);
	}
	return {
		value: rawModelId,
		label: meta.cleanSlug || rawModelId,
		description: subtitleParts.join(' · '),
		badge: capTag,
		group: meta.group,
		vendorIcon: meta.vendorIcon,
		searchKeywords: `${rawModelId} ${meta.group} ${meta.cleanSlug} ${meta.providerSegment ?? ''} ${capTag ?? ''}`.trim(),
	};
}

let activeOpenGlassSelect: AdeGlassSelect | undefined;

/**
 * Custom-drawn Glassmorphic Portal Select (`AdeGlassSelect`):
 * - 100% TrustedTypes CSP safe (pure `dom.$` + `codicon-*` DOM construction).
 * - Mounts floating menu on `portalContainer` with `data-ade-select-portal="true"` (`position: fixed; z-index: 10050`),
 *   auto-flips above/below viewport edges, tracks ancestor scroll & window resize, stops wheel propagation,
 *   and supports two-stage `Escape` (first `Escape` closes only the dropdown portal; second `Escape` reaches parent popover).
 * - Exposes `.value`, `.disabled`, and `'change'` event compatibility shims directly on `triggerEl`.
 */
export class AdeGlassSelect extends Disposable {
	readonly triggerEl: HTMLButtonElement;

	private readonly triggerIconEl: HTMLElement;
	private readonly triggerLabelEl: HTMLElement;
	private readonly triggerTrailingEl: HTMLElement;

	private readonly portalDisposables = this._register(new DisposableStore());
	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;

	private readonly portalContainer: HTMLElement;
	private readonly placeholder: string;
	private readonly searchableSetting: boolean | undefined;
	private readonly searchPlaceholder: string;
	private readonly minMenuWidth: number;
	private readonly setNativeDisabled: (disabled: boolean) => void;

	private items: readonly IAdeGlassSelectItem[] = [];
	private _value = '';
	private _disabled = false;
	private _dispatchingInternalChange = false;

	private portalEl: HTMLElement | undefined;
	private searchInputEl: HTMLInputElement | undefined;
	private listEl: HTMLElement | undefined;
	private filterQuery = '';
	private focusedOptionIndex = -1;
	private visibleOptionButtons: { readonly item: IAdeGlassSelectItem; readonly btn: HTMLButtonElement }[] = [];

	constructor(options: IAdeGlassSelectOptions) {
		super();

		this.portalContainer = options.portalContainer ?? options.container.ownerDocument.body;
		this.placeholder = options.placeholder ?? adeBi(localize('adeGlassSelectPlaceholder', "Select..."), '请选择…');
		this.searchableSetting = options.searchable;
		this.searchPlaceholder = options.searchPlaceholder ?? adeBi(localize('adeGlassSelectSearchPh', "Filter options..."), '搜索筛选项…');
		this.minMenuWidth = options.minMenuWidth ?? 168;

		this.triggerEl = append(options.container, $('button.ade-glass-select-trigger', {
			type: 'button',
			'aria-haspopup': 'listbox',
			'aria-expanded': 'false',
		})) as HTMLButtonElement;

		if (options.className) {
			for (const cls of options.className.split(/\s+/).filter(Boolean)) {
				this.triggerEl.classList.add(cls);
			}
		}
		if (options.ariaLabel) {
			this.triggerEl.setAttribute('aria-label', options.ariaLabel);
		}
		if (options.attributes) {
			for (const [attrKey, attrVal] of Object.entries(options.attributes)) {
				this.triggerEl.setAttribute(attrKey, attrVal);
			}
		}

		const leadEl = append(this.triggerEl, $('span.ade-glass-select-trigger-lead'));
		this.triggerIconEl = append(leadEl, $('span.ade-glass-select-trigger-icon'));
		this.triggerIconEl.hidden = true;
		this.triggerLabelEl = append(leadEl, $('span.ade-glass-select-trigger-label'));
		this.triggerTrailingEl = append(this.triggerEl, $('span.ade-glass-select-trigger-trailing.codicon.codicon-chevron-down.is-chevron', {
			'aria-hidden': 'true',
		}));

		const proto = Object.getPrototypeOf(this.triggerEl) as HTMLButtonElement;
		const nativeDisabledDesc = Object.getOwnPropertyDescriptor(proto, 'disabled')
			?? Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'disabled');
		this.setNativeDisabled = (flag: boolean) => {
			if (nativeDisabledDesc?.set) {
				nativeDisabledDesc.set.call(this.triggerEl, flag);
			} else if (flag) {
				this.triggerEl.setAttribute('disabled', '');
			} else {
				this.triggerEl.removeAttribute('disabled');
			}
		};

		this.installTriggerShims();

		this.items = options.items ? [...options.items] : [];
		if (options.value !== undefined) {
			this._value = options.value;
		} else if (this.items.length > 0) {
			this._value = this.items[0].value;
		}
		this.setDisabled(Boolean(options.disabled));
		this.syncTriggerDisplay();

		this._register(addDisposableListener(this.triggerEl, EventType.CLICK, (e: MouseEvent) => {
			e.stopPropagation();
			if (this._disabled) {
				return;
			}
			this.toggle();
		}));

		this._register(addDisposableListener(this.triggerEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (this._disabled) {
				return;
			}
			if (!this.isOpen() && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ')) {
				e.preventDefault();
				e.stopPropagation();
				this.open();
			}
		}));

		this._register(addDisposableListener(this.triggerEl, EventType.CHANGE, () => {
			if (!this._dispatchingInternalChange) {
				this._onDidChange.fire(this._value);
			}
		}));
	}

	get element(): HTMLButtonElement {
		return this.triggerEl;
	}

	get value(): string {
		return this._value;
	}

	set value(next: string) {
		const normalized = String(next ?? '');
		this._value = normalized;
		this.syncTriggerDisplay();
		if (this.isOpen()) {
			this.renderOptionsList();
		}
	}

	get disabled(): boolean {
		return this._disabled;
	}

	set disabled(next: boolean) {
		this.setDisabled(next);
	}

	setDisabled(disabled: boolean): void {
		const next = Boolean(disabled);
		this._disabled = next;
		this.setNativeDisabled(next);
		this.triggerEl.classList.toggle('is-disabled', next);
		if (next) {
			this.triggerEl.setAttribute('aria-disabled', 'true');
			this.triggerTrailingEl.className = 'ade-glass-select-trigger-trailing codicon codicon-lock is-lock';
			if (this.isOpen()) {
				this.close();
			}
		} else {
			this.triggerEl.removeAttribute('aria-disabled');
			this.triggerTrailingEl.className = 'ade-glass-select-trigger-trailing codicon codicon-chevron-down is-chevron';
		}
	}

	getItems(): readonly IAdeGlassSelectItem[] {
		return this.items;
	}

	setItems(items: readonly IAdeGlassSelectItem[], nextValue?: string): void {
		this.items = [...items];
		if (nextValue !== undefined) {
			this._value = nextValue;
		} else if (this.items.length === 0) {
			this._value = '';
		} else if (!this.items.some(i => i.value === this._value)) {
			this._value = this.items[0].value;
		}
		this.syncTriggerDisplay();
		if (this.isOpen()) {
			this.renderOptionsList();
			this.updatePortalPosition();
		}
	}

	isOpen(): boolean {
		return Boolean(this.portalEl && !this.portalEl.hidden);
	}

	getPortalElement(): HTMLElement | undefined {
		return this.portalEl;
	}

	focus(): void {
		this.triggerEl.focus();
	}

	toggle(): void {
		if (this.isOpen()) {
			this.close();
		} else {
			this.open();
		}
	}

	open(): void {
		if (this._disabled || this.isOpen()) {
			return;
		}
		if (activeOpenGlassSelect && activeOpenGlassSelect !== this) {
			activeOpenGlassSelect.close();
		}
		activeOpenGlassSelect = this;

		this.portalDisposables.clear();
		this.filterQuery = '';

		const portal = append(this.portalContainer, $('.ade-glass-select-portal', {
			'data-ade-select-portal': 'true',
			role: 'dialog',
		}));
		portal.style.position = 'fixed';
		portal.style.zIndex = '10050';
		this.portalEl = portal;

		this.triggerEl.classList.add('is-open');
		this.triggerEl.setAttribute('aria-expanded', 'true');

		this.portalDisposables.add(addDisposableListener(portal, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this.portalDisposables.add(addDisposableListener(portal, EventType.CLICK, e => e.stopPropagation()));
		this.portalDisposables.add(addDisposableListener(portal, EventType.WHEEL, e => e.stopPropagation(), { passive: false }));

		const useSearch = this.searchableSetting ?? (this.items.length >= AUTO_SEARCH_THRESHOLD);
		if (useSearch) {
			const searchWrap = append(portal, $('.ade-glass-select-search-wrap'));
			append(searchWrap, $('span.ade-glass-select-search-icon.codicon.codicon-search', { 'aria-hidden': 'true' }));
			const searchInput = append(searchWrap, $('input.ade-glass-select-search-input', {
				type: 'text',
				placeholder: this.searchPlaceholder,
				'data-ade-select-search': 'true',
				'aria-label': this.searchPlaceholder,
			})) as HTMLInputElement;
			const clearBtn = append(searchWrap, $('button.ade-glass-select-search-clear', {
				type: 'button',
				'aria-label': adeBi(localize('adeGlassSelectClearSearch', "Clear filter"), '清空筛选'),
			})) as HTMLButtonElement;
			append(clearBtn, $('span.codicon.codicon-close', { 'aria-hidden': 'true' }));
			clearBtn.hidden = true;
			this.searchInputEl = searchInput;

			this.portalDisposables.add(addDisposableListener(searchInput, EventType.INPUT, () => {
				this.filterQuery = searchInput.value;
				clearBtn.hidden = !this.filterQuery;
				this.renderOptionsList();
				this.updatePortalPosition();
			}));

			this.portalDisposables.add(addDisposableListener(clearBtn, EventType.CLICK, (e: MouseEvent) => {
				e.stopPropagation();
				searchInput.value = '';
				this.filterQuery = '';
				clearBtn.hidden = true;
				this.renderOptionsList();
				this.updatePortalPosition();
				searchInput.focus();
			}));
		} else {
			this.searchInputEl = undefined;
		}

		this.listEl = append(portal, $('.ade-glass-select-list', {
			role: 'listbox',
		}));

		this.renderOptionsList();
		this.updatePortalPosition();

		const win = getWindow(this.triggerEl);

		// Outside pointerdown closes only the portal while letting parent popovers inspect `[data-ade-select-portal="true"]`
		this.portalDisposables.add(addDisposableListener(win.document, EventType.POINTER_DOWN, (e: PointerEvent) => {
			const target = e.target as Node | null;
			if (target && (portal.contains(target) || this.triggerEl.contains(target))) {
				return;
			}
			this.close();
		}, true));

		// Capture-phase keyboard controller guarantees two-stage Escape before any parent popover/canvas handler runs
		this.portalDisposables.add(addDisposableListener(win.document, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (!this.isOpen()) {
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				this.close(true);
				return;
			}
			if (e.key === 'Tab') {
				this.close(false);
				return;
			}
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				e.stopPropagation();
				this.moveFocusedOption(1);
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				e.stopPropagation();
				this.moveFocusedOption(-1);
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				const entry = this.visibleOptionButtons[this.focusedOptionIndex];
				if (entry && !entry.item.disabled) {
					this.commitSelection(entry.item);
				}
			}
		}, true));

		// Reposition portal when any ancestor scroll container scrolls or viewport resizes
		this.portalDisposables.add(addDisposableListener(win.document, EventType.SCROLL, e => {
			if (!this.isOpen()) {
				return;
			}
			const target = e.target as Node | null;
			if (target && portal.contains(target)) {
				return;
			}
			if (!this.triggerEl.isConnected) {
				this.close(false);
				return;
			}
			this.updatePortalPosition();
		}, true));

		this.portalDisposables.add(addDisposableListener(win, EventType.RESIZE, () => {
			if (this.isOpen()) {
				this.updatePortalPosition();
			}
		}));

		if (this.searchInputEl) {
			this.searchInputEl.focus();
		} else {
			const activeBtn = this.visibleOptionButtons[this.focusedOptionIndex]?.btn;
			activeBtn?.focus();
		}
	}

	close(restoreTriggerFocus = false): void {
		if (activeOpenGlassSelect === this) {
			activeOpenGlassSelect = undefined;
		}
		this.portalDisposables.clear();
		if (this.portalEl) {
			this.portalEl.remove();
			this.portalEl = undefined;
		}
		this.searchInputEl = undefined;
		this.listEl = undefined;
		this.visibleOptionButtons = [];
		this.focusedOptionIndex = -1;
		this.triggerEl.classList.remove('is-open');
		this.triggerEl.setAttribute('aria-expanded', 'false');
		if (restoreTriggerFocus && this.triggerEl.isConnected && !this._disabled) {
			this.triggerEl.focus();
		}
	}

	override dispose(): void {
		this.close(false);
		this.triggerEl.remove();
		super.dispose();
	}

	private installTriggerShims(): void {
		Object.defineProperty(this.triggerEl, 'value', {
			configurable: true,
			enumerable: true,
			get: () => this.value,
			set: (next: unknown) => {
				this.value = String(next ?? '');
			},
		});

		Object.defineProperty(this.triggerEl, 'disabled', {
			configurable: true,
			enumerable: true,
			get: () => this._disabled,
			set: (next: unknown) => {
				this.setDisabled(Boolean(next));
			},
		});
	}

	private syncTriggerDisplay(): void {
		const activeItem = this.items.find(i => i.value === this._value);
		this.triggerIconEl.className = 'ade-glass-select-trigger-icon';
		delete this.triggerIconEl.dataset.os;
		delete this.triggerIconEl.dataset.llm;
		this.triggerIconEl.removeAttribute('aria-label');
		this.triggerIconEl.title = '';
		clearNode(this.triggerIconEl);
		if (activeItem?.osIcon) {
			this.triggerIconEl.hidden = false;
			renderAdeOsIcon(this.triggerIconEl, activeItem.osIcon, {
				baseClass: 'ade-glass-select-trigger-icon is-os-icon',
				prefix: 'ade-os',
			});
		} else if (activeItem?.vendorIcon) {
			this.triggerIconEl.hidden = false;
			renderAdeLlmIcon(this.triggerIconEl, activeItem.vendorIcon, {
				baseClass: 'ade-glass-select-trigger-icon',
				prefix: 'ade-llm',
			});
		} else if (activeItem?.icon) {
			this.triggerIconEl.hidden = false;
			append(this.triggerIconEl, $(`span.codicon.codicon-${activeItem.icon}`, { 'aria-hidden': 'true' }));
		} else {
			this.triggerIconEl.hidden = true;
		}

		if (activeItem) {
			this.triggerLabelEl.textContent = activeItem.label;
			this.triggerLabelEl.classList.remove('is-placeholder');
			this.triggerEl.title = activeItem.description ? `${activeItem.label} (${activeItem.description})` : activeItem.label;
		} else if (this._value) {
			this.triggerLabelEl.textContent = this._value;
			this.triggerLabelEl.classList.remove('is-placeholder');
			this.triggerEl.title = this._value;
		} else {
			this.triggerLabelEl.textContent = this.placeholder;
			this.triggerLabelEl.classList.add('is-placeholder');
			this.triggerEl.title = '';
		}
	}

	private getFilteredItems(): readonly IAdeGlassSelectItem[] {
		const q = this.filterQuery.trim().toLowerCase();
		if (!q) {
			return this.items;
		}
		return this.items.filter(item => {
			const haystack = `${item.label} ${item.value} ${item.group ?? ''} ${item.description ?? ''} ${item.searchKeywords ?? ''}`.toLowerCase();
			return haystack.includes(q);
		});
	}

	private renderOptionsList(): void {
		if (!this.listEl) {
			return;
		}
		clearNode(this.listEl);
		this.visibleOptionButtons = [];

		const filtered = this.getFilteredItems();
		if (filtered.length === 0) {
			append(this.listEl, $('.ade-glass-select-empty', {
				'data-ade-select-empty': 'true',
			}, adeBi(localize('adeGlassSelectNoMatches', "No matching options"), '无匹配选项')));
			this.focusedOptionIndex = -1;
			return;
		}

		const hasGroups = filtered.some(i => Boolean(i.group));
		const entriesToRender: { readonly group?: string; readonly items: readonly IAdeGlassSelectItem[] }[] = [];

		if (hasGroups) {
			const groupOrder: string[] = [];
			const byGroup = new Map<string, IAdeGlassSelectItem[]>();
			for (const item of filtered) {
				const g = item.group || 'Other';
				let bucket = byGroup.get(g);
				if (!bucket) {
					bucket = [];
					byGroup.set(g, bucket);
					groupOrder.push(g);
				}
				bucket.push(item);
			}
			for (const g of groupOrder) {
				entriesToRender.push({ group: g, items: byGroup.get(g)! });
			}
		} else {
			entriesToRender.push({ items: filtered });
		}

		let groupIdx = 0;
		for (const section of entriesToRender) {
			if (section.group) {
				const groupHead = append(this.listEl, $(`.ade-glass-select-group-header${groupIdx === 0 ? '.is-first' : ''}`, {
					'data-ade-select-group': section.group,
					role: 'presentation',
				}));
				append(groupHead, $('span.ade-glass-select-group-title', {}, section.group));
				append(groupHead, $('span.ade-glass-select-group-count', {}, String(section.items.length)));
				groupIdx++;
			}

			for (const item of section.items) {
				const isSelected = item.value === this._value;
				const optBtn = append(this.listEl, $(`button.ade-glass-select-option${isSelected ? '.is-selected' : ''}${item.disabled ? '.is-disabled' : ''}`, {
					type: 'button',
					role: 'option',
					'aria-selected': isSelected ? 'true' : 'false',
					'data-ade-select-option': item.value,
					'data-ade-select-value': item.value,
				})) as HTMLButtonElement;
				optBtn.disabled = Boolean(item.disabled);

				const lead = append(optBtn, $('span.ade-glass-select-option-lead'));
				if (item.osIcon) {
					const ico = append(lead, $('span.ade-glass-select-option-icon'));
					renderAdeOsIcon(ico, item.osIcon, {
						baseClass: 'ade-glass-select-option-icon is-os-icon',
						prefix: 'ade-os',
					});
				} else if (item.vendorIcon) {
					const ico = append(lead, $('span.ade-glass-select-option-icon'));
					renderAdeLlmIcon(ico, item.vendorIcon, {
						baseClass: 'ade-glass-select-option-icon',
						prefix: 'ade-llm',
					});
				} else if (item.icon) {
					const ico = append(lead, $('span.ade-glass-select-option-icon'));
					append(ico, $(`span.codicon.codicon-${item.icon}`, { 'aria-hidden': 'true' }));
				}

				const texts = append(lead, $('span.ade-glass-select-option-texts'));
				append(texts, $('span.ade-glass-select-option-label', {}, item.label));
				if (item.description && item.description !== item.label) {
					append(texts, $('span.ade-glass-select-option-desc', {}, item.description));
				}

				const right = append(optBtn, $('span.ade-glass-select-option-right'));
				if (item.badge) {
					append(right, $('span.ade-glass-select-option-badge', {}, item.badge));
				}
				if (isSelected) {
					append(right, $('span.ade-glass-select-option-check.codicon.codicon-check', { 'aria-hidden': 'true' }));
				}

				const myIndex = this.visibleOptionButtons.length;
				this.visibleOptionButtons.push({ item, btn: optBtn });

				this.portalDisposables.add(addDisposableListener(optBtn, EventType.MOUSE_ENTER, () => {
					if (!item.disabled) {
						this.setFocusedOptionIndex(myIndex, false);
					}
				}));
				this.portalDisposables.add(addDisposableListener(optBtn, EventType.CLICK, (e: MouseEvent) => {
					e.stopPropagation();
					if (item.disabled) {
						return;
					}
					this.commitSelection(item);
				}));
			}
		}

		const selectedIdx = this.visibleOptionButtons.findIndex(entry => entry.item.value === this._value && !entry.item.disabled);
		const firstEnabledIdx = this.visibleOptionButtons.findIndex(entry => !entry.item.disabled);
		this.setFocusedOptionIndex(selectedIdx >= 0 ? selectedIdx : firstEnabledIdx, true);
	}

	private setFocusedOptionIndex(nextIdx: number, scrollIntoView: boolean): void {
		this.focusedOptionIndex = nextIdx;
		for (let i = 0; i < this.visibleOptionButtons.length; i++) {
			const { btn } = this.visibleOptionButtons[i];
			const active = i === nextIdx;
			btn.classList.toggle('is-focused', active);
			if (active && scrollIntoView) {
				btn.scrollIntoView?.({ block: 'nearest' });
			}
		}
	}

	private moveFocusedOption(delta: 1 | -1): void {
		const len = this.visibleOptionButtons.length;
		if (len === 0) {
			return;
		}
		let cursor = this.focusedOptionIndex;
		for (let step = 0; step < len; step++) {
			cursor = (cursor + delta + len) % len;
			if (!this.visibleOptionButtons[cursor].item.disabled) {
				this.setFocusedOptionIndex(cursor, true);
				if (!this.searchInputEl) {
					this.visibleOptionButtons[cursor].btn.focus();
				}
				return;
			}
		}
	}

	private commitSelection(item: IAdeGlassSelectItem): void {
		const changed = this._value !== item.value;
		this._value = item.value;
		this.syncTriggerDisplay();
		this.close(true);
		if (changed) {
			const win = getWindow(this.triggerEl);
			this._dispatchingInternalChange = true;
			try {
				this.triggerEl.dispatchEvent(new win.Event(EventType.CHANGE, { bubbles: true }));
				this._onDidChange.fire(this._value);
			} finally {
				this._dispatchingInternalChange = false;
			}
		}
	}

	updatePortalPosition(): void {
		if (!this.portalEl || !this.listEl) {
			return;
		}
		const win = getWindow(this.triggerEl);
		const vw = win.innerWidth || 1280;
		const vh = win.innerHeight || 800;
		const rect = this.triggerEl.getBoundingClientRect();

		const desiredMinW = Math.max(this.minMenuWidth, Math.round(rect.width || 0));
		const maxAllowedW = Math.max(160, vw - 16);
		this.portalEl.style.minWidth = `${Math.min(desiredMinW, maxAllowedW)}px`;

		const searchH = this.searchInputEl ? 40 : 0;
		const spaceBelow = vh - rect.bottom - 10;
		const spaceAbove = rect.top - 10;
		const naturalPortalH = this.portalEl.offsetHeight || Math.min(320, this.visibleOptionButtons.length * 32 + searchH + 14);

		const flipUp = spaceBelow < Math.min(naturalPortalH, 200) && spaceAbove > spaceBelow;
		this.portalEl.classList.toggle('is-flipped-up', flipUp);

		const availableVertical = Math.max(110, (flipUp ? spaceAbove : spaceBelow) - 8);
		const listMaxH = Math.max(72, Math.min(280, availableVertical - searchH - 12));
		this.listEl.style.maxHeight = `${Math.round(listMaxH)}px`;

		const measuredW = this.portalEl.offsetWidth || desiredMinW;
		const measuredH = this.portalEl.offsetHeight || Math.min(naturalPortalH, availableVertical);

		const left = Math.max(8, Math.min(vw - measuredW - 8, rect.left));
		const top = flipUp
			? Math.max(8, rect.top - measuredH - 5)
			: Math.max(8, Math.min(vh - measuredH - 8, rect.bottom + 5));

		this.portalEl.style.left = `${Math.round(left)}px`;
		this.portalEl.style.top = `${Math.round(top)}px`;
	}
}
