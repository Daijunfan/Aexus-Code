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
	buildCloudProjectUri,
	IAdeCloudHost,
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
	readonly os?: AdeCloudHostOs;
	readonly hostName?: string;
	readonly isCloudHost?: boolean;
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
	listCloudHostTargets(): Promise<readonly IProjectTerminalTarget[]>;
	getCachedCloudHost(authority: string): IAdeCloudHost | undefined;
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
	private readonly _hostMetaCache = new Map<string, IAdeCloudHost>();
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
			this._hostMetaCache.clear();
			for (const h of hosts) {
				this._hostMetaCache.set(h.alias, h);
				this._hostMetaCache.set(h.alias.toLowerCase(), h);
			}
		} catch {
			// Best effort cache prime
		}
	}

	getCachedCloudHost(authority: string): IAdeCloudHost | undefined {
		return this._getCachedCloudHost(authority);
	}

	async listCloudHostTargets(): Promise<readonly IProjectTerminalTarget[]> {
		if (!this._cloudHosts) {
			return [];
		}
		await this._refreshCloudHostMetadata();
		const hosts = await this._cloudHosts.listHosts().catch(() => [] as IAdeCloudHost[]);
		return hosts.map(host => {
			const defaultDir = host.defaultDirectory?.trim() || (host.os === 'windows' ? '/C:/' : '/');
			const uri = buildCloudProjectUri(host.alias, defaultDir, host.os);
			return {
				uri,
				name: host.name?.trim() || host.alias,
				host: host.alias,
				os: host.os,
				hostName: host.hostName,
				isCloudHost: true,
			};
		});
	}

	private _getCachedCloudHost(authority: string): IAdeCloudHost | undefined {
		return this._hostMetaCache.get(authority) ?? this._hostMetaCache.get(authority.toLowerCase());
	}

	private _workspaceTarget(uri: URI, name: string): IProjectTerminalTarget {
		const cloudMeta = uri.scheme === SSH_PROJECT_SCHEME ? this._getCachedCloudHost(uri.authority) : undefined;
		const host = uri.scheme === Schemas.file
			? localize('localHost', "Local")
			: uri.scheme === SSH_PROJECT_SCHEME
				? (cloudMeta?.alias ?? uri.authority)
				: (this._labels.getHostLabel(uri.scheme, uri.authority) || uri.authority);
		return {
			uri,
			name,
			host,
			...(cloudMeta ? { os: cloudMeta.os, hostName: cloudMeta.hostName, isCloudHost: true } : {}),
		};
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

	private _buildSshLaunchConfig(uri: URI, hostLabel: string, name: string, hostMeta: IAdeCloudHost | undefined, configFile: string | undefined): IShellLaunchConfig {
		let remoteCommand: string;
		const osKind: AdeCloudHostOs | undefined = hostMeta?.os;
		const isWindowsTarget = osKind === 'windows' || /^\/[a-zA-Z]:(?:\/|$)/.test(uri.path) || uri.path.startsWith('//');
		const resolvedHostOs: AdeCloudHostOs = osKind ?? (isWindowsTarget ? 'windows' : 'linux');
		const hostDistribution = [hostMeta?.lastTestStatus?.remoteUname, hostMeta?.name, hostMeta?.alias, hostMeta?.user, hostLabel]
			.filter((part): part is string => Boolean(part && part.trim()))
			.join(' ');
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
		// OpenSSH Host matching is case-sensitive whereas persisted aexus-ssh:// URI authorities are lowercased.
		// Prefer the canonical Cloud Host alias whenever available so mixed-case hosts (e.g. kali-Linux1) match.
		const sshTarget = hostMeta?.alias || uri.authority;
		return {
			name,
			hostLabel: hostMeta?.alias || hostLabel,
			hostOs: resolvedHostOs,
			hostDistribution,
			icon: Codicon.remote,
			executable: configuredSshExe || 'ssh',
			args: [...(configFile ? ['-F', configFile] : []), '-t', '--', sshTarget, remoteCommand],
			cwd: this._paths.userHome({ preferLocal: true }),
			ignoreConfigurationCwd: true,
			isRemotePty: true,
			waitOnExit: true,
		};
	}

	getLaunchConfig(target: IProjectTerminalTarget): IShellLaunchConfig {
		if (target.uri.scheme !== SSH_PROJECT_SCHEME) {
			const name = localize('projectTerminalTitle', "{0} · {1}", target.name, target.host);
			return { name, cwd: target.uri };
		}
		const hostMeta = this._getCachedCloudHost(target.uri.authority);
		const displayHost = hostMeta?.alias || target.host;
		const name = localize('projectTerminalTitle', "{0} · {1}", target.name, displayHost);
		const configFile = this._resolveSshConfigPathSync();
		return this._buildSshLaunchConfig(target.uri, displayHost, name, hostMeta, configFile);
	}

	async resolveLaunchConfigForUri(uri: URI, explicitName?: string): Promise<IShellLaunchConfig> {
		const matchedProject = this.findProject(uri);
		if (uri.scheme !== SSH_PROJECT_SCHEME) {
			const hostLabel = matchedProject?.host ?? (this._labels.getHostLabel(uri.scheme, uri.authority) || uri.authority || localize('localHost', "Local"));
			const folderName = explicitName ?? (uri === matchedProject?.uri ? matchedProject.name : (basename(uri) || matchedProject?.name || hostLabel));
			const name = localize('projectTerminalTitle', "{0} · {1}", folderName, hostLabel);
			return { name, cwd: uri };
		}
		if (this._cloudHosts && (!this._cachedEffectiveSshConfigPath || !this._getCachedCloudHost(uri.authority))) {
			await this._refreshCloudHostMetadata();
		}
		const hostMeta = this._getCachedCloudHost(uri.authority);
		const hostLabel = hostMeta?.alias || matchedProject?.host || uri.authority;
		const folderName = explicitName ?? (uri === matchedProject?.uri ? matchedProject.name : (basename(uri) || matchedProject?.name || hostLabel));
		const name = localize('projectTerminalTitle', "{0} · {1}", folderName, hostLabel);
		const configFile = this._resolveSshConfigPathSync();
		return this._buildSshLaunchConfig(uri, hostLabel, name, hostMeta, configFile);
	}
}
