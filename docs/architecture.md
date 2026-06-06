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

The `oss` branch is a real factory (`OssStorageFromEnv(process.env, { counters, logger })`); missing/empty required env at boot does **not** exit — `server.mjs` catches `OssEnvInvalidError`, logs a single-line JSON `oss_init_degraded` (level=warn) with the missing-var list + `code: -32006`, bumps the persistent `oss_init_degraded_count` counter, and falls back to `LocalFsStorage` so the 7 stdio MCP tools keep working. Non-`OssEnvInvalidError` initialization failures (real disk errors, factory crashes) still call `process.exit(1)` — they are fatal, not optional. The same `StorageWriteError` (`-32004`) / `StorageReadError` (`-32005`) codes the local backend emits flow through the existing `/health.last_errors` + `counters.render_errors` observability surface, so the on-the-wire contract is identical regardless of backend — the env switch is the only seam. The full degradation model — boot + runtime + port-fallback — is described in [Optional integration degradation](#optional-integration-degradation) below.

## Why view.html is generated per-render, not a static template

Each `<id>.html` has the diagram's SVG inlined. That means the file is self-contained: open it with `file://` in any browser and the diagram renders immediately, even with no network and no running server. The `fileLink` returned by `render_mermaid` is the path to this file.

Cost: a few KB per render in `data/blobs/`. Benefit: zero infrastructure to view a diagram.

## Why ASCII is best-effort

`mermaid-ascii` does a great job on flowcharts but stumbles on class diagrams, state diagrams, and large sequence diagrams. The contract is:

- **For common cases**, the ASCII in the TUI is good enough to scan.
- **For everything else**, the `fileLink` / `httpLink` gives the user the canonical rendering.

We never fail the tool call on ASCII errors — a failed ASCII render is replaced with the source prefixed by an error line, and the SVG/HTML artifacts are still produced.

## Optional integration degradation

M002 (cloud storage) and the optional HTTP daemon are both **D017-class** integrations: they add capability but are not on the critical path of the 7 stdio MCP tools. Per D017, an integration failure (boot misconfiguration, runtime error, or environment conflict) must never block the main flow — the stdio MCP surface stays available regardless. The project materialises that contract through three independent degradation paths, each with its own observability signal so operators can see what happened without reading the source.

### Architecture: the `DegradableStorage` wrapper

The runtime part of the contract is a thin wrapper at `src/storage/DegradableStorage.mjs` that implements the `StorageBackend` interface (JSDoc typedefs in `src/storage/Backend.mjs`) on top of two backends: a `primary` (typically `OssStorage`, the optional cloud backend) and a `fallback` (always `LocalFsStorage`, the on-disk default). It drives the `primary.breaker` state machine that S03 T02 installed on `OssStorage` (D017 circuit-breaker). The wrapper is constructed only when `MERMAID_RENDERER_BACKEND=oss` and the env is valid; if the env is invalid, the boot path in `server.mjs` skips the wrapper entirely and uses a bare `LocalFsStorage` (with `oss_init_degraded` logged).

```
   tools.mjs (render_mermaid / pin / list / …)
                        │
                        ▼
   server.mjs  ctx.storage   (StorageBackend interface)
                        │
        ┌───────────────┴───────────────┐
        │ DegradableStorage (S03 T03)   │  when BACKEND=oss + env valid
        │   single source of truth:    │
        │   primary.breaker            │
        │                               │
        │   _tryAsync(op, args)        │
        │     ├─ primary.canAttempt()  │── no ──▶ fallback[op]()
        │     └─ yes: try primary ─────┼── ok ──▶ primary.recordSuccess()
        │              │ (throws)      │           (wasOpen? → breaker_close)
        │              ▼               │
        │     primary.recordFailure()  │
        │     opened? → breaker_open   │
        │              │               │
        │              ▼               │
        │          fallback[op]()      │
        └───────────────┬───────────────┘
                        │
              ┌─────────┴──────────┐
              ▼                    ▼
   OssStorage (primary)    LocalFsStorage (fallback)
   src/storage/OssStorage    src/storage/LocalFsStorage
   S3-compatible object      on-disk default (data/)
   store via @aws-sdk/
   client-s3 (D016)
```

The `DegradableStorage` wrapper never keeps its own `degraded` or `failureCount` state — `primary.breaker` is the single source of truth, and the wrapper only drives the transitions. A future where `primary` is swapped for a different cloud backend (e.g. GCS, Azure Blob) needs the new backend to expose the same `breaker` + `canAttempt` + `recordFailure` + `recordSuccess` interface; the constructor's type-guard enforces this at boot.

### Three degradation paths

| # | Path | Trigger | Behaviour | Recovery |
|---|---|---|---|---|
| 1 | **Boot env missing** | `BACKEND=oss` + ≥1 of the 5 `MERMAID_OSS_*` env vars empty/absent | `server.mjs` catches `OssEnvInvalidError`, emits `oss_init_degraded` (warn), bumps `oss_init_degraded_count`, falls back to a bare `LocalFsStorage`. Server stays up. | Fix the env vars and restart; the `oss_init_degraded_count` counter persists in `data/counters.json` across restarts. |
| 2 | **HTTP port taken** | `MERMAID_RENDERER_HTTP=1` + ports 5300/5301/5302 all in use | `port-fallback.mjs` exhausts the R016 fallback list; `server.mjs` logs `http_listen_failed_fallback` (warn) and flips `httpEnabled=false`. stdio MCP tools stay up; HTTP routes (`/view`, `/pin`, `/raw/svg`, `/health`) are not bound. | Stop the conflicting process or set `MERMAID_RENDERER_PORT`; no operator data lost. |
| 3 | **Runtime OSS failure** | A tool call hits the wrapped `OssStorage` and the call throws (timeout, 5xx, ENOTFOUND, etc.) | `DegradableStorage._tryAsync` records the failure on `primary.breaker`. After **N=3** consecutive failures (configurable via `MERMAID_DEGRADE_THRESHOLD`), the breaker trips to `open`; the wrapper emits `breaker_open` (warn) + bumps `breaker_trips_count`. All subsequent calls route to `LocalFsStorage` for the cool-down window (default 60s, configurable via `MERMAID_DEGRADE_HALF_OPEN_AFTER_MS`). | After the cool-down, the next call is allowed to probe `OssStorage`; on success, the breaker closes and `breaker_close` (info) is logged. |

Path 1 and path 3 are S03 additions; path 2 was already D017 in M001.

### Operator signals

Each path emits a distinct surface so log shippers and dashboards can tell them apart:

| Surface | Path 1 (boot env) | Path 2 (port) | Path 3 (runtime) |
|---|---|---|---|
| **Stderr event** | `oss_init_degraded` (level=warn) | `http_listen_failed_fallback` (level=warn) | `breaker_open` (level=warn) → `breaker_close` (level=info) on recovery |
| **`/health` field** | `backend: "degraded"` + `boot_degraded: true` + `last_oss_failure: {ts, code: -32006, msg}` | `/health` route not bound | `backend: "degraded"` + `storage: {degraded: true, breaker_state: "open", consecutive_failures, opened_at, last_failure, primary_root, fallback_root}` |
| **Persistent counter** | `oss_init_degraded_count` (in `data/counters.json`) | — | `breaker_trips_count` (in `data/counters.json`) |

`/health` resolution priority for the `backend` field is documented inline in `src/server.mjs`: boot-degraded wins over the breaker's runtime state, because the boot failure is the operator's strongest signal (they configured OSS expecting it to work). A separate runtime trip on a previously-clean boot surfaces as `"degraded"` via the `DegradableStorage.health()` branch.

### Why not just `try/catch` and a single fallback?

A naive `try { return await oss.put(...) } catch { return await local.put(...) }` would work for a single request, but on a flaky network it would block every `render_mermaid` call for 5s+ waiting for the S3 timeout before falling back. With 10 parallel calls, that's 10× the latency. The circuit-breaker solves the **congestion-collapse** problem: after N consecutive failures, all subsequent calls skip `OssStorage` entirely and go straight to `LocalFsStorage`, recovering the SLO. The half-open probe (one call allowed past the cool-down window) detects recovery without flooding the recovering backend with the full request rate.

This is also why `root` is `fallback.root`, not `primary.root` (T03 contract decision): when degraded, the operator should see the actual data location (the local path) instead of being misled by an OSS bucket name that the data is no longer landing in. The original bucket stays visible via `storage.health().primary_root` for debugging.

