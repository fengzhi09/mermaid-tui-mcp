# S02: MCP tools - 7 tools, CRUD complete — Research

**Date:** 2026-06-04
**Lane:** research
**Slice ID:** S02 (M001)
**Status:** Ready for planning

## Summary

S02 expands the MCP tool surface from 1 (`render_mermaid`) to 7 — the
`render_mermaid` Create plus a full CRUD of resource tools (`pin`,
`unpin`, `list`, `get`, `delete`, `search`) — and introduces a thin
`StorageBackend` interface so M002's `OssStorage` slots in without
touching `server.mjs`. The v0.1.0 `Storage` class is renamed and
extended in place; v0.1.0's `entry` schema gains an optional `title`
field; the 7 tools' result envelope is `{...payload, elapsed_ms,
warnings?}` with `isError: true + {code, message, retryable}` on
failure (R020).

**Decision summary (locked by ADR/MEM):**
- 7 tools, all on stdio MCP (R001, R011-R014, R028, R029, MEM011).
- zod 4.x for input validation; `mcp.registerTool(name, config, cb)` is
  the SDK's blessed path (MEM004).
- `LocalFsStorage` replaces the bare `Storage` class via a thin
  `StorageBackend` interface (`MERMAID_RENDERER_BACKEND=local|oss`,
  `local` default; MEM002).
- `elapsed_ms` on every successful tool result, no MCP progress
  notifications (MEM005).
- `render_mermaid` adds optional `title: string` ≤200 chars
  (persisted in entry, displayed in view.html, searchable; MEM012).
- `search_diagrams` matches title+code case-insensitive, `titleMatch:
  true` ranking boost (R029).
- `delete_mermaid` is strict 404 — never returns `deleted: true` for a
  missing id (MEM014, R028).
- S02's error contract uses a **minimal S02-prefixed subset**
  (`-32004 storage_write_failed`, `-32005 not_found`) and leaves the
  full -32001..-32009 mapping to S03 (which owns the zod-based
  chokepoint per MEM004).

**Biggest unblocker for downstream slices:** the
`StorageBackend` interface. Every new tool reads through it; if its
shape is wrong, S02-S04 all rework.

## Recommendation

### Stack additions

| Layer | Choice | Rationale |
|---|---|---|
| Schema/validation | `zod@^4.0` | MEM004, MEM016. The MCP SDK has zod as a **non-optional** peer dep — installing it is required just to satisfy the SDK. Use v4 (mermaid-ascii 1.x is fine; zod v4 is the v0.2.0 design target). |
| MCP tool registration | `mcp.registerTool(name, {description, inputSchema: zodShape}, cb)` | The SDK's blessed path; deprecated `mcp.tool()` is fine but `registerTool` is the documented replacement (SDK `mcp.d.ts:150`). Auto-converts zod to JSON Schema for the wire `tools/list`; auto-validates `tools/call` arguments. |
| Test driver | reuse `tests/helpers/server.mjs` | S01 already ships the JSON-RPC driver. New tools get integration coverage through the same `spawnServer` + `send("tools/call", ...)` pattern. |
| Storage fixture | update `tests/helpers/storage-fixture.mjs` | Switch `new Storage(root)` → `new LocalFsStorage(root)`; the rest of the seam stays. |
| Coverage | keep `src/server.mjs` excluded | S01 documented the reason (mainline bootstrap is un-importable). S02 MUST extract tool handlers as pure functions in `src/tools.mjs` so they are unit-testable. |

### Repo layout (additions to S01's tree)

```
src/
  storage/
    Backend.mjs              # NEW — StorageBackend typedef + shared helpers
    LocalFsStorage.mjs       # NEW — current Storage class, renamed + new methods
  tools.mjs                  # NEW — pure tool handlers (7 fns), importable in unit tests
  server.mjs                 # MODIFIED — registerTool × 7, MERMAID_RENDERER_BACKEND env, entry.title
  storage.mjs                # REMOVED — replaced by src/storage/LocalFsStorage.mjs
  helpers.mjs                # EXTENDED — renderView subs new {{TITLE}} placeholder
public/
  view.html                  # MODIFIED — add {{TITLE}} placeholder + visible title in topbar
tests/
  helpers/
    storage-fixture.mjs      # MODIFIED — makeTempStorage() returns LocalFsStorage
  unit/
    storage.test.mjs         # REWRITE — exercises LocalFsStorage + new methods
    tools.test.mjs           # NEW — unit tests for the 7 pure tool handlers
    render-view-title.test.mjs # NEW — renderView substitutes {{TITLE}} and escapeHtmls it
  integration/
    stdio-mcp.test.mjs       # EXTENDED — round-trip every new tool (6 new it() blocks)
  evals/
    eval-09-pin-tool.test.mjs # FLIP — it.todo → real assertion: render → pin → list → assert pinned
package.json                 # add zod to dependencies
```

### StorageBackend interface (`src/storage/Backend.mjs`)

Thin. ~10 methods. Each method has a JSDoc contract. No inheritance
required (structural typing via JSDoc in plain-JS; M002's `OssStorage`
just needs the same method names).

```javascript
// src/storage/Backend.mjs
/**
 * @typedef {Object} StorageBackend
 * @property {string} root                     # data dir (or bucket name, etc.)
 * @property {() => Promise<void>} load        # idempotent, scans existing data, calls sweep
 * @property {() => Promise<number>} sweep     # returns count of removed entries
 * @property {(id: string, code: string, svg: string, sourceLength: number, title?: string) => Promise<Entry>} put
 * @property {(id: string) => Entry|null} getMetadata   # NO side effect (vs old get())
 * @property {(id: string) => Promise<boolean>} remove  # true if removed, false if not found
 * @property {(id: string) => Promise<string|null>} readSvg
 * @property {(id: string, pinned: boolean) => Promise<boolean>} setPinned
 * @property {() => {total: number, pinned: number, unpinned: number}} stats
 * @property {(query: string, opts?: {limit?: number, cursor?: string, pinned?: boolean}) => SearchResult} search
 * @property {() => Promise<{items: Entry[], nextCursor: string|null}>} list
 * @property {() => Promise<void>} save
 *
 * @typedef {Object} Entry
 * @property {string} code
 * @property {number} createdAt
 * @property {boolean} pinned
 * @property {number} lastAccessedAt
 * @property {number} sourceLength
 * @property {string} [title]            # NEW — S02; defaults to "" on legacy load
 *
 * @typedef {Object} SearchResult
 * @property {Array<Entry & {titleMatch: boolean, snippet: string}>} items
 * @property {string|null} nextCursor
 */

export const TTL_DAYS = 7;
```

**Design notes:**
- `getMetadata(id)` replaces the v0.1.0 `get(id)` semantics for new
  tools (no `lastAccessedAt` mutation). The HTTP /view path keeps
  using `pruneIfExpired(id)` which still bumps `lastAccessedAt`
  (S01's behavior is locked in by the existing /view contract).
- `remove(id)` is a new method: deletes the in-memory entry, the
  `<id>.svg` blob, and persists. Returns `true` on success, `false`
  if id not found (so the tool handler can map to `-32005`).
- `list()` and `search()` are pure (no I/O after `load()`); they
  read from the in-memory `store` map and return a JSON-serializable
  result. They do NOT update `lastAccessedAt`.
- `search(query, opts)` does case-insensitive substring matching on
  `title` first (sets `titleMatch: true`), then `code` (sets
  `titleMatch: false`); sort = `titleMatch DESC, createdAt DESC`;
  cursor = base64-encoded `{createdAt, id}` for stable pagination.
- `put(id, code, svg, sourceLength, title)` signature gains the
  optional `title` last; existing callers (the `render_mermaid`
  handler) pass `title` from the tool's input.

### MCP tool shape (7 tools)

All 7 use `mcp.registerTool(name, {description, inputSchema: zodShape},
cb)`. The SDK auto-derives the `tools/list` `inputSchema` and
auto-validates `tools/call` arguments. On zod parse failure the SDK
returns a JSON-RPC `-32602 Invalid params` error before the handler
runs — no need to write that path.

```javascript
// src/tools.mjs (sketch — see Tasks for full file)
import { z } from "zod";

const Title = z.string().max(200).optional();
const Id = z.string().min(1).max(200);
const Limit = z.number().int().min(1).max(100).default(20);
const Cursor = z.string().min(1).max(200).optional();
const Pinned = z.boolean().optional();

export const renderMermaidTool = {
  name: "render_mermaid",
  input: { code: z.string().min(1).max(200_000), title: Title },
  output: { id, ascii, fileLink, httpLink, title, elapsed_ms, warnings? },
  run: async (args, ctx) => { /* ... */ },
};

// 6 more — see tasks T03/T04 for the full list
```

Each handler returns one of:

```javascript
// success
{ content: [{ type: "text", text: JSON.stringify({...payload, elapsed_ms, warnings?: string[]}) }] }

// failure
{ isError: true, content: [{ type: "text", text: JSON.stringify({code, message, retryable}) }] }
```

`elapsed_ms` is captured at handler entry with
`process.hrtime.bigint()` and included in every successful result
(MEM005, R020). `warnings` is an optional array (e.g. ASCII failure
per R025).

### Error codes S02 owns

S02 uses a **minimal prefix** that S03 expands. S03 owns the full
-32001..-32009 chokepoint (per R020 and MEM004), but the integration
contract for delete/pin/unpin/read failures needs to be defined
*now* so MCP tests can assert on it. Plan:

| Code | Where thrown | Retryable | When |
|---|---|---|---|
| `-32004` | `put` write retry exhausted | true | S02's put on write retry — but actual EAGAIN retry logic is S03's R017. S02 just calls `put()` and lets it throw a tagged Error; S03 swaps the chokepoint. |
| `-32005` | `remove` / `getMetadata` returns null | false | S02 throws a tagged `NotFoundError` from `pin_mermaid` / `unpin_mermaid` / `get_diagram` / `delete_mermaid` when id is missing. |
| `-32602` | zod parse (via SDK) | n/a | Auto. |
| `-32603` | unhandled | n/a | Fallback. |

`src/server.mjs`'s tool-catch block maps `NotFoundError → -32005` and
any other thrown Error from a tool → `-32603`. S03 will replace this
mapping with its full classifier; S02's contract is "missing id is
NOT a 200, NOT a 200 with `deleted: true` — it is a tagged error that
the response shape can be asserted on". The integration test will
assert on the JSON-RPC `error.code` being one of the documented set.

### Entry schema migration

Old `store.json` (v0.1.0) has no `title` field. `LocalFsStorage.load()`
must default `title: ""` (or `undefined`) for legacy entries so
`search`/`get_diagram` don't crash on `entry.title` access.

`view.html` template gets a new `{{TITLE}}` placeholder. `renderView`
substitutes it via `entry.title ? escapeHtml(entry.title) : ""`. A new
topbar element shows the title (or nothing if empty). The integration
test asserts that a render with `title: "Auth flow"` produces an html
file containing the escaped title and that `search_diagrams` returns
that entry with `titleMatch: true` when querying "auth".

### `entry.lastAccessedAt` semantics

Two paths, two methods:

| Method | Side effect on `lastAccessedAt` | Used by |
|---|---|---|
| `pruneIfExpired(id)` (existing) | YES (bump) | HTTP /view, /raw/svg — preserves v0.1.0 "last viewed" UX |
| `getMetadata(id)` (new) | NO | `get_diagram` tool, internal use — so LLM reads don't fake "recent" activity |

S01's unit test asserts that `get()` bumps `lastAccessedAt`. S02
rewrites that test to assert on `pruneIfExpired` (preserves the
behavior) and adds a new assertion that `getMetadata` does NOT bump.

### Test seams S02 must update

| File | Change | Why |
|---|---|---|
| `tests/evals/eval-09-pin-tool.test.mjs` | `it.todo` → real assertion: render → pin → list → assert pinned | MEM011 eval-09 contract; the public eval test goes from "no tool yet" to "tool exists and works" |
| `tests/unit/storage.test.mjs` | Rewrite against `LocalFsStorage`; add `remove()`, `search()`, `getMetadata()` test blocks; preserve `pruneIfExpired` lastAccessedAt assertion | New storage surface; preserve v0.1.0 behavior where S01 locked it |
| `tests/helpers/storage-fixture.mjs` | `makeTempStorage()` constructs `new LocalFsStorage(root)` | Plumbing; no API change for callers |
| `tests/integration/stdio-mcp.test.mjs` | Add 6 new `it()` blocks: one per new tool | Locks the stdio MCP roundtrip for the new surface |
| `tests/unit/render-view-title.test.mjs` (new) | `renderView` substitutes `{{TITLE}}` and `escapeHtml`s it | Catches the XSS surface in view.html (R023) |
| `tests/unit/tools.test.mjs` (new) | Pure handler unit tests: success path + missing-id path + warnings on ASCII fail | Coverage for `src/tools.mjs` (server.mjs stays excluded) |

### Coverage strategy

`src/server.mjs` stays excluded per the S01 decision. `src/tools.mjs`
is unit-testable (it has no I/O, no bootstrap; takes a `ctx` with
storage/render/clock). The 7 handlers, the `elapsed_ms` wrapper, the
error mapper, and the search/remove/getMetadata logic all live in
`tools.mjs` and are unit-testable to ~95%+. The integration test
file locks the wire format. The threshold stays 80% lines; the new
modules raise the floor (helpers 100% → still 100%, tools 95%+,
storage stays 96%+).

## Files to Modify (canonical list for the planner)

```
ADD:
  src/storage/Backend.mjs                 (JSDoc typedefs + TTL_DAYS export)
  src/storage/LocalFsStorage.mjs          (rename of storage.mjs + remove/search/getMetadata)
  src/tools.mjs                           (7 pure handlers + registerTool adapters)
  tests/unit/tools.test.mjs               (handler unit tests)
  tests/unit/render-view-title.test.mjs   ({{TITLE}} substitution + escapeHtml)

MODIFY:
  package.json                            (add zod@^4.0)
  src/server.mjs                          (import tools, registerTool × 7, drop Storage import)
  src/helpers.mjs                         (renderView subs {{TITLE}})
  public/view.html                        (add {{TITLE}} placeholder + topbar slot)
  tests/evals/eval-09-pin-tool.test.mjs   (it.todo → real)
  tests/unit/storage.test.mjs             (rewrite for LocalFsStorage + new methods)
  tests/helpers/storage-fixture.mjs       (import LocalFsStorage)
  tests/integration/stdio-mcp.test.mjs    (add 6 new tool roundtrip it() blocks)

REMOVE:
  src/storage.mjs                         (replaced by src/storage/LocalFsStorage.mjs)
```

## Risks and Watch-Outs

- **R1 (HIGH): Tool handler testability.** If the 7 tool handlers stay
  inline in `server.mjs`, the coverage gate will be a problem and
  regressions will slip. Pattern: extract pure handlers into
  `src/tools.mjs` taking `{storage, render, clock, env}` as context.
  The integration tests cover the JSON-RPC wiring; unit tests cover
  the handler logic. Same seam S01 used for `renderView` (MEM015).

- **R2 (MED): entry.title backward compat.** v0.1.0 store.json files
  lack `title`. `load()` must default to `""` or the persistence
  round-trip breaks for existing users. S01's unit test for
  `load()` with a valid store.json must keep working — verify by
  preserving the entry shape (just add `title: ""` to the seeded
  objects).

- **R3 (MED): get() vs getMetadata() split.** S01's `get()` bumps
  `lastAccessedAt` — the test asserts this. S02 must NOT break that
  assertion; rename to `pruneIfExpired` (keeps bumping) and add
  `getMetadata` (no side effect). Update the test names so it's
  clear which path the assertion targets.

- **R4 (MED): search cursor stability.** Cursor is base64 of
  `{createdAt, id}`. Items with the same `createdAt` (millisecond
  ties, possible in fast back-to-back renders) must be tiebroken by
  `id` so the cursor is deterministic. Test: render 3 diagrams in a
  tight loop, list with limit=2, assert nextCursor round-trips
  through page 2 without skipping or duplicating.

- **R5 (MED): `remove(id)` is two-step (entry + blob) and must be
  atomic-ish.** If the blob unlink fails, the in-memory entry is
  still removed and the next `save()` writes a clean index, but a
  stale blob stays on disk. v0.1.0's `sweep()` and `pruneIfExpired()`
  have the same property; mirror the pattern (best-effort unlink,
  silent catch). S03 may add retry here (R017) — leave a seam.

- **R6 (LOW): `mermaidToAscii` failure path.** R025 says "warnings
  prefix, render does not interrupt". v0.1.0 `render()` already does
  this; the tool handler must surface the `warnings` array
  correctly. Test: monkey-patch `mermaidToAscii` to throw, assert
  result has `warnings: ["ascii_failed: ..."]` and the call still
  succeeds (R025).

- **R7 (LOW): title in `view.html` is XSS-sensitive.** R023 requires
  `escapeHtml` on the displayed title. `renderView` already
  `escapeHtml`s the id and the code; adding `title` to that list is
  one line. Test the escaped form (see `render-view-title.test.mjs`).

- **R8 (LOW): HTTP /pin route still exists.** v0.1.0 has
  `POST /pin?id=<id>&pin=true|false`. S02 adds `pin_mermaid` over
  stdio MCP. Both must continue to work — both call
  `storage.setPinned(id, true)`. The S01 integration test for /pin
  must keep passing.

## First Proof (highest-risk, biggest unblocker)

1. **T01: `StorageBackend` interface + `LocalFsStorage` rename + new
   methods.** This is the seam every tool reads through. If
   `remove/search/getMetadata` are wrong, the planner has to revisit
   every tool spec. Land the interface first, write the unit tests
   for the new methods, lock the seam. Build order: this MUST be the
   first task.

2. **T02: `eval-09` real assertion.** Flipping `it.todo` → real is
   the smallest end-to-end check that the stdio MCP path works for
   the new tools. A real render → `pin_mermaid` → `list_diagrams` →
   assert pinned; if this passes, the wiring is sound.

3. **T03-T05: 7 tool handlers + registration.** Order: render (extend
   with title) → pin + unpin (setPinned wrapper) → list → get → search
   → delete. Each tool is one zod schema + one handler + one
   integration test. The 7th tool, `delete_mermaid`, must NOT be
   lumped in with get/list; its strict-404 contract (R028, MEM014) is
   easy to get wrong and deserves its own task.

## Out of Scope for S02 (deferred to S03 or later)

- Full -32001..-32009 error contract (R020 fully realized; S03 owns
  the zod chokepoint). S02 uses a minimal tagged-error subset.
- Stderr JSON logging (R008, S03).
- /health counters + last_errors ring (R009, S03).
- 10s render timeout injection (R015, S03).
- jsdom init retry (R018, S03).
- writeFile EAGAIN retry (R017, S03).
- HTTP port fallback 5301/5302 (R016, S03).
- Actual `OssStorage` implementation (R031, M002+).
- MCP progress notifications (R033, deferred).
- OpenClaw native MCP (R034, deferred).

## Tasks Outline (for the planner)

Suggested build order; each task is single-context-sized.

- [ ] **T01: StorageBackend interface + LocalFsStorage rename + new methods** `est:60m`
  Why: Every new tool reads through it. If the seam is wrong,
  every tool reworks. This is the first proof.
  - Files: `src/storage/Backend.mjs` (new), `src/storage/LocalFsStorage.mjs` (new), `src/storage.mjs` (delete), `src/server.mjs` (update import + factory), `tests/unit/storage.test.mjs` (rewrite), `tests/helpers/storage-fixture.mjs` (update import)
  - Methods: `load`, `save`, `sweep`, `put` (gain `title`), `getMetadata` (new, no side effect), `readSvg`, `setPinned`, `remove` (new), `list` (new), `search` (new), `stats` (keep), `pruneIfExpired` (keep; S01 test still asserts)
  - Verify: `npm test tests/unit/storage.test.mjs` exits 0; S01's existing assertions on `pruneIfExpired` lastAccessedAt still hold.

- [ ] **T02: Add zod + flip eval-09 to a real assertion** `est:30m`
  Why: zod is a non-optional peer dep of the MCP SDK — install now so
  T03-T05 can import it. eval-09 is the public acceptance contract for
  S02; flipping it forces the test infrastructure to drive the new
  stdio MCP path through `pin_mermaid` end-to-end.
  - Files: `package.json` (add `zod@^4.0`), `package-lock.json` (regen), `tests/evals/eval-09-pin-tool.test.mjs` (real assertion: render → pin → list → assert pinned)
  - Verify: `npm test tests/evals/eval-09` exits 0; CI's `npm test` (45+ tests) all green.

- [ ] **T03: src/tools.mjs — render_mermaid extended with title + 6 new tool handlers** `est:90m`
  Why: The 7 tool handlers are the runtime surface; they must be
  pure (no MCP, no I/O beyond the storage interface) so unit tests
  can cover them. Each handler returns the R020 envelope.
  - Files: `src/tools.mjs` (new), `tests/unit/tools.test.mjs` (new)
  - Order in tools.mjs: define zod schemas → define handler fns →
    export `{name, input, run, register(server, ctx)}` records.
  - Verify: `npm test tests/unit/tools.test.mjs` exits 0; coverage on tools.mjs ≥ 90%.

- [ ] **T04: src/server.mjs — registerTool × 7 + entry.title plumbing + renderView title substitution** `est:45m`
  Why: The stdio MCP handler now lists 7 tools. The renderView
  template gets `{{TITLE}}`. S01's `get_object_about_test` re-export
  pattern preserved.
  - Files: `src/server.mjs` (use `mcp.registerTool` × 7, wire
    `MERMAID_RENDERER_BACKEND=local` env, pass ctx to handlers),
    `src/helpers.mjs` (renderView subs `{{TITLE}}`), `public/view.html`
    (add `{{TITLE}}` placeholder + topbar display)
  - Verify: `npm test` green; manual `node src/server.mjs` + initialize + tools/list returns 7 tools (note: this blocks on MCP stdio — automated in T05).

- [ ] **T05: Integration tests for the 6 new tools over stdio MCP** `est:45m`
  Why: Locks the wire format and the JSON-RPC envelope (R020
  success + tagged-error failure). Each test is one tool call +
  assertions on the parsed `content[0].text` and `isError`.
  - Files: `tests/integration/stdio-mcp.test.mjs` (add 6 it() blocks:
    pin, unpin, list, get, delete, search), plus the existing
    render_mermaid block updates to assert `title` round-trip.
  - Verify: `npm test tests/integration/stdio-mcp.test.mjs` exits 0; all 6 new tools produce 200 with R020 envelope; missing-id returns tagged error (-32005).

- [ ] **T06: renderView title + XSS guard test, full test run, coverage gate** `est:30m`
  Why: R023 requires escapeHtml on the displayed title; a unit test
  locks it. Final coverage gate must pass on the new modules too.
  - Files: `tests/unit/render-view-title.test.mjs` (new), `vitest.config.mjs` (no change — server.mjs stays excluded), README.md (optional: add 7-tool table footnote)
  - Verify: `npm test` green; `npm run test:coverage` ≥ 80% lines; helpers 100%, tools ≥ 90%, storage ≥ 90%.

## Verification Strategy

Slice-level verification (the final acceptance the planner must
prove):

| # | Check | Command |
|---|-------|---------|
| 1 | `node --check` on every new and modified module | `node --check src/server.mjs src/storage/Backend.mjs src/storage/LocalFsStorage.mjs src/tools.mjs src/helpers.mjs` |
| 2 | All unit, integration, eval tests pass | `npm test` |
| 3 | Coverage threshold met on included files | `npm run test:coverage` (lines ≥ 80%) |
| 4 | 7 tools appear in stdio MCP `tools/list` | spawn child, `initialize` + `tools/list`, assert `result.tools.length === 7` and names contain render_mermaid, pin_mermaid, unpin_mermaid, list_diagrams, get_diagram, delete_mermaid, search_diagrams |
| 5 | `render_mermaid` round-trips title | render with title "Auth flow", assert returned `title === "Auth flow"` and search finds it with `titleMatch: true` |
| 6 | `pin_mermaid` makes sweep skip the entry | render, pin, manually expire entry via `lastAccessedAt` backdate, call `sweep()`, assert entry still present |
| 7 | `unpin_mermaid` restores 7-day TTL | render, pin, unpin, backdate `createdAt` past TTL, call `sweep()`, assert entry removed |
| 8 | `list_diagrams` paginates | render 3, list with `limit: 2`, assert `nextCursor` set, follow cursor, assert remaining 1 |
| 9 | `get_diagram` returns full object | render, get, assert payload includes `id, title, code, ascii, svg, createdAt, lastAccessedAt, pinned, sourceLength, elapsed_ms` |
| 10 | `delete_mermaid` strict 404 | delete an unknown id, assert error code is -32005; delete a real id, assert entry + blob both gone |
| 11 | `search_diagrams` title+code match + titleMatch ranking | render two with different titles; query "TitleA"; assert the matching entry sorts first with `titleMatch: true`; query a substring of the code of the other; assert it ranks below |
| 12 | `entry.title` defaults to "" for legacy store.json | write a v0.1.0-shaped store.json, load, assert `entry.title === ""` and search/get don't throw |
| 13 | `view.html` displays title and escapeHtmls it | render with `title: "<script>alert(1)</script>"`, fetch html, assert the `<title>` in topbar contains the escaped form |
| 14 | `meraidToAscii` failure → `warnings` (R025) | monkey-patch import to throw, render, assert `warnings: ["ascii_failed: ..."]` present |
| 15 | S01 unit test on `pruneIfExpired` lastAccessedAt still holds | `npm test tests/unit/storage.test.mjs` exits 0 with the S01 assertion unchanged |
| 16 | S01 integration test on HTTP /pin still passes | `npm test tests/integration/http.test.mjs` exits 0 |
| 17 | `MERMAID_RENDERER_BACKEND` env path exists | `MERMAID_RENDERER_BACKEND=local node src/server.mjs` still boots; `MERMAID_RENDERER_BACKEND=oss` exits with a clear "not yet implemented" (or just falls back to local in M001) |

## Watch-Outs from the Pattern Library (MEMs)

- **MEM002**: storage abstraction is factory + env. The default is
  `local`; M002's `oss` is the M002 deliverable. S02 ships the
  switch in `server.mjs` (one env read) and the
  `LocalFsStorage` impl; the switch is exercised by check 17 above.
- **MEM004**: zod is the chokepoint for validation. Use `z.object({...})` shape strings, not JSON Schema literals.
- **MEM005**: no MCP progress; `elapsed_ms` on results. Wrap
  `process.hrtime.bigint()` in a `withElapsed(ctx)` higher-order.
- **MEM011**: 7 tools total. Do not invent an 8th.
- **MEM012**: `render_mermaid` title is optional, ≤200 chars, stored
  in entry, displayed in view.html, searchable.
- **MEM014**: `delete_mermaid` strict 404. Do NOT return `deleted: true` for a missing id.
- **MEM015**: extract pure helpers to keep `server.mjs` importable
  for tests. S02's `tools.mjs` follows the same pattern.
- **MEM016**: Mermaid 11 accepts strings earlier versions rejected.
  Use `A-->>B` (extra `>`) for any new "malformed" fixture.
- **MEM017**: server's unref'd sweep setInterval keeps the process
  alive. The integration test driver already SIGTERM→SIGKILLs at
  150ms/1200ms. S02's new tests follow the same close() pattern.

## Open Questions for the Planner

None — all S02 decisions are locked by ADRs / M001-CONTEXT / MEMs.
The planner can decompose into the 6 tasks above and execute.

## Sources

- M001-CONTEXT.md (acceptance criteria + ADRs)
- M001-ROADMAP.md (slice boundaries + provides/consumes)
- S01-SUMMARY.md (forward intelligence: seams, helper names, eval-09 placeholder)
- `.gsd/REQUIREMENTS.md` lines 7-263 (R001-R029 active, R011-R014, R019, R020, R022, R025, R028, R029 = S02)
- `src/server.mjs` (current tool list = 1; HTTP companion = 4 routes; 6 helper re-exports preserved)
- `src/storage.mjs` (current `Storage` class; methods: load/save/sweep/put/get/has/readSvg/setPinned/pruneIfExpired/stats)
- `tests/helpers/server.mjs` (JSON-RPC driver; `spawnServer({env, args})` + `send(method, params)` + `close()` with SIGTERM/SIGKILL escalation)
- `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts:150` (registerTool config: {description, inputSchema, outputSchema, annotations, _meta, title})
- `node_modules/@modelcontextprotocol/sdk/package.json` (peerDep `zod: ^3.25 || ^4.0`, NOT optional)
- `evals.xml` line for `<eval id="9">` (pin tool contract)
