/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ADE_CONFIG_SCHEME } from '../common/ade.js';

export class AdeConfigEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeConfig';
	override readonly resource: URI = URI.from({ scheme: ADE_CONFIG_SCHEME, path: '/config' });

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton;
	}

	override get typeId(): string {
		return AdeConfigEditorInput.ID;
	}

	override getName(): string {
		return localize('adeConfigEditorTitle', "ADE config");
	}

	override getIcon(): ThemeIcon {
		return Codicon.settingsGear;
	}

	override matches(other: EditorInput): boolean {
		return other instanceof AdeConfigEditorInput;
	}
}

export class AdeConfigEditorSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof AdeConfigEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		return input instanceof AdeConfigEditorInput ? 'ade-config' : undefined;
	}

	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(AdeConfigEditorInput);
	}
}

/**
 * Core ADE configuration editor pane — intentionally left blank as a clean placeholder
 * while the new ADE core configuration architecture is being designed.
 */
export class AdeConfigEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.adeConfig';

	private rootEl!: HTMLElement;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(AdeConfigEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.ade-config-editor', {
			tabindex: 0,
			role: 'region',
			'aria-label': localize('adeConfigRegionAria', "ADE config"),
		}));
		this.rootEl.style.width = '100%';
		this.rootEl.style.height = '100%';
		this.rootEl.style.backgroundColor = 'var(--vscode-editor-background)';
	}

	override async setInput(input: AdeConfigEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
	}

	override focus(): void {
		this.rootEl?.focus();
	}

	layout(dimension: Dimension): void {
		if (this.rootEl) {
			this.rootEl.style.width = `${dimension.width}px`;
			this.rootEl.style.height = `${dimension.height}px`;
		}
	}
}
