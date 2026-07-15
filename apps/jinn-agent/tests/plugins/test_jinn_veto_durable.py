"""Veto is durable by session id; published records are immutable."""

from __future__ import annotations

import importlib
import os

import pytest

jinn = importlib.import_module("plugins.jinn")
buf = importlib.import_module("plugins.jinn.capture_buffer")


@pytest.fixture(autouse=True)
def reset(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    buf.reset()
    jinn._vetoed_tasks.clear()
    yield
    buf.reset()
    jinn._vetoed_tasks.clear()


def test_veto_survives_process_memory_loss_and_is_keyed_by_session():
    jinn._on_pre_llm_call(
        session_id="session-1",
        task_id="unstable-task-1",
        user_message="fix it",
        model="m",
    )
    jinn._on_post_tool_call(
        session_id="session-1",
        task_id="unstable-task-2",
        tool_name="terminal",
        tool_call_id="c1",
        args={"command": "true"},
        result={"exit_code": 0},
    )

    out = jinn._handle_jinn(
        command_args="veto", session_id="session-1", task_id="unstable-task-3"
    )
    jinn._vetoed_tasks.clear()  # simulate a new Python process

    assert "session-1" in out
    assert jinn._session_vetoed("session-1") is True
    assert jinn._session_vetoed("another-session") is False


def test_veto_marker_names_cannot_alias_after_sanitizing():
    assert jinn._veto_path("session/a") != jinn._veto_path("session:a")


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission assertion")
def test_veto_marker_and_directory_are_owner_only():
    jinn._record_veto("private-session")

    marker = jinn._veto_path("private-session")
    assert marker.parent.stat().st_mode & 0o777 == 0o700
    assert marker.stat().st_mode & 0o777 == 0o600


def test_published_message_says_the_record_is_immutable():
    line = jinn._contribution_line(
        {
            "contribution": {
                "status": "ok",
                "value": {"recordId": "episode-1", "status": "published"},
            }
        }
    )

    assert line == "jinn: contribution published — immutable (/jinn ledger for the anchor)"
