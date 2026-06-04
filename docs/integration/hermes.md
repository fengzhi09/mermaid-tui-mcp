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
    #   include: [render_mermaid]
    #   exclude: []
```

## Verifying

In a Hermes session:

```
/mcp
```

(or the equivalent Hermes command to list loaded MCP servers — see the [Hermes MCP docs](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference) for the current spelling.)

The `render_mermaid` tool should appear alongside Hermes's built-in tools.

## Notes

- Hermes is YAML-based, not JSON. Strings with special characters (`/`, `\`, `:`) generally do not need quoting, but paths with spaces do.
- `timeout` (per tool call, in seconds) defaults to 120. Mermaid renders are typically < 1 s; 120 is plenty. Bump it if you are rendering very large diagrams.
- `tools.include` / `tools.exclude` let you filter the registered toolset. Useful if a future version of this server exposes more tools and you want to keep the surface minimal.
- If the `mermaid` server fails to spawn, check `~/.hermes/logs/` for the child process stderr.
