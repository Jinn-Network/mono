"""Captures tee for local distillation (mono #1537).

The rung-1 `jinn-layer distill` loop reads ~/.jinn-client/harness-layer/captures;
the plugin is the producer. The trust invariants under test:

  - the tee follows the distill mode (off => nothing reserved);
  - a distill-only opt-in (publish consent declined, mode local/defer) fills
    the buffer and tees, but NEVER publishes;
  - an old layer without `distill status` degrades to no tee, publish path
    untouched;
  - pending files (publish lifecycle) and capture files (distill lifecycle)
    are distinct — the publish drain never touches the captures dir.
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

    def __call__(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(argv)
        # argv[0] is the jinn-layer binary; the verb starts at argv[1].
        if argv[1:3] == ["distill", "status"]:
            if self.status_code != 0:
                return self.status_code, "unknown distill subcommand"
            return 0, json.dumps({"mode": self.mode})
        return 0, "ok"

    def published(self) -> list[list[str]]:
        return [c for c in self.calls if c[1:2] == ["publish"]]


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("JINN_LAYER_CAPTURES_DIR", str(tmp_path / "captures"))
    capture_buffer.reset()
    distill.reset()
    jinn._vetoed_tasks.clear()
    jinn._session_hint_shown.clear()
    yield
    jinn._runner = None


def _drive_session(session_id: str = "s1", task_id: str = "t1") -> None:
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
    jinn._on_session_end(session_id=session_id, task_id=task_id, completed=True, interrupted=False)


def _capture_files(tmp_path_env: str | None = None) -> list[Path]:
    return sorted(distill.captures_dir().glob("*.json"))


def test_accepted_consent_mode_unset_tees_and_publishes(tmp_path):
    consent.save_state(consent.ACCEPTED)
    consent.mark_previewed()
    runner = DistillAwareRunner(mode="unset")
    jinn._runner = runner

    _drive_session()

    files = _capture_files()
    assert len(files) == 1, "accepted + unset must reserve a capture for the first run"
    task = json.loads(files[0].read_text())
    assert task["steps"], "the tee'd file is the full CapturedTask shape"
    assert runner.published(), "the publish path still runs under accepted consent"


def test_mode_off_tees_nothing_but_publish_path_unaffected(tmp_path):
    consent.save_state(consent.ACCEPTED)
    consent.mark_previewed()
    runner = DistillAwareRunner(mode="off")
    jinn._runner = runner

    _drive_session()

    assert _capture_files() == [], "off = stop reserving captures"
    assert runner.published(), "publish stays consent-gated, independent of distill mode"


def test_declined_consent_with_defer_mode_tees_but_never_publishes(tmp_path):
    consent.save_state(consent.DECLINED)
    runner = DistillAwareRunner(mode="defer")
    jinn._runner = runner

    _drive_session()

    assert len(_capture_files()) == 1, "distill opt-in fills the buffer and tees"
    assert runner.published() == [], "a distill-only opt-in must NEVER publish"
    pending = Path(os.environ["HERMES_HOME"]) / "jinn" / "pending"
    assert not pending.exists() or list(pending.glob("*.json")) == [], (
        "no pending file — pending is the publish lifecycle"
    )


def test_declined_consent_and_old_layer_degrades_to_nothing(tmp_path):
    consent.save_state(consent.DECLINED)
    runner = DistillAwareRunner(status_code=2)  # old layer: no `distill status`
    jinn._runner = runner

    _drive_session()

    assert _capture_files() == [], "old layer degrades: distill gating off"
    assert runner.published() == []


def test_mode_is_cached_one_status_read_per_process(tmp_path):
    consent.save_state(consent.ACCEPTED)
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


def test_tee_failure_never_breaks_session_end(tmp_path, monkeypatch):
    consent.save_state(consent.ACCEPTED)
    consent.mark_previewed()
    runner = DistillAwareRunner(mode="defer")
    jinn._runner = runner
    monkeypatch.setattr(distill, "should_tee", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))

    _drive_session()  # must not raise

    assert runner.published(), "the publish path survives a broken tee"
