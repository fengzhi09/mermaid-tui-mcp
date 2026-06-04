# Integrating mermaid-tui-mcp with gsd-pi

gsd-pi spawns MCP servers configured in `mcp.json` files. The first time a stdio server is registered you will be prompted to approve it (one-time per `command + args + cwd + env` signature).

## Config locations (priority: project-local > project-shared > global)

1. `<project>/.gsd/mcp.json` — project-local (committed or gitignored, your choice)
2. `<project>/.mcp.json` — project-shared (typically committed)
3. `~/.gsd/mcp.json` (or `$GSD_HOME/mcp.json`) — global, applies to every project

## Project-local config (recommended)

`<project>/.gsd/mcp.json`:

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

Replace the path with wherever you cloned `mermaid-tui-mcp`. Use forward slashes or escaped backslashes on Windows:

```json
"args": ["C:/Users/ace12/Documents/龙叔智能/codes/mermaid-tui-mcp/src/server.mjs"]
```

## Global config (applies to every gsd-pi project)

`~/.gsd/mcp.json`:

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

## First run

The first time gsd-pi sees the entry, it will prompt:

> Trust MCP server "mermaid"? Project config `<...>/.gsd/mcp.json` wants to start:
>
>   node C:/.../mermaid-tui-mcp/src/server.mjs
>
> Only approve MCP servers you trust.

Approve. After that, the `render_mermaid` tool is available in every gsd-pi session for the lifetime of the trust entry.

## Verifying

Inside a gsd-pi session, ask the LLM:

> Show me a flowchart of the OAuth2 authorization-code flow.

The LLM should call `render_mermaid` automatically, paste the ASCII into its reply, and print the `fileLink` (or `httpLink` if the HTTP daemon is running).

If the tool is not being called, list available MCP servers in gsd-pi with `/mcp` (or check the system prompt) — `mermaid` should be listed.

## HTTP daemon (for browser view + pin)

The stdio MCP path does not need a long-running daemon. But if you want the `httpLink` (with the pin button) to actually work, start the HTTP standalone mode separately:

```bash
# git bash / WSL / Linux / macOS
bash /path/to/mermaid-tui-mcp/bin/start.sh

# Windows PowerShell
powershell -File C:/Users/ace12/Documents/龙叔智能/codes/mermaid-tui-mcp/bin/start.ps1
```

The `httpLink` is `http://127.0.0.1:5300/view?id=<id>`. If the daemon is not running, the LLM still gets a valid `fileLink` that opens the viewer at `file://`.

## Notes

- gsd-pi treats MCP server config as JSON. Comments are not allowed. Trailing commas are not allowed.
- The `args` array is passed verbatim. No shell expansion. If your path contains spaces (e.g. `Documents/龙叔智能/`), you do NOT need to quote it inside the JSON string — JSON strings already handle spaces.
- gsd-pi clears the trust cache when you change `command` / `args` / `cwd` / `env`. If you move the project you will be re-prompted to approve.
