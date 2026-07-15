"""The v1 handshake gates only the additive process bridge."""

from __future__ import annotations

import importlib
import json

import pytest

jinn = importlib.import_module("plugins.jinn")
capture_buffer = importlib.import_module("plugins.jinn.capture_buffer")
consent = importlib.import_module("plugins.jinn.consent")


class ContractRunner:
    def __init__(self, code: int = 0, output: str = '{"contractVersion":1}') -> None:
        self.code = code
        self.output = output
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], **_: object) -> tuple[int, str]:
        self.calls.append(argv)
        return self.code, self.output


@pytest.fixture(autouse=True)
def reset(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    capture_buffer.reset()
    jinn._reset_contract_state()
    jinn._reset_session_state()
    jinn._runner = None
    yield
    jinn._runner = None
    jinn._reset_contract_state()
    jinn._reset_session_state()


def test_matching_contract_is_memoized_and_keeps_bridge_enabled():
    runner = ContractRunner()
    jinn._runner = runner

    jinn._check_contract()
    jinn._check_contract()

    assert jinn._degraded is None
    assert len(runner.calls) == 1


@pytest.mark.parametrize(
    ("code", "output", "reason_part"),
    [
        (127, "jinn-layer: not found", "unavailable"),
        (0, '{"contractVersion":2}', "contract v2"),
        (0, "not json", "unreadable"),
        (1, "broken", "handshake failed"),
    ],
)
def test_missing_or_mismatched_contract_sets_a_concise_reason(code, output, reason_part):
    jinn._runner = ContractRunner(code, output)

    jinn._check_contract()

    assert reason_part in jinn._degraded
    assert len(jinn._degraded) < 100
    assert f"bridge: degraded — {jinn._degraded}" in jinn._handle_jinn(command_args="status")


def test_mismatch_never_disables_python_pickup_or_local_episode_fallback(monkeypatch):
    jinn._runner = ContractRunner(output='{\"contractVersion\":2}')
    jinn._check_contract()
    monkeypatch.setattr(jinn.pickup, "pickup", lambda *_a, **_k: {"context": "python pickup"})
    local: list[dict] = []
    monkeypatch.setattr(jinn.distill, "write_episode_fallback", lambda episode: local.append(episode))
    monkeypatch.setattr(jinn.distill, "tee_capture", lambda *_a, **_k: None)

    result = jinn._on_pre_llm_call(
        session_id="s1", task_id="t1", user_message="fix tests", is_first_turn=True, model="m"
    )
    jinn._on_post_tool_call(
        tool_name="terminal",
        args={"command": "scripts/run_tests.sh tests/plugins/test_jinn_plugin.py"},
        result={"exit_code": 0},
        session_id="s1",
        task_id="t1",
        tool_call_id="c1",
    )
    jinn._on_session_end(session_id="s1", task_id="t1", completed=True)

    assert result == {"context": "python pickup"}
    assert len(local) == 1
    assert local[0]["schemaVersion"] == "jinn.episode.v1"
    assert all(call[1:3] != ["session", "end"] for call in jinn._runner.calls)
