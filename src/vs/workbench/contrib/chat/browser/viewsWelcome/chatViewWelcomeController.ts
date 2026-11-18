/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asCSSUrl } from '../../../../../base/browser/cssValue.js';
import * as dom from '../../../../../base/browser/dom.js';
import { createCSSRule } from '../../../../../base/browser/domStylesheets.js';
import { IRenderedMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Event } from '../../../../../base/common/event.js';
import { StringSHA1 } from '../../../../../base/common/hash.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { localize } from '../../../../../nls.js';
import { asCssVariable } from '../../../../../platform/theme/common/colorUtils.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { chatWorkingProgressStableIconForeground } from '../../common/widget/chatColors.js';
import { chatWorkingLogoFacePaths, createChatWorkingLogoEmblem } from '../widget/chatWorkingLogoDraw.js';
import '../widget/media/chatWorkingLogo.css';
import { chatViewsWelcomeRegistry, IChatViewsWelcomeDescriptor } from './chatViewsWelcome.js';

const $ = dom.$;

export interface IViewWelcomeDelegate {
	readonly onDidChangeViewWelcomeState: Event<void>;
	shouldShowWelcome(): boolean;
}

export class ChatViewWelcomeController extends Disposable {
	private element: HTMLElement | undefined;

	private enabled = false;
	private readonly enabledDisposables = this._register(new DisposableStore());
	private readonly renderDisposables = this._register(new DisposableStore());

	private readonly _isShowingWelcome: ISettableObservable<boolean> = observableValue(this, false);
	public get isShowingWelcome(): IObservable<boolean> {
		return this._isShowingWelcome;
	}

	constructor(
		private readonly container: HTMLElement,
		private readonly delegate: IViewWelcomeDelegate,
		private readonly location: ChatAgentLocation,
		@IContextKeyService private contextKeyService: IContextKeyService,
		@IInstantiationService private instantiationService: IInstantiationService,
	) {
		super();

		this.element = dom.append(this.container, dom.$('.chat-view-welcome'));
		this._register(Event.runAndSubscribe(
			delegate.onDidChangeViewWelcomeState,
			() => this.update()));
		this._register(chatViewsWelcomeRegistry.onDidChange(() => this.update(true)));
	}

	getMatchingWelcomeView(): IChatViewsWelcomeDescriptor | undefined {
		const descriptors = chatViewsWelcomeRegistry.get();
		const matchingDescriptors = descriptors.filter(descriptor => this.contextKeyService.contextMatchesRules(descriptor.when));
		return matchingDescriptors.at(0);
	}

	private update(force?: boolean): void {
		const enabled = this.delegate.shouldShowWelcome();
		if (this.enabled === enabled && !force) {
			return;
		}

		this.enabled = enabled;
		this.enabledDisposables.clear();

		if (!enabled) {
			this.container.classList.toggle('chat-view-welcome-visible', false);
			this.renderDisposables.clear();
			this._isShowingWelcome.set(false, undefined);
			return;
		}

		const descriptors = chatViewsWelcomeRegistry.get();
		if (descriptors.length) {
			this.render(descriptors);

			const descriptorKeys: Set<string> = new Set(descriptors.flatMap(d => d.when.keys()));
			this.enabledDisposables.add(this.contextKeyService.onDidChangeContext(e => {
				if (e.affectsSome(descriptorKeys)) {
					this.render(descriptors);
				}
			}));
		}
	}

	private render(descriptors: ReadonlyArray<IChatViewsWelcomeDescriptor>): void {
		this.renderDisposables.clear();
		dom.clearNode(this.element!);

		const matchingDescriptors = descriptors.filter(descriptor => this.contextKeyService.contextMatchesRules(descriptor.when));
		const enabledDescriptor = matchingDescriptors.at(0);
		if (enabledDescriptor) {
			const content: IChatViewWelcomeContent = {
				icon: enabledDescriptor.icon,
				title: enabledDescriptor.title,
				message: enabledDescriptor.content
			};
			const welcomeView = this.renderDisposables.add(this.instantiationService.createInstance(ChatViewWelcomePart, content, { firstLinkToButton: true, location: this.location }));
			this.element!.appendChild(welcomeView.element);
			this.container.classList.toggle('chat-view-welcome-visible', true);
			this._isShowingWelcome.set(true, undefined);
		} else {
			this.container.classList.toggle('chat-view-welcome-visible', false);
			this._isShowingWelcome.set(false, undefined);
		}
	}
}

export interface IChatViewWelcomeContent {
	readonly icon?: ThemeIcon | URI;
	readonly title: string;
	readonly message: string | IMarkdownString;
	readonly primaryAction?: { readonly label: string; readonly href: string };
	readonly additionalMessage?: string | IMarkdownString;
	tips?: IMarkdownString;
	readonly inputPart?: HTMLElement;
	readonly useLargeIcon?: boolean;
	/** Renders the Aexus emblem as the hero mark instead of {@link icon}. */
	readonly useAexusEmblem?: boolean;
	/** Quick-start prompts rendered as a responsive card grid below the hero. */
	readonly quickStarts?: readonly IChatViewWelcomeQuickStart[];
}

export interface IChatViewWelcomeQuickStart {
	/** The mode group the card belongs to, e.g. "Agent", "Ask" or "Plan". */
	readonly group: string;
	readonly label: string;
	readonly prompt: string;
	readonly icon: ThemeIcon;
}

export interface IChatViewWelcomeRenderOptions {
	readonly firstLinkToButton?: boolean;
	readonly location: ChatAgentLocation;
	readonly isWidgetAgentWelcomeViewContent?: boolean;
	/** Invoked when a quick-start card is chosen. */
	readonly onDidSelectQuickStart?: (quickStart: IChatViewWelcomeQuickStart) => void;
}

export class ChatViewWelcomePart extends Disposable {
	public readonly element: HTMLElement;

	constructor(
		public readonly content: IChatViewWelcomeContent,
		options: IChatViewWelcomeRenderOptions | undefined,
		@IOpenerService private openerService: IOpenerService,
		@ILogService private logService: ILogService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
	) {
		super();

		this.element = dom.$('.chat-welcome-view');

		try {

			// Icon
			const icon = dom.append(this.element, $('.chat-welcome-view-icon'));
			if (content.useLargeIcon) {
				icon.classList.add('large-icon');
			}
			if (content.useAexusEmblem) {
				icon.classList.add('aexus-emblem');
				icon.appendChild(createChatWelcomeEmblem());
			} else if (content.icon) {
				if (ThemeIcon.isThemeIcon(content.icon)) {
					const iconElement = renderIcon(content.icon);
					icon.appendChild(iconElement);
				} else if (URI.isUri(content.icon)) {
					const cssUrl = asCSSUrl(content.icon);
					const hash = new StringSHA1();
					hash.update(cssUrl);
					const iconId = `chat-welcome-icon-${hash.digest()}`;
					const iconClass = `.chat-welcome-view-icon.${iconId}`;

					createCSSRule(iconClass, `
					mask: ${cssUrl} no-repeat 50% 50%;
					-webkit-mask: ${cssUrl} no-repeat 50% 50%;
					background-color: var(--vscode-icon-foreground);
				`);
					icon.classList.add(iconId, 'custom-icon');
				}
			}
			const title = dom.append(this.element, $('.chat-welcome-view-title'));
			title.textContent = content.title;

			const message = dom.append(this.element, $('.chat-welcome-view-message'));

			if (typeof content.message === 'string') {
				dom.append(message, $('p', undefined, content.message));
			} else {
				const messageResult = this.renderMarkdownMessageContent(content.message, options);
				dom.append(message, messageResult.element);
			}

			// Additional message
			if (content.additionalMessage) {
				const disclaimers = dom.append(this.element, $('.chat-welcome-view-disclaimer'));
				if (typeof content.additionalMessage === 'string') {
					disclaimers.textContent = content.additionalMessage;
				} else {
					const additionalMessageResult = this.renderMarkdownMessageContent(content.additionalMessage, options);
					disclaimers.appendChild(additionalMessageResult.element);
				}
			}

			// Tips
			if (content.tips) {
				const tips = dom.append(this.element, $('.chat-welcome-view-tips'));
				const tipsResult = this._register(this.markdownRendererService.render(content.tips));
				tips.appendChild(tipsResult.element);
			}

			if (content.primaryAction) {
				const action = content.primaryAction;
				const button = this._register(new Button(this.element, defaultButtonStyles));
				button.label = action.label;
				this._register(button.onDidClick(() => this.openerService.open(action.href, { allowCommands: true })));
			}

			// Quick-start cards
			if (content.quickStarts?.length) {
				this.renderQuickStarts(content.quickStarts, options);
			}
		} catch (err) {
			this.logService.error('Failed to render chat view welcome content', err);
		}
	}

	private renderQuickStarts(quickStarts: readonly IChatViewWelcomeQuickStart[], options: IChatViewWelcomeRenderOptions | undefined): void {
		const grid = dom.append(this.element, $('.chat-welcome-view-quick-starts', { role: 'list', 'aria-label': localize('chatWelcome.quickStarts', "Quick start prompts") }));
		for (const quickStart of quickStarts) {
			const card = dom.append(grid, $<HTMLButtonElement>('button.chat-welcome-view-quick-start', { type: 'button', role: 'listitem', title: quickStart.prompt }));
			const iconElement = renderIcon(quickStart.icon);
			iconElement.setAttribute('aria-hidden', 'true');
			card.appendChild(iconElement);
			const text = dom.append(card, $('span.chat-welcome-view-quick-start-text'));
			dom.append(text, $('span.chat-welcome-view-quick-start-group', undefined, quickStart.group));
			dom.append(text, $('span.chat-welcome-view-quick-start-label', undefined, quickStart.label));
			card.setAttribute('aria-label', localize('chatWelcome.quickStartAria', "{0}: {1}", quickStart.group, quickStart.label));
			if (options?.onDidSelectQuickStart) {
				const select = options.onDidSelectQuickStart;
				this._register(dom.addDisposableListener(card, dom.EventType.CLICK, () => select(quickStart)));
			} else {
				card.disabled = true;
			}
		}
	}

	public needsRerender(content: IChatViewWelcomeContent): boolean {
		// Heuristic based on content that changes between states
		return !!(
			this.content.title !== content.title ||
			!!this.content.useAexusEmblem !== !!content.useAexusEmblem ||
			(this.content.quickStarts?.map(q => q.prompt).join('\n') ?? '') !== (content.quickStarts?.map(q => q.prompt).join('\n') ?? '') ||
			(typeof this.content.message === 'string' ? this.content.message : this.content.message.value) !== (typeof content.message === 'string' ? content.message : content.message.value) ||
			this.content.primaryAction?.label !== content.primaryAction?.label ||
			this.content.primaryAction?.href !== content.primaryAction?.href ||
			this.content.additionalMessage !== content.additionalMessage ||
			this.content.tips?.value !== content.tips?.value);
	}

	private renderMarkdownMessageContent(content: IMarkdownString, options: IChatViewWelcomeRenderOptions | undefined): IRenderedMarkdown {
		const messageResult = this._register(this.markdownRendererService.render(content));
		// eslint-disable-next-line no-restricted-syntax
		const firstLink = options?.firstLinkToButton ? messageResult.element.querySelector('a') : undefined;
		if (firstLink) {
			const target = firstLink.getAttribute('data-href');
			const button = this._register(new Button(firstLink.parentElement!, defaultButtonStyles));
			button.label = firstLink.textContent ?? '';
			if (target) {
				this._register(button.onDidClick(() => {
					this.openerService.open(target, { allowCommands: true });
				}));
			}
			firstLink.replaceWith(button.element);
		}
		return messageResult;
	}
}

let welcomeEmblemIdPool = 0;

/** A static Aexus emblem for the welcome hero: the same tile, hairline and orbit as the working indicator. */
function createChatWelcomeEmblem(): HTMLElement {
	const emblem = $('span.chat-working-logo.chat-welcome-view-emblem', { 'aria-hidden': 'true' });
	emblem.style.color = asCssVariable(chatWorkingProgressStableIconForeground);
	const face = dom.append(emblem, $('span.chat-working-logo-face'));
	const artwork = createChatWorkingLogoEmblem(`chat-welcome-emblem-${++welcomeEmblemIdPool}`, { width: '100%', height: '100%', focusable: 'false' }, { orbit: true });
	artwork.emblem.append(...chatWorkingLogoFacePaths.map(d => $.SVG<SVGPathElement>('path', { d, fill: 'currentColor' })));
	face.appendChild(artwork.svg);
	return emblem;
}
