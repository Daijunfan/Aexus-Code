/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Schemas } from '../../../../base/common/network.js';
import { isNative } from '../../../../base/common/platform.js';
import { dirname, joinPath, removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import Severity from '../../../../base/common/severity.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor, ServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkingCopyFileService } from '../../../services/workingCopy/common/workingCopyFileService.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import { IAdeEditorService, IAdeProject, IAdeProjectsService } from '../common/ade.js';
import { IAdeSessionsService } from './adeSessionsService.js';

function tryGetService<T>(accessor: ServicesAccessor, identifier: ServiceIdentifier<T>): T | undefined {
	try {
		return accessor.get(identifier);
	} catch {
		return undefined;
	}
}

function deduplicateProjectUris(uris: readonly URI[], uriIdentity: IUriIdentityService): URI[] {
	const seen = new Set<string>();
	const result: URI[] = [];
	for (const raw of uris) {
		const normalized = removeTrailingPathSeparator(raw);
		const key = uriIdentity.extUri.getComparisonKey(normalized);
		if (!seen.has(key)) {
			seen.add(key);
			result.push(normalized);
		}
	}
	return result;
}

async function resolveTargetProjectUris(
	rawTargets: URI | readonly URI[] | undefined,
	sourceMode: 'ade' | 'ide',
	projects: IAdeProjectsService,
	contextService: IWorkspaceContextService | undefined,
	quickInput: IQuickInputService,
	uriIdentity: IUriIdentityService,
	placeHolder: string,
): Promise<URI[]> {
	if (URI.isUri(rawTargets)) {
		return [removeTrailingPathSeparator(rawTargets)];
	}
	if (Array.isArray(rawTargets)) {
		const explicit = deduplicateProjectUris(rawTargets.filter((item): item is URI => URI.isUri(item)), uriIdentity);
		if (explicit.length > 0) {
			return explicit;
		}
	}

	const candidates: readonly IAdeProject[] = sourceMode === 'ide' && contextService?.getWorkspace().folders.length
		? contextService.getWorkspace().folders.map(folder => ({ uri: folder.uri, name: folder.name }))
		: projects.projects;

	if (candidates.length === 0) {
		return [];
	}

	const picked = await quickInput.pick(candidates.map(project => ({
		label: project.name,
		description: project.uri.fsPath,
		uri: project.uri,
	})), { placeHolder, matchOnDescription: true });

	return picked ? [removeTrailingPathSeparator(picked.uri)] : [];
}

export interface IReconcileIdeWorkspaceOptions {
	readonly projects: IAdeProjectsService;
	readonly contextService: IWorkspaceContextService | undefined;
	readonly workspaceEditing: IWorkspaceEditingService | undefined;
	readonly environmentService: IWorkbenchEnvironmentService | undefined;
	readonly fileService: IFileService | undefined;
	readonly uriIdentity: IUriIdentityService;
}

const workspaceReconcileSequencers = new WeakMap<IAdeProjectsService, Sequencer>();

/**
 * Reconciles the active IDE workspace folders with the authoritative profile project catalog.
 * Serialized per projects service instance so concurrent ADE/IDE mutations never race.
 */
export async function reconcileIdeWorkspaceWithCatalog(options: IReconcileIdeWorkspaceOptions): Promise<void> {
	const { projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity } = options;
	if (!contextService || !workspaceEditing) {
		return;
	}

	let sequencer = workspaceReconcileSequencers.get(projects);
	if (!sequencer) {
		sequencer = new Sequencer();
		workspaceReconcileSequencers.set(projects, sequencer);
	}

	return sequencer.queue(async () => {
		const workspace = contextService.getWorkspace();
		const currentFolders = workspace.folders;
		const catalog = projects.projects;
		const desiredUris = new Map<string, { uri: URI; name: string }>();
		const orderedDesired: { uri: URI; name: string }[] = [];

		for (const project of catalog) {
			const key = uriIdentity.extUri.getComparisonKey(project.uri);
			if (desiredUris.has(key)) {
				continue;
			}
			const alreadyInWorkspace = currentFolders.some(folder => uriIdentity.extUri.isEqual(folder.uri, project.uri));
			if (!alreadyInWorkspace) {
				if (project.uri.scheme !== Schemas.file) {
					continue;
				}
				if (fileService) {
					const exists = await fileService.exists(project.uri).catch(() => false);
					if (!exists) {
						continue;
					}
				}
			}
			const entry = { uri: project.uri, name: project.name };
			desiredUris.set(key, entry);
			orderedDesired.push(entry);
		}

		const toAdd = orderedDesired.filter(item => !currentFolders.some(folder => uriIdentity.extUri.isEqual(folder.uri, item.uri)));
		const toRemove = currentFolders
			.filter(folder => !desiredUris.has(uriIdentity.extUri.getComparisonKey(folder.uri)))
			.map(folder => folder.uri);

		if (toAdd.length === 0 && toRemove.length === 0) {
			return;
		}

		const workbenchState = typeof contextService.getWorkbenchState === 'function'
			? contextService.getWorkbenchState()
			: (workspace.configuration ? WorkbenchState.WORKSPACE : currentFolders.length ? WorkbenchState.FOLDER : WorkbenchState.EMPTY);

		if (workbenchState !== WorkbenchState.WORKSPACE && environmentService?.extensionTestsLocationURI) {
			return;
		}

		const applyWorkspaceChanges = async () => {
			if (workbenchState !== WorkbenchState.WORKSPACE) {
				if (orderedDesired.length === 0 && workbenchState === WorkbenchState.EMPTY) {
					return;
				}
				if (
					isNative
					&& environmentService?.untitledWorkspacesHome
					&& !environmentService.extensionTestsLocationURI
					&& typeof workspaceEditing.createAndEnterWorkspace === 'function'
				) {
					const projectWorkspace = joinPath(dirname(environmentService.untitledWorkspacesHome), 'Projects', workspace.id, 'projects.code-workspace');
					await workspaceEditing.createAndEnterWorkspace(orderedDesired, projectWorkspace).catch(() => { });
					return;
				}
			}

			if (toRemove.length > 0) {
				await workspaceEditing.removeFolders(toRemove, true).catch(() => { });
			}
			if (toAdd.length > 0) {
				await workspaceEditing.addFolders(toAdd, true).catch(() => { });
			}
		};

		if (typeof projects.runWithSuppressedWorkspaceSync === 'function') {
			await projects.runWithSuppressedWorkspaceSync(applyWorkspaceChanges);
		} else {
			await applyWorkspaceChanges();
		}
	});
}

export async function syncRemoveProjectsFromIdeWorkspace(
	uris: readonly URI[],
	contextService: IWorkspaceContextService | undefined,
	workspaceEditing: IWorkspaceEditingService | undefined,
	environmentService: IWorkbenchEnvironmentService | undefined,
	uriIdentity: IUriIdentityService,
	projects?: IAdeProjectsService,
	fileService?: IFileService,
): Promise<void> {
	if (projects) {
		await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
		return;
	}
	if (!workspaceEditing || !contextService) {
		return;
	}
	const workspace = contextService.getWorkspace();
	const inWorkspace = uris.filter(target => workspace.folders.some(folder => uriIdentity.extUri.isEqual(folder.uri, target)));
	if (inWorkspace.length === 0) {
		return;
	}
	const workbenchState = typeof contextService.getWorkbenchState === 'function'
		? contextService.getWorkbenchState()
		: (workspace.configuration ? WorkbenchState.WORKSPACE : workspace.folders.length ? WorkbenchState.FOLDER : WorkbenchState.EMPTY);
	if (workbenchState === WorkbenchState.FOLDER && environmentService?.extensionTestsLocationURI) {
		return;
	}
	if (
		isNative
		&& environmentService?.untitledWorkspacesHome
		&& !environmentService.extensionTestsLocationURI
		&& workbenchState === WorkbenchState.FOLDER
		&& typeof workspaceEditing.createAndEnterWorkspace === 'function'
	) {
		const remaining = workspace.folders
			.filter(folder => !inWorkspace.some(target => uriIdentity.extUri.isEqual(folder.uri, target)))
			.map(folder => ({ uri: folder.uri, name: folder.name }));
		const projectWorkspace = joinPath(dirname(environmentService.untitledWorkspacesHome), 'Projects', workspace.id, 'projects.code-workspace');
		await workspaceEditing.createAndEnterWorkspace(remaining, projectWorkspace).catch(() => { });
		return;
	}
	await workspaceEditing.removeFolders(inWorkspace, true).catch(() => { });
}

/** Removes one or more projects from both ADE and IDE without deleting files on disk or engine conversations. */
export async function removeProjectsSynchronized(accessor: ServicesAccessor, rawTargets?: URI | readonly URI[]): Promise<URI[]> {
	const projects = accessor.get(IAdeProjectsService);
	const editors = accessor.get(IAdeEditorService);
	const navigation = accessor.get(IProjectNavigationService);
	const uriIdentity = accessor.get(IUriIdentityService);
	const quickInput = accessor.get(IQuickInputService);
	const fileService = tryGetService(accessor, IFileService);
	const contextService = tryGetService(accessor, IWorkspaceContextService);
	const workspaceEditing = tryGetService(accessor, IWorkspaceEditingService);
	const environmentService = tryGetService(accessor, IWorkbenchEnvironmentService);

	const targets = await resolveTargetProjectUris(
		rawTargets,
		'ade',
		projects,
		contextService,
		quickInput,
		uriIdentity,
		localize('adeSelectProjectToRemove', "Select a project to remove from workspace"),
	);
	if (targets.length === 0) {
		return [];
	}

	for (const targetUri of targets) {
		const projectAgents = projects.agents.filter(agent => uriIdentity.extUri.isEqual(agent.projectUri, targetUri));
		await editors.closeAgents(projectAgents);
		if (navigation.focusedProject && uriIdentity.extUri.isEqual(navigation.focusedProject.uri, targetUri)) {
			navigation.goHome();
		}
		projects.removeProject(targetUri);
	}

	await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
	return targets;
}

async function deleteProjectFolderOnDisk(
	targetUri: URI,
	projectName: string,
	useTrash: boolean,
	fileService: IFileService,
	workingCopyFileService: IWorkingCopyFileService | undefined,
	dialogs: IDialogService,
	notifications: INotificationService,
): Promise<boolean> {
	if (!(await fileService.exists(targetUri))) {
		return true;
	}

	const performDelete = async (trash: boolean) => {
		if (workingCopyFileService) {
			await workingCopyFileService.delete([{ resource: targetUri, recursive: true, useTrash: trash }], CancellationToken.None);
		} else {
			await fileService.del(targetUri, { recursive: true, useTrash: trash });
		}
	};

	try {
		await performDelete(useTrash);
		return true;
	} catch (error) {
		if (useTrash) {
			const fallback = await dialogs.confirm({
				type: 'warning',
				message: localize('deleteProjectTrashFailed', "Failed to delete '{0}' using the Trash. Permanently delete instead?", projectName),
				detail: localize('deleteProjectPermanentIrreversible', "This will permanently delete '{0}' from disk. This action cannot be undone.", targetUri.fsPath),
				primaryButton: localize('deleteProjectPermanentlyFallbackBtn', "&&Delete Permanently"),
			});
			if (!fallback.confirmed) {
				return false;
			}
			try {
				await performDelete(false);
				return true;
			} catch (permanentError) {
				notifications.error(toErrorMessage(permanentError, false));
				return false;
			}
		}
		notifications.error(toErrorMessage(error, false));
		return false;
	}
}

/** Prompts with ADE- or IDE-specific options and deletes sessions and/or files before removing the project from both views. */
export async function deleteProjectsWithModePrompt(
	accessor: ServicesAccessor,
	sourceMode: 'ade' | 'ide',
	rawTargets?: URI | readonly URI[],
	options?: { readonly permanent?: boolean },
): Promise<void> {
	const projects = accessor.get(IAdeProjectsService);
	const editors = accessor.get(IAdeEditorService);
	const sessions = accessor.get(IAdeSessionsService);
	const navigation = accessor.get(IProjectNavigationService);
	const uriIdentity = accessor.get(IUriIdentityService);
	const dialogs = accessor.get(IDialogService);
	const quickInput = accessor.get(IQuickInputService);
	const fileService = accessor.get(IFileService);
	const configurationService = accessor.get(IConfigurationService);
	const notifications = accessor.get(INotificationService);
	const contextService = tryGetService(accessor, IWorkspaceContextService);
	const workspaceEditing = tryGetService(accessor, IWorkspaceEditingService);
	const environmentService = tryGetService(accessor, IWorkbenchEnvironmentService);
	const workingCopyFileService = tryGetService(accessor, IWorkingCopyFileService);

	const targets = await resolveTargetProjectUris(
		rawTargets,
		sourceMode,
		projects,
		contextService,
		quickInput,
		uriIdentity,
		localize('selectProjectToDelete', "Select a project to delete"),
	);
	if (targets.length === 0) {
		return;
	}

	const removedUris: URI[] = [];

	for (const targetUri of targets) {
		const wsFolder = contextService?.getWorkspace().folders.find(folder => uriIdentity.extUri.isEqual(folder.uri, targetUri));
		const projectName = wsFolder?.name ?? projects.getProjectName(targetUri);
		const projectAgents = projects.agents.filter(agent => uriIdentity.extUri.isEqual(agent.projectUri, targetUri));
		const canUseTrash = !options?.permanent
			&& fileService.hasCapability(targetUri, FileSystemProviderCapabilities.Trash)
			&& Boolean(configurationService.getValue<boolean>('files.enableTrash'));

		const sessionLine = projectAgents.length > 0
			? localize('deleteProjectSessionCountLine', "Tracked ADE sessions in this project: {0}", projectAgents.length)
			: localize('deleteProjectNoSessionLine', "No tracked ADE sessions; engine history in this project folder will still be checked.");
		const filesEffect = canUseTrash
			? localize('deleteFilesTrashDesc', "Moves '{0}' to Trash on disk", targetUri.fsPath)
			: localize('deleteFilesPermanentDesc', "Permanently deletes '{0}' from disk (cannot be undone)", targetUri.fsPath);

		type DeleteChoice = 'sessions' | 'sessionsAndFiles' | 'files' | 'filesAndSessions' | undefined;
		let choice: DeleteChoice;

		if (sourceMode === 'ade') {
			const res = await dialogs.prompt<'sessions' | 'sessionsAndFiles' | undefined>({
				type: Severity.Warning,
				message: localize('adeDeleteProjectPromptMessage', "How would you like to delete project '{0}'?", projectName),
				detail: [
					targetUri.fsPath,
					sessionLine,
					'',
					localize('adeDeleteOptionSessions', "• Delete All Sessions: Deletes all Coding Agent sessions for this project and removes it from ADE and IDE (files on disk are kept)."),
					localize('adeDeleteOptionBoth', "• Delete Sessions and Files: Deletes all Coding Agent sessions, {0}, and removes it from ADE and IDE.", filesEffect),
				].join('\n'),
				buttons: [
					{
						label: localize('adeDeleteAllSessionsBtn', "&&Delete All Sessions"),
						run: () => 'sessions' as const,
					},
					{
						label: localize('adeDeleteSessionsAndFilesBtn', "Delete Sessions &&and Files"),
						run: () => 'sessionsAndFiles' as const,
					},
				],
				cancelButton: {
					run: () => undefined,
				},
			});
			choice = res.result;
		} else {
			const res = await dialogs.prompt<'files' | 'filesAndSessions' | undefined>({
				type: Severity.Warning,
				message: localize('ideDeleteProjectPromptMessage', "How would you like to delete project '{0}'?", projectName),
				detail: [
					targetUri.fsPath,
					sessionLine,
					'',
					localize('ideDeleteOptionFiles', "• Delete All Files: {0} and removes it from IDE and ADE (Coding Agent session histories are kept).", filesEffect),
					localize('ideDeleteOptionBoth', "• Delete All Files and Sessions: {0}, deletes all Coding Agent sessions for this project, and removes it from IDE and ADE.", filesEffect),
				].join('\n'),
				buttons: [
					{
						label: localize('ideDeleteAllFilesBtn', "&&Delete All Files"),
						run: () => 'files' as const,
					},
					{
						label: localize('ideDeleteAllFilesAndSessionsBtn', "Delete All Files &&and Sessions"),
						run: () => 'filesAndSessions' as const,
					},
				],
				cancelButton: {
					run: () => undefined,
				},
			});
			choice = res.result;
		}

		if (!choice) {
			continue;
		}

		const shouldDeleteSessions = choice === 'sessions' || choice === 'sessionsAndFiles' || choice === 'filesAndSessions';
		const shouldDeleteFiles = choice === 'files' || choice === 'filesAndSessions' || choice === 'sessionsAndFiles';

		if (shouldDeleteFiles) {
			const dirtyCopies = workingCopyFileService?.getDirty(targetUri) ?? [];
			if (dirtyCopies.length > 0) {
				const dirtyConfirm = await dialogs.confirm({
					type: 'warning',
					message: localize('deleteProjectDirtyConfirm', "Project '{0}' has unsaved changes in {1} file(s). Delete anyway?", projectName, dirtyCopies.length),
					detail: localize('deleteProjectDirtyDetail', "Your unsaved changes will be lost if you continue."),
					primaryButton: localize('deleteProjectDirtyContinueBtn', "&&Continue"),
				});
				if (!dirtyConfirm.confirmed) {
					continue;
				}
				for (const copy of dirtyCopies) {
					await copy.revert({ soft: true }).catch(() => { });
				}
			}
		}

		if (shouldDeleteSessions) {
			for (const member of projectAgents) {
				if (member.session) {
					await sessions.delete(member.session).catch(() => { });
				}
			}
			await sessions.deleteProjectSessions?.(targetUri).catch(() => 0);
		}

		await editors.closeAgents(projectAgents);

		if (shouldDeleteFiles) {
			const deletedOk = await deleteProjectFolderOnDisk(
				targetUri,
				projectName,
				canUseTrash,
				fileService,
				workingCopyFileService,
				dialogs,
				notifications,
			);
			if (!deletedOk) {
				continue;
			}
		}

		if (navigation.focusedProject && uriIdentity.extUri.isEqual(navigation.focusedProject.uri, targetUri)) {
			navigation.goHome();
		}
		projects.removeProject(targetUri);
		removedUris.push(targetUri);
	}

	if (removedUris.length > 0) {
		await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
	}
}
