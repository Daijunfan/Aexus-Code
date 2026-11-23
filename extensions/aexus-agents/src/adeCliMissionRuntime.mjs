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
		throw usageError('Usage: aexus-ade docs read <common|L0..LN|engineering|paradigm|engineering-api|mission|manifest>');
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

function parseKeyValBlobFlag(rawValue, flagName, usageError) {
	const eqIdx = rawValue.indexOf('=');
	if (eqIdx <= 0) {
		throw usageError(`${flagName} expects "Title=Content" (e.g. ${flagName} "API Spec=...").`);
	}
	const title = rawValue.slice(0, eqIdx).trim();
	const content = rawValue.slice(eqIdx + 1).trim();
	if (!title || !content) {
		throw usageError(`${flagName} requires both a non-empty Title and Content ("Title=Content").`);
	}
	return { title, content };
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

	if (sub === 'read' || sub === 'inspect' || sub === 'deref') {
		const params = { ptrs: [] };
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--token', '--token-id')) {
				params.tokenId = takeOptVal(args, ref, '--token', usageError);
			} else if (matchFlag(arg, '--ptr', '--ptrs', '--ref', '--refs')) {
				const raw = takeOptVal(args, ref, '--ptr', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.ptrs.push(...raw);
			} else if (!arg.startsWith('-')) {
				params.ptrs.push(...arg.split(',').map(s => s.trim()).filter(Boolean));
			} else {
				throw usageError(`Unknown option for token read: ${arg}`);
			}
		}
		if (params.ptrs.length === 0) {
			throw usageError('Usage: aexus-ade token read <ptr1[,ptr2...]> [--mission <id>] [--token <tokenId>]');
		}
		return { help: false, json, windowId, action: 'token.read', params };
	}

	if (sub === 'history' || sub === 'log') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--token', '--token-id')) {
				params.tokenId = takeOptVal(args, ref, '--token', usageError);
			} else if (arg === '--all') {
				params.all = true;
			} else if (arg === '--delta' || arg === '--delta-only') {
				params.deltaOnly = true;
			} else if (!arg.startsWith('-') && !params.tokenId) {
				params.tokenId = arg;
			} else {
				throw usageError(`Unknown option for token history: ${arg}`);
			}
		}
		if (!params.tokenId) {
			throw usageError('Usage: aexus-ade token history <tokenId> [--mission <id>] [--all | --delta]');
		}
		return { help: false, json, windowId, action: 'token.history', params };
	}

	if (sub === 'complete' || sub === 'done' || sub === 'submit') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--summary', '--message')) {
				params.summary = takeOptVal(args, ref, '--summary', usageError);
			} else if (matchFlag(arg, '--detail', '--body')) {
				params.detail = takeOptVal(args, ref, '--detail', usageError);
			} else if (matchFlag(arg, '--artifact')) {
				const item = parseKeyValBlobFlag(takeOptVal(args, ref, '--artifact', usageError), '--artifact', usageError);
				params.artifacts = [...(params.artifacts ?? []), item];
			} else if (matchFlag(arg, '--decision')) {
				const item = parseKeyValBlobFlag(takeOptVal(args, ref, '--decision', usageError), '--decision', usageError);
				params.decisions = [...(params.decisions ?? []), item];
			} else if (matchFlag(arg, '--ref', '--refs')) {
				const rawRefs = takeOptVal(args, ref, '--ref', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.refPtrs = [...(params.refPtrs ?? []), ...rawRefs];
			} else if (matchFlag(arg, '--to', '--target', '--targets')) {
				const rawTo = takeOptVal(args, ref, '--to', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.toNodeIds = [...(params.toNodeIds ?? []), ...rawTo];
			} else if (matchFlag(arg, '--whiteboard', '--whiteboards', '--wb')) {
				const rawWb = takeOptVal(args, ref, '--whiteboard', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.whiteboardIds = [...(params.whiteboardIds ?? []), ...rawWb];
			} else if (matchFlag(arg, '--task', '--task-id', '--task-node')) {
				params.taskNodeId = takeOptVal(args, ref, '--task', usageError);
			} else if (matchFlag(arg, '--tasks', '--task-ids')) {
				const rawT = takeOptVal(args, ref, '--tasks', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.taskNodeIds = [...(params.taskNodeIds ?? []), ...rawT];
			} else if (matchFlag(arg, '--files', '--modified-files', '--changed-files')) {
				const rawFiles = takeOptVal(args, ref, '--files', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.modifiedFiles = [...(params.modifiedFiles ?? []), ...rawFiles];
			} else if (arg === '--finish' || arg === '--final') {
				params.finish = true;
			} else if (matchFlag(arg, '--token', '--token-id')) {
				params.tokenId = takeOptVal(args, ref, '--token', usageError);
			} else if (arg === '--skip-checks') {
				params.skipChecks = true;
			} else if (!arg.startsWith('-') && !params.tokenId) {
				params.tokenId = arg;
			} else {
				throw usageError(`Unknown option for token complete: ${arg}`);
			}
		}
		if (!params.tokenId || !params.summary) {
			throw usageError('Usage: aexus-ade token complete <tokenId> --summary "<1-line headline>" [--detail "<full round detail>"] [--artifact "Title=Body"] [--decision "Title=Body"] [--to <nodeId[,...]>] [--whiteboard <wbId[,...]>] [--finish] [--mission <id>]');
		}
		return { help: false, json, windowId, action: 'token.complete', params };
	}

	if (sub === 'handoff' || sub === 'pass' || sub === 'relay') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--to', '--target', '--targets')) {
				const rawTo = takeOptVal(args, ref, '--to', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.toNodeIds = [...(params.toNodeIds ?? []), ...rawTo];
			} else if (matchFlag(arg, '--summary', '--message')) {
				params.summary = takeOptVal(args, ref, '--summary', usageError);
			} else if (matchFlag(arg, '--detail', '--body')) {
				params.detail = takeOptVal(args, ref, '--detail', usageError);
			} else if (matchFlag(arg, '--artifact')) {
				const item = parseKeyValBlobFlag(takeOptVal(args, ref, '--artifact', usageError), '--artifact', usageError);
				params.artifacts = [...(params.artifacts ?? []), item];
			} else if (matchFlag(arg, '--decision')) {
				const item = parseKeyValBlobFlag(takeOptVal(args, ref, '--decision', usageError), '--decision', usageError);
				params.decisions = [...(params.decisions ?? []), item];
			} else if (matchFlag(arg, '--ref', '--refs')) {
				const rawRefs = takeOptVal(args, ref, '--ref', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.refPtrs = [...(params.refPtrs ?? []), ...rawRefs];
			} else if (matchFlag(arg, '--whiteboard', '--whiteboards', '--wb')) {
				const rawWb = takeOptVal(args, ref, '--whiteboard', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.whiteboardIds = [...(params.whiteboardIds ?? []), ...rawWb];
			} else if (matchFlag(arg, '--task', '--task-id', '--task-node')) {
				params.taskNodeId = takeOptVal(args, ref, '--task', usageError);
			} else if (matchFlag(arg, '--tasks', '--task-ids')) {
				const rawT = takeOptVal(args, ref, '--tasks', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.taskNodeIds = [...(params.taskNodeIds ?? []), ...rawT];
			} else if (matchFlag(arg, '--files', '--modified-files', '--changed-files')) {
				const rawFiles = takeOptVal(args, ref, '--files', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.modifiedFiles = [...(params.modifiedFiles ?? []), ...rawFiles];
			} else if (arg === '--skip-checks') {
				params.skipChecks = true;
			} else if (matchFlag(arg, '--token', '--token-id')) {
				params.tokenId = takeOptVal(args, ref, '--token', usageError);
			} else if (!arg.startsWith('-') && !params.tokenId) {
				params.tokenId = arg;
			} else {
				throw usageError(`Unknown option for token handoff: ${arg}`);
			}
		}
		if (!params.tokenId || !params.toNodeIds?.length || !params.summary) {
			throw usageError('Usage: aexus-ade token handoff <tokenId> --to <nodeId[,nodeId2]> --summary "<1-line headline>" [--detail "<full round detail>"] [--task <taskId>] [--artifact "Title=Body"] [--decision "Title=Body"] [--whiteboard <wbId[,...]>] [--ref <ptr[,...]>] [--mission <id>]');
		}
		return { help: false, json, windowId, action: 'token.handoff', params };
	}

	if (sub === 'mint' || sub === 'split' || sub === 'fork') {
		const isSplit = sub === 'split' || sub === 'fork';
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--to', '--target', '--targets')) {
				const rawTo = takeOptVal(args, ref, '--to', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.toNodeIds = [...(params.toNodeIds ?? []), ...rawTo];
			} else if (matchFlag(arg, '--summary', '--message')) {
				params.summary = takeOptVal(args, ref, '--summary', usageError);
			} else if (matchFlag(arg, '--detail', '--body')) {
				params.detail = takeOptVal(args, ref, '--detail', usageError);
			} else if (matchFlag(arg, '--task', '--task-id', '--task-node')) {
				params.taskNodeId = takeOptVal(args, ref, '--task', usageError);
			} else if (matchFlag(arg, '--tasks', '--task-ids')) {
				const rawT = takeOptVal(args, ref, '--tasks', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.taskNodeIds = [...(params.taskNodeIds ?? []), ...rawT];
			} else if (matchFlag(arg, '--branches-json', '--branches')) {
				params.branchesJson = takeOptVal(args, ref, '--branches-json', usageError);
			} else if (matchFlag(arg, '--branch')) {
				const rawBranch = takeOptVal(args, ref, '--branch', usageError);
				let parsedBranch;
				try {
					parsedBranch = JSON.parse(rawBranch);
				} catch (err) {
					throw usageError(`Option --branch expects valid JSON object/array: ${err instanceof Error ? err.message : String(err)}`);
				}
				const items = Array.isArray(parsedBranch) ? parsedBranch : [parsedBranch];
				params.branches = [...(params.branches ?? []), ...items];
			} else if (matchFlag(arg, '--branches-file', '--file', '-f')) {
				params.branchesFile = takeOptVal(args, ref, '--branches-file', usageError);
			} else if (arg === '--wait-join' || arg === '--join') {
				params.waitJoin = true;
			} else if (arg === '--no-wait-join' || arg === '--keep-parent') {
				params.waitJoin = false;
				params.noWaitJoin = true;
			} else if (matchFlag(arg, '--join-mode')) {
				params.joinMode = takeOptVal(args, ref, '--join-mode', usageError).toLowerCase();
			} else if (matchFlag(arg, '--artifact')) {
				const item = parseKeyValBlobFlag(takeOptVal(args, ref, '--artifact', usageError), '--artifact', usageError);
				params.artifacts = [...(params.artifacts ?? []), item];
			} else if (matchFlag(arg, '--decision')) {
				const item = parseKeyValBlobFlag(takeOptVal(args, ref, '--decision', usageError), '--decision', usageError);
				params.decisions = [...(params.decisions ?? []), item];
			} else if (matchFlag(arg, '--ref', '--refs')) {
				const rawRefs = takeOptVal(args, ref, '--ref', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.refPtrs = [...(params.refPtrs ?? []), ...rawRefs];
			} else if (matchFlag(arg, '--whiteboard', '--whiteboards', '--wb')) {
				const rawWb = takeOptVal(args, ref, '--whiteboard', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.whiteboardIds = [...(params.whiteboardIds ?? []), ...rawWb];
			} else if (matchFlag(arg, '--from', '--origin', '--node', '--from-node')) {
				params.fromNodeId = takeOptVal(args, ref, '--from', usageError);
			} else if (matchFlag(arg, '--parent', '--token', '--token-id')) {
				params.parentTokenId = takeOptVal(args, ref, '--token', usageError);
			} else if (!arg.startsWith('-') && !params.parentTokenId) {
				params.parentTokenId = arg;
			} else {
				throw usageError(`Unknown option for token ${sub}: ${arg}`);
			}
		}
		const hasBranches = Boolean(params.branchesJson || params.branchesFile || (Array.isArray(params.branches) && params.branches.length > 0) || (params.toNodeIds?.length && params.summary));
		if (!hasBranches) {
			throw usageError(`Usage: aexus-ade token ${sub} [parentTokenId] (--to <subNodeId> --summary "<headline>" [--detail "<spec>"] [--task <taskId>] | --branches-json '<json>') [--wait-join | --no-wait-join] [--join-mode all|any] [--from <staffNodeId>] [--mission <id>]`);
		}
		return { help: false, json, windowId, action: isSplit ? 'token.split' : 'token.mint', params };
	}

	if (sub === 'return' || sub === 'reply') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--to', '--target')) {
				params.toNodeId = takeOptVal(args, ref, '--to', usageError);
			} else if (matchFlag(arg, '--summary', '--message')) {
				params.summary = takeOptVal(args, ref, '--summary', usageError);
			} else if (matchFlag(arg, '--detail', '--body')) {
				params.detail = takeOptVal(args, ref, '--detail', usageError);
			} else if (matchFlag(arg, '--artifact')) {
				const item = parseKeyValBlobFlag(takeOptVal(args, ref, '--artifact', usageError), '--artifact', usageError);
				params.artifacts = [...(params.artifacts ?? []), item];
			} else if (matchFlag(arg, '--decision')) {
				const item = parseKeyValBlobFlag(takeOptVal(args, ref, '--decision', usageError), '--decision', usageError);
				params.decisions = [...(params.decisions ?? []), item];
			} else if (matchFlag(arg, '--ref', '--refs')) {
				const rawRefs = takeOptVal(args, ref, '--ref', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.refPtrs = [...(params.refPtrs ?? []), ...rawRefs];
			} else if (matchFlag(arg, '--whiteboard', '--whiteboards', '--wb')) {
				const rawWb = takeOptVal(args, ref, '--whiteboard', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.whiteboardIds = [...(params.whiteboardIds ?? []), ...rawWb];
			} else if (matchFlag(arg, '--files', '--modified-files', '--changed-files')) {
				const rawFiles = takeOptVal(args, ref, '--files', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.modifiedFiles = [...(params.modifiedFiles ?? []), ...rawFiles];
			} else if (arg === '--skip-checks') {
				params.skipChecks = true;
			} else if (matchFlag(arg, '--token', '--token-id')) {
				params.tokenId = takeOptVal(args, ref, '--token', usageError);
			} else if (!arg.startsWith('-') && !params.tokenId) {
				params.tokenId = arg;
			} else {
				throw usageError(`Unknown option for token return: ${arg}`);
			}
		}
		if (!params.tokenId || !params.summary) {
			throw usageError('Usage: aexus-ade token return <tokenId> --summary "<1-line delivery>" [--to <superiorNodeId>] [--detail "<report>"] [--artifact "Title=Body"] [--decision "Title=Body"] [--whiteboard <wbId>] [--mission <id>]');
		}
		return { help: false, json, windowId, action: 'token.return', params };
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
			} else if (matchFlag(arg, '--watch-pid', '--wake-on-pid-exit', '--pid')) {
				const raw = takeOptVal(args, ref, '--watch-pid', usageError);
				if (!/^\d+$/.test(raw)) {
					throw usageError(`Invalid PID for --watch-pid: ${raw}`);
				}
				params.watchPid = Number.parseInt(raw, 10);
			} else if (matchFlag(arg, '--watch-file', '--wake-on-file', '--file')) {
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

	if (sub === 'retry') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--node', '--node-id')) {
				params.nodeId = takeOptVal(args, ref, '--node', usageError);
			} else if (matchFlag(arg, '--guidance', '--reason', '--message', '--note')) {
				params.guidance = takeOptVal(args, ref, '--guidance', usageError);
			} else if (matchFlag(arg, '--token', '--token-id')) {
				params.tokenId = takeOptVal(args, ref, '--token', usageError);
			} else if (!arg.startsWith('-') && !params.tokenId) {
				params.tokenId = arg;
			} else {
				throw usageError(`Unknown option for token retry: ${arg}`);
			}
		}
		if (!params.tokenId && !params.nodeId) {
			throw usageError('Usage: aexus-ade token retry (<tokenId> | --node <nodeId>) [--guidance "<text>"] [--mission <id>]');
		}
		return { help: false, json, windowId, action: 'token.retry', params };
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
 * Parses Mission Runtime subcommands (`start`, `timeout`, `boundary`, `recall`, `patch`, `trigger`, `host`, `prompt`, `check`).
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

	if (sub === 'retry') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--node', '--node-id')) {
				params.nodeId = takeOptVal(args, ref, '--node', usageError);
			} else if (matchFlag(arg, '--token', '--token-id')) {
				params.tokenId = takeOptVal(args, ref, '--token', usageError);
			} else if (matchFlag(arg, '--guidance', '--reason', '--message', '--note')) {
				params.guidance = takeOptVal(args, ref, '--guidance', usageError);
			} else if (!arg.startsWith('-') && !params.nodeId && !params.tokenId) {
				if (arg.startsWith('tok-')) {
					params.tokenId = arg;
				} else {
					params.nodeId = arg;
				}
			} else {
				throw usageError(`Unknown option for mission retry: ${arg}`);
			}
		}
		if (!params.tokenId && !params.nodeId) {
			throw usageError('Usage: aexus-ade mission retry [--mission <id>] (--node <nodeId> | --token <tokenId>) [--guidance "<text>"]');
		}
		return { help: false, json, windowId, action: 'mission.retry', params };
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

	if (sub === 'prompt' || sub === 'prompts' || sub === 'preprompt') {
		const pSub = args[0]?.trim() || 'list';
		const pArgs = args.slice(1);
		if (pSub === 'list') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < pArgs.length; ref.i++) {
				const arg = pArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(pArgs, ref, '--mission', usageError);
				} else if (!arg.startsWith('-') && !params.missionId) {
					params.missionId = arg;
				} else {
					throw usageError(`Unknown option for mission prompt list: ${arg}`);
				}
			}
			return { help: false, json, windowId, action: 'mission.prompt.list', params };
		}
		if (pSub === 'get') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < pArgs.length; ref.i++) {
				const arg = pArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(pArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id')) {
					params.nodeId = takeOptVal(pArgs, ref, '--node', usageError);
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else {
					throw usageError(`Unknown option for mission prompt get: ${arg}`);
				}
			}
			if (!params.nodeId) {
				throw usageError('Usage: aexus-ade mission prompt get [--mission <id>] --node <nodeId>');
			}
			return { help: false, json, windowId, action: 'mission.prompt.get', params };
		}
		if (pSub === 'set' || pSub === 'clear') {
			const params = pSub === 'clear' ? { clear: true } : {};
			for (const ref = { i: 0 }; ref.i < pArgs.length; ref.i++) {
				const arg = pArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(pArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id')) {
					params.nodeId = takeOptVal(pArgs, ref, '--node', usageError);
				} else if (matchFlag(arg, '--prompt', '--text', '--pre-prompt')) {
					params.prompt = takeOptVal(pArgs, ref, '--prompt', usageError);
				} else if (matchFlag(arg, '--file')) {
					params.file = takeOptVal(pArgs, ref, '--file', usageError);
				} else if (arg === '--clear') {
					params.clear = true;
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else if (!arg.startsWith('-') && params.prompt === undefined) {
					params.prompt = arg;
				} else {
					throw usageError(`Unknown option for mission prompt set: ${arg}`);
				}
			}
			if (!params.nodeId || (!params.clear && params.prompt === undefined && !params.file)) {
				throw usageError('Usage: aexus-ade mission prompt set [--mission <id>] --node <nodeId> (--prompt "<text>" | --file <path> | --clear)');
			}
			return { help: false, json, windowId, action: 'mission.prompt.set', params };
		}
		throw usageError(`Unknown mission prompt subcommand: ${pSub}`);
	}

	if (sub === 'check' || sub === 'checks' || sub === 'verify') {
		const cSub = args[0]?.trim() || 'list';
		const cArgs = args.slice(1);
		if (cSub === 'list') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < cArgs.length; ref.i++) {
				const arg = cArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(cArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id')) {
					params.nodeId = takeOptVal(cArgs, ref, '--node', usageError);
				} else if (!arg.startsWith('-') && !params.missionId) {
					params.missionId = arg;
				} else {
					throw usageError(`Unknown option for mission check list: ${arg}`);
				}
			}
			return { help: false, json, windowId, action: 'mission.check.list', params };
		}
		if (cSub === 'get') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < cArgs.length; ref.i++) {
				const arg = cArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(cArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id')) {
					params.nodeId = takeOptVal(cArgs, ref, '--node', usageError);
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else {
					throw usageError(`Unknown option for mission check get: ${arg}`);
				}
			}
			if (!params.nodeId) {
				throw usageError('Usage: aexus-ade mission check get [--mission <id>] --node <nodeId>');
			}
			return { help: false, json, windowId, action: 'mission.check.get', params };
		}
		if (cSub === 'set' || cSub === 'add') {
			const params = {};
			const expectFiles = [];
			for (const ref = { i: 0 }; ref.i < cArgs.length; ref.i++) {
				const arg = cArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(cArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id')) {
					params.nodeId = takeOptVal(cArgs, ref, '--node', usageError);
				} else if (matchFlag(arg, '--id', '--check-id', '--check')) {
					params.checkId = takeOptVal(cArgs, ref, '--id', usageError);
				} else if (matchFlag(arg, '--name', '--label')) {
					params.name = takeOptVal(cArgs, ref, '--name', usageError);
				} else if (matchFlag(arg, '--cmd', '--command')) {
					params.command = takeOptVal(cArgs, ref, '--cmd', usageError);
				} else if (matchFlag(arg, '--cwd', '--dir')) {
					params.cwd = takeOptVal(cArgs, ref, '--cwd', usageError);
				} else if (matchFlag(arg, '--host', '--host-alias')) {
					params.hostAlias = takeOptVal(cArgs, ref, '--host', usageError);
				} else if (matchFlag(arg, '--expect-file', '--expect-files', '--file')) {
					for (const fp of takeOptVal(cArgs, ref, '--expect-file', usageError).split(',').map(s => s.trim()).filter(Boolean)) {
						expectFiles.push(fp);
					}
				} else if (matchFlag(arg, '--match', '--expect-output', '--expect-match')) {
					params.expectOutputMatch = takeOptVal(cArgs, ref, '--match', usageError);
				} else if (matchFlag(arg, '--expect-exit', '--exit-code')) {
					const val = Number(takeOptVal(cArgs, ref, '--expect-exit', usageError));
					if (!Number.isInteger(val) || val < 0) {
						throw usageError('Option --expect-exit requires a non-negative integer.');
					}
					params.expectExitCode = val;
				} else if (matchFlag(arg, '--timeout', '--timeout-ms')) {
					params.timeout = takeOptVal(cArgs, ref, '--timeout', usageError);
				} else if (matchFlag(arg, '--on-fail', '--onfail')) {
					const mode = takeOptVal(cArgs, ref, '--on-fail', usageError).trim().toLowerCase();
					if (mode !== 'bounce' && mode !== 'fail' && mode !== 'escalate') {
						throw usageError('Option --on-fail must be bounce, fail, or escalate.');
					}
					params.onFail = mode;
				} else if (matchFlag(arg, '--max-retries', '--retries')) {
					const val = Number(takeOptVal(cArgs, ref, '--max-retries', usageError));
					if (!Number.isInteger(val) || val < 0) {
						throw usageError('Option --max-retries requires a non-negative integer.');
					}
					params.maxAutoRetries = val;
				} else if (arg === '--disabled') {
					params.disabled = true;
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else {
					throw usageError(`Unknown option for mission check set: ${arg}`);
				}
			}
			if (expectFiles.length > 0) {
				params.expectFiles = expectFiles;
			}
			if (!params.nodeId || (!params.command && expectFiles.length === 0)) {
				throw usageError('Usage: aexus-ade mission check set [--mission <id>] --node <nodeId> (--cmd "<shell>" | --expect-file <path>) [--on-fail bounce|fail|escalate] [--max-retries <n>] [--timeout <duration>]');
			}
			return { help: false, json, windowId, action: 'mission.check.set', params };
		}
		if (cSub === 'remove' || cSub === 'rm' || cSub === 'delete' || cSub === 'clear') {
			const params = cSub === 'clear' ? { all: true } : {};
			for (const ref = { i: 0 }; ref.i < cArgs.length; ref.i++) {
				const arg = cArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(cArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id')) {
					params.nodeId = takeOptVal(cArgs, ref, '--node', usageError);
				} else if (matchFlag(arg, '--id', '--check-id', '--check')) {
					params.checkId = takeOptVal(cArgs, ref, '--id', usageError);
				} else if (arg === '--all') {
					params.all = true;
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else if (!arg.startsWith('-') && !params.checkId) {
					params.checkId = arg;
				} else {
					throw usageError(`Unknown option for mission check remove: ${arg}`);
				}
			}
			if (!params.nodeId) {
				throw usageError('Usage: aexus-ade mission check remove [--mission <id>] --node <nodeId> [--id <checkId> | --all]');
			}
			return { help: false, json, windowId, action: 'mission.check.remove', params };
		}
		if (cSub === 'run' || cSub === 'test') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < cArgs.length; ref.i++) {
				const arg = cArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(cArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id')) {
					params.nodeId = takeOptVal(cArgs, ref, '--node', usageError);
				} else if (matchFlag(arg, '--id', '--check-id', '--check')) {
					params.checkId = takeOptVal(cArgs, ref, '--id', usageError);
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else {
					throw usageError(`Unknown option for mission check run: ${arg}`);
				}
			}
			if (!params.nodeId) {
				throw usageError('Usage: aexus-ade mission check run [--mission <id>] --node <nodeId> [--id <checkId>]');
			}
			return { help: false, json, windowId, action: 'mission.check.run', params };
		}
		throw usageError(`Unknown mission check subcommand: ${cSub}`);
	}

	if (sub === 'task' || sub === 'tasks') {
		const tSub = args[0]?.trim() || 'list';
		const tArgs = args.slice(1);
		if (tSub === 'list') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < tArgs.length; ref.i++) {
				const arg = tArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(tArgs, ref, '--mission', usageError);
				} else if (!arg.startsWith('-') && !params.missionId) {
					params.missionId = arg;
				} else {
					throw usageError(`Unknown option for mission task list: ${arg}`);
				}
			}
			return { help: false, json, windowId, action: 'mission.task.list', params };
		}
		if (tSub === 'get') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < tArgs.length; ref.i++) {
				const arg = tArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(tArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id', '--task')) {
					params.nodeId = takeOptVal(tArgs, ref, '--node', usageError);
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else {
					throw usageError(`Unknown option for mission task get: ${arg}`);
				}
			}
			if (!params.nodeId) {
				throw usageError('Usage: aexus-ade mission task get [--mission <id>] --node <taskId>');
			}
			return { help: false, json, windowId, action: 'mission.task.get', params };
		}
		if (tSub === 'create' || tSub === 'add') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < tArgs.length; ref.i++) {
				const arg = tArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(tArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--id', '--node', '--node-id')) {
					params.id = takeOptVal(tArgs, ref, '--id', usageError);
				} else if (matchFlag(arg, '--title', '--label', '--name')) {
					params.title = takeOptVal(tArgs, ref, '--title', usageError);
				} else if (matchFlag(arg, '--description', '--desc', '--prompt')) {
					params.description = takeOptVal(tArgs, ref, '--description', usageError);
				} else if (matchFlag(arg, '--kind')) {
					params.kind = takeOptVal(tArgs, ref, '--kind', usageError).toLowerCase();
				} else if (matchFlag(arg, '--owner', '--owner-node')) {
					params.ownerNodeId = takeOptVal(tArgs, ref, '--owner', usageError);
				} else if (matchFlag(arg, '--assignee', '--assignee-node')) {
					params.assigneeNodeId = takeOptVal(tArgs, ref, '--assignee', usageError);
				} else if (matchFlag(arg, '--department', '--dept')) {
					params.department = takeOptVal(tArgs, ref, '--department', usageError);
				} else if (matchFlag(arg, '--min-tier', '--completer-tier')) {
					params.minCompleterTier = Number(takeOptVal(tArgs, ref, '--min-tier', usageError).replace(/^L/i, ''));
				} else if (matchFlag(arg, '--completers', '--allowed-completers')) {
					params.allowedCompleterNodeIds = takeOptVal(tArgs, ref, '--completers', usageError).split(/[|,;]/).map(s => s.trim()).filter(Boolean);
				} else if (matchFlag(arg, '--after', '--depends-on', '--upstream')) {
					params.after = [...(params.after ?? []), ...takeOptVal(tArgs, ref, '--after', usageError).split(',').map(s => s.trim()).filter(Boolean)];
				} else if (matchFlag(arg, '--before', '--downstream')) {
					params.before = [...(params.before ?? []), ...takeOptVal(tArgs, ref, '--before', usageError).split(',').map(s => s.trim()).filter(Boolean)];
				} else if (!arg.startsWith('-') && !params.title) {
					params.title = arg;
				} else {
					throw usageError(`Unknown option for mission task create: ${arg}`);
				}
			}
			if (!params.title && !params.id) {
				throw usageError('Usage: aexus-ade mission task create [--mission <id>] [--id <T1>] --title "<Title>" [--description "<desc>"] [--after <T0,...>] [--before <T2,...>] [--owner <staffId>] [--assignee <staffId>] [--department <Dept>] [--min-tier <n>] [--completers <id1,id2>]');
			}
			return { help: false, json, windowId, action: 'mission.task.create', params };
		}
		if (tSub === 'update' || tSub === 'edit') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < tArgs.length; ref.i++) {
				const arg = tArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(tArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id', '--task', '--id')) {
					params.nodeId = takeOptVal(tArgs, ref, '--node', usageError);
				} else if (matchFlag(arg, '--title', '--label', '--name')) {
					params.title = takeOptVal(tArgs, ref, '--title', usageError);
				} else if (matchFlag(arg, '--description', '--desc', '--prompt', '--text')) {
					params.description = takeOptVal(tArgs, ref, '--description', usageError);
				} else if (matchFlag(arg, '--owner', '--owner-node')) {
					params.ownerNodeId = takeOptVal(tArgs, ref, '--owner', usageError);
				} else if (matchFlag(arg, '--assignee', '--assignee-node')) {
					params.assigneeNodeId = takeOptVal(tArgs, ref, '--assignee', usageError);
				} else if (matchFlag(arg, '--department', '--dept')) {
					params.department = takeOptVal(tArgs, ref, '--department', usageError);
				} else if (matchFlag(arg, '--min-tier', '--completer-tier')) {
					const raw = takeOptVal(tArgs, ref, '--min-tier', usageError);
					params.minCompleterTier = raw === '' || raw === 'none' ? null : Number(raw.replace(/^L/i, ''));
				} else if (matchFlag(arg, '--completers', '--allowed-completers')) {
					const raw = takeOptVal(tArgs, ref, '--completers', usageError);
					params.allowedCompleterNodeIds = raw === '' || raw === 'none' ? null : raw.split(/[|,;]/).map(s => s.trim()).filter(Boolean);
				} else if (matchFlag(arg, '--color', '--accent')) {
					const raw = takeOptVal(tArgs, ref, '--color', usageError);
					params.color = raw === '' || raw === 'default' || raw === 'none' ? null : raw;
				} else if (matchFlag(arg, '--file')) {
					params.file = takeOptVal(tArgs, ref, '--file', usageError);
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else {
					throw usageError(`Unknown option for mission task ${tSub}: ${arg}`);
				}
			}
			if (!params.nodeId) {
				throw usageError('Usage: aexus-ade mission task update [--mission <id>] --node <taskId> [--title "<Title>"] [--description "<desc>"] [--owner <staffId>] [--assignee <staffId>] [--department <Dept>] [--min-tier <n>] [--completers <id1,id2>]');
			}
			return { help: false, json, windowId, action: 'mission.task.update', params };
		}
		if (tSub === 'remove' || tSub === 'rm' || tSub === 'delete') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < tArgs.length; ref.i++) {
				const arg = tArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(tArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id', '--task', '--id')) {
					params.nodeId = takeOptVal(tArgs, ref, '--node', usageError);
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else {
					throw usageError(`Unknown option for mission task remove: ${arg}`);
				}
			}
			if (!params.nodeId) {
				throw usageError('Usage: aexus-ade mission task remove [--mission <id>] --node <taskId>');
			}
			return { help: false, json, windowId, action: 'mission.task.remove', params };
		}
		if (tSub === 'edge' || tSub === 'edges') {
			const eSub = tArgs[0]?.trim();
			const eArgs = tArgs.slice(1);
			if (eSub === 'add' || eSub === 'connect') {
				const params = {};
				for (const ref = { i: 0 }; ref.i < eArgs.length; ref.i++) {
					const arg = eArgs[ref.i];
					if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
						params.missionId = takeOptVal(eArgs, ref, '--mission', usageError);
					} else if (matchFlag(arg, '--from')) {
						params.from = takeOptVal(eArgs, ref, '--from', usageError);
					} else if (matchFlag(arg, '--to')) {
						params.to = takeOptVal(eArgs, ref, '--to', usageError);
					} else if (matchFlag(arg, '--label')) {
						params.label = takeOptVal(eArgs, ref, '--label', usageError);
					} else if (matchFlag(arg, '--kind')) {
						params.kind = takeOptVal(eArgs, ref, '--kind', usageError).toLowerCase();
					} else if (!arg.startsWith('-') && !params.from) {
						params.from = arg;
					} else if (!arg.startsWith('-') && !params.to) {
						params.to = arg;
					} else {
						throw usageError(`Unknown option for mission task edge add: ${arg}`);
					}
				}
				if (!params.from || !params.to) {
					throw usageError('Usage: aexus-ade mission task edge add [--mission <id>] <fromTaskId> <toTaskId> [--label "<text>"] [--kind success|fail]');
				}
				return { help: false, json, windowId, action: 'mission.task.edge.add', params };
			}
			if (eSub === 'remove' || eSub === 'rm' || eSub === 'delete') {
				const params = {};
				for (const ref = { i: 0 }; ref.i < eArgs.length; ref.i++) {
					const arg = eArgs[ref.i];
					if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
						params.missionId = takeOptVal(eArgs, ref, '--mission', usageError);
					} else if (matchFlag(arg, '--from')) {
						params.from = takeOptVal(eArgs, ref, '--from', usageError);
					} else if (matchFlag(arg, '--to')) {
						params.to = takeOptVal(eArgs, ref, '--to', usageError);
					} else if (!arg.startsWith('-') && !params.from) {
						params.from = arg;
					} else if (!arg.startsWith('-') && !params.to) {
						params.to = arg;
					} else {
						throw usageError(`Unknown option for mission task edge remove: ${arg}`);
					}
				}
				if (!params.from || !params.to) {
					throw usageError('Usage: aexus-ade mission task edge remove [--mission <id>] <fromTaskId> <toTaskId>');
				}
				return { help: false, json, windowId, action: 'mission.task.edge.remove', params };
			}
			throw usageError('Usage: aexus-ade mission task edge <add | remove> [--mission <id>] <fromTaskId> <toTaskId>');
		}
		if (tSub === 'set') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < tArgs.length; ref.i++) {
				const arg = tArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(tArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id', '--task')) {
					params.nodeId = takeOptVal(tArgs, ref, '--node', usageError);
				} else if (matchFlag(arg, '--description', '--desc', '--prompt', '--text')) {
					params.description = takeOptVal(tArgs, ref, '--description', usageError);
				} else if (matchFlag(arg, '--file')) {
					params.file = takeOptVal(tArgs, ref, '--file', usageError);
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else if (!arg.startsWith('-') && params.description === undefined) {
					params.description = arg;
				} else {
					throw usageError(`Unknown option for mission task set: ${arg}`);
				}
			}
			if (!params.nodeId || (params.description === undefined && !params.file)) {
				throw usageError('Usage: aexus-ade mission task set [--mission <id>] --node <taskId> (--description "<text>" | --file <path>)');
			}
			return { help: false, json, windowId, action: 'mission.task.set', params };
		}
		if (tSub === 'complete' || tSub === 'done' || tSub === 'status') {
			const params = tSub === 'status' ? {} : { status: 'completed' };
			for (const ref = { i: 0 }; ref.i < tArgs.length; ref.i++) {
				const arg = tArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(tArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id', '--task')) {
					params.nodeId = takeOptVal(tArgs, ref, '--node', usageError);
				} else if (matchFlag(arg, '--status', '--state')) {
					params.status = takeOptVal(tArgs, ref, '--status', usageError).trim().toLowerCase();
				} else if (matchFlag(arg, '--note', '--summary', '--reason')) {
					params.note = takeOptVal(tArgs, ref, '--note', usageError);
				} else if (arg === '--force') {
					params.force = true;
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else if (tSub === 'status' && !arg.startsWith('-') && !params.status) {
					params.status = arg.trim().toLowerCase();
				} else {
					throw usageError(`Unknown option for mission task ${tSub}: ${arg}`);
				}
			}
			if (!params.nodeId || !params.status) {
				throw usageError(`Usage: aexus-ade mission task ${tSub} [--mission <id>] --node <taskId>${tSub === 'status' ? ' --status <pending|in_progress|completed|blocked>' : ''} [--note "<text>"] [--force]`);
			}
			return { help: false, json, windowId, action: tSub === 'status' ? 'mission.task.status' : 'mission.task.complete', params };
		}
		throw usageError(`Unknown mission task subcommand: ${tSub}`);
	}

	if (sub === 'export') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--file', '--out', '-o')) {
				params.outputFile = takeOptVal(args, ref, '--file', usageError);
			} else if (matchFlag(arg, '--format')) {
				params.format = takeOptVal(args, ref, '--format', usageError).toLowerCase();
			} else if (arg === '--with-positions' || arg === '--positions') {
				params.withPositions = true;
			} else if (arg === '--include-agent-ids') {
				params.includeAgentIds = true;
			} else if (!arg.startsWith('-') && !params.missionId) {
				params.missionId = arg;
			} else {
				throw usageError(`Unknown option for mission export: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: 'mission.export', params };
	}

	if (sub === 'import') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--owner', '--mission', '--mission-id', '--governor')) {
				params.owner = takeOptVal(args, ref, '--owner', usageError);
			} else if (matchFlag(arg, '--project')) {
				params.project = takeOptVal(args, ref, '--project', usageError);
			} else if (matchFlag(arg, '--title')) {
				params.title = takeOptVal(args, ref, '--title', usageError);
			} else if (matchFlag(arg, '--file', '-f')) {
				params.file = takeOptVal(args, ref, '--file', usageError);
			} else if (matchFlag(arg, '--text', '--json-text')) {
				params.text = takeOptVal(args, ref, '--text', usageError);
			} else if (arg === '--open') {
				params.open = true;
			} else if (arg === '--side') {
				params.side = true;
			} else {
				throw usageError(`Unknown option for mission import: ${arg}`);
			}
		}
		if (!params.file && params.text === undefined) {
			throw usageError('Usage: aexus-ade mission import [--owner <id>] [--project <path>] [--title "<t>"] (--file <path> | --text "<bundleJson>") [--open] [--side]');
		}
		return { help: false, json, windowId, action: 'mission.import', params };
	}

	return undefined;
}

export function parseOrchestrationGroupCommand(tail, json, windowId, usageError) {
	const sub = tail[0]?.trim() || 'status';
	const args = tail.slice(1);

	if (sub === 'get' || sub === 'show') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (arg === '--raw') {
				params.raw = true;
			} else if (!arg.startsWith('-') && !params.missionId) {
				params.missionId = arg;
			} else {
				throw usageError(`Unknown option for orchestration get: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: 'orchestration.get', params };
	}

	if (sub === 'apply' || sub === 'set') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--file', '-f')) {
				params.file = takeOptVal(args, ref, '--file', usageError);
			} else if (matchFlag(arg, '--text', '--mermaid')) {
				params.text = takeOptVal(args, ref, '--text', usageError);
			} else {
				throw usageError(`Unknown option for orchestration apply: ${arg}`);
			}
		}
		if (!params.file && params.text === undefined) {
			throw usageError('Usage: aexus-ade orchestration apply [--mission <id>] (--file <path> | --text "<mermaid>")');
		}
		return { help: false, json, windowId, action: 'orchestration.apply', params };
	}

	if (sub === 'validate' || sub === 'check') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--file', '-f')) {
				params.file = takeOptVal(args, ref, '--file', usageError);
			} else if (matchFlag(arg, '--text', '--mermaid')) {
				params.text = takeOptVal(args, ref, '--text', usageError);
			} else if (matchFlag(arg, '--format')) {
				params.format = takeOptVal(args, ref, '--format', usageError).toLowerCase();
			} else if (!arg.startsWith('-') && !params.file) {
				params.file = arg;
			} else {
				throw usageError(`Unknown option for orchestration validate: ${arg}`);
			}
		}
		if (!params.file && params.text === undefined) {
			throw usageError('Usage: aexus-ade orchestration validate (--file <path.json|path.mjs|path.mmd> | --text "<mermaid>")');
		}
		return { help: false, json, windowId, action: 'orchestration.validate', params };
	}

	if (sub === 'load') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--file', '-f')) {
				params.file = takeOptVal(args, ref, '--file', usageError);
			} else if (!arg.startsWith('-') && !params.file) {
				params.file = arg;
			} else {
				throw usageError(`Unknown option for orchestration load: ${arg}`);
			}
		}
		if (!params.file) {
			throw usageError('Usage: aexus-ade orchestration load [--mission <id>] --file <path.json|path.mjs|path.mmd>');
		}
		return { help: false, json, windowId, action: 'orchestration.load', params };
	}

	if (sub === 'pause' || sub === 'resume' || sub === 'abort') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--reason', '--message')) {
				params.reason = takeOptVal(args, ref, '--reason', usageError);
			} else if (!arg.startsWith('-') && !params.missionId) {
				params.missionId = arg;
			} else {
				throw usageError(`Unknown option for orchestration ${sub}: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: `orchestration.${sub}`, params };
	}

	if (sub === 'status') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (!arg.startsWith('-') && !params.missionId) {
				params.missionId = arg;
			} else {
				throw usageError(`Unknown option for orchestration status: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: 'orchestration.status', params };
	}

	if (sub === 'dispatch' || sub === 'send' || sub === 'start') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--prompt', '--message', '--text')) {
				params.prompt = takeOptVal(args, ref, '--prompt', usageError);
			} else if (matchFlag(arg, '--detail', '--body')) {
				params.detail = takeOptVal(args, ref, '--detail', usageError);
			} else if (matchFlag(arg, '--artifact')) {
				const item = parseKeyValBlobFlag(takeOptVal(args, ref, '--artifact', usageError), '--artifact', usageError);
				params.artifacts = [...(params.artifacts ?? []), item];
			} else if (matchFlag(arg, '--decision')) {
				const item = parseKeyValBlobFlag(takeOptVal(args, ref, '--decision', usageError), '--decision', usageError);
				params.decisions = [...(params.decisions ?? []), item];
			} else if (matchFlag(arg, '--to', '--node', '--target')) {
				params.targetNodeId = takeOptVal(args, ref, '--to', usageError);
			} else if (matchFlag(arg, '--task', '--task-id', '--task-node')) {
				params.taskNodeId = takeOptVal(args, ref, '--task', usageError);
			} else if (matchFlag(arg, '--tasks', '--task-ids')) {
				const rawT = takeOptVal(args, ref, '--tasks', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.taskNodeIds = [...(params.taskNodeIds ?? []), ...rawT];
			} else if (matchFlag(arg, '--whiteboard', '--whiteboards', '--wb')) {
				const rawWb = takeOptVal(args, ref, '--whiteboard', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.whiteboardIds = [...(params.whiteboardIds ?? []), ...rawWb];
			} else if (!arg.startsWith('-') && !params.prompt) {
				params.prompt = arg;
			} else {
				throw usageError(`Unknown option for orchestration dispatch: ${arg}`);
			}
		}
		if (!params.prompt) {
			throw usageError('Usage: aexus-ade orchestration dispatch [--mission <id>] --prompt "<requirement>" [--to <staffNodeId>] [--whiteboard <wbId>]');
		}
		return { help: false, json, windowId, action: 'orchestration.dispatch', params };
	}

	if (sub === 'export') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--file', '--out', '-o')) {
				params.outputFile = takeOptVal(args, ref, '--file', usageError);
			} else if (matchFlag(arg, '--format')) {
				params.format = takeOptVal(args, ref, '--format', usageError).toLowerCase();
			} else if (arg === '--with-positions' || arg === '--positions') {
				params.withPositions = true;
			} else if (arg === '--include-agent-ids') {
				params.includeAgentIds = true;
			} else if (arg === '--raw') {
				params.raw = true;
			} else if (!arg.startsWith('-') && !params.missionId) {
				params.missionId = arg;
			} else {
				throw usageError(`Unknown option for orchestration export: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: 'orchestration.export', params };
	}

	if (sub === 'import') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--file', '-f')) {
				params.file = takeOptVal(args, ref, '--file', usageError);
			} else if (matchFlag(arg, '--text', '--mermaid')) {
				params.text = takeOptVal(args, ref, '--text', usageError);
			} else {
				throw usageError(`Unknown option for orchestration import: ${arg}`);
			}
		}
		if (!params.file && params.text === undefined) {
			throw usageError('Usage: aexus-ade orchestration import [--mission <id>] (--file <path> | --text "<mermaid>")');
		}
		return { help: false, json, windowId, action: 'orchestration.import', params };
	}

	if (sub === 'layout') {
		const lSub = args[0]?.trim();
		const lArgs = (lSub === 'set' || lSub === 'mode') ? args.slice(1) : args;
		const params = {};
		for (const ref = { i: 0 }; ref.i < lArgs.length; ref.i++) {
			const arg = lArgs[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(lArgs, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--mode', '--layout')) {
				params.layoutMode = takeOptVal(lArgs, ref, '--mode', usageError).toLowerCase();
			} else if (arg === '--keep-positions') {
				params.keepPositions = true;
			} else if (arg === '--persist-in-code') {
				params.persistInCode = true;
			} else if (!arg.startsWith('-') && !params.layoutMode) {
				params.layoutMode = arg.toLowerCase();
			} else {
				throw usageError(`Unknown option for orchestration layout: ${arg}`);
			}
		}
		if (!params.layoutMode || !['lr', 'td', 'radial', 'grid'].includes(params.layoutMode)) {
			throw usageError('Usage: aexus-ade orchestration layout set <lr|td|radial|grid> [--mission <id>] [--persist-in-code]');
		}
		return { help: false, json, windowId, action: 'orchestration.layout.set', params };
	}

	if (sub === 'group' || sub === 'groups' || sub === 'dept' || sub === 'department') {
		const gSub = args[0]?.trim() || 'list';
		const gArgs = args.slice(1);
		if (gSub === 'list') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < gArgs.length; ref.i++) {
				const arg = gArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(gArgs, ref, '--mission', usageError);
				} else if (!arg.startsWith('-') && !params.missionId) {
					params.missionId = arg;
				} else {
					throw usageError(`Unknown option for orchestration group list: ${arg}`);
				}
			}
			return { help: false, json, windowId, action: 'orchestration.group.list', params };
		}
		if (gSub === 'create' || gSub === 'add') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < gArgs.length; ref.i++) {
				const arg = gArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(gArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--name', '--title')) {
					params.name = takeOptVal(gArgs, ref, '--name', usageError);
				} else if (matchFlag(arg, '--id', '--group-id')) {
					params.groupId = takeOptVal(gArgs, ref, '--id', usageError);
				} else if (!arg.startsWith('-') && !params.name) {
					params.name = arg;
				} else {
					throw usageError(`Unknown option for orchestration group create: ${arg}`);
				}
			}
			if (!params.name) {
				throw usageError('Usage: aexus-ade orchestration group create [--mission <id>] --name "<Group Name>" [--id <GroupId>]');
			}
			return { help: false, json, windowId, action: 'orchestration.group.create', params };
		}
		if (gSub === 'rename') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < gArgs.length; ref.i++) {
				const arg = gArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(gArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--group', '--id', '--from')) {
					params.group = takeOptVal(gArgs, ref, '--group', usageError);
				} else if (matchFlag(arg, '--name', '--new-name', '--to', '--title')) {
					params.name = takeOptVal(gArgs, ref, '--name', usageError);
				} else if (!arg.startsWith('-') && !params.group) {
					params.group = arg;
				} else if (!arg.startsWith('-') && !params.name) {
					params.name = arg;
				} else {
					throw usageError(`Unknown option for orchestration group rename: ${arg}`);
				}
			}
			if (!params.group || !params.name) {
				throw usageError('Usage: aexus-ade orchestration group rename [--mission <id>] <groupIdOrName> "<New Name>"');
			}
			return { help: false, json, windowId, action: 'orchestration.group.rename', params };
		}
		if (gSub === 'assign' || gSub === 'move') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < gArgs.length; ref.i++) {
				const arg = gArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(gArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id')) {
					params.nodeId = takeOptVal(gArgs, ref, '--node', usageError);
				} else if (matchFlag(arg, '--group', '--group-id', '--department', '--dept')) {
					params.group = takeOptVal(gArgs, ref, '--group', usageError);
				} else if (arg === '--ungroup' || arg === '--none') {
					params.ungroup = true;
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else if (!arg.startsWith('-') && !params.group) {
					params.group = arg;
				} else {
					throw usageError(`Unknown option for orchestration group assign: ${arg}`);
				}
			}
			if (!params.nodeId || (!params.group && !params.ungroup)) {
				throw usageError('Usage: aexus-ade orchestration group assign [--mission <id>] --node <nodeId> (--group "<Group>" | --ungroup)');
			}
			return { help: false, json, windowId, action: 'orchestration.group.assign', params };
		}
		if (gSub === 'remove' || gSub === 'rm' || gSub === 'delete' || gSub === 'ungroup') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < gArgs.length; ref.i++) {
				const arg = gArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(gArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--group', '--id', '--name')) {
					params.group = takeOptVal(gArgs, ref, '--group', usageError);
				} else if (arg === '--delete-members' || arg === '--cascade') {
					params.deleteMembers = true;
				} else if (!arg.startsWith('-') && !params.group) {
					params.group = arg;
				} else {
					throw usageError(`Unknown option for orchestration group ${gSub}: ${arg}`);
				}
			}
			if (!params.group) {
				throw usageError('Usage: aexus-ade orchestration group remove [--mission <id>] <groupIdOrName> [--delete-members]');
			}
			return { help: false, json, windowId, action: 'orchestration.group.remove', params };
		}
		throw usageError(`Unknown orchestration group subcommand: ${gSub}`);
	}

	if (sub === 'edge' || sub === 'edges' || sub === 'link') {
		const eSub = args[0]?.trim();
		const eArgs = args.slice(1);
		if (eSub === 'connect' || eSub === 'add') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < eArgs.length; ref.i++) {
				const arg = eArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(eArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--from')) {
					params.from = takeOptVal(eArgs, ref, '--from', usageError);
				} else if (matchFlag(arg, '--to')) {
					params.to = takeOptVal(eArgs, ref, '--to', usageError);
				} else if (matchFlag(arg, '--label')) {
					params.label = takeOptVal(eArgs, ref, '--label', usageError);
				} else if (arg === '--one-way' || arg === '--directed') {
					params.bidirectional = false;
				} else if (arg === '--bidirectional' || arg === '--bidir') {
					params.bidirectional = true;
				} else if (arg === '--dashed') {
					params.dashed = true;
				} else if (!arg.startsWith('-') && !params.from) {
					params.from = arg;
				} else if (!arg.startsWith('-') && !params.to) {
					params.to = arg;
				} else {
					throw usageError(`Unknown option for orchestration edge connect: ${arg}`);
				}
			}
			if (!params.from || !params.to) {
				throw usageError('Usage: aexus-ade orchestration edge connect [--mission <id>] <fromId> <toId> [--label "<text>"] [--one-way | --bidirectional] [--dashed]');
			}
			return { help: false, json, windowId, action: 'orchestration.edge.connect', params };
		}
		if (eSub === 'label' || eSub === 'rename') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < eArgs.length; ref.i++) {
				const arg = eArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(eArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--from')) {
					params.from = takeOptVal(eArgs, ref, '--from', usageError);
				} else if (matchFlag(arg, '--to')) {
					params.to = takeOptVal(eArgs, ref, '--to', usageError);
				} else if (matchFlag(arg, '--label', '--text')) {
					params.label = takeOptVal(eArgs, ref, '--label', usageError);
				} else if (!arg.startsWith('-') && !params.from) {
					params.from = arg;
				} else if (!arg.startsWith('-') && !params.to) {
					params.to = arg;
				} else if (!arg.startsWith('-') && params.label === undefined) {
					params.label = arg;
				} else {
					throw usageError(`Unknown option for orchestration edge label: ${arg}`);
				}
			}
			if (!params.from || !params.to || params.label === undefined) {
				throw usageError('Usage: aexus-ade orchestration edge label [--mission <id>] <fromId> <toId> "<label>"');
			}
			return { help: false, json, windowId, action: 'orchestration.edge.label', params };
		}
		if (eSub === 'remove' || eSub === 'rm' || eSub === 'delete') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < eArgs.length; ref.i++) {
				const arg = eArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(eArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--from')) {
					params.from = takeOptVal(eArgs, ref, '--from', usageError);
				} else if (matchFlag(arg, '--to')) {
					params.to = takeOptVal(eArgs, ref, '--to', usageError);
				} else if (arg === '--both') {
					params.both = true;
				} else if (!arg.startsWith('-') && !params.from) {
					params.from = arg;
				} else if (!arg.startsWith('-') && !params.to) {
					params.to = arg;
				} else {
					throw usageError(`Unknown option for orchestration edge remove: ${arg}`);
				}
			}
			if (!params.from || !params.to) {
				throw usageError('Usage: aexus-ade orchestration edge remove [--mission <id>] <fromId> <toId> [--both]');
			}
			return { help: false, json, windowId, action: 'orchestration.edge.remove', params };
		}
		throw usageError('Usage: aexus-ade orchestration edge <connect | label | remove> ...');
	}

	if (sub === 'staff' || sub === 'employee' || sub === 'recruit') {
		const sSub = sub === 'recruit' ? 'create' : (args[0]?.trim() || 'create');
		const sArgs = sub === 'recruit' ? args : args.slice(1);
		if (sSub === 'rename') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < sArgs.length; ref.i++) {
				const arg = sArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(sArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id', '--id')) {
					params.nodeId = takeOptVal(sArgs, ref, '--node', usageError);
				} else if (matchFlag(arg, '--name', '--label', '--title')) {
					params.label = takeOptVal(sArgs, ref, '--name', usageError);
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else if (!arg.startsWith('-') && !params.label) {
					params.label = arg;
				} else {
					throw usageError(`Unknown option for orchestration staff rename: ${arg}`);
				}
			}
			if (!params.nodeId || !params.label) {
				throw usageError('Usage: aexus-ade orchestration staff rename [--mission <id>] <nodeId> "<New Name>"');
			}
			return { help: false, json, windowId, action: 'orchestration.staff.rename', params };
		}
		if (sSub === 'config' || sSub === 'configure' || sSub === 'set') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < sArgs.length; ref.i++) {
				const arg = sArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(sArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id', '--id')) {
					params.nodeId = takeOptVal(sArgs, ref, '--node', usageError);
				} else if (matchFlag(arg, '--engine', '--engine-id')) {
					params.engineId = takeOptVal(sArgs, ref, '--engine', usageError);
				} else if (matchFlag(arg, '--model')) {
					params.model = takeOptVal(sArgs, ref, '--model', usageError);
				} else if (matchFlag(arg, '--thinking')) {
					params.thinking = takeOptVal(sArgs, ref, '--thinking', usageError);
				} else if (matchFlag(arg, '--host', '--host-alias')) {
					params.hostAlias = takeOptVal(sArgs, ref, '--host', usageError);
				} else if (matchFlag(arg, '--role-prompt', '--persona')) {
					params.rolePrompt = takeOptVal(sArgs, ref, '--role-prompt', usageError);
				} else if (matchFlag(arg, '--allowed-paths', '--allowed-path', '--allow-path', '--allow-paths', '--paths')) {
					const raw = takeOptVal(sArgs, ref, '--allowed-paths', usageError);
					params.allowedPaths = raw === '' || raw === 'none' ? null : raw.split(/[|,;]/).map(s => s.trim()).filter(Boolean);
				} else if (matchFlag(arg, '--color', '--accent')) {
					const raw = takeOptVal(sArgs, ref, '--color', usageError);
					params.color = raw === '' || raw === 'default' || raw === 'none' ? null : raw;
				} else if (arg === '--reset-session' || arg === '--reset') {
					params.resetSession = true;
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else {
					throw usageError(`Unknown option for orchestration staff ${sSub}: ${arg}`);
				}
			}
			if (!params.nodeId) {
				throw usageError('Usage: aexus-ade orchestration staff config [--mission <id>] --node <staffId> [--engine <id>] [--model <m>] [--thinking <lvl>] [--host <alias>] [--role-prompt "<text>"] [--allowed-paths "a,b"] [--reset-session]');
			}
			return { help: false, json, windowId, action: 'orchestration.staff.configure', params };
		}
		if (sSub === 'remove' || sSub === 'rm' || sSub === 'delete') {
			const params = {};
			for (const ref = { i: 0 }; ref.i < sArgs.length; ref.i++) {
				const arg = sArgs[ref.i];
				if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOptVal(sArgs, ref, '--mission', usageError);
				} else if (matchFlag(arg, '--node', '--node-id', '--id')) {
					params.nodeId = takeOptVal(sArgs, ref, '--node', usageError);
				} else if (matchFlag(arg, '--reason', '--message')) {
					params.reason = takeOptVal(sArgs, ref, '--reason', usageError);
				} else if (arg === '--force') {
					params.force = true;
				} else if (!arg.startsWith('-') && !params.nodeId) {
					params.nodeId = arg;
				} else {
					throw usageError(`Unknown option for orchestration staff remove: ${arg}`);
				}
			}
			if (!params.nodeId) {
				throw usageError('Usage: aexus-ade orchestration staff remove [--mission <id>] --node <nodeId> [--reason "<why>"] [--force]');
			}
			return { help: false, json, windowId, action: 'orchestration.staff.remove', params };
		}
		if (sSub !== 'create' && sSub !== 'add') {
			throw usageError('Usage: aexus-ade orchestration staff <create | rename | config | remove> ...');
		}
		const params = {};
		for (const ref = { i: 0 }; ref.i < sArgs.length; ref.i++) {
			const arg = sArgs[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(sArgs, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--name', '--employee')) {
				params.name = takeOptVal(sArgs, ref, '--name', usageError);
			} else if (matchFlag(arg, '--id', '--node', '--node-id')) {
				params.id = takeOptVal(sArgs, ref, '--id', usageError);
			} else if (matchFlag(arg, '--rank', '--tier')) {
				params.rank = takeOptVal(sArgs, ref, '--rank', usageError);
			} else if (matchFlag(arg, '--role', '--title', '--label')) {
				const rawRole = takeOptVal(sArgs, ref, '--role', usageError);
				if (arg === '--role' && !params.rank && /^(?:L\d+|\d+|governor|manager|employee|worker|director|lead|tech-lead|principal|engineer|specialist|reviewer|auditor|researcher|executor)$/i.test(rawRole.trim())) {
					params.rank = rawRole.trim();
				} else {
					params.roleLabel = rawRole;
				}
			} else if (matchFlag(arg, '--department', '--dept')) {
				params.department = takeOptVal(sArgs, ref, '--department', usageError);
			} else if (matchFlag(arg, '--engine', '--engine-id')) {
				params.engineId = takeOptVal(sArgs, ref, '--engine', usageError);
			} else if (matchFlag(arg, '--model')) {
				params.model = takeOptVal(sArgs, ref, '--model', usageError);
			} else if (matchFlag(arg, '--thinking')) {
				params.thinking = takeOptVal(sArgs, ref, '--thinking', usageError);
			} else if (matchFlag(arg, '--host', '--host-alias')) {
				params.hostAlias = takeOptVal(sArgs, ref, '--host', usageError);
			} else if (matchFlag(arg, '--role-prompt', '--persona')) {
				params.rolePrompt = takeOptVal(sArgs, ref, '--role-prompt', usageError);
			} else if (matchFlag(arg, '--allowed-paths', '--allowed-path', '--allow-path', '--allow-paths', '--paths')) {
				params.allowedPaths = takeOptVal(sArgs, ref, '--allowed-paths', usageError).split(/[|,;]/).map(s => s.trim()).filter(Boolean);
			} else if (matchFlag(arg, '--color', '--accent')) {
				params.color = takeOptVal(sArgs, ref, '--color', usageError);
			} else if (matchFlag(arg, '--from', '--creator', '--parent')) {
				params.callerNodeId = takeOptVal(sArgs, ref, '--from', usageError);
			} else if (matchFlag(arg, '--edge-label')) {
				params.edgeLabel = takeOptVal(sArgs, ref, '--edge-label', usageError);
			} else if (arg === '--bidirectional' || arg === '--two-way') {
				params.bidirectional = true;
			} else if (arg === '--one-way' || arg === '--directed') {
				params.bidirectional = false;
			} else if (matchFlag(arg, '--handoff-token', '--token')) {
				params.handoffTokenId = takeOptVal(sArgs, ref, '--handoff-token', usageError);
			} else if (matchFlag(arg, '--mint-token')) {
				params.mintTokenId = takeOptVal(sArgs, ref, '--mint-token', usageError);
			} else if (matchFlag(arg, '--summary', '--message')) {
				params.handoffSummary = takeOptVal(sArgs, ref, '--summary', usageError);
			} else if (matchFlag(arg, '--whiteboard', '--whiteboards', '--wb')) {
				const rawWb = takeOptVal(sArgs, ref, '--whiteboard', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.whiteboardIds = [...(params.whiteboardIds ?? []), ...rawWb];
			} else if (!arg.startsWith('-') && !params.name) {
				params.name = arg;
			} else {
				throw usageError(`Unknown option for orchestration staff create: ${arg}`);
			}
		}
		if (!params.name) {
			throw usageError('Usage: aexus-ade orchestration staff create [--mission <id>] --name "<EmployeeName>" [--rank <rankId|L2..LN>] [--department "<Dept>"] [--handoff-token <tokenId> --summary "<subtask>"]');
		}
		return { help: false, json, windowId, action: 'orchestration.staff.create', params };
	}

	throw usageError(`Unknown orchestration subcommand: ${sub}`);
}

export function parseWhiteboardGroupCommand(tail, json, windowId, usageError) {
	const sub = tail[0]?.trim() || 'list';
	const args = tail.slice(1);

	if (sub === 'list') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--department', '--dept')) {
				params.department = takeOptVal(args, ref, '--department', usageError);
			} else if (!arg.startsWith('-') && !params.missionId) {
				params.missionId = arg;
			} else {
				throw usageError(`Unknown option for whiteboard list: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: 'whiteboard.list', params };
	}

	if (sub === 'read' || sub === 'get' || sub === 'cat') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--id', '--whiteboard', '--wb')) {
				params.id = takeOptVal(args, ref, '--id', usageError);
			} else if (!arg.startsWith('-') && !params.id) {
				params.id = arg;
			} else {
				throw usageError(`Unknown option for whiteboard read: ${arg}`);
			}
		}
		if (!params.id) {
			throw usageError('Usage: aexus-ade whiteboard read <whiteboardId> [--mission <id>]');
		}
		return { help: false, json, windowId, action: 'whiteboard.read', params };
	}

	if (sub === 'create' || sub === 'add' || sub === 'write' || sub === 'set' || sub === 'append') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--id', '--whiteboard', '--wb')) {
				params.id = takeOptVal(args, ref, '--id', usageError);
			} else if (matchFlag(arg, '--title', '--name')) {
				params.title = takeOptVal(args, ref, '--title', usageError);
			} else if (matchFlag(arg, '--department', '--dept')) {
				params.department = takeOptVal(args, ref, '--department', usageError);
			} else if (matchFlag(arg, '--content', '--text')) {
				params.content = takeOptVal(args, ref, '--content', usageError);
			} else if (matchFlag(arg, '--append')) {
				params.appendContent = takeOptVal(args, ref, '--append', usageError);
			} else if (matchFlag(arg, '--expected-version', '--if-version')) {
				const rawVer = takeOptVal(args, ref, '--expected-version', usageError);
				if (!/^\d+$/.test(rawVer)) {
					throw usageError(`Option --expected-version requires a non-negative integer, got: ${rawVer}`);
				}
				params.expectedVersion = Number.parseInt(rawVer, 10);
			} else if (matchFlag(arg, '--file', '-f')) {
				params.file = takeOptVal(args, ref, '--file', usageError);
			} else if (!arg.startsWith('-') && !params.id && (sub === 'write' || sub === 'set' || sub === 'append')) {
				params.id = arg;
			} else if (!arg.startsWith('-') && !params.title && (sub === 'create' || sub === 'add')) {
				params.title = arg;
			} else {
				throw usageError(`Unknown option for whiteboard ${sub}: ${arg}`);
			}
		}
		const action = (sub === 'create' || sub === 'add') ? 'whiteboard.create' : 'whiteboard.write';
		if (action === 'whiteboard.write' && !params.id) {
			throw usageError('Usage: aexus-ade whiteboard write <whiteboardId> (--content "<text>" | --append "<text>" | --file <path>) [--mission <id>]');
		}
		if (action === 'whiteboard.create' && !params.title && !params.department && !params.id) {
			throw usageError('Usage: aexus-ade whiteboard create --department "<Dept>" --title "<Title>" [--id <wbId>] [--content "<text>"] [--mission <id>]');
		}
		return { help: false, json, windowId, action, params };
	}

	if (sub === 'rename') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--id', '--whiteboard', '--wb')) {
				params.id = takeOptVal(args, ref, '--id', usageError);
			} else if (matchFlag(arg, '--title', '--name')) {
				params.title = takeOptVal(args, ref, '--title', usageError);
			} else if (matchFlag(arg, '--department', '--dept')) {
				params.department = takeOptVal(args, ref, '--department', usageError);
			} else if (!arg.startsWith('-') && !params.id) {
				params.id = arg;
			} else if (!arg.startsWith('-') && !params.title) {
				params.title = arg;
			} else {
				throw usageError(`Unknown option for whiteboard rename: ${arg}`);
			}
		}
		if (!params.id || !params.title) {
			throw usageError('Usage: aexus-ade whiteboard rename <wbId> "<New Title>" [--department "<Dept>"] [--mission <id>]');
		}
		return { help: false, json, windowId, action: 'whiteboard.rename', params };
	}

	if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOptVal(args, ref, '--mission', usageError);
			} else if (matchFlag(arg, '--id', '--whiteboard', '--wb')) {
				params.id = takeOptVal(args, ref, '--id', usageError);
			} else if (!arg.startsWith('-') && !params.id) {
				params.id = arg;
			} else {
				throw usageError(`Unknown option for whiteboard remove: ${arg}`);
			}
		}
		if (!params.id) {
			throw usageError('Usage: aexus-ade whiteboard remove <wbId> [--mission <id>]');
		}
		return { help: false, json, windowId, action: 'whiteboard.remove', params };
	}

	throw usageError(`Unknown whiteboard subcommand: ${sub}`);
}
