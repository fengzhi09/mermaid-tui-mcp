---
estimated_steps: 18
estimated_files: 2
skills_used: []
---

# T04: stdio MCP integration tests (6 new tools) + flip eval-09

Why: Locks the wire format and the R020 envelope for the 6 new tools. Eval-09 is the public acceptance contract for S02 (per MEM011) — flipping it from it.todo to a real assertion proves the new stdio MCP path works end-to-end.

Do:
1. Modify tests/integration/stdio-mcp.test.mjs:
   - Update the existing "lists render_mermaid in tools/list ..." test to assert 7 tools: rename the test to "lists 7 tools in tools/list with the new CRUD surface", and assert result.tools.length === 7, with result.tools.map(t => t.name).sort() deep-equal to ['delete_mermaid', 'get_diagram', 'list_diagrams', 'pin_mermaid', 'render_mermaid', 'search_diagrams', 'unpin_mermaid'].
   - Update the existing "renders a diagram via tools/call ..." test to also assert title in the parsed payload (default "") and elapsed_ms (number >= 0). Add a sibling test "renders a diagram with a title and round-trips it through the storage entry" that calls render_mermaid with title: "Auth flow", asserts the parsed title === "Auth flow", then calls search_diagrams({query: "auth"}) and asserts the entry is found with titleMatch: true.
   - Add 5 new it() blocks (one per new tool). Each follows the same pattern: initialize, render (to seed an id), call the new tool, assert the parsed content[0].text shape (success) OR isError: true + code: -32005 (missing-id case).
     - pin_mermaid over stdio MCP flips the pinned flag and returns elapsed_ms: render, pin, assert parsed = {id, pinned: true, elapsed_ms: number >= 0}.
     - unpin_mermaid over stdio MCP is the dual of pin_mermaid: render, pin, unpin, assert parsed = {id, pinned: false, elapsed_ms: number >= 0}.
     - list_diagrams over stdio MCP paginates with limit and supports pinned filter: render 3, list with limit: 2, assert parsed.items.length === 2 and parsed.nextCursor !== null. Then list with pinned: true after pinning the first one, assert the pinned item is in the result and the other 2 are not.
     - get_diagram over stdio MCP returns the full object including title: render with title, get, assert parsed = {id, title, code, ascii, svg, createdAt, lastAccessedAt, pinned, sourceLength, elapsed_ms}.
     - delete_mermaid over stdio MCP removes entry + blob and returns deleted: true: render, delete, assert parsed = {id, deleted: true, elapsed_ms: number >= 0}. Then assert the entry is gone by calling get_diagram({id}) and expecting isError: true with code: -32005.
     - search_diagrams over stdio MCP matches title with titleMatch boost: render two with different titles ("Alpha" + "Beta") and a third with no title; search "alpha", assert the Alpha entry is first with titleMatch: true; search "graph" (matches code), assert the result is present with titleMatch: false.
   - Add 1 negative test: delete_mermaid over stdio MCP returns isError: true with code -32005 for a missing id (strict 404, MEM014): call delete with id: "nonexistent", assert result.isError === true, parse content[0].text, assert parsed.code === -32005 and parsed.retryable === false.
   - Do NOT remove the v0.1.0 3 test cases — they stay; the 2 updates are in-place.
2. Modify tests/evals/eval-09-pin-tool.test.mjs:
   - Replace the it.todo with a real it() block. The eval-09 contract is "pin the diagram we just rendered (id=mabc123) so it doesn't get cleaned up after 7 days." Implement it as: spawn the server via spawnServer({env: {MERMAID_RENDERER_DATA: tempDataDir}}), initialize, call render_mermaid to seed an id, call pin_mermaid({id}), then call list_diagrams({pinned: true}) and assert the seeded id is in the items with pinned: true.
   - Update the header comment to reflect the new S02 reality (the v0.1.0 "HTTP-only" wording in evals.xml is now stale — note this in the test's preamble and mention that S02's behavior supersedes it).

Done when: npm test -- tests/integration/stdio-mcp.test.mjs tests/evals/eval-09-pin-tool.test.mjs exits 0; the new 6 integration it() blocks all green; eval-09's it.todo is gone, replaced by a real assertion that passes; the v0.1.0 3 integration tests still pass (with the 2 in-place updates).

## Inputs

- `src/server.mjs`
- `src/tools.mjs`
- `src/storage/LocalFsStorage.mjs`
- `src/helpers.mjs`
- `public/view.html`
- `tests/helpers/server.mjs`
- `tests/integration/stdio-mcp.test.mjs`
- `tests/evals/eval-09-pin-tool.test.mjs`

## Expected Output

- `tests/integration/stdio-mcp.test.mjs`
- `tests/evals/eval-09-pin-tool.test.mjs`

## Verification

npm test -- tests/integration/stdio-mcp.test.mjs tests/evals/eval-09-pin-tool.test.mjs
