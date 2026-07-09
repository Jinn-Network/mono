"""Jinn plugin tests — the consent gate is the product's trust surface.

The two acceptance criteria from mono issue #1312:
  - consent declined (or unset) ⇒ ZERO capture calls — no jinn-layer
    invocation, no pending file, nothing buffered;
  - consent accepted ⇒ capture on task completion, preview-gated first
    publish, per-task veto recorded locally.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
consent = importlib.import_module("plugins.jinn.consent")
capture_buffer = importlib.import_module("plugins.jinn.capture_buffer")


class RunnerSpy:
    """Records every jinn-layer invocation; returns a canned success."""

    def __init__(self, code: int = 0, out: str = "ok"):
        self.calls: list[list[str]] = []
        self.code = code
        self.out = out

    def __call__(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(argv)
        return self.code, self.out


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    capture_buffer.reset()
    jinn._vetoed_tasks.clear()
    jinn._session_hint_shown.clear()
    spy = RunnerSpy()
    jinn._runner = spy
    yield spy
    jinn._runner = None


def _start_session(session_id: str = "s1", task_id: str = "t1"):
    jinn._on_pre_llm_call(
        session_id=session_id,
        task_id=task_id,
        user_message="Fix the failing test suite",
        is_first_turn=True,
        model="test-model",
        platform="cli",
    )
    jinn._on_post_tool_call(
        tool_name="terminal",
        args={"command": "yarn test"},
        session_id=session_id,
        task_id=task_id,
        tool_call_id="call-1",
        result='{"output": "1 failed"}',
        duration_ms=50,
    )


def _run_session(session_id: str = "s1", task_id: str = "t1", completed: bool = True):
    _start_session(session_id=session_id, task_id=task_id)
    jinn._on_session_end(
        session_id=session_id, task_id=task_id, completed=completed, interrupted=False
    )


def _write_calls(spy: RunnerSpy) -> list[list[str]]:
    """Contribution-side calls only (publish/capture). Pickup's read-only
    corpus calls are allowed regardless of consent — consuming is ungated."""
    return [c for c in spy.calls if len(c) > 1 and c[1] in ("publish", "capture")]


def _pending_files(tmp_home: Path) -> list[Path]:
    d = tmp_home / "jinn" / "pending"
    return sorted(d.glob("*.json")) if d.exists() else []


# ── The gate ─────────────────────────────────────────────────────────────────

def test_unset_consent_captures_nothing(isolated_home, tmp_path):
    _run_session()
    assert _write_calls(isolated_home) == []
    assert _pending_files(tmp_path) == []


def test_declined_consent_captures_nothing(isolated_home, tmp_path):
    consent.save_state(consent.DECLINED)
    _run_session()
    assert _write_calls(isolated_home) == []
    assert _pending_files(tmp_path) == []


def test_accepted_but_unpreviewed_holds_locally(isolated_home, tmp_path, monkeypatch):
    # Fork behaviour: bin/jinn-agent exports JINN_HARNESS_NAME=jinn-agent.
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    consent.save_state(consent.ACCEPTED)
    _run_session()
    # Held for the preview-first rule: a pending file exists, nothing published.
    assert _write_calls(isolated_home) == []
    files = _pending_files(tmp_path)
    assert len(files) == 1
    task = json.loads(files[0].read_text())
    assert task["provenance"] == "contributed"
    assert task["outcome"] == {"status": "completed", "verifiabilityTier": "user-accepted"}
    assert task["task"]["summary"] == "Fix the failing test suite"
    assert task["environment"]["harness"]["name"] == "jinn-agent"
    assert task["steps"][0]["name"] == "tool:terminal"


def test_accepted_and_previewed_publishes(isolated_home, tmp_path):
    consent.save_state(consent.ACCEPTED, previewed=True)
    _run_session()
    writes = _write_calls(isolated_home)
    assert len(writes) == 1
    argv = writes[0]
    assert argv[1] == "publish"
    assert "--veto" not in argv
    # Published pending file is cleaned up.
    assert _pending_files(tmp_path) == []


def test_summary_and_model_captured_when_not_flagged_first_turn(isolated_home, tmp_path):
    """mono #1404: capture must not hinge solely on is_first_turn.

    On the Nous/OpenAI-compat path a completed session published with
    summary "(no summary)" / model "unknown". record_first_turn must run
    regardless of the is_first_turn flag so the trace keeps its metadata.
    """
    consent.save_state(consent.ACCEPTED)
    jinn._on_pre_llm_call(
        session_id="s1",
        task_id="t1",
        user_message="Search the web for X",
        is_first_turn=False,  # the failing path
        model="step-3.7-flash",
        platform="cli",
    )
    jinn._on_post_tool_call(
        tool_name="terminal",
        args={"command": "ls"},
        session_id="s1",
        task_id="t1",
        tool_call_id="c1",
        result='{"output": "ok"}',
        duration_ms=10,
    )
    jinn._on_session_end(session_id="s1", task_id="t1", completed=True, interrupted=False)
    files = _pending_files(tmp_path)
    assert len(files) == 1
    task = json.loads(files[0].read_text())
    assert task["task"]["summary"] == "Search the web for X"
    assert task["environment"]["model"] == "step-3.7-flash"


def test_veto_records_locally_and_never_publishes_content(isolated_home, tmp_path):
    consent.save_state(consent.ACCEPTED, previewed=True)
    # Veto is issued mid-session, once the task under capture has steps.
    _start_session()
    out = jinn._handle_jinn(command_args="veto", session_id="s1", task_id="t1")
    assert "This task is vetoed" in out
    jinn._on_session_end(session_id="s1", task_id="t1", completed=True, interrupted=False)
    writes = _write_calls(isolated_home)
    assert len(writes) == 1
    assert writes[0][1] == "publish"
    assert "--veto" in writes[0]


def test_veto_with_no_active_task_reports_nothing_to_veto(isolated_home):
    # mono issue #1383 — /jinn veto with nothing under capture must not
    # return the success copy (it was an in-memory no-op).
    consent.save_state(consent.ACCEPTED, previewed=True)
    out = jinn._handle_jinn(command_args="veto", session_id="s1", task_id="t1")
    assert out == (
        "No active task to veto — veto marks the task currently running in this session."
    )
    assert not jinn._vetoed_tasks


def test_publish_failure_retains_the_trace_locally(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    capture_buffer.reset()
    consent.save_state(consent.ACCEPTED, previewed=True)
    failing = RunnerSpy(code=1, out="anchor tx reverted")
    jinn._runner = failing
    try:
        _run_session()
    finally:
        jinn._runner = None
    assert len(_write_calls(failing)) == 1
    assert len(_pending_files(tmp_path)) == 1  # retained locally


def test_abandoned_session_is_marked_abandoned(isolated_home, tmp_path):
    consent.save_state(consent.ACCEPTED)
    jinn._on_pre_llm_call(
        session_id="s2", task_id="t2", user_message="x", is_first_turn=True, model="m"
    )
    jinn._on_post_tool_call(
        tool_name="terminal", args={}, session_id="s2", task_id="t2",
        tool_call_id="c", result="", duration_ms=1,
    )
    jinn._on_session_end(session_id="s2", task_id="t2", completed=False, interrupted=True)
    task = json.loads(_pending_files(tmp_path)[0].read_text())
    assert task["outcome"]["status"] == "abandoned"


# ── Draining held pending traces (mono issue #1370) ─────────────────────────
#
# The preview gate's own copy promises "then it publishes on future task
# ends" — so a task held before the preview must drain at the next
# publishing session end, not stay orphaned in the pending dir forever.

def test_unpreviewed_task_is_held_then_drained_by_next_session_end(isolated_home, tmp_path):
    consent.save_state(consent.ACCEPTED)
    _run_session(session_id="sA", task_id="tA")
    # (1) Held: file exists, nothing published.
    assert _write_calls(isolated_home) == []
    held = _pending_files(tmp_path)
    assert len(held) == 1
    held_name = held[0].name

    # (2) Preview, then a later task completes — BOTH publish.
    consent.mark_previewed()
    _run_session(session_id="sB", task_id="tB")
    publishes = [c for c in _write_calls(isolated_home) if c[1] == "publish"]
    published_names = [Path(c[2]).name for c in publishes]
    assert len(publishes) == 2
    assert held_name in published_names
    assert _pending_files(tmp_path) == []  # pending dir fully drained


def test_drain_failure_leaves_file_and_still_drains_the_rest(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    capture_buffer.reset()
    consent.save_state(consent.ACCEPTED)

    class SelectiveRunner(RunnerSpy):
        """Fails publish only for files whose name contains 'sA1'."""

        def __call__(self, argv: list[str]) -> tuple[int, str]:
            self.calls.append(argv)
            if len(argv) > 2 and argv[1] == "publish" and "sA1" in argv[2]:
                return 1, "anchor tx reverted"
            return 0, "ok"

    runner = SelectiveRunner()
    jinn._runner = runner
    try:
        # Two held tasks before the preview.
        _run_session(session_id="sA1", task_id="tA1")
        _run_session(session_id="sA2", task_id="tA2")
        assert len(_pending_files(tmp_path)) == 2
        consent.mark_previewed()
        # Must not raise despite the sA1 drain failure.
        _run_session(session_id="sB", task_id="tB")
    finally:
        jinn._runner = None

    publishes = [c for c in _write_calls(runner) if c[1] == "publish"]
    published_names = {Path(c[2]).name for c in publishes}
    # All three were attempted…
    assert published_names == {"sA1.json", "sA2.json", "sB.json"}
    # …the failed one is retained for a later retry, the rest unlinked.
    remaining = [p.name for p in _pending_files(tmp_path)]
    assert remaining == ["sA1.json"]


# ── Session-end feedback lines (mono issue #1385) ───────────────────────────
#
# Capture/publish outcomes were logger.info-only (~/.jinn-agent/logs/
# agent.log) — terminal-silent in both the TUI and -q modes. One concise
# stderr line per outcome; the TUI's patch_stdout proxy renders stderr
# above the input area, plain stderr everywhere else.

def test_session_end_held_outcome_prints_stderr_line(isolated_home, capsys):
    consent.save_state(consent.ACCEPTED)
    _run_session()
    err = capsys.readouterr().err
    assert "jinn: trace held locally — /jinn preview to see what would publish" in err


def test_session_end_published_outcome_prints_stderr_line_with_ref(isolated_home, capsys):
    consent.save_state(consent.ACCEPTED, previewed=True)
    isolated_home.out = (
        "Published.\n"
        "  ref       bafyTESTREF\n"
        "  anchor    - (anchor tx pending)\n"
        "  fetch it  jinn-layer corpus get bafyTESTREF"
    )
    _run_session()
    err = capsys.readouterr().err
    assert "jinn: contribution published — bafyTESTREF (/jinn ledger for the anchor)" in err


def test_session_end_publish_failure_prints_stderr_line_with_path(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    capture_buffer.reset()
    consent.save_state(consent.ACCEPTED, previewed=True)
    jinn._runner = RunnerSpy(code=1, out="anchor tx reverted")
    try:
        _run_session()
    finally:
        jinn._runner = None
    err = capsys.readouterr().err
    kept = _pending_files(tmp_path)[0]
    assert f"jinn: publish failed — trace kept at {kept}" in err


def test_session_end_drain_prints_one_summary_line(isolated_home, capsys):
    consent.save_state(consent.ACCEPTED)
    _run_session(session_id="sA", task_id="tA")  # held
    consent.mark_previewed()
    capsys.readouterr()  # discard the held line
    _run_session(session_id="sB", task_id="tB")  # publishes sB + drains sA
    err = capsys.readouterr().err
    assert "jinn: 1 held trace(s) published" in err
    # At most 2 user-visible lines per session end.
    assert len([l for l in err.splitlines() if l.startswith("jinn:")]) <= 2


def test_session_end_without_capture_prints_nothing(isolated_home, capsys):
    _run_session()  # consent unset — zero capture, zero terminal noise
    assert capsys.readouterr().err == ""


# ── Consent flow ─────────────────────────────────────────────────────────────

def test_consent_flow_bare_enter_defaults_to_decline(isolated_home):
    answers = iter(["", "y", ""])  # explainer -> decline confirm -> node stub skip
    printed: list[str] = []
    status = consent.run_consent_flow(lambda _: next(answers), printed.append)
    assert status == consent.DECLINED
    assert consent.capture_enabled() is False
    assert any("Contribution is OFF" in line for line in printed)


def test_consent_flow_accept_requires_deliberate_confirm(isolated_home):
    answers = iter(["a", "n", "a", "y", ""])  # accept -> back out -> accept -> confirm -> skip stub
    printed: list[str] = []
    status = consent.run_consent_flow(lambda _: next(answers), printed.append)
    assert status == consent.ACCEPTED
    assert consent.capture_enabled() is True
    assert any("Next: run /jinn preview after your first task" in line for line in printed)


def test_consent_state_survives_reload(isolated_home):
    consent.save_state(consent.ACCEPTED)
    assert consent.load_state()["status"] == consent.ACCEPTED
    consent.mark_previewed()
    state = consent.load_state()
    assert state["previewed"] is True
    assert state["status"] == consent.ACCEPTED


# ── Slash surface ────────────────────────────────────────────────────────────

def test_status_states_capture_off_by_default(isolated_home):
    out = jinn._handle_jinn(command_args="status")
    assert "consent: unset" in out
    assert "capture: OFF" in out


def test_preview_marks_previewed_and_unlocks_publish(isolated_home, tmp_path):
    consent.save_state(consent.ACCEPTED)
    _run_session()  # held pending
    out = jinn._handle_jinn(command_args="preview")
    assert "preview recorded" in out
    assert consent.load_state()["previewed"] is True
    # Preview invoked jinn-layer capture preview on the pending file.
    assert any(c[1:3] == ["capture", "preview"] for c in isolated_home.calls)


def test_corpus_command_delegates_to_layer(isolated_home):
    out = jinn._handle_corpus(command_args="prediction")
    assert out == "ok"
    assert isolated_home.calls[0][1:4] == ["corpus", "search", "prediction"]


# ── Ledger: structured render vs degrade (mono#1418) ─────────────────────────

def test_ledger_renders_structured_rows_from_json(isolated_home):
    # `jinn-layer ledger --json` yields rows → the design 1b table.
    rows = [
        {"time": "05-26 06:41", "task": "fix retry", "envelope": "env-8f21c2",
         "anchor": "0x7a2f…c019", "tier": "tests-passed"},
        {"time": "05-25 22:41", "task": "refactor auth", "state": "vetoed"},
    ]
    isolated_home.out = json.dumps(rows)
    out = jinn._handle_jinn(command_args="ledger")
    assert isolated_home.calls[0][1:3] == ["ledger", "--json"]
    assert "TIER" in out
    assert "tests-passed" in out
    assert "vetoed (local only)" in out


def test_ledger_degrades_to_raw_text_when_json_unavailable(isolated_home):
    # A layer that predates `--json`: the JSON call succeeds but is not JSON,
    # so the fork degrades to the plain `ledger` text pass-through.
    isolated_home.out = "PLAIN LEDGER TEXT (no --json support)"
    out = jinn._handle_jinn(command_args="ledger")
    assert out == "PLAIN LEDGER TEXT (no --json support)"
    # Both the --json probe and the plain ledger were attempted.
    assert ["ledger", "--json"] in [c[1:3] for c in isolated_home.calls]
    assert any(c[1:] == ["ledger"] for c in isolated_home.calls)


def test_preview_with_no_pending_shows_example_fixture(isolated_home):
    # Design requirement iv: preview is reachable before any publish. With no
    # task yet, /jinn preview shows the labelled example fixture.
    consent.save_state(consent.ACCEPTED)
    out = jinn._handle_jinn(command_args="preview")
    assert "example — no task run yet" in out
    assert "NOTHING IS SENT FROM THIS SCREEN" in out
    # It must NOT mark previewed (the real gate stays on a real trace).
    assert consent.load_state()["previewed"] is False


# ── TUI-safe consent commands (no blocking reads) ────────────────────────────

def test_slash_consent_shows_explainer_with_command_keys(isolated_home, monkeypatch):
    # Fork behaviour: bin/jinn-agent exports JINN_HARNESS_NAME=jinn-agent.
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    out = jinn._handle_jinn(command_args="consent")
    assert "jinn-agent is an open coding harness" in out
    assert "/jinn consent accept" in out
    assert consent.load_state()["status"] == consent.UNSET  # nothing recorded


def test_slash_consent_accept_requires_deliberate_confirm(isolated_home):
    out = jinn._handle_jinn(command_args="consent accept")
    assert "To confirm: /jinn consent accept confirm" in out
    assert consent.load_state()["status"] == consent.UNSET
    out = jinn._handle_jinn(command_args="consent accept confirm")
    assert "Contribution is ON" in out
    assert consent.load_state()["status"] == consent.ACCEPTED


def test_slash_consent_decline_records_reader_only(isolated_home):
    out = jinn._handle_jinn(command_args="consent decline confirm")
    assert "Contribution is OFF" in out
    assert consent.load_state()["status"] == consent.DECLINED
    assert consent.capture_enabled() is False


def test_slash_consent_never_calls_blocking_input(isolated_home, monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("blocking input() called from the slash surface")
    monkeypatch.setattr("builtins.input", boom)
    for args in ("consent", "consent accept", "consent accept confirm",
                 "consent decline", "consent decline confirm"):
        jinn._handle_jinn(command_args=args)


def test_jinn_layer_not_found_points_at_canary_tag():
    """mono#1382: bare `npm install -g @jinn-network/client` installs latest,
    which has no jinn-layer bin until stable >= 0.1.10 — the error must name
    the canary tag."""
    jinn_layer = importlib.import_module("plugins.jinn.jinn_layer")
    code, out = jinn_layer._default_runner(["definitely-not-a-real-binary-xyz"])
    assert code == 127
    assert "@jinn-network/client@canary" in out
    assert "JINN_LAYER_BIN" in out


# ── Consent copy: current state + preview next-step (mono#1384) ──────────────

def test_slash_consent_states_current_state_unset(isolated_home, monkeypatch):
    # Fork behaviour: bin/jinn-agent exports JINN_HARNESS_NAME=jinn-agent.
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    out = jinn._handle_jinn(command_args="consent")
    first_line = out.splitlines()[0]
    assert first_line == "Contribution is currently OFF (never asked)."
    assert "jinn-agent is an open coding harness" in out


def test_slash_consent_states_current_state_accepted(isolated_home, monkeypatch):
    # Fork behaviour: bin/jinn-agent exports JINN_HARNESS_NAME=jinn-agent.
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    consent.save_state(consent.ACCEPTED)
    out = jinn._handle_jinn(command_args="consent")
    assert out.splitlines()[0] == "Contribution is currently ON."
    assert "jinn-agent is an open coding harness" in out


def test_slash_consent_states_current_state_declined(isolated_home, monkeypatch):
    # Fork behaviour: bin/jinn-agent exports JINN_HARNESS_NAME=jinn-agent.
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    consent.save_state(consent.DECLINED)
    out = jinn._handle_jinn(command_args="consent")
    assert out.splitlines()[0] == "Contribution is currently OFF (declined)."
    assert "jinn-agent is an open coding harness" in out


def test_accept_confirm_names_preview_as_next_step(isolated_home):
    out = jinn._handle_jinn(command_args="consent accept confirm")
    assert "Contribution is ON" in out
    assert "Next: run /jinn preview after your first task" in out
    assert "run-a-node" not in out
    assert "Nothing to do now" not in out
