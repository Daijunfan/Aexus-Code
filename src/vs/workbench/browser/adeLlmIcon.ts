/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const SVG_NS = 'http://www.w3.org/2000/svg';

export type AdeLlmProviderKind =
	| 'openai'
	| 'anthropic'
	| 'deepseek'
	| 'gemini'
	| 'qwen'
	| 'kimi'
	| 'glm'
	| 'grok'
	| 'meta'
	| 'mistral'
	| 'minimax'
	| 'generic';

export type AdeLlmPickerVendor =
	| 'openai'
	| 'anthropic'
	| 'deepseek'
	| 'gemini'
	| 'qwen'
	| 'kimi'
	| 'glm'
	| 'grok'
	| 'generic';

export type AdeModelCategoryOverrides = Readonly<Record<string, Readonly<Record<string, AdeLlmPickerVendor>>>>;

export const ADE_LLM_PROVIDER_LABELS: Readonly<Record<AdeLlmProviderKind, string>> = {
	openai: 'OpenAI GPT',
	anthropic: 'Anthropic Claude',
	deepseek: 'DeepSeek',
	gemini: 'Google Gemini',
	qwen: 'Alibaba Qwen',
	kimi: 'Moonshot Kimi',
	glm: 'Zhipu GLM',
	grok: 'xAI Grok',
	meta: 'Meta Llama',
	mistral: 'Mistral AI',
	minimax: 'MiniMax',
	generic: 'Other Models',
};

export interface IAdeLlmModelOption {
	readonly id: string;
	readonly label: string;
	readonly supported: boolean;
	readonly configured?: boolean;
	readonly customCategorized?: boolean;
}

export interface IAdeLlmVendorCatalogEntry {
	readonly vendor: AdeLlmPickerVendor;
	readonly shortLabel: string;
	readonly fullLabel: string;
	readonly supported: boolean;
	readonly supportedCount: number;
	readonly models: readonly IAdeLlmModelOption[];
}

export const ADE_LLM_PICKER_VENDORS: readonly { readonly vendor: AdeLlmPickerVendor; readonly shortLabel: string }[] = [
	{ vendor: 'openai', shortLabel: 'GPT' },
	{ vendor: 'anthropic', shortLabel: 'Claude' },
	{ vendor: 'deepseek', shortLabel: 'DeepSeek' },
	{ vendor: 'gemini', shortLabel: 'Gemini' },
	{ vendor: 'qwen', shortLabel: 'Qwen' },
	{ vendor: 'kimi', shortLabel: 'Kimi' },
	{ vendor: 'glm', shortLabel: 'GLM' },
	{ vendor: 'grok', shortLabel: 'Grok' },
	{ vendor: 'generic', shortLabel: 'Other' },
];

const VENDOR_CANONICAL_MODELS: Readonly<Partial<Record<AdeLlmProviderKind, readonly { readonly id: string; readonly label: string }[]>>> = {
	openai: [
		{ id: 'gpt-5.4', label: 'GPT-5.4' },
		{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
		{ id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
		{ id: 'gpt-5.2', label: 'GPT-5.2' },
		{ id: 'gpt-5', label: 'GPT-5' },
		{ id: 'gpt-5-mini', label: 'GPT-5 Mini' },
		{ id: 'o3', label: 'o3' },
		{ id: 'o4-mini', label: 'o4-mini' },
		{ id: 'codex-mini-latest', label: 'Codex Mini' },
		{ id: 'gpt-4.1', label: 'GPT-4.1' },
		{ id: 'gpt-4o', label: 'GPT-4o' },
	],
	anthropic: [
		{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
		{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
		{ id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
		{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
		{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
		{ id: 'opus', label: 'Opus (CLI Alias)' },
		{ id: 'sonnet', label: 'Sonnet (CLI Alias)' },
		{ id: 'haiku', label: 'Haiku (CLI Alias)' },
	],
	deepseek: [
		{ id: 'deepseek-flash[1m]', label: 'DeepSeek Flash (1M)' },
		{ id: 'deepseek-v4-pro[1m]', label: 'DeepSeek V4 Pro (1M)' },
		{ id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
		{ id: 'deepseek-chat', label: 'DeepSeek Chat' },
		{ id: 'deepseek-r1', label: 'DeepSeek R1' },
		{ id: 'deepseek-v3.2', label: 'DeepSeek V3.2' },
	],
	gemini: [
		{ id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' },
		{ id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
		{ id: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)' },
		{ id: 'gemini-4-neon-low', label: 'Gemini 4 Neon (Low)' },
		{ id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)' },
		{ id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
		{ id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)' },
		{ id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
		{ id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
		{ id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
		{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
		{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
		{ id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
	],
	qwen: [
		{ id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus' },
		{ id: 'qwen3-coder', label: 'Qwen3 Coder' },
		{ id: 'qwen3-max', label: 'Qwen3 Max' },
		{ id: 'qwen3-235b-a22b', label: 'Qwen3 235B' },
		{ id: 'qwq-32b', label: 'QwQ 32B' },
	],
	kimi: [
		{ id: 'kimi-k2.5', label: 'Kimi K2.5' },
		{ id: 'kimi-k2-thinking', label: 'Kimi K2 Thinking' },
		{ id: 'kimi-k2', label: 'Kimi K2' },
	],
	glm: [
		{ id: 'glm-4.7', label: 'GLM-4.7' },
		{ id: 'glm-4.6', label: 'GLM-4.6' },
		{ id: 'glm-4.5', label: 'GLM-4.5' },
	],
	grok: [
		{ id: 'grok-4', label: 'Grok 4' },
		{ id: 'grok-3', label: 'Grok 3' },
		{ id: 'grok-code-fast-1', label: 'Grok Code Fast 1' },
	],
};

/**
 * Native concrete model IDs supported out-of-the-box by each Aexus Agent Engine.
 * Vendors or specific models absent from an engine's native set (and not dynamically
 * configured on the host) are dimmed and unselectable in the Mission model picker.
 */
export const ADE_ENGINE_NATIVE_MODELS: Readonly<Record<string, readonly string[]>> = {
	'aexus-claude': [
		'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
		'opus', 'sonnet', 'haiku',
	],
	'aexus-codex': [
		'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5', 'gpt-5-mini',
		'o3', 'o4-mini', 'codex-mini-latest',
	],
	'aexus-dsh': [
		'deepseek-reasoner', 'deepseek-chat', 'deepseek-r1',
	],
	'aexus-antigravity': [
		'gemini-4-neon-xhigh', 'gemini-4-neon-high', 'gemini-4-neon-medium', 'gemini-4-neon-low',
		'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low',
		'gemini-3.1-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash',
		'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5',
	],
	'aexus-kilo': [
		'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5', 'gpt-5-mini', 'o3', 'o4-mini', 'gpt-4.1', 'gpt-4o',
		'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
		'deepseek-reasoner', 'deepseek-chat', 'deepseek-r1', 'deepseek-v3.2',
		'gemini-3.1-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash',
		'qwen3-coder-plus', 'qwen3-coder', 'qwen3-max', 'qwen3-235b-a22b', 'qwq-32b',
		'kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2',
		'glm-4.7', 'glm-4.6', 'glm-4.5',
		'grok-4', 'grok-3', 'grok-code-fast-1',
	],
	'aexus-opencode': [
		'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5', 'gpt-5-mini', 'o3', 'o4-mini', 'gpt-4.1', 'gpt-4o',
		'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
		'deepseek-reasoner', 'deepseek-chat', 'deepseek-r1', 'deepseek-v3.2',
		'gemini-3.1-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash',
		'qwen3-coder-plus', 'qwen3-coder', 'qwen3-max', 'qwen3-235b-a22b', 'qwq-32b',
		'kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2',
		'glm-4.7', 'glm-4.6', 'glm-4.5',
		'grok-4', 'grok-3', 'grok-code-fast-1',
	],
	'aexus-cline': [
		'gpt-5.4', 'gpt-5.2', 'gpt-5', 'gpt-5-mini', 'o3', 'o4-mini', 'gpt-4.1', 'gpt-4o',
		'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
		'deepseek-reasoner', 'deepseek-chat', 'deepseek-r1', 'deepseek-v3.2',
		'gemini-3.1-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash',
		'qwen3-coder-plus', 'qwen3-coder', 'qwen3-max', 'qwen3-235b-a22b', 'qwq-32b',
		'kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2',
		'glm-4.7', 'glm-4.6', 'glm-4.5',
		'grok-4', 'grok-3', 'grok-code-fast-1',
	],
	'aexus-pi': [
		'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2', 'gpt-5', 'gpt-5-mini', 'o3', 'o4-mini', 'gpt-4.1',
		'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
		'deepseek-reasoner', 'deepseek-chat', 'deepseek-r1', 'deepseek-v3.2',
		'gemini-3.1-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash',
		'qwen3-coder-plus', 'qwen3-coder', 'qwen3-max',
		'kimi-k2.5', 'kimi-k2',
		'glm-4.7', 'glm-4.6',
		'grok-4', 'grok-3',
	],
};

const PICKER_VENDOR_SET = new Set<AdeLlmPickerVendor>(ADE_LLM_PICKER_VENDORS.map(v => v.vendor));

export function isAdeLlmPickerVendor(value: string | undefined): value is AdeLlmPickerVendor {
	return Boolean(value && PICKER_VENDOR_SET.has(value as AdeLlmPickerVendor));
}

export function normalizeAdeModelIdentityKey(rawId: string): string {
	const trimmed = rawId.trim();
	// DSH tuple format: ["deepseek-official","deepseek-reasoner"]
	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed) && typeof parsed[1] === 'string') {
				return parsed[1].trim().toLowerCase();
			}
		} catch {
			// Fall through
		}
	}
	// Strip provider prefix like "openai/GPT-5" or "group-openai/DeepSeek-V4" for case-insensitive canonical identity
	const slashIdx = trimmed.lastIndexOf('/');
	const tail = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
	return tail.trim().toLowerCase();
}

export function lookupAdeModelCategoryOverride(
	overrides: AdeModelCategoryOverrides | undefined,
	engineId: string,
	modelId: string | undefined,
): AdeLlmPickerVendor | undefined {
	if (!overrides || !modelId?.trim()) {
		return undefined;
	}
	const engineMap = overrides[engineId];
	if (!engineMap) {
		return undefined;
	}
	const exactLower = modelId.trim().toLowerCase();
	const exactHit = engineMap[exactLower];
	if (isAdeLlmPickerVendor(exactHit)) {
		return exactHit;
	}
	const normKey = normalizeAdeModelIdentityKey(modelId);
	const normHit = engineMap[normKey];
	return isAdeLlmPickerVendor(normHit) ? normHit : undefined;
}

export function toAdePickerVendor(kind: AdeLlmProviderKind): AdeLlmPickerVendor {
	return isAdeLlmPickerVendor(kind) ? kind : 'generic';
}

function classifyModelTokenByName(raw: string): AdeLlmPickerVendor | undefined {
	const normalized = raw.trim().toLowerCase();
	if (!normalized || normalized === 'default') {
		return undefined;
	}
	if (/(^|[/:\s._-])(deepseek|ds-r1|ds-v3|ds-v4|ds_r1|ds_v3|ds_v4)/.test(normalized) || normalized.includes('deepseek')) {
		return 'deepseek';
	}
	if (/(^|[/:\s._-])(claude|sonnet|opus|haiku|anthropic)/.test(normalized) || normalized.includes('claude')) {
		return 'anthropic';
	}
	if (/(^|[/:\s._-])(gpt|chatgpt|codex|openai|o1|o3|o4)($|[/:\s._-]|[\d])/.test(normalized) || normalized.includes('gpt')) {
		return 'openai';
	}
	if (/(^|[/:\s._-])(gemini|gemma|palm|argon)/.test(normalized) || normalized.includes('gemini')) {
		return 'gemini';
	}
	if (/(^|[/:\s._-])(qwen|qwq|qvq|dashscope|tongyi)/.test(normalized) || normalized.includes('qwen')) {
		return 'qwen';
	}
	if (/(^|[/:\s._-])(kimi|moonshot)/.test(normalized) || normalized.includes('kimi')) {
		return 'kimi';
	}
	if (/(^|[/:\s._-])(glm|chatglm|zhipu|bigmodel)/.test(normalized) || normalized.includes('glm')) {
		return 'glm';
	}
	if (/(^|[/:\s._-])(grok|xai|x-ai)/.test(normalized) || normalized.includes('grok')) {
		return 'grok';
	}
	return undefined;
}

/**
 * Classifies any model into one of the 8 brand icon categories purely by its model name (ID tail or display label,
 * fully case-insensitive), falling back to `'generic'` (Other Models) when unrecognized.
 */
export function resolveAdePickerVendorByName(modelId: string | undefined, modelLabel?: string): AdeLlmPickerVendor {
	const idText = (modelId ?? '').trim();
	if (idText) {
		const tail = normalizeAdeModelIdentityKey(idText);
		const byTail = classifyModelTokenByName(tail);
		if (byTail) {
			return byTail;
		}
	}
	if (modelLabel?.trim()) {
		const byLabel = classifyModelTokenByName(modelLabel);
		if (byLabel) {
			return byLabel;
		}
	}
	return 'generic';
}

/**
 * Resolves the effective brand icon for a node/model, honoring user per-engine manual categorization first.
 */
export function resolveEffectiveAdeLlmProvider(
	model: string | undefined,
	engineId?: string,
	categoryOverrides?: AdeModelCategoryOverrides,
): AdeLlmProviderKind {
	if (engineId) {
		const manual = lookupAdeModelCategoryOverride(categoryOverrides, engineId, model);
		if (manual) {
			return manual;
		}
	}
	return resolveAdeLlmProvider(model, engineId);
}

/**
 * Resolves the 9 LLM vendor chips (8 brand icons + Other) and their concrete model lists for a specific Agent Engine,
 * combining the engine's native supported models with any dynamically discovered host models
 * (`aexus.agentEngines.listConfiguredModels`), case-insensitive deduplication, and user manual category overrides.
 */
export function resolveAdeEngineModelCatalog(
	engineId: string,
	configuredModels?: readonly { readonly id: string; readonly label?: string }[],
	categoryOverrides?: AdeModelCategoryOverrides,
): readonly IAdeLlmVendorCatalogEntry[] {
	const discoveredValid = (configuredModels ?? []).filter(m => m.id && m.id.trim() && m.id.trim().toLowerCase() !== 'default');
	const nativeList = ADE_ENGINE_NATIVE_MODELS[engineId] ?? [];

	// If Claude Code has custom non-Anthropic configured models (e.g. ANTHROPIC_BASE_URL proxy),
	// honor that replacement so custom vendor lights up while unsupported native defaults stay accurate.
	const claudeReplacedBuiltIns = engineId === 'aexus-claude'
		&& discoveredValid.length > 0
		&& !discoveredValid.some(m => resolveAdePickerVendorByName(m.id, m.label) === 'anthropic');

	const supportedKeys = new Set<string>(claudeReplacedBuiltIns ? [] : nativeList.map(id => id.toLowerCase()));

	// Case-insensitive deduplication of discovered models across all casings (e.g. DeepSeek-R1 vs deepseek-r1)
	const discoveredByNorm = new Map<string, { readonly id: string; readonly label: string; readonly normKey: string; readonly vendor: AdeLlmPickerVendor; readonly customCategorized: boolean }>();
	for (const item of discoveredValid) {
		const rawId = item.id.trim();
		const normKey = normalizeAdeModelIdentityKey(rawId);
		supportedKeys.add(rawId.toLowerCase());
		supportedKeys.add(normKey);
		if (discoveredByNorm.has(normKey)) {
			continue;
		}
		let cleanLabel = item.label?.trim() || rawId;
		const redundantSuffix = ` (${rawId})`;
		if (cleanLabel.toLowerCase().endsWith(redundantSuffix.toLowerCase()) && cleanLabel.length > redundantSuffix.length) {
			cleanLabel = cleanLabel.slice(0, -redundantSuffix.length).trim();
		}
		const manualVendor = lookupAdeModelCategoryOverride(categoryOverrides, engineId, rawId);
		const vendor = manualVendor ?? resolveAdePickerVendorByName(rawId, cleanLabel);
		discoveredByNorm.set(normKey, {
			id: rawId,
			label: cleanLabel,
			normKey,
			vendor,
			customCategorized: Boolean(manualVendor),
		});
	}

	const bucketModels = new Map<AdeLlmPickerVendor, IAdeLlmModelOption[]>();
	const bucketSeenNorm = new Map<AdeLlmPickerVendor, Set<string>>();
	for (const { vendor } of ADE_LLM_PICKER_VENDORS) {
		bucketModels.set(vendor, []);
		bucketSeenNorm.set(vendor, new Set<string>());
	}
	const globallyPlacedCanonical = new Set<string>();

	// 1. Place canonical vendor models (moving to user-overridden category if user explicitly categorized that model!)
	for (const { vendor: defaultVendor } of ADE_LLM_PICKER_VENDORS) {
		const canonical = VENDOR_CANONICAL_MODELS[defaultVendor] ?? [];
		for (const spec of canonical) {
			const normKey = spec.id.toLowerCase();
			const matchedDiscovered = discoveredByNorm.get(normKey);
			const isSupported = supportedKeys.has(normKey) || Boolean(matchedDiscovered);
			const manualVendor = lookupAdeModelCategoryOverride(categoryOverrides, engineId, matchedDiscovered?.id ?? spec.id);
			const targetVendor = (isSupported && manualVendor) ? manualVendor : defaultVendor;
			const targetSeen = bucketSeenNorm.get(targetVendor)!;
			if (targetSeen.has(normKey)) {
				continue;
			}
			targetSeen.add(normKey);
			globallyPlacedCanonical.add(normKey);
			bucketModels.get(targetVendor)!.push({
				id: matchedDiscovered ? matchedDiscovered.id : spec.id,
				label: spec.label,
				supported: isSupported,
				configured: Boolean(matchedDiscovered),
				...(manualVendor && isSupported ? { customCategorized: true } : {}),
			});
		}
	}

	// 2. Place all additional dynamically discovered models (into their name-matched vendor, user-overridden vendor, or Other)
	for (const disc of discoveredByNorm.values()) {
		if (globallyPlacedCanonical.has(disc.normKey)) {
			continue;
		}
		const targetSeen = bucketSeenNorm.get(disc.vendor)!;
		if (targetSeen.has(disc.normKey)) {
			continue;
		}
		targetSeen.add(disc.normKey);
		bucketModels.get(disc.vendor)!.push({
			id: disc.id,
			label: disc.label,
			supported: true,
			configured: true,
			...(disc.customCategorized ? { customCategorized: true } : {}),
		});
	}

	return ADE_LLM_PICKER_VENDORS.map(({ vendor, shortLabel }): IAdeLlmVendorCatalogEntry => {
		const merged = bucketModels.get(vendor)!;
		// Sort supported models first (configured first inside supported), dimmed unsupported models below
		merged.sort((a, b) => Number(b.supported) - Number(a.supported) || Number(Boolean(b.configured)) - Number(Boolean(a.configured)));
		const supportedCount = merged.filter(m => m.supported).length;
		return {
			vendor,
			shortLabel,
			fullLabel: ADE_LLM_PROVIDER_LABELS[vendor],
			supported: supportedCount > 0,
			supportedCount,
			models: merged,
		};
	});
}

// Authentic vector paths reused from Aexus Code resources (claude-dark.svg, codex-dark.svg, dsh-dark.svg)
const CLAUDE_SUNBURST_D = 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';

const OPENAI_BLOSSOM_D = 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.073zM13.26 22.4302a4.4755 4.4755 0 0 1-2.8764-1.04l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464h-.0001zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';

const DEEPSEEK_WHALE_D = 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45';

const GEMINI_SPARKLE_D = 'M12 1.2C12.7 7.1 16.9 11.3 22.8 12C16.9 12.7 12.7 16.9 12 22.8C11.3 16.9 7.1 12.7 1.2 12C7.1 11.3 11.3 7.1 12 1.2Z';

const QWEN_STAR_D = 'M12 1.5L15.1 6.7L21.1 6.7L18.1 12L21.1 17.3L15.1 17.3L12 22.5L8.9 17.3L2.9 17.3L5.9 12L2.9 6.7L8.9 6.7Z';

const META_INFINITY_D = 'M6.8 6.5C4.1 6.5 2 9.1 2 12.2C2 15.1 3.7 17.5 6.1 17.5C8.1 17.5 9.6 16.1 11.4 13.1L12.6 10.9C14.1 8.4 15.4 7.5 16.9 7.5C18.8 7.5 20 9.4 20 12C20 14.5 18.7 16.2 17 16.2C15.5 16.2 14.4 15.1 13.2 13.2';

let svgGradientUid = 0;

function createSvgElement(doc: Document, tag: string, attrs: Record<string, string>): SVGElement {
	const el = doc.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) {
		el.setAttribute(k, v);
	}
	return el;
}

/**
 * Maps any LLM model identifier (e.g. `gpt-5.3-codex`, `claude-opus-4-6`, `deepseek-r1`,
 * `gemini-2.5-pro`, `qwen3-coder-plus`, `o4-mini`, `kimi-k2`, `glm-4.7`, `grok-3`, `llama-4`,
 * `mistral-large`, `minimax-m1`) to its underlying LLM brand icon kind.
 */
export function resolveAdeLlmProvider(model: string | undefined, fallbackEngineId?: string): AdeLlmProviderKind {
	const normalized = (model ?? '').trim().toLowerCase();
	if (normalized && normalized !== 'default') {
		if (/(^|[/:\s._-])(deepseek|ds-r1|ds-v3)/.test(normalized) || normalized.includes('deepseek')) {
			return 'deepseek';
		}
		if (/(^|[/:\s._-])(claude|sonnet|opus|haiku|anthropic)/.test(normalized) || normalized.includes('claude')) {
			return 'anthropic';
		}
		if (/(^|[/:\s._-])(gpt|chatgpt|codex|openai|o1|o3|o4)($|[/:\s._-]|[\d])/.test(normalized) || normalized.includes('openai') || normalized.includes('gpt')) {
			return 'openai';
		}
		if (/(^|[/:\s._-])(gemini|gemma|google|palm|argon)/.test(normalized) || normalized.includes('gemini')) {
			return 'gemini';
		}
		if (/(^|[/:\s._-])(qwen|qwq|alibaba|dashscope|tongyi)/.test(normalized) || normalized.includes('qwen')) {
			return 'qwen';
		}
		if (/(^|[/:\s._-])(kimi|moonshot)/.test(normalized) || normalized.includes('kimi')) {
			return 'kimi';
		}
		if (/(^|[/:\s._-])(glm|chatglm|zhipu|bigmodel)/.test(normalized) || normalized.includes('glm')) {
			return 'glm';
		}
		if (/(^|[/:\s._-])(grok|xai|x-ai)/.test(normalized) || normalized.includes('grok')) {
			return 'grok';
		}
		if (/(^|[/:\s._-])(llama|meta-llama|meta\/)/.test(normalized) || normalized.includes('llama')) {
			return 'meta';
		}
		if (/(^|[/:\s._-])(mistral|mixtral|codestral|devstral|pixtral|ministral)/.test(normalized) || normalized.includes('mistral')) {
			return 'mistral';
		}
		if (/(^|[/:\s._-])(minimax|abab)/.test(normalized) || normalized.includes('minimax')) {
			return 'minimax';
		}
	}

	switch (fallbackEngineId) {
		case 'aexus-claude':
			return 'anthropic';
		case 'aexus-codex':
			return 'openai';
		case 'aexus-dsh':
			return 'deepseek';
		case 'aexus-antigravity':
			return 'gemini';
		default:
			return 'generic';
	}
}

export function buildAdeLlmIconSvg(doc: Document, kind: AdeLlmProviderKind): SVGElement {
	if (kind === 'openai') {
		const svg = createSvgElement(doc, 'svg', { viewBox: '-0.6 -0.6 25.2 25.2', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
		svg.appendChild(createSvgElement(doc, 'path', { d: OPENAI_BLOSSOM_D, fill: '#19C37D' }));
		return svg;
	}
	if (kind === 'anthropic') {
		const svg = createSvgElement(doc, 'svg', { viewBox: '-0.6 -0.6 25.2 25.2', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
		svg.appendChild(createSvgElement(doc, 'path', { d: CLAUDE_SUNBURST_D, fill: '#E07A5F' }));
		return svg;
	}
	if (kind === 'deepseek') {
		const svg = createSvgElement(doc, 'svg', { viewBox: '-1 -0.5 25.8 25', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
		svg.appendChild(createSvgElement(doc, 'path', { d: DEEPSEEK_WHALE_D, fill: '#5B7BFF' }));
		return svg;
	}
	if (kind === 'gemini') {
		const gradId = `ade-llm-gem-${++svgGradientUid}`;
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		const defs = createSvgElement(doc, 'defs', {});
		const grad = createSvgElement(doc, 'linearGradient', { id: gradId, x1: '2', y1: '2', x2: '22', y2: '22', gradientUnits: 'userSpaceOnUse' });
		grad.appendChild(createSvgElement(doc, 'stop', { offset: '0%', 'stop-color': '#38BDF8' }));
		grad.appendChild(createSvgElement(doc, 'stop', { offset: '52%', 'stop-color': '#4F8BFF' }));
		grad.appendChild(createSvgElement(doc, 'stop', { offset: '100%', 'stop-color': '#A855F7' }));
		defs.appendChild(grad);
		svg.appendChild(defs);
		svg.appendChild(createSvgElement(doc, 'path', { d: GEMINI_SPARKLE_D, fill: `url(#${gradId})` }));
		return svg;
	}
	if (kind === 'qwen') {
		const gradId = `ade-llm-qwen-${++svgGradientUid}`;
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		const defs = createSvgElement(doc, 'defs', {});
		const grad = createSvgElement(doc, 'linearGradient', { id: gradId, x1: '3', y1: '2', x2: '21', y2: '22', gradientUnits: 'userSpaceOnUse' });
		grad.appendChild(createSvgElement(doc, 'stop', { offset: '0%', 'stop-color': '#8B5CF6' }));
		grad.appendChild(createSvgElement(doc, 'stop', { offset: '55%', 'stop-color': '#6366F1' }));
		grad.appendChild(createSvgElement(doc, 'stop', { offset: '100%', 'stop-color': '#38BDF8' }));
		defs.appendChild(grad);
		svg.appendChild(defs);
		svg.appendChild(createSvgElement(doc, 'path', { d: QWEN_STAR_D, fill: `url(#${gradId})` }));
		svg.appendChild(createSvgElement(doc, 'circle', { cx: '12', cy: '12', r: '3.2', fill: '#0b1020' }));
		svg.appendChild(createSvgElement(doc, 'path', { d: 'M13.5 13.5L17.2 17.2', stroke: '#E0E7FF', 'stroke-width': '2', 'stroke-linecap': 'round' }));
		return svg;
	}
	if (kind === 'kimi') {
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		svg.appendChild(createSvgElement(doc, 'circle', { cx: '12', cy: '12', r: '9.5', fill: 'none', stroke: '#38BDF8', 'stroke-width': '2' }));
		svg.appendChild(createSvgElement(doc, 'path', { d: 'M8.5 7.5V16.5M8.5 12L15.2 7.5M11.2 10.6L15.8 16.5', fill: 'none', stroke: '#F8FAFC', 'stroke-width': '2.1', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
		svg.appendChild(createSvgElement(doc, 'circle', { cx: '17.6', cy: '6.2', r: '1.9', fill: '#38BDF8' }));
		return svg;
	}
	if (kind === 'glm') {
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		svg.appendChild(createSvgElement(doc, 'rect', { x: '2.5', y: '2.5', width: '19', height: '19', rx: '5', fill: '#2563EB', 'fill-opacity': '0.24', stroke: '#60A5FA', 'stroke-width': '1.6' }));
		svg.appendChild(createSvgElement(doc, 'path', { d: 'M7 7.5H17L7 16.5H17', fill: 'none', stroke: '#93C5FD', 'stroke-width': '2.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
		return svg;
	}
	if (kind === 'grok') {
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		svg.appendChild(createSvgElement(doc, 'circle', { cx: '12', cy: '12', r: '8.5', fill: 'none', stroke: '#E2E8F0', 'stroke-width': '2.1' }));
		svg.appendChild(createSvgElement(doc, 'path', { d: 'M4.5 19.5L19.5 4.5', stroke: '#F8FAFC', 'stroke-width': '2.4', 'stroke-linecap': 'round' }));
		return svg;
	}
	if (kind === 'meta') {
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		svg.appendChild(createSvgElement(doc, 'path', {
			d: `${META_INFINITY_D}M17.2 6.5C19.9 6.5 22 9.1 22 12.2C22 15.1 20.3 17.5 17.9 17.5C15.9 17.5 14.4 16.1 12.6 13.1L11.4 10.9C9.9 8.4 8.6 7.5 7.1 7.5C5.2 7.5 4 9.4 4 12C4 14.5 5.3 16.2 7 16.2`,
			fill: 'none',
			stroke: '#38BDF8',
			'stroke-width': '2.1',
			'stroke-linecap': 'round',
			'stroke-linejoin': 'round',
		}));
		return svg;
	}
	if (kind === 'mistral') {
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		const blocks: readonly [string, string, string, string, string][] = [
			['3', '4', '4', '3.2', '#FFD800'],
			['17', '4', '4', '3.2', '#FFD800'],
			['3', '7.6', '7.5', '3.2', '#FFAF00'],
			['13.5', '7.6', '7.5', '3.2', '#FFAF00'],
			['3', '11.2', '18', '3.2', '#FF8205'],
			['3', '14.8', '4', '3.2', '#FA520F'],
			['10', '14.8', '4', '3.2', '#FA520F'],
			['17', '14.8', '4', '3.2', '#FA520F'],
			['3', '18.4', '4', '2.8', '#E10500'],
			['17', '18.4', '4', '2.8', '#E10500'],
		];
		for (const [x, y, width, height, fill] of blocks) {
			svg.appendChild(createSvgElement(doc, 'rect', { x, y, width, height, rx: '0.6', fill }));
		}
		return svg;
	}
	if (kind === 'minimax') {
		const gradId = `ade-llm-mm-${++svgGradientUid}`;
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		const defs = createSvgElement(doc, 'defs', {});
		const grad = createSvgElement(doc, 'linearGradient', { id: gradId, x1: '2', y1: '18', x2: '22', y2: '6', gradientUnits: 'userSpaceOnUse' });
		grad.appendChild(createSvgElement(doc, 'stop', { offset: '0%', 'stop-color': '#FB7185' }));
		grad.appendChild(createSvgElement(doc, 'stop', { offset: '100%', 'stop-color': '#A855F7' }));
		defs.appendChild(grad);
		svg.appendChild(defs);
		svg.appendChild(createSvgElement(doc, 'path', { d: 'M3.5 16.5V7.5L8.2 13L12 8.2L15.8 13L20.5 7.5V16.5', fill: 'none', stroke: `url(#${gradId})`, 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
		return svg;
	}

	const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
	svg.appendChild(createSvgElement(doc, 'rect', { x: '3', y: '3', width: '7.5', height: '7.5', rx: '2', fill: '#94A3B8', 'fill-opacity': '0.92' }));
	svg.appendChild(createSvgElement(doc, 'rect', { x: '13.5', y: '3', width: '7.5', height: '7.5', rx: '2', fill: '#94A3B8', 'fill-opacity': '0.62' }));
	svg.appendChild(createSvgElement(doc, 'rect', { x: '3', y: '13.5', width: '7.5', height: '7.5', rx: '2', fill: '#94A3B8', 'fill-opacity': '0.62' }));
	svg.appendChild(createSvgElement(doc, 'rect', { x: '13.5', y: '13.5', width: '7.5', height: '7.5', rx: '2', fill: '#94A3B8', 'fill-opacity': '0.92' }));
	return svg;
}

export function renderAdeLlmIcon(
	container: HTMLElement,
	kind: AdeLlmProviderKind,
	options: { readonly baseClass: string; readonly prefix: string; readonly tooltip?: string },
): void {
	const label = options.tooltip || ADE_LLM_PROVIDER_LABELS[kind];
	container.title = label;
	container.setAttribute('aria-label', label);
	const expectedClass = `${options.baseClass} ${options.prefix}-${kind}`;
	if (container.dataset.llmProvider === kind && container.className === expectedClass && container.firstChild) {
		return;
	}
	container.dataset.llmProvider = kind;
	container.className = expectedClass;
	container.style.backgroundImage = '';
	container.replaceChildren(buildAdeLlmIconSvg(container.ownerDocument, kind));
}
