"""Captures tee for local distillation (mono #1537).

The rung-1 `jinn-layer distill` loop reads ~/.jinn-client/harness-layer/captures;
the plugin is the producer. The trust invariants under test:

  - the tee follows the distill mode (off => nothing reserved);
  - a distill-only opt-in (share consent declined, mode local/defer) fills
    the buffer and tees, but NEVER authorizes publication;
  - an old/missing layer still reserves a local tee while the complete
    EpisodeV1 gets a local fallback write;
  - the retired raw publish verb and pending queue are never used.
"""

from __future__ import annotations

import importlib
import json
import os
import time
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
consent = importlib.import_module("plugins.jinn.consent")
capture_buffer = importlib.import_module("plugins.jinn.capture_buffer")
distill = importlib.import_module("plugins.jinn.distill")


class DistillAwareRunner:
    """RunnerSpy that answers `distill status --json` with a canned mode."""

    def __init__(self, mode: str | None = "defer", status_code: int = 0):
        self.calls: list[list[str]] = []
        self.mode = mode
        self.status_code = status_code

    def __call__(self, argv: list[str], *, input: str | None = None) -> tuple[int, str]:
        self.calls.append(argv)
        # argv[0] is the jinn-layer binary; the verb starts at argv[1].
        if argv[1:3] == ["distill", "status"]:
            if self.status_code != 0:
                return self.status_code, "unknown distill subcommand"
            return 0, json.dumps({"mode": self.mode})
        return 0, "ok"

    def delegated(self) -> list[list[str]]:
        return [c for c in self.calls if c[1:3] == ["session", "end"]]

    def legacy_published(self) -> list[list[str]]:
        return [c for c in self.calls if c[1:2] == ["publish"]]


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("JINN_LAYER_CAPTURES_DIR", str(tmp_path / "captures"))
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path / "episodes"))
    capture_buffer.reset()
    distill.reset()
    jinn._reset_contract_state()
    jinn._reset_session_state()
    jinn._contract_checked = True
    jinn._degraded = None
    jinn._vetoed_tasks.clear()
    jinn._session_hint_shown.clear()
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
        is_first_turn=False,  # skip pickup's corpus search
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
    return sorted(distill.episodes_dir().glob("*.json"))


def _capture_files(tmp_path_env: str | None = None) -> list[Path]:
    return sorted(distill.captures_dir().glob("*.json"))


def test_accepted_consent_mode_unset_tees_and_delegates_episode(tmp_path):
    consent.save_state(True)
    consent.mark_previewed()
    runner = DistillAwareRunner(mode="unset")
    jinn._runner = runner

    _drive_session()

    files = _capture_files()
    assert len(files) == 1, "accepted + unset must reserve a capture for the first run"
    task = json.loads(files[0].read_text())
    assert task["steps"], "the tee'd file is the full CapturedTask shape"
    assert runner.delegated(), "the complete episode is delegated once"
    assert runner.legacy_published() == []


def test_mode_off_tees_nothing_but_episode_delegation_is_unaffected(tmp_path):
    consent.save_state(True)
    consent.mark_previewed()
    runner = DistillAwareRunner(mode="off")
    jinn._runner = runner

    _drive_session()

    assert _capture_files() == [], "off = stop reserving captures"
    assert runner.delegated(), "session delegation is independent of distill mode"
    assert runner.legacy_published() == []


def test_declined_consent_with_defer_mode_tees_but_never_publishes(tmp_path):
    consent.save_state(False)
    runner = DistillAwareRunner(mode="defer")
    jinn._runner = runner

    _drive_session()

    assert len(_capture_files()) == 1, "distill opt-in fills the buffer and tees"
    assert runner.legacy_published() == [], "a distill-only opt-in must NEVER publish raw"
    pending = Path(os.environ["HERMES_HOME"]) / "jinn" / "pending"
    assert not pending.exists() or list(pending.glob("*.json")) == [], (
        "no pending file — pending is the publish lifecycle"
    )


def test_declined_consent_and_old_layer_still_reserves_locally(tmp_path):
    consent.save_state(False)
    runner = DistillAwareRunner(status_code=2)  # old layer: no `distill status`
    jinn._runner = runner

    _drive_session()

    assert len(_capture_files()) == 1, "missing status disables only the process bridge"
    assert runner.legacy_published() == []


def test_mode_is_cached_one_status_read_per_process(tmp_path):
    consent.save_state(True)
    consent.mark_previewed()
    runner = DistillAwareRunner(mode="defer")
    jinn._runner = runner

    _drive_session("s1", "t1")
    _drive_session("s2", "t2")

    status_calls = [c for c in runner.calls if c[1:3] == ["distill", "status"]]
    assert len(status_calls) == 1, "one status subprocess per process, then cached"
    assert len(_capture_files()) == 2


def test_prune_keeps_the_newest_files(tmp_path):
    d = distill.captures_dir()
    d.mkdir(parents=True, exist_ok=True)
    for i in range(5):
        p = d / f"cap-{i}.json"
        p.write_text("{}")
        ts = time.time() - (100 - i)
        os.utime(p, (ts, ts))
    distill.prune_captures(keep=3)
    kept = sorted(f.name for f in d.glob("*.json"))
    assert kept == ["cap-2.json", "cap-3.json", "cap-4.json"]


def test_full_hook_drive_yields_ordered_episode(tmp_path):
    consent.save_state(True)
    consent.mark_previewed()
    runner = DistillAwareRunner(mode="unset")
    jinn._runner = runner

    _drive_session()

    episodes = _episode_files()
    assert len(episodes) == 1, "an EpisodeV1 is written under accepted consent"
    ep = json.loads(episodes[0].read_text())
    assert ep["schemaVersion"] == "jinn.episode.v1"
    assert [step["kind"] for step in ep["trajectory"]] == [
        "jinn.agent_turn",
        "jinn.tool_call",
        "jinn.agent_turn",
    ]
    assert ep["trajectory"][0]["attributes"]["role"] == "user"
    assert ep["trajectory"][2]["attributes"]["role"] == "assistant"
    assert ep["environment"]["skillsLoadout"] == ["tdd"]
    assert ep["cost"]["tokens"] == {"input": 100, "output": 50}


def test_full_hook_drive_omits_cost_tokens_when_host_reports_no_usage(tmp_path):
    # AC2 on the REAL path: when the host forwards 0/0 (the getattr default when
    # the agent recorded no usage), the plugin must OMIT cost.tokens rather than
    # emit {input:0, output:0} (mono #1662).
    consent.save_state(True)
    consent.mark_previewed()
    runner = DistillAwareRunner(mode="unset")
    jinn._runner = runner

    _drive_session(input_tokens=0, output_tokens=0)

    episodes = _episode_files()
    assert len(episodes) == 1
    ep = json.loads(episodes[0].read_text())
    assert "tokens" not in ep["cost"], "no host usage => cost.tokens omitted, not {0,0}"


def test_no_share_consent_still_reserves_locally(tmp_path):
    # mono#1714: local distillation is ungated. With distill reserving (mode
    # "unset" => should_tee True) the tee AND episode are written locally even
    # with no share consent — only the publish path is consent-gated, so the
    # reserved material never leaves the machine.
    consent.save_state(False)  # sharing not consented
    runner = DistillAwareRunner(mode="unset")
    jinn._runner = runner

    _drive_session()

    assert len(_capture_files()) == 1, "local tee reserved regardless of share consent"
    assert len(_episode_files()) == 1, "local episode written regardless of share consent"
    assert runner.legacy_published() == [], "nothing uses the retired raw publish path"


def test_legacy_capture_still_written_byte_shape(tmp_path):
    consent.save_state(True)
    consent.mark_previewed()
    runner = DistillAwareRunner(mode="unset")
    jinn._runner = runner

    _drive_session()

    files = _capture_files()
    assert len(files) == 1
    task = json.loads(files[0].read_text())
    # Legacy CapturedTask shape — no schemaVersion, the keys parseCapturedTask reads.
    assert "schemaVersion" not in task
    assert set(task.keys()) == {
        "session",
        "task",
        "environment",
        "steps",
        "outcome",
        "cost",
        "provenance",
    }


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission assertion")
def test_legacy_capture_is_owner_only(tmp_path):
    runner = DistillAwareRunner(mode="defer")
    path = distill.tee_capture({"private": "raw trajectory"}, "private-session", runner)

    assert path is not None
    assert path.parent.stat().st_mode & 0o777 == 0o700
    assert path.stat().st_mode & 0o777 == 0o600


@pytest.mark.skipif(os.name == "nt", reason="symlink semantics differ")
def test_legacy_capture_refuses_a_symlink_destination(tmp_path):
    directory = distill.captures_dir()
    directory.mkdir(parents=True)
    target = tmp_path / "outside.json"
    target.write_text("do not overwrite", encoding="utf-8")
    (directory / "private-session.json").symlink_to(target)

    result = distill.tee_capture(
        {"private": "raw trajectory"},
        "private-session",
        DistillAwareRunner(mode="defer"),
    )

    assert result is None
    assert target.read_text(encoding="utf-8") == "do not overwrite"


def test_episode_written_to_separate_location(tmp_path):
    consent.save_state(True)
    consent.mark_previewed()
    runner = DistillAwareRunner(mode="unset")
    jinn._runner = runner

    _drive_session()

    assert distill.episodes_dir() != distill.captures_dir()
    episodes = _episode_files()
    assert len(episodes) == 1
    assert json.loads(episodes[0].read_text())["schemaVersion"] == "jinn.episode.v1"


def test_episode_fallback_is_written_even_when_distill_gate_is_off(tmp_path):
    consent.save_state(False)
    runner = DistillAwareRunner(status_code=2)  # old layer: distill gating off
    jinn._runner = runner

    _drive_session()

    assert len(_capture_files()) == 1
    assert len(_episode_files()) == 1


def test_tee_failure_never_breaks_session_end(tmp_path, monkeypatch):
    consent.save_state(True)
    consent.mark_previewed()
    runner = DistillAwareRunner(mode="defer")
    jinn._runner = runner
    monkeypatch.setattr(distill, "should_tee", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))

    _drive_session()  # must not raise

    assert runner.delegated(), "session delegation survives a broken tee"
    assert len(_episode_files()) == 1, "malformed process reply falls back locally"
