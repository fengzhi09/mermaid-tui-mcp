// @ts-check
// src/storage/Backend.mjs — StorageBackend interface (JSDoc typedefs only).
//
// This file has no runtime code; it documents the contract every concrete
// storage implementation must satisfy. The slice's default impl
// (LocalFsStorage) lives at src/storage/LocalFsStorage.mjs. M002's
// OssStorage (or any future backend) just has to expose the same method
// names — there is no inheritance requirement (structural typing via
// JSDoc in plain-JS).
//
// JSDoc usage conventions:
//   - @returns marks async return shapes (Promise<T>)
//   - @property annotates fields on object typedefs
//   - nullable returns are explicit (T | null, not T)
//
// Why this file exists: every new tool (pin_mermaid, unpin_mermaid,
// list_diagrams, get_diagram, delete_mermaid, search_diagrams) reads
// through this seam. If the shape of getMetadata / remove / search /
// list is wrong, every tool reworks. Land the interface first; tools
// follow.

/**
 * @typedef {Object} Entry
 * @property {string} code            The Mermaid source that was rendered.
 * @property {number} createdAt      Epoch ms when the entry was first stored.
 * @property {boolean} pinned         Pin flag — true skips the TTL sweep.
 * @property {number} lastAccessedAt  Epoch ms of the last read (bumped by pruneIfExpired only).
 * @property {number} sourceLength    Length of the source (may differ from code.length for trimmed input).
 * @property {string} [title]         Optional human label. Defaults to "" for v0.1.0 store.json entries.
 */

/**
 * @typedef {Object} ListOptions
 * @property {number} [limit]    Max items to return. Default 20. Clamped to [1, 100].
 * @property {string} [cursor]   Opaque base64 cursor from a previous nextCursor. Omit / null to start from the top.
 * @property {boolean} [pinned]  Optional filter — true returns only pinned entries, false only unpinned.
 */

/**
 * @typedef {Object} ListResult
 * @property {Array<Entry & {id: string}>} items
 *   The page of entries, sorted by createdAt desc, tiebreak id asc. S03
 *   MEM024 fix: each item carries its `id` (the storage map key) so the
 *   caller can pin / get / delete by reference without a second lookup.
 * @property {string|null} nextCursor Opaque base64 cursor for the next page, or null when the page is the last.
 */

/**
 * @typedef {Object} SearchResult
 * @property {Array<Entry & {id: string, titleMatch: boolean, snippet: string}>} items
 *   titleMatch=true means the match hit the title; false means it hit the code.
 *   snippet is a 60-char window around the first match with <mark> tags wrapping the hit.
 *   S03 MEM024 fix: each item carries its `id` (the storage map key) so the
 *   caller can pin / get / delete by reference.
 * @property {string|null} nextCursor Same shape as ListResult.nextCursor.
 */

/**
 * @typedef {Object} StorageBackend
 *
 * @property {string} root  Data directory (or bucket name, or equivalent — opaque to the consumer).
 *
 * @property {() => Promise<void>} load
 *   Idempotent. Scans existing on-disk data, populates the in-memory index, runs a sweep pass.
 *   Legacy entries (v0.1.0 shape) must have `title` defaulted to "" so the new code never sees undefined.
 *
 * @property {() => Promise<number>} sweep
 *   Removes every entry where (now - createdAt) > TTL_MS AND !pinned. Best-effort unlink of the
 *   <id>.svg blob. Persists the index if anything was removed. Returns the count removed.
 *
 * @property {() => Promise<void>} save
 *   Persists the in-memory index to durable storage. Idempotent.
 *
 * @property {(id: string, code: string, svg: string, sourceLength: number, title?: string) => Promise<Entry>} put
 *   Stores code, writes the blob, persists. When `title` is omitted, entry.title is set to "".
 *
 * @property {(id: string) => (Entry|null)} getMetadata
 *   Returns the entry without mutating lastAccessedAt. The 4 tools that take {id}
 *   (pin / unpin / get / delete) call this so LLM reads don't fake "recent" activity.
 *   Returns null when the id is not present.
 *
 * @property {(id: string) => Promise<string|null>} readSvg
 *   Returns the raw SVG body for the id, or null if the blob is missing.
 *
 * @property {(id: string, pinned: boolean) => Promise<boolean>} setPinned
 *   Flips the pin flag. Returns true on success, false if the id is not in the store.
 *
 * @property {(id: string) => Promise<boolean>} remove
 *   Deletes the in-memory entry and the <id>.svg blob. Persists the index.
 *   Best-effort unlink (silent catch, mirrors sweep). Returns true if removed, false if id was not in the store.
 *
 * @property {() => Promise<ListResult>} list
 *   Returns all entries (subject to the optional filter), sorted by createdAt desc, tiebreak id asc.
 *   Paginates via opaque base64 cursor of {createdAt, id}.
 *
 * @property {(query: string, opts?: {limit?: number, cursor?: string, pinned?: boolean}) => SearchResult} search
 *   Case-insensitive substring match on title first (titleMatch: true), then code (titleMatch: false).
 *   Sort: titleMatch DESC, createdAt DESC, id ASC. Each item carries a 60-char snippet around the first match.
 *
 * @property {() => {total: number, pinned: number, unpinned: number}} stats
 *   Synchronous counts. Used by /health and the stdio MCP tools.
 *
 * @property {(id: string) => Promise<(Entry|null)>} pruneIfExpired
 *   Returns the entry if present and not expired (bumps lastAccessedAt).
 *   Removes + returns null if expired and !pinned.
 *   Returns the entry for an expired PINNED id (sweep must not delete it).
 *   Returns null for an unknown id.
 */

export const TTL_DAYS = 7;
