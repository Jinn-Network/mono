#!/usr/bin/env bash
# Per-deployment seeding for the launcher+operator overlay.
#
# Runs as the non-root `node` user (the base entrypoint already dropped
# root→node and chowned $JINN_STATE_DIR). Seeding-only — the pidfile/dotfile/
# state-dir workarounds moved into the daemon (#954/#955/#956).
#
# See docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  STATE_DIR="${JINN_STATE_DIR:-/data}"
  mkdir -p "$STATE_DIR"
  chown -R node:node "$STATE_DIR" 2>/dev/null || true
  exec gosu node env HOME=/home/node "$0" "$@"
fi

echo "[seed] running as uid=$(id -u) ($(id -un)) HOME=$HOME"

EARNING_DIR="${JINN_EARNING_DIR:-${JINN_STATE_DIR:-/data}/earning}"
CONFIG_PATH="${JINN_CONFIG:-/data/config.json}"
LAUNCHED_DIR="$EARNING_DIR/solvernets/launched"
CODEX_HOME="${CODEX_HOME:-/data/codex-home}"

# --- One-shot state restore (cutover migration path) --------------------------
# JINN_STATE_TARBALL_B64, if set, is a base64-encoded tar.gz built with:
#     tar -czf - -C ~/.jinn-client earning swe-rebench-v2
# so its top-level entries are `earning/` (keystore + stake state + launched
# records) AND `swe-rebench-v2/` (generator state + validated-pool.json).
# Extracted into /data ONCE, only when $EARNING_DIR is absent, so a redeploy
# never clobbers live state. This migrates the same wallet/stake AND the
# validated pool off the laptop. The top-level layout is a contract with the
# README's tarball command — keep them in sync.
if [ ! -d "$EARNING_DIR" ] && [ -n "${JINN_STATE_TARBALL_B64:-}" ]; then
  echo "[seed] restoring state tarball into /data (first boot)"
  mkdir -p /data
  if ! printf '%s' "$JINN_STATE_TARBALL_B64" | base64 -d | tar -xzf - -C /data; then
    echo "[seed] ERROR: state tarball restore failed (malformed JINN_STATE_TARBALL_B64?)" >&2
    exit 1
  fi
  if [ ! -d "$EARNING_DIR" ]; then
    echo "[seed] ERROR: restore produced no $EARNING_DIR — the tarball must have a top-level 'earning/' entry" >&2
    echo "[seed] ERROR: build it with: tar -czf - -C ~/.jinn-client earning swe-rebench-v2" >&2
    exit 1
  fi
fi

# Global git identity so plugin session-start hooks (which `git commit
# --allow-empty` to init implStateDir before setting their own user.*) don't
# fail with "Author identity unknown" on a fresh container.
git config --global user.name  "jinn-launcher-operator" || true
git config --global user.email "jinn-launcher-operator@local" || true

# --- Claude auth probe --------------------------------------------------------
# The claude CLI authenticates from CLAUDE_CODE_OAUTH_TOKEN in env (verified
# env-only, no file needed), which Railway exports into this process; child
# claude subprocesses inherit it. The same env var makes
# resolveCredentialId('claude-code') return anthropic:subscription, so the
# AI-units gate engages.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[seed] WARNING: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY set —"
  echo "[seed] WARNING: claude-code will fail auth AND the AI-units throttle will be OFF (unbounded burn)."
fi
if command -v claude >/dev/null 2>&1; then
  echo "[seed] claude CLI: $(claude --version 2>&1 | head -1)"
else
  echo "[seed] ERROR: claude CLI not in PATH; claude-code tasks will fail"
fi

# --- Codex auth probe ---------------------------------------------------------
# The hosted launcher may solve with either claude-code or codex, depending on
# the persisted joinedSolverNets harness selection. CODEX_AUTH_JSON mirrors the
# codex-only recipe: base64 of ~/.codex/auth.json from a logged-in machine.
mkdir -p "$CODEX_HOME"
if [ -n "${CODEX_AUTH_JSON:-}" ]; then
  echo "[seed] writing CODEX_HOME=$CODEX_HOME/auth.json from CODEX_AUTH_JSON env"
  printf '%s' "$CODEX_AUTH_JSON" | base64 -d > "$CODEX_HOME/auth.json"
  chmod 600 "$CODEX_HOME/auth.json"
else
  echo "[seed] INFO: CODEX_AUTH_JSON unset; codex harness tasks need OPENAI_API_KEY or a pre-existing $CODEX_HOME/auth.json"
fi
if command -v codex >/dev/null 2>&1; then
  echo "[seed] codex CLI: $(codex --version 2>&1 | head -1)"
else
  echo "[seed] ERROR: codex CLI not in PATH; codex tasks will fail if selected"
fi

# --- Operator config (seeded only on first run) -------------------------------
if [ ! -f "$CONFIG_PATH" ]; then
  if [ -n "${CONFIG_TEMPLATE_JSON:-}" ]; then
    echo "[seed] seeding $CONFIG_PATH from CONFIG_TEMPLATE_JSON env"
    printf '%s' "$CONFIG_TEMPLATE_JSON" > "$CONFIG_PATH"
  else
    echo "[seed] WARNING: no CONFIG_TEMPLATE_JSON and $CONFIG_PATH missing — daemon starts with no SolverNets joined"
  fi
fi

# --- Launched record (so the generator spawns) --------------------------------
# LAUNCHED_RECORD_JSON, if set, is the operator's owned launched record JSON
# (schemaVersion solvernet.launched.v1). Written to
# $JINN_EARNING_DIR/solvernets/launched/<solverNetId>.json — the path the
# daemon walks at startup (operator/src/main.ts). Skipped if the state tarball
# already restored a record. The filename MUST be the record's solverNetId
# (a SafeId: alnum/dash/underscore/dot).
if [ -n "${LAUNCHED_RECORD_JSON:-}" ]; then
  mkdir -p "$LAUNCHED_DIR"
  SID="$(printf '%s' "$LAUNCHED_RECORD_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).solverNetId||"")})')"
  if [ -z "$SID" ]; then
    echo "[seed] ERROR: LAUNCHED_RECORD_JSON has no solverNetId"; exit 1
  fi
  TARGET="$LAUNCHED_DIR/$SID.json"
  if [ ! -f "$TARGET" ]; then
    echo "[seed] seeding launched record $TARGET"
    printf '%s' "$LAUNCHED_RECORD_JSON" > "$TARGET"
  fi
fi

# --- Base-contract guard (#1066) ----------------------------------------------
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
  echo "[seed] FATAL: rebuild against a newer ghcr.io/jinn-network/client base (BASE_IMAGE/BASE_TAG)." >&2
  exit 1
fi

# --- Stale pidfile cleanup ----------------------------------------------------
# Published base images can lag the daemon-side PID-1 reclaim (#955/#805). On
# Railway, a persisted pidfile containing "1" points at the previous container's
# daemon, but PID 1 in the new container is always alive, so old clients refuse
# to start. Reclaim that known-stale record here before handing off.
PIDFILE="$EARNING_DIR/daemon.pid"
if [ -f "$PIDFILE" ]; then
  PID="$(node -e 'const fs=require("fs"); const p=process.argv[1]; const n=parseInt(fs.readFileSync(p,"utf8").trim(),10); process.stdout.write(Number.isFinite(n) ? String(n) : "");' "$PIDFILE" 2>/dev/null || true)"
  if [ "$PID" = "1" ]; then
    echo "[seed] removing stale daemon pidfile recording PID 1 ($PIDFILE)"
    rm -f "$PIDFILE"
  elif [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
    echo "[seed] removing stale daemon pidfile recording dead PID $PID ($PIDFILE)"
    rm -f "$PIDFILE"
  fi
fi

# --- Hand off to the daemon ---------------------------------------------------
echo "[seed] exec node dist/bin/jinn.js $*"
exec node dist/bin/jinn.js "$@"
