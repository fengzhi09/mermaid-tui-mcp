---
estimated_steps: 19
estimated_files: 6
skills_used: []
---

# T01: StorageBackend interface + LocalFsStorage rewrite

Why: The StorageBackend interface is the seam every new tool reads through. If the shape of getMetadata/remove/search/list is wrong, every tool reworks. Land the interface and the new methods first; the rest of the slice (zod schemas, tool handlers, integration tests) all consume this seam.

Do:
1. Create src/storage/Backend.mjs (new). JSDoc typedefs only — no runtime code. Define StorageBackend (root, load, save, sweep, put, getMetadata, readSvg, setPinned, remove, list, search, stats, pruneIfExpired), Entry (code, createdAt, pinned, lastAccessedAt, sourceLength, title?), SearchResult (items[Entry+titleMatch+snippet], nextCursor). Add a // @ts-check comment at the top so JSDoc is type-checked by IDEs.
2. Create src/storage/LocalFsStorage.mjs (new). Port the v0.1.0 Storage class from src/storage.mjs line-by-line, then extend:
   - Constructor unchanged (takes root).
   - load() defaults entry.title = "" for any existing entry that lacks the field — keeps v0.1.0 store.json backward compatible.
   - put(id, code, svg, sourceLength, title?) — gains a trailing optional title param. When provided, sets entry.title = title. When omitted, sets entry.title = "". Existing single-arg callers (HTTP /pin, sweep, etc.) keep working without modification.
   - getMetadata(id) — new method. Returns the entry without mutating lastAccessedAt. Returns null if id is missing. The 4 tools that take {id} (pin / unpin / get / delete) call this instead of the old get() so LLM reads don't fake "recent" activity.
   - remove(id) — new method. Deletes the in-memory entry + the <id>.svg blob (best-effort unlink, silent catch — mirrors sweep's pattern). Calls save(). Returns true if removed, false if id was not in the store.
   - list({limit, cursor, pinned?}) — new method. Returns {items: Entry[], nextCursor: string|null}. Sorts all entries by createdAt desc (tiebreak by id for determinism). Applies pinned filter if provided. Encodes the cursor as base64 of {createdAt, id} and decodes the same on input. limit defaults to 20, clamps to [1, 100]. cursor: null means "start from the top".
   - search(query, {limit, cursor, pinned?}) — new method. Returns {items, nextCursor}. Case-insensitive substring match on title first (sets titleMatch: true), then code (sets titleMatch: false). Sort order: titleMatch DESC, createdAt DESC, id ASC. Each item also gets a snippet field (a 60-char window around the first match in title or code, with the matched substring wrapped in <mark> tags — pure-string, no HTML escape, since the consumer is the MCP tool handler, not a browser).
   - Keep the existing pruneIfExpired(id) (still bumps lastAccessedAt — locked by S01's unit test). Remove the v0.1.0 get() from the public surface (HTTP /view uses pruneIfExpired; no other callers exist).
   - Keep setPinned, readSvg, sweep, save, stats, has as-is.
   - Export TTL_DAYS = 7 (preserved from v0.1.0).
3. Delete src/storage.mjs (replaced by src/storage/LocalFsStorage.mjs).
4. Modify src/server.mjs: change `import { Storage, TTL_DAYS } from "./storage.mjs"` to `import { LocalFsStorage as Storage, TTL_DAYS } from "./storage/LocalFsStorage.mjs"`. The aliased import means the rest of server.mjs can keep calling `new Storage(DATA)` and `storage.put(...)` etc. without churn. (In T03, server.mjs will switch to the MERMAID_RENDERER_BACKEND=local factory — for T01 the alias is the minimal-diff seam.)
5. Modify tests/helpers/storage-fixture.mjs: change the import from `../../src/storage.mjs` to `../../src/storage/LocalFsStorage.mjs`. Rename the class reference from `Storage` to `LocalFsStorage`. The returned object shape ({storage, root, cleanup}) stays the same so unit + integration tests that consume it don't change.
6. Rewrite tests/unit/storage.test.mjs against LocalFsStorage. Preserve the S01 assertions exactly: load() (3 cases), put+get (rewrite to assert on getMetadata for the no-bump invariant + on pruneIfExpired for the bump invariant), has, readSvg, setPinned, pruneIfExpired (4 cases — keep the TTL boundary, the pinned-not-expired, the expired-non-pinned-removed, and the unknown-id cases), sweep (2 cases), stats, TTL boundary (1 case). Add new describe blocks: remove() (4 cases: removes entry + blob; returns false for missing id; works on a pinned entry; idempotency: a second remove returns false), search() (4 cases: title-match with titleMatch:true; code-match with titleMatch:false; title-match ranks above code-match; case-insensitive on both fields; cursor pagination across title+code+none), list() (3 cases: paginates with limit; respects pinned filter; cursor round-trips without skip/duplicate), getMetadata() (2 cases: returns entry without bumping lastAccessedAt; returns null for missing id), put with title (2 cases: title persists in the entry; title defaults to "" when omitted), load() legacy compat (1 case: v0.1.0-shaped store.json loads with entry.title === "").

Done when: npm test -- tests/unit/storage.test.mjs exits 0 with all 23+ cases green; S01's pruneIfExpired lastAccessedAt assertion still holds; the new getMetadata no-bump assertion is also in the file; legacy store.json (no title field) loads cleanly with entry.title === "".

## Inputs

- `src/storage.mjs`
- `src/server.mjs`
- `tests/helpers/storage-fixture.mjs`
- `tests/unit/storage.test.mjs`
- `.gsd/milestones/M001/slices/S02/S02-RESEARCH.md`

## Expected Output

- `src/storage/Backend.mjs`
- `src/storage/LocalFsStorage.mjs`
- `src/server.mjs`
- `tests/helpers/storage-fixture.mjs`
- `tests/unit/storage.test.mjs`

## Verification

npm test -- tests/unit/storage.test.mjs
