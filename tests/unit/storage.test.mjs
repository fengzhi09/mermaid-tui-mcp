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

import { LocalFsStorage } from "../../src/storage/LocalFsStorage.mjs";
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
});
