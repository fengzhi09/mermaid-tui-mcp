# S01: Test + CI foundation

**Goal:** Establish the test + CI foundation for M001: vitest as the test framework, 10 evals.xml entries converted to executable vitest tests, unit + integration tests for src/{storage,render,server}.mjs, and a GitHub Actions workflow on Node 22 + 24 enforcing the ≥80% line coverage threshold. All other M001 slices (S02/S03/S04) depend on this baseline.
**Demo:** npm test 跑通 10 evals 与单元测试;GitHub Actions Node 22+24 全绿;覆盖率报告 ≥ 80% 且 CI 门槛通过

## Must-Haves

- `npm test` exits 0 with all unit, integration, and eval tests passing except eval 9 (which is `it.todo` until S02 adds the pin tool).
- `npm run test:coverage` exits 0 and reports `lines ≥ 80%` on `src/**/*.mjs` (with `src/server.mjs` excluded from coverage as documented in T01 step 2).
- `.github/workflows/ci.yml` exists with Node 22 + 24 matrix, PR + push triggers, and `npm ci && npm test` followed by `npm run test:coverage` for the threshold assertion.
- All 10 entries in `evals.xml` correspond 1:1 to a `tests/evals/eval-NN-*.test.mjs` file. Eval 9 is `it.todo` (TDD-style placeholder); the other 9 are real assertions that pass against v0.1.0.
- Test helpers at `tests/helpers/{server,storage-fixture,render-fixture}.mjs` are importable from the other test files (verified by the integration and eval tests passing).
- `node --check src/server.mjs && node --check src/render.mjs && node --check src/storage.mjs` exits 0 (basic parse sanity).
- README.md mentions `npm test` and `npm run test:coverage`.

## Proof Level

- This slice proves: contract — locks the v0.1.0 surface (render, storage, stdio MCP, HTTP routes, helpers) under vitest on Node 22 + 24 with a coverage floor. New runtime behavior is not introduced; the proof is that the existing surface still satisfies its evals + helper contracts under an automated harness.

## Integration Closure

Upstream surfaces consumed: src/server.mjs (spawned as child + helpers imported), src/storage.mjs (imported by unit + integration tests), src/render.mjs (imported by unit + eval tests), public/view.html (substituted by renderView in server-helpers unit test), evals.xml (source of truth for eval test contracts), scripts/smoke.sh (JSON-RPC driver pattern reused in tests/helpers/server.mjs).

New wiring introduced: vitest 3.x dev dependency, @vitest/coverage-v8 dev dependency, vitest.config.mjs with 80% lines threshold, npm scripts test/test:watch/test:coverage, .github/workflows/ci.yml with Node 22+24 matrix, test-helper module trio at tests/helpers/, 10 eval test files, unit + integration test trees, export of pure helpers from src/server.mjs (and possibly a new src/helpers.mjs if the mainline bootstrap proves un-importable in unit tests).

What remains before M001 is end-to-end usable: S02 must add 6 more MCP tools (pin/unpin/list/get/delete/search) and flip the eval-09 test from `it.todo` to a real assertion; S03 must add stderr-JSON logging + /health metrics + counters + retry/timeout; S04 must run the real Claude Code + gsd-pi integration smoke. S01 alone proves the test + CI foundation works against the v0.1.0 surface.

## Verification

- Run the task and slice verification checks for this slice.

## Tasks

- [x] **T01: Scaffold vitest, test helpers, and refactor server.mjs to export pure helpers** `est:45m`
  Why: Every subsequent task in this slice and every downstream slice (S02, S03, S04) depends on vitest being wired up, on the test-helper modules being importable, and on src/server.mjs's pure helpers being reachable from unit tests (so coverage can include them).
  - Files: `package.json`, `package-lock.json`, `vitest.config.mjs`, `tests/helpers/server.mjs`, `tests/helpers/storage-fixture.mjs`, `tests/helpers/render-fixture.mjs`, `tests/unit/sanity.test.mjs`, `src/server.mjs`
  - Verify: npm test

- [x] **T02: Unit tests for storage, render, and server helpers** `est:60m`
  Why: Highest coverage win. Locks the existing v0.1.0 surface (storage, render, server helpers) so S02 and S03 can extend it without breaking it. Pure modules + already-exported helpers (per T01) are unit-testable without spawning the server.
  - Files: `tests/unit/storage.test.mjs`, `tests/unit/render.test.mjs`, `tests/unit/server-helpers.test.mjs`, `src/helpers.mjs`
  - Verify: npm test

- [x] **T03: Integration tests for stdio MCP and HTTP routes** `est:45m`
  Why: Spawns the real server as a child process; drives JSON-RPC over stdio; hits the HTTP routes with Node's built-in fetch. Locks the server's externally visible behavior so the v0.1.0 surface stays green under vitest.
  - Files: `tests/integration/stdio-mcp.test.mjs`, `tests/integration/http.test.mjs`
  - Verify: npm test

- [x] **T04: Convert 10 evals.xml entries to vitest tests** `est:60m`
  Why: R006 requires all 10 evals.xml entries to become executable vitest tests. Each entry's <expected> block is a contract; the test asserts on the contract. Eval 9 (pin via stdio) is intentionally a `it.todo` because the v0.1.0 server does not expose `pin_mermaid` over stdio — S02 will replace the todo with a real assertion.
  - Files: `tests/evals/eval-01-tcp-handshake.test.mjs`, `tests/evals/eval-02-three-flows.test.mjs`, `tests/evals/eval-03-gantt.test.mjs`, `tests/evals/eval-04-malformed.test.mjs`, `tests/evals/eval-05-two-renders.test.mjs`, `tests/evals/eval-06-er-diagram.test.mjs`, `tests/evals/eval-07-oversized.test.mjs`, `tests/evals/eval-08-draw-anything.test.mjs`, `tests/evals/eval-09-pin-tool.test.mjs`, `tests/evals/eval-10-file-link.test.mjs`
  - Verify: npm test

- [x] **T05: GitHub Actions CI workflow + README + final coverage + parse sanity** `est:30m`
  Why: R007 requires a GitHub Actions workflow that runs tests on Node 22 and Node 24 on push and pull_request, with the ≥80% coverage threshold enforced. R006 calls for npm test to be the documented entry point for contributors.
  - Files: `.github/workflows/ci.yml`, `README.md`, `.gsd/milestones/M001/slices/S01/S01-PLAN.md`
  - Verify: npm run test:coverage

## Files Likely Touched

- package.json
- package-lock.json
- vitest.config.mjs
- tests/helpers/server.mjs
- tests/helpers/storage-fixture.mjs
- tests/helpers/render-fixture.mjs
- tests/unit/sanity.test.mjs
- src/server.mjs
- tests/unit/storage.test.mjs
- tests/unit/render.test.mjs
- tests/unit/server-helpers.test.mjs
- src/helpers.mjs
- tests/integration/stdio-mcp.test.mjs
- tests/integration/http.test.mjs
- tests/evals/eval-01-tcp-handshake.test.mjs
- tests/evals/eval-02-three-flows.test.mjs
- tests/evals/eval-03-gantt.test.mjs
- tests/evals/eval-04-malformed.test.mjs
- tests/evals/eval-05-two-renders.test.mjs
- tests/evals/eval-06-er-diagram.test.mjs
- tests/evals/eval-07-oversized.test.mjs
- tests/evals/eval-08-draw-anything.test.mjs
- tests/evals/eval-09-pin-tool.test.mjs
- tests/evals/eval-10-file-link.test.mjs
- .github/workflows/ci.yml
- README.md
- .gsd/milestones/M001/slices/S01/S01-PLAN.md
