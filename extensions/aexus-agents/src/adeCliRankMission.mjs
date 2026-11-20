/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Modular CLI parsers for:
 * - `aexus-ade rank <list|names|get|docs|rename|set-count>` (hot-reloadable tier aliases & count >= 1)
 * - `aexus-ade mission <docs|...>` (unified Mission CLI routing)
 */

export const RANK_SUBCOMMANDS = [
	'list',
	'names',
	'get',
	'docs',
	'rename',
	'set-count',
];

export function parseRankGroupCommand(tail, json, windowId, usageError) {
	const sub = tail[0] ?? 'list';
	const args = tail.slice(1);

	if (sub === 'list') {
		return { help: false, json, windowId, action: 'rank.list', params: {} };
	}

	if (sub === 'names' || sub === 'aliases') {
		return { help: false, json, windowId, action: 'rank.names', params: {} };
	}

	if (sub === 'get' || sub === 'info') {
		const target = args[0]?.trim();
		if (!target) {
			throw usageError('Usage: aexus-ade rank get <L0|L1..LN|rankId|alias>');
		}
		return { help: false, json, windowId, action: 'rank.get', params: { target } };
	}

	if (sub === 'docs') {
		const target = args[0]?.trim();
		return {
			help: false,
			json,
			windowId,
			action: 'rank.docs',
			params: target ? { target } : {},
		};
	}

	if (sub === 'rename' || sub === 'alias') {
		let target;
		let alias;
		let shortName;
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === '--short' || arg === '--short-name') {
				const next = args[++i];
				if (!next) {
					throw usageError(`Option ${arg} requires a value.`);
				}
				shortName = next;
			} else if (arg.startsWith('--short=')) {
				shortName = arg.slice('--short='.length);
			} else if (arg.startsWith('--short-name=')) {
				shortName = arg.slice('--short-name='.length);
			} else if (arg.startsWith('-')) {
				throw usageError(`Unknown option for rank rename: ${arg}`);
			} else if (!target) {
				target = arg;
			} else if (!alias) {
				alias = arg;
			} else {
				alias = `${alias} ${arg}`;
			}
		}
		if (!target || !alias?.trim()) {
			throw usageError('Usage: aexus-ade rank rename <L1..LN|rankId> "<newAlias>" [--short <tag>]');
		}
		return {
			help: false,
			json,
			windowId,
			action: 'rank.rename',
			params: {
				target,
				alias: alias.trim(),
				...(shortName?.trim() ? { shortName: shortName.trim() } : {}),
			},
		};
	}

	if (sub === 'set-count' || sub === 'count' || sub === 'resize') {
		const rawCount = args[0]?.trim();
		if (!rawCount || !/^\d+$/.test(rawCount)) {
			throw usageError('Usage: aexus-ade rank set-count <N>  (integer >= 1)');
		}
		const count = Number.parseInt(rawCount, 10);
		if (count < 1) {
			throw usageError('Rank count must be at least 1 (L1 highest → LN lowest; L0 is Secretary).');
		}
		return {
			help: false,
			json,
			windowId,
			action: 'rank.setCount',
			params: { count },
		};
	}

	throw usageError(`Unknown rank subcommand: ${sub}`);
}

export function parseMissionDocsCommand(tail, json, windowId) {
	if (tail[0] === 'docs') {
		return { help: false, json, windowId, action: 'mission.docs', params: {} };
	}
	return undefined;
}

export function rewriteEngineeringActionToMission(parsed) {
	if (parsed.action && parsed.action.startsWith('engineering.')) {
		return {
			...parsed,
			action: `mission.${parsed.action.slice('engineering.'.length)}`,
		};
	}
	return parsed;
}
