/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAdeCloudHostBackendService } from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	ADE_CONTROL_EXECUTE_COMMAND_ID,
	ADE_GET_ROLE_SYNC_SNAPSHOT_COMMAND_ID,
	ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID,
	ADE_SET_SESSION_GOAL_BANNER_COMMAND_ID,
	ADE_SET_SESSION_INITIALIZING_COMMAND_ID,
	ADE_SYNC_SESSION_PREFERENCES_COMMAND_ID,
	IAdeControlDispatchRequest,
} from '../../../../platform/ade/common/adeControl.js';
import {
	ADE_FULL_SUPERVISOR_MISSION_ACTIONS,
	ADE_IN_GRAPH_UNIVERSAL_ACTIONS,
	ADE_PARTIAL_SUPERVISOR_MISSION_ACTIONS,
	parseOrchestrationLimitsRequest,
} from '../../../../platform/ade/common/adeControlPolicy.js';
import {
	AdeThinkingLevel,
	IAdeEngineeringBackendService,
	IAdeInboxService,
} from '../../../../platform/ade/common/adeEngineering.js';
import { resolveSupervisorJurisdiction } from '../../../../platform/ade/common/adeMissionBoundary.js';
import { parseMissionMermaidDag } from '../../../../platform/ade/common/adeMissionDag.js';
import { ADE_USER_TIER, formatTierTag } from '../../../../platform/ade/common/adeRankResize.js';
import {
	canRankSupervise,
	checkAdeApiPermission,
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	getTopRankDefinition,
	isPureExecutionRank,
	resolveEffectiveRankDefinition,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import { ISCMService } from '../../scm/common/scm.js';
import {
	ADE_SECRETARY_ID,
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectsService,
	resolveAdeAgentRank,
} from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { assertSupervisorHasAuthorityOverTarget, executeAdeMissionRuntimeAction, isAdeMissionRuntimeAction } from './adeMissionControlHandler.js';
import { IAdeMissionRuntimeService } from './adeMissionRuntime.js';
import { canCallerOperateMission, canCallerReadMission, IAdeMissionCaller, IAdeMissionRecord, IAdeMissionService } from './adeMissionStore.js';
import { executeAdeRankOrDocsAction, isAdeRankOrDocsAction } from './adeRankApiHandler.js';
import {
	buildAdeAgentRoleContext,
	buildAdeRoleSyncSnapshot,
	formatAdeAgentSubtreeLines,
	resolveAdePromptContext,
	resolveInGraphMissionBinding,
	resolveOrchestrationStaffAuthority,
	toUri,
	tryGetService,
} from './adeRolePromptResolver.js';
import {
	ADE_SESSION_AND_PROJECT_ACTIONS,
	executeAdeSessionOrProjectControlAction,
} from './adeSessionControlActions.js';
import { IAdeSessionsService } from './adeSessionsService.js';
import {
	ADE_SYSTEM_CONTROL_ACTIONS,
	executeAdeSystemControlAction,
} from './adeSystemControlActions.js';

export {
	buildAdeAgentRoleContext,
	buildAdeRoleSyncSnapshot,
	formatAdeAgentSubtreeLines,
	resolveAdePromptContext,
};

function isStrictDescendantOf(projects: IAdeProjectsService, candidateId: string, ancestorId: string): boolean {
	if (!candidateId || !ancestorId || candidateId === ancestorId) {
		return false;
	}
	const visited = new Set<string>([candidateId]);
	let current = projects.getAgent(candidateId)?.parentId;
	while (current) {
		if (current === ancestorId) {
			return true;
		}
		if (visited.has(current)) {
			break;
		}
		visited.add(current);
		current = projects.getAgent(current)?.parentId;
	}
	return false;
}

const MISSION_OWNER_SCOPED_ACTIONS = new Set([
	'mission.init',
	'mission.create',
	'mission.import',
	'mission.open',
	'mission.setMermaid',
	'mission.blueprint.apply',
	'mission.remove',
	'mission.delete',
]);

export async function executeAdeControlRequest(
	accessor: ServicesAccessor,
	arg1: IAdeControlDispatchRequest | string,
	arg2?: Record<string, unknown>,
): Promise<unknown> {
	const request: IAdeControlDispatchRequest = typeof arg1 === 'string'
		? { action: arg1, params: arg2 }
		: arg1;
	const action = request?.action;
	const params = request?.params ?? {};

	const modes = accessor.get(IWorkbenchModeService);
	const projects = accessor.get(IAdeProjectsService);
	const navigation = accessor.get(IProjectNavigationService);
	const editors = accessor.get(IAdeEditorService);
	const sessions = accessor.get(IAdeSessionsService);
	const uriIdentity = accessor.get(IUriIdentityService);
	const commandService = accessor.get(ICommandService);
	const editorService = tryGetService(accessor, IEditorService);
	const workspaceEditing = tryGetService(accessor, IWorkspaceEditingService);
	const contextService = tryGetService(accessor, IWorkspaceContextService);
	const environmentService = tryGetService(accessor, IWorkbenchEnvironmentService);
	const fileService = tryGetService(accessor, IFileService);
	const configurationService = tryGetService(accessor, IConfigurationService);
	const pathService = tryGetService(accessor, IPathService);
	const chatService = tryGetService(accessor, IChatService);
	const scmService = tryGetService(accessor, ISCMService);
	const viewsService = tryGetService(accessor, IViewsService);
	const layoutService = tryGetService(accessor, IWorkbenchLayoutService);
	const missionService = tryGetService(accessor, IAdeMissionService);
	const missionRuntime = tryGetService(accessor, IAdeMissionRuntimeService);
	const engineeringBackend = tryGetService(accessor, IAdeEngineeringBackendService);
	const inboxService = tryGetService(accessor, IAdeInboxService);
	const cloudHosts = tryGetService(accessor, IAdeCloudHostBackendService);
	const roleSchemaService = tryGetService(accessor, IAdeRoleSchemaService);
	const roleConfig = roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;

	const rawCallerStr = typeof params.caller === 'string' ? params.caller.trim().toLowerCase() : '';
	const isVerifiedSessionCaller = params._verifiedCaller === true;
	const rawCallerSessionId = typeof params._callerSessionId === 'string' && params._callerSessionId.trim()
		? params._callerSessionId.trim()
		: undefined;
	const isSecretaryCaller = (rawCallerStr === 'secretary' || rawCallerStr === 'l0')
		&& (!isVerifiedSessionCaller || rawCallerSessionId === ADE_SECRETARY_ID);
	const isHumanUser = !isVerifiedSessionCaller && !isSecretaryCaller && (
		params.caller === undefined || params.caller === null || !rawCallerStr || rawCallerStr === 'user' || rawCallerStr === 'human' || rawCallerStr === 'l-1'
	);
	const isHumanOrSecretary = isHumanUser || isSecretaryCaller;

	const buildMissionCallerFor = (mission: IAdeMissionRecord | undefined, agentCandidate: IAdeAgent | undefined, sessionIdCandidate: string | undefined): IAdeMissionCaller => {
		const orchAuth = !isHumanOrSecretary
			? resolveOrchestrationStaffAuthority(agentCandidate, mission, projects, roleConfig, missionRuntime)
			: undefined;
		return {
			isHumanUser,
			isSecretary: isSecretaryCaller,
			callerSessionId: agentCandidate?.id ?? sessionIdCandidate,
			...(orchAuth?.isTopRank ? { isTopRankOrchestrationStaff: true } : {}),
			...(orchAuth?.isMember ? { isOrchestrationMember: true } : {}),
		};
	};

	const findCallerAssociatedMission = (sessionIdCandidate: string | undefined): IAdeMissionRecord | undefined => {
		if (!missionService || !sessionIdCandidate) {
			return undefined;
		}
		const direct = missionService.getMissionByLinkedSession(sessionIdCandidate);
		if (direct) {
			return direct;
		}
		const live = missionRuntime?.findMissionForAgent(sessionIdCandidate);
		if (live?.mission) {
			return live.mission;
		}
		const agentObj = projects.getAgent(sessionIdCandidate);
		if (agentObj?.treeGovernorId) {
			return missionService.getMission(agentObj.treeGovernorId) ?? missionService.getMissionByLinkedSession(agentObj.treeGovernorId);
		}
		return undefined;
	};

	// Any session (at any rank L1..LN) that creates or owns a Mission — or is the top-rank L1 leader on a
	// User-created standalone Orchestration canvas — is authorized to operate THAT Mission's orchestration.
	let isSelfOwnedMissionAction = false;
	if (!isHumanUser && MISSION_OWNER_SCOPED_ACTIONS.has(action)) {
		const rawTarget = String(params.id ?? params.mission ?? params.missionId ?? params.owner ?? params.governor ?? params.governorSessionId ?? params.sessionId ?? '').trim();
		const callerCandidate = rawCallerSessionId ? projects.getAgent(rawCallerSessionId) : undefined;
		const targetMission = rawTarget
			? (missionService?.getMission(rawTarget) ?? missionService?.getMissionByLinkedSession(rawTarget))
			: (rawCallerSessionId ? findCallerAssociatedMission(rawCallerSessionId) : (isSecretaryCaller ? missionService?.getMissionByLinkedSession(ADE_SECRETARY_ID) : undefined));
		const preliminaryCaller = buildMissionCallerFor(targetMission, callerCandidate, rawCallerSessionId);
		if (targetMission && !canCallerOperateMission(targetMission, preliminaryCaller)) {
			const ownerTierTag = formatTierTag(targetMission.ownerTier);
			const ownerLabel = targetMission.ownerSessionId === ADE_SECRETARY_ID
				? 'Secretary'
				: (targetMission.ownerSessionId ? (projects.getAgent(targetMission.ownerSessionId)?.label ?? targetMission.ownerSessionId) : 'User');
			throw new Error(localize(
				'adeMissionOwnerOnlyDeniedEarly',
				"Permission denied: Mission '{0}' is owned by '{1}' ({2}). Only that owner session or User (L-1) can operate this Mission's orchestration.",
				targetMission.title,
				ownerLabel,
				ownerTierTag,
			));
		}
		if (!isHumanOrSecretary && rawCallerSessionId && callerCandidate && !projects.isArchived(callerCandidate.id)) {
			if (action === 'mission.init' || action === 'mission.create' || action === 'mission.import') {
				if (!projects.isLockedByWorkTree?.(callerCandidate.id)) {
					isSelfOwnedMissionAction = !rawTarget || rawTarget === callerCandidate.id;
				}
			} else if (targetMission) {
				isSelfOwnedMissionAction = Boolean(
					targetMission.ownerSessionId === callerCandidate.id
					|| (preliminaryCaller.isTopRankOrchestrationStaff && (!targetMission.ownerSessionId || targetMission.ownerTier <= ADE_USER_TIER)),
				);
			}
		}
	}

	const isReadOnlyLimitsQuery = action === 'orchestration.limits'
		&& parseOrchestrationLimitsRequest(params, { isHumanUser }).isReadOnlyQuery;
	let isBoundOffGraphSupervisorAction = false;
	const needsPartialSup = ADE_PARTIAL_SUPERVISOR_MISSION_ACTIONS.has(action) || isReadOnlyLimitsQuery;
	const needsFullSup = ADE_FULL_SUPERVISOR_MISSION_ACTIONS.has(action) && !isReadOnlyLimitsQuery;
	if (!isHumanUser && rawCallerSessionId && (needsPartialSup || needsFullSup)) {
		const rawExplicitTarget = String(params.mission ?? params.missionId ?? params.governor ?? '').trim();
		const fallbackParamId = !rawExplicitTarget && typeof params.id === 'string' && params.id.trim()
			? (missionService?.getMission(params.id.trim()) ?? missionService?.getMissionByLinkedSession(params.id.trim()))
			: undefined;
		const targetMission = rawExplicitTarget
			? (missionService?.getMission(rawExplicitTarget) ?? missionService?.getMissionByLinkedSession(rawExplicitTarget))
			: (fallbackParamId ?? missionService?.getMissionByLinkedSession(rawCallerSessionId) ?? missionService?.listMissions().find(m =>
				missionRuntime?.getRuntimeState(m.id).boundary.supervisors.some(s => s.id === rawCallerSessionId)
				|| (Boolean(m.orchestrationText?.trim()) && Object.values(missionRuntime?.getOrchestrationState(m.id).nodeAgentIds ?? {}).includes(rawCallerSessionId)),
			));
		if (targetMission && missionRuntime) {
			const rt = missionRuntime.getRuntimeState(targetMission.id);
			const isOwner = targetMission.ownerSessionId === rawCallerSessionId;
			const callerObj = projects.getAgent(rawCallerSessionId);
			const callerRankDef = callerObj
				? resolveEffectiveRankDefinition(roleConfig, callerObj.role, projects.hasSubordinates(callerObj.id))
				: undefined;
			const orchAuth = resolveOrchestrationStaffAuthority(callerObj, targetMission, projects, roleConfig, missionRuntime);
			const isOrchMember = orchAuth.isMember;
			const isOrchSup = isOrchMember && Boolean(callerRankDef && !callerRankDef.pureExecution && callerRankDef.canHaveSubordinates);
			const isOrchTopRank = orchAuth.isTopRank;
			const isMemberAllowedAction = isOrchMember && (action === 'org.escalate' || isReadOnlyLimitsQuery);
			const callerCanSupervise = Boolean(callerRankDef && !callerRankDef.pureExecution && callerRankDef.canHaveSubordinates);
			const isBoundSup = isOwner || isOrchSup || isMemberAllowedAction || (callerCanSupervise && rt.boundary.supervisors.some(s => s.id === rawCallerSessionId));
			if (needsPartialSup && isBoundSup) {
				isBoundOffGraphSupervisorAction = true;
			} else if (needsFullSup && isBoundSup) {
				const graph = parseMissionMermaidDag(targetMission.mermaidText);
				const jur = resolveSupervisorJurisdiction(
					rt.boundary,
					rawCallerSessionId,
					graph.nodes.map(n => n.id),
					{ ownerSessionId: targetMission.ownerSessionId },
				);
				if (isOwner || isOrchTopRank || jur.hasFullJurisdiction) {
					isBoundOffGraphSupervisorAction = true;
				}
			}
		}
	}

	// Fixed Aexus-Code Kernel Primitive API Authorization Gate:
	const isInGraphBoundRankReadAction = Boolean(
		!isHumanUser
		&& rawCallerSessionId
		&& (action === 'rank.names' || action === 'rank.list' || action === 'rank.get' || isReadOnlyLimitsQuery)
		&& (() => {
			const callerObj = projects.getAgent(rawCallerSessionId);
			return Boolean(callerObj && !projects.isArchived(callerObj.id) && resolveInGraphMissionBinding(callerObj, missionRuntime, missionService));
		})(),
	);
	const permission = checkAdeApiPermission(roleConfig, params.caller, action);
	if (!permission.allowed && !isSelfOwnedMissionAction && !isBoundOffGraphSupervisorAction && !isInGraphBoundRankReadAction) {
		throw new Error(permission.reason ?? localize('adeApiPermissionDenied', "Permission denied for action '{0}'.", String(action)));
	}

	let callerAgent: IAdeAgent | undefined;
	let callerHasSubs = false;
	let effectiveCallerRank = permission.rankId ?? rawCallerStr;
	if (!isHumanOrSecretary && (isVerifiedSessionCaller || rawCallerSessionId)) {
		if (!rawCallerSessionId) {
			throw new Error(localize('adeCallerSessionInactive', "Permission denied: caller session no longer active."));
		}
		const foundCaller = projects.getAgent(rawCallerSessionId);
		if (!foundCaller || projects.isArchived(foundCaller.id)) {
			throw new Error(localize('adeCallerSessionInactive', "Permission denied: caller session no longer active."));
		}
		callerAgent = foundCaller;
		callerHasSubs = projects.hasSubordinates(foundCaller.id);
		const liveRank = resolveAdeAgentRank(foundCaller, callerHasSubs, roleConfig);
		const liveRankDef = resolveEffectiveRankDefinition(roleConfig, foundCaller.role, callerHasSubs);
		const isInGraphBoundNode = Boolean(resolveInGraphMissionBinding(foundCaller, missionRuntime, missionService));
		const isInGraphAllowedAction = (ADE_IN_GRAPH_UNIVERSAL_ACTIONS.has(action) || isReadOnlyLimitsQuery)
			&& (action === 'whoami' || action === 'docs.read' || action === 'api.update' || isInGraphBoundNode);
		// Live demotion guard: a session demoted to pure execution can NEVER invoke non-in-graph control APIs,
		// even if it was previously recorded as a Mission owner or off-graph supervisor.
		if (!isInGraphAllowedAction && (liveRankDef.pureExecution || isPureExecutionRank(roleConfig, liveRank))) {
			throw new Error(localize('adeCallerDemotedToPure', "Permission denied: caller session rank '{0}' is pure execution and cannot invoke ADE control APIs.", liveRankDef.name));
		}
		if (!isSelfOwnedMissionAction && !isBoundOffGraphSupervisorAction && !isInGraphAllowedAction) {
			if (liveRank.toLowerCase() !== rawCallerStr) {
				const livePerm = checkAdeApiPermission(roleConfig, liveRank, action);
				if (!livePerm.allowed) {
					throw new Error(livePerm.reason ?? localize('adeApiPermissionDeniedLive', "Permission denied: live rank '{0}' is not authorized for action '{1}'.", liveRankDef.name, String(action)));
				}
			}
		}
		const tokenRankDef = resolveEffectiveRankDefinition(roleConfig, permission.rankId ?? rawCallerStr, false);
		effectiveCallerRank = liveRankDef.tier >= tokenRankDef.tier ? liveRankDef.id : tokenRankDef.id;
	}

	const missionCallerFor = (mission: IAdeMissionRecord): IAdeMissionCaller =>
		buildMissionCallerFor(mission, callerAgent, rawCallerSessionId);

	const assertCanOperateMission = (mission: IAdeMissionRecord): void => {
		if (canCallerOperateMission(mission, missionCallerFor(mission))) {
			return;
		}
		const ownerTierTag = formatTierTag(mission.ownerTier);
		const ownerLabel = mission.ownerSessionId === ADE_SECRETARY_ID
			? 'Secretary'
			: (mission.ownerSessionId ? (projects.getAgent(mission.ownerSessionId)?.label ?? mission.ownerSessionId) : 'User');
		throw new Error(localize(
			'adeMissionOwnerOnlyDenied',
			"Permission denied: Mission '{0}' is owned by '{1}' ({2}). Only that owner session or User (L-1) can operate this Mission's orchestration.",
			mission.title,
			ownerLabel,
			ownerTierTag,
		));
	};

	const assertCanReadMission = (mission: IAdeMissionRecord): void => {
		const rt = missionRuntime?.getRuntimeState(mission.id);
		if (canCallerReadMission(mission, missionCallerFor(mission), rt)) {
			return;
		}
		throw new Error(localize(
			'adeMissionReadDenied',
			"Permission denied: only User (L-1), Secretary (L0), the Mission owner, or a bound off-graph supervisor can read Mission '{0}' topology.",
			mission.title,
		));
	};

	const topRankDef = getTopRankDefinition(roleConfig);
	const effectiveCallerDef = !isHumanOrSecretary
		? resolveEffectiveRankDefinition(roleConfig, effectiveCallerRank, callerHasSubs)
		: undefined;

	const assertCanSuperviseRank = (targetRankId: string, targetHasSubs: boolean, actionLabel: string): void => {
		if (isHumanOrSecretary) {
			return;
		}
		if (!canRankSupervise(roleConfig, effectiveCallerRank, callerHasSubs, targetRankId, targetHasSubs)) {
			const targetDef = resolveEffectiveRankDefinition(roleConfig, targetRankId, targetHasSubs);
			throw new Error(localize(
				'adeRankSuperviseDenied',
				"Permission denied: rank '{0}' (L{1}) cannot {2} rank '{3}' (L{4}).",
				effectiveCallerDef!.name,
				effectiveCallerDef!.tier,
				actionLabel,
				targetDef.name,
				targetDef.tier,
			));
		}
	};

	const assertTargetInCallerSubtree = (target: IAdeAgent, actionLabel: string, allowSelf = false): void => {
		if (isHumanOrSecretary || !callerAgent) {
			return;
		}
		let inScope = allowSelf
			? (target.id === callerAgent.id || isStrictDescendantOf(projects, target.id, callerAgent.id))
			: isStrictDescendantOf(projects, target.id, callerAgent.id);
		if (!inScope && target.id !== callerAgent.id && missionService && missionRuntime) {
			const orchAuth = assertSupervisorHasAuthorityOverTarget({
				projects,
				sessions,
				missionService,
				missionRuntime,
				commandService,
				roleConfig,
				isHumanUser,
				isSecretary: isSecretaryCaller,
				callerAgent,
				callerSessionId: callerAgent.id,
				isStrictDescendant: (candidateId, ancestorId) => isStrictDescendantOf(projects, candidateId, ancestorId),
			}, target);
			if (orchAuth.authorized && orchAuth.viaMissionId) {
				inScope = true;
			}
		}
		if (!inScope) {
			throw new Error(localize(
				'adeSubtreeScopeDenied',
				"Permission denied: session '{0}' is outside your subordinate subtree and cannot be targeted by {1}.",
				target.label,
				actionLabel,
			));
		}
	};

	const assertCanManageTarget = (target: IAdeAgent, actionLabel: string): void => {
		if (isHumanOrSecretary) {
			return;
		}
		if (callerAgent && target.id === callerAgent.id) {
			throw new Error(localize('adeCannotSelfTarget', "Permission denied: a session cannot {0} itself.", actionLabel));
		}
		const targetHasSubs = projects.hasSubordinates(target.id);
		const targetRank = resolveAdeAgentRank(target, targetHasSubs, roleConfig);
		assertCanSuperviseRank(targetRank, targetHasSubs, actionLabel);
		assertTargetInCallerSubtree(target, actionLabel, false);
	};

	const assertCanDestroyTreeIfPresent = (target: IAdeAgent): void => {
		if (isHumanOrSecretary) {
			return;
		}
		const hasTree = Boolean(target.treeType);
		if (!hasTree) {
			return;
		}
		const destroyTokenPerm = checkAdeApiPermission(roleConfig, params.caller, 'mission.remove');
		if (!destroyTokenPerm.allowed) {
			throw new Error(destroyTokenPerm.reason ?? localize('adeMissionDestroyDenied', "Permission denied: destroying or archiving a Mission-linked session requires 'mission.destroy'."));
		}
		const destroyLivePerm = checkAdeApiPermission(roleConfig, effectiveCallerRank, 'mission.remove');
		if (!destroyLivePerm.allowed) {
			throw new Error(destroyLivePerm.reason ?? localize('adeMissionDestroyDenied', "Permission denied: destroying or archiving a Mission-linked session requires 'mission.destroy'."));
		}
	};

	if (isAdeRankOrDocsAction(action)) {
		const userHomeUri = await pathService?.userHome().catch(() => undefined);
		const defaultAdeHomeDir = userHomeUri ? joinPath(userHomeUri, '.aexus-code').fsPath : undefined;
		return executeAdeRankOrDocsAction(action, params, {
			roleSchemaService,
			roleConfig,
			backendService: engineeringBackend,
			projectsService: projects,
			missionRuntimeService: missionRuntime,
			defaultAdeHomeDir,
			caller: {
				isHumanUser,
				isSecretary: isSecretaryCaller,
				sessionId: callerAgent?.id ?? rawCallerSessionId,
				rankRaw: effectiveCallerRank || rawCallerStr || undefined,
			},
		});
	}

	if (isAdeMissionRuntimeAction(action)) {
		return executeAdeMissionRuntimeAction(action, params, {
			projects,
			sessions,
			missionService,
			missionRuntime,
			commandService,
			roleConfig,
			isHumanUser,
			isSecretary: isSecretaryCaller,
			callerAgent,
			callerSessionId: callerAgent?.id ?? rawCallerSessionId,
			isStrictDescendant: (candidateId, ancestorId) => isStrictDescendantOf(projects, candidateId, ancestorId),
		});
	}

	if (ADE_SESSION_AND_PROJECT_ACTIONS.has(action)) {
		return executeAdeSessionOrProjectControlAction(action, params, {
			modes,
			projects,
			navigation,
			editors,
			editorService,
			sessions,
			uriIdentity,
			commandService,
			workspaceEditing,
			contextService,
			environmentService,
			fileService,
			configurationService,
			pathService,
			chatService,
			scmService,
			viewsService,
			missionService,
			missionRuntime,
			engineeringBackend,
			cloudHosts,
			roleConfig,
			isHumanUser,
			isSecretaryCaller,
			isHumanOrSecretary,
			rawCallerStr,
			rawCallerSessionId,
			callerAgent,
			topRankDef,
			effectiveCallerDef,
			assertCanOperateMission,
			assertCanSuperviseRank,
			assertTargetInCallerSubtree,
			assertCanManageTarget,
			assertCanDestroyTreeIfPresent,
		});
	}

	if (ADE_SYSTEM_CONTROL_ACTIONS.has(action)) {
		return executeAdeSystemControlAction(action, params, {
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
		});
	}

	throw new Error(localize('adeUnknownControlAction', "Unknown ADE control action: {0}", String(action)));
}

CommandsRegistry.registerCommand('aexus.ade.getCloudHostSshContext', async (accessor: ServicesAccessor, rawAlias?: unknown) => {
	const cloudHosts = tryGetService(accessor, IAdeCloudHostBackendService);
	if (!cloudHosts) {
		return undefined;
	}
	const configService = tryGetService(accessor, IConfigurationService);
	const configuredSshPath = configService?.getValue<string>('remote.SSH.path')?.trim() || undefined;
	const alias = typeof rawAlias === 'string' ? rawAlias.trim() : '';
	const [effectiveSshConfigPath, matched] = await Promise.all([
		cloudHosts.getEffectiveSshConfigPath().catch(() => undefined),
		alias ? cloudHosts.getHost(alias).catch(() => undefined) : Promise.resolve(undefined),
	]);
	return {
		effectiveSshConfigPath,
		alias: matched?.alias || alias || undefined,
		os: matched?.os ?? 'linux',
		strictHostKeyChecking: matched?.strictHostKeyChecking,
		remoteHome: matched?.lastTestStatus?.remoteHome,
		hostName: matched?.hostName,
		user: matched?.user,
		port: matched?.port,
		sshExecutable: configuredSshPath,
	};
});

CommandsRegistry.registerCommand(ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID, (accessor: ServicesAccessor, rawResource: unknown) => {
	return resolveAdePromptContext(accessor, rawResource);
});

CommandsRegistry.registerCommand(ADE_GET_ROLE_SYNC_SNAPSHOT_COMMAND_ID, (accessor: ServicesAccessor, explicitActiveAgentId?: unknown) => {
	const modes = accessor.get(IWorkbenchModeService);
	const projects = accessor.get(IAdeProjectsService);
	const editors = accessor.get(IAdeEditorService);
	const sessions = tryGetService(accessor, IAdeSessionsService);
	const roleSchemaService = tryGetService(accessor, IAdeRoleSchemaService);
	const missionRuntime = tryGetService(accessor, IAdeMissionRuntimeService);
	const missionService = tryGetService(accessor, IAdeMissionService);
	const roleConfig = roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
	const docsPaths = roleSchemaService?.getDocsPaths?.();
	const activeId = typeof explicitActiveAgentId === 'string' && explicitActiveAgentId.trim() ? explicitActiveAgentId.trim() : undefined;
	return buildAdeRoleSyncSnapshot(modes, projects, editors, sessions, activeId, roleConfig, docsPaths, missionRuntime, missionService);
});

CommandsRegistry.registerCommand(ADE_CONTROL_EXECUTE_COMMAND_ID, (accessor: ServicesAccessor, arg1: IAdeControlDispatchRequest | string, arg2?: Record<string, unknown>) => {
	return executeAdeControlRequest(accessor, arg1, arg2);
});

CommandsRegistry.registerCommand('aexus.ade.engineering.workerHeartbeat', (accessor: ServicesAccessor, sessionResourceOrId: unknown, rawTimestamp?: unknown) => {
	const missionRuntime = tryGetService(accessor, IAdeMissionRuntimeService);
	if (!missionRuntime || typeof sessionResourceOrId !== 'string' || !sessionResourceOrId.trim()) {
		return;
	}
	const ts = typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp) ? rawTimestamp : Date.now();
	missionRuntime.touchAgentActivity(sessionResourceOrId.trim(), ts);
});

CommandsRegistry.registerCommand('aexus.ade.engineering.beginInteractiveTurn', (accessor: ServicesAccessor, rawPayload: unknown) => {
	const missionRuntime = tryGetService(accessor, IAdeMissionRuntimeService);
	if (!missionRuntime?.beginInteractiveTurn || !rawPayload || typeof rawPayload !== 'object') {
		return undefined;
	}
	const payload = rawPayload as {
		sessionResource?: unknown;
		agentId?: unknown;
		userPrompt?: unknown;
		isDirectUserChat?: unknown;
	};
	const target = (typeof payload.agentId === 'string' && payload.agentId.trim())
		? payload.agentId.trim()
		: (typeof payload.sessionResource === 'string' ? payload.sessionResource.trim() : '');
	if (!target) {
		return undefined;
	}
	const userPrompt = typeof payload.userPrompt === 'string' && payload.userPrompt.trim() ? payload.userPrompt : undefined;
	const isDirectUserChat = payload.isDirectUserChat === true;
	return missionRuntime.beginInteractiveTurn(target, userPrompt || isDirectUserChat ? { userPrompt, isDirectUserChat } : undefined);
});

CommandsRegistry.registerCommand('aexus.ade.engineering.endInteractiveTurn', (accessor: ServicesAccessor, rawPayload: unknown) => {
	const missionRuntime = tryGetService(accessor, IAdeMissionRuntimeService);
	if (!missionRuntime?.endInteractiveTurn) {
		return;
	}
	const turnId = typeof rawPayload === 'string'
		? rawPayload.trim()
		: (rawPayload && typeof rawPayload === 'object' && typeof (rawPayload as { turnId?: unknown }).turnId === 'string'
			? String((rawPayload as { turnId: string }).turnId).trim()
			: '');
	if (turnId) {
		missionRuntime.endInteractiveTurn(turnId);
	}
});

CommandsRegistry.registerCommand('aexus.ade.engineering.recordTurnUsage', (accessor: ServicesAccessor, rawPayload: unknown) => {
	const missionRuntime = tryGetService(accessor, IAdeMissionRuntimeService);
	if (!missionRuntime || !rawPayload || typeof rawPayload !== 'object') {
		return;
	}
	const payload = rawPayload as {
		sessionResource?: unknown;
		agentId?: unknown;
		missionId?: unknown;
		nodeId?: unknown;
		tokenId?: unknown;
		turnId?: unknown;
		usage?: {
			inputTokens?: number;
			outputTokens?: number;
			cacheReadTokens?: number;
			cacheWriteTokens?: number;
			totalTokens?: number;
			contextInitTokens?: number;
			contextTierDocTokens?: number;
			durationMs?: number;
			costUsd?: number;
			turns?: number;
			model?: string;
			engineId?: string;
			summary?: string;
			estimated?: boolean;
			hadToolError?: boolean;
			toolErrorCount?: number;
			turnId?: string;
			tokenId?: string;
		};
	};
	const target = (typeof payload.agentId === 'string' && payload.agentId.trim())
		? payload.agentId.trim()
		: (typeof payload.sessionResource === 'string' ? payload.sessionResource.trim() : '');
	if (!payload.usage || typeof payload.usage !== 'object') {
		return;
	}
	if (target) {
		missionRuntime.touchAgentActivity(target);
	}
	const missionId = typeof payload.missionId === 'string' ? payload.missionId.trim() : '';
	const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId.trim() : '';
	const tokenId = typeof payload.tokenId === 'string' ? payload.tokenId.trim() : (typeof payload.usage.tokenId === 'string' ? payload.usage.tokenId.trim() : '');
	const turnId = typeof payload.turnId === 'string' ? payload.turnId.trim() : (typeof payload.usage.turnId === 'string' ? payload.usage.turnId.trim() : '');
	if (turnId) {
		missionRuntime.recordTurnUsageBySessionResource(target, payload.usage, {
			turnId,
			...(missionId ? { missionId } : {}),
			...(nodeId ? { nodeId } : {}),
			...(tokenId ? { tokenId } : {}),
		});
		return;
	}
	if (missionId && nodeId) {
		missionRuntime.recordNodeTurnUsage(missionId, nodeId, payload.usage);
		return;
	}
	if (!target && !tokenId) {
		return;
	}
	missionRuntime.recordTurnUsageBySessionResource(target, payload.usage, {
		...(tokenId ? { tokenId } : {}),
	});
});

CommandsRegistry.registerCommand(ADE_SYNC_SESSION_PREFERENCES_COMMAND_ID, (accessor: ServicesAccessor, rawPayload: unknown) => {
	if (!rawPayload || typeof rawPayload !== 'object') {
		return;
	}
	const payload = rawPayload as {
		resource?: unknown;
		engineId?: unknown;
		model?: unknown;
		thinking?: unknown;
	};
	const sessionResource = toUri(payload.resource);
	if (!sessionResource) {
		return;
	}
	const projects = accessor.get(IAdeProjectsService);
	const uriIdentity = accessor.get(IUriIdentityService);
	const secretaryResource = projects.secretary.session?.resource;
	if (sessionResource.scheme === 'aexus-secretary' || (secretaryResource && (uriIdentity.extUri.isEqual(sessionResource, secretaryResource) || sessionResource.toString() === secretaryResource.toString()))) {
		if (typeof payload.engineId === 'string' && payload.engineId.trim()) {
			projects.configureSecretary({ engineId: payload.engineId.trim(), resource: secretaryResource ?? sessionResource });
		}
		return;
	}
	const agent = projects.agents.find(entry => entry.session && (
		uriIdentity.extUri.isEqual(entry.session.resource, sessionResource)
		|| entry.session.resource.toString() === sessionResource.toString()
	));
	if (!agent) {
		return;
	}
	const prefs: { preferredModel?: string; preferredThinking?: AdeThinkingLevel } = {};
	if (Object.hasOwn(payload, 'model')) {
		prefs.preferredModel = typeof payload.model === 'string' && payload.model.trim() && payload.model !== 'default'
			? payload.model.trim()
			: undefined;
	}
	if (Object.hasOwn(payload, 'thinking')) {
		const rawThinking = typeof payload.thinking === 'string' ? payload.thinking.trim() : '';
		const mapped: AdeThinkingLevel | undefined = rawThinking === 'off' || rawThinking === 'none'
			? 'off'
			: rawThinking === 'low' || rawThinking === 'minimal'
				? 'low'
				: rawThinking === 'medium'
					? 'medium'
					: rawThinking === 'max' || rawThinking === 'xhigh' || rawThinking === 'extra-high'
						? 'max'
						: rawThinking === 'high'
							? 'high'
							: undefined;
		prefs.preferredThinking = mapped;
	}
	if (projects.updateAgentEnginePreferences) {
		projects.updateAgentEnginePreferences(agent.id, prefs);
	}
});

const MAX_INITIALIZING_SESSION_ENTRIES = 256;
const initializingSessionsByResource = new Map<string, string>();
const observedWidgetsForInit = new WeakSet<object>();

function bindWidgetInitializingObserver(chatWidgetService: IChatWidgetService): void {
	if (observedWidgetsForInit.has(chatWidgetService)) {
		return;
	}
	observedWidgetsForInit.add(chatWidgetService);
	const attachWidget = (widget: {
		readonly viewModel?: { readonly sessionResource: URI };
		readonly onDidChangeViewModel: (cb: () => void) => { dispose(): void } | unknown;
		readonly onDidDispose?: (cb: () => void) => { dispose(): void } | unknown;
		setSessionInitializingState?: (msg: string | undefined) => void;
	}) => {
		if (observedWidgetsForInit.has(widget)) {
			return;
		}
		observedWidgetsForInit.add(widget);
		const sync = () => {
			const res = widget.viewModel?.sessionResource;
			const msg = res ? initializingSessionsByResource.get(res.toString()) : undefined;
			widget.setSessionInitializingState?.(msg);
		};
		const changeSub = widget.onDidChangeViewModel(() => sync()) as { dispose?: () => void } | undefined;
		widget.onDidDispose?.(() => {
			changeSub?.dispose?.();
		});
		sync();
	};
	for (const w of chatWidgetService.getAllWidgets()) {
		attachWidget(w);
	}
	chatWidgetService.onDidAddWidget(w => attachWidget(w));
}

CommandsRegistry.registerCommand(ADE_SET_SESSION_INITIALIZING_COMMAND_ID, (accessor: ServicesAccessor, rawResource: unknown, rawMessage: unknown) => {
	const sessionResource = toUri(rawResource);
	if (!sessionResource) {
		return;
	}
	const message = typeof rawMessage === 'string' && rawMessage.trim() ? rawMessage.trim() : undefined;
	const key = sessionResource.toString();
	if (message) {
		initializingSessionsByResource.delete(key);
		initializingSessionsByResource.set(key, message);
		while (initializingSessionsByResource.size > MAX_INITIALIZING_SESSION_ENTRIES) {
			const oldest = initializingSessionsByResource.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			initializingSessionsByResource.delete(oldest);
		}
	} else {
		initializingSessionsByResource.delete(key);
	}
	const chatWidgetService = tryGetService(accessor, IChatWidgetService);
	if (chatWidgetService) {
		bindWidgetInitializingObserver(chatWidgetService);
		const widget = chatWidgetService.getWidgetBySessionResource(sessionResource);
		widget?.setSessionInitializingState?.(message);
	}
});

CommandsRegistry.registerCommand(ADE_SET_SESSION_GOAL_BANNER_COMMAND_ID, (accessor: ServicesAccessor, rawResource: unknown, rawGoalText: unknown) => {
	const sessionResource = toUri(rawResource);
	if (!sessionResource) {
		return;
	}
	const chatWidgetService = tryGetService(accessor, IChatWidgetService);
	const commandService = tryGetService(accessor, ICommandService);
	const widget = chatWidgetService?.getWidgetBySessionResource(sessionResource);
	const goalText = typeof rawGoalText === 'string' && rawGoalText.trim() ? rawGoalText.trim() : undefined;
	if (widget?.setPinnedGoalBanner) {
		widget.setPinnedGoalBanner(goalText, () => {
			void commandService?.executeCommand('aexus.agentEngines.clearSessionGoal', sessionResource).catch(() => undefined);
		});
	}
});
