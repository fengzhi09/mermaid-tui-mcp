// tests/helpers/storage-fixture.mjs — build a fresh Storage instance rooted
// in a per-test temp directory. Each call gets its own root, so tests do not
// see each other's data and parallel runs do not collide.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Storage } from "../../src/storage.mjs";

/**
 * @returns {Promise<{
 *   storage: Storage,
 *   root: string,
 *   cleanup: () => Promise<void>
 * }>}
 */
export async function makeTempStorage() {
	const root = await mkdtemp(join(tmpdir(), "mermaid-test-"));
	const storage = new Storage(root);
	await storage.load();
	return {
		storage,
		root,
		async cleanup() {
			await rm(root, { recursive: true, force: true });
		},
	};
}
