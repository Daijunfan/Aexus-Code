/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { evaluateAgyPreInvocationHook, ROLE_STATE_ENV_KEY } from './roleBridgeShared';

function readAllStdin(): Promise<string> {
	return new Promise(resolve => {
		const chunks: Buffer[] = [];
		const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
		process.stdin.on('data', chunk => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
		});
		process.stdin.once('end', done);
		process.stdin.once('error', done);
	});
}

void readAllStdin().then(async stdinText => {
	const result = await evaluateAgyPreInvocationHook(stdinText, process.env[ROLE_STATE_ENV_KEY]);
	process.stdout.write(JSON.stringify(result) + '\n');
});
