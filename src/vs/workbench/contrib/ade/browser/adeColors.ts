/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';

/**
 * ADE theme color registrations backing `--vscode-ade-*` CSS variables.
 */

export const ADE_SEVERITY_CRITICAL = registerColor('ade.severity.critical', {
	dark: '#F87171',
	light: '#DC2626',
	hcDark: '#FF8080',
	hcLight: '#B91C1C'
}, localize('ade.severity.critical', "Color for critical severity states in Aexus ADE surfaces."));

export const ADE_SEVERITY_INFO = registerColor('ade.severity.info', {
	dark: '#60A5FA',
	light: '#2563EB',
	hcDark: '#93C5FD',
	hcLight: '#1D4ED8'
}, localize('ade.severity.info', "Color for informational severity states in Aexus ADE surfaces."));

export const ADE_CLOUD = registerColor('ade.cloud', {
	dark: '#38BDF8',
	light: '#0284C7',
	hcDark: '#7DD3FC',
	hcLight: '#075985'
}, localize('ade.cloud', "Accent color for cloud hosts in Aexus ADE surfaces."));

export const ADE_STUDIO_SUCCESS = registerColor('ade.studio.success', {
	dark: '#10B981',
	light: '#059669',
	hcDark: '#6EE7B7',
	hcLight: '#047857'
}, localize('ade.studio.success', "Solid success accent in the ADE Project Canvas."));

export const ADE_STUDIO_WARNING = registerColor('ade.studio.warning', {
	dark: '#F5B942',
	light: '#B45309',
	hcDark: '#FDE047',
	hcLight: '#92400E'
}, localize('ade.studio.warning', "Warning accent in the ADE Project Canvas."));

export const ADE_STUDIO_RESEARCH_ACCENT = registerColor('ade.studio.researchAccent', {
	dark: '#F59E0B',
	light: '#B45309',
	hcDark: '#FCD34D',
	hcLight: '#92400E'
}, localize('ade.studio.researchAccent', "Primary warm accent in the ADE Project Canvas."));

export const ADE_STUDIO_RESEARCH_SECONDARY = registerColor('ade.studio.researchSecondary', {
	dark: '#EC4899',
	light: '#BE185D',
	hcDark: '#F9A8D4',
	hcLight: '#9D174D'
}, localize('ade.studio.researchSecondary', "Secondary warm accent in the ADE Project Canvas."));

export const ADE_STUDIO_ACCENT = registerColor('ade.studio.accent', {
	dark: '#38BDF8',
	light: '#0369A1',
	hcDark: '#7DD3FC',
	hcLight: '#075985'
}, localize('ade.studio.accent', "Primary interactive accent in the ADE Project Canvas."));

export const ADE_STUDIO_DANGER = registerColor('ade.studio.danger', {
	dark: '#F87171',
	light: '#B91C1C',
	hcDark: '#FF8080',
	hcLight: '#991B1B'
}, localize('ade.studio.danger', "Danger and error accent in the ADE Project Canvas."));

export const ADE_STUDIO_REWORK = registerColor('ade.studio.rework', {
	dark: '#C084FC',
	light: '#6D28D9',
	hcDark: '#E9D5FF',
	hcLight: '#5B21B6'
}, localize('ade.studio.rework', "Secondary violet accent in the ADE Project Canvas."));

export const ADE_STUDIO_MUTED_INK = registerColor('ade.studio.mutedInk', {
	dark: '#CBD5E1',
	light: '#334155',
	hcDark: '#FFFFFF',
	hcLight: '#000000'
}, localize('ade.studio.mutedInk', "Muted secondary text ink meeting WCAG AA contrast in the ADE Project Canvas."));
