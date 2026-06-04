#!/usr/bin/env bash
# Start the gsd mermaid renderer in HTTP-standalone mode (background daemon).
# Use this if you want browser access to the view page + pin API on
# http://127.0.0.1:5300. The MCP stdio path does NOT need this — gsd-pi
# spawns a per-session MCP child automatically when the .mcp.json entry is
# present.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$DIR/data/server.pid"
LOGFILE="$DIR/data/server.log"
PORT="${MERMAID_RENDERER_PORT:-5300}"

mkdir -p "$DIR/data"

# Re-use running instance.
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "[mermaid-renderer] already running (pid $(cat "$PIDFILE")) on port $PORT"
  exit 0
fi
rm -f "$PIDFILE"

cd "$DIR"
if [[ ! -d "$DIR/node_modules/mermaid" ]]; then
  echo "[mermaid-renderer] installing dependencies (first run, ~80MB)..."
  npm install --no-audit --no-fund --loglevel=error
fi

MERMAID_RENDERER_HTTP=1 nohup node src/server.mjs > "$LOGFILE" 2>&1 &
PID=$!
echo $PID > "$PIDFILE"

for i in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "[mermaid-renderer] FAILED — see $LOGFILE"
    rm -f "$PIDFILE"
    tail -n 20 "$LOGFILE" 2>/dev/null || true
    exit 1
  fi
  if curl -sS "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1; then
    echo "[mermaid-renderer] started (pid $PID) on http://127.0.0.1:${PORT}"
    echo "[mermaid-renderer] log: $LOGFILE"
    curl -sS "http://127.0.0.1:${PORT}/health"
    echo
    exit 0
  fi
  sleep 1
done

echo "[mermaid-renderer] started (pid $PID) but /health did not respond within 10s"
echo "[mermaid-renderer] check $LOGFILE"
exit 0
