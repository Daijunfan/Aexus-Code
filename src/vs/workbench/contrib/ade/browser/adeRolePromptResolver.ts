/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import {
	buildCloudProjectUri,
	formatProjectDisplayPath,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	AdeSessionRank,
	IAdeControlStatus,
	IAdeProjectSummary,
	IAdeRoleSyncAgentEntry,
	IAdeRoleSyncSnapshot,
	IAdeSessionSummary,
} from '../../../../platform/ade/common/adeControl.js';
import { IAdeDocsPaths } from '../../../../platform/ade/common/adeDocsCatalog.js';
import { IAdeInboxService } from '../../../../platform/ade/common/adeEngineering.js';
import { parseMissionMermaidDag } from '../../../../platform/ade/common/adeMissionDag.js';
import {
	findHighestRankStaffNode,
	resolveEffectiveStaffTier,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import { parseOrchestrationGraph } from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import {
	ADE_SECRETARY_TIER_TAG,
	ADE_USER_TIER,
	formatTierTag,
} from '../../../../platform/ade/common/adeRankResize.js';
import {
	ADE_LIVE_ROLE_BINDINGS_HEADING,
	compileAdeRolePrompt,
	compileAdeRoleStaticCharter,
	computeAdeRoleStaticPromptHash,
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	extractAdeStaticRoleCharter,
	findRankDefinition,
	formatOrganizationLadder,
	getMissionDisplayName,
	IAdeOrganizationConfig,
	IAdeRolePromptCompileInput,
	isPureExecutionRank,
	resolveEffectiveRankDefinition,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { ServiceIdentifier, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import {
	ADE_ENGINEERING_SCHEME,
	ADE_SECRETARY_ID,
	IAdeAgent,
	IAdeAgentTreeNode,
	IAdeEditorService,
	IAdeProject,
	IAdeProjectsService,
	resolveAdeAgentRank,
} from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { IAdeMissionRuntimeService } from './adeMissionRuntime.js';
import { IAdeMissionRecord, IAdeMissionService } from './adeMissionStore.js';
import { AdeExtensionWebviewEditorInput, AdeSessionEditorInput } from './adeSessionEditor.js';
import { IAdeSessionsService } from './adeSessionsService.js';

export const MAX_PROMPT_SUBTREE_LINES = 24;
const MAX_SECRETARY_SESSION_LINES = 24;
const MAX_SECRETARY_PROJECTS = 12;
const MAX_SECRETARY_MISSIONS = 12;
const MAX_SECRETARY_INBOX = 10;

export function tryGetService<T>(accessor: ServicesAccessor, id: ServiceIdentifier<T>): T | undefined {
	try {
		return accessor.get(id);
	} catch {
		return undefined;
	}
}

export function formatRoleTitle(rank: AdeSessionRank, config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG): string {
	const def = findRankDefinition(config, rank);
	if (def) {
		return def.name;
	}
	switch (rank) {
		case 'governor':
			return 'Governor';
		case 'manager':
			return 'Manager';
		case 'employee':
		case 'subordinate':
			return 'Employee';
		case 'worker':
			return 'Worker';
		default:
			return String(rank);
	}
}

export function toUri(raw: unknown): URI | undefined {
	if (!raw) {
		return undefined;
	}
	if (URI.isUri(raw)) {
		return raw;
	}
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) {
			return undefined;
		}
		if (/^ssh:\/\/([^/]+)(\/.*)?$/i.test(trimmed)) {
			const m = /^ssh:\/\/([^/]+)(\/.*)?$/i.exec(trimmed)!;
			const rawPath = m[2] || '/';
			return buildCloudProjectUri(m[1], rawPath, /^\/?[a-zA-Z]:[\\/]/.test(rawPath) ? 'windows' : undefined);
		}
		if (/^[A-Za-z0-9._@-]{2,}:(?:\/(?!\/)|[a-zA-Z]:[\\/])(.*)$/.test(trimmed) && !/^(file|aexus-ssh|vscode-remote|http|https):/i.test(trimmed)) {
			const colonIdx = trimmed.indexOf(':');
			const hostPart = trimmed.slice(0, colonIdx);
			const pathPart = trimmed.slice(colonIdx + 1);
			return buildCloudProjectUri(hostPart, pathPart, /^\/?[a-zA-Z]:[\\/]/.test(pathPart) ? 'windows' : undefined);
		}
		if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(trimmed)) {
			return URI.parse(trimmed);
		}
		return URI.file(trimmed);
	}
	if (typeof raw === 'object') {
		return URI.revive(raw as UriComponents);
	}
	return undefined;
}

export function findMatchingProject(projects: IAdeProjectsService, uriIdentity: IUriIdentityService, rawTarget: unknown): IAdeProject | undefined {
	if (typeof rawTarget === 'string' && rawTarget.trim()) {
		const trimmed = rawTarget.trim();
		const byName = projects.projects.find(project => project.name === trimmed || project.name.toLowerCase() === trimmed.toLowerCase());
		if (byName) {
			return byName;
		}
	}
	const candidateUri = toUri(rawTarget);
	if (!candidateUri) {
		return undefined;
	}
	const normalized = removeTrailingPathSeparator(candidateUri);
	return projects.projects.find(project => uriIdentity.extUri.isEqual(project.uri, normalized));
}

export function buildProjectSummaries(
	projects: IAdeProjectsService,
	navigation: IProjectNavigationService,
	uriIdentity: IUriIdentityService,
): IAdeProjectSummary[] {
	const focusedUri = navigation.focusedProject?.uri;
	const activeUri = focusedUri ?? projects.selectedProject?.uri ?? navigation.selectedProject?.uri;
	return projects.projects.map(project => ({
		name: project.name,
		path: formatProjectDisplayPath(project.uri),
		uri: project.uri.toString(),
		focused: Boolean(focusedUri && uriIdentity.extUri.isEqual(focusedUri, project.uri)),
		selected: Boolean(activeUri && uriIdentity.extUri.isEqual(activeUri, project.uri)),
		activeSessionCount: projects.agents.filter(agent => !projects.isArchived(agent.id) && uriIdentity.extUri.isEqual(agent.projectUri, project.uri)).length,
	}));
}

export function toSessionSummary(
	projects: IAdeProjectsService,
	sessions: IAdeSessionsService | undefined,
	agent: IAdeAgent,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
): IAdeSessionSummary {
	const hasSubs = projects.hasSubordinates(agent.id);
	const effectiveEngineId = agent.session?.engineId ?? agent.preferredEngineId;
	const lockedByWorkTree = Boolean(projects.isLockedByWorkTree?.(agent.id));
	return {
		id: agent.id,
		parentId: agent.parentId,
		projectPath: formatProjectDisplayPath(agent.projectUri),
		projectName: projects.getProjectName(agent.projectUri),
		label: agent.label,
		role: agent.role,
		rank: resolveAdeAgentRank(agent, hasSubs, config),
		isOrchestrated: projects.isOrchestrated(agent),
		engineId: effectiveEngineId,
		engineName: effectiveEngineId ? (sessions?.getEngineName(effectiveEngineId) ?? effectiveEngineId) : undefined,
		...(agent.preferredModel ? { preferredModel: agent.preferredModel } : {}),
		...(agent.preferredThinking ? { preferredThinking: agent.preferredThinking } : {}),
		resource: agent.session?.resource.toString(),
		...(agent.draft ? { draft: agent.draft } : {}),
		status: !agent.session ? 'draft' : (agent.status ?? 'idle'),
		unread: Boolean(agent.unread),
		archived: projects.isArchived(agent.id),
		childrenIds: projects.getDirectSubordinates(agent.id).map(child => child.id),
		...(agent.treeType ? { treeType: agent.treeType } : {}),
		...(agent.treeGovernorId ? { treeGovernorId: agent.treeGovernorId } : {}),
		...(agent.treeSegmentId ? { treeSegmentId: agent.treeSegmentId } : {}),
		...(agent.treeNodeId ? { treeNodeId: agent.treeNodeId } : {}),
		...(agent.treeNodeIds && agent.treeNodeIds.length > 0 ? { treeNodeIds: [...agent.treeNodeIds] } : {}),
		...(lockedByWorkTree ? { lockedByWorkTree: true } : {}),
	};
}

export function buildControlStatus(
	modes: IWorkbenchModeService,
	projects: IAdeProjectsService,
	navigation: IProjectNavigationService,
	editors: IAdeEditorService,
	sessions?: IAdeSessionsService,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
): IAdeControlStatus {
	const focused = navigation.focusedProject;
	const selected = focused ?? projects.selectedProject ?? navigation.selectedProject;
	const activeInput = editors.activeEditor;
	const secretary = projects.secretary;
	const secretaryResource = secretary.session?.resource.toString();

	let activeEditor: IAdeControlStatus['activeEditor'];
	if (activeInput instanceof AdeSessionEditorInput) {
		if (activeInput.agentId === ADE_SECRETARY_ID) {
			activeEditor = {
				kind: 'secretary',
				label: secretary.label,
				resource: secretaryResource,
				engineId: secretary.session?.engineId,
			};
		} else {
			const agent = projects.getAgent(activeInput.agentId);
			activeEditor = {
				kind: 'session',
				agentId: activeInput.agentId,
				label: agent?.label ?? activeInput.getName(),
				role: agent?.role,
				rank: agent ? resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id), config) : undefined,
				engineId: agent?.session?.engineId,
			};
		}
	} else if (activeInput instanceof AdeExtensionWebviewEditorInput) {
		const agent = projects.getAgent(activeInput.agentId);
		activeEditor = {
			kind: 'session',
			agentId: activeInput.agentId,
			label: agent?.label ?? activeInput.getName(),
			resource: agent?.session?.resource.toString(),
			role: agent?.role,
			rank: agent ? resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id), config) : undefined,
			engineId: agent?.session?.engineId ?? activeInput.engineId,
		};
	} else if (activeInput instanceof ChatEditorInput) {
		const sessionKey = activeInput.sessionResource?.toString();
		if (secretaryResource && sessionKey === secretaryResource) {
			activeEditor = {
				kind: 'secretary',
				label: secretary.label,
				resource: secretaryResource,
				engineId: secretary.session?.engineId,
			};
		} else {
			const agent = projects.agents.find(item => item.session?.resource.toString() === sessionKey);
			if (agent) {
				activeEditor = {
					kind: 'session',
					agentId: agent.id,
					label: agent.label,
					resource: sessionKey,
					role: agent.role,
					rank: resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id), config),
					engineId: agent.session?.engineId,
				};
			} else {
				activeEditor = {
					kind: 'other',
					label: activeInput.getName(),
					resource: sessionKey,
				};
			}
		}
	} else {
		const mappedAgentId = activeInput ? editors.getAgentIdForEditor?.(activeInput) : undefined;
		const mappedAgent = mappedAgentId ? projects.getAgent(mappedAgentId) : undefined;
		if (mappedAgent) {
			activeEditor = {
				kind: 'session',
				agentId: mappedAgent.id,
				label: mappedAgent.label,
				resource: mappedAgent.session?.resource.toString(),
				role: mappedAgent.role,
				rank: resolveAdeAgentRank(mappedAgent, projects.hasSubordinates(mappedAgent.id), config),
				engineId: mappedAgent.session?.engineId,
			};
		} else if (activeInput?.resource?.scheme === ADE_ENGINEERING_SCHEME) {
			const govId = activeInput.resource.path.replace(/^\/+/, '');
			activeEditor = {
				kind: 'engineering',
				governorSessionId: govId,
				label: activeInput.getName(),
				resource: activeInput.resource.toString(),
			};
		} else if (activeInput?.resource) {
			activeEditor = {
				kind: 'file',
				label: activeInput.getName(),
				resource: activeInput.resource.toString(),
			};
		} else if (activeInput) {
			activeEditor = {
				kind: 'other',
				label: activeInput.getName(),
			};
		}
	}

	const selectedAgent = projects.selectedAgentId ? projects.getAgent(projects.selectedAgentId) : undefined;

	return {
		mode: modes.mode,
		showArchived: projects.showArchived,
		navigation: {
			isFocused: Boolean(focused),
			focusedProject: focused ? { name: focused.name, path: formatProjectDisplayPath(focused.uri), uri: focused.uri.toString() } : undefined,
			canGoForward: navigation.canGoForward,
		},
		selectedProject: selected ? { name: selected.name, path: formatProjectDisplayPath(selected.uri), uri: selected.uri.toString() } : undefined,
		...(selectedAgent ? { selectedSession: toSessionSummary(projects, sessions, selectedAgent, config) } : {}),
		activeEditor,
		secretary: {
			configured: Boolean(secretary.session),
			engineId: secretary.session?.engineId,
			label: secretary.label,
			status: secretary.session ? secretary.status : 'draft',
			resource: secretaryResource,
		},
		counts: {
			projects: projects.projects.length,
			activeRootSessions: projects.agents.filter(agent => !agent.parentId && !projects.isArchived(agent.id)).length,
			totalActiveSessions: projects.agents.filter(agent => !projects.isArchived(agent.id)).length,
			archived: projects.agents.filter(agent => !agent.parentId && Boolean(agent.archived)).length,
		},
	};
}

export function formatAdeAgentSubtreeLines(
	projects: IAdeProjectsService,
	sessions: IAdeSessionsService | undefined,
	rootAgentId: string,
	maxLines = MAX_PROMPT_SUBTREE_LINES,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
): string[] {
	const tree = projects.getAgentTree(rootAgentId);
	if (!tree) {
		return [];
	}
	const lines: string[] = [];
	let omitted = 0;
	const visit = (node: IAdeAgentTreeNode, depth: number) => {
		if (lines.length >= maxLines) {
			omitted++;
			for (const child of node.children) {
				visit(child, depth + 1);
			}
			return;
		}
		const hasSubs = node.children.length > 0;
		const rankTitle = formatRoleTitle(resolveAdeAgentRank(node.agent, hasSubs, config), config);
		const engineName = node.agent.session ? (sessions?.getEngineName(node.agent.session.engineId) ?? node.agent.session.engineId) : 'Draft';
		const indent = '  '.repeat(depth + 1);
		// Keep role prompt cache-stable: omit volatile live status (idle/working); query live state via CLI when needed.
		lines.push(`${indent}- [${rankTitle}] ${node.agent.label} (id: ${node.agent.id}, engine: ${engineName} [${node.agent.session?.engineId ?? 'draft'}])`);
		for (const child of node.children) {
			visit(child, depth + 1);
		}
	};
	for (const child of tree.children) {
		visit(child, 0);
	}
	if (omitted > 0) {
		lines.push(`  - ... (+${omitted} more subordinates; run \`aexus-ade session tree ${rootAgentId} --json\` for full live tree)`);
	}
	return lines;
}

export function resolveOrchestrationStaffAuthority(
	agent: IAdeAgent | undefined,
	mission: IAdeMissionRecord | undefined,
	projects: IAdeProjectsService,
	roleConfig: IAdeOrganizationConfig,
	missionRuntime?: IAdeMissionRuntimeService,
): {
	readonly isMember: boolean;
	readonly isTopRank: boolean;
	readonly staffNodeId?: string;
	readonly department?: string;
} {
	if (!agent || !mission || !mission.orchestrationText?.trim()) {
		return { isMember: false, isTopRank: false };
	}
	const parsed = parseOrchestrationGraph(mission.orchestrationText);
	if (parsed.error || !parsed.nodes.some(n => n.kind === 'staff')) {
		return { isMember: false, isTopRank: false };
	}
	const orchState = missionRuntime?.getOrchestrationState(mission.id);
	let staffNodeId = orchState
		? Object.entries(orchState.nodeAgentIds).find(([, aid]) => aid === agent.id)?.[0]
		: undefined;
	if (!staffNodeId && agent.treeGovernorId && (agent.treeGovernorId === mission.id || agent.treeGovernorId === mission.ownerSessionId) && agent.treeNodeId) {
		const candidateNode = parsed.nodes.find(n =>
			n.kind === 'staff'
			&& (n.id === agent.treeNodeId || n.employeeKey === agent.treeNodeId || Boolean(agent.treeNodeIds?.includes(n.id))),
		);
		staffNodeId = candidateNode?.id;
	}
	if (!staffNodeId && mission.ownerSessionId === agent.id) {
		staffNodeId = findHighestRankStaffNode(parsed)?.id;
	}
	if (!staffNodeId) {
		return { isMember: false, isTopRank: false };
	}
	const staffNode = parsed.nodes.find(n => n.id === staffNodeId && n.kind === 'staff');
	const highestNode = findHighestRankStaffNode(parsed);
	const highestConfiguredTier = Math.min(...roleConfig.ranks.map(r => r.tier));
	const agentTier = resolveEffectiveRankDefinition(roleConfig, agent.role, projects.hasSubordinates(agent.id)).tier;
	const nodeTier = staffNode ? resolveEffectiveStaffTier(staffNode, roleConfig) : undefined;
	const isTopRank = Boolean(
		(highestNode && highestNode.id === staffNodeId)
		|| agentTier <= highestConfiguredTier
		|| (nodeTier !== undefined && nodeTier <= highestConfiguredTier),
	);
	return {
		isMember: true,
		isTopRank,
		staffNodeId,
		...(staffNode?.department ? { department: staffNode.department } : {}),
	};
}

export function resolveInGraphMissionBinding(
	agent: IAdeAgent,
	missionRuntime?: IAdeMissionRuntimeService,
	missionService?: IAdeMissionService,
): {
	readonly missionId: string;
	readonly mission?: IAdeMissionRecord;
	readonly nodeIds: readonly string[];
	readonly isOrchestrationStaff?: boolean;
	readonly department?: string;
	readonly rolePrompt?: string;
	readonly allowedPaths?: readonly string[];
	readonly checkSummaries?: readonly string[];
} | undefined {
	const extractStaffMetadata = (rec: IAdeMissionRecord, nodeIds: readonly string[]) => {
		let rolePrompt: string | undefined;
		let allowedPaths: readonly string[] | undefined;
		let checkSummaries: readonly string[] | undefined;
		let department: string | undefined;
		let matchedId: string | undefined;
		if (rec.orchestrationText?.trim()) {
			const parsed = parseOrchestrationGraph(rec.orchestrationText);
			if (!parsed.error && parsed.nodes.some(n => n.kind === 'staff')) {
				const staffNode = parsed.nodes.find(n => n.kind === 'staff' && (nodeIds.includes(n.id) || (n.employeeKey && nodeIds.includes(n.employeeKey))));
				if (staffNode) {
					matchedId = staffNode.id;
					department = staffNode.department;
					rolePrompt = staffNode.rolePrompt?.trim() || undefined;
					allowedPaths = staffNode.allowedPaths && staffNode.allowedPaths.length > 0 ? staffNode.allowedPaths : undefined;
					const checks = staffNode.checks && staffNode.checks.length > 0 ? staffNode.checks : undefined;
					if (checks) {
						checkSummaries = checks.map(c => (c.name && c.command ? `${c.name}: \`${c.command}\`` : (c.command || c.name || c.id)));
					}
				}
				return { isOrchestration: true, matchedId, department, rolePrompt, allowedPaths, checkSummaries };
			}
		}
		return { isOrchestration: false, matchedId, department, rolePrompt, allowedPaths, checkSummaries };
	};
	const live = missionRuntime?.findMissionForAgent(agent.id);
	if (live) {
		if (!live.isOffGraphSupervisor && live.nodeIds.length > 0) {
			const meta = extractStaffMetadata(live.mission, live.nodeIds);
			const isOrchestrationStaff = Boolean(live.isOrchestrationStaff || meta.isOrchestration);
			return {
				missionId: live.mission.id,
				mission: live.mission,
				nodeIds: meta.matchedId ? [meta.matchedId] : live.nodeIds,
				isOrchestrationStaff,
				department: live.department ?? meta.department,
				...(meta.rolePrompt ? { rolePrompt: meta.rolePrompt } : {}),
				...(meta.allowedPaths ? { allowedPaths: meta.allowedPaths } : {}),
				...(meta.checkSummaries ? { checkSummaries: meta.checkSummaries } : {}),
			};
		}
		return undefined;
	}
	if (agent.treeNodeId && (agent.treeType === 'engineering' || agent.treeType === 'mission' || !agent.treeType)) {
		const nodeIds = agent.treeNodeIds && agent.treeNodeIds.length > 0 ? agent.treeNodeIds : [agent.treeNodeId];
		const rec = agent.treeGovernorId
			? (missionService?.getMission(agent.treeGovernorId) ?? missionService?.getMissionByLinkedSession(agent.treeGovernorId))
			: undefined;
		if (rec) {
			const meta = extractStaffMetadata(rec, nodeIds);
			if (meta.isOrchestration || agent.treeType === 'engineering') {
				return {
					missionId: rec.id,
					mission: rec,
					nodeIds: meta.matchedId ? [meta.matchedId] : nodeIds,
					isOrchestrationStaff: true,
					...(meta.department ? { department: meta.department } : {}),
					...(meta.rolePrompt ? { rolePrompt: meta.rolePrompt } : {}),
					...(meta.allowedPaths ? { allowedPaths: meta.allowedPaths } : {}),
					...(meta.checkSummaries ? { checkSummaries: meta.checkSummaries } : {}),
				};
			}
		}
		if (agent.treeType === 'engineering') {
			return { missionId: agent.treeGovernorId ?? 'unknown', nodeIds, isOrchestrationStaff: true };
		}
		return { missionId: agent.treeGovernorId ?? 'unknown', nodeIds };
	}
	return undefined;
}

function hashDeterministicStaticCharter(text: string): string {
	let h1 = 0xdeadbeef ^ text.length;
	let h2 = 0x41c6ce57 ^ text.length;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
}

export function buildAdeAgentRoleContextWithStatic(
	projects: IAdeProjectsService,
	sessions: IAdeSessionsService | undefined,
	agent: IAdeAgent,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
	docsPaths?: IAdeDocsPaths,
	missionRuntime?: IAdeMissionRuntimeService,
	missionService?: IAdeMissionService,
): { readonly rolePrompt?: string; readonly staticRoleCharter?: string; readonly staticRoleHash?: string } {
	const subordinates = projects.getDirectSubordinates(agent.id);
	const rankDef = resolveEffectiveRankDefinition(config, agent.role, subordinates.length > 0);
	const tierTag = formatTierTag(rankDef.tier);
	const compiledDocsPaths = docsPaths ? {
		rankDoc: docsPaths.rankDocs[tierTag] ?? `${docsPaths.ranksDir}/${tierTag}.md`,
		missionDoc: docsPaths.missionDoc,
		commonDoc: docsPaths.commonDoc,
		engineeringParadigmDoc: docsPaths.engineeringParadigmDoc,
		engineeringApiDoc: docsPaths.engineeringApiDoc,
	} : undefined;

	const inGraphBinding = resolveInGraphMissionBinding(agent, missionRuntime, missionService);

	// 1. Engineering Orchestration leaf staff (pure execution rank on Orchestration canvas):
	// Contract C2 KV-cache invariance: invariant static charter prefix FIRST, mutable node/dept/role-boundary/
	// allowed-paths/check bindings isolated strictly after `### Live Role Bindings`.
	if (inGraphBinding?.isOrchestrationStaff && rankDef.pureExecution && subordinates.length === 0) {
		const missionId = inGraphBinding.missionId;
		const nodeList = inGraphBinding.nodeIds.join(', ');
		const deptPart = inGraphBinding.department ? ` | Dept: ${inGraphBinding.department}` : '';
		const collapsedRoleBoundary = inGraphBinding.rolePrompt
			? inGraphBinding.rolePrompt.replace(/\r?\n+/g, ' ').trim()
			: '';
		const staticPrefix = [
			'[Aexus ADE · Engineering Staff Context]',
			`- Agent ID: ${agent.id} | Tier: ${tierTag} (Engineering Staff) | Mission: ${missionId}`,
			'- Paradigm: NO task pre-prompts — all directives & deliverables flow via baton tokens and lightweight pointers. Return completed received tokens upward via `token return` (NEVER mint upward). Active tokens remind every 5m unless `token block` is set.',
			`- Sibling Docs (Read On Demand): Native Rank \`aexus-ade docs read ${tierTag}\` | Engineering Paradigm & Token Rules \`aexus-ade docs read engineering\` | CLI Cookbook \`aexus-ade docs read engineering-api\` | \`aexus-ade whoami --json\` | \`aexus-ade api update --since 0 --json\``,
			`- Token & Whiteboard Bus: \`aexus-ade token current --mission ${missionId} --json\` | \`token read <ptrs>\` | \`token history <id>\` | \`token return <id> --summary "<facts>"\` | \`token handoff <id> --to <node> --summary "<facts>"\` | \`token complete|block|fail <id> ...\` | \`whiteboard read|write <wbId> --mission ${missionId}\``,
		].join('\n');
		const liveBindingsLines = [
			`- Node(s): ${nodeList}${deptPart}`,
			...(collapsedRoleBoundary ? [`- Role Boundary: ${collapsedRoleBoundary}`] : []),
			...(inGraphBinding.allowedPaths && inGraphBinding.allowedPaths.length > 0 ? [`- Allowed Read/Write Paths: ${inGraphBinding.allowedPaths.map(p => `\`${p}\``).join(', ')}`] : []),
			...(inGraphBinding.checkSummaries && inGraphBinding.checkSummaries.length > 0 ? [`- Automated Verification Gates: ${inGraphBinding.checkSummaries.join(' | ')}`] : []),
		];
		const rolePrompt = `${staticPrefix}\n\n${ADE_LIVE_ROLE_BINDINGS_HEADING}\n${liveBindingsLines.join('\n')}`;
		const staticRoleCharter = extractAdeStaticRoleCharter(rolePrompt);
		return {
			rolePrompt,
			staticRoleCharter,
			staticRoleHash: hashDeterministicStaticCharter(staticRoleCharter),
		};
	}

	// 2. Legacy in-graph Mission DAG node employees (non-Orchestration):
	// Contract C2 KV-cache invariance: invariant charter prefix FIRST, mutable Node(s) binding after `### Live Role Bindings`.
	if (inGraphBinding && !inGraphBinding.isOrchestrationStaff) {
		const missionId = inGraphBinding.missionId;
		const nodeList = inGraphBinding.nodeIds.join(', ');
		const staticPrefix = [
			'[Aexus ADE · Mission Node Employee]',
			`- Agent ID: ${agent.id} | Tier: ${tierTag} (in-graph) | Mission: ${missionId}`,
			'- Scope: Execute or review your assigned node via baton tokens (never mint/message upward; return completed batons via `token return` or advance via `token complete`).',
			'- Sibling Lazy-Read Docs (Native Rank + Engineering Paradigm):',
			`  - \`aexus-ade whoami --json\` | \`aexus-ade docs read ${tierTag}\` | \`aexus-ade docs read engineering\` | \`aexus-ade docs read common\` | \`aexus-ade api update --since 0 --json\``,
			'  - Token Flow: `aexus-ade token current --json` | `token read <ptrs>` | `token return <id> --summary "<facts>"` | `aexus-ade token complete <id> --summary "<facts>"` | `token reject|block|fail <id> ...`',
		].join('\n');
		const rolePrompt = `${staticPrefix}\n\n${ADE_LIVE_ROLE_BINDINGS_HEADING}\n- Node(s): ${nodeList}`;
		const staticRoleCharter = extractAdeStaticRoleCharter(rolePrompt);
		return {
			rolePrompt,
			staticRoleCharter,
			staticRoleHash: hashDeterministicStaticCharter(staticRoleCharter),
		};
	}

	if (!inGraphBinding?.isOrchestrationStaff && !agent.role && subordinates.length === 0) {
		return {};
	}

	if (!inGraphBinding?.isOrchestrationStaff && rankDef.pureExecution && subordinates.length === 0) {
		return {};
	}

	const supervisor = agent.parentId ? projects.getAgent(agent.parentId) : undefined;
	const ownEngineName = agent.session ? (sessions?.getEngineName(agent.session.engineId) ?? agent.session.engineId) : 'Draft';
	const boundMission = missionRuntime?.findMissionForAgent(agent.id);
	const boundMissionRecord = boundMission?.mission ?? inGraphBinding?.mission;
	const isOrchestrationStaff = Boolean(inGraphBinding?.isOrchestrationStaff || boundMission?.isOrchestrationStaff);
	const isOffGraphSupervisorBinding = Boolean(boundMission?.isOffGraphSupervisor);
	const isWorkTree = Boolean(agent.treeType) || isOffGraphSupervisorBinding || isOrchestrationStaff;
	const supervisorRankName = supervisor
		? formatRoleTitle(resolveAdeAgentRank(supervisor, true, config), config)
		: undefined;
	const orchAuth = isOrchestrationStaff
		? resolveOrchestrationStaffAuthority(agent, boundMissionRecord, projects, config, missionRuntime)
		: undefined;
	const highestConfiguredTier = Math.min(...config.ranks.map(r => r.tier));
	const isTopRankOrchStaff = Boolean(
		isOrchestrationStaff
		&& (orchAuth?.isTopRank || (!boundMissionRecord && rankDef.tier <= highestConfiguredTier)),
	);
	const isExplicitMissionOwner = boundMissionRecord
		? boundMissionRecord.ownerSessionId === agent.id
		: Boolean(agent.treeType && !agent.treeNodeId && (!agent.treeGovernorId || agent.treeGovernorId === agent.id));
	const isMissionOwner = isExplicitMissionOwner
		|| Boolean(isTopRankOrchStaff && (!boundMissionRecord?.ownerSessionId || boundMissionRecord.ownerTier <= ADE_USER_TIER));
	const workTreeSlot = !isWorkTree
		? undefined
		: isOrchestrationStaff
			? (isMissionOwner ? 'orchestrator' as const : (rankDef.canHaveSubordinates ? 'segment_owner' as const : 'reviewer' as const))
			: agent.treeNodeId
				? 'reviewer' as const
				: isMissionOwner
					? 'orchestrator' as const
					: 'segment_owner' as const;

	const compileInput: IAdeRolePromptCompileInput = {
		config,
		rank: rankDef,
		agentId: agent.id,
		agentLabel: agent.label,
		engineDisplay: ownEngineName,
		engineId: agent.session?.engineId ?? 'draft',
		projectName: projects.getProjectName(agent.projectUri),
		projectPath: formatProjectDisplayPath(agent.projectUri),
		supervisor: supervisor && supervisorRankName
			? { id: supervisor.id, label: supervisor.label, rankName: supervisorRankName }
			: undefined,
		subtreeLines: !isWorkTree && subordinates.length > 0
			? formatAdeAgentSubtreeLines(projects, sessions, agent.id, MAX_PROMPT_SUBTREE_LINES, config)
			: undefined,
		workTree: isWorkTree
			? {
				treeType: isOrchestrationStaff ? 'engineering' : 'mission',
				governorId: boundMission?.mission.id ?? inGraphBinding?.missionId ?? agent.treeGovernorId ?? agent.id,
				nodeId: inGraphBinding?.nodeIds[0] ?? agent.treeNodeId,
				nodeIds: inGraphBinding?.nodeIds,
				slot: workTreeSlot,
				isMissionOwner,
				isOrchestrationStaff,
				department: inGraphBinding?.department ?? boundMission?.department,
				managedNodeIds: boundMission?.managedNodeIds,
				...(inGraphBinding?.rolePrompt ? { rolePrompt: inGraphBinding.rolePrompt } : {}),
				...(inGraphBinding?.allowedPaths ? { allowedPaths: inGraphBinding.allowedPaths } : {}),
				...(inGraphBinding?.checkSummaries ? { checkSummaries: inGraphBinding.checkSummaries } : {}),
			}
			: undefined,
		docsPaths: compiledDocsPaths,
	};

	const rolePrompt = compileAdeRolePrompt(compileInput);
	if (!rolePrompt) {
		return {};
	}
	const staticRoleCharter = compileAdeRoleStaticCharter(compileInput) || extractAdeStaticRoleCharter(rolePrompt);
	const staticRoleHash = computeAdeRoleStaticPromptHash(compileInput) || hashDeterministicStaticCharter(staticRoleCharter);
	return { rolePrompt, staticRoleCharter, staticRoleHash };
}

export function buildAdeAgentRoleContext(
	projects: IAdeProjectsService,
	sessions: IAdeSessionsService | undefined,
	agent: IAdeAgent,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
	docsPaths?: IAdeDocsPaths,
	missionRuntime?: IAdeMissionRuntimeService,
	missionService?: IAdeMissionService,
): string | undefined {
	return buildAdeAgentRoleContextWithStatic(projects, sessions, agent, config, docsPaths, missionRuntime, missionService).rolePrompt;
}

export function buildAdeRoleSyncSnapshot(
	modes: IWorkbenchModeService,
	projects: IAdeProjectsService,
	editors: IAdeEditorService,
	sessions: IAdeSessionsService | undefined,
	explicitActiveAgentId?: string,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
	docsPaths?: IAdeDocsPaths,
	missionRuntime?: IAdeMissionRuntimeService,
	missionService?: IAdeMissionService,
): IAdeRoleSyncSnapshot {
	const rawActiveAgentId = explicitActiveAgentId ?? editors.getAgentIdForEditor?.(editors.activeEditor);
	const activeAgentId = rawActiveAgentId && projects.getAgent(rawActiveAgentId) ? rawActiveAgentId : undefined;
	const selectedAgentId = projects.selectedAgentId && projects.getAgent(projects.selectedAgentId) ? projects.selectedAgentId : undefined;
	const agents: IAdeRoleSyncAgentEntry[] = projects.agents.map(agent => {
		const hasSubs = projects.hasSubordinates(agent.id);
		const isMissionNodeEmployee = Boolean(resolveInGraphMissionBinding(agent, missionRuntime, missionService));
		const isOrchestrated = Boolean(hasSubs || isMissionNodeEmployee || (agent.role && !isPureExecutionRank(config, agent.role)));
		const rank = resolveAdeAgentRank(agent, hasSubs, config);
		const roleBundle = isOrchestrated
			? buildAdeAgentRoleContextWithStatic(projects, sessions, agent, config, docsPaths, missionRuntime, missionService)
			: undefined;
		return {
			id: agent.id,
			label: agent.label,
			projectPath: formatProjectDisplayPath(agent.projectUri),
			engineId: agent.session?.engineId ?? agent.preferredEngineId,
			resource: agent.session?.resource.toString(),
			rank,
			isOrchestrated,
			isWorkTree: Boolean(agent.treeType),
			isMissionNode: isMissionNodeEmployee,
			rolePrompt: roleBundle?.rolePrompt,
			...(roleBundle?.staticRoleCharter ? { staticRoleCharter: roleBundle.staticRoleCharter } : {}),
			...(roleBundle?.staticRoleHash ? { staticRoleHash: roleBundle.staticRoleHash } : {}),
			preferredModel: agent.preferredModel,
			preferredThinking: agent.preferredThinking,
		};
	});
	return {
		mode: modes.mode,
		activeAgentId,
		selectedAgentId,
		agents,
	};
}

export function resolveAdePromptContext(accessor: ServicesAccessor, rawResource: unknown): string | undefined {
	let explicitAgentId: string | undefined;
	let candidateResource = rawResource;
	let compactDeltaMode = false;
	if (rawResource && typeof rawResource === 'object' && !URI.isUri(rawResource) && (Object.hasOwn(rawResource, 'agentId') || Object.hasOwn(rawResource, 'resource') || Object.hasOwn(rawResource, 'mode'))) {
		const targetObj = rawResource as { agentId?: unknown; resource?: unknown; mode?: unknown };
		if (typeof targetObj.agentId === 'string' && targetObj.agentId.trim()) {
			explicitAgentId = targetObj.agentId.trim();
		}
		if (targetObj.mode === 'delta') {
			compactDeltaMode = true;
		}
		candidateResource = targetObj.resource;
	}
	const sessionResource = toUri(candidateResource);
	if (!sessionResource && !explicitAgentId) {
		return undefined;
	}
	const projects = accessor.get(IAdeProjectsService);
	const navigation = accessor.get(IProjectNavigationService);
	const modes = accessor.get(IWorkbenchModeService);
	const editors = accessor.get(IAdeEditorService);
	const uriIdentity = accessor.get(IUriIdentityService);
	const sessions = tryGetService(accessor, IAdeSessionsService);
	const missionService = tryGetService(accessor, IAdeMissionService);
	const missionRuntime = tryGetService(accessor, IAdeMissionRuntimeService);
	const inbox = tryGetService(accessor, IAdeInboxService);
	const roleSchemaService = tryGetService(accessor, IAdeRoleSchemaService);
	const roleConfig = roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
	const docsPaths = roleSchemaService?.getDocsPaths?.();

	const secretaryResource = projects.secretary.session?.resource;
	if (sessionResource && (sessionResource.scheme === 'aexus-secretary' || (secretaryResource && (uriIdentity.extUri.isEqual(sessionResource, secretaryResource) || sessionResource.toString() === secretaryResource.toString())))) {
		const status = buildControlStatus(modes, projects, navigation, editors, sessions, roleConfig);
		const summaries = buildProjectSummaries(projects, navigation, uriIdentity);
		const focusLine = status.navigation.isFocused && status.navigation.focusedProject
			? `Focused Project: ${status.navigation.focusedProject.name} (${status.navigation.focusedProject.path})`
			: `Home (All Projects Overview)${status.navigation.canGoForward ? ' [Forward available]' : ''}`;
		const selectedLine = status.selectedProject
			? `${status.selectedProject.name} (${status.selectedProject.path})`
			: 'None';
		const activeEditorLine = !status.activeEditor
			? 'None'
			: status.activeEditor.kind === 'secretary'
				? `Secretary (${status.activeEditor.engineId ?? 'draft'})`
				: status.activeEditor.kind === 'engineering'
					? `Mission Canvas (mission=${status.activeEditor.governorSessionId})`
					: status.activeEditor.kind === 'session'
						? `Session "${status.activeEditor.label}" (id=${status.activeEditor.agentId}, role=${status.activeEditor.rank ?? status.activeEditor.role ?? 'worker'}, engine=${status.activeEditor.engineId ?? 'draft'})`
						: `${status.activeEditor.kind}: ${status.activeEditor.label}${status.activeEditor.resource ? ` (${status.activeEditor.resource})` : ''}`;

		const shownProjects = summaries.slice(0, MAX_SECRETARY_PROJECTS);
		const projectLines = shownProjects.length
			? [
				...shownProjects.map(project => `  - ${project.name} (${project.path})${project.focused ? ' [FOCUSED]' : project.selected ? ' [SELECTED]' : ''}: ${project.activeSessionCount} active session(s)`),
				...(summaries.length > MAX_SECRETARY_PROJECTS ? [`  - ... (+${summaries.length - MAX_SECRETARY_PROJECTS} more projects; run \`aexus-ade project list --json\`)`] : []),
			].join('\n')
			: '  (No projects registered)';

		const activeRoots = projects.agents.filter(agent => !agent.parentId && !projects.isArchived(agent.id));
		const sessionLines: string[] = [];
		let omittedSessions = 0;
		const renderSessionLine = (agent: IAdeAgent, depth: number) => {
			if (sessionLines.length >= MAX_SECRETARY_SESSION_LINES) {
				omittedSessions++;
				for (const child of projects.getDirectSubordinates(agent.id)) {
					renderSessionLine(child, depth + 1);
				}
				return;
			}
			const hasSubs = projects.hasSubordinates(agent.id);
			const rankTitle = formatRoleTitle(resolveAdeAgentRank(agent, hasSubs, roleConfig), roleConfig);
			const engId = agent.session?.engineId ?? agent.preferredEngineId;
			const eng = engId ? (sessions?.getEngineName(engId) ?? engId) : 'Draft';
			const st = !agent.session ? 'lazy' : (agent.status ?? 'idle');
			const isWorkTreeRoot = !agent.parentId && Boolean(agent.treeType);
			const treeBadge = isWorkTreeRoot ? ` [${agent.treeType!.toUpperCase()}]` : '';
			if (isWorkTreeRoot) {
				const managedCount = Math.max(0, projects.getSubtree(agent.id).length - 1);
				const managedSuffix = managedCount > 0 ? `, +${managedCount} managed Mission employee(s) — see ADE Missions above` : '';
				sessionLines.push(`${'  '.repeat(depth + 1)}- [${rankTitle}]${treeBadge} "${agent.label}" (id: ${agent.id}, project: ${projects.getProjectName(agent.projectUri)}, engine: ${eng} [${engId ?? 'draft'}], status: ${st}${agent.unread ? ', UNREAD' : ''}${managedSuffix})`);
				return;
			}
			sessionLines.push(`${'  '.repeat(depth + 1)}- [${rankTitle}] "${agent.label}" (id: ${agent.id}, project: ${projects.getProjectName(agent.projectUri)}, engine: ${eng} [${engId ?? 'draft'}], status: ${st}${agent.unread ? ', UNREAD' : ''})`);
			for (const child of projects.getDirectSubordinates(agent.id)) {
				renderSessionLine(child, depth + 1);
			}
		};
		for (const root of activeRoots) {
			renderSessionLine(root, 0);
		}
		if (omittedSessions > 0) {
			sessionLines.push(`  - ... (+${omittedSessions} more sessions; run \`aexus-ade session list --json\`)`);
		}
		const hierarchyBlock = sessionLines.length ? sessionLines.join('\n') : '  (No active ADE sessions)';

		const missionAlias = getMissionDisplayName(roleConfig);
		const missions = missionService?.listMissions() ?? [];
		const shownMissions = missions.slice(0, MAX_SECRETARY_MISSIONS);
		const engBlock = shownMissions.length
			? [
				...shownMissions.map(m => {
					const parsed = parseMissionMermaidDag(m.mermaidText);
					return `  - [${missionAlias.toUpperCase()}] "${m.title}" (id: ${m.id}, nodes: ${parsed.nodes.length}, edges: ${parsed.edges.length})`;
				}),
				...(missions.length > MAX_SECRETARY_MISSIONS ? [`  - ... (+${missions.length - MAX_SECRETARY_MISSIONS} more missions; run \`aexus-ade mission list --json\`)`] : []),
			].join('\n')
			: `  (No active ${missionAlias}s)`;

		const activeInboxItems = inbox?.list({ includeResolved: false }) ?? [];
		const shownInbox = activeInboxItems.slice(0, MAX_SECRETARY_INBOX);
		const inboxBlock = shownInbox.length
			? [
				...shownInbox.map(item => `  - [${item.kind.toUpperCase()}] id=${item.id} (governor=${item.governorSessionId}${item.nodeId ? `, node=${item.nodeId}` : ''}${item.unread ? ', UNREAD' : ''}): ${item.title} — ${item.message.split('\n')[0].slice(0, 140)}`),
				...(activeInboxItems.length > MAX_SECRETARY_INBOX ? [`  - ... (+${activeInboxItems.length - MAX_SECRETARY_INBOX} more inbox items; run \`aexus-ade inbox list --json\`)`] : []),
			].join('\n')
			: '  (ADE Inbox empty)';

		if (compactDeltaMode) {
			return [
				'[ADE Live Viewport State]',
				`- Focus: ${focusLine} | Selected Project: ${selectedLine} | Active Editor: ${activeEditorLine}`,
				`- Live Counts: ${status.counts.projects} project(s), ${status.counts.totalActiveSessions} active session(s), ${missions.length} mission(s), ${inbox?.unreadCount ?? 0} unread inbox item(s)`,
			].join('\n');
		}

		const rankHeaderLine = '- Organizational Rank System (Numeric Tier Index L-1..LN; aliases hot-update via `aexus-ade rank names --json`):';
		const rankLines = roleConfig.ranks.map(r => {
			const apiList = r.pureExecution ? 'none (100% pure native context)' : (r.allowedApis.length > 0 ? r.allowedApis.join(', ') : 'none');
			return `  - \`${r.id}\` (L${r.tier} · ${r.name}): ${r.summary} [APIs: ${apiList}]`;
		});

		const l0DocPath = docsPaths?.rankDocs[ADE_SECRETARY_TIER_TAG] ?? '~/.aexus-code/docs/ranks/L0.md';
		const engineeringParadigmDocPath = docsPaths?.engineeringParadigmDoc ?? '~/.aexus-code/docs/engineering/ENGINEERING_PARADIGM.md';
		const engineeringApiDocPath = docsPaths?.engineeringApiDoc ?? '~/.aexus-code/docs/engineering/ENGINEERING_API.md';
		const missionDocPath = docsPaths?.missionDoc ?? '~/.aexus-code/docs/mission/MISSION_API.md';

		// KV-Cache Prefix Ordering (Contract C2): 100% invariant Charter + Rank System + CLI Reference FIRST;
		// volatile live viewport state (Focus, Counts, Projects, Missions, Inbox, Session Hierarchy) LAST.
		return [
			'[Aexus ADE Live Viewport & Macro Control Context]',
			'You are the global **Secretary (Tier L0)** in **Aexus Code ADE**, positioned strictly beneath User (`L-1`) and above `L1..LN` with macro-control authority inside ADE.',
			'- Scope & Boundary Rule: Operate STRICTLY inside **ADE** (Agentic Development Environment). Do NOT switch workbench mode to IDE and do NOT manipulate IDE-only views. Communication with `L1..LN` is strictly top-down (`org subordinates|send|context`).',
			`- Single-Copy Sibling Docs: Native L0 doc \`${l0DocPath}\` (docs/ranks/) | Engineering Paradigm & API (sibling docs/engineering/): \`${engineeringParadigmDocPath}\` & \`${engineeringApiDocPath}\` | Unified Mission doc: \`${missionDocPath}\``,
			'- Immutable Lazy-Read Entry Commands: `aexus-ade whoami --json` | `aexus-ade docs read L0` | `aexus-ade docs read engineering` | `aexus-ade docs read engineering-api` | `aexus-ade docs read common` | `aexus-ade docs read mission` | `aexus-ade api update --since 0 --json`',
			rankHeaderLine,
			`  - Strict Rank Order: L-1 (User) > L0 (Secretary) > ${formatOrganizationLadder(roleConfig)}.`,
			...rankLines,
			'- Complete ADE Macro Control CLI (`aexus-ade` is directly on your PATH; pass `--json` for structured output):',
			'  - Viewport & Inspector: `aexus-ade status --json` | `aexus-ade view [status | --archived <true|false|toggle> | --inspector <changes|files|hide> | --refresh] --json`',
			'  - Live Ranks, Hot-Updated Aliases & Single-Copy Docs: `aexus-ade rank names --json` | `aexus-ade rank list --json` | `aexus-ade rank get <L-1|L0|L1..LN|id> --json` | `aexus-ade rank docs [common|L0..LN|engineering|engineering-api|mission] --json` | `aexus-ade rank rename <L1..LN> "<alias>" [--short <tag>]` | `aexus-ade rank set-count <N>`',
			'  - Organization, Custom Ranks & Primitive APIs: `aexus-ade role list --json` | `aexus-ade role apis --json` | `aexus-ade role presets --json` | `aexus-ade role apply-preset <presetId>` | `aexus-ade role set-tier <sessionId> <rankId|worker|none>` | `aexus-ade role reset` | `aexus-ade role studio`',
			'  - Projects & Cloud Hosts: `aexus-ade project list|add|select|remove|delete|focus|home|forward|move` | `aexus-ade project changes [target]` | `aexus-ade project files [target]` | `aexus-ade project open-file|open-diff` | `aexus-ade host list|info|add|update|remove|test|browse|import-vscode`',
			'  - Top-Down Supervision & Sessions (`org.*` / `session.*` / `engine.*`): `aexus-ade org subordinates|send|context|escalate` | `aexus-ade engine list` | `aexus-ade engine sessions <e>` | `aexus-ade session list|info|subordinates|tree|create` | `aexus-ade session attach` | `aexus-ade session connect` | `aexus-ade session open|select|close|mark-read|draft|rename|role|move|reorder|send|history|stop|archive|unarchive|detach|delete`',
			'  - Engineering Dual-View Orchestration & Mission Task DAG (read `aexus-ade docs read engineering` & `aexus-ade docs read engineering-api` on demand; unified `docs read mission`): `aexus-ade orchestration get|validate|load|apply|export|staff|group|edge|status|pause|resume|abort|limits|dispatch --mission <id>` | `aexus-ade mission list|init|open|status|diagnostics|checkpoint|blueprint|task|trigger|host|export|import|remove --mission <id>` | `aexus-ade whiteboard list|create|read [--toc|--section <h>]|write [--section <h>] --mission <id>`',
			'  - ADE Inbox: `aexus-ade inbox list [--unread-only]` | `aexus-ade inbox post --from <sessionId> --message <text>` | `aexus-ade inbox mark-read (<id>|--all)` | `aexus-ade inbox resolve --id <msgId>`',
			'  - Secretary Self-Management: `aexus-ade secretary [status | open [--side] | engine <e> | reset [--engine <e>] | send <prompt> [--wait] | history [--limit <n>] | stop | draft [text|--clear] | mark-read]`',
			'- Live Viewport Snapshot:',
			`  - Focus State: ${focusLine}`,
			`  - Selected Project: ${selectedLine}`,
			`  - Sidebar State: showArchived=${status.showArchived}`,
			`  - Active ADE Editor: ${activeEditorLine}`,
			`  - Counts: ${status.counts.projects} project(s), ${status.counts.activeRootSessions} root session(s), ${status.counts.totalActiveSessions} total active session(s), ${status.counts.archived} archived, ${missions.length} mission(s), ${inbox?.unreadCount ?? 0} unread inbox item(s)`,
			'- ADE Projects:',
			projectLines,
			'- ADE Missions:',
			engBlock,
			'- ADE Inbox (Pending Gates & Escalations):',
			inboxBlock,
			'- Live ADE Session Hierarchy:',
			hierarchyBlock,
		].join('\n');
	}

	const agent = (explicitAgentId ? projects.getAgent(explicitAgentId) : undefined)
		?? (sessionResource ? projects.agents.find(entry => entry.session && (
			uriIdentity.extUri.isEqual(entry.session.resource, sessionResource)
			|| entry.session.resource.toString() === sessionResource.toString()
		)) : undefined);
	if (!agent) {
		return undefined;
	}

	if (compactDeltaMode) {
		// Work-tree and Mission node topology is locked, so subsequent turns need zero delta hierarchy overhead.
		if (agent.treeType === 'engineering' || agent.treeType === 'research' || agent.treeType === 'mission' || Boolean(agent.treeNodeId) || Boolean(resolveInGraphMissionBinding(agent, missionRuntime, missionService))) {
			return undefined;
		}
		const subordinates = projects.getDirectSubordinates(agent.id);
		if (!agent.role && subordinates.length === 0) {
			return undefined;
		}
		const rankDef = resolveEffectiveRankDefinition(roleConfig, agent.role, subordinates.length > 0);
		if (rankDef.pureExecution && subordinates.length === 0) {
			return undefined;
		}
		const supervisor = agent.parentId ? projects.getAgent(agent.parentId) : undefined;
		if (!supervisor && subordinates.length === 0) {
			return undefined;
		}
		const subSummary = subordinates.length > 0
			? subordinates.map(c => `${c.label} (${c.id}, ${formatRoleTitle(resolveAdeAgentRank(c, projects.hasSubordinates(c.id), roleConfig), roleConfig)})`).join(', ')
			: 'None';
		return [
			'[ADE Live Hierarchy State]',
			`- Role: ${rankDef.name} (session: ${agent.id}, project: ${projects.getProjectName(agent.projectUri)})`,
			...(supervisor ? [`- Supervisor: ${supervisor.label} (${supervisor.id})`] : []),
			`- Direct Subordinates: ${subSummary}`,
		].join('\n');
	}

	return buildAdeAgentRoleContext(projects, sessions, agent, roleConfig, docsPaths, missionRuntime, missionService);
}
