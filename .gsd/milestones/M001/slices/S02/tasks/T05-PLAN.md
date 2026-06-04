---
estimated_steps: 12
estimated_files: 1
skills_used: []
---

# T05: renderView TITLE XSS-guard test + final coverage gate

Why: R023 requires escapeHtml on the displayed title. The render-view-title unit test locks the XSS surface for v0.2.0. The final coverage gate proves the new modules (tools.mjs, LocalFsStorage.mjs) maintain the 80% lines floor under vitest's v8 coverage.

Do:
1. Create tests/unit/render-view-title.test.mjs (new). Cases:
   - substitutes {{TITLE}} with the escaped title when entry.title is set: renderView with entry.title = "Auth flow", assert the HTML contains "Auth flow" and the raw {{TITLE}} placeholder is gone.
   - escapes HTML in the title (XSS guard): renderView with entry.title = "<script>alert(1)</script>", assert the HTML contains "&lt;script&gt;alert(1)&lt;/script&gt;" and does NOT contain the raw <script> substring outside of the JSON-stringified form inside <script> tags.
   - substitutes {{TITLE}} with empty string when entry.title is missing or empty: renderView with entry.title = "" and entry.title = undefined, assert the HTML does not contain the literal {{TITLE}} placeholder, and the <h1 class="diagram-title"> element is empty.
   - substitutes {{TITLE_JSON}} with the JSON-stringified title for JS-side use: renderView with entry.title = 'He said "hi"', assert the HTML contains He said \"hi\" (JSON-escaped form) inside the <script> block (look for `const TITLE = ` followed by the JSON form).
   - preserves the {{ID}} and {{CODE}} placeholders (regression): assert {{ID}} is gone after substitution and {{TITLE}} substitution didn't break the other placeholders.
2. Run npm test to confirm the new test file is picked up and all 5 cases pass.
3. Run npm run test:coverage to confirm the 80% lines threshold is met on the included files (src/**/*.mjs excluding src/server.mjs). The new files src/storage/LocalFsStorage.mjs and src/tools.mjs must be at or above 80%; the existing helpers.mjs and render.mjs stay at 100%.
4. If coverage fails, identify the missing lines and add the smallest possible test to cover them. Do NOT lower the threshold — per D008 it's 80% lines, locked.

Done when: npm test exits 0 (full suite — all unit + integration + eval tests pass); npm run test:coverage exits 0 with lines ≥ 80% and the per-file table shows src/tools.mjs ≥ 80% and src/storage/LocalFsStorage.mjs ≥ 80% (target ≥ 90% on both); tests/unit/render-view-title.test.mjs exists with 5 cases.

## Inputs

- `src/helpers.mjs`
- `src/storage/LocalFsStorage.mjs`
- `src/tools.mjs`
- `public/view.html`
- `tests/unit/server-helpers.test.mjs`
- `vitest.config.mjs`

## Expected Output

- `tests/unit/render-view-title.test.mjs`

## Verification

npm test && npm run test:coverage
