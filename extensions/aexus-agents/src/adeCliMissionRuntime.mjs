/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Modular CLI parsers for the unified Mission Runtime, Token Bus, Universal Docs/Diff,
 * and Strictly Top-Down Off-Graph Org Control commands (`mission_plan.md`).
 */

function takeOptVal(args, ref, flagName, usageError) {
	const cur = args[ref.i];
	const eqIdx = cur.indexOf('=');
	if (eqIdx >= 0) {
		const val = cur.slice(eqIdx + 1);
		if (!val) {
			throw usageError(`Option ${flagName} requires a value.`);
		}
		return val;
	}
	const next = args[++ref.i];
	if (next === undefined) {
		throw usageError(`Option ${flagName} requires a value.`);
	}
	return next;
}

function matchFlag(arg, ...names) {
	for (const n of names) {
		if (arg === n || arg.startsWith(`${n}=`)) {
			return true;
		}
	}
	return false;
}

export function parseWhoamiCommand(tail, json, windowId, usageError) {
	if (tail.length > 0) {
		throw usageError(`Unexpected arguments for whoami: ${tail.join(' ')}`);
	}
	return { help: false, json, windowId, action: 'whoami', params: {} };
}

export function parseDocsCommand(tail, json, windowId, usageError) {
	const first = tail[0]?.trim();
	if (!first) {
		throw usageError('Usage: aexus-ade docs read <common|mission|manifest|L0..LN>');
	}
	if (first === 'read' || first === 'get' || first === 'cat') {
		const target = tail[1]?.trim() || 'common';
		return { help: false, json, windowId, action: 'docs.read', params: { target } };
	}
	return { help: false, json, windowId, action: 'docs.read', params: { target: first } };
}

export function parseApiCommand(tail, json, windowId, usageError) {
	const sub = tail[0]?.trim();
	if (sub !== 'update' && sub !== 'diff') {
		throw usageError('Usage: aexus-ade api update [--since <rev>] [--scope <all|common|in_graph|off_graph|mission>]');
	}
	const args = tail.slice(1);
	let since = 0;
	let scope;
	for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
		const arg = args[ref.i];
		if (matchFlag(arg, '--since', '--from', '--rev', '--revision')) {
			const val = takeOptVal(args, ref, '--since', usageError);
			const num = Number(val);
			if (!Number.isFinite(num) || num < 0) {
				throw usageError(`Invalid revision for --since: ${val}`);
			}
			since = Math.floor(num);
		} else if (matchFlag(arg, '--scope')) {
			scope = takeOptVal(args, ref, '--scope', usageError).trim();
		} else if (!arg.startsWith('-') && since === 0 && /^\d+$/.test(arg)) {
			since = Number.parseInt(arg, 10);
		} else {
			throw usageError(`Unknown option for api update: ${arg}`);
		}
	}
	return {
		help: false,
		json,
		windowId,
		action: 'api.update',
		params: {
			since,
			...(scope ? { scope } : {}),
		},
	};
}

export function parseTokenGroupCommand(tail, json, windowId, usageError) {
	const sub = tail[0]?.trim() || 'current';
	const args = tail.slice(1);

	if (sub === 'current' || sub === 'list' || sub === 'get') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--agent', '--agent-id')) {
				params.agentId = takeOptVal(args, ref, '--agent', usageError);
			} else {
				throw usageError(`Unknown option for token ${sub}: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: 'token.current', params };
	}

	if (sub === 'trace') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--limit')) {
				const num = Number(takeOptVal(args, ref, '--limit', usageError));
				if (!Number.isInteger(num) || num < 1) {
					throw usageError('Option --limit requires a positive integer.');
				}
				params.limit = num;
			} else if (matchFlag(arg, '--ptr', '--trace-ptr')) {
				params.tracePtr = takeOptVal(args, ref, '--ptr', usageError);
			} else if (!arg.startsWith('-') && !params.tracePtr) {
				params.tracePtr = arg;
			} else {
				throw usageError(`Unknown option for token trace: ${arg}`);
			}
		}
		if (!params.tracePtr) {
			throw usageError('Usage: aexus-ade token trace <tracePtr> [--mission <id>] [--limit <n>]');
		}
		return { help: false, json, windowId, action: 'token.trace', params };
	}

	if (sub === 'complete' || sub === 'done' || sub === 'submit') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--summary', '--message')) {
				params.summary = takeOptVal(args, ref, '--summary', usageError);
			} else if (matchFlag(arg, '--token', '--token-id')) {
				params.tokenId = takeOptVal(args, ref, '--token', usageError);
			} else if (!arg.startsWith('-') && !params.tokenId) {
				params.tokenId = arg;
			} else {
				throw usageError(`Unknown option for token complete: ${arg}`);
			}
		}
		if (!params.tokenId || !params.summary) {
			throw usageError('Usage: aexus-ade token complete <tokenId> --summary "<concise factual summary>" [--mission <id>]');
		}
		return { help: false, json, windowId, action: 'token.complete', params };
	}

	if (sub === 'reject') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--reason', '--feedback', '--message')) {
				params.reason = takeOptVal(args, ref, '--reason', usageError);
			} else if (matchFlag(arg, '--target', '--to', '--target-node', '--node')) {
				params.targetNodeId = takeOptVal(args, ref, '--target', usageError);
			} else if (matchFlag(arg, '--token', '--token-id')) {
				params.tokenId = takeOptVal(args, ref, '--token', usageError);
			} else if (!arg.startsWith('-') && !params.tokenId) {
				params.tokenId = arg;
			} else {
				throw usageError(`Unknown option for token reject: ${arg}`);
			}
		}
		if (!params.tokenId || !params.reason) {
			throw usageError('Usage: aexus-ade token reject <tokenId> --reason "<why>" [--target <nodeId>] [--mission <id>]');
		}
		return { help: false, json, windowId, action: 'token.reject', params };
	}

	if (sub === 'block') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--max', '--max-duration', '--duration')) {
				params.maxDuration = takeOptVal(args, ref, '--duration', usageError);
			} else if (matchFlag(arg, '--reason', '--message')) {
				params.reason = takeOptVal(args, ref, '--reason', usageError);
			} else if (matchFlag(arg, '--watch-pid', '--pid')) {
				const raw = takeOptVal(args, ref, '--watch-pid', usageError);
				if (!/^\d+$/.test(raw)) {
					throw usageError(`Invalid PID for --watch-pid: ${raw}`);
				}
				params.watchPid = Number.parseInt(raw, 10);
			} else if (matchFlag(arg, '--watch-file', '--file')) {
				params.watchFile = takeOptVal(args, ref, '--watch-file', usageError);
			} else if (matchFlag(arg, '--host', '--host-alias')) {
				params.hostAlias = takeOptVal(args, ref, '--host', usageError);
			} else if (matchFlag(arg, '--token', '--token-id')) {
				params.tokenId = takeOptVal(args, ref, '--token', usageError);
			} else if (!arg.startsWith('-') && !params.tokenId) {
				params.tokenId = arg;
			} else {
				throw usageError(`Unknown option for token block: ${arg}`);
			}
		}
		if (!params.tokenId || !params.maxDuration) {
			throw usageError('Usage: aexus-ade token block <tokenId> --duration <duration> [--reason "<why>"] [--watch-pid <pid>] [--watch-file <path>] [--host <alias>]');
		}
		return { help: false, json, windowId, action: 'token.block', params };
	}

	if (sub === 'fail') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--reason', '--message')) {
				params.reason = takeOptVal(args, ref, '--reason', usageError);
			} else if (matchFlag(arg, '--token', '--token-id')) {
				params.tokenId = takeOptVal(args, ref, '--token', usageError);
			} else if (!arg.startsWith('-') && !params.tokenId) {
				params.tokenId = arg;
			} else {
				throw usageError(`Unknown option for token fail: ${arg}`);
			}
		}
		if (!params.tokenId || !params.reason) {
			throw usageError('Usage: aexus-ade token fail <tokenId> --reason "<why>" [--mission <id>]');
		}
		return { help: false, json, windowId, action: 'token.fail', params };
	}

	throw usageError(`Unknown token subcommand: ${sub}`);
}

export function parseOrgCommandIfRuntime(tail, json, windowId, usageError) {
	const sub = tail[0]?.trim();
	const args = tail.slice(1);

	if (sub === 'subordinates' || sub === 'subs' || sub === 'jurisdiction') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (!arg.startsWith('-') && !params.id) {
				params.id = arg.trim();
			} else {
				throw usageError(`Unknown option for org subordinates: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: 'org.subordinates', params };
	}

	if (sub === 'send') {
		let target;
		let wait = false;
		let missionId;
		const msgParts = [];
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (arg === '--wait') {
				wait = true;
			} else if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--to', '--target')) {
				target = takeOptVal(args, ref, '--to', usageError);
			} else if (matchFlag(arg, '--message')) {
				msgParts.push(takeOptVal(args, ref, '--message', usageError));
			} else if (!target && !arg.startsWith('-')) {
				target = arg;
			} else {
				msgParts.push(arg);
			}
		}
		const message = msgParts.join(' ').trim();
		if (!target || !message) {
			throw usageError('Usage: aexus-ade org send <nodeOrSessionId> "<message>" [--mission <id>] [--wait]');
		}
		return {
			help: false,
			json,
			windowId,
			action: 'org.send',
			params: { target, message, ...(missionId ? { missionId } : {}), ...(wait ? { wait: true } : {}) },
		};
	}

	if (sub === 'context' || sub === 'history') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--limit')) {
				const num = Number(takeOptVal(args, ref, '--limit', usageError));
				if (!Number.isInteger(num) || num < 1) {
					throw usageError('Option --limit requires a positive integer.');
				}
				params.limit = num;
			} else if (matchFlag(arg, '--target', '--agent')) {
				params.target = takeOptVal(args, ref, '--target', usageError);
			} else if (!arg.startsWith('-') && !params.target) {
				params.target = arg;
			} else {
				throw usageError(`Unknown option for org context: ${arg}`);
			}
		}
		if (!params.target) {
			throw usageError('Usage: aexus-ade org context <nodeOrSessionId> [--limit <n>] [--mission <id>]');
		}
		return { help: false, json, windowId, action: 'org.context', params };
	}

	if (sub === 'escalate') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--token', '--token-id')) {
				params.tokenId = takeOptVal(args, ref, '--token', usageError);
			} else if (matchFlag(arg, '--node', '--node-id')) {
				params.nodeId = takeOptVal(args, ref, '--node', usageError);
			} else if (matchFlag(arg, '--from', '--supervisor')) {
				params.from = takeOptVal(args, ref, '--from', usageError);
			} else if (matchFlag(arg, '--reason', '--message')) {
				params.reason = takeOptVal(args, ref, '--reason', usageError);
			} else {
				throw usageError(`Unknown option for org escalate: ${arg}`);
			}
		}
		if (!params.reason) {
			throw usageError('Usage: aexus-ade org escalate --reason "<why>" [--mission <id>] [--token <tokenId>] [--node <nodeId>]');
		}
		return { help: false, json, windowId, action: 'org.escalate', params };
	}

	return undefined;
}

/**
 * Parses Mission Runtime subcommands (`start`, `timeout`, `boundary`, `recall`, `patch`, `trigger`, `host`).
 * Accepts `--mission` everywhere (with `--governor` kept as a hidden backward-compatible alias).
 */
export function parseMissionRuntimeSubcommand(tail, json, windowId, usageError) {
	const sub = tail[0]?.trim();
	const args = tail.slice(1);

	if (sub === 'start') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--timeout', '--silence-timeout', '--minutes')) {
				const num = Number(takeOptVal(args, ref, '--timeout', usageError));
				if (!Number.isFinite(num) || num < 1) {
					throw usageError('Option --timeout requires a positive number of minutes.');
				}
				params.silenceTimeoutMinutes = Math.round(num);
			} else if (matchFlag(arg, '--prompt')) {
				params.initialPrompt = takeOptVal(args, ref, '--prompt', usageError);
			} else if (!arg.startsWith('-') && !params.missionId) {
				params.missionId = arg;
			} else {
				throw usageError(`Unknown option for mission start: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: 'mission.start', params };
	}

	if (sub === 'timeout') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--minutes', '--timeout')) {
				const num = Number(takeOptVal(args, ref, '--minutes', usageError));
				if (!Number.isFinite(num) || num < 1) {
					throw usageError('Option --minutes requires a positive number.');
				}
				params.minutes = Math.round(num);
			} else if (!arg.startsWith('-') && /^\d+$/.test(arg) && params.minutes === undefined) {
				params.minutes = Number.parseInt(arg, 10);
			} else {
				throw usageError(`Unknown option for mission timeout: ${arg}`);
			}
		}
		if (params.minutes === undefined) {
			throw usageError('Usage: aexus-ade mission timeout [--mission <id>] --minutes <n>');
		}
		return { help: false, json, windowId, action: 'mission.timeout.set', params };
	}

	if (sub === 'boundary') {
		const bSub = args[0]?.trim() || 'get';
		const bArgs = args.slice(1);
		if (bSub === 'get' || bSub === 'show') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < bArgs.length; ref.i++) {
				const arg = bArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
					params.missionId = takeOptVal(bArgs, ref, '--mission', usageError);
				} else if (!arg.startsWith('-') && !params.missionId) {
					params.missionId = arg;
				} else {
					throw usageError(`Unknown option for mission boundary get: ${arg}`);
				}
			}
			return { help: false, json, windowId, action: 'mission.boundary.get', params };
		}
		if (bSub === 'set') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < bArgs.length; ref.i++) {
				const arg = bArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
					params.missionId = takeOptVal(bArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--off-graph-max-tier', '--cutoff', '--max-tier')) {
					const val = Number(takeOptVal(bArgs, ref, '--off-graph-max-tier', usageError));
					if (!Number.isInteger(val) || val < 0) {
						throw usageError('Option --off-graph-max-tier requires a non-negative integer.');
					}
					params.offGraphMaxTier = val;
				} else if (matchFlag(arg, '--supervisors-json')) {
					try {
						params.supervisors = JSON.parse(takeOptVal(bArgs, ref, '--supervisors-json', usageError));
					} catch {
						throw usageError('Option --supervisors-json must be valid JSON.');
					}
				} else if (matchFlag(arg, '--assignments-json')) {
					try {
						params.nodeAssignments = JSON.parse(takeOptVal(bArgs, ref, '--assignments-json', usageError));
					} catch {
						throw usageError('Option --assignments-json must be valid JSON.');
					}
				} else {
					throw usageError(`Unknown option for mission boundary set: ${arg}`);
				}
			}
			return { help: false, json, windowId, action: 'mission.boundary.set', params };
		}
		throw usageError(`Unknown mission boundary subcommand: ${bSub}`);
	}

	if (sub === 'recall') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--nodes', '--node-ids', '--node')) {
				params.nodes = takeOptVal(args, ref, '--nodes', usageError).split(',').map(s => s.trim()).filter(Boolean);
			} else if (matchFlag(arg, '--branch', '--branch-root', '--from-node')) {
				params.branchRootNodeId = takeOptVal(args, ref, '--branch', usageError);
			} else if (matchFlag(arg, '--reason', '--message')) {
				params.reason = takeOptVal(args, ref, '--reason', usageError);
			} else {
				throw usageError(`Unknown option for mission recall: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: 'mission.recall', params };
	}

	if (sub === 'patch') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--file', '-f')) {
				params.file = takeOptVal(args, ref, '--file', usageError);
			} else if (matchFlag(arg, '--mermaid', '--text')) {
				params.mermaid = takeOptVal(args, ref, '--mermaid', usageError);
			} else if (matchFlag(arg, '--reason', '--message')) {
				params.reason = takeOptVal(args, ref, '--reason', usageError);
			} else {
				throw usageError(`Unknown option for mission patch: ${arg}`);
			}
		}
		if (!params.file && !params.mermaid) {
			throw usageError('Usage: aexus-ade mission patch [--mission <id>] (--file <path> | --text "<mermaid>") [--reason "<why>"]');
		}
		return { help: false, json, windowId, action: 'mission.patch', params };
	}

	if (sub === 'trigger' || sub === 'triggers') {
		const tSub = args[0]?.trim() || 'list';
		const tArgs = args.slice(1);
		if (tSub === 'list') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < tArgs.length; ref.i++) {
				const arg = tArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
					params.missionId = takeOptVal(tArgs, ref, '--mission', usageError);
				} else if (!arg.startsWith('-') && !params.missionId) {
					params.missionId = arg;
				} else {
					throw usageError(`Unknown option for mission trigger list: ${arg}`);
				}
			}
			return { help: false, json, windowId, action: 'mission.trigger.list', params };
		}
		if (tSub === 'set' || tSub === 'add') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < tArgs.length; ref.i++) {
				const arg = tArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(tArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--trigger', '--trigger-id', '--id')) {
					params.triggerId = takeOptVal(tArgs, ref, '--trigger', usageError);
				} else if (matchFlag(arg, '--node', '--node-id')) {
					params.nodeId = takeOptVal(tArgs, ref, '--node', usageError);
				} else if (matchFlag(arg, '--kind', '--type')) {
					params.kind = takeOptVal(tArgs, ref, '--kind', usageError);
				} else if (matchFlag(arg, '--fire-at')) {
					params.fireAt = takeOptVal(tArgs, ref, '--fire-at', usageError);
				} else if (matchFlag(arg, '--delay')) {
					params.delay = takeOptVal(tArgs, ref, '--delay', usageError);
				} else if (matchFlag(arg, '--interval')) {
					params.interval = takeOptVal(tArgs, ref, '--interval', usageError);
				} else if (matchFlag(arg, '--cron')) {
					params.cronExpr = takeOptVal(tArgs, ref, '--cron', usageError);
				} else if (matchFlag(arg, '--event-type', '--event')) {
					params.eventType = takeOptVal(tArgs, ref, '--event-type', usageError);
				} else if (matchFlag(arg, '--target', '--path', '--target-path')) {
					params.targetPath = takeOptVal(tArgs, ref, '--target', usageError);
				} else if (matchFlag(arg, '--host', '--host-alias')) {
					params.hostAlias = takeOptVal(tArgs, ref, '--host', usageError);
				} else if (matchFlag(arg, '--gpu-threshold')) {
					params.gpuThreshold = Number(takeOptVal(tArgs, ref, '--gpu-threshold', usageError));
				} else if (arg === '--disabled') {
					params.disabled = true;
				} else if (arg === '--auto-start') {
					params.autoStartOnMissionStart = true;
				} else {
					throw usageError(`Unknown option for mission trigger set: ${arg}`);
				}
			}
			if (!params.nodeId || !params.kind) {
				throw usageError('Usage: aexus-ade mission trigger set [--mission <id>] --node <id> --kind <once|interval|cron|event> [...]');
			}
			return { help: false, json, windowId, action: 'mission.trigger.set', params };
		}
		if (tSub === 'remove' || tSub === 'rm' || tSub === 'delete') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < tArgs.length; ref.i++) {
				const arg = tArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(tArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--trigger', '--trigger-id', '--id')) {
					params.triggerId = takeOptVal(tArgs, ref, '--trigger', usageError);
				} else if (!arg.startsWith('-') && !params.triggerId) {
					params.triggerId = arg;
				} else {
					throw usageError(`Unknown option for mission trigger remove: ${arg}`);
				}
			}
			if (!params.triggerId) {
				throw usageError('Usage: aexus-ade mission trigger remove [--mission <id>] --trigger <id>');
			}
			return { help: false, json, windowId, action: 'mission.trigger.remove', params };
		}
		throw usageError(`Unknown mission trigger subcommand: ${tSub}`);
	}

	if (sub === 'host') {
		const hSub = args[0]?.trim();
		const hArgs = args.slice(1);
		if (hSub !== 'bind' && hSub !== 'set') {
			throw usageError('Usage: aexus-ade mission host bind [--mission <id>] --node <id> --host <local|alias> [--path <remotePath>] [--agent <agentId>] [--role-kind <worker|reviewer>]');
		}
		const params = {};
		for (const ref = { i: 0 }; ref.i < hArgs.length; ref.i++) {
			const arg = hArgs[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(hArgs, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--node', '--node-id')) {
				params.nodeId = takeOptVal(hArgs, ref, '--node', usageError);
			} else if (matchFlag(arg, '--host', '--host-alias')) {
				params.hostAlias = takeOptVal(hArgs, ref, '--host', usageError);
			} else if (matchFlag(arg, '--path', '--remote-path')) {
				params.remoteProjectPath = takeOptVal(hArgs, ref, '--path', usageError);
			} else if (matchFlag(arg, '--agent', '--agent-id')) {
				params.agentId = takeOptVal(hArgs, ref, '--agent', usageError);
			} else if (matchFlag(arg, '--role-kind', '--node-role')) {
				params.roleKind = takeOptVal(hArgs, ref, '--role-kind', usageError);
			} else {
				throw usageError(`Unknown option for mission host bind: ${arg}`);
			}
		}
		if (!params.nodeId || !params.hostAlias) {
			throw usageError('Usage: aexus-ade mission host bind [--mission <id>] --node <id> --host <local|alias> [--path <remotePath>]');
		}
		return { help: false, json, windowId, action: 'mission.host.bind', params };
	}

	return undefined;
}
