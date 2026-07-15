"""Derived Stage 1 history rendering and command wiring."""

from __future__ import annotations

import importlib
import json
import re

import pytest

jinn = importlib.import_module("plugins.jinn")
history_view = importlib.import_module("plugins.jinn.history_view")
jinn_layer = importlib.import_module("plugins.jinn.jinn_layer")

_ANSI = re.compile(r"\033\[[0-9;]*m")


def _plain(value: str) -> str:
    return _ANSI.sub("", value)


@pytest.fixture(autouse=True)
def _plain_terminal(monkeypatch):
    monkeypatch.setenv("NO_COLOR", "1")


def _entry(**overrides):
    value = {
        "sessionId": "session-1",
        "capturedAt": "2026-07-15T12:00:00.000Z",
        "taskSummary": "Fix the retry bridge",
        "knowledgeSurfaced": 2,
        "knowledgeUsed": 1,
        "captureStatus": "captured",
        "eligibility": {
            "eligible": True,
            "reason": "accepted diff on a public repository",
            "checkedAt": "2026-07-15T12:01:00.000Z",
        },
        "contributionState": {"status": "queued"},
        "distilledSkills": [
            {"ref": "local-skill:retry-budget", "state": "installed"},
            {"ref": "local-skill:test-first", "state": "staged"},
        ],
    }
    value.update(overrides)
    return value


def test_history_renders_real_session_facts_and_skill_state():
    out = _plain(history_view.render_history([_entry()]))
    assert "Jinn history · 1 session" in out
    assert "Fix the retry bridge" in out
    assert "2 surfaced · 1 used" in out
    assert "eligible" in out
    assert "contribution queued" in out
    assert "retry-budget (installed)" in out
    assert "test-first (staged)" in out


def test_history_renders_unavailable_facts_instead_of_zeroes():
    out = _plain(history_view.render_history([_entry(
        knowledgeSurfaced=None,
        knowledgeUsed=None,
        eligibility=None,
        contributionState={"status": "unavailable"},
        distilledSkills=None,
    )]))
    assert "knowledge unavailable" in out
    assert "eligibility unavailable" in out
    assert "contribution unavailable" in out
    assert "local skills unavailable" in out
    assert "0 surfaced" not in out


def test_history_empty_state_is_explicit():
    assert "No Jinn sessions captured yet" in _plain(history_view.render_history([]))


def test_jinn_history_uses_the_versioned_layer_command(monkeypatch):
    calls = []

    def runner(argv):
        calls.append(argv)
        return 0, json.dumps({
            "contractVersion": 1,
            "status": "ok",
            "value": {"entries": [_entry()]},
        })

    monkeypatch.setattr(jinn, "_runner", runner)
    out = _plain(jinn._handle_jinn(command_args="history"))
    assert calls == [[jinn_layer.binary(), "history", "--json"]]
    assert "Fix the retry bridge" in out


def test_jinn_history_preserves_degraded_reason(monkeypatch):
    def runner(_argv):
        return 0, json.dumps({
            "contractVersion": 1,
            "status": "degraded",
            "reason": "contribution: contribution store offline",
            "value": {"entries": [_entry(contributionState={"status": "unavailable"})]},
        })

    monkeypatch.setattr(jinn, "_runner", runner)
    out = _plain(jinn._handle_jinn(command_args="history"))
    assert "contribution unavailable" in out
    assert "history degraded — contribution: contribution store offline" in out


def test_jinn_history_sanitises_layer_supplied_fields(monkeypatch):
    def runner(_argv):
        return 0, json.dumps({
            "contractVersion": 1,
            "status": "degraded",
            "reason": "store\n\033[31mspoofed",
            "value": {"entries": [_entry(
                taskSummary="task\n\033[31mspoofed",
                contributionState={"status": "published", "anchorRef": "anchor-1"},
            )]},
        })

    monkeypatch.setattr(jinn, "_runner", runner)
    out = jinn._handle_jinn(command_args="history")
    assert "taskspoofed" in out
    assert "storespoofed" in out
    assert "anchor-1" in out
    assert "\033[31m" not in out


def test_jinn_history_reports_missing_layer_as_unavailable(monkeypatch):
    monkeypatch.setattr(jinn, "_runner", lambda _argv: (127, "jinn-layer: not found"))
    out = jinn._handle_jinn(command_args="history")
    assert out == "history unavailable:\njinn-layer: not found"
