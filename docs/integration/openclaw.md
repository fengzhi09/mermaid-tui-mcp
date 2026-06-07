# Integrating @acer_09/mermaid-tui-mcp with OpenClaw

The `@acer_09/mermaid-tui-mcp` server is published on npm as [`@acer_09/mermaid-tui-mcp`](https://www.npmjs.com/package/@acer_09/mermaid-tui-mcp). [OpenClaw](https://github.com/openclaw/openclaw) (as of mid-2026) does **not have native MCP client support**. Tracking issue: [openclaw/openclaw#29053](https://github.com/openclaw/openclaw/issues/29053). There are a few workarounds.

## Workaround 1: HTTP transport

Run this server in HTTP-standalone mode (see [docs/architecture.md](../architecture.md)) and call it from OpenClaw via `exec` + `curl`:

```bash
# In one shell, start the HTTP daemon (resolved from the npm package):
MERMAID_RENDERER_HTTP=1 npx -y @acer_09/mermaid-tui-mcp

# In OpenClaw, ask the LLM to:
# 1. build the JSON body: {"code": "graph TD\n  A-->B"}
# 2. POST it to http://127.0.0.1:5300/... (note: HTTP mode does NOT expose
#    a render endpoint — only /view, /raw/svg, /pin, /health. See below.)
```

**Caveat:** The HTTP-standalone mode does not expose a render endpoint by design. The MCP tool is the only render path. So this workaround only works if you ALSO have an MCP-compatible client (e.g. Claude Code, gsd-pi) running alongside OpenClaw and you can ask it to render on OpenClaw's behalf.

## Workaround 2: Call the npm package's `render.mjs` directly (no MCP, no HTTP)

OpenClaw's `exec` tool can run a small Node script that imports the `render` function from inside the npm-installed `@acer_09/mermaid-tui-mcp` package. Because ESM imports need a static path, resolve the package root via `npm root -g` and use a dynamic `import()`:

```js
// scripts/render-once.mjs (place this in your project, not in @acer_09/mermaid-tui-mcp)
import { execSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const npmRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
const renderUrl = pathToFileURL(join(npmRoot, "@acer_09/mermaid-tui-mcp", "src", "render.mjs")).href;
const { render } = await import(renderUrl);

const code = process.argv[2];
if (!code) {
  console.error("usage: node render-once.mjs <mermaid-source>");
  process.exit(2);
}
const { ascii } = await render(code);
process.stdout.write(ascii);
```

Prereq: `npm install -g @acer_09/mermaid-tui-mcp` (so `npm root -g` resolves to a directory containing the package).

Then in OpenClaw:

```bash
node /path/to/scripts/render-once.mjs 'graph TD\n  A-->B'
```

This is fragile (no 7-day storage, no pin, no HTTP viewer) but it unblocks the basic use case while waiting for native MCP support in OpenClaw.

## Workaround 3: Wait for native MCP

Star and watch [openclaw/openclaw#29053](https://github.com/openclaw/openclaw/issues/29053). When native support lands, follow the gsd-pi / Claude Code / opencode / Hermes integration docs (one block in `~/.openclaw/config.*` or similar — TBD when the feature ships).

## v0.2.0 tool set & stdio-only tools (important for OpenClaw workarounds)

The `mermaid` server exposes **7 stdio MCP tools** (v0.2.0 surface): `render_mermaid`, `pin_mermaid`, `unpin_mermaid`, `get_diagram`, `list_diagrams`, `search_diagrams`, `delete_mermaid`.

**6 of the 7 tools are stdio-MCP-only** and have no HTTP or CLI surface: `pin_mermaid`, `unpin_mermaid`, `get_diagram`, `list_diagrams`, `search_diagrams`, `delete_mermaid`. Only `render_mermaid` is reachable through the workaround paths above (`render.mjs` direct call, or the HTTP `/raw/svg` / `/view` / `/pin` endpoints for the post-render file/pin side effects).

**Practical implication for OpenClaw:**

- Workaround 1 (HTTP-standalone) and Workaround 2 (`render.mjs` direct) give you **rendering only**. Pinning, listing, searching, getting metadata, and explicit deletion are not reachable from OpenClaw in v0.2.0.
- If you need the full 7-tool CRUD lifecycle from inside OpenClaw, you must either wait for native MCP (Workaround 3) or pair OpenClaw with a second MCP-capable agent (Claude Code, gsd-pi, opencode, Hermes) and have that agent run the CRUD tools on OpenClaw's behalf.

## v0.3.0 cloud storage (OssStorage) — not reachable from the OpenClaw workarounds

The `mermaid` server can route all 7 stdio MCP tools to a S3-compatible
object store (AWS S3, MinIO, Aliyun OSS in S3-compat mode) by setting
`MERMAID_RENDERER_BACKEND=oss` plus 5 required `MERMAID_OSS_*` env vars
on the server process. See `README.md` for the full env-var table and
the 4-of-5 post-sweep `bin/migrate-to-oss` migration CLI.

**The OpenClaw workarounds (HTTP-standalone, `render.mjs` direct) do
not reach the cloud backend.** They render only — no storage, no
migration, no pin/get/list/search/delete. To use v0.3.0 cloud storage
from inside OpenClaw, you must run the actual `@acer_09/mermaid-tui-mcp` process
(Workaround 1 plus a paired MCP-capable agent that drives the 7 stdio
tools), or wait for native MCP support (Workaround 3).

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
stderr and exits 1.

## Recommendation

If you have a choice of agent and want the polished experience, use gsd-pi, Claude Code, opencode, or Hermes — all of which have working MCP client support today. OpenClaw is best reserved for tasks that don't need MCP yet.
