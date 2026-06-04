---
id: T03
parent: S02
milestone: M001
key_files:
  - src/server.mjs
  - src/tools.mjs
  - src/helpers.mjs
  - public/view.html
  - tests/unit/tools.test.mjs
  - tests/unit/server-helpers.test.mjs
key_decisions:
  - registerTools refactored from mcp.registerTool(name, config, cb) to mcp.setRequestHandler(ListToolsRequestSchema, ...) + mcp.setRequestHandler(CallToolRequestSchema, ...) because the public @modelcontextprotocol/sdk/server export is the low-level Server class which lacks registerTool (that method is on McpServer, which is not in the package's exports map)
  - z.toJSONSchema(schema, {target: "draft-07"}) for tool inputSchema so LLM clients see a real JSON schema (not a zod object); preserves zod v4's max(200) title constraint as maxLength on the JSON schema
  - Storage backend factory logs the 'oss' stub branch to stderr (matches the existing log() helper) and falls through to LocalFsStorage so M002 can land the real impl without server.mjs changes
  - Unknown tool name at call time returns isError: true with code: -32601 (the JSON-RPC standard for method-not-found) wrapped in the R020 envelope, so a stale LLM call never gets a raw -32603
duration: 
verification_result: passed
completed_at: 2026-06-04T08:48:23.782Z
blocker_discovered: false
---

# T03: Wired registerTools() into server.mjs (storage backend factory, single SDK seam), added {{TITLE}}/{{TITLE_JSON}} placeholders to helpers.mjs + view.html (title prefix, h1 slot, document.title, JSON escape), and refactored registerTools to use setRequestHandler with z.toJSONSchema so it works on the actual public Server class.

**Wired registerTools() into server.mjs (storage backend factory, single SDK seam), added {{TITLE}}/{{TITLE_JSON}} placeholders to helpers.mjs + view.html (title prefix, h1 slot, document.title, JSON escape), and refactored registerTools to use setRequestHandler with z.toJSONSchema so it works on the actual public Server class.**

## What Happened

Executed the T03 plan with one structural correction forced by the SDK reality: the plan's `registerTools(mcp, ctx)` call was based on `mcp.registerTool(...)` which exists on `McpServer` (the high-level helper), but `src/server.mjs` imports `Server as McpServer` from `@modelcontextprotocol/sdk/server` — and that public export is the LOW-LEVEL `Server` class, which exposes `setRequestHandler` and not `registerTool`. The T02 unit tests passed because they used a fake `mcp` with a `registerTool` mock, so the API mismatch was invisible until T03 wired it to the real Server.

Fix: refactored `registerTools` in `src/tools.mjs` to install two `setRequestHandler` calls (ListToolsRequestSchema + CallToolRequestSchema) instead of looping `mcp.registerTool`. The list handler returns `{tools: TOOL_DEFS.map(t => ({name, description, inputSchema: z.toJSONSchema(t.input, {target: "draft-07"})}))}`. The call handler dispatches by name to `TOOL_DEFS[i].run`, applies the R020 envelope, catches tagged errors (`e.code` is a number) for the isError path, and re-throws unknown errors (SDK turns into -32603). Unit test fake updated to expose `setRequestHandler` + `callTool(name, args)` + `listTools()` helpers; the "registers all 7 tools" assertion now calls `mcp.listTools()` and checks the JSON schema shape (zod was the old assertion). End-to-end smoke verified all 7 tools reachable via real stdio MCP with proper draft-07 inputSchema.

Other T03 work as-planned: (1) server.mjs — removed dead `CallToolRequestSchema`/`ListToolsRequestSchema` imports + the now-unused `readFile`/`writeFile` imports, added `import { registerTools } from "./tools.mjs"`, added the MERMAID_RENDERER_BACKEND factory (`oss` → log + fall through to LocalFsStorage stub; `local`/unset → LocalFsStorage), replaced the two setRequestHandler blocks with one `registerTools(mcp, {storage, render, renderView, dataDir, httpEnabled, httpHost, httpPort})` call. (2) helpers.mjs — added `.replace(/\{\{TITLE\}\}/g, ...)` and `.replace(/\{\{TITLE_JSON\}\}/g, ...)` to renderView. (3) view.html — `<title>` now `{{TITLE}} · Mermaid {{ID}}` (empty title degrades to ` · Mermaid <id>`), added `<h1 class="diagram-title">` in topbar, CSS `.diagram-title` + `:empty { display: none }`, script-side `const TITLE = {{TITLE_JSON}};` + `document.title = ...` reassignment. (4) server-helpers.test.mjs updated to match the new S02 title shape (intent: HTML-escape + JSON-escape verification; the exact string changed). Preservation invariants: 6 single-name `^export` re-exports intact, v0.1.0 SIGINT/SIGTERM graceful shutdown intact, hourly sweep setInterval intact.

End-to-end verification: `node --check` on server.mjs + helpers.mjs + tools.mjs passes; `npm test` returns 90 passed / 1 todo (matches pre-change baseline); manual stdio JSON-RPC smoke confirms all 7 tools register, render with title returns proper envelope, JSON-schema inputSchemas are well-formed draft-07.

## Verification

node --check src/server.mjs && node --check src/helpers.mjs && node --check src/tools.mjs (parse OK); npm test (90 passed, 1 todo, 0 failed across 17 test files); grep -c "^export" src/server.mjs (6, S01 invariant preserved); grep -c "{{TITLE}}" public/view.html (2: <title> + <h1>); grep -c "{{TITLE_JSON}}" public/view.html (1: script-side); live stdio MCP smoke: tools/list returns 7 tools with proper draft-07 inputSchema, render_mermaid({code, title}) returns {id, ascii, fileLink, httpLink, title, elapsed_ms}, list_diagrams and search_diagrams work.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node --check src/server.mjs && node --check src/helpers.mjs && node --check src/tools.mjs` | 0 | pass | 2000ms |
| 2 | `npm test` | 0 | pass (90/91) | 6800ms |
| 3 | `grep -c "^export" src/server.mjs` | 0 | pass (6) | 200ms |
| 4 | `grep -c "{{TITLE}}" public/view.html` | 0 | pass (2) | 200ms |
| 5 | `live stdio MCP smoke (initialize + tools/list + render + list + search)` | 0 | pass (7 tools listed, render w/ title returns proper envelope) | 10000ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/server.mjs`
- `src/tools.mjs`
- `src/helpers.mjs`
- `public/view.html`
- `tests/unit/tools.test.mjs`
- `tests/unit/server-helpers.test.mjs`
