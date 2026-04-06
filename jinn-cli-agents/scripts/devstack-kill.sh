#!/bin/sh

# Kill processes commonly used by the dev stack before restart
# - Ponder dev server
# - Control API server (GraphQL Yoga)
# - Worker processes (worker.ts, mech_worker.ts)

set -e

echo "[devstack-kill] Cleaning up existing dev processes..."

# Helper: kill by pattern if exists
kill_if_running() {
  PATTERN="$1"
  PIDS="$(pgrep -f "$PATTERN" || true)"
  if [ -n "$PIDS" ]; then
    echo "[devstack-kill] Killing $PATTERN (pids: $PIDS)"
    # Try graceful first
    kill $PIDS 2>/dev/null || true
    # Wait briefly then force kill if still alive
    sleep 1
    PIDS_AFTER="$(pgrep -f "$PATTERN" || true)"
    if [ -n "$PIDS_AFTER" ]; then
      echo "[devstack-kill] Force killing $PATTERN (pids: $PIDS_AFTER)"
      kill -9 $PIDS_AFTER 2>/dev/null || true
    fi
  else
    echo "[devstack-kill] No processes found for pattern: $PATTERN"
  fi
}

# Known patterns in this repo's dev stack
kill_if_running "ponder dev"
kill_if_running "tsx control-api/server.ts"
kill_if_running "control-api/server.ts"
kill_if_running "tsx jinn-node/src/worker/mech_worker.ts"
kill_if_running "jinn-node/src/worker/mech_worker.ts"
kill_if_running "jinn-node/src/agent/mcp/server.ts"

# Also clean common dev ports if set/known
# Control API default: 4001, Ponder default (env PONDER_PORT): 42069, Vite dev possible: 5173
kill_port() {
  PORT="$1"
  if [ -z "$PORT" ]; then
    return
  fi
  if lsof -i :"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    PID="$(lsof -i :"$PORT" -sTCP:LISTEN -t | tr '\n' ' ')"
    echo "[devstack-kill] Port $PORT in use by PID(s): $PID. Terminating."
    kill $PID 2>/dev/null || true
    sleep 1
    if lsof -i :"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
      PID2="$(lsof -i :"$PORT" -sTCP:LISTEN -t | tr '\n' ' ')"
      echo "[devstack-kill] Force killing PID(s): $PID2 on $PORT"
      kill -9 $PID2 2>/dev/null || true
    fi
  fi
}

kill_port "${CONTROL_API_PORT:-4001}"
kill_port "${PONDER_PORT:-42069}"
kill_port "5173"

echo "[devstack-kill] Cleanup complete."


