"""Capture must not silently drop a trace's summary + model — mono #1404.

Regression for the 2026-07-06 Nous-path run: a completed browser session
published with ``task.summary == "(no summary)"`` and
``environment.model == "unknown"`` while still carrying all its tool steps.
Two single points of failure fed it:

  - ``record_first_turn`` crashed on an empty first message
    (``"".splitlines()[0]`` → IndexError), swallowed by the hook dispatcher,
    so the model write never ran either;
  - the buffer keyed ``task_id``-first, but ``task_id`` is a fresh per-turn
    uuid on the interactive path, so the first-turn write and the steps /
    ``assemble`` could land in different buffers.
"""

from __future__ import annotations

import importlib

capture_buffer = importlib.import_module("plugins.jinn.capture_buffer")


def test_empty_first_message_does_not_crash_and_keeps_model():
    capture_buffer.reset()
    # Must not raise (was IndexError on "".splitlines()[0]).
    capture_buffer.record_first_turn("t1", "s1", "", "step-3.7-flash", "cli")
    capture_buffer.record_tool_call("t1", "s1", "terminal", "c1", {"command": "ls"}, "ok")
    task = capture_buffer.assemble("t1", "s1", completed=True, interrupted=False)
    capture_buffer.reset()
    assert task is not None
    # Model survives even when the first message carried no summary text.
    assert task["environment"]["model"] == "step-3.7-flash"


def test_empty_first_message_lets_a_later_message_set_the_summary():
    capture_buffer.reset()
    capture_buffer.record_first_turn("t1", "s1", "", "m", "cli")
    capture_buffer.record_first_turn("t1", "s1", "Search the web for X", "m", "cli")
    capture_buffer.record_tool_call("t1", "s1", "terminal", "c1", {}, "ok")
    task = capture_buffer.assemble("t1", "s1", completed=True, interrupted=False)
    capture_buffer.reset()
    assert task["task"]["summary"] == "Search the web for X"


def test_buffer_keys_on_session_across_unstable_task_ids():
    # Interactive path: effective_task_id is a fresh uuid per turn while
    # session_id is stable — the trace must still assemble as one unit.
    capture_buffer.reset()
    capture_buffer.record_first_turn("uuid-turn-1", "sess-A", "Do the thing", "m", "cli")
    capture_buffer.record_tool_call("uuid-turn-2", "sess-A", "terminal", "c1", {}, "ok")
    task = capture_buffer.assemble("uuid-turn-3", "sess-A", completed=True, interrupted=False)
    capture_buffer.reset()
    assert task is not None
    assert task["task"]["summary"] == "Do the thing"
    assert task["environment"]["model"] == "m"
    assert len(task["steps"]) == 1


def test_assemble_uses_resolved_harness_when_stock(monkeypatch):
    from plugins.jinn import capture_buffer as buf
    monkeypatch.delenv("JINN_HARNESS_NAME", raising=False)
    buf.reset()
    buf.record_first_turn("t", "s", "fix the retry bug", "gpt-4o-mini", "")
    buf.record_tool_call("t", "s", "edit", "c1", {}, "ok", 5)
    task = buf.assemble("t", "s", completed=True, interrupted=False)
    assert task["environment"]["harness"]["name"] == "hermes-agent"
    assert task["task"]["distributionTags"][0] == "hermes-agent"
