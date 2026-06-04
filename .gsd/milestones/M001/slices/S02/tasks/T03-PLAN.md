---
estimated_steps: 18
estimated_files: 3
skills_used: []
---

# T03: server.mjs registerTool x 7 + view.html TITLE + renderView substitution

Why: The stdio MCP handler must list 7 tools. The view.html template needs a {{TITLE}} slot (R023 + MEM012). The renderView helper in src/helpers.mjs must substitute it. S01's grep -c "^export" === 6 audit invariant is preserved.

Do:
1. Modify src/server.mjs:
   - Add import: `import { registerTools } from "./tools.mjs";`.
   - Replace the mcp.setRequestHandler(ListToolsRequestSchema, ...) block and the mcp.setRequestHandler(CallToolRequestSchema, ...) block with a single call: registerTools(mcp, {storage, render, renderView, dataDir: DATA, httpEnabled: HTTP_ENABLED, httpHost: HTTP_HOST, httpPort: HTTP_PORT}).
   - Add a tiny factory step before `await storage.load()`: read MERMAID_RENDERER_BACKEND env. If === "oss", log a stderr line and fall through to LocalFsStorage (the 'oss' branch is a stub for M002 — per MEM002 the switch exists but the impl lands in M002). If === "local" or unset, use LocalFsStorage. Use the alias import from T01.
   - The current `const storage = new Storage(DATA); await storage.load();` lines stay; the factory wraps the `new` call.
   - Preserve the v0.1.0 SIGINT/SIGTERM graceful shutdown and the hourly sweep setInterval.
   - Preserve the 6 single-name helper re-exports (the grep -c "^export" === 6 audit count).
2. Modify src/helpers.mjs:
   - In renderView(id, entry, svg, withPinButton = false), add one line after the existing .replace() chain: .replace(/\{\{TITLE\}\}/g, entry.title ? escapeHtml(entry.title) : ""). Also add a {{TITLE_JSON}} substitution: .replace(/\{\{TITLE_JSON\}\}/g, JSON.stringify(entry.title ?? "")).
3. Modify public/view.html:
   - Update the <title> element to use the title: <title>{{TITLE}} · Mermaid {{ID}}</title>. When title is empty, the rendered <title> becomes ` · Mermaid <id>`, which is acceptable (graceful degradation).
   - Add a new element in the topbar after the <span class="id">{{ID}}</span> element: <h1 class="diagram-title" id="diagram-title">{{TITLE}}</h1>. When title is empty, the h1 is rendered with empty text content — the CSS hides it via :empty { display: none } (add a small .diagram-title { font-size: 14px; font-weight: 500; color: #f9fafb; margin: 0; } .diagram-title:empty { display: none; } rule in the existing <style> block).
   - Add a script-side `const TITLE = {{TITLE_JSON}};` line in the existing inline <script> block, and `document.title = TITLE ? `${TITLE} · Mermaid ${ID}` : `Mermaid ${ID}`;`.
4. Run `node --check src/server.mjs && node --check src/helpers.mjs` to confirm both still parse.
5. Run `npm test` to confirm S01's locked assertions (HTTP /pin still works, stdio MCP render still works, no regressions).

Done when: `node --check src/server.mjs && node --check src/helpers.mjs` exits 0; `npm test` exits 0 (full suite); the server still has 6 single-name `^export` lines; the view.html contains the {{TITLE}} placeholder (verifiable by grep).

## Inputs

- `src/server.mjs`
- `src/tools.mjs`
- `src/helpers.mjs`
- `src/storage/LocalFsStorage.mjs`
- `public/view.html`
- `tests/integration/stdio-mcp.test.mjs`
- `tests/integration/http.test.mjs`

## Expected Output

- `src/server.mjs`
- `src/helpers.mjs`
- `public/view.html`

## Verification

node --check src/server.mjs && node --check src/helpers.mjs && npm test
