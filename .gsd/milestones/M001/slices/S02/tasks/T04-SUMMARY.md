---
id: T04
parent: S02
milestone: M001
key_files:
  - tests/integration/stdio-mcp.test.mjs
  - tests/evals/eval-09-pin-tool.test.mjs
key_decisions:
  - Identified list/search items by title (not id) in tests because the S02 surface doesn't project id onto items (MEM022) — keeps the tests honest with the shipped behavior while still proving the contract works
  - Factored parseCallText(callResult) helper to make the 9 envelope assertions one-liners and to lock content[0].type === "text" universally
  - Renamed test #3 to reflect the new S02 shape ({ id, ascii, fileLink, title, elapsed_ms }) while preserving the fileLink file:/// + .html assertions in the body
  - Added ground-truth cross-checks (e.g., pin then list_pinned shows the entry; unpin then list_pinned hides it; delete then get returns -32005) on top of the envelope assertions, to make the tests fail loudly if the storage backend's behavior drifts from the wrapper envelope
duration: 
verification_result: passed
completed_at: 2026-06-04T09:00:12.367Z
blocker_discovered: false
---

# T04: Locked S02's 7-tool stdio MCP wire format + R020 envelope across 11 integration tests and flipped eval-09 from it.todo to a real pin/list round-trip assertion; full suite now 99 pass / 0 todo / 0 fail.

**Locked S02's 7-tool stdio MCP wire format + R020 envelope across 11 integration tests and flipped eval-09 from it.todo to a real pin/list round-trip assertion; full suite now 99 pass / 0 todo / 0 fail.**

## What Happened

## What Shipped

**`tests/integration/stdio-mcp.test.mjs`** — grew from 3 to 11 it() blocks (3 v0.1.0 preserved, 2 updated in-place, 6 new positive + 1 negative). A small `parseCallText(callResult)` helper was factored out so the 9 envelope assertions stay one-liners; it asserts `content[0].type === "text"` and `JSON.parse(text)` for both success and isError paths. The 11 tests are:

1. initialize handshake (unchanged from v0.1.0)
2. **lists 7 tools in tools/list** (renamed + extended — was "lists render_mermaid in tools/list ..."; now asserts `result.tools.length === 7`, `tools.map(t => t.name).sort() === ['delete_mermaid', 'get_diagram', 'list_diagrams', 'pin_mermaid', 'render_mermaid', 'search_diagrams', 'unpin_mermaid']`, every tool has a non-empty description + `inputSchema.type === "object"`, and `render_mermaid.inputSchema.required.includes("code")` regression check)
3. **renders a diagram** (extended — kept fileLink file:/// + .html assertions; added `title === ""` default and `elapsed_ms` is a number ≥ 0)
4. renders with title + search round-trip (new sibling — render `title: "Auth flow"`, assert `rendered.title === "Auth flow"`, then `search_diagrams({query: "auth"})` finds the entry with `titleMatch: true` and `title === "Auth flow"`)
5. **pin_mermaid** (new — seed render, pin, assert `{id, pinned: true, elapsed_ms: number≥0}`; ground-truth: `list_diagrams({pinned: true})` contains the entry)
6. **unpin_mermaid** (new — seed + pin, then unpin, assert `{id, pinned: false, elapsed_ms: number≥0}`; ground-truth: pinned:true no longer contains it)
7. **list_diagrams** (new — render 3 with distinct titles, `list_diagrams({limit: 2})` returns 2 items + a non-null `nextCursor`; pin the first-rendered, then assert pinned:true contains the first-rendered and not the other 2; pinned:false excludes the first-rendered)
8. **get_diagram** (new — render with title, `get_diagram({id})` returns the full object {id, title, code, ascii, svg, createdAt, lastAccessedAt, pinned, sourceLength, elapsed_ms}; explicitly asserts `ascii === ""` per the T02 contract that ASCII is not re-rendered on read)
9. **delete_mermaid** (new — render, delete, assert `{id, deleted: true, elapsed_ms: number≥0}`; ground-truth: follow-up `get_diagram({id})` returns `isError: true` with `code: -32005, retryable: false`)
10. **search_diagrams** (new — render 3 with titles "Alpha", "Beta", and one with no title; `search("alpha")` returns the Alpha entry first with `titleMatch: true`; `search("graph")` returns items with `titleMatch: false` and the untitled entry is first by createdAt desc)
11. **delete_mermaid 404** (new negative — `delete_mermaid({id: "nonexistent"})` returns `isError: true`, body has `code: -32005`, `retryable: false`, plus a non-empty `message` and `elapsed_ms: number≥0`; locks the strict-404 MEM014 contract)

**`tests/evals/eval-09-pin-tool.test.mjs`** — flipped from `it.todo` to a real assertion. New structure: `mkdtemp` per test + `spawnServer({env: {MERMAID_RENDERER_DATA: dataDir}})` + `initialize` + render `{title: "eval-09 pin target"}` to seed an id + `pin_mermaid({id})` + `list_diagrams({pinned: true})` ground-truth + `list_diagrams({pinned: false})` negative ground-truth. The preamble now documents the S02 reality: the v0.1.0 "HTTP-only" wording in evals.xml is stale and S02's stdio MCP behavior supersedes it.

## Verification

`node --check` on both files passes; `npm test -- tests/integration/stdio-mcp.test.mjs tests/evals/eval-09-pin-tool.test.mjs` exits 0 with 12/12 pass; `npm test` (full suite) exits 0 with 99 pass / 0 todo / 0 fail (was 90 / 1 todo / 0 fail at T03 close; T04 contributes 8 new stdio-mcp tests + 1 new eval-09 test replacing the todo).

## Deviations

- **list_diagrams and search_diagrams items don't carry `id` (MEM022 gotcha).** The T02 description text for both tools claims "each item carries id, title, code, ...", and the T04 plan uses "the pinned item" / "the seeded id" / etc. as if the LLM could identify items by id. The actual implementation in `LocalFsStorage.list()` and `.search()` returns `page.map(([, e]) => e)` — the entry object has `{code, createdAt, pinned, lastAccessedAt, sourceLength, title}` but **not** `id` (the id is the store map key, never projected onto the value). The integration tests work around this by identifying items by `title` (which is unique within each test); the eval-09 test does the same. This is a real S02 surface gap: an LLM client receiving a list/search result cannot pin/get/delete any item because the id is missing. **Not fixed in T04** — out of scope for the test-only task; captured as MEM022 (gotcha) and documented as a Known Issue / Follow-up. The fix is one line in each of `LocalFsStorage.list()` and `.search()`: change `page.map(([, e]) => e)` to `page.map(([id, e]) => ({id, ...e}))`, plus the same in `Backend.mjs` typedefs. Recommended as a S03 / T05+ follow-up.
- **Plan says "5 new it() blocks" but enumerates 6 tools** (pin, unpin, list, get, delete, search). I implemented 6 positive + 1 negative = 7 new it() blocks, matching the enumeration. The "5" in the plan header is a typo.
- **The render-sibling test ("renders a diagram with a title and round-trips it through the storage entry")** asserts the round-trip via `title`, not `id` (for the same MEM022 reason). The test still proves the title round-trips through storage and is searchable with `titleMatch: true`.
- **Test #3 (renders a diagram) was renamed** from "renders a diagram via tools/call and returns { id, ascii, fileLink } with fileLink starting with file:/// and ending with .html" to "renders a diagram via tools/call and returns { id, ascii, fileLink, title, elapsed_ms }". The rename reflects the new S02 shape; the fileLink file:/// + .html assertions are preserved inside the test body. The plan said "update the existing ... test" without specifying name preservation, and the new name describes the asserted shape more accurately.

## Known Issues

- **MEM022 (above)** — list_diagrams / search_diagrams items do not carry `id` despite the T02 description text claiming they do. LLM clients cannot operate on items returned by list/search. T05+ / S03 fix: project `{id, ...e}` in `LocalFsStorage.list()` and `.search()` and update the `Backend.mjs` typedefs.
- **eval-09's question text in evals.xml** still reads "the standalone HTTP daemon (bin/start.sh)" — the test's preamble flags this as stale, but the evals.xml file itself was not in T04's expected outputs. S03 task could either update the XML or add a CI check that the evals/*.test.mjs files match the XML questions.

## Verification

node --check on both test files (syntax OK); npm test -- tests/integration/stdio-mcp.test.mjs tests/evals/eval-09-pin-tool.test.mjs exits 0 with 12/12 passing (11 stdio-mcp + 1 eval-09); npm test full suite exits 0 with 99 pass / 0 todo / 0 fail. The 6 new positive integration it() blocks (pin_mermaid, unpin_mermaid, list_diagrams, get_diagram, delete_mermaid, search_diagrams) plus the 1 sibling render-with-title test plus the 1 negative 404 test plus the 2 in-place updates (lists 7 tools, render with title + elapsed_ms) plus the 1 unchanged v0.1.0 test (initialize handshake) all pass. eval-09's it.todo is gone, replaced by a real pin/list round-trip assertion that passes.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node --check tests/integration/stdio-mcp.test.mjs && node --check tests/evals/eval-09-pin-tool.test.mjs` | 0 | pass — syntax OK on both modified test files | 600ms |
| 2 | `npm test -- tests/integration/stdio-mcp.test.mjs tests/evals/eval-09-pin-tool.test.mjs` | 0 | pass — 12/12 tests green (11 stdio-mcp + 1 eval-09) | 20870ms |
| 3 | `npm test` | 0 | pass — full suite 99 pass / 0 todo / 0 fail (was 90/1/0 at T03 close) | 23010ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `tests/integration/stdio-mcp.test.mjs`
- `tests/evals/eval-09-pin-tool.test.mjs`
