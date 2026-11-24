/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { AEXUS_SSH_SCHEME } from '../../../../platform/ade/common/adeCloudHosts.js';
import { resolveMergedNodeCheckHooks } from '../../../../platform/ade/common/adeControlPolicy.js';
import {
	IAdeSourceTriggerFireEvent,
	IAdeWatchdogWakeupEvent,
} from '../../../../platform/ade/common/adeEngineering.js';
import { parseMissionMermaidDag } from '../../../../platform/ade/common/adeMissionDag.js';
import {
	computeMissionTotalCostUsd,
	fireMissionSourceTrigger,
	IMissionRuntimeState,
	IMissionToken,
	IMissionTurnUsageInput,
	MissionEngineEffect,
	recordMissionNodeTurnUsage,
	recordWatchdogWakeup,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import {
	abortOrchestrationTokens,
	dispatchRequirementToOrchestration,
	expireOrchestrationJoinBarrier,
	findHighestRankStaffNode,
	hasActiveOrchestrationTokens,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	OrchestrationEngineEffect,
	pauseOrchestration,
	recordOrchestrationFinOpsUsage,
	recordOrchestrationSilenceReminder,
	resolveEffectiveStaffTier,
	resumeOrchestration,
	setOrchestrationGuardrails,
	wakeBlockedOrchestrationToken,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import { parseOrchestrationGraph } from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { normalizeAdeEngineId, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import { ADE_SECRETARY_ID, IAdeAgent } from '../common/ade.js';
import { IAdeMissionRecord } from './adeMissionStore.js';
import type {
	IAdeMissionRuntimeHost,
	IMissionTurnAttribution,
	IPendingAgentDispatchOptions,
} from './adeMissionRuntimeTypes.js';

const MAX_RETAINED_TURN_ATTRIBUTIONS = 512;
const DELAYED_TURN_USAGE_GRACE_MS = 60_000;
const STALE_INFLIGHT_TURN_MS = 30 * 60_000;

export class AdeMissionAgentDispatchController {
	constructor(
		private readonly host: IAdeMissionRuntimeHost,
	) { }

	touchAgentActivity(sessionResourceOrAgentId: string, timestamp = Date.now()): void {
		const projects = this.host.projectsService;
		const missions = this.host.missionService;
		if (!projects || !missions || !sessionResourceOrAgentId) {
			return;
		}
		const agent = projects.getAgent(sessionResourceOrAgentId)
			?? projects.agents.find(a => a.session?.resource.toString() === sessionResourceOrAgentId);
		if (!agent) {
			return;
		}
		this.host.inMemoryAgentActivityAt.set(agent.id, timestamp);
		const lastSync = this.host.lastHeartbeatSyncAt.get(agent.id) ?? 0;
		if (timestamp - lastSync < 5_000) {
			return;
		}
		this.host.lastHeartbeatSyncAt.set(agent.id, timestamp);

		for (const rec of missions.listMissions()) {
			const hasLegacyActive = rec.runtime?.status === 'running' && Object.values(rec.runtime.tokens).some(tok => {
				const assigned = rec.runtime!.boundary.nodeAssignments[tok.nodeId]?.agentId;
				return tok.status === 'active' && (tok.holderAgentId === agent.id || assigned === agent.id);
			});
			const hasOrchActive = Boolean(rec.orchestrationRuntime && Object.values(rec.orchestrationRuntime.tokens).some(tok => {
				const assigned = rec.orchestrationRuntime!.nodeAgentIds[tok.nodeId];
				return tok.status === 'active' && (tok.holderAgentId === agent.id || assigned === agent.id);
			}));
			if (hasLegacyActive || hasOrchActive) {
				this.host.syncWatchdog(rec.id, rec.runtime ?? this.host.ensureSynchronizedState(rec));
			}
		}
	}

	recordNodeTurnUsage(missionId: string, nodeId: string, usage: IMissionTurnUsageInput): void {
		const missions = this.host.missionService;
		if (!missions || !missionId || !nodeId) {
			return;
		}
		const rec = missions.getMission(missionId);
		if (!rec) {
			return;
		}
		const state = rec.runtime ?? (rec.orchestrationRuntime ? this.host.ensureSynchronizedState(rec) : undefined);
		if (!state) {
			return;
		}
		const pricingOpts = this.host.resolveNodePricingOptions(state, nodeId);
		const nextState = recordMissionNodeTurnUsage(state, nodeId, usage, pricingOpts);
		const trippedNow = Boolean(nextState.budgetCircuitTripped && !state.budgetCircuitTripped);
		this.host.commitState(rec.id, nextState, trippedNow ? undefined : { deferPersist: true, skipWatchdogSync: true });

		let orchTrippedNow = false;
		if (rec.orchestrationRuntime) {
			const orch = rec.orchestrationRuntime;
			const targetTok = usage.tokenId
				? orch.tokens[usage.tokenId]
				: Object.values(orch.tokens).find(t => t.nodeId === nodeId && (t.status === 'active' || t.status === 'blocked'));
			const isRework = Boolean(targetTok && (targetTok.dispatchKind === 'reject' || targetTok.dispatchKind === 'retry'));
			const finOpsUpdated = recordOrchestrationFinOpsUsage(orch, {
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cacheReadTokens: usage.cacheReadTokens,
				cacheWriteTokens: usage.cacheWriteTokens,
				totalTokens: usage.totalTokens,
				isRework,
				model: usage.model || pricingOpts.fallbackModel,
				engineId: usage.engineId || pricingOpts.fallbackEngineId,
			});
			const prevLegacyCostUsd = computeMissionTotalCostUsd(state);
			const nextLegacyCostUsd = computeMissionTotalCostUsd(nextState);
			const turnDeltaUsd = Math.max(0, nextLegacyCostUsd - prevLegacyCostUsd);
			// Preserve monotonic totalCostUsd across headless turns & checkpoint restores so a renderer turn
			// NEVER lowers orch.totalCostUsd or disarms a tripped FinOps budget circuit breaker.
			const monotonicTotalCostUsd = Math.max(nextLegacyCostUsd, (orch.totalCostUsd ?? 0) + turnDeltaUsd);
			const syncedOrch = setOrchestrationGuardrails(finOpsUpdated.state, {
				...(nextState.budgetLimitUsd !== undefined ? { budgetLimitUsd: nextState.budgetLimitUsd } : {}),
				totalCostUsd: monotonicTotalCostUsd,
			});
			orchTrippedNow = syncedOrch.budgetTrippedNow;
			if (orchTrippedNow) {
				this.host.commitOrchestrationState(rec.id, syncedOrch.state);
			} else {
				this.host.missionService?.updateOrchestrationRuntime(rec.id, syncedOrch.state, { deferPersist: true });
			}
		}
		if (trippedNow || orchTrippedNow) {
			void this.host.stopActiveAgentsOnBudgetTrip(nextState, this.host.missionService?.getMission(rec.id) ?? rec);
			this.host.notifyBudgetCircuitTripped(rec, nextState);
		}
	}

	private registerTurnAttribution(entry: IMissionTurnAttribution): void {
		const now = entry.startedAt || Date.now();
		this.host.turnAttributionById.set(entry.turnId, entry);
		if (this.host.turnAttributionById.size > MAX_RETAINED_TURN_ATTRIBUTIONS) {
			const oldestKey = this.host.turnAttributionById.keys().next().value;
			if (oldestKey) {
				const oldest = this.host.turnAttributionById.get(oldestKey);
				this.host.turnAttributionById.delete(oldestKey);
				if (oldest) {
					if (this.host.inFlightTurnByAgent.get(oldest.agentId)?.turnId === oldestKey) {
						this.host.inFlightTurnByAgent.delete(oldest.agentId);
					}
					if (oldest.sessionResource && this.host.inFlightTurnBySession.get(oldest.sessionResource)?.turnId === oldestKey) {
						this.host.inFlightTurnBySession.delete(oldest.sessionResource);
					}
				}
			}
		}
		for (const [aid, active] of [...this.host.inFlightTurnByAgent.entries()]) {
			if (now - active.startedAt > STALE_INFLIGHT_TURN_MS) {
				this.host.inFlightTurnByAgent.delete(aid);
			}
		}
		for (const [sessKey, active] of [...this.host.inFlightTurnBySession.entries()]) {
			if (now - active.startedAt > STALE_INFLIGHT_TURN_MS) {
				this.host.inFlightTurnBySession.delete(sessKey);
			}
		}
		this.host.inFlightTurnByAgent.set(entry.agentId, entry);
		if (entry.sessionResource) {
			this.host.inFlightTurnBySession.set(entry.sessionResource, entry);
		}
	}

	private finalizeTurnAttribution(turnId: string | undefined, now = Date.now()): void {
		if (!turnId) {
			return;
		}
		const entry = this.host.turnAttributionById.get(turnId);
		if (!entry) {
			return;
		}
		entry.finishedAt = now;
		if (this.host.inFlightTurnByAgent.get(entry.agentId)?.turnId === turnId) {
			this.host.inFlightTurnByAgent.delete(entry.agentId);
		}
		if (entry.sessionResource && this.host.inFlightTurnBySession.get(entry.sessionResource)?.turnId === turnId) {
			this.host.inFlightTurnBySession.delete(entry.sessionResource);
		}
		this.host.lastTurnByAgent.set(entry.agentId, entry);
		if (this.host.lastTurnByAgent.size > MAX_RETAINED_TURN_ATTRIBUTIONS) {
			const oldestAgent = this.host.lastTurnByAgent.keys().next().value;
			if (oldestAgent) {
				this.host.lastTurnByAgent.delete(oldestAgent);
			}
		}
		if (entry.sessionResource) {
			this.host.lastTurnBySession.set(entry.sessionResource, entry);
			if (this.host.lastTurnBySession.size > MAX_RETAINED_TURN_ATTRIBUTIONS) {
				const oldestSession = this.host.lastTurnBySession.keys().next().value;
				if (oldestSession) {
					this.host.lastTurnBySession.delete(oldestSession);
				}
			}
		}
	}

	private hasBlockingTokenForAgent(agentId: string, targetMissionId?: string, targetNodeId?: string): boolean {
		const missions = this.host.missionService;
		if (!missions || !agentId) {
			return false;
		}
		for (const rec of missions.listMissions()) {
			const state = rec.runtime;
			if (state && (state.status === 'running' || state.status === 'paused')) {
				for (const tok of Object.values(state.tokens)) {
					if (tok.status !== 'blocked' && tok.status !== 'active') {
						continue;
					}
					const holder = state.boundary.nodeAssignments[tok.nodeId]?.agentId ?? tok.holderAgentId;
					if (holder !== agentId) {
						continue;
					}
					if (targetMissionId && targetNodeId && rec.id === targetMissionId && tok.nodeId === targetNodeId) {
						continue;
					}
					return true;
				}
			}
			const orch = rec.orchestrationRuntime;
			if (orch && orch.status !== 'paused' && orch.status !== 'aborted') {
				for (const tok of Object.values(orch.tokens)) {
					if (tok.status !== 'blocked' && tok.status !== 'active') {
						continue;
					}
					const holder = orch.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId;
					if (holder !== agentId) {
						continue;
					}
					if (targetMissionId && targetNodeId && rec.id === targetMissionId && tok.nodeId === targetNodeId) {
						continue;
					}
					return true;
				}
			}
		}
		return false;
	}

	flushPendingDispatchesForReleasedOrchAgents(prevState: IOrchestrationRuntimeState | undefined, nextState: IOrchestrationRuntimeState): void {
		if (!prevState || this.host.pendingDispatchesByAgent.size === 0) {
			return;
		}
		const collectLiveAgents = (state: IOrchestrationRuntimeState): Set<string> => {
			const live = new Set<string>();
			if (state.status === 'paused' || state.status === 'aborted') {
				return live;
			}
			for (const tok of Object.values(state.tokens)) {
				if (tok.status === 'active' || tok.status === 'blocked') {
					const holder = state.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId;
					if (holder) {
						live.add(holder);
					}
				}
			}
			return live;
		};
		const prevLive = collectLiveAgents(prevState);
		const nextLive = collectLiveAgents(nextState);
		for (const aid of prevLive) {
			if (!nextLive.has(aid) && this.host.pendingDispatchesByAgent.has(aid)) {
				this.flushNextQueuedDispatch(aid);
			}
		}
	}

	flushPendingDispatchesForReleasedAgents(prevState: IMissionRuntimeState, nextState: IMissionRuntimeState): void {
		if (this.host.pendingDispatchesByAgent.size === 0) {
			return;
		}
		const collectLiveAgents = (state: IMissionRuntimeState): Set<string> => {
			const live = new Set<string>();
			if (state.status !== 'running' && state.status !== 'paused') {
				return live;
			}
			for (const tok of Object.values(state.tokens)) {
				if (tok.status === 'active' || tok.status === 'blocked') {
					const holder = state.boundary.nodeAssignments[tok.nodeId]?.agentId ?? tok.holderAgentId;
					if (holder) {
						live.add(holder);
					}
				}
			}
			return live;
		};
		const prevLive = collectLiveAgents(prevState);
		const nextLive = collectLiveAgents(nextState);
		for (const aid of prevLive) {
			if (!nextLive.has(aid) && this.host.pendingDispatchesByAgent.has(aid)) {
				this.flushNextQueuedDispatch(aid);
			}
		}
	}

	beginInteractiveTurn(
		sessionResourceOrAgentId: string,
		options?: {
			readonly userPrompt?: string;
			readonly isDirectUserChat?: boolean;
		},
	): {
		readonly turnId: string;
		readonly missionId: string;
		readonly nodeId: string;
		readonly tokenId?: string;
		readonly autoMintedRootToken?: boolean;
	} | undefined {
		const projects = this.host.projectsService;
		const missions = this.host.missionService;
		const key = sessionResourceOrAgentId?.trim();
		if (!projects || !missions || !key) {
			return undefined;
		}
		const agent = projects.getAgent(key)
			?? projects.agents.find(a => a.session?.resource.toString() === key);
		if (!agent) {
			return undefined;
		}
		let blockedMatch: { readonly missionId: string; readonly nodeId: string; readonly tokenId: string } | undefined;
		for (const rec of missions.listMissions()) {
			const orch = rec.orchestrationRuntime;
			if (orch && orch.status !== 'paused' && orch.status !== 'aborted') {
				const activeOrchTok = Object.values(orch.tokens).find(tok => {
					const assigned = orch.nodeAgentIds[tok.nodeId];
					return tok.status === 'active' && (assigned === agent.id || (!assigned && tok.holderAgentId === agent.id));
				});
				if (activeOrchTok) {
					const now = Date.now();
					const turnId = `interactive-${++this.host.turnAttributionSeq}-${now.toString(36)}`;
					this.registerTurnAttribution({
						turnId,
						missionId: rec.id,
						nodeId: activeOrchTok.nodeId,
						tokenId: activeOrchTok.id,
						agentId: agent.id,
						sessionResource: agent.session?.resource.toString() ?? (key.includes(':') ? key : undefined),
						source: 'interactive',
						startedAt: now,
					});
					return {
						turnId,
						missionId: rec.id,
						nodeId: activeOrchTok.nodeId,
						tokenId: activeOrchTok.id,
					};
				}
				if (!blockedMatch) {
					const blockedOrchTok = Object.values(orch.tokens).find(tok => {
						const assigned = orch.nodeAgentIds[tok.nodeId];
						return tok.status === 'blocked' && (assigned === agent.id || (!assigned && tok.holderAgentId === agent.id));
					});
					if (blockedOrchTok) {
						blockedMatch = { missionId: rec.id, nodeId: blockedOrchTok.nodeId, tokenId: blockedOrchTok.id };
					}
				}
			}
			const state = rec.runtime;
			if (!state || state.status === 'completed' || state.status === 'stopped' || state.status === 'failed') {
				continue;
			}
			const activeTok = Object.values(state.tokens).find(tok => {
				const assigned = state.boundary.nodeAssignments[tok.nodeId]?.agentId;
				return tok.status === 'active' && (assigned === agent.id || (!assigned && tok.holderAgentId === agent.id));
			});
			if (activeTok) {
				const now = Date.now();
				const turnId = `interactive-${++this.host.turnAttributionSeq}-${now.toString(36)}`;
				this.registerTurnAttribution({
					turnId,
					missionId: rec.id,
					nodeId: activeTok.nodeId,
					tokenId: activeTok.id,
					agentId: agent.id,
					sessionResource: agent.session?.resource.toString() ?? (key.includes(':') ? key : undefined),
					source: 'interactive',
					startedAt: now,
				});
				return {
					turnId,
					missionId: rec.id,
					nodeId: activeTok.nodeId,
					tokenId: activeTok.id,
				};
			}
			if (!blockedMatch) {
				const blockedTok = Object.values(state.tokens).find(tok => {
					const assigned = state.boundary.nodeAssignments[tok.nodeId]?.agentId;
					return tok.status === 'blocked' && (assigned === agent.id || (!assigned && tok.holderAgentId === agent.id));
				});
				if (blockedTok) {
					blockedMatch = { missionId: rec.id, nodeId: blockedTok.nodeId, tokenId: blockedTok.id };
				}
			}
		}
		if (blockedMatch) {
			const now = Date.now();
			const turnId = `interactive-${++this.host.turnAttributionSeq}-${now.toString(36)}`;
			this.registerTurnAttribution({
				turnId,
				missionId: blockedMatch.missionId,
				nodeId: blockedMatch.nodeId,
				tokenId: blockedMatch.tokenId,
				agentId: agent.id,
				sessionResource: agent.session?.resource.toString() ?? (key.includes(':') ? key : undefined),
				source: 'interactive',
				startedAt: now,
			});
			return {
				turnId,
				missionId: blockedMatch.missionId,
				nodeId: blockedMatch.nodeId,
				tokenId: blockedMatch.tokenId,
			};
		}

		const rawUserPrompt = options?.isDirectUserChat ? options.userPrompt?.trim() : undefined;
		if (rawUserPrompt) {
			const binding = this.host.findMissionForAgent(agent.id);
			if (binding?.isOrchestrationStaff && binding.mission.orchestrationText?.trim()) {
				const rec = binding.mission;
				const parsedOrch = parseOrchestrationGraph(rec.orchestrationText!);
				if (!parsedOrch.error) {
					const orchState = this.host.ensureSynchronizedOrchestrationState(rec);
					if (orchState.status !== 'paused' && orchState.status !== 'aborted') {
						const staffNodeId = binding.nodeIds[0]
							?? Object.entries(orchState.nodeAgentIds).find(([, aid]) => aid === agent.id)?.[0];
						const staffNode = staffNodeId ? parsedOrch.nodes.find(n => n.id === staffNodeId && n.kind === 'staff') : undefined;
						const highestNode = findHighestRankStaffNode(parsedOrch);
						const highestConfiguredTier = Math.min(...this.host.orgConfig.ranks.map(r => r.tier));
						const staffTier = staffNode ? resolveEffectiveStaffTier(staffNode, this.host.orgConfig) : undefined;
						const isTopLeader = Boolean(
							staffNode
							&& (
								(highestNode && staffNode.id === highestNode.id)
								|| (staffTier !== undefined && staffTier <= highestConfiguredTier)
								|| rec.ownerSessionId === agent.id
							),
						);
						if (isTopLeader && staffNode) {
							const singleLine = rawUserPrompt.replace(/\s+/g, ' ').trim();
							const headline = singleLine.length > 156 ? `${singleLine.slice(0, 155)}…` : singleLine;
							const detail = rawUserPrompt.length > 156 || rawUserPrompt.includes('\n') ? rawUserPrompt : undefined;
							const taskGraph = rec.mermaidText?.trim() ? parseMissionMermaidDag(rec.mermaidText) : undefined;
							const now = Date.now();
							const res = dispatchRequirementToOrchestration(orchState, parsedOrch, rec.whiteboards, this.host.orgConfig, {
								prompt: headline,
								...(detail ? { detail } : {}),
								targetNodeId: staffNode.id,
								...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses: rec.taskStatuses } : {}),
								now,
							});
							if (res.ok && res.data?.tokenId) {
								this.host.commitOrchestrationState(rec.id, res.state);
								const turnId = `interactive-${++this.host.turnAttributionSeq}-${now.toString(36)}`;
								this.registerTurnAttribution({
									turnId,
									missionId: rec.id,
									nodeId: staffNode.id,
									tokenId: res.data.tokenId,
									agentId: agent.id,
									sessionResource: agent.session?.resource.toString() ?? (key.includes(':') ? key : undefined),
									source: 'interactive',
									startedAt: now,
								});
								return {
									turnId,
									missionId: rec.id,
									nodeId: staffNode.id,
									tokenId: res.data.tokenId,
									autoMintedRootToken: true,
								};
							}
						}
					}
				}
			}
		}

		return undefined;
	}

	endInteractiveTurn(turnId: string): void {
		this.finalizeTurnAttribution(turnId?.trim());
	}

	recordTurnUsageBySessionResource(
		sessionResource: string,
		usage: IMissionTurnUsageInput,
		options?: {
			readonly turnId?: string;
			readonly missionId?: string;
			readonly nodeId?: string;
			readonly tokenId?: string;
		},
	): void {
		const missions = this.host.missionService;
		if (!missions) {
			return;
		}
		const explicitTurnId = options?.turnId?.trim() || usage.turnId?.trim();
		if (explicitTurnId) {
			const bound = this.host.turnAttributionById.get(explicitTurnId);
			if (bound) {
				this.recordNodeTurnUsage(bound.missionId, bound.nodeId, usage);
				return;
			}
		}
		const explicitMissionId = options?.missionId?.trim();
		const explicitNodeId = options?.nodeId?.trim();
		if (explicitMissionId && explicitNodeId) {
			this.recordNodeTurnUsage(explicitMissionId, explicitNodeId, usage);
			return;
		}
		const explicitTokenId = options?.tokenId?.trim() || usage.tokenId?.trim();
		if (explicitTokenId) {
			for (const rec of missions.listMissions()) {
				const tok = rec.runtime?.tokens[explicitTokenId];
				if (tok) {
					this.recordNodeTurnUsage(rec.id, tok.nodeId, usage);
					return;
				}
				const orchTok = rec.orchestrationRuntime?.tokens[explicitTokenId];
				if (orchTok) {
					this.recordNodeTurnUsage(rec.id, orchTok.nodeId, usage);
					return;
				}
			}
		}

		const projects = this.host.projectsService;
		if (!projects || !sessionResource) {
			return;
		}
		const key = sessionResource.trim();
		const agent = projects.getAgent(key)
			?? projects.agents.find(a => a.session?.resource.toString() === key);
		if (!agent) {
			return;
		}
		const agentSessionUri = agent.session?.resource.toString();

		const inFlight = (agentSessionUri ? this.host.inFlightTurnBySession.get(agentSessionUri) : undefined)
			?? this.host.inFlightTurnBySession.get(key)
			?? this.host.inFlightTurnByAgent.get(agent.id);
		if (inFlight) {
			this.recordNodeTurnUsage(inFlight.missionId, inFlight.nodeId, usage);
			return;
		}

		const now = Date.now();
		const allMissions = missions.listMissions();
		let activeMatch: { readonly missionId: string; readonly nodeId: string; readonly arrivedAt: number } | undefined;
		let recentFinishedToken: { readonly missionId: string; readonly nodeId: string; readonly lastActivityAt: number } | undefined;

		for (const rec of allMissions) {
			const orch = rec.orchestrationRuntime;
			if (orch) {
				for (const oTok of Object.values(orch.tokens)) {
					const assigned = orch.nodeAgentIds[oTok.nodeId];
					if (oTok.holderAgentId !== agent.id && assigned !== agent.id) {
						continue;
					}
					if (oTok.status === 'active') {
						if (!activeMatch || oTok.arrivedAt >= activeMatch.arrivedAt) {
							activeMatch = { missionId: rec.id, nodeId: oTok.nodeId, arrivedAt: oTok.arrivedAt };
						}
					} else if ((now - oTok.lastActivityAt) <= DELAYED_TURN_USAGE_GRACE_MS) {
						if (!recentFinishedToken || oTok.lastActivityAt >= recentFinishedToken.lastActivityAt) {
							recentFinishedToken = { missionId: rec.id, nodeId: oTok.nodeId, lastActivityAt: oTok.lastActivityAt };
						}
					}
				}
			}
			const state = rec.runtime;
			if (!state) {
				continue;
			}
			const isLiveMission = state.status !== 'completed' && state.status !== 'stopped' && state.status !== 'failed';
			for (const tok of Object.values(state.tokens)) {
				const assigned = state.boundary.nodeAssignments[tok.nodeId]?.agentId;
				if (tok.holderAgentId !== agent.id && assigned !== agent.id) {
					continue;
				}
				if (isLiveMission && tok.status === 'active') {
					if (!activeMatch || tok.arrivedAt >= activeMatch.arrivedAt) {
						activeMatch = { missionId: rec.id, nodeId: tok.nodeId, arrivedAt: tok.arrivedAt };
					}
				} else if (
					(tok.status === 'completed' || tok.status === 'blocked' || tok.status === 'frozen_failed' || tok.status === 'recalled')
					&& (now - tok.lastActivityAt) <= DELAYED_TURN_USAGE_GRACE_MS
				) {
					if (!recentFinishedToken || tok.lastActivityAt >= recentFinishedToken.lastActivityAt) {
						recentFinishedToken = { missionId: rec.id, nodeId: tok.nodeId, lastActivityAt: tok.lastActivityAt };
					}
				}
			}
		}

		if (activeMatch) {
			this.recordNodeTurnUsage(activeMatch.missionId, activeMatch.nodeId, usage);
			return;
		}

		const lastBound = (agentSessionUri ? this.host.lastTurnBySession.get(agentSessionUri) : undefined)
			?? this.host.lastTurnBySession.get(key)
			?? this.host.lastTurnByAgent.get(agent.id);
		const lastBoundTime = lastBound?.finishedAt ?? lastBound?.startedAt ?? 0;
		const hasFreshLastBound = Boolean(lastBound && (now - lastBoundTime) <= DELAYED_TURN_USAGE_GRACE_MS);

		if (hasFreshLastBound && (!recentFinishedToken || lastBoundTime >= recentFinishedToken.lastActivityAt)) {
			this.recordNodeTurnUsage(lastBound!.missionId, lastBound!.nodeId, usage);
			return;
		}
		if (recentFinishedToken) {
			this.recordNodeTurnUsage(recentFinishedToken.missionId, recentFinishedToken.nodeId, usage);
			return;
		}

		for (const rec of allMissions) {
			const state = rec.runtime;
			if (!state || state.status === 'completed' || state.status === 'stopped' || state.status === 'failed') {
				continue;
			}
			const assignedNodes = Object.entries(state.boundary.nodeAssignments)
				.filter(([, assign]) => assign.agentId === agent.id)
				.map(([nid]) => nid);
			if (assignedNodes.length === 1 || (state.status === 'idle' && assignedNodes.length > 0)) {
				this.recordNodeTurnUsage(rec.id, assignedNodes[0], usage);
				return;
			}
		}
	}

	async handleWatchdogWakeup(ev: IAdeWatchdogWakeupEvent): Promise<void> {
		const rec = this.host.missionService?.getMission(ev.missionId);
		if (!rec) {
			return;
		}
		// 0. Orchestration join barrier deadline expiry supervision (Contract C6).
		if (ev.reason === 'barrier_deadline_expired') {
			const barrierId = ev.barrierId?.trim() || ev.tokenId?.trim();
			if (!barrierId || !rec.orchestrationRuntime?.joinBarriers?.[barrierId]) {
				return;
			}
			const orchState = this.host.ensureSynchronizedOrchestrationState(rec);
			const orchGraph = parseOrchestrationGraph(rec.orchestrationText ?? '');
			const taskGraph = rec.mermaidText?.trim() ? parseMissionMermaidDag(rec.mermaidText) : undefined;
			const expired = expireOrchestrationJoinBarrier(orchState, orchGraph, rec.whiteboards, this.host.orgConfig, {
				barrierId,
				reason: ev.detail,
				...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses: rec.taskStatuses } : {}),
				now: ev.timestamp,
			});
			if (expired.ok) {
				this.host.commitOrchestrationState(rec.id, expired.state);
				await this.executeOrchestrationEffects(rec, expired.effects);
			}
			return;
		}
		// 1. Check Orchestration cyclic re-entrant token watchdog first.
		if (rec.orchestrationRuntime?.tokens[ev.tokenId]) {
			const orchState = this.host.ensureSynchronizedOrchestrationState(rec);
			const result = (ev.reason === 'block_expired' || ev.reason === 'pid_exited' || ev.reason === 'file_ready')
				? wakeBlockedOrchestrationToken(orchState, {
					tokenId: ev.tokenId,
					reason: ev.reason,
					detail: ev.detail,
					now: ev.timestamp,
				})
				: recordOrchestrationSilenceReminder(orchState, {
					tokenId: ev.tokenId,
					detail: ev.detail,
					now: ev.timestamp,
				});
			if (result.ok) {
				this.host.commitOrchestrationState(rec.id, result.state);
				await this.executeOrchestrationEffects(rec, result.effects, {
					preferReattachForRemote: ev.reason === 'agent_exited',
				});
				// Auto-escalate to direct superior (or Human ADE Inbox) every 3 consecutive unacknowledged silence nudges.
				if (ev.reason === 'silence_timeout' || ev.reason === 'agent_exited') {
					const updatedTok = result.state.tokens[ev.tokenId];
					const nudgeCount = updatedTok?.nudgeCount ?? 0;
					if (updatedTok && updatedTok.status === 'active' && nudgeCount >= 3 && nudgeCount % 3 === 0) {
						const holderAgentId = result.state.nodeAgentIds[updatedTok.nodeId] ?? updatedTok.holderAgentId;
						await this.host.escalate(rec.id, {
							callerSupervisorId: holderAgentId ?? updatedTok.nodeId,
							nodeId: updatedTok.nodeId,
							tokenId: updatedTok.id,
							reason: `Staff node "${updatedTok.nodeId}" remained unresponsive after ${nudgeCount} consecutive watchdog reminders (${ev.reason}) for baton "${updatedTok.id}".`,
						}).catch(() => undefined);
					}
				}
			}
			return;
		}
		// 2. Legacy Mission DAG watchdog path
		if (rec.runtime?.status !== 'running') {
			return;
		}
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = recordWatchdogWakeup(rec.runtime, {
			tokenId: ev.tokenId,
			reason: ev.reason,
			detail: ev.detail,
			graph,
			owner: { ownerSessionId: rec.ownerSessionId, ownerTier: rec.ownerTier },
			now: ev.timestamp,
		});
		if (result.ok) {
			this.host.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
	}

	async handleSourceTriggerFire(ev: IAdeSourceTriggerFireEvent): Promise<void> {
		const rec = this.host.missionService?.getMission(ev.missionId);
		if (!rec || rec.runtime?.status !== 'running') {
			return;
		}
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = fireMissionSourceTrigger(rec.runtime, graph, {
			triggerId: ev.triggerId,
			payloadSummary: ev.detail,
			now: ev.timestamp,
		});
		if (result.ok) {
			this.host.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
	}

	private async ensureAgentSessionReady(agent: IAdeAgent): Promise<URI | undefined> {
		if (agent.session?.resource) {
			return agent.session.resource;
		}
		const sessions = this.host.sessionsService;
		const projects = this.host.projectsService;
		if (!sessions || !projects) {
			return undefined;
		}
		const available = await sessions.getEngines(agent.projectUri).catch(() => []);
		const engineId = normalizeAdeEngineId(agent.preferredEngineId) || available[0]?.id;
		if (!engineId) {
			return undefined;
		}
		const created = await sessions.create(engineId, agent.projectUri).catch(() => undefined);
		if (!created) {
			return undefined;
		}
		projects.bindSession(agent.id, created);
		return created.resource;
	}

	private isTransientDispatchError(errMsg: string): boolean {
		return /\b(502|503|504|429|520|522|524)\b|upstream connection failed|urlerror|tls handshake timeout|econnreset|etimedout|econnrefused|epipe|socket hang up|context deadline exceeded|temporarily unavailable|overloaded|rate limit|network error|\beof\b|exited with code 255|exit code 255|broken pipe|connection closed by remote host|client_loop|ssh_exchange_identification|kex_exchange_identification|network is unreachable|no route to host|host is down|connection timed out/i.test(errMsg);
	}

	flushNextQueuedDispatch(agentId: string): void {
		if ((this.host.activeTurnsByAgent.get(agentId) ?? 0) > 0) {
			return;
		}
		const queue = this.host.pendingDispatchesByAgent.get(agentId);
		if (!queue || queue.length === 0) {
			return;
		}
		const deferredPaused: typeof queue = [];
		while (queue.length > 0) {
			const next = queue.shift()!;
			if (next.options?.missionId && next.options?.tokenId) {
				const rec = this.host.missionService?.getMission(next.options.missionId);
				const orchTok = rec?.orchestrationRuntime?.tokens[next.options.tokenId];
				if (orchTok) {
					if (rec?.orchestrationRuntime?.status === 'paused') {
						deferredPaused.push(next);
						continue;
					}
					if (orchTok.status !== 'active') {
						continue;
					}
				} else {
					const tok = rec?.runtime?.tokens[next.options.tokenId];
					if (!rec || !tok || tok.status !== 'active') {
						continue;
					}
					if (rec.runtime?.status === 'paused') {
						deferredPaused.push(next);
						continue;
					}
					if (rec.runtime?.status !== 'running') {
						continue;
					}
				}
			}
			if (this.hasBlockingTokenForAgent(agentId, next.options?.missionId, next.options?.nodeId)) {
				deferredPaused.push(next);
				continue;
			}
			if (deferredPaused.length > 0) {
				queue.unshift(...deferredPaused);
			}
			if (queue.length === 0) {
				this.host.pendingDispatchesByAgent.delete(agentId);
			}
			void this.dispatchPromptToAgent(agentId, next.prompt, next.options).then(dispatched => {
				if (dispatched) {
					return;
				}
				if (next.options?.onDispatchError) {
					next.options.onDispatchError(`Queued dispatch failed: agent "${agentId}" or its session is unavailable.`);
				} else if (next.options?.missionId && next.options?.tokenId) {
					const failReason = `Unable to dispatch queued token ${next.options.tokenId} on node ${next.options.nodeId ?? ''} (agent "${agentId}" unavailable).`;
					if (next.options.tokenId.startsWith('otok-')) {
						void this.host.failOrchestrationToken(next.options.missionId, { tokenId: next.options.tokenId, reason: failReason }).catch(() => undefined);
					} else {
						void this.host.failToken(next.options.missionId, { tokenId: next.options.tokenId, reason: failReason }).catch(() => undefined);
					}
				}
			}, err => {
				const reason = err instanceof Error ? err.message : String(err ?? 'Queued dispatch error');
				if (next.options?.onDispatchError) {
					next.options.onDispatchError(reason);
				} else if (next.options?.missionId && next.options?.tokenId) {
					const failReason = `Queued dispatch error on node ${next.options.nodeId ?? ''}: ${reason.slice(0, 300)}`;
					if (next.options.tokenId.startsWith('otok-')) {
						void this.host.failOrchestrationToken(next.options.missionId, { tokenId: next.options.tokenId, reason: failReason }).catch(() => undefined);
					} else {
						void this.host.failToken(next.options.missionId, { tokenId: next.options.tokenId, reason: failReason }).catch(() => undefined);
					}
				}
			});
			return;
		}
		if (deferredPaused.length > 0) {
			this.host.pendingDispatchesByAgent.set(agentId, deferredPaused);
		} else {
			this.host.pendingDispatchesByAgent.delete(agentId);
		}
	}

	async dispatchPromptToAgent(
		agentId: string | undefined,
		prompt: string,
		options?: IPendingAgentDispatchOptions,
	): Promise<boolean> {
		if (!agentId || !this.host.projectsService || !this.host.commandService) {
			return false;
		}
		if (agentId === ADE_SECRETARY_ID) {
			const secSession = this.host.projectsService.secretary.session;
			if (!secSession) {
				this.host.projectsService.setSecretaryDraft(prompt);
				return options?.requireLiveDelivery ? false : true;
			}
			void this.host.commandService.executeCommand('aexus.agentEngines.dispatchEngineeringTurn', secSession.resource, prompt, {
				agentId: ADE_SECRETARY_ID,
				pureWorker: false,
				callerRole: 'secretary',
				autonomousApproved: options?.autonomousApproved ?? true,
			}).catch(err => {
				const errMsg = err instanceof Error ? err.message : String(err ?? 'Unknown Secretary dispatch error');
				options?.onDispatchError?.(errMsg);
			});
			return true;
		}
		const agent = this.host.projectsService.getAgent(agentId);
		if (!agent) {
			return false;
		}
		const trackedMissionId = options?.missionId;
		const trackedTokenId = options?.tokenId;
		const trackedNodeId = options?.nodeId;
		const dedupeKey = options?.dedupeKey ?? (trackedMissionId && trackedTokenId ? `${trackedMissionId}:${trackedTokenId}` : undefined);

		const enqueueForAgent = () => {
			const queue = this.host.pendingDispatchesByAgent.get(agent.id) ?? [];
			const alreadyQueued = dedupeKey
				? queue.some(item => (item.options?.dedupeKey ?? (item.options?.missionId && item.options?.tokenId ? `${item.options.missionId}:${item.options.tokenId}` : undefined)) === dedupeKey)
				: false;
			if (!alreadyQueued) {
				queue.push({ prompt, options });
				this.host.pendingDispatchesByAgent.set(agent.id, queue);
			}
		};

		if (
			(this.host.activeTurnsByAgent.get(agent.id) ?? 0) > 0
			|| this.hasBlockingTokenForAgent(agent.id, trackedMissionId, trackedNodeId)
		) {
			enqueueForAgent();
			return true;
		}

		this.host.activeTurnsByAgent.set(agent.id, 1);
		let slotClaimed = true;
		const releaseSlot = () => {
			if (!slotClaimed) {
				return;
			}
			slotClaimed = false;
			const remaining = Math.max(0, (this.host.activeTurnsByAgent.get(agent.id) ?? 1) - 1);
			if (remaining === 0) {
				this.host.activeTurnsByAgent.delete(agent.id);
				this.host.projectsService?.setAgentStatus(agent.id, 'idle');
				this.flushNextQueuedDispatch(agent.id);
			} else {
				this.host.activeTurnsByAgent.set(agent.id, remaining);
			}
		};

		let resource: URI | undefined;
		try {
			resource = await this.ensureAgentSessionReady(agent);
		} catch {
			releaseSlot();
			return false;
		}
		if (!resource) {
			releaseSlot();
			return false;
		}

		if (trackedMissionId && trackedTokenId) {
			const freshRec = this.host.missionService?.getMission(trackedMissionId);
			const freshOrchTok = freshRec?.orchestrationRuntime?.tokens[trackedTokenId];
			if (freshOrchTok) {
				if (freshOrchTok.status !== 'active') {
					releaseSlot();
					return true;
				}
			} else {
				const freshTok = freshRec?.runtime?.tokens[trackedTokenId];
				if (!freshRec || freshRec.runtime?.status !== 'running' || !freshTok || freshTok.status !== 'active') {
					releaseSlot();
					return true;
				}
			}
		}

		const rankDef = resolveEffectiveRankDefinition(this.host.orgConfig, agent.role, this.host.projectsService.hasSubordinates(agent.id));
		const boundTurnId = trackedMissionId && trackedNodeId
			? `dispatch-${++this.host.turnAttributionSeq}-${Date.now().toString(36)}`
			: undefined;
		if (boundTurnId && trackedMissionId && trackedNodeId) {
			this.registerTurnAttribution({
				turnId: boundTurnId,
				missionId: trackedMissionId,
				nodeId: trackedNodeId,
				tokenId: trackedTokenId,
				agentId: agent.id,
				sessionResource: resource.toString(),
				source: 'dispatch',
				startedAt: Date.now(),
			});
		}
		this.host.projectsService.setAgentStatus(agent.id, 'working');
		const circuitKey = `${agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : 'local'}:${agent.session?.engineId ?? agent.preferredEngineId ?? 'default'}`;
		const dispatchPromise = this.host.commandService.executeCommand<{
			readonly reply?: string;
			readonly stopped?: boolean;
			readonly usage?: IMissionTurnUsageInput;
		} | undefined>('aexus.agentEngines.dispatchEngineeringTurn', resource, prompt, {
			agentId: agent.id,
			missionId: trackedMissionId,
			nodeId: trackedNodeId,
			tokenId: trackedTokenId,
			turnId: boundTurnId,
			model: agent.preferredModel,
			thinking: agent.preferredThinking,
			pureWorker: Boolean(rankDef.pureExecution && !(trackedNodeId || agent.treeNodeId || (agent.treeNodeIds && agent.treeNodeIds.length > 0))),
			isMissionNode: Boolean(trackedNodeId || agent.treeNodeId || (agent.treeNodeIds && agent.treeNodeIds.length > 0)),
			callerRole: rankDef.id,
			autonomousApproved: options?.autonomousApproved ?? true,
			...(options?.preferReattach ? { preferReattach: true } : {}),
		});
		let turnTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const timedDispatch = this.host.engineeringTurnTimeoutMs > 0
			? Promise.race([
				dispatchPromise,
				new Promise<never>((_resolve, reject) => {
					turnTimeoutHandle = setTimeout(() => {
						const latest = this.host.projectsService?.getAgent(agent.id);
						if (latest?.session && this.host.sessionsService?.stop) {
							const hostAlias = latest.projectUri.scheme === AEXUS_SSH_SCHEME ? latest.projectUri.authority : undefined;
							void this.host.sessionsService.stop(latest.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
						}
						reject(new Error(`Transient engineering turn timeout after ${this.host.engineeringTurnTimeoutMs}ms`));
					}, this.host.engineeringTurnTimeoutMs);
				}),
			]).finally(() => {
				if (turnTimeoutHandle !== undefined) {
					clearTimeout(turnTimeoutHandle);
					turnTimeoutHandle = undefined;
				}
			})
			: dispatchPromise;
		void timedDispatch.then(
			turnRes => {
				this.host.transientCircuitFailuresByKey.delete(circuitKey);
				if (trackedMissionId && trackedTokenId) {
					this.host.transientRetryCount.delete(`${trackedMissionId}:${trackedTokenId}`);
				}
				if (turnRes && typeof turnRes === 'object') {
					const latestAgent = this.host.projectsService?.getAgent(agent.id) ?? agent;
					const conciseReply = typeof turnRes.reply === 'string' && turnRes.reply.trim()
						? turnRes.reply.trim().split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 120)
						: undefined;
					if (turnRes.usage || conciseReply) {
						const payload: IMissionTurnUsageInput = {
							...(turnRes.usage ?? {}),
							...(boundTurnId ? { turnId: boundTurnId } : {}),
							...(trackedTokenId ? { tokenId: trackedTokenId } : {}),
							...(turnRes.usage?.isNoiseTurn === undefined && options?.isNoiseTurn ? { isNoiseTurn: true } : {}),
							model: turnRes.usage?.model || latestAgent.preferredModel,
							engineId: turnRes.usage?.engineId || latestAgent.session?.engineId || latestAgent.preferredEngineId,
							...(conciseReply ? { summary: conciseReply } : {}),
						};
						if (trackedMissionId && trackedNodeId) {
							this.recordNodeTurnUsage(trackedMissionId, trackedNodeId, payload);
						} else {
							this.recordTurnUsageBySessionResource(resource.toString(), payload, {
								turnId: boundTurnId,
								tokenId: trackedTokenId,
							});
						}
					}
				}
				this.finalizeTurnAttribution(boundTurnId);
				releaseSlot();
				if (trackedMissionId && trackedTokenId && trackedNodeId && !turnRes?.stopped) {
					this.scheduleUnclosedTokenCheck(trackedMissionId, trackedTokenId, trackedNodeId, agent.id);
				}
			},
			err => {
				this.finalizeTurnAttribution(boundTurnId);
				releaseSlot();
				const errMsg = err instanceof Error ? err.message : String(err ?? 'Unknown engine dispatch error');
				const isTransient = this.isTransientDispatchError(errMsg);
				if (isTransient) {
					const now = Date.now();
					const prev = this.host.transientCircuitFailuresByKey.get(circuitKey);
					const nextCount = prev && now - prev.lastFailureAt < 120_000 ? prev.count + 1 : 1;
					this.host.transientCircuitFailuresByKey.set(circuitKey, { count: nextCount, lastFailureAt: now });
				}

				if (trackedMissionId && trackedTokenId) {
					const retryKey = `${trackedMissionId}:${trackedTokenId}`;
					const rec = this.host.missionService?.getMission(trackedMissionId);
					const orchTok = rec?.orchestrationRuntime?.tokens[trackedTokenId];
					if (orchTok) {
						if (rec?.orchestrationRuntime?.status !== 'paused' && rec?.orchestrationRuntime?.status !== 'aborted' && !rec?.orchestrationRuntime?.budgetCircuitTripped && orchTok.status === 'active') {
							const prevAttempts = this.host.transientRetryCount.get(retryKey) ?? 0;
							const backoffsMs = this.host.transientRetryBackoffsMs;
							if (isTransient && prevAttempts < backoffsMs.length) {
								const attempt = prevAttempts + 1;
								const delayMs = this.host.computeTransientRetryDelayMs(backoffsMs[prevAttempts], circuitKey);
								this.host.transientRetryCount.set(retryKey, attempt);
								this.touchAgentActivity(agent.id, Date.now());
								this.host.scheduleTrackedTimer(trackedMissionId, () => {
									const latestRec = this.host.missionService?.getMission(trackedMissionId);
									const latestOrch = latestRec?.orchestrationRuntime;
									const latestTok = latestOrch?.tokens[trackedTokenId];
									if (!latestRec || !latestOrch || latestOrch.status === 'paused' || latestOrch.status === 'aborted' || latestOrch.budgetCircuitTripped || !latestTok || latestTok.status !== 'active') {
										this.host.transientRetryCount.delete(retryKey);
										return;
									}
									this.touchAgentActivity(agent.id, Date.now());
									const retryPrompt = [
										`[Automatic Transient Error Recovery #${attempt}/${backoffsMs.length} · Staff \`${trackedNodeId ?? latestTok.nodeId}\` · Baton \`${trackedTokenId}\`]`,
										`Your previous turn was interrupted by a transient gateway/network error (\`${errMsg.slice(0, 220)}\`).`,
										`Inspect your workspace (keep any files you already wrote), finish remaining work, and advance baton \`${trackedTokenId}\` via \`aexus-ade token return|handoff|mint|complete --mission ${trackedMissionId}\`.`,
									].join('\n');
									void this.dispatchPromptToAgent(agent.id, retryPrompt, {
										...options,
										retryAttempt: attempt,
										isNoiseTurn: true,
									});
								}, delayMs);
								return;
							}
							this.host.transientRetryCount.delete(retryKey);
							this.host.unclosedTurnNudgeCount.delete(retryKey);
							void this.host.failOrchestrationToken(trackedMissionId, {
								tokenId: trackedTokenId,
								reason: `Engine dispatch error on staff ${trackedNodeId ?? orchTok.nodeId}: ${errMsg.slice(0, 400)}`,
							}).catch(() => undefined);
						}
						return;
					}
					const tok = rec?.runtime?.tokens[trackedTokenId];
					if (rec?.runtime?.status === 'running' && tok?.status === 'active') {
						const prevAttempts = this.host.transientRetryCount.get(retryKey) ?? 0;
						const backoffsMs = this.host.transientRetryBackoffsMs;
						if (isTransient && prevAttempts < backoffsMs.length) {
							const attempt = prevAttempts + 1;
							const delayMs = this.host.computeTransientRetryDelayMs(backoffsMs[prevAttempts], circuitKey);
							this.host.transientRetryCount.set(retryKey, attempt);
							this.touchAgentActivity(agent.id, Date.now());
							this.host.scheduleTrackedTimer(trackedMissionId, () => {
								const latestRec = this.host.missionService?.getMission(trackedMissionId);
								const latestTok = latestRec?.runtime?.tokens[trackedTokenId];
								if (!latestRec || latestRec.runtime?.status !== 'running' || !latestTok || latestTok.status !== 'active') {
									this.host.transientRetryCount.delete(retryKey);
									return;
								}
								this.touchAgentActivity(agent.id, Date.now());
								const retryPrompt = [
									`[Automatic Transient Error Recovery #${attempt}/${backoffsMs.length} · Node \`${trackedNodeId ?? latestTok.nodeId}\` · Token \`${trackedTokenId}\`]`,
									`Your previous turn was interrupted by a transient gateway/network error (\`${errMsg.slice(0, 220)}\`).`,
									`Inspect your workspace (keep any files you already wrote), finish remaining deliverables & tests, and close token \`${trackedTokenId}\` via \`aexus-ade token complete ${trackedTokenId} --summary "..."\`.`,
								].join('\n');
								void this.dispatchPromptToAgent(agent.id, retryPrompt, {
									...options,
									retryAttempt: attempt,
									isNoiseTurn: true,
								});
							}, delayMs);
							return;
						}
						this.host.transientRetryCount.delete(retryKey);
						this.host.unclosedTurnNudgeCount.delete(retryKey);
						void this.host.failToken(trackedMissionId, {
							tokenId: trackedTokenId,
							reason: `Engine dispatch error on node ${trackedNodeId ?? tok.nodeId}: ${errMsg.slice(0, 400)}`,
						}).catch(() => undefined);
					}
					return;
				}

				const escAttempt = options?.retryAttempt ?? 0;
				const escBackoffsMs = [10_000, 25_000];
				if (isTransient && options?.requireLiveDelivery && escAttempt < escBackoffsMs.length) {
					const delayMs = this.host.computeTransientRetryDelayMs(escBackoffsMs[escAttempt], circuitKey);
					this.host.scheduleTrackedTimer(trackedMissionId, () => {
						void this.dispatchPromptToAgent(agent.id, prompt, {
							...options,
							retryAttempt: escAttempt + 1,
						});
					}, delayMs);
					return;
				}

				options?.onDispatchError?.(errMsg);
			},
		);
		return true;
	}

	private scheduleUnclosedTokenCheck(missionId: string, tokenId: string, nodeId: string, agentId: string): void {
		const nudgeKey = `${missionId}:${tokenId}`;
		if (tokenId.startsWith('otok-')) {
			if ((this.host.unclosedTurnNudgeCount.get(nudgeKey) ?? 0) >= 1) {
				return;
			}
			this.host.scheduleTrackedTimer(missionId, () => {
				const rec = this.host.missionService?.getMission(missionId);
				const orch = rec?.orchestrationRuntime;
				if (!rec || !orch || orch.status === 'paused' || orch.status === 'aborted') {
					this.host.unclosedTurnNudgeCount.delete(nudgeKey);
					return;
				}
				const tok = orch.tokens[tokenId];
				if (!tok || tok.status !== 'active' || tok.nodeId !== nodeId) {
					this.host.unclosedTurnNudgeCount.delete(nudgeKey);
					return;
				}
				const hasLiveChildren = (tok.childTokenIds ?? []).some(cid => {
					const child = orch.tokens[cid];
					return Boolean(child && (child.status === 'active' || child.status === 'blocked' || child.status === 'waiting_join'));
				});
				if (hasLiveChildren || (this.host.activeTurnsByAgent.get(agentId) ?? 0) > 0) {
					return;
				}
				this.host.unclosedTurnNudgeCount.set(nudgeKey, 1);
				const primaryAction = tok.returnToNodeId
					? `aexus-ade token return ${tokenId} --summary "<1-line>" --mission ${missionId} --json`
					: `aexus-ade token mint|handoff|complete ${tokenId} --mission ${missionId} --json`;
				const reminder = [
					`[Aexus Baton Reminder · ${nodeId} · ${tokenId}] Turn ended with baton still ACTIVE.`,
					`Advance now: \`${primaryAction}\` (or \`token block ${tokenId} --duration <30m|2h> --reason "..."\` / \`token fail ${tokenId} --reason "..."\`).`,
				].join('\n');
				void this.dispatchPromptToAgent(agentId, reminder, {
					autonomousApproved: true,
					missionId,
					tokenId,
					nodeId,
					dedupeKey: `orch-fast-nudge:${missionId}:${tokenId}`,
					isNoiseTurn: true,
				});
			}, 8_000);
			return;
		}
		this.host.scheduleTrackedTimer(missionId, () => {
			const rec = this.host.missionService?.getMission(missionId);
			if (!rec || rec.runtime?.status !== 'running') {
				this.host.unclosedTurnNudgeCount.delete(nudgeKey);
				return;
			}
			const tok = rec.runtime.tokens[tokenId];
			if (!tok || tok.status !== 'active' || tok.nodeId !== nodeId) {
				this.host.unclosedTurnNudgeCount.delete(nudgeKey);
				return;
			}
			const count = (this.host.unclosedTurnNudgeCount.get(nudgeKey) ?? 0) + 1;
			this.host.unclosedTurnNudgeCount.set(nudgeKey, count);
			if (count <= 2) {
				const checkHintLines = tok.lastCheckFailure
					? [
						`Last deterministic verification FAILED (attempt ${tok.lastCheckFailure.attempt}/${tok.lastCheckFailure.maxAutoRetries}): ${tok.lastCheckFailure.summary}`,
						`Fix the failure, self-check with \`aexus-ade mission check run --mission ${missionId} --node ${nodeId} --json\`, then call \`aexus-ade token complete ${tokenId} --summary "..."\`.`,
					]
					: [
						`You MUST close this token via the shell right now so downstream nodes can proceed:`,
						`- If finished: \`aexus-ade token complete ${tokenId} --summary "<concise factual summary of deliverables & test results>"\``,
						`- If blocked/unrecoverable: \`aexus-ade token fail ${tokenId} --reason "<exact failure reason>"\``,
					];
				const reminder = [
					`[Mission Token Reminder #${count}/2 · Node \`${nodeId}\` · Token \`${tokenId}\`]`,
					`Your previous turn ended while token \`${tokenId}\` is still ACTIVE.`,
					...checkHintLines,
					`Run the command immediately without repeating completed work.`,
				].join('\n');
				void this.dispatchPromptToAgent(agentId, reminder, {
					autonomousApproved: true,
					missionId,
					tokenId,
					nodeId,
					isNoiseTurn: true,
				});
			} else {
				this.host.unclosedTurnNudgeCount.delete(nudgeKey);
				void this.host.failToken(missionId, {
					tokenId,
					reason: `Node ${nodeId} ended its turn ${count} times without closing token ${tokenId} via aexus-ade token complete/fail.`,
				}).catch(() => undefined);
			}
		}, 1500);
	}

	async recoverInterruptedActiveTokens(missionId?: string): Promise<number> {
		const missions = this.host.missionService;
		const projects = this.host.projectsService;
		if (!missions || !projects || !this.host.commandService) {
			return 0;
		}
		const targetRecords = missionId
			? [missions.getMission(missionId) ?? missions.getMissionByLinkedSession(missionId)].filter((m): m is IAdeMissionRecord => Boolean(m))
			: missions.listMissions();
		let resumedCount = 0;
		for (const rec of targetRecords) {
			const isLegacyRunning = rec.runtime?.status === 'running';
			const hasPendingHeadless = Boolean(rec.orchestrationRuntime?.pendingHeadlessEffects && rec.orchestrationRuntime.pendingHeadlessEffects.length > 0);
			const hasOrchTokens = Boolean(rec.orchestrationRuntime && (hasActiveOrchestrationTokens(rec.orchestrationRuntime) || hasPendingHeadless));
			if (!isLegacyRunning && !hasOrchTokens) {
				continue;
			}
			if (!missionId && this.host.backendService?.canRecoverMission) {
				const canRecover = await this.host.backendService.canRecoverMission(rec.id).catch(() => true);
				if (!canRecover) {
					continue;
				}
			}
			if (isLegacyRunning) {
				const state = this.host.ensureSynchronizedState(rec);
				const graph = parseMissionMermaidDag(rec.mermaidText);
				const recoveredTokenIds: string[] = [];
				for (const tok of Object.values(state.tokens)) {
					if (tok.status !== 'active') {
						continue;
					}
					const targetAgentId = state.boundary.nodeAssignments[tok.nodeId]?.agentId ?? tok.holderAgentId;
					if (!targetAgentId) {
						continue;
					}
					if ((this.host.activeTurnsByAgent.get(targetAgentId) ?? 0) > 0) {
						continue;
					}
					const dedupeKey = `recover:${rec.id}:${tok.id}`;
					const queued = this.host.pendingDispatchesByAgent.get(targetAgentId);
					if (queued?.some(item => item.options?.tokenId === tok.id && item.options?.missionId === rec.id)) {
						continue;
					}
					const agent = projects.getAgent(targetAgentId);
					if (!agent) {
						continue;
					}
					const isRemoteAgent = agent.projectUri.scheme === AEXUS_SSH_SCHEME;
					const dagNode = graph.nodes.find(n => n.id === tok.nodeId);
					const nodeLabel = dagNode?.label ?? tok.nodeId;
					const recoveryPrompt = [
						`[IDE Restart Auto-Recovery · Node \`${tok.nodeId}\` (${nodeLabel}) · Token \`${tok.id}\`]`,
						`Aexus Code restarted while you held active token \`${tok.id}\` (wave \`${tok.waveId}\`).`,
						`Inspect your workspace (preserve any deliverables already written), complete remaining work and checks, and close the token via \`aexus-ade token complete ${tok.id} --summary "..."\` (or \`token block\` / \`token fail\`).`,
						tok.lastSummary ? `\n### Previous Step Summary (\`last_summary\`)\n${tok.lastSummary}` : '',
					].filter(Boolean).join('\n');
					const dispatched = await this.dispatchPromptToAgent(targetAgentId, recoveryPrompt, {
						autonomousApproved: true,
						missionId: rec.id,
						tokenId: tok.id,
						nodeId: tok.nodeId,
						dedupeKey,
						...(isRemoteAgent ? { preferReattach: true } : {}),
					});
					if (dispatched) {
						resumedCount++;
						this.host.inMemoryAgentActivityAt.set(targetAgentId, Date.now());
						recoveredTokenIds.push(tok.id);
					}
				}
				if (recoveredTokenIds.length > 0) {
					const latestRec = missions.getMission(rec.id);
					if (latestRec?.runtime?.status === 'running') {
						const latestState = this.host.ensureSynchronizedState(latestRec);
						const now = Date.now();
						let updatedTokens: Record<string, IMissionToken> | undefined;
						for (const tid of recoveredTokenIds) {
							const liveTok = latestState.tokens[tid];
							if (liveTok?.status === 'active') {
								updatedTokens ??= { ...latestState.tokens };
								updatedTokens[tid] = { ...liveTok, lastActivityAt: now };
							}
						}
						if (updatedTokens) {
							this.host.commitState(latestRec.id, { ...latestState, tokens: updatedTokens, updatedAt: now });
						}
					}
				}
			}

			if (hasOrchTokens) {
				let latestOrchRec = missions.getMission(rec.id) ?? rec;
				if (this.host.backendService?.getOrchestrationDaemonState) {
					const daemonMap = await this.host.backendService.getOrchestrationDaemonState(rec.id).catch(() => undefined);
					const daemonSnap = daemonMap?.[rec.id];
					const localUpdatedAt = latestOrchRec.orchestrationRuntime?.updatedAt ?? 0;
					if (daemonSnap && daemonSnap.updatedAt > localUpdatedAt) {
						const curOrch = this.host.ensureSynchronizedOrchestrationState(latestOrchRec);
						if (daemonSnap.status === 'paused' || daemonSnap.status === 'aborted') {
							const reconciled = daemonSnap.status === 'paused'
								? pauseOrchestration(curOrch, { reason: daemonSnap.pausedReason, now: daemonSnap.updatedAt })
								: abortOrchestrationTokens(curOrch, { reason: daemonSnap.pausedReason || 'Aborted via headless daemon', now: daemonSnap.updatedAt });
							if (reconciled.ok) {
								this.host.commitOrchestrationState(rec.id, reconciled.state);
							}
							continue;
						} else if (daemonSnap.status === 'running' && curOrch.status === 'paused') {
							const reconciled = resumeOrchestration(curOrch, { now: daemonSnap.updatedAt });
							if (reconciled.ok) {
								this.host.commitOrchestrationState(rec.id, reconciled.state);
							}
						}
					}
				}
				latestOrchRec = missions.getMission(rec.id) ?? rec;
				const orchState = this.host.ensureSynchronizedOrchestrationState(latestOrchRec);
				if (orchState.status === 'paused' || orchState.status === 'aborted' || orchState.budgetCircuitTripped) {
					continue;
				}
				const freshlyDispatchedTokenIds = new Set<string>();
				if (orchState.pendingHeadlessEffects && orchState.pendingHeadlessEffects.length > 0) {
					const queuedEffects = [...orchState.pendingHeadlessEffects];
					const drainedState: IOrchestrationRuntimeState = {
						...orchState,
						pendingHeadlessEffects: undefined,
						updatedAt: Math.max(Date.now(), orchState.updatedAt + 1),
					};
					this.host.commitOrchestrationState(latestOrchRec.id, drainedState);
					for (const eff of queuedEffects) {
						if (eff.kind === 'dispatch_token' || eff.kind === 'wakeup_blocked' || eff.kind === 'silence_reminder') {
							freshlyDispatchedTokenIds.add(eff.tokenId);
						}
					}
					await this.executeOrchestrationEffects(latestOrchRec, queuedEffects);
					resumedCount += queuedEffects.filter(e => e.kind === 'dispatch_token' || e.kind === 'wakeup_blocked' || e.kind === 'silence_reminder').length;
				}
				latestOrchRec = missions.getMission(rec.id) ?? latestOrchRec;
				const postDrainOrch = this.host.ensureSynchronizedOrchestrationState(latestOrchRec);
				const orchGraph = parseOrchestrationGraph(latestOrchRec.orchestrationText ?? '');
				const recoveredOrchTokenIds: string[] = [];
				for (const tok of Object.values(postDrainOrch.tokens)) {
					if (tok.status !== 'active' || freshlyDispatchedTokenIds.has(tok.id)) {
						continue;
					}
					const targetAgentId = postDrainOrch.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId;
					if (!targetAgentId || (this.host.activeTurnsByAgent.get(targetAgentId) ?? 0) > 0) {
						continue;
					}
					const queued = this.host.pendingDispatchesByAgent.get(targetAgentId);
					if (queued?.some(item => item.options?.tokenId === tok.id && item.options?.missionId === rec.id)) {
						continue;
					}
					const agent = projects.getAgent(targetAgentId);
					if (!agent) {
						continue;
					}
					const staffNode = orchGraph.nodes.find(n => n.id === tok.nodeId && n.kind === 'staff');
					const isRemoteAgent = agent.projectUri.scheme === AEXUS_SSH_SCHEME;
					const recoveryPrompt = [
						`[Orchestration Restart Auto-Recovery · Staff \`${tok.nodeId}\` (${staffNode?.label ?? tok.nodeId}) · Token \`${tok.id}\`]`,
						`Aexus Code restarted/reloaded while you held active Orchestration baton \`${tok.id}\` (wave \`${tok.waveId}\`).`,
						tok.lastSummary ? `- Current directive headline: ${tok.lastSummary}` : '',
						tok.payloadPtr ? `- Read detail pointer: \`aexus-ade token read ${tok.payloadPtr} --mission ${rec.id} --token ${tok.id} --json\`` : '',
						`Continue advancing your work and explicitly submit via \`token return\`, \`token handoff\`, \`token mint\`, or \`token complete --finish\`.`,
					].filter(Boolean).join('\n');
					const dispatched = await this.dispatchPromptToAgent(targetAgentId, recoveryPrompt, {
						autonomousApproved: true,
						missionId: rec.id,
						tokenId: tok.id,
						nodeId: tok.nodeId,
						dedupeKey: `recover-orch:${rec.id}:${tok.id}`,
						...(isRemoteAgent ? { preferReattach: true } : {}),
					});
					if (dispatched) {
						resumedCount++;
						this.host.inMemoryAgentActivityAt.set(targetAgentId, Date.now());
						recoveredOrchTokenIds.push(tok.id);
					}
				}
				if (recoveredOrchTokenIds.length > 0) {
					const freshRec = missions.getMission(rec.id);
					if (freshRec?.orchestrationRuntime && freshRec.orchestrationRuntime.status !== 'paused') {
						const latestOrch = this.host.ensureSynchronizedOrchestrationState(freshRec);
						const now = Date.now();
						let updatedOrchTokens: Record<string, IOrchestrationToken> | undefined;
						for (const tid of recoveredOrchTokenIds) {
							const liveTok = latestOrch.tokens[tid];
							if (liveTok?.status === 'active') {
								updatedOrchTokens ??= { ...latestOrch.tokens };
								updatedOrchTokens[tid] = { ...liveTok, lastActivityAt: now };
							}
						}
						if (updatedOrchTokens) {
							this.host.commitOrchestrationState(freshRec.id, { ...latestOrch, tokens: updatedOrchTokens, updatedAt: now });
						}
					}
				}
			}
		}
		return resumedCount;
	}

	async executeEffects(rec: IAdeMissionRecord, effects: readonly MissionEngineEffect[]): Promise<void> {
		if (effects.length === 0) {
			return;
		}
		type AgentDispatchEffect = Extract<MissionEngineEffect, { readonly kind: 'dispatch_token' | 'wakeup_agent' }>;
		const agentBuckets = new Map<string, AgentDispatchEffect[]>();
		const serialEffects: Exclude<MissionEngineEffect, AgentDispatchEffect>[] = [];

		const initialLatestRec = this.host.missionService?.getMission(rec.id) ?? rec;
		const initialLiveState = this.host.ensureSynchronizedState(initialLatestRec);
		for (const effect of effects) {
			if (effect.kind === 'dispatch_token' || effect.kind === 'wakeup_agent') {
				const targetKey = initialLiveState.boundary.nodeAssignments[effect.nodeId]?.agentId
					?? initialLiveState.tokens[effect.tokenId]?.holderAgentId
					?? effect.holderAgentId
					?? `__unbound__:${effect.nodeId}:${effect.tokenId}`;
				const list = agentBuckets.get(targetKey) ?? [];
				list.push(effect);
				agentBuckets.set(targetKey, list);
			} else {
				serialEffects.push(effect);
			}
		}

		for (const effect of serialEffects) {
			switch (effect.kind) {
				case 'stop_agent': {
					if (effect.holderAgentId) {
						const agent = this.host.projectsService?.getAgent(effect.holderAgentId);
						if (agent?.session) {
							const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
							await this.host.sessionsService?.stop?.(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
							this.host.projectsService?.setAgentStatus(agent.id, 'idle');
						}
					}
					break;
				}
				case 'upsert_gate_inbox': {
					const govId = rec.ownerSessionId ?? rec.id;
					await this.host.inboxService?.upsertUserGateTodo?.({
						governorSessionId: govId,
						treeType: 'mission',
						nodeId: effect.nodeId,
						nodeTitle: effect.nodeTitle,
						description: `Human Gate "${effect.nodeTitle}" (token ${effect.tokenId}) requires Approve / Reject sign-off.`,
						upstreamSummary: effect.upstreamSummary,
						rollbackCandidates: effect.rollbackCandidates,
					}).catch(() => undefined);
					break;
				}
				case 'escalate_to_supervisor': {
					const latestRec = this.host.missionService?.getMission(rec.id) ?? rec;
					const failedAgentId = effect.nodeId
						? latestRec.runtime?.boundary.nodeAssignments[effect.nodeId]?.agentId
						: undefined;
					const prompt = [
						`[Engineering Escalation · ${rec.title} (${rec.id})]`,
						`- Node: ${effect.nodeId || '(unknown)'} | Token: ${effect.tokenId || '(unknown)'}${failedAgentId ? ` | Subordinate Agent: \`${failedAgentId}\`` : ''}`,
						`- Failure / Escalation Reason: ${effect.reason}`,
						`- Next Actions:`,
						`  1. Inspect subordinate context via \`aexus-ade org context ${failedAgentId || '<agentId>'} --json\`.`,
						`  2. Mint or hand off a recovery baton (\`aexus-ade token mint|handoff\`), remove/replace stalled subordinate (\`aexus-ade orchestration staff remove --mission ${rec.id} --node ${effect.nodeId || '<nodeId>'} --force\`), or pause/abort the wave (\`aexus-ade orchestration pause|abort --mission ${rec.id}\`).`,
						`  3. Escalate further upward if needed via \`aexus-ade org escalate --mission ${rec.id} --token ${effect.tokenId} --reason "..."\`.`,
					].join('\n');
					const postInboxFallback = (detail: string) => {
						const govId = rec.ownerSessionId ?? rec.id;
						void this.host.inboxService?.postGovernorMessage({
							governorSessionId: govId,
							title: `Mission Escalation (${effect.nodeId || rec.id})`,
							message: `Supervisor "${effect.supervisorId}" could not handle escalation for token \`${effect.tokenId}\` (${detail}).\n\n${effect.reason}`,
							nodeId: effect.nodeId || undefined,
							severity: 'critical',
						}).catch(() => undefined);
					};
					const delivered = await this.dispatchPromptToAgent(effect.supervisorId, prompt, {
						autonomousApproved: true,
						requireLiveDelivery: true,
						dedupeKey: `escalate:${rec.id}:${effect.tokenId || effect.nodeId}`,
						onDispatchError: errMsg => postInboxFallback(`dispatch failed: ${errMsg.slice(0, 300)}`),
					});
					if (!delivered) {
						postInboxFallback('supervisor session unavailable');
					}
					break;
				}
				case 'post_inbox': {
					const govId = rec.ownerSessionId ?? rec.id;
					await this.host.inboxService?.postGovernorMessage({
						governorSessionId: govId,
						title: effect.title,
						message: effect.message,
						nodeId: effect.nodeId,
						severity: effect.severity,
						senderAgentId: effect.senderAgentId,
					}).catch(() => undefined);
					break;
				}
				case 'mermaid_patched': {
					this.host.missionService?.updateMermaid(rec.id, effect.newMermaidText);
					break;
				}
			}
		}

		if (agentBuckets.size > 0) {
			await Promise.all(
				[...agentBuckets.values()].map(async bucket => {
					for (const effect of bucket) {
						const latestRec = this.host.missionService?.getMission(rec.id) ?? rec;
						const liveState = this.host.ensureSynchronizedState(latestRec);
						const targetAgentId = liveState.boundary.nodeAssignments[effect.nodeId]?.agentId
							?? liveState.tokens[effect.tokenId]?.holderAgentId
							?? effect.holderAgentId;
						if (effect.kind === 'dispatch_token') {
							const nodeChecks = (this.host.computeEffectiveNodeChecks(latestRec, parseMissionMermaidDag(latestRec.mermaidText), effect.nodeId)[effect.nodeId] ?? [])
								.filter(h => h.enabled !== false);
							let wakeupPrompt = effect.prompt;
							if (nodeChecks.length > 0) {
								const checkLines = nodeChecks.map(h => {
									const parts: string[] = [];
									if (h.command) { parts.push(`\`${h.command}\``); }
									if (h.expectFiles && h.expectFiles.length > 0) { parts.push(`files: ${h.expectFiles.join(', ')}`); }
									return `- ${h.name || h.id}: ${parts.join(' + ')}`;
								});
								wakeupPrompt += `\n\n### Deterministic Verification Gate (Auto-Run on \`token complete\`)\n${checkLines.join('\n')}\n- Self-verify anytime (0 review cost): \`aexus-ade mission check run --mission ${rec.id} --node ${effect.nodeId} --json\``;
							}
							const dispatched = await this.dispatchPromptToAgent(targetAgentId, wakeupPrompt, {
								autonomousApproved: true,
								missionId: rec.id,
								tokenId: effect.tokenId,
								nodeId: effect.nodeId,
							});
							if (!dispatched) {
								await this.host.failToken(rec.id, {
									tokenId: effect.tokenId,
									reason: `Unable to dispatch token ${effect.tokenId} to node ${effect.nodeId} (agent "${targetAgentId ?? 'unassigned'}" unavailable).`,
								}).catch(() => undefined);
							}
						} else {
							const dispatched = await this.dispatchPromptToAgent(targetAgentId, effect.message, {
								autonomousApproved: true,
								missionId: rec.id,
								tokenId: effect.tokenId,
								nodeId: effect.nodeId,
							});
							if (!dispatched) {
								await this.host.failToken(rec.id, {
									tokenId: effect.tokenId,
									reason: `Unable to wake agent "${targetAgentId ?? 'unassigned'}" for node ${effect.nodeId} (${effect.wakeupReason}).`,
								}).catch(() => undefined);
							}
						}
					}
				}),
			);
		}
	}

	async executeOrchestrationEffects(
		rec: IAdeMissionRecord,
		effects: readonly OrchestrationEngineEffect[],
		options?: { readonly preferReattachForRemote?: boolean },
	): Promise<void> {
		if (effects.length === 0) {
			return;
		}
		this.host.missionService?.ensureOrchestrationStaffSynced?.(rec.id);
		const latestRec = this.host.missionService?.getMission(rec.id) ?? rec;
		const orchState = this.host.ensureSynchronizedOrchestrationState(latestRec);
		const parsedDag = latestRec.mermaidText?.trim() ? parseMissionMermaidDag(latestRec.mermaidText) : undefined;

		type AgentEffectItem = Exclude<OrchestrationEngineEffect, { readonly kind: 'post_inbox' }>;
		const inboxEffects: Array<Extract<OrchestrationEngineEffect, { readonly kind: 'post_inbox' }>> = [];
		const unboundEffects: AgentEffectItem[] = [];
		const byAgent = new Map<string, Array<{ readonly eff: AgentEffectItem; readonly promptText: string }>>();

		for (const eff of effects) {
			if (eff.kind === 'post_inbox') {
				inboxEffects.push(eff);
				continue;
			}
			const targetAgentId = orchState.nodeAgentIds[eff.nodeId] ?? eff.holderAgentId;
			if (!targetAgentId) {
				unboundEffects.push(eff);
				continue;
			}
			let promptText = eff.kind === 'dispatch_token' ? eff.prompt : eff.message;
			if (eff.kind === 'dispatch_token' && (parsedDag || latestRec.orchestrationText?.trim() || latestRec.nodeChecks)) {
				const liveTok = orchState.tokens[eff.tokenId];
				const checkTargetNodes = [
					eff.nodeId,
					...(liveTok?.taskNodeId ? [liveTok.taskNodeId] : []),
					...(liveTok?.taskNodeIds ?? []),
				];
				const parsedOrchForChecks = latestRec.orchestrationText?.trim() ? parseOrchestrationGraph(latestRec.orchestrationText) : undefined;
				const combinedChecks = resolveMergedNodeCheckHooks({
					nodeIds: checkTargetNodes,
					recordNodeChecks: latestRec.nodeChecks,
					parsedOrch: parsedOrchForChecks,
					parsedDag,
					onlyEnabled: true,
				});
				if (combinedChecks.length > 0 && !promptText.includes('Deterministic Verification Gate') && !promptText.includes('mission check run')) {
					const checkLines = combinedChecks.map(h => {
						const parts: string[] = [];
						if (h.command) { parts.push(`\`${h.command}\``); }
						if (h.expectFiles && h.expectFiles.length > 0) { parts.push(`files: ${h.expectFiles.join(', ')}`); }
						return `- ${h.name || h.id}: ${parts.join(' + ')}`;
					});
					promptText += `\n\n### Deterministic Verification Gate (Auto-Run on \`token return\` / \`token complete\`)\n${checkLines.join('\n')}\n- Self-verify anytime (0 review cost): \`aexus-ade mission check run --mission ${rec.id} --node ${eff.nodeId} --json\``;
				}
			}
			const list = byAgent.get(targetAgentId) ?? [];
			list.push({ eff, promptText });
			byAgent.set(targetAgentId, list);
		}

		for (const eff of inboxEffects) {
			const govId = rec.ownerSessionId ?? rec.id;
			await this.host.inboxService?.postGovernorMessage({
				governorSessionId: govId,
				title: eff.title,
				message: eff.message,
				nodeId: eff.nodeId,
				severity: eff.severity,
				senderAgentId: eff.senderAgentId,
			}).catch(() => undefined);
			if (rec.ownerSessionId && rec.ownerSessionId !== ADE_SECRETARY_ID) {
				this.host.projectsService?.setAgentStatus(rec.ownerSessionId, 'idle', true);
			}
		}

		for (const eff of unboundEffects) {
			if (eff.kind === 'dispatch_token') {
				await this.host.failOrchestrationToken(rec.id, {
					tokenId: eff.tokenId,
					reason: `No bound agent session found for staff node "${eff.nodeId}".`,
				}).catch(() => undefined);
			}
		}

		if (byAgent.size > 0) {
			await Promise.all(
				[...byAgent.entries()].map(async ([targetAgentId, items]) => {
					const targetAgent = this.host.projectsService?.getAgent(targetAgentId);
					const preferReattach = Boolean(options?.preferReattachForRemote && targetAgent?.projectUri.scheme === AEXUS_SSH_SCHEME);
					for (const { eff, promptText } of items) {
						const dispatched = await this.dispatchPromptToAgent(targetAgentId, promptText, {
							autonomousApproved: true,
							missionId: rec.id,
							tokenId: eff.tokenId,
							nodeId: eff.nodeId,
							...(preferReattach ? { preferReattach: true } : {}),
							...(eff.kind === 'silence_reminder' ? { dedupeKey: `orch-nudge:${rec.id}:${eff.tokenId}:${eff.nudgeCount}` } : {}),
						});
						if (!dispatched && eff.kind === 'dispatch_token') {
							await this.host.failOrchestrationToken(rec.id, {
								tokenId: eff.tokenId,
								reason: `Unable to dispatch baton ${eff.tokenId} to staff "${eff.nodeId}" (agent "${targetAgentId}" session/engine unavailable).`,
							}).catch(() => undefined);
						}
					}
				}),
			);
		}
	}
}
