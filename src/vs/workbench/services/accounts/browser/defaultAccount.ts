/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Barrier } from '../../../../base/common/async.js';
import { ICopilotTokenInfo,IDefaultAccount,IDefaultAccountAuthenticationProvider,IPolicyData } from '../../../../base/common/defaultAccount.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IDefaultAccountProvider,IDefaultAccountRefreshOptions,IDefaultAccountService,IManagedSettingsCompatibilityError,ManagedSettingsFetchStatus } from '../../../../platform/defaultAccount/common/defaultAccount.js';
import { IManagedSettingsFreshness,MANAGED_SETTINGS_FRESHNESS_NOT_REQUIRED,ManagedSettingsFreshnessState } from '../../../../platform/policy/common/managedSettingsFreshness.js';
import { IProductService } from '../../../../platform/product/common/productService.js';

export const DEFAULT_ACCOUNT_SIGN_IN_COMMAND = 'workbench.actions.accounts.signIn';
export const enum DefaultAccountStatus {
	Uninitialized = 'uninitialized',
	Unavailable = 'unavailable',
	Available = 'available',
}
export const CONTEXT_DEFAULT_ACCOUNT_STATE = new RawContextKey<string>('defaultAccountStatus', DefaultAccountStatus.Uninitialized);

export class DefaultAccountService extends Disposable implements IDefaultAccountService {
	declare _serviceBrand: undefined;

	private defaultAccount: IDefaultAccount | null = null;
	get currentDefaultAccount(): IDefaultAccount | null { return this.defaultAccount; }
	get policyData(): IPolicyData | null { return this.defaultAccountProvider?.policyData ?? null; }
	get copilotTokenInfo(): ICopilotTokenInfo | null { return this.defaultAccountProvider?.copilotTokenInfo ?? null; }

	get managedSettingsFetchStatus(): ManagedSettingsFetchStatus { return this.defaultAccountProvider?.managedSettingsFetchStatus ?? null; }
	get managedSettingsFetchedAt(): number | null { return this.defaultAccountProvider?.managedSettingsFetchedAt ?? null; }
	get managedSettingsRawResponse(): unknown { return this.defaultAccountProvider?.managedSettingsRawResponse ?? null; }
	get managedSettingsCompatibilityError(): IManagedSettingsCompatibilityError | null { return this.defaultAccountProvider?.managedSettingsCompatibilityError ?? null; }
	get managedSettingsFreshness(): IManagedSettingsFreshness { return this.defaultAccountProvider?.managedSettingsFreshness ?? MANAGED_SETTINGS_FRESHNESS_NOT_REQUIRED; }

	private readonly initBarrier = new Barrier();

	private readonly _onDidChangeDefaultAccount = this._register(new Emitter<IDefaultAccount | null>());
	readonly onDidChangeDefaultAccount = this._onDidChangeDefaultAccount.event;

	private readonly _onDidChangePolicyData = this._register(new Emitter<IPolicyData | null>());
	readonly onDidChangePolicyData = this._onDidChangePolicyData.event;

	private readonly _onDidChangeCopilotTokenInfo = this._register(new Emitter<ICopilotTokenInfo | null>());
	readonly onDidChangeCopilotTokenInfo = this._onDidChangeCopilotTokenInfo.event;

	private readonly _onDidChangeManagedSettingsCompatibilityError = this._register(new Emitter<IManagedSettingsCompatibilityError | null>());
	readonly onDidChangeManagedSettingsCompatibilityError = this._onDidChangeManagedSettingsCompatibilityError.event;

	private readonly _onDidChangeManagedSettingsFreshness = this._register(new Emitter<IManagedSettingsFreshness>());
	readonly onDidChangeManagedSettingsFreshness = this._onDidChangeManagedSettingsFreshness.event;

	private defaultAccountProvider: IDefaultAccountProvider | null = null;

	constructor(@IProductService _productService: IProductService) {
		super();
		this.initBarrier.open();
	}

	async getDefaultAccount(): Promise<IDefaultAccount | null> {
		await this.initBarrier.wait();
		return this.defaultAccount;
	}

	getDefaultAccountAuthenticationProvider(): IDefaultAccountAuthenticationProvider {
		if (this.defaultAccountProvider) {
			return this.defaultAccountProvider.getDefaultAccountAuthenticationProvider();
		}
		return {
			id: 'github',
			name: 'GitHub',
			enterprise: false
		};
	}

	setDefaultAccountProvider(provider: IDefaultAccountProvider): void {
		if (this.defaultAccountProvider) {
			throw new Error('Default account provider is already set');
		}

		this.defaultAccountProvider = provider;
		this._register(provider.onDidChangeManagedSettingsCompatibilityError(error => this._onDidChangeManagedSettingsCompatibilityError.fire(error)));
		this._register(provider.onDidChangeManagedSettingsFreshness(freshness => this._onDidChangeManagedSettingsFreshness.fire(freshness)));
		if (this.defaultAccountProvider.policyData) {
			this._onDidChangePolicyData.fire(this.defaultAccountProvider.policyData);
		}
		if (this.defaultAccountProvider.managedSettingsCompatibilityError) {
			this._onDidChangeManagedSettingsCompatibilityError.fire(this.defaultAccountProvider.managedSettingsCompatibilityError);
		}
		if (this.defaultAccountProvider.managedSettingsFreshness.state !== ManagedSettingsFreshnessState.NotRequired) {
			this._onDidChangeManagedSettingsFreshness.fire(this.defaultAccountProvider.managedSettingsFreshness);
		}
		provider.refresh().then(account => {
			this.defaultAccount = account;
		}).finally(() => {
			this.initBarrier.open();
			this._register(provider.onDidChangeDefaultAccount(account => this.setDefaultAccount(account)));
			this._register(provider.onDidChangePolicyData(policyData => this._onDidChangePolicyData.fire(policyData)));
			this._register(provider.onDidChangeCopilotTokenInfo(tokenInfo => this._onDidChangeCopilotTokenInfo.fire(tokenInfo)));
		});
	}

	async refresh(options?: IDefaultAccountRefreshOptions): Promise<IDefaultAccount | null> {
		await this.initBarrier.wait();

		const account = await this.defaultAccountProvider?.refresh(options);
		this.setDefaultAccount(account ?? null);
		return this.defaultAccount;
	}

	async signIn(options?: { additionalScopes?: readonly string[];[key: string]: unknown }): Promise<IDefaultAccount | null> {
		await this.initBarrier.wait();
		return this.defaultAccountProvider?.signIn(options) ?? null;
	}

	async signOut(): Promise<void> {
		await this.initBarrier.wait();
		await this.defaultAccountProvider?.signOut();
	}

	resolveGitHubUrl(path: string): string | undefined {
		if (this.defaultAccountProvider) {
			return this.defaultAccountProvider.resolveGitHubUrl(path);
		}

		return `https://github.com/${path}`;
	}

	private setDefaultAccount(account: IDefaultAccount | null): void {
		if (equals(this.defaultAccount, account)) {
			return;
		}
		this.defaultAccount = account;
		this._onDidChangeDefaultAccount.fire(this.defaultAccount);
	}
}
