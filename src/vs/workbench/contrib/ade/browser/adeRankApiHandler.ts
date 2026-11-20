/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildAdeDocsPaths, IAdeDocsPaths } from '../../../../platform/ade/common/adeDocsCatalog.js';
import {
	ADE_SECRETARY_TIER_TAG,
	buildLiveRankDirectory,
	findRankByTierOrId,
	formatTierTag,
	parseTierNumber,
} from '../../../../platform/ade/common/adeRankResize.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, IAdeOrganizationConfig } from '../../../../platform/ade/common/adeRoleSchema.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';

export interface IAdeRankApiHandlerContext {
	readonly roleSchemaService: IAdeRoleSchemaService | undefined;
	readonly roleConfig: IAdeOrganizationConfig;
}

const RANK_API_ACTIONS = new Set([
	'rank.list',
	'rank.names',
	'rank.get',
	'rank.docs',
	'rank.rename',
	'rank.setCount',
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
	return buildAdeDocsPaths('~/.aexus-code', ctx.roleConfig.ranks.length);
}

/**
 * Handles hot-reloadable rank query/mutation APIs (`rank.list`, `rank.names`, `rank.get`,
 * `rank.docs`, `rank.rename`, `rank.setCount`) and `mission.docs`.
 */
export async function executeAdeRankOrDocsAction(
	action: string,
	params: Record<string, unknown>,
	ctx: IAdeRankApiHandlerContext,
): Promise<unknown> {
	const config = ctx.roleSchemaService?.getConfig() ?? ctx.roleConfig ?? DEFAULT_ADE_ORGANIZATION_CONFIG;

	switch (action) {
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
				namesByTier: dir.namesByTier,
				tierByAlias: dir.tierByAlias,
			};
		}

		case 'rank.get': {
			const rawTarget = params.tier ?? params.rank ?? params.id ?? params.target;
			const docs = await resolveDocsPaths(ctx, false);
			const dir = buildLiveRankDirectory(config, docs);
			const tierNum = parseTierNumber(rawTarget as string | number | undefined);
			if (tierNum === 0 || (typeof rawTarget === 'string' && rawTarget.trim().toLowerCase() === 'secretary')) {
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

		default:
			throw new Error(`Unsupported rank/docs action: ${action}`);
	}
}
