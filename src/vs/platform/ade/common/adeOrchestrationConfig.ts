/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Structured Engineering Code-as-Orchestration Manifest (v1):
 * Allows teams to store version-controlled declarative orchestration topology + complete staff
 * role configurations (`rolePrompt`, `allowedPaths`, automated `checks`, `engineId`, `model`,
 * `thinking`, `hostAlias`), department whiteboards, and optional Mission Task DAG definitions
 * right in their repository (e.g. `.aexus/orchestration.json` or `.aexus/orchestration.mjs`),
 * validate them deterministically via CLI/API, compile them into canonical bijective Mermaid
 * + runtime metadata, and export live workspaces losslessly back to JSON.
 */

import {
	IMissionDagParseResult,
	IMissionNodeCheckHook,
	MissionDagDirection,
	MissionDagEdgeKind,
	parseMissionMermaidDag,
} from './adeMissionDag.js';
import {
	IOrchestrationDepartmentGroup,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	IOrchestrationGraphParseResult,
	OrchestrationDirection,
	OrchestrationLayoutMode,
	parseOrchestrationGraph,
	serializeOrchestrationGraph,
} from './adeOrchestrationGraph.js';
import { normalizeAdeNodeColor } from './adeNodeColors.js';

export const ADE_ORCHESTRATION_MANIFEST_SCHEMA_VERSION = 1;

export interface IAdeOrchestrationManifestDepartment {
	readonly id?: string;
	readonly name: string;
}

export interface IAdeOrchestrationManifestStaff {
	readonly id: string;
	readonly name: string;
	readonly roleLabel?: string;
	readonly tier?: number;
	readonly rankId?: string;
	readonly department?: string;
	readonly engineId?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly hostAlias?: string;
	/** Concise role boundary / persona prompt (strictly NOT legacy task pre-prompt). */
	readonly rolePrompt?: string;
	/** Repo-relative allowed read/write directory prefixes for this staff role. */
	readonly allowedPaths?: readonly string[];
	/** Automated deterministic verification commands executed before token handoff/return/complete. */
	readonly checks?: readonly IMissionNodeCheckHook[];
	/** Optional visual accent color preset ID (e.g. 'gold', 'cyan') or `#rrggbb` hex. */
	readonly color?: string;
}

export interface IAdeOrchestrationManifestWhiteboard {
	readonly id: string;
	readonly title: string;
	readonly department?: string;
	readonly content?: string;
	readonly version?: number;
	readonly color?: string;
}

export interface IAdeOrchestrationManifestEdge {
	readonly from: string;
	readonly to: string;
	readonly label?: string;
	readonly bidirectional?: boolean;
	readonly dashed?: boolean;
}

export interface IAdeOrchestrationManifestTaskNode {
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly kind?: 'task' | 'gate';
	readonly ownerNodeId?: string;
	readonly assigneeNodeId?: string;
	readonly department?: string;
	readonly minCompleterTier?: number;
	readonly allowedCompleterNodeIds?: readonly string[];
	readonly checks?: readonly IMissionNodeCheckHook[];
	readonly color?: string;
}

export interface IAdeOrchestrationManifestTaskEdge {
	readonly from: string;
	readonly to: string;
	readonly label?: string;
	readonly kind?: MissionDagEdgeKind;
}

export interface IAdeOrchestrationManifestTasks {
	readonly direction?: MissionDagDirection;
	readonly nodes: readonly IAdeOrchestrationManifestTaskNode[];
	readonly edges?: readonly IAdeOrchestrationManifestTaskEdge[];
}

export interface IAdeOrchestrationManifest {
	readonly schemaVersion: 1;
	readonly name?: string;
	readonly description?: string;
	readonly direction?: OrchestrationDirection;
	readonly layoutMode?: OrchestrationLayoutMode;
	readonly departments?: readonly IAdeOrchestrationManifestDepartment[];
	readonly staff: readonly IAdeOrchestrationManifestStaff[];
	readonly whiteboards?: readonly IAdeOrchestrationManifestWhiteboard[];
	readonly edges?: readonly IAdeOrchestrationManifestEdge[];
	readonly tasks?: IAdeOrchestrationManifestTasks;
}

export interface IAdeOrchestrationManifestValidationResult {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly warnings: readonly string[];
	readonly manifest?: IAdeOrchestrationManifest;
}

export interface IAdeCompiledOrchestrationManifest {
	readonly orchestrationText: string;
	readonly whiteboards: Readonly<Record<string, {
		readonly id: string;
		readonly title: string;
		readonly department: string;
		readonly content: string;
		readonly version: number;
	}>>;
	readonly mermaidText?: string;
	readonly nodePrompts: Readonly<Record<string, string>>;
	readonly nodeChecks: Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
	readonly staffChecks: Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
	readonly parsedOrchestration: IOrchestrationGraphParseResult;
	readonly parsedTasks?: IMissionDagParseResult;
}

const VALID_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function escapeQuoted(val: string): string {
	return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ').trim();
}

function formatTaskMetaValue(val: string): string {
	return /^[A-Za-z0-9_.:|-]+$/.test(val) ? val : `"${escapeQuoted(val)}"`;
}

function sanitizeCheckHook(raw: unknown, ownerId: string, index: number, errors: string[], fieldPrefix: string): IMissionNodeCheckHook | undefined {
	if (!raw || typeof raw !== 'object') {
		errors.push(`${fieldPrefix}[${index}] must be an object.`);
		return undefined;
	}
	const rec = raw as Record<string, unknown>;
	const command = typeof rec.command === 'string' ? rec.command.trim() : undefined;
	const expectFiles = Array.isArray(rec.expectFiles)
		? rec.expectFiles.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).map(f => f.trim())
		: undefined;
	if (!command && (!expectFiles || expectFiles.length === 0)) {
		errors.push(`${fieldPrefix}[${index}] must specify either "command" or non-empty "expectFiles".`);
		return undefined;
	}
	const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : `manifest-check-${ownerId}-${index + 1}`;
	const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : undefined;
	const cwd = typeof rec.cwd === 'string' && rec.cwd.trim() ? rec.cwd.trim() : undefined;
	const hostAlias = typeof rec.hostAlias === 'string' && rec.hostAlias.trim() ? rec.hostAlias.trim() : undefined;
	const expectOutputMatch = typeof rec.expectOutputMatch === 'string' && rec.expectOutputMatch.trim() ? rec.expectOutputMatch.trim() : undefined;
	const expectExitCode = typeof rec.expectExitCode === 'number' && Number.isInteger(rec.expectExitCode) && rec.expectExitCode >= 0
		? rec.expectExitCode
		: undefined;
	const timeoutMs = typeof rec.timeoutMs === 'number' && Number.isFinite(rec.timeoutMs) && rec.timeoutMs > 0
		? Math.max(1_000, Math.min(300_000, Math.round(rec.timeoutMs)))
		: undefined;
	const onFail = rec.onFail === 'bounce' || rec.onFail === 'fail' || rec.onFail === 'escalate' ? rec.onFail : undefined;
	const maxAutoRetries = typeof rec.maxAutoRetries === 'number' && Number.isInteger(rec.maxAutoRetries) && rec.maxAutoRetries >= 0
		? Math.min(5, rec.maxAutoRetries)
		: undefined;
	const enabled = typeof rec.enabled === 'boolean' ? rec.enabled : true;

	return {
		id,
		...(name ? { name } : {}),
		...(command ? { command } : {}),
		...(expectExitCode !== undefined ? { expectExitCode } : {}),
		...(cwd ? { cwd } : {}),
		...(hostAlias ? { hostAlias } : {}),
		...(expectFiles && expectFiles.length > 0 ? { expectFiles } : {}),
		...(expectOutputMatch ? { expectOutputMatch } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(onFail ? { onFail } : {}),
		...(maxAutoRetries !== undefined ? { maxAutoRetries } : {}),
		enabled,
		source: 'config',
	};
}

function buildTaskMermaidFromManifest(tasks: IAdeOrchestrationManifestTasks): string {
	const dir: MissionDagDirection = tasks.direction === 'TD' ? 'TD' : 'LR';
	const lines: string[] = [`flowchart ${dir}`];
	for (const node of tasks.nodes) {
		const lbl = escapeQuoted(node.title || node.id);
		if (node.kind === 'gate') {
			lines.push(`  ${node.id}{{"${lbl}"}}`);
		} else {
			lines.push(`  ${node.id}["${lbl}"]`);
		}
		const metaParts: string[] = [];
		if (node.ownerNodeId?.trim()) { metaParts.push(`owner=${formatTaskMetaValue(node.ownerNodeId.trim())}`); }
		if (node.assigneeNodeId?.trim()) { metaParts.push(`assignee=${formatTaskMetaValue(node.assigneeNodeId.trim())}`); }
		if (node.department?.trim()) { metaParts.push(`dept=${formatTaskMetaValue(node.department.trim())}`); }
		if (node.minCompleterTier !== undefined) { metaParts.push(`min_tier=${node.minCompleterTier}`); }
		if (node.allowedCompleterNodeIds && node.allowedCompleterNodeIds.length > 0) {
			metaParts.push(`completers=${formatTaskMetaValue(node.allowedCompleterNodeIds.join('|'))}`);
		}
		const taskColor = normalizeAdeNodeColor(node.color);
		if (taskColor) { metaParts.push(`color=${formatTaskMetaValue(taskColor)}`); }
		if (metaParts.length > 0) {
			lines.push(`  %% task ${node.id} [${metaParts.join(', ')}]`);
		}
	}
	for (const edge of tasks.edges ?? []) {
		const lbl = edge.label?.trim().replace(/\|/g, '/');
		const op = edge.kind === 'fail'
			? `-->|${lbl || 'fail'}|`
			: (lbl ? `-->|${lbl}|` : '-->');
		lines.push(`  ${edge.from} ${op} ${edge.to}`);
	}
	return lines.join('\n');
}

/**
 * Deterministically validates a raw JSON/JS orchestration manifest object.
 */
export function validateOrchestrationManifest(raw: unknown): IAdeOrchestrationManifestValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { valid: false, errors: ['Orchestration manifest must be a JSON object.'], warnings };
	}
	const obj = raw as Record<string, unknown>;
	const schemaVersion = obj.schemaVersion === undefined ? 1 : obj.schemaVersion;
	if (schemaVersion !== ADE_ORCHESTRATION_MANIFEST_SCHEMA_VERSION) {
		errors.push(`Unsupported schemaVersion "${String(schemaVersion)}" (expected ${ADE_ORCHESTRATION_MANIFEST_SCHEMA_VERSION}).`);
	}

	const direction: OrchestrationDirection | undefined = obj.direction === 'LR' || obj.direction === 'TD'
		? obj.direction
		: (obj.direction === undefined ? undefined : (errors.push(`Invalid direction "${String(obj.direction)}" (expected "LR" or "TD").`), undefined));
	const layoutMode: OrchestrationLayoutMode | undefined = obj.layoutMode === 'lr' || obj.layoutMode === 'td' || obj.layoutMode === 'radial' || obj.layoutMode === 'grid'
		? obj.layoutMode
		: (obj.layoutMode === undefined ? undefined : (errors.push(`Invalid layoutMode "${String(obj.layoutMode)}" (expected lr|td|radial|grid).`), undefined));

	const departments: IAdeOrchestrationManifestDepartment[] = [];
	if (obj.departments !== undefined) {
		if (!Array.isArray(obj.departments)) {
			errors.push('"departments" must be an array.');
		} else {
			obj.departments.forEach((d, idx) => {
				if (typeof d === 'string' && d.trim()) {
					departments.push({ name: d.trim() });
				} else if (d && typeof d === 'object' && typeof (d as Record<string, unknown>).name === 'string' && ((d as Record<string, unknown>).name as string).trim()) {
					const rec = d as Record<string, unknown>;
					departments.push({
						...(typeof rec.id === 'string' && rec.id.trim() ? { id: rec.id.trim() } : {}),
						name: (rec.name as string).trim(),
					});
				} else {
					errors.push(`departments[${idx}] must be a non-empty string or object with "name".`);
				}
			});
		}
	}

	const staff: IAdeOrchestrationManifestStaff[] = [];
	const staffIds = new Set<string>();
	const employeeKeys = new Set<string>();
	if (!Array.isArray(obj.staff) || obj.staff.length === 0) {
		errors.push('"staff" must be a non-empty array of staff definitions.');
	} else {
		obj.staff.forEach((entry, idx) => {
			if (!entry || typeof entry !== 'object') {
				errors.push(`staff[${idx}] must be an object.`);
				return;
			}
			const rec = entry as Record<string, unknown>;
			const id = typeof rec.id === 'string' ? rec.id.trim() : '';
			const name = typeof rec.name === 'string' ? rec.name.trim() : '';
			if (!id || !VALID_ID_RE.test(id)) {
				errors.push(`staff[${idx}].id "${id}" is invalid (must match ${VALID_ID_RE.source}).`);
				return;
			}
			if (staffIds.has(id)) {
				errors.push(`Duplicate staff id "${id}".`);
				return;
			}
			if (!name) {
				errors.push(`staff[${idx}].name is required for "${id}".`);
				return;
			}
			const empKey = name.toLowerCase().replace(/\s+/g, ' ');
			if (employeeKeys.has(empKey)) {
				errors.push(`Duplicate employee name "${name}" (each employee may appear at most once on the Orchestration canvas).`);
				return;
			}
			staffIds.add(id);
			employeeKeys.add(empKey);

			let tier: number | undefined;
			if (rec.tier !== undefined) {
				if (typeof rec.tier === 'number' && Number.isInteger(rec.tier) && rec.tier >= 0) {
					tier = rec.tier;
				} else {
					errors.push(`staff[${idx}].tier must be a non-negative integer.`);
				}
			}
			let allowedPaths: string[] | undefined;
			if (rec.allowedPaths !== undefined) {
				if (!Array.isArray(rec.allowedPaths)) {
					errors.push(`staff[${idx}].allowedPaths must be an array of strings.`);
				} else {
					allowedPaths = rec.allowedPaths
						.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
						.map(p => p.trim());
				}
			}
			let checks: IMissionNodeCheckHook[] | undefined;
			if (rec.checks !== undefined) {
				if (!Array.isArray(rec.checks)) {
					errors.push(`staff[${idx}].checks must be an array.`);
				} else {
					checks = rec.checks
						.map((c, cIdx) => sanitizeCheckHook(c, id, cIdx, errors, `staff[${idx}].checks`))
						.filter((c): c is IMissionNodeCheckHook => Boolean(c));
				}
			}

			staff.push({
				id,
				name,
				...(typeof rec.roleLabel === 'string' && rec.roleLabel.trim() ? { roleLabel: rec.roleLabel.trim() } : {}),
				...(tier !== undefined ? { tier } : {}),
				...(typeof rec.rankId === 'string' && rec.rankId.trim() ? { rankId: rec.rankId.trim() } : {}),
				...(typeof rec.department === 'string' && rec.department.trim() ? { department: rec.department.trim() } : {}),
				...(typeof rec.engineId === 'string' && rec.engineId.trim() ? { engineId: rec.engineId.trim() } : {}),
				...(typeof rec.model === 'string' && rec.model.trim() ? { model: rec.model.trim() } : {}),
				...(typeof rec.thinking === 'string' && rec.thinking.trim() ? { thinking: rec.thinking.trim() } : {}),
				...(typeof rec.hostAlias === 'string' && rec.hostAlias.trim() ? { hostAlias: rec.hostAlias.trim() } : {}),
				...(typeof rec.rolePrompt === 'string' && rec.rolePrompt.trim() ? { rolePrompt: rec.rolePrompt.trim() } : {}),
				...(allowedPaths && allowedPaths.length > 0 ? { allowedPaths } : {}),
				...(checks && checks.length > 0 ? { checks } : {}),
				...(typeof rec.color === 'string' && normalizeAdeNodeColor(rec.color) ? { color: normalizeAdeNodeColor(rec.color) } : {}),
			});
		});
	}

	const whiteboards: IAdeOrchestrationManifestWhiteboard[] = [];
	const allNodeIds = new Set<string>(staffIds);
	if (obj.whiteboards !== undefined) {
		if (!Array.isArray(obj.whiteboards)) {
			errors.push('"whiteboards" must be an array.');
		} else {
			obj.whiteboards.forEach((entry, idx) => {
				if (!entry || typeof entry !== 'object') {
					errors.push(`whiteboards[${idx}] must be an object.`);
					return;
				}
				const rec = entry as Record<string, unknown>;
				const id = typeof rec.id === 'string' ? rec.id.trim() : '';
				const title = typeof rec.title === 'string' ? rec.title.trim() : '';
				if (!id || !VALID_ID_RE.test(id)) {
					errors.push(`whiteboards[${idx}].id "${id}" is invalid.`);
					return;
				}
				if (allNodeIds.has(id)) {
					errors.push(`Duplicate node/whiteboard id "${id}".`);
					return;
				}
				allNodeIds.add(id);
				whiteboards.push({
					id,
					title: title || id,
					...(typeof rec.department === 'string' && rec.department.trim() ? { department: rec.department.trim() } : {}),
					...(typeof rec.content === 'string' ? { content: rec.content } : {}),
					...(typeof rec.version === 'number' && Number.isInteger(rec.version) && rec.version >= 0 ? { version: rec.version } : {}),
					...(typeof rec.color === 'string' && normalizeAdeNodeColor(rec.color) ? { color: normalizeAdeNodeColor(rec.color) } : {}),
				});
			});
		}
	}

	const edges: IAdeOrchestrationManifestEdge[] = [];
	if (obj.edges !== undefined) {
		if (!Array.isArray(obj.edges)) {
			errors.push('"edges" must be an array.');
		} else {
			obj.edges.forEach((entry, idx) => {
				if (!entry || typeof entry !== 'object') {
					errors.push(`edges[${idx}] must be an object.`);
					return;
				}
				const rec = entry as Record<string, unknown>;
				const from = typeof rec.from === 'string' ? rec.from.trim() : '';
				const to = typeof rec.to === 'string' ? rec.to.trim() : '';
				if (!from || !to) {
					errors.push(`edges[${idx}] requires both "from" and "to".`);
					return;
				}
				if (from === to) {
					errors.push(`edges[${idx}] self-loop "${from} -> ${to}" is forbidden.`);
					return;
				}
				if (!allNodeIds.has(from)) {
					errors.push(`edges[${idx}].from references unknown node "${from}".`);
					return;
				}
				if (!allNodeIds.has(to)) {
					errors.push(`edges[${idx}].to references unknown node "${to}".`);
					return;
				}
				edges.push({
					from,
					to,
					...(typeof rec.label === 'string' && rec.label.trim() ? { label: rec.label.trim() } : {}),
					...(rec.bidirectional === true ? { bidirectional: true } : {}),
					...(rec.dashed === true ? { dashed: true } : {}),
				});
			});
		}
	}

	let tasks: IAdeOrchestrationManifestTasks | undefined;
	if (obj.tasks !== undefined) {
		if (!obj.tasks || typeof obj.tasks !== 'object' || Array.isArray(obj.tasks)) {
			errors.push('"tasks" must be an object with "nodes" and optional "edges".');
		} else {
			const tObj = obj.tasks as Record<string, unknown>;
			const tDir: MissionDagDirection | undefined = tObj.direction === 'LR' || tObj.direction === 'TD' ? tObj.direction : undefined;
			const taskNodes: IAdeOrchestrationManifestTaskNode[] = [];
			const taskIds = new Set<string>();
			if (!Array.isArray(tObj.nodes)) {
				errors.push('"tasks.nodes" must be an array.');
			} else {
				tObj.nodes.forEach((entry, idx) => {
					if (!entry || typeof entry !== 'object') {
						errors.push(`tasks.nodes[${idx}] must be an object.`);
						return;
					}
					const rec = entry as Record<string, unknown>;
					const id = typeof rec.id === 'string' ? rec.id.trim() : '';
					const title = typeof rec.title === 'string' ? rec.title.trim() : '';
					if (!id || !VALID_ID_RE.test(id)) {
						errors.push(`tasks.nodes[${idx}].id "${id}" is invalid.`);
						return;
					}
					if (taskIds.has(id)) {
						errors.push(`Duplicate task node id "${id}".`);
						return;
					}
					taskIds.add(id);
					const ownerNodeId = typeof rec.ownerNodeId === 'string' && rec.ownerNodeId.trim() ? rec.ownerNodeId.trim() : undefined;
					const assigneeNodeId = typeof rec.assigneeNodeId === 'string' && rec.assigneeNodeId.trim() ? rec.assigneeNodeId.trim() : undefined;
					if (ownerNodeId && !staffIds.has(ownerNodeId)) {
						warnings.push(`tasks.nodes[${idx}].ownerNodeId "${ownerNodeId}" does not match any staff node in this manifest.`);
					}
					if (assigneeNodeId && !staffIds.has(assigneeNodeId)) {
						warnings.push(`tasks.nodes[${idx}].assigneeNodeId "${assigneeNodeId}" does not match any staff node in this manifest.`);
					}
					const allowedCompleterNodeIds = Array.isArray(rec.allowedCompleterNodeIds)
						? rec.allowedCompleterNodeIds.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map(s => s.trim())
						: undefined;
					const checks = Array.isArray(rec.checks)
						? rec.checks.map((c, cIdx) => sanitizeCheckHook(c, id, cIdx, errors, `tasks.nodes[${idx}].checks`)).filter((c): c is IMissionNodeCheckHook => Boolean(c))
						: undefined;
					taskNodes.push({
						id,
						title: title || id,
						...(typeof rec.description === 'string' && rec.description.trim() ? { description: rec.description.trim() } : {}),
						...(rec.kind === 'gate' ? { kind: 'gate' } : { kind: 'task' }),
						...(ownerNodeId ? { ownerNodeId } : {}),
						...(assigneeNodeId ? { assigneeNodeId } : {}),
						...(typeof rec.department === 'string' && rec.department.trim() ? { department: rec.department.trim() } : {}),
						...(typeof rec.minCompleterTier === 'number' && Number.isInteger(rec.minCompleterTier) && rec.minCompleterTier >= 0 ? { minCompleterTier: rec.minCompleterTier } : {}),
						...(allowedCompleterNodeIds && allowedCompleterNodeIds.length > 0 ? { allowedCompleterNodeIds } : {}),
						...(checks && checks.length > 0 ? { checks } : {}),
						...(typeof rec.color === 'string' && normalizeAdeNodeColor(rec.color) ? { color: normalizeAdeNodeColor(rec.color) } : {}),
					});
				});
			}

			const taskEdges: IAdeOrchestrationManifestTaskEdge[] = [];
			if (Array.isArray(tObj.edges)) {
				tObj.edges.forEach((entry, idx) => {
					if (!entry || typeof entry !== 'object') {
						errors.push(`tasks.edges[${idx}] must be an object.`);
						return;
					}
					const rec = entry as Record<string, unknown>;
					const from = typeof rec.from === 'string' ? rec.from.trim() : '';
					const to = typeof rec.to === 'string' ? rec.to.trim() : '';
					if (!from || !to) {
						errors.push(`tasks.edges[${idx}] requires "from" and "to".`);
						return;
					}
					if (!taskIds.has(from) || !taskIds.has(to)) {
						errors.push(`tasks.edges[${idx}] "${from} -> ${to}" references unknown task node(s).`);
						return;
					}
					taskEdges.push({
						from,
						to,
						...(typeof rec.label === 'string' && rec.label.trim() ? { label: rec.label.trim() } : {}),
						...(rec.kind === 'fail' ? { kind: 'fail' } : {}),
					});
				});
			}

			tasks = {
				...(tDir ? { direction: tDir } : {}),
				nodes: taskNodes,
				...(taskEdges.length > 0 ? { edges: taskEdges } : {}),
			};

			// Validate acyclicity of task DAG!
			if (taskNodes.length > 0) {
				const parsedDag = parseMissionMermaidDag(buildTaskMermaidFromManifest(tasks));
				if (parsedDag.error) {
					errors.push(`Mission Task DAG error: ${parsedDag.error}`);
				}
			}
		}
	}

	if (errors.length > 0) {
		return { valid: false, errors, warnings };
	}

	const manifest: IAdeOrchestrationManifest = {
		schemaVersion: 1,
		...(typeof obj.name === 'string' && obj.name.trim() ? { name: obj.name.trim() } : {}),
		...(typeof obj.description === 'string' && obj.description.trim() ? { description: obj.description.trim() } : {}),
		...(direction ? { direction } : {}),
		...(layoutMode ? { layoutMode } : {}),
		...(departments.length > 0 ? { departments } : {}),
		staff,
		...(whiteboards.length > 0 ? { whiteboards } : {}),
		...(edges.length > 0 ? { edges } : {}),
		...(tasks ? { tasks } : {}),
	};

	const compiled = compileOrchestrationManifest(manifest);
	if (compiled.parsedOrchestration.error) {
		errors.push(`Compiled Orchestration graph error: ${compiled.parsedOrchestration.error}`);
		return { valid: false, errors, warnings };
	}
	for (const adv of compiled.parsedOrchestration.advisories ?? []) {
		warnings.push(adv.message);
	}
	return { valid: true, errors: [], warnings, manifest };
}

/**
 * Compiles a validated structured manifest into canonical bijective Orchestration Mermaid code,
 * whiteboard records, optional Mission Task DAG Mermaid + descriptions, and check hooks.
 */
export function compileOrchestrationManifest(manifest: IAdeOrchestrationManifest): IAdeCompiledOrchestrationManifest {
	const nodes: IOrchestrationGraphNode[] = [];
	const staffChecks: Record<string, readonly IMissionNodeCheckHook[]> = {};

	for (const s of manifest.staff) {
		const tierSuffix = s.tier !== undefined ? ` (L${s.tier})` : '';
		const rolePart = s.roleLabel?.trim() ? ` · ${s.roleLabel.trim()}` : '';
		const label = `@${s.name}${rolePart}${tierSuffix}`;
		nodes.push({
			id: s.id,
			label,
			kind: 'staff',
			employeeName: s.name,
			...(s.tier !== undefined ? { tier: s.tier } : {}),
			...(s.rankId ? { rankId: s.rankId } : {}),
			...(s.department ? { department: s.department } : {}),
			...(s.engineId ? { engineId: s.engineId } : {}),
			...(s.model ? { model: s.model } : {}),
			...(s.thinking ? { thinking: s.thinking } : {}),
			...(s.hostAlias ? { hostAlias: s.hostAlias } : {}),
			...(s.rolePrompt ? { rolePrompt: s.rolePrompt } : {}),
			...(s.allowedPaths && s.allowedPaths.length > 0 ? { allowedPaths: s.allowedPaths } : {}),
			...(s.checks && s.checks.length > 0 ? { checks: s.checks } : {}),
			...(s.color ? { color: s.color } : {}),
		});
		if (s.checks && s.checks.length > 0) {
			staffChecks[s.id] = s.checks;
		}
	}

	const whiteboards: Record<string, { id: string; title: string; department: string; content: string; version: number }> = {};
	for (const wb of manifest.whiteboards ?? []) {
		const department = wb.department?.trim() || 'General';
		const content = wb.content ?? '';
		const version = wb.version ?? (content.length > 0 ? 1 : 0);
		whiteboards[wb.id] = {
			id: wb.id,
			title: wb.title || wb.id,
			department,
			content,
			version,
		};
		nodes.push({
			id: wb.id,
			label: wb.title || wb.id,
			kind: 'whiteboard',
			whiteboardId: wb.id,
			department,
			whiteboardContent: content,
			whiteboardVersion: version,
			...(wb.color ? { color: wb.color } : {}),
		});
	}

	const edges: IOrchestrationGraphEdge[] = [];
	const edgeKeys = new Set<string>();
	for (const e of manifest.edges ?? []) {
		const fwd = `${e.from}->${e.to}`;
		if (!edgeKeys.has(fwd)) {
			edgeKeys.add(fwd);
			edges.push({
				id: fwd,
				from: e.from,
				to: e.to,
				...(e.label ? { label: e.label } : {}),
				...(e.dashed ? { dashed: true } : {}),
				...(e.bidirectional ? { isBidirectional: true, reverseEdgeId: `${e.to}->${e.from}` } : {}),
			});
		}
		if (e.bidirectional) {
			const rev = `${e.to}->${e.from}`;
			if (!edgeKeys.has(rev)) {
				edgeKeys.add(rev);
				edges.push({
					id: rev,
					from: e.to,
					to: e.from,
					...(e.label ? { label: e.label } : {}),
					...(e.dashed ? { dashed: true } : {}),
					isBidirectional: true,
					reverseEdgeId: fwd,
				});
			}
		}
	}

	const departments: IOrchestrationDepartmentGroup[] = (manifest.departments ?? []).map(d => ({
		id: d.id?.trim() || d.name.trim().replace(/[^A-Za-z0-9_-]+/g, '_'),
		name: d.name.trim(),
		nodeIds: [],
		whiteboardIds: [],
	}));

	const orchestrationText = serializeOrchestrationGraph({
		direction: manifest.direction ?? 'TD',
		layoutMode: manifest.layoutMode,
		nodes,
		edges,
		departments,
		whiteboards,
	});
	const parsedOrchestration = parseOrchestrationGraph(orchestrationText);

	const nodePrompts: Record<string, string> = {};
	const nodeChecks: Record<string, readonly IMissionNodeCheckHook[]> = { ...staffChecks };
	let mermaidText: string | undefined;
	let parsedTasks: IMissionDagParseResult | undefined;

	if (manifest.tasks && manifest.tasks.nodes.length > 0) {
		mermaidText = buildTaskMermaidFromManifest(manifest.tasks);
		parsedTasks = parseMissionMermaidDag(mermaidText);
		for (const tn of manifest.tasks.nodes) {
			if (tn.description?.trim()) {
				nodePrompts[tn.id] = tn.description.trim();
			}
			if (tn.checks && tn.checks.length > 0) {
				nodeChecks[tn.id] = tn.checks;
			}
		}
	}

	return {
		orchestrationText,
		whiteboards,
		...(mermaidText ? { mermaidText } : {}),
		nodePrompts,
		nodeChecks,
		staffChecks,
		parsedOrchestration,
		...(parsedTasks ? { parsedTasks } : {}),
	};
}

/**
 * Exports a live Engineering workspace (Orchestration topology + whiteboards + optional Mission Task DAG)
 * into a clean, version-controllable `IAdeOrchestrationManifest` JSON object.
 */
export function exportToOrchestrationManifest(input: {
	readonly name?: string;
	readonly description?: string;
	readonly orchestrationText: string;
	readonly whiteboards?: Readonly<Record<string, {
		readonly id: string;
		readonly title: string;
		readonly department: string;
		readonly content: string;
		readonly version: number;
	}>>;
	readonly mermaidText?: string;
	readonly nodePrompts?: Readonly<Record<string, string>>;
	readonly nodeChecks?: Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
	readonly staffRuntimeMeta?: Readonly<Record<string, {
		readonly engineId?: string;
		readonly model?: string;
		readonly thinking?: string;
		readonly hostAlias?: string;
	}>>;
}): IAdeOrchestrationManifest {
	const parsedOrch = parseOrchestrationGraph(input.orchestrationText);
	const staff: IAdeOrchestrationManifestStaff[] = [];
	const whiteboards: IAdeOrchestrationManifestWhiteboard[] = [];
	const seenWbIds = new Set<string>();

	for (const node of parsedOrch.nodes) {
		if (node.kind === 'staff') {
			const rt = input.staffRuntimeMeta?.[node.id];
			const mergedChecks = input.nodeChecks?.[node.id] ?? node.checks;
			staff.push({
				id: node.id,
				name: node.employeeName || node.label || node.id,
				...(node.tier !== undefined ? { tier: node.tier } : {}),
				...(node.rankId ? { rankId: node.rankId } : {}),
				...(node.department ? { department: node.department } : {}),
				...(rt?.engineId ?? node.engineId ? { engineId: rt?.engineId ?? node.engineId } : {}),
				...(rt?.model ?? node.model ? { model: rt?.model ?? node.model } : {}),
				...(rt?.thinking ?? node.thinking ? { thinking: rt?.thinking ?? node.thinking } : {}),
				...(rt?.hostAlias ?? node.hostAlias ? { hostAlias: rt?.hostAlias ?? node.hostAlias } : {}),
				...(node.rolePrompt ? { rolePrompt: node.rolePrompt } : {}),
				...(node.allowedPaths && node.allowedPaths.length > 0 ? { allowedPaths: node.allowedPaths } : {}),
				...(mergedChecks && mergedChecks.length > 0 ? { checks: mergedChecks } : {}),
				...(node.color ? { color: node.color } : {}),
			});
		} else {
			const liveWb = input.whiteboards?.[node.id];
			seenWbIds.add(node.id);
			whiteboards.push({
				id: node.id,
				title: liveWb?.title || node.label || node.id,
				department: liveWb?.department || node.department || 'General',
				content: liveWb ? liveWb.content : (node.whiteboardContent ?? ''),
				version: liveWb?.version ?? node.whiteboardVersion ?? 0,
				...(node.color ? { color: node.color } : {}),
			});
		}
	}

	for (const [id, wb] of Object.entries(input.whiteboards ?? {})) {
		if (!seenWbIds.has(id)) {
			whiteboards.push({
				id: wb.id || id,
				title: wb.title || id,
				department: wb.department || 'General',
				content: wb.content,
				version: wb.version,
			});
		}
	}

	// Fold symmetric bidirectional pairs into single manifest edge with `bidirectional: true`
	const edgeMap = new Map<string, IOrchestrationGraphEdge>();
	for (const e of parsedOrch.edges) {
		edgeMap.set(`${e.from}->${e.to}`, e);
	}
	const emitted = new Set<string>();
	const edges: IAdeOrchestrationManifestEdge[] = [];
	for (const e of parsedOrch.edges) {
		const fwd = `${e.from}->${e.to}`;
		if (emitted.has(fwd)) {
			continue;
		}
		const rev = `${e.to}->${e.from}`;
		const revEdge = edgeMap.get(rev);
		const isSym = Boolean(revEdge && !emitted.has(rev) && (revEdge.label ?? '') === (e.label ?? '') && Boolean(revEdge.dashed) === Boolean(e.dashed));
		if (isSym) {
			emitted.add(fwd);
			emitted.add(rev);
			edges.push({
				from: e.from,
				to: e.to,
				...(e.label ? { label: e.label } : {}),
				bidirectional: true,
				...(e.dashed ? { dashed: true } : {}),
			});
		} else {
			emitted.add(fwd);
			edges.push({
				from: e.from,
				to: e.to,
				...(e.label ? { label: e.label } : {}),
				...(e.dashed ? { dashed: true } : {}),
			});
		}
	}

	const departments: IAdeOrchestrationManifestDepartment[] = parsedOrch.departments.map(d => ({
		id: d.id,
		name: d.name,
	}));

	let tasks: IAdeOrchestrationManifestTasks | undefined;
	if (input.mermaidText?.trim()) {
		const parsedTasks = parseMissionMermaidDag(input.mermaidText);
		if (!parsedTasks.error && parsedTasks.nodes.length > 0) {
			tasks = {
				direction: parsedTasks.direction,
				nodes: parsedTasks.nodes.map(n => ({
					id: n.id,
					title: n.label,
					...(input.nodePrompts?.[n.id]?.trim() ? { description: input.nodePrompts[n.id].trim() } : {}),
					...(n.kind === 'gate' ? { kind: 'gate' as const } : {}),
					...(n.ownerNodeId ? { ownerNodeId: n.ownerNodeId } : {}),
					...(n.assigneeNodeId ? { assigneeNodeId: n.assigneeNodeId } : {}),
					...(n.department ? { department: n.department } : {}),
					...(n.minCompleterTier !== undefined ? { minCompleterTier: n.minCompleterTier } : {}),
					...(n.allowedCompleterNodeIds && n.allowedCompleterNodeIds.length > 0 ? { allowedCompleterNodeIds: n.allowedCompleterNodeIds } : {}),
					...(input.nodeChecks?.[n.id]?.length || n.checks?.length ? { checks: input.nodeChecks?.[n.id] ?? n.checks } : {}),
					...(n.color ? { color: n.color } : {}),
				})),
				...(parsedTasks.edges.length > 0
					? {
						edges: parsedTasks.edges.map(e => ({
							from: e.from,
							to: e.to,
							...(e.label ? { label: e.label } : {}),
							...(e.edgeKind === 'fail' ? { kind: 'fail' as const } : {}),
						})),
					}
					: {}),
			};
		}
	}

	return {
		schemaVersion: 1,
		...(input.name ? { name: input.name } : {}),
		...(input.description ? { description: input.description } : {}),
		direction: parsedOrch.direction,
		...(parsedOrch.layoutMode ? { layoutMode: parsedOrch.layoutMode } : {}),
		...(departments.length > 0 ? { departments } : {}),
		staff,
		...(whiteboards.length > 0 ? { whiteboards } : {}),
		...(edges.length > 0 ? { edges } : {}),
		...(tasks ? { tasks } : {}),
	};
}
