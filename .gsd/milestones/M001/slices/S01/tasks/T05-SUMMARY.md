---
id: T05
parent: S01
milestone: M001
key_files:
  - .github/workflows/ci.yml
  - README.md
  - .gsd/milestones/M001/slices/S01/S01-PLAN.md
key_decisions:
  - Branching glob milestone/* in the on: triggers matches the project's actual branch (milestone/M001) and is generic enough for milestone/M002 etc.
  - Coverage run gated on matrix.node-version == 24 to keep a single coverage report; the threshold assertion in vitest.config.mjs is the actual gate, so duplicating the run on Node 22 would only add noise.
  - fail-fast: false on the matrix strategy so a Node 22 regression does not mask the Node 24 signal.
  - if-no-files-found: warn on the upload-artifact step is defensive — coverage/ is always written today, but a future refactor that gates the coverage run differently should not break CI on a missing artifact.
  - README Testing section placed between Development and License (the plan said "near Usage / Configuration", which don't exist in this README) so the contributor flow reads naturally: run it → verify it → legal.
  - Test Layout in S01-PLAN.md is a new section appended at the end, not interleaved with Must-Haves/Tasks/Files Likely Touched; the completion contract forbids editing PLAN.md checkboxes, so the section is added as a documentation addendum and the T05 checkbox is left to the completion tool.
duration: 
verification_result: passed
completed_at: 2026-06-04T07:11:15.276Z
blocker_discovered: false
---

# T05: Wired .github/workflows/ci.yml (Node 22+24 matrix with coverage gate + artifact on Node 24), added README "Testing" section, documented the tests/ layout in S01-PLAN.md, and confirmed parse-sanity + coverage threshold still pass.

**Wired .github/workflows/ci.yml (Node 22+24 matrix with coverage gate + artifact on Node 24), added README "Testing" section, documented the tests/ layout in S01-PLAN.md, and confirmed parse-sanity + coverage threshold still pass.**

## What Happened

## What Happened

Closed the S01/T05 gap: the test + CI foundation now has a working GitHub Actions workflow and a contributor-facing Testing section in the README, and the test layout is documented inside S01-PLAN.md so a future maintainer can see at a glance which file under `tests/` covers which surface.

### Files created

1. **`.github/workflows/ci.yml`** (66 lines, 2.1 KB) — the standard M001 CI layout per the plan:
   - `name: CI`
   - `on.push` + `on.pull_request` for `main`, `master`, and `milestone/*` (the repo's branching convention — current branch is `milestone/M001`, confirmed via `git branch`).
   - `jobs.test.runs-on: ubuntu-latest`, `strategy.matrix.node-version: [22, 24]`, `fail-fast: false` so a Node 22 regression does not mask the Node 24 signal.
   - Steps: `actions/checkout@v4` → `actions/setup-node@v4` (with `cache: 'npm'`) → `npm ci` → `npm test` → `npm run test:coverage` (gated on `matrix.node-version == 24`, where the `coverage.thresholds.lines: 80` assertion in `vitest.config.mjs` fails the build) → `actions/upload-artifact@v4` with `name: coverage-${{ matrix.node-version }}` and `path: coverage/`, also gated on Node 24. The artifact step carries `if-no-files-found: warn` defensively.

### Files modified

2. **`README.md`** — added a `## Testing` section between `## Development` and `## License` (the natural contributor-flow ordering). It includes the requested short description (`Run the test suite with npm test. Get a coverage report with npm run test:coverage (target: ≥80% lines, enforced by vitest.config.mjs).`) plus one bullet each for unit tests, integration tests, eval tests, and CI. The CI bullet explicitly names `.github/workflows/ci.yml`, the Node 22 + 24 matrix, and the coverage-threshold + artifact gate.

3. **`.gsd/milestones/M001/slices/S01/S01-PLAN.md`** — added a new `## Test Layout (post-T05)` section at the end (after `## Files Likely Touched`). The section is a documentation addendum that does not touch any checkboxes; the completion tool's checkbox toggle is left to itself. It enumerates every file under `tests/` (15 test files + 3 helpers + `vitest.config.mjs` + `.github/workflows/ci.yml` + the README Testing section) with a one-line description of what each covers, and ends with the coverage breakdown on the Node 24 leg: `helpers.mjs` 100% lines, `render.mjs` 100% lines, `storage.mjs` 96.8% lines, `src/server.mjs` excluded per `vitest.config.mjs` for the documented reason.

### Decisions

- **Coverage run on Node 24 only** — per the plan, the threshold assertion is the gate, so running coverage on both legs would produce two near-identical reports and double the artifact count without adding signal. The Node 22 leg keeps `npm test` (no coverage) so a Node-22-specific runtime regression still gets caught.
- **`fail-fast: false`** in the matrix strategy — a Node 22 failure should not cancel the Node 24 leg; the maintainer wants to see both signals.
- **`if-no-files-found: warn`** on the upload-artifact step — defensive. In the current setup `coverage/` is always written (the threshold-check step runs first), but a future refactor that gates `test:coverage` differently should not fail CI on a missing artifact.
- **README placement** — Testing goes between Development and License so the contributor flow reads naturally: "here's how to run it" (Development) → "here's how to verify it" (Testing) → "here's the legal stuff" (License). The plan said "near Usage / Configuration"; this README has no Usage/Configuration section (those were guides for the LLM, not the project), so Development is the natural neighbor.
- **S01-PLAN.md placement** — Test Layout is a new section appended at the end, not interleaved with the existing Must-Haves / Tasks / Files Likely Touched blocks. The completion contract forbids editing PLAN.md checkboxes, so the section is added as a documentation addendum; the T05 checkbox is left to the completion tool to toggle.

### Final verification

- `node --check src/server.mjs && node --check src/render.mjs && node --check src/storage.mjs && node --check src/helpers.mjs && echo PARSE_OK` — exit 0 (all 4 files parse).
- `npm test` — exit 0; **15 test files passed (1 skipped), 47 tests passed (1 todo)**, ~11 s. The single `it.todo` is the planned S02 placeholder in `eval-09`.
- `npm run test:coverage` — exit 0; threshold `lines: 80` met. Coverage table: `helpers.mjs` 100% / `render.mjs` 100% / `storage.mjs` 96.8%; `src/server.mjs` excluded per `vitest.config.mjs` (the "All files" 54% in the v8 report is the table including the explicitly-excluded file — the threshold check uses only the included files, which is why exit is 0). Coverage is stable across reruns.
- CI YAML structure check (all 18 expected fields present): name CI, push + pull_request triggers, main/master/milestone/* branches, ubuntu-latest runner, `[22, 24]` matrix, `actions/checkout@v4`, `actions/setup-node@v4`, `cache: 'npm'`, `npm ci`, `npm test`, `npm run test:coverage`, `matrix.node-version == 24` gate, `actions/upload-artifact@v4`, `coverage/` path, `coverage-${{ matrix.node-version }}` artifact name — all ✓.
- README structural check: `## Testing` heading present, `npm test` mentioned, `npm run test:coverage` mentioned, bullets for Unit / Integration / Eval / CI present.
- S01-PLAN.md structural check: `## Test Layout (post-T05)` heading present, every test file path under `tests/` documented.

### Done-when criteria (from T05-PLAN.md)

- ✅ `.github/workflows/ci.yml` exists on disk (2155 bytes).
- ✅ `npm test` exits 0 (47 tests pass, 1 todo as planned).
- ✅ `npm run test:coverage` exits 0 with `lines ≥ 80%` threshold met.
- ✅ `node --check` passes for `src/server.mjs`, `src/render.mjs`, `src/storage.mjs` (and the T02-extracted `src/helpers.mjs`).
- ✅ `README.md` has a `## Testing` section that mentions both `npm test` and `npm run test:coverage`.
- ✅ S01-PLAN.md has a `## Test Layout (post-T05)` section documenting the `tests/` tree.

Slice S01 is now ready to close.

## Verification

All five T05 done-when criteria pass: (1) `.github/workflows/ci.yml` exists at 2155 bytes with the planned Node 22+24 matrix, push+PR triggers on main/master/milestone/*, `npm test` on every leg, and `npm run test:coverage` + `coverage/` artifact upload gated on Node 24. (2) `npm test` exits 0 with 15 test files passed (1 skipped = eval-09 it.todo), 47 tests passed (1 todo), ~11 s. (3) `npm run test:coverage` exits 0 with the `lines: 80` threshold met (helpers.mjs 100%, render.mjs 100%, storage.mjs 96.8%; server.mjs excluded per vitest.config.mjs as designed). (4) `node --check src/server.mjs && node --check src/render.mjs && node --check src/storage.mjs && node --check src/helpers.mjs` exits 0 (all four source modules parse). (5) README.md has a `## Testing` section at line 126 that mentions both `npm test` (line 128) and `npm run test:coverage` (line 128) and includes the four bullets (unit, integration, eval, CI). (6) S01-PLAN.md has a `## Test Layout (post-T05)` section at line 89 documenting all 19 test .mjs files plus vitest.config.mjs, .github/workflows/ci.yml, and the README Testing section.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node --check src/server.mjs && node --check src/render.mjs && node --check src/storage.mjs && node --check src/helpers.mjs && echo PARSE_OK` | 0 | pass — all 4 source modules parse clean | 280ms |
| 2 | `ls -la .github/workflows/ci.yml` | 0 | pass — CI workflow exists, 2155 bytes | 40ms |
| 3 | `node -e structural check of all 18 required CI YAML fields (name CI, push, pull_request, main, master, milestone/*, ubuntu-latest, [22,24] matrix, actions/checkout@v4, actions/setup-node@v4, cache:'npm', npm ci, npm test, npm run test:coverage, matrix.node-version==24 gate, actions/upload-artifact@v4, coverage/ path, coverage-${{ matrix.node-version }} artifact name)` | 0 | pass — all 18 required CI fields present | 120ms |
| 4 | `grep -n '## Testing\|npm test\|test:coverage' README.md` | 0 | pass — Testing section at line 126, npm test + test:coverage at line 128, CI bullet at line 135 | 30ms |
| 5 | `grep -n '## Test Layout' .gsd/milestones/M001/slices/S01/S01-PLAN.md` | 0 | pass — Test Layout section at line 89, no checkboxes touched | 20ms |
| 6 | `npm test` | 0 | pass — 15 test files passed (1 skipped), 47 tests passed (1 todo) | 11730ms |
| 7 | `npm run test:coverage` | 0 | pass — lines:80 threshold met; helpers.mjs 100%, render.mjs 100%, storage.mjs 96.8%; server.mjs excluded per vitest.config.mjs | 8050ms |
| 8 | `find tests -type f -name '*.mjs' | sort | wc -l` | 0 | pass — 19 test .mjs files on disk (4 unit + 2 integration + 10 evals + 3 helpers), matches the plan | 50ms |
| 9 | `grep -rE '(it\.todo|it\.skip|describe\.skip|describe\.todo)' tests/ --include='*.mjs' | grep -vE '://|replace this it\.todo'` | 0 | pass — only the planned eval-09-pin-tool.test.mjs it.todo remains; the other 9 evals are real assertions | 60ms |

## Deviations

None. The T05 plan was followed as written: the CI YAML uses the standard layout, the README Testing section has the requested description + four bullets, the test layout is documented in S01-PLAN.md as a new section (no checkbox edits), and the parse-sanity + coverage verification commands both pass. The only minor local adaptation is the README placement (between Development and License) because the plan referenced "Usage / Configuration" sections that don't exist in this README — Development is the natural neighbor for a contributor-facing Testing section.

## Known Issues

None. The "All files" 54% in the v8 coverage report is the table including the explicitly-excluded `src/server.mjs`; vitest's threshold check uses only the included files (helpers/render/storage, all well above 80%), so the exit-0 is correct. This is already documented in the vitest.config.mjs comment.

## Files Created/Modified

- `.github/workflows/ci.yml`
- `README.md`
- `.gsd/milestones/M001/slices/S01/S01-PLAN.md`
