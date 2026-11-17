/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as path from 'node:path';

// Node IPC tracks the host lifetime without consuming the engine's stdio protocol.
const [executable, ...args] = process.argv.slice(2);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_CHANNEL_FD;
delete env.NODE_CHANNEL_SERIALIZATION_MODE;
const child = cp.spawn(executable, args, {
	stdio: 'inherit', env, windowsHide: true,
	shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable),
});

const terminate = () => {
	if (process.platform === 'win32') {
		if (!child.pid) { process.exit(1); }
		const taskkill = cp.spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
		taskkill.on('exit', () => process.exit(0));
		taskkill.on('error', () => { child.kill(); process.exit(1); });
	} else {
		process.kill(-process.pid, 'SIGTERM');
	}
};
process.on('disconnect', terminate);
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
