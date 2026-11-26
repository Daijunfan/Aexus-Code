/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { Sequencer } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import * as path from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { IAdeCloudHostBackendService } from '../common/adeCloudHosts.js';
import { ADE_CONTROL_DIR_NAME, ADE_REMOTE_STORE_DIR_NAME, stripAdeControlEnv } from '../common/adeControl.js';
import {
	ADE_ANTIGRAVITY_ROUTING_RULE_MD,
	ADE_ROUTING_MANAGED_BEGIN_MARKER,
	ADE_ROUTING_MANAGED_END_MARKER,
	ADE_STATIC_AGENTS_ROUTER_MD,
	ADE_SYSPROMPT_DOC_REV,
	ADE_SYSPROMPT_MODULE_DOCS,
	ADE_SYSPROMPT_MODULE_KEYS,
	AdeSyspromptModuleKey,
} from '../common/adeSyspromptCatalog.js';

function sha256Hex(text: string): string {
	return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function posixQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

const EXPECTED_DOC_HASHES: Readonly<Record<AdeSyspromptModuleKey, string>> = {
	ticket: sha256Hex(ADE_SYSPROMPT_MODULE_DOCS.ticket),
	orchestration: sha256Hex(ADE_SYSPROMPT_MODULE_DOCS.orchestration),
	whiteboard: sha256Hex(ADE_SYSPROMPT_MODULE_DOCS.whiteboard),
};

interface IManagedFilesLedger {
	readonly version: 1;
	readonly entries: Record<string, { readonly pureManaged: boolean; readonly sha256: string; readonly updatedAt: number }>;
}

/**
 * Merges or updates the controlled `AGENTS.md` / `CLAUDE.md` routing block idempotently without losing user rules.
 */
export function buildIdempotentRoutingFileContent(
	existingContent: string | undefined,
	pureManagedPreviously: boolean,
): { readonly content: string; readonly pureManaged: boolean } {
	if (existingContent === undefined || existingContent.trim().length === 0 || pureManagedPreviously || existingContent === ADE_STATIC_AGENTS_ROUTER_MD) {
		return { content: ADE_STATIC_AGENTS_ROUTER_MD, pureManaged: true };
	}
	const managedBlock = `${ADE_ROUTING_MANAGED_BEGIN_MARKER}\n${ADE_STATIC_AGENTS_ROUTER_MD.trimEnd()}\n${ADE_ROUTING_MANAGED_END_MARKER}`;
	const beginIdx = existingContent.indexOf(ADE_ROUTING_MANAGED_BEGIN_MARKER);
	const endIdx = existingContent.indexOf(ADE_ROUTING_MANAGED_END_MARKER);
	if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
		const before = existingContent.slice(0, beginIdx);
		const after = existingContent.slice(endIdx + ADE_ROUTING_MANAGED_END_MARKER.length);
		return { content: `${before}${managedBlock}${after}`, pureManaged: false };
	}
	return {
		content: `${managedBlock}\n\n${existingContent}`,
		pureManaged: false,
	};
}

const DEFAULT_REMOTE_SYSPROMPT_CACHE_TTL_MS = 60_000;

function computeSyspromptDocsContentDigest(): string {
	const hash = crypto.createHash('sha256');
	hash.update(`rev:${ADE_SYSPROMPT_DOC_REV}\n`, 'utf8');
	for (const key of ADE_SYSPROMPT_MODULE_KEYS) {
		hash.update(`${key}:${ADE_SYSPROMPT_MODULE_DOCS[key].length}:`, 'utf8');
		hash.update(ADE_SYSPROMPT_MODULE_DOCS[key], 'utf8');
		hash.update('\n', 'utf8');
	}
	return hash.digest('hex');
}

export interface IAdeEnsureSyspromptDocsResult {
	readonly doc_rev: number;
	readonly base_dir: string;
	readonly files: Readonly<Record<AdeSyspromptModuleKey, string>>;
}

export interface IAdeWorkspaceRoutingSpec {
	readonly hasClaudeAgent?: boolean;
	readonly hasLegacyClaudeOrBedrock: boolean;
	readonly hasAntigravityAgent: boolean;
}

export interface IAdeSyspromptSyncServiceOptions {
	readonly adeHomeDir?: string;
	readonly cloudHostService?: IAdeCloudHostBackendService;
	readonly remoteDocsCacheTtlMs?: number;
}

/**
 * Synchronizes:
 * 1. Read-only (`0444`) lowercase `{ticket.md, orchestration.md, whiteboard.md}` outside the workspace
 *    (local `~/.aexus-code/sysprompts/v1/` and remote `$HOME/.ade_store/sysprompts/v1/`) with SHA-256 self-healing,
 *    single-round-trip POSIX batch verification, inflight coalescing, and TTL caching.
 * 2. Zero-double-load 8-engine workspace routing rules (`<cwd>/AGENTS.md` by default; `<cwd>/.claude/CLAUDE.md` full
 *    copy ONLY for legacy Claude/Bedrock — NEVER `@AGENTS.md`; `<cwd>/.agents/rules/ade-routing.md` ONLY when
 *    `antigravity` agents exist), silently added to Git `info/exclude` (Git Worktree safe) and serialized by `Sequencer`.
 */
export class AdeSyspromptSyncService {
	private readonly adeHomeDir: string;
	private readonly managedLedgerPath: string;
	private readonly cloudHosts?: IAdeCloudHostBackendService;
	private readonly remoteDocsCacheTtlMs: number;
	private readonly localDocsSequencer = new Sequencer();
	private readonly localRoutingLedgerSequencer = new Sequencer();
	private readonly remoteDocsInflight = new Map<string, Promise<IAdeEnsureSyspromptDocsResult>>();
	private readonly remoteDocsCache = new Map<string, { readonly expiresAt: number; readonly value: IAdeEnsureSyspromptDocsResult }>();
	private remoteCacheGeneration = 0;

	constructor(options?: IAdeSyspromptSyncServiceOptions) {
		this.adeHomeDir = options?.adeHomeDir ?? path.join(os.homedir(), ADE_CONTROL_DIR_NAME);
		this.managedLedgerPath = path.join(this.adeHomeDir, 'managed-files.json');
		this.cloudHosts = options?.cloudHostService;
		this.remoteDocsCacheTtlMs = Math.max(0, options?.remoteDocsCacheTtlMs ?? DEFAULT_REMOTE_SYSPROMPT_CACHE_TTL_MS);
	}

	invalidateRemoteSyspromptCache(): void {
		this.remoteCacheGeneration += 1;
		this.remoteDocsCache.clear();
		this.remoteDocsInflight.clear();
	}

	async updateAllSyspromptDocs(): Promise<IAdeEnsureSyspromptDocsResult> {
		this.invalidateRemoteSyspromptCache();
		return this.ensureLocalSyspromptDocs();
	}

	getLocalSyspromptBaseDir(docRev = ADE_SYSPROMPT_DOC_REV): string {
		return path.join(this.adeHomeDir, 'sysprompts', `v${docRev}`);
	}

	getRemoteSyspromptBaseDir(remoteHome: string, docRev = ADE_SYSPROMPT_DOC_REV): string {
		return path.posix.join(remoteHome.replace(/\/+$/, ''), ADE_REMOTE_STORE_DIR_NAME, 'sysprompts', `v${docRev}`);
	}

	/**
	 * Ensures all 3 lowercase `0444` module docs exist and match SHA-256 on the local machine.
	 */
	ensureLocalSyspromptDocs(): Promise<IAdeEnsureSyspromptDocsResult> {
		return this.localDocsSequencer.queue(async () => {
			const baseDir = this.getLocalSyspromptBaseDir(ADE_SYSPROMPT_DOC_REV);
			await fs.promises.mkdir(baseDir, { recursive: true, mode: 0o755 });

			const files: Record<AdeSyspromptModuleKey, string> = {
				ticket: '',
				orchestration: '',
				whiteboard: '',
			};
			for (const key of ADE_SYSPROMPT_MODULE_KEYS) {
				const filePath = path.join(baseDir, `${key}.md`);
				files[key] = filePath;
				const expectedBody = ADE_SYSPROMPT_MODULE_DOCS[key];
				const expectedSha = EXPECTED_DOC_HASHES[key];

				let valid = false;
				try {
					const st = await fs.promises.lstat(filePath);
					if (st.isFile() && !st.isSymbolicLink()) {
						const raw = await fs.promises.readFile(filePath, 'utf8');
						const modeOk = isWindows || (st.mode & 0o777) === 0o444;
						valid = raw === expectedBody && sha256Hex(raw) === expectedSha && modeOk;
					}
				} catch {
					valid = false;
				}

				if (!valid) {
					await this.writeLocalReadonly0444Atomically(filePath, expectedBody);
				}
			}

			return {
				doc_rev: ADE_SYSPROMPT_DOC_REV,
				base_dir: baseDir,
				files,
			};
		});
	}

	private async resolveCanonicalRemoteHostKey(sshAliasOrIp: string, canonicalHostHint?: string): Promise<{
		readonly canonicalHostKey: string;
		readonly effectiveAuthority: string;
	}> {
		const trimmed = sshAliasOrIp.trim();
		const hint = canonicalHostHint?.trim().toLowerCase();
		if (this.cloudHosts) {
			try {
				const found = typeof this.cloudHosts.getHost === 'function'
					? await this.cloudHosts.getHost(trimmed)
					: undefined;
				if (found?.hostName?.trim()) {
					return {
						canonicalHostKey: found.hostName.trim().toLowerCase(),
						effectiveAuthority: found.alias || trimmed,
					};
				}
				if (typeof this.cloudHosts.listHosts === 'function') {
					const all = await this.cloudHosts.listHosts();
					const matched = all.find(h =>
						h.alias === trimmed
						|| h.hostName === trimmed
						|| h.id === trimmed
						|| h.alias.toLowerCase() === trimmed.toLowerCase()
						|| h.hostName.toLowerCase() === trimmed.toLowerCase(),
					);
					if (matched?.hostName?.trim()) {
						return {
							canonicalHostKey: matched.hostName.trim().toLowerCase(),
							effectiveAuthority: matched.alias || trimmed,
						};
					}
				}
			} catch {
				// fallback to hint or raw alias
			}
		}
		return {
			canonicalHostKey: hint || trimmed.toLowerCase(),
			effectiveAuthority: trimmed,
		};
	}

	/**
	 * Ensures all 3 lowercase `0444` module docs exist and match SHA-256 on a remote cloud host (`$HOME/.ade_store/sysprompts/v1/`).
	 * Coalesces concurrent inflight calls per `(canonicalHostKey, docsContentDigest)` with TTL caching,
	 * and completes in a single SSH `sh -c` round-trip whenever all 3 docs already match SHA-256 and `0444`.
	 */
	async ensureRemoteSyspromptDocs(
		sshAlias: string,
		remoteHome: string,
		canonicalHostHint?: string,
	): Promise<IAdeEnsureSyspromptDocsResult> {
		const baseDir = this.getRemoteSyspromptBaseDir(remoteHome, ADE_SYSPROMPT_DOC_REV);
		const files: Record<AdeSyspromptModuleKey, string> = {
			ticket: path.posix.join(baseDir, 'ticket.md'),
			orchestration: path.posix.join(baseDir, 'orchestration.md'),
			whiteboard: path.posix.join(baseDir, 'whiteboard.md'),
		};
		const svc = this.cloudHosts as (IAdeCloudHostBackendService & {
			remoteExecCommand?: (authority: string, opts: { command: string; timeoutMs?: number }) => Promise<{ exitCode: number; outputTail: string }>;
		}) | undefined;
		if (!svc) {
			return { doc_rev: ADE_SYSPROMPT_DOC_REV, base_dir: baseDir, files };
		}

		const { canonicalHostKey, effectiveAuthority } = await this.resolveCanonicalRemoteHostKey(sshAlias, canonicalHostHint);
		const docsDigest = computeSyspromptDocsContentDigest();
		const cacheKey = `${canonicalHostKey}\0${baseDir}\0${docsDigest}`;
		const now = Date.now();

		if (this.remoteDocsCacheTtlMs > 0) {
			const hit = this.remoteDocsCache.get(cacheKey);
			if (hit && hit.expiresAt > now) {
				return hit.value;
			}
			if (hit) {
				this.remoteDocsCache.delete(cacheKey);
			}
		}

		const existingInflight = this.remoteDocsInflight.get(cacheKey);
		if (existingInflight) {
			return existingInflight;
		}

		const genAtStart = this.remoteCacheGeneration;
		const runSync = async (): Promise<IAdeEnsureSyspromptDocsResult> => {
			if (svc.remoteExecCommand) {
				const safePosixPath = (p: string) => p.startsWith('-') ? `./${p}` : p;
				const checkCalls = ADE_SYSPROMPT_MODULE_KEYS.map(key => {
					const expectedSha = sha256Hex(ADE_SYSPROMPT_MODULE_DOCS[key]);
					return `chk_doc ${posixQuote(key)} ${posixQuote(safePosixPath(files[key]))} ${posixQuote(expectedSha)}`;
				});
				const batchScript = [
					`set -e`,
					`mkdir -p -m 755 ${posixQuote(safePosixPath(baseDir))}`,
					`get_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || { lp=$(ls -ld "$1" 2>/dev/null | awk '{print $1}'); case "$lp" in -r--r--r--*) printf '444' ;; *) printf 'other' ;; esac; }; }`,
					`chk_doc() { k="$1"; p="$2"; exp="$3"; case "$p" in -*) p="./$p" ;; esac; if [ -f "$p" ] && [ ! -L "$p" ]; then sha=$( (sha256sum "$p" 2>/dev/null || shasum -a 256 "$p") | awk '{print $1}' ); md=$(get_mode "$p" | tr -d ' \\t\\r\\n'); if [ "$sha" = "$exp" ]; then case "$md" in 444|0444) printf '__ADE_DOC_OK__:%s\\n' "$k"; return 0 ;; esac; chmod 0444 "$p" 2>/dev/null || true; md2=$(get_mode "$p" | tr -d ' \\t\\r\\n'); case "$md2" in 444|0444) printf '__ADE_DOC_OK__:%s\\n' "$k"; return 0 ;; esac; fi; fi; rm -f -- "$p" 2>/dev/null || chmod u+w "$p" 2>/dev/null || true; printf '__ADE_DOC_MISS__:%s\\n' "$k"; }`,
					...checkCalls,
				].join('\n');

				const probeRes = await svc.remoteExecCommand(effectiveAuthority, { command: batchScript, timeoutMs: 12_000 });
				const okKeys = new Set<string>();
				if (probeRes.exitCode === 0) {
					for (const rawLine of probeRes.outputTail.split(/\r?\n/)) {
						const line = rawLine.trim();
						if (line.startsWith('__ADE_DOC_OK__:')) {
							okKeys.add(line.slice('__ADE_DOC_OK__:'.length));
						}
					}
				} else {
					await svc.remoteMkdir(effectiveAuthority, baseDir);
				}

				const missingKeys = ADE_SYSPROMPT_MODULE_KEYS.filter(k => !okKeys.has(k));
				if (missingKeys.length > 0) {
					for (const key of missingKeys) {
						const remoteFile = files[key];
						const body = ADE_SYSPROMPT_MODULE_DOCS[key];
						await svc.remoteWriteFile(effectiveAuthority, remoteFile, VSBuffer.fromString(body), { create: true, overwrite: true });
					}
					const finalizeArgs = missingKeys.map(k => posixQuote(safePosixPath(files[k]))).join(' ');
					const finalizeRes = await svc.remoteExecCommand(effectiveAuthority, {
						command: `chmod 0444 ${finalizeArgs}`,
						timeoutMs: 8_000,
					});
					if (finalizeRes.exitCode !== 0) {
						throw new Error(`Failed to set 0444 on remote sysprompt docs (${effectiveAuthority}): exit ${finalizeRes.exitCode}`);
					}
				}
			} else {
				await svc.remoteMkdir(effectiveAuthority, baseDir);
				for (const key of ADE_SYSPROMPT_MODULE_KEYS) {
					const remoteFile = files[key];
					const body = ADE_SYSPROMPT_MODULE_DOCS[key];
					const expectedSha = sha256Hex(body);
					const existing = await this.readRemoteTextIfExists(effectiveAuthority, remoteFile);
					if (existing === undefined || sha256Hex(existing) !== expectedSha) {
						await svc.remoteWriteFile(effectiveAuthority, remoteFile, VSBuffer.fromString(body), { create: true, overwrite: true });
					}
				}
			}

			const result: IAdeEnsureSyspromptDocsResult = {
				doc_rev: ADE_SYSPROMPT_DOC_REV,
				base_dir: baseDir,
				files,
			};
			if (this.remoteDocsCacheTtlMs > 0 && this.remoteCacheGeneration === genAtStart) {
				this.remoteDocsCache.set(cacheKey, {
					expiresAt: Date.now() + this.remoteDocsCacheTtlMs,
					value: result,
				});
			}
			return result;
		};

		const inflightPromise = runSync().finally(() => {
			if (this.remoteDocsInflight.get(cacheKey) === inflightPromise) {
				this.remoteDocsInflight.delete(cacheKey);
			}
		});
		this.remoteDocsInflight.set(cacheKey, inflightPromise);
		return inflightPromise;
	}

	/**
	 * Deploys static routing files (`AGENTS.md`, optional `.claude/CLAUDE.md`, optional `.agents/rules/ade-routing.md`)
	 * into a local directory `<cwd>` and silently excludes newly created files via Git's worktree-safe `info/exclude`.
	 * Serialized by `localRoutingLedgerSequencer` to eliminate concurrent `managed-files.json` ledger races.
	 */
	syncLocalWorkspaceRoutingFiles(
		cwdPath: string,
		spec: IAdeWorkspaceRoutingSpec,
	): Promise<{ readonly hasAgentsOverrideWarning: boolean; readonly writtenRelPaths: readonly string[] }> {
		return this.localRoutingLedgerSequencer.queue(async () => {
			await fs.promises.mkdir(cwdPath, { recursive: true });
			const ledger = await this.readManagedLedger();
			const newlyCreatedRelPaths: string[] = [];
			const writtenRelPaths: string[] = [];

			// 1. Always deploy `<cwd>/AGENTS.md` (NEVER create a root `CLAUDE.md` containing `@AGENTS.md`!)
			const agentsMdPath = path.join(cwdPath, 'AGENTS.md');
			const agentsExisted = await this.fileExists(agentsMdPath);
			const existingAgentsText = agentsExisted ? await fs.promises.readFile(agentsMdPath, 'utf8').catch(() => undefined) : undefined;
			const prevRec = ledger.entries[agentsMdPath];
			const mergedAgents = buildIdempotentRoutingFileContent(existingAgentsText, Boolean(prevRec?.pureManaged));
			if (existingAgentsText !== mergedAgents.content) {
				await this.writeLocalFileAtomically(agentsMdPath, mergedAgents.content, 0o644);
			}
			ledger.entries[agentsMdPath] = {
				pureManaged: mergedAgents.pureManaged,
				sha256: sha256Hex(mergedAgents.content),
				updatedAt: Date.now(),
			};
			writtenRelPaths.push('AGENTS.md');
			if (!agentsExisted) {
				newlyCreatedRelPaths.push('AGENTS.md');
			}

			// 2. Conditional Claude rule: ONLY when legacy Claude (<2.1.277) / Bedrock / custom root CLAUDE.md exists
			const rootClaudeMdPath = path.join(cwdPath, 'CLAUDE.md');
			const rootClaudeExists = await this.fileExists(rootClaudeMdPath);
			if ((spec.hasClaudeAgent ?? spec.hasLegacyClaudeOrBedrock) && rootClaudeExists) {
				const existingClaudeText = await fs.promises.readFile(rootClaudeMdPath, 'utf8').catch(() => undefined);
				const prevClaudeRec = ledger.entries[rootClaudeMdPath];
				const mergedClaude = buildIdempotentRoutingFileContent(existingClaudeText, Boolean(prevClaudeRec?.pureManaged));
				if (existingClaudeText !== mergedClaude.content) {
					await this.writeLocalFileAtomically(rootClaudeMdPath, mergedClaude.content, 0o644);
				}
				ledger.entries[rootClaudeMdPath] = {
					pureManaged: mergedClaude.pureManaged,
					sha256: sha256Hex(mergedClaude.content),
					updatedAt: Date.now(),
				};
				writtenRelPaths.push('CLAUDE.md');
			} else if (spec.hasLegacyClaudeOrBedrock) {
				const subClaudeRel = '.claude/CLAUDE.md';
				const subClaudePath = path.join(cwdPath, '.claude', 'CLAUDE.md');
				const subExisted = await this.fileExists(subClaudePath);
				const existingSubText = subExisted ? await fs.promises.readFile(subClaudePath, 'utf8').catch(() => undefined) : undefined;
				const mergedSub = buildIdempotentRoutingFileContent(existingSubText, Boolean(ledger.entries[subClaudePath]?.pureManaged));
				if (existingSubText !== mergedSub.content) {
					await this.writeLocalFileAtomically(subClaudePath, mergedSub.content, 0o644);
				}
				ledger.entries[subClaudePath] = {
					pureManaged: mergedSub.pureManaged,
					sha256: sha256Hex(mergedSub.content),
					updatedAt: Date.now(),
				};
				writtenRelPaths.push(subClaudeRel);
				if (!subExisted) {
					newlyCreatedRelPaths.push(subClaudeRel);
				}
			}

			// 3. Conditional Antigravity (`agy acp`) rule: ONLY when project has an `antigravity` agent
			if (spec.hasAntigravityAgent) {
				const agyRel = '.agents/rules/ade-routing.md';
				const agyPath = path.join(cwdPath, '.agents', 'rules', 'ade-routing.md');
				const agyExisted = await this.fileExists(agyPath);
				const existingAgy = agyExisted ? await fs.promises.readFile(agyPath, 'utf8').catch(() => undefined) : undefined;
				if (existingAgy !== ADE_ANTIGRAVITY_ROUTING_RULE_MD) {
					await this.writeLocalFileAtomically(agyPath, ADE_ANTIGRAVITY_ROUTING_RULE_MD, 0o644);
				}
				ledger.entries[agyPath] = {
					pureManaged: true,
					sha256: sha256Hex(ADE_ANTIGRAVITY_ROUTING_RULE_MD),
					updatedAt: Date.now(),
				};
				writtenRelPaths.push(agyRel);
				if (!agyExisted) {
					newlyCreatedRelPaths.push(agyRel);
				}
			}

			await this.writeManagedLedger(ledger);

			if (newlyCreatedRelPaths.length > 0) {
				await this.appendGitInfoExcludeLocal(cwdPath, newlyCreatedRelPaths);
			}

			const hasAgentsOverrideWarning = await this.fileExists(path.join(cwdPath, 'AGENTS.override.md'));
			return { hasAgentsOverrideWarning, writtenRelPaths };
		});
	}

	/**
	 * Deploys static routing files to a remote cloud directory (`<remoteCwd>` or `$HOME/.ade_store/workspaces/{pid}/{aid}/`)
	 * and updates Git `info/exclude` when inside a Git repository/worktree.
	 */
	async syncRemoteWorkspaceRoutingFiles(
		sshAlias: string,
		remoteCwdPath: string,
		spec: IAdeWorkspaceRoutingSpec,
	): Promise<void> {
		if (!this.cloudHosts) {
			return;
		}
		await this.cloudHosts.remoteMkdir(sshAlias, remoteCwdPath);

		const createdRels: string[] = [];
		const agentsRemotePath = path.posix.join(remoteCwdPath, 'AGENTS.md');
		const existingAgents = await this.readRemoteTextIfExists(sshAlias, agentsRemotePath);
		const mergedAgents = buildIdempotentRoutingFileContent(existingAgents, existingAgents === undefined);
		if (existingAgents !== mergedAgents.content) {
			await this.cloudHosts.remoteWriteFile(sshAlias, agentsRemotePath, VSBuffer.fromString(mergedAgents.content), { create: true, overwrite: true });
		}
		if (existingAgents === undefined) {
			createdRels.push('AGENTS.md');
		}

		const rootClaudeRemote = path.posix.join(remoteCwdPath, 'CLAUDE.md');
		const existingRootClaude = await this.readRemoteTextIfExists(sshAlias, rootClaudeRemote);
		if ((spec.hasClaudeAgent ?? spec.hasLegacyClaudeOrBedrock) && existingRootClaude !== undefined) {
			const mergedClaude = buildIdempotentRoutingFileContent(existingRootClaude, false);
			if (existingRootClaude !== mergedClaude.content) {
				await this.cloudHosts.remoteWriteFile(sshAlias, rootClaudeRemote, VSBuffer.fromString(mergedClaude.content), { create: true, overwrite: true });
			}
		} else if (spec.hasLegacyClaudeOrBedrock) {
			const subClaudeRemote = path.posix.join(remoteCwdPath, '.claude', 'CLAUDE.md');
			const existingSub = await this.readRemoteTextIfExists(sshAlias, subClaudeRemote);
			const mergedSub = buildIdempotentRoutingFileContent(existingSub, existingSub === undefined);
			if (existingSub !== mergedSub.content) {
				await this.cloudHosts.remoteWriteFile(sshAlias, subClaudeRemote, VSBuffer.fromString(mergedSub.content), { create: true, overwrite: true });
			}
			if (existingSub === undefined) {
				createdRels.push('.claude/CLAUDE.md');
			}
		}

		if (spec.hasAntigravityAgent) {
			const agyRemote = path.posix.join(remoteCwdPath, '.agents', 'rules', 'ade-routing.md');
			const existingAgy = await this.readRemoteTextIfExists(sshAlias, agyRemote);
			if (existingAgy !== ADE_ANTIGRAVITY_ROUTING_RULE_MD) {
				await this.cloudHosts.remoteWriteFile(sshAlias, agyRemote, VSBuffer.fromString(ADE_ANTIGRAVITY_ROUTING_RULE_MD), { create: true, overwrite: true });
			}
			if (existingAgy === undefined) {
				createdRels.push('.agents/rules/ade-routing.md');
			}
		}

		const svc = this.cloudHosts as (IAdeCloudHostBackendService & {
			remoteExecCommand?: (authority: string, opts: { command: string; timeoutMs?: number }) => Promise<{ exitCode: number }>;
		});
		if (createdRels.length > 0 && svc.remoteExecCommand) {
			const excludeLines = createdRels.map(rel => `grep -qxF ${posixQuote(`/${rel}`)} "$excl" 2>/dev/null || printf '%s\\n' ${posixQuote(`/${rel}`)} >> "$excl"`).join('; ');
			const gitCmd = `excl=$(git -C ${posixQuote(remoteCwdPath)} rev-parse --path-format=absolute --git-path info/exclude 2>/dev/null || true); if [ -n "$excl" ]; then mkdir -p -- "$(dirname -- "$excl")"; touch "$excl"; ${excludeLines}; fi`;
			await svc.remoteExecCommand(sshAlias, { command: gitCmd, timeoutMs: 6_000 }).catch(() => undefined);
		}
	}

	buildRemoteIsolatedAgentWorkspaceDir(remoteHome: string, projectId: string, agentId: string): string {
		const safePid = projectId.replace(/[^A-Za-z0-9_.-]/g, '_');
		const safeAid = agentId.replace(/[^A-Za-z0-9_.-]/g, '_');
		return path.posix.join(remoteHome.replace(/\/+$/, ''), ADE_REMOTE_STORE_DIR_NAME, 'workspaces', safePid, safeAid);
	}

	private async readRemoteTextIfExists(sshAlias: string, remotePath: string): Promise<string | undefined> {
		if (!this.cloudHosts) {
			return undefined;
		}
		try {
			const buf = await this.cloudHosts.remoteReadFile(sshAlias, remotePath);
			return buf.toString();
		} catch {
			return undefined;
		}
	}

	private async appendGitInfoExcludeLocal(cwdPath: string, relPaths: readonly string[]): Promise<void> {
		const excludeFile = await this.resolveGitInfoExcludePath(cwdPath);
		if (!excludeFile) {
			return;
		}
		try {
			await fs.promises.mkdir(path.dirname(excludeFile), { recursive: true });
			let current = '';
			try {
				current = await fs.promises.readFile(excludeFile, 'utf8');
			} catch {
				current = '';
			}
			const existingLines = new Set(current.split(/\r?\n/).map(l => l.trim()));
			const additions: string[] = [];
			for (const rel of relPaths) {
				const normEntry = `/${rel.replace(/\\/g, '/').replace(/^\/+/, '')}`;
				if (!existingLines.has(normEntry) && !existingLines.has(normEntry.slice(1))) {
					additions.push(normEntry);
				}
			}
			if (additions.length > 0) {
				const prefix = current.length > 0 && !current.endsWith('\n') ? `${current}\n` : current;
				await this.writeLocalFileAtomically(excludeFile, `${prefix}${additions.join('\n')}\n`, 0o644);
			}
		} catch {
			// Ignore if not a writable git directory
		}
	}

	private resolveGitInfoExcludePath(cwdPath: string): Promise<string | undefined> {
		return new Promise(resolve => {
			let out = '';
			let settled = false;
			const child = spawn('git', ['-C', cwdPath, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], {
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'ignore'],
				env: stripAdeControlEnv(process.env),
			});
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					try { child.kill('SIGKILL'); } catch { /* ignore */ }
					resolve(undefined);
				}
			}, 3_000);
			if (typeof (timer as { unref?: () => void }).unref === 'function') {
				(timer as { unref?: () => void }).unref!();
			}
			child.stdout.on('data', (c: Buffer) => {
				out += c.toString('utf8');
			});
			child.once('error', () => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(undefined);
				}
			});
			child.once('close', code => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					const trimmed = out.trim();
					resolve(code === 0 && trimmed ? trimmed : undefined);
				}
			});
		});
	}

	private async writeLocalReadonly0444Atomically(targetPath: string, content: string): Promise<void> {
		const dir = path.dirname(targetPath);
		await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 });
		const tmp = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
		try {
			await fs.promises.writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
			if (!isWindows) {
				await fs.promises.chmod(tmp, 0o444);
				// Allow replacing existing 0444 file on platforms requiring writable target unlink
				await fs.promises.chmod(targetPath, 0o600).catch(() => undefined);
			}
			await fs.promises.rename(tmp, targetPath);
			if (!isWindows) {
				await fs.promises.chmod(targetPath, 0o444).catch(() => undefined);
			}
		} catch (err) {
			await fs.promises.unlink(tmp).catch(() => undefined);
			throw err;
		}
	}

	private async writeLocalFileAtomically(targetPath: string, content: string, mode: number): Promise<void> {
		const dir = path.dirname(targetPath);
		await fs.promises.mkdir(dir, { recursive: true });
		const tmp = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
		try {
			await fs.promises.writeFile(tmp, content, { encoding: 'utf8', mode });
			await fs.promises.rename(tmp, targetPath);
		} catch (err) {
			await fs.promises.unlink(tmp).catch(() => undefined);
			throw err;
		}
	}

	private async fileExists(filePath: string): Promise<boolean> {
		try {
			const st = await fs.promises.stat(filePath);
			return st.isFile();
		} catch {
			return false;
		}
	}

	private async readManagedLedger(): Promise<IManagedFilesLedger> {
		try {
			const raw = await fs.promises.readFile(this.managedLedgerPath, 'utf8');
			const parsed = JSON.parse(raw) as Partial<IManagedFilesLedger>;
			if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
				return { version: 1, entries: { ...parsed.entries } };
			}
		} catch {
			// absent
		}
		return { version: 1, entries: {} };
	}

	private async writeManagedLedger(ledger: IManagedFilesLedger): Promise<void> {
		await fs.promises.mkdir(path.dirname(this.managedLedgerPath), { recursive: true, mode: 0o700 });
		await this.writeLocalFileAtomically(this.managedLedgerPath, JSON.stringify(ledger, null, 2) + '\n', 0o600);
	}
}
