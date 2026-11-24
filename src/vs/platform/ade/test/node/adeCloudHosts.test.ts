/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	formatLiveRemoteDirInput,
	parseLiveRemotePathInput,
	resolveAdeOsIconKind,
	resolveInitialCloudHostDirectory,
} from '../../common/adeCloudHosts.js';

suite('parseLiveRemotePathInput', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses Windows live path input across drive roots, parent folders, backslashes, and tilde', () => {
		const parse = (input: string, remoteHome?: string) => parseLiveRemotePathInput(input, 'windows', remoteHome);

		assert.deepStrictEqual({
			trailingSlashAfterUserFolder: parse('/C:/Users/djf/'),
			backspaceToUserFolder: parse('/C:/Users/djf'),
			backspaceToUsersFolder: parse('/C:/'),
			backspaceToDrive: parse('/C:'),
			backspaceToRoot: parse('/'),
			backslashInput: parse('C:\\Users\\djf\\'),
			bareDrive: parse('C:'),
			tildeWithoutHome: parse('~'),
			tildeFolderWithoutHome: parse('~/work'),
			tildeWithWindowsHome: parse('~', 'C:\\Users\\djf'),
			tildeFolderWithWindowsHome: parse('~/work', 'C:\\Users\\djf'),
		}, {
			trailingSlashAfterUserFolder: {
				browseDir: '/C:/Users/djf',
				filterPrefix: '',
				targetPath: '/C:/Users/djf',
				parentDir: '/C:/Users',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			backspaceToUserFolder: {
				browseDir: '/C:/Users',
				filterPrefix: 'djf',
				targetPath: '/C:/Users/djf',
				parentDir: '/C:',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			backspaceToUsersFolder: {
				browseDir: '/C:',
				filterPrefix: '',
				targetPath: '/C:',
				parentDir: '/',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			backspaceToDrive: {
				browseDir: '/',
				filterPrefix: 'C',
				targetPath: '/C:',
				parentDir: undefined,
				isWindowsDriveRoot: true,
				omitLeadingSlashOnWindows: false,
			},
			backspaceToRoot: {
				browseDir: '/',
				filterPrefix: '',
				targetPath: '/',
				parentDir: undefined,
				isWindowsDriveRoot: true,
				omitLeadingSlashOnWindows: false,
			},
			backslashInput: {
				browseDir: '/C:/Users/djf',
				filterPrefix: '',
				targetPath: '/C:/Users/djf',
				parentDir: '/C:/Users',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: true,
			},
			bareDrive: {
				browseDir: '/',
				filterPrefix: 'C',
				targetPath: '/C:',
				parentDir: undefined,
				isWindowsDriveRoot: true,
				omitLeadingSlashOnWindows: true,
			},
			tildeWithoutHome: {
				browseDir: '/C:',
				filterPrefix: '',
				targetPath: '/C:',
				parentDir: '/',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			tildeFolderWithoutHome: {
				browseDir: '/C:',
				filterPrefix: 'work',
				targetPath: '/C:/work',
				parentDir: '/',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			tildeWithWindowsHome: {
				browseDir: '/C:/Users/djf',
				filterPrefix: '',
				targetPath: '/C:/Users/djf',
				parentDir: '/C:/Users',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			tildeFolderWithWindowsHome: {
				browseDir: '/C:/Users/djf',
				filterPrefix: 'work',
				targetPath: '/C:/Users/djf/work',
				parentDir: '/C:/Users',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
		});
	});

	test('parses Linux and macOS live path input across parent folders, root, and tilde', () => {
		const parse = (input: string, os: 'linux' | 'macos', remoteHome?: string) => parseLiveRemotePathInput(input, os, remoteHome);

		assert.deepStrictEqual({
			trailingSlash: parse('/home/ubuntu/work/', 'linux'),
			backspaceToWork: parse('/home/ubuntu/work', 'linux'),
			backspaceToHome: parse('/home/ubuntu/', 'linux'),
			home: parse('/home/ubuntu', 'linux'),
			rootUser: parse('/root', 'linux'),
			root: parse('/', 'linux'),
			tildeWithoutHome: parse('~', 'linux'),
			tildeFolderWithoutHome: parse('~/work', 'linux'),
			tildeWithHome: parse('~', 'linux', '/home/ubuntu'),
			tildeFolderWithHome: parse('~/work', 'linux', '/home/ubuntu'),
			macosUserFolder: parse('/Users/me/work', 'macos'),
		}, {
			trailingSlash: {
				browseDir: '/home/ubuntu/work',
				filterPrefix: '',
				targetPath: '/home/ubuntu/work',
				parentDir: '/home/ubuntu',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			backspaceToWork: {
				browseDir: '/home/ubuntu',
				filterPrefix: 'work',
				targetPath: '/home/ubuntu/work',
				parentDir: '/home',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			backspaceToHome: {
				browseDir: '/home/ubuntu',
				filterPrefix: '',
				targetPath: '/home/ubuntu',
				parentDir: '/home',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			home: {
				browseDir: '/home',
				filterPrefix: 'ubuntu',
				targetPath: '/home/ubuntu',
				parentDir: '/',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			rootUser: {
				browseDir: '/',
				filterPrefix: 'root',
				targetPath: '/root',
				parentDir: undefined,
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			root: {
				browseDir: '/',
				filterPrefix: '',
				targetPath: '/',
				parentDir: undefined,
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			tildeWithoutHome: {
				browseDir: '/',
				filterPrefix: '',
				targetPath: '/',
				parentDir: undefined,
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			tildeFolderWithoutHome: {
				browseDir: '/',
				filterPrefix: 'work',
				targetPath: '/work',
				parentDir: undefined,
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			tildeWithHome: {
				browseDir: '/home/ubuntu',
				filterPrefix: '',
				targetPath: '/home/ubuntu',
				parentDir: '/home',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			tildeFolderWithHome: {
				browseDir: '/home/ubuntu',
				filterPrefix: 'work',
				targetPath: '/home/ubuntu/work',
				parentDir: '/home',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
			macosUserFolder: {
				browseDir: '/Users/me',
				filterPrefix: 'work',
				targetPath: '/Users/me/work',
				parentDir: '/Users',
				isWindowsDriveRoot: false,
				omitLeadingSlashOnWindows: false,
			},
		});
	});
});

suite('formatLiveRemoteDirInput', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('adds a trailing slash for folders while keeping Windows drive-root formatting', () => {
		assert.deepStrictEqual({
			windowsFolder: formatLiveRemoteDirInput('/C:/Users/djf', 'windows'),
			windowsFolderWithoutLeadingSlash: formatLiveRemoteDirInput('/C:/Users/djf', 'windows', true),
			windowsBackslashFolder: formatLiveRemoteDirInput('C:\\Users\\djf', 'windows'),
			windowsDrive: formatLiveRemoteDirInput('/C:', 'windows'),
			windowsRoot: formatLiveRemoteDirInput('/', 'windows'),
			windowsEmpty: formatLiveRemoteDirInput('', 'windows'),
			linuxFolder: formatLiveRemoteDirInput('/home/ubuntu/work', 'linux'),
			linuxFolderWithTrailingSlash: formatLiveRemoteDirInput('/home/ubuntu/work/', 'linux'),
			linuxRootUser: formatLiveRemoteDirInput('/root', 'linux'),
			linuxRoot: formatLiveRemoteDirInput('/', 'linux'),
			macosFolder: formatLiveRemoteDirInput('/Users/me/work', 'macos'),
		}, {
			windowsFolder: '/C:/Users/djf/',
			windowsFolderWithoutLeadingSlash: 'C:/Users/djf/',
			windowsBackslashFolder: '/C:/Users/djf/',
			windowsDrive: '/C:/',
			windowsRoot: '/',
			windowsEmpty: '/',
			linuxFolder: '/home/ubuntu/work/',
			linuxFolderWithTrailingSlash: '/home/ubuntu/work/',
			linuxRootUser: '/root/',
			linuxRoot: '/',
			macosFolder: '/Users/me/work/',
		});
	});
});

suite('resolveInitialCloudHostDirectory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('prefers explicit, recent, and discovered folders, then falls back to each OS home', () => {
		assert.deepStrictEqual({
			windowsUser: resolveInitialCloudHostDirectory({ os: 'windows', user: 'djf', recentDirectories: [] }),
			windowsWithoutUser: resolveInitialCloudHostDirectory({ os: 'windows', recentDirectories: [] }),
			windowsExplicit: resolveInitialCloudHostDirectory({ os: 'windows', user: 'djf', defaultDirectory: 'C:\\Users\\djf\\Projects\\', recentDirectories: [] }),
			recentFallback: resolveInitialCloudHostDirectory({ os: 'linux', user: 'ubuntu', recentDirectories: ['/recent/path/'] }),
			discoveredHomeFallback: resolveInitialCloudHostDirectory({ os: 'linux', user: 'ubuntu', recentDirectories: [], lastTestStatus: { ok: true, checkedAt: 0, latencyMs: 1, remoteHome: '/home/ubuntu/' } }),
			linuxRootUser: resolveInitialCloudHostDirectory({ os: 'linux', user: 'root', recentDirectories: [] }),
			linuxUser: resolveInitialCloudHostDirectory({ os: 'linux', user: 'ubuntu', recentDirectories: [] }),
			linuxWithoutUser: resolveInitialCloudHostDirectory({ os: 'linux', recentDirectories: [] }),
			macosUser: resolveInitialCloudHostDirectory({ os: 'macos', user: 'me', recentDirectories: [] }),
			macosWithoutUser: resolveInitialCloudHostDirectory({ os: 'macos', recentDirectories: [] }),
		}, {
			windowsUser: '/C:/Users/djf',
			windowsWithoutUser: '/C:',
			windowsExplicit: '/C:/Users/djf/Projects',
			recentFallback: '/recent/path',
			discoveredHomeFallback: '/home/ubuntu',
			linuxRootUser: '/root',
			linuxUser: '/home/ubuntu',
			linuxWithoutUser: '/',
			macosUser: '/Users/me',
			macosWithoutUser: '/Users',
		});
	});

	test('skips shallow root paths when a user home or deeper folder is known and strips domain qualifiers', () => {
		assert.deepStrictEqual({
			linuxRootRecentWithUser: resolveInitialCloudHostDirectory({ os: 'linux', user: 'lab', recentDirectories: ['/'] }),
			linuxRootDefaultWithHome: resolveInitialCloudHostDirectory({ os: 'linux', user: 'lab', defaultDirectory: '/', recentDirectories: ['/', '/home/lab'] }),
			winDriveRootWithUser: resolveInitialCloudHostDirectory({ os: 'windows', user: 'lab', defaultDirectory: '/C:', recentDirectories: ['/C:'] }),
			winAdDomainUser: resolveInitialCloudHostDirectory({ os: 'windows', user: 'administrator@ad.vmlab.test', defaultDirectory: '/C:', recentDirectories: [] }),
			winBackslashDomainUser: resolveInitialCloudHostDirectory({ os: 'windows', user: 'CORP\\alice', defaultDirectory: '/C:', recentDirectories: [] }),
		}, {
			linuxRootRecentWithUser: '/home/lab',
			linuxRootDefaultWithHome: '/home/lab',
			winDriveRootWithUser: '/C:/Users/lab',
			winAdDomainUser: '/C:/Users/administrator',
			winBackslashDomainUser: '/C:/Users/alice',
		});
	});
});

suite('resolveAdeOsIconKind', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies strictly into the 4 OS icons (Windows, macOS, Kali, Ubuntu)', () => {
		assert.deepStrictEqual({
			win: resolveAdeOsIconKind({ os: 'windows', hint: 'BUPT-Windows' }),
			mac: resolveAdeOsIconKind({ os: 'macos', hint: 'Mac-Studio' }),
			kali: resolveAdeOsIconKind({ os: 'linux', hint: 'kali-Linux1' }),
			ubuntuByAlias: resolveAdeOsIconKind({ os: 'linux', hint: 'ubuntu-target1' }),
			ubuntuByDistro: resolveAdeOsIconKind({ os: 'linux', distribution: 'Linux (ubuntu)', hint: 'GPU-server' }),
			debian: resolveAdeOsIconKind({ os: 'linux', distribution: 'Linux (debian)' }),
			rhel: resolveAdeOsIconKind({ os: 'linux', distribution: 'Linux (rocky)' }),
			generic: resolveAdeOsIconKind({ os: 'linux', hint: 'bupt208' }),
		}, {
			win: 'windows',
			mac: 'macos',
			kali: 'kali',
			ubuntuByAlias: 'ubuntu',
			ubuntuByDistro: 'ubuntu',
			debian: 'ubuntu',
			rhel: 'ubuntu',
			generic: 'ubuntu',
		});
	});
});
