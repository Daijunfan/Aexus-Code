/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { estimateTextTokens } from './adeEngineering.js';

/** VS Code user/workspace setting key storing the customizable ADE organization, ranks, prompts, and primitive API grants. */
export const ADE_ORGANIZATION_CONFIG_KEY = 'aexus.ade.organization';

/** Fixed, immutable core primitive APIs provided by Aexus-Code and enforced at the ADE control kernel boundary. */
export type AdePrimitiveApiId =
	| 'session.read_context'
	| 'session.message'
	| 'session.manage'
	| 'project.read'
	| 'project.manage'
	| 'host.access'
	| 'inbox.post'
	| 'engineering.read'
	| 'engineering.design'
	| 'engineering.review'
	| 'engineering.integrate'
	| 'engineering.destroy'
	| 'engineering.control';

/** Structural operational slots used by Engineering & Research DAG work-trees across arbitrary N-tier organizations. */
export type AdeWorkTreeSlot = 'orchestrator' | 'segment_owner' | 'reviewer' | 'executor';

export const ADE_WORK_TREE_SLOTS: readonly AdeWorkTreeSlot[] = ['orchestrator', 'segment_owner', 'reviewer', 'executor'];

export type IAdeWorkTreeSlotMap = Readonly<Partial<Record<AdeWorkTreeSlot, string>>>;

export type AdePrimitiveApiCategory = 'messaging' | 'hierarchy' | 'workspace' | 'engineering';

export type AdeRankColorToken = 'amber' | 'indigo' | 'purple' | 'emerald' | 'cyan' | 'rose' | 'slate';

export type AdeRankIconToken =
	| 'organization'
	| 'briefcase'
	| 'shield'
	| 'tools'
	| 'beaker'
	| 'law'
	| 'rocket'
	| 'eye'
	| 'person'
	| 'star-full'
	| 'terminal'
	| 'sparkle';

export const ADE_RANK_COLOR_TOKENS: readonly AdeRankColorToken[] = ['amber', 'indigo', 'purple', 'emerald', 'cyan', 'rose', 'slate'];

export const ADE_RANK_ICON_TOKENS: readonly AdeRankIconToken[] = [
	'organization',
	'briefcase',
	'shield',
	'tools',
	'beaker',
	'law',
	'rocket',
	'eye',
	'person',
	'star-full',
	'terminal',
	'sparkle',
];

export interface IAdePromptApiRenderContext {
	readonly agentId: string;
	readonly isWorkTree: boolean;
	readonly treeGovernorId?: string;
	readonly treeSegmentId?: string;
	readonly treeNodeId?: string;
	readonly rankId: string;
	readonly workTreeSlot?: AdeWorkTreeSlot;
}

export interface IAdePrimitiveApiSpec {
	readonly id: AdePrimitiveApiId;
	readonly category: AdePrimitiveApiCategory;
	readonly label: string;
	readonly description: string;
	readonly actions: readonly string[];
	readonly dangerous?: boolean;
	/** Renders concise, cache-stable `aexus-ade` CLI instructions for this primitive API. */
	readonly renderCliLines: (ctx: IAdePromptApiRenderContext) => readonly string[];
}

export const ADE_PRIMITIVE_APIS: readonly IAdePrimitiveApiSpec[] = [
	{
		id: 'session.read_context',
		category: 'messaging',
		label: 'Read Sessions & Context',
		description: 'Inspect session metadata, subordinate hierarchy trees, conversation histories, and active org schema.',
		actions: [
			'status',
			'session.list',
			'session.info',
			'session.get',
			'session.subordinates',
			'session.children',
			'session.tree',
			'session.subtree',
			'session.history',
			'role.schema.get',
			'role.apis',
			'role.presets',
		],
		renderCliLines: ctx => ctx.isWorkTree
			? [`  - Subordinate History: \`aexus-ade session history <subordinate-id> --limit 10 --json\``]
			: [`  - Inspect: \`aexus-ade session subordinates ${ctx.agentId} --json\` | \`session tree ${ctx.agentId} --json\` | \`session info ${ctx.agentId} --json\` | \`session history <sub-id> --limit 10 --json\``],
	},
	{
		id: 'session.message',
		category: 'messaging',
		label: 'Send Messages & Stop Turns',
		description: 'Send prompts/delegations to other sessions, stop running turns, update drafts, and mark sessions read.',
		actions: [
			'session.send',
			'session.stop',
			'session.draft',
			'session.markRead',
		],
		renderCliLines: ctx => ctx.isWorkTree
			? []
			: [`  - Dispatch / Stop: \`aexus-ade session send <sub-id> "<message>" --wait --json\` | \`aexus-ade session stop <sub-id>\``],
	},
	{
		id: 'session.manage',
		category: 'hierarchy',
		label: 'Spawn & Organize Subordinates',
		description: 'Create, attach, connect, reparent, rename, assign roles, archive, or remove subordinate sessions.',
		actions: [
			'session.create',
			'session.attach',
			'session.connect',
			'session.open',
			'session.select',
			'session.close',
			'session.rename',
			'session.role',
			'session.setRole',
			'session.move',
			'session.nest',
			'session.reparent',
			'session.reorder',
			'session.archive',
			'session.unarchive',
			'session.remove',
			'session.detach',
			'session.delete',
		],
		renderCliLines: ctx => ctx.isWorkTree
			? []
			: [`  - Spawn / Move: \`aexus-ade session create --parent ${ctx.agentId} --engine <claude|codex|kilo|opencode|dsh|agy|cline|pi> --title "<title>" --no-open --json\` | \`aexus-ade session move <sub-id> <new-parent-id|none> --json\``],
	},
	{
		id: 'project.read',
		category: 'workspace',
		label: 'Read Projects, Files & Git Diff',
		description: 'List registered projects, inspect changed files, browse project directories, open files/diffs, and list Coding Agent engines.',
		actions: [
			'project.list',
			'project.changes',
			'project.files',
			'project.openFile',
			'project.openDiff',
			'engine.list',
			'engine.sessions',
		],
		renderCliLines: ctx => ctx.isWorkTree
			? []
			: [`  - Project Read: \`aexus-ade project list --json\` | \`project changes --json\` | \`project files --depth 2 --json\``],
	},
	{
		id: 'project.manage',
		category: 'workspace',
		label: 'Manage Projects & Workspace View',
		description: 'Add, remove, delete, select, focus, or reorder workspace projects and toggle ADE sidebar/inspector views.',
		actions: [
			'project.add',
			'project.select',
			'project.remove',
			'project.delete',
			'project.focus',
			'project.home',
			'project.forward',
			'project.move',
			'view.get',
			'view.set',
			'view.refresh',
			'mode.get',
		],
		dangerous: true,
		renderCliLines: () => [
			`  - Workspace Manage: \`aexus-ade project add <path> --json\` | \`project focus <target>\` | \`project home\` | \`view --inspector <changes|files|hide>\``,
		],
	},
	{
		id: 'host.access',
		category: 'workspace',
		label: 'Cloud Host (SSH) Access',
		description: 'List, test, browse, and manage remote SSH Cloud Host connections and folders.',
		actions: [
			'host.list',
			'host.info',
			'host.get',
			'host.browse',
			'host.test',
			'host.add',
			'host.update',
			'host.upsert',
			'host.remove',
			'host.delete',
			'host.import',
			'host.open',
		],
		renderCliLines: () => [
			`  - Cloud Hosts: \`aexus-ade host list --json\` | \`host browse <alias> --path <dir> --json\` | \`host test <alias> --json\``,
		],
	},
	{
		id: 'inbox.post',
		category: 'messaging',
		label: 'Human Inbox Escalation',
		description: 'Post decisions, status summaries, or circuit-breaker escalations to the Human ADE Inbox.',
		actions: [
			'inbox.post',
			'inbox.list',
			'inbox.markRead',
			'inbox.resolve',
		],
		renderCliLines: ctx => [
			`  - Human Inbox: \`aexus-ade inbox post --from ${ctx.treeGovernorId ?? ctx.agentId} --message "<decision needed>"\``,
		],
	},
	{
		id: 'engineering.read',
		category: 'engineering',
		label: 'Inspect DAG Status, Diffs & Blueprint',
		description: 'Read Engineering/Research tree status, node diffs, incremental reports, raw blueprint, validation, and starter templates.',
		actions: [
			'engineering.list',
			'engineering.status',
			'engineering.diff',
			'engineering.reports',
			'engineering.report',
			'engineering.blueprint.get',
			'engineering.blueprint.validate',
			'engineering.template.list',
			'engineering.templates.list',
		],
		renderCliLines: ctx => {
			if (!ctx.isWorkTree) {
				return [];
			}
			const govId = ctx.treeGovernorId ?? ctx.agentId;
			const nodeArg = ctx.treeNodeId ?? '<nodeId>';
			const isReviewer = ctx.workTreeSlot === 'reviewer' || (!ctx.workTreeSlot && (ctx.rankId === 'employee' || ctx.rankId === 'subordinate'));
			const isSegmentOwner = ctx.workTreeSlot === 'segment_owner' || (!ctx.workTreeSlot && ctx.rankId === 'manager');
			if (isReviewer) {
				return [
					`  - Inspect: \`aexus-ade engineering diff --governor ${govId} --node ${nodeArg}\` | \`aexus-ade engineering status --governor ${govId} --node ${nodeArg} --json\``,
				];
			}
			if (isSegmentOwner) {
				return [
					`  - Inspect: \`aexus-ade engineering status --governor ${govId} --node <nodeId> --json\` | \`diff --governor ${govId} --node <nodeId>\``,
				];
			}
			return [
				`  - Templates & Blueprint Read: \`aexus-ade engineering template list --json\` | \`aexus-ade engineering blueprint get --governor ${govId} --raw\` | \`validate --file <path>\``,
				`  - Inspect DAG: \`aexus-ade engineering status --governor ${govId} [--node <id>] --json\` | \`diff --governor ${govId} --node <id>\` | \`reports --governor ${govId} --json\``,
			];
		},
	},
	{
		id: 'engineering.design',
		category: 'engineering',
		label: 'Author Blueprint & Configure DAG',
		description: 'Initialize trees, apply blueprints/templates, and configure per-node engines, models, and thinking budgets.',
		actions: [
			'engineering.init',
			'engineering.blueprint.apply',
			'engineering.blueprint.generate',
			'engineering.generate',
			'engineering.template.apply',
			'engineering.templates.apply',
			'engineering.configure',
			'engineering.demo',
		],
		renderCliLines: ctx => {
			if (!ctx.isWorkTree) {
				return [];
			}
			const govId = ctx.treeGovernorId ?? ctx.agentId;
			return [
				`  - Blueprint Apply: \`aexus-ade engineering template apply --governor ${govId} --template <id>\` | \`aexus-ade engineering blueprint apply --governor ${govId} --file <path>\``,
				`  - Configure DAG: \`aexus-ade engineering configure --governor ${govId} --all [--engine <e>] [--model <m>] [--thinking <off|low|medium|high|max>]\``,
			];
		},
	},
	{
		id: 'engineering.review',
		category: 'engineering',
		label: 'DAG Review Verdict & Watchdog',
		description: 'Submit formal Reviewer/Segment-Owner pass/reject/guidance review verdicts and execute Watchdog remind/kill-restart actions.',
		actions: [
			'engineering.review',
			'engineering.watchdogAction',
		],
		renderCliLines: ctx => {
			if (!ctx.isWorkTree) {
				return [];
			}
			const govId = ctx.treeGovernorId ?? ctx.agentId;
			const nodeArg = ctx.treeNodeId ?? '<nodeId>';
			const isReviewer = ctx.workTreeSlot === 'reviewer' || (!ctx.workTreeSlot && (ctx.rankId === 'employee' || ctx.rankId === 'subordinate'));
			if (isReviewer) {
				return [
					`  - Pass: \`aexus-ade engineering review --governor ${govId} --node ${nodeArg} --role employee --verdict pass --report "<concise summary>"\``,
					`  - Reject (reuses Worker): \`aexus-ade engineering review --governor ${govId} --node ${nodeArg} --role employee --verdict reject --feedback "<fix instructions>"\``,
				];
			}
			return [
				`  - Verdict / Guidance: \`aexus-ade engineering review --governor ${govId} --node <nodeId> --role manager --verdict <pass|reject|guidance> [--feedback "<text>"]\``,
				`  - Watchdog Action: \`aexus-ade engineering watchdog-action --governor ${govId} --node <nodeId> --action <remind|kill-restart> [--message "<text>"]\``,
			];
		},
	},
	{
		id: 'engineering.integrate',
		category: 'engineering',
		label: 'Merge & Clean Up Git Worktrees',
		description: 'Inspect, merge isolated segment branches into the project branch, and prune Git worktrees (High Privilege).',
		actions: [
			'engineering.worktrees',
			'engineering.worktrees.merge',
			'engineering.worktrees.cleanup',
		],
		dangerous: true,
		renderCliLines: ctx => {
			if (!ctx.isWorkTree) {
				return [];
			}
			const govId = ctx.treeGovernorId ?? ctx.agentId;
			return [
				`  - Worktree Integration: \`aexus-ade engineering worktrees merge --governor ${govId}\` | \`worktrees cleanup --governor ${govId}\``,
			];
		},
	},
	{
		id: 'engineering.destroy',
		category: 'engineering',
		label: 'Reset & Remove DAG Trees',
		description: 'Reset DAG execution progress or permanently remove an Engineering/Research Work-Tree (High Privilege).',
		actions: [
			'engineering.reset',
			'engineering.remove',
		],
		dangerous: true,
		renderCliLines: ctx => {
			if (!ctx.isWorkTree) {
				return [];
			}
			const govId = ctx.treeGovernorId ?? ctx.agentId;
			return [
				`  - Reset / Remove Tree: \`aexus-ade engineering reset --governor ${govId} [--node <id>]\` | \`remove --governor ${govId}\``,
			];
		},
	},
	{
		id: 'engineering.control',
		category: 'engineering',
		label: 'Start / Pause / Gate DAG Execution',
		description: 'Start, pause, resume, stop, or approve/rollback User Acceptance Gates on a Work-Tree (typically reserved for User/Secretary).',
		actions: [
			'engineering.run',
			'engineering.pause',
			'engineering.resume',
			'engineering.stop',
			'engineering.gate',
			'engineering.open',
		],
		dangerous: true,
		renderCliLines: ctx => {
			if (!ctx.isWorkTree) {
				return [];
			}
			const govId = ctx.treeGovernorId ?? ctx.agentId;
			return [
				`  - Execution Control: \`aexus-ade engineering run --governor ${govId}\` | \`pause --governor ${govId}\` | \`resume --governor ${govId}\``,
			];
		},
	},
];

const PRIMITIVE_API_BY_ID = new Map<AdePrimitiveApiId, IAdePrimitiveApiSpec>(
	ADE_PRIMITIVE_APIS.map(spec => [spec.id, spec]),
);

const ACTION_TO_PRIMITIVE_API = new Map<string, AdePrimitiveApiId>();
for (const spec of ADE_PRIMITIVE_APIS) {
	for (const action of spec.actions) {
		ACTION_TO_PRIMITIVE_API.set(action, spec.id);
	}
}

export const ALL_ADE_PRIMITIVE_API_IDS: readonly AdePrimitiveApiId[] = ADE_PRIMITIVE_APIS.map(spec => spec.id);

export function getAdePrimitiveApiSpec(id: AdePrimitiveApiId): IAdePrimitiveApiSpec | undefined {
	return PRIMITIVE_API_BY_ID.get(id);
}

/** Resolves the fixed Aexus-Code primitive API governing a given control action (returns undefined for system-only actions like `mode.set` or `role.schema.set`). */
export function resolveActionPrimitiveApi(action: string): AdePrimitiveApiId | undefined {
	return ACTION_TO_PRIMITIVE_API.get(action);
}

export interface IAdeRankDefinition {
	/** Stable lowercase slug ID (e.g. 'governor', 'manager', 'employee', 'worker', or custom 'cto', 'qa-lead'). */
	readonly id: string;
	/** Display name shown in sidebar badges, role pickers, and compiled prompts. */
	readonly name: string;
	/** Compact 2-5 character label shown in Inbox rank filter chips (e.g. 'Gov', 'Mgr', 'QA'). */
	readonly shortName: string;
	/** Hierarchy tier number (1 = highest authority L1; larger numbers = lower authority). */
	readonly tier: number;
	/** Visual badge accent color token. */
	readonly color: AdeRankColorToken;
	/** Visual Codicon glyph token. */
	readonly icon: AdeRankIconToken;
	/** Concise 1-line summary shown in role pickers and hierarchy overviews. */
	readonly summary: string;
	/** User-authored initialization prompt / charter template supporting `{{variable}}` placeholders. */
	readonly initPrompt: string;
	/** When true, sessions of this rank receive ZERO ADE role/API prompt injection (100% pure native agent context). */
	readonly pureExecution?: boolean;
	/** Whether sessions of this rank can spawn and supervise lower-tier subordinates. */
	readonly canHaveSubordinates: boolean;
	/** Optional explicit default child rank ID when creating a sub-session (defaults to the next lower tier in the ladder). */
	readonly defaultChildRankId?: string;
	/** Subset of immutable Aexus-Code primitive APIs authorized for this rank. */
	readonly allowedApis: readonly AdePrimitiveApiId[];
}

export interface IAdeOrganizationConfig {
	readonly version: 1;
	readonly presetId?: string;
	readonly slots?: IAdeWorkTreeSlotMap;
	readonly ranks: readonly IAdeRankDefinition[];
}

export interface IAdeOrganizationPreset {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly config: IAdeOrganizationConfig;
}

export const ADE_PROMPT_TEMPLATE_VARIABLES: readonly { readonly token: string; readonly description: string }[] = [
	{ token: '{{rank.name}}', description: 'This rank display name (e.g. Governor / Tech Lead)' },
	{ token: '{{rank.tier}}', description: 'Tier label (e.g. L1, L2, L3)' },
	{ token: '{{rank.id}}', description: 'Stable rank slug ID' },
	{ token: '{{rank.summary}}', description: 'One-line rank summary' },
	{ token: '{{session.id}}', description: 'Current ADE session ID' },
	{ token: '{{session.label}}', description: 'Current session display title' },
	{ token: '{{project.name}}', description: 'Active project folder name' },
	{ token: '{{project.path}}', description: 'Active project path or SSH target' },
	{ token: '{{supervisor.label}}', description: 'Direct supervisor label (or None)' },
	{ token: '{{supervisor.rank}}', description: 'Direct supervisor rank name (or None)' },
	{ token: '{{hierarchy.ladder}}', description: 'Full configured rank ladder (L1 > L2 > ...)' },
];

export const DEFAULT_ADE_ORGANIZATION_CONFIG: IAdeOrganizationConfig = {
	version: 1,
	presetId: 'default-4tier',
	slots: {
		orchestrator: 'governor',
		segment_owner: 'manager',
		reviewer: 'employee',
		executor: 'worker',
	},
	ranks: [
		{
			id: 'governor',
			name: 'Governor',
			shortName: 'Gov',
			tier: 1,
			color: 'amber',
			icon: 'organization',
			summary: 'L1 Governor (Project Director): Top-level orchestrator in Aexus Code ADE overseeing Manager (L2), Employee (L3), and Worker (L4) subordinates.',
			initPrompt: [
				'You are {{rank.tier}} **{{rank.name}}** (Project Director), the top-level orchestrator for project **{{project.name}}**.',
				'Decompose goals cleanly, design parallel work plans, delegate execution to lower-tier subordinates, and escalate major human decisions via Inbox when blocked.',
			].join('\n'),
			pureExecution: false,
			canHaveSubordinates: true,
			defaultChildRankId: 'manager',
			allowedApis: [
				'session.read_context',
				'session.message',
				'session.manage',
				'project.read',
				'inbox.post',
				'engineering.read',
				'engineering.design',
			],
		},
		{
			id: 'manager',
			name: 'Manager',
			shortName: 'Mgr',
			tier: 2,
			color: 'indigo',
			icon: 'briefcase',
			summary: 'L2 Manager (Module Lead): Mid-level lead coordinating Employee (L3) and Worker (L4) subordinates and reporting to your supervisor (if assigned).',
			initPrompt: [
				'You are {{rank.tier}} **{{rank.name}}** (Module Lead), coordinating module/segment delivery under {{supervisor.label}} ({{supervisor.rank}}).',
				'Oversee lower-tier reviewers and executors, unblock stalled work, conduct secondary architectural/quality reviews, and report concise outcomes upward.',
			].join('\n'),
			pureExecution: false,
			canHaveSubordinates: true,
			defaultChildRankId: 'employee',
			allowedApis: [
				'session.read_context',
				'session.message',
				'session.manage',
				'project.read',
				'inbox.post',
				'engineering.read',
				'engineering.review',
			],
		},
		{
			id: 'employee',
			name: 'Employee',
			shortName: 'Emp',
			tier: 3,
			color: 'purple',
			icon: 'shield',
			summary: 'L3 Employee (Supervisory Reviewer · Employee ≠ Worker): Orchestrated supervisor & reviewer positioned strictly ABOVE Worker (L4). You hold `aexus-ade` authority to spawn, dispatch, supervise, and review leaf Worker (L4) sessions rather than acting as a rankless pure executor.',
			initPrompt: [
				'You are {{rank.tier}} **{{rank.name}}** (Supervisory Reviewer · Employee ≠ Worker), positioned strictly ABOVE Worker (L4).',
				'You hold `aexus-ade` authority to spawn, dispatch, supervise, and review leaf Worker (L4) sessions rather than acting as a rankless pure executor.',
			].join('\n'),
			pureExecution: false,
			canHaveSubordinates: true,
			defaultChildRankId: 'worker',
			allowedApis: [
				'session.read_context',
				'session.message',
				'session.manage',
				'project.read',
				'engineering.read',
				'engineering.review',
			],
		},
		{
			id: 'worker',
			name: 'Worker',
			shortName: 'Wrk',
			tier: 4,
			color: 'emerald',
			icon: 'tools',
			summary: 'L4 Worker (Pure Executor): Lowest pure-execution rank positioned below Employee (L3) with no subordinates.',
			initPrompt: '',
			pureExecution: true,
			canHaveSubordinates: false,
			allowedApis: [],
		},
	],
};

export const ADE_ORGANIZATION_PRESETS: readonly IAdeOrganizationPreset[] = [
	{
		id: 'default-4tier',
		name: 'Enterprise 4-Tier (Default)',
		description: 'Classic Governor (L1) → Manager (L2) → Employee (L3) → Pure Worker (L4) hierarchy with full DAG support.',
		config: DEFAULT_ADE_ORGANIZATION_CONFIG,
	},
	{
		id: 'startup-3tier',
		name: 'Agile 3-Tier Startup',
		description: 'Fast, lean Tech Lead (L1) → Reviewer (L2) → Pure Builder (L3) flow for small high-velocity teams.',
		config: {
			version: 1,
			presetId: 'startup-3tier',
			slots: {
				orchestrator: 'tech-lead',
				segment_owner: 'tech-lead',
				reviewer: 'reviewer',
				executor: 'builder',
			},
			ranks: [
				{
					id: 'tech-lead',
					name: 'Tech Lead',
					shortName: 'Lead',
					tier: 1,
					color: 'amber',
					icon: 'rocket',
					summary: 'L1 Tech Lead: Owns architecture, breaks down tasks, and delegates to Reviewers and Builders.',
					initPrompt: 'You are {{rank.tier}} **{{rank.name}}** for **{{project.name}}**. Define crisp technical specs, delegate execution to subordinates via `aexus-ade`, and ship fast with high engineering rigor.',
					pureExecution: false,
					canHaveSubordinates: true,
					defaultChildRankId: 'reviewer',
					allowedApis: ['session.read_context', 'session.message', 'session.manage', 'project.read', 'inbox.post', 'engineering.read', 'engineering.design', 'engineering.review'],
				},
				{
					id: 'reviewer',
					name: 'Reviewer',
					shortName: 'Rev',
					tier: 2,
					color: 'purple',
					icon: 'eye',
					summary: 'L2 Reviewer: Audits diffs, verifies tests, and directs Builders without coding directly.',
					initPrompt: 'You are {{rank.tier}} **{{rank.name}}** under {{supervisor.label}}. Strictly audit diffs and acceptance tests; dispatch fixes to Builder subordinates rather than editing business code yourself.',
					pureExecution: false,
					canHaveSubordinates: true,
					defaultChildRankId: 'builder',
					allowedApis: ['session.read_context', 'session.message', 'session.manage', 'project.read', 'engineering.read', 'engineering.review'],
				},
				{
					id: 'builder',
					name: 'Builder',
					shortName: 'Bld',
					tier: 3,
					color: 'emerald',
					icon: 'tools',
					summary: 'L3 Builder: Pure-execution coding agent with 100% clean native context.',
					initPrompt: '',
					pureExecution: true,
					canHaveSubordinates: false,
					allowedApis: [],
				},
			],
		},
	},
	{
		id: 'research-lab',
		name: 'AI Research Lab',
		description: 'Principal Investigator (L1) → Research Lead (L2) → Peer Critic (L3) → Experimenter (L4 Pure).',
		config: {
			version: 1,
			presetId: 'research-lab',
			slots: {
				orchestrator: 'governor',
				segment_owner: 'manager',
				reviewer: 'employee',
				executor: 'worker',
			},
			ranks: [
				{
					id: 'governor',
					name: 'Principal Investigator',
					shortName: 'PI',
					tier: 1,
					color: 'amber',
					icon: 'beaker',
					summary: 'L1 Principal Investigator: Sets hypotheses, experimental methodology, and synthesis criteria.',
					initPrompt: 'You are {{rank.tier}} **{{rank.name}}** leading research on **{{project.name}}**. Formulate falsifiable hypotheses, design multi-track investigation DAGs, and synthesize reproducible findings.',
					pureExecution: false,
					canHaveSubordinates: true,
					defaultChildRankId: 'manager',
					allowedApis: ['session.read_context', 'session.message', 'session.manage', 'project.read', 'inbox.post', 'engineering.read', 'engineering.design'],
				},
				{
					id: 'manager',
					name: 'Research Lead',
					shortName: 'Lead',
					tier: 2,
					color: 'cyan',
					icon: 'briefcase',
					summary: 'L2 Research Lead: Coordinates experimental tracks and validates statistical/methodological rigor.',
					initPrompt: 'You are {{rank.tier}} **{{rank.name}}** coordinating experimental tracks under {{supervisor.label}}. Challenge weak evidence and ensure every claim is backed by reproducible artifacts.',
					pureExecution: false,
					canHaveSubordinates: true,
					defaultChildRankId: 'employee',
					allowedApis: ['session.read_context', 'session.message', 'session.manage', 'project.read', 'inbox.post', 'engineering.read', 'engineering.review'],
				},
				{
					id: 'employee',
					name: 'Peer Critic',
					shortName: 'Crit',
					tier: 3,
					color: 'purple',
					icon: 'law',
					summary: 'L3 Peer Critic: Independently audits methodology, benchmarks, and citations produced by Experimenters.',
					initPrompt: 'You are {{rank.tier}} **{{rank.name}}** (strictly above Experimenter / never edit experiment code directly). Verify reproducibility, detect confounders/leakage, and write concise critique verdicts.',
					pureExecution: false,
					canHaveSubordinates: true,
					defaultChildRankId: 'worker',
					allowedApis: ['session.read_context', 'session.message', 'project.read', 'engineering.read', 'engineering.review'],
				},
				{
					id: 'worker',
					name: 'Experimenter',
					shortName: 'Exp',
					tier: 4,
					color: 'emerald',
					icon: 'tools',
					summary: 'L4 Experimenter: Pure-execution researcher running benchmarks, scripts, and data analysis.',
					initPrompt: '',
					pureExecution: true,
					canHaveSubordinates: false,
					allowedApis: [],
				},
			],
		},
	},
	{
		id: 'security-audit',
		name: 'Security Red/Blue Audit',
		description: 'Audit Director (L1) → Lead Auditor (L2) → Verifier (L3) → Scanner (L4 Pure) with least-privilege APIs.',
		config: {
			version: 1,
			presetId: 'security-audit',
			slots: {
				orchestrator: 'governor',
				segment_owner: 'manager',
				reviewer: 'employee',
				executor: 'worker',
			},
			ranks: [
				{
					id: 'governor',
					name: 'Audit Director',
					shortName: 'Dir',
					tier: 1,
					color: 'rose',
					icon: 'shield',
					summary: 'L1 Audit Director: Defines threat model, scope boundaries, and coordinates parallel audit tracks.',
					initPrompt: 'You are {{rank.tier}} **{{rank.name}}** governing security review of **{{project.name}}**. Define threat models, prioritize critical attack surfaces, and escalate confirmed high-severity findings to Human Inbox.',
					pureExecution: false,
					canHaveSubordinates: true,
					defaultChildRankId: 'manager',
					allowedApis: ['session.read_context', 'session.message', 'session.manage', 'project.read', 'host.access', 'inbox.post', 'engineering.read', 'engineering.design'],
				},
				{
					id: 'manager',
					name: 'Lead Auditor',
					shortName: 'Aud',
					tier: 2,
					color: 'amber',
					icon: 'eye',
					summary: 'L2 Lead Auditor: Triages exploit paths, verifies PoCs, and oversees Verifiers.',
					initPrompt: 'You are {{rank.tier}} **{{rank.name}}** under {{supervisor.label}}. Validate severity ratings (CVSS), eliminate false positives, and require minimal reproducible PoCs.',
					pureExecution: false,
					canHaveSubordinates: true,
					defaultChildRankId: 'employee',
					allowedApis: ['session.read_context', 'session.message', 'session.manage', 'project.read', 'host.access', 'inbox.post', 'engineering.read', 'engineering.review'],
				},
				{
					id: 'employee',
					name: 'Verifier',
					shortName: 'Ver',
					tier: 3,
					color: 'cyan',
					icon: 'law',
					summary: 'L3 Verifier: Independently validates Scanner findings and remediation diffs without mutating production code.',
					initPrompt: 'You are {{rank.tier}} **{{rank.name}}**. Audit Scanner evidence and patch diffs with zero assumptions; reject unverified claims with precise reproduction requests.',
					pureExecution: false,
					canHaveSubordinates: true,
					defaultChildRankId: 'worker',
					allowedApis: ['session.read_context', 'session.message', 'project.read', 'engineering.read', 'engineering.review'],
				},
				{
					id: 'worker',
					name: 'Scanner',
					shortName: 'Scn',
					tier: 4,
					color: 'emerald',
					icon: 'terminal',
					summary: 'L4 Scanner: Pure-execution analysis & remediation agent with zero ADE privilege.',
					initPrompt: '',
					pureExecution: true,
					canHaveSubordinates: false,
					allowedApis: [],
				},
			],
		},
	},
	{
		id: 'flat-swarm',
		name: '2-Tier Flat Swarm',
		description: 'Minimal Coordinator (L1) → Pure Agent (L2) swarm for rapid parallel fan-out.',
		config: {
			version: 1,
			presetId: 'flat-swarm',
			slots: {
				orchestrator: 'coordinator',
				segment_owner: 'coordinator',
				reviewer: 'coordinator',
				executor: 'agent',
			},
			ranks: [
				{
					id: 'coordinator',
					name: 'Coordinator',
					shortName: 'Coord',
					tier: 1,
					color: 'amber',
					icon: 'sparkle',
					summary: 'L1 Coordinator: Fans out tasks across parallel pure Agents and synthesizes results.',
					initPrompt: 'You are {{rank.tier}} **{{rank.name}}** orchestrating a flat swarm in **{{project.name}}**. Split independent work across Agent sessions via `aexus-ade` and synthesize verified results.',
					pureExecution: false,
					canHaveSubordinates: true,
					defaultChildRankId: 'agent',
					allowedApis: ['session.read_context', 'session.message', 'session.manage', 'project.read', 'inbox.post', 'engineering.read', 'engineering.design', 'engineering.review'],
				},
				{
					id: 'agent',
					name: 'Agent',
					shortName: 'Agt',
					tier: 2,
					color: 'emerald',
					icon: 'tools',
					summary: 'L2 Agent: Pure-execution leaf worker with 100% clean native context.',
					initPrompt: '',
					pureExecution: true,
					canHaveSubordinates: false,
					allowedApis: [],
				},
			],
		},
	},
];

export function sanitizeRankId(raw: string): string {
	const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
	return cleaned.slice(0, 32);
}

function isValidColorToken(raw: unknown): raw is AdeRankColorToken {
	return typeof raw === 'string' && (ADE_RANK_COLOR_TOKENS as readonly string[]).includes(raw);
}

function isValidIconToken(raw: unknown): raw is AdeRankIconToken {
	return typeof raw === 'string' && (ADE_RANK_ICON_TOKENS as readonly string[]).includes(raw);
}

function isValidPrimitiveApiId(raw: unknown): raw is AdePrimitiveApiId {
	return typeof raw === 'string' && PRIMITIVE_API_BY_ID.has(raw as AdePrimitiveApiId);
}

const RESERVED_RANK_IDS = new Set(['all', 'none', 'secretary', 'user', 'human']);

function cloneDefaultOrganizationConfig(): IAdeOrganizationConfig {
	return {
		version: 1,
		presetId: DEFAULT_ADE_ORGANIZATION_CONFIG.presetId,
		...(DEFAULT_ADE_ORGANIZATION_CONFIG.slots ? { slots: { ...DEFAULT_ADE_ORGANIZATION_CONFIG.slots } } : {}),
		ranks: DEFAULT_ADE_ORGANIZATION_CONFIG.ranks.map(r => ({ ...r, allowedApis: [...r.allowedApis] })),
	};
}

/**
 * Normalizes arbitrary user/settings JSON into a valid, safe {@link IAdeOrganizationConfig}.
 * Falls back cleanly to a fresh clone of {@link DEFAULT_ADE_ORGANIZATION_CONFIG} when missing or empty.
 */
export function normalizeAdeOrganizationConfig(raw: unknown): IAdeOrganizationConfig {
	if (!raw || typeof raw !== 'object') {
		return cloneDefaultOrganizationConfig();
	}
	const obj = raw as Record<string, unknown>;
	const rawRanks = Array.isArray(obj.ranks) ? obj.ranks : undefined;
	if (!rawRanks || rawRanks.length === 0) {
		return cloneDefaultOrganizationConfig();
	}

	const seenIds = new Set<string>();
	const parsed: IAdeRankDefinition[] = [];
	const fallbackColors: readonly AdeRankColorToken[] = ['amber', 'indigo', 'purple', 'emerald', 'cyan', 'rose', 'slate'];
	const fallbackIcons: readonly AdeRankIconToken[] = ['organization', 'briefcase', 'shield', 'tools', 'person'];

	for (let idx = 0; idx < rawRanks.length; idx++) {
		const item = rawRanks[idx];
		if (!item || typeof item !== 'object') {
			continue;
		}
		const rec = item as Record<string, unknown>;
		const rawName = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : `Rank ${idx + 1}`;
		let id = sanitizeRankId(typeof rec.id === 'string' && rec.id.trim() ? rec.id : rawName);
		if (!id || RESERVED_RANK_IDS.has(id)) {
			id = `rank-${idx + 1}`;
		}
		if (seenIds.has(id)) {
			let suffix = 2;
			while (seenIds.has(`${id}-${suffix}`)) {
				suffix++;
			}
			id = `${id}-${suffix}`;
		}
		seenIds.add(id);

		const tier = typeof rec.tier === 'number' && Number.isFinite(rec.tier) && rec.tier >= 1
			? Math.min(99, Math.round(rec.tier))
			: idx + 1;
		const shortRaw = typeof rec.shortName === 'string' && rec.shortName.trim()
			? rec.shortName.trim().slice(0, 6)
			: rawName.slice(0, 4);
		const pureExecution = rec.pureExecution === true;
		const canHaveSubordinates = pureExecution ? false : (rec.canHaveSubordinates !== false);
		const allowedApis = pureExecution
			? []
			: Array.isArray(rec.allowedApis)
				? [...new Set(rec.allowedApis.filter(isValidPrimitiveApiId))]
				: [];
		const defaultChildRankId = !pureExecution && canHaveSubordinates && typeof rec.defaultChildRankId === 'string' && rec.defaultChildRankId.trim()
			? sanitizeRankId(rec.defaultChildRankId)
			: undefined;

		parsed.push({
			id,
			name: rawName,
			shortName: shortRaw,
			tier,
			color: isValidColorToken(rec.color) ? rec.color : fallbackColors[idx % fallbackColors.length],
			icon: isValidIconToken(rec.icon) ? rec.icon : fallbackIcons[idx % fallbackIcons.length],
			summary: typeof rec.summary === 'string' && rec.summary.trim()
				? rec.summary.trim()
				: `L${tier} ${rawName}`,
			initPrompt: pureExecution
				? ''
				: (typeof rec.initPrompt === 'string' ? rec.initPrompt.trim() : ''),
			pureExecution,
			canHaveSubordinates,
			...(defaultChildRankId ? { defaultChildRankId } : {}),
			allowedApis,
		});
	}

	if (parsed.length === 0) {
		return cloneDefaultOrganizationConfig();
	}

	parsed.sort((a, b) => a.tier - b.tier);

	// Clean up dangling defaultChildRankId references
	const validIds = new Set(parsed.map(r => r.id));
	const cleaned = parsed.map(r => (
		r.defaultChildRankId && (!validIds.has(r.defaultChildRankId) || r.defaultChildRankId === r.id)
			? { ...r, defaultChildRankId: undefined }
			: r
	));

	// Sanitize optional structural work-tree slot mapping against valid rank IDs
	let normalizedSlots: IAdeWorkTreeSlotMap | undefined;
	if (obj.slots && typeof obj.slots === 'object' && !Array.isArray(obj.slots)) {
		const rawSlots = obj.slots as Record<string, unknown>;
		const slotEntries: Partial<Record<AdeWorkTreeSlot, string>> = {};
		for (const slot of ADE_WORK_TREE_SLOTS) {
			const candidate = typeof rawSlots[slot] === 'string' ? sanitizeRankId(rawSlots[slot] as string) : '';
			if (candidate && validIds.has(candidate)) {
				slotEntries[slot] = candidate;
			}
		}
		if (Object.keys(slotEntries).length > 0) {
			normalizedSlots = slotEntries;
		}
	}

	return {
		version: 1,
		presetId: typeof obj.presetId === 'string' && obj.presetId.trim() ? obj.presetId.trim() : undefined,
		...(normalizedSlots ? { slots: normalizedSlots } : {}),
		ranks: cleaned,
	};
}

/**
 * Resolves the concrete rank definition fulfilling a structural Work-Tree slot
 * (`orchestrator`, `segment_owner`, `reviewer`, `executor`) across ANY organization preset
 * (4-tier Enterprise, 3-tier Startup, 2-tier Flat Swarm, or custom N-tier schemas).
 */
export function resolveWorkTreeSlotRank(
	config: IAdeOrganizationConfig,
	slot: AdeWorkTreeSlot,
): IAdeRankDefinition {
	const explicitId = config.slots?.[slot];
	if (explicitId) {
		const explicit = findRankDefinition(config, explicitId);
		if (explicit) {
			return explicit;
		}
	}
	const nonPure = config.ranks.filter(r => !r.pureExecution);
	switch (slot) {
		case 'orchestrator':
			return findRankDefinition(config, 'governor')
				?? nonPure[0]
				?? getTopRankDefinition(config);
		case 'executor':
			return getDefaultPureLeafRank(config);
		case 'reviewer':
			return findRankDefinition(config, 'employee')
				?? nonPure[nonPure.length - 1]
				?? getTopRankDefinition(config);
		case 'segment_owner':
			return findRankDefinition(config, 'manager')
				?? (nonPure.length >= 3 ? nonPure[1] : nonPure[0])
				?? getTopRankDefinition(config);
	}
}

/** Convenience helper returning the resolved rank slug ID for a structural Work-Tree slot. */
export function resolveWorkTreeSlotRankId(
	config: IAdeOrganizationConfig,
	slot: AdeWorkTreeSlot,
): string {
	return resolveWorkTreeSlotRank(config, slot).id;
}

/** Returns all structural Work-Tree slots fulfilled by `rankId` (in 2-tier/3-tier orgs one rank may fulfill multiple slots). */
export function resolveRankWorkTreeSlots(
	config: IAdeOrganizationConfig,
	rankId: string | undefined,
): AdeWorkTreeSlot[] {
	const target = findRankDefinition(config, rankId);
	if (!target) {
		return [];
	}
	return ADE_WORK_TREE_SLOTS.filter(slot => resolveWorkTreeSlotRank(config, slot).id === target.id);
}

/** Finds a rank definition by ID (with backward-compatible alias mapping for legacy `'subordinate'` / `'member'`). */
export function findRankDefinition(config: IAdeOrganizationConfig, rankId: string | undefined): IAdeRankDefinition | undefined {
	if (!rankId) {
		return undefined;
	}
	const lower = rankId.trim().toLowerCase();
	const direct = config.ranks.find(r => r.id.toLowerCase() === lower);
	if (direct) {
		return direct;
	}
	if (lower === 'subordinate' || lower === 'member') {
		return config.ranks.find(r => r.id === 'employee')
			?? config.ranks.find(r => !r.pureExecution && r.tier > 1)
			?? config.ranks[Math.max(0, config.ranks.length - 2)];
	}
	return undefined;
}

/** Returns the default pure-execution leaf rank (e.g. `worker`, or the lowest tier rank in custom schemas). */
export function getDefaultPureLeafRank(config: IAdeOrganizationConfig): IAdeRankDefinition {
	const pureLeaf = [...config.ranks].reverse().find(r => r.pureExecution);
	return pureLeaf ?? config.ranks[config.ranks.length - 1] ?? DEFAULT_ADE_ORGANIZATION_CONFIG.ranks[3];
}

/** Returns the highest-authority top rank (e.g. `governor`, or L1 rank in custom schemas). */
export function getTopRankDefinition(config: IAdeOrganizationConfig): IAdeRankDefinition {
	return config.ranks[0] ?? DEFAULT_ADE_ORGANIZATION_CONFIG.ranks[0];
}

/** Resolves the effective rank definition for an agent role string + subordinate presence. */
export function resolveEffectiveRankDefinition(
	config: IAdeOrganizationConfig,
	role: string | undefined,
	hasSubordinates = false,
): IAdeRankDefinition {
	if (role) {
		const found = findRankDefinition(config, role);
		if (found) {
			return found;
		}
	}
	if (hasSubordinates) {
		return getTopRankDefinition(config);
	}
	return getDefaultPureLeafRank(config);
}

/** Returns true if a rank is a pure-execution leaf (zero ADE prompt/API injection). */
export function isPureExecutionRank(config: IAdeOrganizationConfig, rankId: string | undefined): boolean {
	if (!rankId) {
		return true;
	}
	const def = findRankDefinition(config, rankId);
	if (def) {
		return Boolean(def.pureExecution);
	}
	return rankId.trim().toLowerCase() === 'worker';
}

/**
 * Computes numeric authority level (higher = more authority; lowest rank = 0).
 * For default 4-tier config: Governor = 3, Manager = 2, Employee = 1, Worker = 0.
 */
export function getRankLevelFromConfig(
	config: IAdeOrganizationConfig,
	role: string | undefined,
	hasSubordinates = false,
): number {
	const maxTier = config.ranks.reduce((acc, r) => Math.max(acc, r.tier), 1);
	const def = resolveEffectiveRankDefinition(config, role, hasSubordinates);
	return Math.max(0, maxTier - def.tier);
}

/** Computes the automatic child rank when spawning a sub-session under a parent rank. */
export function getNextLowerRankFromConfig(
	config: IAdeOrganizationConfig,
	parentRole: string | undefined,
	parentHasSubordinates = false,
): {
	readonly canSpawnSubSession: boolean;
	readonly childRole: string | undefined;
	readonly childRank: string;
	readonly childDefinition: IAdeRankDefinition;
} {
	const parentDef = resolveEffectiveRankDefinition(config, parentRole, parentHasSubordinates);
	const pureLeaf = getDefaultPureLeafRank(config);
	if (parentDef.pureExecution || !parentDef.canHaveSubordinates) {
		return {
			canSpawnSubSession: false,
			childRole: undefined,
			childRank: pureLeaf.id,
			childDefinition: pureLeaf,
		};
	}

	let childDef: IAdeRankDefinition | undefined;
	if (parentDef.defaultChildRankId) {
		const explicit = findRankDefinition(config, parentDef.defaultChildRankId);
		if (explicit && explicit.tier > parentDef.tier) {
			childDef = explicit;
		}
	}
	if (!childDef) {
		childDef = config.ranks.find(r => r.tier > parentDef.tier);
	}
	if (!childDef) {
		return {
			canSpawnSubSession: false,
			childRole: undefined,
			childRank: pureLeaf.id,
			childDefinition: pureLeaf,
		};
	}
	// When the child is the default pure-execution leaf ('worker' or pureExecution), keep role=undefined so pure sessions stay clean.
	const isDefaultPure = Boolean(childDef.pureExecution && childDef.id === pureLeaf.id);
	return {
		canSpawnSubSession: true,
		childRole: isDefaultPure ? undefined : childDef.id,
		childRank: childDef.id,
		childDefinition: childDef,
	};
}

/** Returns true if `supervisorRole` is strictly higher-tier and allowed to supervise `subordinateRole`. */
export function canRankSupervise(
	config: IAdeOrganizationConfig,
	supervisorRole: string | undefined,
	supervisorHasSubordinates: boolean,
	subordinateRole: string | undefined,
	subordinateHasSubordinates: boolean,
): boolean {
	const supDef = resolveEffectiveRankDefinition(config, supervisorRole, supervisorHasSubordinates);
	if (supDef.pureExecution || !supDef.canHaveSubordinates) {
		return false;
	}
	const subDef = resolveEffectiveRankDefinition(config, subordinateRole, subordinateHasSubordinates);
	return supDef.tier < subDef.tier;
}

/** Formats the configured rank ladder as a single human-readable line (e.g. `Governor (L1) > Manager (L2) > Employee (L3) > Worker (L4 · pure)`). */
export function formatOrganizationLadder(config: IAdeOrganizationConfig): string {
	return config.ranks
		.map(r => {
			if (r.id === 'employee') {
				return `\`${r.name}\` (L${r.tier} · supervisor/reviewer, \`Employee ≠ Worker\`)`;
			}
			if (r.pureExecution) {
				return `\`${r.name}\` (L${r.tier} · pure executor, no subordinates)`;
			}
			return `\`${r.name}\` (L${r.tier})`;
		})
		.join(' > ');
}

export interface IAdeApiPermissionResult {
	readonly allowed: boolean;
	readonly requiredApi?: AdePrimitiveApiId;
	readonly rankId?: string;
	readonly rankName?: string;
	readonly reason?: string;
}

/**
 * Kernel-level authorization check for fixed Aexus-Code primitive APIs.
 * - Unspecified caller (human user CLI) or `'secretary'` bypasses rank restriction.
 * - Orchestrated/custom rank callers must hold the primitive API governing `action`.
 */
export function checkAdeApiPermission(
	config: IAdeOrganizationConfig,
	callerRaw: unknown,
	action: string,
): IAdeApiPermissionResult {
	if (callerRaw === undefined || callerRaw === null) {
		return { allowed: true };
	}
	if (typeof callerRaw !== 'string') {
		return {
			allowed: false,
			reason: `Permission denied: invalid caller identity for action "${action}".`,
		};
	}
	const caller = callerRaw.trim().toLowerCase();
	if (!caller || caller === 'user' || caller === 'human' || caller === 'secretary') {
		return { allowed: true };
	}
	const requiredApi = resolveActionPrimitiveApi(action);
	if (!requiredApi) {
		// System-only / unmapped actions (e.g. mode.set, role.schema.set) are not granted to non-Secretary agents.
		return {
			allowed: false,
			rankId: caller,
			reason: `Permission denied: rank "${caller}" is not authorized to invoke system action "${action}".`,
		};
	}

	const rankDef = findRankDefinition(config, caller);
	if (!rankDef) {
		return {
			allowed: false,
			requiredApi,
			rankId: caller,
			reason: `Permission denied: unknown caller rank "${caller}" cannot invoke primitive API "${requiredApi}" (${action}).`,
		};
	}

	if (rankDef.pureExecution || !rankDef.allowedApis.includes(requiredApi)) {
		return {
			allowed: false,
			requiredApi,
			rankId: rankDef.id,
			rankName: rankDef.name,
			reason: `Permission denied: rank "${rankDef.name}" (L${rankDef.tier}) is not granted primitive API "${requiredApi}" required for action "${action}". Update rank permissions in ADE Organization & Roles Settings.`,
		};
	}

	return {
		allowed: true,
		requiredApi,
		rankId: rankDef.id,
		rankName: rankDef.name,
	};
}

export interface IAdeRolePromptCompileInput {
	readonly config: IAdeOrganizationConfig;
	readonly rank: IAdeRankDefinition;
	readonly agentId: string;
	readonly agentLabel: string;
	readonly engineDisplay: string;
	readonly engineId: string;
	readonly projectName: string;
	readonly projectPath: string;
	readonly supervisor?: { readonly id: string; readonly label: string; readonly rankName: string };
	readonly subtreeLines?: readonly string[];
	readonly workTree?: {
		readonly treeType: 'engineering' | 'research';
		readonly governorId: string;
		readonly segmentId?: string;
		readonly nodeId?: string;
		readonly slot?: AdeWorkTreeSlot;
	};
}

/** Replaces `{{variable}}` placeholders in user-authored rank initialization prompts safely. */
export function interpolateAdeRoleTemplate(template: string, input: IAdeRolePromptCompileInput): string {
	const vars: Readonly<Record<string, string>> = {
		'rank.name': input.rank.name,
		'rank.id': input.rank.id,
		'rank.tier': `L${input.rank.tier}`,
		'rank.shortName': input.rank.shortName,
		'rank.summary': input.rank.summary,
		'session.id': input.agentId,
		'session.label': input.agentLabel,
		'project.name': input.projectName,
		'project.path': input.projectPath,
		'supervisor.label': input.supervisor?.label ?? 'None',
		'supervisor.id': input.supervisor?.id ?? 'none',
		'supervisor.rank': input.supervisor?.rankName ?? 'None',
		'hierarchy.ladder': formatOrganizationLadder(input.config),
		'tree.governorId': input.workTree?.governorId ?? input.agentId,
		'tree.segmentId': input.workTree?.segmentId ?? 'auto',
		'tree.nodeId': input.workTree?.nodeId ?? '<nodeId>',
	};
	return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, key: string) => {
		return Object.hasOwn(vars, key) ? vars[key] : match;
	});
}

/** Renders the fixed, cache-stable `aexus-ade` primitive API lines authorized for a rank. */
export function renderAllowedPrimitiveApiLines(
	rank: IAdeRankDefinition,
	ctx: IAdePromptApiRenderContext,
): string[] {
	const lines: string[] = [];
	for (const apiId of rank.allowedApis) {
		const spec = PRIMITIVE_API_BY_ID.get(apiId);
		if (!spec) {
			continue;
		}
		for (const line of spec.renderCliLines(ctx)) {
			if (line && !lines.includes(line)) {
				lines.push(line);
			}
		}
	}
	return lines;
}

/**
 * Compiles the final cache-stable `[Aexus Orchestrated Role Context]` prompt from:
 * 1. User-configured rank identity & initialization prompt template
 * 2. Live structural context (supervisor / subtree or work-tree binding — zero volatile status fields!)
 * 3. Auto-generated CLI reference for ONLY the fixed Aexus-Code primitive APIs granted to this rank.
 */
export function compileAdeRolePrompt(input: IAdeRolePromptCompileInput): string | undefined {
	if (input.rank.pureExecution) {
		return undefined;
	}
	const { rank, config } = input;
	const lines: string[] = [
		'[Aexus Orchestrated Role Context]',
		`You are an orchestrated agent in **Aexus Code ADE**.`,
		`- Rank: ${rank.summary}`,
		`- Role: ${rank.name}`,
		`- Session: ${input.agentLabel} (id: ${input.agentId}, engine: ${input.engineDisplay} [${input.engineId}])`,
		`- Project: ${input.projectName} (${input.projectPath})`,
		`- Hierarchy: ${formatOrganizationLadder(config)}`,
	];

	if (input.supervisor) {
		lines.push(`- Supervisor: ${input.supervisor.label} (id: ${input.supervisor.id}, role: ${input.supervisor.rankName})`);
	}

	const interpolatedCharter = rank.initPrompt.trim()
		? interpolateAdeRoleTemplate(rank.initPrompt.trim(), input)
		: '';

	if (input.workTree) {
		const govId = input.workTree.governorId;
		const treeKindTitle = input.workTree.treeType === 'research' ? 'ADE Research Tree' : 'ADE Engineering Tree';
		const resolvedSlot: AdeWorkTreeSlot | undefined = input.workTree.slot
			?? (input.workTree.nodeId ? 'reviewer'
				: input.workTree.segmentId ? 'segment_owner'
					: resolveRankWorkTreeSlots(config, rank.id)[0]);
		const reviewerRank = resolveWorkTreeSlotRank(config, 'reviewer');
		const segmentOwnerRank = resolveWorkTreeSlotRank(config, 'segment_owner');
		const executorRank = resolveWorkTreeSlotRank(config, 'executor');

		lines.push(
			`- Work Tree: **${treeKindTitle}** (governor: \`${govId}\`${input.workTree.segmentId ? `, segment: \`${input.workTree.segmentId}\`` : ''}${input.workTree.nodeId ? `, node: \`${input.workTree.nodeId}\`` : ''}) — topology locked by \`blueprint.md\`; inspect live nodes/status via \`aexus-ade engineering status --governor ${govId} --json\`.`,
			`- Identity Rule: When asked your role/rank, state **${rank.name}**, session \`${input.agentId}\`, project **${input.projectName}**, and work tree \`${govId}\`. NEVER claim that you are "not an employee" or have "no rank".`,
		);
		if (interpolatedCharter) {
			lines.push('- Role Initialization Charter:');
			for (const charterLine of interpolatedCharter.split(/\r?\n/)) {
				if (charterLine.trim()) {
					lines.push(`  ${charterLine}`);
				}
			}
		}

		// Preserve strict Work-Tree operational guardrails keyed by structural slot (works across all org presets)
		const isResearchTree = input.workTree.treeType === 'research';
		if (resolvedSlot === 'orchestrator') {
			lines.push(
				isResearchTree
					? `- Research ${rank.name} (L${rank.tier}) Operational Rules:`
					: `- Engineering ${rank.name} (L${rank.tier}) Operational Rules:`,
				isResearchTree
					? '  - Design multi-track research synthesis & verification DAG topology in `blueprint.md`.'
					: '  - Design task decomposition & DAG parallel topology in `blueprint.md` (supports optional node `files:` scope and `verify:` check commands, plus `max_concurrency`).',
				`  - Asleep during normal execution; woken ONLY on 3rd formal ${segmentOwnerRank.name} failure (RED Circuit Breaker). NEVER call \`aexus-ade engineering run\` yourself unless explicitly authorized (normally User or Secretary starts execution).`,
			);
		} else if (resolvedSlot === 'segment_owner') {
			lines.push(
				`- Segment ${rank.name} (L${rank.tier}) Operational Rules (Segment \`${input.workTree.segmentId ?? 'auto'}\`):`,
				`  - Woken ONLY on: (a) segment tail / ★Critical secondary review, (b) 3x ${reviewerRank.name} internal rejections (grant 4th-chance guidance or formal reject), (c) Git worktree merge conflict, or (d) persistent Watchdog stall.`,
			);
		} else if (resolvedSlot === 'reviewer') {
			const noCodingPair = rank.id === 'employee' && executorRank.id === 'worker'
				? 'Employee ≠ Worker'
				: `${rank.name} ≠ ${executorRank.name}`;
			lines.push(
				`- Single-Node Reviewer (L${rank.tier}) Operational Rules (Node \`${input.workTree.nodeId ?? 'task'}\`):`,
				`  - **STRICT PROHIBITION (\`${noCodingPair}\`)**: NEVER write or edit business code yourself — your ${executorRank.name} executes all coding. Audit Acceptance Criteria + Diff and submit your verdict via \`aexus-ade\`.`,
			);
		}

		const apiLines = renderAllowedPrimitiveApiLines(rank, {
			agentId: input.agentId,
			isWorkTree: true,
			treeGovernorId: govId,
			treeSegmentId: input.workTree.segmentId,
			treeNodeId: input.workTree.nodeId,
			rankId: rank.id,
			workTreeSlot: resolvedSlot,
		});
		if (apiLines.length > 0) {
			lines.push(`- Authorized Aexus-Code Primitive APIs (${rank.allowedApis.join(', ')}):`);
			lines.push(...apiLines);
		} else {
			lines.push('- Authorized Aexus-Code Primitive APIs: None');
		}
		return lines.join('\n');
	}

	if (input.subtreeLines && input.subtreeLines.length > 0) {
		lines.push('- Subtree Rooted at You:');
		lines.push(...input.subtreeLines);
	} else {
		lines.push('- Direct Subordinates: None');
	}

	lines.push(
		`- Identity Rule: When asked your role/rank, state **${rank.name}**, session \`${input.agentId}\`, project **${input.projectName}**, supervisor (${input.supervisor ? `${input.supervisor.label} [${input.supervisor.rankName}]` : 'None'}), and subordinates. NEVER claim that you are "not an employee" or have "no rank".`,
	);

	if (interpolatedCharter) {
		lines.push('- Role Initialization Charter:');
		for (const charterLine of interpolatedCharter.split(/\r?\n/)) {
			if (charterLine.trim()) {
				lines.push(`  ${charterLine}`);
			}
		}
	}

	const apiLines = renderAllowedPrimitiveApiLines(rank, {
		agentId: input.agentId,
		isWorkTree: false,
		rankId: rank.id,
	});
	if (apiLines.length > 0) {
		if (rank.allowedApis.includes('session.read_context')) {
			lines.push(`- Live State: Hierarchy can hot-swap dynamically; run \`aexus-ade session info ${input.agentId} --json\` or \`aexus-ade session tree ${input.agentId} --json\` for live status before delegating.`);
		}
		lines.push(`- Subordinate Control API & Authorized Aexus-Code Primitives (\`aexus-ade\` is on PATH; enforced by kernel — granted: ${rank.allowedApis.join(', ')}):`);
		lines.push(...apiLines);
	} else {
		lines.push('- Authorized Aexus-Code Primitive APIs: None (you have no `aexus-ade` control permissions granted by this organization schema).');
	}

	return lines.join('\n');
}

/** Compiles a sample preview prompt & estimated token count for the visual Organization Studio. */
export function previewCompiledRankPrompt(config: IAdeOrganizationConfig, rank: IAdeRankDefinition): {
	readonly prompt: string;
	readonly estimatedTokens: number;
} {
	if (rank.pureExecution) {
		return {
			prompt: '(Pure Execution Leaf — ZERO ADE role prompt or API instructions injected. Receives 100% clean native Coding Agent context.)',
			estimatedTokens: 0,
		};
	}
	const higherRank = [...config.ranks].reverse().find(r => r.tier < rank.tier);
	const compiled = compileAdeRolePrompt({
		config,
		rank,
		agentId: `sample-${rank.id}-01`,
		agentLabel: `${rank.name} Session`,
		engineDisplay: 'Claude Code',
		engineId: 'aexus-claude',
		projectName: 'MyProject',
		projectPath: '/workspace/MyProject',
		supervisor: higherRank ? { id: `sample-${higherRank.id}-01`, label: `${higherRank.name} Lead`, rankName: higherRank.name } : undefined,
	}) ?? '';
	return {
		prompt: compiled,
		estimatedTokens: estimateTextTokens(compiled),
	};
}

/** VS Code settings JSON schema for `aexus.ade.organization`. */
export const ADE_ORGANIZATION_JSON_SCHEMA = {
	type: 'object' as const,
	additionalProperties: false,
	properties: {
		version: {
			type: 'number' as const,
			enum: [1],
			default: 1,
			description: 'Organization schema version.',
		},
		presetId: {
			type: 'string' as const,
			description: 'Active preset identifier (e.g. default-4tier, startup-3tier, research-lab, security-audit, flat-swarm, custom).',
		},
		slots: {
			type: 'object' as const,
			additionalProperties: false,
			description: 'Structural Work-Tree slot mapping (orchestrator, segment_owner, reviewer, executor) to configured rank IDs.',
			properties: {
				orchestrator: { type: 'string' as const, description: 'Rank ID owning DAG topology & escalations (L1).' },
				segment_owner: { type: 'string' as const, description: 'Rank ID owning segment review, merge conflicts, and escalations.' },
				reviewer: { type: 'string' as const, description: 'Rank ID auditing single-node diffs & acceptance criteria without coding.' },
				executor: { type: 'string' as const, description: 'Rank ID executing coding / analysis turns (typically pure execution).' },
			},
		},
		ranks: {
			type: 'array' as const,
			minItems: 1,
			description: 'Ordered organizational ranks from highest authority (L1) to lowest (LN).',
			items: {
				type: 'object' as const,
				required: ['id', 'name', 'tier'],
				additionalProperties: false,
				properties: {
					id: { type: 'string' as const, description: 'Stable machine slug ID (e.g. governor, tech-lead, reviewer, worker).' },
					name: { type: 'string' as const, description: 'Display name for this rank.' },
					shortName: { type: 'string' as const, description: 'Compact 2-5 character badge tag for Inbox filters.' },
					tier: { type: 'number' as const, minimum: 1, maximum: 99, description: 'Hierarchy tier (1 = highest rank L1).' },
					color: { type: 'string' as const, enum: [...ADE_RANK_COLOR_TOKENS], description: 'Badge accent color token.' },
					icon: { type: 'string' as const, enum: [...ADE_RANK_ICON_TOKENS], description: 'Badge icon name.' },
					summary: { type: 'string' as const, description: 'One-line role summary shown in pickers and headers.' },
					initPrompt: { type: 'string' as const, description: 'Initialization system prompt / charter template supporting {{rank.name}}, {{project.name}}, etc.' },
					pureExecution: { type: 'boolean' as const, default: false, description: 'When true, zero ADE role/API prompt is injected (100% pure native Coding Agent context).' },
					canHaveSubordinates: { type: 'boolean' as const, default: true, description: 'Whether sessions of this rank can spawn and supervise lower-tier subordinates.' },
					defaultChildRankId: { type: 'string' as const, description: 'Optional explicit default subordinate rank ID when creating a sub-session.' },
					allowedApis: {
						type: 'array' as const,
						description: 'Fixed Aexus-Code core primitive APIs authorized for this rank.',
						items: {
							type: 'string' as const,
							enum: [...ALL_ADE_PRIMITIVE_API_IDS],
						},
					},
				},
			},
		},
	},
};
