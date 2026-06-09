#!/usr/bin/env bash
# Stop the devnet started by up.sh.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
if [ -f "$NODE_PID" ] && kill -0 "$(cat "$NODE_PID")" 2>/dev/null; then
  kill "$(cat "$NODE_PID")" && echo "[down] stopped pid $(cat "$NODE_PID")"
  rm -f "$NODE_PID"
else
  echo "[down] no running node recorded"
fi
