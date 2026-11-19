/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ThemeIcon } from '../../../../base/common/themables.js';
import {
	ADE_OS_ICON_LABELS,
	AdeOsIconKind,
	resolveAdeOsIconKind,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import { renderAdeOsIcon, resolveLocalOsIconKind } from '../../../browser/adeOsIcon.js';
import { ITerminalInstance } from './terminal.js';

const STANDARD_TERMINAL_ICON_IDS = new Set([
	'terminal',
	'remote',
	'terminal-bash',
	'terminal-cmd',
	'terminal-powershell',
	'terminal-linux',
	'terminal-ubuntu',
	'terminal-debian',
	'terminal-tmux',
]);

export function shouldShowTerminalOsIcon(instance: ITerminalInstance): boolean {
	if (!instance.icon) {
		return true;
	}
	if (ThemeIcon.isThemeIcon(instance.icon)) {
		return STANDARD_TERMINAL_ICON_IDS.has(instance.icon.id);
	}
	return false;
}

export function resolveTerminalOsIconKind(instance: ITerminalInstance): AdeOsIconKind {
	const cfg = instance.shellLaunchConfig;
	if (cfg.hostOs || cfg.hostDistribution || cfg.isRemotePty || cfg.hostLabel) {
		return resolveAdeOsIconKind({
			os: cfg.hostOs,
			distribution: cfg.hostDistribution,
			hint: `${cfg.hostLabel ?? ''} ${instance.title ?? ''}`,
		});
	}
	return resolveLocalOsIconKind(instance.title);
}

export function getTerminalOsTooltip(instance: ITerminalInstance, kind: AdeOsIconKind): string {
	const osLabel = ADE_OS_ICON_LABELS[kind];
	const host = instance.shellLaunchConfig.hostLabel;
	return host ? `${osLabel} · ${host}` : osLabel;
}

export function renderTerminalOsIcon(container: HTMLElement, kind: AdeOsIconKind, tooltip?: string): void {
	renderAdeOsIcon(container, kind, {
		baseClass: 'terminal-os-icon',
		prefix: 'terminal-os',
		tooltip,
	});
}
