/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	ADE_ORGANIZATION_CONFIG_KEY,
	ADE_ORGANIZATION_PRESETS,
	canRankSupervise,
	checkAdeApiPermission,
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	findRankDefinition,
	getDefaultPureLeafRank,
	getNextLowerRankFromConfig,
	getRankLevelFromConfig,
	getTopRankDefinition,
	IAdeApiPermissionResult,
	IAdeOrganizationConfig,
	IAdeOrganizationPreset,
	IAdeRankDefinition,
	isPureExecutionRank,
	normalizeAdeOrganizationConfig,
	resolveEffectiveRankDefinition,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IAdeRoleSchemaService = createDecorator<IAdeRoleSchemaService>('adeRoleSchemaService');

export interface IAdeRoleSchemaService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSchema: Event<IAdeOrganizationConfig>;

	getConfig(): IAdeOrganizationConfig;
	getPresets(): readonly IAdeOrganizationPreset[];
	updateConfig(config: IAdeOrganizationConfig, target?: ConfigurationTarget): Promise<IAdeOrganizationConfig>;
	applyPreset(presetId: string, target?: ConfigurationTarget): Promise<IAdeOrganizationConfig>;
	resetToDefault(target?: ConfigurationTarget): Promise<IAdeOrganizationConfig>;

	getRank(rankId: string | undefined): IAdeRankDefinition | undefined;
	resolveRank(role: string | undefined, hasSubordinates?: boolean): IAdeRankDefinition;
	getDefaultPureLeafRank(): IAdeRankDefinition;
	getTopRank(): IAdeRankDefinition;
	isPureExecutionRank(rankId: string | undefined): boolean;
	getRankLevel(role: string | undefined, hasSubordinates?: boolean): number;
	getNextLowerRank(parentRole: string | undefined, parentHasSubordinates?: boolean): {
		readonly canSpawnSubSession: boolean;
		readonly childRole: string | undefined;
		readonly childRank: string;
		readonly childDefinition: IAdeRankDefinition;
	};
	canSupervise(
		supervisorRole: string | undefined,
		supervisorHasSubordinates: boolean,
		subordinateRole: string | undefined,
		subordinateHasSubordinates: boolean,
	): boolean;
	checkApiPermission(caller: unknown, action: string): IAdeApiPermissionResult;
}

export class AdeRoleSchemaService extends Disposable implements IAdeRoleSchemaService {
	declare readonly _serviceBrand: undefined;

	private currentConfig: IAdeOrganizationConfig;
	private readonly _onDidChangeSchema = this._register(new Emitter<IAdeOrganizationConfig>());
	readonly onDidChangeSchema = this._onDidChangeSchema.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.currentConfig = this.readConfigFromSettings();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ADE_ORGANIZATION_CONFIG_KEY)) {
				const next = this.readConfigFromSettings();
				if (JSON.stringify(next) !== JSON.stringify(this.currentConfig)) {
					this.currentConfig = next;
					this._onDidChangeSchema.fire(next);
				}
			}
		}));
	}

	private readConfigFromSettings(): IAdeOrganizationConfig {
		const raw = this.configurationService.getValue<unknown>(ADE_ORGANIZATION_CONFIG_KEY);
		return normalizeAdeOrganizationConfig(raw);
	}

	getConfig(): IAdeOrganizationConfig {
		return this.currentConfig;
	}

	getPresets(): readonly IAdeOrganizationPreset[] {
		return ADE_ORGANIZATION_PRESETS;
	}

	async updateConfig(config: IAdeOrganizationConfig, target = ConfigurationTarget.USER): Promise<IAdeOrganizationConfig> {
		const normalized = normalizeAdeOrganizationConfig(config);
		await this.configurationService.updateValue(ADE_ORGANIZATION_CONFIG_KEY, normalized, target);
		if (JSON.stringify(normalized) !== JSON.stringify(this.currentConfig)) {
			this.currentConfig = normalized;
			this._onDidChangeSchema.fire(normalized);
		}
		return normalized;
	}

	async applyPreset(presetId: string, target = ConfigurationTarget.USER): Promise<IAdeOrganizationConfig> {
		const preset = ADE_ORGANIZATION_PRESETS.find(p => p.id === presetId);
		if (!preset) {
			throw new Error(`Unknown ADE organization preset: ${presetId}`);
		}
		return this.updateConfig(preset.config, target);
	}

	async resetToDefault(target = ConfigurationTarget.USER): Promise<IAdeOrganizationConfig> {
		return this.updateConfig(DEFAULT_ADE_ORGANIZATION_CONFIG, target);
	}

	getRank(rankId: string | undefined): IAdeRankDefinition | undefined {
		return findRankDefinition(this.currentConfig, rankId);
	}

	resolveRank(role: string | undefined, hasSubordinates = false): IAdeRankDefinition {
		return resolveEffectiveRankDefinition(this.currentConfig, role, hasSubordinates);
	}

	getDefaultPureLeafRank(): IAdeRankDefinition {
		return getDefaultPureLeafRank(this.currentConfig);
	}

	getTopRank(): IAdeRankDefinition {
		return getTopRankDefinition(this.currentConfig);
	}

	isPureExecutionRank(rankId: string | undefined): boolean {
		return isPureExecutionRank(this.currentConfig, rankId);
	}

	getRankLevel(role: string | undefined, hasSubordinates = false): number {
		return getRankLevelFromConfig(this.currentConfig, role, hasSubordinates);
	}

	getNextLowerRank(parentRole: string | undefined, parentHasSubordinates = false) {
		return getNextLowerRankFromConfig(this.currentConfig, parentRole, parentHasSubordinates);
	}

	canSupervise(
		supervisorRole: string | undefined,
		supervisorHasSubordinates: boolean,
		subordinateRole: string | undefined,
		subordinateHasSubordinates: boolean,
	): boolean {
		return canRankSupervise(
			this.currentConfig,
			supervisorRole,
			supervisorHasSubordinates,
			subordinateRole,
			subordinateHasSubordinates,
		);
	}

	checkApiPermission(caller: unknown, action: string): IAdeApiPermissionResult {
		return checkAdeApiPermission(this.currentConfig, caller, action);
	}
}
