/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IMissionDagParseResult } from './adeMissionDag.js';
import { ADE_SECRETARY_TIER, ADE_USER_TIER, formatTierTag } from './adeRankResize.js';
import type { IAdeOrganizationConfig } from './adeRoleSchema.js';

export type MissionFactorySide = 'off_graph' | 'in_graph';
export type MissionNodeRoleKind = 'worker' | 'reviewer';

/**
 * Binding for an off-graph supervisor (`L0` or `L1..Lk`) managing a freely chosen
 * (possibly non-contiguous / jump-node) subset of DAG nodes and/or subordinate supervisors.
 */
export interface IMissionSupervisorBinding {
	/** Unique supervisor session / agent ID (never occupies a DAG task node). */
	readonly id: string;
	/** Numeric tier (`0` for L0 Secretary, `1..k` for off-graph ranks). */
	readonly tier: number;
	/** Free jump-node jurisdiction list: any subset of DAG node IDs across branches. */
	readonly managedNodeIds: readonly string[];
	/** Optional subordinate off-graph supervisor IDs (their managed nodes roll up into jurisdiction). */
	readonly managedSupervisorIds?: readonly string[];
	/** Optional immediate upper off-graph supervisor ID for escalation (undefined on top-most L1 -> escalates to Human Inbox). */
	readonly parentSupervisorId?: string;
	/** Optional mission-specific supervisor charter / escalation decision instructions. */
	readonly prompt?: string;
	/** Execution host binding: `'local'` or an SSH Cloud Host alias. */
	readonly hostAlias?: string;
}

/**
 * Per-node execution assignment inside the factory floor (`L(k+1)..LN`).
 */
export interface IMissionNodeAssignment {
	/** Numeric tier of the employee assigned to this DAG node (must satisfy `tier > offGraphMaxTier`). */
	readonly tier?: number;
	/** Whether this in-graph employee executes tasks or performs in-graph review/rejection. */
	readonly roleKind?: MissionNodeRoleKind;
	/** Bound ADE agent/session ID (optional; synced with locked sidebar employee). */
	readonly agentId?: string;
	/** Bound host (`'local'` or SSH Cloud Host alias) where this native agent runs. */
	readonly hostAlias?: string;
	/** Optional remote project directory path on `hostAlias` (for cross-host relay). */
	readonly remoteProjectPath?: string;
	/** Optional normalized LLM API provider key (e.g. `'anthropic'`, `'openai'`, `'google'`, `'deepseek'`) for per-provider concurrency limiting. */
	readonly provider?: string;
}

/**
 * Hard factory boundary configuration separating off-graph supervisors (`<= offGraphMaxTier`)
 * from in-graph execution/review employees (`> offGraphMaxTier`).
 */
export interface IMissionBoundaryConfig {
	/**
	 * Cutoff tier `k`:
	 * - Tiers `<= k` (`L-1`, `L0`, `L1..Lk`) are strictly **off-graph supervisors** (never in DAG nodes).
	 * - Tiers `> k` (`L(k+1)..LN`) are strictly **in-graph employees** (execute/review DAG nodes).
	 * When `k === 0`, only `L0` Secretary / `L-1` User supervise off-graph and `L1..LN` work inside the DAG.
	 */
	readonly offGraphMaxTier: number;
	/** Free jump-node off-graph supervisor bindings. */
	readonly supervisors: readonly IMissionSupervisorBinding[];
	/** Optional per-node employee tier, role kind, and host assignments. */
	readonly nodeAssignments: Readonly<Record<string, IMissionNodeAssignment>>;
}

export interface IMissionBoundaryValidationResult {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly offGraphTiers: readonly number[];
	readonly inGraphTiers: readonly number[];
}

export function createDefaultMissionBoundary(
	orgConfig: IAdeOrganizationConfig,
	owner?: { readonly ownerSessionId?: string; readonly ownerTier?: number },
	nodeIds: readonly string[] = [],
): IMissionBoundaryConfig {
	const rankCount = Math.max(1, orgConfig.ranks.length);
	const ownerTier = owner?.ownerTier ?? ADE_USER_TIER;
	let offGraphMaxTier: number;
	if (ownerTier >= 1 && ownerTier < rankCount) {
		offGraphMaxTier = ownerTier;
	} else if (rankCount >= 2) {
		// Default: L1 (and L0) supervise off-graph; L2..LN work inside the DAG.
		offGraphMaxTier = 1;
	} else {
		// Single business rank (L1 only): L0/L-1 supervise off-graph; L1 works inside the DAG.
		offGraphMaxTier = 0;
	}

	const supervisors: IMissionSupervisorBinding[] = [];
	if (owner?.ownerSessionId && ownerTier >= ADE_SECRETARY_TIER && ownerTier <= offGraphMaxTier) {
		supervisors.push({
			id: owner.ownerSessionId,
			tier: ownerTier,
			managedNodeIds: [...nodeIds],
		});
	}

	return {
		offGraphMaxTier,
		supervisors,
		nodeAssignments: {},
	};
}

/**
 * Classifies a numeric tier as off-graph (`<= offGraphMaxTier`) or in-graph (`> offGraphMaxTier`).
 */
export function classifyTierFactorySide(tier: number, offGraphMaxTier: number): MissionFactorySide {
	return tier <= offGraphMaxTier ? 'off_graph' : 'in_graph';
}

/**
 * Enforces all hard factory-wall constraints from `mission_plan.md` Section 3:
 * 1. `offGraphMaxTier` must be within `[0, N - 1]` so at least one tier (`L(k+1)..LN`) exists inside the factory.
 * 2. Every off-graph supervisor tier must satisfy `0 <= tier <= offGraphMaxTier`.
 * 3. Every in-graph node employee tier must satisfy `offGraphMaxTier < tier <= N`.
 * 4. No tier `Lk` may appear on both sides of the factory wall.
 * 5. All off-graph tiers must be strictly higher authority (smaller tier number) than all in-graph tiers.
 * 6. No off-graph supervisor session may occupy a DAG task node.
 * 7. Escalation links (`parentSupervisorId`) must point to strictly higher-tier supervisors with no cycles.
 */
export function validateMissionFactoryBoundary(
	orgConfig: IAdeOrganizationConfig,
	boundary: IMissionBoundaryConfig,
	graph?: Pick<IMissionDagParseResult, 'nodes'>,
): IMissionBoundaryValidationResult {
	const errors: string[] = [];
	const rankCount = Math.max(1, orgConfig.ranks.length);
	const cutoff = Math.floor(boundary.offGraphMaxTier);

	if (!Number.isInteger(cutoff) || cutoff < 0 || cutoff >= rankCount) {
		errors.push(
			`Invalid off-graph tier cutoff "${boundary.offGraphMaxTier}". With ${rankCount} rank tier(s) (L1..L${rankCount}), offGraphMaxTier must be an integer in [0, ${rankCount - 1}] so at least one tier remains in-graph.`,
		);
	}

	const offGraphTierSet = new Set<number>();
	const inGraphTierSet = new Set<number>();
	const supervisorById = new Map<string, IMissionSupervisorBinding>();
	const graphNodeIds = graph ? new Set(graph.nodes.map(n => n.id)) : undefined;

	for (const sup of boundary.supervisors) {
		const id = sup.id?.trim();
		if (!id) {
			errors.push('Off-graph supervisor entry is missing a unique session ID.');
			continue;
		}
		if (supervisorById.has(id)) {
			errors.push(`Duplicate off-graph supervisor ID "${id}".`);
			continue;
		}
		supervisorById.set(id, sup);
		if (!Number.isInteger(sup.tier) || sup.tier < ADE_SECRETARY_TIER || sup.tier > rankCount) {
			errors.push(`Supervisor "${id}" has invalid tier "${sup.tier}" (expected L0..L${rankCount}).`);
		} else {
			offGraphTierSet.add(sup.tier);
			if (sup.tier > cutoff) {
				errors.push(
					`Factory boundary violation: supervisor "${id}" is at tier ${formatTierTag(sup.tier)}, which is inside the in-graph execution layer (> ${formatTierTag(cutoff)}).`,
				);
			}
		}
		if (graphNodeIds) {
			for (const nid of sup.managedNodeIds) {
				if (!graphNodeIds.has(nid)) {
					errors.push(`Supervisor "${id}" references unknown DAG node "${nid}".`);
				}
			}
		}
	}

	// Check parentSupervisorId & managedSupervisorIds hierarchy (strictly top-down, known IDs, no cycles)
	const downAdj = new Map<string, Set<string>>();
	const addDownEdge = (parentId: string, childId: string) => {
		let set = downAdj.get(parentId);
		if (!set) {
			set = new Set();
			downAdj.set(parentId, set);
		}
		set.add(childId);
	};

	for (const sup of supervisorById.values()) {
		if (sup.parentSupervisorId) {
			const parent = supervisorById.get(sup.parentSupervisorId);
			if (!parent) {
				errors.push(`Supervisor "${sup.id}" references unknown parentSupervisorId "${sup.parentSupervisorId}".`);
			} else if (parent.id === sup.id) {
				errors.push(`Supervisor "${sup.id}" cannot reference itself as parentSupervisorId.`);
			} else if (parent.tier >= sup.tier) {
				errors.push(
					`Escalation hierarchy violation: parent supervisor "${parent.id}" (${formatTierTag(parent.tier)}) must have strictly higher authority than "${sup.id}" (${formatTierTag(sup.tier)}).`,
				);
			} else {
				addDownEdge(parent.id, sup.id);
			}
		}

		for (const rawSubId of sup.managedSupervisorIds ?? []) {
			const subId = rawSubId?.trim();
			if (!subId) {
				errors.push(`Supervisor "${sup.id}" contains an empty entry in managedSupervisorIds.`);
				continue;
			}
			if (subId === sup.id) {
				errors.push(`Supervisor "${sup.id}" cannot manage itself in managedSupervisorIds.`);
				continue;
			}
			const sub = supervisorById.get(subId);
			if (!sub) {
				errors.push(`Supervisor "${sup.id}" references unknown subordinate supervisor "${subId}" in managedSupervisorIds.`);
			} else if (sup.tier >= sub.tier) {
				errors.push(
					`Supervisor hierarchy violation: "${sup.id}" (${formatTierTag(sup.tier)}) cannot supervise "${sub.id}" (${formatTierTag(sub.tier)}) in managedSupervisorIds — supervision must be strictly top-down.`,
				);
			} else {
				addDownEdge(sup.id, sub.id);
			}
		}

		// Detect escalation cycles along parentSupervisorId
		const visited = new Set<string>([sup.id]);
		let cursor = sup.parentSupervisorId;
		while (cursor) {
			if (visited.has(cursor)) {
				errors.push(`Cycle detected in off-graph supervisor escalation chain involving "${sup.id}".`);
				break;
			}
			visited.add(cursor);
			cursor = supervisorById.get(cursor)?.parentSupervisorId;
		}
	}

	// Detect cycles in the combined top-down supervision graph (managedSupervisorIds + parentSupervisorId)
	const visitColor = new Map<string, 0 | 1 | 2>();
	let cycleReported = false;
	const dfsCycle = (nodeId: string) => {
		if (cycleReported) {
			return;
		}
		visitColor.set(nodeId, 1);
		for (const nextId of downAdj.get(nodeId) ?? []) {
			const color = visitColor.get(nextId) ?? 0;
			if (color === 1) {
				errors.push(`Cycle detected in off-graph supervisor hierarchy involving "${nodeId}" -> "${nextId}".`);
				cycleReported = true;
				return;
			}
			if (color === 0) {
				dfsCycle(nextId);
			}
		}
		visitColor.set(nodeId, 2);
	};
	for (const supId of supervisorById.keys()) {
		if ((visitColor.get(supId) ?? 0) === 0) {
			dfsCycle(supId);
		}
	}

	// Check in-graph node assignments
	for (const [nodeId, assign] of Object.entries(boundary.nodeAssignments ?? {})) {
		if (assign.agentId && supervisorById.has(assign.agentId)) {
			errors.push(
				`Factory boundary violation: off-graph supervisor session "${assign.agentId}" cannot occupy in-graph DAG node "${nodeId}".`,
			);
		}
		if (assign.tier !== undefined) {
			if (!Number.isInteger(assign.tier) || assign.tier < 1 || assign.tier > rankCount) {
				errors.push(`In-graph node "${nodeId}" has invalid tier "${assign.tier}" (expected L1..L${rankCount}).`);
			} else {
				inGraphTierSet.add(assign.tier);
				if (assign.tier <= cutoff) {
					errors.push(
						`Factory boundary violation: in-graph node "${nodeId}" is assigned tier ${formatTierTag(assign.tier)}, which belongs to the off-graph supervisor layer (<= ${formatTierTag(cutoff)}).`,
					);
				}
			}
		}
	}

	// Iron law: zero overlap between off-graph and in-graph tiers, and max(offGraph) < min(inGraph)
	for (const t of offGraphTierSet) {
		if (inGraphTierSet.has(t)) {
			errors.push(
				`Factory boundary violation: tier ${formatTierTag(t)} is used on BOTH off-graph and in-graph sides. A single tier must live exclusively on one side.`,
			);
		}
	}
	if (offGraphTierSet.size > 0 && inGraphTierSet.size > 0) {
		const maxOff = Math.max(...offGraphTierSet);
		const minIn = Math.min(...inGraphTierSet);
		if (maxOff >= minIn) {
			errors.push(
				`Factory boundary violation: lowest off-graph tier (${formatTierTag(maxOff)}) must be strictly higher than highest in-graph tier (${formatTierTag(minIn)}).`,
			);
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		offGraphTiers: [...offGraphTierSet].sort((a, b) => a - b),
		inGraphTiers: [...inGraphTierSet].sort((a, b) => a - b),
	};
}

/**
 * Resolves the complete set of DAG node IDs under a supervisor's jurisdiction,
 * combining its direct free jump-node list (`managedNodeIds`) with all nodes
 * managed transitively by subordinate off-graph supervisors.
 */
export function resolveSupervisorJurisdiction(
	boundary: IMissionBoundaryConfig,
	supervisorId: string,
	allGraphNodeIds: readonly string[],
	callerInfo?: { readonly isHumanUser?: boolean; readonly isSecretary?: boolean; readonly ownerSessionId?: string },
): { readonly hasFullJurisdiction: boolean; readonly nodeIds: ReadonlySet<string>; readonly supervisorIds: ReadonlySet<string> } {
	if (callerInfo?.isHumanUser || callerInfo?.isSecretary) {
		return {
			hasFullJurisdiction: true,
			nodeIds: new Set(allGraphNodeIds),
			supervisorIds: new Set(boundary.supervisors.map(s => s.id)),
		};
	}

	const byId = new Map(boundary.supervisors.map(s => [s.id, s]));
	const self = byId.get(supervisorId);
	if (!self) {
		// Mission owner without explicit supervisor entry defaults to full mission jurisdiction if off-graph
		if (callerInfo?.ownerSessionId && callerInfo.ownerSessionId === supervisorId) {
			return {
				hasFullJurisdiction: true,
				nodeIds: new Set(allGraphNodeIds),
				supervisorIds: new Set(boundary.supervisors.map(s => s.id)),
			};
		}
		return { hasFullJurisdiction: false, nodeIds: new Set(), supervisorIds: new Set() };
	}

	// Build parent -> children adjacency from BOTH explicit managedSupervisorIds AND parentSupervisorId backlinks
	const childSups = new Map<string, Set<string>>();
	for (const sup of boundary.supervisors) {
		if (sup.managedSupervisorIds) {
			let set = childSups.get(sup.id);
			if (!set) {
				set = new Set();
				childSups.set(sup.id, set);
			}
			for (const cid of sup.managedSupervisorIds) {
				set.add(cid);
			}
		}
		if (sup.parentSupervisorId) {
			let set = childSups.get(sup.parentSupervisorId);
			if (!set) {
				set = new Set();
				childSups.set(sup.parentSupervisorId, set);
			}
			set.add(sup.id);
		}
	}

	const visitedSups = new Set<string>();
	const managedNodes = new Set<string>();
	const queue: string[] = [self.id];
	while (queue.length > 0) {
		const curId = queue.shift()!;
		if (visitedSups.has(curId)) {
			continue;
		}
		visitedSups.add(curId);
		const sup = byId.get(curId);
		if (!sup) {
			continue;
		}
		for (const nid of sup.managedNodeIds) {
			managedNodes.add(nid);
		}
		for (const childId of childSups.get(curId) ?? []) {
			if (!visitedSups.has(childId)) {
				queue.push(childId);
			}
		}
	}

	visitedSups.delete(self.id);
	const hasFull = allGraphNodeIds.length > 0 && allGraphNodeIds.every(nid => managedNodes.has(nid));
	return {
		hasFullJurisdiction: hasFull,
		nodeIds: managedNodes,
		supervisorIds: visitedSups,
	};
}

/**
 * Finds the most specific (lowest-tier / largest tier number) off-graph supervisor directly
 * managing `nodeId`. Falls back to the top-most supervisor (or Mission owner) if none is bound.
 */
export function findDirectSupervisorForNode(
	boundary: IMissionBoundaryConfig,
	nodeId: string,
	owner?: { readonly ownerSessionId?: string; readonly ownerTier?: number },
): IMissionSupervisorBinding | undefined {
	const directMatches = boundary.supervisors
		.filter(sup => sup.managedNodeIds.includes(nodeId))
		.sort((a, b) => b.tier - a.tier); // Prefer closest (highest tier number, e.g. L2 over L1)
	if (directMatches.length > 0) {
		return directMatches[0];
	}
	// Fallback: highest-authority (lowest tier number) off-graph supervisor if configured
	const sortedTop = [...boundary.supervisors].sort((a, b) => a.tier - b.tier);
	if (sortedTop.length > 0) {
		return sortedTop[0];
	}
	if (owner?.ownerSessionId && (owner.ownerTier ?? ADE_USER_TIER) >= ADE_SECRETARY_TIER && (owner.ownerTier ?? 99) <= boundary.offGraphMaxTier) {
		return {
			id: owner.ownerSessionId,
			tier: owner.ownerTier ?? 1,
			managedNodeIds: [nodeId],
		};
	}
	return undefined;
}

/**
 * Resolves the immediate parent supervisor for escalation. Returns `undefined` when caller is
 * already at top-most off-graph level (`L1` / root), signaling escalation directly to Human Inbox!
 */
export function findParentSupervisorForEscalation(
	boundary: IMissionBoundaryConfig,
	supervisorId: string,
): IMissionSupervisorBinding | undefined {
	const byId = new Map(boundary.supervisors.map(s => [s.id, s]));
	const current = byId.get(supervisorId);
	if (!current) {
		return undefined;
	}
	if (current.parentSupervisorId) {
		const explicit = byId.get(current.parentSupervisorId);
		if (explicit && explicit.tier < current.tier) {
			return explicit;
		}
	}
	// Check reverse `managedSupervisorIds` links
	const manager = boundary.supervisors
		.filter(s => s.tier < current.tier && s.managedSupervisorIds?.includes(supervisorId))
		.sort((a, b) => b.tier - a.tier)[0];
	if (manager) {
		return manager;
	}
	// If already at L1 (or L0), escalate directly to Human Inbox
	if (current.tier <= 1) {
		return undefined;
	}
	// Fallback: closest higher-tier off-graph supervisor
	return boundary.supervisors
		.filter(s => s.tier < current.tier && s.tier >= 1)
		.sort((a, b) => b.tier - a.tier)[0];
}
