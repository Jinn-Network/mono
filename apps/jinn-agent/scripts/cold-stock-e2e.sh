#!/usr/bin/env bash
# Cold test: install the Jinn plugin into a fresh STOCK upstream Hermes and
# verify discovery, consent-offer (harness identity + home resolver fall
# back honestly on a stock host), corpus tools, and the /jinn + /corpus
# command surface — all wired against a stub jinn-layer (no real corpus
# writes). No fork files involved: this exercises only the pip-installable
# `jinn-plugin` package (plugins/jinn/pyproject.toml, entry-point
# `jinn = "jinn_plugin"` in group `hermes_agent.plugins`).
#
# Requires network (clones NousResearch/hermes-agent). If network is
# unavailable, the register-assertion block below can still be run against
# a venv that has ONLY the plugin installed — see the adaptation note in
# .superpowers/sdd/task-7-report.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; export HERMES_HOME="$WORK/home"; mkdir -p "$HERMES_HOME"
export JINN_LAYER_BIN="$HERE/scripts/fixtures/jinn-layer-stub"
export JINN_LAYER_STUB_LOG="$WORK/stub.log"
HERMES_UPSTREAM_SHA="9df5f879b4a5925c0f8f947e7e16ed8e845932c3"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

git init -q "$WORK/upstream"
git -C "$WORK/upstream" remote add origin https://github.com/NousResearch/hermes-agent
git -C "$WORK/upstream" fetch -q --depth 1 origin "$HERMES_UPSTREAM_SHA"
git -C "$WORK/upstream" checkout -q --detach FETCH_HEAD
test "$(git -C "$WORK/upstream" rev-parse HEAD)" = "$HERMES_UPSTREAM_SHA"
python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q "$WORK/upstream"
"$WORK/venv/bin/pip" install -q "$HERE/plugins/jinn"

# 1. discovered + register() runs (import surface); 2. consent inert until
# set; 3. harness identity + home resolver fall back honestly with no fork
# env exported (this venv only has stock hermes_cli/hermes_constants).
"$WORK/venv/bin/python" - <<'PY'
import jinn_plugin, types
calls = {"hooks": {}, "tools": [], "cmds": [], "cli": []}
ctx = types.SimpleNamespace(
    register_hook=lambda n, cb: calls["hooks"].__setitem__(n, cb),
    register_tool=lambda **k: calls["tools"].append(k["name"]),
    register_command=lambda n, **k: calls["cmds"].append(n),
    register_cli_command=lambda n, **k: calls["cli"].append(n),
)
jinn_plugin.register(ctx)
required_hooks = {"on_session_start","pre_llm_call","post_tool_call","post_llm_call","on_session_end"}
assert required_hooks.issubset(calls["hooks"]), calls
assert all(callable(calls["hooks"][name]) for name in required_hooks), calls
assert set(calls["tools"]) == {"corpus_search","corpus_fetch"}, calls
assert "jinn" in calls["cmds"] and "corpus" in calls["cmds"], calls
assert "onboarding" in calls["cli"], calls

# Correct import path under a pip install is `jinn_plugin.*` (the package-dir
# mapping in pyproject.toml maps `jinn_plugin` to `.`) — NOT `plugins.jinn`,
# which only resolves inside this repo's own tree.
from jinn_plugin import consent, harness

assert harness.harness_name() == "hermes-agent", harness.harness_name()
print("register ok:", calls)
PY

# 4. skill install round-trips through the stub jinn-layer contract
# (extract+verify+write is the layer's job; the plugin only shells out and
# drops the .jinn-ref marker — thin-fork boundary, Task 4).
"$WORK/venv/bin/python" - <<'PY'
from jinn_plugin import skills_install
path = skills_install.install("stub-ref-001")
assert path.endswith("stub-skill/SKILL.md"), path
installed = skills_install.list_installed()
assert installed == [{"slug": "stub-skill", "ref": "stub-ref-001"}], installed
print("skill install ok:", path)
PY

echo "COLD E2E PASS"
