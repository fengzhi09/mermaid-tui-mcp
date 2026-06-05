# Architecture

## Why MCP stdio (not HTTP, not SSE, not stdio-only-server-libraries)?

| Transport | Pros | Cons | Verdict |
|---|---|---|---|
| **stdio MCP** | Zero port management; gsd-pi / Claude Code / opencode / Hermes all support it natively; automatic lifecycle (child exits when parent exits); no authentication story needed | Slower cold start per session (~1–2 s for jsdom + mermaid 11 init) | ✅ default |
| **HTTP (REST)** | One shared daemon across sessions; view page + pin in one process | Port conflicts when multiple sessions are open; needs start.sh dance; ad-hoc — not how agents integrate MCP | ⚠️ optional companion |
| **SSE** | Compatible with web clients | opencode has documented issues with SSE (SST/opencode#834); extra complexity for no gain | ❌ not used |
| **Library (npm import)** | Smallest possible surface | Forces every agent to add `mermaid-tui-mcp` to its own bundle; bypasses the MCP tool-discovery UX | ❌ not used |

The stdio path is the right default. HTTP-standalone is a one-line opt-in (`MERMAID_RENDERER_HTTP=1`) for users who want the browser view + pin to work.

## Process model

A single `node src/server.mjs` process serves both protocols when HTTP is enabled. They do not conflict because they use different OS resources:

- **stdio MCP** — JSON-RPC over the child's `stdin` / `stdout` / `stderr`. Stderr is reserved for our own logs (the MCP spec is explicit: never write to stdout outside the JSON-RPC stream).
- **HTTP standalone** — TCP listener on `127.0.0.1:5300`. Independent of stdio.

When HTTP is disabled (the default), the process only listens on stdio. No port is opened, no socket is bound.

## Data flow (one tool call)

```
   tool call                                  tool result
       │                                          ▲
       │ {"method":"tools/call",                  │ {"content":[{"type":"text",
       │  "params":{"name":"render_mermaid",      │   "text":"{\"id\":\"mabc123\",
       │           "arguments":{"code":"..."}}}    │   \"ascii\":\"┌───┐...\",...}}]}
       │                                          │
       ▼                                          │
   ┌──────────────────────────────────────────────────┐
   │ server.mjs  (StdioServerTransport handler)      │
   │  1. parse + validate code                       │
   │  2. await render(code)  ──────────────┐         │
   │  3. await storage.put(id, code, svg)  │         │
   │  4. await renderView()  ──┐           │         │
   │  5. write blobs/<id>.html  │           │         │
   │  6. return tool result     │           │         │
   └────────────────────────────┼───────────┼─────────┘
                                ▼           │
                       render.mjs             │
                       ┌──────────────┐       │
                       │ getMermaid() │       │
                       │  (cached)    │       │
                       └──────┬───────┘       │
                              ▼               │
                       mermaid.render(id,code)│
                              │               │
                              ▼               │
                       mermaidToAscii(code) ──┘
```

## Storage

```
data/
├── store.json              # index: id -> { code, createdAt, pinned, lastAccessedAt, sourceLength }
├── blobs/
│   ├── <id>.svg            # raw rendered SVG
│   └── <id>.html           # self-contained viewer (file:// safe)
├── server.pid              # HTTP-standalone pid (only in HTTP mode)
└── server.log              # HTTP-standalone log
```

- **Sweep policy:** `now - createdAt > 7d AND !pinned` ⇒ delete. Runs on `load()`, on every `put()`, and hourly.
- **Pin flag** survives the sweep. Cleared via `POST /pin?id=<id>&pin=false`.
- **`lastAccessedAt`** is updated on every `get()` / `pruneIfExpired()`. It is currently informational only — used to show "last viewed" in the viewer's `created` line.

## Storage backends

The 7 tool handlers never touch the filesystem or the network directly. They go through a `StorageBackend` interface (JSDoc typedefs in `src/storage/Backend.mjs`):

```
load() / save() / sweep() / put(id, code, svg, title) / getMetadata(id)
readSvg(id) / setPinned(id, bool) / remove(id) / list() / search(q)
stats() / pruneIfExpired() / root
```

`src/server.mjs` picks an implementation at boot from `MERMAID_RENDERER_BACKEND`:

| `BACKEND` | Impl | Source | Default? |
|---|---|---|---|
| `local` (default, unset) | `LocalFsStorage` | `src/storage/LocalFsStorage.mjs` | yes — 7-day TTL, JSON index, self-contained viewer in `data/blobs/` |
| `oss` | `OssStorage` | `src/storage/OssStorage.mjs` | opt-in — S3-compatible object store via `@aws-sdk/client-s3`; covers AWS S3, MinIO, Aliyun OSS in S3-compat mode |

The `oss` branch is a real factory (`OssStorageFromEnv(process.env, { counters, logger })`); missing/empty required env at boot causes `process.exit(1)` after a single-line JSON `oss_init_failed` stderr log. The same `StorageWriteError` (`-32004`) / `StorageReadError` (`-32005`) codes the local backend emits flow through the existing `/health.last_errors` + `counters.render_errors` observability surface, so the on-the-wire contract is identical regardless of backend — the env switch is the only seam.

## Why view.html is generated per-render, not a static template

Each `<id>.html` has the diagram's SVG inlined. That means the file is self-contained: open it with `file://` in any browser and the diagram renders immediately, even with no network and no running server. The `fileLink` returned by `render_mermaid` is the path to this file.

Cost: a few KB per render in `data/blobs/`. Benefit: zero infrastructure to view a diagram.

## Why ASCII is best-effort

`mermaid-ascii` does a great job on flowcharts but stumbles on class diagrams, state diagrams, and large sequence diagrams. The contract is:

- **For common cases**, the ASCII in the TUI is good enough to scan.
- **For everything else**, the `fileLink` / `httpLink` gives the user the canonical rendering.

We never fail the tool call on ASCII errors — a failed ASCII render is replaced with the source prefixed by an error line, and the SVG/HTML artifacts are still produced.
