# API reference

## MCP tool: `render_mermaid`

The primary tool this server exposes.

### Input

```json
{
  "code": "graph TD\n  A[Start] --> B{Decision}\n  B -->|yes| C[OK]\n  B -->|no| D[End]"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string | yes | Mermaid source. Up to 200 KB. |

### Output

```json
{
  "id": "mabc123",
  "ascii": "┌──────┐  ┌────────┐\n│Start │─▶│Decide  │\n└──────┘  └────┬───┘\n...",
  "fileLink": "file:///C:/Users/.../data/blobs/mabc123.html",
  "httpLink": null
}
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Short, base36, sortable. Use it as a key if you want to reference this diagram later. |
| `ascii` | string | Terminal-safe ASCII art (best-effort). |
| `fileLink` | string | Path to a self-contained HTML viewer. Opens at `file://` in any browser. |
| `httpLink` | string \| null | `http://127.0.0.1:5300/view?id=<id>` if the HTTP daemon is running. `null` otherwise. |
| `title` | string | Optional human label (≤200 chars). Round-trips through storage and `search_diagrams`. Defaults to `""`. |
| `warnings` | string[] | Optional. Present only when the ASCII conversion failed (R025). Each entry is `ascii_failed: <reason>`. The SVG is still produced; the LLM can choose to retry. |
| `elapsed_ms` | number | Wall-clock ms of the tool call. Always present (success + failure paths). |

### Errors

| Condition | Inner code | retryable | Message |
|---|---|---|---|
| Empty `code` | `-32602` (Invalid params) | false | "empty mermaid source" |
| `code` > 200 KB | `-32602` (Invalid params) | false | "mermaid source too long (X chars, max 200000)" |
| mermaid parse error | `-32002` (Render failed) | false | "mermaid parse error: <mermaid's diagnostic, truncated to 500 chars>" |
| mermaid render timeout (10s) | `-32001` (Render timeout) | true | "mermaid render exceeded 10000ms" |
| jsdom init failed twice | `-32003` (Jsdom init failed) | true | "jsdom init failed: <second attempt's message>" |
| Storage write exhausted retries | `-32004` (Storage write failed) | true | the underlying error message |
| Storage read timeout (5s) | `-32005` (Storage read failed) | true | "svg read timed out after 5000ms" |
| All HTTP ports in use | `-32008` (Port in use) | true | "all candidate ports in use: 5300, 5301, 5302" |

**Namespace disambiguation:** these `code` values live in the INNER `error.code` of the MCP `CallToolResult` (`isError: true`); they are NOT the JSON-RPC envelope `error.code`. The two namespaces share a few numbers (-32602 is the most common collision) but mean different things. See `docs/mcp-protocol.md` for the wire shape.

The error message includes mermaid's own diagnostic (line/column, the offending token) so the LLM can fix the diagram. The LLM should retry with the corrected source.

ASCII errors never fail the call. They appear as `[mermaid-ascii failed: <reason>]\n<source>` inside the `ascii` field.

## HTTP endpoints (standalone mode only)

These are only served when `MERMAID_RENDERER_HTTP=1`. They are NOT exposed in default stdio mode.

### `GET /view?id=<id>`

Returns a self-contained HTML viewer for the diagram. Sets `text/html; charset=utf-8`. The page includes zoom, pan, pin (when served from HTTP — not from `file://`), and SVG / PNG download buttons.

- `200 OK` — HTML
- `400` — missing `id`
- `404` — not found or expired (7 days since `createdAt`, not pinned)

### `GET /raw/svg?id=<id>`

Returns the raw rendered SVG. Sets `image/svg+xml; charset=utf-8`.

### `POST /pin?id=<id>&pin=true|false`

Toggles the long-term-storage flag. Pinned diagrams are not auto-cleaned after 7 days.

- `200 OK` — `{ "id": "<id>", "pinned": true }`
- `400` — missing `id` or invalid `pin` value
- `404` — not found

### `GET /health`

Liveness probe. Returns the merge of the S02 storage stats and the S03 observability surface.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSec": 42,
  "ttlDays": 7,
  "total": 17,
  "pinned": 2,
  "unpinned": 15,
  "counters": {
    "render_total": 42,
    "render_errors": 3,
    "ascii_failures": 1,
    "storage_write_retries": 0,
    "sweep_runs": 5,
    "sweep_removed": 2
  },
  "last_render_ms": 234,
  "last_errors": [
    { "code": -32602, "at": 1700000000000, "retryable": false, "message": "mermaid source too long (200001 chars, max 200000)" }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `status` | string | Always `"ok"` while the server is up. |
| `version` | string | Server semver. |
| `uptimeSec` | number | Seconds since the process started. |
| `ttlDays` | number | TTL for unpinned entries. |
| `total` / `pinned` / `unpinned` | number | Storage stats — S02 surface. |
| `counters` | object | The 6 persistent monotonic counters (R010). Persisted to `data/counters.json` and reloaded on boot. |
| `last_render_ms` | number | Wall-clock ms of the most recent tool call (success or failure). `0` when no tool has been called yet. |
| `last_errors` | array | Up to 5 most recent tagged failures (FIFO ring; oldest dropped when a 6th is recorded). Always an array, possibly empty. Each entry carries `code` (number), `at` (epoch ms), `retryable` (bool), and `message` (string). |

#### Counter reference

| Key | Bumped when |
|---|---|
| `render_total` | A `render_mermaid` call succeeds. |
| `render_errors` | Any tool call fails with a tagged error (-32001..-32009, -32602, -32603). |
| `ascii_failures` | The renderer produced an SVG but the ASCII conversion failed (R025; the call still succeeds with a `warnings` array). |
| `storage_write_retries` | The write-retry path fired on a transient error (EAGAIN / EWOULDBLOCK). The 2nd attempt's success does NOT bump; the 1st attempt's failure-with-retry does. |
| `sweep_runs` | Every sweep pass (including no-op passes). Bumped by `load()` on boot. |
| `sweep_removed` | Per entry removed by a sweep pass. `0` on a no-op sweep. |

#### Error ring reference

`last_errors[0..4]` is a 5-element FIFO. Each entry is `{code, at, retryable, message}`. The codes are the same as the inner `CallToolResult` payload codes (see the table above and `docs/mcp-protocol.md`).

### CORS

All endpoints (except `GET /view`, which is meant for browsers) respond with:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

`OPTIONS` returns `204` for any path.

## Storage directory

The data directory is `data/` by default, override with `MERMAID_RENDERER_DATA`. The directory must be writable by the user running the server.

```bash
# relocate
MERMAID_RENDERER_DATA=/var/lib/mermaid-tui-mcp node src/server.mjs
```

On-disk layout:

| Path | Purpose | Lifecycle |
|---|---|---|
| `data/store.json` | `{ id -> Entry }` index | Rewritten on every put / pin / unpin / remove / sweep. |
| `data/store.json.tmp` | Atomic-write staging | Unlinked on next `load()` if a previous save crashed mid-rename. |
| `data/blobs/<id>.svg` | Rendered SVG body | Created on `put`, removed on `remove` + sweep. |
| `data/blobs/<id>.html` | Self-contained HTML viewer | Created on `put`. |
| `data/counters.json` | Persistent monotonic counters (R010) | Rewritten on every `increment()`. |
| `data/counters.json.tmp` | Atomic-write staging (counters) | Unlinked on next `load()` if a previous save crashed. |
