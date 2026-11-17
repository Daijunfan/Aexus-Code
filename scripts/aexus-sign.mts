/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { sign } from '../build/node_modules/@electron/osx-sign/dist/index.js';

const root = path.resolve(import.meta.dirname, '..');
const signing = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/aexus-code/signing.json'), 'utf8')) as { identity: string };
if (!signing.identity || signing.identity === '-') { throw new Error('A persistent Aexus Code signing identity is required.'); }
await sign({
	app: path.resolve(root, process.argv[2] ?? '../VSCode-darwin-arm64/Aexus Code.app'),
	platform: 'darwin',
	identity: signing.identity,
	identityValidation: false,
	preAutoEntitlements: false,
	preEmbedProvisioningProfile: false,
	optionsForFile: file => {
		const helper = / Helper(?: \((GPU|Renderer|Plugin)\))?\.app/.exec(file);
		const name = helper ? `helper${helper[1] ? `-${helper[1].toLowerCase()}` : ''}` : 'app';
		return {
			entitlements: path.join(root, 'build/azure-pipelines/darwin', `${name}-entitlements.plist`),
			hardenedRuntime: false,
			timestamp: 'none'
		};
	}
});
console.log('Aexus Code: persistent local signature verified.');
