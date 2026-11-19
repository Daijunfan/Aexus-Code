/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AdeThinkingLevel,
	AdeWorkspaceIsolationMode,
	AdeWorkTreeType,
	DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
	IAdeEngineeringBlueprint,
	IAdeEngineeringBlueprintEdge,
	IAdeEngineeringBlueprintNode,
} from './adeEngineering.js';
import {
	computeAutoLayoutPositions,
	normalizeBlueprintEngine,
	partitionEngineeringManagers,
} from './adeEngineeringBlueprint.js';

export type AdeBlueprintTemplatePreset = 'balanced' | 'max-quality' | 'fast-economy';

export interface IAdeBlueprintTemplatePreviewNode {
	readonly id: string;
	/** Normalized X coordinate in [0..100]. */
	readonly x: number;
	/** Normalized Y coordinate in [0..100]. */
	readonly y: number;
	readonly type: 'task' | 'user_gate';
}

export interface IAdeBlueprintTemplateSummary {
	readonly id: string;
	readonly name: string;
	readonly tagline: string;
	readonly category: string;
	readonly treeType: AdeWorkTreeType;
	readonly recommendedIsolation: AdeWorkspaceIsolationMode;
	readonly recommendedBudgetUsd: number;
	readonly nodeCount: number;
	readonly parallelBranches: number;
	readonly highlights: readonly string[];
	readonly previewNodes: readonly IAdeBlueprintTemplatePreviewNode[];
	readonly previewEdges: readonly { readonly from: string; readonly to: string }[];
}

interface ITemplateNodeBlueprint {
	readonly id: string;
	readonly title: string;
	readonly type: 'task' | 'user_gate';
	readonly critical: boolean;
	readonly roleKind?: 'architect' | 'builder' | 'reviewer' | 'verifier';
	readonly goal?: string;
	readonly acceptance?: string;
	readonly description?: string;
	readonly files?: readonly string[];
	readonly verify?: string;
}

interface IBlueprintTemplateDefinition extends IAdeBlueprintTemplateSummary {
	readonly maxConcurrency?: number;
	readonly defaultVerify?: string;
	readonly nodes: readonly ITemplateNodeBlueprint[];
	readonly edges: readonly IAdeEngineeringBlueprintEdge[];
}

const TEMPLATES: readonly IBlueprintTemplateDefinition[] = [
	{
		id: 'feature-ship',
		name: 'Full-Stack Feature Ship',
		tagline: 'Contract-first spec fan-out into isolated parallel worktrees, human release gate, and end-to-end integration.',
		category: 'Shipping',
		treeType: 'engineering',
		recommendedIsolation: 'worktree',
		recommendedBudgetUsd: 8,
		maxConcurrency: 3,
		defaultVerify: 'npm test',
		nodeCount: 6,
		parallelBranches: 3,
		highlights: ['3 parallel Git Worktree lanes', 'Adversarial L3 review per pod', 'Human Release Gate before merge'],
		previewNodes: [
			{ id: 'N1', x: 12, y: 50, type: 'task' },
			{ id: 'N2', x: 42, y: 18, type: 'task' },
			{ id: 'N3', x: 42, y: 50, type: 'task' },
			{ id: 'N4', x: 42, y: 82, type: 'task' },
			{ id: 'U1', x: 70, y: 50, type: 'user_gate' },
			{ id: 'N5', x: 90, y: 50, type: 'task' },
		],
		previewEdges: [
			{ from: 'N1', to: 'N2' },
			{ from: 'N1', to: 'N3' },
			{ from: 'N1', to: 'N4' },
			{ from: 'N2', to: 'U1' },
			{ from: 'N3', to: 'U1' },
			{ from: 'N4', to: 'U1' },
			{ from: 'U1', to: 'N5' },
		],
		nodes: [
			{
				id: 'N1',
				title: 'Interface & Data Contract',
				type: 'task',
				critical: true,
				roleKind: 'architect',
				files: ['src/contracts/**', 'src/types/**'],
				verify: 'npm run typecheck',
				goal: 'Define shared TypeScript/API schemas, interface contracts, and file-ownership boundaries so parallel tracks execute with zero merge conflicts.',
				acceptance: '1. Public types and contracts compile cleanly with zero warnings;\n2. Downstream file ownership boundaries are explicitly documented.',
			},
			{
				id: 'N2',
				title: 'Core Backend & Services',
				type: 'task',
				critical: true,
				roleKind: 'builder',
				files: ['src/services/**', 'src/server/**'],
				verify: 'npm test -- services',
				goal: 'Implement business logic, persistence, and error handling strictly adhering to the N1 contract.',
				acceptance: '1. Core service unit tests pass with edge-case coverage;\n2. No unintended edits outside backend module boundaries.',
			},
			{
				id: 'N3',
				title: 'UI & Interactive Surface',
				type: 'task',
				critical: false,
				roleKind: 'builder',
				files: ['src/ui/**', 'src/components/**'],
				verify: 'npm run build',
				goal: 'Build responsive dark/light/high-contrast UI components wired to the N1 interface contract with keyboard accessibility.',
				acceptance: '1. UI renders cleanly without overflow or clipping;\n2. Keyboard navigation and focus states work end-to-end.',
			},
			{
				id: 'N4',
				title: 'Automated Test & Regression Suite',
				type: 'task',
				critical: false,
				roleKind: 'verifier',
				files: ['test/**', 'tests/**'],
				verify: 'npm test',
				goal: 'Author comprehensive unit and integration tests covering happy paths, concurrency, and failure recovery.',
				acceptance: '1. New tests run deterministically with zero flakiness;\n2. Both positive and failure paths are asserted.',
			},
			{
				id: 'U1',
				title: 'Release Readiness Gate',
				type: 'user_gate',
				critical: true,
				description: 'Review all 3 upstream Employee acceptance reports & worktree diffs before final integration and merge.',
			},
			{
				id: 'N5',
				title: 'Integration & Smoke Verification',
				type: 'task',
				critical: true,
				roleKind: 'verifier',
				files: ['src/**', 'test/**'],
				verify: 'npm run lint && npm test',
				goal: 'Verify cross-track integration after merge, run full typecheck, lint, and smoke tests, and summarize release readiness.',
				acceptance: '1. Full build, lint, and test suite pass with zero errors;\n2. Release summary documents verified behavior and metrics.',
			},
		],
		edges: [
			{ from: 'N1', to: 'N2' },
			{ from: 'N1', to: 'N3' },
			{ from: 'N1', to: 'N4' },
			{ from: 'N2', to: 'U1' },
			{ from: 'N3', to: 'U1' },
			{ from: 'N4', to: 'U1' },
			{ from: 'U1', to: 'N5' },
		],
	},
	{
		id: 'bug-hunt-fix',
		name: 'Surgical Bug Hunt & Regression Fix',
		tagline: 'Reproduce deterministically first, then fan out surgical fix + regression tests before final safety sign-off.',
		category: 'Debugging',
		treeType: 'engineering',
		recommendedIsolation: 'shared',
		recommendedBudgetUsd: 4,
		maxConcurrency: 2,
		defaultVerify: 'npm test',
		nodeCount: 5,
		parallelBranches: 2,
		highlights: ['Repro-first root-cause discipline', 'Parallel fix & regression harness', 'Side-effect & perf audit'],
		previewNodes: [
			{ id: 'N1', x: 12, y: 50, type: 'task' },
			{ id: 'N2', x: 42, y: 26, type: 'task' },
			{ id: 'N3', x: 42, y: 74, type: 'task' },
			{ id: 'N4', x: 68, y: 50, type: 'task' },
			{ id: 'U1', x: 90, y: 50, type: 'user_gate' },
		],
		previewEdges: [
			{ from: 'N1', to: 'N2' },
			{ from: 'N1', to: 'N3' },
			{ from: 'N2', to: 'N4' },
			{ from: 'N3', to: 'N4' },
			{ from: 'N4', to: 'U1' },
		],
		nodes: [
			{
				id: 'N1',
				title: 'Root-Cause & Minimal Repro',
				type: 'task',
				critical: true,
				roleKind: 'architect',
				files: ['test/repro/**'],
				verify: 'npm run typecheck',
				goal: 'Isolate the exact failing code path, prove root cause with a minimal failing reproduction test, and document fix scope.',
				acceptance: '1. Minimal repro deterministically demonstrates the failure;\n2. Root cause cites exact file paths and state transitions.',
			},
			{
				id: 'N2',
				title: 'Surgical Implementation Fix',
				type: 'task',
				critical: true,
				roleKind: 'builder',
				files: ['src/**'],
				verify: 'npm test',
				goal: 'Apply the cleanest minimal fix for the confirmed root cause without refactoring unrelated modules.',
				acceptance: '1. The N1 reproduction passes cleanly;\n2. Diff is minimal, idiomatic, and free of lint/type regressions.',
			},
			{
				id: 'N3',
				title: 'Edge-Case Regression Suite',
				type: 'task',
				critical: false,
				roleKind: 'verifier',
				files: ['test/regression/**'],
				verify: 'npm test',
				goal: 'Add targeted unit/integration tests covering boundary conditions and adjacent sibling paths to prevent regressions.',
				acceptance: '1. Regression tests fail before N2 and pass after N2;\n2. Full module test suite runs cleanly.',
			},
			{
				id: 'N4',
				title: 'Side-Effect & Performance Audit',
				type: 'task',
				critical: true,
				roleKind: 'reviewer',
				files: ['src/**', 'test/**'],
				verify: 'npm run lint && npm test',
				goal: 'Audit the combined diff for memory leaks, race conditions, error handling, and performance impact.',
				acceptance: '1. Zero unhandled rejections, leaks, or performance regressions;\n2. Build and test checks verified end-to-end.',
			},
			{
				id: 'U1',
				title: 'Merge Sign-Off Gate',
				type: 'user_gate',
				critical: true,
				description: 'Inspect root-cause evidence, surgical diff, and audit report before shipping.',
			},
		],
		edges: [
			{ from: 'N1', to: 'N2' },
			{ from: 'N1', to: 'N3' },
			{ from: 'N2', to: 'N4' },
			{ from: 'N3', to: 'N4' },
			{ from: 'N4', to: 'U1' },
		],
	},
	{
		id: 'security-audit-swarm',
		name: 'Multi-Engine Security Audit Swarm',
		tagline: 'Three parallel specialist security auditors converge into hardened patches and an executive sign-off gate.',
		category: 'Security',
		treeType: 'engineering',
		recommendedIsolation: 'worktree',
		recommendedBudgetUsd: 6,
		maxConcurrency: 3,
		defaultVerify: 'npm test',
		nodeCount: 6,
		parallelBranches: 3,
		highlights: ['3 parallel threat-model tracks', 'Cross-engine blind-spot reduction', 'Directed rollback per audit lane'],
		previewNodes: [
			{ id: 'N1', x: 16, y: 18, type: 'task' },
			{ id: 'N2', x: 16, y: 50, type: 'task' },
			{ id: 'N3', x: 16, y: 82, type: 'task' },
			{ id: 'N4', x: 50, y: 50, type: 'task' },
			{ id: 'U1', x: 74, y: 50, type: 'user_gate' },
			{ id: 'N5', x: 92, y: 50, type: 'task' },
		],
		previewEdges: [
			{ from: 'N1', to: 'N4' },
			{ from: 'N2', to: 'N4' },
			{ from: 'N3', to: 'N4' },
			{ from: 'N4', to: 'U1' },
			{ from: 'U1', to: 'N5' },
		],
		nodes: [
			{
				id: 'N1',
				title: 'Auth, Permissions & Secrets Audit',
				type: 'task',
				critical: true,
				roleKind: 'reviewer',
				files: ['docs/audit/auth/**'],
				verify: 'git status --short',
				goal: 'Audit authentication flows, token storage, file permissions (0600), privilege boundaries, and secret leakage vectors.',
				acceptance: '1. Every finding includes exact file:line, severity, and exploit path;\n2. Zero hardcoded credentials or unguarded endpoints missed.',
			},
			{
				id: 'N2',
				title: 'Injection, Path Traversal & IPC Audit',
				type: 'task',
				critical: true,
				roleKind: 'reviewer',
				files: ['docs/audit/ipc/**'],
				verify: 'git status --short',
				goal: 'Inspect shell spawning, SQL/command injection, path traversal, deserialization, and IPC/socket input sanitization.',
				acceptance: '1. All untrusted inputs traced from boundary to sink;\n2. Concrete remediation patches proposed for every Medium+ issue.',
			},
			{
				id: 'N3',
				title: 'Supply-Chain & Runtime Surface Audit',
				type: 'task',
				critical: false,
				roleKind: 'reviewer',
				files: ['docs/audit/supply-chain/**'],
				verify: 'git status --short',
				goal: 'Review dependencies, sandbox flags, CSP/webview boundaries, and error/log redaction across platforms.',
				acceptance: '1. Dependency and sandbox posture summarized clearly;\n2. Actionable hardening recommendations prioritized by risk.',
			},
			{
				id: 'N4',
				title: 'Consolidated Hardening & Patches',
				type: 'task',
				critical: true,
				roleKind: 'builder',
				files: ['src/**', 'test/security/**'],
				verify: 'npm test',
				goal: 'Synthesize findings from N1–N3, apply minimal security patches, and add security regression tests for each resolved vulnerability.',
				acceptance: '1. Every High/Critical finding patched and covered by automated tests;\n2. Zero regressions to existing functionality.',
			},
			{
				id: 'U1',
				title: 'Security Officer Approval Gate',
				type: 'user_gate',
				critical: true,
				description: 'Review consolidated vulnerability findings, patches, and residual risk notes before final verification.',
			},
			{
				id: 'N5',
				title: 'Final Security Verification & Report',
				type: 'task',
				critical: true,
				roleKind: 'verifier',
				files: ['docs/audit/**', 'test/**'],
				verify: 'npm run lint && npm test',
				goal: 'Re-run security checks, static analysis, and full test suite, then publish a clean PR-ready security sign-off report.',
				acceptance: '1. All security and regression checks pass;\n2. Final report cleanly maps findings to verified fixes.',
			},
		],
		edges: [
			{ from: 'N1', to: 'N4' },
			{ from: 'N2', to: 'N4' },
			{ from: 'N3', to: 'N4' },
			{ from: 'N4', to: 'U1' },
			{ from: 'U1', to: 'N5' },
		],
	},
	{
		id: 'safe-migration',
		name: 'Zero-Downtime Refactor & Migration',
		tagline: 'Freeze behavior with baseline tests, migrate core + call sites in parallel worktrees, gate diffs, then cut over.',
		category: 'Refactoring',
		treeType: 'engineering',
		recommendedIsolation: 'worktree',
		recommendedBudgetUsd: 7,
		maxConcurrency: 2,
		defaultVerify: 'npm test',
		nodeCount: 5,
		parallelBranches: 2,
		highlights: ['Baseline characterization tests', 'Parallel worktree module cutover', 'Safe rollback checkpoint'],
		previewNodes: [
			{ id: 'N1', x: 12, y: 50, type: 'task' },
			{ id: 'N2', x: 40, y: 26, type: 'task' },
			{ id: 'N3', x: 40, y: 74, type: 'task' },
			{ id: 'U1', x: 68, y: 50, type: 'user_gate' },
			{ id: 'N4', x: 90, y: 50, type: 'task' },
		],
		previewEdges: [
			{ from: 'N1', to: 'N2' },
			{ from: 'N1', to: 'N3' },
			{ from: 'N2', to: 'U1' },
			{ from: 'N3', to: 'U1' },
			{ from: 'U1', to: 'N4' },
		],
		nodes: [
			{
				id: 'N1',
				title: 'Baseline Tests & Compatibility Shim',
				type: 'task',
				critical: true,
				roleKind: 'architect',
				files: ['src/compat/**', 'test/baseline/**'],
				verify: 'npm test',
				goal: 'Lock existing behavior with characterization tests and introduce clean adapter shims for incremental cutover.',
				acceptance: '1. Baseline tests pass before any refactoring begins;\n2. Compatibility adapter compiles cleanly.',
			},
			{
				id: 'N2',
				title: 'Core Architecture Migration',
				type: 'task',
				critical: true,
				roleKind: 'builder',
				files: ['src/core/**'],
				verify: 'npm test',
				goal: 'Implement the target refactored core behind the N1 adapter boundary with strict typing and unit tests.',
				acceptance: '1. New implementation passes all baseline + new unit tests;\n2. Zero breaking public API changes.',
			},
			{
				id: 'N3',
				title: 'Caller Sites & Config Migration',
				type: 'task',
				critical: false,
				roleKind: 'builder',
				files: ['src/callers/**', 'config/**'],
				verify: 'npm run typecheck',
				goal: 'Update downstream call sites, configuration bindings, and documentation to target the refactored interfaces.',
				acceptance: '1. Zero deprecated references remaining in active modules;\n2. Static typecheck passes cleanly.',
			},
			{
				id: 'U1',
				title: 'Diff & Rollback Verification Gate',
				type: 'user_gate',
				critical: true,
				description: 'Audit migration diffs and confirm rollback path before removing legacy compatibility shims.',
			},
			{
				id: 'N4',
				title: 'Cutover & Legacy Cleanup',
				type: 'task',
				critical: true,
				roleKind: 'verifier',
				files: ['src/**', 'test/**'],
				verify: 'npm run lint && npm test',
				goal: 'Remove obsolete shims, run full regression/build suite, and confirm zero dead code or orphaned imports.',
				acceptance: '1. Full build and test suite green with zero warnings;\n2. Legacy code cleanly removed.',
			},
		],
		edges: [
			{ from: 'N1', to: 'N2' },
			{ from: 'N1', to: 'N3' },
			{ from: 'N2', to: 'U1' },
			{ from: 'N3', to: 'U1' },
			{ from: 'U1', to: 'N4' },
		],
	},
	{
		id: 'deep-research-lab',
		name: 'Deep Research & Benchmark Lab',
		tagline: 'Multi-track literature synthesis, parallel hypothesis ablations, quantitative benchmarks, and peer-reviewed synthesis.',
		category: 'Research',
		treeType: 'research',
		recommendedIsolation: 'shared',
		recommendedBudgetUsd: 6,
		maxConcurrency: 3,
		defaultVerify: 'git status --short',
		nodeCount: 6,
		parallelBranches: 3,
		highlights: ['3 parallel hypothesis tracks', 'Peer-reviewed Employee L3 audits', 'Reproducible benchmark synthesis'],
		previewNodes: [
			{ id: 'R1', x: 12, y: 50, type: 'task' },
			{ id: 'R2', x: 42, y: 18, type: 'task' },
			{ id: 'R3', x: 42, y: 50, type: 'task' },
			{ id: 'R4', x: 42, y: 82, type: 'task' },
			{ id: 'U1', x: 70, y: 50, type: 'user_gate' },
			{ id: 'R5', x: 90, y: 50, type: 'task' },
		],
		previewEdges: [
			{ from: 'R1', to: 'R2' },
			{ from: 'R1', to: 'R3' },
			{ from: 'R1', to: 'R4' },
			{ from: 'R2', to: 'U1' },
			{ from: 'R3', to: 'U1' },
			{ from: 'R4', to: 'U1' },
			{ from: 'U1', to: 'R5' },
		],
		nodes: [
			{
				id: 'R1',
				title: 'Problem Framing & Prior Art',
				type: 'task',
				critical: true,
				roleKind: 'architect',
				files: ['research/framing/**'],
				verify: 'test -d research',
				goal: 'Survey primary sources, prior benchmarks, and open failure modes; establish explicit hypotheses and evaluation metrics.',
				acceptance: '1. All claims cite primary sources or exact codebase evidence;\n2. Falsifiable hypotheses and quantitative metrics are defined.',
			},
			{
				id: 'R2',
				title: 'Hypothesis Track A · Mechanism Probe',
				type: 'task',
				critical: true,
				roleKind: 'builder',
				files: ['research/track-a/**'],
				verify: 'test -d research/track-a',
				goal: 'Investigate primary hypothesis A via controlled prototype or analytical proof and record quantitative observations.',
				acceptance: '1. Controlled experiment / analysis is reproducible;\n2. Limitations and confounding variables are explicitly reported.',
			},
			{
				id: 'R3',
				title: 'Hypothesis Track B · Counter-Baseline',
				type: 'task',
				critical: false,
				roleKind: 'builder',
				files: ['research/track-b/**'],
				verify: 'test -d research/track-b',
				goal: 'Evaluate competing approach B under identical constraints to prevent confirmation bias.',
				acceptance: '1. Apples-to-apples comparison against identical baseline;\n2. Clear failure cases and trade-offs documented.',
			},
			{
				id: 'R4',
				title: 'Quantitative Benchmark Harness',
				type: 'task',
				critical: false,
				roleKind: 'verifier',
				files: ['research/benchmarks/**'],
				verify: 'test -d research/benchmarks',
				goal: 'Build and run a repeatable benchmark measuring latency, throughput, accuracy, and token/resource cost.',
				acceptance: '1. Raw benchmark numbers & variance recorded;\n2. Script executes cleanly from a single command.',
			},
			{
				id: 'U1',
				title: 'Methodology Peer Gate',
				type: 'user_gate',
				critical: true,
				description: 'Audit experimental methodology, statistical rigor, and upstream peer reports before writing final conclusions.',
			},
			{
				id: 'R5',
				title: 'Final Synthesis & Decision Brief',
				type: 'task',
				critical: true,
				roleKind: 'architect',
				files: ['research/report/**'],
				verify: 'test -d research/report',
				goal: 'Synthesize verified findings into an actionable technical report with recommendation matrix, charts/tables, and next steps.',
				acceptance: '1. Every conclusion traces directly to verified upstream evidence;\n2. Executive summary and concrete recommendations are crystal clear.',
			},
		],
		edges: [
			{ from: 'R1', to: 'R2' },
			{ from: 'R1', to: 'R3' },
			{ from: 'R1', to: 'R4' },
			{ from: 'R2', to: 'U1' },
			{ from: 'R3', to: 'U1' },
			{ from: 'R4', to: 'U1' },
			{ from: 'U1', to: 'R5' },
		],
	},
	{
		id: 'arch-teardown',
		name: 'Architecture Teardown & RFC',
		tagline: 'Map system surfaces, run parallel systems + UX teardowns, and converge into a decision-ready engineering RFC.',
		category: 'Strategy',
		treeType: 'research',
		recommendedIsolation: 'shared',
		recommendedBudgetUsd: 5,
		maxConcurrency: 2,
		defaultVerify: 'git status --short',
		nodeCount: 5,
		parallelBranches: 2,
		highlights: ['Systems & UX parallel analysis', 'Evidence-backed trade-off matrix', 'Actionable RFC blueprint'],
		previewNodes: [
			{ id: 'R1', x: 12, y: 50, type: 'task' },
			{ id: 'R2', x: 40, y: 26, type: 'task' },
			{ id: 'R3', x: 40, y: 74, type: 'task' },
			{ id: 'R4', x: 68, y: 50, type: 'task' },
			{ id: 'U1', x: 90, y: 50, type: 'user_gate' },
		],
		previewEdges: [
			{ from: 'R1', to: 'R2' },
			{ from: 'R1', to: 'R3' },
			{ from: 'R2', to: 'R4' },
			{ from: 'R3', to: 'R4' },
			{ from: 'R4', to: 'U1' },
		],
		nodes: [
			{
				id: 'R1',
				title: 'System & API Surface Inventory',
				type: 'task',
				critical: true,
				roleKind: 'architect',
				files: ['docs/rfc/inventory/**'],
				verify: 'test -d docs/rfc',
				goal: 'Map module architecture, IPC/RPC boundaries, state ownership, and external extension points with concrete file references.',
				acceptance: '1. Architecture diagram matches actual code;\n2. All major bottlenecks and invariants identified.',
			},
			{
				id: 'R2',
				title: 'Concurrency, Scale & Failure Analysis',
				type: 'task',
				critical: true,
				roleKind: 'reviewer',
				files: ['docs/rfc/systems/**'],
				verify: 'test -d docs/rfc/systems',
				goal: 'Analyze scalability limits, failure domains, latency hot paths, and cross-platform edge cases.',
				acceptance: '1. Concrete failure modes and complexity bounds documented;\n2. Ranked mitigation options provided.',
			},
			{
				id: 'R3',
				title: 'Developer Experience & UX Teardown',
				type: 'task',
				critical: false,
				roleKind: 'reviewer',
				files: ['docs/rfc/ux/**'],
				verify: 'test -d docs/rfc/ux',
				goal: 'Evaluate onboarding friction, workflow ergonomics, visual clarity, and competitive differentiation.',
				acceptance: '1. Friction points prioritized by user impact;\n2. Concrete UX improvements specified.',
			},
			{
				id: 'R4',
				title: 'Trade-Off Matrix & Engineering RFC',
				type: 'task',
				critical: true,
				roleKind: 'architect',
				files: ['docs/rfc/RFC.md'],
				verify: 'test -f docs/rfc/RFC.md',
				goal: 'Compile R1–R3 into a concise Engineering RFC with decision matrix, rollout phases, and measurable success metrics.',
				acceptance: '1. RFC addresses alternatives, risks, and migration strategy;\n2. Ready for team review and Engineering DAG execution.',
			},
			{
				id: 'U1',
				title: 'Architecture Review Gate',
				type: 'user_gate',
				critical: true,
				description: 'Approve the final RFC or roll back a track for deeper analysis.',
			},
		],
		edges: [
			{ from: 'R1', to: 'R2' },
			{ from: 'R1', to: 'R3' },
			{ from: 'R2', to: 'R4' },
			{ from: 'R3', to: 'R4' },
			{ from: 'R4', to: 'U1' },
		],
	},
];

export function listBlueprintTemplates(treeType?: AdeWorkTreeType): readonly IAdeBlueprintTemplateSummary[] {
	const items = treeType ? TEMPLATES.filter(t => t.treeType === treeType) : TEMPLATES;
	return items.map(({ nodes: _n, edges: _e, maxConcurrency: _mc, defaultVerify: _dv, ...summary }) => summary);
}

export function getBlueprintTemplate(templateId: string): IAdeBlueprintTemplateSummary | undefined {
	const found = TEMPLATES.find(t => t.id === templateId);
	if (!found) {
		return undefined;
	}
	const { nodes: _n, edges: _e, maxConcurrency: _mc, defaultVerify: _dv, ...summary } = found;
	return summary;
}

export interface IBuildBlueprintFromTemplateOptions {
	readonly governorSessionId: string;
	readonly defaultEngine?: string;
	readonly secondaryEngine?: string;
	readonly treeType?: AdeWorkTreeType;
	readonly preset?: AdeBlueprintTemplatePreset;
	readonly workspaceIsolation?: AdeWorkspaceIsolationMode;
	readonly maxBudgetUsd?: number;
}

export function buildBlueprintFromTemplate(
	templateId: string,
	options: IBuildBlueprintFromTemplateOptions,
): IAdeEngineeringBlueprint {
	const tpl = TEMPLATES.find(t => t.id === templateId);
	if (!tpl) {
		throw new Error(`Unknown blueprint template "${templateId}". Available: ${TEMPLATES.map(t => t.id).join(', ')}`);
	}
	const primary = normalizeBlueprintEngine(options.defaultEngine, 'claude-code');
	const secondary = options.secondaryEngine ? normalizeBlueprintEngine(options.secondaryEngine, primary) : primary;
	const preset: AdeBlueprintTemplatePreset = options.preset ?? 'balanced';
	const treeType: AdeWorkTreeType = options.treeType ?? tpl.treeType;
	const workspaceIsolation: AdeWorkspaceIsolationMode = options.workspaceIsolation ?? tpl.recommendedIsolation;

	const pickThinking = (role: 'worker' | 'employee' | 'manager', critical: boolean): AdeThinkingLevel => {
		if (preset === 'fast-economy') {
			return role === 'worker' && critical ? 'medium' : 'low';
		}
		if (preset === 'max-quality') {
			return role === 'worker' && critical ? 'max' : 'high';
		}
		// balanced
		if (role === 'worker') {
			return critical ? 'high' : 'medium';
		}
		if (role === 'manager') {
			return 'medium';
		}
		return 'medium';
	};

	const pickEngine = (role: 'worker' | 'employee', roleKind?: ITemplateNodeBlueprint['roleKind']): string => {
		if (preset === 'balanced' && secondary !== primary && role === 'worker' && (roleKind === 'builder' || roleKind === 'verifier')) {
			return secondary;
		}
		return primary;
	};

	const rawNodes: IAdeEngineeringBlueprintNode[] = tpl.nodes.map(n => {
		if (n.type === 'user_gate') {
			return {
				id: n.id,
				title: n.title,
				type: 'user_gate',
				critical: n.critical,
				description: n.description ?? '',
			};
		}
		return {
			id: n.id,
			title: n.title,
			type: 'task',
			critical: n.critical,
			employee: { engine: pickEngine('employee', n.roleKind), thinking: pickThinking('employee', n.critical) },
			worker: { engine: pickEngine('worker', n.roleKind), thinking: pickThinking('worker', n.critical) },
			goal: n.goal ?? '',
			acceptance: n.acceptance ?? '',
			...(n.files && n.files.length > 0 ? { files: [...n.files] } : {}),
			...(n.verify ? { verify: n.verify } : {}),
		};
	});

	const edges = tpl.edges.map(e => ({ ...e }));
	const budgetUsd = options.maxBudgetUsd !== undefined
		? (options.maxBudgetUsd > 0 ? options.maxBudgetUsd : undefined)
		: (preset === 'fast-economy' ? Math.min(2, tpl.recommendedBudgetUsd) : undefined);

	const metadata = {
		treeType,
		governorSessionId: options.governorSessionId,
		workspaceIsolation,
		watchdogTimeoutMinutes: DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
		flowDirection: 'LR' as const,
		...(tpl.maxConcurrency !== undefined ? { maxConcurrency: tpl.maxConcurrency } : {}),
		...(tpl.defaultVerify ? { verify: tpl.defaultVerify } : {}),
		...(budgetUsd !== undefined ? { maxBudgetUsd: budgetUsd } : {}),
	};

	const posMap = computeAutoLayoutPositions({ nodes: rawNodes, edges, metadata });
	const nodes = rawNodes.map(n => ({
		...n,
		position: posMap.get(n.id) ?? { x: 204, y: 260 },
	}));

	const managers = partitionEngineeringManagers(nodes, edges, [], primary).map(seg => ({
		...seg,
		config: {
			...seg.config,
			engine: primary,
			thinking: pickThinking('manager', true),
		},
	}));

	return {
		metadata,
		managers,
		nodes,
		edges,
	};
}
