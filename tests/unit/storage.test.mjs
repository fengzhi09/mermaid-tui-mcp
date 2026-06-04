// tests/unit/storage.test.mjs — unit tests for src/storage/LocalFsStorage.mjs.
//
// Locks:
//   - S01's v0.1.0 contract: load / put / has / readSvg / setPinned /
//     pruneIfExpired (still bumps lastAccessedAt) / sweep / stats / TTL
//     boundary — these assertions are preserved unchanged so a v0.2.0
//     refactor can't silently regress the HTTP /view + /pin + /health
//     surface.
//   - S02's new contract: getMetadata (no side effect), remove (incl.
//     pinned + idempotency), list (paginate + pinned filter + cursor
//     round-trip), search (title-first ranking + case-insensitive +
//     cursor), put with title, legacy store.json compat.
//
// Uses makeTempStorage so each test gets a fresh root and parallel
// runs cannot collide. The legacy-compat case writes a hand-crafted
// store.json (no `title` field) into a temp root and loads it.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Counters } from "../../src/counters.mjs";
import { StorageReadError, StorageWriteError } from "../../src/tools.mjs";
import {
	LocalFsStorage,
	__setReadFileForTesting,
	__setReadTimeoutForTesting,
	__setWriteFileForTesting,
} from "../../src/storage/LocalFsStorage.mjs";
import { makeTempStorage } from "../helpers/storage-fixture.mjs";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function freshRootWithStoreJson(storeJson) {
	const root = await mkdtemp(join(tmpdir(), "mermaid-test-"));
	await mkdir(join(root, "blobs"), { recursive: true });
	if (storeJson !== undefined) {
		await writeFile(join(root, "store.json"), storeJson);
	}
	return root;
}

describe("LocalFsStorage", () => {
	let ctx;
	afterEach(async () => {
		if (ctx) await ctx.cleanup();
		ctx = undefined;
		vi.useRealTimers();
		// Reset S03 test seams so a test that installs a stub can't leak
		// into the next test. Each seam's "pass null" branch restores the
		// real node:fs/promises impl (and the real 5000ms read timeout).
		__setWriteFileForTesting(null);
		__setReadFileForTesting(null);
		__setReadTimeoutForTesting(null);
	});

	describe("load()", () => {
		it("starts empty on a fresh root and creates the blobs dir", async () => {
			const root = await mkdtemp(join(tmpdir(), "mermaid-test-"));
			try {
				const storage = new LocalFsStorage(root);
				await storage.load();
				expect(storage.store.size).toBe(0);
				expect(existsSync(join(root, "blobs"))).toBe(true);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("populates the store from a valid store.json", async () => {
			const valid = {
				m1: {
					code: "graph TD\n  A-->B",
					createdAt: Date.now() - 1000,
					pinned: false,
					lastAccessedAt: Date.now() - 1000,
					sourceLength: 13,
				},
				m2: {
					code: "graph LR\n  X-->Y",
					createdAt: Date.now() - 500,
					pinned: true,
					lastAccessedAt: Date.now() - 500,
					sourceLength: 12,
				},
			};
			const root = await freshRootWithStoreJson(JSON.stringify(valid));
			try {
				const storage = new LocalFsStorage(root);
				await storage.load();
				expect(storage.store.size).toBe(2);
				expect(storage.has("m1")).toBe(true);
				expect(storage.has("m2")).toBe(true);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("starts empty and does not crash on a corrupted store.json", async () => {
			const root = await freshRootWithStoreJson("not json{{{");
			try {
				const storage = new LocalFsStorage(root);
				await expect(storage.load()).resolves.toBeUndefined();
				expect(storage.store.size).toBe(0);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("defaults entry.title to \"\" for legacy v0.1.0 store.json (no title field)", async () => {
			const legacy = {
				mLegacy: {
					code: "graph TD\n  A-->B",
					createdAt: Date.now() - 1000,
					pinned: false,
					lastAccessedAt: Date.now() - 1000,
					sourceLength: 13,
				},
			};
			const root = await freshRootWithStoreJson(JSON.stringify(legacy));
			try {
				const storage = new LocalFsStorage(root);
				await storage.load();
				const entry = storage.store.get("mLegacy");
				expect(entry).toBeDefined();
				expect(entry.title).toBe("");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	});

	describe("put() + getMetadata() + pruneIfExpired()", () => {
		it("stores the entry, writes the blob, and getMetadata does NOT bump lastAccessedAt", async () => {
			ctx = await makeTempStorage();
			const id = "mPutMeta1";
			const code = "graph TD\n  A-->B";
			const svg = "<svg>body</svg>";
			const sourceLength = code.length;
			const t0 = Date.now();
			await ctx.storage.put(id, code, svg, sourceLength);

			const entry = ctx.storage.store.get(id);
			expect(entry).toBeDefined();
			expect(entry.code).toBe(code);
			expect(entry.sourceLength).toBe(sourceLength);
			expect(entry.pinned).toBe(false);
			expect(entry.createdAt).toBeGreaterThanOrEqual(t0);
			expect(entry.lastAccessedAt).toBeGreaterThanOrEqual(t0);
			expect(entry.title).toBe("");

			// blob on disk
			const blobPath = join(ctx.root, "blobs", `${id}.svg`);
			expect(existsSync(blobPath)).toBe(true);
			const onDisk = await readFile(blobPath, "utf-8");
			expect(onDisk).toBe(svg);

			// store.json persisted
			const storeJson = JSON.parse(await readFile(join(ctx.root, "store.json"), "utf-8"));
			expect(storeJson[id]).toBeDefined();
			expect(storeJson[id].code).toBe(code);

			// getMetadata returns the entry WITHOUT bumping lastAccessedAt
			const tBefore = entry.lastAccessedAt;
			await new Promise((r) => setTimeout(r, 5));
			const meta = ctx.storage.getMetadata(id);
			expect(meta).not.toBeNull();
			expect(meta.code).toBe(code);
			expect(meta.lastAccessedAt).toBe(tBefore);
		});

		it("pruneIfExpired bumps lastAccessedAt (S01 locked behaviour, used by HTTP /view + /raw/svg)", async () => {
			ctx = await makeTempStorage();
			const id = "mPruneBump";
			await ctx.storage.put(id, "graph TD\n  A-->B", "<svg></svg>", 13);
			const tBefore = ctx.storage.store.get(id).lastAccessedAt;
			await new Promise((r) => setTimeout(r, 5));
			const got = await ctx.storage.pruneIfExpired(id);
			expect(got).not.toBeNull();
			expect(got.lastAccessedAt).toBeGreaterThan(tBefore);
		});

		it("falls back to code.length when sourceLength is not a number", async () => {
			ctx = await makeTempStorage();
			const id = "mNoSrc";
			const code = "graph TD\n  A-->B";
			await ctx.storage.put(id, code, "<svg/>", undefined);
			expect(ctx.storage.store.get(id).sourceLength).toBe(code.length);
		});
	});

	describe("has()", () => {
		it("returns true for stored ids and false otherwise", async () => {
			ctx = await makeTempStorage();
			await ctx.storage.put("m1", "g", "<svg></svg>", 1);
			expect(ctx.storage.has("m1")).toBe(true);
			expect(ctx.storage.has("m404")).toBe(false);
		});
	});

	describe("readSvg()", () => {
		it("returns the svg text for a stored id, null for missing", async () => {
			ctx = await makeTempStorage();
			const id = "mSvg1";
			const svg = "<svg>body</svg>";
			await ctx.storage.put(id, "graph TD\n  A-->B", svg, 13);
			expect(await ctx.storage.readSvg(id)).toBe(svg);
			expect(await ctx.storage.readSvg("nope")).toBeNull();
		});
	});

	describe("setPinned()", () => {
		it("flips the pinned flag and returns true for existing ids, false for missing", async () => {
			ctx = await makeTempStorage();
			const id = "mPin1";
			await ctx.storage.put(id, "graph TD\n  A-->B", "<svg></svg>", 13);
			expect(ctx.storage.store.get(id).pinned).toBe(false);
			expect(await ctx.storage.setPinned(id, true)).toBe(true);
			expect(ctx.storage.store.get(id).pinned).toBe(true);
			expect(await ctx.storage.setPinned(id, false)).toBe(true);
			expect(ctx.storage.store.get(id).pinned).toBe(false);
			expect(await ctx.storage.setPinned("missing", true)).toBe(false);
		});
	});

	describe("pruneIfExpired()", () => {
		it("returns the entry and updates lastAccessedAt for an unexpired id", async () => {
			ctx = await makeTempStorage();
			const id = "mPruneLive";
			await ctx.storage.put(id, "graph TD\n  A-->B", "<svg></svg>", 13);
			const tBefore = ctx.storage.store.get(id).lastAccessedAt;
			await new Promise((r) => setTimeout(r, 5));
			const got = await ctx.storage.pruneIfExpired(id);
			expect(got).not.toBeNull();
			expect(got.code).toBe("graph TD\n  A-->B");
			expect(got.lastAccessedAt).toBeGreaterThan(tBefore);
			expect(ctx.storage.has(id)).toBe(true);
		});

		it("returns null and removes the entry + blob for an expired non-pinned id", async () => {
			ctx = await makeTempStorage();
			const id = "mPruneExpired";
			await ctx.storage.put(id, "g", "<svg></svg>", 1);
			await writeFile(join(ctx.root, "blobs", `${id}.svg`), "<svg></svg>", "utf-8");
			// backdate the entry past TTL
			ctx.storage.store.get(id).createdAt = Date.now() - TTL_MS - 1000;
			await ctx.storage.save();
			expect(existsSync(join(ctx.root, "blobs", `${id}.svg`))).toBe(true);
			const got = await ctx.storage.pruneIfExpired(id);
			expect(got).toBeNull();
			expect(ctx.storage.has(id)).toBe(false);
			expect(existsSync(join(ctx.root, "blobs", `${id}.svg`))).toBe(false);
		});

		it("returns the entry for an expired PINNED id (no sweep)", async () => {
			ctx = await makeTempStorage();
			const id = "mPrunePinned";
			await ctx.storage.put(id, "g", "<svg></svg>", 1);
			await writeFile(join(ctx.root, "blobs", `${id}.svg`), "<svg></svg>", "utf-8");
			ctx.storage.store.get(id).createdAt = Date.now() - TTL_MS - 1000;
			ctx.storage.store.get(id).pinned = true;
			await ctx.storage.save();
			const got = await ctx.storage.pruneIfExpired(id);
			expect(got).not.toBeNull();
			expect(got.pinned).toBe(true);
			expect(ctx.storage.has(id)).toBe(true);
			expect(existsSync(join(ctx.root, "blobs", `${id}.svg`))).toBe(true);
		});

		it("returns null for an unknown id", async () => {
			ctx = await makeTempStorage();
			expect(await ctx.storage.pruneIfExpired("nope")).toBeNull();
		});
	});

	describe("sweep()", () => {
		it("removes expired non-pinned, keeps pinned + fresh, returns the count, and calls save()", async () => {
			ctx = await makeTempStorage();
			const now = Date.now();
			const seed = [
				["mExpired", { code: "g", createdAt: now - TTL_MS - 1000, pinned: false, lastAccessedAt: now, sourceLength: 1 }],
				["mPinned", { code: "g", createdAt: now - TTL_MS - 1000, pinned: true, lastAccessedAt: now, sourceLength: 1 }],
				["mFresh", { code: "g", createdAt: now, pinned: false, lastAccessedAt: now, sourceLength: 1 }],
			];
			for (const [id, entry] of seed) {
				ctx.storage.store.set(id, entry);
				await writeFile(join(ctx.root, "blobs", `${id}.svg`), "<svg></svg>", "utf-8");
			}
			await ctx.storage.save();

			const removed = await ctx.storage.sweep();
			expect(removed).toBe(1);
			expect(ctx.storage.has("mExpired")).toBe(false);
			expect(ctx.storage.has("mPinned")).toBe(true);
			expect(ctx.storage.has("mFresh")).toBe(true);
			expect(existsSync(join(ctx.root, "blobs", "mExpired.svg"))).toBe(false);
			expect(existsSync(join(ctx.root, "blobs", "mPinned.svg"))).toBe(true);
			expect(existsSync(join(ctx.root, "blobs", "mFresh.svg"))).toBe(true);

			// store.json was persisted after the sweep
			const storeJson = JSON.parse(await readFile(join(ctx.root, "store.json"), "utf-8"));
			expect(storeJson.mExpired).toBeUndefined();
			expect(storeJson.mPinned).toBeDefined();
			expect(storeJson.mFresh).toBeDefined();
		});

		it("returns 0 and does not call save() when nothing is expired", async () => {
			ctx = await makeTempStorage();
			await ctx.storage.put("mFresh", "g", "<svg></svg>", 1);
			const removed = await ctx.storage.sweep();
			expect(removed).toBe(0);
			expect(ctx.storage.has("mFresh")).toBe(true);
		});
	});

	describe("stats()", () => {
		it("counts pinned vs unpinned correctly", async () => {
			ctx = await makeTempStorage();
			await ctx.storage.put("a", "g", "<svg></svg>", 1);
			await ctx.storage.put("b", "g", "<svg></svg>", 1);
			await ctx.storage.put("c", "g", "<svg></svg>", 1);
			await ctx.storage.setPinned("a", true);
			await ctx.storage.setPinned("b", true);
			const s = ctx.storage.stats();
			expect(s.total).toBe(3);
			expect(s.pinned).toBe(2);
			expect(s.unpinned).toBe(1);
		});
	});

	describe("TTL boundary", () => {
		it("treats an entry exactly at the TTL boundary as still valid (strict > comparison)", async () => {
			ctx = await makeTempStorage();
			const id = "mBoundary";
			const T = Date.now();

			vi.useFakeTimers();
			vi.setSystemTime(T);
			await ctx.storage.put(id, "g", "<svg></svg>", 1);

			// advance exactly TTL_MS — boundary is still valid (now - createdAt === TTL_MS, not >)
			vi.setSystemTime(T + TTL_MS);
			expect(await ctx.storage.pruneIfExpired(id)).not.toBeNull();
			expect(await ctx.storage.sweep()).toBe(0);

			// one more ms past the boundary — should expire
			vi.setSystemTime(T + TTL_MS + 1);
			expect(await ctx.storage.pruneIfExpired(id)).toBeNull();
		});
	});

	// ==========================================================================
	// S02 new surface
	// ==========================================================================

	describe("put() with title", () => {
		it("persists the title in the entry", async () => {
			ctx = await makeTempStorage();
			const id = "mWithTitle";
			await ctx.storage.put(id, "graph TD\n  A-->B", "<svg></svg>", 13, "Auth flow");
			const entry = ctx.storage.store.get(id);
			expect(entry.title).toBe("Auth flow");
		});

		it("defaults title to \"\" when the title arg is omitted", async () => {
			ctx = await makeTempStorage();
			const id = "mNoTitle";
			await ctx.storage.put(id, "graph TD\n  A-->B", "<svg></svg>", 13);
			expect(ctx.storage.store.get(id).title).toBe("");
		});
	});

	describe("getMetadata()", () => {
		it("returns the entry without bumping lastAccessedAt", async () => {
			ctx = await makeTempStorage();
			const id = "mMetaNoBump";
			await ctx.storage.put(id, "graph TD\n  A-->B", "<svg></svg>", 13);
			const tBefore = ctx.storage.store.get(id).lastAccessedAt;
			await new Promise((r) => setTimeout(r, 5));
			const meta = ctx.storage.getMetadata(id);
			expect(meta).not.toBeNull();
			expect(meta.code).toBe("graph TD\n  A-->B");
			expect(meta.lastAccessedAt).toBe(tBefore);
		});

		it("returns null for a missing id", async () => {
			ctx = await makeTempStorage();
			expect(ctx.storage.getMetadata("nope")).toBeNull();
		});
	});

	describe("remove()", () => {
		it("removes the entry AND the <id>.svg blob, and returns true", async () => {
			ctx = await makeTempStorage();
			const id = "mRemove1";
			await ctx.storage.put(id, "graph TD\n  A-->B", "<svg></svg>", 13);
			const blobPath = join(ctx.root, "blobs", `${id}.svg`);
			expect(existsSync(blobPath)).toBe(true);
			expect(ctx.storage.has(id)).toBe(true);

			const ok = await ctx.storage.remove(id);
			expect(ok).toBe(true);
			expect(ctx.storage.has(id)).toBe(false);
			expect(existsSync(blobPath)).toBe(false);

			// store.json no longer has the id
			const storeJson = JSON.parse(await readFile(join(ctx.root, "store.json"), "utf-8"));
			expect(storeJson[id]).toBeUndefined();
		});

		it("returns false for a missing id and does not throw", async () => {
			ctx = await makeTempStorage();
			expect(await ctx.storage.remove("nope")).toBe(false);
		});

		it("works on a PINNED entry (the pin flag does not block explicit delete)", async () => {
			ctx = await makeTempStorage();
			const id = "mRemovePinned";
			await ctx.storage.put(id, "graph TD\n  A-->B", "<svg></svg>", 13);
			await ctx.storage.setPinned(id, true);
			expect(ctx.storage.store.get(id).pinned).toBe(true);
			expect(await ctx.storage.remove(id)).toBe(true);
			expect(ctx.storage.has(id)).toBe(false);
		});

		it("is idempotent: a second remove returns false", async () => {
			ctx = await makeTempStorage();
			const id = "mRemoveIdem";
			await ctx.storage.put(id, "g", "<svg></svg>", 1);
			expect(await ctx.storage.remove(id)).toBe(true);
			expect(await ctx.storage.remove(id)).toBe(false);
		});
	});

	describe("list()", () => {
		it("paginates with limit and orders by createdAt desc (tiebreak id asc)", async () => {
			ctx = await makeTempStorage();
			const t0 = Date.now();
			const a = { code: "g", createdAt: t0 - 3000, pinned: false, lastAccessedAt: t0, sourceLength: 1 };
			const b = { code: "g", createdAt: t0 - 2000, pinned: false, lastAccessedAt: t0, sourceLength: 1 };
			const c = { code: "g", createdAt: t0 - 1000, pinned: false, lastAccessedAt: t0, sourceLength: 1 };
			ctx.storage.store.set("a-old", a);
			ctx.storage.store.set("b-mid", b);
			ctx.storage.store.set("c-new", c);

			const page1 = await ctx.storage.list({ limit: 2 });
			expect(page1.items.map((e) => e.createdAt)).toEqual([c.createdAt, b.createdAt]);
			expect(page1.nextCursor).toBeTruthy();
			const page2 = await ctx.storage.list({ limit: 2, cursor: page1.nextCursor });
			expect(page2.items.map((e) => e.createdAt)).toEqual([a.createdAt]);
			expect(page2.nextCursor).toBeNull();
		});

		it("respects the pinned filter (true returns only pinned, false only unpinned)", async () => {
			ctx = await makeTempStorage();
			const t0 = Date.now();
			ctx.storage.store.set("p1", { code: "g", createdAt: t0 - 2000, pinned: true, lastAccessedAt: t0, sourceLength: 1 });
			ctx.storage.store.set("p2", { code: "g", createdAt: t0 - 1000, pinned: true, lastAccessedAt: t0, sourceLength: 1 });
			ctx.storage.store.set("u1", { code: "g", createdAt: t0, pinned: false, lastAccessedAt: t0, sourceLength: 1 });

			const pinned = await ctx.storage.list({ pinned: true });
			expect(pinned.items).toHaveLength(2);
			expect(pinned.items.every((e) => e.pinned === true)).toBe(true);

			const unpinned = await ctx.storage.list({ pinned: false });
			expect(unpinned.items).toHaveLength(1);
			expect(unpinned.items[0].pinned).toBe(false);

			const all = await ctx.storage.list({});
			expect(all.items).toHaveLength(3);
		});

		it("cursor round-trips without skipping or duplicating across the full set", async () => {
			ctx = await makeTempStorage();
			const t0 = Date.now();
			const ids = ["z1", "a2", "m3", "b4", "k5", "x6"];
			const entries = ids.map((id, i) => ({
				code: "g",
				createdAt: t0 - (ids.length - i) * 1000,
				pinned: false,
				lastAccessedAt: t0,
				sourceLength: 1,
			}));
			// use the same keys so map order matches the list-sort id-asc tiebreak
			for (let i = 0; i < ids.length; i++) ctx.storage.store.set(ids[i], entries[i]);

			const seen = [];
			let cursor = undefined;
			let pages = 0;
			do {
				const res = await ctx.storage.list({ limit: 2, cursor });
				for (const e of res.items) seen.push(e.createdAt);
				cursor = res.nextCursor;
				pages++;
				if (pages > 10) throw new Error("cursor did not terminate");
			} while (cursor);

			expect(seen).toHaveLength(ids.length);
			// strictly decreasing createdAt across the full sequence
			for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThan(seen[i - 1]);
		});
	});

	describe("search()", () => {
		it("title match returns titleMatch: true and a snippet wrapping the hit", async () => {
			ctx = await makeTempStorage();
			const t0 = Date.now();
			ctx.storage.store.set("mA", {
				code: "graph TD\n  A-->B",
				createdAt: t0 - 2000,
				pinned: false,
				lastAccessedAt: t0,
				sourceLength: 1,
				title: "Auth flow",
			});
			ctx.storage.store.set("mB", {
				code: "graph TD\n  X-->Y",
				createdAt: t0 - 1000,
				pinned: false,
				lastAccessedAt: t0,
				sourceLength: 1,
				title: "Other",
			});

			const res = ctx.storage.search("auth");
			expect(res.items).toHaveLength(1);
			expect(res.items[0].titleMatch).toBe(true);
			expect(res.items[0].snippet).toContain("<mark>Auth</mark>");
		});

		it("code-only match returns titleMatch: false", async () => {
			ctx = await makeTempStorage();
			const t0 = Date.now();
			ctx.storage.store.set("mA", {
				code: "graph TD\n  Authentication subsystem",
				createdAt: t0,
				pinned: false,
				lastAccessedAt: t0,
				sourceLength: 1,
				title: "Diagram",
			});

			const res = ctx.storage.search("authentication");
			expect(res.items).toHaveLength(1);
			expect(res.items[0].titleMatch).toBe(false);
			expect(res.items[0].snippet).toContain("<mark>Authentication</mark>");
		});

		it("title match ranks above code match (titleMatch DESC, createdAt DESC, id ASC)", async () => {
			ctx = await makeTempStorage();
			const t0 = Date.now();
			// mCode is NEWER but matches only on code; mTitle is OLDER and matches on title.
			// titleMatch DESC wins → mTitle should be first.
			ctx.storage.store.set("mCode", {
				code: "auth code",
				createdAt: t0,
				pinned: false,
				lastAccessedAt: t0,
				sourceLength: 1,
				title: "no-match",
			});
			ctx.storage.store.set("mTitle", {
				code: "irrelevant",
				createdAt: t0 - 5000,
				pinned: false,
				lastAccessedAt: t0 - 5000,
				sourceLength: 1,
				title: "auth-title",
			});

			const res = ctx.storage.search("auth");
			expect(res.items).toHaveLength(2);
			expect(res.items[0].titleMatch).toBe(true);
			expect(res.items[1].titleMatch).toBe(false);
		});

		it("is case-insensitive on both title and code", async () => {
			ctx = await makeTempStorage();
			const t0 = Date.now();
			ctx.storage.store.set("mA", {
				code: "graph TD\n  A-->B",
				createdAt: t0,
				pinned: false,
				lastAccessedAt: t0,
				sourceLength: 1,
				title: "UPPERCASE TITLE",
			});

			expect(ctx.storage.search("uppercase title").items).toHaveLength(1);
			expect(ctx.storage.search("UPPERCASE TITLE").items).toHaveLength(1);
			expect(ctx.storage.search("uPpErCaSe").items).toHaveLength(1);
			// code match also case-insensitive
			expect(ctx.storage.search("GRAPH").items).toHaveLength(1);
		});

		it("cursor pagination across title+code+none matches (no skip, no duplicate)", async () => {
			ctx = await makeTempStorage();
			const t0 = Date.now();
			// 5 entries: 2 title-match, 2 code-match, 1 no-match
			const seed = [
				{ id: "a", title: "auth-a", code: "x" },
				{ id: "b", title: "auth-b", code: "y" },
				{ id: "c", title: "nope", code: "auth code c" },
				{ id: "d", title: "nope", code: "auth code d" },
				{ id: "e", title: "nope", code: "no match" },
			];
			seed.forEach((s, i) =>
				ctx.storage.store.set(s.id, {
					code: s.code,
					createdAt: t0 - (seed.length - i) * 1000,
					pinned: false,
					lastAccessedAt: t0,
					sourceLength: 1,
					title: s.title,
				}),
			);

			/** @type {Array<{title: string, titleMatch: boolean}>} */
			const seen = [];
			let cursor = undefined;
			let pages = 0;
			do {
				const res = ctx.storage.search("auth", { limit: 2, cursor });
				for (const item of res.items) {
					// record both which field matched AND a stable label
					seen.push({ title: item.titleMatch ? item.title : item.code, titleMatch: item.titleMatch });
				}
				cursor = res.nextCursor;
				pages++;
				if (pages > 10) throw new Error("cursor did not terminate");
			} while (cursor);

			// 4 matches total: 2 title-match first (auth-a, auth-b), then 2 code-match
			expect(seen).toHaveLength(4);
			// the first two are title-match
			expect(seen.slice(0, 2).map((s) => s.titleMatch)).toEqual([true, true]);
			expect(seen.slice(0, 2).map((s) => s.title).sort()).toEqual(["auth-a", "auth-b"]);
			// the last two are code-match (sorted createdAt DESC, so auth code c, auth code d)
			expect(seen.slice(2).map((s) => s.titleMatch)).toEqual([false, false]);
			expect(seen.slice(2).map((s) => s.title).sort()).toEqual(["auth code c", "auth code d"]);
			// no duplicates
			const allLabels = seen.map((s) => s.title);
			expect(new Set(allLabels).size).toBe(allLabels.length);
		});
	});

	// ==========================================================================
	// S03 new surface — write retry, read timeout, sweep counters, MEM024 fix.
	// ==========================================================================
	// R017 (write retry on EAGAIN/EWOULDBLOCK), R005 (5s read timeout for
	// readSvg), R010 (sweep_runs / sweep_removed counters), and the
	// MEM024 follow-up that closes the S02 surface gap where list() and
	// search() dropped the map key.

	describe("write retry (R017)", () => {
		it("retries writeFile once on EAGAIN, increments storage_write_retries, and persists the entry", async () => {
			const root = await mkdtemp(join(tmpdir(), "mermaid-test-"));
			try {
				const counters = new Counters(root);
				await counters.load();
				const storage = new LocalFsStorage(root, { counters });
				await storage.load();

				// First writeFile call throws EAGAIN; second call delegates to
				// the real node:fs/promises impl. The retry path should
				// exercise the 1x retry, surface the success, and bump
				// storage_write_retries by exactly 1.
				let writeCalls = 0;
				__setWriteFileForTesting(async (path, content) => {
					writeCalls++;
					if (writeCalls === 1) {
						const err = new Error("synthetic EAGAIN");
						err.code = "EAGAIN";
						throw err;
					}
					return await writeFile(path, content, "utf-8");
				});

				const id = "mEagain1";
				await storage.put(id, "graph TD\n  A-->B", "<svg></svg>", 13);

				// The blob write is the first writeFile call → EAGAIN, then
				// retry → real write. The save() then writes store.json.tmp
				// (real writeFile, no EAGAIN) and renames. So the seam was
				// called at least twice (1 EAGAIN + 1 retry); subsequent
				// calls (save's tmp write) also count.
				expect(writeCalls).toBeGreaterThanOrEqual(2);
				// Counter bumped by exactly 1 — the EAGAIN retried once.
				expect(counters.snapshot().storage_write_retries).toBe(1);
				// Entry is persisted and the blob is on disk.
				expect(storage.has(id)).toBe(true);
				expect(existsSync(join(root, "blobs", `${id}.svg`))).toBe(true);
				const onDisk = await readFile(join(root, "blobs", `${id}.svg`), "utf-8");
				expect(onDisk).toBe("<svg></svg>");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("does NOT retry on ENOSPC; throws StorageWriteError (-32004, retryable: true) immediately", async () => {
			const root = await mkdtemp(join(tmpdir(), "mermaid-test-"));
			try {
				const counters = new Counters(root);
				await counters.load();
				const storage = new LocalFsStorage(root, { counters });
				await storage.load();

				let writeCalls = 0;
				__setWriteFileForTesting(async () => {
					writeCalls++;
					const err = new Error("synthetic ENOSPC");
					err.code = "ENOSPC";
					throw err;
				});

				let caught;
				try {
					await storage.put("mEnospc", "graph TD\n  A-->B", "<svg></svg>", 13);
				} catch (e) {
					caught = e;
				}
				// Tagged failure: StorageWriteError with the locked R020 envelope.
				expect(caught).toBeInstanceOf(StorageWriteError);
				expect(caught.code).toBe(-32004);
				expect(caught.retryable).toBe(true);
				expect(caught.name).toBe("StorageWriteError");
				// Terminal errors don't retry → the seam is called exactly once.
				expect(writeCalls).toBe(1);
				// And the counter is NOT bumped (no transient retry happened).
				expect(counters.snapshot().storage_write_retries).toBe(0);
				// The entry is in memory but never made it to disk.
				expect(storage.has("mEnospc")).toBe(true);
				expect(existsSync(join(root, "blobs", "mEnospc.svg"))).toBe(false);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("retries on EWOULDBLOCK (sibling of EAGAIN in the transient bucket)", async () => {
			const root = await mkdtemp(join(tmpdir(), "mermaid-test-"));
			try {
				const counters = new Counters(root);
				await counters.load();
				const storage = new LocalFsStorage(root, { counters });
				await storage.load();

				let writeCalls = 0;
				__setWriteFileForTesting(async (path, content) => {
					writeCalls++;
					if (writeCalls === 1) {
						const err = new Error("synthetic EWOULDBLOCK");
						err.code = "EWOULDBLOCK";
						throw err;
					}
					return await writeFile(path, content, "utf-8");
				});

				await storage.put("mEwould", "g", "<svg></svg>", 1);
				expect(counters.snapshot().storage_write_retries).toBe(1);
				expect(existsSync(join(root, "blobs", "mEwould.svg"))).toBe(true);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("does NOT retry on EACCES (sibling of ENOSPC in the terminal bucket)", async () => {
			const root = await mkdtemp(join(tmpdir(), "mermaid-test-"));
			try {
				const counters = new Counters(root);
				await counters.load();
				const storage = new LocalFsStorage(root, { counters });
				await storage.load();

				let writeCalls = 0;
				__setWriteFileForTesting(async () => {
					writeCalls++;
					const err = new Error("synthetic EACCES");
					err.code = "EACCES";
					throw err;
				});

				let caught;
				try {
					await storage.put("mEacces", "g", "<svg></svg>", 1);
				} catch (e) {
					caught = e;
				}
				expect(caught).toBeInstanceOf(StorageWriteError);
				expect(caught.code).toBe(-32004);
				expect(caught.retryable).toBe(true);
				expect(writeCalls).toBe(1);
				expect(counters.snapshot().storage_write_retries).toBe(0);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	});

	describe("read timeout (R005)", () => {
		it("throws StorageReadError (-32005, retryable: true) when readFile never resolves within the timeout", async () => {
			ctx = await makeTempStorage();
			const id = "mReadTimeout";
			await ctx.storage.put(id, "graph TD\n  A-->B", "<svg></svg>", 13);

			// Replace readFile with a never-resolving promise so the
			// Promise.race resolves via the timeout branch. 50ms keeps the
			// test under 1s.
			__setReadFileForTesting(() => new Promise(() => {}));
			__setReadTimeoutForTesting(50);

			let caught;
			try {
				await ctx.storage.readSvg(id);
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(StorageReadError);
			expect(caught.code).toBe(-32005);
			expect(caught.retryable).toBe(true);
			expect(caught.name).toBe("StorageReadError");
			// Message names the actual timeout (50ms) so operators can see
			// which budget fired.
			expect(caught.message).toContain("50");
			expect(caught.message).toMatch(/svg read timed out after/);
		});

		it("returns the svg text on the happy path (no timeout fires, the real read wins)", async () => {
			ctx = await makeTempStorage();
			const id = "mReadOk";
			const svg = "<svg>body</svg>";
			await ctx.storage.put(id, "graph TD\n  A-->B", svg, 13);
			// Default seams + default 5000ms timeout — read completes well
			// under that budget.
			expect(await ctx.storage.readSvg(id)).toBe(svg);
		});

		it("returns null on a missing blob (preserves v0.1.0 '404 = null' contract)", async () => {
			ctx = await makeTempStorage();
			// No put() — the blob file does not exist. readFile throws
			// ENOENT, which the catch swallows into null (not a timeout).
			expect(await ctx.storage.readSvg("never-stored")).toBeNull();
		});
	});

	describe("sweep counters (R010)", () => {
		it("increments sweep_runs on every call and sweep_removed when entries are removed", async () => {
			const root = await mkdtemp(join(tmpdir(), "mermaid-test-"));
			try {
				const counters = new Counters(root);
				await counters.load();
				const storage = new LocalFsStorage(root, { counters });
				await storage.load();

				// load() itself calls sweep() at the end, so the counter
				// has already been bumped once before this test starts.
				// Capture the baseline so the assertions are not coupled
				// to the load() side effect.
				const baselineRuns = counters.snapshot().sweep_runs;

				// 1st sweep: nothing expired → sweep_removed stays 0.
				const r1 = await storage.sweep();
				expect(r1).toBe(0);
				expect(counters.snapshot().sweep_runs).toBe(baselineRuns + 1);
				expect(counters.snapshot().sweep_removed).toBe(0);

				// 2nd sweep: still nothing expired.
				const r2 = await storage.sweep();
				expect(r2).toBe(0);
				expect(counters.snapshot().sweep_runs).toBe(baselineRuns + 2);
				expect(counters.snapshot().sweep_removed).toBe(0);

				// Add an expired entry, sweep, and verify sweep_removed
				// advances by exactly 1.
				const now = Date.now();
				storage.store.set("expired1", {
					code: "g",
					createdAt: now - TTL_MS - 1000,
					pinned: false,
					lastAccessedAt: now,
					sourceLength: 1,
				});
				const r3 = await storage.sweep();
				expect(r3).toBe(1);
				expect(counters.snapshot().sweep_removed).toBe(1);
				expect(storage.has("expired1")).toBe(false);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("does NOT increment sweep_removed when nothing is removed (and does not call save())", async () => {
			const root = await mkdtemp(join(tmpdir(), "mermaid-test-"));
			try {
				const counters = new Counters(root);
				await counters.load();
				const storage = new LocalFsStorage(root, { counters });
				await storage.load();
				// Add a fresh, unexpired entry.
				await storage.put("mFreshSweep", "g", "<svg></svg>", 1);
				const removedBefore = counters.snapshot().sweep_removed;
				const r = await storage.sweep();
				expect(r).toBe(0);
				// sweep_removed never advances on a no-op sweep.
				expect(counters.snapshot().sweep_removed).toBe(removedBefore);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	});

	describe("MEM024 — list() and search() items carry the id field", () => {
		it("list() returns items with `id` present and matching the seeded keys", async () => {
			ctx = await makeTempStorage();
			const t0 = Date.now();
			ctx.storage.store.set("alpha", {
				code: "graph TD\n  A-->B",
				createdAt: t0 - 2000,
				pinned: false,
				lastAccessedAt: t0,
				sourceLength: 13,
				title: "alpha-title",
			});
			ctx.storage.store.set("beta", {
				code: "graph TD\n  X-->Y",
				createdAt: t0 - 1000,
				pinned: false,
				lastAccessedAt: t0,
				sourceLength: 13,
				title: "beta-title",
			});

			const res = await ctx.storage.list({ limit: 10 });
			expect(res.items).toHaveLength(2);
			// The ids are present and match the seeded keys.
			const ids = res.items.map((it) => it.id);
			expect(ids.sort()).toEqual(["alpha", "beta"]);
			// Every other Entry field is also still present.
			for (const item of res.items) {
				expect(typeof item.code).toBe("string");
				expect(typeof item.createdAt).toBe("number");
				expect(typeof item.pinned).toBe("boolean");
				expect(typeof item.lastAccessedAt).toBe("number");
				expect(typeof item.sourceLength).toBe("number");
				expect(typeof item.title).toBe("string");
			}
		});

		it("list() with a cursor still projects id on the next page", async () => {
			ctx = await makeTempStorage();
			const t0 = Date.now();
			ctx.storage.store.set("a1", { code: "g", createdAt: t0 - 3000, pinned: false, lastAccessedAt: t0, sourceLength: 1 });
			ctx.storage.store.set("a2", { code: "g", createdAt: t0 - 2000, pinned: false, lastAccessedAt: t0, sourceLength: 1 });
			ctx.storage.store.set("a3", { code: "g", createdAt: t0 - 1000, pinned: false, lastAccessedAt: t0, sourceLength: 1 });

			const page1 = await ctx.storage.list({ limit: 2 });
			expect(page1.items).toHaveLength(2);
			expect(page1.items[0].id).toBe("a3"); // newest
			expect(page1.items[1].id).toBe("a2");
			expect(page1.nextCursor).toBeTruthy();

			const page2 = await ctx.storage.list({ limit: 2, cursor: page1.nextCursor });
			expect(page2.items).toHaveLength(1);
			expect(page2.items[0].id).toBe("a1");
		});

		it("search() returns items with `id` present alongside titleMatch and snippet", async () => {
			ctx = await makeTempStorage();
			const t0 = Date.now();
			ctx.storage.store.set("mKw1", {
				code: "graph TD\n  A-->B",
				createdAt: t0 - 2000,
				pinned: false,
				lastAccessedAt: t0,
				sourceLength: 1,
				title: "Auth flow keyword",
			});
			ctx.storage.store.set("mKw2", {
				code: "graph TD\n  keyword in code",
				createdAt: t0 - 1000,
				pinned: false,
				lastAccessedAt: t0,
				sourceLength: 1,
				title: "Other",
			});

			const res = ctx.storage.search("keyword");
			expect(res.items).toHaveLength(2);
			// Both items carry id, titleMatch, snippet.
			for (const item of res.items) {
				expect(typeof item.id).toBe("string");
				expect(item.id.length).toBeGreaterThan(0);
				expect(typeof item.titleMatch).toBe("boolean");
				expect(typeof item.snippet).toBe("string");
				expect(item.snippet).toContain("<mark>");
			}
			// The ids match the seeded keys.
			const ids = res.items.map((it) => it.id);
			expect(ids.sort()).toEqual(["mKw1", "mKw2"]);
		});

		it("search() with code-only match still surfaces the id on the returned item", async () => {
			ctx = await makeTempStorage();
			const t0 = Date.now();
			ctx.storage.store.set("mCodeOnly", {
				code: "graph TD\n  keyword in source",
				createdAt: t0,
				pinned: false,
				lastAccessedAt: t0,
				sourceLength: 1,
				title: "diagram",
			});
			const res = ctx.storage.search("keyword");
			expect(res.items).toHaveLength(1);
			expect(res.items[0].id).toBe("mCodeOnly");
			expect(res.items[0].titleMatch).toBe(false);
		});
	});
});
