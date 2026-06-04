---
estimated_steps: 18
estimated_files: 10
skills_used: []
---

# T04: Convert 10 evals.xml entries to vitest tests

Why: R006 requires all 10 evals.xml entries to become executable vitest tests. Each entry's <expected> block is a contract; the test asserts on the contract. Eval 9 (pin via stdio) is intentionally a `it.todo` because the v0.1.0 server does not expose `pin_mermaid` over stdio — S02 will replace the todo with a real assertion.

Do: For each entry in evals.xml (ids 1 through 10), create `tests/evals/eval-NN-slug.test.mjs` where `slug` is a short kebab-case name matching the eval's topic. Each file must:
  - Start with a comment block (5-10 lines) quoting the <question> and <expected> from the corresponding evals.xml entry.
  - Use `describe('eval-NN: <one-line topic>', ...)` wrapper.
  - Contain 1-5 vitest assertions exercising the contract.

Per-eval specifics:
- eval-01-tcp-handshake: render a sequence diagram (e.g. `sequenceDiagram\n  participant C\n  participant S\n  C->>S: SYN\n  S->>C: SYN+ACK\n  C->>S: ACK`); assert the result has non-empty `ascii` and `fileLink`.
- eval-02-three-flows: render a single diagram containing three subgraphs (OAuth2 auth-code, OAuth2 client-creds, OIDC implicit) in one `render_mermaid` call; assert the response is a single diagram (one call, one id).
- eval-03-gantt: render a gantt chart with design(2d), impl(5d), review(2d), bug-fix(3d), deploy(1d); assert the render succeeds (no throw, non-empty svg, non-empty ascii).
- eval-04-malformed: call `render` with MALFORMED; assert it throws an error whose message starts with "mermaid parse error:".
- eval-05-two-renders: call `render_mermaid` twice with slightly different code; assert the two ids are different.
- eval-06-er-diagram: render an `erDiagram` with 5 entities and 4 relationships; assert the render does not throw and produces a non-empty `fileLink`.
- eval-07-oversized: call `render` with `oversizedCode(200_001)`; assert it throws an error whose message contains "mermaid source too long" and "200001".
- eval-08-draw-anything: render a reasonable default (e.g. a small system architecture flowchart); assert it does not throw and produces a non-empty result.
- eval-09-pin-tool: use `it.todo` with a multi-line comment block explaining: "S01 expected: stdio MCP exposes render_mermaid only. S02 will add pin_mermaid; replace this it.todo with a real assertion that pin_mermaid is in the tools/list response. Header note: this is a TDD placeholder, not a failure."
- eval-10-file-link: call `render_mermaid`; assert `fileLink` starts with `file:///`; assert the path inside the URL exists on disk (use `fs/promises.access` or `fs.existsSync` to verify the .html file referenced by the link is reachable).

Where it makes sense, evals may use the stdio MCP path via `tests/helpers/server.mjs` (eval 1, 5, 6, 8, 10). Where the contract is purely about the render function or storage, evals may import `src/render.mjs` directly (eval 3, 4, 7) or `src/storage.mjs` directly (none of these 10). Eval 2 is best done at the render layer to assert "one call produces one id" (which the stdio MCP layer also enforces but is more boilerplate).

Done when: `npm test` exits 0; all 10 eval test files exist on disk; eval 9 is the only `it.todo`; the other 9 are real assertions that pass against the v0.1.0 server.

## Inputs

- `evals.xml`
- `src/server.mjs`
- `src/render.mjs`
- `src/storage.mjs`
- `tests/helpers/server.mjs`
- `tests/helpers/render-fixture.mjs`
- `tests/helpers/storage-fixture.mjs`
- `tests/integration/stdio-mcp.test.mjs`
- `tests/integration/http.test.mjs`
- `vitest.config.mjs`

## Expected Output

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

## Verification

npm test
