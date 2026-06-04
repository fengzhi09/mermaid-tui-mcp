---
estimated_steps: 20
estimated_files: 3
skills_used: []
---

# T05: GitHub Actions CI workflow + README + final coverage + parse sanity

Why: R007 requires a GitHub Actions workflow that runs tests on Node 22 and Node 24 on push and pull_request, with the ≥80% coverage threshold enforced. R006 calls for npm test to be the documented entry point for contributors.

Do:
1. Create `.github/workflows/ci.yml`. Use the standard layout:
   - `name: CI`
   - `on: { push: { branches: [main, master, milestone/*] }, pull_request: { branches: [main, master, milestone/*] } }` — match the project's branching convention (the repo is on `milestone/M001`).
   - `jobs.test`: `runs-on: ubuntu-latest`, `strategy.matrix.node-version: [22, 24]`, steps:
     - `actions/checkout@v4`
     - `actions/setup-node@v4` with `node-version: ${{ matrix.node-version }}` and `cache: 'npm'`
     - `run: npm ci`
     - `run: npm test` (vitest run, no coverage here — the threshold check is in a separate step that runs only on the primary node version to avoid duplicating coverage output)
     - `run: npm run test:coverage` (only on `matrix.node-version == 24` to keep one coverage report; the threshold assertion in vitest.config.mjs is what fails the build if coverage drops)
     - `actions/upload-artifact@v4` with `name: coverage-${{ matrix.node-version }}`, `path: coverage/`, `if: matrix.node-version == 24`
2. Add a "Testing" section to README.md (insert near the existing "Usage" / "Configuration" sections). Include:
   - A short description: "Run the test suite with `npm test`. Get a coverage report with `npm run test:coverage` (target: ≥80% lines)."
   - One bullet each for: unit tests, integration tests, eval tests, CI.
3. Run final verification commands:
   - `node --check src/server.mjs && node --check src/render.mjs && node --check src/storage.mjs` — basic parse sanity.
   - `npm run test:coverage` — must exit 0 with `lines ≥ 80%`. If it is below 80%, add the missing test cases to T02 and re-run.
4. Document the test layout in S01-PLAN.md: which files exist under tests/ and what each covers.

Done when: `.github/workflows/ci.yml` exists on disk; `npm test` exits 0; `npm run test:coverage` exits 0 with `lines ≥ 80%`; `node --check` passes for all three src/*.mjs files; README.md has a "Testing" section mentioning `npm test` and `npm run test:coverage`.

## Inputs

- `package.json`
- `vitest.config.mjs`
- `src/server.mjs`
- `src/render.mjs`
- `src/storage.mjs`
- `README.md`
- `tests/helpers/server.mjs`
- `tests/helpers/storage-fixture.mjs`
- `tests/helpers/render-fixture.mjs`
- `tests/unit/storage.test.mjs`
- `tests/unit/render.test.mjs`
- `tests/unit/server-helpers.test.mjs`
- `tests/integration/stdio-mcp.test.mjs`
- `tests/integration/http.test.mjs`
- `tests/evals/eval-01-tcp-handshake.test.mjs`
- `tests/evals/eval-02-three-flows.test.mjs`
- `tests/evals/eval-03-gantt.test.mjs`
- `tests/evals/eval-04-malformed.test.mjs`
- `tests/evals/eval-05-two-renders.test.mjs`
- `tests/evals/eval-06-er-diagram.test.mjs`
- `tests/evals/eval-07-oversized.test.mjs`
- `tests/evals/eval-08-draw-anything.test.mjs`
- `tests/evals/eval-09-pin-tool.test.mjs`
- `tests/evals/eval-10-file-link.test.mjs`

## Expected Output

- `.github/workflows/ci.yml`
- `README.md`

## Verification

npm run test:coverage
