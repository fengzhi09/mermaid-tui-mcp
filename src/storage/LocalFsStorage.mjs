// src/storage/LocalFsStorage.mjs — default StorageBackend impl backed by the
// local filesystem. Renamed from src/storage.mjs and extended with:
//   - put(id, code, svg, sourceLength, title?) — gains an optional title
//   - getMetadata(id) — read without bumping lastAccessedAt
//   - remove(id) — delete entry + blob, return true on hit / false on miss
//   - list({limit, cursor, pinned?}) — paginated, sorted createdAt desc
//   - search(query, {limit, cursor, pinned?}) — title-first ranking, snippets
//   - S03: constructor accepts optional { counters, logger } (R010 + R008 surface)
//   - S03: writeFile wrapped in retryOnce(classify) (R017 — EAGAIN/EWOULDBLOCK retry,
//     ENOSPC/EACCES terminal, other unknown → StorageWriteError -32004)
//   - S03: readFile in readSvg wrapped in 5s timeout (StorageReadError -32005)
//   - S03: save() uses tmp+rename atomic write (R010)
//   - S03: sweep() increments sweep_runs (always) + sweep_removed (when count > 0)
//   - S03: list() and search() project {id, ...e} (MEM024 fix)
//
// On-disk layout (unchanged from v0.1.0):
//   <root>/store.json                # { id -> Entry }     (persisted by save())
//   <root>/store.json.tmp            # atomic-write staging file
//   <root>/blobs/<id>.svg            # rendered SVG body
//
// Sweep policy: any entry where (now - createdAt) > TTL_MS_DEFAULT AND
// !pinned is removed. Sweep runs on load, on every put, and hourly (the
// hourly tick is owned by server.mjs; this class only exposes sweep()).

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { StorageWriteError, StorageReadError } from "../tools.mjs";

const TTL_DAYS_DEFAULT = 7;
const TTL_MS_DEFAULT = TTL_DAYS_DEFAULT * 24 * 60 * 60 * 1000;
const SNIPPET_RADIUS = 30; // 30 chars on each side of the match → 60-ish char window
const SNIPPET_HARD_MAX = 80; // safety cap on snippet length
const READ_TIMEOUT_MS_DEFAULT = 5000; // R005 — 5s read timeout for readSvg()

// ---------------------------------------------------------------------------
// Test seams — module-level so the unit tests can replace the underlying
// node:fs/promises calls without touching the class instance. The defaults
// are the real implementations; passing `null` to a seam restores them
// (natural afterEach cleanup pattern, mirrors src/render.mjs's seams).
// ---------------------------------------------------------------------------

let _writeFileImpl = (path, content) => writeFile(path, content, "utf-8");
let _readFileImpl = (path) => readFile(path, "utf-8");
let _readTimeoutMs = READ_TIMEOUT_MS_DEFAULT;

/**
 * Build a 60-char-ish window around the first case-insensitive match
 * of `needle` in `haystack`, with the match wrapped in <mark> tags.
 * Pure-string (no HTML escape) — the consumer is an MCP tool handler,
 * not a browser.
 *
 * @param {string} haystack
 * @param {string} needle   pre-lowered
 * @returns {string}
 */
function buildSnippet(haystack, needle) {
	if (!needle) return "";
	const lower = haystack.toLowerCase();
	const idx = lower.indexOf(needle);
	if (idx < 0) return "";
	const start = Math.max(0, idx - SNIPPET_RADIUS);
	const end = Math.min(haystack.length, idx + needle.length + SNIPPET_RADIUS);
	const before = haystack.slice(start, idx);
	const match = haystack.slice(idx, idx + needle.length);
	const after = haystack.slice(idx + needle.length, end);
	let snippet = `${start > 0 ? "…" : ""}${before}<mark>${match}</mark>${after}${end < haystack.length ? "…" : ""}`;
	if (snippet.length > SNIPPET_HARD_MAX) snippet = snippet.slice(0, SNIPPET_HARD_MAX) + "…";
	return snippet;
}

/**
 * Encode / decode the opaque cursor for list() and search(). The cursor
 * is base64 of "{createdAt}:{id}" so it round-trips through JSON.
 *
 * @param {{createdAt: number, id: string}|null} pos
 * @returns {string|null}
 */
function encodeCursor(pos) {
	if (!pos) return null;
	return Buffer.from(`${pos.createdAt}:${pos.id}`, "utf-8").toString("base64");
}

/**
 * @param {string|null|undefined} cursor
 * @returns {{createdAt: number, id: string}|null}
 */
function decodeCursor(cursor) {
	if (!cursor) return null;
	try {
		const decoded = Buffer.from(cursor, "base64").toString("utf-8");
		const sep = decoded.indexOf(":");
		if (sep < 0) return null;
		const createdAt = Number.parseInt(decoded.slice(0, sep), 10);
		const id = decoded.slice(sep + 1);
		if (!Number.isFinite(createdAt) || !id) return null;
		return { createdAt, id };
	} catch {
		return null;
	}
}

export class LocalFsStorage {
	/**
	 * @param {string} root  data dir (or equivalent; opaque to consumers)
	 * @param {{counters?: import("../counters.mjs").Counters | null, logger?: {log?: Function} | null}} [opts]
	 *   S03 optional surface. counters is incremented on transient write retries,
	 *   on every sweep pass, and per removed entry. logger is reserved for future
	 *   structured-log call sites (T05); the constructor accepts it so the
	 *   server.mjs wiring seam stays uniform with the counters arg.
	 */
	constructor(root, opts = {}) {
		this.root = root;
		this.storePath = join(root, "store.json");
		this.tmpPath = join(root, "store.json.tmp");
		this.blobsDir = join(root, "blobs");
		this.store = new Map();
		this.counters = opts.counters ?? null;
		this.logger = opts.logger ?? null;
	}

	async load() {
		await mkdir(this.blobsDir, { recursive: true });
		if (existsSync(this.storePath)) {
			try {
				const raw = await readFile(this.storePath, "utf-8");
				const obj = JSON.parse(raw);
				for (const [k, v] of Object.entries(obj)) {
					if (v && typeof v === "object" && typeof v.code === "string") {
						// Legacy v0.1.0 entries lack `title`; default to "" so
						// downstream consumers (search, get_diagram) never see undefined.
						if (typeof v.title !== "string") v.title = "";
						this.store.set(k, v);
					}
				}
			} catch {
				// corrupted; start fresh
			}
		}
		await this.sweep();
	}

	async save() {
		const obj = Object.fromEntries(this.store);
		const json = JSON.stringify(obj, null, 2);
		// Atomic tmp+rename (R010). The writeFile side goes through
		// _writeFileWithRetry so a transient EAGAIN on the tmp write
		// triggers a single retry before a StorageWriteError surfaces. A
		// crash mid-rename leaves the .tmp behind — the next save()
		// overwrites it; load() does not need to clean it up because
		// save() is the only writer. On POSIX the rename is atomic; on
		// NTFS (Windows) it is near-atomic — the worst-case observable
		// state is either the old store.json OR the new one, never a
		// half-written mix.
		const tmpPath = this.tmpPath;
		await this._writeFileWithRetry(async () => {
			await _writeFileImpl(tmpPath, json);
		});
		await rename(this.tmpPath, this.storePath);
	}

	async sweep() {
		// R010: bump sweep_runs on every call (even if nothing is removed).
		// Failure mode: if a previous sweep() throws between the counter
		// increment and the save(), the counter has already advanced. That's
		// the correct observable — a sweep was attempted. Counters reflect
		// intent, not success.
		if (this.counters) {
			await this.counters.increment("sweep_runs");
		}
		const now = Date.now();
		let removed = 0;
		for (const [id, entry] of [...this.store.entries()]) {
			if (!entry.pinned && now - entry.createdAt > TTL_MS_DEFAULT) {
				this.store.delete(id);
				const blobPath = join(this.blobsDir, `${id}.svg`);
				if (existsSync(blobPath)) {
					try {
						await unlink(blobPath);
					} catch {
						// best-effort
					}
				}
				removed++;
			}
		}
		if (removed > 0) {
			if (this.counters) {
				// Counters.increment(key) bumps by 1; we want sweep_removed to
				// advance by `removed`. The single-flight _writeChain
				// serializes all of these so concurrent sweeps can't lose
				// updates. Awaiting each one keeps the call site
				// straightforward; the cost is N small atomic writes per sweep,
				// which is fine for the expected batch size (handful of entries).
				for (let i = 0; i < removed; i++) {
					await this.counters.increment("sweep_removed");
				}
			}
			await this.save();
		}
		return removed;
	}

	/**
	 * Wrap a single writeFile call in the R017 retry policy: on transient
	 * errors (EAGAIN, EWOULDBLOCK) call fn() once more; on terminal or
	 * unknown errors throw StorageWriteError(-32004) with the original
	 * error message so callers see a tagged failure. On the retry path,
	 * bump the storage_write_retries counter (if attached).
	 *
	 * The retry is bounded to exactly one extra attempt — the second
	 * failure propagates verbatim (not re-classified, not re-wrapped),
	 * which means a permanent EAGAIN surfaces as a raw EAGAIN error to
	 * the caller. The plan mandates "no second retry" so we honor that.
	 *
	 * @param {() => Promise<void>} fn
	 * @returns {Promise<void>}
	 */
	async _writeFileWithRetry(fn) {
		try {
			await fn();
		} catch (firstErr) {
			const classification = _classifyWriteError(firstErr);
			if (classification === "transient") {
				if (this.counters) {
					await this.counters.increment("storage_write_retries");
				}
				return await fn(); // single retry, no further classification
			}
			// terminal or unknown → wrap as StorageWriteError
			const msg = firstErr && typeof firstErr === "object" && typeof firstErr.message === "string"
				? firstErr.message
				: String(firstErr);
			throw new StorageWriteError(msg);
		}
	}

	/**
	 * @param {string} id
	 * @param {string} code
	 * @param {string} svg
	 * @param {number} sourceLength
	 * @param {string} [title]
	 * @returns {Promise<import("./Backend.mjs").Entry>}
	 */
	async put(id, code, svg, sourceLength, title) {
		const entry = {
			code,
			createdAt: Date.now(),
			pinned: false,
			lastAccessedAt: Date.now(),
			sourceLength: typeof sourceLength === "number" ? sourceLength : code.length,
			title: typeof title === "string" ? title : "",
		};
		this.store.set(id, entry);
		const blobPath = join(this.blobsDir, `${id}.svg`);
		await this._writeFileWithRetry(async () => {
			await _writeFileImpl(blobPath, svg);
		});
		await this.save();
		return entry;
	}

	has(id) {
		return this.store.has(id);
	}

	/**
	 * Read the entry WITHOUT mutating lastAccessedAt. The 4 tools that
	 * take {id} (pin / unpin / get / delete) call this so LLM reads
	 * don't fake "recent" activity. HTTP /view and /raw/svg keep using
	 * pruneIfExpired (which still bumps) — that path is locked by S01.
	 *
	 * @param {string} id
	 * @returns {import("./Backend.mjs").Entry|null}
	 */
	getMetadata(id) {
		const entry = this.store.get(id);
		return entry ? entry : null;
	}

	async readSvg(id) {
		const blobPath = join(this.blobsDir, `${id}.svg`);
		const timeoutMs = _readTimeoutMs;
		// R005: 5s read timeout. Promise.race resolves to the timeoutPromise
		// rejection if the underlying readFile doesn't complete in time. The
		// timer is always cleared in finally so a successful read doesn't
		// leave a dangling setTimeout that would fire on the next tick.
		let timer;
		const timeoutPromise = new Promise((_, reject) => {
			timer = setTimeout(
				() => reject(new StorageReadError(`svg read timed out after ${timeoutMs}ms`)),
				timeoutMs,
			);
		});
		try {
			const readPromise = _readFileImpl(blobPath);
			const result = await Promise.race([readPromise, timeoutPromise]);
			clearTimeout(timer);
			return result;
		} catch (e) {
			clearTimeout(timer);
			// StorageReadError (timeout) propagates as a tagged failure so
			// registerTools (T05) can map it to the -32005 inner-payload.
			// All other errors (ENOENT, EACCES, etc.) preserve the v0.1.0
			// "return null on miss" behavior — the storage treats a missing
			// blob the same as a non-existent entry.
			if (e instanceof StorageReadError) throw e;
			return null;
		}
	}

	async setPinned(id, pinned) {
		const entry = this.store.get(id);
		if (!entry) return false;
		entry.pinned = !!pinned;
		await this.save();
		return true;
	}

	/**
	 * @param {string} id
	 * @returns {Promise<boolean>}  true if removed, false if id was not in the store.
	 */
	async remove(id) {
		const entry = this.store.get(id);
		if (!entry) return false;
		this.store.delete(id);
		const blobPath = join(this.blobsDir, `${id}.svg`);
		if (existsSync(blobPath)) {
			try {
				await unlink(blobPath);
			} catch {
				// best-effort unlink, mirrors sweep
			}
		}
		await this.save();
		return true;
	}

	/**
	 * @param {{limit?: number, cursor?: string, pinned?: boolean}} [opts]
	 * @returns {Promise<import("./Backend.mjs").ListResult>}
	 */
	async list(opts = {}) {
		const limitRaw = opts.limit == null ? 20 : opts.limit;
		const limit = Math.min(100, Math.max(1, Math.floor(limitRaw)));
		const cursorPos = decodeCursor(opts.cursor);
		const pinnedFilter = typeof opts.pinned === "boolean" ? opts.pinned : null;

		const all = [...this.store.entries()]
			.filter(([, e]) => (pinnedFilter == null ? true : e.pinned === pinnedFilter))
			.sort((a, b) => {
				// createdAt desc, tiebreak id asc (deterministic)
				if (b[1].createdAt !== a[1].createdAt) return b[1].createdAt - a[1].createdAt;
				return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
			});

		// Apply cursor: the cursor references the LAST item of the previous
		// page. Find the index of that exact (createdAt, id) pair and start
		// the next page at index+1. If the cursor doesn't resolve (e.g. the
		// entry was deleted between calls), fall back to startIdx=0.
		let startIdx = 0;
		if (cursorPos) {
			const foundAt = all.findIndex(([id, e]) => e.createdAt === cursorPos.createdAt && id === cursorPos.id);
			if (foundAt >= 0) startIdx = foundAt + 1;
		}

		const page = all.slice(startIdx, startIdx + limit);
		const hasMore = startIdx + limit < all.length;
		const last = page[page.length - 1];
		const nextCursor = hasMore && last ? encodeCursor({ createdAt: last[1].createdAt, id: last[0] }) : null;

		// MEM024 fix: project {id, ...entry} so the caller can pin/get/delete
		// by reference. Pre-MEM024, this returned `page.map(([, e]) => e)`
		// which dropped the map key — the only stable identifier for an
		// entry. The id is now part of the returned object, matching the
		// updated ListResult.items typedef in src/storage/Backend.mjs.
		return {
			items: page.map(([id, e]) => ({ id, ...e })),
			nextCursor,
		};
	}

	/**
	 * @param {string} query
	 * @param {{limit?: number, cursor?: string, pinned?: boolean}} [opts]
	 * @returns {import("./Backend.mjs").SearchResult}
	 */
	search(query, opts = {}) {
		const q = (query || "").toLowerCase();
		const limitRaw = opts.limit == null ? 20 : opts.limit;
		const limit = Math.min(100, Math.max(1, Math.floor(limitRaw)));
		const cursorPos = decodeCursor(opts.cursor);
		const pinnedFilter = typeof opts.pinned === "boolean" ? opts.pinned : null;

		// Collect (id, entry) pairs that match the pinned filter, then build a
		// flat match record. Match: title first (titleMatch: true), then code
		// (titleMatch: false). Empty query matches nothing.
		const all = [...this.store.entries()].filter(([, e]) => (pinnedFilter == null ? true : e.pinned === pinnedFilter));

		/** @type {Array<{id: string, entry: import("./Backend.mjs").Entry, titleMatch: boolean, snippet: string}>} */
		const matched = [];
		for (const [id, e] of all) {
			const title = (e.title || "").toLowerCase();
			const code = (e.code || "").toLowerCase();
			let titleMatch = false;
			let hitField = null;
			if (q && title.includes(q)) {
				titleMatch = true;
				hitField = e.title || "";
			} else if (q && code.includes(q)) {
				hitField = e.code || "";
			} else {
				continue;
			}
			matched.push({ id, entry: e, titleMatch, snippet: buildSnippet(hitField, q) });
		}

		// Sort: titleMatch DESC, createdAt DESC, id ASC (deterministic).
		matched.sort((a, b) => {
			if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
			if (b.entry.createdAt !== a.entry.createdAt) return b.entry.createdAt - a.entry.createdAt;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});

		// Apply cursor: the cursor references the LAST item of the previous
		// page. Find the index of that exact (createdAt, id) pair and start
		// the next page at index+1. If the cursor doesn't resolve, start
		// from the top.
		let startIdx = 0;
		if (cursorPos) {
			const foundAt = matched.findIndex((m) => m.entry.createdAt === cursorPos.createdAt && m.id === cursorPos.id);
			if (foundAt >= 0) startIdx = foundAt + 1;
		}

		const pageRaw = matched.slice(startIdx, startIdx + limit);
		const hasMore = startIdx + limit < matched.length;
		const last = pageRaw[pageRaw.length - 1];
		const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.entry.createdAt, id: last.id }) : null;

		// MEM024 fix: project {id, ...entry, titleMatch, snippet} so the
		// caller can pin/get/delete by reference. Pre-MEM024, this returned
		// `{ ...m.entry, titleMatch, snippet }` which dropped the map key.
		// The id is now the first field of the returned object.
		return {
			items: pageRaw.map((m) => ({ id: m.id, ...m.entry, titleMatch: m.titleMatch, snippet: m.snippet })),
			nextCursor,
		};
	}

	/**
	 * Returns the entry if present and not expired. Removes + returns null
	 * if expired. Callers should treat null as 404. Still bumps
	 * lastAccessedAt (S01's locked behaviour, used by HTTP /view and /raw/svg).
	 *
	 * @param {string} id
	 * @returns {Promise<import("./Backend.mjs").Entry|null>}
	 */
	async pruneIfExpired(id) {
		const entry = this.store.get(id);
		if (!entry) return null;
		if (!entry.pinned && Date.now() - entry.createdAt > TTL_MS_DEFAULT) {
			this.store.delete(id);
			const blobPath = join(this.blobsDir, `${id}.svg`);
			if (existsSync(blobPath)) {
				try {
					await unlink(blobPath);
				} catch {
					// best-effort
				}
			}
			await this.save();
			return null;
		}
		entry.lastAccessedAt = Date.now();
		return entry;
	}

	stats() {
		let pinned = 0;
		for (const e of this.store.values()) if (e.pinned) pinned++;
		return { total: this.store.size, pinned, unpinned: this.store.size - pinned };
	}
}

export const TTL_DAYS = TTL_DAYS_DEFAULT;

// ---------------------------------------------------------------------------
// Module-level helpers (intentionally not on the class — they're pure
// functions of the thrown error, not of the storage state).
// ---------------------------------------------------------------------------

/**
 * Classify a writeFile failure into the R017 buckets:
 *   - "transient": EAGAIN, EWOULDBLOCK — retry once
 *   - "terminal":  ENOSPC, EACCES — no retry, surface StorageWriteError
 *   - "unknown":   anything else — no retry, surface StorageWriteError
 *
 * @param {unknown} err
 * @returns {"transient" | "terminal" | "unknown"}
 */
function _classifyWriteError(err) {
	const code = err && typeof err === "object" ? /** @type {any} */ (err).code : undefined;
	if (code === "EAGAIN" || code === "EWOULDBLOCK") return "transient";
	if (code === "ENOSPC" || code === "EACCES") return "terminal";
	return "unknown";
}

// ---------------------------------------------------------------------------
// Test seams (no-ops when not called; live alongside the class). The unit
// tests in tests/unit/storage.test.mjs use these to inject transient
// errors, terminal errors, and never-resolving reads without touching the
// real filesystem.
//
// Pass `null` to restore the default behavior (real node:fs/promises impl).
// This matches src/render.mjs's reset-to-default pattern.
// ---------------------------------------------------------------------------

/**
 * Replace the internal writeFile call. The supplied function takes
 * `(path, content)` and returns a Promise<void>. Pass `null` to restore
 * the real `writeFile(path, content, "utf-8")`. Used by the EAGAIN retry
 * test (throw on first call, succeed on second) and the ENOSPC no-retry
 * test (throw with code "ENOSPC" on first call).
 *
 * @param {((path: string, content: string) => Promise<void>) | null} fn
 */
export function __setWriteFileForTesting(fn) {
	_writeFileImpl = typeof fn === "function" ? fn : (path, content) => writeFile(path, content, "utf-8");
}

/**
 * Replace the internal readFile call. The supplied function takes
 * `(path)` and returns a `Promise<string>`. Pass `null` to restore the
 * real `readFile(path, "utf-8")`. Used by the read-timeout test (return
 * a never-resolving promise to force the Promise.race → timeout path).
 *
 * @param {((path: string) => Promise<string>) | null} fn
 */
export function __setReadFileForTesting(fn) {
	_readFileImpl = typeof fn === "function" ? fn : (path) => readFile(path, "utf-8");
}

/**
 * Override the readSvg timeout for tests. The production path uses
 * READ_TIMEOUT_MS_DEFAULT (5000ms); this seam lets the read-timeout test
 * force a short timeout (e.g. 50ms) so the test completes in < 1s. Pass
 * `null` to restore the default 5000ms.
 *
 * Note: this seam is NOT in the plan's item 4 list (which named only
 * __setWriteFileForTesting + __setReadFileForTesting) but test 3c needs
 * a way to set a short read timeout. Following the pattern from
 * src/render.mjs's `__setRenderTimeoutForTesting` (T03), the seam is
 * added as a minor deviation — documented in the SUMMARY's Deviations
 * section.
 *
 * @param {number | null} ms
 */
export function __setReadTimeoutForTesting(ms) {
	_readTimeoutMs = typeof ms === "number" && ms > 0 ? ms : READ_TIMEOUT_MS_DEFAULT;
}
