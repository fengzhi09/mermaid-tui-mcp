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

`tools/list` returns one tool:

```json
{
  "tools": [
    {
      "name": "render_mermaid",
      "description": "Render a Mermaid diagram source string into terminal-safe ASCII art. ALWAYS call this tool before emitting a ```mermaid code fence in your reply. Return value: { id, ascii, fileLink, httpLink }. Use `ascii` in your reply (replacing the raw mermaid source). `fileLink` opens a self-contained HTML viewer at file:// in any browser. `httpLink` opens the same viewer at http://127.0.0.1:5300 (only works if the standalone HTTP daemon was started separately; ignore the 404 if not).",
      "inputSchema": {
        "type": "object",
        "properties": {
          "code": {
            "type": "string",
            "description": "Mermaid diagram source. E.g. 'graph TD\\n  A-->B'."
          }
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
      "text": "{\"id\":\"mabc123\",\"ascii\":\"...\",\"fileLink\":\"file:///...\",\"httpLink\":null}"
    }
  ]
}
```

The `text` payload is itself a JSON string. The LLM parses it. (We do not use MCP's `type: "json"` content block because not every client supports it yet.)

Error response (MCP error):

```json
{
  "isError": true,
  "content": [
    { "type": "text", "text": "mermaid parse error: ..." }
  ]
}
```

JSON-RPC-level errors (e.g. unknown method) use the standard JSON-RPC 2.0 error codes. We do not throw them in normal operation.

## Logging

All log output goes to `stderr`. `stdout` is reserved for the JSON-RPC stream — if you write to `stdout`, the client will see a parse error on the next message.

Format:

```
[12:34:56][mermaid-renderer] v0.1.0 ready | data: ./data | http: off | stats: { total: 0, pinned: 0, unpinned: 0 }
```

## Lifecycle

1. Agent spawns `node src/server.mjs` as a child.
2. Agent sends `initialize` → server responds.
3. Agent sends `notifications/initialized`.
4. Agent sends `tools/list` → server responds.
5. Agent sends `tools/call` (one or more) → server responds to each.
6. Agent exits → SIGTERM is sent to the child → server drains for 3 s and exits.
7. If the server crashes, the agent sees an EOF on stdout and reports the MCP failure.

There is no explicit "shutdown" message in MCP. We rely on SIGTERM.

## Protocol violations to watch for

- Writing to `stdout` outside the JSON-RPC stream — fatal, breaks the client.
- Long-running tool calls without progress reporting — MCP supports `progress` notifications but we do not use them. The render is < 2 s in practice; add progress if that ever changes.
- Returning a non-`text` content block without verifying the client supports it.
