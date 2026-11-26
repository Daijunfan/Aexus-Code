/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import {
	IAdeControlCenterService,
	IAdeUiCreateAgentInput,
	IAdeUiEditAgentInput,
} from '../../../../platform/ade/common/adeControlCenterIpc.js';
import {
	AdeBoardPermission,
	AdeLayoutDirection,
	IAdeAgentNode,
	IAdeDepartment,
	IAdeProjectSnapshot,
	IAdeWhiteboard,
} from '../../../../platform/ade/common/adeModels.js';
import { IMissionNodePosition } from '../../../../platform/ade/common/adeOrchestrationLayout.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { adeBi } from '../common/adeLocalization.js';
import { EngineeringHistoryStore } from './adeEngineeringViewLinkage.js';
import { IAdeMissionService } from './adeMissionStore.js';

export interface IAdeEngineeringGraphActionsHost {
	getProjectId(): string | undefined;
	getProjectSnapshot(): IAdeProjectSnapshot | undefined;
	getCurrentPositionsObject(): Record<string, IMissionNodePosition>;
	clearLocalPositionCache?(): void;
	applyOptimisticPositions(positions: Readonly<Record<string, IMissionNodePosition>>): void;
	onFeedback(message: string, kind: 'ok' | 'error' | 'info'): void;
	onRefreshSnapshot(force?: boolean): Promise<void>;
}

/**
 * Coordinates all human UI mutations on the Project Orchestration Canvas via
 * `IAdeControlCenterService` (`state.db`), plus position Undo/Redo via `EngineeringHistoryStore`.
 */
export class AdeEngineeringGraphActions {
	constructor(
		private readonly controlCenter: IAdeControlCenterService | undefined,
		private readonly missionService: IAdeMissionService | undefined,
		private readonly dialogService: IDialogService | undefined,
		private readonly historyStore: EngineeringHistoryStore,
		private readonly host: IAdeEngineeringGraphActionsHost,
	) { }

	private requireControlCenter(): IAdeControlCenterService {
		if (!this.controlCenter) {
			throw new Error('ADE Control Center service is unavailable.');
		}
		return this.controlCenter;
	}

	async switchLayoutDirection(direction: AdeLayoutDirection): Promise<void> {
		const projectId = this.host.getProjectId();
		if (!projectId || !this.controlCenter) {
			return;
		}
		const snap = this.host.getProjectSnapshot();
		const beforePositions: Record<string, IMissionNodePosition> = {
			...this.host.getCurrentPositionsObject(),
		};
		if (snap) {
			for (const a of snap.agents) {
				if (!beforePositions[a.agent_id] && typeof a.canvas_x === 'number' && Number.isFinite(a.canvas_x) && typeof a.canvas_y === 'number' && Number.isFinite(a.canvas_y)) {
					beforePositions[a.agent_id] = { x: a.canvas_x, y: a.canvas_y };
				}
			}
			for (const w of snap.whiteboards) {
				if (!beforePositions[w.board_id] && typeof w.canvas_x === 'number' && Number.isFinite(w.canvas_x) && typeof w.canvas_y === 'number' && Number.isFinite(w.canvas_y)) {
					beforePositions[w.board_id] = { x: w.canvas_x, y: w.canvas_y };
				}
			}
		}
		if (Object.keys(beforePositions).length > 0) {
			this.historyStore.push(projectId, {
				positions: beforePositions,
				label: `Switch Layout (${direction})`,
			});
		}

		this.host.clearLocalPositionCache?.();
		this.missionService?.evictProjectSnapshot(projectId);

		const layoutPatch: Parameters<IAdeControlCenterService['uiUpdateCanvasLayout']>[1] & {
			readonly resetPinnedPositions?: boolean;
		} = {
			layoutDirection: direction,
			resetPinnedPositions: true,
		};
		await this.controlCenter.uiUpdateCanvasLayout(projectId, layoutPatch);
		await this.host.onRefreshSnapshot(true);
	}

	async commitPositionsChange(
		before: Readonly<Record<string, IMissionNodePosition>>,
		after: Readonly<Record<string, IMissionNodePosition>>,
		label: string,
	): Promise<void> {
		const projectId = this.host.getProjectId();
		if (!projectId || !this.controlCenter) {
			return;
		}
		this.historyStore.push(projectId, { positions: { ...before }, label });

		const snap = this.host.getProjectSnapshot();
		const patch: Record<string, { x: number; y: number; color?: string }> = {};
		for (const [id, pos] of Object.entries(after)) {
			const prev = before[id];
			if (!prev || prev.x !== pos.x || prev.y !== pos.y) {
				const agentColor = snap?.agents.find(a => a.agent_id === id)?.color_token;
				patch[id] = {
					x: Math.round(pos.x),
					y: Math.round(pos.y),
					...(agentColor ? { color: agentColor } : {}),
				};
			}
		}
		if (Object.keys(patch).length === 0) {
			return;
		}
		await this.controlCenter.uiUpdateCanvasLayout(projectId, { nodePositions: patch });
		await this.host.onRefreshSnapshot(true);
	}

	async undoPositions(): Promise<boolean> {
		const projectId = this.host.getProjectId();
		if (!projectId || !this.controlCenter) {
			return false;
		}
		const entry = this.historyStore.popUndo(projectId, label => ({
			positions: this.host.getCurrentPositionsObject(),
			label,
		}));
		if (!entry) {
			return false;
		}
		this.host.applyOptimisticPositions(entry.positions);
		const patch: Record<string, { x: number; y: number }> = {};
		for (const [id, pos] of Object.entries(entry.positions)) {
			patch[id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
		}
		await this.controlCenter.uiUpdateCanvasLayout(projectId, { nodePositions: patch });
		await this.host.onRefreshSnapshot(true);
		return true;
	}

	async redoPositions(): Promise<boolean> {
		const projectId = this.host.getProjectId();
		if (!projectId || !this.controlCenter) {
			return false;
		}
		const entry = this.historyStore.popRedo(projectId, label => ({
			positions: this.host.getCurrentPositionsObject(),
			label,
		}));
		if (!entry) {
			return false;
		}
		this.host.applyOptimisticPositions(entry.positions);
		const patch: Record<string, { x: number; y: number }> = {};
		for (const [id, pos] of Object.entries(entry.positions)) {
			patch[id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
		}
		await this.controlCenter.uiUpdateCanvasLayout(projectId, { nodePositions: patch });
		await this.host.onRefreshSnapshot(true);
		return true;
	}

	async createAgent(input: IAdeUiCreateAgentInput): Promise<IAdeAgentNode> {
		const cc = this.requireControlCenter();
		const created = await cc.uiCreateAgent(input);
		await this.host.onRefreshSnapshot(true);
		this.host.onFeedback(
			adeBi(
				localize('adeCreatedAgentOk', "Created employee '{0}' (L{1}).", created.name, created.level),
				`已创建员工「${created.name}」(L${created.level})。`,
			),
			'ok',
		);
		return created;
	}

	async editAgent(input: IAdeUiEditAgentInput): Promise<IAdeAgentNode> {
		const cc = this.requireControlCenter();
		const updated = await cc.uiEditAgent(input);
		await this.host.onRefreshSnapshot(true);
		return updated;
	}

	async renameNode(nodeId: string, nextName: string): Promise<void> {
		const projectId = this.host.getProjectId();
		const snap = this.host.getProjectSnapshot();
		if (!projectId || !snap || !this.controlCenter) {
			return;
		}
		const trimmed = nextName.trim();
		if (!trimmed) {
			return;
		}
		try {
			const wb = snap.whiteboards.find(w => w.board_id === nodeId);
			if (wb) {
				await this.controlCenter.uiConfigureWhiteboard({
					projectId,
					boardId: wb.board_id,
					name: trimmed,
				});
			} else {
				await this.controlCenter.uiEditAgent({
					projectId,
					agentId: nodeId,
					name: trimmed,
				});
			}
			await this.host.onRefreshSnapshot(true);
		} catch (err) {
			this.host.onFeedback(err instanceof Error ? err.message : String(err), 'error');
		}
	}

	async setNodeColor(nodeId: string, colorToken: string | undefined): Promise<void> {
		const projectId = this.host.getProjectId();
		const snap = this.host.getProjectSnapshot();
		if (!projectId || !snap) {
			return;
		}
		const wb = snap.whiteboards.find(w => w.board_id === nodeId);
		if (wb) {
			this.missionService?.setWhiteboardAccentColor(projectId, wb.board_id, colorToken);
			return;
		}
		if (!this.controlCenter) {
			return;
		}
		try {
			await this.controlCenter.uiEditAgent({
				projectId,
				agentId: nodeId,
				colorToken: colorToken ?? '',
			});
			await this.host.onRefreshSnapshot(true);
		} catch (err) {
			this.host.onFeedback(err instanceof Error ? err.message : String(err), 'error');
		}
	}

	async reparentAgent(agentId: string, newParentId: string): Promise<void> {
		const projectId = this.host.getProjectId();
		if (!projectId || !this.controlCenter) {
			return;
		}
		try {
			await this.controlCenter.uiMoveAgent(projectId, agentId, newParentId);
			await this.host.onRefreshSnapshot(true);
			this.host.onFeedback(
				adeBi(localize('adeMovedAgentOk', "Updated reporting line."), '已更新上下级汇报关系。'),
				'ok',
			);
		} catch (err) {
			this.host.onFeedback(err instanceof Error ? err.message : String(err), 'error');
		}
	}

	async deleteAgentWithConfirm(agentId: string, skipConfirm = false): Promise<void> {
		const projectId = this.host.getProjectId();
		const snap = this.host.getProjectSnapshot();
		if (!projectId || !snap || !this.controlCenter) {
			return;
		}
		const agent = snap.agents.find(a => a.agent_id === agentId);
		if (!agent) {
			return;
		}
		if (!skipConfirm && this.dialogService) {
			const res = await this.dialogService.confirm({
				type: 'warning',
				message: adeBi(
					localize('adeConfirmDeleteAgentTitle', "Delete employee '{0}'?", agent.name),
					`确认删除员工节点「${agent.name}」？`,
				),
				detail: adeBi(
					localize('adeConfirmDeleteAgentDetail', "Owned whiteboards will be transferred upward without data loss, and active tickets involving this employee will move to frozen_orphan."),
					'该员工持有的白板将无损向上级过户，关联的在途活跃 Ticket 将转为冻结孤儿单保留历史查阅。',
				),
				primaryButton: adeBi(localize('adeConfirmDeletePrimary', "&&Delete"), '删除(&&D)'),
			});
			if (!res.confirmed) {
				return;
			}
		}
		try {
			await this.controlCenter.uiDeleteAgent(projectId, agentId);
			await this.host.onRefreshSnapshot(true);
		} catch (err) {
			this.host.onFeedback(err instanceof Error ? err.message : String(err), 'error');
			throw err;
		}
	}

	async createDepartment(rootAgentId: string, name: string, colorToken?: string): Promise<IAdeDepartment> {
		const projectId = this.host.getProjectId();
		const cc = this.requireControlCenter();
		if (!projectId) {
			throw new Error('No active Project.');
		}
		const created = await cc.uiCreateDepartment(projectId, rootAgentId, name);
		if (colorToken) {
			this.missionService?.setDepartmentAccentColor(projectId, created.dept_id, colorToken);
		}
		await this.host.onRefreshSnapshot(true);
		return created;
	}

	async editDepartment(deptId: string, patch: {
		readonly name?: string;
		readonly boardId?: string;
		readonly perm?: AdeBoardPermission;
		readonly colorToken?: string;
	}): Promise<void> {
		const projectId = this.host.getProjectId();
		const cc = this.requireControlCenter();
		if (!projectId) {
			return;
		}
		this.missionService?.setDepartmentAccentColor(projectId, deptId, patch.colorToken);
		if (patch.name !== undefined || (patch.boardId && patch.perm)) {
			await cc.uiEditDepartment(projectId, deptId, {
				name: patch.name,
				boardId: patch.boardId,
				perm: patch.perm,
			});
		}
		await this.host.onRefreshSnapshot(true);
	}

	async toggleDepartmentMember(deptId: string, agentId: string, action: 'in' | 'out'): Promise<void> {
		const projectId = this.host.getProjectId();
		const cc = this.requireControlCenter();
		if (!projectId) {
			return;
		}
		await cc.uiSetDepartmentMember(projectId, deptId, agentId, action);
		await this.host.onRefreshSnapshot(true);
	}

	async deleteDepartment(deptId: string): Promise<void> {
		const projectId = this.host.getProjectId();
		const cc = this.requireControlCenter();
		if (!projectId) {
			return;
		}
		await cc.uiDeleteDepartment(projectId, deptId);
		this.missionService?.setDepartmentAccentColor(projectId, deptId, undefined);
		await this.host.onRefreshSnapshot(true);
	}

	async createWhiteboard(input: {
		readonly name: string;
		readonly ownerId?: string | null;
		readonly deptId?: string | null;
		readonly storageHost?: string;
		readonly tags?: readonly string[];
		readonly canvasX?: number;
		readonly canvasY?: number;
		readonly colorToken?: string;
	}): Promise<IAdeWhiteboard> {
		const projectId = this.host.getProjectId();
		const cc = this.requireControlCenter();
		if (!projectId) {
			throw new Error('No active Project.');
		}
		const wb = await cc.uiCreateWhiteboard({
			projectId,
			name: input.name,
			ownerId: input.ownerId,
			deptId: input.deptId,
			storageHost: input.storageHost,
			tags: input.tags,
			canvasX: input.canvasX,
			canvasY: input.canvasY,
		});
		if (input.colorToken) {
			this.missionService?.setWhiteboardAccentColor(projectId, wb.board_id, input.colorToken);
		}
		await this.host.onRefreshSnapshot(true);
		return wb;
	}

	async deleteWhiteboardWithConfirm(boardId: string, skipConfirm = false): Promise<void> {
		const projectId = this.host.getProjectId();
		const snap = this.host.getProjectSnapshot();
		if (!projectId || !snap || !this.controlCenter) {
			return;
		}
		const wb = snap.whiteboards.find(w => w.board_id === boardId);
		if (!wb) {
			return;
		}
		if (!skipConfirm && this.dialogService) {
			const res = await this.dialogService.confirm({
				type: 'warning',
				message: adeBi(
					localize('adeConfirmDeleteWbTitle', "Delete whiteboard '{0}'?", wb.name),
					`确认删除共享白板「${wb.name}」？`,
				),
				detail: adeBi(
					localize('adeConfirmDeleteWbDetail', "All backed-up files and role notes stored on this whiteboard will be scheduled for garbage collection."),
					'该白板下的全部共享条目、备份文件与角色留言将被物理回收清理。',
				),
				primaryButton: adeBi(localize('adeConfirmDeleteWbBtn', "&&Delete Whiteboard"), '删除白板(&&D)'),
			});
			if (!res.confirmed) {
				return;
			}
		}
		try {
			await this.controlCenter.uiDeleteWhiteboard(projectId, boardId);
			this.missionService?.setWhiteboardAccentColor(projectId, boardId, undefined);
			await this.host.onRefreshSnapshot(true);
		} catch (err) {
			this.host.onFeedback(err instanceof Error ? err.message : String(err), 'error');
		}
	}
}
