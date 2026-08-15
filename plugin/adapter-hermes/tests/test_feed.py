"""The session feed writer: C4's shapes, monotonic time, append-only, 0600."""

from __future__ import annotations

import importlib
import json
import threading

import pytest

feed = importlib.import_module("jinn_plugin.feed")


def read_lines(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


@pytest.fixture()
def feed_path(tmp_path):
    path = tmp_path / "feed.ndjson"
    path.touch(mode=0o600)
    return path


def test_session_open_is_the_first_line_and_carries_the_declared_shape(feed_path):
    writer = feed.SessionFeed(feed_path)
    writer.open_session(
        session_id="s-1",
        host_name="hermes-agent",
        host_version="1.2.3",
        model_provider="anthropic",
        model_name="claude-opus-4.6",
        conversation_id="c-9",
    )
    first = read_lines(feed_path)[0]
    assert first["type"] == "session-open"
    assert first["v"] == 1
    assert first["sessionId"] == "s-1"
    assert first["host"] == {"name": "hermes-agent", "version": "1.2.3"}
    assert first["model"] == {"provider": "anthropic", "name": "claude-opus-4.6"}
    assert first["conversationId"] == "c-9"
    assert first["startedAt"].endswith("Z")
    assert first["atUnixNano"].isdigit()


def test_every_event_type_round_trips(feed_path):
    writer = feed.SessionFeed(feed_path)
    writer.open_session(
        session_id="s-1", host_name="h", host_version="1", model_provider="p", model_name="m"
    )
    writer.environment(tools=["bash", "read"], skills=["superpowers"])
    writer.user_turn("fix the flaky test")
    writer.tool_call(
        tool_name="bash",
        tool_call_id="call-1",
        arguments={"command": "pytest -q"},
        result="2 failed",
        status="error",
        started_at_unix_nano=None,
        error_message="exit 1",
    )
    writer.assistant_turn("I will rerun with -x", model="m")
    writer.tokens(input_tokens=100, output_tokens=42)
    writer.close_session(outcome="completed", summary="fixed the flaky test")

    events = read_lines(feed_path)
    assert [event["type"] for event in events] == [
        "session-open",
        "environment",
        "user-turn",
        "tool-call",
        "assistant-turn",
        "tokens",
        "session-close",
    ]
    tool = events[3]
    assert tool["status"] == "error"
    assert json.loads(tool["arguments"]) == {"command": "pytest -q"}
    assert tool["result"] == "2 failed"
    assert tool["errorMessage"] == "exit 1"
    assert tool["startedAtUnixNano"].isdigit()
    assert events[5]["inputTokens"] == 100
    assert events[-1]["outcome"] == "completed"


def test_timestamps_never_decrease_even_when_the_clock_does(feed_path, monkeypatch):
    writer = feed.SessionFeed(feed_path)
    stamps = iter([2_000, 1_000, 1_000, 3_000])
    monkeypatch.setattr(feed.time, "time_ns", lambda: next(stamps))
    writer.open_session(session_id="s", host_name="h", host_version="1", model_provider="p", model_name="m")
    writer.user_turn("a")
    writer.user_turn("b")
    writer.user_turn("c")
    values = [int(event["atUnixNano"]) for event in read_lines(feed_path)]
    assert values == sorted(values)


def test_arguments_and_results_are_pre_stringified(feed_path):
    writer = feed.SessionFeed(feed_path)
    writer.open_session(session_id="s", host_name="h", host_version="1", model_provider="p", model_name="m")
    writer.tool_call(
        tool_name="read",
        tool_call_id="c",
        arguments={"path": "/tmp/x", "nested": {"deep": [1, 2]}},
        result={"lines": 12},
        status="ok",
        started_at_unix_nano=None,
    )
    event = read_lines(feed_path)[-1]
    assert isinstance(event["arguments"], str)
    assert isinstance(event["result"], str)
    assert json.loads(event["arguments"])["nested"] == {"deep": [1, 2]}


def test_stringify_is_stable_for_equal_structures():
    assert feed.stringify({"b": 1, "a": 2}) == feed.stringify({"a": 2, "b": 1})


def test_stringify_never_raises_on_an_unserialisable_value():
    assert isinstance(feed.stringify(object()), str)


def test_the_writer_is_append_only_and_never_rewrites(feed_path):
    writer = feed.SessionFeed(feed_path)
    writer.open_session(session_id="s", host_name="h", host_version="1", model_provider="p", model_name="m")
    before = feed_path.read_text(encoding="utf-8")
    writer.user_turn("later")
    after = feed_path.read_text(encoding="utf-8")
    assert after.startswith(before)
    assert after.endswith("\n")


def test_the_writer_does_not_change_the_file_mode(feed_path):
    feed_path.chmod(0o600)
    writer = feed.SessionFeed(feed_path)
    writer.open_session(session_id="s", host_name="h", host_version="1", model_provider="p", model_name="m")
    assert (feed_path.stat().st_mode & 0o777) == 0o600


def test_concurrent_writers_produce_whole_lines(feed_path):
    writer = feed.SessionFeed(feed_path)
    writer.open_session(session_id="s", host_name="h", host_version="1", model_provider="p", model_name="m")

    def append(index: int) -> None:
        for _ in range(20):
            writer.user_turn(f"turn {index}")

    threads = [threading.Thread(target=append, args=(index,)) for index in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    events = read_lines(feed_path)  # would raise on a torn line
    assert len(events) == 81
    assert writer.line_count == 81


def test_a_write_failure_is_swallowed_so_a_session_never_breaks(feed_path):
    writer = feed.SessionFeed(feed_path / "not-a-directory" / "feed.ndjson")
    writer.user_turn("this must not raise")
    assert writer.line_count == 0
