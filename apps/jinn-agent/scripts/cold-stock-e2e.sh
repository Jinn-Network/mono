#!/usr/bin/env bash
# Blocking Stage 1 product gate: build the standalone products, install the
# wheel into pinned stock Hermes, drive the user lifecycle, then let the real
# task-creator read and advance the same contribution store.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
CLIENT="$REPO_ROOT/client"
HERMES_UPSTREAM_SHA="9df5f879b4a5925c0f8f947e7e16ed8e845932c3"
WORK="$(mktemp -d)"
export JINN_STAGE1_WORK="$WORK"
export HOME="$WORK/home"
export HERMES_HOME="$HOME"
export NO_COLOR=1
export JINN_LAYER_BIN="$CLIENT/dist/bin/jinn-layer.js"
export JINN_LAYER_EPISODES_DIR="$WORK/state/episodes"
export JINN_LAYER_CAPTURES_DIR="$WORK/state/captures"
export JINN_LAYER_SKILLS_INSTALL_DIR="$HERMES_HOME/skills"
export JINN_MINEABLE_STATE_DIR="$WORK/state/mineable"
mkdir -p "$HOME" "$WORK/state" "$WORK/wheels"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo "Stage 1 cold-stock gate requires Node 22+ (found $(node --version))." >&2
  exit 2
fi

if [[ "${JINN_STAGE1_SKIP_CLIENT_BUILD:-0}" != "1" ]]; then
  (
    cd "$CLIENT"
    corepack enable
    yarn install --immutable
    yarn build
  )
fi
test -x "$JINN_LAYER_BIN"
"$JINN_LAYER_BIN" contract --json | grep -q '"contractVersion":1'

# Build and install the distributable wheel. Installing the plugin source tree
# would miss packaging errors and would not represent the user-facing product.
python3 -m pip wheel --no-deps --wheel-dir "$WORK/wheels" "$HERE/plugins/jinn"
WHEEL="$(find "$WORK/wheels" -maxdepth 1 -name 'jinn_plugin-*.whl' -print -quit)"
test -n "$WHEEL"

git init -q "$WORK/upstream"
git -C "$WORK/upstream" remote add origin https://github.com/NousResearch/hermes-agent
git -C "$WORK/upstream" fetch -q --depth 1 origin "$HERMES_UPSTREAM_SHA"
git -C "$WORK/upstream" checkout -q --detach FETCH_HEAD
test "$(git -C "$WORK/upstream" rev-parse HEAD)" = "$HERMES_UPSTREAM_SHA"

python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q "$WORK/upstream"
"$WORK/venv/bin/pip" install -q "$WHEEL"

(
  cd "$WORK/upstream"
  "$WORK/venv/bin/python" "$HERE/scripts/stage1-stock-product.py"
)

(
  cd "$CLIENT"
  node scripts/stage1-task-creator-acceptance.mjs
)

echo "COLD STOCK STAGE 1 PRODUCT GATE PASS"
