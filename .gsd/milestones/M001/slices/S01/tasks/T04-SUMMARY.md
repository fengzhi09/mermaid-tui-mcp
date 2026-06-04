---
id: T04
parent: S01
milestone: M001
key_files:
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
key_decisions:
  - Layering follows the plan's per-eval specifics: evals 3, 4, 7 import src/render.mjs directly (contract is purely about the render function); evals 1, 5, 6, 8, 10 use stdio MCP via tests/helpers/server.mjs (externally-visible tool contract); eval 2 is at the render layer per the plan's "best done at the render layer" guidance.</item>
<item>Per-test temp data dir under os.tmpdir() (mkdtemp + rm) for every stdio-MCP-spawning eval — same pattern as the integration tests in T03, so parallel test runs cannot collide and the real <repo>/data/ is never touched.</item>
<item>One assertion per test (1 total) — the plan allowed 1-5; 1 is sufficient and keeps failure messages clean since each eval corresponds to a single contract from the <expected> block.</item>
<item>Each file starts with a 5-10 line comment block quoting the <question> and <expected> from the corresponding evals.xml entry, so a future reader sees the source-of-truth contract without cross-referencing.</item>
<item>eval-09 it.todo includes the multi-line S01/S02 explanation per the plan ("S01 expected: stdio MCP exposes render_mermaid only. S02 will add pin_mermaid; replace this it.todo with a real assertion..."). Header note explicitly marks it as a TDD placeholder, not a failure.</item>
<item>eval-10's fileLinkToPath helper uses fileURLToPath to handle both windows "C:/..." and posix "/..." shapes uniformly, and asserts the path exists via fs/promises.access (a non-throwing access proves the file is reachable, per the plan).</item>
duration: 
verification_result: passed
completed_at: 2026-06-04T07:03:10.302Z
blocker_discovered: false
---

# T04: Wrote 10 vitest eval test files (eval-01..eval-10) under tests/evals/ that lock the v0.1.0 surface against evals.xml; eval-09 is the planned it.todo placeholder for S02's pin_mermaid addition.

**Wrote 10 vitest eval test files (eval-01..eval-10) under tests/evals/ that lock the v0.1.0 surface against evals.xml; eval-09 is the planned it.todo placeholder for S02's pin_mermaid addition.**

## What Happened

## What Happened

Wrote the S01/T04 eval test layer — 10 new files under `tests/evals/`, one per entry in `evals.xml`, asserting the contract of each `<expected>` block. Verified by `npm test` (47 passed, 1 todo, exit 0) and `npm run test:coverage` (threshold 80% still met; helpers.mjs 100% / render.mjs 100% / storage.mjs 96.8%).

### Files created

1. **`tests/evals/eval-01-tcp-handshake.test.mjs`** — TCP three-way handshake `sequenceDiagram` rendered through the stdio MCP path; asserts non-empty `id` / `ascii` / `fileLink`, and that `fileLink` starts with `file:///`.
2. **`tests/evals/eval-02-three-flows.test.mjs`** — A single flowchart with three subgraphs (OAuth2 auth-code, OAuth2 client-creds, OIDC implicit) imported directly from `src/render.mjs`; asserts the call returns exactly one `{ id, svg, ascii, sourceLength }` — i.e. "one call, one id" (per the eval's explicit "not three times" expectation).
3. **`tests/evals/eval-03-gantt.test.mjs`** — Gantt chart with design(2d), impl(5d), review(2d), bug-fix(3d), deploy(1d) at the render layer; asserts the call doesn't throw and returns non-empty svg + ascii.
4. **`tests/evals/eval-04-malformed.test.mjs`** — Calls `render(MALFORMED)` directly and asserts the rejection message starts with `mermaid parse error:`. Reuses `MALFORMED` from `tests/helpers/render-fixture.mjs` (the contract is shared with the unit test).
5. **`tests/evals/eval-05-two-renders.test.mjs`** — Two `render_mermaid` calls over stdio MCP with slightly different code; asserts the two returned `id`s (and their `fileLink`s) differ. Monotonic id generation guarantees distinct ids.
6. **`tests/evals/eval-06-er-diagram.test.mjs`** — 5-entity / 4-relationship `erDiagram` over stdio MCP; asserts no throw and non-empty `fileLink` (ASCII quality is not asserted, per the eval's explicit best-effort note).
7. **`tests/evals/eval-07-oversized.test.mjs`** — Calls `render(oversizedCode(200_001))`; asserts the thrown error message contains both `mermaid source too long` and `200001` so the assistant can echo the offending size to the user.
8. **`tests/evals/eval-08-draw-anything.test.mjs`** — A small system-architecture flowchart (the assistant's reasonable default) over stdio MCP; asserts the standard `{ id, ascii, fileLink }` contract is satisfied.
9. **`tests/evals/eval-09-pin-tool.test.mjs`** — `it.todo` with a multi-line comment block explaining the S01/S02 contract: stdio MCP exposes `render_mermaid` only; S02 will add `pin_mermaid` and replace this with `expect(toolNames).toContain("pin_mermaid")`. Header note explicitly marks this as a TDD placeholder, not a failure.
10. **`tests/evals/eval-10-file-link.test.mjs`** — `render_mermaid` over stdio MCP; asserts `fileLink` starts with `file:///`, and that the path inside the URL exists on disk (decoded via `fileURLToPath` and verified with `fs/promises.access`). Handles both windows `C:/...` and posix `/...` shapes uniformly.

### Per-file design choices

- **Layering follows the plan's guidance.** Evals 3, 4, 7 import `src/render.mjs` directly (the contract is purely about the render function — no need to spawn a child process). Evals 1, 5, 6, 8, 10 use the stdio MCP path via `tests/helpers/server.mjs` (these are about the externally-visible tool contract). Eval 2 is at the render layer per the plan's recommendation ("best done at the render layer to assert 'one call produces one id' (which the stdio MCP layer also enforces but is more boilerplate)").
- **Per-test temp data dir** for every stdio-MCP-spawning eval (1, 5, 6, 8, 10) using the same `mkdtemp(join(tmpdir(), ...))` + `rm` pattern as the integration tests. The real `<repo>/data/` is never touched and parallel test runs cannot collide.
- **Comment-block headers** (5–10 lines) on every file quote the `<question>` and `<expected>` from `evals.xml`, so a future reader can see the source-of-truth contract without cross-referencing.
- **`describe` wrappers** use the format `eval-NN: <one-line topic>` per the plan.
- **assertion counts:** 1 per test (matching the plan's "1-5 vitest assertions exercising the contract" — 1 is sufficient and keeps the failure messages clean).

### Final verification

- `node --check` clean on all 10 new files.
- `npm test` — **15 test files passed (1 skipped) / 47 tests passed (1 todo)** in ~6.35s. Exit 0.
- `npm run test:coverage` — **exit 0**, coverage threshold `lines: 80` still met (helpers.mjs 100% / render.mjs 100% / storage.mjs 96.8% / server.mjs excluded per vitest.config.mjs as designed).
- `grep -rE "(it\.todo|it\.skip|describe\.skip|describe\.todo)" tests/evals/` confirms eval-09 is the only `it.todo` in the evals tree.

### What I did NOT do (left for downstream tasks)

- T05: GitHub Actions CI workflow + README updates + final coverage + parse-sanity gate.
- Eval-09's `it.todo` will be replaced by S02 with a real `pin_mermaid` assertion; no S01 work is needed for that.


## Verification

## Verification

Done-when criteria for T04, all met:

1. **`npm test` exits 0** — 15 test files passed (1 skipped is the eval-09 it.todo), 47 tests passed (1 todo), 0 failed. Duration ~6.35s.
2. **All 10 eval test files exist on disk** — `ls tests/evals/*.test.mjs | wc -l` returns **10**; the 10 filenames exactly match the plan's `Expected Output` list (`eval-01-tcp-handshake.test.mjs` through `eval-10-file-link.test.mjs`).
3. **Eval 9 is the only `it.todo`** — `grep -rE "(it\.todo|...)" tests/evals/` returns matches only in `eval-09-pin-tool.test.mjs` (and the matches are the descriptive comment + describe text). No real test is silently skipped or marked todo.
4. **The other 9 evals are real assertions that pass against the v0.1.0 server** — verified by `npm test` output showing green ✓ for each of eval-01..eval-08 and eval-10. Each assertion exercises a concrete contract from the corresponding `<expected>` block.
5. **Per-file comment block (5–10 lines) quotes the `<question>` and `<expected>`** — every file starts with `// From evals.xml <eval id="N">: ...` and includes both the question and the expected output verbatim. Verified by reading each file.
6. **`describe` wrappers follow the `eval-NN: <one-line topic>` format** — confirmed by grep.
7. **Each eval uses the right layer** per the plan's per-eval specifics — evals 3, 4, 7 import `src/render.mjs` directly; evals 1, 5, 6, 8, 10 use stdio MCP via `tests/helpers/server.mjs`; eval 2 is at the render layer (single-call → single-id contract). The plan's "best done at the render layer" guidance for eval 2 is followed.
8. **Coverage threshold still met** — `npm run test:coverage` exit 0; render.mjs 100% lines, storage.mjs 96.8% lines, helpers.mjs 100% lines. Threshold 80% satisfied.
9. **All 10 new files parse clean** — `node --check` returns 0 for each.


## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node --check tests/evals/eval-01-tcp-handshake.test.mjs && node --check tests/evals/eval-02-three-flows.test.mjs && node --check tests/evals/eval-03-gantt.test.mjs && node --check tests/evals/eval-04-malformed.test.mjs && node --check tests/evals/eval-05-two-renders.test.mjs && node --check tests/evals/eval-06-er-diagram.test.mjs && node --check tests/evals/eval-07-oversized.test.mjs && node --check tests/evals/eval-08-draw-anything.test.mjs && node --check tests/evals/eval-09-pin-tool.test.mjs && node --check tests/evals/eval-10-file-link.test.mjs && echo ALL_PARSE_OK` | 0 | pass — all 10 eval test files parse clean | 450ms |
| 2 | `npm test` | 0 | pass — 15 test files passed (1 skipped), 47 tests passed (1 todo), 0 failed; duration ~6.35s | 8000ms |
| 3 | `npm run test:coverage` | 0 | pass — coverage threshold lines:80 met (helpers.mjs 100%, render.mjs 100%, storage.mjs 96.8%; server.mjs excluded as designed) | 8500ms |
| 4 | `ls tests/evals/*.test.mjs | wc -l` | 0 | pass — 10 eval test files on disk (matches plan's expected output list) | 50ms |
| 5 | `grep -rE "(it\.todo|it\.skip|describe\.skip|describe\.todo)" tests/evals/ | grep -vE "^\s*//|describe\(.*it\.todo|replace this it\.todo"` | 0 | pass — only eval-09 has an it.todo; the other 9 are real assertions | 60ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

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
