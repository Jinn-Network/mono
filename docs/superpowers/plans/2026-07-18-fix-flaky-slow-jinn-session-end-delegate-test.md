# Fix flaky/slow test_jinn_session_end_delegate.py Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the unbounded real-subprocess seam in
`apps/jinn-agent/tests/plugins/test_jinn_session_end_delegate.py` so the file
runs in single-digit seconds, deterministically, with zero real
`jinn-layer` spawns — resolving GitHub issue #1783.

**Architecture:** The file's autouse `reset` fixture currently leaves
`jinn._runner = None`. One test
(`test_vetoed_hook_sends_candidate_and_clears_marker_only_after_veto_receipt`)
never sets `jinn._runner`, so `_on_session_end` falls through to
`distill.cached_mode(None)` → `distill_status(None)` →
`jinn_layer.run(..., runner=None)` → the real `_default_runner`, which
`subprocess.run`s an actually-installed `jinn-layer` binary against the
operator's real `~/.jinn-client` state (120s timeout, PATH/HOME preserved by
`env -i`). Fix: monkeypatch `jinn_layer._default_runner` in the fixture to a
fake that returns `(127, "", "jinn-layer disabled by test fixture")` — same
shape as the existing `FileNotFoundError` branch — so no test in the file can
ever reach a real subprocess, regardless of whether it sets `jinn._runner`.
Add `distill.reset()` to the fixture for cache hygiene, matching the sibling
`test_jinn_distill_command.py` pattern. Add a lightweight regression signal
(a spawn-guard on `subprocess.run`) proving the seam is closed, and verify
timing empirically.

**Tech Stack:** Python, pytest, `monkeypatch` fixture; test lives under
`apps/jinn-agent/tests/plugins/`; run via `scripts/run_tests.sh` (canonical,
`env -i` hermetic wrapper) or bare `pytest`.

## Global Constraints

- Effort: Medium (per issue #1783 triage). Keep the change surgical — this
  is a `test`-shape issue: touch only the fixture (and, if needed, one
  assertion), not production code (`plugins/jinn/__init__.py`,
  `plugins/jinn/distill.py`, `plugins/jinn/jinn_layer.py`) and not the other
  tests' bodies.
- No commits — this is the Plan stage only. (Note: the execution phase that
  follows this plan will commit; this plan document itself must not.)
- Match existing style: monkeypatch layering must not break
  `test_delegate_parses_normally_when_stderr_carries_a_warning`, which
  itself calls `monkeypatch.setattr(jinn.jinn_layer, "_default_runner", ...)`
  — pytest's `monkeypatch` fixture supports multiple `setattr` calls on the
  same target within one test function; the test's own override simply wins
  for the duration of that test (fixture-level patch is applied first, then
  the test-level patch overwrites it — no restore-order conflict since both
  unwind via the same monkeypatch stack in LIFO order at teardown).
- Acceptance criteria (from issue #1783), each mapped to a task below:
  1. Root cause identified — already done in the design stage (see Architecture
     above); no task needed, but Task 1 asserts it in test form.
  2. The test runs in single-digit seconds deterministically, or is
     restructured so the slow path is covered without wall-clock cost — Task 2
     (fixture hardening) + Task 3 (verification).

---

## File Structure

- Modify: `apps/jinn-agent/tests/plugins/test_jinn_session_end_delegate.py`
  — only the `reset` fixture (lines 102–114) and, if the spawn-guard needs a
  home, a new small helper/test near the top of the file. No other test
  bodies change.

No new files. No production code changes.

---

### Task 1: Add a spawn-guard regression test proving the real-subprocess seam is closed

**Files:**
- Modify: `apps/jinn-agent/tests/plugins/test_jinn_session_end_delegate.py`
- Test: same file (this task *is* the test)

**Interfaces:**
- Consumes: `jinn._on_session_end`, `jinn._on_pre_llm_call`,
  `jinn._on_post_tool_call`, `jinn._record_veto` (all already imported via
  `jinn = importlib.import_module("plugins.jinn")` at the top of the file),
  `jinn.jinn_layer._default_runner` (target of the guard).
- Produces: nothing new consumed by later tasks — this is a leaf regression
  test. It must be written to **fail against the current (unfixed) fixture**
  so it proves the bug, then verified to pass once Task 2 lands.

This test is the acceptance-criterion-1 artifact: it demonstrates in
executable form that the root cause (a real `subprocess.run` reachable via
`jinn._runner = None` → `distill.cached_mode` → `_default_runner`) is closed,
and will regress loudly (via a monkeypatched `subprocess.run` raising) if
anyone reintroduces an un-patched code path to the real runner.

- [ ] **Step 1: Write the failing test**

Add this test to
`apps/jinn-agent/tests/plugins/test_jinn_session_end_delegate.py`, placed
directly after `test_vetoed_hook_sends_candidate_and_clears_marker_only_after_veto_receipt`
(after line 261, before the `_drive_hook` helper at line 264):

```python
def test_no_real_subprocess_is_ever_spawned_by_this_file(monkeypatch):
    """mono#1783: `_on_session_end` with `jinn._runner = None` used to fall
    through to `distill.cached_mode(None)` -> `jinn_layer._default_runner`,
    which genuinely shells out to an installed `jinn-layer` binary (up to a
    120s timeout) against the operator's real ~/.jinn-client state. The
    `reset` fixture now monkeypatches `_default_runner` itself so this path
    is unreachable; assert that guarantee directly by failing loudly if
    `subprocess.run` is ever invoked while this test executes."""
    import subprocess as subprocess_module

    def guard(*_args, **_kwargs):
        raise AssertionError(
            "real subprocess.run was invoked — the jinn_layer._default_runner "
            "seam is not closed (mono#1783 regression)"
        )

    monkeypatch.setattr(subprocess_module, "run", guard)

    candidate = {
        "schemaVersion": "jinn.contribution-candidate.v1",
        "sourceId": "filled-by-test",
    }
    monkeypatch.setattr(
        jinn.session_bridge, "build_contribution_candidate", lambda *_a, **_k: candidate
    )
    monkeypatch.setattr(jinn.distill, "tee_capture", lambda *_a, **_k: None)
    jinn._runner = None  # deliberately unset, exercising the real-runner path

    _drive_hook()  # must complete without ever touching subprocess.run
```

- [ ] **Step 2: Run it to confirm it currently fails (proves the bug)**

Run (against the *unmodified* fixture, before Task 2):

```bash
cd apps/jinn-agent
scripts/run_tests.sh tests/plugins/test_jinn_session_end_delegate.py::test_no_real_subprocess_is_ever_spawned_by_this_file -v
```

Expected: FAIL with `AssertionError: real subprocess.run was invoked — the
jinn_layer._default_runner seam is not closed (mono#1783 regression)`, and
the run itself is slow (multi-second, mirroring the flake) because the
guard fires only after `subprocess.run` is actually called — confirm this
matches the described root cause before proceeding.

- [ ] **Step 3: Leave the test in place** (no code change yet — this step is
  just confirmation). Move to Task 2 to make it pass.

---

### Task 2: Harden the `reset` fixture to eliminate the real-subprocess seam

**Files:**
- Modify: `apps/jinn-agent/tests/plugins/test_jinn_session_end_delegate.py:102-114`

**Interfaces:**
- Consumes: `jinn.jinn_layer._default_runner` (the function being patched —
  signature `(argv: List[str], cwd: Optional[str] = None, input:
  Optional[str] = None, timeout_s: int = _TIMEOUT_S) -> Tuple[int, str,
  str]`, per `apps/jinn-agent/plugins/jinn/jinn_layer.py:35-40`), `distill.reset()`
  (per `apps/jinn-agent/plugins/jinn/distill.py:56-59`).
- Produces: every test in the file now runs with `jinn_layer._default_runner`
  pre-patched to a fake that never touches `subprocess`. Tests that install
  their own `monkeypatch.setattr(jinn.jinn_layer, "_default_runner", ...)`
  (i.e. `test_delegate_parses_normally_when_stderr_carries_a_warning`) simply
  overwrite the fixture's patch for their duration — no interface change
  needed there.

- [ ] **Step 1: Edit the fixture**

Replace lines 102–114 of
`apps/jinn-agent/tests/plugins/test_jinn_session_end_delegate.py`:

```python
@pytest.fixture(autouse=True)
def reset(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    buf.reset()
    jinn._reset_contract_state()
    jinn._reset_session_state()
    jinn._contract_checked = True
    jinn._degraded = None
    jinn._runner = None
    yield
    jinn._runner = None
    buf.reset()
```

with:

```python
@pytest.fixture(autouse=True)
def reset(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    buf.reset()
    jinn._reset_contract_state()
    jinn._reset_session_state()
    jinn._contract_checked = True
    jinn._degraded = None
    jinn._runner = None

    def _no_real_subprocess(argv, cwd=None, input=None, timeout_s=None):
        # mono#1783: with jinn._runner unset, _on_session_end falls through
        # to distill.cached_mode -> jinn_layer._default_runner, which
        # genuinely shells out (up to a 120s timeout) to a real jinn-layer
        # binary on PATH against the operator's actual ~/.jinn-client state.
        # No test in this file may ever reach a real subprocess; individual
        # tests that need a specific _default_runner behavior override this
        # via their own monkeypatch.setattr, which layers on top.
        return 127, "", "jinn-layer disabled by test fixture"

    monkeypatch.setattr(jinn.jinn_layer, "_default_runner", _no_real_subprocess)
    jinn.distill.reset()
    yield
    jinn._runner = None
    buf.reset()
```

- [ ] **Step 2: Run the new spawn-guard test to confirm it now passes**

```bash
cd apps/jinn-agent
scripts/run_tests.sh tests/plugins/test_jinn_session_end_delegate.py::test_no_real_subprocess_is_ever_spawned_by_this_file -v
```

Expected: PASS, completing in well under 1 second.

- [ ] **Step 3: Run the full file and confirm all tests pass, including the
  self-overriding one**

```bash
cd apps/jinn-agent
scripts/run_tests.sh tests/plugins/test_jinn_session_end_delegate.py -v
```

Expected: all 8 tests (7 original + the new spawn-guard test) PASS. Pay
particular attention to
`test_delegate_parses_normally_when_stderr_carries_a_warning` (its own
`monkeypatch.setattr(jinn.jinn_layer, "_default_runner", fake_default_runner)`
must still take effect over the fixture's patch) — confirm it passes and
still exercises its own `fake_default_runner`.

- [ ] **Step 4: Commit**

```bash
git add apps/jinn-agent/tests/plugins/test_jinn_session_end_delegate.py
git commit -m "test(jinn-agent): close real-subprocess seam in session-end delegate test

mono#1783: the reset fixture left jinn._runner unset, so
test_vetoed_hook_sends_candidate_and_clears_marker_only_after_veto_receipt
fell through distill.cached_mode -> jinn_layer._default_runner and spawned
a real jinn-layer subprocess (up to 120s timeout) against the operator's
actual ~/.jinn-client state, causing the file's 70-100s intermittent
flake/slowness. Monkeypatch _default_runner in the fixture to a fake
127-exit response (same shape as the existing FileNotFoundError branch)
and add a spawn-guard regression test."
```

---

### Task 3: Verify timing and run the full jinn-agent suite

**Files:** none modified — verification only.

**Interfaces:** none.

- [ ] **Step 1: Time the target file in isolation**

```bash
cd apps/jinn-agent
time scripts/run_tests.sh tests/plugins/test_jinn_session_end_delegate.py
```

Expected: wall time in the single-digit seconds (well under 10s), and no
variance across repeated runs — run it 3 times back to back to confirm
determinism:

```bash
for i in 1 2 3; do time scripts/run_tests.sh tests/plugins/test_jinn_session_end_delegate.py; done
```

Expected: all three runs complete in a consistent, small number of seconds
(the prior symptom was 70–100s intermittently; any run now taking more than
~10s indicates the seam is not fully closed and Task 2 needs revisiting).

- [ ] **Step 2: Run the file directly under bare pytest too** (sanity check
  that the fix isn't dependent on the `env -i` wrapper — the design note's
  finding was that `env -i` *preserves* PATH/HOME, so a bare-pytest run is an
  equally valid reproduction environment and should be equally fast):

```bash
cd apps/jinn-agent
.venv/bin/python -m pytest tests/plugins/test_jinn_session_end_delegate.py -v
```

(Substitute the actual venv path if different — see
`scripts/run_tests.sh`'s venv-probe order: `.venv`, `venv`,
`~/.hermes/hermes-agent/venv`.)

Expected: PASS, fast, matching Step 1.

- [ ] **Step 3: Run the full jinn-agent test suite** to confirm no
  regressions elsewhere (other files that reference `jinn_layer` or
  `distill` are unaffected since this fix is scoped to one file's fixture):

```bash
cd apps/jinn-agent
scripts/run_tests.sh
```

Expected: full suite green, same pass count as `main`/`next` baseline plus
the one new test.

- [ ] **Step 4: Confirm acceptance criteria met**

  - Root cause identified: yes (Task 1's spawn-guard test encodes it and
    fails against the pre-fix fixture, proving the mechanism).
  - Test runs in single-digit seconds deterministically: confirmed by
    Step 1's repeated timing.

No commit in this task (verification-only); if any step fails, return to
Task 2 and fix before proceeding.

---

## Self-Review Notes

- **Spec coverage:** Both acceptance criteria mapped (Task 1 encodes root
  cause as an executable regression signal; Task 2 is the fix; Task 3
  verifies the single-digit-second, deterministic requirement). The design
  note's exact chosen approach (monkeypatch `_default_runner` to
  `(127, "", "jinn-layer disabled by test fixture")`, optional
  `distill.reset()`) is implemented verbatim in Task 2.
- **Placeholder scan:** No TBD/TODO; all steps show exact code and exact
  commands with expected output.
- **Type consistency:** `_default_runner`'s signature
  (`argv, cwd=None, input=None, timeout_s=...`) and 3-tuple return
  `(code, stdout, stderr)` match `jinn_layer.py:35-40` exactly; the fixture's
  fake preserves that shape (`(127, "", "jinn-layer disabled by test
  fixture")`), matching the existing `FileNotFoundError` branch at
  `jinn_layer.py:57-60`.
