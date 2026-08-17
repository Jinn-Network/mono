#!/usr/bin/env bash
# Per-deployment seeding for the codex-harness operator overlay.
#
# Runs as the non-root `node` user (the base entrypoint already dropped
# root→node and chowned $JINN_STATE_DIR). Seeding-only — the daemon derives its
# state dirs from JINN_STATE_DIR, so no per-key mkdir workarounds here.
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-/data/codex-home}"
CONFIG_PATH="${JINN_CONFIG:-/data/config.json}"

# CODEX_HOME holds the codex auth file (written below); ensure it exists.
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
  echo "[seed] writing CODEX_HOME=$CODEX_HOME/auth.json from CODEX_AUTH_JSON env"
  printf '%s' "$CODEX_AUTH_JSON" | base64 -d > "$CODEX_HOME/auth.json"
  chmod 600 "$CODEX_HOME/auth.json"
else
  echo "[seed] WARNING: CODEX_AUTH_JSON unset; codex CLI will fail at first task pickup unless OPENAI_API_KEY is present"
fi

# Quick reachability probe — non-fatal, just visible in logs.
if command -v codex >/dev/null 2>&1; then
  echo "[seed] codex CLI: $(codex --version 2>&1 | head -1)"
else
  echo "[seed] ERROR: codex CLI not in PATH; codex harness tasks will fail"
fi

# --- Operator config (only seeded on first run) ---
# CONFIG_TEMPLATE_JSON, if set, is written verbatim. Lets the deploy ship a
# specific joinedSolverNets / harness selection without baking it into the
# image.
if [ ! -f "$CONFIG_PATH" ]; then
  if [ -n "${CONFIG_TEMPLATE_JSON:-}" ]; then
    echo "[seed] seeding $CONFIG_PATH from CONFIG_TEMPLATE_JSON env"
    printf '%s' "$CONFIG_TEMPLATE_JSON" > "$CONFIG_PATH"
  else
    echo "[seed] WARNING: no CONFIG_TEMPLATE_JSON and $CONFIG_PATH missing — daemon will start with defaults (no SolverNets joined)"
  fi
fi

# --- Base-contract guard (#1066) ---
# This overlay needs the #988 container-native base contract: the base
# entrypoint must exec this absolute-path seed script as-is rather than feed it
# to `jinn` as a verb. A #988+ base sets JINN_BASE_CONTRACT. A pre-#988 base
# dies on "Unknown verb" before reaching this line, so the guard's real value is
# future-proofing against a base whose contract is bumped past what this overlay
# expects — a clear message instead of a cryptic crash.
REQUIRED_BASE_CONTRACT=1
contract="${JINN_BASE_CONTRACT:-0}"
case "$contract" in (*[!0-9]*|'') contract=0 ;; esac
if [ "$contract" -lt "$REQUIRED_BASE_CONTRACT" ]; then
  echo "[seed] FATAL: base image contract '${JINN_BASE_CONTRACT:-unset}' < required ${REQUIRED_BASE_CONTRACT}." >&2
  echo "[seed] FATAL: this overlay needs a base built from #988+ (absolute-path CMD dispatch)." >&2
  echo "[seed] FATAL: rebuild against a newer ghcr.io/jinn-network/operator base (BASE_IMAGE/BASE_TAG)." >&2
  exit 1
fi

# --- Hand off to the daemon ---
echo "[seed] exec node dist/bin/jinn.js $*"
exec node dist/bin/jinn.js "$@"
