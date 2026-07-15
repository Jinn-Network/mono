"""Current-session and session-completion product legibility."""

from __future__ import annotations

import importlib
import re

import pytest

jinn = importlib.import_module("plugins.jinn")
buf = importlib.import_module("plugins.jinn.capture_buffer")
session_view = importlib.import_module("plugins.jinn.session_view")

_ANSI = re.compile(r"\033\[[0-9;]*m")


def _plain(value: str) -> str:
    return _ANSI.sub("", value)


@pytest.fixture(autouse=True)
def reset(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("NO_COLOR", "1")
    buf.reset()
    jinn._reset_session_state()
    yield
    buf.reset()
    jinn._reset_session_state()


def test_current_session_renders_all_stage_1_state():
    out = _plain(session_view.render_current(
        activity={
            "surfacedRefs": ["knowledge/ref-a", "knowledge/ref-b"],
            "fetchedRefs": ["knowledge/ref-a"],
            "installedSkillRefs": ["knowledge/ref-a"],
        },
        capture_active=True,
        share_enabled=False,
    ))

    assert "Jinn session" in out
    assert "2 surfaced · 1 fetched · 1 installed" in out
    assert "capture active" in out
    assert "eligibility pending until session end" in out
    assert "contribution pending until session end · publication OFF" in out
    assert "local learning reserves this capture at session end" in out


def test_current_session_nothing_found_yet_is_explicit():
    out = _plain(session_view.render_current(
        activity={"surfacedRefs": [], "fetchedRefs": [], "installedSkillRefs": []},
        capture_active=False,
        share_enabled=True,
    ))
    assert "nothing relevant found yet" in out
    assert "capture waiting for ordinary work" in out


def test_current_session_does_not_call_directly_fetched_knowledge_nothing():
    out = _plain(session_view.render_current(
        activity={
            "surfacedRefs": [],
            "fetchedRefs": ["knowledge/direct-ref"],
            "installedSkillRefs": [],
        },
        capture_active=True,
        share_enabled=False,
    ))
    assert "0 surfaced · 1 fetched · 0 installed" in out
    assert "nothing relevant found" not in out


def test_session_end_renders_nothing_found_capture_learning_and_contribution():
    out = _plain(session_view.render_complete(
        summary={
            "surfacedRefs": [],
            "fetchedRefs": [],
            "installedSkillRefs": [],
            "nothingFound": True,
            "eligibility": {
                "eligible": True,
                "reason": "accepted diff on a public repository",
            },
        },
        activity={"surfacedRefs": [], "fetchedRefs": [], "installedSkillRefs": []},
        capture_status="captured",
        local_learning_status="pending",
        contribution={"status": "ok", "value": {"status": "recorded"}},
    ))
    assert "Jinn session complete" in out
    assert "nothing relevant found" in out
    assert "episode captured" in out
    assert "local learning pending" in out
    assert "eligibility eligible — accepted diff on a public repository" in out
    assert "contribution recorded" in out


def test_session_end_renders_relevant_knowledge_and_used_refs():
    out = _plain(session_view.render_complete(
        summary={
            "surfacedRefs": ["knowledge/ref-a", "knowledge/ref-b"],
            "fetchedRefs": ["knowledge/ref-a"],
            "installedSkillRefs": ["knowledge/ref-a"],
            "nothingFound": False,
            "eligibility": {"eligible": False, "reason": "no accepted diff"},
        },
        activity={},
        capture_status="captured",
        local_learning_status="pending",
        contribution={"status": "ok", "value": {"status": "queued"}},
    ))
    assert "2 surfaced · 1 fetched · 1 installed" in out
    assert "surfaced knowledge/ref-a, knowledge/ref-b" in out
    assert "used knowledge/ref-a" in out
    assert "contribution queued" in out


def test_session_end_distinguishes_no_candidate_from_unavailable_pipeline():
    out = _plain(session_view.render_complete(
        summary=None,
        activity={},
        capture_status="captured-locally",
        local_learning_status="off",
        contribution=None,
        candidate_created=False,
    ))
    assert "episode captured locally — process bridge degraded" in out
    assert "local learning off" in out
    assert "eligibility unavailable" in out
    assert "contribution no reusable public-task candidate" in out


def test_jinn_session_reads_the_live_buffer_and_activity(monkeypatch):
    state = jinn._state_for("s1")
    state["activity"] = {
        "surfacedRefs": ["knowledge/ref-a"],
        "fetchedRefs": ["knowledge/ref-a"],
        "installedSkillRefs": [],
    }
    buf.record_first_turn("t1", "s1", "fix retry", "model", "cli")
    buf.record_user_turn("t1", "s1", "fix retry")
    monkeypatch.setattr(jinn.consent, "share_enabled", lambda: False)

    out = _plain(jinn._handle_jinn(
        command_args="session", session_id="s1", task_id="t1"
    ))
    assert "1 surfaced · 1 fetched · 0 installed" in out
    assert "capture active" in out
