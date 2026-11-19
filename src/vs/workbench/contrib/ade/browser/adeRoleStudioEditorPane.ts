/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/adeRoleStudio.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	ADE_ORGANIZATION_PRESETS,
	ADE_PRIMITIVE_APIS,
	ADE_PROMPT_TEMPLATE_VARIABLES,
	ADE_RANK_COLOR_TOKENS,
	ADE_RANK_ICON_TOKENS,
	AdePrimitiveApiCategory,
	AdePrimitiveApiId,
	AdeRankColorToken,
	AdeRankIconToken,
	ALL_ADE_PRIMITIVE_API_IDS,
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	IAdeOrganizationConfig,
	IAdeRankDefinition,
	normalizeAdeOrganizationConfig,
	previewCompiledRankPrompt,
	sanitizeRankId,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ADE_ROLE_STUDIO_SCHEME } from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';

export function resolveAdeRankCodicon(icon: AdeRankIconToken | string | undefined): ThemeIcon {
	switch (icon) {
		case 'organization': return Codicon.organization;
		case 'briefcase': return Codicon.briefcase;
		case 'shield': return Codicon.shield;
		case 'tools': return Codicon.tools;
		case 'beaker': return Codicon.beaker;
		case 'law': return Codicon.law;
		case 'rocket': return Codicon.rocket;
		case 'eye': return Codicon.eye;
		case 'person': return Codicon.person;
		case 'star-full': return Codicon.starFull;
		case 'terminal': return Codicon.terminal;
		case 'sparkle': return Codicon.sparkle;
		default: return Codicon.account;
	}
}

export class AdeRoleStudioEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeRoleStudio';
	override readonly resource = URI.from({ scheme: ADE_ROLE_STUDIO_SCHEME, path: '/studio' });

	private _focusRankId: string | undefined;

	constructor(focusRankId?: string) {
		super();
		this._focusRankId = focusRankId;
	}

	get focusRankId(): string | undefined {
		return this._focusRankId;
	}

	setFocusRankId(rankId: string | undefined): void {
		this._focusRankId = rankId;
	}

	override get typeId(): string {
		return AdeRoleStudioEditorInput.ID;
	}

	override getName(): string {
		return localize('adeRoleStudioEditorTitle', "Organization & Roles Studio");
	}

	override getIcon(): ThemeIcon {
		return Codicon.organization;
	}

	override matches(other: EditorInput): boolean {
		return other instanceof AdeRoleStudioEditorInput;
	}
}

export class AdeRoleStudioEditorSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof AdeRoleStudioEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		return input instanceof AdeRoleStudioEditorInput ? (input.focusRankId ?? '') : undefined;
	}

	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput | undefined {
		return instantiationService.createInstance(AdeRoleStudioEditorInput, raw || undefined);
	}
}

interface IMutableRankDraft {
	id: string;
	name: string;
	shortName: string;
	tier: number;
	color: AdeRankColorToken;
	icon: AdeRankIconToken;
	summary: string;
	initPrompt: string;
	pureExecution: boolean;
	canHaveSubordinates: boolean;
	defaultChildRankId?: string;
	allowedApis: AdePrimitiveApiId[];
}

interface IMutableOrgDraft {
	version: 1;
	presetId?: string;
	ranks: IMutableRankDraft[];
}

function cloneToDraft(config: IAdeOrganizationConfig): IMutableOrgDraft {
	return {
		version: 1,
		presetId: config.presetId,
		ranks: config.ranks.map(r => ({
			id: r.id,
			name: r.name,
			shortName: r.shortName,
			tier: r.tier,
			color: r.color,
			icon: r.icon,
			summary: r.summary,
			initPrompt: r.initPrompt,
			pureExecution: Boolean(r.pureExecution),
			canHaveSubordinates: r.canHaveSubordinates,
			defaultChildRankId: r.defaultChildRankId,
			allowedApis: [...r.allowedApis],
		})),
	};
}

function draftToConfig(draft: IMutableOrgDraft): IAdeOrganizationConfig {
	return normalizeAdeOrganizationConfig({
		version: 1,
		presetId: draft.presetId,
		ranks: draft.ranks.map(r => ({ ...r, allowedApis: [...r.allowedApis] })),
	});
}

const API_CATEGORY_ORDER: readonly { readonly id: AdePrimitiveApiCategory; readonly title: string }[] = [
	{ id: 'messaging', title: 'Messaging, Context & Human Inbox' },
	{ id: 'hierarchy', title: 'Hierarchy & Session Lifecycle' },
	{ id: 'workspace', title: 'Workspace, Files & Cloud Hosts' },
	{ id: 'engineering', title: 'Engineering & Research DAG Workflow' },
];

export class AdeRoleStudioEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.adeRoleStudio';

	private rootEl: HTMLElement | undefined;
	private readonly renderDisposables = this._register(new DisposableStore());
	private draft: IMutableOrgDraft;
	private selectedRankId: string;
	private dirty = false;
	private importBarVisible = false;
	private importDraftText = '';
	private previewPreEl: HTMLElement | undefined;
	private previewTokenPillEl: HTMLElement | undefined;
	private editorColEl: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAdeRoleSchemaService private readonly roleSchemaService: IAdeRoleSchemaService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(AdeRoleStudioEditorPane.ID, group, telemetryService, themeService, storageService);
		this.draft = cloneToDraft(this.roleSchemaService.getConfig());
		this.selectedRankId = this.draft.ranks[0]?.id ?? 'governor';
		this._register(this.roleSchemaService.onDidChangeSchema(next => {
			if (!this.dirty) {
				this.draft = cloneToDraft(next);
				if (!this.draft.ranks.some(r => r.id === this.selectedRankId)) {
					this.selectedRankId = this.draft.ranks[0]?.id ?? '';
				}
				this.render();
			}
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.ade-role-studio'));
		this.render();
	}

	override async setInput(
		input: AdeRoleStudioEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (input.focusRankId && this.draft.ranks.some(r => r.id === input.focusRankId)) {
			this.selectedRankId = input.focusRankId;
		}
		this.render();
	}

	focusRank(rankId: string | undefined): void {
		if (rankId && this.draft.ranks.some(r => r.id === rankId) && this.selectedRankId !== rankId) {
			this.selectedRankId = rankId;
			this.render();
		}
	}

	override layout(_dimension: Dimension): void {
		// Flexbox CSS handles responsive sizing automatically.
	}

	private getSelectedRank(): IMutableRankDraft | undefined {
		const found = this.draft.ranks.find(r => r.id === this.selectedRankId);
		if (found) {
			return found;
		}
		if (this.draft.ranks[0]) {
			this.selectedRankId = this.draft.ranks[0].id;
			return this.draft.ranks[0];
		}
		return undefined;
	}

	private markDirty(customPreset = true): void {
		this.dirty = true;
		if (customPreset) {
			this.draft.presetId = 'custom';
		}
	}

	private updateLivePreviewOnly(): void {
		const rank = this.getSelectedRank();
		if (!rank || !this.previewPreEl || !this.previewTokenPillEl) {
			return;
		}
		const normalized = draftToConfig(this.draft);
		const normalizedRank = normalized.ranks.find(r => r.id === rank.id) ?? rank as IAdeRankDefinition;
		const preview = previewCompiledRankPrompt(normalized, normalizedRank);
		this.previewPreEl.textContent = preview.prompt;
		this.previewTokenPillEl.textContent = localize('adeRoleStudioTokenCount', "~{0} tokens", preview.estimatedTokens);
	}

	private async saveDraft(): Promise<void> {
		try {
			const normalized = draftToConfig(this.draft);
			await this.roleSchemaService.updateConfig(normalized);
			this.draft = cloneToDraft(normalized);
			if (!this.draft.ranks.some(r => r.id === this.selectedRankId)) {
				this.selectedRankId = this.draft.ranks[0]?.id ?? '';
			}
			this.dirty = false;
			this.render();
			this.notificationService.info(localize(
				'adeRoleStudioSaved',
				"Saved ADE organization schema ({0} rank(s)) to Settings. All prompts, sidebar badges, and kernel API permissions are now live.",
				normalized.ranks.length,
			));
		} catch (err) {
			this.notificationService.error(localize(
				'adeRoleStudioSaveFailed',
				"Failed to save ADE organization settings: {0}",
				err instanceof Error ? err.message : String(err),
			));
		}
	}

	private addCustomRank(): void {
		const maxTier = this.draft.ranks.reduce((acc, r) => Math.max(acc, r.tier), 0);
		let idx = this.draft.ranks.length + 1;
		let id = `custom-rank-${idx}`;
		while (this.draft.ranks.some(r => r.id === id)) {
			idx++;
			id = `custom-rank-${idx}`;
		}
		const colors: readonly AdeRankColorToken[] = ['cyan', 'rose', 'purple', 'indigo', 'amber', 'emerald', 'slate'];
		const newRank: IMutableRankDraft = {
			id,
			name: localize('adeNewCustomRankName', "Custom Rank {0}", idx),
			shortName: `R${idx}`,
			tier: maxTier + 1,
			color: colors[idx % colors.length],
			icon: 'person',
			summary: `L${maxTier + 1} Custom Rank: Fill in role responsibilities and allowed APIs.`,
			initPrompt: 'You are {{rank.tier}} **{{rank.name}}** in **{{project.name}}** under {{supervisor.label}}.\nState your key responsibilities, review criteria, and boundaries here.',
			pureExecution: false,
			canHaveSubordinates: true,
			allowedApis: ['session.read_context', 'session.message', 'project.read'],
		};
		this.draft.ranks.push(newRank);
		this.selectedRankId = newRank.id;
		this.markDirty();
		this.render();
	}

	private moveRank(rankId: string, delta: -1 | 1): void {
		const sorted = [...this.draft.ranks].sort((a, b) => a.tier - b.tier);
		const idx = sorted.findIndex(r => r.id === rankId);
		const targetIdx = idx + delta;
		if (idx < 0 || targetIdx < 0 || targetIdx >= sorted.length) {
			return;
		}
		const swap = sorted[targetIdx];
		sorted[targetIdx] = sorted[idx];
		sorted[idx] = swap;
		sorted.forEach((r, i) => { r.tier = i + 1; });
		this.draft.ranks = sorted;
		this.markDirty();
		this.render();
	}

	private deleteRank(rankId: string): void {
		if (this.draft.ranks.length <= 1) {
			this.notificationService.warn(localize('adeRoleStudioMinOneRank', "At least one rank is required in the organization."));
			return;
		}
		this.draft.ranks = this.draft.ranks.filter(r => r.id !== rankId);
		for (const rank of this.draft.ranks) {
			if (rank.defaultChildRankId === rankId) {
				rank.defaultChildRankId = undefined;
			}
		}
		if (this.selectedRankId === rankId) {
			this.selectedRankId = this.draft.ranks[0]?.id ?? '';
		}
		this.markDirty();
		this.render();
	}

	private render(): void {
		if (!this.rootEl) {
			return;
		}
		const prevEditorScrollTop = this.editorColEl?.scrollTop ?? 0;
		this.renderDisposables.clear();
		clearNode(this.rootEl);

		// 1. Sticky Header + Presets
		const header = append(this.rootEl, $('.ade-rs-header'));
		const headerTop = append(header, $('.ade-rs-header-top'));
		const titleGroup = append(headerTop, $('.ade-rs-title-group'));
		const titleRow = append(titleGroup, $('.ade-rs-title-row'));
		append(titleRow, $('h2.ade-rs-title', {}, localize('adeRoleStudioHeaderTitle', "Organization & Roles Studio")));
		append(titleRow, $('span.ade-rs-philosophy-pill', {}, localize('adeRoleStudioPhilosophyBadge', "Everything is Extendible")));
		if (this.dirty) {
			append(titleRow, $('span.ade-rs-dirty-pill', {}, localize('adeRoleStudioUnsavedBadge', "Unsaved Changes")));
		}
		append(titleGroup, $('p.ade-rs-subtitle', {}, localize(
			'adeRoleStudioSubtitle',
			"Design your own multi-agent hierarchy like filling in the blanks: define ranks, author each rank's initialization prompt, and grant fixed Aexus-Code kernel API permissions.",
		)));

		const toolbar = append(headerTop, $('.ade-rs-toolbar'));
		const addToolbarBtn = (label: string, icon: ThemeIcon, cls: string, onClick: () => void, disabled = false) => {
			const btn = append(toolbar, $(`button.ade-rs-btn${cls ? `.${cls}` : ''}`, { type: 'button' })) as HTMLButtonElement;
			btn.disabled = disabled;
			const glyph = append(btn, $('span'));
			glyph.classList.add(...ThemeIcon.asClassNameArray(icon));
			append(btn, $('span', {}, label));
			this.renderDisposables.add(addDisposableListener(btn, EventType.CLICK, () => onClick()));
			return btn;
		};

		addToolbarBtn(localize('adeRoleStudioSave', "Save to Settings"), Codicon.check, 'primary', () => {
			void this.saveDraft();
		});
		addToolbarBtn(localize('adeRoleStudioReset', "Reset Default"), Codicon.discard, '', () => {
			this.draft = cloneToDraft(DEFAULT_ADE_ORGANIZATION_CONFIG);
			this.selectedRankId = this.draft.ranks[0]?.id ?? 'governor';
			this.dirty = true;
			this.render();
		});
		addToolbarBtn(localize('adeRoleStudioCopyJson', "Copy JSON"), Codicon.copy, '', () => {
			const json = JSON.stringify(draftToConfig(this.draft), null, 2);
			void this.clipboardService.writeText(json).then(() => {
				this.notificationService.info(localize('adeRoleStudioCopied', "Copied organization schema JSON to clipboard."));
			});
		});
		addToolbarBtn(localize('adeRoleStudioImportJson', "Import JSON"), Codicon.cloudUpload, '', () => {
			this.importBarVisible = !this.importBarVisible;
			this.render();
		});
		addToolbarBtn(localize('adeRoleStudioOpenSettingsJson', "settings.json"), Codicon.json, '', () => {
			void this.commandService.executeCommand('workbench.action.openSettingsJson');
		});

		// Presets Strip
		const presetsRow = append(header, $('.ade-rs-presets-row'));
		append(presetsRow, $('span.ade-rs-presets-label', {}, localize('adeRoleStudioPresetsLabel', "Starter Presets:")));
		for (const preset of ADE_ORGANIZATION_PRESETS) {
			const chip = append(presetsRow, $('button.ade-rs-preset-chip', {
				type: 'button',
				title: preset.description,
			}, preset.name));
			chip.classList.toggle('active', this.draft.presetId === preset.id);
			this.renderDisposables.add(addDisposableListener(chip, EventType.CLICK, () => {
				this.draft = cloneToDraft(preset.config);
				this.selectedRankId = this.draft.ranks[0]?.id ?? '';
				this.markDirty(false);
				this.render();
			}));
		}

		// Optional Import JSON Drawer
		if (this.importBarVisible) {
			const importBar = append(this.rootEl, $('.ade-rs-import-bar'));
			append(importBar, $('span.ade-rs-label', {}, localize('adeRoleStudioImportLabel', "Paste an ADE organization schema JSON below and click Apply:")));
			const importTa = append(importBar, $('textarea.ade-rs-import-textarea', {
				placeholder: '{"version": 1, "ranks": [...]}',
			})) as HTMLTextAreaElement;
			importTa.value = this.importDraftText;
			this.renderDisposables.add(addDisposableListener(importTa, EventType.INPUT, () => {
				this.importDraftText = importTa.value;
			}));
			const actionsRow = append(importBar, $('.ade-rs-import-actions'));
			const applyBtn = append(actionsRow, $('button.ade-rs-btn.primary', { type: 'button' }, localize('adeRoleStudioApplyImport', "Apply JSON")));
			const cancelBtn = append(actionsRow, $('button.ade-rs-btn', { type: 'button' }, localize('adeRoleStudioCancelImport', "Cancel")));
			this.renderDisposables.add(addDisposableListener(applyBtn, EventType.CLICK, () => {
				try {
					const parsed = JSON.parse(importTa.value);
					const normalized = normalizeAdeOrganizationConfig(parsed);
					this.draft = cloneToDraft(normalized);
					this.selectedRankId = this.draft.ranks[0]?.id ?? '';
					this.importBarVisible = false;
					this.importDraftText = '';
					this.markDirty();
					this.render();
				} catch (err) {
					this.notificationService.error(localize('adeRoleStudioImportError', "Invalid JSON schema: {0}", err instanceof Error ? err.message : String(err)));
				}
			}));
			this.renderDisposables.add(addDisposableListener(cancelBtn, EventType.CLICK, () => {
				this.importBarVisible = false;
				this.render();
			}));
		}

		// 2. Main Split Body
		const body = append(this.rootEl, $('.ade-rs-body'));

		// 2A. Left Visual Hierarchy Ladder
		const ladderCol = append(body, $('.ade-rs-ladder-col'));
		const ladderHead = append(ladderCol, $('.ade-rs-ladder-head'));
		append(ladderHead, $('span', {}, localize('adeRoleStudioLadderTitle', "Hierarchy Ladder (High → Low)")));
		append(ladderHead, $('span', {}, `${this.draft.ranks.length}`));

		const ladderList = append(ladderCol, $('.ade-rs-ladder-list'));
		const sortedRanks = [...this.draft.ranks].sort((a, b) => a.tier - b.tier);
		for (let i = 0; i < sortedRanks.length; i++) {
			const rank = sortedRanks[i];
			const card = append(ladderList, $(`.ade-rs-rank-card.color-${rank.color}`, {
				'data-rank-id': rank.id,
			}));
			card.classList.toggle('selected', rank.id === this.selectedRankId);

			const top = append(card, $('.ade-rs-rank-card-top'));
			append(top, $('span.ade-rs-tier-badge', {}, `L${rank.tier}`));
			const iconEl = append(top, $('span.ade-rs-rank-icon'));
			iconEl.classList.add(...ThemeIcon.asClassNameArray(resolveAdeRankCodicon(rank.icon)));
			append(top, $('span.ade-rs-rank-name', {}, rank.name));

			const meta = append(card, $('.ade-rs-rank-meta'));
			const pill = append(meta, $(`span.ade-rs-rank-pill${rank.pureExecution ? '.pure' : ''}`, {}, rank.pureExecution
				? localize('adeRoleStudioPureLeafPill', "Pure Leaf · 0 APIs")
				: localize('adeRoleStudioApiCountPill', "{0} Core APIs", rank.allowedApis.length)));
			pill.title = rank.id;

			const cardActions = append(meta, $('.ade-rs-rank-card-actions'));
			const addMiniBtn = (icon: ThemeIcon, title: string, disabled: boolean, fn: () => void) => {
				const btn = append(cardActions, $('button.ade-rs-mini-icon-btn', { type: 'button', title })) as HTMLButtonElement;
				btn.disabled = disabled;
				btn.classList.add(...ThemeIcon.asClassNameArray(icon));
				this.renderDisposables.add(addDisposableListener(btn, EventType.CLICK, e => {
					e.stopPropagation();
					fn();
				}));
			};
			addMiniBtn(Codicon.arrowUp, localize('adeRoleStudioMoveUp', "Promote Tier Up"), i === 0, () => this.moveRank(rank.id, -1));
			addMiniBtn(Codicon.arrowDown, localize('adeRoleStudioMoveDown', "Demote Tier Down"), i === sortedRanks.length - 1, () => this.moveRank(rank.id, 1));
			addMiniBtn(Codicon.trash, localize('adeRoleStudioDeleteRank', "Delete Rank"), sortedRanks.length <= 1, () => this.deleteRank(rank.id));

			this.renderDisposables.add(addDisposableListener(card, EventType.CLICK, () => {
				this.selectedRankId = rank.id;
				this.render();
			}));
		}

		const ladderFooter = append(ladderCol, $('.ade-rs-ladder-footer'));
		const addRankBtn = append(ladderFooter, $('button.ade-rs-btn.ade-rs-add-btn', { type: 'button' }));
		const addIcon = append(addRankBtn, $('span'));
		addIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		append(addRankBtn, $('span', {}, localize('adeRoleStudioAddCustomRank', "Add Custom Rank")));
		this.renderDisposables.add(addDisposableListener(addRankBtn, EventType.CLICK, () => this.addCustomRank()));

		// 2B. Right Fill-in-the-Blank Form
		const editorCol = this.editorColEl = append(body, $('.ade-rs-editor-col'));
		const selected = this.getSelectedRank();
		if (!selected) {
			return;
		}

		// --- Card 1: Rank Identity & Position ---
		const card1 = append(editorCol, $('.ade-rs-card'));
		const c1Head = append(card1, $('.ade-rs-card-head'));
		const c1Title = append(c1Head, $('h3.ade-rs-card-title'));
		append(c1Title, $('span.ade-rs-step-badge', {}, '1'));
		append(c1Title, $('span', {}, localize('adeRoleStudioStep1', "Rank Identity & Hierarchy Position")));

		const grid = append(card1, $('.ade-rs-grid'));

		const addTextField = (
			label: string,
			value: string,
			placeholder: string,
			onInput: (val: string) => void,
			extraClass = '',
			inputType: 'text' | 'number' = 'text',
		) => {
			const field = append(grid, $(`.ade-rs-field${extraClass ? `.${extraClass}` : ''}`));
			append(field, $('label.ade-rs-label', {}, label));
			const input = append(field, $('input.ade-rs-input', {
				type: inputType,
				value,
				placeholder,
			})) as HTMLInputElement;
			this.renderDisposables.add(addDisposableListener(input, EventType.INPUT, () => {
				onInput(input.value);
			}));
			return input;
		};

		const nameInput = addTextField(localize('adeRoleFieldName', "Rank Display Name"), selected.name, 'e.g. Governor, Tech Lead, QA Auditor', val => {
			selected.name = val;
			this.markDirty();
			this.updateLivePreviewOnly();
		});
		this.renderDisposables.add(addDisposableListener(nameInput, EventType.CHANGE, () => this.render()));
		const idInput = addTextField(localize('adeRoleFieldId', "Rank Machine ID (slug)"), selected.id, 'e.g. tech-lead', val => {
			const sanitized = sanitizeRankId(val);
			if (sanitized && sanitized !== selected.id && !this.draft.ranks.some(r => r !== selected && r.id === sanitized)) {
				selected.id = sanitized;
				this.selectedRankId = sanitized;
				this.markDirty();
				this.updateLivePreviewOnly();
			}
		});
		idInput.title = localize('adeRoleFieldIdHint', "Lowercase alphanumeric slug used in CLI --role and settings.json");
		this.renderDisposables.add(addDisposableListener(idInput, EventType.BLUR, () => {
			if (idInput.value !== selected.id) {
				idInput.value = selected.id;
			}
		}));

		addTextField(localize('adeRoleFieldShort', "Inbox Short Tag (2–6 chars)"), selected.shortName, 'e.g. Gov, Lead, QA', val => {
			selected.shortName = val.slice(0, 6);
			this.markDirty();
		});
		const tierInput = addTextField(localize('adeRoleFieldTier', "Hierarchy Tier (L1 = highest)"), String(selected.tier), '1', val => {
			const parsed = Number(val);
			if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 99) {
				selected.tier = Math.round(parsed);
				this.markDirty();
				this.updateLivePreviewOnly();
			}
		}, '', 'number');
		tierInput.min = '1';
		tierInput.max = '99';
		this.renderDisposables.add(addDisposableListener(tierInput, EventType.CHANGE, () => this.render()));

		addTextField(localize('adeRoleFieldSummary', "One-Line Role Summary"), selected.summary, 'Shown in role pickers and hierarchy headers', val => {
			selected.summary = val;
			this.markDirty();
			this.updateLivePreviewOnly();
		}, 'full');

		// Color & Icon Pickers
		const colorField = append(grid, $('.ade-rs-field'));
		append(colorField, $('label.ade-rs-label', {}, localize('adeRoleFieldColor', "Badge Accent Color")));
		const colorRow = append(colorField, $('.ade-rs-picker-row'));
		for (const token of ADE_RANK_COLOR_TOKENS) {
			const sw = append(colorRow, $(`button.ade-rs-swatch.color-${token}`, {
				type: 'button',
				title: token,
				'aria-label': localize('adeRoleColorChoiceAria', "Badge color: {0}", token),
			}));
			sw.classList.toggle('selected', selected.color === token);
			this.renderDisposables.add(addDisposableListener(sw, EventType.CLICK, () => {
				selected.color = token;
				this.markDirty();
				this.render();
			}));
		}

		const iconField = append(grid, $('.ade-rs-field'));
		append(iconField, $('label.ade-rs-label', {}, localize('adeRoleFieldIcon', "Badge Icon")));
		const iconRow = append(iconField, $('.ade-rs-picker-row'));
		for (const iconToken of ADE_RANK_ICON_TOKENS) {
			const btn = append(iconRow, $('button.ade-rs-icon-choice', {
				type: 'button',
				title: iconToken,
				'aria-label': localize('adeRoleIconChoiceAria', "Badge icon: {0}", iconToken),
			}));
			btn.classList.add(...ThemeIcon.asClassNameArray(resolveAdeRankCodicon(iconToken)));
			btn.classList.toggle('selected', selected.icon === iconToken);
			this.renderDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				selected.icon = iconToken;
				this.markDirty();
				this.render();
			}));
		}

		// Default Child Rank selector
		const lowerCandidates = sortedRanks.filter(r => r.tier > selected.tier);
		const childField = append(grid, $('.ade-rs-field'));
		append(childField, $('label.ade-rs-label', {}, localize('adeRoleFieldDefaultChild', "Default Sub-Session Rank")));
		const childSelect = append(childField, $('select.ade-rs-select')) as HTMLSelectElement;
		childSelect.disabled = selected.pureExecution || !selected.canHaveSubordinates || lowerCandidates.length === 0;
		const autoOpt = append(childSelect, $('option', { value: '' }, localize('adeRoleChildAuto', "Auto (Next Lower Tier)"))) as HTMLOptionElement;
		autoOpt.selected = !selected.defaultChildRankId;
		for (const cand of lowerCandidates) {
			const opt = append(childSelect, $('option', { value: cand.id }, `L${cand.tier} · ${cand.name}`)) as HTMLOptionElement;
			opt.selected = selected.defaultChildRankId === cand.id;
		}
		this.renderDisposables.add(addDisposableListener(childSelect, EventType.CHANGE, () => {
			selected.defaultChildRankId = childSelect.value || undefined;
			this.markDirty();
		}));

		// Behavior Switches
		const switches = append(card1, $('.ade-rs-switches'));
		const canSubLabel = append(switches, $('label.ade-rs-check-row'));
		const canSubCb = append(canSubLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		canSubCb.checked = selected.canHaveSubordinates && !selected.pureExecution;
		canSubCb.disabled = selected.pureExecution;
		append(canSubLabel, $('span', {}, localize('adeRoleCanSupervise', "Can spawn & supervise lower-tier subordinate sessions")));
		this.renderDisposables.add(addDisposableListener(canSubCb, EventType.CHANGE, () => {
			selected.canHaveSubordinates = canSubCb.checked;
			this.markDirty();
			this.render();
		}));

		const pureLabel = append(switches, $('label.ade-rs-check-row'));
		const pureCb = append(pureLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		pureCb.checked = selected.pureExecution;
		append(pureLabel, $('span', {}, localize('adeRolePureExecution', "Pure Execution Leaf — 0 ADE role/API prompt injection (100% clean native Coding Agent context)")));
		this.renderDisposables.add(addDisposableListener(pureCb, EventType.CHANGE, () => {
			selected.pureExecution = pureCb.checked;
			if (selected.pureExecution) {
				selected.canHaveSubordinates = false;
				selected.allowedApis = [];
				selected.initPrompt = '';
			}
			this.markDirty();
			this.render();
		}));

		// --- Card 2: Initialization Prompt Template ---
		const card2 = append(editorCol, $('.ade-rs-card'));
		const c2Head = append(card2, $('.ade-rs-card-head'));
		const c2Title = append(c2Head, $('h3.ade-rs-card-title'));
		append(c2Title, $('span.ade-rs-step-badge', {}, '2'));
		append(c2Title, $('span', {}, localize('adeRoleStudioStep2', "Initialization Prompt Template")));

		if (selected.pureExecution) {
			append(card2, $('.ade-rs-pure-banner', {}, localize(
				'adeRolePurePromptNote',
				"Pure Execution Leaf is enabled for this rank. Sessions with this rank receive ZERO ADE prompt injection and ZERO control APIs so they operate with 100% native Coding Agent focus.",
			)));
		} else {
			append(card2, $('p.ade-rs-card-hint', {}, localize(
				'adeRolePromptHint',
				"Write this rank's mission, review standards, or guardrails below. Click any placeholder chip to insert live session/project metadata (all cache-stable).",
			)));

			const varsStrip = append(card2, $('.ade-rs-vars-strip'));
			const promptTa = append(card2, $('textarea.ade-rs-textarea', {
				placeholder: localize('adeRolePromptPlaceholder', "Example: You are {{rank.tier}} {{rank.name}} for {{project.name}}. Review diffs strictly and delegate implementation to lower-tier subordinates..."),
			})) as HTMLTextAreaElement;
			promptTa.value = selected.initPrompt;

			for (const v of ADE_PROMPT_TEMPLATE_VARIABLES) {
				const chip = append(varsStrip, $('button.ade-rs-var-chip', { type: 'button', title: v.description }, v.token));
				this.renderDisposables.add(addDisposableListener(chip, EventType.CLICK, () => {
					const start = promptTa.selectionStart ?? promptTa.value.length;
					const end = promptTa.selectionEnd ?? promptTa.value.length;
					promptTa.value = promptTa.value.slice(0, start) + v.token + promptTa.value.slice(end);
					selected.initPrompt = promptTa.value;
					promptTa.focus();
					promptTa.setSelectionRange(start + v.token.length, start + v.token.length);
					this.markDirty();
					this.updateLivePreviewOnly();
				}));
			}

			this.renderDisposables.add(addDisposableListener(promptTa, EventType.INPUT, () => {
				selected.initPrompt = promptTa.value;
				this.markDirty();
				this.updateLivePreviewOnly();
			}));
		}

		// --- Card 3: Fixed Core Primitive API Permissions ---
		const card3 = append(editorCol, $('.ade-rs-card'));
		const c3Head = append(card3, $('.ade-rs-card-head'));
		const c3Title = append(c3Head, $('h3.ade-rs-card-title'));
		append(c3Title, $('span.ade-rs-step-badge', {}, '3'));
		append(c3Title, $('span', {}, localize('adeRoleStudioStep3', "Core Aexus-Code Primitive API Permissions")));
		append(c3Head, $('span.ade-rs-kernel-badge', {}, localize('adeRoleStudioKernelLocked', "Fixed Kernel Primitives · Runtime Enforced")));

		append(card3, $('p.ade-rs-card-hint', {}, localize(
			'adeRoleApisHint',
			"Core primitive APIs (messaging, reading context, hierarchy ops, project inspection, Inbox, DAG control) are fixed by Aexus-Code. Toggling an API both grants/revokes runtime kernel authorization AND auto-updates the CLI instructions injected into this rank's prompt.",
		)));

		if (!selected.pureExecution) {
			const quickBar = append(card3, $('.ade-rs-api-actions-bar'));
			const addQuickBtn = (label: string, apis: readonly AdePrimitiveApiId[]) => {
				const b = append(quickBar, $('button.ade-rs-btn', { type: 'button' }, label));
				this.renderDisposables.add(addDisposableListener(b, EventType.CLICK, () => {
					selected.allowedApis = [...apis];
					this.markDirty();
					this.render();
				}));
			};
			addQuickBtn(localize('adeRoleApisRecommended', "Recommended Orchestrator"), ['session.read_context', 'session.message', 'session.manage', 'project.read', 'inbox.post']);
			addQuickBtn(localize('adeRoleApisReadOnly', "Read-Only Reviewer"), ['session.read_context', 'project.read', 'engineering.read', 'engineering.review']);
			addQuickBtn(localize('adeRoleApisSelectAll', "Grant All"), ALL_ADE_PRIMITIVE_API_IDS);
			addQuickBtn(localize('adeRoleApisClearAll', "Revoke All"), []);
		}

		for (const cat of API_CATEGORY_ORDER) {
			const catApis = ADE_PRIMITIVE_APIS.filter(api => api.category === cat.id);
			if (catApis.length === 0) {
				continue;
			}
			const groupEl = append(card3, $('.ade-rs-api-group'));
			append(groupEl, $('.ade-rs-api-group-title', {}, cat.title));
			const apiGrid = append(groupEl, $('.ade-rs-api-grid'));

			for (const api of catApis) {
				const isChecked = !selected.pureExecution && selected.allowedApis.includes(api.id);
				const item = append(apiGrid, $('label.ade-rs-api-item'));
				item.classList.toggle('checked', isChecked);
				item.classList.toggle('disabled', selected.pureExecution);

				const cb = append(item, $('input', { type: 'checkbox' })) as HTMLInputElement;
				cb.checked = isChecked;
				cb.disabled = selected.pureExecution;
				cb.dataset.apiId = api.id;

				const apiBody = append(item, $('.ade-rs-api-body'));
				const tRow = append(apiBody, $('.ade-rs-api-title-row'));
				append(tRow, $('span.ade-rs-api-label', {}, api.label));
				append(tRow, $('code.ade-rs-api-id', {}, api.id));
				if (api.dangerous) {
					append(tRow, $('span.ade-rs-api-danger', {}, localize('adeRoleApiHighPriv', "High Privilege")));
				}
				append(apiBody, $('span.ade-rs-api-desc', {}, api.description));
				append(apiBody, $('span.ade-rs-api-cmds', {}, api.actions.join(' · ')));

				this.renderDisposables.add(addDisposableListener(cb, EventType.CHANGE, () => {
					if (cb.checked) {
						if (!selected.allowedApis.includes(api.id)) {
							selected.allowedApis.push(api.id);
						}
					} else {
						selected.allowedApis = selected.allowedApis.filter(id => id !== api.id);
					}
					item.classList.toggle('checked', cb.checked);
					this.markDirty();
					this.updateLivePreviewOnly();
				}));
			}
		}

		// --- Card 4: Live Compiled Prompt Preview ---
		const card4 = append(editorCol, $('.ade-rs-card'));
		const c4Head = append(card4, $('.ade-rs-card-head'));
		const c4Title = append(c4Head, $('h3.ade-rs-card-title'));
		append(c4Title, $('span.ade-rs-step-badge', {}, '4'));
		append(c4Title, $('span', {}, localize('adeRoleStudioStep4', "Live Compiled Prompt Preview")));
		this.previewTokenPillEl = append(c4Head, $('span.ade-rs-token-pill'));
		this.previewPreEl = append(card4, $('pre.ade-rs-preview-pre'));
		this.updateLivePreviewOnly();
		if (prevEditorScrollTop > 0) {
			editorCol.scrollTop = prevEditorScrollTop;
		}
	}
}
