/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { buildAdeDocsPaths, IAdeDocsPaths } from '../../../../platform/ade/common/adeDocsCatalog.js';
import {
	ADE_MAX_RANK_COUNT,
	ADE_MIN_RANK_COUNT,
	ADE_SECRETARY_ALIAS,
	ADE_SECRETARY_TIER_TAG,
	ADE_USER_ALIAS,
	ADE_USER_TIER_TAG,
	formatTierTag,
	resizeOrganizationRanks,
} from '../../../../platform/ade/common/adeRankResize.js';
import {
	ADE_ORGANIZATION_PRESETS,
	DEFAULT_ADE_MISSION_NAME,
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	getMissionDisplayName,
	IAdeOrganizationConfig,
	IAdeRankDefinition,
	normalizeAdeOrganizationConfig,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService, ServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ADE_CONFIG_SCHEME } from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import './media/adeConfigStudio.css';

interface IMutableRankEntry {
	id: string;
	name: string;
	shortName: string;
	tier: number;
	color: IAdeRankDefinition['color'];
	icon: IAdeRankDefinition['icon'];
	summary: string;
	initPrompt: string;
	pureExecution: boolean;
	canHaveSubordinates: boolean;
	defaultChildRankId?: string;
	allowedApis: IAdeRankDefinition['allowedApis'][number][];
}

interface IMutableConfigDraft {
	presetId?: string;
	missionName: string;
	slots?: IAdeOrganizationConfig['slots'];
	ranks: IMutableRankEntry[];
}

const MISSION_ALIAS_SUGGESTIONS = ['Engineering', 'Mission', 'Research'] as const;

function cloneConfigToDraft(config: IAdeOrganizationConfig): IMutableConfigDraft {
	return {
		presetId: config.presetId,
		missionName: getMissionDisplayName(config),
		slots: config.slots ? { ...config.slots } : undefined,
		ranks: [...config.ranks]
			.sort((a, b) => a.tier - b.tier)
			.map(r => ({
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

function draftToConfig(draft: IMutableConfigDraft): IAdeOrganizationConfig {
	return normalizeAdeOrganizationConfig({
		version: 1,
		presetId: draft.presetId,
		missionName: draft.missionName.trim() || DEFAULT_ADE_MISSION_NAME,
		...(draft.slots ? { slots: draft.slots } : {}),
		ranks: draft.ranks.map((r, idx) => ({
			...r,
			tier: idx + 1,
			shortName: r.name.trim().slice(0, 4) || `L${idx + 1}`,
			defaultChildRankId: idx + 1 < draft.ranks.length ? draft.ranks[idx + 1].id : undefined,
		})),
	});
}

export class AdeConfigEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeConfig';
	override readonly resource: URI = URI.from({ scheme: ADE_CONFIG_SCHEME, path: '/config' });

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton;
	}

	override get typeId(): string {
		return AdeConfigEditorInput.ID;
	}

	override getName(): string {
		return localize('adeConfigEditorTitle', "ADE config");
	}

	override getIcon(): ThemeIcon {
		return Codicon.settingsGear;
	}

	override matches(other: EditorInput): boolean {
		return other instanceof AdeConfigEditorInput;
	}
}

export class AdeConfigEditorSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof AdeConfigEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		return input instanceof AdeConfigEditorInput ? 'ade-config' : undefined;
	}

	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(AdeConfigEditorInput);
	}
}

/**
 * Core ADE configuration editor pane:
 * - Customize unified Mission mode display alias (e.g. Mission / Engineering / Research — hot-updates left sidebar)
 * - Configure rank depth (`N >= 1`, `L1` highest → `LN` lowest, `L0` fixed as Secretary) and custom rank names
 * - Inspect single-copy tier & sibling Mission API docs paths
 */
export class AdeConfigEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.adeConfig';

	private rootEl!: HTMLElement;
	private dirtyPillEl: HTMLElement | undefined;
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly roleSchemaService: IAdeRoleSchemaService | undefined;
	private readonly clipboardService: IClipboardService | undefined;
	private readonly notificationService: INotificationService | undefined;
	private draft: IMutableConfigDraft;
	private dirty = false;
	private saving = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(AdeConfigEditorPane.ID, group, telemetryService, themeService, storageService);
		const tryGet = <T>(id: ServiceIdentifier<T>): T | undefined => instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(id);
			} catch {
				return undefined;
			}
		});
		this.roleSchemaService = tryGet(IAdeRoleSchemaService);
		this.clipboardService = tryGet(IClipboardService);
		this.notificationService = tryGet(INotificationService);
		this.draft = cloneConfigToDraft(this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG);
		if (this.roleSchemaService) {
			this._register(this.roleSchemaService.onDidChangeSchema(updated => {
				if (!this.dirty) {
					this.draft = cloneConfigToDraft(updated);
					this.render();
				}
			}));
		}
	}

	protected createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.ade-config-editor', {
			tabindex: 0,
			role: 'region',
			'aria-label': localize('adeConfigRegionAria', "ADE config"),
		}));
		this._register(addDisposableListener(this.rootEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
				e.preventDefault();
				void this.saveDraft();
			}
		}));
		this.render();
	}

	override async setInput(input: AdeConfigEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!this.dirty && this.roleSchemaService) {
			this.draft = cloneConfigToDraft(this.roleSchemaService.getConfig());
		}
		this.render();
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

	private getDocsPaths(): IAdeDocsPaths {
		const live = this.roleSchemaService?.getDocsPaths?.();
		const homeRoot = live ? live.docsRoot.replace(/[\\/]docs$/, '') : '~/.aexus-code';
		return buildAdeDocsPaths(homeRoot, this.draft.ranks.length);
	}

	private markDirty(): void {
		this.dirty = true;
		if (this.dirtyPillEl) {
			this.dirtyPillEl.hidden = false;
		}
	}

	private applyRankCount(nextCount: number): void {
		const clamped = Math.max(ADE_MIN_RANK_COUNT, Math.min(ADE_MAX_RANK_COUNT, Math.floor(nextCount)));
		if (clamped === this.draft.ranks.length) {
			return;
		}
		const resized = resizeOrganizationRanks(draftToConfig(this.draft), clamped);
		this.draft = cloneConfigToDraft(resized);
		this.dirty = true;
		this.render();
	}

	private async applyPreset(presetId: string): Promise<void> {
		const preset = ADE_ORGANIZATION_PRESETS.find(p => p.id === presetId);
		if (!preset) {
			return;
		}
		const currentMissionName = this.draft.missionName;
		this.draft = cloneConfigToDraft({ ...preset.config, missionName: currentMissionName });
		this.dirty = true;
		this.render();
		await this.saveDraft();
	}

	private async resetToDefault(): Promise<void> {
		this.draft = cloneConfigToDraft(DEFAULT_ADE_ORGANIZATION_CONFIG);
		this.dirty = true;
		this.render();
		await this.saveDraft();
	}

	private async saveDraft(): Promise<void> {
		if (this.saving) {
			return;
		}
		this.saving = true;
		try {
			const normalized = draftToConfig(this.draft);
			if (this.roleSchemaService) {
				const saved = await this.roleSchemaService.updateConfig(normalized);
				await this.roleSchemaService.syncDocs?.();
				this.draft = cloneConfigToDraft(saved);
			} else {
				this.draft = cloneConfigToDraft(normalized);
			}
			this.dirty = false;
			this.render();
			this.notificationService?.info(localize(
				'adeConfigSavedHotReload',
				"ADE config applied ({0} mode, {1} rank tier(s), hot-updated live).",
				this.draft.missionName,
				this.draft.ranks.length,
			));
		} catch (err) {
			this.notificationService?.error(err instanceof Error ? err.message : String(err));
		} finally {
			this.saving = false;
		}
	}

	private render(): void {
		if (!this.rootEl) {
			return;
		}
		this.renderDisposables.clear();
		clearNode(this.rootEl);

		const shell = append(this.rootEl, $('.ade-cfg-shell'));
		this.renderHeader(shell);
		this.renderMissionAliasCard(shell);
		this.renderRankHierarchyCard(shell);
		this.renderDocsCard(shell);
	}

	private renderHeader(shell: HTMLElement): void {
		const header = append(shell, $('.ade-cfg-header'));
		const titleBlock = append(header, $('.ade-cfg-title-block'));
		const titleRow = append(titleBlock, $('.ade-cfg-title-row'));
		append(titleRow, $('h1.ade-cfg-title', {}, localize('adeConfigHeading', "ADE config")));
		this.dirtyPillEl = append(titleRow, $('span.ade-cfg-dirty-pill', {}, localize('adeConfigUnsaved', "Unsaved")));
		this.dirtyPillEl.hidden = !this.dirty;
		append(titleBlock, $('p.ade-cfg-subtitle', {}, localize(
			'adeConfigSubtitle',
			"Customize Engineering mode display alias, rank depth (L-1 User → L0 Secretary → L1 highest → LN lowest), and custom tier names.",
		)));

		const actions = append(header, $('.ade-cfg-actions'));

		const presetSelect = append(actions, $('select.ade-cfg-preset-select', {
			'aria-label': localize('adeConfigPresetAria', "Configuration Preset"),
		})) as HTMLSelectElement;
		const presets = this.roleSchemaService?.getPresets() ?? ADE_ORGANIZATION_PRESETS;
		for (const preset of presets) {
			const opt = append(presetSelect, $('option', { value: preset.id }, preset.name)) as HTMLOptionElement;
			if (this.draft.presetId === preset.id) {
				opt.selected = true;
			}
		}
		if (!presets.some(p => p.id === this.draft.presetId)) {
			const customOpt = append(presetSelect, $('option', { value: 'custom' }, localize('adeConfigCustomPreset', "Custom Configuration"))) as HTMLOptionElement;
			customOpt.selected = true;
		}
		this.renderDisposables.add(addDisposableListener(presetSelect, EventType.CHANGE, () => {
			if (presetSelect.value && presetSelect.value !== 'custom') {
				void this.applyPreset(presetSelect.value);
			}
		}));

		const resetBtn = append(actions, $('button.ade-cfg-btn', { type: 'button' }, localize('adeConfigResetBtn', "Reset Default")));
		this.renderDisposables.add(addDisposableListener(resetBtn, EventType.CLICK, () => {
			void this.resetToDefault();
		}));

		const saveBtn = append(actions, $('button.ade-cfg-btn.primary', {
			type: 'button',
			'data-ade-config-save': 'true',
		}, localize('adeConfigSaveBtn', "Save & Apply")));
		this.renderDisposables.add(addDisposableListener(saveBtn, EventType.CLICK, () => {
			void this.saveDraft();
		}));
	}

	private renderMissionAliasCard(shell: HTMLElement): void {
		const card = append(shell, $('.ade-cfg-card'));
		const header = append(card, $('.ade-cfg-card-header'));
		const titleGroup = append(header, $('.ade-cfg-card-title-group'));
		append(titleGroup, $('h2.ade-cfg-card-title', {}, localize('adeConfigMissionAliasTitle', "Engineering Mode Display Name")));
		append(titleGroup, $('p.ade-cfg-card-hint', {}, localize(
			'adeConfigMissionAliasHint',
			"Engineering encompasses both Mission (Task DAG) and Orchestration (All-Staff Topology) views. Rename freely — left sidebar badges & tabs hot-update live.",
		)));

		const body = append(card, $('.ade-cfg-mission-row'));
		const aliasInput = append(body, $('input.ade-cfg-input.mission-alias', {
			type: 'text',
			maxlength: '32',
			value: this.draft.missionName,
			placeholder: DEFAULT_ADE_MISSION_NAME,
			'aria-label': localize('adeConfigMissionAliasInputAria', "Engineering mode display alias"),
			'data-ade-mission-alias-input': 'true',
		})) as HTMLInputElement;

		this.renderDisposables.add(addDisposableListener(aliasInput, EventType.INPUT, () => {
			this.draft.missionName = aliasInput.value;
			this.markDirty();
		}));

		const chipsWrap = append(body, $('.ade-cfg-chip-group'));
		for (const suggestion of MISSION_ALIAS_SUGGESTIONS) {
			const chip = append(chipsWrap, $(`button.ade-cfg-chip${this.draft.missionName === suggestion ? '.active' : ''}`, {
				type: 'button',
				'data-mission-alias-chip': suggestion,
			}, suggestion)) as HTMLButtonElement;
			this.renderDisposables.add(addDisposableListener(chip, EventType.CLICK, () => {
				this.draft.missionName = suggestion;
				aliasInput.value = suggestion;
				this.markDirty();
				this.render();
			}));
		}
	}

	private renderRankHierarchyCard(shell: HTMLElement): void {
		const count = this.draft.ranks.length;
		const card = append(shell, $('.ade-cfg-card'));
		const cardHeader = append(card, $('.ade-cfg-card-header'));
		const titleGroup = append(cardHeader, $('.ade-cfg-card-title-group'));
		append(titleGroup, $('h2.ade-cfg-card-title', {}, localize('adeConfigRanksTitle', "Rank Hierarchy & Live Aliases")));
		append(titleGroup, $('p.ade-cfg-card-hint', {}, localize(
			'adeConfigRanksHint',
			"Configure organization tiers (L1..L{0} beneath L-1 User & L0 Secretary) and hot-reload display names. Roles read API docs by tier.",
			count,
		)));

		const stepperWrap = append(cardHeader, $('.ade-cfg-stepper-wrap'));
		append(stepperWrap, $('span.ade-cfg-stepper-label', {}, localize('adeConfigRankCountLabel', "Rank tiers (≥ 1)")));
		const stepper = append(stepperWrap, $('.ade-cfg-stepper'));
		const decBtn = append(stepper, $('button.ade-cfg-step-btn', {
			type: 'button',
			'aria-label': localize('adeConfigDecreaseRankCount', "Decrease rank count"),
			'data-ade-rank-dec': 'true',
		}, '−')) as HTMLButtonElement;
		decBtn.disabled = count <= ADE_MIN_RANK_COUNT;
		append(stepper, $('span.ade-cfg-step-value', { 'data-ade-rank-count': String(count) }, String(count)));
		const incBtn = append(stepper, $('button.ade-cfg-step-btn', {
			type: 'button',
			'aria-label': localize('adeConfigIncreaseRankCount', "Increase rank count"),
			'data-ade-rank-inc': 'true',
		}, '+')) as HTMLButtonElement;
		incBtn.disabled = count >= ADE_MAX_RANK_COUNT;

		this.renderDisposables.add(addDisposableListener(decBtn, EventType.CLICK, () => this.applyRankCount(count - 1)));
		this.renderDisposables.add(addDisposableListener(incBtn, EventType.CLICK, () => this.applyRankCount(count + 1)));

		const list = append(card, $('.ade-cfg-rank-list'));
		const headRow = append(list, $('.ade-cfg-rank-row.compact.head'));
		append(headRow, $('span', {}, localize('adeConfigColTier', "Tier")));
		append(headRow, $('span', {}, localize('adeConfigColAlias', "Display Name (Hot-Reload)")));
		append(headRow, $('span', { style: 'justify-self:end' }, localize('adeConfigColDoc', "API Doc")));

		// Fixed L-1 User row (Human sovereign operator above L0)
		const userRow = append(list, $('.ade-cfg-rank-row.compact.system-user', { 'data-tier': ADE_USER_TIER_TAG }));
		const userTierCell = append(userRow, $('.ade-cfg-tier-cell'));
		append(userTierCell, $('span.ade-cfg-tier-pill.tier-user', {}, ADE_USER_TIER_TAG));
		append(userTierCell, $('span.ade-cfg-tier-note', {}, localize('adeConfigHumanNote', "Human")));
		const userName = append(userRow, $('.ade-cfg-static-name'));
		append(userName, $('span', {}, ADE_USER_ALIAS));
		append(userName, $('span.ade-cfg-static-badge', {}, localize('adeConfigFixedUser', "Owner L-1")));
		append(userRow, $('span.ade-cfg-doc-pill', {}, localize('adeConfigUserOperatorTag', "Operator")));

		// Fixed L0 Secretary row
		const l0Row = append(list, $('.ade-cfg-rank-row.compact.system-l0', { 'data-tier': ADE_SECRETARY_TIER_TAG }));
		const l0TierCell = append(l0Row, $('.ade-cfg-tier-cell'));
		append(l0TierCell, $('span.ade-cfg-tier-pill.tier-l0', {}, ADE_SECRETARY_TIER_TAG));
		append(l0TierCell, $('span.ade-cfg-tier-note', {}, localize('adeConfigSystemNote', "System")));
		const l0Name = append(l0Row, $('.ade-cfg-static-name'));
		append(l0Name, $('span', {}, ADE_SECRETARY_ALIAS));
		append(l0Name, $('span.ade-cfg-static-badge', {}, localize('adeConfigFixedGlobal', "Default L0")));
		append(l0Row, $('span.ade-cfg-doc-pill', {}, `ranks/${ADE_SECRETARY_TIER_TAG}.md`));

		// Editable L1..LN rows (L1, L2... always preserved!)
		this.draft.ranks.forEach((rank, index) => {
			const tier = index + 1;
			const tierTag = formatTierTag(tier);
			const row = append(list, $('.ade-cfg-rank-row.compact', { 'data-tier': tierTag, 'data-rank-id': rank.id }));

			const tierCell = append(row, $('.ade-cfg-tier-cell'));
			append(tierCell, $(`span.ade-cfg-tier-pill${tier === 1 ? '.tier-top' : ''}`, {}, tierTag));
			const roleNote = count === 1
				? localize('adeConfigOnlyTier', "Only")
				: tier === 1
					? localize('adeConfigHighestTier', "Highest")
					: tier === count
						? localize('adeConfigLowestTier', "Lowest")
						: '';
			if (roleNote) {
				append(tierCell, $('span.ade-cfg-tier-note', {}, roleNote));
			}

			const aliasInput = append(row, $('input.ade-cfg-input.alias', {
				type: 'text',
				value: rank.name,
				'aria-label': localize('adeConfigAliasInputAria', "{0} display name", tierTag),
				'data-tier-alias': tierTag,
			})) as HTMLInputElement;
			this.renderDisposables.add(addDisposableListener(aliasInput, EventType.INPUT, () => {
				rank.name = aliasInput.value;
				if (this.draft.presetId === 'default-4tier') {
					this.draft.presetId = 'custom';
				}
				this.markDirty();
			}));

			append(row, $('span.ade-cfg-doc-pill', {}, `ranks/${tierTag}.md`));
		});
	}

	private renderDocsCard(shell: HTMLElement): void {
		const docs = this.getDocsPaths();
		const card = append(shell, $('.ade-cfg-card'));
		const header = append(card, $('.ade-cfg-card-header'));
		const titleGroup = append(header, $('.ade-cfg-card-title-group'));
		append(titleGroup, $('h2.ade-cfg-card-title', {}, localize('adeConfigDocsTitle', "Single-Copy API Docs & Engineering Reference")));
		append(titleGroup, $('p.ade-cfg-card-hint', {}, localize(
			'adeConfigDocsHint',
			"Stored once in a shared location. Roles read strictly by L<tier>; Engineering docs (Mission & Orchestration) live alongside ranks/ and are read on demand.",
		)));

		const headerBtns = append(header, $('.ade-cfg-actions'));
		const copyBtn = append(headerBtns, $('button.ade-cfg-btn', { type: 'button' }, localize('adeConfigCopyDocsPath', "Copy Docs Path")));
		this.renderDisposables.add(addDisposableListener(copyBtn, EventType.CLICK, () => {
			void this.clipboardService?.writeText(docs.docsRoot);
			this.notificationService?.info(localize('adeConfigCopiedDocsPath', "Copied API docs path: {0}", docs.docsRoot));
		}));
		if (this.roleSchemaService?.syncDocs) {
			const syncBtn = append(headerBtns, $('button.ade-cfg-btn', { type: 'button' }, localize('adeConfigSyncDocsNow', "Sync Docs")));
			this.renderDisposables.add(addDisposableListener(syncBtn, EventType.CLICK, () => {
				void this.roleSchemaService?.syncDocs?.().then(synced => {
					this.notificationService?.info(localize('adeConfigSyncedDocsDone', "Synced single-copy API docs to {0}.", synced.docsRoot));
					this.render();
				});
			}));
		}

		const body = append(card, $('.ade-cfg-docs-body'));
		const grid = append(body, $('.ade-cfg-docs-grid'));

		const ranksBox = append(grid, $('.ade-cfg-doc-box'));
		const ranksTitle = append(ranksBox, $('.ade-cfg-doc-box-title'));
		const ranksIcon = append(ranksTitle, $('span'));
		ranksIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.book));
		append(ranksTitle, $('span', {}, localize('adeConfigRanksDocsBoxTitle', "Native Rank Docs (L0 .. L{0})", this.draft.ranks.length)));
		append(ranksBox, $('.ade-cfg-doc-box-path', { 'data-ade-docs-ranks': docs.ranksDir }, docs.ranksDir));
		append(ranksBox, $('.ade-cfg-doc-box-desc', {}, localize(
			'adeConfigRanksDocsBoxDesc',
			"Contains L0.md through L{0}.md (pure Native Rank CLI APIs). Indexed strictly by tier so custom alias renames never invalidate role manuals.",
			this.draft.ranks.length,
		)));

		if (docs.engineeringDir) {
			const engBox = append(grid, $('.ade-cfg-doc-box'));
			const engTitle = append(engBox, $('.ade-cfg-doc-box-title'));
			const engIcon = append(engTitle, $('span'));
			engIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.organization));
			append(engTitle, $('span', {}, localize('adeConfigEngineeringDocsBoxTitle', "Engineering Paradigm & API (Sibling · On Demand)")));
			append(engBox, $('.ade-cfg-doc-box-path', { 'data-ade-docs-engineering': docs.engineeringDir }, docs.engineeringDir));
			append(engBox, $('.ade-cfg-doc-box-desc', {}, localize(
				'adeConfigEngineeringDocsBoxDesc',
				"Contains ENGINEERING_PARADIGM.md (token rules, dual-view workflow, staffing & Task DAG) and ENGINEERING_API.md, placed alongside ranks/.",
			)));
		}

		const missionBox = append(grid, $('.ade-cfg-doc-box'));
		const missionTitle = append(missionBox, $('.ade-cfg-doc-box-title'));
		const missionIcon = append(missionTitle, $('span'));
		missionIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.typeHierarchySub));
		append(missionTitle, $('span', {}, localize('adeConfigMissionDocsBoxTitle', "Unified Mission Reference (Sibling · On Demand)")));
		append(missionBox, $('.ade-cfg-doc-box-path', { 'data-ade-docs-mission': docs.missionDoc }, docs.missionDoc));
		append(missionBox, $('.ade-cfg-doc-box-desc', {}, localize(
			'adeConfigMissionDocsBoxDesc',
			"Unified Engineering/Mission API reference placed alongside ranks/ and engineering/. Read on demand.",
		)));
	}
}
