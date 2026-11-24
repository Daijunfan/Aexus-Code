/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import {
	addEdgeToMermaid,
	addNodeToMermaid,
	IMissionNodePosition,
	removeEdgeFromMermaid,
	removeNodeFromMermaid,
	removeNodesFromMermaid,
	renameEdgeLabelInMermaid,
	renameNodeInMermaid,
	upsertTaskMetadataInMermaid,
} from '../../../../platform/ade/common/adeMissionDag.js';
import {
	IOrchestrationWhiteboard,
	planDynamicSubordinateCreation,
	upsertDepartmentWhiteboard,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	addOrchestrationGroup,
	addStaffNodeToOrchestration,
	addWhiteboardNodeToOrchestration,
	connectOrchestrationEdge,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	moveOrchestrationNodeToGroup,
	removeOrchestrationEdge,
	removeOrchestrationGroup,
	removeOrchestrationNode,
	renameOrchestrationEdgeLabel,
	renameOrchestrationGroup,
	renameOrchestrationNode,
	upsertOrchestrationNodeColorInCode,
	upsertOrchestrationWhiteboardInCode,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, IAdeOrganizationConfig } from '../../../../platform/ade/common/adeRoleSchema.js';
import { AdeEngineeringViewMode } from '../common/ade.js';
import { adeBi } from '../common/adeLocalization.js';
import { IEngineeringHistoryEntry, pruneWhiteboardsForDeletedNodes } from './adeEngineeringViewLinkage.js';
import type { IAdeMissionRuntimeService } from './adeMissionRuntime.js';
import type { IAdeMissionService } from './adeMissionStore.js';

export interface IEngineeringCommitCodeOptions {
	readonly nodePosition?: { readonly nodeId: string; readonly pos: IMissionNodePosition };
	readonly clearPositions?: boolean;
	readonly successMessage?: string;
	readonly afterApply?: () => void;
}

export interface IEngineeringGraphActionsHost {
	getActiveMissionId(): string | undefined;
	getViewMode(): AdeEngineeringViewMode;
	isDisposed(): boolean;
	getMermaidText(): string;
	getDirection(): 'LR' | 'TD';
	getOrchestrationText(): string;
	setOrchestrationText(text: string): void;
	getOrchDirection(): 'LR' | 'TD';
	getOrchNodes(): readonly IOrchestrationGraphNode[];
	getOrchEdges(): readonly IOrchestrationGraphEdge[];
	getNodePosition(nodeId: string): IMissionNodePosition | undefined;
	computeDefaultNewNodeWorldPos(): IMissionNodePosition;
	getOrgConfig(): IAdeOrganizationConfig;
	getActiveWhiteboards(): Readonly<Record<string, IOrchestrationWhiteboard>>;
	getMissionService(): IAdeMissionService | undefined;
	getMissionRuntimeService(): IAdeMissionRuntimeService | undefined;
	captureHistorySnapshot(label: string): IEngineeringHistoryEntry;
	pushHistory(entry: IEngineeringHistoryEntry): void;
	commitCodeMutation(nextCode: string, reason: string, options?: IEngineeringCommitCodeOptions): void;
	syncCodeToDrawer(nextCode: string): void;
	parseAndRenderOrchestrationGraph(nextCode: string, forceAutoLayout: boolean): void;
	syncAllNodePromptViews(): void;
	removeDeletedNodeIdsFromSelection(nodeIds: readonly string[]): void;
	reportFeedback(message: string, kind: 'error' | 'ok' | 'info', options?: { readonly offerOpenFile?: boolean }): void;
}

/**
 * Encapsulates visual canvas graph authoring mutations (adding/renaming/deleting
 * tasks, staff, whiteboards, groups, edges, and node colors) so the main editor
 * pane stays cohesive and strictly below the module size limit.
 */
export class AdeEngineeringGraphActions {
	constructor(private readonly host: IEngineeringGraphActionsHost) { }

	addOrchestrationStaffVisual(payload: {
		readonly name: string;
		readonly rankId: string;
		readonly tier: number;
		readonly department?: string;
		readonly worldPos?: IMissionNodePosition;
	}): void {
		const missionId = this.host.getActiveMissionId();
		if (!missionId) {
			return;
		}
		const org = this.host.getOrgConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const rankDef = org.ranks.find(r => r.id === payload.rankId || r.tier === payload.tier);
		const added = addStaffNodeToOrchestration(this.host.getOrchestrationText(), {
			name: payload.name,
			roleLabel: rankDef?.name,
			tier: payload.tier,
			rankId: payload.rankId,
			department: payload.department,
			direction: this.host.getOrchDirection(),
		});
		if (!added.ok || !added.orchestrationText || !added.nodeId) {
			this.host.reportFeedback(added.error ?? adeBi(localize('adeOrchAddStaffFail', "Failed to add staff node."), '添加员工节点失败。'), 'error');
			return;
		}
		const targetPos = payload.worldPos ?? this.host.computeDefaultNewNodeWorldPos();
		this.host.commitCodeMutation(added.orchestrationText, `Add staff ${payload.name}`, {
			nodePosition: { nodeId: added.nodeId, pos: targetPos },
			successMessage: adeBi(
				localize('adeOrchAddStaffOk', "Added unique staff node '{0}' ({1}).", payload.name, added.nodeId),
				'已添加唯一员工节点「{0}」({1})。',
				payload.name,
				added.nodeId,
			),
		});
	}

	addOrchestrationSubordinateVisual(
		parentNode: IOrchestrationGraphNode,
		payload: {
			readonly name: string;
			readonly rankId: string;
			readonly tier: number;
			readonly department?: string;
		},
	): void {
		const missionId = this.host.getActiveMissionId();
		if (!missionId) {
			return;
		}
		const org = this.host.getOrgConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const plan = planDynamicSubordinateCreation(this.host.getOrchestrationText(), org, {
			callerNodeId: parentNode.id,
			callerTier: parentNode.tier,
			name: payload.name,
			targetRankIdOrTier: payload.rankId || payload.tier,
			department: payload.department ?? parentNode.department,
			bidirectional: true,
		});
		if (!plan.ok || !plan.orchestrationText || !plan.newNodeId) {
			this.host.reportFeedback(plan.error ?? adeBi(localize('adeOrchAddSubFail', "Failed to create subordinate."), '动态创建下级员工失败。'), 'error');
			return;
		}
		const parentPos = this.host.getNodePosition(parentNode.id);
		const orchDir = this.host.getOrchDirection();
		const targetPos = parentPos
			? {
				x: Math.round(parentPos.x + (orchDir === 'TD' ? 0 : 440)),
				y: Math.round(parentPos.y + (orchDir === 'TD' ? 300 : 120)),
			}
			: this.host.computeDefaultNewNodeWorldPos();
		this.host.commitCodeMutation(plan.orchestrationText, `Create subordinate ${payload.name} under ${parentNode.id}`, {
			nodePosition: { nodeId: plan.newNodeId, pos: targetPos },
			successMessage: adeBi(
				localize('adeOrchAddSubOk', "Created subordinate '{0}' ({1}) with bidirectional link {2} ⇄ {1}.", payload.name, plan.newNodeId, parentNode.id),
				'已动态扩编下级「{0}」({1})，并自动建立双向连线 {2} ⇄ {1}。',
				payload.name,
				plan.newNodeId,
				parentNode.id,
			),
		});
	}

	addOrchestrationWhiteboardVisual(payload: {
		readonly department: string;
		readonly title: string;
		readonly worldPos?: IMissionNodePosition;
	}): void {
		const missionId = this.host.getActiveMissionId();
		if (!missionId) {
			return;
		}
		const added = addWhiteboardNodeToOrchestration(this.host.getOrchestrationText(), {
			department: payload.department,
			title: payload.title,
			direction: this.host.getOrchDirection(),
		});
		if (!added.ok || !added.orchestrationText || !added.whiteboardId) {
			this.host.reportFeedback(added.error ?? adeBi(localize('adeOrchAddWbFail', "Failed to add whiteboard."), '创建部门白板失败。'), 'error');
			return;
		}
		const wbId = added.whiteboardId;
		const targetPos = payload.worldPos ?? this.host.computeDefaultNewNodeWorldPos();
		this.host.commitCodeMutation(added.orchestrationText, `Add whiteboard ${payload.title}`, {
			nodePosition: { nodeId: wbId, pos: targetPos },
			afterApply: () => {
				const runtime = this.host.getMissionRuntimeService();
				const store = this.host.getMissionService();
				if (runtime) {
					runtime.upsertOrchestrationWhiteboard(missionId, {
						id: wbId,
						department: payload.department,
						title: payload.title,
						content: '',
						caller: { isHumanUser: true },
					});
				} else if (store) {
					const up = upsertDepartmentWhiteboard(this.host.getActiveWhiteboards(), {
						id: wbId,
						department: payload.department,
						title: payload.title,
						content: '',
					});
					store.updateWhiteboards(missionId, up.whiteboards);
				}
			},
			successMessage: adeBi(
				localize('adeOrchAddWbOk', "Created department whiteboard '{0}' ({1}).", payload.title, wbId),
				'已创建部门共享白板「{0}」({1})。',
				payload.title,
				wbId,
			),
		});
	}

	saveWhiteboardPatch(
		missionId: string,
		liveWb: IOrchestrationWhiteboard,
		patch: { readonly department: string; readonly title: string; readonly content: string },
	): { readonly ok: boolean; readonly codeChanged: boolean } {
		const runtime = this.host.getMissionRuntimeService();
		const store = this.host.getMissionService();
		let savedVersion = (liveWb.version ?? 0) + 1;
		let codeChanged = false;
		if (runtime) {
			const res = runtime.upsertOrchestrationWhiteboard(missionId, {
				id: liveWb.id,
				department: patch.department,
				title: patch.title,
				content: patch.content,
				caller: { isHumanUser: true },
			});
			if (!res.ok && res.error) {
				this.host.reportFeedback(res.error, 'error');
				return { ok: false, codeChanged: false };
			}
			if (res.whiteboard) {
				savedVersion = res.whiteboard.version;
			}
			if (res.orchestrationText && res.orchestrationText !== this.host.getOrchestrationText()) {
				this.host.setOrchestrationText(res.orchestrationText);
				this.host.syncCodeToDrawer(res.orchestrationText);
				codeChanged = true;
			}
		} else if (store) {
			const up = upsertDepartmentWhiteboard(this.host.getActiveWhiteboards(), {
				id: liveWb.id,
				department: patch.department,
				title: patch.title,
				content: patch.content,
				updatedBy: 'human',
				updatedByLabel: 'Human',
			});
			savedVersion = up.whiteboard.version;
			store.updateWhiteboards(missionId, up.whiteboards);
			const nextCode = upsertOrchestrationWhiteboardInCode(this.host.getOrchestrationText(), {
				id: liveWb.id,
				department: patch.department,
				title: patch.title,
				content: patch.content,
				version: savedVersion,
			});
			if (nextCode !== this.host.getOrchestrationText()) {
				this.host.setOrchestrationText(nextCode);
				this.host.syncCodeToDrawer(nextCode);
				store.updateOrchestrationText(missionId, nextCode);
				codeChanged = true;
			}
		}
		void savedVersion;
		return { ok: true, codeChanged };
	}

	addMissionTaskVisual(worldPos?: IMissionNodePosition): void {
		const missionId = this.host.getActiveMissionId();
		if (!missionId) {
			return;
		}
		const targetPos = worldPos ?? this.host.computeDefaultNewNodeWorldPos();
		const added = addNodeToMermaid(this.host.getMermaidText(), {
			kind: 'task',
			direction: this.host.getDirection(),
		});
		this.host.commitCodeMutation(added.mermaidText, `Add task ${added.nodeId}`, {
			nodePosition: { nodeId: added.nodeId, pos: targetPos },
			afterApply: () => {
				const store = this.host.getMissionService();
				if (store) {
					const existingRec = store.getMission(missionId);
					if (existingRec?.nodePrompts?.[added.nodeId]) {
						store.updateNodePrompt(missionId, added.nodeId, '');
					}
					this.host.syncAllNodePromptViews();
				}
			},
			successMessage: adeBi(
				localize('adeMissionVisualAddTaskOk', "Added task node {0} (click to edit description, drag port to connect).", added.nodeId),
				'已添加任务节点 {0}（点击编辑描述，拖拽端口连线）。',
				added.nodeId,
			),
		});
	}

	renameVisualNode(nodeId: string, nextLabel: string): void {
		if (this.host.getViewMode() === 'orchestration') {
			const cur = this.host.getOrchestrationText();
			const nextCode = renameOrchestrationNode(cur, nodeId, nextLabel);
			if (nextCode === cur) {
				return;
			}
			this.host.commitCodeMutation(nextCode, `Rename ${nodeId}`, {
				successMessage: adeBi(localize('adeMissionVisualRenameOk', "Renamed {0} to '{1}'.", nodeId, nextLabel), '已将节点 {0} 重命名为「{1}」。', nodeId, nextLabel),
			});
			return;
		}
		const cur = this.host.getMermaidText();
		const nextMermaid = renameNodeInMermaid(cur, nodeId, nextLabel);
		if (nextMermaid === cur) {
			return;
		}
		this.host.commitCodeMutation(nextMermaid, `Rename ${nodeId}`, {
			successMessage: adeBi(localize('adeMissionVisualRenameOk', "Renamed {0} to '{1}'.", nodeId, nextLabel), '已将节点 {0} 重命名为「{1}」。', nodeId, nextLabel),
		});
	}

	deleteVisualNodes(nodeIds: readonly string[]): void {
		const missionId = this.host.getActiveMissionId();
		const uniqueIds = [...new Set(nodeIds.map(id => id.trim()).filter(Boolean))];
		if (uniqueIds.length === 0) {
			return;
		}
		if (this.host.getViewMode() === 'orchestration') {
			const orchNodes = this.host.getOrchNodes();
			const staffIds = uniqueIds.filter(id => orchNodes.some(n => n.id === id && n.kind === 'staff'));
			const nonStaffIds = uniqueIds.filter(id => !staffIds.includes(id));
			const runtime = this.host.getMissionRuntimeService();
			const store = this.host.getMissionService();

			if (missionId && runtime && staffIds.length > 0) {
				const preDeleteSnap = this.host.captureHistorySnapshot(`Delete ${uniqueIds.join(', ')}`);
				void (async () => {
					let removedCount = 0;
					let reclaimedTotal = 0;
					let recoveryTotal = 0;
					const errors: string[] = [];
					for (const staffId of staffIds) {
						const res = await runtime.removeOrchestrationSubordinate(missionId, {
							targetNodeId: staffId,
							isHumanUser: true,
							force: true,
							reason: 'Removed from Engineering canvas',
						});
						if (res.ok) {
							removedCount++;
							reclaimedTotal += res.reclaimedTokenIds?.length ?? 0;
							recoveryTotal += res.recoveryTokenIds?.length ?? 0;
						} else if (res.error) {
							errors.push(`${staffId}: ${res.error}`);
						}
					}
					if (this.host.isDisposed() || this.host.getActiveMissionId() !== missionId) {
						return;
					}
					const latestText = store?.getMission(missionId)?.orchestrationText ?? this.host.getOrchestrationText();
					let nextCode = latestText;
					for (const id of nonStaffIds) {
						nextCode = removeOrchestrationNode(nextCode, id);
					}
					if (nextCode !== latestText) {
						store?.updateOrchestrationText(missionId, nextCode);
						removedCount += nonStaffIds.length;
					}
					if (removedCount > 0 || nextCode !== latestText) {
						this.host.pushHistory(preDeleteSnap);
					}
					const prunedWbs = pruneWhiteboardsForDeletedNodes(this.host.getActiveWhiteboards(), nonStaffIds);
					if (prunedWbs) {
						store?.updateWhiteboards(missionId, prunedWbs);
					}
					this.host.setOrchestrationText(nextCode);
					this.host.syncCodeToDrawer(nextCode);
					this.host.removeDeletedNodeIdsFromSelection(uniqueIds);
					this.host.parseAndRenderOrchestrationGraph(nextCode, false);
					if (errors.length > 0) {
						this.host.reportFeedback(errors.join(' | '), 'error');
					} else if (removedCount > 0) {
						const reclaimNote = reclaimedTotal > 0
							? adeBi(
								localize('adeOrchDeleteReclaimNote', " (reclaimed {0} token(s), bounced {1} recovery baton(s))", reclaimedTotal, recoveryTotal),
								'（已回收 {0} 枚在途令牌，回弹 {1} 枚恢复令牌给上级）',
								reclaimedTotal,
								recoveryTotal,
							)
							: '';
						this.host.reportFeedback(adeBi(
							localize('adeOrchDeleteOkWithReclaim', "Removed {0} node(s){1}.", removedCount, reclaimNote),
							'已删除 {0} 个节点{1}。',
							removedCount,
							reclaimNote,
						), 'ok');
					}
				})();
				return;
			}

			const curCode = this.host.getOrchestrationText();
			let nextCode = curCode;
			for (const id of uniqueIds) {
				nextCode = removeOrchestrationNode(nextCode, id);
			}
			if (nextCode === curCode) {
				return;
			}
			this.host.commitCodeMutation(nextCode, `Delete ${uniqueIds.join(', ')}`, {
				afterApply: () => {
					if (missionId) {
						const prunedWbs = pruneWhiteboardsForDeletedNodes(this.host.getActiveWhiteboards(), uniqueIds);
						if (prunedWbs) {
							store?.updateWhiteboards(missionId, prunedWbs);
						}
					}
					this.host.removeDeletedNodeIdsFromSelection(uniqueIds);
				},
				successMessage: adeBi(localize('adeOrchDeleteOk', "Removed {0} node(s).", uniqueIds.length), '已删除 {0} 个节点。', uniqueIds.length),
			});
			return;
		}

		const curMermaid = this.host.getMermaidText();
		const nextMermaid = uniqueIds.length === 1
			? removeNodeFromMermaid(curMermaid, uniqueIds[0])
			: removeNodesFromMermaid(curMermaid, uniqueIds);
		if (nextMermaid === curMermaid) {
			return;
		}
		this.host.commitCodeMutation(nextMermaid, `Delete ${uniqueIds.join(', ')}`, {
			afterApply: () => {
				const store = this.host.getMissionService();
				if (missionId && store) {
					for (const nid of uniqueIds) {
						store.updateNodePrompt(missionId, nid, '');
					}
					this.host.syncAllNodePromptViews();
				}
				this.host.removeDeletedNodeIdsFromSelection(uniqueIds);
			},
			successMessage: adeBi(localize('adeMissionDeleteTasksOk', "Removed {0} task node(s).", uniqueIds.length), '已删除 {0} 个任务节点。', uniqueIds.length),
		});
	}

	renameVisualEdgeLabel(fromId: string, toId: string, nextLabel: string): void {
		if (this.host.getViewMode() === 'orchestration') {
			const cur = this.host.getOrchestrationText();
			const nextCode = renameOrchestrationEdgeLabel(cur, fromId, toId, nextLabel);
			if (nextCode !== cur) {
				this.host.commitCodeMutation(nextCode, `Edit edge label ${fromId}->${toId}`);
			}
			return;
		}
		const cur = this.host.getMermaidText();
		const nextMermaid = renameEdgeLabelInMermaid(cur, fromId, toId, nextLabel);
		if (nextMermaid !== cur) {
			this.host.commitCodeMutation(nextMermaid, `Edit edge label ${fromId}->${toId}`);
		}
	}

	connectVisualEdge(fromId: string, toId: string, options?: { readonly fail?: boolean; readonly bidirectional?: boolean }): void {
		if (this.host.getViewMode() === 'orchestration') {
			const res = connectOrchestrationEdge(this.host.getOrchestrationText(), fromId, toId, {
				bidirectional: options?.bidirectional,
			});
			if (!res.ok || !res.orchestrationText) {
				this.host.reportFeedback(res.error ?? adeBi(localize('adeMissionVisualConnectFail', "Cannot create edge."), '无法建立连线。'), 'error');
				return;
			}
			const orchNodes = this.host.getOrchNodes();
			const fromStaff = orchNodes.find(n => n.id === fromId && n.kind === 'staff');
			const toStaff = orchNodes.find(n => n.id === toId && n.kind === 'staff');
			const hasReverse = this.host.getOrchEdges().some(e => e.from === toId && e.to === fromId);
			const isDownwardOneWay = !options?.bidirectional && !hasReverse
				&& fromStaff?.tier !== undefined && toStaff?.tier !== undefined && fromStaff.tier < toStaff.tier;
			this.host.commitCodeMutation(res.orchestrationText, `Connect ${fromId} ${options?.bidirectional ? '<-->' : '-->'} ${toId}`, {
				successMessage: options?.bidirectional
					? adeBi(localize('adeOrchConnectBidirOk', "Connected {0} <--> {1}.", fromId, toId), '已建立双向连线 {0} ⇄ {1}。', fromId, toId)
					: isDownwardOneWay
						? adeBi(localize('adeOrchConnectOneWayTip', "Connected {0} → {1} (Tip: right-click edge → Make Bidirectional <--> if subordinate must return tokens).", fromId, toId), '已建立单向连线 {0} → {1}（提示：若下级需回传令牌，请右键连线切换为双向 <-->）。', fromId, toId)
						: adeBi(localize('adeMissionVisualConnectOk', "Connected {0} → {1}.", fromId, toId), '已建立连线 {0} → {1}。', fromId, toId),
			});
			return;
		}
		const res = addEdgeToMermaid(this.host.getMermaidText(), fromId, toId);
		if (!res.ok || !res.mermaidText) {
			this.host.reportFeedback(res.error ?? adeBi(localize('adeMissionVisualConnectFail', "Cannot create edge."), '无法建立连线。'), 'error');
			return;
		}
		this.host.commitCodeMutation(res.mermaidText, `Connect ${fromId} -> ${toId}`, {
			successMessage: adeBi(localize('adeMissionVisualConnectOk', "Connected {0} → {1}.", fromId, toId), '已建立任务依赖 {0} → {1}。', fromId, toId),
		});
	}

	deleteVisualEdge(fromId: string, toId: string): void {
		if (this.host.getViewMode() === 'orchestration') {
			const cur = this.host.getOrchestrationText();
			const nextCode = removeOrchestrationEdge(cur, fromId, toId);
			if (nextCode !== cur) {
				this.host.commitCodeMutation(nextCode, `Delete edge ${fromId} -> ${toId}`, {
					successMessage: adeBi(localize('adeMissionVisualDeleteEdgeOk', "Removed edge {0} → {1}.", fromId, toId), '已删除连线 {0} → {1}。', fromId, toId),
				});
			}
			return;
		}
		const cur = this.host.getMermaidText();
		const nextMermaid = removeEdgeFromMermaid(cur, fromId, toId);
		if (nextMermaid !== cur) {
			this.host.commitCodeMutation(nextMermaid, `Delete edge ${fromId} -> ${toId}`, {
				successMessage: adeBi(localize('adeMissionVisualDeleteEdgeOk', "Removed edge {0} → {1}.", fromId, toId), '已删除连线 {0} → {1}。', fromId, toId),
			});
		}
	}

	toggleOrchestrationEdgeBidirectional(fromId: string, toId: string): void {
		const cur = this.host.getOrchestrationText();
		const hasReverse = this.host.getOrchEdges().some(e => e.from === toId && e.to === fromId);
		if (hasReverse) {
			const nextCode = removeOrchestrationEdge(cur, toId, fromId);
			if (nextCode !== cur) {
				this.host.commitCodeMutation(nextCode, `Unidirectional ${fromId} -> ${toId}`, {
					successMessage: adeBi(localize('adeOrchEdgeUnidirOk', "Switched {0} → {1} to one-way.", fromId, toId), '已将连线 {0} → {1} 切换为单向。', fromId, toId),
				});
			}
		} else {
			const res = connectOrchestrationEdge(cur, toId, fromId);
			if (res.ok && res.orchestrationText) {
				this.host.commitCodeMutation(res.orchestrationText, `Bidirectional ${fromId} <--> ${toId}`, {
					successMessage: adeBi(localize('adeOrchEdgeBidirOk', "Switched {0} ⇄ {1} to bidirectional.", fromId, toId), '已将连线 {0} ⇄ {1} 切换为双向。', fromId, toId),
				});
			}
		}
	}

	setNodeColorVisual(nodeId: string, color: string | null): void {
		if (!this.host.getActiveMissionId()) {
			return;
		}
		if (this.host.getViewMode() === 'mission') {
			const cur = this.host.getMermaidText();
			const nextMermaid = upsertTaskMetadataInMermaid(cur, nodeId, { color });
			if (nextMermaid !== cur) {
				this.host.commitCodeMutation(nextMermaid, `Set node color ${nodeId}`, {
					successMessage: color
						? adeBi(localize('adeNodeColorUpdatedOk', "Updated color for {0}.", nodeId), '已更新 {0} 的节点颜色。', nodeId)
						: adeBi(localize('adeNodeColorResetOk', "Reset color for {0} to default.", nodeId), '已恢复 {0} 为默认配色。', nodeId),
				});
			}
			return;
		}
		const cur = this.host.getOrchestrationText();
		const res = upsertOrchestrationNodeColorInCode(cur, nodeId, color);
		if (!res.ok || !res.orchestrationText) {
			this.host.reportFeedback(res.error ?? adeBi(localize('adeNodeColorFail', "Failed to update node color."), '更新节点颜色失败。'), 'error');
			return;
		}
		if (res.orchestrationText !== cur) {
			this.host.commitCodeMutation(res.orchestrationText, `Set node color ${nodeId}`, {
				successMessage: color
					? adeBi(localize('adeNodeColorUpdatedOk', "Updated color for {0}.", nodeId), '已更新 {0} 的节点颜色。', nodeId)
					: adeBi(localize('adeNodeColorResetOk', "Reset color for {0} to default.", nodeId), '已恢复 {0} 为默认配色。', nodeId),
			});
		}
	}

	addOrchestrationGroupVisual(name: string, worldPos?: IMissionNodePosition): void {
		const res = addOrchestrationGroup(this.host.getOrchestrationText(), {
			name,
			direction: this.host.getOrchDirection(),
		});
		if (!res.ok || !res.orchestrationText || !res.groupId) {
			this.host.reportFeedback(res.error ?? adeBi(localize('adeOrchAddGroupFail', "Failed to create group."), '创建分组失败。'), 'error');
			return;
		}
		this.host.commitCodeMutation(res.orchestrationText, `Add group ${name}`, {
			...(worldPos ? { nodePosition: { nodeId: res.groupId, pos: worldPos } } : {}),
			successMessage: adeBi(localize('adeOrchAddGroupOk', "Created group '{0}' ({1}).", res.groupName ?? name, res.groupId), '已创建部门分组「{0}」({1})。', res.groupName ?? name, res.groupId),
		});
	}

	renameOrchestrationGroupVisual(groupId: string, nextName: string): void {
		const res = renameOrchestrationGroup(this.host.getOrchestrationText(), groupId, nextName);
		if (!res.ok || !res.orchestrationText) {
			this.host.reportFeedback(res.error ?? adeBi(localize('adeOrchRenameGroupFail', "Failed to rename group."), '重命名分组失败。'), 'error');
			return;
		}
		this.host.commitCodeMutation(res.orchestrationText, `Rename group ${groupId}`, {
			successMessage: adeBi(localize('adeOrchRenameGroupOk', "Renamed group to '{0}'.", res.newName ?? nextName), '已将分组重命名为「{0}」。', res.newName ?? nextName),
		});
	}

	moveOrchestrationNodeToGroupVisual(nodeId: string, targetGroupIdOrName: string | undefined): void {
		const res = moveOrchestrationNodeToGroup(this.host.getOrchestrationText(), nodeId, targetGroupIdOrName);
		if (!res.ok || !res.orchestrationText) {
			this.host.reportFeedback(res.error ?? adeBi(localize('adeOrchMoveGroupFail', "Failed to move node to group."), '移动节点至分组失败。'), 'error');
			return;
		}
		this.host.commitCodeMutation(res.orchestrationText, `Move ${nodeId} to ${res.groupName ?? 'top-level'}`, {
			successMessage: res.groupName
				? adeBi(localize('adeOrchMoveGroupOk', "Moved {0} into group '{1}'.", nodeId, res.groupName), '已将节点 {0} 移入分组「{1}」。', nodeId, res.groupName)
				: adeBi(localize('adeOrchUngroupNodeOk', "Removed {0} from its group.", nodeId), '已将节点 {0} 移出分组。', nodeId),
		});
	}

	removeOrchestrationGroupVisual(groupId: string, deleteMembers: boolean): void {
		const missionId = this.host.getActiveMissionId();
		const res = removeOrchestrationGroup(this.host.getOrchestrationText(), groupId, { deleteMembers });
		if (!res.ok || !res.orchestrationText) {
			this.host.reportFeedback(res.error ?? adeBi(localize('adeOrchRemoveGroupFail', "Failed to remove group."), '删除分组失败。'), 'error');
			return;
		}
		this.host.commitCodeMutation(res.orchestrationText, deleteMembers ? `Delete group ${groupId} & members` : `Ungroup ${groupId}`, {
			afterApply: () => {
				if (deleteMembers && missionId && res.removedNodeIds && res.removedNodeIds.length > 0) {
					const prunedWbs = pruneWhiteboardsForDeletedNodes(this.host.getActiveWhiteboards(), res.removedNodeIds);
					if (prunedWbs) {
						this.host.getMissionService()?.updateWhiteboards(missionId, prunedWbs);
					}
				}
			},
			successMessage: deleteMembers
				? adeBi(localize('adeOrchDeleteGroupMembersOk', "Deleted group '{0}' and {1} member(s).", groupId, res.removedNodeIds?.length ?? 0), '已删除分组「{0}」及其 {1} 个成员。', groupId, res.removedNodeIds?.length ?? 0)
				: adeBi(localize('adeOrchUngroupOk', "Ungrouped '{0}' (all members preserved).", groupId), '已解散分组「{0}」（已保留全部成员）。', groupId),
		});
	}
}
