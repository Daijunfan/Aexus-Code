/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from '../../../../base/common/path.js';
import { FileAccess } from '../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	ADE_TICKET_SYSTEM_PREFIX_HEAD,
	ADE_TICKET_SYSTEM_PREFIX_TAIL,
	buildAdeTicketSystemPrefix,
} from '../../common/adeModels.js';

function resolveRepoRoot(): string {
	const appRoot = FileAccess.asFileUri('').fsPath;
	const baseName = path.basename(appRoot);
	if (baseName === 'out' || baseName === 'out-build') {
		return path.dirname(appRoot);
	}
	return appRoot;
}

const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'out',
	'out-build',
]);

const TEXT_EXTENSIONS = new Set([
	'.ts',
	'.mts',
	'.cts',
	'.js',
	'.mjs',
	'.cjs',
	'.json',
	'.md',
	'.css',
	'.sh',
	'.ps1',
	'.cmd',
	'.yml',
	'.yaml',
]);

function collectScannedFiles(repoRoot: string, relTargets: readonly string[]): readonly string[] {
	const files: string[] = [];
	const walk = (absPath: string) => {
		if (!fs.existsSync(absPath)) {
			return;
		}
		const stat = fs.statSync(absPath);
		if (stat.isDirectory()) {
			for (const entry of fs.readdirSync(absPath)) {
				if (SKIP_DIRS.has(entry)) {
					continue;
				}
				walk(path.join(absPath, entry));
			}
			return;
		}
		if (!stat.isFile()) {
			return;
		}
		const base = path.basename(absPath);
		if (base.startsWith('adeZeroLegacyPromptsGate.test.')) {
			return;
		}
		const ext = path.extname(base).toLowerCase();
		if (TEXT_EXTENSIONS.has(ext) || base.startsWith('ade_')) {
			files.push(absPath);
		}
	};
	for (const rel of relTargets) {
		walk(path.join(repoRoot, rel));
	}
	return files;
}

suite('Gate 1: Zero Legacy Prompts, Role Hijack & Envelope Blacklist Static Redline', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const FORBIDDEN_PATTERNS: readonly string[] = [
		['compileAdeRole', 'Prompt'].join(''),
		['AEXUS_SYSTEM_TOKEN', '_ENVELOPE'].join(''),
		['dshRole', 'Preload'].join(''),
		['extHostRole', 'Preload'].join(''),
		['agyRole', 'Hook'].join(''),
		['nativeRole', 'Bridge'].join(''),
		['--append-system', '-prompt'].join(''),
		['Autonomous Goal ', 'Stop-Check'].join(''),
		['Summarize this ', 'conversation so far'].join(''),
		['[Mode: ', 'Plan Mode'].join(''),
		['node', 'Prompts'].join(''),
		['aexus-', 'secretary'].join(''),
		['aexus-', 'ade'].join(''),
	];

	test('1. Standard Ticket system prefix preserves exact literal and trailing single ASCII space', () => {
		const sysWord = ['系统', '提示词'].join('');
		assert.strictEqual(ADE_TICKET_SYSTEM_PREFIX_HEAD, `[${sysWord}: 此消息是来自Agent {`);
		assert.strictEqual(ADE_TICKET_SYSTEM_PREFIX_TAIL, '}的Ticket] ');
		assert.strictEqual(ADE_TICKET_SYSTEM_PREFIX_TAIL.endsWith(' '), true, 'Must preserve single trailing space');
		assert.strictEqual(
			buildAdeTicketSystemPrefix('agent_l1_lead'),
			`[${sysWord}: 此消息是来自Agent {agent_l1_lead}的Ticket] `,
		);
	});

	test('2. Scanned ADE directories contain zero legacy prompt/envelope/hijack blacklist hits and restrict Ticket prefix literal', () => {
		const repoRoot = resolveRepoRoot();
		const targets = [
			'src/vs/platform/ade',
			'src/vs/workbench/contrib/ade',
			'src/vs/workbench/api',
			'extensions/aexus-agents',
			'examples',
			'scripts',
			'.github',
		];
		const files = collectScannedFiles(repoRoot, targets);
		assert.ok(files.length >= 20, `Expected ADE source files under ${repoRoot}, found ${files.length}`);

		const violations: string[] = [];
		const sysWord = ['系统', '提示词'].join('');
		const rebuildCatalogFiles = new Set([
			'src/vs/platform/ade/common/adeModels.ts',
			'src/vs/platform/ade/common/adeSyspromptCatalog.ts',
			'extensions/aexus-agents/src/ticketMessageFormat.ts',
		]);
		const ticketPrefixHead = `[${sysWord}: 此消息是来自Agent {`;

		for (const absFile of files) {
			const relFile = path.relative(repoRoot, absFile).replace(/\\/g, '/');
			const content = fs.readFileSync(absFile, 'utf8');
			for (const token of FORBIDDEN_PATTERNS) {
				if (content.includes(token)) {
					violations.push(`${relFile} -> forbidden token "${token}"`);
				}
			}
			if (content.includes(sysWord) && !rebuildCatalogFiles.has(relFile)) {
				const strippedStandardTicketPrefix = content.split(ticketPrefixHead).join('');
				if (strippedStandardTicketPrefix.includes(sysWord)) {
					violations.push(`${relFile} -> unexpected "${sysWord}" outside standard Ticket prefix / Rebuild catalog`);
				}
			}
		}

		assert.deepStrictEqual(violations, [], `Legacy prompt/hijack redline violations:\n${violations.join('\n')}`);
	});
});
