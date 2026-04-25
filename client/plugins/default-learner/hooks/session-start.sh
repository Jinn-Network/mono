#!/usr/bin/env bash
# default-learner session-start hook.
#
# Runs once at the start of every default-learner session. Ensures
# implStateDir is a git repo and sets the author identity so any
# subsequent `git commit` from inside the plugin's agents uses the
# default-learner identity automatically.
#
# Inputs (from environment):
#   IMPL_STATE_DIR — path to the operator's implStateDir
#
# Idempotent: safe to re-run. No remote, no signing — implStateDir
# history is operator-private.

set -euo pipefail

if [[ -z "${IMPL_STATE_DIR:-}" ]]; then
  echo "session-start: IMPL_STATE_DIR not set" >&2
  exit 1
fi

mkdir -p "$IMPL_STATE_DIR"
cd "$IMPL_STATE_DIR"

if [[ ! -d .git ]]; then
  git init --initial-branch=main --quiet
  git commit --allow-empty -m "init implStateDir" --quiet
fi

git config user.name "default-learner"
git config user.email "default-learner@jinn.local"

echo "session-start: implStateDir ready at $(pwd) (HEAD=$(git rev-parse HEAD))"
