# Integrating mermaid-tui-mcp with Claude Code

Claude Code reads MCP server config from `.mcp.json` at the project root (project scope) or `~/.claude.json` (user scope). See the [Claude Code MCP docs](https://docs.claude.com/en/docs/claude-code/mcp) for the latest details.

## Project scope (recommended for repo-bound work)

`<project>/.mcp.json`:

```json
{
  "mcpServers": {
    "mermaid": {
      "command": "node",
      "args": [
        "C:/Users/ace12/Documents/龙叔智能/codes/mermaid-tui-mcp/src/server.mjs"
      ]
    }
  }
}
```

Project-scoped servers are typically committed to the repo so every contributor gets the same toolset.

## User scope (applies to every Claude Code session)

`~/.claude.json` — add to the `mcpServers` key:

```json
{
  "mcpServers": {
    "mermaid": {
      "command": "node",
      "args": [
        "C:/Users/ace12/Documents/龙叔智能/codes/mermaid-tui-mcp/src/server.mjs"
      ]
    }
  }
}
```

## Approval

Claude Code asks for approval the first time a stdio MCP server is added. After approval, the tool is available in every session that loads the same config.

## v0.2.0 tool set

The `mermaid` server exposes **7 stdio MCP tools** (v0.2.0 surface):

| Tool | Purpose |
|------|---------|
| `render_mermaid` | Render a diagram; returns `{id, ascii, fileLink, httpLink, title, elapsed_ms, warnings}`. |
| `pin_mermaid` | Protect a diagram from the 7-day sweep. |
| `unpin_mermaid` | Remove pin protection. |
| `get_diagram` | Fetch the full stored entry (code, title, pinned, timestamps). |
| `list_diagrams` | Paginated list (each item carries `id`, `title`, `pinned`). |
| `search_diagrams` | Substring match on title (boosted) and code. |
| `delete_mermaid` | Explicit remove. |

The LLM still calls `render_mermaid` first for any new diagram, then uses the other 6 tools for the CRUD lifecycle.

## Verifying

Inside Claude Code:

```
/mcp
```

Should list `mermaid` and all 7 of its tools. Then:

> Render a Mermaid sequence diagram showing OAuth2 authorization-code flow: client → auth server → resource server.

The LLM should call `render_mermaid` automatically and paste the ASCII output.

## CLI alternative (without editing config)

```bash
claude --mcp-config '{
  "mcpServers": {
    "mermaid": {
      "command": "node",
      "args": ["C:/Users/ace12/Documents/龙叔智能/codes/mermaid-tui-mcp/src/server.mjs"]
    }
  }
}'
```

## v0.3.0 cloud storage (OssStorage)

The `mermaid` server can route all 7 stdio MCP tools to a S3-compatible
object store (AWS S3, MinIO, Aliyun OSS in S3-compat mode) by setting
`MERMAID_RENDERER_BACKEND=oss` plus 5 required `MERMAID_OSS_*` env vars
in the server's env. The 7 tool handlers and the default `LocalFsStorage`
impl are unchanged — the env switch is the only seam.

| Var | Required | Example |
|---|---|---|
| `MERMAID_RENDERER_BACKEND` | yes | `oss` |
| `MERMAID_OSS_ENDPOINT` | yes | `http://127.0.0.1:9000` (MinIO), `https://s3.us-east-1.amazonaws.com` (AWS) |
| `MERMAID_OSS_REGION` | yes | `us-east-1`, `cn-hangzhou` |
| `MERMAID_OSS_ACCESS_KEY_ID` | yes | `<key>` |
| `MERMAID_OSS_SECRET_ACCESS_KEY` | yes | `<secret>` |
| `MERMAID_OSS_BUCKET` | yes | `mermaid` |
| `MERMAID_OSS_PREFIX` | no | `team-a/` |
| `MERMAID_OSS_FORCE_PATH_STYLE` | no | `true` (default) |

On missing/empty required env, the server logs `oss_init_failed` to
stderr and exits 1. See the migration section below for bringing
existing v0.2.0 `data/` into a bucket.

### Migrating from local to cloud

`node bin/migrate-to-oss.mjs` (idempotent, dry-run-able, 4-of-5 post-sweep
invariant, exit codes 0/1/2). See `README.md` for the full CLI doc.

## Notes

- If the path contains backslashes, escape them in the JSON: `"C:\\Users\\...\\server.mjs"`. Forward slashes work without escaping on every platform Claude Code supports.
- Each Claude Code session spawns its own MCP child. Multiple sessions = multiple child processes. The data store is shared (same `data/` directory), so diagrams rendered in one session are visible to another as long as they have not expired.
- See the Claude Code MCP docs for `sse` transport and OAuth flows if you need to point at a remote `mermaid-tui-mcp` over the network. This project only ships the stdio transport out of the box.
