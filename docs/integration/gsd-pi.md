# Integrating @acer_09/mermaid-tui-mcp with gsd-pi

The `@acer_09/mermaid-tui-mcp` server is published on npm as [`@acer_09/mermaid-tui-mcp`](https://www.npmjs.com/package/@acer_09/mermaid-tui-mcp). All paths in the legacy `mcp.json` form below go through `npx`, so no local clone is required.

## Recommended: the `mermaid-direct` gsd-pi extension (v0.3.0+)

The default gsd-pi MCP transport (`mcp_client` extension backed by `@modelcontextprotocol/sdk` 1.29.0) **double-escapes the `code` arg** when relaying a `tools/call` request, so multi-line Mermaid source arrives at the server with literal `\n` instead of real newlines. The Mermaid 11 parser then chokes on the single-line input. This affects every real-world use case (`graph TD\n  A --> B\n  B --> C` etc.) — **the `mcp_client`-driven integration is effectively unusable for the headline mermaid use case**.

The fix is the `mermaid-direct` gsd-pi extension shipped in `extensions/gsd-pi-mermaid/`. It bypasses the broken SDK transport by spawning the mermaid server as a long-lived child process and exchanging raw JSON-RPC over stdio — real newlines survive.

### Install

The extension is gsd-pi-specific (not on npm) and is shipped inside the `@acer_09/mermaid-tui-mcp` package at `node_modules/mermaid-tui-mermaid/extensions/gsd-pi-mermaid/`. Two install paths:

```bash
# 1. Install the @acer_09/mermaid-tui-mcp package (one-time, user-scope)
npm install -g @acer_09/mermaid-tui-mcp

# 2. Copy the bundled gsd-pi extension to your gsd-pi extensions dir
mkdir -p ~/.pi/agent/extensions
cp -r "$(npm root -g)/mermaid-tui-mcp/extensions/gsd-pi-mermaid" ~/.pi/agent/extensions/mermaid-direct

# 3. Point the extension at the npm-installed server (one-time env var)
#    Add this to your shell rc so it persists across gsd-pi sessions:
export MERMAID_SERVER_PATH="$(npm root -g)/mermaid-tui-mcp/src/server.mjs"

# 4. /reload in gsd-pi
```

The extension registers 7 tools: `mermaid_render`, `mermaid_pin`, `mermaid_unpin`, `mermaid_get`, `mermaid_list`, `mermaid_search`, `mermaid_delete`.

### Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `MERMAID_SERVER_PATH` | `<projectRoot>/src/server.mjs` (only valid when you run gsd-pi from inside a local `@acer_09/mermaid-tui-mcp` checkout) | Absolute path to the mermaid server entrypoint. Set to `$(npm root -g)/mermaid-tui-mcp/src/server.mjs` for the npm-install flow above. |
| `PI_PROJECT_DIR` | (gsd-pi per-session) | Project root the default `MERMAID_SERVER_PATH` is resolved from |
| All `MERMAID_RENDERER_*` and `MERMAID_OSS_*` env vars | inherited | Forwarded verbatim to the spawned server (so `MERMAID_RENDERER_DATA`, `MERMAID_OSS_ENDPOINT`, etc. work as if you ran the server directly) |

### Limitations

- One mermaid server per gsd-pi session (one per `PI_PROJECT_DIR`).
- No auto-reconnect on child crash — next tool call throws; the user can reload gsd-pi to spawn a fresh server.
- The underlying gsd-pi / MCP SDK bug is real and should be fixed upstream; this extension is the scoped, project-local workaround that ships now.

---

## Legacy: `mcp.json` config (NOT recommended — see above)

If you must use the standard mcp.json path (e.g. you need other MCP servers that go through the same transport and accept the double-escape), the legacy configuration is:

## Config locations (priority: project-local > project-shared > global)

1. `<project>/.gsd/mcp.json` — project-local (committed or gitignored, your choice)
2. `<project>/.mcp.json` — project-shared (typically committed)
3. `~/.gsd/mcp.json` (or `$GSD_HOME/mcp.json`) — global, applies to every project

## Project-local config (legacy)

`<project>/.gsd/mcp.json`:

```json
{
  "mcpServers": {
    "mermaid": {
      "command": "npx",
      "args": ["-y", "@acer_09/mermaid-tui-mcp"]
    }
  }
}
```

`npx` resolves the package from the npm registry on first use; no local clone is needed.

## Global config (applies to every gsd-pi project)

`~/.gsd/mcp.json`:

```json
{
  "mcpServers": {
    "mermaid": {
      "command": "npx",
      "args": ["-y", "@acer_09/mermaid-tui-mcp"]
    }
  }
}
```

## v0.2.0 tool set

The `mermaid` server exposes **7 stdio MCP tools** (v0.2.0 surface): `render_mermaid`, `pin_mermaid`, `unpin_mermaid`, `get_diagram`, `list_diagrams`, `search_diagrams`, `delete_mermaid`. The LLM calls `render_mermaid` first for any new diagram, then uses the other 6 tools for the CRUD lifecycle (pin/unpin, get, list, search, delete).

## First run

The first time gsd-pi sees the entry, it will prompt:

> Trust MCP server "mermaid"? Project config `<...>/.gsd/mcp.json` wants to start:
>
>   npx -y @acer_09/mermaid-tui-mcp
>
> Only approve MCP servers you trust.

Approve. After that, all 7 tools are available in every gsd-pi session for the lifetime of the trust entry.

## Verifying

Inside a gsd-pi session, ask the LLM:

> Show me a flowchart of the OAuth2 authorization-code flow.

The LLM should call `mermaid_render` automatically, paste the ASCII into its reply, and print the `fileLink` (or `httpLink` if the HTTP daemon is running).

If the tool is not being called, list available MCP servers in gsd-pi with `/mcp` (or check the system prompt) — `mermaid` should be listed.

## HTTP daemon (for browser view + pin)

The stdio MCP path does not need a long-running daemon. But if you want the `httpLink` (with the pin button) to actually work, start the HTTP standalone mode separately:

```bash
MERMAID_RENDERER_HTTP=1 npx -y @acer_09/mermaid-tui-mcp
```

The `httpLink` is `http://127.0.0.1:5300/view?id=<id>`. If the daemon is not running, the LLM still gets a valid `fileLink` that opens the viewer at `file://`.

A managed background daemon (PID file + log + auto-restart) is also available via the bash helper shipped in the npm package at `$(npm root -g)/mermaid-tui-mcp/bin/start.sh` — but the inline `npx` command above is the common case.

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

`npx -y @acer_09/mermaid-tui-mcp --bin=migrate-to-oss` (or, from a local checkout, `node bin/migrate-to-oss.mjs`). The CLI is idempotent, dry-run-able, 4-of-5 post-sweep invariant, exit codes 0/1/2. See `README.md` for the full CLI doc.

## Notes

- gsd-pi treats MCP server config as JSON. Comments are not allowed. Trailing commas are not allowed.
- gsd-pi clears the trust cache when you change `command` / `args` / `cwd` / `env`. If you switch between the npx form and a local-path form, you will be re-prompted to approve.
- For per-project data isolation in the legacy mcp.json path, set `MERMAID_RENDERER_DATA` in the server's env via the gsd-pi `mcpServers.<name>.env` map.
