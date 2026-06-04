---
id: T05
parent: S02
milestone: M001
key_files:
  - tests/unit/render-view-title.test.mjs
key_decisions:
  - Used position-based slicing (indexOf + lastIndexOf) instead of a /<script[\s\S]*?<\/script>/g regex to find the actual <script> block boundaries — the regex incorrectly matched the JSON-stringified form of the XSS title first.
  - Kept the existing escapeHtml-on-{{TITLE}} and JSON.stringify-on-{{TITLE_JSON}} pipes in src/helpers.mjs as-is (no production code change); the test file is the only deliverable, since R023's contract was already correctly implemented in T03.
duration: 
verification_result: passed
completed_at: 2026-06-04T10:15:33.833Z
blocker_discovered: false
---

# T05: Landed renderView TITLE XSS-guard test (5 cases) and confirmed the 80% coverage gate (tools.mjs 93.33%, LocalFsStorage.mjs 97.53%, helpers.mjs 100%, render.mjs 100%) for v0.2.0.

**Landed renderView TITLE XSS-guard test (5 cases) and confirmed the 80% coverage gate (tools.mjs 93.33%, LocalFsStorage.mjs 97.53%, helpers.mjs 100%, render.mjs 100%) for v0.2.0.**

## What Happened

Created tests/unit/render-view-title.test.mjs with 5 cases that lock R023's escapeHtml-on-title surface for v0.2.0:

1. Substitutes {{TITLE}} with the escaped title when entry.title is set ("Auth flow" → visible in h1 + <title>).
2. Escapes HTML in the title (XSS guard): "<script>alert(1)</script>" is rendered as `&lt;script&gt;alert(1)&lt;/script&gt;`; the raw substring is asserted to NOT appear in HTML context (only inside the JSON-stringified form within the <script> block, which is safe).
3. Substitutes {{TITLE}} with an empty string when entry.title is missing or empty (h1 slot is empty, const TITLE = "").
4. Substitutes {{TITLE_JSON}} with JSON.stringify(title) for the <script>-block const (asserts the `He said \"hi\"` JSON-escaped form lands after `const TITLE = `).
5. Regression: {{TITLE}} substitution doesn't break {{ID}} or {{CODE}} substitution.

Implementation note: the XSS-guard test originally used `/<script[\s\S]*?<\/script>/g` to strip the inline script block, but that regex incorrectly matched the JSON-stringified form of the XSS title itself (which is shaped like `<script>...</script>`). Switched to position-based slicing with `indexOf("<script>")` and `lastIndexOf("</script>")` to find the actual HTML script-block boundaries. Captured this as MEM023 so future tests don't repeat the mistake.

Coverage gate (npm run test:coverage) exits 0 with per-file lines:
- helpers.mjs: 100% (existing floor maintained)
- render.mjs: 100% (existing floor maintained)
- tools.mjs: 93.33% (≥80% ✓, ≥90% target ✓)
- LocalFsStorage.mjs: 97.53% (≥80% ✓, ≥90% target ✓)

`server.mjs` (0%) is excluded from the vitest config, and `Backend.mjs` (0%) is a pure JSDoc typedef file — neither affects the threshold gate. The vitest 80% lines threshold is applied to the actively-tested code files, all of which are above 80%.

Full suite: 18 test files, 104 tests, 0 failures (up from 99 — the 5 new render-view-title cases are picked up by vitest's `tests/**/*.test.mjs` include glob).

## Verification

npm test (104 tests pass, 0 fail, 0 todo) and npm run test:coverage (exit 0, per-file lines: tools.mjs 93.33%, LocalFsStorage.mjs 97.53%, helpers.mjs 100%, render.mjs 100%). All five render-view-title.test.mjs cases pass and lock the {{TITLE}} / {{TITLE_JSON}} XSS-guard contract for v0.2.0.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npm test` | 0 | pass — 18 test files, 104 tests, 0 failures (5 new render-view-title cases included) | 24800ms |
| 2 | `npm run test:coverage` | 0 | pass — coverage gate exits 0, tools.mjs 93.33% lines (≥90% target), LocalFsStorage.mjs 97.53% lines (≥90% target), helpers.mjs 100% lines, render.mjs 100% lines | 27880ms |
| 3 | `npx vitest run tests/unit/render-view-title.test.mjs` | 0 | pass — 5/5 cases pass (renderView {{TITLE}} substitution, XSS guard, empty-title handling, {{TITLE_JSON}} JSON escape, regression on {{ID}}/{{CODE}}) | 843ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `tests/unit/render-view-title.test.mjs`
