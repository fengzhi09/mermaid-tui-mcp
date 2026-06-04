# Integrating mermaid-tui-mcp with OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) (as of mid-2026) does **not have native MCP client support**. Tracking issue: [openclaw/openclaw#29053](https://github.com/openclaw/openclaw/issues/29053). There are a few workarounds.

## Workaround 1: HTTP transport

Run this server in HTTP-standalone mode (see [docs/architecture.md](../architecture.md)) and call it from OpenClaw via `exec` + `curl`:

```bash
# In one shell:
bash /path/to/mermaid-tui-mcp/bin/start.sh

# In OpenClaw, ask the LLM to:
# 1. build the JSON body: {"code": "graph TD\n  A-->B"}
# 2. POST it to http://127.0.0.1:5300/... (note: HTTP mode does NOT expose
#    a render endpoint — only /view, /raw/svg, /pin, /health. See below.)
```

**Caveat:** The HTTP-standalone mode does not expose a render endpoint by design. The MCP tool is the only render path. So this workaround only works if you ALSO have an MCP-compatible client (e.g. Claude Code, gsd-pi) running alongside OpenClaw and you can ask it to render on OpenClaw's behalf.

## Workaround 2: Call `node` directly (no MCP, no HTTP)

OpenClaw's `exec` tool can run a small Node script that:

1. Spawns `node src/render.mjs` to produce SVG + ASCII.
2. Returns the output to OpenClaw.

`render.mjs` is the internal API the MCP server uses — its top-level export is `render(code)`. Use it like this:

```js
// scripts/render-once.mjs (place this in your project, not in mermaid-tui-mcp)
import { render } from "/path/to/mermaid-tui-mcp/src/render.mjs";

const code = process.argv[2];
if (!code) {
  console.error("usage: node render-once.mjs <mermaid-source>");
  process.exit(2);
}
const { ascii, svg } = await render(code);
process.stdout.write(ascii);
```

Then in OpenClaw:

```bash
node /path/to/scripts/render-once.mjs 'graph TD\n  A-->B'
```

This is fragile (no 7-day storage, no pin, no HTTP viewer) but it unblocks the basic use case while waiting for native MCP support in OpenClaw.

## Workaround 3: Wait for native MCP

Star and watch [openclaw/openclaw#29053](https://github.com/openclaw/openclaw/issues/29053). When native support lands, follow the gsd-pi / Claude Code / opencode / Hermes integration docs (one block in `~/.openclaw/config.*` or similar — TBD when the feature ships).

## v0.2.0 tool set & stdio-only tools (important for OpenClaw workarounds)

The `mermaid` server exposes **7 stdio MCP tools** (v0.2.0 surface): `render_mermaid`, `pin_mermaid`, `unpin_mermaid`, `get_diagram`, `list_diagrams`, `search_diagrams`, `delete_mermaid`.

**6 of the 7 tools are stdio-MCP-only** and have no HTTP or CLI surface: `pin_mermaid`, `unpin_mermaid`, `get_diagram`, `list_diagrams`, `search_diagrams`, `delete_mermaid`. Only `render_mermaid` is reachable through the workaround paths above (`node src/render.mjs` direct call, or the HTTP `/raw/svg` / `/view` / `/pin` endpoints for the post-render file/pin side effects).

**Practical implication for OpenClaw:**

- Workaround 1 (HTTP-standalone) and Workaround 2 (`node src/render.mjs` direct) give you **rendering only**. Pinning, listing, searching, getting metadata, and explicit deletion are not reachable from OpenClaw in v0.2.0.
- If you need the full 7-tool CRUD lifecycle from inside OpenClaw, you must either wait for native MCP (Workaround 3) or pair OpenClaw with a second MCP-capable agent (Claude Code, gsd-pi, opencode, Hermes) and have that agent run the CRUD tools on OpenClaw's behalf.

## Recommendation

If you have a choice of agent and want the polished experience, use gsd-pi, Claude Code, opencode, or Hermes — all of which have working MCP client support today. OpenClaw is best reserved for tasks that don't need MCP yet.
