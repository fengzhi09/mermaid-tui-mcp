---
estimated_steps: 16
estimated_files: 2
skills_used: []
---

# T03: Add render timeout, jsdom init retry, and test seams to render.mjs

Why: R015 requires a 10s render timeout (MERMAID_RENDER_TIMEOUT_MS env, default 10000) that throws RenderTimeoutError (-32001) on expiry. R018 requires a 1x retry of getMermaid() init — if jsdom init fails on the first try, retry once; if it still fails, throw JsdomInitError (-32003). Both retry paths need deterministic test seams so the unit tests can hit the failure paths without flaky timing — mermaid 11 renders are usually < 2s, so a 1ms timeout on a real render is unreliable; the test seam lets the test inject a never-resolving promise to force the timeout. The 3 existing throw sites (empty source, oversize, parse error) stay as raw `throw new Error(...)` and are classified in errors.mjs (per T02's classifyDomainError); this preserves the 9 existing eval tests' message-substring assertions.

Do:
1. Modify src/render.mjs:
   a. Add MERMAID_RENDER_TIMEOUT_MS env read (default 10000) at module load time; cache in a const RENDER_TIMEOUT_MS.
   b. Replace the mermaid.render(id, code).then(out => out.svg) call with a Promise.race against a setTimeout-based timeout. On timeout, clearTimeout the timer, throw RenderTimeoutError (from T02's errors.mjs) with message `mermaid render exceeded ${RENDER_TIMEOUT_MS}ms`. On success, clearTimeout and return the svg.
   c. Add a 1x retry to getMermaid(): on first init failure, clear mermaidPromise (so the next call re-initialises), re-run the init; if the retry also fails, throw JsdomInitError with the second error's message; if the retry succeeds, return the new promise. Only retry once — two attempts total.
   d. Add a `asciiFailed` boolean to the return value of render() — true when the ascii branch caught a mermaidToAscii error (currently swallowed at the catch at lines 101-104); false otherwise. This lets tools.mjs (in T05) increment the ascii_failures counter without re-detecting the sentinel.
   e. Add 2 test seams (both no-ops when not called): `__setMermaidRenderForTesting(fn)` replaces the internal render function (the test passes a function that returns a never-resolving promise to force the timeout path); `__setJSDOMFactoryForTesting(fn)` replaces the internal JSDOM factory (the test passes a function that throws to force the jsdom retry path). Both seams are exported and live alongside the module's other exports.
   f. Add a `__resetMermaidForTesting()` that clears the mermaidPromise cache (so the next getMermaid() call re-initialises from the current factory). Used by the jsdom retry test to ensure a clean state.
2. Extend tests/unit/render.test.mjs (3 new cases):
   a. Timeout: install a mermaid render stub via __setMermaidRenderForTesting that returns new Promise(() => {}) (never resolves); set MERMAID_RENDER_TIMEOUT_MS=10 in beforeEach (restored in afterEach); call render(VALID_GRAPH); expect it to reject with RenderTimeoutError (code -32001, retryable false, message includes the timeout value). Restore the seam in afterEach.
   b. jsdom init retry succeeds: install a JSDOM factory via __setJSDOMFactoryForTesting that throws on first call and returns a valid JSDOM on second call (count invocations); call __resetMermaidForTesting(); call render(VALID_GRAPH); expect success (the retry should fix the first-try failure). Assert the factory was called exactly twice.
   c. jsdom init retry exhausted: install a JSDOM factory that always throws; call __resetMermaidForTesting(); call render(VALID_GRAPH); expect it to reject with JsdomInitError (code -32003, retryable false). Assert the factory was called exactly twice (1 original + 1 retry, not more).
   d. asciiFailed flag: monkey-patch mermaidToAscii to throw; call render(VALID_GRAPH); expect success with asciiFailed: true and the sentinel [mermaid-ascii failed: ...] in the ascii field (preserves the existing R025 sentinel contract).
3. Add the 3 new test seams + RenderTimeoutError + JsdomInitError to the export list at the bottom of render.mjs. Keep the existing exports (render, nextId — well, nextId is internal; just render + the 3 seams).

Done when: `npm test -- tests/unit/render.test.mjs` exits 0; the 4 new test cases pass; the 4 existing test cases (empty, whitespace, non-string, oversize, happy path, parse error) all still pass; node --check src/render.mjs exits 0. The timeout test completes in < 1s (not 10s) thanks to the test seam.

## Inputs

- `src/render.mjs`
- `tests/unit/render.test.mjs`
- `src/errors.mjs`

## Expected Output

- `src/render.mjs`
- `tests/unit/render.test.mjs`

## Verification

npm test -- tests/unit/render.test.mjs

## Observability Impact

adds render_timeout log event (-32001) on slow renders; adds jsdom_init_failed log event (-32003) on cold-start init failure (after 1x retry); adds ascii_failures hook via the asciiFailed return flag (counter increment is wired in T05)
