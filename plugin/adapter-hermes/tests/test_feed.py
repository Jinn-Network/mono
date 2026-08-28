"""The session feed writer: C4's shapes, monotonic time, append-only, 0600."""

from __future__ import annotations

import base64
import importlib
import json
import pathlib
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


def test_open_session_carries_the_hosted_model_service_identity(feed_path):
    writer = feed.SessionFeed(feed_path)
    writer.open_session(
        session_id="s-1",
        host_name="hermes-agent",
        host_version="1.2.3",
        model_provider="anthropic",
        model_name="claude-opus-5",
        model_service={
            "iri": "https://spec.jinn.network/services/anthropic/claude-opus-5",
            "version": "claude-opus-5-20260514",
            "unknown": "dropped",
            "deployment": "",
        },
    )
    model = read_lines(feed_path)[0]["model"]
    assert model["service"] == {
        "iri": "https://spec.jinn.network/services/anthropic/claude-opus-5",
        "version": "claude-opus-5-20260514",
    }


def test_open_session_omits_the_service_when_none_is_reported(feed_path):
    writer = feed.SessionFeed(feed_path)
    writer.open_session(
        session_id="s-1",
        host_name="hermes-agent",
        host_version="1.2.3",
        model_provider="anthropic",
        model_name="claude-opus-5",
    )
    assert read_lines(feed_path)[0]["model"] == {
        "provider": "anthropic",
        "name": "claude-opus-5",
    }


def test_repository_state_binds_the_base_commit_and_tree(feed_path):
    writer = feed.SessionFeed(feed_path)
    writer.repository_state(
        repository="https://github.com/Jinn-Network/mono",
        branch="autopilot/3223",
        target_base="next",
        base_commit="a" * 40,
        base_tree="b" * 40,
    )
    event = read_lines(feed_path)[0]
    assert event["type"] == "repository-state"
    assert event["baseCommit"] == "a" * 40
    assert event["baseTree"] == "b" * 40
    assert event["targetBase"] == "next"
    assert event["atUnixNano"].isdigit()


def test_controlled_input_carries_the_exact_bytes(feed_path):
    writer = feed.SessionFeed(feed_path)
    writer.controlled_input(
        role="workflow",
        name="implement-issue/SKILL.md",
        media_type="text/markdown",
        content=b"# implement-issue\n",
    )
    event = read_lines(feed_path)[0]
    assert event["type"] == "controlled-input"
    assert event["role"] == "workflow"
    assert base64.b64decode(event["contentBase64"]) == b"# implement-issue\n"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"role": "secrets", "content": b"x"},
        {"role": "config", "content": b""},
        {"role": "config", "content": b"x" * (feed.CONTROLLED_INPUT_MAX_BYTES + 1)},
    ],
)
def test_controlled_input_drops_what_the_runtime_would_refuse(feed_path, kwargs):
    writer = feed.SessionFeed(feed_path)
    writer.controlled_input(name="n", media_type="text/plain", **kwargs)
    assert feed_path.read_text(encoding="utf-8") == ""


def test_controlled_input_stops_at_the_per_session_budget(feed_path):
    writer = feed.SessionFeed(feed_path)
    for index in range(feed.CONTROLLED_INPUT_MAX_COUNT + 3):
        writer.controlled_input(
            role="skill",
            name=f"skill-{index}.md",
            media_type="text/markdown",
            content=b"x",
        )
    assert len(read_lines(feed_path)) == feed.CONTROLLED_INPUT_MAX_COUNT


def test_controlled_input_bounds_match_the_runtime_that_enforces_them():
    """The runtime refuses the whole feed past these bounds, so drift here loses sessions."""
    source = (
        pathlib.Path(__file__).resolve().parents[2]
        / "runtime"
        / "src"
        / "capture"
        / "feed.ts"
    ).read_text(encoding="utf-8")
    assert (
        f"CONTROLLED_INPUT_MAX_BYTES = {feed.CONTROLLED_INPUT_MAX_BYTES // 1024} * 1024" in source
    )
    assert f"CONTROLLED_INPUT_MAX_COUNT = {feed.CONTROLLED_INPUT_MAX_COUNT}" in source
    for role in feed.CONTROLLED_INPUT_ROLES:
        assert f'"{role}"' in source


def _fixture_events():
    path = (
        pathlib.Path(__file__).resolve().parents[2]
        / "runtime"
        / "fixtures"
        / "capture"
        / "session-autopilot.ndjson"
    )
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_the_writer_still_produces_the_shape_the_runtime_fixture_pins(feed_path):
    """The fixture is adapter output the runtime parses; drift on either side breaks capture."""
    writer = feed.SessionFeed(feed_path)
    writer.open_session(
        session_id="s-autopilot",
        host_name="hermes-agent",
        host_version="1.2.3",
        model_provider="anthropic",
        model_name="claude-opus-5",
        conversation_id="s-autopilot",
        model_service={
            "iri": "https://spec.jinn.network/services/anthropic/claude-opus-5",
            "name": "Anthropic Messages API",
            "version": "claude-opus-5-20260514",
            "deployment": "api.anthropic.com",
            "providerIri": "https://spec.jinn.network/organizations/anthropic",
        },
    )
    writer.repository_state(
        repository="https://github.com/Jinn-Network/mono",
        branch="autopilot/3223",
        target_base="next",
        base_commit="4f0e2b7c1a9d8e3f5b6a7c8d9e0f1a2b3c4d5e6f",
        base_tree="0a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
    )
    writer.controlled_input(
        role="workflow",
        name=".claude/skills/implement-issue/SKILL.md",
        media_type="text/markdown",
        content=b"# implement-issue\n",
    )

    written = read_lines(feed_path)
    pinned = _fixture_events()[: len(written)]
    for actual, expected in zip(written, pinned):
        assert set(actual) == set(expected), actual["type"]
        for key, value in expected.items():
            if key in ("atUnixNano", "startedAt"):
                continue
            assert actual[key] == value, key
