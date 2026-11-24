/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Modular CLI parsers for Orchestration topology, Department Shared Whiteboards (including C3
 * TOC / section / window-sliced reads & section upserts), and C6 Mission/Orchestration Checkpoints.
 */

const ORCH_ALLOW_DASH_VALUE_FLAGS = new Set([
	'--summary', '--message', '--detail', '--body', '--detail-file', '--body-file',
	'--artifact', '--decision', '--reason', '--feedback', '--note', '--guidance',
	'--prompt', '--text', '--mermaid', '--json-text', '--pre-prompt', '--description', '--desc',
	'--title', '--name', '--label', '--edge-label', '--whiteboard-title', '--wb-title',
	'--content', '--append', '--append-file', '--file', '-f', '--out', '-o',
	'--role-prompt', '--persona',
]);

export function takeOrchOptVal(args, ref, flagName, usageError, allowDashValue = false) {
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
	if (!allowDashValue && !ORCH_ALLOW_DASH_VALUE_FLAGS.has(flagName) && next.startsWith('--')) {
		throw usageError(`Option ${flagName} requires a value, got ${next}.`);
	}
	return next;
}

export function matchOrchFlag(arg, ...names) {
	for (const n of names) {
		if (arg === n || arg.startsWith(`${n}=`)) {
			return true;
		}
	}
	return false;
}

export function parseOrchKeyValBlobFlag(rawValue, flagName, usageError) {
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

/**
 * Shared C3 progressive-disclosure slice flag parser for `whiteboard read` and `token read`:
 * `--toc`, `--summary-only`, `--section "<Heading>"`, `--max-chars <N>`, `--offset <N>`, `--tail <N>`.
 */
export function consumeSliceReadFlag(arg, args, ref, params, usageError) {
	if (arg === '--toc') {
		params.toc = true;
		return true;
	}
	if (arg === '--summary-only' || arg === '--outline') {
		params.summaryOnly = true;
		return true;
	}
	if (matchOrchFlag(arg, '--section', '--heading')) {
		params.section = takeOrchOptVal(args, ref, '--section', usageError);
		return true;
	}
	if (matchOrchFlag(arg, '--max-chars', '--maxChars')) {
		const raw = takeOrchOptVal(args, ref, '--max-chars', usageError).trim();
		if (!/^\d+$/.test(raw) || Number(raw) < 1) {
			throw usageError(`Invalid --max-chars value "${raw}". Expected a positive integer >= 1.`);
		}
		params.maxChars = Number.parseInt(raw, 10);
		return true;
	}
	if (matchOrchFlag(arg, '--offset')) {
		const raw = takeOrchOptVal(args, ref, '--offset', usageError).trim();
		if (!/^\d+$/.test(raw)) {
			throw usageError(`Invalid --offset value "${raw}". Expected a non-negative integer >= 0.`);
		}
		if (params.tailChars !== undefined) {
			throw usageError('Cannot combine --offset and --tail in the same read.');
		}
		params.offset = Number.parseInt(raw, 10);
		return true;
	}
	if (matchOrchFlag(arg, '--tail', '--tail-chars', '--tailChars')) {
		const raw = takeOrchOptVal(args, ref, '--tail', usageError).trim();
		if (!/^\d+$/.test(raw) || Number(raw) < 1) {
			throw usageError(`Invalid --tail value "${raw}". Expected a positive integer >= 1.`);
		}
		if (params.offset !== undefined) {
			throw usageError('Cannot combine --offset and --tail in the same read.');
		}
		params.tailChars = Number.parseInt(raw, 10);
		return true;
	}
	return false;
}

/**
 * Shared C6 checkpoint parser supporting both `mission checkpoint ...` and `orchestration checkpoint ...`.
 */
export function parseCheckpointGroupCommand(args, json, windowId, usageError, actionPrefix = 'mission.checkpoint') {
	const cpSub = args[0]?.trim() || 'list';
	const cpArgs = args.slice(1);

	if (cpSub === 'list' || cpSub === 'ls') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < cpArgs.length; ref.i++) {
			const arg = cpArgs[ref.i];
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOrchOptVal(cpArgs, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--limit')) {
				const raw = takeOrchOptVal(cpArgs, ref, '--limit', usageError).trim();
				if (!/^\d+$/.test(raw) || Number(raw) < 1) {
					throw usageError(`Invalid --limit value "${raw}". Expected a positive integer.`);
				}
				params.limit = Number.parseInt(raw, 10);
			} else if (!arg.startsWith('-') && !params.missionId) {
				params.missionId = arg;
			} else {
				throw usageError(`Unknown option for checkpoint list: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: `${actionPrefix}.list`, params };
	}

	if (cpSub === 'create' || cpSub === 'save' || cpSub === 'add') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < cpArgs.length; ref.i++) {
			const arg = cpArgs[ref.i];
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOrchOptVal(cpArgs, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--label', '--name', '--title')) {
				params.label = takeOrchOptVal(cpArgs, ref, '--label', usageError, true);
			} else if (matchOrchFlag(arg, '--reason', '--note', '--message')) {
				params.reason = takeOrchOptVal(cpArgs, ref, '--reason', usageError, true);
			} else if (!arg.startsWith('-') && !params.label) {
				params.label = arg;
			} else {
				throw usageError(`Unknown option for checkpoint create: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: `${actionPrefix}.create`, params };
	}

	if (cpSub === 'diff' || cpSub === 'compare') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < cpArgs.length; ref.i++) {
			const arg = cpArgs[ref.i];
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOrchOptVal(cpArgs, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--checkpoint', '--checkpoint-id', '--id', '--from')) {
				const cid = takeOrchOptVal(cpArgs, ref, '--checkpoint', usageError);
				params.checkpointId = cid;
				params.id = cid;
				params.from = cid;
			} else if (matchOrchFlag(arg, '--to', '--against', '--base')) {
				const tid = takeOrchOptVal(cpArgs, ref, '--to', usageError);
				params.to = tid;
				params.againstCheckpointId = tid;
			} else if (!arg.startsWith('-') && !params.checkpointId) {
				params.checkpointId = arg;
				params.id = arg;
				params.from = arg;
			} else if (!arg.startsWith('-') && !params.to) {
				params.to = arg;
				params.againstCheckpointId = arg;
			} else {
				throw usageError(`Unknown option for checkpoint diff: ${arg}`);
			}
		}
		if (!params.checkpointId) {
			throw usageError('Usage: aexus-ade mission checkpoint diff [--mission <id>] (<checkpointId> | --checkpoint <id>) [<toCheckpointId> | --to <otherId>]');
		}
		return { help: false, json, windowId, action: `${actionPrefix}.diff`, params };
	}

	if (cpSub === 'restore' || cpSub === 'rollback') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < cpArgs.length; ref.i++) {
			const arg = cpArgs[ref.i];
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOrchOptVal(cpArgs, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--checkpoint', '--checkpoint-id', '--id')) {
				const cid = takeOrchOptVal(cpArgs, ref, '--checkpoint', usageError);
				params.checkpointId = cid;
				params.id = cid;
			} else if (matchOrchFlag(arg, '--mode')) {
				const mode = takeOrchOptVal(cpArgs, ref, '--mode', usageError).trim().toLowerCase();
				if (mode !== 'full' && mode !== 'tokens_only') {
					throw usageError(`Invalid --mode "${mode}". Expected full or tokens_only.`);
				}
				params.mode = mode;
			} else if (arg === '--tokens-only') {
				params.mode = 'tokens_only';
			} else if (matchOrchFlag(arg, '--reason', '--note', '--message')) {
				params.reason = takeOrchOptVal(cpArgs, ref, '--reason', usageError, true);
			} else if (arg === '--force') {
				params.force = true;
			} else if (!arg.startsWith('-') && !params.checkpointId) {
				params.checkpointId = arg;
				params.id = arg;
			} else {
				throw usageError(`Unknown option for checkpoint restore: ${arg}`);
			}
		}
		if (!params.checkpointId) {
			throw usageError('Usage: aexus-ade mission checkpoint restore [--mission <id>] (<checkpointId> | --checkpoint <id>) [--mode <full|tokens_only>] [--reason "<why>"] [--force]');
		}
		return { help: false, json, windowId, action: `${actionPrefix}.restore`, params };
	}

	throw usageError('Usage: aexus-ade mission checkpoint <list | create | diff | restore> [--mission <id>] [--label "<name>"] [--checkpoint <id>]');
}

export function parseOrchestrationGroupCommand(tail, json, windowId, usageError) {
	const sub = tail[0]?.trim() || 'status';
	const args = tail.slice(1);

	if (sub === 'checkpoint' || sub === 'checkpoints') {
		return parseCheckpointGroupCommand(args, json, windowId, usageError, 'mission.checkpoint');
	}

	if (sub === 'diagnostics' || sub === 'diag' || sub === 'health') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (!arg.startsWith('-') && !params.missionId) {
				params.missionId = arg;
			} else {
				throw usageError(`Unknown option for orchestration diagnostics: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: 'mission.diagnostics', params };
	}

	if (sub === 'get' || sub === 'show') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
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
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--file', '-f')) {
				params.file = takeOrchOptVal(args, ref, '--file', usageError);
			} else if (matchOrchFlag(arg, '--text', '--mermaid')) {
				params.text = takeOrchOptVal(args, ref, '--text', usageError);
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
			if (matchOrchFlag(arg, '--file', '-f')) {
				params.file = takeOrchOptVal(args, ref, '--file', usageError);
			} else if (matchOrchFlag(arg, '--text', '--mermaid')) {
				params.text = takeOrchOptVal(args, ref, '--text', usageError);
			} else if (matchOrchFlag(arg, '--format')) {
				params.format = takeOrchOptVal(args, ref, '--format', usageError).toLowerCase();
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
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--file', '-f')) {
				params.file = takeOrchOptVal(args, ref, '--file', usageError);
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
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--reason', '--message')) {
				params.reason = takeOrchOptVal(args, ref, '--reason', usageError);
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
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (arg === '--full' || arg === '--verbose') {
				params.full = true;
			} else if (!arg.startsWith('-') && !params.missionId) {
				params.missionId = arg;
			} else {
				throw usageError(`Unknown option for orchestration status: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: 'orchestration.status', params };
	}

	if (sub === 'limits' || sub === 'guardrails' || sub === 'budget') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--max-hops', '--maxHops', '--hops')) {
				const raw = takeOrchOptVal(args, ref, '--max-hops', usageError).trim();
				const lower = raw.toLowerCase();
				if (lower === 'none' || lower === 'off' || lower === 'default' || lower === 'clear' || lower === 'unlimited' || raw === '0') {
					params.maxHops = null;
				} else {
					const parsed = Number(raw);
					if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
						throw usageError(`Invalid --max-hops value "${raw}". Provide an integer between 1 and 10000 or "none".`);
					}
					params.maxHops = parsed;
				}
			} else if (matchOrchFlag(arg, '--budget', '--budget-limit', '--limit-usd', '--usd')) {
				const raw = takeOrchOptVal(args, ref, '--budget', usageError).trim();
				const lower = raw.toLowerCase();
				if (lower === 'none' || lower === 'off' || lower === 'clear' || lower === 'unlimited' || lower === 'inf' || lower === 'infinity' || raw === '0') {
					params.budgetLimitUsd = null;
				} else {
					const parsed = Number(raw);
					if (!Number.isFinite(parsed) || parsed <= 0) {
						throw usageError(`Invalid --budget value "${raw}". Provide a positive USD number or "none".`);
					}
					params.budgetLimitUsd = parsed;
				}
			} else if (matchOrchFlag(arg, '--silence', '--silence-minutes', '--silence-reminder', '--silence-reminder-minutes')) {
				const raw = takeOrchOptVal(args, ref, '--silence', usageError).trim();
				const parsed = Number(raw);
				if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1440) {
					throw usageError(`Invalid --silence value "${raw}". Provide minutes between 1 and 1440.`);
				}
				params.silenceReminderMinutes = Math.floor(parsed);
			} else if (matchOrchFlag(arg, '--total-cost', '--total-cost-usd')) {
				const raw = takeOrchOptVal(args, ref, '--total-cost', usageError).trim();
				const lower = raw.toLowerCase();
				if (lower === 'off' || lower === 'reset' || lower === 'clear') {
					params.totalCostUsd = 0;
				} else {
					const parsed = Number(raw);
					if (!Number.isFinite(parsed) || parsed < 0) {
						throw usageError(`Invalid --total-cost value "${raw}". Provide a non-negative USD number.`);
					}
					params.totalCostUsd = parsed;
				}
			} else if (!arg.startsWith('-') && !params.missionId) {
				params.missionId = arg;
			} else {
				throw usageError(`Unknown option for orchestration ${sub}: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: 'orchestration.limits', params };
	}

	if (sub === 'dispatch' || sub === 'send' || sub === 'start') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--prompt', '--message', '--text')) {
				params.prompt = takeOrchOptVal(args, ref, '--prompt', usageError);
			} else if (matchOrchFlag(arg, '--detail', '--body')) {
				params.detail = takeOrchOptVal(args, ref, '--detail', usageError);
			} else if (matchOrchFlag(arg, '--detail-file', '--body-file')) {
				params.detailFile = takeOrchOptVal(args, ref, '--detail-file', usageError);
			} else if (matchOrchFlag(arg, '--artifact')) {
				const item = parseOrchKeyValBlobFlag(takeOrchOptVal(args, ref, '--artifact', usageError), '--artifact', usageError);
				params.artifacts = [...(params.artifacts ?? []), item];
			} else if (matchOrchFlag(arg, '--decision')) {
				const item = parseOrchKeyValBlobFlag(takeOrchOptVal(args, ref, '--decision', usageError), '--decision', usageError);
				params.decisions = [...(params.decisions ?? []), item];
			} else if (matchOrchFlag(arg, '--ref', '--refs')) {
				const rawRefs = takeOrchOptVal(args, ref, '--ref', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.refPtrs = [...(params.refPtrs ?? []), ...rawRefs];
			} else if (matchOrchFlag(arg, '--to', '--node', '--target')) {
				params.targetNodeId = takeOrchOptVal(args, ref, '--to', usageError);
			} else if (matchOrchFlag(arg, '--task', '--task-id', '--task-node')) {
				params.taskNodeId = takeOrchOptVal(args, ref, '--task', usageError);
			} else if (matchOrchFlag(arg, '--tasks', '--task-ids')) {
				const rawT = takeOrchOptVal(args, ref, '--tasks', usageError).split(',').map(s => s.trim()).filter(Boolean);
				params.taskNodeIds = [...(params.taskNodeIds ?? []), ...rawT];
			} else if (matchOrchFlag(arg, '--whiteboard', '--whiteboards', '--wb')) {
				const rawWb = takeOrchOptVal(args, ref, '--whiteboard', usageError).split(',').map(s => s.trim()).filter(Boolean);
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
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--file', '--out', '-o')) {
				params.outputFile = takeOrchOptVal(args, ref, '--file', usageError);
			} else if (matchOrchFlag(arg, '--format')) {
				params.format = takeOrchOptVal(args, ref, '--format', usageError).toLowerCase();
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
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor', '--id')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--file', '-f')) {
				params.file = takeOrchOptVal(args, ref, '--file', usageError);
			} else if (matchOrchFlag(arg, '--text', '--mermaid')) {
				params.text = takeOrchOptVal(args, ref, '--text', usageError);
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
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOrchOptVal(lArgs, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--mode', '--layout')) {
				params.layoutMode = takeOrchOptVal(lArgs, ref, '--mode', usageError).toLowerCase();
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
				if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOrchOptVal(gArgs, ref, '--mission', usageError);
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
				if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOrchOptVal(gArgs, ref, '--mission', usageError);
				} else if (matchOrchFlag(arg, '--name', '--title')) {
					params.name = takeOrchOptVal(gArgs, ref, '--name', usageError);
				} else if (matchOrchFlag(arg, '--id', '--group-id')) {
					params.groupId = takeOrchOptVal(gArgs, ref, '--id', usageError);
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
				if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOrchOptVal(gArgs, ref, '--mission', usageError);
				} else if (matchOrchFlag(arg, '--group', '--id', '--from')) {
					params.group = takeOrchOptVal(gArgs, ref, '--group', usageError);
				} else if (matchOrchFlag(arg, '--name', '--new-name', '--to', '--title')) {
					params.name = takeOrchOptVal(gArgs, ref, '--name', usageError);
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
				if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOrchOptVal(gArgs, ref, '--mission', usageError);
				} else if (matchOrchFlag(arg, '--node', '--node-id')) {
					params.nodeId = takeOrchOptVal(gArgs, ref, '--node', usageError);
				} else if (matchOrchFlag(arg, '--group', '--group-id', '--department', '--dept')) {
					params.group = takeOrchOptVal(gArgs, ref, '--group', usageError);
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
				if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOrchOptVal(gArgs, ref, '--mission', usageError);
				} else if (matchOrchFlag(arg, '--group', '--id', '--name')) {
					params.group = takeOrchOptVal(gArgs, ref, '--group', usageError);
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
				if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOrchOptVal(eArgs, ref, '--mission', usageError);
				} else if (matchOrchFlag(arg, '--from')) {
					params.from = takeOrchOptVal(eArgs, ref, '--from', usageError);
				} else if (matchOrchFlag(arg, '--to')) {
					params.to = takeOrchOptVal(eArgs, ref, '--to', usageError);
				} else if (matchOrchFlag(arg, '--label')) {
					params.label = takeOrchOptVal(eArgs, ref, '--label', usageError);
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
				if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOrchOptVal(eArgs, ref, '--mission', usageError);
				} else if (matchOrchFlag(arg, '--from')) {
					params.from = takeOrchOptVal(eArgs, ref, '--from', usageError);
				} else if (matchOrchFlag(arg, '--to')) {
					params.to = takeOrchOptVal(eArgs, ref, '--to', usageError);
				} else if (matchOrchFlag(arg, '--label', '--text')) {
					params.label = takeOrchOptVal(eArgs, ref, '--label', usageError);
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
				if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOrchOptVal(eArgs, ref, '--mission', usageError);
				} else if (matchOrchFlag(arg, '--from')) {
					params.from = takeOrchOptVal(eArgs, ref, '--from', usageError);
				} else if (matchOrchFlag(arg, '--to')) {
					params.to = takeOrchOptVal(eArgs, ref, '--to', usageError);
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
				if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOrchOptVal(sArgs, ref, '--mission', usageError);
				} else if (matchOrchFlag(arg, '--node', '--node-id', '--id')) {
					params.nodeId = takeOrchOptVal(sArgs, ref, '--node', usageError);
				} else if (matchOrchFlag(arg, '--name', '--label', '--title')) {
					params.label = takeOrchOptVal(sArgs, ref, '--name', usageError);
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
				if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOrchOptVal(sArgs, ref, '--mission', usageError);
				} else if (matchOrchFlag(arg, '--node', '--node-id', '--id')) {
					params.nodeId = takeOrchOptVal(sArgs, ref, '--node', usageError);
				} else if (matchOrchFlag(arg, '--engine', '--engine-id')) {
					params.engineId = takeOrchOptVal(sArgs, ref, '--engine', usageError);
				} else if (matchOrchFlag(arg, '--model')) {
					params.model = takeOrchOptVal(sArgs, ref, '--model', usageError);
				} else if (matchOrchFlag(arg, '--thinking')) {
					params.thinking = takeOrchOptVal(sArgs, ref, '--thinking', usageError);
				} else if (matchOrchFlag(arg, '--host', '--host-alias')) {
					params.hostAlias = takeOrchOptVal(sArgs, ref, '--host', usageError);
				} else if (matchOrchFlag(arg, '--role-prompt', '--persona')) {
					params.rolePrompt = takeOrchOptVal(sArgs, ref, '--role-prompt', usageError);
				} else if (matchOrchFlag(arg, '--allowed-paths', '--allowed-path', '--allow-path', '--allow-paths', '--paths')) {
					const raw = takeOrchOptVal(sArgs, ref, '--allowed-paths', usageError);
					params.allowedPaths = raw === '' || raw === 'none' ? null : raw.split(/[|,;]/).map(s => s.trim()).filter(Boolean);
				} else if (matchOrchFlag(arg, '--color', '--accent')) {
					const raw = takeOrchOptVal(sArgs, ref, '--color', usageError);
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
				if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
					params.missionId = takeOrchOptVal(sArgs, ref, '--mission', usageError);
				} else if (matchOrchFlag(arg, '--node', '--node-id', '--id')) {
					params.nodeId = takeOrchOptVal(sArgs, ref, '--node', usageError);
				} else if (matchOrchFlag(arg, '--reason', '--message')) {
					params.reason = takeOrchOptVal(sArgs, ref, '--reason', usageError);
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
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOrchOptVal(sArgs, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--name', '--employee')) {
				params.name = takeOrchOptVal(sArgs, ref, '--name', usageError);
			} else if (matchOrchFlag(arg, '--id', '--node', '--node-id')) {
				params.id = takeOrchOptVal(sArgs, ref, '--id', usageError);
			} else if (matchOrchFlag(arg, '--rank', '--tier')) {
				params.rank = takeOrchOptVal(sArgs, ref, '--rank', usageError);
			} else if (matchOrchFlag(arg, '--role', '--title', '--label')) {
				const rawRole = takeOrchOptVal(sArgs, ref, '--role', usageError, true);
				const isRoleFlag = arg === '--role' || arg.startsWith('--role=');
				if (isRoleFlag && !params.rank && /^(?:L\d+|\d+|governor|manager|employee|worker|director|lead|tech-lead|principal|engineer|specialist|reviewer|auditor|researcher|executor)$/i.test(rawRole.trim())) {
					params.rank = rawRole.trim();
				} else {
					params.roleLabel = rawRole;
				}
			} else if (matchOrchFlag(arg, '--department', '--dept', '--new-department', '--new-dept')) {
				params.department = takeOrchOptVal(sArgs, ref, '--department', usageError);
			} else if (arg === '--create-whiteboard' || arg === '--with-whiteboard') {
				params.createWhiteboard = true;
			} else if (arg.startsWith('--create-whiteboard=') || arg.startsWith('--with-whiteboard=')) {
				const titleVal = arg.slice(arg.indexOf('=') + 1).trim();
				params.createWhiteboard = true;
				if (titleVal) {
					params.whiteboardTitle = titleVal;
				}
			} else if (matchOrchFlag(arg, '--whiteboard-title', '--wb-title')) {
				params.createWhiteboard = true;
				params.whiteboardTitle = takeOrchOptVal(sArgs, ref, '--whiteboard-title', usageError);
			} else if (matchOrchFlag(arg, '--engine', '--engine-id')) {
				params.engineId = takeOrchOptVal(sArgs, ref, '--engine', usageError);
			} else if (matchOrchFlag(arg, '--model')) {
				params.model = takeOrchOptVal(sArgs, ref, '--model', usageError);
			} else if (matchOrchFlag(arg, '--thinking')) {
				params.thinking = takeOrchOptVal(sArgs, ref, '--thinking', usageError);
			} else if (matchOrchFlag(arg, '--host', '--host-alias')) {
				params.hostAlias = takeOrchOptVal(sArgs, ref, '--host', usageError);
			} else if (matchOrchFlag(arg, '--role-prompt', '--persona')) {
				params.rolePrompt = takeOrchOptVal(sArgs, ref, '--role-prompt', usageError);
			} else if (matchOrchFlag(arg, '--allowed-paths', '--allowed-path', '--allow-path', '--allow-paths', '--paths')) {
				params.allowedPaths = takeOrchOptVal(sArgs, ref, '--allowed-paths', usageError).split(/[|,;]/).map(s => s.trim()).filter(Boolean);
			} else if (matchOrchFlag(arg, '--color', '--accent')) {
				params.color = takeOrchOptVal(sArgs, ref, '--color', usageError);
			} else if (matchOrchFlag(arg, '--from', '--creator', '--parent')) {
				params.callerNodeId = takeOrchOptVal(sArgs, ref, '--from', usageError);
			} else if (matchOrchFlag(arg, '--edge-label')) {
				params.edgeLabel = takeOrchOptVal(sArgs, ref, '--edge-label', usageError);
			} else if (arg === '--bidirectional' || arg === '--two-way') {
				params.bidirectional = true;
			} else if (arg.startsWith('--bidirectional=') || arg.startsWith('--two-way=')) {
				const rawBool = arg.slice(arg.indexOf('=') + 1).trim().toLowerCase();
				if (rawBool === 'true' || rawBool === '1' || rawBool === 'yes') {
					params.bidirectional = true;
				} else if (rawBool === 'false' || rawBool === '0' || rawBool === 'no') {
					params.bidirectional = false;
				} else {
					throw usageError(`Invalid boolean value for --bidirectional: ${rawBool}`);
				}
			} else if (arg === '--one-way' || arg === '--directed') {
				params.bidirectional = false;
			} else if (matchOrchFlag(arg, '--handoff-token', '--token')) {
				params.handoffTokenId = takeOrchOptVal(sArgs, ref, '--handoff-token', usageError);
			} else if (matchOrchFlag(arg, '--mint-token')) {
				params.mintTokenId = takeOrchOptVal(sArgs, ref, '--mint-token', usageError);
			} else if (matchOrchFlag(arg, '--summary', '--message')) {
				params.handoffSummary = takeOrchOptVal(sArgs, ref, '--summary', usageError);
			} else if (matchOrchFlag(arg, '--whiteboard', '--whiteboards', '--wb')) {
				const rawWb = takeOrchOptVal(sArgs, ref, '--whiteboard', usageError).split(',').map(s => s.trim()).filter(Boolean);
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
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--department', '--dept')) {
				params.department = takeOrchOptVal(args, ref, '--department', usageError);
			} else if (!arg.startsWith('-') && !params.missionId) {
				params.missionId = arg;
			} else {
				throw usageError(`Unknown option for whiteboard list: ${arg}`);
			}
		}
		return { help: false, json, windowId, action: 'whiteboard.list', params };
	}

	if (sub === 'read' || sub === 'get' || sub === 'cat' || sub === 'toc' || sub === 'outline') {
		const params = (sub === 'toc' || sub === 'outline') ? { toc: true } : {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--id', '--whiteboard', '--wb')) {
				params.id = takeOrchOptVal(args, ref, '--id', usageError);
			} else if (consumeSliceReadFlag(arg, args, ref, params, usageError)) {
				// Slice option consumed.
			} else if (!arg.startsWith('-') && !params.id) {
				params.id = arg;
			} else {
				throw usageError(`Unknown option for whiteboard ${sub}: ${arg}`);
			}
		}
		if (!params.id) {
			throw usageError('Usage: aexus-ade whiteboard read <whiteboardId> [--mission <id>] [--toc | --summary-only] [--section "<Heading>"] [--max-chars <N>] [--offset <N> | --tail <N>]');
		}
		return { help: false, json, windowId, action: 'whiteboard.read', params };
	}

	if (sub === 'create' || sub === 'add' || sub === 'write' || sub === 'set' || sub === 'append') {
		const params = {};
		for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
			const arg = args[ref.i];
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--id', '--whiteboard', '--wb')) {
				params.id = takeOrchOptVal(args, ref, '--id', usageError);
			} else if (matchOrchFlag(arg, '--title', '--name')) {
				params.title = takeOrchOptVal(args, ref, '--title', usageError);
			} else if (matchOrchFlag(arg, '--department', '--dept')) {
				params.department = takeOrchOptVal(args, ref, '--department', usageError);
			} else if (matchOrchFlag(arg, '--section', '--heading')) {
				params.section = takeOrchOptVal(args, ref, '--section', usageError);
			} else if (matchOrchFlag(arg, '--content', '--text')) {
				params.content = takeOrchOptVal(args, ref, '--content', usageError);
			} else if (matchOrchFlag(arg, '--append')) {
				params.appendContent = takeOrchOptVal(args, ref, '--append', usageError);
			} else if (matchOrchFlag(arg, '--append-file')) {
				params.appendFile = takeOrchOptVal(args, ref, '--append-file', usageError);
			} else if (matchOrchFlag(arg, '--expected-version', '--if-version')) {
				const rawVer = takeOrchOptVal(args, ref, '--expected-version', usageError);
				if (!/^\d+$/.test(rawVer)) {
					throw usageError(`Option --expected-version requires a non-negative integer, got: ${rawVer}`);
				}
				params.expectedVersion = Number.parseInt(rawVer, 10);
			} else if (matchOrchFlag(arg, '--file', '-f')) {
				if (sub === 'append') {
					params.appendFile = takeOrchOptVal(args, ref, '--file', usageError);
				} else {
					params.file = takeOrchOptVal(args, ref, '--file', usageError);
				}
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
			throw usageError('Usage: aexus-ade whiteboard write <whiteboardId> [--section "<Heading>"] (--content "<text>" | --append "<text>" | --file <path>) [--expected-version <n>] [--mission <id>]');
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
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--id', '--whiteboard', '--wb')) {
				params.id = takeOrchOptVal(args, ref, '--id', usageError);
			} else if (matchOrchFlag(arg, '--title', '--name')) {
				params.title = takeOrchOptVal(args, ref, '--title', usageError);
			} else if (matchOrchFlag(arg, '--department', '--dept')) {
				params.department = takeOrchOptVal(args, ref, '--department', usageError);
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
			if (matchOrchFlag(arg, '--mission', '--mission-id', '--governor')) {
				params.missionId = takeOrchOptVal(args, ref, '--mission', usageError);
			} else if (matchOrchFlag(arg, '--id', '--whiteboard', '--wb')) {
				params.id = takeOrchOptVal(args, ref, '--id', usageError);
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
