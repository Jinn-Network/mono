#!/usr/bin/env bash
# Materialise per-deployment state from env vars before launching the daemon.
# Persistent state lives on the Railway volume at /data so the daemon survives
# restarts. See docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md
set -euo pipefail

# --- Drop from root to the non-root `node` user -------------------------------
# Railway starts the container as root and mounts /data as root. But Claude Code
# refuses `--dangerously-skip-permissions` when running as root, so the
# claude-code harness crashed on every task ("cannot be used with root/sudo
# privileges"). Fix: as root, take ownership of the volume, then re-exec this
# script as `node` (Claude permits the flag for non-root users). HOME is pinned
# to the node user's home so claude / git / ~/.jinn-client resolve correctly.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data 2>/dev/null || true
  echo "[entrypoint] chowned /data; dropping root → node"
  exec gosu node env HOME=/home/node "$0" "$@"
fi
echo "[entrypoint] running as uid=$(id -u) ($(id -un)) HOME=$HOME"

EARNING_DIR="${JINN_EARNING_DIR:-/data/earning}"
CONFIG_PATH="${JINN_CONFIG:-/data/config.json}"
LAUNCHED_DIR="$EARNING_DIR/solvernets/launched"
# Generator state + validated-pool artifact dir. MUST be on the volume: the
# generator has no IPFS fetch for the validated pool, so an unseeded/ephemeral
# state dir means it posts ZERO tasks (see Dockerfile JINN_SWE_REBENCH_V2_STATE_DIR).
STATE_DIR="${JINN_SWE_REBENCH_V2_STATE_DIR:-/data/swe-rebench-v2}"

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
  echo "[entrypoint] restoring state tarball into /data (first boot)"
  mkdir -p /data
  if ! printf '%s' "$JINN_STATE_TARBALL_B64" | base64 -d | tar -xzf - -C /data; then
    echo "[entrypoint] ERROR: state tarball restore failed (malformed JINN_STATE_TARBALL_B64?)" >&2
    exit 1
  fi
  if [ ! -d "$EARNING_DIR" ]; then
    echo "[entrypoint] ERROR: restore produced no $EARNING_DIR — the tarball must have a top-level 'earning/' entry" >&2
    echo "[entrypoint] ERROR: build it with: tar -czf - -C ~/.jinn-client earning swe-rebench-v2" >&2
    exit 1
  fi
fi

mkdir -p "$EARNING_DIR" "$LAUNCHED_DIR" "$STATE_DIR"

# Global git identity so plugin session-start hooks (which `git commit
# --allow-empty` to init implStateDir before setting their own user.*) don't
# fail with "Author identity unknown" on a fresh container.
git config --global user.name  "jinn-launcher-operator" || true
git config --global user.email "jinn-launcher-operator@local" || true

# --- Claude auth probe --------------------------------------------------------
# Per the Task 0 spike: the claude CLI authenticates from CLAUDE_CODE_OAUTH_TOKEN
# in env (verified env-only, no file needed), which Railway exports into this
# process; child claude subprocesses inherit it. The same env var makes
# resolveCredentialId('claude-code') return anthropic:subscription, so the
# AI-units gate engages.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[entrypoint] WARNING: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY set —"
  echo "[entrypoint] WARNING: claude-code will fail auth AND the AI-units throttle will be OFF (unbounded burn)."
fi
# --- File-based fallback (NOT needed per Task 0; uncomment only if a future ---
# --- claude-code version stops honouring the env var): -----------------------
# if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
#   printf '{"oauthToken":"%s"}' "$CLAUDE_CODE_OAUTH_TOKEN" > /root/.claude/claude.json
#   chmod 600 /root/.claude/claude.json
# fi
if command -v claude >/dev/null 2>&1; then
  echo "[entrypoint] claude CLI: $(claude --version 2>&1 | head -1)"
else
  echo "[entrypoint] ERROR: claude CLI not in PATH; claude-code tasks will fail"
fi

# --- Operator config (seeded only on first run) -------------------------------
if [ ! -f "$CONFIG_PATH" ]; then
  if [ -n "${CONFIG_TEMPLATE_JSON:-}" ]; then
    echo "[entrypoint] seeding $CONFIG_PATH from CONFIG_TEMPLATE_JSON env"
    printf '%s' "$CONFIG_TEMPLATE_JSON" > "$CONFIG_PATH"
  else
    echo "[entrypoint] WARNING: no CONFIG_TEMPLATE_JSON and $CONFIG_PATH missing — daemon starts with no SolverNets joined"
  fi
fi

# --- Launched record (so the generator spawns) --------------------------------
# LAUNCHED_RECORD_JSON, if set, is the operator's owned launched record JSON
# (schemaVersion solvernet.launched.v1). Written to
# $JINN_EARNING_DIR/solvernets/launched/<solverNetId>.json — the path the
# daemon walks at startup (client/src/main.ts:2393). Skipped if the state
# tarball already restored a record. The filename MUST be the record's
# solverNetId (a SafeId: alnum/dash/underscore/dot).
if [ -n "${LAUNCHED_RECORD_JSON:-}" ]; then
  SID="$(printf '%s' "$LAUNCHED_RECORD_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).solverNetId||"")})')"
  if [ -z "$SID" ]; then
    echo "[entrypoint] ERROR: LAUNCHED_RECORD_JSON has no solverNetId"; exit 1
  fi
  TARGET="$LAUNCHED_DIR/$SID.json"
  if [ ! -f "$TARGET" ]; then
    echo "[entrypoint] seeding launched record $TARGET"
    printf '%s' "$LAUNCHED_RECORD_JSON" > "$TARGET"
  fi
fi

# --- Hand off to the daemon ---------------------------------------------------
echo "[entrypoint] exec node dist/bin/jinn.js $*"
exec node dist/bin/jinn.js "$@"
