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

## Recommendation

If you have a choice of agent and want the polished experience, use gsd-pi, Claude Code, opencode, or Hermes — all of which have working MCP client support today. OpenClaw is best reserved for tasks that don't need MCP yet.
