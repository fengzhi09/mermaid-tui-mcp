# S01: Test + CI foundation — UAT

**Milestone:** M001
**Written:** 2026-06-04T07:17:06.954Z

# S01 UAT: Test + CI foundation

**UAT Type:** Contract verification (the slice proves the v0.1.0 surface still satisfies its evals + helper contracts under an automated harness — no new runtime behavior).

**Preconditions**
- A clean clone of `mermaid-tui-mcp` at the milestone/M001 branch.
- Node 22 (or Node 24) installed; `npm` available.
- Working directory is the repo root.

**Steps**

1. **Install dependencies**
   ```bash
   npm ci
   ```
   Expected: exit 0, no errors, `node_modules/` populated with `vitest` and `@vitest/coverage-v8`.

2. **Run the test suite (no coverage)**
   ```bash
   npm test
   ```
   Expected: exit 0; vitest reports `Test Files 15 passed (1 skipped) (16) | Tests 47 passed (1 todo) (48)`. The single `it.todo` is `tests/evals/eval-09-pin-tool.test.mjs` — the planned TDD placeholder for S02's `pin_mermaid` tool. All other tests are real assertions.

3. **Run coverage and verify the threshold**
   ```bash
   npm run test:coverage
   ```
   Expected: exit 0; vitest's `coverage.thresholds.lines: 80` assertion holds. Coverage table for the three included files: `helpers.mjs` 100% lines, `render.mjs` 100% lines, `storage.mjs` 96.8% lines. `src/server.mjs` appears as 0% in the table because it is excluded per `vitest.config.mjs` (the threshold check uses only the included files).

4. **Verify parse sanity for all source modules**
   ```bash
   node --check src/server.mjs && \
   node --check src/render.mjs && \
   node --check src/storage.mjs && \
   node --check src/helpers.mjs && \
   echo PARSE_OK
   ```
   Expected: exit 0, prints `PARSE_OK`.

5. **Verify the GitHub Actions workflow is in place**
   ```bash
   ls -la .github/workflows/ci.yml
   grep -E '^name:|^on:|^jobs:|node-version:|actions/checkout|actions/setup-node|npm ci|npm test|npm run test:coverage|actions/upload-artifact|fail-fast' .github/workflows/ci.yml
   ```
   Expected: file exists (~2.1 KB), grep hits confirm `name: CI`, push + pull_request triggers, `node-version: [22, 24]` matrix, `fail-fast: false`, all 4 actions, all 3 npm steps.

6. **Verify the README Testing section**
   ```bash
   grep -n -E '^## Testing|npm test|test:coverage' README.md
   ```
   Expected: `## Testing` heading present, both `npm test` and `npm run test:coverage` mentioned in that section.

7. **Verify the 10 eval files exist 1:1 with evals.xml**
   ```bash
   ls tests/evals/ | sort
   grep -c '<entry>' evals.xml
   ```
   Expected: 10 files `eval-01-*.test.mjs` through `eval-10-*.test.mjs`; `<entry>` count in evals.xml is 10.

8. **Verify only the planned it.todo exists**
   ```bash
   grep -rE 'it\.todo|it\.skip' tests/ --include='*.mjs'
   ```
   Expected: only `tests/evals/eval-09-pin-tool.test.mjs` shows an `it.todo`; no other `it.todo` / `it.skip` / `describe.skip` anywhere in `tests/`.

**Expected Outcomes (overall)**

- `npm test` exits 0 and exercises 47 real tests across unit (34) + integration (4) + eval (9) layers.
- `npm run test:coverage` exits 0 and enforces the 80% line threshold on the included source files.
- The 9 real eval tests pass against the v0.1.0 server; the 1 `it.todo` is a documented TDD placeholder, not a regression.
- A future push to `milestone/M001` (or PR targeting `main` / `master`) will run the CI workflow on Node 22 and Node 24 in parallel; the Node 24 leg will additionally produce a coverage report, fail the build if `lines < 80`, and upload the `coverage/` directory as a `coverage-24` artifact.
- A contributor reading README will find the `## Testing` section and know to run `npm test` + `npm run test:coverage`.

**Edge Cases**

- **Node 22 vs Node 24 divergence** — both legs run `npm test`; only Node 24 runs `npm run test:coverage` and uploads the artifact. A Node-22-only runtime regression will still be caught; a coverage regression will be caught on Node 24. `fail-fast: false` means a Node 22 failure does not cancel the Node 24 leg.
- **Coverage drift below 80%** — `vitest.config.mjs` sets `coverage.thresholds.lines: 80`. Any drop on a future change will fail the build on the Node 24 leg with vitest's threshold-exceeded error.
- **Server exits not on their own** — `tests/helpers/server.mjs` close() escalates SIGTERM (150ms) → SIGKILL (1200ms) so the spawn-server tests do not hang on non-Windows runners (MEM017).
- **Stale `data/` from a previous run** — integration and eval tests use `mkdtemp` under `os.tmpdir()` with a `mermaid-int-*` or `mermaid-eval-*` prefix and `rm` on teardown, so `<repo>/data/` is never touched by tests.

**Acceptance Gate**

S01 is accepted when all 8 steps above produce the expected outcomes on a clean clone with Node 22 or Node 24. S02/S03/S04 may then proceed; they consume the vitest harness, the spawnServer helper, the per-test temp data convention, and the CI workflow template.

