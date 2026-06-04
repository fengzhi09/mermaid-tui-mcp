// src/storage/LocalFsStorage.mjs — default StorageBackend impl backed by the
// local filesystem. Renamed from src/storage.mjs and extended with:
//   - put(id, code, svg, sourceLength, title?) — gains an optional title
//   - getMetadata(id) — read without bumping lastAccessedAt
//   - remove(id) — delete entry + blob, return true on hit / false on miss
//   - list({limit, cursor, pinned?}) — paginated, sorted createdAt desc
//   - search(query, {limit, cursor, pinned?}) — title-first ranking, snippets
//
// On-disk layout (unchanged from v0.1.0):
//   <root>/store.json                # { id -> Entry }
//   <root>/blobs/<id>.svg            # rendered SVG body
//
// Sweep policy: any entry where (now - createdAt) > TTL_MS_DEFAULT AND
// !pinned is removed. Sweep runs on load, on every put, and hourly (the
// hourly tick is owned by server.mjs; this class only exposes sweep()).

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const TTL_DAYS_DEFAULT = 7;
const TTL_MS_DEFAULT = TTL_DAYS_DEFAULT * 24 * 60 * 60 * 1000;
const SNIPPET_RADIUS = 30; // 30 chars on each side of the match → 60-ish char window
const SNIPPET_HARD_MAX = 80; // safety cap on snippet length

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
	 */
	constructor(root) {
		this.root = root;
		this.storePath = join(root, "store.json");
		this.blobsDir = join(root, "blobs");
		this.store = new Map();
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
		await writeFile(this.storePath, JSON.stringify(obj, null, 2));
	}

	async sweep() {
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
		if (removed > 0) await this.save();
		return removed;
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
		await writeFile(join(this.blobsDir, `${id}.svg`), svg, "utf-8");
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
		try {
			return await readFile(join(this.blobsDir, `${id}.svg`), "utf-8");
		} catch {
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

		return {
			items: page.map(([, e]) => e),
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

		return {
			items: pageRaw.map((m) => ({ ...m.entry, titleMatch: m.titleMatch, snippet: m.snippet })),
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
