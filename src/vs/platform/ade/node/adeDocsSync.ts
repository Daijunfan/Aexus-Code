/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from '../../../base/common/path.js';
import {
	ADE_DOCS_COMMON_FILE_NAME,
	ADE_DOCS_MANIFEST_FILE_NAME,
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
 * - `<adeHome>/docs/common/COMMON_API.md`
 * - `<adeHome>/docs/ranks/L0.md`, `L1.md`, ..., `L<N>.md` (pure Native Rank CLI docs)
 * - `<adeHome>/docs/engineering/ENGINEERING_PARADIGM.md` & `ENGINEERING_API.md` (sibling Engineering docs)
 * - `<adeHome>/docs/mission/MISSION_API.md` (sibling unified Engineering/Mission reference)
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
		...(paths.commonDir ? [fs.promises.mkdir(paths.commonDir, { recursive: true, mode: 0o700 })] : []),
		fs.promises.mkdir(paths.ranksDir, { recursive: true, mode: 0o700 }),
		...(paths.engineeringDir ? [fs.promises.mkdir(paths.engineeringDir, { recursive: true, mode: 0o700 })] : []),
		fs.promises.mkdir(paths.missionDir, { recursive: true, mode: 0o700 }),
	]);

	const expectedRankFiles = new Set(Object.keys(bundle.rankFiles));
	const writes: Promise<void>[] = [];

	if (paths.commonDir && bundle.commonFile) {
		writes.push(writeIfChanged(path.join(paths.commonDir, ADE_DOCS_COMMON_FILE_NAME), bundle.commonFile));
	}
	if (bundle.manifestJson) {
		writes.push(writeIfChanged(path.join(paths.docsRoot, ADE_DOCS_MANIFEST_FILE_NAME), bundle.manifestJson));
	}
	for (const [fileName, content] of Object.entries(bundle.rankFiles)) {
		writes.push(writeIfChanged(path.join(paths.ranksDir, fileName), content));
	}
	if (paths.engineeringDir && bundle.engineeringFiles) {
		for (const [fileName, content] of Object.entries(bundle.engineeringFiles)) {
			writes.push(writeIfChanged(path.join(paths.engineeringDir, fileName), content));
		}
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
