/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	AdeCloudHostOs,
	IAdeCloudHostBackendService,
	toRemoteNativePath,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { IAdeProjectsService } from '../../ade/common/ade.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';

export interface IProjectTerminalTarget {
	readonly uri: URI;
	readonly name: string;
	readonly host: string;
}

interface IStoredSSHProject {
	host: string;
	path: string;
	name: string;
}

export const SSH_PROJECT_SCHEME = 'aexus-ssh';
export const IProjectTerminalService = createDecorator<IProjectTerminalService>('projectTerminalService');

export interface IProjectTerminalService {
	readonly _serviceBrand: undefined;
	readonly currentProject: IProjectTerminalTarget | undefined;
	readonly projects: readonly IProjectTerminalTarget[];
	readonly sshProjects: readonly IProjectTerminalTarget[];
	addSSHProject(host: string, path: string, name?: string): IProjectTerminalTarget;
	findProject(cwd: string | URI | undefined): IProjectTerminalTarget | undefined;
	getLaunchConfig(target: IProjectTerminalTarget): IShellLaunchConfig;
	resolveLaunchConfigForUri(uri: URI, explicitName?: string): Promise<IShellLaunchConfig>;
}

/** Resolves project context at creation time; running terminals retain their own host and cwd. */
export class ProjectTerminalService extends Disposable implements IProjectTerminalService {
	declare readonly _serviceBrand: undefined;
	private _sshEntries: IStoredSSHProject[];
	private _cachedEffectiveSshConfigPath: string | undefined;
	private readonly _hostOsCache = new Map<string, AdeCloudHostOs>();
	private readonly _cloudHosts: IAdeCloudHostBackendService | undefined;

	constructor(
		@IWorkbenchModeService private readonly _modes: IWorkbenchModeService,
		@IProjectNavigationService private readonly _ide: IProjectNavigationService,
		@IAdeProjectsService private readonly _ade: IAdeProjectsService,
		@IPathService private readonly _paths: IPathService,
		@ILabelService private readonly _labels: ILabelService,
		@IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
		@IStorageService private readonly _storage: IStorageService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._sshEntries = _storage.getObject<IStoredSSHProject[]>('aexus.terminal.sshProjects', StorageScope.PROFILE, []);
		this._cloudHosts = instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(IAdeCloudHostBackendService);
			} catch {
				return undefined;
			}
		});
		if (this._cloudHosts) {
			void this._refreshCloudHostMetadata();
			this._register(this._cloudHosts.onDidChangeHosts(() => {
				void this._refreshCloudHostMetadata();
			}));
		}
	}

	private async _refreshCloudHostMetadata(): Promise<void> {
		if (!this._cloudHosts) {
			return;
		}
		try {
			const [cfgPath, hosts] = await Promise.all([
				this._cloudHosts.getEffectiveSshConfigPath().catch(() => undefined),
				this._cloudHosts.listHosts().catch(() => []),
			]);
			if (cfgPath) {
				this._cachedEffectiveSshConfigPath = cfgPath;
			}
			this._hostOsCache.clear();
			for (const h of hosts) {
				this._hostOsCache.set(h.alias, h.os);
			}
		} catch {
			// Best effort cache prime
		}
	}

	private _workspaceTarget(uri: URI, name: string): IProjectTerminalTarget {
		const host = uri.scheme === Schemas.file
			? localize('localHost', "Local")
			: uri.scheme === SSH_PROJECT_SCHEME
				? uri.authority
				: (this._labels.getHostLabel(uri.scheme, uri.authority) || uri.authority);
		return { uri, name, host };
	}

	get projects(): readonly IProjectTerminalTarget[] {
		return this._modes.mode === 'ide'
			? this._ide.orderedProjects.map(folder => this._workspaceTarget(folder.uri, folder.name))
			: this._ade.projects.map(project => this._workspaceTarget(project.uri, project.name));
	}

	get currentProject(): IProjectTerminalTarget | undefined {
		const project = this._modes.mode === 'ide'
			? this._ide.selectedProject
			: (this._ide.focusedProject ?? this._ade.selectedProject ?? this._ide.selectedProject);
		return project ? this._workspaceTarget(project.uri, project.name) : undefined;
	}

	get sshProjects(): readonly IProjectTerminalTarget[] {
		return this._sshEntries.map(entry => ({ uri: URI.from({ scheme: SSH_PROJECT_SCHEME, authority: entry.host, path: entry.path }), name: entry.name, host: entry.host }));
	}

	addSSHProject(host: string, path: string, name = basename(URI.file(path)) || host): IProjectTerminalTarget {
		this._sshEntries = this._sshEntries.filter(entry => entry.host !== host || entry.path !== path);
		this._sshEntries.push({ host, path, name });
		this._storage.store('aexus.terminal.sshProjects', JSON.stringify(this._sshEntries), StorageScope.PROFILE, StorageTarget.MACHINE);
		return this.sshProjects[this.sshProjects.length - 1];
	}

	findProject(cwd: string | URI | undefined): IProjectTerminalTarget | undefined {
		if (!URI.isUri(cwd)) {
			return undefined;
		}
		const projects = [
			...this.projects,
			...this._ide.orderedProjects.map(folder => this._workspaceTarget(folder.uri, folder.name)),
			...this._ade.projects.map(project => this._workspaceTarget(project.uri, project.name)),
		];
		return projects
			.filter(project => this._uriIdentity.extUri.isEqualOrParent(cwd, project.uri))
			.sort((a, b) => b.uri.path.length - a.uri.path.length)[0];
	}

	private _resolveSshConfigPathSync(): string | undefined {
		if (this._cachedEffectiveSshConfigPath) {
			return this._cachedEffectiveSshConfigPath;
		}
		let configFile = this._configuration.getValue<string>('remote.SSH.configFile');
		if (configFile?.startsWith('~/') || configFile?.startsWith('~\\')) {
			configFile = joinPath(this._paths.userHome({ preferLocal: true }), configFile.slice(2)).fsPath;
		}
		return configFile || undefined;
	}

	private _encodePowerShellUtf16Base64(script: string): string {
		const bytes = new Uint8Array(script.length * 2);
		for (let i = 0; i < script.length; i++) {
			const code = script.charCodeAt(i);
			bytes[i * 2] = code & 0xff;
			bytes[i * 2 + 1] = (code >>> 8) & 0xff;
		}
		return encodeBase64(VSBuffer.wrap(bytes));
	}

	private _buildSshLaunchConfig(uri: URI, hostLabel: string, name: string, osKind: AdeCloudHostOs | undefined, configFile: string | undefined): IShellLaunchConfig {
		let remoteCommand: string;
		const isWindowsTarget = osKind === 'windows' || /^\/[a-zA-Z]:(?:\/|$)/.test(uri.path) || uri.path.startsWith('//');
		if (isWindowsTarget) {
			const winPath = toRemoteNativePath(uri.path || '/', 'windows').replace(/'/g, `''`);
			const encoded = this._encodePowerShellUtf16Base64(`Set-Location -LiteralPath '${winPath}'`);
			remoteCommand = `powershell -NoLogo -NoExit -EncodedCommand ${encoded}`;
		} else {
			// Quote the remote POSIX path without changing its contents or expanding shell expressions.
			const posixPath = uri.path || '/';
			const quoted = `'${posixPath.replace(/'/g, `'\\''`)}'`;
			remoteCommand = `cd -- ${quoted} && exec "\${SHELL:-/bin/sh}" -l`;
		}
		const configuredSshExe = this._configuration.getValue<string>('remote.SSH.path')?.trim();
		return {
			name,
			hostLabel,
			icon: Codicon.remote,
			executable: configuredSshExe || 'ssh',
			args: [...(configFile ? ['-F', configFile] : []), '-t', '--', uri.authority, remoteCommand],
			cwd: this._paths.userHome({ preferLocal: true }),
			ignoreConfigurationCwd: true,
			isRemotePty: true,
			waitOnExit: true,
		};
	}

	getLaunchConfig(target: IProjectTerminalTarget): IShellLaunchConfig {
		const name = localize('projectTerminalTitle', "{0} · {1}", target.name, target.host);
		if (target.uri.scheme !== SSH_PROJECT_SCHEME) {
			return { name, cwd: target.uri };
		}
		const osKind = this._hostOsCache.get(target.uri.authority);
		const configFile = this._resolveSshConfigPathSync();
		return this._buildSshLaunchConfig(target.uri, target.host, name, osKind, configFile);
	}

	async resolveLaunchConfigForUri(uri: URI, explicitName?: string): Promise<IShellLaunchConfig> {
		const matchedProject = this.findProject(uri);
		const hostLabel = matchedProject?.host ?? (uri.scheme === SSH_PROJECT_SCHEME ? uri.authority : (this._labels.getHostLabel(uri.scheme, uri.authority) || uri.authority || localize('localHost', "Local")));
		const folderName = explicitName ?? (uri === matchedProject?.uri ? matchedProject.name : (basename(uri) || matchedProject?.name || hostLabel));
		const name = localize('projectTerminalTitle', "{0} · {1}", folderName, hostLabel);
		if (uri.scheme !== SSH_PROJECT_SCHEME) {
			return { name, cwd: uri };
		}
		if (this._cloudHosts && (!this._cachedEffectiveSshConfigPath || !this._hostOsCache.has(uri.authority))) {
			await this._refreshCloudHostMetadata();
		}
		const osKind = this._hostOsCache.get(uri.authority);
		const configFile = this._resolveSshConfigPathSync();
		return this._buildSshLaunchConfig(uri, hostLabel, name, osKind, configFile);
	}
}
