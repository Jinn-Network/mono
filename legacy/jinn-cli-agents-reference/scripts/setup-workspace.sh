#!/usr/bin/env bash
# Setup script for Conductor workspaces.
# Symlinks .env and .operate from the main repo into this worktree.
#
# Usage:
#   ./scripts/setup-workspace.sh
#
# Intended to run automatically when a Conductor workspace is created.
# Safe to run multiple times (idempotent).

set -euo pipefail

MAIN_REPO="$HOME/Repositories/main/jinn-cli-agents"
WORKSPACE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Setting up workspace: $WORKSPACE_ROOT"
echo "Main repo: $MAIN_REPO"

# 1. Symlink .env
if [ -L "$WORKSPACE_ROOT/.env" ]; then
  echo "  .env: symlink already exists → $(readlink "$WORKSPACE_ROOT/.env")"
elif [ -f "$WORKSPACE_ROOT/.env" ]; then
  echo "  .env: regular file exists, skipping (remove manually to use symlink)"
else
  if [ -f "$MAIN_REPO/.env" ]; then
    ln -s "$MAIN_REPO/.env" "$WORKSPACE_ROOT/.env"
    echo "  .env: symlinked → $MAIN_REPO/.env"
  else
    echo "  .env: WARNING — not found at $MAIN_REPO/.env"
  fi
fi

# 2. Symlink .env into jinn-node/ (worker runs from jinn-node/ and loads its own .env)
JINN_NODE_ENV="$WORKSPACE_ROOT/jinn-node/.env"
if [ -L "$JINN_NODE_ENV" ]; then
  echo "  jinn-node/.env: symlink already exists → $(readlink "$JINN_NODE_ENV")"
elif [ -f "$JINN_NODE_ENV" ]; then
  echo "  jinn-node/.env: regular file exists, skipping"
else
  if [ -f "$MAIN_REPO/.env" ]; then
    ln -s "$MAIN_REPO/.env" "$JINN_NODE_ENV"
    echo "  jinn-node/.env: symlinked → $MAIN_REPO/.env"
  else
    echo "  jinn-node/.env: WARNING — not found at $MAIN_REPO/.env"
  fi
fi

# 3. Symlink .operate into jinn-node/ (where operate-profile.ts looks for it)
JINN_NODE_OPERATE="$WORKSPACE_ROOT/jinn-node/.operate"
SOURCE_OPERATE="$MAIN_REPO/olas-operate-middleware/.operate"

if [ -L "$JINN_NODE_OPERATE" ]; then
  echo "  jinn-node/.operate: symlink already exists → $(readlink "$JINN_NODE_OPERATE")"
elif [ -d "$JINN_NODE_OPERATE" ]; then
  echo "  jinn-node/.operate: directory exists, skipping"
else
  if [ -d "$SOURCE_OPERATE" ]; then
    ln -s "$SOURCE_OPERATE" "$JINN_NODE_OPERATE"
    echo "  jinn-node/.operate: symlinked → $SOURCE_OPERATE"
  else
    echo "  jinn-node/.operate: WARNING — not found at $SOURCE_OPERATE"
  fi
fi

echo "Done."
