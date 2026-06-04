# MCP protocol details

This server speaks the [Model Context Protocol](https://modelcontextprotocol.io) (revision 2025-06-18) over stdio JSON-RPC 2.0.

## Server identity

```json
{
  "name": "mermaid-tui-mcp",
  "version": "0.1.0"
}
```

The version string follows semver. The server does not dynamically report its version to the LLM — it is visible in `npx @modelcontextprotocol/inspector` and in the agent's system prompt under the server entry.

## Capabilities

```json
{
  "capabilities": {
    "tools": {}
  }
}
```

Only `tools` is declared. The server does NOT declare `resources`, `prompts`, `sampling`, or `roots`. Adding any of these is a breaking change for clients that do not handle unknown capabilities gracefully — be careful.

## Initialize

The server responds to `initialize` with:

```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": { "tools": {} },
  "serverInfo": { "name": "mermaid-tui-mcp", "version": "0.1.0" }
}
```

The client is expected to send a `notifications/initialized` notification after receiving this. The server does not require any other initialization parameters (no API keys, no clientInfo echoing).

## Tools list

`tools/list` returns the 7 tools shipped in v0.1.0 + S02:

```json
{
  "tools": [
    {
      "name": "render_mermaid",
      "description": "...",
      "inputSchema": {
        "type": "object",
        "properties": {
          "code": { "type": "string", "description": "Mermaid diagram source. E.g. 'graph TD\\n  A-->B'." },
          "title": { "type": "string", "description": "Optional human label (≤200 chars)." }
        },
        "required": ["code"],
        "additionalProperties": false
      }
    }
  ]
}
```

The description is the only thing the LLM reads to decide whether to call the tool. It is written for a stranger under time pressure. Do not shorten it without testing that the LLM still calls it in the right places.

## Tools call

Request:

```json
{
  "method": "tools/call",
  "params": {
    "name": "render_mermaid",
    "arguments": { "code": "graph TD\n  A-->B" }
  }
}
```

Success response (MCP `CallToolResult`):

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"id\":\"mabc123\",\"ascii\":\"...\",\"fileLink\":\"file:///...\",\"httpLink\":null,\"title\":\"\",\"elapsed_ms\":234}"
    }
  ]
}
```

The `text` payload is itself a JSON string. The LLM parses it. (We do not use MCP's `type: "json"` content block because not every client supports it yet.)

Failure response (MCP `CallToolResult` with `isError: true`):

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "{\"code\":-32002,\"message\":\"mermaid parse error: Lexical error on line 3\",\"retryable\":false,\"elapsed_ms\":12}"
    }
  ]
}
```

### Error contract (R020 + S03 extension)

| Inner `code` | retryable | Meaning |
|---|---|---|
| `-32602` | false | Invalid params — zod rejected the input shape (empty code, code > 200 KB, etc.). |
| `-32001` | true | Render timeout — `mermaid.render()` didn't return within `MERMAID_RENDER_TIMEOUT_MS` (default 10s). |
| `-32002` | false | Render failed — mermaid parse error. |
| `-32003` | true | JSDOM init failed twice. |
| `-32004` | true | Storage write failed (terminal error after no-retry or retry exhausted). |
| `-32005` | true | Storage read timeout (5s). Distinct from the S02 NotFoundError which uses the same code with `retryable: false`. |
| `-32008` | true | All candidate HTTP ports (5300/5301/5302) are in use. |
| `-32009` | false | MCP protocol violation (unknown tool, missing arguments, etc.). |
| `-32603` | false | Internal error — unclassified failure. |

**Namespace disambiguation (CRITICAL):** the `code` field above is the INNER `CallToolResult` payload code, NOT the JSON-RPC envelope `error.code`. The two namespaces share a few numbers (most notably `-32602` — zod uses it in both layers, but the meaning is different) and the protocol is wired so an LLM client always reads the inner one for tool-failure diagnostics:

```jsonc
// JSON-RPC envelope (top-level `error.code`) — SDK-defined:
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32603, "message": "Internal error" }  // transport/SDK
}

// Inner CallToolResult payload (S03 application-level):
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "{\"error\":{\"code\":-32002,\"message\":\"mermaid parse error: ...\",\"retryable\":false,\"elapsed_ms\":12}}"
  }]
}
```

The wire shape for the inner error is `{code, message, retryable, elapsed_ms}` (4 fields, stable insertion order). The `elapsed_ms` is the wall-clock ms of the tool call — always present, success and failure paths.

JSON-RPC-level errors (e.g. unknown method) use the standard JSON-RPC 2.0 error codes. We do not throw them in normal operation. After the S03 wrapper change, un-tagged in-process failures (e.g. a handler throwing a plain `Error`) are classified via `classifyDomainError` and surface in the inner `CallToolResult` as code `-32603` instead of bubbling to a JSON-RPC envelope error.

## Logging

All log output goes to `stderr`. `stdout` is reserved for the JSON-RPC stream — if you write to `stdout`, the client will see a parse error on the next message.

S03 (R008) format: one JSON object per line, with stable field order `{ts, level, event, code?, id?, ...rest}`. Example:

```json
{"ts":"2026-06-04T12:00:00.000Z","level":"info","event":"boot","version":"0.1.0","data":"./data","http":false,"stats":{"total":0,"pinned":0,"unpinned":0}}
{"ts":"2026-06-04T12:00:00.123Z","level":"info","event":"tool_call","tool":"render_mermaid","status":"ok","elapsed_ms":234}
{"ts":"2026-06-04T12:00:00.456Z","level":"info","event":"tool_call","tool":"render_mermaid","status":"error","code":-32002,"elapsed_ms":12,"retryable":false}
```

| Field | Type | Description |
|---|---|---|
| `ts` | string (ISO 8601) | Always present. |
| `level` | `"info"` \| `"warn"` \| `"error"` \| `"debug"` | Always present; defaults to `"info"`. |
| `event` | string | Machine-readable event name. Always present. |
| `code` | number | Optional. Present on tagged errors and on `tool_call` failures. |
| `id` | string | Optional. Present when the log line refers to a specific diagram id. |
| `...rest` | any | Event-specific extras (e.g. `host`, `port`, `tool`, `elapsed_ms`, `retryable`). |

Log consumers (gsd-pi, log shippers, human `grep`) MUST tolerate any field being absent (except `ts`, `level`, `event`) — the `code` and `id` keys are emitted only when meaningful.

## Lifecycle

1. Agent spawns `node src/server.mjs` as a child.
2. Agent sends `initialize` → server responds.
3. Agent sends `notifications/initialized`.
4. Agent sends `tools/list` → server responds.
5. Agent sends `tools/call` (one or more) → server responds to each.
6. Agent exits → SIGTERM is sent to the child → server drains for 3 s and exits.
7. If the server crashes, the agent sees an EOF on stdout and reports the MCP failure.

The hourly sweep `setInterval` is `unref()`'d (S03 MEM017) — it does not keep the event loop alive after stdio closes, so a graceful shutdown path doesn't have to escalate to SIGKILL. The test helper keeps a SIGTERM→SIGKILL escalation as defense-in-depth.

There is no explicit "shutdown" message in MCP. We rely on SIGTERM.

## Protocol violations to watch for

- Writing to `stdout` outside the JSON-RPC stream — fatal, breaks the client.
- Long-running tool calls without progress reporting — MCP supports `progress` notifications but we do not use them. The render is < 2 s in practice; add progress if that ever changes.
- Returning a non-`text` content block without verifying the client supports it.
- Treating the JSON-RPC envelope `error.code` and the inner `CallToolResult` `code` as the same namespace — they are not. See "Namespace disambiguation" above.
