# Integrating mermaid-tui-mcp with Hermes (Nous Research)

[Hermes Agent](https://hermes-agent.nousresearch.com) has a built-in MCP client since v0.2.0. Servers are configured in `~/.hermes/config.yaml` under the `mcp_servers` key.

## Config location

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  mermaid:
    type: stdio
    command: node
    args:
      - "C:/Users/ace12/Documents/龙叔智能/codes/mermaid-tui-mcp/src/server.mjs"
    # optional:
    # env: {}
    # timeout: 120
    # tools:
    #   # Default: load all 7 tools. To load a subset, list them here.
    #   include: []                # empty = all 7 (render_mermaid, pin_mermaid,
    #                              #          unpin_mermaid, get_diagram,
    #                              #          list_diagrams, search_diagrams,
    #                              #          delete_mermaid)
    #   # include: [render_mermaid, delete_mermaid]   # minimal example
    #   exclude: []
```

## v0.2.0 tool set

The `mermaid` server exposes **7 stdio MCP tools** (v0.2.0 surface): `render_mermaid`, `pin_mermaid`, `unpin_mermaid`, `get_diagram`, `list_diagrams`, `search_diagrams`, `delete_mermaid`. The LLM calls `render_mermaid` first for any new diagram, then uses the other 6 tools for the CRUD lifecycle.

## Verifying

In a Hermes session:

```
/mcp
```

(or the equivalent Hermes command to list loaded MCP servers — see the [Hermes MCP docs](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference) for the current spelling.)

All 7 `mermaid` tools should appear alongside Hermes's built-in tools.

## Notes

- Hermes is YAML-based, not JSON. Strings with special characters (`/`, `\`, `:`) generally do not need quoting, but paths with spaces do.
- `timeout` (per tool call, in seconds) defaults to 120. Mermaid renders are typically < 1 s; 120 is plenty. Bump it if you are rendering very large diagrams.
- `tools.include` (default: empty list = load all 7) and `tools.exclude` let you filter the registered toolset. Use `include` to keep the surface minimal (e.g. `[render_mermaid, delete_mermaid]` for a read-only LLM that also needs to clean up).
- If the `mermaid` server fails to spawn, check `~/.hermes/logs/` for the child process stderr.
