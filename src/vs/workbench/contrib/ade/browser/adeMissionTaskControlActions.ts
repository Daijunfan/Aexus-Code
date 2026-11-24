/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	parseStrictMinTierParam,
	stripForeignWhiteboardBodiesFromOrchestrationText,
} from '../../../../platform/ade/common/adeControlPolicy.js';
import {
	addEdgeToMermaid,
	addNodeToMermaid,
	parseMissionMermaidDag,
	removeEdgeFromMermaid,
	removeNodeFromMermaid,
	renameNodeInMermaid,
	upsertTaskMetadataInMermaid,
} from '../../../../platform/ade/common/adeMissionDag.js';
import {
	canCallerCompleteMissionTask,
	IMissionTaskCheckReceipt,
	IOrchestrationWhiteboard,
	MissionTaskStatus,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	connectOrchestrationEdge,
	parseOrchestrationGraph,
	removeOrchestrationEdge,
	renameOrchestrationEdgeLabel,
	serializeOrchestrationGraph,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import {
	assertFullMissionControlAuthority,
	assertMissionMemberOrSupervisor,
	assertMissionTaskDesignScope,
	IAdeMissionControlContext,
	resolveMissionRecord,
} from './adeMissionControlHelpers.js';

export const ADE_MISSION_TASK_CONTROL_ACTIONS = new Set([
	'mission.task.list',
	'mission.task.get',
	'mission.task.set',
	'mission.task.create',
	'mission.task.update',
	'mission.task.remove',
	'mission.task.edge.add',
	'mission.task.edge.remove',
	'mission.task.complete',
	'mission.task.status',
	'mission.diagnostics',
	'mission.export',
	'mission.checkpoint.create',
	'mission.checkpoint.list',
	'mission.checkpoint.diff',
	'mission.checkpoint.restore',
	'orchestration.checkpoint.create',
	'orchestration.checkpoint.list',
	'orchestration.checkpoint.diff',
	'orchestration.checkpoint.restore',
	'orchestration.pause',
	'orchestration.resume',
	'orchestration.abort',
	'orchestration.edge.connect',
	'orchestration.edge.label',
	'orchestration.edge.remove',
]);

export async function executeAdeMissionTaskControlAction(
	action: string,
	params: Record<string, unknown>,
	ctx: IAdeMissionControlContext,
): Promise<unknown> {
	const runtime = ctx.missionRuntime;
	if (!runtime) {
		throw new Error('ADE Mission runtime service is not available.');
	}

	switch (action) {
		case 'mission.task.list': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const full = params.full === true || params.verbose === true;
			const parsed = parseMissionMermaidDag(mission.mermaidText);
			const tasks = parsed.nodes.map(n => {
				const st = mission.taskStatuses?.[n.id];
				const fullDesc = mission.nodePrompts?.[n.id] ?? '';
				const desc = (!full && fullDesc.length > 280)
					? `${fullDesc.slice(0, 277)}...`
					: fullDesc;
				return {
					id: n.id,
					title: n.label,
					kind: n.kind,
					description: desc,
					...(!full && fullDesc.length > 280 ? { descriptionTruncated: true, descriptionChars: fullDesc.length } : {}),
					status: st?.status ?? 'pending',
					...(n.ownerNodeId ? { ownerNodeId: n.ownerNodeId } : {}),
					...(st?.assigneeNodeId ?? n.assigneeNodeId ? { assigneeNodeId: st?.assigneeNodeId ?? n.assigneeNodeId } : {}),
					...(st?.assigneeLabel ? { assigneeLabel: st.assigneeLabel } : {}),
					...(n.department ? { department: n.department } : {}),
					...(n.minCompleterTier !== undefined ? { minCompleterTier: n.minCompleterTier } : {}),
					...(n.allowedCompleterNodeIds ? { allowedCompleterNodeIds: n.allowedCompleterNodeIds } : {}),
					...(n.completionContract ? { completionContract: n.completionContract } : {}),
					...(st?.activeTokenIds && st.activeTokenIds.length > 0 ? { activeTokenIds: st.activeTokenIds } : {}),
					...(st?.lastTokenId ? { lastTokenId: st.lastTokenId } : {}),
					...(st?.startedAt !== undefined ? { startedAt: st.startedAt } : {}),
					...(st?.durationMs !== undefined ? { durationMs: st.durationMs } : {}),
					...(st?.artifactPtrs && st.artifactPtrs.length > 0 ? { artifactPtrs: st.artifactPtrs } : {}),
					...(st?.touchedFiles && st.touchedFiles.length > 0 ? { touchedFiles: st.touchedFiles } : {}),
					...(st?.lastCheckReceipt ? { lastCheckReceipt: st.lastCheckReceipt } : {}),
					...(st?.blockedReason ? { blockedReason: st.blockedReason } : {}),
					...(st?.lastError ? { lastError: st.lastError } : {}),
					...(st?.completedBy ? { completedBy: st.completedBy } : {}),
					...(st?.completedByLabel ? { completedByLabel: st.completedByLabel } : {}),
					...(st?.completedAt !== undefined ? { completedAt: st.completedAt } : {}),
					...(st?.note ? { note: st.note } : {}),
					upstreamIds: parsed.edges.filter(e => e.to === n.id).map(e => e.from),
					downstreamIds: parsed.edges.filter(e => e.from === n.id).map(e => e.to),
				};
			});
			return { missionId: mission.id, title: mission.title, tasks, ...(parsed.error ? { error: parsed.error } : {}) };
		}

		case 'mission.task.get': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			if (!nodeId) {
				throw new Error('Task node ID (--node) is required for mission.task.get.');
			}
			const parsed = parseMissionMermaidDag(mission.mermaidText);
			const node = parsed.nodes.find(n => n.id === nodeId);
			if (!node) {
				throw new Error(`Task node "${nodeId}" not found in Mission "${mission.id}".`);
			}
			const statusRec = mission.taskStatuses?.[nodeId];
			return {
				missionId: mission.id,
				id: node.id,
				title: node.label,
				kind: node.kind,
				description: mission.nodePrompts?.[nodeId] ?? '',
				...(node.ownerNodeId ? { ownerNodeId: node.ownerNodeId } : {}),
				...(statusRec?.assigneeNodeId ?? node.assigneeNodeId ? { assigneeNodeId: statusRec?.assigneeNodeId ?? node.assigneeNodeId } : {}),
				...(node.department ? { department: node.department } : {}),
				...(node.minCompleterTier !== undefined ? { minCompleterTier: node.minCompleterTier } : {}),
				...(node.allowedCompleterNodeIds ? { allowedCompleterNodeIds: node.allowedCompleterNodeIds } : {}),
				...(node.completionContract ? { completionContract: node.completionContract } : {}),
				...(statusRec?.touchedFiles && statusRec.touchedFiles.length > 0 ? { touchedFiles: statusRec.touchedFiles } : {}),
				...(statusRec?.lastCheckReceipt ? { lastCheckReceipt: statusRec.lastCheckReceipt } : {}),
				status: statusRec?.status ?? 'pending',
				statusRecord: statusRec,
				upstreamIds: parsed.edges.filter(e => e.to === node.id).map(e => e.from),
				downstreamIds: parsed.edges.filter(e => e.from === node.id).map(e => e.to),
			};
		}

		case 'mission.task.set': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			if (!nodeId) {
				throw new Error('Task node ID (--node) is required for mission.task.set.');
			}
			const parsed = parseMissionMermaidDag(mission.mermaidText);
			const targetTask = parsed.nodes.find(n => n.id === nodeId);
			if (!targetTask) {
				throw new Error(`Task node "${nodeId}" not found in Mission "${mission.id}".`);
			}
			assertMissionTaskDesignScope(ctx, mission, 'edit description of', { targetTask });
			const hasDescParam = params.description !== undefined || params.prompt !== undefined || params.text !== undefined;
			const hasContractParam = params.requireChecksPassed !== undefined || params.requirePassingChecks !== undefined
				|| params.requireChecks !== undefined || params.requireArtifact !== undefined || params.requireFiles !== undefined
				|| params.requiredWhiteboardIds !== undefined || params.requireWhiteboard !== undefined || params.requireWb !== undefined
				|| params.minSummaryChars !== undefined || params.minSummary !== undefined || params.minEvidenceChars !== undefined;
			if (!hasDescParam && !hasContractParam) {
				throw new Error('Task --description (or --text / --prompt) is required for mission.task.set.');
			}
			if (hasContractParam) {
				const parseOptCsv = (raw: unknown): readonly string[] | null => {
					if (raw === null || raw === '') { return null; }
					return Array.isArray(raw)
						? raw.map(v => String(v).trim()).filter(Boolean)
						: String(raw).split(/[|,;]/).map(s => s.trim()).filter(Boolean);
				};
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
					metaPatch.requiredWhiteboardIds = parseOptCsv(params.requiredWhiteboardIds ?? params.requireWhiteboard ?? params.requireWb);
				}
				if (params.minSummaryChars !== undefined || params.minSummary !== undefined || params.minEvidenceChars !== undefined) {
					const rawS = params.minSummaryChars ?? params.minSummary ?? params.minEvidenceChars;
					metaPatch.minSummaryChars = (rawS === null || rawS === '' || rawS === 0) ? null : (Number.isInteger(Number(rawS)) && Number(rawS) >= 1 ? Math.min(2_000, Number(rawS)) : null);
				}
				const nextMermaid = upsertTaskMetadataInMermaid(mission.mermaidText ?? '', nodeId, metaPatch);
				ctx.missionService?.updateMermaid(mission.id, nextMermaid);
			}
			const updated = hasDescParam
				? ctx.missionService?.updateNodePrompt(mission.id, nodeId, String(params.description ?? params.prompt ?? params.text ?? ''))
				: ctx.missionService?.getMission(mission.id);
			return {
				ok: true,
				missionId: mission.id,
				nodeId,
				description: updated?.nodePrompts?.[nodeId] ?? '',
			};
		}

		case 'mission.task.create': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const explicitDept = typeof (params.department ?? params.dept) === 'string' && String(params.department ?? params.dept).trim()
				? String(params.department ?? params.dept).trim()
				: undefined;
			assertMissionTaskDesignScope(ctx, mission, 'create', { requestedDepartment: explicitDept });
			const title = String(params.title ?? params.label ?? params.name ?? '').trim();
			const explicitId = typeof (params.id ?? params.node ?? params.nodeId) === 'string' && String(params.id ?? params.node ?? params.nodeId).trim()
				? String(params.id ?? params.node ?? params.nodeId).trim()
				: undefined;
			if (!title && !explicitId) {
				throw new Error('Task --title (or --id) is required for mission.task.create.');
			}
			const kind = params.kind === 'gate' ? 'gate' : 'task';
			const added = addNodeToMermaid(mission.mermaidText ?? '', {
				id: explicitId,
				label: title || explicitId,
				kind,
			});
			let nextMermaid = added.mermaidText;
			const nodeId = added.nodeId;

			const parseCsv = (raw: unknown): string[] => Array.isArray(raw)
				? raw.map(v => String(v).trim()).filter(Boolean)
				: (typeof raw === 'string' ? raw.split(/[|,;]/).map(s => s.trim()).filter(Boolean) : []);

			const orchState = runtime.getOrchestrationState(mission.id);
			const orchGraph = parseOrchestrationGraph(mission.orchestrationText ?? '');
			let callerNodeId: string | undefined;
			if (ctx.callerSessionId) {
				for (const [nid, aid] of Object.entries(orchState.nodeAgentIds)) {
					if (aid === ctx.callerSessionId) { callerNodeId = nid; break; }
				}
			}
			const callerStaffNode = callerNodeId ? orchGraph.nodes.find(n => n.id === callerNodeId && n.kind === 'staff') : undefined;
			const ownerNodeId = typeof (params.ownerNodeId ?? params.owner) === 'string' && String(params.ownerNodeId ?? params.owner).trim()
				? String(params.ownerNodeId ?? params.owner).trim()
				: callerNodeId;
			const assigneeNodeId = typeof (params.assigneeNodeId ?? params.assignee) === 'string' && String(params.assigneeNodeId ?? params.assignee).trim()
				? String(params.assigneeNodeId ?? params.assignee).trim()
				: undefined;
			const department = typeof (params.department ?? params.dept) === 'string' && String(params.department ?? params.dept).trim()
				? String(params.department ?? params.dept).trim()
				: callerStaffNode?.department;
			const minTierRaw = params.minCompleterTier ?? params.minTier;
			const parsedMinTier = parseStrictMinTierParam(minTierRaw, { allowClear: false });
			if (!parsedMinTier.ok) {
				throw new Error(parsedMinTier.error);
			}
			const minCompleterTier = parsedMinTier.value;
			const allowedCompleterNodeIds = parseCsv(params.allowedCompleterNodeIds ?? params.completers);
			const rawReqChecks = params.requireChecksPassed ?? params.requirePassingChecks ?? params.requireChecks;
			const rawReqArtifact = params.requireArtifact;
			const rawReqFiles = params.requireFiles;
			const reqWbs = parseCsv(params.requiredWhiteboardIds ?? params.requireWhiteboard ?? params.requireWb);
			const rawMinSum = params.minSummaryChars ?? params.minSummary ?? params.minEvidenceChars;
			const minSummaryChars = rawMinSum !== undefined && rawMinSum !== null && String(rawMinSum).trim() !== '' && Number.isInteger(Number(rawMinSum)) && Number(rawMinSum) >= 1
				? Math.min(2_000, Number(rawMinSum))
				: undefined;
			const hasContractCreate = rawReqChecks !== undefined || rawReqArtifact !== undefined || rawReqFiles !== undefined || reqWbs.length > 0 || minSummaryChars !== undefined;

			if (ownerNodeId || assigneeNodeId || department || minCompleterTier !== undefined || allowedCompleterNodeIds.length > 0 || hasContractCreate) {
				nextMermaid = upsertTaskMetadataInMermaid(nextMermaid, nodeId, {
					...(ownerNodeId ? { ownerNodeId } : {}),
					...(assigneeNodeId ? { assigneeNodeId } : {}),
					...(department ? { department } : {}),
					...(minCompleterTier !== undefined ? { minCompleterTier } : {}),
					...(allowedCompleterNodeIds.length > 0 ? { allowedCompleterNodeIds } : {}),
					...(rawReqChecks !== undefined ? { requireChecksPassed: Boolean(rawReqChecks) } : {}),
					...(rawReqArtifact !== undefined ? { requireArtifact: Boolean(rawReqArtifact) } : {}),
					...(rawReqFiles !== undefined ? { requireFiles: Boolean(rawReqFiles) } : {}),
					...(reqWbs.length > 0 ? { requiredWhiteboardIds: reqWbs } : {}),
					...(minSummaryChars !== undefined ? { minSummaryChars } : {}),
				});
			}

			for (const upId of parseCsv(params.after ?? params.upstream ?? params.dependsOn)) {
				const edgeRes = addEdgeToMermaid(nextMermaid, upId, nodeId);
				if (!edgeRes.ok || !edgeRes.mermaidText) {
					throw new Error(edgeRes.error ?? `Failed to add dependency edge ${upId} -> ${nodeId}.`);
				}
				nextMermaid = edgeRes.mermaidText;
			}
			for (const downId of parseCsv(params.before ?? params.downstream)) {
				const edgeRes = addEdgeToMermaid(nextMermaid, nodeId, downId);
				if (!edgeRes.ok || !edgeRes.mermaidText) {
					throw new Error(edgeRes.error ?? `Failed to add dependency edge ${nodeId} -> ${downId}.`);
				}
				nextMermaid = edgeRes.mermaidText;
			}
			const finalParsed = parseMissionMermaidDag(nextMermaid);
			if (finalParsed.error) {
				throw new Error(finalParsed.error);
			}
			ctx.missionService?.updateMermaid(mission.id, nextMermaid);
			if (typeof params.description === 'string' && params.description.trim()) {
				ctx.missionService?.updateNodePrompt(mission.id, nodeId, params.description.trim());
			}
			return {
				ok: true,
				missionId: mission.id,
				nodeId,
				node: finalParsed.nodes.find(n => n.id === nodeId),
			};
		}

		case 'mission.task.update': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = String(params.node ?? params.nodeId ?? params.id ?? '').trim();
			if (!nodeId) {
				throw new Error('Task node ID (--node) is required for mission.task.update.');
			}
			let nextMermaid = mission.mermaidText ?? '';
			const initialParsed = parseMissionMermaidDag(nextMermaid);
			const targetTask = initialParsed.nodes.find(n => n.id === nodeId);
			if (!targetTask) {
				throw new Error(`Task node "${nodeId}" not found in Mission "${mission.id}".`);
			}
			const requestedDept = typeof (params.department ?? params.dept) === 'string' && String(params.department ?? params.dept).trim()
				? String(params.department ?? params.dept).trim()
				: undefined;
			assertMissionTaskDesignScope(ctx, mission, 'update', { targetTask, requestedDepartment: requestedDept });
			const nextTitle = typeof (params.title ?? params.label ?? params.name) === 'string' && String(params.title ?? params.label ?? params.name).trim()
				? String(params.title ?? params.label ?? params.name).trim()
				: undefined;
			if (nextTitle) {
				nextMermaid = renameNodeInMermaid(nextMermaid, nodeId, nextTitle);
			}
			const parseOptCsv = (raw: unknown): readonly string[] | null | undefined => {
				if (raw === null || raw === '') { return null; }
				if (raw === undefined) { return undefined; }
				return Array.isArray(raw)
					? raw.map(v => String(v).trim()).filter(Boolean)
					: String(raw).split(/[|,;]/).map(s => s.trim()).filter(Boolean);
			};
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
				const v = params.minCompleterTier ?? params.minTier;
				const parsedMinTier = parseStrictMinTierParam(v, { allowClear: true });
				if (!parsedMinTier.ok) {
					throw new Error(parsedMinTier.error);
				}
				metaPatch.minCompleterTier = parsedMinTier.clear ? null : parsedMinTier.value;
				hasMetaPatch = true;
			}
			const completersPatch = parseOptCsv(params.allowedCompleterNodeIds ?? params.completers);
			if (completersPatch !== undefined) {
				metaPatch.allowedCompleterNodeIds = completersPatch;
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
			const reqWbPatch = parseOptCsv(params.requiredWhiteboardIds ?? params.requireWhiteboard ?? params.requireWb);
			if (reqWbPatch !== undefined) {
				metaPatch.requiredWhiteboardIds = reqWbPatch;
				hasMetaPatch = true;
			}
			if (params.minSummaryChars !== undefined || params.minSummary !== undefined || params.minEvidenceChars !== undefined) {
				const rawS = params.minSummaryChars ?? params.minSummary ?? params.minEvidenceChars;
				metaPatch.minSummaryChars = (rawS === null || rawS === '' || rawS === 0)
					? null
					: (Number.isInteger(Number(rawS)) && Number(rawS) >= 1 ? Math.min(2_000, Number(rawS)) : null);
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
			if (nextMermaid !== (mission.mermaidText ?? '')) {
				ctx.missionService?.updateMermaid(mission.id, nextMermaid);
			}
			if (typeof params.description === 'string') {
				ctx.missionService?.updateNodePrompt(mission.id, nodeId, params.description);
			}
			const reparsed = parseMissionMermaidDag(nextMermaid);
			return {
				ok: true,
				missionId: mission.id,
				nodeId,
				node: reparsed.nodes.find(n => n.id === nodeId),
			};
		}

		case 'mission.task.remove': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = String(params.node ?? params.nodeId ?? params.id ?? '').trim();
			if (!nodeId) {
				throw new Error('Task node ID (--node) is required for mission.task.remove.');
			}
			const parsed = parseMissionMermaidDag(mission.mermaidText ?? '');
			const targetTask = parsed.nodes.find(n => n.id === nodeId);
			if (!targetTask) {
				throw new Error(`Task node "${nodeId}" not found in Mission "${mission.id}".`);
			}
			assertMissionTaskDesignScope(ctx, mission, 'remove', { targetTask });
			const nextMermaid = removeNodeFromMermaid(mission.mermaidText ?? '', nodeId);
			ctx.missionService?.updateMermaid(mission.id, nextMermaid);
			if (mission.taskStatuses && Object.hasOwn(mission.taskStatuses, nodeId)) {
				const nextStatuses = { ...mission.taskStatuses };
				delete nextStatuses[nodeId];
				ctx.missionService?.updateTaskStatuses(mission.id, nextStatuses);
			}
			return { ok: true, missionId: mission.id, removedNodeId: nodeId };
		}

		case 'mission.task.edge.add': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const from = String(params.from ?? '').trim();
			const to = String(params.to ?? '').trim();
			if (!from || !to) {
				throw new Error('Both --from and --to task node IDs are required for mission.task.edge.add.');
			}
			const existingDag = parseMissionMermaidDag(mission.mermaidText ?? '');
			const fromTask = existingDag.nodes.find(n => n.id === from);
			const toTask = existingDag.nodes.find(n => n.id === to);
			assertMissionTaskDesignScope(ctx, mission, 'connect edge from', { targetTask: fromTask });
			assertMissionTaskDesignScope(ctx, mission, 'connect edge to', { targetTask: toTask });
			const res = addEdgeToMermaid(mission.mermaidText ?? '', from, to, {
				label: typeof params.label === 'string' && params.label.trim() ? params.label.trim() : undefined,
				kind: params.kind === 'fail' ? 'fail' : 'success',
			});
			if (!res.ok || !res.mermaidText) {
				throw new Error(res.error ?? `Failed to add Mission Task DAG edge ${from} -> ${to}.`);
			}
			ctx.missionService?.updateMermaid(mission.id, res.mermaidText);
			return { ok: true, missionId: mission.id, from, to };
		}

		case 'mission.task.edge.remove': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const from = String(params.from ?? '').trim();
			const to = String(params.to ?? '').trim();
			if (!from || !to) {
				throw new Error('Both --from and --to task node IDs are required for mission.task.edge.remove.');
			}
			const existingDag = parseMissionMermaidDag(mission.mermaidText ?? '');
			const fromTask = existingDag.nodes.find(n => n.id === from);
			const toTask = existingDag.nodes.find(n => n.id === to);
			assertMissionTaskDesignScope(ctx, mission, 'disconnect edge from', { targetTask: fromTask });
			assertMissionTaskDesignScope(ctx, mission, 'disconnect edge to', { targetTask: toTask });
			const nextMermaid = removeEdgeFromMermaid(mission.mermaidText ?? '', from, to);
			ctx.missionService?.updateMermaid(mission.id, nextMermaid);
			return { ok: true, missionId: mission.id, from, to };
		}

		case 'mission.task.complete':
		case 'mission.task.status': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			if (!nodeId) {
				throw new Error('Task node ID (--node) is required.');
			}
			const rawStatus = action === 'mission.task.complete'
				? 'completed'
				: String(params.status ?? '').trim().toLowerCase();
			if (!['pending', 'in_progress', 'completed', 'blocked'].includes(rawStatus)) {
				throw new Error(`Invalid task status "${rawStatus}". Expected pending, in_progress, completed, or blocked.`);
			}
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			// Security: validate task existence and caller's completion authority BEFORE executing side-effecting checks!
			const taskDag = parseMissionMermaidDag(mission.mermaidText);
			const targetTaskNode = taskDag.nodes.find(n => n.id === nodeId);
			if (!targetTaskNode) {
				throw new Error(`Task node "${nodeId}" not found in Mission "${mission.id}".`);
			}
			const orchGraphForAuth = mission.orchestrationText?.trim() ? parseOrchestrationGraph(mission.orchestrationText) : undefined;
			const orchStateForAuth = mission.orchestrationText?.trim() ? runtime.getOrchestrationState(mission.id) : undefined;
			const callerNodeId = ctx.callerSessionId && orchStateForAuth?.nodeAgentIds
				? Object.entries(orchStateForAuth.nodeAgentIds).find(([, aid]) => aid === ctx.callerSessionId)?.[0]
				: undefined;
			if (rawStatus === 'completed') {
				if (targetTaskNode.kind === 'gate') {
					const gateAllowed = Boolean(
						ctx.isHumanUser
						|| ctx.isSecretary
						|| (callerNodeId && targetTaskNode.allowedCompleterNodeIds?.includes(callerNodeId)),
					);
					if (!gateAllowed) {
						throw new Error(`FORBIDDEN: Human approval gate "${nodeId}" may only be completed by Human User, Secretary, or an explicitly allowlisted approver.`);
					}
				} else if (!canCallerCompleteMissionTask(
					ctx.roleConfig,
					targetTaskNode,
					{
						isHumanUser: ctx.isHumanUser,
						isSecretary: ctx.isSecretary,
						callerTier,
						callerNodeId,
					},
					orchGraphForAuth && !orchGraphForAuth.error ? orchGraphForAuth : undefined,
					mission.taskStatuses?.[nodeId],
				)) {
					throw new Error(`FORBIDDEN: caller lacks completion authority for Mission task "${nodeId}".`);
				}
			}
			const enabledChecks = (runtime.getEffectiveNodeChecks(mission.id, nodeId)[nodeId] ?? []).filter(c => c.enabled !== false);
			const allowSkipChecks = ctx.isHumanUser && (params.skipChecks === true || params.force === true);
			let checkReceipt: IMissionTaskCheckReceipt | undefined;
			if (rawStatus === 'completed' && enabledChecks.length > 0 && !allowSkipChecks) {
				const suite = await runtime.runNodeChecks(mission.id, nodeId);
				checkReceipt = {
					passed: suite.passed,
					summary: suite.summary,
					checkedAt: Date.now(),
					checkCount: suite.results.length,
				};
				if (!suite.passed) {
					// Record failing check receipt onto task status before throwing
					runtime.recordTaskCheckReceipt?.(mission.id, nodeId, checkReceipt);
					throw new Error(`AUTOMATED_CHECK_FAILED on "${nodeId}": ${suite.summary}`);
				}
			}
			const rawTouchedFiles = params.touchedFiles ?? params.modifiedFiles ?? params.files;
			const touchedFiles = Array.isArray(rawTouchedFiles)
				? rawTouchedFiles.map(v => String(v).trim()).filter(Boolean)
				: (typeof rawTouchedFiles === 'string' && rawTouchedFiles.trim()
					? rawTouchedFiles.split(/[|,;]/).map(s => s.trim()).filter(Boolean)
					: undefined);
			const effectiveNote = typeof params.note === 'string' && params.note.trim()
				? params.note
				: (typeof (params.evidence ?? params.evidenceSummary) === 'string' && String(params.evidence ?? params.evidenceSummary).trim()
					? String(params.evidence ?? params.evidenceSummary)
					: (typeof params.note === 'string' ? params.note : undefined));
			const res = runtime.setMissionTaskStatus(mission.id, {
				nodeId,
				status: rawStatus as MissionTaskStatus,
				caller: {
					isHumanUser: ctx.isHumanUser,
					isSecretary: ctx.isSecretary,
					callerTier,
					callerSessionId: ctx.callerSessionId,
					callerLabel: ctx.callerAgent?.label ?? (ctx.isHumanUser ? 'User' : ctx.isSecretary ? 'Secretary' : undefined),
					...(callerNodeId ? { callerNodeId } : {}),
				},
				hasConfiguredChecks: enabledChecks.length > 0,
				...(checkReceipt ? { checkReceipt } : {}),
				...(touchedFiles && touchedFiles.length > 0 ? { touchedFiles } : {}),
				force: params.force === true,
				note: effectiveNote,
			});
			if (!res.ok) {
				throw new Error(res.error ?? `Failed to update task "${nodeId}" status.`);
			}
			return {
				ok: true,
				missionId: mission.id,
				nodeId,
				status: res.taskStatuses[nodeId],
				...(res.incompleteUpstreamTaskIds ? { incompleteUpstreamTaskIds: res.incompleteUpstreamTaskIds } : {}),
			};
		}

		case 'mission.diagnostics': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const report = runtime.getMissionDiagnostics(mission.id);
			return {
				ok: true,
				...report,
			};
		}

		case 'mission.checkpoint.create':
		case 'orchestration.checkpoint.create': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'create checkpoint for');
			const label = typeof params.label === 'string' && params.label.trim() ? params.label.trim() : undefined;
			const reason = typeof params.reason === 'string' && params.reason.trim() ? params.reason.trim() : 'manual';
			const created = await runtime.createMissionCheckpoint(mission.id, {
				...(label ? { label } : {}),
				reason,
				createdBy: ctx.callerSessionId ?? (ctx.isHumanUser ? 'human' : 'secretary'),
			});
			return { ok: true, missionId: mission.id, checkpoint: created };
		}

		case 'mission.checkpoint.list':
		case 'orchestration.checkpoint.list': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const checkpoints = await runtime.listMissionCheckpoints(mission.id);
			return { ok: true, missionId: mission.id, count: checkpoints.length, checkpoints };
		}

		case 'mission.checkpoint.diff':
		case 'orchestration.checkpoint.diff': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const fromId = String(params.from ?? params.checkpointId ?? params.id ?? '').trim();
			if (!fromId) {
				throw new Error('Checkpoint ID (--id / --from) is required for mission.checkpoint.diff.');
			}
			const rawToId = params.to ?? params.againstCheckpointId;
			const toId = typeof rawToId === 'string' && rawToId.trim() ? rawToId.trim() : undefined;
			const diff = await runtime.diffMissionCheckpoint(mission.id, fromId, toId);
			return { ok: true, missionId: mission.id, fromCheckpointId: fromId, toCheckpointId: toId ?? 'live', diff };
		}

		case 'mission.checkpoint.restore':
		case 'orchestration.checkpoint.restore': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'restore checkpoint for');
			const checkpointId = String(params.checkpointId ?? params.id ?? '').trim();
			if (!checkpointId) {
				throw new Error('Checkpoint ID (--id) is required for mission.checkpoint.restore.');
			}
			const mode: 'full' | 'tokens_only' = String(params.mode ?? 'full').trim().toLowerCase() === 'tokens_only' ? 'tokens_only' : 'full';
			const restored = await runtime.restoreMissionCheckpoint(mission.id, checkpointId, {
				mode,
				restoredBy: ctx.callerSessionId ?? (ctx.isHumanUser ? 'human' : 'secretary'),
			});
			return { ...restored, missionId: mission.id };
		}

		case 'orchestration.pause': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'pause Orchestration for');
			const reason = typeof params.reason === 'string' ? params.reason : undefined;
			const res = await runtime.pauseOrchestration(mission.id, reason);
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to pause Orchestration.');
			}
			return { ok: true, missionId: mission.id, status: res.state.status };
		}

		case 'orchestration.resume': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'resume Orchestration for');
			const res = await runtime.resumeOrchestration(mission.id);
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to resume Orchestration.');
			}
			return { ok: true, missionId: mission.id, status: res.state.status, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'orchestration.abort': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'abort all active Orchestration tokens for');
			await runtime.createMissionCheckpoint(mission.id, {
				reason: 'pre_orchestration_abort',
				createdBy: ctx.callerSessionId ?? (ctx.isHumanUser ? 'human' : 'secretary'),
			}).catch(() => undefined);
			const reason = typeof params.reason === 'string' ? params.reason : undefined;
			const res = await runtime.abortOrchestrationTokens(mission.id, reason);
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to abort Orchestration tokens.');
			}
			return { ok: true, missionId: mission.id, status: res.state.status, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'orchestration.edge.connect': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'connect Orchestration edge for');
			const from = String(params.from ?? '').trim();
			const to = String(params.to ?? '').trim();
			if (!from || !to) {
				throw new Error('Both --from and --to node IDs are required for orchestration.edge.connect.');
			}
			const bidirectional = params.bidirectional !== false;
			const label = typeof params.label === 'string' && params.label.trim() ? params.label.trim() : undefined;
			const dashed = params.dashed === true;
			const res = connectOrchestrationEdge(mission.orchestrationText ?? '', from, to, { label, bidirectional, dashed });
			if (!res.ok || !res.orchestrationText) {
				throw new Error(res.error ?? `Failed to connect edge "${from}" -> "${to}".`);
			}
			ctx.missionService?.updateOrchestrationText(mission.id, res.orchestrationText);
			return { ok: true, missionId: mission.id, from, to, bidirectional, ...(label ? { label } : {}), ...(dashed ? { dashed: true } : {}) };
		}

		case 'orchestration.edge.label': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'edit Orchestration edge label for');
			const from = String(params.from ?? '').trim();
			const to = String(params.to ?? '').trim();
			const label = typeof params.label === 'string' ? params.label.trim() : '';
			if (!from || !to) {
				throw new Error('Both --from and --to node IDs are required for orchestration.edge.label.');
			}
			const nextText = renameOrchestrationEdgeLabel(mission.orchestrationText ?? '', from, to, label);
			ctx.missionService?.updateOrchestrationText(mission.id, nextText);
			return { ok: true, missionId: mission.id, from, to, label };
		}

		case 'orchestration.edge.remove': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'remove Orchestration edge for');
			const from = String(params.from ?? '').trim();
			const to = String(params.to ?? '').trim();
			if (!from || !to) {
				throw new Error('Both --from and --to node IDs are required for orchestration.edge.remove.');
			}
			let nextText = removeOrchestrationEdge(mission.orchestrationText ?? '', from, to);
			if (params.both === true) {
				nextText = removeOrchestrationEdge(nextText, to, from);
			}
			ctx.missionService?.updateOrchestrationText(mission.id, nextText);
			return { ok: true, missionId: mission.id, from, to, ...(params.both === true ? { both: true } : {}) };
		}

		case 'mission.export': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const withPositions = params.withPositions === true;
			const includeAgentIds = params.includeAgentIds === true;
			const parsedOrch = parseOrchestrationGraph(mission.orchestrationText ?? '');
			const orchState = runtime.getOrchestrationState(mission.id);
			const rtState = runtime.getRuntimeState(mission.id);
			const staffRuntimeMeta: Record<string, { engineId?: string; model?: string; thinking?: string; hostAlias?: string; agentId?: string }> = {};
			for (const node of parsedOrch.nodes) {
				if (node.kind !== 'staff') {
					continue;
				}
				const aid = orchState.nodeAgentIds[node.id] ?? node.agentId;
				const agent = aid ? ctx.projects.getAgent(aid) : undefined;
				const hostAlias = rtState.boundary.nodeAssignments[node.id]?.hostAlias ?? node.hostAlias;
				staffRuntimeMeta[node.id] = {
					...(agent?.session?.engineId ?? agent?.preferredEngineId ?? node.engineId ? { engineId: agent?.session?.engineId ?? agent?.preferredEngineId ?? node.engineId } : {}),
					...(agent?.preferredModel ?? node.model ? { model: agent?.preferredModel ?? node.model } : {}),
					...(agent?.preferredThinking ?? node.thinking ? { thinking: agent?.preferredThinking ?? node.thinking } : {}),
					...(hostAlias ? { hostAlias } : {}),
					...(includeAgentIds && aid ? { agentId: aid } : {}),
				};
			}
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			const wbList = runtime.listOrchestrationWhiteboards(mission.id, {
				isHumanUser: ctx.isHumanUser,
				isSecretary: ctx.isSecretary,
				callerTier,
				callerAgentId: ctx.callerSessionId,
			});
			const wbMap: Record<string, IOrchestrationWhiteboard> = {};
			for (const wb of wbList) {
				wbMap[wb.id] = wb;
			}
			const rawOrchExport = (mission.orchestrationText?.trim() || wbList.length > 0)
				? serializeOrchestrationGraph({
					direction: parsedOrch.direction,
					layoutMode: mission.orchestrationLayoutMode ?? parsedOrch.layoutMode,
					nodes: parsedOrch.nodes,
					edges: parsedOrch.edges,
					departments: parsedOrch.departments,
					whiteboards: wbMap,
					positions: withPositions ? (mission.orchestrationPositions ?? parsedOrch.positions) : undefined,
					staffRuntimeMeta,
					includeAgentIds,
				})
				: '';
			const losslessOrchText = (ctx.isHumanUser || ctx.isSecretary)
				? rawOrchExport
				: stripForeignWhiteboardBodiesFromOrchestrationText(rawOrchExport, new Set(wbList.map(w => w.id)));
			const format = typeof params.format === 'string' ? params.format.trim().toLowerCase() : 'json';
			if (format === 'markdown' || format === 'md') {
				const mdLines = [
					`# ${mission.title}`,
					'',
					'## Mission Task DAG',
					'```mermaid',
					mission.mermaidText,
					'```',
				];
				if (losslessOrchText.trim()) {
					mdLines.push('', '## Orchestration Team', '```mermaid', losslessOrchText, '```');
				}
				const promptEntries = Object.entries(mission.nodePrompts ?? {}).filter(([, body]) => Boolean(body?.trim()));
				if (promptEntries.length > 0) {
					mdLines.push('', '## Task Specifications');
					for (const [nid, body] of promptEntries) {
						mdLines.push('', `### ${nid}`, body.trim());
					}
				}
				return {
					format: 'markdown',
					missionId: mission.id,
					title: mission.title,
					content: mdLines.join('\n'),
				};
			}
			return {
				schemaVersion: 1,
				exportedAt: Date.now(),
				missionId: mission.id,
				title: mission.title,
				mermaidText: mission.mermaidText,
				nodePrompts: mission.nodePrompts ?? {},
				taskStatuses: mission.taskStatuses ?? {},
				orchestrationLayoutMode: mission.orchestrationLayoutMode ?? parsedOrch.layoutMode,
				orchestrationText: losslessOrchText,
				whiteboards: wbMap,
				...(withPositions && Object.keys(mission.positions ?? {}).length > 0 ? { positions: mission.positions } : {}),
				...(withPositions && Object.keys(mission.orchestrationPositions ?? {}).length > 0 ? { orchestrationPositions: mission.orchestrationPositions } : {}),
			};
		}

		default:
			throw new Error(`Unsupported Mission task action: ${action}`);
	}
}
