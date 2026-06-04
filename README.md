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

- **7 stdio MCP tools.** Full CRUD on rendered diagrams: `render_mermaid`, `pin_mermaid`, `unpin_mermaid`, `get_diagram`, `list_diagrams`, `search_diagrams`, `delete_mermaid`. See the [tool table](#tools) below.
- **Local-only.** No network calls, no external services, no data leaving the host. Works fully offline.
- **Self-contained viewer.** Each render produces `data/blobs/<id>.html` that opens in any browser at `file://` — no running server needed for the basic case.
- **Optional HTTP daemon.** Start it for the pin/long-term-storage flow, the `/health` metrics endpoint, and for `http://127.0.0.1:5300/view?id=...` links. Auto-falls-back to ports 5301/5302 on conflict.
- **7-day TTL + pin.** Diagrams are auto-cleaned after 7 days; pin ones you want to keep.
- **Observability.** Single-line JSON logs to stderr; persistent counters in `data/counters.json`; `/health` returns metrics + last 5 errors. See [Troubleshooting](#troubleshooting).
- **Full mermaid 11 syntax.** flowchart, sequence, class, state, gantt, er, pie, journey — anything mermaid renders, this renders. ASCII fallback is best-effort via `mermaid-ascii`; the HTML viewer is always canonical.
- **Multi-agent.** Drop-in integration for gsd-pi, Claude Code, opencode, Hermes, OpenClaw (workaround). See `docs/integration/`.

## Tools

The server exposes 7 stdio MCP tools (v0.2.0 surface):

| Tool | Purpose | Output shape |
|------|---------|--------------|
| `render_mermaid({code, title?})` | Render a Mermaid diagram. `code` is required (≤200 KB); `title` is optional (≤200 chars). | `{id, ascii, fileLink, httpLink, title, elapsed_ms, warnings}` |
| `pin_mermaid({id})` | Protect a diagram from the 7-day sweep. | `{id, pinned: true, elapsed_ms}` |
| `unpin_mermaid({id})` | Remove pin protection. | `{id, pinned: false, elapsed_ms}` |
| `get_diagram({id})` | Fetch the full stored entry (code, title, pinned, timestamps). | `{id, code, title, pinned, createdAt, ttlDays, ...}` |
| `list_diagrams({limit?, cursor?})` | Paginated list of stored diagrams (newest first; each item carries `id`). | `{items: [{id, title, pinned, ...}], nextCursor}` |
| `search_diagrams({query, limit?})` | Substring match on title (boosted) and code. | `{items: [{id, title, score, ...}], nextCursor}` |
| `delete_mermaid({id})` | Explicit remove (entry + blob). | `{id, deleted: true, elapsed_ms}` |

The LLM still calls `render_mermaid` first for any new diagram; the other 6 tools cover the full CRUD lifecycle after that.

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
│   ├── server.mjs              # stdio MCP + optional HTTP, single process
│   ├── tools.mjs               # 7 stdio MCP tool handlers (R020 envelope)
│   ├── render.mjs              # mermaid 11 (jsdom) + mermaid-ascii
│   ├── helpers.mjs             # shared helpers (escapeHtml, fileUrlFor, log re-export)
│   ├── logger.mjs              # single-line JSON stderr logging (R008)
│   ├── counters.mjs            # persistent counters (data/counters.json, R010)
│   ├── errors.mjs              # -32001..-32009 + -32602 error code set (R020)
│   ├── health-state.mjs        # 5-error ring + last_render_ms (R009)
│   ├── port-fallback.mjs       # tryListen EADDRINUSE fallback (R016)
│   └── storage/
│       ├── Backend.mjs         # StorageBackend interface (JSDoc typedefs)
│       └── LocalFsStorage.mjs  # default impl: 7-day TTL, pin, JSON index
├── public/
│   └── view.html               # self-contained viewer (zoom / pan / pin / download)
├── bin/
│   ├── start.sh / start.ps1
│   └── stop.sh  / stop.ps1
├── tests/
│   ├── unit/                   # 16 unit test files
│   ├── integration/            # stdio MCP + HTTP integration tests
│   ├── evals/                  # 10 eval tests (R027)
│   └── helpers/                # shared fixtures (server, storage, render)
├── docs/
│   ├── integration/            # one .md per supported agent (5 files)
│   ├── architecture.md
│   ├── api.md
│   └── mcp-protocol.md
├── evals.xml                   # 10 eval questions for the 7-tool surface
├── .github/workflows/ci.yml    # Node 22 + Node 24 matrix, coverage gate
├── package.json
├── LICENSE                     # MIT
├── CONTRIBUTING.md
├── SECURITY.md
└── CHANGELOG.md
```

## Troubleshooting

Errors come back with a stable JSON envelope: `{code, message, retryable, elapsed_ms}`. Codes are unique across the namespace (no collision with MCP transport -32000/-32001).

| Code | Name | Retryable | Meaning | Client action |
|------|------|-----------|---------|---------------|
| -32602 | invalid_params | false | Empty / oversized / malformed input. | Fix the input; do not retry. |
| -32603 | internal_error | false | Unhandled exception. | Report; capture stderr JSON for diagnosis. |
| -32001 | render_timeout | true | 10 s render timeout (R015). | Wait briefly, retry once. If persistent, try a smaller diagram. |
| -32002 | render_failed | false | Mermaid parse error. | Fix the diagram source. |
| -32003 | jsdom_init_failed | true | jsdom + mermaid init retry exhausted (R018). | Wait briefly, retry once. |
| -32004 | storage_write_failed | true | Terminal EIO/ENOSPC, or EAGAIN retry exhausted (R017). | Check disk space / permissions, then retry. |
| -32005 | not_found | false | `get_diagram` / `pin_mermaid` / `delete_mermaid` for an unknown id. | Don't retry; the id is gone. |
| -32005 | storage_read_failed | true | 5 s read timeout (R005). | Wait briefly, retry once. |
| -32008 | port_in_use | true | HTTP port 5300/5301/5302 all occupied (R016). | Stop the conflicting process, or set `MERMAID_RENDERER_PORT`. |
| -32009 | mcp_protocol_violation | false | Malformed JSON-RPC from the client. | Fix the wire format. |

For the full wire contract, see `docs/mcp-protocol.md`. For runtime health (counters, last 5 errors, last render ms), curl `GET /health` on the HTTP daemon.

## Limits

- Mermaid source up to 200 KB per call.
- ASCII art is an approximation (mermaid-ascii). It is intended as a quick "what does this look like" preview in the TUI. For a faithful rendering, open the `fileLink` in a browser.
- The HTTP-standalone mode tries ports 5300 → 5301 → 5302 (R016). To bind a specific port, set `MERMAID_RENDERER_PORT` before `start.sh`.
- 5,000 diagrams in the store triggers the hourly sweep; pinned diagrams are exempt.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm run dev          # auto-reload stdio MCP
npm run start:http   # HTTP-standalone for browser testing

# full round-trip via the official inspector
npx @modelcontextprotocol/inspector node src/server.mjs
```

## Testing

Run the test suite with `npm test`. Get a coverage report with `npm run test:coverage` (target: **≥80% lines**, enforced by `vitest.config.mjs`).

The harness is split into three layers, each in its own folder under `tests/`:

- **Unit tests** (`tests/unit/`) — pure modules in isolation: `logger.mjs`, `counters.mjs`, `errors.mjs`, `health-state.mjs`, `port-fallback.mjs`, `helpers.mjs`, `render.mjs`, `LocalFsStorage.mjs`, `tools.mjs`. Fast, no child process, no network.
- **Integration tests** (`tests/integration/`) — spawn the real `src/server.mjs` as a child process and drive it over stdio JSON-RPC (the MCP transport) and the local HTTP routes (`/health`, `/raw/svg`, `/pin`, `/view`). The helper at `tests/helpers/server.mjs` re-implements the JSON-RPC driver from `scripts/smoke.sh` in JS so the suite stays parallelizable.
- **Eval tests** (`tests/evals/`) — one file per entry in `evals.xml` (`eval-01` … `eval-10`). Each test asserts the contract declared in the corresponding `<expected>` block. **10/10 pass** on the v0.2.0 surface (R027 gate). `eval-09` covers `pin_mermaid`; `eval-10` covers the `fileLink` round-trip.
- **Real-client integration smoke** (`tests/integration/real-client-smoke/`, S04) — drives the server through two real MCP clients (Claude Code + gsd-pi) and saves transcripts as `.log` proof artifacts. Best-effort: skips on missing auth with a warning, never fails the suite. See [docs/integration/](docs/integration/) for the user-facing client docs and the smoke logs for the wire-level transcripts.
- **CI** — every push and pull request to `main` / `master` / `milestone/*` runs `npm test` on **Node 22 and Node 24** in parallel via `.github/workflows/ci.yml`. The coverage threshold is enforced on the Node 24 leg, and the `coverage/` directory is uploaded as a workflow artifact.

Shared fixtures live in `tests/helpers/` (`storage-fixture.mjs`, `render-fixture.mjs`, `server.mjs`) and are imported by the integration and eval tests.

**Baseline:** 23 test files, 175/175 tests passing, ~30 s on a single thread.

## License

MIT — see [LICENSE](LICENSE).
