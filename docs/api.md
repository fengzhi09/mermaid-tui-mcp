# API reference

## MCP tool: `render_mermaid`

The only tool this server exposes.

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

### Errors

| Condition | MCP error code | Message |
|---|---|---|
| Empty `code` | `-32602` (Invalid params) | "`code` must be a non-empty string" |
| `code` > 200 KB | `-32602` | "mermaid source too long (X chars, max 200000)" |
| mermaid parse error | `-32603` (Internal error) | "mermaid parse error: <mermaid's diagnostic, truncated to 500 chars>" |

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

Liveness probe.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSec": 42,
  "ttlDays": 7,
  "total": 17,
  "pinned": 2,
  "unpinned": 15
}
```

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
