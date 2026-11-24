/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseWhiteboardSliceParams } from '../../../../platform/ade/common/adeControlPolicy.js';
import { upsertOrchestrationWhiteboardInCode } from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { sliceWhiteboardContent } from '../../../../platform/ade/common/adeOrchestrationWhiteboards.js';
import { resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import {
	assertDepartmentWhiteboardAdminAuthority,
	assertMissionMemberOrSupervisor,
	IAdeMissionControlContext,
	resolveMissionRecord,
} from './adeMissionControlHelpers.js';

export const ADE_WHITEBOARD_CONTROL_ACTIONS = new Set([
	'whiteboard.list',
	'whiteboard.read',
	'whiteboard.create',
	'whiteboard.write',
	'whiteboard.rename',
	'whiteboard.remove',
]);

export function executeAdeWhiteboardControlAction(
	action: string,
	params: Record<string, unknown>,
	ctx: IAdeMissionControlContext,
): unknown {
	const runtime = ctx.missionRuntime;
	if (!runtime) {
		throw new Error('ADE Mission runtime service is not available.');
	}

	switch (action) {
		case 'whiteboard.list': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			const deptFilter = typeof (params.department ?? params.dept) === 'string' && String(params.department ?? params.dept).trim()
				? String(params.department ?? params.dept).trim().toLowerCase()
				: undefined;
			const whiteboards = runtime.listOrchestrationWhiteboards(mission.id, {
				isHumanUser: ctx.isHumanUser,
				isSecretary: ctx.isSecretary,
				callerTier,
				callerAgentId: ctx.callerSessionId,
			}).filter(wb => !deptFilter || wb.department.trim().toLowerCase() === deptFilter);
			return {
				missionId: mission.id,
				whiteboards: whiteboards.map(wb => ({
					whiteboardId: wb.id,
					title: wb.title,
					department: wb.department,
					version: wb.version,
					contentLength: wb.content.length,
					updatedAt: wb.updatedAt,
					updatedByLabel: wb.updatedByLabel,
				})),
			};
		}

		case 'whiteboard.read': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const id = String(params.id ?? params.whiteboardId ?? params.whiteboard ?? '').trim();
			if (!id) {
				throw new Error('Whiteboard ID is required for whiteboard.read.');
			}
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			const res = runtime.readOrchestrationWhiteboard(mission.id, id, {
				isHumanUser: ctx.isHumanUser,
				isSecretary: ctx.isSecretary,
				callerTier,
				callerAgentId: ctx.callerSessionId,
			});
			if (!res.ok || !res.whiteboard) {
				throw new Error(res.error ?? `Unable to read whiteboard "${id}".`);
			}
			const sliceOpts = parseWhiteboardSliceParams(params);
			if (sliceOpts.hasSliceParams) {
				const sliced = sliceWhiteboardContent(res.whiteboard.content, sliceOpts);
				return {
					ok: true,
					missionId: mission.id,
					whiteboard: {
						...res.whiteboard,
						content: sliced.content,
					},
					slice: {
						truncated: sliced.truncated,
						totalChars: sliced.totalChars,
						lineCount: sliced.lineCount,
						offset: sliced.offset,
						...(sliced.nextOffset !== undefined ? { nextOffset: sliced.nextOffset } : {}),
						...(sliced.matchedSection ? { matchedSection: sliced.matchedSection } : {}),
						headings: sliced.headings,
						...(sliced.availableSections ? { availableSections: sliced.availableSections } : {}),
						isPartialSlice: sliced.isPartialSlice,
					},
				};
			}
			return { ok: true, missionId: mission.id, whiteboard: res.whiteboard };
		}

		case 'whiteboard.create':
		case 'whiteboard.write': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			const rawExpectedVersion = params.expectedVersion ?? params.ifVersion;
			let expectedVersion: number | undefined;
			if (rawExpectedVersion !== undefined && rawExpectedVersion !== null && String(rawExpectedVersion).trim() !== '') {
				const parsedVer = Number(rawExpectedVersion);
				if (!Number.isInteger(parsedVer) || parsedVer < 0) {
					throw new Error(`Invalid --expected-version "${String(rawExpectedVersion)}": must be a non-negative integer.`);
				}
				expectedVersion = parsedVer;
			}
			const rawWbId = params.id ?? params.whiteboardId ?? params.whiteboard;
			const rawDept = params.department ?? params.dept;
			const section = typeof params.section === 'string' && params.section.trim() ? params.section.trim() : undefined;
			const rawSectionMode = typeof params.sectionMode === 'string' ? params.sectionMode.trim().toLowerCase() : undefined;
			const sectionMode: 'replace' | 'append' | undefined = section
				? (rawSectionMode === 'append' || (rawSectionMode !== 'replace' && typeof params.appendContent === 'string' && params.content === undefined) ? 'append' : 'replace')
				: undefined;
			const res = runtime.upsertOrchestrationWhiteboard(mission.id, {
				id: typeof rawWbId === 'string' && rawWbId.trim() ? rawWbId.trim() : undefined,
				title: typeof params.title === 'string' ? params.title : undefined,
				department: typeof rawDept === 'string' ? rawDept : undefined,
				content: typeof params.content === 'string' ? params.content : undefined,
				appendContent: typeof params.appendContent === 'string' ? params.appendContent : undefined,
				...(section ? { section, sectionMode } : {}),
				mode: action === 'whiteboard.create' ? 'create' : 'write',
				...(expectedVersion !== undefined ? { expectedVersion } : {}),
				caller: {
					isHumanUser: ctx.isHumanUser,
					isSecretary: ctx.isSecretary,
					callerTier,
					callerAgentId: ctx.callerSessionId,
					callerLabel: ctx.callerAgent?.label ?? (ctx.isHumanUser ? 'User' : ctx.isSecretary ? 'Secretary' : undefined),
				},
			});
			if (!res.ok || !res.whiteboard) {
				throw new Error(res.error ?? 'Failed to write Department Whiteboard.');
			}
			return {
				ok: true,
				missionId: mission.id,
				whiteboard: {
					whiteboardId: res.whiteboard.id,
					title: res.whiteboard.title,
					department: res.whiteboard.department,
					version: res.whiteboard.version,
					updatedAt: res.whiteboard.updatedAt,
				},
			};
		}

		case 'whiteboard.rename': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const wbId = String(params.whiteboardId ?? params.whiteboard ?? params.id ?? '').trim();
			const title = String(params.title ?? params.name ?? '').trim();
			const department = typeof params.department === 'string' && params.department.trim() ? params.department.trim() : undefined;
			if (!wbId || !title) {
				throw new Error('Whiteboard ID and new --title are required for whiteboard.rename.');
			}
			const existing = runtime.listOrchestrationWhiteboards(mission.id).find(w => w.id === wbId);
			if (!existing) {
				throw new Error(`Department whiteboard "${wbId}" not found.`);
			}
			const nextDept = department ?? existing.department;
			assertDepartmentWhiteboardAdminAuthority(ctx, mission, [existing.department, nextDept], 'rename');
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			const res = runtime.upsertOrchestrationWhiteboard(mission.id, {
				id: wbId,
				title,
				department: nextDept,
				mode: 'write',
				allowDepartmentRelocation: true,
				caller: {
					isHumanUser: ctx.isHumanUser,
					isSecretary: ctx.isSecretary,
					callerTier,
					callerAgentId: ctx.callerSessionId,
					callerLabel: ctx.callerAgent?.label ?? (ctx.isHumanUser ? 'User' : ctx.isSecretary ? 'Secretary' : undefined),
				},
			});
			if (!res.ok || !res.whiteboard) {
				throw new Error(res.error ?? `Failed to rename whiteboard "${wbId}".`);
			}
			const latestMission = ctx.missionService?.getMission(mission.id) ?? mission;
			const nextCode = upsertOrchestrationWhiteboardInCode(latestMission.orchestrationText ?? '', {
				id: res.whiteboard.id,
				title: res.whiteboard.title,
				department: res.whiteboard.department,
				content: res.whiteboard.content,
				version: res.whiteboard.version,
			});
			ctx.missionService?.updateOrchestrationText(mission.id, nextCode);
			return {
				ok: true,
				missionId: mission.id,
				whiteboard: {
					whiteboardId: res.whiteboard.id,
					title: res.whiteboard.title,
					department: res.whiteboard.department,
					version: res.whiteboard.version,
				},
			};
		}

		case 'whiteboard.remove': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const wbId = String(params.whiteboardId ?? params.whiteboard ?? params.id ?? '').trim();
			if (!wbId) {
				throw new Error('Whiteboard ID is required for whiteboard.remove.');
			}
			const existing = runtime.listOrchestrationWhiteboards(mission.id).find(w => w.id === wbId);
			if (!existing) {
				throw new Error(`Department whiteboard "${wbId}" not found.`);
			}
			assertDepartmentWhiteboardAdminAuthority(ctx, mission, [existing.department], 'remove');
			const removed = runtime.removeOrchestrationWhiteboard(mission.id, wbId);
			if (!removed.ok) {
				throw new Error(removed.error ?? `Failed to remove whiteboard "${wbId}".`);
			}
			return {
				ok: true,
				missionId: mission.id,
				removedWhiteboardId: wbId,
				...(removed.prunedTokenIds && removed.prunedTokenIds.length > 0 ? { prunedTokenIds: removed.prunedTokenIds } : {}),
			};
		}

		default:
			throw new Error(`Unsupported whiteboard action: ${action}`);
	}
}
