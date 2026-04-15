#!/bin/bash
# Wrapper: runs the worker via Docker Compose by default.
# Falls back to bare tsx if Docker is unavailable.
# Usage:
#   yarn worker              → docker compose up -d (detached, auto-restart)
#   yarn worker --single     → docker compose run --rm (one-off, foreground)
#   yarn worker:dev          → bare tsx (no Docker)

set -e
cd "$(dirname "$0")/.."

# --- Check Docker availability ---
HAS_DOCKER=false
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  HAS_DOCKER=true
fi

if [ "$HAS_DOCKER" = false ]; then
  echo "[worker] Docker not available — running bare worker (no auto-restart, no health monitoring)"
  echo "[worker] Install Docker for production use: https://docs.docker.com/get-docker/"
  LOG_PRETTY=1 USE_TSX_MCP=1 exec npx tsx src/worker/mech_worker.ts "$@"
fi

# --- Docker mode ---
# Build image if needed (quiet, only on first run or after changes)
echo "[worker] Building Docker image (first run may take a minute)..."
docker compose build --quiet 2>/dev/null || true

if [ $# -eq 0 ]; then
  # No args: start detached with auto-restart
  docker compose up -d
  echo ""
  echo "Worker started (detached)"
  echo ""
  echo "  Logs:    docker compose logs -f"
  echo "  Health:  docker compose ps"
  echo "  Stop:    docker compose down"
  echo ""
else
  # With args (e.g., --single, --request-id=X): one-off container run (foreground)
  exec docker compose run --rm worker dumb-init -- node dist/worker/worker_launcher.js "$@"
fi
