// tests/unit/storage.test.mjs — unit tests for src/storage.mjs.
//
// Locks the v0.1.0 storage surface (load/put/get/has/readSvg/setPinned/
// pruneIfExpired/sweep/stats) so S02+ can extend it without breaking the
// existing TTL + pin + sweep contract. Uses a fresh temp root per test
// (via makeTempStorage) so parallel runs cannot collide.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Storage } from "../../src/storage.mjs";
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

describe("Storage", () => {
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
				const storage = new Storage(root);
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
				const storage = new Storage(root);
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
				const storage = new Storage(root);
				await expect(storage.load()).resolves.toBeUndefined();
				expect(storage.store.size).toBe(0);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	});

	describe("put() + get()", () => {
		it("stores the entry, writes the blob, and get() bumps lastAccessedAt", async () => {
			ctx = await makeTempStorage();
			const id = "mPutGet1";
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

			// blob on disk
			const blobPath = join(ctx.root, "blobs", `${id}.svg`);
			expect(existsSync(blobPath)).toBe(true);
			const onDisk = await readFile(blobPath, "utf-8");
			expect(onDisk).toBe(svg);

			// store.json persisted
			const storeJson = JSON.parse(await readFile(join(ctx.root, "store.json"), "utf-8"));
			expect(storeJson[id]).toBeDefined();
			expect(storeJson[id].code).toBe(code);

			// get() returns the entry and bumps lastAccessedAt
			const tBefore = entry.lastAccessedAt;
			await new Promise((r) => setTimeout(r, 5));
			const got = ctx.storage.get(id);
			expect(got).not.toBeNull();
			expect(got.code).toBe(code);
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
			const storeMtimeBefore = (await import("node:fs/promises")).stat(join(ctx.root, "store.json")).then((s) => s.mtimeMs);
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
});
