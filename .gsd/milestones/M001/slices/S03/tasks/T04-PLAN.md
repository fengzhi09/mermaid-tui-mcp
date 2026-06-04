---
estimated_steps: 21
estimated_files: 3
skills_used: []
---

# T04: Add write retry, read timeout, atomic save, sweep counters, and MEM024 id projection to LocalFsStorage

Why: R017 requires writeFile to retry once on transient errors (EAGAIN, EWOULDBLOCK) and throw StorageWriteError (-32004, retryable: true) on terminal errors (ENOSPC, EACCES) or after retry exhaustion. R005's readFile side requires a 5s read timeout that throws StorageReadError (-32005, retryable: true) on expiry. R010 requires the counter increment surface to be present in sweep() (sweep_runs + sweep_removed). MEM024 is a real S02 surface gap that LLM clients hit immediately: list_diagrams and search_diagrams return items without the `id` field, so an LLM client cannot pin/get/delete any item by reference — the only stable identifier is the map key, dropped in `LocalFsStorage.list()` and `.search()`. S03 closes this by projecting `{id, ...e}` in both methods. The Backend.mjs JSDoc typedefs for ListResult.items and SearchResult.items must be updated to include `id: string` in the projection.

Do:
1. Modify src/storage/LocalFsStorage.mjs:
   a. Add an optional 2nd constructor arg: `constructor(root, opts = {})` where opts accepts `{ counters, logger }` (both optional). Store them as `this.counters = opts.counters ?? null; this.logger = opts.logger ?? null;`.
   b. Wrap the 2 writeFile sites (save() and put()) in a `retryOnce(fn, classify)` helper. classify returns 'transient' for {code: 'EAGAIN'} and {code: 'EWOULDBLOCK'}; 'terminal' for {code: 'ENOSPC'} and {code: 'EACCES'}; 'unknown' for anything else. retryOnce: on 'transient', call fn() once more (no second retry); on 'terminal' or 'unknown' after the first failure, throw StorageWriteError(-32004, retryable: true) with the original error message. On the retry attempt, if this.counters is set, call this.counters.increment("storage_write_retries").
   c. Wrap the readFile in readSvg() with a 5s timeout via Promise.race against setTimeout(fn, 5000, 'timeout'). On timeout, throw StorageReadError(-32005, retryable: true) with message "svg read timed out after 5000ms". The timer is always cleared on success.
   d. Change save() to use tmp+rename: write to `<root>/store.json.tmp` via writeFile, then rename to `<root>/store.json` (atomic on POSIX, near-atomic on Windows; documented in a code comment).
   e. Modify sweep(): if this.counters is set, call this.counters.increment("sweep_runs") at the start (always, even if nothing is removed). If anything is removed, call this.counters.increment("sweep_removed") with the count.
   f. **MEM024 fix**: change list() to project `page.map(([id, e]) => ({id, ...e}))` instead of `page.map(([, e]) => e)`. Change search() to project `pageRaw.map((m) => ({id: m.id, ...m.entry, titleMatch: m.titleMatch, snippet: m.snippet}))` instead of `pageRaw.map((m) => ({...m.entry, titleMatch: m.titleMatch, snippet: m.snippet}))`. The id is now part of the returned object.
2. Update src/storage/Backend.mjs:
   a. Update ListResult typedef: `items: Array<Entry & {id: string}>` (was `items: Entry[]`).
   b. Update SearchResult typedef: `items: Array<Entry & {id: string, titleMatch: boolean, snippet: string}>` (was `Array<Entry & {titleMatch, snippet}>`).
3. Extend tests/unit/storage.test.mjs (5 new cases):
   a. Write retry on EAGAIN: monkey-patch the storage's internal writeFile to throw {code: 'EAGAIN'} on first call, succeed on second; call put(); expect success; assert storage_write_retries counter bumped by 1 (if counters are attached); assert the entry was persisted.
   b. Write no-retry on ENOSPC: monkey-patch writeFile to throw {code: 'ENOSPC'} on first call; call put(); expect it to reject with StorageWriteError (code -32004, retryable true); assert storage_write_retries was NOT incremented (terminal errors don't retry).
   c. Read timeout: monkey-patch readFile to return a never-resolving promise; set a short read timeout (e.g., 50ms) via a test seam; call readSvg(); expect it to reject with StorageReadError (code -32005, retryable true).
   d. Sweep counters: attach a Counters instance to the storage; call sweep() twice; assert sweep_runs === 2; if no entries were removed, sweep_removed === 0; add an expired entry, call sweep(); assert sweep_removed === 1.
   e. MEM024 list id: seed 2 entries, call list({limit: 10}); assert items[0].id and items[1].id are present and match the seeded ids; assert all other Entry fields are also present.
   f. MEM024 search id: seed 2 entries with different titles, call search("keyword"); assert each returned item has id present (along with titleMatch, snippet).
4. Add 2 test seams to LocalFsStorage for unit-testability: `__setWriteFileForTesting(fn)` and `__setReadFileForTesting(fn)` (both no-ops when not called, both default to the real node:fs/promises impl). The seams are exported alongside the class.

Done when: `npm test -- tests/unit/storage.test.mjs` exits 0; the 6 new test cases pass; the 34 existing test cases (S01 + S02 locked) all still pass; node --check src/storage/LocalFsStorage.mjs src/storage/Backend.mjs exits 0. The MEM024 fix is verified by items[i].id being present in list() and search() results.

## Inputs

- `src/storage/LocalFsStorage.mjs`
- `src/storage/Backend.mjs`
- `src/errors.mjs`
- `tests/unit/storage.test.mjs`

## Expected Output

- `src/storage/LocalFsStorage.mjs`
- `src/storage/Backend.mjs`
- `tests/unit/storage.test.mjs`

## Verification

npm test -- tests/unit/storage.test.mjs

## Observability Impact

adds storage_write_retries counter (increments on transient retry); adds storage_read_failed log event (-32005) on read timeout; adds sweep_runs + sweep_removed counters on every sweep; closes MEM024 (list/search items now carry id)
