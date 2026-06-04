# S02: MCP tools - 7 tools, CRUD complete

**Goal:** Expand the v0.1.0 single-tool MCP server into a 7-tool CRUD surface over stdio MCP. Add pin_mermaid / unpin_mermaid / list_diagrams / get_diagram / delete_mermaid / search_diagrams alongside the extended render_mermaid({code, title?}). Introduce a StorageBackend interface with LocalFsStorage as the default impl (selectable via MERMAID_RENDERER_BACKEND=local). Wire the R020 result envelope on every tool: success returns {...payload, elapsed_ms, warnings?}; failure returns isError: true with {code, message, retryable}. Persist optional title (≤200 chars) in the entry, render it in view.html, and make it the primary search anchor (titleMatch: true ranking boost).
**Demo:** stdio MCP 列 7 工具(render 与 6 资源管理);render 接可选 title 入参;pin_mermaid 后 sweep 不删;list_diagrams 与 search_diagrams 翻页过滤与 title 命中优先;get_diagram 完整对象含 title;delete_mermaid 真删;storage pluggable 接口就绪(LocalFsStorage 默认)

## Must-Haves

- 7 tools appear in stdio MCP `tools/list`: render_mermaid, pin_mermaid, unpin_mermaid, list_diagrams, get_diagram, delete_mermaid, search_diagrams.
- render_mermaid({code, title?}) round-trips title (entry.title defaults to "" for legacy store.json); returned object includes {id, ascii, fileLink, httpLink, title, elapsed_ms, warnings?}.
- pin_mermaid({id}) flips the pinned flag and returns {id, pinned: true, elapsed_ms, warnings?}; missing id → isError: true with code: -32005, retryable: false.
- unpin_mermaid({id}) is the dual; missing id → -32005.
- list_diagrams({limit?, cursor?, pinned?}) returns {items, nextCursor, elapsed_ms, warnings?} sorted by createdAt desc; limit default 20, max 100; cursor is opaque base64; pinned filter works.
- get_diagram({id, include?}) returns the full object {id, title, code, ascii, svg, createdAt, lastAccessedAt, pinned, sourceLength, elapsed_ms, warnings?}; missing id → -32005.
- delete_mermaid({id}) deletes the entry + blob and returns {id, deleted: true, elapsed_ms, warnings?}; missing id → -32005 (strict, not idempotent, per MEM014).
- search_diagrams({query, limit?, cursor?, pinned?}) returns {items[{id, title, titleMatch, snippet, ...}], nextCursor, elapsed_ms, warnings?} with case-insensitive substring matching on title + code; titleMatch: true ranks above false (MEM013).
- view.html shows the title in a topbar slot via the new {{TITLE}} placeholder; title is HTML-escaped (R023) — no XSS via title: "<script>alert(1)</script>".
- StorageBackend typedef lives in src/storage/Backend.mjs; LocalFsStorage is the default impl selected by MERMAID_RENDERER_BACKEND=local (default).
- All 6 new tools ship with unit tests (in tests/unit/tools.test.mjs) AND integration tests (in tests/integration/stdio-mcp.test.mjs).
- tests/evals/eval-09-pin-tool.test.mjs flips from it.todo to a real assertion (render → pin → list → assert pinned).
- npm test exits 0; npm run test:coverage exits 0 with lines ≥ 80% (helpers.mjs, LocalFsStorage.mjs, tools.mjs, render.mjs all ≥ 90%).
- S01's locked v0.1.0 contract is preserved: pruneIfExpired still bumps lastAccessedAt; HTTP /pin, /view, /raw/svg, /health routes still work; corrupted store.json still loads fresh.

## Proof Level

- This slice proves: integration — real stdio MCP roundtrip of all 7 tools with zod-validated inputs, real LocalFsStorage read/write to a temp data dir, real view.html {{TITLE}} substitution verified via the rendered HTML, real R020 success + isError envelopes asserted on the parsed content[0].text.

## Integration Closure

Upstream consumed: S01 test infrastructure (vitest 3.x + v8 coverage + 80% lines threshold, JSON-RPC driver at tests/helpers/server.mjs with SIGTERM→SIGKILL close, makeTempStorage pattern at tests/helpers/storage-fixture.mjs, render fixtures at tests/helpers/render-fixture.mjs), existing src/server.mjs (the 6 single-name helper re-exports are preserved — S01's grep -c "^export" === 6 audit invariant), existing src/render.mjs (signatures unchanged — render(code) keeps returning {id, svg, ascii, sourceLength}), existing public/view.html (the {{ID}} / {{CREATED_AT}} / {{SVG_BODY}} / {{CODE}} / {{PINNED}} / {{WITH_PIN}} / {{SOURCE_LENGTH}} / {{ID_JSON}} placeholders are preserved), the 10 evals.xml entries (eval-09's "HTTP-only" wording is now stale and gets re-described in eval-09's test header).

New wiring introduced: src/storage/Backend.mjs (JSDoc typedefs for StorageBackend, Entry, SearchResult), src/storage/LocalFsStorage.mjs (rename + 5 new methods: remove / search / getMetadata / list, plus title param on put, plus title default on load), src/tools.mjs (7 pure handlers + registerTools(mcp, ctx) wrapper enforcing the R020 envelope and elapsed_ms timer), 7 mcp.registerTool calls replacing the v0.1.0 single mcp.setRequestHandler(ListToolsRequestSchema, ...), MERMAID_RENDERER_BACKEND env-driven factory (default 'local' falls through to LocalFsStorage; 'oss' is recognized as a future slot for M002), {{TITLE}} placeholder in view.html + renderView substitution with escapeHtml (R023), {{TITLE_JSON}} for JS-side document.title use.

What remains before M001 is end-to-end usable: S03 owns the structured stderr JSON logger + counters (data/counters.json with tmp+rename) + extended /health + the full -32001..-32009 error classifier (S02 uses a minimal prefix: -32004 storage_write_failed, -32005 not_found). S04 owns the real Claude Code + gsd-pi smoke + README/CHANGELOG updates. S02 alone proves the 7-tool surface + CRUD contract + storage pluggability + view.html title; it does not prove the S03 observability surfaces or the S04 real-client integration.

## Verification

- none — S02 introduces no new observability surfaces. The slice does not change the /health response shape (S03 owns the counters / last_render_ms / last_errors[5] extension). The slice does not change the log() helper (S03 owns the stderr single-line JSON migration). S02's tools.mjs uses the existing log() helper (stderr, timestamp prefix) which is sufficient for in-process diagnostics; a future S03 task can swap it for the structured logger without touching S02's tool handlers (they only depend on the storage interface, not on log).

## Tasks

- [x] **T01: StorageBackend interface + LocalFsStorage rewrite** `est:90m`
  Why: The StorageBackend interface is the seam every new tool reads through. If the shape of getMetadata/remove/search/list is wrong, every tool reworks. Land the interface and the new methods first; the rest of the slice (zod schemas, tool handlers, integration tests) all consume this seam.
  - Files: `src/storage/Backend.mjs`, `src/storage/LocalFsStorage.mjs`, `src/storage.mjs`, `src/server.mjs`, `tests/helpers/storage-fixture.mjs`, `tests/unit/storage.test.mjs`
  - Verify: npm test -- tests/unit/storage.test.mjs

- [x] **T02: Add zod + create src/tools.mjs with 7 handlers + unit tests** `est:90m`
  Why: zod is a non-optional peer dep of @modelcontextprotocol/sdk@1.29 (peerDeps line 207 of the SDK's package.json, peerDependenciesMeta.zod.optional: false) — it must be installed before T03 can wire mcp.registerTool(name, config, cb) with inputSchema: zodShape. The 7 tool handlers must be pure (no I/O beyond the storage interface, no MCP SDK import beyond the registerTool call site) so unit tests can cover them. The registerTools(mcp, ctx) wrapper centralizes the R020 envelope and the elapsed_ms timer so every tool gets the same shape without per-handler boilerplate.
  - Files: `package.json`, `package-lock.json`, `src/tools.mjs`, `tests/unit/tools.test.mjs`
  - Verify: npm test -- tests/unit/tools.test.mjs

- [x] **T03: server.mjs registerTool x 7 + view.html TITLE + renderView substitution** `est:60m`
  Why: The stdio MCP handler must list 7 tools. The view.html template needs a {{TITLE}} slot (R023 + MEM012). The renderView helper in src/helpers.mjs must substitute it. S01's grep -c "^export" === 6 audit invariant is preserved.
  - Files: `src/server.mjs`, `src/helpers.mjs`, `public/view.html`
  - Verify: node --check src/server.mjs && node --check src/helpers.mjs && npm test

- [x] **T04: stdio MCP integration tests (6 new tools) + flip eval-09** `est:60m`
  Why: Locks the wire format and the R020 envelope for the 6 new tools. Eval-09 is the public acceptance contract for S02 (per MEM011) — flipping it from it.todo to a real assertion proves the new stdio MCP path works end-to-end.
  - Files: `tests/integration/stdio-mcp.test.mjs`, `tests/evals/eval-09-pin-tool.test.mjs`
  - Verify: npm test -- tests/integration/stdio-mcp.test.mjs tests/evals/eval-09-pin-tool.test.mjs

- [x] **T05: renderView TITLE XSS-guard test + final coverage gate** `est:30m`
  Why: R023 requires escapeHtml on the displayed title. The render-view-title unit test locks the XSS surface for v0.2.0. The final coverage gate proves the new modules (tools.mjs, LocalFsStorage.mjs) maintain the 80% lines floor under vitest's v8 coverage.
  - Files: `tests/unit/render-view-title.test.mjs`
  - Verify: npm test && npm run test:coverage

## Files Likely Touched

- src/storage/Backend.mjs
- src/storage/LocalFsStorage.mjs
- src/storage.mjs
- src/server.mjs
- tests/helpers/storage-fixture.mjs
- tests/unit/storage.test.mjs
- package.json
- package-lock.json
- src/tools.mjs
- tests/unit/tools.test.mjs
- src/helpers.mjs
- public/view.html
- tests/integration/stdio-mcp.test.mjs
- tests/evals/eval-09-pin-tool.test.mjs
- tests/unit/render-view-title.test.mjs
