# Integrating mermaid-tui-mcp with opencode

[opencode](https://opencode.ai) (by SST) supports stdio MCP servers via its `mcp` config key.

## Config locations (priority: project > global)

1. `<project>/opencode.json` — project scope
2. `~/.config/opencode/opencode.json` — global scope

## Project scope (recommended)

`<project>/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mermaid": {
      "type": "local",
      "command": ["node", "C:/Users/ace12/Documents/龙叔智能/codes/mermaid-tui-mcp/src/server.mjs"],
      "enabled": true
    }
  }
}
```

## Global scope

`~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "mermaid": {
      "type": "local",
      "command": ["node", "C:/Users/ace12/Documents/龙叔智能/codes/mermaid-tui-mcp/src/server.mjs"],
      "enabled": true
    }
  }
}
```

The `command` is an array (argv). The first element is the executable, the rest are arguments. No shell is involved, so paths with spaces do not need quoting.

## Verifying

In an opencode session:

```
/mcp
```

The `mermaid` server should be listed. Its `render_mermaid` tool becomes available to the LLM.

## Notes

- The exact schema and field names (`type: "local"`, `command: [...]`) follow the opencode v0.6+ conventions. If you are on an older version, check the [opencode docs](https://opencode.ai/docs/).
- opencode has had issues with SSE-based MCP servers (see SST/opencode#834). `mermaid-tui-mcp` only uses stdio, so it is unaffected.
- If you want to gate the server behind a feature flag or env var, wrap the path lookup in a small shell script rather than relying on opencode's env support.
