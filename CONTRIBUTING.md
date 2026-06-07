# Contributing

Thanks for your interest in `@acer_09/mermaid-tui-mcp`! This is a small focused tool — the surface area is `src/server.mjs`, `src/render.mjs`, `src/storage.mjs`, and the HTML viewer. Most contributions fit in under 100 lines.

## Development

```bash
git clone https://gitee.com/fengzhi09/mermaid-tui-mcp
cd mermaid-tui-mcp
npm install
npm run dev          # auto-reload on src changes (stdio MCP)
npm run start:http   # start HTTP-standalone mode for browser testing
```

### Try it without an agent

```bash
# stdio MCP roundtrip via the official inspector
npx @modelcontextprotocol/inspector node src/server.mjs
# in the UI: connect, list tools, call render_mermaid with:
#   code: "graph TD\n  A[Start] --> B{Decision}\n  B -->|yes| C[OK]\n  B -->|no| D[End]"

# HTTP smoke
bash bin/start.sh
curl -sS http://127.0.0.1:5300/health | jq
# (POST /to_assic_art is not exposed over HTTP — MCP is the only render path
# in standalone mode. Use the inspector for tool calls.)
```

### Layout

```
src/
  server.mjs    # entry — stdio MCP + optional HTTP, both bound to the same storage
  render.mjs    # mermaid render (jsdom + getBBox polyfill) + ASCII fallback (mermaid-ascii)
  storage.mjs   # 7-day TTL, pin, JSON index, on-disk SVG + HTML blobs
public/
  view.html     # self-contained viewer with zoom/pan/download (no build step)
bin/
  start.sh / start.ps1   # HTTP-standalone daemon
  stop.sh  / stop.ps1    # graceful shutdown
docs/
  integration/  # one .md per agent
  api.md        # HTTP / MCP endpoints
  architecture.md
evals.xml       # 10 eval questions for the render_mermaid tool
```

### Code style

- ESM (`"type": "module"`), plain Node 22+. No TypeScript, no transpiler.
- 2-space indent, tabs in `.editorconfig` resolve to spaces for JSON/YAML.
- Logging goes to `stderr` — `stdout` is reserved for the MCP JSON-RPC stream.
- Public surface (tool input schema, tool description, env vars) is documented in code; keep the docs in sync.

### Adding a new tool

1. Add the tool to the `tools` array in `server.mjs` (under `mcp.setRequestHandler(ListToolsRequestSchema, ...)`). Write the description as if for a stranger under time pressure — it is the only thing the model reads to decide whether to call.
2. Add the handler under `mcp.setRequestHandler(CallToolRequestSchema, ...)`.
3. Add an `<eval>` to `evals.xml` that requires at least 2 calls (or a decision the model must make based on earlier output).
4. Test via the MCP Inspector before opening a PR.

## Pull requests

- One change per PR. If your PR has "and" in the title, split it.
- If your change touches the tool description, MCP schema, or storage layout, mention it in the PR body — these are compatibility-relevant.
- Run `bash bin/start.sh` + the inspector once locally before requesting review.

## Issues

- Bug reports: include the agent name, version, OS, the exact mermaid source that fails (or paste a redacted version), and the relevant log line.
- Feature requests: open an issue first. The tool surface is intentionally small.

## License

By contributing you agree your contributions are licensed under the MIT License (see `LICENSE`).
