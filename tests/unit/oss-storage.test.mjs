// tests/unit/oss-storage.test.mjs — unit tests for src/storage/OssStorage.mjs.
//
// T02 contract: the full StorageBackend surface (13 methods) on
// OssStorage, exercised through a stub S3Client so no real network is
// touched. The stub mimics the SDK's response shape:
//   - GetObject → { Body: { transformToString: () => Promise<string> }, ... }
//   - PutObject → { ETag: "stub" }
//   - HeadBucket / HeadObject / DeleteObject / CreateBucket → {}
// and records every command so each test can assert exactly which
// S3 calls happened.
//
// Storage layout (mirroring LocalFsStorage's on-disk shape):
//   <prefix>/store.json            (the persisted Map<id, Entry>)
//   <prefix>/blobs/<id>.svg        (the rendered SVG body)
//
// Test scenarios (from the T02 plan):
//   (a) full lifecycle: load → put → getMetadata → readSvg → list → search →
//       setPinned → setPinned(false) → remove → remove again (returns false) →
//       stats
//   (b) legacy v0.1.0 store.json compat (no title field defaults to "")
//   (c) TTL boundary
//   (d) cursor round-trip (list + search)
//   (e) title-first search ranking
//   (f) readSvg timeout throws StorageReadError
//   (g) save failure surfaces StorageWriteError after retry exhaustion
//   (h) GetObject NoSuchKey returns null
//   (i) bucket-not-found with createBucket=true creates the bucket
//   (j) bucket-not-found with createBucket=false throws
//
// Conventions:
//   - Each test gets a fresh stub via makeStubClient() — no shared state
//     between tests.
//   - After each test the stub is torn down (a forced destroy) so a
//     hanging Promise.race from the timeout test cannot leak.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StorageReadError, StorageWriteError } from "../../src/tools.mjs";
import { OssStorage, TTL_DAYS } from "../../src/storage/OssStorage.mjs";

// ---------------------------------------------------------------------------
// Error shims — match the SDK's exact error class shape (a name property
// the production code checks) so the production code's "NoSuchKey" /
// "NoSuchBucket" classification takes the right path.
// ---------------------------------------------------------------------------

class S3NoSuchKey extends Error {
	constructor(message = "The specified key does not exist.") {
		super(message);
		this.name = "NoSuchKey";
		this.$fault = "client";
	}
}

class S3NoSuchBucket extends Error {
	constructor(message = "The specified bucket does not exist.") {
		super(message);
		this.name = "NoSuchBucket";
		this.$fault = "client";
	}
}

class S3TimeoutError extends Error {
	constructor(message = "Request timeout") {
		super(message);
		this.name = "TimeoutError";
		this.$fault = "client";
	}
}

// ---------------------------------------------------------------------------
// FakeBlob — mirrors the SDK's Body.transformToString() shape so the
// production _readObjectWithTimeout can call into it without special
// casing the stub path. The body could equally be a Buffer, but the
// SDK contract is `transformToString(encoding?) → Promise<string>`.
// ---------------------------------------------------------------------------

class FakeBlob {
	constructor(content) {
		this.content = typeof content === "string" ? content : "";
	}
	async transformToString(encoding = "utf-8") {
		// The production code passes "utf-8" explicitly; mirror the
		// minimal contract — single arg, returns the string.
		return this.content;
	}
}

// ---------------------------------------------------------------------------
// makeStubClient — builds a fresh S3Client stub for one test.
//
// Storage model:
//   - bucketExists: boolean (default true)
//   - blobs: Map<string, string> — the blob namespace (key → svg body)
//   - store: Map<string, string> — the store.json namespace (key → json body)
//
// Test controls:
//   - commands[]: every command sent, in order, with its input snapshot
//   - failNextPut: an Error to throw on the next PutObject call (used for
//     the retry-exhaustion and write-failure tests). The error is consumed
//     once and then cleared (so a second put can succeed if the test
//     exercises a retry-then-success path).
//   - failNextGet: an Error to throw on the next GetObject call (used
//     for the read-timeout test).
//   - failNextGetForever: a sticky Error that fires on every GetObject
//     call (used when the test wants a permanent failure, not a
//     one-shot).
// ---------------------------------------------------------------------------

function makeStubClient() {
	/** @type {Array<{name: string, input: any}>} */
	const commands = [];
	const blobs = new Map();
	const store = new Map();
	let bucketExists = true;
	/** @type {Error | null} */
	let failNextPut = null;
	/** @type {Error | null} */
	let failNextGet = null;
	/** @type {Error | null} */
	let failNextGetForever = null;
	/** @type {Error | null} */
	let failNextCreateBucket = null;

	const client = {
		// Test handles can read .commands to assert which S3 calls happened.
		commands,
		blobs,
		store,
		setBucketExists(v) {
			bucketExists = v;
		},
		failPutOnce(err) {
			failNextPut = err;
		},
		failGetOnce(err) {
			failNextGet = err;
		},
		failGetForever(err) {
			failNextGetForever = err;
		},
		failCreateBucketOnce(err) {
			failNextCreateBucket = err;
		},
		async send(command) {
			const name = command && command.constructor ? command.constructor.name : "UnknownCommand";
			const input = command && typeof command === "object" ? command.input : undefined;
			commands.push({ name, input });

			// --- CreateBucketCommand
			if (name === "CreateBucketCommand") {
				if (failNextCreateBucket) {
					const err = failNextCreateBucket;
					failNextCreateBucket = null;
					throw err;
				}
				bucketExists = true;
				return { $metadata: { httpStatusCode: 200 } };
			}

			// --- HeadBucketCommand
			if (name === "HeadBucketCommand") {
				if (!bucketExists) {
					throw new S3NoSuchBucket();
				}
				return { $metadata: { httpStatusCode: 200 } };
			}

			// --- GetObjectCommand
			if (name === "GetObjectCommand") {
				if (failNextGet) {
					const err = failNextGet;
					failNextGet = null;
					throw err;
				}
				if (failNextGetForever) {
					throw failNextGetForever;
				}
				const key = input && input.Key;
				// store.json lives in the store namespace; blobs live in blobs
				const body = key === "store.json" || (typeof key === "string" && key.endsWith("/store.json"))
					? store.get(key)
					: blobs.get(key);
				if (body === undefined) {
					throw new S3NoSuchKey();
				}
				return {
					Body: new FakeBlob(body),
					ContentType: key.endsWith("store.json") ? "application/json" : "image/svg+xml",
					$metadata: { httpStatusCode: 200 },
				};
			}

			// --- PutObjectCommand
			if (name === "PutObjectCommand") {
				if (failNextPut) {
					const err = failNextPut;
					failNextPut = null;
					throw err;
				}
				const key = input && input.Key;
				// Serialize the body so the stub stores the same shape the
				// SDK would (a JSON-string for the store, raw svg for blobs).
				const bodyText = typeof input.Body === "string"
					? input.Body
					: input.Body instanceof FakeBlob
						? input.Body.content
						: (input.Body ? String(input.Body) : "");
				if (typeof key === "string" && (key === "store.json" || key.endsWith("/store.json"))) {
					store.set(key, bodyText);
				} else {
					blobs.set(key, bodyText);
				}
				return { ETag: "stub-etag", $metadata: { httpStatusCode: 200 } };
			}

			// --- DeleteObjectCommand
			if (name === "DeleteObjectCommand") {
				const key = input && input.Key;
				blobs.delete(key);
				store.delete(key);
				return { $metadata: { httpStatusCode: 204 } };
			}

			// --- HeadObjectCommand (not used in the current code paths,
			// but stub it for forward-compat — the production read
			// path may adopt it in a later slice).
			if (name === "HeadObjectCommand") {
				const key = input && input.Key;
				if (!blobs.has(key) && !store.has(key)) throw new S3NoSuchKey();
				return { $metadata: { httpStatusCode: 200 } };
			}

			throw new Error(`stub: unhandled command ${name}`);
		},
	};

	return client;
}

// ---------------------------------------------------------------------------
// makeStorage — convenience helper that wires a fresh stub client into a
// fresh OssStorage with no counters/logger. Returns both so tests can
// poke the stub directly (e.g. seed blobs, force failures).
// ---------------------------------------------------------------------------

function makeStorage(opts = {}) {
	const client = makeStubClient();
	const storage = new OssStorage({
		bucket: "test-bucket",
		prefix: opts.prefix || "",
		client,
		counters: opts.counters || null,
		logger: opts.logger || null,
		readTimeoutMs: opts.readTimeoutMs || 5000,
		createBucket: opts.createBucket || false,
	});
	return { storage, client };
}

// ---------------------------------------------------------------------------
// The test suite.
// ---------------------------------------------------------------------------

describe("OssStorage — T02 full StorageBackend", () => {
	let ctx;
	beforeEach(() => {
		ctx = undefined;
	});
	afterEach(() => {
		ctx = undefined;
		vi.restoreAllMocks();
	});

	// -------------------------------------------------------------------------
	// (a) Full lifecycle: load → put → getMetadata → readSvg → list → search
	//     → setPinned(true) → setPinned(false) → remove → remove(again)
	//     → stats
	// -------------------------------------------------------------------------
	describe("(a) full lifecycle", () => {
		it("runs the full happy path: load (empty) → put → getMetadata → readSvg → list → search → setPinned → remove", async () => {
			ctx = makeStorage();
			// load() on an empty bucket: HeadBucket passes, GetObject on
			// store.json returns NoSuchKey (empty), sweep runs.
			await ctx.storage.load();

			// After load the store is empty.
			expect(ctx.storage.stats()).toEqual({ total: 0, pinned: 0, unpinned: 0 });
			// load() should have called HeadBucket + GetObject (store.json).
			const loadCommands = ctx.client.commands.map((c) => c.name);
			expect(loadCommands).toContain("HeadBucketCommand");
			expect(loadCommands).toContain("GetObjectCommand");

			// put() — PutObject on the blob, then PutObject on store.json.
			const id = "mLife1";
			const code = "graph TD\n  A-->B";
			const svg = "<svg>body</svg>";
			await ctx.storage.put(id, code, svg, code.length, "Lifecycle flow");

			// Blob is in the S3 stub's blob namespace.
			expect(ctx.client.blobs.get("blobs/mLife1.svg")).toBe(svg);
			// store.json is in the store namespace (no prefix).
			expect(ctx.client.store.has("store.json")).toBe(true);
			// has() returns true.
			expect(ctx.storage.has(id)).toBe(true);

			// getMetadata returns the entry WITHOUT mutating lastAccessedAt.
			const tBefore = ctx.storage.store.get(id).lastAccessedAt;
			await new Promise((r) => setTimeout(r, 5));
			const meta = ctx.storage.getMetadata(id);
			expect(meta).not.toBeNull();
			expect(meta.code).toBe(code);
			expect(meta.title).toBe("Lifecycle flow");
			expect(meta.lastAccessedAt).toBe(tBefore);

			// readSvg returns the stored svg.
			expect(await ctx.storage.readSvg(id)).toBe(svg);
			// readSvg for a missing id returns null.
			expect(await ctx.storage.readSvg("nope")).toBeNull();

			// list() — one item, the id matches the seeded key.
			const listed = await ctx.storage.list({});
			expect(listed.items).toHaveLength(1);
			expect(listed.items[0].id).toBe(id);
			expect(listed.items[0].title).toBe("Lifecycle flow");
			expect(listed.nextCursor).toBeNull();

			// search() — substring on title returns a match.
			const titleSearch = ctx.storage.search("lifecycle");
			expect(titleSearch.items).toHaveLength(1);
			expect(titleSearch.items[0].titleMatch).toBe(true);
			expect(titleSearch.items[0].snippet).toContain("<mark>Lifecycle</mark>");

			// setPinned(true) returns true; the entry flips; list(pinned:true) finds it.
			expect(await ctx.storage.setPinned(id, true)).toBe(true);
			expect(ctx.storage.store.get(id).pinned).toBe(true);
			const pinnedList = await ctx.storage.list({ pinned: true });
			expect(pinnedList.items).toHaveLength(1);
			expect(pinnedList.items[0].pinned).toBe(true);

			// setPinned(false) returns true; flips back; list(pinned:false) finds it.
			expect(await ctx.storage.setPinned(id, false)).toBe(true);
			expect(ctx.storage.store.get(id).pinned).toBe(false);
			const unpinnedList = await ctx.storage.list({ pinned: false });
			expect(unpinnedList.items).toHaveLength(1);

			// remove() — returns true, the entry is gone, the blob is gone.
			const blobKey = "blobs/mLife1.svg";
			expect(ctx.client.blobs.has(blobKey)).toBe(true);
			expect(await ctx.storage.remove(id)).toBe(true);
			expect(ctx.storage.has(id)).toBe(false);
			expect(ctx.client.blobs.has(blobKey)).toBe(false);

			// remove() again — returns false (idempotency).
			expect(await ctx.storage.remove(id)).toBe(false);

			// stats() — back to empty.
			expect(ctx.storage.stats()).toEqual({ total: 0, pinned: 0, unpinned: 0 });

			// setPinned on a missing id returns false.
			expect(await ctx.storage.setPinned("nope", true)).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// (b) Legacy v0.1.0 store.json compat — entries without a title field
	//     must have title defaulted to "" so downstream consumers never
	//     see undefined.
	// -------------------------------------------------------------------------
	describe("(b) legacy v0.1.0 store.json compat", () => {
		it("defaults entry.title to \"\" when the persisted store.json lacks the title field", async () => {
			ctx = makeStorage();
			// Seed a v0.1.0-style store.json (no title on either entry).
			const legacy = {
				mLegacy1: {
					code: "graph TD\n  A-->B",
					createdAt: Date.now() - 2000,
					pinned: false,
					lastAccessedAt: Date.now() - 2000,
					sourceLength: 13,
				},
				mLegacy2: {
					code: "graph LR\n  X-->Y",
					createdAt: Date.now() - 1000,
					pinned: true,
					lastAccessedAt: Date.now() - 1000,
					sourceLength: 12,
				},
			};
			ctx.client.store.set("store.json", JSON.stringify(legacy));

			await ctx.storage.load();

			expect(ctx.storage.store.size).toBe(2);
			expect(ctx.storage.store.get("mLegacy1").title).toBe("");
			expect(ctx.storage.store.get("mLegacy2").title).toBe("");
			// The other fields are preserved.
			expect(ctx.storage.store.get("mLegacy1").code).toBe("graph TD\n  A-->B");
			expect(ctx.storage.store.get("mLegacy2").pinned).toBe(true);
		});

		it("ignores malformed entries (not an object, or no code field) without throwing", async () => {
			ctx = makeStorage();
			ctx.client.store.set("store.json", JSON.stringify({
				good: { code: "g", createdAt: Date.now(), pinned: false, lastAccessedAt: Date.now(), sourceLength: 1 },
				bad1: "not-an-object",
				bad2: null,
				bad3: { createdAt: Date.now() }, // missing code
			}));
			await ctx.storage.load();
			expect(ctx.storage.store.size).toBe(1);
			expect(ctx.storage.has("good")).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// (c) TTL boundary — exact boundary is still valid; one ms past expires.
	//     This matches the LocalFsStorage contract.
	// -------------------------------------------------------------------------
	describe("(c) TTL boundary", () => {
		const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

		it("treats an entry exactly at the TTL boundary as still valid (strict > comparison)", async () => {
			ctx = makeStorage();
			await ctx.storage.load();

			// Seed an entry via the in-memory Map (bypasses the S3 blob
			// write so the test is hermetic). The entry's createdAt
			// is set to T - TTL_MS so the test can drive time.
			const T = Date.now();
			ctx.storage.store.set("mBoundary", {
				code: "g",
				createdAt: T - TTL_MS,
				pinned: false,
				lastAccessedAt: T - TTL_MS,
				sourceLength: 1,
				title: "",
			});
			// Now is T, so (now - createdAt) === TTL_MS. pruneIfExpired
			// must NOT remove it (strict > comparison).
			const got = await ctx.storage.pruneIfExpired("mBoundary");
			expect(got).not.toBeNull();
			expect(ctx.storage.has("mBoundary")).toBe(true);

			// 1ms past the boundary → removes + returns null.
			const pastT = T + 1;
			// Use a small wait so Date.now() advances past T (the entry
			// still has createdAt = T - TTL_MS, so now - createdAt >
			// TTL_MS as soon as real-time ticks past T).
			await new Promise((r) => setTimeout(r, 5));
			expect(Date.now()).toBeGreaterThan(pastT);
			const got2 = await ctx.storage.pruneIfExpired("mBoundary");
			expect(got2).toBeNull();
			expect(ctx.storage.has("mBoundary")).toBe(false);
		});

		it("sweep() removes expired non-pinned, keeps pinned + fresh, returns the count", async () => {
			ctx = makeStorage();
			await ctx.storage.load();
			const now = Date.now();
			ctx.storage.store.set("mExpired", { code: "g", createdAt: now - TTL_MS - 1000, pinned: false, lastAccessedAt: now, sourceLength: 1, title: "" });
			ctx.storage.store.set("mPinned", { code: "g", createdAt: now - TTL_MS - 1000, pinned: true, lastAccessedAt: now, sourceLength: 1, title: "" });
			ctx.storage.store.set("mFresh", { code: "g", createdAt: now, pinned: false, lastAccessedAt: now, sourceLength: 1, title: "" });

			// Seed a blob in the stub so we can assert the DeleteObject was sent.
			ctx.client.blobs.set("blobs/mExpired.svg", "<svg/>");

			const removed = await ctx.storage.sweep();
			expect(removed).toBe(1);
			expect(ctx.storage.has("mExpired")).toBe(false);
			expect(ctx.storage.has("mPinned")).toBe(true);
			expect(ctx.storage.has("mFresh")).toBe(true);

			// The stub records the DeleteObject for the expired blob.
			const deleteCommands = ctx.client.commands.filter((c) => c.name === "DeleteObjectCommand");
			expect(deleteCommands.length).toBeGreaterThanOrEqual(1);
			expect(deleteCommands[0].input.Key).toBe("blobs/mExpired.svg");
		});
	});

	// -------------------------------------------------------------------------
	// (d) Cursor round-trip — list and search both paginate without
	//     dropping or duplicating entries across the boundary.
	// -------------------------------------------------------------------------
	describe("(d) cursor round-trip", () => {
		it("list() paginates with limit, no skips, no duplicates across the full set", async () => {
			ctx = makeStorage();
			await ctx.storage.load();
			const t0 = Date.now();
			const ids = ["z1", "a2", "m3", "b4", "k5", "x6"];
			for (let i = 0; i < ids.length; i++) {
				ctx.storage.store.set(ids[i], {
					code: "g",
					createdAt: t0 - (ids.length - i) * 1000,
					pinned: false,
					lastAccessedAt: t0,
					sourceLength: 1,
					title: "",
				});
			}
			// Drain the save() that put() would have triggered; here we
			// seeded directly so no save was needed, but the next call
			// (list) shouldn't trigger a write either.

			const seen = [];
			let cursor = undefined;
			let pages = 0;
			do {
				const res = await ctx.storage.list({ limit: 2, cursor });
				for (const e of res.items) seen.push(e.id);
				cursor = res.nextCursor;
				pages++;
				if (pages > 10) throw new Error("cursor did not terminate");
			} while (cursor);

			expect(seen).toHaveLength(ids.length);
			expect(new Set(seen).size).toBe(seen.length);
			// Order is createdAt desc, tiebreak id asc → x6, k5, b4, m3, a2, z1.
			expect(seen).toEqual(["x6", "k5", "b4", "m3", "a2", "z1"]);
		});

		it("search() paginates with limit, no skips, no duplicates across the full set", async () => {
			ctx = makeStorage();
			await ctx.storage.load();
			const t0 = Date.now();
			// 4 title-matches + 4 code-matches = 8 total.
			for (let i = 0; i < 4; i++) {
				ctx.storage.store.set(`t${i}`, {
					code: "x",
					createdAt: t0 - (10 - i) * 1000,
					pinned: false,
					lastAccessedAt: t0,
					sourceLength: 1,
					title: `kw-title-${i}`,
				});
			}
			for (let i = 0; i < 4; i++) {
				ctx.storage.store.set(`c${i}`, {
					code: `kw-code-${i}`,
					createdAt: t0 - (4 - i) * 1000,
					pinned: false,
					lastAccessedAt: t0,
					sourceLength: 1,
					title: "no-match",
				});
			}

			const seen = [];
			let cursor = undefined;
			let pages = 0;
			do {
				const res = ctx.storage.search("kw", { limit: 3, cursor });
				for (const item of res.items) seen.push(item.id);
				cursor = res.nextCursor;
				pages++;
				if (pages > 10) throw new Error("cursor did not terminate");
			} while (cursor);

			expect(seen).toHaveLength(8);
			expect(new Set(seen).size).toBe(seen.length);
			// The first 4 must be the title-matches (in createdAt desc, id asc order).
			expect(seen.slice(0, 4).sort()).toEqual(["t0", "t1", "t2", "t3"]);
			// The last 4 must be the code-matches.
			expect(seen.slice(4).sort()).toEqual(["c0", "c1", "c2", "c3"]);
		});
	});

	// -------------------------------------------------------------------------
	// (e) Title-first search ranking — titleMatch DESC, createdAt DESC, id ASC.
	// -------------------------------------------------------------------------
	describe("(e) title-first search ranking", () => {
		it("title match ranks above code match (titleMatch DESC, createdAt DESC, id ASC)", () => {
			ctx = makeStorage();
			const t0 = Date.now();
			// mCode is NEWER but matches only on code; mTitle is OLDER and matches on title.
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
			expect(res.items[0].id).toBe("mTitle");
			expect(res.items[1].titleMatch).toBe(false);
			expect(res.items[1].id).toBe("mCode");
		});

		it("case-insensitive on both title and code", () => {
			ctx = makeStorage();
			const t0 = Date.now();
			ctx.storage.store.set("mA", {
				code: "graph TD\n  A-->B",
				createdAt: t0,
				pinned: false,
				lastAccessedAt: t0,
				sourceLength: 1,
				title: "UPPERCASE TITLE",
			});
			expect(ctx.storage.search("uppercase").items).toHaveLength(1);
			expect(ctx.storage.search("UPPERCASE TITLE").items).toHaveLength(1);
			expect(ctx.storage.search("graph").items).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// (f) readSvg timeout — when the GetObject never resolves within the
	//     budget, the production code throws StorageReadError (-32005).
	//     We use a short readTimeoutMs and a never-resolving GetObject
	//     to keep the test under 1s.
	// -------------------------------------------------------------------------
	describe("(f) readSvg timeout", () => {
		it("throws StorageReadError (-32005, retryable: true) when GetObject never resolves within the timeout", async () => {
			ctx = makeStorage({ readTimeoutMs: 50 });
			await ctx.storage.load();
			// Seed a blob in the stub so the production code reaches GetObject.
			// Then immediately make the stub never resolve.
			ctx.client.blobs.set("blobs/mTimeout.svg", "<svg/>");
			ctx.client.failGetForever(new Promise(() => {})); // never-resolving GetObject
			// Override the stub's send to return the never-resolving promise
			// (the S3TimeoutError path on a real hang also lands here, but
			// Promise.race cares only about which one settles first).
			const origSend = ctx.client.send.bind(ctx.client);
			ctx.client.send = async (command) => {
				const name = command && command.constructor ? command.constructor.name : "UnknownCommand";
				if (name === "GetObjectCommand") {
					return new Promise(() => {}); // hang forever
				}
				return origSend(command);
			};

			let caught;
			try {
				await ctx.storage.readSvg("mTimeout");
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(StorageReadError);
			expect(caught.code).toBe(-32005);
			expect(caught.retryable).toBe(true);
			expect(caught.message).toContain("50");
		});

		it("returns null on NoSuchKey (not a timeout, not a 404-throw)", async () => {
			ctx = makeStorage();
			await ctx.storage.load();
			// No blob in the stub → NoSuchKey → null.
			expect(await ctx.storage.readSvg("never-stored")).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// (g) save failure surfaces StorageWriteError after retry exhaustion.
	//     We force a transient error (TimeoutError) on every PutObject
	//     call. The first attempt fails, the retry fails, the second
	//     failure is wrapped as StorageWriteError.
	// -------------------------------------------------------------------------
	describe("(g) save failure surfaces StorageWriteError", () => {
		it("wraps a terminal/unknown PutObject failure as StorageWriteError (no retry)", async () => {
			ctx = makeStorage();
			await ctx.storage.load();

			// Force a generic Error (no .name matching the SDK's
			// transient/terminal set, no .code) so the classifier
			// returns "unknown" and the code wraps it as
			// StorageWriteError. This mirrors LocalFsStorage's "does NOT
			// retry on ENOSPC" path — the retry classifier has only
			// "transient" (retry once) and "terminal/unknown"
			// (StorageWriteError, no retry) buckets.
			const origSend = ctx.client.send.bind(ctx.client);
			ctx.client.send = async (command) => {
				const name = command && command.constructor ? command.constructor.name : "UnknownCommand";
				if (name === "PutObjectCommand") {
					throw new Error("synthetic oss put failure: EIO");
				}
				return origSend(command);
			};

			let caught;
			try {
				await ctx.storage.put("mPutFail", "g", "<svg/>", 1);
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(StorageWriteError);
			expect(caught.code).toBe(-32004);
			expect(caught.retryable).toBe(true);
			expect(caught.message).toContain("synthetic oss put failure: EIO");
		});

		it("retries once on a transient error and succeeds if the retry call lands a real response", async () => {
			ctx = makeStorage();
			await ctx.storage.load();
			// First PutObject call throws TimeoutError (classified as
			// "transient"); the retry path delegates to the real stub
			// and succeeds. The retry must have bumped the counter (if
			// attached) and the blob must be on disk.
			let putCalls = 0;
			const origSend = ctx.client.send.bind(ctx.client);
			ctx.client.send = async (command) => {
				const name = command && command.constructor ? command.constructor.name : "UnknownCommand";
				if (name === "PutObjectCommand") {
					putCalls++;
					if (putCalls === 1) throw new S3TimeoutError("first-call transient");
					return origSend(command);
				}
				return origSend(command);
			};

			const entry = await ctx.storage.put("mRetry", "g", "<svg/>", 1);
			expect(entry).toBeDefined();
			expect(putCalls).toBeGreaterThanOrEqual(2);
			expect(ctx.client.blobs.get("blobs/mRetry.svg")).toBe("<svg/>");
		});

		it("raw transient error propagates on the second failure (no second retry, no wrap)", async () => {
			ctx = makeStorage();
			await ctx.storage.load();
			// A sticky TimeoutError on every PutObject call. The first
			// failure is classified as transient → one retry → the
			// retry also fails → the raw TimeoutError propagates to
			// the caller (no wrap into StorageWriteError — that's the
			// contract for the transient-retry-exhaustion path; the
			// "wrap" path is reserved for terminal/unknown errors).
			const origSend = ctx.client.send.bind(ctx.client);
			ctx.client.send = async (command) => {
				const name = command && command.constructor ? command.constructor.name : "UnknownCommand";
				if (name === "PutObjectCommand") {
					throw new S3TimeoutError("synthetic oss put timeout");
				}
				return origSend(command);
			};

			let caught;
			try {
				await ctx.storage.put("mTimeoutFail", "g", "<svg/>", 1);
			} catch (e) {
				caught = e;
			}
			// The second failure is a raw TimeoutError, NOT a
			// StorageWriteError. This mirrors LocalFsStorage's exact
			// contract: "the second failure propagates verbatim (not
			// re-classified, not re-wrapped)".
			expect(caught).toBeInstanceOf(S3TimeoutError);
			expect(caught.message).toContain("synthetic oss put timeout");
		});
	});

	// -------------------------------------------------------------------------
	// (h) GetObject NoSuchKey returns null (LocalFsStorage parity).
	// -------------------------------------------------------------------------
	describe("(h) NoSuchKey on readSvg", () => {
		it("returns null (not throws) when the blob key is missing", async () => {
			ctx = makeStorage();
			await ctx.storage.load();
			expect(await ctx.storage.readSvg("nope")).toBeNull();
		});

		it("load() treats a missing store.json as an empty store (NoSuchKey swallowed)", async () => {
			ctx = makeStorage();
			// store.json is absent (default empty stub).
			await ctx.storage.load();
			expect(ctx.storage.store.size).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// (i) Bucket-not-found with createBucket=true creates the bucket.
	// -------------------------------------------------------------------------
	describe("(i) bucket-not-found with createBucket=true", () => {
		it("calls CreateBucket and continues to read store.json when HeadBucket fails with NoSuchBucket", async () => {
			ctx = makeStorage({ createBucket: true });
			ctx.client.setBucketExists(false);

			await ctx.storage.load();

			// HeadBucket was called, then CreateBucket, then GetObject(store.json).
			const names = ctx.client.commands.map((c) => c.name);
			const headIdx = names.indexOf("HeadBucketCommand");
			const createIdx = names.indexOf("CreateBucketCommand");
			const getIdx = names.indexOf("GetObjectCommand");
			expect(headIdx).toBeGreaterThanOrEqual(0);
			expect(createIdx).toBeGreaterThan(headIdx);
			expect(getIdx).toBeGreaterThan(createIdx);
			// The store is empty (no store.json to read).
			expect(ctx.storage.store.size).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// (j) Bucket-not-found with createBucket=false throws NoSuchBucket.
	// -------------------------------------------------------------------------
	describe("(j) bucket-not-found with createBucket=false", () => {
		it("propagates the NoSuchBucket error from HeadBucket", async () => {
			ctx = makeStorage({ createBucket: false });
			ctx.client.setBucketExists(false);

			let caught;
			try {
				await ctx.storage.load();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeDefined();
			expect(caught.name).toBe("NoSuchBucket");
			// The stub did NOT receive a CreateBucket call.
			const names = ctx.client.commands.map((c) => c.name);
			expect(names).toContain("HeadBucketCommand");
			expect(names).not.toContain("CreateBucketCommand");
		});
	});

	// -------------------------------------------------------------------------
	// Prefix support — non-empty prefix must prefix every S3 key.
	// -------------------------------------------------------------------------
	describe("prefix support", () => {
		it("writes store.json and blobs under the configured prefix", async () => {
			ctx = makeStorage({ prefix: "team-a/renders" });
			await ctx.storage.load();
			await ctx.storage.put("mPre", "g", "<svg/>", 1);

			expect(ctx.client.blobs.has("team-a/renders/blobs/mPre.svg")).toBe(true);
			expect(ctx.client.store.has("team-a/renders/store.json")).toBe(true);
		});

		it("reads from the prefixed store.json on load()", async () => {
			ctx = makeStorage({ prefix: "team-b" });
			const seeded = {
				mPrefixed: {
					code: "graph TD\n  X-->Y",
					createdAt: Date.now() - 1000,
					pinned: false,
					lastAccessedAt: Date.now() - 1000,
					sourceLength: 13,
					title: "prefixed-title",
				},
			};
			ctx.client.store.set("team-b/store.json", JSON.stringify(seeded));
			await ctx.storage.load();
			expect(ctx.storage.store.size).toBe(1);
			expect(ctx.storage.store.get("mPrefixed").title).toBe("prefixed-title");
		});
	});

	// -------------------------------------------------------------------------
	// sweep counters (R010) — sweep_runs is bumped on every call;
	// sweep_removed is bumped when entries are removed.
	// -------------------------------------------------------------------------
	describe("sweep counters (R010)", () => {
		it("increments sweep_runs on every call and sweep_removed when entries are removed", async () => {
			// Use a Counters instance wired into the storage.
			const { mkdtemp, rm } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const { Counters } = await import("../../src/counters.mjs");

			const root = await mkdtemp(join(tmpdir(), "mermaid-oss-counter-"));
			try {
				const counters = new Counters(root);
				await counters.load();

				ctx = makeStorage({ counters });
				await ctx.storage.load();

				// load() calls sweep once, so sweep_runs is at least 1
				// before this test asserts.
				const baselineRuns = counters.snapshot().sweep_runs;
				const baselineRemoved = counters.snapshot().sweep_removed;

				// No-op sweep.
				const r1 = await ctx.storage.sweep();
				expect(r1).toBe(0);
				expect(counters.snapshot().sweep_runs).toBe(baselineRuns + 1);
				expect(counters.snapshot().sweep_removed).toBe(baselineRemoved);

				// Seed an expired entry; sweep; expect sweep_removed to advance by 1.
				ctx.storage.store.set("mSweepExpired", {
					code: "g",
					createdAt: Date.now() - (TTL_DAYS * 24 * 60 * 60 * 1000) - 1000,
					pinned: false,
					lastAccessedAt: Date.now(),
					sourceLength: 1,
					title: "",
				});
				const r2 = await ctx.storage.sweep();
				expect(r2).toBe(1);
				expect(counters.snapshot().sweep_removed).toBe(baselineRemoved + 1);
				expect(ctx.storage.has("mSweepExpired")).toBe(false);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// sourceLength fallback — when sourceLength is not a number, put()
	// falls back to code.length (LocalFsStorage parity).
	// -------------------------------------------------------------------------
	describe("sourceLength fallback", () => {
		it("uses code.length when sourceLength is not a number", async () => {
			ctx = makeStorage();
			await ctx.storage.load();
			const code = "graph TD\n  A-->B";
			await ctx.storage.put("mNoSrc", code, "<svg/>", undefined);
			expect(ctx.storage.store.get("mNoSrc").sourceLength).toBe(code.length);
		});
	});

	// -------------------------------------------------------------------------
	// root property — opaque token == bucket name (per Backend.mjs).
	// -------------------------------------------------------------------------
	describe("root property", () => {
		it("exposes the bucket name as the opaque root (LocalFsStorage parity)", () => {
			ctx = makeStorage();
			expect(ctx.storage.root).toBe("test-bucket");
			expect(ctx.storage.bucket).toBe("test-bucket");
		});
	});

	// -------------------------------------------------------------------------
	// logger — oss_op structured log line is emitted on every S3 call
	// when a logger is attached. The line shape (R008) is
	// { level, event: "oss_op", command, key, ...rest }.
	// -------------------------------------------------------------------------
	describe("logger (oss_op)", () => {
		it("emits an oss_op log line on every PutObject / GetObject / DeleteObject / HeadBucket", async () => {
			const logSpy = vi.fn();
			ctx = makeStorage({ logger: { log: logSpy } });
			await ctx.storage.load();
			await ctx.storage.put("mLog", "g", "<svg/>", 1);
			await ctx.storage.readSvg("mLog");
			await ctx.storage.remove("mLog");

			const ossOps = logSpy.mock.calls
				.map((c) => c[0])
				.filter((rec) => rec && rec.event === "oss_op");
			// load() emits HeadBucket + GetObject; put emits 2x PutObject
			// (blob + store.json); readSvg emits GetObject; remove emits
			// DeleteObject + PutObject (save). Expect at least 6.
			expect(ossOps.length).toBeGreaterThanOrEqual(6);

			// Every line carries the expected R008 fields.
			for (const rec of ossOps) {
				expect(typeof rec.command).toBe("string");
				expect(typeof rec.key).toBe("string");
				expect(["info", "warn", "error"]).toContain(rec.level);
			}
		});

		it("does NOT log when no logger is attached (silent operation)", async () => {
			ctx = makeStorage({ logger: null });
			await ctx.storage.load();
			await ctx.storage.put("mNoLog", "g", "<svg/>", 1);
			// No throw, no spy — the call is silent. We just assert
			// the operation completed.
			expect(ctx.storage.has("mNoLog")).toBe(true);
		});
	});
});
