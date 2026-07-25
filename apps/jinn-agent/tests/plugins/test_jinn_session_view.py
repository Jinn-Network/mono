"""Current-session and session-completion product legibility (searched → provided)."""

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
    monkeypatch.delenv("JINN_VERBOSE", raising=False)
    buf.reset()
    jinn._reset_session_state()
    yield
    buf.reset()
    jinn._reset_session_state()


def test_current_session_renders_operator_facing_pickup_summary():
    out = _plain(session_view.render_current(
        activity={
            "searchedTerms": ["dashboard", "vitest"],
            "providedRefs": ["knowledge/ref-a"],
        },
        capture_active=True,
    ))

    assert "Jinn" in out
    assert "Used 1 prior note from your local Jinn history" in out
    assert "capture active" not in out
    assert "contribution" not in out


def test_current_session_nothing_found_yet_is_explicit():
    out = _plain(session_view.render_current(
        activity={"searchedTerms": [], "providedRefs": []},
        capture_active=False,
    ))
    assert "No relevant prior notes yet" in out
    assert "contribution" not in out


def test_current_session_searched_but_nothing_provided_is_honest():
    out = _plain(session_view.render_current(
        activity={"searchedTerms": ["quasar", "unobtainium"], "providedRefs": []},
        capture_active=True,
    ))
    assert "No relevant prior notes found" in out
    assert "quasar" not in out


def test_current_session_verbose_includes_protocol_detail(monkeypatch):
    monkeypatch.setenv("JINN_VERBOSE", "1")
    out = _plain(session_view.render_current(
        activity={
            "searchedTerms": ["dashboard", "vitest"],
            "providedRefs": ["knowledge/ref-a"],
        },
        capture_active=True,
    ))
    assert "knowledge searched dashboard, vitest · provided 1 (knowledge/ref-a)" in out
    assert "capture active" in out
    assert "contribution parked · nothing leaves this machine" in out


def test_session_end_renders_published_contribution_in_default_mode():
    out = _plain(session_view.render_complete(
        summary=None,
        activity={},
        capture_status="captured",
        local_learning_status="pending",
        contribution={
            "status": "ok",
            "value": {"recordId": "episode-1", "status": "published"},
        },
    ))
    assert "jinn: contribution published — immutable" in out
    assert "episode captured" not in out


def test_session_end_renders_operator_facing_outcome():
    out = _plain(session_view.render_complete(
        summary={
            "searchedTerms": ["quasar"],
            "providedPackets": [],
            "nothingFound": True,
            "eligibility": {
                "eligible": True,
                "reason": "accepted diff on a public repository",
            },
        },
        activity={"searchedTerms": ["quasar"], "providedRefs": []},
        capture_status="captured",
        local_learning_status="pending",
        contribution={"status": "ok", "value": {"status": "recorded"}},
    ))
    assert "Jinn" in out
    assert "No relevant prior notes found" in out
    assert "Saved this session for next time" in out
    assert "episode captured" not in out
    assert "contribution recorded" not in out
    assert "local learning" not in out


def test_session_end_renders_used_notes_and_save_line():
    out = _plain(session_view.render_complete(
        summary={
            "searchedTerms": ["dashboard", "vitest", "flake"],
            "providedPackets": [{"ref": "bafySourceEpisode", "title": "Fix the dashboard flake"}],
            "nothingFound": False,
            "eligibility": {"eligible": False, "reason": "no accepted diff"},
        },
        activity={},
        capture_status="captured",
        local_learning_status="pending",
        contribution={"status": "ok", "value": {"status": "queued"}},
    ))
    assert "Used 1 prior note from your local Jinn history" in out
    assert "Saved this session for next time" in out
    assert "contribution queued" not in out


def test_session_end_verbose_includes_protocol_detail(monkeypatch):
    monkeypatch.setenv("JINN_VERBOSE", "1")
    out = _plain(session_view.render_complete(
        summary={
            "searchedTerms": ["quasar"],
            "providedPackets": [],
            "nothingFound": True,
            "eligibility": {
                "eligible": True,
                "reason": "accepted diff on a public repository",
            },
        },
        activity={"searchedTerms": ["quasar"], "providedRefs": []},
        capture_status="captured",
        local_learning_status="pending",
        contribution={"status": "ok", "value": {"status": "recorded"}},
    ))
    assert "knowledge searched · nothing relevant found" in out
    assert "episode captured" in out
    assert "local learning pending" in out
    assert "eligibility eligible — accepted diff on a public repository" in out
    assert "contribution recorded" in out


def test_session_end_verbose_distinguishes_no_candidate_from_unavailable_pipeline(monkeypatch):
    monkeypatch.setenv("JINN_VERBOSE", "1")
    out = _plain(session_view.render_complete(
        summary=None,
        activity={},
        capture_status="captured-locally",
        local_learning_status="off",
        contribution=None,
        candidate_created=False,
    ))
    assert "Saved this session locally" in out
    assert "episode captured locally — process bridge degraded" in out
    assert "local learning off" in out
    assert "eligibility unavailable" in out
    assert "contribution no reusable public-task candidate" in out


def test_session_end_falls_back_to_activity_when_summary_is_absent():
    out = _plain(session_view.render_complete(
        summary=None,
        activity={"searchedTerms": ["dashboard"], "providedRefs": ["bafySourceEpisode"]},
        capture_status="captured-locally",
        local_learning_status="pending",
        contribution=None,
        candidate_created=True,
    ))
    assert "Used 1 prior note from your local Jinn history" in out
    assert "Saved this session locally" in out


def test_jinn_session_reads_the_live_buffer_and_activity(monkeypatch):
    state = jinn._state_for("s1")
    lifecycle_token = jinn._current_session_lifecycle_token("s1")
    state["activity"] = {
        "searchedTerms": ["dashboard"],
        "providedRefs": ["knowledge/ref-a"],
        "surfacedRefs": [],
        "fetchedRefs": [],
    }
    buf.record_first_turn(
        "t1",
        "s1",
        "fix retry",
        "model",
        "cli",
        lifecycle_token=lifecycle_token,
    )
    buf.record_user_turn(
        "t1",
        "s1",
        "fix retry",
        lifecycle_token=lifecycle_token,
    )
    monkeypatch.setattr(jinn.consent, "share_enabled", lambda: False)

    out = _plain(jinn._handle_jinn(
        command_args="session", session_id="s1", task_id="t1"
    ))
    assert "Used 1 prior note from your local Jinn history" in out
    assert "capture active" not in out


def test_boundary_no_installed_skill_state_anywhere_in_session_rendering():
    complete = _plain(session_view.render_complete(
        summary={
            "searchedTerms": ["dashboard"],
            "providedPackets": [{"ref": "bafyRef1", "title": "x"}],
            "nothingFound": False,
            "eligibility": {"eligible": True, "reason": "ok"},
        },
        activity={},
        capture_status="captured",
        local_learning_status="pending",
        contribution={"status": "ok", "value": {"status": "recorded"}},
    ))
    current = _plain(session_view.render_current(
        activity={"searchedTerms": ["dashboard"], "providedRefs": ["bafyRef1"]},
        capture_active=True,
    ))
    for out in (complete, current):
        assert "installed" not in out.lower()
        assert "skill" not in out.lower()
