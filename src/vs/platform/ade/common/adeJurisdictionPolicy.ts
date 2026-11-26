/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AdeBoardPermission,
	AdeEffectiveBoardPermission,
	AdeError,
	AdeTicketLifecycleStatus,
	canonicalEdgePairKey,
	IAdeTicketTransferHop,
} from './adeModels.js';

/**
 * Pure, zero-side-effect formal policy engine for ADE Orchestration, Departments,
 * Two-Tier Whiteboard Authorization, Lossless Ownership Transfer, and Four-Step Ticket Auth.
 */

export interface IAdePolicyAgent {
	readonly agent_id: string;
	readonly project_id: string;
	readonly level: number;
	readonly is_top_role: boolean;
	parent_id: string | null;
	excluded_dept_ids: string[];
}

export interface IAdePolicyDepartment {
	readonly dept_id: string;
	readonly project_id: string;
	name: string;
	readonly root_agent_id: string;
	parent_dept_id: string | null;
	board_permissions: Record<string, AdeBoardPermission>;
	readonly created_by: string;
}

export interface IAdePolicyWhiteboard {
	readonly board_id: string;
	readonly project_id: string;
	owner_id: string | null;
	dept_id: string | null;
}

export interface IAdePolicyBoardGrant {
	readonly board_id: string;
	readonly agent_id: string;
	permission: AdeBoardPermission;
	readonly granted_by: string;
}

export interface IAdePolicyTicket {
	readonly ticket_id: string;
	readonly project_id: string;
	readonly creator_id: string;
	readonly peer_id: string;
	readonly ticket_level: number;
	from_id: string;
	to_id: string;
	holder_id: string | null;
	need_return: boolean;
	status: AdeTicketLifecycleStatus;
}

export interface IAdePolicyProjectState {
	readonly project_id: string;
	readonly agents: Record<string, IAdePolicyAgent>;
	readonly departments: Record<string, IAdePolicyDepartment>;
	readonly whiteboards: Record<string, IAdePolicyWhiteboard>;
	readonly board_grants: IAdePolicyBoardGrant[];
	readonly tickets: Record<string, IAdePolicyTicket>;
}

/**
 * Returns the ordered ancestor chain from root (`u_0`) down to `agentId` (`u_m = agentId`).
 */
export function getRootToSelfPath(
	project: Pick<IAdePolicyProjectState, 'agents'>,
	agentId: string,
): string[] {
	const chain: string[] = [];
	const visited = new Set<string>();
	let cur: string | null = agentId;
	while (cur) {
		if (visited.has(cur)) {
			break;
		}
		visited.add(cur);
		const node: IAdePolicyAgent | undefined = project.agents[cur];
		if (!node) {
			break;
		}
		chain.push(cur);
		cur = node.parent_id;
	}
	chain.reverse();
	return chain;
}

export function isInStrictSubtree(
	project: Pick<IAdePolicyProjectState, 'agents'>,
	ancestorId: string,
	descendantId: string,
): boolean {
	if (ancestorId === descendantId) {
		return false;
	}
	const path = getRootToSelfPath(project, descendantId);
	return path.includes(ancestorId);
}

export function getSubtreeAgentIds(
	project: Pick<IAdePolicyProjectState, 'agents'>,
	rootId: string,
): string[] {
	const childrenMap = new Map<string, string[]>();
	for (const a of Object.values(project.agents)) {
		if (a.parent_id) {
			let list = childrenMap.get(a.parent_id);
			if (!list) {
				list = [];
				childrenMap.set(a.parent_id, list);
			}
			list.push(a.agent_id);
		}
	}
	const out: string[] = [];
	const queue: string[] = [rootId];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (seen.has(id) || !project.agents[id]) {
			continue;
		}
		seen.add(id);
		out.push(id);
		const kids = childrenMap.get(id);
		if (kids) {
			kids.sort();
			queue.push(...kids);
		}
	}
	return out;
}

/**
 * Computes the unique simple path along the single-parent reporting tree between `fromId` and `toId`,
 * returning ordered hops for the 3000ms arc-length proportional Ticket animation and `edge_ticket_transfers`.
 */
export function computeTreeTransferHops(
	project: Pick<IAdePolicyProjectState, 'agents'>,
	fromId: string,
	toId: string,
): IAdeTicketTransferHop[] {
	if (fromId === toId) {
		return [];
	}
	const pathA = getRootToSelfPath(project, fromId);
	const pathB = getRootToSelfPath(project, toId);
	if (pathA.length === 0 || pathB.length === 0 || pathA[0] !== pathB[0]) {
		return [{
			edge_pair_key: canonicalEdgePairKey(fromId, toId),
			hop_from_id: fromId,
			hop_to_id: toId,
			hop_seq: 1,
			total_hops: 1,
		}];
	}
	let lcaIdx = 0;
	while (lcaIdx + 1 < pathA.length && lcaIdx + 1 < pathB.length && pathA[lcaIdx + 1] === pathB[lcaIdx + 1]) {
		lcaIdx++;
	}
	const nodeSeq: string[] = [];
	for (let i = pathA.length - 1; i >= lcaIdx; i--) {
		nodeSeq.push(pathA[i]);
	}
	for (let j = lcaIdx + 1; j < pathB.length; j++) {
		nodeSeq.push(pathB[j]);
	}
	const totalHops = Math.max(1, nodeSeq.length - 1);
	const hops: IAdeTicketTransferHop[] = [];
	for (let k = 0; k < nodeSeq.length - 1; k++) {
		const u = nodeSeq[k];
		const v = nodeSeq[k + 1];
		hops.push({
			edge_pair_key: canonicalEdgePairKey(u, v),
			hop_from_id: u,
			hop_to_id: v,
			hop_seq: k + 1,
			total_hops: totalHops,
		});
	}
	return hops;
}

/**
 * Branch-truncation connected-subtree formula (from outer dept to inner dept):
 * `agentId` is an effective member of `D` iff `D.root_agent_id` appears at index `k` on `rootToSelfPath`,
 * and for every node `u_i` (`k <= i <= m`), `D.dept_id` is NOT in `u_i.excluded_dept_ids`
 * (`u_k === D.root_agent_id` can never be excluded from `D`).
 */
export function getEffectiveDeptIds(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments'>,
	agentId: string,
): string[] {
	const path = getRootToSelfPath(project, agentId);
	if (path.length === 0) {
		return [];
	}
	const deptsByRoot = new Map<string, IAdePolicyDepartment[]>();
	for (const dept of Object.values(project.departments)) {
		let list = deptsByRoot.get(dept.root_agent_id);
		if (!list) {
			list = [];
			deptsByRoot.set(dept.root_agent_id, list);
		}
		list.push(dept);
	}
	const effective: string[] = [];
	for (let k = 0; k < path.length; k++) {
		const candidates = deptsByRoot.get(path[k]);
		if (!candidates) {
			continue;
		}
		candidates.sort((a, b) => a.dept_id.localeCompare(b.dept_id));
		for (const dept of candidates) {
			let excluded = false;
			for (let i = k + 1; i < path.length; i++) {
				const node = project.agents[path[i]];
				if (node && node.excluded_dept_ids.includes(dept.dept_id)) {
					excluded = true;
					break;
				}
			}
			if (!excluded) {
				effective.push(dept.dept_id);
			}
		}
	}
	return effective;
}

/**
 * Recomputes `parent_dept_id` for all departments based strictly on `dept.root_agent_id` itself.
 */
export function recomputeAllParentDeptIds(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments'>,
): void {
	for (const dept of Object.values(project.departments)) {
		const outerCandidates = getEffectiveDeptIds(project, dept.root_agent_id)
			.filter(id => id !== dept.dept_id)
			.map(id => project.departments[id])
			.filter((d): d is IAdePolicyDepartment => Boolean(d && project.agents[d.root_agent_id]));
		outerCandidates.sort((a, b) =>
			project.agents[b.root_agent_id].level - project.agents[a.root_agent_id].level
			|| a.dept_id.localeCompare(b.dept_id),
		);
		dept.parent_dept_id = outerCandidates[0]?.dept_id ?? null;
	}
}

/**
 * Cleans stale department IDs from `excluded_dept_ids` when they are no longer on an agent's ancestor chain
 * or no longer exist.
 */
export function pruneStaleExcludedDeptIds(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments'>,
	agentIds?: readonly string[],
): void {
	const targets = agentIds ?? Object.keys(project.agents);
	for (const id of targets) {
		const node = project.agents[id];
		if (!node || node.excluded_dept_ids.length === 0) {
			continue;
		}
		const pathSet = new Set(getRootToSelfPath(project, id));
		node.excluded_dept_ids = node.excluded_dept_ids.filter(deptId => {
			const dept = project.departments[deptId];
			if (!dept) {
				return false;
			}
			if (dept.root_agent_id === id) {
				return false;
			}
			return pathSet.has(dept.root_agent_id);
		});
	}
}

function doesDeptChainReachOuter(
	departments: Readonly<Record<string, IAdePolicyDepartment>>,
	innerDeptId: string,
	outerDeptId: string,
): boolean {
	const visited = new Set<string>();
	let cur: string | null = innerDeptId;
	while (cur && !visited.has(cur)) {
		if (cur === outerDeptId) {
			return true;
		}
		visited.add(cur);
		cur = departments[cur]?.parent_dept_id ?? null;
	}
	return false;
}

/**
 * Checks if `callerId` is strictly disallowed from managing `targetId` due to cross-department isolation.
 * Assumes `targetId` is already verified to be in `callerId`'s strict subordinate subtree with `caller.level < target.level`.
 */
export function hasCrossDeptViolation(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments'>,
	callerId: string,
	targetId: string,
): boolean {
	const caller = project.agents[callerId];
	const target = project.agents[targetId];
	if (!caller || !target) {
		return true;
	}
	if (caller.is_top_role) {
		return false;
	}
	const targetDepts = getEffectiveDeptIds(project, targetId);
	if (targetDepts.length === 0) {
		return false;
	}
	const callerDeptSet = new Set(getEffectiveDeptIds(project, callerId));
	const callerOwnedDepts = Object.values(project.departments).filter(d => d.root_agent_id === callerId);

	for (const deptId of targetDepts) {
		const dept = project.departments[deptId];
		if (!dept) {
			continue;
		}
		if (dept.root_agent_id === callerId || isInStrictSubtree(project, dept.root_agent_id, callerId)) {
			if (!callerDeptSet.has(deptId)) {
				return true;
			}
		} else if (isInStrictSubtree(project, callerId, dept.root_agent_id)) {
			// Inner sub-department beneath caller: caller MUST personally own an outer wrapping department reaching `dept`
			const wrapped = callerOwnedDepts.some(outer => doesDeptChainReachOuter(project.departments, deptId, outer.dept_id));
			if (!wrapped) {
				return true;
			}
		} else {
			return true;
		}
	}
	return false;
}

export function canCallerManageTarget(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments'>,
	callerId: string,
	targetId: string,
): boolean {
	const caller = project.agents[callerId];
	const target = project.agents[targetId];
	if (!caller || !target || caller.project_id !== target.project_id) {
		return false;
	}
	if (callerId === targetId || caller.level >= target.level) {
		return false;
	}
	if (!isInStrictSubtree(project, callerId, targetId)) {
		return false;
	}
	return !hasCrossDeptViolation(project, callerId, targetId);
}

export function assertCallerManagesTarget(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments'>,
	callerId: string,
	targetId: string,
	options?: { readonly forTicketCreate?: boolean },
): void {
	const caller = project.agents[callerId];
	if (!caller) {
		throw new AdeError('ERR_UNAUTHORIZED', '当前调用者员工会话无效或已被吊销');
	}
	const target = project.agents[targetId];
	if (!target || target.project_id !== caller.project_id) {
		throw new AdeError(
			options?.forTicketCreate ? 'ERR_CROSS_PROJECT' : 'ERR_AGENT_NOT_FOUND',
			options?.forTicketCreate ? '目标接收员工不存在或不属于同一项目' : '指定的目标员工节点不存在',
		);
	}
	if (targetId === callerId) {
		if (options?.forTicketCreate) {
			throw new AdeError('ERR_INVALID_ARGS', '禁止给自己创建双人 Ticket');
		}
		throw new AdeError('ERR_FORBIDDEN_HIERARCHY', '禁止对自身执行下属管理操作');
	}
	if (target.level < caller.level) {
		throw new AdeError(
			options?.forTicketCreate ? 'ERR_LEVEL_EXCEEDED' : 'ERR_FORBIDDEN_HIERARCHY',
			options?.forTicketCreate ? '目标接收员工职级高于 Ticket 等级' : '禁止下级操作上级员工',
		);
	}
	if (target.level === caller.level || !isInStrictSubtree(project, callerId, targetId)) {
		throw new AdeError(
			options?.forTicketCreate ? 'ERR_PEER_TICKET_FORBIDDEN' : 'ERR_FORBIDDEN_HIERARCHY',
			options?.forTicketCreate ? '禁止向同级或非下属子树员工发送 Ticket' : '目标员工不在调用者的下属管辖子树内或职级不满足严格递增',
		);
	}
	if (hasCrossDeptViolation(project, callerId, targetId)) {
		throw new AdeError('ERR_CROSS_DEPT', '禁止跨部门操作其他部门员工或向其派发 Ticket');
	}
}

export function canCallerManageDept(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments'>,
	callerId: string,
	dept: IAdePolicyDepartment,
): boolean {
	if (callerId === dept.root_agent_id) {
		return Boolean(project.agents[callerId]);
	}
	return canCallerManageTarget(project, callerId, dept.root_agent_id);
}

export function assertCallerManagesDept(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments'>,
	callerId: string,
	dept: IAdePolicyDepartment | undefined,
): asserts dept is IAdePolicyDepartment {
	if (!dept) {
		throw new AdeError('ERR_INVALID_ARGS', '指定的部门不存在');
	}
	if (callerId === dept.root_agent_id) {
		if (!project.agents[callerId]) {
			throw new AdeError('ERR_UNAUTHORIZED', '当前调用者无效');
		}
		return;
	}
	assertCallerManagesTarget(project, callerId, dept.root_agent_id);
}

export function assertCanCreateDepartment(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments'>,
	callerId: string,
	rootId: string,
): void {
	const caller = project.agents[callerId];
	if (!caller) {
		throw new AdeError('ERR_UNAUTHORIZED', '当前调用者无效');
	}
	const root = project.agents[rootId];
	if (!root || root.project_id !== caller.project_id) {
		throw new AdeError('ERR_AGENT_NOT_FOUND', '指定的部门根员工节点不存在');
	}
	if (Object.values(project.departments).some(d => d.root_agent_id === rootId)) {
		throw new AdeError('ERR_IS_DEPT_ROOT', '该员工已是另一个活跃部门的根节点');
	}
	if (rootId !== callerId) {
		assertCallerManagesTarget(project, callerId, rootId);
	}
	if (caller.is_top_role) {
		return;
	}
	if (rootId === callerId) {
		const parent = caller.parent_id ? project.agents[caller.parent_id] : undefined;
		const callerEffDepts = new Set(getEffectiveDeptIds(project, callerId));
		const parentWrapsCaller = Boolean(parent && (
			parent.is_top_role ||
			Object.values(project.departments).some(d => d.root_agent_id === parent.agent_id && callerEffDepts.has(d.dept_id))
		));
		if (!parentWrapsCaller) {
			throw new AdeError('ERR_FORBIDDEN_HIERARCHY', '当前直属上级未持有外层包裹部门，禁止自建独立部门脱离直属上级管辖');
		}
	} else {
		const rootEffDepts = new Set(getEffectiveDeptIds(project, rootId));
		const callerWrapsRoot = Object.values(project.departments).some(
			d => d.root_agent_id === callerId && rootEffDepts.has(d.dept_id),
		);
		if (!callerWrapsRoot) {
			throw new AdeError('ERR_FORBIDDEN_HIERARCHY', '调用者须先持有包裹目标下属的外层部门，方可为其划分子部门');
		}
	}
}

export function assertCanDeleteDept(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments'>,
	callerId: string,
	dept: IAdePolicyDepartment | undefined,
): asserts dept is IAdePolicyDepartment {
	if (!dept) {
		throw new AdeError('ERR_INVALID_ARGS', '指定的部门不存在');
	}
	const caller = project.agents[callerId];
	if (!caller) {
		throw new AdeError('ERR_UNAUTHORIZED', '当前调用者无效');
	}
	if (caller.is_top_role) {
		return;
	}
	if (callerId === dept.root_agent_id) {
		if (dept.created_by === callerId) {
			return;
		}
		throw new AdeError('ERR_FORBIDDEN_HIERARCHY', '被上级指派的部门负责人无权单方面解散上级创建的部门');
	}
	assertCallerManagesTarget(project, callerId, dept.root_agent_id);
}

/**
 * Validates and applies `ade_dept_member <dept_id> --agent <targetId> --action <out|in>`
 * including Patch A1 (prevent breaking `D_inner ⊆ D_outer`) and Patch A2 (prevent non-top self-lockout).
 */
export function applyDeptMemberAction(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments'>,
	callerId: string,
	deptId: string,
	targetId: string,
	action: 'out' | 'in',
): void {
	const dept = project.departments[deptId];
	assertCallerManagesDept(project, callerId, dept);
	if (!project.agents[targetId]) {
		throw new AdeError('ERR_AGENT_NOT_FOUND', '指定的目标员工不存在');
	}
	if (targetId === dept.root_agent_id) {
		throw new AdeError('ERR_INVALID_ARGS', '不可将部门根节点本人移出或移入自身部门');
	}
	// Current-state management verification (strictly forbids projection bypass on `--action in`)
	assertCallerManagesTarget(project, callerId, targetId);

	if (!isInStrictSubtree(project, dept.root_agent_id, targetId)) {
		throw new AdeError('ERR_NOT_IN_DEPT_TREE', '目标员工不位于该部门根节点的子树下');
	}

	const target = project.agents[targetId];
	const caller = project.agents[callerId];

	if (action === 'in') {
		const parentId = target.parent_id;
		if (!parentId || !getEffectiveDeptIds(project, parentId).includes(deptId)) {
			throw new AdeError('ERR_NOT_IN_DEPT_TREE', '目标员工的直属上级当前不属于该部门有效成员，无法跨越断层移入');
		}
		target.excluded_dept_ids = target.excluded_dept_ids.filter(id => id !== deptId);
		pruneStaleExcludedDeptIds(project, getSubtreeAgentIds(project, targetId));
		recomputeAllParentDeptIds(project);
		return;
	}

	// Patch A1: forbid breaking nested inclusion `D_inner ⊆ D_outer` when `target` is inside `D_inner` (and `target !== D_inner.root_agent_id`)
	const currentEffDepts = getEffectiveDeptIds(project, targetId);
	for (const innerId of currentEffDepts) {
		if (innerId === deptId) {
			continue;
		}
		const innerDept = project.departments[innerId];
		if (!innerDept || innerDept.root_agent_id === targetId) {
			continue;
		}
		if (doesDeptChainReachOuter(project.departments, innerId, deptId)) {
			throw new AdeError('ERR_INVALID_ARGS', `目标员工当前仍属于内层子部门 ${innerId}，请先将其从内层子部门移出`);
		}
	}

	// Simulate `--action out` to check Patch A2 (prevent non-top caller from detaching a child dept out of caller's jurisdiction)
	const prevExcluded = [...target.excluded_dept_ids];
	if (!target.excluded_dept_ids.includes(deptId)) {
		target.excluded_dept_ids.push(deptId);
	}
	recomputeAllParentDeptIds(project);

	if (!caller.is_top_role) {
		const subtreeIds = getSubtreeAgentIds(project, targetId);
		const subDepts = Object.values(project.departments).filter(d => subtreeIds.includes(d.root_agent_id));
		for (const subDept of subDepts) {
			if (!canCallerManageTarget(project, callerId, subDept.root_agent_id)) {
				target.excluded_dept_ids = prevExcluded;
				recomputeAllParentDeptIds(project);
				throw new AdeError('ERR_FORBIDDEN_HIERARCHY', '非顶级负责人禁止将子部门剥离出自身外层部门管辖边界（防止自锁死）');
			}
		}
	}

	pruneStaleExcludedDeptIds(project, getSubtreeAgentIds(project, targetId));
	recomputeAllParentDeptIds(project);
}

/**
 * Validates and applies `ade_agent_move <agentId> --to-parent <newParentId>`.
 */
export function applyAgentMove(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments'>,
	callerId: string,
	agentId: string,
	newParentId: string,
): void {
	const caller = project.agents[callerId];
	if (!caller) {
		throw new AdeError('ERR_UNAUTHORIZED', '当前调用者无效');
	}
	const agent = project.agents[agentId];
	const newParent = project.agents[newParentId];
	if (!agent || !newParent || agent.project_id !== caller.project_id || newParent.project_id !== caller.project_id) {
		throw new AdeError('ERR_AGENT_NOT_FOUND', '目标员工或新上级节点不存在');
	}
	if (agent.is_top_role || agent.parent_id === null) {
		throw new AdeError('ERR_FORBIDDEN_HIERARCHY', '禁止移动项目顶级根节点');
	}
	if (agentId === newParentId || isInStrictSubtree(project, agentId, newParentId)) {
		throw new AdeError('ERR_FORBIDDEN_HIERARCHY', '新上级不能是目标员工自身或其下属子孙节点');
	}
	if (newParent.level >= agent.level) {
		throw new AdeError('ERR_FORBIDDEN_HIERARCHY', '新上级职级必须严格高于被移动员工');
	}

	// Caller must manage `agentId`, AND either `callerId === newParentId` or `caller` strictly outranks & manages `newParentId`
	assertCallerManagesTarget(project, callerId, agentId);
	if (callerId !== newParentId) {
		if (caller.level >= agent.level || caller.level >= newParent.level) {
			throw new AdeError('ERR_FORBIDDEN_HIERARCHY', '调用者职级必须同时严格高于被移动员工与新上级');
		}
		assertCallerManagesTarget(project, callerId, newParentId);
	}

	// Connected-subtree invariant: any external effective department of `subtree(agentId)` (whose root is outside `subtree(agentId)`)
	// MUST include `newParentId` as an effective member (`ERR_NOT_IN_DEPT_TREE`).
	const subtreeIds = getSubtreeAgentIds(project, agentId);
	const subtreeSet = new Set(subtreeIds);
	const newParentEffDepts = new Set(getEffectiveDeptIds(project, newParentId));
	for (const subNodeId of subtreeIds) {
		for (const effDeptId of getEffectiveDeptIds(project, subNodeId)) {
			const d = project.departments[effDeptId];
			if (d && !subtreeSet.has(d.root_agent_id) && !newParentEffDepts.has(effDeptId)) {
				throw new AdeError('ERR_NOT_IN_DEPT_TREE', `改挂上级会破坏部门 ${effDeptId} 的连通子树约束，请先将员工移出该部门`);
			}
		}
	}

	agent.parent_id = newParentId;
	pruneStaleExcludedDeptIds(project, subtreeIds);
	recomputeAllParentDeptIds(project);
}

// ============================================================================
// Two-Tier Whiteboard Authorization & Lossless Ownership Reconciliation
// ============================================================================

function mergeBoardPerms(
	a: AdeBoardPermission | undefined,
	b: AdeBoardPermission | undefined,
): AdeBoardPermission | 'none' {
	if (!a && !b) {
		return 'none';
	}
	if (!a) {
		return b!;
	}
	if (!b || a === b) {
		return a;
	}
	return 'read_write';
}

export function canReadBoardPerm(perm: AdeEffectiveBoardPermission): boolean {
	return perm === 'owner' || perm === 'read_write' || perm === 'write' || perm === 'read';
}

export function canWriteBoardPerm(perm: AdeEffectiveBoardPermission): boolean {
	return perm === 'owner' || perm === 'read_write' || perm === 'write';
}

export function resolveWhiteboardPermission(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments' | 'whiteboards' | 'board_grants'>,
	boardId: string,
	agentId: string,
): AdeEffectiveBoardPermission {
	const board = project.whiteboards[boardId];
	if (!board || !project.agents[agentId]) {
		return 'none';
	}
	if (board.owner_id === agentId) {
		return 'owner';
	}
	let deptPerm: AdeBoardPermission | undefined;
	if (board.dept_id) {
		const dept = project.departments[board.dept_id];
		if (dept && getEffectiveDeptIds(project, agentId).includes(board.dept_id)) {
			deptPerm = dept.board_permissions[boardId] ?? 'read_write';
		}
	}
	const grant = project.board_grants.find(g => g.board_id === boardId && g.agent_id === agentId);
	return mergeBoardPerms(deptPerm, grant?.permission);
}

export function assertWhiteboardAccess(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments' | 'whiteboards' | 'board_grants'>,
	boardId: string,
	callerId: string,
	required: 'read' | 'write' | 'owner_wb' | 'owner_grant',
): { readonly board: IAdePolicyWhiteboard; readonly perm: AdeEffectiveBoardPermission } {
	const board = project.whiteboards[boardId];
	if (!board) {
		throw new AdeError('ERR_BOARD_NOT_FOUND', '指定的 board_id 不存在或已被删除');
	}
	if (required === 'owner_grant') {
		if (board.owner_id !== callerId) {
			throw new AdeError('ERR_BOARD_NOT_OWNER', '目标白板并非调用者本人持有');
		}
		return { board, perm: 'owner' };
	}
	if (required === 'owner_wb') {
		if (board.owner_id !== callerId) {
			throw new AdeError('ERR_WB_NOT_OWNER', '仅白板所有者有权执行此管理操作');
		}
		return { board, perm: 'owner' };
	}
	const perm = resolveWhiteboardPermission(project, boardId, callerId);
	if (required === 'read' && !canReadBoardPerm(perm)) {
		throw new AdeError('ERR_WB_FORBIDDEN', '调用者无权读取该白板');
	}
	if (required === 'write' && !canWriteBoardPerm(perm)) {
		throw new AdeError('ERR_WB_FORBIDDEN', '调用者无权写入该白板');
	}
	return { board, perm };
}

/**
 * Reconciles department whiteboard ownership and personal grants after topology/department mutations.
 */
export function reconcileTopologySideEffects(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments' | 'whiteboards' | 'board_grants'>,
): void {
	// 1. Transfer department whiteboard ownership to `dept.root_agent_id` if previous owner lost jurisdiction over `dept.root_agent_id`
	for (const board of Object.values(project.whiteboards)) {
		if (!board.dept_id) {
			continue;
		}
		const dept = project.departments[board.dept_id];
		if (!dept) {
			board.dept_id = null;
			continue;
		}
		const ownerValid = Boolean(
			board.owner_id && project.agents[board.owner_id] && (
				board.owner_id === dept.root_agent_id ||
				canCallerManageTarget(project, board.owner_id, dept.root_agent_id)
			),
		);
		if (!ownerValid) {
			board.owner_id = dept.root_agent_id;
		}
	}

	// 2. Clean redundant grants for owners and grants where `owner` no longer manages `grant.agent_id`
	for (let i = project.board_grants.length - 1; i >= 0; i--) {
		const g = project.board_grants[i];
		const board = project.whiteboards[g.board_id];
		if (!board || !project.agents[g.agent_id]) {
			project.board_grants.splice(i, 1);
			continue;
		}
		if (board.owner_id === g.agent_id) {
			project.board_grants.splice(i, 1);
			continue;
		}
		if (board.owner_id && !canCallerManageTarget(project, board.owner_id, g.agent_id)) {
			project.board_grants.splice(i, 1);
		}
	}
}

/**
 * Losslessly transfers whiteboards owned by `deletedAgent` upward before removing `deletedAgent`
 * (NEVER destroys personal/former-dept whiteboards; sets `owner_id = null` escrow ONLY if sole L1 is deleted via UI).
 */
export function transferAgentWhiteboardsOnDelete(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments' | 'whiteboards' | 'board_grants'>,
	deletedAgentId: string,
): void {
	const target = project.agents[deletedAgentId];
	if (!target) {
		return;
	}
	for (const board of Object.values(project.whiteboards)) {
		if (board.owner_id !== deletedAgentId) {
			continue;
		}
		if (board.dept_id) {
			const dept = project.departments[board.dept_id];
			if (dept && dept.root_agent_id !== deletedAgentId) {
				if (target.parent_id && canCallerManageTarget(project, target.parent_id, dept.root_agent_id)) {
					board.owner_id = target.parent_id;
				} else {
					board.owner_id = dept.root_agent_id;
				}
				continue;
			}
		}
		// Lossless upward transfer to `parent_id` (or `null` escrow when UI deletes the sole L1 root)
		board.owner_id = target.parent_id ?? null;
	}
}

// ============================================================================
// Four-Step Ticket Access Verification & Active Ticket Invalidation
// ============================================================================

export function assertTicketAccess(
	ticket: IAdePolicyTicket | undefined,
	callerId: string,
	mode: 'read' | 'edit' | 'destroy',
): asserts ticket is IAdePolicyTicket {
	// Step 1: Non-existent or destroyed tickets ALWAYS return ERR_TICKET_NOT_FOUND to Agent CLIs
	if (!ticket || ticket.status === 'destroyed') {
		throw new AdeError('ERR_TICKET_NOT_FOUND', '指定的 ticket_id 不存在或已被销毁');
	}
	// Step 2: Unrelated third parties blocked BEFORE checking frozen status (prevents probing ERR_TICKET_FROZEN)
	const isBoundParty = callerId === ticket.creator_id || callerId === ticket.peer_id;
	if (!isBoundParty) {
		throw new AdeError(mode === 'read' ? 'ERR_FORBIDDEN' : 'ERR_NOT_HOLDER', '调用者无权访问或操作该 Ticket');
	}
	if (mode === 'read') {
		return;
	}
	// Step 3: Bound parties attempting `ade_edit` or `ade_destroy` on a frozen orphan ticket get ERR_TICKET_FROZEN
	if (ticket.status === 'frozen_orphan') {
		throw new AdeError('ERR_TICKET_FROZEN', '该 Ticket 已移入项目无名孤儿列表冻结，禁止再传递、修改或销毁');
	}
	// Step 4: Active write operations require `holder_id === callerId`
	if (ticket.holder_id !== callerId) {
		throw new AdeError('ERR_NOT_HOLDER', '该 Ticket 当前未挂存在调用者名下');
	}
	if (mode === 'destroy' && ticket.need_return) {
		throw new AdeError('ERR_RETURN_REQUIRED', '该 Ticket 的 need_return 为 true，禁止销毁');
	}
}

/**
 * Finds all currently `active` tickets whose bound pair `{creator_id, peer_id}` is no longer both alive
 * or no longer satisfies `canCallerManageTarget(project, creator_id, peer_id)`, freezes them to `frozen_orphan`,
 * and returns the newly frozen ticket IDs so pending outbox entries can be cancelled atomically.
 */
export function freezeInvalidatedActiveTickets(
	project: Pick<IAdePolicyProjectState, 'agents' | 'departments' | 'tickets'>,
): string[] {
	const newlyFrozen: string[] = [];
	for (const tk of Object.values(project.tickets)) {
		if (tk.status !== 'active') {
			continue;
		}
		const creator = project.agents[tk.creator_id];
		const peer = project.agents[tk.peer_id];
		if (!creator || !peer) {
			tk.status = 'frozen_orphan';
			tk.holder_id = null;
			newlyFrozen.push(tk.ticket_id);
			continue;
		}
		const validPair = (creator.level < peer.level && canCallerManageTarget(project, tk.creator_id, tk.peer_id))
			|| (peer.level < creator.level && canCallerManageTarget(project, tk.peer_id, tk.creator_id));
		if (!validPair) {
			tk.status = 'frozen_orphan';
			tk.holder_id = null;
			newlyFrozen.push(tk.ticket_id);
		}
	}
	newlyFrozen.sort();
	return newlyFrozen;
}
