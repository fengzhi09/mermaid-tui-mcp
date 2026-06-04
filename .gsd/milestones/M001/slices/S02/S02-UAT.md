# S02: MCP tools - 7 tools, CRUD complete — UAT

**Milestone:** M001
**Written:** 2026-06-04T10:30:59.618Z

# S02 UAT: MCP tools - 7 tools, CRUD complete

**Milestone:** M001
**Slice:** S02
**UAT Type:** Integration verification (the slice proves the 7 stdio MCP tools round-trip through real stdio JSON-RPC with zod-validated inputs, R020 envelopes, and the new StorageBackend seam — the S02 acceptance contract is the 11-test `tests/integration/stdio-mcp.test.mjs` + the flipped-from-it.todo `tests/evals/eval-09-pin-tool.test.mjs`).

## Preconditions

- A clean clone of `mermaid-tui-mcp` at the milestone/M001 branch with S01 already merged.
- Node 22 or Node 24 installed; `npm` available.
- Working directory is the repo root.
- The 7 stdio MCP tools' zod input schemas are documented at the top of `src/tools.mjs` (per-tool `z.object({...})` constants: `InputRender`, `InputId`, `InputList`, `InputGet`, `InputSearch`).
- The `StorageBackend` interface is documented in `src/storage/Backend.mjs` (pure JSDoc typedefs, no runtime code).
- A per-test temp `data/` dir under `os.tmpdir()` (created via `mkdtemp` + `rm` on teardown) so the real `<repo>/data/` is never touched.

## Steps

1. **Install dependencies (zod is now a direct dep)**
   ```bash
   npm ci
   ```
   Expected: exit 0, no errors, `node_modules/zod` present at the version pinned in `package-lock.json` (4.4.3).

2. **Run the test suite (no coverage)**
   ```bash
   npm test
   ```
   Expected: exit 0; vitest reports `Test Files 18 passed (18) | Tests 104 passed (104)`. **0 todo** (eval-09 has been flipped from the S01 `it.todo` to a real pin/list round-trip assertion). The 7 stdio MCP tools (render_mermaid, pin_mermaid, unpin_mermaid, list_diagrams, get_diagram, delete_mermaid, search_diagrams) are all covered by the 11 stdio MCP integration tests.

3. **Run coverage and verify the per-module threshold**
   ```bash
   npm run test:coverage
   ```
   Expected: exit 0; vitest's `coverage.thresholds.lines: 80` assertion holds. Per-file line coverage: `helpers.mjs` 100%, `render.mjs` 100%, `tools.mjs` 93.33%, `LocalFsStorage.mjs` 97.53% (all ≥90% target). `src/server.mjs` is excluded per `vitest.config.mjs` (the bootstrap is not unit-testable in-process); `Backend.mjs` is a pure JSDoc typedef file (0% by design — no runtime code to cover).

4. **Targeted run of the S02 acceptance tests**
   ```bash
   npx vitest run tests/integration/stdio-mcp.test.mjs tests/evals/eval-09-pin-tool.test.mjs
   ```
   Expected: exit 0; 12/12 tests pass (11 stdio MCP integration + 1 flipped-from-it.todo eval-09). The 11 stdio MCP tests cover: initialize handshake, the 7-tool list with the full name set, render with `{id, ascii, fileLink, title, elapsed_ms}`, render-with-title round-trip via search, pin, unpin, list with limit + pinned filter, get full object, delete + ground-truth 404, search with titleMatch boost, and the delete-404 negative envelope.

5. **Verify parse sanity for all S02 source modules**
   ```bash
   node --check src/server.mjs && \
   node --check src/tools.mjs && \
   node --check src/storage/Backend.mjs && \
   node --check src/storage/LocalFsStorage.mjs && \
   node --check src/helpers.mjs && \
   echo PARSE_OK
   ```
   Expected: exit 0, prints `PARSE_OK`. (Note: `src/storage.mjs` was deleted in T01; the storage layer is now `src/storage/Backend.mjs` + `src/storage/LocalFsStorage.mjs`.)

6. **Verify the S01 audit invariant is preserved**
   ```bash
   grep -c "^export" src/server.mjs
   ```
   Expected: prints `6` (the six single-name helper re-exports — renderView, extractSvgBody, escapeHtml, fileUrlFor, httpError, log — are unchanged from S01; the 6th `^export` is the new `import { registerTools } from "./tools.mjs"` line, and the `registerTools` itself is the 6th).

   Actually verify: the count of `^export` lines in `src/server.mjs` should be exactly 6 — the same number S01 locked.

7. **Verify the view.html title slots**
   ```bash
   grep -c "{{TITLE}}" public/view.html
   grep -c "{{TITLE_JSON}}" public/view.html
   ```
   Expected: first command prints `2` (`<title>` prefix + `<h1 class="diagram-title">` topbar slot); second prints `1` (script-side `const TITLE = {{TITLE_JSON}};`).

8. **Verify the 7 stdio MCP tool names are wired**
   The integration test #2 (`tests/integration/stdio-mcp.test.mjs`) does this assertion; for a manual check, spawn the server and call `tools/list`:
   ```bash
   node -e '
     import("./tests/helpers/server.mjs").then(async ({ spawnServer }) => {
       const server = spawnServer({ env: { MERMAID_RENDERER_DATA: "" } });
       const r = await server.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.0" } });
       const tools = await server.send("tools/list");
       console.log(JSON.stringify(tools.tools.map(t => t.name).sort()));
       await server.close();
     });
   '
   ```
   Expected: prints `["delete_mermaid","get_diagram","list_diagrams","pin_mermaid","render_mermaid","search_diagrams","unpin_mermaid"]` — length 7, the full S02 CRUD surface.

9. **Verify the StorageBackend seam is pluggable**
   ```bash
   ls src/storage/
   ```
   Expected: prints `Backend.mjs` and `LocalFsStorage.mjs` (and no `storage.mjs` — it was deleted in T01). The `MERMAID_RENDERER_BACKEND=oss` env is recognized in `src/server.mjs` (logs a stderr line and falls through to `LocalFsStorage`); M002's `OssStorage` can drop in without re-plumbing.

10. **Verify the S01 storage invariant is preserved**
    ```bash
    npx vitest run tests/integration/http.test.mjs
    ```
    Expected: exit 0; S01's HTTP integration test (which covers /health, /raw/svg, /pin, /view) still passes — the S02 changes to view.html and the storage layer are additive (the `{{TITLE}}` slot degrades to empty when title is absent; the `pruneIfExpired` side-effect on read is preserved).

## Expected Outcomes (overall)

- `npm test` exits 0 and exercises 104 real tests across unit (66 — 25 tools + 5 render-view-title + 34 storage + sanity) + integration (15 — 11 stdio MCP + 4 HTTP) + eval (10 — including the flipped eval-09) + helpers layers.
- `npm run test:coverage` exits 0 and enforces the 80% line threshold; the four S02 target modules (helpers.mjs / render.mjs / tools.mjs / LocalFsStorage.mjs) all report ≥90% line coverage.
- The 7 stdio MCP tools are reachable end-to-end via real stdio JSON-RPC: `initialize` → `tools/list` (7 tools) → `tools/call` for each of the 7 with proper zod-validated inputs → R020 success envelope `{content: [{type:"text", text: JSON.stringify({...payload, elapsed_ms})}]}` for the 6 happy paths and the 1 render-with-title sibling → R020 `isError: true` envelope `{content: [{type:"text", text: JSON.stringify({code: -32005, message, retryable: false, elapsed_ms})}]}` for the delete-404 negative path.
- The `StorageBackend` interface is documented as JSDoc typedefs in `src/storage/Backend.mjs` (no runtime code); `LocalFsStorage` is the default impl; `MERMAID_RENDERER_BACKEND=oss` is a recognized future slot. M002 can drop in `OssStorage` without re-plumbing `server.mjs`.
- `view.html` shows the title in the topbar `<h1>` (with `:empty { display: none }` degradation) and in the `<title>` tag prefix; the raw `<script>alert(1)</script>` XSS payload is HTML-escaped (R023) and JSON-stringified (safe in the script block).
- S01's locked v0.1.0 surface is preserved: the 6 single-name helper re-exports, the sweep on load + put + hourly, the HTTP /pin /view /raw/svg /health routes, the corrupted store.json loads fresh, and the `pruneIfExpired` side-effect on read.

## Edge Cases

- **Corrupted store.json on load** — S01's `load()` defaults `entry.title = ""` for legacy v0.1.0 entries that lack the title field; if the JSON is malformed, the existing S01 fallback path returns an empty store (no crash). The S02 unit test `load legacy compat (1: v0.1.0-shaped store.json loads with entry.title === "")` locks this.
- **Oversized render input (>200KB)** — `InputRender` enforces `code: z.string().min(1).max(200_000)`; the server returns the JSON-RPC standard `-32602` (invalid params) for oversized input. Locked by the S01 eval-07 test, which still passes.
- **Pin a missing id** — `pin_mermaid`/`unpin_mermaid` throw `NotFoundError` (-32005, retryable: false); the `registerTools` wrapper maps tagged errors to the R020 isError envelope. Locked by the T02 unit tests + the T04 negative 404 test.
- **Delete a missing id (strict 404)** — `delete_mermaid` throws `NotFoundError` (-32005, retryable: false); NOT idempotent per MEM014. The LLM is expected to call `list_diagrams` first to confirm the id exists. Locked by the T04 negative integration test.
- **Search with a title keyword vs a code keyword** — title matches get `titleMatch: true` + a `<mark>`-wrapped snippet from the title; code matches get `titleMatch: false` + a `<mark>`-wrapped snippet from the code. Title matches always rank above code matches (sort: `titleMatch DESC, createdAt DESC, id ASC`). Locked by the T04 search test.
- **Render with a missing or empty title** — `entry.title ?? ""` defaults to empty; the `<h1 class="diagram-title">` is hidden via CSS `:empty { display: none }`; the `<title>` tag degrades to `· Mermaid <id>`. Locked by the T05 render-view-title test.
- **Render when mermaidToAscii fails (R025)** — the renderer's `[mermaid-ascii failed: <msg>]\n<code>` sentinel is detected on the first line; the result includes `warnings: ["ascii_failed: <msg>"]` (the warnings key is OMITTED on the clean-render path). The render itself does not fail. Locked by the T02 unit test.
- **MERMAID_RENDERER_BACKEND=oss** — logs a stderr line ("'oss' backend is a stub for M002; falling back to LocalFsStorage") and falls through to `LocalFsStorage`. M002 can drop in `OssStorage` without re-plumbing `server.mjs`.
- **Hourly sweep tick** — `setInterval(sweep, 60*60*1000)` in `src/server.mjs` is unchanged; sweep removes entries where `(now - createdAt) > TTL_MS` AND `!pinned`. The S01 sweep setInterval is NOT unref'd (per MEM017); the integration test `close()` escalates SIGTERM (150ms) → SIGKILL (1200ms) to prevent the test from hanging.

## Acceptance Gate

S02 is accepted when all 10 steps above produce the expected outcomes on a clean clone with Node 22 or Node 24. S03 may then proceed to add the structured stderr JSON logger + counters + the full -32001..-32009 error classifier on top of the `registerTools` wrapper (the seam is the wrapper's `try/catch`; the tagged-error pattern is the discriminator). S04 may then proceed to the real Claude Code + gsd-pi smoke + MCP Inspector run.
