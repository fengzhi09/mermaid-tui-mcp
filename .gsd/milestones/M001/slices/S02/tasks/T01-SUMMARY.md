---
id: T01
parent: S02
milestone: M001
key_files:
  - src/storage/Backend.mjs
  - src/storage/LocalFsStorage.mjs
  - src/server.mjs
  - tests/helpers/storage-fixture.mjs
  - tests/unit/storage.test.mjs
key_decisions:
  - getMetadata (pure) vs pruneIfExpired (bumps lastAccessedAt) split — load-bearing for S02 tool handlers
  - remove() deletes pinned entries (explicit user delete, not sweep)
  - server.mjs render_mermaid handler swapped from removed get() to pruneIfExpired (semantically identical for freshly-put entries)
  - Search snippet is unescaped (consumer is MCP tool handler, not browser); HTML escape lives in renderView (T03)
duration: 
verification_result: passed
completed_at: 2026-06-04T08:08:28.553Z
blocker_discovered: false
---

# T01: Landed StorageBackend interface (JSDoc typedefs) + LocalFsStorage rewrite with getMetadata/remove/list/search/title-defaulted put + legacy v0.1.0 store.json compat; all 34 unit + 65 full-suite tests green.

**Landed StorageBackend interface (JSDoc typedefs) + LocalFsStorage rewrite with getMetadata/remove/list/search/title-defaulted put + legacy v0.1.0 store.json compat; all 34 unit + 65 full-suite tests green.**

## What Happened

## What Shipped

Replaced `src/storage.mjs` with a two-file split that the rest of S02 (T02 zod schemas, T03 registerTool x 7, T04 integration tests) reads through.

**1. `src/storage/Backend.mjs`** — pure JSDoc contract. StorageBackend typedef with all 13 methods (load/save/sweep/put/getMetadata/readSvg/setPinned/remove/list/search/stats/pruneIfExpired + root). Entry shape gains optional `title: ""`. SearchResult items carry `titleMatch: boolean` + `snippet: string`. TTL_DAYS = 7 re-exported. Zero runtime code, `// @ts-check` enabled so JSDoc is checked by IDEs.

**2. `src/storage/LocalFsStorage.mjs`** — line-by-line port of v0.1.0 Storage + the new surface:
- `put(id, code, svg, sourceLength, title?)` — gains optional title last; defaults to "" when omitted so all existing single-arg callers (HTTP /pin, sweep, etc.) keep working
- `getMetadata(id)` — new, pure read, returns null on miss (no lastAccessedAt bump)
- `remove(id)` — new, deletes entry + blob, best-effort unlink mirroring sweep, returns true on hit / false on miss (idempotent)
- `list({limit, cursor, pinned?})` — new, base64 cursor of {createdAt, id}, sorted createdAt desc with id-asc tiebreak, limit clamped to [1,100] defaulting to 20
- `search(query, {limit, cursor, pinned?})` — new, case-insensitive substring on title first (titleMatch:true) then code (titleMatch:false); sort titleMatch DESC → createdAt DESC → id ASC; 60-char `<mark>`-wrapped snippet
- `load()` — defaults `entry.title = ""` for any legacy v0.1.0 entry lacking the field
- `pruneIfExpired(id)` preserved as-is (S01 locked: still bumps lastAccessedAt, used by HTTP /view + /raw/svg)
- Removed v0.1.0 `get(id)` from the public surface (its only remaining consumer was server.mjs's render_mermaid handler, which now uses `pruneIfExpired` — identical semantics for that path, since the entry was just put and is not expired)

**3. `src/storage.mjs` deleted.**

**4. `src/server.mjs` updated** — import line aliased `LocalFsStorage as Storage`; render_mermaid's `storage.get(id)` call swapped for `storage.pruneIfExpired(id)` (kept an `if (!entry) throw` guard for defence-in-depth; the call still produces an Entry because the put just succeeded). The 6 single-name helper re-exports are unchanged so S01's `grep -c "^export" === 6` audit invariant holds.

**5. `tests/helpers/storage-fixture.mjs` updated** — imports `LocalFsStorage` from the new path; rest of the seam (`{storage, root, cleanup}`) unchanged so unit + integration consumers don't churn.

**6. `tests/unit/storage.test.mjs` rewritten** — 34 cases, all green. Preserved S01 assertions exactly: load (3), put+get rewritten to assert on `getMetadata` for no-bump + on `pruneIfExpired` for the bump invariant, has, readSvg, setPinned, pruneIfExpired (4 — TTL boundary, pinned-not-expired, expired-non-pinned-removed, unknown-id), sweep (2), stats, TTL boundary. Added new describe blocks: remove (4: removes+blob, missing-id, pinned entry, idempotency), search (5: title-match with snippet, code-only match, titleMatch ranking, case-insensitive, cursor pagination across title+code+none), list (3: limit pagination, pinned filter, cursor round-trip), getMetadata (2: no-bump, null on miss), put with title (2: persists, defaults ""), load legacy compat (1: v0.1.0-shaped store.json loads with entry.title === "").

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node --check` on all 4 source files + test file | 0 | pass | <1s |
| 2 | `npm test -- tests/unit/storage.test.mjs` | 0 | 34/34 pass | ~175ms |
| 3 | `npm test` (full suite) | 0 | 65 pass / 1 todo / 0 fail | ~5.6s |
| 4 | `grep -c "^export" src/server.mjs` (S01 invariant) | 6 | pass | <1s |

The 1 todo is the eval-09 S02 placeholder (`it.todo`); T02 will flip it to a real assertion.

## Deviations

- **server.mjs uses `pruneIfExpired` instead of `get`**: the plan said "no other callers exist" for `get`, but `server.mjs`'s render_mermaid handler does call `await storage.get(id)` to get the entry back for `renderView`. Rather than re-introducing a deprecated `get()` alias, I swapped the call to `pruneIfExpired` (semantically identical for a freshly-put, never-expired entry) and added an `if (!entry) throw` guard. The aliased import + minimal-diff seam is preserved everywhere else.
- **cursor advance logic**: my first cut walked the sorted array with a `<` / `<=` test, but failed the round-trip test when a fresher entry appeared before the cursor position. Switched to `findIndex` for an exact (createdAt, id) match and start at index+1 — clear, deterministic, and handles deletion-between-pages by falling back to startIdx=0.
- **`backend.mjs` is a typedef-only file** — its 0% line coverage is intentional (no runtime code). Doesn't trip the 80% lines threshold (vitest v3's threshold is reported but not enforced as a hard failure in this project's existing config; pre-existing behaviour from S01).

## Key Decisions

- The `getMetadata` vs `pruneIfExpired` split is a load-bearing contract for S02's 4 id-taking tools. Captured as MEM018 (convention) so future agents don't accidentally call the side-effecting one from a tool handler.
- `remove()` deletes pinned entries (it is an explicit user-initiated delete, not a TTL sweep). The `pinned` flag only exempts from sweep.
- Search's snippet is a pure string with `<mark>` tags — not HTML-escaped — because the consumer is an MCP tool handler, not a browser. `renderView` (T03's job) will escapeHtml the title for the actual view page (R023 XSS guard, see T05).

## Verification

npm test -- tests/unit/storage.test.mjs (34/34 pass); full suite (65/65 pass, 1 todo, 0 fail); node --check on all 4 source files + test file; grep -c "^export" src/server.mjs === 6 (S01 invariant preserved).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node --check src/storage/Backend.mjs && node --check src/storage/LocalFsStorage.mjs && node --check src/server.mjs && node --check tests/helpers/storage-fixture.mjs && node --check tests/unit/storage.test.mjs` | 0 | pass | 500ms |
| 2 | `npm test -- tests/unit/storage.test.mjs` | 0 | pass — 34/34 cases green | 888ms |
| 3 | `npm test` | 0 | pass — 65 pass / 1 todo / 0 fail (full suite) | 5570ms |
| 4 | `grep -c "^export" src/server.mjs` | 0 | pass — S01 invariant preserved (6) | 50ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/storage/Backend.mjs`
- `src/storage/LocalFsStorage.mjs`
- `src/server.mjs`
- `tests/helpers/storage-fixture.mjs`
- `tests/unit/storage.test.mjs`
