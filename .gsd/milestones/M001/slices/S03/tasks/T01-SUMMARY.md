---
id: T01
parent: S03
milestone: M001
key_files:
  - src/logger.mjs
  - src/counters.mjs
  - src/helpers.mjs
  - src/server.mjs
  - tests/unit/logger.test.mjs
  - tests/unit/counters.test.mjs
  - tests/unit/server-helpers.test.mjs
key_decisions:
  - Re-export log from helpers.mjs (preserves S01's 6 single-name ^export invariant; lets tests target src/logger.mjs directly without server.mjs bootstrap side effects)
  - Single-flight chain via .then() on this._writeChain — simple, no extra deps, single-process only (R037)
  - Omit code/id on null/undefined (not emit as null) — keeps the JSON shape minimal and lets log shippers pattern-match on key presence
  - Stable field order {ts, level, event, code, id, ...rest} — human-grep-friendly and log-shipper-friendly
  - Best-effort unlink of stale .tmp on load() — recovers from mid-rename crashes without operator intervention
  - Forward-compat: unknown counter keys are accepted and persisted (so future T03/T04 can add ad-hoc keys without a code change to counters.mjs)
duration: 
verification_result: passed
completed_at: 2026-06-04T10:56:46.739Z
blocker_discovered: false
---

# T01: Replaced console.error log() with single-line JSON stderr logger; added 6-key Counters with tmp+rename + single-flight; migrated 7 server.mjs call sites to structured records.

**Replaced console.error log() with single-line JSON stderr logger; added 6-key Counters with tmp+rename + single-flight; migrated 7 server.mjs call sites to structured records.**

## What Happened

## T01: Build structured stderr JSON logger + persistent counters

### What shipped

**New modules**

- `src/logger.mjs` — `log({event, level="info", code?, id?, ...rest})` writes one JSON line to `process.stderr` with stable field order `{ts, level, event, code?, id?, ...rest}`. Required fields `ts/level/event` always present; `code` and `id` are **omitted** (not emitted as `null`) when null/undefined. `process.stderr.write` is wrapped in try/catch so EPIPE / shutdown-time errors do not crash the renderer. `JSON.stringify` is also wrapped in try/catch with a fallback minimal record for circular-ref safety. Tested by `tests/unit/logger.test.mjs` (8 cases).

- `src/counters.mjs` — `Counters` class. Constructor takes a data-dir root. `load()` reads `<root>/counters.json` via `readFile`; on missing file or JSON.parse failure, populates `freshValues()` (all 6 keys at 0). Best-effort unlinks a stale `.tmp` from a prior crash. `increment(key)` appends to a single-flight promise chain (`this._writeChain = this._writeChain.then(...)`), bumps the counter, writes to `<root>/counters.json.tmp`, and `rename`s to the real path. `snapshot()` returns a shallow copy. Exported `COUNTER_KEYS = ["render_total", "render_errors", "ascii_failures", "storage_write_retries", "sweep_runs", "sweep_removed"]`. Single-process mutex only (R037). Tested by `tests/unit/counters.test.mjs` (10 cases including 100-concurrent-increments).

**Modified modules**

- `src/helpers.mjs` — `log` is now a re-export of `logger.mjs`'s `loggerLog`, preserving the 6 single-name `^export` invariant in `src/server.mjs` (MEM015 + S01 audit). 1-line comment added pointing to the new module.

- `src/server.mjs` — all 7 `log()` call sites migrated to the structured record API:
  - L62 backend fallback: `log({level:"warn", event:"backend_stub", backend:"oss"})`
  - L71 sweep error: `log({level:"error", event:"sweep_error", error: String(e?.message || e)})`
  - L99 stdio connect: `log({event:"mcp_stdio_connected"})`
  - L165 http error: `log({level:"error", event:"http_error", method, path, status, error})`
  - L171 http listen: `log({event:"http_listening", host, port})`
  - L189 boot: `log({event:"boot", version, data, http, stats})`
  - L194 shutdown: `log({event:"shutdown", signal})`
  
  No `console.error` or text prefix remains in `src/`.

- `tests/unit/server-helpers.test.mjs` — the `describe("log")` block now mocks `process.stderr.write` (not `console.error`), calls `log({event:"hello", extra:42})`, and asserts the line is a single parseable JSON object with `ts/level/event` in the leading positions, matching the R008 contract. The other 5 describe blocks (escapeHtml, fileUrlFor, extractSvgBody, httpError, renderView) are unchanged.

### Verification outcomes

- `npm test -- tests/unit/logger.test.mjs tests/unit/counters.test.mjs tests/unit/server-helpers.test.mjs` → **29/29 pass** in 1.12s.
- `npx vitest run` (full suite) → **122/122 pass across 20 files** in 23.24s. No regressions to S01 (vitest harness) or S02 (7-tool MCP + HTTP + storage) baselines.
- `node --check src/logger.mjs src/counters.mjs src/server.mjs src/helpers.mjs` → exit 0.
- `grep -c "^export" src/server.mjs` → **6** (S01 invariant preserved).
- `grep -rn "console.error" src/` → no hits (no text-prefix logging left).
- Live boot smoke: `MERMAID_RENDERER_HTTP=1 node src/server.mjs` emits the three boot records (`mcp_stdio_connected`, `boot`, `http_listening`) as one-line JSON with stable field order to stderr.

### Foundation handed forward

T03 (render timeout), T04 (storage write retry), and T05 (registerTools wrapper + /health surface) consume this work directly:
- T03 emits `log({level:"error", event:"render_timeout", id})` from the new timeout path.
- T04 emits `log({level:"warn", event:"storage_write_retry", id, attempt})` and calls `counters.increment("storage_write_retries")` and `sweep_runs`/`sweep_removed`.
- T05 instantiates `Counters`, calls `.load()`, passes `counters` + `logger` into `registerTools`, and extends `/health` with `counters.snapshot()`.

## Verification

29 of 29 new/updated unit tests pass (logger:8, counters:10, server-helpers:11). Full vitest run: 122 of 122 tests pass across 20 files including all S01/S02 baselines — no regressions. `node --check` clean on all 4 source modules. `grep -c "^export" src/server.mjs` returns 6 (S01 invariant preserved). `grep -rn "console.error" src/` returns no hits. Live boot emits single-line JSON to stderr (mcp_stdio_connected, boot, http_listening) with stable field order. 100 concurrent increment() calls converge to render_total=100 (single-flight mutex verified).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run tests/unit/logger.test.mjs tests/unit/counters.test.mjs tests/unit/server-helpers.test.mjs` | 0 | pass — 29/29 tests pass (logger:8, counters:10, server-helpers:11) in 1.12s | 1120ms |
| 2 | `npx vitest run` | 0 | pass — 122/122 tests pass across 20 test files in 23.24s; S01 + S02 baselines preserved | 23240ms |
| 3 | `node --check src/logger.mjs src/counters.mjs src/server.mjs src/helpers.mjs` | 0 | pass — all 4 source modules parse | 800ms |
| 4 | `MERMAID_RENDERER_HTTP=1 node src/server.mjs (timeout 3) — captures stderr JSON stream` | 0 | pass — emits mcp_stdio_connected, boot, http_listening as single-line JSON with stable field order ts/level/event/...rest | 3000ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/logger.mjs`
- `src/counters.mjs`
- `src/helpers.mjs`
- `src/server.mjs`
- `tests/unit/logger.test.mjs`
- `tests/unit/counters.test.mjs`
- `tests/unit/server-helpers.test.mjs`
