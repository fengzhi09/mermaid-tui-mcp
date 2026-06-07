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

### 1. Add to your agent

The server is distributed as the [`mermaid-tui-mcp`](https://www.npmjs.com/package/mermaid-tui-mcp) npm package — there is nothing to install first. `npx` resolves the package from the npm registry on first use and caches it. Pick your agent:

| Agent | Doc | Config file |
|---|---|---|
| gsd-pi | [docs/integration/gsd-pi.md](docs/integration/gsd-pi.md) | `.gsd/mcp.json` |
| Claude Code | [docs/integration/claude-code.md](docs/integration/claude-code.md) | `.mcp.json` |
| opencode | [docs/integration/opencode.md](docs/integration/opencode.md) | `opencode.json` |
| Hermes | [docs/integration/hermes.md](docs/integration/hermes.md) | `~/.hermes/config.yaml` |
| OpenClaw | [docs/integration/openclaw.md](docs/integration/openclaw.md) | (no native MCP — workaround) |

All five docs use the same `npx -y mermaid-tui-mcp` form — no absolute paths, no local clone, no per-platform quoting.

### 2. (Optional) Start the HTTP daemon for browser links + pin

```bash
MERMAID_RENDERER_HTTP=1 npx -y mermaid-tui-mcp
```

The same `mermaid-tui-mcp` binary serves both the stdio MCP and the optional HTTP daemon. The HTTP mode binds `http://127.0.0.1:5300` and exposes `/view`, `/raw/svg`, `/pin`, `/health`. Stop with `Ctrl-C`.

For a managed background daemon (PID file + log file + health-check poll), a bash helper ships in the npm package at `node_modules/mermaid-tui-mcp/bin/start.sh` — but the inline `npx` command above is what most people want.

Without the HTTP daemon, the `fileLink` returned by `render_mermaid` still works (it points to a self-contained HTML file under the package's `data/blobs/`). The `httpLink` will be `null`.

### 4. (Optional) Use cloud storage (OssStorage)

By default, diagrams are stored on the local filesystem under `data/`. To route all 7 stdio MCP tools to a S3-compatible object store instead, set `MERMAID_RENDERER_BACKEND=oss` plus the 5 required `MERMAID_OSS_*` env vars (see [Configuration](#configuration) below). The easiest way to try it locally is MinIO in Docker:

```bash
docker run -d --name minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  quay.io/minio/minio server /data --console-address :9001

export MERMAID_RENDERER_BACKEND=oss
export MERMAID_OSS_ENDPOINT=http://127.0.0.1:9000
export MERMAID_OSS_REGION=us-east-1
export MERMAID_OSS_ACCESS_KEY_ID=minioadmin
export MERMAID_OSS_SECRET_ACCESS_KEY=minioadmin
export MERMAID_OSS_BUCKET=mermaid
```

Browse the bucket at `http://127.0.0.1:9001` (login `minioadmin` / `minioadmin`). The 7 tool handlers are unchanged — the env switch is the only seam. AWS S3 and Aliyun OSS in S3-compat mode work the same way; only `MERMAID_OSS_ENDPOINT` / `MERMAID_OSS_REGION` / `MERMAID_OSS_ACCESS_KEY_ID` / `MERMAID_OSS_SECRET_ACCESS_KEY` differ.

### Migrating from local to cloud

Already have diagrams in a v0.2.0 `data/` dir? Run `node bin/migrate-to-oss.mjs` once to copy them to your configured bucket. The migration is **idempotent** (safe to re-run — a re-run is a no-op when the bucket is already populated), **dry-run-able** (`--dry-run` reports what would be copied without writing), and exits `1` only on missing `MERMAID_OSS_*` env vars (the env-validation error lists the 5 required var names in the stable order). On success the bucket ends up with the **post-sweep state** of the source: an `expired-and-unpinned` entry is dropped by the source's TTL sweep on `load()` before the migration sees the store, so a v0.2.0 source with 5 entries (3 fresh+pinned, 1 expired-but-pinned, 1 expired-and-unpinned) yields 4 entries in the bucket. `createdAt` / `title` / `pinned` are preserved byte-equal; the migration re-stamps `createdAt` to the source's age so the 7-day TTL is identical after migration.

```bash
# Source = local data dir (default: $MERMAID_RENDERER_DATA, or <repo>/data);
# target = the S3-compatible bucket configured by MERMAID_OSS_*.
node bin/migrate-to-oss.mjs

# Or: explicit source dir (overrides MERMAID_RENDERER_DATA for this run).
node bin/migrate-to-oss.mjs --source-dir /var/lib/mermaid-tui-mcp/data

# Or: dry-run first — emits the same 6 events, writes 0 entries.
node bin/migrate-to-oss.mjs --dry-run
```

The CLI emits 6 structured stderr JSON events (`migrate_start`, `migrate_copy` / `migrate_skip` / `migrate_dry_run` per entry, `migrate_read_failed` on per-entry read errors, and the final `migrate_done` event). The final `migrate_done` event carries `{copied, skipped, readFailed, dryRun, source, target}` where `source` / `target` are `storage.stats()` snapshots (`{total, pinned, unpinned}`) — operators can diff them to confirm a re-run is a no-op (`source == target` and `copied == 0` on the second run). Stdout is reserved for the human summary line (`Migration complete: copied=N skipped=M (source {...} → target {...})`), matching the project's stdio-MCP-server convention (R008 — stderr is the structured event stream). Exit codes: `0` success (copy or dry-run), `1` env-missing, `2` malformed argv. See `tests/integration/migrate-to-oss-proofs/migrate-dry-run.txt` for the canonical output shape.

## Configuration

All knobs are environment variables, set in the shell that runs `node src/server.mjs`. None of them are required — the defaults give you a fully-working local install.

### General

| Variable | Default | Purpose |
|---|---|---|
| `MERMAID_RENDERER_DATA` | `<repo>/data` | Root directory for `store.json`, `blobs/`, `counters.json`. |
| `MERMAID_RENDERER_HTTP` | unset | Set to `1` to also expose the HTTP routes (`/health`, `/view`, `/raw/svg`, `/pin`). |
| `MERMAID_RENDERER_HOST` | `127.0.0.1` | Bind address for the HTTP daemon. |
| `MERMAID_RENDERER_PORT` | `5300` | First port tried; falls back to 5301, 5302 (R016). |
| `MERMAID_RENDERER_BACKEND` | `local` | `local` = `LocalFsStorage` (default). `oss` = `OssStorage` over S3-compatible object storage. |

### Cloud storage (OssStorage)

Setting `MERMAID_RENDERER_BACKEND=oss` routes all 7 stdio MCP tools to a S3-compatible object store (AWS S3, MinIO, Aliyun OSS in S3-compat mode) via `@aws-sdk/client-s3`. The 7 tool handlers and the `LocalFsStorage` default impl are unchanged — the env switch is the only seam. See M002/S01 + M002/S03 for the cloud integration story.

| Variable | Required | Default | Example |
|---|---|---|---|
| `MERMAID_OSS_ENDPOINT` | yes (when `BACKEND=oss`) | — | `http://127.0.0.1:9000` (MinIO), `https://s3.us-east-1.amazonaws.com` (AWS) |
| `MERMAID_OSS_REGION` | yes (when `BACKEND=oss`) | — | `us-east-1`, `cn-hangzhou` |
| `MERMAID_OSS_ACCESS_KEY_ID` | yes (when `BACKEND=oss`) | — | `minioadmin` |
| `MERMAID_OSS_SECRET_ACCESS_KEY` | yes (when `BACKEND=oss`) | — | `minioadmin` |
| `MERMAID_OSS_BUCKET` | yes (when `BACKEND=oss`) | — | `mermaid` |
| `MERMAID_OSS_PREFIX` | no | `""` (root) | `team-a/` (share a bucket across instances) |
| `MERMAID_OSS_FORCE_PATH_STYLE` | no | `true` | `0` / `false` / `no` to opt out (only needed for virtual-hosted–style endpoints) |

On missing/empty required env at boot, the server **does not exit**. It logs a single-line JSON `oss_init_degraded` (level=warn, with the missing-var list and `code: -32006`), bumps the persistent `oss_init_degraded_count` counter in `data/counters.json`, falls back to a `LocalFsStorage` on the local filesystem, and continues serving all 7 stdio MCP tools. This is the D017 (optional integration failure must not block the main flow) contract — OSS is opt-in, not on the critical path. The runtime also wraps `OssStorage` in a `DegradableStorage` circuit-breaker: if 3 consecutive runtime calls fail (default `MERMAID_DEGRADE_THRESHOLD=3`, cool-down `MERMAID_DEGRADE_HALF_OPEN_AFTER_MS=60000`), the wrapper trips the breaker to `open`, emits `breaker_open` (warn) + bumps `breaker_trips_count`, and routes all subsequent calls to the local fallback for the cool-down window. On a successful half-open probe past the window, `breaker_close` (info) is logged. `/health` exposes `backend` (`local` | `oss` | `degraded`), `last_oss_failure` ({ts, code, msg} | null), `boot_degraded` (boolean), the breaker sub-state (`storage: {degraded, breaker_state, consecutive_failures, …}`), and the two new counters. The same `StorageWriteError` (`-32004`) / `StorageReadError` (`-32005`) codes the local backend emits flow through the existing observability surface (`/health.last_errors`, `counters.render_errors`). Non-`OssEnvInvalidError` initialization failures (real disk errors, factory crashes) still call `process.exit(1)` — they are fatal, not optional. See [docs/architecture.md](docs/architecture.md#optional-integration-degradation) for the full architecture.

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
│   ├── start.sh / start.ps1      # managed background HTTP daemon
│   ├── stop.sh  / stop.ps1
│   └── migrate-to-oss.mjs         # v0.2.0 → v0.3.0 one-shot Local→OSS migration CLI
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

## Optional integration failure modes

OSS (cloud storage) and the optional HTTP daemon are both **D017-class** integrations: they add capability but are not on the critical path of the 7 stdio MCP tools. An integration failure (boot misconfiguration, runtime error, or environment conflict) must never block the main flow — stdio MCP stays up regardless. The project materialises that contract through three independent degradation paths:

| # | Path | Trigger | What the operator sees |
|---|---|---|---|
| 1 | **Boot env missing** | `BACKEND=oss` + ≥1 of the 5 `MERMAID_OSS_*` vars empty/absent | stderr `oss_init_degraded` (warn, code `-32006`) + `data/counters.json: oss_init_degraded_count` + `/health: backend="degraded"`, `boot_degraded=true`, `last_oss_failure={ts, code, msg}`. All 7 tools work via local fallback. |
| 2 | **HTTP port taken** | `MERMAID_RENDERER_HTTP=1` + 5300/5301/5302 all in use | stderr `http_listen_failed_fallback` (warn). stdio MCP tools stay up; HTTP routes (`/view`, `/pin`, `/raw/svg`, `/health`) are not bound. |
| 3 | **Runtime OSS failure** | A tool call hits `OssStorage` and throws (timeout, 5xx, ENOTFOUND) | After 3 consecutive failures (configurable via `MERMAID_DEGRADE_THRESHOLD`), stderr `breaker_open` (warn) + `data/counters.json: breaker_trips_count` + `/health: backend="degraded"`, `storage: {degraded: true, breaker_state: "open", …}`. All subsequent calls route to local for the 60s cool-down (configurable via `MERMAID_DEGRADE_HALF_OPEN_AFTER_MS`). On the next successful probe, stderr `breaker_close` (info). |

These signals are the canonical observability surface — no manual file inspection needed. See [docs/architecture.md](docs/architecture.md#optional-integration-degradation) for the full architecture, the `DegradableStorage` wrapper's `_tryAsync` driver, and the rationale for using a circuit-breaker instead of naive `try/catch` per request.

## Limits

- Mermaid source up to 200 KB per call.
- ASCII art is an approximation (mermaid-ascii). It is intended as a quick "what does this look like" preview in the TUI. For a faithful rendering, open the `fileLink` in a browser.
- The HTTP-standalone mode tries ports 5300 → 5301 → 5302 (R016). To bind a specific port, set `MERMAID_RENDERER_PORT` before `start.sh`.
- 5,000 diagrams in the store triggers the hourly sweep; pinned diagrams are exempt.

## Development

For contributors (modifying the source, running the test suite locally, opening a PR):

```bash
git clone https://gitee.com/lhl/mermaid-tui-mcp
cd mermaid-tui-mcp
npm install
npm run dev          # auto-reload stdio MCP
npm run start:http   # HTTP-standalone for browser testing

# full round-trip via the official inspector
npx @modelcontextprotocol/inspector node src/server.mjs
```

For a local checkout that should be reachable as `npx mermaid-tui-mcp` (useful for testing integration docs against a local build), link it globally:

```bash
npm link              # in the checkout
npm link mermaid-tui-mcp   # in any other project (or just use it globally)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide.

## Testing

Run the test suite with `npm test`. Get a coverage report with `npm run test:coverage` (target: **≥80% lines**, enforced by `vitest.config.mjs`).

The harness is split into three layers, each in its own folder under `tests/`:

- **Unit tests** (`tests/unit/`) — pure modules in isolation: `logger.mjs`, `counters.mjs`, `errors.mjs`, `health-state.mjs`, `port-fallback.mjs`, `helpers.mjs`, `render.mjs`, `LocalFsStorage.mjs`, `tools.mjs`. Fast, no child process, no network.
- **Integration tests** (`tests/integration/`) — spawn the real `src/server.mjs` as a child process and drive it over stdio JSON-RPC (the MCP transport) and the local HTTP routes (`/health`, `/raw/svg`, `/pin`, `/view`). The helper at `tests/helpers/server.mjs` re-implements the JSON-RPC driver from `scripts/smoke.sh` in JS so the suite stays parallelizable.
- **Eval tests** (`tests/evals/`) — one file per entry in `evals.xml` (`eval-01` … `eval-10`). Each test asserts the contract declared in the corresponding `<expected>` block. **10/10 pass** on the v0.2.0 surface (R027 gate). `eval-09` covers `pin_mermaid`; `eval-10` covers the `fileLink` round-trip.
- **Real-client integration smoke** (`tests/integration/real-client-smoke/`, S04) — drives the server through two real MCP clients (Claude Code + gsd-pi) and saves transcripts as `.log` proof artifacts. Best-effort: skips on missing auth with a warning, never fails the suite. See [docs/integration/](docs/integration/) for the user-facing client docs and the smoke logs for the wire-level transcripts.
- **CI** — every push and pull request to `main` / `master` / `milestone/*` runs `npm test` on **Node 22 and Node 24** in parallel via `.github/workflows/ci.yml`. The coverage threshold is enforced on the Node 24 leg, and the `coverage/` directory is uploaded as a workflow artifact.

Shared fixtures live in `tests/helpers/` (`storage-fixture.mjs`, `render-fixture.mjs`, `server.mjs`) and are imported by the integration and eval tests.

**Baseline (v0.3.0, M003/S03):** 31 test files (5 OSS-endpoint tests skip when `MERMAID_OSS_ENDPOINT` is unset), 286/286 tests passing + 36 skipped, ~12 s on a single thread.

## License

MIT — see [LICENSE](LICENSE).
