#!/usr/bin/env bash
# smoke.sh — verify the server boots, responds to a render, and exits cleanly.
# Runs the stdio MCP path in a single round-trip via the official inspector
# pattern (using a small inline Node script that spawns the server and
# exchanges JSON-RPC messages). For more thorough testing, use
# `npx @modelcontextprotocol/inspector node src/server.mjs`.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Ensure deps.
if [[ ! -d "$DIR/node_modules/mermaid" ]]; then
  echo "[smoke] installing dependencies..."
  npm install --no-audit --no-fund --loglevel=error
fi

# Health probe in HTTP mode (separate from the MCP smoke below).
echo "[smoke] booting HTTP daemon for 5 s..."
MERMAID_RENDERER_HTTP=1 MERMAID_RENDERER_PORT=15300 node src/server.mjs > /tmp/mermaid-smoke.log 2>&1 &
PID=$!
trap "kill $PID 2>/dev/null || true" EXIT

for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sS http://127.0.0.1:15300/health > /dev/null 2>&1; then break; fi
  sleep 1
done

echo "[smoke] /health:"
curl -sS http://127.0.0.1:15300/health | sed 's/^/  /'

echo "[smoke] HTTP daemon OK; killing for stdio round-trip..."
kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true
trap - EXIT

# stdio MCP round-trip via a small driver.
echo "[smoke] stdio MCP round-trip..."
cat > /tmp/mcp-smoke.mjs <<'NODE'
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const serverPath = resolve(process.argv[2], "src/server.mjs");
const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });

let buffer = "";
let id = 0;
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function send(method, params) {
  const _id = ++id;
  return new Promise((resolve) => {
    pending.set(_id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: _id, method, params }) + "\n");
  });
}

const initResp = await send("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0.0.0" },
});
console.log("initialize.ok =", initResp.result?.serverInfo);

const toolsResp = await send("tools/list", {});
console.log("tools:", toolsResp.result?.tools?.map((t) => t.name));

const callResp = await send("tools/call", {
  name: "render_mermaid",
  arguments: { code: "graph TD\n  A[Start] --> B{Decision}\n  B -->|yes| C[OK]\n  B -->|no| D[End]" },
});
const text = callResp.result?.content?.[0]?.text;
if (!text) { console.error("no content"); process.exit(2); }
const parsed = JSON.parse(text);
console.log("rendered id =", parsed.id);
console.log("ascii first 80 chars:");
console.log("  " + (parsed.ascii || "").split("\n").slice(0, 3).join("\n  "));
console.log("fileLink =", parsed.fileLink);

if (!parsed.id || !parsed.ascii || !parsed.fileLink) {
  console.error("FAIL: missing fields in result");
  process.exit(2);
}

child.kill();
console.log("OK");
NODE

node /tmp/mcp-smoke.mjs "$DIR"
echo "[smoke] all checks passed"
