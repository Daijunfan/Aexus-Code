/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Mutable } from '../../../../base/common/types.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IObservable,observableValue } from '../../../../base/common/observable.js';
import { IEntitlementsData } from '../../../../base/common/defaultAccount.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService,RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType,registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

export namespace ChatEntitlementContextKeys {

	export const Setup = {
		hidden: new RawContextKey<boolean>('chatSetupHidden', false, true), 		// True when chat setup is explicitly hidden.
		installed: new RawContextKey<boolean>('chatSetupInstalled', false, true),  	// True when the chat extension is installed and enabled.
		disabled: new RawContextKey<boolean>('chatSetupDisabled', false, true),  	// True when the chat extension is disabled due to any other reason than workspace trust.
		disabledInWorkspace: new RawContextKey<boolean>('chatSetupDisabledInWorkspace', false, true),	// True when chat is disabled at the workspace level via settings.
		untrusted: new RawContextKey<boolean>('chatSetupUntrusted', false, true),  	// True when the chat extension is disabled due to workspace trust.
		later: new RawContextKey<boolean>('chatSetupLater', false, true),  			// True when the user wants to finish setup later.
		registered: new RawContextKey<boolean>('chatSetupRegistered', false, true), // True when the user has registered as Free or Pro user.
		completed: new RawContextKey<boolean>('chatSetupCompleted', false, true)	// True when the user has completed the setup flow, regardless of the outcome.
	};

	export const Entitlement = {
		signedOut: new RawContextKey<boolean>('chatEntitlementSignedOut', false, true), 				// True when user is signed out.
		canSignUp: new RawContextKey<boolean>('chatPlanCanSignUp', false, true), 						// True when user can sign up to be a chat free user.

		planFree: new RawContextKey<boolean>('chatPlanFree', false, true),								// True when user is a chat free user.
		planPro: new RawContextKey<boolean>('chatPlanPro', false, true),								// True when user is a chat pro user.
		planEdu: new RawContextKey<boolean>('chatPlanEdu', false, true),								// True when user is a chat edu user.
		planProPlus: new RawContextKey<boolean>('chatPlanProPlus', false, true), 						// True when user is a chat pro plus user.
		planMax: new RawContextKey<boolean>('chatPlanMax', false, true), 								// True when user is a chat max user.
		planBusiness: new RawContextKey<boolean>('chatPlanBusiness', false, true), 						// True when user is a chat business user.
		planEnterprise: new RawContextKey<boolean>('chatPlanEnterprise', false, true), 					// True when user is a chat enterprise user.

		organisations: new RawContextKey<string[]>('chatEntitlementOrganisations', undefined, true), 	// The organizations the user belongs to.
		internal: new RawContextKey<boolean>('chatEntitlementInternal', false, true), 					// True when the user is GitHub/Microsoft staff or belongs to an internal organisation.
		sku: new RawContextKey<string>('chatEntitlementSku', undefined, true), 							// The SKU of the user.
	};

	export const chatQuotaExceeded = new RawContextKey<boolean>('chatQuotaExceeded', false, true);
	export const completionsQuotaExceeded = new RawContextKey<boolean>('completionsQuotaExceeded', false, true);

	export const chatAnonymous = new RawContextKey<boolean>('chatAnonymous', false, true);

	export const clientByokEnabled = new RawContextKey<boolean>('github.copilot.clientByokEnabled', true, true);

	export const hasByokModels = new RawContextKey<boolean>('github.copilot.hasByokModels', false, true);
}

export const IChatEntitlementService = createDecorator<IChatEntitlementService>('chatEntitlementService');

export enum ChatEntitlement {
	/** Signed out */
	Unknown = 1,
	/** Signed in but not yet resolved */
	Unresolved = 2,
	/** Signed in and entitled to Free */
	Available = 3,
	/** Signed in but not entitled to Free */
	Unavailable = 4,
	/** Signed-up to Free */
	Free = 5,
	/** Signed-up to EDU */
	EDU = 10,
	/** Signed-up to Pro */
	Pro = 6,
	/** Signed-up to Pro Plus */
	ProPlus = 7,
	/** Signed-up to Business */
	Business = 8,
	/** Signed-up to Enterprise */
	Enterprise = 9,
	/** Signed-up to Max */
	Max = 11,
}

export interface IChatSentiment {

	/**
	 * Whether the user has completed the setup flow or not, regardless of the outcome
	 */
	completed?: boolean;

	/**
	 * User has Chat installed.
	 */
	installed?: boolean;

	/**
	 * User signals no intent in using Chat.
	 *
	 * Note: in contrast to `disabled`, this should not only disable
	 * Chat but also hide all of its UI.
	 */
	hidden?: boolean;

	/**
	 * User signals intent to disable Chat.
	 *
	 * Note: in contrast to `hidden`, this should not hide
	 * Chat but but disable its functionality.
	 */
	disabled?: boolean;

	/**
	 * Chat is disabled at the workspace level
	 *
	 * Note: in contrast to `hidden` (which hides all UI globally),
	 * this only disables Chat in the current workspace while
	 * keeping its UI visible so the user can re-enable it.
	 */
	disabledInWorkspace?: boolean;

	/**
	 * Chat is disabled due to missing workspace trust.
	 *
	 * Note: even though this disables Chat, we want to treat it
	 * different from the `disabled` state that is by explicit
	 * user choice.
	 */
	untrusted?: boolean;

	/**
	 * User signals intent to use Chat later.
	 */
	later?: boolean;

	/**
	 * User has registered as Free or Pro user.
	 */
	registered?: boolean;
}

export interface IChatSetupRequirement {
	/** Whether the setup flow has been completed (any outcome). */
	readonly completed: boolean;
	/** Whether the chat extension is disabled for a reason other than trust. */
	readonly disabled: boolean;
	/** Whether the chat extension is disabled because the workspace is untrusted. */
	readonly untrusted: boolean;
	/** The user's last known or resolved entitlement. */
	readonly entitlement: ChatEntitlement;
	/** Whether anonymous (signed-out) Chat access is enabled. */
	readonly anonymous: boolean;
	/** Whether BYOK models are available. */
	readonly hasByokModels: boolean;
}

export function chatRequiresSetup(context: IChatSetupRequirement): boolean {
	return (
		(!context.completed && !context.hasByokModels) ||			// Setup not completed (unless BYOK models are available)
		context.disabled ||											// Extension disabled: run setup to enable
		context.untrusted ||										// Workspace untrusted: run setup to ask for trust
		context.entitlement === ChatEntitlement.Available ||		// Entitlement available: run setup to sign up
		(
			context.entitlement === ChatEntitlement.Unknown &&		// Entitlement unknown: run setup to sign in / sign up
			!context.anonymous &&									// unless anonymous access is enabled
			!context.hasByokModels									// unless BYOK models are available
		)
	);
}

export interface IChatEntitlementService {

	_serviceBrand: undefined;

	readonly onDidChangeEntitlement: Event<void>;

	readonly entitlement: ChatEntitlement;
	readonly entitlementObs: IObservable<ChatEntitlement>;

	readonly clientByokEnabled: boolean;
	readonly hasByokModels: boolean;

	readonly organisations: string[] | undefined;

	/** True for GitHub/Microsoft staff or members of an internal organisation. */
	readonly isInternal: boolean;
	readonly sku: string | undefined;
	readonly copilotTrackingId: string | undefined;

	readonly onDidChangeQuotaExceeded: Event<void>;
	readonly onDidChangeQuotaRemaining: Event<void>;
	readonly onDidChangeUsageBasedBilling: Event<void>;

	readonly quotas: IQuotas;

	readonly onDidChangeSentiment: Event<void>;

	readonly sentiment: IChatSentiment;
	readonly sentimentObs: IObservable<IChatSentiment>;

	// TODO@bpasero eventually this will become enabled by default
	// and in that case we only need to check on entitlements change
	// between `unknown` and any other entitlement.
	readonly onDidChangeAnonymous: Event<void>;
	readonly anonymous: boolean;
	readonly anonymousObs: IObservable<boolean>;

	acceptQuotas(quotas: IQuotas): void;

	/**
	 * Clear all quota state.
	 */
	clearQuotas(): void;

	markAnonymousRateLimited(): void;

	/**
	 * Mark the chat setup flow as completed.
	 */
	markSetupCompleted(): void;

	/**
	 * Force the hidden state on or off, overriding the normal entitlement logic.
	 * Used by the account policy gate to hide all AI features when the gate is
	 * active and unsatisfied.
	 */
	setForceHidden(hidden: boolean): void;

	update(token: CancellationToken): Promise<void>;
}

export function isProUser(chatEntitlement: ChatEntitlement): boolean {
	return chatEntitlement === ChatEntitlement.EDU ||
		chatEntitlement === ChatEntitlement.Pro ||
		chatEntitlement === ChatEntitlement.ProPlus ||
		chatEntitlement === ChatEntitlement.Max ||
		chatEntitlement === ChatEntitlement.Business ||
		chatEntitlement === ChatEntitlement.Enterprise;
}

export function getChatPlanName(chatEntitlement: ChatEntitlement): string {
	switch (chatEntitlement) {
		case ChatEntitlement.EDU:
			return localize('plan.eduName', 'Student');
		case ChatEntitlement.Pro:
			return localize('plan.proName', 'Pro');
		case ChatEntitlement.ProPlus:
			return localize('plan.proPlusName', 'Pro+');
		case ChatEntitlement.Max:
			return localize('plan.maxName', 'Max');
		case ChatEntitlement.Business:
			return localize('plan.businessName', 'Business');
		case ChatEntitlement.Enterprise:
			return localize('plan.enterpriseName', 'Enterprise');
		default:
			return localize('plan.freeName', 'Free');
	}
}

export function isChatQuotaExceeded(entitlement: ChatEntitlement, quotas: IChatEntitlementService['quotas']): boolean {
	const premium = quotas.premiumChat;
	const managed = entitlement === ChatEntitlement.Business || entitlement === ChatEntitlement.Enterprise;
	const exhausted = premium?.unlimited ? premium.hasQuota === false : premium?.percentRemaining === 0;
	return quotas.chat?.percentRemaining === 0 || (managed && premium?.hasQuota === false) || (exhausted && (managed || !quotas.additionalUsageEnabled));
}

export function hasUsableCopilotPremiumQuota(entitlement: ChatEntitlement, quotas: IChatEntitlementService['quotas']): boolean {
	const premium = quotas.premiumChat;
	return isProUser(entitlement) && !!premium
		&& (premium.unlimited || (Number.isFinite(premium.percentRemaining) && premium.percentRemaining >= 0 && premium.percentRemaining <= 100))
		&& !isChatQuotaExceeded(entitlement, quotas);
}

export interface IQuotaSnapshot {
	readonly percentRemaining: number;
	readonly unlimited: boolean;
	readonly hasQuota?: boolean;
	/** When this quota resets, as a Unix timestamp in *seconds*. */
	readonly resetAt?: number;
	readonly usageBasedBilling?: boolean;
	readonly entitlement?: number;
	readonly quotaRemaining?: number;
	/**
	 * Aggregate credits consumed, only for users whose org sets no user-level budget. Drawn from
	 * an unmeterable pool, so it has no denominator. See microsoft/vscode#319589.
	 */
	readonly creditsUsed?: number;
}

export const enum QuotaUsageKind {

	/**
	 * Consumption measured against a known entitlement, best surfaced as a percentage.
	 */
	Percentage,

	/**
	 * Absolute credits consumed. Used for plans without a cap to measure a percentage against.
	 */
	CreditsUsed
}

export type IQuotaUsage = {
	readonly kind: QuotaUsageKind.Percentage;
	readonly usedPercentage: number;
	/**
	 * Credits consumed and the entitlement they are measured against. Both are
	 * `undefined` when the plan reports no entitlement to break the percentage down into.
	 */
	readonly used: number | undefined;
	readonly total: number | undefined;
} | {
	readonly kind: QuotaUsageKind.CreditsUsed;
	readonly creditsUsed: number;
};

export function getQuotaUsage(quota: IQuotaSnapshot | undefined): IQuotaUsage | undefined {
	if (!quota) {
		return undefined;
	}

	if (quota.unlimited) {
		if (quota.hasQuota === false || typeof quota.creditsUsed !== 'number') {
			return undefined;
		}

		return { kind: QuotaUsageKind.CreditsUsed, creditsUsed: quota.creditsUsed };
	}

	// An entitlement of `0` carries no ratio to report, so it is treated as absent.
	const total = quota.entitlement || undefined;
	let used: number | undefined;
	if (total !== undefined) {
		// `creditsUsed` has no denominator, so dividing it by `entitlement` disagrees with
		// `percentRemaining`. `quotaRemaining` shares the entitlement's basis.
		used = Math.max(0, quota.quotaRemaining !== undefined
			? total - quota.quotaRemaining
			: total * (100 - quota.percentRemaining) / 100);
	}

	return {
		kind: QuotaUsageKind.Percentage,
		usedPercentage: Math.max(0, 100 - quota.percentRemaining),
		used,
		total
	};
}

export interface IQuotaReset {
	readonly date: Date;
	/** Whether the underlying source carries a time of day worth surfacing. */
	readonly hasTime: boolean;
}

export function getQuotaReset(quota: IQuotaSnapshot | undefined, accountReset: { readonly resetDate?: string; readonly resetDateHasTime?: boolean }): IQuotaReset | undefined {
	if (quota?.resetAt) {
		return { date: new Date(quota.resetAt * 1000), hasTime: true };
	}

	if (!accountReset.resetDate) {
		return undefined;
	}

	const parsed = Date.parse(accountReset.resetDate);
	if (isNaN(parsed)) {
		return undefined;
	}

	return { date: new Date(parsed), hasTime: !!accountReset.resetDateHasTime };
}

export interface IRateLimitSnapshot {
	readonly percentRemaining: number;
	readonly unlimited: boolean;
	readonly resetDate?: string;
}

interface IQuotas {
	readonly resetDate?: string;
	readonly resetDateHasTime?: boolean;

	readonly usageBasedBilling?: boolean;
	readonly canUpgradePlan?: boolean;

	readonly chat?: IQuotaSnapshot;
	readonly completions?: IQuotaSnapshot;
	readonly premiumChat?: IQuotaSnapshot;
	readonly additionalUsageEnabled?: boolean;
	readonly additionalUsageCount?: number;
	readonly additionalUsageEntitlement?: number;

	readonly sessionRateLimit?: IRateLimitSnapshot;
	readonly weeklyRateLimit?: IRateLimitSnapshot;
}

export function parseQuotas(entitlementsData: IEntitlementsData): IQuotas {
	const quotas: Mutable<IQuotas> = {
		resetDate: entitlementsData.quota_reset_date_utc ?? entitlementsData.quota_reset_date ?? entitlementsData.limited_user_reset_date,
		resetDateHasTime: typeof entitlementsData.quota_reset_date_utc === 'string',
		usageBasedBilling: entitlementsData.token_based_billing,
		canUpgradePlan: entitlementsData.can_upgrade_plan,
	};

	// Legacy Free SKU Quota
	if (entitlementsData.monthly_quotas?.chat && typeof entitlementsData.limited_user_quotas?.chat === 'number') {
		quotas.chat = {
			percentRemaining: Math.min(100, Math.max(0, (entitlementsData.limited_user_quotas.chat / entitlementsData.monthly_quotas.chat) * 100)),
			unlimited: false
		};
	}

	if (entitlementsData.monthly_quotas?.completions && typeof entitlementsData.limited_user_quotas?.completions === 'number') {
		quotas.completions = {
			percentRemaining: Math.min(100, Math.max(0, (entitlementsData.limited_user_quotas.completions / entitlementsData.monthly_quotas.completions) * 100)),
			unlimited: false
		};
	}

	// New Quota Snapshot
	if (entitlementsData.quota_snapshots) {
		for (const quotaType of ['chat', 'completions', 'premium_interactions'] as const) {
			const rawQuotaSnapshot = entitlementsData.quota_snapshots[quotaType];
			if (!rawQuotaSnapshot) {
				continue;
			}
			const parsedEntitlement = rawQuotaSnapshot.entitlement !== undefined ? Number(rawQuotaSnapshot.entitlement) : undefined;
			const parsedCreditsUsed = rawQuotaSnapshot.credits_used !== undefined ? Number(rawQuotaSnapshot.credits_used) : undefined;

			// Skip snapshots where the user has no allocated entitlement for this
			// category (e.g. free tier premium_interactions with 0 credits). Under
			// TBB, has_quota is always false at the per-snapshot level so we cannot
			// rely on it; instead check the actual entitlement value.
			if (!rawQuotaSnapshot.unlimited && parsedEntitlement === 0) {
				continue;
			}

			const parsedQuotaRemaining = rawQuotaSnapshot.quota_remaining !== undefined ? Number(rawQuotaSnapshot.quota_remaining) : undefined;
			const quotaSnapshot: IQuotaSnapshot = {
				percentRemaining: Math.min(100, Math.max(0, rawQuotaSnapshot.percent_remaining)),
				unlimited: rawQuotaSnapshot.unlimited,
				hasQuota: rawQuotaSnapshot.has_quota,
				usageBasedBilling: entitlementsData.token_based_billing,
				resetAt: rawQuotaSnapshot.quota_reset_at || undefined,
				entitlement: parsedEntitlement !== undefined && Number.isFinite(parsedEntitlement) && parsedEntitlement >= 0 ? parsedEntitlement : undefined,
				quotaRemaining: parsedQuotaRemaining !== undefined && Number.isFinite(parsedQuotaRemaining) && parsedQuotaRemaining >= 0 ? parsedQuotaRemaining : undefined,
				creditsUsed: parsedCreditsUsed !== undefined && Number.isFinite(parsedCreditsUsed) && parsedCreditsUsed >= 0 ? parsedCreditsUsed : undefined,
			};

			switch (quotaType) {
				case 'chat':
					quotas.chat = quotaSnapshot;
					break;
				case 'completions':
					quotas.completions = quotaSnapshot;
					break;
				case 'premium_interactions':
					quotas.premiumChat = quotaSnapshot;
					break;
			}
		}

		const overageSource = entitlementsData.quota_snapshots['premium_interactions'];
		quotas.additionalUsageEnabled = overageSource?.overage_permitted ?? false;
		quotas.additionalUsageCount = overageSource?.overage_count ?? 0;
		quotas.additionalUsageEntitlement = overageSource?.overage_entitlement ?? 0;
	}
	return quotas;
}

/** Compatibility contract for extension APIs; Aexus has no built-in subscription provider. */
export class ChatEntitlementService implements IChatEntitlementService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeEntitlement = Event.None;
	readonly entitlement: ChatEntitlement = ChatEntitlement.Unavailable;
	readonly entitlementObs = observableValue<ChatEntitlement>(this, this.entitlement);
	readonly clientByokEnabled = true;
	readonly hasByokModels = false;
	readonly organisations = undefined;
	readonly isInternal = false;
	readonly sku = undefined;
	readonly copilotTrackingId = undefined;
	readonly onDidChangeQuotaExceeded = Event.None;
	readonly onDidChangeQuotaRemaining = Event.None;
	readonly onDidChangeUsageBasedBilling = Event.None;
	readonly quotas: IQuotas = {};
	readonly onDidChangeSentiment = Event.None;
	readonly sentiment: IChatSentiment = { hidden: true, completed: true };
	readonly sentimentObs = observableValue<IChatSentiment>(this, this.sentiment);
	readonly onDidChangeAnonymous = Event.None;
	readonly anonymous = false;
	readonly anonymousObs = observableValue(this, false);
	constructor(@IContextKeyService contextKeyService: IContextKeyService) {
		ChatEntitlementContextKeys.Setup.hidden.bindTo(contextKeyService).set(true);
		ChatEntitlementContextKeys.Setup.completed.bindTo(contextKeyService).set(true);
	}
	acceptQuotas(_quotas: IQuotas): void { }
	clearQuotas(): void { }
	markAnonymousRateLimited(): void { }
	markSetupCompleted(): void { }
	setForceHidden(_hidden: boolean): void { }
	async update(_token: CancellationToken): Promise<void> { }
}
registerSingleton(IChatEntitlementService, ChatEntitlementService, InstantiationType.Eager);
