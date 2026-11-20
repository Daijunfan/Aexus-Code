/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ADE_API_LATEST_REVISION, queryApiUpdateDiff } from '../../../../platform/ade/common/adeApiRegistry.js';
import { buildAdeDocsBundle, buildAdeDocsPaths, IAdeDocsPaths } from '../../../../platform/ade/common/adeDocsCatalog.js';
import { IAdeEngineeringBackendService } from '../../../../platform/ade/common/adeEngineering.js';
import { classifyTierFactorySide } from '../../../../platform/ade/common/adeMissionBoundary.js';
import {
	ADE_SECRETARY_TIER,
	ADE_SECRETARY_TIER_TAG,
	ADE_USER_TIER,
	buildLiveRankDirectory,
	findRankByTierOrId,
	formatTierTag,
	parseTierNumber,
} from '../../../../platform/ade/common/adeRankResize.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, IAdeOrganizationConfig, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import { ADE_SECRETARY_ID, IAdeProjectsService } from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { IAdeMissionRuntimeService } from './adeMissionRuntime.js';

export interface IAdeRankApiHandlerContext {
	readonly roleSchemaService: IAdeRoleSchemaService | undefined;
	readonly roleConfig: IAdeOrganizationConfig;
	readonly backendService?: IAdeEngineeringBackendService;
	readonly projectsService?: IAdeProjectsService;
	readonly missionRuntimeService?: IAdeMissionRuntimeService;
	readonly defaultAdeHomeDir?: string;
	readonly caller?: {
		readonly isHumanUser: boolean;
		readonly isSecretary: boolean;
		readonly sessionId?: string;
		readonly rankRaw?: string;
	};
}

const RANK_API_ACTIONS = new Set([
	'whoami',
	'docs.read',
	'api.update',
	'rank.list',
	'rank.names',
	'rank.get',
	'rank.docs',
	'rank.rename',
	'rank.setCount',
	'rank.setMissionName',
	'mission.renameAlias',
	'mission.docs',
]);

export function isAdeRankOrDocsAction(action: string): boolean {
	return RANK_API_ACTIONS.has(action);
}

async function resolveDocsPaths(ctx: IAdeRankApiHandlerContext, syncFirst: boolean): Promise<IAdeDocsPaths> {
	if (syncFirst && ctx.roleSchemaService?.syncDocs) {
		return ctx.roleSchemaService.syncDocs();
	}
	if (ctx.roleSchemaService?.getDocsPaths) {
		return ctx.roleSchemaService.getDocsPaths();
	}
	return buildAdeDocsPaths(ctx.defaultAdeHomeDir || '.aexus-code', ctx.roleConfig.ranks.length);
}

/**
 * Handles universal self/doc/diff APIs (`whoami`, `docs.read`, `api.update`),
 * hot-reloadable rank query/mutation APIs (`rank.*`), and `mission.docs`.
 */
export async function executeAdeRankOrDocsAction(
	action: string,
	params: Record<string, unknown>,
	ctx: IAdeRankApiHandlerContext,
): Promise<unknown> {
	const config = ctx.roleSchemaService?.getConfig() ?? ctx.roleConfig ?? DEFAULT_ADE_ORGANIZATION_CONFIG;

	switch (action) {
		case 'api.update': {
			const rawSince = params.since ?? params.from ?? params.revision;
			const sinceNum = typeof rawSince === 'number'
				? rawSince
				: (typeof rawSince === 'string' && rawSince.trim() ? Number(rawSince) : 0);
			const scope = typeof params.scope === 'string' ? params.scope : undefined;
			return queryApiUpdateDiff(sinceNum, scope);
		}

		case 'docs.read': {
			const rawTarget = String(params.target ?? params.doc ?? params.tier ?? 'common').trim() || 'common';
			let canonicalTarget = rawTarget;
			if (!/^common$/i.test(rawTarget) && !/^mission$/i.test(rawTarget) && !/^manifest$/i.test(rawTarget)) {
				const parsedTier = parseTierNumber(rawTarget);
				if (parsedTier !== undefined && parsedTier >= 0) {
					canonicalTarget = formatTierTag(parsedTier);
				} else if (/^secretary$/i.test(rawTarget)) {
					canonicalTarget = ADE_SECRETARY_TIER_TAG;
				} else {
					const matchedRank = findRankByTierOrId(config, rawTarget);
					if (matchedRank) {
						canonicalTarget = formatTierTag(matchedRank.tier);
					}
				}
			}

			if (ctx.backendService?.readApiDoc) {
				const res = await ctx.backendService.readApiDoc(canonicalTarget, config);
				if (!res.ok) {
					throw new Error(res.error ?? `API doc not found: ${rawTarget}`);
				}
				return res;
			}

			// Fallback for pure browser/unit-test environments without Node backend IPC.
			const bundle = buildAdeDocsBundle(config);
			const paths = await resolveDocsPaths(ctx, false);
			if (/^common$/i.test(canonicalTarget)) {
				return { ok: true, target: 'common', path: paths.commonDoc, revision: ADE_API_LATEST_REVISION, content: bundle.commonFile };
			}
			if (/^mission$/i.test(canonicalTarget)) {
				return { ok: true, target: 'mission', path: paths.missionDoc, revision: ADE_API_LATEST_REVISION, content: bundle.missionFile };
			}
			if (/^manifest$/i.test(canonicalTarget)) {
				return { ok: true, target: 'manifest', path: paths.manifestFile, revision: ADE_API_LATEST_REVISION, content: bundle.manifestJson };
			}
			const rankDoc = bundle.rankFiles[canonicalTarget] ?? bundle.rankFiles[`${canonicalTarget}.md`];
			if (!rankDoc) {
				throw new Error(`Unknown API doc target "${rawTarget}". Valid targets: common, mission, manifest, L0..L${config.ranks.length}.`);
			}
			return {
				ok: true,
				target: canonicalTarget,
				path: paths.rankDocs[canonicalTarget],
				revision: ADE_API_LATEST_REVISION,
				content: rankDoc,
			};
		}

		case 'whoami': {
			const docs = await resolveDocsPaths(ctx, false);
			const caller = ctx.caller;
			if (!caller || caller.isHumanUser) {
				return {
					id: 'human',
					tier: ADE_USER_TIER,
					tierTag: 'L-1',
					rankId: 'user',
					factorySide: 'off_graph',
					latestApiRevision: ADE_API_LATEST_REVISION,
					docsEntry: {
						common: 'aexus-ade docs read common',
						selfRank: 'aexus-ade docs read L0',
						mission: 'aexus-ade docs read mission',
						update: 'aexus-ade api update --since 0 --json',
						docsRoot: docs.docsRoot,
					},
				};
			}
			if (caller.isSecretary || caller.sessionId === ADE_SECRETARY_ID) {
				return {
					id: ADE_SECRETARY_ID,
					tier: ADE_SECRETARY_TIER,
					tierTag: ADE_SECRETARY_TIER_TAG,
					rankId: 'secretary',
					factorySide: 'off_graph',
					latestApiRevision: ADE_API_LATEST_REVISION,
					docsEntry: {
						common: 'aexus-ade docs read common',
						selfRank: 'aexus-ade docs read L0',
						mission: 'aexus-ade docs read mission',
						update: 'aexus-ade api update --since 0 --json',
						docsRoot: docs.docsRoot,
					},
				};
			}

			const sid = caller.sessionId;
			const agent = sid ? ctx.projectsService?.getAgent(sid) : undefined;
			const hasSubs = Boolean(agent && ctx.projectsService?.hasSubordinates(agent.id));
			const rankDef = resolveEffectiveRankDefinition(config, agent?.role ?? caller.rankRaw, hasSubs);
			const tierTag = formatTierTag(rankDef.tier);
			const missionHit = sid ? ctx.missionRuntimeService?.findMissionForAgent(sid) : undefined;
			const currentTokens = sid ? (ctx.missionRuntimeService?.getCurrentTokens(sid, missionHit?.mission.id) ?? []) : [];
			const offGraphMax = missionHit?.runtime.boundary.offGraphMaxTier ?? Math.max(0, Math.min(1, config.ranks.length - 1));
			const factorySide = missionHit
				? (missionHit.isOffGraphSupervisor ? 'off_graph' : 'in_graph')
				: classifyTierFactorySide(rankDef.tier, offGraphMax);

			return {
				id: sid ?? 'unknown',
				label: agent?.label,
				tier: rankDef.tier,
				tierTag,
				rankId: rankDef.id,
				factorySide,
				...(missionHit ? {
					missionId: missionHit.mission.id,
					nodeIds: missionHit.nodeIds,
					...(missionHit.managedNodeIds ? { managedNodeIds: missionHit.managedNodeIds } : {}),
				} : {}),
				currentTokenIds: currentTokens.map(t => t.id),
				currentTokens: currentTokens.map(t => ({
					id: t.id,
					missionId: t.missionId,
					nodeId: t.nodeId,
					waveId: t.waveId,
					status: t.status,
				})),
				latestApiRevision: ADE_API_LATEST_REVISION,
				docsEntry: {
					common: 'aexus-ade docs read common',
					selfRank: `aexus-ade docs read ${tierTag}`,
					mission: 'aexus-ade docs read mission',
					update: 'aexus-ade api update --since 0 --json',
					docsRoot: docs.docsRoot,
				},
			};
		}

		case 'rank.list': {
			const docs = await resolveDocsPaths(ctx, false);
			return buildLiveRankDirectory(config, docs);
		}

		case 'rank.names': {
			const docs = await resolveDocsPaths(ctx, false);
			const dir = buildLiveRankDirectory(config, docs);
			return {
				rankCount: dir.rankCount,
				presetId: dir.presetId,
				missionName: dir.missionName,
				namesByTier: dir.namesByTier,
				tierByAlias: dir.tierByAlias,
			};
		}

		case 'rank.get': {
			const rawTarget = params.tier ?? params.rank ?? params.id ?? params.target;
			const docs = await resolveDocsPaths(ctx, false);
			const dir = buildLiveRankDirectory(config, docs);
			const tierNum = parseTierNumber(rawTarget as string | number | undefined);
			const rawLower = typeof rawTarget === 'string' ? rawTarget.trim().toLowerCase() : '';
			if (tierNum === -1 || rawLower === 'user' || rawLower === 'human') {
				return dir.ranks.find(r => r.tier === -1);
			}
			if (tierNum === 0 || rawLower === 'secretary') {
				return dir.ranks.find(r => r.tier === 0);
			}
			const matched = findRankByTierOrId(config, rawTarget as string | number | undefined);
			if (!matched) {
				throw new Error(`Rank not found: ${String(rawTarget ?? '')}`);
			}
			return dir.ranks.find(r => r.id === matched.id);
		}

		case 'rank.docs': {
			const docs = await resolveDocsPaths(ctx, true);
			const rawTarget = typeof params.target === 'string' ? params.target.trim() : undefined;
			if (!rawTarget) {
				return docs;
			}
			if (rawTarget.toLowerCase() === 'common') {
				return { target: 'common', docPath: docs.commonDoc, docsRoot: docs.docsRoot, commonDir: docs.commonDir };
			}
			if (rawTarget.toLowerCase() === 'mission') {
				return { target: 'mission', docPath: docs.missionDoc, docsRoot: docs.docsRoot, missionDir: docs.missionDir };
			}
			const tierNum = parseTierNumber(rawTarget);
			if (tierNum === 0 || rawTarget.toLowerCase() === 'secretary') {
				return { target: ADE_SECRETARY_TIER_TAG, docPath: docs.rankDocs[ADE_SECRETARY_TIER_TAG], docsRoot: docs.docsRoot, ranksDir: docs.ranksDir };
			}
			const matched = findRankByTierOrId(config, rawTarget);
			const tag = matched ? formatTierTag(matched.tier) : (tierNum !== undefined ? formatTierTag(tierNum) : undefined);
			if (!tag || !docs.rankDocs[tag]) {
				throw new Error(`Rank doc not found for: ${rawTarget}`);
			}
			return { target: tag, docPath: docs.rankDocs[tag], docsRoot: docs.docsRoot, ranksDir: docs.ranksDir };
		}

		case 'mission.docs': {
			const docs = await resolveDocsPaths(ctx, true);
			return {
				missionDoc: docs.missionDoc,
				missionDir: docs.missionDir,
				commonDoc: docs.commonDoc,
				manifestFile: docs.manifestFile,
				docsRoot: docs.docsRoot,
				ranksDir: docs.ranksDir,
			};
		}

		case 'rank.rename': {
			if (!ctx.roleSchemaService?.renameRankAlias) {
				throw new Error('ADE Role Schema service is not available.');
			}
			const target = (params.tier ?? params.rank ?? params.id ?? params.target) as string | number | undefined;
			const alias = typeof (params.alias ?? params.name) === 'string' ? String(params.alias ?? params.name).trim() : '';
			const shortName = typeof (params.shortName ?? params.short) === 'string' ? String(params.shortName ?? params.short).trim() : undefined;
			if (target === undefined || !alias) {
				throw new Error('Both tier/id and alias are required for rank.rename.');
			}
			const updated = await ctx.roleSchemaService.renameRankAlias(target, alias, shortName);
			const docs = await resolveDocsPaths(ctx, true);
			return buildLiveRankDirectory(updated, docs);
		}

		case 'rank.setCount': {
			if (!ctx.roleSchemaService?.resizeRankCount) {
				throw new Error('ADE Role Schema service is not available.');
			}
			const rawCount = Number(params.count ?? params.rankCount);
			if (!Number.isInteger(rawCount) || rawCount < 1) {
				throw new Error('rank.setCount requires an integer count >= 1.');
			}
			const updated = await ctx.roleSchemaService.resizeRankCount(rawCount);
			const docs = await resolveDocsPaths(ctx, true);
			return buildLiveRankDirectory(updated, docs);
		}

		case 'rank.setMissionName':
		case 'mission.renameAlias': {
			if (!ctx.roleSchemaService?.renameMissionAlias) {
				throw new Error('ADE Role Schema service is not available.');
			}
			const alias = typeof (params.name ?? params.alias ?? params.missionName) === 'string'
				? String(params.name ?? params.alias ?? params.missionName).trim()
				: '';
			if (!alias) {
				throw new Error('Mission display alias is required.');
			}
			const updated = await ctx.roleSchemaService.renameMissionAlias(alias);
			const docs = await resolveDocsPaths(ctx, false);
			return buildLiveRankDirectory(updated, docs);
		}

		default:
			throw new Error(`Unsupported rank/docs action: ${action}`);
	}
}
