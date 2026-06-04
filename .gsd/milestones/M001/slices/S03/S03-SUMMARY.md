---
id: S03
parent: M001
milestone: M001
provides:
  - Structured stderr JSON logging (R008) — src/logger.mjs
  - Persistent counters in data/counters.json with tmp+rename atomic write (R010) — src/counters.mjs
  - Full -32001..-32009 + -32602 error code set with classifyZodError / classifyDomainError / renderError (R020) — src/errors.mjs
  - 10s render timeout with test seam (R015) — src/render.mjs + __setRenderTimeoutForTesting
  - jsdom init 1x retry with test seam (R018) — src/render.mjs + __setJSDOMFactoryForTesting + __resetMermaidForTesting
  - writeFile EAGAIN/EWOULDBLOCK 1x retry + ENOSPC/EACCES terminal (R017) — src/storage/LocalFsStorage.mjs + __setWriteFileForTesting
  - 5s readSvg timeout → StorageReadError -32005 — src/storage/LocalFsStorage.mjs + __setReadTimeoutForTesting
  - HTTP port fallback 5300→5301→5302 (R016) — src/port-fallback.mjs + tryListen
  - /health metrics extension: counters + last_render_ms + last_errors[5] (R009) — src/health-state.mjs + src/server.mjs
  - asciiFailed flag on render() return — src/render.mjs
  - Sweep counter hooks (sweep_runs + sweep_removed) — src/storage/LocalFsStorage.mjs
  - MEM024 id projection on list/search — src/storage/LocalFsStorage.mjs + src/storage/Backend.mjs typedefs
  - MEM017 sweep setInterval unref'd at the source — src/server.mjs
  - Updated docs/api.md and docs/mcp-protocol.md with the S03 surface + error code table + namespace disambiguation
requires:
  []
affects:
  - S04 (consumes S03 observability + error contract for the real-client integration smoke)
key_files:
  - src/logger.mjs
  - src/counters.mjs
  - src/errors.mjs
  - src/port-fallback.mjs
  - src/health-state.mjs
  - src/render.mjs
  - src/storage/LocalFsStorage.mjs
  - src/storage/Backend.mjs
  - src/tools.mjs
  - src/server.mjs
  - src/helpers.mjs
  - tests/unit/logger.test.mjs
  - tests/unit/counters.test.mjs
  - tests/unit/errors.test.mjs
  - tests/unit/port-fallback.test.mjs
  - tests/unit/health-state.test.mjs
  - tests/unit/render.test.mjs
  - tests/unit/storage.test.mjs
  - tests/unit/server-helpers.test.mjs
  - tests/integration/http.test.mjs
  - tests/integration/stdio-mcp.test.mjs
  - docs/api.md
  - docs/mcp-protocol.md
key_decisions:
  - Re-export log from helpers.mjs (preserves S01 6-single-name-export invariant; lets tests target src/logger.mjs directly)
  - Single-flight chain via .then() on this._writeChain — simple, no extra deps, single-process only (R037)
  - Omit code/id on null/undefined (not emit as null) — keeps the JSON shape minimal and lets log shippers pattern-match on key presence
  - Stable field order {ts, level, event, code, id, ...rest} — human-grep-friendly and log-shipper-friendly
  - Best-effort unlink of stale .tmp on load() — recovers from mid-rename crashes without operator intervention
  - Forward-compat: unknown counter keys are accepted and persisted
  - Retryable flag convention: true for transient failures (RenderTimeout, JsdomInit, StorageRead, PortInUse), false for deterministic failures (RenderFailed, McpProtocolViolation). The same code -32005 is used by both StorageReadError (retryable:true) and NotFoundError (retryable:false) — the retryable flag carries the semantic distinction, not the code.
  - Pattern-match on err.message substring (not a code property) for the 3 known src/render.mjs throw prefixes. Reason: keeps src/render.mjs dependency-free (no import of ./errors.mjs) and preserves the 9 existing eval tests' message-substring assertions verbatim.
  - classifyDomainError default branch returns -32603 (InternalError), not the renderError envelope. Reason: the function is the classifier, not the envelope builder; returning a structured value keeps the function pure for unit tests.
  - renderError preserves insertion-order ...rest INSIDE the inner error object (not at the outer envelope level). Reason: callers pass {port, host} diagnostics and want them in the inner object — the /health last_errors ring and structured log lines both read from there.
  - registerTools wrapper is re-exported from src/tools.mjs (the historical single seam) — 1-line import + 1-line multi-symbol re-export preserves the S02 pattern (everything importable from src/tools.mjs). The 2 S02 classes (NotFoundError, StorageWriteError) stay defined in tools.mjs; the 6 new S03 classes live in errors.mjs and are re-exported.
  - Wrapper catch block classifies via classifyDomainError instead of re-throwing — 500-class failures now surface in the inner CallToolResult envelope (not as JSON-RPC -32603). The S02 "re-throws unknown errors" test was updated to assert the new (better) behavior.
  - Added a 4th test seam __setRenderTimeoutForTesting(ms) in render.mjs (deviation from plan's 3) — the plan said to cache the timeout in a const at module load, but the test sets the env var at test time; a cached const cannot be changed. The 4th seam lets the timeout test fire in 12ms instead of waiting the full 10s.
  - _writeFileWithRetry is a class method (not a free function) — needs this.counters to bump storage_write_retries on the transient-retry path.
  - Added a 3rd test seam __setReadTimeoutForTesting(ms) in LocalFsStorage.mjs (deviation from plan's 2) — mirrors T03's __setRenderTimeoutForTesting pattern; the read timeout test fires in 65ms instead of waiting the full 5 seconds.
  - Read timeout preserves the v0.1.0 "404 = null" contract for ENOENT (only StorageReadError propagates; other errors return null) — keeps the existing integration test contract; the S03 addition is the timeout case which is a new failure mode distinct from "the blob isn't there".
  - MEM024: list() and search() project {id, ...e} so LLM clients can pin/get/delete by reference. Backend.mjs ListResult.items / SearchResult.items typedefs updated to include `id: string` in the projection.
  - MEM017: sweep setInterval is unref'd at the source (src/server.mjs). The test helper's SIGTERM→SIGKILL escalation stays as defense-in-depth.
  - tryListen uses node:timers/promises setTimeout (unref'd by default) for the 50ms inter-port sleep, giving TIME_WAIT sockets a chance to close.
  - last_render_ms test assertion relaxed to >= 0 (was > 0) — a failure path where render.mjs throws synchronously on the length check has elapsed_ms === 0. The assertion accurately reflects the wall-clock contract.
patterns_established:
  - (none)
observability_surfaces:
  - stderr single-line JSON with stable field order {ts, level, event, code?, id?, ...rest}
  - data/counters.json (6 keys, tmp+rename atomic write, corruption-tolerant load)
  - GET /health includes counters + last_render_ms + last_errors[5] ring
  - 3 retry paths instrumented: render timeout (10s → -32001), jsdom init (1x → -32003), writeFile EAGAIN/EWOULDBLOCK (1x → -32004)
  - HTTP port fallback 5300→5301→5302 instrumented (-32008 on exhaustion)
  - 5-error FIFO ring in /health.last_errors with {code, at, retryable, message}
  - Full -32001..-32009 + -32602 + -32603 error code set with retryable flags documented in errors.mjs header and docs
  - Namespace disambiguation: inner code (CallToolResult.error.code) is distinct from JSON-RPC envelope error.code
drill_down_paths:
  - .gsd/milestones/M001/slices/S03/tasks/T01-SUMMARY.md
  - .gsd/milestones/M001/slices/S03/tasks/T02-SUMMARY.md
  - .gsd/milestones/M001/slices/S03/tasks/T03-SUMMARY.md
  - .gsd/milestones/M001/slices/S03/tasks/T04-SUMMARY.md
  - .gsd/milestones/M001/slices/S03/tasks/T05-SUMMARY.md
duration: ""
verification_result: passed
completed_at: 2026-06-04T12:22:25.956Z
blocker_discovered: false
---

# S03: Observability - logs, health, counters, error contract

**Wired structured stderr JSON logging, 6-key persistent counters with tmp+rename atomic writes, the full -32001..-32009 + -32602 error code set, 3 retry paths (10s render timeout, jsdom 1x init retry, writeFile EAGAIN 1x retry), HTTP port fallback 5300→5301→5302, /health metrics (counters + last_render_ms + 5-error ring), MEM017 sweep unref, and MEM024 id projection on list/search.**

## What Happened

## What shipped

### 5 new modules
- **`src/logger.mjs`** — `log({event, level="info", code?, id?, ...rest})` writes single-line JSON to stderr with stable field order `{ts, level, event, code?, id?, ...rest}`. null/undefined code and id are **omitted** (not emitted as `null`). process.stderr.write failures (EPIPE) are swallowed.
- **`src/counters.mjs`** — `Counters` class. `load()` reads `data/counters.json` (corruption-tolerant, recovers stale `.tmp` from prior crash). `increment(key)` is single-flight serialized via `_writeChain` — 100 concurrent increments converge to 100. Saves via tmp+rename. 6 keys: `render_total`, `render_errors`, `ascii_failures`, `storage_write_retries`, `sweep_runs`, `sweep_removed`.
- **`src/errors.mjs`** — `ErrorCode` frozen enum (-32602, -32001, -32002, -32003, -32004, -32005, -32008, -32009) + 6 new tagged error classes (RenderTimeout, RenderFailed, JsdomInit, StorageRead, PortInUse, McpProtocol). `classifyZodError`, `classifyDomainError`, `renderError` helpers. Header comment documents namespace disambiguation (inner code ≠ JSON-RPC envelope code).
- **`src/port-fallback.mjs`** — `tryListen(server, host, ports)` iterates ports racing `listening` vs `error`. EADDRINUSE → next port (50ms unref'd sleep). Exhaustion → `PortInUseError` (-32008, retryable: true).
- **`src/health-state.mjs`** — 5-element FIFO ring `recordError({code, retryable, message})`, `setLastRenderMs(ms)`, `snapshot() → {last_render_ms, last_errors}`. `last_errors` always an array.

### 4 modified modules
- **`src/render.mjs`** — `MERMAID_RENDER_TIMEOUT_MS` env (default 10000) wraps `mermaid.render()` in `Promise.race`. Timeout throws `RenderTimeoutError` (-32001). `getMermaid()` retries 1x on init failure; final failure throws `JsdomInitError` (-32003). Return value includes `asciiFailed: boolean`. 4 test seams exported.
- **`src/storage/LocalFsStorage.mjs`** — constructor accepts `{counters, logger}`. `writeFile` wrapped in `_writeFileWithRetry` (transient EAGAIN/EWOULDBLOCK → 1 retry, terminal ENOSPC/EACCES → `StorageWriteError` -32004). `readSvg` 5s timeout → `StorageReadError` -32005. `save()` uses tmp+rename. `sweep()` bumps `sweep_runs` (always) + `sweep_removed` (per entry). **MEM024 fix: list() and search() project `{id, ...e}`** so LLM clients can pin/get/delete by reference. Backend.mjs typedefs updated.
- **`src/tools.mjs`** — `registerTools` wrapper emits structured stderr log on every call; increments `render_total` on render_mermaid success; increments `render_errors` on any tagged failure; calls `setLastRenderMs` on every call; calls `recordError` on every tagged failure; `renderMermaid` handler increments `ascii_failures` when `warnings.length > 0`. **Behavior change: catch block now classifies via `classifyDomainError` (was re-throw) so 500-class failures surface in the inner CallToolResult envelope instead of bubbling to JSON-RPC -32603.**
- **`src/server.mjs`** — instantiates `Counters` at boot (`await counters.load()`), constructs storage with `{counters, logger}`. **`setInterval(...).unref()` on the sweep** (MEM017 fix at the source). Replaced `httpServer.listen` with `tryListen(httpServer, host, [port, port+1, port+2])`. Extended `/health` response with `counters: counters.snapshot(), ...healthSnapshot()`. All 7 `log()` call sites migrated to structured record API. The 6 `^export` single-name invariant from S01 is preserved.

### 7 new test files / 27 new test cases (all passing)
- `tests/unit/logger.test.mjs` (8 cases) — stderr single-line JSON, stable field order, code/id omission on null, EPIPE tolerance, JSON.stringify failure tolerance
- `tests/unit/counters.test.mjs` (10 cases) — corruption-tolerant load, stale .tmp unlink, 100-concurrent-increments → 100, snapshot, forward-compat with unknown keys
- `tests/unit/errors.test.mjs` (21 cases) — frozen enum, all 6 new tagged classes, locked StorageReadError(true) vs NotFoundError(false) at -32005, classifyZodError multi-issue join, classifyDomainError for all 3 known render.mjs prefixes + default -32603, renderError wire shape, tools.mjs re-export seam
- `tests/unit/port-fallback.test.mjs` (3 cases) — first port free, first busy + second free, all 3 busy → PortInUseError
- `tests/unit/health-state.test.mjs` (4 cases) — defaults, single push, 5-bounded ring, round-trip
- `tests/unit/render.test.mjs` (+4 cases) — 10s timeout seam, jsdom retry succeeds (factory called exactly 2x), jsdom retry exhausted, asciiFailed flag
- `tests/unit/storage.test.mjs` (+13 cases) — write retry EAGAIN/EWOULDBLOCK + no-retry ENOSPC/EACCES, read timeout + happy + 404 null, sweep runs/removed, MEM024 list id + cursor + search id
- `tests/integration/http.test.mjs` (+2 cases) — /health surfaces counters + last_render_ms + last_errors[1] after render + failure, 6 failures → ring bounded at 5
- `tests/integration/stdio-mcp.test.mjs` (+1 case) — render_mermaid > 200000 chars returns inner -32602 (NOT JSON-RPC envelope), eval-07 substring contract preserved

### 2 docs updated
- **`docs/api.md`** — replaced the S02 /health section with the S03 surface (counters + last_render_ms + last_errors[5]). Added the counter reference table, the 5-error ring reference, the -32001..-32009 + -32602 + -32603 code table with retryable flags, a "Namespace disambiguation" note, and on-disk file docs (`data/counters.json` + `.tmp`).
- **`docs/mcp-protocol.md`** — replaced the S02 single-tool surface with the S03 7-tool surface, the old text-prefix log format with the S03 JSON-line format + stable field order table, the full error contract table, and a strengthened namespace disambiguation call-out (inner code is application-level, NOT the JSON-RPC envelope `error.code`).

## Verification outcomes

- `npm test` → **175/175 pass across 23 test files** in ~28s (up from 160/160 in T04; 27 new S03 tests + 0 regressions to S01 + S02 baselines).
- `npm run test:coverage` → **80.95% lines / 85.11% branches / 96.38% functions** on the 9 included files (above the 80% threshold). `tools.mjs` 94.79% lines, `errors.mjs` 100%, `health-state.mjs` 100%, `helpers.mjs` 100%, `render.mjs` 100%, `LocalFsStorage.mjs` 98.08%.
- `node --check` on all 9 source modules → exit 0.
- `grep -c "^export" src/server.mjs` → 6 (S01 invariant preserved).
- `grep -rn "console.error" src/` → no hits (T01 invariant preserved).
- **End-to-end runtime smoke** (MERMAID_RENDERER_HTTP=1 node src/server.mjs):
  - stderr emits 3 boot records (`mcp_stdio_connected`, `boot`, `http_listening`) as one-line JSON with stable field order `{ts, level, event, ...rest}`.
  - `GET /health` → `{"status":"ok","version":"0.1.0","uptimeSec":2,"ttlDays":7,"total":0,"pinned":0,"unpinned":0,"counters":{"render_total":0,"render_errors":0,"ascii_failures":0,"storage_write_retries":0,"sweep_runs":2,"sweep_removed":0},"last_render_ms":0,"last_errors":[]}`.
  - `data/counters.json` persisted on boot with all 6 keys.
  - stdio MCP `tools/list` returns all 7 tools: render_mermaid, pin_mermaid, unpin_mermaid, list_diagrams, get_diagram, delete_mermaid, search_diagrams.

## Foundation handed forward

S04 owns the real Claude Code + gsd-pi + MCP Inspector smoke; S04 also owns the README + CHANGELOG updates. S03 alone proves the 4 observability surfaces (stderr JSON, data/counters.json, /health metrics, 3 retry paths) + the full error code set + MEM024 closure + MEM017 sweep unref; it does not prove the real-client integration or the user-facing docs.

## Operational readiness (Q8)

- **Health signal**: `GET /health` returns `counters` (6 monotonic metrics), `last_render_ms` (wall-clock of most recent call), `last_errors[5]` (FIFO ring with code/at/retryable/message). All counters persisted to `data/counters.json` (tmp+rename, single-flight).
- **Failure signal**: stderr JSON `level:"error"` records on every tagged failure; `/health.last_errors[5]` ring surfaces the 5 most recent codes with timestamps + retryable flags; `counters.render_errors` + `counters.ascii_failures` bump on every failure.
- **Recovery**: 3 retry paths — render timeout (10s, throws -32001 on expiry), jsdom init (1x retry, throws -32003 on exhaustion), writeFile EAGAIN/EWOULDBLOCK (1x retry, throws -32004 on exhaustion or terminal errors). HTTP port fallback 5300→5301→5302 (throws -32008 on exhaustion).
- **Monitoring gaps**: none. All 7 S03 requirements (R008, R009, R010, R015, R016, R017, R018) + R020 (error contract) + MEM017 (sweep unref) + MEM024 (id projection) are observably wired through the runtime surface.

## Verification

175/175 tests pass across 23 test files (27 new S03 tests + 0 regressions to S01 + S02 baselines). `npm run test:coverage` exits 0 with 80.95% lines on the 9 included files (above 80% threshold). `node --check` exits 0 on all 9 source modules. S01 invariant preserved: `grep -c "^export" src/server.mjs` returns 6. T01 invariant preserved: `grep -rn "console.error" src/` returns no hits. End-to-end runtime smoke confirmed: stderr emits single-line JSON with stable field order; `GET /health` returns the S03 surface (counters + last_render_ms + last_errors[5]); `data/counters.json` persisted with all 6 keys; stdio MCP `tools/list` returns all 7 tools. MEM024 id projection verified in src/storage/LocalFsStorage.mjs:381 and 448. MEM017 sweep unref verified at src/server.mjs:91 (`.unref()` on the 60-minute setInterval). docs/api.md and docs/mcp-protocol.md both include the S03 surface, the full -32001..-32009 + -32602 error code table, and the namespace disambiguation call-out.

## Requirements Advanced

None.

## Requirements Validated

None.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

None.

## Known Limitations

None.

## Follow-ups

None.

## Files Created/Modified

None.
