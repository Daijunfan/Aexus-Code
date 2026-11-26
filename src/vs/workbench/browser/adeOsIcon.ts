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

export type { AdeOsIconKind };

const SVG_NS = 'http://www.w3.org/2000/svg';

// Apple silhouette & Kali Linux dragon vector paths inspired by Aexus-Bot's TeamOSIcon.
const APPLE_PATH_D = 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701';

const KALI_PATH_D = 'm71.766572 36.353532s-10.212-.6795-27.602 4.7619c-17.722 5.5452-27.773 13.405-27.773 13.405s26.414-14.748 56.228-15.586zm38.089998 16.035 1.3276-.08664s-7.6062-9.2286-22.164998-13.724c8.1839 3.3267 15.306998 7.7345 20.836998 13.81zm2.1727 3.8344c.20411-.3539.86302 1.1243 1.3634 1.7453.0212.124.0564.19967-.23373.13998-.0244-.12747-.0665-.16444-.0665-.16444s-.70029-.41667-.91499-.71224c-.21487-.29556-.253-.81255-.14825-1.0086zm17.867 43.930008s1.6147-18.538008-27.511-22.812008c-3.691498-.54163-8.359898-.9585-13.081998-.97044-23.344.30865-24.195-26.924-6.6044-28.299 7.2901-.60152 15.995 3.3311 24.504998 7.2941-.0316 1.0569.0121 1.9961.70646 2.864.69414.86762 3.3607 1.8142 4.2128 2.3031.85203.48907 3.5816 2.2245 5.2543 4.4017.36275-.67854 3.3921-2.6504 3.3921-2.6504s-.72571.01579-2.414-.61519c-1.6885-.63098-3.6921-2.5401-3.7395-2.6504-.0473-.11052-.0788-.28401.31578-.36295.2996-.25224-.37893-1.0727-.67874-1.3723-.2996-.2998-2.3036-3.7073-2.3508-3.7863-.0473-.07894-.0632-.1577-.20507-.25243-.4419-.1421-2.3826.20506-2.3826.20506s-2.9847-1.4659-4.0135-4.6264c.015.55358-.5118 1.158 0 2.4298-1.5562-.65832-2.8929-1.7811-3.9472-4.5557-.62751 1.5781 0 2.5815 0 2.5815s-3.664598-1.024-4.250898-4.4036c-.6435 1.5171 0 2.4296 0 2.4296s-5.9742-3.1172-15.901-3.1624c-6.646-.60961-8.0296-12.301-7.4139-14.269 0 0-9.586-5.0521-28.456-7.2841-18.87-2.2322-34.346-.33638-34.346-.33638s33.421-1.6039 60.195 9.2356c.91018 4.0709 3.6482 10.851 5.1229 14.11-4.2197 2.9175-8.9781 5.6609-9.7191 15.391-.74074 9.7297 7.6245 18.288 17.998 18.552 9.8502.52469 16.655998.59921 24.904998 4.8759 7.8739 4.3537 14.33 17.620008 14.969 29.551008.69008-8.8524-2.632-27.889008-18.134-33.669008 21.667 3.7917 23.573 19.854008 23.573 19.854008zm-58.639998-65.253008-.77963-2.5147s-12.864-2.2844-30.16-1.055-34.759 7.2839-34.759 7.2839 35.732-8.991 65.698-3.7143';

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

let kaliGradientSeq = 0;

export function buildAdeOsIconSvg(doc: Document, kind: AdeOsIconKind): SVGElement {
	if (kind === 'macos') {
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		svg.appendChild(createSvgElement(doc, 'path', { d: APPLE_PATH_D, fill: 'currentColor' }));
		return svg;
	}
	if (kind === 'windows') {
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true' });
		for (const [x, y] of [['3', '3'], ['17', '3'], ['3', '17'], ['17', '17']]) {
			svg.appendChild(createSvgElement(doc, 'rect', { x, y, width: '12', height: '12', rx: '1.5', fill: '#0078D4' }));
		}
		return svg;
	}
	if (kind === 'kali') {
		const gradId = `ade-kali-bg-${++kaliGradientSeq}`;
		const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		const defs = createSvgElement(doc, 'defs', {});
		const grad = createSvgElement(doc, 'linearGradient', {
			id: gradId,
			x1: '0%',
			y1: '0%',
			x2: '100%',
			y2: '100%',
		});
		grad.appendChild(createSvgElement(doc, 'stop', { offset: '0%', 'stop-color': '#38bdf8' }));
		grad.appendChild(createSvgElement(doc, 'stop', { offset: '52%', 'stop-color': '#2563eb' }));
		grad.appendChild(createSvgElement(doc, 'stop', { offset: '100%', 'stop-color': '#1d4ed8' }));
		defs.appendChild(grad);
		svg.appendChild(defs);
		// Solid fallback base circle + vivid Kali blue gradient disc + subtle inner highlight ring
		svg.appendChild(createSvgElement(doc, 'circle', { cx: '12', cy: '12', r: '11.25', fill: '#2563eb' }));
		svg.appendChild(createSvgElement(doc, 'circle', { cx: '12', cy: '12', r: '11.25', fill: `url(#${gradId})` }));
		svg.appendChild(createSvgElement(doc, 'circle', {
			cx: '12',
			cy: '12',
			r: '10.95',
			fill: 'none',
			stroke: 'rgba(255,255,255,0.28)',
			'stroke-width': '0.55',
		}));
		const dragonGroup = createSvgElement(doc, 'g', {
			transform: 'translate(2.45 2.45) scale(0.141)',
		});
		dragonGroup.appendChild(createSvgElement(doc, 'path', {
			d: KALI_PATH_D,
			fill: '#ffffff',
			stroke: '#ffffff',
			'stroke-width': '2.4',
			'stroke-linejoin': 'round',
		}));
		svg.appendChild(dragonGroup);
		return svg;
	}
	const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true' });
	svg.appendChild(createSvgElement(doc, 'circle', { cx: '16', cy: '16', r: '15', fill: '#E95420' }));
	svg.appendChild(createSvgElement(doc, 'circle', { cx: '16', cy: '16', r: '6.3', fill: 'none', stroke: '#fff', 'stroke-width': '2' }));
	svg.appendChild(createSvgElement(doc, 'circle', { cx: '16', cy: '4.5', r: '2.1', fill: '#fff' }));
	svg.appendChild(createSvgElement(doc, 'circle', { cx: '25.96', cy: '21.75', r: '2.1', fill: '#fff' }));
	svg.appendChild(createSvgElement(doc, 'circle', { cx: '6.04', cy: '21.75', r: '2.1', fill: '#fff' }));
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
