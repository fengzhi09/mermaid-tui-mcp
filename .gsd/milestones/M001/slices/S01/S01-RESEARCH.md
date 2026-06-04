# S01: Test + CI foundation — Research

**Date:** 2026-06-04
**Lane:** research
**Slice ID:** S01 (M001)
**Status:** Ready for planning

## Summary

S01 lays the testing + CI baseline for M001. The project today has zero
automated tests and no GitHub Actions workflow. Three modules
(`src/server.mjs`, `src/render.mjs`, `src/storage.mjs`) plus a
`public/view.html` template form the entire production surface. All four
need coverage.

**Decision summary (already locked by D001/D008/D009):**
- Framework: **vitest** (latest 3.x, with `@vitest/coverage-v8`).
- Coverage threshold: **≥ 80% lines** enforced in CI.
- CI matrix: **Node 22 + 24** GitHub Actions, push + PR triggers.
- All 10 `evals.xml` entries become executable vitest tests in
  `tests/evals/`.

**Primary recommendation:** introduce a single `vitest.config.mjs` (no
TypeScript, matches the project's ESM-only plain-JS style), three test
trees under `tests/` (unit / integration / evals), and one
`.github/workflows/ci.yml`. Reuse `scripts/smoke.sh`'s spawn-the-server
pattern (Node child_process JSON-RPC driver) for the integration tests
that need a live stdio MCP server. Storage tests should use a per-test
temp dir to avoid touching the real `data/` directory.

**Biggest unblocker for downstream slices:** S02 and S03 both depend on
S01's test infrastructure. The eval-driven test harness + storage
fixture helpers are the seams they will import. Get those seams right
and S02/S03 don't have to re-derive them.

## Recommendation

### Stack

| Layer | Choice | Rationale |
|---|---|---|
| Test runner | `vitest@^3.0` | Locked by D001. ESM-native, watch mode, JSDoc-friendly, Jest API. |
| Coverage | `@vitest/coverage-v8` | v8 provider is faster; AST remap is now accurate (per vitest 3.2+ notes). |
| Coverage threshold | `lines: 80` (D008) | Enforced in `vitest.config.mjs` via `coverage.thresholds.lines`. |
| CI runner | `actions/setup-node@v4` with `node-version: [22, 24]` | D009. Cache `~/.npm` keyed by `package-lock.json`. |
| Test env | `node` (default) for unit/integration; **no jsdom env** needed for unit tests because we exercise `render.mjs` via the real mermaid pipeline (jsdom is initialized inside `render.mjs` itself) | Don't double up environments. |
| HTTP test client | Node 22+ built-in `fetch` | No new dep. |
| File fixtures | Real temp dirs via `node:fs/promises.mkdtemp` under `os.tmpdir()/mermaid-test-XXXXXX` | No `os.tmpdir()` mocking needed. |

### Repo layout to add

```
vitest.config.mjs                # new — vitest + coverage config
.github/workflows/ci.yml         # new — Node 22+24 matrix, npm test, coverage upload
tests/
  helpers/
    server.mjs                   # spawn src/server.mjs as child, JSON-RPC driver (extracted from smoke.sh)
    storage-fixture.mjs          # makeTempStorage(): root, blobs, store.json writers
    render-fixture.mjs           # valid/malformed/oversized/edge mermaid sources
  unit/
    storage.test.mjs             # put/get/remove/sweep/corruption/atomic-write
    render.test.mjs              # render() success / parse error / oversized / ASCII fail
    file-url.test.mjs            # fileUrlFor() Windows/posix paths
    server-helpers.test.mjs      # extractSvgBody, escapeHtml, httpError, log
  integration/
    stdio-mcp.test.mjs           # spawn server, initialize, list tools, call render_mermaid
    http.test.mjs                # spawn server with MERMAID_RENDERER_HTTP=1, hit /view /pin /raw/svg /health
  evals/
    eval-01-tcp-handshake.test.mjs
    eval-02-three-flows.test.mjs
    eval-03-gantt.test.mjs
    eval-04-malformed.test.mjs
    eval-05-two-renders.test.mjs
    eval-06-er-diagram.test.mjs
    eval-07-oversized.test.mjs
    eval-08-draw-anything.test.mjs
    eval-09-pin-tool.test.mjs    # asserts stdio MCP exposes pin tool (M001 S02 deliverable — see watch-out)
    eval-10-file-link.test.mjs
package.json scripts:
  "test": "vitest run"
  "test:watch": "vitest"
  "test:coverage": "vitest run --coverage"
```

### Seams for downstream slices (S02/S03/S04)

S02 will need to:
- Assert **7 tools** are listed (M001 S02 target).
- Round-trip pin / unpin / list / get / delete / search.
- Exercise `StorageBackend` interface (LocalFsStorage default).

S03 will need to:
- Inject 10s render timeout — read `MERMAID_RENDERER_TIMEOUT_MS` env
  (currently *not* read; S03 will add it). For now, just make sure
  `render.mjs` is testable in isolation; S01 tests cover the success +
  parse-error paths.
- Mock `fs.rename` failure for the storage-write-retry test (S03
  introduces retry; S01 just needs `Storage.save()` to be observable).
- Inspect `/health` JSON shape — current shape is
  `{ status, version, uptimeSec, ttlDays, total, pinned, unpinned }`.
  S03 will extend it; S01 tests should *lock the current shape* so
  S03 additions are diff-visible.

S04 will need:
- A way to spawn the server with controlled env (use the
  `tests/helpers/server.mjs` driver that S01 introduces).
- The eval harness to also work with the *new* S02 7-tool surface
  (eval 09 in particular expects `pin_mermaid`).

**Watch-out (eval 09):** today's `evals.xml` says *"the stdio MCP path
does not expose a pin tool"*. After S02 the assertion flips: pin
**must** be available. The eval test for case 09 needs to be written in
S01 so it currently **fails** against the v0.1.0 server, then **passes**
after S02 lands. Use `it.todo()` or a `describe.skip` with a clear
"ENABLED-AFTER-S02" marker, OR a feature-detect that asserts the
current state and is updated in S02. Recommended: a single
`tests/evals/eval-09-pin-tool.test.mjs` that uses the JSON-RPC
`tools/list` response and asserts `pin_mermaid` is present. This will
fail until S02 — that's expected, document it in the test file header.

### Coverage strategy

- `vitest.config.mjs` sets `coverage.thresholds.lines = 80` and
  `coverage.include = ['src/**/*.mjs']`. `coverage.exclude` should drop
  `src/server.mjs` *mainline bootstrap* (the `await mcp.connect(transport)`
  side-effect at module top-level) — but the helper functions
  (`renderView`, `extractSvgBody`, `escapeHtml`, `fileUrlFor`, `log`,
  `httpError`) must remain covered by unit tests.
- Run `npm run test:coverage` in CI. Upload `coverage/lcov.info` via
  `actions/upload-artifact@v4` (no third-party badge service; optional
  v0.2.0 nice-to-have).
- Branch coverage is NOT enforced (D008 only requires lines; avoid
  ceremony).

## Implementation Landscape

### Key Files

- `src/storage.mjs` — pure ESM class, easy to unit-test; needs
  `load()` / `put()` / `get()` / `setPinned()` / `pruneIfExpired()` /
  `stats()` / `sweep()` coverage. **S01's biggest coverage win is
  here** — it's the most testable surface and currently has zero tests.
  Watch: the sweep logic inlines a `Date.now() - createdAt >
  TTL_MS_DEFAULT` check; tests must inject a clock via
  `vi.useFakeTimers()` (or override `Date.now` in a per-test helper).
  The `save()` method writes the whole `store.json` on every change —
  S01 should test the corruption-recovery branch (truncate the file,
  expect a clean fresh start, not a crash).
- `src/render.mjs` — `render(code)` is the public entry. Tests:
  - empty / whitespace-only → throws `empty mermaid source`.
  - code > 200_000 chars → throws `mermaid source too long (X chars, max 200000)`.
  - valid `graph TD\n  A-->B` → returns `{ id, svg, ascii, sourceLength }` with non-empty svg and id matching `^m[a-z0-9]+$`.
  - malformed → throws `mermaid parse error: ...` (eval 4 contract).
  - `mermaid-ascii` failure: out of scope to force today; the code
    path is a try/catch so we just assert the `ascii` field is a
    string. (Mermaid-ascii may already throw on complex inputs; if it
    does, the catch returns `[mermaid-ascii failed: ...]\n<code>` —
    assert that contract in S01, even if no test triggers it today.)
  - **jsdom init is cached** (`mermaidPromise` module-level var) — once
    per test process. Tests cannot reset it without re-importing
    the module. Acceptable: each test file is a separate process
    boundary in vitest, OR document the caching behavior.
- `src/server.mjs` — split into testable units. Pure helpers
  (`escapeHtml`, `extractSvgBody`, `fileUrlFor`, `httpError`, `log`)
  are easy. The MCP `setRequestHandler` callbacks are best covered
  via **integration tests** (spawn the real server, drive JSON-RPC
  through stdin/stdout). The HTTP route handlers are also best
  covered via the integration test that runs in
  `MERMAID_RENDERER_HTTP=1` mode. **Do not** try to mock
  `StdioServerTransport` — spawn the child, that's the contract.
- `public/view.html` — currently template-substituted by `renderView`
  in `server.mjs`. Don't try to test the HTML output byte-for-byte;
  test that `renderView(id, entry, svg, withPinButton)` returns a
  string containing the substituted `{{ID}}`, `{{CREATED_AT}}`, etc.
  A snapshot test (toMatchInlineSnapshot) on one case is enough.
- `evals.xml` — convert each `<eval>` into a vitest test under
  `tests/evals/eval-NN-*.test.mjs`. The test name and `<eval id>` map
  1:1. Each test invokes `render()` (for code-shape contracts) or
  spawns the server (for protocol-shape contracts). Test bodies are
  short; the `<expected>` text becomes a comment + assertions.

### Build Order

1. **vitest scaffold + first passing run.** Add `vitest@^3` and
   `@vitest/coverage-v8` as devDependencies, write
   `vitest.config.mjs`, add `npm test` / `npm run test:coverage`
   scripts, write *one* trivial unit test
   (`tests/unit/sanity.test.mjs` asserting `1+1 === 2`). Run
   `npm test`; expect green. This proves the harness works on this
   Node version before writing real tests.
2. **Helpers first.** `tests/helpers/server.mjs` (extract the driver
   from `scripts/smoke.sh` so smoke.sh and tests share it — but in S01
   keep smoke.sh untouched; just copy the pattern into the helper
   file). `tests/helpers/storage-fixture.mjs` (mkdtemp + minimal
   `Storage` factory). `tests/helpers/render-fixture.mjs` (the four
   canonical sources: valid, malformed, oversized, ascii-hostile).
3. **Storage unit tests.** Highest coverage win, lowest risk. Target
   `lines ≥ 90%` for this file in isolation (to keep room for the
   other two modules under the 80% global threshold).
4. **Render unit tests.** Eval 4 (malformed) and eval 7 (oversized)
   are pure render-layer tests. Lock those now.
5. **Server-helper unit tests.** `escapeHtml`, `fileUrlFor`,
   `extractSvgBody`, `httpError`. Cheap, high coverage.
6. **Integration test: stdio MCP roundtrip.** Spawn the server, send
   `initialize` + `tools/list` + `tools/call` for `render_mermaid`.
   Reuses smoke.sh's JSON-RPC driver verbatim. This is eval 1, eval
   2, eval 5, eval 6, eval 8.
7. **Integration test: HTTP routes.** Spawn with
   `MERMAID_RENDERER_HTTP=1 MERMAID_RENDERER_PORT=0` (let OS pick a
   port) and assert `/view`, `/pin`, `/raw/svg`, `/health`. This
   covers eval 9 (pin) and eval 10 (fileLink format).
8. **Eval tests.** Convert all 10 evals. One file per eval, name
   `eval-NN-slug.test.mjs`. Body: short comment block quoting the
   `<expected>` text from evals.xml, then 1-5 assertions.
9. **CI workflow.** `.github/workflows/ci.yml` with Node 22+24
   matrix, `npm ci` (not `npm install`), `npm test`. The
   `--coverage` flag is added in a separate job that also uploads the
   `coverage/` artifact. Threshold assertion is in `vitest.config.mjs`
   so a coverage miss fails the test job.
10. **README + smoke.sh touch-up.** Document `npm test`, add a
    coverage badge line (optional). Update `scripts/smoke.sh` to point
    users at `npm test` as the deeper alternative.

### Verification

- `npm test` — all 10 eval tests + unit tests pass.
- `npm run test:coverage` — lines ≥ 80% across `src/**/*.mjs`.
- Manual: open a GitHub PR (or simulate with `act` if available) and
  confirm the matrix job runs both Node 22 and Node 24.
- Pre-merge sanity: `node --check src/server.mjs && node --check
  src/render.mjs && node --check src/storage.mjs` — basic parse check
  the existing project doesn't have.

## Forward Intelligence (for S02/S03/S04)

### Fragility

- **Module-level side effects in `server.mjs`.** The file
  unconditionally creates a `Storage`, calls `await storage.load()`,
  connects `StdioServerTransport`, and (if `MERMAID_RENDERER_HTTP=1`)
  starts an HTTP listener. Spawning it inside vitest works as long as
  vitest's worker doesn't share the process with another test that
  also tries to bind the same port. Mitigation: use port 0 + capture
  the bound port from the `listening` event; or hardcode unique ports
  per test (15301, 15302, ...).
- **`mermaidPromise` module-level cache in `render.mjs`.** Once
  initialized it sticks around. Across test files in the same worker
  process, mermaid state persists. Acceptable for now — don't try to
  reset it. If isolation becomes needed, S01 should use
  `vitest.config.mjs`'s `isolate: true` (default) so each file gets a
  fresh module graph.
- **jsdom + mermaid 11 cold start is slow.** First render in a worker
  process takes ~2-4s (jsdom init + mermaid.initialize). Plan test
  timeouts generously (`vitest.config.mjs` `testTimeout: 30_000` for
  integration/eval tests).
- **`scripts/smoke.sh` shell quirks.** It uses bash-isms
  (`$()` with quoted heredoc, `set -euo pipefail`). Don't rewrite
  it from this slice — extract only the JS driver to
  `tests/helpers/server.mjs`, leave the shell script alone.

### Changed Assumptions

- **Eval 9 (pin via stdio) flips from "absent" to "present" at S02.**
  S01's `eval-09-pin-tool.test.mjs` should use `it.todo()` with a
  comment block explaining it activates in S02, OR (cleaner) write the
  test as a real assertion that fails today. Pick the latter — TDD
  shape is more useful. Document the expected failure in the test
  file header so reviewers don't think it's a bug.
- **Eval 4 (malformed source) error message text is contractual.**
  Today's contract: `mermaid parse error: <mermaid's diagnostic,
  truncated to 500 chars>`. S03 introduces a new error code (`-32002`)
  and a structured `error: { code, message, retryable }` envelope.
  S01's eval-04 test asserts the *current* message shape. S03 will
  extend it. No S01 action needed beyond a header comment.

### Watch-outs

- **Don't add `@types/*` packages.** The project is plain ESM JS with
  JSDoc. Vitest works fine without types. Adding TypeScript as a
  devDep is out of scope for S01.
- **Don't add `eslint` or `prettier`.** Out of scope. The repo's
  existing `.editorconfig` is the style contract.
- **Coverage threshold for the threshold's sake.** D008 says 80%
  *lines*. Set `thresholds.lines: 80` only. Don't set functions /
  branches / statements unless the test naturally hits them — avoid
  ceremony.
- **No flaky-test policy needed yet.** Run-on-CI is the truth;
  vitest's `--reporter=verbose` in CI is enough to diagnose failures.
  No retry plugin for S01.
- **Existing `scripts/smoke.sh` should keep working.** Don't break
  it. It runs in CI today? Probably not (no .github dir), but it's
  used locally — keep it as the fast HTTP boot probe, and let
  `npm test` be the deep suite.

## Open Questions

None for S01. All slice-level decisions are locked (D001/D008/D009).
Eval-09 activation timing is a known coupling to S02 — documented
above as a watch-out, not a research question.
