/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh, isWindows } from '../../base/common/platform.js';
import {
	ADE_OS_ICON_LABELS,
	AdeOsIconKind,
	resolveAdeOsIconKind,
} from '../../platform/ade/common/adeCloudHosts.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Apple silhouette & Kali Linux dragon vector paths inspired by Aexus-Bot's TeamOSIcon.
const APPLE_PATH_D = 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701';

const KALI_PATH_D = 'm71.766572 36.353532s-10.212-.6795-27.602 4.7619c-17.722 5.5452-27.773 13.405-27.773 13.405s26.414-14.748 56.228-15.586zm38.089998 16.035 1.3276-.08664s-7.6062-9.2286-22.164998-13.724c8.1839 3.3267 15.306998 7.7345 20.836998 13.81zm2.1727 3.8344c.20411-.3539.86302 1.1243 1.3634 1.7453.0212.124.0564.19967-.23373.13998-.0244-.12747-.0665-.16444-.0665-.16444s-.70029-.41667-.91499-.71224c-.21487-.29556-.253-.81255-.14825-1.0086zm17.867 43.930008s1.6147-18.538008-27.511-22.812008c-3.691498-.54163-8.359898-.9585-13.081998-.97044-23.344.30865-24.195-26.924-6.6044-28.299 7.2901-.60152 15.995 3.3311 24.504998 7.2941-.0316 1.0569.0121 1.9961.70646 2.864.69414.86762 3.3607 1.8142 4.2128 2.3031.85203.48907 3.5816 2.2245 5.2543 4.4017.36275-.67854 3.3921-2.6504 3.3921-2.6504s-.72571.01579-2.414-.61519c-1.6885-.63098-3.6921-2.5401-3.7395-2.6504-.0473-.11052-.0788-.28401.31578-.36295.2996-.25224-.37893-1.0727-.67874-1.3723-.2996-.2998-2.3036-3.7073-2.3508-3.7863-.0473-.07894-.0632-.1577-.20507-.25243-.4419-.1421-2.3826.20506-2.3826.20506s-2.9847-1.4659-4.0135-4.6264c.015.55358-.5118 1.158 0 2.4298-1.5562-.65832-2.8929-1.7811-3.9472-4.5557-.62751 1.5781 0 2.5815 0 2.5815s-3.664598-1.024-4.250898-4.4036c-.6435 1.5171 0 2.4296 0 2.4296s-5.9742-3.1172-15.901-3.1624c-6.646-.60961-8.0296-12.301-7.4139-14.269 0 0-9.586-5.0521-28.456-7.2841-18.87-2.2322-34.346-.33638-34.346-.33638s33.421-1.6039 60.195 9.2356c.91018 4.0709 3.6482 10.851 5.1229 14.11-4.2197 2.9175-8.9781 5.6609-9.7191 15.391-.74074 9.7297 7.6245 18.288 17.998 18.552 9.8502.52469 16.655998.59921 24.904998 4.8759 7.8739 4.3537 14.33 17.620008 14.969 29.551008.69008-8.8524-2.632-27.889008-18.134-33.669008 21.667 3.7917 23.573 19.854008 23.573 19.854008zm-58.639998-65.253008-.77963-2.5147s-12.864-2.2844-30.16-1.055-34.759 7.2839-34.759 7.2839 35.732-8.991 65.698-3.7143';

// Authentic tapered Debian Open-Use Swirl (24x24 viewBox, optically centered inside the crimson roundel).
const DEBIAN_SWIRL_D = 'M9.82 19.17Q9.93 18.87 8.46 17.39Q6.99 15.90 6.57 13.94Q6.15 11.99 6.79 10.25Q7.44 8.52 8.78 7.57Q10.11 6.63 11.57 6.66Q13.04 6.70 14.14 7.56Q15.25 8.43 15.67 9.73Q16.08 11.04 15.75 12.25Q15.41 13.47 14.58 14.17Q13.74 14.87 12.80 14.91Q11.85 14.95 11.14 14.44Q10.42 13.93 10.16 13.16Q9.90 12.39 10.11 11.74Q10.32 11.09 10.74 10.86Q11.15 10.63 11.31 10.36Q11.48 10.09 10.56 10.24Q9.65 10.40 9.16 11.34Q8.67 12.28 8.92 13.50Q9.17 14.72 10.22 15.64Q11.27 16.55 12.81 16.60Q14.35 16.65 15.72 15.64Q17.10 14.62 17.67 12.83Q18.24 11.04 17.67 9.11Q17.09 7.18 15.44 5.89Q13.79 4.60 11.62 4.58Q9.45 4.57 7.63 5.95Q5.81 7.33 5.09 9.62Q4.37 11.92 5.08 14.28Q5.80 16.64 7.75 18.05Q9.70 19.47 9.82 19.17Z';

export function resolveLocalOsIconKind(hint?: string): AdeOsIconKind {
	if (isMacintosh) {
		return 'macos';
	}
	if (isWindows) {
		return 'windows';
	}
	return resolveAdeOsIconKind({ os: 'linux', hint });
}

function createSvgElement(doc: Document, tag: string, attrs: Record<string, string>): SVGElement {
	const el = doc.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) {
		el.setAttribute(k, v);
	}
	return el;
}

export function buildAdeOsIconSvg(doc: Document, kind: AdeOsIconKind): SVGElement {
	if (kind === 'macos') {
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		const group = createSvgElement(doc, 'g', { transform: 'translate(2.5 2) scale(0.83)' });
		group.appendChild(createSvgElement(doc, 'path', { d: APPLE_PATH_D, fill: 'currentColor' }));
		svg.appendChild(group);
		return svg;
	}
	if (kind === 'windows') {
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		const panes: ReadonlyArray<readonly [string, string, string]> = [
			['3', '3', '#00ADEF'],
			['12.6', '3', '#0095E8'],
			['3', '12.6', '#0078D4'],
			['12.6', '12.6', '#0067B8'],
		];
		for (const [x, y, fill] of panes) {
			svg.appendChild(createSvgElement(doc, 'rect', { x, y, width: '8.4', height: '8.4', rx: '0.6', fill }));
		}
		return svg;
	}
	if (kind === 'ubuntu') {
		// Authentic Canonical Circle of Friends: 3 segmented shoulder arcs + 3 nestled friend heads at 120 deg.
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		svg.appendChild(createSvgElement(doc, 'circle', { cx: '12', cy: '12', r: '11.2', fill: '#E95420' }));
		svg.appendChild(createSvgElement(doc, 'circle', { cx: '12', cy: '12', r: '4.9', fill: 'none', stroke: '#FFFFFF', 'stroke-width': '2.05' }));
		// Radial hand-separation splits at 0 deg, 120 deg, 240 deg
		for (const d of ['M15.1 12L19.2 12', 'M10.45 14.68L8.4 18.24', 'M10.45 9.32L8.4 5.76']) {
			svg.appendChild(createSvgElement(doc, 'path', { d, stroke: '#E95420', 'stroke-width': '1.25', 'stroke-linecap': 'butt' }));
		}
		// Three friend heads at 180 deg (9 o'clock), -60 deg (1 o'clock), and 60 deg (5 o'clock) with crisp cutouts
		for (const [cx, cy] of [['4.55', '12'], ['15.73', '5.55'], ['15.73', '18.45']]) {
			svg.appendChild(createSvgElement(doc, 'circle', { cx, cy, r: '2.25', fill: '#E95420' }));
			svg.appendChild(createSvgElement(doc, 'circle', { cx, cy, r: '1.55', fill: '#FFFFFF' }));
		}
		return svg;
	}
	if (kind === 'kali') {
		// Authentic self-contained Kali Linux royal-sapphire emblem + optically weighted white dragon (crisp from 13px to 32px in Dark & Light themes).
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		svg.appendChild(createSvgElement(doc, 'circle', { cx: '12', cy: '12', r: '11.2', fill: '#1E40AF' }));
		svg.appendChild(createSvgElement(doc, 'circle', {
			cx: '12',
			cy: '12',
			r: '10.55',
			fill: 'none',
			stroke: 'rgba(147,197,253,0.34)',
			'stroke-width': '0.7',
		}));
		const group = createSvgElement(doc, 'g', { transform: 'translate(1.15 2.35) scale(0.148)' });
		group.appendChild(createSvgElement(doc, 'path', {
			d: KALI_PATH_D,
			fill: '#FFFFFF',
			stroke: '#FFFFFF',
			'stroke-width': '2.8',
			'stroke-linejoin': 'round',
			'stroke-linecap': 'round',
		}));
		svg.appendChild(group);
		return svg;
	}
	if (kind === 'debian') {
		// Authentic Debian Open-Use Swirl on Rubine Red roundel.
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		svg.appendChild(createSvgElement(doc, 'circle', { cx: '12', cy: '12', r: '11.2', fill: '#D70A53' }));
		svg.appendChild(createSvgElement(doc, 'path', { d: DEBIAN_SWIRL_D, fill: '#FFFFFF' }));
		return svg;
	}
	if (kind === 'enterprise-linux') {
		// Sleek Enterprise Linux (RHEL / Rocky) crimson roundel with iconic geometric fedora silhouette.
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		svg.appendChild(createSvgElement(doc, 'circle', { cx: '12', cy: '12', r: '11.2', fill: '#CC0000' }));
		svg.appendChild(createSvgElement(doc, 'path', {
			d: 'M7.2 12.1c.5-2.3 1.4-4.6 2.8-4.9.7-.2 1.4.2 2.1.3.8.1 1.6-.4 2.4-.2 1.2.3 2 2.4 2.3 4.8-.6.9-2.3 1.5-4.8 1.3-2.5-.2-4.3-.7-4.8-1.3Z',
			fill: '#FFFFFF',
		}));
		svg.appendChild(createSvgElement(doc, 'path', {
			d: 'M7.3 11.4c1.3.7 3.1 1.1 4.8 1.2 1.8.1 3.5-.1 4.6-.7l.1.7c-1.1.6-2.9.9-4.7.8-1.9-.1-3.6-.5-4.9-1.2l.1-.8Z',
			fill: '#7F0000',
		}));
		svg.appendChild(createSvgElement(doc, 'path', {
			d: 'M4.2 13.7c-.4 1 1 2.9 4.9 3.8 4.4 1 8.8.4 10.4-1.3.5-.6.4-1.5-.6-2.1-.6-.4-1.4-.6-2.1-.7-.4 1.1-2.3 1.8-5.1 1.5-2.8-.2-4.6-1.1-5.1-2.1-1 .1-1.9.4-2.4.9Z',
			fill: '#FFFFFF',
		}));
		return svg;
	}
	// Generic Linux: sleek obsidian/slate medallion + refined minimalist Tux penguin silhouette (crisp 14px-32px in dark & light themes).
	const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true' });
	svg.appendChild(createSvgElement(doc, 'circle', { cx: '16', cy: '16', r: '15', fill: '#1E2633' }));
	svg.appendChild(createSvgElement(doc, 'circle', {
		cx: '16',
		cy: '16',
		r: '14.3',
		fill: 'none',
		stroke: 'rgba(255,255,255,0.18)',
		'stroke-width': '1',
	}));
	// Refined dark Tux silhouette with subtle light contour for crisp separation
	svg.appendChild(createSvgElement(doc, 'path', {
		d: 'M16 4.8c-3.3 0-5.4 2.3-5.4 5.7 0 1.3.3 2.4.7 3.3-2 1.9-3.5 4.4-3.9 6.8-.2 1 .4 1.7 1.3 1.5 1-.2 1.8-.9 2.3-1.7.6 2 2.3 3.6 5 3.6s4.4-1.6 5-3.6c.5.8 1.3 1.5 2.3 1.7.9.2 1.5-.5 1.3-1.5-.4-2.4-1.9-4.9-3.9-6.8.4-.9.7-2 .7-3.3 0-3.4-2.1-5.7-5.4-5.7Z',
		fill: '#0B0F17',
		stroke: 'rgba(248,250,252,0.28)',
		'stroke-width': '0.9',
		'stroke-linejoin': 'round',
	}));
	// Crisp snow-white Tux belly
	svg.appendChild(createSvgElement(doc, 'ellipse', { cx: '16', cy: '19.2', rx: '4.2', ry: '5', fill: '#F8FAFC' }));
	// Minimal sleek eyes (zero cartoonish giant eyeballs)
	svg.appendChild(createSvgElement(doc, 'circle', { cx: '14.1', cy: '9.9', r: '0.9', fill: '#F8FAFC' }));
	svg.appendChild(createSvgElement(doc, 'circle', { cx: '17.9', cy: '9.9', r: '0.9', fill: '#F8FAFC' }));
	// Crisp Linux-gold Tux beak & feet
	svg.appendChild(createSvgElement(doc, 'circle', { cx: '16', cy: '12.5', r: '1.25', fill: '#F5C211' }));
	svg.appendChild(createSvgElement(doc, 'path', {
		d: 'M13.8 12.3c1.2-.8 3.2-.8 4.4 0 .4.3.3.8-.1 1.1l-1.7 1.1c-.25.16-.55.16-.8 0l-1.7-1.1c-.4-.3-.5-.8-.1-1.1Z',
		fill: '#F5C211',
	}));
	svg.appendChild(createSvgElement(doc, 'path', {
		d: 'M9.6 24.4c0-.95 1.3-1.55 2.9-1.4 1.4.15 2.2.8 2.2 1.6 0 .85-1.2 1.5-2.7 1.5-1.45 0-2.4-.7-2.4-1.7Z',
		fill: '#F5C211',
	}));
	svg.appendChild(createSvgElement(doc, 'path', {
		d: 'M22.4 24.4c0-.95-1.3-1.55-2.9-1.4-1.4.15-2.2.8-2.2 1.6 0 .85 1.2 1.5 2.7 1.5 1.45 0 2.4-.7 2.4-1.7Z',
		fill: '#F5C211',
	}));
	return svg;
}

export function renderAdeOsIcon(
	container: HTMLElement,
	kind: AdeOsIconKind,
	options: { readonly baseClass: string; readonly prefix: string; readonly tooltip?: string },
): void {
	const label = options.tooltip || ADE_OS_ICON_LABELS[kind];
	container.title = label;
	container.setAttribute('aria-label', label);
	const expectedClass = `${options.baseClass} ${options.prefix}-${kind}`;
	if (container.dataset.os === kind && container.className === expectedClass && container.firstChild) {
		return;
	}
	container.dataset.os = kind;
	container.className = expectedClass;
	container.style.backgroundImage = '';
	container.replaceChildren(buildAdeOsIconSvg(container.ownerDocument, kind));
}
