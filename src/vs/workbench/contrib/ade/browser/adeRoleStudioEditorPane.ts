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
	ADE_WORK_TREE_SLOTS,
	AdePrimitiveApiCategory,
	AdePrimitiveApiId,
	AdeRankColorToken,
	AdeRankIconToken,
	AdeWorkTreeSlot,
	ALL_ADE_PRIMITIVE_API_IDS,
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	IAdeOrganizationConfig,
	IAdeRankDefinition,
	normalizeAdeOrganizationConfig,
	previewCompiledRankPrompt,
	resolveWorkTreeSlotRank,
	sanitizeRankId,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import {
	EditorInputCapabilities,
	GroupIdentifier,
	IEditorOpenContext,
	IEditorSerializer,
	IRevertOptions,
	ISaveOptions,
	IUntypedEditorInput,
} from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ADE_ROLE_STUDIO_SCHEME, IAdeProjectsService } from '../common/ade.js';
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

export interface IAdeRoleStudioEditorDelegate {
	isDirty(): boolean;
	save(): Promise<boolean>;
	revert(): Promise<void>;
}

export class AdeRoleStudioEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeRoleStudio';
	override readonly resource = URI.from({ scheme: ADE_ROLE_STUDIO_SCHEME, path: '/studio' });

	private _focusRankId: string | undefined;
	private _delegate: IAdeRoleStudioEditorDelegate | undefined;

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

	bindDelegate(delegate: IAdeRoleStudioEditorDelegate | undefined): void {
		const prevDirty = this.isDirty();
		this._delegate = delegate;
		if (prevDirty !== this.isDirty()) {
			this._onDidChangeDirty.fire();
		}
	}

	notifyDirtyChange(): void {
		this._onDidChangeDirty.fire();
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton;
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

	override isDirty(): boolean {
		return this._delegate?.isDirty() ?? false;
	}

	override async save(_group: GroupIdentifier, _options?: ISaveOptions): Promise<EditorInput | IUntypedEditorInput | undefined> {
		if (!this._delegate) {
			return this;
		}
		const saved = await this._delegate.save();
		return saved ? this : undefined;
	}

	override async revert(_group: GroupIdentifier, _options?: IRevertOptions): Promise<void> {
		await this._delegate?.revert();
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
	originalId: string;
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
	slots?: Partial<Record<AdeWorkTreeSlot, string>>;
	ranks: IMutableRankDraft[];
}

interface IPrePureRankSnapshot {
	readonly initPrompt: string;
	readonly allowedApis: readonly AdePrimitiveApiId[];
	readonly canHaveSubordinates: boolean;
	readonly defaultChildRankId?: string;
}

function cloneToDraft(config: IAdeOrganizationConfig): IMutableOrgDraft {
	return {
		version: 1,
		presetId: config.presetId,
		...(config.slots ? { slots: { ...config.slots } } : {}),
		ranks: config.ranks.map(r => ({
			originalId: r.id,
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
		...(draft.slots ? { slots: { ...draft.slots } } : {}),
		ranks: draft.ranks.map(r => ({ ...r, allowedApis: [...r.allowedApis] })),
	});
}

function tryResolveOptional<T>(instantiationService: IInstantiationService, id: { (...args: unknown[]): unknown; toString(): string }): T | undefined {
	return instantiationService.invokeFunction(accessor => {
		try {
			return accessor.get(id as never) as T;
		} catch {
			return undefined;
		}
	});
}

const API_CATEGORY_ORDER: readonly { readonly id: AdePrimitiveApiCategory; readonly title: string }[] = [
	{ id: 'messaging', title: 'Messaging, Context & Human Inbox' },
	{ id: 'hierarchy', title: 'Hierarchy & Session Lifecycle' },
	{ id: 'workspace', title: 'Workspace, Files & Cloud Hosts' },
	{ id: 'engineering', title: 'Mission DAG Workflow' },
];

export class AdeRoleStudioEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.adeRoleStudio';

	private rootEl: HTMLElement | undefined;
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly dialogService: IDialogService | undefined;
	private readonly projectsService: IAdeProjectsService | undefined;
	private draft: IMutableOrgDraft;
	private selectedRankId: string;
	private viewMode: 'editor' | 'matrix' = 'editor';
	private dirty = false;
	private isSaving = false;
	private importBarVisible = false;
	private importDraftText = '';
	private boundInput: AdeRoleStudioEditorInput | undefined;
	private dirtyPillEl: HTMLElement | undefined;
	private revertBtnEl: HTMLButtonElement | undefined;
	private previewPreEl: HTMLElement | undefined;
	private previewTokenPillEl: HTMLElement | undefined;
	private editorColEl: HTMLElement | undefined;
	private readonly prePureSnapshots = new Map<string, IPrePureRankSnapshot>();
	private readonly rankCardRefs = new Map<string, { card: HTMLElement; iconEl: HTMLElement; nameEl: HTMLElement; pillEl: HTMLElement }>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAdeRoleSchemaService private readonly roleSchemaService: IAdeRoleSchemaService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(AdeRoleStudioEditorPane.ID, group, telemetryService, themeService, storageService);
		this.dialogService = tryResolveOptional<IDialogService>(instantiationService, IDialogService);
		this.projectsService = tryResolveOptional<IAdeProjectsService>(instantiationService, IAdeProjectsService);
		this.draft = cloneToDraft(this.roleSchemaService.getConfig());
		this.selectedRankId = this.draft.ranks[0]?.id ?? 'governor';
		this._register(this.roleSchemaService.onDidChangeSchema(next => {
			if (!this.dirty) {
				this.draft = cloneToDraft(next);
				this.prePureSnapshots.clear();
				if (!this.draft.ranks.some(r => r.id === this.selectedRankId)) {
					this.selectedRankId = this.draft.ranks[0]?.id ?? '';
				}
				this.render();
			}
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.ade-role-studio', {
			role: 'region',
			'aria-label': localize('adeRoleStudioRegionAria', "Organization & Roles Studio"),
		}));
		this._register(addDisposableListener(this.rootEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
				e.preventDefault();
				e.stopPropagation();
				void this.saveDraft();
			}
		}));
		this.render();
	}

	override async setInput(
		input: AdeRoleStudioEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		if (this.boundInput && this.boundInput !== input) {
			this.boundInput.bindDelegate(undefined);
		}
		await super.setInput(input, options, context, token);
		this.boundInput = input;
		input.bindDelegate({
			isDirty: () => this.dirty,
			save: () => this.saveDraft(),
			revert: () => this.revertDraft(),
		});
		if (input.focusRankId && this.draft.ranks.some(r => r.id === input.focusRankId)) {
			this.selectedRankId = input.focusRankId;
		}
		this.render();
	}

	override clearInput(): void {
		this.boundInput?.bindDelegate(undefined);
		this.boundInput = undefined;
		super.clearInput();
	}

	override dispose(): void {
		this.boundInput?.bindDelegate(undefined);
		this.boundInput = undefined;
		super.dispose();
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

	private setDirty(nextDirty: boolean): void {
		const changed = this.dirty !== nextDirty;
		this.dirty = nextDirty;
		if (this.dirtyPillEl) {
			this.dirtyPillEl.hidden = !nextDirty;
		}
		if (this.revertBtnEl) {
			this.revertBtnEl.disabled = !nextDirty;
		}
		if (changed) {
			this.boundInput?.notifyDirtyChange();
		}
	}

	private markDirty(customPreset = true): void {
		if (customPreset) {
			this.draft.presetId = 'custom';
		}
		this.setDirty(true);
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

	private updateSelectedCardMetaInPlace(rank: IMutableRankDraft): void {
		const ref = this.rankCardRefs.get(rank.id);
		if (!ref) {
			return;
		}
		for (const token of ADE_RANK_COLOR_TOKENS) {
			ref.card.classList.toggle(`color-${token}`, rank.color === token);
		}
		ref.iconEl.className = 'ade-rs-rank-icon';
		ref.iconEl.classList.add(...ThemeIcon.asClassNameArray(resolveAdeRankCodicon(rank.icon)));
		ref.nameEl.textContent = rank.name;
		ref.pillEl.classList.toggle('pure', rank.pureExecution);
		ref.pillEl.textContent = rank.pureExecution
			? localize('adeRoleStudioPureLeafPill', "Pure Leaf · 0 APIs")
			: localize('adeRoleStudioApiCountPill', "{0} Core APIs", rank.allowedApis.length);
		ref.pillEl.title = rank.id;
	}

	private migrateRenamedRanksOnLiveSessions(renames: ReadonlyArray<readonly [string, string]>): number {
		if (!this.projectsService || renames.length === 0) {
			return 0;
		}
		let migratedTotal = 0;
		const migrator = this.projectsService as IAdeProjectsService & { migrateRankId?: (oldId: string, newId: string) => number };
		for (const [oldId, newId] of renames) {
			if (typeof migrator.migrateRankId === 'function') {
				migratedTotal += migrator.migrateRankId(oldId, newId);
			} else {
				const prevLower = oldId.trim().toLowerCase();
				for (const agent of this.projectsService.agents) {
					if (agent.role && agent.role.trim().toLowerCase() === prevLower) {
						this.projectsService.setAgentRole(agent.id, newId);
						migratedTotal++;
					}
				}
			}
		}
		return migratedTotal;
	}

	private async saveDraft(): Promise<boolean> {
		if (this.isSaving) {
			return false;
		}
		this.isSaving = true;
		try {
			const renames: Array<readonly [string, string]> = [];
			for (const rank of this.draft.ranks) {
				if (rank.originalId && rank.originalId !== rank.id) {
					renames.push([rank.originalId, rank.id]);
				}
			}
			const normalized = draftToConfig(this.draft);
			await this.roleSchemaService.updateConfig(normalized);
			const migratedCount = this.migrateRenamedRanksOnLiveSessions(renames);
			this.draft = cloneToDraft(normalized);
			this.prePureSnapshots.clear();
			if (!this.draft.ranks.some(r => r.id === this.selectedRankId)) {
				this.selectedRankId = this.draft.ranks[0]?.id ?? '';
			}
			this.setDirty(false);
			this.render();
			this.notificationService.info(migratedCount > 0
				? localize(
					'adeRoleStudioSavedMigrated',
					"Saved ADE organization schema ({0} rank(s)) and migrated {1} live session(s) to updated rank IDs.",
					normalized.ranks.length,
					migratedCount,
				)
				: localize(
					'adeRoleStudioSaved',
					"Saved ADE organization schema ({0} rank(s)) to Settings. All prompts, sidebar badges, and kernel API permissions are now live.",
					normalized.ranks.length,
				));
			return true;
		} catch (err) {
			this.notificationService.error(localize(
				'adeRoleStudioSaveFailed',
				"Failed to save ADE organization settings: {0}",
				err instanceof Error ? err.message : String(err),
			));
			return false;
		} finally {
			this.isSaving = false;
		}
	}

	private async revertDraft(): Promise<void> {
		this.draft = cloneToDraft(this.roleSchemaService.getConfig());
		this.prePureSnapshots.clear();
		if (!this.draft.ranks.some(r => r.id === this.selectedRankId)) {
			this.selectedRankId = this.draft.ranks[0]?.id ?? '';
		}
		this.setDirty(false);
		this.render();
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
			originalId: id,
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
		if (this.draft.slots) {
			for (const slot of ADE_WORK_TREE_SLOTS) {
				if (this.draft.slots[slot] === rankId) {
					delete this.draft.slots[slot];
				}
			}
		}
		if (this.selectedRankId === rankId) {
			this.selectedRankId = this.draft.ranks[0]?.id ?? '';
		}
		this.markDirty();
		this.render();
	}

	private renderPermissionMatrix(body: HTMLElement): void {
		const matrixWrap = append(body, $('.ade-rs-matrix-wrap', {
			role: 'tabpanel',
			'aria-label': localize('adeRoleStudioMatrixPanelAria', "Rank by Kernel API Permission Matrix"),
		}));
		const matrixCard = append(matrixWrap, $('.ade-rs-card'));
		const head = append(matrixCard, $('.ade-rs-card-head'));
		const title = append(head, $('h3.ade-rs-card-title'));
		append(title, $('span', {}, localize('adeRoleStudioMatrixTitle', "Rank × Fixed Kernel API Permission Matrix")));
		append(head, $('span.ade-rs-kernel-badge', {}, localize('adeRoleStudioKernelLocked', "Fixed Kernel Primitives · Runtime Enforced")));
		append(matrixCard, $('p.ade-rs-card-hint', {}, localize(
			'adeRoleStudioMatrixHint',
			"Audit and toggle kernel primitive API grants across every rank in one view. Pure Execution leaf ranks are permanently locked to 0 APIs; High Privilege APIs are highlighted in rose.",
		)));

		const sortedRanks = [...this.draft.ranks].sort((a, b) => a.tier - b.tier);
		const tableScroll = append(matrixCard, $('.ade-rs-matrix-scroll'));
		const table = append(tableScroll, $('table.ade-rs-matrix-table', {
			role: 'grid',
			'aria-label': localize('adeRoleStudioMatrixTableAria', "Permission Matrix"),
		}));
		const thead = append(table, $('thead'));
		const headRow = append(thead, $('tr'));
		append(headRow, $('th.ade-rs-matrix-api-col', { scope: 'col' }, localize('adeRoleStudioMatrixApiCol', "Fixed Kernel Primitive API")));

		const countBadgesByRank = new Map<string, HTMLElement>();
		for (const rank of sortedRanks) {
			const th = append(headRow, $(`th.ade-rs-matrix-rank-col.color-${rank.color}`, {
				scope: 'col',
				'data-rank-id': rank.id,
			}));
			const colHead = append(th, $('.ade-rs-matrix-rank-head'));
			append(colHead, $('span.ade-rs-tier-badge', {}, `L${rank.tier}`));
			append(colHead, $('span.ade-rs-matrix-rank-name', {}, rank.name));
			const countEl = append(colHead, $(`span.ade-rs-rank-pill${rank.pureExecution ? '.pure' : ''}`, {}, rank.pureExecution
				? localize('adeRoleStudioMatrixPureShort', "Pure · 0")
				: `${rank.allowedApis.length}/${ADE_PRIMITIVE_APIS.length}`));
			countBadgesByRank.set(rank.id, countEl);
		}

		const tbody = append(table, $('tbody'));
		for (const cat of API_CATEGORY_ORDER) {
			const catApis = ADE_PRIMITIVE_APIS.filter(api => api.category === cat.id);
			if (catApis.length === 0) {
				continue;
			}
			const catRow = append(tbody, $('tr.ade-rs-matrix-cat-row'));
			append(catRow, $('td', { colSpan: String(sortedRanks.length + 1) }, cat.title));

			for (const api of catApis) {
				const row = append(tbody, $(`tr.ade-rs-matrix-row${api.dangerous ? '.dangerous' : ''}`, {
					'data-api-id': api.id,
				}));
				const apiCell = append(row, $('th.ade-rs-matrix-api-cell', { scope: 'row', title: api.actions.join(' · ') }));
				const apiTop = append(apiCell, $('.ade-rs-api-title-row'));
				append(apiTop, $('span.ade-rs-api-label', {}, api.label));
				append(apiTop, $('code.ade-rs-api-id', {}, api.id));
				if (api.dangerous) {
					append(apiTop, $('span.ade-rs-api-danger', {}, localize('adeRoleApiHighPriv', "High Privilege")));
				}
				append(apiCell, $('div.ade-rs-api-desc', {}, api.description));

				for (const rank of sortedRanks) {
					const isChecked = !rank.pureExecution && rank.allowedApis.includes(api.id);
					const td = append(row, $(`td.ade-rs-matrix-cell${isChecked ? '.granted' : ''}${rank.pureExecution ? '.pure-locked' : ''}`));
					const cb = append(td, $('input.ade-rs-matrix-cb', {
						type: 'checkbox',
						'aria-label': localize('adeRoleStudioMatrixCellAria', "Grant {0} ({1}) to {2}", api.label, api.id, rank.name),
					})) as HTMLInputElement;
					cb.checked = isChecked;
					cb.disabled = rank.pureExecution;
					cb.dataset.rankId = rank.id;
					cb.dataset.apiId = api.id;
					this.renderDisposables.add(addDisposableListener(cb, EventType.CHANGE, () => {
						if (cb.checked) {
							if (!rank.allowedApis.includes(api.id)) {
								rank.allowedApis.push(api.id);
							}
						} else {
							rank.allowedApis = rank.allowedApis.filter(id => id !== api.id);
						}
						td.classList.toggle('granted', cb.checked);
						const badge = countBadgesByRank.get(rank.id);
						if (badge && !rank.pureExecution) {
							badge.textContent = `${rank.allowedApis.length}/${ADE_PRIMITIVE_APIS.length}`;
						}
						this.markDirty();
					}));
				}
			}
		}
	}

	private render(): void {
		if (!this.rootEl) {
			return;
		}
		const prevEditorScrollTop = this.editorColEl?.scrollTop ?? 0;
		this.renderDisposables.clear();
		this.rankCardRefs.clear();
		clearNode(this.rootEl);

		// 1. Sticky Header + Presets + View Mode Toggle
		const header = append(this.rootEl, $('.ade-rs-header'));
		const headerTop = append(header, $('.ade-rs-header-top'));
		const titleGroup = append(headerTop, $('.ade-rs-title-group'));
		const titleRow = append(titleGroup, $('.ade-rs-title-row'));
		append(titleRow, $('h2.ade-rs-title', {}, localize('adeRoleStudioHeaderTitle', "Organization & Roles Studio")));
		append(titleRow, $('span.ade-rs-philosophy-pill', {}, localize('adeRoleStudioPhilosophyBadge', "Everything is Extensible")));
		this.dirtyPillEl = append(titleRow, $('span.ade-rs-dirty-pill', { 'aria-live': 'polite' }, localize('adeRoleStudioUnsavedBadge', "Unsaved Changes")));
		this.dirtyPillEl.hidden = !this.dirty;
		append(titleGroup, $('p.ade-rs-subtitle', {}, localize(
			'adeRoleStudioSubtitle',
			"Design your own multi-agent hierarchy like filling in the blanks: define ranks, author each rank's initialization prompt, and grant fixed Aexus-Code kernel API permissions.",
		)));

		const toolbar = append(headerTop, $('.ade-rs-toolbar', {
			role: 'toolbar',
			'aria-label': localize('adeRoleStudioToolbarAria', "Role Studio Actions"),
		}));
		const addToolbarBtn = (label: string, icon: ThemeIcon, cls: string, onClick: () => void, disabled = false) => {
			const btn = append(toolbar, $(`button.ade-rs-btn${cls ? `.${cls}` : ''}`, { type: 'button', 'aria-label': label })) as HTMLButtonElement;
			btn.disabled = disabled;
			const glyph = append(btn, $('span', { 'aria-hidden': 'true' }));
			glyph.classList.add(...ThemeIcon.asClassNameArray(icon));
			append(btn, $('span', {}, label));
			this.renderDisposables.add(addDisposableListener(btn, EventType.CLICK, () => onClick()));
			return btn;
		};

		addToolbarBtn(localize('adeRoleStudioSave', "Save to Settings"), Codicon.check, 'primary', () => {
			void this.saveDraft();
		});
		this.revertBtnEl = addToolbarBtn(localize('adeRoleStudioRevert', "Revert"), Codicon.history, '', () => {
			void this.revertDraft();
		}, !this.dirty);
		addToolbarBtn(localize('adeRoleStudioReset', "Reset Default"), Codicon.discard, '', () => {
			this.draft = cloneToDraft(DEFAULT_ADE_ORGANIZATION_CONFIG);
			this.prePureSnapshots.clear();
			this.selectedRankId = this.draft.ranks[0]?.id ?? 'governor';
			this.markDirty(false);
			this.render();
		});
		addToolbarBtn(localize('adeRoleStudioCopyJson', "Copy JSON"), Codicon.copy, '', () => {
			const json = JSON.stringify(draftToConfig(this.draft), null, 2);
			void this.clipboardService.writeText(json).then(() => {
				this.notificationService.info(localize('adeRoleStudioCopied', "Copied organization schema JSON to clipboard."));
			});
		});
		const importBtn = addToolbarBtn(localize('adeRoleStudioImportJson', "Import JSON"), Codicon.cloudUpload, '', () => {
			this.importBarVisible = !this.importBarVisible;
			this.render();
		});
		importBtn.setAttribute('aria-expanded', String(this.importBarVisible));
		addToolbarBtn(localize('adeRoleStudioOpenSettingsJson', "settings.json"), Codicon.json, '', () => {
			void this.commandService.executeCommand('workbench.action.openSettingsJson');
		});

		// Presets Strip + View Toggle (Rank Editor | Permission Matrix)
		const controlsBar = append(header, $('.ade-rs-controls-bar'));
		const presetsRow = append(controlsBar, $('.ade-rs-presets-row', {
			role: 'group',
			'aria-label': localize('adeRoleStudioPresetsAria', "Starter Organization Presets"),
		}));
		append(presetsRow, $('span.ade-rs-presets-label', {}, localize('adeRoleStudioPresetsLabel', "Starter Presets:")));
		for (const preset of ADE_ORGANIZATION_PRESETS) {
			const isActive = this.draft.presetId === preset.id;
			const chip = append(presetsRow, $('button.ade-rs-preset-chip', {
				type: 'button',
				title: preset.description,
				'aria-pressed': String(isActive),
			}, preset.name));
			chip.classList.toggle('active', isActive);
			this.renderDisposables.add(addDisposableListener(chip, EventType.CLICK, () => {
				this.draft = cloneToDraft(preset.config);
				this.prePureSnapshots.clear();
				this.selectedRankId = this.draft.ranks[0]?.id ?? '';
				this.markDirty(false);
				this.render();
			}));
		}

		const viewToggle = append(controlsBar, $('.ade-rs-view-toggle', {
			role: 'tablist',
			'aria-label': localize('adeRoleStudioViewModeAria', "Role Studio View"),
		}));
		const addViewTab = (mode: 'editor' | 'matrix', label: string, icon: ThemeIcon) => {
			const active = this.viewMode === mode;
			const tab = append(viewToggle, $(`button.ade-rs-view-tab${active ? '.active' : ''}`, {
				type: 'button',
				role: 'tab',
				'data-view-mode': mode,
				'aria-selected': String(active),
			}));
			const ico = append(tab, $('span', { 'aria-hidden': 'true' }));
			ico.classList.add(...ThemeIcon.asClassNameArray(icon));
			append(tab, $('span', {}, label));
			this.renderDisposables.add(addDisposableListener(tab, EventType.CLICK, () => {
				if (this.viewMode !== mode) {
					this.viewMode = mode;
					this.render();
				}
			}));
		};
		addViewTab('editor', localize('adeRoleStudioViewEditor', "Rank Editor"), Codicon.edit);
		addViewTab('matrix', localize('adeRoleStudioViewMatrix', "Permission Matrix"), Codicon.table);

		// Work-Tree DAG 4-Slot Mapping Bar (P1-02)
		const normalizedForSlots = draftToConfig(this.draft);
		const sortedSlotRanks = [...this.draft.ranks].sort((a, b) => a.tier - b.tier);
		const slotsBar = append(header, $('.ade-rs-slots-bar', {
			role: 'group',
			'aria-label': localize('adeRoleStudioSlotsAria', "Work-Tree DAG Slot Mapping"),
		}));
		const slotsHead = append(slotsBar, $('.ade-rs-slots-head'));
		append(slotsHead, $('span.ade-rs-presets-label', {}, localize('adeRoleStudioSlotsLabel', "Work-Tree DAG Slots:")));
		const slotsGrid = append(slotsBar, $('.ade-rs-slots-grid'));
		const slotDefs: readonly { readonly slot: AdeWorkTreeSlot; readonly label: string; readonly hint: string }[] = [
			{ slot: 'orchestrator', label: localize('adeRoleSlotOrchestrator', "Orchestrator"), hint: localize('adeRoleSlotOrchestratorHint', "Owns the DAG tree & blueprint") },
			{ slot: 'segment_owner', label: localize('adeRoleSlotSegmentOwner', "Segment Owner"), hint: localize('adeRoleSlotSegmentOwnerHint', "Secondary review, merge & escalation") },
			{ slot: 'reviewer', label: localize('adeRoleSlotReviewer', "Adversarial Reviewer"), hint: localize('adeRoleSlotReviewerHint', "Single-node diff & QA verification") },
			{ slot: 'executor', label: localize('adeRoleSlotExecutor', "Pure Executor"), hint: localize('adeRoleSlotExecutorHint', "Clean coding leaf worker") },
		];
		const resolvedSlotRanks: Record<AdeWorkTreeSlot, IAdeRankDefinition> = {
			orchestrator: resolveWorkTreeSlotRank(normalizedForSlots, 'orchestrator'),
			segment_owner: resolveWorkTreeSlotRank(normalizedForSlots, 'segment_owner'),
			reviewer: resolveWorkTreeSlotRank(normalizedForSlots, 'reviewer'),
			executor: resolveWorkTreeSlotRank(normalizedForSlots, 'executor'),
		};
		for (const def of slotDefs) {
			const slotItem = append(slotsGrid, $('.ade-rs-slot-item', { 'data-slot': def.slot, title: def.hint }));
			const selectId = `ade-rs-slot-${def.slot}`;
			append(slotItem, $('label.ade-rs-slot-label', { for: selectId }, def.label));
			const selectEl = append(slotItem, $('select.ade-rs-select.ade-rs-slot-select', {
				id: selectId,
				'data-slot': def.slot,
				'aria-label': localize('adeRoleSlotSelectAria', "DAG slot {0}", def.label),
			})) as HTMLSelectElement;
			const currentId = this.draft.slots?.[def.slot] ?? resolvedSlotRanks[def.slot].id;
			for (const r of sortedSlotRanks) {
				const opt = append(selectEl, $('option', { value: r.id }, `L${r.tier} · ${r.name}`)) as HTMLOptionElement;
				opt.selected = r.id === currentId;
			}
			this.renderDisposables.add(addDisposableListener(selectEl, EventType.CHANGE, () => {
				if (!this.draft.slots) {
					this.draft.slots = {
						orchestrator: resolvedSlotRanks.orchestrator.id,
						segment_owner: resolvedSlotRanks.segment_owner.id,
						reviewer: resolvedSlotRanks.reviewer.id,
						executor: resolvedSlotRanks.executor.id,
					};
				}
				this.draft.slots[def.slot] = selectEl.value;
				this.markDirty();
				this.render();
			}));
		}
		const slotWarnings: Array<{ readonly code: string; readonly text: string }> = [];
		if (resolvedSlotRanks.reviewer.id === resolvedSlotRanks.executor.id) {
			slotWarnings.push({
				code: 'reviewer-equals-executor',
				text: localize(
					'adeRoleSlotWarnSameReviewerExecutor',
					"Adversarial Reviewer and Pure Executor share rank '{0}' — self-review disables independent adversarial QA.",
					resolvedSlotRanks.reviewer.name,
				),
			});
		}
		if (!resolvedSlotRanks.executor.pureExecution) {
			slotWarnings.push({
				code: 'executor-not-pure',
				text: localize(
					'adeRoleSlotWarnExecutorNotPure',
					"Pure Executor slot '{0}' does not have Pure Execution Leaf enabled — DAG workers will receive ADE control prompts/APIs.",
					resolvedSlotRanks.executor.name,
				),
			});
		}
		if (slotWarnings.length > 0) {
			const warnWrap = append(slotsBar, $('.ade-rs-slot-warnings', { role: 'alert' }));
			for (const w of slotWarnings) {
				const warnEl = append(warnWrap, $('.ade-rs-slot-warning', { 'data-slot-warning': w.code }));
				const ico = append(warnEl, $('span.ade-rs-slot-warning-icon', { 'aria-hidden': 'true' }));
				ico.classList.add(...ThemeIcon.asClassNameArray(Codicon.warning));
				append(warnEl, $('span', {}, w.text));
			}
		}

		// Optional Import JSON Drawer
		if (this.importBarVisible) {
			const importBar = append(this.rootEl, $('.ade-rs-import-bar'));
			append(importBar, $('label.ade-rs-label', { for: 'ade-rs-import-ta' }, localize('adeRoleStudioImportLabel', "Paste an ADE organization schema JSON below and click Apply:")));
			const importTa = append(importBar, $('textarea.ade-rs-import-textarea', {
				id: 'ade-rs-import-ta',
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
					this.prePureSnapshots.clear();
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

		// 2. Main Body (Rank Editor OR Permission Matrix)
		const body = append(this.rootEl, $('.ade-rs-body'));
		if (this.viewMode === 'matrix') {
			this.editorColEl = undefined;
			this.previewPreEl = undefined;
			this.previewTokenPillEl = undefined;
			this.renderPermissionMatrix(body);
			return;
		}

		// 2A. Left Visual Hierarchy Ladder
		const ladderCol = append(body, $('.ade-rs-ladder-col'));
		const ladderHead = append(ladderCol, $('.ade-rs-ladder-head'));
		append(ladderHead, $('span', {}, localize('adeRoleStudioLadderTitle', "Hierarchy Ladder (High → Low)")));
		append(ladderHead, $('span', {}, `${this.draft.ranks.length}`));

		const ladderList = append(ladderCol, $('.ade-rs-ladder-list', {
			role: 'listbox',
			'aria-label': localize('adeRoleStudioLadderAria', "Organizational Ranks"),
		}));
		const sortedRanks = [...this.draft.ranks].sort((a, b) => a.tier - b.tier);
		for (let i = 0; i < sortedRanks.length; i++) {
			const rank = sortedRanks[i];
			const isSelected = rank.id === this.selectedRankId;
			const card = append(ladderList, $(`.ade-rs-rank-card.color-${rank.color}`, {
				'data-rank-id': rank.id,
				role: 'option',
				tabindex: '0',
				'aria-selected': String(isSelected),
			}));
			card.classList.toggle('selected', isSelected);

			const top = append(card, $('.ade-rs-rank-card-top'));
			append(top, $('span.ade-rs-tier-badge', {}, `L${rank.tier}`));
			const iconEl = append(top, $('span.ade-rs-rank-icon', { 'aria-hidden': 'true' }));
			iconEl.classList.add(...ThemeIcon.asClassNameArray(resolveAdeRankCodicon(rank.icon)));
			const nameEl = append(top, $('span.ade-rs-rank-name', {}, rank.name));

			const meta = append(card, $('.ade-rs-rank-meta'));
			const pill = append(meta, $(`span.ade-rs-rank-pill${rank.pureExecution ? '.pure' : ''}`, {}, rank.pureExecution
				? localize('adeRoleStudioPureLeafPill', "Pure Leaf · 0 APIs")
				: localize('adeRoleStudioApiCountPill', "{0} Core APIs", rank.allowedApis.length)));
			pill.title = rank.id;
			this.rankCardRefs.set(rank.id, { card, iconEl, nameEl, pillEl: pill });

			const cardActions = append(meta, $('.ade-rs-rank-card-actions'));
			const addMiniBtn = (icon: ThemeIcon, title: string, disabled: boolean, fn: () => void) => {
				const btn = append(cardActions, $('button.ade-rs-mini-icon-btn', { type: 'button', title, 'aria-label': title })) as HTMLButtonElement;
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
			this.renderDisposables.add(addDisposableListener(card, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.target !== card) {
					return;
				}
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.selectedRankId = rank.id;
					this.render();
				} else if (e.key === 'ArrowDown' && i + 1 < sortedRanks.length) {
					e.preventDefault();
					this.selectedRankId = sortedRanks[i + 1].id;
					this.render();
					this.rankCardRefs.get(this.selectedRankId)?.card.focus();
				} else if (e.key === 'ArrowUp' && i > 0) {
					e.preventDefault();
					this.selectedRankId = sortedRanks[i - 1].id;
					this.render();
					this.rankCardRefs.get(this.selectedRankId)?.card.focus();
				}
			}));
		}

		const ladderFooter = append(ladderCol, $('.ade-rs-ladder-footer'));
		const addRankBtn = append(ladderFooter, $('button.ade-rs-btn.ade-rs-add-btn', { type: 'button' }));
		const addIcon = append(addRankBtn, $('span', { 'aria-hidden': 'true' }));
		addIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		append(addRankBtn, $('span', {}, localize('adeRoleStudioAddCustomRank', "Add Custom Rank")));
		this.renderDisposables.add(addDisposableListener(addRankBtn, EventType.CLICK, () => this.addCustomRank()));

		// 2B. Right Fill-in-the-Blank Form
		const editorCol = this.editorColEl = append(body, $('.ade-rs-editor-col', {
			role: 'tabpanel',
			'aria-label': localize('adeRoleStudioEditorPanelAria', "Selected Rank Editor"),
		}));
		const selected = this.getSelectedRank();
		if (!selected) {
			return;
		}

		// --- Card 1: Rank Identity & Position ---
		const card1 = append(editorCol, $('.ade-rs-card'));
		const c1Head = append(card1, $('.ade-rs-card-head'));
		const c1Title = append(c1Head, $('h3.ade-rs-card-title'));
		append(c1Title, $('span.ade-rs-step-badge', { 'aria-hidden': 'true' }, '1'));
		append(c1Title, $('span', {}, localize('adeRoleStudioStep1', "Rank Identity & Hierarchy Position")));

		const grid = append(card1, $('.ade-rs-grid'));

		const addTextField = (
			fieldId: string,
			label: string,
			value: string,
			placeholder: string,
			onInput: (val: string) => void,
			extraClass = '',
			inputType: 'text' | 'number' = 'text',
		) => {
			const field = append(grid, $(`.ade-rs-field${extraClass ? `.${extraClass}` : ''}`));
			append(field, $('label.ade-rs-label', { for: fieldId }, label));
			const input = append(field, $('input.ade-rs-input', {
				id: fieldId,
				type: inputType,
				value,
				placeholder,
			})) as HTMLInputElement;
			this.renderDisposables.add(addDisposableListener(input, EventType.INPUT, () => {
				onInput(input.value);
			}));
			return input;
		};

		const nameInput = addTextField('ade-rs-field-name', localize('adeRoleFieldName', "Rank Display Name"), selected.name, 'e.g. Governor, Tech Lead, QA Auditor', val => {
			selected.name = val;
			this.markDirty();
			this.updateSelectedCardMetaInPlace(selected);
			this.updateLivePreviewOnly();
		});
		this.renderDisposables.add(addDisposableListener(nameInput, EventType.CHANGE, () => this.render()));
		const idInput = addTextField('ade-rs-field-id', localize('adeRoleFieldId', "Rank Machine ID (slug)"), selected.id, 'e.g. tech-lead', val => {
			const sanitized = sanitizeRankId(val);
			if (sanitized && sanitized !== selected.id && !this.draft.ranks.some(r => r !== selected && r.id === sanitized)) {
				const prevId = selected.id;
				selected.id = sanitized;
				this.selectedRankId = sanitized;
				for (const r of this.draft.ranks) {
					if (r.defaultChildRankId === prevId) {
						r.defaultChildRankId = sanitized;
					}
				}
				if (this.draft.slots) {
					for (const slot of ADE_WORK_TREE_SLOTS) {
						if (this.draft.slots[slot] === prevId) {
							this.draft.slots[slot] = sanitized;
						}
					}
				}
				const prevRef = this.rankCardRefs.get(prevId);
				if (prevRef) {
					prevRef.card.setAttribute('data-rank-id', sanitized);
					this.rankCardRefs.delete(prevId);
					this.rankCardRefs.set(sanitized, prevRef);
				}
				this.markDirty();
				this.updateSelectedCardMetaInPlace(selected);
				this.updateLivePreviewOnly();
			}
		});
		idInput.dataset.field = 'rank-id';
		idInput.title = localize('adeRoleFieldIdHint', "Lowercase alphanumeric slug used in CLI --role and settings.json");
		this.renderDisposables.add(addDisposableListener(idInput, EventType.BLUR, () => {
			if (idInput.value !== selected.id) {
				idInput.value = selected.id;
			}
		}));

		addTextField('ade-rs-field-short', localize('adeRoleFieldShort', "Inbox Short Tag (2–6 chars)"), selected.shortName, 'e.g. Gov, Lead, QA', val => {
			selected.shortName = val.slice(0, 6);
			this.markDirty();
		});
		const tierInput = addTextField('ade-rs-field-tier', localize('adeRoleFieldTier', "Hierarchy Tier (L1 = highest)"), String(selected.tier), '1', val => {
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

		addTextField('ade-rs-field-summary', localize('adeRoleFieldSummary', "One-Line Role Summary"), selected.summary, 'Shown in role pickers and hierarchy headers', val => {
			selected.summary = val;
			this.markDirty();
			this.updateLivePreviewOnly();
		}, 'full');

		// Color & Icon Pickers (incremental DOM updates preserve keyboard focus!)
		const colorField = append(grid, $('.ade-rs-field'));
		append(colorField, $('span.ade-rs-label', { id: 'ade-rs-color-label' }, localize('adeRoleFieldColor', "Badge Accent Color")));
		const colorRow = append(colorField, $('.ade-rs-picker-row', { role: 'group', 'aria-labelledby': 'ade-rs-color-label' }));
		const swatchButtons: Array<{ token: AdeRankColorToken; el: HTMLButtonElement }> = [];
		for (const token of ADE_RANK_COLOR_TOKENS) {
			const isSelectedColor = selected.color === token;
			const sw = append(colorRow, $(`button.ade-rs-swatch.color-${token}`, {
				type: 'button',
				title: token,
				'aria-label': localize('adeRoleColorChoiceAria', "Badge color: {0}", token),
				'aria-pressed': String(isSelectedColor),
			})) as HTMLButtonElement;
			sw.classList.toggle('selected', isSelectedColor);
			swatchButtons.push({ token, el: sw });
			this.renderDisposables.add(addDisposableListener(sw, EventType.CLICK, () => {
				selected.color = token;
				for (const entry of swatchButtons) {
					const active = entry.token === token;
					entry.el.classList.toggle('selected', active);
					entry.el.setAttribute('aria-pressed', String(active));
				}
				this.updateSelectedCardMetaInPlace(selected);
				this.markDirty();
			}));
		}

		const iconField = append(grid, $('.ade-rs-field'));
		append(iconField, $('span.ade-rs-label', { id: 'ade-rs-icon-label' }, localize('adeRoleFieldIcon', "Badge Icon")));
		const iconRow = append(iconField, $('.ade-rs-picker-row', { role: 'group', 'aria-labelledby': 'ade-rs-icon-label' }));
		const iconButtons: Array<{ iconToken: AdeRankIconToken; el: HTMLButtonElement }> = [];
		for (const iconToken of ADE_RANK_ICON_TOKENS) {
			const isSelectedIcon = selected.icon === iconToken;
			const btn = append(iconRow, $('button.ade-rs-icon-choice', {
				type: 'button',
				title: iconToken,
				'aria-label': localize('adeRoleIconChoiceAria', "Badge icon: {0}", iconToken),
				'aria-pressed': String(isSelectedIcon),
			})) as HTMLButtonElement;
			btn.classList.add(...ThemeIcon.asClassNameArray(resolveAdeRankCodicon(iconToken)));
			btn.classList.toggle('selected', isSelectedIcon);
			iconButtons.push({ iconToken, el: btn });
			this.renderDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				selected.icon = iconToken;
				for (const entry of iconButtons) {
					const active = entry.iconToken === iconToken;
					entry.el.classList.toggle('selected', active);
					entry.el.setAttribute('aria-pressed', String(active));
				}
				this.updateSelectedCardMetaInPlace(selected);
				this.markDirty();
			}));
		}

		// Default Child Rank selector
		const lowerCandidates = sortedRanks.filter(r => r.tier > selected.tier);
		const childField = append(grid, $('.ade-rs-field'));
		append(childField, $('label.ade-rs-label', { for: 'ade-rs-field-child' }, localize('adeRoleFieldDefaultChild', "Default Sub-Session Rank")));
		const childSelect = append(childField, $('select.ade-rs-select', { id: 'ade-rs-field-child' })) as HTMLSelectElement;
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
		const pureCb = append(pureLabel, $('input', { type: 'checkbox', 'data-field': 'pure-execution' })) as HTMLInputElement;
		pureCb.checked = selected.pureExecution;
		append(pureLabel, $('span', {}, localize('adeRolePureExecution', "Pure Execution Leaf — 0 ADE role/API prompt injection (100% clean native Coding Agent context)")));
		this.renderDisposables.add(addDisposableListener(pureCb, EventType.CHANGE, () => {
			const snapshotKey = selected.originalId || selected.id;
			selected.pureExecution = pureCb.checked;
			if (selected.pureExecution) {
				if (selected.initPrompt || selected.allowedApis.length > 0 || selected.canHaveSubordinates) {
					this.prePureSnapshots.set(snapshotKey, {
						initPrompt: selected.initPrompt,
						allowedApis: [...selected.allowedApis],
						canHaveSubordinates: selected.canHaveSubordinates,
						defaultChildRankId: selected.defaultChildRankId,
					});
				}
				selected.canHaveSubordinates = false;
				selected.allowedApis = [];
				selected.initPrompt = '';
			} else {
				const restored = this.prePureSnapshots.get(snapshotKey);
				if (restored) {
					selected.initPrompt = restored.initPrompt;
					selected.allowedApis = [...restored.allowedApis];
					selected.canHaveSubordinates = restored.canHaveSubordinates;
					selected.defaultChildRankId = restored.defaultChildRankId;
				}
			}
			this.markDirty();
			this.render();
		}));

		// --- Card 2: Initialization Prompt Template ---
		const card2 = append(editorCol, $('.ade-rs-card'));
		const c2Head = append(card2, $('.ade-rs-card-head'));
		const c2Title = append(c2Head, $('h3.ade-rs-card-title'));
		append(c2Title, $('span.ade-rs-step-badge', { 'aria-hidden': 'true' }, '2'));
		append(c2Title, $('span', {}, localize('adeRoleStudioStep2', "Initialization Prompt Template")));

		if (selected.pureExecution) {
			append(card2, $('.ade-rs-pure-banner', { role: 'status' }, localize(
				'adeRolePurePromptNote',
				"Pure Execution Leaf is enabled for this rank. Sessions with this rank receive ZERO ADE prompt injection and ZERO control APIs so they operate with 100% native Coding Agent focus.",
			)));
		} else {
			append(card2, $('p.ade-rs-card-hint', {}, localize(
				'adeRolePromptHint',
				"Write this rank's mission, review standards, or guardrails below. Click any placeholder chip to insert live session/project metadata (all cache-stable).",
			)));

			const varsStrip = append(card2, $('.ade-rs-vars-strip', {
				role: 'group',
				'aria-label': localize('adeRoleTemplateVarsAria', "Prompt Template Variables"),
			}));
			const promptTa = append(card2, $('textarea.ade-rs-textarea', {
				id: 'ade-rs-field-prompt',
				'aria-label': localize('adeRoleStudioStep2', "Initialization Prompt Template"),
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
		append(c3Title, $('span.ade-rs-step-badge', { 'aria-hidden': 'true' }, '3'));
		append(c3Title, $('span', {}, localize('adeRoleStudioStep3', "Core Aexus-Code Primitive API Permissions")));
		append(c3Head, $('span.ade-rs-kernel-badge', {}, localize('adeRoleStudioKernelLocked', "Fixed Kernel Primitives · Runtime Enforced")));

		append(card3, $('p.ade-rs-card-hint', {}, localize(
			'adeRoleApisHint',
			"Core primitive APIs (messaging, reading context, hierarchy ops, project inspection, Inbox, DAG control) are fixed by Aexus-Code. Toggling an API both grants/revokes runtime kernel authorization AND auto-updates the CLI instructions injected into this rank's prompt.",
		)));

		if (!selected.pureExecution) {
			const quickBar = append(card3, $('.ade-rs-api-actions-bar', {
				role: 'group',
				'aria-label': localize('adeRoleQuickGrantAria', "Quick Permission Presets"),
			}));
			const addQuickBtn = (label: string, apis: readonly AdePrimitiveApiId[], requireConfirm = false) => {
				const b = append(quickBar, $(`button.ade-rs-btn${requireConfirm ? '.danger' : ''}`, {
					type: 'button',
					...(requireConfirm ? { 'data-action': 'grant-all' } : {}),
				}, label));
				this.renderDisposables.add(addDisposableListener(b, EventType.CLICK, () => {
					if (requireConfirm) {
						void (async () => {
							if (this.dialogService) {
								const dangerousList = ADE_PRIMITIVE_APIS.filter(a => a.dangerous).map(a => `${a.label} (${a.id})`).join('\n• ');
								const res = await this.dialogService.confirm({
									type: 'warning',
									message: localize('adeRoleConfirmGrantAllTitle', "Grant ALL kernel APIs to '{0}'?", selected.name),
									detail: localize(
										'adeRoleConfirmGrantAllDetail',
										"This includes High Privilege APIs that can delete projects, merge Git worktrees, start/stop DAG runs, and remove Engineering trees:\n• {0}",
										dangerousList,
									),
									primaryButton: localize('adeRoleConfirmGrantAllBtn', "&&Grant All"),
								});
								if (!res.confirmed) {
									return;
								}
							}
							selected.allowedApis = [...apis];
							this.markDirty();
							this.render();
						})();
						return;
					}
					selected.allowedApis = [...apis];
					this.markDirty();
					this.render();
				}));
			};
			addQuickBtn(localize('adeRoleApisRecommended', "Recommended Orchestrator"), ['session.read_context', 'session.message', 'session.manage', 'project.read', 'inbox.post']);
			addQuickBtn(localize('adeRoleApisReadOnly', "Read-Only Reviewer"), ['session.read_context', 'project.read', 'engineering.read', 'engineering.review']);
			addQuickBtn(localize('adeRoleApisSelectAll', "Grant All"), ALL_ADE_PRIMITIVE_API_IDS, true);
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
					this.updateSelectedCardMetaInPlace(selected);
					this.markDirty();
					this.updateLivePreviewOnly();
				}));
			}
		}

		// --- Card 4: Live Compiled Prompt Preview ---
		const card4 = append(editorCol, $('.ade-rs-card'));
		const c4Head = append(card4, $('.ade-rs-card-head'));
		const c4Title = append(c4Head, $('h3.ade-rs-card-title'));
		append(c4Title, $('span.ade-rs-step-badge', { 'aria-hidden': 'true' }, '4'));
		append(c4Title, $('span', {}, localize('adeRoleStudioStep4', "Live Compiled Prompt Preview")));
		this.previewTokenPillEl = append(c4Head, $('span.ade-rs-token-pill', { 'aria-live': 'polite' }));
		this.previewPreEl = append(card4, $('pre.ade-rs-preview-pre'));
		this.updateLivePreviewOnly();
		if (prevEditorScrollTop > 0) {
			editorCol.scrollTop = prevEditorScrollTop;
		}
	}
}
