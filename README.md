# mermaid-tui-mcp

> A local Model Context Protocol (MCP) server that lets any coding agent render Mermaid diagrams into the terminal command box.
> The LLM calls `render_mermaid` instead of emitting a raw `​```mermaid` block. You get ASCII art inline plus a clickable link to the rendered diagram in a browser.

```
┌─ gsd-pi / Claude Code / opencode / Hermes ────────────────┐
│   Agent receives a user prompt that needs a diagram       │
│   LLM calls render_mermaid({code: "graph TD\n  A-->B"})   │
└──────────────────────────────┬───────────────────────────┘
                               │ stdio JSON-RPC
                               ▼
┌─ mermaid-tui-mcp (this server, child process) ───────────┐
│   1. mermaid 11 + jsdom  → real SVG                       │
│   2. mermaid-ascii       → terminal-safe ASCII            │
│   3. write data/blobs/<id>.{svg,html}                     │
│   4. return { id, ascii, fileLink, httpLink }            │
└──────────────────────────────────────────────────────────┘
                               │
                               ▼
   TUI command box shows ASCII art + clickable browser link
```

## Why

The TUI command box cannot render Mermaid natively. Without this server, an LLM that wants to show you a diagram has to emit a `​```mermaid` code block, which appears as raw source in the TUI. The user has to mentally parse the syntax — not great.

`mermaid-tui-mcp` solves this with a single tool: the LLM calls `render_mermaid(code)` and gets back ASCII art + a link. The LLM pastes the ASCII into the reply (so the user sees the diagram immediately) and prints the link (so the user can open a real, fully-rendered diagram in their browser if they want).

## Features

- **One tool.** `render_mermaid({code})` returns `{id, ascii, fileLink, httpLink}`. No tool explosion.
- **Local-only.** No network calls, no external services, no data leaving the host. Works fully offline.
- **Self-contained viewer.** Each render produces `data/blobs/<id>.html` that opens in any browser at `file://` — no running server needed for the basic case.
- **Optional HTTP daemon.** Start it for the pin/long-term-storage flow and for `http://127.0.0.1:5300/view?id=...` links.
- **7-day TTL + pin.** Diagrams are auto-cleaned after 7 days; pin ones you want to keep.
- **Full mermaid 11 syntax.** flowchart, sequence, class, state, gantt, er, pie, journey — anything mermaid renders, this renders. ASCII fallback is best-effort via `mermaid-ascii`; the HTML viewer is always canonical.
- **Multi-agent.** Drop-in integration for gsd-pi, Claude Code, opencode, Hermes. See `docs/integration/`.

## Quick start

### 1. Install

```bash
git clone https://gitee.com/lhl/mermaid-tui-mcp
cd mermaid-tui-mcp
npm install
```

### 2. Add to your agent

Pick your agent and follow the corresponding doc:

| Agent | Doc | Config file |
|---|---|---|
| gsd-pi | [docs/integration/gsd-pi.md](docs/integration/gsd-pi.md) | `.gsd/mcp.json` |
| Claude Code | [docs/integration/claude-code.md](docs/integration/claude-code.md) | `.mcp.json` |
| opencode | [docs/integration/opencode.md](docs/integration/opencode.md) | `opencode.json` |
| Hermes | [docs/integration/hermes.md](docs/integration/hermes.md) | `~/.hermes/config.yaml` |
| OpenClaw | [docs/integration/openclaw.md](docs/integration/openclaw.md) | (no native MCP — workaround) |

### 3. (Optional) Start the HTTP daemon for browser links + pin

```bash
bash bin/start.sh        # git bash / WSL / macOS / Linux
# or
powershell -File bin/start.ps1   # Windows PowerShell
```

Stops the same way (`bin/stop.sh` / `bin/stop.ps1`).

Without this, the `fileLink` returned by `render_mermaid` still works (it points to a self-contained HTML file under `data/blobs/`). The `httpLink` will be `null`.

## How the LLM uses it

The tool description (delivered to the LLM via MCP) tells the model:

> ALWAYS call this tool before emitting a `​```mermaid` code fence in your reply. Use `ascii` in your reply (replacing the raw mermaid source). Print the `fileLink` so the user can open a fully-rendered version in a browser.

That's it. The model knows what to do. You don't need a custom system prompt.

## Layout

```
mermaid-tui-mcp/
├── src/
│   ├── server.mjs       # stdio MCP + optional HTTP, single process
│   ├── render.mjs       # mermaid 11 (jsdom) + mermaid-ascii
│   └── storage.mjs      # 7-day TTL, pin, JSON index, blob I/O
├── public/
│   └── view.html        # self-contained viewer (zoom / pan / pin / download)
├── bin/
│   ├── start.sh / start.ps1
│   └── stop.sh  / stop.ps1
├── docs/
│   ├── integration/     # one .md per supported agent
│   ├── architecture.md
│   ├── api.md
│   └── mcp-protocol.md
├── evals.xml            # 10 eval questions for the render_mermaid tool
├── package.json
├── LICENSE              # MIT
├── CONTRIBUTING.md
├── SECURITY.md
└── CHANGELOG.md
```

## Limits

- Mermaid source up to 200 KB per call.
- ASCII art is an approximation (mermaid-ascii). It is intended as a quick "what does this look like" preview in the TUI. For a faithful rendering, open the `fileLink` in a browser.
- The HTTP-standalone mode uses port 5300. If you need multiple daemons on one host, set `MERMAID_RENDERER_PORT` before `start.sh`.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm run dev          # auto-reload stdio MCP
npm run start:http   # HTTP-standalone for browser testing

# full round-trip via the official inspector
npx @modelcontextprotocol/inspector node src/server.mjs
```

## License

MIT — see [LICENSE](LICENSE).
