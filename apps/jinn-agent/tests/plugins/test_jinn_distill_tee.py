"""C7 regression: Hermes writes canonical episodes, never a CapturedTask tee."""

from __future__ import annotations

import importlib
import json
import os
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
consent = importlib.import_module("plugins.jinn.consent")
capture_buffer = importlib.import_module("plugins.jinn.capture_buffer")
distill = importlib.import_module("plugins.jinn.distill")


class DistillAwareRunner:
    def __init__(self, mode: str | None = "defer", status_code: int = 0):
        self.calls: list[list[str]] = []
        self.mode = mode
        self.status_code = status_code

    def __call__(self, argv: list[str], *, input: str | None = None) -> tuple[int, str]:
        self.calls.append(argv)
        if argv[1:3] == ["distill", "status"]:
            if self.status_code != 0:
                return self.status_code, "unknown distill subcommand"
            return 0, json.dumps({"mode": self.mode})
        # Deliberately not a valid session-end response: this exercises the
        # canonical host fallback writer without introducing a second store.
        return 0, "ok"

    def delegated(self) -> list[list[str]]:
        return [call for call in self.calls if call[1:3] == ["session", "end"]]

    def legacy_published(self) -> list[list[str]]:
        return [call for call in self.calls if call[1:2] == ["publish"]]


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("JINN_LAYER_CAPTURES_DIR", str(tmp_path / "captures"))
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path / "episodes"))
    capture_buffer.reset()
    distill.reset()
    jinn._reset_session_state()
    jinn._degraded = None
    jinn._vetoed_tasks.clear()
    yield
    jinn._runner = None


def _drive_session(
    session_id: str = "s1",
    task_id: str = "t1",
    input_tokens: int = 100,
    output_tokens: int = 50,
) -> None:
    jinn._on_pre_llm_call(
        session_id=session_id,
        task_id=task_id,
        user_message="Fix the failing retry test",
        is_first_turn=False,
        model="test-model",
        platform="cli",
    )
    jinn._on_post_tool_call(
        tool_name="terminal",
        args={"command": "yarn test"},
        session_id=session_id,
        task_id=task_id,
        tool_call_id="c1",
        result="1 failed",
        duration_ms=10,
    )
    jinn._on_post_llm_call(
        session_id=session_id,
        task_id=task_id,
        user_message="Fix the failing retry test",
        assistant_response="Fixed the retry test.",
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )
    jinn._on_session_end(
        session_id=session_id,
        task_id=task_id,
        completed=True,
        interrupted=False,
        skills_loadout=["tdd"],
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )


def _episode_files() -> list[Path]:
    return sorted(distill.episodes_dir().glob("*.episode.json"))


def _legacy_capture_files() -> list[Path]:
    return sorted(Path(os.environ["JINN_LAYER_CAPTURES_DIR"]).glob("*.json"))


@pytest.mark.parametrize(
    ("mode", "status_code"),
    [("unset", 0), ("local", 0), ("defer", 0), ("off", 0), (None, 2)],
)
def test_every_mode_keeps_one_episode_and_writes_no_legacy_tee(mode, status_code):
    consent.save_state(False)
    runner = DistillAwareRunner(mode=mode, status_code=status_code)
    jinn._runner = runner

    _drive_session()

    assert len(_episode_files()) == 1
    assert _legacy_capture_files() == []
    assert runner.delegated(), "the canonical episode is delegated before fallback"
    assert runner.legacy_published() == []
    pending = Path(os.environ["HERMES_HOME"]) / "jinn" / "pending"
    assert not pending.exists() or list(pending.glob("*.json")) == []


def test_full_hook_drive_yields_the_complete_ordered_episode():
    jinn._runner = DistillAwareRunner(mode="unset")

    _drive_session()

    episode = json.loads(_episode_files()[0].read_text())
    assert episode["schemaVersion"] == "jinn.episode.v1"
    assert [step["kind"] for step in episode["trajectory"]] == [
        "jinn.agent_turn",
        "jinn.tool_call",
        "jinn.agent_turn",
    ]
    assert episode["trajectory"][0]["attributes"]["role"] == "user"
    assert episode["trajectory"][2]["attributes"]["role"] == "assistant"
    assert episode["environment"]["skillsLoadout"] == ["tdd"]
    assert episode["cost"]["tokens"] == {"input": 100, "output": 50}
    assert _legacy_capture_files() == []


def test_no_host_usage_omits_tokens_from_the_canonical_episode():
    jinn._runner = DistillAwareRunner(mode="unset")

    _drive_session(input_tokens=0, output_tokens=0)

    episode = json.loads(_episode_files()[0].read_text())
    assert "tokens" not in episode["cost"]
    assert _legacy_capture_files() == []


def test_distill_mode_status_is_cached_without_controlling_episode_capture():
    runner = DistillAwareRunner(mode="defer")
    jinn._runner = runner

    _drive_session("s1", "t1")
    _drive_session("s2", "t2")

    status_calls = [call for call in runner.calls if call[1:3] == ["distill", "status"]]
    assert len(status_calls) == 1
    assert len(_episode_files()) == 2
    assert _legacy_capture_files() == []
