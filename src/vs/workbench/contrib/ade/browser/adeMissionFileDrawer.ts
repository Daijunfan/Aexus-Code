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
import { IMissionRuntimeState } from '../../../../platform/ade/common/adeMissionEngine.js';
import { adeBi, onDidChangeAdeLocale } from '../common/adeLocalization.js';

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
	onDrawerOpenChanged?(isOpen: boolean): void;
}

/**
 * Owns the top-left File toggle button, diff-checked Run-control pill,
 * and Split Drawer (Left: Mermaid DAG editor + runtime config; Right: Per-Node Pre-Prompts).
 */
export class AdeMissionFileDrawer extends Disposable {
	private readonly topBarSlotEl: HTMLElement;
	private readonly topBarEl: HTMLElement;
	private readonly fileBtnEl: HTMLButtonElement;
	private readonly fileDotEl: HTMLElement;
	private readonly runBarEl: HTMLElement;
	private readonly runStatusLabelEl: HTMLElement;
	private readonly runPrimaryBtnEl: HTMLButtonElement;
	private readonly runStopBtnEl: HTMLButtonElement;
	private readonly fileDrawerEl: HTMLElement;
	private readonly drawerMetaEl: HTMLElement;
	private readonly drawerPromptCountEl: HTMLElement;
	private readonly layoutBtnEl: HTMLButtonElement;
	private readonly removeBtnEl: HTMLButtonElement;
	private readonly closeBtnEl: HTMLButtonElement;
	private readonly leftPaneTitleEl: HTMLElement;
	private readonly rightPaneTitleEl: HTMLElement;
	private readonly timeoutLabelEl: HTMLElement;
	private readonly cutoffLabelEl: HTMLElement;
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
	private lastRuntimeSyncArgs: readonly [IMissionRuntimeState | undefined, number, number] | undefined;

	constructor(
		bodyEl: HTMLElement,
		private readonly delegate: IMissionFileDrawerDelegate,
	) {
		super();

		this.topBarSlotEl = append(bodyEl, $('.ade-mission-top-bar-slot', {
			'data-ade-mission-top-bar-slot': 'true',
		}));
		this.topBarEl = append(this.topBarSlotEl, $('.ade-mission-top-bar', {
			'data-ade-mission-top-bar': 'true',
		}));

		this.fileBtnEl = append(this.topBarEl, $('button.ade-mission-file-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionFileBtnTooltip', "Mission Mermaid DAG File"), '任务流图源码与提示词抽屉'),
			'aria-label': adeBi(localize('adeMissionFileBtnAria', "Open Mission Mermaid DAG File"), '打开任务流图源码文件'),
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
		this.runStatusLabelEl = append(this.runBarEl, $('span.ade-mission-run-status', {}, adeBi(localize('adeMissionRunIdle', "Idle"), '待命')));
		this.runPrimaryBtnEl = append(this.runBarEl, $('button.ade-mission-run-btn', {
			type: 'button',
			'data-ade-mission-run-primary': 'true',
		})) as HTMLButtonElement;
		this.runStopBtnEl = append(this.runBarEl, $('button.ade-mission-run-stop-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionStopTooltip', "Stop Mission"), '停止任务'),
			'aria-label': adeBi(localize('adeMissionStopTooltip', "Stop Mission"), '停止任务'),
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

		this.fileDrawerEl = append(bodyEl, $('.ade-mission-file-drawer', {
			role: 'dialog',
			'aria-label': adeBi(localize('adeMissionDrawerAria', "Mission Mermaid File"), '任务流图源码与提示词文件'),
			'data-ade-mission-drawer': 'true',
		}));
		this.fileDrawerEl.hidden = true;

		const header = append(this.fileDrawerEl, $('.ade-mission-drawer-header'));
		const titleWrap = append(header, $('.ade-mission-drawer-title'));
		const titleIcon = append(titleWrap, $('span', { 'aria-hidden': 'true' }));
		titleIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.fileCode));
		append(titleWrap, $('span', {}, 'mission.mmd'));
		this.drawerMetaEl = append(titleWrap, $('span.ade-mission-drawer-meta', {}, adeBi(localize('adeMissionDrawerMetaEmpty', "Empty"), '空画布')));
		this.drawerPromptCountEl = append(titleWrap, $('span.ade-mission-drawer-prompt-pill', {
			'data-ade-mission-prompt-count': 'true',
		}, adeBi(localize('adeMissionPromptCountPill', "{0}/{1} Prompts", 0, 0), '{0}/{1} 条提示词', 0, 0)));

		const actions = append(header, $('.ade-mission-drawer-actions'));
		this.layoutBtnEl = append(actions, $('button.ade-mission-icon-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionAutoLayoutBtn', "Auto Layout"), '自动整理布局'),
			'aria-label': adeBi(localize('adeMissionAutoLayoutBtn', "Auto Layout"), '自动整理布局'),
			'data-ade-mission-autolayout': 'true',
		})) as HTMLButtonElement;
		this.layoutBtnEl.appendChild($('span.codicon.codicon-layout'));
		this._register(addDisposableListener(this.layoutBtnEl, EventType.CLICK, () => {
			this.delegate.onAutoLayoutClick();
		}));

		this.removeBtnEl = append(actions, $('button.ade-mission-icon-btn.danger', {
			type: 'button',
			title: adeBi(localize('adeMissionRemoveAllBtn', "Remove Mission & All Employees"), '移除任务及全部执行成员'),
			'aria-label': adeBi(localize('adeMissionRemoveAllBtn', "Remove Mission & All Employees"), '移除任务及全部执行成员'),
			'data-ade-mission-remove': 'true',
		})) as HTMLButtonElement;
		this.removeBtnEl.appendChild($('span.codicon.codicon-trash'));
		this._register(addDisposableListener(this.removeBtnEl, EventType.CLICK, () => {
			this.delegate.onRemoveMissionClick();
		}));

		this.closeBtnEl = append(actions, $('button.ade-mission-icon-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionCloseDrawer', "Close"), '关闭'),
			'aria-label': adeBi(localize('adeMissionCloseDrawer', "Close"), '关闭'),
		})) as HTMLButtonElement;
		this.closeBtnEl.appendChild($('span.codicon.codicon-close'));
		this._register(addDisposableListener(this.closeBtnEl, EventType.CLICK, () => {
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
		this.leftPaneTitleEl = append(leftHead, $('span', {}, adeBi(localize('adeMissionLeftPaneTitle', "Orchestration · Mermaid DAG"), '统筹编排 · Mermaid 流图')));

		this.mermaidTextareaEl = append(leftPane, $('textarea.ade-mission-mermaid-input', {
			spellcheck: 'false',
			placeholder: MERMAID_PLACEHOLDER,
			'aria-label': adeBi(localize('adeMissionMermaidInputAria', "Mermaid DAG Definition"), 'Mermaid 流图定义'),
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
			this.setStatus(adeBi(localize('adeMissionLivePatchValidating', "Applying atomic live patch..."), '正在原子应用在线补丁...'));
			void this.delegate.onCommitLiveMermaidPatch(nextText).then(res => {
				this.livePatchInFlight = false;
				if (this.delegate.getActiveMissionId() !== missionId) {
					this.syncLivePatchButtons();
					return;
				}
				if (res.ok) {
					this.setStatus(adeBi(localize('adeMissionLivePatchApplied', "Atomic live DAG patch applied"), '已原子应用在线流图补丁'), 'ok');
				} else {
					// Keep the user's draft intact in the textarea so they can fix the validation error or explicitly Revert.
					this.setStatus(res.error ?? adeBi(localize('adeMissionLivePatchRejected', "Live DAG patch rejected."), '在线流图补丁未通过校验。'), 'error');
				}
				this.syncLivePatchButtons();
			}, err => {
				this.livePatchInFlight = false;
				if (this.delegate.getActiveMissionId() !== missionId) {
					this.syncLivePatchButtons();
					return;
				}
				const msg = err instanceof Error ? err.message : String(err);
				this.setStatus(msg || adeBi(localize('adeMissionLivePatchRejected', "Live DAG patch rejected."), '在线流图补丁未通过校验。'), 'error');
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
					this.setStatus(adeBi(
						localize('adeMissionLivePatchPendingCommit', "Draft live edit valid — click Apply Patch or press Cmd/Ctrl+Enter"),
						'在线草稿校验通过 — 点击「应用补丁」或按 Cmd/Ctrl+Enter 提交',
					));
				} else {
					this.setStatus(adeBi(localize('adeMissionLivePatchSynced', "Synced with live Mission DAG"), '已与运行中的流图同步'));
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
		this.timeoutLabelEl = append(timeoutField, $('span.ade-mission-config-label', {}, adeBi(localize('adeMissionTimeoutLabel', "Nudge Timeout (min)"), '催办超时 (分)')));
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
		this.cutoffLabelEl = append(cutoffField, $('span.ade-mission-config-label', {}, adeBi(localize('adeMissionCutoffLabel', "Off-Graph Supervisors"), '图外监工')));
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
		this.rightPaneTitleEl = append(rightHead, $('span', {}, adeBi(localize('adeMissionRightPaneTitle', "Node Prompts"), '节点提示词')));

		const promptsWorkspace = append(rightPane, $('.ade-mission-prompts-workspace'));
		this.promptNodeListEl = append(promptsWorkspace, $('.ade-mission-prompt-node-list', {
			role: 'listbox',
			'aria-label': adeBi(localize('adeMissionPromptNodesAria', "Mission Nodes"), '任务节点列表'),
			'data-ade-prompt-node-list': 'true',
		}));

		const promptEditorCol = append(promptsWorkspace, $('.ade-mission-prompt-editor-col'));
		this.promptEditorHeaderEl = append(promptEditorCol, $('.ade-mission-prompt-editor-head'));
		this.nodePromptTextareaEl = append(promptEditorCol, $('textarea.ade-mission-node-prompt-input', {
			spellcheck: 'false',
			placeholder: adeBi(
				localize(
					'adeMissionNodePromptPlaceholder',
					"Describe what this node should do (goals, target files, acceptance criteria).\nSent automatically to the assigned Agent when execution reaches this node.",
				),
				'写明这个节点需要做什么（如任务目标、涉及文件、完成标准等）。\n运行到该节点时会自动发送给对应的 Agent。',
			),
			'aria-label': adeBi(localize('adeMissionNodePromptAria', "Node Prompt"), '节点提示词'),
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
		this.promptFooterHintEl = append(promptHintBar, $('span.ade-mission-prompt-hint-text', {}, adeBi(
			localize('adeMissionPromptWakeupHint', "Sent automatically to the assigned Agent when this node runs"),
			'运行到该节点时自动发送给对应 Agent',
		)));

		const footer = append(this.fileDrawerEl, $('.ade-mission-drawer-footer'));
		this.drawerStatusEl = append(footer, $('span.ade-mission-drawer-status', {}, adeBi(
			localize('adeMissionStatusEmpty', "Write Mermaid DAG syntax to render nodes"),
			'编写 Mermaid 流图语法以实时渲染节点',
		)));
		this.livePatchActionsEl = append(footer, $('.ade-mission-live-patch-actions', {
			'data-ade-mission-live-patch-actions': 'true',
		}));
		this.revertPatchBtnEl = append(this.livePatchActionsEl, $('button.ade-mission-live-patch-btn.secondary', {
			type: 'button',
			title: adeBi(localize('adeMissionRevertLivePatchTip', "Discard unsaved live DAG draft and restore current committed graph"), '放弃未提交的在线草稿并恢复当前生效流图'),
			'data-ade-mission-revert-patch': 'true',
		}, adeBi(localize('adeMissionRevertLivePatch', "Revert"), '还原'))) as HTMLButtonElement;
		this.applyPatchBtnEl = append(this.livePatchActionsEl, $('button.ade-mission-live-patch-btn.primary', {
			type: 'button',
			title: adeBi(localize('adeMissionApplyLivePatchTip', "Validate and atomically apply live DAG patch (Cmd/Ctrl+Enter)"), '校验并原子应用在线流图补丁 (Cmd/Ctrl+Enter)'),
			'data-ade-mission-apply-patch': 'true',
		}, adeBi(localize('adeMissionApplyLivePatch', "Apply Patch"), '应用补丁'))) as HTMLButtonElement;
		this.livePatchActionsEl.hidden = true;

		this._register(addDisposableListener(this.applyPatchBtnEl, EventType.CLICK, () => {
			commitLiveMermaidPatch();
		}));
		this._register(addDisposableListener(this.revertPatchBtnEl, EventType.CLICK, () => {
			if (this.livePatchInFlight) {
				return;
			}
			this.mermaidTextareaEl.value = this.delegate.getMermaidText();
			this.setStatus(adeBi(localize('adeMissionLivePatchReverted', "Draft reverted to live Mission DAG"), '草稿已还原为当前生效流图'));
			this.syncLivePatchButtons();
		}));

		this._register(onDidChangeAdeLocale(() => this.refreshLocale()));
	}

	private refreshLocale(): void {
		const fileTip = adeBi(localize('adeMissionFileBtnTooltip', "Mission Mermaid DAG File"), '任务流图源码与提示词抽屉');
		this.fileBtnEl.title = fileTip;
		this.fileBtnEl.setAttribute('aria-label', adeBi(localize('adeMissionFileBtnAria', "Open Mission Mermaid DAG File"), '打开任务流图源码文件'));
		const stopTip = adeBi(localize('adeMissionStopTooltip', "Stop Mission"), '停止任务');
		this.runStopBtnEl.title = stopTip;
		this.runStopBtnEl.setAttribute('aria-label', stopTip);
		this.fileDrawerEl.setAttribute('aria-label', adeBi(localize('adeMissionDrawerAria', "Mission Mermaid File"), '任务流图源码与提示词文件'));
		const layoutTip = adeBi(localize('adeMissionAutoLayoutBtn', "Auto Layout"), '自动整理布局');
		this.layoutBtnEl.title = layoutTip;
		this.layoutBtnEl.setAttribute('aria-label', layoutTip);
		const removeTip = adeBi(localize('adeMissionRemoveAllBtn', "Remove Mission & All Employees"), '移除任务及全部执行成员');
		this.removeBtnEl.title = removeTip;
		this.removeBtnEl.setAttribute('aria-label', removeTip);
		const closeTip = adeBi(localize('adeMissionCloseDrawer', "Close"), '关闭');
		this.closeBtnEl.title = closeTip;
		this.closeBtnEl.setAttribute('aria-label', closeTip);
		this.leftPaneTitleEl.textContent = adeBi(localize('adeMissionLeftPaneTitle', "Orchestration · Mermaid DAG"), '统筹编排 · Mermaid 流图');
		this.rightPaneTitleEl.textContent = adeBi(localize('adeMissionRightPaneTitle', "Node Prompts"), '节点提示词');
		this.timeoutLabelEl.textContent = adeBi(localize('adeMissionTimeoutLabel', "Nudge Timeout (min)"), '催办超时 (分)');
		this.cutoffLabelEl.textContent = adeBi(localize('adeMissionCutoffLabel', "Off-Graph Supervisors"), '图外监工');
		this.nodePromptTextareaEl.placeholder = adeBi(
			localize(
				'adeMissionNodePromptPlaceholder',
				"Describe what this node should do (goals, target files, acceptance criteria).\nSent automatically to the assigned Agent when execution reaches this node.",
			),
			'写明这个节点需要做什么（如任务目标、涉及文件、完成标准等）。\n运行到该节点时会自动发送给对应的 Agent。',
		);
		this.revertPatchBtnEl.textContent = adeBi(localize('adeMissionRevertLivePatch', "Revert"), '还原');
		this.applyPatchBtnEl.textContent = adeBi(localize('adeMissionApplyLivePatch', "Apply Patch"), '应用补丁');

		// Force dynamic controls & prompts pane to refresh labels in the new locale
		this.lastRunBarPrimaryKey = '';
		this.lastCutoffSignature = '';
		if (this.lastRuntimeSyncArgs) {
			this.syncRuntimeControls(...this.lastRuntimeSyncArgs);
		} else {
			this.runStatusLabelEl.textContent = adeBi(localize('adeMissionRunIdle', "Idle"), '待命');
		}
		this.syncPromptsPane(true);
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
		const nextOpen = forceOpen ?? !this.drawerOpen;
		const changed = nextOpen !== this.drawerOpen;
		this.drawerOpen = nextOpen;
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
		if (changed) {
			this.delegate.onDrawerOpenChanged?.(this.drawerOpen);
		}
	}

	syncRuntimeControls(state: IMissionRuntimeState | undefined, nodeCount: number, rankCount: number): void {
		this.lastRuntimeSyncArgs = [state, nodeCount, rankCount];
		const hasRuntime = Boolean(state);
		this.runBarEl.hidden = !hasRuntime;
		if (!state) {
			return;
		}
		const status = state.status;
		if (this.runBarEl.dataset.status !== status) {
			this.runBarEl.dataset.status = status;
		}
		const statusLabel = status === 'running'
			? adeBi(localize('adeMissionRunRunning', "Running"), '运行中')
			: status === 'paused'
				? adeBi(localize('adeMissionRunPaused', "Paused"), '已暂停')
				: status === 'completed'
					? adeBi(localize('adeMissionRunCompleted', "Done"), '已完成')
					: status === 'failed'
						? adeBi(localize('adeMissionRunFailed', "Failed"), '失败')
						: status === 'stopped'
							? adeBi(localize('adeMissionRunStopped', "Stopped"), '已停止')
							: adeBi(localize('adeMissionRunIdle', "Idle"), '待命');
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
				append(this.runPrimaryBtnEl, $('span', {}, adeBi(localize('adeMissionPauseBtn', "Pause"), '暂停')));
			} else if (primaryBucket === 'resume') {
				this.runPrimaryBtnEl.appendChild($('span.codicon.codicon-debug-continue'));
				append(this.runPrimaryBtnEl, $('span', {}, adeBi(localize('adeMissionResumeBtn', "Resume"), '继续')));
			} else {
				this.runPrimaryBtnEl.appendChild($('span.codicon.codicon-play'));
				append(this.runPrimaryBtnEl, $('span', {}, adeBi(localize('adeMissionStartBtn', "Start"), '启动')));
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
			? adeBi(localize('adeMissionTimeoutLockedTip', "Locked while Mission is running"), '任务运行期间已锁定')
			: adeBi(localize('adeMissionTimeoutEditTip', "Watchdog silence nudge timeout in minutes (locked once started)"), '卡顿静默自动催办超时分钟数（启动后锁定）');

		const maxCutoff = Math.max(0, rankCount - 1);
		const cutoffSig = `${maxCutoff}`;
		if (this.lastCutoffSignature !== cutoffSig) {
			this.lastCutoffSignature = cutoffSig;
			clearNode(this.cutoffSelectEl);
			for (let k = 0; k <= maxCutoff; k++) {
				append(this.cutoffSelectEl, $('option', { value: String(k) },
					k === 0
						? adeBi(localize('adeMissionCutoffL0', "L0 only"), '仅 L0')
						: adeBi(localize('adeMissionCutoffLk', "L0..L{0}", k), 'L0..L{0}', k),
				));
			}
		}
		const targetCutoff = String(state.boundary.offGraphMaxTier);
		if (this.cutoffSelectEl.value !== targetCutoff) {
			this.cutoffSelectEl.value = targetCutoff;
		}
		this.cutoffSelectEl.disabled = status === 'running' || status === 'paused';
		this.syncLivePatchButtons();
	}

	syncPromptsPane(preserveTextarea = false): void {
		const prompts = this.delegate.getNodePrompts();
		const taskNodes = this.delegate.getNodes().filter(n => n.kind !== 'gate');

		const configuredCount = taskNodes.filter(n => Boolean(prompts[n.id]?.trim())).length;
		const countText = adeBi(
			localize('adeMissionPromptCountPill', "{0}/{1} Prompts", configuredCount, taskNodes.length),
			'{0}/{1} 条提示词',
			configuredCount,
			taskNodes.length,
		);
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
			append(this.promptNodeListEl, $('.ade-mission-prompt-empty', {}, adeBi(localize('adeMissionPromptNoNodes', "No task nodes yet"), '暂无任务节点')));
			this.nodePromptTextareaEl.value = '';
			this.nodePromptTextareaEl.disabled = true;
			this.promptFooterHintEl.textContent = adeBi(
				localize('adeMissionPromptAddMermaidFirst', "Add nodes in the Mermaid editor on the left to write per-node instructions"),
				'先在左侧添加节点，即可为每个节点编写任务说明',
			);
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
				title: adeBi(localize('adeMissionClearNodePromptTip', "Clear pre-prompt for {0}", activeNode.id), '清空 {0} 的节点提示词', activeNode.id),
				'data-ade-node-prompt-clear': activeNode.id,
			}, adeBi(localize('adeMissionClearNodePrompt', "Clear"), '清空'))) as HTMLButtonElement;
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
			? adeBi(localize('adeMissionPromptSavedHint', "Auto-sent when {0} runs · {1} chars", activeNode.id, charCount), '运行到 {0} 时自动发送 · {1} 字', activeNode.id, charCount)
			: adeBi(localize('adeMissionPromptWakeupHint', "Sent automatically to the assigned Agent when this node runs"), '运行到该节点时自动发送给对应 Agent');
	}
}
