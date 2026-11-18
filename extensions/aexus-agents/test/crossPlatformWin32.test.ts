/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCliCommand } from '../src/adeCli.ts';
import { escapeWinCmdToken, isPathWithinOrEqual } from '../src/roleBridgeShared.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(TEST_DIR, '..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..', '..');

/**
 * Mirrors the Windows npm `.cmd` shim handling in `resolveDshDirectSpawn`, which is guarded by
 * `process.platform === 'win32'` and therefore cannot run its real branch on every host.
 */
const WINDOWS_CMD_SHIM_JS_PATTERN = /"%(?:~)?dp0%?\\([^"]+\.(?:c|m)?js)"/i;

function extractWindowsCmdShimJsEntry(contents: string, shimDir: string): string | undefined {
	const match = contents.match(WINDOWS_CMD_SHIM_JS_PATTERN);
	return match ? path.resolve(shimDir, match[1].replace(/\\/g, path.sep)) : undefined;
}

describe('cross-platform launchers', () => {
	test('extension bin ships POSIX, cmd and PowerShell launchers', () => {
		const binDir = path.join(EXTENSION_ROOT, 'bin');
		const entries = ['aexus-ade', 'aexus-ade.cmd', 'aexus-ade.ps1'].map(name => {
			const filePath = path.join(binDir, name);
			return { name, isFile: fs.existsSync(filePath) && fs.statSync(filePath).isFile() };
		});
		assert.deepStrictEqual(entries, [
			{ name: 'aexus-ade', isFile: true },
			{ name: 'aexus-ade.cmd', isFile: true },
			{ name: 'aexus-ade.ps1', isFile: true },
		]);
	});

	test('Windows resources ship cmd, PowerShell and POSIX launchers', () => {
		for (const rel of [['resources', 'win32', 'bin'], ['resources', 'win32', 'versioned', 'bin']]) {
			const binDir = path.join(REPO_ROOT, ...rel);
			const entries = ['aexus-ade.cmd', 'aexus-ade.ps1', 'aexus-ade.sh'].map(name => {
				const filePath = path.join(binDir, name);
				return { name, isFile: fs.existsSync(filePath) && fs.statSync(filePath).isFile() };
			});
			assert.deepStrictEqual(entries, [
				{ name: 'aexus-ade.cmd', isFile: true },
				{ name: 'aexus-ade.ps1', isFile: true },
				{ name: 'aexus-ade.sh', isFile: true },
			]);
		}
	});
});

describe('isPathWithinOrEqual', () => {
	const root = path.join(os.tmpdir(), 'aexus-path-containment');

	test('accepts the same path and descendants, rejects siblings and prefixes', () => {
		assert.deepStrictEqual([
			isPathWithinOrEqual(root, root),
			isPathWithinOrEqual(path.join(root, 'nested', 'child'), root),
			isPathWithinOrEqual(root + '-sibling', root),
			isPathWithinOrEqual(path.dirname(root), root),
		], [true, true, false, false]);
	});

	test('treats the filesystem root as containing every absolute path', () => {
		const fsRoot = path.parse(root).root;
		assert.equal(isPathWithinOrEqual(path.join(root, 'child'), fsRoot), true);
	});

	test('handles Windows drive roots and case-insensitive containment', { skip: process.platform !== 'win32' }, () => {
		assert.deepStrictEqual([
			isPathWithinOrEqual('C:\\Users\\dev', 'C:\\'),
			isPathWithinOrEqual('C:\\Users\\DEV\\repo', 'c:\\users\\dev'),
			isPathWithinOrEqual('D:\\repo', 'C:\\'),
		], [true, true, false]);
	});
});

describe('Windows npm .cmd shim JS entry resolution', () => {
	const shimDir = path.join(os.tmpdir(), 'aexus-shim');

	test('extracts the JS entry from %~dp0 and %dp0% shims', () => {
		const shims = [
			'@ECHO off\r\nnode "%~dp0\\..\\lib\\cli.js" %*\r\n',
			'"%dp0%\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.cjs" %*\r\n',
			'"%~dp0\\..\\lib\\cli.mjs" %*\r\n',
		];
		assert.deepStrictEqual(shims.map(shim => extractWindowsCmdShimJsEntry(shim, shimDir)), [
			path.resolve(shimDir, '..', 'lib', 'cli.js'),
			path.resolve(shimDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.cjs'),
			path.resolve(shimDir, '..', 'lib', 'cli.mjs'),
		]);
	});

	test('ignores batch files without a quoted JS entry', () => {
		assert.deepStrictEqual([
			extractWindowsCmdShimJsEntry('@ECHO off\r\necho hi\r\n', shimDir),
			extractWindowsCmdShimJsEntry('node cli.js %*', shimDir),
		], [undefined, undefined]);
	});
});

describe('parseCliCommand project add tilde expansion', () => {
	test('expands both ~/ and ~\\ against the home directory', () => {
		const parsed = parseCliCommand(['project', 'add', '~/repo', '~\\repo', '~']);
		const home = os.homedir();
		const repo = path.resolve(home, 'repo');
		assert.deepStrictEqual(parsed, {
			help: false,
			json: false,
			windowId: undefined,
			action: 'project.add',
			params: { paths: [repo, repo, path.resolve(home)] },
		});
	});
});

describe('escapeWinCmdToken', () => {
	test('keeps plain outer quotes on command paths containing spaces while escaping metacharacters in arguments', () => {
		const cmdToken = escapeWinCmdToken('C:\\Users\\First Last\\AppData\\Local\\Programs\\Aexus Code\\bin\\aexus-ade.cmd', true);
		const argToken = escapeWinCmdToken('A & B | (C) "quoted"', false);
		assert.strictEqual(cmdToken, '"C:\\Users\\First Last\\AppData\\Local\\Programs\\Aexus Code\\bin\\aexus-ade.cmd"');
		assert.ok(!cmdToken.includes('^"'));
		assert.ok(argToken.includes('^&') && argToken.includes('^|'));
	});
});
