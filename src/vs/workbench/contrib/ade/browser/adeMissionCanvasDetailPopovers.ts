/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	AdeOsIconKind,
	resolveAdeOsIconKind,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	IAdeUiCreateAgentInput,
	IAdeUiEditAgentInput,
} from '../../../../platform/ade/common/adeControlCenterIpc.js';
import {
	ADE_REGISTERED_ENGINES,
	AdeBoardPermission,
	formatLevelLabel,
	IAdeAgentNode,
	IAdeDepartment,
	IAdeProjectSnapshot,
	IAdeWhiteboard,
	parseLevelInput,
} from '../../../../platform/ade/common/adeModels.js';
import {
	ADE_NODE_COLOR_PRESETS,
	normalizeAdeNodeColor,
} from '../../../../platform/ade/common/adeNodeColors.js';
import { isAgentEffectiveDepartmentMember } from '../../../../platform/ade/common/adeOrchestrationLayout.js';
import { adeBi } from '../common/adeLocalization.js';
import { AdeGlassSelect, buildModelGlassSelectItem, IAdeGlassSelectItem } from './adeGlassSelect.js';
import {
	AdeMissionHostCatalog,
	MISSION_ENGINE_DEFAULT_MODELS,
	MISSION_ENGINE_FALLBACK_NAMES,
	MISSION_THINKING_LEVEL_OPTIONS,
} from './adeMissionHostCatalog.js';
import { normalizeAdeShortEngineId } from '../common/ade.js';

export interface IMissionDetailPopoverHost {
	readonly popoverEl: HTMLElement;
	readonly popoverDisposables: DisposableStore;
	readonly portalContainer?: HTMLElement;
	openAtAnchor(anchorEl: HTMLElement, extraClass?: string): void;
	openAtClientPoint(clientX: number, clientY: number, extraClass?: string): void;
	close(reason?: 'dismiss' | 'escape'): void;
}

function resolvePopoverPortalContainer(host: IMissionDetailPopoverHost): HTMLElement {
	return host.portalContainer ?? host.popoverEl.parentElement ?? host.popoverEl.ownerDocument.body;
}

export interface ICreateAgentPopoverOptions {
	readonly snapshot: IAdeProjectSnapshot;
	readonly defaultParentId?: string | null;
	readonly canvasX?: number;
	readonly canvasY?: number;
	readonly onCreateAgent: (input: IAdeUiCreateAgentInput) => Promise<unknown>;
	readonly onFeedback?: (message: string, kind: 'ok' | 'error') => void;
}

export interface IEditAgentPopoverOptions {
	readonly snapshot: IAdeProjectSnapshot;
	readonly agent: IAdeAgentNode;
	readonly onEditAgent: (input: IAdeUiEditAgentInput) => Promise<unknown>;
	readonly onDeleteAgent?: (agentId: string) => Promise<void>;
	readonly onOpenSession?: (agentId: string, side: boolean) => void;
	readonly onFeedback?: (message: string, kind: 'ok' | 'error') => void;
}

export interface ICreateDepartmentPopoverOptions {
	readonly snapshot: IAdeProjectSnapshot;
	readonly defaultRootAgentId?: string;
	readonly onCreateDepartment: (rootAgentId: string, name: string, colorToken?: string) => Promise<unknown>;
	readonly onFeedback?: (message: string, kind: 'ok' | 'error') => void;
}

export interface IEditDepartmentPopoverOptions {
	readonly snapshot: IAdeProjectSnapshot;
	readonly department: IAdeDepartment;
	readonly currentColorToken?: string;
	readonly onEditDepartment: (deptId: string, patch: {
		readonly name?: string;
		readonly boardId?: string;
		readonly perm?: AdeBoardPermission;
		readonly colorToken?: string;
	}) => Promise<unknown>;
	readonly onToggleMember: (deptId: string, agentId: string, action: 'in' | 'out') => Promise<unknown>;
	readonly onDeleteDepartment: (deptId: string) => Promise<unknown>;
	readonly onFeedback?: (message: string, kind: 'ok' | 'error') => void;
}

export interface ICreateWhiteboardPopoverOptions {
	readonly snapshot: IAdeProjectSnapshot;
	readonly defaultDeptId?: string | null;
	readonly defaultOwnerId?: string | null;
	readonly canvasX?: number;
	readonly canvasY?: number;
	readonly onCreateWhiteboard: (input: {
		readonly name: string;
		readonly ownerId?: string | null;
		readonly deptId?: string | null;
		readonly storageHost?: string;
		readonly tags?: readonly string[];
		readonly canvasX?: number;
		readonly canvasY?: number;
		readonly colorToken?: string;
	}) => Promise<unknown>;
	readonly onFeedback?: (message: string, kind: 'ok' | 'error') => void;
}

interface IAvailablePopoverHostOption {
	readonly value: string;
	readonly label: string;
	readonly osIcon: AdeOsIconKind;
	readonly matchKeys: readonly string[];
}

function collectAvailableHostOptions(
	snapshot: IAdeProjectSnapshot,
	hostCatalog: AdeMissionHostCatalog,
): readonly IAvailablePopoverHostOption[] {
	const localInfo = hostCatalog.resolveNodeHostAndOs('local');
	const out: IAvailablePopoverHostOption[] = [
		{
			value: 'local',
			label: adeBi(localize('adePopoverHostLocal', "Local Machine (local)"), '本机 (local)'),
			osIcon: localInfo.osKind,
			matchKeys: ['local'],
		},
	];
	const seenLower = new Set<string>(['local']);
	for (const h of snapshot.hosts) {
		const ip = h.ip.trim();
		const alias = (h.ssh_alias ?? '').trim();
		const primary = alias || ip;
		if (primary && !seenLower.has(primary.toLowerCase()) && (!ip || !seenLower.has(ip.toLowerCase()))) {
			const catalogInfo = hostCatalog.resolveNodeHostAndOs(alias || ip);
			const effectiveAlias = alias || (catalogInfo.displayHost !== ip ? catalogInfo.displayHost : '');
			const keys = Array.from(new Set([
				primary.toLowerCase(),
				ip.toLowerCase(),
				alias.toLowerCase(),
				effectiveAlias.toLowerCase(),
			].filter(Boolean)));
			for (const k of keys) {
				seenLower.add(k);
			}
			const osIcon = catalogInfo.osKind === 'kali'
				? 'kali'
				: resolveAdeOsIconKind({
					os: h.os_kind,
					hint: `${h.name ?? ''} ${effectiveAlias} ${alias} ${ip}`,
				});
			const suffix = effectiveAlias && ip && effectiveAlias.toLowerCase() !== ip.toLowerCase()
				? `${effectiveAlias} · ${ip}`
				: primary;
			out.push({
				value: primary,
				label: `${h.name || effectiveAlias || alias || ip} (${suffix})`,
				osIcon,
				matchKeys: keys,
			});
		}
	}
	for (const ch of hostCatalog.getKnownCloudHosts()) {
		const alias = (ch.alias ?? '').trim();
		const hostName = (ch.hostName ?? '').trim();
		const primary = alias || hostName;
		if (primary && !seenLower.has(primary.toLowerCase())) {
			const portSuffix = ch.port && ch.port !== 22 ? `:${ch.port}` : '';
			const keys = Array.from(new Set([
				primary.toLowerCase(),
				alias.toLowerCase(),
				ch.id.toLowerCase(),
				hostName ? `${hostName.toLowerCase()}:${ch.port || 22}` : '',
				...(!seenLower.has(hostName.toLowerCase()) ? [hostName.toLowerCase()] : []),
			].filter(Boolean)));
			for (const k of keys) {
				seenLower.add(k);
			}
			const osIcon = resolveAdeOsIconKind({
				os: ch.os,
				distribution: ch.lastTestStatus?.remoteUname,
				hint: `${ch.name ?? ''} ${alias} ${ch.user ?? ''} ${hostName} ${ch.notes ?? ''}`,
			});
			const suffix = alias && hostName && alias.toLowerCase() !== hostName.toLowerCase()
				? `${alias} · ${hostName}${portSuffix}`
				: primary;
			out.push({
				value: primary,
				label: `${ch.name || alias || hostName} (${suffix})`,
				osIcon,
				matchKeys: keys,
			});
		}
	}
	return out;
}

function renderColorSwatchPicker(
	container: HTMLElement,
	disposables: DisposableStore,
	initialToken: string | undefined,
	onChange: (nextToken: string | undefined) => void,
): void {
	const row = append(container, $('.ade-popover-swatch-row'));
	let current = normalizeAdeNodeColor(initialToken);

	const buttons: { readonly token: string | undefined; readonly el: HTMLButtonElement }[] = [];
	const syncActive = () => {
		for (const b of buttons) {
			b.el.classList.toggle('is-active', b.token === current);
		}
	};

	const clearBtn = append(row, $('button.ade-popover-swatch-btn.is-default', {
		type: 'button',
		title: adeBi(localize('adeSwatchDefault', "Default theme color"), '恢复默认配色'),
	}, '×')) as HTMLButtonElement;
	buttons.push({ token: undefined, el: clearBtn });
	disposables.add(addDisposableListener(clearBtn, EventType.CLICK, () => {
		current = undefined;
		syncActive();
		onChange(undefined);
	}));

	for (const preset of ADE_NODE_COLOR_PRESETS) {
		const btn = append(row, $('button.ade-popover-swatch-btn', {
			type: 'button',
			title: adeBi(preset.labelEn, preset.labelZh),
			'data-swatch-id': preset.id,
		})) as HTMLButtonElement;
		btn.style.setProperty('--swatch-hex', preset.hex);
		buttons.push({ token: preset.id, el: btn });
		disposables.add(addDisposableListener(btn, EventType.CLICK, () => {
			current = preset.id;
			syncActive();
			onChange(preset.id);
		}));
	}
	syncActive();
}

/**
 * 5-Step Cascade Agent Creation Popover (`Host -> Engine -> Model -> Effort -> Name & Role Summary`).
 * - When `snapshot.agents.length === 0`: locks `is_top_role = true`, `parent_id = null`, `level = 1`
 *   to bootstrap the Project's sole top-level L1 Lead (`plan.md` §8.1.4).
 * - When `snapshot.agents.length > 0`: blocks any second root (`parent_id` must reference an existing
 *   parent node and `level > parent.level`).
 */
export function renderCreateAgentCascadePopover(
	host: IMissionDetailPopoverHost,
	hostCatalog: AdeMissionHostCatalog,
	options: ICreateAgentPopoverOptions,
	openTarget: { readonly anchorEl?: HTMLElement; readonly clientX?: number; readonly clientY?: number },
): void {
	const { popoverEl, popoverDisposables } = host;
	clearNode(popoverEl);

	const agents = options.snapshot.agents;
	const isSoleTopRoleMode = agents.length === 0;

	const header = append(popoverEl, $('.ade-mission-popover-header'));
	append(header, $('.ade-mission-popover-title', {}, isSoleTopRoleMode
		? adeBi(localize('adeCreateSoleL1Title', "Create Sole Top-Level L1 Lead"), '创建唯一顶层 L1 负责人')
		: adeBi(localize('adeCreateSubordinateTitle', "Recruit Subordinate Agent"), '招募下级员工节点')));

	const closeBtn = append(header, $('button.ade-mission-popover-close', {
		type: 'button',
		title: adeBi(localize('adeClosePopover', "Close"), '关闭'),
	}, '×')) as HTMLButtonElement;
	popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => host.close()));

	const form = append(popoverEl, $('.ade-popover-cascade-form', {
		'data-ade-agent-create-form': 'true',
		'data-sole-l1-mode': isSoleTopRoleMode ? 'true' : 'false',
	}));

	// Topology Placement Banner / Selector
	const sortedAgents = [...agents].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
	let selectedParentId: string | null = isSoleTopRoleMode
		? null
		: (options.defaultParentId && agents.some(a => a.agent_id === options.defaultParentId)
			? options.defaultParentId
			: (sortedAgents.find(a => a.is_top_role)?.agent_id ?? sortedAgents[0]?.agent_id ?? null));

	const computeDefaultLevel = (pid: string | null): number => {
		if (!pid) {
			return 1;
		}
		const p = agents.find(a => a.agent_id === pid);
		return (p?.level ?? 1) + 1;
	};
	let selectedLevel = isSoleTopRoleMode ? 1 : computeDefaultLevel(selectedParentId);
	let levelInputEl: HTMLInputElement | undefined;

	if (isSoleTopRoleMode) {
		append(form, $('.ade-popover-locked-banner', {
			'data-ade-locked-sole-l1': 'true',
		}, adeBi(
			localize('adeSoleL1BannerText', "Locked Root: L1 · is_top_role = true · parent_id = null"),
			'锁定根节点：L1 · is_top_role = true · parent_id = null（全项目唯一顶层负责人）',
		)));
	} else {
		const topoRow = append(form, $('.ade-popover-two-col'));
		const parentField = append(topoRow, $('.ade-popover-field'));
		append(parentField, $('label.ade-popover-label', {}, adeBi(
			localize('adeParentAgentLabel', "Direct Supervisor"),
			'直属上级（禁止第二根节点）',
		)));
		const parentSelect = popoverDisposables.add(new AdeGlassSelect({
			container: parentField,
			portalContainer: resolvePopoverPortalContainer(host),
			className: 'ade-popover-select',
			attributes: { 'data-ade-create-parent': 'true' },
			items: sortedAgents.map(ag => ({
				value: ag.agent_id,
				label: `${formatLevelLabel(ag.level)} · ${ag.name}`,
				icon: 'account',
			})),
			value: selectedParentId ?? sortedAgents[0]?.agent_id ?? '',
		}));

		const levelField = append(topoRow, $('.ade-popover-field'));
		append(levelField, $('label.ade-popover-label', {}, adeBi(
			localize('adeAgentLevelLabel', "Rank Level (> Supervisor)"),
			'职级 Level（严格低于上级）',
		)));
		const levelInput = append(levelField, $('input.ade-popover-input', {
			type: 'text',
			value: formatLevelLabel(selectedLevel),
			'data-ade-create-level': 'true',
		})) as HTMLInputElement;
		levelInputEl = levelInput;

		popoverDisposables.add(parentSelect.onDidChange(val => {
			selectedParentId = val;
			const minLv = computeDefaultLevel(selectedParentId);
			if (selectedLevel < minLv) {
				selectedLevel = minLv;
				levelInput.value = formatLevelLabel(selectedLevel);
			}
		}));
		popoverDisposables.add(addDisposableListener(levelInput, EventType.CHANGE, () => {
			try {
				selectedLevel = parseLevelInput(levelInput.value);
			} catch {
				// Validated on submit
			}
		}));
	}

	const portalContainer = resolvePopoverPortalContainer(host);

	// Step 1: Host
	const hostOptions = collectAvailableHostOptions(options.snapshot, hostCatalog);
	let selectedHost = hostOptions[0]?.value ?? 'local';
	const step1 = append(form, $('.ade-popover-field', { 'data-ade-create-step': 'host' }));
	append(step1, $('label.ade-popover-label', {}, adeBi(
		localize('adeCreateStep1Host', "1. Host Machine"),
		'1. 运行主机 (Host · 创建后只读)',
	)));
	const hostSelect = popoverDisposables.add(new AdeGlassSelect({
		container: step1,
		portalContainer,
		className: 'ade-popover-select',
		attributes: { 'data-ade-create-host': 'true' },
		items: hostOptions.map(h => ({
			value: h.value,
			label: h.label,
			osIcon: h.osIcon,
		})),
		value: selectedHost,
	}));

	// Step 2: Engine
	let selectedEngine = 'claude';
	const step2 = append(form, $('.ade-popover-field', { 'data-ade-create-step': 'engine' }));
	append(step2, $('label.ade-popover-label', {}, adeBi(
		localize('adeCreateStep2Engine', "2. Coding Agent Engine"),
		'2. 编码引擎 (Engine · 会话启动后锁定)',
	)));
	const engineSelect = popoverDisposables.add(new AdeGlassSelect({
		container: step2,
		portalContainer,
		className: 'ade-popover-select',
		attributes: { 'data-ade-create-engine': 'true' },
		items: ADE_REGISTERED_ENGINES.map(eng => ({
			value: eng,
			label: `${MISSION_ENGINE_FALLBACK_NAMES[eng] ?? eng} (${eng})`,
			icon: 'hubot',
		})),
		value: selectedEngine,
	}));

	// Step 3: Model
	let selectedModel = MISSION_ENGINE_DEFAULT_MODELS[selectedEngine] ?? 'claude-sonnet-4-5';
	const step3 = append(form, $('.ade-popover-field', { 'data-ade-create-step': 'model' }));
	append(step3, $('label.ade-popover-label', {}, adeBi(
		localize('adeCreateStep3Model', "3. Model"),
		'3. 模型 (Model)',
	)));
	const modelSelect = popoverDisposables.add(new AdeGlassSelect({
		container: step3,
		portalContainer,
		className: 'ade-popover-select',
		attributes: { 'data-ade-create-model': 'true' },
		items: [buildModelGlassSelectItem(selectedModel)],
		value: selectedModel,
		searchable: true,
		searchPlaceholder: adeBi(localize('adeFilterModelsPh', "Search model or vendor..."), '搜索模型或厂商…'),
	}));
	const customModelInput = append(step3, $('input.ade-popover-input.ade-popover-sub-input', {
		type: 'text',
		placeholder: adeBi(localize('adeCustomModelPh', "Or enter custom model ID..."), '或输入自定义模型 ID…'),
		'data-ade-create-model-custom': 'true',
	})) as HTMLInputElement;

	// Step 4: Effort
	let selectedEffort = 'medium';
	const step4 = append(form, $('.ade-popover-field', { 'data-ade-create-step': 'effort' }));
	append(step4, $('label.ade-popover-label', {}, adeBi(
		localize('adeCreateStep4Effort', "4. Thinking Effort"),
		'4. 思考档位 (Effort)',
	)));
	const effortRow = append(step4, $('.ade-popover-effort-pills', {
		'data-ade-create-effort-group': 'true',
	}));

	const renderEffortPills = (efforts: readonly string[]) => {
		clearNode(effortRow);
		const list = efforts.length > 0 ? efforts : MISSION_THINKING_LEVEL_OPTIONS;
		if (!list.includes(selectedEffort)) {
			selectedEffort = list.includes('medium') ? 'medium' : list[0];
		}
		for (const eff of list) {
			const pill = append(effortRow, $('button.ade-popover-effort-pill', {
				type: 'button',
				'data-ade-create-effort': eff,
			}, eff)) as HTMLButtonElement;
			pill.classList.toggle('is-active', eff === selectedEffort);
			popoverDisposables.add(addDisposableListener(pill, EventType.CLICK, () => {
				selectedEffort = eff;
				renderEffortPills(list);
			}));
		}
	};

	// Step 5: Name & Role Summary
	const step5 = append(form, $('.ade-popover-field', { 'data-ade-create-step': 'identity' }));
	append(step5, $('label.ade-popover-label', {}, adeBi(
		localize('adeCreateStep5Identity', "5. Name & Role Responsibility Summary"),
		'5. 员工姓名与职责简述',
	)));
	const nameInput = append(step5, $('input.ade-popover-input', {
		type: 'text',
		placeholder: isSoleTopRoleMode
			? adeBi(localize('adeSoleL1NamePh', "e.g. Chief Architect"), '例如：总架构师')
			: adeBi(localize('adeSubNamePh', "e.g. Backend Engineer"), '例如：后端研发工程师'),
		'data-ade-create-name': 'true',
	})) as HTMLInputElement;
	const roleInput = append(step5, $('textarea.ade-popover-textarea', {
		rows: 2,
		placeholder: adeBi(
			localize('adeRoleSummaryPh', "Concise organizational responsibility summary..."),
			'简明描述该员工负责的模块与职责边界…',
		),
		'data-ade-create-role': 'true',
	})) as HTMLTextAreaElement;

	let selectedColor: string | undefined;
	const colorField = append(form, $('.ade-popover-field'));
	append(colorField, $('label.ade-popover-label', {}, adeBi(
		localize('adeCardAccentOptional', "Card Accent Color (Optional)"),
		'卡片主题色（可选）',
	)));
	renderColorSwatchPicker(colorField, popoverDisposables, undefined, next => {
		selectedColor = next;
	});

	const errorEl = append(form, $('.ade-popover-inline-error'));
	errorEl.hidden = true;

	let probeGen = 0;
	const refreshModelsForEngine = async (targetHost: string, shortEng: string) => {
		const myGen = ++probeGen;
		const probed = await hostCatalog.probeControlCenterModels(targetHost, shortEng);
		if (myGen !== probeGen || popoverDisposables.isDisposed) {
			return;
		}
		const fallbackModel = MISSION_ENGINE_DEFAULT_MODELS[shortEng] ?? 'claude-sonnet-4-5';
		const models = probed.models.length > 0 ? probed.models : [fallbackModel];
		if (!models.includes(selectedModel)) {
			selectedModel = models[0];
		}
		modelSelect.setItems(models.map(m => buildModelGlassSelectItem(m)), selectedModel);
		renderEffortPills(probed.efforts);
	};

	const refreshEnginesForHost = async (targetHost: string) => {
		const probedList = await hostCatalog.probeControlCenterEngines(targetHost);
		if (popoverDisposables.isDisposed) {
			return;
		}
		const discoveredShorts: string[] = [];
		for (const item of probedList) {
			const s = normalizeAdeShortEngineId(item);
			if (!discoveredShorts.includes(s)) {
				discoveredShorts.push(s);
			}
		}
		const engines = discoveredShorts.length > 0 ? discoveredShorts : [...ADE_REGISTERED_ENGINES];
		if (!engines.includes(selectedEngine)) {
			selectedEngine = engines[0];
		}
		engineSelect.setItems(engines.map(eng => ({
			value: eng,
			label: `${MISSION_ENGINE_FALLBACK_NAMES[eng] ?? eng} (${eng})`,
			icon: 'hubot',
		})), selectedEngine);
		await refreshModelsForEngine(targetHost, selectedEngine);
	};

	// Seed synchronous defaults immediately so unit tests and fast interactions never wait on async IPC
	renderEffortPills(MISSION_THINKING_LEVEL_OPTIONS);
	void refreshEnginesForHost(selectedHost);

	popoverDisposables.add(hostSelect.onDidChange(val => {
		selectedHost = val;
		void refreshEnginesForHost(selectedHost);
	}));
	popoverDisposables.add(engineSelect.onDidChange(val => {
		selectedEngine = normalizeAdeShortEngineId(val);
		selectedModel = MISSION_ENGINE_DEFAULT_MODELS[selectedEngine] ?? selectedModel;
		void refreshModelsForEngine(selectedHost, selectedEngine);
	}));
	popoverDisposables.add(modelSelect.onDidChange(val => {
		selectedModel = val;
	}));

	const footer = append(form, $('.ade-popover-footer'));
	const cancelBtn = append(footer, $('button.ade-mission-token-action-btn', {
		type: 'button',
	}, adeBi(localize('adeCancelBtn', "Cancel"), '取消'))) as HTMLButtonElement;
	const submitBtn = append(footer, $('button.ade-mission-token-action-btn.primary', {
		type: 'button',
		'data-ade-create-submit': 'true',
	}, isSoleTopRoleMode
		? adeBi(localize('adeCreateSoleL1Submit', "Create L1 Lead"), '创建 L1 负责人')
		: adeBi(localize('adeCreateSubSubmit', "Create Agent"), '创建员工节点'))) as HTMLButtonElement;

	popoverDisposables.add(addDisposableListener(cancelBtn, EventType.CLICK, () => host.close()));
	popoverDisposables.add(addDisposableListener(submitBtn, EventType.CLICK, async () => {
		errorEl.hidden = true;
		const name = nameInput.value.trim();
		const roleSummary = roleInput.value.trim();
		const finalModel = customModelInput.value.trim() || modelSelect.value || selectedModel;
		if (!name) {
			errorEl.textContent = adeBi(localize('adeErrAgentNameRequired', "Employee name is required."), '请填写员工姓名。');
			errorEl.hidden = false;
			return;
		}
		if (!isSoleTopRoleMode) {
			if (!selectedParentId) {
				errorEl.textContent = adeBi(
					localize('adeErrSecondRootForbidden', "A Project can only have a single L1 root; select a supervisor."),
					'同一项目仅允许唯一顶层 L1 根节点，请选择直属上级。',
				);
				errorEl.hidden = false;
				return;
			}
			if (levelInputEl) {
				try {
					selectedLevel = parseLevelInput(levelInputEl.value);
				} catch (err) {
					errorEl.textContent = err instanceof Error ? err.message : String(err);
					errorEl.hidden = false;
					return;
				}
			}
			const parentNode = agents.find(a => a.agent_id === selectedParentId);
			if (parentNode && selectedLevel <= parentNode.level) {
				errorEl.textContent = adeBi(
					localize('adeErrSubordinateLevel', "Subordinate level must be strictly greater than supervisor level ({0}).", formatLevelLabel(parentNode.level)),
					`下属职级数字必须严格大于直属上级（>${formatLevelLabel(parentNode.level)}）。`,
				);
				errorEl.hidden = false;
				return;
			}
		}

		submitBtn.disabled = true;
		try {
			await options.onCreateAgent({
				projectId: options.snapshot.meta.project_id,
				parentId: isSoleTopRoleMode ? null : selectedParentId,
				level: isSoleTopRoleMode ? 1 : selectedLevel,
				name,
				roleSummary: roleSummary || name,
				host: selectedHost,
				engine: normalizeAdeShortEngineId(engineSelect.value || selectedEngine),
				model: finalModel,
				effort: selectedEffort || 'medium',
				canvasX: options.canvasX,
				canvasY: options.canvasY,
				colorToken: selectedColor,
			});
			host.close();
		} catch (err) {
			submitBtn.disabled = false;
			const msg = err instanceof Error ? err.message : String(err);
			errorEl.textContent = msg;
			errorEl.hidden = false;
			options.onFeedback?.(msg, 'error');
		}
	}));

	if (openTarget.anchorEl) {
		host.openAtAnchor(openTarget.anchorEl, 'is-cascade-popover');
	} else {
		host.openAtClientPoint(openTarget.clientX ?? 240, openTarget.clientY ?? 160, 'is-cascade-popover');
	}
	nameInput.focus();
}

/**
 * Staff Card Configuration Popover:
 * - Both `host` and `engine` are editable via `AdeGlassSelect`, cascading host -> engine -> model -> effort.
 * - When `agent.session_started === true` and the user modifies `host` or `engine`, displays a clear notice
 *   ("保存后将开启全新对话会话") and submits `allowSessionReset: true`.
 */
export function renderEditAgentPopover(
	host: IMissionDetailPopoverHost,
	hostCatalog: AdeMissionHostCatalog,
	options: IEditAgentPopoverOptions,
	anchorEl: HTMLElement,
): void {
	const { popoverEl, popoverDisposables } = host;
	clearNode(popoverEl);

	const { agent, snapshot } = options;
	const sessionStarted = Boolean(agent.session_started || agent.session_phase !== 'unstarted');
	const hasSubordinates = snapshot.agents.some(a => a.parent_id === agent.agent_id);
	const isDeptRoot = snapshot.departments.some(d => d.root_agent_id === agent.agent_id);

	const header = append(popoverEl, $('.ade-mission-popover-header'));
	append(header, $('.ade-mission-popover-title', {}, `${formatLevelLabel(agent.level)} · ${agent.name}`));
	const closeBtn = append(header, $('button.ade-mission-popover-close', { type: 'button' }, '×')) as HTMLButtonElement;
	popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => host.close()));

	const form = append(popoverEl, $('.ade-popover-cascade-form', {
		'data-ade-agent-edit-form': agent.agent_id,
	}));

	const portalContainer = resolvePopoverPortalContainer(host);
	const rawInitialHost = (agent.host || 'local').trim();
	const initialEngine = normalizeAdeShortEngineId(agent.engine);

	// Editable Host AdeGlassSelect (`data-ade-edit-host="true"`)
	const hostField = append(form, $('.ade-popover-field'));
	append(hostField, $('label.ade-popover-label', {}, adeBi(
		localize('adeEditHostSwitchableLabel', "Host Machine"),
		'运行主机 (Host)',
	)));
	const baseHostOptions = collectAvailableHostOptions(snapshot, hostCatalog);
	const matchedInitialOption = baseHostOptions.find(h => h.matchKeys.includes(rawInitialHost.toLowerCase()));
	const initialHost = matchedInitialOption ? matchedInitialOption.value : rawInitialHost;
	const editHostItems: IAdeGlassSelectItem[] = baseHostOptions.map(h => ({
		value: h.value,
		label: h.label,
		osIcon: h.osIcon,
	}));
	if (!matchedInitialOption) {
		const fallbackHostInfo = hostCatalog.resolveNodeHostAndOs(initialHost);
		editHostItems.push({ value: initialHost, label: initialHost, osIcon: fallbackHostInfo.osKind });
	}
	const hostSelect = popoverDisposables.add(new AdeGlassSelect({
		container: hostField,
		portalContainer,
		className: 'ade-popover-select',
		attributes: { 'data-ade-edit-host': 'true' },
		items: editHostItems,
		value: initialHost,
		disabled: false,
	}));

	// Editable Engine AdeGlassSelect (`data-ade-edit-engine="true"`, always unlocked)
	const engineField = append(form, $('.ade-popover-field'));
	append(engineField, $('label.ade-popover-label', {}, adeBi(
		localize('adeEditEngineSwitchableLabel', "Coding Agent Engine"),
		'编码引擎 (Engine)',
	)));

	const buildEngineSelectItems = (shorts: readonly string[]): IAdeGlassSelectItem[] => {
		const out: IAdeGlassSelectItem[] = shorts.map(eng => ({
			value: eng,
			label: `${MISSION_ENGINE_FALLBACK_NAMES[eng] ?? eng} (${eng})`,
			icon: 'hubot',
		}));
		return out;
	};
	const initialEngineShorts: string[] = [...ADE_REGISTERED_ENGINES];
	if (!initialEngineShorts.includes(initialEngine)) {
		initialEngineShorts.push(initialEngine);
	}
	const engineSelect = popoverDisposables.add(new AdeGlassSelect({
		container: engineField,
		portalContainer,
		className: 'ade-popover-select',
		attributes: {
			'data-ade-edit-engine': 'true',
			'data-engine-locked': 'false',
		},
		items: buildEngineSelectItems(initialEngineShorts),
		value: initialEngine,
		disabled: false,
	}));

	const resetNoticeEl = append(form, $('.ade-popover-session-reset-notice', {
		'data-ade-edit-reset-notice': 'true',
	}, adeBi(
		localize('adeEditSessionResetNotice', "Saving host or engine changes will start a fresh chat session."),
		'保存后将开启全新对话会话',
	)));
	resetNoticeEl.hidden = true;

	const syncSessionResetNotice = () => {
		const curHost = (hostSelect.value || initialHost).trim();
		const curEng = normalizeAdeShortEngineId(engineSelect.value || initialEngine);
		const changed = curHost.toLowerCase() !== initialHost.toLowerCase() || curEng !== initialEngine;
		resetNoticeEl.hidden = !(sessionStarted && changed);
	};

	// Model & Effort
	const modelField = append(form, $('.ade-popover-field'));
	append(modelField, $('label.ade-popover-label', {}, adeBi(localize('adeEditModelLabel', "Model"), '模型 (Model)')));
	const modelSelect = popoverDisposables.add(new AdeGlassSelect({
		container: modelField,
		portalContainer,
		className: 'ade-popover-select',
		attributes: { 'data-ade-edit-model': 'true' },
		items: [buildModelGlassSelectItem(agent.model)],
		value: agent.model,
		searchable: true,
		searchPlaceholder: adeBi(localize('adeEditFilterModelsPh', "Search model or vendor..."), '搜索模型或厂商…'),
	}));

	const customModelInput = append(modelField, $('input.ade-popover-input.ade-popover-sub-input', {
		type: 'text',
		placeholder: adeBi(localize('adeEditCustomModelPh', "Override custom model ID..."), '或输入自定义模型 ID…'),
		'data-ade-edit-model-custom': 'true',
	})) as HTMLInputElement;

	let selectedEffort = agent.effort || 'medium';
	const effortField = append(form, $('.ade-popover-field'));
	append(effortField, $('label.ade-popover-label', {}, adeBi(localize('adeEditEffortLabel', "Thinking Effort"), '思考档位 (Effort)')));
	const effortRow = append(effortField, $('.ade-popover-effort-pills'));

	const renderEfforts = (efforts: readonly string[]) => {
		clearNode(effortRow);
		const list = efforts.length > 0 ? efforts : MISSION_THINKING_LEVEL_OPTIONS;
		if (!list.includes(selectedEffort)) {
			selectedEffort = list.includes('medium') ? 'medium' : list[0];
		}
		for (const eff of list) {
			const pill = append(effortRow, $('button.ade-popover-effort-pill', {
				type: 'button',
				'data-ade-edit-effort': eff,
			}, eff)) as HTMLButtonElement;
			pill.classList.toggle('is-active', eff === selectedEffort);
			popoverDisposables.add(addDisposableListener(pill, EventType.CLICK, () => {
				selectedEffort = eff;
				renderEfforts(list);
			}));
		}
	};
	renderEfforts(MISSION_THINKING_LEVEL_OPTIONS);

	let probeSeq = 0;
	const loadModels = async (targetHost: string, shortEng: string, preserveCurrentModel: boolean) => {
		const seq = ++probeSeq;
		const probed = await hostCatalog.probeControlCenterModels(targetHost || 'local', shortEng);
		if (seq !== probeSeq || popoverDisposables.isDisposed) {
			return;
		}
		const list = [...probed.models];
		if (preserveCurrentModel && agent.model && !list.includes(agent.model)) {
			list.unshift(agent.model);
		}
		if (list.length === 0) {
			list.push(MISSION_ENGINE_DEFAULT_MODELS[shortEng] ?? agent.model);
		}
		const nextVal = preserveCurrentModel && list.includes(agent.model) ? agent.model : list[0];
		modelSelect.setItems(list.map(m => buildModelGlassSelectItem(m)), nextVal);
		renderEfforts(probed.efforts);
	};

	const loadEnginesForHost = async (targetHost: string, preserveCurrentModel: boolean) => {
		const probedList = await hostCatalog.probeControlCenterEngines(targetHost || 'local');
		if (popoverDisposables.isDisposed) {
			return;
		}
		const discoveredShorts: string[] = [];
		for (const item of probedList) {
			const s = normalizeAdeShortEngineId(item);
			if (!discoveredShorts.includes(s)) {
				discoveredShorts.push(s);
			}
		}
		const engines = discoveredShorts.length > 0 ? discoveredShorts : [...ADE_REGISTERED_ENGINES];
		const curEng = normalizeAdeShortEngineId(engineSelect.value || initialEngine);
		if (preserveCurrentModel && !engines.includes(curEng)) {
			engines.unshift(curEng);
		}
		const nextEng = engines.includes(curEng) ? curEng : engines[0];
		engineSelect.setItems(buildEngineSelectItems(engines), nextEng);
		syncSessionResetNotice();
		await loadModels(targetHost, nextEng, preserveCurrentModel && nextEng === initialEngine);
	};

	void loadEnginesForHost(initialHost, true);

	popoverDisposables.add(hostSelect.onDidChange(nextHost => {
		syncSessionResetNotice();
		void loadEnginesForHost(nextHost, false);
	}));
	popoverDisposables.add(engineSelect.onDidChange(val => {
		syncSessionResetNotice();
		void loadModels(hostSelect.value || initialHost, normalizeAdeShortEngineId(val), false);
	}));

	// Name & Role Summary
	const nameField = append(form, $('.ade-popover-field'));
	append(nameField, $('label.ade-popover-label', {}, adeBi(localize('adeEditNameLabel', "Employee Name"), '员工姓名')));
	const nameInput = append(nameField, $('input.ade-popover-input', {
		type: 'text',
		value: agent.name,
		'data-ade-edit-name': 'true',
	})) as HTMLInputElement;

	const roleField = append(form, $('.ade-popover-field'));
	append(roleField, $('label.ade-popover-label', {}, adeBi(localize('adeEditRoleLabel', "Role Summary"), '职责简述')));
	const roleInput = append(roleField, $('textarea.ade-popover-textarea', {
		rows: 2,
		'data-ade-edit-role': 'true',
	})) as HTMLTextAreaElement;
	roleInput.value = agent.role_summary;

	let selectedColor = normalizeAdeNodeColor(agent.color_token);
	const colorField = append(form, $('.ade-popover-field'));
	append(colorField, $('label.ade-popover-label', {}, adeBi(localize('adeEditColorLabel', "Card Accent Color"), '卡片主题色')));
	renderColorSwatchPicker(colorField, popoverDisposables, selectedColor, next => {
		selectedColor = next;
	});

	const errorEl = append(form, $('.ade-popover-inline-error'));
	errorEl.hidden = true;

	const footer = append(form, $('.ade-popover-footer'));
	if (options.onDeleteAgent) {
		const deleteBlocked = hasSubordinates || isDeptRoot;
		const delBtn = append(footer, $('button.ade-mission-token-action-btn.danger', {
			type: 'button',
			'data-ade-edit-delete': 'true',
			title: hasSubordinates
				? adeBi(localize('adeDelBlockedSubs', "Remove direct subordinates first"), '存在直属下属，请先移除下属节点')
				: isDeptRoot
					? adeBi(localize('adeDelBlockedDeptRoot', "Dissolve the department rooted at this employee first"), '该员工为活跃部门根节点，请先解散部门')
					: adeBi(localize('adeDelAgentTip', "Delete employee node"), '删除该员工节点'),
		}, adeBi(localize('adeDeleteBtn', "Delete"), '删除'))) as HTMLButtonElement;
		delBtn.disabled = deleteBlocked;
		popoverDisposables.add(addDisposableListener(delBtn, EventType.CLICK, async () => {
			delBtn.disabled = true;
			try {
				await options.onDeleteAgent?.(agent.agent_id);
				host.close();
			} catch (err) {
				delBtn.disabled = false;
				errorEl.textContent = err instanceof Error ? err.message : String(err);
				errorEl.hidden = false;
			}
		}));
	}

	if (options.onOpenSession) {
		const chatBtn = append(footer, $('button.ade-mission-token-action-btn', {
			type: 'button',
		}, adeBi(localize('adeOpenChatBtn', "Open Chat"), '打开对话'))) as HTMLButtonElement;
		popoverDisposables.add(addDisposableListener(chatBtn, EventType.CLICK, () => {
			host.close();
			options.onOpenSession?.(agent.agent_id, false);
		}));
	}

	const saveBtn = append(footer, $('button.ade-mission-token-action-btn.primary', {
		type: 'button',
		'data-ade-edit-save': 'true',
	}, adeBi(localize('adeSaveChangesBtn', "Save"), '保存'))) as HTMLButtonElement;

	popoverDisposables.add(addDisposableListener(saveBtn, EventType.CLICK, async () => {
		errorEl.hidden = true;
		const nextName = nameInput.value.trim();
		if (!nextName) {
			errorEl.textContent = adeBi(localize('adeErrAgentNameEmpty', "Name cannot be empty."), '姓名不能为空。');
			errorEl.hidden = false;
			return;
		}
		const nextHost = (hostSelect.value || initialHost).trim();
		const nextEngine = normalizeAdeShortEngineId(engineSelect.value || initialEngine);
		const nextModel = customModelInput.value.trim() || modelSelect.value || agent.model;
		const hostChanged = nextHost.toLowerCase() !== initialHost.toLowerCase();
		const engineChanged = nextEngine !== initialEngine;
		const needsSessionReset = sessionStarted && (hostChanged || engineChanged);
		const patch: IAdeUiEditAgentInput = {
			projectId: snapshot.meta.project_id,
			agentId: agent.agent_id,
			name: nextName,
			roleSummary: roleInput.value.trim(),
			...(hostChanged ? { host: nextHost } : {}),
			...(engineChanged ? { engine: nextEngine } : {}),
			...(needsSessionReset ? { allowSessionReset: true } : {}),
			model: nextModel,
			effort: selectedEffort,
			colorToken: selectedColor ?? '',
		};
		saveBtn.disabled = true;
		try {
			await options.onEditAgent(patch);
			host.close();
		} catch (err) {
			saveBtn.disabled = false;
			const msg = err instanceof Error ? err.message : String(err);
			errorEl.textContent = msg;
			errorEl.hidden = false;
			options.onFeedback?.(msg, 'error');
		}
	}));

	host.openAtAnchor(anchorEl, 'is-cascade-popover');
}

export function renderCreateDepartmentPopover(
	host: IMissionDetailPopoverHost,
	options: ICreateDepartmentPopoverOptions,
	openTarget: { readonly anchorEl?: HTMLElement; readonly clientX?: number; readonly clientY?: number },
): void {
	const { popoverEl, popoverDisposables } = host;
	clearNode(popoverEl);

	const header = append(popoverEl, $('.ade-mission-popover-header'));
	append(header, $('.ade-mission-popover-title', {}, adeBi(
		localize('adeCreateDeptTitle', "Create Department"),
		'创建部门边界',
	)));
	const closeBtn = append(header, $('button.ade-mission-popover-close', { type: 'button' }, '×')) as HTMLButtonElement;
	popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => host.close()));

	const form = append(popoverEl, $('.ade-popover-cascade-form'));
	const usedRoots = new Set(options.snapshot.departments.map(d => d.root_agent_id));
	const candidates = [...options.snapshot.agents]
		.filter(a => !usedRoots.has(a.agent_id))
		.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

	const rootField = append(form, $('.ade-popover-field'));
	append(rootField, $('label.ade-popover-label', {}, adeBi(
		localize('adeDeptRootLabel', "Department Head (Root Agent)"),
		'部门负责人（根节点）',
	)));
	const initialDeptRoot = (options.defaultRootAgentId && candidates.some(c => c.agent_id === options.defaultRootAgentId))
		? options.defaultRootAgentId
		: (candidates[0]?.agent_id ?? '');
	const rootSelect = popoverDisposables.add(new AdeGlassSelect({
		container: rootField,
		portalContainer: resolvePopoverPortalContainer(host),
		className: 'ade-popover-select',
		attributes: { 'data-ade-dept-root': 'true' },
		items: candidates.map(c => ({
			value: c.agent_id,
			label: `${formatLevelLabel(c.level)} · ${c.name}`,
			icon: 'organization',
		})),
		value: initialDeptRoot,
		disabled: candidates.length === 0,
	}));

	const nameField = append(form, $('.ade-popover-field'));
	append(nameField, $('label.ade-popover-label', {}, adeBi(localize('adeDeptNameLabel', "Department Name"), '部门名称')));
	const nameInput = append(nameField, $('input.ade-popover-input', {
		type: 'text',
		placeholder: adeBi(localize('adeDeptNamePh', "e.g. Backend Engineering"), '例如：后端研发部'),
		'data-ade-dept-name': 'true',
	})) as HTMLInputElement;

	let selectedColor: string | undefined;
	const colorField = append(form, $('.ade-popover-field'));
	append(colorField, $('label.ade-popover-label', {}, adeBi(localize('adeDeptColorLabel', "Frame Accent"), '边框主题色')));
	renderColorSwatchPicker(colorField, popoverDisposables, undefined, c => { selectedColor = c; });

	const errorEl = append(form, $('.ade-popover-inline-error'));
	errorEl.hidden = true;
	if (candidates.length === 0) {
		errorEl.textContent = adeBi(
			localize('adeNoEligibleDeptRoot', "All current employees are already department roots."),
			'当前全部员工均已是活跃部门根节点。',
		);
		errorEl.hidden = false;
	}

	const footer = append(form, $('.ade-popover-footer'));
	const createBtn = append(footer, $('button.ade-mission-token-action-btn.primary', {
		type: 'button',
		'data-ade-dept-submit': 'true',
	}, adeBi(localize('adeCreateDeptBtn', "Create Department"), '创建部门'))) as HTMLButtonElement;
	createBtn.disabled = candidates.length === 0;

	popoverDisposables.add(addDisposableListener(createBtn, EventType.CLICK, async () => {
		const deptName = nameInput.value.trim();
		if (!deptName || !rootSelect.value) {
			errorEl.textContent = adeBi(localize('adeDeptNameReq', "Enter a department name."), '请填写部门名称。');
			errorEl.hidden = false;
			return;
		}
		createBtn.disabled = true;
		try {
			await options.onCreateDepartment(rootSelect.value, deptName, selectedColor);
			host.close();
		} catch (err) {
			createBtn.disabled = false;
			errorEl.textContent = err instanceof Error ? err.message : String(err);
			errorEl.hidden = false;
		}
	}));

	if (openTarget.anchorEl) {
		host.openAtAnchor(openTarget.anchorEl, 'is-cascade-popover');
	} else {
		host.openAtClientPoint(openTarget.clientX ?? 260, openTarget.clientY ?? 180, 'is-cascade-popover');
	}
	nameInput.focus();
}

export function renderEditDepartmentPopover(
	host: IMissionDetailPopoverHost,
	options: IEditDepartmentPopoverOptions,
	openTarget: { readonly anchorEl?: HTMLElement; readonly clientX?: number; readonly clientY?: number },
): void {
	const { popoverEl, popoverDisposables } = host;
	clearNode(popoverEl);

	const { department, snapshot } = options;
	const header = append(popoverEl, $('.ade-mission-popover-header'));
	append(header, $('.ade-mission-popover-title', {}, `${department.name}`));
	const closeBtn = append(header, $('button.ade-mission-popover-close', { type: 'button' }, '×')) as HTMLButtonElement;
	popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => host.close()));

	const form = append(popoverEl, $('.ade-popover-cascade-form'));
	const nameField = append(form, $('.ade-popover-field'));
	append(nameField, $('label.ade-popover-label', {}, adeBi(localize('adeDeptEditName', "Department Name"), '部门名称')));
	const nameInput = append(nameField, $('input.ade-popover-input', {
		type: 'text',
		value: department.name,
	})) as HTMLInputElement;

	const deptBoard = snapshot.whiteboards.find(w => w.dept_id === department.dept_id);
	let selectedPerm: AdeBoardPermission | undefined = deptBoard
		? (department.board_permissions[deptBoard.board_id] ?? 'read_write')
		: undefined;
	if (deptBoard) {
		const permField = append(form, $('.ade-popover-field'));
		append(permField, $('label.ade-popover-label', {}, adeBi(
			localize('adeDeptBoardPermLabel', "Department Whiteboard Default Permission ({0})", deptBoard.name),
			`部门白板默认权限（${deptBoard.name}）`,
		)));
		const permSelect = popoverDisposables.add(new AdeGlassSelect({
			container: permField,
			portalContainer: resolvePopoverPortalContainer(host),
			className: 'ade-popover-select',
			attributes: { 'data-ade-dept-board-perm': 'true' },
			items: (['read_write', 'write', 'read'] as const).map(p => ({ value: p, label: p, icon: 'shield' })),
			value: selectedPerm ?? 'read_write',
			searchable: false,
		}));
		popoverDisposables.add(permSelect.onDidChange(val => {
			selectedPerm = val as AdeBoardPermission;
		}));
	}

	let selectedColor = normalizeAdeNodeColor(options.currentColorToken);
	const colorField = append(form, $('.ade-popover-field'));
	append(colorField, $('label.ade-popover-label', {}, adeBi(localize('adeDeptColorEdit', "Frame Accent"), '边框主题色')));
	renderColorSwatchPicker(colorField, popoverDisposables, selectedColor, c => { selectedColor = c; });

	// Subtree member toggles (`in` / `out`)
	const agentsById = new Map(snapshot.agents.map(a => [a.agent_id, a]));
	const isInRootSubtree = (aid: string): boolean => {
		let cur: string | null = aid;
		const seen = new Set<string>();
		while (cur && !seen.has(cur)) {
			seen.add(cur);
			if (cur === department.root_agent_id) {
				return true;
			}
			cur = agentsById.get(cur)?.parent_id ?? null;
		}
		return false;
	};
	const subtreeAgents = snapshot.agents
		.filter(a => a.agent_id !== department.root_agent_id && isInRootSubtree(a.agent_id))
		.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

	if (subtreeAgents.length > 0) {
		const membersField = append(form, $('.ade-popover-field'));
		append(membersField, $('label.ade-popover-label', {}, adeBi(
			localize('adeDeptSubtreeMembers', "Subtree Members (Branch-Cut Inclusion)"),
			'子树成员边界（移出分支 / 纳回部门）',
		)));
		const memberList = append(membersField, $('.ade-popover-member-list'));
		for (const sub of subtreeAgents) {
			const row = append(memberList, $('.ade-popover-member-row'));
			const isMember = isAgentEffectiveDepartmentMember(agentsById, department, sub.agent_id);
			append(row, $('span.ade-popover-member-name', {}, `${formatLevelLabel(sub.level)} · ${sub.name}`));
			const toggleBtn = append(row, $('button.ade-mission-token-action-btn', {
				type: 'button',
			}, isMember
				? adeBi(localize('adeDeptMemberOut', "Exclude (--action out)"), '移出部门')
				: adeBi(localize('adeDeptMemberIn', "Include (--action in)"), '纳回部门'))) as HTMLButtonElement;
			popoverDisposables.add(addDisposableListener(toggleBtn, EventType.CLICK, async () => {
				toggleBtn.disabled = true;
				try {
					await options.onToggleMember(department.dept_id, sub.agent_id, isMember ? 'out' : 'in');
					host.close();
				} catch (err) {
					toggleBtn.disabled = false;
					errorEl.textContent = err instanceof Error ? err.message : String(err);
					errorEl.hidden = false;
				}
			}));
		}
	}

	const errorEl = append(form, $('.ade-popover-inline-error'));
	errorEl.hidden = true;

	const footer = append(form, $('.ade-popover-footer'));
	const dissolveBtn = append(footer, $('button.ade-mission-token-action-btn.danger', {
		type: 'button',
	}, adeBi(localize('adeDissolveDeptBtn', "Dissolve Department"), '解散部门'))) as HTMLButtonElement;
	popoverDisposables.add(addDisposableListener(dissolveBtn, EventType.CLICK, async () => {
		dissolveBtn.disabled = true;
		try {
			await options.onDeleteDepartment(department.dept_id);
			host.close();
		} catch (err) {
			dissolveBtn.disabled = false;
			errorEl.textContent = err instanceof Error ? err.message : String(err);
			errorEl.hidden = false;
		}
	}));

	const saveBtn = append(footer, $('button.ade-mission-token-action-btn.primary', {
		type: 'button',
	}, adeBi(localize('adeSaveDeptBtn', "Save"), '保存'))) as HTMLButtonElement;
	popoverDisposables.add(addDisposableListener(saveBtn, EventType.CLICK, async () => {
		const nextName = nameInput.value.trim();
		if (!nextName) {
			errorEl.textContent = adeBi(localize('adeDeptNameEmpty', "Department name cannot be empty."), '部门名称不能为空。');
			errorEl.hidden = false;
			return;
		}
		saveBtn.disabled = true;
		try {
			await options.onEditDepartment(department.dept_id, {
				name: nextName,
				...(deptBoard && selectedPerm ? { boardId: deptBoard.board_id, perm: selectedPerm } : {}),
				colorToken: selectedColor,
			});
			host.close();
		} catch (err) {
			saveBtn.disabled = false;
			errorEl.textContent = err instanceof Error ? err.message : String(err);
			errorEl.hidden = false;
		}
	}));

	if (openTarget.anchorEl) {
		host.openAtAnchor(openTarget.anchorEl, 'is-cascade-popover');
	} else {
		host.openAtClientPoint(openTarget.clientX ?? 260, openTarget.clientY ?? 180, 'is-cascade-popover');
	}
}

export function renderCreateWhiteboardPopover(
	host: IMissionDetailPopoverHost,
	hostCatalog: AdeMissionHostCatalog,
	options: ICreateWhiteboardPopoverOptions,
	openTarget: { readonly anchorEl?: HTMLElement; readonly clientX?: number; readonly clientY?: number },
): void {
	const { popoverEl, popoverDisposables } = host;
	clearNode(popoverEl);

	const header = append(popoverEl, $('.ade-mission-popover-header'));
	append(header, $('.ade-mission-popover-title', {}, adeBi(
		localize('adeCreateWbTitle', "Create Shared Whiteboard"),
		'新建共享白板',
	)));
	const closeBtn = append(header, $('button.ade-mission-popover-close', { type: 'button' }, '×')) as HTMLButtonElement;
	popoverDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => host.close()));

	const form = append(popoverEl, $('.ade-popover-cascade-form'));
	const { snapshot } = options;

	const nameField = append(form, $('.ade-popover-field'));
	append(nameField, $('label.ade-popover-label', {}, adeBi(localize('adeWbNameLabel', "Whiteboard Name"), '白板名称')));
	const nameInput = append(nameField, $('input.ade-popover-input', {
		type: 'text',
		placeholder: adeBi(localize('adeWbNamePh', "e.g. Architecture & Contracts"), '例如：接口契约与实验共享板'),
		'data-ade-wb-name': 'true',
	})) as HTMLInputElement;

	const portalContainer = resolvePopoverPortalContainer(host);

	const sortedAgents = [...snapshot.agents].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
	const ownerField = append(form, $('.ade-popover-field'));
	append(ownerField, $('label.ade-popover-label', {}, adeBi(localize('adeWbOwnerLabel', "Owner"), '持有者 (Owner)')));
	const initialOwnerId = (options.defaultOwnerId && sortedAgents.some(a => a.agent_id === options.defaultOwnerId))
		? options.defaultOwnerId
		: (sortedAgents[0]?.agent_id ?? '');
	const ownerSelect = popoverDisposables.add(new AdeGlassSelect({
		container: ownerField,
		portalContainer,
		className: 'ade-popover-select',
		attributes: { 'data-ade-wb-owner': 'true' },
		items: sortedAgents.map(a => ({
			value: a.agent_id,
			label: `${formatLevelLabel(a.level)} · ${a.name}`,
			icon: 'account',
		})),
		value: initialOwnerId,
	}));

	const boundDeptIds = new Set(snapshot.whiteboards.map(w => w.dept_id).filter((id): id is string => Boolean(id)));
	const freeDepts = snapshot.departments.filter(d => !boundDeptIds.has(d.dept_id));
	const deptField = append(form, $('.ade-popover-field'));
	append(deptField, $('label.ade-popover-label', {}, adeBi(
		localize('adeWbDeptBindLabel', "Bind Department (Optional · Max 1 Board / Dept)"),
		'绑定部门（可选 · 一部门一板制）',
	)));
	const initialDeptId = (options.defaultDeptId && freeDepts.some(d => d.dept_id === options.defaultDeptId))
		? options.defaultDeptId
		: '';
	const deptSelect = popoverDisposables.add(new AdeGlassSelect({
		container: deptField,
		portalContainer,
		className: 'ade-popover-select',
		attributes: { 'data-ade-wb-dept': 'true' },
		items: [
			{ value: '', label: adeBi(localize('adeWbPrivateUnbound', "Unbound (Owner + Explicit Grants)"), '不绑定部门（仅持有者与显式授权）') },
			...freeDepts.map(d => ({ value: d.dept_id, label: d.name, icon: 'organization' })),
		],
		value: initialDeptId,
	}));

	const hostOptions = collectAvailableHostOptions(snapshot, hostCatalog);
	const storageField = append(form, $('.ade-popover-field'));
	append(storageField, $('label.ade-popover-label', {}, adeBi(
		localize('adeWbStorageHostLabel', "Default Backup Storage Host"),
		'默认物理存储主机 (storage_host)',
	)));
	const storageSelect = popoverDisposables.add(new AdeGlassSelect({
		container: storageField,
		portalContainer,
		className: 'ade-popover-select',
		attributes: { 'data-ade-wb-storage-host': 'true' },
		items: hostOptions.map(h => ({
			value: h.value,
			label: h.label,
			osIcon: h.osIcon,
		})),
		value: hostOptions[0]?.value ?? 'local',
	}));

	const tagsField = append(form, $('.ade-popover-field'));
	append(tagsField, $('label.ade-popover-label', {}, adeBi(
		localize('adeWbInitialTagsLabel', "Controlled Tag Categories (Comma-separated)"),
		'受控标签类别池（逗号分隔，可选）',
	)));
	const tagsInput = append(tagsField, $('input.ade-popover-input', {
		type: 'text',
		placeholder: adeBi(localize('adeWbTagsPh', "e.g. API, Benchmark, Release"), '例如：API契约, 实验结论, 发布清单'),
	})) as HTMLInputElement;

	let selectedColor: string | undefined;
	const colorField = append(form, $('.ade-popover-field'));
	append(colorField, $('label.ade-popover-label', {}, adeBi(localize('adeWbColorLabel', "Card Accent"), '卡片主题色')));
	renderColorSwatchPicker(colorField, popoverDisposables, undefined, c => { selectedColor = c; });

	const errorEl = append(form, $('.ade-popover-inline-error'));
	errorEl.hidden = true;

	const footer = append(form, $('.ade-popover-footer'));
	const createBtn = append(footer, $('button.ade-mission-token-action-btn.primary', {
		type: 'button',
		'data-ade-wb-submit': 'true',
	}, adeBi(localize('adeCreateWbBtn', "Create Whiteboard"), '创建白板'))) as HTMLButtonElement;

	popoverDisposables.add(addDisposableListener(createBtn, EventType.CLICK, async () => {
		const wbName = nameInput.value.trim();
		if (!wbName) {
			errorEl.textContent = adeBi(localize('adeWbNameReq', "Enter a whiteboard name."), '请填写白板名称。');
			errorEl.hidden = false;
			return;
		}
		const tags = tagsInput.value
			.split(/[,，]/)
			.map(s => s.trim())
			.filter(Boolean);
		createBtn.disabled = true;
		try {
			await options.onCreateWhiteboard({
				name: wbName,
				ownerId: ownerSelect.value || null,
				deptId: deptSelect.value || null,
				storageHost: storageSelect.value || 'local',
				tags: tags.length > 0 ? tags : undefined,
				canvasX: options.canvasX,
				canvasY: options.canvasY,
				colorToken: selectedColor,
			});
			host.close();
		} catch (err) {
			createBtn.disabled = false;
			errorEl.textContent = err instanceof Error ? err.message : String(err);
			errorEl.hidden = false;
		}
	}));

	if (openTarget.anchorEl) {
		host.openAtAnchor(openTarget.anchorEl, 'is-cascade-popover');
	} else {
		host.openAtClientPoint(openTarget.clientX ?? 260, openTarget.clientY ?? 180, 'is-cascade-popover');
	}
	nameInput.focus();
}

export type { IAdeWhiteboard };
