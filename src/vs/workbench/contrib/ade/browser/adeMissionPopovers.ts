/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	ADE_OS_ICON_LABELS,
	AdeOsIconKind,
	IAdeCloudHost,
	IAdeCloudHostBackendService,
	resolveAdeOsIconKind,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import { AdeThinkingLevel } from '../../../../platform/ade/common/adeEngineering.js';
import { IMissionSupervisorBinding } from '../../../../platform/ade/common/adeMissionBoundary.js';
import { IMissionDagEdge, IMissionDagEmployeeGroup, IMissionDagNode } from '../../../../platform/ade/common/adeMissionDag.js';
import {
	collectValidUpstreamRollbackCandidates,
	IMissionRuntimeState,
	IMissionSourceTrigger,
	IMissionToken,
	MissionExternalEventType,
	MissionSourceTriggerKind,
	parseDurationMs,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import {
	IMissionTaskStatusRecord,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationWhiteboard,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import { ADE_NODE_COLOR_PRESETS, normalizeAdeNodeColor, resolveAdeNodeColorHex } from '../../../../platform/ade/common/adeNodeColors.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import { formatTierTag } from '../../../../platform/ade/common/adeRankResize.js';
import {
	ADE_LLM_PICKER_VENDORS,
	ADE_LLM_PROVIDER_LABELS,
	AdeLlmPickerVendor,
	IAdeLlmModelOption,
	IAdeLlmVendorCatalogEntry,
	normalizeAdeModelIdentityKey,
	renderAdeLlmIcon,
	resolveAdeEngineModelCatalog,
	resolveEffectiveAdeLlmProvider,
	toAdePickerVendor,
} from '../../../browser/adeLlmIcon.js';
import { renderAdeOsIcon, resolveLocalOsIconKind } from '../../../browser/adeOsIcon.js';
import { ADE_SECRETARY_ID, IAdeAgent, IAdeProjectsService } from '../common/ade.js';
import { adeBi } from '../common/adeLocalization.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import {
	AdeMissionHostCatalog,
	applyMissionEngineIcon,
	IHostEngineProbeCacheEntry,
	MISSION_ENGINE_DEFAULT_MODELS,
	MISSION_THINKING_LEVEL_OPTIONS,
} from './adeMissionHostCatalog.js';
import {
	formatMissionBlockedRemaining,
	formatMissionTriggerShortLabel,
	formatMissionWaveTag,
	getMissionSupervisorColorIndex,
} from './adeMissionCanvasRenderer.js';
import { IAdeMissionRuntimeService } from './adeMissionRuntime.js';
import {
	IDeterministicCheckHook,
	IMissionDetailPopoverHost,
	IMissionPopoverPointerReadResult,
	IMissionTaskEditorPopoverCallbacks,
	IMissionTaskEditorPopoverOptions,
	IOrchestrationTokenPopoverOptions,
	IWhiteboardEditorPopoverOptions,
	renderAddGroupPopover,
	renderAddStaffPopover,
	renderAddWhiteboardPopover,
	renderDispatchRequirementPopover,
	renderMissionTaskDetailPopover,
	renderMoveToGroupPopover,
	renderOrchestrationTokenDetailPopover,
	renderWhiteboardDetailPopover,
} from './adeMissionCanvasDetailPopovers.js';

export type {
	IDeterministicCheckHook,
	IMissionPopoverPointerReadResult,
	IMissionTaskEditorPopoverCallbacks,
	IMissionTaskEditorPopoverOptions,
	IOrchestrationTokenPopoverOptions,
	IWhiteboardEditorPopoverOptions,
};

export interface IMissionPopoversDelegate {
	getActiveMissionId(): string | undefined;
	getMissionGraph?(): { readonly nodes: readonly IMissionDagNode[]; readonly edges: readonly IMissionDagEdge[] };
	getNodePrompt(missionId: string, nodeId: string): string;
	canSwitchAgentEngine(agent: IAdeAgent): boolean;
	getExplicitNodeHost(missionId: string, nodeId: string): string | undefined;
	resolveSupervisorDisplay?(supervisorId: string): { readonly label: string; readonly shortLabel: string; readonly tier: number };
	onAssignNodeEmployee(nodeId: string, employeeName: string | undefined): void;
	onNodePromptEdit(missionId: string, nodeId: string, nextVal: string): void;
	onOpenDrawerForNodePrompt(nodeId: string): void;
	onOpenAgentSession?(agentId: string): void;
	onUpdateOrchestrationStaffConfig?(missionId: string, nodeId: string, patch: {
		readonly engineId?: string;
		readonly model?: string;
		readonly thinking?: AdeThinkingLevel;
		readonly resetSession?: boolean;
	}): Promise<void>;
	onHoverSupervisor?(supervisorId: string | undefined): void;
	onQuickRetryNode?(node: IMissionDagNode, token: IMissionToken, guidance?: string): Promise<void>;
	onActionFeedback?(message: string, kind: 'ok' | 'error' | 'info'): void;
	onGraphVisualInvalidated(prewarmHosts?: boolean): void;
	onRuntimeControlsInvalidated(): void;
}

/**
 * Unified floating popover manager for the Mission Canvas:
 * - Host & OS picker
 * - Agent Engine picker (with proactive local/SSH availability probing)
 * - Vendor-grouped Model & Thinking picker (with persistent user recategorization)
 * - Per-Node Pre-Prompt live editor (synchronized with the Mission store & File drawer)
 * - Employee context-reuse / host / off-graph supervisor popover
 * - Human Gate approve/reject sign-off popover
 */
export class AdeMissionPopovers extends Disposable {
	private readonly popoverEl: HTMLElement;
	private readonly popoverDisposables = this._register(new DisposableStore());
	private popoverGeneration = 0;

	private activePromptNodeId: string | undefined;
	private activePromptTextarea: HTMLTextAreaElement | undefined;
	private activePromptHintEl: HTMLElement | undefined;
	private activePromptClearBtn: HTMLButtonElement | undefined;
	private activeTokenInspectorId: string | undefined;
	private activeTokenCountdownEl: HTMLElement | undefined;
	private activeInlineErrorEl: HTMLElement | undefined;
	private activeAnchorEl: HTMLElement | undefined;
	private beforeCloseFlush: (() => void) | undefined;
	private activeOrchCountdownUpdater: ((now: number, orchState?: IOrchestrationRuntimeState) => void) | undefined;

	constructor(
		private readonly bodyEl: HTMLElement,
		private readonly hostCatalog: AdeMissionHostCatalog,
		private readonly projectsService: IAdeProjectsService | undefined,
		private readonly missionRuntimeService: IAdeMissionRuntimeService | undefined,
		private readonly roleSchemaService: IAdeRoleSchemaService | undefined,
		private readonly cloudHostService: IAdeCloudHostBackendService | undefined,
		private readonly delegate: IMissionPopoversDelegate,
	) {
		super();
		this.popoverEl = append(this.bodyEl, $('.ade-mission-emp-popover', {
			role: 'dialog',
			'aria-label': localize('adeMissionEmployeePickerAria', "Assign or Reuse Employee"),
			'data-ade-mission-emp-popover': 'true',
		}));
		this.popoverEl.hidden = true;
		this._register({
			dispose: () => {
				this.close();
			},
		});
	}

	isOpen(): boolean {
		return !this.popoverEl.hidden;
	}

	close(reason: 'dismiss' | 'escape' = 'dismiss'): void {
		const flushHook = this.beforeCloseFlush;
		this.beforeCloseFlush = undefined;
		this.activeOrchCountdownUpdater = undefined;
		if (reason !== 'escape' && flushHook && !this.popoverEl.hidden) {
			try {
				flushHook();
			} catch {
				// Ignore flush callback errors during teardown
			}
		}
		this.popoverGeneration++;
		this.popoverDisposables.clear();
		this.activePromptNodeId = undefined;
		this.activePromptTextarea = undefined;
		this.activePromptHintEl = undefined;
		this.activePromptClearBtn = undefined;
		this.activeTokenInspectorId = undefined;
		this.activeTokenCountdownEl = undefined;
		this.activeInlineErrorEl = undefined;
		this.activeAnchorEl = undefined;
		this.popoverEl.classList.remove(
			'is-model-popover',
			'is-prompt-popover',
			'is-token-popover',
			'is-triggers-popover',
			'is-context-menu',
			'is-color-popover',
		);
		this.popoverEl.style.maxWidth = '';
		this.popoverEl.style.maxHeight = '';
		delete this.popoverEl.dataset.popoverKind;
		delete this.popoverEl.dataset.adeCanvasContextMenu;
		delete this.popoverEl.dataset.popoverNodeId;
		delete this.popoverEl.dataset.popoverHost;
		delete this.popoverEl.dataset.popoverTokenId;
		clearNode(this.popoverEl);
		this.popoverEl.hidden = true;
	}

	patchOpenTokenCountdown(
		runtimeState: IMissionRuntimeState | undefined,
		now = Date.now(),
		orchRuntimeState?: IOrchestrationRuntimeState,
	): void {
		if (this.activeOrchCountdownUpdater) {
			const missionId = runtimeState?.missionId ?? this.delegate.getActiveMissionId();
			const effectiveOrch = orchRuntimeState
				?? (missionId ? this.missionRuntimeService?.getOrchestrationState(missionId) : undefined);
			this.activeOrchCountdownUpdater(now, effectiveOrch);
		}
		if (!this.activeTokenInspectorId || !this.activeTokenCountdownEl || !runtimeState) {
			return;
		}
		const tok = runtimeState.tokens[this.activeTokenInspectorId];
		if (!tok || tok.status !== 'blocked' || !tok.blocked) {
			return;
		}
		const rem = formatMissionBlockedRemaining(tok.blocked.expiresAt, now);
		const text = `⏳ ${rem.text}`;
		if (this.activeTokenCountdownEl.textContent !== text) {
			this.activeTokenCountdownEl.textContent = text;
		}
		this.activeTokenCountdownEl.classList.toggle('is-overdue', rem.isOverdue);
	}

	showInlineError(message: string): void {
		if (this.popoverEl.hidden) {
			return;
		}
		if (this.activeInlineErrorEl && this.activeInlineErrorEl.isConnected) {
			this.activeInlineErrorEl.textContent = message;
			this.activeInlineErrorEl.hidden = false;
			return;
		}
		this.activeInlineErrorEl = append(this.popoverEl, $('.ade-mission-drawer-status.error', {
			'data-ade-popover-inline-error': 'true',
		}, message));
	}

	syncOpenPromptPopover(prompts: Readonly<Record<string, string>>, source?: 'drawer' | 'popover'): void {
		if (!this.activePromptNodeId || !this.activePromptTextarea) {
			return;
		}
		const popPrompt = prompts[this.activePromptNodeId] ?? '';
		if (source !== 'popover' && this.activePromptTextarea.value !== popPrompt) {
			this.activePromptTextarea.value = popPrompt;
		}
		const trimmedLen = (source === 'popover' ? this.activePromptTextarea.value : popPrompt).trim().length;
		if (this.activePromptClearBtn) {
			this.activePromptClearBtn.hidden = trimmedLen === 0;
		}
		if (this.activePromptHintEl) {
			this.activePromptHintEl.textContent = trimmedLen > 0
				? adeBi(localize('adeMissionPromptPopoverSavedHint', "Auto-sent when step starts · {0} chars", trimmedLen), '运行到该节点时自动发送 · {0} 字', trimmedLen)
				: adeBi(localize('adeMissionPromptPopoverEmptyHint', "Auto-sent to this step's Agent when activated"), '运行到该节点时自动发送给该节点 Agent');
		}
	}

	private positionNear(anchorEl: HTMLElement, width: number, estimatedHeight?: number, offsetY = 6): { readonly bodyRect: DOMRect; readonly anchorRect: DOMRect } {
		this.activeAnchorEl = anchorEl;
		const bodyRect = this.bodyEl.getBoundingClientRect();
		const anchorRect = anchorEl.getBoundingClientRect();
		const availW = bodyRect.width > 0 ? Math.max(64, bodyRect.width - 16) : width;
		if (bodyRect.width > 0 && bodyRect.width < width + 24) {
			this.popoverEl.style.maxWidth = `${Math.floor(availW)}px`;
		} else {
			this.popoverEl.style.maxWidth = '';
		}
		const effectiveW = Math.min(width, availW);
		const maxLeft = Math.max(8, bodyRect.width - effectiveW - 8);
		const left = Math.max(8, Math.min(maxLeft, anchorRect.left - bodyRect.left));
		const rawTop = anchorRect.bottom - bodyRect.top + offsetY;
		const top = estimatedHeight !== undefined && bodyRect.height > 0
			? Math.max(8, Math.min(Math.max(8, bodyRect.height - estimatedHeight - 8), rawTop))
			: Math.max(8, rawTop);
		this.popoverEl.style.left = `${Math.round(left)}px`;
		this.popoverEl.style.top = `${Math.round(top)}px`;
		this.popoverEl.hidden = false;
		return { bodyRect, anchorRect };
	}

	private clampTopToViewport(bodyRect: DOMRect, anchorRect: DOMRect, offsetY = 6): void {
		if (this.popoverEl.hidden) {
			return;
		}
		const freshBody = this.bodyEl.getBoundingClientRect();
		const liveBody = freshBody.width > 0 && freshBody.height > 0 ? freshBody : bodyRect;
		if (liveBody.width <= 0 || liveBody.height <= 0) {
			return;
		}
		const maxAvailW = Math.max(64, Math.floor(liveBody.width - 16));
		const maxAvailH = Math.max(64, Math.floor(liveBody.height - 16));
		this.popoverEl.style.maxHeight = `${maxAvailH}px`;
		let pRect = this.popoverEl.getBoundingClientRect();
		if (pRect.width > maxAvailW) {
			this.popoverEl.style.maxWidth = `${maxAvailW}px`;
			pRect = this.popoverEl.getBoundingClientRect();
		}
		const freshAnchor = this.activeAnchorEl && this.activeAnchorEl.isConnected
			? this.activeAnchorEl.getBoundingClientRect()
			: undefined;
		const liveAnchor = freshAnchor && (freshAnchor.width > 0 || freshAnchor.height > 0)
			? freshAnchor
			: anchorRect;
		const hasValidAnchor = liveAnchor.width > 0 || liveAnchor.height > 0 || liveAnchor.left !== 0 || liveAnchor.top !== 0;

		const actualW = Math.min(pRect.width, maxAvailW);
		const maxLeft = Math.max(8, liveBody.width - actualW - 8);
		const desiredLeft = hasValidAnchor ? (liveAnchor.left - liveBody.left) : (Number.parseFloat(this.popoverEl.style.left) || 8);
		this.popoverEl.style.left = `${Math.round(Math.max(8, Math.min(maxLeft, desiredLeft)))}px`;

		const maxTop = Math.max(8, liveBody.height - pRect.height - 8);
		if (!hasValidAnchor) {
			const curTop = Number.parseFloat(this.popoverEl.style.top) || 8;
			this.popoverEl.style.top = `${Math.round(Math.max(8, Math.min(maxTop, curTop)))}px`;
			return;
		}
		const belowTop = liveAnchor.bottom - liveBody.top + offsetY;
		const aboveTop = liveAnchor.top - liveBody.top - pRect.height - offsetY;
		if (belowTop > maxTop && aboveTop >= 8) {
			this.popoverEl.style.top = `${Math.round(Math.min(maxTop, aboveTop))}px`;
		} else {
			this.popoverEl.style.top = `${Math.round(Math.max(8, Math.min(maxTop, belowTop)))}px`;
		}
	}

	private clampClientPointPopover(bodyRect: DOMRect, clientX: number, clientY: number): void {
		if (this.popoverEl.hidden) {
			return;
		}
		const freshBody = this.bodyEl.getBoundingClientRect();
		const liveBody = freshBody.width > 0 && freshBody.height > 0 ? freshBody : bodyRect;
		if (liveBody.width <= 0 || liveBody.height <= 0) {
			return;
		}
		const maxAvailW = Math.max(64, Math.floor(liveBody.width - 16));
		const maxAvailH = Math.max(64, Math.floor(liveBody.height - 16));
		this.popoverEl.style.maxHeight = `${maxAvailH}px`;
		let pRect = this.popoverEl.getBoundingClientRect();
		if (pRect.width > maxAvailW) {
			this.popoverEl.style.maxWidth = `${maxAvailW}px`;
			pRect = this.popoverEl.getBoundingClientRect();
		}
		const maxLeft = Math.max(8, liveBody.width - pRect.width - 8);
		const maxTop = Math.max(8, liveBody.height - pRect.height - 8);
		this.popoverEl.style.left = `${Math.round(Math.max(8, Math.min(maxLeft, clientX - liveBody.left)))}px`;
		this.popoverEl.style.top = `${Math.round(Math.max(8, Math.min(maxTop, clientY - liveBody.top)))}px`;
	}

	async openHostPopover(missionId: string, node: IMissionDagNode, currentHost: string, anchorEl: HTMLElement): Promise<void> {
		this.close();
		if (!this.missionRuntimeService || !this.cloudHostService) {
			return;
		}
		const openGen = ++this.popoverGeneration;
		const hosts = await this.cloudHostService.listHosts().catch(() => [] as readonly IAdeCloudHost[]);
		if (openGen !== this.popoverGeneration) {
			return;
		}
		this.popoverDisposables.clear();
		clearNode(this.popoverEl);
		const { bodyRect, anchorRect } = this.positionNear(anchorEl, 276, 260);

		append(this.popoverEl, $('.ade-mission-emp-popover-title', {}, localize('adeMissionHostQuickPickerTitle', "Execution Host & OS for {0}", node.id)));
		const list = append(this.popoverEl, $('.ade-mission-emp-popover-list'));

		const addHostOption = (alias: string, label: string, osKind: AdeOsIconKind, isActive: boolean) => {
			const btn = append(list, $(`button.ade-mission-emp-popover-item${isActive ? '.active' : ''}`, {
				type: 'button',
				'data-ade-host-option': alias,
			}));
			const lead = append(btn, $('span.ade-mission-engine-option-lead'));
			const osEl = append(lead, $('span.ade-mission-os-icon', { 'aria-hidden': 'true' }));
			renderAdeOsIcon(osEl, osKind, { baseClass: 'ade-mission-os-icon', prefix: 'ade-os' });
			append(lead, $('span', {}, label));
			if (isActive) {
				append(btn, $('span.codicon.codicon-check', { 'aria-hidden': 'true' }));
			}
			this.popoverDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				void this.missionRuntimeService?.bindNodeHost(missionId, node.id, { hostAlias: alias }).then(res => {
					if (openGen !== this.popoverGeneration) {
						return;
					}
					if (res && typeof res === 'object' && (res as { readonly ok?: boolean }).ok === false) {
						const msg = (res as { readonly error?: string }).error ?? localize('adeMissionHostBindFailed', "Failed to bind execution host.");
						this.showInlineError(msg);
						this.delegate.onActionFeedback?.(msg, 'error');
						return;
					}
					this.close();
					this.delegate.onGraphVisualInvalidated(true);
				}, err => {
					if (openGen !== this.popoverGeneration) {
						return;
					}
					const msg = err instanceof Error ? err.message : localize('adeMissionHostBindFailed', "Failed to bind execution host.");
					this.showInlineError(msg);
					this.delegate.onActionFeedback?.(msg, 'error');
				});
			}));
		};

		const localOs = resolveLocalOsIconKind();
		addHostOption('local', `${ADE_OS_ICON_LABELS[localOs]} (Local)`, localOs, currentHost === 'local');
		for (const h of hosts) {
			const hOs = resolveAdeOsIconKind({
				os: h.os,
				distribution: h.lastTestStatus?.remoteUname,
				hint: `${h.name} ${h.alias} ${h.user ?? ''}`,
			});
			addHostOption(h.alias, `${h.alias} (${ADE_OS_ICON_LABELS[hOs]})`, hOs, h.alias.toLowerCase() === currentHost.toLowerCase());
		}
		this.clampTopToViewport(bodyRect, anchorRect);
	}

	async openEnginePopover(
		missionId: string,
		nodeId: string,
		agent: IAdeAgent | undefined,
		currentEngineId: string,
		anchorEl: HTMLElement,
		options?: { readonly staffLabel?: string; readonly hostAlias?: string },
	): Promise<void> {
		this.close();
		const hasStaffConfigUpdater = Boolean(this.delegate.onUpdateOrchestrationStaffConfig);
		if (agent && !this.delegate.canSwitchAgentEngine(agent) && !hasStaffConfigUpdater) {
			return;
		}
		if (!agent && !hasStaffConfigUpdater) {
			return;
		}
		const openGen = ++this.popoverGeneration;
		const latestAgent = agent ? (this.projectsService?.getAgent(agent.id) ?? agent) : undefined;
		const displayLabel = latestAgent?.label ?? options?.staffLabel ?? nodeId;
		const effectiveProbeUri = this.hostCatalog.resolveEffectiveNodeProbeUri(
			this.delegate.getExplicitNodeHost(missionId, nodeId) ?? options?.hostAlias,
			latestAgent,
		);
		const hostLabel = this.hostCatalog.formatHostLabelForUri(effectiveProbeUri);
		const hasActiveSession = Boolean(latestAgent?.session);

		this.popoverDisposables.clear();
		clearNode(this.popoverEl);
		this.popoverEl.classList.remove('is-model-popover', 'is-prompt-popover');
		this.popoverEl.dataset.popoverKind = 'engine';
		this.popoverEl.dataset.popoverHost = hostLabel;
		const { bodyRect, anchorRect } = this.positionNear(anchorEl, 286);

		const headRow = append(this.popoverEl, $('.ade-mission-engine-popover-head'));
		append(headRow, $('.ade-mission-emp-popover-title', {}, localize('adeMissionEnginePickerTitle', "Agent Engine for {0}", displayLabel)));
		const headMeta = append(headRow, $('.ade-mission-engine-popover-head-right'));
		append(headMeta, $('span.ade-mission-engine-host-badge', { title: hostLabel }, hostLabel));
		const refreshBtn = append(headMeta, $('button.ade-mission-engine-refresh-btn', {
			type: 'button',
			title: localize('adeMissionEngineRefreshTip', "Re-detect available Agent engines on {0}", hostLabel),
			'aria-label': localize('adeMissionEngineRefreshTip', "Re-detect available Agent engines on {0}", hostLabel),
			'data-ade-engine-refresh': 'true',
		})) as HTMLButtonElement;
		append(refreshBtn, $('span.codicon.codicon-refresh', { 'aria-hidden': 'true' }));

		if (hasActiveSession) {
			const resetBanner = append(this.popoverEl, $('.ade-mission-engine-reset-banner', {
				'data-ade-engine-reset-banner': 'true',
			}));
			append(resetBanner, $('span.codicon.codicon-warning', { 'aria-hidden': 'true' }));
			append(resetBanner, $('span', {}, adeBi(
				localize('adeMissionEngineResetBanner', "Session active — choosing another engine will reset this staff session."),
				'当前已有活跃会话 — 切换引擎将自动重置该员工会话并重新预热。',
			)));
		}

		const errorHostEl = append(this.popoverEl, $('.ade-mission-engine-probe-error'));
		errorHostEl.hidden = true;
		const list = append(this.popoverEl, $('.ade-mission-emp-popover-list'));
		const listDisposables = this.popoverDisposables.add(new DisposableStore());

		const renderProbeResult = (probe: IHostEngineProbeCacheEntry | undefined, loading: boolean) => {
			if (openGen !== this.popoverGeneration || this.popoverEl.hidden) {
				return;
			}
			listDisposables.clear();
			clearNode(list);
			refreshBtn.classList.toggle('is-spinning', loading);
			refreshBtn.disabled = loading;

			if (probe?.error) {
				errorHostEl.hidden = false;
				errorHostEl.textContent = probe.error;
			} else {
				errorHostEl.hidden = true;
				errorHostEl.textContent = '';
			}

			if (!probe) {
				const loadingRow = append(list, $('.ade-mission-engine-loading', { 'data-ade-engine-loading': 'true' }));
				append(loadingRow, $('span.codicon.codicon-loading.codicon-modifier-spin', { 'aria-hidden': 'true' }));
				append(loadingRow, $('span', {}, localize('adeMissionEngineDetecting', "Detecting available engines on {0}...", hostLabel)));
				this.clampTopToViewport(bodyRect, anchorRect);
				return;
			}

			for (const eng of probe.allEngines) {
				const isActive = eng.id === currentEngineId;
				const isAvailable = eng.available;
				const btnCls = [
					'button.ade-mission-emp-popover-item',
					isActive ? '.active' : '',
					isAvailable ? '' : '.is-unavailable',
				].join('');
				const btn = append(list, $(btnCls, {
					type: 'button',
					'data-ade-engine-option': eng.id,
					'data-ade-engine-available': String(isAvailable),
					'aria-disabled': String(!isAvailable),
					title: isAvailable
						? localize('adeMissionEngineOptionAvailableTip', "{0} — Available on {1}", eng.name, hostLabel)
						: probe.error
							? localize('adeMissionEngineOptionHostErrTip', "{0} is unavailable on {1}: {2}", eng.name, hostLabel, probe.error)
							: localize('adeMissionEngineOptionUnavailableTip', "{0} is not installed on {1}", eng.name, hostLabel),
				})) as HTMLButtonElement;
				if (!isAvailable) {
					btn.disabled = true;
				}
				const lead = append(btn, $('span.ade-mission-engine-option-lead'));
				const iconEl = append(lead, $('span.ade-mission-engine-icon', { 'aria-hidden': 'true' }));
				applyMissionEngineIcon(iconEl, eng.icon);
				append(lead, $('span.ade-mission-engine-option-name', {}, eng.name));
				const tail = append(btn, $('span.ade-mission-engine-option-tail'));
				if (!isAvailable) {
					append(tail, $('span.ade-mission-engine-status-badge.is-unavailable', {}, localize('adeMissionEngineUnavailableTag', "Unavailable")));
				} else if (isActive) {
					append(tail, $('span.codicon.codicon-check', { 'aria-hidden': 'true' }));
				}
				if (isAvailable) {
					listDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
						const current = latestAgent ? (this.projectsService?.getAgent(latestAgent.id) ?? latestAgent) : undefined;
						if (this.delegate.onUpdateOrchestrationStaffConfig) {
							const needsReset = Boolean(current?.session && eng.id !== currentEngineId);
							this.close();
							void this.delegate.onUpdateOrchestrationStaffConfig(missionId, nodeId, {
								engineId: eng.id,
								model: MISSION_ENGINE_DEFAULT_MODELS[eng.id],
								resetSession: needsReset,
							});
							return;
						}
						if (!current || !this.delegate.canSwitchAgentEngine(current)) {
							this.close();
							this.delegate.onGraphVisualInvalidated();
							return;
						}
						this.projectsService?.updateAgentEnginePreferences?.(current.id, {
							preferredEngineId: eng.id,
							preferredModel: MISSION_ENGINE_DEFAULT_MODELS[eng.id],
						});
						this.close();
						this.delegate.onGraphVisualInvalidated();
					}));
				}
			}
			this.clampTopToViewport(bodyRect, anchorRect);
		};

		this.popoverDisposables.add(addDisposableListener(refreshBtn, EventType.CLICK, e => {
			e.stopPropagation();
			renderProbeResult(this.hostCatalog.getCachedHostEngines(effectiveProbeUri), true);
			void this.hostCatalog.probeHostEngines(effectiveProbeUri, true).then(fresh => {
				renderProbeResult(fresh, false);
			});
		}));

		const cached = this.hostCatalog.getCachedHostEngines(effectiveProbeUri);
		if (cached) {
			renderProbeResult(cached, false);
		} else {
			renderProbeResult(undefined, true);
			const fresh = await this.hostCatalog.probeHostEngines(effectiveProbeUri, false);
			if (openGen !== this.popoverGeneration || this.popoverEl.hidden) {
				return;
			}
			renderProbeResult(fresh, false);
		}
	}

	openModelPopover(
		missionId: string,
		nodeId: string,
		agent: IAdeAgent | undefined,
		currentEngineId: string,
		anchorEl: HTMLElement,
		options?: { readonly currentModel?: string; readonly currentThinking?: AdeThinkingLevel; readonly hostAlias?: string },
	): void {
		this.close();
		if (!this.projectsService && !this.delegate.onUpdateOrchestrationStaffConfig) {
			return;
		}
		if (!agent && !this.delegate.onUpdateOrchestrationStaffConfig) {
			return;
		}
		const popoverSession = ++this.popoverGeneration;
		const latestAgent = agent ? (this.projectsService?.getAgent(agent.id) ?? agent) : undefined;
		const effectiveProbeUri = this.hostCatalog.resolveEffectiveNodeProbeUri(
			this.delegate.getExplicitNodeHost(missionId, nodeId) ?? options?.hostAlias,
			latestAgent,
		);
		this.popoverDisposables.clear();
		clearNode(this.popoverEl);

		this.popoverEl.classList.add('is-model-popover');
		this.popoverEl.dataset.popoverKind = 'model';
		const { bodyRect, anchorRect } = this.positionNear(anchorEl, 348);

		const engineDisplayName = this.hostCatalog.getEngineDisplayName(currentEngineId);
		const modelSection = append(this.popoverEl, $('.ade-mission-model-section'));
		const currentDisplayModel = (latestAgent?.preferredModel ?? options?.currentModel ?? MISSION_ENGINE_DEFAULT_MODELS[currentEngineId] ?? '').trim();
		const currentResolvedModel = currentDisplayModel.toLowerCase();
		const currentNormalizedModel = normalizeAdeModelIdentityKey(currentDisplayModel);
		let currentVendor: AdeLlmPickerVendor = toAdePickerVendor(
			resolveEffectiveAdeLlmProvider(currentResolvedModel, currentEngineId, this.hostCatalog.getModelCategoryOverrides()),
		);

		const titleRow = append(modelSection, $('.ade-mission-model-title-row'));
		append(titleRow, $('.ade-mission-emp-popover-title', {}, localize('adeMissionModelConfigTitleWithEngine', "Model & Thinking · {0}", engineDisplayName)));
		if (currentDisplayModel) {
			append(titleRow, $('span.ade-mission-model-current-pill', { title: currentDisplayModel }, currentDisplayModel));
		}

		const presetsGrid = append(modelSection, $('.ade-mission-model-presets'));
		const vendorModelsTray = append(modelSection, $('.ade-mission-vendor-models-pop', {
			'data-ade-vendor-models-tray': 'true',
		}));

		const vendorGridDisposables = this.popoverDisposables.add(new DisposableStore());
		const vendorModelsDisposables = this.popoverDisposables.add(new DisposableStore());
		let latestLiveModels: readonly { readonly id: string; readonly label?: string }[] | undefined =
			this.hostCatalog.getCachedConfiguredModels(effectiveProbeUri, currentEngineId);
		const rebuildCatalog = (): readonly IAdeLlmVendorCatalogEntry[] => resolveAdeEngineModelCatalog(
			currentEngineId,
			latestLiveModels,
			this.hostCatalog.getModelCategoryOverrides(),
		);
		let catalog: readonly IAdeLlmVendorCatalogEntry[] = rebuildCatalog();
		const resolveDefaultVendor = (cat: readonly IAdeLlmVendorCatalogEntry[]): AdeLlmPickerVendor | undefined => {
			if (cat.some(entry => entry.vendor === currentVendor && entry.supported)) {
				return currentVendor;
			}
			return cat.find(entry => entry.supported)?.vendor;
		};
		let selectedVendor: AdeLlmPickerVendor | undefined = resolveDefaultVendor(catalog);
		let categorizingModelId: string | undefined;

		const renderModelRow = (
			listEl: HTMLElement,
			modelOpt: IAdeLlmModelOption,
			activeCategoryVendor: AdeLlmPickerVendor,
		) => {
			const optLower = modelOpt.id.toLowerCase();
			const optNorm = normalizeAdeModelIdentityKey(modelOpt.id);
			const isSelected = currentResolvedModel === optLower || (Boolean(currentNormalizedModel) && currentNormalizedModel === optNorm);
			const itemWrap = append(listEl, $('.ade-mission-vendor-model-item'));
			const rowLine = append(itemWrap, $('.ade-mission-vendor-model-row-wrap'));
			const rowCls = [
				'button.ade-mission-vendor-model-row',
				isSelected ? '.active' : '',
				modelOpt.supported ? '' : '.is-unsupported',
			].join('');
			const rowBtn = append(rowLine, $(rowCls, {
				type: 'button',
				role: 'option',
				'aria-selected': String(isSelected),
				'data-ade-model-option': modelOpt.id,
				'data-ade-model-supported': String(modelOpt.supported),
				title: modelOpt.supported
					? `${modelOpt.label} (${modelOpt.id})`
					: localize('adeMissionModelUnsupportedTip', "{0} is not supported by {1}", modelOpt.id, engineDisplayName),
			})) as HTMLButtonElement;
			if (!modelOpt.supported) {
				rowBtn.disabled = true;
			}
			const lead = append(rowBtn, $('.ade-mission-vendor-model-lead'));
			const info = append(lead, $('.ade-mission-vendor-model-info'));
			append(info, $('span.ade-mission-vendor-model-label', {}, modelOpt.label));
			if (modelOpt.label.toLowerCase() !== modelOpt.id.toLowerCase()) {
				append(info, $('span.ade-mission-vendor-model-id', {}, modelOpt.id));
			}
			if (modelOpt.supported) {
				if (isSelected) {
					append(rowBtn, $('span.codicon.codicon-check.ade-mission-vendor-model-check', { 'aria-hidden': 'true' }));
				}
				vendorModelsDisposables.add(addDisposableListener(rowBtn, EventType.CLICK, () => {
					if (this.delegate.onUpdateOrchestrationStaffConfig) {
						this.close();
						void this.delegate.onUpdateOrchestrationStaffConfig(missionId, nodeId, { model: modelOpt.id });
						return;
					}
					if (latestAgent) {
						this.projectsService?.updateAgentEnginePreferences?.(latestAgent.id, { preferredModel: modelOpt.id });
					}
					this.close();
					this.delegate.onGraphVisualInvalidated();
				}));

				const isCatOpen = categorizingModelId === modelOpt.id;
				const catBtn = append(rowLine, $(`button.ade-mission-model-cat-btn${modelOpt.customCategorized ? '.is-customized' : ''}${isCatOpen ? '.is-open' : ''}`, {
					type: 'button',
					'data-ade-model-categorize': modelOpt.id,
					'aria-expanded': String(isCatOpen),
					title: modelOpt.customCategorized
						? localize('adeMissionModelCategorizedTip', "Custom icon category — Click to move to another icon group or reset to Auto")
						: localize('adeMissionModelCategorizeTip', "Move this model to a specific brand icon category"),
				})) as HTMLButtonElement;
				append(catBtn, $('span.codicon.codicon-tag', { 'aria-hidden': 'true' }));
				vendorModelsDisposables.add(addDisposableListener(catBtn, EventType.CLICK, e => {
					e.stopPropagation();
					categorizingModelId = isCatOpen ? undefined : modelOpt.id;
					renderVendorModelList();
				}));

				if (isCatOpen) {
					const catStrip = append(itemWrap, $('.ade-mission-model-cat-strip', {
						'data-ade-model-cat-picker': modelOpt.id,
					}));
					append(catStrip, $('.ade-mission-model-cat-strip-label', {}, localize('adeMissionModelMoveCategoryTitle', "Move to icon group:")));
					const chipsWrap = append(catStrip, $('.ade-mission-model-cat-chips'));
					for (const { vendor: targetVendor, shortLabel } of ADE_LLM_PICKER_VENDORS) {
						const isSameCat = targetVendor === activeCategoryVendor;
						const chipBtn = append(chipsWrap, $(`button.ade-mission-model-cat-chip${isSameCat ? '.active' : ''}`, {
							type: 'button',
							'data-ade-assign-vendor': targetVendor,
							title: localize('adeMissionModelAssignToVendorTip', "Categorize under {0}", ADE_LLM_PROVIDER_LABELS[targetVendor]),
						})) as HTMLButtonElement;
						const chipIco = append(chipBtn, $('span.ade-mission-llm-icon.is-mini', { 'aria-hidden': 'true' }));
						renderAdeLlmIcon(chipIco, targetVendor, { baseClass: 'ade-mission-llm-icon is-mini', prefix: 'ade-llm' });
						append(chipBtn, $('span', {}, shortLabel));
						vendorModelsDisposables.add(addDisposableListener(chipBtn, EventType.CLICK, e => {
							e.stopPropagation();
							this.hostCatalog.setModelCategoryOverride(currentEngineId, modelOpt.id, targetVendor);
							currentVendor = toAdePickerVendor(
								resolveEffectiveAdeLlmProvider(currentResolvedModel, currentEngineId, this.hostCatalog.getModelCategoryOverrides()),
							);
							categorizingModelId = undefined;
							catalog = rebuildCatalog();
							selectedVendor = targetVendor;
							renderVendorGrid();
							renderVendorModelList();
							this.delegate.onGraphVisualInvalidated();
						}));
					}
					if (modelOpt.customCategorized) {
						const resetBtn = append(chipsWrap, $('button.ade-mission-model-cat-chip.is-reset', {
							type: 'button',
							'data-ade-assign-vendor': 'auto',
							title: localize('adeMissionModelResetCategoryTip', "Reset to automatic name-based category"),
						})) as HTMLButtonElement;
						append(resetBtn, $('span.codicon.codicon-discard', { 'aria-hidden': 'true' }));
						append(resetBtn, $('span', {}, localize('adeMissionModelAutoCategoryLabel', "Auto")));
						vendorModelsDisposables.add(addDisposableListener(resetBtn, EventType.CLICK, e => {
							e.stopPropagation();
							this.hostCatalog.setModelCategoryOverride(currentEngineId, modelOpt.id, undefined);
							currentVendor = toAdePickerVendor(
								resolveEffectiveAdeLlmProvider(currentResolvedModel, currentEngineId, this.hostCatalog.getModelCategoryOverrides()),
							);
							categorizingModelId = undefined;
							catalog = rebuildCatalog();
							const nextEntry = catalog.find(item => item.models.some(m => normalizeAdeModelIdentityKey(m.id) === optNorm && m.supported));
							selectedVendor = nextEntry?.vendor ?? resolveDefaultVendor(catalog);
							renderVendorGrid();
							renderVendorModelList();
							this.delegate.onGraphVisualInvalidated();
						}));
					}
				}
			} else {
				append(rowBtn, $('span.ade-mission-vendor-model-na', {}, localize('adeMissionModelUnsupportedBadge', "N/A")));
			}
		};

		const renderVendorModelList = () => {
			vendorModelsDisposables.clear();
			clearNode(vendorModelsTray);
			const entry = (selectedVendor ? catalog.find(item => item.vendor === selectedVendor && item.supported) : undefined)
				?? catalog.find(item => item.supported);
			if (!entry) {
				vendorModelsTray.hidden = true;
				return;
			}
			selectedVendor = entry.vendor;
			vendorModelsTray.hidden = false;
			vendorModelsTray.dataset.vendor = entry.vendor;

			const trayHead = append(vendorModelsTray, $('.ade-mission-vendor-models-head'));
			const headLead = append(trayHead, $('.ade-mission-vendor-models-lead'));
			const headIcon = append(headLead, $('span.ade-mission-llm-icon.is-mini', { 'aria-hidden': 'true' }));
			renderAdeLlmIcon(headIcon, entry.vendor, { baseClass: 'ade-mission-llm-icon is-mini', prefix: 'ade-llm' });
			append(headLead, $('span.ade-mission-vendor-models-title', {}, entry.fullLabel));
			append(trayHead, $('span.ade-mission-vendor-models-count', {}, `${entry.supportedCount}/${entry.models.length}`));

			const listEl = append(vendorModelsTray, $('.ade-mission-vendor-models-list', {
				role: 'listbox',
				'aria-label': entry.fullLabel,
			}));
			for (const modelOpt of entry.models) {
				renderModelRow(listEl, modelOpt, entry.vendor);
			}
		};

		const renderVendorGrid = () => {
			vendorGridDisposables.clear();
			clearNode(presetsGrid);
			for (const entry of catalog) {
				const isSelectedTab = entry.supported && selectedVendor === entry.vendor;
				const isCurrentVendor = entry.supported && entry.vendor === currentVendor;
				const btnCls = [
					'button.ade-mission-model-preset-btn',
					isCurrentVendor ? '.active' : '',
					isSelectedTab ? '.expanded' : '',
					entry.supported ? '' : '.is-unsupported',
				].join('');
				const pBtn = append(presetsGrid, $(btnCls, {
					type: 'button',
					'data-ade-vendor': entry.vendor,
					'data-ade-vendor-supported': String(entry.supported),
					'aria-pressed': String(isSelectedTab),
					title: entry.supported
						? localize('adeMissionVendorSupportedTip', "{0} — {1} model(s) supported by {2}. Click to view models.", entry.fullLabel, entry.supportedCount, engineDisplayName)
						: localize('adeMissionVendorUnsupportedTip', "{0} is not natively supported by {1}", entry.fullLabel, engineDisplayName),
				})) as HTMLButtonElement;
				if (!entry.supported) {
					pBtn.disabled = true;
				}
				const pIcon = append(pBtn, $('span.ade-mission-llm-icon.is-mini', { 'aria-hidden': 'true' }));
				renderAdeLlmIcon(pIcon, entry.vendor, {
					baseClass: 'ade-mission-llm-icon is-mini',
					prefix: 'ade-llm',
					tooltip: entry.supported ? entry.fullLabel : localize('adeMissionVendorUnsupportedTip', "{0} is not natively supported by {1}", entry.fullLabel, engineDisplayName),
				});
				append(pBtn, $('span.ade-mission-vendor-btn-label', {}, entry.shortLabel));
				if (entry.supported) {
					vendorGridDisposables.add(addDisposableListener(pBtn, EventType.CLICK, () => {
						if (selectedVendor === entry.vendor) {
							return;
						}
						selectedVendor = entry.vendor;
						categorizingModelId = undefined;
						renderVendorGrid();
						renderVendorModelList();
					}));
				}
			}
		};

		renderVendorGrid();
		renderVendorModelList();

		// Asynchronously enrich with live configured models from the node's host without shifting layout
		void this.hostCatalog.fetchConfiguredModels(effectiveProbeUri).then(allMap => {
			if (popoverSession !== this.popoverGeneration || this.popoverEl.hidden) {
				return;
			}
			const liveModels = allMap?.[currentEngineId];
			if (liveModels && liveModels.length > 0) {
				latestLiveModels = liveModels;
				catalog = rebuildCatalog();
				if (!selectedVendor || !catalog.some(entry => entry.vendor === selectedVendor && entry.supported)) {
					selectedVendor = resolveDefaultVendor(catalog);
				}
				renderVendorGrid();
				renderVendorModelList();
			}
		});

		const thinkingRow = append(modelSection, $('.ade-mission-thinking-picker'));
		const activeThinking: AdeThinkingLevel = latestAgent?.preferredThinking ?? options?.currentThinking ?? 'medium';
		for (const level of MISSION_THINKING_LEVEL_OPTIONS) {
			const tBtn = append(thinkingRow, $(`button.ade-mission-thinking-opt${level === activeThinking ? '.active' : ''}`, {
				type: 'button',
				'data-ade-thinking-option': level,
			}, level)) as HTMLButtonElement;
			this.popoverDisposables.add(addDisposableListener(tBtn, EventType.CLICK, () => {
				if (this.delegate.onUpdateOrchestrationStaffConfig) {
					this.close();
					void this.delegate.onUpdateOrchestrationStaffConfig(missionId, nodeId, { thinking: level });
					return;
				}
				if (latestAgent) {
					this.projectsService?.updateAgentEnginePreferences?.(latestAgent.id, { preferredThinking: level });
				}
				this.close();
				this.delegate.onGraphVisualInvalidated();
			}));
		}

		this.clampTopToViewport(bodyRect, anchorRect);
	}

	openNodePromptPopover(missionId: string, node: IMissionDagNode, anchorEl: HTMLElement): void {
		this.close();
		this.popoverGeneration++;
		this.popoverDisposables.clear();
		clearNode(this.popoverEl);

		const currentPrompt = this.delegate.getNodePrompt(missionId, node.id);
		this.popoverEl.classList.add('is-prompt-popover');
		this.popoverEl.dataset.popoverKind = 'prompt';
		this.popoverEl.dataset.popoverNodeId = node.id;
		const { bodyRect, anchorRect } = this.positionNear(anchorEl, 396);

		const head = append(this.popoverEl, $('.ade-mission-prompt-pop-head'));
		const headMeta = append(head, $('.ade-mission-prompt-pop-meta'));
		append(headMeta, $('span.ade-mission-prompt-active-id', {}, node.id));
		append(headMeta, $('span.ade-mission-prompt-active-title', { title: node.label }, node.label));
		if (node.employeeName) {
			append(headMeta, $('span.ade-mission-prompt-active-emp', {}, `@${node.employeeName}`));
		}

		const headActions = append(head, $('.ade-mission-prompt-pop-actions'));
		const openDrawerBtn = append(headActions, $('button.ade-mission-prompt-pop-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionPromptPopOpenDrawerTip', "Open in full editor"), '在完整编辑器中打开'),
			'data-ade-prompt-pop-open-drawer': node.id,
		})) as HTMLButtonElement;
		append(openDrawerBtn, $('span.codicon.codicon-split-horizontal', { 'aria-hidden': 'true' }));
		this.popoverDisposables.add(addDisposableListener(openDrawerBtn, EventType.CLICK, () => {
			this.close();
			this.delegate.onOpenDrawerForNodePrompt(node.id);
		}));

		const clearBtn = append(headActions, $('button.ade-mission-prompt-clear-btn', {
			type: 'button',
			title: localize('adeMissionClearNodePromptTip', "Clear pre-prompt for {0}", node.id),
			'data-ade-prompt-pop-clear': node.id,
		}, localize('adeMissionClearNodePrompt', "Clear"))) as HTMLButtonElement;
		clearBtn.hidden = currentPrompt.trim().length === 0;

		const closeBtn = append(headActions, $('button.ade-mission-prompt-pop-btn', {
			type: 'button',
			title: localize('adeMissionPromptPopCloseTip', "Close"),
			'data-ade-prompt-pop-close': 'true',
		})) as HTMLButtonElement;
		append(closeBtn, $('span.codicon.codicon-close', { 'aria-hidden': 'true' }));
		this.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => {
			this.close();
		}));

		const textarea = append(this.popoverEl, $('textarea.ade-mission-node-prompt-popover-input', {
			spellcheck: 'false',
			placeholder: adeBi(
				localize(
					'adeMissionNodePromptPlaceholder',
					"Describe what this step should accomplish (objectives, files, acceptance criteria).\nAuto-sent to the assigned Agent when this step starts.",
				),
				'写明这个节点需要做什么（如任务目标、涉及文件、完成标准等）。\n运行到该节点时会自动发送给对应的 Agent。',
			),
			'aria-label': localize('adeMissionNodePromptPopoverAria', "Prompt for {0}", node.id),
			'data-ade-node-prompt-popover-input': node.id,
		})) as HTMLTextAreaElement;
		textarea.value = currentPrompt;

		const hintBar = append(this.popoverEl, $('.ade-mission-prompt-hint-bar'));
		append(hintBar, $('span.codicon.codicon-sparkle', { 'aria-hidden': 'true' }));
		const hintTextEl = append(hintBar, $('span.ade-mission-prompt-hint-text'));

		this.activePromptNodeId = node.id;
		this.activePromptTextarea = textarea;
		this.activePromptHintEl = hintTextEl;
		this.activePromptClearBtn = clearBtn;

		this.popoverDisposables.add(addDisposableListener(textarea, EventType.INPUT, () => {
			this.delegate.onNodePromptEdit(missionId, node.id, textarea.value);
		}));
		this.popoverDisposables.add(addDisposableListener(textarea, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				this.close();
				return;
			}
			e.stopPropagation();
		}));
		this.popoverDisposables.add(addDisposableListener(clearBtn, EventType.CLICK, () => {
			textarea.value = '';
			this.delegate.onNodePromptEdit(missionId, node.id, '');
			textarea.focus();
		}));

		this.syncOpenPromptPopover({ [node.id]: currentPrompt }, 'popover');
		this.clampTopToViewport(bodyRect, anchorRect);
		textarea.focus();
	}

	openEmployeePopover(
		missionId: string | undefined,
		node: IMissionDagNode,
		employees: readonly IMissionDagEmployeeGroup[],
		anchorEl: HTMLElement,
	): void {
		this.close();
		const openGen = ++this.popoverGeneration;
		this.positionNear(anchorEl, 276, 220);

		append(this.popoverEl, $('.ade-mission-emp-popover-title', {}, localize('adeMissionReuseTitle', "Employee for {0} (Reuse Context)", node.id)));
		const input = append(this.popoverEl, $('input.ade-mission-emp-popover-input', {
			type: 'text',
			placeholder: localize('adeMissionEmpInputPlaceholder', "Employee name + Enter..."),
			value: node.employeeName ?? '',
			'data-ade-mission-emp-input': 'true',
		})) as HTMLInputElement;
		this.popoverDisposables.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				const val = input.value.trim();
				this.delegate.onAssignNodeEmployee(node.id, val || undefined);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this.close();
			}
		}));

		const explicitGroups = employees.filter(g => g.isExplicit);
		const list = append(this.popoverEl, $('.ade-mission-emp-popover-list'));
		for (const group of explicitGroups) {
			const isCurrent = Boolean(node.employeeKey && group.key === `emp:${node.employeeKey}`);
			const btn = append(list, $(`button.ade-mission-emp-popover-item${isCurrent ? '.active' : ''}`, {
				type: 'button',
				'data-ade-emp-option': group.displayName,
			}));
			append(btn, $('span', {}, group.displayName));
			append(btn, $('span.ade-mission-emp-popover-meta', {}, localize('adeMissionEmpStepCount', "{0} step(s)", group.nodeIds.length)));
			this.popoverDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				this.delegate.onAssignNodeEmployee(node.id, group.displayName);
				this.close();
			}));
		}

		if (node.employeeName) {
			const clearBtn = append(list, $('button.ade-mission-emp-popover-item.clear', {
				type: 'button',
				'data-ade-emp-clear': 'true',
			}, localize('adeMissionEmpClearBtn', "Detach (Standalone Step)")));
			this.popoverDisposables.add(addDisposableListener(clearBtn, EventType.CLICK, () => {
				this.delegate.onAssignNodeEmployee(node.id, undefined);
				this.close();
			}));
		}

		// Compact host binding strip inside employee popover
		if (missionId && this.missionRuntimeService && this.cloudHostService) {
			const currentHost = this.missionRuntimeService.getRuntimeState(missionId).boundary.nodeAssignments[node.id]?.hostAlias ?? 'local';
			const hostSection = append(this.popoverEl, $('.ade-mission-host-section'));
			append(hostSection, $('.ade-mission-emp-popover-title', {}, localize('adeMissionHostPickerTitle', "Execution Host")));
			const hostSelect = append(hostSection, $('select.ade-mission-config-select.full', {
				'data-ade-node-host-select': node.id,
			})) as HTMLSelectElement;
			const localOpt = append(hostSelect, $('option', { value: 'local' }, localize('adeMissionHostLocal', "Local Machine"))) as HTMLOptionElement;
			if (currentHost === 'local') {
				localOpt.selected = true;
			}
			void this.cloudHostService.listHosts().then(hosts => {
				if (!hostSelect.isConnected) {
					return;
				}
				for (const h of hosts) {
					const opt = append(hostSelect, $('option', { value: h.alias }, `${h.name} (${h.alias})`)) as HTMLOptionElement;
					if (h.alias === currentHost) {
						opt.selected = true;
					}
				}
			}).catch(() => undefined);
			this.popoverDisposables.add(addDisposableListener(hostSelect, EventType.CHANGE, () => {
				if (this.missionRuntimeService) {
					void this.missionRuntimeService.bindNodeHost(missionId, node.id, { hostAlias: hostSelect.value }).then(res => {
						if (openGen !== this.popoverGeneration) {
							return;
						}
						if (res && typeof res === 'object' && (res as { readonly ok?: boolean }).ok === false) {
							const msg = (res as { readonly error?: string }).error ?? localize('adeMissionHostBindFailed', "Failed to bind execution host.");
							this.showInlineError(msg);
							this.delegate.onActionFeedback?.(msg, 'error');
							return;
						}
						this.close();
						this.delegate.onGraphVisualInvalidated(true);
					}, err => {
						if (openGen !== this.popoverGeneration) {
							return;
						}
						const msg = err instanceof Error ? err.message : localize('adeMissionHostBindFailed', "Failed to bind execution host.");
						this.showInlineError(msg);
						this.delegate.onActionFeedback?.(msg, 'error');
					});
				}
			}));
		}

		// Compact off-graph supervisor binding strip
		if (missionId && this.missionRuntimeService) {
			const rt = this.missionRuntimeService.getRuntimeState(missionId);
			const org = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
			const inGraphAgentIds = new Set(
				Object.values(rt.boundary.nodeAssignments)
					.map(a => a.agentId)
					.filter((id): id is string => Boolean(id)),
			);
			const currentSup = rt.boundary.supervisors.find(s => s.managedNodeIds.includes(node.id));
			const supSection = append(this.popoverEl, $('.ade-mission-host-section'));
			append(supSection, $('.ade-mission-emp-popover-title', {}, localize('adeMissionSupervisorPickerTitle', "Off-graph Supervisor")));
			const supSelect = append(supSection, $('select.ade-mission-config-select.full', {
				'data-ade-node-supervisor-select': node.id,
			})) as HTMLSelectElement;
			const autoOpt = append(supSelect, $('option', { value: '' }, localize('adeMissionSupervisorAuto', "Auto (Mission Owner)"))) as HTMLOptionElement;
			if (!currentSup) {
				autoOpt.selected = true;
			}
			const eligibleSupervisors: { readonly id: string; readonly label: string; readonly tier: number }[] = [
				{ id: ADE_SECRETARY_ID, label: 'Secretary (L0)', tier: 0 },
			];
			for (const agent of this.projectsService?.agents ?? []) {
				if (this.projectsService?.isArchived(agent.id) || inGraphAgentIds.has(agent.id) || agent.treeNodeId) {
					continue;
				}
				const liveTier = resolveEffectiveRankDefinition(org, agent.role, this.projectsService?.hasSubordinates(agent.id) ?? false).tier;
				if (liveTier <= rt.boundary.offGraphMaxTier) {
					eligibleSupervisors.push({ id: agent.id, label: `${agent.label} (${formatTierTag(liveTier)})`, tier: liveTier });
				}
			}
			for (const sup of eligibleSupervisors) {
				const opt = append(supSelect, $('option', { value: sup.id }, sup.label)) as HTMLOptionElement;
				if (currentSup?.id === sup.id) {
					opt.selected = true;
				}
			}
			const supErrEl = append(supSection, $('.ade-mission-drawer-status.error', { hidden: 'true' }));
			this.popoverDisposables.add(addDisposableListener(supSelect, EventType.CHANGE, () => {
				if (!this.missionRuntimeService) {
					return;
				}
				const selectedId = supSelect.value.trim();
				const latestRt = this.missionRuntimeService.getRuntimeState(missionId);
				const updated: IMissionSupervisorBinding[] = [];
				let foundSelected = false;
				for (const existingSup of latestRt.boundary.supervisors) {
					const withoutNode = existingSup.managedNodeIds.filter(nid => nid !== node.id);
					if (selectedId && existingSup.id === selectedId) {
						foundSelected = true;
						updated.push({ ...existingSup, managedNodeIds: [...withoutNode, node.id] });
					} else if (withoutNode.length > 0 || existingSup.managedNodeIds.length === 0) {
						updated.push({ ...existingSup, managedNodeIds: withoutNode });
					}
				}
				if (selectedId && !foundSelected) {
					const meta = eligibleSupervisors.find(e => e.id === selectedId);
					updated.push({ id: selectedId, tier: meta?.tier ?? 0, managedNodeIds: [node.id] });
				}
				void this.missionRuntimeService.setBoundary(missionId, { supervisors: updated }).then(res => {
					if (openGen !== this.popoverGeneration) {
						return;
					}
					if (res.ok) {
						this.close();
						this.delegate.onRuntimeControlsInvalidated();
					} else {
						supErrEl.textContent = res.error ?? localize('adeMissionSupervisorBindFailed', "Failed to bind supervisor.");
						supErrEl.hidden = false;
					}
				}, err => {
					if (openGen !== this.popoverGeneration) {
						return;
					}
					supErrEl.textContent = err instanceof Error ? err.message : localize('adeMissionSupervisorBindFailed', "Failed to bind supervisor.");
					supErrEl.hidden = false;
				});
			}));
		}

		input.focus();
		input.select();
	}

	openTokenInspectorPopover(
		missionId: string,
		node: IMissionDagNode,
		initialToken: IMissionToken,
		allNodeTokens: readonly IMissionToken[],
		linkedAgentId: string | undefined,
		anchorEl: HTMLElement,
	): void {
		this.close();
		if (!this.missionRuntimeService) {
			return;
		}
		const openGen = ++this.popoverGeneration;
		this.popoverEl.classList.add('is-token-popover');
		this.popoverEl.dataset.popoverKind = 'token';
		this.popoverEl.dataset.popoverNodeId = node.id;
		const { bodyRect, anchorRect } = this.positionNear(anchorEl, 390, 360, 8);

		const tokens = allNodeTokens.length > 0 ? allNodeTokens : [initialToken];
		let selectedToken: IMissionToken = tokens.find(t => t.id === initialToken.id) ?? tokens[0];
		let traceExpanded = false;
		const guidanceDraftByTokenId = new Map<string, string>();

		const contentDisposables = this.popoverDisposables.add(new DisposableStore());
		const contentRoot = append(this.popoverEl, $('.ade-mission-token-inspector'));

		const renderSelectedToken = (): void => {
			contentDisposables.clear();
			clearNode(contentRoot);
			this.activeTokenInspectorId = selectedToken.id;
			this.activeTokenCountdownEl = undefined;
			this.popoverEl.dataset.popoverTokenId = selectedToken.id;

			// Header row
			const header = append(contentRoot, $('.ade-mission-token-insp-head'));
			const titleWrap = append(header, $('.ade-mission-token-insp-title-wrap'));
			append(titleWrap, $('span.ade-mission-token-insp-node-id', {}, node.id));
			append(titleWrap, $('span.ade-mission-token-insp-title', { title: node.label }, node.label));
			append(header, $(`span.ade-mission-token-status-badge.status-${selectedToken.status.replace(/_/g, '-')}`, {}, selectedToken.status));
			const closeBtn = append(header, $('button.ade-mission-icon-btn', {
				type: 'button',
				title: localize('adeMissionTokenInspClose', "Close"),
				'aria-label': localize('adeMissionTokenInspClose', "Close"),
			})) as HTMLButtonElement;
			closeBtn.appendChild($('span.codicon.codicon-close'));
			contentDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.close()));

			// Multi-wave token switcher
			if (tokens.length > 1) {
				const switcher = append(contentRoot, $('.ade-mission-token-wave-switcher', {
					'data-ade-token-wave-switcher': 'true',
				}));
				for (const tok of tokens) {
					const isSelected = tok.id === selectedToken.id;
					const pill = append(switcher, $(`button.ade-mission-token-wave-btn${isSelected ? '.active' : ''}.status-${tok.status.replace(/_/g, '-')}`, {
						type: 'button',
						'data-ade-token-select': tok.id,
					}, `${formatMissionWaveTag(tok.waveId)} · ${tok.status}`)) as HTMLButtonElement;
					contentDisposables.add(addDisposableListener(pill, EventType.CLICK, () => {
						selectedToken = tok;
						traceExpanded = false;
						renderSelectedToken();
					}));
				}
			}

			// Metadata chips
			const metaRow = append(contentRoot, $('.ade-mission-token-meta-row'));
			append(metaRow, $('span.ade-mission-token-meta-chip', { title: selectedToken.id }, selectedToken.id));
			append(metaRow, $('span.ade-mission-token-meta-chip.wave', {}, selectedToken.waveId));
			if (selectedToken.fromNodeId) {
				append(metaRow, $('span.ade-mission-token-meta-chip', {}, `← ${selectedToken.fromNodeId}`));
			}
			if (selectedToken.returnToNodeId) {
				append(metaRow, $('span.ade-mission-token-meta-chip.rework', {}, `↩ ${selectedToken.returnToNodeId}`));
			}
			if (selectedToken.nudgeCount > 0) {
				append(metaRow, $('span.ade-mission-token-meta-chip.warn', {}, localize('adeMissionTokenNudges', "Nudges: {0}", selectedToken.nudgeCount)));
			}

			// Blocked watch box
			if (selectedToken.status === 'blocked' && selectedToken.blocked) {
				const b = selectedToken.blocked;
				const rem = formatMissionBlockedRemaining(b.expiresAt, Date.now());
				const blockedBox = append(contentRoot, $('.ade-mission-token-box.is-blocked', {
					'data-ade-token-blocked-box': 'true',
				}));
				const bHead = append(blockedBox, $('.ade-mission-token-box-head'));
				append(bHead, $('span.ade-mission-token-box-label', {}, localize('adeMissionTokenBlockedLabel', "Blocked Wait")));
				const cdEl = append(bHead, $(`span.ade-mission-token-countdown${rem.isOverdue ? '.is-overdue' : ''}`, {
					'data-ade-inspector-countdown': 'true',
				}, `⏳ ${rem.text}`));
				this.activeTokenCountdownEl = cdEl;
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

			// Failure / escalation box
			if (selectedToken.failure) {
				const failBox = append(contentRoot, $('.ade-mission-token-box.is-failed', {
					'data-ade-token-failure-box': 'true',
				}));
				const fHead = append(failBox, $('.ade-mission-token-box-head'));
				append(fHead, $('span.ade-mission-token-box-label', {}, localize('adeMissionTokenFailureLabel', "Failure & Escalation")));
				if (selectedToken.failure.escalatedToInbox) {
					append(fHead, $('span.ade-mission-token-meta-chip.danger', {}, localize('adeMissionTokenInboxEscalated', "Inbox Escalated")));
				} else if (selectedToken.failure.escalatedToSupervisorId) {
					append(fHead, $('span.ade-mission-token-meta-chip.warn', {}, `↑ ${selectedToken.failure.escalatedToSupervisorId}`));
				}
				append(failBox, $('.ade-mission-token-box-body', {}, selectedToken.failure.reason));
				if (selectedToken.failure.escalationHistory.length > 0) {
					const escList = append(failBox, $('.ade-mission-token-esc-list'));
					for (const esc of selectedToken.failure.escalationHistory) {
						append(escList, $('.ade-mission-token-esc-item', {}, `${esc.fromId} → ${esc.toId}: ${esc.note}`));
					}
				}
			}

			// Deterministic check failure box
			if (selectedToken.lastCheckFailure) {
				const chkBox = append(contentRoot, $('.ade-mission-token-box.is-warn', {
					'data-ade-token-check-box': 'true',
				}));
				const cHead = append(chkBox, $('.ade-mission-token-box-head'));
				append(cHead, $('span.ade-mission-token-box-label', {}, localize('adeMissionTokenCheckFailLabel', "Verification Check Failed ({0}/{1})", selectedToken.lastCheckFailure.attempt, selectedToken.lastCheckFailure.maxAutoRetries)));
				append(chkBox, $('.ade-mission-token-box-body', {}, selectedToken.lastCheckFailure.summary));
			}

			// Latest step summary
			const summarySection = append(contentRoot, $('.ade-mission-token-section'));
			append(summarySection, $('.ade-mission-token-section-title', {}, localize('adeMissionTokenLastSummaryTitle', "Latest Summary (lastSummary)")));
			append(summarySection, $('.ade-mission-token-text-block', {
				'data-ade-token-last-summary': 'true',
			}, selectedToken.lastSummary?.trim() || localize('adeMissionTokenNoSummary', "No summary reported yet.")));

			// Rolling compressed history
			const historySection = append(contentRoot, $('.ade-mission-token-section'));
			const histHead = append(historySection, $('.ade-mission-token-section-head'));
			append(histHead, $('.ade-mission-token-section-title', {}, localize('adeMissionTokenCompressedHistoryTitle', "Rolling History (compressedHistory)")));
			if (selectedToken.historyState && selectedToken.historyState.archivedCount > 0) {
				append(histHead, $('span.ade-mission-token-meta-chip', {}, localize('adeMissionTokenArchivedCount', "{0} archived", selectedToken.historyState.archivedCount)));
			}
			append(historySection, $('.ade-mission-token-text-block.scrollable', {
				'data-ade-token-compressed-history': 'true',
			}, selectedToken.compressedHistory?.trim() || localize('adeMissionTokenNoHistory', "Entry wave — no prior compressed history.")));

			// Lazy tracePtr expander
			const traceSection = append(contentRoot, $('.ade-mission-token-section'));
			const traceHead = append(traceSection, $('.ade-mission-token-section-head'));
			append(traceHead, $('.ade-mission-token-section-title', {}, `Trace · ${selectedToken.tracePtr}`));
			const expandBtn = append(traceHead, $('button.ade-mission-token-trace-btn', {
				type: 'button',
				'data-ade-expand-trace': 'true',
			}, traceExpanded ? localize('adeMissionTokenHideTrace', "Hide Trace") : localize('adeMissionTokenExpandTrace', "Expand Trace"))) as HTMLButtonElement;
			const traceListEl = append(traceSection, $('.ade-mission-token-trace-list', {
				'data-ade-trace-list': 'true',
			}));
			traceListEl.hidden = !traceExpanded;

			const populateTrace = (): void => {
				clearNode(traceListEl);
				const entries = this.missionRuntimeService?.expandTrace(missionId, selectedToken.tracePtr, 50) ?? [];
				if (entries.length === 0) {
					append(traceListEl, $('.ade-mission-token-trace-empty', {}, localize('adeMissionTokenTraceEmpty', "No trace records found.")));
					return;
				}
				for (const entry of entries) {
					const safeEvt = String(entry.event).replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '') || 'evt';
					const row = append(traceListEl, $('.ade-mission-token-trace-row', {
						'data-trace-ptr': entry.ptr,
						'data-trace-event': entry.event,
					}));
					append(row, $(`span.ade-mission-trace-event.evt-${safeEvt}`, {}, entry.event));
					append(row, $('span.ade-mission-trace-node', {}, entry.nodeId));
					if (entry.summary) {
						append(row, $('span.ade-mission-trace-summary', { title: entry.summary }, entry.summary));
					}
				}
			};
			if (traceExpanded) {
				populateTrace();
			}
			contentDisposables.add(addDisposableListener(expandBtn, EventType.CLICK, () => {
				traceExpanded = !traceExpanded;
				traceListEl.hidden = !traceExpanded;
				expandBtn.textContent = traceExpanded
					? localize('adeMissionTokenHideTrace', "Hide Trace")
					: localize('adeMissionTokenExpandTrace', "Expand Trace");
				if (traceExpanded) {
					populateTrace();
				}
				this.clampTopToViewport(bodyRect, anchorRect, 8);
			}));

			// Action bar (Retry with guidance, Recall, Gate Review, Open Session)
			const canRetry = selectedToken.status === 'frozen_failed' || selectedToken.status === 'recalled';
			const canRecall = selectedToken.status === 'active'
				|| selectedToken.status === 'queued'
				|| selectedToken.status === 'blocked'
				|| selectedToken.status === 'waiting_gate'
				|| selectedToken.status === 'waiting_join'
				|| selectedToken.status === 'frozen_failed';
			let guidanceInput: HTMLInputElement | undefined;
			if (canRetry) {
				guidanceInput = append(contentRoot, $('input.ade-mission-emp-popover-input', {
					type: 'text',
					value: guidanceDraftByTokenId.get(selectedToken.id) ?? '',
					placeholder: localize('adeMissionTokenRetryGuidancePlaceholder', "Optional retry guidance for the agent..."),
					'data-ade-token-retry-guidance': 'true',
				})) as HTMLInputElement;
				const activeTokId = selectedToken.id;
				contentDisposables.add(addDisposableListener(guidanceInput, EventType.INPUT, () => {
					if (guidanceInput && guidanceInput.value) {
						guidanceDraftByTokenId.set(activeTokId, guidanceInput.value);
					} else {
						guidanceDraftByTokenId.delete(activeTokId);
					}
				}));
			}

			const actionRow = append(contentRoot, $('.ade-mission-token-actions'));
			const statusErrEl = append(contentRoot, $('.ade-mission-drawer-status.error', {
				hidden: 'true',
				'data-ade-token-action-error': 'true',
			}));

			const reportPopoverError = (msg: string): void => {
				if (openGen !== this.popoverGeneration) {
					return;
				}
				statusErrEl.textContent = msg;
				statusErrEl.hidden = false;
				this.delegate.onActionFeedback?.(msg, 'error');
			};

			if (canRetry) {
				const retryBtn = append(actionRow, $('button.ade-mission-token-action-btn.primary', {
					type: 'button',
					'data-ade-popover-retry': selectedToken.id,
				}, localize('adeMissionTokenRetryAction', "Retry Node"))) as HTMLButtonElement;
				contentDisposables.add(addDisposableListener(retryBtn, EventType.CLICK, () => {
					if (!this.missionRuntimeService) {
						return;
					}
					const guidance = guidanceInput?.value.trim() || undefined;
					void this.missionRuntimeService.retryToken(missionId, {
						caller: { isHumanUser: true },
						tokenId: selectedToken.id,
						nodeId: node.id,
						guidance,
					}).then(res => {
						if (openGen !== this.popoverGeneration) {
							return;
						}
						if (res.ok) {
							this.delegate.onActionFeedback?.(localize('adeMissionRetryOk', "Retried node {0}.", node.id), 'ok');
							this.close();
						} else {
							reportPopoverError(res.error ?? localize('adeMissionRetryFailed', "Retry failed."));
						}
					}, err => reportPopoverError(err instanceof Error ? err.message : String(err)));
				}));
			}

			if (selectedToken.status === 'waiting_gate' && node.kind === 'gate') {
				const gateBtn = append(actionRow, $('button.ade-mission-token-action-btn.primary', {
					type: 'button',
					'data-ade-popover-open-gate': node.id,
				}, localize('adeMissionTokenReviewGateBtn', "Approve / Reject"))) as HTMLButtonElement;
				contentDisposables.add(addDisposableListener(gateBtn, EventType.CLICK, () => {
					this.openGateDecisionPopover(missionId, node, anchorEl, selectedToken.id);
				}));
			}

			if (canRecall) {
				const recallBtn = append(actionRow, $('button.ade-mission-token-action-btn.danger', {
					type: 'button',
					'data-ade-popover-recall': selectedToken.id,
				}, localize('adeMissionTokenRecallAction', "Recall"))) as HTMLButtonElement;
				contentDisposables.add(addDisposableListener(recallBtn, EventType.CLICK, () => {
					if (!this.missionRuntimeService) {
						return;
					}
					void this.missionRuntimeService.recallTokens(missionId, {
						caller: { isHumanUser: true },
						nodeIds: [node.id],
						reason: 'Recalled from Mission token inspector',
					}).then(res => {
						if (openGen !== this.popoverGeneration) {
							return;
						}
						if (res.ok) {
							this.delegate.onActionFeedback?.(localize('adeMissionRecallOk', "Recalled tokens on {0}.", node.id), 'ok');
							this.close();
						} else {
							reportPopoverError(res.error ?? localize('adeMissionRecallFailed', "Recall failed."));
						}
					}, err => reportPopoverError(err instanceof Error ? err.message : String(err)));
				}));
			}

			if (linkedAgentId && this.delegate.onOpenAgentSession) {
				const openAgentBtn = append(actionRow, $('button.ade-mission-token-action-btn', {
					type: 'button',
					'data-ade-popover-open-agent': linkedAgentId,
				}, localize('adeMissionTokenOpenAgentBtn', "Open Agent"))) as HTMLButtonElement;
				contentDisposables.add(addDisposableListener(openAgentBtn, EventType.CLICK, () => {
					this.close();
					this.delegate.onOpenAgentSession?.(linkedAgentId);
				}));
			}

			this.clampTopToViewport(bodyRect, anchorRect, 8);
		};

		renderSelectedToken();
	}

	openGateDecisionPopover(
		missionId: string,
		node: IMissionDagNode,
		anchorEl: HTMLElement,
		preferredTokenId?: string,
		options?: { readonly focusReject?: boolean },
	): void {
		this.close();
		if (!this.missionRuntimeService) {
			return;
		}
		const openGen = ++this.popoverGeneration;
		this.popoverEl.dataset.popoverKind = 'gate';
		this.popoverEl.dataset.popoverNodeId = node.id;
		const { bodyRect, anchorRect } = this.positionNear(anchorEl, 372, 268, 8);

		const rt = this.missionRuntimeService.getRuntimeState(missionId);
		const graph = this.delegate.getMissionGraph?.() ?? { nodes: [node], edges: [] };
		const waitingTokens = Object.values(rt.tokens)
			.filter(t => t.nodeId === node.id && t.status === 'waiting_gate')
			.sort((a, b) => a.arrivedAt - b.arrivedAt);
		let selectedTokenId: string | undefined = (preferredTokenId && waitingTokens.some(t => t.id === preferredTokenId))
			? preferredTokenId
			: waitingTokens[0]?.id;
		const selectedRollbackByTokenId = new Map<string, string>();

		const gateHead = append(this.popoverEl, $('.ade-mission-token-insp-head'));
		const gateHeadLeft = append(gateHead, $('.ade-mission-task-pop-head-left'));
		append(gateHeadLeft, $('span.ade-mission-task-desc-id', {}, node.id));
		append(gateHeadLeft, $('.ade-mission-emp-popover-title', {}, adeBi(
			localize('adeMissionGateSignoffTitle', "Human Gate · {0}", node.label),
			'人工审批门 · {0}',
			node.label,
		)));
		const gateCloseBtn = append(gateHead, $('button.ade-mission-icon-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionCloseGatePop', "Close"), '关闭'),
			'aria-label': adeBi(localize('adeMissionCloseGatePop', "Close"), '关闭'),
		})) as HTMLButtonElement;
		gateCloseBtn.appendChild($('span.codicon.codicon-close'));
		this.popoverDisposables.add(addDisposableListener(gateCloseBtn, EventType.CLICK, () => this.close()));

		const summaryPreviewEl = append(this.popoverEl, $('.ade-mission-gate-summary-preview', {
			'data-ade-gate-summary': 'true',
		}));

		const rollbackFieldEl = append(this.popoverEl, $('.ade-mission-gate-rollback-field', {
			'data-ade-gate-rollback-wrap': 'true',
		}));
		const rollbackSelectId = `ade-gate-rollback-${node.id}`;
		append(rollbackFieldEl, $('label.ade-mission-gate-rollback-label', { for: rollbackSelectId }, adeBi(
			localize('adeMissionGateRollbackLabel', "Rollback Target (on Reject)"),
			'驳回打回目标节点',
		)));
		const rollbackSelectEl = append(rollbackFieldEl, $('select.ade-mission-config-select.ade-mission-gate-rollback-select', {
			id: rollbackSelectId,
			'aria-label': adeBi(localize('adeMissionGateRollbackAria', "Rollback Target Node"), '选择打回目标节点'),
			'data-ade-gate-rollback-select': 'true',
		})) as HTMLSelectElement;

		const syncGatePreview = () => {
			const activeTok = waitingTokens.find(t => t.id === selectedTokenId) ?? waitingTokens[0];
			if (activeTok?.lastSummary?.trim()) {
				summaryPreviewEl.textContent = `${formatMissionWaveTag(activeTok.waveId)}: ${activeTok.lastSummary.trim()}`;
				summaryPreviewEl.hidden = false;
			} else {
				summaryPreviewEl.hidden = true;
			}

			clearNode(rollbackSelectEl);
			const candidates = activeTok
				? collectValidUpstreamRollbackCandidates(rt, graph, node.id, activeTok.tracePtr, activeTok.fromNodeId)
				: [];
			if (candidates.length === 0) {
				rollbackFieldEl.hidden = true;
				return;
			}
			rollbackFieldEl.hidden = false;
			const tokenKey = activeTok?.id ?? '__default__';
			const remembered = selectedRollbackByTokenId.get(tokenKey);
			const defaultTarget = (remembered && candidates.some(c => c.id === remembered))
				? remembered
				: candidates[candidates.length - 1].id;
			selectedRollbackByTokenId.set(tokenKey, defaultTarget);
			const directTag = adeBi(localize('adeMissionGateDirectPredTag', "Direct"), '紧邻上游');
			for (const c of candidates) {
				const optLabel = c.isDirectPredecessor ? `[${c.id}] ${c.title} · ${directTag}` : `[${c.id}] ${c.title}`;
				const opt = append(rollbackSelectEl, $('option', { value: c.id }, optLabel)) as HTMLOptionElement;
				if (c.id === defaultTarget) {
					opt.selected = true;
				}
			}
		};

		this.popoverDisposables.add(addDisposableListener(rollbackSelectEl, EventType.CHANGE, () => {
			const tokenKey = selectedTokenId ?? waitingTokens[0]?.id ?? '__default__';
			if (rollbackSelectEl.value) {
				selectedRollbackByTokenId.set(tokenKey, rollbackSelectEl.value);
			}
		}));

		const waveBtns: HTMLButtonElement[] = [];
		if (waitingTokens.length > 1) {
			const waveBar = append(this.popoverEl, $('.ade-mission-token-wave-switcher', {
				'data-ade-gate-wave-switcher': 'true',
			}));
			for (const tok of waitingTokens) {
				const btn = append(waveBar, $(`button.ade-mission-token-wave-btn${tok.id === selectedTokenId ? '.active' : ''}`, {
					type: 'button',
					'data-ade-gate-wave-btn': tok.id,
				}, `${formatMissionWaveTag(tok.waveId)} (${tok.id})`)) as HTMLButtonElement;
				waveBtns.push(btn);
				this.popoverDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
					selectedTokenId = tok.id;
					for (const b of waveBtns) {
						b.classList.toggle('active', b === btn);
					}
					syncGatePreview();
				}));
			}
		}
		syncGatePreview();

		const noteInput = append(this.popoverEl, $('input.ade-mission-emp-popover-input', {
			type: 'text',
			placeholder: adeBi(localize('adeMissionGateNotePlaceholder', "Optional note or rejection reason..."), '可选：填写审批备注或打回原因...'),
			'data-ade-gate-note': 'true',
		})) as HTMLInputElement;
		const btnRow = append(this.popoverEl, $('.ade-mission-gate-actions'));
		const approveBtn = append(btnRow, $('button.ade-mission-gate-btn.approve', {
			type: 'button',
			'data-ade-gate-approve': node.id,
		}, adeBi(localize('adeMissionGateApproveBtn', "Approve"), '通过'))) as HTMLButtonElement;
		const rejectBtn = append(btnRow, $(`button.ade-mission-gate-btn.reject${options?.focusReject ? '.is-emphasized' : ''}`, {
			type: 'button',
			'data-ade-gate-reject': node.id,
		}, adeBi(localize('adeMissionGateRejectBtn', "Reject & Roll Back"), '驳回并打回'))) as HTMLButtonElement;
		const gateErrEl = append(this.popoverEl, $('.ade-mission-drawer-status.error', {
			hidden: 'true',
			'data-ade-gate-error': 'true',
		}));

		let inFlight = false;
		const setBusy = (busy: boolean) => {
			inFlight = busy;
			approveBtn.disabled = busy;
			rejectBtn.disabled = busy;
			rollbackSelectEl.disabled = busy;
			for (const b of waveBtns) {
				b.disabled = busy;
			}
		};
		const handleGateResult = (res: { readonly ok: boolean; readonly error?: string } | undefined) => {
			if (openGen !== this.popoverGeneration) {
				return;
			}
			setBusy(false);
			if (res?.ok) {
				this.close();
			} else {
				const msg = res?.error ?? adeBi(localize('adeMissionGateFailed', "Gate decision failed."), '审批决策提交失败。');
				gateErrEl.textContent = msg;
				gateErrEl.hidden = false;
				this.delegate.onActionFeedback?.(msg, 'error');
			}
		};
		const handleGateReject = (err: unknown) => {
			if (openGen !== this.popoverGeneration) {
				return;
			}
			setBusy(false);
			const msg = err instanceof Error ? err.message : adeBi(localize('adeMissionGateFailed', "Gate decision failed."), '审批决策提交失败。');
			gateErrEl.textContent = msg;
			gateErrEl.hidden = false;
			this.delegate.onActionFeedback?.(msg, 'error');
		};
		this.popoverDisposables.add(addDisposableListener(approveBtn, EventType.CLICK, () => {
			if (inFlight) {
				return;
			}
			if (!this.missionRuntimeService) {
				handleGateReject(new Error(adeBi(localize('adeMissionGateRuntimeUnavailable', "Mission runtime is unavailable."), '任务运行时不可用。')));
				return;
			}
			setBusy(true);
			void this.missionRuntimeService.resolveGate(missionId, {
				nodeId: node.id,
				tokenId: selectedTokenId,
				decision: 'approve',
				note: noteInput.value.trim() || undefined,
			}).then(handleGateResult, handleGateReject);
		}));
		this.popoverDisposables.add(addDisposableListener(rejectBtn, EventType.CLICK, () => {
			if (inFlight) {
				return;
			}
			if (!this.missionRuntimeService) {
				handleGateReject(new Error(adeBi(localize('adeMissionGateRuntimeUnavailable', "Mission runtime is unavailable."), '任务运行时不可用。')));
				return;
			}
			setBusy(true);
			const chosenRollback = !rollbackFieldEl.hidden && rollbackSelectEl.value
				? rollbackSelectEl.value
				: undefined;
			void this.missionRuntimeService.resolveGate(missionId, {
				nodeId: node.id,
				tokenId: selectedTokenId,
				decision: 'reject',
				rollbackNodeId: chosenRollback,
				note: noteInput.value.trim() || undefined,
			}).then(handleGateResult, handleGateReject);
		}));
		this.clampTopToViewport(bodyRect, anchorRect, 8);
		if (options?.focusReject && !rollbackFieldEl.hidden) {
			rollbackSelectEl.focus();
		} else {
			noteInput.focus();
		}
	}

	openSupervisorPopover(missionId: string, node: IMissionDagNode, anchorEl: HTMLElement): void {
		this.close();
		if (!this.missionRuntimeService) {
			return;
		}
		const openGen = ++this.popoverGeneration;
		this.popoverEl.dataset.popoverKind = 'supervisor';
		this.popoverEl.dataset.popoverNodeId = node.id;
		const { bodyRect, anchorRect } = this.positionNear(anchorEl, 290, 260, 6);

		const rt = this.missionRuntimeService.getRuntimeState(missionId);
		const org = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const inGraphAgentIds = new Set(
			Object.values(rt.boundary.nodeAssignments)
				.map(a => a.agentId)
				.filter((id): id is string => Boolean(id)),
		);
		const currentSup = rt.boundary.supervisors.find(s => s.managedNodeIds.includes(node.id));
		const managedCountBySup = new Map<string, number>();
		for (const sup of rt.boundary.supervisors) {
			managedCountBySup.set(sup.id, sup.managedNodeIds.length);
		}

		const header = append(this.popoverEl, $('.ade-mission-token-insp-head'));
		append(header, $('.ade-mission-emp-popover-title', {}, localize('adeMissionSupPopoverTitle', "Off-graph Supervisor · {0}", node.id)));
		append(header, $('span.ade-mission-token-meta-chip', {}, rt.boundary.offGraphMaxTier === 0 ? 'Wall L0' : `Wall L0..L${rt.boundary.offGraphMaxTier}`));

		const list = append(this.popoverEl, $('.ade-mission-emp-popover-list'));
		const errEl = append(this.popoverEl, $('.ade-mission-drawer-status.error', {
			hidden: 'true',
			'data-ade-sup-error': 'true',
		}));

		const eligibleSupervisors: { readonly id: string; readonly label: string; readonly tier: number }[] = [
			{ id: ADE_SECRETARY_ID, label: 'Secretary', tier: 0 },
		];
		for (const agent of this.projectsService?.agents ?? []) {
			if (this.projectsService?.isArchived(agent.id) || inGraphAgentIds.has(agent.id) || agent.treeNodeId) {
				continue;
			}
			const liveTier = resolveEffectiveRankDefinition(org, agent.role, this.projectsService?.hasSubordinates(agent.id) ?? false).tier;
			if (liveTier <= rt.boundary.offGraphMaxTier) {
				eligibleSupervisors.push({ id: agent.id, label: agent.label, tier: liveTier });
			}
		}

		const applySupervisorChoice = (selectedId: string, tier?: number): void => {
			if (!this.missionRuntimeService) {
				return;
			}
			const latestRt = this.missionRuntimeService.getRuntimeState(missionId);
			const updated: IMissionSupervisorBinding[] = [];
			let foundSelected = false;
			for (const existingSup of latestRt.boundary.supervisors) {
				const withoutNode = existingSup.managedNodeIds.filter(nid => nid !== node.id);
				if (selectedId && existingSup.id === selectedId) {
					foundSelected = true;
					updated.push({ ...existingSup, managedNodeIds: [...withoutNode, node.id] });
				} else if (withoutNode.length > 0 || existingSup.managedNodeIds.length === 0) {
					updated.push({ ...existingSup, managedNodeIds: withoutNode });
				}
			}
			if (selectedId && !foundSelected) {
				updated.push({ id: selectedId, tier: tier ?? 0, managedNodeIds: [node.id] });
			}
			void this.missionRuntimeService.setBoundary(missionId, { supervisors: updated }).then(res => {
				if (openGen !== this.popoverGeneration) {
					return;
				}
				if (res.ok) {
					this.close();
					this.delegate.onGraphVisualInvalidated(false);
					this.delegate.onRuntimeControlsInvalidated();
				} else {
					const msg = res.error ?? localize('adeMissionSupervisorBindFailed', "Failed to bind supervisor.");
					errEl.textContent = msg;
					errEl.hidden = false;
					this.delegate.onActionFeedback?.(msg, 'error');
				}
			}, err => {
				if (openGen !== this.popoverGeneration) {
					return;
				}
				const msg = err instanceof Error ? err.message : localize('adeMissionSupervisorBindFailed', "Failed to bind supervisor.");
				errEl.textContent = msg;
				errEl.hidden = false;
				this.delegate.onActionFeedback?.(msg, 'error');
			});
		};

		// Auto (Mission Owner) option
		const autoBtn = append(list, $(`button.ade-mission-emp-popover-item${!currentSup ? '.active' : ''}`, {
			type: 'button',
			'data-ade-sup-option': '',
		})) as HTMLButtonElement;
		append(autoBtn, $('span', {}, localize('adeMissionSupervisorAuto', "Auto (Mission Owner)")));
		if (!currentSup) {
			append(autoBtn, $('span.codicon.codicon-check', { 'aria-hidden': 'true' }));
		}
		this.popoverDisposables.add(addDisposableListener(autoBtn, EventType.CLICK, () => applySupervisorChoice('')));

		for (const sup of eligibleSupervisors) {
			const isCurrent = currentSup?.id === sup.id;
			const colorIdx = getMissionSupervisorColorIndex(sup.id);
			const btn = append(list, $(`button.ade-mission-emp-popover-item${isCurrent ? '.active' : ''}`, {
				type: 'button',
				'data-ade-sup-option': sup.id,
			})) as HTMLButtonElement;
			const lead = append(btn, $('.ade-mission-sup-option-lead'));
			append(lead, $(`span.ade-mission-sup-dot.sup-color-${colorIdx}`, { 'aria-hidden': 'true' }));
			append(lead, $('span', {}, `${sup.label} (${formatTierTag(sup.tier)})`));
			const count = managedCountBySup.get(sup.id) ?? 0;
			append(btn, $('span.ade-mission-emp-popover-meta', {}, count > 0 ? localize('adeMissionSupNodeCount', "{0} node(s)", count) : ''));
			this.popoverDisposables.add(addDisposableListener(btn, EventType.CLICK, () => applySupervisorChoice(sup.id, sup.tier)));
			this.popoverDisposables.add(addDisposableListener(btn, 'pointerenter', () => this.delegate.onHoverSupervisor?.(sup.id)));
			this.popoverDisposables.add(addDisposableListener(btn, 'pointerleave', () => this.delegate.onHoverSupervisor?.(undefined)));
		}

		// Configure parentSupervisorId (上级监工) right from the node's Supervisor popover when currentSup has tier > 0!
		if (currentSup && currentSup.tier > 0) {
			const higherPool = [...eligibleSupervisors];
			for (const s of rt.boundary.supervisors) {
				if (!higherPool.some(c => c.id === s.id)) {
					const d = this.delegate.resolveSupervisorDisplay?.(s.id) ?? { label: s.id, shortLabel: s.id, tier: s.tier };
					higherPool.push({ id: s.id, label: d.label, tier: s.tier });
				}
			}
			const higherCandidates = higherPool.filter(cand => cand.id !== currentSup.id && cand.tier < currentSup.tier);
			if (currentSup.parentSupervisorId && !higherCandidates.some(c => c.id === currentSup.parentSupervisorId)) {
				const d = this.delegate.resolveSupervisorDisplay?.(currentSup.parentSupervisorId) ?? { label: currentSup.parentSupervisorId, shortLabel: currentSup.parentSupervisorId, tier: 0 };
				higherCandidates.push({ id: currentSup.parentSupervisorId, label: d.label, tier: d.tier });
			}
			const parentSection = append(this.popoverEl, $('.ade-mission-host-section'));
			append(parentSection, $('.ade-mission-emp-popover-title', {}, adeBi(localize('adeMissionSupParentTitle', "Escalation Parent"), '上级监工 (Escalation Parent)')));
			const parentSelect = append(parentSection, $('select.ade-mission-config-select.full', {
				'data-ade-sup-parent-select': currentSup.id,
				'aria-label': localize('adeMissionSupParentAria', "Parent supervisor for {0}", currentSup.id),
			})) as HTMLSelectElement;
			const noneOpt = append(parentSelect, $('option', { value: '' }, adeBi(localize('adeMissionSupParentHumanInbox', "Human Inbox (Top-Level Escalation)"), 'Human Inbox (顶层直报人工)'))) as HTMLOptionElement;
			if (!currentSup.parentSupervisorId) {
				noneOpt.selected = true;
			}
			for (const cand of higherCandidates) {
				const opt = append(parentSelect, $('option', { value: cand.id }, `${cand.label} (${formatTierTag(cand.tier)})`)) as HTMLOptionElement;
				if (currentSup.parentSupervisorId === cand.id) {
					opt.selected = true;
				}
			}
			this.popoverDisposables.add(addDisposableListener(parentSelect, EventType.CHANGE, () => {
				if (!this.missionRuntimeService) {
					return;
				}
				const nextParentId = parentSelect.value.trim() || undefined;
				const latestRt = this.missionRuntimeService.getRuntimeState(missionId);
				if (!latestRt.boundary.supervisors.some(s => s.id === currentSup.id)) {
					return;
				}
				const updated: IMissionSupervisorBinding[] = latestRt.boundary.supervisors.map(s =>
					s.id === currentSup.id
						? { ...s, parentSupervisorId: nextParentId }
						: s,
				);
				// Boundary invariant requires parentSupervisorId to exist in boundary.supervisors
				if (nextParentId && !updated.some(s => s.id === nextParentId)) {
					const parentMeta = higherCandidates.find(c => c.id === nextParentId);
					updated.push({ id: nextParentId, tier: parentMeta?.tier ?? 0, managedNodeIds: [] });
				}
				void this.missionRuntimeService.setBoundary(missionId, { supervisors: updated }).then(res => {
					if (openGen !== this.popoverGeneration) {
						return;
					}
					if (res.ok) {
						this.delegate.onGraphVisualInvalidated(false);
						this.delegate.onRuntimeControlsInvalidated();
						this.openSupervisorPopover(missionId, node, anchorEl);
					} else {
						const msg = res.error ?? localize('adeMissionSupParentSaveFail', "Failed to update parent supervisor.");
						errEl.textContent = msg;
						errEl.hidden = false;
						this.delegate.onActionFeedback?.(msg, 'error');
					}
				}, err => {
					if (openGen !== this.popoverGeneration) {
						return;
					}
					const msg = err instanceof Error ? err.message : localize('adeMissionSupParentSaveFail', "Failed to update parent supervisor.");
					errEl.textContent = msg;
					errEl.hidden = false;
				});
			}));
		}

		this.clampTopToViewport(bodyRect, anchorRect, 6);
	}

	openTriggersPopover(
		missionId: string,
		nodes: readonly IMissionDagNode[],
		edges: readonly IMissionDagEdge[],
		anchorEl: HTMLElement,
		preferredNodeId?: string,
	): void {
		this.close();
		if (!this.missionRuntimeService) {
			return;
		}
		const openGen = ++this.popoverGeneration;
		this.popoverEl.classList.add('is-triggers-popover');
		this.popoverEl.dataset.popoverKind = 'triggers';
		const { bodyRect, anchorRect } = this.positionNear(anchorEl, 408, 420, 8);

		const inDeg = new Map<string, number>();
		const outDeg = new Map<string, number>();
		for (const e of edges) {
			outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
			inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
		}
		const sourceNodes = nodes.filter(n => n.kind !== 'gate' && (inDeg.get(n.id) ?? 0) === 0 && (outDeg.get(n.id) ?? 0) >= 1);

		const contentDisposables = this.popoverDisposables.add(new DisposableStore());
		const container = append(this.popoverEl, $('.ade-mission-triggers-studio'));
		let studioRenderGen = 0;

		const renderStudio = (): void => {
			const myRenderGen = ++studioRenderGen;
			contentDisposables.clear();
			clearNode(container);
			if (!this.missionRuntimeService) {
				return;
			}
			const triggers = this.missionRuntimeService.listTriggers(missionId);
			const missionStatus = this.missionRuntimeService.getRuntimeState(missionId).status;

			const head = append(container, $('.ade-mission-token-insp-head'));
			append(head, $('.ade-mission-emp-popover-title', {}, localize('adeMissionTriggersTitle', "Zero-Token Source Triggers ({0})", triggers.length)));
			const closeBtn = append(head, $('button.ade-mission-icon-btn', {
				type: 'button',
				title: localize('adeMissionTriggersClose', "Close"),
			})) as HTMLButtonElement;
			closeBtn.appendChild($('span.codicon.codicon-close'));
			contentDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.close()));

			const listWrap = append(container, $('.ade-mission-triggers-list', {
				'data-ade-triggers-list': 'true',
			}));
			if (triggers.length === 0) {
				append(listWrap, $('.ade-mission-ni-muted-hint', {}, localize('adeMissionTriggersEmpty', "No source triggers configured yet. Add an interval, cron, one-shot, file, git, or GPU-idle trigger below.")));
			} else {
				for (const trig of triggers) {
					const row = append(listWrap, $(`.ade-mission-trigger-row${trig.enabled ? '' : '.is-disabled'}`, {
						'data-ade-trigger-row': trig.id,
					}));
					const info = append(row, $('.ade-mission-trigger-row-info'));
					const topLine = append(info, $('.ade-mission-trigger-row-top'));
					append(topLine, $('span.ade-mission-ni-node-id', {}, trig.nodeId));
					append(topLine, $('span.ade-mission-token-meta-chip.wave', {}, trig.kind));
					append(topLine, $('span.ade-mission-trigger-row-spec', {}, formatMissionTriggerShortLabel(trig)));
					const trigState = !trig.enabled ? 'paused' : (missionStatus === 'running' ? 'armed' : 'standby');
					const trigStateLabel = trigState === 'armed'
						? adeBi(localize('adeMissionTrigStateArmed', "● Armed"), '● 监听中')
						: trigState === 'standby'
							? adeBi(localize('adeMissionTrigStateStandby', "◐ Standby"), '◐ 待命')
							: adeBi(localize('adeMissionTrigStatePaused', "○ Paused"), '○ 已暂停');
					append(topLine, $(`span.ade-mission-trigger-state-chip.state-${trigState}`, {
						'data-ade-trigger-status': trig.id,
						'data-trigger-state': trigState,
					}, trigStateLabel));
					const metaBits = [
						trig.targetPath ? trig.targetPath : undefined,
						trig.hostAlias ? `@${trig.hostAlias}` : undefined,
						trig.autoStartOnMissionStart ? localize('adeMissionTrigAutoStartTag', "auto-start") : undefined,
						localize('adeMissionTrigFiredCount', "fired {0}×", trig.fireCount),
					].filter((v): v is string => Boolean(v));
					append(info, $('.ade-mission-trigger-row-sub', {}, metaBits.join(' · ')));

					const rowActions = append(row, $('.ade-mission-trigger-row-actions'));
					const toggleBtn = append(rowActions, $('button.ade-mission-ni-mini-btn', {
						type: 'button',
						'data-ade-trigger-toggle': trig.id,
					}, trig.enabled ? localize('adeMissionTrigDisable', "Pause") : localize('adeMissionTrigEnable', "Enable"))) as HTMLButtonElement;
					contentDisposables.add(addDisposableListener(toggleBtn, EventType.CLICK, () => {
						void this.missionRuntimeService?.setTrigger(missionId, { ...trig, enabled: !trig.enabled }, { isHumanUser: true }).then(res => {
							if (openGen !== this.popoverGeneration) {
								return;
							}
							if (res.ok) {
								this.delegate.onGraphVisualInvalidated(false);
								this.delegate.onRuntimeControlsInvalidated();
								renderStudio();
							} else if (res.error) {
								errEl.textContent = res.error;
								errEl.hidden = false;
							}
						});
					}));

					const delBtn = append(rowActions, $('button.ade-mission-icon-btn.danger', {
						type: 'button',
						title: localize('adeMissionTrigDelete', "Delete Trigger"),
						'data-ade-trigger-delete': trig.id,
					})) as HTMLButtonElement;
					delBtn.appendChild($('span.codicon.codicon-trash'));
					contentDisposables.add(addDisposableListener(delBtn, EventType.CLICK, () => {
						void this.missionRuntimeService?.removeTrigger(missionId, trig.id, { isHumanUser: true }).then(res => {
							if (openGen !== this.popoverGeneration) {
								return;
							}
							if (res.ok) {
								this.delegate.onGraphVisualInvalidated(false);
								this.delegate.onRuntimeControlsInvalidated();
								renderStudio();
							} else if (res.error) {
								errEl.textContent = res.error;
								errEl.hidden = false;
							}
						});
					}));
				}
			}

			// Add Trigger Form
			const form = append(container, $('.ade-mission-trigger-form'));
			append(form, $('.ade-mission-emp-popover-title', {}, localize('adeMissionTrigAddTitle', "Add Source Trigger")));

			const errEl = append(form, $('.ade-mission-drawer-status.error', {
				hidden: 'true',
				'data-ade-trigger-error': 'true',
			}));

			if (sourceNodes.length === 0) {
				append(form, $('.ade-mission-ni-muted-hint', {}, localize('adeMissionTrigNoEntryNodes', "No eligible source generator nodes found (requires a task node with inDegree = 0 and outDegree ≥ 1).")));
				this.clampTopToViewport(bodyRect, anchorRect, 8);
				return;
			}

			const row1 = append(form, $('.ade-mission-trigger-form-row'));
			const nodeSelect = append(row1, $('select.ade-mission-config-select', {
				'data-ade-trigger-node-select': 'true',
			})) as HTMLSelectElement;
			for (const sn of sourceNodes) {
				const opt = append(nodeSelect, $('option', { value: sn.id }, `${sn.id} · ${sn.label}`)) as HTMLOptionElement;
				if (preferredNodeId && sn.id === preferredNodeId) {
					opt.selected = true;
				}
			}

			const kindSelect = append(row1, $('select.ade-mission-config-select', {
				'data-ade-trigger-kind-select': 'true',
			})) as HTMLSelectElement;
			const kinds: readonly { readonly value: MissionSourceTriggerKind; readonly label: string }[] = [
				{ value: 'interval', label: localize('adeMissionTrigKindInterval', "Interval") },
				{ value: 'cron', label: localize('adeMissionTrigKindCron', "Cron") },
				{ value: 'event', label: localize('adeMissionTrigKindEvent', "Event (File/Git/GPU)") },
				{ value: 'once', label: localize('adeMissionTrigKindOnce', "One-Shot") },
			];
			for (const k of kinds) {
				append(kindSelect, $('option', { value: k.value }, k.label));
			}

			// Dynamic kind-specific fields
			const intervalInput = append(form, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				value: '5m',
				placeholder: localize('adeMissionTrigIntervalPh', "Interval duration (e.g. 30s, 5m, 1h)"),
				'data-ade-trigger-interval-input': 'true',
			})) as HTMLInputElement;

			const cronInput = append(form, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				value: '*/5 * * * *',
				placeholder: localize('adeMissionTrigCronPh', "5-field cron (e.g. */5 * * * *)"),
				'data-ade-trigger-cron-input': 'true',
			})) as HTMLInputElement;

			const onceInput = append(form, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				value: '10m',
				placeholder: localize('adeMissionTrigOncePh', "Delay (e.g. 10m) or ISO time (2026-11-22T09:00)"),
				'data-ade-trigger-once-input': 'true',
			})) as HTMLInputElement;

			const eventFields = append(form, $('.ade-mission-trigger-event-fields'));
			const eventTypeSelect = append(eventFields, $('select.ade-mission-config-select.full', {
				'data-ade-trigger-event-type': 'true',
			})) as HTMLSelectElement;
			const eventTypes: readonly { readonly value: MissionExternalEventType; readonly label: string }[] = [
				{ value: 'file_created', label: localize('adeMissionTrigEvtFileCreated', "File Created") },
				{ value: 'file_changed', label: localize('adeMissionTrigEvtFileChanged', "File Changed") },
				{ value: 'git_updated', label: localize('adeMissionTrigEvtGitUpdated', "Git HEAD Updated") },
				{ value: 'gpu_idle', label: localize('adeMissionTrigEvtGpuIdle', "GPU Idle (%)") },
			];
			for (const et of eventTypes) {
				append(eventTypeSelect, $('option', { value: et.value }, et.label));
			}

			const pathInput = append(eventFields, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				placeholder: localize('adeMissionTrigPathPh', "Target file or Git repository path..."),
				'data-ade-trigger-path-input': 'true',
			})) as HTMLInputElement;

			const gpuInput = append(eventFields, $('input.ade-mission-emp-popover-input', {
				type: 'number',
				min: '0',
				max: '100',
				value: '10',
				placeholder: localize('adeMissionTrigGpuPh', "GPU utilization ceiling % (e.g. 10)"),
				'data-ade-trigger-gpu-input': 'true',
			})) as HTMLInputElement;

			const hostSelect = append(eventFields, $('select.ade-mission-config-select.full', {
				'data-ade-trigger-host-select': 'true',
			})) as HTMLSelectElement;
			append(hostSelect, $('option', { value: 'local' }, localize('adeMissionHostLocal', "Local Machine")));
			if (this.cloudHostService) {
				void this.cloudHostService.listHosts().then(hosts => {
					if (!hostSelect.isConnected || openGen !== this.popoverGeneration) {
						return;
					}
					for (const h of hosts) {
						append(hostSelect, $('option', { value: h.alias }, `${h.name} (${h.alias})`));
					}
				}).catch(() => undefined);
			}

			const syncKindFields = () => {
				const kind = kindSelect.value as MissionSourceTriggerKind;
				intervalInput.hidden = kind !== 'interval';
				cronInput.hidden = kind !== 'cron';
				onceInput.hidden = kind !== 'once';
				eventFields.hidden = kind !== 'event';
				const evType = eventTypeSelect.value as MissionExternalEventType;
				pathInput.hidden = evType === 'gpu_idle';
				gpuInput.hidden = evType !== 'gpu_idle';
				this.clampTopToViewport(bodyRect, anchorRect, 8);
			};
			contentDisposables.add(addDisposableListener(kindSelect, EventType.CHANGE, syncKindFields));
			contentDisposables.add(addDisposableListener(eventTypeSelect, EventType.CHANGE, syncKindFields));

			const footerRow = append(form, $('.ade-mission-trigger-form-footer'));
			const autoStartLabel = append(footerRow, $('label.ade-mission-trigger-check'));
			const autoStartCheckbox = append(autoStartLabel, $('input', {
				type: 'checkbox',
				'data-ade-trigger-autostart': 'true',
			})) as HTMLInputElement;
			append(autoStartLabel, $('span', {}, localize('adeMissionTrigAutoStartLabel', "Fire immediately on Start")));

			const submitBtn = append(footerRow, $('button.ade-mission-token-action-btn.primary', {
				type: 'button',
				'data-ade-trigger-submit': 'true',
			}, localize('adeMissionTrigSubmitBtn', "+ Add Trigger"))) as HTMLButtonElement;

			let submitting = false;
			contentDisposables.add(addDisposableListener(submitBtn, EventType.CLICK, () => {
				if (submitting) {
					return;
				}
				errEl.hidden = true;
				const kind = kindSelect.value as MissionSourceTriggerKind;
				const nodeId = nodeSelect.value;
				const base: Partial<IMissionSourceTrigger> & { readonly nodeId: string; readonly kind: MissionSourceTriggerKind } = {
					nodeId,
					kind,
					enabled: true,
					autoStartOnMissionStart: autoStartCheckbox.checked,
				};
				let payload = base;
				if (kind === 'interval') {
					const parsedMs = parseDurationMs(intervalInput.value.trim());
					if (!parsedMs || parsedMs < 5000) {
						errEl.textContent = localize('adeMissionTrigBadInterval', "Interval must be at least 5s (e.g. 30s, 5m, 1h).");
						errEl.hidden = false;
						return;
					}
					payload = { ...base, intervalMs: parsedMs };
				} else if (kind === 'cron') {
					const expr = cronInput.value.trim();
					if (expr.split(/\s+/).filter(Boolean).length !== 5) {
						errEl.textContent = localize('adeMissionTrigBadCron', "Cron expression must have 5 space-separated fields (e.g. */5 * * * *).");
						errEl.hidden = false;
						return;
					}
					payload = { ...base, cronExpr: expr };
				} else if (kind === 'once') {
					const raw = onceInput.value.trim();
					const relMs = parseDurationMs(raw);
					const fireAt = relMs && relMs > 0 ? Date.now() + relMs : Date.parse(raw);
					if (!Number.isFinite(fireAt)) {
						errEl.textContent = localize('adeMissionTrigBadOnce', "Enter a valid delay (e.g. 10m) or ISO timestamp.");
						errEl.hidden = false;
						return;
					}
					payload = { ...base, fireAt };
				} else if (kind === 'event') {
					const evType = eventTypeSelect.value as MissionExternalEventType;
					const gpuPct = Number.parseFloat(gpuInput.value || '10');
					payload = {
						...base,
						eventType: evType,
						targetPath: evType === 'gpu_idle' ? undefined : (pathInput.value.trim() || undefined),
						hostAlias: hostSelect.value || 'local',
						gpuUtilThresholdPct: evType === 'gpu_idle' && Number.isFinite(gpuPct) ? gpuPct : undefined,
					};
				}

				submitting = true;
				submitBtn.disabled = true;
				void this.missionRuntimeService?.setTrigger(missionId, payload, { isHumanUser: true }).then(res => {
					if (openGen !== this.popoverGeneration || myRenderGen !== studioRenderGen) {
						return;
					}
					submitting = false;
					submitBtn.disabled = false;
					if (res.ok) {
						this.delegate.onGraphVisualInvalidated(false);
						this.delegate.onRuntimeControlsInvalidated();
						this.delegate.onActionFeedback?.(localize('adeMissionTrigSavedOk', "Saved {0} trigger on {1}.", kind, nodeId), 'ok');
						renderStudio();
					} else {
						const msg = res.error ?? localize('adeMissionTrigSaveFail', "Failed to add trigger.");
						errEl.textContent = msg;
						errEl.hidden = false;
						this.delegate.onActionFeedback?.(msg, 'error');
					}
				}, err => {
					if (openGen !== this.popoverGeneration || myRenderGen !== studioRenderGen) {
						return;
					}
					submitting = false;
					submitBtn.disabled = false;
					const msg = err instanceof Error ? err.message : String(err);
					errEl.textContent = msg;
					errEl.hidden = false;
				});
			}));

			syncKindFields();
		};

		renderStudio();
	}

	openGuidedRetryPopover(
		_missionId: string,
		node: IMissionDagNode,
		token: IMissionToken,
		anchorEl: HTMLElement,
	): void {
		this.close();
		this.popoverGeneration++;
		this.popoverEl.dataset.popoverKind = 'guided-retry';
		this.popoverEl.dataset.popoverNodeId = node.id;
		const { bodyRect, anchorRect } = this.positionNear(anchorEl, 340, 210, 6);

		const head = append(this.popoverEl, $('.ade-mission-token-insp-head'));
		append(head, $('.ade-mission-emp-popover-title', {}, adeBi(
			localize('adeMissionGuidedRetryTitle', "Guided Retry · {0} ({1})", node.id, formatMissionWaveTag(token.waveId)),
			'带指导重试 · {0} ({1})',
			node.id,
			formatMissionWaveTag(token.waveId),
		)));
		const closeBtn = append(head, $('button.ade-mission-icon-btn', { type: 'button', title: localize('adeMissionClose', "Close") })) as HTMLButtonElement;
		closeBtn.appendChild($('span.codicon.codicon-close'));
		this.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.close()));

		const failReason = token.failure?.reason?.trim() || token.lastCheckFailure?.summary?.trim();
		if (failReason) {
			const box = append(this.popoverEl, $('.ade-mission-token-box.is-failed'));
			append(box, $('.ade-mission-token-box-body', {}, failReason));
		}

		const input = append(this.popoverEl, $('textarea.ade-mission-node-prompt-popover-input', {
			rows: '3',
			placeholder: adeBi(
				localize('adeMissionGuidedRetryPh', "Enter corrective guidance (e.g. lower batch_size to 16, fix type errors before running tests…)"),
				'输入纠偏指导（如：降 batch_size 到 16、先修复类型错误再跑单测…）',
			),
			'data-ade-guided-retry-input': 'true',
		})) as HTMLTextAreaElement;

		const actions = append(this.popoverEl, $('.ade-mission-token-actions'));
		const submitBtn = append(actions, $('button.ade-mission-token-action-btn.primary', {
			type: 'button',
			'data-ade-guided-retry-submit': token.id,
		}, adeBi(localize('adeMissionGuidedRetrySubmit', "Guided Retry"), '带指导重试'))) as HTMLButtonElement;

		const doSubmit = () => {
			const guidance = input.value.trim() || undefined;
			this.close();
			void this.delegate.onQuickRetryNode?.(node, token, guidance);
		};
		this.popoverDisposables.add(addDisposableListener(submitBtn, EventType.CLICK, doSubmit));
		this.popoverDisposables.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
				e.preventDefault();
				doSubmit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this.close();
			}
		}));

		this.clampTopToViewport(bodyRect, anchorRect, 6);
		input.focus();
	}

	private renderNodeColorPickerSection(
		parentEl: HTMLElement,
		currentColor: string | undefined,
		onSelectColor: (color: string | null) => void,
		options?: { readonly closeOnPick?: boolean; readonly compact?: boolean },
	): void {
		const activeNorm = normalizeAdeNodeColor(currentColor);
		const activeHex = resolveAdeNodeColorHex(activeNorm);
		const wrap = append(parentEl, $(`.ade-node-color-picker${options?.compact ? '.is-compact' : ''}`, {
			'data-ade-node-color-picker': 'true',
		}));
		const headRow = append(wrap, $('.ade-node-color-picker-head'));
		append(headRow, $('span.ade-node-color-picker-label', {}, adeBi(localize('adeNodeColorLabel', "Node Color"), '节点颜色')));
		const resetBtn = append(headRow, $(`button.ade-node-color-reset${!activeNorm ? '.is-active' : ''}`, {
			type: 'button',
			'data-ade-color-reset': 'true',
			title: adeBi(localize('adeNodeColorResetTip', "Reset to default theme color"), '恢复默认配色'),
		}, adeBi(localize('adeNodeColorDefault', "Auto"), '默认'))) as HTMLButtonElement;

		const grid = append(wrap, $('.ade-node-color-swatches'));
		const swatchBtns: Array<{ readonly id: string; readonly btn: HTMLButtonElement }> = [];
		const updateActiveRing = (nextNorm: string | undefined) => {
			resetBtn.classList.toggle('is-active', !nextNorm);
			for (const entry of swatchBtns) {
				entry.btn.classList.toggle('is-active', entry.id === nextNorm);
			}
		};

		this.popoverDisposables.add(addDisposableListener(resetBtn, EventType.CLICK, e => {
			e.stopPropagation();
			updateActiveRing(undefined);
			onSelectColor(null);
			if (options?.closeOnPick) {
				this.close();
			}
		}));

		for (const preset of ADE_NODE_COLOR_PRESETS) {
			const isSelected = activeNorm === preset.id;
			const btn = append(grid, $(`button.ade-node-color-swatch${isSelected ? '.is-active' : ''}`, {
				type: 'button',
				'data-ade-color-swatch': preset.id,
				'aria-label': adeBi(preset.labelEn, preset.labelZh),
				title: adeBi(preset.labelEn, preset.labelZh),
			})) as HTMLButtonElement;
			btn.style.setProperty('--swatch-hex', preset.hex);
			swatchBtns.push({ id: preset.id, btn });
			this.popoverDisposables.add(addDisposableListener(btn, EventType.CLICK, e => {
				e.stopPropagation();
				updateActiveRing(preset.id);
				onSelectColor(preset.id);
				if (options?.closeOnPick) {
					this.close();
				}
			}));
		}

		// Custom arbitrary hex color picker button
		const customWrap = append(grid, $('label.ade-node-color-custom-wrap', {
			title: adeBi(localize('adeNodeColorCustomTip', "Pick custom hex color…"), '自定义色盘颜色…'),
		}));
		const customInput = append(customWrap, $('input.ade-node-color-custom-input', {
			type: 'color',
			value: activeHex ?? '#38bdf8',
			'data-ade-color-custom': 'true',
		})) as HTMLInputElement;
		this.popoverDisposables.add(addDisposableListener(customWrap, EventType.CLICK, e => e.stopPropagation()));
		this.popoverDisposables.add(addDisposableListener(customInput, EventType.CHANGE, e => {
			e.stopPropagation();
			const hex = normalizeAdeNodeColor(customInput.value);
			if (hex) {
				updateActiveRing(hex);
				onSelectColor(hex);
				if (options?.closeOnPick) {
					this.close();
				}
			}
		}));
	}

	openNodeColorPopover(
		nodeLabel: string,
		currentColor: string | undefined,
		anchorEl: HTMLElement,
		onSelectColor: (color: string | null) => void,
	): void {
		this.close();
		this.popoverGeneration++;
		this.popoverEl.classList.add('is-color-popover');
		this.popoverEl.dataset.popoverKind = 'node-color';
		const { bodyRect, anchorRect } = this.positionNear(anchorEl, 246, 134, 8);
		this.popoverDisposables.add(addDisposableListener(this.popoverEl, EventType.POINTER_DOWN, e => e.stopPropagation()));

		const head = append(this.popoverEl, $('.ade-mission-token-insp-head'));
		append(head, $('.ade-mission-emp-popover-title', {}, nodeLabel));
		const closeBtn = append(head, $('button.ade-mission-icon-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionClose', "Close"), '关闭'),
		})) as HTMLButtonElement;
		closeBtn.appendChild($('span.codicon.codicon-close'));
		this.popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.close()));

		this.renderNodeColorPickerSection(this.popoverEl, currentColor, onSelectColor, { closeOnPick: false });
		this.clampTopToViewport(bodyRect, anchorRect, 8);
	}

	openCanvasContextMenu(
		clientX: number,
		clientY: number,
		items: readonly {
			readonly id: string;
			readonly label: string;
			readonly icon?: string;
			readonly danger?: boolean;
			readonly disabled?: boolean;
			readonly separatorBefore?: boolean;
			readonly run: () => void;
		}[],
		options?: {
			readonly colorPicker?: {
				readonly currentColor?: string;
				readonly onSelectColor: (color: string | null) => void;
			};
		},
	): void {
		this.close();
		this.popoverGeneration++;
		this.popoverEl.classList.add('is-context-menu');
		this.popoverEl.dataset.popoverKind = 'context-menu';
		this.popoverEl.dataset.adeCanvasContextMenu = 'true';

		const bodyRect = this.bodyEl.getBoundingClientRect();
		const hasPicker = Boolean(options?.colorPicker);
		const menuW = hasPicker ? 228 : 184;
		const estH = Math.min(410, items.length * 28 + 16 + (hasPicker ? 82 : 0));
		const left = Math.max(8, Math.min(bodyRect.width - menuW - 8, clientX - bodyRect.left));
		const top = Math.max(8, Math.min(bodyRect.height - estH - 8, clientY - bodyRect.top));
		this.popoverEl.style.left = `${Math.round(left)}px`;
		this.popoverEl.style.top = `${Math.round(top)}px`;
		this.popoverEl.hidden = false;

		const list = append(this.popoverEl, $('.ade-mission-emp-popover-list'));
		if (options?.colorPicker) {
			this.renderNodeColorPickerSection(list, options.colorPicker.currentColor, options.colorPicker.onSelectColor, {
				closeOnPick: true,
				compact: true,
			});
			append(list, $('.ade-mission-ctx-menu-sep'));
		}
		for (const item of items) {
			if (item.separatorBefore) {
				append(list, $('.ade-mission-ctx-menu-sep'));
			}
			const btn = append(list, $(`button.ade-mission-emp-popover-item${item.danger ? '.is-danger' : ''}`, {
				type: 'button',
				'data-ade-ctx-action': item.id,
			})) as HTMLButtonElement;
			if (item.disabled) {
				btn.disabled = true;
			}
			const lead = append(btn, $('.ade-mission-engine-option-lead'));
			if (item.icon) {
				const safeIcon = item.icon.replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '');
				if (safeIcon) {
					append(lead, $(`span.codicon.codicon-${safeIcon}`, { 'aria-hidden': 'true' }));
				}
			}
			append(lead, $('span', {}, item.label));
			if (!item.disabled) {
				this.popoverDisposables.add(addDisposableListener(btn, EventType.CLICK, e => {
					e.stopPropagation();
					this.close();
					item.run();
				}));
			}
		}
		this.clampClientPointPopover(bodyRect, clientX, clientY);
	}

	private createDetailPopoverHost(): IMissionDetailPopoverHost {
		return {
			popoverEl: this.popoverEl,
			popoverDisposables: this.popoverDisposables,
			getPopoverGeneration: () => this.popoverGeneration,
			bumpPopoverGeneration: () => ++this.popoverGeneration,
			close: (reason?: 'dismiss' | 'escape') => this.close(reason),
			positionNear: (anchorEl, width, estimatedHeight, offsetY) => this.positionNear(anchorEl, width, estimatedHeight, offsetY),
			clampToViewport: (bodyRect, anchorRect, offsetY) => this.clampTopToViewport(bodyRect, anchorRect, offsetY),
			positionAtClientPoint: (clientX, clientY, width, estimatedHeight) => {
				const bodyRect = this.bodyEl.getBoundingClientRect();
				this.popoverEl.style.left = `${Math.round(Math.max(8, Math.min(bodyRect.width - width, clientX - bodyRect.left)))}px`;
				this.popoverEl.style.top = `${Math.round(Math.max(8, Math.min(bodyRect.height - estimatedHeight, clientY - bodyRect.top)))}px`;
				this.popoverEl.hidden = false;
				return bodyRect;
			},
			clampClientPointToViewport: (bodyRect, clientX, clientY) => this.clampClientPointPopover(bodyRect, clientX, clientY),
			getOrganizationConfig: () => this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG,
			renderNodeColorPickerSection: (parentEl, currentColor, onSelectColor, options) =>
				this.renderNodeColorPickerSection(parentEl, currentColor, onSelectColor, options),
			getNodePrompt: (missionId, nodeId) => this.delegate.getNodePrompt(missionId, nodeId),
			bindPromptEditorHandles: (nodeId, textarea) => {
				this.activePromptNodeId = nodeId;
				this.activePromptTextarea = textarea;
			},
			setInlineErrorHandle: el => {
				this.activeInlineErrorEl = el;
			},
			setBeforeCloseFlush: fn => {
				this.beforeCloseFlush = fn;
			},
			setOrchCountdownUpdater: fn => {
				this.activeOrchCountdownUpdater = fn;
			},
			resolveOrchestrationTokenDelta: (missionId, tokenId) =>
				missionId ? this.missionRuntimeService?.getOrchestrationTokenDelta(missionId, tokenId) : undefined,
			resolveOrchestrationState: missionId =>
				missionId ? this.missionRuntimeService?.getOrchestrationState(missionId) : undefined,
			getActiveMissionId: () => this.delegate.getActiveMissionId(),
		};
	}

	/**
	 * Mission View: Task Node Detail, Contract Guardrails, Verification Receipt & Description Editor Popover.
	 */
	openMissionTaskEditorPopover(
		missionId: string,
		node: IMissionDagNode,
		statusRecord: IMissionTaskStatusRecord | undefined,
		anchorEl: HTMLElement,
		callbacks: IMissionTaskEditorPopoverCallbacks,
		options?: IMissionTaskEditorPopoverOptions,
	): void {
		renderMissionTaskDetailPopover(
			this.createDetailPopoverHost(),
			missionId,
			node,
			statusRecord,
			anchorEl,
			callbacks,
			options,
		);
	}

	/**
	 * Orchestration View: Department Shared Whiteboard Live Viewer, Section TOC & Editor Popover.
	 */
	openWhiteboardEditorPopover(
		whiteboard: IOrchestrationWhiteboard,
		anchorEl: HTMLElement,
		onSave: (patch: { readonly title: string; readonly department: string; readonly content: string }) => void,
		options?: IWhiteboardEditorPopoverOptions,
	): void {
		renderWhiteboardDetailPopover(
			this.createDetailPopoverHost(),
			whiteboard,
			anchorEl,
			onSave,
			options,
		);
	}

	/**
	 * Orchestration View: Quick Create Staff / Whiteboard / Group / Dispatch Requirement Popovers.
	 */
	openAddStaffPopover(
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
		renderAddStaffPopover(this.createDetailPopoverHost(), clientX, clientY, onCreate, options);
	}

	openAddWhiteboardPopover(
		clientX: number,
		clientY: number,
		onCreate: (payload: { readonly department: string; readonly title: string }) => void,
		options?: { readonly defaultDepartment?: string },
	): void {
		renderAddWhiteboardPopover(this.createDetailPopoverHost(), clientX, clientY, onCreate, options);
	}

	openAddGroupPopover(
		clientX: number,
		clientY: number,
		onCreate: (groupName: string) => void,
	): void {
		renderAddGroupPopover(this.createDetailPopoverHost(), clientX, clientY, onCreate);
	}

	openMoveToGroupPopover(
		clientX: number,
		clientY: number,
		nodeLabel: string,
		currentDepartment: string | undefined,
		groups: ReadonlyArray<{ readonly id: string; readonly name: string }>,
		onSelect: (targetGroupNameOrId: string | undefined) => void,
	): void {
		renderMoveToGroupPopover(this.createDetailPopoverHost(), clientX, clientY, nodeLabel, currentDepartment, groups, onSelect);
	}

	openOrchestrationTokenPopover(
		staffLabel: string,
		token: IOrchestrationToken,
		anchorEl: HTMLElement,
		callbacks?: IOrchestrationTokenPopoverOptions,
		options?: IOrchestrationTokenPopoverOptions,
	): void {
		renderOrchestrationTokenDetailPopover(
			this.createDetailPopoverHost(),
			staffLabel,
			token,
			anchorEl,
			callbacks,
			options,
		);
	}

	openDispatchRequirementPopover(
		clientX: number,
		clientY: number,
		targetLabel: string,
		onDispatch: (requirement: string) => void,
	): void {
		renderDispatchRequirementPopover(this.createDetailPopoverHost(), clientX, clientY, targetLabel, onDispatch);
	}
}
