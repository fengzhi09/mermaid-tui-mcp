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

- Hermes is YAML-based, not JSON. Strings with special characters (`/`, `\`, `:`) generally do not need quoting, but paths with spaces do.
- `timeout` (per tool call, in seconds) defaults to 120. Mermaid renders are typically < 1 s; 120 is plenty. Bump it if you are rendering very large diagrams.
- `tools.include` (default: empty list = load all 7) and `tools.exclude` let you filter the registered toolset. Use `include` to keep the surface minimal (e.g. `[render_mermaid, delete_mermaid]` for a read-only LLM that also needs to clean up).
- If the `mermaid` server fails to spawn, check `~/.hermes/logs/` for the child process stderr.
