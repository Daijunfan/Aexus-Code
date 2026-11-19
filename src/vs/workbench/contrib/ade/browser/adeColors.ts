/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';

/**
 * ADE color registrations.
 *
 * These colors back the `--vscode-ade-*` CSS variables consumed by the workbench-level
 * `aexusTokens.css` sheet (rank/tier grammar, severity and cloud accents). Registering
 * them through the theme registry lets themes override ranks and severities natively,
 * while the stylesheet keeps sensible dark/light/high-contrast fallbacks.
 */

export const ADE_RANK_GOVERNOR = registerColor('ade.rank.governor', {
	dark: '#F2C35B',
	light: '#9A6700',
	hcDark: '#FFD666',
	hcLight: '#7A5200'
}, localize('ade.rank.governor', "Color of the L1 Governor (Sovereign Gold) rank in Aexus ADE surfaces."));

export const ADE_RANK_MANAGER = registerColor('ade.rank.manager', {
	dark: '#818CF8',
	light: '#4F46E5',
	hcDark: '#A5B4FC',
	hcLight: '#3730A3'
}, localize('ade.rank.manager', "Color of the L2 Manager (Royal Indigo) rank in Aexus ADE surfaces."));

export const ADE_RANK_EMPLOYEE = registerColor('ade.rank.employee', {
	dark: '#A78BFA',
	light: '#6D28D9',
	hcDark: '#C4B5FD',
	hcLight: '#5B21B6'
}, localize('ade.rank.employee', "Color of the L3 Employee (Supervisory Violet) rank in Aexus ADE surfaces."));

export const ADE_RANK_WORKER = registerColor('ade.rank.worker', {
	dark: '#34D399',
	light: '#059669',
	hcDark: '#6EE7B7',
	hcLight: '#047857'
}, localize('ade.rank.worker', "Color of the L4 Worker (Execution Emerald) rank in Aexus ADE surfaces."));

export const ADE_RANK_MEMBER = registerColor('ade.rank.member', {
	dark: '#9AA4B2',
	light: '#566070',
	hcDark: '#FFFFFF',
	hcLight: '#000000'
}, localize('ade.rank.member', "Color of unranked members in Aexus ADE surfaces."));

export const ADE_SEVERITY_CRITICAL = registerColor('ade.severity.critical', {
	dark: '#F87171',
	light: '#DC2626',
	hcDark: '#FF8080',
	hcLight: '#B91C1C'
}, localize('ade.severity.critical', "Color for critical severity states in Aexus ADE surfaces."));

export const ADE_SEVERITY_GATE = registerColor('ade.severity.gate', {
	dark: '#FF7AB8',
	light: '#B8237A',
	hcDark: '#FF9FCB',
	hcLight: '#9D174D'
}, localize('ade.severity.gate', "Color for human-in-the-loop gate states in Aexus ADE surfaces."));

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
}, localize('ade.studio.success', "Solid success accent in the ADE Engineering & Research Studio."));

export const ADE_STUDIO_WARNING = registerColor('ade.studio.warning', {
	dark: '#F5B942',
	light: '#B45309',
	hcDark: '#FDE047',
	hcLight: '#92400E'
}, localize('ade.studio.warning', "Warning accent in the ADE Engineering & Research Studio."));

export const ADE_STUDIO_RESEARCH_ACCENT = registerColor('ade.studio.researchAccent', {
	dark: '#F59E0B',
	light: '#B45309',
	hcDark: '#FCD34D',
	hcLight: '#92400E'
}, localize('ade.studio.researchAccent', "Primary accent for Research Mode canvases in the ADE Studio."));

export const ADE_STUDIO_RESEARCH_SECONDARY = registerColor('ade.studio.researchSecondary', {
	dark: '#EC4899',
	light: '#BE185D',
	hcDark: '#F9A8D4',
	hcLight: '#9D174D'
}, localize('ade.studio.researchSecondary', "Secondary accent for Research Mode canvases in the ADE Studio."));
