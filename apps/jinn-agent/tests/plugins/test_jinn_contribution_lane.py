"""Contribution lane — publish/preview/veto/status against the real single-
consent path (Jinn-Network/mono#1664).

Post-#1714 there is ONE lane: the share_enabled() publish path in
_on_session_end. It is gated on the single shareConsent, preview-gated on
`previewed`, and veto-honored via _vetoed_tasks. These tests pin:

AC2 — first publish is preview-gated (held), subsequent publishes silent.
AC3 — /jinn veto withholds the current session's trace (recorded locally,
      never published).
AC4 — a held pre-publish trace reads `contribution: recorded` in /jinn status
      with no error line; absent held trace → no such line, no error.
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
consent = importlib.import_module("plugins.jinn.consent")
capture_buffer = importlib.import_module("plugins.jinn.capture_buffer")


class RunnerSpy:
    """Answers every jinn-layer verb with (code, out). argv[0] is the binary;
    the verb is argv[1]."""

    def __init__(self, code: int = 0, out: str = "ok"):
        self.calls: list[list[str]] = []
        self.code = code
        self.out = out

    def __call__(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(argv)
        return self.code, self.out

    def publish_calls(self) -> list[list[str]]:
        return [c for c in self.calls if len(c) > 1 and c[1] == "publish"]


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    capture_buffer.reset()
    jinn._vetoed_tasks.clear()
    jinn._session_hint_shown.clear()
    spy = RunnerSpy()
    jinn._runner = spy
    yield spy
    jinn._runner = None


def _share_on():
    """Single sharing consent ON (post-#1714). previewed stays False."""
    consent.save_state(True)


def _start_session(session_id="s1", task_id="t1"):
    jinn._on_pre_llm_call(
        session_id=session_id, task_id=task_id,
        user_message="Fix the failing test suite", is_first_turn=False,
        model="test-model", platform="cli",
    )
    jinn._on_post_tool_call(
        tool_name="terminal", args={"command": "yarn test"},
        session_id=session_id, task_id=task_id, tool_call_id="call-1",
        result='{"output": "1 failed"}', duration_ms=50,
    )


def _end_session(session_id="s1", task_id="t1"):
    jinn._on_session_end(
        session_id=session_id, task_id=task_id, completed=True, interrupted=False,
    )


def _pending_files() -> list[Path]:
    d = jinn._pending_dir()
    return sorted(d.glob("*.json")) if d.exists() else []


# ── AC2 — preview-gated first publish, then silent ───────────────────────────

def test_first_publish_is_held_until_previewed(isolated_home):
    _share_on()  # previewed is False
    _start_session()
    _end_session()
    # Held: the trace sits in the pending dir, nothing published yet.
    assert isolated_home.publish_calls() == []
    assert len(_pending_files()) == 1


def test_publishes_after_preview_and_is_silent_next_time(isolated_home):
    _share_on()
    consent.mark_previewed()
    _start_session(session_id="s1", task_id="t1")
    _end_session(session_id="s1", task_id="t1")
    assert len(isolated_home.publish_calls()) == 1  # published, no re-preview

    # A subsequent session publishes silently — no second preview gate.
    _start_session(session_id="s2", task_id="t2")
    _end_session(session_id="s2", task_id="t2")
    assert len(isolated_home.publish_calls()) == 2
    assert consent.load_state()["previewed"] is True


# ── AC3 — /jinn veto withholds the current session's trace ───────────────────

def test_veto_withholds_the_current_session(isolated_home):
    _share_on()
    consent.mark_previewed()
    _start_session()
    out = jinn._handle_jinn(command_args="veto", session_id="s1", task_id="t1")
    assert "This task is vetoed" in out
    _end_session()
    # The publish path took the veto branch: a veto-record call fired, but no
    # plain publish left the machine. The veto branch calls publish(..., veto=True)
    # — assert nothing published WITHOUT the veto flag.
    plain_publish = [
        c for c in isolated_home.publish_calls()
        if "--veto" not in c and "veto" not in c[2:]
    ]
    assert plain_publish == []


# ── AC4 — held trace reads `recorded` in /jinn status, no error ──────────────

def test_status_reads_recorded_when_trace_held(isolated_home):
    _share_on()  # previewed False → the trace is held, not published
    _start_session()
    _end_session()
    out = jinn._handle_jinn(command_args="status")
    assert "contribution: recorded" in out
    assert "error" not in out.lower()
    assert "unavailable" not in out.lower()


def test_status_has_no_recorded_line_when_no_trace(isolated_home):
    _share_on()
    out = jinn._handle_jinn(command_args="status")
    assert "contribution: recorded" not in out
    assert "error" not in out.lower()
