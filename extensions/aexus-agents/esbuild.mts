/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';
import { generateAdeBins } from './scripts/genAdeBins.mjs';

generateAdeBins(path.join(import.meta.dirname, 'bin'));

const srcDir = path.join(import.meta.dirname, 'src');
run({
	platform: 'node',
	entryPoints: {
		extension: path.join(srcDir, 'extension.ts'),
		engineProcess: path.join(srcDir, 'engineProcess.ts'),
		adeCli: path.join(srcDir, 'adeCli.ts'),
	},
	srcDir,
	outdir: path.join(import.meta.dirname, 'dist'),
}, process.argv);
