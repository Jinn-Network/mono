#!/usr/bin/env bash
set -euo pipefail
# Drop root → node so claude-code's --dangerously-skip-permissions works
# (it refuses root) and the daemon writes the volume as a non-root user.
# Railway/compose start as root and may mount $JINN_STATE_DIR as root, so as
# root we take ownership then re-exec self as node; HOME is pinned so claude /
# git / ~/.jinn-client resolve. Already-non-root invocations pass straight through.
if [ "$(id -u)" = "0" ]; then
  STATE_DIR="${JINN_STATE_DIR:-/data}"
  mkdir -p "$STATE_DIR"
  chown -R node:node "$STATE_DIR" 2>/dev/null || true
  exec gosu node env HOME=/home/node "$0" "$@"
fi
# Back-compatible dispatch: bare jinn subcommands (run/version/doctor/...) get the
# `node dist/bin/jinn.js` prefix (preserving the historical `docker run IMAGE version`
# contract); an absolute-path/node/sh/bash first arg is exec'd as-is (so an S8 overlay
# can pass a seeding script as its CMD, and `docker run -it IMAGE bash` works).
case "${1:-}" in
  node|/*|sh|bash) exec "$@" ;;
  *) exec node dist/bin/jinn.js "$@" ;;
esac
