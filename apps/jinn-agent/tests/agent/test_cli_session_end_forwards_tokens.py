"""CLI session-end fire sites forward session token counters (mono #1662, #1840).

turn_finalizer already forwards `input_tokens`/`output_tokens` on the
normal-completion path, but real `-p`/interrupted jinn runs terminate through
the CLI fire sites (`_emit_interrupted_session_end` and the mid-turn shutdown
safety-net). Those omitted the token kwargs, so the jinn plugin's
`_on_session_end` guard (`if input_tokens or output_tokens`) was false and
`cost.tokens` was never assembled — 0% of real episodes carried it.

This pins the interrupt fire site. The shutdown safety-net (~cli.py:15507)
receives the identical additive kwargs off `self.agent`; it lives inside a large
prompt_toolkit CLI method that can't be unit-driven cleanly, so it is not
exercised in isolation here.
"""

from __future__ import annotations

from types import SimpleNamespace

import cli as jinn_cli


def _fake_cli():
    agent = SimpleNamespace(
        session_id="sess-A",
        model="test-model",
        platform="cli",
        session_input_tokens=100,
        session_output_tokens=50,
        _current_task_id="task-1",
        _current_turn_id="turn-1",
        _current_api_request_id="req-1",
        interrupt=lambda *a, **k: None,
    )
    return SimpleNamespace(agent=agent, session_id="sess-A")


def _run(monkeypatch):
    calls: list[tuple[str, dict]] = []

    def invoke_hook(name, **kwargs):
        calls.append((name, kwargs))
        return []

    monkeypatch.setattr("hermes_cli.plugins.invoke_hook", invoke_hook)

    jinn_cli._emit_interrupted_session_end(_fake_cli(), reason="keyboard_interrupt")
    return calls


def test_interrupted_session_end_forwards_token_counters(monkeypatch):
    calls = _run(monkeypatch)
    end = dict(calls)["on_session_end"]
    assert end["input_tokens"] == 100
    assert end["output_tokens"] == 50
