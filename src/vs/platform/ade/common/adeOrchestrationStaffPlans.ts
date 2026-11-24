/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	addStaffNodeToOrchestration,
	connectOrchestrationEdge,
	IOrchestrationGraphNode,
	parseOrchestrationGraph,
	serializeOrchestrationGraph,
} from './adeOrchestrationGraph.js';
import {
	ICreateSubordinatePlan,
	IDynamicSubordinateCreateParams,
	IOrchestrationWhiteboard,
	IRemoveSubordinatePlan,
	isCompanyWideExecutiveDept,
	resolveEffectiveStaffTier,
} from './adeOrchestrationTypes.js';
import { IAdeOrganizationConfig, IAdeRankDefinition } from './adeRoleSchema.js';

/**
 * Pure planner & validator for dynamic runtime subordinate creation on the Orchestration canvas:
 * - Superior (tier T) may create ONLY an immediate next-tier subordinate (no rank-skipping!)
 *   within their own department (no cross-department staffing!), auto-wired via `<-->` by default.
 * - Human User (L-1) and Secretary (L0) may create staff at any configured tier/department.
 * - Enforces strict employee uniqueness on the Orchestration canvas.
 */
export function planDynamicSubordinateCreation(
	rawOrchestrationText: string,
	config: IAdeOrganizationConfig,
	params: IDynamicSubordinateCreateParams,
): ICreateSubordinatePlan {
	const parsed = parseOrchestrationGraph(rawOrchestrationText);
	if (parsed.error && rawOrchestrationText.trim().length > 0) {
		return { ok: false, code: 'INVALID_GRAPH', error: parsed.error };
	}

	const sortedRanks = [...config.ranks].sort((a, b) => a.tier - b.tier);
	if (sortedRanks.length === 0) {
		return { ok: false, code: 'INVALID_RANK', error: 'Organization schema has no configured ranks.' };
	}

	const callerNode = params.callerNodeId ? parsed.nodes.find(n => n.id === params.callerNodeId && n.kind === 'staff') : undefined;
	if (!params.isHumanUser && !params.isSecretary && params.callerNodeId?.trim() && !callerNode) {
		return {
			ok: false,
			code: 'NOT_FOUND',
			error: `Caller staff node "${params.callerNodeId.trim()}" does not exist on the Orchestration canvas.`,
		};
	}
	const effectiveCallerTier = params.isHumanUser ? -1 : params.isSecretary ? 0 : (params.callerTier ?? resolveEffectiveStaffTier(callerNode, config));
	const immediateNextRank = effectiveCallerTier !== undefined
		? sortedRanks.find(r => r.tier > effectiveCallerTier)
		: sortedRanks[0];

	if (!params.isHumanUser && !params.isSecretary) {
		if (effectiveCallerTier === undefined) {
			return { ok: false, code: 'FORBIDDEN', error: 'Unable to determine caller rank tier for subordinate creation.' };
		}
		const callerRankDef = sortedRanks.find(r => r.tier === effectiveCallerTier);
		const lowestTier = sortedRanks[sortedRanks.length - 1].tier;
		if (effectiveCallerTier >= lowestTier || !immediateNextRank || (callerRankDef && !callerRankDef.canHaveSubordinates)) {
			return {
				ok: false,
				code: 'FORBIDDEN',
				error: `Rank L${effectiveCallerTier}${callerRankDef ? ` (${callerRankDef.name})` : ''} cannot dynamically create lower-tier subordinates.`,
			};
		}
	}

	let resolvedRank: IAdeRankDefinition | undefined;
	if (params.targetRankIdOrTier !== undefined && String(params.targetRankIdOrTier).trim() !== '') {
		const raw = String(params.targetRankIdOrTier).trim();
		const tierMatch = /^L?(\d+)$/i.exec(raw);
		if (tierMatch) {
			const t = Number.parseInt(tierMatch[1], 10);
			resolvedRank = sortedRanks.find(r => r.tier === t);
		} else {
			resolvedRank = sortedRanks.find(r => r.id.toLowerCase() === raw.toLowerCase() || r.name.toLowerCase() === raw.toLowerCase());
		}
		if (!resolvedRank) {
			return { ok: false, code: 'INVALID_RANK', error: `Unknown target rank "${raw}".` };
		}
	} else {
		resolvedRank = immediateNextRank ?? sortedRanks[sortedRanks.length - 1];
	}

	if (!params.isHumanUser && !params.isSecretary && effectiveCallerTier !== undefined) {
		if (resolvedRank.tier <= effectiveCallerTier) {
			return {
				ok: false,
				code: 'FORBIDDEN',
				error: `Hierarchy violation: caller (L${effectiveCallerTier}) can only create strictly lower-tier subordinates (requested L${resolvedRank.tier} ${resolvedRank.name}).`,
			};
		}
		if (immediateNextRank && resolvedRank.tier !== immediateNextRank.tier) {
			return {
				ok: false,
				code: 'RANK_SKIP_FORBIDDEN',
				error: `RANK_SKIP_FORBIDDEN: caller (L${effectiveCallerTier}) cannot skip ranks to create L${resolvedRank.tier} (${resolvedRank.name}); immediate subordinate tier is L${immediateNextRank.tier} (${immediateNextRank.name}).`,
			};
		}
	}

	const requestedDept = params.department?.trim();
	const callerDept = callerNode?.department?.trim();
	const isHighestOrgRank = effectiveCallerTier !== undefined && effectiveCallerTier <= sortedRanks[0].tier;
	if (!params.isHumanUser && !params.isSecretary && !isHighestOrgRank && requestedDept) {
		// Non-highest-rank staff without an assigned department cannot create new departments or cross into foreign ones;
		// assigned mid-tier managers may only create subordinates in their own department (unless executive).
		const isForeignCrossDept = callerDept
			? (!isCompanyWideExecutiveDept(callerDept) && requestedDept.toLowerCase() !== callerDept.toLowerCase())
			: true;
		if (isForeignCrossDept) {
			return {
				ok: false,
				code: 'CROSS_DEPARTMENT_FORBIDDEN',
				error: `CROSS_DEPARTMENT_FORBIDDEN: staff "${callerNode?.id ?? 'caller'}" in department "${callerDept || 'Unassigned'}" cannot create subordinates in foreign or new department "${requestedDept}".`,
			};
		}
	}

	const department = requestedDept || callerDept;
	const createdDepartment = Boolean(
		department
		&& !parsed.departments.some(d =>
			d.name.trim().toLowerCase() === department.toLowerCase()
			|| d.id.trim().toLowerCase() === department.toLowerCase(),
		),
	);
	const added = addStaffNodeToOrchestration(rawOrchestrationText, {
		id: params.id,
		name: params.name,
		roleLabel: params.roleLabel?.trim() || resolvedRank.name,
		tier: resolvedRank.tier,
		rankId: resolvedRank.id,
		department,
		engineId: params.engineId,
		model: params.model,
		thinking: params.thinking,
		hostAlias: params.hostAlias,
		rolePrompt: params.rolePrompt,
		allowedPaths: params.allowedPaths,
		checks: params.checks,
		color: params.color,
		direction: parsed.direction,
	});
	if (!added.ok || !added.nodeId || !added.orchestrationText) {
		return {
			ok: false,
			code: added.error?.includes('already exists') ? 'DUPLICATE_EMPLOYEE' : 'INVALID_GRAPH',
			error: added.error ?? 'Failed to add subordinate staff node.',
		};
	}

	let finalText = added.orchestrationText;
	if (callerNode) {
		const wired = connectOrchestrationEdge(finalText, callerNode.id, added.nodeId, {
			bidirectional: params.bidirectional !== false,
			label: params.edgeLabel?.trim() || undefined,
		});
		if (wired.ok && wired.orchestrationText) {
			finalText = wired.orchestrationText;
		}
	}

	const validatedFinal = parseOrchestrationGraph(finalText);
	if (validatedFinal.error) {
		return {
			ok: false,
			code: validatedFinal.error.includes('Duplicate employee') ? 'DUPLICATE_EMPLOYEE' : 'INVALID_GRAPH',
			error: validatedFinal.error,
		};
	}

	return {
		ok: true,
		newNodeId: added.nodeId,
		resolvedRank,
		...(department ? { department } : {}),
		createdDepartment,
		orchestrationText: finalText,
	};
}

/**
 * Pure planner & validator for dynamic runtime subordinate removal on the Orchestration canvas:
 * - Enforces superior-only removal, no self-removal, NO rank-skipping (`target.tier === immediateNextTier`),
 *   NO cross-department removal, direct-subordinate verification, and active-subordinate guard.
 */
export function planDynamicSubordinateRemoval(
	rawOrchestrationText: string,
	config: IAdeOrganizationConfig,
	params: {
		readonly targetNodeId: string;
		readonly callerNodeId?: string;
		readonly callerTier?: number;
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly force?: boolean;
		readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
	},
): IRemoveSubordinatePlan {
	const parsed = parseOrchestrationGraph(rawOrchestrationText);
	if (parsed.error) {
		return { ok: false, code: 'INVALID_GRAPH', error: parsed.error };
	}
	const targetId = params.targetNodeId.trim();
	const staffById = new Map<string, IOrchestrationGraphNode>();
	for (const n of parsed.nodes) {
		if (n.kind === 'staff') {
			staffById.set(n.id, n);
		}
	}
	const targetNode = staffById.get(targetId);
	if (!targetNode) {
		return { ok: false, code: 'NOT_FOUND', error: `Staff node "${targetId}" not found on Orchestration canvas.` };
	}
	if (params.callerNodeId && params.callerNodeId.trim() === targetId && !params.isHumanUser && !params.isSecretary) {
		return { ok: false, code: 'FORBIDDEN', error: `Staff node "${targetId}" cannot remove itself.` };
	}

	const sortedRanks = [...config.ranks].sort((a, b) => a.tier - b.tier);
	const callerNode = params.callerNodeId ? staffById.get(params.callerNodeId) : undefined;
	const effectiveCallerTier = params.isHumanUser ? -1 : params.isSecretary ? 0 : (params.callerTier ?? resolveEffectiveStaffTier(callerNode, config));

	if (!params.isHumanUser && !params.isSecretary) {
		if (effectiveCallerTier === undefined) {
			return { ok: false, code: 'FORBIDDEN', error: 'Unable to determine caller rank tier for subordinate removal.' };
		}
		const callerRankDef = sortedRanks.find(r => r.tier === effectiveCallerTier);
		const immediateNextRank = sortedRanks.find(r => r.tier > effectiveCallerTier);
		if (!immediateNextRank || (callerRankDef && !callerRankDef.canHaveSubordinates)) {
			return {
				ok: false,
				code: 'FORBIDDEN',
				error: `Rank L${effectiveCallerTier}${callerRankDef ? ` (${callerRankDef.name})` : ''} cannot remove subordinates.`,
			};
		}
		const targetTier = resolveEffectiveStaffTier(targetNode, config);
		if (targetTier === undefined) {
			return {
				ok: false,
				code: 'FORBIDDEN',
				error: `FORBIDDEN: cannot verify rank tier of target staff "${targetId}"; only Human User or Secretary may remove untiered staff.`,
			};
		}
		if (targetTier <= effectiveCallerTier) {
			return {
				ok: false,
				code: 'FORBIDDEN',
				error: `Hierarchy violation: caller (L${effectiveCallerTier}) cannot remove equal/higher-rank staff "${targetId}" (L${targetTier}).`,
			};
		}
		if (targetTier !== immediateNextRank.tier) {
			return {
				ok: false,
				code: 'RANK_SKIP_FORBIDDEN',
				error: `RANK_SKIP_FORBIDDEN: caller (L${effectiveCallerTier}) cannot skip ranks to remove "${targetId}" (L${targetTier}); only immediate subordinate tier L${immediateNextRank.tier} (${immediateNextRank.name}) may be removed.`,
			};
		}
		const callerDept = callerNode?.department?.trim();
		const targetDept = targetNode.department?.trim();
		const isHighestOrgRank = effectiveCallerTier !== undefined && sortedRanks.length > 0 && effectiveCallerTier <= sortedRanks[0].tier;
		if (!isHighestOrgRank && !isCompanyWideExecutiveDept(callerDept)) {
			const deptMismatch = callerDept
				? (!targetDept || targetDept.toLowerCase() !== callerDept.toLowerCase())
				: Boolean(targetDept);
			if (deptMismatch) {
				return {
					ok: false,
					code: 'CROSS_DEPARTMENT_FORBIDDEN',
					error: `CROSS_DEPARTMENT_FORBIDDEN: staff "${callerNode?.id ?? 'caller'}" in department "${callerDept || 'Unassigned'}" cannot remove "${targetId}" in department "${targetDept || 'Unassigned'}".`,
				};
			}
		}
		if (callerNode) {
			const hasDirectManagementEdge = parsed.edges.some(e => e.from === callerNode.id && e.to === targetId);
			if (!isHighestOrgRank && !hasDirectManagementEdge) {
				return {
					ok: false,
					code: 'FORBIDDEN',
					error: `Staff "${targetId}" does not report directly to "${callerNode.id}".`,
				};
			}
			const otherSuperiors = parsed.edges.filter(e => {
				if (e.to !== targetId || e.from === callerNode.id) {
					return false;
				}
				const src = staffById.get(e.from);
				const srcTier = resolveEffectiveStaffTier(src, config);
				return Boolean(src && srcTier !== undefined && srcTier < targetTier);
			});
			if (!hasDirectManagementEdge && otherSuperiors.length > 0) {
				return {
					ok: false,
					code: 'FORBIDDEN',
					error: `Staff "${targetId}" does not report directly to "${callerNode.id}".`,
				};
			}
		}
	}

	const targetEffectiveTier = resolveEffectiveStaffTier(targetNode, config);
	const activeSubordinateIds = parsed.edges
		.filter(e => e.from === targetId)
		.map(e => staffById.get(e.to))
		.filter((n): n is IOrchestrationGraphNode => {
			if (!n || n.id === targetId) {
				return false;
			}
			const childTier = resolveEffectiveStaffTier(n, config);
			return targetEffectiveTier === undefined || childTier === undefined || childTier > targetEffectiveTier;
		})
		.map(n => n.id);
	const uniqueSubordinateIds = [...new Set(activeSubordinateIds)];
	if (uniqueSubordinateIds.length > 0 && !(params.force && params.isHumanUser)) {
		return {
			ok: false,
			code: 'HAS_ACTIVE_SUBORDINATES',
			activeSubordinateIds: uniqueSubordinateIds,
			error: `HAS_ACTIVE_SUBORDINATES: cannot remove "${targetId}" while it still manages lower-tier subordinate(s): ${uniqueSubordinateIds.join(', ')}. Remove or reassign subordinates first.`,
		};
	}

	const nextNodes = parsed.nodes.filter(n => n.id !== targetId);
	const nextEdges = parsed.edges.filter(e => e.from !== targetId && e.to !== targetId);
	const nextPositions = parsed.positions
		? Object.fromEntries(Object.entries(parsed.positions).filter(([k]) => k !== targetId))
		: undefined;
	const nextText = serializeOrchestrationGraph({
		direction: parsed.direction,
		layoutMode: parsed.layoutMode,
		nodes: nextNodes,
		edges: nextEdges,
		departments: parsed.departments,
		whiteboards: params.whiteboards,
		positions: nextPositions,
		includeAgentIds: true,
	});

	return {
		ok: true,
		removedNode: targetNode,
		orchestrationText: nextText,
	};
}
