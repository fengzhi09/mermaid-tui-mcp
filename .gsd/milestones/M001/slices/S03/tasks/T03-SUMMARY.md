---
id: T03
parent: S03
milestone: M001
key_files:
  - src/render.mjs
  - tests/unit/render.test.mjs
key_decisions:
  - Added a 4th test seam `__setRenderTimeoutForTesting(ms)` to override the cached render timeout for tests (the plan listed 3; the timeout test needs a way to fire in < 1s)
  - Used `vi.hoisted` + `vi.mock("mermaid-ascii", ...)` wrapper for the asciiFailed test (ESM exports are read-only; direct monkey-patching is impossible)
  - Asserted `retryable: true` for both RenderTimeoutError and JsdomInitError per the T02 error class definitions (plan's "retryable false" text appears to be a typo)
  - Implemented the 3 test seams as reset-to-default (passing `null` restores the real implementation) for natural afterEach cleanup
  - Preserved the historical `mermaid parse error: ${msg}` prefix on non-timeout render errors so the 9 existing eval tests' substring assertions and classifyDomainError's -32002 mapping keep working
  - Did NOT re-export RenderTimeoutError/JsdomInitError from render.mjs — the plan's last sentence said "just render + the 3 seams"; the error classes are already re-exported from src/tools.mjs (T02's historical single seam)
duration: 
verification_result: passed
completed_at: 2026-06-04T11:29:58.165Z
blocker_discovered: false
---

# T03: Added 10s render timeout (R015), jsdom init 1x retry with JsdomInitError (R018), asciiFailed flag, and 4 test seams (__setMermaidRenderForTesting, __setJSDOMFactoryForTesting, __resetMermaidForTesting, __setRenderTimeoutForTesting) to src/render.mjs; 4 new test cases pass alongside the 6 existing ones.

**Added 10s render timeout (R015), jsdom init 1x retry with JsdomInitError (R018), asciiFailed flag, and 4 test seams (__setMermaidRenderForTesting, __setJSDOMFactoryForTesting, __resetMermaidForTesting, __setRenderTimeoutForTesting) to src/render.mjs; 4 new test cases pass alongside the 6 existing ones.**

## What Happened

## T03: Add render timeout, jsdom init retry, and test seams to render.mjs

### What shipped

**`src/render.mjs` — 5 changes**

1. **Render timeout (R015)** — Added `MERMAID_RENDER_TIMEOUT_MS` env read (default 10000) cached in a const `RENDER_TIMEOUT_MS` at module load. Wrapped the `mermaid.render(id, code)` call in a `Promise.race` against a `setTimeout`-based timeout. On timeout: `clearTimeout` the timer (no-op since it already fired) and `throw new RenderTimeoutError(\`mermaid render exceeded ${ms}ms\`)`. On success: `clearTimeout` the timer (prevents the callback from firing after we've already returned) and resolve with `out.svg`. The `RenderTimeoutError` passes through the outer catch unchanged (detected by `e.name === "RenderTimeoutError"`) so callers can read `.code = -32001` directly. Every other error from the render call gets the historical `"mermaid parse error: ${msg}"` prefix so the 9 existing eval tests' substring assertions and `classifyDomainError`'s -32002 mapping (T02) keep working.

2. **JSDOM init 1x retry (R018)** — Refactored `getMermaid()` to use a try/catch around the first `initMermaid()` call. On first-attempt failure: clear `mermaidPromise`, re-run `initMermaid()`. If the retry also fails: clear `mermaidPromise` and `throw new JsdomInitError(\`jsdom init failed: ${retryErr.message}\`)`. The retry is bounded to exactly one extra attempt (two total). The error message surfaces the SECOND attempt's underlying reason so operators can diagnose.

3. **asciiFailed flag (S03 ascii counter hook)** — Added a `let asciiFailed = false;` before the `mermaidToAscii` try/catch. Set to `true` in the catch block. The return value is now `{id, svg, ascii, sourceLength, asciiFailed}`. The existing R025 sentinel format (`[mermaid-ascii failed: ${msg}]\n${code}`) is preserved verbatim. The boolean lets `tools.mjs` (T05) increment the `ascii_failures` counter without re-detecting the sentinel substring.

4. **4 test seams** — All exported, all no-ops when not called:
   - `__setMermaidRenderForTesting(fn)` — replaces the internal `mermaid.render` call. `fn` takes `(id, code)` and returns a `Promise<{svg}>`. Pass `null` to restore. Used by the timeout test (passes a never-resolving promise).
   - `__setJSDOMFactoryForTesting(fn)` — replaces the internal JSDOM factory. `fn` takes `(html, opts)` and returns a JSDOM. Pass `null` to restore. Used by the jsdom retry test (throws on first call, returns valid JSDOM on second).
   - `__resetMermaidForTesting()` — clears the cached `mermaidPromise`. Used by the jsdom retry test to start from a clean cache.
   - `__setRenderTimeoutForTesting(ms)` — overrides the cached render timeout for tests. Pass `null` to restore. **This 4th seam is a deviation from the plan** (the plan listed 3) — see Deviations below.

5. **Imports** — Added `import { RenderTimeoutError, JsdomInitError } from "./errors.mjs";` at the top. The two error classes are imported, used internally, and NOT re-exported (the plan's last sentence said "just render + the 3 seams" — the error classes are re-exported from `src/tools.mjs` per T02's historical single-seam pattern).

**`tests/unit/render.test.mjs` — 4 new test cases**

1. **render timeout (R015)** — Installs a never-resolving render stub via `__setMermaidRenderForTesting(() => new Promise(() => {}))`, sets the timeout to 10ms via `__setRenderTimeoutForTesting(10)`, calls `render(VALID_GRAPH)`, expects a `RenderTimeoutError` with `code = -32001`, `name = "RenderTimeoutError"`, `retryable = true` (per T02's transient-failure convention), and a message that includes the timeout value and the `"mermaid render exceeded"` prefix. The test completes in 12ms (well under 1s).

2. **jsdom init retry succeeds** — Installs a factory that throws on first call and returns a real `new JSDOM(html, opts)` on second call (counts invocations via closure). Calls `__resetMermaidForTesting()` to clear the cache, then `render(VALID_GRAPH)`. Asserts the render succeeds (svg contains `<svg`) and the factory was called exactly **2** times (1 original + 1 retry, not more).

3. **jsdom init retry exhausted** — Installs a factory that always throws. Asserts the render rejects with `JsdomInitError` (`code = -32003`, `name = "JsdomInitError"`, `retryable = true`, message contains the synthetic reason). Asserts the factory was called exactly **2** times (retry is bounded).

4. **asciiFailed flag** — Uses `vi.hoisted(() => ({shouldThrow: false}))` to create hoisted state shared with a `vi.mock("mermaid-ascii", ...)` factory. The mock delegates to the real `mermaidToAscii` when the flag is false (default, for all other tests) and throws when the flag is true. Toggles the flag, calls `render(VALID_GRAPH)`, asserts `asciiFailed === true` and the ascii string matches the R025 sentinel prefix `^\[mermaid-ascii failed: `. The render still succeeds (ASCII is best-effort per R025).

Also updated the existing happy-path test to assert `out.asciiFailed === false` (the field is now always present).

### Verification outcomes

- `npm test -- tests/unit/render.test.mjs` → **10/10 pass** in 1.26s. The 6 existing test cases (empty, whitespace, non-string, oversize, happy path, parse error) all still pass; 4 new test cases pass.
- `npx vitest run` (full suite) → **147/147 pass across 21 test files** in 23.30s. Up from 143/143 in T02 (4 new render tests, 0 regressions to S01 + S02 + S03-T01 + S03-T02 baselines).
- `npx vitest run --coverage` → exit 0. `src/render.mjs` shows **100% lines / 90.16% branch / 92.85% functions**. Uncovered branches are all edge cases: the `MERMAID_RENDER_TIMEOUT_MS` invalid-env fallback (line 19), the JSDOM matchMedia fallback (line 71, modern JSDOM always has matchMedia), and the non-Error throw branches in the three catch blocks (lines 101, 161, 174). Aggregate lines 79.49%.
- `node --check src/render.mjs tests/unit/render.test.mjs` → exit 0. Both files parse cleanly.
- `grep -c "^export" src/server.mjs` → **6** (S01 invariant preserved — server.mjs is untouched in T03).
- `grep -rn "console.error" src/` → no hits (T01 invariant preserved — no text-prefix logging).
- **Timeout test wall-clock time**: 12ms (the plan's "completes in < 1s thanks to the test seam" criterion is met).
- **JSDOM retry test wall-clock time**: 38ms (succeeds path) and 0ms (exhausted path). Both well under 1s.
- **asciiFailed test wall-clock time**: 26ms.

### Foundation handed forward

T04 (storage write retry + read timeout) and T05 (registerTools wiring + port-fallback + health-state) consume this work directly:

- **T04** does not touch `src/render.mjs` — it works on `src/storage/FsStorage.mjs` (write retry EAGAIN) and the read timeout. The 10s render timeout is independent of storage timeouts.
- **T05** will:
  - Import `RenderTimeoutError` and `JsdomInitError` from `src/tools.mjs` (the historical single seam, re-exported in T02) to check for `e.code === -32001` / `-32003` in the registerTools wrapper's catch.
  - Wire `log({level:"error", event:"render_timeout", id})` from the catch in `render()` (currently it just re-throws; T05 will add the log call before the re-throw) — wait, actually, the plan says the log call is in T05's wrapper, not in render.mjs. The render.mjs just throws the tagged error.
  - Wire `counters.increment("ascii_failures")` when `out.asciiFailed === true` in the `renderMermaid` handler in `src/tools.mjs`.

### Decisions

- **Added a 4th test seam `__setRenderTimeoutForTesting(ms)`** (the plan listed 3). Reason: the plan says "cache the timeout in a const at module load" and the test sets `MERMAID_RENDER_TIMEOUT_MS=10` in beforeEach. But the const is already frozen at module load with the default 10000 — setting the env var at test time cannot change a cached const. Options considered: (a) read the env var on each call (deviates from "cache in a const"), (b) `vi.stubEnv` + `vi.resetModules` + dynamic import (complex, slow), (c) add a 4th seam (minimal, explicit). Went with (c). The seam is documented in the file's comment block.
- **`vi.hoisted` + `vi.mock("mermaid-ascii", ...)` for the asciiFailed test** (not a direct monkey-patch). Reason: `mermaid-ascii` is an ES module with read-only export bindings; you cannot reassign `mermaidToAscii` from outside. The `vi.mock` factory replaces the entire module with a thin wrapper that checks a hoisted flag. The flag defaults to `false` so all other tests see the real `mermaidToAscii` (transparent pass-through). `vi.hoisted` is required because `vi.mock` is hoisted to the top of the file and runs before top-level `let` declarations are initialized — a bare `let asciiShouldThrow = false` would be in the TDZ when the factory is called.
- **Retryable flag assertions in the new tests follow the T02 error class definitions** (`retryable: true` for both `RenderTimeoutError` and `JsdomInitError`), not the plan's literal text "retryable false". The plan's text appears to be a typo — T02's summary explicitly documents "Retryable flag convention: true for transient failures (RenderTimeout, JsdomInit, StorageRead, PortInUse)". The locked errors.test.mjs tests assert `retryable: true` for both. The new tests assert the same.
- **`__setJSDOMFactoryForTesting(null)` and `__setMermaidRenderForTesting(null)` reset to the real implementation** (not a no-op). Reason: the test's `afterEach` calls these with `null` to restore the default state, so the next test starts from a clean slate. The plan said "no-ops when not called" but a reset-to-default seam is the natural cleanup pattern.

## Verification

10/10 render.test.mjs tests pass (6 existing + 4 new). Full vitest run: 147/147 pass across 21 test files — no regressions. `node --check` clean on both modified files. Coverage: render.mjs at 100% lines / 90.16% branch / 92.85% functions. `grep -c "^export" src/server.mjs` returns 6 (S01 invariant preserved). Timeout test wall-clock: 12ms (well under the 1s target). JSDOM retry tests: 38ms / 0ms. asciiFailed test: 26ms.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run tests/unit/render.test.mjs` | 0 | pass — 10/10 tests pass (6 existing + 4 new) in 1.26s; covers input validation (empty/whitespace/non-string/oversize), happy path with asciiFailed:false, parse error, render timeout (-32001, retryable:true, message contains 10), jsdom retry succeeds (factory called exactly 2x), jsdom retry exhausted (factory called exactly 2x, JsdomInitError -32003), asciiFailed flag (vi.mock + vi.hoisted wrapper throws, render still succeeds with sentinel) | 2580ms |
| 2 | `npx vitest run` | 0 | pass — 147/147 tests pass across 21 test files in 23.30s; up from 143/143 in T02 (4 new render tests, 0 regressions to S01 + S02 + S03-T01 + S03-T02 baselines including 21 errors tests, 29 logger+counters+server-helpers tests, 25 tools tests, 11 stdio MCP integration tests, etc.) | 23300ms |
| 3 | `npx vitest run --coverage` | 0 | pass — render.mjs at 100% lines / 90.16% branch / 92.85% functions; uncovered branches are edge cases (invalid env var fallback, JSDOM matchMedia fallback, non-Error throw branches); aggregate lines 79.49% | 25630ms |
| 4 | `node --check src/render.mjs tests/unit/render.test.mjs` | 0 | pass — both source + test files parse cleanly | 800ms |
| 5 | `grep -c "^export" src/server.mjs` | 0 | pass — returns 6 (S01 invariant preserved; server.mjs is untouched in T03) | 50ms |
| 6 | `grep -rn "console.error" src/` | 0 | pass — no hits (T01 invariant preserved; no text-prefix logging in render.mjs; the new test seams use stderr only via the existing logger.mjs) | 50ms |
| 7 | `npx vitest run tests/unit/render.test.mjs -t "render timeout" --reporter=verbose` | 0 | pass — timeout test completes in 12ms (well under 1s target); 10ms timeout fires before the never-resolving promise resolves | 2080ms |

## Deviations

Added a 4th test seam `__setRenderTimeoutForTesting(ms)` (the plan listed 3: `__setMermaidRenderForTesting`, `__setJSDOMFactoryForTesting`, `__resetMermaidForTesting`). Reason: the plan says to cache the timeout in a const at module load, but the test sets `MERMAID_RENDER_TIMEOUT_MS=10` in beforeEach — a cached const cannot be changed by setting the env var at test time. The 4th seam overrides the cached timeout so the timeout test fires in 12ms instead of waiting the full 10s. The seam is documented in the file's comment block alongside the other 3.

The plan said "retryable false" for both `RenderTimeoutError` and `JsdomInitError` in the test assertions. Followed the T02 error class definitions instead (both have `retryable: true` per the "transient failures are retryable" convention). The locked errors.test.mjs tests assert `retryable: true` for both, so the new tests assert the same for consistency.

The plan said `__setJSDOMFactoryForTesting` and `__setMermaidRenderForTesting` are "no-ops when not called". Implemented them as reset-to-default seams (passing `null` restores the real JSDOM / real `mermaid.render`). This is the natural cleanup pattern for `afterEach` and doesn't change the no-op-when-not-called property (the default state IS the real implementation).

## Known Issues

None.

## Files Created/Modified

- `src/render.mjs`
- `tests/unit/render.test.mjs`
