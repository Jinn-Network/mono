# Cold-stock Install Lifecycle Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the blocking cold-stock gate through stock Hermes's real local git install, interactive enable, doctor, and remove lifecycle while preserving the existing wheel-based Stage 1 journey.

**Architecture:** The shell gate creates a temporary root-layout git repository from the Jinn plugin source, matching the slim release channel without contacting or mutating a production repository. A Python acceptance driver invokes the pinned stock-Hermes CLI through a PTY for the real enable prompt, loads the installed directory plugin through `PluginManager`, exercises each plugin-side doctor precondition red then green, and removes the plugin through the CLI. The existing wheel install and Stage 1 product/daemon drivers run afterward unchanged, so both distribution boundaries remain covered without a duplicate-plugin discovery collision.

**Tech Stack:** Bash, Python 3.11 standard library, pinned stock Hermes, Node.js 22, pytest.

## Global Constraints

- Scope only issue #1820; do not add A5 corpus doctor probes or alter production install behavior.
- Use only a temporary `file://` git repository and local fixture services; never mutate a live plugin install or production network.
- Preserve pinned stock Hermes SHA `9df5f879b4a5925c0f8f947e7e16ed8e845932c3`.
- Preserve the existing wheel-based Stage 1 journey and daemon-side acceptance leg.
- Keep `.github/workflows/jinn-agent-ci.yml` blocking: no `continue-on-error: true`.
- Use Node.js 22 or newer.

---

### Task 1: Add the regression contract for the extended journey

**Files:**
- Modify: `apps/jinn-agent/tests/plugins/test_jinn_stage1_acceptance_gate.py`
- Test: `apps/jinn-agent/tests/plugins/test_jinn_stage1_acceptance_gate.py`

**Interfaces:**
- Consumes: the cold-stock shell script and the new onboarding driver as text artifacts.
- Produces: a static regression fence requiring the real CLI install/enable/remove path and preserving the old Stage 1 drivers.

- [ ] **Step 1: Write the failing test**

Add assertions that the cold-stock script creates a local git plugin channel, passes its `file://` URI to a repository-owned onboarding driver before the wheel install, and still invokes `stage1-stock-product.py` plus `stage1-task-creator-acceptance.mjs`. Assert the onboarding driver contains the stock-Hermes commands `plugins install`, `jinn-doctor`, and `plugins remove`, the enable prompt text, banner text, and the doctor check names.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
cd apps/jinn-agent
./scripts/run_tests.sh tests/plugins/test_jinn_stage1_acceptance_gate.py -q
```

Expected: FAIL because the onboarding driver and real CLI lifecycle are absent.

- [ ] **Step 3: Commit only after the implementation turns the regression green**

The test and implementation ship in one test-shaped commit after Task 3.

### Task 2: Add the real stock-Hermes onboarding acceptance driver

**Files:**
- Create: `apps/jinn-agent/scripts/cold-stock-onboarding.py`
- Test: `apps/jinn-agent/tests/plugins/test_jinn_stage1_acceptance_gate.py`

**Interfaces:**
- Consumes: `JINN_HERMES_BIN`, `JINN_PLUGIN_CHANNEL`, `HERMES_HOME`, `JINN_LAYER_BIN`, and Node 22 on `PATH`.
- Produces: an installed-and-enabled real user plugin during the run, a doctor red→green transcript asserted in-process, then a removed plugin and stock-silent state.

- [ ] **Step 1: Drive the real enable prompt through a PTY**

Spawn:

```python
[hermes_bin, "plugins", "install", plugin_channel.as_uri()]
```

with stdin/stdout/stderr connected to a pseudo-terminal. Wait for `Enable 'jinn' now? [y/N]:`, send `y`, require exit code zero, and assert the CLI reports the plugin enabled.

- [ ] **Step 2: Prove the installed source owns the product boundary**

Require `$HERMES_HOME/plugins/jinn/.git`, inspect `config.yaml` for `plugins.enabled: [jinn]`, load a fresh `PluginManager`, and assert the loaded `jinn` manifest source is `user` and its module path is under the installed plugin directory.

- [ ] **Step 3: Assert the real first-session banner**

Invoke the registered `on_session_start` hook once under redirected stderr and assert:

```text
jinn ready — 4 checks passed
◇ corpus
silence means nothing relevant yet
commands: /jinn · re-check: /jinn doctor
```

- [ ] **Step 4: Exercise every current plugin-side doctor precondition red→green**

Run `hermes jinn-doctor` for the healthy baseline and after each isolated mutation:

- temporarily invalidate git `HEAD` → `[fail] plugin-build` → restore → `[ok  ] plugin-build`;
- point `JINN_LAYER_BIN` to an absent path → `[fail] layer-available` → restore → `[ok  ] layer-available`;
- point it to an executable v999 contract stub → `[fail] layer-contract` → restore → `[ok  ] layer-contract`;
- put a Node-version shim first on `PATH` that reports v20 for `--version` but delegates other invocations to the real Node 22 binary → `[fail] prerequisites` → restore → `[ok  ] prerequisites`.

Every failure assertion also requires exactly one rendered `remedy:` line for its check. `host-provider` remains an informational full-run pointer. Corpus-down and no-result behavior remain covered by the existing Stage 1 driver because the A5 corpus doctor probes are not present on this base.

- [ ] **Step 5: Remove through the real CLI and prove stock silence**

Run:

```python
[hermes_bin, "plugins", "remove", "jinn"]
```

Require the installed directory to be gone, `plugins list --user --plain` to report no user plugins, and a fresh `PluginManager` to contain no `jinn` plugin.

### Task 3: Wire the new leg into the hermetic shell gate

**Files:**
- Modify: `apps/jinn-agent/scripts/cold-stock-e2e.sh`
- Test: `apps/jinn-agent/tests/plugins/test_jinn_stage1_acceptance_gate.py`

**Interfaces:**
- Consumes: the monorepo plugin source tree and the pinned stock-Hermes virtual environment.
- Produces: a temporary root-layout git source at `$JINN_STAGE1_WORK`, then the unchanged wheel/product/daemon legs.

- [ ] **Step 1: Create the install-equivalent local channel**

Copy only `apps/jinn-agent/plugins/jinn/` into a temporary repository root, initialize git, configure fixture identity, and commit. Export its path as `JINN_PLUGIN_CHANNEL`.

- [ ] **Step 2: Run the local-channel journey before installing the wheel**

After stock Hermes is installed in the virtual environment, export `JINN_HERMES_BIN=$WORK/venv/bin/hermes` and invoke:

```bash
"$WORK/venv/bin/python" "$HERE/scripts/cold-stock-onboarding.py"
```

The driver removes the user plugin before the wheel is installed, preventing entry-point precedence from hiding the real directory plugin.

- [ ] **Step 3: Preserve the existing journey**

Install the already-built wheel and run `stage1-stock-product.py`, followed by `stage1-task-creator-acceptance.mjs`, exactly as before. Keep the existing corpus-down and `knowledge searched · nothing relevant found` assertions.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
cd apps/jinn-agent
./scripts/run_tests.sh tests/plugins/test_jinn_stage1_acceptance_gate.py -q
bash scripts/cold-stock-e2e.sh
```

Expected: both commands exit 0; cold-stock ends with `COLD STOCK STAGE 1 PRODUCT GATE PASS`.

- [ ] **Step 5: Run affected suites**

Run:

```bash
cd apps/jinn-agent
./scripts/run_tests.sh --files tests/plugins/test_jinn_stage1_acceptance_gate.py:tests/plugins/test_jinn_stock_load.py:tests/plugins/test_jinn_doctor.py:tests/plugins/test_jinn_pickup.py:tests/plugins/test_jinn_session_view.py -j 4 --file-timeout 1200 -q
```

Expected: zero failures.

- [ ] **Step 6: Commit**

```bash
git add \
  apps/jinn-agent/scripts/cold-stock-e2e.sh \
  apps/jinn-agent/scripts/cold-stock-onboarding.py \
  apps/jinn-agent/tests/plugins/test_jinn_stage1_acceptance_gate.py \
  docs/superpowers/plans/2026-07-20-1820-cold-stock-extension.md
git commit -m "test(jinn-agent): extend cold-stock install lifecycle"
```
