---
estimated_steps: 28
estimated_files: 10
skills_used: []
---

# T05: Wire logger/counters/errors into server.mjs, add port fallback + health-state, extend /health, unref sweep, extend integration tests

Why: This is the integration task. T01-T04 ship the pure modules and per-component modifications; T05 wires them all together in server.mjs, extends /health with the S03 observability surface (R009), adds the HTTP port fallback (R016) via a new src/port-fallback.mjs helper, adds the 5-error ring + last_render_ms via a new src/health-state.mjs module, unrefs the sweep setInterval (MEM017 — the S01 test helper's SIGTERM→SIGKILL escalation is a band-aid; the proper fix is to unref the interval), extends the 2 integration test files with the new observability assertions, and updates the 2 docs files (api.md, mcp-protocol.md). After T05 the full S03 surface is live: stderr JSON logs, data/counters.json, /health metrics, 3 retry paths, port fallback, MEM024 closed, MEM017 fixed.

Do:
1. Create src/port-fallback.mjs — exports `tryListen(server, host, ports)` which iterates the ports array, attempts `server.listen(port, host)`, and resolves with the port that successfully bound. On `error` event with `e.code === 'EADDRINUSE'`, if the port is not the last in the list, logs a structured `port_in_use` event and tries the next port (after a 50ms unref'd sleep). On the last port, throws PortInUseError (-32008, retryable: true). On non-EADDRINUSE errors, throws immediately. The helper uses node:timers/promises setTimeout (which is unref'd by default).
2. Create src/health-state.mjs — a small state holder. Exports `recordError({code, retryable, message})` which pushes to an internal 5-element ring buffer (FIFO: drop the oldest when full); `setLastRenderMs(ms)` and `getLastRenderMs()`; `snapshot()` returns `{ last_render_ms: number, last_errors: Array<{code, at, retryable, message}> }`. The at field is Date.now() at record time.
3. Create tests/unit/port-fallback.test.mjs (3 cases). Use real net.Server instances and free-port discovery. a. First port succeeds: call tryListen with [freePort]; assert returns the port. b. First port busy, second succeeds: bind another server to a port to occupy it; call tryListen with [occupiedPort, freePort]; assert returns freePort. c. All ports busy: occupy 3 ports; call tryListen with [occupied1, occupied2, occupied3]; assert it throws PortInUseError (code -32008, retryable true).
4. Create tests/unit/health-state.test.mjs (4 cases). a. snapshot() defaults: last_render_ms === 0, last_errors === []. b. recordError pushes to ring; snapshot reflects it. c. Ring bounded at 5: record 7 errors; snapshot.last_errors.length === 5, the oldest 2 are dropped, the most recent is at the end. d. setLastRenderMs / getLastRenderMs round-trip.
5. Modify src/server.mjs:
   a. Import Counters from ./counters.mjs, log from ./logger.mjs (via the re-export in helpers.mjs), PortInUseError from ./errors.mjs, tryListen from ./port-fallback.mjs, { recordError, setLastRenderMs, snapshot as healthSnapshot } from ./health-state.mjs.
   b. Instantiate `const counters = new Counters(DATA); await counters.load();` near the top (after `await storage.load()`).
   c. Reconstruct storage with counters + logger: `storage = new Storage(DATA, { counters, logger: log });` so sweep counter increments are wired.
   d. Unref the sweep setInterval: `setInterval(...).unref();` (the existing interval is not unref'd, which keeps the child process alive after stdio closes — MEM017; the test helper's SIGTERM→SIGKILL escalation is a band-aid, the proper fix is at the source).
   e. Pass counters + logger + health-state recordError/setLastRenderMs to registerTools via ctx: `registerTools(mcp, { storage, render, renderView, dataDir, httpEnabled, httpHost, httpPort, counters, logger: log, recordError, setLastRenderMs });` — registerTools (modified in step 6) will use these to emit structured logs, increment counters, and update the 5-error ring.
   f. Replace `httpServer.listen(HTTP_PORT, HTTP_HOST, ...)` with `await tryListen(httpServer, HTTP_HOST, [HTTP_PORT, HTTP_PORT + 1, HTTP_PORT + 2]).catch((e) => { log({level: "error", event: "http_listen_failed", error: String(e?.message || e), port: HTTP_PORT}); process.exit(1); });` — on EADDRINUSE the helper logs a `port_in_use` event and tries the next port; on exhaustion it logs `http_listen_failed` and exits with code 1.
   g. Extend /health response: merge `counters: counters.snapshot()` and `...healthSnapshot()` into the existing JSON shape. The full response now is `{status, version, uptimeSec, ttlDays, total, pinned, unpinned, counters: {...}, last_render_ms, last_errors: [...]}`. last_errors is always an array (possibly empty), per the S03 research decision.
   h. Emit a structured log on every render attempt (success or failure) — the registerTools wrapper (step 6) handles this; server.mjs only needs to ensure the logger is passed.
6. Modify src/tools.mjs (registerTools wrapper only, no changes to handler bodies):
   a. Accept the new ctx fields: `counters`, `logger`, `recordError`, `setLastRenderMs`. All optional — if absent, the wrapper logs a warning and continues without the observability surface.
   b. On success: emit a structured log `{event: "tool_call", tool: name, status: "ok", elapsed_ms}`. Call `counters?.increment("render_total")` ONLY for the render_mermaid tool (not for the 6 resource-management tools — they don't increment render_total; resource tools have no counter in the current design). Actually, per the roadmap "错误码 -32001 到 -32009 映射到 counter 齐全" the wrapper tracks errors uniformly — increment render_errors for any tagged failure across all 7 tools. Render_total is only for render_mermaid. Call `setLastRenderMs(elapsed_ms)` on every tool call (it's a wall-clock ms of the last attempt regardless of tool).
   c. On tagged failure (e.code is a number): emit `{event: "tool_call", tool: name, status: "error", code, elapsed_ms, retryable}`. Call `counters?.increment("render_errors")` (for any tool failure). Call `recordError({code, retryable, message: String(e.message ?? e)})` to push to the 5-error ring. If the failure is from render_mermaid AND the code is -32002 (parse error) with a mermaidToAscii warning, that's a future case; the ascii-failures counter is incremented by the renderMermaid handler when asciiFailed is true (success path with warning).
   d. In renderMermaid handler: after the existing warnings detection, if `warnings.length > 0` AND `counters` is present, call `counters.increment("ascii_failures")`.
7. Extend tests/integration/http.test.mjs (2 new cases):
   a. /health counters after a render: spawn the server in HTTP mode, make 1 successful render_mermaid call via stdio MCP, then 1 failed render_mermaid call (oversized code → zod -32602). GET /health. Assert: counters.render_total === 1, counters.render_errors === 1, last_errors.length === 1, last_errors[0].code === -32602, last_render_ms > 0. All existing fields (status, version, etc.) are still present.
   b. /health last_errors ring bounded at 5: make 6 failed render_mermaid calls (oversized code each time). GET /health. Assert last_errors.length === 5 (the oldest was dropped).
8. Extend tests/integration/stdio-mcp.test.mjs (1 new case):
   a. zod -32602 via MCP: call render_mermaid with code > 200_000 chars; expect an isError: true response with code: -32602, retryable: false, elapsed_ms: number, and a message string. The message string should mention the length and the max (preserves the eval-07 substring contract).
9. Update docs/api.md: add a section documenting the new /health fields (counters with the 6 keys, last_render_ms, last_errors[5] with shape {code, at, retryable, message}); add a table mapping each -32001..-32009 + -32602 code to its meaning + retryable flag + which log level it emits at.
10. Update docs/mcp-protocol.md: add a section on the error contract — {isError: true, content: [{type: "text", text: JSON.stringify({error: {code, message, retryable, elapsed_ms}})}]} for failure, with the same code table as api.md; explicitly call out the namespace disambiguation (inner error.code is application-level, NOT the JSON-RPC envelope error.code).

Done when: `npm test` exits 0 (all 18+ existing test files / 104+ existing tests preserved, plus the 5+ new S03 test files passing); `npm run test:coverage` exits 0 with lines >= 80% on the included files (helpers.mjs, render.mjs, LocalFsStorage.mjs, tools.mjs, logger.mjs, counters.mjs, errors.mjs, port-fallback.mjs, health-state.mjs); `node --check src/server.mjs src/tools.mjs src/port-fallback.mjs src/health-state.mjs src/logger.mjs src/counters.mjs src/errors.mjs src/render.mjs src/storage/LocalFsStorage.mjs` exits 0. The /health response includes the new fields, the 5-error ring is bounded, the sweep interval is unref'd (verified by the test helper's close() no longer needing the SIGKILL escalation — though we keep the escalation as defense-in-depth).

## Inputs

- `src/server.mjs`
- `src/tools.mjs`
- `src/logger.mjs`
- `src/counters.mjs`
- `src/errors.mjs`
- `src/render.mjs`
- `src/storage/LocalFsStorage.mjs`
- `tests/integration/http.test.mjs`
- `tests/integration/stdio-mcp.test.mjs`
- `docs/api.md`
- `docs/mcp-protocol.md`

## Expected Output

- `src/port-fallback.mjs`
- `src/health-state.mjs`
- `tests/unit/port-fallback.test.mjs`
- `tests/unit/health-state.test.mjs`
- `src/server.mjs`
- `src/tools.mjs`
- `tests/integration/http.test.mjs`
- `tests/integration/stdio-mcp.test.mjs`
- `docs/api.md`
- `docs/mcp-protocol.md`

## Verification

npm test

## Observability Impact

adds the full S03 observability surface: /health returns counters + last_render_ms + last_errors[5]; stderr JSON logs on every tool call (success + failure); HTTP port fallback with EADDRINUSE detection; unref'd sweep setInterval (MEM017 closed); registerTools wrapper increments counters and pushes to the 5-error ring on every tool call; docs updated with the new fields + error code table
