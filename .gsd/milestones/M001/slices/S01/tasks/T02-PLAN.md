---
estimated_steps: 28
estimated_files: 4
skills_used: []
---

# T02: Unit tests for storage, render, and server helpers

Why: Highest coverage win. Locks the existing v0.1.0 surface (storage, render, server helpers) so S02 and S03 can extend it without breaking it. Pure modules + already-exported helpers (per T01) are unit-testable without spawning the server.

Do:
1. Create `tests/unit/storage.test.mjs`. Use `makeTempStorage()` from T01. Cover, at minimum:
   - `load()` on a fresh root: store is empty, blobs dir is created.
   - `load()` with a valid `store.json` containing entries: store is populated.
   - `load()` with a corrupted `store.json` (write garbage like `not json{{{`): store starts empty, no crash.
   - `put(id, code, svg, sourceLength)`: entry exists in store; blob file exists on disk; `get(id)` returns entry with `lastAccessedAt` updated.
   - `has(id)`: true for stored, false otherwise.
   - `readSvg(id)`: returns the svg text; returns null for missing id.
   - `setPinned(id, true)`: entry's `pinned` flag flips; `setPinned` on missing id returns false; `setPinned` on existing id returns true.
   - `pruneIfExpired(id)`: returns entry for unexpired; returns null + removes from store + unlinks blob for expired non-pinned; returns entry for expired pinned (no sweep).
   - `sweep()`: removes expired non-pinned entries; keeps pinned ones; calls `save()` when it removed something; returns the count.
   - `stats()`: counts pinned vs unpinned correctly.
   - TTL boundary: an entry with `createdAt` exactly at the TTL boundary is treated as still valid (use `Date.now()` mocking via `vi.setSystemTime` or `vi.useFakeTimers` to control `Date.now()`).
2. Create `tests/unit/render.test.mjs`. Use `VALID_GRAPH` from `tests/helpers/render-fixture.mjs`. Cover, at minimum:
   - `render("")` throws "empty mermaid source".
   - `render("   ")` (whitespace only) throws "empty mermaid source".
   - `render(non-string)` (e.g. `null`, `123`) throws "empty mermaid source".
   - `render(oversizedCode(200_001))` throws an error message starting with "mermaid source too long (" and including the actual length and 200000.
   - `render(VALID_GRAPH)` returns `{ id, svg, ascii, sourceLength }` where `id` matches `/^m[a-z0-9]+$/`, `svg` is a non-empty string containing `<svg`, `ascii` is a string, and `sourceLength === VALID_GRAPH.length`.
   - `render(MALFORMED)` rejects with a message starting with "mermaid parse error:".
3. Create `tests/unit/server-helpers.test.mjs`. Import the exported helpers from T01's refactored `src/server.mjs` (note: importing server.mjs will run its mainline bootstrap; either set the env so the bootstrap is harmless or use `import { escapeHtml, fileUrlFor, extractSvgBody, httpError, renderView, log }` from a path that does not trigger the bootstrap. Practical approach: if importing server.mjs is too heavy in unit tests, copy the helper bodies into a test-only shim — but first attempt the real import. If `await storage.load()` at module top level conflicts, factor helpers into a separate `src/helpers.mjs` file that server.mjs also imports, then unit-test `src/helpers.mjs` directly. Whichever approach is used, the test must cover:
   - `escapeHtml`: escapes `&`, `<`, `>`, `"`, `'`.
   - `fileUrlFor`: on a posix path like `/Users/foo/bar.svg` produces `file:///Users/foo/bar.svg`; on a windows path like `C:\foo\bar.svg` produces `file:///C:/foo/bar.svg`.
   - `extractSvgBody`: returns the inner content of a `<svg>...</svg>` block; returns `""` for input that has no svg.
   - `httpError(404, "not found")`: returned Error has `.status === 404` and `.message === "not found"`.
   - `renderView(id, entry, svg, withPinButton)`: returns a string containing `escapeHtml(id)`, the ISO string of `entry.createdAt`, and the SVG inner body. Use `toContain` assertions.

Done when: `npm test` exits 0; all unit tests pass; running just the unit tests produces green output for storage + render + server-helpers.

## Inputs

- `src/storage.mjs`
- `src/render.mjs`
- `src/server.mjs`
- `tests/helpers/storage-fixture.mjs`
- `tests/helpers/render-fixture.mjs`
- `public/view.html`
- `package.json`
- `vitest.config.mjs`

## Expected Output

- `tests/unit/storage.test.mjs`
- `tests/unit/render.test.mjs`
- `tests/unit/server-helpers.test.mjs`
- `src/helpers.mjs`

## Verification

npm test
