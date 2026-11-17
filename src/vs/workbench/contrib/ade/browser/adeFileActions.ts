/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { basename, dirname, joinPath, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IBulkEditService, ResourceFileEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IUndoRedoService, UndoRedoSource } from '../../../../platform/undoRedo/common/undoRedo.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkingCopyFileService } from '../../../services/workingCopy/common/workingCopyFileService.js';
import { IAdeEditorService } from '../common/ade.js';

/** File operations take explicit ADE project resources and never use the IDE explorer selection. */
export class AdeFileActions {
	private readonly undoRedoSource = new UndoRedoSource();

	constructor(
		@IFileService private readonly files: IFileService,
		@IBulkEditService private readonly edits: IBulkEditService,
		@IQuickInputService private readonly input: IQuickInputService,
		@IDialogService private readonly dialogs: IDialogService,
		@IWorkingCopyFileService private readonly workingCopies: IWorkingCopyFileService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IFilesConfigurationService private readonly filesConfiguration: IFilesConfigurationService,
		@IPathService private readonly paths: IPathService,
		@IUriIdentityService private readonly uriIdentity: IUriIdentityService,
		@IUndoRedoService private readonly undoRedo: IUndoRedoService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@ILabelService private readonly labels: ILabelService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@IAdeEditorService private readonly editors: IAdeEditorService,
	) { }

	undo(): boolean | Promise<void> {
		return this.configuration.getValue<boolean>('explorer.enableUndo') && this.undoRedo.canUndo(this.undoRedoSource)
			? Promise.resolve(this.undoRedo.undo(this.undoRedoSource)).catch(error => this.notifications.error(error))
			: false;
	}

	redo(): boolean | Promise<void> {
		return this.configuration.getValue<boolean>('explorer.enableUndo') && this.undoRedo.canRedo(this.undoRedoSource)
			? Promise.resolve(this.undoRedo.redo(this.undoRedoSource)).catch(error => this.notifications.error(error))
			: false;
	}

	getActions(resource: URI, isFolder: boolean, projectUri: URI, refresh: (resource?: URI) => Promise<void>): IAction[] {
		const folder = isFolder ? resource : dirname(resource);
		const writable = !this.filesConfiguration.isReadonly(resource);
		const action = (id: string, label: string, run: () => Promise<void>, enabled = true): IAction => toAction({
			id,
			label,
			enabled,
			run: async () => {
				try {
					await run();
				} catch (error) {
					this.notifications.error(error);
				}
			},
		});
		return [
			action('ade.newFile', localize('newFile', "New File..."), () => this.create(folder, false, projectUri, refresh), writable),
			action('ade.newFolder', localize('newFolder', "New Folder..."), () => this.create(folder, true, projectUri, refresh), writable),
			new Separator(),
			action('ade.openInTerminal', localize('openInTerminal', "Open in Integrated Terminal"), () => this.commands.executeCommand('workbench.action.terminal.new', { cwd: folder })),
			new Separator(),
			action('ade.copyPath', localize('copyPath', "Copy Path"), () => this.clipboard.writeText(this.labels.getUriLabel(resource, { noPrefix: true }))),
			action('ade.copyRelativePath', localize('copyRelativePath', "Copy Relative Path"), () => this.clipboard.writeText(relativePath(projectUri, resource) ?? basename(resource))),
			...(!this.uriIdentity.extUri.isEqual(resource, projectUri) ? [
				new Separator(),
				action('ade.renameFile', localize('rename', "Rename..."), () => this.rename(resource, isFolder, refresh), writable),
				action('ade.deleteFile', localize('delete', "Delete"), () => this.delete(resource, isFolder, refresh), writable),
			] : []),
		];
	}

	private async inputName(folder: URI, isFolder: boolean, source?: URI): Promise<string | undefined> {
		const value = source ? basename(source) : '';
		return this.input.input({
			prompt: source ? localize('renamePrompt', "Enter the new name") : isFolder ? localize('createFolderPrompt', "Enter a folder name") : localize('createFilePrompt', "Enter a file name"),
			value,
			valueSelection: [0, !isFolder && value.lastIndexOf('.') > 0 ? value.lastIndexOf('.') : value.length],
			validateInput: async name => {
				const segments = name.split('/');
				if (!name.trim() || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\')) || !(await Promise.all(segments.map(segment => this.paths.hasValidBasename(folder, segment)))).every(Boolean)) {
					return localize('invalidName', "Enter a valid relative file or folder name.");
				}
				const target = joinPath(folder, name);
				if (source) {
					const result = await this.files.canMove(source, target);
					return result instanceof Error ? result.message : undefined;
				}
				return await this.files.exists(target) ? localize('nameExists', "A file or folder named '{0}' already exists.", name) : undefined;
			},
		});
	}

	private async create(folder: URI, isFolder: boolean, projectUri: URI, refresh: (resource?: URI) => Promise<void>): Promise<void> {
		const name = await this.inputName(folder, isFolder);
		if (!name) {
			return;
		}
		const resource = joinPath(folder, name);
		await this.edits.apply([new ResourceFileEdit(undefined, resource, { folder: isFolder, overwrite: false })], { label: localize('createLabel', "Create {0}", name), undoRedoSource: this.undoRedoSource, confirmBeforeUndo: true });
		await refresh(resource);
		if (!isFolder) {
			await this.editors.openFile(resource, projectUri);
		}
	}

	private async rename(resource: URI, isFolder: boolean, refresh: (resource?: URI) => Promise<void>): Promise<void> {
		const name = await this.inputName(dirname(resource), isFolder, resource);
		if (!name) {
			return;
		}
		const target = joinPath(dirname(resource), name);
		if (target.toString() === resource.toString()) {
			return;
		}
		await this.edits.apply([new ResourceFileEdit(resource, target)], { label: localize('renameLabel', "Rename {0} to {1}", basename(resource), name), undoRedoSource: this.undoRedoSource });
		await refresh(target);
	}

	private async delete(resource: URI, isFolder: boolean, refresh: () => Promise<void>): Promise<void> {
		const dirty = this.workingCopies.getDirty(resource).length > 0;
		const useTrash = this.files.hasCapability(resource, FileSystemProviderCapabilities.Trash) && this.configuration.getValue<boolean>('files.enableTrash');
		if (dirty || this.configuration.getValue<boolean>('explorer.confirmDelete') !== false) {
			const confirmation = await this.dialogs.confirm({
				type: dirty || !useTrash ? 'warning' : 'question',
				message: dirty ? localize('deleteDirty', "You are deleting '{0}' with unsaved changes. Do you want to continue?", basename(resource)) : localize('deleteConfirm', "Are you sure you want to delete '{0}'?", basename(resource)),
				detail: dirty ? localize('deleteDirtyDetail', "Your changes will be lost if you don't save them.") : useTrash ? localize('deleteTrashDetail', "You can restore this item from the Trash.") : isFolder ? localize('deleteFolderDetail', "This will permanently delete the folder and its contents.") : localize('deleteFileDetail', "You can restore this file using the Undo command."),
				primaryButton: useTrash ? localize('moveToTrash', "&&Move to Trash") : localize('deleteButton', "&&Delete"),
			});
			if (!confirmation.confirmed) {
				return;
			}
		}
		await this.edits.apply([new ResourceFileEdit(resource, undefined, { folder: isFolder, recursive: true, skipTrashBin: !useTrash, maxSize: 5000000 })], { label: localize('deleteLabel', "Delete {0}", basename(resource)), undoRedoSource: this.undoRedoSource });
		await refresh();
	}
}
