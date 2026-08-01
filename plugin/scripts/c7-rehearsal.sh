#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Gate C7: a real Hermes session reaches the corpus moment against a seeded
# archive, the doctor is green, and every broken precondition names its remedy.
#
# Requires on PATH: hermes, node (>=22), npm, git, yarn.
# Publishes nothing. The runtime is installed from a local `npm pack` tarball,
# which exercises the same runtime-pin assertion as the published path; the
# real-registry acquisition is C8's extended cold-stock job.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/jinn-c7-XXXXXX")"
export HERMES_HOME="$WORK/hermes"
mkdir -p "$HERMES_HOME"
trap 'echo "rehearsal artifacts: $WORK"' EXIT

PYTHON="${PYTHON:-python3}"

step() { printf '\n=== %s ===\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

expect_fail() {
  local name="$1" needle="$2" out
  out="$(hermes jinn-doctor || true)"
  printf '%s' "$out" | grep -q "\[fail\] $name" || { printf '%s\n' "$out"; fail "$name did not fail when it should"; }
  if [ -z "$needle" ]; then
    printf '%s' "$out" | grep -q "not fixable from this machine" \
      || { printf '%s\n' "$out"; fail "$name printed a remedy where none can work"; }
  else
    printf '%s' "$out" | grep -q "$needle" \
      || { printf '%s\n' "$out"; fail "$name did not print the remedy containing: $needle"; }
  fi
}

reinstall_runtime() {
  if [ ! -d "$WORK/runtime-node_modules-snapshot/.bin" ]; then
    fail "runtime snapshot missing — rehearsal install did not complete"
  fi
  mkdir -p "$PLUGIN_DIR/runtime"
  rm -rf "$PLUGIN_DIR/runtime/node_modules"
  cp -a "$WORK/runtime-node_modules-snapshot" "$PLUGIN_DIR/runtime/node_modules"
  if [ ! -x "$PLUGIN_DIR/runtime/node_modules/.bin/jinn-plugin-runtime" ]; then
    node "$REPO_ROOT/plugin/runtime/scripts/rehearsal-install.mjs" "$WORK" "$PLUGIN_DIR/runtime" \
      || fail "could not rebuild the pinned runtime prefix"
  fi
  [ -x "$PLUGIN_DIR/runtime/node_modules/.bin/jinn-plugin-runtime" ] \
    || fail "runtime restore did not lay down jinn-plugin-runtime"
}

stop_runtime_children() {
  pkill -f "jinn-plugin-runtime" 2>/dev/null || true
  sleep 0.5
}

run_with_timeout() {
  local seconds="$1"
  shift
  "$PYTHON" -c '
import subprocess, sys
try:
  subprocess.run(sys.argv[2:], timeout=int(sys.argv[1]))
except subprocess.TimeoutExpired:
  sys.exit(124)
' "$seconds" "$@"
}

step "build the runtime"
(cd "$REPO_ROOT/plugin/runtime" && yarn install --immutable && yarn build)

step "publish the adapter to a local git remote (the install channel's shape)"
SLIM="$WORK/jinn-plugin"
mkdir -p "$SLIM"
cp -R "$REPO_ROOT/plugin/adapter-hermes/." "$SLIM/"
rm -rf "$SLIM/tests" "$SLIM/scripts" "$SLIM/pytest.ini"
(cd "$SLIM" && git init -q && git add -A && git -c user.email=c7@jinn -c user.name=c7 commit -qm "c7 rehearsal")

step "install exactly as a user would"
if hermes plugins install --help 2>&1 | grep -q -- '--yes'; then
  hermes plugins install "file://$SLIM" --yes || fail "hermes plugins install failed"
else
  hermes plugins install "file://$SLIM" || fail "hermes plugins install failed"
fi
PLUGIN_DIR="$HERMES_HOME/plugins/jinn"
[ -d "$PLUGIN_DIR" ] || fail "the plugin did not land at $PLUGIN_DIR"
hermes plugins enable jinn >/dev/null 2>&1 || true

step "install the pinned runtime from packed tarballs"
node "$REPO_ROOT/plugin/runtime/scripts/rehearsal-install.mjs" "$WORK" "$PLUGIN_DIR/runtime" \
  || fail "packed runtime install failed"
PIN_VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$PLUGIN_DIR/runtime-pin.json")"
PACK_VERSION="$(node -e 'process.stdout.write(require(process.argv[1]+"/package.json").version)' "$REPO_ROOT/plugin/runtime")"
[ "$PIN_VERSION" = "$PACK_VERSION" ] || fail "runtime-pin.json pins $PIN_VERSION but the tree builds $PACK_VERSION"
RUNTIME_BIN="$PLUGIN_DIR/runtime/node_modules/.bin/jinn-plugin-runtime"
SESSION_BIN="$PLUGIN_DIR/runtime/node_modules/.bin/jinn-plugin-runtime-session"
[ -x "$RUNTIME_BIN" ] || fail "the pinned runtime bin is missing or not executable"
[ -x "$SESSION_BIN" ] || fail "the session-host bin is missing or not executable"
cp -a "$PLUGIN_DIR/runtime/node_modules" "$WORK/runtime-node_modules-snapshot"

step "seed the archive"
export JINN_PLUGIN_HOME="$HERMES_HOME/jinn/runtime-home"
mkdir -p "$JINN_PLUGIN_HOME"
node "$REPO_ROOT/plugin/scripts/seed-archive.mjs" "$RUNTIME_BIN" "$JINN_PLUGIN_HOME" || fail "seeding failed"

step "the host can connect MCP servers"
"$PYTHON" -c "import mcp" 2>/dev/null || fail "this Hermes lacks the mcp extra; run: pip install 'hermes-agent[mcp]'"

step "inherit host inference config when present"
if [ -f "$HOME/.hermes/.env" ] && [ ! -f "$HERMES_HOME/.env" ]; then
  cp "$HOME/.hermes/.env" "$HERMES_HOME/.env"
fi
for item in auth.json auth; do
  if [ -e "$HOME/.hermes/$item" ] && [ ! -e "$HERMES_HOME/$item" ]; then
    cp -R "$HOME/.hermes/$item" "$HERMES_HOME/$item"
  fi
done
if [ -f "$HOME/.hermes/config.yaml" ] && [ -f "$HERMES_HOME/config.yaml" ]; then
  node - "$HOME/.hermes/config.yaml" "$HERMES_HOME/config.yaml" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const [srcPath, dstPath] = process.argv.slice(2);
const src = readFileSync(srcPath, "utf8");
const dst = readFileSync(dstPath, "utf8");
const modelBlock = src.match(/^model:\n(?:  .+\n)+/m)?.[0];
if (!modelBlock || /^model:/m.test(dst)) {
  process.exit(0);
}
const agentBlock = dst.match(/^agent:\n(?:  .+\n)*/m);
const merged = agentBlock
  ? dst.replace(agentBlock[0], `${modelBlock}${agentBlock[0]}`)
  : `${dst.trimEnd()}\n\n${modelBlock}`;
writeFileSync(dstPath, merged.endsWith("\n") ? merged : `${merged}\n`);
NODE
fi

step "doctor is green"
DOCTOR="$(hermes jinn-doctor)" || fail "jinn-doctor exited non-zero"
printf '%s\n' "$DOCTOR"
printf '%s' "$DOCTOR" | grep -q "all checks passed." || fail "the doctor is not green on a correct install"

step "a real session reaches the corpus moment"
SESSION_LOG="$WORK/session.log"
run_with_timeout 180 hermes chat -Q -q "the vitest suite fails intermittently on CI but passes locally" \
  >"$SESSION_LOG" 2>&1 || true
grep -q "corpus" "$SESSION_LOG" || { cat "$SESSION_LOG"; fail "no corpus line in a real session (residual: hermes chat corpus moment — model/API or plugin hooks)"; }
grep -q "provided" "$SESSION_LOG" || { cat "$SESSION_LOG"; fail "the corpus line reported no packets against a seeded archive"; }

stop_runtime_children
reinstall_runtime

step "the session was captured"
node - "$JINN_PLUGIN_HOME" <<'NODE' || fail "no capture landed for the live session"
import { readdir } from "node:fs/promises";
const [home] = process.argv.slice(2);
const sessions = await readdir(`${home}/capture/sessions`);
if (sessions.filter((name) => !name.startsWith("seed-")).length === 0) {
  console.error("no non-seed capture session directory");
  process.exit(1);
}
console.log(`captured ${sessions.length} session(s)`);
NODE

step "break each precondition and read the remedy"
stop_runtime_children
reinstall_runtime

RUNTIME_BIN_PATH="$PLUGIN_DIR/runtime/node_modules/.bin/jinn-plugin-runtime"
HIDDEN_RUNTIME_BIN="$WORK/hidden-jinn-plugin-runtime"
mv "$RUNTIME_BIN_PATH" "$HIDDEN_RUNTIME_BIN"
expect_fail "runtime-available" "hermes plugins update jinn"
reinstall_runtime

node -e '
const fs = require("node:fs");
const path = process.argv[1];
const pin = JSON.parse(fs.readFileSync(path, "utf8"));
fs.writeFileSync(path + ".bak", JSON.stringify(pin));
pin.version = "9.9.9";
fs.writeFileSync(path, JSON.stringify(pin));
' "$PLUGIN_DIR/runtime-pin.json"
expect_fail "runtime-pin" "hermes plugins update jinn"
mv "$PLUGIN_DIR/runtime-pin.json.bak" "$PLUGIN_DIR/runtime-pin.json"

rm -rf "$PLUGIN_DIR/runtime/node_modules"
node -e '
const fs = require("node:fs");
const path = process.argv[1];
const pin = JSON.parse(fs.readFileSync(path, "utf8"));
fs.writeFileSync(path + ".bak", JSON.stringify(pin));
pin.version = "0.0.0-nonexistent";
fs.writeFileSync(path, JSON.stringify(pin));
' "$PLUGIN_DIR/runtime-pin.json"
hermes chat -Q -q "trigger a registration attempt" >/dev/null 2>&1 || true
expect_fail "runtime-available" ""
mv "$PLUGIN_DIR/runtime-pin.json.bak" "$PLUGIN_DIR/runtime-pin.json"
reinstall_runtime

"$PYTHON" - "$HERMES_HOME/config.yaml" <<'PY'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
path.with_suffix(".yaml.bak").write_text(text, encoding="utf-8")
path.write_text(re.sub(r"(?ms)^mcp_servers:.*?(?=^\S|\Z)", "", text), encoding="utf-8")
PY
export JINN_PLUGIN_SKIP_HOST_CONFIG_ENSURE=1
expect_fail "host-tools" "hermes jinn-doctor"
unset JINN_PLUGIN_SKIP_HOST_CONFIG_ENSURE
mv "$HERMES_HOME/config.yaml.bak" "$HERMES_HOME/config.yaml"

step "disable stops the product"
hermes plugins disable jinn
run_with_timeout 60 hermes chat -Q -q "the vitest suite fails intermittently on CI" >"$WORK/disabled.log" 2>&1 || true
grep -q "corpus" "$WORK/disabled.log" && fail "the corpus line still rendered after disable"
hermes jinn-doctor >/dev/null 2>&1 && fail "jinn-doctor is still registered after disable"

step "remove returns to stock"
hermes plugins enable jinn >/dev/null
hermes plugins remove jinn
[ -d "$PLUGIN_DIR" ] && fail "the plugin directory survived remove"
run_with_timeout 60 hermes chat -Q -q "hello" >"$WORK/removed.log" 2>&1 || true
grep -q "corpus" "$WORK/removed.log" && fail "the corpus line rendered after remove"

printf '\nGATE C7 PASSED\n'
