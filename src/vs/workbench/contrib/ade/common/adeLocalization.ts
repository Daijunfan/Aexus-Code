/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { language } from '../../../../base/common/platform.js';
import { getNLSLanguage } from '../../../../nls.js';

export const ADE_DISPLAY_LANGUAGE_CONFIG_KEY = 'aexus.ade.displayLanguage';

export type AdeDisplayLanguageSetting = 'auto' | 'en' | 'zh-cn';
export type AdeResolvedLocale = 'en' | 'zh-cn';

const _onDidChangeAdeLocale = new Emitter<AdeResolvedLocale>();
export const onDidChangeAdeLocale: Event<AdeResolvedLocale> = _onDidChangeAdeLocale.event;

let displayLanguageOverride: AdeDisplayLanguageSetting = 'auto';

function normalizeDisplayLanguageSetting(raw: unknown): AdeDisplayLanguageSetting {
	if (typeof raw !== 'string') {
		return 'auto';
	}
	const norm = raw.trim().toLowerCase();
	if (norm === 'zh' || norm === 'zh-cn' || norm === 'zh-hans' || norm === 'zh-tw' || norm === 'zh-hant') {
		return 'zh-cn';
	}
	if (norm === 'en' || norm === 'en-us' || norm === 'en-gb') {
		return 'en';
	}
	return 'auto';
}

export function getAdeDisplayLanguageSetting(): AdeDisplayLanguageSetting {
	return displayLanguageOverride;
}

export function resolveAdeLocale(): AdeResolvedLocale {
	if (displayLanguageOverride === 'zh-cn') {
		return 'zh-cn';
	}
	if (displayLanguageOverride === 'en') {
		return 'en';
	}
	const activeLang = (getNLSLanguage() || language || 'en').toLowerCase();
	return activeLang.startsWith('zh') ? 'zh-cn' : 'en';
}

export function isAdeChineseLocale(): boolean {
	return resolveAdeLocale() === 'zh-cn';
}

export function setAdeDisplayLanguageOverride(next: AdeDisplayLanguageSetting | string | undefined): AdeResolvedLocale {
	const normalized = normalizeDisplayLanguageSetting(next);
	const prevResolved = resolveAdeLocale();
	displayLanguageOverride = normalized;
	const nextResolved = resolveAdeLocale();
	if (nextResolved !== prevResolved) {
		_onDidChangeAdeLocale.fire(nextResolved);
	}
	return nextResolved;
}

function formatMessageArgs(template: string, args: readonly (string | number | boolean | undefined | null)[]): string {
	if (args.length === 0) {
		return template;
	}
	return template.replace(/\{(\d+)\}/g, (match, indexStr) => {
		const idx = Number.parseInt(indexStr, 10);
		if (idx < 0 || idx >= args.length) {
			return match;
		}
		const val = args[idx];
		return val === undefined || val === null ? '' : String(val);
	});
}

export function adeBi(
	enLocalized: string,
	zhTemplate: string,
	...args: (string | number | boolean | undefined | null)[]
): string {
	if (!isAdeChineseLocale()) {
		return enLocalized;
	}
	return formatMessageArgs(zhTemplate, args);
}
