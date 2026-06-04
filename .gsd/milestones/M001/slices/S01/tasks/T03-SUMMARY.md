---
id: T03
parent: S01
milestone: M001
key_files:
  - tests/integration/stdio-mcp.test.mjs
  - tests/integration/http.test.mjs
  - tests/helpers/server.mjs
key_decisions:
  - Hardened tests/helpers/server.mjs close() with SIGTERM (150ms) -> SIGKILL (1200ms) escalation. The server's mainline bootstrap registers an hourly setInterval for sweep that is not unref'd, so on Linux/macOS the process never exits on its own when stdio closes — the original 500ms single-kill safety net (which sent SIGTERM, caught by the server's handler as a 3s unref'd drain) hung the test. Two-step escalation is the standard graceful-then-forceful pattern and works cross-platform (on Windows both signals map to TerminateProcess, so it's effectively immediate). Captured as MEM017 (gotcha) for future slices.</item>
<item>Used free-port (net.createServer().listen(0) + close) for the HTTP test instead of the plan's "poll from 15300" alternative. Free-port is faster (one port check vs many), more robust (no arbitrary starting port), and handles parallel test runs naturally. The plan's spirit — "discover the port, then test the routes" — is preserved.</item>
<item>Split the stdio MCP test into 3 separate it() blocks (initialize / tools/list / tools/call) rather than one big test. The plan describes the steps of a single flow, but vitest conventions favor one assertion per test for better failure isolation. Each test pays the server-spawn cost (~1s) but the failure messages are cleaner (a tools/list failure does not also report an initialize failure).</item>
<item>Per-test temp data dir under os.tmpdir() (mkdtemp + rm) keeps the real <repo>/data/ untouched and avoids cross-test contamination. The mkdtemp prefix (mermaid-int-stdio- / mermaid-int-http-) makes any leaked temp dir trivially identifiable as test-only.</item>
<item>For the HTTP test, used waitForHealth() with a 5s timeout to confirm the HTTP listener is up before driving it. The plan's "First call render, then /health" order is preserved in spirit: we seed a render, then hit /health — we just wait for the HTTP server to be ready first (otherwise the first /health call would fail intermittently and need its own retry loop).</item>
duration: 
verification_result: passed
completed_at: 2026-06-04T06:55:29.023Z
blocker_discovered: false
---

# T03: Wrote 4 integration tests across stdio MCP (initialize, tools/list, tools/call) and HTTP (/health, /raw/svg, /pin, /view) that spawn the real server as a child process; hardened the spawnServer close() with SIGTERM→SIGKILL escalation for cross-platform reliability.

**Wrote 4 integration tests across stdio MCP (initialize, tools/list, tools/call) and HTTP (/health, /raw/svg, /pin, /view) that spawn the real server as a child process; hardened the spawnServer close() with SIGTERM→SIGKILL escalation for cross-platform reliability.**

## What Happened

## What Happened

Wrote the S01/T03 integration-test layer that drives the real `src/server.mjs` as a child process — locking the v0.1.0 MCP stdio surface and the four HTTP routes under vitest, so a future change to server.mjs can't silently break the gsd-pi-facing contract.

### 1. Created `tests/integration/stdio-mcp.test.mjs` (3 tests)

Three separate `it` blocks over a shared `beforeEach`/`afterEach` (fresh server per test, per-test temp `MERMAID_RENDERER_DATA` dir under `os.tmpdir()` + `mkdtemp`, cleanup with `fs/promises.rm`):

- **`initialize` handshake** — sends `protocolVersion: "2025-06-18"`, `clientInfo: { name: "vitest", version: "0.0.0" }`, asserts `result.serverInfo.name === "mermaid-tui-mcp"` and that the version is a non-empty string.
- **`tools/list` surface** — asserts a tool named `render_mermaid` exists with a non-empty `description` and an `inputSchema.required` that includes `"code"`. Pins the JSON-Schema shape gsd-pi depends on.
- **`tools/call` happy path** — calls `render_mermaid` with `code: "graph TD\n  A-->B"`, asserts `content[0].type === "text"`, parses the JSON text, asserts non-empty `id` / `ascii` / `fileLink`, and that `fileLink` starts with `file:///` and ends with `.html`.

### 2. Created `tests/integration/http.test.mjs` (1 test)

Single end-to-end test that exercises all four routes the standalone daemon exposes:

- Picks a free port via `net.createServer().listen(0)` + close — avoids collisions with other local processes and parallel test runs (used a free port instead of the plan's "poll from 15300" alternative because it's faster, more robust, and handles parallelism naturally; the plan's spirit — "discover the port, then test the routes" — is preserved).
- Spawns the server with `MERMAID_RENDERER_HTTP=1` + the picked port + a per-test temp data dir.
- Polls `GET /health` (5s timeout, 50ms interval) to confirm the HTTP listener is up before driving it.
- Seeds a render via the stdio MCP path (`render_mermaid` with `code: "graph TD\n  A-->B"`).
- Hits `GET /health` (asserts `status: "ok"`, `version` is a non-empty string, `total >= 1`).
- Hits `GET /raw/svg?id=<id>` (asserts 200, `Content-Type` contains `image/svg+xml`, body matches `/<svg/`).
- Hits `POST /pin?id=<id>&pin=true` (asserts 200, body has `pinned: true` and echoes the id).
- Hits `GET /view?id=<id>` (asserts 200, `Content-Type` contains `text/html`, body contains the rendered id).

### 3. Hardened `tests/helpers/server.mjs` `close()` (cross-platform safety)

The original 500ms safety net did `child.kill()` (SIGTERM). The server's mainline bootstrap registers an hourly `setInterval` for the sweep that is **not** `unref`'d, so the event loop never goes idle on its own. On Windows `child.kill()` maps to `TerminateProcess` and the test still works, but on Linux/macOS the SIGTERM handler's 3s unref'd drain timer can't overcome the live setInterval — the process never exits, the `child.on("exit")` listener never fires, and `close()` hangs.

Replaced the single 500ms `child.kill()` with a two-step escalation:
- 150ms: `child.kill("SIGTERM")` — graceful, lets the server flush
- 1200ms: `child.kill("SIGKILL")` — force-kill if SIGTERM didn't take

Captured as **MEM017** (gotcha) for future slices that touch process lifecycle.

### 4. Final verification
- `npm test` — 6 files, 38 tests, all green, exit 0 in ~8.1s.
- `npm run test:coverage` — exit 0; helpers.mjs 100% / render.mjs 95.65% / storage.mjs 96.8% lines (server.mjs excluded per vitest.config.mjs, as planned). Threshold `coverage.thresholds.lines: 80` satisfied.
- `node --check` clean on all 7 affected files.
- No `data/` directory written to the repo (per-test temp dirs are cleaned up by `afterEach`).

### What I did NOT do (left for downstream tasks)
- T04: 10 eval tests ported from `evals.xml`.
- T05: CI workflow + parse-sanity gate in the slice-level verification.

## Verification

## Verification

Done-when criteria for T03, all met:

1. **`tests/integration/stdio-mcp.test.mjs` exists and exercises the three stdio JSON-RPC methods** — `initialize` handshake (asserts `serverInfo.name === "mermaid-tui-mcp"`), `tools/list` (asserts `render_mermaid` exists with non-empty description and `required` includes `code`), `tools/call` (asserts the JSON-parsed text block has non-empty `id`/`ascii`/`fileLink`, and that `fileLink` starts with `file:///` and ends with `.html`).
2. **`tests/integration/http.test.mjs` exists and exercises all four routes** — `GET /health` (status 200, `status === "ok"`, `version` non-empty, `total >= 1`), `GET /raw/svg?id=<id>` (200, `image/svg+xml` content-type, body matches `/<svg/`), `POST /pin?id=<id>&pin=true` (200, `pinned: true`), `GET /view?id=<id>` (200, `text/html` content-type, body contains the id).
3. **Each test uses a per-test temp `MERMAID_RENDERER_DATA` dir under `os.tmpdir()`** — `mkdtemp` in `beforeEach`, `fs/promises.rm(... { recursive: true, force: true })` in `afterEach`. The real `<repo>/data/` is never touched (verified with `ls data` → not found).
4. **The HTTP test picks a free port dynamically** — uses `net.createServer().listen(0)` + close, then passes that port as `MERMAID_RENDERER_PORT`. Avoids collisions with other local processes and parallel runs.
5. **`spawnServer()` is used as required** — both files import from `../helpers/server.mjs` and drive the same JSON-RPC driver the unit tests would have used.
6. **`npm test` exits 0** — 6 files, 38 tests, all green (34 existing unit/sanity + 3 new stdio + 1 new HTTP).
7. **`npm run test:coverage` exits 0** — coverage threshold `lines: 80` still satisfied (helpers.mjs 100% / render.mjs 95.65% / storage.mjs 96.8% — all above 80%).
8. **All affected files parse clean** — `node --check` on `src/server.mjs`, `src/render.mjs`, `src/storage.mjs`, `src/helpers.mjs`, `tests/helpers/server.mjs`, `tests/integration/stdio-mcp.test.mjs`, `tests/integration/http.test.mjs` all return 0.
9. **Cross-platform shutdown safety** — the helper's `close()` now escalates SIGTERM → SIGKILL so the test does not hang on Linux/macOS runners where the server's non-unref'd `setInterval` keeps the event loop alive past the SIGTERM drain.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node --check src/server.mjs && node --check src/render.mjs && node --check src/storage.mjs && node --check src/helpers.mjs && node --check tests/helpers/server.mjs && node --check tests/integration/stdio-mcp.test.mjs && node --check tests/integration/http.test.mjs` | 0 | ✅ pass — all 7 affected files parse clean | 176ms |
| 2 | `npx vitest run tests/integration/stdio-mcp.test.mjs` | 0 | ✅ pass — 3 stdio MCP integration tests (initialize, tools/list, tools/call) all green | 5260ms |
| 3 | `npx vitest run tests/integration/http.test.mjs` | 0 | ✅ pass — HTTP integration test (health, raw/svg, pin, view) green | 3280ms |
| 4 | `npm test` | 0 | ✅ pass — 6 test files, 38 tests (34 prior + 3 new stdio + 1 new HTTP), all green | 8148ms |
| 5 | `npm run test:coverage` | 0 | ✅ pass — coverage: helpers.mjs 100%, render.mjs 95.65%, storage.mjs 96.8% lines; threshold.lines=80 satisfied | 8062ms |
| 6 | `ls data 2>/dev/null && echo STRAY || echo clean` | 0 | ✅ pass — no stray data/ in repo (per-test temp dirs cleaned up by afterEach) | 50ms |

## Deviations

Used free-port for the HTTP test (plan's "poll from 15300" alternative was the suggested approach; I chose a different free-port variant — find a free port first, then pass it as PORT — which is faster and more robust). Split the stdio MCP test into 3 it() blocks instead of one big flow. Hardened the helper's close() with SIGTERM->SIGKILL escalation (not in the plan, but necessary to avoid hanging the test on non-Windows CI runners). All three deviations are documented in the narrative and key_decisions sections.</item>
</invoke>

## Known Issues

None.</knownIssues>

## Files Created/Modified

- `tests/integration/stdio-mcp.test.mjs`
- `tests/integration/http.test.mjs`
- `tests/helpers/server.mjs`
