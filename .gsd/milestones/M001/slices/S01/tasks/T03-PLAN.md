---
estimated_steps: 19
estimated_files: 2
skills_used: []
---

# T03: Integration tests for stdio MCP and HTTP routes

Why: Spawns the real server as a child process; drives JSON-RPC over stdio; hits the HTTP routes with Node's built-in fetch. Locks the server's externally visible behavior so the v0.1.0 surface stays green under vitest.

Do:
1. Create `tests/integration/stdio-mcp.test.mjs`:
   - Use `spawnServer()` from `tests/helpers/server.mjs`.
   - Set `MERMAID_RENDERER_DATA` to a per-test temp dir under `os.tmpdir()` so the real `data/` is not touched (clean up with `fs/promises.rm` in afterEach).
   - Send `initialize` with `protocolVersion: "2025-06-18"`, `clientInfo: { name: "vitest", version: "0.0.0" }`. Assert `result.serverInfo.name === "mermaid-tui-mcp"`.
   - Send `tools/list`. Assert the response contains a tool named `render_mermaid` with a non-empty `description` and an `inputSchema` whose `required` array includes `"code"`.
   - Send `tools/call` for `render_mermaid` with `code: "graph TD\n  A-->B"`. Assert `result.content[0].type === "text"`, parse the JSON text, assert the parsed object has non-empty `id`, `ascii`, `fileLink`. Assert `fileLink` starts with `file:///` and ends with `.html`.
   - Close the server.
2. Create `tests/integration/http.test.mjs`:
   - Spawn the server with `MERMAID_RENDERER_HTTP=1`, `MERMAID_RENDERER_PORT=0` (let the OS pick a port), `MERMAID_RENDERER_HOST=127.0.0.1`, and a per-test `MERMAID_RENDERER_DATA` temp dir.
   - Capture the bound port from the server's startup log on stderr (the server logs `http listening on http://127.0.0.1:<port>`). Alternative: poll `http://127.0.0.1:<port>/health` starting at port 15300 and increment until a connection succeeds, with a 5s timeout. The polling approach is simpler and avoids log-parsing.
   - First call `render_mermaid` over the stdio MCP path with a simple `graph TD\n  A-->B` to seed an entry + blob on disk.
   - Then call `GET http://127.0.0.1:<port>/health`. Assert status 200, body has `status === "ok"`, `version` is a string, and `total >= 1` (since we just rendered one).
   - Then call `GET http://127.0.0.1:<port>/raw/svg?id=<id>`. Assert status 200, content-type contains `image/svg+xml`, body starts with `<svg` or contains `<svg`.
   - Then call `POST http://127.0.0.1:<port>/pin?id=<id>&pin=true`. Assert status 200, body has `pinned: true`.
   - Then call `GET http://127.0.0.1:<port>/view?id=<id>`. Assert status 200, content-type contains `text/html`, body contains the rendered id.
   - Cleanup: kill the server child and `fs/promises.rm` the temp data dir.

Done when: `npm test` exits 0; the stdio MCP integration test passes; the HTTP integration test passes.

## Inputs

- `src/server.mjs`
- `src/render.mjs`
- `src/storage.mjs`
- `tests/helpers/server.mjs`
- `tests/helpers/storage-fixture.mjs`
- `package.json`
- `vitest.config.mjs`

## Expected Output

- `tests/integration/stdio-mcp.test.mjs`
- `tests/integration/http.test.mjs`

## Verification

npm test
