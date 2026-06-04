# S03: Observability - logs, health, counters, error contract

**Goal:** Add structured stderr JSON logging (R008), persistent counters in data/counters.json with tmp+rename atomic writes (R010), the full -32001..-32009 error code set on top of S02's R020 envelope (R020), 3 retry paths (R015 render timeout 10s, R017 writeFile EAGAIN 1x retry, R018 jsdom init 1x retry), HTTP port fallback 5300→5301→5302 (R016), /health metrics extension with counters + last_render_ms + 5-error ring (R009), and the sweep setInterval unref (MEM017). Close the S02 follow-up MEM024 (list_diagrams / search_diagrams items do not carry id).
**Demo:** stderr 单行 JSON 日志(字段稳定 ts 与 level 与 event 与 code 与 id);/health 返 counters 与 last_render_ms 与 last_errors(5 条环形)与现有字段;data/counters.json 持久化启动 load increment save(tmp+rename 原子);10s 渲染超时可注入触发;jsdom 初始化 1 次重试可注入触发;写失败 1 次重试可注入触发;错误码 -32001 到 -32009 映射到 counter 齐全

## Must-Haves

- src/logger.mjs writes single-line JSON to stderr with stable field order {ts, level, event, code?, id?}; null/undefined code and id are omitted (not "code": null); extras are preserved in order; process.stderr.write failures (EPIPE) are swallowed.
- src/counters.mjs persists to data/counters.json with tmp+rename atomic write; COUNTER_KEYS = [render_total, render_errors, ascii_failures, storage_write_retries, sweep_runs, sweep_removed]; load() is corruption-tolerant; increment(key) is single-flight serialized via _writeChain; concurrent Promise.all of 100 increments yields final value 100.
- src/errors.mjs exports ErrorCode enum (-32602, -32001, -32002, -32003, -32004, -32005, -32008, -32009), 6 new tagged error classes (RenderTimeoutError, RenderFailedError, JsdomInitError, StorageReadError, PortInUseError, McpProtocolError), classifyZodError, classifyDomainError, renderError; the namespace disambiguation comment is present.
- src/render.mjs: MERMAID_RENDER_TIMEOUT_MS env (default 10000) wraps mermaid.render() in Promise.race; timeout throws RenderTimeoutError (-32001); getMermaid() retries 1x on init failure; final failure throws JsdomInitError (-32003); test seams __setMermaidRenderForTesting, __setJSDOMFactoryForTesting, __resetMermaidForTesting are exported; return value includes asciiFailed: boolean.
- src/storage/LocalFsStorage.mjs: constructor accepts optional { counters, logger }; writeFile wrapped in retryOnce(classify) — transient (EAGAIN, EWOULDBLOCK) retries 1x; terminal (ENOSPC, EACCES) throws StorageWriteError (-32004) immediately; readFile in readSvg wrapped in 5s timeout → StorageReadError (-32005) on expiry; save() uses tmp+rename; sweep() increments sweep_runs (always) + sweep_removed (when count > 0); list() and search() project {id, ...e} (MEM024 fix).
- src/storage/Backend.mjs: ListResult.items and SearchResult.items typedefs updated to include id: string in the projection.
- src/port-fallback.mjs: tryListen(server, host, ports) handles EADDRINUSE → next port; throws PortInUseError (-32008, retryable: true) on exhaustion; non-EADDRINUSE errors throw immediately; 50ms inter-port sleep is unref'd.
- src/health-state.mjs: 5-error ring buffer (FIFO, bounded); recordError / setLastRenderMs / snapshot; snapshot returns { last_render_ms, last_errors: Array<{code, at, retryable, message}> }.
- src/server.mjs: imports Counters, log, PortInUseError, tryListen, health-state; instantiates Counters at boot, calls .load(); constructs storage with { counters, logger }; unref's the sweep setInterval; passes counters + logger + recordError + setLastRenderMs to registerTools via ctx; replaces httpServer.listen with tryListen; extends /health response with counters + last_render_ms + last_errors[5]; all 7 log() call sites use the structured record API.
- src/tools.mjs: registerTools wrapper emits structured log on every call; increments render_total on render_mermaid success; increments render_errors on any tagged failure; calls setLastRenderMs on every call; calls recordError on every tagged failure; renderMermaid handler increments ascii_failures when warnings.length > 0.
- All 18+ existing test files / 104+ existing tests preserved (S01 + S02 invariants).
- 5+ new test files (logger, counters, errors, port-fallback, health-state) all pass; 3 existing test files (render, storage, server-helpers) extended with 11+ new cases; 2 existing integration test files (http, stdio-mcp) extended with 3 new cases.
- npm test exits 0; npm run test:coverage exits 0 with lines >= 80% on included files (helpers.mjs, render.mjs, LocalFsStorage.mjs, tools.mjs, logger.mjs, counters.mjs, errors.mjs, port-fallback.mjs, health-state.mjs); src/server.mjs stays excluded per vitest.config.mjs.
- node --check on all 9 source modules (server, tools, render, LocalFsStorage, helpers, logger, counters, errors, port-fallback, health-state) exits 0.
- docs/api.md and docs/mcp-protocol.md updated with the new /health fields and the full error code table.

## Proof Level

- This slice proves: integration — the slice proves real stdio MCP + HTTP integration with all 7 tools, 3 retry paths (render timeout, jsdom init, storage write), HTTP port fallback, structured stderr JSON logging, persistent counters in data/counters.json, /health metrics (counters + last_render_ms + last_errors[5]), and the full -32001..-32009 error code set on top of the S02 R020 envelope. All assertions are on real subprocesses (stdio MCP + HTTP) and real files (data/counters.json, data/store.json, data/blobs/<id>.svg).

## Integration Closure

Upstream consumed: S01 test infrastructure (vitest 3.x + v8 coverage + 80% lines threshold, JSON-RPC driver at tests/helpers/server.mjs with SIGTERM→SIGKILL close, makeTempStorage pattern at tests/helpers/storage-fixture.mjs, render fixtures at tests/helpers/render-fixture.mjs); S02 (7 stdio MCP tools with R020 envelopes, StorageBackend interface + LocalFsStorage default impl, tagged error pattern with NotFoundError -32005 + StorageWriteError -32004, title round-trip into entry.title + view.html, MEM024 follow-up known); existing src/server.mjs (6 single-name helper re-exports preserved per S01 audit); existing src/render.mjs (signatures preserved; 3 throw sites stay as raw Error and get classified in errors.mjs); existing public/view.html (no changes).

New wiring introduced: src/logger.mjs (structured stderr JSON), src/counters.mjs (data/counters.json + tmp+rename), src/errors.mjs (full -32001..-32009 + -32602 code set + classifyZodError + classifyDomainError + 6 new tagged error classes), src/port-fallback.mjs (tryListen EADDRINUSE fallback 5300→5301→5302), src/health-state.mjs (5-error ring + last_render_ms); modified src/render.mjs (timeout + jsdom retry + 3 test seams + asciiFailed flag), src/storage/LocalFsStorage.mjs (write retry + read timeout + atomic save + sweep counters + MEM024 id fix), src/tools.mjs (registerTools wrapper gains counters + logger + recordError + setLastRenderMs wiring), src/server.mjs (instantiate counters at boot, unref sweep interval, wire tryListen, extend /health, migrate 7 log() call sites to structured record API); 5 new unit test files; 2 extended unit test files; 2 extended integration test files; 2 updated docs files.

What remains before M001 is end-to-end usable: S04 owns the real Claude Code + gsd-pi + MCP Inspector smoke; S04 also owns the README + CHANGELOG updates. S03 alone proves the 4 observability surfaces (stderr JSON, data/counters.json, /health metrics, retry paths) + the full error code set + MEM024 closure + MEM017 sweep unref; it does not prove the real-client integration or the user-facing docs.

## Verification

- Runtime signals: structured stderr JSON logs with stable field order {ts, level, event, code?, id?, ...rest}; data/counters.json persisted with 6 counter keys; /health HTTP response includes counters + last_render_ms + last_errors[5].
- Inspection surfaces: GET /health (HTTP mode); data/counters.json (file on disk, human-readable JSON); stderr JSON stream (one line per event).
- Failure visibility: 5-error ring buffer in /health.last_errors surfaces the most recent error codes with timestamps + retryable flags; structured error-level logs on retry exhaustion (storage_write_failed, jsdom_init_failed, port_in_use, render_timeout); counter increments visible in /health.counters.<key>.
- Redaction constraints: no secrets in log records; only error.message (sanitized by the throw sites), counter values (integers), and well-known fields (tool name, status code, host, port). User-controlled data (code, title, id) is NEVER included in log records — only referenced via the id field when relevant.

## Tasks

- [x] **T01: Build structured stderr JSON logger + persistent counters** `est:60m`
  Why: R008 requires structured stderr JSON logging with stable fields (ts, level, event, code, id); R010 requires persistent counters in data/counters.json with tmp+rename atomic writes. Both are pure modules with zero S02 dependencies and form the foundation for T03 (render timeout events), T04 (storage write retry events, sweep counter), and T05 (registerTools wrapper counter increment, /health metrics surface). The current log() in src/helpers.mjs:57 uses console.error with a [HH:MM:SS][mermaid-renderer] text prefix — this task replaces it with structured JSON output and migrates the 7 server.mjs call sites. The current code has no persistence layer for metrics — this task adds src/counters.mjs with 6 counter keys, corruption-tolerant load(), single-flight serialized increment(), and tmp+rename atomic write.
  - Files: `src/logger.mjs`, `src/counters.mjs`, `tests/unit/logger.test.mjs`, `tests/unit/counters.test.mjs`, `src/helpers.mjs`, `src/server.mjs`, `tests/unit/server-helpers.test.mjs`
  - Verify: npm test -- tests/unit/logger.test.mjs tests/unit/counters.test.mjs tests/unit/server-helpers.test.mjs

- [x] **T02: Build errors module with the full -32001..-32009 + -32602 code set** `est:60m`
  Why: R020 (the error contract) and the 3 retry-path requirements (R015, R016, R017, R018) all need a centralized error code namespace + classification function. S02's tools.mjs already ships a partial implementation: NotFoundError (-32005, retryable: false) and StorageWriteError (-32004, retryable: true), used by 4 of the 7 tools. S03 must add the missing codes (-32001 render_timeout, -32002 render_failed, -32003 jsdom_init_failed, -32005 storage_read_failed (new class, retryable: true — distinct from NotFoundError which is retryable: false), -32008 port_in_use, -32009 mcp_protocol_violation) and the classifyDomainError function that maps the existing render.mjs Error throws (mermaid parse error, empty source, source too long) to the right codes without breaking the 9 existing eval tests that assert on the message text. The "code namespace" ambiguity (MCP SDK uses -32000/-32001 for transport-level codes) must be documented in a header comment so future readers don't collide.
  - Files: `src/errors.mjs`, `tests/unit/errors.test.mjs`, `src/tools.mjs`
  - Verify: npm test -- tests/unit/errors.test.mjs

- [x] **T03: Add render timeout, jsdom init retry, and test seams to render.mjs** `est:90m`
  Why: R015 requires a 10s render timeout (MERMAID_RENDER_TIMEOUT_MS env, default 10000) that throws RenderTimeoutError (-32001) on expiry. R018 requires a 1x retry of getMermaid() init — if jsdom init fails on the first try, retry once; if it still fails, throw JsdomInitError (-32003). Both retry paths need deterministic test seams so the unit tests can hit the failure paths without flaky timing — mermaid 11 renders are usually < 2s, so a 1ms timeout on a real render is unreliable; the test seam lets the test inject a never-resolving promise to force the timeout. The 3 existing throw sites (empty source, oversize, parse error) stay as raw `throw new Error(...)` and are classified in errors.mjs (per T02's classifyDomainError); this preserves the 9 existing eval tests' message-substring assertions.
  - Files: `src/render.mjs`, `tests/unit/render.test.mjs`
  - Verify: npm test -- tests/unit/render.test.mjs

- [x] **T04: Add write retry, read timeout, atomic save, sweep counters, and MEM024 id projection to LocalFsStorage** `est:90m`
  Why: R017 requires writeFile to retry once on transient errors (EAGAIN, EWOULDBLOCK) and throw StorageWriteError (-32004, retryable: true) on terminal errors (ENOSPC, EACCES) or after retry exhaustion. R005's readFile side requires a 5s read timeout that throws StorageReadError (-32005, retryable: true) on expiry. R010 requires the counter increment surface to be present in sweep() (sweep_runs + sweep_removed). MEM024 is a real S02 surface gap that LLM clients hit immediately: list_diagrams and search_diagrams return items without the `id` field, so an LLM client cannot pin/get/delete any item by reference — the only stable identifier is the map key, dropped in `LocalFsStorage.list()` and `.search()`. S03 closes this by projecting `{id, ...e}` in both methods. The Backend.mjs JSDoc typedefs for ListResult.items and SearchResult.items must be updated to include `id: string` in the projection.
  - Files: `src/storage/LocalFsStorage.mjs`, `src/storage/Backend.mjs`, `tests/unit/storage.test.mjs`
  - Verify: npm test -- tests/unit/storage.test.mjs

- [x] **T05: Wire logger/counters/errors into server.mjs, add port fallback + health-state, extend /health, unref sweep, extend integration tests** `est:120m`
  Why: This is the integration task. T01-T04 ship the pure modules and per-component modifications; T05 wires them all together in server.mjs, extends /health with the S03 observability surface (R009), adds the HTTP port fallback (R016) via a new src/port-fallback.mjs helper, adds the 5-error ring + last_render_ms via a new src/health-state.mjs module, unrefs the sweep setInterval (MEM017 — the S01 test helper's SIGTERM→SIGKILL escalation is a band-aid; the proper fix is to unref the interval), extends the 2 integration test files with the new observability assertions, and updates the 2 docs files (api.md, mcp-protocol.md). After T05 the full S03 surface is live: stderr JSON logs, data/counters.json, /health metrics, 3 retry paths, port fallback, MEM024 closed, MEM017 fixed.
  - Files: `src/port-fallback.mjs`, `src/health-state.mjs`, `tests/unit/port-fallback.test.mjs`, `tests/unit/health-state.test.mjs`, `src/server.mjs`, `src/tools.mjs`, `tests/integration/http.test.mjs`, `tests/integration/stdio-mcp.test.mjs`, `docs/api.md`, `docs/mcp-protocol.md`
  - Verify: npm test

## Files Likely Touched

- src/logger.mjs
- src/counters.mjs
- tests/unit/logger.test.mjs
- tests/unit/counters.test.mjs
- src/helpers.mjs
- src/server.mjs
- tests/unit/server-helpers.test.mjs
- src/errors.mjs
- tests/unit/errors.test.mjs
- src/tools.mjs
- src/render.mjs
- tests/unit/render.test.mjs
- src/storage/LocalFsStorage.mjs
- src/storage/Backend.mjs
- tests/unit/storage.test.mjs
- src/port-fallback.mjs
- src/health-state.mjs
- tests/unit/port-fallback.test.mjs
- tests/unit/health-state.test.mjs
- tests/integration/http.test.mjs
- tests/integration/stdio-mcp.test.mjs
- docs/api.md
- docs/mcp-protocol.md
