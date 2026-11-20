/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ADE_PRIMITIVE_APIS,
	ADE_RANK_COLOR_TOKENS,
	ADE_RANK_ICON_TOKENS,
	AdePrimitiveApiId,
	AdeRankColorToken,
	AdeRankIconToken,
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	IAdeOrganizationConfig,
	IAdeRankDefinition,
	normalizeAdeOrganizationConfig,
} from './adeRoleSchema.js';
import type { IAdeDocsPaths } from './adeDocsCatalog.js';

export const ADE_SECRETARY_TIER = 0;
export const ADE_SECRETARY_TIER_TAG = 'L0';
export const ADE_SECRETARY_ALIAS = 'Secretary';
export const ADE_MIN_RANK_COUNT = 1;
export const ADE_MAX_RANK_COUNT = 12;

export interface IAdeLiveRankEntry {
	readonly tier: number;
	readonly tierTag: string;
	readonly id: string;
	readonly alias: string;
	readonly shortName: string;
	readonly summary: string;
	readonly color: AdeRankColorToken;
	readonly icon: AdeRankIconToken;
	readonly pureExecution: boolean;
	readonly canHaveSubordinates: boolean;
	readonly allowedApis: readonly AdePrimitiveApiId[];
	readonly docPath: string;
	readonly isSystemL0?: boolean;
}

export interface IAdeLiveRankDirectory {
	readonly version: number;
	readonly presetId: string;
	readonly rankCount: number;
	readonly ranks: readonly IAdeLiveRankEntry[];
	readonly namesByTier: Readonly<Record<string, string>>;
	readonly tierByAlias: Readonly<Record<string, string>>;
	readonly docs?: IAdeDocsPaths;
}

const DEFAULT_FALLBACK_NAMES: readonly { readonly id: string; readonly name: string; readonly shortName: string; readonly color: AdeRankColorToken; readonly icon: AdeRankIconToken }[] = [
	{ id: 'governor', name: 'Governor', shortName: 'Gov', color: 'amber', icon: 'organization' },
	{ id: 'manager', name: 'Manager', shortName: 'Mgr', color: 'indigo', icon: 'briefcase' },
	{ id: 'employee', name: 'Employee', shortName: 'Emp', color: 'purple', icon: 'shield' },
	{ id: 'worker', name: 'Worker', shortName: 'Wrk', color: 'emerald', icon: 'tools' },
];

export function formatTierTag(tier: number): string {
	const n = Math.max(0, Math.floor(tier));
	return `L${n}`;
}

export function parseTierNumber(raw: string | number | undefined): number | undefined {
	if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && Number.isInteger(raw)) {
		return raw;
	}
	if (typeof raw !== 'string') {
		return undefined;
	}
	const trimmed = raw.trim();
	const m = /^l?(\d+)$/i.exec(trimmed);
	if (!m) {
		return undefined;
	}
	const parsed = Number.parseInt(m[1], 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Resolves a rank in `config` by tier tag (`"L1"`, `"l2"`, `1`), stable slug `id`, or current display alias (`name`).
 */
export function findRankByTierOrId(
	config: IAdeOrganizationConfig,
	query: string | number | undefined,
): IAdeRankDefinition | undefined {
	if (query === undefined || query === null) {
		return undefined;
	}
	const tierNum = parseTierNumber(query);
	if (tierNum !== undefined && tierNum >= 1) {
		return config.ranks.find(r => r.tier === tierNum);
	}
	if (typeof query !== 'string' || !query.trim()) {
		return undefined;
	}
	const key = query.trim().toLowerCase();
	return config.ranks.find(r => r.id.toLowerCase() === key)
		?? config.ranks.find(r => r.name.toLowerCase() === key)
		?? config.ranks.find(r => r.shortName.toLowerCase() === key);
}

function buildGeneratedRankForTier(tier: number, totalCount: number, usedIds: Set<string>): IAdeRankDefinition {
	const isTop = tier === 1;
	const isBottom = tier === totalCount;
	const defaultMatch = DEFAULT_ADE_ORGANIZATION_CONFIG.ranks[tier - 1];
	const fallbackMeta = DEFAULT_FALLBACK_NAMES[tier - 1];
	const color = fallbackMeta?.color ?? ADE_RANK_COLOR_TOKENS[(tier - 1) % ADE_RANK_COLOR_TOKENS.length];
	const icon = fallbackMeta?.icon ?? ADE_RANK_ICON_TOKENS[(tier - 1) % ADE_RANK_ICON_TOKENS.length];

	let id = fallbackMeta && !usedIds.has(fallbackMeta.id) ? fallbackMeta.id : `tier-${tier}`;
	while (usedIds.has(id)) {
		id = `tier-${tier}-${usedIds.size + 1}`;
	}
	usedIds.add(id);

	const name = fallbackMeta?.name ?? `Tier ${tier}`;
	const shortName = fallbackMeta?.shortName ?? `L${tier}`;

	if (totalCount === 1) {
		return {
			id,
			name,
			shortName,
			tier: 1,
			color,
			icon,
			summary: 'Single-tier autonomous agent with full workspace & Mission capabilities.',
			initPrompt: 'You operate at tier L1 for {{project.name}}. Read your tier API doc and collaborate cleanly.',
			pureExecution: false,
			canHaveSubordinates: false,
			allowedApis: ['session.read_context', 'session.message', 'project.read', 'host.access', 'inbox.post', 'engineering.read', 'engineering.design', 'engineering.review', 'engineering.integrate'],
		};
	}

	if (defaultMatch && tier <= DEFAULT_ADE_ORGANIZATION_CONFIG.ranks.length && !isBottom) {
		return { ...defaultMatch, id, tier };
	}

	if (isBottom) {
		return {
			id,
			name,
			shortName,
			tier,
			color,
			icon,
			summary: 'Lowest execution tier (pure native coding context by default).',
			initPrompt: '',
			pureExecution: true,
			canHaveSubordinates: false,
			allowedApis: [],
		};
	}

	if (isTop) {
		return {
			...(DEFAULT_ADE_ORGANIZATION_CONFIG.ranks[0]),
			id,
			name,
			shortName,
			tier: 1,
		};
	}

	return {
		id,
		name,
		shortName,
		tier,
		color,
		icon,
		summary: `Tier L${tier} coordinator & reviewer overseeing lower tiers.`,
		initPrompt: `You operate at tier L${tier} for {{project.name}}. Consult your L${tier} API reference doc and delegate execution downward.`,
		pureExecution: false,
		canHaveSubordinates: true,
		allowedApis: ['session.read_context', 'session.message', 'session.manage', 'project.read', 'host.access', 'engineering.read', 'engineering.review'],
	};
}

/**
 * Resizes the configured rank ladder to `targetCount` (`1..12`), strictly indexed `L1` (highest) → `L<N>` (lowest).
 * Existing user aliases, prompts, colors, icons, and API permissions are preserved wherever tiers remain.
 */
export function resizeOrganizationRanks(
	config: IAdeOrganizationConfig,
	targetCount: number,
): IAdeOrganizationConfig {
	const count = Math.max(ADE_MIN_RANK_COUNT, Math.min(ADE_MAX_RANK_COUNT, Math.floor(targetCount)));
	const current = [...config.ranks].sort((a, b) => a.tier - b.tier);
	const nextRanks: IAdeRankDefinition[] = [];
	const usedIds = new Set<string>();

	for (let i = 0; i < count; i++) {
		const tier = i + 1;
		const existing = current[i];
		if (existing) {
			usedIds.add(existing.id);
			const isSingle = count === 1;
			const isLast = tier === count;
			nextRanks.push({
				...existing,
				tier,
				canHaveSubordinates: isSingle ? false : (isLast ? false : existing.canHaveSubordinates || true),
				pureExecution: isSingle ? false : existing.pureExecution,
			});
		} else {
			nextRanks.push(buildGeneratedRankForTier(tier, count, usedIds));
		}
	}

	const linked = nextRanks.map((rank, idx) => ({
		...rank,
		defaultChildRankId: idx + 1 < nextRanks.length ? nextRanks[idx + 1].id : undefined,
	}));

	return normalizeAdeOrganizationConfig({
		version: 1,
		presetId: 'custom',
		ranks: linked,
		slots: config.slots,
	});
}

/**
 * Hot-renames a tier's display alias (and optional short tag) while keeping its tier index and machine ID stable.
 */
export function renameOrganizationRankAlias(
	config: IAdeOrganizationConfig,
	tierOrId: string | number,
	newAlias: string,
	newShortName?: string,
): IAdeOrganizationConfig {
	const trimmed = newAlias.trim();
	if (!trimmed) {
		throw new Error('Rank alias cannot be empty.');
	}
	const target = findRankByTierOrId(config, tierOrId);
	if (!target) {
		throw new Error(`Rank not found: ${String(tierOrId)}`);
	}
	const derivedShort = newShortName?.trim()
		|| (trimmed.length <= 5 ? trimmed : trimmed.slice(0, 4));
	const nextRanks = config.ranks.map(rank => rank.id === target.id
		? { ...rank, name: trimmed, shortName: derivedShort }
		: rank);
	return normalizeAdeOrganizationConfig({
		...config,
		presetId: config.presetId === 'default-4tier' ? 'custom' : config.presetId,
		ranks: nextRanks,
	});
}

/**
 * Builds the live, hot-updated rank directory including L0 (Secretary) and L1..LN.
 */
export function buildLiveRankDirectory(
	config: IAdeOrganizationConfig,
	docsPaths?: IAdeDocsPaths,
): IAdeLiveRankDirectory {
	const l0Entry: IAdeLiveRankEntry = {
		tier: ADE_SECRETARY_TIER,
		tierTag: ADE_SECRETARY_TIER_TAG,
		id: 'secretary',
		alias: ADE_SECRETARY_ALIAS,
		shortName: 'Sec',
		summary: 'Global sovereign ADE assistant (L0) with full macro-control over projects, sessions, ranks, and Missions.',
		color: 'cyan',
		icon: 'sparkle',
		pureExecution: false,
		canHaveSubordinates: true,
		allowedApis: ADE_PRIMITIVE_APIS.map(api => api.id),
		docPath: docsPaths?.rankDocs[ADE_SECRETARY_TIER_TAG] ?? '~/.aexus-code/docs/ranks/L0.md',
		isSystemL0: true,
	};

	const sorted = [...config.ranks].sort((a, b) => a.tier - b.tier);
	const tierEntries: IAdeLiveRankEntry[] = sorted.map(rank => {
		const tierTag = formatTierTag(rank.tier);
		return {
			tier: rank.tier,
			tierTag,
			id: rank.id,
			alias: rank.name,
			shortName: rank.shortName,
			summary: rank.summary,
			color: rank.color,
			icon: rank.icon,
			pureExecution: Boolean(rank.pureExecution),
			canHaveSubordinates: Boolean(rank.canHaveSubordinates),
			allowedApis: rank.pureExecution ? [] : [...rank.allowedApis],
			docPath: docsPaths?.rankDocs[tierTag] ?? `~/.aexus-code/docs/ranks/${tierTag}.md`,
		};
	});

	const allRanks = [l0Entry, ...tierEntries];
	const namesByTier: Record<string, string> = {};
	const tierByAlias: Record<string, string> = {};
	for (const entry of allRanks) {
		namesByTier[entry.tierTag] = entry.alias;
		tierByAlias[entry.alias.toLowerCase()] = entry.tierTag;
	}

	return {
		version: config.version,
		presetId: config.presetId ?? 'custom',
		rankCount: sorted.length,
		ranks: allRanks,
		namesByTier,
		tierByAlias,
		...(docsPaths ? { docs: docsPaths } : {}),
	};
}
