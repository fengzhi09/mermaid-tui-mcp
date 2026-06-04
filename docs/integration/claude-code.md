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

## Verifying

Inside Claude Code:

```
/mcp
```

Should list `mermaid` and its tools (currently `render_mermaid`). Then:

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

## Notes

- If the path contains backslashes, escape them in the JSON: `"C:\\Users\\...\\server.mjs"`. Forward slashes work without escaping on every platform Claude Code supports.
- Each Claude Code session spawns its own MCP child. Multiple sessions = multiple child processes. The data store is shared (same `data/` directory), so diagrams rendered in one session are visible to another as long as they have not expired.
- See the Claude Code MCP docs for `sse` transport and OAuth flows if you need to point at a remote `mermaid-tui-mcp` over the network. This project only ships the stdio transport out of the box.
