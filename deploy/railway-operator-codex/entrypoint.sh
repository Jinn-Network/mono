#!/usr/bin/env bash
# Materialise per-deployment state from env vars before launching the daemon.
# Persistent state lives on the Railway volume mounted at /data so the daemon
# survives restarts.
set -euo pipefail

DATA_DIR="${JINN_EARNING_DIR:-/data/earning}"
CODEX_HOME="${CODEX_HOME:-/data/codex-home}"
CONFIG_PATH="${JINN_CONFIG:-/data/config.json}"

mkdir -p "$DATA_DIR"
mkdir -p "$CODEX_HOME"

# Global git identity so plugin session-start hooks — which do `git commit
# --allow-empty` to init implStateDir before their own `git config user.*`
# fires — don't fail with "Author identity unknown" on a fresh container.
git config --global user.name  "jinn-operator-codex" || true
git config --global user.email "jinn-operator-codex@local" || true

# --- Codex auth (one-shot materialisation; container is read-only otherwise) ---
# CODEX_AUTH_JSON is the base64-encoded contents of ~/.codex/auth.json from the
# operator's local install. Written once per restart so a token-refresh on disk
# inside the volume is preserved, but a redeploy with rotated secret always
# wins.
if [ -n "${CODEX_AUTH_JSON:-}" ]; then
  echo "[entrypoint] writing CODEX_HOME=$CODEX_HOME/auth.json from CODEX_AUTH_JSON env"
  printf '%s' "$CODEX_AUTH_JSON" | base64 -d > "$CODEX_HOME/auth.json"
  chmod 600 "$CODEX_HOME/auth.json"
else
  echo "[entrypoint] WARNING: CODEX_AUTH_JSON unset; codex CLI will fail at first task pickup unless OPENAI_API_KEY is present"
fi

# Quick reachability probe — non-fatal, just visible in logs.
if command -v codex >/dev/null 2>&1; then
  echo "[entrypoint] codex CLI: $(codex --version 2>&1 | head -1)"
else
  echo "[entrypoint] ERROR: codex CLI not in PATH; codex harness tasks will fail"
fi

# --- Operator config (only seeded on first run) ---
# CONFIG_TEMPLATE_JSON, if set, is written verbatim. Lets the deploy ship a
# specific joinedSolverNets / harness selection without baking it into the
# image.
if [ ! -f "$CONFIG_PATH" ]; then
  if [ -n "${CONFIG_TEMPLATE_JSON:-}" ]; then
    echo "[entrypoint] seeding $CONFIG_PATH from CONFIG_TEMPLATE_JSON env"
    printf '%s' "$CONFIG_TEMPLATE_JSON" > "$CONFIG_PATH"
  else
    echo "[entrypoint] WARNING: no CONFIG_TEMPLATE_JSON and $CONFIG_PATH missing — daemon will start with defaults (no SolverNets joined)"
  fi
fi

# --- Hand off to the daemon ---
echo "[entrypoint] exec node dist/bin/jinn.js $*"
exec node dist/bin/jinn.js "$@"
