// tests/helpers/migrate-fixture.mjs — build a 5-entry LocalFsStorage
// fixture for the M002/S02 migration CLI unit + integration tests.
//
// The 5-entry mix is the S02 demo shape: 3 fresh + pinned, 1
// expired-but-pinned (survives the source's TTL sweep), and 1
// expired-and-unpinned (dropped by the source's TTL sweep). The
// post-sweep state is exactly 4 surviving entries — the slice's
// "4-of-5 copy" invariant.
//
// The fixture writes both the in-memory Map AND the on-disk blob +
// store.json so the migration CLI's `await source.load()` call picks
// up the same shape a real LocalFsStorage would see at boot.
//
// Returns { storage, ids, survivingIds } so the tests can assert
// against both pre-sweep and post-sweep shape — e.g. "5 entries
// pre-sweep" needs the fixture to load() THEN inspect the seed
// (not the storage), and "4 entries post-sweep" reads survivingIds
// directly. The ids array preserves the seed order; survivingIds
// is the post-sweep subset (everything except the expired-unpinned).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LocalFsStorage } from "../../src/storage/LocalFsStorage.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
// Match the production TTL: TTL_MS_DEFAULT = 7 * DAY_MS in
// src/storage/LocalFsStorage.mjs. We use 7 days so "expired" means
// createdAt is at least 8 days old (> TTL).
const TTL_MS = 7 * DAY_MS;
const EXPIRED_OFFSET_MS = 8 * DAY_MS;

/**
 * Seed entries — the 5 ids in deterministic order. Pre-sweep this
 * is 5 entries; post-sweep the source drops the unpinned-expired
 * one and 4 remain.
 *
 * @type {Array<{id: string, code: string, svg: string, sourceLength: number, title: string, pinned: boolean, expired: boolean}>}
 */
const SEED = [
	{ id: "fresh-pinned-0", code: "graph TD\n  A-->B", svg: "<svg>fb0</svg>", sourceLength: 13, title: "Fresh 0", pinned: true,  expired: false },
	{ id: "fresh-pinned-1", code: "graph LR\n  X-->Y", svg: "<svg>fb1</svg>", sourceLength: 12, title: "Fresh 1", pinned: true,  expired: false },
	{ id: "fresh-pinned-2", code: "graph TD\n  C-->D", svg: "<svg>fb2</svg>", sourceLength: 13, title: "Fresh 2", pinned: true,  expired: false },
	// expired-pinned: survives the sweep because the source's sweep
	// only removes entries where !pinned && now-createdAt > TTL.
	{ id: "expired-pinned", code: "graph TD\n  E-->F", svg: "<svg>ep</svg>",  sourceLength: 13, title: "Expired but pinned", pinned: true,  expired: true },
	// expired-unpinned: the sweep target. This entry is created, then
	// the source's load() sweep() removes it before the migration
	// sees the store — so the migration's source.store has 4 entries
	// after load(). survivingIds is exactly the 4 above.
	{ id: "expired-unpinned", code: "graph TD\n  G-->H", svg: "<svg>eu</svg>", sourceLength: 13, title: "Will be swept", pinned: false, expired: true },
];

/**
 * Build a fresh LocalFsStorage rooted at `root` with 5 entries
 * matching the S02 demo mix. Calls .load() so the source's sweep
 * has already run — the returned storage's in-memory Map is the
 * post-sweep state (4 entries).
 *
 * @param {string} root  data dir for the LocalFsStorage (the test
 *   passes a temp dir from mkdtemp).
 * @returns {Promise<{
 *   storage: LocalFsStorage,
 *   ids: string[],          // 5 ids in seed order (pre-sweep)
 *   survivingIds: string[], // 4 ids that survive the source's sweep
 *   ttlMs: number,          // the TTL_MS the fixture was built against
 * }>}
 */
export async function makeLocalFixture(root) {
	const now = Date.now();
	// Pre-create the blobs dir + write the 5 blobs so the on-disk
	// shape matches the in-memory Map. We write blobs for all 5 even
	// though the expired-unpinned entry will be swept on load() —
	// the on-disk blob is best-effort cleaned by sweep() too, so the
	// post-load state is consistent (no orphan blob).
	await mkdir(join(root, "blobs"), { recursive: true });
	for (const e of SEED) {
		const blobPath = join(root, "blobs", `${e.id}.svg`);
		await writeFile(blobPath, e.svg, "utf-8");
	}

	// Construct the storage and seed the in-memory store directly,
	// mirroring how tests/unit/storage.test.mjs seeds test fixtures
	// (lines 282-302 — putting the entries in the Map then setting
	// createdAt/pinned explicitly). We do NOT use storage.put() here
	// because put() always sets createdAt=Date.now() which would
	// overwrite the "expired" ages we want.
	const storage = new LocalFsStorage(root);
	for (const e of SEED) {
		const age = e.expired ? EXPIRED_OFFSET_MS : 0;
		storage.store.set(e.id, {
			code: e.code,
			createdAt: now - age,
			pinned: e.pinned,
			lastAccessedAt: now,
			sourceLength: e.sourceLength,
			title: e.title,
		});
	}
	// Persist the seed to store.json so the on-disk shape matches the
	// in-memory state — then call load() so the source's sweep runs
	// (sweep removes the expired-unpinned entry, so the migration CLI
	// sees the 4-entry post-sweep state).
	await storage.save();
	await storage.load();

	return {
		storage,
		ids: SEED.map((e) => e.id),
		survivingIds: SEED.filter((e) => e.pinned || !e.expired).map((e) => e.id),
		ttlMs: TTL_MS,
	};
}

// Re-export the seed for tests that want to assert on individual
// fields (e.g. the bytes-pinned test that needs the exact svg body
// for byte-equal comparison).
export { SEED as MIGRATE_FIXTURE_SEED };
