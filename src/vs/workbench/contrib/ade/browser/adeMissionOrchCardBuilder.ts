/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AdeOsIconKind } from '../../../../platform/ade/common/adeCloudHosts.js';
import { resolveModelContextWindowTokens } from '../../../../platform/ade/common/adeModelPricing.js';
import {
	formatLevelLabel,
	IAdeAgentNode,
	IAdeTicketSummaryCard,
	IAdeWhiteboard,
} from '../../../../platform/ade/common/adeModels.js';
import {
	getOrchestrationAnchorFraction,
	getOrchestrationNodeSize,
	IMissionNodePosition,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	ORCH_STAFF_CARD_HEIGHT,
	ORCH_STAFF_CARD_WIDTH,
	ORCH_WHITEBOARD_CARD_HEIGHT,
	ORCH_WHITEBOARD_CARD_WIDTH,
	ORCHESTRATION_ANCHOR_SIDES,
	ORCHESTRATION_SLOTS_PER_SIDE,
	OrchestrationAnchorSide,
	reanchorOrchestrationRoute,
} from '../../../../platform/ade/common/adeOrchestrationLayout.js';
import {
	ADE_LLM_PROVIDER_LABELS,
	renderAdeLlmIcon,
	resolveEffectiveAdeLlmProvider,
} from '../../../browser/adeLlmIcon.js';
import { renderAdeOsIcon } from '../../../browser/adeOsIcon.js';
import { IAdeAgent, normalizeAdeShortEngineId } from '../common/ade.js';
import { adeBi } from '../common/adeLocalization.js';
import {
	buildContextUsageSnapshot,
	formatCompactContextTokens,
	IAdeAgentContextUsage,
} from './adeContextUsageTracker.js';
import {
	AdeMissionHostCatalog,
	applyMissionEngineIcon,
	MISSION_ENGINE_DEFAULT_MODELS,
	toPrefixedAdeEngineId,
} from './adeMissionHostCatalog.js';

export {
	ORCH_STAFF_CARD_WIDTH,
	ORCH_STAFF_CARD_HEIGHT,
	ORCH_WHITEBOARD_CARD_WIDTH,
	ORCH_WHITEBOARD_CARD_HEIGHT,
	getOrchestrationNodeSize as getRenderedOrchestrationNodeSize,
	reanchorOrchestrationRoute,
};

export function sanitizeCssSlug(raw: string): string {
	const cleaned = String(raw || '').trim().replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '');
	return cleaned || 'default';
}

export interface IOrchGraphDerivedIndex {
	readonly heldTicketsByAgent: ReadonlyMap<string, readonly IAdeTicketSummaryCard[]>;
	readonly wbLinkCountById: ReadonlyMap<string, number>;
}

export function buildOrchGraphDerivedIndex(
	orchEdges: readonly IOrchestrationGraphEdge[],
	tickets: readonly IAdeTicketSummaryCard[],
): IOrchGraphDerivedIndex {
	const heldTicketsByAgent = new Map<string, IAdeTicketSummaryCard[]>();
	const wbLinkCountById = new Map<string, number>();

	for (const e of orchEdges) {
		wbLinkCountById.set(e.from, (wbLinkCountById.get(e.from) ?? 0) + 1);
		wbLinkCountById.set(e.to, (wbLinkCountById.get(e.to) ?? 0) + 1);
	}

	for (const tk of tickets) {
		if (tk.status === 'active' && tk.holder_id) {
			const arr = heldTicketsByAgent.get(tk.holder_id) ?? [];
			arr.push(tk);
			heldTicketsByAgent.set(tk.holder_id, arr);
		}
	}
	for (const arr of heldTicketsByAgent.values()) {
		arr.sort((a, b) => b.updated_at - a.updated_at);
	}

	return {
		heldTicketsByAgent,
		wbLinkCountById,
	};
}

export interface IOrchWhiteboardDomRefs {
	readonly kind: 'whiteboard';
	readonly rootEl: HTMLElement;
	readonly cardEl: HTMLElement;
	readonly idWrapEl: HTMLElement;
	readonly colorTriggerWrapEl: HTMLElement;
	readonly deptChipEl: HTMLElement;
	readonly inspectBtnEl: HTMLButtonElement;
	readonly titleEl: HTMLElement;
	readonly bodySlotEl: HTMLElement;
	readonly storageTagEl: HTMLElement;
	readonly linkCountEl: HTMLElement;
	readonly metaTagEl: HTMLElement;
	readonly verTagEl: HTMLElement;
	readonly dynamicDisposables: DisposableStore;
	whiteboard: IAdeWhiteboard;
	lastSignature: string;
}

export interface IOrchStaffDomRefs {
	readonly kind: 'staff';
	readonly rootEl: HTMLElement;
	readonly cardEl: HTMLElement;
	readonly idWrapEl: HTMLElement;
	readonly stateDotEl: HTMLElement;
	readonly rankPillEl: HTMLElement;
	readonly colorTriggerWrapEl: HTMLElement;
	readonly topRightEl: HTMLElement;
	readonly editBtnEl: HTMLButtonElement;
	readonly openChatBtnEl: HTMLButtonElement;
	readonly coreIconTileEl: HTMLElement;
	readonly coreLlmGlyphEl: HTMLElement;
	readonly titleEl: HTMLElement;
	readonly liveBadgeEl: HTMLElement;
	readonly modelRowEl: HTMLElement;
	readonly modelPillEl: HTMLButtonElement;
	readonly modelNameEl: HTMLElement;
	readonly thinkingTagEl: HTMLButtonElement;
	readonly thinkingLabelEl: HTMLElement;
	readonly contextSummaryEl: HTMLElement;
	readonly statusStripEl: HTMLElement;
	readonly statusIcoEl: HTMLElement;
	readonly statusPreviewEl: HTMLElement;
	readonly statusTagEl: HTMLElement;
	readonly ctxRowEl: HTMLElement;
	readonly ctxLabelEl: HTMLElement;
	readonly ctxFillEl: HTMLElement;
	readonly ctxTokensEl: HTMLElement;
	readonly ctxPctEl: HTMLElement;
	readonly engineBadgeEl: HTMLButtonElement;
	readonly engineIconEl: HTMLElement;
	readonly engineNameEl: HTMLElement;
	readonly hostPillEl: HTMLButtonElement;
	readonly hostOsIconEl: HTMLElement;
	readonly hostNameEl: HTMLElement;
	readonly dynamicDisposables: DisposableStore;
	agentNode: IAdeAgentNode | undefined;
	linkedAgent: IAdeAgent | undefined;
	engineId: string;
	canSwitchEngine: boolean;
	canSwitchModel: boolean;
	canSwitchHost: boolean;
	hostAlias: string;
	displayHost: string;
	osKind: AdeOsIconKind;
	osLabel: string;
	lastOsSlug: string;
	isRemoteHost: boolean;
	nodeState: string;
	lastHeaderSig: string;
	lastModelSig: string;
	lastRuntimeSig: string;
	lastContextSig: string;
}

export interface IOrchCardBuildContext {
	readonly nodesLayerEl: HTMLElement;
	readonly graphDisposables: DisposableStore;
	readonly hostCatalog: AdeMissionHostCatalog;
	readonly orchAnchorButtons: Map<string, HTMLButtonElement>;
	readonly applyCustomNodeColor: (nodeEl: HTMLElement, rawColor: string | undefined) => void;
	readonly mountNodeColorTrigger: (parentEl: HTMLElement, nodeId: string, label: string, rawColor: string | undefined, store: DisposableStore) => void;
	readonly bindMultiAnchorConnectDrag: (oNode: IOrchestrationGraphNode, anchorEl: HTMLButtonElement, side: OrchestrationAnchorSide, slot: number) => void;
	readonly startInlineNodeRename: (nodeId: string) => void;
	readonly onOpenWhiteboardPopover?: (whiteboard: IAdeWhiteboard, anchorEl: HTMLElement, options?: { readonly initialTag?: string }) => void;
	readonly onOpenModelPopover: (
		nodeId: string,
		agent: IAdeAgent | undefined,
		engineId: string,
		anchorEl: HTMLElement,
		options?: { readonly currentModel?: string; readonly currentThinking?: string; readonly hostAlias?: string },
	) => void;
	readonly onOpenEffortPopover?: (
		nodeId: string,
		agent: IAdeAgent | undefined,
		engineId: string,
		anchorEl: HTMLElement,
		options?: { readonly currentThinking?: string; readonly hostAlias?: string },
	) => void;
	readonly onOpenEnginePopover: (
		nodeId: string,
		agent: IAdeAgent | undefined,
		engineId: string,
		anchorEl: HTMLElement,
		options?: { readonly staffLabel?: string; readonly hostAlias?: string; readonly currentModel?: string; readonly currentThinking?: string },
	) => void;
	readonly onOpenHostPopover?: (
		nodeId: string,
		agent: IAdeAgent | undefined,
		rawHost: string,
		anchorEl: HTMLElement,
		options?: { readonly staffLabel?: string; readonly currentEngine?: string; readonly currentModel?: string; readonly currentThinking?: string },
	) => void;
	readonly onOpenStaffEditPopover?: (node: IOrchestrationGraphNode, anchorEl: HTMLElement) => void;
	readonly onOpenAgentSession?: (agentId: string, openToSide: boolean) => void;
	readonly onRenameNodeAvailable: boolean;
}

function mountMultiAnchors(
	oNode: IOrchestrationGraphNode,
	cardEl: HTMLElement,
	ctx: IOrchCardBuildContext,
): void {
	for (const side of ORCHESTRATION_ANCHOR_SIDES) {
		for (let slot = 0; slot < ORCHESTRATION_SLOTS_PER_SIDE; slot++) {
			const pct = Math.round(getOrchestrationAnchorFraction(slot, ORCHESTRATION_SLOTS_PER_SIDE) * 100);
			const anchorBtn = append(cardEl, $(`button.ade-orch-anchor.side-${side}.slot-${slot}.is-connectable`, {
				type: 'button',
				'data-ade-card-interactive': 'true',
				'data-ade-connect-port': oNode.id,
				'data-anchor-side': side,
				'data-anchor-slot': String(slot),
				title: adeBi(
					localize('adeOrchAnchorBidirectionalTip', "Drag from this anchor to recruit a subordinate or reparent (<-->)"),
					'从此锚点拖拽以招募下属或调整上下级汇报关系（<-->）',
				),
			})) as HTMLButtonElement;
			ctx.graphDisposables.add(addDisposableListener(anchorBtn, EventType.DBLCLICK, e => e.stopPropagation()));
			if (side === 'top' || side === 'bottom') {
				anchorBtn.style.left = `${pct}%`;
			} else {
				anchorBtn.style.top = `${pct}%`;
			}
			ctx.orchAnchorButtons.set(`${oNode.id}:${side}:${slot}`, anchorBtn);
			ctx.bindMultiAnchorConnectDrag(oNode, anchorBtn, side, slot);
		}
	}
}

export interface IOrchWhiteboardPatchInput {
	readonly oNode: IOrchestrationGraphNode;
	readonly pos: IMissionNodePosition;
	readonly wb: IAdeWhiteboard;
	readonly derived: IOrchGraphDerivedIndex;
}

export function buildOrchWhiteboardCardDom(
	input: IOrchWhiteboardPatchInput,
	ctx: IOrchCardBuildContext,
): IOrchWhiteboardDomRefs {
	const { oNode, pos, wb } = input;
	const deptLabel = oNode.department || adeBi(localize('adeWbPersonalBadge', "Personal"), '个人白板');
	const nodeEl = append(ctx.nodesLayerEl, $('.ade-mission-node.kind-whiteboard', {
		'data-node-id': oNode.id,
		'data-node-kind': 'whiteboard',
		'data-whiteboard-id': wb.board_id,
		'data-department': deptLabel,
	}));
	nodeEl.style.left = `${pos.x}px`;
	nodeEl.style.top = `${pos.y}px`;
	ctx.applyCustomNodeColor(nodeEl, oNode.color);

	const cardEl = append(nodeEl, $('.ade-mission-node-card.is-whiteboard-card'));
	append(cardEl, $('span.ade-mission-clamp.tl', { 'aria-hidden': 'true' }));
	append(cardEl, $('span.ade-mission-clamp.tr', { 'aria-hidden': 'true' }));
	append(cardEl, $('span.ade-mission-clamp.bl', { 'aria-hidden': 'true' }));
	append(cardEl, $('span.ade-mission-clamp.br', { 'aria-hidden': 'true' }));

	const topRow = append(cardEl, $('.ade-mission-node-top'));
	const idWrapEl = append(topRow, $('span.ade-mission-node-id-wrap'));
	append(idWrapEl, $('span.codicon.codicon-notebook.ade-orch-wb-ico', { 'aria-hidden': 'true' }));
	append(idWrapEl, $('span.ade-mission-node-id', { title: wb.board_id }, wb.board_id));
	const colorTriggerWrapEl = append(idWrapEl, $('span.ade-node-color-trigger-slot'));

	const topRightWrap = append(topRow, $('.ade-orch-top-right-wrap'));
	const deptChipEl = append(topRightWrap, $('span.ade-orch-wb-dept-chip', { title: deptLabel }, deptLabel));
	const inspectBtnEl = append(topRightWrap, $('button.ade-orch-wb-open-btn', {
		type: 'button',
		'data-ade-card-interactive': 'true',
		'data-ade-open-wb': wb.board_id,
		title: adeBi(
			localize('adeWbOpenInspectorBtnTip', "Open whiteboard panel"),
			'打开共享白板面板',
		),
	})) as HTMLButtonElement;
	append(inspectBtnEl, $('span.codicon.codicon-eye', { 'aria-hidden': 'true' }));
	ctx.graphDisposables.add(addDisposableListener(inspectBtnEl, EventType.DBLCLICK, e => {
		e.preventDefault();
		e.stopPropagation();
	}));

	const wbWell = append(cardEl, $('.ade-mission-core-well.wb-well'));
	const titleEl = append(wbWell, $('.ade-mission-node-title.is-wb-title', { title: wb.name }, wb.name));
	const bodySlotEl = append(wbWell, $('.ade-orch-wb-body-slot'));

	const foot = append(cardEl, $('.ade-orch-wb-footer'));
	const footLeft = append(foot, $('.ade-orch-wb-footer-left'));
	const storageTagEl = append(footLeft, $('span.ade-orch-wb-ptr-tag', {}, wb.storage_host || 'local'));
	const linkCountEl = append(footLeft, $('span.ade-orch-wb-links-tag'));
	linkCountEl.hidden = true;
	const footRight = append(foot, $('.ade-orch-wb-footer-right'));
	const metaTagEl = append(footRight, $('span.ade-orch-wb-meta-tag'));
	metaTagEl.hidden = true;
	const verTagEl = append(footRight, $('span.ade-orch-wb-ver-tag', {}, wb.migration_state === 'transferring' ? 'CAS…' : `${wb.tag_categories.length} tags`));

	mountMultiAnchors(oNode, cardEl, ctx);

	const dynamicDisposables = ctx.graphDisposables.add(new DisposableStore());
	const refs: IOrchWhiteboardDomRefs = {
		kind: 'whiteboard',
		rootEl: nodeEl,
		cardEl,
		idWrapEl,
		colorTriggerWrapEl,
		deptChipEl,
		inspectBtnEl,
		titleEl,
		bodySlotEl,
		storageTagEl,
		linkCountEl,
		metaTagEl,
		verTagEl,
		dynamicDisposables,
		whiteboard: wb,
		lastSignature: '',
	};

	patchOrchWhiteboardCardDom(refs, input, ctx);
	return refs;
}

export function patchOrchWhiteboardCardDom(
	refs: IOrchWhiteboardDomRefs,
	input: IOrchWhiteboardPatchInput,
	ctx: IOrchCardBuildContext,
): void {
	const { oNode, pos, wb, derived } = input;
	refs.whiteboard = wb;

	if (!refs.rootEl.classList.contains('dragging')) {
		const leftStr = `${pos.x}px`;
		const topStr = `${pos.y}px`;
		if (refs.rootEl.style.left !== leftStr) {
			refs.rootEl.style.left = leftStr;
		}
		if (refs.rootEl.style.top !== topStr) {
			refs.rootEl.style.top = topStr;
		}
	}

	const deptLabel = oNode.department || adeBi(localize('adeWbPersonalBadge', "Personal"), '个人白板');
	const linkCount = derived.wbLinkCountById.get(wb.board_id) ?? 0;
	const hostInfo = ctx.hostCatalog.resolveNodeHostAndOs(wb.storage_host || 'local');
	const storageDisplay = hostInfo.isRemote ? (hostInfo.displayHost || wb.storage_host) : 'local';
	const sig = JSON.stringify([
		wb.name,
		deptLabel,
		wb.storage_host,
		storageDisplay,
		wb.migration_state,
		wb.migration_epoch,
		wb.owner_id ?? '',
		oNode.ownerName ?? '',
		wb.tag_categories,
		wb.updated_at,
		oNode.color ?? '',
		linkCount,
	]);
	if (refs.lastSignature === sig) {
		return;
	}
	refs.lastSignature = sig;

	ctx.applyCustomNodeColor(refs.rootEl, oNode.color);
	refs.rootEl.setAttribute('data-department', deptLabel);
	refs.deptChipEl.textContent = deptLabel;
	refs.deptChipEl.title = deptLabel;
	if (refs.titleEl.firstElementChild?.tagName !== 'INPUT') {
		refs.titleEl.textContent = wb.name;
		refs.titleEl.title = wb.name;
	}
	refs.storageTagEl.textContent = `@${storageDisplay}`;
	refs.storageTagEl.title = adeBi(
		localize('adeWbStorageHostTip', "Storage Host: {0} ({1})", storageDisplay, hostInfo.osLabel),
		'存储主机：{0}（{1}）',
		storageDisplay,
		hostInfo.osLabel,
	);
	refs.verTagEl.textContent = wb.migration_state === 'transferring'
		? adeBi(localize('adeWbMigratingBadge', "Migrating…"), '搬迁中…')
		: wb.migration_state === 'failed'
			? adeBi(localize('adeWbMigFailedBadge', "Mig Err"), '搬迁异常')
			: `${wb.tag_categories.length} ${adeBi(localize('adeWbTagsUnit', "tags"), '标签')}`;

	refs.dynamicDisposables.clear();
	clearNode(refs.colorTriggerWrapEl);
	ctx.mountNodeColorTrigger(refs.colorTriggerWrapEl, oNode.id, wb.name, oNode.color, refs.dynamicDisposables);

	refs.dynamicDisposables.add(addDisposableListener(refs.inspectBtnEl, EventType.CLICK, e => {
		e.stopPropagation();
		ctx.onOpenWhiteboardPopover?.(refs.whiteboard, refs.cardEl);
	}));

	clearNode(refs.bodySlotEl);
	if (wb.tag_categories.length > 0) {
		const tocEl = append(refs.bodySlotEl, $('.ade-orch-wb-toc'));
		const shown = wb.tag_categories.slice(0, 3);
		for (const tag of shown) {
			const chipBtn = append(tocEl, $('button.ade-orch-wb-toc-chip', {
				type: 'button',
				'data-ade-card-interactive': 'true',
				'data-ade-wb-tag': tag,
				title: adeBi(
					localize('adeWbFilterByTagTip', "Open whiteboard filtered by tag \"{0}\"", tag),
					'打开白板并按标签「{0}」筛选',
					tag,
				),
			}, `# ${tag}`)) as HTMLButtonElement;
			refs.dynamicDisposables.add(addDisposableListener(chipBtn, EventType.CLICK, e => {
				e.stopPropagation();
				ctx.onOpenWhiteboardPopover?.(refs.whiteboard, chipBtn, { initialTag: tag });
			}));
			refs.dynamicDisposables.add(addDisposableListener(chipBtn, EventType.DBLCLICK, e => {
				e.preventDefault();
				e.stopPropagation();
			}));
		}
		if (wb.tag_categories.length > 3) {
			append(tocEl, $('span.ade-orch-wb-toc-more', {
				title: wb.tag_categories.slice(3).map(t => `# ${t}`).join('\n'),
			}, `+${wb.tag_categories.length - 3}`));
		}
	} else {
		const excerpt = adeBi(
			localize('adeWbCardDoubleClickHint', "Shared messages, file backups & targeted notes · Double-click to open"),
			'共享消息、文件独立备份与定向留言 · 双击打开白板',
		);
		append(refs.bodySlotEl, $('.ade-orch-wb-excerpt', {}, excerpt));
	}

	if (linkCount > 0) {
		refs.linkCountEl.hidden = false;
		refs.linkCountEl.textContent = `⇄ ${linkCount}`;
	} else {
		refs.linkCountEl.hidden = true;
	}

	if (oNode.ownerName || wb.owner_id) {
		refs.metaTagEl.hidden = false;
		refs.metaTagEl.textContent = oNode.ownerName ?? wb.owner_id ?? '';
		refs.metaTagEl.title = adeBi(
			localize('adeWbOwnerMetaTip', "Owner: {0}", oNode.ownerName ?? wb.owner_id ?? ''),
			'所有者：{0}',
			oNode.ownerName ?? wb.owner_id ?? '',
		);
	} else {
		refs.metaTagEl.hidden = false;
		refs.metaTagEl.textContent = adeBi(localize('adeWbUnclaimedTag', "Custody"), '托管保留');
	}
}

export interface IOrchStaffPatchInput {
	readonly oNode: IOrchestrationGraphNode;
	readonly pos: IMissionNodePosition;
	readonly agentNode: IAdeAgentNode | undefined;
	readonly linkedAgent: IAdeAgent | undefined;
	readonly liveChatState?: 'idle' | 'working' | 'pending';
	readonly contextUsage?: IAdeAgentContextUsage;
	readonly derived: IOrchGraphDerivedIndex;
}

export function buildOrchStaffCardDom(
	input: IOrchStaffPatchInput,
	ctx: IOrchCardBuildContext,
): IOrchStaffDomRefs {
	const { oNode, pos } = input;
	const nodeEl = append(ctx.nodesLayerEl, $('.ade-mission-node.kind-staff', {
		'data-node-id': oNode.id,
		'data-node-kind': 'staff',
		...(oNode.department ? { 'data-department': oNode.department } : {}),
	}));
	nodeEl.style.left = `${pos.x}px`;
	nodeEl.style.top = `${pos.y}px`;

	const cardEl = append(nodeEl, $('.ade-mission-node-card.is-staff-card'));
	append(cardEl, $('span.ade-mission-clamp.tl', { 'aria-hidden': 'true' }));
	append(cardEl, $('span.ade-mission-clamp.tr', { 'aria-hidden': 'true' }));
	append(cardEl, $('span.ade-mission-clamp.bl', { 'aria-hidden': 'true' }));
	append(cardEl, $('span.ade-mission-clamp.br', { 'aria-hidden': 'true' }));

	const topRow = append(cardEl, $('.ade-mission-node-top'));
	const idWrapEl = append(topRow, $('span.ade-mission-node-id-wrap'));
	const stateDotEl = append(idWrapEl, $('span.ade-mission-state-dot', { 'aria-hidden': 'true' }));
	stateDotEl.hidden = true;
	append(idWrapEl, $('span.ade-mission-node-id', { title: oNode.id }, oNode.id));
	const rankPillEl = append(idWrapEl, $('span.ade-mission-rank-pill'));
	const colorTriggerWrapEl = append(idWrapEl, $('span.ade-node-color-trigger-slot'));

	const topRightWrap = append(topRow, $('.ade-orch-top-right-wrap'));
	const topRightEl = append(topRightWrap, $('.ade-mission-top-pills'));
	const editBtnEl = append(topRightWrap, $('button.ade-orch-card-edit-btn', {
		type: 'button',
		'data-ade-card-interactive': 'true',
		'data-ade-orch-role-bar': oNode.id,
		title: adeBi(
			localize('adeStaffEditProfileBtnTip', "Edit employee profile & duties"),
			'编辑员工姓名、职责与部门配置',
		),
	})) as HTMLButtonElement;
	append(editBtnEl, $('span.codicon.codicon-settings-gear', { 'aria-hidden': 'true' }));

	const openChatBtnEl = append(topRightWrap, $('button.ade-orch-open-chat-btn', {
		type: 'button',
		'data-ade-card-interactive': 'true',
		'data-ade-open-chat': oNode.id,
		title: adeBi(
			localize('adeStaffOpenChatBtnTip', "Open employee chat session"),
			'打开员工对话界面',
		),
	})) as HTMLButtonElement;
	append(openChatBtnEl, $('span.codicon.codicon-comment-discussion', { 'aria-hidden': 'true' }));

	// Recessed Core Well (`344×188` frosted-glass staff geometry preserved 1:1;
	// non-pill areas pass pointer events cleanly to cardEl so single-click = select & double-click = open session)
	const coreWellEl = append(cardEl, $('.ade-mission-core-well'));
	const coreHead = append(coreWellEl, $('.ade-mission-core-head'));
	const coreIconTileEl = append(coreHead, $('.ade-mission-core-icon-well'));
	const coreLlmGlyphEl = append(coreIconTileEl, $('span.ade-mission-llm-icon', { 'aria-hidden': 'true' }));

	const coreMeta = append(coreHead, $('.ade-mission-core-meta'));
	const coreTitleRow = append(coreMeta, $('.ade-mission-core-title-row'));
	const titleEl = append(coreTitleRow, $('.ade-mission-node-title', { title: oNode.label }, oNode.label));
	const liveBadgeEl = append(coreTitleRow, $('span.ade-orch-live-badge'));

	const modelRowEl = append(coreMeta, $('.ade-mission-core-model-row'));
	const modelPillEl = append(modelRowEl, $('button.ade-mission-model-pill.is-editable', {
		type: 'button',
		'data-ade-card-interactive': 'true',
	})) as HTMLButtonElement;
	const modelNameEl = append(modelPillEl, $('span.ade-mission-model-name'));
	append(modelPillEl, $('span.codicon.codicon-chevron-down.ade-mission-pill-caret', { 'aria-hidden': 'true' }));

	const thinkingTagEl = append(modelRowEl, $('button.ade-mission-thinking-tag.is-editable', {
		type: 'button',
		'data-ade-card-interactive': 'true',
	})) as HTMLButtonElement;
	const thinkingLabelEl = append(thinkingTagEl, $('span.ade-mission-thinking-label'));
	append(thinkingTagEl, $('span.codicon.codicon-chevron-down.ade-mission-pill-caret', { 'aria-hidden': 'true' }));

	const contextSummaryEl = append(coreWellEl, $('.ade-mission-core-context'));

	// Non-button Status / Active-Ticket Telemetry Strip (single-click selects card, double-click opens session!)
	const statusStripEl = append(coreWellEl, $('.ade-mission-node-status-strip', {
		'data-ade-status-strip': oNode.id,
	}));
	const statusIcoEl = append(statusStripEl, $('span.codicon.codicon-comment-discussion.ade-mission-node-prompt-ico', { 'aria-hidden': 'true' }));
	const statusPreviewEl = append(statusStripEl, $('span.ade-mission-node-prompt-preview'));
	const statusTagEl = append(statusStripEl, $('span.ade-mission-node-prompt-tag'));

	// Precision Session Context Window Telemetry Row (`CTX | progress bar | used / window | %`)
	const ctxRowEl = append(coreWellEl, $('.ade-mission-ctx-row', {
		'data-ade-ctx-meter': oNode.id,
	}));
	const ctxLabelEl = append(ctxRowEl, $('span.ade-mission-ctx-label', {}, 'CTX'));
	const ctxTrackEl = append(ctxRowEl, $('.ade-mission-ctx-track'));
	const ctxFillEl = append(ctxTrackEl, $('.ade-mission-ctx-fill'));
	const ctxStatsEl = append(ctxRowEl, $('span.ade-mission-ctx-stats'));
	const ctxTokensEl = append(ctxStatsEl, $('span.ade-mission-ctx-tokens'));
	const ctxPctEl = append(ctxStatsEl, $('span.ade-mission-ctx-pct'));

	// Engine + OS Host Footer (both ALWAYS clickable in-place quick popovers)
	const footer = append(cardEl, $('.ade-mission-node-footer'));
	const engineBadgeEl = append(footer, $('button.ade-mission-engine-pill.is-editable', {
		type: 'button',
		'data-ade-card-interactive': 'true',
	})) as HTMLButtonElement;
	const engineIconEl = append(engineBadgeEl, $('span.ade-mission-engine-icon', { 'aria-hidden': 'true' }));
	const engineNameEl = append(engineBadgeEl, $('span.ade-mission-engine-name'));
	append(engineBadgeEl, $('span.codicon.codicon-chevron-down.ade-mission-pill-caret', { 'aria-hidden': 'true' }));

	const hostPillEl = append(footer, $('button.ade-mission-host-pill.is-editable', {
		type: 'button',
		'data-ade-card-interactive': 'true',
	})) as HTMLButtonElement;
	const hostOsIconEl = append(hostPillEl, $('span.ade-mission-os-icon', { 'aria-hidden': 'true' }));
	const hostNameEl = append(hostPillEl, $('span.ade-mission-host-name'));
	append(hostPillEl, $('span.codicon.codicon-chevron-down.ade-mission-pill-caret', { 'aria-hidden': 'true' }));

	// Mount 20 Perimeter Multi-Anchor Connection Ports (4 sides × 5 slots)
	mountMultiAnchors(oNode, cardEl, ctx);

	// Prevent double-clicking ONLY dedicated interactive buttons from bubbling to cardEl DBLCLICK (openAgentSession)
	const interactiveButtons: readonly HTMLElement[] = [
		editBtnEl,
		openChatBtnEl,
		modelPillEl,
		thinkingTagEl,
		engineBadgeEl,
		hostPillEl,
	];
	for (const btn of interactiveButtons) {
		ctx.graphDisposables.add(addDisposableListener(btn, EventType.DBLCLICK, e => {
			e.preventDefault();
			e.stopPropagation();
		}));
	}

	const dynamicDisposables = ctx.graphDisposables.add(new DisposableStore());
	const refs: IOrchStaffDomRefs = {
		kind: 'staff',
		rootEl: nodeEl,
		cardEl,
		idWrapEl,
		stateDotEl,
		rankPillEl,
		colorTriggerWrapEl,
		topRightEl,
		editBtnEl,
		openChatBtnEl,
		coreIconTileEl,
		coreLlmGlyphEl,
		titleEl,
		liveBadgeEl,
		modelRowEl,
		modelPillEl,
		modelNameEl,
		thinkingTagEl,
		thinkingLabelEl,
		contextSummaryEl,
		statusStripEl,
		statusIcoEl,
		statusPreviewEl,
		statusTagEl,
		ctxRowEl,
		ctxLabelEl,
		ctxFillEl,
		ctxTokensEl,
		ctxPctEl,
		engineBadgeEl,
		engineIconEl,
		engineNameEl,
		hostPillEl,
		hostOsIconEl,
		hostNameEl,
		dynamicDisposables,
		agentNode: input.agentNode,
		linkedAgent: input.linkedAgent,
		engineId: 'aexus-claude',
		canSwitchEngine: true,
		canSwitchModel: true,
		canSwitchHost: true,
		hostAlias: 'local',
		displayHost: 'Local',
		osKind: 'macos',
		osLabel: 'macOS',
		lastOsSlug: '',
		isRemoteHost: false,
		nodeState: 'idle',
		lastHeaderSig: '',
		lastModelSig: '',
		lastRuntimeSig: '',
		lastContextSig: '',
	};

	patchOrchStaffCardDom(refs, input, ctx);
	return refs;
}

function renderStaffContextUsageMeter(
	refs: IOrchStaffDomRefs,
	resolvedModel: string,
	rawEngine: string,
	sessionStarted: boolean,
	liveChatState: 'idle' | 'working' | 'pending' | undefined,
	contextUsage: IAdeAgentContextUsage | undefined,
	ctx: IOrchCardBuildContext,
): void {
	const overrides = ctx.hostCatalog.getModelCategoryOverrides();
	const usage = contextUsage ?? buildContextUsageSnapshot({
		usedTokens: 0,
		model: resolvedModel,
		engine: rawEngine,
		overrides,
		isStreaming: liveChatState === 'working',
	});
	const windowTokens = usage.contextWindowTokens > 0
		? usage.contextWindowTokens
		: resolveModelContextWindowTokens(resolvedModel, normalizeAdeShortEngineId(rawEngine), overrides);

	const contextSig = JSON.stringify([
		usage.usedTokens,
		windowTokens,
		usage.percent,
		usage.severity,
		usage.isEstimated,
		usage.isStreaming,
		usage.inputTokens ?? -1,
		usage.outputTokens ?? -1,
		usage.cacheReadTokens ?? -1,
		sessionStarted,
	]);
	if (refs.lastContextSig === contextSig) {
		return;
	}
	refs.lastContextSig = contextSig;

	const isUnused = !sessionStarted || usage.usedTokens <= 0;
	const fillPct = isUnused ? 0 : Math.max(2, Math.min(100, usage.ratio * 100));
	const usedCompact = usage.isEstimated && usage.usedTokens > 0
		? `~${formatCompactContextTokens(usage.usedTokens)}`
		: formatCompactContextTokens(usage.usedTokens);
	const winCompact = formatCompactContextTokens(windowTokens);

	refs.ctxRowEl.className = `ade-mission-ctx-row severity-${usage.severity}${isUnused ? ' is-unused' : ''}${usage.isStreaming ? ' is-streaming' : ''}`;
	refs.ctxRowEl.setAttribute('data-ctx-used', String(usage.usedTokens));
	refs.ctxRowEl.setAttribute('data-ctx-window', String(windowTokens));
	refs.ctxRowEl.setAttribute('data-ctx-pct', String(usage.percent));
	refs.ctxRowEl.setAttribute('data-ctx-severity', usage.severity);

	refs.ctxLabelEl.textContent = 'CTX';
	refs.ctxFillEl.style.width = `${fillPct.toFixed(1)}%`;
	refs.ctxTokensEl.textContent = `${usedCompact}/${winCompact}`;
	refs.ctxPctEl.textContent = `${isUnused ? 0 : usage.percent}%`;

	const breakdownParts: string[] = [];
	if (typeof usage.inputTokens === 'number' && usage.inputTokens > 0) {
		breakdownParts.push(`${adeBi('Input', '输入')}: ${usage.inputTokens.toLocaleString()}`);
	}
	if (typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens > 0) {
		breakdownParts.push(`${adeBi('Cache', '缓存命中')}: ${usage.cacheReadTokens.toLocaleString()}`);
	}
	if (typeof usage.outputTokens === 'number' && usage.outputTokens > 0) {
		breakdownParts.push(`${adeBi('Output', '输出')}: ${usage.outputTokens.toLocaleString()}`);
	}
	const detailLine = breakdownParts.length > 0
		? `\n${breakdownParts.join(' · ')}`
		: (usage.isEstimated && usage.usedTokens > 0
			? `\n${adeBi(localize('adeCtxEstimatedNote', "Estimated from active session transcript"), '基于当前会话消息实时估算')}`
			: (!sessionStarted
				? `\n${adeBi(localize('adeCtxUnstartedNote', "Session not started yet — double-click card to begin"), '会话尚未启动 — 双击卡片开始对话')}`
				: ''));

	refs.ctxRowEl.title = adeBi(
		localize(
			'adeCtxUsageFullTooltip',
			"Context Window: {0} / {1} tokens ({2}%){3}",
			usage.usedTokens.toLocaleString(),
			windowTokens.toLocaleString(),
			isUnused ? 0 : usage.percent,
			detailLine,
		),
		'会话上下文用量：{0} / {1} tokens（{2}%）{3}',
		usage.usedTokens.toLocaleString(),
		windowTokens.toLocaleString(),
		isUnused ? 0 : usage.percent,
		detailLine,
	);
}

export function patchOrchStaffCardDom(
	refs: IOrchStaffDomRefs,
	input: IOrchStaffPatchInput,
	ctx: IOrchCardBuildContext,
): void {
	const { oNode, pos, agentNode, linkedAgent, liveChatState, contextUsage, derived } = input;

	if (!refs.rootEl.classList.contains('dragging')) {
		const leftStr = `${pos.x}px`;
		const topStr = `${pos.y}px`;
		if (refs.rootEl.style.left !== leftStr) {
			refs.rootEl.style.left = leftStr;
		}
		if (refs.rootEl.style.top !== topStr) {
			refs.rootEl.style.top = topStr;
		}
	}

	const rawHost = agentNode?.host ?? oNode.host ?? 'local';
	const hostInfo = ctx.hostCatalog.resolveNodeHostAndOs(rawHost, linkedAgent);
	const levelNum = Math.max(1, Math.floor(agentNode?.level ?? oNode.tier ?? 1));
	const levelLabel = formatLevelLabel(levelNum);
	const isTopRole = Boolean(agentNode?.is_top_role ?? oNode.isTopRole ?? (levelNum === 1 && !oNode.parentId));
	const sessionStarted = Boolean(agentNode?.session_started ?? oNode.sessionStarted);
	const heldTickets = derived.heldTicketsByAgent.get(oNode.id) ?? [];

	const nodeState = liveChatState === 'working'
		? 'active'
		: (heldTickets.length > 0 ? 'active' : 'idle');

	refs.agentNode = agentNode;
	refs.linkedAgent = linkedAgent;
	refs.nodeState = nodeState;
	refs.hostAlias = hostInfo.hostKey;
	refs.displayHost = hostInfo.displayHost;
	refs.osKind = hostInfo.osKind;
	refs.osLabel = hostInfo.osLabel;
	refs.isRemoteHost = hostInfo.isRemote;

	const osSlug = sanitizeCssSlug(hostInfo.osKind);
	refs.rootEl.setAttribute('data-node-state', nodeState);
	refs.rootEl.setAttribute('data-node-tier', String(levelNum));
	refs.rootEl.setAttribute('data-node-level', levelLabel);
	refs.rootEl.setAttribute('data-node-os', hostInfo.osKind);
	refs.rootEl.setAttribute('data-node-host', rawHost);
	refs.rootEl.setAttribute('data-session-started', String(sessionStarted));
	if (oNode.department) {
		refs.rootEl.setAttribute('data-department', oNode.department);
	} else {
		refs.rootEl.removeAttribute('data-department');
	}
	refs.rootEl.classList.toggle('is-remote-host', hostInfo.isRemote);
	refs.rootEl.classList.toggle('is-local-host', !hostInfo.isRemote);
	refs.rootEl.classList.toggle('state-active', nodeState === 'active');
	if (refs.lastOsSlug !== osSlug) {
		if (refs.lastOsSlug) {
			refs.rootEl.classList.remove(`os-${refs.lastOsSlug}`);
		}
		refs.rootEl.classList.add(`os-${osSlug}`);
		refs.lastOsSlug = osSlug;
	}

	if (refs.titleEl.firstElementChild?.tagName !== 'INPUT') {
		if (refs.titleEl.textContent !== oNode.label) {
			refs.titleEl.textContent = oNode.label;
		}
		if (refs.titleEl.title !== oNode.label) {
			refs.titleEl.title = oNode.label;
		}
	}

	refs.stateDotEl.hidden = nodeState === 'idle';
	if (nodeState !== 'idle') {
		refs.stateDotEl.title = nodeState;
	}

	const rawEngine = agentNode?.engine ?? oNode.engineId ?? 'claude';
	const engineId = toPrefixedAdeEngineId(rawEngine);
	const engineName = ctx.hostCatalog.getEngineDisplayName(engineId);
	const engineIcon = ctx.hostCatalog.getEngineIcon(engineId);
	const resolvedModel = agentNode?.model || oNode.model || MISSION_ENGINE_DEFAULT_MODELS[engineId] || 'claude-sonnet-4-5';
	const llmProvider = resolveEffectiveAdeLlmProvider(resolvedModel, engineId, ctx.hostCatalog.getModelCategoryOverrides());
	const llmProviderLabel = ADE_LLM_PROVIDER_LABELS[llmProvider];
	const resolvedThinking = agentNode?.effort || oNode.thinking || 'medium';

	refs.engineId = engineId;
	refs.canSwitchModel = true;
	refs.canSwitchEngine = true;
	refs.canSwitchHost = true;

	// Update live context window meter independently so streaming deltas stay O(1)
	renderStaffContextUsageMeter(refs, resolvedModel, rawEngine, sessionStarted, liveChatState, contextUsage, ctx);

	const clampedTier = Math.max(1, Math.min(4, levelNum));
	const headerSig = JSON.stringify([levelNum, isTopRole, oNode.department ?? '', oNode.color ?? '', oNode.label]);
	if (refs.lastHeaderSig !== headerSig) {
		refs.lastHeaderSig = headerSig;
		ctx.applyCustomNodeColor(refs.rootEl, oNode.color);
		refs.rankPillEl.className = `ade-mission-rank-pill tier-${clampedTier}`;
		refs.rankPillEl.textContent = levelLabel;
		refs.rankPillEl.title = isTopRole
			? adeBi(localize('adeTopRoleLevelTip', "{0} · Sole Top-Level Lead", levelLabel), '{0} · 唯一顶层负责人', levelLabel)
			: levelLabel;

		clearNode(refs.topRightEl);
		if (oNode.department) {
			append(refs.topRightEl, $('span.ade-orch-dept-pill', { title: oNode.department }, oNode.department));
		}
		if (isTopRole) {
			append(refs.topRightEl, $('span.ade-orch-dept-pill.is-top-role', {
				title: adeBi(localize('adeTopRoleBadgeTip', "Project Root Lead (is_top_role = true)"), '项目唯一顶层负责人'),
			}, 'TOP'));
		}
	}

	const modelSig = JSON.stringify([
		engineId,
		engineName,
		resolvedModel,
		llmProvider,
		resolvedThinking,
		sessionStarted,
		rawHost,
		hostInfo.displayHost,
		hostInfo.osKind,
		hostInfo.osLabel,
		hostInfo.isRemote,
	]);
	if (refs.lastModelSig !== modelSig) {
		refs.lastModelSig = modelSig;
		refs.coreIconTileEl.className = `ade-mission-core-icon-well llm-${sanitizeCssSlug(llmProvider)}`;
		refs.coreIconTileEl.setAttribute('data-llm-provider', llmProvider);
		refs.coreIconTileEl.title = `${llmProviderLabel} · ${resolvedModel}`;
		clearNode(refs.coreLlmGlyphEl);
		renderAdeLlmIcon(refs.coreLlmGlyphEl, llmProvider, {
			baseClass: 'ade-mission-llm-icon',
			prefix: 'ade-llm',
			tooltip: `${llmProviderLabel} · ${resolvedModel}`,
		});

		refs.modelRowEl.className = 'ade-mission-core-model-row';
		refs.modelRowEl.setAttribute('data-node-model', resolvedModel);
		refs.modelRowEl.setAttribute('data-node-thinking', resolvedThinking);

		refs.modelPillEl.className = 'ade-mission-model-pill is-editable';
		refs.modelPillEl.disabled = false;
		refs.modelPillEl.setAttribute('data-node-model', resolvedModel);
		refs.modelPillEl.title = adeBi(
			localize('adeStaffModelPillTip', "Model: {0} — Click to switch model", resolvedModel),
			'当前模型：{0} — 点击原位切换模型',
			resolvedModel,
		);
		refs.modelNameEl.textContent = resolvedModel;

		refs.thinkingTagEl.className = `ade-mission-thinking-tag level-${sanitizeCssSlug(resolvedThinking)} is-editable`;
		refs.thinkingTagEl.disabled = false;
		refs.thinkingTagEl.setAttribute('data-node-thinking', resolvedThinking);
		refs.thinkingTagEl.title = adeBi(
			localize('adeStaffEffortPillTip', "Thinking Effort: {0} — Click to switch effort", resolvedThinking),
			'思考程度：{0} — 点击原位切换思考档位',
			resolvedThinking,
		);
		refs.thinkingLabelEl.textContent = resolvedThinking;

		const hostDisplayLabel = hostInfo.isRemote
			? (hostInfo.displayHost || rawHost)
			: `Local · ${hostInfo.osLabel}`;
		refs.engineBadgeEl.className = 'ade-mission-engine-pill is-editable';
		refs.engineBadgeEl.setAttribute('data-node-engine-id', rawEngine);
		refs.engineBadgeEl.setAttribute('data-engine-locked', 'false');
		refs.engineBadgeEl.setAttribute('data-session-started', String(sessionStarted));
		refs.engineBadgeEl.disabled = false;
		refs.engineBadgeEl.title = sessionStarted
			? adeBi(localize('adeOrchEngineSwitchResetTip', "Engine: {0} — Click to switch engine (starts fresh session)", engineName), '执行引擎：{0} — 点击切换引擎（将开启新会话）', engineName)
			: adeBi(localize('adeOrchEngineSwitchTip', "Engine: {0} — Click to switch engine", engineName), '执行引擎：{0} — 点击切换引擎', engineName);
		clearNode(refs.engineIconEl);
		applyMissionEngineIcon(refs.engineIconEl, engineIcon);
		refs.engineNameEl.textContent = engineName;

		refs.hostPillEl.className = `ade-mission-host-pill os-${osSlug}${hostInfo.isRemote ? ' is-remote' : ' is-local'} is-editable`;
		refs.hostPillEl.setAttribute('data-node-host', rawHost);
		refs.hostPillEl.setAttribute('data-node-os', hostInfo.osKind);
		refs.hostPillEl.removeAttribute('data-host-readonly');
		refs.hostPillEl.disabled = false;
		refs.hostPillEl.title = sessionStarted
			? adeBi(localize('adeOrchHostSwitchResetTip', "Host: {0} ({1}) — Click to switch host (starts fresh session)", hostDisplayLabel, hostInfo.osLabel), '运行主机：{0}（{1}）— 点击切换主机（将开启新会话）', hostDisplayLabel, hostInfo.osLabel)
			: adeBi(localize('adeOrchHostSwitchTip', "Host: {0} ({1}) — Click to switch host", hostDisplayLabel, hostInfo.osLabel), '运行主机：{0}（{1}）— 点击切换运行主机', hostDisplayLabel, hostInfo.osLabel);
		clearNode(refs.hostOsIconEl);
		renderAdeOsIcon(refs.hostOsIconEl, hostInfo.osKind, { baseClass: 'ade-mission-os-icon', prefix: 'ade-os' });
		refs.hostNameEl.textContent = hostDisplayLabel;
	}

	const roleSummary = (agentNode?.role_summary ?? oNode.roleSummary ?? '').trim();
	const topHeld = heldTickets[0];
	const runtimeSig = JSON.stringify([
		roleSummary,
		sessionStarted,
		liveChatState ?? 'idle',
		heldTickets.length,
		topHeld?.ticket_id ?? '',
		topHeld?.current_task_title ?? '',
		modelSig,
		oNode.color ?? '',
		oNode.label,
	]);
	if (refs.lastRuntimeSig === runtimeSig) {
		return;
	}
	refs.lastRuntimeSig = runtimeSig;

	refs.dynamicDisposables.clear();
	clearNode(refs.colorTriggerWrapEl);
	ctx.mountNodeColorTrigger(refs.colorTriggerWrapEl, oNode.id, oNode.label, oNode.color, refs.dynamicDisposables);

	if (ctx.onOpenStaffEditPopover) {
		refs.dynamicDisposables.add(addDisposableListener(refs.editBtnEl, EventType.CLICK, e => {
			e.stopPropagation();
			ctx.onOpenStaffEditPopover?.(oNode, refs.editBtnEl);
		}));
	}
	refs.dynamicDisposables.add(addDisposableListener(refs.openChatBtnEl, EventType.CLICK, (e: MouseEvent) => {
		e.stopPropagation();
		ctx.onOpenAgentSession?.(oNode.id, Boolean(e.altKey || e.metaKey || e.ctrlKey));
	}));
	refs.dynamicDisposables.add(addDisposableListener(refs.modelPillEl, EventType.CLICK, e => {
		e.stopPropagation();
		ctx.onOpenModelPopover(oNode.id, linkedAgent, engineId, refs.modelPillEl, {
			currentModel: resolvedModel,
			currentThinking: resolvedThinking,
			hostAlias: rawHost,
		});
	}));
	refs.dynamicDisposables.add(addDisposableListener(refs.thinkingTagEl, EventType.CLICK, e => {
		e.stopPropagation();
		if (ctx.onOpenEffortPopover) {
			ctx.onOpenEffortPopover(oNode.id, linkedAgent, engineId, refs.thinkingTagEl, {
				currentThinking: resolvedThinking,
				hostAlias: rawHost,
			});
		} else {
			ctx.onOpenModelPopover(oNode.id, linkedAgent, engineId, refs.thinkingTagEl, {
				currentModel: resolvedModel,
				currentThinking: resolvedThinking,
				hostAlias: rawHost,
			});
		}
	}));
	refs.dynamicDisposables.add(addDisposableListener(refs.engineBadgeEl, EventType.CLICK, e => {
		e.stopPropagation();
		ctx.onOpenEnginePopover(oNode.id, linkedAgent, engineId, refs.engineBadgeEl, {
			staffLabel: oNode.label,
			hostAlias: rawHost,
			currentModel: resolvedModel,
			currentThinking: resolvedThinking,
		});
	}));
	refs.dynamicDisposables.add(addDisposableListener(refs.hostPillEl, EventType.CLICK, e => {
		e.stopPropagation();
		ctx.onOpenHostPopover?.(oNode.id, linkedAgent, rawHost, refs.hostPillEl, {
			staffLabel: oNode.label,
			currentEngine: rawEngine,
			currentModel: resolvedModel,
			currentThinking: resolvedThinking,
		});
	}));

	const displayRole = roleSummary || adeBi(localize('adeStaffNoRoleSummary', "No role summary specified"), '未填写职责简述');
	refs.contextSummaryEl.textContent = displayRole;
	refs.contextSummaryEl.title = displayRole;

	if (liveChatState === 'working') {
		refs.liveBadgeEl.hidden = false;
		refs.liveBadgeEl.className = 'ade-orch-live-badge is-working';
		refs.liveBadgeEl.textContent = adeBi(localize('adeStaffWorkingBadge', "Running"), '运行中');
	} else if (heldTickets.length > 0) {
		refs.liveBadgeEl.hidden = false;
		refs.liveBadgeEl.className = 'ade-orch-live-badge is-ticket';
		refs.liveBadgeEl.textContent = `🎫 ${heldTickets.length}`;
		refs.liveBadgeEl.title = heldTickets.map(t => `${t.ticket_id}: ${t.current_task_title}`).join('\n');
	} else if (sessionStarted) {
		refs.liveBadgeEl.hidden = false;
		refs.liveBadgeEl.className = 'ade-orch-live-badge is-ready';
		refs.liveBadgeEl.textContent = adeBi(localize('adeStaffLiveReadyBadge', "Active"), '已激活');
	} else {
		refs.liveBadgeEl.hidden = true;
		refs.liveBadgeEl.textContent = '';
	}

	if (topHeld) {
		refs.statusStripEl.className = 'ade-mission-node-status-strip has-ticket';
		refs.statusIcoEl.className = 'codicon codicon-ticket ade-mission-node-prompt-ico';
		refs.statusPreviewEl.textContent = `${topHeld.ticket_id} · ${topHeld.current_task_title}`;
		refs.statusTagEl.textContent = heldTickets.length > 1
			? `+${heldTickets.length - 1}`
			: adeBi(localize('adeStaffActiveTag', "Held"), '持有中');
		refs.statusStripEl.title = heldTickets.map(t => `${t.ticket_id} · ${t.current_task_title}`).join('\n');
	} else if (liveChatState === 'working') {
		refs.statusStripEl.className = 'ade-mission-node-status-strip is-working';
		refs.statusIcoEl.className = 'codicon codicon-loading codicon-modifier-spin ade-mission-node-prompt-ico';
		refs.statusPreviewEl.textContent = adeBi(
			localize('adeStaffStreamingHint', "Executing active turn · Double-click to inspect"),
			'正在执行当前会话轮次 · 双击查看实时输出',
		);
		refs.statusTagEl.textContent = adeBi(localize('adeStaffStreamingTag', "Live"), '流式中');
		refs.statusStripEl.title = refs.statusPreviewEl.textContent;
	} else {
		refs.statusStripEl.className = 'ade-mission-node-status-strip';
		refs.statusIcoEl.className = 'codicon codicon-comment-discussion ade-mission-node-prompt-ico';
		refs.statusPreviewEl.textContent = adeBi(
			localize('adeStaffDoubleClickChatHintV2', "Double-click card to enter session"),
			'双击卡片进入会话',
		);
		refs.statusTagEl.textContent = sessionStarted
			? adeBi(localize('adeStaffReadyTag', "Ready"), '就绪')
			: adeBi(localize('adeStaffUnstartedTag', "Standby"), '待启动');
		refs.statusStripEl.title = refs.statusPreviewEl.textContent;
	}
}
