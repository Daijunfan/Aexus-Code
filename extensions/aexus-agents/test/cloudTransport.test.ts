/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildPosixPathAugmentSnippet,
	buildPosixRemoteExecCommand,
	buildRemotePersistentPrefix,
	buildWindowsRemoteExecCommand,
	captureRemoteEngine,
	clearCloudTransportCaches,
	disposeAllRemoteControlBridges,
	encodeClaudeProjectSlug,
	encodePiProjectSlug,
	encodePowerShellCommand,
	ensureRemoteControlReverseBridge,
	extractForwardableRemoteEnv,
	inspectRemotePersistentSessionsByPrefix,
	isLegacyCloudBridgeCwd,
	normalizeCloudProjectUriString,
	normalizeRemoteCwdForCompare,
	notifySystemResume,
	onSystemResume,
	openRemoteControlReverseBridge,
	openRemotePortForward,
	parseCloudProjectUri,
	parseRemoteEngineProbeOutput,
	posixQuote,
	probeRemoteEngines,
	psSingleQuote,
	readRemoteTextFile,
	readRemoteTextFilesBatch,
	registerCloudTransportBridge,
	remotePathToFileUrl,
	resolveRemoteRealpath,
	stageLocalFileToRemote,
	stageRemoteAdeCliShim,
	terminateRemotePersistentSession,
	terminateRemotePersistentSessionsByPrefix,
	toRemoteNativePath,
	type CloudHostTarget,
} from '../src/cloudTransport.ts';
import { discoverEngineModels, registerRemoteCapabilitiesReader } from '../src/capabilities.ts';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aexus-cloud-transport-'));

const originalPath = process.env.PATH;
const originalHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const stagedRemoteFiles: string[] = [];

const MOCK_SSH_SOURCE = `#!/usr/bin/env node
'use strict';
const cp = require('node:child_process');
const net = require('node:net');

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const tail = separator >= 0 ? argv.slice(separator + 1) : [];
const alias = tail[0];
const remoteCommand = tail[1];

if (alias && alias.startsWith('fail-host')) {
	process.stderr.write('Permission denied (mock ssh).\\n');
	process.exit(255);
}

const forwardIndex = argv.indexOf('-L');
const reverseIndex = argv.indexOf('-R');
if (forwardIndex !== -1 && argv.includes('-N')) {
	const match = /^127\\.0\\.0\\.1:(\\d+):127\\.0\\.0\\.1:(\\d+)$/.exec(argv[forwardIndex + 1] || '');
	if (!match) {
		process.stderr.write('unsupported -L spec\\n');
		process.exit(2);
	}
	const server = net.createServer(client => {
		const upstream = net.createConnection({ host: '127.0.0.1', port: Number(match[2]) });
		client.pipe(upstream);
		upstream.pipe(client);
		client.on('error', () => upstream.destroy());
		upstream.on('error', () => client.destroy());
	});
	server.listen(Number(match[1]), '127.0.0.1');
	let closing = false;
	const shutdown = () => {
		if (closing) { return; }
		closing = true;
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 250).unref();
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
} else if (reverseIndex !== -1 && argv.includes('-N')) {
	const fs = require('node:fs');
	const spec = argv[reverseIndex + 1] || '';
	const udsMatch = /^(\\/[^:]+):127\\.0\\.0\\.1:(\\d+)$/.exec(spec);
	const tcpMatch = /^127\\.0\\.0\\.1:(\\d+):127\\.0\\.0\\.1:(\\d+)$/.exec(spec);
	if (udsMatch) {
		if (alias && alias.startsWith('no-uds-host')) {
			process.stderr.write('Error: remote port forwarding failed for listen path ' + udsMatch[1] + ' (administratively prohibited)\\n');
			process.exit(255);
		}
		try { fs.rmSync(udsMatch[1], { force: true }); } catch {}
		const server = net.createServer(client => {
			const upstream = net.createConnection({ host: '127.0.0.1', port: Number(udsMatch[2]) });
			client.pipe(upstream);
			upstream.pipe(client);
			client.on('error', () => upstream.destroy());
			upstream.on('error', () => client.destroy());
		});
		server.listen(udsMatch[1]);
		let closing = false;
		const shutdown = () => {
			if (closing) { return; }
			closing = true;
			server.close(() => {
				try { fs.rmSync(udsMatch[1], { force: true }); } catch {}
				process.exit(0);
			});
			setTimeout(() => process.exit(0), 250).unref();
		};
		process.on('SIGTERM', shutdown);
		process.on('SIGINT', shutdown);
	} else if (tcpMatch) {
		const requestedPort = Number(tcpMatch[1]);
		const server = net.createServer(client => {
			const upstream = net.createConnection({ host: '127.0.0.1', port: Number(tcpMatch[2]) });
			client.pipe(upstream);
			upstream.pipe(client);
			client.on('error', () => upstream.destroy());
			upstream.on('error', () => client.destroy());
		});
		server.listen(requestedPort, '127.0.0.1', () => {
			if (requestedPort === 0) {
				const addr = server.address();
				if (addr && typeof addr !== 'string') {
					process.stderr.write('Allocated port ' + addr.port + ' for remote forward to 127.0.0.1:' + tcpMatch[2] + '\\n');
				}
			}
		});
		let closing = false;
		const shutdown = () => {
			if (closing) { return; }
			closing = true;
			server.close(() => process.exit(0));
			setTimeout(() => process.exit(0), 250).unref();
		};
		process.on('SIGTERM', shutdown);
		process.on('SIGINT', shutdown);
	} else {
		process.stderr.write('unsupported -R spec: ' + spec + '\\n');
		process.exit(2);
	}
} else {
	const child = cp.spawn(process.env.AEXUS_MOCK_REMOTE_SHELL || 'sh', ['-c', remoteCommand], { stdio: ['pipe', 'pipe', 'pipe'] });
	process.stdin.on('error', () => undefined);
	child.stdin.on('error', () => undefined);
	process.stdin.pipe(child.stdin);
	child.stdout.pipe(process.stdout);
	child.stderr.pipe(process.stderr);
	child.on('exit', code => process.exit(code === null ? 1 : code));
}
`;

const mockSshPath = path.join(testRoot, 'mock-ssh.cjs');
fs.writeFileSync(mockSshPath, MOCK_SSH_SOURCE);
fs.chmodSync(mockSshPath, 0o755);

function writeExecutable(filePath: string, content: string): string {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	fs.chmodSync(filePath, 0o755);
	return filePath;
}

function makeTarget(alias: string, overrides: Partial<CloudHostTarget> = {}): CloudHostTarget {
	return {
		authority: alias.toLowerCase(),
		alias,
		os: 'linux',
		sshExecutable: mockSshPath,
		...overrides,
	};
}

function withPrependedPath(dir: string, fn: () => Promise<void>): Promise<void> {
	const previous = process.env.PATH;
	process.env.PATH = `${dir}${path.delimiter}${previous ?? ''}`;
	return fn().finally(() => {
		if (previous === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = previous;
		}
	});
}

function decodePosixExecCommand(command: string): string {
	const prefix = `sh -c '`;
	assert.ok(command.startsWith(prefix), command);
	assert.ok(command.endsWith(`'`), command);
	return command.slice(prefix.length, -1).replace(/'\\''/g, `'`);
}

function decodePowerShellCommand(command: string): string {
	const marker = '-EncodedCommand ';
	const index = command.indexOf(marker);
	assert.ok(index >= 0, `Expected an -EncodedCommand invocation: ${command}`);
	const encoded = command.slice(index + marker.length).trim();
	return Buffer.from(encoded, 'base64').toString('utf16le');
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		http.get(url, response => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
		}).on('error', reject);
	});
}

async function waitForPortClosed(port: number, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const connected = await new Promise<boolean>(resolve => {
			const socket = net.createConnection({ host: '127.0.0.1', port });
			socket.once('connect', () => { socket.destroy(); resolve(true); });
			socket.once('error', () => { socket.destroy(); resolve(false); });
			socket.setTimeout(250, () => { socket.destroy(); resolve(false); });
		});
		if (!connected) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error(`Expected forwarded port ${port} to be closed after dispose().`);
}

after(() => {
	registerCloudTransportBridge({});
	clearCloudTransportCaches();
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalHome.HOME === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome.HOME;
	}
	if (originalHome.USERPROFILE === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = originalHome.USERPROFILE;
	}
	for (const remoteFile of stagedRemoteFiles) {
		fs.rmSync(path.dirname(remoteFile), { recursive: true, force: true });
	}
	fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('toRemoteNativePath', () => {
	test('keeps POSIX paths intact on linux and macos', () => {
		assert.equal(toRemoteNativePath('/home/dev/project', 'linux'), '/home/dev/project');
		assert.equal(toRemoteNativePath('/Users/dev/project', 'macos'), '/Users/dev/project');
		assert.equal(toRemoteNativePath('/home/dev/project/', 'linux'), '/home/dev/project');
	});

	test('expands tilde forms using remoteHome', () => {
		assert.equal(toRemoteNativePath('~', 'linux', '/home/dev'), '/home/dev');
		assert.equal(toRemoteNativePath('/~', 'linux', '/home/dev'), '/home/dev');
		assert.equal(toRemoteNativePath('~/code', 'linux', '/home/dev'), '/home/dev/code');
		assert.equal(toRemoteNativePath('/~/code', 'macos', '/Users/dev/'), '/Users/dev/code');
		assert.equal(toRemoteNativePath('~/code', 'linux', 'home/dev'), '/home/dev/code');
		assert.equal(toRemoteNativePath('~/code', 'linux'), '/~/code');
	});

	test('converts Windows drive paths, roots, and UNC paths', () => {
		assert.equal(toRemoteNativePath('/C:/foo', 'windows'), 'C:\\foo');
		assert.equal(toRemoteNativePath('C:/dir', 'windows'), 'C:\\dir');
		assert.equal(toRemoteNativePath('/', 'windows'), 'C:\\');
		assert.equal(toRemoteNativePath('//server/share/dir', 'windows'), '\\\\server\\share\\dir');
		assert.equal(toRemoteNativePath('/~', 'windows', 'C:/Users/dev'), 'C:\\Users\\dev');
	});
});

describe('normalizeRemoteCwdForCompare', () => {
	test('strips trailing POSIX slashes and normalizes separators', () => {
		assert.equal(normalizeRemoteCwdForCompare('/srv/app/', 'linux'), '/srv/app');
		assert.equal(normalizeRemoteCwdForCompare('/srv/app/../app/./', 'macos'), '/srv/app');
		assert.equal(normalizeRemoteCwdForCompare('  /srv/app  ', 'linux'), '/srv/app');
	});

	test('is case-insensitive and backslash-normalized on Windows', () => {
		assert.equal(normalizeRemoteCwdForCompare('C:\\Work\\Repo\\', 'windows'), 'c:\\work\\repo');
		assert.equal(normalizeRemoteCwdForCompare('C:/Work/Repo', 'windows'), 'c:\\work\\repo');
		assert.equal(normalizeRemoteCwdForCompare('C:', 'windows'), 'c:\\');
		assert.equal(normalizeRemoteCwdForCompare('C:/', 'windows'), 'c:\\');
	});
});

describe('remotePathToFileUrl', () => {
	test('percent-encodes reserved characters and spaces on POSIX hosts', () => {
		assert.equal(
			remotePathToFileUrl('/home/dev/a b/c#1?.txt', 'linux'),
			'file:///home/dev/a%20b/c%231%3F.txt',
		);
		assert.equal(remotePathToFileUrl('home/dev/plain.txt', 'linux'), 'file:///home/dev/plain.txt');
	});

	test('percent-encodes UTF-8 non-ASCII paths', () => {
		assert.equal(
			remotePathToFileUrl('/tmp/中文 图片.txt', 'linux'),
			'file:///tmp/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.txt',
		);
	});

	test('keeps the Windows drive segment literal and encodes the rest', () => {
		assert.equal(
			remotePathToFileUrl('C:\\dir\\shot#1.png', 'windows'),
			'file:///C:/dir/shot%231.png',
		);
		assert.equal(
			remotePathToFileUrl('C:\\Users\\Me\\文件?.txt', 'windows'),
			'file:///C:/Users/Me/%E6%96%87%E4%BB%B6%3F.txt',
		);
	});
});

describe('cloud project URI helpers', () => {
	test('isLegacyCloudBridgeCwd detects legacy workspace roots only', () => {
		assert.equal(isLegacyCloudBridgeCwd('/home/dev/.aexus-code/cloud-workspaces/repo'), true);
		assert.equal(isLegacyCloudBridgeCwd('C:\\Users\\dev\\.aexus-code\\cloud-workspaces\\repo'), true);
		assert.equal(isLegacyCloudBridgeCwd('/home/dev/project'), false);
		assert.equal(isLegacyCloudBridgeCwd(undefined), false);
		assert.equal(isLegacyCloudBridgeCwd(''), false);
	});

	test('parseCloudProjectUri decodes paths and rejects non-cloud URIs', () => {
		assert.deepStrictEqual(parseCloudProjectUri('aexus-ssh://GPU1/workspace/repo%20x'), {
			scheme: 'aexus-ssh',
			authority: 'GPU1',
			path: '/workspace/repo x',
			raw: 'aexus-ssh://GPU1/workspace/repo%20x',
		});
		assert.deepStrictEqual(parseCloudProjectUri('aexus-ssh://gpu1'), {
			scheme: 'aexus-ssh',
			authority: 'gpu1',
			path: '/',
			raw: 'aexus-ssh://gpu1',
		});
		assert.equal(parseCloudProjectUri('https://gpu1/workspace'), undefined);
		assert.equal(parseCloudProjectUri('aexus-ssh:///workspace'), undefined);
		assert.equal(parseCloudProjectUri('   '), undefined);
		assert.equal(parseCloudProjectUri(undefined), undefined);
	});

	test('normalizeCloudProjectUriString trims trailing slashes and encodes segments', () => {
		const plainUri = {
			scheme: 'aexus-ssh',
			authority: 'gpu1',
			path: '/workspace/repo/',
			toString: () => 'unused',
		};
		assert.equal(normalizeCloudProjectUriString(plainUri), 'aexus-ssh://gpu1/workspace/repo');

		const spacedUri = {
			scheme: 'aexus-ssh',
			authority: 'gpu1',
			path: '/work space/repo//',
			toString: () => 'unused',
		};
		assert.equal(normalizeCloudProjectUriString(spacedUri), 'aexus-ssh://gpu1/work%20space/repo');

		const rootUri = { scheme: 'aexus-ssh', authority: 'gpu1', path: '/', toString: () => 'unused' };
		assert.equal(normalizeCloudProjectUriString(rootUri), 'aexus-ssh://gpu1/');

		const withUri = {
			scheme: 'aexus-ssh',
			authority: 'gpu1',
			path: '/a/b/',
			toString: () => 'unused',
			with(change: { path?: string }) {
				return {
					scheme: 'aexus-ssh',
					authority: 'gpu1',
					path: change.path ?? '/',
					toString: () => `aexus-ssh://gpu1${change.path}`,
				};
			},
		};
		assert.equal(normalizeCloudProjectUriString(withUri), 'aexus-ssh://gpu1/a/b');
	});
});

describe('shell quoting helpers', () => {
	test('posixQuote escapes single quotes safely', () => {
		assert.equal(posixQuote('plain'), `'plain'`);
		assert.equal(posixQuote(`it's`), `'it'\\''s'`);
		assert.equal(posixQuote(''), `''`);
	});

	test('psSingleQuote doubles single quotes', () => {
		assert.equal(psSingleQuote('plain'), `'plain'`);
		assert.equal(psSingleQuote(`it's`), `'it''s'`);
	});

	test('encodePowerShellCommand embeds the UTF-8 no-BOM setup in UTF-16LE base64', () => {
		const encoded = encodePowerShellCommand(`Write-Output 'hi'`);
		const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
		assert.ok(decoded.startsWith('$utf8=[System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding=$utf8; [Console]::OutputEncoding=$utf8; $OutputEncoding=$utf8;'));
		assert.ok(decoded.endsWith(`Write-Output 'hi'`));
		assert.ok(!decoded.startsWith('\uFEFF'));
	});
});

describe('buildPosixRemoteExecCommand', () => {
	test('augments PATH, quotes the executable, and escapes args', () => {
		const command = buildPosixRemoteExecCommand('node', ['-e', `console.log("it's")`]);
		assert.ok(command.startsWith(`sh -c `));
		assert.ok(command.includes('$HOME/.npm-global/bin'));
		assert.ok(command.includes('$HOME/.local/bin'));
		assert.ok(command.includes('export PATH'));
		assert.ok(decodePosixExecCommand(command).includes(`exec 'node' '-e' 'console.log("it'\\''s")'`));
	});

	test('exports allowlisted env vars and skips invalid identifiers', () => {
		const command = buildPosixRemoteExecCommand('claude', [], undefined, {
			MAX_THINKING_TOKENS: '2048',
			'INVALID-KEY': 'nope',
		});
		const script = decodePosixExecCommand(command);
		assert.ok(script.includes(`export MAX_THINKING_TOKENS='2048'`));
		assert.ok(!script.includes('INVALID-KEY'));
	});

	test('emits a safe printf error when the cwd is missing', () => {
		const command = buildPosixRemoteExecCommand('claude', [], '/srv/my project');
		assert.ok(decodePosixExecCommand(command).includes(`cd -- '/srv/my project' || { printf 'Remote directory not found or inaccessible: %s\\n' '/srv/my project' >&2; exit 66; }`));
	});

	test('adds a stdin-close watchdog when killOnStdinClose is set', () => {
		const command = buildPosixRemoteExecCommand('kilo', ['serve'], '/srv/app', undefined, { killOnStdinClose: true });
		const script = decodePosixExecCommand(command);
		assert.ok(script.includes(`'kilo' 'serve' </dev/null &`));
		assert.ok(script.includes('_aex_pid=$!'));
		assert.ok(script.includes('exec 3<&0'));
		assert.ok(script.includes(`trap '_aex_cleanup' EXIT TERM INT HUP`));
		assert.ok(script.includes(`_aex_kill_pgid_and_tree`));
		assert.ok(script.includes(`(cat <&3 >/dev/null 2>&1; _aex_cleanup) &`));
		assert.ok(script.includes('wait $_aex_pid'));
		assert.ok(!script.includes(`exec 'kilo'`));
	});
});

describe('buildWindowsRemoteExecCommand', () => {
	test('augments PATH, sets cwd, and quotes the argument array', () => {
		const command = buildWindowsRemoteExecCommand('claude.cmd', ['--foo', `it's`], 'C:\\Work Dir', { MAX_THINKING_TOKENS: '2048' });
		assert.ok(command.startsWith('powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand '));
		const decoded = decodePowerShellCommand(command);
		assert.ok(decoded.includes(`(Join-Path $env:APPDATA 'npm')`));
		assert.ok(decoded.includes('$env:Path = (($_dirs -join \';\') + \';\' + $env:Path)'));
		assert.ok(decoded.includes(`$env:MAX_THINKING_TOKENS = '2048'`));
		assert.ok(decoded.includes(`Set-Location -LiteralPath 'C:\\Work Dir'`));
		assert.ok(decoded.includes(`$_args = @('--foo', 'it''s')`));
		assert.ok(decoded.includes(`& $_exe @_args`));
	});

	test('unwraps npm .cmd Node shims', () => {
		const command = buildWindowsRemoteExecCommand('claude.cmd', ['-p', 'hi']);
		const decoded = decodePowerShellCommand(command);
		assert.ok(decoded.includes(`-match '\\.(cmd|bat)$'`));
		assert.ok(decoded.includes(`'"%(?:~)?dp0%?\\\\([^"]+\\.(?:c|m)?js)"\\s+%\\*'`));
		assert.ok(decoded.includes(`(?:c|m)?js`));
		assert.ok(decoded.includes(`$_sibNode = Join-Path (Split-Path -Parent $_exe) 'node.exe'`));
		assert.ok(decoded.includes(`& $_node $_js @_args; exit $LASTEXITCODE`));
	});

	test('adds a stdin watcher only when killOnStdinClose is set', () => {
		const withoutWatcher = decodePowerShellCommand(buildWindowsRemoteExecCommand('kilo.cmd', ['serve']));
		assert.ok(!withoutWatcher.includes('[Threading.Tasks.Task]::Run'));
		const withWatcher = decodePowerShellCommand(buildWindowsRemoteExecCommand('kilo.cmd', ['serve'], undefined, undefined, { killOnStdinClose: true }));
		assert.ok(withWatcher.includes('[Threading.Tasks.Task]::Run([Action]{'));
		assert.ok(withWatcher.includes('[Diagnostics.Process]::GetCurrentProcess().Kill($true)'));
	});
});

describe('extractForwardableRemoteEnv', () => {
	test('keeps only allowlisted non-empty keys and rejects secrets/ADE control vars', () => {
		const env: NodeJS.ProcessEnv = {
			MAX_THINKING_TOKENS: '4096',
			NO_COLOR: '1',
			TERM: 'xterm-256color',
			CLAUDE_CODE_DISABLE_THINKING: '',
			ANTHROPIC_API_KEY: 'sk-secret',
			OPENAI_API_KEY: 'sk-other',
			AWS_SECRET_ACCESS_KEY: 'aws-secret',
			GITHUB_TOKEN: 'gh-token',
			AEXUS_ADE_TOKEN: 'ade-token',
			AEXUS_ADE_CONTROL_FILE: '/tmp/control',
			AEXUS_ADE_SOCKET: '/tmp/socket',
			AEXUS_ADE_SESSION_TOKEN: 'session-token',
			AEXUS_ADE_CALLER: 'caller',
		};
		assert.deepStrictEqual(extractForwardableRemoteEnv(env), {
			MAX_THINKING_TOKENS: '4096',
			NO_COLOR: '1',
			TERM: 'xterm-256color',
		});
	});

	test('returns an empty object for undefined env', () => {
		assert.deepStrictEqual(extractForwardableRemoteEnv(undefined), {});
	});
});

describe('parseRemoteEngineProbeOutput', () => {
	test('parses OS, HOME, and BIN records', () => {
		const raw = [
			'OS=Darwin',
			'HOME=/Users/dev',
			'BIN:claude=/opt/homebrew/bin/claude',
			'BIN:codex=/usr/local/bin/codex',
			'BIN:pi=',
			'not-a-record',
			'',
		].join('\n');
		assert.deepStrictEqual(parseRemoteEngineProbeOutput(raw, 'linux'), {
			os: 'macos',
			remoteHome: '/Users/dev',
			executables: { claude: '/opt/homebrew/bin/claude', codex: '/usr/local/bin/codex' },
		});
	});

	test('detects Windows and Linux OS values and tolerates CRLF', () => {
		assert.equal(parseRemoteEngineProbeOutput('OS=Windows_NT\r\nHOME=C:\\Users\\dev\r\n', 'linux').os, 'windows');
		assert.equal(parseRemoteEngineProbeOutput('OS=Linux\r\n', 'windows').os, 'linux');
	});

	test('falls back to the supplied OS when no OS record exists', () => {
		assert.deepStrictEqual(parseRemoteEngineProbeOutput('HOME=/root\n', 'macos'), {
			os: 'macos',
			remoteHome: '/root',
			executables: {},
		});
	});
});

describe('clearCloudTransportCaches', () => {
	test('can be called globally or for a single authority', () => {
		assert.doesNotThrow(() => clearCloudTransportCaches());
		assert.doesNotThrow(() => clearCloudTransportCaches('some-host'));
	});
});

describe('Mock-SSH integration', { skip: process.platform === 'win32' ? 'Mock SSH uses POSIX sh.' : false }, () => {
	test('probeRemoteEngines discovers fake remote executables', async () => {
		const binDir = path.join(testRoot, 'probe-bin');
		const fakeClaude = writeExecutable(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');
		writeExecutable(path.join(binDir, 'codex'), '#!/bin/sh\nexit 0\n');

		await withPrependedPath(binDir, async () => {
			clearCloudTransportCaches('mock-probe-host');
			const result = await probeRemoteEngines(makeTarget('mock-probe-host'), true);
			assert.equal(result.ok, true);
			assert.equal(result.executables.claude, fakeClaude);
			assert.ok(result.executables.codex);
			assert.equal(typeof result.checkedAt, 'number');
			assert.ok(result.os === 'linux' || result.os === 'macos');
		});
	});

	test('probeRemoteEngines succeeds with exit 0 even when trailing CLIs (e.g. pi) are not installed', async () => {
		const isolatedHome = path.join(testRoot, 'isolated-home');
		const isolatedBin = path.join(isolatedHome, '.local', 'bin');
		const fakeClaude = writeExecutable(path.join(isolatedBin, 'claude'), '#!/bin/sh\nexit 0\n');
		const prevHome = process.env.HOME;
		const prevPath = process.env.PATH;
		process.env.HOME = isolatedHome;
		process.env.PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
		try {
			clearCloudTransportCaches('mock-sparse-host');
			const result = await probeRemoteEngines(makeTarget('mock-sparse-host'), true);
			assert.equal(result.ok, true);
			assert.equal(result.executables.claude, fakeClaude);
			assert.equal(result.executables.pi, undefined);
		} finally {
			process.env.HOME = prevHome;
			process.env.PATH = prevPath;
		}
	});

	test('probeRemoteEngines honors registered remote CLI path overrides', async () => {
		const overridePath = writeExecutable(path.join(testRoot, 'override-bin', 'claude-custom'), '#!/bin/sh\nexit 0\n');
		registerCloudTransportBridge({
			getConfiguredRemoteCliPaths: () => ({ 'mock-override-host': { claude: overridePath } }),
		});
		try {
			clearCloudTransportCaches('mock-override-host');
			const result = await probeRemoteEngines(makeTarget('mock-override-host'), true);
			assert.equal(result.ok, true);
			assert.equal(result.executables.claude, overridePath);
		} finally {
			registerCloudTransportBridge({});
		}
	});

	test('probeRemoteEngines reports an error result when mock ssh exits non-zero', async () => {
		clearCloudTransportCaches('fail-host');
		const result = await probeRemoteEngines(makeTarget('fail-host'), true);
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /Permission denied/);
		assert.deepStrictEqual(result.executables, {});
	});

	test('clearCloudTransportCaches invalidates the probe cache', async () => {
		const fakeDsh = writeExecutable(path.join(testRoot, 'cache-bin', 'dsh-fake'), '#!/bin/sh\nexit 0\n');
		registerCloudTransportBridge({
			getConfiguredRemoteCliPaths: () => ({ 'mock-cache-host': { dsh: fakeDsh } }),
		});
		try {
			clearCloudTransportCaches('mock-cache-host');
			const first = await probeRemoteEngines(makeTarget('mock-cache-host'));
			assert.equal(first.executables.dsh, fakeDsh);

			const cached = await probeRemoteEngines(makeTarget('mock-cache-host'));
			assert.equal(cached.checkedAt, first.checkedAt);

			fs.rmSync(fakeDsh);
			clearCloudTransportCaches('mock-cache-host');
			await new Promise(resolve => setTimeout(resolve, 10));
			const refreshed = await probeRemoteEngines(makeTarget('mock-cache-host'));
			assert.equal(refreshed.executables.dsh, undefined);
			assert.ok(refreshed.checkedAt > first.checkedAt);
		} finally {
			registerCloudTransportBridge({});
		}
	});

	test('readRemoteTextFile reads UTF-8 content, caches, and reports missing files', async () => {
		const remoteDir = path.join(testRoot, 'remote-files');
		const chinesePath = path.join(remoteDir, '中文.txt');
		fs.mkdirSync(remoteDir, { recursive: true });
		fs.writeFileSync(chinesePath, '你好，远程世界\n第二行\n');

		const target = makeTarget('mock-read-host');
		clearCloudTransportCaches(target.authority);
		const content = await readRemoteTextFile(target, chinesePath);
		assert.equal(content, '你好，远程世界\n第二行\n');

		// Within the cache TTL the previous content is served, and bypassCache forces a fresh read.
		fs.writeFileSync(chinesePath, '更新后的内容\n');
		assert.equal(await readRemoteTextFile(target, chinesePath), '你好，远程世界\n第二行\n');
		assert.equal(await readRemoteTextFile(target, chinesePath, { bypassCache: true }), '更新后的内容\n');

		assert.equal(await readRemoteTextFile(target, path.join(remoteDir, 'missing.txt')), undefined);
	});

	test('readRemoteTextFilesBatch reads multiple files in one round-trip', async () => {
		const remoteDir = path.join(testRoot, 'batch-files');
		fs.mkdirSync(remoteDir, { recursive: true });
		const alpha = path.join(remoteDir, 'alpha.txt');
		const chinese = path.join(remoteDir, '批量.txt');
		const missing = path.join(remoteDir, 'missing.txt');
		fs.writeFileSync(alpha, 'alpha-content');
		fs.writeFileSync(chinese, '中文批量内容✓\n');

		const target = makeTarget('mock-batch-host');
		clearCloudTransportCaches(target.authority);
		const result = await readRemoteTextFilesBatch(target, [alpha, chinese, missing]);
		assert.equal(result.size, 3);
		assert.equal(result.get(alpha), 'alpha-content');
		assert.equal(result.get(chinese), '中文批量内容✓\n');
		assert.equal(result.get(missing), undefined);
	});

	test('stageLocalFileToRemote uploads exact binary bytes', async () => {
		const sourcePath = path.join(testRoot, 'attachment.bin');
		const payload = Buffer.alloc(512);
		for (let i = 0; i < payload.length; i++) {
			payload[i] = i % 256;
		}
		fs.writeFileSync(sourcePath, payload);

		const target = makeTarget('mock-stage-host');
		clearCloudTransportCaches(target.authority);
		const remoteDest = await stageLocalFileToRemote(target, sourcePath);
		assert.ok(remoteDest);
		stagedRemoteFiles.push(remoteDest);
		assert.ok(remoteDest.startsWith('/tmp/aexus-att-'));
		assert.equal(Buffer.compare(fs.readFileSync(remoteDest), payload), 0);

		assert.equal(await stageLocalFileToRemote(target, path.join(testRoot, 'not-there.bin')), undefined);
	});

	test('captureRemoteEngine runs a fake remote CLI inside the remote cwd', async () => {
		const projectDir = path.join(testRoot, 'remote-project');
		fs.mkdirSync(projectDir, { recursive: true });
		const fakeCli = writeExecutable(path.join(testRoot, 'fake-cli', 'fake-remote-cli'), [
			'#!/bin/sh',
			`printf 'PWD=%s\\n' "$(pwd)"`,
			`printf 'ARG1=%s\\n' "$1"`,
			`printf 'ARG2=%s\\n' "$2"`,
			'',
		].join('\n'));

		const target = makeTarget('mock-capture-host');
		clearCloudTransportCaches(target.authority);
		const output = await captureRemoteEngine(target, fakeCli, ['hello', 'wörld'], undefined, projectDir);
		assert.ok(output.includes('ARG1=hello'));
		assert.ok(output.includes('ARG2=wörld'));
		const reportedPwd = /PWD=(.+)/.exec(output)?.[1]?.trim();
		assert.ok(reportedPwd, `Expected a PWD line in: ${output}`);
		assert.equal(fs.realpathSync(reportedPwd), fs.realpathSync(projectDir));
	});

	test('openRemotePortForward proxies HTTP and tears down on dispose', async () => {
		const server = http.createServer((request, response) => {
			response.writeHead(200, { 'content-type': 'text/plain' });
			response.end(`remote-http-ok:${request.url}`);
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const remotePort = (server.address() as net.AddressInfo).port;
		const target = makeTarget('mock-forward-host');

		const forward = await openRemotePortForward(target, remotePort);
		try {
			assert.ok(forward.localPort > 0);
			assert.equal(forward.localUrl, `http://127.0.0.1:${forward.localPort}`);
			const response = await httpGet(`${forward.localUrl}/ping`);
			assert.equal(response.status, 200);
			assert.equal(response.body, 'remote-http-ok:/ping');
		} finally {
			forward.dispose();
		}

		await waitForPortClosed(forward.localPort);
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	});

	test('discoverEngineModels reads remote .claude/settings.json without touching local config', async () => {
		const remoteHome = path.join(testRoot, 'remote-home');
		const projectDir = path.join(testRoot, 'remote-capabilities-project');
		const localHome = path.join(testRoot, 'local-mac-home');
		fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
		fs.mkdirSync(path.join(localHome, '.claude'), { recursive: true });
		fs.mkdirSync(path.join(remoteHome, '.claude'), { recursive: true });
		fs.writeFileSync(path.join(remoteHome, '.claude', 'settings.json'), JSON.stringify({
			model: 'remote-only-model',
			modelPicker: {
				replaceBuiltInOptions: true,
				options: [{ model: 'remote-picker-model', label: 'Remote Picker' }],
			},
		}));
		fs.writeFileSync(path.join(localHome, '.claude', 'settings.json'), JSON.stringify({ model: 'local-mac-model' }));

		const target = makeTarget('mock-capabilities-host', { os: 'linux', remoteHome });
		registerRemoteCapabilitiesReader(readRemoteTextFilesBatch);
		clearCloudTransportCaches(target.authority);

		const previousHome = process.env.HOME;
		process.env.HOME = localHome;
		try {
			const models = await discoverEngineModels('aexus-claude', projectDir, [], undefined, [], target);
			assert.deepStrictEqual(models.map(model => model.id), ['default', 'remote-picker-model', 'remote-only-model']);
			assert.equal(models[1].name, 'Remote Picker');
			assert.equal(models.some(model => model.id === 'local-mac-model'), false);
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
		}
	});
});

describe('Remote SSH Reverse Control Bridge & Remote aexus-ade CLI Staging', { skip: process.platform === 'win32' ? 'POSIX mock ssh.' : false }, () => {
	function sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	async function waitForDeath(pid: number, timeoutMs = 3000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				process.kill(pid, 0);
			} catch {
				return;
			}
			await sleep(25);
		}
		throw new Error(`Mock SSH process ${pid} was still alive ${timeoutMs}ms after dispose().`);
	}

	test('buildPosixPathAugmentSnippet exposes ~/.aexus-code/remote-bin on PATH', () => {
		const snippet = buildPosixPathAugmentSnippet();
		assert.ok(snippet.includes('$HOME/.aexus-code/remote-bin'));
		assert.ok(snippet.includes('export PATH'));
	});

	test('buildWindowsRemoteExecCommand augments PATH with .aexus-code\\remote-bin', () => {
		const command = buildWindowsRemoteExecCommand('aexus-ade.cmd', ['whoami']);
		const decoded = decodePowerShellCommand(command);
		assert.ok(decoded.includes('.aexus-code\\remote-bin'));
	});

	test('openRemoteControlReverseBridge resolves the allocated remote port and tears the tunnel down on dispose', async () => {
		const bridgeDir = path.join(testRoot, 'reverse-bridge');
		fs.mkdirSync(bridgeDir, { recursive: true });
		const argsFile = path.join(bridgeDir, 'ssh-args.log');
		const pidFile = path.join(bridgeDir, 'ssh.pid');
		const mockSsh = writeExecutable(path.join(bridgeDir, 'mock-ssh.sh'), [
			'#!/bin/sh',
			`printf '%s\\n' "$@" > "${argsFile}"`,
			`printf '%s\\n' "$$" > "${pidFile}"`,
			`printf 'Allocated port 45678 for remote forward to 127.0.0.1:12345\\n' >&2`,
			'exec sleep 600',
			'',
		].join('\n'));
		const target = makeTarget('mock-reverse-host', { sshExecutable: mockSsh });
		clearCloudTransportCaches(target.authority);

		const handle = await openRemoteControlReverseBridge(target, 12345, { timeoutMs: 5000 });
		let pid: number | undefined;
		try {
			assert.strictEqual(handle.remotePort, 45678);
			assert.strictEqual(handle.localPort, 12345);
			assert.strictEqual(handle.isAlive(), true);

			const loggedArgs = fs.readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);
			assert.ok(loggedArgs.includes('-N'), loggedArgs.join(' '));
			assert.ok(loggedArgs.includes('-R'), loggedArgs.join(' '));
			assert.ok(loggedArgs.includes('127.0.0.1:0:127.0.0.1:12345'), loggedArgs.join(' '));

			pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
			assert.ok(Number.isInteger(pid) && pid > 0, `Expected a mock SSH PID, got ${pid}.`);
		} finally {
			handle.dispose();
		}

		assert.strictEqual(handle.isAlive(), false);
		assert.ok(pid);
		await waitForDeath(pid);
	});

	test('stageRemoteAdeCliShim runs the staging script once and caches by file hash', async () => {
		const stageDir = path.join(testRoot, 'stage-cli');
		const homeDir = path.join(stageDir, 'home');
		const logFile = path.join(stageDir, 'ssh.log');
		fs.mkdirSync(homeDir, { recursive: true });
		// Emulates `ssh -- <alias> <remoteCommand>`: logs the invocation and executes the
		// remote command locally with the piped stdin (the adeCli.js bundle).
		const mockSsh = writeExecutable(path.join(stageDir, 'mock-ssh.sh'), [
			'#!/bin/sh',
			`printf 'INVOKE\\n' >> "${logFile}"`,
			`printf '%s\\n' "$@" >> "${logFile}"`,
			'remote=""',
			'seen=0',
			'for a in "$@"; do',
			'  case "$seen" in',
			'    0) if [ "$a" = "--" ]; then seen=1; fi ;;',
			'    1) seen=2 ;;',
			'    2) remote="$a"; seen=3 ;;',
			'  esac',
			'done',
			'exec sh -c "$remote"',
			'',
		].join('\n'));
		const payload = Buffer.from('\'use strict\';\nconsole.log(\'aexus-ade\');\n');
		const localAdeCliJs = path.join(stageDir, 'adeCli.js');
		fs.writeFileSync(localAdeCliJs, payload);

		const target = makeTarget('mock-stage-cli-host', { sshExecutable: mockSsh, os: 'linux' });
		clearCloudTransportCaches(target.authority);
		const previousHome = process.env.HOME;
		process.env.HOME = homeDir;
		try {
			const remoteBinDir = await stageRemoteAdeCliShim(target, localAdeCliJs);
			const expectedDir = path.join(homeDir, '.aexus-code', 'remote-bin');
			assert.strictEqual(remoteBinDir, expectedDir);

			const files = fs.readdirSync(expectedDir);
			const bundleName = files.find(file => /^adeCli\.[0-9a-f]{12}\.js$/.test(file));
			assert.ok(bundleName, `Expected a hashed adeCli bundle, got: ${files.join(', ')}`);
			assert.equal(fs.readFileSync(path.join(expectedDir, bundleName), 'utf8'), payload.toString());

			const shimPath = path.join(expectedDir, 'aexus-ade');
			assert.ok(fs.existsSync(shimPath), 'Expected the aexus-ade shim wrapper.');
			assert.doesNotThrow(() => fs.accessSync(shimPath, fs.constants.X_OK));
			assert.ok(fs.readFileSync(shimPath, 'utf8').includes(`exec node "${path.join(expectedDir, bundleName)}" "$@"`));

			// Same file hash => second call is served from cache without another SSH round-trip.
			fs.rmSync(expectedDir, { recursive: true, force: true });
			assert.strictEqual(await stageRemoteAdeCliShim(target, localAdeCliJs), expectedDir);
			assert.strictEqual(fs.existsSync(expectedDir), false);
			const invocations = fs.readFileSync(logFile, 'utf8').split('\n').filter(line => line === 'INVOKE').length;
			assert.strictEqual(invocations, 1);
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
		}
	});

	test('extractForwardableRemoteEnv still strips AEXUS_ADE_SESSION_TOKEN and AEXUS_ADE_TCP_PORT', () => {
		assert.deepStrictEqual(extractForwardableRemoteEnv({
			AEXUS_ADE_SESSION_TOKEN: 'aexus-cap.fake.sig',
			AEXUS_ADE_TCP_PORT: '45678',
			AEXUS_ADE_REMOTE_BRIDGE_PORT: '45678',
			AEXUS_ADE_CALLER: 'employee',
			NO_COLOR: '1',
		}), { NO_COLOR: '1' });
	});
});

// `spawnRemoteEngine` hardcodes `path.join(__dirname, 'engineProcess.js')`, and the compiled launcher only exists in
// `dist/` (it is not emitted next to `src/*.ts` when running under `--experimental-strip-types`). These tests therefore
// exercise the exact remote command that `spawnRemoteEngine` feeds to SSH — `buildPosixRemoteExecCommand` — through the
// same POSIX mock SSH transport, covering bidirectional NDJSON stdio and the stdin-close watchdog end to end.
describe('Remote engine stdio transport over mock SSH', { skip: process.platform === 'win32' ? 'Mock SSH uses POSIX sh.' : false }, () => {
	function spawnMockRemoteShell(alias: string, remoteCommand: string): cp.ChildProcessWithoutNullStreams {
		return cp.spawn(mockSshPath, ['-T', '-o', 'BatchMode=yes', '--', alias, remoteCommand], {
			stdio: ['pipe', 'pipe', 'pipe'],
		}) as cp.ChildProcessWithoutNullStreams;
	}

	function readLines(stream: NodeJS.ReadableStream): { next: (timeoutMs?: number) => Promise<string> } {
		let buffer = '';
		const pending: string[] = [];
		const waiters: Array<(line: string) => void> = [];
		stream.setEncoding('utf8');
		stream.on('data', (chunk: string) => {
			buffer += chunk;
			let index: number;
			while ((index = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (!line.trim()) {
					continue;
				}
				const waiter = waiters.shift();
				if (waiter) {
					waiter(line);
				} else {
					pending.push(line);
				}
			}
		});
		return {
			next: (timeoutMs = 5000) => new Promise<string>((resolve, reject) => {
				const queued = pending.shift();
				if (queued !== undefined) {
					resolve(queued);
					return;
				}
				const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for remote output.`)), timeoutMs);
				waiters.push(line => {
					clearTimeout(timer);
					resolve(line);
				});
			}),
		};
	}

	function waitForExit(child: cp.ChildProcess, timeoutMs = 5000): Promise<number | null> {
		return new Promise((resolve, reject) => {
			if (child.exitCode !== null) {
				resolve(child.exitCode);
				return;
			}
			const timer = setTimeout(() => {
				child.kill('SIGKILL');
				reject(new Error(`Remote SSH child did not exit within ${timeoutMs}ms.`));
			}, timeoutMs);
			child.once('exit', code => {
				clearTimeout(timer);
				resolve(code);
			});
		});
	}

	function isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === 'EPERM';
		}
	}

	async function waitForPidFile(pidFile: string, timeoutMs = 5000): Promise<number> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const raw = fs.readFileSync(pidFile, 'utf8').trim();
				if (raw) {
					return Number(raw);
				}
			} catch {
				// Not written yet.
			}
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		throw new Error(`Remote child never wrote its PID to ${pidFile}.`);
	}

	async function waitForProcessDeath(pid: number, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!isProcessAlive(pid)) {
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		throw new Error(`Remote child PID ${pid} was still alive ${timeoutMs}ms after SSH stdin closed.`);
	}

	test('streams NDJSON line-by-line both directions while the remote engine runs inside the remote project cwd', async () => {
		const projectDir = path.join(testRoot, 'remote-stream-project');
		const engineScript = path.join(testRoot, 'remote-stream-engine.js');
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(engineScript, [
			`'use strict';`,
			`let buffer = '';`,
			`process.stdin.setEncoding('utf8');`,
			`process.stdin.on('data', chunk => {`,
			`	buffer += chunk;`,
			`	let index;`,
			`	while ((index = buffer.indexOf('\\n')) !== -1) {`,
			`		const line = buffer.slice(0, index).trim();`,
			`		buffer = buffer.slice(index + 1);`,
			`		if (!line) { continue; }`,
			`		const received = JSON.parse(line);`,
			`		process.stdout.write(JSON.stringify({ cwd: process.cwd(), received }) + '\\n');`,
			`	}`,
			`});`,
			`process.stdin.on('end', () => process.exit(0));`,
			``,
		].join('\n'));

		const remoteCommand = buildPosixRemoteExecCommand(process.execPath, [engineScript], projectDir);
		const child = spawnMockRemoteShell('mock-stream-host', remoteCommand);
		let stderr = '';
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', chunk => { stderr += chunk; });
		const lines = readLines(child.stdout);

		try {
			const messages = [
				{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'ade-test' } } },
				{ jsonrpc: '2.0', id: 2, method: 'prompt', params: { text: 'echo 你好' } },
			];
			for (const message of messages) {
				child.stdin.write(`${JSON.stringify(message)}\n`);
			}

			const replies: Array<{ cwd: string; received: unknown }> = [];
			for (let i = 0; i < messages.length; i++) {
				replies.push(JSON.parse(await lines.next()));
			}

			assert.equal(fs.realpathSync(replies[0].cwd), fs.realpathSync(projectDir));
			assert.deepStrictEqual(replies.map(reply => reply.received), messages);
			assert.equal(fs.realpathSync(replies[1].cwd), fs.realpathSync(projectDir));
		} catch (error) {
			throw new Error(`${(error as Error).message}\nRemote stderr: ${stderr}`);
		} finally {
			child.stdin.end();
		}

		const exitCode = await waitForExit(child);
		assert.equal(exitCode, 0, `Remote engine exited with ${exitCode}. stderr: ${stderr}`);
	});

	test('killOnStdinClose watchdog terminates the remote child process when SSH stdin closes', async () => {
		const projectDir = path.join(testRoot, 'remote-watchdog-project');
		const engineScript = path.join(testRoot, 'remote-watchdog-server.js');
		const pidFile = path.join(testRoot, 'remote-watchdog.pid');
		fs.mkdirSync(projectDir, { recursive: true });
		fs.rmSync(pidFile, { force: true });
		fs.writeFileSync(engineScript, [
			`'use strict';`,
			`const fs = require('node:fs');`,
			`fs.writeFileSync(process.argv[2], String(process.pid));`,
			`const timer = setInterval(() => { }, 1000);`,
			`const stop = () => { clearInterval(timer); process.exit(0); };`,
			`process.on('SIGTERM', stop);`,
			`process.on('SIGINT', stop);`,
			``,
		].join('\n'));

		const remoteCommand = buildPosixRemoteExecCommand(process.execPath, [engineScript, pidFile], projectDir, undefined, { killOnStdinClose: true });
		const child = spawnMockRemoteShell('mock-watchdog-host', remoteCommand);
		let stderr = '';
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', chunk => { stderr += chunk; });

		const pid = await waitForPidFile(pidFile).catch((error: Error) => {
			throw new Error(`${error.message}\nRemote stderr: ${stderr}`);
		});
		assert.equal(isProcessAlive(pid), true, `Remote child PID ${pid} should be running before stdin closes.`);

		// Closing SSH stdin must trip the POSIX watchdog and kill the long-lived remote server (no zombie remote processes).
		child.stdin.end();
		try {
			await waitForProcessDeath(pid, 3000);
		} catch (error) {
			throw new Error(`${(error as Error).message}\nRemote stderr: ${stderr}`);
		}
		await waitForExit(child);
	});

	test('persistentSessionId survives abrupt SSH client disconnect and supports lossless byte-offset reattach', async () => {
		const projectDir = path.join(testRoot, 'remote-persist-project');
		const sessionBaseDir = path.join(testRoot, 'remote-persist-sessions');
		const engineScript = path.join(testRoot, 'remote-persist-worker.js');
		const pidFile = path.join(testRoot, 'remote-persist.pid');
		const doneFile = path.join(testRoot, 'remote-persist.done');
		fs.mkdirSync(projectDir, { recursive: true });
		fs.mkdirSync(sessionBaseDir, { recursive: true });
		fs.rmSync(pidFile, { force: true });
		fs.rmSync(doneFile, { force: true });
		fs.writeFileSync(engineScript, [
			`'use strict';`,
			`const fs = require('node:fs');`,
			`fs.writeFileSync(process.argv[2], String(process.pid));`,
			`process.stdout.write(JSON.stringify({ seq: 1, status: 'started' }) + '\\n');`,
			`setTimeout(() => {`,
			`  process.stdout.write(JSON.stringify({ seq: 2, status: 'completed' }) + '\\n');`,
			`  fs.writeFileSync(process.argv[3], 'finished-ok');`,
			`  process.exit(0);`,
			`}, 900);`,
			``,
		].join('\n'));

		const sessionId = `persist-test-${Date.now()}`;
		const envOverride = { AEXUS_REMOTE_SESSION_DIR: sessionBaseDir };
		const initialCmd = buildPosixRemoteExecCommand(
			process.execPath,
			[engineScript, pidFile, doneFile],
			projectDir,
			envOverride,
			{ persistentSessionId: sessionId, attachByteOffset: 0 },
		);
		const firstSsh = spawnMockRemoteShell('mock-persist-host', initialCmd);
		let firstStdout = '';
		firstSsh.stdout.setEncoding('utf8');
		const firstLineReceived = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timed out waiting for seq=1. stdout=${firstStdout}`)), 5000);
			firstSsh.stdout.on('data', chunk => {
				firstStdout += chunk;
				if (firstStdout.includes('"seq":1')) {
					clearTimeout(timer);
					resolve();
				}
			});
		});

		await firstLineReceived;
		const remotePid = await waitForPidFile(pidFile);
		assert.equal(isProcessAlive(remotePid), true, 'Remote persistent worker PID should be alive');

		// Simulate abrupt laptop sleep / Wi-Fi drop (sshd sends SIGHUP/SIGTERM to the attach shell while the detached tmux/nohup worker stays alive!)
		firstSsh.kill('SIGHUP');
		await waitForExit(firstSsh);

		// Wait briefly and verify the remote worker survived SSH disconnect and completed its work!
		await new Promise(resolve => setTimeout(resolve, 1100));
		assert.equal(fs.existsSync(doneFile), true, 'Remote persistent worker MUST survive SSH disconnect and finish writing doneFile');
		assert.equal(fs.readFileSync(doneFile, 'utf8'), 'finished-ok');

		// Reattach using attachByteOffset equal to already-received bytes -> receives ONLY seq:2 with exit code 0!
		const byteOffset = Buffer.byteLength(firstStdout, 'utf8');
		const reattachCmd = buildPosixRemoteExecCommand(
			process.execPath,
			[engineScript, pidFile, doneFile],
			projectDir,
			envOverride,
			{ persistentSessionId: sessionId, attachByteOffset: byteOffset },
		);
		const secondSsh = spawnMockRemoteShell('mock-persist-host', reattachCmd);
		let reattachStdout = '';
		let reattachStderr = '';
		secondSsh.stdout.setEncoding('utf8');
		secondSsh.stderr.setEncoding('utf8');
		secondSsh.stdout.on('data', chunk => { reattachStdout += chunk; });
		secondSsh.stderr.on('data', chunk => { reattachStderr += chunk; });

		const exitCode = await waitForExit(secondSsh);
		assert.equal(exitCode, 0, `Reattach exited with ${exitCode}. stderr=${reattachStderr}`);
		assert.equal(reattachStdout.includes('"seq":1'), false, `Reattach must not replay seq:1 (got: ${reattachStdout})`);
		assert.equal(reattachStdout.includes('"seq":2'), true, `Reattach must deliver seq:2 (got: ${reattachStdout})`);
	});

	test('terminateRemotePersistentSession (killTree: true) kills parent agent AND nested grandchild GPU-style workers with zero zombies', async () => {
		const projectDir = path.join(testRoot, 'remote-killtree-project');
		const sessionBaseDir = path.join(testRoot, 'remote-killtree-sessions');
		const agentScript = path.join(testRoot, 'mock-tree-agent.cjs');
		const parentPidFile = path.join(testRoot, 'tree-parent.pid');
		const childPidFile = path.join(testRoot, 'tree-child.pid');
		const grandPidFile = path.join(testRoot, 'tree-grand.pid');
		fs.mkdirSync(projectDir, { recursive: true });
		fs.mkdirSync(sessionBaseDir, { recursive: true });
		for (const f of [parentPidFile, childPidFile, grandPidFile]) {
			fs.rmSync(f, { force: true });
		}
		// Parent spawns a child, which spawns a grandchild ignoring SIGHUP (simulating a cloud GPU trainer).
		const childScript = path.join(testRoot, 'mock-tree-child.cjs');
		const grandScript = path.join(testRoot, 'mock-tree-grand.cjs');
		fs.writeFileSync(grandScript, [
			`'use strict';`,
			`const fs = require('node:fs');`,
			`process.on('SIGHUP', () => {});`,
			`fs.writeFileSync(process.argv[2], String(process.pid));`,
			`setInterval(() => {}, 1000);`,
		].join('\n'));
		fs.writeFileSync(childScript, [
			`'use strict';`,
			`const cp = require('node:child_process');`,
			`const fs = require('node:fs');`,
			`process.on('SIGHUP', () => {});`,
			`fs.writeFileSync(process.argv[2], String(process.pid));`,
			`cp.spawn(process.execPath, [process.argv[3], process.argv[4]], { stdio: 'ignore' });`,
			`setInterval(() => {}, 1000);`,
		].join('\n'));
		fs.writeFileSync(agentScript, [
			`'use strict';`,
			`const cp = require('node:child_process');`,
			`const fs = require('node:fs');`,
			`fs.writeFileSync(process.argv[2], String(process.pid));`,
			`cp.spawn(process.execPath, [process.argv[3], process.argv[4], process.argv[5], process.argv[6]], { stdio: 'ignore' });`,
			`setInterval(() => {}, 1000);`,
		].join('\n'));

		const sessionId = `${buildRemotePersistentPrefix('claude', 'sess-tree-kill-1')}-deadbeef`;
		const prevSessionDir = process.env.AEXUS_REMOTE_SESSION_DIR;
		process.env.AEXUS_REMOTE_SESSION_DIR = sessionBaseDir;
		const cmd = buildPosixRemoteExecCommand(
			process.execPath,
			[agentScript, parentPidFile, childScript, childPidFile, grandScript, grandPidFile],
			projectDir,
			{ AEXUS_REMOTE_SESSION_DIR: sessionBaseDir },
			{ persistentSessionId: sessionId, attachByteOffset: 0 },
		);
		const sshProc = spawnMockRemoteShell('mock-tree-host', cmd);
		try {
			const parentPid = await waitForPidFile(parentPidFile);
			const childPid = await waitForPidFile(childPidFile);
			const grandPid = await waitForPidFile(grandPidFile);
			assert.equal(isProcessAlive(parentPid), true);
			assert.equal(isProcessAlive(childPid), true);
			assert.equal(isProcessAlive(grandPid), true);

			// Verify inspect sees the live session by deterministic prefix.
			const target = makeTarget('mock-tree-host');
			const inspected = await inspectRemotePersistentSessionsByPrefix(target, buildRemotePersistentPrefix('claude', 'sess-tree-kill-1'));
			assert.equal(inspected.length, 1);
			assert.equal(inspected[0].alive, true);
			assert.equal(inspected[0].id, sessionId);

			// Simulate Recall / Stop: terminate ENTIRE process group + descendants!
			await terminateRemotePersistentSession(target, sessionId, { killTree: true });

			await waitForProcessDeath(parentPid, 4000);
			await waitForProcessDeath(childPid, 4000);
			await waitForProcessDeath(grandPid, 4000);
			assert.equal(isProcessAlive(parentPid), false, 'parent agent must be dead');
			assert.equal(isProcessAlive(childPid), false, 'child process must be dead (no zombie)');
			assert.equal(isProcessAlive(grandPid), false, 'grandchild GPU-style worker must be dead (no zombie)');
			assert.equal(fs.existsSync(path.join(sessionBaseDir, sessionId)), false, 'session dir must be cleaned up');
		} finally {
			sshProc.kill('SIGKILL');
			await waitForExit(sshProc);
			if (prevSessionDir === undefined) {
				delete process.env.AEXUS_REMOTE_SESSION_DIR;
			} else {
				process.env.AEXUS_REMOTE_SESSION_DIR = prevSessionDir;
			}
		}
	});

	test('terminateRemotePersistentSessionsByPrefix kills orphaned post-reload remote sessions without knowing random turn suffix', async () => {
		const projectDir = path.join(testRoot, 'remote-prefix-project');
		const sessionBaseDir = path.join(testRoot, 'remote-prefix-sessions');
		const agentScript = path.join(testRoot, 'mock-prefix-agent.cjs');
		const parentPidFile = path.join(testRoot, 'prefix-parent.pid');
		const childPidFile = path.join(testRoot, 'prefix-child.pid');
		fs.mkdirSync(projectDir, { recursive: true });
		fs.mkdirSync(sessionBaseDir, { recursive: true });
		fs.rmSync(parentPidFile, { force: true });
		fs.rmSync(childPidFile, { force: true });
		fs.writeFileSync(agentScript, [
			`'use strict';`,
			`const cp = require('node:child_process');`,
			`const fs = require('node:fs');`,
			`fs.writeFileSync(process.argv[2], String(process.pid));`,
			`cp.spawn(process.execPath, ['-e', \`const fs=require('node:fs'); fs.writeFileSync(\${JSON.stringify(process.argv[3])},String(process.pid)); setInterval(()=>{},1000);\`], { stdio: 'ignore' });`,
			`setInterval(() => {}, 1000);`,
		].join('\n'));

		const prefix = buildRemotePersistentPrefix('codex', 'session-reloaded-99');
		const fullId = `${prefix}-9988aabb`;
		const prevSessionDir = process.env.AEXUS_REMOTE_SESSION_DIR;
		process.env.AEXUS_REMOTE_SESSION_DIR = sessionBaseDir;
		const cmd = buildPosixRemoteExecCommand(
			process.execPath,
			[agentScript, parentPidFile, childPidFile],
			projectDir,
			{ AEXUS_REMOTE_SESSION_DIR: sessionBaseDir },
			{ persistentSessionId: fullId, attachByteOffset: 0 },
		);
		const sshProc = spawnMockRemoteShell('mock-prefix-host', cmd);
		try {
			const parentPid = await waitForPidFile(parentPidFile);
			const childPid = await waitForPidFile(childPidFile);
			// Drop the original SSH client (simulating window reload)
			sshProc.kill('SIGKILL');
			await waitForExit(sshProc);
			assert.equal(isProcessAlive(parentPid), true, 'remote agent survives window reload');
			assert.equal(isProcessAlive(childPid), true, 'remote child survives window reload');

			// Reloaded window only knows (engine, sessionId) -> deterministic prefix kills BOTH!
			const target = makeTarget('mock-prefix-host');
			await terminateRemotePersistentSessionsByPrefix(target, prefix, { killTree: true });

			await waitForProcessDeath(parentPid, 4000);
			await waitForProcessDeath(childPid, 4000);
			assert.equal(isProcessAlive(parentPid), false);
			assert.equal(isProcessAlive(childPid), false);
		} finally {
			if (prevSessionDir === undefined) {
				delete process.env.AEXUS_REMOTE_SESSION_DIR;
			} else {
				process.env.AEXUS_REMOTE_SESSION_DIR = prevSessionDir;
			}
		}
	});

	test('attachOnly exits with code 44 when no remote persistent session exists and notifySystemResume fires listeners', async () => {
		const sessionBaseDir = path.join(testRoot, 'remote-attachonly-sessions');
		fs.mkdirSync(sessionBaseDir, { recursive: true });
		const attachCmd = buildPosixRemoteExecCommand(
			process.execPath,
			['-e', 'process.exit(0)'],
			testRoot,
			{ AEXUS_REMOTE_SESSION_DIR: sessionBaseDir },
			{ persistentSessionId: 'nonexistent-attachonly-session', attachOnly: true },
		);
		const proc = spawnMockRemoteShell('mock-attachonly-host', attachCmd);
		const code = await waitForExit(proc);
		assert.equal(code, 44, 'attachOnly must exit 44 when session does not exist instead of spawning a new process');

		let resumeCount = 0;
		const sub = onSystemResume(() => { resumeCount++; });
		notifySystemResume();
		sub.dispose();
		notifySystemResume();
		assert.equal(resumeCount, 1, 'onSystemResume notifies active listeners once and respects dispose');
	});
});

describe('project slug encoding & resolveRemoteRealpath', () => {
	test('encodeClaudeProjectSlug matches Claude Code canonical project directory slugs', () => {
		assert.equal(encodeClaudeProjectSlug('/home/djf/develop/aexus-ide-cloud-exp'), '-home-djf-develop-aexus-ide-cloud-exp');
		assert.equal(encodeClaudeProjectSlug('/home/djf/develop/aexus-ide-cloud-exp/'), '-home-djf-develop-aexus-ide-cloud-exp');
		assert.equal(encodeClaudeProjectSlug('/home/djf/develop/.cloudhosts-agent-qa'), '-home-djf-develop--cloudhosts-agent-qa');
		assert.equal(encodeClaudeProjectSlug('/home/djf/work_dir/v1.2'), '-home-djf-work-dir-v1-2');
		assert.equal(encodeClaudeProjectSlug('C:\\Users\\dev\\my_app\\'), 'C--Users-dev-my-app');
	});

	test('encodePiProjectSlug matches Pi canonical session directory slugs', () => {
		assert.equal(encodePiProjectSlug('/home/djf/develop/aexus-ide-cloud-exp'), '--home-djf-develop-aexus-ide-cloud-exp--');
		assert.equal(encodePiProjectSlug('/home/djf/develop/aexus-ide-cloud-exp/'), '--home-djf-develop-aexus-ide-cloud-exp--');
		assert.equal(encodePiProjectSlug('/home/djf/develop/.cloudhosts-agent-qa'), '--home-djf-develop-.cloudhosts-agent-qa--');
	});

	test('resolveRemoteRealpath resolves symlinks over SSH and caches result', async () => {
		const realDir = path.join(testRoot, 'real-cloud-proj');
		const linkDir = path.join(testRoot, 'link-cloud-proj');
		fs.mkdirSync(realDir, { recursive: true });
		fs.rmSync(linkDir, { force: true });
		fs.symlinkSync(realDir, linkDir);

		const target = makeTarget('mock-realpath-host');
		const resolved = await resolveRemoteRealpath(target, linkDir);
		assert.equal(resolved, fs.realpathSync(realDir));
	});
});

describe('zero-drift remote control reverse bridge (UDS + atomic metadata fallback)', () => {
	test('ensureRemoteControlReverseBridge opens fixed-path UDS reverse tunnel and writes remote bridge metadata on POSIX', async () => {
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-uds-'));
		const localServer = net.createServer(socket => {
			socket.once('data', data => {
				socket.end(`echo:${data.toString('utf8').trim()}\n`);
			});
		});
		await new Promise<void>(resolve => localServer.listen(0, '127.0.0.1', resolve));
		const localPort = (localServer.address() as net.AddressInfo).port;
		try {
			const target = makeTarget('mock-uds-bridge', { remoteHome: fakeHome });
			const handle = await ensureRemoteControlReverseBridge(target, localPort);
			assert.ok(handle.remoteSocketPath, 'POSIX reverse bridge must use fixed remote Unix Domain Socket');
			assert.ok(handle.remoteBridgeMetaPath, 'Bridge must record atomic remote metadata pointer path');
			assert.equal(fs.existsSync(handle.remoteBridgeMetaPath!), true, 'ade-remote-bridge.json must exist on remote host');

			const meta = JSON.parse(fs.readFileSync(handle.remoteBridgeMetaPath!, 'utf8')) as {
				socketPath?: string;
				tcpPort?: number;
				updatedAt?: number;
			};
			assert.equal(meta.socketPath, handle.remoteSocketPath);
			assert.equal(meta.tcpPort, undefined);
			assert.ok(typeof meta.updatedAt === 'number' && meta.updatedAt > 0);

			// Verify end-to-end traffic flows through the fixed UDS socket to localPort!
			const reply = await new Promise<string>((resolve, reject) => {
				const client = net.createConnection({ path: handle.remoteSocketPath! }, () => {
					client.write('hello-uds\n');
				});
				let out = '';
				client.setEncoding('utf8');
				client.on('data', chunk => { out += chunk; });
				client.on('end', () => resolve(out.trim()));
				client.on('error', reject);
			});
			assert.equal(reply, 'echo:hello-uds');
		} finally {
			disposeAllRemoteControlBridges();
			await new Promise<void>(resolve => localServer.close(() => resolve()));
			fs.rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	test('ensureRemoteControlReverseBridge falls back to TCP + updates atomic metadata when sshd forbids StreamLocal forwarding', async () => {
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-tcp-'));
		const localServer = net.createServer(socket => {
			socket.once('data', data => {
				socket.end(`tcp-echo:${data.toString('utf8').trim()}\n`);
			});
		});
		await new Promise<void>(resolve => localServer.listen(0, '127.0.0.1', resolve));
		const localPort = (localServer.address() as net.AddressInfo).port;
		try {
			const target = makeTarget('no-uds-host-1', { remoteHome: fakeHome });
			const handle = await ensureRemoteControlReverseBridge(target, localPort);
			assert.equal(handle.remoteSocketPath, undefined, 'Fallback bridge should use TCP when sshd forbids UDS');
			assert.ok(handle.remotePort > 0, 'Fallback bridge must bind a valid TCP port');
			assert.ok(handle.remoteBridgeMetaPath && fs.existsSync(handle.remoteBridgeMetaPath));

			const meta = JSON.parse(fs.readFileSync(handle.remoteBridgeMetaPath!, 'utf8')) as {
				tcpPort?: number;
				socketPath?: string;
				updatedAt?: number;
			};
			assert.equal(meta.tcpPort, handle.remotePort);
			assert.equal(meta.socketPath, undefined);
			assert.ok(typeof meta.updatedAt === 'number' && meta.updatedAt > 0);

			const reply = await new Promise<string>((resolve, reject) => {
				const client = net.createConnection({ host: '127.0.0.1', port: handle.remotePort }, () => {
					client.write('hello-tcp\n');
				});
				let out = '';
				client.setEncoding('utf8');
				client.on('data', chunk => { out += chunk; });
				client.on('end', () => resolve(out.trim()));
				client.on('error', reject);
			});
			assert.equal(reply, 'tcp-echo:hello-tcp');
		} finally {
			disposeAllRemoteControlBridges();
			await new Promise<void>(resolve => localServer.close(() => resolve()));
			fs.rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	test('ensureRemoteControlReverseBridge does not falsely succeed on slow (>550ms) SSH handshake when UDS forwarding fails afterwards', async () => {
		const slowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-slow-ssh-'));
		const fakeHome = path.join(slowDir, 'home');
		fs.mkdirSync(fakeHome, { recursive: true });
		// Simulate high-latency SSH handshake (600ms > legacy 450ms timer) that rejects UDS StreamLocal forwarding
		// after 600ms, while succeeding on dynamic TCP -R forwarding.
		const slowSsh = writeExecutable(path.join(slowDir, 'slow-ssh.cjs'), `#!/usr/bin/env node
'use strict';
const cp = require('node:child_process');
const net = require('node:net');
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const tail = sep >= 0 ? argv.slice(sep + 1) : [];
const remoteCmd = tail[1];
const rIdx = argv.indexOf('-R');
if (rIdx !== -1 && argv.includes('-N')) {
	const spec = argv[rIdx + 1] || '';
	if (spec.startsWith('/')) {
		setTimeout(() => {
			process.stderr.write('Warning: remote port forwarding failed for listen path ' + spec + '\\n');
			process.exit(255);
		}, 600);
	} else {
		const m = /^127\\.0\\.0\\.1:(\\d+):127\\.0\\.0\\.1:(\\d+)$/.exec(spec);
		const srv = net.createServer(c => {
			const up = net.createConnection({ host: '127.0.0.1', port: Number(m[2]) });
			c.pipe(up); up.pipe(c);
			c.on('error', () => up.destroy());
			up.on('error', () => c.destroy());
		});
		setTimeout(() => {
			srv.listen(Number(m[1]), '127.0.0.1', () => {
				const port = srv.address().port;
				process.stderr.write('Allocated port ' + port + ' for remote forward to 127.0.0.1:' + m[2] + '\\n');
			});
		}, 150);
		process.on('SIGTERM', () => srv.close(() => process.exit(0)));
	}
} else {
	const child = cp.spawn('sh', ['-c', remoteCmd], { stdio: 'inherit' });
	child.on('exit', code => process.exit(code ?? 1));
}
`);
		const localServer = net.createServer(socket => {
			socket.once('data', d => socket.end(`ok:${d.toString('utf8').trim()}\n`));
		});
		await new Promise<void>(resolve => localServer.listen(0, '127.0.0.1', resolve));
		const localPort = (localServer.address() as net.AddressInfo).port;
		try {
			const target = makeTarget('slow-no-uds-host', { sshExecutable: slowSsh, remoteHome: fakeHome });
			const handle = await ensureRemoteControlReverseBridge(target, localPort);
			assert.equal(handle.remoteSocketPath, undefined, 'Must NOT falsely report UDS ready at 450ms when sshd rejects UDS at 600ms');
			assert.ok(handle.remotePort > 0, 'Must cleanly fall back to verified TCP reverse port');

			// Also verify openRemoteControlReverseBridge rejects (instead of resolving dead UDS with 0) when UDS hangs past timeoutMs without __AEX_BRIDGE_READY__ (#67 P1-3)
			const hangSsh = writeExecutable(path.join(slowDir, 'hang-ssh'), '#!/bin/sh\nsleep 5\n');
			const hangTarget = makeTarget('hang-uds-host', { sshExecutable: hangSsh, remoteHome: fakeHome });
			await assert.rejects(
				() => openRemoteControlReverseBridge(hangTarget, localPort, { remoteSocketPath: path.join(fakeHome, 'dead.sock'), timeoutMs: 120 }),
				/Timed out establishing SSH reverse control bridge/,
			);
		} finally {
			disposeAllRemoteControlBridges();
			await new Promise<void>(resolve => localServer.close(() => resolve()));
			fs.rmSync(slowDir, { recursive: true, force: true });
		}
	});
});
