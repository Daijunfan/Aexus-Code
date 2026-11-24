/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	isStrictCompanyWideExecutiveDept,
	parseJoinBarrierOptions,
	parseOrchestrationLimitsRequest,
	parseStrictMinTierParam,
	parseStrictPositiveInt,
	parseUnifiedMissionCheckpointBundle,
} from '../common/adeControlPolicy.js';
import { IAdeHeadlessControlResult } from '../common/adeEngineering.js';
import {
	addEdgeToMermaid,
	addNodeToMermaid,
	IMissionNodeCheckHook,
	parseDualViewBlueprintMarkdown,
	parseMissionMermaidDag,
	removeEdgeFromMermaid,
	removeNodeFromMermaid,
	renameNodeInMermaid,
	upsertTaskMetadataInMermaid,
} from '../common/adeMissionDag.js';
import { parseDurationMs } from '../common/adeMissionEngine.js';
import {
	abortOrchestrationTokens,
	assertOrchestrationTokenHolder,
	blockOrchestrationToken,
	buildOrchestrationDispatchEffect,
	canCallerAccessWhiteboard,
	canCallerCompleteMissionTask,
	completeOrchestrationToken,
	createInitialOrchestrationRuntimeState,
	DEFAULT_ORCHESTRATION_MAX_HOPS,
	dispatchRequirementToOrchestration,
	failOrchestrationToken,
	handoffOrchestrationToken,
	IMissionTaskCheckReceipt,
	IMissionTaskStatusRecord,
	IOrchestrationContextBlobInput,
	IOrchestrationMintBranch,
	IOrchestrationToken,
	IOrchestrationWhiteboard,
	mintOrchestrationTokens,
	MissionTaskStatus,
	mutateDepartmentWhiteboard,
	OrchestrationEngineEffect,
	pauseOrchestration,
	planDynamicWhiteboardCreation,
	pruneRemovedWhiteboardFromState,
	recordMissionTaskCheckReceipt,
	rejectOrchestrationToken,
	resolveEffectiveStaffTier,
	resumeOrchestration,
	retryOrchestrationToken,
	returnOrchestrationToken,
	setOrchestrationGuardrails,
	updateMissionTaskNodeStatus,
	upsertWhiteboardSection,
} from '../common/adeOrchestrationEngine.js';
import {
	applyOrchestrationCheckpointRestore,
} from '../common/adeOrchestrationCheckpoints.js';
import {
	OrchestrationReworkCategory,
	OrchestrationScopeConflictPolicy,
} from '../common/adeOrchestrationTypes.js';
import {
	IOrchestrationGraphParseResult,
	parseOrchestrationGraph,
	removeOrchestrationNode,
	upsertOrchestrationWhiteboardInCode,
} from '../common/adeOrchestrationGraph.js';
import {
	buildHeadlessCheckpointSnapshot,
	IHeadlessMissionScopeContext,
} from './adeHeadlessControlReadActions.js';

function parseStrList(raw: unknown): readonly string[] | undefined {
	if (Array.isArray(raw)) {
		const out = raw.map(v => String(v).trim()).filter(Boolean);
		return out.length > 0 ? out : undefined;
	}
	if (typeof raw === 'string' && raw.trim()) {
		const out = raw.split(/[|,;]/).map(s => s.trim()).filter(Boolean);
		return out.length > 0 ? out : undefined;
	}
	return undefined;
}

function parseCsvList(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw.map(v => String(v).trim()).filter(Boolean);
	}
	if (typeof raw === 'string' && raw.trim()) {
		return raw.split(/[|,;]/).map(s => s.trim()).filter(Boolean);
	}
	return [];
}

function parseBlobList(raw: unknown): readonly IOrchestrationContextBlobInput[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const out: IOrchestrationContextBlobInput[] = [];
	for (const item of raw) {
		if (item && typeof item === 'object' && typeof (item as { content?: unknown }).content === 'string') {
			out.push({
				title: typeof (item as { title?: unknown }).title === 'string' ? (item as { title: string }).title : '',
				content: (item as { content: string }).content,
			});
		}
	}
	return out.length > 0 ? out : undefined;
}

function assertHeadlessDeptWhiteboardAdmin(
	ctx: IHeadlessMissionScopeContext,
	departments: readonly string[],
	verb: 'rename' | 'remove',
): string | undefined {
	const { caller, effectiveOrgConfig, parsedGraph, record } = ctx;
	if (caller.isHumanUser || caller.isSecretary || ctx.canOperateMission(caller)) {
		return undefined;
	}
	const highestTier = effectiveOrgConfig.ranks.length > 0 ? Math.min(...effectiveOrgConfig.ranks.map(r => r.tier)) : 1;
	const ownerSid = typeof record.ownerSessionId === 'string' ? record.ownerSessionId.trim() : '';
	if ((ownerSid && caller.callerSessionId === ownerSid) || (caller.callerTier !== undefined && caller.callerTier <= highestTier)) {
		return undefined;
	}
	const callerNode = caller.callerNodeId ? parsedGraph.nodes.find(n => n.id === caller.callerNodeId && n.kind === 'staff') : undefined;
	const callerDept = callerNode?.department?.trim();
	if (!callerDept) {
		return `FORBIDDEN: caller lacks department authority to ${verb} whiteboard.`;
	}
	if (isStrictCompanyWideExecutiveDept(callerDept)) {
		return undefined;
	}
	const allSameDept = departments.every(d => d.trim().toLowerCase() === callerDept.toLowerCase());
	if (!allSameDept) {
		return `CROSS_DEPARTMENT_FORBIDDEN: caller in department "${callerDept}" cannot ${verb} whiteboard in department "${departments.join(' -> ')}".`;
	}
	return undefined;
}

function assertHeadlessTaskDesignScope(
	ctx: IHeadlessMissionScopeContext,
	verb: string,
	options?: { readonly targetDepartment?: string; readonly targetOwnerNodeId?: string; readonly requestedDepartment?: string },
): string | undefined {
	const { caller, effectiveOrgConfig, parsedGraph, record } = ctx;
	if (caller.isHumanUser || caller.isSecretary || ctx.canOperateMission(caller)) {
		return undefined;
	}
	const highestTier = effectiveOrgConfig.ranks.length > 0 ? Math.min(...effectiveOrgConfig.ranks.map(r => r.tier)) : 1;
	const ownerSid = typeof record.ownerSessionId === 'string' ? record.ownerSessionId.trim() : '';
	if ((ownerSid && caller.callerSessionId === ownerSid) || (caller.callerTier !== undefined && caller.callerTier <= highestTier)) {
		return undefined;
	}
	const callerNode = caller.callerNodeId ? parsedGraph.nodes.find(n => n.id === caller.callerNodeId && n.kind === 'staff') : undefined;
	const callerDept = callerNode?.department?.trim();
	if (isStrictCompanyWideExecutiveDept(callerDept)) {
		return undefined;
	}
	if (options?.targetOwnerNodeId && caller.callerNodeId && options.targetOwnerNodeId === caller.callerNodeId) {
		if (!options.requestedDepartment || (callerDept && options.requestedDepartment.trim().toLowerCase() === callerDept.toLowerCase())) {
			return undefined;
		}
	}
	const checkDept = options?.requestedDepartment ?? options?.targetDepartment;
	if (!callerDept || !checkDept || checkDept.trim().toLowerCase() !== callerDept.toLowerCase()) {
		return `FORBIDDEN: caller lacks authority to ${verb} task outside department "${callerDept || 'Unassigned'}".`;
	}
	return undefined;
}

async function saveAutoCheckpoint(ctx: IHeadlessMissionScopeContext, reason: string, nowTs: number): Promise<string | undefined> {
	const createdBy = ctx.caller.callerNodeId ?? ctx.caller.callerSessionId ?? (ctx.caller.isHumanUser ? 'human' : 'secretary');
	const built = buildHeadlessCheckpointSnapshot(ctx.missionId, ctx.record, {
		label: `auto:${reason}`,
		reason,
		createdBy,
		now: nowTs,
		seq: ctx.host.nextTmpSeq(),
	});
	try {
		await ctx.host.saveMissionCheckpoint(ctx.missionId, built.checkpointId, built.payloadJson, built.meta);
		return built.checkpointId;
	} catch {
		return undefined;
	}
}

/**
 * Handles all mutating mission-scoped headless actions (blueprints, escalations, whiteboards,
 * Mission Task DAG CRUD/status, deterministic checks CRUD, checkpoints, baton tokens, and run control).
 */
export async function executeHeadlessMissionMutationAction(
	ctx: IHeadlessMissionScopeContext,
): Promise<IAdeHeadlessControlResult> {
	const { host, missionId, action, params, effectiveOrgConfig, record, orch, orchestrationText, parsedGraph, caller } = ctx;

	if (action === 'mission.blueprint.apply') {
		if (!ctx.canOperateMission(caller)) {
			return { handled: true, error: `FORBIDDEN: caller is not authorized to apply Mission blueprint for "${missionId}".` };
		}
		const rawText = String(params.text ?? params.mermaid ?? '').trim();
		if (!rawText) {
			return { handled: true, error: 'Blueprint Mermaid/Markdown text (--file or --text) is required for mission.blueprint.apply.' };
		}
		const parsedDual = parseDualViewBlueprintMarkdown(rawText);
		const dag = parseMissionMermaidDag(parsedDual.mermaidText);
		if (dag.error) {
			return { handled: true, error: dag.error };
		}
		const orchParsed = parsedDual.orchestrationText?.trim()
			? parseOrchestrationGraph(parsedDual.orchestrationText)
			: undefined;
		if (orchParsed?.error) {
			return { handled: true, error: orchParsed.error };
		}
		const nowTs = Date.now();
		await saveAutoCheckpoint(ctx, 'pre_blueprint_apply', nowTs);
		record.mermaidText = parsedDual.mermaidText;
		if (Object.keys(parsedDual.nodePrompts).length > 0) {
			record.nodePrompts = {
				...((record.nodePrompts ?? {}) as Readonly<Record<string, string>>),
				...parsedDual.nodePrompts,
			};
		}
		let appliedOrchStaff = 0;
		if (orchParsed && parsedDual.orchestrationText?.trim()) {
			record.orchestrationText = parsedDual.orchestrationText;
			appliedOrchStaff = orchParsed.nodes.filter(n => n.kind === 'staff').length;
			const prevWbs = (record.whiteboards ?? {}) as Readonly<Record<string, IOrchestrationWhiteboard>>;
			const nextWbs: Record<string, IOrchestrationWhiteboard> = { ...prevWbs };
			for (const wbNode of orchParsed.nodes) {
				if (wbNode.kind === 'whiteboard' && !nextWbs[wbNode.id]) {
					const parsedWbSpec = orchParsed.whiteboardContents?.[wbNode.id];
					nextWbs[wbNode.id] = {
						id: wbNode.id,
						title: parsedWbSpec?.title || wbNode.label,
						department: parsedWbSpec?.department || wbNode.department || 'General',
						content: parsedWbSpec?.content ?? wbNode.whiteboardContent ?? '',
						version: parsedWbSpec?.version ?? wbNode.whiteboardVersion ?? 1,
						createdAt: nowTs,
						updatedAt: nowTs,
					};
				}
			}
			record.whiteboards = nextWbs;
		}
		await ctx.saveCurrentRecord(nowTs);
		return {
			handled: true,
			result: {
				headless: true,
				ok: true,
				missionId,
				nodeCount: dag.nodes.length,
				edgeCount: dag.edges.length,
				appliedTaskDescriptions: Object.keys(parsedDual.nodePrompts).length,
				...(parsedDual.orchestrationText ? { orchestrationApplied: true, staffCount: appliedOrchStaff } : {}),
			},
		};
	}

	if (action === 'mission.checkpoint.create' || action === 'orchestration.checkpoint.create') {
		if (!ctx.canOperateMission(caller) && !caller.isSecretary) {
			return { handled: true, error: `FORBIDDEN: caller is not authorized to create checkpoints for Mission "${missionId}".` };
		}
		const nowTs = Date.now();
		const label = typeof params.label === 'string' && params.label.trim() ? params.label.trim() : undefined;
		const reason = typeof params.reason === 'string' && params.reason.trim() ? params.reason.trim() : 'manual';
		const createdBy = caller.callerNodeId ?? caller.callerSessionId ?? (caller.isHumanUser ? 'human' : 'secretary');
		const built = buildHeadlessCheckpointSnapshot(missionId, record, { label, reason, createdBy, now: nowTs, seq: host.nextTmpSeq() });
		await host.saveMissionCheckpoint(missionId, built.checkpointId, built.payloadJson, built.meta);
		return {
			handled: true,
			result: {
				headless: true,
				ok: true,
				missionId,
				checkpoint: { ...built.meta, summary: built.summary },
			},
		};
	}

	if (action === 'mission.checkpoint.restore' || action === 'orchestration.checkpoint.restore') {
		if (!ctx.canOperateMission(caller) && !caller.isSecretary) {
			return { handled: true, error: `FORBIDDEN: caller is not authorized to restore checkpoints for Mission "${missionId}".` };
		}
		const checkpointId = String(params.checkpointId ?? params.id ?? '').trim();
		if (!checkpointId) {
			return { handled: true, error: 'Checkpoint ID (--id) is required for mission.checkpoint.restore.' };
		}
		const rawCkpt = await host.loadMissionCheckpoint(missionId, checkpointId);
		if (!rawCkpt) {
			return { handled: true, error: `Checkpoint "${checkpointId}" not found for Mission "${missionId}".` };
		}
		const bundle = parseUnifiedMissionCheckpointBundle(rawCkpt);
		if (!bundle) {
			return { handled: true, error: `Checkpoint "${checkpointId}" payload is malformed or contains no restorable snapshot.` };
		}
		const nowTs = Date.now();
		const restoreMode: 'full' | 'tokens_only' = String(params.mode ?? 'full').trim().toLowerCase() === 'tokens_only' ? 'tokens_only' : 'full';
		const baseOrch = orch ?? createInitialOrchestrationRuntimeState(missionId, []);
		const restored = applyOrchestrationCheckpointRestore(baseOrch, bundle.checkpointSnapshot, {
			mode: restoreMode,
			currentTaskStatuses: record.taskStatuses as Readonly<Record<string, IMissionTaskStatusRecord>> | undefined,
			currentWhiteboards: record.whiteboards as Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
			restoredBy: caller.callerNodeId ?? caller.callerSessionId ?? (caller.isHumanUser ? 'human' : 'secretary'),
			now: nowTs,
		});
		if (!restored.ok) {
			return { handled: true, error: restored.error ?? `Failed to restore checkpoint "${checkpointId}".` };
		}
		// Only take pre-restore auto-checkpoint and mutate record AFTER restore validation succeeds!
		const preRestoreCheckpointId = await saveAutoCheckpoint(ctx, `pre_restore:${checkpointId}`, nowTs);
		if (restoreMode === 'full') {
			if (bundle.mermaidText !== undefined) { record.mermaidText = bundle.mermaidText; }
			if (bundle.orchestrationText !== undefined) { record.orchestrationText = bundle.orchestrationText; }
			if (bundle.nodePrompts !== undefined) { record.nodePrompts = bundle.nodePrompts; }
			if (bundle.nodeChecks !== undefined) { record.nodeChecks = bundle.nodeChecks; }
		}
		record.orchestrationRuntime = restored.state;
		if (restored.taskStatuses !== undefined) { record.taskStatuses = restored.taskStatuses; }
		if (restored.whiteboards !== undefined) { record.whiteboards = restored.whiteboards; }
		await ctx.saveCurrentRecord(nowTs);
		host.syncHeadlessWatchdogForRecord(missionId, record);
		return {
			handled: true,
			result: {
				headless: true,
				ok: true,
				missionId,
				restoredCheckpointId: checkpointId,
				restoredMode: restoreMode,
				...(preRestoreCheckpointId ? { preRestoreCheckpointId } : {}),
				...(restored.tracePtr ? { tracePtr: restored.tracePtr } : {}),
				...(restored.diff ? { diff: restored.diff } : {}),
				stateRevision: restored.state.stateRevision,
			},
		};
	}

	if (action === 'org.escalate') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		const reason = String(params.reason ?? params.message ?? '').trim();
		if (!reason) {
			return { handled: true, error: 'Escalation --reason is required for org.escalate.' };
		}
		const now = Date.now();
		const tokenId = typeof (params.tokenId ?? params.token) === 'string' ? String(params.tokenId ?? params.token).trim() : '';
		const callerNode = caller.callerNodeId ? parsedGraph.nodes.find(n => n.id === caller.callerNodeId && n.kind === 'staff') : undefined;
		const callerTier = caller.callerTier ?? resolveEffectiveStaffTier(callerNode, effectiveOrgConfig) ?? 99;
		let targetSupNode: IOrchestrationGraphParseResult['nodes'][number] | undefined;
		if (callerNode && !parsedGraph.error) {
			const higherSuperiors = parsedGraph.edges
				.filter(e => e.to === callerNode.id)
				.map(e => parsedGraph.nodes.find(n => n.id === e.from && n.kind === 'staff'))
				.filter((n): n is NonNullable<typeof n> => {
					if (!n || n.id === callerNode.id) { return false; }
					const supTier = resolveEffectiveStaffTier(n, effectiveOrgConfig);
					return supTier !== undefined && supTier < callerTier;
				})
				.sort((a, b) => (resolveEffectiveStaffTier(b, effectiveOrgConfig) ?? 0) - (resolveEffectiveStaffTier(a, effectiveOrgConfig) ?? 0));
			targetSupNode = higherSuperiors[0];
		}
		const targetSupAgentId = targetSupNode ? (orch?.nodeAgentIds?.[targetSupNode.id] ?? targetSupNode.agentId) : undefined;
		const baseOrch = orch ?? createInitialOrchestrationRuntimeState(
			missionId,
			parsedGraph.nodes.filter(n => n.kind === 'staff').map(n => n.id),
			now,
		);
		const originNodeId = (typeof (params.nodeId ?? params.node) === 'string' && String(params.nodeId ?? params.node).trim())
			|| callerNode?.id
			|| 'orchestration';
		if (targetSupNode && targetSupAgentId && targetSupAgentId !== caller.callerSessionId) {
			const prompt = [
				`[Engineering Escalation · ${typeof record.title === 'string' ? record.title : missionId} (${missionId})]`,
				`- Node: ${originNodeId} | Token: ${tokenId || '(none)'}${caller.callerSessionId ? ` | Subordinate Agent: \`${caller.callerSessionId}\`` : ''}`,
				`- Failure / Escalation Reason: [Escalated by ${callerNode?.id ?? originNodeId}] ${reason}`,
				`- Next Actions: inspect via \`aexus-ade org context ${caller.callerSessionId || '<agentId>'} --json\`, mint/handoff a recovery baton, or escalate upward.`,
			].join('\n');
			await ctx.persistHeadlessOrchState(baseOrch, [{
				kind: 'wakeup_blocked',
				missionId,
				nodeId: targetSupNode.id,
				tokenId,
				holderAgentId: targetSupAgentId,
				message: prompt,
			}], now);
			return {
				handled: true,
				result: {
					headless: true,
					ok: true,
					missionId,
					escalatedTo: targetSupAgentId,
					escalatedToNodeId: targetSupNode.id,
					queuedEffects: 1,
				},
			};
		}
		await ctx.persistHeadlessOrchState(baseOrch, [{
			kind: 'post_inbox',
			missionId,
			nodeId: originNodeId,
			tokenId,
			title: `Engineering Escalation (${originNodeId})`,
			message: `Escalated by \`${callerNode?.id ?? caller.callerSessionId ?? 'staff'}\`${tokenId ? ` for token \`${tokenId}\`` : ''}:\n\n${reason}`,
			severity: 'critical',
			senderAgentId: caller.callerSessionId,
		}], now);
		return {
			handled: true,
			result: {
				headless: true,
				ok: true,
				missionId,
				escalatedTo: 'human_inbox',
			},
		};
	}

	if (action === 'whiteboard.create' || action === 'whiteboard.write' || action === 'whiteboard.rename' || action === 'whiteboard.remove') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		const existingWbs = ctx.buildMergedWhiteboards();
		if (action === 'whiteboard.rename') {
			const wbId = String(params.whiteboardId ?? params.whiteboard ?? params.id ?? '').trim();
			const title = String(params.title ?? params.name ?? '').trim();
			const requestedDept = typeof (params.department ?? params.dept) === 'string' && String(params.department ?? params.dept).trim()
				? String(params.department ?? params.dept).trim()
				: undefined;
			if (!wbId || !title) {
				return { handled: true, error: 'Whiteboard ID and new --title are required for whiteboard.rename.' };
			}
			const existing = existingWbs[wbId];
			if (!existing) {
				return { handled: true, error: `Department whiteboard "${wbId}" not found.` };
			}
			const nextDept = requestedDept ?? existing.department;
			const adminErr = assertHeadlessDeptWhiteboardAdmin(ctx, [existing.department, nextDept], 'rename');
			if (adminErr) {
				return { handled: true, error: adminErr };
			}
			const now = Date.now();
			const mutated = mutateDepartmentWhiteboard(existingWbs, {
				id: wbId,
				title,
				department: nextDept,
				mode: 'write',
				allowDepartmentRelocation: true,
				updatedBy: caller.callerSessionId ?? (caller.isHumanUser ? 'human' : undefined),
				now,
			});
			if (!mutated.ok || !mutated.whiteboard || !mutated.whiteboards) {
				return { handled: true, error: mutated.error ?? `Failed to rename whiteboard "${wbId}".` };
			}
			record.whiteboards = mutated.whiteboards;
			record.orchestrationText = upsertOrchestrationWhiteboardInCode(orchestrationText, {
				id: mutated.whiteboard.id,
				title: mutated.whiteboard.title,
				department: mutated.whiteboard.department,
				content: mutated.whiteboard.content,
				version: mutated.whiteboard.version,
			});
			await ctx.saveCurrentRecord(now);
			return {
				handled: true,
				result: {
					headless: true,
					ok: true,
					missionId,
					whiteboard: {
						whiteboardId: mutated.whiteboard.id,
						title: mutated.whiteboard.title,
						department: mutated.whiteboard.department,
						version: mutated.whiteboard.version,
					},
				},
			};
		}
		if (action === 'whiteboard.remove') {
			const wbId = String(params.whiteboardId ?? params.whiteboard ?? params.id ?? '').trim();
			if (!wbId) {
				return { handled: true, error: 'Whiteboard ID is required for whiteboard.remove.' };
			}
			const existing = existingWbs[wbId];
			if (!existing) {
				return { handled: true, error: `Department whiteboard "${wbId}" not found.` };
			}
			const adminErr = assertHeadlessDeptWhiteboardAdmin(ctx, [existing.department], 'remove');
			if (adminErr) {
				return { handled: true, error: adminErr };
			}
			const now = Date.now();
			const nextWbs: Record<string, IOrchestrationWhiteboard> = { ...existingWbs };
			delete nextWbs[wbId];
			record.whiteboards = Object.keys(nextWbs).length > 0 ? nextWbs : undefined;
			record.orchestrationText = removeOrchestrationNode(orchestrationText, wbId);
			let prunedTokenIds: readonly string[] = [];
			if (orch) {
				const pruned = pruneRemovedWhiteboardFromState(orch, wbId, now);
				prunedTokenIds = pruned.prunedTokenIds;
				record.orchestrationRuntime = pruned.state;
			}
			await ctx.saveCurrentRecord(now);
			return {
				handled: true,
				result: {
					headless: true,
					ok: true,
					missionId,
					removedWhiteboardId: wbId,
					...(prunedTokenIds.length > 0 ? { prunedTokenIds } : {}),
				},
			};
		}

		// whiteboard.create / whiteboard.write
		const highestTier = effectiveOrgConfig.ranks.length > 0 ? Math.min(...effectiveOrgConfig.ranks.map(r => r.tier)) : 1;
		const isOwner = typeof record.ownerSessionId === 'string' && record.ownerSessionId.trim() === caller.callerSessionId;
		const isTopPriv = caller.isHumanUser || caller.isSecretary || isOwner || (caller.callerTier !== undefined && caller.callerTier <= highestTier);
		const callerNode = caller.callerNodeId ? parsedGraph.nodes.find(n => n.id === caller.callerNodeId && n.kind === 'staff') : undefined;
		let wbId = String(params.id ?? params.whiteboardId ?? params.whiteboard ?? '').trim();
		const requestedDept = typeof (params.department ?? params.dept) === 'string' ? String(params.department ?? params.dept).trim() : '';
		const targetDept = requestedDept || (wbId ? existingWbs[wbId]?.department : undefined) || callerNode?.department?.trim() || (isTopPriv ? 'General' : '');

		if (action === 'whiteboard.create' && !wbId) {
			if (!isTopPriv) {
				const callerDept = callerNode?.department?.trim();
				if (!callerDept || (!isStrictCompanyWideExecutiveDept(callerDept) && targetDept.toLowerCase() !== callerDept.toLowerCase())) {
					return { handled: true, error: `CROSS_DEPARTMENT_FORBIDDEN: caller "${caller.callerNodeId ?? 'caller'}" cannot create whiteboard in department "${targetDept || 'Unassigned'}".` };
				}
			}
			const title = typeof params.title === 'string' && params.title.trim() ? params.title.trim() : `${targetDept || 'General'} Whiteboard`;
			const planned = planDynamicWhiteboardCreation(orchestrationText, {
				title,
				department: targetDept || 'General',
				connectFromNodeId: caller.callerNodeId,
			});
			if (!planned.ok || !planned.whiteboardId) {
				return { handled: true, error: planned.error ?? 'Failed to auto-generate Department Whiteboard ID.' };
			}
			wbId = planned.whiteboardId;
		}
		if (!wbId) {
			return { handled: true, error: 'Whiteboard ID is required for whiteboard.write.' };
		}
		const existing = existingWbs[wbId];
		if (existing) {
			if (!canCallerAccessWhiteboard(parsedGraph, existing, effectiveOrgConfig, { ...caller, access: 'write', state: orch })) {
				return { handled: true, error: `FORBIDDEN: caller cannot write to department "${existing.department}" whiteboard "${existing.id}".` };
			}
		} else if (!isTopPriv) {
			const callerDept = callerNode?.department?.trim();
			if (!callerDept || !targetDept || (!isStrictCompanyWideExecutiveDept(callerDept) && targetDept.toLowerCase() !== callerDept.toLowerCase())) {
				return { handled: true, error: `CROSS_DEPARTMENT_FORBIDDEN: caller "${caller.callerNodeId ?? 'caller'}" cannot create whiteboard "${wbId}" in department "${targetDept || 'Unassigned'}".` };
			}
		}
		const now = Date.now();
		const rawExpected = params.expectedVersion ?? params.ifVersion;
		let expectedVersion: number | undefined;
		if (rawExpected !== undefined && rawExpected !== null && String(rawExpected).trim() !== '') {
			const parsedExp = Number(rawExpected);
			if (!Number.isInteger(parsedExp) || parsedExp < 0) {
				return { handled: true, error: `Invalid expectedVersion "${String(rawExpected)}": must be a non-negative integer.` };
			}
			expectedVersion = parsedExp;
		}
		const sectionHeading = typeof params.section === 'string' && params.section.trim() ? params.section.trim() : undefined;
		let nextContent = typeof params.content === 'string' ? params.content : undefined;
		let nextAppend = typeof params.appendContent === 'string' ? params.appendContent : undefined;
		if (sectionHeading) {
			const sectionBody = nextAppend ?? nextContent ?? '';
			const sectionMode: 'replace' | 'append' = (params.sectionMode === 'append' || (nextAppend !== undefined && nextContent === undefined)) ? 'append' : 'replace';
			nextContent = upsertWhiteboardSection(existing?.content ?? '', sectionHeading, sectionBody, sectionMode);
			nextAppend = undefined;
		}
		const mutated = mutateDepartmentWhiteboard(existingWbs, {
			id: wbId,
			title: typeof params.title === 'string' ? params.title : undefined,
			department: targetDept || existing?.department || 'General',
			content: nextContent,
			appendContent: nextAppend,
			mode: action === 'whiteboard.create' ? 'create' : 'write',
			...(expectedVersion !== undefined ? { expectedVersion } : {}),
			updatedBy: caller.callerSessionId ?? (caller.isHumanUser ? 'human' : undefined),
			now,
		});
		if (!mutated.ok || !mutated.whiteboard || !mutated.whiteboards) {
			return { handled: true, error: mutated.error ?? 'Failed to write Department Whiteboard.' };
		}
		record.whiteboards = mutated.whiteboards;
		record.orchestrationText = upsertOrchestrationWhiteboardInCode(orchestrationText, {
			id: mutated.whiteboard.id,
			title: mutated.whiteboard.title,
			department: mutated.whiteboard.department,
			content: mutated.whiteboard.content,
			version: mutated.whiteboard.version,
		});
		await ctx.saveCurrentRecord(now);
		return {
			handled: true,
			result: {
				headless: true,
				ok: true,
				missionId,
				whiteboard: {
					whiteboardId: mutated.whiteboard.id,
					title: mutated.whiteboard.title,
					department: mutated.whiteboard.department,
					version: mutated.whiteboard.version,
					updatedAt: mutated.whiteboard.updatedAt,
				},
			},
		};
	}

	if (
		action === 'mission.task.set'
		|| action === 'mission.task.create'
		|| action === 'mission.task.update'
		|| action === 'mission.task.remove'
		|| action === 'mission.task.edge.add'
		|| action === 'mission.task.edge.remove'
	) {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		const currentMermaid = typeof record.mermaidText === 'string' ? record.mermaidText : '';
		const parsedDag = parseMissionMermaidDag(currentMermaid);
		const nowTs = Date.now();
		if (action === 'mission.task.set') {
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			if (!nodeId) {
				return { handled: true, error: 'Task node ID (--node) is required for mission.task.set.' };
			}
			const target = parsedDag.nodes.find(n => n.id === nodeId);
			if (!target) {
				return { handled: true, error: `Task node "${nodeId}" not found in Mission "${missionId}".` };
			}
			const scopeErr = assertHeadlessTaskDesignScope(ctx, 'edit description of', { targetDepartment: target.department, targetOwnerNodeId: target.ownerNodeId });
			if (scopeErr) { return { handled: true, error: scopeErr }; }
			const hasDescParam = params.description !== undefined || params.prompt !== undefined || params.text !== undefined;
			const hasContractParam = params.requireChecksPassed !== undefined || params.requirePassingChecks !== undefined
				|| params.requireChecks !== undefined || params.requireArtifact !== undefined || params.requireFiles !== undefined
				|| params.requiredWhiteboardIds !== undefined || params.requireWhiteboard !== undefined || params.requireWb !== undefined
				|| params.minSummaryChars !== undefined || params.minSummary !== undefined || params.minEvidenceChars !== undefined;
			if (!hasDescParam && !hasContractParam) {
				return { handled: true, error: 'Task --description (or --text / --prompt) is required for mission.task.set.' };
			}
			if (hasContractParam) {
				const metaPatch: {
					requireChecksPassed?: boolean | null;
					requireArtifact?: boolean | null;
					requireFiles?: boolean | null;
					requiredWhiteboardIds?: readonly string[] | null;
					minSummaryChars?: number | null;
				} = {};
				if (params.requireChecksPassed !== undefined || params.requirePassingChecks !== undefined || params.requireChecks !== undefined) {
					const v = params.requireChecksPassed ?? params.requirePassingChecks ?? params.requireChecks;
					metaPatch.requireChecksPassed = v === null ? null : Boolean(v);
				}
				if (params.requireArtifact !== undefined) {
					metaPatch.requireArtifact = params.requireArtifact === null ? null : Boolean(params.requireArtifact);
				}
				if (params.requireFiles !== undefined) {
					metaPatch.requireFiles = params.requireFiles === null ? null : Boolean(params.requireFiles);
				}
				if (params.requiredWhiteboardIds !== undefined || params.requireWhiteboard !== undefined || params.requireWb !== undefined) {
					const rawW = params.requiredWhiteboardIds ?? params.requireWhiteboard ?? params.requireWb;
					metaPatch.requiredWhiteboardIds = (rawW === null || rawW === '') ? null : parseCsvList(rawW);
				}
				if (params.minSummaryChars !== undefined || params.minSummary !== undefined || params.minEvidenceChars !== undefined) {
					const rawS = params.minSummaryChars ?? params.minSummary ?? params.minEvidenceChars;
					metaPatch.minSummaryChars = (rawS === null || rawS === '' || rawS === 0) ? null : (Number.isInteger(Number(rawS)) && Number(rawS) >= 1 ? Math.min(2_000, Number(rawS)) : null);
				}
				record.mermaidText = upsertTaskMetadataInMermaid(currentMermaid, nodeId, metaPatch);
			}
			const nextPrompts: Record<string, string> = { ...((record.nodePrompts ?? {}) as Record<string, string>) };
			if (hasDescParam) {
				const desc = String(params.description ?? params.prompt ?? params.text ?? '');
				if (desc.trim()) { nextPrompts[nodeId] = desc; } else { delete nextPrompts[nodeId]; }
				record.nodePrompts = Object.keys(nextPrompts).length > 0 ? nextPrompts : undefined;
			}
			await ctx.saveCurrentRecord(nowTs);
			return { handled: true, result: { headless: true, ok: true, missionId, nodeId, description: nextPrompts[nodeId] ?? '' } };
		}
		if (action === 'mission.task.create') {
			const explicitDept = typeof (params.department ?? params.dept) === 'string' && String(params.department ?? params.dept).trim()
				? String(params.department ?? params.dept).trim()
				: undefined;
			const scopeErr = assertHeadlessTaskDesignScope(ctx, 'create', { requestedDepartment: explicitDept });
			if (scopeErr) { return { handled: true, error: scopeErr }; }
			const title = String(params.title ?? params.label ?? params.name ?? '').trim();
			const explicitId = typeof (params.id ?? params.node ?? params.nodeId) === 'string' && String(params.id ?? params.node ?? params.nodeId).trim()
				? String(params.id ?? params.node ?? params.nodeId).trim()
				: undefined;
			if (!title && !explicitId) {
				return { handled: true, error: 'Task --title (or --id) is required for mission.task.create.' };
			}
			const added = addNodeToMermaid(currentMermaid, {
				id: explicitId,
				label: title || explicitId,
				kind: params.kind === 'gate' ? 'gate' : 'task',
			});
			let nextMermaid = added.mermaidText;
			const nodeId = added.nodeId;
			const callerStaff = caller.callerNodeId ? parsedGraph.nodes.find(n => n.id === caller.callerNodeId && n.kind === 'staff') : undefined;
			const ownerNodeId = typeof (params.ownerNodeId ?? params.owner) === 'string' && String(params.ownerNodeId ?? params.owner).trim()
				? String(params.ownerNodeId ?? params.owner).trim()
				: caller.callerNodeId;
			const assigneeNodeId = typeof (params.assigneeNodeId ?? params.assignee) === 'string' && String(params.assigneeNodeId ?? params.assignee).trim()
				? String(params.assigneeNodeId ?? params.assignee).trim()
				: undefined;
			const department = explicitDept ?? callerStaff?.department;
			const parsedMinTier = parseStrictMinTierParam(params.minCompleterTier ?? params.minTier, { allowClear: false });
			if (!parsedMinTier.ok) {
				return { handled: true, error: parsedMinTier.error };
			}
			const completers = parseCsvList(params.allowedCompleterNodeIds ?? params.completers);
			const rawReqChecks = params.requireChecksPassed ?? params.requirePassingChecks ?? params.requireChecks;
			const rawReqArtifact = params.requireArtifact;
			const rawReqFiles = params.requireFiles;
			const reqWbs = parseCsvList(params.requiredWhiteboardIds ?? params.requireWhiteboard ?? params.requireWb);
			const rawMinSum = params.minSummaryChars ?? params.minSummary ?? params.minEvidenceChars;
			const minSummaryChars = rawMinSum !== undefined && rawMinSum !== null && String(rawMinSum).trim() !== '' && Number.isInteger(Number(rawMinSum)) && Number(rawMinSum) >= 1
				? Math.min(2_000, Number(rawMinSum))
				: undefined;
			const hasContractCreate = rawReqChecks !== undefined || rawReqArtifact !== undefined || rawReqFiles !== undefined || reqWbs.length > 0 || minSummaryChars !== undefined;
			if (ownerNodeId || assigneeNodeId || department || parsedMinTier.value !== undefined || completers.length > 0 || hasContractCreate) {
				nextMermaid = upsertTaskMetadataInMermaid(nextMermaid, nodeId, {
					...(ownerNodeId ? { ownerNodeId } : {}),
					...(assigneeNodeId ? { assigneeNodeId } : {}),
					...(department ? { department } : {}),
					...(parsedMinTier.value !== undefined ? { minCompleterTier: parsedMinTier.value } : {}),
					...(completers.length > 0 ? { allowedCompleterNodeIds: completers } : {}),
					...(rawReqChecks !== undefined ? { requireChecksPassed: Boolean(rawReqChecks) } : {}),
					...(rawReqArtifact !== undefined ? { requireArtifact: Boolean(rawReqArtifact) } : {}),
					...(rawReqFiles !== undefined ? { requireFiles: Boolean(rawReqFiles) } : {}),
					...(reqWbs.length > 0 ? { requiredWhiteboardIds: reqWbs } : {}),
					...(minSummaryChars !== undefined ? { minSummaryChars } : {}),
				});
			}
			for (const upId of parseCsvList(params.after ?? params.upstream ?? params.dependsOn)) {
				const edgeRes = addEdgeToMermaid(nextMermaid, upId, nodeId);
				if (!edgeRes.ok || !edgeRes.mermaidText) {
					return { handled: true, error: edgeRes.error ?? `Failed to add dependency edge ${upId} -> ${nodeId}.` };
				}
				nextMermaid = edgeRes.mermaidText;
			}
			for (const downId of parseCsvList(params.before ?? params.downstream)) {
				const edgeRes = addEdgeToMermaid(nextMermaid, nodeId, downId);
				if (!edgeRes.ok || !edgeRes.mermaidText) {
					return { handled: true, error: edgeRes.error ?? `Failed to add dependency edge ${nodeId} -> ${downId}.` };
				}
				nextMermaid = edgeRes.mermaidText;
			}
			const finalParsed = parseMissionMermaidDag(nextMermaid);
			if (finalParsed.error) {
				return { handled: true, error: finalParsed.error };
			}
			record.mermaidText = nextMermaid;
			if (typeof params.description === 'string' && params.description.trim()) {
				record.nodePrompts = { ...((record.nodePrompts ?? {}) as Record<string, string>), [nodeId]: params.description.trim() };
			}
			await ctx.saveCurrentRecord(nowTs);
			return { handled: true, result: { headless: true, ok: true, missionId, nodeId, node: finalParsed.nodes.find(n => n.id === nodeId) } };
		}
		if (action === 'mission.task.update') {
			const nodeId = String(params.node ?? params.nodeId ?? params.id ?? '').trim();
			if (!nodeId) {
				return { handled: true, error: 'Task node ID (--node) is required for mission.task.update.' };
			}
			const target = parsedDag.nodes.find(n => n.id === nodeId);
			if (!target) {
				return { handled: true, error: `Task node "${nodeId}" not found in Mission "${missionId}".` };
			}
			const requestedDept = typeof (params.department ?? params.dept) === 'string' && String(params.department ?? params.dept).trim()
				? String(params.department ?? params.dept).trim()
				: undefined;
			const scopeErr = assertHeadlessTaskDesignScope(ctx, 'update', { targetDepartment: target.department, targetOwnerNodeId: target.ownerNodeId, requestedDepartment: requestedDept });
			if (scopeErr) { return { handled: true, error: scopeErr }; }
			let nextMermaid = currentMermaid;
			const nextTitle = typeof (params.title ?? params.label ?? params.name) === 'string' && String(params.title ?? params.label ?? params.name).trim()
				? String(params.title ?? params.label ?? params.name).trim()
				: undefined;
			if (nextTitle) {
				nextMermaid = renameNodeInMermaid(nextMermaid, nodeId, nextTitle);
			}
			const metaPatch: {
				ownerNodeId?: string | null;
				assigneeNodeId?: string | null;
				department?: string | null;
				minCompleterTier?: number | null;
				allowedCompleterNodeIds?: readonly string[] | null;
				requireChecksPassed?: boolean | null;
				requireArtifact?: boolean | null;
				requireFiles?: boolean | null;
				requiredWhiteboardIds?: readonly string[] | null;
				minSummaryChars?: number | null;
				color?: string | null;
			} = {};
			let hasMetaPatch = false;
			if (params.ownerNodeId !== undefined || params.owner !== undefined) {
				const v = params.ownerNodeId ?? params.owner;
				metaPatch.ownerNodeId = v === null ? null : String(v);
				hasMetaPatch = true;
			}
			if (params.assigneeNodeId !== undefined || params.assignee !== undefined) {
				const v = params.assigneeNodeId ?? params.assignee;
				metaPatch.assigneeNodeId = v === null ? null : String(v);
				hasMetaPatch = true;
			}
			if (params.department !== undefined || params.dept !== undefined) {
				const v = params.department ?? params.dept;
				metaPatch.department = v === null ? null : String(v);
				hasMetaPatch = true;
			}
			if (params.minCompleterTier !== undefined || params.minTier !== undefined) {
				const parsedMinTier = parseStrictMinTierParam(params.minCompleterTier ?? params.minTier, { allowClear: true });
				if (!parsedMinTier.ok) { return { handled: true, error: parsedMinTier.error }; }
				metaPatch.minCompleterTier = parsedMinTier.clear ? null : parsedMinTier.value;
				hasMetaPatch = true;
			}
			if (params.allowedCompleterNodeIds !== undefined || params.completers !== undefined) {
				const rawC = params.allowedCompleterNodeIds ?? params.completers;
				metaPatch.allowedCompleterNodeIds = (rawC === null || rawC === '') ? null : parseCsvList(rawC);
				hasMetaPatch = true;
			}
			if (params.requireChecksPassed !== undefined || params.requirePassingChecks !== undefined || params.requireChecks !== undefined) {
				const v = params.requireChecksPassed ?? params.requirePassingChecks ?? params.requireChecks;
				metaPatch.requireChecksPassed = v === null ? null : Boolean(v);
				hasMetaPatch = true;
			}
			if (params.requireArtifact !== undefined) {
				metaPatch.requireArtifact = params.requireArtifact === null ? null : Boolean(params.requireArtifact);
				hasMetaPatch = true;
			}
			if (params.requireFiles !== undefined) {
				metaPatch.requireFiles = params.requireFiles === null ? null : Boolean(params.requireFiles);
				hasMetaPatch = true;
			}
			if (params.requiredWhiteboardIds !== undefined || params.requireWhiteboard !== undefined || params.requireWb !== undefined) {
				const rawW = params.requiredWhiteboardIds ?? params.requireWhiteboard ?? params.requireWb;
				metaPatch.requiredWhiteboardIds = (rawW === null || rawW === '') ? null : parseCsvList(rawW);
				hasMetaPatch = true;
			}
			if (params.minSummaryChars !== undefined || params.minSummary !== undefined || params.minEvidenceChars !== undefined) {
				const rawS = params.minSummaryChars ?? params.minSummary ?? params.minEvidenceChars;
				metaPatch.minSummaryChars = (rawS === null || rawS === '' || rawS === 0) ? null : (Number.isInteger(Number(rawS)) && Number(rawS) >= 1 ? Math.min(2_000, Number(rawS)) : null);
				hasMetaPatch = true;
			}
			if (params.color !== undefined || params.accent !== undefined) {
				const v = params.color ?? params.accent;
				metaPatch.color = (v === null || v === '') ? null : String(v);
				hasMetaPatch = true;
			}
			if (hasMetaPatch) {
				nextMermaid = upsertTaskMetadataInMermaid(nextMermaid, nodeId, metaPatch);
			}
			record.mermaidText = nextMermaid;
			if (typeof params.description === 'string') {
				const nextPrompts: Record<string, string> = { ...((record.nodePrompts ?? {}) as Record<string, string>) };
				if (params.description.trim()) { nextPrompts[nodeId] = params.description; } else { delete nextPrompts[nodeId]; }
				record.nodePrompts = Object.keys(nextPrompts).length > 0 ? nextPrompts : undefined;
			}
			await ctx.saveCurrentRecord(nowTs);
			const reparsed = parseMissionMermaidDag(nextMermaid);
			return { handled: true, result: { headless: true, ok: true, missionId, nodeId, node: reparsed.nodes.find(n => n.id === nodeId) } };
		}
		if (action === 'mission.task.remove') {
			const nodeId = String(params.node ?? params.nodeId ?? params.id ?? '').trim();
			if (!nodeId) { return { handled: true, error: 'Task node ID (--node) is required for mission.task.remove.' }; }
			const target = parsedDag.nodes.find(n => n.id === nodeId);
			if (!target) { return { handled: true, error: `Task node "${nodeId}" not found in Mission "${missionId}".` }; }
			const scopeErr = assertHeadlessTaskDesignScope(ctx, 'remove', { targetDepartment: target.department, targetOwnerNodeId: target.ownerNodeId });
			if (scopeErr) { return { handled: true, error: scopeErr }; }
			record.mermaidText = removeNodeFromMermaid(currentMermaid, nodeId);
			const prevStatuses = record.taskStatuses as Record<string, IMissionTaskStatusRecord> | undefined;
			if (prevStatuses && Object.hasOwn(prevStatuses, nodeId)) {
				const nextStatuses = { ...prevStatuses };
				delete nextStatuses[nodeId];
				record.taskStatuses = Object.keys(nextStatuses).length > 0 ? nextStatuses : undefined;
			}
			await ctx.saveCurrentRecord(nowTs);
			return { handled: true, result: { headless: true, ok: true, missionId, removedNodeId: nodeId } };
		}
		// mission.task.edge.add / mission.task.edge.remove
		const from = String(params.from ?? '').trim();
		const to = String(params.to ?? '').trim();
		if (!from || !to) {
			return { handled: true, error: `Both --from and --to task node IDs are required for ${action}.` };
		}
		const fromTask = parsedDag.nodes.find(n => n.id === from);
		const toTask = parsedDag.nodes.find(n => n.id === to);
		const fromErr = assertHeadlessTaskDesignScope(ctx, action === 'mission.task.edge.add' ? 'connect edge from' : 'disconnect edge from', { targetDepartment: fromTask?.department, targetOwnerNodeId: fromTask?.ownerNodeId });
		if (fromErr) { return { handled: true, error: fromErr }; }
		const toErr = assertHeadlessTaskDesignScope(ctx, action === 'mission.task.edge.add' ? 'connect edge to' : 'disconnect edge to', { targetDepartment: toTask?.department, targetOwnerNodeId: toTask?.ownerNodeId });
		if (toErr) { return { handled: true, error: toErr }; }
		if (action === 'mission.task.edge.add') {
			const edgeRes = addEdgeToMermaid(currentMermaid, from, to, {
				label: typeof params.label === 'string' && params.label.trim() ? params.label.trim() : undefined,
				kind: params.kind === 'fail' ? 'fail' : 'success',
			});
			if (!edgeRes.ok || !edgeRes.mermaidText) {
				return { handled: true, error: edgeRes.error ?? `Failed to add edge ${from} -> ${to}.` };
			}
			record.mermaidText = edgeRes.mermaidText;
		} else {
			record.mermaidText = removeEdgeFromMermaid(currentMermaid, from, to);
		}
		await ctx.saveCurrentRecord(nowTs);
		return { handled: true, result: { headless: true, ok: true, missionId, from, to } };
	}

	if (action === 'mission.check.set' || action === 'mission.check.remove') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		const nodeId = String(params.node ?? params.nodeId ?? '').trim();
		if (!nodeId) {
			return { handled: true, error: `Node ID (--node) is required for ${action}.` };
		}
		const scopeErr = assertHeadlessTaskDesignScope(ctx, action === 'mission.check.set' ? 'configure check on' : 'remove check from', {});
		if (scopeErr && !ctx.canOperateMission(caller)) {
			// Allow managers to configure checks on their own department staff/tasks
			const staffTarget = parsedGraph.nodes.find(n => n.id === nodeId && n.kind === 'staff');
			const dagTarget = parseMissionMermaidDag(typeof record.mermaidText === 'string' ? record.mermaidText : '').nodes.find(n => n.id === nodeId);
			const deptScopeErr = assertHeadlessTaskDesignScope(ctx, action === 'mission.check.set' ? 'configure check on' : 'remove check from', {
				targetDepartment: staffTarget?.department ?? dagTarget?.department,
				targetOwnerNodeId: dagTarget?.ownerNodeId,
			});
			if (deptScopeErr) {
				return { handled: true, error: deptScopeErr };
			}
		}
		const nowTs = Date.now();
		const currentChecks = { ...((record.nodeChecks ?? {}) as Record<string, readonly IMissionNodeCheckHook[]>) };
		if (action === 'mission.check.remove') {
			const checkId = typeof (params.checkId ?? params.id) === 'string' && String(params.checkId ?? params.id).trim()
				? String(params.checkId ?? params.id).trim()
				: undefined;
			if (!checkId) {
				delete currentChecks[nodeId];
			} else {
				const filtered = (currentChecks[nodeId] ?? []).filter(c => c.id !== checkId);
				if (filtered.length > 0) { currentChecks[nodeId] = filtered; } else { delete currentChecks[nodeId]; }
			}
			record.nodeChecks = Object.keys(currentChecks).length > 0 ? currentChecks : undefined;
			await ctx.saveCurrentRecord(nowTs);
			return { handled: true, result: { headless: true, ok: true, missionId, nodeId, checks: currentChecks[nodeId] ?? [] } };
		}
		const command = typeof params.command === 'string' && params.command.trim() ? params.command.trim() : undefined;
		const expectFiles = parseCsvList(params.expectFiles ?? params.expectFile);
		if (!command && expectFiles.length === 0) {
			return { handled: true, error: 'Either --command or --expect-files is required for mission.check.set.' };
		}
		const checkId = typeof (params.checkId ?? params.id) === 'string' && String(params.checkId ?? params.id).trim()
			? String(params.checkId ?? params.id).trim()
			: `chk-${nodeId}-${host.nextTmpSeq()}`;
		const hook: IMissionNodeCheckHook = {
			id: checkId,
			...(typeof params.name === 'string' && params.name.trim() ? { name: params.name.trim() } : {}),
			...(command ? { command } : {}),
			...(typeof params.expectExitCode === 'number' && Number.isInteger(params.expectExitCode) ? { expectExitCode: params.expectExitCode } : {}),
			...(typeof params.cwd === 'string' && params.cwd.trim() ? { cwd: params.cwd.trim() } : {}),
			...(typeof (params.hostAlias ?? params.host) === 'string' && String(params.hostAlias ?? params.host).trim() ? { hostAlias: String(params.hostAlias ?? params.host).trim() } : {}),
			...(expectFiles.length > 0 ? { expectFiles } : {}),
			...(typeof params.expectOutputMatch === 'string' && params.expectOutputMatch.trim() ? { expectOutputMatch: params.expectOutputMatch.trim() } : {}),
			...(typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) ? { timeoutMs: Math.max(1_000, Math.min(300_000, Math.round(params.timeoutMs))) } : {}),
			...(params.onFail === 'bounce' || params.onFail === 'fail' || params.onFail === 'escalate' ? { onFail: params.onFail } : {}),
			enabled: params.enabled !== false,
			source: 'config',
		};
		const prevList = currentChecks[nodeId] ?? [];
		const idx = prevList.findIndex(c => c.id === checkId);
		currentChecks[nodeId] = idx >= 0 ? prevList.map((c, i) => (i === idx ? hook : c)) : [...prevList, hook];
		record.nodeChecks = currentChecks;
		await ctx.saveCurrentRecord(nowTs);
		return { handled: true, result: { headless: true, ok: true, missionId, nodeId, check: hook, checks: currentChecks[nodeId] } };
	}

	if (action === 'mission.task.complete' || action === 'mission.task.status') {
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		const nodeId = String(params.node ?? params.nodeId ?? '').trim();
		if (!nodeId) {
			return { handled: true, error: 'Task node ID (--node) is required.' };
		}
		const rawStatus = action === 'mission.task.complete' ? 'completed' : String(params.status ?? '').trim().toLowerCase();
		if (!['pending', 'in_progress', 'completed', 'blocked'].includes(rawStatus)) {
			return { handled: true, error: `Invalid task status "${rawStatus}".` };
		}
		const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
		const taskGraph = parseMissionMermaidDag(mermaidText);
		const targetTaskNode = taskGraph.nodes.find(n => n.id === nodeId);
		if (!targetTaskNode) {
			return { handled: true, error: `Task node "${nodeId}" not found in Mission "${missionId}".` };
		}
		const now = Date.now();
		// Security: align check-skipping/force bypass strictly with renderer (Human L-1 only).
		const forceBypass = params.force === true && Boolean(caller.isHumanUser);
		let currentStatuses = record.taskStatuses as Readonly<Record<string, IMissionTaskStatusRecord>> | undefined;
		// Security: validate caller's task-completion authority BEFORE executing side-effecting deterministic checks!
		if (rawStatus === 'completed') {
			if (targetTaskNode.kind === 'gate') {
				const gateAllowed = Boolean(
					caller.isHumanUser
					|| caller.isSecretary
					|| (caller.callerNodeId && targetTaskNode.allowedCompleterNodeIds?.includes(caller.callerNodeId)),
				);
				if (!gateAllowed) {
					return { handled: true, error: `FORBIDDEN: Human approval gate "${nodeId}" may only be completed by Human User, Secretary, or an explicitly allowlisted approver.` };
				}
			} else if (!canCallerCompleteMissionTask(
				effectiveOrgConfig,
				targetTaskNode,
				{
					isHumanUser: caller.isHumanUser,
					isSecretary: caller.isSecretary,
					callerTier: caller.callerTier,
					callerNodeId: caller.callerNodeId,
				},
				!parsedGraph.error ? parsedGraph : undefined,
				currentStatuses?.[nodeId],
			)) {
				return { handled: true, error: `FORBIDDEN: caller lacks completion authority for Mission task "${nodeId}".` };
			}
		}
		let checkReceipt: IMissionTaskCheckReceipt | undefined = currentStatuses?.[nodeId]?.lastCheckReceipt;
		const configuredChecks = ctx.collectEffectiveNodeChecks(nodeId)[nodeId]?.filter(c => c.enabled !== false) ?? [];
		if (rawStatus === 'completed' && configuredChecks.length > 0 && !forceBypass) {
			const checkOutcome = await host.runHeadlessOrchestrationChecksIfNeeded(
				record,
				parsedGraph,
				taskGraph,
				nodeId,
				[],
				params.skipChecks === true,
				caller.isHumanUser,
			);
			if (checkOutcome.receipt) {
				checkReceipt = checkOutcome.receipt;
				currentStatuses = recordMissionTaskCheckReceipt(currentStatuses, nodeId, checkReceipt);
				record.taskStatuses = currentStatuses;
			}
			if (!checkOutcome.ok) {
				await ctx.saveCurrentRecord(now);
				return { handled: true, error: checkOutcome.error };
			}
		}
		const touchedFiles = parseStrList(params.touchedFiles ?? params.modifiedFiles ?? params.files);
		const effectiveNote = typeof params.note === 'string' && params.note.trim()
			? params.note
			: (typeof (params.evidence ?? params.evidenceSummary) === 'string' && String(params.evidence ?? params.evidenceSummary).trim()
				? String(params.evidence ?? params.evidenceSummary)
				: (typeof params.note === 'string' ? params.note : undefined));
		const res = updateMissionTaskNodeStatus(
			currentStatuses,
			taskGraph,
			effectiveOrgConfig,
			{
				nodeId,
				status: rawStatus as MissionTaskStatus,
				caller: {
					isHumanUser: caller.isHumanUser,
					isSecretary: caller.isSecretary,
					callerTier: caller.callerTier,
					callerSessionId: caller.callerSessionId,
					callerNodeId: caller.callerNodeId,
				},
				orchGraph: !parsedGraph.error ? parsedGraph : undefined,
				whiteboards: ctx.buildMergedWhiteboards(),
				hasConfiguredChecks: configuredChecks.length > 0,
				...(checkReceipt ? { checkReceipt } : {}),
				...(touchedFiles && touchedFiles.length > 0 ? { touchedFiles } : {}),
				force: params.force === true,
				note: effectiveNote,
				now,
			},
		);
		if (!res.ok) {
			return { handled: true, error: res.error ?? `Failed to update task "${nodeId}" status.` };
		}
		record.taskStatuses = res.taskStatuses;
		await ctx.saveCurrentRecord(now);
		return {
			handled: true,
			result: { headless: true, ok: true, missionId, nodeId, status: res.taskStatuses[nodeId] },
		};
	}

	if (
		action === 'token.return'
		|| action === 'token.handoff'
		|| action === 'token.complete'
		|| action === 'token.reject'
		|| action === 'token.block'
		|| action === 'token.fail'
		|| action === 'token.retry'
		|| action === 'token.mint'
		|| action === 'token.split'
	) {
		if (!orch) {
			return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
		}
		const denied = ctx.assertMissionMemberOrSupervisor();
		if (denied) {
			return { handled: true, error: denied };
		}
		const callerAgentId = caller.isHumanUser
			? undefined
			: (caller.callerSessionId || '__unbound_headless_caller__');
		const whiteboards = ctx.buildMergedWhiteboards();
		const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
		const taskGraph = mermaidText.trim() ? parseMissionMermaidDag(mermaidText) : undefined;
		const taskStatuses = record.taskStatuses as Readonly<Record<string, IMissionTaskStatusRecord>> | undefined;
		const now = Date.now();

		const applyHeadlessCompleteTaskIfRequested = (
			tok: IOrchestrationToken | undefined,
			extraTaskIds: readonly string[],
			noteSummary: string,
			checkReceiptsByTaskId: ReadonlyMap<string, IMissionTaskCheckReceipt>,
			modifiedFiles?: readonly string[],
			inlineArtifacts?: readonly IOrchestrationContextBlobInput[],
			inlineDecisions?: readonly IOrchestrationContextBlobInput[],
			inlineRefPtrs?: readonly string[],
		): { readonly ok: true; readonly completedTaskIds: readonly string[]; readonly nextStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>> } | { readonly ok: false; readonly error: string } => {
			if (params.completeTask !== true) {
				return { ok: true, completedTaskIds: [] };
			}
			const targetIds = [...new Set([
				...extraTaskIds,
				...(tok?.taskNodeId ? [tok.taskNodeId] : []),
				...(tok?.taskNodeIds ?? []),
			].map(s => s.trim()).filter(Boolean))];
			if (targetIds.length === 0) {
				return { ok: true, completedTaskIds: [] };
			}
			if (!taskGraph || taskGraph.error || taskGraph.nodes.length === 0) {
				return { ok: false, error: `Cannot complete bound task(s) (${targetIds.join(', ')}): Mission Task DAG is missing or invalid.` };
			}
			let working: Readonly<Record<string, IMissionTaskStatusRecord>> = taskStatuses ?? {};
			const completedIds: string[] = [];
			const effectiveNodeId = tok?.nodeId ?? caller.callerNodeId;
			const staff = effectiveNodeId ? parsedGraph.nodes.find(n => n.id === effectiveNodeId && n.kind === 'staff') : undefined;
			const effectiveTier = caller.callerTier ?? resolveEffectiveStaffTier(staff, effectiveOrgConfig);
			const tokenArtifacts = [
				...(tok?.contextRefs ?? []).filter(r => r.kind === 'artifact' || r.kind === 'decision').map(r => r.ptr),
				...(inlineArtifacts ?? []).map((a, i) => `inline:art-${i}:${a.title || 'artifact'}`),
				...(inlineDecisions ?? []).map((d, i) => `inline:dec-${i}:${d.title || 'decision'}`),
				...(inlineRefPtrs ?? []).filter(p => /^(?:art|dec)-/i.test(p)),
			];
			for (const tid of targetIds) {
				if (working[tid]?.status === 'completed') {
					continue;
				}
				const hasChecks = (ctx.collectEffectiveNodeChecks(tid)[tid]?.filter(c => c.enabled !== false).length ?? 0) > 0;
				const receipt = checkReceiptsByTaskId.get(tid) ?? working[tid]?.lastCheckReceipt;
				const trans = updateMissionTaskNodeStatus(working, taskGraph, effectiveOrgConfig, {
					nodeId: tid,
					status: 'completed',
					caller: {
						isHumanUser: caller.isHumanUser,
						isSecretary: caller.isSecretary,
						callerTier: effectiveTier,
						callerSessionId: caller.callerSessionId,
						callerLabel: staff?.label,
						callerNodeId: effectiveNodeId,
					},
					orchGraph: !parsedGraph.error ? parsedGraph : undefined,
					whiteboards,
					hasConfiguredChecks: hasChecks,
					...(receipt ? { checkReceipt: receipt } : {}),
					...(tokenArtifacts.length > 0 ? { artifactPtrs: tokenArtifacts } : {}),
					...(modifiedFiles && modifiedFiles.length > 0 ? { touchedFiles: modifiedFiles } : {}),
					force: params.force === true,
					note: noteSummary,
					now,
				});
				if (!trans.ok) {
					return { ok: false, error: trans.error ?? `Cannot mark task "${tid}" completed.` };
				}
				working = trans.taskStatuses;
				completedIds.push(tid);
			}
			return { ok: true, completedTaskIds: completedIds, nextStatuses: completedIds.length > 0 ? working : undefined };
		};

		if (action === 'token.return') {
			const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
			const summary = String(params.summary ?? params.message ?? '').trim();
			const taskNodeId = typeof (params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode) === 'string' && String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
				? String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
				: undefined;
			const taskNodeIds = parseStrList(params.taskNodeIds ?? params.taskIds ?? params.tasks);
			const modifiedFiles = parseStrList(params.touchedFiles ?? params.modifiedFiles ?? params.files);
			const inlineArtifacts = parseBlobList(params.artifacts);
			const inlineDecisions = parseBlobList(params.decisions);
			const inlineRefPtrs = parseStrList(params.refPtrs ?? params.refs ?? params.ref);
			const evidenceText = typeof (params.evidence ?? params.evidenceSummary) === 'string' && String(params.evidence ?? params.evidenceSummary).trim()
				? String(params.evidence ?? params.evidenceSummary).trim()
				: '';
			const noteForTask = summary || evidenceText;
			const tok = orch.tokens[tokenId];
			if (tok && (tok.status === 'active' || tok.status === 'blocked')) {
				// Security: verify token holder BEFORE running checks or `--complete-task`!
				const holderCheck = assertOrchestrationTokenHolder(orch, parsedGraph, tok, callerAgentId);
				if (!holderCheck.ok) {
					return { handled: true, error: holderCheck.error ?? `FORBIDDEN: caller does not hold token "${tokenId}".` };
				}
			}
			const checkReceipts = new Map<string, IMissionTaskCheckReceipt>();
			if (tok && (tok.status === 'active' || tok.status === 'blocked')) {
				const extraTaskIds = [...new Set([
					...(tok.taskNodeId ? [tok.taskNodeId] : []),
					...(tok.taskNodeIds ?? []),
					...(taskNodeId ? [taskNodeId] : []),
					...(taskNodeIds ?? []),
				])];
				const checkRes = await host.runHeadlessOrchestrationChecksIfNeeded(
					record,
					parsedGraph,
					taskGraph,
					tok.nodeId,
					extraTaskIds,
					params.skipChecks === true,
					caller.isHumanUser,
					tok.id,
				);
				if (checkRes.receipt) {
					for (const tid of extraTaskIds) {
						checkReceipts.set(tid, checkRes.receipt);
					}
				}
				if (!checkRes.ok) {
					if (checkRes.receipt && extraTaskIds.length > 0) {
						let updatedStatuses = record.taskStatuses as Readonly<Record<string, IMissionTaskStatusRecord>> | undefined;
						for (const tid of extraTaskIds) {
							updatedStatuses = recordMissionTaskCheckReceipt(updatedStatuses, tid, checkRes.receipt);
						}
						record.taskStatuses = updatedStatuses;
						await ctx.saveCurrentRecord(now);
					}
					return { handled: true, error: checkRes.error };
				}
			}
			const completePre = applyHeadlessCompleteTaskIfRequested(
				tok,
				[...(taskNodeId ? [taskNodeId] : []), ...(taskNodeIds ?? [])],
				noteForTask,
				checkReceipts,
				modifiedFiles,
				inlineArtifacts,
				inlineDecisions,
				inlineRefPtrs,
			);
			if (!completePre.ok) {
				return { handled: true, error: completePre.error };
			}
			const effectiveStatuses = completePre.nextStatuses ?? taskStatuses;
			const res = returnOrchestrationToken(orch, parsedGraph, whiteboards, effectiveOrgConfig, {
				tokenId,
				toNodeId: typeof (params.toNodeId ?? params.to ?? params.target) === 'string' ? String(params.toNodeId ?? params.to ?? params.target).trim() : undefined,
				summary,
				detail: typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined,
				...(taskNodeId ? { taskNodeId } : {}),
				...(taskNodeIds && taskNodeIds.length > 0 ? { taskNodeIds } : {}),
				...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses: effectiveStatuses } : {}),
				whiteboardIds: parseStrList(params.whiteboardIds ?? params.whiteboards ?? params.whiteboard),
				artifacts: inlineArtifacts,
				decisions: inlineDecisions,
				refPtrs: inlineRefPtrs,
				modifiedFiles,
				callerAgentId,
				now,
			});
			if (!res.ok) {
				if (res.code === 'MAX_HOPS_EXCEEDED') {
					await ctx.persistHeadlessOrchState(res.state, res.effects, now);
				}
				return { handled: true, error: res.error ?? `Failed to return token ${tokenId}.` };
			}
			if (completePre.nextStatuses) {
				record.taskStatuses = completePre.nextStatuses;
			}
			await ctx.persistHeadlessOrchState(res.state, res.effects, now);
			return {
				handled: true,
				result: {
					headless: true,
					ok: true,
					missionId,
					queuedEffects: res.effects.length,
					...(res.data as Record<string, unknown> ?? {}),
					...(completePre.completedTaskIds.length > 0 ? { completedTaskIds: completePre.completedTaskIds } : {}),
				},
			};
		}

		if (action === 'token.handoff') {
			const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
			const summary = String(params.summary ?? params.message ?? '').trim();
			const toNodeIds = parseStrList(params.toNodeIds ?? params.to ?? params.target ?? params.targets) ?? [];
			const tok = orch.tokens[tokenId];
			if (tok && (tok.status === 'active' || tok.status === 'blocked')) {
				const holderCheck = assertOrchestrationTokenHolder(orch, parsedGraph, tok, callerAgentId);
				if (!holderCheck.ok) {
					return { handled: true, error: holderCheck.error ?? `FORBIDDEN: caller does not hold token "${tokenId}".` };
				}
				const fromNode = parsedGraph.nodes.find(n => n.id === tok.nodeId && n.kind === 'staff');
				const fromTier = resolveEffectiveStaffTier(fromNode, effectiveOrgConfig);
				const isPureDownward = toNodeIds.length > 0 && toNodeIds.every(tid => {
					const targetNode = parsedGraph.nodes.find(n => n.id === tid && n.kind === 'staff');
					const targetTier = resolveEffectiveStaffTier(targetNode, effectiveOrgConfig);
					return fromTier !== undefined && targetTier !== undefined && targetTier > fromTier;
				});
				if (!isPureDownward) {
					const extraTaskIds = [...(tok.taskNodeId ? [tok.taskNodeId] : []), ...(tok.taskNodeIds ?? [])];
					const checkRes = await host.runHeadlessOrchestrationChecksIfNeeded(
						record,
						parsedGraph,
						taskGraph,
						tok.nodeId,
						extraTaskIds,
						params.skipChecks === true,
						caller.isHumanUser,
						tok.id,
					);
					if (!checkRes.ok) {
						return { handled: true, error: checkRes.error };
					}
				}
			}
			const res = handoffOrchestrationToken(orch, parsedGraph, whiteboards, effectiveOrgConfig, {
				tokenId,
				toNodeIds,
				summary,
				detail: typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined,
				taskNodeId: typeof (params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode) === 'string' ? String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim() : undefined,
				taskNodeIds: parseStrList(params.taskNodeIds ?? params.taskIds ?? params.tasks),
				...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses } : {}),
				whiteboardIds: parseStrList(params.whiteboardIds ?? params.whiteboards ?? params.whiteboard),
				artifacts: parseBlobList(params.artifacts),
				decisions: parseBlobList(params.decisions),
				refPtrs: parseStrList(params.refPtrs ?? params.refs ?? params.ref),
				modifiedFiles: parseStrList(params.modifiedFiles ?? params.files),
				callerAgentId,
				now,
			});
			if (!res.ok) {
				if (res.code === 'MAX_HOPS_EXCEEDED') {
					await ctx.persistHeadlessOrchState(res.state, res.effects, now);
				}
				return { handled: true, error: res.error ?? `Failed to hand off token ${tokenId}.` };
			}
			await ctx.persistHeadlessOrchState(res.state, res.effects, now);
			return { handled: true, result: { headless: true, ok: true, missionId, queuedEffects: res.effects.length, ...(res.data as Record<string, unknown> ?? {}) } };
		}

		if (action === 'token.complete') {
			const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
			const summary = String(params.summary ?? params.message ?? '').trim();
			const toNodeIds = parseStrList(params.toNodeIds ?? params.to ?? params.target);
			const completeTaskNodeId = typeof (params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode) === 'string' && String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
				? String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
				: undefined;
			const completeTaskNodeIds = parseStrList(params.taskNodeIds ?? params.taskIds ?? params.tasks);
			const modifiedFiles = parseStrList(params.touchedFiles ?? params.modifiedFiles ?? params.files);
			const inlineArtifacts = parseBlobList(params.artifacts);
			const inlineDecisions = parseBlobList(params.decisions);
			const inlineRefPtrs = parseStrList(params.refPtrs ?? params.refs ?? params.ref);
			const evidenceText = typeof (params.evidence ?? params.evidenceSummary) === 'string' && String(params.evidence ?? params.evidenceSummary).trim()
				? String(params.evidence ?? params.evidenceSummary).trim()
				: '';
			const noteForTask = summary || evidenceText;
			const tok = orch.tokens[tokenId];
			if (tok && (tok.status === 'active' || tok.status === 'blocked')) {
				const holderCheck = assertOrchestrationTokenHolder(orch, parsedGraph, tok, callerAgentId);
				if (!holderCheck.ok) {
					return { handled: true, error: holderCheck.error ?? `FORBIDDEN: caller does not hold token "${tokenId}".` };
				}
			}
			const checkReceipts = new Map<string, IMissionTaskCheckReceipt>();
			if (tok && (tok.status === 'active' || tok.status === 'blocked')) {
				const fromNode = parsedGraph.nodes.find(n => n.id === tok.nodeId && n.kind === 'staff');
				const fromTier = resolveEffectiveStaffTier(fromNode, effectiveOrgConfig);
				const isPureDownward = params.finish !== true && Boolean(toNodeIds && toNodeIds.length > 0) && toNodeIds!.every(tid => {
					const targetNode = parsedGraph.nodes.find(n => n.id === tid && n.kind === 'staff');
					const targetTier = resolveEffectiveStaffTier(targetNode, effectiveOrgConfig);
					return fromTier !== undefined && targetTier !== undefined && targetTier > fromTier;
				});
				if (!isPureDownward) {
					const extraTaskIds = [...new Set([
						...(tok.taskNodeId ? [tok.taskNodeId] : []),
						...(tok.taskNodeIds ?? []),
						...(completeTaskNodeId ? [completeTaskNodeId] : []),
						...(completeTaskNodeIds ?? []),
					])];
					const checkRes = await host.runHeadlessOrchestrationChecksIfNeeded(
						record,
						parsedGraph,
						taskGraph,
						tok.nodeId,
						extraTaskIds,
						params.skipChecks === true,
						caller.isHumanUser,
						tok.id,
					);
					if (checkRes.receipt) {
						for (const tid of extraTaskIds) {
							checkReceipts.set(tid, checkRes.receipt);
						}
					}
					if (!checkRes.ok) {
						if (checkRes.receipt && extraTaskIds.length > 0) {
							let updatedStatuses = record.taskStatuses as Readonly<Record<string, IMissionTaskStatusRecord>> | undefined;
							for (const tid of extraTaskIds) {
								updatedStatuses = recordMissionTaskCheckReceipt(updatedStatuses, tid, checkRes.receipt);
							}
							record.taskStatuses = updatedStatuses;
							await ctx.saveCurrentRecord(now);
						}
						return { handled: true, error: checkRes.error };
					}
				}
			}
			const completePre = applyHeadlessCompleteTaskIfRequested(
				tok,
				[...(completeTaskNodeId ? [completeTaskNodeId] : []), ...(completeTaskNodeIds ?? [])],
				noteForTask,
				checkReceipts,
				modifiedFiles,
				inlineArtifacts,
				inlineDecisions,
				inlineRefPtrs,
			);
			if (!completePre.ok) {
				return { handled: true, error: completePre.error };
			}
			const effectiveStatuses = completePre.nextStatuses ?? taskStatuses;
			const res = completeOrchestrationToken(orch, parsedGraph, whiteboards, effectiveOrgConfig, {
				tokenId,
				summary,
				detail: typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined,
				toNodeIds,
				taskNodeId: completeTaskNodeId,
				taskNodeIds: completeTaskNodeIds,
				...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses: effectiveStatuses } : {}),
				whiteboardIds: parseStrList(params.whiteboardIds ?? params.whiteboards ?? params.whiteboard),
				artifacts: inlineArtifacts,
				decisions: inlineDecisions,
				refPtrs: inlineRefPtrs,
				modifiedFiles,
				finish: params.finish === true,
				...(params.force === true ? { force: true } : {}),
				isHumanUser: caller.isHumanUser,
				callerAgentId,
				now,
			});
			if (!res.ok) {
				if (res.code === 'MAX_HOPS_EXCEEDED') {
					await ctx.persistHeadlessOrchState(res.state, res.effects, now);
				}
				return { handled: true, error: res.error ?? `Failed to complete token ${tokenId}.` };
			}
			if (completePre.nextStatuses) {
				record.taskStatuses = completePre.nextStatuses;
			}
			await ctx.persistHeadlessOrchState(res.state, res.effects, now);
			return {
				handled: true,
				result: {
					headless: true,
					ok: true,
					missionId,
					queuedEffects: res.effects.length,
					...(res.data as Record<string, unknown> ?? {}),
					...(completePre.completedTaskIds.length > 0 ? { completedTaskIds: completePre.completedTaskIds } : {}),
				},
			};
		}

		if (action === 'token.block') {
			const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
			const maxDurationMs = parseDurationMs((params.maxDuration ?? params.max ?? params.duration) as string | number);
			if (!maxDurationMs) {
				return { handled: true, error: 'Valid --duration (e.g. "30m", "2h") is required for token.block.' };
			}
			const rawPid = params.watchPid ?? params.pid;
			let watchPid: number | undefined;
			if (rawPid !== undefined && rawPid !== null && String(rawPid).trim() !== '') {
				watchPid = parseStrictPositiveInt(rawPid);
				if (watchPid === undefined) {
					return { handled: true, error: `Invalid --watch-pid "${String(rawPid)}": must be a positive integer PID.` };
				}
			}
			const watchFile = typeof (params.watchFile ?? params.file) === 'string' ? String(params.watchFile ?? params.file).trim() : undefined;
			const tok = orch.tokens[tokenId];
			const staffNode = tok ? parsedGraph.nodes.find(n => n.id === tok.nodeId && n.kind === 'staff') : undefined;
			const hostAlias = (typeof (params.host ?? params.hostAlias) === 'string' && String(params.host ?? params.hostAlias).trim())
				|| staffNode?.hostAlias
				|| undefined;
			let initialFileMtime: number | null | undefined;
			let initialFileSignature: string | null | undefined;
			if (watchFile) {
				const effectiveHost = hostAlias || 'local';
				initialFileMtime = await host.probeFileMtime(effectiveHost, watchFile);
				initialFileSignature = await host.probeFileSignature(effectiveHost, watchFile);
			}
			const res = blockOrchestrationToken(orch, {
				tokenId,
				reason: String(params.reason ?? params.message ?? '').trim() || 'Long-running task in progress',
				maxDurationMs,
				...(watchPid !== undefined ? { watchPid } : {}),
				...(watchFile ? { watchFile, initialFileMtime } : {}),
				...(hostAlias ? { hostAlias } : {}),
				callerAgentId,
				now,
			});
			if (!res.ok) { return { handled: true, error: res.error ?? `Failed to block token ${tokenId}.` }; }
			let nextState = res.state;
			const updatedTok = nextState.tokens[tokenId];
			if (watchFile && updatedTok?.blocked && initialFileSignature !== undefined) {
				const blockedWithSig = Object.assign({}, updatedTok.blocked, { initialFileSignature });
				nextState = {
					...nextState,
					tokens: {
						...nextState.tokens,
						[tokenId]: { ...updatedTok, blocked: blockedWithSig },
					},
				};
			}
			await ctx.persistHeadlessOrchState(nextState, res.effects, now);
			return { handled: true, result: { headless: true, ok: true, missionId, token: nextState.tokens[tokenId] } };
		}

		if (action === 'token.reject') {
			const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
			const reason = String(params.reason ?? params.feedback ?? params.message ?? params.summary ?? '').trim();
			const targetNodeIds = parseStrList(params.targetNodeIds ?? params.targets ?? params.target ?? params.targetNode ?? params.targetNodeId ?? params.to);
			const waitJoin = params.waitJoin !== undefined ? params.waitJoin === true : (params.noWaitJoin === true ? false : undefined);
			const rawCategory = typeof (params.category ?? params.reworkCategory) === 'string'
				? String(params.category ?? params.reworkCategory).trim().toLowerCase()
				: undefined;
			const validCategories = new Set(['defect', 'spec', 'test', 'env', 'scope', 'security', 'other']);
			if (rawCategory && !validCategories.has(rawCategory)) {
				return { handled: true, error: `Invalid rework --category "${rawCategory}". Valid values: defect, spec, test, env, scope, security, other.` };
			}
			const category = rawCategory ? (rawCategory as OrchestrationReworkCategory) : undefined;
			const res = rejectOrchestrationToken(orch, parsedGraph, whiteboards, effectiveOrgConfig, {
				tokenId,
				reason,
				detail: typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined,
				...(category ? { category } : {}),
				...(targetNodeIds?.[0] ? { targetNodeId: targetNodeIds[0] } : {}),
				...(targetNodeIds && targetNodeIds.length > 0 ? { targetNodeIds } : {}),
				whiteboardIds: parseStrList(params.whiteboardIds ?? params.whiteboards ?? params.whiteboard),
				artifacts: parseBlobList(params.artifacts),
				decisions: parseBlobList(params.decisions),
				refPtrs: parseStrList(params.refPtrs ?? params.refs ?? params.ref),
				...(waitJoin !== undefined ? { waitJoin } : {}),
				callerAgentId,
				now,
			});
			if (!res.ok) {
				if (res.code === 'MAX_HOPS_EXCEEDED') {
					await ctx.persistHeadlessOrchState(res.state, res.effects, now);
				}
				return { handled: true, error: res.error ?? `Failed to reject token ${tokenId}.` };
			}
			await ctx.persistHeadlessOrchState(res.state, res.effects, now);
			return { handled: true, result: { headless: true, ok: true, missionId, queuedEffects: res.effects.length, ...(res.data as Record<string, unknown> ?? {}) } };
		}

		if (action === 'token.fail') {
			const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
			const reason = String(params.reason ?? params.message ?? '').trim();
			const rawFailCat = typeof (params.category ?? params.reworkCategory) === 'string'
				? String(params.category ?? params.reworkCategory).trim().toLowerCase()
				: undefined;
			const validCategories = new Set(['defect', 'spec', 'test', 'env', 'scope', 'security', 'other']);
			if (rawFailCat && !validCategories.has(rawFailCat)) {
				return { handled: true, error: `Invalid rework --category "${rawFailCat}". Valid values: defect, spec, test, env, scope, security, other.` };
			}
			const failCategory = rawFailCat ? (rawFailCat as OrchestrationReworkCategory) : undefined;
			const res = failOrchestrationToken(orch, parsedGraph, whiteboards, effectiveOrgConfig, {
				tokenId,
				reason,
				detail: typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined,
				...(failCategory ? { category: failCategory } : {}),
				callerAgentId,
				now,
			});
			if (!res.ok) { return { handled: true, error: res.error ?? `Failed to report failure on token ${tokenId}.` }; }
			await ctx.persistHeadlessOrchState(res.state, res.effects, now);
			return { handled: true, result: { headless: true, ok: true, missionId, queuedEffects: res.effects.length, ...(res.data as Record<string, unknown> ?? {}) } };
		}

		if (action === 'token.retry') {
			const tokenId = typeof (params.tokenId ?? params.token) === 'string' && String(params.tokenId ?? params.token).trim() ? String(params.tokenId ?? params.token).trim() : undefined;
			const nodeId = typeof (params.node ?? params.nodeId) === 'string' && String(params.node ?? params.nodeId).trim() ? String(params.node ?? params.nodeId).trim() : undefined;
			const guidance = typeof (params.guidance ?? params.reason ?? params.message ?? params.note) === 'string' ? String(params.guidance ?? params.reason ?? params.message ?? params.note).trim() : undefined;
			const waitJoin = params.waitJoin !== undefined ? params.waitJoin === true : (params.noWaitJoin === true ? false : undefined);
			const res = retryOrchestrationToken(orch, parsedGraph, whiteboards, effectiveOrgConfig, {
				...(tokenId ? { tokenId } : {}),
				...(nodeId ? { nodeId } : {}),
				...(guidance ? { guidance } : {}),
				...(waitJoin !== undefined ? { waitJoin } : {}),
				caller: {
					isHumanUser: caller.isHumanUser,
					isSecretary: caller.isSecretary,
					...(caller.callerTier !== undefined ? { callerTier: caller.callerTier } : {}),
					...(caller.callerNodeId ? { callerNodeId: caller.callerNodeId } : {}),
					...(caller.callerSessionId ? { callerAgentId: caller.callerSessionId } : {}),
				},
				now,
			});
			if (!res.ok) {
				if (res.code === 'MAX_HOPS_EXCEEDED') {
					await ctx.persistHeadlessOrchState(res.state, res.effects, now);
				}
				return { handled: true, error: res.error ?? 'Failed to retry token.' };
			}
			await ctx.persistHeadlessOrchState(res.state, res.effects, now);
			return { handled: true, result: { headless: true, ok: true, missionId, queuedEffects: res.effects.length, ...(res.data as Record<string, unknown> ?? {}) } };
		}

		// token.mint / token.split
		const rawParent = String(params.parentTokenId ?? params.tokenId ?? params.token ?? params.id ?? '').trim();
		const parentTokenId = (!rawParent || rawParent.toLowerCase() === 'root' || rawParent.toLowerCase() === 'new') ? undefined : rawParent;
		let rawBranches: unknown = params.branches;
		if (!rawBranches && typeof params.branchesJson === 'string' && params.branchesJson.trim()) {
			try { rawBranches = JSON.parse(params.branchesJson); } catch (err) {
				return { handled: true, error: `Invalid --branches-json payload: ${err instanceof Error ? err.message : String(err)}` };
			}
		}
		const branches: IOrchestrationMintBranch[] = [];
		if (Array.isArray(rawBranches) && rawBranches.length > 0) {
			for (const item of rawBranches) {
				if (!item || typeof item !== 'object') { continue; }
				const b = item as Record<string, unknown>;
				const scopePaths = parseStrList(b.scopePaths ?? b.scope);
				branches.push({
					toNodeId: String(b.toNodeId ?? b.to ?? b.target ?? '').trim(),
					summary: String(b.summary ?? b.message ?? '').trim(),
					...(typeof b.detail === 'string' && b.detail.trim() ? { detail: b.detail } : {}),
					...(typeof (b.taskNodeId ?? b.taskId ?? b.task) === 'string' && String(b.taskNodeId ?? b.taskId ?? b.task).trim() ? { taskNodeId: String(b.taskNodeId ?? b.taskId ?? b.task).trim() } : {}),
					...(parseStrList(b.taskNodeIds ?? b.taskIds ?? b.tasks) ? { taskNodeIds: parseStrList(b.taskNodeIds ?? b.taskIds ?? b.tasks) } : {}),
					...(scopePaths ? { scopePaths } : {}),
					...(parseStrList(b.whiteboardIds ?? b.whiteboards ?? b.whiteboard) ? { whiteboardIds: parseStrList(b.whiteboardIds ?? b.whiteboards ?? b.whiteboard) } : {}),
					...(parseBlobList(b.artifacts) ? { artifacts: parseBlobList(b.artifacts) } : {}),
					...(parseBlobList(b.decisions) ? { decisions: parseBlobList(b.decisions) } : {}),
					...(parseStrList(b.refPtrs ?? b.refs ?? b.ref) ? { refPtrs: parseStrList(b.refPtrs ?? b.refs ?? b.ref) } : {}),
				});
			}
		} else {
			const targets = parseStrList(params.toNodeIds ?? params.to ?? params.target) ?? [];
			const summary = String(params.summary ?? params.message ?? '').trim();
			const scopePaths = parseStrList(params.scopePaths ?? params.scope);
			for (const toNodeId of targets) {
				branches.push({
					toNodeId,
					summary,
					...(typeof params.detail === 'string' && params.detail.trim() ? { detail: params.detail } : {}),
					...(typeof (params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode) === 'string' && String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim() ? { taskNodeId: String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim() } : {}),
					...(parseStrList(params.taskNodeIds ?? params.taskIds ?? params.tasks) ? { taskNodeIds: parseStrList(params.taskNodeIds ?? params.taskIds ?? params.tasks) } : {}),
					...(scopePaths ? { scopePaths } : {}),
					...(parseStrList(params.whiteboardIds ?? params.whiteboards ?? params.whiteboard) ? { whiteboardIds: parseStrList(params.whiteboardIds ?? params.whiteboards ?? params.whiteboard) } : {}),
					...(parseBlobList(params.artifacts) ? { artifacts: parseBlobList(params.artifacts) } : {}),
					...(parseBlobList(params.decisions) ? { decisions: parseBlobList(params.decisions) } : {}),
					...(parseStrList(params.refPtrs ?? params.refs ?? params.ref) ? { refPtrs: parseStrList(params.refPtrs ?? params.refs ?? params.ref) } : {}),
				});
			}
		}
		const waitJoin = params.waitJoin !== undefined ? params.waitJoin === true : (action === 'token.split' && params.noWaitJoin !== true);
		const fromNodeId = typeof (params.fromNodeId ?? params.from ?? params.origin) === 'string' && String(params.fromNodeId ?? params.from ?? params.origin).trim()
			? String(params.fromNodeId ?? params.from ?? params.origin).trim()
			: undefined;
		const waveSummary = typeof params.waveSummary === 'string' && params.waveSummary.trim() ? params.waveSummary.trim() : undefined;
		const parsedBarrier = parseJoinBarrierOptions(params, now);
		if (!parsedBarrier.ok) {
			return { handled: true, error: parsedBarrier.error };
		}
		const res = mintOrchestrationTokens(orch, parsedGraph, whiteboards, effectiveOrgConfig, {
			...(parentTokenId ? { parentTokenId } : {}),
			...(fromNodeId ? { fromNodeId } : {}),
			...(waveSummary ? { waveSummary } : {}),
			branches,
			waitJoin,
			joinMode: parsedBarrier.joinMode,
			...(parsedBarrier.quorumCount !== undefined ? { quorumCount: parsedBarrier.quorumCount } : {}),
			...(parsedBarrier.failFast ? { failFast: true } : {}),
			...(parsedBarrier.deadlineAt !== undefined ? { deadlineAt: parsedBarrier.deadlineAt } : {}),
			...(parsedBarrier.conflictPolicy ? { conflictPolicy: parsedBarrier.conflictPolicy as OrchestrationScopeConflictPolicy } : {}),
			...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses } : {}),
			isHumanUser: caller.isHumanUser,
			isSecretary: caller.isSecretary,
			callerAgentId,
			now,
		});
		if (!res.ok) {
			if (res.code === 'MAX_HOPS_EXCEEDED') {
				await ctx.persistHeadlessOrchState(res.state, res.effects, now);
			}
			return { handled: true, error: res.error ?? 'Failed to mint Orchestration tokens.' };
		}
		await ctx.persistHeadlessOrchState(res.state, res.effects, now);
		const mintData = (res.data as Record<string, unknown> | undefined) ?? {};
		return {
			handled: true,
			result: {
				headless: true,
				ok: true,
				missionId,
				queuedEffects: res.effects.length,
				...mintData,
				...(mintData.joinBarrierId ? { nextAction: 'STOP_TURN_NOW' } : {}),
			},
		};
	}

	// Read-only `orchestration.limits` is allowed for any bound Mission member (`#93` §2)!
	if (action === 'orchestration.limits') {
		const memberDenied = ctx.assertMissionMemberOrSupervisor();
		if (memberDenied) {
			return { handled: true, error: memberDenied };
		}
		const preLimits = parseOrchestrationLimitsRequest(params, { isHumanUser: caller.isHumanUser });
		if (preLimits.ok && preLimits.isReadOnlyQuery) {
			const baseOrch = orch ?? createInitialOrchestrationRuntimeState(
				missionId,
				parsedGraph.nodes.filter(n => n.kind === 'staff').map(n => n.id),
				Date.now(),
			);
			return {
				handled: true,
				result: {
					headless: true,
					ok: true,
					missionId,
					status: baseOrch.status ?? 'running',
					maxHops: baseOrch.maxHops ?? DEFAULT_ORCHESTRATION_MAX_HOPS,
					...(baseOrch.budgetLimitUsd !== undefined ? { budgetLimitUsd: baseOrch.budgetLimitUsd } : {}),
					totalCostUsd: baseOrch.totalCostUsd ?? 0,
					budgetCircuitTripped: Boolean(baseOrch.budgetCircuitTripped),
					silenceReminderMinutes: baseOrch.silenceReminderMinutes,
				},
			};
		}
	}

	// Strictly authorize dispatch / mutating limits / budget / pause / resume / abort in headless daemon mode!
	const isMember = ctx.isMissionMember(caller);
	const ownerSessionId = typeof record.ownerSessionId === 'string' ? record.ownerSessionId.trim() : '';
	const highestTier = effectiveOrgConfig.ranks.length > 0 ? Math.min(...effectiveOrgConfig.ranks.map(r => r.tier)) : 1;
	const isAuthorizedForRunControl = Boolean(
		caller.isHumanUser
		|| caller.isSecretary
		|| (ownerSessionId && caller.callerSessionId === ownerSessionId)
		|| (isMember && caller.callerTier !== undefined && caller.callerTier <= highestTier),
	);
	if (!isAuthorizedForRunControl) {
		return {
			handled: true,
			error: `FORBIDDEN: only Human User (L-1), Secretary (L0), the Mission owner, or highest-rank member (L${highestTier}) of Mission "${missionId}" may invoke "${action}".`,
		};
	}

	const now = Date.now();
	if (action === 'orchestration.dispatch') {
		const prompt = String(params.prompt ?? params.message ?? params.text ?? '').trim();
		if (!prompt) {
			return { handled: true, error: 'Prompt (--prompt) is required for orchestration.dispatch.' };
		}
		const baseOrch = orch ?? createInitialOrchestrationRuntimeState(
			missionId,
			parsedGraph.nodes.filter(n => n.kind === 'staff').map(n => n.id),
			now,
		);
		const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
		const taskGraph = mermaidText.trim() ? parseMissionMermaidDag(mermaidText) : undefined;
		const taskStatuses = record.taskStatuses as Readonly<Record<string, IMissionTaskStatusRecord>> | undefined;
		const res = dispatchRequirementToOrchestration(baseOrch, parsedGraph, ctx.buildMergedWhiteboards(), effectiveOrgConfig, {
			prompt,
			detail: typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined,
			targetNodeId: typeof (params.targetNodeId ?? params.target ?? params.to ?? params.node) === 'string' ? String(params.targetNodeId ?? params.target ?? params.to ?? params.node).trim() : undefined,
			taskNodeId: typeof (params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode) === 'string' ? String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim() : undefined,
			taskNodeIds: parseStrList(params.taskNodeIds ?? params.taskIds ?? params.tasks),
			...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses } : {}),
			whiteboardIds: parseStrList(params.whiteboardIds ?? params.whiteboards ?? params.whiteboard),
			artifacts: parseBlobList(params.artifacts),
			decisions: parseBlobList(params.decisions),
			refPtrs: parseStrList(params.refPtrs ?? params.refs ?? params.ref),
			now,
		});
		if (!res.ok) {
			return { handled: true, error: res.error ?? 'Failed to dispatch Orchestration requirement.' };
		}
		await ctx.persistHeadlessOrchState(res.state, res.effects, now);
		return {
			handled: true,
			result: { headless: true, ok: true, missionId, queuedEffects: res.effects.length, ...(res.data as Record<string, unknown> ?? {}) },
		};
	}

	if (action === 'orchestration.limits' || action === 'mission.budget.set') {
		const baseOrch = orch ?? createInitialOrchestrationRuntimeState(
			missionId,
			parsedGraph.nodes.filter(n => n.kind === 'staff').map(n => n.id),
			now,
		);
		const normalizedLimitsParams: Record<string, unknown> = {
			...params,
			...(params.budgetLimitUsd === undefined && (params.budget !== undefined || params.limitUsd !== undefined || params.limit !== undefined)
				? { budgetLimitUsd: params.budget ?? params.limitUsd ?? params.limit }
				: {}),
		};
		const parsedLimits = parseOrchestrationLimitsRequest(normalizedLimitsParams, { isHumanUser: caller.isHumanUser });
		if (!parsedLimits.ok) {
			return { handled: true, error: parsedLimits.error ?? 'Invalid limits parameters.' };
		}
		if (parsedLimits.isReadOnlyQuery) {
			return {
				handled: true,
				result: {
					headless: true,
					ok: true,
					missionId,
					status: baseOrch.status ?? 'running',
					maxHops: baseOrch.maxHops ?? DEFAULT_ORCHESTRATION_MAX_HOPS,
					...(baseOrch.budgetLimitUsd !== undefined ? { budgetLimitUsd: baseOrch.budgetLimitUsd } : {}),
					totalCostUsd: baseOrch.totalCostUsd ?? 0,
					budgetCircuitTripped: Boolean(baseOrch.budgetCircuitTripped),
					silenceReminderMinutes: baseOrch.silenceReminderMinutes,
				},
			};
		}
		const budgetLimitUsd = parsedLimits.clearBudgetLimit ? null : parsedLimits.budgetLimitUsd;
		const maxHopsParam = parsedLimits.clearMaxHops ? null : parsedLimits.maxHops;
		const guard = setOrchestrationGuardrails(baseOrch, {
			...(maxHopsParam !== undefined ? { maxHops: maxHopsParam } : {}),
			...(budgetLimitUsd !== undefined ? { budgetLimitUsd } : {}),
			...(parsedLimits.totalCostUsd !== undefined ? { totalCostUsd: parsedLimits.totalCostUsd } : {}),
			now,
		});
		const nextOrchState = parsedLimits.silenceReminderMinutes !== undefined
			? { ...guard.state, silenceReminderMinutes: parsedLimits.silenceReminderMinutes }
			: guard.state;
		if (record.runtime && typeof record.runtime === 'object' && budgetLimitUsd !== undefined) {
			const legacyRuntime = record.runtime as Record<string, unknown>;
			legacyRuntime.budgetLimitUsd = nextOrchState.budgetLimitUsd;
			legacyRuntime.budgetCircuitTripped = Boolean(nextOrchState.budgetCircuitTripped);
			if (nextOrchState.budgetCircuitTripped) {
				legacyRuntime.status = 'paused';
			}
		}
		const effects: OrchestrationEngineEffect[] = guard.budgetTrippedNow
			? [{
				kind: 'post_inbox',
				missionId,
				nodeId: '',
				tokenId: '',
				title: `Budget Circuit Breaker Tripped · ${typeof record.title === 'string' ? record.title : missionId}`,
				message: nextOrchState.pausedReason ?? 'Orchestration paused after reaching FinOps budget ceiling.',
				severity: 'critical',
			}]
			: [];
		await ctx.persistHeadlessOrchState(nextOrchState, effects, now);
		return {
			handled: true,
			result: {
				headless: true,
				ok: true,
				missionId,
				status: nextOrchState.status ?? 'running',
				maxHops: nextOrchState.maxHops ?? DEFAULT_ORCHESTRATION_MAX_HOPS,
				...(nextOrchState.budgetLimitUsd !== undefined ? { budgetLimitUsd: nextOrchState.budgetLimitUsd } : {}),
				totalCostUsd: nextOrchState.totalCostUsd ?? 0,
				budgetCircuitTripped: Boolean(nextOrchState.budgetCircuitTripped),
				silenceReminderMinutes: nextOrchState.silenceReminderMinutes,
			},
		};
	}

	if (!orch) {
		return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
	}
	if (action === 'orchestration.abort') {
		await saveAutoCheckpoint(ctx, 'pre_orchestration_abort', now);
	}
	const reason = typeof params.reason === 'string' ? params.reason : undefined;
	const transition = action === 'orchestration.pause'
		? pauseOrchestration(orch, { reason, now })
		: action === 'orchestration.resume'
			? resumeOrchestration(orch, { now })
			: abortOrchestrationTokens(orch, { reason, now });

	if (!transition.ok) {
		return { handled: true, error: transition.error ?? `Failed to execute "${action}".` };
	}

	const postEffects: OrchestrationEngineEffect[] = [];
	if (action === 'orchestration.resume') {
		const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
		const taskGraph = mermaidText.trim() ? parseMissionMermaidDag(mermaidText) : undefined;
		const rawTaskStatuses = record.taskStatuses as Readonly<Record<string, IMissionTaskStatusRecord>> | undefined;
		const whiteboards = ctx.buildMergedWhiteboards();
		for (const tok of Object.values(transition.state.tokens ?? {})) {
			if (tok.status !== 'active') {
				continue;
			}
			const staffNode = parsedGraph.nodes.find(n => n.id === tok.nodeId && n.kind === 'staff');
			if (!staffNode) {
				continue;
			}
			const dispatchEffect = buildOrchestrationDispatchEffect({
				state: transition.state,
				graph: parsedGraph,
				whiteboards,
				config: effectiveOrgConfig,
				targetNode: staffNode,
				token: tok,
				holderAgentId: transition.state.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId,
				taskGraph,
				rawTaskStatuses,
			});
			if (dispatchEffect.kind === 'dispatch_token') {
				const resumeNotice = `[Orchestration Resumed · Token \`${tok.id}\`] Orchestration was resumed headlessly; continue work on staff node \`${tok.nodeId}\` immediately.`;
				postEffects.push({
					...dispatchEffect,
					prompt: `${dispatchEffect.prompt}\n\n${resumeNotice}`,
				});
			}
		}
	}

	await ctx.persistHeadlessOrchState(transition.state, postEffects, now);
	return {
		handled: true,
		result: {
			headless: true,
			ok: transition.ok,
			missionId,
			status: transition.state.status,
			queuedEffects: postEffects.length,
			...(transition.data ? transition.data as Record<string, unknown> : {}),
		},
	};
}
