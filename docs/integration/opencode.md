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

## v0.2.0 tool set

The `mermaid` server exposes **7 stdio MCP tools** (v0.2.0 surface): `render_mermaid`, `pin_mermaid`, `unpin_mermaid`, `get_diagram`, `list_diagrams`, `search_diagrams`, `delete_mermaid`. The LLM calls `render_mermaid` first for any new diagram, then uses the other 6 tools for the CRUD lifecycle.

## Verifying

In an opencode session:

```
/mcp
```

The `mermaid` server should be listed. All 7 of its tools become available to the LLM.

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

- The exact schema and field names (`type: "local"`, `command: [...]`) follow the opencode v0.6+ conventions. If you are on an older version, check the [opencode docs](https://opencode.ai/docs/).
- opencode has had issues with SSE-based MCP servers (see SST/opencode#834). `mermaid-tui-mcp` only uses stdio, so it is unaffected.
- If you want to gate the server behind a feature flag or env var, wrap the path lookup in a small shell script rather than relying on opencode's env support.
