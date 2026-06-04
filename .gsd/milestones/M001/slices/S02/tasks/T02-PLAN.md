---
estimated_steps: 31
estimated_files: 4
skills_used: []
---

# T02: Add zod + create src/tools.mjs with 7 handlers + unit tests

Why: zod is a non-optional peer dep of @modelcontextprotocol/sdk@1.29 (peerDeps line 207 of the SDK's package.json, peerDependenciesMeta.zod.optional: false) — it must be installed before T03 can wire mcp.registerTool(name, config, cb) with inputSchema: zodShape. The 7 tool handlers must be pure (no I/O beyond the storage interface, no MCP SDK import beyond the registerTool call site) so unit tests can cover them. The registerTools(mcp, ctx) wrapper centralizes the R020 envelope and the elapsed_ms timer so every tool gets the same shape without per-handler boilerplate.

Do:
1. npm install zod@^4.0 (already present in node_modules/zod@4.4.3 as a transitive dep — install explicitly so it's a direct dep). Commit the resulting package.json and package-lock.json changes. Verify with `node -e "import('zod').then(z => console.log(z.z.string().parse('ok')))"`.
2. Create src/tools.mjs (new). Structure:
   - Imports: z from "zod". No other imports — the file is pure handlers + a registerTools helper.
   - Tagged error classes: `class NotFoundError extends Error { constructor(msg) { super(msg); this.code = -32005; this.retryable = false; } }` and `class StorageWriteError extends Error { constructor(msg) { super(msg); this.code = -32004; this.retryable = true; } }`. S03 may add more codes; the tagged-error pattern is the seam.
   - Shared zod primitives: Title = z.string().max(200).optional(), Id = z.string().min(1).max(200), Limit = z.number().int().min(1).max(100).default(20), Cursor = z.string().min(1).max(200).optional(), Pinned = z.boolean().optional(), Query = z.string().min(1).max(200), Include = z.array(z.string()).optional().
   - Per-tool input shapes: InputRender = z.object({ code: z.string().min(1).max(200_000), title: Title }), InputId = z.object({ id: Id }), InputList = z.object({ limit: Limit, cursor: Cursor, pinned: Pinned }), InputGet = z.object({ id: Id, include: Include }), InputSearch = z.object({ query: Query, limit: Limit, cursor: Cursor, pinned: Pinned }).
   - 7 handler functions, each async (args, ctx) => { ... }:
     - renderMermaid(args, ctx): validates code length (already done in zod schema), calls ctx.render(args.code) to get {id, svg, ascii, sourceLength}, calls ctx.storage.put(id, args.code, svg, sourceLength, args.title), calls ctx.renderView(id, ctx.storage.getMetadata(id), svg), writes the HTML blob to ctx.dataDir/blobs/<id>.html (mirror the v0.1.0 pattern), and returns {id, ascii, fileLink: fileUrlFor(htmlPath), httpLink: ctx.httpEnabled ? `http://${ctx.httpHost}:${ctx.httpPort}/view?id=${id}` : null, title: args.title ?? ""}. On mermaidToAscii failure (caught in render()), surfaces warnings: ["ascii_failed: <reason>"] (R025) — the handler checks if ascii starts with "[mermaid-ascii failed:" and if so, adds the warning.
     - pinMermaid(args, ctx): calls ctx.storage.setPinned(args.id, true); if returns false, throws new NotFoundError(`diagram not found: ${args.id}`); returns {id: args.id, pinned: true}.
     - unpinMermaid(args, ctx): same pattern, setPinned(args.id, false). Throws NotFoundError on missing.
     - listDiagrams(args, ctx): calls ctx.storage.list({limit: args.limit, cursor: args.cursor, pinned: args.pinned}); returns {items, nextCursor}.
     - getDiagram(args, ctx): calls ctx.storage.getMetadata(args.id); if null, throws NotFoundError; otherwise calls ctx.storage.readSvg(args.id), returns the full object {id, title: entry.title ?? "", code, ascii, svg, createdAt, lastAccessedAt, pinned, sourceLength}. The include filter is a future M002 enhancement — for S02 we always return the full object; the field is accepted but not honored.
     - deleteMermaid(args, ctx): calls ctx.storage.remove(args.id); if returns false, throws new NotFoundError(`diagram not found: ${args.id}`) (per MEM014 strict 404); otherwise returns {id: args.id, deleted: true}.
     - searchDiagrams(args, ctx): calls ctx.storage.search(args.query, {limit: args.limit, cursor: args.cursor, pinned: args.pinned}); returns {items, nextCursor}.
   - TOOL_DEFS array: [{name: "render_mermaid", description: "...", input: InputRender, run: renderMermaid}, ...] with descriptions matching the v0.1.0 wording (so eval-08's "draw anything" still hints correctly) plus the new CRUD descriptions. Each description is 1-3 sentences telling the LLM what the tool does and what its output looks like.
   - registerTools(mcp, ctx) function: iterates TOOL_DEFS, calls mcp.registerTool(name, {description, inputSchema: input}, async (args) => { ... }). The callback:
     - Captures const startNs = process.hrtime.bigint().
     - try: const payload = await tool.run(args, ctx); const elapsed_ms = Number((process.hrtime.bigint() - startNs) / 1_000_000n); return {content: [{type: "text", text: JSON.stringify({...payload, elapsed_ms})}]}.
     - catch (e): if e.code is a number, return {isError: true, content: [{type: "text", text: JSON.stringify({code: e.code, message: String(e.message ?? e), retryable: !!e.retryable})}]}. Else re-throw (the SDK converts unknown throws to JSON-RPC -32603).
3. Export registerTools, the 7 handler functions (so unit tests import them directly), and the tagged error classes. Do NOT export TOOL_DEFS.
4. Create tests/unit/tools.test.mjs (new). For each handler, write 2-4 cases covering the success path and the tagged-error path. Mock the ctx: {storage: makeTempStorage().storage, render: render, renderView: renderView, dataDir: tempDir, httpEnabled: false, httpHost: "127.0.0.1", httpPort: 5300}. Use makeTempStorage() from tests/helpers/storage-fixture.mjs (after T01 updates it). Cases:
   - renderMermaid: success returns {id, ascii, fileLink, httpLink: null, title: ""}; success with title returns title in payload; the warnings path: stub ctx.render to return ascii starting with "[mermaid-ascii failed:" and assert warnings: ["ascii_failed: <reason>"] in the result.
   - pinMermaid / unpinMermaid: success returns {id, pinned: true|false}; missing id throws NotFoundError with code -32005.
   - listDiagrams: success returns {items, nextCursor} with the right shape (3 entries seeded, limit=2, expect items.length=2 + nextCursor).
   - getDiagram: success returns the full object; missing id throws NotFoundError.
   - deleteMermaid: success returns {id, deleted: true}; missing id throws NotFoundError.
   - searchDiagrams: success returns {items: [{titleMatch: true, ...}, ...]} with title-match ranking above code-match.
   - registerTools wrapper: also test it directly with a fake mcp (an object recording registerTool calls) and a fake ctx, asserting that the wrapper produces the right R020 envelope on success (JSON.parse(text).elapsed_ms >= 0) and on tagged error (isError: true, code: -32005).

Done when: npm test -- tests/unit/tools.test.mjs exits 0 with all 14-20 cases green; node --check src/tools.mjs exits 0; node -e "import('./src/tools.mjs').then(m => console.log(typeof m.registerTools, typeof m.renderMermaid, typeof m.pinMermaid))" prints "function function function".

## Inputs

- `package.json`
- `src/storage/LocalFsStorage.mjs`
- `src/render.mjs`
- `src/helpers.mjs`
- `tests/helpers/storage-fixture.mjs`
- `tests/helpers/render-fixture.mjs`

## Expected Output

- `package.json`
- `package-lock.json`
- `src/tools.mjs`
- `tests/unit/tools.test.mjs`

## Verification

npm test -- tests/unit/tools.test.mjs
