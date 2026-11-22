/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IMissionDagNode, parseMissionMermaidDag } from '../../../../platform/ade/common/adeMissionDag.js';
import { formatCompactTokenCount, IMissionFinOpsSummary, IMissionRuntimeState } from '../../../../platform/ade/common/adeMissionEngine.js';

const MERMAID_PLACEHOLDER = [
	'flowchart LR',
	'  N1["@Backend: API Schema"] --> N2["@Frontend: UI Canvas"]',
	'  N1 --> N3["@Backend: Core Engine"]',
	'  N2 --> N4["@Backend: Integration"]',
	'  N3 --> N4',
].join('\n');

export interface IMissionFileDrawerDelegate {
	getActiveMissionId(): string | undefined;
	getMermaidText(): string;
	isLiveRun(): boolean;
	getNodes(): readonly IMissionDagNode[];
	getNodePrompts(): Readonly<Record<string, string>>;
	onMermaidDraftChange(nextText: string): void;
	onCommitLiveMermaidPatch(nextText: string): Promise<{ readonly ok: boolean; readonly error?: string }>;
	onNodePromptEdit(nodeId: string, nextVal: string): void;
	onPrimaryRunClick(timeoutMinutes: number): Promise<void>;
	onStopClick(): void;
	onTimeoutChange(minutes: number): Promise<void>;
	onCutoffChange(offGraphMaxTier: number): Promise<void>;
	onAutoLayoutClick(): void;
	onRemoveMissionClick(): void;
	onOpenGovernancePopover?(anchorEl: HTMLElement): void;
	onOpenTriggersPopover?(anchorEl: HTMLElement): void;
	onOpenTemplatesPopover?(anchorEl: HTMLElement): void;
	onQuickAddNodeClick?(anchorEl: HTMLElement): void;
	onOpenFinOpsLedger?(): void;
}

/**
 * Owns the top-left File toggle button, diff-checked Run-control pill,
 * and Split Drawer (Left: Mermaid DAG editor + runtime config; Right: Per-Node Pre-Prompts).
 */
export class AdeMissionFileDrawer extends Disposable {
	private readonly topBarEl: HTMLElement;
	private readonly fileBtnEl: HTMLButtonElement;
	private readonly fileDotEl: HTMLElement;
	private readonly runBarEl: HTMLElement;
	private readonly runStatusLabelEl: HTMLElement;
	private readonly runPrimaryBtnEl: HTMLButtonElement;
	private readonly runStopBtnEl: HTMLButtonElement;
	private readonly governanceBtnEl: HTMLButtonElement;
	private readonly governanceLabelEl: HTMLElement;
	private readonly governanceSupCountEl: HTMLElement;
	private readonly triggersBtnEl: HTMLButtonElement;
	private readonly triggersDotEl: HTMLElement;
	private readonly triggersCountEl: HTMLElement;
	private readonly addNodeBtnEl: HTMLButtonElement;
	private readonly templatesBtnEl: HTMLButtonElement;
	private readonly finOpsBtnEl: HTMLButtonElement;
	private readonly finOpsTokensEl: HTMLElement;
	private readonly finOpsSpendEl: HTMLElement;
	private readonly finOpsBarFillEl: HTMLElement;
	private readonly finOpsCacheEl: HTMLElement;
	private readonly finOpsBreakerTagEl: HTMLElement;
	private readonly fileDrawerEl: HTMLElement;
	private readonly drawerMetaEl: HTMLElement;
	private readonly drawerPromptCountEl: HTMLElement;
	private readonly mermaidTextareaEl: HTMLTextAreaElement;
	private readonly promptNodeListEl: HTMLElement;
	private readonly promptEditorHeaderEl: HTMLElement;
	private readonly nodePromptTextareaEl: HTMLTextAreaElement;
	private readonly promptFooterHintEl: HTMLElement;
	private readonly timeoutInputEl: HTMLInputElement;
	private readonly cutoffSelectEl: HTMLSelectElement;
	private readonly drawerStatusEl: HTMLElement;
	private readonly livePatchActionsEl: HTMLElement;
	private readonly applyPatchBtnEl: HTMLButtonElement;
	private readonly revertPatchBtnEl: HTMLButtonElement;

	private readonly promptListDisposables = this._register(new DisposableStore());
	private readonly promptHeaderDisposables = this._register(new DisposableStore());
	private readonly promptNodeButtons = new Map<string, { readonly btn: HTMLButtonElement; readonly labelEl: HTMLElement }>();

	private drawerOpen = false;
	private selectedPromptNodeId: string | undefined;
	private parseTimer: ReturnType<typeof setTimeout> | undefined;
	private livePatchInFlight = false;
	private lastRenderedMissionId: string | undefined;

	// Diff keys to avoid rebuilding unchanged Run-bar / Cutoff DOM on every runtime tick
	private lastRunBarPrimaryKey = '';
	private lastCutoffSignature = '';

	constructor(
		bodyEl: HTMLElement,
		private readonly delegate: IMissionFileDrawerDelegate,
	) {
		super();

		this.topBarEl = append(bodyEl, $('.ade-mission-top-bar', {
			'data-ade-mission-top-bar': 'true',
		}));

		this.fileBtnEl = append(this.topBarEl, $('button.ade-mission-file-btn', {
			type: 'button',
			title: localize('adeMissionFileBtnTooltip', "Mission Mermaid DAG File"),
			'aria-label': localize('adeMissionFileBtnAria', "Open Mission Mermaid DAG File"),
			'aria-expanded': 'false',
			'data-ade-mission-file-btn': 'true',
		})) as HTMLButtonElement;
		const iconEl = append(this.fileBtnEl, $('span', { 'aria-hidden': 'true' }));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.fileCode));
		this.fileDotEl = append(this.fileBtnEl, $('span.ade-mission-file-dot', { 'aria-hidden': 'true' }));
		this.fileDotEl.hidden = true;

		this._register(addDisposableListener(this.fileBtnEl, EventType.CLICK, () => {
			this.toggle();
		}));

		// Minimal corner run-control pill next to the top-left file icon
		this.runBarEl = append(this.topBarEl, $('.ade-mission-run-bar', {
			'data-ade-mission-run-bar': 'true',
		}));
		append(this.runBarEl, $('span.ade-mission-run-dot', { 'aria-hidden': 'true' }));
		this.runStatusLabelEl = append(this.runBarEl, $('span.ade-mission-run-status', {}, localize('adeMissionRunIdle', "Idle")));
		this.runPrimaryBtnEl = append(this.runBarEl, $('button.ade-mission-run-btn', {
			type: 'button',
			'data-ade-mission-run-primary': 'true',
		})) as HTMLButtonElement;
		this.runStopBtnEl = append(this.runBarEl, $('button.ade-mission-run-stop-btn', {
			type: 'button',
			title: localize('adeMissionStopTooltip', "Stop Mission"),
			'aria-label': localize('adeMissionStopTooltip', "Stop Mission"),
			'data-ade-mission-run-stop': 'true',
		})) as HTMLButtonElement;
		this.runStopBtnEl.appendChild($('span.codicon.codicon-debug-stop'));
		this.runStopBtnEl.hidden = true;

		this._register(addDisposableListener(this.runPrimaryBtnEl, EventType.CLICK, () => {
			const mins = Number.parseInt(this.timeoutInputEl.value || '5', 10);
			void this.delegate.onPrimaryRunClick(Number.isFinite(mins) && mins >= 1 ? mins : 5);
		}));
		this._register(addDisposableListener(this.runStopBtnEl, EventType.CLICK, () => {
			this.delegate.onStopClick();
		}));

		// First-class Supervisor & Runtime Rules pill right on the canvas bar
		this.governanceBtnEl = append(this.topBarEl, $('button.ade-mission-toolbar-pill', {
			type: 'button',
			title: localize('adeMissionGovernanceBtnTip', "配置谁在流程图外担任监工、任务卡顿多久自动催办，以及查看各监工管辖的节点与汇报链"),
			'data-ade-mission-governance-btn': 'true',
		})) as HTMLButtonElement;
		append(this.governanceBtnEl, $('span.codicon.codicon-shield', { 'aria-hidden': 'true' }));
		this.governanceLabelEl = append(this.governanceBtnEl, $('span.ade-mission-toolbar-pill-label', {
			'data-ade-mission-governance-label': 'true',
		}, localize('adeMissionWallLabelL0', "监工规则 · L0")));
		this.governanceSupCountEl = append(this.governanceBtnEl, $('span.ade-mission-toolbar-pill-badge', {
			'data-ade-mission-governance-sup-count': 'true',
		}));
		this.governanceSupCountEl.hidden = true;
		this.governanceBtnEl.hidden = true;
		this._register(addDisposableListener(this.governanceBtnEl, EventType.CLICK, e => {
			e.stopPropagation();
			this.delegate.onOpenGovernancePopover?.(this.governanceBtnEl);
		}));

		// First-class Source Triggers pill right on the canvas bar (shows live armed/standby dot)
		this.triggersBtnEl = append(this.topBarEl, $('button.ade-mission-toolbar-pill', {
			type: 'button',
			title: localize('adeMissionTriggersBtnTip', "Manage Zero-Token Source Triggers (Interval / Cron / Once / File / Git / GPU Idle)"),
			'data-ade-mission-triggers-btn': 'true',
		})) as HTMLButtonElement;
		this.triggersDotEl = append(this.triggersBtnEl, $('span.ade-mission-triggers-status-dot', { 'aria-hidden': 'true' }));
		this.triggersDotEl.hidden = true;
		append(this.triggersBtnEl, $('span.codicon.codicon-zap', { 'aria-hidden': 'true' }));
		append(this.triggersBtnEl, $('span.ade-mission-toolbar-pill-label', {}, localize('adeMissionTriggersBtnLabel', "Triggers")));
		this.triggersCountEl = append(this.triggersBtnEl, $('span.ade-mission-toolbar-pill-badge', {
			'data-ade-mission-triggers-count': 'true',
		}));
		this.triggersCountEl.hidden = true;
		this.triggersBtnEl.hidden = true;
		this._register(addDisposableListener(this.triggersBtnEl, EventType.CLICK, e => {
			e.stopPropagation();
			this.delegate.onOpenTriggersPopover?.(this.triggersBtnEl);
		}));

		// Visual Graph Authoring quick buttons: + Node & Classic DAG Templates
		this.addNodeBtnEl = append(this.topBarEl, $('button.ade-mission-toolbar-pill', {
			type: 'button',
			title: localize('adeMissionAddNodeBtnTip', "Add a Task, Reviewer, or Human Gate node visually (or right-click anywhere on the canvas)"),
			'data-ade-mission-add-node-btn': 'true',
		})) as HTMLButtonElement;
		append(this.addNodeBtnEl, $('span.codicon.codicon-add', { 'aria-hidden': 'true' }));
		append(this.addNodeBtnEl, $('span.ade-mission-toolbar-pill-label', {}, localize('adeMissionAddNodeBtnLabel', "节点")));
		this._register(addDisposableListener(this.addNodeBtnEl, EventType.CLICK, e => {
			e.stopPropagation();
			this.delegate.onQuickAddNodeClick?.(this.addNodeBtnEl);
		}));

		this.templatesBtnEl = append(this.topBarEl, $('button.ade-mission-toolbar-pill', {
			type: 'button',
			title: localize('adeMissionTemplatesBtnTip', "Apply a 1-click multi-machine Engineering or Research DAG template"),
			'data-ade-mission-templates-btn': 'true',
		})) as HTMLButtonElement;
		append(this.templatesBtnEl, $('span.codicon.codicon-sparkle', { 'aria-hidden': 'true' }));
		append(this.templatesBtnEl, $('span.ade-mission-toolbar-pill-label', {}, localize('adeMissionTemplatesBtnLabel', "模板")));
		this._register(addDisposableListener(this.templatesBtnEl, EventType.CLICK, e => {
			e.stopPropagation();
			this.delegate.onOpenTemplatesPopover?.(this.templatesBtnEl);
		}));

		// First-class FinOps Guardrail Pill right on the top bar (live tokens · $USD / budget · mini bar · cache savings)
		this.finOpsBtnEl = append(this.topBarEl, $('button.ade-mission-finops-pill', {
			type: 'button',
			title: localize('adeMissionFinOpsBtnTip', "Open FinOps Budget Guardrail & Spend Ledger (per-rank & per-host breakdown)"),
			'data-ade-mission-finops-btn': 'true',
		})) as HTMLButtonElement;
		append(this.finOpsBtnEl, $('span.codicon.codicon-credit-card.ade-mission-finops-ico', { 'aria-hidden': 'true' }));
		this.finOpsTokensEl = append(this.finOpsBtnEl, $('span.ade-mission-finops-tokens', {
			'data-ade-finops-tokens': 'true',
		}, '0'));
		append(this.finOpsBtnEl, $('span.ade-mission-finops-sep', { 'aria-hidden': 'true' }, '·'));
		this.finOpsSpendEl = append(this.finOpsBtnEl, $('span.ade-mission-finops-spend', {
			'data-ade-finops-spend': 'true',
		}, '$0.00'));
		const finOpsTrack = append(this.finOpsBtnEl, $('.ade-mission-finops-track', { 'aria-hidden': 'true' }));
		this.finOpsBarFillEl = append(finOpsTrack, $('.ade-mission-finops-bar-fill'));
		this.finOpsCacheEl = append(this.finOpsBtnEl, $('span.ade-mission-finops-cache', {
			'data-ade-finops-cache': 'true',
		}));
		this.finOpsCacheEl.hidden = true;
		this.finOpsBreakerTagEl = append(this.finOpsBtnEl, $('span.ade-mission-finops-breaker-tag', {
			'data-ade-finops-breaker': 'true',
		}, localize('adeMissionFinOpsBreakerTag', "BREAKER")));
		this.finOpsBreakerTagEl.hidden = true;
		this.finOpsBtnEl.hidden = true;
		this._register(addDisposableListener(this.finOpsBtnEl, EventType.CLICK, e => {
			e.stopPropagation();
			this.delegate.onOpenFinOpsLedger?.();
		}));

		this.fileDrawerEl = append(bodyEl, $('.ade-mission-file-drawer', {
			role: 'dialog',
			'aria-label': localize('adeMissionDrawerAria', "Mission Mermaid File"),
			'data-ade-mission-drawer': 'true',
		}));
		this.fileDrawerEl.hidden = true;

		const header = append(this.fileDrawerEl, $('.ade-mission-drawer-header'));
		const titleWrap = append(header, $('.ade-mission-drawer-title'));
		const titleIcon = append(titleWrap, $('span', { 'aria-hidden': 'true' }));
		titleIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.fileCode));
		append(titleWrap, $('span', {}, 'mission.mmd'));
		this.drawerMetaEl = append(titleWrap, $('span.ade-mission-drawer-meta', {}, 'Empty'));
		this.drawerPromptCountEl = append(titleWrap, $('span.ade-mission-drawer-prompt-pill', {
			'data-ade-mission-prompt-count': 'true',
		}, '0/0 Prompts'));

		const actions = append(header, $('.ade-mission-drawer-actions'));
		const layoutBtn = append(actions, $('button.ade-mission-icon-btn', {
			type: 'button',
			title: localize('adeMissionAutoLayoutBtn', "Auto Layout"),
			'aria-label': localize('adeMissionAutoLayoutBtn', "Auto Layout"),
			'data-ade-mission-autolayout': 'true',
		})) as HTMLButtonElement;
		layoutBtn.appendChild($('span.codicon.codicon-layout'));
		this._register(addDisposableListener(layoutBtn, EventType.CLICK, () => {
			this.delegate.onAutoLayoutClick();
		}));

		const removeBtn = append(actions, $('button.ade-mission-icon-btn.danger', {
			type: 'button',
			title: localize('adeMissionRemoveAllBtn', "Remove Mission & All Employees"),
			'aria-label': localize('adeMissionRemoveAllBtn', "Remove Mission & All Employees"),
			'data-ade-mission-remove': 'true',
		})) as HTMLButtonElement;
		removeBtn.appendChild($('span.codicon.codicon-trash'));
		this._register(addDisposableListener(removeBtn, EventType.CLICK, () => {
			this.delegate.onRemoveMissionClick();
		}));

		const closeBtn = append(actions, $('button.ade-mission-icon-btn', {
			type: 'button',
			title: localize('adeMissionCloseDrawer', "Close"),
			'aria-label': localize('adeMissionCloseDrawer', "Close"),
		})) as HTMLButtonElement;
		closeBtn.appendChild($('span.codicon.codicon-close'));
		this._register(addDisposableListener(closeBtn, EventType.CLICK, () => {
			this.toggle(false);
		}));

		const splitBody = append(this.fileDrawerEl, $('.ade-mission-drawer-split', {
			'data-ade-mission-drawer-split': 'true',
		}));

		// Left Pane: Mermaid DAG Orchestration
		const leftPane = append(splitBody, $('.ade-mission-drawer-left', {
			'data-ade-mission-mermaid-pane': 'true',
		}));
		const leftHead = append(leftPane, $('.ade-mission-drawer-pane-head'));
		append(leftHead, $('span.codicon.codicon-type-hierarchy', { 'aria-hidden': 'true' }));
		append(leftHead, $('span', {}, localize('adeMissionLeftPaneTitle', "统筹编排 · Mermaid DAG")));

		this.mermaidTextareaEl = append(leftPane, $('textarea.ade-mission-mermaid-input', {
			spellcheck: 'false',
			placeholder: MERMAID_PLACEHOLDER,
			'aria-label': localize('adeMissionMermaidInputAria', "Mermaid DAG Definition"),
			'data-ade-mission-mermaid-input': 'true',
		})) as HTMLTextAreaElement;

		const commitLiveMermaidPatch = (): void => {
			if (!this.delegate.isLiveRun() || this.livePatchInFlight) {
				return;
			}
			const nextText = this.mermaidTextareaEl.value;
			const previousValid = this.delegate.getMermaidText();
			if (nextText === previousValid) {
				this.syncLivePatchButtons();
				return;
			}
			const missionId = this.delegate.getActiveMissionId();
			this.livePatchInFlight = true;
			this.syncLivePatchButtons();
			this.setStatus(localize('adeMissionLivePatchValidating', "Applying atomic live patch..."));
			void this.delegate.onCommitLiveMermaidPatch(nextText).then(res => {
				this.livePatchInFlight = false;
				if (this.delegate.getActiveMissionId() !== missionId) {
					this.syncLivePatchButtons();
					return;
				}
				if (res.ok) {
					this.setStatus(localize('adeMissionLivePatchApplied', "Atomic live DAG patch applied"), 'ok');
				} else {
					// Keep the user's draft intact in the textarea so they can fix the validation error or explicitly Revert.
					this.setStatus(res.error ?? localize('adeMissionLivePatchRejected', "Live DAG patch rejected."), 'error');
				}
				this.syncLivePatchButtons();
			}, err => {
				this.livePatchInFlight = false;
				if (this.delegate.getActiveMissionId() !== missionId) {
					this.syncLivePatchButtons();
					return;
				}
				const msg = err instanceof Error ? err.message : String(err);
				this.setStatus(msg || localize('adeMissionLivePatchRejected', "Live DAG patch rejected."), 'error');
				this.syncLivePatchButtons();
			});
		};

		this._register(addDisposableListener(this.mermaidTextareaEl, EventType.INPUT, () => {
			const nextText = this.mermaidTextareaEl.value;
			this.clearParseTimer();
			if (this.delegate.isLiveRun()) {
				// Validate syntax locally during live runs; commit atomic patch ONLY via Apply Patch or Cmd/Ctrl+Enter.
				this.syncLivePatchButtons();
				const preview = parseMissionMermaidDag(nextText);
				if (preview.error) {
					this.setStatus(preview.error, 'error');
				} else if (nextText !== this.delegate.getMermaidText()) {
					this.setStatus(localize('adeMissionLivePatchPendingCommit', "Draft live edit valid — click Apply Patch or press Cmd/Ctrl+Enter"));
				} else {
					this.setStatus(localize('adeMissionLivePatchSynced', "Synced with live Mission DAG"));
				}
				return;
			}
			this.syncLivePatchButtons();
			this.parseTimer = setTimeout(() => {
				this.parseTimer = undefined;
				if (this.delegate.isLiveRun()) {
					return;
				}
				this.delegate.onMermaidDraftChange(nextText);
			}, 90);
		}));

		this._register(addDisposableListener(this.mermaidTextareaEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && this.delegate.isLiveRun()) {
				e.preventDefault();
				commitLiveMermaidPatch();
			}
		}));

		const configStrip = append(leftPane, $('.ade-mission-drawer-config', {
			'data-ade-mission-drawer-config': 'true',
		}));
		const timeoutField = append(configStrip, $('label.ade-mission-config-field'));
		append(timeoutField, $('span.ade-mission-config-label', {}, localize('adeMissionTimeoutLabel', "催办超时 (分)")));
		this.timeoutInputEl = append(timeoutField, $('input.ade-mission-config-input', {
			type: 'number',
			min: '1',
			max: '240',
			value: '5',
			'data-ade-mission-timeout-input': 'true',
		})) as HTMLInputElement;
		this._register(addDisposableListener(this.timeoutInputEl, EventType.CHANGE, () => {
			const mins = Number.parseInt(this.timeoutInputEl.value, 10);
			if (Number.isFinite(mins) && mins >= 1) {
				void this.delegate.onTimeoutChange(mins);
			}
		}));

		const cutoffField = append(configStrip, $('label.ade-mission-config-field'));
		append(cutoffField, $('span.ade-mission-config-label', {}, localize('adeMissionCutoffLabel', "图外监工")));
		this.cutoffSelectEl = append(cutoffField, $('select.ade-mission-config-select', {
			'data-ade-mission-cutoff-select': 'true',
		})) as HTMLSelectElement;
		this._register(addDisposableListener(this.cutoffSelectEl, EventType.CHANGE, () => {
			const cutoff = Number.parseInt(this.cutoffSelectEl.value, 10);
			if (Number.isInteger(cutoff) && cutoff >= 0) {
				void this.delegate.onCutoffChange(cutoff);
			}
		}));

		// Right Pane: Per-Node Pre-Prompts Editor
		const rightPane = append(splitBody, $('.ade-mission-drawer-right', {
			'data-ade-mission-prompts-pane': 'true',
		}));
		const rightHead = append(rightPane, $('.ade-mission-drawer-pane-head'));
		append(rightHead, $('span.codicon.codicon-comment-discussion', { 'aria-hidden': 'true' }));
		append(rightHead, $('span', {}, localize('adeMissionRightPaneTitle', "节点前置提示词 · Node Pre-Prompts")));

		const promptsWorkspace = append(rightPane, $('.ade-mission-prompts-workspace'));
		this.promptNodeListEl = append(promptsWorkspace, $('.ade-mission-prompt-node-list', {
			role: 'listbox',
			'aria-label': localize('adeMissionPromptNodesAria', "Mission Nodes"),
			'data-ade-prompt-node-list': 'true',
		}));

		const promptEditorCol = append(promptsWorkspace, $('.ade-mission-prompt-editor-col'));
		this.promptEditorHeaderEl = append(promptEditorCol, $('.ade-mission-prompt-editor-head'));
		this.nodePromptTextareaEl = append(promptEditorCol, $('textarea.ade-mission-node-prompt-input', {
			spellcheck: 'false',
			placeholder: localize(
				'adeMissionNodePromptPlaceholder',
				"编写该节点被唤醒时的前置提示词（任务目标、目录/技术约束、交付物与验收标准…）。\n节点收到令牌被唤醒时，会自动将此前置提示词与令牌信息一起打包发送给 Agent。",
			),
			'aria-label': localize('adeMissionNodePromptAria', "Node Pre-Prompt"),
			'data-ade-node-prompt-input': 'true',
		})) as HTMLTextAreaElement;
		this._register(addDisposableListener(this.nodePromptTextareaEl, EventType.INPUT, () => {
			if (!this.selectedPromptNodeId) {
				return;
			}
			this.delegate.onNodePromptEdit(this.selectedPromptNodeId, this.nodePromptTextareaEl.value);
		}));
		this._register(addDisposableListener(this.nodePromptTextareaEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key !== 'Escape') {
				e.stopPropagation();
			}
		}));
		const promptHintBar = append(promptEditorCol, $('.ade-mission-prompt-hint-bar'));
		append(promptHintBar, $('span.codicon.codicon-sparkle', { 'aria-hidden': 'true' }));
		this.promptFooterHintEl = append(promptHintBar, $('span.ade-mission-prompt-hint-text', {}, localize('adeMissionPromptWakeupHint', "唤醒时自动与令牌信息打包下发")));

		const footer = append(this.fileDrawerEl, $('.ade-mission-drawer-footer'));
		this.drawerStatusEl = append(footer, $('span.ade-mission-drawer-status', {}, localize('adeMissionStatusEmpty', "Write Mermaid DAG syntax to render nodes")));
		this.livePatchActionsEl = append(footer, $('.ade-mission-live-patch-actions', {
			'data-ade-mission-live-patch-actions': 'true',
		}));
		this.revertPatchBtnEl = append(this.livePatchActionsEl, $('button.ade-mission-live-patch-btn.secondary', {
			type: 'button',
			title: localize('adeMissionRevertLivePatchTip', "Discard unsaved live DAG draft and restore current committed graph"),
			'data-ade-mission-revert-patch': 'true',
		}, localize('adeMissionRevertLivePatch', "Revert"))) as HTMLButtonElement;
		this.applyPatchBtnEl = append(this.livePatchActionsEl, $('button.ade-mission-live-patch-btn.primary', {
			type: 'button',
			title: localize('adeMissionApplyLivePatchTip', "Validate and atomically apply live DAG patch (Cmd/Ctrl+Enter)"),
			'data-ade-mission-apply-patch': 'true',
		}, localize('adeMissionApplyLivePatch', "Apply Patch"))) as HTMLButtonElement;
		this.livePatchActionsEl.hidden = true;

		this._register(addDisposableListener(this.applyPatchBtnEl, EventType.CLICK, () => {
			commitLiveMermaidPatch();
		}));
		this._register(addDisposableListener(this.revertPatchBtnEl, EventType.CLICK, () => {
			if (this.livePatchInFlight) {
				return;
			}
			this.mermaidTextareaEl.value = this.delegate.getMermaidText();
			this.setStatus(localize('adeMissionLivePatchReverted', "Draft reverted to live Mission DAG"));
			this.syncLivePatchButtons();
		}));
	}

	override dispose(): void {
		this.clearParseTimer();
		super.dispose();
	}

	clearParseTimer(): void {
		if (this.parseTimer !== undefined) {
			clearTimeout(this.parseTimer);
			this.parseTimer = undefined;
		}
	}

	isOpen(): boolean {
		return this.drawerOpen;
	}

	setSelectedPromptNodeId(nodeId: string | undefined): void {
		this.selectedPromptNodeId = nodeId;
	}

	setMermaidValue(text: string): void {
		this.clearParseTimer();
		const activeId = this.delegate.getActiveMissionId();
		const switchedMission = activeId !== this.lastRenderedMissionId;
		this.lastRenderedMissionId = activeId;
		// Preserve an unsaved live draft while the user is actively editing on the same running Mission.
		if (!switchedMission && this.delegate.isLiveRun() && this.drawerOpen && this.mermaidTextareaEl.value !== text && this.mermaidTextareaEl.value !== '') {
			this.syncLivePatchButtons();
			return;
		}
		if (this.mermaidTextareaEl.value !== text) {
			this.mermaidTextareaEl.value = text;
		}
		this.syncLivePatchButtons();
	}

	private syncLivePatchButtons(): void {
		const isLive = this.delegate.isLiveRun();
		const isDirty = isLive && this.mermaidTextareaEl.value !== this.delegate.getMermaidText();
		this.livePatchActionsEl.hidden = !isDirty && !this.livePatchInFlight;
		this.applyPatchBtnEl.disabled = this.livePatchInFlight || !isDirty;
		this.revertPatchBtnEl.disabled = this.livePatchInFlight || !isDirty;
	}

	setFileDotVisible(visible: boolean): void {
		this.fileDotEl.hidden = !visible;
	}

	setMeta(text: string): void {
		if (this.drawerMetaEl.textContent !== text) {
			this.drawerMetaEl.textContent = text;
		}
	}

	setStatus(text: string, kind?: 'ok' | 'error'): void {
		this.drawerStatusEl.textContent = text;
		this.drawerStatusEl.className = kind ? `ade-mission-drawer-status ${kind}` : 'ade-mission-drawer-status';
	}

	toggle(forceOpen?: boolean, focusNodeId?: string): void {
		this.drawerOpen = forceOpen ?? !this.drawerOpen;
		if (focusNodeId) {
			this.selectedPromptNodeId = focusNodeId;
		}
		this.fileDrawerEl.hidden = !this.drawerOpen;
		this.fileBtnEl.classList.toggle('active', this.drawerOpen);
		this.fileBtnEl.setAttribute('aria-expanded', String(this.drawerOpen));
		if (this.drawerOpen) {
			this.syncPromptsPane(false);
			if (focusNodeId) {
				this.nodePromptTextareaEl.focus();
			} else {
				this.mermaidTextareaEl.focus();
			}
		}
	}

	syncRuntimeControls(state: IMissionRuntimeState | undefined, nodeCount: number, rankCount: number, boundaryValid = true, finOps?: IMissionFinOpsSummary): void {
		const hasRuntime = Boolean(state);
		this.runBarEl.hidden = !hasRuntime;
		this.governanceBtnEl.hidden = !hasRuntime;
		this.triggersBtnEl.hidden = !hasRuntime;
		this.finOpsBtnEl.hidden = !hasRuntime;
		if (!state) {
			return;
		}
		const status = state.status;
		if (this.runBarEl.dataset.status !== status) {
			this.runBarEl.dataset.status = status;
		}
		const statusLabel = status === 'running'
			? localize('adeMissionRunRunning', "Running")
			: status === 'paused'
				? localize('adeMissionRunPaused', "Paused")
				: status === 'completed'
					? localize('adeMissionRunCompleted', "Done")
					: status === 'failed'
						? localize('adeMissionRunFailed', "Failed")
						: status === 'stopped'
							? localize('adeMissionRunStopped', "Stopped")
							: localize('adeMissionRunIdle', "Idle");
		if (this.runStatusLabelEl.textContent !== statusLabel) {
			this.runStatusLabelEl.textContent = statusLabel;
		}

		// Diff-checked primary run button: only rebuild inner icon/label when status bucket changes
		const primaryBucket = status === 'running' ? 'pause' : status === 'paused' ? 'resume' : 'start';
		if (this.lastRunBarPrimaryKey !== primaryBucket) {
			this.lastRunBarPrimaryKey = primaryBucket;
			clearNode(this.runPrimaryBtnEl);
			if (primaryBucket === 'pause') {
				this.runPrimaryBtnEl.appendChild($('span.codicon.codicon-debug-pause'));
				append(this.runPrimaryBtnEl, $('span', {}, localize('adeMissionPauseBtn', "Pause")));
			} else if (primaryBucket === 'resume') {
				this.runPrimaryBtnEl.appendChild($('span.codicon.codicon-debug-continue'));
				append(this.runPrimaryBtnEl, $('span', {}, localize('adeMissionResumeBtn', "Resume")));
			} else {
				this.runPrimaryBtnEl.appendChild($('span.codicon.codicon-play'));
				append(this.runPrimaryBtnEl, $('span', {}, localize('adeMissionStartBtn', "Start")));
			}
		}
		this.runPrimaryBtnEl.disabled = nodeCount === 0 && status !== 'running' && status !== 'paused';
		this.runStopBtnEl.hidden = status !== 'running' && status !== 'paused';

		const timeoutStr = String(state.silenceTimeoutMinutes);
		if (this.timeoutInputEl.value !== timeoutStr) {
			this.timeoutInputEl.value = timeoutStr;
		}
		this.timeoutInputEl.disabled = state.silenceTimeoutLocked;
		this.timeoutInputEl.title = state.silenceTimeoutLocked
			? localize('adeMissionTimeoutLockedTip', "Locked while Mission is running")
			: localize('adeMissionTimeoutEditTip', "Watchdog silence nudge timeout in minutes (locked once started)");

		const maxCutoff = Math.max(0, rankCount - 1);
		const cutoffSig = `${maxCutoff}`;
		if (this.lastCutoffSignature !== cutoffSig) {
			this.lastCutoffSignature = cutoffSig;
			clearNode(this.cutoffSelectEl);
			for (let k = 0; k <= maxCutoff; k++) {
				append(this.cutoffSelectEl, $('option', { value: String(k) },
					k === 0
						? localize('adeMissionCutoffL0', "L0 only")
						: localize('adeMissionCutoffLk', "L0..L{0}", k),
				));
			}
		}
		const targetCutoff = String(state.boundary.offGraphMaxTier);
		if (this.cutoffSelectEl.value !== targetCutoff) {
			this.cutoffSelectEl.value = targetCutoff;
		}
		this.cutoffSelectEl.disabled = status === 'running' || status === 'paused';

		// Update always-visible top-bar Governance pill & Source Triggers pill
		const cutoffTier = state.boundary.offGraphMaxTier;
		const wallLabel = cutoffTier === 0
			? localize('adeMissionWallLabelL0', "监工规则 · L0")
			: localize('adeMissionWallLabelLk', "监工规则 · L0..L{0}", cutoffTier);
		if (this.governanceLabelEl.textContent !== wallLabel) {
			this.governanceLabelEl.textContent = wallLabel;
		}
		this.governanceBtnEl.classList.toggle('has-warning', !boundaryValid);
		this.governanceBtnEl.dataset.offGraphMaxTier = String(cutoffTier);
		const boundSupCount = state.boundary.supervisors.filter(s => s.managedNodeIds.length > 0).length;
		if (boundSupCount > 0) {
			this.governanceSupCountEl.hidden = false;
			const supText = localize('adeMissionGovSupCount', "{0} 位监工", boundSupCount);
			if (this.governanceSupCountEl.textContent !== supText) {
				this.governanceSupCountEl.textContent = supText;
			}
		} else {
			this.governanceSupCountEl.hidden = true;
		}

		const triggerCount = state.triggers.length;
		const enabledTriggers = state.triggers.filter(t => t.enabled).length;
		const triggerState = enabledTriggers === 0
			? (triggerCount > 0 ? 'paused' : 'none')
			: (status === 'running' ? 'armed' : 'standby');
		this.triggersBtnEl.classList.toggle('has-active', enabledTriggers > 0);
		this.triggersBtnEl.classList.toggle('is-armed', triggerState === 'armed');
		this.triggersBtnEl.classList.toggle('is-standby', triggerState === 'standby');
		this.triggersBtnEl.dataset.triggerCount = String(triggerCount);
		this.triggersBtnEl.dataset.triggersState = triggerState;
		this.triggersDotEl.hidden = triggerState === 'none';
		if (triggerCount > 0) {
			this.triggersCountEl.hidden = false;
			const countStr = String(triggerCount);
			if (this.triggersCountEl.textContent !== countStr) {
				this.triggersCountEl.textContent = countStr;
			}
		} else {
			this.triggersCountEl.hidden = true;
		}

		// Update top-bar FinOps Guardrail Pill in place
		if (finOps) {
			const tokStr = formatCompactTokenCount(finOps.totalTokens);
			if (this.finOpsTokensEl.textContent !== tokStr) {
				this.finOpsTokensEl.textContent = tokStr;
			}
			const spendStr = finOps.budgetLimitUsd !== undefined
				? `$${finOps.totalCostUsd.toFixed(2)} / $${finOps.budgetLimitUsd.toFixed(2)}`
				: `$${finOps.totalCostUsd.toFixed(2)}`;
			if (this.finOpsSpendEl.textContent !== spendStr) {
				this.finOpsSpendEl.textContent = spendStr;
			}
			const barPct = finOps.budgetLimitUsd !== undefined
				? Math.min(100, finOps.budgetUsedPct)
				: (finOps.totalCostUsd > 0 ? Math.min(100, Math.round(Math.log10(1 + finOps.totalCostUsd * 10) * 45)) : 0);
			this.finOpsBarFillEl.style.width = `${barPct}%`;
			this.finOpsBtnEl.dataset.severity = finOps.severity;
			this.finOpsBtnEl.classList.toggle('severity-warn', finOps.severity === 'warn');
			this.finOpsBtnEl.classList.toggle('severity-critical', finOps.severity === 'critical');
			this.finOpsBtnEl.classList.toggle('severity-tripped', finOps.severity === 'tripped');
			if (finOps.cacheSavingsPct > 0) {
				this.finOpsCacheEl.hidden = false;
				const cacheStr = localize('adeMissionFinOpsCacheSaved', "省{0}%", finOps.cacheSavingsPct);
				if (this.finOpsCacheEl.textContent !== cacheStr) {
					this.finOpsCacheEl.textContent = cacheStr;
				}
			} else {
				this.finOpsCacheEl.hidden = true;
			}
			this.finOpsBreakerTagEl.hidden = !finOps.budgetCircuitTripped;
		}

		this.syncLivePatchButtons();
	}

	syncPromptsPane(preserveTextarea = false): void {
		const prompts = this.delegate.getNodePrompts();
		const taskNodes = this.delegate.getNodes().filter(n => n.kind !== 'gate');

		const configuredCount = taskNodes.filter(n => Boolean(prompts[n.id]?.trim())).length;
		const countText = localize('adeMissionPromptCountPill', "{0}/{1} Prompts", configuredCount, taskNodes.length);
		if (this.drawerPromptCountEl.textContent !== countText) {
			this.drawerPromptCountEl.textContent = countText;
		}
		this.drawerPromptCountEl.classList.toggle('has-prompts', configuredCount > 0);

		if (taskNodes.length === 0) {
			this.selectedPromptNodeId = undefined;
			this.promptListDisposables.clear();
			this.promptHeaderDisposables.clear();
			this.promptNodeButtons.clear();
			clearNode(this.promptNodeListEl);
			clearNode(this.promptEditorHeaderEl);
			append(this.promptNodeListEl, $('.ade-mission-prompt-empty', {}, localize('adeMissionPromptNoNodes', "暂无任务节点")));
			this.nodePromptTextareaEl.value = '';
			this.nodePromptTextareaEl.disabled = true;
			this.promptFooterHintEl.textContent = localize('adeMissionPromptAddMermaidFirst', "先在左侧编写 Mermaid 节点，即可为每个节点配置前置提示词");
			return;
		}

		if (!this.selectedPromptNodeId || !taskNodes.some(n => n.id === this.selectedPromptNodeId)) {
			this.selectedPromptNodeId = taskNodes[0].id;
		}
		const activeNode = taskNodes.find(n => n.id === this.selectedPromptNodeId) ?? taskNodes[0];

		// Reuse existing node-list buttons in place when IDs match so typing/clicking never resets scrollTop
		const existingKeys = Array.from(this.promptNodeButtons.keys());
		const sameNodeList = existingKeys.length === taskNodes.length
			&& existingKeys.every((id, idx) => id === taskNodes[idx].id);

		if (sameNodeList) {
			for (const node of taskNodes) {
				const entry = this.promptNodeButtons.get(node.id)!;
				const hasPrompt = Boolean(prompts[node.id]?.trim());
				const isSelected = node.id === activeNode.id;
				entry.btn.classList.toggle('active', isSelected);
				entry.btn.classList.toggle('has-prompt', hasPrompt);
				entry.btn.setAttribute('aria-selected', String(isSelected));
				entry.btn.setAttribute('data-has-prompt', String(hasPrompt));
				entry.btn.title = `${node.id} · ${node.label}${node.employeeName ? ` (@${node.employeeName})` : ''}`;
				if (entry.labelEl.textContent !== node.label) {
					entry.labelEl.textContent = node.label;
				}
			}
		} else {
			this.promptListDisposables.clear();
			this.promptNodeButtons.clear();
			clearNode(this.promptNodeListEl);
			for (const node of taskNodes) {
				const hasPrompt = Boolean(prompts[node.id]?.trim());
				const isSelected = node.id === activeNode.id;
				const btn = append(this.promptNodeListEl, $(`button.ade-mission-prompt-node-item${isSelected ? '.active' : ''}${hasPrompt ? '.has-prompt' : ''}`, {
					type: 'button',
					role: 'option',
					'aria-selected': String(isSelected),
					'data-ade-prompt-node-item': node.id,
					'data-has-prompt': String(hasPrompt),
					title: `${node.id} · ${node.label}${node.employeeName ? ` (@${node.employeeName})` : ''}`,
				})) as HTMLButtonElement;
				const topLine = append(btn, $('.ade-mission-prompt-node-top'));
				append(topLine, $('span.ade-mission-prompt-node-id', {}, node.id));
				append(topLine, $('span.ade-mission-prompt-node-dot', { 'aria-hidden': 'true' }));
				const labelEl = append(btn, $('span.ade-mission-prompt-node-label', {}, node.label));
				this.promptNodeButtons.set(node.id, { btn, labelEl });
				this.promptListDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
					this.selectedPromptNodeId = node.id;
					this.syncPromptsPane(false);
					this.nodePromptTextareaEl.focus();
				}));
			}
		}

		this.promptHeaderDisposables.clear();
		clearNode(this.promptEditorHeaderEl);
		const headMeta = append(this.promptEditorHeaderEl, $('.ade-mission-prompt-editor-meta'));
		append(headMeta, $('span.ade-mission-prompt-active-id', {}, activeNode.id));
		append(headMeta, $('span.ade-mission-prompt-active-title', { title: activeNode.label }, activeNode.label));
		if (activeNode.employeeName) {
			append(headMeta, $('span.ade-mission-prompt-active-emp', {}, `@${activeNode.employeeName}`));
		}

		const activePromptText = prompts[activeNode.id] ?? '';
		if (activePromptText.trim()) {
			const clearBtn = append(this.promptEditorHeaderEl, $('button.ade-mission-prompt-clear-btn', {
				type: 'button',
				title: localize('adeMissionClearNodePromptTip', "Clear pre-prompt for {0}", activeNode.id),
				'data-ade-node-prompt-clear': activeNode.id,
			}, localize('adeMissionClearNodePrompt', "Clear"))) as HTMLButtonElement;
			this.promptHeaderDisposables.add(addDisposableListener(clearBtn, EventType.CLICK, () => {
				this.nodePromptTextareaEl.value = '';
				this.delegate.onNodePromptEdit(activeNode.id, '');
			}));
		}

		this.nodePromptTextareaEl.disabled = false;
		this.nodePromptTextareaEl.dataset.activeNodeId = activeNode.id;
		if (!preserveTextarea && this.nodePromptTextareaEl.value !== activePromptText) {
			this.nodePromptTextareaEl.value = activePromptText;
		}
		const charCount = (preserveTextarea ? this.nodePromptTextareaEl.value : activePromptText).trim().length;
		this.promptFooterHintEl.textContent = charCount > 0
			? localize('adeMissionPromptSavedHint', "唤醒 {0} 时自动与令牌信息打包下发 · {1} chars", activeNode.id, charCount)
			: localize('adeMissionPromptWakeupHint', "唤醒时自动与令牌信息打包下发");
	}
}
