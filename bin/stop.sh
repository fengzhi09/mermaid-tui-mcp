#!/usr/bin/env bash
# Stop the gsd mermaid renderer (if running).
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$DIR/data/server.pid"

if [[ ! -f "$PIDFILE" ]]; then
  echo "[mermaid-renderer] not running (no pidfile)"
  exit 0
fi

PID="$(cat "$PIDFILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID" 2>/dev/null || true
  # Wait up to 5s for clean exit.
  for i in 1 2 3 4 5; do
    if ! kill -0 "$PID" 2>/dev/null; then break; fi
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "[mermaid-renderer] graceful shutdown timed out, sending SIGKILL"
    kill -9 "$PID" 2>/dev/null || true
  fi
  echo "[mermaid-renderer] stopped (pid $PID)"
else
  echo "[mermaid-renderer] stale pidfile (pid $PID not alive)"
fi
rm -f "$PIDFILE"
