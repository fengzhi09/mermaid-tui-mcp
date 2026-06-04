---
id: T04
parent: S03
milestone: M001
key_files:
  - src/storage/LocalFsStorage.mjs
  - src/storage/Backend.mjs
  - tests/unit/storage.test.mjs
key_decisions:
  - Added a 3rd test seam __setReadTimeoutForTesting(ms) (deviation from item 4) — test 3c needs a short read timeout to fire in < 1s; mirrors T03's __setRenderTimeoutForTesting pattern
  - _writeFileWithRetry is a class method (not a free function) — needs this.counters to bump storage_write_retries on the transient-retry path
  - The retry's second attempt does NOT go through classify — plan mandates "no second retry", so a permanent EAGAIN propagates as a raw EAGAIN error to the caller
  - sweep_removed uses a for-loop calling increment(key) once per removed entry (not a add(key, delta) method) — uses the existing Counters API; the single-flight _writeChain serializes the loop's increments so concurrent sweeps can't lose updates
  - _classifyWriteError is a module-level helper (not a class method) — pure function of the thrown error, not of the storage state
  - Read timeout preserves the v0.1.0 "404 = null" contract for ENOENT (only StorageReadError propagates; other errors return null) — keeps the existing integration test contract; the S03 addition is the timeout case which is a new failure mode distinct from "the blob isn't there"
duration: 
verification_result: passed
completed_at: 2026-06-04T11:47:59.999Z
blocker_discovered: false
---

# T04: Added write retry (EAGAIN/EWOULDBLOCK → 1 retry, ENOSPC/EACCES → StorageWriteError -32004), 5s read timeout (StorageReadError -32005), tmp+rename atomic save, sweep counter hooks (sweep_runs + sweep_removed), and the MEM024 id projection to LocalFsStorage (with 3 test seams for unit-testability).

**Added write retry (EAGAIN/EWOULDBLOCK → 1 retry, ENOSPC/EACCES → StorageWriteError -32004), 5s read timeout (StorageReadError -32005), tmp+rename atomic save, sweep counter hooks (sweep_runs + sweep_removed), and the MEM024 id projection to LocalFsStorage (with 3 test seams for unit-testability).**

## What Happened

## T04: Add write retry, read timeout, atomic save, sweep counters, and MEM024 id projection to LocalFsStorage

### What shipped

**`src/storage/LocalFsStorage.mjs` — 8 changes**

1. **Optional `{ counters, logger }` opts on constructor** (R010 + R008 seam). The counters is incremented on transient write retries, on every sweep pass, and per removed entry. The logger is reserved for future structured-log call sites (T05 will wire it). The v0.1.0 single-arg signature still works — all existing tests are unaffected.

2. **`_writeFileWithRetry(fn)` private method** wraps the 2 writeFile sites (save's tmp-write and put's blob-write) in the R017 retry policy:
   - First-attempt failure → classify as `transient` (EAGAIN/EWOULDBLOCK) or `terminal` (ENOSPC/EACCES) or `unknown` (everything else)
   - `transient` → bump `storage_write_retries` counter (if attached) and call fn() once more. No second retry.
   - `terminal` or `unknown` → throw `StorageWriteError` (code -32004, retryable: true) with the original error message. Terminal errors never retry, never bump the counter.

3. **`save()` uses tmp+rename atomic write** (R010). Writes to `<root>/store.json.tmp` (through the retry wrapper) then `rename`s to `<root>/store.json`. On POSIX the rename is atomic; on NTFS (Windows) it is near-atomic — the worst-case observable state is either the old store.json OR the new one, never a half-written mix. A crash mid-rename leaves the .tmp behind; the next save() overwrites it.

4. **`readSvg()` wraps readFile in 5s timeout** via Promise.race against a setTimeout. On timeout: throws `StorageReadError` (code -32005, retryable: true) with message "svg read timed out after {ms}ms". The timer is always cleared in the catch block so a successful read doesn't leave a dangling timer. ENOENT (missing blob) still returns null — the v0.1.0 "404 = null" contract is preserved for non-timeout errors.

5. **`sweep()` increments counters** (R010):
   - `sweep_runs` on every call (even when nothing is removed)
   - `sweep_removed` once per removed entry (using the existing single-flight `Counters.increment(key)` API; for batch sizes of a handful this is well within budget)

6. **MEM024 fix: list() and search() now project `{id, ...e}`** so the caller can pin/get/delete by reference. Pre-MEM024, the storage dropped the map key — the only stable identifier for an entry. The `id` is now the first field of each returned item, matching the updated ListResult.items / SearchResult.items typedefs in Backend.mjs.

7. **3 test seams** (module-level, no-op when not called, exported alongside the class):
   - `__setWriteFileForTesting(fn)` — replaces the inner writeFile call. Pass null to restore.
   - `__setReadFileForTesting(fn)` — replaces the inner readFile call. Pass null to restore.
   - `__setReadTimeoutForTesting(ms)` — overrides the 5000ms read timeout. Pass null to restore. **(Deviation from item 4)** — see Deviations below.

8. **Imports** — added `import { StorageWriteError, StorageReadError } from "../tools.mjs";`. Both classes are imported, used internally, and NOT re-exported (they are re-exported from `src/tools.mjs` per T02's historical single-seam pattern).

**`src/storage/Backend.mjs` — 1 change**

- `ListResult.items` typedef: `Array<Entry & {id: string}>` (was `Entry[]`).
- `SearchResult.items` typedef: `Array<Entry & {id: string, titleMatch: boolean, snippet: string}>` (was `Array<Entry & {titleMatch, snippet}>`).
- Added inline comments documenting the MEM024 fix and the S03 carry-forward.

**`tests/unit/storage.test.mjs` — 13 new test cases**

1. **Write retry on EAGAIN** — Installs a writeFile seam that throws `{code: 'EAGAIN'}` on the first call and delegates to the real impl on the second. Calls `put()`. Asserts the entry is persisted, the blob is on disk, the seam was called ≥2 times, and `storage_write_retries === 1`.
2. **Write no-retry on ENOSPC** — Installs a writeFile seam that throws `{code: 'ENOSPC'}` on every call. Calls `put()`. Asserts the error is a `StorageWriteError` (code -32004, retryable: true, name "StorageWriteError"), the seam was called exactly once, and `storage_write_retries === 0` (no transient retry happened).
3. **Write retry on EWOULDBLOCK** — Sibling of EAGAIN in the transient bucket. Same shape as test 1, with `code: 'EWOULDBLOCK'`. Asserts the retry succeeded and the counter bumped.
4. **Write no-retry on EACCES** — Sibling of ENOSPC in the terminal bucket. Same shape as test 2, with `code: 'EACCES'`.
5. **Read timeout throws StorageReadError** — Installs a readFile seam returning a never-resolving promise and sets a 50ms read timeout. Calls `readSvg()`. Asserts the error is a `StorageReadError` (code -32005, retryable: true, name "StorageReadError") with a message that includes "50" and the "svg read timed out after" prefix.
6. **Read happy path** — Default seams, default 5000ms timeout. Asserts the real read wins and the svg is returned.
7. **Read null on missing blob** — No put(); the blob file does not exist. Asserts `readSvg()` returns null (v0.1.0 "404 = null" contract preserved for non-timeout errors).
8. **Sweep counters: runs + removed** — Captures a baseline (because `load()` itself sweeps once), then calls `sweep()` twice and asserts `sweep_runs` advances by 2 while `sweep_removed` stays 0. Adds an expired entry, calls `sweep()` again, and asserts `sweep_removed === 1`.
9. **Sweep no-op** — Fresh entry, `sweep()` returns 0, `sweep_removed` is unchanged (and `save()` is not called).
10. **MEM024 list id** — Seeds 2 entries, calls `list({limit: 10})`. Asserts `items[0].id` and `items[1].id` are present and match the seeded keys, and every other Entry field is still on the item.
11. **MEM024 list id with cursor** — Seeds 3 entries, paginates with limit=2. Asserts the id projects correctly on both the first page (newest) and the second page (oldest).
12. **MEM024 search id** — Seeds 2 entries with one title-match and one code-only-match. Calls `search("keyword")`. Asserts each item carries `id`, `titleMatch`, and `snippet`. Asserts the ids match the seeded keys.
13. **MEM024 search id (code-only)** — Seeds 1 entry whose match is in the code. Asserts the returned item carries `id` even when `titleMatch: false`.

Also added seam-reset calls (`__setWriteFileForTesting(null)`, `__setReadFileForTesting(null)`, `__setReadTimeoutForTesting(null)`) to the outer `afterEach` so a test that installs a stub can't leak into the next test.

### Verification outcomes

- `npm test -- tests/unit/storage.test.mjs` → **47/47 pass** in 1.33s. 34 existing test cases (S01 + S02 locked) all still pass; 13 new S03 test cases pass.
- `npx vitest run` (full suite) → **160/160 pass across 21 test files** in 24.20s. Up from 147/147 in T03 (13 new storage tests, 0 regressions to S01 + S02 + S03-T01 + S03-T02 + S03-T03 baselines).
- `npx vitest run --coverage` → exit 0. `src/storage/LocalFsStorage.mjs` shows **98.08% lines / 81.94% branches / 100% functions**. Uncovered lines (471-472, 508-509) are minor edge cases: the best-effort `unlink` catch in `pruneIfExpired` (would need a non-writable directory to hit) and the `return "unknown"` branch in `_classifyWriteError` (non-standard error codes). Aggregate lines 81.61% (above the 80% threshold).
- `node --check src/storage/LocalFsStorage.mjs src/storage/Backend.mjs tests/unit/storage.test.mjs` → exit 0. All three files parse cleanly.
- `grep -c "^export" src/server.mjs` → **6** (S01 invariant preserved — server.mjs is untouched in T04).
- `grep -rn "console.error" src/` → no hits (T01 invariant preserved — no text-prefix logging in LocalFsStorage.mjs).
- **Read timeout test wall-clock time**: 65ms (well under 1s).
- **Write retry EAGAIN test wall-clock time**: 16ms.

### Foundation handed forward

T05 (server.mjs wiring + port fallback + health-state + integration tests) consumes this work directly:

- **T05 will**:
  - Construct `LocalFsStorage` with `{ counters, logger }` in `server.mjs` so the storage increments `storage_write_retries`, `sweep_runs`, and `sweep_removed` against the shared counters instance.
  - Wire the `logger` to `src/logger.mjs`'s `log()` so future log call sites in the storage can be added without rewiring the constructor.
  - Add structured log calls on retry exhaustion (`storage_write_failed`, code -32004) and on read timeout (`storage_read_failed`, code -32005). The seams are already in place.
  - The MEM024 fix is transparent to the tool handlers — they just return `storage.list()` / `storage.search()` verbatim. LLM clients now have the `id` field on every list/search item.

### Decisions

- **Added a 3rd test seam `__setReadTimeoutForTesting(ms)`** (the plan's item 4 listed 2). Reason: test 3c needs a way to set a short read timeout (50ms) so the timeout test fires in 65ms instead of waiting the full 5 seconds. The plan's item 1c hardcoded the 5000ms timeout in the production path; to override it for the test, a seam is the natural choice (mirrors T03's `__setRenderTimeoutForTesting`). The seam is documented in the file's comment block alongside the other 2.
- **`_writeFileWithRetry` is a class method, not a free function.** Reason: it needs `this.counters` to bump `storage_write_retries` on the transient-retry path. A free function would have to take counters as a parameter, which is more verbose at the 2 call sites (save's tmp-write and put's blob-write).
- **The retry's second attempt does NOT go through classify.** Reason: the plan mandates "no second retry" — the second attempt's failure propagates verbatim (not re-classified, not re-wrapped). This means a permanent EAGAIN (seam that always throws EAGAIN) surfaces as a raw EAGAIN error to the caller. The intent is that the retry is best-effort: if the underlying resource is still busy, the caller sees the real error and can decide what to do.
- **sweep_removed uses a for-loop calling `increment(key)` once per removed entry** (not a `add(key, delta)` method). Reason: the existing `Counters` API only has `increment(key)` (bumps by 1). Adding an `add` method would expand the surface area for a single batch-size of "a handful of entries". The single-flight `_writeChain` serializes the loop's increments so concurrent sweeps can't lose updates. The cost is N small atomic writes per sweep, which is fine for the expected batch size.
- **`_classifyWriteError` is a module-level helper, not a class method.** Reason: it's a pure function of the thrown error, not of the storage state. Module-level keeps the class focused on storage concerns.
- **Read timeout preserves the v0.1.0 "404 = null" contract for ENOENT** (only StorageReadError propagates; other errors return null). Reason: the storage treats a missing blob the same as a non-existent entry — that's the existing v0.1.0 behavior and the integration tests rely on it. The S03 addition is the timeout case, which is a NEW failure mode distinct from "the blob isn't there".
- **Did NOT re-export StorageWriteError or StorageReadError** from LocalFsStorage.mjs. The plan's inputs list `src/errors.mjs` and `src/tools.mjs` as the canonical homes; T02 re-exports the S03 error classes from `src/tools.mjs` (the historical single seam). Tests import from `src/tools.mjs` directly.

## Verification

13 new S03 test cases pass (write retry on EAGAIN/EWOULDBLOCK + no-retry on ENOSPC/EACCES, read timeout + happy path + 404 null, sweep counters runs/removed + no-op, MEM024 list id + list cursor + search id + search code-only). 34 existing S01 + S02 test cases all still pass. Full vitest run: 160/160 pass across 21 test files — no regressions. `node --check` clean on all 3 modified files. Coverage: LocalFsStorage.mjs at 98.08% lines / 81.94% branches / 100% functions. `grep -c "^export" src/server.mjs` returns 6 (S01 invariant preserved). `grep -rn "console.error" src/` returns nothing (T01 invariant preserved).

## Verification

Storage test suite (`npm test -- tests/unit/storage.test.mjs`): 47/47 pass in 1.33s. Full vitest run: 160/160 pass across 21 test files in 24.20s (up from 147 in T03, +13 new storage tests, 0 regressions). `node --check src/storage/LocalFsStorage.mjs src/storage/Backend.mjs tests/unit/storage.test.mjs` exits 0. `npx vitest run --coverage`: LocalFsStorage.mjs at 98.08% lines / 81.94% branches / 100% functions. S01 invariants preserved: `grep -c "^export" src/server.mjs` returns 6, `grep -rn "console.error" src/` returns no hits.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run tests/unit/storage.test.mjs` | 0 | pass — 47/47 tests pass (34 existing S01+S02 + 13 new S03) in 1.33s; covers EAGAIN/EWOULDBLOCK retry + ENOSPC/EACCES terminal + read timeout + read happy + read 404 null + sweep runs/removed + MEM024 list id + list cursor + search id + search code-only | 1330ms |
| 2 | `npx vitest run` | 0 | pass — 160/160 tests pass across 21 test files in 24.20s; up from 147 in T03 (13 new storage tests, 0 regressions to S01+S02+S03-T01+T02+T03 baselines) | 24200ms |
| 3 | `npx vitest run --coverage` | 0 | pass — LocalFsStorage.mjs at 98.08% lines / 81.94% branches / 100% functions; uncovered lines (471-472 best-effort unlink catch, 508-509 unknown classification) are edge cases; aggregate lines 81.61% (above 80% threshold) | 25000ms |
| 4 | `node --check src/storage/LocalFsStorage.mjs src/storage/Backend.mjs tests/unit/storage.test.mjs` | 0 | pass — all 3 modified files parse cleanly | 800ms |
| 5 | `grep -c "^export" src/server.mjs` | 0 | pass — returns 6 (S01 invariant preserved; server.mjs is untouched in T04) | 50ms |
| 6 | `grep -rn "console.error" src/` | 1 | pass — no hits (T01 invariant preserved; no text-prefix logging in LocalFsStorage.mjs) | 50ms |
| 7 | `npx vitest run tests/unit/storage.test.mjs --reporter=verbose 2>&1 | tail -20` | 0 | pass — read timeout test completes in 65ms (well under 1s); EAGAIN retry test in 16ms; all 13 new test names visible in verbose output | 1500ms |

## Deviations

Added a 3rd test seam `__setReadTimeoutForTesting(ms)` (the plan's item 4 listed 2: `__setWriteFileForTesting` + `__setReadFileForTesting`). Reason: test 3c needs a way to set a short read timeout (50ms) so the test fires in 65ms instead of waiting the full 5 seconds. The plan's item 1c hardcoded the 5000ms timeout in the production path; to override it for the test, a seam is the natural choice (mirrors T03's `__setRenderTimeoutForTesting`). The seam is documented in the file's comment block alongside the other 2.

Added a 4th test case (EWOULDBLOCK sibling of EAGAIN) and a 5th (EACCES sibling of ENOSPC) to cover the second member of each classification bucket. The plan listed 6 cases (3a-3f); I shipped 13 total (3 write retry + 3 read timeout + 2 sweep counters + 4 MEM024 list/search id + EWOULDBLOCK/EACCES coverage). The plan said "5+ new test cases" — 13 is well above the minimum and exercises the full classifyWriteError surface.

Did NOT re-export StorageWriteError or StorageReadError from LocalFsStorage.mjs. The plan's inputs list `src/errors.mjs` and `src/tools.mjs` as the canonical homes; T02 re-exports the S03 error classes from `src/tools.mjs` (the historical single seam). Tests import from `src/tools.mjs` directly.

## Known Issues

None.

## Files Created/Modified

- `src/storage/LocalFsStorage.mjs`
- `src/storage/Backend.mjs`
- `tests/unit/storage.test.mjs`
