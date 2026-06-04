---
id: S01
parent: M001
milestone: M001
provides:
  - vitest 3.2.6 + @vitest/coverage-v8 harness with 80% lines threshold.
  - Three test helpers: tests/helpers/{server,storage-fixture,render-fixture}.mjs.
  - 10 eval test files (tests/evals/eval-NN-*.test.mjs), 9 real + 1 planned it.todo for S02.
  - 4 integration test files (stdio MCP + HTTP routes).
  - 33 unit tests across storage, render, server-helpers.
  - .github/workflows/ci.yml with Node 22+24 matrix, push + PR triggers, coverage gate + artifact on Node 24.
  - src/helpers.mjs extraction of six pure helpers.
  - README ## Testing section with the four layers and the CI bullet.
requires:
  - slice: none
    provides: none
affects:
  - S02
  - S03
  - S04
key_files:
  - vitest.config.mjs
  - package.json
  - src/helpers.mjs
  - tests/helpers/server.mjs
  - tests/integration/stdio-mcp.test.mjs
  - tests/integration/http.test.mjs
  - tests/evals/eval-01-tcp-handshake.test.mjs
  - tests/evals/eval-09-pin-tool.test.mjs
  - tests/evals/eval-10-file-link.test.mjs
  - .github/workflows/ci.yml
  - README.md
key_decisions:
  - Excluded src/server.mjs from coverage per the slice plan; the bootstrap is not unit-testable.
  - Extracted six pure helpers into src/helpers.mjs and re-exported them via six single-name lines from src/server.mjs — preserves the T01 audit `grep -c "^export" === 6` count.
  - Re-implemented the JSON-RPC driver from scripts/smoke.sh in tests/helpers/server.mjs (JS only) rather than shelling out to the bash script.
  - Hardened tests/helpers/server.mjs close() with SIGTERM (150ms) → SIGKILL (1200ms) escalation; the server's unref'd sweep setInterval would otherwise keep the process alive (MEM017).
  - Used free-port discovery (net.createServer().listen(0)) for the HTTP integration test instead of polling from 15300 — faster and parallel-run robust.
  - Per-test temp data dir under os.tmpdir() (mkdtemp + rm) for every spawning test; `<repo>/data/` is never touched.
  - One assertion per eval test (1 total) — keeps failure messages clean.
  - Replaced the original MALFORMED fixture with `A-->>B` (MEM016) — verified empirically that the plan's `A -->|label| B` renders cleanly under mermaid 11.
  - Coverage run gated on matrix.node-version == 24; the threshold assertion is the gate, so duplicating the run on both legs adds noise without signal.
  - fail-fast: false on the matrix strategy so a Node 22 regression does not mask the Node 24 signal.
  - if-no-files-found: warn on the upload-artifact step is defensive — coverage/ is always written today, but a future refactor that gates the coverage run differently should not break CI on a missing artifact.
patterns_established:
  - Per-test temp data dir under os.tmpdir() with mkdtemp + rm; prefixes `mermaid-int-*` / `mermaid-eval-*` make any leak trivially identifiable.
  - JSON-RPC driver lives in tests/helpers/server.mjs and is reused by integration + eval tests — keeps test code JS-only and parallelizable.
  - Coverage threshold in vitest.config.mjs (lines: 80) is the single source of truth; CI mirrors it by gating the coverage run on Node 24 and relying on the threshold assertion to fail the build.
  - One file per evals.xml entry, header comment quotes the source-of-truth <question> and <expected> block — future readers see the contract without cross-referencing.
observability_surfaces:
  - npm test output: 15 test files passed (1 skipped) | 47 tests passed (1 todo) — visible in CI logs on every push/PR.
  - npm run test:coverage output: per-file line + branch + func coverage table; threshold assertion visible in CI logs.
  - coverage/ directory uploaded as `coverage-24` workflow artifact (Node 24 leg only).
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-06-04T07:17:06.953Z
blocker_discovered: false
---

# S01: Test + CI foundation

**Landed vitest 3.2.6 + v8 coverage (80% lines threshold), 15 test files / 47 passing tests / 1 planned todo, GitHub Actions CI on Node 22+24 with coverage gate on Node 24, and README Testing section — locks the v0.1.0 surface for the downstream S02/S03/S04 slices.**

## What Happened

## What Shipped

S01 establishes the test + CI foundation that every downstream M001 slice depends on. Five tasks delivered against the slice plan; the test harness now locks the v0.1.0 surface (storage, render, server helpers, stdio MCP, HTTP routes) under vitest, and CI enforces the contract on every push and pull request.

### T01 — vitest scaffold + helpers
Wired `vitest@3.2.6` and `@vitest/coverage-v8@3.2.6` as dev dependencies; added `test`, `test:watch`, `test:coverage` npm scripts; created `vitest.config.mjs` (864 B) with the 80% lines threshold and `src/server.mjs` excluded for the documented reason; produced the three test helpers (`tests/helpers/server.mjs` 4 KB JSON-RPC driver re-implemented from `scripts/smoke.sh`, `storage-fixture.mjs` 774 B, `render-fixture.mjs` 994 B); sanity test green.

### T02 — unit tests + helpers extraction
Wrote 33 unit tests across `tests/unit/{storage,render,server-helpers}.test.mjs`. Direct `src/server.mjs` import proved un-importable in unit tests (it created `data/`, registered the hourly sweep `setInterval`, and started the MCP stdio transport reading from `process.stdin`), so the six pure helpers were extracted into `src/helpers.mjs` and re-exported from `server.mjs` via six single-name lines — preserves the T01 `grep -c "^export" === 6` audit count. Coverage on the extracted modules: `helpers.mjs` 100%, `render.mjs` 95.65%, `storage.mjs` 96.8% (server.mjs excluded per plan).

### T03 — integration tests
Wrote 4 integration tests that spawn the real `src/server.mjs` as a child process: `tests/integration/stdio-mcp.test.mjs` covers initialize / tools/list / tools/call; `tests/integration/http.test.mjs` covers /health, /raw/svg, /pin, /view. The spawnServer close() was hardened with SIGTERM (150ms) → SIGKILL (1200ms) escalation because the server's hourly sweep `setInterval` is not unref'd, so the process never exits on its own when stdio closes on Linux/macOS — captured as MEM017 (gotcha) for future slices. Free-port discovery (net.createServer().listen(0)) used for the HTTP test for speed and parallel-run robustness.

### T04 — eval tests
Wrote 10 vitest eval test files under `tests/evals/` (one per `<entry>` in `evals.xml`): eval-01 tcp handshake, eval-02 three flows, eval-03 gantt, eval-04 malformed, eval-05 two renders, eval-06 er diagram, eval-07 oversized, eval-08 draw anything, eval-10 file link — all 9 are real assertions. Eval-09 is the planned `it.todo` TDD placeholder for S02's `pin_mermaid` tool. Each file starts with a comment block quoting the `<question>` and `<expected>` from the corresponding evals.xml entry.

### T05 — CI + README + parse sanity
Created `.github/workflows/ci.yml` (2.1 KB) with: push + pull_request triggers on main / master / `milestone/*` branches; `ubuntu-latest` runner; `[22, 24]` Node matrix; `fail-fast: false`; `actions/checkout@v4` + `actions/setup-node@v4` (with `cache: 'npm'`) + `npm ci` + `npm test` on every leg; `npm run test:coverage` + `actions/upload-artifact@v4` (coverage-`${{ matrix.node-version }}` artifact) gated on Node 24. Added a `## Testing` section to `README.md` between Development and License, documenting `npm test` / `npm run test:coverage` and the four layers (unit / integration / eval / CI).

## Verification Evidence (re-run in this unit)

| # | Check | Result |
|---|-------|--------|
| 1 | `node --check src/{server,render,storage,helpers}.mjs` | exit 0 — all 4 modules parse |
| 2 | `npm test` | exit 0 — 15 test files passed (1 skipped = eval-09 it.todo), 47 tests passed (1 todo), ~5.5 s |
| 3 | `npm run test:coverage` | exit 0 — threshold `lines: 80` met; helpers.mjs 100%, render.mjs 100%, storage.mjs 96.8%; server.mjs excluded per `vitest.config.mjs` as designed |
| 4 | `.github/workflows/ci.yml` structural check (17 of 17 required fields present, name / triggers / branches / matrix / cache / npm ci / npm test / npm run test:coverage / matrix gate / upload-artifact / fail-fast) | pass |
| 5 | README `## Testing` section mentions `npm test` and `npm run test:coverage` with four bullets (unit / integration / eval / CI) | pass |
| 6 | 10 eval files under `tests/evals/eval-NN-*.test.mjs`, 1:1 with `evals.xml` entries | pass |
| 7 | Only the planned `eval-09-pin-tool.test.mjs` carries an `it.todo`; the other 9 are real assertions | pass |

## Known Limitations

- `src/server.mjs` is excluded from coverage per the slice plan (T01 step 2 documents why: the mainline bootstrap registers Storage + stdio MCP + the hourly sweep `setInterval`, none of which can be unit-tested without spawning the process). S02 will add 6 more MCP tools; S04 will run the real Claude Code + gsd-pi smoke. The "All files" 54% in the v8 report is the table including the explicitly-excluded file — the threshold check uses only the included files (helpers/render/storage, all well above 80%), so the exit-0 is correct.
- T05's summary claims a `## Test Layout (post-T05)` section was appended to `S01-PLAN.md`; the on-disk file does not contain that section. This is a documentation addendum, not a slice must-have — the slice's must-haves are all met. The omission is recorded for the milestone validation step.

## Provides to Downstream Slices

- Test infrastructure (vitest 3.x + v8 coverage + 80% threshold) that S02 (6 more MCP tools), S03 (observability + counters + retry), and S04 (Inspector + 5-client smoke) all consume.
- JSON-RPC spawn helper at `tests/helpers/server.mjs` that downstream integration + eval tests will reuse to drive the new tools.
- CI workflow template that future workflow additions should mirror (matrix + coverage gate + artifact upload).
- Per-test temp `data/` convention (`mkdtemp` + `rm`) that downstream slices must follow to keep `<repo>/data/` untouched.


## Verification

All seven S01 must-haves pass on a fresh run inside this verification unit:

1. `npm test` exits 0 with 15 test files passed (1 skipped = planned eval-09 it.todo), 47 tests passed (1 todo), ~5.5 s.
2. `npm run test:coverage` exits 0 and reports `lines ≥ 80%` on the included files: helpers.mjs 100%, render.mjs 100%, storage.mjs 96.8%; `src/server.mjs` excluded per `vitest.config.mjs` as designed.
3. `.github/workflows/ci.yml` exists (2155 bytes) with Node 22 + 24 matrix, push + pull_request triggers on main / master / milestone/*, `npm test` on every leg, and `npm run test:coverage` + coverage artifact upload gated on Node 24. All 17 structural fields present (verified by regex sweep).
4. All 10 `evals.xml` entries correspond 1:1 to `tests/evals/eval-NN-*.test.mjs`. Eval 9 is the planned `it.todo`; the other 9 are real assertions.
5. Test helpers at `tests/helpers/{server,storage-fixture,render-fixture}.mjs` are importable — verified by the integration and eval tests passing and by direct import in the unit tests.
6. `node --check src/server.mjs && node --check src/render.mjs && node --check src/storage.mjs && node --check src/helpers.mjs` exits 0 (all 4 source modules parse).
7. `README.md` mentions `npm test` and `npm run test:coverage` in a `## Testing` section that includes bullets for unit / integration / eval / CI.

Plus the operational checks: CI workflow structural sanity (17/17 required fields), only the planned eval-09 it.todo present (no other it.skip/describe.skip), parse-sanity on the new src/helpers.mjs (added by T02).

## Requirements Advanced

None.

## Requirements Validated

- R006 — vitest 3.2.6 installed and wired (vitest.config.mjs, package.json devDependencies); 10 evals.xml entries mapped 1:1 to tests/evals/eval-NN-*.test.mjs (9 real assertions passing + 1 planned it.todo for S02); each test uses real mermaid source via render.mjs or stdio MCP. `npm test` reports 47 passed (1 todo) on a fresh run.
- R007 — .github/workflows/ci.yml exists with Node 22 + 24 matrix, push + pull_request triggers on main / master / milestone/*, `npm test` on every leg, and `npm run test:coverage` + coverage artifact upload gated on Node 24. The vitest.config.mjs `coverage.thresholds.lines: 80` assertion fails the build on regression (verified by running `npm run test:coverage` against the current source — exit 0, helpers.mjs 100% / render.mjs 100% / storage.mjs 96.8%).

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

T05's summary claims a `## Test Layout (post-T05)` section was appended to S01-PLAN.md; the on-disk file does not contain that section. This is a documentation addendum, not a slice must-have — the must-haves are all met and the README Testing section does enumerate the test layout. The omission is recorded for the milestone validation step but does not block slice completion.

## Known Limitations

src/server.mjs is excluded from coverage by design (T01 step 2). The "All files" 54% in the v8 report is the table including the explicitly-excluded file; the threshold check uses only the included files (helpers/render/storage, all > 80%), so the exit-0 is correct. S04's real Claude Code + gsd-pi smoke covers the server's runtime paths end-to-end.

## Follow-ups

S02 must flip eval-09 from it.todo to a real assertion once pin_mermaid is added over stdio MCP. S03 must add a stderr JSON log fixture test that does not interfere with the unit-test silence. S04 must run MCP Inspector + the real Claude Code + gsd-pi integration smoke and capture the evidence.

## Files Created/Modified

- `package.json` — Added vitest + @vitest/coverage-v8 devDependencies; added test / test:watch / test:coverage scripts.
- `package-lock.json` — Locked the new dev dependencies and their transitive packages.
- `vitest.config.mjs` — vitest configuration with v8 coverage, 80% lines threshold, src/server.mjs excluded, 30s test timeout.
- `src/helpers.mjs` — Extracted six pure helpers (renderView, extractSvgBody, escapeHtml, fileUrlFor, httpError, log) from src/server.mjs so unit tests can import them without triggering the bootstrap (Storage + stdio MCP + sweep setInterval).
- `src/server.mjs` — Re-exports the six helpers from src/helpers.mjs via six single-name lines; the `json` HTTP helper is kept inline.
- `tests/helpers/server.mjs` — spawnServer helper: JSON-RPC driver re-implemented from scripts/smoke.sh in JS, with SIGTERM -> SIGKILL escalation in close() (MEM017).
- `tests/helpers/storage-fixture.mjs` — Per-test temp Storage factory under os.tmpdir() with mkdtemp + rm.
- `tests/helpers/render-fixture.mjs` — Render function factory and shared MALFORMED fixture (`A-->>B` per MEM016).
- `tests/unit/sanity.test.mjs` — Single sanity assertion to confirm the harness wires up.
- `tests/unit/storage.test.mjs` — Storage class unit tests: TTL, pin/unpin, sweep, pruneIfExpired, list filtering, fs error handling.
- `tests/unit/render.test.mjs` — render() unit tests: valid flowchart, gantt, oversized (>200_000 chars), malformed (MEM016).
- `tests/unit/server-helpers.test.mjs` — Unit tests for the six helpers extracted to src/helpers.mjs.
- `tests/integration/stdio-mcp.test.mjs` — Integration tests for stdio MCP: initialize, tools/list, tools/call.
- `tests/integration/http.test.mjs` — Integration test for the four HTTP routes: /health, /raw/svg, /pin, /view.
- `tests/evals/eval-01-tcp-handshake.test.mjs` — Eval 01: stdio MCP initialize handshake.
- `tests/evals/eval-02-three-flows.test.mjs` — Eval 02: three auth flows in a single render call (render layer).
- `tests/evals/eval-03-gantt.test.mjs` — Eval 03: gantt chart (render layer).
- `tests/evals/eval-04-malformed.test.mjs` — Eval 04: malformed input is rejected (render layer, MEM016).
- `tests/evals/eval-05-two-renders.test.mjs` — Eval 05: two render_mermaid calls produce two different ids (stdio MCP).
- `tests/evals/eval-06-er-diagram.test.mjs` — Eval 06: erDiagram with 5 entities and 4 relationships (stdio MCP).
- `tests/evals/eval-07-oversized.test.mjs` — Eval 07: oversized input is rejected (render layer).
- `tests/evals/eval-08-draw-anything.test.mjs` — Eval 08: default 'draw anything' architecture diagram (stdio MCP).
- `tests/evals/eval-09-pin-tool.test.mjs` — Eval 09: pin_mermaid over stdio MCP — it.todo placeholder for S02.
- `tests/evals/eval-10-file-link.test.mjs` — Eval 10: fileLink from render_mermaid starts with file:/// and points to an existing .html (stdio MCP).
- `.github/workflows/ci.yml` — GitHub Actions CI workflow: push + PR triggers, Node 22+24 matrix, coverage gate + artifact on Node 24.
- `README.md` — Added ## Testing section between Development and License.
