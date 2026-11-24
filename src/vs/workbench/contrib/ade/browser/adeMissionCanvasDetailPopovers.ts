/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	IMissionDagNode,
	IMissionNodeCheckHook,
	IMissionTaskCompletionContract,
} from '../../../../platform/ade/common/adeMissionDag.js';
import {
	IMissionTaskStatusRecord,
	IOrchestrationJoinBarrier,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationTokenDeltaView,
	IOrchestrationWhiteboard,
	MissionTaskStatus,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import { parseWhiteboardSections } from '../../../../platform/ade/common/adeOrchestrationWhiteboards.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, IAdeOrganizationConfig } from '../../../../platform/ade/common/adeRoleSchema.js';
import { adeBi } from '../common/adeLocalization.js';
import {
	formatMissionBlockedRemaining,
	formatMissionWaveTag,
} from './adeMissionCanvasRenderer.js';

export type IDeterministicCheckHook = IMissionNodeCheckHook;

export interface IMissionPopoverPointerReadResult {
	readonly title?: string;
	readonly kind?: string;
	readonly content?: string;
	readonly error?: string;
}

export interface IMissionTaskStatusCallbackOutcome {
	readonly ok: boolean;
	readonly error?: string;
	readonly unmetRequirements?: readonly string[];
}

export type MissionTaskStatusSetReturn =
	| void
	| boolean
	| IMissionTaskStatusCallbackOutcome
	| Promise<void | boolean | IMissionTaskStatusCallbackOutcome>;

export interface IMissionTaskEditorPopoverOptions {
	readonly completionContract?: IMissionTaskCompletionContract;
	readonly statusRecord?: IMissionTaskStatusRecord;
	readonly nodeChecks?: readonly IMissionNodeCheckHook[];
	readonly activeTokens?: readonly IOrchestrationToken[];
	readonly assigneeNodeId?: string;
	readonly assigneeLabel?: string;
	readonly focusSection?: 'contract' | 'checks';
	readonly onRunChecks?: () => Promise<unknown> | unknown;
	readonly onJumpToStaff?: (staffNodeId: string, focusTokenId?: string) => void;
	readonly onJumpToWhiteboard?: (wbId: string) => void;
	readonly onReadPointer?: (ptr: string) => Promise<string | IMissionPopoverPointerReadResult | undefined> | string | IMissionPopoverPointerReadResult | undefined;
}

export interface IMissionTaskEditorPopoverCallbacks extends IMissionTaskEditorPopoverOptions {
	readonly onRenameTask: (nextTitle: string) => void;
	readonly onChangeDescription: (nextDesc: string) => void;
	readonly onSetTaskStatus: (nextStatus: MissionTaskStatus) => MissionTaskStatusSetReturn;
	readonly onChangeColor?: (nextColor: string | null) => void;
}

export interface IOrchestrationTokenPopoverOptions {
	readonly delta?: IOrchestrationTokenDeltaView;
	readonly getDeltaForToken?: (token: IOrchestrationToken) => IOrchestrationTokenDeltaView | undefined;
	readonly onOpenWhiteboard?: (whiteboardId: string) => void;
	readonly onReadPointer?: (ptr: string, tokenId?: string) => IMissionPopoverPointerReadResult | undefined;
	readonly allStaffTokens?: readonly IOrchestrationToken[];
	readonly joinBarrier?: IOrchestrationJoinBarrier;
	readonly joinBarriers?: Readonly<Record<string, IOrchestrationJoinBarrier>>;
	readonly onJumpToTask?: (taskNodeId: string) => void;
	readonly focusSection?: 'barrier' | 'scope' | 'rework';
}

export interface IWhiteboardEditorPopoverOptions {
	readonly currentColor?: string;
	readonly onChangeColor?: (nextColor: string | null) => void;
	readonly initialSection?: string;
	readonly updatedByLabel?: string;
	readonly updatedAt?: number;
	readonly getLatestVersion?: () => number | undefined;
	readonly getLatestWhiteboard?: () => IOrchestrationWhiteboard | undefined;
}

export interface IMissionDetailPopoverHost {
	readonly popoverEl: HTMLElement;
	readonly popoverDisposables: DisposableStore;
	getPopoverGeneration(): number;
	bumpPopoverGeneration(): number;
	close(reason?: 'dismiss' | 'escape'): void;
	positionNear(anchorEl: HTMLElement, width: number, estimatedHeight?: number, offsetY?: number): { readonly bodyRect: DOMRect; readonly anchorRect: DOMRect };
	clampToViewport(bodyRect: DOMRect, anchorRect: DOMRect, offsetY?: number): void;
	positionAtClientPoint(clientX: number, clientY: number, width: number, estimatedHeight: number): DOMRect;
	clampClientPointToViewport(bodyRect: DOMRect, clientX: number, clientY: number): void;
	getOrganizationConfig(): IAdeOrganizationConfig;
	renderNodeColorPickerSection(
		parentEl: HTMLElement,
		currentColor: string | undefined,
		onSelectColor: (color: string | null) => void,
		options?: { readonly closeOnPick?: boolean; readonly compact?: boolean },
	): void;
	getNodePrompt(missionId: string, nodeId: string): string;
	bindPromptEditorHandles(nodeId: string, textarea: HTMLTextAreaElement): void;
	setInlineErrorHandle?(el: HTMLElement | undefined): void;
	setBeforeCloseFlush(fn: (() => void) | undefined): void;
	setOrchCountdownUpdater(fn: ((now: number, orchState?: IOrchestrationRuntimeState) => void) | undefined): void;
	resolveOrchestrationTokenDelta?(missionId: string | undefined, tokenId: string): IOrchestrationTokenDeltaView | undefined;
	resolveOrchestrationState?(missionId: string | undefined): IOrchestrationRuntimeState | undefined;
	getActiveMissionId(): string | undefined;
}

function toSafeCssSlug(raw: string): string {
	return raw.trim().replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function formatCompactRelativeAge(timestampMs: number | undefined, now = Date.now()): string {
	if (!timestampMs || !Number.isFinite(timestampMs)) {
		return '';
	}
	const diffSec = Math.max(0, Math.floor((now - timestampMs) / 1000));
	if (diffSec < 60) {
		return adeBi(localize('adePopJustNow', "just now"), '刚刚');
	}
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) {
		return adeBi(localize('adePopMinutesAgo', "{0}m ago", diffMin), '{0} 分钟前', diffMin);
	}
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) {
		return adeBi(localize('adePopHoursAgo', "{0}h ago", diffHr), '{0} 小时前', diffHr);
	}
	const diffDay = Math.floor(diffHr / 24);
	return adeBi(localize('adePopDaysAgo', "{0}d ago", diffDay), '{0} 天前', diffDay);
}

function hasAnyCompletionContractRule(contract: IMissionTaskCompletionContract | undefined): boolean {
	if (!contract) {
		return false;
	}
	return Boolean(
		contract.requireChecksPassed
		|| contract.requireArtifact
		|| contract.requireFiles
		|| (contract.requiredWhiteboardIds && contract.requiredWhiteboardIds.length > 0)
		|| (contract.minSummaryChars !== undefined && contract.minSummaryChars > 0),
	);
}

/**
 * Renders the enriched Mission View Task Detail & Editor Popover:
 * - C4 Completion Contract live checklist (`.ade-pop-contract-box`)
 * - C4 Verification Receipt & Node Check Hooks (`.ade-pop-receipt-box`)
 * - Cross-view Staff assignee (`@Name`) & live baton (`⚡ W1 · tok`) jump links
 * - Flush-on-dismiss title edit + contract-aware status toggle error retention
 */
export function renderMissionTaskDetailPopover(
	host: IMissionDetailPopoverHost,
	missionId: string,
	node: IMissionDagNode,
	positionalStatusRecord: IMissionTaskStatusRecord | undefined,
	anchorEl: HTMLElement,
	callbacks: IMissionTaskEditorPopoverCallbacks,
	extraOptions?: IMissionTaskEditorPopoverOptions,
): void {
	const merged: IMissionTaskEditorPopoverCallbacks = extraOptions
		? { ...callbacks, ...extraOptions }
		: callbacks;
	const statusRecord = merged.statusRecord ?? positionalStatusRecord;
	const contract = merged.completionContract ?? node.completionContract;
	const nodeChecks = merged.nodeChecks ?? node.checks ?? [];
	const activeTokens = merged.activeTokens ?? [];
	const assigneeNodeId = merged.assigneeNodeId ?? statusRecord?.assigneeNodeId ?? node.assigneeNodeId;
	const assigneeLabel = merged.assigneeLabel ?? statusRecord?.assigneeLabel ?? assigneeNodeId;

	host.close('dismiss');
	const openGen = host.getPopoverGeneration();
	host.popoverEl.classList.add('is-prompt-popover');
	host.popoverEl.dataset.popoverKind = 'mission-task';
	host.popoverEl.dataset.popoverNodeId = node.id;

	const hasRichSections = hasAnyCompletionContractRule(contract)
		|| Boolean(statusRecord?.lastCheckReceipt)
		|| nodeChecks.length > 0
		|| Boolean(assigneeNodeId)
		|| activeTokens.length > 0
		|| Boolean(statusRecord?.touchedFiles?.length)
		|| Boolean(statusRecord?.artifactPtrs?.length);
	const { bodyRect, anchorRect } = host.positionNear(anchorEl, hasRichSections ? 412 : 380, hasRichSections ? 420 : 310, 8);
	host.popoverDisposables.add(addDisposableListener(host.popoverEl, EventType.POINTER_DOWN, e => e.stopPropagation()));

	const head = append(host.popoverEl, $('.ade-mission-token-insp-head'));
	const titleLeft = append(head, $('.ade-mission-task-pop-head-left'));
	append(titleLeft, $('span.ade-mission-task-desc-id', {}, node.id));
	append(titleLeft, $('.ade-mission-emp-popover-title', {}, adeBi(localize('adeTaskPopTitle', "Task Details"), '任务详情')));
	const currentStatus = statusRecord?.status ?? 'pending';
	append(head, $(`span.ade-mission-token-status-badge.status-${toSafeCssSlug(currentStatus)}`, {},
		currentStatus === 'completed'
			? adeBi(localize('adeTaskStateCompleted', "Completed"), '已完成')
			: currentStatus === 'in_progress'
				? adeBi(localize('adeTaskStateInProgress', "In Progress"), '进行中')
				: currentStatus === 'blocked'
					? adeBi(localize('adeTaskStateBlocked', "Blocked"), '阻塞中')
					: adeBi(localize('adeTaskStatePending', "Pending"), '待完成'),
	));
	const closeBtn = append(head, $('button.ade-mission-icon-btn', {
		type: 'button',
		title: adeBi(localize('adeMissionClose', "Close"), '关闭'),
		'aria-label': adeBi(localize('adeMissionClose', "Close"), '关闭'),
	})) as HTMLButtonElement;
	closeBtn.appendChild($('span.codicon.codicon-close'));
	host.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => host.close('dismiss')));

	// Cross-view Execution Lineage Bar (Assignee Staff + Active Batons + Department)
	if (assigneeNodeId || activeTokens.length > 0 || node.department) {
		const linkRow = append(host.popoverEl, $('.ade-mission-token-meta-row', {
			'data-ade-task-live-links': 'true',
		}));
		if (node.department) {
			append(linkRow, $('span.ade-orch-wb-dept-chip', {}, node.department));
		}
		if (assigneeNodeId) {
			if (merged.onJumpToStaff) {
				const staffBtn = append(linkRow, $('button.ade-mission-token-trace-btn', {
					type: 'button',
					'data-ade-jump-staff': assigneeNodeId,
					title: adeBi(
						localize('adeTaskJumpStaffTip', "Switch to Orchestration View and focus @{0}", assigneeLabel ?? assigneeNodeId),
						'切换至编排视图并定位员工 @{0}',
						assigneeLabel ?? assigneeNodeId,
					),
				}, `@${assigneeLabel ?? assigneeNodeId} ↗`)) as HTMLButtonElement;
				host.popoverDisposables.add(addDisposableListener(staffBtn, EventType.CLICK, () => {
					host.close('dismiss');
					merged.onJumpToStaff?.(assigneeNodeId);
				}));
			} else {
				append(linkRow, $('span.ade-mission-token-meta-chip', {}, `@${assigneeLabel ?? assigneeNodeId}`));
			}
		}
		const shownTokens = activeTokens.slice(0, 2);
		for (const tok of shownTokens) {
			const chipLabel = `⚡ ${formatMissionWaveTag(tok.waveId)} · ${tok.id}`;
			if (merged.onJumpToStaff && tok.nodeId) {
				const tokBtn = append(linkRow, $('button.ade-mission-token-trace-btn', {
					type: 'button',
					'data-ade-jump-staff': tok.nodeId,
					'data-ade-jump-token': tok.id,
				}, chipLabel)) as HTMLButtonElement;
				host.popoverDisposables.add(addDisposableListener(tokBtn, EventType.CLICK, () => {
					host.close('dismiss');
					merged.onJumpToStaff?.(tok.nodeId, tok.id);
				}));
			} else {
				append(linkRow, $('span.ade-mission-token-meta-chip.wave', {}, chipLabel));
			}
		}
		if (activeTokens.length > shownTokens.length) {
			append(linkRow, $('span.ade-mission-token-meta-chip', {}, `+${activeTokens.length - shownTokens.length}`));
		}
	}

	if (statusRecord?.blockedReason || statusRecord?.lastError) {
		const alertBox = append(host.popoverEl, $(`.ade-mission-token-box.${statusRecord.lastError ? 'is-failed' : 'is-blocked'}`, {
			'data-ade-task-alert': 'true',
		}));
		append(alertBox, $('.ade-mission-token-box-body', {}, statusRecord.lastError ?? statusRecord.blockedReason ?? ''));
	}

	const titleInput = append(host.popoverEl, $('input.ade-mission-task-pop-title-input', {
		type: 'text',
		value: node.label,
		placeholder: adeBi(localize('adeTaskPopTitlePh', "Task title…"), '任务标题…'),
		'data-ade-task-title-input': node.id,
	})) as HTMLInputElement;
	let lastCommittedTitle = node.label;
	const commitTitle = () => {
		const v = titleInput.value.trim();
		if (v && v !== lastCommittedTitle) {
			lastCommittedTitle = v;
			merged.onRenameTask(v);
		}
	};
	host.setBeforeCloseFlush(commitTitle);
	host.popoverDisposables.add(addDisposableListener(titleInput, EventType.CHANGE, commitTitle));

	append(host.popoverEl, $('.ade-mission-task-pop-label', {}, adeBi(localize('adeTaskPopDescLabel', "Task Description"), '任务详细内容与描述')));
	const descTextarea = append(host.popoverEl, $('textarea.ade-mission-node-prompt-popover-input', {
		rows: hasRichSections ? '3' : '5',
		spellcheck: 'false',
		placeholder: adeBi(
			localize('adeTaskPopDescPh', "Describe concrete objectives, technical constraints, and acceptance criteria…"),
			'填写任务的具体目标、实现约束、输入输出与达标验收标准…',
		),
		'data-ade-task-pop-desc': node.id,
	})) as HTMLTextAreaElement;
	descTextarea.value = host.getNodePrompt(missionId, node.id);
	host.bindPromptEditorHandles(node.id, descTextarea);

	host.popoverDisposables.add(addDisposableListener(titleInput, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		e.stopPropagation();
		if (e.key === 'Enter') {
			e.preventDefault();
			commitTitle();
			descTextarea.focus();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			host.close('escape');
		}
	}));
	host.popoverDisposables.add(addDisposableListener(descTextarea, EventType.INPUT, () => {
		merged.onChangeDescription(descTextarea.value);
	}));
	host.popoverDisposables.add(addDisposableListener(descTextarea, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		e.stopPropagation();
		if (e.key === 'Escape') {
			e.preventDefault();
			host.close('escape');
		}
	}));

	// C4 Completion Contract Box (`.ade-pop-contract-box`)
	let contractBoxEl: HTMLElement | undefined;
	const receipt = statusRecord?.lastCheckReceipt;
	const isReceiptStale = Boolean(receipt && statusRecord?.lastReworkAt && statusRecord.lastReworkAt > receipt.checkedAt);
	if (hasAnyCompletionContractRule(contract) && contract) {
		contractBoxEl = append(host.popoverEl, $('.ade-pop-contract-box', {
			'data-ade-pop-contract-box': 'true',
		}));
		append(contractBoxEl, $('.ade-mission-task-pop-label', {}, adeBi(
			localize('adeTaskContractBoxTitle', "Completion Contract Guardrails"),
			'完成契约硬性门槛',
		)));
		const pillList = append(contractBoxEl, $('.ade-mission-token-meta-row'));
		const addContractItem = (met: boolean, label: string) => {
			append(pillList, $(`span.ade-mission-token-meta-chip.${met ? 'ok' : 'warn'}`, {
				'data-contract-met': met ? 'true' : 'false',
			}, `${met ? '✓' : '○'} ${label}`));
		};
		if (contract.requireChecksPassed) {
			const checksOk = Boolean(receipt?.passed && !isReceiptStale);
			addContractItem(checksOk, adeBi(localize('adeTaskContractChecks', "Checks passed"), '校验通过'));
		}
		if (contract.requireArtifact) {
			const artCount = statusRecord?.artifactPtrs?.length ?? 0;
			addContractItem(artCount > 0, adeBi(localize('adeTaskContractArtifact', "Artifact ({0})", artCount), '交付产物 ({0})', artCount));
		}
		if (contract.requireFiles) {
			const fileCount = statusRecord?.touchedFiles?.length ?? 0;
			addContractItem(fileCount > 0, adeBi(localize('adeTaskContractFiles', "Touched files ({0})", fileCount), '变更文件 ({0})', fileCount));
		}
		if (contract.minSummaryChars && contract.minSummaryChars > 0) {
			const noteLen = (statusRecord?.note ?? '').trim().length;
			const met = currentStatus === 'completed' || noteLen >= contract.minSummaryChars;
			addContractItem(met, adeBi(localize('adeTaskContractMinSummary', "Summary ≥{0}c", contract.minSummaryChars), '总结 ≥{0} 字', contract.minSummaryChars));
		}
		if (contract.requiredWhiteboardIds && contract.requiredWhiteboardIds.length > 0) {
			for (const wbId of contract.requiredWhiteboardIds) {
				const wbTip = adeBi(localize('adeTaskJumpWbTip', "Open shared whiteboard {0}", wbId), '打开共享白板 {0}', wbId);
				if (merged.onJumpToWhiteboard) {
					const wbBtn = append(pillList, $('button.ade-mission-token-trace-btn', {
						type: 'button',
						'data-ade-jump-whiteboard': wbId,
						title: wbTip,
					}, `📋 ${wbId} ↗`)) as HTMLButtonElement;
					host.popoverDisposables.add(addDisposableListener(wbBtn, EventType.CLICK, () => {
						host.close('dismiss');
						merged.onJumpToWhiteboard?.(wbId);
					}));
				} else {
					append(pillList, $('span.ade-mission-token-meta-chip', { title: wbTip }, `📋 ${wbId}`));
				}
			}
		}
	}

	// Lazy pointer preview box (created detached, mounted after receipt/evidence box so clicking artifact chips never shifts controls downward)
	const taskPtrPreviewEl = $('.ade-orch-ptr-preview', {
		'data-ade-task-ptr-preview': 'true',
	});
	taskPtrPreviewEl.hidden = true;
	const taskPtrHead = append(taskPtrPreviewEl, $('.ade-orch-ptr-preview-head'));
	const taskPtrTitle = append(taskPtrHead, $('span.ade-orch-ptr-preview-title'));
	const taskPtrClose = append(taskPtrHead, $('button.ade-mission-icon-btn', {
		type: 'button',
		title: adeBi(localize('adeMissionClose', "Close"), '关闭'),
		'aria-label': adeBi(localize('adeMissionClose', "Close"), '关闭'),
	})) as HTMLButtonElement;
	taskPtrClose.appendChild($('span.codicon.codicon-close'));
	host.popoverDisposables.add(addDisposableListener(taskPtrClose, EventType.CLICK, () => {
		taskPtrPreviewEl.hidden = true;
	}));
	const taskPtrBody = append(taskPtrPreviewEl, $('pre.ade-orch-ptr-preview-body'));
	const emptyPlaceholder = adeBi(localize('adePopEmptyContent', "(empty)"), '（空）');
	let ptrReqSeq = 0;
	const previewTaskPointer = (ptr: string) => {
		if (!merged.onReadPointer) {
			return;
		}
		const reqId = ++ptrReqSeq;
		const readFn = merged.onReadPointer;
		void new Promise<string | IMissionPopoverPointerReadResult | undefined>(resolve => resolve(readFn(ptr))).then(res => {
			if (openGen !== host.getPopoverGeneration() || reqId !== ptrReqSeq || res === undefined) {
				return;
			}
			if (typeof res === 'string') {
				taskPtrTitle.textContent = ptr;
				taskPtrBody.textContent = res || emptyPlaceholder;
			} else {
				taskPtrTitle.textContent = res.title ? `${ptr} · ${res.title}` : ptr;
				taskPtrBody.textContent = res.error ? res.error : (res.content ?? emptyPlaceholder);
			}
			taskPtrPreviewEl.hidden = false;
			host.clampToViewport(bodyRect, anchorRect, 8);
		}, () => undefined);
	};

	const statusErrEl = $('.ade-mission-drawer-status.error', {
		hidden: 'true',
		'data-ade-popover-inline-error': 'true',
	});

	// C4 Verification Receipt, Artifacts & Deterministic Check Hooks Box (`.ade-pop-receipt-box`)
	let receiptBoxEl: HTMLElement | undefined;
	const hasArtifacts = Boolean(statusRecord?.artifactPtrs && statusRecord.artifactPtrs.length > 0);
	if (receipt || nodeChecks.length > 0 || (statusRecord?.touchedFiles && statusRecord.touchedFiles.length > 0) || hasArtifacts) {
		receiptBoxEl = append(host.popoverEl, $('.ade-pop-receipt-box', {
			'data-ade-pop-receipt-box': 'true',
		}));
		const recHead = append(receiptBoxEl, $('.ade-mission-ni-section-head'));
		append(recHead, $('.ade-mission-task-pop-label', {}, adeBi(
			localize('adeTaskReceiptBoxTitle', "Verification & Evidence"),
			'确定性校验回执与证据',
		)));
		if (merged.onRunChecks && nodeChecks.length > 0) {
			const idleRunLabel = adeBi(localize('adeTaskRunChecksBtn', "Run Checks"), '立即校验');
			const runningLabel = adeBi(localize('adeTaskRunningChecksBtn', "Running…"), '校验中…');
			const runBtn = append(recHead, $('button.ade-mission-token-trace-btn', {
				type: 'button',
				'data-ade-task-run-checks': node.id,
			}, idleRunLabel)) as HTMLButtonElement;
			host.popoverDisposables.add(addDisposableListener(runBtn, EventType.CLICK, () => {
				statusErrEl.hidden = true;
				statusErrEl.textContent = '';
				runBtn.disabled = true;
				runBtn.textContent = runningLabel;
				void new Promise<unknown>(resolve => resolve(merged.onRunChecks?.())).then(() => {
					if (openGen === host.getPopoverGeneration()) {
						runBtn.disabled = false;
						runBtn.textContent = idleRunLabel;
						host.clampToViewport(bodyRect, anchorRect, 8);
					}
				}, err => {
					if (openGen !== host.getPopoverGeneration()) {
						return;
					}
					runBtn.disabled = false;
					runBtn.textContent = idleRunLabel;
					statusErrEl.textContent = err instanceof Error ? err.message : String(err);
					statusErrEl.hidden = false;
					host.clampToViewport(bodyRect, anchorRect, 8);
				});
			}));
		}
		if (receipt) {
			const badgeState = isReceiptStale ? 'warn' : (receipt.passed ? 'ok' : 'danger');
			const badgeText = isReceiptStale
				? adeBi(localize('adeTaskReceiptStale', "STALE (Rework newer)"), '已过期（返工后需重跑）')
				: receipt.passed
					? adeBi(localize('adeTaskReceiptPassed', "PASS"), '通过')
					: adeBi(localize('adeTaskReceiptFailed', "FAIL"), '未通过');
			const recMeta = append(receiptBoxEl, $('.ade-mission-token-meta-row'));
			append(recMeta, $(`span.ade-mission-token-meta-chip.${badgeState}`, {}, badgeText));
			if (receipt.checkCount !== undefined) {
				append(recMeta, $('span.ade-mission-token-meta-chip', {}, receipt.checkCount === 1
					? adeBi(localize('adeTaskReceiptOneCheckCount', "1 check"), '1 项检查')
					: adeBi(localize('adeTaskReceiptCheckCount', "{0} checks", receipt.checkCount), '{0} 项检查', receipt.checkCount)));
			}
			const age = formatCompactRelativeAge(receipt.checkedAt);
			if (age) {
				append(recMeta, $('span.ade-mission-token-meta-chip', {}, age));
			}
			if (receipt.summary) {
				append(receiptBoxEl, $('.ade-mission-token-box-body', {}, receipt.summary));
			}
		}
		if (nodeChecks.length > 0) {
			const hooksMeta = append(receiptBoxEl, $('.ade-mission-token-meta-row'));
			for (const chk of nodeChecks.slice(0, 4)) {
				const spec = chk.name ?? chk.command ?? (chk.expectFiles?.[0] ? `file:${chk.expectFiles[0]}` : chk.id);
				append(hooksMeta, $('span.ade-mission-token-meta-chip', { title: spec }, `⚙ ${spec}`));
			}
			if (nodeChecks.length > 4) {
				append(hooksMeta, $('span.ade-mission-token-meta-chip', {}, `+${nodeChecks.length - 4}`));
			}
		}
		if (statusRecord?.artifactPtrs && statusRecord.artifactPtrs.length > 0) {
			const artRow = append(receiptBoxEl, $('.ade-mission-token-meta-row'));
			for (const ptr of statusRecord.artifactPtrs) {
				if (merged.onReadPointer) {
					const ptrBtn = append(artRow, $('button.ade-orch-hop-ptr-btn', {
						type: 'button',
						'data-ade-task-artifact-ptr': ptr,
					}, `📦 ${ptr}`)) as HTMLButtonElement;
					host.popoverDisposables.add(addDisposableListener(ptrBtn, EventType.CLICK, () => previewTaskPointer(ptr)));
				} else {
					append(artRow, $('span.ade-mission-token-meta-chip', {}, `📦 ${ptr}`));
				}
			}
		}
		if (statusRecord?.touchedFiles && statusRecord.touchedFiles.length > 0) {
			const filesRow = append(receiptBoxEl, $('.ade-mission-token-meta-row'));
			for (const f of statusRecord.touchedFiles.slice(0, 5)) {
				append(filesRow, $('span.ade-mission-token-meta-chip.file', { title: f }, `◫ ${f}`));
			}
			if (statusRecord.touchedFiles.length > 5) {
				append(filesRow, $('span.ade-mission-token-meta-chip', {}, `+${statusRecord.touchedFiles.length - 5}`));
			}
		}
	}

	append(host.popoverEl, taskPtrPreviewEl);

	if (merged.onChangeColor) {
		host.renderNodeColorPickerSection(host.popoverEl, node.color, merged.onChangeColor, { compact: true });
	}

	append(host.popoverEl, statusErrEl);
	host.setInlineErrorHandle?.(statusErrEl);

	const hasUnmetContract = Boolean(
		currentStatus !== 'completed'
		&& contract
		&& (
			(contract.requireChecksPassed && (!receipt?.passed || isReceiptStale))
			|| (contract.requireArtifact && !(statusRecord?.artifactPtrs?.length))
			|| (contract.requireFiles && !(statusRecord?.touchedFiles?.length))
			|| (contract.minSummaryChars && contract.minSummaryChars > 0 && (statusRecord?.note ?? '').trim().length < contract.minSummaryChars)
		),
	);
	const statusRow = append(host.popoverEl, $('.ade-mission-task-pop-footer'));
	const metaText = statusRecord?.status === 'completed' && statusRecord.completedByLabel
		? adeBi(localize('adeTaskCompletedByMeta', "Completed by {0}", statusRecord.completedByLabel), '由 {0} 标注完成', statusRecord.completedByLabel)
		: hasUnmetContract
			? adeBi(localize('adeTaskContractGuardedMeta', "Completion gated by contract & checks"), '需满足完成契约与校验门槛')
			: adeBi(localize('adeTaskHighestRankMeta', "Marked completed by highest-rank role"), '运行中由最高职级角色标注完成');
	append(statusRow, $('span.ade-mission-task-pop-meta', {}, metaText));

	const toggleBtn = append(statusRow, $(`button.ade-mission-token-action-btn${currentStatus === 'completed' || hasUnmetContract ? '' : '.primary'}`, {
		type: 'button',
		'data-ade-task-toggle-complete': node.id,
	}, currentStatus === 'completed'
		? adeBi(localize('adeTaskMarkPendingBtn', "Reopen Task"), '重置为待完成')
		: adeBi(localize('adeTaskMarkCompletedBtn', "Mark Completed ✓"), '标注已完成 ✓'))) as HTMLButtonElement;

	host.popoverDisposables.add(addDisposableListener(toggleBtn, EventType.CLICK, () => {
		const targetStatus: MissionTaskStatus = currentStatus === 'completed' ? 'pending' : 'completed';
		statusErrEl.hidden = true;
		statusErrEl.textContent = '';
		toggleBtn.disabled = true;
		void new Promise<MissionTaskStatusSetReturn>(resolve => resolve(merged.onSetTaskStatus(targetStatus))).then(res => {
			if (openGen !== host.getPopoverGeneration()) {
				return;
			}
			toggleBtn.disabled = false;
			if (res === false) {
				statusErrEl.textContent = adeBi(
					localize('adeTaskStatusRejectedFallback', "Cannot update task status: upstream dependencies or completion contract unmet."),
					'无法变更任务状态：上游依赖尚未完成或未满足完成契约门槛。',
				);
				statusErrEl.hidden = false;
				host.clampToViewport(bodyRect, anchorRect, 8);
				return;
			}
			if (typeof res === 'object' && res !== null) {
				const outcome = res as IMissionTaskStatusCallbackOutcome;
				if (outcome.ok === false) {
					const detail = outcome.unmetRequirements && outcome.unmetRequirements.length > 0
						? `${outcome.error ?? ''} (${outcome.unmetRequirements.join('; ')})`.trim()
						: (outcome.error ?? adeBi(localize('adeTaskStatusRejectedGeneric', "Task status transition rejected."), '任务状态变更被拒绝。'));
					statusErrEl.textContent = detail;
					statusErrEl.hidden = false;
					host.clampToViewport(bodyRect, anchorRect, 8);
					return;
				}
			}
			// If `showInlineError` was synchronously invoked inside `onSetTaskStatus`, keep open so user sees why
			if (!statusErrEl.hidden && statusErrEl.textContent) {
				host.clampToViewport(bodyRect, anchorRect, 8);
				return;
			}
			host.close('dismiss');
		}, err => {
			if (openGen !== host.getPopoverGeneration()) {
				return;
			}
			toggleBtn.disabled = false;
			statusErrEl.textContent = err instanceof Error ? err.message : String(err);
			statusErrEl.hidden = false;
			host.clampToViewport(bodyRect, anchorRect, 8);
		});
	}));

	host.clampToViewport(bodyRect, anchorRect, 8);

	if (merged.focusSection === 'contract' && contractBoxEl) {
		contractBoxEl.classList.add('is-focused-section');
		contractBoxEl.scrollIntoView({ block: 'nearest' });
	} else if (merged.focusSection === 'checks' && receiptBoxEl) {
		receiptBoxEl.classList.add('is-focused-section');
		receiptBoxEl.scrollIntoView({ block: 'nearest' });
	} else {
		descTextarea.focus();
	}
}

/**
 * Renders the enriched Orchestration View Department Whiteboard Live Viewer & Editor Popover:
 * - Version, character/line counters, `updatedByLabel` & relative timestamp
 * - Interactive Markdown heading TOC bar (`.ade-pop-wb-toc` / `.ade-pop-wb-toc-chip`) jumping directly to `startLine`
 * - Non-destructive external version bump detection (`getLatestVersion`) before saving
 */
export function renderWhiteboardDetailPopover(
	host: IMissionDetailPopoverHost,
	whiteboard: IOrchestrationWhiteboard,
	anchorEl: HTMLElement,
	onSave: (patch: { readonly title: string; readonly department: string; readonly content: string }) => void,
	options?: IWhiteboardEditorPopoverOptions,
): void {
	host.close('dismiss');
	const openGen = host.getPopoverGeneration();
	host.popoverEl.classList.add('is-prompt-popover');
	host.popoverEl.dataset.popoverKind = 'whiteboard';
	host.popoverEl.dataset.popoverNodeId = whiteboard.id;

	const { bodyRect, anchorRect } = host.positionNear(anchorEl, 440, 390, 8);
	host.popoverDisposables.add(addDisposableListener(host.popoverEl, EventType.POINTER_DOWN, e => e.stopPropagation()));

	const head = append(host.popoverEl, $('.ade-mission-token-insp-head'));
	const left = append(head, $('.ade-mission-task-pop-head-left'));
	const deptChipEl = append(left, $('span.ade-orch-wb-dept-chip', {}, whiteboard.department));
	const titleEl = append(left, $('.ade-mission-emp-popover-title', {}, `${whiteboard.title} (v${whiteboard.version})`));
	const closeBtn = append(head, $('button.ade-mission-icon-btn', {
		type: 'button',
		title: adeBi(localize('adeMissionClose', "Close"), '关闭'),
		'aria-label': adeBi(localize('adeMissionClose', "Close"), '关闭'),
	})) as HTMLButtonElement;
	closeBtn.appendChild($('span.codicon.codicon-close'));
	host.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => host.close('dismiss')));

	append(host.popoverEl, $('.ade-mission-task-pop-meta', {}, adeBi(
		localize('adeWbPointerNote', "Shared department whiteboard · Tokens pass lightweight pointer `{0}` only", whiteboard.id),
		'部门共享白板 · 令牌流转仅携带轻量指针「{0}」，不直接塞入全文',
		whiteboard.id,
	)));

	const statsMetaEl = append(host.popoverEl, $('.ade-mission-task-pop-meta', {
		'data-ade-wb-stats-meta': 'true',
	}));
	let currentVersion = whiteboard.version;
	let currentAuthor = options?.updatedByLabel ?? whiteboard.updatedByLabel ?? whiteboard.updatedBy;
	let currentUpdatedAt = options?.updatedAt ?? whiteboard.updatedAt;
	const syncStatsMeta = (text: string) => {
		const chars = text.length;
		const lines = text ? text.split(/\r?\n/).length : 0;
		const age = formatCompactRelativeAge(currentUpdatedAt);
		const byPart = currentAuthor ? ` · ${currentAuthor}` : '';
		const agePart = age ? ` · ${age}` : '';
		statsMetaEl.textContent = adeBi(
			localize('adeWbMetaStats', "v{0} · {1} chars · {2} lines{3}{4}", currentVersion, chars, lines, byPart, agePart),
			'v{0} · {1} 字符 · {2} 行{3}{4}',
			currentVersion,
			chars,
			lines,
			byPart,
			agePart,
		);
	};

	// Interactive Markdown Section TOC bar (`.ade-pop-wb-toc` / `.ade-pop-wb-toc-chip`)
	const tocBarEl = append(host.popoverEl, $('.ade-pop-wb-toc', {
		'data-ade-pop-wb-toc': 'true',
	}));
	const tocDisposables = host.popoverDisposables.add(new DisposableStore());

	const contentArea = append(host.popoverEl, $('textarea.ade-mission-node-prompt-popover-input', {
		rows: '9',
		spellcheck: 'false',
		placeholder: adeBi(
			localize('adeWbContentPh', "Write shared department specs, API contracts, decisions, and notes (Markdown)…"),
			'在此沉淀部门共享规范、接口约定、结论与上下文（支持 Markdown）…',
		),
		'data-ade-whiteboard-content-input': whiteboard.id,
	})) as HTMLTextAreaElement;
	contentArea.value = whiteboard.content;

	const jumpTextareaToLine = (oneBasedLine: number) => {
		const text = contentArea.value;
		const lines = text.split('\n');
		const targetIdx = Math.max(0, Math.min(lines.length - 1, oneBasedLine - 1));
		let startOffset = 0;
		for (let i = 0; i < targetIdx; i++) {
			startOffset += lines[i].length + 1;
		}
		const endOffset = startOffset + (lines[targetIdx]?.length ?? 0);
		contentArea.focus();
		contentArea.setSelectionRange(startOffset, endOffset);
		const totalLines = Math.max(1, lines.length);
		const approxLineHeight = contentArea.scrollHeight / totalLines;
		contentArea.scrollTop = Math.max(0, Math.round(targetIdx * approxLineHeight - 16));
	};

	const rebuildToc = (text: string) => {
		tocDisposables.clear();
		clearNode(tocBarEl);
		const sections = parseWhiteboardSections(text);
		if (sections.length === 0) {
			tocBarEl.hidden = true;
			return sections;
		}
		tocBarEl.hidden = false;
		for (const sec of sections) {
			const prefix = sec.level > 2 ? '· ' : '§ ';
			const chip = append(tocBarEl, $('button.ade-pop-wb-toc-chip', {
				type: 'button',
				'data-wb-section-slug': sec.slug,
				'data-wb-section-line': String(sec.startLine),
				title: `L${sec.startLine}–L${sec.endLine} (${sec.chars}c)`,
			}, `${prefix}${sec.title}`)) as HTMLButtonElement;
			tocDisposables.add(addDisposableListener(chip, EventType.CLICK, () => {
				jumpTextareaToLine(sec.startLine);
			}));
		}
		return sections;
	};

	syncStatsMeta(contentArea.value);
	const initialSections = rebuildToc(contentArea.value);

	if (options?.onChangeColor) {
		host.renderNodeColorPickerSection(host.popoverEl, options.currentColor, options.onChangeColor, { compact: true });
	}

	const conflictBannerEl = append(host.popoverEl, $('.ade-mission-drawer-status.error', {
		hidden: 'true',
		'data-ade-wb-conflict-banner': 'true',
	}));
	const conflictDisposables = host.popoverDisposables.add(new DisposableStore());

	let acknowledgedVersion = whiteboard.version;
	const checkExternalUpdate = (): number | undefined => {
		const latestWb = options?.getLatestWhiteboard?.();
		const latestVer = options?.getLatestVersion?.() ?? latestWb?.version;
		if (latestVer !== undefined && latestVer > acknowledgedVersion) {
			conflictDisposables.clear();
			clearNode(conflictBannerEl);
			append(conflictBannerEl, $('span', {}, adeBi(
				localize('adeWbExternalUpdateWarn', "Whiteboard updated externally to v{0}. Click Save again to overwrite with your buffer.", latestVer),
				'白板已被其他成员更新至 v{0}；再次点击保存将以当前编辑内容覆盖。',
				latestVer,
			)));
			if (latestWb) {
				const reloadBtn = append(conflictBannerEl, $('button.ade-mission-token-trace-btn', {
					type: 'button',
					'data-ade-wb-reload-external': 'true',
				}, adeBi(localize('adeWbReloadLatestBtn', "Reload v{0}", latestVer), '加载最新 v{0}', latestVer))) as HTMLButtonElement;
				conflictDisposables.add(addDisposableListener(reloadBtn, EventType.CLICK, () => {
					const fresh = options?.getLatestWhiteboard?.() ?? latestWb;
					currentVersion = fresh.version;
					acknowledgedVersion = fresh.version;
					currentAuthor = fresh.updatedByLabel ?? fresh.updatedBy ?? currentAuthor;
					currentUpdatedAt = fresh.updatedAt ?? currentUpdatedAt;
					deptChipEl.textContent = fresh.department;
					titleEl.textContent = `${fresh.title} (v${currentVersion})`;
					contentArea.value = fresh.content;
					conflictBannerEl.hidden = true;
					syncStatsMeta(contentArea.value);
					rebuildToc(contentArea.value);
					host.clampToViewport(bodyRect, anchorRect, 8);
				}));
			}
			conflictBannerEl.hidden = false;
			host.clampToViewport(bodyRect, anchorRect, 8);
			return latestVer;
		}
		return undefined;
	};

	host.popoverDisposables.add(addDisposableListener(contentArea, EventType.INPUT, () => {
		syncStatsMeta(contentArea.value);
		rebuildToc(contentArea.value);
	}));
	host.popoverDisposables.add(addDisposableListener(contentArea, EventType.FOCUS, () => {
		if (openGen === host.getPopoverGeneration()) {
			checkExternalUpdate();
		}
	}));

	const actions = append(host.popoverEl, $('.ade-mission-token-actions'));
	const saveBtn = append(actions, $('button.ade-mission-token-action-btn.primary', {
		type: 'button',
		'data-ade-whiteboard-save': whiteboard.id,
	}, adeBi(localize('adeWbSaveBtn', "Save Whiteboard"), '保存白板'))) as HTMLButtonElement;

	const commit = () => {
		const newerVer = checkExternalUpdate();
		if (newerVer !== undefined) {
			acknowledgedVersion = newerVer;
			return;
		}
		const latestWb = options?.getLatestWhiteboard?.();
		onSave({
			title: latestWb?.title ?? whiteboard.title,
			department: latestWb?.department ?? whiteboard.department,
			content: contentArea.value,
		});
		host.close('dismiss');
	};
	host.popoverDisposables.add(addDisposableListener(saveBtn, EventType.CLICK, commit));
	host.popoverDisposables.add(addDisposableListener(contentArea, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		e.stopPropagation();
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			commit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			host.close('escape');
		}
	}));

	host.clampToViewport(bodyRect, anchorRect, 8);
	if (options?.initialSection && initialSections.length > 0) {
		const needle = options.initialSection.trim().replace(/^#+\s*/, '').toLowerCase();
		const target = initialSections.find(s => s.slug === needle || s.title.toLowerCase() === needle)
			?? initialSections.find(s => s.title.toLowerCase().includes(needle) || s.slug.includes(needle));
		if (target) {
			jumpTextareaToLine(target.startLine);
			return;
		}
	}
	contentArea.focus();
}

/**
 * Renders the enriched Orchestration View Token Baton Inspector Popover:
 * - Multi-token switcher (`.ade-mission-token-wave-switcher`) when staff holds >1 baton
 * - Cross-view bound Task DAG chips (`↗ <taskId>`)
 * - 1Hz live Blocked Wait countdown (`⏳`) & Join Barrier SLA countdown (`⏱`)
 * - C5 Scope globs (`scopePaths`), `touchedFiles`, Join Barrier progress, `quorum`, `failFast`, and `fileConflicts` (`.ade-pop-barrier-box`, `.ade-pop-conflict-row`)
 * - C6 Rework Memory Ledger (`attemptNumber`, `reworkCategory`, `reworkHistory` in `.ade-pop-rework-list`)
 * - Lazy on-demand pointer preview (`[data-ade-ptr-preview="true"]` strictly `hidden` until user clicks a pointer!)
 */
export function renderOrchestrationTokenDetailPopover(
	host: IMissionDetailPopoverHost,
	staffLabel: string,
	initialToken: IOrchestrationToken,
	anchorEl: HTMLElement,
	callbacks?: IOrchestrationTokenPopoverOptions,
	extraOptions?: IOrchestrationTokenPopoverOptions,
): void {
	const opts: IOrchestrationTokenPopoverOptions = extraOptions
		? { ...callbacks, ...extraOptions }
		: (callbacks ?? {});

	host.close('dismiss');
	host.popoverEl.classList.add('is-token-popover');
	host.popoverEl.dataset.popoverKind = 'orch-token';
	host.popoverEl.dataset.popoverTokenId = initialToken.id;

	const { bodyRect, anchorRect } = host.positionNear(anchorEl, 412, 420, 6);
	host.popoverDisposables.add(addDisposableListener(host.popoverEl, EventType.POINTER_DOWN, e => e.stopPropagation()));

	const allTokens = opts.allStaffTokens && opts.allStaffTokens.length > 0
		? opts.allStaffTokens
		: [initialToken];
	let selectedToken: IOrchestrationToken = allTokens.find(t => t.id === initialToken.id) ?? initialToken;

	const contentDisposables = host.popoverDisposables.add(new DisposableStore());
	const contentRoot = append(host.popoverEl, $('.ade-orch-token-pop-root'));

	const resolveBarrierForToken = (tok: IOrchestrationToken, orchState?: IOrchestrationRuntimeState): IOrchestrationJoinBarrier | undefined => {
		if (tok.id === initialToken.id && opts.joinBarrier) {
			const liveId = opts.joinBarrier.id;
			return orchState?.joinBarriers?.[liveId] ?? opts.joinBarriers?.[liveId] ?? opts.joinBarrier;
		}
		const barrierId = tok.joinBarrierId ?? tok.parentJoinBarrierId;
		if (!barrierId) {
			return undefined;
		}
		return orchState?.joinBarriers?.[barrierId] ?? opts.joinBarriers?.[barrierId];
	};

	const resolveDeltaForToken = (tok: IOrchestrationToken): IOrchestrationTokenDeltaView | undefined => {
		if (opts.getDeltaForToken) {
			return opts.getDeltaForToken(tok);
		}
		if (tok.id === initialToken.id && opts.delta) {
			return opts.delta;
		}
		const missionId = tok.missionId ?? host.getActiveMissionId();
		return host.resolveOrchestrationTokenDelta?.(missionId, tok.id);
	};

	const renderSelected = (applyInitialFocusSection: boolean): void => {
		contentDisposables.clear();
		clearNode(contentRoot);

		let liveBlockedCdEl: HTMLElement | undefined;
		let liveBarrierCdEl: HTMLElement | undefined;

		const missionId = selectedToken.missionId ?? host.getActiveMissionId();
		const liveOrch = host.resolveOrchestrationState?.(missionId);
		selectedToken = liveOrch?.tokens[selectedToken.id] ?? selectedToken;
		host.popoverEl.dataset.popoverTokenId = selectedToken.id;

		const delta = resolveDeltaForToken(selectedToken);
		const barrier = resolveBarrierForToken(selectedToken, liveOrch);

		const hopNum = selectedToken.hopIndex ?? Math.max(0, (selectedToken.hopLog?.length ?? 1) - 1);
		const head = append(contentRoot, $('.ade-mission-token-insp-head'));
		append(head, $('.ade-mission-emp-popover-title', {}, `${selectedToken.id} · Hop #${hopNum} · ${staffLabel}`));
		const closeBtn = append(head, $('button.ade-mission-icon-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionClose', "Close"), '关闭'),
			'aria-label': adeBi(localize('adeMissionClose', "Close"), '关闭'),
		})) as HTMLButtonElement;
		closeBtn.appendChild($('span.codicon.codicon-close'));
		contentDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => host.close('dismiss')));

		// Multi-token wave/baton switcher when staff holds >1 baton
		if (allTokens.length > 1) {
			const switcher = append(contentRoot, $('.ade-mission-token-wave-switcher', {
				'data-ade-orch-token-switcher': 'true',
			}));
			for (const tok of allTokens) {
				const liveTok = liveOrch?.tokens[tok.id] ?? tok;
				const isSelected = liveTok.id === selectedToken.id;
				const pill = append(switcher, $(`button.ade-mission-token-wave-btn${isSelected ? '.active' : ''}.status-${toSafeCssSlug(liveTok.status)}`, {
					type: 'button',
					'data-ade-orch-token-select': liveTok.id,
				}, `${formatMissionWaveTag(liveTok.waveId)} · ${liveTok.id} · ${liveTok.status}`)) as HTMLButtonElement;
				contentDisposables.add(addDisposableListener(pill, EventType.CLICK, () => {
					const freshOrch = host.resolveOrchestrationState?.(liveTok.missionId ?? host.getActiveMissionId());
					selectedToken = freshOrch?.tokens[liveTok.id] ?? liveTok;
					renderSelected(false);
				}));
			}
		}

		// Metadata line + Bound Task DAG jump chips
		const fromPart = selectedToken.fromNodeId
			? ` · ${adeBi(localize('adeOrchTokenFromNode', "from {0}", selectedToken.fromNodeId), '来自 {0}', selectedToken.fromNodeId)}`
			: '';
		const reminderPart = selectedToken.nudgeCount > 0
			? ` · ${adeBi(localize('adeOrchTokenReminders', "{0}× 5m reminder", selectedToken.nudgeCount), '5分钟催办 {0} 次', selectedToken.nudgeCount)}`
			: '';
		const attemptSuffix = (selectedToken.attemptNumber ?? 1) > 1
			? ` · ${adeBi(localize('adeOrchTokenAttemptTag', "Attempt #{0}", selectedToken.attemptNumber), '第 {0} 次尝试', selectedToken.attemptNumber)}`
			: '';
		append(contentRoot, $('.ade-mission-task-pop-meta', {},
			`${selectedToken.waveId} · ${selectedToken.status}${fromPart}${reminderPart}${attemptSuffix}`,
		));

		const taskIds = selectedToken.taskNodeIds && selectedToken.taskNodeIds.length > 0
			? selectedToken.taskNodeIds
			: (selectedToken.taskNodeId ? [selectedToken.taskNodeId] : []);
		if (taskIds.length > 0) {
			const taskRow = append(contentRoot, $('.ade-mission-token-meta-row', {
				'data-ade-orch-bound-tasks': 'true',
			}));
			for (const taskId of taskIds) {
				if (opts.onJumpToTask) {
					const tBtn = append(taskRow, $('button.ade-mission-token-trace-btn', {
						type: 'button',
						'data-ade-jump-task': taskId,
						title: adeBi(localize('adeOrchJumpTaskTip', "Switch to Mission View and focus task {0}", taskId), '切换至任务视图并定位任务 {0}', taskId),
					}, `↗ ${taskId}`)) as HTMLButtonElement;
					contentDisposables.add(addDisposableListener(tBtn, EventType.CLICK, () => {
						host.close('dismiss');
						opts.onJumpToTask?.(taskId);
					}));
				} else {
					append(taskRow, $('span.ade-mission-token-meta-chip', {}, `🎯 ${taskId}`));
				}
			}
		}

		if (delta?.isReentrantVisit) {
			append(contentRoot, $('.ade-orch-token-delta-bar', { 'data-ade-orch-delta-bar': 'true' }, adeBi(
				localize(
					'adeOrchDeltaBanner',
					"Cyclic Re-entry · Delta since Hop #{0}: {1} new/updated ptr · {2} unchanged collapsed",
					delta.lastSeenHop ?? 0,
					delta.newOrUpdatedRefs.length,
					delta.unchangedRefs.length,
				),
				'环路重入 · 增量游标（自 Hop #{0}）：{1} 个新增/变更指针 · {2} 个已读折叠去重',
				delta.lastSeenHop ?? 0,
				delta.newOrUpdatedRefs.length,
				delta.unchangedRefs.length,
			)));
		}

		// Live 1Hz Blocked Wait Box
		if (selectedToken.status === 'blocked' && selectedToken.blocked) {
			const b = selectedToken.blocked;
			const rem = formatMissionBlockedRemaining(b.expiresAt, Date.now());
			const blockedBox = append(contentRoot, $('.ade-mission-token-box.is-blocked', {
				'data-ade-token-blocked-box': 'true',
			}));
			const bHead = append(blockedBox, $('.ade-mission-token-box-head'));
			append(bHead, $('span.ade-mission-token-box-label', {}, adeBi(localize('adeOrchBlockedLabel', "Blocked Wait"), '阻塞等待中')));
			liveBlockedCdEl = append(bHead, $(`span.ade-mission-token-countdown${rem.isOverdue ? '.is-overdue' : ''}`, {
				'data-ade-inspector-countdown': 'true',
			}, `⏳ ${rem.text}`));
			append(blockedBox, $('.ade-mission-token-box-body', {}, b.reason));
			const watchRow = append(blockedBox, $('.ade-mission-token-watch-row'));
			if (b.watchPid !== undefined) {
				append(watchRow, $('span.ade-mission-token-meta-chip.pid', { 'data-ade-inspector-pid': String(b.watchPid) }, `PID ${b.watchPid}`));
			}
			if (b.watchFile) {
				append(watchRow, $('span.ade-mission-token-meta-chip.file', { title: b.watchFile, 'data-ade-inspector-file': b.watchFile }, b.watchFile));
			}
			if (b.hostAlias) {
				append(watchRow, $('span.ade-mission-token-meta-chip', {}, `@${b.hostAlias}`));
			}
		}

		// Headline summary box
		const box = append(contentRoot, $('.ade-mission-token-box'));
		append(box, $('.ade-mission-token-box-body', {}, selectedToken.lastSummary || adeBi(localize('adeOrchNoHeadline', "(No headline)"), '（暂无摘要）')));

		// Lazy on-demand pointer preview pane (MUST remain hidden until user clicks a pointer!)
		const previewBox = append(contentRoot, $('.ade-orch-ptr-preview', { 'data-ade-ptr-preview': 'true' }));
		previewBox.hidden = true;
		const previewHead = append(previewBox, $('.ade-orch-ptr-preview-head'));
		const previewTitle = append(previewHead, $('span.ade-orch-ptr-preview-title'));
		const previewHideBtn = append(previewHead, $('button.ade-mission-icon-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionClose', "Close"), '关闭'),
			'aria-label': adeBi(localize('adeMissionClose', "Close"), '关闭'),
		})) as HTMLButtonElement;
		previewHideBtn.appendChild($('span.codicon.codicon-close'));
		contentDisposables.add(addDisposableListener(previewHideBtn, EventType.CLICK, () => {
			previewBox.hidden = true;
		}));
		const previewBody = append(previewBox, $('pre.ade-orch-ptr-preview-body'));

		const inspectPointer = (ptr: string) => {
			const res = opts.onReadPointer?.(ptr, selectedToken.id);
			if (!res) {
				return;
			}
			previewTitle.textContent = res.title ? `${ptr} · ${res.title}` : ptr;
			previewBody.textContent = res.error ? res.error : (res.content ?? adeBi(localize('adePopEmptyContent', "(empty)"), '（空）'));
			previewBox.hidden = false;
			host.clampToViewport(bodyRect, anchorRect, 6);
		};

		// C5 Scope Globs, Touched Files & Join Barrier SLA / File Conflicts Box (`.ade-pop-barrier-box`)
		let barrierOrScopeBoxEl: HTMLElement | undefined;
		const hasScopeOrFiles = Boolean((selectedToken.scopePaths && selectedToken.scopePaths.length > 0) || (selectedToken.touchedFiles && selectedToken.touchedFiles.length > 0));
		if (barrier || hasScopeOrFiles) {
			barrierOrScopeBoxEl = append(contentRoot, $('.ade-pop-barrier-box', {
				'data-ade-pop-barrier-box': 'true',
			}));
			if (hasScopeOrFiles) {
				append(barrierOrScopeBoxEl, $('.ade-mission-task-pop-label', {}, adeBi(
					localize('adeOrchScopeCardLabel', "Write Scope & Touched Files"),
					'并行写入隔离域与变更文件',
				)));
				const scopeRow = append(barrierOrScopeBoxEl, $('.ade-mission-token-meta-row'));
				for (const glob of selectedToken.scopePaths ?? []) {
					append(scopeRow, $('span.ade-mission-token-meta-chip', { title: glob }, `🔒 ${glob}`));
				}
				for (const tf of (selectedToken.touchedFiles ?? []).slice(0, 6)) {
					append(scopeRow, $('span.ade-mission-token-meta-chip.file', { title: tf }, `◫ ${tf}`));
				}
				if ((selectedToken.touchedFiles?.length ?? 0) > 6) {
					append(scopeRow, $('span.ade-mission-token-meta-chip', {}, `+${(selectedToken.touchedFiles?.length ?? 0) - 6}`));
				}
			}
			if (barrier) {
				const settledEntries = Object.values(barrier.settledChildren);
				const totalChildren = barrier.childTokenIds.length;
				const modeLabel = barrier.mode === 'quorum'
					? `quorum ${barrier.quorumCount ?? totalChildren}/${totalChildren}`
					: barrier.mode;
				const barHead = append(barrierOrScopeBoxEl, $('.ade-mission-ni-section-head'));
				append(barHead, $('.ade-mission-task-pop-label', {}, adeBi(
					localize('adeOrchBarrierHeadLabel', "Join Barrier · {0}/{1} ({2})", settledEntries.length, totalChildren, modeLabel),
					'并发汇合屏障 · {0}/{1} ({2})',
					settledEntries.length,
					totalChildren,
					modeLabel,
				)));
				const barChips = append(barrierOrScopeBoxEl, $('.ade-mission-token-meta-row'));
				append(barChips, $(`span.ade-mission-token-meta-chip.${barrier.status === 'satisfied' ? 'ok' : barrier.status === 'aborted' ? 'danger' : 'wave'}`, {}, barrier.status));
				if (barrier.failFast) {
					append(barChips, $('span.ade-mission-token-meta-chip.warn', {}, '⚡ failFast'));
				}
				if (barrier.timedOut) {
					append(barChips, $('span.ade-mission-token-meta-chip.danger', {}, adeBi(localize('adeOrchBarrierTimedOut', "TIMED OUT"), '已超时收敛')));
				} else if (barrier.deadlineAt !== undefined && barrier.status === 'waiting') {
					const rem = formatMissionBlockedRemaining(barrier.deadlineAt, Date.now());
					liveBarrierCdEl = append(barChips, $(`span.ade-mission-token-countdown${rem.isOverdue ? '.is-overdue' : ''}`, {
						'data-ade-barrier-countdown': 'true',
					}, `⏱ ${rem.text}`));
				}
				if (barrier.scopeOverlapWarnings && barrier.scopeOverlapWarnings.length > 0) {
					for (const warn of barrier.scopeOverlapWarnings) {
						append(barrierOrScopeBoxEl, $('.ade-mission-task-pop-meta', {}, `⚠ ${warn}`));
					}
				}
				if (barrier.childTokenIds.length > 0) {
					for (const childId of barrier.childTokenIds) {
						const settled = barrier.settledChildren[childId];
						const childRow = append(barrierOrScopeBoxEl, $('.ade-orch-hop-row', {
							'data-ade-barrier-child': childId,
						}));
						if (settled) {
							const okOutcome = settled.outcome === 'returned' || settled.outcome === 'completed';
							const glyph = okOutcome ? '✓' : '✕';
							append(childRow, $('span.ade-orch-hop-route', {}, `${glyph} ${settled.fromNodeId} · ${settled.outcome}`));
							if (settled.summary) {
								append(childRow, $('span.ade-orch-hop-headline', {}, settled.summary));
							}
							if (settled.payloadPtr) {
								const childPtrBtn = append(childRow, $('button.ade-orch-hop-ptr-btn', {
									type: 'button',
									'data-ade-hop-ptr': settled.payloadPtr,
								}, settled.payloadPtr)) as HTMLButtonElement;
								contentDisposables.add(addDisposableListener(childPtrBtn, EventType.CLICK, () => {
									inspectPointer(settled.payloadPtr!);
								}));
							}
						} else {
							const pendingTok = liveOrch?.tokens[childId];
							const holderTag = pendingTok?.nodeId ? `${pendingTok.nodeId} (${childId})` : childId;
							append(childRow, $('span.ade-orch-hop-route', {}, `◌ ${holderTag}`));
							append(childRow, $('span.ade-orch-hop-headline', {}, adeBi(
								localize('adeOrchBarrierChildPending', "pending"),
								'等待汇合',
							)));
						}
					}
				}
				if (barrier.fileConflicts && barrier.fileConflicts.length > 0) {
					for (const conflict of barrier.fileConflicts) {
						append(barrierOrScopeBoxEl, $('.ade-pop-conflict-row', {
							'data-ade-barrier-conflict-path': conflict.path,
						}, `⚠ ${conflict.path} — ${conflict.tokenIds.join(' × ')} (${conflict.fromNodeIds.join(', ')})`));
					}
				}
			}
		}

		// C6 Rework Memory Ledger (`.ade-pop-rework-list`)
		let reworkListEl: HTMLElement | undefined;
		const reworkHistory = selectedToken.reworkHistory ?? [];
		if (reworkHistory.length > 0 || selectedToken.reworkCategory || (selectedToken.attemptNumber ?? 1) > 1) {
			reworkListEl = append(contentRoot, $('.ade-pop-rework-list', {
				'data-ade-pop-rework-list': 'true',
			}));
			const rwHead = append(reworkListEl, $('.ade-mission-token-meta-row'));
			append(rwHead, $('.ade-mission-task-pop-label', {}, adeBi(
				localize('adeOrchReworkLedgerLabel', "Rework Memory Ledger"),
				'返工记忆台账',
			)));
			if ((selectedToken.attemptNumber ?? 1) > 1) {
				append(rwHead, $('span.ade-mission-token-meta-chip.rework', {}, `#${selectedToken.attemptNumber}`));
			}
			if (selectedToken.reworkCategory) {
				append(rwHead, $('span.ade-mission-token-meta-chip.warn', {}, selectedToken.reworkCategory));
			}
			for (const rw of reworkHistory) {
				const row = append(reworkListEl, $('.ade-orch-hop-row', {
					'data-rework-attempt': String(rw.attempt),
				}));
				const catTag = rw.category ? ` [${rw.category}]` : '';
				append(row, $('span.ade-orch-hop-route', {}, `#${rw.attempt} ${rw.kind} · ${rw.byNodeId}${catTag}`));
				append(row, $('span.ade-orch-hop-headline', {}, rw.summary));
				if (rw.payloadPtr) {
					const rwPtrBtn = append(row, $('button.ade-orch-hop-ptr-btn', {
						type: 'button',
						'data-ade-hop-ptr': rw.payloadPtr,
					}, rw.payloadPtr)) as HTMLButtonElement;
					contentDisposables.add(addDisposableListener(rwPtrBtn, EventType.CLICK, () => {
						inspectPointer(rw.payloadPtr!);
					}));
				}
			}
		}

		// Typed split context pointers (Whiteboards, Per-Hop Details, Artifacts, Decisions) — ZERO body pre-loaded!
		const refs = selectedToken.contextRefs ?? [];
		const legacyWbs = refs.length === 0 ? (selectedToken.whiteboardPointers ?? []) : [];
		const unchangedPtrSet = new Set((delta?.unchangedRefs ?? []).map(r => r.ptr));
		const newOrUpdatedPtrSet = new Set((delta?.newOrUpdatedRefs ?? []).map(r => r.ptr));
		if (refs.length > 0 || legacyWbs.length > 0) {
			const ptrWrap = append(contentRoot, $('.ade-orch-token-pointers', { 'data-ade-orch-context-refs': 'true' }));
			append(ptrWrap, $('.ade-mission-task-pop-label', {}, adeBi(
				localize('adeOrchCtxPtrsLabel', "Context Pointers (Click to Load On Demand)"),
				'携带的上下文指针（按需点击展开）',
			)));
			const orderedRefs = delta?.isReentrantVisit
				? [...refs.filter(r => !unchangedPtrSet.has(r.ptr)), ...refs.filter(r => unchangedPtrSet.has(r.ptr))]
				: refs;
			for (const ref of orderedRefs) {
				const isWb = ref.kind === 'whiteboard';
				const wbId = isWb ? (ref.ptr.startsWith('wb:') ? ref.ptr.slice(3) : ref.ptr) : undefined;
				const kindTag = ref.kind === 'whiteboard' ? '📋' : ref.kind === 'artifact' ? '📦' : ref.kind === 'decision' ? '🧭' : '📝';
				const sizeTag = ref.sizeChars > 0 ? ` · ${ref.sizeChars}c` : '';
				const isSeen = Boolean(delta?.isReentrantVisit && unchangedPtrSet.has(ref.ptr));
				const isNewDelta = Boolean(delta?.isReentrantVisit && newOrUpdatedPtrSet.has(ref.ptr));
				const deltaTag = isNewDelta ? ' [NEW]' : isSeen ? ' [SEEN]' : '';
				const btn = append(ptrWrap, $(`button.ade-mission-emp-popover-item.ade-orch-ptr-chip${isSeen ? '.is-seen' : ''}${isNewDelta ? '.is-delta-new' : ''}`, {
					type: 'button',
					'data-ade-context-ptr': ref.ptr,
					'data-ptr-kind': ref.kind,
					...(wbId ? { 'data-ade-wb-pointer': wbId } : {}),
				}, `${kindTag} ${ref.ptr} · ${ref.title} (v${ref.version}${sizeTag})${deltaTag}`)) as HTMLButtonElement;
				contentDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
					if (isWb && wbId) {
						host.close('dismiss');
						opts.onOpenWhiteboard?.(wbId);
					} else {
						inspectPointer(ref.ptr);
					}
				}));
			}
			for (const ptr of legacyWbs) {
				const btn = append(ptrWrap, $('button.ade-mission-emp-popover-item.ade-orch-ptr-chip', {
					type: 'button',
					'data-ade-wb-pointer': ptr.whiteboardId,
				}, `📋 [${ptr.department}] ${ptr.title} (v${ptr.version})`)) as HTMLButtonElement;
				contentDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
					host.close('dismiss');
					opts.onOpenWhiteboard?.(ptr.whiteboardId);
				}));
			}
		}

		// Compact Pass History Trail (hop-by-hop pointers)
		const hopLog = selectedToken.hopLog ?? [];
		const earlierHopSet = new Set((delta?.earlierHops ?? []).map(h => `${h.tokenId}:${h.hop}`));
		if (hopLog.length > 0) {
			const histWrap = append(contentRoot, $('.ade-orch-hop-history', { 'data-ade-orch-hop-history': 'true' }));
			append(histWrap, $('.ade-mission-task-pop-label', {}, adeBi(
				localize('adeOrchHopHistoryLabel', "Pass History ({0} hops)", hopLog.length),
				'历史传递记录（{0} 跳）',
				hopLog.length,
			)));
			for (const entry of hopLog) {
				const isSeenHop = Boolean(delta?.isReentrantVisit && earlierHopSet.has(`${entry.tokenId}:${entry.hop}`));
				const row = append(histWrap, $(`.ade-orch-hop-row${isSeenHop ? '.is-seen' : ''}`, { 'data-hop-index': String(entry.hop) }));
				const route = entry.fromNodeId ? `${entry.fromNodeId} → ${entry.toNodeId}` : `User → ${entry.toNodeId}`;
				append(row, $('span.ade-orch-hop-route', {}, `#${entry.hop} ${route}`));
				append(row, $('span.ade-orch-hop-headline', {}, entry.headline));
				if (entry.payloadPtr) {
					const ptrBtn = append(row, $('button.ade-orch-hop-ptr-btn', {
						type: 'button',
						'data-ade-hop-ptr': entry.payloadPtr,
					}, entry.payloadPtr)) as HTMLButtonElement;
					contentDisposables.add(addDisposableListener(ptrBtn, EventType.CLICK, () => {
						inspectPointer(entry.payloadPtr!);
					}));
				}
			}
		}

		// Register 1Hz live countdown updater for both Blocked Wait and Join Barrier SLA
		if (liveBlockedCdEl || liveBarrierCdEl) {
			host.setOrchCountdownUpdater((now, latestOrch) => {
				const liveTok = latestOrch?.tokens[selectedToken.id] ?? selectedToken;
				if (liveBlockedCdEl && liveTok.status === 'blocked' && liveTok.blocked) {
					const rem = formatMissionBlockedRemaining(liveTok.blocked.expiresAt, now);
					const txt = `⏳ ${rem.text}`;
					if (liveBlockedCdEl.textContent !== txt) {
						liveBlockedCdEl.textContent = txt;
					}
					liveBlockedCdEl.classList.toggle('is-overdue', rem.isOverdue);
				}
				const liveBar = resolveBarrierForToken(liveTok, latestOrch);
				if (liveBarrierCdEl && liveBar) {
					if (!liveBar.timedOut && liveBar.status === 'waiting' && liveBar.deadlineAt !== undefined) {
						const rem = formatMissionBlockedRemaining(liveBar.deadlineAt, now);
						const txt = `⏱ ${rem.text}`;
						if (liveBarrierCdEl.textContent !== txt) {
							liveBarrierCdEl.textContent = txt;
						}
						liveBarrierCdEl.classList.toggle('is-overdue', rem.isOverdue);
					} else if (liveBar.timedOut) {
						const timedOutTxt = adeBi(localize('adeOrchBarrierTimedOut', "TIMED OUT"), '已超时收敛');
						if (liveBarrierCdEl.textContent !== timedOutTxt) {
							liveBarrierCdEl.textContent = timedOutTxt;
						}
						liveBarrierCdEl.classList.add('is-overdue');
					} else {
						const doneTxt = `✓ ${liveBar.status}`;
						if (liveBarrierCdEl.textContent !== doneTxt) {
							liveBarrierCdEl.textContent = doneTxt;
						}
						liveBarrierCdEl.classList.remove('is-overdue');
					}
				}
			});
		} else {
			host.setOrchCountdownUpdater(undefined);
		}

		host.clampToViewport(bodyRect, anchorRect, 6);

		if (applyInitialFocusSection && opts.focusSection) {
			const targetEl = (opts.focusSection === 'barrier' || opts.focusSection === 'scope')
				? barrierOrScopeBoxEl
				: (opts.focusSection === 'rework' ? reworkListEl : undefined);
			if (targetEl) {
				targetEl.classList.add('is-focused-section');
				targetEl.scrollIntoView({ block: 'nearest' });
			}
		}
	};

	renderSelected(true);
}

export function renderAddStaffPopover(
	host: IMissionDetailPopoverHost,
	clientX: number,
	clientY: number,
	onCreate: (payload: { readonly name: string; readonly rankId: string; readonly tier: number; readonly department?: string }) => void,
	options?: {
		readonly title?: string;
		readonly submitLabel?: string;
		readonly minTier?: number;
		readonly defaultDepartment?: string;
		readonly subtitle?: string;
	},
): void {
	host.close('dismiss');
	host.bumpPopoverGeneration();
	host.popoverEl.classList.add('is-prompt-popover');
	host.popoverEl.dataset.popoverKind = 'add-staff';
	const bodyRect = host.positionAtClientPoint(clientX, clientY, 332, 260);
	host.popoverDisposables.add(addDisposableListener(host.popoverEl, EventType.POINTER_DOWN, e => e.stopPropagation()));

	const head = append(host.popoverEl, $('.ade-mission-token-insp-head'));
	append(head, $('.ade-mission-emp-popover-title', {}, options?.title ?? adeBi(localize('adeOrchAddStaffTitle', "New Staff Node"), '新建员工节点')));
	const closeBtn = append(head, $('button.ade-mission-icon-btn', {
		type: 'button',
		title: adeBi(localize('adeMissionClose', "Close"), '关闭'),
		'aria-label': adeBi(localize('adeMissionClose', "Close"), '关闭'),
	})) as HTMLButtonElement;
	closeBtn.appendChild($('span.codicon.codicon-close'));
	host.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => host.close('dismiss')));
	if (options?.subtitle) {
		append(host.popoverEl, $('.ade-mission-task-pop-meta', {}, options.subtitle));
	}

	const nameInput = append(host.popoverEl, $('input.ade-mission-task-pop-title-input', {
		type: 'text',
		placeholder: adeBi(localize('adeOrchAddStaffNamePh', "Unique employee name (e.g. Alice, BackendLead)…"), '唯一员工姓名（如 Alice、后端主程）…'),
		'data-ade-orch-staff-name': 'true',
	})) as HTMLInputElement;

	const org = host.getOrganizationConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
	const allRanks = [...org.ranks].sort((a, b) => a.tier - b.tier);
	const filteredRanks = options?.minTier !== undefined ? allRanks.filter(r => r.tier >= options.minTier!) : allRanks;
	const sortedRanks = filteredRanks.length > 0 ? filteredRanks : allRanks;
	const rankSelect = append(host.popoverEl, $('select.ade-mission-config-select.full', {
		'data-ade-orch-staff-rank': 'true',
	})) as HTMLSelectElement;
	for (const r of sortedRanks) {
		append(rankSelect, $('option', { value: `${r.id}:${r.tier}` }, `L${r.tier} · ${r.name}`));
	}

	const deptInput = append(host.popoverEl, $('input.ade-mission-task-pop-title-input', {
		type: 'text',
		value: options?.defaultDepartment ?? '',
		placeholder: adeBi(localize('adeOrchAddStaffDeptPh', "Department (optional, e.g. Backend, Frontend)…"), '所属部门（可选，如 Backend、Frontend）…'),
		'data-ade-orch-staff-dept': 'true',
	})) as HTMLInputElement;

	const actions = append(host.popoverEl, $('.ade-mission-token-actions'));
	const submitBtn = append(actions, $('button.ade-mission-token-action-btn.primary', {
		type: 'button',
		'data-ade-orch-staff-submit': 'true',
	}, options?.submitLabel ?? adeBi(localize('adeOrchAddStaffSubmit', "Create Staff"), '创建员工'))) as HTMLButtonElement;

	const doSubmit = () => {
		const name = nameInput.value.trim();
		if (!name) {
			nameInput.focus();
			return;
		}
		const [rankId, tierStr] = (rankSelect.value || `${sortedRanks[0]?.id ?? 'governor'}:1`).split(':');
		const tier = Number.parseInt(tierStr, 10) || 1;
		const department = deptInput.value.trim() || undefined;
		host.close('dismiss');
		onCreate({ name, rankId, tier, department });
	};
	host.popoverDisposables.add(addDisposableListener(submitBtn, EventType.CLICK, doSubmit));
	for (const inp of [nameInput, deptInput]) {
		host.popoverDisposables.add(addDisposableListener(inp, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				doSubmit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				host.close('escape');
			}
		}));
	}
	host.clampClientPointToViewport(bodyRect, clientX, clientY);
	nameInput.focus();
}

export function renderAddWhiteboardPopover(
	host: IMissionDetailPopoverHost,
	clientX: number,
	clientY: number,
	onCreate: (payload: { readonly department: string; readonly title: string }) => void,
	options?: { readonly defaultDepartment?: string },
): void {
	host.close('dismiss');
	host.bumpPopoverGeneration();
	host.popoverEl.classList.add('is-prompt-popover');
	host.popoverEl.dataset.popoverKind = 'add-whiteboard';
	const bodyRect = host.positionAtClientPoint(clientX, clientY, 332, 210);
	host.popoverDisposables.add(addDisposableListener(host.popoverEl, EventType.POINTER_DOWN, e => e.stopPropagation()));

	const head = append(host.popoverEl, $('.ade-mission-token-insp-head'));
	append(head, $('.ade-mission-emp-popover-title', {}, adeBi(localize('adeOrchAddWbTitle', "New Department Whiteboard"), '新建部门共享白板')));
	const closeBtn = append(head, $('button.ade-mission-icon-btn', {
		type: 'button',
		title: adeBi(localize('adeMissionClose', "Close"), '关闭'),
		'aria-label': adeBi(localize('adeMissionClose', "Close"), '关闭'),
	})) as HTMLButtonElement;
	closeBtn.appendChild($('span.codicon.codicon-close'));
	host.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => host.close('dismiss')));

	const deptInput = append(host.popoverEl, $('input.ade-mission-task-pop-title-input', {
		type: 'text',
		value: options?.defaultDepartment ?? '',
		placeholder: adeBi(localize('adeOrchAddWbDeptPh', "Department name (e.g. Backend, QA)…"), '部门名称（如 Backend、QA）…'),
		'data-ade-orch-wb-dept': 'true',
	})) as HTMLInputElement;
	const titleInput = append(host.popoverEl, $('input.ade-mission-task-pop-title-input', {
		type: 'text',
		placeholder: adeBi(localize('adeOrchAddWbTitlePh', "Whiteboard title (e.g. API Contract)…"), '白板标题（如 接口规范）…'),
		'data-ade-orch-wb-title': 'true',
	})) as HTMLInputElement;

	const actions = append(host.popoverEl, $('.ade-mission-token-actions'));
	const submitBtn = append(actions, $('button.ade-mission-token-action-btn.primary', {
		type: 'button',
		'data-ade-orch-wb-submit': 'true',
	}, adeBi(localize('adeOrchAddWbSubmit', "Create Whiteboard"), '创建白板'))) as HTMLButtonElement;

	const doSubmit = () => {
		const department = deptInput.value.trim() || 'General';
		const title = titleInput.value.trim() || `${department} Whiteboard`;
		host.close('dismiss');
		onCreate({ department, title });
	};
	host.popoverDisposables.add(addDisposableListener(submitBtn, EventType.CLICK, doSubmit));
	for (const inp of [deptInput, titleInput]) {
		host.popoverDisposables.add(addDisposableListener(inp, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				doSubmit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				host.close('escape');
			}
		}));
	}
	host.clampClientPointToViewport(bodyRect, clientX, clientY);
	if (options?.defaultDepartment) {
		titleInput.focus();
	} else {
		deptInput.focus();
	}
}

export function renderAddGroupPopover(
	host: IMissionDetailPopoverHost,
	clientX: number,
	clientY: number,
	onCreate: (groupName: string) => void,
): void {
	host.close('dismiss');
	host.bumpPopoverGeneration();
	host.popoverEl.classList.add('is-prompt-popover');
	host.popoverEl.dataset.popoverKind = 'add-group';
	const bodyRect = host.positionAtClientPoint(clientX, clientY, 332, 170);
	host.popoverDisposables.add(addDisposableListener(host.popoverEl, EventType.POINTER_DOWN, e => e.stopPropagation()));

	const head = append(host.popoverEl, $('.ade-mission-token-insp-head'));
	append(head, $('.ade-mission-emp-popover-title', {}, adeBi(localize('adeOrchAddGroupTitle', "New Group / Department"), '新建部门分组 (Group)')));
	const closeBtn = append(head, $('button.ade-mission-icon-btn', {
		type: 'button',
		title: adeBi(localize('adeMissionClose', "Close"), '关闭'),
		'aria-label': adeBi(localize('adeMissionClose', "Close"), '关闭'),
	})) as HTMLButtonElement;
	closeBtn.appendChild($('span.codicon.codicon-close'));
	host.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => host.close('dismiss')));

	const nameInput = append(host.popoverEl, $('input.ade-mission-task-pop-title-input', {
		type: 'text',
		placeholder: adeBi(localize('adeOrchAddGroupPh', "Group name (e.g. Platform Backend, Security QA)…"), '分组名称（如 Platform Backend、Security QA）…'),
		'data-ade-orch-group-name': 'true',
	})) as HTMLInputElement;

	const actions = append(host.popoverEl, $('.ade-mission-token-actions'));
	const submitBtn = append(actions, $('button.ade-mission-token-action-btn.primary', {
		type: 'button',
		'data-ade-orch-group-submit': 'true',
	}, adeBi(localize('adeOrchAddGroupSubmit', "Create Group"), '创建分组'))) as HTMLButtonElement;

	const doSubmit = () => {
		const name = nameInput.value.trim();
		if (!name) {
			nameInput.focus();
			return;
		}
		host.close('dismiss');
		onCreate(name);
	};
	host.popoverDisposables.add(addDisposableListener(submitBtn, EventType.CLICK, doSubmit));
	host.popoverDisposables.add(addDisposableListener(nameInput, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		e.stopPropagation();
		if (e.key === 'Enter') {
			e.preventDefault();
			doSubmit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			host.close('escape');
		}
	}));
	host.clampClientPointToViewport(bodyRect, clientX, clientY);
	nameInput.focus();
}

export function renderMoveToGroupPopover(
	host: IMissionDetailPopoverHost,
	clientX: number,
	clientY: number,
	nodeLabel: string,
	currentDepartment: string | undefined,
	groups: ReadonlyArray<{ readonly id: string; readonly name: string }>,
	onSelect: (targetGroupNameOrId: string | undefined) => void,
): void {
	host.close('dismiss');
	host.bumpPopoverGeneration();
	host.popoverEl.classList.add('is-prompt-popover');
	host.popoverEl.dataset.popoverKind = 'move-to-group';
	const bodyRect = host.positionAtClientPoint(clientX, clientY, 312, 280);
	host.popoverDisposables.add(addDisposableListener(host.popoverEl, EventType.POINTER_DOWN, e => e.stopPropagation()));

	const head = append(host.popoverEl, $('.ade-mission-token-insp-head'));
	append(head, $('.ade-mission-emp-popover-title', {}, adeBi(localize('adeOrchMoveGroupTitle', "Assign Group · {0}", nodeLabel), '归属分组 · {0}', nodeLabel)));
	const closeBtn = append(head, $('button.ade-mission-icon-btn', {
		type: 'button',
		title: adeBi(localize('adeMissionClose', "Close"), '关闭'),
		'aria-label': adeBi(localize('adeMissionClose', "Close"), '关闭'),
	})) as HTMLButtonElement;
	closeBtn.appendChild($('span.codicon.codicon-close'));
	host.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => host.close('dismiss')));

	const list = append(host.popoverEl, $('.ade-mission-emp-popover-list'));
	const curLower = (currentDepartment ?? '').trim().toLowerCase();
	const noneBtn = append(list, $(`button.ade-mission-emp-popover-item${!curLower ? '.active' : ''}`, {
		type: 'button',
		'data-ade-move-group-option': '__none__',
	}));
	append(noneBtn, $('span', {}, adeBi(localize('adeOrchNoGroupOpt', "(No Group / Top-Level)"), '（无分组 / 顶层）')));
	host.popoverDisposables.add(addDisposableListener(noneBtn, EventType.CLICK, () => {
		host.close('dismiss');
		onSelect(undefined);
	}));

	for (const grp of groups) {
		const isCur = grp.name.trim().toLowerCase() === curLower;
		const btn = append(list, $(`button.ade-mission-emp-popover-item${isCur ? '.active' : ''}`, {
			type: 'button',
			'data-ade-move-group-option': grp.id,
		}));
		append(btn, $('span', {}, grp.name));
		if (isCur) {
			append(btn, $('span.codicon.codicon-check', { 'aria-hidden': 'true' }));
		}
		host.popoverDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
			host.close('dismiss');
			onSelect(grp.id);
		}));
	}

	const newInput = append(host.popoverEl, $('input.ade-mission-task-pop-title-input', {
		type: 'text',
		placeholder: adeBi(localize('adeOrchMoveNewGroupPh', "Or type a new group name + Enter…"), '或输入新分组名称后按回车…'),
		'data-ade-move-group-new': 'true',
	})) as HTMLInputElement;
	host.popoverDisposables.add(addDisposableListener(newInput, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		e.stopPropagation();
		if (e.key === 'Enter') {
			e.preventDefault();
			const v = newInput.value.trim();
			if (v) {
				host.close('dismiss');
				onSelect(v);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			host.close('escape');
		}
	}));
	host.clampClientPointToViewport(bodyRect, clientX, clientY);
}

export function renderDispatchRequirementPopover(
	host: IMissionDetailPopoverHost,
	clientX: number,
	clientY: number,
	targetLabel: string,
	onDispatch: (requirement: string) => void,
): void {
	host.close('dismiss');
	host.bumpPopoverGeneration();
	host.popoverEl.classList.add('is-prompt-popover');
	host.popoverEl.dataset.popoverKind = 'orch-dispatch';
	const bodyRect = host.positionAtClientPoint(clientX, clientY, 372, 230);
	host.popoverDisposables.add(addDisposableListener(host.popoverEl, EventType.POINTER_DOWN, e => e.stopPropagation()));

	const head = append(host.popoverEl, $('.ade-mission-token-insp-head'));
	append(head, $('.ade-mission-emp-popover-title', {}, adeBi(
		localize('adeOrchDispatchTitle', "Dispatch Requirement → {0}", targetLabel),
		'下达总需求 → {0}',
		targetLabel,
	)));
	const closeBtn = append(head, $('button.ade-mission-icon-btn', {
		type: 'button',
		title: adeBi(localize('adeMissionClose', "Close"), '关闭'),
		'aria-label': adeBi(localize('adeMissionClose', "Close"), '关闭'),
	})) as HTMLButtonElement;
	closeBtn.appendChild($('span.codicon.codicon-close'));
	host.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => host.close('dismiss')));

	const reqArea = append(host.popoverEl, $('textarea.ade-mission-node-prompt-popover-input', {
		rows: '5',
		spellcheck: 'false',
		placeholder: adeBi(
			localize('adeOrchDispatchPh', "Describe the overall requirement to dispatch to the highest-rank role as a token baton…"),
			'输入总需求，系统将以接力令牌形式下达给最高职级角色进行拆解与分发…',
		),
		'data-ade-orch-dispatch-input': 'true',
	})) as HTMLTextAreaElement;

	const actions = append(host.popoverEl, $('.ade-mission-token-actions'));
	const submitBtn = append(actions, $('button.ade-mission-token-action-btn.primary', {
		type: 'button',
		'data-ade-orch-dispatch-submit': 'true',
	}, adeBi(localize('adeOrchDispatchSubmit', "Dispatch Baton"), '派发接力令牌'))) as HTMLButtonElement;

	const doSubmit = () => {
		const text = reqArea.value.trim();
		if (!text) {
			reqArea.focus();
			return;
		}
		host.close('dismiss');
		onDispatch(text);
	};
	host.popoverDisposables.add(addDisposableListener(submitBtn, EventType.CLICK, doSubmit));
	host.popoverDisposables.add(addDisposableListener(reqArea, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		e.stopPropagation();
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			doSubmit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			host.close('escape');
		}
	}));
	host.clampClientPointToViewport(bodyRect, clientX, clientY);
	reqArea.focus();
}
