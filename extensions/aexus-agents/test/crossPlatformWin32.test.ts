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
import { ADE_CLI_COMMANDS } from '../scripts/genAdeBins.mjs';
import { isPathWithinOrEqual } from '../src/agentEnvIsolation.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(TEST_DIR, '..');

const WINDOWS_CMD_SHIM_JS_PATTERN = /"%(?:~)?dp0%?\\([^"]+\.(?:c|m)?js)"/i;

function extractWindowsCmdShimJsEntry(contents: string, shimDir: string): string | undefined {
	const match = contents.match(WINDOWS_CMD_SHIM_JS_PATTERN);
	return match ? path.resolve(shimDir, match[1].replace(/\\/g, path.sep)) : undefined;
}

describe('cross-platform 45 ade_* CLI launchers', () => {
	test('extension bin ships _ade_runner plus 45 POSIX and 45 Windows .cmd launchers (zero legacy wrapper)', () => {
		const binDir = path.join(EXTENSION_ROOT, 'bin');
		const legacyCli = ['aexus', 'ade'].join('-');
		assert.equal(ADE_CLI_COMMANDS.length, 45);
		assert.equal(fs.existsSync(path.join(binDir, '_ade_runner')), true, '_ade_runner must exist');
		assert.equal(fs.existsSync(path.join(binDir, legacyCli)), false, 'legacy wrapper must not exist');
		assert.equal(fs.existsSync(path.join(binDir, `${legacyCli}.cmd`)), false, 'legacy cmd wrapper must not exist');

		for (const cmd of ADE_CLI_COMMANDS) {
			const posixPath = path.join(binDir, cmd);
			const cmdPath = path.join(binDir, `${cmd}.cmd`);
			assert.equal(fs.existsSync(posixPath) && fs.statSync(posixPath).isFile(), true, `Missing POSIX launcher ${cmd}`);
			assert.equal(fs.existsSync(cmdPath) && fs.statSync(cmdPath).isFile(), true, `Missing Windows launcher ${cmd}.cmd`);
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
});

describe('cross-platform sqlite3 & env hygiene in acp.ts', () => {
	test('acp.ts resolves sqlite3 cross-platform without hardcoded /usr/bin/sqlite3 and scrubs ADE control env', () => {
		const acpSource = fs.readFileSync(path.join(EXTENSION_ROOT, 'src', 'acp.ts'), 'utf8');
		assert.strictEqual(acpSource.includes('/usr/bin/sqlite3'), false, 'acp.ts must not hardcode /usr/bin/sqlite3');
		assert.ok(acpSource.includes('findExecutable(\'sqlite3\')'), 'acp.ts should resolve sqlite3 via findExecutable');
		assert.ok(acpSource.includes('stripAdeControlEnv(process.env)'), 'acp.ts should strip ADE control vars before spawning sqlite3');
	});
});
