# Security

## Trust model

`mermaid-tui-mcp` is a **stdio MCP server**. It is spawned by an agent (gsd-pi, Claude Code, opencode, Hermes, ...) as a child process. The agent pipes JSON-RPC over the child's stdin/stdout. The child has the same OS-level privileges as the spawning agent.

This means:

- If you trust the agent, you can trust the MCP server it spawns — there is no extra trust boundary being crossed.
- If you do not trust an MCP server, do not let your agent spawn it. This applies to every MCP server, not just this one.
- The HTTP-standalone mode (`MERMAID_RENDERER_HTTP=1`) binds to `127.0.0.1` only. It is not reachable from other machines on the network. It is reachable from any browser running on the same host, including malicious browser extensions.

## What the server does

- Reads mermaid source from the tool call input.
- Renders to SVG via `mermaid` (a self-contained jsdom + mermaid 11).
- Renders to ASCII via `mermaid-ascii`.
- Writes files under `data/` (configurable via `MERMAID_RENDERER_DATA`).
- Returns ASCII art + a `fileLink` (path to a self-contained HTML viewer) and optionally an `httpLink`.

## What the server does NOT do

- It does not make outbound network calls. Diagrams never leave the host.
- It does not read or write anything outside `data/` (unless `MERMAID_RENDERER_DATA` points elsewhere).
- It does not execute shell commands or eval code. The mermaid parser is the only "code execution" surface, and it only processes declarative diagram syntax.
- It does not authenticate the HTTP API. The HTTP listener is bound to localhost on the assumption that the OS user controls who can open local sockets.

## Reporting a vulnerability

Email `lhl` via the address on the Gitee profile, or open a private security advisory on Gitee. Do not open a public issue for suspected vulnerabilities.

Please include:

- The agent + version you used to spawn the server
- The exact mermaid source that triggers the issue
- The relevant log line from `data/server.log` (if running in HTTP mode) or from the spawning agent's stderr
