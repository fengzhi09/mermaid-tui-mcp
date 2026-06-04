---
estimated_steps: 19
estimated_files: 8
skills_used: []
---

# T01: Scaffold vitest, test helpers, and refactor server.mjs to export pure helpers

Why: Every subsequent task in this slice and every downstream slice (S02, S03, S04) depends on vitest being wired up, on the test-helper modules being importable, and on src/server.mjs's pure helpers being reachable from unit tests (so coverage can include them).

Do:
1. `npm install -D vitest@^3 @vitest/coverage-v8@^3` (both pinned to ^3 to match D001). Verify vit_modules is on disk afterwards.
2. Create `vitest.config.mjs` at the repo root. Use ESM (matches package.json "type": "module"). Set:
   - `test.testTimeout: 30_000` (jsdom cold start is 2-4s per research)
   - `test.include: ['tests/**/*.test.mjs']`
   - `coverage.provider: 'v8'`
   - `coverage.reporter: ['text', 'lcov']`
   - `coverage.include: ['src/**/*.mjs']`
   - `coverage.exclude: ['src/server.mjs']` (the mainline bootstrap runs only in a child process spawned by integration tests, which vitest's coverage does not track; unit-testable helpers are covered by exporting them and importing in unit tests)
   - `coverage.thresholds.lines: 80` (D008)
3. Add to package.json scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, `"test:coverage": "vitest run --coverage"`.
4. Create `tests/helpers/server.mjs`: export a `spawnServer({env, args})` function that spawns `node src/server.mjs` as a child process with stdio piped and returns `{ child, send(method, params), close() }`. Reuse the JSON-RPC driver pattern from `scripts/smoke.sh` (the lines after the cat heredoc). Use `child_process.spawn` and read NDJSON from stdout. Do not import the driver from smoke.sh; copy the pattern into a JS module.
5. Create `tests/helpers/storage-fixture.mjs`: export `makeTempStorage()` which uses `fs/promises.mkdtemp(path.join(os.tmpdir(), 'mermaid-test-'))` to create a fresh root, instantiates `new Storage(root)`, calls `await storage.load()`, and returns `{ storage, root, cleanup() }`. Cleanup must `fs.promises.rm(root, { recursive: true, force: true })`.
6. Create `tests/helpers/render-fixture.mjs`: export constants `VALID_GRAPH` (= `"graph TD\n  A-->B"`), `VALID_GANTT` (= `"gantt\n  title A\n  dateFormat YYYY-MM-DD\n  section S\n  Task :a1, 2026-01-01, 5d"`), `MALFORMED` (= `"graph TD\n  A[Start] -->|wrong syntax here| B"`), and a function `oversizedCode(n=200_001)` returning a string of `n` chars that passes the type check.
7. Refactor `src/server.mjs`: add `export` to the top-level helper functions `renderView`, `extractSvgBody`, `escapeHtml`, `fileUrlFor`, `httpError`, `log`. Do not change behavior. The module's top-level side effects (creating storage, calling `await storage.load()`, connecting MCP transport) must remain runnable as-is.
8. Create `tests/unit/sanity.test.mjs` with one test: `expect(1 + 1).toBe(2)`.
9. Run `npm test`. Expect 1 test to pass with exit code 0. The sanity test proves vitest is wired correctly before writing real tests.

Done when: `npm test` exits 0 with the sanity test green; vitest config + helpers exist on disk; the six server.mjs helpers are exported (verifiable by `grep -c "^export" src/server.mjs` returning 6 or more).

## Inputs

- `src/server.mjs`
- `src/storage.mjs`
- `src/render.mjs`
- `scripts/smoke.sh`
- `package.json`
- `.gitignore`

## Expected Output

- `package.json`
- `package-lock.json`
- `vitest.config.mjs`
- `tests/helpers/server.mjs`
- `tests/helpers/storage-fixture.mjs`
- `tests/helpers/render-fixture.mjs`
- `tests/unit/sanity.test.mjs`
- `src/server.mjs`

## Verification

npm test
