/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	ADE_DOCS_MISSION_FILE_NAME,
	buildAdeDocsBundle,
	buildAdeDocsPaths,
	IAdeDocsPaths,
} from '../common/adeDocsCatalog.js';
import { IAdeOrganizationConfig } from '../common/adeRoleSchema.js';

async function writeIfChanged(filePath: string, content: string): Promise<void> {
	try {
		const existing = await fs.promises.readFile(filePath, 'utf8');
		if (existing === content) {
			return;
		}
	} catch {
		// File does not exist yet
	}
	await fs.promises.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Synchronizes the single canonical copy of ADE API docs on disk:
 * - `<adeHome>/docs/ranks/L0.md`, `L1.md`, ..., `L<N>.md`
 * - `<adeHome>/docs/mission/MISSION_API.md` (sibling directory alongside `ranks/`)
 *
 * Writes only when content changes and prunes stale `L<k>.md` files when tier count shrinks.
 */
export async function syncAdeApiDocsToDisk(
	adeHomeDir: string,
	config: IAdeOrganizationConfig,
): Promise<IAdeDocsPaths> {
	const paths = buildAdeDocsPaths(adeHomeDir, config.ranks.length);
	const bundle = buildAdeDocsBundle(config);

	await Promise.all([
		fs.promises.mkdir(paths.ranksDir, { recursive: true, mode: 0o700 }),
		fs.promises.mkdir(paths.missionDir, { recursive: true, mode: 0o700 }),
	]);

	const expectedRankFiles = new Set(Object.keys(bundle.rankFiles));
	const writes: Promise<void>[] = [];

	for (const [fileName, content] of Object.entries(bundle.rankFiles)) {
		writes.push(writeIfChanged(path.join(paths.ranksDir, fileName), content));
	}
	writes.push(writeIfChanged(path.join(paths.missionDir, ADE_DOCS_MISSION_FILE_NAME), bundle.missionFile));
	await Promise.all(writes);

	// Remove stale tier docs (e.g. L4.md if user lowered rank count from 4 to 3)
	try {
		const existingEntries = await fs.promises.readdir(paths.ranksDir);
		const removals: Promise<void>[] = [];
		for (const entry of existingEntries) {
			if (/^L\d+\.md$/i.test(entry) && !expectedRankFiles.has(entry)) {
				removals.push(fs.promises.rm(path.join(paths.ranksDir, entry), { force: true }));
			}
		}
		if (removals.length > 0) {
			await Promise.all(removals);
		}
	} catch {
		// Ignore cleanup errors
	}

	return paths;
}
