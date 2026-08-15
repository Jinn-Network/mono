#!/usr/bin/env bash
# Blocking Stage 1 product gate: build the standalone products, install the
# wheel into pinned stock Hermes, drive the user lifecycle, then let the real
# task-creator read and advance the same contribution store.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
CLIENT="$REPO_ROOT/client"
PLUGIN="$REPO_ROOT/packages/plugin"
CORE="$REPO_ROOT/packages/core"
LAYER="$REPO_ROOT/packages/layer"
HERMES_UPSTREAM_SHA="9df5f879b4a5925c0f8f947e7e16ed8e845932c3"
WORK="$(mktemp -d)"
export JINN_STAGE1_WORK="$WORK"
export HOME="$WORK/home"
export HERMES_HOME="$HOME"
export NO_COLOR=1
export JINN_LAYER_EPISODES_DIR="$WORK/state/episodes"
export JINN_LAYER_CAPTURES_DIR="$WORK/state/captures"
export JINN_LAYER_SKILLS_INSTALL_DIR="$HERMES_HOME/skills"
export JINN_MINEABLE_STATE_DIR="$WORK/state/mineable"
mkdir -p "$HOME" "$WORK/state" "$WORK/tarballs" "$WORK/wheels"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo "Stage 1 cold-stock gate requires Node 22+ (found $(node --version))." >&2
  exit 2
fi

if [[ "${JINN_STAGE1_SKIP_CLIENT_BUILD:-0}" != "1" ]]; then
  (
    cd "$REPO_ROOT/packages/plugin"
    corepack enable
    yarn install --immutable
    yarn build
  )
  (
    cd "$REPO_ROOT/packages/core"
    corepack enable
    yarn install --immutable
    yarn build
  )
  (
    cd "$LAYER"
    corepack enable
    yarn install --immutable
    yarn build
  )
  (
    cd "$CLIENT"
    corepack enable
    yarn install --immutable
    yarn build
  )
fi

pack_local_package() {
  local package_root="$1"
  local filename
  filename="$(
    cd "$package_root" &&
    npm pack --silent --pack-destination "$WORK/tarballs"
  )"
  if [[ ! "$filename" =~ ^[A-Za-z0-9._-]+\.tgz$ ]]; then
    echo "npm pack returned an invalid filename for $package_root: $filename" >&2
    return 1
  fi
  local tarball="$WORK/tarballs/$filename"
  if [[ ! -f "$tarball" ]]; then
    echo "npm pack did not create $tarball" >&2
    return 1
  fi
  printf '%s\n' "$tarball"
}

PLUGIN_TARBALL="$(pack_local_package "$PLUGIN")"
CORE_TARBALL="$(pack_local_package "$CORE")"
LAYER_TARBALL="$(pack_local_package "$LAYER")"

# Build and install the distributable wheel. Installing the plugin source tree
# would miss packaging errors and would not represent the user-facing product.
python3 -m pip wheel --no-deps --wheel-dir "$WORK/wheels" "$REPO_ROOT/plugin/frozen"
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

PLUGIN_DIR="$(
  "$WORK/venv/bin/python" <<'PY'
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.find_spec("jinn_plugin")
assert spec is not None and spec.origin is not None
plugin_dir = Path(spec.origin).resolve().parent
assert plugin_dir.is_relative_to(Path(sys.prefix).resolve())
print(plugin_dir)
PY
)"
if [[ ! -d "$PLUGIN_DIR" || -L "$PLUGIN_DIR" ]]; then
  echo "installed jinn_plugin directory is unsafe or missing: $PLUGIN_DIR" >&2
  exit 1
fi
PLUGIN_RUNTIME="$PLUGIN_DIR/runtime"
npm install \
  --prefix "$PLUGIN_RUNTIME" \
  --loglevel=error \
  --save-exact \
  --omit=dev \
  --no-audit \
  --no-fund \
  "$PLUGIN_TARBALL" \
  "$CORE_TARBALL" \
  "$LAYER_TARBALL"
export JINN_STAGE1_LAYER_BIN="$PLUGIN_RUNTIME/node_modules/.bin/jinn-layer"
test -x "$JINN_STAGE1_LAYER_BIN"
"$JINN_STAGE1_LAYER_BIN" contract --json | grep -q '"contractVersion":1'

(
  cd "$WORK/upstream"
  "$WORK/venv/bin/python" "$HERE/scripts/stage1-stock-product.py"
)

(
  cd "$CLIENT"
  node scripts/stage1-task-creator-acceptance.mjs
)

echo "COLD STOCK STAGE 1 PRODUCT GATE PASS"
