/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import {
	AdeCloudHostOs,
	IAdeCloudHostBackendService,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import { IAdeInboxService } from '../../../../platform/ade/common/adeEngineering.js';
import { parseDualViewBlueprintMarkdown, parseMissionMermaidDag } from '../../../../platform/ade/common/adeMissionDag.js';
import {
	IMissionTaskStatusRecord,
	IOrchestrationWhiteboard,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import { parseOrchestrationGraph } from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { ADE_SECRETARY_TIER, ADE_USER_TIER, formatTierTag } from '../../../../platform/ade/common/adeRankResize.js';
import {
	ADE_ORGANIZATION_PRESETS,
	ADE_PRIMITIVE_APIS,
	getMissionDisplayName,
	IAdeOrganizationConfig,
	normalizeAdeOrganizationConfig,
	resolveEffectiveRankDefinition,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import {
	ADE_CHANGES_VIEW_ID,
	ADE_FILES_VIEW_ID,
	ADE_SECRETARY_ID,
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectsService,
	resolveAdeAgentRank,
} from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { IAdeMissionRuntimeService } from './adeMissionRuntime.js';
import {
	canCallerOperateMission,
	canCallerReadMission,
	IAdeMissionCaller,
	IAdeMissionRecord,
	IAdeMissionService,
} from './adeMissionStore.js';
import {
	buildControlStatus,
	findMatchingProject,
	toUri,
} from './adeRolePromptResolver.js';
import { resolveAgentFromParams } from './adeSessionControlActions.js';
import { IAdeSessionsService } from './adeSessionsService.js';

export const ADE_SYSTEM_CONTROL_ACTIONS = new Set([
	'status',
	'mode.get',
	'mode.set',
	'view.get',
	'view.refresh',
	'view.set',
	'mission.init',
	'mission.create',
	'mission.import',
	'mission.list',
	'mission.rename',
	'mission.open',
	'mission.blueprint.get',
	'mission.get',
	'mission.blueprint.validate',
	'mission.blueprint.apply',
	'mission.setMermaid',
	'mission.remove',
	'mission.delete',
	'inbox.list',
	'inbox.post',
	'inbox.resolve',
	'inbox.markRead',
	'host.list',
	'host.get',
	'host.info',
	'host.upsert',
	'host.delete',
	'host.test',
	'host.browse',
	'host.import',
	'host.open',
	'role.schema.get',
	'role.apis',
	'role.presets',
	'role.schema.set',
	'role.schema.reset',
	'role.studio.open',
]);

export interface IAdeSystemControlActionContext {
	readonly modes: IWorkbenchModeService;
	readonly projects: IAdeProjectsService;
	readonly navigation: IProjectNavigationService;
	readonly editors: IAdeEditorService;
	readonly sessions: IAdeSessionsService;
	readonly uriIdentity: IUriIdentityService;
	readonly commandService: ICommandService;
	readonly viewsService: IViewsService | undefined;
	readonly layoutService: IWorkbenchLayoutService | undefined;
	readonly missionService: IAdeMissionService | undefined;
	readonly missionRuntime: IAdeMissionRuntimeService | undefined;
	readonly inboxService: IAdeInboxService | undefined;
	readonly cloudHosts: IAdeCloudHostBackendService | undefined;
	readonly roleSchemaService: IAdeRoleSchemaService | undefined;
	readonly roleConfig: IAdeOrganizationConfig;
	readonly isHumanUser: boolean;
	readonly isSecretaryCaller: boolean;
	readonly isHumanOrSecretary: boolean;
	readonly callerAgent: IAdeAgent | undefined;
	readonly missionCallerFor: (mission: IAdeMissionRecord) => IAdeMissionCaller;
	readonly findCallerAssociatedMission: (sessionIdCandidate: string | undefined) => IAdeMissionRecord | undefined;
	readonly assertCanOperateMission: (mission: IAdeMissionRecord) => void;
	readonly assertCanReadMission: (mission: IAdeMissionRecord) => void;
}

export async function executeAdeSystemControlAction(
	action: string,
	params: Record<string, unknown>,
	ctx: IAdeSystemControlActionContext,
): Promise<unknown> {
	const {
		modes,
		projects,
		navigation,
		editors,
		sessions,
		uriIdentity,
		commandService,
		viewsService,
		layoutService,
		missionService,
		missionRuntime,
		inboxService,
		cloudHosts,
		roleSchemaService,
		roleConfig,
		isHumanUser,
		isSecretaryCaller,
		isHumanOrSecretary,
		callerAgent,
		missionCallerFor,
		findCallerAssociatedMission,
		assertCanOperateMission,
		assertCanReadMission,
	} = ctx;

	switch (action) {
		case 'status':
			return buildControlStatus(modes, projects, navigation, editors, sessions, roleConfig);

		case 'mode.get':
			return { mode: modes.mode };

		case 'mode.set': {
			const nextMode = params.mode;
			if (nextMode !== 'ade' && nextMode !== 'ide') {
				throw new Error(localize('adeInvalidMode', "Expected mode 'ade' or 'ide', received '{0}'.", String(nextMode)));
			}
			if (nextMode === 'ide' && isSecretaryCaller) {
				throw new Error(localize('adeSecretaryIdeForbidden', "Secretary operates strictly inside ADE and does not switch to IDE mode."));
			}
			modes.setMode(nextMode);
			return { mode: modes.mode };
		}

		case 'view.get':
			return {
				showArchived: projects.showArchived,
				inspector: {
					changesVisible: Boolean(viewsService?.isViewVisible(ADE_CHANGES_VIEW_ID)),
					filesVisible: Boolean(viewsService?.isViewVisible(ADE_FILES_VIEW_ID)),
					auxiliaryBarVisible: Boolean(layoutService?.isVisible(Parts.AUXILIARYBAR_PART)),
				},
			};

		case 'view.refresh':
			await commandService.executeCommand('workbench.action.ade.refresh').catch(() => undefined);
			return { refreshed: true, showArchived: projects.showArchived };

		case 'view.set': {
			const rawArchived = params.showArchived ?? params.archived;
			if (typeof rawArchived === 'boolean') {
				projects.setShowArchived(rawArchived);
			} else if (rawArchived === 'toggle') {
				projects.setShowArchived(!projects.showArchived);
			}
			if (typeof params.inspector === 'string') {
				const inspectorTarget = params.inspector.trim().toLowerCase();
				modes.setMode('ade');
				if (inspectorTarget === 'changes') {
					await viewsService?.openView(ADE_CHANGES_VIEW_ID, true);
				} else if (inspectorTarget === 'files') {
					await viewsService?.openView(ADE_FILES_VIEW_ID, true);
				} else if (inspectorTarget === 'hide' || inspectorTarget === 'close') {
					layoutService?.setPartHidden(true, Parts.AUXILIARYBAR_PART);
				} else {
					throw new Error(localize('adeInvalidInspectorView', "Expected inspector 'changes', 'files', or 'hide', received '{0}'.", params.inspector));
				}
			}
			if (params.refresh === true) {
				await commandService.executeCommand('workbench.action.ade.refresh').catch(() => undefined);
			}
			return {
				showArchived: projects.showArchived,
				...(typeof params.inspector === 'string' ? {
					inspector: {
						changesVisible: Boolean(viewsService?.isViewVisible(ADE_CHANGES_VIEW_ID)),
						filesVisible: Boolean(viewsService?.isViewVisible(ADE_FILES_VIEW_ID)),
						auxiliaryBarVisible: Boolean(layoutService?.isVisible(Parts.AUXILIARYBAR_PART)),
					},
				} : {}),
			};
		}

		case 'mission.init':
		case 'mission.create': {
			if (!missionService) {
				throw new Error('ADE Mission service is not available.');
			}
			const rawOwner = params.owner ?? params.ownerSessionId ?? params.mission ?? params.missionId ?? params.governor ?? params.governorSessionId ?? params.sessionId;
			const rawOwnerStr = typeof rawOwner === 'string' ? rawOwner.trim() : '';
			const rawOwnerLower = rawOwnerStr.toLowerCase();
			let ownerSessionId: string | undefined;
			let ownerTier: number = ADE_USER_TIER;
			let ownerRankId: string = 'user';
			let linkedAgent: IAdeAgent | undefined;

			if (isHumanUser) {
				if (rawOwnerStr && (rawOwnerLower === 'secretary' || rawOwnerLower === 'l0' || rawOwnerStr === ADE_SECRETARY_ID)) {
					ownerSessionId = ADE_SECRETARY_ID;
					ownerTier = ADE_SECRETARY_TIER;
					ownerRankId = 'secretary';
				} else if (rawOwnerStr) {
					linkedAgent = resolveAgentFromParams(projects, { id: rawOwnerStr });
					if (projects.isLockedByWorkTree?.(linkedAgent.id)) {
						throw new Error(localize('adeMissionCreateOnLockedDenied', "Session '{0}' is a locked Mission-generated employee and cannot host another Mission.", linkedAgent.label));
					}
					const ownerRankDef = resolveEffectiveRankDefinition(roleConfig, linkedAgent.role, projects.hasSubordinates(linkedAgent.id));
					ownerSessionId = linkedAgent.id;
					ownerTier = ownerRankDef.tier;
					ownerRankId = ownerRankDef.id;
				}
			} else if (isSecretaryCaller) {
				if (rawOwnerStr && rawOwnerLower !== 'secretary' && rawOwnerLower !== 'l0' && rawOwnerStr !== ADE_SECRETARY_ID) {
					throw new Error(localize(
						'adeMissionForeignInitDenied',
						"Permission denied: Secretary (L0) can only create and operate its own L0 Mission; only session '{0}' or User (L-1) may create a Mission on that session.",
						rawOwnerStr,
					));
				}
				ownerSessionId = ADE_SECRETARY_ID;
				ownerTier = ADE_SECRETARY_TIER;
				ownerRankId = 'secretary';
			} else if (callerAgent) {
				if (projects.isLockedByWorkTree?.(callerAgent.id)) {
					throw new Error(localize('adeMissionCreateOnLockedDenied', "Session '{0}' is a locked Mission-generated employee and cannot host another Mission.", callerAgent.label));
				}
				if (rawOwnerStr && rawOwnerStr !== callerAgent.id) {
					const targetAgent = resolveAgentFromParams(projects, { id: rawOwnerStr });
					if (targetAgent.id !== callerAgent.id) {
						throw new Error(localize(
							'adeMissionForeignAgentInitDenied',
							"Permission denied: session '{0}' can only create and operate a Mission on itself, not on '{1}'.",
							callerAgent.label,
							targetAgent.label,
						));
					}
				}
				linkedAgent = callerAgent;
				const ownerRankDef = resolveEffectiveRankDefinition(roleConfig, callerAgent.role, projects.hasSubordinates(callerAgent.id));
				ownerSessionId = callerAgent.id;
				ownerTier = ownerRankDef.tier;
				ownerRankId = ownerRankDef.id;
			} else {
				throw new Error(localize('adeMissionCallerRequired', "Permission denied: a verified owner session or User (L-1) identity is required to create a Mission."));
			}

			const title = typeof params.title === 'string' && params.title.trim()
				? params.title.trim()
				: (linkedAgent?.label ?? (ownerSessionId === ADE_SECRETARY_ID ? 'Secretary' : undefined));
			const mermaidText = typeof (params.mermaid ?? params.mermaidText ?? params.text) === 'string'
				? String(params.mermaid ?? params.mermaidText ?? params.text)
				: '';
			if (mermaidText) {
				const validated = parseMissionMermaidDag(mermaidText);
				if (validated.error) {
					throw new Error(validated.error);
				}
			}

			const rawProject = params.project ?? params.projectPath ?? params.path ?? params.uri;
			const resolvedProjectUri = linkedAgent?.projectUri
				?? (rawProject ? (findMatchingProject(projects, uriIdentity, rawProject)?.uri ?? toUri(rawProject)) : undefined)
				?? (ownerSessionId === ADE_SECRETARY_ID ? (navigation.focusedProject?.uri ?? projects.selectedProject?.uri ?? projects.projects[0]?.uri) : undefined);

			const existing = ownerSessionId ? missionService.getMissionByLinkedSession(ownerSessionId) : undefined;
			if (existing) {
				assertCanOperateMission(existing);
			}
			const record = existing ?? missionService.createMission({
				id: ownerSessionId ?? (typeof params.id === 'string' && params.id.trim() ? params.id.trim() : undefined),
				title,
				mermaidText,
				ownerSessionId,
				ownerTier,
				ownerRankId,
				linkedSessionId: ownerSessionId,
				projectUri: resolvedProjectUri?.toString(),
			});
			if (mermaidText && record.mermaidText !== mermaidText) {
				missionService.updateMermaid(record.id, mermaidText);
			}
			if (params.open === true) {
				await missionService.openMissionEditor(record.id, { side: Boolean(params.side) });
			}
			const latest = missionService.getMission(record.id) ?? record;
			const parsed = parseMissionMermaidDag(latest.mermaidText);
			return {
				id: latest.id,
				title: latest.title,
				ownerSessionId: latest.ownerSessionId,
				ownerTier: latest.ownerTier,
				ownerTierTag: formatTierTag(latest.ownerTier),
				ownerRankId: latest.ownerRankId,
				missionName: getMissionDisplayName(roleConfig),
				nodeCount: parsed.nodes.length,
				edgeCount: parsed.edges.length,
				generatedEmployeeCount: missionService.getGeneratedEmployees(latest.id).length,
			};
		}

		case 'mission.import': {
			if (!missionService) {
				throw new Error('ADE Mission service is not available.');
			}
			let bundle: Record<string, unknown> = params;
			if (typeof params.text === 'string' && params.text.trim()) {
				try {
					const decoded = JSON.parse(params.text);
					if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
						throw new Error('Bundle JSON must be an object.');
					}
					bundle = { ...(decoded as Record<string, unknown>), ...params };
				} catch (err) {
					throw new Error(`Invalid Engineering bundle JSON: ${err instanceof Error ? err.message : String(err)}`);
				}
			} else if (params.bundle && typeof params.bundle === 'object' && !Array.isArray(params.bundle)) {
				bundle = { ...(params.bundle as Record<string, unknown>), ...params };
			}

			const mermaidText = typeof bundle.mermaidText === 'string'
				? bundle.mermaidText
				: (typeof bundle.mermaid === 'string' ? bundle.mermaid : '');
			if (mermaidText.trim()) {
				const validatedDag = parseMissionMermaidDag(mermaidText);
				if (validatedDag.error) {
					throw new Error(`Invalid Mission DAG in import bundle: ${validatedDag.error}`);
				}
			}
			const orchestrationText = typeof bundle.orchestrationText === 'string'
				? bundle.orchestrationText
				: (typeof bundle.orchestration === 'string' ? bundle.orchestration : '');
			const parsedOrch = orchestrationText.trim() ? parseOrchestrationGraph(orchestrationText) : undefined;
			if (parsedOrch?.error) {
				throw new Error(`Invalid Orchestration Mermaid in import bundle: ${parsedOrch.error}`);
			}

			const rawOwner = params.owner ?? params.ownerSessionId ?? params.mission ?? params.missionId ?? params.governor ?? params.governorSessionId ?? params.sessionId;
			const rawOwnerStr = typeof rawOwner === 'string' ? rawOwner.trim() : '';
			const rawOwnerLower = rawOwnerStr.toLowerCase();
			let ownerSessionId: string | undefined;
			let ownerTier: number = ADE_USER_TIER;
			let ownerRankId: string = 'user';
			let linkedAgent: IAdeAgent | undefined;

			if (isHumanUser) {
				if (rawOwnerStr && (rawOwnerLower === 'secretary' || rawOwnerLower === 'l0' || rawOwnerStr === ADE_SECRETARY_ID)) {
					ownerSessionId = ADE_SECRETARY_ID;
					ownerTier = ADE_SECRETARY_TIER;
					ownerRankId = 'secretary';
				} else if (rawOwnerStr) {
					linkedAgent = resolveAgentFromParams(projects, { id: rawOwnerStr });
					if (projects.isLockedByWorkTree?.(linkedAgent.id)) {
						throw new Error(localize('adeMissionCreateOnLockedDenied', "Session '{0}' is a locked Mission-generated employee and cannot host another Mission.", linkedAgent.label));
					}
					const ownerRankDef = resolveEffectiveRankDefinition(roleConfig, linkedAgent.role, projects.hasSubordinates(linkedAgent.id));
					ownerSessionId = linkedAgent.id;
					ownerTier = ownerRankDef.tier;
					ownerRankId = ownerRankDef.id;
				}
			} else if (isSecretaryCaller) {
				if (rawOwnerStr && rawOwnerLower !== 'secretary' && rawOwnerLower !== 'l0' && rawOwnerStr !== ADE_SECRETARY_ID) {
					throw new Error(localize('adeMissionForeignInitDenied', "Permission denied: Secretary (L0) can only create and operate its own L0 Mission; only session '{0}' or User (L-1) may create a Mission on that session.", rawOwnerStr));
				}
				ownerSessionId = ADE_SECRETARY_ID;
				ownerTier = ADE_SECRETARY_TIER;
				ownerRankId = 'secretary';
			} else if (callerAgent) {
				if (projects.isLockedByWorkTree?.(callerAgent.id)) {
					throw new Error(localize('adeMissionCreateOnLockedDenied', "Session '{0}' is a locked Mission-generated employee and cannot host another Mission.", callerAgent.label));
				}
				if (rawOwnerStr && rawOwnerStr !== callerAgent.id) {
					const targetAgent = resolveAgentFromParams(projects, { id: rawOwnerStr });
					if (targetAgent.id !== callerAgent.id) {
						throw new Error(localize('adeMissionForeignAgentInitDenied', "Permission denied: session '{0}' can only create and operate a Mission on itself, not on '{1}'.", callerAgent.label, targetAgent.label));
					}
				}
				linkedAgent = callerAgent;
				const ownerRankDef = resolveEffectiveRankDefinition(roleConfig, callerAgent.role, projects.hasSubordinates(callerAgent.id));
				ownerSessionId = callerAgent.id;
				ownerTier = ownerRankDef.tier;
				ownerRankId = ownerRankDef.id;
			} else {
				throw new Error(localize('adeMissionCallerRequired', "Permission denied: a verified owner session or User (L-1) identity is required to create a Mission."));
			}

			const bundleTitle = typeof params.title === 'string' && params.title.trim()
				? params.title.trim()
				: (typeof bundle.title === 'string' && bundle.title.trim() ? bundle.title.trim() : undefined);
			const rawProject = params.project ?? params.projectPath ?? params.path ?? params.uri;
			const resolvedProjectUri = linkedAgent?.projectUri
				?? (rawProject ? (findMatchingProject(projects, uriIdentity, rawProject)?.uri ?? toUri(rawProject)) : undefined)
				?? (ownerSessionId === ADE_SECRETARY_ID ? (navigation.focusedProject?.uri ?? projects.selectedProject?.uri ?? projects.projects[0]?.uri) : undefined);

			const existing = ownerSessionId ? missionService.getMissionByLinkedSession(ownerSessionId) : undefined;
			if (existing) {
				assertCanOperateMission(existing);
			}
			const runImportMutations = (): IAdeMissionRecord => {
				const created = existing ?? missionService.createMission({
					id: ownerSessionId ?? (typeof params.id === 'string' && params.id.trim() ? params.id.trim() : undefined),
					title: bundleTitle ?? linkedAgent?.label,
					mermaidText,
					orchestrationText: orchestrationText || undefined,
					ownerSessionId,
					ownerTier,
					ownerRankId,
					linkedSessionId: ownerSessionId,
					projectUri: resolvedProjectUri?.toString(),
				});
				if (bundleTitle && created.title !== bundleTitle) {
					missionService.renameMission(created.id, bundleTitle);
				}
				if (mermaidText !== created.mermaidText) {
					missionService.updateMermaid(created.id, mermaidText);
				}
				if (bundle.nodePrompts && typeof bundle.nodePrompts === 'object' && !Array.isArray(bundle.nodePrompts)) {
					const promptMap: Record<string, string> = {};
					for (const [k, v] of Object.entries(bundle.nodePrompts as Record<string, unknown>)) {
						if (typeof v === 'string') {
							promptMap[k] = v;
						}
					}
					missionService.updateNodePrompts(created.id, promptMap);
				}
				if (bundle.taskStatuses && typeof bundle.taskStatuses === 'object' && !Array.isArray(bundle.taskStatuses)) {
					const normalizedStatuses: Record<string, IMissionTaskStatusRecord> = {};
					const now = Date.now();
					for (const [nid, rawRec] of Object.entries(bundle.taskStatuses as Record<string, unknown>)) {
						if (rawRec && typeof rawRec === 'object') {
							const r = rawRec as Record<string, unknown>;
							const st = r.status;
							if (st === 'pending' || st === 'in_progress' || st === 'completed' || st === 'blocked') {
								const activeTokenIds = Array.isArray(r.activeTokenIds)
									? r.activeTokenIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
									: undefined;
								const artifactPtrs = Array.isArray(r.artifactPtrs)
									? r.artifactPtrs.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
									: undefined;
								normalizedStatuses[nid] = {
									status: st,
									updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : now,
									...(typeof r.completedAt === 'number' && Number.isFinite(r.completedAt) ? { completedAt: r.completedAt } : {}),
									...(typeof r.completedBy === 'string' && r.completedBy ? { completedBy: r.completedBy } : {}),
									...(typeof r.completedByLabel === 'string' && r.completedByLabel ? { completedByLabel: r.completedByLabel } : {}),
									...(typeof r.completedByTier === 'number' && Number.isFinite(r.completedByTier) ? { completedByTier: r.completedByTier } : {}),
									...(typeof r.note === 'string' && r.note ? { note: r.note } : {}),
									...(typeof r.assigneeNodeId === 'string' && r.assigneeNodeId ? { assigneeNodeId: r.assigneeNodeId } : {}),
									...(typeof r.assigneeLabel === 'string' && r.assigneeLabel ? { assigneeLabel: r.assigneeLabel } : {}),
									...(activeTokenIds && activeTokenIds.length > 0 ? { activeTokenIds } : {}),
									...(typeof r.lastTokenId === 'string' && r.lastTokenId ? { lastTokenId: r.lastTokenId } : {}),
									...(typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) ? { startedAt: r.startedAt } : {}),
									...(typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? { durationMs: r.durationMs } : {}),
									...(artifactPtrs && artifactPtrs.length > 0 ? { artifactPtrs } : {}),
									...(typeof r.blockedReason === 'string' && r.blockedReason ? { blockedReason: r.blockedReason } : {}),
									...(typeof r.lastError === 'string' && r.lastError ? { lastError: r.lastError } : {}),
								};
							}
						}
					}
					missionService.updateTaskStatuses(created.id, normalizedStatuses);
				}
				if (bundle.nodeChecks && typeof bundle.nodeChecks === 'object' && !Array.isArray(bundle.nodeChecks)) {
					for (const [nid, rawHooks] of Object.entries(bundle.nodeChecks as Record<string, unknown>)) {
						if (Array.isArray(rawHooks)) {
							for (const rawHook of rawHooks) {
								if (rawHook && typeof rawHook === 'object' && typeof (rawHook as { id?: unknown }).id === 'string') {
									missionService.upsertNodeCheck(created.id, nid, rawHook as Parameters<typeof missionService.upsertNodeCheck>[2]);
								}
							}
						}
					}
				}
				if (bundle.positions && typeof bundle.positions === 'object' && !Array.isArray(bundle.positions)) {
					missionService.clearNodePositions(created.id);
					missionService.updateNodePositions(created.id, bundle.positions as Record<string, { readonly x: number; readonly y: number }>);
				}
				if (orchestrationText) {
					missionService.updateOrchestrationText(created.id, orchestrationText, { replaceWhiteboards: true, replacePositions: true });
				}
				const rawLayoutMode = typeof bundle.orchestrationLayoutMode === 'string' ? bundle.orchestrationLayoutMode.trim().toLowerCase() : undefined;
				if (rawLayoutMode === 'lr' || rawLayoutMode === 'td' || rawLayoutMode === 'radial' || rawLayoutMode === 'grid') {
					missionService.updateOrchestrationLayoutMode?.(created.id, rawLayoutMode);
				}
				if (bundle.orchestrationPositions && typeof bundle.orchestrationPositions === 'object' && !Array.isArray(bundle.orchestrationPositions)) {
					missionService.clearOrchestrationPositions(created.id);
					missionService.updateOrchestrationPositions(created.id, bundle.orchestrationPositions as Record<string, { readonly x: number; readonly y: number }>);
				}
				if (bundle.whiteboards && typeof bundle.whiteboards === 'object' && !Array.isArray(bundle.whiteboards)) {
					const latestBeforeWb = missionService.getMission(created.id);
					const mergedWbs: Record<string, IOrchestrationWhiteboard> = { ...(latestBeforeWb?.whiteboards ?? {}) };
					for (const [wbId, rawWb] of Object.entries(bundle.whiteboards as Record<string, unknown>)) {
						if (rawWb && typeof rawWb === 'object') {
							const w = rawWb as Record<string, unknown>;
							const now = Date.now();
							mergedWbs[wbId] = {
								id: typeof w.id === 'string' && w.id.trim() ? w.id.trim() : wbId,
								title: typeof w.title === 'string' && w.title.trim() ? w.title.trim() : wbId,
								department: typeof w.department === 'string' && w.department.trim() ? w.department.trim() : 'General',
								content: typeof w.content === 'string' ? w.content : '',
								version: typeof w.version === 'number' && Number.isFinite(w.version) ? w.version : 1,
								createdAt: typeof w.createdAt === 'number' ? w.createdAt : now,
								updatedAt: typeof w.updatedAt === 'number' ? w.updatedAt : now,
							};
						}
					}
					missionService.updateWhiteboards(created.id, mergedWbs);
				}
				return created;
			};
			const rec = missionService.batch ? missionService.batch(runImportMutations) : runImportMutations();
			if (orchestrationText && missionRuntime && parsedOrch && !parsedOrch.error) {
				for (const staffNode of parsedOrch.nodes) {
					if (staffNode.kind === 'staff' && staffNode.hostAlias && staffNode.hostAlias.trim() && staffNode.hostAlias.trim().toLowerCase() !== 'local') {
						await missionRuntime.bindNodeHost(rec.id, staffNode.id, { hostAlias: staffNode.hostAlias.trim() }).catch(() => undefined);
					}
				}
			}
			if (params.open === true) {
				await missionService.openMissionEditor(rec.id, { side: Boolean(params.side) });
			}
			const latest = missionService.getMission(rec.id) ?? rec;
			const finalDag = parseMissionMermaidDag(latest.mermaidText);
			const finalOrch = parseOrchestrationGraph(latest.orchestrationText ?? '');
			return {
				ok: true,
				id: latest.id,
				title: latest.title,
				ownerSessionId: latest.ownerSessionId,
				ownerTier: latest.ownerTier,
				ownerTierTag: formatTierTag(latest.ownerTier),
				taskCount: finalDag.nodes.length,
				taskEdgeCount: finalDag.edges.length,
				groupCount: finalOrch.departments.length,
				staffCount: finalOrch.nodes.filter(n => n.kind === 'staff').length,
				whiteboardCount: finalOrch.nodes.filter(n => n.kind === 'whiteboard').length,
				orchestrationEdgeCount: finalOrch.edges.length,
				layoutMode: latest.orchestrationLayoutMode ?? finalOrch.layoutMode,
				generatedEmployeeCount: missionService.getGeneratedEmployees(latest.id).length,
			};
		}

		case 'mission.list': {
			if (!missionService) {
				return [];
			}
			const rawProject = params.project ?? params.projectPath ?? params.path ?? params.uri;
			const projectFilterUri = rawProject ? (findMatchingProject(projects, uriIdentity, rawProject)?.uri ?? toUri(rawProject)) : undefined;
			const projectFilterStr = projectFilterUri ? removeTrailingPathSeparator(projectFilterUri).toString() : undefined;
			return missionService.listMissions()
				.filter(m => {
					if (projectFilterStr) {
						if (!m.projectUri) {
							return false;
						}
						const recUri = toUri(m.projectUri);
						if (recUri && projectFilterUri) {
							if (!uriIdentity.extUri.isEqual(removeTrailingPathSeparator(recUri), removeTrailingPathSeparator(projectFilterUri))) {
								return false;
							}
						} else if (m.projectUri !== projectFilterStr) {
							return false;
						}
					}
					// Multi-tenant isolation: non-Human/non-Secretary callers see ONLY Missions they own, supervise, or belong to.
					if (!isHumanOrSecretary) {
						const rt = missionRuntime?.getRuntimeState(m.id);
						const perMissionCaller = missionCallerFor(m);
						const orchForFilter = m.orchestrationText?.trim() || m.orchestrationRuntime
							? (missionRuntime?.getOrchestrationState(m.id) ?? m.orchestrationRuntime)
							: undefined;
						const isInGraphLegacy = Boolean(
							perMissionCaller.callerSessionId
							&& rt
							&& Object.values(rt.boundary.nodeAssignments).some(a => a.agentId === perMissionCaller.callerSessionId),
						);
						const isOrchMember = Boolean(
							perMissionCaller.callerSessionId
							&& orchForFilter
							&& Object.values(orchForFilter.nodeAgentIds).includes(perMissionCaller.callerSessionId),
						);
						const isLinkedTreeEmployee = Boolean(
							callerAgent?.treeGovernorId
							&& (callerAgent.treeGovernorId === m.id || callerAgent.treeGovernorId === m.ownerSessionId),
						);
						if (!canCallerReadMission(m, perMissionCaller, rt) && !isInGraphLegacy && !isOrchMember && !isLinkedTreeEmployee) {
							return false;
						}
					}
					return true;
				})
				.map(m => {
					const parsed = parseMissionMermaidDag(m.mermaidText);
					const rt = missionRuntime?.getRuntimeState(m.id);
					const orch = m.orchestrationText?.trim() || m.orchestrationRuntime
						? (missionRuntime?.getOrchestrationState(m.id) ?? m.orchestrationRuntime)
						: undefined;
					const orchActiveCount = orch
						? Object.values(orch.tokens).filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join').length
						: 0;
					const legacyActiveCount = rt
						? Object.values(rt.tokens).filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_gate').length
						: 0;
					const activeTokenCount = orch ? orchActiveCount : legacyActiveCount;
					const effectiveStatus = orch
						? (orch.status ?? (orchActiveCount > 0 ? 'running' : 'idle'))
						: (rt?.status ?? 'idle');
					const perMissionCaller = missionCallerFor(m);
					return {
						id: m.id,
						title: m.title,
						ownerSessionId: m.ownerSessionId,
						ownerTier: m.ownerTier,
						ownerTierTag: formatTierTag(m.ownerTier),
						ownerRankId: m.ownerRankId,
						linkedSessionId: m.linkedSessionId,
						...(m.projectUri ? { projectUri: m.projectUri } : {}),
						status: effectiveStatus,
						activeTokenCount,
						canOperate: canCallerOperateMission(m, perMissionCaller),
						canRead: canCallerReadMission(m, perMissionCaller, rt),
						isBoundSupervisor: Boolean(perMissionCaller.callerSessionId && rt?.boundary.supervisors.some(s => s.id === perMissionCaller.callerSessionId)),
						nodeCount: parsed.nodes.length,
						edgeCount: parsed.edges.length,
						generatedEmployeeCount: missionService.getGeneratedEmployees(m.id).length,
						updatedAt: m.updatedAt,
					};
				});
		}

		case 'mission.rename': {
			if (!missionService) {
				throw new Error('ADE Mission service is not available.');
			}
			const explicitId = String(params.id ?? params.mission ?? params.missionId ?? params.owner ?? params.governor ?? params.governorSessionId ?? '').trim();
			const existing = explicitId
				? (missionService.getMission(explicitId) ?? missionService.getMissionByLinkedSession(explicitId))
				: (callerAgent ? findCallerAssociatedMission(callerAgent.id) : (isSecretaryCaller ? missionService.getMissionByLinkedSession(ADE_SECRETARY_ID) : undefined));
			if (!existing) {
				throw new Error(`Mission not found: ${explicitId || (callerAgent?.id ?? '')}`);
			}
			assertCanOperateMission(existing);
			const nextTitle = String(params.title ?? params.name ?? params.label ?? '').trim();
			if (!nextTitle) {
				throw new Error('A non-empty Mission --title is required for mission.rename.');
			}
			const updated = missionService.renameMission(existing.id, nextTitle) ?? existing;
			return {
				ok: true,
				id: updated.id,
				title: updated.title,
				updatedAt: updated.updatedAt,
			};
		}

		case 'mission.open': {
			if (!missionService) {
				throw new Error('ADE Mission service is not available.');
			}
			const explicitId = String(params.id ?? params.mission ?? params.missionId ?? params.owner ?? params.governor ?? params.governorSessionId ?? '').trim();
			const existing = explicitId
				? (missionService.getMission(explicitId) ?? missionService.getMissionByLinkedSession(explicitId))
				: (callerAgent ? findCallerAssociatedMission(callerAgent.id) : (isSecretaryCaller ? missionService.getMissionByLinkedSession(ADE_SECRETARY_ID) : undefined));
			const rawId = explicitId || (existing?.id ?? (callerAgent?.id ?? (isSecretaryCaller ? ADE_SECRETARY_ID : '')));
			if (!rawId) {
				throw new Error('Mission ID is required.');
			}
			const rawView = typeof params.view === 'string' ? params.view.trim().toLowerCase() : undefined;
			const viewMode = rawView === 'mission' ? 'mission' as const : rawView === 'orchestration' ? 'orchestration' as const : undefined;
			const openSiblingViews = rawView === 'both' || params.allViews === true;
			const openOpts = {
				side: Boolean(params.side),
				...(viewMode ? { viewMode } : {}),
				...(openSiblingViews ? { openSiblingViews: true } : {}),
			};
			if (existing) {
				assertCanOperateMission(existing);
				await missionService.openMissionEditor(existing.id, openOpts);
				return { opened: existing.id, title: existing.title, view: rawView ?? 'orchestration', ownerSessionId: existing.ownerSessionId, ownerTierTag: formatTierTag(existing.ownerTier) };
			}
			if (!isHumanUser) {
				throw new Error(`Mission not found: ${rawId}`);
			}
			const rec = missionService.ensureMission(rawId);
			await missionService.openMissionEditor(rec.id, openOpts);
			return { opened: rec.id, title: rec.title, view: rawView ?? 'orchestration', ownerSessionId: rec.ownerSessionId, ownerTierTag: formatTierTag(rec.ownerTier) };
		}

		case 'mission.blueprint.get':
		case 'mission.get': {
			if (!missionService) {
				throw new Error('ADE Mission service is not available.');
			}
			const explicitRawId = String(params.id ?? params.mission ?? params.missionId ?? params.owner ?? params.governor ?? params.governorSessionId ?? '').trim();
			let rec = explicitRawId
				? (missionService.getMission(explicitRawId) ?? missionService.getMissionByLinkedSession(explicitRawId))
				: (callerAgent
					? (findCallerAssociatedMission(callerAgent.id)
						?? missionService.listMissions().find(m =>
							missionRuntime?.getRuntimeState(m.id).boundary.supervisors.some(s => s.id === callerAgent.id),
						))
					: (isSecretaryCaller ? missionService.getMissionByLinkedSession(ADE_SECRETARY_ID) : undefined));
			if (!rec && !explicitRawId && isHumanOrSecretary) {
				const all = missionService.listMissions();
				if (all.length === 1) {
					rec = all[0];
				}
			}
			if (!rec) {
				throw new Error(`Mission not found: ${explicitRawId || (callerAgent?.id ?? '')}`);
			}
			assertCanReadMission(rec);
			return params.raw === true
				? rec.mermaidText
				: {
					id: rec.id,
					title: rec.title,
					ownerSessionId: rec.ownerSessionId,
					ownerTier: rec.ownerTier,
					ownerTierTag: formatTierTag(rec.ownerTier),
					ownerRankId: rec.ownerRankId,
					canOperate: canCallerOperateMission(rec, missionCallerFor(rec)),
					mermaidText: rec.mermaidText,
					parsed: parseMissionMermaidDag(rec.mermaidText),
					generatedEmployeeIds: missionService.getGeneratedEmployees(rec.id).map(a => a.id),
				};
		}

		case 'mission.blueprint.validate': {
			const text = typeof (params.text ?? params.mermaid) === 'string' ? String(params.text ?? params.mermaid) : '';
			const dual = parseDualViewBlueprintMarkdown(text);
			const parsed = parseMissionMermaidDag(dual.mermaidText);
			const errors: string[] = [];
			if (parsed.error) {
				errors.push(parsed.error);
			}
			let orchStaffCount = 0;
			let orchEdgeCount = 0;
			if (dual.orchestrationText?.trim()) {
				const parsedOrch = parseOrchestrationGraph(dual.orchestrationText);
				if (parsedOrch.error) {
					errors.push(`Orchestration section: ${parsedOrch.error}`);
				} else {
					orchStaffCount = parsedOrch.nodes.filter(n => n.kind === 'staff').length;
					orchEdgeCount = parsedOrch.edges.length;
				}
			}
			return {
				valid: errors.length === 0,
				errors,
				direction: parsed.direction,
				nodeCount: parsed.nodes.length,
				edgeCount: parsed.edges.length,
				taskDescriptionCount: Object.keys(dual.nodePrompts).length,
				...(dual.orchestrationText ? { hasOrchestration: true, staffCount: orchStaffCount, orchestrationEdgeCount: orchEdgeCount } : {}),
			};
		}

		case 'mission.blueprint.apply':
		case 'mission.setMermaid': {
			if (!missionService) {
				throw new Error('ADE Mission service is not available.');
			}
			const explicitId = String(params.id ?? params.mission ?? params.missionId ?? params.owner ?? params.governor ?? params.governorSessionId ?? '').trim();
			const existing = explicitId
				? (missionService.getMission(explicitId) ?? missionService.getMissionByLinkedSession(explicitId))
				: (callerAgent ? findCallerAssociatedMission(callerAgent.id) : (isSecretaryCaller ? missionService.getMissionByLinkedSession(ADE_SECRETARY_ID) : undefined));
			const rawId = explicitId || (existing?.id ?? (callerAgent?.id ?? (isSecretaryCaller ? ADE_SECRETARY_ID : '')));
			if (!existing) {
				if (!isHumanUser) {
					throw new Error(`Mission not found: ${rawId}`);
				}
			} else {
				assertCanOperateMission(existing);
			}
			const text = typeof (params.text ?? params.mermaid ?? params.mermaidText) === 'string'
				? String(params.text ?? params.mermaid ?? params.mermaidText)
				: '';
			const dual = parseDualViewBlueprintMarkdown(text);
			const parsed = parseMissionMermaidDag(dual.mermaidText);
			if (parsed.error) {
				throw new Error(parsed.error);
			}
			const parsedOrch = dual.orchestrationText?.trim() ? parseOrchestrationGraph(dual.orchestrationText) : undefined;
			if (parsedOrch?.error) {
				throw new Error(parsedOrch.error);
			}
			if (existing && (existing.mermaidText?.trim() || existing.orchestrationText?.trim())) {
				await missionRuntime?.createMissionCheckpoint?.(existing.id, {
					reason: 'pre_blueprint_apply',
					createdBy: callerAgent?.id ?? (isHumanUser ? 'human' : 'secretary'),
				}).catch(() => undefined);
			}
			const applyMutations = (): IAdeMissionRecord => {
				const targetRec = existing ?? missionService.ensureMission(rawId);
				missionService.updateMermaid(targetRec.id, dual.mermaidText);
				if (Object.keys(dual.nodePrompts).length > 0) {
					missionService.updateNodePrompts(targetRec.id, {
						...(targetRec.nodePrompts ?? {}),
						...dual.nodePrompts,
					});
				}
				if (dual.orchestrationText?.trim() && parsedOrch) {
					missionService.updateOrchestrationText(targetRec.id, dual.orchestrationText);
					const latestAfterOrch = missionService.getMission(targetRec.id) ?? targetRec;
					const nextWbs: Record<string, IOrchestrationWhiteboard> = { ...(latestAfterOrch.whiteboards ?? {}) };
					let wbAdded = false;
					const nowTs = Date.now();
					for (const wbNode of parsedOrch.nodes) {
						if (wbNode.kind === 'whiteboard' && !nextWbs[wbNode.id]) {
							const parsedWb = parsedOrch.whiteboardContents?.[wbNode.id];
							nextWbs[wbNode.id] = {
								id: wbNode.id,
								title: parsedWb?.title || wbNode.label,
								department: parsedWb?.department || wbNode.department || 'General',
								content: parsedWb?.content ?? wbNode.whiteboardContent ?? '',
								version: parsedWb?.version ?? wbNode.whiteboardVersion ?? 1,
								createdAt: nowTs,
								updatedAt: nowTs,
							};
							wbAdded = true;
						}
					}
					if (wbAdded) {
						missionService.updateWhiteboards(targetRec.id, nextWbs);
					}
				}
				return targetRec;
			};
			const rec = missionService.batch ? missionService.batch(applyMutations) : applyMutations();
			if (parsedOrch && missionRuntime) {
				for (const staffNode of parsedOrch.nodes) {
					if (staffNode.kind === 'staff' && staffNode.hostAlias && staffNode.hostAlias.trim() && staffNode.hostAlias.trim().toLowerCase() !== 'local') {
						await missionRuntime.bindNodeHost(rec.id, staffNode.id, { hostAlias: staffNode.hostAlias.trim() }).catch(() => undefined);
					}
				}
			}
			return {
				id: rec.id,
				ownerSessionId: rec.ownerSessionId,
				ownerTierTag: formatTierTag(rec.ownerTier),
				nodeCount: parsed.nodes.length,
				edgeCount: parsed.edges.length,
				appliedTaskDescriptions: Object.keys(dual.nodePrompts).length,
				...(parsedOrch ? { orchestrationApplied: true, staffCount: parsedOrch.nodes.filter(n => n.kind === 'staff').length } : {}),
				generatedEmployeeIds: missionService.getGeneratedEmployees(rec.id).map(a => a.id),
			};
		}

		case 'mission.remove':
		case 'mission.delete': {
			if (!missionService) {
				throw new Error('ADE Mission service is not available.');
			}
			const explicitId = String(params.id ?? params.mission ?? params.missionId ?? params.owner ?? params.governor ?? params.governorSessionId ?? '').trim();
			const existing = explicitId
				? (missionService.getMission(explicitId) ?? missionService.getMissionByLinkedSession(explicitId))
				: (callerAgent ? findCallerAssociatedMission(callerAgent.id) : (isSecretaryCaller ? missionService.getMissionByLinkedSession(ADE_SECRETARY_ID) : undefined));
			const rawId = explicitId || (existing?.id ?? (callerAgent?.id ?? (isSecretaryCaller ? ADE_SECRETARY_ID : '')));
			if (!existing) {
				return { deleted: false, id: rawId, removedEmployeeIds: [] };
			}
			assertCanOperateMission(existing);
			return await missionService.removeMissionWithEmployees(existing.id, { deleteEngineHistory: params.deleteEngineHistory === true });
		}

		case 'inbox.list': {
			if (!inboxService) {
				return [];
			}
			const rawGov = params.governor ?? params.governorId;
			const govFilter = typeof rawGov === 'string' && rawGov.trim()
				? resolveAgentFromParams(projects, { id: rawGov }).id
				: undefined;
			const listed = inboxService.list({
				unreadOnly: params.unreadOnly === true,
				governorSessionId: govFilter,
				includeResolved: params.includeResolved !== false,
			});
			if (isHumanOrSecretary) {
				return listed;
			}
			const allowedGovernors = new Set<string>();
			if (callerAgent) {
				allowedGovernors.add(callerAgent.id);
				for (const m of missionService?.listMissions() ?? []) {
					const mc = missionCallerFor(m);
					const rt = missionRuntime?.getRuntimeState(m.id);
					const isBoundSup = Boolean(rt?.boundary.supervisors.some(s => s.id === callerAgent.id));
					if (m.ownerSessionId === callerAgent.id || mc.isTopRankOrchestrationStaff || isBoundSup) {
						allowedGovernors.add(m.id);
						if (m.ownerSessionId) {
							allowedGovernors.add(m.ownerSessionId);
						}
					}
				}
			}
			return listed.filter(item => allowedGovernors.has(item.governorSessionId));
		}

		case 'inbox.post': {
			if (!inboxService) {
				throw new Error('ADE Inbox service is not available.');
			}
			// Verified non-Human/non-Secretary callers cannot spoof --from to impersonate another session.
			const gov = (!isHumanOrSecretary && callerAgent)
				? callerAgent
				: resolveAgentFromParams(projects, { id: params.from ?? params.governor ?? params.governorId ?? params.id });
			const message = typeof params.message === 'string' ? params.message.trim() : '';
			if (!message) {
				throw new Error('Inbox message text is required.');
			}
			const rawNode = params.node ?? params.nodeId;
			const resolvedRank = resolveAdeAgentRank(gov, projects.hasSubordinates(gov.id), roleConfig);
			const senderRank = resolvedRank === 'subordinate' ? 'employee' : resolvedRank;
			return inboxService.postGovernorMessage({
				governorSessionId: gov.id,
				message,
				title: typeof params.title === 'string' ? params.title : undefined,
				nodeId: typeof rawNode === 'string' ? rawNode : undefined,
				senderRank,
				senderAgentId: gov.id,
			});
		}

		case 'inbox.resolve': {
			if (!inboxService) {
				throw new Error('ADE Inbox service is not available.');
			}
			const id = typeof params.id === 'string' ? params.id.trim() : '';
			if (!id) {
				throw new Error('Inbox message ID (--id) is required.');
			}
			const targetItem = inboxService.list({ includeResolved: true }).find(i => i.id === id);
			if (!targetItem) {
				throw new Error(`Inbox item not found: ${id}`);
			}
			if (!isHumanUser && targetItem.kind === 'user_gate') {
				throw new Error('FORBIDDEN: Human Gate Inbox items can only be resolved by the Human User (L-1).');
			}
			if (!isHumanOrSecretary) {
				const allowedGovernors = new Set<string>();
				if (callerAgent) {
					allowedGovernors.add(callerAgent.id);
					for (const m of missionService?.listMissions() ?? []) {
						const mc = missionCallerFor(m);
						const rt = missionRuntime?.getRuntimeState(m.id);
						const isBoundSup = Boolean(rt?.boundary.supervisors.some(s => s.id === callerAgent.id));
						if (m.ownerSessionId === callerAgent.id || mc.isTopRankOrchestrationStaff || isBoundSup) {
							allowedGovernors.add(m.id);
							if (m.ownerSessionId) {
								allowedGovernors.add(m.ownerSessionId);
							}
						}
					}
				}
				if (!allowedGovernors.has(targetItem.governorSessionId)) {
					throw new Error(`FORBIDDEN: caller lacks authority to resolve inbox item "${id}" belonging to another tenant.`);
				}
			}
			const resolved = await inboxService.resolveItem(id, typeof params.resolution === 'string' ? params.resolution : undefined);
			if (!resolved) {
				throw new Error(`Inbox item not found: ${id}`);
			}
			return resolved;
		}

		case 'inbox.markRead': {
			if (!inboxService) {
				throw new Error('ADE Inbox service is not available.');
			}
			const id = params.all === true ? '' : (typeof params.id === 'string' ? params.id.trim() : '');
			if (!isHumanOrSecretary) {
				const allowedGovernors = new Set<string>();
				if (callerAgent) {
					allowedGovernors.add(callerAgent.id);
					for (const m of missionService?.listMissions() ?? []) {
						const mc = missionCallerFor(m);
						const rt = missionRuntime?.getRuntimeState(m.id);
						const isBoundSup = Boolean(rt?.boundary.supervisors.some(s => s.id === callerAgent.id));
						if (m.ownerSessionId === callerAgent.id || mc.isTopRankOrchestrationStaff || isBoundSup) {
							allowedGovernors.add(m.id);
							if (m.ownerSessionId) {
								allowedGovernors.add(m.ownerSessionId);
							}
						}
					}
				}
				const allItems = inboxService.list({ includeResolved: true });
				if (id) {
					const targetItem = allItems.find(i => i.id === id);
					if (!targetItem) {
						throw new Error(`Inbox item not found: ${id}`);
					}
					if (!allowedGovernors.has(targetItem.governorSessionId)) {
						throw new Error(`FORBIDDEN: caller lacks authority to mark inbox item "${id}" belonging to another tenant as read.`);
					}
					await inboxService.markRead(id);
				} else {
					for (const item of allItems) {
						if (item.unread && allowedGovernors.has(item.governorSessionId)) {
							await inboxService.markRead(item.id);
						}
					}
				}
				const scopedUnread = inboxService.list({ unreadOnly: true, includeResolved: false })
					.filter(i => allowedGovernors.has(i.governorSessionId)).length;
				return { unreadCount: scopedUnread };
			}
			if (params.all === true) {
				await inboxService.markRead();
				return { unreadCount: inboxService.unreadCount };
			}
			await inboxService.markRead(id || undefined);
			return { unreadCount: inboxService.unreadCount };
		}

		case 'host.list': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			return cloudHosts.listHosts();
		}

		case 'host.get':
		case 'host.info': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			const rawTarget = String(params.target ?? params.id ?? params.alias ?? params.host ?? '').trim();
			if (!rawTarget) {
				throw new Error('Cloud Host ID or alias is required.');
			}
			const found = await cloudHosts.getHost(rawTarget);
			if (!found) {
				throw new Error(`Cloud Host not found: ${rawTarget}`);
			}
			return found;
		}

		case 'host.upsert': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			const lookupKey = String(params.id ?? params.alias ?? params.target ?? '').trim();
			const existing = lookupKey ? await cloudHosts.getHost(lookupKey) : undefined;
			const previousAlias = existing?.alias;
			const hostName = String(params.hostName ?? params.host ?? existing?.hostName ?? '').trim();
			if (!hostName) {
				throw new Error('Cloud Host address (--host) is required.');
			}
			const rawOs = typeof params.os === 'string' ? params.os.trim().toLowerCase() : undefined;
			const osKind: AdeCloudHostOs | undefined = rawOs === 'windows' || rawOs === 'macos' || rawOs === 'linux' ? rawOs : existing?.os;
			const rawStrict = typeof params.strictHostKeyChecking === 'string' ? params.strictHostKeyChecking.trim() : undefined;
			const strictCheck = rawStrict === 'yes' || rawStrict === 'accept-new' || rawStrict === 'no' ? rawStrict : existing?.strictHostKeyChecking;
			const saved = await cloudHosts.upsertHost({
				id: typeof params.id === 'string' && params.id.trim() ? params.id.trim() : existing?.id,
				name: (typeof params.name === 'string' && params.name.trim() ? params.name.trim() : existing?.name) ?? hostName,
				alias: typeof params.alias === 'string' && params.alias.trim() ? params.alias.trim() : existing?.alias,
				hostName,
				user: typeof params.user === 'string' ? (params.user.trim() || undefined) : existing?.user,
				port: typeof params.port === 'number' ? params.port : (typeof params.port === 'string' && /^\d+$/.test(params.port) ? Number(params.port) : existing?.port),
				os: osKind,
				identityFile: typeof params.identityFile === 'string' ? params.identityFile : existing?.identityFile,
				proxyJump: typeof params.proxyJump === 'string' ? params.proxyJump : existing?.proxyJump,
				strictHostKeyChecking: strictCheck,
				defaultDirectory: typeof params.defaultDirectory === 'string' ? params.defaultDirectory : existing?.defaultDirectory,
				notes: typeof params.notes === 'string' ? params.notes : existing?.notes,
			});
			if (previousAlias && previousAlias.toLowerCase() !== saved.alias.toLowerCase()) {
				projects.migrateCloudHostAlias?.(previousAlias, saved.alias);
				void commandService?.executeCommand?.('aexus.agentEngines.invalidateCloudHost', previousAlias, saved.alias);
			} else {
				void commandService?.executeCommand?.('aexus.agentEngines.invalidateCloudHost', saved.alias);
			}
			return saved;
		}

		case 'host.delete': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			const rawTarget = String(params.target ?? params.id ?? params.alias ?? params.host ?? '').trim();
			if (!rawTarget) {
				throw new Error('Cloud Host ID or alias is required.');
			}
			const existing = await cloudHosts.getHost(rawTarget).catch(() => undefined);
			const ok = await cloudHosts.deleteHost(rawTarget);
			if (!ok) {
				throw new Error(`Cloud Host not found: ${rawTarget}`);
			}
			void commandService?.executeCommand?.('aexus.agentEngines.invalidateCloudHost', existing?.alias ?? rawTarget);
			return { deleted: rawTarget };
		}

		case 'host.test': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			const rawTarget = String(params.target ?? params.id ?? params.alias ?? params.host ?? '').trim();
			if (!rawTarget) {
				throw new Error('Cloud Host ID or alias is required.');
			}
			return cloudHosts.testConnection(rawTarget);
		}

		case 'host.browse': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			const rawTarget = String(params.target ?? params.host ?? params.alias ?? '').trim();
			if (!rawTarget) {
				throw new Error('Cloud Host alias is required.');
			}
			const matched = await cloudHosts.getHost(rawTarget);
			const authority = matched?.alias ?? rawTarget;
			const remotePath = typeof params.path === 'string' && params.path.trim()
				? params.path.trim()
				: (matched?.defaultDirectory || matched?.recentDirectories[0] || '/');
			const entries = await cloudHosts.remoteReadDir(authority, remotePath);
			return { host: authority, path: remotePath, entries };
		}

		case 'host.import': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			return cloudHosts.importFromVsCodeAndSshConfig();
		}

		case 'host.open': {
			const target = typeof params.target === 'string' && params.target.trim() ? params.target.trim() : undefined;
			await editors.openCloudHosts?.(target);
			return { opened: true, ...(target ? { target } : {}) };
		}

		case 'role.schema.get':
			return roleConfig;

		case 'role.apis':
			return ADE_PRIMITIVE_APIS.map(api => ({
				id: api.id,
				category: api.category,
				label: api.label,
				description: api.description,
				actions: api.actions,
				dangerous: Boolean(api.dangerous),
			}));

		case 'role.presets':
			return ADE_ORGANIZATION_PRESETS.map(preset => ({
				id: preset.id,
				name: preset.name,
				description: preset.description,
				ranks: preset.config.ranks.map(r => ({ id: r.id, name: r.name, tier: r.tier, pureExecution: Boolean(r.pureExecution) })),
			}));

		case 'role.schema.set': {
			if (!roleSchemaService) {
				throw new Error('ADE Role Schema service is not available.');
			}
			if (typeof params.presetId === 'string' && params.presetId.trim()) {
				return roleSchemaService.applyPreset(params.presetId.trim());
			}
			const rawConfig = params.config ?? params.schema;
			if (!rawConfig || typeof rawConfig !== 'object') {
				throw new Error('Expected config object or presetId for role.schema.set.');
			}
			return roleSchemaService.updateConfig(normalizeAdeOrganizationConfig(rawConfig));
		}

		case 'role.schema.reset': {
			if (!roleSchemaService) {
				throw new Error('ADE Role Schema service is not available.');
			}
			return roleSchemaService.resetToDefault();
		}

		case 'role.studio.open': {
			const rankId = typeof params.rankId === 'string' && params.rankId.trim() ? params.rankId.trim() : undefined;
			await editors.openRoleStudio?.(rankId);
			return { opened: true, ...(rankId ? { rankId } : {}) };
		}

		default:
			throw new Error(localize('adeUnknownControlAction', "Unknown ADE control action: {0}", String(action)));
	}
}
