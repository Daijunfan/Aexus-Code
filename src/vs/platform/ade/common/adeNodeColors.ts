/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Curated per-node accent color palette & lossless normalization helpers shared across
 * Engineering Orchestration (Staff + Whiteboards) and Mission Task DAG views.
 */

export interface IAdeNodeColorPreset {
	readonly id: string;
	readonly labelEn: string;
	readonly labelZh: string;
	readonly hex: string;
}

export const ADE_NODE_COLOR_PRESETS: readonly IAdeNodeColorPreset[] = [
	{ id: 'gold', labelEn: 'Executive Gold', labelZh: '曜石金', hex: '#f59e0b' },
	{ id: 'cyan', labelEn: 'Quantum Cyan', labelZh: '量子青', hex: '#22d3ee' },
	{ id: 'sky', labelEn: 'Azure Sky', labelZh: '天穹蓝', hex: '#38bdf8' },
	{ id: 'indigo', labelEn: 'Electric Indigo', labelZh: '星云靛', hex: '#818cf8' },
	{ id: 'violet', labelEn: 'Nebula Violet', labelZh: '紫晶紫', hex: '#a78bfa' },
	{ id: 'rose', labelEn: 'Plasma Rose', labelZh: '绯红玫', hex: '#fb7185' },
	{ id: 'pink', labelEn: 'Neon Pink', labelZh: '霓虹粉', hex: '#f472b6' },
	{ id: 'emerald', labelEn: 'Matrix Emerald', labelZh: '翡翠绿', hex: '#34d399' },
	{ id: 'teal', labelEn: 'Cyber Teal', labelZh: '赛博碧', hex: '#2dd4bf' },
	{ id: 'amber', labelEn: 'Solar Amber', labelZh: '琥珀黄', hex: '#fbbf24' },
	{ id: 'orange', labelEn: 'Forge Orange', labelZh: '熔岩橙', hex: '#fb923c' },
	{ id: 'slate', labelEn: 'Titanium Slate', labelZh: '钛银灰', hex: '#94a3b8' },
];

const PRESET_BY_ID = new Map<string, IAdeNodeColorPreset>(
	ADE_NODE_COLOR_PRESETS.map(p => [p.id, p]),
);

const COLOR_ALIASES: Readonly<Record<string, string>> = {
	yellow: 'amber',
	blue: 'sky',
	purple: 'violet',
	green: 'emerald',
	red: 'rose',
	crimson: 'rose',
	magenta: 'pink',
	gray: 'slate',
	grey: 'slate',
	silver: 'slate',
};

const HEX3_RE = /^#([0-9a-f]{3})$/i;
const HEX6_RE = /^#([0-9a-f]{6})$/i;

/**
 * Normalizes a user- or code-supplied node color value into either a canonical preset ID
 * (e.g. `'gold'`, `'cyan'`) or a lowercase `#rrggbb` hex string.
 * Returns `undefined` for empty/reset/invalid values (`'default'`, `'auto'`, `'none'`, etc.).
 */
export function normalizeAdeNodeColor(raw: string | null | undefined): string | undefined {
	if (typeof raw !== 'string') {
		return undefined;
	}
	const trimmed = raw.trim().toLowerCase();
	if (!trimmed || trimmed === 'default' || trimmed === 'auto' || trimmed === 'none' || trimmed === 'reset') {
		return undefined;
	}
	if (PRESET_BY_ID.has(trimmed)) {
		return trimmed;
	}
	const aliased = COLOR_ALIASES[trimmed];
	if (aliased && PRESET_BY_ID.has(aliased)) {
		return aliased;
	}
	const m6 = HEX6_RE.exec(trimmed);
	if (m6) {
		return `#${m6[1].toLowerCase()}`;
	}
	const m3 = HEX3_RE.exec(trimmed);
	if (m3) {
		const [r, g, b] = m3[1].toLowerCase();
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	return undefined;
}

/**
 * Resolves a preset ID or hex string into a concrete `#rrggbb` color hex for CSS custom properties and SVG.
 */
export function resolveAdeNodeColorHex(raw: string | null | undefined): string | undefined {
	const normalized = normalizeAdeNodeColor(raw);
	if (!normalized) {
		return undefined;
	}
	const preset = PRESET_BY_ID.get(normalized);
	if (preset) {
		return preset.hex;
	}
	return normalized;
}
