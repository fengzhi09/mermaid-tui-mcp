---
id: T02
parent: S02
milestone: M001
key_files:
  - package.json
  - package-lock.json
  - src/tools.mjs
  - tests/unit/tools.test.mjs
key_decisions:
  - registerTools wrapper is the single R020 envelope point — every tool's success/error shape comes from one place; S03 can add structured logging without touching handler bodies
  - Tagged-error class seam (NotFoundError -32005, StorageWriteError -32004) — wrapper checks typeof e.code === "number"; S03 will add -32001..-32009 by writing more classes, no wrapper change
  - TOOL_DEFS is internal (not exported) — the public surface is the 7 handlers + registerTools + 2 error classes; the MCP server in T03 will import registerTools + the 7 handlers directly
  - getDiagram returns ascii: "" (not re-rendered) — ASCII is best-effort (R025) and re-running mermaidToAscii on every get_diagram call would be a hidden compute cost; LLM can re-call render_mermaid if it wants fresh ASCII
duration: 
verification_result: passed
completed_at: 2026-06-04T08:24:38.613Z
blocker_discovered: false
---

# T02: Installed zod 4.4.3 as a direct dep; created src/tools.mjs with 7 pure handlers (render/pin/unpin/list/get/delete/search) + tagged error classes + registerTools(mcp,ctx) wrapper enforcing the R020 envelope + 25 unit tests covering every handler's success+error path + the wrapper's success+error envelopes.

**Installed zod 4.4.3 as a direct dep; created src/tools.mjs with 7 pure handlers (render/pin/unpin/list/get/delete/search) + tagged error classes + registerTools(mcp,ctx) wrapper enforcing the R020 envelope + 25 unit tests covering every handler's success+error path + the wrapper's success+error envelopes.**

## What Happened

## What Shipped

### 1. `package.json` + `package-lock.json`
Added `"zod": "^4.4.3"` to `dependencies`. Already present as a transitive dep of `@modelcontextprotocol/sdk@1.29.0`; installed explicitly per the T02 plan so it's a first-class dep. Verified with `node -e "import('zod').then(z => console.log(z.z.string().parse('ok')))"` → `"ok"`.

### 2. `src/tools.mjs` (new, 13.9KB)
Two layers, both load-bearing:

**Layer A — 7 pure handler functions.** Each is `async (args, ctx) => { ... }` and depends only on the injected `ctx` (`storage`, `render`, `renderView`, `dataDir`, `httpEnabled`, `httpHost`, `httpPort`). No MCP SDK import. Unit tests exercise every handler by mocking the ctx with a real `LocalFsStorage` rooted in a temp dir + the real `render` + `renderView`.

- `renderMermaid({code, title?})` — calls `ctx.render`, `ctx.storage.put(...title?)`, `ctx.renderView`, writes `<id>.html` next to `<id>.svg`, returns `{id, ascii, fileLink, httpLink, title, warnings?}`. Detects the `[mermaid-ascii failed: <reason>]\n<code>` sentinel from src/render.mjs on the FIRST line of ascii and surfaces `warnings: ["ascii_failed: <reason>"]` (R025).
- `pinMermaid({id})` / `unpinMermaid({id})` — `setPinned(true|false)`; throws `NotFoundError` (code `-32005`, retryable `false`) on miss.
- `listDiagrams({limit?, cursor?, pinned?})` — pass-through to `ctx.storage.list` (LocalFsStorage already does the cursor + sort + filter).
- `getDiagram({id, include?})` — `getMetadata` + `readSvg`; returns the full object `{id, title, code, ascii:"", svg, createdAt, lastAccessedAt, pinned, sourceLength}`. The `include` field is accepted-but-not-honored in S02 (future M002 enhancement).
- `deleteMermaid({id})` — `ctx.storage.remove`; throws `NotFoundError` on miss (strict 404 per MEM014, NOT idempotent).
- `searchDiagrams({query, limit?, cursor?, pinned?})` — pass-through to `ctx.storage.search` (LocalFsStorage already does title-first ranking + case-insensitive + 60-char snippet).

**Layer B — `registerTools(mcp, ctx)`.** The only seam that imports the SDK. Iterates a private `TOOL_DEFS` array, calls `mcp.registerTool(name, {description, inputSchema}, cb)` for each. The callback:
- Captures `const startNs = process.hrtime.bigint()`.
- `try`: computes `elapsed_ms` from `process.hrtime.bigint()`, returns `{content: [{type:"text", text: JSON.stringify({...payload, elapsed_ms})}]}`.
- `catch (e)`: if `typeof e.code === "number"`, builds the tagged-error envelope `{isError: true, content: [{type:"text", text: JSON.stringify({code, message, retryable, elapsed_ms})}]}`. Otherwise re-throws (SDK converts unknown throws to JSON-RPC -32603).

**Tagged error classes**: `NotFoundError` (-32005, retryable:false) and `StorageWriteError` (-32004, retryable:true). S03 will add more codes; the tagged-error pattern is the seam.

**TOOL_DEFS** carries the description text (render_mermaid's wording preserves v0.1.0 so eval-08's "draw anything" hint still lands, plus the 6 new CRUD descriptions). NOT exported — the seam is the handler functions, not the definitions.

### 3. `tests/unit/tools.test.mjs` (new, 20.5KB, 25 cases)
Covers: 6 renderMermaid cases (success with/without title, httpLink on, html blob written, warnings path, no-warnings-clean), pin/unpin success+error, listDiagrams with limit+nextCursor pagination, getDiagram full object + missing id, deleteMermaid success+strict-404, searchDiagrams title-rank + limit/cursor/pinned, registerTools wrapper (registers all 7, success R020 envelope, tagged-error R020 envelope, all-7-tools CRUD roundtrip, re-throw on unknown error, render-warnings through wrapper), and a defensive section (empty-code rejection, svg-empty when blob missing on disk).

Real `LocalFsStorage` + real `render` + real `renderView` everywhere except the warnings stub (which mocks `ctx.render` to return the ASCII-failed sentinel). All 25 green; full suite now 90 pass / 1 todo / 0 fail (was 65 / 1 todo / 0 fail at end of T01 — T02 contributes 25 new cases). tools.mjs coverage: 97.28% lines / 90% branch / 90.9% funcs (uncovered: 47-51 = StorageWriteError future-proof seam, 128-131 = defensive `if (!entry)` after put).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node --check src/tools.mjs` | 0 | pass | <1s |
| 2 | `node --check tests/unit/tools.test.mjs` | 0 | pass | <1s |
| 3 | `node -e "import('zod').then(z => console.log(z.z.string().parse('ok')))"` | 0 | pass | <1s |
| 4 | `node -e "import('./src/tools.mjs').then(m => console.log(typeof m.registerTools, typeof m.renderMermaid, typeof m.pinMermaid))"` | 0 | pass — prints "function function function" | <1s |
| 5 | `grep -c "^export" src/server.mjs` | 0 (count 6) | pass — S01 invariant preserved | <1s |
| 6 | `npm test -- tests/unit/tools.test.mjs` | 0 | pass — 25/25 cases green | 2.78s |
| 7 | `npm test` (full suite) | 0 | pass — 90 pass / 1 todo / 0 fail | 5.58s |
| 8 | `npm run test:coverage` | 0 | pass — tools.mjs 97.28% lines, suite 69.42% lines (server.mjs is the only file below 80% and is excluded by vitest config) | 5.89s |

## Deviations

- **Description "use `ascii` in your reply" wording** is preserved verbatim from v0.1.0's `setRequestHandler(ListToolsRequestSchema, ...)` body so the S01-locked eval-08 ("draw anything") test still passes (it didn't directly assert on the description text, but the LLM in production would have been trained on the v0.1.0 wording).
- **getDiagram returns `ascii: ""` not the re-rendered ASCII.** Reasoning: ASCII is best-effort (R025) and re-running `mermaidToAscii` on every `get_diagram` call would be a hidden compute cost. If the LLM wants fresh ASCII it can re-call `render_mermaid`. Documented in the function body so T04 integration tests don't accidentally assert on a different value.
- **`warnings` field is OMITTED (not `warnings: []`) on the clean-render path** so the LLM client doesn't have to special-case `length === 0` to know "no warnings". Toggled with spread: `...(warnings.length > 0 ? { warnings } : {})`. Locked by the "does not include the warnings key when the render is clean" test.
- **render-warnings detection parses the first line of ascii** because the renderer's actual format is `[mermaid-ascii failed: <msg>]\n<code>` — the sentinel ends at the first newline, not the end of the string. The first attempted detection used `endsWith("]")` on the whole string and failed because the trailing `<code>` text doesn't end with `]`. Fixed by splitting on `\n` and checking the first line.

## Key Decisions

- **registerTools wrapper is the single envelope point** — every tool's success/error shape comes from one place. S03 can add structured logging, the `/health` counters hook, or an in-process LRU without touching handler bodies.
- **Tagged-error class seam** (`NotFoundError`, `StorageWriteError`) lets S03 add `-32001..-32009` codes by writing more classes; the wrapper's `typeof e.code === "number"` check stays the same.
- **`StorageWriteError` is exported but never thrown** in T02 (97.28% lines coverage reflects this). It's there for S03's "auto-save failure" path and for M002's OSS backend's network-failure cases. Documented in the file header so future agents know it's intentional, not dead code.
- **TOOL_DEFS is internal** (not exported) because the public surface is `(registerTools, renderMermaid, pinMermaid, unpinMermaid, listDiagrams, getDiagram, deleteMermaid, searchDiagrams, NotFoundError, StorageWriteError)`. The MCP server in T03 will import `registerTools` and the 7 handlers; the test file imports the same 9 names directly.

## Verification

`npm test -- tests/unit/tools.test.mjs` (25/25 pass); `npm test` full suite (90 pass / 1 todo / 0 fail); `npm run test:coverage` (tools.mjs at 97.28% lines, suite at 69.42% lines with server.mjs excluded by vitest config); `node --check` on all 3 new files; `grep -c "^export" src/server.mjs === 6` (S01 invariant preserved).

## Files Created/Modified

- `package.json` — added `"zod": "^4.4.3"` to dependencies
- `package-lock.json` — zod locked at 4.4.3 (was already there as a transitive of @modelcontextprotocol/sdk; now anchored as a direct dep)
- `src/tools.mjs` — new, 13.9KB
- `tests/unit/tools.test.mjs` — new, 20.5KB, 25 cases

## Verification

npm test -- tests/unit/tools.test.mjs (25/25 cases green); npm test full suite (90 pass / 1 todo / 0 fail); npm run test:coverage (tools.mjs at 97.28% lines); node --check on all 3 new files; grep -c "^export" src/server.mjs === 6 (S01 invariant preserved); node -e "import('./src/tools.mjs').then(m => console.log(typeof m.registerTools, typeof m.renderMermaid, typeof m.pinMermaid))" prints "function function function".

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node --check src/tools.mjs` | 0 | pass | 200ms |
| 2 | `node --check tests/unit/tools.test.mjs` | 0 | pass | 200ms |
| 3 | `node -e "import('zod').then(z => console.log(z.z.string().parse('ok')))"` | 0 | pass — prints "ok" | 300ms |
| 4 | `node -e "import('./src/tools.mjs').then(m => console.log(typeof m.registerTools, typeof m.renderMermaid, typeof m.pinMermaid))"` | 0 | pass — prints "function function function" | 300ms |
| 5 | `grep -c "^export" src/server.mjs` | 0 | pass — S01 invariant preserved (6) | 50ms |
| 6 | `npm test -- tests/unit/tools.test.mjs` | 0 | pass — 25/25 cases green | 2780ms |
| 7 | `npm test` | 0 | pass — 90 pass / 1 todo / 0 fail (full suite) | 5580ms |
| 8 | `npm run test:coverage` | 0 | pass — tools.mjs 97.28% lines, suite 69.42% lines (server.mjs excluded by config) | 5890ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `package.json`
- `package-lock.json`
- `src/tools.mjs`
- `tests/unit/tools.test.mjs`
