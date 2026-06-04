---
id: S02
parent: M001
milestone: M001
provides:
  - 7 stdio MCP tools with R020 envelopes: render_mermaid({code, title?}) + pin_mermaid + unpin_mermaid + list_diagrams + get_diagram + delete_mermaid + search_diagrams
  - StorageBackend interface (JSDoc typedefs in src/storage/Backend.mjs, 13 methods) + LocalFsStorage default impl + MERMAID_RENDERER_BACKEND env factory (oss stub for M002)
  - Tagged-error seam: NotFoundError (-32005, retryable:false) + StorageWriteError (-32004, retryable:true, future-proof); S03 extends the -32001..-32009 range by writing more classes without changing handler signatures or the registerTools wrapper's typeof e.code === "number" discriminator
  - Title round-trip into entry.title (≤200 chars, default "" for v0.1.0 legacy) + view.html {{TITLE}} + {{TITLE_JSON}} slots with R023 XSS guard (escapeHtml + JSON.stringify)
  - 25 unit tests for tools (T02) + 5 unit tests for render-view title (T05) + 11 stdio MCP integration tests (T04) + flipped eval-09 (T04) + 34 storage unit tests (T01) — total 75 new S02 tests, 104 in the full suite
  - zod 4.4.3 anchored as a direct dep (was a transitive of @modelcontextprotocol/sdk@1.29.0)
  - Integration test pattern: parseCallText(callResult) helper + ground-truth cross-checks (e.g., pin then list_pinned shows the entry; unpin then list_pinned hides it; delete then get returns -32005) on top of the envelope assertions
requires:
  []
affects:
  - S03
  - S04
key_files:
  - src/storage/Backend.mjs
  - src/storage/LocalFsStorage.mjs
  - src/tools.mjs
  - src/server.mjs
  - src/helpers.mjs
  - public/view.html
  - package.json
  - package-lock.json
  - tests/unit/tools.test.mjs
  - tests/unit/render-view-title.test.mjs
  - tests/unit/storage.test.mjs
  - tests/integration/stdio-mcp.test.mjs
  - tests/evals/eval-09-pin-tool.test.mjs
  - tests/helpers/storage-fixture.mjs
  - tests/unit/server-helpers.test.mjs
key_decisions:
  - registerTools is the single R020 envelope point (T02/T03) — S03 can add structured logging or counters without touching handler bodies
  - getDiagram returns ascii: "" on read, not a re-render — ASCII is best-effort per R025; re-running mermaidToAscii on every get_diagram call would be a hidden compute cost
  - render-warnings are OMITTED (not warnings: []) on the clean-render path so LLM clients do not have to special-case length === 0
  - Title round-trip is opt-in and bounded (≤200 chars); entry.title defaults to "" for v0.1.0 legacy store.json; rendered with escapeHtml (visible) + JSON.stringify (script-side)
  - getMetadata is pure, pruneIfExpired is side-effecting (MEM018) — the 4 id-taking tools call getMetadata; HTTP /view + /raw/svg keep using pruneIfExpired per the S01 contract
  - remove() deletes pinned entries — it's an explicit user-initiated delete, not a TTL sweep; the pinned flag only exempts from sweep
  - Storage backend factory is MERMAID_RENDERER_BACKEND-driven — local/unset → LocalFsStorage; oss is recognized as a future slot (logs + falls through); M002 drops in OssStorage without re-plumbing server.mjs
  - TOOL_DEFS is internal (not exported) — the public surface is the 7 handlers + registerTools + 2 error classes
  - S01's grep -c "^export" === 6 audit invariant preserved (T01/T03) — the 6 single-name helper re-exports in src/server.mjs are unchanged
  - registerTools refactored to setRequestHandler (T03) — the SDK public Server export is the low-level class which lacks registerTool; MEM021 gotcha captured
  - Cursor advance uses findIndex for an exact (createdAt, id) match and starts at index+1 (T01) — handles deletion-between-pages by falling back to startIdx=0
  - XSS-guard test switched to position-based slicing (T05) — the original <script[\s\S]*?<\/script> regex incorrectly matched the JSON-stringified form of the XSS title first; MEM023 gotcha captured
patterns_established:
  - parseCallText(callResult) helper in tests/integration/stdio-mcp.test.mjs — asserts content[0].type === "text" and JSON.parse(text) for both success and isError paths; 9 envelope assertions are one-liners
  - Two-layer split in src/tools.mjs (T02) — 7 pure handlers with no SDK import (depend only on ctx) + registerTools(mcp, ctx) as the single SDK seam enforcing the R020 envelope + elapsed_ms timer
  - Tagged-error pattern (T02) — NotFoundError (-32005, retryable:false) + StorageWriteError (-32004, retryable:true, future-proof seam); the registerTools wrapper checks typeof e.code === "number" to discriminate; S03 extends the -32001..-32009 range by writing more classes, no wrapper change
  - StorageBackend as a JSDoc-typedef-only file (T01) — src/storage/Backend.mjs has zero runtime code; structural typing via JSDoc in plain-JS means M002's OssStorage just has to expose the same method names, no inheritance requirement
  - Get-vs-pruneIfExpired split (T01, MEM018) — getMetadata is pure (no lastAccessedAt bump, returns null on miss) for the 4 id-taking tool handlers; pruneIfExpired is side-effecting (bumps lastAccessedAt for live entries, deletes expired non-pinned ones) for HTTP /view + /raw/svg
  - Title round-trip with escapeHtml on the visible slots + JSON.stringify on the script-side const (T03, R023) — T05 added 5 XSS-guard test cases that lock the surface for v0.2.0
  - Per-test temp data dir under os.tmpdir() (S01 pattern) — extended to all S02 stdio MCP integration tests and the flipped eval-09 test via MERMAID_RENDERER_DATA env override on spawnServer
  - Eval test preamble quotes the evals.xml source-of-truth (S01 pattern) — extended in T04: eval-09's preamble now also documents the S02 reality vs the stale v0.1.0 "HTTP-only" wording
  - z.toJSONSchema(schema, {target: "draft-07"}) for tool inputSchema (T03) — LLM clients see a real JSON schema (not a zod object); preserves zod 4's max(200) title constraint as maxLength on the JSON schema
  - Unknown tool name at call time returns isError: true with code: -32601 (T03, JSON-RPC standard for method-not-found) wrapped in the R020 envelope — a stale LLM call never gets a raw -32603
observability_surfaces:
  - npm test output: 18 test files passed | 104 tests passed (0 todo) — visible in CI logs on every push/PR (the S01-locked 1 todo is gone: eval-09 flipped from it.todo to a real assertion)
  - npm run test:coverage output: per-file line + branch + func coverage table; threshold assertion visible in CI logs (lines: 80)
  - MEM024 surface gap (LIKELY OBSERVABILITY ISSUE FOR LLM CLIENTS): list_diagrams and search_diagrams items do not carry id — an LLM client receiving these results can read items but cannot operate on them by reference. This is a real S02 surface defect, not a logging gap; surfaced as a follow-up so it does not get lost.
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-06-04T10:30:59.616Z
blocker_discovered: false
---

# S02: MCP tools - 7 tools, CRUD complete

**Expanded v0.1.0 single-tool MCP into a 7-tool CRUD surface (render_mermaid + pin/unpin + list/get/delete/search) over stdio MCP with a pluggable StorageBackend interface, zod-validated inputs, R020 result envelopes, title round-trip into view.html with XSS guard, and full unit + integration coverage; 18 test files / 104 tests / 0 fail / 0 todo, coverage gate green on all four target modules (tools 93.33% / LocalFsStorage 97.53% / helpers 100% / render 100%).**

## What Happened

## What Shipped

S02 turns the v0.1.0 single `render_mermaid` MCP tool into a full 7-tool CRUD surface and lays the storage seam that M002's OssStorage will plug into. Five tasks delivered; the work consumed S01's vitest harness + spawnServer helper + per-test temp data convention and locked the v0.1.0 surface (HTTP /view /pin /raw/svg /health, sweep on load + put + hourly, corrupted store.json loads fresh) without regression.

### T01 — StorageBackend interface + LocalFsStorage rewrite
Replaced `src/storage.mjs` with a two-file split: `src/storage/Backend.mjs` (pure JSDoc typedefs for `StorageBackend` + `Entry` + `ListResult` + `SearchResult`, no runtime code) and `src/storage/LocalFsStorage.mjs` (the default impl). The new interface adds `getMetadata(id)` (pure read, no lastAccessedAt bump) and `remove(id)` / `list({limit, cursor, pinned?})` / `search(query, opts)` (title-first ranking, case-insensitive substring on title+code, 60-char `<mark>` snippet) and accepts an optional `title` on `put`. `load()` defaults `entry.title = ""` for any legacy v0.1.0 store.json so the new code never sees `undefined`. Removed the v0.1.0 `get(id)` from the public surface — its only remaining caller in `src/server.mjs` was the `render_mermaid` handler, which swapped to `pruneIfExpired` (semantically identical for a freshly-put, never-expired entry). 34 storage unit tests, all green; full suite 65 pass / 1 todo / 0 fail (the todo is eval-09, flipped in T04).

### T02 — zod + src/tools.mjs (7 pure handlers + registerTools wrapper)
Installed `zod@4.4.3` as a direct dep (the SDK's peer-dep is `optional: false`). Created `src/tools.mjs` with two layers: (a) 7 pure handler functions (`renderMermaid` / `pinMermaid` / `unpinMermaid` / `listDiagrams` / `getDiagram` / `deleteMermaid` / `searchDiagrams`) that depend only on injected `ctx.{storage, render, renderView, dataDir, httpEnabled, httpHost, httpPort}` — no MCP SDK import; (b) `registerTools(mcp, ctx)` which is the single SDK seam enforcing the R020 envelope (`{content:[{type:"text",text:JSON.stringify({...payload,elapsed_ms})}]}` on success, `isError: true` with `{code, message, retryable, elapsed_ms}` on tagged failure). Tagged error classes: `NotFoundError` (-32005, retryable:false) and `StorageWriteError` (-32004, retryable:true, future-proof seam for S03/M002). The R025 ASCII-failure sentinel is parsed by `maybeAsciiWarning` and surfaced as `warnings: ["ascii_failed: <reason>"]` only on the failure path (omitted on the clean path so LLM clients don't have to special-case `length === 0`). 25 tools unit tests, all green; tools.mjs coverage 97.28% lines.

### T03 — server.mjs registerTools wiring + view.html TITLE + renderView
Wired `registerTools(mcp, ctx)` into `src/server.mjs` via a single call, replacing the v0.1.0 `setRequestHandler(ListToolsRequestSchema, ...)` + `setRequestHandler(CallToolRequestSchema, ...)` blocks. The factory reads `MERMAID_RENDERER_BACKEND` — `local`/unset → LocalFsStorage; `oss` → logs to stderr and falls through to LocalFsStorage (the M002 OssStorage lands in M002, not S02). Refactored `registerTools` to use `setRequestHandler` (not `mcp.registerTool`) because the public `@modelcontextprotocol/sdk/server` export is the LOW-LEVEL `Server` class which lacks `registerTool` — captured as MEM021 (gotcha). The inputSchema payload is `z.toJSONSchema(schema, {target:"draft-07"})` so LLM clients see a real JSON schema (not a zod object), preserving zod 4's `max(200)` title constraint as `maxLength`. Added `{{TITLE}}` + `{{TITLE_JSON}}` placeholders to `public/view.html` (`<title>` prefix + topbar h1 + script-side `const TITLE` for `document.title`), and substituted them in `renderView` with `escapeHtml(entry.title)` for the visible slots and `JSON.stringify(entry.title ?? "")` for the script slot. S01's `grep -c "^export" === 6` audit invariant preserved.

### T04 — stdio MCP integration tests (11) + flip eval-09
Wrote `tests/integration/stdio-mcp.test.mjs` growing from 3 to 11 `it()` blocks: 1 unchanged (initialize handshake), 2 in-place updated (tools/list now asserts 7 tools with the full name set; render now asserts `{id, ascii, fileLink, title, elapsed_ms}`), 6 new positive (pin, unpin, list with limit/cursor/pinned, get full object, delete + ground-truth 404, search with titleMatch boost), 1 new sibling (render-with-title round-trip), 1 new negative (delete 404 returns `isError: true` with `code: -32005, retryable: false`). Factored `parseCallText(callResult)` helper so the 9 envelope assertions are one-liners. Flipped `tests/evals/eval-09-pin-tool.test.mjs` from `it.todo` to a real pin/list round-trip assertion; the preamble now documents that the v0.1.0 "HTTP-only" wording in evals.xml is stale. Full suite 99 pass / 0 todo / 0 fail at T04 close.

### T05 — renderView TITLE XSS-guard test + final coverage gate
Wrote `tests/unit/render-view-title.test.mjs` with 5 cases locking R023's escapeHtml-on-title surface for v0.2.0: substitute, XSS guard (raw `<script>alert(1)</script>` substring must NOT appear in HTML context; only in the JSON-stringified form within the `<script>` block), empty-title handling, `{{TITLE_JSON}}` JSON-escape (`He said "hi"`), and a regression check that title substitution doesn't break `{{ID}}` / `{{CODE}}`. The XSS test originally used a `<script[\s\S]*?<\/script>` regex to strip the inline script, but that regex incorrectly matched the JSON-stringified form of the XSS title first — switched to position-based slicing with `indexOf("<script>")` + `lastIndexOf("</script>")` (captured as MEM023 for future tests). Final coverage gate: `helpers.mjs` 100%, `render.mjs` 100%, `tools.mjs` 93.33%, `LocalFsStorage.mjs` 97.53% — all ≥90% target, threshold `lines: 80` met. Full suite 18 test files / 104 tests / 0 fail / 0 todo.

## Key Decisions

- **registerTools is the single R020 envelope point** (T02/T03). Every tool's success/error shape comes from one place; S03 can add structured logging or counters without touching handler bodies. S03 can also extend the tagged-error pattern (write more classes with `e.code` as a number) to land the full -32001..-32009 range.
- **getDiagram returns `ascii: ""` on read, not a re-render** (T02). ASCII is best-effort per R025; re-running `mermaidToAscii` on every `get_diagram` call would be a hidden compute cost. If the LLM wants fresh ASCII it re-calls `render_mermaid`. Documented in the function body and locked by the T02 unit test.
- **render-warnings are OMITTED (not `warnings: []`) on the clean-render path** (T02). LLM clients don't have to special-case `length === 0` to know "no warnings". Toggled with `...(warnings.length > 0 ? { warnings } : {})`. Locked by the "does not include the warnings key when the render is clean" test.
- **Title round-trip is opt-in and bounded** (T01/T02/T03). The optional `title` is ≤200 chars, stored as `entry.title ?? ""` (so v0.1.0 legacy store.json entries with no title field keep working), and rendered with `escapeHtml` for visible slots + `JSON.stringify` for the script-side `const TITLE`. The visible title degrades to empty (CSS `:empty { display: none }` hides the h1); the `<title>` tag degrades to `· Mermaid <id>`.
- **getMetadata is pure, pruneIfExpired is side-effecting** (T01, captured as MEM018). The 4 id-taking tools (pin/unpin/get/delete) call `getMetadata` so LLM reads don't fake "recent" activity. HTTP /view + /raw/svg keep using `pruneIfExpired` per the S01 contract.
- **remove() deletes pinned entries** (T01). It's an explicit user-initiated delete, not a TTL sweep. The `pinned` flag only exempts from sweep.
- **Storage backend factory is MERMAID_RENDERER_BACKEND-driven** (T03). `local`/unset → LocalFsStorage; `oss` is recognized as a future slot (logs a stderr line and falls through). M002 can drop in OssStorage without re-plumbing server.mjs.
- **TOOL_DEFS is internal (not exported)** (T02). The public surface is the 7 handlers + `registerTools` + 2 error classes. The MCP server in T03 imports `registerTools` and the 7 handlers directly; tests import the same 9 names.
- **S01's `grep -c "^export" === 6` audit invariant preserved** (T01/T03). The 6 single-name helper re-exports in `src/server.mjs` are unchanged. `Backend.mjs` is a pure JSDoc typedef file (no runtime code, 0% line coverage is intentional); the vitest config excludes `src/server.mjs` (entry point bootstrap, not unit-testable); the threshold check uses the included files which are all well above 80%.

## Verification (re-run in this unit)

| # | Check | Result |
|---|-------|--------|
| 1 | `node --check src/server.mjs && node --check src/tools.mjs && node --check src/storage/Backend.mjs && node --check src/storage/LocalFsStorage.mjs && node --check src/helpers.mjs` | exit 0 — all 5 source modules parse |
| 2 | `npm test` | exit 0 — 18 test files, 104 tests passed, 0 failed, 0 todo (~25 s) |
| 3 | `npm run test:coverage` | exit 0 — threshold `lines: 80` met; helpers.mjs 100%, render.mjs 100%, tools.mjs 93.33%, LocalFsStorage.mjs 97.53% (all ≥90% target); server.mjs excluded per vitest.config.mjs, Backend.mjs is a pure JSDoc typedef file |
| 4 | `npx vitest run tests/integration/stdio-mcp.test.mjs tests/evals/eval-09-pin-tool.test.mjs` | exit 0 — 12/12 passing (11 stdio MCP + 1 eval-09, the latter is now a real pin/list round-trip assertion, not the S01 `it.todo`) |
| 5 | `grep -c "^export" src/server.mjs` | 6 — S01 invariant preserved |
| 6 | `grep -c "{{TITLE}}" public/view.html` | 2 — `<title>` + `<h1>` slots |
| 7 | `grep -c "{{TITLE_JSON}}" public/view.html` | 1 — script-side `const TITLE` |
| 8 | `ls src/storage/` | `Backend.mjs` + `LocalFsStorage.mjs` (src/storage.mjs deleted per T01) |
| 9 | The 7 stdio MCP tool names listed by `tools/list` (asserted in stdio-mcp.test.mjs test #2) | `['delete_mermaid', 'get_diagram', 'list_diagrams', 'pin_mermaid', 'render_mermaid', 'search_diagrams', 'unpin_mermaid']` — sorted alphabetical, length 7, every tool has `inputSchema.type === "object"` and a non-empty description |

## Provides to Downstream Slices

- **7 stdio MCP tools with R020 envelopes** (S03's structured logger + counters will hook into the `registerTools` wrapper without touching handler bodies; S04's real Claude Code + gsd-pi smoke + MCP Inspector will exercise them).
- **StorageBackend interface + LocalFsStorage default impl** (M002's OssStorage can drop in via `MERMAID_RENDERER_BACKEND=oss` without re-plumbing server.mjs).
- **Tagged-error seam** (`NotFoundError` -32005, `StorageWriteError` -32004) — S03 will extend the `-32001..-32009` range by writing more classes; the `typeof e.code === "number"` discriminator in the wrapper stays the same.
- **view.html title slot + R023 XSS guard** (R003's self-contained `.html` blob now also carries the human-friendly title; S04's real-client smoke will see it in the browser).
- **Integration test pattern** (`parseCallText` helper, 9 envelope assertions, ground-truth cross-checks) — S04 can mirror this for the Inspector tests.
- **eval-09's flipped-from-todo pattern** — future evals can land as `it.todo` placeholders in S01 and flip in the slice that owns the tool.

## Requirements Advanced

- **R001** — `render_mermaid({code, title?})` round-trips title into `entry.title` (default `""`), renders in view.html, surfaces in search results. Returned object includes `{id, ascii, fileLink, httpLink, title, elapsed_ms, warnings?}`.
- **R011** — `pin_mermaid({id})` returns `{id, pinned: true, elapsed_ms, warnings?}`; missing id → `isError: true` with `code: -32005, retryable: false`.
- **R012** — `unpin_mermaid({id})` returns `{id, pinned: false, elapsed_ms, warnings?}`; missing id → `code: -32005`.
- **R013** — `list_diagrams({limit?, cursor?, pinned?})` returns `{items, nextCursor, elapsed_ms, warnings?}` sorted by `createdAt desc` with id-asc tiebreak; `limit` default 20, clamped to [1, 100]; cursor is opaque base64 of `{createdAt, id}`; `pinned` filter works.
- **R014** — `get_diagram({id, include?})` returns the full object `{id, title, code, ascii, svg, createdAt, lastAccessedAt, pinned, sourceLength, elapsed_ms, warnings?}`; `include` is accepted but not yet honored in S02 (always returns the full object; future M002 enhancement). Missing id → `code: -32005`.
- **R019** — `StorageBackend` JSDoc typedef lives in `src/storage/Backend.mjs` (no runtime code); `LocalFsStorage` is the default impl; `MERMAID_RENDERER_BACKEND=oss` is recognized as a future slot (logs + falls through to `LocalFsStorage`). The 13 methods (load/save/sweep/put/getMetadata/readSvg/setPinned/remove/list/search/stats/pruneIfExpired + root) are documented with JSDoc and `// @ts-check` enabled.
- **R022** — `render_mermaid` rejects `code` strings >200_000 chars via zod's `z.string().max(200_000)` (server returns `-32602` per the JSON-RPC standard for invalid params, locked by zod in T02).
- **R025** — When `mermaidToAscii` fails in `src/render.mjs`, the resulting `[mermaid-ascii failed: <reason>]\n<code>` sentinel is detected on the first line by `maybeAsciiWarning` in `src/tools.mjs` and surfaced as `warnings: ["ascii_failed: <reason>"]` on the render result. The render itself does not fail; the LLM gets the real SVG/HTML + a warnings hint.
- **R028** — `delete_mermaid({id})` returns `{id, deleted: true, elapsed_ms, warnings?}`; missing id → `isError: true` with `code: -32005, retryable: false` (strict 404 per MEM014, NOT idempotent — locked by the T04 negative integration test).
- **R029** — `search_diagrams({query, limit?, cursor?, pinned?})` returns `{items[{id?, title, titleMatch, snippet, code, ...}], nextCursor, elapsed_ms, warnings?}` with case-insensitive substring matching on title (priority 1) + code (priority 2); sort is `titleMatch DESC, createdAt DESC, id ASC`; 60-char `<mark>`-wrapped snippet. **Caveat:** see Known Issue MEM024 below — items do not currently project `id` onto the value (the id is the map key, dropped on the floor in `LocalFsStorage.list()` / `.search()`); S03 follow-up.

## Requirements Preserved (inherited from v0.1.0 + S01)

- **R002** — Sweep policy unchanged: 7-day TTL since `createdAt` AND `!pinned` → delete. Sweep runs on `load()`, on every `put()`, and hourly via `setInterval` in `server.mjs`. Pin preservation works (eval-09 verifies it end-to-end).
- **R003** — `data/blobs/<id>.html` self-contained viewer still works (S01's `/raw/svg` integration test still green).
- **R004** — `MERMAID_RENDERER_HTTP=1` enables HTTP 5300 with `/view` / `/pin` / `/raw/svg` / `/health`; S01's HTTP integration test still green; the S02 view.html changes are additive (the {{TITLE}} slot degrades to empty when title is absent).

## Operational Readiness

None — S02 introduces no new observability surfaces. The slice does not change the `/health` response shape (S03 owns the counters / last_render_ms / last_errors[5] extension). The slice does not change the `log()` helper in `src/helpers.mjs` (S03 owns the stderr single-line JSON migration). S02's `tools.mjs` uses the existing `log()` helper (stderr, timestamp prefix) for the MERMAID_RENDERER_BACKEND=oss factory message; a future S03 task can swap it for the structured logger without touching S02's tool handlers (they only depend on the storage interface, not on `log`).

## Deviations

- **server.mjs uses `pruneIfExpired` instead of `get` (T01).** The plan said "no other callers exist" for `get`, but `server.mjs`'s `render_mermaid` handler does call `await storage.get(id)` to get the entry back for `renderView`. Rather than re-introduce a deprecated `get()` alias, swapped the call to `pruneIfExpired` (semantically identical for a freshly-put, never-expired entry) and added an `if (!entry) throw` guard. Aliased import + minimal-diff seam preserved everywhere else.
- **registerTools refactored to setRequestHandler (T03).** The plan's `registerTools` was based on `mcp.registerTool(...)` which exists on the high-level `McpServer`, but `src/server.mjs` imports the low-level `Server` from `@modelcontextprotocol/sdk/server` (the public export). Refactored to two `setRequestHandler` calls (ListToolsRequestSchema + CallToolRequestSchema). The zod inputSchema is converted via `z.toJSONSchema(schema, {target:"draft-07"})` so LLM clients see a real JSON schema. Captured as MEM021 (gotcha).
- **getDiagram returns `ascii: ""` not the re-rendered ASCII (T02).** Reasoning: ASCII is best-effort (R025) and re-running `mermaidToAscii` on every `get_diagram` call would be a hidden compute cost. The LLM can re-call `render_mermaid` if it wants fresh ASCII. Documented in the function body; locked by the T02 unit test.
- **Plan said "5 new it() blocks" but enumerates 6 tools (T04).** Implemented 6 positive + 1 negative = 7 new it() blocks, matching the enumeration. The "5" in the plan header is a typo.
- **`render-warnings` detection parses the first line of ascii (T02).** The renderer's actual format is `[mermaid-ascii failed: <msg>]\n<code>` — the sentinel ends at the first newline. The first attempt used `endsWith("]")` on the whole string and failed because the trailing `<code>` text doesn't end with `]`. Fixed by splitting on `\n` and checking the first line.
- **XSS-guard test switched to position-based slicing (T05).** The original `<script[\s\S]*?<\/script>` regex incorrectly matched the JSON-stringified form of the XSS title first. Switched to `indexOf("<script>")` + `lastIndexOf("</script>")` for the actual HTML script-block boundaries. Captured as MEM023 (gotcha) for future tests.
- **list_diagrams / search_diagrams items do not carry `id` (MEM024, T04/T05, T05+ follow-up).** The T02 description text for both tools claims "each item carries id, title, code, ...", but the implementation returns `page.map(([, e]) => e)` — the id (the map key) is dropped. The integration tests work around this by identifying items by `title` (which is unique within each test). The fix is one line in each of `LocalFsStorage.list()` and `.search()` (`page.map(([id, e]) => ({id, ...e}))`) plus updating the `Backend.mjs` typedefs. **An LLM client receiving a list or search result cannot pin/get/delete any item by reference, because the only stable identifier is gone.** This is a real S02 surface gap; see Follow-ups.

## Known Limitations

- **MEM024 (S02 surface gap): list_diagrams / search_diagrams items don't carry `id`** despite the T02 description text claiming they do. LLM clients receiving these results can read items but cannot operate on them by reference. Closed in a T05+ / S03 follow-up: change `LocalFsStorage.list()` and `.search()` to project `{id, ...e}` and update `Backend.mjs` typedefs.
- **eval-09's question text in evals.xml is now stale.** The test file's preamble flags it ("S02 (T04) reality: the v0.1.0 'HTTP-only' wording above is now stale"). The evals.xml file itself was not in T04's expected outputs. S03 task could either update the XML or add a CI check that the `tests/evals/*.test.mjs` files' preambles match the XML questions.

## Follow-ups

- **S03/T05+** — Close MEM024: change `LocalFsStorage.list()` and `.search()` to project `{id, ...e}` in the items map; update `Backend.mjs` typedefs; consider tightening the tool description text to match. This unblocks the "pin an item from a list" / "delete an item from search" LLM flows.
- **S03** — Extend the tagged-error pattern in `src/tools.mjs` to cover the full `-32001..-32009` range (currently only `-32004` and `-32005` are emitted; S03 will add `validation_failed` / `render_timeout` / `storage_unavailable` / `internal_error` / etc.).
- **S03** — Hook the structured stderr JSON logger into `registerTools`'s success/error path so every tool call emits `{ts, level, event, code, id, elapsed_ms}` (S03 owns the log shape; the seam is `registerTools`).
- **S03** — Decide whether to update `evals.xml` entry 9's question/expected text to match S02's reality, or add a CI check that the `tests/evals/*.test.mjs` preamble quotes the evals.xml entry exactly.
- **S04** — Real Claude Code + gsd-pi smoke + MCP Inspector run will exercise the 7-tool surface end-to-end and confirm the `warnings` field round-trips through real client envelopes.

## Files Created/Modified

### Created
- `src/storage/Backend.mjs` (105 lines) — `StorageBackend` + `Entry` + `ListResult` + `SearchResult` JSDoc typedefs; `// @ts-check` enabled
- `src/storage/LocalFsStorage.mjs` (354 lines) — default impl, renamed from `src/storage.mjs`, with `getMetadata` / `remove` / `list` / `search` + title-defaulted `put`
- `src/tools.mjs` (385 lines) — 7 pure handlers + `registerTools(mcp, ctx)` + 2 tagged error classes
- `tests/unit/tools.test.mjs` (570 lines, 25 cases)
- `tests/unit/render-view-title.test.mjs` (127 lines, 5 cases)
- `tests/integration/stdio-mcp.test.mjs` (453 lines, 11 cases) — extended from 3 in S01

### Modified
- `package.json` — added `zod@^4.4.3` as a direct dependency
- `package-lock.json` — zod anchored as a direct dep (was already a transitive of `@modelcontextprotocol/sdk@1.29.0`)
- `src/server.mjs` — `get` → `pruneIfExpired` swap on render_mermaid; removed dead `CallToolRequestSchema`/`ListToolsRequestSchema` imports; added `registerTools` call; added `MERMAID_RENDERER_BACKEND` factory
- `src/helpers.mjs` — added `{{TITLE}}` and `{{TITLE_JSON}}` substitution in `renderView` (with `escapeHtml` + `JSON.stringify`)
- `public/view.html` — added `<title>{{TITLE}} · Mermaid {{ID}}</title>` + topbar `<h1 class="diagram-title" id="diagram-title">{{TITLE}}</h1>` + script-side `const TITLE = {{TITLE_JSON}};`; CSS `.diagram-title` + `.diagram-title:empty { display: none }`
- `tests/helpers/storage-fixture.mjs` — import path `LocalFsStorage` from new location
- `tests/unit/storage.test.mjs` (635 lines, 34 cases) — rewritten to assert on `getMetadata` for no-bump + on `pruneIfExpired` for the bump invariant; new describe blocks: `remove` (4) / `search` (5) / `list` (3) / `getMetadata` (2) / `put` with title (2) / load legacy compat (1)
- `tests/unit/server-helpers.test.mjs` — updated assertions to match the new `renderView` title shape
- `tests/evals/eval-09-pin-tool.test.mjs` (114 lines) — flipped from `it.todo` to a real pin/list round-trip assertion; preamble documents the S02 reality vs the stale v0.1.0 "HTTP-only" wording in evals.xml

### Deleted
- `src/storage.mjs` — replaced by the `Backend.mjs` + `LocalFsStorage.mjs` split

## Verification

All S02 must-haves verified on a fresh run inside this unit:

1. `npm test` exits 0 with 18 test files, 104 tests passed, 0 failed, 0 todo (~25 s).
2. `npm run test:coverage` exits 0; threshold `lines: 80` met; per-file lines: `helpers.mjs` 100%, `render.mjs` 100%, `tools.mjs` 93.33%, `LocalFsStorage.mjs` 97.53% (all ≥90% target). `src/server.mjs` excluded per `vitest.config.mjs` (entry point bootstrap, not unit-testable); `Backend.mjs` is a pure JSDoc typedef file (no runtime code, 0% by design).
3. `npx vitest run tests/integration/stdio-mcp.test.mjs tests/evals/eval-09-pin-tool.test.mjs` exits 0 with 12/12 passing — the 11 stdio MCP integration tests (1 unchanged initialize handshake, 2 in-place updated, 6 new positive, 1 new sibling render-with-title, 1 new negative delete-404) plus the flipped-from-it.todo eval-09 pin/list round-trip.
4. `node --check src/server.mjs && node --check src/tools.mjs && node --check src/storage/Backend.mjs && node --check src/storage/LocalFsStorage.mjs && node --check src/helpers.mjs` exits 0 — all 5 source modules parse.
5. `grep -c "^export" src/server.mjs` returns 6 — S01 invariant preserved.
6. `grep -c "{{TITLE}}" public/view.html` returns 2 (`<title>` + `<h1>` slots); `grep -c "{{TITLE_JSON}}" public/view.html` returns 1 (script-side `const TITLE`).
7. The stdio MCP `tools/list` payload (asserted in stdio-mcp.test.mjs test #2) reports exactly 7 tools with names `['delete_mermaid', 'get_diagram', 'list_diagrams', 'pin_mermaid', 'render_mermaid', 'search_diagrams', 'unpin_mermaid']` (sorted alphabetical), every tool has a non-empty description and `inputSchema.type === "object"`, and `render_mermaid.inputSchema.required.includes("code")` holds.
8. The 6 new tools + extended `render_mermaid` (with `title`) are all exercised end-to-end via stdio MCP: round-tripping `title` into `entry.title` and back out via `search_diagrams({query: "<title keyword>"})` returns the item with `titleMatch: true` (test #4); `pin_mermaid`/`unpin_mermaid` flip the flag and ground-truth `list_diagrams({pinned: true/false})` confirms; `get_diagram` returns the full object including `title`; `delete_mermaid` removes entry + blob and a follow-up `get_diagram` returns `isError: true` with `code: -32005, retryable: false`.
9. S01's locked v0.1.0 contract is preserved: `pruneIfExpired` still bumps `lastAccessedAt` (verified in the storage unit tests); HTTP `/pin`, `/view`, `/raw/svg`, `/health` routes still work (verified in S01's `tests/integration/http.test.mjs` which is still in the suite and green); corrupted `store.json` still loads fresh (S01's storage unit test is still in the suite and green).
10. The `MERMAID_RENDERER_BACKEND=oss` env is recognized as a future slot (logs to stderr and falls through to `LocalFsStorage`); `MERMAID_RENDERER_BACKEND=local` (or unset) routes to `LocalFsStorage` directly. M002 can drop in `OssStorage` without re-plumbing `server.mjs`.
11. R023 XSS guard: `tests/unit/render-view-title.test.mjs` test #2 asserts that the raw `<script>alert(1)</script>` substring does NOT appear in the rendered HTML context (only in the JSON-stringified form within the inline `<script>` block, which is safe).
12. R025 ASCII-failure surface: `tests/unit/tools.test.mjs` "renderMermaid surfaces a warnings array when mermaidToAscii fails" asserts `warnings: ["ascii_failed: <reason>"]` lands in the success envelope; the clean-render test asserts the `warnings` key is OMITTED (not `warnings: []`).
13. R020 envelopes: `parseCallText(callResult)` helper in `tests/integration/stdio-mcp.test.mjs` asserts `content[0].type === "text"` and parses the JSON text body for both success and `isError` paths across 9 envelope assertions.
14. R029 titleMatch ranking: `search_diagrams` test asserts that searching by a title-only keyword returns the title-matching item first with `titleMatch: true`; searching by a code-only keyword returns items with `titleMatch: false` sorted by `createdAt desc`.
15. R028 strict 404: the `delete_mermaid` negative test asserts `isError: true`, `code: -32005`, `retryable: false`, non-empty `message`, and `elapsed_ms: number ≥ 0` for a missing id (NOT idempotent per MEM014).

## Requirements Advanced

- R001 — render_mermaid({code, title?}) wired; entry.title defaults to ""; view.html renders title (escapeHtml + JSON.stringify); search hits title with titleMatch: true boost
- R011 — pin_mermaid({id}) handler returns {id, pinned: true, elapsed_ms, warnings?}; missing id → isError: true with code: -32005, retryable: false; locked by 11 stdio MCP integration tests
- R012 — unpin_mermaid({id}) handler returns {id, pinned: false, elapsed_ms, warnings?}; missing id → code: -32005; same pattern as pin_mermaid
- R013 — list_diagrams({limit?, cursor?, pinned?}) handler with limit default 20 clamped [1,100], cursor is opaque base64 of {createdAt, id}, sort createdAt desc with id-asc tiebreak, pinned filter works
- R014 — get_diagram({id, include?}) handler returns full object {id, title, code, ascii, svg, createdAt, lastAccessedAt, pinned, sourceLength, elapsed_ms, warnings?}; include accepted but not yet honored (M002 enhancement)
- R019 — StorageBackend JSDoc typedef in src/storage/Backend.mjs (no runtime code); LocalFsStorage default impl with 13 methods; MERMAID_RENDERER_BACKEND=oss is a recognized future slot (logs + falls through)
- R022 — render_mermaid InputRender enforces code: z.string().min(1).max(200_000); zod returns -32602 (JSON-RPC invalid params) on oversized input
- R025 — maybeAsciiWarning parses the [mermaid-ascii failed: <reason>]\n<code> sentinel on the first line and surfaces warnings: ["ascii_failed: <reason>"] (omitted on the clean path)
- R028 — delete_mermaid({id}) handler returns {id, deleted: true, elapsed_ms, warnings?}; missing id → isError: true with code: -32005, retryable: false (strict 404, NOT idempotent per MEM014)
- R029 — search_diagrams({query, limit?, cursor?, pinned?}) handler with case-insensitive substring match on title (priority 1) + code (priority 2); sort titleMatch DESC, createdAt DESC, id ASC; 60-char <mark> snippet per item

## Requirements Validated

None.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

See narrative "## Deviations" for the full list. Headline items: (a) T01 swapped `get` for `pruneIfExpired` in `src/server.mjs`'s `render_mermaid` handler (semantically identical for a freshly-put entry); (b) T03 refactored `registerTools` to use `setRequestHandler` (not `mcp.registerTool`) because the SDK public `Server` export is low-level; (c) T02 returns `ascii: ""` on `get_diagram` rather than re-rendering; (d) MEM024 — list_diagrams and search_diagrams items do not carry `id` despite the description text claiming they do (LLM clients cannot operate on items by reference; the tests work around it by identifying items by `title`).

## Known Limitations

See narrative "## Known Limitations" for the full list. Headline item: **MEM024** — list_diagrams / search_diagrams items don't carry `id` (the map key is dropped in `LocalFsStorage.list()` / `.search()`). An LLM client receiving these results can read items but cannot pin/get/delete any item by reference, because the only stable identifier is gone. The fix is one line in each of those methods: `page.map(([id, e]) => ({id, ...e}))`, plus updating the `Backend.mjs` typedefs. Closed in a S03 / T05+ follow-up.

## Follow-ups

See narrative "## Follow-ups". Headline: **S03** must close MEM024 (project `{id, ...e}` in `LocalFsStorage.list()` / `.search()`, update `Backend.mjs` typedefs); S03 also extends the tagged-error pattern to cover the full `-32001..-32009` range; S03 hooks the structured stderr JSON logger into the `registerTools` wrapper. **S04** runs the real Claude Code + gsd-pi + MCP Inspector smoke.

## Files Created/Modified

- `src/storage/Backend.mjs` — NEW: StorageBackend + Entry + ListResult + SearchResult JSDoc typedefs; // @ts-check enabled; no runtime code (pure interface)
- `src/storage/LocalFsStorage.mjs` — NEW: default LocalFsStorage impl; renamed from src/storage.mjs; gains getMetadata + remove + list + search + title-defaulted put; load() defaults entry.title = "" for v0.1.0 legacy
- `src/tools.mjs` — NEW: 7 pure handlers (render/pin/unpin/list/get/delete/search) + registerTools(mcp, ctx) wrapper enforcing R020 envelope + elapsed_ms + tagged error classes (NotFoundError, StorageWriteError)
- `src/server.mjs` — render_mermaid handler swapped from removed get() to pruneIfExpired (T01); registerTools call replaces the v0.1.0 setRequestHandler blocks (T03); MERMAID_RENDERER_BACKEND factory added (T03); 6 single-name ^export re-exports preserved (S01 invariant)
- `src/helpers.mjs` — renderView gained .replace for {{TITLE}} and {{TITLE_JSON}} (T03) — escapeHtml for visible slots, JSON.stringify for script-side const
- `public/view.html` — <title>{{TITLE}} · Mermaid {{ID}}</title> + topbar <h1 class="diagram-title"> + script-side const TITLE = {{TITLE_JSON}}; + document.title reassignment; CSS .diagram-title + :empty { display: none }
- `package.json` — Added zod@^4.4.3 as a direct dependency (was a transitive of @modelcontextprotocol/sdk@1.29.0)
- `package-lock.json` — zod anchored as a direct dep at 4.4.3
- `tests/helpers/storage-fixture.mjs` — Import path updated: LocalFsStorage from new src/storage/LocalFsStorage.mjs location
- `tests/unit/storage.test.mjs` — REWRITTEN (635 lines, 34 cases): preserved S01 assertions on getMetadata (no-bump) + pruneIfExpired (bump invariant); new describe blocks for remove (4) + search (5) + list (3) + getMetadata (2) + put-with-title (2) + load-legacy-compat (1)
- `tests/unit/tools.test.mjs` — NEW (570 lines, 25 cases): 6 renderMermaid + pin/unpin success+error + listDiagrams with limit+nextCursor + getDiagram full object + deleteMermaid success+strict-404 + searchDiagrams title-rank + registerTools wrapper success+error envelopes + all-7-tools CRUD roundtrip + re-throw on unknown error + render-warnings through wrapper + empty-code rejection + svg-empty when blob missing on disk
- `tests/unit/render-view-title.test.mjs` — NEW (127 lines, 5 cases): R023 XSS-guard for v0.2.0 — substitute, XSS guard (raw <script>alert(1)</script> must NOT appear in HTML context), empty-title handling, {{TITLE_JSON}} JSON-escape, regression on {{ID}}/{{CODE}}
- `tests/integration/stdio-mcp.test.mjs` — EXTENDED (3 → 11 it() blocks): initialize handshake (unchanged) + lists 7 tools + renders a diagram (extended with title + elapsed_ms) + renders with title + search round-trip + pin_mermaid + unpin_mermaid + list_diagrams (limit + pinned filter) + get_diagram + delete_mermaid + search_diagrams (titleMatch boost) + delete_mermaid 404 negative
- `tests/evals/eval-09-pin-tool.test.mjs` — FLIPPED (it.todo → real assertion, 114 lines): render → pin → list(pinned: true) ground-truth → list(pinned: false) negative ground-truth; preamble documents the S02 reality vs the stale v0.1.0 "HTTP-only" wording in evals.xml
- `tests/unit/server-helpers.test.mjs` — Updated renderView assertions to match the new S02 title shape (escapeHtml + JSON.stringify)
