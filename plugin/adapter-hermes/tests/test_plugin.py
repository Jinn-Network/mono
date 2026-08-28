"""register(), the hooks, the injection, and disable-returns-to-stock."""

from __future__ import annotations

import importlib
import importlib.util
import json
import re
from pathlib import Path

import pytest

jinn = importlib.import_module("jinn_plugin")
feed_module = importlib.import_module("jinn_plugin.feed")


class RecordingCtx:
    def __init__(self):
        self.hooks = {}
        self.commands = {}
        self.cli_commands = {}

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def register_command(self, name, handler, description="", args_hint=""):
        self.commands[name] = handler

    def register_cli_command(self, name, help, setup_fn, handler_fn=None, description=""):
        self.cli_commands[name] = handler_fn


class FakeClient:
    def __init__(self, feed_path: Path, pickup=None):
        self.calls = []
        self._feed_path = feed_path
        self._pickup = pickup or {"status": "nothing-relevant", "terms": ["a"], "recordCount": 0, "text": ""}
        self.closed = False

    def start(self):
        return self

    def close(self):
        self.closed = True

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        if name == "capture_open":
            self._feed_path.parent.mkdir(parents=True, exist_ok=True)
            self._feed_path.touch(mode=0o600)
            return {"sessionId": "cap-1", "feedPath": str(self._feed_path)}
        if name == "pickup":
            return self._pickup
        if name == "capture_seal":
            return {"sealed": True, "digest": "sha256:abc"}
        if name == "health":
            return {"ok": True, "version": "0.1.0", "checks": []}
        return {}


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    monkeypatch.setattr(
        jinn.doctor,
        "run_checks",
        lambda full, **_: [{"name": "runtime-available", "ok": True, "detail": "fine", "remedy": None}],
    )
    jinn._reset_state_for_tests()
    yield


@pytest.fixture()
def lines(monkeypatch):
    collected = []
    monkeypatch.setattr(jinn, "user_line", collected.append)
    return collected


def install_client(monkeypatch, tmp_path, pickup=None) -> FakeClient:
    client = FakeClient(tmp_path / "capture" / "sessions" / "cap-1" / "feed.ndjson", pickup)
    monkeypatch.setattr(jinn, "_spawn_client", lambda: client)
    return client


def test_importing_the_module_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "pristine"))
    spec = importlib.util.spec_from_file_location(
        "jinn_plugin",
        feed_module.__file__.replace("feed.py", "__init__.py"),
        submodule_search_locations=[str(Path(feed_module.__file__).resolve().parent)],
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert not (tmp_path / "pristine").exists()


def test_register_wires_exactly_the_declared_hooks(monkeypatch):
    monkeypatch.setattr(jinn.runtime_pin, "ensure", lambda: _pinned())
    monkeypatch.setattr(jinn.host_config, "ensure_entry", lambda *a, **k: "written")
    ctx = RecordingCtx()
    jinn.register(ctx)
    assert sorted(ctx.hooks) == [
        "on_session_end",
        "on_session_start",
        "post_llm_call",
        "post_tool_call",
        "pre_llm_call",
    ]
    assert "jinn" in ctx.commands
    assert "jinn-doctor" in ctx.cli_commands


def test_register_survives_a_channel_outage_without_raising(monkeypatch, lines):
    def outage():
        raise jinn.runtime_pin.ChannelOutageError("npm cannot supply @jinn-network/plugin-runtime@0.1.0")

    monkeypatch.setattr(jinn.runtime_pin, "ensure", outage)
    ctx = RecordingCtx()
    jinn.register(ctx)
    assert ctx.hooks  # the plugin still registers; the doctor will say why it is degraded


def test_the_first_turn_injects_the_projection_verbatim(monkeypatch, tmp_path, lines):
    install_client(
        monkeypatch,
        tmp_path,
        pickup={"status": "projected", "terms": ["flaky", "vitest"], "recordCount": 2, "text": "BLOCK"},
    )
    jinn._on_session_start(session_id="s", platform="cli", cwd=str(tmp_path))
    result = jinn._on_pre_llm_call(session_id="s", user_message="fix the flaky test", is_first_turn=True, model="m")
    assert result == {"context": "BLOCK"}
    assert any("provided 2 evidence packets" in line for line in lines)


def test_a_later_turn_never_injects_again(monkeypatch, tmp_path, lines):
    install_client(monkeypatch, tmp_path, pickup={"status": "projected", "terms": ["a"], "recordCount": 1, "text": "BLOCK"})
    jinn._on_session_start(session_id="s", platform="cli", cwd=str(tmp_path))
    jinn._on_pre_llm_call(session_id="s", user_message="first", is_first_turn=True, model="m")
    assert jinn._on_pre_llm_call(session_id="s", user_message="second", is_first_turn=False, model="m") is None


def test_the_empty_state_shows_once_on_the_first_session_then_stays_silent(monkeypatch, tmp_path, lines):
    install_client(monkeypatch, tmp_path)
    jinn._on_session_start(session_id="s", platform="cli", cwd=str(tmp_path))
    jinn._on_pre_llm_call(session_id="s", user_message="obscure", is_first_turn=True, model="m")
    assert any("nothing relevant yet" in line for line in lines)

    lines.clear()
    jinn._reset_state_for_tests()
    install_client(monkeypatch, tmp_path)
    jinn._on_session_start(session_id="s2", platform="cli", cwd=str(tmp_path))
    jinn._on_pre_llm_call(session_id="s2", user_message="obscure", is_first_turn=True, model="m")
    assert not any("nothing relevant" in line for line in lines)


def test_a_pickup_failure_leaves_the_turn_untouched(monkeypatch, tmp_path, lines):
    client = install_client(monkeypatch, tmp_path)

    def explode(name, arguments):
        if name == "pickup":
            raise jinn.mcp_client.McpClientError("timeout", "no response within 30s")
        return FakeClient.call_tool(client, name, arguments)

    monkeypatch.setattr(client, "call_tool", explode)
    jinn._on_session_start(session_id="s", platform="cli", cwd=str(tmp_path))
    assert jinn._on_pre_llm_call(session_id="s", user_message="x", is_first_turn=True, model="m") is None


def test_the_hooks_write_the_feed_the_runtime_will_seal(monkeypatch, tmp_path, lines):
    client = install_client(monkeypatch, tmp_path)
    jinn._on_session_start(session_id="s", platform="cli", cwd=str(tmp_path))
    jinn._on_pre_llm_call(session_id="s", user_message="fix it", is_first_turn=True, model="claude-opus-4.6")
    jinn._on_post_tool_call(
        tool_name="bash", args={"command": "pytest"}, result="ok", session_id="s",
        tool_call_id="c1", duration_ms=120, status="ok",
    )
    jinn._on_post_llm_call(session_id="s", assistant_response="done", model="claude-opus-4.6", input_tokens=10, output_tokens=5)
    jinn._on_session_end(session_id="s", completed=True, interrupted=False, input_tokens=10, output_tokens=5)

    events = [json.loads(line) for line in (tmp_path / "capture" / "sessions" / "cap-1" / "feed.ndjson").read_text(encoding="utf-8").splitlines()]
    # repository-state is an observation of the working directory, so it is present only when
    # one is readable; the turn sequence around it is what this test pins.
    assert [event["type"] for event in events if event["type"] != "repository-state"] == [
        "session-open", "environment", "user-turn", "tool-call", "assistant-turn", "tokens", "session-close",
    ]
    assert events[-1]["outcome"] == "completed"
    assert ("capture_seal", {"sessionId": "cap-1"}) in client.calls
    assert client.closed is True


def test_an_interrupted_session_seals_as_abandoned(monkeypatch, tmp_path, lines):
    client = install_client(monkeypatch, tmp_path)
    jinn._on_session_start(session_id="s", platform="cli", cwd=str(tmp_path))
    jinn._on_pre_llm_call(session_id="s", user_message="x", is_first_turn=True, model="m")
    jinn._on_session_end(session_id="s", completed=False, interrupted=True, input_tokens=0, output_tokens=0)
    events = [json.loads(line) for line in (tmp_path / "capture" / "sessions" / "cap-1" / "feed.ndjson").read_text(encoding="utf-8").splitlines()]
    assert events[-1]["outcome"] == "abandoned"


def test_a_dead_runtime_never_breaks_a_session(monkeypatch, tmp_path, lines):
    monkeypatch.setattr(jinn, "_spawn_client", _raise_start_failed)
    jinn._on_session_start(session_id="s", platform="cli", cwd=str(tmp_path))
    assert jinn._on_pre_llm_call(session_id="s", user_message="x", is_first_turn=True, model="m") is None
    jinn._on_post_tool_call(tool_name="bash", args={}, result="", session_id="s", tool_call_id="c", duration_ms=1, status="ok")
    jinn._on_session_end(session_id="s", completed=True, interrupted=False, input_tokens=0, output_tokens=0)
    assert any("remedy" in line for line in lines)


def test_the_jinn_command_renders_the_doctor(monkeypatch, tmp_path):
    monkeypatch.setattr(jinn.doctor, "run_checks", lambda full, **_: [{"name": "a", "ok": True, "detail": "fine", "remedy": None}])
    assert "[ok  ] a: fine" in jinn.handle_jinn(command_args="doctor", session_id="s")


def _pinned():
    class Pinned:
        argv = ("/plugins/jinn/runtime/node_modules/.bin/jinn-plugin-runtime",)
        source = "pinned"
        detail = "@jinn-network/plugin-runtime@0.1.0"
    return Pinned()


def _raise_start_failed():
    raise importlib.import_module("jinn_plugin.mcp_client").McpClientError("start-failed", "runtime exited")


def test_session_start_reports_the_model_service_and_the_base_repository_state(
    monkeypatch, tmp_path, lines
):
    """The two facts this tree can observe are actually emitted, not merely emittable."""
    install_client(monkeypatch, tmp_path)
    monkeypatch.setattr(
        jinn,
        "_observe_repository_state",
        lambda: {
            "repository": "https://github.com/Jinn-Network/mono",
            "base_commit": "4f0e2b7c1a9d8e3f5b6a7c8d9e0f1a2b3c4d5e6f",
            "base_tree": "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
            "branch": "autopilot/3223",
            "target_base": "next",
        },
    )
    jinn._on_session_start(session_id="s", platform="cli", cwd=str(tmp_path))
    jinn._on_pre_llm_call(
        session_id="s", user_message="x", is_first_turn=True, model="anthropic/claude-opus-5"
    )

    events = [
        json.loads(line)
        for line in (tmp_path / "capture" / "sessions" / "cap-1" / "feed.ndjson")
        .read_text(encoding="utf-8")
        .splitlines()
    ]
    assert events[0]["model"]["service"] == {
        "iri": "https://spec.jinn.network/services/anthropic/claude-opus-5",
        "name": "anthropic claude-opus-5",
    }
    state = next(event for event in events if event["type"] == "repository-state")
    assert state["baseCommit"] == "4f0e2b7c1a9d8e3f5b6a7c8d9e0f1a2b3c4d5e6f"
    assert state["baseTree"] == "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567"
    assert state["targetBase"] == "next"


def test_an_unreadable_repository_costs_the_base_state_and_nothing_else(
    monkeypatch, tmp_path, lines
):
    install_client(monkeypatch, tmp_path)
    monkeypatch.setattr(jinn, "_observe_repository_state", lambda: None)
    jinn._on_session_start(session_id="s", platform="cli", cwd=str(tmp_path))
    assert (
        jinn._on_pre_llm_call(session_id="s", user_message="x", is_first_turn=True, model="m")
        is None
    )
    events = [
        json.loads(line)
        for line in (tmp_path / "capture" / "sessions" / "cap-1" / "feed.ndjson")
        .read_text(encoding="utf-8")
        .splitlines()
    ]
    assert [event["type"] for event in events] == ["session-open", "environment", "user-turn"]


@pytest.mark.parametrize(
    "remote,expected",
    [
        ("git@github.com:Jinn-Network/mono.git", "https://github.com/Jinn-Network/mono"),
        ("ssh://git@github.com/Jinn-Network/mono.git", "https://github.com/Jinn-Network/mono"),
        ("https://github.com/Jinn-Network/mono.git", "https://github.com/Jinn-Network/mono"),
        ("https://github.com/Jinn-Network/mono", "https://github.com/Jinn-Network/mono"),
        ("", ""),
        # A local remote names a filesystem path, often carrying a username. The record is
        # durable and publicly projectable, so it is dropped rather than normalized.
        ("file:///Users/someone/src/mono", ""),
        ("/Users/someone/src/mono", ""),
        ("C:\\Users\\someone\\mono", ""),
    ],
)
def test_a_git_remote_becomes_an_absolute_iri(remote, expected):
    """The record requires an absolute IRI; an SSH remote is not one."""
    assert jinn._repository_iri(remote) == expected


def test_observing_the_repository_reads_the_commit_and_tree_this_session_started_from():
    observed = jinn._observe_repository_state()
    assert observed is not None
    assert re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", observed["base_commit"])
    assert re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", observed["base_tree"])
    assert observed["repository"].startswith("http")


def test_observing_a_directory_that_is_not_a_repository_reports_nothing(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    assert jinn._observe_repository_state() is None
